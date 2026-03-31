-- 0014_custom_mode_profiles.sql
-- Custom AI mode profiles + stage assignments + immutable version snapshots.

CREATE TABLE IF NOT EXISTS custom_mode_profiles (
    id                                  BIGSERIAL PRIMARY KEY,
    code                                TEXT NOT NULL UNIQUE,
    name                                TEXT NOT NULL,
    description                         TEXT,
    parent_mode                         TEXT NOT NULL DEFAULT 'quality',
    is_system                           BOOLEAN NOT NULL DEFAULT FALSE,
    is_active                           BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived                         BOOLEAN NOT NULL DEFAULT FALSE,
    is_disabled                         BOOLEAN NOT NULL DEFAULT FALSE,
    status                              TEXT NOT NULL DEFAULT 'draft'
                                        CHECK (status IN ('active', 'draft', 'archived', 'disabled')),
    default_routing_behavior            TEXT NOT NULL DEFAULT 'stage_based',
    allow_premium                       BOOLEAN NOT NULL DEFAULT FALSE,
    allow_preview                       BOOLEAN NOT NULL DEFAULT FALSE,
    stable_only                         BOOLEAN NOT NULL DEFAULT TRUE,
    emergency_fallback                  BOOLEAN NOT NULL DEFAULT TRUE,
    max_premium_budget_for_run          NUMERIC(12, 4),
    max_premium_share_per_day           NUMERIC(8, 4),
    created_by                          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by                          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    config_version                      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_custom_mode_profiles_status
    ON custom_mode_profiles(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_mode_profiles_active
    ON custom_mode_profiles(is_active, is_archived, is_disabled);

CREATE TABLE IF NOT EXISTS custom_mode_stage_assignments (
    id                      BIGSERIAL PRIMARY KEY,
    mode_profile_id         BIGINT NOT NULL REFERENCES custom_mode_profiles(id) ON DELETE CASCADE,
    mission_key             TEXT NOT NULL,
    stage_key               TEXT NOT NULL REFERENCES ai_stage_catalog(stage_key) ON DELETE RESTRICT,
    agent_role              TEXT NOT NULL,
    primary_model_id        BIGINT REFERENCES ai_models(id) ON DELETE SET NULL,
    fallback_model_ids      BIGINT[] NOT NULL DEFAULT '{}'::BIGINT[],
    allow_premium           BOOLEAN,
    allow_preview           BOOLEAN,
    stable_only             BOOLEAN,
    preferred_cost_tier     TEXT,
    preferred_provider      TEXT,
    override_strength       TEXT NOT NULL DEFAULT 'soft'
                            CHECK (override_strength IN ('soft', 'hard')),
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mode_profile_id, mission_key, stage_key, agent_role)
);

CREATE INDEX IF NOT EXISTS idx_custom_mode_assignments_mode
    ON custom_mode_stage_assignments(mode_profile_id, stage_key);

CREATE TABLE IF NOT EXISTS custom_mode_profile_versions (
    id                      BIGSERIAL PRIMARY KEY,
    mode_profile_id         BIGINT NOT NULL REFERENCES custom_mode_profiles(id) ON DELETE CASCADE,
    version                 INTEGER NOT NULL,
    snapshot                JSONB NOT NULL,
    created_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (mode_profile_id, version)
);

CREATE INDEX IF NOT EXISTS idx_custom_mode_profile_versions_profile
    ON custom_mode_profile_versions(mode_profile_id, version DESC);

ALTER TABLE generation_runs
    ADD COLUMN IF NOT EXISTS mode_profile_id BIGINT REFERENCES custom_mode_profiles(id) ON DELETE SET NULL;
ALTER TABLE generation_runs
    ADD COLUMN IF NOT EXISTS mode_profile_version INTEGER;
ALTER TABLE generation_runs
    ADD COLUMN IF NOT EXISTS requested_mode_code TEXT;

ALTER TABLE ai_routing_decisions
    ADD COLUMN IF NOT EXISTS mode_profile_id BIGINT REFERENCES custom_mode_profiles(id) ON DELETE SET NULL;
ALTER TABLE ai_routing_decisions
    ADD COLUMN IF NOT EXISTS mode_profile_version INTEGER;
ALTER TABLE ai_routing_decisions
    ADD COLUMN IF NOT EXISTS configured_source TEXT;
ALTER TABLE ai_routing_decisions
    ADD COLUMN IF NOT EXISTS effective_source TEXT;

INSERT INTO custom_mode_profiles (
    code, name, description, parent_mode, is_system, is_active, is_archived, is_disabled, status,
    default_routing_behavior, allow_premium, allow_preview, stable_only, emergency_fallback
)
VALUES
    ('auto', 'Auto (System)', 'Системный режим: автоматический роутинг', 'auto', TRUE, FALSE, FALSE, FALSE, 'active', 'stage_based', TRUE, FALSE, FALSE, TRUE),
    ('economy', 'Economy (System)', 'Системный режим: экономичный', 'economy', TRUE, FALSE, FALSE, FALSE, 'active', 'stage_based', FALSE, FALSE, TRUE, TRUE),
    ('balanced', 'Balanced (System)', 'Системный режим: сбалансированный', 'balanced', TRUE, FALSE, FALSE, FALSE, 'active', 'stage_based', TRUE, FALSE, TRUE, TRUE),
    ('quality', 'Quality (System)', 'Системный режим: повышенное качество', 'quality', TRUE, FALSE, FALSE, FALSE, 'active', 'stage_based', TRUE, FALSE, TRUE, TRUE),
    ('manual', 'Manual (System)', 'Системный режим: ручной', 'manual', TRUE, FALSE, FALSE, FALSE, 'active', 'manual', TRUE, TRUE, FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;
