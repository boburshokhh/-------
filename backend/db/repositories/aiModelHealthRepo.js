const pg = require('../pgPool');

async function upsertHealth({
    aiModelId, apiModelId = null,
    windowStart, windowEnd,
    totalRequests = 0, failedRequests = 0,
    errorRate = 0, avgLatencyMs = null, p95LatencyMs = null,
    isHealthy = true, isSuppressed = false, metadata = {},
}) {
    const { rows } = await pg.query(`
        INSERT INTO ai_model_health (
            ai_model_id, api_model_id, window_start, window_end,
            total_requests, failed_requests, error_rate,
            avg_latency_ms, p95_latency_ms, is_healthy, is_suppressed, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (ai_model_id, window_start) DO UPDATE SET
            window_end = EXCLUDED.window_end,
            total_requests = EXCLUDED.total_requests,
            failed_requests = EXCLUDED.failed_requests,
            error_rate = EXCLUDED.error_rate,
            avg_latency_ms = EXCLUDED.avg_latency_ms,
            p95_latency_ms = EXCLUDED.p95_latency_ms,
            is_healthy = EXCLUDED.is_healthy,
            is_suppressed = EXCLUDED.is_suppressed,
            metadata = EXCLUDED.metadata
        RETURNING *
    `, [
        aiModelId, apiModelId, windowStart, windowEnd,
        totalRequests, failedRequests, errorRate,
        avgLatencyMs, p95LatencyMs, isHealthy, isSuppressed,
        JSON.stringify(metadata),
    ]);
    return rows[0];
}

async function getLatestHealth(aiModelId) {
    const { rows } = await pg.query(`
        SELECT * FROM ai_model_health
        WHERE ai_model_id = $1
        ORDER BY window_start DESC LIMIT 1
    `, [aiModelId]);
    return rows[0] || null;
}

async function listHealthy({ onlyHealthy = true, limit = 100 } = {}) {
    const where = onlyHealthy ? 'WHERE is_healthy = true AND is_suppressed = false' : '';
    const { rows } = await pg.query(`
        SELECT DISTINCT ON (ai_model_id)
            ai_model_id, api_model_id, is_healthy, is_suppressed,
            error_rate, avg_latency_ms, p95_latency_ms, window_start
        FROM ai_model_health
        ${where}
        ORDER BY ai_model_id, window_start DESC
        LIMIT $1
    `, [limit]);
    return rows;
}

async function listAllLatest({ limit = 200 } = {}) {
    const { rows } = await pg.query(`
        SELECT DISTINCT ON (ai_model_id) *
        FROM ai_model_health
        ORDER BY ai_model_id, window_start DESC
        LIMIT $1
    `, [limit]);
    return rows;
}

module.exports = { upsertHealth, getLatestHealth, listHealthy, listAllLatest };
