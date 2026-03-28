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

async function getResultDetailById(id) {
    const { rows } = await pg.query(`
        SELECT r.*, t.title AS test_title, t.questions_json
        FROM results r
        JOIN tests t ON r.test_id = t.id
        WHERE r.id = $1
    `, [id]);
    return rows[0] || null;
}

module.exports = { insertResult, getResultsByTestId, getResultDetailById };
