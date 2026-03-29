const pg = require('../pgPool');

async function getUsage(fingerprint, date, modelId) {
    const { rows } = await pg.query(`
        SELECT requests FROM gemini_usage
        WHERE key_fingerprint = $1 AND usage_date = $2 AND model_id = $3
    `, [fingerprint, date, modelId]);
    return rows[0] ? rows[0].requests : 0;
}

async function recordUsage(fingerprint, date, modelId) {
    await pg.query(`
        INSERT INTO gemini_usage (key_fingerprint, usage_date, model_id, requests)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (key_fingerprint, usage_date, model_id)
        DO UPDATE SET requests = gemini_usage.requests + 1
    `, [fingerprint, date, modelId]);
}

/** Подтянуть счётчик до minRequests (после 429 «дневная квота» от Google). */
async function setUsageAtLeast(fingerprint, date, modelId, minRequests) {
    const n = Math.max(0, Math.floor(Number(minRequests) || 0));
    await pg.query(`
        INSERT INTO gemini_usage (key_fingerprint, usage_date, model_id, requests)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (key_fingerprint, usage_date, model_id)
        DO UPDATE SET requests = GREATEST(gemini_usage.requests, EXCLUDED.requests)
    `, [fingerprint, date, modelId, n]);
}

async function resetUsage(fingerprint) {
    if (fingerprint) {
        await pg.query('DELETE FROM gemini_usage WHERE key_fingerprint = $1', [fingerprint]);
    } else {
        console.warn('[QUOTA] resetUsage called without fingerprint, ignoring to prevent wiping all users.');
    }
}

async function getUsageSummary(fingerprint, date) {
    const { rows } = await pg.query(`
        SELECT model_id, requests FROM gemini_usage
        WHERE key_fingerprint = $1 AND usage_date = $2
    `, [fingerprint, date]);
    return rows;
}

module.exports = { getUsage, recordUsage, setUsageAtLeast, resetUsage, getUsageSummary };
