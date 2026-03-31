const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const documentRepo = require('../db/repositories/documentRepo');
const testRepo = require('../db/repositories/testRepo');
const runRepo = require('../db/repositories/runRepo');
const fileStorage = require('../services/storage/fileStorage');
const { parseDocument } = require('../services/parser');
const { generateTest } = require('../services/generator');
const { countTokens } = require('../services/chunker');
const { indexDocument } = require('../services/indexer');
const jobProgress = require('../services/jobProgress');
const { normalizeDisplayFilename, resolveStorageExtension } = require('../utils/filename');
const { logStructured } = require('../utils/observability');
const customModeProfilesRepo = require('../db/repositories/customModeProfilesRepo');

const router = express.Router();
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function registerUploadJobStub(req, res, next) {
    const incomingJobId = (typeof req.get === 'function' && req.get('X-Job-Id'))
        ? String(req.get('X-Job-Id')).trim()
        : '';
    if (incomingJobId && JOB_ID_RE.test(incomingJobId)) {
        jobProgress.logJobProgress(incomingJobId, {
            phase: 'upload',
            stage: 'receiving',
            detail: 'Приём файла на сервер…',
        });
        const cl = req.get('content-length');
        logStructured({
            level: 'info',
            traceId: incomingJobId,
            phase: 'upload',
            event: 'upload_job_stub_registered',
            metadata: {
                content_length: cl != null && cl !== '' ? cl : null,
            },
        });
    }
    next();
}

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
        const err = new Error('Неподдерживаемый формат. Используйте PDF.');
        err.type = 'INVALID_FILE_TYPE';
        cb(err, false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
});

router.post('/', registerUploadJobStub, upload.single('file'), async (req, res, next) => {
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

    const incomingJobId = (typeof req.get === 'function' && req.get('X-Job-Id'))
        ? String(req.get('X-Job-Id')).trim()
        : '';
    if (incomingJobId && !JOB_ID_RE.test(incomingJobId)) {
        return res.status(400).json({
            error: 'Некорректный X-Job-Id',
            details: 'Разрешены только латиница, цифры, "_" и "-", длина до 80 символов',
        });
    }
    const jobId = incomingJobId || uuidv4();
    const report = (payload) => jobProgress.logJobProgress(jobId, payload);
    const W = jobProgress.WEIGHT;
    const baseWorkAfterDb = W.PARSE_READ + W.PARSE_PARSED + W.DB_SAVING + W.DB_SAVED;

    let storageResult = null;

    try {
        report({
            phase: 'parse',
            stage: 'reading',
            workDelta: W.PARSE_READ,
            detail: `Чтение файла: ${displayName}`,
        });
        console.log(`[UPLOAD] Файл: storage=${file.filename} display="${displayName}"`);

        // Upload to storage (MinIO or local)
        try {
            storageResult = await fileStorage.upload(filePath, displayName);
        } catch (storageErr) {
            console.warn(`[UPLOAD] Storage upload failed, continuing with local file: ${storageErr.message}`);
        }

        const parseResult = await parseDocument(filePath, file.mimetype);
        const { text, pageCount, rawText, diagnostics } = parseResult;

        report({
            phase: 'parse',
            stage: 'parsed',
            workDelta: W.PARSE_PARSED,
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
                detail: `Слишком много страниц: ${pageCount} (макс. ${config.MAX_PAGES})`,
            });
            return res.status(413).json({
                error: `Документ слишком большой (${pageCount} стр.)`,
                details: `Максимум ${config.MAX_PAGES} страниц`,
            });
        }

        report({ phase: 'db', stage: 'saving', workDelta: W.DB_SAVING, detail: 'Сохранение метаданных документа' });

        const storeFullText = config.STORE_DOCUMENT_TEXT_IN_DB === true;

        const docRow = await documentRepo.insertDocument({
            filename: file.filename,
            original_name: displayName,
            original_name_raw: originalNameRaw || null,
            page_count: pageCount,
            text_length: text.length,
            extraction_quality: diagnostics.extractionQuality ?? null,
            parse_diagnostics: diagnostics,
            low_text_quality: !!diagnostics.lowTextQuality,
            text_raw: storeFullText ? rawText : null,
            text_clean: storeFullText ? text : null,
            storage_bucket: storageResult?.bucket || null,
            storage_key: storageResult?.key || null,
            mime_type: file.mimetype,
            size_bytes: storageResult?.size || null,
            checksum_sha256: storageResult?.checksum || null,
        });
        const documentId = docRow.id;

        console.log(
            `[UPLOAD] Документ #${documentId}: ${text.length} символов, ${countTokens(text)} токенов, extractionQuality=${diagnostics.extractionQuality}`,
        );
        report({
            phase: 'db',
            stage: 'saved',
            workDelta: W.DB_SAVED,
            detail: `Документ #${documentId}, ${countTokens(text)} токенов`,
        });

        console.log(`[UPLOAD] Индексация документа #${documentId}...`);
        const indexedChunks = await indexDocument(documentId, text, report, { baseWorkDone: baseWorkAfterDb });
        console.log(`[UPLOAD] Индекс готов: ${indexedChunks.length} чанков`);
        logStructured({
            level: 'info',
            traceId: jobId,
            documentId: Number(documentId),
            phase: 'index',
            event: 'indexing_complete',
            metrics: { chunk_count: indexedChunks.length, text_length: text.length },
        });

        const modelId = req.body.model && typeof req.body.model === 'string' ? req.body.model.trim() : null;
        const allowedIds = (config.LLM_MODELS || []).map((m) => m.id);
        const hasValidPick = !!(modelId && allowedIds.includes(modelId));
        const model = hasValidPick ? modelId : config.LLM_MODEL;
        if (modelId && model !== modelId) {
            console.warn(`[UPLOAD] Неизвестная модель "${modelId}", использована ${model}`);
        }

        const routingModeRaw = req.body.routingMode && typeof req.body.routingMode === 'string'
            ? req.body.routingMode.trim().toLowerCase()
            : '';
        let routingMode = hasValidPick ? 'manual' : 'auto';
        if (routingModeRaw) {
            if (['auto', 'economy', 'balanced', 'quality', 'manual'].includes(routingModeRaw)) {
                routingMode = routingModeRaw;
            } else {
                const customMode = await customModeProfilesRepo.getProfileByCode(routingModeRaw);
                if (
                    customMode
                    && customMode.status === 'active'
                    && !customMode.is_archived
                    && !customMode.is_disabled
                ) {
                    routingMode = routingModeRaw;
                }
            }
        }

        console.log(`[UPLOAD] Генерация теста с моделью: ${model} (routingMode=${routingMode})`);
        logStructured({
            level: 'info',
            traceId: jobId,
            documentId: Number(documentId),
            phase: 'generate',
            event: 'generate_test_invoked',
            metadata: { model },
        });
        const complexityScore = req.body.complexityScore != null && req.body.complexityScore !== ''
            ? Number(req.body.complexityScore)
            : undefined;

        const testData = await generateTest(text, displayName, indexedChunks, report, {
            model,
            routingMode,
            pageCount,
            lowTextQuality: !!diagnostics.lowTextQuality,
            documentMetadata: {
                page_count: pageCount,
                low_text_quality: !!diagnostics.lowTextQuality,
                extraction_quality: diagnostics.extractionQuality ?? null,
            },
            complexityScore: Number.isFinite(complexityScore) ? complexityScore : undefined,
            extractionQuality: diagnostics.extractionQuality,
            traceId: jobId,
            documentId: Number(documentId),
            forceOffline: req.body.forceOffline === 'true' || req.body.forceOffline === true,
        });

        const testRow = await testRepo.insertTest({
            document_id: documentId,
            title: testData.title,
            questions: testData.questions,
            total_questions: testData.questions.length,
            generation_metrics: testData.generationMetrics || null,
            generation_run_id: testData.runId || null,
        });

        const testId = testRow.id;
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
                detail: error && error.message ? String(error.message) : 'Ошибка обработки',
            });
        } catch { /* ignore */ }
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
