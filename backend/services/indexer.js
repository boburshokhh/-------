const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const db = require('../db/database');
const { chunkText } = require('./chunker');
const { extractJSON } = require('./validator');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const EMBED_BATCH_SIZE = config.EMBED_BATCH_SIZE || 5;
const EMBED_CONCURRENCY = config.EMBED_CONCURRENCY || 2;

/**
 * SHA-256 хэш текста — используется для кэша эмбеддингов
 */
function hashText(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Экспоненциальный backoff
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Получает эмбеддинг для одного текста с retry/backoff
 */
async function fetchEmbeddingWithRetry(text, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await ai.models.embedContent({
                model: config.EMBEDDING_MODEL || 'text-embedding-004',
                contents: text,
            });
            // Нормализуем ответ SDK: может вернуть .embeddings[] или .embeddings.values
            const emb = Array.isArray(response.embeddings)
                ? response.embeddings[0].values
                : response.embeddings.values || response.embedding.values;
            return emb;
        } catch (err) {
            lastError = err;
            console.warn(`[INDEXER] Эмбеддинг попытка ${attempt}/${retries}: ${err.message}`);
            if (attempt < retries) await sleep(1000 * Math.pow(2, attempt - 1));
        }
    }
    throw lastError;
}

/**
 * Получает LLM-резюме для одного чанка (5–10 ключевых фактов)
 */
async function fetchChunkSummary(chunkText, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: `Прочитай следующий фрагмент учебного материала и выдели из него 5–10 конкретных фактов, определений, правил или ключевых утверждений. Оформи каждый факт как отдельный пункт списка (одна строка). Не пересказывай, а вычленяй именно проверяемые знания.\n\nФрагмент:\n${chunkText}\n\nВерни только JSON объект вида {"facts": ["факт 1","факт 2",...]}. Никакого другого текста.`,
                config: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                },
            });
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
            console.warn(`[INDEXER] Summary попытка ${attempt}/${retries}: ${err.message}`);
            if (attempt < retries) await sleep(1000 * Math.pow(2, attempt - 1));
        }
    }
    console.error(`[INDEXER] Summary не получен: ${lastError.message}`);
    return [];
}

/**
 * Обрабатывает батч чанков параллельно с ограничением параллелизма
 */
async function processBatch(batch, embeddingModel) {
    const results = [];
    // Батчим с ограничением параллелизма
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
                results.push({ ...result.reason, embedding: null });
            }
        }
        // Пауза между батчами
        if (i + EMBED_CONCURRENCY < batch.length) await sleep(300);
    }
    return results;
}

/**
 * Индексирует документ: чанки → хэши → эмбеддинги → summary → SQLite
 * Пропускает уже проиндексированные чанки по content_hash.
 *
 * @param {number} documentId - ID документа в БД
 * @param {string} fullText - Полный текст документа
 * @returns {Promise<Array<{id, document_id, chunk_index, text, token_count, content_hash}>>}
 */
async function indexDocument(documentId, fullText) {
    const startTime = Date.now();
    const rawChunks = chunkText(fullText);

    if (rawChunks.length === 0) {
        throw new Error('Нет чанков для индексации');
    }

    console.log(`[INDEXER] Документ #${documentId}: ${rawChunks.length} чанков`);

    const embeddingModel = config.EMBEDDING_MODEL || 'text-embedding-004';

    // Загружаем уже существующие хэши для этого документа (кэш)
    const existingHashes = new Map();
    const existingRows = db.prepare(
        'SELECT id, content_hash FROM document_chunks WHERE document_id = ?'
    ).all(documentId);
    for (const row of existingRows) {
        existingHashes.set(row.content_hash, row.id);
    }

    // Стейтменты для вставки
    const insertChunk = db.prepare(`
        INSERT INTO document_chunks (document_id, chunk_index, text, token_count, content_hash)
        VALUES (?, ?, ?, ?, ?)
    `);
    const insertEmbedding = db.prepare(`
        INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding_model, embedding, dims)
        VALUES (?, ?, ?, ?)
    `);
    const insertSummary = db.prepare(`
        INSERT OR REPLACE INTO chunk_summaries (chunk_id, summary_text)
        VALUES (?, ?)
    `);

    const indexedChunks = [];
    const newChunks = [];

    // Проверяем кэш — что уже есть, что нужно индексировать
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

    if (newChunks.length === 0) {
        // Все чанки уже в индексе
        const allChunkIds = indexedChunks.map(c => c.id);
        return loadIndexedChunks(documentId);
    }

    // Сохраняем новые чанки в БД
    const insertedChunks = [];
    const insertAllChunks = db.transaction(() => {
        for (const c of newChunks) {
            const result = insertChunk.run(documentId, c.index, c.text, c.tokens, c.content_hash);
            insertedChunks.push({ ...c, id: result.lastInsertRowid });
        }
    });
    insertAllChunks();

    // Батчевые эмбеддинги для новых чанков
    const batches = [];
    for (let i = 0; i < insertedChunks.length; i += EMBED_BATCH_SIZE) {
        batches.push(insertedChunks.slice(i, i + EMBED_BATCH_SIZE));
    }

    const chunksWithEmbeddings = [];
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        console.log(`[INDEXER] Эмбеддинги батч ${bIdx + 1}/${batches.length}...`);
        const processed = await processBatch(batches[bIdx], embeddingModel);
        chunksWithEmbeddings.push(...processed);
        if (bIdx < batches.length - 1) await sleep(500);
    }

    // Сохраняем эмбеддинги в БД
    const saveEmbeddings = db.transaction(() => {
        for (const c of chunksWithEmbeddings) {
            if (!c.embedding) continue;
            const embJson = JSON.stringify(c.embedding);
            insertEmbedding.run(c.id, embeddingModel, embJson, c.embedding.length);
        }
    });
    saveEmbeddings();

    // Summary — для каждого нового чанка
    console.log(`[INDEXER] Генерация summary для ${insertedChunks.length} чанков...`);
    for (let i = 0; i < insertedChunks.length; i++) {
        const c = insertedChunks[i];
        console.log(`[INDEXER] Summary ${i + 1}/${insertedChunks.length}...`);
        const facts = await fetchChunkSummary(c.text);
        if (facts.length > 0) {
            insertSummary.run(c.id, JSON.stringify(facts));
        }
        if (i < insertedChunks.length - 1) await sleep(800);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[INDEXER] Индексация завершена за ${(elapsed / 1000).toFixed(1)}s`);

    return loadIndexedChunks(documentId);
}

/**
 * Загружает все проиндексированные чанки документа с эмбеддингами и summary
 */
function loadIndexedChunks(documentId) {
    const rows = db.prepare(`
        SELECT
            dc.id,
            dc.document_id,
            dc.chunk_index,
            dc.text,
            dc.token_count,
            dc.content_hash,
            ce.embedding,
            ce.embedding_model,
            cs.summary_text
        FROM document_chunks dc
        LEFT JOIN chunk_embeddings ce ON ce.chunk_id = dc.id
            AND ce.embedding_model = ?
        LEFT JOIN chunk_summaries cs ON cs.chunk_id = dc.id
        WHERE dc.document_id = ?
        ORDER BY dc.chunk_index ASC
    `).all(config.EMBEDDING_MODEL || 'text-embedding-004', documentId);

    return rows.map(row => ({
        id: Number(row.id),
        document_id: Number(row.document_id),
        chunk_index: row.chunk_index,
        text: row.text,
        token_count: row.token_count,
        content_hash: row.content_hash,
        embedding: row.embedding ? JSON.parse(row.embedding) : null,
        summary: row.summary_text ? JSON.parse(row.summary_text) : [],
    }));
}

/**
 * Проверяет, есть ли уже индекс для документа
 */
function hasIndex(documentId) {
    const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM document_chunks WHERE document_id = ?'
    ).get(documentId);
    return row.cnt > 0;
}

module.exports = { indexDocument, loadIndexedChunks, hasIndex };
