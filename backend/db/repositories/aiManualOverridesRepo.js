const pg = require('../pgPool');

async function createOverride({
    scope,
    target = '',
    modelId = null,
    isEnabled = true,
    priority = 0,
    conditions = {},
    expiresAt = null,
    reason = null,
    createdBy = null,
}) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_manual_overrides (
            scope, target, model_id, is_enabled, priority, conditions, expires_at, reason, created_by, updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        RETURNING *
        `,
        [
            scope,
            target,
            modelId,
            !!isEnabled,
            Number(priority || 0),
            JSON.stringify(conditions || {}),
            expiresAt,
            reason,
            createdBy,
        ],
    );
    return getOverrideById(rows[0]?.id);
}

async function getOverrideById(id) {
    const { rows } = await pg.query(
        `
        SELECT o.*, m.api_model_id
        FROM ai_manual_overrides o
        LEFT JOIN ai_models m ON m.id = o.model_id
        WHERE o.id = $1
        LIMIT 1
        `,
        [id],
    );
    return rows[0] || null;
}

async function updateOverride(id, {
    scope,
    target,
    modelId,
    isEnabled,
    priority,
    conditions,
    expiresAt,
    reason,
    updatedBy = null,
} = {}) {
    const sets = [];
    const params = [];
    let i = 1;
    if (typeof scope !== 'undefined') { sets.push(`scope = $${i++}`); params.push(scope); }
    if (typeof target !== 'undefined') { sets.push(`target = $${i++}`); params.push(target); }
    if (typeof modelId !== 'undefined') { sets.push(`model_id = $${i++}`); params.push(modelId); }
    if (typeof isEnabled !== 'undefined') { sets.push(`is_enabled = $${i++}`); params.push(!!isEnabled); }
    if (typeof priority !== 'undefined') { sets.push(`priority = $${i++}`); params.push(Number(priority || 0)); }
    if (typeof conditions !== 'undefined') { sets.push(`conditions = $${i++}::jsonb`); params.push(JSON.stringify(conditions || {})); }
    if (typeof expiresAt !== 'undefined') { sets.push(`expires_at = $${i++}`); params.push(expiresAt); }
    if (typeof reason !== 'undefined') { sets.push(`reason = $${i++}`); params.push(reason); }
    sets.push(`updated_by = $${i++}`);
    params.push(updatedBy);
    sets.push('updated_at = now()');

    const { rows } = await pg.query(
        `UPDATE ai_manual_overrides SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        [...params, id],
    );
    return getOverrideById(rows[0]?.id);
}

async function listOverrides({
    includeDisabled = false,
    scope = null,
    activeOnly = false,
    limit = 100,
    offset = 0,
} = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (!includeDisabled) {
        where.push(`o.is_enabled = true`);
    }
    if (scope) {
        where.push(`o.scope = $${i++}`);
        params.push(scope);
    }
    if (activeOnly) {
        where.push('(o.expires_at IS NULL OR o.expires_at > now())');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pg.query(
        `
        SELECT o.*, m.api_model_id
        FROM ai_manual_overrides o
        LEFT JOIN ai_models m ON m.id = o.model_id
        ${whereSql}
        ORDER BY o.priority DESC, o.id DESC
        LIMIT $${i++} OFFSET $${i}
        `,
        [...params, Math.max(1, Number(limit || 100)), Math.max(0, Number(offset || 0))],
    );
    return rows;
}

module.exports = {
    createOverride,
    getOverrideById,
    updateOverride,
    listOverrides,
};
