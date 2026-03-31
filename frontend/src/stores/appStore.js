import { reactive, computed } from 'vue';

const state = reactive({
  models: [],
  defaultModel: '',
  /** Пустая строка = авто-выбор модели сервером */
  selectedModel: '',
  /** 'auto' | 'manual' — ручной выбор конкретной модели из списка */
  modelChoiceMode: 'auto',
  /** Режим маршрутизации для запроса: auto | economy | balanced | quality | manual */
  routingModeUser: 'auto',
  /** Публичный список доступных режимов (включая кастомные) */
  availableModes: [],
  /** Последний снимок GET /api/generation-routing */
  generationRouting: null,
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
    /** Снимок маршрутизации на момент завершения (дублирует часть generationMetrics) */
    routingSummary: null,
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
      modelChoiceMode: state.modelChoiceMode,
      routingModeUser: state.routingModeUser,
      availableModes: state.availableModes,
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
    if (snapshot.modelChoiceMode === 'auto' || snapshot.modelChoiceMode === 'manual') {
      state.modelChoiceMode = snapshot.modelChoiceMode;
    } else if (snapshot.selectedModel) {
      state.modelChoiceMode = 'manual';
    }
    if (snapshot.routingModeUser) state.routingModeUser = snapshot.routingModeUser;
    if (Array.isArray(snapshot.availableModes)) state.availableModes = snapshot.availableModes;
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
      if (!state.selectedModel && state.modelChoiceMode === 'manual' && state.defaultModel) {
        state.selectedModel = state.defaultModel;
      }
      persistState();
    },

    setSelectedModel(modelId) {
      state.selectedModel = modelId || '';
      persistState();
    },

    setModelChoice(mode, modelId) {
      state.modelChoiceMode = mode === 'manual' ? 'manual' : 'auto';
      state.selectedModel = modelId || '';
      persistState();
    },

    setRoutingModeUser(mode) {
      state.routingModeUser = mode || 'auto';
      persistState();
    },

    setAvailableModes(modes) {
      state.availableModes = Array.isArray(modes) ? modes : [];
      // Если сохранён кастомный режим, которого уже нет в публичном списке — сбрасываем в auto.
      const current = String(state.routingModeUser || 'auto');
      const builtin = ['auto', 'economy', 'balanced', 'quality', 'manual'];
      const known = new Set([
        ...builtin,
        ...state.availableModes.map((m) => String(m?.code || '').trim().toLowerCase()).filter(Boolean),
      ]);
      if (!known.has(current)) {
        state.routingModeUser = 'auto';
      }
      persistState();
    },

    setGenerationRouting(payload) {
      state.generationRouting = payload && typeof payload === 'object' ? payload : null;
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
      const gm = payload?.generationMetrics;
      state.upload.routingSummary = gm
        ? {
            routing_mode_requested: gm.routing_mode_requested,
            routing_mode_effective: gm.routing_mode_effective,
            pipeline_execution_mode: gm.pipeline_execution_mode,
            models_by_agent: gm.models_by_agent,
            degraded_reasons: gm.degraded_reasons,
            quota_offline: gm.quota_offline,
          }
        : null;
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
