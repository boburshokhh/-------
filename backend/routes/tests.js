const express = require('express');
const testRepo = require('../db/repositories/testRepo');

const router = express.Router();

router.get('/', async (req, res, next) => {
    try {
        const tests = await testRepo.getAllTests();
        res.json({ tests });
    } catch (e) {
        next(e);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const test = await testRepo.getTestById(req.params.id);
        if (!test) {
            return res.status(404).json({ error: 'Тест не найден' });
        }

        const questionsJson = test.questions_json;
        const questions = typeof questionsJson === 'string' ? JSON.parse(questionsJson) : (questionsJson || []);
        const generationMetrics = test.generation_metrics || null;
        const parseDiagnostics = test.parse_diagnostics || null;

        res.json({
            id: test.id,
            title: test.title,
            questions,
            totalQuestions: test.total_questions,
            documentName: test.document_name,
            pageCount: test.page_count,
            extractionQuality: test.extraction_quality,
            lowTextQuality: !!test.low_text_quality,
            parseDiagnostics,
            generationMetrics,
            createdAt: test.created_at,
        });
    } catch (e) {
        next(e);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const deleted = await testRepo.deleteTest(req.params.id);
        if (deleted === 0) {
            return res.status(404).json({ error: 'Тест не найден' });
        }
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
});

module.exports = router;
