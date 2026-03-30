const pg = require('../pgPool');

async function getPolicies() {
    const { rows } = await pg.query(`SELECT * FROM ai_global_policies WHERE id = 1 LIMIT 1`);
    return rows[0] || null;
}

async function updatePolicies(patch, { updatedBy = null } = {}) {
    const allowed = [
        'routing_mode', 'stable_only', 'premium_guard_enabled',
        'premium_soft_limit_percent', 'max_premium_percent_per_day',
        'max_pro_calls_per_run', 'preview_canary_percent',
        'emergency_downgrade', 'metadata',
    ];

    const sets = [];
    const vals = [];
    let n = 1;

    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
            if (key === 'metadata') {
                sets.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${n}::jsonb`);
                vals.push(JSON.stringify(patch[key]));
            } else {
                sets.push(`${key} = $${n}`);
                vals.push(patch[key]);
            }
            n++;
        }
    }

    if (updatedBy != null) {
        sets.push(`updated_by = $${n}`);
        vals.push(updatedBy);
        n++;
    }

    if (sets.length === 0) return getPolicies();

    sets.push('updated_at = now()');
    vals.push(1);

    const { rows } = await pg.query(
        `UPDATE ai_global_policies SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
        vals,
    );
    return rows[0] || null;
}

module.exports = { getPolicies, updatePolicies };
