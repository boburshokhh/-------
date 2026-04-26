const pg = require('../pgPool');

async function insertTest(data) {
    const { rows } = await pg.query(`
        INSERT INTO tests (document_id, title, questions_json, total_questions, generation_metrics, generation_run_id)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
    `, [
        data.document_id,
        data.title,
        JSON.stringify(data.questions),
        data.total_questions,
        data.generation_metrics ? JSON.stringify(data.generation_metrics) : null,
        data.generation_run_id || null,
    ]);
    return rows[0];
}

async function getAllTests() {
    const { rows } = await pg.query(`
        SELECT t.id, t.title, t.total_questions, t.created_at,
               d.original_name AS document_name, d.page_count,
               d.extraction_quality,
               d.low_text_quality
        FROM tests t
        LEFT JOIN documents d ON t.document_id = d.id
        ORDER BY t.created_at DESC
    `);
    return rows;
}

async function getTestById(id) {
    const { rows } = await pg.query(`
        SELECT t.id, t.title, t.questions_json, t.total_questions, t.created_at,
               t.generation_metrics,
               d.original_name AS document_name, d.page_count,
               d.extraction_quality,
               d.low_text_quality,
               d.parse_diagnostics
        FROM tests t
        LEFT JOIN documents d ON t.document_id = d.id
        WHERE t.id = $1
    `, [id]);
    return rows[0] || null;
}

async function deleteTest(id) {
    const { rowCount } = await pg.query('DELETE FROM tests WHERE id = $1', [id]);
    return rowCount;
}

module.exports = { insertTest, getAllTests, getTestById, deleteTest };
