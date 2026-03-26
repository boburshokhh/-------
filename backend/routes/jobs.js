const express = require('express');
const { getJob } = require('../services/jobProgress');

const router = express.Router();

/**
 * GET /api/jobs/:jobId
 * Текущий прогресс загрузки/генерации (опрос с фронта во время POST /upload).
 */
router.get('/:jobId', (req, res) => {
    const state = getJob(req.params.jobId);
    if (!state) {
        return res.status(404).json({ error: 'Задача не найдена или устарела' });
    }
    res.json({ ok: true, ...state });
});

module.exports = router;
