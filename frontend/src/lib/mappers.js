function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function mapTestListItem(row) {
  return {
    id: row.id,
    status: 'ready',
    date: formatDate(row.created_at),
    title: row.title,
    questions: row.total_questions || 0,
    progressPercent: 0,
    documentName: row.document_name || 'Без названия',
    pageCount: row.page_count ?? null,
    extractionQuality: row.extraction_quality ?? null,
    lowTextQuality: !!row.low_text_quality,
  };
}

export function mapQuestion(question, idx) {
  const options = Array.isArray(question.options) ? question.options : [];
  const type = question.type || (typeof question.correct_answer === 'boolean' ? 'true_false' : 'multiple_choice');

  const normalizedOptions = type === 'true_false'
    ? [
      { id: 'true', text: 'Верно', value: true },
      { id: 'false', text: 'Неверно', value: false },
    ]
    : options.map((text, optionIdx) => ({
      id: String.fromCharCode(97 + optionIdx),
      text: String(text),
      value: optionIdx,
    }));

  return {
    id: question.id ?? idx + 1,
    type,
    text: question.question || '',
    explanation: question.explanation || '',
    options: normalizedOptions,
  };
}

export function mapTestDetail(payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const questions = Array.isArray(safePayload.questions) ? safePayload.questions : [];
  const mappedQuestions = questions.map(mapQuestion);
  return {
    id: safePayload.id ?? null,
    title: safePayload.title || 'Тест',
    topic: safePayload.documentName ? `Документ: ${safePayload.documentName}` : 'Сгенерированный тест',
    questions: mappedQuestions,
    totalQuestions: safePayload.totalQuestions || mappedQuestions.length,
    generationMetrics: safePayload.generationMetrics || null,
    createdAt: safePayload.createdAt || null,
    documentName: safePayload.documentName || null,
    pageCount: safePayload.pageCount ?? null,
    extractionQuality: safePayload.extractionQuality ?? null,
    lowTextQuality: !!safePayload.lowTextQuality,
    parseDiagnostics: safePayload.parseDiagnostics || null,
  };
}

export function mapSubmitAnswersPayload(testDetail, answersMap) {
  const result = [];
  const entries = Object.entries(answersMap || {});
  for (const [questionId, answer] of entries) {
    if (answer === null || typeof answer === 'undefined') continue;
    result.push({
      questionId: Number(questionId),
      answer,
    });
  }
  return {
    testId: testDetail.id,
    answers: result,
  };
}

/**
 * Текст ответа для карточки разбора: индекс варианта → текст из options; boolean → Верно/Неверно.
 */
function formatAnswerForDisplay(value, question) {
  if (value === null || typeof value === 'undefined' || value === '') return '—';
  if (typeof value === 'boolean') {
    return value ? 'Верно' : 'Неверно';
  }
  const type = question?.type || 'multiple_choice';
  if (type === 'true_false' && (value === 'true' || value === 'false')) {
    return value === 'true' ? 'Верно' : 'Неверно';
  }
  const options = Array.isArray(question?.options) ? question.options : [];
  if (typeof value === 'number' && Number.isFinite(value)) {
    const idx = Math.trunc(value);
    if (idx >= 0 && idx < options.length) {
      return String(options[idx]);
    }
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function mapResultSummary(payload, testDetail, userName = 'Пользователь') {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const maxScore = safePayload.maxScore || 0;
  const score = safePayload.score || 0;
  const correct = Array.isArray(safePayload.answers) ? safePayload.answers.filter((a) => a.isCorrect).length : score;
  const wrong = Math.max(0, maxScore - correct);
  return {
    resultId: safePayload.resultId,
    testId: testDetail?.id != null ? Number(testDetail.id) : null,
    score: safePayload.percentage || 0,
    label: 'Достигнутый балл',
    name: userName,
    quizName: testDetail?.title || 'Тест',
    stats: [
      { icon: 'check_circle', label: 'Правильных ответов', value: `${correct} / ${maxScore}`, bg: 'bg-[#E8F5E9]', iconColor: 'text-[#2E7D32]' },
      { icon: 'cancel', label: 'Неправильных', value: String(wrong), bg: 'bg-[#FFEBEE]', iconColor: 'text-[#C62828]' },
      { icon: 'workspace_premium', label: 'Баллы', value: `${score} / ${maxScore}`, bg: 'bg-[#DDE1FF]', iconColor: 'text-[#2747B6]' },
    ],
    aiFeedback: 'Результат сформирован на основе ваших ответов. Изучите детальный разбор, чтобы закрепить сложные темы.',
    strength: 'Темы с высоким процентом верных ответов',
    improve: 'Темы с ошибками и пропусками',
    breakdown: [],
    completedAt: safePayload.completedAt || null,
    raw: safePayload,
  };
}

export function mapResultDetail(payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const questions = Array.isArray(safePayload.questions) ? safePayload.questions : [];
  const answers = Array.isArray(safePayload.answers) ? safePayload.answers : [];
  const byQuestionId = new Map();
  questions.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const id = q.id;
    if (id != null && id !== '') {
      byQuestionId.set(id, q);
      const n = Number(id);
      if (!Number.isNaN(n)) byQuestionId.set(n, q);
    } else {
      byQuestionId.set(i + 1, q);
    }
  });

  const items = answers.map((a, idx) => {
    const qid = a.questionId;
    let q = byQuestionId.get(qid);
    if (!q && qid != null) {
      const n = Number(qid);
      if (!Number.isNaN(n)) q = byQuestionId.get(n);
    }
    if (!q) q = questions[idx] || {};
    return {
      id: a.questionId ?? idx + 1,
      status: a.isCorrect ? 'correct' : 'incorrect',
      text: q.question || 'Вопрос',
      yourAnswer: formatAnswerForDisplay(a.userAnswer, q),
      correctAnswer: formatAnswerForDisplay(a.correctAnswer, q),
      reasoning: a.explanation || 'Объяснение отсутствует.',
    };
  });

  return {
    score: safePayload.percentage || 0,
    grade: safePayload.percentage >= 90 ? 'Отлично' : safePayload.percentage >= 70 ? 'Хорошо' : 'Нужно повторить',
    correct: items.filter((i) => i.status === 'correct').length,
    total: items.length,
    quiz: safePayload.testTitle || 'Разбор теста',
    questions: items,
    testTitle: safePayload.testTitle || 'Тест',
    userName: safePayload.userName || 'Аноним',
    completedAt: safePayload.completedAt || null,
  };
}
