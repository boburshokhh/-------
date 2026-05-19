'use strict';

/**
 * Google отключил gemini-2.0-flash для новых ключей (404 NOT_FOUND).
 * Подменяем на актуальные 2.5 до обновления правил в БД.
 */
const DEPRECATED_MODEL_ALIASES = Object.freeze({
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
});

function resolveApiModelId(modelId) {
    const m = String(modelId || '').trim();
    if (!m) return m;
    return DEPRECATED_MODEL_ALIASES[m] || m;
}

function resolveApiModelChain(modelIds) {
    const out = [];
    const seen = new Set();
    for (const raw of modelIds || []) {
        const id = resolveApiModelId(raw);
        if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

module.exports = {
    DEPRECATED_MODEL_ALIASES,
    resolveApiModelId,
    resolveApiModelChain,
};
