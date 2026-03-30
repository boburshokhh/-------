const config = require('../config');
const jobProgress = require('../services/jobProgress');

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function markUploadJobError(req, detail) {
    const raw = typeof req.get === 'function' ? req.get('X-Job-Id') : '';
    const jobId = raw ? String(raw).trim() : '';
    if (jobId && JOB_ID_RE.test(jobId)) {
        jobProgress.logJobProgress(jobId, {
            phase: 'error',
            stage: 'upload_failed',
            detail: detail || 'Ошибка загрузки',
        });
    }
}

module.exports = function errorHandler(err, req, res, next) {
    console.error(`[ERROR] ${new Date().toISOString()}:`, err.message);
    console.error(err.stack);

    if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = config.MAX_FILE_SIZE_MB || 10;
        markUploadJobError(req, `Файл больше ${mb} МБ (лимит сервера)`);
        return res.status(413).json({
            error: 'Файл слишком большой',
            details: `Максимальный размер файла — ${mb} МБ`
        });
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        markUploadJobError(req, 'Неверное поле формы для файла');
        return res.status(400).json({
            error: 'Неверное поле файла',
            details: 'Используйте поле "file" для загрузки'
        });
    }

    if (err.type === 'INVALID_FILE_TYPE') {
        markUploadJobError(req, err.message || 'Неподдерживаемый формат');
        return res.status(415).json({
            error: 'Неподдерживаемый формат файла',
            details: err.message || 'Поддерживаются только PDF файлы'
        });
    }
    if (err.requiresOfflineConsent) {
        markUploadJobError(req, err.message || 'Требуется согласие на офлайн-сборку');
        return res.status(err.status || 402).json({
            error: err.message || 'Дневной лимит квоты исчерпан. Перейти в оффлайн-режим?',
            requiresOfflineConsent: true,
            details: err.details,
        });
    }

    if (err.type === 'QUOTA_EXCEEDED') {
        markUploadJobError(req, err.message || 'Превышен лимит запросов');
        return res.status(429).json({
            error: err.message || 'Превышен лимит запросов',
            details: err.details,
        });
    }

    if (err.type === 'PARSE_ERROR') {
        return res.status(422).json({
            error: 'Ошибка обработки документа',
            details: err.message
        });
    }

    if (err.type === 'LLM_ERROR') {
        markUploadJobError(req, err.message || 'Ошибка генерации');
        return res.status(502).json({
            error: 'Ошибка генерации теста',
            details: err.message,
        });
    }

    if (typeof err.message === 'string' && err.message.includes('CORS origin is not allowed')) {
        return res.status(403).json({
            error: 'Доступ с этого origin запрещен',
        });
    }

    res.status(err.status || 500).json({
        error: 'Внутренняя ошибка сервера',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
};
