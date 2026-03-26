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
const jobProgress = require('../services/jobProgress');
const { normalizeDisplayFilename, resolveStorageExtension } = require('../utils/filename');
const { logStructured } = require('../utils/observability');

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(config.UPLOAD_DIR)) {
            fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
        }
        cb(null, config.UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = resolveStorageExtension(file.originalname, file.mimetype);
        if (!ext) {
            const err = new Error('Недопустимое расширение файла');
            err.type = 'INVALID_FILE_TYPE';
            cb(err);
            return;
        }
        cb(null, `${uuidv4()}${ext}`);
    },
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
    limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
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
    const originalNameRaw = typeof file.originalname === 'string' ? file.originalname : '';
    const displayName = normalizeDisplayFilename(originalNameRaw);

    if (displayName !== originalNameRaw) {
        console.warn(`[UPLOAD] Имя файла нормализовано: raw="${originalNameRaw}" → display="${displayName}"`);
    }

    const jobId = (typeof req.get === 'function' && req.get('X-Job-Id') && String(req.get('X-Job-Id')).trim())
        ? String(req.get('X-Job-Id')).trim()
        : uuidv4();
    const report = (payload) => jobProgress.logJobProgress(jobId, payload);

    try {
        report({ phase: 'parse', stage: 'reading', percent: 2, detail: `Чтение файла: ${displayName}` });
        console.log(`[UPLOAD] Файл: storage=${file.filename} display="${displayName}"`);

        const parseResult = await parseDocument(filePath, file.mimetype);
        const { text, pageCount, rawText, diagnostics } = parseResult;

        report({
            phase: 'parse',
            stage: 'parsed',
            percent: 8,
            detail: `${pageCount != null ? `${pageCount} стр.` : 'страницы ?'}, ${text.length} символов, качество ${diagnostics.extractionQuality ?? '—'}`,
        });

        logStructured({
            level: 'info',
            traceId: jobId,
            phase: 'upload',
            event: 'parse_complete',
            metrics: {
                text_length: text.length,
                token_count: countTokens(text),
                page_count: pageCount ?? null,
                parse_quality_score: diagnostics.extractionQuality ?? null,
                low_text_quality: !!diagnostics.lowTextQuality,
            },
            metadata: { parse_method: diagnostics.parseMethod || null, display_name: displayName },
        });

        if (diagnostics.lowTextQuality) {
            console.warn(`[UPLOAD] Низкое качество извлечения текста (quality=${diagnostics.extractionQuality}, doc=${displayName})`);
        }

        if (pageCount && pageCount > config.MAX_PAGES) {
            jobProgress.logJobProgress(jobId, {
                phase: 'error',
                stage: 'too_many_pages',
                percent: 0,
                detail: `Слишком много страниц: ${pageCount} (макс. ${config.MAX_PAGES})`,
            });
            return res.status(413).json({
                error: `Документ слишком большой (${pageCount} стр.)`,
                details: `Максимум ${config.MAX_PAGES} страниц`,
            });
        }

        report({ phase: 'db', stage: 'saving', percent: 9, detail: 'Сохранение метаданных документа' });

        const storeFullText = config.STORE_DOCUMENT_TEXT_IN_DB === true;
        const diagJson = JSON.stringify(diagnostics);

        const docInsert = db.prepare(`
      INSERT INTO documents (
        filename, original_name, original_name_raw, page_count, text_length,
        extraction_quality, parse_diagnostics_json, low_text_quality, text_raw, text_clean
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const docResult = docInsert.run(
            file.filename,
            displayName,
            originalNameRaw || null,
            pageCount,
            text.length,
            diagnostics.extractionQuality ?? null,
            diagJson,
            diagnostics.lowTextQuality ? 1 : 0,
            storeFullText ? rawText : null,
            storeFullText ? text : null,
        );
        const documentId = docResult.lastInsertRowid;

        console.log(
            `[UPLOAD] Документ #${documentId}: ${text.length} символов, ${countTokens(text)} токенов, extractionQuality=${diagnostics.extractionQuality}`,
        );
        report({
            phase: 'db',
            stage: 'saved',
            percent: 10,
            detail: `Документ #${documentId}, ${countTokens(text)} токенов`,
        });

        console.log(`[UPLOAD] Индексация документа #${documentId}...`);
        const indexedChunks = await indexDocument(documentId, text, report);
        console.log(`[UPLOAD] Индекс готов: ${indexedChunks.length} чанков`);

        const modelId = req.body.model && typeof req.body.model === 'string' ? req.body.model.trim() : null;
        const allowedIds = (config.LLM_MODELS || []).map((m) => m.id);
        const model = (modelId && allowedIds.includes(modelId)) ? modelId : config.LLM_MODEL;
        if (modelId && model !== modelId) {
            console.warn(`[UPLOAD] Неизвестная модель "${modelId}", использована ${model}`);
        }
        console.log(`[UPLOAD] Генерация теста с моделью: ${model}`);
        const testData = await generateTest(text, displayName, indexedChunks, report, {
            model,
            extractionQuality: diagnostics.extractionQuality,
            traceId: jobId,
            documentId: Number(documentId),
        });

        const testInsert = db.prepare(`
      INSERT INTO tests (document_id, title, questions_json, total_questions, generation_metrics_json)
      VALUES (?, ?, ?, ?, ?)
    `);
        const metricsJson = testData.generationMetrics
            ? JSON.stringify(testData.generationMetrics)
            : null;
        const testResult = testInsert.run(
            documentId,
            testData.title,
            JSON.stringify(testData.questions),
            testData.questions.length,
            metricsJson,
        );

        const testId = Number(testResult.lastInsertRowid);
        logStructured({
            level: 'info',
            traceId: jobId,
            documentId: Number(documentId),
            testId,
            phase: 'upload',
            event: 'test_saved',
            metrics: {
                total_questions: testData.questions.length,
                final_quality_score: testData.generationMetrics?.final_quality_score ?? null,
            },
        });

        report({
            phase: 'done',
            stage: 'saved_test',
            percent: 100,
            detail: `Сохранён тест: ${testData.questions.length} вопросов`,
        });

        res.status(201).json({
            success: true,
            jobId,
            testId,
            title: testData.title,
            totalQuestions: testData.questions.length,
            generationMetrics: testData.generationMetrics ?? null,
            documentInfo: {
                id: Number(documentId),
                name: displayName,
                pages: pageCount,
                textLength: text.length,
                extractionQuality: diagnostics.extractionQuality,
                lowTextQuality: diagnostics.lowTextQuality,
                parseMethod: diagnostics.parseMethod || null,
            },
        });
    } catch (error) {
        try {
            jobProgress.logJobProgress(jobId, {
                phase: 'error',
                stage: 'failed',
                percent: 0,
                detail: error && error.message ? String(error.message) : 'Ошибка обработки',
            });
        } catch {
            /* ignore */
        }
        next(error);
    } finally {
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
