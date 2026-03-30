-- 0005_chunk_extractive_facts.sql
-- Persist extractive (non-LLM) fact bullets alongside primary summary_text facts.

ALTER TABLE chunk_summaries
    ADD COLUMN IF NOT EXISTS extractive_facts JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN chunk_summaries.extractive_facts IS
    'Heuristic facts from chunk text; always filled when possible, independent of LLM summary_text';
