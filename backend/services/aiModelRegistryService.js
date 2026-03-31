const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiModelLimitsRepo = require('../db/repositories/aiModelLimitsRepo');
const aiRoutingRulesRepo = require('../db/repositories/aiRoutingRulesRepo');
const aiModelUsageRepo = require('../db/repositories/aiModelUsageRepo');
const aiRoutingConfigRepo = require('../db/repositories/aiRoutingConfigRepo');
const aiManualOverridesRepo = require('../db/repositories/aiManualOverridesRepo');
const aiAdminAuditRepo = require('../db/repositories/aiAdminAuditRepo');

const CACHE_TTL_MS = 30_000;

let cacheKey = '';
let cacheTs = 0;
let cacheValue = null;

function nowIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

function inferIsPreview({ uiName, apiModelId }) {
    const s = `${uiName || ''} ${apiModelId || ''}`.toLowerCase();
    return s.includes('preview');
}

function inferModelRole({ category, uiName, apiModelId }) {
    const s = `${uiName || ''} ${apiModelId || ''}`.toLowerCase();

    if (s.includes('embedding')) return 'embedding';
    if (category === 'text_out') return 'llm';
    if (category === 'tts') return 'tts';
    if (category === 'image') return 'image';
    if (category === 'video') return 'video';

    // Default for unknown: keep llm to match generator expectations.
    return 'llm';
}

/**
 * Read-only snapshot for UI/admin.
 */
async function getRegistrySnapshot({
    provider = 'google',
    tier = 'free',
    includeDisabled = false,
    includePreviews = true,
    category = null,
} = {}) {
    const key = JSON.stringify({ provider, tier, includeDisabled, includePreviews, category });
    if (cacheValue && cacheKey === key && Date.now() - cacheTs < CACHE_TTL_MS) return cacheValue;

    const models = await aiModelsRepo.listModelsWithLimits({
        provider,
        tier,
        includeDisabled,
        includePreviews,
        category,
    });

    cacheKey = key;
    cacheTs = Date.now();
    cacheValue = {
        provider,
        tier,
        models,
    };

    return cacheValue;
}

async function listRoutingRules(phase, { enabledOnly = true } = {}) {
    if (phase) return aiRoutingRulesRepo.listRulesByPhase(phase, { enabledOnly });
    return aiRoutingRulesRepo.listRules({ enabledOnly });
}

function bumpModelRouterRulesCache() {
    try {
        require('./modelRouter').invalidateRoutingRulesCache();
    } catch (_) { /* optional dep at cold start */ }
}

async function createRoutingRule({
    name,
    phase,
    priority = 0,
    isEnabled = true,
    conditions = {},
    actions = {},
    stageKey = null,
    allowPremium = false,
    allowPreview = false,
    stableOnly = true,
    maxEscalationDepth = 1,
}) {
    const id = await aiRoutingRulesRepo.createRule({
        name,
        phase,
        priority,
        isEnabled,
        conditions,
        actions,
        stageKey,
        allowPremium,
        allowPreview,
        stableOnly,
        maxEscalationDepth,
    });
    bumpModelRouterRulesCache();
    return id;
}

async function updateRoutingRule(ruleId, {
    name,
    phase,
    priority,
    isEnabled,
    conditions,
    actions,
    stageKey,
    allowPremium,
    allowPreview,
    stableOnly,
    maxEscalationDepth,
} = {}) {
    await aiRoutingRulesRepo.updateRule(ruleId, {
        name,
        phase,
        priority,
        isEnabled,
        conditions,
        actions,
        stageKey,
        allowPremium,
        allowPreview,
        stableOnly,
        maxEscalationDepth,
    });
    bumpModelRouterRulesCache();
}

async function enableRoutingRule(ruleId, isEnabled) {
    await aiRoutingRulesRepo.enableRule(ruleId, isEnabled);
    bumpModelRouterRulesCache();
}

async function setModelEnabled(modelId, isEnabled) {
    cacheValue = null;
    cacheKey = '';
    return aiModelsRepo.setModelEnabled(modelId, isEnabled);
}

async function upsertModelWithLimits({
    uiName,
    category,
    provider = 'google',
    apiModelId = null,
    tier = 'free',
    rpm = null,
    tpm = null,
    rpd = null,
    isEnabled = true,
    metadata = {},
    isPreview = null,
    modelRole = null,
    baseModelId = null,
}) {
    const preview = isPreview == null ? inferIsPreview({ uiName, apiModelId }) : !!isPreview;
    const role = modelRole || inferModelRole({ category, uiName, apiModelId });

    const aiModelId = await aiModelsRepo.upsertModel({
        uiName,
        category,
        provider,
        modelRole: role,
        apiModelId,
        isPreview: preview,
        baseModelId,
        isEnabled,
        metadata,
    });

    await aiModelLimitsRepo.upsertLimit({
        aiModelId,
        tier,
        rpm: rpm == null ? null : Number(rpm),
        tpm: tpm == null ? null : Number(tpm),
        rpd: rpd == null ? null : Number(rpd),
        isActive: true,
    });

    cacheValue = null;
    cacheKey = '';
    return aiModelId;
}

/**
 * Import from models.json (subset: models[])
 * - "used" fields are ignored (usage tracked by ai_model_usage table)
 * - tool entries can be optionally imported with includeTools=true
 */
async function importFromModelsJson(modelsJson, {
    provider = 'google',
    tier = 'free',
    includeTools = false,
} = {}) {
    if (!modelsJson || typeof modelsJson !== 'object') {
        throw new Error('importFromModelsJson: invalid modelsJson payload');
    }
    const list = Array.isArray(modelsJson.models) ? modelsJson.models : [];

    let createdOrUpdated = 0;
    for (const entry of list) {
        const uiName = entry.ui_name || '';
        if (!uiName) continue;

        const apiModelId = entry.api_model_id || null;
        const category = entry.category || 'other';

        const rpmLimit = entry?.rpm?.limit ?? null;
        const tpmLimit = entry?.tpm?.limit ?? null;
        const rpdLimit = entry?.rpd?.limit ?? null;

        await upsertModelWithLimits({
            uiName,
            category,
            provider,
            apiModelId,
            tier,
            rpm: rpmLimit,
            tpm: tpmLimit,
            rpd: rpdLimit,
            isEnabled: true,
            metadata: { source: modelsJson.source || 'models.json', raw: entry },
            // infer preview/role automatically
        });

        createdOrUpdated++;
    }

    if (includeTools && Array.isArray(modelsJson.tools)) {
        for (const tool of modelsJson.tools) {
            if (!tool || !tool.ui_name || !tool.tool_type) continue;
            await upsertModelWithLimits({
                uiName: tool.ui_name,
                category: 'tool',
                provider,
                apiModelId: null,
                tier,
                rpm: null,
                tpm: null,
                rpd: tool?.rpd?.limit ?? null,
                isEnabled: true,
                metadata: { source: modelsJson.source || 'models.json', raw: tool },
                // tool_type stored in metadata + role fallback
                modelRole: String(tool.tool_type || 'tool').toLowerCase(),
                isPreview: false,
            });
            createdOrUpdated++;
        }
    }

    return { createdOrUpdated };
}

async function recordUsageByApiModelId({
    keyFingerprint,
    apiModelId,
    usageDate = null,
    phase = 'default',
    requestsDelta = 1,
    rpmHitsDelta = 0,
    tpmEstimatedDelta = null,
    failOnMissingModel = false,
}) {
    if (!apiModelId) throw new Error('recordUsageByApiModelId: apiModelId is required');
    const aiModelId = await aiModelsRepo.findModelIdByApiModelId(apiModelId);
    if (!aiModelId) {
        if (failOnMissingModel) throw new Error(`recordUsageByApiModelId: ai_model not found for api_model_id=${apiModelId}`);
        return null;
    }

    return aiModelUsageRepo.recordUsage({
        keyFingerprint,
        aiModelId,
        usageDate: usageDate || nowIsoDate(),
        phase,
        requestsDelta,
        rpmHitsDelta,
        tpmEstimatedDelta,
    });
}

async function listUsage({
    fromDate = null,
    toDate = null,
    phase = null,
    apiModelId = null,
    keyFingerprint = null,
    limit = 100,
    offset = 0,
} = {}) {
    return aiModelUsageRepo.listUsage({
        fromDate,
        toDate,
        phase,
        apiModelId,
        keyFingerprint,
        limit,
        offset,
    });
}

async function getRoutingMode() {
    const row = await aiRoutingConfigRepo.getRoutingConfig();
    return row || { id: 1, routing_mode: 'auto', metadata: {}, updated_by: null };
}

async function setRoutingMode({ routingMode, updatedBy = null, metadata = {} }) {
    const row = await aiRoutingConfigRepo.setRoutingMode({ routingMode, updatedBy, metadata });
    try {
        require('./modelRouter').invalidateRoutingConfigCache();
    } catch (_) { /* optional dep at cold start */ }
    return row;
}

async function listManualOverrides({
    includeDisabled = false,
    scope = null,
    activeOnly = false,
    limit = 100,
    offset = 0,
} = {}) {
    return aiManualOverridesRepo.listOverrides({
        includeDisabled,
        scope,
        activeOnly,
        limit,
        offset,
    });
}

async function getManualOverrideById(id) {
    return aiManualOverridesRepo.getOverrideById(id);
}

async function createManualOverride(payload) {
    const row = await aiManualOverridesRepo.createOverride(payload);
    try {
        require('./modelRouter').invalidateManualOverridesCache();
    } catch (_) { /* optional dep at cold start */ }
    return row;
}

async function updateManualOverride(id, payload) {
    const row = await aiManualOverridesRepo.updateOverride(id, payload);
    try {
        require('./modelRouter').invalidateManualOverridesCache();
    } catch (_) { /* optional dep at cold start */ }
    return row;
}

async function appendAuditEvent(input) {
    return aiAdminAuditRepo.appendAuditEvent(input);
}

async function listAudit({
    entityType = null,
    actorUserId = null,
    limit = 100,
    offset = 0,
} = {}) {
    return aiAdminAuditRepo.listAudit({
        entityType,
        actorUserId,
        limit,
        offset,
    });
}

function invalidateRegistryCache() {
    cacheValue = null;
    cacheKey = '';
}

module.exports = {
    getRegistrySnapshot,
    listRoutingRules,
    createRoutingRule,
    updateRoutingRule,
    enableRoutingRule,
    listUsage,
    getRoutingMode,
    setRoutingMode,
    listManualOverrides,
    getManualOverrideById,
    createManualOverride,
    updateManualOverride,
    appendAuditEvent,
    listAudit,
    setModelEnabled,
    upsertModelWithLimits,
    importFromModelsJson,
    recordUsageByApiModelId,
    invalidateRegistryCache,
    inferIsPreview,
    inferModelRole,
};

