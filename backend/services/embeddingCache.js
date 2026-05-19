'use strict';

/**
 * services/embeddingCache.js
 *
 * Redis-backed embedding vector cache.
 * Key: emb:<schemaVersion>:<sha256(text)>:<modelId>
 * Value: JSON array of float32 numbers (the embedding vector).
 * TTL: EMBEDDING_CACHE_TTL_SECONDS (default 604800 = 7 days).
 *
 * Memory bound: EMBEDDING_CACHE_MAX_ENTRIES (default 50000) enforced via
 * Redis maxmemory + volatile-lru policy on DB2 (set in Redis config).
 *
 * Graceful degradation: any Redis error → warn + return null (cache miss).
 */

const crypto = require('crypto');
const config = require('../config');
const { logStructured } = require('../utils/observability');

let _redisClient = null;

function getRedis() {
    if (!_redisClient) {
        const { getEmbeddingClient } = require('../db/redisClient');
        _redisClient = getEmbeddingClient();
    }
    return _redisClient;
}

function isEnabled() {
    return config.EMBEDDING_CACHE_ENABLED === true;
}

function computeTextHash(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function buildKey(textHash, modelId) {
    const v = config.CACHE_SCHEMA_VERSION || '1';
    return `emb:${v}:${textHash}:${modelId}`;
}

/**
 * Look up an embedding vector in cache.
 * @param {string} text
 * @param {string} modelId
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text, modelId) {
    if (!isEnabled()) return null;
    const hash = computeTextHash(text);
    const key = buildKey(hash, modelId);
    try {
        const raw = await getRedis().get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`[EmbeddingCache] GET error (degraded): ${err.message}`);
        logStructured({
            level: 'warn', phase: 'embed', event: 'embedding_cache_unavailable',
            metadata: { reason_code: 'embedding_cache_unavailable', error: err.message },
        });
        return null;
    }
}

/**
 * Store an embedding vector in cache.
 * @param {string} text
 * @param {string} modelId
 * @param {number[]} vector
 */
async function setEmbedding(text, modelId, vector) {
    if (!isEnabled()) return;
    const hash = computeTextHash(text);
    const key = buildKey(hash, modelId);
    const ttl = config.EMBEDDING_CACHE_TTL_SECONDS || 604800;
    try {
        await getRedis().set(key, JSON.stringify(vector), 'EX', ttl);
    } catch (err) {
        console.warn(`[EmbeddingCache] SET error (degraded): ${err.message}`);
        logStructured({
            level: 'warn', phase: 'embed', event: 'embedding_cache_unavailable',
            metadata: { reason_code: 'embedding_cache_unavailable', error: err.message },
        });
    }
}

module.exports = { getEmbedding, setEmbedding, isEnabled, computeTextHash };
