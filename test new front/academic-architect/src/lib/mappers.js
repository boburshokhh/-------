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
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const mappedQuestions = questions.map(mapQuestion);
  return {
    id: payload.id,
    title: payload.title || 'Тест',
    topic: payload.documentName ? `Документ: ${payload.documentName}` : 'Сгенерированный тест',
    questions: mappedQuestions,
    totalQuestions: payload.totalQuestions || mappedQuestions.length,
    generationMetrics: payload.generationMetrics || null,
    createdAt: payload.createdAt || null,
    documentName: payload.documentName || null,
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

export function mapResultSummary(payload, testDetail, userName = 'Пользователь') {
  const maxScore = payload.maxScore || 0;
  const score = payload.score || 0;
  const correct = Array.isArray(payload.answers) ? payload.answers.filter((a) => a.isCorrect).length : score;
  const wrong = Math.max(0, maxScore - correct);
  return {
    resultId: payload.resultId,
    score: payload.percentage || 0,
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
    raw: payload,
  };
}

export function mapResultDetail(payload) {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const byQuestionId = new Map(questions.map((q) => [q.id, q]));

  const items = answers.map((a, idx) => {
    const q = byQuestionId.get(a.questionId) || {};
    return {
      id: a.questionId ?? idx + 1,
      status: a.isCorrect ? 'correct' : 'incorrect',
      text: q.question || 'Вопрос',
      yourAnswer: typeof a.userAnswer === 'boolean' ? (a.userAnswer ? 'Верно' : 'Неверно') : String(a.userAnswer ?? '—'),
      correctAnswer: typeof a.correctAnswer === 'boolean' ? (a.correctAnswer ? 'Верно' : 'Неверно') : String(a.correctAnswer ?? '—'),
      reasoning: a.explanation || 'Объяснение отсутствует.',
    };
  });

  return {
    score: payload.percentage || 0,
    grade: payload.percentage >= 90 ? 'Отлично' : payload.percentage >= 70 ? 'Хорошо' : 'Нужно повторить',
    correct: items.filter((i) => i.status === 'correct').length,
    total: items.length,
    quiz: payload.testTitle || 'Разбор теста',
    questions: items,
    testTitle: payload.testTitle || 'Тест',
    userName: payload.userName || 'Аноним',
    completedAt: payload.completedAt || null,
  };
}
