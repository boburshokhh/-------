-- Прогресс длительных задач (upload → index → generate) для опроса GET /api/jobs/:id.
-- Позволяет нескольким инстансам приложения и переживать рестарт в пределах TTL.
CREATE TABLE IF NOT EXISTS job_progress (
    job_id VARCHAR(80) PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_progress_updated_at ON job_progress (updated_at);
