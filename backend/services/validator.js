/**
 * Валидация структуры JSON вопросов от LLM.
 * Формат: только multiple_choice с Bloom's Taxonomy difficulty.
 */

const VALID_TYPES = ['multiple_choice'];
const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

// Маппинг старых уровней сложности → Bloom taxonomy
const DIFFICULTY_MAPPING = {
    easy: 'remember',
    medium: 'understand',
    hard: 'analyze',
};

/**
 * Валидирует и очищает массив вопросов от LLM.
 * @param {Array} questions - Массив вопросов
 * @returns {Array} - Провалидированные вопросы
 */
function validateQuestions(questions) {
    if (!Array.isArray(questions)) {
        throw new Error('Ответ LLM не содержит массив вопросов');
    }

    const valid = [];

    for (const q of questions) {
        try {
            // Пропускаем soft-skip объекты от LLM
            if (q && q.skipped === true) continue;

            const validated = validateSingleQuestion(q);
            if (validated) valid.push(validated);
        } catch (e) {
            console.warn(`[VALIDATOR] Пропущен вопрос: ${e.message}`);
        }
    }

    if (valid.length === 0) {
        throw new Error('LLM не смог сгенерировать ни одного валидного вопроса');
    }

    return valid;
}

function validateSingleQuestion(q) {
    if (!q || typeof q !== 'object') {
        throw new Error('Вопрос не является объектом');
    }

    // Принудительно ставим multiple_choice если type отсутствует или неизвестен
    const type = q.type && VALID_TYPES.includes(q.type) ? q.type : 'multiple_choice';

    if (!q.question || typeof q.question !== 'string' || q.question.length < 5) {
        throw new Error('Некорректный текст вопроса');
    }

    // Нормализуем difficulty: поддерживаем и старые (easy/medium/hard) и новые (Bloom) уровни
    let difficulty = q.difficulty;
    if (DIFFICULTY_MAPPING[difficulty]) {
        difficulty = DIFFICULTY_MAPPING[difficulty];
    }
    if (!BLOOM_LEVELS.includes(difficulty)) {
        difficulty = 'understand'; // безопасный дефолт
    }

    const result = {
        type,
        question: q.question.trim(),
        explanation: (q.explanation || '').trim(),
        hint: (q.hint || '').trim(),
        difficulty,
        sourceChunkId: q.sourceChunkId != null ? q.sourceChunkId : null,
        sources: Array.isArray(q.sources) ? q.sources : [],
    };

    // ─── Валидация multiple_choice ────────────────────────────────────────
    if (!Array.isArray(q.options) || q.options.length !== 4) {
        throw new Error('multiple_choice должен содержать ровно 4 варианта');
    }
    result.options = q.options.map(o => String(o).trim());

    // Поддерживаем оба формата: correctIndex (новый) и correct_answer (старый)
    let correctIdx = Number(q.correctIndex != null ? q.correctIndex : q.correct_answer);

    if (typeof correctIdx !== 'number' || !Number.isFinite(correctIdx) || correctIdx < 0 || correctIdx > 3) {
        throw new Error(`correctIndex должен быть числом 0-3, получено: ${rawIdx}`);
    }

    result.correctIndex = correctIdx;
    result.correct_answer = correctIdx; // backward compatibility

    return result;
}

/**
 * Пытается извлечь JSON из текста ответа LLM.
 * Обрабатывает случаи с markdown code blocks, trailing commas и т.д.
 * @param {string} text
 * @returns {object|Array}
 */
function extractJSON(text) {
    if (text == null) {
        throw new Error('Пустой ответ от LLM при извлечении JSON');
    }

    // Убираем markdown code blocks
    let cleaned = String(text)
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

    // Пытаемся оставить в строке только JSON-фрагмент.
    // Причина: иногда LLM возвращает "почти JSON", обрамленный лишним текстом.
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
    const first = [firstObj, firstArr].filter(i => i >= 0).sort((a, b) => a - b)[0];

    const lastObj = cleaned.lastIndexOf('}');
    const lastArr = cleaned.lastIndexOf(']');
    const last = Math.max(lastObj, lastArr);

    if (first != null && first >= 0 && last != null && last >= 0 && last > first) {
        cleaned = cleaned.slice(first, last + 1);
    }

    // Убираем trailing commas перед ] и }
    cleaned = cleaned
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Логируем кусок ответа, чтобы можно было увидеть "что именно вернуло LLM".
        const posMatch = String(e && e.message ? e.message : '').match(/position (\d+)/i);
        const pos = posMatch ? parseInt(posMatch[1], 10) : null;
        let snippet = cleaned;
        if (pos != null && Number.isFinite(pos)) {
            const start = Math.max(0, pos - 140);
            const end = Math.min(cleaned.length, pos + 200);
            snippet = cleaned.slice(start, end);
        } else {
            snippet = cleaned.slice(0, 420);
        }

        console.warn(`[VALIDATOR] JSON.parse не удался. Сниппет: ${snippet}`);
        throw new Error(`Не удалось распарсить JSON ответ LLM: ${e.message}`);
    }
}

module.exports = { validateQuestions, extractJSON, BLOOM_LEVELS };
