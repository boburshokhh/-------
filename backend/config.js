const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const {
    DOCUMENT_UPLOAD_MAX_PAGES,
    DOCUMENT_UPLOAD_MAX_FILE_MB,
    DOCUMENT_UPLOAD_MAX_FILE_BYTES,
} = require('./utils/uploadLimits');

const dataDir = process.env.DATA_DIR || __dirname;

/** MinIO SDK ждёт только хост/IP, без схемы (http://) и без пути */
function normalizeMinioEndpoint(raw) {
  const s = String(raw || 'localhost').trim();
  if (!s) return 'localhost';
  return s.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0] || 'localhost';
}

/** Окно и потолок для express-rate-limit (общий API vs админка — раздельно). */
function parseRateLimitWindow() {
  const w = parseInt(process.env.API_RATE_LIMIT_WINDOW_MS, 10);
  return Number.isFinite(w) && w >= 60_000 ? w : 15 * 60 * 1000;
}
function parseRateMax(envVal, fallback) {
  const n = parseInt(envVal, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Положительное число или null (без лимита): 0, пустая строка, unlimited → null */
function parseOptionalPositiveLimit(envVal, fallback = null) {
  if (envVal === undefined) return fallback;
  const raw = String(envVal).trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'unlimited' || raw === 'none' || raw === 'off') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3002,
  /** Лимит запросов к публичному API за окно (по умолчанию 100 / 15 мин). */
  API_RATE_LIMIT_WINDOW_MS: parseRateLimitWindow(),
  API_RATE_LIMIT_MAX: parseRateMax(process.env.API_RATE_LIMIT_MAX, 100),
  /** Админка дергает много эндпоинтов параллельно — отдельный более высокий потолок. */
  ADMIN_API_RATE_LIMIT_MAX: parseRateMax(process.env.ADMIN_API_RATE_LIMIT_MAX, 800),
  /** Лимит POST /api/upload за окно (по умолчанию 30 / 15 мин). */
  UPLOAD_RATE_LIMIT_WINDOW_MS: (() => {
    const w = parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 10);
    return Number.isFinite(w) && w >= 60_000 ? w : 15 * 60 * 1000;
  })(),
  UPLOAD_RATE_LIMIT_MAX: parseRateMax(process.env.UPLOAD_RATE_LIMIT_MAX, 30),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  /** Жёсткий потолок размера файла (МБ), см. utils/uploadLimits.js */
  MAX_FILE_SIZE_MB: DOCUMENT_UPLOAD_MAX_FILE_MB,
  MAX_FILE_SIZE_BYTES: DOCUMENT_UPLOAD_MAX_FILE_BYTES,
  CHUNK_TOKEN_LIMIT: parseInt(process.env.CHUNK_TOKEN_LIMIT) || 2500,
  CHUNK_OVERLAP_TOKENS: parseInt(process.env.CHUNK_OVERLAP_TOKENS) || 200,
  UPLOAD_DIR: path.join(dataDir, 'uploads'),
  DB_PATH: path.join(dataDir, 'data.db'),
  ALLOWED_MIMES: [
    'application/pdf'
  ],

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  DB_CLIENT: process.env.DB_CLIENT || 'postgres',
  DATABASE_URL: String(process.env.DATABASE_URL || '').trim(),
  PGHOST: process.env.PGHOST || 'localhost',
  PGPORT: parseInt(process.env.PGPORT) || 5432,
  PGDATABASE: process.env.PGDATABASE || 'ai_testgen',
  PGUSER: process.env.PGUSER || 'ai_testgen',
  PGPASSWORD: process.env.PGPASSWORD || '',
  PG_MAX_POOL: parseInt(process.env.PG_MAX_POOL) || 10,

  // ── MinIO / Object Storage ───────────────────────────────────────────────
  STORAGE_BACKEND: process.env.STORAGE_BACKEND || 'local',
  MINIO_ENDPOINT: normalizeMinioEndpoint(process.env.MINIO_ENDPOINT || 'localhost'),
  MINIO_PORT: parseInt(process.env.MINIO_PORT) || 9000,
  MINIO_USE_SSL: process.env.MINIO_USE_SSL === 'true',
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || '',
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || '',
  MINIO_BUCKET: process.env.MINIO_BUCKET || 'ai-testgen-docs',
  /** Жёсткий потолок страниц PDF, см. utils/uploadLimits.js */
  MAX_PAGES: DOCUMENT_UPLOAD_MAX_PAGES,
  QUESTIONS_PER_CHUNK: parseInt(process.env.QUESTIONS_PER_CHUNK, 10) || 4,
  CHAR_LENGTH_PER_QUESTION: parseInt(process.env.CHAR_LENGTH_PER_QUESTION, 10) || 2000,
  LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.5-flash',
  LLM_FAST_MODEL: process.env.LLM_FAST_MODEL || 'gemini-1.5-flash',
  /** Free tier (ориентир для отображения; сверяйте с AI Studio для своего ключа) */
  GEMINI_QUOTA_TIER: 'free',
  /**
   * Локальная блокировка по RPM/RPD до лимитов Google (учёт в БД).
   * По умолчанию выключено: при платном/высоком тарифе лимиты редко упираются, режет только искусственно.
   * Включить: LOCAL_GEMINI_QUOTA_ENABLED=true
   */
  LOCAL_GEMINI_QUOTA_ENABLED: process.env.LOCAL_GEMINI_QUOTA_ENABLED === 'true',
  // Только Text-out модели с доступными лимитами (RPM/TPM/RPD)
  LLM_MODELS: [
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (4K RPM, 4M TPM)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (1K RPM, 1M TPM, 10K RPD)' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2 Flash (2K RPM, 4M TPM)' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2 Flash Lite (4K RPM, 4M TPM)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (150 RPM, 2M TPM, 1K RPD)' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (25 RPM, 2M TPM, 250 RPD)' },
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (legacy)' },
  ],
  LLM_FALLBACK_CHAIN: {
    'gemini-2.0-flash': ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    'gemini-2.0-flash-lite': ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    'gemini-1.5-flash': ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    'gemini-2.5-flash-lite': ['gemini-1.5-flash', 'gemini-2.5-flash'],
    'gemini-2.5-flash': ['gemini-1.5-flash', 'gemini-2.5-flash-lite'],
    'gemini-3.1-pro-preview': ['gemini-3-pro-preview', 'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    'gemini-3-pro-preview': ['gemini-pro-latest', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    'gemini-pro-latest': ['gemini-2.5-pro', 'gemini-2.5-flash'],
    'gemini-2.5-pro': ['gemini-pro-latest', 'gemini-2.5-flash'],
  },
  /**
   * Локальные лимиты (только при LOCAL_GEMINI_QUOTA_ENABLED=true).
   * rpd: null — без дневного потолка (Unlimited в AI Studio); tpm — справочно, не режем.
   */
  FREE_TIER_QUOTAS: {
    'gemini-2.5-flash-lite': { rpm: 4000, tpm: 4000000, rpd: null },
    'gemini-2.5-flash': { rpm: 1000, tpm: 1000000, rpd: 10000 },
    'gemini-2.0-flash': { rpm: 2000, tpm: 4000000, rpd: null },
    'gemini-2.0-flash-lite': { rpm: 4000, tpm: 4000000, rpd: null },
    'gemini-2.5-pro': { rpm: 150, tpm: 2000000, rpd: 1000 },
    'gemini-3.1-pro-preview': { rpm: 25, tpm: 2000000, rpd: 250 },
    'gemini-3-pro-preview': { rpm: 25, tpm: 2000000, rpd: 250 },
    'gemini-pro-latest': { rpm: 150, tpm: 2000000, rpd: 1000 },
    'gemini-3-flash-preview': { rpm: 1000, tpm: 2000000, rpd: 10000 },
    'gemini-1.5-flash': { rpm: 15, tpm: 1000000, rpd: 1500 },
    'gemini-embedding-001': { rpm: 3000, tpm: 1000000, rpd: null },
    'gemini-embedding-2': { rpm: 3000, tpm: 1000000, rpd: null },
    'gemini-embedding-2-preview': { rpm: 3000, tpm: 1000000, rpd: null },
  },
  /** Если model id не в FREE_TIER_QUOTAS — только RPM, без дневного лимита */
  FREE_TIER_QUOTA_DEFAULT: { rpm: 60, tpm: 1000000, rpd: null },
  LLM_MAX_RETRIES: 3,
  /**
   * Summary generation strategy for the indexer (primary facts in summary_text).
   * Heuristic extractive bullets are always computed and stored in extractive_facts when possible.
   * - extractive: primary facts = extractive only, zero LLM (default — saves RPD quota)
   * - llm:        primary facts from LLM_MODEL; extractive_facts kept in parallel
   * - cheap_llm:  primary facts from SUMMARY_CHEAP_MODEL with LLM_SUMMARY_BATCH_SIZE batching
   * - none:       primary facts empty (summary_text []); extractive_facts still saved for RAG/blueprint
   */
  SUMMARY_MODE: process.env.SUMMARY_MODE || 'extractive',
  /** Model used when SUMMARY_MODE=cheap_llm (should have high RPD on free tier) */
  SUMMARY_CHEAP_MODEL: process.env.SUMMARY_CHEAP_MODEL || 'gemini-2.5-flash-lite',
  /** Max sentences kept by extractive summariser per chunk */
  SUMMARY_EXTRACTIVE_SENTENCES: parseInt(process.env.SUMMARY_EXTRACTIVE_SENTENCES, 10) || 5,
  /**
   * How many chunks to pack into a single LLM call for summary generation.
   * Only applies when SUMMARY_MODE=cheap_llm or llm.
   * Higher = fewer LLM calls but larger prompt. Recommended: 5–8.
   */
  LLM_SUMMARY_BATCH_SIZE: parseInt(process.env.LLM_SUMMARY_BATCH_SIZE, 10) || 6,
  /** Таймаут одного вызова generateContent/embed (мс); 0 = без ограничения */
  GEMINI_REQUEST_TIMEOUT_MS: parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS, 10) || 180000,
  /** Макс. ожидание освобождения RPM-слота при индексации (мс) */
  /** Макс. ожидание освобождения RPM-слота (мс). 90s — безопасный лимит до HTTP-таймаута клиента */
  QUOTA_RPM_WAIT_MAX_MS: parseInt(process.env.QUOTA_RPM_WAIT_MAX_MS, 10) || 90000,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  /**
   * Фиксированный язык документа: ru | en — пропускает эвристику (документы всегда на одном языке).
   * Пусто или auto — локальное определение по тексту (без LLM, ~1 мс).
   */
  DEFAULT_DOCUMENT_LANGUAGE: (() => {
    const v = String(process.env.DEFAULT_DOCUMENT_LANGUAGE || '').trim().toLowerCase();
    return v === 'ru' || v === 'en' ? v : '';
  })(),
  // RAG настройки
  TARGET_QUESTIONS_MIN: parseInt(process.env.TARGET_QUESTIONS_MIN) || 20,
  TARGET_QUESTIONS_MAX: parseInt(process.env.TARGET_QUESTIONS_MAX) || 30,
  RAG_TOP_K: parseInt(process.env.RAG_TOP_K) || 5,
  RETRIEVAL_TOP_N: parseInt(process.env.RETRIEVAL_TOP_N) || 12,
  RAG_THRESHOLD: parseFloat(process.env.RAG_THRESHOLD) || 0.0,
  MMR_LAMBDA: parseFloat(process.env.MMR_LAMBDA) || 0.65,
  EMBED_BATCH_SIZE: parseInt(process.env.EMBED_BATCH_SIZE) || 5,
  EMBED_CONCURRENCY: parseInt(process.env.EMBED_CONCURRENCY) || 2,
  LLM_BATCH_SIZE: parseInt(process.env.LLM_BATCH_SIZE) || 2,
  BACKFILL_MAX_ROUNDS: parseInt(process.env.BACKFILL_MAX_ROUNDS) || 3,
  ENABLE_GROUNDING: process.env.ENABLE_GROUNDING !== 'false',
  DEDUP_THRESHOLD: parseFloat(process.env.DEDUP_THRESHOLD) || 0.85,
  ENABLE_PDF_OCR: process.env.ENABLE_PDF_OCR !== 'false',
  /** OCR: тот же потолок, что и для загрузки (не 10 стр.) */
  MAX_OCR_PAGES: DOCUMENT_UPLOAD_MAX_PAGES,
  MIN_TEXT_LENGTH: parseInt(process.env.MIN_TEXT_LENGTH, 10) || 50,
  EVIDENCE_MIN_CHARS: parseInt(process.env.EVIDENCE_MIN_CHARS, 10) || 80,
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  LOGS_API_TOKEN: process.env.LOGS_API_TOKEN || '',
  SETTINGS_API_TOKEN: process.env.SETTINGS_API_TOKEN || '',
  /** JWT для /api/auth; в production задайте JWT_SECRET в .env (≥32 символа) */
  JWT_SECRET:
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === 'production'
      ? ''
      : 'local-dev-jwt-secret-min-32chars-long!!'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  /** Полные тексты в SQLite (может сильно раздуть data.db) */
  STORE_DOCUMENT_TEXT_IN_DB: process.env.STORE_DOCUMENT_TEXT_IN_DB === 'true',
  /** Ниже этого chars/page для pdf-parse будет пробоваться pdf.js */
  PDF_MIN_CHARS_PER_PAGE_SKIP_FALLBACK: parseInt(process.env.PDF_MIN_CHARS_PER_PAGE_SKIP_FALLBACK, 10) || 120,

  /** Модель «премиум» для budget guard и сложных стадий */
  LLM_PREMIUM_MODEL: process.env.LLM_PREMIUM_MODEL || 'gemini-2.5-pro',

  /**
   * Мягкие бюджеты по данным ai_model_usage (дополнение к gemini_usage / quotaGuard).
   * Отключить: AI_BUDGET_GUARDS_ENABLED=false
   */
  AI_BUDGET_GUARDS: {
    enabled: process.env.AI_BUDGET_GUARDS_ENABLED !== 'false',
    /** Доля от soft-RPD premium: выше — не маршрутизируем premium на обычные стадии */
    premiumUsageRatioThreshold: parseFloat(process.env.AI_BUDGET_PREMIUM_RATIO_THRESHOLD) || 0.35,
    /** Доля soft-RPD стандартного Flash: выше — дешёвые задачи на lite */
    flashUsageRatioThreshold: parseFloat(process.env.AI_BUDGET_FLASH_RATIO_THRESHOLD) || 0.65,
    /** Premium requests / standard requests — выше порога premium «тесный» для обычных задач */
    premiumVsStandardMaxRatio: parseFloat(process.env.AI_BUDGET_PREMIUM_VS_STANDARD_MAX) || 0.4,
    /** Порог для ветки cheap: flash vs soft limit */
    flashForCheapMaxRatio: parseFloat(process.env.AI_BUDGET_FLASH_FOR_CHEAP_MAX) || 0.5,
    /** Доля RPD из FREE_TIER_QUOTAS, считающаяся «soft cap» */
    rpdSoftFraction: parseFloat(process.env.AI_BUDGET_RPD_SOFT_FRACTION) || 0.85,
    /** Доля ошибок preview (failed / (failed+ok)) — выше порога preview исключаются из auto-routing */
    previewErrorRateThreshold: parseFloat(process.env.AI_BUDGET_PREVIEW_ERROR_THRESHOLD) || 0.2,
    /** Минимум выборок preview перед блокировкой маршрутизации */
    previewMinSamples: parseInt(process.env.AI_BUDGET_PREVIEW_MIN_SAMPLES, 10) || 5,
  },

  /**
   * Model routing (pipeline modelRouter): режимы auto / economy / balanced / quality / manual.
   */
  MODEL_ROUTING: {
    /** complexityScore 0..1: выше — допуск premium на «тяжёлых» стадиях (режим auto) */
    complexityPremiumThreshold: parseFloat(process.env.MODEL_ROUTING_COMPLEXITY_PREMIUM) || 0.65,
    /** Режим quality: минимальная сложность для приоритета premium на тяжёлых стадиях */
    qualityMinComplexityForPremium: parseFloat(process.env.MODEL_ROUTING_QUALITY_MIN_COMPLEXITY) || 0.45,
    /** Страниц выше этого порога — документ считается «тяжёлым» для эвристики */
    /** Эвристика «тяжёлого» документа для роутинга — не отказ в загрузке */
    maxPagesForEasyDoc: DOCUMENT_UPLOAD_MAX_PAGES,
    /** Стадии, на которых допустим premium при quality/auto (api stage names) */
    heavyStages: ['pipeline', 'generation', 'grounding', 'backfill', 'blueprint'],
  },

  // ── Feature flags (оптимизация pipeline) ────────────────────────────────────
  /**
   * Включить фоновую очередь BullMQ: POST /upload возвращает 202 + jobId,
   * пайплайн выполняется в отдельном worker-процессе.
   * Изменение требует перезапуска API и worker.
   */
  JOB_QUEUE_ENABLED: process.env.JOB_QUEUE_ENABLED === 'true',

  /**
   * Количество LLM-батчей, запускаемых параллельно в main batch loop.
   * 1 = последовательное (текущее поведение). Рекомендуется 2–4.
   * Quota Guard контролирует RPM-лимиты при параллельном выполнении.
   */
  LLM_BATCH_PARALLELISM: Math.max(1, parseInt(process.env.LLM_BATCH_PARALLELISM, 10) || 1),

  /**
   * Кэш blueprint в Redis: при повторной генерации для того же PDF
   * blueprint-стадия пропускается (экономия одного LLM-вызова).
   */
  BLUEPRINT_CACHE_ENABLED: process.env.BLUEPRINT_CACHE_ENABLED === 'true',
  BLUEPRINT_CACHE_TTL_SECONDS: parseInt(process.env.BLUEPRINT_CACHE_TTL_SECONDS, 10) || 86400,

  /**
   * Кэш embedding-векторов в Redis: идентичные тексты не вызывают
   * повторный Gemini embedding API-запрос.
   */
  EMBEDDING_CACHE_ENABLED: process.env.EMBEDDING_CACHE_ENABLED === 'true',
  EMBEDDING_CACHE_TTL_SECONDS: parseInt(process.env.EMBEDDING_CACHE_TTL_SECONDS, 10) || 604800,
  EMBEDDING_CACHE_MAX_ENTRIES: parseInt(process.env.EMBEDDING_CACHE_MAX_ENTRIES, 10) || 50000,

  /**
   * Использовать bulk INSERT вместо одиночных вставок для intents,
   * questions и question_sources.
   */
  BULK_INSERT_ENABLED: process.env.BULK_INSERT_ENABLED === 'true',
  BULK_INSERT_MAX_ROWS: parseInt(process.env.BULK_INSERT_MAX_ROWS, 10) || 1000,

  /**
   * Включить SSE-эндпоинт GET /api/jobs/:id/stream для реалтайм-прогресса.
   * При выключении клиенты используют polling GET /api/jobs/:id.
   */
  SSE_ENABLED: process.env.SSE_ENABLED === 'true',

  // ── Redis (для BullMQ, blueprint cache, embedding cache, SSE Pub/Sub) ────────
  REDIS_URL: process.env.REDIS_URL || '',
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  /** DB 0 — BullMQ очередь; DB 1 — blueprint cache; DB 2 — embedding cache */
  REDIS_DB_QUEUE: parseInt(process.env.REDIS_DB_QUEUE, 10) || 0,
  REDIS_DB_BLUEPRINT: parseInt(process.env.REDIS_DB_BLUEPRINT, 10) || 1,
  REDIS_DB_EMBEDDING: parseInt(process.env.REDIS_DB_EMBEDDING, 10) || 2,

  /** BullMQ: максимальное число попыток job до перехода в failed */
  JOB_MAX_ATTEMPTS: parseInt(process.env.JOB_MAX_ATTEMPTS, 10) || 2,
  /** BullMQ: таймаут выполнения одного job (мс) */
  JOB_TIMEOUT_MS: parseInt(process.env.JOB_TIMEOUT_MS, 10) || 600000,
  /** Таймаут ожидания Redis-слота для quota guard (мс) */
  QUOTA_WAIT_TIMEOUT_MS: parseInt(process.env.QUOTA_WAIT_TIMEOUT_MS, 10) || 30000,
  /** Макс. время повтора persist прогресса при недоступном Redis (мс) */
  REDIS_RETRY_MAX_MS: parseInt(process.env.REDIS_RETRY_MAX_MS, 10) || 30000,
  /** Версия схемы кэша: при смене промпта/модели инкрементируйте для инвалидации */
  CACHE_SCHEMA_VERSION: process.env.CACHE_SCHEMA_VERSION || '1',
};
