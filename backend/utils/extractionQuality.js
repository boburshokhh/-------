/**
 * Метрики и итоговая оценка качества извлечения текста (0..1).
 * Не ломает термины: только счётчики символов и артефактов.
 */

const RE_REPLACEMENT = /\uFFFD/g;
/** Подозрительные последовательности mojibake в тексте */
const RE_MOJIBAKE_HINT = /[ÃÐÑâ€][\x00-\x7FА-Яа-я]{0,3}/g;

/**
 * @param {object} opts
 * @param {string} opts.text — извлечённый текст (до или после clean — единообразно для одного вызова)
 * @param {number|null} opts.pageCount
 * @param {string} opts.method — 'pdf-parse' | 'pdfjs' | 'mammoth' | 'ocr'
 * @param {string[]} [opts.warnings]
 * @returns {{ score: number, metrics: object, lowQuality: boolean }}
 */
function scoreExtraction({ text, pageCount, method, warnings = [] }) {
    const len = text ? text.length : 0;
    const pages = pageCount && pageCount > 0 ? pageCount : 1;
    const charsPerPage = len / pages;

    const replacementCount = text ? (text.match(RE_REPLACEMENT) || []).length : 0;
    const replacementRatio = len > 0 ? replacementCount / len : 0;
    const mojibakeHits = text ? (text.match(RE_MOJIBAKE_HINT) || []).length : 0;
    const mojibakeRatio = len > 0 ? Math.min(1, mojibakeHits / Math.max(1, len / 500)) : 0;

    // Базовая оценка: достаточно символов на страницу
    let score = 1;
    if (charsPerPage < 400) score -= 0.15;
    if (charsPerPage < 150) score -= 0.2;
    if (charsPerPage < 60) score -= 0.25;

    score -= Math.min(0.35, replacementRatio * 8);
    score -= Math.min(0.2, mojibakeRatio * 0.15);

    if (warnings.length) score -= Math.min(0.15, warnings.length * 0.03);

    if (method === 'ocr') score -= 0.05;

    score = Math.max(0, Math.min(1, score));

    const lowQuality = score < 0.42 || charsPerPage < 50 || replacementRatio > 0.02;

    const metrics = {
        charCount: len,
        pageCount: pageCount ?? null,
        charsPerPage: Math.round(charsPerPage * 10) / 10,
        replacementCount,
        replacementRatio: Math.round(replacementRatio * 10000) / 10000,
        mojibakeHints: mojibakeHits,
        method,
    };

    return { score: Math.round(score * 1000) / 1000, metrics, lowQuality };
}

module.exports = { scoreExtraction, RE_REPLACEMENT };
