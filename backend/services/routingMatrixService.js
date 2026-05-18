'use strict';

/**
 * Агрегат для Admin UI «Роли и этапы»: configured rules + effective preview (dry-run).
 */

const quotaGuard = require('./quotaGuard');
const routingEngine = require('./routingEngine');
const aiRoutingRulesRepo = require('../db/repositories/aiRoutingRulesRepo');
const aiRoutingDecisionsRepo = require('../db/repositories/aiRoutingDecisionsRepo');
const aiStageCatalogRepo = require('../db/repositories/aiStageCatalogRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const aiRoutingConfigRepo = require('../db/repositories/aiRoutingConfigRepo');
const { STAGE_KEYS, STAGE_TO_AGENT_ROLE, STAGE_CATALOG } = require('../config/stageTaxonomy');
const { BUILT_IN_ROUTING_MODES } = require('../config/routingModes');

const MATRIX_STAGE_KEYS = [
    STAGE_KEYS.embedding,
    STAGE_KEYS.cheap_preprocess,
    STAGE_KEYS.blueprint_generation,
    STAGE_KEYS.question_generation,
    STAGE_KEYS.grounding_validation,
    STAGE_KEYS.backfill_generation,
];

const VALID_PREVIEW = new Set(BUILT_IN_ROUTING_MODES);

function normalizePreviewMode(raw) {
    const m = String(raw || 'auto').toLowerCase().trim();
    return VALID_PREVIEW.has(m) ? m : 'auto';
}

function pickRuleForStage(allRules, stageKey, agentRole) {
    const candidates = allRules.filter(
        (r) => r.is_enabled
            && (r.stage_key === stageKey || r.phase === stageKey || r.phase === agentRole),
    );
    candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id);
    return candidates[0] || null;
}

function mapConfiguredRule(rule) {
    if (!rule) {
        return {
            rule_id: null,
            priority: 0,
            primary_api_model_id: null,
            fallback_api_model_ids: [],
            allow_premium: false,
            allow_preview: false,
            stable_only: true,
            max_escalation_depth: 1,
            conditions: {},
        };
    }
    const actions = rule.actions || {};
    return {
        rule_id: rule.id,
        priority: rule.priority ?? 0,
        primary_api_model_id: actions.primary_api_model_id || null,
        fallback_api_model_ids: Array.isArray(actions.fallback_api_model_ids)
            ? actions.fallback_api_model_ids
            : [],
        allow_premium: rule.allow_premium ?? (actions.allow_premium === true),
        allow_preview: !!rule.allow_preview,
        stable_only: rule.stable_only !== false,
        max_escalation_depth: rule.max_escalation_depth ?? 1,
        conditions: rule.conditions || {},
    };
}

function mapEffectivePreview(decision) {
    if (!decision) {
        return {
            effective_api_model_id: null,
            fallback_chain_resolved: [],
            cost_tier: null,
            premium_blocked: false,
            preview_blocked: false,
            decision_source: 'unknown',
            reason: '',
            explain: [],
        };
    }
    const explain = [];
    if (decision.fromDbRule) explain.push('Сработало правило из БД');
    if (decision.decisionSource) explain.push(`Источник: ${decision.decisionSource}`);
    if (decision.wasFallback) explain.push('Использован fallback-кандидат');
    return {
        effective_api_model_id: decision.selectedModel || null,
        fallback_chain_resolved: Array.isArray(decision.fallbackChain) ? decision.fallbackChain : [],
        cost_tier: decision.costTier || null,
        premium_blocked: !!decision.premiumBlocked,
        preview_blocked: !!decision.previewBlocked,
        decision_source: decision.decisionSource || 'engine',
        reason: decision.reason || '',
        explain,
    };
}

/**
 * @param {object} opts
 * @param {string} [opts.previewMode] — auto|economy|balanced|quality|max_quality|manual
 * @param {boolean} [opts.includeLastDecision]
 */
async function getRoutingMatrix({ previewMode = 'auto', includeLastDecision = true } = {}) {
    const modeNorm = normalizePreviewMode(previewMode);

    const [policies, baseConfig, quotaSnap, allRules, stages] = await Promise.all([
        aiGlobalPoliciesRepo.getPolicies().catch(() => null),
        aiRoutingConfigRepo.getRoutingConfig().catch(() => null),
        quotaGuard.getUsageSnapshot().catch(() => ({ flags: {} })),
        aiRoutingRulesRepo.listRules({ enabledOnly: false }),
        aiStageCatalogRepo.listStages({ activeOnly: true }),
    ]);

    const stageMeta = Object.fromEntries((stages || []).map((s) => [s.stage_key, s]));

    const globalPolicies = policies
        ? {
            stable_only: !!policies.stable_only,
            premium_guard_enabled: policies.premium_guard_enabled !== false,
            emergency_downgrade: !!policies.emergency_downgrade,
            routing_mode: policies.routing_mode || 'auto',
        }
        : null;

    const routingModeBase = baseConfig?.routing_mode || globalPolicies?.routing_mode || 'auto';

    const rows = [];
    for (const stageKey of MATRIX_STAGE_KEYS) {
        const cat = stageMeta[stageKey] || STAGE_CATALOG[stageKey] || {};
        const agentRole = STAGE_TO_AGENT_ROLE[stageKey] || null;
        const rule = pickRuleForStage(allRules, stageKey, agentRole);

        let lastDecision = null;
        if (includeLastDecision) {
            lastDecision = await aiRoutingDecisionsRepo.getLatestDecisionByStage(stageKey);
        }

        let decision;
        try {
            decision = await routingEngine.selectModel({
                stageKey,
                agentRole,
                requestedMode: modeNorm,
                complexityScore: 0.4,
                documentMetadata: { page_count: 1 },
                quotaSnapshot: quotaSnap,
                traceId: 'admin-routing-matrix-preview',
                recordDecision: false,
            });
        } catch (e) {
            decision = null;
        }

        rows.push({
            stage_key: stageKey,
            agent_role: agentRole,
            catalog: {
                ui_label: cat.ui_label || stageKey,
                premium_eligible: cat.premium_eligible !== false,
                default_cost_tier: cat.default_cost_tier || 'standard',
            },
            configured: mapConfiguredRule(rule),
            effective_preview: mapEffectivePreview(decision),
            last_decision: lastDecision
                ? {
                    id: lastDecision.id,
                    created_at: lastDecision.created_at,
                    selected_api_model_id: lastDecision.selected_api_model_id,
                    decision_source: lastDecision.decision_source,
                }
                : null,
        });
    }

    return {
        ok: true,
        global_policies: globalPolicies,
        routing_mode_base: routingModeBase,
        preview_mode_requested: modeNorm,
        rows,
    };
}

module.exports = { getRoutingMatrix, MATRIX_STAGE_KEYS };
