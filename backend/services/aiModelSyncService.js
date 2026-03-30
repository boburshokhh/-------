const config = require('../config');
const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const {
    upsertModelWithLimits,
    invalidateRegistryCache,
} = require('./aiModelRegistryService');
const {
    listNormalizedModels,
    loadUiNameMapping,
    resolveUiNameAndCategory,
} = require('./providers/geminiModelsProvider');

function metaSnapshot(row) {
    if (!row || !row.metadata) return {};
    return typeof row.metadata === 'object' ? row.metadata : {};
}

function capsEqual(a, b) {
    const sa = JSON.stringify([...(a || [])].map(String).sort());
    const sb = JSON.stringify([...(b || [])].map(String).sort());
    return sa === sb;
}

function logSyncSummary(summary) {
    const { added, updated, disabled, unchanged } = summary;
    console.error(
        '[AI_MODEL_SYNC]',
        JSON.stringify({
            added: added.length,
            updated: updated.length,
            disabled: disabled.length,
            unchanged,
        }),
    );
    if (added.length) {
        console.error('[AI_MODEL_SYNC] added:', added.map((x) => `${x.id}:${x.api_model_id}`).join(', '));
    }
    if (updated.length) {
        console.error('[AI_MODEL_SYNC] updated:', updated.map((x) => `${x.id}:${x.api_model_id}`).join(', '));
    }
    if (disabled.length) {
        console.error('[AI_MODEL_SYNC] disabled:', disabled.map((x) => `${x.id}:${x.api_model_id}`).join(', '));
    }
}

/**
 * @param {object} options
 * @param {boolean} [options.disableMissingFromApi]
 * @param {string} [options.provider]
 */
async function syncFromGemini({
    disableMissingFromApi = false,
    provider = 'google',
} = {}) {
    const mapping = loadUiNameMapping();
    const normalizedList = await listNormalizedModels();
    const apiIdsFromApi = new Set(normalizedList.map((n) => n.api_model_id));

    const added = [];
    const updated = [];
    const disabled = [];
    let unchanged = 0;

    const tier = config.GEMINI_QUOTA_TIER || 'free';

    for (const norm of normalizedList) {
        const { ui_name: uiName, category } = resolveUiNameAndCategory(norm, mapping);
        const existing = await aiModelsRepo.getModelByApiModelId(norm.api_model_id);

        const baseMeta = {
            source: 'gemini_sync',
            sync_managed: true,
            capabilities: norm.capabilities,
            raw_name: norm.raw_name,
            synced_at: new Date().toISOString(),
        };

        if (!existing) {
            const aiModelId = await upsertModelWithLimits({
                uiName,
                category,
                provider,
                apiModelId: norm.api_model_id,
                tier,
                rpm: null,
                tpm: null,
                rpd: null,
                isEnabled: true,
                metadata: baseMeta,
                isPreview: norm.is_preview,
                modelRole: norm.model_role,
                baseModelId: null,
            });
            if (aiModelId) {
                added.push({
                    id: String(aiModelId),
                    api_model_id: norm.api_model_id,
                    ui_name: uiName,
                });
            }
            continue;
        }

        const prevMeta = metaSnapshot(existing);
        const mergedMeta = {
            ...prevMeta,
            ...baseMeta,
        };

        const same =
            existing.ui_name === uiName &&
            existing.category === category &&
            existing.model_role === norm.model_role &&
            !!existing.is_preview === !!norm.is_preview &&
            capsEqual(prevMeta.capabilities, norm.capabilities);

        if (same) {
            unchanged += 1;
            continue;
        }

        await aiModelsRepo.updateModelById(
            existing.id,
            {
                ui_name: uiName,
                category,
                model_role: norm.model_role,
                is_preview: norm.is_preview,
                api_model_id: norm.api_model_id,
                metadata: mergedMeta,
            },
            { mergeMetadata: false },
        );

        updated.push({
            id: String(existing.id),
            api_model_id: norm.api_model_id,
            ui_name: uiName,
        });
    }

    if (disableMissingFromApi) {
        const managed = await aiModelsRepo.listSyncManagedModels({ provider });
        for (const row of managed) {
            const aid = row.api_model_id;
            if (!aid || apiIdsFromApi.has(aid)) continue;
            if (!row.is_enabled) continue;
            await aiModelsRepo.setModelEnabled(row.id, false);
            disabled.push({
                id: String(row.id),
                api_model_id: aid,
                ui_name: row.ui_name,
            });
        }
    }

    invalidateRegistryCache();

    const summary = { added, updated, disabled, unchanged };
    logSyncSummary(summary);

    return {
        ok: true,
        summary: {
            added,
            updated,
            disabled,
            unchanged,
            counts: {
                added: added.length,
                updated: updated.length,
                disabled: disabled.length,
                unchanged,
                totalFromApi: normalizedList.length,
            },
        },
    };
}

module.exports = {
    syncFromGemini,
};
