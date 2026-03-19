const express = require('express');
const logCollector = require('../services/logCollector');

const router = express.Router();

/**
 * GET /api/logs?limit=200
 * Возвращает последние N логов, собранные в памяти.
 */
router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    res.json({
        logs: logCollector.getLogs(limit || 200),
    });
});

module.exports = router;

