const pg = require('../pgPool');

/**
 * Получить все профили
 */
async function getAllProfiles() {
    const { rows } = await pg.query(`
        SELECT * FROM ai_routing_profiles ORDER BY code ASC
    `);
    return rows;
}

/**
 * Получить полный профиль со всеми правилами стадий
 */
async function getProfileWithRules(code) {
    const { rows: profileRows } = await pg.query(
        `SELECT * FROM ai_routing_profiles WHERE code = $1 LIMIT 1`,
        [code]
    );
    
    if (profileRows.length === 0) return null;
    const profile = profileRows[0];

    const { rows: ruleRows } = await pg.query(
        `SELECT * FROM ai_routing_stage_rules WHERE profile_code = $1`,
        [code]
    );
    
    profile.rules = ruleRows;
    return profile;
}

/**
 * Получить конкретное правило для профиля и стадии
 */
async function getStageRule(profileCode, stageName) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_routing_stage_rules 
         WHERE profile_code = $1 AND stage_name = $2 
         LIMIT 1`,
        [profileCode, stageName]
    );
    return rows[0] || null;
}

/**
 * Обновить правило для стадии в профиле
 */
async function updateStageRule(profileCode, stageName, updateData) {
    const allowed = [
        'primary_model_id', 'fallback_model_id', 'allow_premium', 
        'allow_preview', 'on_quota_limit', 'on_guard_blocked'
    ];

    const sets = [];
    const vals = [];
    let n = 1;

    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(updateData, key) && updateData[key] !== undefined) {
            sets.push(`${key} = $${n}`);
            vals.push(updateData[key]);
            n++;
        }
    }

    if (sets.length === 0) return getStageRule(profileCode, stageName);

    // Upsert behavior is not strictly needed if we assume it exists (DB is seeded). 
    // But let's build an exact UPDATE.
    vals.push(profileCode, stageName);

    const { rows } = await pg.query(
        `UPDATE ai_routing_stage_rules 
         SET ${sets.join(', ')} 
         WHERE profile_code = $${n} AND stage_name = $${n + 1}
         RETURNING *`,
        vals
    );
    return rows[0] || null;
}

module.exports = {
    getAllProfiles,
    getProfileWithRules,
    getStageRule,
    updateStageRule
};
