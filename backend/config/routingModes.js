'use strict';

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

const MAX_QUALITY_LLM_CHAIN = Object.freeze([
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-pro-latest',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
]);

const MAX_QUALITY_EMBEDDING_CHAIN = Object.freeze([
    'gemini-embedding-2',
    'gemini-embedding-001',
]);

function isMaxQualityMode(mode) {
    return String(mode || '').toLowerCase().trim() === MAX_QUALITY_MODE;
}

module.exports = {
    MAX_QUALITY_MODE,
    BUILT_IN_ROUTING_MODES,
    SYSTEM_ROUTING_MODES,
    MAX_QUALITY_LLM_CHAIN,
    MAX_QUALITY_EMBEDDING_CHAIN,
    isMaxQualityMode,
};
