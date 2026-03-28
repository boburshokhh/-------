/**
 * Локальный учёт free-tier квот по модели (по отпечатку текущего API-ключа).
 * При смене ключа счётчики сбрасываются — новый ключ = новая «корзина» на нашей стороне.
 * Реальные квоты Google остаются на стороне Google; мы не даём сжечь их быстрее локальных порогов.
 */

const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');

const RPM_WINDOW_MS = 60 * 1000;
/** modelId -> timestamps ms */
const rpmHits = new Map();

function getKeyFingerprint() {
    const key = runtimeConfig.getGeminiApiKey();
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

/**
 * Вызвать ПЕРЕД каждым успешным обращением к Gemini API для modelId.
 */
function assertWithinFreeTierQuota(modelId) {
    if (!modelId) return;
    const limits = getLimitsForModel(modelId);
    if (!limits) return;

    const fp = getKeyFingerprint();
    if (!fp) return;

    const date = utcDateString();
    const row = db.prepare(`
        SELECT requests FROM gemini_usage
        WHERE key_fingerprint = ? AND usage_date = ? AND model_id = ?
    `).get(fp, date, modelId);

    const usedDay = row ? row.requests : 0;
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
 * Вызвать ПОСЛЕ успешного ответа Gemini (чтобы не списывать попытки при сетевых ошибках).
 */
function recordGeminiCall(modelId) {
    if (!modelId) return;
    const limits = getLimitsForModel(modelId);
    if (!limits) return;

    const fp = getKeyFingerprint();
    if (!fp) return;

    const date = utcDateString();

    db.prepare(`
        INSERT INTO gemini_usage (key_fingerprint, usage_date, model_id, requests)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(key_fingerprint, usage_date, model_id) DO UPDATE SET
            requests = requests + 1
    `).run(fp, date, modelId);

    const arr = pruneRpm(modelId);
    arr.push(Date.now());
    rpmHits.set(modelId, arr);
}

function resetUsageForNewApiKey() {
    try {
        db.prepare('DELETE FROM gemini_usage').run();
    } catch (e) {
        console.warn('[QUOTA] Не удалось очистить gemini_usage:', e.message);
    }
    rpmHits.clear();
}

function getUsageSummaryPublic() {
    const fp = getKeyFingerprint();
    const date = utcDateString();
    const rows = fp
        ? db.prepare(`
            SELECT model_id, requests FROM gemini_usage
            WHERE key_fingerprint = ? AND usage_date = ?
        `).all(fp, date)
        : [];
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
