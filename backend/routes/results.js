const express = require('express');
const db = require('../db/database');

const router = express.Router();

/**
 * POST /api/results
 * Сохранение результата прохождения теста
 */
router.post('/', (req, res) => {
    const { testId, userName, answers } = req.body;

    if (!testId || !answers || !Array.isArray(answers)) {
        return res.status(400).json({
            error: 'Необходимы поля: testId, answers (массив)'
        });
    }

    // Получаем тест для проверки ответов
    const test = db.prepare('SELECT questions_json FROM tests WHERE id = ?').get(testId);

    if (!test) {
        return res.status(404).json({ error: 'Тест не найден' });
    }

    const questions = JSON.parse(test.questions_json);

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
                    isCorrect = userAnswer.answer === question.correct_answer;
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
            correctAnswer: question.correct_answer,
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
        testId,
        userName || 'Аноним',
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
        answers: JSON.parse(result.answers_json),
        questions: JSON.parse(result.questions_json),
        completedAt: result.completed_at
    });
});

module.exports = router;
