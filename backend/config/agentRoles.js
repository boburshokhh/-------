'use strict';

/**
 * Канонические id агентов пайплайна генерации тестов.
 * Поле phase в ai_routing_rules = этому id (например phase = 'blueprint_agent').
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
 * Fallback stage для modelRouter.routeModel, если нет подходящего правила в БД.
 * @type {Record<string, string>}
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
    ALL_AGENT_IDS,
    AGENT_RESOLUTION_ORDER,
    isKnownAgentRole,
};
