'use strict';

/**
 * Публичный снимок настроек маршрутизации для страницы генерации (без admin).
 */

const modelRouter = require('./modelRouter');
const routingEngine = require('./routingEngine');
const quotaGuard = require('./quotaGuard');
const aiRoutingConfigRepo = require('../db/repositories/aiRoutingConfigRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const operationalGuardrails = require('./operationalGuardrails');
const { STAGE_KEYS } = require('../config/stageTaxonomy');

const BUILTIN_MODES = new Set(['auto', 'economy', 'balanced', 'quality', 'manual']);

function normalizeMode(raw) {
    const m = String(raw || 'auto').toLowerCase().trim();
    if (BUILTIN_MODES.has(m)) return m;
    // Кастомный код режима допускаем для предпросмотра, если это валидный slug.
    if (/^[a-z0-9][a-z0-9_-]{1,63}$/.test(m)) return m;
    return 'auto';
}

/**
 * @param {object} opts
 * @param {string} [opts.requestedMode] — auto | economy | balanced | quality | manual
 * @returns {Promise<object>}
 */
async function getPublicGenerationRoutingSnapshot({ requestedMode = 'auto' } = {}) {
    const mode = normalizeMode(requestedMode);

    let baseConfig = null;
    let globalPolicies = null;
    try {
        baseConfig = await aiRoutingConfigRepo.getRoutingConfig();
    } catch { /* ignore */ }
    try {
        globalPolicies = await aiGlobalPoliciesRepo.getPolicies();
    } catch { /* ignore */ }

    let effectiveMode = mode;
    try {
        effectiveMode = await modelRouter.resolveEffectiveMode(mode);
    } catch {
        effectiveMode = mode === 'auto' ? (baseConfig?.routing_mode || 'auto') : mode;
    }

    const quotaSnap = await quotaGuard.getUsageSnapshot().catch(() => ({ flags: {} }));

    let premiumBudget = { allowed: true, reason: 'unknown' };
    try {
        premiumBudget = await operationalGuardrails.checkPremiumBudget({});
    } catch (e) {
        premiumBudget = { allowed: true, reason: 'check_failed', error: e.message };
    }

    const explanations = [];
    if (mode === 'auto') {
        const gm = baseConfig?.routing_mode || 'auto';
        if (gm && gm !== 'auto') {
            explanations.push(
                `Режим «auto» подставляет базовый режим администратора: «${gm}».`,
            );
        } else {
            explanations.push(
                'Режим «auto»: в конфиге указан «auto» — эффективный режим выбирается эвристиками и лимитами (см. effective_mode).',
            );
        }
    } else if (mode !== 'manual') {
        explanations.push(`Выбран режим «${mode}»: приоритет у стоимости/качества в зависимости от режима.`);
    } else {
        explanations.push('Режим «manual»: используется модель из вашего выбора (если разрешено квотой и политиками).');
    }

    const downgradeActive = !!(globalPolicies?.emergency_downgrade);
    if (downgradeActive) {
        explanations.push('Включён аварийный downgrade: приоритет у стабильных экономичных моделей.');
    }

    const stableOnly = !!(globalPolicies?.stable_only);
    if (stableOnly) {
        explanations.push('Включено «только стабильные модели»: preview-модели не используются.');
    }

    if (globalPolicies?.premium_guard_enabled && premiumBudget.warning) {
        explanations.push(
            `Расход premium приближается к мягкому лимиту (~${premiumBudget.premiumPercent ?? '?'}% сегодня).`,
        );
    }
    if (globalPolicies?.premium_guard_enabled && premiumBudget.allowed === false) {
        explanations.push('Premium сейчас ограничен политикой дневного бюджета.');
    }

    const flags = quotaSnap.flags || {};
    if (flags.premiumBudgetTight) {
        explanations.push('Система снизила использование premium из‑за лимитов бюджета (premium_budget_tight).');
    }
    if (flags.flashBudgetTightForCheap) {
        explanations.push('Flash-class под нагрузкой по бюджету — дешёвые стадии могут перейти на другую модель.');
    }
    if (flags.previewRoutingBlocked) {
        explanations.push('Preview-модели временно отключены из‑за высокой ошибки (preview_routing_blocked).');
    }

    /** Предпросмотр моделей по стадиям для UI (эвристика: complexity 0.4, 1 стр.); отдельный endpoint не требуется. */
    const stagePreview = {};
    try {
        const v2 = await modelRouter.resolvePipelineModelsV2({
            routingMode: mode,
            documentMetadata: { page_count: 1 },
            complexityScore: 0.4,
            quotaSnapshot: quotaSnap,
            adminOverrides: {},
            traceId: 'ui-preview',
            documentId: null,
            runId: null,
        });
        if (v2?.decisions) {
            const keys = [
                STAGE_KEYS.question_generation,
                STAGE_KEYS.blueprint_generation,
                STAGE_KEYS.grounding_validation,
                STAGE_KEYS.embedding,
            ];
            for (const k of keys) {
                const d = v2.decisions[k];
                if (d) {
                    stagePreview[k] = {
                        selected: d.selectedModel,
                        fallback: d.fallbackModel,
                        reason: d.reason,
                        cost_tier: d.costTier,
                        premium_blocked: !!d.premiumBlocked,
                        preview_blocked: !!d.previewBlocked,
                    };
                }
            }
        }
    } catch (e) {
        stagePreview._error = e.message;
    }

    return {
        requested_mode: mode,
        effective_mode: effectiveMode,
        base_config_routing_mode: baseConfig?.routing_mode ?? 'auto',
        policies: globalPolicies
            ? {
                stable_only: !!globalPolicies.stable_only,
                emergency_downgrade: !!globalPolicies.emergency_downgrade,
                premium_guard_enabled: globalPolicies.premium_guard_enabled !== false,
                premium_soft_limit_percent: globalPolicies.premium_soft_limit_percent ?? 20,
                max_premium_percent_per_day: globalPolicies.max_premium_percent_per_day ?? 25,
                preview_canary_percent: globalPolicies.preview_canary_percent ?? 0,
            }
            : null,
        quota_flags: flags,
        premium_budget: {
            allowed: premiumBudget.allowed !== false,
            reason: premiumBudget.reason || null,
            premium_percent: premiumBudget.premiumPercent ?? null,
            warning: !!premiumBudget.warning,
        },
        downgrade_active: downgradeActive,
        stage_preview: stagePreview,
        explanations,
    };
}

module.exports = { getPublicGenerationRoutingSnapshot, normalizeMode };
