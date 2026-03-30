const pg = require('../pgPool');

async function createRule({
    name,
    phase,
    priority = 0,
    isEnabled = true,
    conditions = {},
    actions = {},
}) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
        `,
        [name, phase, priority, !!isEnabled, JSON.stringify(conditions || {}), JSON.stringify(actions || {})],
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
} = {}) {
    const sets = [];
    const params = [];
    let i = 1;

    // The addSet approach needs explicit conditions.
    if (typeof name !== 'undefined') { sets.push(`name = $${i}`); params.push(name); i++; }
    if (typeof phase !== 'undefined') { sets.push(`phase = $${i}`); params.push(phase); i++; }
    if (typeof priority !== 'undefined') { sets.push(`priority = $${i}`); params.push(priority); i++; }
    if (typeof isEnabled !== 'undefined') { sets.push(`is_enabled = $${i}`); params.push(!!isEnabled); i++; }
    if (typeof conditions !== 'undefined') { sets.push(`conditions = $${i}`); params.push(JSON.stringify(conditions || {})); i++; }
    if (typeof actions !== 'undefined') { sets.push(`actions = $${i}`); params.push(JSON.stringify(actions || {})); i++; }

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

