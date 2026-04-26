const pg = require('../pgPool');

async function insertTest(data) {
    const { rows } = await pg.query(`
        INSERT INTO tests (
            document_id,
            title,
            questions_json,
            total_questions,
            generation_metrics,
            generation_run_id,
            sort_order
        )
        VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT MAX(sort_order) + 1 FROM tests), 1))
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
        SELECT t.id, t.title, t.total_questions, t.created_at, t.sort_order,
               d.original_name AS document_name, d.page_count,
               d.extraction_quality,
               d.low_text_quality
        FROM tests t
        LEFT JOIN documents d ON t.document_id = d.id
        ORDER BY t.sort_order ASC, t.created_at DESC, t.id DESC
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

async function moveTestPosition(id, direction) {
    return pg.transaction(async (client) => {
        const currentRes = await client.query(
            'SELECT id, sort_order FROM tests WHERE id = $1',
            [id],
        );
        const current = currentRes.rows[0] || null;
        if (!current) return { found: false, moved: false };

        const comparator = direction === 'up' ? '<' : '>';
        const order = direction === 'up' ? 'DESC' : 'ASC';

        const neighborRes = await client.query(
            `
            SELECT id, sort_order
            FROM tests
            WHERE sort_order ${comparator} $1
            ORDER BY sort_order ${order}, id ${order}
            LIMIT 1
            `,
            [current.sort_order],
        );
        const neighbor = neighborRes.rows[0] || null;
        if (!neighbor) return { found: true, moved: false };

        await client.query(
            'UPDATE tests SET sort_order = $1 WHERE id = $2',
            [neighbor.sort_order, current.id],
        );
        await client.query(
            'UPDATE tests SET sort_order = $1 WHERE id = $2',
            [current.sort_order, neighbor.id],
        );

        return { found: true, moved: true };
    });
}

module.exports = { insertTest, getAllTests, getTestById, deleteTest, moveTestPosition };
