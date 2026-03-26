const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const config = require('../config');
const { parsePDFWithOCR } = require('./pdfOcr');
const { extractPdfBestEffort } = require('./pdfTextExtract');
const { scoreExtraction } = require('../utils/extractionQuality');

/**
 * Извлечение текста из PDF или DOCX.
 * @returns {Promise<{
 *   text: string,
 *   pageCount: number|null,
 *   rawText: string,
 *   diagnostics: object
 * }>}
 */
async function parseDocument(filePath, mimeType) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.pdf' || mimeType === 'application/pdf') {
        return parsePDF(filePath);
    }

    if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        return parseDOCX(filePath);
    }

    const err = new Error(`Неподдерживаемый формат файла: ${ext}`);
    err.type = 'INVALID_FILE_TYPE';
    throw err;
}

async function parsePDF(filePath) {
    const buffer = fs.readFileSync(filePath);
    const minLen = config.MIN_TEXT_LENGTH;

    const diag = {
        format: 'pdf',
        steps: [],
        mammothMessages: [],
    };

    const {
        text: extractedRaw,
        pageCount,
        method,
        warnings,
    } = await extractPdfBestEffort(buffer, {
        minTextLength: minLen,
        minCharsPerPageToSkipFallback: config.PDF_MIN_CHARS_PER_PAGE_SKIP_FALLBACK ?? 120,
    });

    diag.steps.push({ method, warnings: warnings || [] });
    let text = extractedRaw.trim();
    const pages = Math.max(1, pageCount || 1);

    if (text && text.length >= minLen) {
        const cleaned = cleanText(text);
        const quality = scoreExtraction({
            text: cleaned,
            pageCount: pages,
            method: method || 'pdf-parse',
            warnings: warnings || [],
        });
        diag.parseMethod = method;
        return {
            text: preserveTechnicalSpacing(cleaned),
            pageCount: pages,
            rawText: text,
            diagnostics: buildDiagnostics(diag, quality),
        };
    }

    if (config.ENABLE_PDF_OCR && pages > 0) {
        if (pages > config.MAX_OCR_PAGES) {
            const err = new Error(
                `Для OCR разрешено не более ${config.MAX_OCR_PAGES} страниц. В документе ${pages} стр. Уменьшите файл или отключите OCR.`
            );
            err.type = 'PARSE_ERROR';
            throw err;
        }
        try {
            console.log(`[OCR] Запуск распознавания текста (OCR) для PDF: ${pages} стр. — может занять несколько минут`);
            const ocrResult = await parsePDFWithOCR(filePath, pages);
            const ocrRaw = ocrResult.text.trim();
            const cleaned = cleanText(ocrRaw);
            const quality = scoreExtraction({
                text: cleaned,
                pageCount: pages,
                method: 'ocr',
                warnings: ['Текст получен через OCR (скан)'],
            });
            diag.steps.push({ method: 'tesseract', pages });
            diag.parseMethod = 'ocr';
            return {
                text: preserveTechnicalSpacing(cleaned),
                pageCount: ocrResult.pageCount,
                rawText: ocrRaw,
                diagnostics: buildDiagnostics(diag, quality),
            };
        } catch (ocrErr) {
            if (ocrErr.type === 'PARSE_ERROR') throw ocrErr;
            const err = new Error(
                'PDF не содержит текстового слоя. OCR не сработал: ' + (ocrErr.message || 'установите GraphicsMagick.')
            );
            err.type = 'PARSE_ERROR';
            throw err;
        }
    }

    const err = new Error(
        'PDF не содержит текстового слоя. Возможно, это отсканированный документ. Включите OCR (ENABLE_PDF_OCR) и установите GraphicsMagick.'
    );
    err.type = 'PARSE_ERROR';
    throw err;
}

async function parseDOCX(filePath) {
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });

    const mammothMessages = (result.messages || []).map((m) => ({
        type: m.type,
        message: m.message,
    }));
    if (mammothMessages.length) {
        console.warn(`[DOCX] mammoth: ${mammothMessages.length} сообщений (шрифты/конвертация)`);
    }

    const text = (result.value || '').trim();

    if (!text || text.length < config.MIN_TEXT_LENGTH) {
        const err = new Error('Документ Word пуст или содержит слишком мало текста.');
        err.type = 'PARSE_ERROR';
        throw err;
    }

    const cleaned = cleanText(text);
    const quality = scoreExtraction({
        text: cleaned,
        pageCount: null,
        method: 'mammoth',
        warnings: mammothMessages.map((m) => m.message),
    });

    const diag = {
        format: 'docx',
        mammothMessages,
        parseMethod: 'mammoth',
    };

    return {
        text: preserveTechnicalSpacing(cleaned),
        pageCount: null,
        rawText: text,
        diagnostics: buildDiagnostics(diag, quality),
    };
}

/**
 * Мягкое сохранение пробелов вокруг единиц и цифр (не ломает целые слова).
 */
function preserveTechnicalSpacing(text) {
    return text
        .replace(/(\d)\s*([°%‰№§])/g, '$1 $2')
        .replace(/([А-Яа-яA-Za-z]{2,})\s*([×x])\s*(\d)/g, '$1 $2 $3');
}

/**
 * Очистка извлечённого текста: без агрессивного схлопывания пробелов внутри строк с цифрами.
 */
function cleanText(text) {
    return text
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^ +| +$/gm, '')
        .trim();
}

function buildDiagnostics(diag, quality) {
    return {
        ...diag,
        extractionQuality: quality.score,
        lowTextQuality: quality.lowQuality,
        metrics: quality.metrics,
    };
}

module.exports = { parseDocument, cleanText };
