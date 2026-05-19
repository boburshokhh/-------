const aiRoutingTariffsRepo = require('../../db/repositories/aiRoutingTariffsRepo');
const aiGlobalPoliciesRepo = require('../../db/repositories/aiGlobalPoliciesRepo');
const quotaGuard = require('../quotaGuard');
const { resolveApiModelId } = require('../../utils/modelAliases');

/**
 * Разрешает, какую модель использовать для данной задачи (stage),
 * с учетом профиля, лимитов квоты и fallback-стратегий.
 */
async function resolveRoute(profileCode, stageName, { estimatedTokens = 0, env = 'production' } = {}) {
    const trace = [];
    trace.push(`[Base] Requested Profile: ${profileCode}`);
    trace.push(`[Base] Stage: ${stageName}`);

    // Получаем базу глобальных политик (чтобы знать дефолтный если не передан профиль)
    const policies = await aiGlobalPoliciesRepo.getPolicies() || {};
    const actualProfile = profileCode || policies.default_routing_profile || 'standard';
    
    // Получаем правило роутинга для Profile + Stage
    const rule = await aiRoutingTariffsRepo.getStageRule(actualProfile, stageName);

    if (!rule) {
        trace.push(`[Rule] Нет явного правила для ${actualProfile} -> ${stageName}. Fallback: gemini-1.5-flash.`);
        return {
            resolved_model: 'gemini-1.5-flash',
            is_fallback_active: true,
            explainability_trace: trace,
        };
    }

    trace.push(`[Rule] Primary requested: ${rule.primary_model_id} (allow_premium=${rule.allow_premium})`);

    // Hardcoded Guards: "embedding" and "cheap_preprocess" MUST NEVER burn premium
    if ((stageName === 'embedding' || stageName === 'cheap_preprocess') && rule.allow_premium) {
        trace.push(`[Guard] WARNING: Hardcoded policy prevents premium on '${stageName}'. Overriding allow_premium to false.`);
        rule.allow_premium = false;
        // if for some reason someone put a pro model here, degrade it implicitly
        if (rule.primary_model_id.includes('pro')) {
            rule.primary_model_id = 'gemini-1.5-flash';
            trace.push(`[Guard] Forced downgrade to flash.`);
        }
    }

    // Checking preview models in production
    if (env === 'production' && !rule.allow_preview) {
        if (rule.primary_model_id.includes('exp') || rule.primary_model_id.includes('preview')) {
            trace.push(`[Guard] Preview/Exp models forbidden in prod by DB rule.`);
            rule.primary_model_id = 'gemini-1.5-flash';
        }
    }

    // 1. Пытаемся взять Primary
    let selectedModel = rule.primary_model_id;
    let isFallbackActive = false;
    let primaryExhausted = await quotaGuard.isRpdExhaustedForModel(selectedModel);

    // Дополнительная проверка RPM или других блокеров могла бы быть тут.
    // Пока проверяем RPD.

    if (primaryExhausted) {
        trace.push(`[Quota] Primary model ${selectedModel} is EXHAUSTED (RPD).`);

        // Смотрим, как система должна реагировать на лимиты
        if (rule.on_quota_limit === 'fail_fast') {
            trace.push(`[Result] Action: fail_fast. Dropping request.`);
            throw new Error(`[Routing] Лимит основной модели исчерпан, правило предписывает Fail Fast.`);
        } else if (rule.on_quota_limit === 'queue') {
            trace.push(`[Result] Action: queue. Assuming caller will handle sleep/retry.`);
            // Мы просто возвращаем Primary, так как стратегия Queue - оркестратор задержит задачу
            selectedModel = rule.primary_model_id; 
        } else if (rule.on_quota_limit === 'fallback_model' || rule.on_quota_limit === 'graceful_degrade') {
            if (rule.fallback_model_id) {
                trace.push(`[Action] Checking fallback model: ${rule.fallback_model_id}`);
                const fallbackExhausted = await quotaGuard.isRpdExhaustedForModel(rule.fallback_model_id);
                if (fallbackExhausted) {
                    trace.push(`[Quota] Fallback model ${rule.fallback_model_id} IS ALSO EXHAUSTED.`);
                    throw new Error(`[Routing] Все доступные модели для стадии ${stageName} исчерпаны.`);
                }
                
                // Проверка размера контекста, чтобы не упасть с Payload Too Large.
                // Допустим `gemini-1.5-flash-8b` окно 1M. `gemini-1.5-pro` окно 2M.
                if (estimatedTokens > 1000000 && rule.fallback_model_id.includes('8b')) {
                    trace.push(`[Guard] Estimated tokens (${estimatedTokens}) exceeds fallback window. Fail fast.`);
                    throw new Error(`[Routing] Невозможно использовать Fallback (payload слишком большой).`);
                }

                selectedModel = rule.fallback_model_id;
                isFallbackActive = true;
                trace.push(`[Result] Using fallback model: ${selectedModel}`);
            } else {
                trace.push(`[Action] Fallback mode specified, but no fallback_model_id. Failing.`);
                throw new Error(`[Routing] Лимиты исчерпаны, резервная модель не задана.`);
            }
        } else if (rule.on_quota_limit === 'skip') {
            trace.push(`[Result] Action: skip. Aborting stage.`);
            return {
                resolved_model: 'SKIP',
                is_fallback_active: true,
                explainability_trace: trace,
                skipStage: true
            };
        }
    } else {
        trace.push(`[Result] Primary model has budget. Using: ${selectedModel}`);
    }

    return {
        resolved_model: resolveApiModelId(selectedModel),
        is_fallback_active: isFallbackActive,
        explainability_trace: trace,
        skipStage: false,
    };
}

module.exports = {
    resolveRoute
};
