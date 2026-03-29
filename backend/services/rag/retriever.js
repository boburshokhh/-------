const { GoogleGenAI } = require('@google/genai');
const config = require('../../config');
const runtimeConfig = require('../runtimeConfig');
const quotaGuard = require('../quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry } = require('../geminiError');
const { cosineSimilarity } = require('../nlp/similarity');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

async function getQueryEmbedding(query, retries = 3) {
    const embedModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(embedModel);
            const ai = await getAiClient();
            const response = await ai.models.embedContent({
                model: embedModel,
                contents: query,
            });
            await quotaGuard.recordGeminiCall(embedModel);
            return Array.isArray(response.embeddings)
                ? response.embeddings[0].values
                : response.embeddings.values || response.embedding.values;
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const parsed = parseGeminiApiError(err);
            if (parsed.isResourceExhausted) {
                await quotaGuard.syncFromGoogle429(embedModel, err);
            }
            if (parsed.isDailyFreeTierQuota) break;
            if (attempt < retries) await sleepForGeminiRetry(parsed, attempt, retries, sleep);
        }
    }
    throw lastError;
}

async function getBatchEmbeddings(texts, retries = 3) {
    if (!texts || texts.length === 0) return [];
    const embeddings = [];

    // Обрабатываем последовательно мелкими батчами, чтобы не упереться в лимиты API
    const chunkSize = 5;
    for (let i = 0; i < texts.length; i += chunkSize) {
        const batch = texts.slice(i, i + chunkSize);
        const promises = batch.map(text => getQueryEmbedding(text, retries));
        const batchResults = await Promise.all(promises);
        embeddings.push(...batchResults);
    }

    return embeddings;
}

function mmrSelect(queryVec, candidates, k, lambda = 0.65, threshold = 0.0) {
    const valid = candidates.filter(c => Array.isArray(c.embedding) && c.embedding.length > 0);
    if (valid.length === 0) return candidates.slice(0, k);
    const withScore = valid.map(c => ({ ...c, queryScore: cosineSimilarity(queryVec, c.embedding) }));
    const aboveThreshold = threshold > 0 ? withScore.filter(c => c.queryScore >= threshold) : withScore;
    const pool = aboveThreshold.length > 0 ? aboveThreshold : withScore;
    const selected = [];
    const remaining = [...pool];

    while (selected.length < k && remaining.length > 0) {
        if (selected.length === 0) {
            const best = remaining.reduce((a, b) => (a.queryScore > b.queryScore ? a : b));
            selected.push(best);
            remaining.splice(remaining.indexOf(best), 1);
        } else {
            let bestScore = -Infinity;
            let bestIdx = 0;
            for (let i = 0; i < remaining.length; i++) {
                const cand = remaining[i];
                const maxSim = selected.reduce(
                    (mx, s) => Math.max(mx, cosineSimilarity(cand.embedding, s.embedding)), 0
                );
                const mmrScore = lambda * cand.queryScore - (1 - lambda) * maxSim;
                if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
            }
            selected.push(remaining[bestIdx]);
            remaining.splice(bestIdx, 1);
        }
    }
    return selected;
}

function lexicalScore(query, text) {
    const queryWords = new Set(query.toLowerCase().split(/\\W+/).filter(w => w.length > 2));
    const textLower = text.toLowerCase();
    let hits = 0;
    for (const w of queryWords) {
        const re = new RegExp(`\\b${w}\\b`, 'g');
        const matches = textLower.match(re);
        if (matches) hits += Math.log(1 + matches.length);
    }
    return queryWords.size > 0 ? hits / queryWords.size : 0;
}

async function hybridRetrieve(query, indexedChunks, k, opts = {}) {
    const {
        topN = Math.max(k * 3, 12),
        wVec = 0.75,
        wLex = 0.25,
        lambda = config.MMR_LAMBDA || 0.65,
        threshold = config.RAG_THRESHOLD || 0.0,
    } = opts;

    const queryVec = await getQueryEmbedding(query);
    const scored = indexedChunks.map(c => {
        const vecSim = Array.isArray(c.embedding) ? cosineSimilarity(queryVec, c.embedding) : 0;
        const lexSim = lexicalScore(query, c.text);
        return { ...c, vectorScore: vecSim, lexScore: lexSim, hybridScore: wVec * vecSim + wLex * lexSim };
    });
    scored.sort((a, b) => b.hybridScore - a.hybridScore);
    const candidates = scored.slice(0, topN);
    const selected = mmrSelect(queryVec, candidates, k, lambda, threshold);
    if (selected.length === 0) return indexedChunks.slice(0, k);
    selected.sort((a, b) => a.chunk_index - b.chunk_index);
    return selected;
}

module.exports = {
    getQueryEmbedding,
    getBatchEmbeddings,
    hybridRetrieve,
    mmrSelect,
    lexicalScore
};
