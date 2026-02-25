const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { extractJSON } = require('./validator');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ─── Векторные утилиты ──────────────────────────────────────────────────────

/**
 * Косинусное сходство двух векторов
 */
function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Получает эмбеддинг для одной строки-запроса с retry
 */
async function getQueryEmbedding(query, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await ai.models.embedContent({
                model: config.EMBEDDING_MODEL || 'text-embedding-004',
                contents: query,
            });
            return Array.isArray(response.embeddings)
                ? response.embeddings[0].values
                : response.embeddings.values || response.embedding.values;
        } catch (err) {
            lastError = err;
            if (attempt < retries) await sleep(800 * attempt);
        }
    }
    throw lastError;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── MMR (Maximal Marginal Relevance) ──────────────────────────────────────

/**
 * Выбирает K разнообразных кандидатов по MMR.
 *
 * @param {number[]} queryVec     - Вектор запроса
 * @param {Array}    candidates   - Массив {embedding, ...}
 * @param {number}   k            - Сколько выбрать
 * @param {number}   lambda       - 0 = max diversity, 1 = max relevance
 * @param {number}   threshold    - Минимальное сходство с запросом
 * @returns {Array} выбранные кандидаты
 */
function mmrSelect(queryVec, candidates, k, lambda = 0.65, threshold = 0.0) {
    // Фильтруем чанки без эмбеддингов
    const valid = candidates.filter(c => Array.isArray(c.embedding) && c.embedding.length > 0);
    if (valid.length === 0) return candidates.slice(0, k);

    // Считаем сходство с запросом для всех кандидатов
    const withScore = valid.map(c => ({
        ...c,
        queryScore: cosineSimilarity(queryVec, c.embedding),
    }));

    // Порог: убираем нерелевантных (если порог > 0)
    const aboveThreshold = threshold > 0
        ? withScore.filter(c => c.queryScore >= threshold)
        : withScore;

    // Fallback: если после порога ничего не осталось — берём лучший
    const pool = aboveThreshold.length > 0 ? aboveThreshold : withScore;

    const selected = [];
    const remaining = [...pool];

    while (selected.length < k && remaining.length > 0) {
        if (selected.length === 0) {
            // Первый — просто самый релевантный
            const best = remaining.reduce((a, b) => (a.queryScore > b.queryScore ? a : b));
            selected.push(best);
            remaining.splice(remaining.indexOf(best), 1);
        } else {
            // MMR: максимизируем λ*rel - (1-λ)*max_sim_to_selected
            let bestScore = -Infinity;
            let bestIdx = 0;
            for (let i = 0; i < remaining.length; i++) {
                const cand = remaining[i];
                const maxSim = selected.reduce(
                    (mx, s) => Math.max(mx, cosineSimilarity(cand.embedding, s.embedding)),
                    0
                );
                const mmrScore = lambda * cand.queryScore - (1 - lambda) * maxSim;
                if (mmrScore > bestScore) {
                    bestScore = mmrScore;
                    bestIdx = i;
                }
            }
            selected.push(remaining[bestIdx]);
            remaining.splice(bestIdx, 1);
        }
    }

    return selected;
}

// ─── Гибридный retrieval ───────────────────────────────────────────────────

/**
 * BM25-подобный лексический скор (упрощённый TF-IDF approximation).
 * Работает без внешних зависимостей на основе нормализованного кол-ва совпадающих слов.
 */
function lexicalScore(query, text) {
    const queryWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const textLower = text.toLowerCase();
    let hits = 0;
    for (const w of queryWords) {
        // Считаем вхождения каждого слова
        const re = new RegExp(`\\b${w}\\b`, 'g');
        const matches = textLower.match(re);
        if (matches) hits += Math.log(1 + matches.length);
    }
    return queryWords.size > 0 ? hits / queryWords.size : 0;
}

/**
 * Гибридный retrieval: векторный (cosine) + лексический (BM25-lite) + MMR
 *
 * @param {string}  query          - Текстовый запрос (тема/intent)
 * @param {Array}   indexedChunks  - Чанки с полями embedding и text
 * @param {number}  k              - Сколько итоговых чанков вернуть
 * @param {object}  opts           - {topN, wVec, wLex, lambda, threshold}
 * @returns {Promise<Array>}
 */
async function hybridRetrieve(query, indexedChunks, k, opts = {}) {
    const {
        topN = Math.max(k * 3, 12),
        wVec = 0.75,
        wLex = 0.25,
        lambda = config.MMR_LAMBDA || 0.65,
        threshold = config.RAG_THRESHOLD || 0.0,
    } = opts;

    const queryVec = await getQueryEmbedding(query);

    // Скорим все чанки
    const scored = indexedChunks.map(c => {
        const vecSim = Array.isArray(c.embedding) ? cosineSimilarity(queryVec, c.embedding) : 0;
        const lexSim = lexicalScore(query, c.text);
        return {
            ...c,
            vectorScore: vecSim,
            lexScore: lexSim,
            hybridScore: wVec * vecSim + wLex * lexSim,
        };
    });

    // Берём topN кандидатов по гибридному скору
    scored.sort((a, b) => b.hybridScore - a.hybridScore);
    const candidates = scored.slice(0, topN);

    // MMR для разнообразия
    const selected = mmrSelect(queryVec, candidates, k, lambda, threshold);

    // Fallback: если ничего не нашли — соседние чанки по chunk_index
    if (selected.length === 0) {
        return indexedChunks.slice(0, k);
    }

    // Сортируем финал по оригинальному порядку в документе для связности
    selected.sort((a, b) => a.chunk_index - b.chunk_index);

    return selected;
}

// ─── Извлечение тем ────────────────────────────────────────────────────────

/**
 * Извлекает ключевые темы из ПОЛНОГО текста документа
 * (не только начало — делаем репрезентативную выборку)
 */
async function extractThemes(fullText, numThemes = null) {
    const target = numThemes || Math.min(8, Math.max(5, Math.floor(fullText.length / 3000)));

    // Берём начало, середину и конец документа для покрытия всего материала
    const third = Math.floor(fullText.length / 3);
    const sampleStart = fullText.slice(0, 3000);
    const sampleMid = fullText.slice(third, third + 3000);
    const sampleEnd = fullText.slice(-3000);
    const sample = `${sampleStart}\n...\n${sampleMid}\n...\n${sampleEnd}`;

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: `Проанализируй следующие фрагменты учебного материала (начало, середина, конец документа) и выдели из них ${target} ключевых тем или концепций, которые РАВНОМЕРНО ОХВАТЫВАЮТ весь материал. Каждая тема должна быть конкретной и достаточно специфичной, чтобы по ней можно было задать 2–5 проверочных вопросов.\n\nФрагменты:\n${sample}\n\nВерни JSON массив строк (названия тем). Никакого другого текста.`,
                config: {
                    temperature: 0.2,
                    responseMimeType: 'application/json',
                },
            });

            const parsed = extractJSON(response.text);
            // Принимаем массив или объект {themes:[...]}
            let themes = Array.isArray(parsed) ? parsed
                : (parsed.themes && Array.isArray(parsed.themes) ? parsed.themes : null);

            if (themes && themes.length > 0) return themes;
            throw new Error('Пустой список тем');
        } catch (err) {
            lastError = err;
            console.warn(`[RAG] extractThemes попытка ${attempt}/3: ${err.message}`);
            if (attempt < 3) await sleep(1000 * attempt);
        }
    }

    console.error('[RAG] extractThemes не удался:', lastError.message);
    return ['Основные концепции документа'];
}

// ─── Blueprint (планировщик вопросов) ─────────────────────────────────────

/**
 * Для каждой темы создаёт список question intents (подтем) + тип вопроса.
 * Масштабирует общее количество intents под TARGET_QUESTIONS_MIN/MAX.
 *
 * @param {string[]} themes
 * @param {number}   targetMin
 * @param {number}   targetMax
 * @returns {Promise<Array<{theme, intent, type}>>}
 */
async function buildQuestionBlueprint(themes, targetMin, targetMax) {
    const totalIntents = Math.round((targetMin + targetMax) / 2);
    const intentsPerTheme = Math.max(2, Math.round(totalIntents / themes.length));
    const expectedCount = themes.length * intentsPerTheme;

    const TYPES = ['multiple_choice', 'multiple_choice', 'true_false', 'open_ended'];

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: `Ты создаёшь план проверочного теста. Для каждой из ${themes.length} тем придумай ровно ${intentsPerTheme} конкретных «намерений вопроса» (question intent) — короткое описание того, ЧТО именно нужно проверить (1–2 предложения). Также назначь тип вопроса для каждого intent (распределяй равномерно: multiple_choice чаще остальных).\n\nТемы:\n${themes.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nВерни JSON массив ровно из ${expectedCount} объектов (ни больше, ни меньше):\n[\n  {"theme": "...", "intent": "...", "type": "multiple_choice|true_false|open_ended"},\n  ...\n]\nНикакого другого текста.`,
                config: {
                    temperature: 0.3,
                    responseMimeType: 'application/json',
                },
            });

            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed
                : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

            if (list && list.length > 0) {
                if (list.length < expectedCount) {
                    console.warn(`[RAG] buildBlueprint: LLM вернул ${list.length} intents, ожидалось ${expectedCount}, попытка ${attempt}/3`);
                    throw new Error(`Слишком мало intents: ${list.length} < ${expectedCount}`);
                }
                return list;
            }
            throw new Error('Пустой blueprint');
        } catch (err) {
            lastError = err;
            console.warn(`[RAG] buildBlueprint попытка ${attempt}/3: ${err.message}`);
            if (attempt < 3) await sleep(1000 * attempt);
        }
    }

    // Fallback: генерируем blueprint вручную
    console.error('[RAG] buildBlueprint не удался, используем fallback');
    const fallback = [];
    for (const theme of themes) {
        for (let i = 0; i < intentsPerTheme; i++) {
            fallback.push({
                theme,
                intent: `Проверить понимание: ${theme}`,
                type: TYPES[fallback.length % TYPES.length],
            });
        }
    }
    return fallback;
}

// ─── Evidence packet (контекстная компрессия) ──────────────────────────────

/**
 * Формирует evidence packet из retrieved чанков:
 * - Использует pre-computed summary (факты) если есть
 * - Иначе fallback на краткое сырое начало чанка
 *
 * @param {Array}  chunks         - Чанки из retrieval (с полем summary)
 * @param {string} intent         - Текст intent (для фокусировки)
 * @returns {Array<{chunk_id, facts, quote}>}
 */
function buildEvidencePackets(chunks, intent) {
    return chunks.map(chunk => {
        const facts = Array.isArray(chunk.summary) && chunk.summary.length > 0
            ? chunk.summary
            : [];

        // Короткая цитата — до 300 символов из наиболее релевантной части
        const quote = extractShortQuote(chunk.text, intent, 300);

        return {
            chunk_id: chunk.id,
            facts,
            quote,
        };
    });
}

/**
 * Извлекает короткую цитату из текста, содержащую слова intent
 */
function extractShortQuote(text, query, maxLen = 300) {
    const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const sentences = text.split(/[.!?]\s+/);
    let bestSentence = '';
    let bestScore = -1;

    for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        let score = 0;
        for (const w of words) {
            if (lower.includes(w)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestSentence = sentence.trim();
        }
    }

    if (!bestSentence) {
        bestSentence = text.slice(0, maxLen);
    }

    return bestSentence.length > maxLen
        ? bestSentence.slice(0, maxLen) + '...'
        : bestSentence;
}

/**
 * Форматирует evidence packets в текст для промпта — минимальные токены
 */
function formatEvidenceForPrompt(packets) {
    return packets.map((p, i) => {
        const factsStr = p.facts.length > 0
            ? p.facts.map(f => `  • ${f}`).join('\n')
            : `  • ${p.quote}`;
        return `[Источник ${i + 1}, chunk_id=${p.chunk_id}]\n${factsStr}`;
    }).join('\n\n');
}

module.exports = {
    hybridRetrieve,
    extractThemes,
    buildQuestionBlueprint,
    buildEvidencePackets,
    formatEvidenceForPrompt,
    cosineSimilarity,
    getQueryEmbedding,
};
