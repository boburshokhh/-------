/**
 * Routing engine: выбор api model id для стадий пайплайна с учётом режима, квоты и бюджетов.
 */

'use strict';

const config = require('../config');
const { AGENT_ROLES, AGENT_TO_ROUTER_STAGE } = require('../config/agentRoles');
const quotaGuard = require('./quotaGuard');
const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiModelRegistryService = require('./aiModelRegistryService');
const runRepo = require('../db/repositories/runRepo');
const { logStructured } = require('../utils/observability');

const ROUTING_CFG = () => config.MODEL_ROUTING || {};

function normalizeComplexity(raw) {
    if (raw == null || Number.isNaN(Number(raw))) return 0.4;
    const n = Number(raw);
    if (n > 1) return Math.min(1, n / 100);
    return Math.max(0, Math.min(1, n));
}

function isHeavyStage(stage) {
    const s = String(stage || 'pipeline').toLowerCase();
    const heavy = ROUTING_CFG().heavyStages || [
        'pipeline', 'generation', 'grounding', 'backfill', 'blueprint',
    ];
    return heavy.includes(s);
}

function isPremiumModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    const pro = String(config.LLM_PREMIUM_MODEL || 'gemini-2.5-pro').toLowerCase();
    return id.includes('pro') && !id.includes('flash') || id === pro;
}

function isLiteModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('flash-lite') || id.includes('flash_lite');
}

function isPremiumAllowed(mode, stage, complexityNorm, documentMetadata) {
    if (!isHeavyStage(stage)) return false;
    const meta = documentMetadata || {};
    const pages = Number(meta.page_count) || 0;
    const maxEasy = ROUTING_CFG().maxPagesForEasyDoc ?? 15;
    const docHeavy = pages > maxEasy || !!meta.low_text_quality;
    const thAuto = ROUTING_CFG().complexityPremiumThreshold ?? 0.65;
    const thQuality = ROUTING_CFG().qualityMinComplexityForPremium ?? 0.45;

    if (mode === 'quality') {
        return complexityNorm >= thQuality || docHeavy;
    }
    if (mode === 'auto') {
        return complexityNorm >= thAuto || docHeavy;
    }
    return false;
}

/**
 * Бюджетная фаза для canUseModelForStage (aiBudgetGuard).
 */
function budgetPhaseForCandidate(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (id.includes('embedding')) return 'embedding';
    if (id.includes('flash-lite') || id.includes('flash_lite')) return 'cheap_generation';
    if (isPremiumModelId(modelId)) return 'premium_reasoning';
    return 'standard_generation';
}

function isPreviewHeuristic(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('preview') || id.includes('experimental');
}

async function isPreviewModel(modelId) {
    if (!modelId) return false;
    if (isPreviewHeuristic(modelId)) return true;
    try {
        const row = await aiModelsRepo.getModelByApiModelId(modelId);
        return !!(row && row.is_preview);
    } catch {
        return false;
    }
}

function costTierFromModelId(modelId) {
    if (!modelId) return 'standard';
    if (isPremiumModelId(modelId)) return 'premium';
    if (isLiteModelId(modelId)) return 'economy';
    return 'standard';
}

function allowedLlmIds() {
    const set = new Set((config.LLM_MODELS || []).map((m) => m.id));
    if (config.LLM_PREMIUM_MODEL) set.add(config.LLM_PREMIUM_MODEL);
    if (config.LLM_FAST_MODEL) set.add(config.LLM_FAST_MODEL);
    if (config.LLM_MODEL) set.add(config.LLM_MODEL);
    if (config.SUMMARY_CHEAP_MODEL) set.add(config.SUMMARY_CHEAP_MODEL);
    return set;
}

function dedupe(ids) {
    const out = [];
    const seen = new Set();
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Упорядочить кандидатов LLM по режиму и допуску premium.
 */
function buildLlmCandidateOrder(mode, stage, allowPremium, flags, adminOverrides) {
    const lite = config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite';
    const flash = config.LLM_MODEL || 'gemini-2.5-flash';
    const pro = config.LLM_PREMIUM_MODEL || 'gemini-2.5-pro';

    const disablePremium = adminOverrides?.disablePremium || flags?.premiumBudgetTight;

    let order = [];
    if (mode === 'economy') {
        order = [lite, flash];
        if (allowPremium && !disablePremium) order.push(pro);
    } else if (mode === 'balanced') {
        order = [flash, lite];
        if (allowPremium && !disablePremium) order.push(pro);
    } else if (mode === 'quality') {
        if (allowPremium && !disablePremium && isHeavyStage(stage)) {
            order = [pro, flash, lite];
        } else {
            order = [flash, lite];
            if (allowPremium && !disablePremium) order.push(pro);
        }
    } else {
        const autoPrem = allowPremium && !disablePremium && isHeavyStage(stage);
        if (autoPrem) {
            order = [pro, flash, lite];
        } else {
            order = [flash, lite];
            if (allowPremium && !disablePremium) order.push(pro);
        }
    }

    return dedupe(order);
}

async function filterPreviewCandidates(ids, flags, adminOverrides) {
    const blocked = flags?.previewRoutingBlocked;
    const force = adminOverrides?.forcePreview;
    if (!blocked || force) return ids;
    const out = [];
    for (const id of ids) {
        if (!(await isPreviewModel(id))) out.push(id);
    }
    return out.length ? out : ids;
}

/**
 * @param {object} input
 * @param {string} input.stage
 * @param {string} input.requestedMode
 * @param {object} [input.documentMetadata]
 * @param {number} [input.complexityScore]
 * @param {object|null} [input.quotaSnapshot]
 * @param {object} [input.adminOverrides]
 * @param {string} [input.traceId]
 * @param {number|string|null} [input.documentId]
 * @returns {Promise<object>}
 */
async function routeModel(input) {
    const stage = String(input.stage || 'pipeline').toLowerCase();
    const mode = await resolveEffectiveMode(input.requestedMode);
    const documentMetadata = input.documentMetadata || {};
    const complexityNorm = normalizeComplexity(input.complexityScore);
    const adminOverrides = input.adminOverrides || {};
    const traceId = input.traceId || null;
    const documentId = input.documentId != null ? input.documentId : null;
    const agentRole = input.agentRole || null;

    const snap = input.quotaSnapshot != null
        ? input.quotaSnapshot
        : await quotaGuard.getUsageSnapshot();
    const flags = snap.flags || {};

    // embedding: только embedding model
    if (stage === 'embedding') {
        const emb = config.EMBEDDING_MODEL || 'gemini-embedding-001';
        const tier = 'economy';
        const preview = await isPreviewModel(emb);
        const out = {
            selectedModel: emb,
            fallbackModel: emb,
            reason: 'embedding_stage_only',
            costTier: tier,
            isPreview: preview,
        };
        logRouterDecision(out, { mode, stage, flags, traceId, documentId, ...(agentRole ? { agentRole } : {}) });
        return out;
    }

    // manual
    if (mode === 'manual' && adminOverrides.model) {
        const mid = String(adminOverrides.model).trim();
        const allowed = allowedLlmIds();
        if (!allowed.has(mid)) {
            const out = {
                selectedModel: config.LLM_MODEL || 'gemini-2.5-flash',
                fallbackModel: quotaGuard.getFallbackModel('standard_generation'),
                reason: 'manual_invalid_model_fallback_default',
                costTier: 'standard',
                isPreview: await isPreviewModel(config.LLM_MODEL),
            };
            logRouterDecision(out, {
                mode, stage, flags, traceId, documentId,
                ...(agentRole ? { agentRole } : {}),
                metadata: { requested: mid },
            });
            return out;
        }
        const phase = budgetPhaseForCandidate(mid);
        const guardCheck = await quotaGuard.canUseModelForStage(mid, phase);
        let selected = mid;
        let reason = 'manual_override';
        if (!guardCheck.allowed) {
            const fallbackList = dedupe([
                guardCheck.suggestedModel,
                quotaGuard.getFallbackModel(phase),
                config.LLM_MODEL,
                config.SUMMARY_CHEAP_MODEL,
            ].filter(Boolean));
            const sug = await pickFirstPassingCandidate(fallbackList, flags, adminOverrides);
            selected = sug || config.LLM_MODEL || 'gemini-2.5-flash';
            reason = `manual_guard_${guardCheck.reason || 'adjusted'}`;
        }
        const fb = pickNextFallback(selected, [mid, config.LLM_MODEL, config.SUMMARY_CHEAP_MODEL].filter(Boolean));
        const out = {
            selectedModel: selected,
            fallbackModel: fb,
            reason,
            costTier: costTierFromModelId(selected),
            isPreview: await isPreviewModel(selected),
        };
        logRouterDecision(out, { mode, stage, flags, traceId, documentId, ...(agentRole ? { agentRole } : {}) });
        return out;
    }

    const allowPremium = isPremiumAllowed(mode, stage, complexityNorm, documentMetadata) || mode === 'balanced';

    let candidates = buildLlmCandidateOrder(mode, stage, allowPremium, flags, adminOverrides);
    candidates = await filterPreviewCandidates(candidates, flags, adminOverrides);

    let selected = null;
    let reason = 'ordered_pick';

    for (const id of candidates) {
        const phase = budgetPhaseForCandidate(id);
        const { allowed } = await quotaGuard.canUseModelForStage(id, phase);
        if (allowed) {
            selected = id;
            break;
        }
    }

    if (!selected) {
        selected = quotaGuard.getFallbackModel('standard_generation');
        reason = 'no_candidate_passed_budget_guard';
    }

    const rpdOk = await quotaGuard.getAvailableModel(selected);
    if (rpdOk && rpdOk !== selected) {
        reason = `${reason}_rpd_fallback`;
        selected = rpdOk;
    }

    const fallbackModel = pickNextFallback(selected, candidates) || quotaGuard.getFallbackModel(budgetPhaseForCandidate(selected));

    const out = {
        selectedModel: selected,
        fallbackModel: fallbackModel || selected,
        reason,
        costTier: costTierFromModelId(selected),
        isPreview: await isPreviewModel(selected),
    };

    logRouterDecision(out, {
        mode,
        stage,
        flags,
        traceId,
        documentId,
        ...(agentRole ? { agentRole } : {}),
        metrics: { complexity_norm: complexityNorm },
    });
    return out;
}

async function pickFirstPassingCandidate(ids, flags, adminOverrides) {
    const filtered = await filterPreviewCandidates(dedupe(ids), flags, adminOverrides);
    for (const id of filtered) {
        const { allowed } = await quotaGuard.canUseModelForStage(id, budgetPhaseForCandidate(id));
        if (allowed) return id;
    }
    return null;
}

function pickNextFallback(selected, orderedCandidates) {
    const idx = orderedCandidates.indexOf(selected);
    if (idx >= 0 && idx < orderedCandidates.length - 1) {
        return orderedCandidates[idx + 1];
    }
    const chain = (config.LLM_FALLBACK_CHAIN && config.LLM_FALLBACK_CHAIN[selected]) || [];
    if (chain[0]) return chain[0];
    return null;
}

function logRouterDecision(out, ctx) {
    logStructured({
        level: 'info',
        traceId: ctx.traceId,
        documentId: ctx.documentId,
        phase: 'generate',
        event: 'model_router_decision',
        metrics: {
            selected_model: out.selectedModel,
            fallback_model: out.fallbackModel,
            cost_tier: out.costTier,
            requested_mode: ctx.mode,
            stage: ctx.stage,
            reason: out.reason,
            is_preview: out.isPreview,
            ...(ctx.agentRole ? { agent_role: ctx.agentRole } : {}),
            ...(ctx.metrics || {}),
        },
        metadata: {
            flags: ctx.flags,
            ...(ctx.agentRole ? { agent_role: ctx.agentRole } : {}),
            ...(ctx.metadata || {}),
        },
    });
}

/**
 * Дублирует решение роутера в pipeline_run_events (после появления run_id).
 */
async function emitRouterDecisionToPipeline(runId, documentId, traceId, decision) {
    if (!runId || !decision) return;
    try {
        await runRepo.insertPipelineEvent({
            run_id: runId,
            document_id: documentId,
            phase: 'generate',
            event: 'model_router_decision',
            level: 'info',
            metadata: {
                selected_model: decision.selectedModel,
                fallback_model: decision.fallbackModel,
                cost_tier: decision.costTier,
                reason: decision.reason,
                is_preview: decision.isPreview,
                ...(decision.agentRole ? { agent_role: decision.agentRole } : {}),
                ...(decision.fromDbRule != null ? { from_db_rule: decision.fromDbRule } : {}),
                ...(decision.fromManualOverride != null ? { from_manual_override: decision.fromManualOverride } : {}),
                ...(decision.manualOverrideId != null ? { manual_override_id: decision.manualOverrideId } : {}),
            },
        });
    } catch (e) {
        console.warn('[modelRouter] emitRouterDecisionToPipeline:', e.message);
    }
}

// ─── DB routing rules (ai_routing_rules.phase = agent id) ───────────────────

const ROUTING_RULES_CACHE_TTL_MS = 30_000;
const routingRulesCache = new Map();
const ROUTING_CONFIG_CACHE_TTL_MS = 15_000;
const MANUAL_OVERRIDES_CACHE_TTL_MS = 15_000;
let routingConfigCache = null;
let manualOverridesCache = null;

function invalidateRoutingRulesCache() {
    routingRulesCache.clear();
}

function invalidateRoutingConfigCache() {
    routingConfigCache = null;
}

function invalidateManualOverridesCache() {
    manualOverridesCache = null;
}

async function loadRoutingRulesForAgent(agentRole) {
    const now = Date.now();
    const hit = routingRulesCache.get(agentRole);
    if (hit && now - hit.ts < ROUTING_RULES_CACHE_TTL_MS) return hit.rows;
    let rows = [];
    try {
        rows = await aiModelRegistryService.listRoutingRules(agentRole, { enabledOnly: true });
    } catch (e) {
        console.warn(`[modelRouter] listRoutingRules(${agentRole}): ${e.message}`);
    }
    routingRulesCache.set(agentRole, { ts: now, rows });
    return rows;
}

async function loadRoutingConfigCached() {
    const now = Date.now();
    if (routingConfigCache && now - routingConfigCache.ts < ROUTING_CONFIG_CACHE_TTL_MS) {
        return routingConfigCache.row;
    }
    let row = null;
    try {
        row = await aiModelRegistryService.getRoutingMode();
    } catch (e) {
        console.warn(`[modelRouter] getRoutingMode: ${e.message}`);
    }
    routingConfigCache = { ts: now, row };
    return row;
}

async function loadManualOverridesCached() {
    const now = Date.now();
    if (manualOverridesCache && now - manualOverridesCache.ts < MANUAL_OVERRIDES_CACHE_TTL_MS) {
        return manualOverridesCache.rows;
    }
    let rows = [];
    try {
        rows = await aiModelRegistryService.listManualOverrides({
            includeDisabled: false,
            activeOnly: true,
            limit: 500,
            offset: 0,
        });
    } catch (e) {
        console.warn(`[modelRouter] listManualOverrides: ${e.message}`);
    }
    manualOverridesCache = { ts: now, rows };
    return rows;
}

/**
 * @param {object} ctx — нормализованный контекст routeModelForAgent
 * @param {object} conditions — JSON из ai_routing_rules.conditions
 */
function matchRoutingRuleConditions(ctx, conditions) {
    if (!conditions || typeof conditions !== 'object' || Object.keys(conditions).length === 0) {
        return true;
    }
    const mode = String(ctx.requestedMode || 'auto').toLowerCase();
    if (conditions.routing_mode !== undefined) {
        const allowed = Array.isArray(conditions.routing_mode)
            ? conditions.routing_mode
            : [conditions.routing_mode];
        const allowedLc = allowed.map((x) => String(x).toLowerCase());
        if (!allowedLc.includes(mode)) return false;
    }
    if (conditions.min_complexity != null && ctx.complexityNorm < Number(conditions.min_complexity)) {
        return false;
    }
    if (conditions.max_complexity != null && ctx.complexityNorm > Number(conditions.max_complexity)) {
        return false;
    }
    const pages = Number(ctx.documentMetadata?.page_count) || 0;
    if (conditions.min_pages != null && pages < Number(conditions.min_pages)) return false;
    if (conditions.execution_mode != null && ctx.executionMode
        && ctx.executionMode !== conditions.execution_mode) {
        return false;
    }
    return true;
}

async function resolveEffectiveMode(requestedModeRaw) {
    const normalized = String(requestedModeRaw || '').toLowerCase().trim();
    if (['auto', 'economy', 'balanced', 'quality', 'manual'].includes(normalized)) {
        if (normalized !== 'auto') return normalized;
        const cfg = await loadRoutingConfigCached();
        const globalMode = String(cfg?.routing_mode || '').toLowerCase().trim();
        if (['economy', 'balanced', 'quality', 'manual'].includes(globalMode)) {
            return globalMode;
        }
        return 'auto';
    }
    const cfg = await loadRoutingConfigCached();
    const globalMode = String(cfg?.routing_mode || '').toLowerCase().trim();
    return ['auto', 'economy', 'balanced', 'quality', 'manual'].includes(globalMode)
        ? globalMode
        : 'auto';
}

function matchManualOverrideScope(override, { agentRole, stage, documentId }) {
    const scope = String(override.scope || '');
    const target = String(override.target || '');
    if (scope === 'global') return true;
    if (scope === 'agent') return target === String(agentRole || '');
    if (scope === 'phase') return target === String(stage || '');
    if (scope === 'document') return target === String(documentId || '');
    return false;
}

function buildOverrideCtx(routerCtx, agentRole, stage, documentId) {
    return {
        ...routerCtx,
        agentRole,
        stage,
        documentId,
    };
}

async function pickMatchingManualOverride({ agentRole, stage, documentId, routerCtx }) {
    const rows = await loadManualOverridesCached();
    for (const row of rows) {
        if (!matchManualOverrideScope(row, { agentRole, stage, documentId })) continue;
        if (!matchRoutingRuleConditions(buildOverrideCtx(routerCtx, agentRole, stage, documentId), row.conditions || {})) {
            continue;
        }
        if (!row.api_model_id) continue;
        return row;
    }
    return null;
}

function shouldInsertEscalationModel(ctx, actions) {
    const esc = actions.escalation;
    if (!esc || !esc.to_api_model_id) return false;
    if (actions.allow_premium === false) return false;
    const when = esc.when;
    if (!Array.isArray(when) || when.length === 0) return false;
    const th = esc.min_complexity_for_escalation != null
        ? Number(esc.min_complexity_for_escalation)
        : (ROUTING_CFG().complexityPremiumThreshold ?? 0.65);
    const maxEasy = ROUTING_CFG().maxPagesForEasyDoc ?? 15;
    for (const w of when) {
        if (w === 'high_complexity' && ctx.complexityNorm >= th) return true;
        if (w === 'routing_mode_quality' && String(ctx.requestedMode || '').toLowerCase() === 'quality') {
            return true;
        }
        if (w === 'doc_heavy') {
            const pages = Number(ctx.documentMetadata?.page_count) || 0;
            if (pages > maxEasy || ctx.documentMetadata?.low_text_quality) return true;
        }
    }
    return false;
}

/**
 * Порядок кандидатов из actions правила БД.
 * @param {object} actions — JSON из ai_routing_rules.actions
 */
function buildCandidateIdsFromRuleActions(ctx, actions) {
    if (!actions || typeof actions !== 'object') return [];
    const primary = actions.primary_api_model_id;
    const fallbacks = Array.isArray(actions.fallback_api_model_ids)
        ? actions.fallback_api_model_ids
        : [];
    const out = [];
    if (primary) out.push(String(primary).trim());
    if (shouldInsertEscalationModel(ctx, actions) && actions.escalation?.to_api_model_id) {
        out.push(String(actions.escalation.to_api_model_id).trim());
    }
    for (const f of fallbacks) {
        if (f) out.push(String(f).trim());
    }
    return dedupe(out.filter(Boolean));
}

/**
 * Выбор модели для агентной роли: сначала правила в БД (phase = agentRole), иначе legacy routeModel.
 *
 * @param {object} input
 * @param {string} input.agentRole — например blueprint_agent
 * @param {string} [input.requestedMode]
 * @param {object} [input.documentMetadata]
 * @param {number} [input.complexityScore]
 * @param {object|null} [input.quotaSnapshot]
 * @param {object} [input.adminOverrides]
 * @param {string} [input.traceId]
 * @param {number|string|null} [input.documentId]
 * @param {string} [input.executionMode] — normal | degraded | emergency_fallback (pipelineContext)
 */
async function routeModelForAgent(input) {
    const agentRole = String(input.agentRole || '').trim();
    const mode = await resolveEffectiveMode(input.requestedMode);
    const documentMetadata = input.documentMetadata || {};
    const complexityNorm = normalizeComplexity(input.complexityScore);
    const adminOverrides = input.adminOverrides || {};
    const traceId = input.traceId || null;
    const documentId = input.documentId != null ? input.documentId : null;
    const executionMode = input.executionMode || 'normal';

    const snap = input.quotaSnapshot != null
        ? input.quotaSnapshot
        : await quotaGuard.getUsageSnapshot();
    const flags = snap.flags || {};

    const routerCtx = {
        requestedMode: mode,
        complexityNorm,
        documentMetadata,
        executionMode,
    };

    if (agentRole === AGENT_ROLES.evaluation) {
        const out = {
            selectedModel: null,
            fallbackModel: null,
            reason: 'evaluation_agent_no_llm',
            costTier: 'none',
            isPreview: false,
            agentRole,
            fromDbRule: false,
        };
        logRouterDecision(out, {
            mode, stage: 'evaluation', flags, traceId, documentId, agentRole,
        });
        return out;
    }

    if (agentRole === AGENT_ROLES.evidence) {
        const emb = await routeModel({
            stage: 'embedding',
            requestedMode: mode,
            documentMetadata,
            complexityScore: input.complexityScore,
            quotaSnapshot: snap,
            adminOverrides,
            traceId,
            documentId,
            agentRole,
        });
        return {
            ...emb,
            agentRole,
            fromDbRule: false,
            reason: emb.reason === 'embedding_stage_only' ? 'evidence_agent_embedding' : emb.reason,
        };
    }

    const fallbackStage = AGENT_TO_ROUTER_STAGE[agentRole] || 'pipeline';

    if (mode === 'manual' && adminOverrides.model) {
        const base = await routeModel({
            stage: fallbackStage,
            requestedMode: 'manual',
            documentMetadata,
            complexityScore: input.complexityScore,
            quotaSnapshot: snap,
            adminOverrides,
            traceId,
            documentId,
            agentRole,
        });
        return { ...base, agentRole, fromDbRule: false };
    }

    const manualOverride = await pickMatchingManualOverride({
        agentRole,
        stage: fallbackStage,
        documentId,
        routerCtx,
    });
    if (manualOverride) {
        const mid = String(manualOverride.api_model_id || '').trim();
        const phase = budgetPhaseForCandidate(mid);
        const guardCheck = await quotaGuard.canUseModelForStage(mid, phase);
        let selected = mid;
        let reason = `manual_override_${manualOverride.id}`;
        if (!guardCheck.allowed) {
            const fallbackList = dedupe([
                guardCheck.suggestedModel,
                quotaGuard.getFallbackModel(phase),
                config.LLM_MODEL,
                config.SUMMARY_CHEAP_MODEL,
            ].filter(Boolean));
            const sug = await pickFirstPassingCandidate(fallbackList, flags, adminOverrides);
            selected = sug || config.LLM_MODEL || 'gemini-2.5-flash';
            reason = `${reason}_guard_${guardCheck.reason || 'adjusted'}`;
        }
        const fallbackModel = pickNextFallback(selected, [mid, config.LLM_MODEL, config.SUMMARY_CHEAP_MODEL].filter(Boolean));
        const out = {
            selectedModel: selected,
            fallbackModel: fallbackModel || selected,
            reason,
            costTier: costTierFromModelId(selected),
            isPreview: await isPreviewModel(selected),
            agentRole,
            fromDbRule: false,
            fromManualOverride: true,
            manualOverrideId: manualOverride.id,
        };
        logRouterDecision(out, {
            mode,
            stage: fallbackStage,
            flags,
            traceId,
            documentId,
            agentRole,
            metrics: { complexity_norm: complexityNorm, manual_override_id: manualOverride.id },
        });
        return out;
    }

    const rules = await loadRoutingRulesForAgent(agentRole);
    let matchedActions = null;
    let fromDbRule = false;
    for (const rule of rules) {
        const cond = rule.conditions && typeof rule.conditions === 'object'
            ? rule.conditions
            : {};
        if (matchRoutingRuleConditions(routerCtx, cond)) {
            matchedActions = rule.actions && typeof rule.actions === 'object' ? rule.actions : {};
            fromDbRule = true;
            break;
        }
    }

    if (matchedActions && Object.keys(matchedActions).length > 0) {
        let candidates = buildCandidateIdsFromRuleActions(routerCtx, matchedActions);
        candidates = await filterPreviewCandidates(candidates, flags, adminOverrides);
        if (candidates.length === 0) {
            candidates = buildCandidateIdsFromRuleActions(routerCtx, matchedActions);
        }

        if (candidates.length === 0) {
            const legacyEmpty = await routeModel({
                stage: fallbackStage,
                requestedMode: mode,
                documentMetadata,
                complexityScore: input.complexityScore,
                quotaSnapshot: snap,
                adminOverrides,
                traceId,
                documentId,
                agentRole,
            });
            return { ...legacyEmpty, agentRole, fromDbRule: false };
        }

        let selected = null;
        let reason = 'db_rule_ordered_pick';
        for (const id of candidates) {
            const phase = budgetPhaseForCandidate(id);
            const { allowed } = await quotaGuard.canUseModelForStage(id, phase);
            if (allowed) {
                selected = id;
                break;
            }
        }
        if (!selected) {
            selected = quotaGuard.getFallbackModel('standard_generation');
            reason = 'db_rule_no_candidate_passed_budget_guard';
        }
        const rpdOk = await quotaGuard.getAvailableModel(selected);
        if (rpdOk && rpdOk !== selected) {
            reason = `${reason}_rpd_fallback`;
            selected = rpdOk;
        }
        const fallbackModel = pickNextFallback(selected, candidates)
            || quotaGuard.getFallbackModel(budgetPhaseForCandidate(selected));
        const out = {
            selectedModel: selected,
            fallbackModel: fallbackModel || selected,
            reason,
            costTier: costTierFromModelId(selected),
            isPreview: await isPreviewModel(selected),
            agentRole,
            fromDbRule,
        };
        logRouterDecision(out, {
            mode,
            stage: fallbackStage,
            flags,
            traceId,
            documentId,
            agentRole,
            metrics: { complexity_norm: complexityNorm },
        });
        return out;
    }

    const legacy = await routeModel({
        stage: fallbackStage,
        requestedMode: mode,
        documentMetadata,
        complexityScore: input.complexityScore,
        quotaSnapshot: snap,
        adminOverrides,
        traceId,
        documentId,
        agentRole,
    });
    return { ...legacy, agentRole, fromDbRule: false };
}

module.exports = {
    routeModel,
    routeModelForAgent,
    emitRouterDecisionToPipeline,
    invalidateRoutingRulesCache,
    invalidateRoutingConfigCache,
    invalidateManualOverridesCache,
    normalizeComplexity,
    costTierFromModelId,
    budgetPhaseForCandidate,
    isHeavyStage,
    canUseModelForStage: quotaGuard.canUseModelForStage,
    getFallbackModel: quotaGuard.getFallbackModel,
    getUsageSnapshot: quotaGuard.getUsageSnapshot,
};
