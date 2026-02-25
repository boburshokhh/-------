const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { chunkText } = require('./chunker');
const { validateQuestions, extractJSON } = require('./validator');
const rag = require('./rag');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ─── System prompts ────────────────────────────────────────────────────────

function getSystemPrompt(questionType) {
    const baseRules = `ПРАВИЛА:
1. Генерируй вопрос СТРОГО на основе предоставленных данных (evidence). Не выдумывай факты.
2. correct_answer и explanation должны прямо вытекать из evidence.
3. В поле "sources" перечисли chunk_id из которых взята информация.
4. Объяснение краткое (1–2 предложения).`;

    const typeInstructions = {
        multiple_choice: `Создай 1 вопрос типа multiple_choice. 4 варианта ответа, только один правильный. Дистракторы — правдоподобные, но неверные.`,
        true_false: `Создай 1 вопрос типа true_false. Утверждение должно быть конкретным и проверяемым.`,
        open_ended: `Создай 1 вопрос типа open_ended. Ответ — краткое, фактическое утверждение (1–3 предложения).`,
    };

    const examples = {
        multiple_choice: `{"type":"multiple_choice","question":"...?","options":["A","B","C","D"],"correct_answer":0,"explanation":"...","sources":[{"chunk_id":1,"quote":"..."}]}`,
        true_false: `{"type":"true_false","question":"...","correct_answer":true,"explanation":"...","sources":[{"chunk_id":1,"quote":"..."}]}`,
        open_ended: `{"type":"open_ended","question":"...?","correct_answer":"...","explanation":"...","sources":[{"chunk_id":1,"quote":"..."}]}`,
    };

    return `Ты — генератор проверочных вопросов для учебного теста.
${typeInstructions[questionType] || typeInstructions.multiple_choice}

${baseRules}

ФОРМАТ ОТВЕТА — строго один JSON объект:
${examples[questionType] || examples.multiple_choice}

ВАЖНО: Отвечай ТОЛЬКО JSON объектом. Никакого другого текста.`;
}

const GROUNDING_SYSTEM = `Ты проверяешь качество тестового вопроса.
Твоя задача: убедиться, что correct_answer и explanation полностью подтверждаются предоставленным evidence.
Верни JSON: {"grounded": true|false, "reason": "краткое объяснение"}`;

// ─── Утилиты ──────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Генерация одного вопроса ──────────────────────────────────────────────

/**
 * Генерирует один вопрос по intent + evidence с retry
 */
async function generateSingleQuestion(intent, evidenceText, questionType, chunkIds, retries = null) {
    retries = retries || config.LLM_MAX_RETRIES;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const userPrompt = `Намерение вопроса: "${intent.intent}"\nТема: "${intent.theme}"\n\nEvidence (источники):\n${evidenceText}`;

            const response = await ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: userPrompt,
                config: {
                    systemInstruction: getSystemPrompt(questionType),
                    temperature: 0.65,
                    responseMimeType: 'application/json',
                },
            });

            const content = response.text;
            if (!content) throw new Error('Пустой ответ от LLM');

            let parsed = extractJSON(content);
            if (Array.isArray(parsed)) parsed = parsed[0];

            // Убеждаемся, что sources присутствуют (заполняем fallback из chunkIds)
            if (!parsed.sources || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
                parsed.sources = chunkIds.map(id => ({ chunk_id: id, quote: '' }));
            }

            // Проверяем через validateQuestions (без sources — доп. поле)
            const [validated] = validateQuestions([parsed]);
            return { ...validated, sources: parsed.sources };

        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await sleep(1000 * Math.pow(2, attempt - 1));
            }
        }
    }

    console.error(`[GENERATOR] Вопрос пропущен (intent: "${intent.intent}"): ${lastError.message}`);
    return null;
}

// ─── Проверка groundedness ─────────────────────────────────────────────────

/**
 * Проверяет, подтверждается ли ответ evidence (anti-hallucination)
 * Дешёвый вызов с temperature=0
 */
async function checkGrounding(question, evidenceText) {
    try {
        const prompt = `Вопрос: ${question.question}\nОтвет: ${JSON.stringify(question.correct_answer)}\nОбъяснение: ${question.explanation}\n\nEvidence:\n${evidenceText}`;
        const response = await ai.models.generateContent({
            model: config.LLM_MODEL,
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

// ─── Главная функция ───────────────────────────────────────────────────────

/**
 * Генерирует тест из полного текста документа с полноценным RAG-пайплайном.
 *
 * @param {string}   fullText       - Текст документа
 * @param {string}   docName        - Имя файла
 * @param {Array}    indexedChunks  - Проиндексированные чанки (из indexer.js)
 * @param {function} onProgress     - Коллбэк прогресса (currentStep, totalSteps)
 * @returns {Promise<{title, questions}>}
 */
async function generateTest(fullText, docName, indexedChunks, onProgress) {
    const startTime = Date.now();

    // Fallback: если индекс не передан — используем старый путь через chunkText
    if (!indexedChunks || indexedChunks.length === 0) {
        const chunks = chunkText(fullText);
        indexedChunks = chunks.map((c, i) => ({
            id: i + 1,
            chunk_index: c.index,
            text: c.text,
            token_count: c.tokens,
            embedding: null,
            summary: [],
        }));
    }

    const targetMin = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;

    console.log(`[GENERATOR] Цель: ${targetMin}–${targetMax} вопросов из ${indexedChunks.length} чанков`);

    // Шаг 1: Извлечение тем
    if (onProgress) onProgress(1, 6);
    console.log('[GENERATOR] Извлечение тем...');
    const themes = await rag.extractThemes(fullText);
    console.log(`[GENERATOR] Темы (${themes.length}):`, themes);

    // Шаг 2: Blueprint — план вопросов
    if (onProgress) onProgress(2, 6);
    console.log('[GENERATOR] Построение blueprint...');
    const blueprint = await rag.buildQuestionBlueprint(themes, targetMin, targetMax);
    console.log(`[GENERATOR] Blueprint: ${blueprint.length} intent-ов`);

    // Шаг 3: Retrieval + compression + генерация по каждому intent
    if (onProgress) onProgress(3, 6);
    const topK = config.RAG_TOP_K || 3;
    const allQuestions = [];
    const enableGrounding = config.ENABLE_GROUNDING !== false;

    for (let i = 0; i < blueprint.length; i++) {
        const intent = blueprint[i];
        console.log(`[GENERATOR] Intent ${i + 1}/${blueprint.length}: "${intent.intent}"`);

        // Retrieval: гибридный поиск
        const relevantChunks = await rag.hybridRetrieve(
            `${intent.theme}: ${intent.intent}`,
            indexedChunks,
            topK
        );

        // Компрессия: evidence packets
        const packets = rag.buildEvidencePackets(relevantChunks, intent.intent);
        const evidenceText = rag.formatEvidenceForPrompt(packets);
        const chunkIds = relevantChunks.map(c => c.id);

        // Генерация одного вопроса
        const question = await generateSingleQuestion(intent, evidenceText, intent.type, chunkIds);

        if (question) {
            // Проверка groundedness
            if (enableGrounding) {
                const grounded = await checkGrounding(question, evidenceText);
                if (!grounded) {
                    console.warn(`[GENERATOR] Intent ${i + 1}: вопрос не прошёл groundedness, пропускаем`);
                    await sleep(300);
                    continue;
                }
            }
            allQuestions.push(question);
        }

        // Пауза между запросами
        if (i < blueprint.length - 1) await sleep(800);
    }

    console.log(`[GENERATOR] Сгенерировано вопросов до дедупликации: ${allQuestions.length}`);

    // Шаг 4: Семантическая дедупликация
    if (onProgress) onProgress(4, 6);
    console.log('[GENERATOR] Семантическая дедупликация...');
    const uniqueQuestions = await semanticDedup(allQuestions, config.DEDUP_THRESHOLD || 0.88);
    console.log(`[GENERATOR] После дедупликации: ${uniqueQuestions.length} вопросов`);

    // Шаг 5: Нумеруем финальный список
    if (onProgress) onProgress(5, 6);
    const finalQuestions = uniqueQuestions.map((q, i) => ({ ...q, id: i + 1 }));

    if (onProgress) onProgress(6, 6);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[GENERATOR] Готово: ${finalQuestions.length} вопросов за ${elapsed}s`);

    const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
    return {
        title: `Тест по документу: ${cleanName}`,
        questions: finalQuestions,
    };
}

module.exports = { generateTest };
