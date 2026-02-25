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

    try {
        // 1. Парсинг документа
        console.log(`[UPLOAD] Обработка файла: ${file.originalname}`);
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
        const docResult = docInsert.run(file.filename, file.originalname, pageCount, text.length);
        const documentId = docResult.lastInsertRowid;

        console.log(`[UPLOAD] Документ #${documentId}: ${text.length} символов, ${countTokens(text)} токенов`);

        // 4. Индексация документа (чанки + эмбеддинги + summary → SQLite)
        console.log(`[UPLOAD] Индексация документа #${documentId}...`);
        const indexedChunks = await indexDocument(documentId, text);
        console.log(`[UPLOAD] Индекс готов: ${indexedChunks.length} чанков`);

        // 5. Генерация теста через LLM + RAG
        const testData = await generateTest(text, file.originalname, indexedChunks);

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
                name: file.originalname,
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
