const pg = require('../pgPool');
const config = require('../../config');

/** Split array into chunks of at most `size` elements */
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

async function insertRun(data) {
    const { rows } = await pg.query(`
        INSERT INTO generation_runs (
            document_id, status, model, target_min, target_max, target_count,
            language, budget_metrics, requested_mode_code, mode_profile_id, mode_profile_version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id
    `, [
        data.document_id,
        data.status || 'running',
        data.model || null,
        data.target_min || null,
        data.target_max || null,
        data.target_count || null,
        data.language || null,
        data.budget_metrics ? JSON.stringify(data.budget_metrics) : null,
        data.requested_mode_code || null,
        data.mode_profile_id || null,
        data.mode_profile_version || null,
    ]);
    return rows[0];
}

async function updateRunFinished(id, data) {
    await pg.query(`
        UPDATE generation_runs SET
            status = $2,
            final_metrics = $3,
            fallback_decisions = $4,
            finished_at = now(),
            duration_ms = $5,
            error_message = $6
        WHERE id = $1
    `, [
        id,
        data.status || 'completed',
        data.final_metrics ? JSON.stringify(data.final_metrics) : null,
        data.fallback_decisions ? JSON.stringify(data.fallback_decisions) : null,
        data.duration_ms || null,
        data.error_message || null,
    ]);
}

async function insertIntents(runId, intents) {
    if (!intents || intents.length === 0) return [];

    if (!config.BULK_INSERT_ENABLED) {
        // Legacy one-by-one path
        return pg.transaction(async (client) => {
            const inserted = [];
            for (let i = 0; i < intents.length; i++) {
                const intent = intents[i];
                const { rows } = await client.query(`
                    INSERT INTO intents (run_id, intent_index, theme, section, intent_text, difficulty, type, status)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    RETURNING id
                `, [
                    runId, i,
                    intent.theme || null, intent.section || null,
                    intent.intent || intent.intent_text || '',
                    intent.difficulty || null,
                    intent.type || 'multiple_choice', 'pending',
                ]);
                inserted.push({ ...intent, _dbId: rows[0].id });
            }
            return inserted;
        });
    }

    // Bulk INSERT path
    const maxRows = config.BULK_INSERT_MAX_ROWS || 1000;
    const inserted = [];
    for (const batch of chunkArray(intents, maxRows)) {
        const values = [];
        const params = [];
        let p = 1;
        for (let i = 0; i < batch.length; i++) {
            const intent = batch[i];
            const globalIdx = inserted.length + i;
            values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            params.push(
                runId, globalIdx,
                intent.theme || null, intent.section || null,
                intent.intent || intent.intent_text || '',
                intent.difficulty || null,
                intent.type || 'multiple_choice', 'pending',
            );
        }
        const sql = `INSERT INTO intents (run_id, intent_index, theme, section, intent_text, difficulty, type, status)
                     VALUES ${values.join(',')} RETURNING id`;
        try {
            const { rows } = await pg.query(sql, params);
            for (let i = 0; i < batch.length; i++) {
                inserted.push({ ...batch[i], _dbId: rows[i]?.id });
            }
        } catch (e) {
            console.error('[runRepo] Bulk intent INSERT failed, rolling back:', e.message);
            const err = new Error('db_bulk_insert_failed: intents');
            err.code = 'db_bulk_insert_failed';
            throw err;
        }
    }
    return inserted;
}

async function updateIntentStatus(intentId, status, skipReason, evidenceScore) {
    await pg.query(`
        UPDATE intents SET status = $2, skip_reason = $3, evidence_score = $4 WHERE id = $1
    `, [intentId, status, skipReason || null, evidenceScore ?? null]);
}

async function insertQuestion(runId, questionIndex, q) {
    const { rows } = await pg.query(`
        INSERT INTO questions (run_id, question_index, type, question, options, correct_index, difficulty, explanation, hint, grounded)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
    `, [
        runId, questionIndex,
        q.type || 'multiple_choice',
        q.question,
        JSON.stringify(q.options),
        q.correctIndex,
        q.difficulty || 'understand',
        q.explanation || '',
        q.hint || '',
        q.grounded !== false,
    ]);
    return rows[0];
}

/**
 * Bulk-insert all questions for a run, then bulk-insert their sources.
 * Falls back to one-by-one if BULK_INSERT_ENABLED=false.
 * @param {number} runId
 * @param {object[]} questions - array of question objects (same shape as insertQuestion)
 * @returns {Promise<void>}
 */
async function insertQuestionsBulk(runId, questions) {
    if (!questions || questions.length === 0) return;

    if (!config.BULK_INSERT_ENABLED) {
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const qRow = await insertQuestion(runId, i, q);
            if (q.sources && q.sources.length > 0) await insertQuestionSources(qRow.id, q.sources);
        }
        return;
    }

    const maxRows = config.BULK_INSERT_MAX_ROWS || 1000;

    // Insert questions in bulk chunks
    const questionIds = [];
    for (const batch of chunkArray(questions, maxRows)) {
        const values = [];
        const params = [];
        let p = 1;
        for (let i = 0; i < batch.length; i++) {
            const q = batch[i];
            const globalIdx = questionIds.length + i;
            values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            params.push(
                runId, globalIdx,
                q.type || 'multiple_choice',
                q.question,
                JSON.stringify(q.options),
                q.correctIndex,
                q.difficulty || 'understand',
                q.explanation || '',
                q.hint || '',
                q.grounded !== false,
            );
        }
        const sql = `INSERT INTO questions
            (run_id, question_index, type, question, options, correct_index, difficulty, explanation, hint, grounded)
            VALUES ${values.join(',')} RETURNING id`;
        try {
            const { rows } = await pg.query(sql, params);
            for (const row of rows) questionIds.push(row.id);
        } catch (e) {
            console.error('[runRepo] Bulk questions INSERT failed:', e.message);
            const err = new Error('db_bulk_insert_failed: questions');
            err.code = 'db_bulk_insert_failed';
            throw err;
        }
    }

    // Insert sources for questions that have them
    const sourcePairs = []; // { questionId, sources }
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (q.sources && q.sources.length > 0 && questionIds[i] != null) {
            sourcePairs.push({ questionId: questionIds[i], sources: q.sources });
        }
    }

    // Bulk sources: flatten all (questionId, chunkId, quote) rows
    const allSourceRows = [];
    for (const { questionId, sources } of sourcePairs) {
        for (const src of sources) {
            if (src.chunk_id != null) allSourceRows.push({ questionId, chunkId: src.chunk_id, quote: src.quote || null });
        }
    }

    for (const batch of chunkArray(allSourceRows, maxRows)) {
        const values = [];
        const params = [];
        let p = 1;
        for (const row of batch) {
            values.push(`($${p++},$${p++},$${p++})`);
            params.push(row.questionId, row.chunkId, row.quote);
        }
        try {
            if (values.length > 0) {
                await pg.query(
                    `INSERT INTO question_sources (question_id, chunk_id, quote) VALUES ${values.join(',')}`,
                    params,
                );
            }
        } catch (e) {
            console.error('[runRepo] Bulk question_sources INSERT failed:', e.message);
            const err = new Error('db_bulk_insert_failed: question_sources');
            err.code = 'db_bulk_insert_failed';
            throw err;
        }
    }
}

async function insertQuestionSources(questionId, sources) {
    if (!sources || sources.length === 0) return;
    const valid = sources.filter(s => s.chunk_id != null);
    if (valid.length === 0) return;

    if (!config.BULK_INSERT_ENABLED || valid.length === 1) {
        for (const src of valid) {
            await pg.query(
                `INSERT INTO question_sources (question_id, chunk_id, quote) VALUES ($1,$2,$3)`,
                [questionId, src.chunk_id, src.quote || null],
            );
        }
        return;
    }

    const maxRows = config.BULK_INSERT_MAX_ROWS || 1000;
    for (const batch of chunkArray(valid, maxRows)) {
        const values = [];
        const params = [];
        let p = 1;
        for (const src of batch) {
            values.push(`($${p++},$${p++},$${p++})`);
            params.push(questionId, src.chunk_id, src.quote || null);
        }
        try {
            await pg.query(
                `INSERT INTO question_sources (question_id, chunk_id, quote) VALUES ${values.join(',')}`,
                params,
            );
        } catch (e) {
            console.error('[runRepo] Bulk question_sources INSERT failed:', e.message);
            const err = new Error('db_bulk_insert_failed: question_sources');
            err.code = 'db_bulk_insert_failed';
            throw err;
        }
    }
}

async function insertPipelineEvent(data) {
    await pg.query(`
        INSERT INTO pipeline_run_events (run_id, document_id, phase, event, level, reason_code, defect_class, metrics, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
        data.run_id || null,
        data.document_id || null,
        data.phase || 'unknown',
        data.event || '',
        data.level || 'info',
        data.reason_code || null,
        data.defect_class || null,
        data.metrics ? JSON.stringify(data.metrics) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
    ]);
}

async function getRunById(id) {
    const { rows } = await pg.query(`
        SELECT
            generation_runs.*,
            generation_runs.started_at AS created_at
        FROM generation_runs
        WHERE id = $1
    `, [id]);
    return rows[0] || null;
}

async function listRuns({ status, documentId, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (status) {
        where.push(`status = $${i++}`);
        params.push(status);
    }
    if (documentId) {
        where.push(`document_id = $${i++}`);
        params.push(documentId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pg.query(`
        SELECT
            id,
            document_id,
            status,
            target_count,
            language,
            started_at AS created_at,
            finished_at,
            duration_ms,
            budget_metrics,
            fallback_decisions,
            error_message
        FROM generation_runs
        ${whereSql}
        ORDER BY started_at DESC
        LIMIT $${i++} OFFSET $${i}
    `, [...params, limit, offset]);
    
    const { rows: countRows } = await pg.query(`
        SELECT COUNT(*) as total FROM generation_runs ${whereSql}
    `, params);
    
    return { rows, total: parseInt(countRows[0].total, 10) };
}

async function getPipelineEventsForRun(runId) {
    const { rows } = await pg.query(`
        SELECT * FROM pipeline_run_events
        WHERE run_id = $1
        ORDER BY created_at ASC, id ASC
    `, [runId]);
    return rows;
}

async function getIntentsForRun(runId) {
    const { rows } = await pg.query(`
        SELECT * FROM intents WHERE run_id = $1 ORDER BY id ASC
    `, [runId]);
    return rows;
}

async function getQuestionsForRun(runId) {
    const { rows } = await pg.query(`
        SELECT * FROM questions WHERE run_id = $1 ORDER BY id ASC
    `, [runId]);
    return rows;
}

module.exports = {
    insertRun,
    updateRunFinished,
    insertIntents,
    updateIntentStatus,
    insertQuestion,
    insertQuestionsBulk,
    insertQuestionSources,
    insertPipelineEvent,
    getRunById,
    listRuns,
    getPipelineEventsForRun,
    getIntentsForRun,
    getQuestionsForRun,
};
