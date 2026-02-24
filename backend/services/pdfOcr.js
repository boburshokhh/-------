const path = require('path');
const os = require('os');
const fs = require('fs');
const { fromPath } = require('pdf2pic');
const Tesseract = require('tesseract.js');
const config = require('../config');

/**
 * Извлекает текст из PDF через OCR (конвертация страниц в изображения + Tesseract).
 * Требует установленный GraphicsMagick (или ImageMagick) и Ghostscript.
 * @param {string} filePath - путь к PDF
 * @param {number} pageCount - количество страниц для обработки
 * @returns {Promise<{text: string, pageCount: number}>}
 */
async function parsePDFWithOCR(filePath, pageCount) {
    const tmpDir = path.join(os.tmpdir(), `pdf-ocr-${Date.now()}`);
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }

    const options = {
        density: 180,
        format: 'png',
        savePath: tmpDir,
        saveFilename: 'page',
        width: 1600,
        height: 2200,
        preserveAspectRatio: true
    };

    let convert;
    try {
        convert = fromPath(filePath, options);
    } catch (err) {
        cleanup(tmpDir);
        const msg = err.message || '';
        if (/gm|graphicsmagick|imagemagick|ghostscript/i.test(msg)) {
            const e = new Error('OCR недоступен: установите GraphicsMagick и Ghostscript на сервере.');
            e.type = 'PARSE_ERROR';
            throw e;
        }
        const e = new Error('Не удалось конвертировать PDF в изображения. Установите GraphicsMagick.');
        e.type = 'PARSE_ERROR';
        throw e;
    }

    const texts = [];
    for (let page = 1; page <= pageCount; page++) {
        let imageResult;
        try {
            imageResult = await convert(page, { responseType: 'buffer' });
        } catch (err) {
            cleanup(tmpDir);
            const e = new Error('Не удалось конвертировать PDF в изображения. Установите GraphicsMagick и Ghostscript.');
            e.type = 'PARSE_ERROR';
            throw e;
        }

        const buffer = imageResult.buffer || imageResult;
        if (!buffer || buffer.length === 0) continue;

        try {
            const { data } = await Tesseract.recognize(buffer, 'rus+eng', {
                logger: () => {}
            });
            if (data && data.text) {
                texts.push(data.text.trim());
            }
        } catch (ocrErr) {
            console.warn(`[PDF_OCR] Ошибка распознавания страницы ${page}:`, ocrErr.message);
        }
    }

    cleanup(tmpDir);
    const combined = texts.join('\n\n').trim();
    if (!combined || combined.length < config.MIN_TEXT_LENGTH) {
        const err = new Error('Не удалось распознать текст из отсканированного PDF. Попробуйте улучшить качество скана.');
        err.type = 'PARSE_ERROR';
        throw err;
    }

    return {
        text: combined,
        pageCount
    };
}

function cleanup(dir) {
    try {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                fs.unlinkSync(path.join(dir, f));
            }
            fs.rmdirSync(dir);
        }
    } catch (e) {
        console.warn('[PDF_OCR] Не удалось удалить временные файлы:', e.message);
    }
}

module.exports = { parsePDFWithOCR };
