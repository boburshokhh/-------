const crypto = require('crypto');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');
const aiModelUsageRepo = require('../db/repositories/aiModelUsageRepo');
const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiModelRegistryService = require('./aiModelRegistryService');

const BUCKETS = ['embedding', 'cheap_generation', 'standard_generation', 'premium_reasoning'];

function utcDateString() {
    return new Date().toISOString().slice(0, 10);
}

async function getKeyFingerprint() {
    const key = await runtimeConfig.getGeminiApiKey();
    if (!key) return '';
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function guardCfg() {
    return config.AI_BUDGET_GUARDS || {};
}

function budgetGuardsActive() {
    if (config.LOCAL_GEMINI_QUOTA_ENABLED !== true) return false;
    return guardCfg().enabled !== false;
}

function getLimitsForModel(modelId) {
    if (!modelId) return null;
    return config.FREE_TIER_QUOTAS[modelId] || config.FREE_TIER_QUOTA_DEFAULT || null;
}

function softRpdLimit(modelId) {
    const lim = getLimitsForModel(modelId);
    if (!lim || lim.rpd == null) return null;
    const frac = guardCfg().rpdSoftFraction ?? 0.85;
    return Math.max(1, Math.floor(lim.rpd * frac));
}

/**
 * Бюджетная фаза для записи в ai_model_usage (совпадает со «stage» для правил).
 */
function inferBudgetPhaseFromModel(modelId, opts = {}) {
    if (opts.budgetPhase && BUCKETS.includes(opts.budgetPhase)) return opts.budgetPhase;
    if (opts.stage && BUCKETS.includes(opts.stage)) return opts.stage;
    const id = String(modelId || '').toLowerCase();
    if (!id) return 'standard_generation';
    if (id.includes('embedding')) return 'embedding';
    if (id.includes('flash-lite') || id.includes('flash_lite')) return 'cheap_generation';
    if (id.includes('pro') && !id.includes('flash')) return 'premium_reasoning';
    if (id.includes('flash')) return 'standard_generation';
    return 'standard_generation';
}

function isFlashFamily(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('flash') && !id.includes('flash-lite') && !id.includes('flash_lite');
}

function isPremiumModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('pro') && !id.includes('flash');
}

function isPreviewModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('preview') || id.includes('experimental');
}

/**
 * @param {string} modelId api_model_id
 * @param {string} stage embedding | cheap_generation | standard_generation | premium_reasoning
 */
async function canUseModelForStage(modelId, stage, opts = {}) {
    if (opts.bypassLimits) {
        return { allowed: true, reason: null };
    }
    const g = guardCfg();
    if (!budgetGuardsActive()) {
        return { allowed: true, reason: null };
    }
    if (!modelId || !BUCKETS.includes(stage)) {
        return { allowed: true, reason: null };
    }

    const snap = await getUsageSnapshot();
    const flags = snap.flags;

    const preview = isPreviewModelId(modelId) || (await isPreviewInRegistry(modelId));
    if (preview && flags.previewRoutingBlocked && stage !== 'premium_reasoning') {
        return { allowed: false, reason: 'preview_error_rate_high', suggestedModel: pickNonPreviewStandard() };
    }

    if (isPremiumModelId(modelId) && stage !== 'premium_reasoning') {
        if (flags.premiumBudgetTight) {
            return {
                allowed: false,
                reason: 'premium_usage_over_threshold',
                suggestedModel: config.LLM_MODEL || 'gemini-2.5-flash',
            };
        }
    }

    if (stage === 'cheap_generation' && isFlashFamily(modelId)) {
        if (flags.flashBudgetTightForCheap) {
            return {
                allowed: false,
                reason: 'flash_usage_high_use_lite',
                suggestedModel: config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite',
            };
        }
    }

    return { allowed: true, reason: null };
}

async function isPreviewInRegistry(apiModelId) {
    try {
        const row = await aiModelsRepo.getModelByApiModelId(apiModelId);
        return !!(row && row.is_preview);
    } catch {
        return false;
    }
}

function pickNonPreviewStandard() {
    const id = config.LLM_MODEL || 'gemini-2.5-flash';
    return isPreviewModelId(id) ? (config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite') : id;
}

/**
 * Fallback по стадии (строка — api model id).
 */
function getFallbackModel(stage) {
    switch (stage) {
        case 'embedding':
            return config.EMBEDDING_MODEL || 'gemini-embedding-001';
        case 'cheap_generation':
            return config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite';
        case 'premium_reasoning':
            return config.LLM_PREMIUM_MODEL || 'gemini-2.5-pro';
        case 'standard_generation':
        default:
            return config.LLM_MODEL || 'gemini-2.5-flash';
    }
}

function ratio(used, soft) {
    if (soft == null || soft <= 0) return 0;
    return used / soft;
}

/**
 * Снимок по ai_model_usage за UTC-сегодня + флаги правил.
 */
async function getUsageSnapshot() {
    const g = guardCfg();
    const fp = await getKeyFingerprint();
    const date = utcDateString();

    const empty = {
        usageDateUtc: date,
        buckets: {
            embedding: { requests: 0, failed: 0, softLimit: softRpdLimit(config.EMBEDDING_MODEL) },
            cheap_generation: { requests: 0, failed: 0, softLimit: softRpdLimit(config.SUMMARY_CHEAP_MODEL) },
            standard_generation: { requests: 0, failed: 0, softLimit: softRpdLimit(config.LLM_MODEL) },
            premium_reasoning: { requests: 0, failed: 0, softLimit: softRpdLimit(config.LLM_PREMIUM_MODEL) },
        },
        flags: {
            premiumBudgetTight: false,
            flashBudgetTightForCheap: false,
            previewRoutingBlocked: false,
            previewErrorRate: 0,
        },
        source: 'ai_model_usage',
    };

    if (!fp || !budgetGuardsActive()) {
        return empty;
    }

    let rows;
    try {
        rows = await aiModelUsageRepo.listUsageWithModelsForDate({ keyFingerprint: fp, usageDate: date });
    } catch {
        return empty;
    }

    const buckets = { ...empty.buckets };
    let previewReq = 0;
    let previewFail = 0;

    for (const r of rows) {
        const apiId = r.api_model_id || '';
        const phase = BUCKETS.includes(r.phase) ? r.phase : inferBudgetPhaseFromModel(apiId);
        if (!buckets[phase]) buckets[phase] = { requests: 0, failed: 0, softLimit: null };
        buckets[phase].requests += Number(r.requests) || 0;
        buckets[phase].failed += Number(r.failed_requests) || 0;

        if (r.is_preview) {
            previewReq += Number(r.requests) || 0;
            previewFail += Number(r.failed_requests) || 0;
        }
    }

    for (const b of BUCKETS) {
        const limKey =
            b === 'embedding'
                ? config.EMBEDDING_MODEL
                : b === 'cheap_generation'
                  ? config.SUMMARY_CHEAP_MODEL
                  : b === 'premium_reasoning'
                    ? config.LLM_PREMIUM_MODEL
                    : config.LLM_MODEL;
        buckets[b].softLimit = softRpdLimit(limKey);
    }

    const premSoft = buckets.premium_reasoning.softLimit || 1;
    const stdSoft = buckets.standard_generation.softLimit || 1;
    const flashSoft = buckets.standard_generation.softLimit || 1;
    const premUsed = buckets.premium_reasoning.requests;
    const stdUsed = buckets.standard_generation.requests;

    const premTh = g.premiumUsageRatioThreshold ?? 0.35;
    const premVsStdMax = g.premiumVsStandardMaxRatio ?? 0.4;
    const flashTh = g.flashUsageRatioThreshold ?? 0.65;
    const flashForCheapMax = g.flashForCheapMaxRatio ?? 0.5;
    const previewErrTh = g.previewErrorRateThreshold ?? 0.2;

    const premiumBudgetTight =
        ratio(premUsed, premSoft) > premTh || (stdUsed > 0 && premUsed / Math.max(1, stdUsed) > premVsStdMax);

    const flashBudgetTightForCheap = ratio(stdUsed, flashSoft) > flashTh || ratio(stdUsed, flashSoft) > flashForCheapMax;

    const previewTotal = previewFail + previewReq;
    const previewErrorRate = previewTotal > 0 ? previewFail / previewTotal : 0;
    const previewRoutingBlocked =
        previewTotal >= (guardCfg().previewMinSamples ?? 5) && previewErrorRate >= previewErrTh;

    return {
        usageDateUtc: date,
        buckets,
        flags: {
            premiumBudgetTight,
            flashBudgetTightForCheap,
            previewRoutingBlocked,
            previewErrorRate,
        },
        source: 'ai_model_usage',
    };
}

function createBudgetError(message, details) {
    const e = new Error(message);
    e.status = 429;
    e.type = 'BUDGET_GUARD';
    e.details = details;
    return e;
}

/**
 * Мягкая проверка бюджета (после assertWithinFreeTierQuota).
 */
async function assertBudgetAllows(modelId, opts = {}) {
    if (opts.bypassLimits) return;
    if (!budgetGuardsActive()) return;
    const stage = opts.stage || inferBudgetPhaseFromModel(modelId, opts);
    const { allowed, reason, suggestedModel } = await canUseModelForStage(modelId, stage, opts);
    if (!allowed) {
        throw createBudgetError(
            reason === 'premium_usage_over_threshold'
                ? 'Превышен мягкий бюджет premium: для этой стадии выберите стандартную модель.'
                : reason === 'flash_usage_high_use_lite'
                  ? 'Высокая нагрузка на Flash: для дешёвых задач используйте Flash Lite.'
                  : reason === 'preview_error_rate_high'
                    ? 'Высокий процент ошибок preview-моделей: временно отключён auto-routing на preview.'
                    : 'Бюджетная политика ограничивает использование этой модели.',
            { modelId, stage, reason, suggestedModel },
        );
    }
}

async function recordAiModelUsageSuccess(modelId, opts = {}) {
    if (!budgetGuardsActive()) return;
    const fp = await getKeyFingerprint();
    if (!fp || !modelId) return;
    const phase = inferBudgetPhaseFromModel(modelId, opts);
    try {
        await aiModelRegistryService.recordUsageByApiModelId({
            keyFingerprint: fp,
            apiModelId: modelId,
            phase,
            requestsDelta: opts.requestsDelta ?? 1,
        });
    } catch (e) {
        console.warn('[BUDGET] recordAiModelUsageSuccess:', e.message);
    }
}

async function recordAiModelUsageFailure(modelId, opts = {}) {
    if (!budgetGuardsActive()) return;
    const fp = await getKeyFingerprint();
    if (!fp || !modelId) return;
    const phase = inferBudgetPhaseFromModel(modelId, opts);
    const aiModelId = await aiModelsRepo.findModelIdByApiModelId(modelId);
    if (!aiModelId) return;
    try {
        await aiModelUsageRepo.incrementFailed({
            keyFingerprint: fp,
            aiModelId,
            phase,
            delta: opts.delta ?? 1,
        });
    } catch (e) {
        console.warn('[BUDGET] recordAiModelUsageFailure:', e.message);
    }
}

module.exports = {
    BUCKETS,
    inferBudgetPhaseFromModel,
    canUseModelForStage,
    getFallbackModel,
    getUsageSnapshot,
    assertBudgetAllows,
    recordAiModelUsageSuccess,
    recordAiModelUsageFailure,
    getKeyFingerprint,
};
