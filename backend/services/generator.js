const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { chunkText } = require('./chunker');
const { validateQuestions, extractJSON } = require('./validator');
const rag = require('./rag');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ─── Bloom's Taxonomy difficulty levels ────────────────────────────────────
const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

// ─── Language Detection ────────────────────────────────────────────────────

/**
 * Определяет язык документа по первым N символам текста.
 * Ищет характерные паттерны кириллицы/латиницы и частотные слова.
 *
 * @param {string} text - Текст документа
 * @returns {string} - Код языка: 'ru', 'en', или 'auto'
 */
function detectLanguage(text) {
    const sample = text.slice(0, 3000);

    // Считаем кириллические и латинские символы
    const cyrillicCount = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
    const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;

    if (cyrillicCount > latinCount * 1.5) return 'ru';
    if (latinCount > cyrillicCount * 1.5) return 'en';

    // Проверка частотных слов
    const ruWords = ['и', 'в', 'на', 'что', 'это', 'для', 'не', 'по', 'как', 'из', 'при'];
    const enWords = ['the', 'and', 'is', 'in', 'to', 'of', 'for', 'with', 'that', 'on', 'are'];

    const lowerSample = sample.toLowerCase();
    const ruHits = ruWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;
    const enHits = enWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;

    if (ruHits > enHits) return 'ru';
    if (enHits > ruHits) return 'en';

    return 'auto'; // Не удалось определить — пусть LLM сам решит
}

/**
 * Возвращает языковую инструкцию для system prompt.
 * @param {string} lang - Код языка ('ru', 'en', 'auto')
 * @returns {string}
 */
function getLanguageInstruction(lang) {
    switch (lang) {
        case 'ru':
            return 'ЯЗЫК: Генерируй все вопросы, варианты ответов, объяснения и подсказки СТРОГО на русском языке.';
        case 'en':
            return 'LANGUAGE: Generate all questions, options, explanations and hints STRICTLY in English.';
        default:
            return 'ЯЗЫК / LANGUAGE: Определи язык evidence и генерируй вопросы на ТОМ ЖЕ языке, что и документ.';
    }
}

// ─── System prompts ────────────────────────────────────────────────────────

function getBatchSystemPrompt(lang = 'auto') {
    const langInstruction = getLanguageInstruction(lang);

    return `Ты — эксперт по генерации учебных тестов по документации.

Твоя задача: создать РОВНО ОДИН вопрос формата multiple_choice для каждого intent на основе предоставленного evidence.

${langInstruction}

ПРАВИЛА:
1. Каждый вопрос генерируй СТРОГО на основе evidence своего intent. НЕ ВЫДУМЫВАЙ факты вне evidence.
2. Каждый вопрос должен проверять полезное понимание документа.
3. Формат — ТОЛЬКО multiple_choice: ровно 4 варианта ответа, один правильный.
4. "correctIndex" — индекс правильного ответа (0–3).
5. Неверные варианты (дистракторы) должны быть ПРАВДОПОДОБНЫМИ, но ОДНОЗНАЧНО неверными. Не используй явно абсурдные варианты.
6. НЕ создавай два почти одинаковых вопроса — проверяй разные аспекты документа.
7. "hint" — подсказка в 1 предложение, которая направляет к ответу, но НЕ раскрывает его.
8. "explanation" — 1–2 предложения, объясняющих правильный ответ с опорой на evidence.
9. "difficulty" — уровень Bloom's Taxonomy из intent: "remember", "understand", "apply" или "analyze".
   - remember: вопрос на запоминание конкретного факта
   - understand: вопрос на понимание концепции/процесса
   - apply: вопрос на применение знания к ситуации
   - analyze: вопрос на сравнение, причинно-следственные связи, выводы
10. "sourceChunkId" — chunk_id из evidence этого вопроса (число).
11. Если evidence НЕДОСТАТОЧЕН для создания качественного вопроса (слишком общий, неконкретный, или нет фактов) — верни для этого intent объект: {"skipped": true, "reason": "краткое объяснение"}.

ФОРМАТ ОТВЕТА — строго JSON массив (столько объектов, сколько intents):
[
  {"type":"multiple_choice","question":"...?","options":["A","B","C","D"],"correctIndex":0,"explanation":"...","hint":"...","sourceChunkId":1,"difficulty":"understand"},
  {"skipped":true,"reason":"Evidence не содержит конкретных фактов для вопроса"}
]

ВАЖНО: Отвечай ТОЛЬКО JSON массивом. Никакого другого текста.`;
}

const GROUNDING_SYSTEM = `Ты проверяешь качество тестового вопроса формата multiple_choice.
Проверь:
1. correct_answer (correctIndex) полностью подтверждается evidence
2. explanation опирается на evidence
3. Все 4 варианта ответа логичны (дистракторы правдоподобны, но неверны)
4. Вопрос не выходит за рамки evidence
Верни JSON: {"grounded": true|false, "reason": "краткое объяснение"}`;

// ─── Утилиты ──────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Evidence Quality Scoring (soft-skip) ─────────────────────────────────

/**
 * Оценивает качество evidence для intent.
 * Возвращает score 0–1 и причину, если evidence недостаточен.
 *
 * @param {string} evidenceText - Текст evidence
 * @param {string} intent - Текст intent
 * @returns {{score: number, reason: string|null}}
 */
function scoreEvidenceQuality(evidenceText, intent) {
    const minChars = config.EVIDENCE_MIN_CHARS || 80;

    if (!evidenceText || evidenceText.trim().length < minChars) {
        return { score: 0.1, reason: `Evidence слишком короткий (${evidenceText ? evidenceText.trim().length : 0} < ${minChars} символов)` };
    }

    // Проверяем наличие конкретных фактов (числа, имена, термины)
    const hasNumbers = /\d+/.test(evidenceText);
    const hasSentences = (evidenceText.match(/[.!?]/g) || []).length >= 2;
    const hasKeyTerms = evidenceText.split(/\s+/).filter(w => w.length > 5).length >= 5;

    let score = 0.5;
    if (hasNumbers) score += 0.15;
    if (hasSentences) score += 0.2;
    if (hasKeyTerms) score += 0.15;

    // Проверяем, есть ли пересечение между intent и evidence (релевантность)
    const intentWords = new Set(intent.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const evidenceLower = evidenceText.toLowerCase();
    let relevanceHits = 0;
    for (const word of intentWords) {
        if (evidenceLower.includes(word)) relevanceHits++;
    }
    const relevance = intentWords.size > 0 ? relevanceHits / intentWords.size : 0;
    if (relevance < 0.15) {
        return { score: 0.2, reason: `Evidence не релевантен intent (совпадение: ${Math.round(relevance * 100)}%)` };
    }

    return { score: Math.min(1, score), reason: null };
}

// ─── Вспомогательные функции для batch-генерации ─────────────────────────

/**
 * Распределяет уровни сложности Bloom's Taxonomy по всему blueprint.
 * @param {Array}  blueprint     - Массив intent-объектов
 * @param {object} bloomMix      - { remember, understand, apply, analyze } — доли (в сумме ~1)
 */
function assignDifficulties(blueprint, bloomMix = { remember: 0.20, understand: 0.35, apply: 0.25, analyze: 0.20 }) {
    const total = blueprint.length;
    const counts = {
        remember: Math.round(total * (bloomMix.remember ?? 0.20)),
        understand: Math.round(total * (bloomMix.understand ?? 0.35)),
        apply: Math.round(total * (bloomMix.apply ?? 0.25)),
        analyze: Math.round(total * (bloomMix.analyze ?? 0.20)),
    };

    // Компенсируем ошибки округления, добавляя остаток к understand
    const assigned = counts.remember + counts.understand + counts.apply + counts.analyze;
    counts.understand += total - assigned;

    const pool = [
        ...Array(Math.max(0, counts.remember)).fill('remember'),
        ...Array(Math.max(0, counts.understand)).fill('understand'),
        ...Array(Math.max(0, counts.apply)).fill('apply'),
        ...Array(Math.max(0, counts.analyze)).fill('analyze'),
    ];

    // Перемешиваем для разнообразия в каждом batch
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    return blueprint.map((intent, i) => ({ ...intent, difficulty: pool[i] || 'understand' }));
}

/**
 * Строит текст пользовательского промпта для batch-вызова.
 * @param {Array}  intents            - Intent-объекты (с полем difficulty)
 * @param {Array}  evidenceList       - Evidence text для каждого intent
 * @param {number} maxEvidenceChars   - Лимит символов на один evidence блок
 */
function buildBatchPrompt(intents, evidenceList, maxEvidenceChars = 2500) {
    const lines = [`Создай ${intents.length} вопрос(а/ов) формата multiple_choice — по одному на каждый intent.\n`];

    for (let i = 0; i < intents.length; i++) {
        const intent = intents[i];
        let evidence = evidenceList[i] || '';
        if (evidence.length > maxEvidenceChars) {
            evidence = evidence.substring(0, maxEvidenceChars) + '…';
        }
        lines.push(`=== Intent ${i + 1} ===`);
        lines.push(`Тема: "${intent.theme}"`);
        lines.push(`Намерение: "${intent.intent}"`);
        lines.push(`Тип: multiple_choice`);
        lines.push(`Bloom-уровень: ${intent.difficulty || 'understand'}`);
        lines.push(`Evidence:\n${evidence}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Нормализует поля LLM-ответа к формату пайплайна.
 * - correctIndex как primary field
 * - sourceChunkId → sources
 */
function normalizeQuestion(q, chunkIds = []) {
    const normalized = { ...q };

    // Нормализуем correctIndex (поддержка разных имён от LLM)
    if (normalized.correctIndex == null && normalized.correct_answer != null) {
        normalized.correctIndex = normalized.correct_answer;
    }
    // Обеспечиваем backward compatibility
    if (normalized.correctIndex != null) {
        normalized.correct_answer = normalized.correctIndex;
    }

    // Принудительно type = multiple_choice
    normalized.type = 'multiple_choice';

    // Нормализуем difficulty к Bloom taxonomy
    if (!BLOOM_LEVELS.includes(normalized.difficulty)) {
        // Маппинг из старых уровней
        const mapping = { easy: 'remember', medium: 'understand', hard: 'analyze' };
        normalized.difficulty = mapping[normalized.difficulty] || 'understand';
    }

    // Нормализуем sources
    if (!normalized.sources || !Array.isArray(normalized.sources) || normalized.sources.length === 0) {
        const srcId = normalized.sourceChunkId;
        if (srcId != null) {
            normalized.sources = [{ chunk_id: srcId, quote: '' }];
        } else {
            normalized.sources = chunkIds.map(id => ({ chunk_id: id, quote: '' }));
        }
    }

    return normalized;
}

// ─── Batch-генерация вопросов ─────────────────────────────────────────────

/**
 * Генерирует batch вопросов за ОДИН LLM-вызов.
 * Поддерживает soft-skip: если LLM вернул {skipped: true}, пропускаем без ошибки.
 *
 * @param {Array}  intents      - Массив intent-объектов
 * @param {Array}  evidenceList - Evidence text для каждого intent
 * @param {Array}  chunkIdsList - Массив chunk ID для каждого intent
 * @param {number} [retries]
 * @param {string} [model]
 * @param {string} [lang]       - Код языка документа
 * @returns {Promise<Array<{question: object, intentIdx: number}>>}
 */
async function generateBatchQuestions(intents, evidenceList, chunkIdsList, retries = null, model = null, lang = 'auto') {
    retries = retries || config.LLM_MAX_RETRIES;
    const llmModel = model || config.LLM_MODEL;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const userPrompt = buildBatchPrompt(intents, evidenceList);

            const response = await ai.models.generateContent({
                model: llmModel,
                contents: userPrompt,
                config: {
                    systemInstruction: getBatchSystemPrompt(lang),
                    temperature: 0.7,
                    responseMimeType: 'application/json',
                },
            });

            const content = response.text;
            if (!content) throw new Error('Пустой ответ от LLM');

            let parsed = extractJSON(content);
            if (!Array.isArray(parsed)) parsed = [parsed];

            const results = [];
            const limit = Math.min(parsed.length, intents.length);

            for (let i = 0; i < limit; i++) {
                // Soft-skip: LLM сигнализирует, что evidence недостаточен
                if (parsed[i] && parsed[i].skipped === true) {
                    console.log(`[GENERATOR] Batch: intent[${i + 1}] пропущен LLM — ${parsed[i].reason || 'недостаточный evidence'}`);
                    continue;
                }

                try {
                    const normalized = normalizeQuestion(parsed[i], chunkIdsList[i] || []);
                    const [validated] = validateQuestions([normalized]);
                    results.push({ question: { ...validated, sources: normalized.sources }, intentIdx: i });
                } catch (e) {
                    console.warn(`[GENERATOR] Batch: вопрос ${i + 1}/${limit} невалиден — ${e.message}`);
                }
            }

            if (results.length > 0) return results;
            throw new Error('Ни один вопрос в batch не прошёл валидацию');

        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await sleep(1000 * Math.pow(2, attempt - 1));
            }
        }
    }

    console.error(`[GENERATOR] Batch пропущен: ${lastError.message}`);
    return [];
}

// ─── Проверка groundedness ─────────────────────────────────────────────────

/**
 * Проверяет, подтверждается ли ответ evidence (anti-hallucination).
 * @param {string} [model] - ID модели
 */
async function checkGrounding(question, evidenceText, model = null) {
    const llmModel = model || config.LLM_MODEL;
    try {
        const correctOption = Array.isArray(question.options) && question.correctIndex != null
            ? question.options[question.correctIndex]
            : JSON.stringify(question.correctIndex);

        const prompt = `Вопрос: ${question.question}\nПравильный ответ: ${correctOption}\nОбъяснение: ${question.explanation}\n\nEvidence:\n${evidenceText}`;
        const response = await ai.models.generateContent({
            model: llmModel,
            contents: prompt,
            config: {
                systemInstruction: GROUNDING_SYSTEM,
                temperature: 0.0,
                responseMimeType: 'application/json',
            },
        });
        const parsed = extractJSON(response.text);
        return parsed.grounded !== false;
    } catch {
        // Если проверка не прошла технически — оставляем вопрос (не блокируем)
        return true;
    }
}

// ─── Семантическая дедупликация ────────────────────────────────────────────

/**
 * Семантическая дедупликация через эмбеддинги вопросов + Levenshtein fallback
 */
async function semanticDedup(questions, threshold = 0.88) {
    if (questions.length === 0) return questions;

    // Получаем эмбеддинги для всех вопросов
    const embeddings = [];
    for (const q of questions) {
        try {
            const emb = await rag.getQueryEmbedding(q.question);
            embeddings.push(emb);
        } catch {
            embeddings.push(null);
        }
        await sleep(200);
    }

    const unique = [];
    const usedIdx = new Set();

    for (let i = 0; i < questions.length; i++) {
        if (usedIdx.has(i)) continue;
        let isDup = false;

        for (let j = 0; j < unique.length; j++) {
            const prevIdx = unique[j]._origIdx;
            // Семантическое сходство
            if (embeddings[i] && embeddings[prevIdx]) {
                const sim = rag.cosineSimilarity(embeddings[i], embeddings[prevIdx]);
                if (sim > threshold) { isDup = true; break; }
            }
            // Levenshtein fallback
            const textSim = levenshteinSimilarity(
                questions[i].question.toLowerCase(),
                unique[j].question.toLowerCase()
            );
            if (textSim > 0.8) { isDup = true; break; }
        }

        if (!isDup) {
            unique.push({ ...questions[i], _origIdx: i });
        } else {
            usedIdx.add(i);
        }
    }

    return unique.map(({ _origIdx, ...q }, i) => ({ ...q, id: i + 1 }));
}

// ─── Levenshtein ───────────────────────────────────────────────────────────

function levenshteinSimilarity(a, b) {
    if (a === b) return 1;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const costs = [];
    for (let i = 0; i <= longer.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= shorter.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (longer[i - 1] !== shorter[j - 1]) {
                    newValue = Math.min(newValue, lastValue, costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[shorter.length] = lastValue;
    }
    return (longer.length - costs[shorter.length]) / longer.length;
}

// ─── Backfill helpers ─────────────────────────────────────────────────────

/**
 * Создаёт backfill-intents из чанков, которые ещё не покрыты вопросами.
 * Все intents — только multiple_choice.
 *
 * @param {Array}  poolChunks   - Чанки-кандидаты для backfill
 * @param {number} count        - Сколько intents создать
 * @param {number} typeOffset   - Смещение (не используется, сохранено для API совместимости)
 * @returns {Array}             - Intent-объекты с полем _chunkRef
 */
function createBackfillIntents(poolChunks, count, typeOffset = 0) {
    const intents = [];

    for (let i = 0; i < count; i++) {
        const chunk = poolChunks[i % poolChunks.length];

        let intentText;
        if (Array.isArray(chunk.summary) && chunk.summary.length > 0) {
            const factIdx = Math.floor(i / poolChunks.length) % chunk.summary.length;
            intentText = `Проверить знание факта: "${chunk.summary[factIdx]}"`;
        } else if (chunk.section && chunk.section !== 'Документ') {
            intentText = `Проверить ключевые понятия раздела "${chunk.section}"`;
        } else {
            intentText = `Проверить понимание фрагмента документа (чанк ${chunk.chunk_index + 1})`;
        }

        intents.push({
            theme: chunk.section || 'Документ',
            section: chunk.section || 'Документ',
            intent: intentText,
            type: 'multiple_choice',
            _chunkRef: chunk,
        });
    }

    return intents;
}

// ─── Главная функция ───────────────────────────────────────────────────────

/**
 * Вычисляет целевое число вопросов по размеру документа.
 */
function computeTargetQuestionCount(fullText, indexedChunks) {
    const targetMin = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;
    let baseTarget;
    if (indexedChunks && indexedChunks.length > 0) {
        baseTarget = indexedChunks.length * (config.QUESTIONS_PER_CHUNK || 4);
    } else {
        baseTarget = Math.round(fullText.length / (config.CHAR_LENGTH_PER_QUESTION || 2000));
    }
    return Math.min(targetMax, Math.max(targetMin, baseTarget));
}

/**
 * Генерирует тест из полного текста документа с RAG-пайплайном.
 * Формат вопросов: только multiple_choice.
 * Уровни сложности: Bloom's Taxonomy (remember, understand, apply, analyze).
 *
 * @param {string}   fullText       - Текст документа
 * @param {string}   docName        - Имя файла
 * @param {Array}    indexedChunks  - Проиндексированные чанки
 * @param {function} onProgress     - Коллбэк прогресса
 * @param {object}   [opts]         - { model }
 * @returns {Promise<{title, questions}>}
 */
async function generateTest(fullText, docName, indexedChunks, onProgress, opts = {}) {
    const startTime = Date.now();
    const model = opts.model || config.LLM_MODEL;

    // Определяем язык документа
    const detectedLang = detectLanguage(fullText);
    console.log(`[GENERATOR] Определён язык документа: ${detectedLang}`);

    // Fallback: если индекс не передан
    if (!indexedChunks || indexedChunks.length === 0) {
        const chunks = chunkText(fullText);
        indexedChunks = chunks.map((c, i) => ({
            id: i + 1,
            chunk_index: c.index,
            text: c.text,
            token_count: c.tokens,
            page: c.page ?? null,
            section: c.section ?? null,
            heading: c.heading ?? null,
            embedding: null,
            summary: [],
        }));
    }

    const targetMin = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;
    const targetCount = computeTargetQuestionCount(fullText, indexedChunks);
    const baseFromChunks = indexedChunks.length * (config.QUESTIONS_PER_CHUNK || 4);
    const logReason = baseFromChunks > 0
        ? `по чанкам: ${indexedChunks.length} × ${config.QUESTIONS_PER_CHUNK} = ${baseFromChunks} → ${targetCount}`
        : `по тексту: ${fullText.length} / ${config.CHAR_LENGTH_PER_QUESTION} → ${targetCount}`;
    console.log(`[GENERATOR] Цель: ${targetMin}–${targetMax} вопросов, выбран ${targetCount} (${logReason}), чанков: ${indexedChunks.length}, модель: ${model}, формат: multiple_choice only, Bloom taxonomy`);

    // Шаг 1: Извлечение тем
    if (onProgress) onProgress(1, 6);
    console.log('[GENERATOR] Извлечение тем из summaries чанков...');
    const themes = await rag.extractThemes(indexedChunks, fullText, model);
    console.log(`[GENERATOR] Тем: ${themes.length}`, themes.map(t => `[${t.section}] ${t.topic || t}`).join(', '));

    // Шаг 2: Blueprint — план вопросов (только multiple_choice)
    if (onProgress) onProgress(2, 6);
    console.log('[GENERATOR] Построение blueprint...');
    const blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, model);
    console.log(`[GENERATOR] Blueprint: ${blueprint.length} intent-ов`);

    // Шаг 3: Retrieval + soft-skip + batch-генерация
    if (onProgress) onProgress(3, 6);
    const topK = config.RAG_TOP_K || 5;
    const batchSize = Math.max(3, Math.min(5, config.LLM_BATCH_SIZE || 4));
    const allQuestions = [];
    const enableGrounding = config.ENABLE_GROUNDING !== false;

    // Распределяем уровни Bloom по blueprint
    const blueprintWithDifficulty = assignDifficulties(blueprint);

    // Coverage map
    const coverageMap = rag.buildCoverageMap(indexedChunks);

    let statsValidated = 0;
    let statsSkippedEvidence = 0;
    let statsSkippedLLM = 0;

    const totalBatches = Math.ceil(blueprintWithDifficulty.length / batchSize);
    console.log(`[GENERATOR] Batch-режим: ${blueprintWithDifficulty.length} intents → ${totalBatches} batch(ей) по ≤${batchSize}`);

    for (let batchStart = 0; batchStart < blueprintWithDifficulty.length; batchStart += batchSize) {
        const batch = blueprintWithDifficulty.slice(batchStart, batchStart + batchSize);
        const batchNum = Math.floor(batchStart / batchSize) + 1;
        console.log(`[GENERATOR] Batch ${batchNum}/${totalBatches}: ${batch.length} intents`);

        // Retrieval + soft-skip pre-check для каждого intent
        const filteredBatch = [];
        const evidenceList = [];
        const chunkIdsList = [];

        for (const intent of batch) {
            const relevantChunks = await rag.hybridRetrieve(
                `${intent.theme}: ${intent.intent}`,
                indexedChunks,
                topK
            );
            const packets = rag.buildEvidencePackets(relevantChunks, intent.intent);
            const evidenceText = rag.formatEvidenceForPrompt(packets);
            const ids = relevantChunks.map(c => c.id);

            // === Soft-skip: проверяем качество evidence ===
            const quality = scoreEvidenceQuality(evidenceText, intent.intent);
            if (quality.score < 0.3) {
                console.log(`[GENERATOR] Soft-skip intent "${intent.intent.slice(0, 60)}…" — ${quality.reason}`);
                statsSkippedEvidence++;
                continue;
            }

            filteredBatch.push(intent);
            evidenceList.push(evidenceText);
            chunkIdsList.push(ids);
            rag.updateCoverageMap(coverageMap, ids);
        }

        if (filteredBatch.length === 0) {
            console.warn(`[GENERATOR] Batch ${batchNum}: все intents пропущены (weak evidence)`);
            continue;
        }

        // Один LLM-вызов на batch
        const batchResults = await generateBatchQuestions(filteredBatch, evidenceList, chunkIdsList, null, model, detectedLang);
        statsValidated += batchResults.length;

        // Проверка groundedness
        for (const { question, intentIdx } of batchResults) {
            if (enableGrounding) {
                const grounded = await checkGrounding(question, evidenceList[intentIdx], model);
                if (!grounded) {
                    console.warn(`[GENERATOR] Batch ${batchNum}, intent[${intentIdx + 1}]: не прошёл groundedness, пропускаем`);
                    continue;
                }
            }
            allQuestions.push(question);
        }

        // Пауза между batch-запросами
        if (batchStart + batchSize < blueprintWithDifficulty.length) await sleep(1200);
    }

    console.log(`[GENERATOR] Покрытие: ${rag.formatCoverageReport(coverageMap)}`);
    console.log(`[GENERATOR] Статистика: blueprint=${blueprintWithDifficulty.length}, skipped_evidence=${statsSkippedEvidence}, validated=${statsValidated}, grounded=${allQuestions.length}, target=${targetMin}`);

    // Шаг 4: Семантическая дедупликация
    if (onProgress) onProgress(4, 6);
    console.log('[GENERATOR] Семантическая дедупликация...');
    const initialDedup = await semanticDedup(allQuestions, config.DEDUP_THRESHOLD || 0.88);
    console.log(`[GENERATOR] После дедупликации: ${initialDedup.length} (было ${allQuestions.length})`);

    // ─── Backfill: добираем вопросы до targetMin ────────────────────────────
    const maxBackfillRounds = config.BACKFILL_MAX_ROUNDS || 3;
    let workingQuestions = [...initialDedup];

    for (let round = 1; round <= maxBackfillRounds && workingQuestions.length < targetMin; round++) {
        const gap = targetMin - workingQuestions.length;

        const uncoveredChunks = indexedChunks.filter(c => !coverageMap.usedChunkIds.has(c.id));
        const poolChunks = uncoveredChunks.length > 0 ? uncoveredChunks : indexedChunks;

        console.log(`[GENERATOR] Backfill round ${round}/${maxBackfillRounds}: gap=${gap}, непокрытых чанков: ${uncoveredChunks.length}/${indexedChunks.length}`);

        const intentsNeeded = Math.min(gap * 2, poolChunks.length * 3, 20);
        if (intentsNeeded === 0) {
            console.warn('[GENERATOR] Backfill: нет доступных чанков, прерываем');
            break;
        }

        const backfillIntents = createBackfillIntents(poolChunks, intentsNeeded, workingQuestions.length);
        const backfillWithDiff = assignDifficulties(backfillIntents);

        const newRawQuestions = [];
        const totalBackfillBatches = Math.ceil(backfillWithDiff.length / batchSize);

        for (let bs = 0; bs < backfillWithDiff.length; bs += batchSize) {
            const batchIntents = backfillWithDiff.slice(bs, bs + batchSize);
            const bNum = Math.floor(bs / batchSize) + 1;
            console.log(`[GENERATOR] Backfill round ${round}, batch ${bNum}/${totalBackfillBatches}: ${batchIntents.length} intents`);

            const bfEvidenceList = [];
            const bfChunkIdsList = [];
            const bfFilteredBatch = [];

            for (const intent of batchIntents) {
                const chunkRef = intent._chunkRef;
                const packets = rag.buildEvidencePackets([chunkRef], intent.intent);
                const evidenceText = rag.formatEvidenceForPrompt(packets);

                // Soft-skip для backfill
                const quality = scoreEvidenceQuality(evidenceText, intent.intent);
                if (quality.score < 0.3) {
                    statsSkippedEvidence++;
                    continue;
                }

                bfFilteredBatch.push(intent);
                bfEvidenceList.push(evidenceText);
                bfChunkIdsList.push([chunkRef.id]);
                rag.updateCoverageMap(coverageMap, [chunkRef.id]);
            }

            if (bfFilteredBatch.length === 0) continue;

            const batchResults = await generateBatchQuestions(bfFilteredBatch, bfEvidenceList, bfChunkIdsList, null, model, detectedLang);

            for (const { question, intentIdx } of batchResults) {
                if (enableGrounding) {
                    const grounded = await checkGrounding(question, bfEvidenceList[intentIdx], model);
                    if (!grounded) continue;
                }
                newRawQuestions.push(question);
            }

            if (bs + batchSize < backfillWithDiff.length) await sleep(1200);
        }

        if (newRawQuestions.length === 0) {
            console.warn(`[GENERATOR] Backfill round ${round}: нет новых вопросов, прерываем`);
            break;
        }

        const dedupedNew = newRawQuestions.length > 1
            ? await semanticDedup(newRawQuestions, config.DEDUP_THRESHOLD || 0.88)
            : newRawQuestions;

        const filtered = dedupedNew.filter(q =>
            !workingQuestions.some(existing =>
                levenshteinSimilarity(q.question.toLowerCase(), existing.question.toLowerCase()) > 0.8
            )
        );

        console.log(`[GENERATOR] Backfill round ${round}: получено=${newRawQuestions.length}, dedup=${dedupedNew.length}, уникальных новых=${filtered.length}, итого=${workingQuestions.length + filtered.length}`);
        workingQuestions = [...workingQuestions, ...filtered];
    }

    // Шаг 5: Финализация
    if (onProgress) onProgress(5, 6);
    const finalQuestions = workingQuestions
        .slice(0, targetMax)
        .map((q, i) => ({ ...q, id: i + 1 }));

    if (onProgress) onProgress(6, 6);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
        `[GENERATOR] Итог → запрошено: ${targetMin}–${targetMax} | ` +
        `blueprint: ${blueprintWithDifficulty.length} | ` +
        `skipped(evidence): ${statsSkippedEvidence} | ` +
        `validated: ${statsValidated} | grounded: ${allQuestions.length} | ` +
        `после dedup: ${initialDedup.length} | ` +
        `финальных: ${finalQuestions.length} | время: ${elapsed}s | ` +
        `язык: ${detectedLang} | формат: multiple_choice | Bloom taxonomy`
    );

    const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
    return {
        title: `Тест по документу: ${cleanName}`,
        questions: finalQuestions,
    };
}

module.exports = { generateTest, detectLanguage, scoreEvidenceQuality, BLOOM_LEVELS };
