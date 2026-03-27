const express = require('express');
const db = require('../db/database');

const router = express.Router();
const MAX_USER_NAME_LENGTH = 120;

function parseJsonSafe(raw, fallback) {
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function validateAnswers(answers) {
    if (!Array.isArray(answers)) return 'Поле answers должно быть массивом';
    if (!answers.length) return 'Поле answers не должно быть пустым';
    if (answers.length > 500) return 'Слишком много ответов в одном запросе';
    for (const row of answers) {
        if (!row || typeof row !== 'object') return 'Каждый ответ должен быть объектом';
        const qid = Number(row.questionId);
        if (!Number.isInteger(qid) || qid <= 0) return 'questionId должен быть положительным целым числом';
        const kind = typeof row.answer;
        const isArray = Array.isArray(row.answer);
        if (row.answer == null || isArray || !['number', 'boolean', 'string'].includes(kind)) {
            return 'answer должен быть number, boolean или string';
        }
        if (kind === 'string' && row.answer.length > 2000) {
            return 'Текстовый answer слишком длинный (макс. 2000 символов)';
        }
    }
    return null;
}

/**
 * POST /api/results
 * Сохранение результата прохождения теста
 */
router.post('/', (req, res) => {
    const { testId, userName, answers } = req.body;
    const numericTestId = Number(testId);

    if (!Number.isInteger(numericTestId) || numericTestId <= 0) {
        return res.status(400).json({ error: 'testId должен быть положительным целым числом' });
    }

    const answersError = validateAnswers(answers);
    if (answersError) {
        return res.status(400).json({
            error: answersError
        });
    }

    const safeUserName = typeof userName === 'string' ? userName.trim() : '';
    if (safeUserName.length > MAX_USER_NAME_LENGTH) {
        return res.status(400).json({
            error: `userName слишком длинный (макс. ${MAX_USER_NAME_LENGTH} символов)`
        });
    }

    // Получаем тест для проверки ответов
    const test = db.prepare('SELECT questions_json FROM tests WHERE id = ?').get(numericTestId);

    if (!test) {
        return res.status(404).json({ error: 'Тест не найден' });
    }

    const questions = parseJsonSafe(test.questions_json, []);
    if (!Array.isArray(questions) || !questions.length) {
        return res.status(422).json({ error: 'Тест поврежден: не удалось прочитать вопросы' });
    }

    // Подсчёт баллов
    let score = 0;
    const maxScore = questions.length;
    const detailedAnswers = [];

    for (const question of questions) {
        const userAnswer = answers.find(a => a.questionId === question.id);
        let isCorrect = false;

        if (userAnswer) {
            switch (question.type) {
                case 'multiple_choice':
                    isCorrect = userAnswer.answer === (question.correctIndex ?? question.correct_answer);
                    break;
                case 'true_false':
                    isCorrect = userAnswer.answer === question.correct_answer;
                    break;
                case 'open_ended':
                    // Для открытых вопросов — всегда засчитываем как ответ, оценка вручную
                    isCorrect = false; // Требует ручной проверки
                    break;
            }
        }

        if (isCorrect) score++;

        detailedAnswers.push({
            questionId: question.id,
            userAnswer: userAnswer ? userAnswer.answer : null,
            correctAnswer: question.correctIndex ?? question.correct_answer,
            isCorrect,
            explanation: question.explanation
        });
    }

    const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100 * 10) / 10 : 0;

    // Сохраняем результат
    const insert = db.prepare(`
    INSERT INTO results (test_id, user_name, answers_json, score, max_score, percentage)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

    const result = insert.run(
        numericTestId,
        safeUserName || 'Аноним',
        JSON.stringify(detailedAnswers),
        score,
        maxScore,
        percentage
    );

    res.status(201).json({
        resultId: Number(result.lastInsertRowid),
        score,
        maxScore,
        percentage,
        answers: detailedAnswers
    });
});

/**
 * GET /api/results/:testId
 * Получение всех результатов для теста
 */
router.get('/:testId', (req, res) => {
    const results = db.prepare(`
    SELECT id, user_name, score, max_score, percentage, completed_at
    FROM results
    WHERE test_id = ?
    ORDER BY completed_at DESC
  `).all(req.params.testId);

    res.json({ results });
});

/**
 * GET /api/results/detail/:id
 * Детальный результат
 */
router.get('/detail/:id', (req, res) => {
    const result = db.prepare(`
    SELECT r.*, t.title AS test_title, t.questions_json
    FROM results r
    JOIN tests t ON r.test_id = t.id
    WHERE r.id = ?
  `).get(req.params.id);

    if (!result) {
        return res.status(404).json({ error: 'Результат не найден' });
    }

    res.json({
        id: result.id,
        testTitle: result.test_title,
        userName: result.user_name,
        score: result.score,
        maxScore: result.max_score,
        percentage: result.percentage,
        answers: parseJsonSafe(result.answers_json, []),
        questions: parseJsonSafe(result.questions_json, []),
        completedAt: result.completed_at
    });
});

module.exports = router;
