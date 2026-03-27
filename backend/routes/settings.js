const express = require('express');
const config = require('../config');
const runtimeConfig = require('../services/runtimeConfig');

const router = express.Router();

function authorize(req, res) {
    if (!config.SETTINGS_API_TOKEN) {
        return true;
    }
    const provided = req.get('X-Settings-Token') || '';
    if (provided !== config.SETTINGS_API_TOKEN) {
        res.status(403).json({ error: 'Доступ к настройкам запрещён' });
        return false;
    }
    return true;
}

router.get('/runtime', (req, res) => {
    if (!authorize(req, res)) return;
    res.json({
        success: true,
        settings: runtimeConfig.getPublicRuntimeSettings(),
    });
});

router.post('/gemini-key', (req, res, next) => {
    if (!authorize(req, res)) return;
    try {
        const key = req.body?.geminiApiKey;
        if (!key || !String(key).trim()) {
            return res.status(400).json({ error: 'geminiApiKey обязателен' });
        }
        runtimeConfig.setGeminiApiKey(key);
        res.json({
            success: true,
            settings: runtimeConfig.getPublicRuntimeSettings(),
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
