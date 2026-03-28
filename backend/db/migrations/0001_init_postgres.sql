-- 0001_init_postgres.sql
-- Core tables: documents, chunks, embeddings, summaries, tests, results, settings, quota

CREATE TABLE IF NOT EXISTS documents (
    id              SERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    original_name   TEXT NOT NULL,
    original_name_raw TEXT,
    page_count      INTEGER,
    text_length     INTEGER,
    extraction_quality DOUBLE PRECISION,
    parse_diagnostics JSONB,
    low_text_quality BOOLEAN DEFAULT FALSE,
    text_raw        TEXT,
    text_clean      TEXT,
    -- storage fields (MinIO)
    storage_bucket  TEXT,
    storage_key     TEXT,
    mime_type       TEXT DEFAULT 'application/pdf',
    size_bytes      BIGINT,
    checksum_sha256 TEXT,
    status          TEXT DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_checksum ON documents (checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);

CREATE TABLE IF NOT EXISTS chunks (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    text            TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    page            INTEGER,
    section         TEXT,
    heading         TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks (content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_doc_index ON chunks (document_id, chunk_index);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
    id              SERIAL PRIMARY KEY,
    chunk_id        INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedding_model TEXT NOT NULL,
    embedding       JSONB NOT NULL,
    dims            INTEGER NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (chunk_id, embedding_model)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON chunk_embeddings (chunk_id);

CREATE TABLE IF NOT EXISTS chunk_summaries (
    id              SERIAL PRIMARY KEY,
    chunk_id        INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    summary_text    JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_summaries_chunk_id ON chunk_summaries (chunk_id);

CREATE TABLE IF NOT EXISTS tests (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    questions_json  JSONB NOT NULL,
    total_questions INTEGER NOT NULL,
    generation_metrics JSONB,
    generation_run_id INTEGER,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS results (
    id              SERIAL PRIMARY KEY,
    test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
    user_name       TEXT DEFAULT 'Аноним',
    answers_json    JSONB NOT NULL,
    score           INTEGER NOT NULL,
    max_score       INTEGER NOT NULL,
    percentage      DOUBLE PRECISION NOT NULL,
    completed_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
    key             TEXT PRIMARY KEY,
    value           TEXT,
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gemini_usage (
    key_fingerprint TEXT NOT NULL,
    usage_date      TEXT NOT NULL,
    model_id        TEXT NOT NULL,
    requests        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_fingerprint, usage_date, model_id)
);
