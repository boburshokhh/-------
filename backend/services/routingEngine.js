'use strict';

/**
 * RoutingEngine — explainable model selection for every pipeline stage.
 *
 * Entry point: selectModel(stageRequest) -> RoutingDecision
 *
 * Wraps the old modelRouter.js logic with:
 *  - unified stage taxonomy
 *  - candidate filtering + scoring
 *  - fallback chain construction
 *  - explainable decision logging to ai_routing_decisions
 *  - preview/canary gating
 *  - premium burn guard
 *  - manual override precedence
 */

const config = require('../config');
const { logStructured } = require('../utils/observability');
const {
    STAGE_KEYS, ALL_STAGE_KEYS, STAGE_CATALOG, COST_TIERS,
    classifyDocumentSize, usageBucketFromStageKey, stageKeyFromAgentRole,
} = require('../config/stageTaxonomy');
const {
    MAX_QUALITY_MODE,
    SYSTEM_ROUTING_MODES,
    MAX_QUALITY_LLM_CHAIN,
    MAX_QUALITY_EMBEDDING_CHAIN,
    isMaxQualityMode,
} = require('../config/routingModes');

const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiRoutingDecisionsRepo = require('../db/repositories/aiRoutingDecisionsRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const aiModelHealthRepo = require('../db/repositories/aiModelHealthRepo');
const aiRoutingRulesRepo = require('../db/repositories/aiRoutingRulesRepo');
const aiManualOverridesRepo = require('../db/repositories/aiManualOverridesRepo');

// ---------------------------------------------------------------------------
// Caches (short TTL, invalidated on admin writes)
// ---------------------------------------------------------------------------
const CACHE_TTL = 15_000;
let _policiesCache = null;
let _catalogCache = null;
let _healthCache = null;
let _rulesCache = new Map();
let _overridesCache = null;

function invalidateAll() {
    _policiesCache = null;
    _catalogCache = null;
    _healthCache = null;
    _rulesCache.clear();
    _overridesCache = null;
}
function invalidatePolicies() { _policiesCache = null; }
function invalidateRules() { _rulesCache.clear(); }
function invalidateOverrides() { _overridesCache = null; }
function invalidateHealth() { _healthCache = null; }

async function _loadPolicies() {
    if (_policiesCache && Date.now() - _policiesCache.ts < CACHE_TTL) return _policiesCache.data;
    let data;
    try { data = await aiGlobalPoliciesRepo.getPolicies(); } catch { data = null; }
    if (!data) {
        data = {
            routing_mode: 'auto', stable_only: false, premium_guard_enabled: true,
            premium_soft_limit_percent: 20, max_premium_percent_per_day: 25,
            max_pro_calls_per_run: 10, preview_canary_percent: 0,
            emergency_downgrade: false, metadata: {},
        };
    }
    _policiesCache = { ts: Date.now(), data };
    return data;
}

async function _loadCatalog() {
    if (_catalogCache && Date.now() - _catalogCache.ts < CACHE_TTL) return _catalogCache.data;
    let data;
    try {
        data = await aiModelsRepo.listModelsWithLimits({
            provider: 'google',
            tier: config.GEMINI_QUOTA_TIER || 'free',
            includeDisabled: true,
            includePreviews: true,
        });
    } catch { data = []; }
    _catalogCache = { ts: Date.now(), data };
    return data;
}

async function _loadHealth() {
    if (_healthCache && Date.now() - _healthCache.ts < CACHE_TTL) return _healthCache.data;
    let rows;
    try { rows = await aiModelHealthRepo.listAllLatest(); } catch { rows = []; }
    const map = new Map();
    for (const r of rows) map.set(Number(r.ai_model_id), r);
    _healthCache = { ts: Date.now(), data: map };
    return map;
}

async function _loadRulesForStage(stageKey) {
    const hit = _rulesCache.get(stageKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.rows;
    let rows = [];
    try {
        const byStage = await aiRoutingRulesRepo.listRules({ phase: null, enabledOnly: true });
        rows = byStage.filter(r => r.stage_key === stageKey || r.phase === stageKey);
    } catch { /* ignore */ }
    _rulesCache.set(stageKey, { ts: Date.now(), rows });
    return rows;
}

async function _loadOverrides() {
    if (_overridesCache && Date.now() - _overridesCache.ts < CACHE_TTL) return _overridesCache.data;
    let data;
    try {
        data = await aiManualOverridesRepo.listOverrides({
            includeDisabled: false,
            activeOnly: true,
            limit: 500,
        });
    } catch { data = []; }
    _overridesCache = { ts: Date.now(), data };
    return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPremiumId(id) {
    const s = String(id || '').toLowerCase();
    return s.includes('pro') && !s.includes('flash');
}
function isLiteId(id) {
    const s = String(id || '').toLowerCase();
    return s.includes('flash-lite') || s.includes('flash_lite');
}
function isPreviewId(id) {
    const s = String(id || '').toLowerCase();
    return s.includes('preview') || s.includes('experimental');
}
function costTierOf(id) {
    if (isPremiumId(id)) return COST_TIERS.premium;
    if (isLiteId(id)) return COST_TIERS.economy;
    return COST_TIERS.standard;
}

function normalizeComplexity(raw) {
    if (raw == null || Number.isNaN(Number(raw))) return 0.4;
    const n = Number(raw);
    if (n > 1) return Math.min(1, n / 100);
    return Math.max(0, Math.min(1, n));
}

function dedupe(arr) {
    const seen = new Set();
    return arr.filter(x => { if (!x || seen.has(x)) return false; seen.add(x); return true; });
}

function modelHasCapability(model, requiredCaps) {
    if (!requiredCaps || requiredCaps.length === 0) return true;
    const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
    const role = model.model_role || '';
    for (const req of requiredCaps) {
        if (caps.includes(req)) continue;
        if (req === 'supports_embedding' && role === 'embedding') continue;
        if (req === 'supports_fast_generation' && role === 'llm') continue;
        if (req === 'supports_grounding' && role === 'llm') continue;
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Core: selectModel
// ---------------------------------------------------------------------------

/**
 * @param {object} stageRequest
 * @param {string} stageRequest.stageKey — canonical stage_key from STAGE_KEYS
 * @param {string} [stageRequest.agentRole] — legacy agent role (optional)
 * @param {string} [stageRequest.requestedMode] — user/admin requested mode
 * @param {object} [stageRequest.documentMetadata]
 * @param {number} [stageRequest.complexityScore]
 * @param {number} [stageRequest.qualityRiskScore]
 * @param {string} [stageRequest.traceId]
 * @param {number|string} [stageRequest.documentId]
 * @param {number} [stageRequest.runId]
 * @param {string} [stageRequest.executionMode] — 'normal'|'degraded'|'emergency_fallback'
 * @param {object} [stageRequest.adminOverrides] — { model, disablePremium, forcePreview }
 * @param {object} [stageRequest.quotaSnapshot] — pre-loaded snapshot
 * @returns {Promise<RoutingDecision>}
 */
async function selectModel(stageRequest) {
    const startMs = Date.now();
    const stageKey = stageRequest.stageKey || STAGE_KEYS.question_generation;
    const stageMeta = STAGE_CATALOG[stageKey] || STAGE_CATALOG[STAGE_KEYS.question_generation];
    const agentRole = stageRequest.agentRole || null;
    const complexity = normalizeComplexity(stageRequest.complexityScore);
    const qualityRisk = Number(stageRequest.qualityRiskScore) || 0;
    const docMeta = stageRequest.documentMetadata || {};
    const pageCount = Number(docMeta.page_count) || 0;
    const docSize = classifyDocumentSize(pageCount);
    const traceId = stageRequest.traceId || null;
    const documentId = stageRequest.documentId ?? null;
    const runId = stageRequest.runId ?? null;
    const executionMode = stageRequest.executionMode || 'normal';
    const adminOv = stageRequest.adminOverrides || {};

    const rejections = [];
    let premiumBlocked = false;
    let previewBlocked = false;
    let wasFallback = false;
    let fallbackReason = null;
    let manualOverrideId = null;
    let decisionSource = 'engine';

    // 1. Load policies, catalog, health, rules, overrides
    const [policies, catalog, healthMap, overrides] = await Promise.all([
        _loadPolicies(),
        _loadCatalog(),
        _loadHealth(),
        _loadOverrides(),
    ]);

    const effectiveMode = resolveMode(stageRequest.requestedMode, policies);
    const isEmergency = isMaxQualityMode(effectiveMode) ? false : policies.emergency_downgrade;

    // 2. Check manual override (highest precedence)
    const override = findMatchingOverride(overrides, { stageKey, agentRole, documentId, runId });
    let forcedModelId = null;
    if (override) {
        manualOverrideId = override.id;
        decisionSource = 'manual_override';
        const modelRow = catalog.find(m => m.id === Number(override.model_id));
        if (modelRow && modelRow.api_model_id) {
            forcedModelId = modelRow.api_model_id;
        }
    }
    if (!forcedModelId && adminOv.model) {
        forcedModelId = adminOv.model;
        decisionSource = 'admin_override';
    }

    // 3. Load stage routing rules
    const stageRules = await _loadRulesForStage(stageKey);
    const matchedRule = stageRules.find(r => matchRuleConditions(r, {
        routingMode: effectiveMode, complexity, docMeta, executionMode,
    }));
    const ruleActions = matchedRule?.actions || {};

    // 4. Build effective policy
    const maxQuality = isMaxQualityMode(effectiveMode);

    const allowPreview = maxQuality || (!policies.stable_only
        && !isEmergency
        && (matchedRule?.allow_preview || false)
        && !adminOv.forceStableOnly);
    const allowPremium = !isEmergency
        && (stageMeta.premium_eligible || maxQuality)
        && (maxQuality || ruleActions.allow_premium !== false)
        && (maxQuality || !adminOv.disablePremium)
        && shouldAllowPremium(effectiveMode, stageKey, complexity, docMeta, policies);

    // 5. Build candidate list
    let candidates = buildCandidatePool(catalog, stageMeta, {
        forcedModelId, ruleActions, effectiveMode,
    });

    // 6. Filter candidates
    const preFilterCount = candidates.length;
    candidates = candidates.filter(c => {
        if (!c.is_enabled) { rejections.push({ id: c.api_model_id, reason: 'disabled' }); return false; }
        if (!modelHasCapability(c, stageMeta.capabilities)) {
            rejections.push({ id: c.api_model_id, reason: 'missing_capability' }); return false;
        }
        if (isPreviewId(c.api_model_id) || c.is_preview || c.stability_class === 'preview') {
            if (!allowPreview) {
                rejections.push({ id: c.api_model_id, reason: 'preview_blocked' });
                previewBlocked = true;
                return false;
            }
        }
        if (isPremiumId(c.api_model_id)) {
            if (!allowPremium) {
                rejections.push({ id: c.api_model_id, reason: 'premium_blocked' });
                premiumBlocked = true;
                return false;
            }
        }
        const health = healthMap.get(Number(c.id));
        if (!maxQuality && health && (health.is_suppressed || (!health.is_healthy && health.error_rate > 0.3))) {
            rejections.push({ id: c.api_model_id, reason: 'health_suppressed' });
            return false;
        }
        return true;
    });

    // 7. Score and sort
    candidates = scoreCandidates(candidates, {
        effectiveMode, stageKey, complexity, qualityRisk, docSize, isEmergency,
        canaryPercent: policies.preview_canary_percent || 0,
    });

    // 8. Pick primary
    let selected = candidates[0] || null;
    if (!selected) {
        selected = pickEmergencyFallback(catalog, stageMeta);
        wasFallback = true;
        fallbackReason = 'no_candidate_after_filtering';
        decisionSource = 'emergency_fallback';
    }

    // 9. Build fallback chain
    const fallbackChain = buildFallbackChain(candidates, selected, catalog, stageMeta);

    // 10. Resolve forced override if it passed guards
    if (forcedModelId) {
        const forcedRow = catalog.find(m => m.api_model_id === forcedModelId);
        if (forcedRow && forcedRow.is_enabled) {
            const wasForced = selected;
            selected = forcedRow;
            if (!override?.force_override) {
                const health = healthMap.get(Number(forcedRow.id));
                if (health && health.is_suppressed) {
                    selected = wasForced;
                    fallbackReason = 'override_model_suppressed';
                    wasFallback = true;
                }
            }
        }
    }

    const selectedApiModelId = selected?.api_model_id || config.LLM_MODEL || 'gemini-2.5-flash';
    const selectedModelId = selected?.id || null;

    const decision = {
        selectedModel: selectedApiModelId,
        selectedModelId,
        fallbackModel: fallbackChain[0] || selectedApiModelId,
        fallbackChain: fallbackChain,
        reason: buildReasonString(decisionSource, effectiveMode, matchedRule, wasFallback, fallbackReason),
        costTier: costTierOf(selectedApiModelId),
        isPreview: !!(selected?.is_preview || isPreviewId(selectedApiModelId)),
        stageKey,
        agentRole,
        premiumBlocked,
        previewBlocked,
        wasFallback,
        fallbackReason,
        manualOverrideId,
        decisionSource,
        fromDbRule: !!matchedRule,
    };

    // 11. Write decision log
    const latencyMs = Date.now() - startMs;
    const recordDecision = stageRequest.recordDecision !== false;
    let decisionId = null;
    if (recordDecision) {
        try {
            decisionId = await aiRoutingDecisionsRepo.insertDecision({
                runId, documentId, traceId, stageKey, agentRole,
                selectedModelId, selectedApiModelId,
                fallbackChain,
                decisionReason: decision.reason,
                decisionSource,
                wasFallback, fallbackReason,
                premiumBlocked, previewBlocked,
                manualOverrideId,
                costTier: decision.costTier,
                isPreview: decision.isPreview,
                quotaSnapshot: stageRequest.quotaSnapshot || null,
                candidateSnapshot: rejections.length > 0 ? { rejected: rejections.slice(0, 20) } : null,
                policySnapshot: {
                    mode: effectiveMode,
                    stable_only: policies.stable_only,
                    emergency: isEmergency,
                    premium_guard: policies.premium_guard_enabled,
                    canary_percent: policies.preview_canary_percent,
                },
                latencyMs,
            });
        } catch (e) {
            console.warn('[RoutingEngine] decision log write failed:', e.message);
        }

        logStructured({
            level: 'info',
            traceId, documentId,
            phase: 'generate',
            event: 'routing_engine_decision',
            metrics: {
                stage_key: stageKey,
                agent_role: agentRole,
                selected_model: selectedApiModelId,
                fallback_model: decision.fallbackModel,
                cost_tier: decision.costTier,
                mode: effectiveMode,
                reason: decision.reason,
                is_preview: decision.isPreview,
                premium_blocked: premiumBlocked,
                preview_blocked: previewBlocked,
                decision_id: decisionId,
                latency_ms: latencyMs,
            },
        });
    }

    decision.decisionId = decisionId;

    return decision;
}

// ---------------------------------------------------------------------------
// Sub-routines
// ---------------------------------------------------------------------------

function resolveMode(requestedMode, policies) {
    const normalized = String(requestedMode || '').toLowerCase().trim();
    const valid = SYSTEM_ROUTING_MODES;
    if (valid.includes(normalized)) return normalized;
    const global = String(policies.routing_mode || '').toLowerCase().trim();
    if (valid.includes(global)) return global;
    return 'auto';
}

function findMatchingOverride(overrides, { stageKey, agentRole, documentId, runId }) {
    if (!overrides || overrides.length === 0) return null;
    const scoped = overrides.filter(o => {
        const scope = String(o.scope || '');
        const target = String(o.target || '');
        if (scope === 'global') return true;
        if (scope === 'agent' && agentRole && target === agentRole) return true;
        if (scope === 'phase' && (target === stageKey || target === agentRole)) return true;
        if (scope === 'document' && documentId != null && target === String(documentId)) return true;
        if (o.stage_key && o.stage_key === stageKey) return true;
        return false;
    });
    scoped.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return scoped[0] || null;
}

function matchRuleConditions(rule, { routingMode, complexity, docMeta, executionMode }) {
    const cond = rule.conditions || {};
    if (Object.keys(cond).length === 0) return true;
    if (cond.routing_mode) {
        const allowed = Array.isArray(cond.routing_mode) ? cond.routing_mode : [cond.routing_mode];
        if (!allowed.map(x => String(x).toLowerCase()).includes(routingMode)) return false;
    }
    if (cond.min_complexity != null && complexity < Number(cond.min_complexity)) return false;
    if (cond.max_complexity != null && complexity > Number(cond.max_complexity)) return false;
    const pages = Number(docMeta?.page_count) || 0;
    if (cond.min_pages != null && pages < Number(cond.min_pages)) return false;
    if (cond.execution_mode && executionMode !== cond.execution_mode) return false;
    return true;
}

function shouldAllowPremium(mode, stageKey, complexity, docMeta, policies) {
    if (isMaxQualityMode(mode)) return true;
    if (!policies.premium_guard_enabled) return true;
    const heavyStages = [
        STAGE_KEYS.blueprint_generation,
        STAGE_KEYS.question_generation,
        STAGE_KEYS.grounding_validation,
        STAGE_KEYS.facts_enrichment,
        STAGE_KEYS.theme_extraction,
    ];
    if (!heavyStages.includes(stageKey)) return false;
    const pages = Number(docMeta?.page_count) || 0;
    const docHeavy = pages > 15 || !!docMeta?.low_text_quality;
    if (mode === 'quality') return complexity >= 0.45 || docHeavy;
    if (mode === 'auto' || mode === 'balanced') return complexity >= 0.65 || docHeavy;
    return false;
}

function buildCandidatePool(catalog, stageMeta, { forcedModelId, ruleActions, effectiveMode }) {
    const pool = [];

    if (forcedModelId) {
        const row = catalog.find(m => m.api_model_id === forcedModelId);
        if (row) pool.push(row);
    }

    if (ruleActions.primary_api_model_id) {
        const row = catalog.find(m => m.api_model_id === ruleActions.primary_api_model_id);
        if (row && !pool.find(p => p.id === row.id)) pool.push(row);
    }
    if (ruleActions.escalation?.to_api_model_id) {
        const row = catalog.find(m => m.api_model_id === ruleActions.escalation.to_api_model_id);
        if (row && !pool.find(p => p.id === row.id)) pool.push(row);
    }
    if (Array.isArray(ruleActions.fallback_api_model_ids)) {
        for (const fid of ruleActions.fallback_api_model_ids) {
            const row = catalog.find(m => m.api_model_id === fid);
            if (row && !pool.find(p => p.id === row.id)) pool.push(row);
        }
    }

    const taskType = stageMeta.task_type;
    const isEmbedding = taskType === 'embedding';

    if (isMaxQualityMode(effectiveMode)) {
        const preferred = isEmbedding ? MAX_QUALITY_EMBEDDING_CHAIN : MAX_QUALITY_LLM_CHAIN;
        for (const apiId of preferred) {
            const row = catalog.find(m => m.api_model_id === apiId);
            if (row && !pool.find(p => p.id === row.id)) pool.push(row);
        }
    }

    for (const m of catalog) {
        if (pool.find(p => p.id === m.id)) continue;
        if (isEmbedding && m.model_role !== 'embedding') continue;
        if (!isEmbedding && m.model_role === 'embedding') continue;
        if (!isEmbedding && m.model_role !== 'llm') continue;
        pool.push(m);
    }

    return pool;
}

function scoreCandidates(candidates, opts) {
    const { effectiveMode, stageKey, complexity, qualityRisk, docSize, isEmergency } = opts;

    return candidates.map(c => {
        let score = 0;

        const tier = costTierOf(c.api_model_id);
        if (effectiveMode === MAX_QUALITY_MODE) {
            if (tier === 'premium') score += 50;
            else if (tier === 'standard') score += 25;
            else score += 5;
        } else if (tier === 'economy') score += 30;
        else if (tier === 'standard') score += 20;
        else score += 5;

        if (c.stability_class === 'stable' || (!c.is_preview && !isPreviewId(c.api_model_id))) {
            score += 15;
        }

        if (isEmergency && tier === 'economy') score += 20;

        if (effectiveMode === MAX_QUALITY_MODE) {
            const preferred = stageKey === STAGE_KEYS.embedding
                ? MAX_QUALITY_EMBEDDING_CHAIN
                : MAX_QUALITY_LLM_CHAIN;
            const idx = preferred.indexOf(c.api_model_id);
            if (idx >= 0) score += 100 - idx * 10;
            if (c.is_preview || isPreviewId(c.api_model_id)) score += 12;
            if (String(c.api_model_id || '').includes('3.1')) score += 8;
            if (String(c.api_model_id || '').includes('3-pro')) score += 6;
        } else if (effectiveMode === 'economy') {
            if (tier === 'economy') score += 15;
        } else if (effectiveMode === 'quality') {
            if (tier === 'standard') score += 10;
            if (tier === 'premium' && complexity >= 0.5) score += 15;
        } else if (effectiveMode === 'balanced') {
            if (tier === 'standard') score += 12;
        }

        if (complexity >= 0.7 && tier === 'premium') score += 8;

        if (c.is_enabled) score += 5;

        return { ...c, _score: score };
    }).sort((a, b) => b._score - a._score);
}

function buildFallbackChain(scoredCandidates, selected, catalog, stageMeta) {
    const chain = [];
    for (const c of scoredCandidates) {
        if (c.id === selected?.id) continue;
        if (chain.length >= 3) break;
        chain.push(c.api_model_id);
    }

    const defaultFlash = config.LLM_MODEL || 'gemini-2.5-flash';
    const defaultLite = config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite';
    if (!chain.includes(defaultFlash) && selected?.api_model_id !== defaultFlash) {
        chain.push(defaultFlash);
    }
    if (!chain.includes(defaultLite) && selected?.api_model_id !== defaultLite && chain.length < 4) {
        chain.push(defaultLite);
    }

    return dedupe(chain).slice(0, 4);
}

function pickEmergencyFallback(catalog, stageMeta) {
    const isEmbedding = stageMeta.task_type === 'embedding';
    if (isEmbedding) {
        const emb = catalog.find(m =>
            m.is_enabled && m.model_role === 'embedding' && !m.is_preview);
        if (emb) return emb;
    }
    const flash = catalog.find(m =>
        m.is_enabled && m.api_model_id && m.api_model_id.includes('flash')
        && !m.api_model_id.includes('lite') && !m.is_preview && m.model_role === 'llm');
    if (flash) return flash;
    const any = catalog.find(m => m.is_enabled && m.model_role === 'llm');
    return any || null;
}

function buildReasonString(source, mode, matchedRule, wasFallback, fallbackReason) {
    const parts = [source];
    parts.push(`mode_${mode}`);
    if (matchedRule) parts.push(`rule_${matchedRule.id}`);
    if (wasFallback) parts.push('fallback');
    if (fallbackReason) parts.push(fallbackReason);
    return parts.join('_');
}

// ---------------------------------------------------------------------------
// Convenience: resolve models for full pipeline in one call
// ---------------------------------------------------------------------------

async function resolvePipelineModels(pipelineCtx) {
    const {
        routingMode, documentMetadata, complexityScore, qualityRiskScore,
        quotaSnapshot, adminOverrides, traceId, documentId, runId, executionMode,
    } = pipelineCtx;

    const stages = [
        STAGE_KEYS.embedding,
        STAGE_KEYS.cheap_preprocess,
        STAGE_KEYS.blueprint_generation,
        STAGE_KEYS.question_generation,
        STAGE_KEYS.grounding_validation,
        STAGE_KEYS.backfill_generation,
    ];

    const decisions = {};
    const modelsByStage = {};

    for (const stageKey of stages) {
        const decision = await selectModel({
            stageKey,
            requestedMode: routingMode,
            documentMetadata,
            complexityScore,
            qualityRiskScore,
            quotaSnapshot,
            adminOverrides,
            traceId,
            documentId,
            runId,
            executionMode,
        });
        decisions[stageKey] = decision;
        modelsByStage[stageKey] = decision.selectedModel;
    }

    return { decisions, modelsByStage };
}

module.exports = {
    selectModel,
    resolvePipelineModels,
    invalidateAll,
    invalidatePolicies,
    invalidateRules,
    invalidateOverrides,
    invalidateHealth,
    normalizeComplexity,
    costTierOf,
    isPremiumId,
    isLiteId,
    isPreviewId,
};
