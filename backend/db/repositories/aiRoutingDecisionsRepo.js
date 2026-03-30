const pg = require('../pgPool');

async function insertDecision({
    runId = null, documentId = null, traceId = null,
    stageKey, agentRole = null,
    selectedModelId = null, selectedApiModelId = null,
    fallbackChain = [], decisionReason = 'auto', decisionSource = 'engine',
    wasFallback = false, fallbackReason = null,
    premiumBlocked = false, previewBlocked = false,
    manualOverrideId = null, costTier = null, isPreview = false,
    quotaSnapshot = null, candidateSnapshot = null, policySnapshot = null,
    latencyMs = null,
}) {
    const { rows } = await pg.query(`
        INSERT INTO ai_routing_decisions (
            run_id, document_id, trace_id, stage_key, agent_role,
            selected_model_id, selected_api_model_id, fallback_chain,
            decision_reason, decision_source, was_fallback, fallback_reason,
            premium_blocked, preview_blocked, manual_override_id,
            cost_tier, is_preview, quota_snapshot, candidate_snapshot, policy_snapshot,
            latency_ms
        ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
        ) RETURNING id
    `, [
        runId, documentId, traceId, stageKey, agentRole,
        selectedModelId, selectedApiModelId,
        JSON.stringify(fallbackChain),
        decisionReason, decisionSource, wasFallback, fallbackReason,
        premiumBlocked, previewBlocked, manualOverrideId,
        costTier, isPreview,
        quotaSnapshot ? JSON.stringify(quotaSnapshot) : null,
        candidateSnapshot ? JSON.stringify(candidateSnapshot) : null,
        policySnapshot ? JSON.stringify(policySnapshot) : null,
        latencyMs,
    ]);
    return rows[0].id;
}

async function listDecisions({
    runId = null, documentId = null, stageKey = null,
    selectedApiModelId = null, limit = 100, offset = 0,
} = {}) {
    const where = [];
    const params = [];
    let i = 1;

    if (runId != null) { where.push(`run_id = $${i++}`); params.push(runId); }
    if (documentId != null) { where.push(`document_id = $${i++}`); params.push(documentId); }
    if (stageKey) { where.push(`stage_key = $${i++}`); params.push(stageKey); }
    if (selectedApiModelId) { where.push(`selected_api_model_id = $${i++}`); params.push(selectedApiModelId); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pg.query(`
        SELECT * FROM ai_routing_decisions
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${i++} OFFSET $${i}
    `, [...params, Math.max(1, Number(limit)), Math.max(0, Number(offset))]);

    return rows;
}

async function getDecisionById(id) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_routing_decisions WHERE id = $1`,
        [id],
    );
    return rows[0] || null;
}

module.exports = { insertDecision, listDecisions, getDecisionById };
