'use strict';

const { AGENT_ROLE_TO_STAGE, STAGE_KEYS } = require('./stageTaxonomy');

/**
 * Канонические id агентов пайплайна генерации тестов.
 * Поле phase в ai_routing_rules может содержать agent id (legacy) или stage_key (new).
 *
 * @readonly
 * @enum {string}
 */
const AGENT_ROLES = {
    structuring: 'structuring_agent',
    evidence: 'evidence_agent',
    blueprint: 'blueprint_agent',
    generator: 'generator_agent',
    quality: 'quality_agent',
    backfill: 'backfill_agent',
    evaluation: 'evaluation_agent',
};

/** Человекочитаемые подписи для логов и метрик */
const AGENT_LABELS = {
    [AGENT_ROLES.structuring]: 'Structuring',
    [AGENT_ROLES.evidence]: 'Evidence / retrieval',
    [AGENT_ROLES.blueprint]: 'Blueprint (themes + intents)',
    [AGENT_ROLES.generator]: 'Question generator',
    [AGENT_ROLES.quality]: 'Grounding + validation',
    [AGENT_ROLES.backfill]: 'Backfill',
    [AGENT_ROLES.evaluation]: 'Evaluation (metrics)',
};

/**
 * Legacy fallback stage for modelRouter.routeModel.
 * @deprecated Use AGENT_ROLE_TO_STAGE from stageTaxonomy.js instead.
 */
const AGENT_TO_ROUTER_STAGE = {
    [AGENT_ROLES.structuring]: 'pipeline',
    [AGENT_ROLES.evidence]: 'embedding',
    [AGENT_ROLES.blueprint]: 'blueprint',
    [AGENT_ROLES.generator]: 'generation',
    [AGENT_ROLES.quality]: 'grounding',
    [AGENT_ROLES.backfill]: 'backfill',
    [AGENT_ROLES.evaluation]: 'pipeline',
};

/**
 * Canonical stage_key for each agent role (new taxonomy).
 */
const AGENT_TO_STAGE_KEY = Object.freeze({ ...AGENT_ROLE_TO_STAGE });

const ALL_AGENT_IDS = Object.values(AGENT_ROLES);

/** Порядок резолвинга и записи в метрики / pipeline events */
const AGENT_RESOLUTION_ORDER = [
    AGENT_ROLES.structuring,
    AGENT_ROLES.evidence,
    AGENT_ROLES.blueprint,
    AGENT_ROLES.generator,
    AGENT_ROLES.quality,
    AGENT_ROLES.backfill,
    AGENT_ROLES.evaluation,
];

function isKnownAgentRole(id) {
    return typeof id === 'string' && ALL_AGENT_IDS.includes(id);
}

module.exports = {
    AGENT_ROLES,
    AGENT_LABELS,
    AGENT_TO_ROUTER_STAGE,
    AGENT_TO_STAGE_KEY,
    ALL_AGENT_IDS,
    AGENT_RESOLUTION_ORDER,
    isKnownAgentRole,
};
