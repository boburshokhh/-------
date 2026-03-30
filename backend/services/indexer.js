const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const chunkRepo = require('../db/repositories/chunkRepo');
const { chunkText } = require('./chunker');
const { detectFactProfile, extractiveSummary } = require('./nlp/extractiveFacts');
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

// ─────────────────────────────────────────────────────────────────────────────
// LLM SUMMARISER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Строит промпт для LLM-извлечения фактов из батча чанков.
 */
function buildBatchFactExtractionPrompt(chunks) {
    const isTechnical = chunks.some(c => c.factProfile === 'technical_procedural' || c.factProfile === 'mixed');
    
    let instructions = isTechnical
        ? `Прочитай следующие ${chunks.length} фрагментов технической документации. Для каждого фрагмента извлеки конкретные единицы знания.\n
Типы знания: [procedural], [declarative], [warning], [troubleshooting], [parameter].
ПРАВИЛА:
1. Шаги процедуры = отдельные факты.
2. Предупреждения (ВНИМАНИЕ) = отдельные факты.
3. Числовые параметры = отдельные факты с единицами измерения.`
        : `Прочитай следующие ${chunks.length} фрагментов учебного/общего документа. Выдели из каждого фрагмента конкретные факты, определения, правила.`;

    let prompt = `${instructions}

Верни строго JSON массив объектов (по одному объекту на каждый переданный фрагмент). Формат:
[
  { "chunk_index": число (из заголовка), "facts": ["[procedural] факт...", "[warning] факт..."] },
  ...
]

Никакого другого текста, отвечай только JSON массивом.

=== ФРАГМЕНТЫ ===`;

    for (const c of chunks) {
        prompt += `\n\n--- Чанк (chunk_index: ${c.chunk_index}) ---\n${c.text}`;
    }
    return prompt;
}

/**
 * Обрабатывает пачку чанков одним LLM-вызовом. Возвращает массив результатов.
 */
async function fetchBatchSummaryLLM(chunks, modelId) {
    try {
        await quotaGuard.waitUntilQuotaAllows(modelId, { maxWaitMs: 0 });
    } catch (e) {
        if (e.type === 'QUOTA_EXCEEDED' && e.details?.limit === 'rpd') {
            console.warn(`[INDEXER] Batch Summary LLM пропущен (дневной лимит ${modelId}): ${e.message}`);
            return { parsedResults: [], quotaHit: true };
        }
    }

    const retries = config.LLM_MAX_RETRIES || 3;
    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 0;
    const prompt = buildBatchFactExtractionPrompt(chunks);
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.waitUntilQuotaAllows(modelId);
            const ai = await getAiClient();
            const genPromise = ai.models.generateContent({
                model: modelId,
                contents: prompt,
                config: { temperature: 0.1, responseMimeType: 'application/json' },
            });
            const response = await withTimeout(genPromise, reqTimeout, '[INDEXER] Batch Summary generateContent');
            await quotaGuard.recordGeminiCall(modelId);
            const raw = response.text;
            if (!raw) throw new Error('Пустой ответ при генерации batch summary');
            let parsed = extractJSON(raw);
            if (!Array.isArray(parsed)) {
                if (parsed && Array.isArray(parsed.results)) parsed = parsed.results;
                else throw new Error('Неожиданный формат ответа (ожидался массив)');
            }
            return { parsedResults: parsed, quotaHit: false };
        } catch (err) {
            lastError = err;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(modelId, err);
            console.warn(`[INDEXER] Batch Summary LLM (${modelId}) попытка ${attempt}/${retries}: ${err.message}`);
            if (g.isDailyFreeTierQuota) return { parsedResults: [], quotaHit: true };
            if (attempt < retries) await sleepForGeminiRetry(g, attempt, retries, sleep);
        }
    }
    console.error(`[INDEXER] Batch Summary LLM не получен (${modelId}): ${lastError?.message}`);
    return { parsedResults: [], quotaHit: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE ROUTER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Обрабатывает батч чанков, возвращая массив результатов summaries.
 */
async function processSummaryBatch(chunksMap) {
    const chunks = Object.values(chunksMap);
    const mode = (config.SUMMARY_MODE || 'extractive').toLowerCase();
    
    for (const c of chunks) {
        const det = detectFactProfile(c.text);
        c.factProfile = det.profile;
        c.signals = det.signals;
        if (c.signals.length > 0) console.log(`[INDEXER] chunk_${c.chunk_index} profile=${c.factProfile}`);
    }

    if (mode === 'none') {
        return chunks.map(c => {
            const extractive_facts = extractiveSummary(c.text, c.factProfile);
            return {
                id: c.id,
                facts: [],
                extractive_facts,
                source: 'none',
                status: extractive_facts.length > 0 ? 'ok' : 'empty',
                errorReason: null,
                factProfile: c.factProfile,
            };
        });
    }

    if (mode === 'extractive') {
        return chunks.map(c => {
            const facts = extractiveSummary(c.text, c.factProfile);
            return {
                id: c.id,
                facts,
                extractive_facts: facts,
                source: 'extractive',
                status: facts.length > 0 ? 'ok' : 'empty',
                errorReason: null,
                factProfile: c.factProfile,
            };
        });
    }

    const modelId = mode === 'llm' ? (config.LLM_MODEL || 'gemini-2.5-flash') : (config.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite');
    const sourceTag = mode === 'llm' ? 'llm' : 'cheap_llm';

    const fallbackToExtractive = (reason, status) => {
        return chunks.map(c => {
            const facts = extractiveSummary(c.text, c.factProfile);
            return {
                id: c.id,
                facts,
                extractive_facts: facts,
                source: 'extractive',
                status,
                errorReason: reason,
                factProfile: c.factProfile,
            };
        });
    };

    try {
        const { parsedResults, quotaHit } = await fetchBatchSummaryLLM(chunks, modelId);
        if (quotaHit) return fallbackToExtractive(`${modelId} daily RPD exhausted`, 'quota_skip');
        if (!parsedResults || parsedResults.length === 0) return fallbackToExtractive(`${modelId} response empty array`, 'error');

        const results = [];
        for (const c of chunks) {
            const extractive_facts = extractiveSummary(c.text, c.factProfile);
            const llmRes = parsedResults.find(r => String(r.chunk_index) === String(c.chunk_index));
            if (llmRes && Array.isArray(llmRes.facts) && llmRes.facts.length > 0) {
                results.push({
                    id: c.id,
                    facts: llmRes.facts,
                    extractive_facts,
                    source: sourceTag,
                    status: 'ok',
                    errorReason: null,
                    factProfile: c.factProfile,
                });
            } else {
                results.push({
                    id: c.id,
                    facts: extractive_facts,
                    extractive_facts,
                    source: 'extractive',
                    status: extractive_facts.length > 0 ? 'ok' : 'empty',
                    errorReason: 'LLM skipped in batch',
                    factProfile: c.factProfile,
                });
            }
        }
        return results;
    } catch (err) {
        console.error(`[INDEXER] processSummaryBatch error: ${err.message}`);
        return fallbackToExtractive(err.message, 'error');
    }
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

    // ── Summary stage ──────────────────────────────────────────────────────────
    const summaryMode = (config.SUMMARY_MODE || 'extractive').toLowerCase();
    const SUMMARY_BATCH_SIZE = config.LLM_SUMMARY_BATCH_SIZE || 6;
    
    console.log(`[INDEXER] Генерация summary для ${insertedChunks.length} чанков (mode=${summaryMode}, batch_size=${SUMMARY_BATCH_SIZE})...`);
    onProgress?.({
        phase: 'index',
        stage: 'summaries',
        detail: `Краткие выжимки по фрагментам: 0/${insertedChunks.length} (mode=${summaryMode})`,
    });

    let quotaExhaustedGlobal = false;
    let summaryOk = 0, summaryFallback = 0, summarySkipped = 0;
    const profileCounts = { declarative: 0, technical_procedural: 0, mixed: 0 };
    let totalFactsExtracted = 0;

    const summaryBatches = [];
    for (let i = 0; i < insertedChunks.length; i += SUMMARY_BATCH_SIZE) {
        summaryBatches.push(insertedChunks.slice(i, i + SUMMARY_BATCH_SIZE));
    }

    for (let b = 0; b < summaryBatches.length; b++) {
        const batchChunks = summaryBatches[b];
        console.log(`[INDEXER] Summary batch ${b + 1}/${summaryBatches.length} (${batchChunks.length} chunks)...`);

        let batchResults = [];
        if (quotaExhaustedGlobal && summaryMode !== 'extractive' && summaryMode !== 'none') {
            batchResults = batchChunks.map(c => {
                const det = detectFactProfile(c.text);
                const facts = extractiveSummary(c.text, det.profile);
                return {
                    id: c.id,
                    facts,
                    extractive_facts: facts,
                    source: 'extractive',
                    status: 'quota_skip',
                    errorReason: 'quota exhausted earlier',
                    factProfile: det.profile,
                };
            });
        } else {
            const chunksMap = {};
            for (const c of batchChunks) chunksMap[c.chunk_index] = c;
            batchResults = await processSummaryBatch(chunksMap);
            if (batchResults.some(r => r.status === 'quota_skip')) quotaExhaustedGlobal = true;
        }

        for (const res of batchResults) {
            if (res.factProfile) profileCounts[res.factProfile] = (profileCounts[res.factProfile] || 0) + 1;
            totalFactsExtracted += res.facts.length;

            await chunkRepo.insertSummary(
                res.id,
                res.facts,
                res.source,
                res.status,
                res.errorReason,
                res.extractive_facts
            );

            if (res.source === 'llm' || res.source === 'cheap_llm') summaryOk++;
            else if (res.status === 'quota_skip') summarySkipped++;
            else summaryFallback++;
        }

        const processedCount = Math.min((b + 1) * SUMMARY_BATCH_SIZE, insertedChunks.length);
        onProgress?.({
            phase: 'index',
            stage: 'summaries',
            workDelta: WEIGHT.INDEX_SUMMARY * batchChunks.length,
            detail: `Краткие выжимки: ${processedCount}/${insertedChunks.length} [llm=${summaryOk} ext=${summaryFallback} skip=${summarySkipped}]`,
        });

        if (!quotaExhaustedGlobal && summaryMode !== 'extractive' && summaryMode !== 'none') {
            if (b < summaryBatches.length - 1) await sleep(400); // Wait slightly between summary batches
        }
    }

    console.log(`[INDEXER] Summary завершён: llm=${summaryOk}, extractive=${summaryFallback}, quota_skip=${summarySkipped}`);
    console.log(`[INDEXER] Fact profiles: declarative=${profileCounts.declarative || 0}, technical_procedural=${profileCounts.technical_procedural || 0}, mixed=${profileCounts.mixed || 0}`);
    console.log(`[INDEXER] Total facts extracted: ${totalFactsExtracted} from ${insertedChunks.length} chunks`);

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
