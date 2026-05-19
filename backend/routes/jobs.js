'use strict';

const express = require('express');
const { getJob } = require('../services/jobProgress');
const { logStructured } = require('../utils/observability');
const config = require('../config');

const router = express.Router();
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ── SSE helpers ───────────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['done', 'error', 'failed', 'cancelled', 'completed']);
const SSE_KEEPALIVE_MS = 25000;
const SSE_POLL_MS = 500; // how often we check for updates when Redis pub/sub not available

function sendSseEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendKeepalive(res) {
    res.write(': keepalive\n\n');
}

// ── GET /api/jobs/:jobId — snapshot (polling fallback) ────────────────────────

router.get('/:jobId', async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!JOB_ID_RE.test(jobId)) {
        return res.status(400).json({ error: 'Некорректный идентификатор задачи' });
    }
    const state = await getJob(jobId);
    if (!state) {
        logStructured({
            level: 'warn', traceId: jobId, event: 'job_poll_miss',
            metadata: {
                ip: req.ip || req.socket?.remoteAddress || null,
                user_agent: req.get('user-agent') || null,
            },
        });
        return res.status(404).json({ error: 'Задача не найдена или устарела' });
    }
    res.json({ ok: true, ...state });
});

// ── GET /api/jobs/:jobId/stream — SSE real-time progress ─────────────────────

router.get('/:jobId/stream', async (req, res) => {
    if (!config.SSE_ENABLED) {
        return res.status(404).json({ error: 'SSE отключён. Используйте GET /api/jobs/:id для опроса.' });
    }

    const jobId = String(req.params.jobId || '');
    if (!JOB_ID_RE.test(jobId)) {
        return res.status(400).json({ error: 'Некорректный идентификатор задачи' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    let closed = false;
    let lastPhase = null;

    function onClose() {
        closed = true;
    }
    req.on('close', onClose);
    req.on('error', onClose);

    // Try Redis pub/sub if available; fall back to polling
    let subscriber = null;
    let redisAvailable = false;

    try {
        const { newConnection } = require('../db/redisClient');
        subscriber = newConnection(config.REDIS_DB_QUEUE ?? 0);
        subscriber.on('error', () => { redisAvailable = false; });
        await subscriber.ping();
        redisAvailable = true;
    } catch {
        redisAvailable = false;
        if (subscriber) { subscriber.quit().catch(() => {}); subscriber = null; }
    }

    if (redisAvailable && subscriber) {
        // ── Pub/Sub path ──────────────────────────────────────────────────────
        const channel = `job:${jobId}:progress`;
        await subscriber.subscribe(channel);

        subscriber.on('message', (_ch, message) => {
            if (closed) return;
            try {
                const update = JSON.parse(message);
                const isTerminal = TERMINAL_PHASES.has(update.phase);
                sendSseEvent(res, isTerminal ? 'terminal' : 'progress', update);
                if (isTerminal) {
                    cleanup();
                    res.end();
                }
            } catch { /* ignore malformed messages */ }
        });

        // Send initial snapshot
        const initial = await getJob(jobId).catch(() => null);
        if (initial) {
            const isTerminal = TERMINAL_PHASES.has(initial.phase);
            sendSseEvent(res, isTerminal ? 'terminal' : 'progress', { jobId, ...initial });
            if (isTerminal) { cleanup(); return res.end(); }
        }

        const keepaliveTimer = setInterval(() => {
            if (closed) { cleanup(); return; }
            sendKeepalive(res);
        }, SSE_KEEPALIVE_MS);

        function cleanup() {
            clearInterval(keepaliveTimer);
            if (subscriber) {
                subscriber.unsubscribe(channel).catch(() => {});
                subscriber.quit().catch(() => {});
                subscriber = null;
            }
        }

        req.on('close', cleanup);
    } else {
        // ── Polling fallback path ─────────────────────────────────────────────
        const keepaliveTimer = setInterval(() => {
            if (!closed) sendKeepalive(res);
        }, SSE_KEEPALIVE_MS);

        const pollTimer = setInterval(async () => {
            if (closed) {
                clearInterval(pollTimer);
                clearInterval(keepaliveTimer);
                return;
            }
            try {
                const state = await getJob(jobId);
                if (!state) return;
                const phase = state.phase || '';
                if (phase !== lastPhase) {
                    lastPhase = phase;
                    const isTerminal = TERMINAL_PHASES.has(phase);
                    sendSseEvent(res, isTerminal ? 'terminal' : 'progress', {
                        jobId, phase, percent: state.percent, message: state.detail || phase,
                    });
                    if (isTerminal) {
                        clearInterval(pollTimer);
                        clearInterval(keepaliveTimer);
                        res.end();
                    }
                }
            } catch { /* ignore poll errors */ }
        }, SSE_POLL_MS);

        // Send initial state
        try {
            const initial = await getJob(jobId);
            if (initial) {
                const isTerminal = TERMINAL_PHASES.has(initial.phase || '');
                sendSseEvent(res, isTerminal ? 'terminal' : 'progress', { jobId, ...initial });
                if (isTerminal) {
                    clearInterval(pollTimer);
                    clearInterval(keepaliveTimer);
                    return res.end();
                }
            }
        } catch { /* ignore */ }

        req.on('close', () => {
            clearInterval(pollTimer);
            clearInterval(keepaliveTimer);
        });
    }
});

module.exports = router;
