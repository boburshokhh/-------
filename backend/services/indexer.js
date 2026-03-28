const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const chunkRepo = require('../db/repositories/chunkRepo');
const { chunkText } = require('./chunker');
const { extractJSON } = require('./validator');
const runtimeConfig = require('./runtimeConfig');
const quotaGuard = require('./quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry, withTimeout } = require('./geminiError');
const jobProgressSvc = require('./jobProgress');
const { WEIGHT } = jobProgressSvc;

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

const EMBED_BATCH_SIZE = config.EMBED_BATCH_SIZE || 5;
const EMBED_CONCURRENCY = config.EMBED_CONCURRENCY || 2;

function hashText(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchEmbeddingWithRetry(text, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const embedModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';
            await quotaGuard.assertWithinFreeTierQuota(embedModel);
            const ai = await getAiClient();
            const response = await ai.models.embedContent({
                model: embedModel,
                contents: text,
            });
            await quotaGuard.recordGeminiCall(embedModel);
            const emb = Array.isArray(response.embeddings)
                ? response.embeddings[0].values
                : response.embeddings.values || response.embedding.values;
            return emb;
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const parsed = parseGeminiApiError(err);
            if (parsed.isResourceExhausted) {
                await quotaGuard.syncFromGoogle429(config.EMBEDDING_MODEL || 'gemini-embedding-001', err);
            }
            console.warn(`[INDEXER] Эмбеддинг попытка ${attempt}/${retries}: ${err.message}`);
            if (parsed.isDailyFreeTierQuota) break;
            if (attempt < retries) await sleepForGeminiRetry(parsed, attempt, retries, sleep);
        }
    }
    throw lastError;
}

async function fetchChunkSummary(chunkTextStr, retries = 3) {
    try {
        await quotaGuard.waitUntilQuotaAllows(config.LLM_MODEL);
    } catch (e) {
        if (e.type === 'QUOTA_EXCEEDED') {
            console.warn(`[INDEXER] Summary пропущен (лимит free tier): ${e.message}`);
            return [];
        }
        throw e;
    }

    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 0;
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const ai = await getAiClient();
            const genPromise = ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: `Прочитай следующий фрагмент учебного материала и выдели из него 5–10 конкретных фактов, определений, правил или ключевых утверждений. Оформи каждый факт как отдельный пункт списка (одна строка). Не пересказывай, а вычленяй именно проверяемые знания.\n\nФрагмент:\n${chunkTextStr}\n\nВерни только JSON объект вида {"facts": ["факт 1","факт 2",...]}. Никакого другого текста.`,
                config: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                },
            });
            const response = await withTimeout(genPromise, reqTimeout, '[INDEXER] Summary generateContent');
            await quotaGuard.recordGeminiCall(config.LLM_MODEL);
            const raw = response.text;
            if (!raw) throw new Error('Пустой ответ при генерации summary');
            const parsed = extractJSON(raw);
            if (parsed && Array.isArray(parsed.facts) && parsed.facts.length > 0) {
                return parsed.facts;
            }
            if (Array.isArray(parsed)) return parsed;
            throw new Error('Неожиданный формат summary');
        } catch (err) {
            lastError = err;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) {
                await quotaGuard.syncFromGoogle429(config.LLM_MODEL, err);
            }
            console.warn(`[INDEXER] Summary попытка ${attempt}/${retries}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < retries) await sleepForGeminiRetry(g, attempt, retries, sleep);
        }
    }
    console.error(`[INDEXER] Summary не получен: ${lastError.message}`);
    return [];
}

async function processBatch(batch) {
    const results = [];
    for (let i = 0; i < batch.length; i += EMBED_CONCURRENCY) {
        const slice = batch.slice(i, i + EMBED_CONCURRENCY);
        const settled = await Promise.allSettled(
            slice.map(async (item) => {
                const embedding = await fetchEmbeddingWithRetry(item.text);
                return { ...item, embedding };
            })
        );
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                console.error(`[INDEXER] Ошибка батч-эмбеддинга: ${result.reason.message}`);
                results.push({ id: null, embedding: null });
            }
        }
        if (i + EMBED_CONCURRENCY < batch.length) await sleep(300);
    }
    return results;
}

async function indexDocument(documentId, fullText, onProgress, opts = {}) {
    const baseWorkDone = Math.max(0, Math.floor(Number(opts.baseWorkDone) || 0));
    const startTime = Date.now();
    const rawChunks = chunkText(fullText);

    if (rawChunks.length === 0) {
        throw new Error('Нет чанков для индексации');
    }

    console.log(`[INDEXER] Документ #${documentId}: ${rawChunks.length} чанков`);

    const { genUnits, estMainBatches } = jobProgressSvc.estimateGenerationTailUnits(config);
    const embeddingModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';

    const existingRows = await chunkRepo.getChunkHashesByDocumentId(documentId);
    const existingHashes = new Map();
    for (const row of existingRows) {
        existingHashes.set(row.content_hash, row.id);
    }

    const indexedChunks = [];
    const newChunks = [];

    for (const raw of rawChunks) {
        const hash = hashText(raw.text);
        if (existingHashes.has(hash)) {
            const chunkId = existingHashes.get(hash);
            indexedChunks.push({
                id: chunkId,
                document_id: documentId,
                chunk_index: raw.index,
                text: raw.text,
                token_count: raw.tokens,
                content_hash: hash,
                cached: true,
            });
        } else {
            newChunks.push({ ...raw, content_hash: hash });
        }
    }

    console.log(`[INDEXER] Кэш: ${indexedChunks.length} чанков уже есть, ${newChunks.length} новых`);

    const indexW = jobProgressSvc.indexWorkloadUnits(newChunks.length, EMBED_BATCH_SIZE);
    const workTotal = baseWorkDone + indexW + genUnits;

    if (newChunks.length === 0) {
        onProgress?.({
            phase: 'index',
            stage: 'cache_hit',
            workTotal,
            planEstMainBatches: estMainBatches,
            workDelta: WEIGHT.INDEX_SPLIT + WEIGHT.INDEX_CACHE_HIT,
            detail: `Индекс из кэша: ${indexedChunks.length} фрагментов, новых нет`,
        });
        return chunkRepo.loadIndexedChunks(documentId);
    }

    onProgress?.({
        phase: 'index',
        stage: 'split',
        workTotal,
        planEstMainBatches: estMainBatches,
        workDelta: WEIGHT.INDEX_SPLIT,
        detail: `Разбиение: ${rawChunks.length} фрагментов (${newChunks.length} новых), полный объём работ: ${workTotal} ед.`,
    });

    const insertedChunks = await chunkRepo.insertChunks(documentId, newChunks);

    onProgress?.({
        phase: 'index',
        stage: 'chunks_saved',
        detail: `Сохранено ${newChunks.length} новых фрагментов в БД`,
    });

    const batches = [];
    for (let i = 0; i < insertedChunks.length; i += EMBED_BATCH_SIZE) {
        batches.push(insertedChunks.slice(i, i + EMBED_BATCH_SIZE));
    }

    const chunksWithEmbeddings = [];
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        console.log(`[INDEXER] Эмбеддинги батч ${bIdx + 1}/${batches.length}...`);
        const processed = await processBatch(batches[bIdx]);
        chunksWithEmbeddings.push(...processed);
        onProgress?.({
            phase: 'index',
            stage: 'embeddings',
            workDelta: WEIGHT.INDEX_EMBED_BATCH,
            detail: `Векторные эмбеддинги: батч ${bIdx + 1}/${batches.length}`,
        });
        if (bIdx < batches.length - 1) await sleep(500);
    }

    await chunkRepo.insertEmbeddings(chunksWithEmbeddings, embeddingModel);

    console.log(`[INDEXER] Генерация summary для ${insertedChunks.length} чанков...`);
    onProgress?.({
        phase: 'index',
        stage: 'summaries',
        detail: `Краткие выжимки по фрагментам: 0/${insertedChunks.length}`,
    });

    for (let i = 0; i < insertedChunks.length; i++) {
        const c = insertedChunks[i];
        console.log(`[INDEXER] Summary ${i + 1}/${insertedChunks.length}...`);
        const facts = await fetchChunkSummary(c.text);
        if (facts.length > 0) {
            await chunkRepo.insertSummary(c.id, facts);
        }
        onProgress?.({
            phase: 'index',
            stage: 'summaries',
            workDelta: WEIGHT.INDEX_SUMMARY,
            detail: `Краткие выжимки: ${i + 1}/${insertedChunks.length}`,
        });
        /* Пауза между чанками: основной pacing — waitUntilQuotaAllows в fetchChunkSummary */
        if (i < insertedChunks.length - 1) await sleep(200);
    }

    onProgress?.({
        phase: 'index',
        stage: 'indexed',
        workDelta: WEIGHT.INDEX_TAIL,
        detail: 'Индексация завершена, загрузка чанков в память',
    });

    const elapsed = Date.now() - startTime;
    console.log(`[INDEXER] Индексация завершена за ${(elapsed / 1000).toFixed(1)}s`);

    return chunkRepo.loadIndexedChunks(documentId);
}

module.exports = { indexDocument, loadIndexedChunks: chunkRepo.loadIndexedChunks, hasIndex: chunkRepo.hasIndex };
