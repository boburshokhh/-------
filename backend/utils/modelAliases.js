'use strict';

/**
 * Google снял gemini-2.0-flash* для многих ключей (404 NOT_FOUND).
 * Подменяем на 2.5 до обновления записей в БД / реестре.
 */
const DEPRECATED_MODEL_ALIASES = Object.freeze({
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-2.0-flash-001': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite-001': 'gemini-2.5-flash-lite',
});

/** Суффиксы версий в API id: gemini-2.0-flash-001 → base gemini-2.0-flash */
const VERSION_SUFFIX_RE = /-(00[0-9]|latest|experimental)$/i;

function resolveApiModelId(modelId) {
    const m = String(modelId || '').trim();
    if (!m) return m;
    if (DEPRECATED_MODEL_ALIASES[m]) return DEPRECATED_MODEL_ALIASES[m];

    const base = m.replace(VERSION_SUFFIX_RE, '');
    if (base !== m && DEPRECATED_MODEL_ALIASES[base]) return DEPRECATED_MODEL_ALIASES[base];

    if (/^gemini-2\.0-flash-lite/i.test(m)) return 'gemini-2.5-flash-lite';
    if (/^gemini-2\.0-flash/i.test(m)) return 'gemini-2.5-flash';

    return m;
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
