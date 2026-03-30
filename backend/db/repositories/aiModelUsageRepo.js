const pg = require('../pgPool');

async function recordUsage({
    keyFingerprint,
    aiModelId,
    usageDate = null,
    phase = 'default',
    requestsDelta = 1,
    rpmHitsDelta = 0,
    tpmEstimatedDelta = null,
}) {
    if (!keyFingerprint) throw new Error('recordUsage: keyFingerprint is required');
    if (!aiModelId) throw new Error('recordUsage: aiModelId is required');

    const date = usageDate || new Date().toISOString().slice(0, 10);
    const { rows } = await pg.query(
        `
        INSERT INTO ai_model_usage (
            key_fingerprint, usage_date, ai_model_id, phase,
            requests, rpm_hits, tpm_estimated, failed_requests
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7, 0)
        ON CONFLICT (key_fingerprint, usage_date, ai_model_id, phase) DO UPDATE
        SET
            requests = ai_model_usage.requests + EXCLUDED.requests,
            rpm_hits = ai_model_usage.rpm_hits + EXCLUDED.rpm_hits,
            tpm_estimated = COALESCE(ai_model_usage.tpm_estimated, 0) + COALESCE(EXCLUDED.tpm_estimated, 0),
            last_used_at = now(),
            updated_at = now()
        RETURNING id
        `,
        [
            keyFingerprint,
            date,
            aiModelId,
            phase,
            Number(requestsDelta || 0),
            Number(rpmHitsDelta || 0),
            tpmEstimatedDelta == null ? null : Number(tpmEstimatedDelta),
        ],
    );

    return rows[0].id;
}

/**
 * Increment failed_requests for the same key as successful usage (API errors, parse failures optional).
 */
async function incrementFailed({
    keyFingerprint,
    aiModelId,
    usageDate = null,
    phase = 'default',
    delta = 1,
}) {
    if (!keyFingerprint) throw new Error('incrementFailed: keyFingerprint is required');
    if (!aiModelId) throw new Error('incrementFailed: aiModelId is required');
    const date = usageDate || new Date().toISOString().slice(0, 10);
    const { rows } = await pg.query(
        `
        INSERT INTO ai_model_usage (
            key_fingerprint, usage_date, ai_model_id, phase,
            requests, rpm_hits, tpm_estimated, failed_requests
        )
        VALUES ($1,$2,$3,$4, 0, 0, NULL, $5)
        ON CONFLICT (key_fingerprint, usage_date, ai_model_id, phase) DO UPDATE
        SET
            failed_requests = ai_model_usage.failed_requests + EXCLUDED.failed_requests,
            updated_at = now()
        RETURNING id
        `,
        [keyFingerprint, date, aiModelId, phase, Number(delta) || 0],
    );
    return rows[0]?.id || null;
}

/**
 * Rows for budget snapshot: usage + model catalog fields.
 */
async function listUsageWithModelsForDate({ keyFingerprint, usageDate = null } = {}) {
    if (!keyFingerprint) throw new Error('listUsageWithModelsForDate: keyFingerprint is required');
    const date = usageDate || new Date().toISOString().slice(0, 10);
    const { rows } = await pg.query(
        `
        SELECT
            u.phase,
            u.requests,
            u.failed_requests,
            m.api_model_id,
            m.is_preview,
            m.model_role,
            m.category
        FROM ai_model_usage u
        JOIN ai_models m ON m.id = u.ai_model_id
        WHERE u.key_fingerprint = $1 AND u.usage_date = $2
        `,
        [keyFingerprint, date],
    );
    return rows;
}

async function getUsageSummary({ keyFingerprint, usageDate = null }) {
    if (!keyFingerprint) throw new Error('getUsageSummary: keyFingerprint is required');
    const date = usageDate || new Date().toISOString().slice(0, 10);

    const { rows } = await pg.query(
        `
        SELECT
            ai_model_id,
            phase,
            SUM(requests)  AS requests,
            SUM(rpm_hits)  AS rpm_hits,
            SUM(tpm_estimated) AS tpm_estimated
        FROM ai_model_usage
        WHERE key_fingerprint = $1 AND usage_date = $2
        GROUP BY ai_model_id, phase
        ORDER BY SUM(requests) DESC
        `,
        [keyFingerprint, date],
    );

    return rows;
}

async function getUsageByModel({ keyFingerprint, usageDate = null, aiModelId, phase = 'default' }) {
    if (!aiModelId) throw new Error('getUsageByModel: aiModelId is required');
    if (!keyFingerprint) throw new Error('getUsageByModel: keyFingerprint is required');
    const date = usageDate || new Date().toISOString().slice(0, 10);

    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_model_usage
        WHERE key_fingerprint = $1 AND usage_date = $2 AND ai_model_id = $3 AND phase = $4
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [keyFingerprint, date, aiModelId, phase],
    );
    return rows[0] || null;
}

async function listUsage({
    fromDate = null,
    toDate = null,
    phase = null,
    apiModelId = null,
    keyFingerprint = null,
    limit = 100,
    offset = 0,
} = {}) {
    const where = [];
    const params = [];
    let i = 1;

    if (fromDate) { where.push(`u.usage_date >= $${i++}`); params.push(fromDate); }
    if (toDate) { where.push(`u.usage_date <= $${i++}`); params.push(toDate); }
    if (phase) { where.push(`u.phase = $${i++}`); params.push(phase); }
    if (apiModelId) { where.push(`m.api_model_id = $${i++}`); params.push(apiModelId); }
    if (keyFingerprint) { where.push(`u.key_fingerprint = $${i++}`); params.push(keyFingerprint); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pg.query(
        `
        SELECT
            u.id,
            u.key_fingerprint,
            u.usage_date,
            u.phase,
            u.requests,
            u.rpm_hits,
            u.tpm_estimated,
            u.failed_requests,
            u.last_used_at,
            m.id AS model_id,
            m.ui_name,
            m.api_model_id
        FROM ai_model_usage u
        JOIN ai_models m ON m.id = u.ai_model_id
        ${whereSql}
        ORDER BY u.usage_date DESC, u.last_used_at DESC, u.id DESC
        LIMIT $${i++} OFFSET $${i}
        `,
        [...params, Math.max(1, Number(limit || 100)), Math.max(0, Number(offset || 0))],
    );
    return rows;
}

module.exports = {
    recordUsage,
    incrementFailed,
    listUsageWithModelsForDate,
    getUsageSummary,
    getUsageByModel,
    listUsage,
};

