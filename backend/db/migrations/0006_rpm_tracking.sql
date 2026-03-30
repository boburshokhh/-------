CREATE TABLE IF NOT EXISTS gemini_rpm_hits (
    id SERIAL PRIMARY KEY,
    key_fingerprint TEXT NOT NULL,
    model_id TEXT NOT NULL,
    hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rpm_hits_lookup
ON gemini_rpm_hits (key_fingerprint, model_id, hit_at);
