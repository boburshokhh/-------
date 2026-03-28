const pg = require('../pgPool');

async function insertRun(data) {
    const { rows } = await pg.query(`
        INSERT INTO generation_runs (
            document_id, status, model, target_min, target_max, target_count,
            language, budget_metrics
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
                intent.theme || null,
                intent.section || null,
                intent.intent || intent.intent_text || '',
                intent.difficulty || null,
                intent.type || 'multiple_choice',
                'pending',
            ]);
            inserted.push({ ...intent, _dbId: rows[0].id });
        }
        return inserted;
    });
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

async function insertQuestionSources(questionId, sources) {
    if (!sources || sources.length === 0) return;
    for (const src of sources) {
        const chunkId = src.chunk_id;
        if (chunkId == null) continue;
        await pg.query(`
            INSERT INTO question_sources (question_id, chunk_id, quote)
            VALUES ($1,$2,$3)
        `, [questionId, chunkId, src.quote || null]);
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
    const { rows } = await pg.query('SELECT * FROM generation_runs WHERE id = $1', [id]);
    return rows[0] || null;
}

module.exports = {
    insertRun,
    updateRunFinished,
    insertIntents,
    updateIntentStatus,
    insertQuestion,
    insertQuestionSources,
    insertPipelineEvent,
    getRunById,
};
