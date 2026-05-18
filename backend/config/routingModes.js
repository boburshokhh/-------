'use strict';

const { STAGE_KEYS } = require('./stageTaxonomy');

const MAX_QUALITY_MODE = 'max_quality';

const BUILT_IN_ROUTING_MODES = Object.freeze([
    'auto',
    'economy',
    'balanced',
    'quality',
    MAX_QUALITY_MODE,
    'manual',
]);

const SYSTEM_ROUTING_MODES = Object.freeze(
    BUILT_IN_ROUTING_MODES.filter((mode) => mode !== 'auto'),
);

/** Топ-модели: план теста и формулировка вопросов — главный вклад в качество. */
const MAX_QUALITY_PREMIUM_CHAIN = Object.freeze([
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-pro-latest',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
]);

/** Сильные, но стабильные: дозаполнение, темы, факты. */
const MAX_QUALITY_STANDARD_CHAIN = Object.freeze([
    'gemini-2.5-pro',
    'gemini-pro-latest',
    'gemini-2.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash-lite',
]);

/** Быстрые задачи: препроцесс, простая валидация. */
const MAX_QUALITY_ECONOMY_CHAIN = Object.freeze([
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
]);

/** Grounding: стабильность важнее preview (меньше 503). */
const MAX_QUALITY_GROUNDING_CHAIN = Object.freeze([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-pro-latest',
    'gemini-3-pro-preview',
    'gemini-3.1-pro-preview',
]);

const MAX_QUALITY_EMBEDDING_CHAIN = Object.freeze([
    'gemini-embedding-2',
    'gemini-embedding-001',
]);

/** @deprecated Используйте getMaxQualityLlmChainForStage */
const MAX_QUALITY_LLM_CHAIN = MAX_QUALITY_PREMIUM_CHAIN;

const MAX_QUALITY_PREMIUM_STAGES = Object.freeze(new Set([
    STAGE_KEYS.blueprint_generation,
    STAGE_KEYS.question_generation,
]));

function isMaxQualityMode(mode) {
    return String(mode || '').toLowerCase().trim() === MAX_QUALITY_MODE;
}

function shouldBypassAppLimits(mode) {
    return isMaxQualityMode(mode);
}

/**
 * Цепочка LLM/embedding для стадии в режиме max_quality.
 * @param {string} stageKey — STAGE_KEYS.*
 */
function getMaxQualityLlmChainForStage(stageKey) {
    const key = String(stageKey || '').trim();
    if (key === STAGE_KEYS.embedding) return MAX_QUALITY_EMBEDDING_CHAIN;
    if (key === STAGE_KEYS.grounding_validation) return MAX_QUALITY_GROUNDING_CHAIN;
    if (key === STAGE_KEYS.cheap_preprocess) return MAX_QUALITY_ECONOMY_CHAIN;
    if (MAX_QUALITY_PREMIUM_STAGES.has(key)) return MAX_QUALITY_PREMIUM_CHAIN;
    if (key === STAGE_KEYS.backfill_generation) return MAX_QUALITY_STANDARD_CHAIN;
    return MAX_QUALITY_STANDARD_CHAIN;
}

function isMaxQualityPremiumStage(stageKey) {
    return MAX_QUALITY_PREMIUM_STAGES.has(String(stageKey || '').trim());
}

module.exports = {
    MAX_QUALITY_MODE,
    BUILT_IN_ROUTING_MODES,
    SYSTEM_ROUTING_MODES,
    MAX_QUALITY_PREMIUM_CHAIN,
    MAX_QUALITY_STANDARD_CHAIN,
    MAX_QUALITY_ECONOMY_CHAIN,
    MAX_QUALITY_GROUNDING_CHAIN,
    MAX_QUALITY_LLM_CHAIN,
    MAX_QUALITY_EMBEDDING_CHAIN,
    MAX_QUALITY_PREMIUM_STAGES,
    isMaxQualityMode,
    shouldBypassAppLimits,
    getMaxQualityLlmChainForStage,
    isMaxQualityPremiumStage,
};
