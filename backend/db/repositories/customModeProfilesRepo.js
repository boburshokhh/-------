const pg = require('../pgPool');

function mapProfile(row) {
    if (!row) return null;
    return {
        ...row,
        allow_premium: !!row.allow_premium,
        allow_preview: !!row.allow_preview,
        stable_only: !!row.stable_only,
        emergency_fallback: !!row.emergency_fallback,
        is_system: !!row.is_system,
        is_active: !!row.is_active,
        is_archived: !!row.is_archived,
        is_disabled: !!row.is_disabled,
    };
}

async function listProfiles({
    status = null,
    includeArchived = false,
    includeDisabled = true,
    search = null,
    limit = 100,
    offset = 0,
} = {}) {
    const where = [];
    const params = [];
    let i = 1;

    if (status) {
        where.push(`status = $${i++}`);
        params.push(status);
    }
    if (!includeArchived) {
        where.push(`is_archived = false`);
    }
    if (!includeDisabled) {
        where.push(`is_disabled = false`);
    }
    if (search) {
        where.push(`(code ILIKE $${i} OR name ILIKE $${i} OR COALESCE(description, '') ILIKE $${i})`);
        params.push(`%${search}%`);
        i++;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const listParams = [...params, Math.max(1, Number(limit) || 100), Math.max(0, Number(offset) || 0)];
    const listLimitRef = i++;
    const listOffsetRef = i;

    const listSql = `
        SELECT *
        FROM custom_mode_profiles
        ${whereSql}
        ORDER BY is_system DESC, updated_at DESC, id DESC
        LIMIT $${listLimitRef} OFFSET $${listOffsetRef}
    `;
    const countSql = `SELECT COUNT(*)::int AS total FROM custom_mode_profiles ${whereSql}`;

    const [listRes, countRes] = await Promise.all([
        pg.query(listSql, listParams),
        pg.query(countSql, params),
    ]);

    return {
        items: listRes.rows.map(mapProfile),
        total: countRes.rows[0]?.total || 0,
    };
}

async function getProfileById(id) {
    const { rows } = await pg.query(
        `SELECT * FROM custom_mode_profiles WHERE id = $1 LIMIT 1`,
        [id],
    );
    return mapProfile(rows[0] || null);
}

async function getProfileByCode(code) {
    const { rows } = await pg.query(
        `SELECT * FROM custom_mode_profiles WHERE code = $1 LIMIT 1`,
        [code],
    );
    return mapProfile(rows[0] || null);
}

async function listAssignments(modeProfileId) {
    const { rows } = await pg.query(
        `
        SELECT
            a.*,
            pm.api_model_id AS primary_api_model_id,
            fm.models AS fallback_models
        FROM custom_mode_stage_assignments a
        LEFT JOIN ai_models pm ON pm.id = a.primary_model_id
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object('id', m.id, 'api_model_id', m.api_model_id, 'ui_name', m.ui_name)
                ORDER BY array_position(a.fallback_model_ids, m.id)
            ) AS models
            FROM ai_models m
            WHERE m.id = ANY(a.fallback_model_ids)
        ) fm ON TRUE
        WHERE a.mode_profile_id = $1
        ORDER BY a.stage_key ASC, a.agent_role ASC
        `,
        [modeProfileId],
    );
    return rows;
}

async function getProfileWithAssignmentsById(id) {
    const profile = await getProfileById(id);
    if (!profile) return null;
    const assignments = await listAssignments(id);
    return { ...profile, assignments };
}

async function createProfile(profileData, assignments = []) {
    const createdId = await pg.transaction(async (client) => {
        const { rows } = await client.query(
            `
            INSERT INTO custom_mode_profiles (
                code, name, description, parent_mode, is_system,
                is_active, is_archived, is_disabled, status,
                default_routing_behavior, allow_premium, allow_preview, stable_only, emergency_fallback,
                max_premium_budget_for_run, max_premium_share_per_day,
                created_by, updated_by
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
            )
            RETURNING *
            `,
            [
                profileData.code,
                profileData.name,
                profileData.description || null,
                profileData.parent_mode || 'quality',
                !!profileData.is_system,
                !!profileData.is_active,
                !!profileData.is_archived,
                !!profileData.is_disabled,
                profileData.status || 'draft',
                profileData.default_routing_behavior || 'stage_based',
                !!profileData.allow_premium,
                !!profileData.allow_preview,
                profileData.stable_only !== false,
                profileData.emergency_fallback !== false,
                profileData.max_premium_budget_for_run ?? null,
                profileData.max_premium_share_per_day ?? null,
                profileData.created_by ?? null,
                profileData.updated_by ?? null,
            ],
        );
        const profile = mapProfile(rows[0]);
        if (assignments.length) {
            await replaceAssignmentsTx(client, profile.id, assignments);
        }
        return profile.id;
    });
    return getProfileWithAssignmentsById(createdId);
}

async function replaceAssignmentsTx(client, modeProfileId, assignments) {
    await client.query(`DELETE FROM custom_mode_stage_assignments WHERE mode_profile_id = $1`, [modeProfileId]);
    for (const item of assignments) {
        await client.query(
            `
            INSERT INTO custom_mode_stage_assignments (
                mode_profile_id, mission_key, stage_key, agent_role,
                primary_model_id, fallback_model_ids, allow_premium, allow_preview, stable_only,
                preferred_cost_tier, preferred_provider, override_strength, enabled, notes
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
            )
            `,
            [
                modeProfileId,
                item.mission_key,
                item.stage_key,
                item.agent_role,
                item.primary_model_id ?? null,
                Array.isArray(item.fallback_model_ids) ? item.fallback_model_ids : [],
                item.allow_premium ?? null,
                item.allow_preview ?? null,
                item.stable_only ?? null,
                item.preferred_cost_tier ?? null,
                item.preferred_provider ?? null,
                item.override_strength || 'soft',
                item.enabled !== false,
                item.notes || null,
            ],
        );
    }
}

async function updateProfile(id, patch, assignments = null) {
    const updatedId = await pg.transaction(async (client) => {
        const current = await client.query(
            `SELECT * FROM custom_mode_profiles WHERE id = $1 LIMIT 1 FOR UPDATE`,
            [id],
        );
        if (!current.rows[0]) return null;
        const row = current.rows[0];

        const next = {
            code: patch.code ?? row.code,
            name: patch.name ?? row.name,
            description: patch.description ?? row.description,
            parent_mode: patch.parent_mode ?? row.parent_mode,
            is_system: patch.is_system ?? row.is_system,
            is_active: patch.is_active ?? row.is_active,
            is_archived: patch.is_archived ?? row.is_archived,
            is_disabled: patch.is_disabled ?? row.is_disabled,
            status: patch.status ?? row.status,
            default_routing_behavior: patch.default_routing_behavior ?? row.default_routing_behavior,
            allow_premium: patch.allow_premium ?? row.allow_premium,
            allow_preview: patch.allow_preview ?? row.allow_preview,
            stable_only: patch.stable_only ?? row.stable_only,
            emergency_fallback: patch.emergency_fallback ?? row.emergency_fallback,
            max_premium_budget_for_run: patch.max_premium_budget_for_run ?? row.max_premium_budget_for_run,
            max_premium_share_per_day: patch.max_premium_share_per_day ?? row.max_premium_share_per_day,
            updated_by: patch.updated_by ?? row.updated_by,
            config_version: Number(row.config_version || 1) + 1,
        };

        await client.query(
            `
            UPDATE custom_mode_profiles
            SET
                code = $2,
                name = $3,
                description = $4,
                parent_mode = $5,
                is_system = $6,
                is_active = $7,
                is_archived = $8,
                is_disabled = $9,
                status = $10,
                default_routing_behavior = $11,
                allow_premium = $12,
                allow_preview = $13,
                stable_only = $14,
                emergency_fallback = $15,
                max_premium_budget_for_run = $16,
                max_premium_share_per_day = $17,
                updated_by = $18,
                updated_at = now(),
                config_version = $19
            WHERE id = $1
            `,
            [
                id,
                next.code,
                next.name,
                next.description,
                next.parent_mode,
                !!next.is_system,
                !!next.is_active,
                !!next.is_archived,
                !!next.is_disabled,
                next.status,
                next.default_routing_behavior,
                !!next.allow_premium,
                !!next.allow_preview,
                !!next.stable_only,
                !!next.emergency_fallback,
                next.max_premium_budget_for_run,
                next.max_premium_share_per_day,
                next.updated_by,
                next.config_version,
            ],
        );

        if (Array.isArray(assignments)) {
            await replaceAssignmentsTx(client, id, assignments);
        }

        return id;
    });
    if (!updatedId) return null;
    return getProfileWithAssignmentsById(updatedId);
}

async function snapshotProfile(modeProfileId, version, snapshot, createdBy) {
    await pg.query(
        `
        INSERT INTO custom_mode_profile_versions (mode_profile_id, version, snapshot, created_by)
        VALUES ($1, $2, $3::jsonb, $4)
        ON CONFLICT (mode_profile_id, version) DO NOTHING
        `,
        [modeProfileId, version, JSON.stringify(snapshot), createdBy ?? null],
    );
}

async function archiveProfile(id, archived, updatedBy) {
    const status = archived ? 'archived' : 'draft';
    const { rows } = await pg.query(
        `
        UPDATE custom_mode_profiles
        SET is_archived = $2, status = $3, updated_by = $4, updated_at = now(), config_version = config_version + 1
        WHERE id = $1
        RETURNING *
        `,
        [id, !!archived, status, updatedBy ?? null],
    );
    return mapProfile(rows[0] || null);
}

async function setDisabled(id, disabled, updatedBy) {
    const status = disabled ? 'disabled' : 'draft';
    const { rows } = await pg.query(
        `
        UPDATE custom_mode_profiles
        SET is_disabled = $2, status = $3, updated_by = $4, updated_at = now(), config_version = config_version + 1
        WHERE id = $1
        RETURNING *
        `,
        [id, !!disabled, status, updatedBy ?? null],
    );
    return mapProfile(rows[0] || null);
}

async function listRunsForMode(modeProfileId, { status = null, limit = 50, offset = 0 } = {}) {
    const where = ['mode_profile_id = $1'];
    const params = [modeProfileId];
    let i = 2;
    if (status) {
        where.push(`status = $${i++}`);
        params.push(status);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rowsRes = await pg.query(
        `
        SELECT id, document_id, status, target_count, language, started_at, finished_at, duration_ms,
               mode_profile_id, mode_profile_version, requested_mode_code, fallback_decisions, error_message
        FROM generation_runs
        ${whereSql}
        ORDER BY started_at DESC, id DESC
        LIMIT $${i++} OFFSET $${i}
        `,
        [...params, Math.max(1, Number(limit) || 50), Math.max(0, Number(offset) || 0)],
    );
    const countRes = await pg.query(
        `SELECT COUNT(*)::int AS total FROM generation_runs ${whereSql}`,
        params,
    );
    return { rows: rowsRes.rows, total: countRes.rows[0]?.total || 0 };
}

module.exports = {
    listProfiles,
    getProfileById,
    getProfileByCode,
    listAssignments,
    getProfileWithAssignmentsById,
    createProfile,
    updateProfile,
    archiveProfile,
    setDisabled,
    snapshotProfile,
    listRunsForMode,
};
