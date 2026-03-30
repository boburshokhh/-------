'use strict';

/**
 * Preview / Canary Service
 *
 * Manages safe preview model rollout:
 *  - Canary percentage: only N% of eligible requests route to preview
 *  - Health suppression: auto-disable preview if error rate exceeds threshold
 *  - Separate diagnostics: track preview vs stable performance
 */

const aiModelHealthRepo = require('../db/repositories/aiModelHealthRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const { logStructured } = require('../utils/observability');

const PREVIEW_ERROR_RATE_THRESHOLD = 0.15;
const PREVIEW_MIN_REQUESTS_FOR_JUDGMENT = 5;

let _policiesCache = null;
const CACHE_TTL = 15_000;

async function _policies() {
    if (_policiesCache && Date.now() - _policiesCache.ts < CACHE_TTL) return _policiesCache.data;
    let data;
    try { data = await aiGlobalPoliciesRepo.getPolicies(); } catch { data = null; }
    if (!data) data = { preview_canary_percent: 0, stable_only: false };
    _policiesCache = { ts: Date.now(), data };
    return data;
}

function invalidateCache() { _policiesCache = null; }

/**
 * Determine if this request should be routed to a preview model.
 * Uses deterministic hash-based sampling to achieve target percentage.
 */
async function shouldUsePreview({ stageKey, traceId, runId }) {
    const policies = await _policies();

    if (policies.stable_only) return { allow: false, reason: 'stable_only_policy' };

    const canaryPercent = policies.preview_canary_percent || 0;
    if (canaryPercent <= 0) return { allow: false, reason: 'canary_disabled' };

    const seed = `${traceId || ''}:${runId || ''}:${stageKey || ''}`;
    const hash = simpleHash(seed);
    const bucket = hash % 100;

    if (bucket >= canaryPercent) return { allow: false, reason: 'outside_canary_bucket' };

    return { allow: true, reason: 'canary_selected', bucket, canaryPercent };
}

/**
 * Check if a specific preview model is healthy enough to use.
 */
async function isPreviewModelHealthy(aiModelId) {
    if (!aiModelId) return true;

    let health;
    try {
        health = await aiModelHealthRepo.getLatestHealth(aiModelId);
    } catch {
        return true;
    }

    if (!health) return true;

    if (health.is_suppressed) return false;

    if (health.total_requests >= PREVIEW_MIN_REQUESTS_FOR_JUDGMENT
        && health.error_rate > PREVIEW_ERROR_RATE_THRESHOLD) {
        return false;
    }

    return health.is_healthy !== false;
}

/**
 * Record a preview model call result for health tracking.
 */
async function recordPreviewResult({
    aiModelId, apiModelId, success, latencyMs,
}) {
    if (!aiModelId) return;

    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setMinutes(windowStart.getMinutes() - (windowStart.getMinutes() % 15));
    windowStart.setSeconds(0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setMinutes(windowEnd.getMinutes() + 15);

    try {
        const existing = await aiModelHealthRepo.getLatestHealth(aiModelId);
        const isSameWindow = existing
            && new Date(existing.window_start).getTime() === windowStart.getTime();

        const total = isSameWindow ? (existing.total_requests || 0) + 1 : 1;
        const failed = isSameWindow
            ? (existing.failed_requests || 0) + (success ? 0 : 1)
            : (success ? 0 : 1);
        const errorRate = total > 0 ? failed / total : 0;

        const shouldSuppress = total >= PREVIEW_MIN_REQUESTS_FOR_JUDGMENT
            && errorRate > PREVIEW_ERROR_RATE_THRESHOLD;

        await aiModelHealthRepo.upsertHealth({
            aiModelId,
            apiModelId,
            windowStart,
            windowEnd,
            totalRequests: total,
            failedRequests: failed,
            errorRate,
            avgLatencyMs: latencyMs || null,
            p95LatencyMs: latencyMs || null,
            isHealthy: !shouldSuppress,
            isSuppressed: shouldSuppress,
            metadata: { last_success: success, last_latency_ms: latencyMs },
        });

        if (shouldSuppress) {
            logStructured({
                level: 'warn',
                phase: 'generate',
                event: 'preview_model_suppressed',
                metrics: {
                    ai_model_id: aiModelId,
                    api_model_id: apiModelId,
                    error_rate: errorRate,
                    total_requests: total,
                    failed_requests: failed,
                },
            });
        }
    } catch (e) {
        console.warn('[PreviewCanary] recordPreviewResult error:', e.message);
    }
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash);
}

module.exports = {
    shouldUsePreview,
    isPreviewModelHealthy,
    recordPreviewResult,
    invalidateCache,
    PREVIEW_ERROR_RATE_THRESHOLD,
};
