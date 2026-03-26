const { pathToFileURL } = require('url');
const pdfParse = require('pdf-parse');

let pdfjsModulePromise = null;

function loadPdfJs() {
    if (!pdfjsModulePromise) {
        pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsModulePromise;
}

/**
 * Настраивает worker для pdf.js в Node (один раз на процесс).
 */
async function ensurePdfJsWorker() {
    const pdfjs = await loadPdfJs();
    if (pdfjs.GlobalWorkerOptions.workerSrc) return pdfjs;
    try {
        const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    } catch (e) {
        console.warn('[PDFJS] Не удалось задать worker:', e.message);
    }
    return pdfjs;
}

/**
 * Извлечение текста через pdf-parse (быстро, тот же движок что и раньше).
 * @param {Buffer} buffer
 */
async function extractWithPdfParse(buffer) {
    const data = await pdfParse(buffer);
    return {
        text: (data.text || '').trim(),
        numPages: data.numpages || 0,
        method: 'pdf-parse',
    };
}

/**
 * Fallback: pdf.js getTextContent по страницам (лучше для части PDF со сложными шрифтами).
 * @param {Buffer} buffer
 */
async function extractWithPdfJs(buffer) {
    const pdfjs = await ensurePdfJsWorker();
    const { getDocument } = pdfjs;
    // pdf.js 4.x в Node отклоняет Buffer — нужен «чистый» Uint8Array
    const uint8 = Buffer.isBuffer(buffer)
        ? Uint8Array.from(buffer)
        : new Uint8Array(buffer);
    const loadingTask = getDocument({
        data: uint8,
        useSystemFonts: true,
        disableFontFace: false,
        isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    const parts = [];
    for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const line = textContent.items
            .map((item) => (item.str != null ? item.str : ''))
            .join(' ');
        parts.push(line);
    }
    return {
        text: parts.join('\n').trim(),
        numPages,
        method: 'pdfjs',
    };
}

/**
 * Выбирает лучший результат: при сомнительном pdf-parse пробуем pdfjs и сравниваем.
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {number} opts.minTextLength
 * @param {number} opts.minCharsPerPageToSkipFallback — если pdf-parse выше порога, pdfjs не вызываем
 */
async function extractPdfBestEffort(buffer, opts = {}) {
    const minLen = opts.minTextLength ?? 50;
    const minCppSkip = opts.minCharsPerPageToSkipFallback ?? 120;

    const primary = await extractWithPdfParse(buffer);
    const pages = primary.numPages || 1;
    const cpp = primary.text.length / Math.max(pages, 1);

    let chosen = { ...primary, warnings: [] };
    let triedPdfJs = false;

    const shouldTryPdfJs =
        primary.text.length >= minLen
        && (cpp < minCppSkip || primary.text.includes('\uFFFD'));

    if (shouldTryPdfJs || primary.text.length < minLen) {
        try {
            triedPdfJs = true;
            const secondary = await extractWithPdfJs(buffer);
            const pages2 = secondary.numPages || 1;
            const cpp2 = secondary.text.length / Math.max(pages2, 1);

            const betterLength = secondary.text.length > primary.text.length * 1.08;
            const betterDensity = cpp2 > cpp * 1.15 && secondary.text.length >= minLen;
            const fewerReplacement = (secondary.text.match(/\uFFFD/g) || []).length
                < (primary.text.match(/\uFFFD/g) || []).length;

            if (secondary.text.length >= minLen && (betterLength || betterDensity || (fewerReplacement && secondary.text.length >= primary.text.length))) {
                chosen = {
                    text: secondary.text,
                    numPages: secondary.numPages,
                    method: 'pdfjs',
                    warnings: ['Выбран fallback pdf.js (лучше плотность/объём текста)'],
                };
            } else if (primary.text.length < minLen && secondary.text.length >= minLen) {
                chosen = {
                    text: secondary.text,
                    numPages: secondary.numPages,
                    method: 'pdfjs',
                    warnings: ['Основной слой pdf-parse дал мало текста, использован pdf.js'],
                };
            } else {
                chosen.warnings = [];
            }
        } catch (e) {
            console.warn('[PDFJS] Fallback не выполнен:', e.message);
            chosen.warnings = [`pdf.js fallback: ${e.message}`];
        }
    }

    return {
        text: chosen.text,
        pageCount: chosen.numPages || pages,
        method: chosen.method,
        warnings: chosen.warnings || [],
    };
}

module.exports = {
    extractWithPdfParse,
    extractWithPdfJs,
    extractPdfBestEffort,
};
