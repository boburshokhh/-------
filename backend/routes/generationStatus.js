'use strict';

const express = require('express');
const generationLock = require('../services/generationLock');

const router = express.Router();

/** GET /api/generation/active — занят ли сервер другой генерацией */
router.get('/active', async (req, res) => {
    const state = await generationLock.getActive();
    res.json({ ok: true, ...state });
});

module.exports = router;
