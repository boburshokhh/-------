const pg = require('../pgPool');

async function listStages({ activeOnly = true } = {}) {
    const where = activeOnly ? 'WHERE is_active = true' : '';
    const { rows } = await pg.query(`
        SELECT * FROM ai_stage_catalog ${where} ORDER BY ui_order ASC, stage_key ASC
    `);
    return rows;
}

async function getStageByKey(stageKey) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_stage_catalog WHERE stage_key = $1 LIMIT 1`,
        [stageKey],
    );
    return rows[0] || null;
}

async function upsertStage({
    stageKey, uiLabel, uiOrder = 0, requiresLlm = true,
    taskType = 'standard_generation', defaultCostTier = 'standard',
    premiumEligible = false, capabilities = [], isActive = true,
}) {
    const { rows } = await pg.query(`
        INSERT INTO ai_stage_catalog (
            stage_key, ui_label, ui_order, requires_llm,
            task_type, default_cost_tier, premium_eligible, capabilities, is_active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (stage_key) DO UPDATE SET
            ui_label = EXCLUDED.ui_label,
            ui_order = EXCLUDED.ui_order,
            requires_llm = EXCLUDED.requires_llm,
            task_type = EXCLUDED.task_type,
            default_cost_tier = EXCLUDED.default_cost_tier,
            premium_eligible = EXCLUDED.premium_eligible,
            capabilities = EXCLUDED.capabilities,
            is_active = EXCLUDED.is_active,
            updated_at = now()
        RETURNING *
    `, [
        stageKey, uiLabel, uiOrder, requiresLlm,
        taskType, defaultCostTier, premiumEligible,
        JSON.stringify(capabilities), isActive,
    ]);
    return rows[0];
}

module.exports = { listStages, getStageByKey, upsertStage };
