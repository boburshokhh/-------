/**
 * Валидация структуры JSON вопросов от LLM.
 */

const VALID_TYPES = ['multiple_choice', 'true_false', 'open_ended'];

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

    if (!q.type || !VALID_TYPES.includes(q.type)) {
        throw new Error(`Неизвестный тип вопроса: ${q.type}`);
    }

    if (!q.question || typeof q.question !== 'string' || q.question.length < 5) {
        throw new Error('Некорректный текст вопроса');
    }

    const result = {
        type: q.type,
        question: q.question.trim(),
        explanation: (q.explanation || '').trim(),
        // Сохраняем ссылки на источники, если переданы (RAG citations)
        sources: Array.isArray(q.sources) ? q.sources : [],
    };

    switch (q.type) {
        case 'multiple_choice':
            if (!Array.isArray(q.options) || q.options.length !== 4) {
                throw new Error('multiple_choice должен содержать ровно 4 варианта');
            }
            result.options = q.options.map(o => String(o).trim());
            if (typeof q.correct_answer !== 'number' || q.correct_answer < 0 || q.correct_answer > 3) {
                throw new Error('correct_answer для multiple_choice должен быть числом 0-3');
            }
            result.correct_answer = q.correct_answer;
            break;

        case 'true_false':
            if (typeof q.correct_answer !== 'boolean') {
                // Попробуем преобразовать строки "true"/"false"
                if (q.correct_answer === 'true' || q.correct_answer === 'True') {
                    result.correct_answer = true;
                } else if (q.correct_answer === 'false' || q.correct_answer === 'False') {
                    result.correct_answer = false;
                } else {
                    throw new Error('correct_answer для true_false должен быть boolean');
                }
            } else {
                result.correct_answer = q.correct_answer;
            }
            break;

        case 'open_ended':
            if (!q.correct_answer || typeof q.correct_answer !== 'string') {
                throw new Error('correct_answer для open_ended должен быть строкой');
            }
            result.correct_answer = q.correct_answer.trim();
            break;
    }

    return result;
}

/**
 * Пытается извлечь JSON из текста ответа LLM.
 * Обрабатывает случаи с markdown code blocks, trailing commas и т.д.
 * @param {string} text
 * @returns {object|Array}
 */
function extractJSON(text) {
    // Убираем markdown code blocks
    let cleaned = text
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

    // Пытаемся найти JSON массив или объект
    const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (jsonMatch) {
        cleaned = jsonMatch[1];
    }

    // Убираем trailing commas перед ] и }
    cleaned = cleaned
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`Не удалось распарсить JSON ответ LLM: ${e.message}`);
    }
}

module.exports = { validateQuestions, extractJSON };
