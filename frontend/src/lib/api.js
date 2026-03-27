const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const LOGS_API_TOKEN = import.meta.env.VITE_LOGS_API_TOKEN || '';
const SETTINGS_API_TOKEN = import.meta.env.VITE_SETTINGS_API_TOKEN || '';

function createError(message, status, payload) {
  const err = new Error(message);
  err.status = status;
  err.payload = payload;
  return err;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function mapHttpError(status, payload) {
  const fallback = payload?.details || payload?.error || 'Ошибка запроса';
  if (status === 413) return 'Файл слишком большой или превышен лимит страниц.';
  if (status === 415) return 'Неподдерживаемый формат файла. Используйте PDF.';
  if (status === 422) return 'Документ не удалось обработать. Проверьте содержимое файла.';
  if (status === 429) return 'Слишком много запросов. Повторите попытку чуть позже.';
  if (status === 502) return 'Временная ошибка генерации. Повторите попытку.';
  if (status === 404) return payload?.error || 'Запрошенные данные не найдены.';
  return fallback;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  const payload = await parseJson(response);
  if (!response.ok) {
    throw createError(mapHttpError(response.status, payload), response.status, payload);
  }
  return payload;
}

export function createClientJobId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const API = {
  BASE: API_BASE,

  upload(file, opts = {}) {
    const formData = new FormData();
    formData.append('file', file);
    if (opts.modelId) formData.append('model', opts.modelId);

    const headers = {};
    if (opts.jobId) headers['X-Job-Id'] = opts.jobId;

    return request('/upload', {
      method: 'POST',
      body: formData,
      headers,
    });
  },

  getJobProgress(jobId) {
    return request(`/jobs/${encodeURIComponent(jobId)}`);
  },

  async getModels() {
    try {
      return await request('/models');
    } catch {
      return { models: [], defaultModel: '' };
    }
  },

  getHealth() {
    return request('/health');
  },

  getLogs(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const query = new URLSearchParams({ limit: String(safeLimit) });
    const headers = {};
    if (LOGS_API_TOKEN) {
      headers['X-Logs-Token'] = LOGS_API_TOKEN;
    }
    return request(`/logs?${query.toString()}`, { headers });
  },

  getRuntimeSettings() {
    const headers = {};
    if (SETTINGS_API_TOKEN) {
      headers['X-Settings-Token'] = SETTINGS_API_TOKEN;
    }
    return request('/_hidden/settings/runtime', { headers });
  },

  setGeminiApiKey(geminiApiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (SETTINGS_API_TOKEN) {
      headers['X-Settings-Token'] = SETTINGS_API_TOKEN;
    }
    return request('/_hidden/settings/gemini-key', {
      method: 'POST',
      headers,
      body: JSON.stringify({ geminiApiKey }),
    });
  },

  getTests() {
    return request('/tests');
  },

  getTest(id) {
    return request(`/tests/${encodeURIComponent(id)}`);
  },

  deleteTest(id) {
    return request(`/tests/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  submitResults(testId, userName, answers) {
    return request('/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testId, userName, answers }),
    });
  },

  getResults(testId) {
    return request(`/results/${encodeURIComponent(testId)}`);
  },

  getResultDetail(id) {
    return request(`/results/detail/${encodeURIComponent(id)}`);
  },
};
