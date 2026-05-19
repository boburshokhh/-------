/**
 * Эвристика языка документа + диагностика для логов (не вызывает сеть).
 * @returns {{ lang: 'ru'|'en'|'auto', diagnostics: Record<string, number|string> }}
 */
function detectLanguageWithDiagnostics(text) {
    const fullTextLength = typeof text === 'string' ? text.length : 0;
    const sample = (text || '').slice(0, 3000);
    const cyrillicCount = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
    const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;
    const ruWords = ['и', 'в', 'на', 'что', 'это', 'для', 'не', 'по', 'как', 'из', 'при'];
    const enWords = ['the', 'and', 'is', 'in', 'to', 'of', 'for', 'with', 'that', 'on', 'are'];
    const lowerSample = sample.toLowerCase();
    const ruHits = ruWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;
    const enHits = enWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;

    let lang;
    let resolvedBy;
    if (cyrillicCount > latinCount * 1.5) {
        lang = 'ru';
        resolvedBy = 'cyrillic_ratio';
    } else if (latinCount > cyrillicCount * 1.5) {
        lang = 'en';
        resolvedBy = 'latin_ratio';
    } else if (ruHits > enHits) {
        lang = 'ru';
        resolvedBy = 'stopwords_ru';
    } else if (enHits > ruHits) {
        lang = 'en';
        resolvedBy = 'stopwords_en';
    } else {
        lang = 'auto';
        resolvedBy = 'undetermined';
    }

    return {
        lang,
        diagnostics: {
            full_text_length: fullTextLength,
            sample_chars: sample.length,
            cyrillic_count: cyrillicCount,
            latin_count: latinCount,
            ru_word_hits: ruHits,
            en_word_hits: enHits,
            resolved_by: resolvedBy,
        },
    };
}

/** Публичный API / тесты: только код языка (внутри используется detectLanguageWithDiagnostics). */
function detectLanguage(text) {
    return detectLanguageWithDiagnostics(text).lang;
}

/**
 * Язык для пайплайна: фиксированный из config или эвристика по тексту.
 * Эвристика — локальная (первые ~3000 символов), без вызовов LLM.
 * @param {string} text
 * @param {{ defaultLang?: string }} [opts] — 'ru' | 'en' из DEFAULT_DOCUMENT_LANGUAGE
 */
function resolveDocumentLanguage(text, opts = {}) {
    const fixed = opts.defaultLang && ['ru', 'en'].includes(opts.defaultLang) ? opts.defaultLang : null;
    if (fixed) {
        return {
            lang: fixed,
            diagnostics: {
                full_text_length: typeof text === 'string' ? text.length : 0,
                sample_chars: 0,
                cyrillic_count: 0,
                latin_count: 0,
                ru_word_hits: 0,
                en_word_hits: 0,
                resolved_by: 'config_default',
            },
        };
    }
    return detectLanguageWithDiagnostics(text);
}

module.exports = {
    detectLanguageWithDiagnostics,
    detectLanguage,
    resolveDocumentLanguage,
};
