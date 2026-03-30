const pg = require('../pgPool');

async function upsertLimit({
    aiModelId,
    tier = 'free',
    rpm = null,
    tpm = null,
    rpd = null,
    isActive = true,
    effectiveFrom = null,
    effectiveTo = null,
}) {
    if (!aiModelId) throw new Error('upsertLimit: aiModelId is required');

    const { rows } = await pg.query(
        `
        INSERT INTO ai_model_limits (
            ai_model_id, tier, rpm, tpm, rpd, is_active, effective_from, effective_to
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (ai_model_id, tier) DO UPDATE
        SET
            rpm = EXCLUDED.rpm,
            tpm = EXCLUDED.tpm,
            rpd = EXCLUDED.rpd,
            is_active = EXCLUDED.is_active,
            effective_from = EXCLUDED.effective_from,
            effective_to = EXCLUDED.effective_to,
            updated_at = now()
        RETURNING id
        `,
        [aiModelId, tier, rpm, tpm, rpd, !!isActive, effectiveFrom, effectiveTo],
    );

    return rows[0].id;
}

async function setActive(aiModelId, tier, isActive) {
    await pg.query(
        `UPDATE ai_model_limits SET is_active = $1, updated_at = now() WHERE ai_model_id = $2 AND tier = $3`,
        [!!isActive, aiModelId, tier],
    );
}

async function getActiveLimit(aiModelId, tier = 'free') {
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_model_limits
        WHERE ai_model_id = $1 AND tier = $2 AND is_active = true
        ORDER BY effective_from DESC NULLS LAST
        LIMIT 1
        `,
        [aiModelId, tier],
    );
    return rows[0] || null;
}

async function getLimitsByModel(aiModelId) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_model_limits WHERE ai_model_id = $1 ORDER BY tier`,
        [aiModelId],
    );
    return rows;
}

module.exports = {
    upsertLimit,
    setActive,
    getActiveLimit,
    getLimitsByModel,
};

