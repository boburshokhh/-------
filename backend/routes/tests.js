const express = require('express');
const db = require('../db/database');

const router = express.Router();

/**
 * GET /api/tests
 * Получение списка всех тестов
 */
router.get('/', (req, res) => {
    const tests = db.prepare(`
    SELECT t.id, t.title, t.total_questions, t.created_at,
           d.original_name AS document_name, d.page_count
    FROM tests t
    LEFT JOIN documents d ON t.document_id = d.id
    ORDER BY t.created_at DESC
  `).all();

    res.json({ tests });
});

/**
 * GET /api/tests/:id
 * Получение конкретного теста с вопросами
 */
router.get('/:id', (req, res) => {
    const test = db.prepare(`
    SELECT t.id, t.title, t.questions_json, t.total_questions, t.created_at,
           d.original_name AS document_name, d.page_count
    FROM tests t
    LEFT JOIN documents d ON t.document_id = d.id
    WHERE t.id = ?
  `).get(req.params.id);

    if (!test) {
        return res.status(404).json({ error: 'Тест не найден' });
    }

    res.json({
        id: test.id,
        title: test.title,
        questions: JSON.parse(test.questions_json),
        totalQuestions: test.total_questions,
        documentName: test.document_name,
        pageCount: test.page_count,
        createdAt: test.created_at
    });
});

/**
 * DELETE /api/tests/:id
 * Удаление теста
 */
router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM tests WHERE id = ?').run(req.params.id);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Тест не найден' });
    }

    res.json({ success: true });
});

module.exports = router;
