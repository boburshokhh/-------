const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const config = require('../config');
const { parsePDFWithOCR } = require('./pdfOcr');

/**
 * Извлечение текста из PDF или DOCX файла.
 * @param {string} filePath - Путь к файлу
 * @param {string} mimeType - MIME-тип файла
 * @returns {Promise<{text: string, pageCount: number|null}>}
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
    const data = await pdfParse(buffer);

    const text = data.text.trim();
    const minLen = config.MIN_TEXT_LENGTH;
    const pageCount = data.numpages || 1;

    if (text && text.length >= minLen) {
        return {
            text: cleanText(text),
            pageCount: data.numpages
        };
    }

    if (config.ENABLE_PDF_OCR && pageCount > 0) {
        if (pageCount > config.MAX_OCR_PAGES) {
            const err = new Error(
                `Для OCR разрешено не более ${config.MAX_OCR_PAGES} страниц. В документе ${pageCount} стр. Уменьшите файл или отключите OCR.`
            );
            err.type = 'PARSE_ERROR';
            throw err;
        }
        try {
            const ocrResult = await parsePDFWithOCR(filePath, pageCount);
            return {
                text: cleanText(ocrResult.text),
                pageCount: ocrResult.pageCount
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

    const text = result.value.trim();

    if (!text || text.length < config.MIN_TEXT_LENGTH) {
        const err = new Error('Документ Word пуст или содержит слишком мало текста.');
        err.type = 'PARSE_ERROR';
        throw err;
    }

    // DOCX does not have reliable page count without rendering
    return {
        text: cleanText(text),
        pageCount: null
    };
}

/**
 * Очистка извлечённого текста.
 */
function cleanText(text) {
    return text
        // Убираем множественные пробелы
        .replace(/[ \t]+/g, ' ')
        // Убираем множественные переносы строк (>3 -> 2)
        .replace(/\n{3,}/g, '\n\n')
        // Убираем пробелы в начале/конце строк
        .replace(/^ +| +$/gm, '')
        .trim();
}

module.exports = { parseDocument };
