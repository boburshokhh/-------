const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config');

const db = new Database(config.DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    page_count INTEGER,
    text_length INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    total_questions INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
    user_name TEXT DEFAULT 'Аноним',
    answers_json TEXT NOT NULL,
    score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    percentage REAL NOT NULL,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS document_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chunk_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id INTEGER NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
    embedding_model TEXT NOT NULL,
    embedding TEXT NOT NULL,
    dims INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id, embedding_model)
  );

  CREATE TABLE IF NOT EXISTS chunk_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_id INTEGER NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
    summary_text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id)
  );
`);

// Indexes for fast RAG lookups
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON document_chunks(content_hash);
  CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON chunk_embeddings(chunk_id);
  CREATE INDEX IF NOT EXISTS idx_summaries_chunk_id ON chunk_summaries(chunk_id);
`);

// Schema migration: добавляем поля section-aware chunking если их ещё нет
// (try/catch потому что SQLite не поддерживает ADD COLUMN IF NOT EXISTS)
try { db.exec(`ALTER TABLE document_chunks ADD COLUMN page    INTEGER DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE document_chunks ADD COLUMN section TEXT    DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE document_chunks ADD COLUMN heading TEXT    DEFAULT NULL`); } catch (_) {}

// Документ: имя как пришло от клиента, качество парсинга, опционально полные тексты
try { db.exec(`ALTER TABLE documents ADD COLUMN original_name_raw TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE documents ADD COLUMN extraction_quality REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE documents ADD COLUMN parse_diagnostics_json TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE documents ADD COLUMN low_text_quality INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE documents ADD COLUMN text_raw TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE documents ADD COLUMN text_clean TEXT`); } catch (_) {}

// Метрики observability по генерации теста (JSON для дашбордов / отладки)
try { db.exec(`ALTER TABLE tests ADD COLUMN generation_metrics_json TEXT`); } catch (_) {}

module.exports = db;
