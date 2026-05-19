'use strict';

/**
 * db/redisClient.js
 *
 * Shared factory for ioredis connections, one per logical DB.
 * DB layout:
 *   0 — BullMQ job queue
 *   1 — Blueprint cache (TTL 24 h)
 *   2 — Embedding cache (LRU TTL 7 days)
 *
 * All connections are lazy-created on first call and reused.
 * Call redisClient.quit() on graceful shutdown.
 */

const Redis = require('ioredis');
const config = require('../config');

const _instances = new Map(); // db index → Redis instance

function buildConnectionOptions(db) {
    const url = config.REDIS_URL;
    if (url) {
        return { url, db };
    }
    const opts = {
        host: config.REDIS_HOST || 'localhost',
        port: config.REDIS_PORT || 6379,
        db,
        lazyConnect: false,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            if (times > 5) return null; // stop retrying
            return Math.min(times * 200, 2000);
        },
    };
    if (config.REDIS_PASSWORD) opts.password = config.REDIS_PASSWORD;
    return opts;
}

/**
 * Returns a shared ioredis instance for the given logical DB.
 * @param {number} db
 * @returns {Redis}
 */
function getClient(db = 0) {
    if (_instances.has(db)) return _instances.get(db);

    const opts = buildConnectionOptions(db);
    const client = config.REDIS_URL
        ? new Redis(opts.url, { db })
        : new Redis(opts);

    client.on('error', (err) => {
        console.error(`[Redis DB${db}] connection error: ${err.message}`);
    });
    client.on('connect', () => {
        console.log(`[Redis DB${db}] connected`);
    });

    _instances.set(db, client);
    return client;
}

/** BullMQ queue DB */
function getQueueClient() { return getClient(config.REDIS_DB_QUEUE ?? 0); }
/** Blueprint cache DB */
function getBlueprintClient() { return getClient(config.REDIS_DB_BLUEPRINT ?? 1); }
/** Embedding cache DB */
function getEmbeddingClient() { return getClient(config.REDIS_DB_EMBEDDING ?? 2); }

/** Create a fresh (non-cached) connection — needed by BullMQ workers */
function newConnection(db = 0) {
    const opts = buildConnectionOptions(db);
    const client = config.REDIS_URL
        ? new Redis(opts.url, { db })
        : new Redis(opts);
    client.on('error', (err) => console.error(`[Redis new DB${db}] ${err.message}`));
    return client;
}

/** Gracefully close all shared connections */
async function quit() {
    await Promise.all([..._instances.values()].map(c => c.quit().catch(() => {})));
    _instances.clear();
}

/**
 * Quick ping to verify Redis is reachable.
 * @param {number} [db=0]
 * @returns {Promise<boolean>}
 */
async function ping(db = 0) {
    try {
        const r = await getClient(db).ping();
        return r === 'PONG';
    } catch {
        return false;
    }
}

module.exports = { getClient, getQueueClient, getBlueprintClient, getEmbeddingClient, newConnection, quit, ping };
