const express = require('express');
const testRepo = require('../db/repositories/testRepo');
const resultRepo = require('../db/repositories/resultRepo');

const router = express.Router();
const MAX_USER_NAME_LENGTH = 120;

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

router.post('/', async (req, res, next) => {
    try {
        const { testId, userName, answers } = req.body;
        const numericTestId = Number(testId);

        if (!Number.isInteger(numericTestId) || numericTestId <= 0) {
            return res.status(400).json({ error: 'testId должен быть положительным целым числом' });
        }

        const answersError = validateAnswers(answers);
        if (answersError) {
            return res.status(400).json({ error: answersError });
        }

        const safeUserName = typeof userName === 'string' ? userName.trim() : '';
        if (safeUserName.length > MAX_USER_NAME_LENGTH) {
            return res.status(400).json({ error: `userName слишком длинный (макс. ${MAX_USER_NAME_LENGTH} символов)` });
        }

        const test = await testRepo.getTestById(numericTestId);
        if (!test) {
            return res.status(404).json({ error: 'Тест не найден' });
        }

        const questionsRaw = test.questions_json;
        const questions = typeof questionsRaw === 'string' ? JSON.parse(questionsRaw) : (questionsRaw || []);
        if (!Array.isArray(questions) || !questions.length) {
            return res.status(422).json({ error: 'Тест поврежден: не удалось прочитать вопросы' });
        }

        let score = 0;
        const maxScore = questions.length;
        const detailedAnswers = [];

        for (const question of questions) {
            const userAnswer = answers.find(a => a.questionId === question.id);
            let isCorrect = false;

            if (userAnswer) {
                if (question.type === 'multiple_choice') {
                    isCorrect = userAnswer.answer === (question.correctIndex ?? question.correct_answer);
                } else if (question.type === 'true_false') {
                    isCorrect = userAnswer.answer === question.correct_answer;
                }
            }
            if (isCorrect) score++;

            detailedAnswers.push({
                questionId: question.id,
                userAnswer: userAnswer ? userAnswer.answer : null,
                correctAnswer: question.correctIndex ?? question.correct_answer,
                isCorrect,
                explanation: question.explanation,
            });
        }

        const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100 * 10) / 10 : 0;

        const result = await resultRepo.insertResult({
            test_id: numericTestId,
            user_name: safeUserName || 'Аноним',
            answers: detailedAnswers,
            score,
            max_score: maxScore,
            percentage,
        });

        res.status(201).json({
            resultId: result.id,
            score,
            maxScore,
            percentage,
            answers: detailedAnswers,
        });
    } catch (e) {
        next(e);
    }
});

router.get('/:testId', async (req, res, next) => {
    try {
        const results = await resultRepo.getResultsByTestId(req.params.testId);
        res.json({ results });
    } catch (e) {
        next(e);
    }
});

router.get('/detail/:id', async (req, res, next) => {
    try {
        const result = await resultRepo.getResultDetailById(req.params.id);
        if (!result) {
            return res.status(404).json({ error: 'Результат не найден' });
        }

        const questionsRaw = result.questions_json;
        const questions = typeof questionsRaw === 'string' ? JSON.parse(questionsRaw) : (questionsRaw || []);
        const answersRaw = result.answers_json;
        const answers = typeof answersRaw === 'string' ? JSON.parse(answersRaw) : (answersRaw || []);

        res.json({
            id: result.id,
            testTitle: result.test_title,
            userName: result.user_name,
            score: result.score,
            maxScore: result.max_score,
            percentage: result.percentage,
            answers,
            questions,
            completedAt: result.completed_at,
        });
    } catch (e) {
        next(e);
    }
});

module.exports = router;
