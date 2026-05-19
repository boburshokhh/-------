/**
 * backend/worker.js
 *
 * Standalone BullMQ worker process.
 * Run with:  node worker.js
 * Or via package.json: npm run worker
 *
 * The worker consumes jobs from the "ai-test-generation" queue (Redis DB 0)
 * and executes the full Test_Generation_Pipeline for each job.
 * Multiple instances can run in parallel — BullMQ guarantees at-most-once delivery.
 */
console.error('[WORKER]', new Date().toISOString(), 'starting, pid=', process.pid);

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Worker } = require('bullmq');
const config = require('./config');
const { QUEUE_NAME, buildConnection } = require('./queue/jobQueue');
const { processGenerationJob } = require('./queue/processor');
const { runMigrations } = require('./db/migrations/runner');
const pgPool = require('./db/pgPool');
const fileStorage = require('./services/storage/fileStorage');

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 1;

async function start() {
    console.log(`[WORKER] Running migrations…`);
    await runMigrations(pgPool);

    await fileStorage.init().catch((e) =>
        console.warn(`[WORKER] fileStorage.init failed (non-fatal): ${e.message}`)
    );

    const worker = new Worker(QUEUE_NAME, processGenerationJob, {
        connection: buildConnection(),
        concurrency: CONCURRENCY,
        lockDuration: config.JOB_TIMEOUT_MS ?? 600000,
        lockRenewTime: Math.floor((config.JOB_TIMEOUT_MS ?? 600000) / 4),
    });

    worker.on('active', (job) => {
        console.log(`[WORKER] Job ${job.id} started (attempt ${job.attemptsMade + 1})`);
    });

    worker.on('completed', (job, returnValue) => {
        console.log(`[WORKER] Job ${job.id} completed: testId=${returnValue?.testId}`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[WORKER] Job ${job?.id} failed: ${err.message}`);
    });

    worker.on('error', (err) => {
        console.error(`[WORKER] Worker error: ${err.message}`);
    });

    console.log(`[WORKER] Listening on queue "${QUEUE_NAME}" concurrency=${CONCURRENCY}`);

    async function shutdown(signal) {
        console.log(`[WORKER] ${signal} received, closing gracefully…`);
        await worker.close().catch(() => {});
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
    console.error('[WORKER] Fatal startup error:', err);
    process.exit(1);
});
