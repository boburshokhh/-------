const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { extractJSON } = require('./validator');
const runtimeConfig = require('./runtimeConfig');
const quotaGuard = require('./quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry, withTimeout } = require('./geminiError');
const { getQueryEmbedding, getBatchEmbeddings, hybridRetrieve, mmrSelect, lexicalScore } = require('./rag/retriever');
const { detectSectionHint, resolveChunkEvidence, buildSummaryDigest, buildEvidencePackets, formatEvidenceForPrompt } = require('./rag/evidenceBuilder');
const { cosineSimilarity } = require('./nlp/similarity');

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

/**
 * После исчерпания повторов к Gemini — явная ошибка для API/UI (без молчаливого fallback).
 * @param {string} stepHuman
 * @param {unknown} lastError
 */
function throwAfterGeminiRetriesFailed(stepHuman, lastError) {
    console.error(`[RAG] ${stepHuman}: попытки исчерпаны`, lastError && lastError.message);
    if (lastError && lastError.type === 'QUOTA_EXCEEDED') {
        throw lastError;
    }
    if (!lastError) {
        const e = new Error('Не удалось связаться с моделью генерации. Повторите попытку позже.');
        e.type = 'LLM_ERROR';
        throw e;
    }
    const g = parseGeminiApiError(lastError);
    if (g.isDailyFreeTierQuota) {
        const e = new Error('Достигнут дневной лимит запросов к модели (UTC). Попробуйте завтра или укажите другой API-ключ в настройках.');
        e.type = 'QUOTA_EXCEEDED';
        e.details = lastError.message;
        throw e;
    }
    if (g.isTransientUnavailable) {
        const e = new Error('Выбранная модель временно перегружена или недоступна (Google). Подождите несколько минут или выберите другую модель, например gemini-2.5-flash.');
        e.type = 'LLM_ERROR';
        e.details = lastError.message;
        throw e;
    }
    if (g.isResourceExhausted) {
        const e = new Error('Превышен лимит запросов к API модели. Подождите около минуты и повторите попытку.');
        e.type = 'LLM_ERROR';
        e.details = lastError.message;
        throw e;
    }
    const e = new Error('Модель не вернула корректный ответ. Повторите попытку.');
    e.type = 'LLM_ERROR';
    e.details = lastError.message;
    throw e;
}

const { getQueryEmbedding, getBatchEmbeddings, hybridRetrieve, mmrSelect, lexicalScore } = require('./rag/retriever');
const { detectSectionHint, resolveChunkEvidence, buildSummaryDigest, buildEvidencePackets, formatEvidenceForPrompt } = require('./rag/evidenceBuilder');
const {
    estimateThemeCount, buildLocalThemesFromSections, buildThemesAndBlueprint, extractThemes,
    buildQuestionBlueprint, computeIntentsPerTheme, buildBlueprintFallbackLocal
} = require('./generation/blueprintService');
const { cosineSimilarity } = require('./nlp/similarity');


// Логика Blueprint вынесена в generation/blueprintService.js

function buildCoverageMap(indexedChunks) {
    const map = { totalChunks: indexedChunks.length, usedChunkIds: new Set(), bySection: {} };
    for (const chunk of indexedChunks) {
        const sec = chunk.section || 'Документ';
        if (!map.bySection[sec]) map.bySection[sec] = { chunkIds: [], usedIds: new Set() };
        map.bySection[sec].chunkIds.push(chunk.id);
    }
    return map;
}

function updateCoverageMap(coverageMap, chunkIds) {
    for (const id of chunkIds) {
        coverageMap.usedChunkIds.add(id);
        for (const data of Object.values(coverageMap.bySection)) {
            if (data.chunkIds.includes(id)) { data.usedIds.add(id); break; }
        }
    }
}

function formatCoverageReport(coverageMap) {
    const used = coverageMap.usedChunkIds.size;
    const total = coverageMap.totalChunks;
    const pct = total > 0 ? Math.round(used / total * 100) : 0;
    const sections = Object.entries(coverageMap.bySection).map(([sec, data]) => {
        const sp = data.chunkIds.length > 0 ? Math.round(data.usedIds.size / data.chunkIds.length * 100) : 0;
        return `"${sec}": ${data.usedIds.size}/${data.chunkIds.length} (${sp}%)`;
    }).join(', ');
    return `${used}/${total} чанков (${pct}%) | ${sections}`;
}

module.exports = {
    hybridRetrieve, extractThemes, buildQuestionBlueprint, buildThemesAndBlueprint, buildLocalThemesFromSections, buildBlueprintFallbackLocal, computeIntentsPerTheme,
    buildEvidencePackets, formatEvidenceForPrompt,
    buildCoverageMap, updateCoverageMap, formatCoverageReport,
    cosineSimilarity, getQueryEmbedding, getBatchEmbeddings,
    resolveChunkEvidence,
};
