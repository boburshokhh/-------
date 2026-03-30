const crypto = require('crypto');
const quotaRepo = require('../db/repositories/quotaRepo');
const config = require('../config');
const { parseGeminiApiError } = require('./geminiError');

const RPM_WINDOW_MS = 60 * 1000;
const phaseCounters = new Map(); // traceId -> { phase: count }

async function getKeyFingerprint() {
    const runtimeConfig = require('./runtimeConfig');
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

    // 1. Check & Update RPM optimistically in DB
    const rpmCount = await quotaRepo.getRpmCount(fp, modelId, RPM_WINDOW_MS);
    if (rpmCount >= limits.rpm) {
        throw createQuotaError(
            `Превышен лимит запросов в минуту (free tier: ${limits.rpm} RPM) для модели ${modelId}. Подождите до минуты.`,
            { modelId, limit: 'rpm', max: limits.rpm },
        );
    }
    // Optimistic lock for RPM (now handled directly in DB)
    await quotaRepo.recordRpmHit(fp, modelId);

    // 2. Check & Update RPD (direct DB query via PG is <1ms, so cache removed)
    const usedDay = await quotaRepo.getUsage(fp, date, modelId);

    if (usedDay >= limits.rpd) {
        throw createQuotaError(
            `Достигнут дневной лимит free tier для этой модели (${limits.rpd} запросов/сутки, UTC). Завтра лимит обновится, либо задайте другой API-ключ в настройках.`,
            { modelId, limit: 'rpd', max: limits.rpd, used: usedDay },
        );
    }
}

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
    const maxWaitMs = options.maxWaitMs ?? (config.QUOTA_RPM_WAIT_MAX_MS || 60000);
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
    if (!p.isResourceExhausted) return false;

    if (!p.isDailyFreeTierQuota) {
        // Cluster RPM exhausted (Google hit RPM limit but our local didn't block it)
        const limits = getLimitsForModel(modelId);
        if (limits) {
            const fp = await getKeyFingerprint();
            if (fp) {
                // To simulate cluster RPM exhaust, record multiple hits
                for (let i = 0; i < limits.rpm; i++) {
                    await quotaRepo.recordRpmHit(fp, modelId);
                }
            }
            console.warn(`[QUOTA] Синхронизация с 429: исчерпан кластерный RPM для ${modelId}, worker приостановлен.`);
        }
        return false;
    }

    const limits = getLimitsForModel(modelId);
    if (!limits) return false;
    const fp = await getKeyFingerprint();
    if (!fp) return false;
    const date = utcDateString();

    await quotaRepo.setUsageAtLeast(fp, date, modelId, limits.rpd);

    console.warn(
        `[QUOTA] Синхронизация с ответом Google: дневной лимит free tier для ${modelId} (локально ≥ ${limits.rpd} запросов за UTC-сутки).`,
    );
    return true;
}

async function recordGeminiCall(modelId, opts = {}) {
    if (!modelId) return;
    const limits = getLimitsForModel(modelId);
    if (!limits) return;

    const fp = await getKeyFingerprint();
    if (!fp) return;

    const date = utcDateString();
    await quotaRepo.recordUsage(fp, date, modelId);

    if (opts.phase && opts.traceId) {
        let entry = phaseCounters.get(opts.traceId);
        if (!entry) {
            entry = {};
            phaseCounters.set(opts.traceId, entry);
        }
        entry[opts.phase] = (entry[opts.phase] || 0) + 1;
    }
}

function getPhaseUsage(traceId) {
    return phaseCounters.get(traceId) || {};
}

function resetUsageForNewApiKey() {
    // Внимание: мы больше НЕ сбрасываем историю в базе данных!
    // Каждая запись в БД привязана к fingerprint ключа. При ротации ключа
    // новый ключ начнёт с нуля, а старый сохранит свою историю.
    // Если пользователь вернёт старый ключ сегодня, его лимит не будет превышен обманным путём.
    // History in DB is kept, new keys start fresh automatically.
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

async function getAvailableModel(preferredModelId) {
    if (!preferredModelId) return null;

        // Check primary model
        if (!(await isRpdExhaustedForModel(preferredModelId))) {
            return preferredModelId;
        }

        console.warn(`[QUOTA] Дневной лимит (RPD) для основной модели ${preferredModelId} исчерпан. Поиск доступного fallback...`);

        // Check fallback chain
        const chain = config.LLM_FALLBACK_CHAIN && config.LLM_FALLBACK_CHAIN[preferredModelId]
            ? config.LLM_FALLBACK_CHAIN[preferredModelId]
            : [];

        for (const fallbackModel of chain) {
            if (!(await isRpdExhaustedForModel(fallbackModel))) {
                console.warn(`[QUOTA] Fallback успешен: переключение на ${fallbackModel}`);
                return fallbackModel;
            }
        }

    console.warn(`[QUOTA] Ни одна запасная модель из Fallback-цепочки недоступна (RPD исчерпаны).`);
    return null;
}

module.exports = {
    getLimitsForModel,
    assertWithinFreeTierQuota,
    isRpdExhaustedForModel,
    waitUntilQuotaAllows,
    recordGeminiCall,
    syncFromGoogle429,
    getUsageSummaryPublic,
    getKeyFingerprint,
    resetUsageForNewApiKey,
    getAvailableModel,
    getPhaseUsage,
};