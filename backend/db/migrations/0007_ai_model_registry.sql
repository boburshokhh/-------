-- AI Model Registry: models, limits, routing rules, usage tracking

-- Models catalog
CREATE TABLE IF NOT EXISTS ai_models (
    id                BIGSERIAL PRIMARY KEY,
    ui_name           TEXT NOT NULL,
    category          TEXT NOT NULL,
    provider          TEXT NOT NULL DEFAULT 'google',
    model_role        TEXT NOT NULL DEFAULT 'llm',
    api_model_id      TEXT,
    is_preview        BOOLEAN NOT NULL DEFAULT FALSE,
    base_model_id    BIGINT REFERENCES ai_models(id) ON DELETE SET NULL,
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ai_models_unique_key UNIQUE (provider, category, ui_name, is_preview)
);

-- Limits per model & tier
CREATE TABLE IF NOT EXISTS ai_model_limits (
    id             BIGSERIAL PRIMARY KEY,
    ai_model_id   BIGINT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
    tier           TEXT NOT NULL DEFAULT 'free',
    rpm            INTEGER,
    tpm            INTEGER,
    rpd            INTEGER,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from TIMESTAMPTZ,
    effective_to   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ai_model_limits_unique UNIQUE (ai_model_id, tier)
);

-- Editable routing rules (phase -> choose models/strategies)
CREATE TABLE IF NOT EXISTS ai_routing_rules (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    phase       TEXT NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,
    is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    conditions  JSONB NOT NULL DEFAULT '{}'::jsonb,
    actions     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usage tracking per key fingerprint & model
CREATE TABLE IF NOT EXISTS ai_model_usage (
    id              BIGSERIAL PRIMARY KEY,
    key_fingerprint TEXT NOT NULL,
    usage_date     DATE NOT NULL,
    ai_model_id     BIGINT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
    phase           TEXT NOT NULL DEFAULT 'default',
    requests       BIGINT NOT NULL DEFAULT 0,
    rpm_hits       BIGINT NOT NULL DEFAULT 0,
    tpm_estimated  BIGINT,
    last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ai_model_usage_unique UNIQUE (key_fingerprint, usage_date, ai_model_id, phase)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ai_models_enabled ON ai_models(is_enabled);
CREATE INDEX IF NOT EXISTS idx_ai_models_api_model_id ON ai_models(api_model_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_limits_ai_model_id ON ai_model_limits(ai_model_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_limits_tier_active ON ai_model_limits(tier, is_active);
CREATE INDEX IF NOT EXISTS idx_ai_routing_rules_phase_enabled_pri ON ai_routing_rules(phase, is_enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_ai_model_usage_date ON ai_model_usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_ai_model_usage_model_id ON ai_model_usage(ai_model_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_usage_key_fp_date ON ai_model_usage(key_fingerprint, usage_date);

