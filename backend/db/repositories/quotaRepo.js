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

async function getRpmCount(fingerprint, modelId, windowMs) {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const { rows } = await pg.query(`
        SELECT COUNT(*) as count FROM gemini_rpm_hits
        WHERE key_fingerprint = $1 AND model_id = $2 AND hit_at >= $3
    `, [fingerprint, modelId, cutoff]);
    return parseInt(rows[0].count, 10) || 0;
}

async function recordRpmHit(fingerprint, modelId) {
    await pg.query(`
        INSERT INTO gemini_rpm_hits (key_fingerprint, model_id, hit_at)
        VALUES ($1, $2, now())
    `, [fingerprint, modelId]);
}

async function pruneOldRpm(maxAgeMs = 120000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    await pg.query(`
        DELETE FROM gemini_rpm_hits WHERE hit_at < $1
    `, [cutoff]);
}

module.exports = { 
    getUsage, recordUsage, setUsageAtLeast, resetUsage, getUsageSummary,
    getRpmCount, recordRpmHit, pruneOldRpm
};
