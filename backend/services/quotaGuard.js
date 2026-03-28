const crypto = require('crypto');
const quotaRepo = require('../db/repositories/quotaRepo');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');
const { parseGeminiApiError } = require('./geminiError');

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

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

/**
 * Ждём, пока можно сделать вызов без нарушения RPM (дневной лимит — сразу ошибка).
 * Нужен для индексации: серия summary быстрее ~10/мин провоцирует «зависание» ответа API без явного 429.
 */
/**
 * Локальный учёт: исчерпан ли дневной лимит generateContent для модели (без новых вызовов API).
 */
async function isRpdExhaustedForModel(modelId) {
    if (!modelId) return false;
    const limits = getLimitsForModel(modelId);
    if (!limits) return false;
    const fp = await getKeyFingerprint();
    if (!fp) return false;
    const used = await quotaRepo.getUsage(fp, utcDateString(), modelId);
    return used >= limits.rpd;
}

async function waitUntilQuotaAllows(modelId, options = {}) {
    const maxWaitMs = options.maxWaitMs ?? (config.QUOTA_RPM_WAIT_MAX_MS || 600000);
    const pollMs = options.pollMs ?? 500;
    const deadline = Date.now() + maxWaitMs;
    let lastRpm = null;
    let lastLog = 0;
    while (Date.now() < deadline) {
        try {
            await assertWithinFreeTierQuota(modelId);
            return;
        } catch (e) {
            if (e.type !== 'QUOTA_EXCEEDED') throw e;
            if (e.details?.limit === 'rpd') throw e;
            if (e.details?.limit === 'rpm') {
                lastRpm = e;
                const now = Date.now();
                if (now - lastLog > 30_000) {
                    lastLog = now;
                    const sec = Math.max(0, Math.round((deadline - now) / 1000));
                    console.warn(
                        `[QUOTA] Ожидание слота RPM для ${modelId} (осталось ≤ ${sec} с до таймаута ожидания)…`,
                    );
                }
                await sleep(pollMs);
                continue;
            }
            throw e;
        }
    }
    const err = new Error(
        lastRpm?.message || `Таймаут ожидания слота RPM для ${modelId} (${Math.round(maxWaitMs / 1000)} с)`,
    );
    err.type = 'QUOTA_EXCEEDED';
    err.status = 429;
    err.details = { ...(lastRpm?.details || {}), modelId, limit: 'rpm', timeout: true };
    throw err;
}

/**
 * После 429 с дневной квотой free tier синхронизируем локальный учёт с лимитом,
 * чтобы не слать десятки бесполезных запросов подряд.
 * @returns {Promise<boolean>} true если учёт обновлён
 */
async function syncFromGoogle429(modelId, err) {
    const p = parseGeminiApiError(err);
    if (!p.isResourceExhausted || !p.isDailyFreeTierQuota) return false;
    const limits = getLimitsForModel(modelId);
    if (!limits) return false;
    const fp = await getKeyFingerprint();
    if (!fp) return false;
    await quotaRepo.setUsageAtLeast(fp, utcDateString(), modelId, limits.rpd);
    console.warn(
        `[QUOTA] Синхронизация с ответом Google: дневной лимит free tier для ${modelId} (локально ≥ ${limits.rpd} запросов за UTC-сутки).`,
    );
    return true;
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
    isRpdExhaustedForModel,
    waitUntilQuotaAllows,
    recordGeminiCall,
    syncFromGoogle429,
    resetUsageForNewApiKey,
    getUsageSummaryPublic,
};
