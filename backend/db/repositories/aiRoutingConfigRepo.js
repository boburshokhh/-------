const pg = require('../pgPool');

async function getRoutingConfig() {
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_routing_config
        WHERE id = 1
        LIMIT 1
        `,
    );
    return rows[0] || null;
}

async function setRoutingMode({ routingMode, updatedBy = null, metadata = {} }) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_routing_config (id, routing_mode, updated_by, metadata, updated_at)
        VALUES (1, $1, $2, $3::jsonb, now())
        ON CONFLICT (id) DO UPDATE
        SET routing_mode = EXCLUDED.routing_mode,
            updated_by = EXCLUDED.updated_by,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        RETURNING *
        `,
        [routingMode, updatedBy, JSON.stringify(metadata || {})],
    );
    return rows[0] || null;
}

module.exports = {
    getRoutingConfig,
    setRoutingMode,
};
