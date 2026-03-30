'use strict';

/**
 * Unified Stage Taxonomy for the model selection pipeline.
 *
 * Resolves the three previously conflated concepts:
 *   - stage_key  — canonical pipeline step identifier (used everywhere)
 *   - agent_role — legacy agent id (kept for backward compat in ai_routing_rules)
 *   - usage_bucket — coarse cost category for budget guards
 */

const STAGE_KEYS = Object.freeze({
    embedding:              'embedding',
    cheap_preprocess:       'cheap_preprocess',
    facts_enrichment:       'facts_enrichment',
    theme_extraction:       'theme_extraction',
    blueprint_generation:   'blueprint_generation',
    question_generation:    'question_generation',
    grounding_validation:   'grounding_validation',
    backfill_generation:    'backfill_generation',
    audit_debug:            'audit_debug',
});

const ALL_STAGE_KEYS = Object.values(STAGE_KEYS);

const TASK_TYPES = Object.freeze({
    embedding:            'embedding',
    cheap_generation:     'cheap_generation',
    standard_generation:  'standard_generation',
    premium_reasoning:    'premium_reasoning',
    audit:                'audit',
});

const COST_TIERS = Object.freeze({
    economy:  'economy',
    standard: 'standard',
    premium:  'premium',
});

const STABILITY_CLASSES = Object.freeze({
    stable:       'stable',
    preview:      'preview',
    experimental: 'experimental',
});

/**
 * Full metadata per stage.
 * requires_llm — whether LLM call is needed.
 * task_type — which TASK_TYPES bucket this stage falls into.
 * default_cost_tier — cheapest acceptable tier.
 * premium_eligible — whether premium can ever be used.
 * capabilities — required model capability tags.
 * ui_label — human-readable label for admin panel.
 * ui_order — sort order in admin UI.
 */
const STAGE_CATALOG = Object.freeze({
    [STAGE_KEYS.embedding]: {
        key: STAGE_KEYS.embedding,
        ui_label: 'Embedding',
        ui_order: 1,
        requires_llm: false,
        task_type: TASK_TYPES.embedding,
        default_cost_tier: COST_TIERS.economy,
        premium_eligible: false,
        capabilities: ['supports_embedding'],
    },
    [STAGE_KEYS.cheap_preprocess]: {
        key: STAGE_KEYS.cheap_preprocess,
        ui_label: 'Cheap Preprocess (LLM summaries)',
        ui_order: 2,
        requires_llm: true,
        task_type: TASK_TYPES.cheap_generation,
        default_cost_tier: COST_TIERS.economy,
        premium_eligible: false,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.facts_enrichment]: {
        key: STAGE_KEYS.facts_enrichment,
        ui_label: 'Facts Enrichment',
        ui_order: 3,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: true,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.theme_extraction]: {
        key: STAGE_KEYS.theme_extraction,
        ui_label: 'Theme Extraction',
        ui_order: 4,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: true,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.blueprint_generation]: {
        key: STAGE_KEYS.blueprint_generation,
        ui_label: 'Blueprint Generation',
        ui_order: 5,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: true,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.question_generation]: {
        key: STAGE_KEYS.question_generation,
        ui_label: 'Question Generation',
        ui_order: 6,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: true,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.grounding_validation]: {
        key: STAGE_KEYS.grounding_validation,
        ui_label: 'Grounding / Validation',
        ui_order: 7,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: true,
        capabilities: ['supports_grounding'],
    },
    [STAGE_KEYS.backfill_generation]: {
        key: STAGE_KEYS.backfill_generation,
        ui_label: 'Backfill Generation',
        ui_order: 8,
        requires_llm: true,
        task_type: TASK_TYPES.standard_generation,
        default_cost_tier: COST_TIERS.economy,
        premium_eligible: false,
        capabilities: ['supports_fast_generation'],
    },
    [STAGE_KEYS.audit_debug]: {
        key: STAGE_KEYS.audit_debug,
        ui_label: 'Audit / Debug',
        ui_order: 9,
        requires_llm: true,
        task_type: TASK_TYPES.audit,
        default_cost_tier: COST_TIERS.standard,
        premium_eligible: false,
        capabilities: ['supports_fast_generation'],
    },
});

/**
 * Maps legacy agent roles to canonical stage keys.
 */
const AGENT_ROLE_TO_STAGE = Object.freeze({
    structuring_agent:  STAGE_KEYS.cheap_preprocess,
    evidence_agent:     STAGE_KEYS.embedding,
    blueprint_agent:    STAGE_KEYS.blueprint_generation,
    generator_agent:    STAGE_KEYS.question_generation,
    quality_agent:      STAGE_KEYS.grounding_validation,
    backfill_agent:     STAGE_KEYS.backfill_generation,
    evaluation_agent:   null,
});

const STAGE_TO_AGENT_ROLE = Object.freeze({
    [STAGE_KEYS.embedding]:             'evidence_agent',
    [STAGE_KEYS.cheap_preprocess]:      'structuring_agent',
    [STAGE_KEYS.facts_enrichment]:      null,
    [STAGE_KEYS.theme_extraction]:      null,
    [STAGE_KEYS.blueprint_generation]:  'blueprint_agent',
    [STAGE_KEYS.question_generation]:   'generator_agent',
    [STAGE_KEYS.grounding_validation]:  'quality_agent',
    [STAGE_KEYS.backfill_generation]:   'backfill_agent',
    [STAGE_KEYS.audit_debug]:           'evaluation_agent',
});

/**
 * Maps stage_key to the legacy budget bucket used by aiBudgetGuard.
 */
const STAGE_TO_USAGE_BUCKET = Object.freeze({
    [STAGE_KEYS.embedding]:             'embedding',
    [STAGE_KEYS.cheap_preprocess]:      'cheap_generation',
    [STAGE_KEYS.facts_enrichment]:      'standard_generation',
    [STAGE_KEYS.theme_extraction]:      'standard_generation',
    [STAGE_KEYS.blueprint_generation]:  'standard_generation',
    [STAGE_KEYS.question_generation]:   'standard_generation',
    [STAGE_KEYS.grounding_validation]:  'standard_generation',
    [STAGE_KEYS.backfill_generation]:   'standard_generation',
    [STAGE_KEYS.audit_debug]:           'standard_generation',
});

/**
 * Document size class thresholds (page count).
 */
const DOCUMENT_SIZE_THRESHOLDS = Object.freeze({
    tiny:   { max: 3 },
    small:  { max: 10 },
    medium: { max: 30 },
    large:  { max: 100 },
    huge:   { max: Infinity },
});

function classifyDocumentSize(pageCount) {
    const p = Number(pageCount) || 0;
    if (p <= DOCUMENT_SIZE_THRESHOLDS.tiny.max)   return 'tiny';
    if (p <= DOCUMENT_SIZE_THRESHOLDS.small.max)  return 'small';
    if (p <= DOCUMENT_SIZE_THRESHOLDS.medium.max) return 'medium';
    if (p <= DOCUMENT_SIZE_THRESHOLDS.large.max)  return 'large';
    return 'huge';
}

function isValidStageKey(key) {
    return typeof key === 'string' && ALL_STAGE_KEYS.includes(key);
}

function getStageMetadata(stageKey) {
    return STAGE_CATALOG[stageKey] || null;
}

function stageKeyFromAgentRole(agentRole) {
    return AGENT_ROLE_TO_STAGE[agentRole] || null;
}

function agentRoleFromStageKey(stageKey) {
    return STAGE_TO_AGENT_ROLE[stageKey] || null;
}

function usageBucketFromStageKey(stageKey) {
    return STAGE_TO_USAGE_BUCKET[stageKey] || 'standard_generation';
}

module.exports = {
    STAGE_KEYS,
    ALL_STAGE_KEYS,
    TASK_TYPES,
    COST_TIERS,
    STABILITY_CLASSES,
    STAGE_CATALOG,
    AGENT_ROLE_TO_STAGE,
    STAGE_TO_AGENT_ROLE,
    STAGE_TO_USAGE_BUCKET,
    DOCUMENT_SIZE_THRESHOLDS,
    classifyDocumentSize,
    isValidStageKey,
    getStageMetadata,
    stageKeyFromAgentRole,
    agentRoleFromStageKey,
    usageBucketFromStageKey,
};
