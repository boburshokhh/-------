-- Audit log for admin AI routing changes

CREATE TABLE IF NOT EXISTS ai_admin_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT,
    before_state    JSONB,
    after_state     JSONB,
    request_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_admin_audit_created_at
    ON ai_admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_admin_audit_entity
    ON ai_admin_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_admin_audit_actor
    ON ai_admin_audit_log(actor_user_id, created_at DESC);
