const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dataDir = process.env.DATA_DIR || __dirname;

module.exports = {
  PORT: parseInt(process.env.PORT) || 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB) || 10,
  CHUNK_TOKEN_LIMIT: parseInt(process.env.CHUNK_TOKEN_LIMIT) || 2500,
  CHUNK_OVERLAP_TOKENS: parseInt(process.env.CHUNK_OVERLAP_TOKENS) || 200,
  UPLOAD_DIR: path.join(dataDir, 'uploads'),
  DB_PATH: path.join(dataDir, 'data.db'),
  ALLOWED_MIMES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ],
  MAX_PAGES: 30,
  QUESTIONS_PER_CHUNK: 4,
  LLM_MODEL: 'gemini-2.5-flash',
  LLM_MAX_RETRIES: 3,
  EMBEDDING_MODEL: 'text-embedding-004',
  // RAG настройки
  TARGET_QUESTIONS_MIN: parseInt(process.env.TARGET_QUESTIONS_MIN) || 20,
  TARGET_QUESTIONS_MAX: parseInt(process.env.TARGET_QUESTIONS_MAX) || 30,
  RAG_TOP_K: parseInt(process.env.RAG_TOP_K) || 3,
  RETRIEVAL_TOP_N: parseInt(process.env.RETRIEVAL_TOP_N) || 12,
  RAG_THRESHOLD: parseFloat(process.env.RAG_THRESHOLD) || 0.0,
  MMR_LAMBDA: parseFloat(process.env.MMR_LAMBDA) || 0.65,
  EMBED_BATCH_SIZE: parseInt(process.env.EMBED_BATCH_SIZE) || 5,
  EMBED_CONCURRENCY: parseInt(process.env.EMBED_CONCURRENCY) || 2,
  ENABLE_GROUNDING: process.env.ENABLE_GROUNDING !== 'false',
  DEDUP_THRESHOLD: parseFloat(process.env.DEDUP_THRESHOLD) || 0.88,
  ENABLE_PDF_OCR: process.env.ENABLE_PDF_OCR !== 'false',
  MAX_OCR_PAGES: parseInt(process.env.MAX_OCR_PAGES, 10) || 10,
  MIN_TEXT_LENGTH: parseInt(process.env.MIN_TEXT_LENGTH, 10) || 50
};
