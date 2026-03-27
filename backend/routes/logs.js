const express = require('express');
const logCollector = require('../services/logCollector');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/logs?limit=200
 * Возвращает последние N логов, собранные в памяти.
 */
router.get('/', (req, res) => {
    if (config.LOGS_API_TOKEN) {
        const providedToken = req.get('X-Logs-Token') || req.query.token;
        if (providedToken !== config.LOGS_API_TOKEN) {
            return res.status(403).json({ error: 'Доступ к логам запрещён' });
        }
    }

    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 200;
    res.json({
        logs: logCollector.getLogs(limit),
    });
});

module.exports = router;

