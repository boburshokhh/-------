-- 0002_pipeline_tables.sql
-- Pipeline-specific: generation_runs, intents, questions, question_sources, events, document_sections

CREATE TABLE IF NOT EXISTS document_sections (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    section_index   INTEGER NOT NULL,
    title           TEXT,
    heading         TEXT,
    start_page      INTEGER,
    end_page        INTEGER,
    char_offset     INTEGER,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (document_id, section_index)
);

CREATE TABLE IF NOT EXISTS generation_runs (
    id              SERIAL PRIMARY KEY,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    model           TEXT,
    target_min      INTEGER,
    target_max      INTEGER,
    target_count    INTEGER,
    language        TEXT,
    budget_metrics  JSONB,
    final_metrics   JSONB,
    fallback_decisions JSONB,
    started_at      TIMESTAMPTZ DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,
    error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_document_id ON generation_runs (document_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON generation_runs (status);

CREATE TABLE IF NOT EXISTS intents (
    id              SERIAL PRIMARY KEY,
    run_id          INTEGER NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
    intent_index    INTEGER NOT NULL,
    theme           TEXT,
    section         TEXT,
    intent_text     TEXT NOT NULL,
    difficulty      TEXT,
    type            TEXT DEFAULT 'multiple_choice',
    status          TEXT DEFAULT 'pending',
    skip_reason     TEXT,
    evidence_score  DOUBLE PRECISION,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intents_run_id ON intents (run_id);

CREATE TABLE IF NOT EXISTS questions (
    id              SERIAL PRIMARY KEY,
    run_id          INTEGER NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
    question_index  INTEGER NOT NULL,
    type            TEXT DEFAULT 'multiple_choice',
    question        TEXT NOT NULL,
    options         JSONB NOT NULL,
    correct_index   INTEGER NOT NULL,
    difficulty      TEXT,
    explanation     TEXT,
    hint            TEXT,
    grounded        BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (run_id, question_index)
);

CREATE INDEX IF NOT EXISTS idx_questions_run_id ON questions (run_id);

CREATE TABLE IF NOT EXISTS question_sources (
    id              SERIAL PRIMARY KEY,
    question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    chunk_id        INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    quote           TEXT
);

CREATE INDEX IF NOT EXISTS idx_qsources_question_id ON question_sources (question_id);
CREATE INDEX IF NOT EXISTS idx_qsources_chunk_id ON question_sources (chunk_id);

CREATE TABLE IF NOT EXISTS pipeline_run_events (
    id              SERIAL PRIMARY KEY,
    run_id          INTEGER REFERENCES generation_runs(id) ON DELETE CASCADE,
    document_id     INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    phase           TEXT NOT NULL,
    event           TEXT NOT NULL,
    level           TEXT DEFAULT 'info',
    reason_code     TEXT,
    defect_class    TEXT,
    metrics         JSONB,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_run_id ON pipeline_run_events (run_id);
CREATE INDEX IF NOT EXISTS idx_events_phase ON pipeline_run_events (phase);

-- Link tests to generation_runs
ALTER TABLE tests ADD COLUMN IF NOT EXISTS generation_run_id INTEGER REFERENCES generation_runs(id) ON DELETE SET NULL;
