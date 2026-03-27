const db = require('../db/database');
const config = require('../config');

function getSetting(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
}

function getGeminiApiKey() {
    const fromDb = getSetting('GEMINI_API_KEY');
    if (typeof fromDb === 'string' && fromDb.trim()) {
        return fromDb.trim();
    }
    return config.GEMINI_API_KEY || '';
}

function setGeminiApiKey(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error('GEMINI_API_KEY не может быть пустым');
    }
    setSetting('GEMINI_API_KEY', normalized);
}

function hasGeminiApiKey() {
    return !!getGeminiApiKey();
}

function getPublicRuntimeSettings() {
    return {
        hasGeminiApiKey: hasGeminiApiKey(),
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
