const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { chunkText } = require('./chunker');
const { validateQuestions, extractJSON } = require('./validator');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const SYSTEM_PROMPT = `Ты — ИИ-генератор тестов. На основе предоставленного текста создай ровно ${config.QUESTIONS_PER_CHUNK} вопроса для проверки знаний.

ПРАВИЛА:
1. Генерируй вопросы ТОЛЬКО на основе предоставленного текста. Не выдумывай факты.
2. Миксуй типы вопросов: multiple_choice, true_false, open_ended.
3. Каждый вопрос должен проверять понимание ключевых концепций.
4. Объяснения должны быть краткими (1–2 предложения).

ФОРМАТ ОТВЕТА — строго JSON массив:
[
  {
    "type": "multiple_choice",
    "question": "Текст вопроса?",
    "options": ["Вариант A", "Вариант B", "Вариант C", "Вариант D"],
    "correct_answer": 0,
    "explanation": "Краткое объяснение."
  },
  {
    "type": "true_false",
    "question": "Утверждение.",
    "correct_answer": true,
    "explanation": "Краткое объяснение."
  },
  {
    "type": "open_ended",
    "question": "Вопрос?",
    "correct_answer": "Эталонный ответ.",
    "explanation": "Краткое объяснение."
  }
]

ВАЖНО: Отвечай ТОЛЬКО JSON массивом. Никакого текста до или после.`;

/**
 * Генерирует тест из полного текста документа.
 * @param {string} fullText - Текст документа
 * @param {string} docName - Название документа
 * @param {function} onProgress - Коллбэк прогресса (chunkIndex, totalChunks)
 * @returns {Promise<{title: string, questions: Array}>}
 */
async function generateTest(fullText, docName, onProgress) {
    const chunks = chunkText(fullText);

    if (chunks.length === 0) {
        const err = new Error('Текст слишком короткий для генерации теста');
        err.type = 'PARSE_ERROR';
        throw err;
    }

    console.log(`[GENERATOR] Документ разбит на ${chunks.length} чанков`);

    const allQuestions = [];

    for (const chunk of chunks) {
        if (onProgress) {
            onProgress(chunk.index, chunks.length);
        }

        console.log(`[GENERATOR] Обработка чанка ${chunk.index + 1}/${chunks.length} (${chunk.tokens} токенов)`);

        const questions = await generateQuestionsForChunk(chunk.text, chunk.index);
        allQuestions.push(...questions);

        // Пауза между запросами, чтобы не превысить rate limit
        if (chunk.index < chunks.length - 1) {
            await sleep(500);
        }
    }

    // Нумеруем вопросы
    const numberedQuestions = allQuestions.map((q, i) => ({
        id: i + 1,
        ...q
    }));

    // Убираем дублирующиеся вопросы
    const uniqueQuestions = deduplicateQuestions(numberedQuestions);

    const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');

    return {
        title: `Тест по документу: ${cleanName}`,
        questions: uniqueQuestions
    };
}

/**
 * Генерирует вопросы для одного чанка текста с retry-логикой.
 */
async function generateQuestionsForChunk(chunkText, chunkIndex) {
    let lastError;

    for (let attempt = 1; attempt <= config.LLM_MAX_RETRIES; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: config.LLM_MODEL,
                contents: `Текст для анализа (блок ${chunkIndex + 1}):\n\n${chunkText}`,
                config: {
                    systemInstruction: SYSTEM_PROMPT,
                    temperature: 0.7,
                    responseMimeType: "application/json",
                }
            });

            const content = response.text;
            if (!content) {
                throw new Error('Пустой ответ от LLM');
            }

            let parsed = extractJSON(content);

            // Если LLM вернул объект с ключом questions
            if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.questions)) {
                parsed = parsed.questions;
            }

            const validated = validateQuestions(Array.isArray(parsed) ? parsed : [parsed]);
            console.log(`[GENERATOR] Чанк ${chunkIndex + 1}: получено ${validated.length} вопросов`);

            return validated;

        } catch (error) {
            lastError = error;
            console.warn(
                `[GENERATOR] Попытка ${attempt}/${config.LLM_MAX_RETRIES} для чанка ${chunkIndex + 1} не удалась: ${error.message}`
            );

            if (attempt < config.LLM_MAX_RETRIES) {
                // Exponential backoff
                await sleep(1000 * Math.pow(2, attempt - 1));
            }
        }
    }

    // Все попытки исчерпаны — пропустим чанк вместо полной ошибки
    console.error(`[GENERATOR] Чанк ${chunkIndex + 1} полностью пропущен: ${lastError.message}`);
    return [];
}

/**
 * Удаление дублирующихся вопросов по текстовому сходству.
 */
function deduplicateQuestions(questions) {
    const seen = [];
    const unique = [];

    for (const q of questions) {
        const normalized = q.question.toLowerCase().replace(/\s+/g, ' ').trim();
        const isDuplicate = seen.some(s => levenshteinSimilarity(s, normalized) > 0.8);

        if (!isDuplicate) {
            seen.push(normalized);
            unique.push(q);
        }
    }

    // Перенумеровываем
    return unique.map((q, i) => ({ ...q, id: i + 1 }));
}

/**
 * Приблизительное сходство строк (Levenshtein).
 */
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { generateTest };
