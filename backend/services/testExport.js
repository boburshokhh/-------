const EXPORT_SCHEMA_VERSION = 'ai_test_export.v1';

function parseMaybeJson(value, fallback) {
    if (typeof value === 'string') {
        return JSON.parse(value);
    }
    return value ?? fallback;
}

function getCorrectValue(question) {
    return question.correctIndex ?? question.correct_answer ?? question.correctAnswer ?? null;
}

function getCorrectAnswerText(question, correctValue) {
    if (question.type === 'multiple_choice') {
        const options = Array.isArray(question.options) ? question.options : [];
        const idx = Number(correctValue);
        if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
            return String(options[idx]);
        }
        return correctValue != null ? String(correctValue) : null;
    }

    if (question.type === 'true_false') {
        if (correctValue === true || correctValue === 'true') return 'Верно';
        if (correctValue === false || correctValue === 'false') return 'Неверно';
    }

    return correctValue != null ? correctValue : null;
}

function normalizeQuestionForExport(question, index) {
    const q = question && typeof question === 'object' ? question : {};
    const type = q.type || 'multiple_choice';
    const correctValue = getCorrectValue(q);
    const normalized = {
        ...q,
        id: q.id ?? index + 1,
        type,
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        correct_answer: q.correct_answer ?? correctValue,
        correctIndex: q.correctIndex ?? correctValue,
        correctAnswerText: getCorrectAnswerText({ ...q, type }, correctValue),
        hint: q.hint || '',
        explanation: q.explanation || '',
        difficulty: q.difficulty || null,
        sourceChunkId: q.sourceChunkId ?? null,
        sources: Array.isArray(q.sources) ? q.sources : [],
    };

    return normalized;
}

function buildTestExportPayload(test) {
    const questions = parseMaybeJson(test.questions_json, []);
    const generationMetrics = parseMaybeJson(test.generation_metrics, null);
    const parseDiagnostics = parseMaybeJson(test.parse_diagnostics, null);
    const normalizedQuestions = Array.isArray(questions)
        ? questions.map(normalizeQuestionForExport)
        : [];

    return {
        schema_version: EXPORT_SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        test: {
            id: test.id,
            title: test.title,
            totalQuestions: test.total_questions ?? normalizedQuestions.length,
            createdAt: test.created_at,
            document: {
                name: test.document_name || null,
                pageCount: test.page_count ?? null,
                extractionQuality: test.extraction_quality ?? null,
                lowTextQuality: !!test.low_text_quality,
                parseDiagnostics,
            },
        },
        questions: normalizedQuestions,
        generationMetrics,
    };
}

module.exports = {
    EXPORT_SCHEMA_VERSION,
    buildTestExportPayload,
};
