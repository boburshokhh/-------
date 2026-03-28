import { reactive, computed } from 'vue';

const state = reactive({
  models: [],
  defaultModel: '',
  selectedModel: '',
  upload: {
    file: null,
    status: 'idle',
    error: '',
    jobId: '',
    progress: {
      phase: '',
      stage: '',
      percent: 0,
      detail: '',
      updatedAt: 0,
      volumeReady: false,
      workDone: 0,
      workTotal: null,
      history: [],
    },
    testId: null,
    generationMetrics: null,
  },
  tests: [],
  testsLoading: false,
  testsError: '',
  activeTest: null,
  activeTestLoading: false,
  activeTestError: '',
  answers: {},
  userName: '',
  resultSummary: null,
  resultDetail: null,
  resultError: '',
  diagnostics: {
    health: null,
    healthError: '',
    logs: [],
    logsError: '',
    logsUpdatedAt: 0,
  },
});

const STORAGE_KEY = 'aa_front_state_v1';

function persistState() {
  try {
    const snapshot = {
      jobId: state.upload.jobId,
      testId: state.upload.testId,
      selectedModel: state.selectedModel,
      userName: state.userName,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage errors
  }
}

function restoreState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const snapshot = JSON.parse(raw);
    if (snapshot.jobId) state.upload.jobId = snapshot.jobId;
    if (snapshot.testId) state.upload.testId = snapshot.testId;
    if (snapshot.selectedModel) state.selectedModel = snapshot.selectedModel;
    if (snapshot.userName) state.userName = snapshot.userName;
  } catch {
    // ignore invalid snapshot
  }
}

restoreState();

const getters = {
  answeredCount: computed(() => Object.values(state.answers).filter((v) => v !== null && typeof v !== 'undefined').length),
  totalQuestions: computed(() => state.activeTest?.questions?.length || 0),
  progressPercent: computed(() => {
    const total = getters.totalQuestions.value;
    if (!total) return 0;
    return Math.round((getters.answeredCount.value / total) * 100);
  }),
};

export function useAppStore() {
  const actions = {
    setModels(payload) {
      state.models = payload?.models || [];
      state.defaultModel = payload?.defaultModel || '';
      if (!state.selectedModel && state.defaultModel) {
        state.selectedModel = state.defaultModel;
      }
      persistState();
    },

    setSelectedModel(modelId) {
      state.selectedModel = modelId || '';
      persistState();
    },

    startUpload(file, jobId) {
      state.upload.file = file;
      state.upload.status = 'uploading';
      state.upload.error = '';
      state.upload.jobId = jobId;
      state.upload.progress = {
        phase: 'upload',
        stage: 'sending',
        percent: 0,
        detail: 'Загрузка файла на сервер…',
        updatedAt: Date.now(),
        volumeReady: false,
        workDone: 0,
        workTotal: null,
        history: [],
      };
      persistState();
    },

    setUploadProgress(progress) {
      const p = progress && typeof progress === 'object' ? progress : {};
      state.upload.progress = {
        phase: p.phase || '',
        stage: p.stage || '',
        percent: Number(p.percent || 0),
        detail: p.detail || '',
        updatedAt: p.updatedAt || Date.now(),
        volumeReady: p.volumeReady === true,
        workDone: Number(p.workDone ?? 0),
        workTotal: p.workTotal != null && p.workTotal !== '' ? Number(p.workTotal) : null,
        history: Array.isArray(p.history) ? p.history : [],
      };
      state.upload.status = state.upload.progress.phase === 'error' ? 'error' : 'processing';
      persistState();
    },

    finishUpload(payload) {
      state.upload.status = 'done';
      state.upload.error = '';
      state.upload.testId = payload?.testId ?? null;
      state.upload.generationMetrics = payload?.generationMetrics ?? null;
      state.upload.progress = {
        phase: 'done',
        stage: 'saved_test',
        percent: 100,
        detail: 'Тест успешно сгенерирован',
        updatedAt: Date.now(),
        volumeReady: true,
        workDone: state.upload.progress.workTotal ?? 0,
        workTotal: state.upload.progress.workTotal,
        history: state.upload.progress.history || [],
      };
      persistState();
    },

    failUpload(message) {
      state.upload.status = 'error';
      state.upload.error = message || 'Не удалось обработать документ';
      persistState();
    },

    setTestsLoading(isLoading) {
      state.testsLoading = !!isLoading;
    },

    setTests(tests) {
      state.tests = tests || [];
      state.testsError = '';
    },

    setTestsError(message) {
      state.testsError = message || 'Ошибка загрузки тестов';
    },

    removeTest(id) {
      state.tests = state.tests.filter((t) => t.id !== id);
    },

    setActiveTestLoading(isLoading) {
      state.activeTestLoading = !!isLoading;
    },

    setActiveTest(test) {
      state.activeTest = test;
      state.activeTestError = '';
      state.answers = {};
      (test?.questions || []).forEach((q) => {
        state.answers[q.id] = null;
      });
      if (test?.id) {
        state.upload.testId = test.id;
      }
      persistState();
    },

    setActiveTestError(message) {
      state.activeTestError = message || 'Ошибка загрузки теста';
    },

    setAnswer(questionId, answer) {
      state.answers[questionId] = answer;
    },

    setUserName(name) {
      state.userName = name || '';
      persistState();
    },

    setResultSummary(summary) {
      state.resultSummary = summary;
      state.resultError = '';
    },

    setResultDetail(detail) {
      state.resultDetail = detail;
      state.resultError = '';
    },

    setResultError(message) {
      state.resultError = message || 'Ошибка загрузки результата';
    },

    setHealth(payload) {
      state.diagnostics.health = payload || null;
      state.diagnostics.healthError = '';
    },

    setHealthError(message) {
      state.diagnostics.healthError = message || 'Не удалось получить статус сервиса';
    },

    setLogs(logs) {
      state.diagnostics.logs = Array.isArray(logs) ? logs : [];
      state.diagnostics.logsError = '';
      state.diagnostics.logsUpdatedAt = Date.now();
    },

    setLogsError(message) {
      state.diagnostics.logsError = message || 'Не удалось получить логи';
    },
  };

  return {
    state,
    getters,
    actions,
  };
}
