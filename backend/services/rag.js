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

// ─── Извлечение тем (через summaries чанков) ──────────────────────────────

/**
 * Пытается определить заголовок раздела из первых строк чанка.
 * Ищет строки, похожие на заголовок: короткие, без завершающей пунктуации,
 * написанные заглавными буквами или начинающиеся с номера/ключевого слова.
 */
function detectSectionHint(text) {
    const lines = text.split('\n').slice(0, 6);
    for (const line of lines) {
        const t = line.trim();
        if (t.length < 4 || t.length > 90) continue;
        if (/[.,:;]$/.test(t)) continue;
        if (
            t === t.toUpperCase() ||
            /^[0-9]+[.\s]/.test(t) ||
            /^(Глава|Раздел|Тема|Chapter|Section|Part|Unit)\b/i.test(t)
        ) return t;
    }
    return null;
}

/**
 * Строит текстовый дайджест из summaries всех чанков.
 * Если у чанка нет summary — берём начало его текста.
 * Включает подсказку о разделе (если удалось определить).
 *
 * @param {Array}  indexedChunks
 * @param {string} fullText       - Fallback если indexedChunks пуст
 * @param {number} maxTotalChars  - Лимит символов на весь дайджест
 */
function buildSummaryDigest(indexedChunks, fullText, maxTotalChars = 14000) {
    if (!indexedChunks || indexedChunks.length === 0) {
        const third = Math.floor(fullText.length / 3);
        return [
            fullText.slice(0, 3000),
            '...',
            fullText.slice(third, third + 3000),
            '...',
            fullText.slice(-3000),
        ].join('\n');
    }

    const blocks = [];
    let totalChars = 0;

    for (const chunk of indexedChunks) {
        const hasSummary = Array.isArray(chunk.summary) && chunk.summary.length > 0;
        const sectionHint = detectSectionHint(chunk.text);
        const header = sectionHint
            ? `=== Чанк ${chunk.chunk_index + 1} [${sectionHint}] ===`
            : `=== Чанк ${chunk.chunk_index + 1} ===`;

        let content;
        if (hasSummary) {
            content = chunk.summary.map(f => `• ${f}`).join('\n');
        } else {
            content = chunk.text.slice(0, 400);
        }

        const block = `${header}\n${content}`;
        if (totalChars + block.length > maxTotalChars) break;
        blocks.push(block);
        totalChars += block.length;
    }

    return blocks.join('\n\n');
}

/**
 * Оценивает целевое число тем по размеру документа.
 */
function estimateThemeCount(indexedChunks, fullText) {
    if (indexedChunks && indexedChunks.length > 0) {
        let factsCount = 0;
        for (const chunk of indexedChunks) {
            if (Array.isArray(chunk.summary)) {
                factsCount += chunk.summary.length;
            }
        }
        // Адаптивный пол по числу фактов: 1 тема на ~4 факта
        const themesByFacts = factsCount > 0 ? Math.max(1, Math.ceil(factsCount / 4)) : 1;
        
        const baseThemes = Math.ceil(indexedChunks.length / 2);
        // Не требуем 5 тем, если контента мало
        const adaptiveMin = Math.min(5, themesByFacts);
        
        return Math.min(14, Math.max(adaptiveMin, Math.min(baseThemes, themesByFacts)));
    }
    const lenBasedMin = Math.max(1, Math.floor(fullText.length / 5000));
    return Math.min(8, Math.max(Math.min(5, lenBasedMin), Math.floor(fullText.length / 3000)));
}

/**
 * Извлекает rich-темы документа на основе summaries ВСЕХ чанков.
 * Каждая тема содержит: topic, section, importance, suggestedCount, difficultyCandidates.
 *
 * @param {Array}  indexedChunks - Проиндексированные чанки (с полем summary)
 * @param {string} fullText      - Полный текст (fallback если нет чанков)
 * @param {string} [model]
 * @param {number} [targetCount] - Целевое число вопросов (опционально)
 * @returns {Promise<Array<{topic,section,importance,suggestedCount,difficultyCandidates}>>}
 */
async function extractThemes(indexedChunks, fullText, model = null, targetCount = null) {
    const llmModel = model || config.LLM_MODEL;
    const digest = buildSummaryDigest(indexedChunks, fullText);
    
    // Если передан budget, ограничиваем число тем, чтобы на каждую приходилось хотя бы ~2-3 вопроса
    const targetThemes = targetCount 
        ? Math.max(1, Math.min(10, Math.ceil(targetCount / 2)))
        : estimateThemeCount(indexedChunks, fullText);

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: llmModel,
                contents: `Ты анализируешь учебный материал. На основе фактов из ВСЕХ чанков документа выдели ровно ${targetThemes} ключевых тем, охватывающих документ РАВНОМЕРНО — не только самые заметные части.\n\nДля каждой темы укажи:\n- topic: конкретное название темы\n- section: название раздела или главы (выводи из заголовка чанка, иначе "Раздел N")\n- importance: важность 1–3 (3 = самая важная)\n- suggestedCount: рекомендуемое число вопросов (2–5)\n- difficultyCandidates: массив из 1–3 значений Bloom Taxonomy: "remember", "understand", "apply", "analyze"\n  - remember: факты, определения, даты\n  - understand: объяснение процессов, концепций\n  - apply: применение знаний к ситуациям\n  - analyze: сравнение, причинно-следственные связи\n\nМатериал (факты по чанкам):\n${digest}\n\nВерни JSON массив из ${targetThemes} объектов. Никакого другого текста:\n[{"topic":"...","section":"...","importance":2,"suggestedCount":3,"difficultyCandidates":["understand","apply"]},...]`,
                config: {
                    temperature: 0.2,
                    responseMimeType: 'application/json',
                },
            });

            const parsed = extractJSON(response.text);
            let themes = Array.isArray(parsed) ? parsed
                : (parsed.themes && Array.isArray(parsed.themes) ? parsed.themes : null);

            // Bloom taxonomy levels + backward compat mapping
            const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];
            const OLD_TO_BLOOM = { easy: 'remember', medium: 'understand', hard: 'analyze' };

            if (themes && themes.length > 0) {
                themes = themes.map((t, i) => {
                    let candidates = Array.isArray(t.difficultyCandidates) && t.difficultyCandidates.length > 0
                        ? t.difficultyCandidates
                        : ['understand'];
                    // Маппинг старых значений к Bloom
                    candidates = candidates.map(d => OLD_TO_BLOOM[d] || d).filter(d => BLOOM_LEVELS.includes(d));
                    if (candidates.length === 0) candidates = ['understand'];

                    return {
                        topic: (t.topic || t.name || String(t)).trim(),
                        section: (t.section || `Раздел ${i + 1}`).trim(),
                        importance: Math.min(3, Math.max(1, Number(t.importance) || 2)),
                        suggestedCount: Math.min(5, Math.max(2, Number(t.suggestedCount) || 3)),
                        difficultyCandidates: candidates,
                    };
                });
                console.log(`[RAG] extractThemes: ${themes.length} тем из ${indexedChunks ? indexedChunks.length : 0} чанков (Bloom taxonomy)`);
                return themes;
            }
            throw new Error('Пустой список тем');
        } catch (err) {
            lastError = err;
            console.warn(`[RAG] extractThemes попытка ${attempt}/3: ${err.message}`);
            if (attempt < 3) await sleep(1000 * attempt);
        }
    }

    console.error('[RAG] extractThemes не удался:', lastError.message);
    return [{ topic: 'Основные концепции документа', section: 'Документ', importance: 2, suggestedCount: 3, difficultyCandidates: ['understand'] }];
}

// ─── Blueprint (планировщик вопросов) ─────────────────────────────────────

/**
 * Пропорционально распределяет целевое число intents по темам
 * с учётом importance и suggestedCount каждой темы.
 *
 * @param {Array}  richThemes  - Массив rich-тем
 * @param {number} totalTarget - Общее желаемое число intents
 * @returns {number[]}         - Число intents для каждой темы
 */
function computeIntentsPerTheme(richThemes, totalTarget) {
    const weights = richThemes.map(t => (t.importance || 2) * (t.suggestedCount || 3));
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    const counts = weights.map(w => Math.max(2, Math.round((w / totalWeight) * totalTarget)));

    // Корректируем сумму до totalTarget
    let diff = counts.reduce((s, n) => s + n, 0) - totalTarget;
    let idx = 0;
    while (diff > 0) {
        if (counts[idx % counts.length] > 2) { counts[idx % counts.length]--; diff--; }
        idx++;
    }
    idx = 0;
    while (diff < 0) {
        counts[idx % counts.length]++;
        diff++;
        idx++;
    }

    return counts;
}

/**
 * Для каждой темы создаёт список question intents (только multiple_choice).
 * Принимает как rich-объекты ({topic,section,...}), так и строки (fallback).
 *
 * @param {Array}  themes     - Rich-темы или строки
 * @param {number} targetMin
 * @param {number} targetMax
 * @param {string} [model]
 * @returns {Promise<Array<{theme,section,intent,type}>>}
 */
async function buildQuestionBlueprint(themes, targetMin, targetMax, model = null) {
    const llmModel = model || config.LLM_MODEL;

    // Нормализуем: принимаем строки (старый формат) и rich-объекты
    const richThemes = themes.map(t => typeof t === 'string'
        ? { topic: t, section: 'Документ', importance: 2, suggestedCount: 3, difficultyCandidates: ['understand'] }
        : t
    );

    const totalTarget = Math.round((targetMin + targetMax) / 2);
    const perTheme = computeIntentsPerTheme(richThemes, totalTarget);
    const expectedCount = perTheme.reduce((s, n) => s + n, 0);

    const themesForPrompt = richThemes.map((t, i) =>
        `${i + 1}. [${t.section}] ${t.topic} → ${perTheme[i]} вопросов`
    ).join('\n');

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: llmModel,
                contents: `Ты создаёшь план проверочного теста. Все вопросы — формата multiple_choice (4 варианта, 1 правильный).\n\nДля каждой темы придумай РОВНО указанное число конкретных «намерений вопроса» (question intent) — что именно нужно проверить (1–2 предложения).\n\nТемы (формат: N. [Раздел] Тема → кол-во вопросов):\n${themesForPrompt}\n\nВерни JSON массив ровно из ${expectedCount} объектов:\n[\n  {"theme":"...","section":"...","intent":"...","type":"multiple_choice"},\n  ...\n]\nНикакого другого текста.`,
                config: {
                    temperature: 0.3,
                    responseMimeType: 'application/json',
                },
            });

            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed
                : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

            if (list && list.length > 0) {
                // Принудительно ставим type = multiple_choice для всех
                const normalized = list.map(item => ({ ...item, type: 'multiple_choice' }));

                if (normalized.length < Math.floor(expectedCount * 0.8)) {
                    console.warn(`[RAG] buildBlueprint: LLM вернул ${normalized.length} intents, ожидалось ${expectedCount}, попытка ${attempt}/3`);
                    throw new Error(`Слишком мало intents: ${normalized.length} < ${expectedCount}`);
                }
                return normalized;
            }
            throw new Error('Пустой blueprint');
        } catch (err) {
            lastError = err;
            console.warn(`[RAG] buildBlueprint попытка ${attempt}/3: ${err.message}`);
            if (attempt < 3) await sleep(1000 * attempt);
        }
    }

    // Fallback: генерируем вручную (только multiple_choice)
    console.error('[RAG] buildBlueprint не удался, используем fallback');
    const fallback = [];
    for (let ti = 0; ti < richThemes.length; ti++) {
        const t = richThemes[ti];
        for (let i = 0; i < perTheme[ti]; i++) {
            fallback.push({
                theme: t.topic,
                section: t.section,
                intent: `Проверить понимание: ${t.topic}`,
                type: 'multiple_choice',
            });
        }
    }
    return fallback;
}

// ─── Evidence packet ───────────────────────────────────────────────────────

/**
 * Формирует evidence packets из retrieved чанков.
 * Каждый пакет содержит: chunk_id, facts (summary), text, page, section.
 *
 * @param {Array}  chunks       - Чанки из retrieval
 * @param {string} _intent      - Зарезервировано (не используется)
 * @param {object} opts
 * @param {number} opts.maxTextChars - Лимит символов текста чанка (default 800)
 * @returns {Array<{chunk_id, facts, text, page, section}>}
 */
function buildEvidencePackets(chunks, _intent, opts = {}) {
    const { maxTextChars = 800 } = opts;

    return chunks.map(chunk => {
        const facts = Array.isArray(chunk.summary) && chunk.summary.length > 0
            ? chunk.summary
            : [];

        const text = chunk.text.length > maxTextChars
            ? chunk.text.slice(0, maxTextChars) + '…'
            : chunk.text;

        return {
            chunk_id: chunk.id,
            facts,
            text,
            page: chunk.page ?? null,
            section: chunk.section ?? null,
        };
    });
}

/**
 * Форматирует evidence packets в текст для промпта.
 * Включает факты (summary), полный текст чанка, страницу и раздел.
 */
function formatEvidenceForPrompt(packets) {
    return packets.map((p, i) => {
        const metaParts = [`chunk_id=${p.chunk_id}`];
        if (p.page != null) metaParts.push(`стр. ${p.page}`);
        if (p.section) metaParts.push(`раздел: "${p.section}"`);

        const parts = [`[Источник ${i + 1}, ${metaParts.join(' | ')}]`];

        if (p.facts.length > 0) {
            parts.push(`Факты:\n${p.facts.map(f => `  • ${f}`).join('\n')}`);
        }

        parts.push(`Текст:\n${p.text}`);

        return parts.join('\n');
    }).join('\n\n');
}

// ─── Coverage map ──────────────────────────────────────────────────────────

/**
 * Создаёт карту покрытия: показывает, какие чанки и разделы уже задействованы.
 *
 * @param {Array} indexedChunks
 * @returns {{ totalChunks, usedChunkIds: Set, bySection: object }}
 */
function buildCoverageMap(indexedChunks) {
    const map = {
        totalChunks: indexedChunks.length,
        usedChunkIds: new Set(),
        bySection: {},
    };

    for (const chunk of indexedChunks) {
        const sec = chunk.section || 'Документ';
        if (!map.bySection[sec]) {
            map.bySection[sec] = { chunkIds: [], usedIds: new Set() };
        }
        map.bySection[sec].chunkIds.push(chunk.id);
    }

    return map;
}

/**
 * Помечает chunk IDs как использованные в карте покрытия.
 *
 * @param {object}   coverageMap - Объект, созданный buildCoverageMap
 * @param {number[]} chunkIds    - ID чанков, задействованных в последнем retrieval
 */
function updateCoverageMap(coverageMap, chunkIds) {
    for (const id of chunkIds) {
        coverageMap.usedChunkIds.add(id);
        for (const data of Object.values(coverageMap.bySection)) {
            if (data.chunkIds.includes(id)) {
                data.usedIds.add(id);
                break;
            }
        }
    }
}

/**
 * Возвращает строку-отчёт о покрытии документа.
 *
 * @param {object} coverageMap
 * @returns {string}
 */
function formatCoverageReport(coverageMap) {
    const used = coverageMap.usedChunkIds.size;
    const total = coverageMap.totalChunks;
    const pct = total > 0 ? Math.round(used / total * 100) : 0;

    const sections = Object.entries(coverageMap.bySection).map(([sec, data]) => {
        const sp = data.chunkIds.length > 0
            ? Math.round(data.usedIds.size / data.chunkIds.length * 100)
            : 0;
        return `"${sec}": ${data.usedIds.size}/${data.chunkIds.length} (${sp}%)`;
    }).join(', ');

    return `${used}/${total} чанков (${pct}%) | ${sections}`;
}

module.exports = {
    hybridRetrieve,
    extractThemes,
    buildQuestionBlueprint,
    buildEvidencePackets,
    formatEvidenceForPrompt,
    buildCoverageMap,
    updateCoverageMap,
    formatCoverageReport,
    cosineSimilarity,
    getQueryEmbedding,
};
