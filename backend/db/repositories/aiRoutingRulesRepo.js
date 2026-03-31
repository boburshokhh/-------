const pg = require('../pgPool');

async function createRule({
    name,
    phase,
    priority = 0,
    isEnabled = true,
    conditions = {},
    actions = {},
    stageKey = null,
    allowPremium = false,
    allowPreview = false,
    stableOnly = true,
    maxEscalationDepth = 1,
} = {}) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_routing_rules (
            name, phase, priority, is_enabled, conditions, actions,
            stage_key, allow_premium, allow_preview, stable_only, max_escalation_depth
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id
        `,
        [
            name,
            phase,
            priority,
            !!isEnabled,
            JSON.stringify(conditions || {}),
            JSON.stringify(actions || {}),
            stageKey,
            !!allowPremium,
            !!allowPreview,
            !!stableOnly,
            Number(maxEscalationDepth) || 1,
        ],
    );
    return rows[0].id;
}

async function updateRule(ruleId, {
    name,
    phase,
    priority,
    isEnabled,
    conditions,
    actions,
    stageKey,
    allowPremium,
    allowPreview,
    stableOnly,
    maxEscalationDepth,
} = {}) {
    const sets = [];
    const params = [];
    let i = 1;

    if (typeof name !== 'undefined') { sets.push(`name = $${i}`); params.push(name); i++; }
    if (typeof phase !== 'undefined') { sets.push(`phase = $${i}`); params.push(phase); i++; }
    if (typeof priority !== 'undefined') { sets.push(`priority = $${i}`); params.push(priority); i++; }
    if (typeof isEnabled !== 'undefined') { sets.push(`is_enabled = $${i}`); params.push(!!isEnabled); i++; }
    if (typeof conditions !== 'undefined') { sets.push(`conditions = $${i}`); params.push(JSON.stringify(conditions || {})); i++; }
    if (typeof actions !== 'undefined') { sets.push(`actions = $${i}`); params.push(JSON.stringify(actions || {})); i++; }
    if (typeof stageKey !== 'undefined') { sets.push(`stage_key = $${i}`); params.push(stageKey); i++; }
    if (typeof allowPremium !== 'undefined') { sets.push(`allow_premium = $${i}`); params.push(!!allowPremium); i++; }
    if (typeof allowPreview !== 'undefined') { sets.push(`allow_preview = $${i}`); params.push(!!allowPreview); i++; }
    if (typeof stableOnly !== 'undefined') { sets.push(`stable_only = $${i}`); params.push(!!stableOnly); i++; }
    if (typeof maxEscalationDepth !== 'undefined') { sets.push(`max_escalation_depth = $${i}`); params.push(Number(maxEscalationDepth) || 1); i++; }

    sets.push(`updated_at = now()`);

    await pg.query(
        `UPDATE ai_routing_rules SET ${sets.join(', ')} WHERE id = $${i}`,
        [...params, ruleId],
    );
}

async function enableRule(ruleId, isEnabled) {
    await pg.query(
        `UPDATE ai_routing_rules SET is_enabled = $1, updated_at = now() WHERE id = $2`,
        [!!isEnabled, ruleId],
    );
}

async function getRuleById(ruleId) {
    const { rows } = await pg.query(`SELECT * FROM ai_routing_rules WHERE id = $1 LIMIT 1`, [ruleId]);
    return rows[0] || null;
}

async function listRulesByPhase(phase, { enabledOnly = true } = {}) {
    const where = ['phase = $1'];
    const params = [phase];
    if (enabledOnly) {
        where.push('is_enabled = true');
    }
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_routing_rules
        WHERE ${where.join(' AND ')}
        ORDER BY priority DESC, id ASC
        `,
        params,
    );
    return rows;
}

async function listRules({ phase = null, enabledOnly = true } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (phase) {
        where.push(`phase = $${i++}`);
        params.push(phase);
    }
    if (enabledOnly) where.push('is_enabled = true');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_routing_rules
        ${whereSql}
        ORDER BY phase ASC, priority DESC, id ASC
        `,
        params,
    );
    return rows;
}

module.exports = {
    createRule,
    updateRule,
    enableRule,
    getRuleById,
    listRulesByPhase,
    listRules,
};
