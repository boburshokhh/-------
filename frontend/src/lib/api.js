import { getToken } from '@/lib/authSession';

function normalizeApiBase(raw) {
  const base = String(raw || '/api').trim();
  if (!base) return '/api';
  if (/^https?:\/\//i.test(base)) {
    return base.replace(/\/+$/, '');
  }
  const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/api';
}

const API_BASE = normalizeApiBase(import.meta.env.VITE_API_BASE);
const LOGS_API_TOKEN = import.meta.env.VITE_LOGS_API_TOKEN || '';
const SETTINGS_API_TOKEN = import.meta.env.VITE_SETTINGS_API_TOKEN || '';

function createError(message, status, payload) {
  const err = new Error(message);
  err.status = status;
  err.payload = payload;
  err.requiresOfflineConsent = payload?.requiresOfflineConsent || false;
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
  if (status === 402) return payload?.error || 'Дневная квота исчерпана.';
  if (status === 429) return payload?.error || 'Слишком много запросов. Повторите попытку чуть позже.';
  if (status === 502) {
    return payload?.details || payload?.error || 'Временная ошибка генерации. Повторите попытку.';
  }
  if (status === 404) return payload?.error || 'Запрошенные данные не найдены.';
  if (status === 401) return payload?.error || 'Требуется войти или сессия истекла.';
  return fallback;
}

async function request(path, options = {}) {
  const { timeoutMs = 0, ...fetchOpts } = options;
  const ctrl = new AbortController();
  let timer;
  if (timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  const token = getToken();
  const headers = { ...(fetchOpts.headers || {}) };
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...fetchOpts, headers, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('Таймаут запроса к серверу');
      err.code = 'FETCH_TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    if (opts.forceOffline) formData.append('forceOffline', 'true');
    if (opts.routingMode) formData.append('routingMode', String(opts.routingMode));

    const headers = {};
    if (opts.jobId) headers['X-Job-Id'] = opts.jobId;

    return request('/upload', {
      method: 'POST',
      body: formData,
      headers,
    });
  },

  /** Предпросмотр политик маршрутизации для UI генерации (без admin). */
  getGenerationRouting(mode = 'auto') {
    const qs = new URLSearchParams();
    if (mode) qs.set('mode', String(mode));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/generation-routing${suffix}`);
  },

  getJobProgress(jobId) {
    return request(`/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 20000 });
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

  /** Дашборд: средний % и последняя попытка по каждому тесту. userName — фильтр по имени при сохранении результата */
  getResultsDashboard(userName) {
    const q = new URLSearchParams();
    if (userName && String(userName).trim()) {
      q.set('userName', String(userName).trim());
    }
    const qs = q.toString();
    return request(`/results/overview${qs ? `?${qs}` : ''}`);
  },

  getResultDetail(id) {
    return request(`/results/detail/${encodeURIComponent(id)}`);
  },

  register({ email, password, fullName }) {
    return request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName }),
    });
  },

  login({ email, password }) {
    return request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  },

  getMe() {
    return request('/auth/me');
  },

  changePassword({ currentPassword, newPassword }) {
    return request('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  // ── Admin AI routing ─────────────────────────────────────────────────────
  adminGetModels() {
    return request('/admin/ai/models');
  },

  adminSyncModels({ disableMissingFromApi = false } = {}) {
    return request('/admin/ai/models/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disableMissingFromApi }),
    });
  },

  adminPatchModel(id, patch) {
    return request(`/admin/ai/models/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
  },

  adminGetRoutingMatrix({ previewMode = 'auto', includeLastDecision = true } = {}) {
    const qs = new URLSearchParams();
    qs.set('preview_mode', previewMode || 'auto');
    qs.set('include_last_decision', includeLastDecision ? 'true' : 'false');
    return request(`/admin/ai/routing-matrix?${qs.toString()}`);
  },

  adminBulkPatchRoutingRules(items) {
    return request('/admin/ai/routing-rules/bulk-patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  },

  adminGetRoutingRules(phase, { enabledOnly = false } = {}) {
    const qs = new URLSearchParams();
    qs.set('enabled_only', enabledOnly ? 'true' : 'false');
    return request(`/admin/ai/routing-rules/${encodeURIComponent(phase)}?${qs.toString()}`);
  },

  adminCreateRoutingRule(payload) {
    return request('/admin/ai/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },

  adminUpdateRoutingRule(id, patch) {
    return request(`/admin/ai/routing-rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
  },

  adminSetRoutingRuleEnabled(id, isEnabled) {
    return request(`/admin/ai/routing-rules/${encodeURIComponent(id)}/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: !!isEnabled }),
    });
  },

  adminGetUsage(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/ai/usage${suffix}`);
  },

  adminGetRoutingMode() {
    return request('/admin/ai/routing-mode');
  },

  adminSetRoutingMode(routingMode, metadata = {}) {
    return request('/admin/ai/routing-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routing_mode: routingMode, metadata }),
    });
  },

  adminGetManualOverrides(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/ai/manual-overrides${suffix}`);
  },

  adminCreateManualOverride(payload) {
    return request('/admin/ai/manual-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },

  adminUpdateManualOverride(id, patch) {
    return request(`/admin/ai/manual-overrides/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
  },

  adminGetAudit(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/ai/audit${suffix}`);
  },

  // ── Stage Catalog ──────────────────────────────────────────────────────
  adminGetStages({ activeOnly = true } = {}) {
    const qs = activeOnly ? '' : '?active_only=false';
    return request(`/admin/ai/stages${qs}`);
  },

  adminGetStage(stageKey) {
    return request(`/admin/ai/stages/${encodeURIComponent(stageKey)}`);
  },

  // ── Global Policies ────────────────────────────────────────────────────
  adminGetGlobalPolicies() {
    return request('/admin/ai/global-policies');
  },

  adminUpdateGlobalPolicies(patch) {
    return request('/admin/ai/global-policies', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
  },

  // ── Routing Decisions ──────────────────────────────────────────────────
  adminGetRoutingDecisions(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/ai/routing-decisions${suffix}`);
  },

  adminGetRoutingDecision(id) {
    return request(`/admin/ai/routing-decisions/${encodeURIComponent(id)}`);
  },

  adminGetRoutingDecisionExplain(id) {
    return request(`/admin/ai/routing-decisions/${encodeURIComponent(id)}/explain`);
  },

  // ── Model Health ───────────────────────────────────────────────────────
  adminGetModelHealth(params = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/admin/ai/model-health${suffix}`);
  },

  adminGetModelHealthById(modelId) {
    return request(`/admin/ai/model-health/${encodeURIComponent(modelId)}`);
  },

  // ── Routing Rules by Stage Key ─────────────────────────────────────────
  adminGetRoutingRulesByStage(stageKey, { enabledOnly = true } = {}) {
    const qs = enabledOnly ? '' : '?enabled_only=false';
    return request(`/admin/ai/routing-rules-by-stage/${encodeURIComponent(stageKey)}${qs}`);
  },

  // ── Routing Tariffs ────────────────────────────────────────────────────
  adminGetRoutingProfiles() {
    return request('/admin/ai/routing-profiles');
  },

  adminUpdateRoutingProfileRule(code, stageName, payload) {
    return request(`/admin/ai/routing-profiles/${encodeURIComponent(code)}/rules/${encodeURIComponent(stageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },

  adminResolveRoutingProfile(payload) {
    return request('/admin/ai/router/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  },
};
