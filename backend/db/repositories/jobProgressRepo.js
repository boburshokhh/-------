const pgPool = require('../pgPool');

/**
 * @param {string} jobId
 * @param {{ current: object, history: object[] }} payload
 */
async function upsert(jobId, payload) {
    await pgPool.query(
        `INSERT INTO job_progress (job_id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (job_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [jobId, JSON.stringify(payload)],
    );
}

/**
 * @param {string} jobId
 * @returns {Promise<{ payload: { current: object, history: object[] }, updated_at: Date } | null>}
 */
async function getById(jobId) {
    const { rows } = await pgPool.query(
        'SELECT payload, updated_at FROM job_progress WHERE job_id = $1',
        [jobId],
    );
    if (!rows[0]) return null;
    return {
        payload: rows[0].payload,
        updated_at: rows[0].updated_at,
    };
}

/**
 * @param {string} jobId
 */
async function remove(jobId) {
    await pgPool.query('DELETE FROM job_progress WHERE job_id = $1', [jobId]);
}

module.exports = {
    upsert,
    getById,
    remove,
};
