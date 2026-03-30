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
            requests, rpm_hits, tpm_estimated
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
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

module.exports = {
    recordUsage,
    getUsageSummary,
    getUsageByModel,
};

