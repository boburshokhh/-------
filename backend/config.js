const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3002,
  /** Лимит запросов к публичному API за окно (по умолчанию 100 / 15 мин). */
  API_RATE_LIMIT_WINDOW_MS: parseRateLimitWindow(),
  API_RATE_LIMIT_MAX: parseRateMax(process.env.API_RATE_LIMIT_MAX, 100),
  /** Админка дергает много эндпоинтов параллельно — отдельный более высокий потолок. */
  ADMIN_API_RATE_LIMIT_MAX: parseRateMax(process.env.ADMIN_API_RATE_LIMIT_MAX, 800),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB) || 10,
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
  MAX_PAGES: 30,
  QUESTIONS_PER_CHUNK: parseInt(process.env.QUESTIONS_PER_CHUNK, 10) || 4,
  CHAR_LENGTH_PER_QUESTION: parseInt(process.env.CHAR_LENGTH_PER_QUESTION, 10) || 2000,
  LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.5-flash',
  LLM_FAST_MODEL: process.env.LLM_FAST_MODEL || 'gemini-1.5-flash',
  /** Free tier (ориентир для защиты от злоупотреблений; сверяйте с AI Studio для своего ключа) */
  GEMINI_QUOTA_TIER: 'free',
  // Только Text-out модели с доступными лимитами (RPM/TPM/RPD)
  LLM_MODELS: [
    { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (15 RPM, 1M TPM, 1500 RPD)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (7 RPM, 250K TPM, 20 RPD)' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (10 RPM, 250K TPM, 20 RPD)' },
  ],
  LLM_FALLBACK_CHAIN: {
    'gemini-1.5-flash': ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    'gemini-2.5-flash-lite': ['gemini-1.5-flash', 'gemini-2.5-flash'],
    'gemini-2.5-flash': ['gemini-1.5-flash', 'gemini-2.5-flash-lite'],
  },
  /**
   * Локальные лимиты по модели (free tier). Используются для учёта и блокировки до лимита Google.
   * tpm — для отображения; жёстко не режем (сложно без точного usageMetadata на каждом ответе).
   */
  FREE_TIER_QUOTAS: {
    'gemini-1.5-flash': { rpm: 15, tpm: 1000000, rpd: 1500 },
    'gemini-2.5-flash': { rpm: 7, tpm: 250000, rpd: 20 },
    'gemini-2.5-flash-lite': { rpm: 10, tpm: 250000, rpd: 20 },
    'gemini-embedding-001': { rpm: 100, tpm: 100000, rpd: 1500 },
  },
  /** Если model id не в FREE_TIER_QUOTAS — консервативный дефолт */
  FREE_TIER_QUOTA_DEFAULT: { rpm: 5, tpm: 250000, rpd: 20 },
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
  MAX_OCR_PAGES: parseInt(process.env.MAX_OCR_PAGES, 10) || 10,
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
    maxPagesForEasyDoc: parseInt(process.env.MODEL_ROUTING_MAX_PAGES_EASY, 10) || 15,
    /** Стадии, на которых допустим premium при quality/auto (api stage names) */
    heavyStages: ['pipeline', 'generation', 'grounding', 'backfill', 'blueprint'],
  },
};
