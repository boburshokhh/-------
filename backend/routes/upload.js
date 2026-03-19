const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const db = require('../db/database');
const { parseDocument } = require('../services/parser');
const { generateTest } = require('../services/generator');
const { countTokens } = require('../services/chunker');
const { indexDocument } = require('../services/indexer');

const router = express.Router();

function normalizeFilenameEncoding(name) {
    // Иногда браузер/промежуточный слой может передать имя файла так,
    // что кириллица оказывается "битой" (типичный артефакт: Ð...).
    // Пробуем восстановить вариант latin1->utf8 и выбираем более "разумный".
    if (typeof name !== 'string' || name.length === 0) return name;

    const original = name;
    let latin1Decoded = null;
    try {
        latin1Decoded = Buffer.from(name, 'latin1').toString('utf8');
    } catch {
        latin1Decoded = null;
    }

    const score = (s) => {
        if (typeof s !== 'string' || s.length === 0) return -Infinity;
        const repl = (s.match(/�/g) || []).length;
        const cyr = (s.match(/[А-Яа-яЁё]/g) || []).length;
        // Чем больше кириллицы и меньше replacement-character — тем лучше.
        return cyr * 10 - repl * 25;
    };

    if (!latin1Decoded) return original;
    return score(latin1Decoded) > score(original) ? latin1Decoded : original;
}

// Настройка multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(config.UPLOAD_DIR)) {
            fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
        }
        cb(null, config.UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${uuidv4()}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    if (config.ALLOWED_MIMES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        const err = new Error('Неподдерживаемый формат. Используйте PDF или DOCX.');
        err.type = 'INVALID_FILE_TYPE';
        cb(err, false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 }
});

/**
 * POST /api/upload
 * Загрузка PDF/DOCX, парсинг, генерация теста
 */
router.post('/', upload.single('file'), async (req, res, next) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }

    const filePath = file.path;
    const safeOriginalName = normalizeFilenameEncoding(file.originalname);
    if (safeOriginalName !== file.originalname) {
        console.warn(`[UPLOAD] Нормализовано имя файла: "${file.originalname}" -> "${safeOriginalName}"`);
    }

    try {
        // 1. Парсинг документа
        console.log(`[UPLOAD] Обработка файла: ${safeOriginalName}`);
        const { text, pageCount } = await parseDocument(filePath, file.mimetype);

        // 2. Проверка лимита страниц
        if (pageCount && pageCount > config.MAX_PAGES) {
            return res.status(413).json({
                error: `Документ слишком большой (${pageCount} стр.)`,
                details: `Максимум ${config.MAX_PAGES} страниц`
            });
        }

        // 3. Сохранение документа в БД
        const docInsert = db.prepare(`
      INSERT INTO documents (filename, original_name, page_count, text_length)
      VALUES (?, ?, ?, ?)
    `);
        const docResult = docInsert.run(file.filename, safeOriginalName, pageCount, text.length);
        const documentId = docResult.lastInsertRowid;

        console.log(`[UPLOAD] Документ #${documentId}: ${text.length} символов, ${countTokens(text)} токенов`);

        // 4. Индексация документа (чанки + эмбеддинги + summary → SQLite)
        console.log(`[UPLOAD] Индексация документа #${documentId}...`);
        const indexedChunks = await indexDocument(documentId, text);
        console.log(`[UPLOAD] Индекс готов: ${indexedChunks.length} чанков`);

        // 5. Генерация теста через LLM + RAG
        const modelId = req.body.model && typeof req.body.model === 'string' ? req.body.model.trim() : null;
        const allowedIds = (config.LLM_MODELS || []).map(m => m.id);
        const model = (modelId && allowedIds.includes(modelId)) ? modelId : config.LLM_MODEL;
        if (modelId && model !== modelId) {
            console.warn(`[UPLOAD] Неизвестная модель "${modelId}", использована ${model}`);
        }
        console.log(`[UPLOAD] Генерация теста с моделью: ${model}`);
        const testData = await generateTest(text, safeOriginalName, indexedChunks, null, { model });

        // 6. Сохранение теста в БД
        const testInsert = db.prepare(`
      INSERT INTO tests (document_id, title, questions_json, total_questions)
      VALUES (?, ?, ?, ?)
    `);
        const testResult = testInsert.run(
            documentId,
            testData.title,
            JSON.stringify(testData.questions),
            testData.questions.length
        );

        res.status(201).json({
            success: true,
            testId: Number(testResult.lastInsertRowid),
            title: testData.title,
            totalQuestions: testData.questions.length,
            documentInfo: {
                id: Number(documentId),
                name: safeOriginalName,
                pages: pageCount,
                textLength: text.length
            }
        });

    } catch (error) {
        next(error);
    } finally {
        // Удаляем загруженный файл в любом случае
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.warn(`[UPLOAD] Не удалось удалить файл: ${e.message}`);
        }
    }
});

module.exports = router;
