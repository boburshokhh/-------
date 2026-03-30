const pg = require('../pgPool');

async function appendAuditEvent({
    actorUserId = null,
    action,
    entityType,
    entityId = null,
    beforeState = null,
    afterState = null,
    requestMeta = {},
}) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_admin_audit_log (
            actor_user_id, action, entity_type, entity_id, before_state, after_state, request_meta
        )
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
        RETURNING *
        `,
        [
            actorUserId,
            action,
            entityType,
            entityId == null ? null : String(entityId),
            beforeState == null ? null : JSON.stringify(beforeState),
            afterState == null ? null : JSON.stringify(afterState),
            JSON.stringify(requestMeta || {}),
        ],
    );
    return rows[0] || null;
}

async function listAudit({
    entityType = null,
    actorUserId = null,
    limit = 100,
    offset = 0,
} = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (entityType) {
        where.push(`entity_type = $${i++}`);
        params.push(entityType);
    }
    if (actorUserId) {
        where.push(`actor_user_id = $${i++}`);
        params.push(actorUserId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_admin_audit_log
        ${whereSql}
        ORDER BY id DESC
        LIMIT $${i++} OFFSET $${i}
        `,
        [...params, Math.max(1, Number(limit || 100)), Math.max(0, Number(offset || 0))],
    );
    return rows;
}

module.exports = {
    appendAuditEvent,
    listAudit,
};
