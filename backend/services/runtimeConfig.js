const settingsRepo = require('../db/repositories/settingsRepo');
const config = require('../config');

let cachedApiKey = null;
let cacheTs = 0;
const CACHE_TTL = 30000;

async function getSetting(key) {
    return settingsRepo.getSetting(key);
}

async function setSetting(key, value) {
    return settingsRepo.setSetting(key, value);
}

async function getGeminiApiKey() {
    if (cachedApiKey && Date.now() - cacheTs < CACHE_TTL) return cachedApiKey;
    const fromDb = await settingsRepo.getSetting('GEMINI_API_KEY');
    if (typeof fromDb === 'string' && fromDb.trim()) {
        cachedApiKey = fromDb.trim();
        cacheTs = Date.now();
        return cachedApiKey;
    }
    return config.GEMINI_API_KEY || '';
}

async function setGeminiApiKey(value) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error('GEMINI_API_KEY не может быть пустым');
    await settingsRepo.setSetting('GEMINI_API_KEY', normalized);
    cachedApiKey = normalized;
    cacheTs = Date.now();
    const quotaGuard = require('./quotaGuard');
    await quotaGuard.resetUsageForNewApiKey();
}

async function hasGeminiApiKey() {
    return !!(await getGeminiApiKey());
}

async function getPublicRuntimeSettings() {
    const quotaGuard = require('./quotaGuard');
    return {
        hasGeminiApiKey: await hasGeminiApiKey(),
        geminiQuota: await quotaGuard.getUsageSummaryPublic(),
    };
}

module.exports = {
    getSetting,
    setSetting,
    getGeminiApiKey,
    setGeminiApiKey,
    hasGeminiApiKey,
    getPublicRuntimeSettings,
};
