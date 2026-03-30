const pg = require('../pgPool');

async function insertResult(data) {
    const { rows } = await pg.query(`
        INSERT INTO results (test_id, user_name, answers_json, score, max_score, percentage)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
    `, [
        data.test_id,
        data.user_name || 'Аноним',
        JSON.stringify(data.answers),
        data.score,
        data.max_score,
        data.percentage,
    ]);
    return rows[0];
}

async function getResultsByTestId(testId) {
    const { rows } = await pg.query(`
        SELECT id, user_name, score, max_score, percentage, completed_at
        FROM results WHERE test_id = $1
        ORDER BY completed_at DESC
    `, [testId]);
    return rows;
}

/**
 * Все тесты с последней попыткой (опционально по user_name).
 * @param {string|null} userName — если задано, только результаты с этим именем
 */
async function getResultsDashboard(userName) {
    const name = userName && String(userName).trim() ? String(userName).trim() : null;
    const { rows } = await pg.query(`
        SELECT
            t.id AS test_id,
            t.title AS test_title,
            r.id AS latest_result_id,
            r.percentage,
            r.score,
            r.max_score,
            r.completed_at,
            r.user_name AS result_user_name
        FROM tests t
        LEFT JOIN LATERAL (
            SELECT r2.id, r2.test_id, r2.percentage, r2.score, r2.max_score, r2.completed_at, r2.user_name
            FROM results r2
            WHERE r2.test_id = t.id
              AND ($1::text IS NULL OR TRIM(BOTH FROM r2.user_name) = $1)
            ORDER BY r2.completed_at DESC
            LIMIT 1
        ) r ON true
        ORDER BY t.created_at DESC NULLS LAST, t.id DESC
    `, [name]);
    return rows;
}

async function getResultDetailById(id) {
    const { rows } = await pg.query(`
        SELECT r.*, t.title AS test_title, t.questions_json
        FROM results r
        JOIN tests t ON r.test_id = t.id
        WHERE r.id = $1
    `, [id]);
    return rows[0] || null;
}

module.exports = { insertResult, getResultsByTestId, getResultDetailById, getResultsDashboard };
