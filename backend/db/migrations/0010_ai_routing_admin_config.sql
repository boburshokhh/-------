-- Admin AI routing config + manual overrides (PostgreSQL)

CREATE TABLE IF NOT EXISTS ai_routing_config (
    id              BIGSERIAL PRIMARY KEY,
    routing_mode    TEXT NOT NULL DEFAULT 'auto'
                    CHECK (routing_mode IN ('auto', 'economy', 'balanced', 'quality', 'manual')),
    updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep exactly one config row (id=1) to simplify reads/writes.
INSERT INTO ai_routing_config (id, routing_mode, metadata)
VALUES (1, 'auto', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_manual_overrides (
    id              BIGSERIAL PRIMARY KEY,
    scope           TEXT NOT NULL
                    CHECK (scope IN ('global', 'agent', 'phase', 'document')),
    target          TEXT NOT NULL DEFAULT '',
    model_id        BIGINT REFERENCES ai_models(id) ON DELETE SET NULL,
    is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    priority        INTEGER NOT NULL DEFAULT 0,
    conditions      JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at      TIMESTAMPTZ,
    reason          TEXT,
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_manual_overrides_active
    ON ai_manual_overrides(is_enabled, priority DESC, scope);
CREATE INDEX IF NOT EXISTS idx_ai_manual_overrides_scope_target
    ON ai_manual_overrides(scope, target);
CREATE INDEX IF NOT EXISTS idx_ai_manual_overrides_expires_at
    ON ai_manual_overrides(expires_at);
