-- Track API failures per model/phase for preview error-rate and soft budget guards

ALTER TABLE ai_model_usage
    ADD COLUMN IF NOT EXISTS failed_requests BIGINT NOT NULL DEFAULT 0;

UPDATE ai_model_usage SET failed_requests = 0 WHERE failed_requests IS NULL;
