-- 0003_summary_meta.sql
-- Adds metadata columns to chunk_summaries for tracking summary source/status.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE chunk_summaries
    ADD COLUMN IF NOT EXISTS summary_source TEXT DEFAULT 'llm',
    ADD COLUMN IF NOT EXISTS summary_status TEXT DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS summary_error_reason TEXT;

COMMENT ON COLUMN chunk_summaries.summary_source IS
    'How the summary was produced: llm | cheap_llm | extractive | none';

COMMENT ON COLUMN chunk_summaries.summary_status IS
    'ok | quota_skip | error | empty';

COMMENT ON COLUMN chunk_summaries.summary_error_reason IS
    'Short error message when summary_status != ok';
