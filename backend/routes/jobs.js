const express = require('express');
const { getJob } = require('../services/jobProgress');
const { logStructured } = require('../utils/observability');

const router = express.Router();
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * GET /api/jobs/:jobId
 * Текущий прогресс загрузки/генерации (опрос с фронта во время POST /upload).
 */
router.get('/:jobId', async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!JOB_ID_RE.test(jobId)) {
        return res.status(400).json({ error: 'Некорректный идентификатор задачи' });
    }
    const state = await getJob(jobId);
    if (!state) {
        logStructured({
            level: 'warn',
            traceId: jobId,
            event: 'job_poll_miss',
            metadata: {
                ip: req.ip || req.socket?.remoteAddress || null,
                user_agent: req.get('user-agent') || null,
            },
        });
        return res.status(404).json({ error: 'Задача не найдена или устарела' });
    }
    res.json({ ok: true, ...state });
});

module.exports = router;
