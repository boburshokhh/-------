'use strict';

/**
 * services/blueprintCache.js
 *
 * Redis-backed blueprint cache.
 * Key: blueprint:<schemaVersion>:<docHash>:<routingMode>:<questionCount>:<language>
 * Value: JSON-serialised blueprint array.
 * TTL: BLUEPRINT_CACHE_TTL_SECONDS (default 86400 = 24 h).
 *
 * Graceful degradation: any Redis error → warn + return null (cache miss).
 * The caller falls through to the normal LLM blueprint call.
 */

const crypto = require('crypto');
const config = require('../config');
const { logStructured } = require('../utils/observability');

let _redisClient = null;

function getRedis() {
    if (!_redisClient) {
        const { getBlueprintClient } = require('../db/redisClient');
        _redisClient = getBlueprintClient();
    }
    return _redisClient;
}

function isEnabled() {
    return config.BLUEPRINT_CACHE_ENABLED === true;
}

/**
 * Compute a SHA-256 hash of the document text used as part of the cache key.
 * We trim + normalise whitespace before hashing so minor formatting differences
 * in the same logical document don't produce cache misses.
 * @param {string} text
 * @returns {string} hex digest
 */
function computeDocumentHash(text) {
    const normalised = String(text || '').replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Build the Redis key.
 * Includes CACHE_SCHEMA_VERSION so a model/prompt change invalidates the cache.
 */
function buildKey(docHash, routingMode, questionCount, language) {
    const v = config.CACHE_SCHEMA_VERSION || '1';
    return `blueprint:${v}:${docHash}:${routingMode}:${questionCount}:${language}`;
}

/**
 * Look up blueprint in cache.
 * @param {string} docHash
 * @param {string} routingMode
 * @param {number} questionCount
 * @param {string} language
 * @param {string} [traceId]
 * @returns {Promise<{ blueprint: object[]|null, cacheAgeSeconds: number|null }>}
 */
async function getBlueprint(docHash, routingMode, questionCount, language, traceId) {
    if (!isEnabled()) return { blueprint: null, cacheAgeSeconds: null };
    const key = buildKey(docHash, routingMode, questionCount, language);
    try {
        const redis = getRedis();
        const [raw, ttlLeft] = await Promise.all([
            redis.get(key),
            redis.ttl(key),
        ]);
        if (!raw) return { blueprint: null, cacheAgeSeconds: null };

        const blueprint = JSON.parse(raw);
        const configuredTtl = config.BLUEPRINT_CACHE_TTL_SECONDS || 86400;
        const cacheAgeSeconds = ttlLeft >= 0 ? configuredTtl - ttlLeft : null;

        logStructured({
            level: 'info', traceId, phase: 'blueprint', event: 'blueprint_cache_hit',
            metadata: { cache_hit: true, doc_hash: docHash, cache_age_seconds: cacheAgeSeconds },
        });
        console.log(`[BlueprintCache] HIT key=${key} age=${cacheAgeSeconds}s intents=${blueprint.length}`);
        return { blueprint, cacheAgeSeconds };
    } catch (err) {
        console.warn(`[BlueprintCache] GET error (degraded): ${err.message}`);
        logStructured({
            level: 'warn', traceId, phase: 'blueprint', event: 'blueprint_cache_unavailable',
            metadata: { reason_code: 'blueprint_cache_unavailable', error: err.message },
        });
        return { blueprint: null, cacheAgeSeconds: null };
    }
}

/**
 * Store blueprint in cache.
 * @param {string} docHash
 * @param {string} routingMode
 * @param {number} questionCount
 * @param {string} language
 * @param {object[]} blueprint
 * @param {string} [traceId]
 */
async function setBlueprint(docHash, routingMode, questionCount, language, blueprint, traceId) {
    if (!isEnabled()) return;
    const key = buildKey(docHash, routingMode, questionCount, language);
    const ttl = config.BLUEPRINT_CACHE_TTL_SECONDS || 86400;
    try {
        const redis = getRedis();
        await redis.set(key, JSON.stringify(blueprint), 'EX', ttl);
        console.log(`[BlueprintCache] SET key=${key} ttl=${ttl}s intents=${blueprint.length}`);
    } catch (err) {
        console.warn(`[BlueprintCache] SET error (degraded): ${err.message}`);
        logStructured({
            level: 'warn', traceId, phase: 'blueprint', event: 'blueprint_cache_unavailable',
            metadata: { reason_code: 'blueprint_cache_unavailable', error: err.message },
        });
    }
}

module.exports = { computeDocumentHash, getBlueprint, setBlueprint, isEnabled };
