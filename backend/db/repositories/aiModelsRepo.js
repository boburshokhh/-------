const pg = require('../pgPool');

/**
 * Repository for ai_models catalog.
 * Provides CRUD by stable business key: (provider, category, ui_name, is_preview).
 */

async function upsertModel({
    uiName,
    category,
    provider = 'google',
    modelRole = 'llm',
    apiModelId = null,
    isPreview = false,
    baseModelId = null,
    isEnabled = true,
    metadata = {},
}) {
    const { rows } = await pg.query(
        `
        INSERT INTO ai_models (
            ui_name, category, provider, model_role, api_model_id, is_preview, base_model_id,
            is_enabled, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (provider, category, ui_name, is_preview) DO UPDATE
        SET
            model_role     = EXCLUDED.model_role,
            api_model_id   = EXCLUDED.api_model_id,
            base_model_id  = EXCLUDED.base_model_id,
            is_enabled     = EXCLUDED.is_enabled,
            metadata       = EXCLUDED.metadata,
            updated_at     = now()
        RETURNING id
        `,
        [
            uiName,
            category,
            provider,
            modelRole,
            apiModelId,
            isPreview,
            baseModelId,
            isEnabled,
            JSON.stringify(metadata || {}),
        ],
    );

    return rows[0].id;
}

async function setModelEnabled(modelId, isEnabled) {
    await pg.query(
        `UPDATE ai_models SET is_enabled = $1, updated_at = now() WHERE id = $2`,
        [!!isEnabled, modelId],
    );
}

async function getModelById(modelId) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_models WHERE id = $1 LIMIT 1`,
        [modelId],
    );
    return rows[0] || null;
}

async function getModelByApiModelId(apiModelId) {
    const { rows } = await pg.query(
        `SELECT * FROM ai_models WHERE api_model_id = $1 ORDER BY is_preview DESC LIMIT 1`,
        [apiModelId],
    );
    return rows[0] || null;
}

async function findModelIdByApiModelId(apiModelId) {
    const model = await getModelByApiModelId(apiModelId);
    return model ? model.id : null;
}

// The previous function had a placeholder helper; implement clean version below.
async function listModelsWithLimitsClean({
    provider = 'google',
    tier = 'free',
    includeDisabled = false,
    includePreviews = true,
    category = null,
} = {}) {
    const where = ['m.provider = $1'];
    const params = [provider];
    let i = 2;
    if (!includeDisabled) {
        where.push('m.is_enabled = true');
    }
    if (!includePreviews) {
        where.push('m.is_preview = false');
    }
    if (category) {
        where.push(`m.category = $${i}`);
        params.push(category);
        i++;
    }

    const { rows } = await pg.query(
        `
        SELECT
            m.*,
            l.rpm, l.tpm, l.rpd, l.is_active as limits_active
        FROM ai_models m
        LEFT JOIN ai_model_limits l
            ON l.ai_model_id = m.id AND l.tier = $2 AND l.is_active = true
        WHERE ${where.join(' AND ')}
        ORDER BY m.is_preview ASC, m.ui_name ASC
        `,
        [provider, tier, ...params.slice(1)],
    );

    return rows;
}

/**
 * Partial update by primary key (for admin PATCH and sync-by-id).
 * metadata: merged with existing row via JSONB || when mergeMetadata is true (default).
 */
async function updateModelById(modelId, patch, { mergeMetadata = true } = {}) {
    const row = await getModelById(modelId);
    if (!row) return null;

    const fields = {
        ui_name: 'ui_name',
        category: 'category',
        model_role: 'model_role',
        api_model_id: 'api_model_id',
        is_preview: 'is_preview',
        is_enabled: 'is_enabled',
        base_model_id: 'base_model_id',
    };

    const sets = [];
    const vals = [];
    let n = 1;

    for (const [key, col] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
            sets.push(`${col} = $${n}`);
            vals.push(patch[key]);
            n += 1;
        }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'metadata') && patch.metadata !== undefined) {
        if (mergeMetadata) {
            sets.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${n}::jsonb`);
        } else {
            sets.push(`metadata = $${n}::jsonb`);
        }
        vals.push(JSON.stringify(patch.metadata));
        n += 1;
    }

    if (!sets.length) {
        return row;
    }

    sets.push('updated_at = now()');
    vals.push(modelId);
    const idPlaceholder = vals.length;

    const sql = `
        UPDATE ai_models
        SET ${sets.join(', ')}
        WHERE id = $${idPlaceholder}
        RETURNING *
    `;

    try {
        const { rows } = await pg.query(sql, vals);
        return rows[0] || null;
    } catch (e) {
        if (e.code === '23505') {
            const err = new Error('Конфликт уникального ключа (provider, category, ui_name, is_preview)');
            err.status = 409;
            throw err;
        }
        throw e;
    }
}

/**
 * Rows previously synced from Gemini (for optional disable-if-missing).
 */
async function listSyncManagedModels({
    provider = 'google',
} = {}) {
    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_models
        WHERE provider = $1
          AND api_model_id IS NOT NULL
          AND (
              metadata->>'source' = 'gemini_sync'
              OR (metadata->>'sync_managed') = 'true'
          )
        `,
        [provider],
    );
    return rows;
}

async function listModels({
    provider = 'google',
    includeDisabled = false,
    includePreviews = true,
    category = null,
} = {}) {
    const where = ['provider = $1'];
    const params = [provider];
    let idx = 2;
    if (!includeDisabled) {
        where.push('is_enabled = true');
    }
    if (!includePreviews) {
        where.push('is_preview = false');
    }
    if (category) {
        where.push(`category = $${idx}`);
        params.push(category);
        idx++;
    }

    const { rows } = await pg.query(
        `
        SELECT *
        FROM ai_models
        WHERE ${where.join(' AND ')}
        ORDER BY is_preview ASC, ui_name ASC
        `,
        params,
    );

    return rows;
}

module.exports = {
    upsertModel,
    setModelEnabled,
    getModelById,
    getModelByApiModelId,
    findModelIdByApiModelId,
    listModels,
    listModelsWithLimits: listModelsWithLimitsClean,
    updateModelById,
    listSyncManagedModels,
};

