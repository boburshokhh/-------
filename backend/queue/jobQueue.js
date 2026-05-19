'use strict';

/**
 * queue/jobQueue.js
 *
 * BullMQ Queue singleton for AI test generation jobs (Redis DB 0).
 *
 * Jobs carry the full context needed to run the pipeline in a worker:
 *   jobId, documentId, routingMode, model, displayName,
 *   text, indexedChunks, options (complexityScore, etc.)
 *
 * The queue is only created when JOB_QUEUE_ENABLED=true (checked by callers).
 */

const { Queue } = require('bullmq');
const config = require('../config');

const QUEUE_NAME = 'ai-test-generation';

let _queue = null;

function buildConnection() {
    if (config.REDIS_URL) {
        return { url: config.REDIS_URL, db: config.REDIS_DB_QUEUE ?? 0 };
    }
    const conn = {
        host: config.REDIS_HOST || 'localhost',
        port: config.REDIS_PORT || 6379,
        db: config.REDIS_DB_QUEUE ?? 0,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };
    if (config.REDIS_PASSWORD) conn.password = config.REDIS_PASSWORD;
    return conn;
}

/**
 * Returns the singleton BullMQ Queue instance.
 * Throws if BullMQ / ioredis is not available.
 */
function getQueue() {
    if (!_queue) {
        _queue = new Queue(QUEUE_NAME, {
            connection: buildConnection(),
            defaultJobOptions: {
                attempts: config.JOB_MAX_ATTEMPTS ?? 2,
                backoff: { type: 'exponential', delay: 10000 },
                removeOnComplete: { age: 3600, count: 500 },
                removeOnFail: { age: 86400, count: 500 },
            },
        });
        _queue.on('error', (err) => {
            console.error('[JobQueue] Queue error:', err.message);
        });
    }
    return _queue;
}

/**
 * Enqueue a generation job.
 * @param {string} jobId - client-supplied job id (used as BullMQ job name for idempotency)
 * @param {object} payload
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueue(jobId, payload) {
    const queue = getQueue();
    const opts = {
        jobId,
        timeout: config.JOB_TIMEOUT_MS ?? 600000,
    };

    // Idempotency: повторный upload с тем же X-Job-Id не падает с duplicate error
    try {
        const existing = await queue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();
            if (state === 'completed') {
                await existing.remove();
            } else if (['waiting', 'delayed', 'active', 'paused'].includes(state)) {
                console.log(`[JobQueue] Job ${jobId} already ${state}, returning existing`);
                return existing;
            }
        }
    } catch (e) {
        console.warn(`[JobQueue] getJob check failed: ${e.message}`);
    }

    try {
        return await queue.add(jobId, payload, opts);
    } catch (err) {
        const msg = String(err && err.message || err);
        if (msg.includes('already exists') || msg.includes('JobId')) {
            const existing = await queue.getJob(jobId);
            if (existing) return existing;
        }
        throw err;
    }
}

/**
 * Gracefully close the queue connection.
 */
async function close() {
    if (_queue) {
        await _queue.close().catch(() => {});
        _queue = null;
    }
}

module.exports = { QUEUE_NAME, getQueue, enqueue, close, buildConnection };
