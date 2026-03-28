const crypto = require('crypto');
const quotaRepo = require('../db/repositories/quotaRepo');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');

const RPM_WINDOW_MS = 60 * 1000;
const rpmHits = new Map();

async function getKeyFingerprint() {
    const key = await runtimeConfig.getGeminiApiKey();
    if (!key) return '';
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function utcDateString() {
    return new Date().toISOString().slice(0, 10);
}

function getLimitsForModel(modelId) {
    if (!modelId) return null;
    return config.FREE_TIER_QUOTAS[modelId] || config.FREE_TIER_QUOTA_DEFAULT || null;
}

function createQuotaError(message, details) {
    const e = new Error(message);
    e.status = 429;
    e.type = 'QUOTA_EXCEEDED';
    e.details = details;
    return e;
}

function pruneRpm(modelId) {
    const now = Date.now();
    let arr = rpmHits.get(modelId) || [];
    arr = arr.filter((t) => now - t < RPM_WINDOW_MS);
    rpmHits.set(modelId, arr);
    return arr;
}

async function assertWithinFreeTierQuota(modelId) {
    if (!modelId) return;
    const limits = getLimitsForModel(modelId);
    if (!limits) return;

    const fp = await getKeyFingerprint();
    if (!fp) return;

    const date = utcDateString();
    const usedDay = await quotaRepo.getUsage(fp, date, modelId);
    if (usedDay >= limits.rpd) {
        throw createQuotaError(
            `Достигнут дневной лимит free tier для этой модели (${limits.rpd} запросов/сутки, UTC). Завтра лимит обновится, либо задайте другой API-ключ в настройках.`,
            { modelId, limit: 'rpd', max: limits.rpd, used: usedDay },
        );
    }

    const arr = pruneRpm(modelId);
    if (arr.length >= limits.rpm) {
        throw createQuotaError(
            `Превышен лимит запросов в минуту (free tier: ${limits.rpm} RPM) для модели ${modelId}. Подождите до минуты.`,
            { modelId, limit: 'rpm', max: limits.rpm },
        );
    }
}

async function recordGeminiCall(modelId) {
    if (!modelId) return;
    const limits = getLimitsForModel(modelId);
    if (!limits) return;

    const fp = await getKeyFingerprint();
    if (!fp) return;

    const date = utcDateString();
    await quotaRepo.recordUsage(fp, date, modelId);

    const arr = pruneRpm(modelId);
    arr.push(Date.now());
    rpmHits.set(modelId, arr);
}

async function resetUsageForNewApiKey() {
    try {
        await quotaRepo.resetUsage();
    } catch (e) {
        console.warn('[QUOTA] Не удалось очистить gemini_usage:', e.message);
    }
    rpmHits.clear();
}

async function getUsageSummaryPublic() {
    const fp = await getKeyFingerprint();
    const date = utcDateString();
    const rows = fp ? await quotaRepo.getUsageSummary(fp, date) : [];
    const usedByModel = {};
    for (const r of rows) {
        usedByModel[r.model_id] = r.requests;
    }

    const ids = new Set([
        ...Object.keys(config.FREE_TIER_QUOTAS || {}),
        ...(config.LLM_MODELS || []).map((m) => m.id),
        config.EMBEDDING_MODEL,
    ].filter(Boolean));

    const perModel = {};
    for (const id of ids) {
        const lim = getLimitsForModel(id);
        if (!lim) continue;
        perModel[id] = {
            usedToday: usedByModel[id] || 0,
            rpd: lim.rpd,
            rpm: lim.rpm,
            tpm: lim.tpm,
        };
    }

    return {
        tier: config.GEMINI_QUOTA_TIER || 'free',
        usageDateUtc: date,
        perModel,
    };
}

module.exports = {
    getLimitsForModel,
    assertWithinFreeTierQuota,
    recordGeminiCall,
    resetUsageForNewApiKey,
    getUsageSummaryPublic,
};
