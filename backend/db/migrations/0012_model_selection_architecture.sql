-- Model Selection Architecture: stage catalog, global policies, routing decisions,
-- model capabilities/health, and extended usage tracking.

-- 1. Stage catalog (registry of valid pipeline stages)
CREATE TABLE IF NOT EXISTS ai_stage_catalog (
    id              BIGSERIAL PRIMARY KEY,
    stage_key       TEXT NOT NULL UNIQUE,
    ui_label        TEXT NOT NULL,
    ui_order        INTEGER NOT NULL DEFAULT 0,
    requires_llm    BOOLEAN NOT NULL DEFAULT TRUE,
    task_type       TEXT NOT NULL DEFAULT 'standard_generation',
    default_cost_tier TEXT NOT NULL DEFAULT 'standard',
    premium_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    capabilities    JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ai_stage_catalog (stage_key, ui_label, ui_order, requires_llm, task_type, default_cost_tier, premium_eligible, capabilities)
VALUES
  ('embedding',            'Embedding',                    1, false, 'embedding',           'economy',  false, '["supports_embedding"]'),
  ('cheap_preprocess',     'Cheap Preprocess',             2, true,  'cheap_generation',    'economy',  false, '["supports_fast_generation"]'),
  ('facts_enrichment',     'Facts Enrichment',             3, true,  'standard_generation', 'standard', true,  '["supports_fast_generation"]'),
  ('theme_extraction',     'Theme Extraction',             4, true,  'standard_generation', 'standard', true,  '["supports_fast_generation"]'),
  ('blueprint_generation', 'Blueprint Generation',         5, true,  'standard_generation', 'standard', true,  '["supports_fast_generation"]'),
  ('question_generation',  'Question Generation',          6, true,  'standard_generation', 'standard', true,  '["supports_fast_generation"]'),
  ('grounding_validation', 'Grounding / Validation',       7, true,  'standard_generation', 'standard', true,  '["supports_grounding"]'),
  ('backfill_generation',  'Backfill Generation',          8, true,  'standard_generation', 'economy',  false, '["supports_fast_generation"]'),
  ('audit_debug',          'Audit / Debug',                9, true,  'audit',               'standard', false, '["supports_fast_generation"]')
ON CONFLICT (stage_key) DO NOTHING;


-- 2. Global policies (replaces single-row ai_routing_config for richer policy flags)
CREATE TABLE IF NOT EXISTS ai_global_policies (
    id                          BIGSERIAL PRIMARY KEY,
    routing_mode                TEXT NOT NULL DEFAULT 'auto'
                                CHECK (routing_mode IN ('auto','economy','balanced','quality','manual')),
    stable_only                 BOOLEAN NOT NULL DEFAULT FALSE,
    premium_guard_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    premium_soft_limit_percent  INTEGER NOT NULL DEFAULT 20,
    max_premium_percent_per_day INTEGER NOT NULL DEFAULT 25,
    max_pro_calls_per_run       INTEGER NOT NULL DEFAULT 10,
    preview_canary_percent      INTEGER NOT NULL DEFAULT 0,
    emergency_downgrade         BOOLEAN NOT NULL DEFAULT FALSE,
    metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ai_global_policies (
    id, routing_mode, stable_only, premium_guard_enabled,
    premium_soft_limit_percent, max_premium_percent_per_day,
    max_pro_calls_per_run, preview_canary_percent, emergency_downgrade
)
VALUES (1, 'auto', false, true, 20, 25, 10, 0, false)
ON CONFLICT (id) DO NOTHING;


-- 3. Routing decisions log (explainable)
CREATE TABLE IF NOT EXISTS ai_routing_decisions (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT,
    document_id           BIGINT,
    trace_id              TEXT,
    stage_key             TEXT NOT NULL,
    agent_role            TEXT,
    selected_model_id     BIGINT REFERENCES ai_models(id) ON DELETE SET NULL,
    selected_api_model_id TEXT,
    fallback_chain        JSONB NOT NULL DEFAULT '[]'::jsonb,
    decision_reason       TEXT NOT NULL DEFAULT 'auto',
    decision_source       TEXT NOT NULL DEFAULT 'engine',
    was_fallback          BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason       TEXT,
    premium_blocked       BOOLEAN NOT NULL DEFAULT FALSE,
    preview_blocked       BOOLEAN NOT NULL DEFAULT FALSE,
    manual_override_id    BIGINT,
    cost_tier             TEXT,
    is_preview            BOOLEAN NOT NULL DEFAULT FALSE,
    quota_snapshot        JSONB,
    candidate_snapshot    JSONB,
    policy_snapshot       JSONB,
    latency_ms            INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_routing_decisions_run
    ON ai_routing_decisions(run_id, stage_key);
CREATE INDEX IF NOT EXISTS idx_ai_routing_decisions_doc
    ON ai_routing_decisions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_decisions_stage
    ON ai_routing_decisions(stage_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_routing_decisions_created
    ON ai_routing_decisions(created_at DESC);


-- 4. Model health snapshots (rolling provider health)
CREATE TABLE IF NOT EXISTS ai_model_health (
    id              BIGSERIAL PRIMARY KEY,
    ai_model_id     BIGINT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
    api_model_id    TEXT,
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    total_requests  INTEGER NOT NULL DEFAULT 0,
    failed_requests INTEGER NOT NULL DEFAULT 0,
    error_rate      REAL NOT NULL DEFAULT 0,
    avg_latency_ms  INTEGER,
    p95_latency_ms  INTEGER,
    is_healthy      BOOLEAN NOT NULL DEFAULT TRUE,
    is_suppressed   BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ai_model_health_window_unique
        UNIQUE (ai_model_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_model_health_model
    ON ai_model_health(ai_model_id, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_ai_model_health_healthy
    ON ai_model_health(is_healthy, is_suppressed);


-- 5. Extend ai_models with capability/cost/health columns
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_tier TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS latency_tier TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS stability_class TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS canary_eligible BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_models_cost_tier ON ai_models(cost_tier);
CREATE INDEX IF NOT EXISTS idx_ai_models_stability ON ai_models(stability_class);


-- 6. Extend ai_model_usage with stage_key and decision tracking
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS stage_key TEXT;
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS decision_id BIGINT;
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS run_id BIGINT;
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS document_id BIGINT;
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE ai_model_usage ADD COLUMN IF NOT EXISTS provider_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_model_usage_stage_key
    ON ai_model_usage(stage_key, usage_date);
CREATE INDEX IF NOT EXISTS idx_ai_model_usage_run_id
    ON ai_model_usage(run_id);


-- 7. Extend ai_routing_rules with stage_key column (alongside legacy phase)
ALTER TABLE ai_routing_rules ADD COLUMN IF NOT EXISTS stage_key TEXT;
ALTER TABLE ai_routing_rules ADD COLUMN IF NOT EXISTS allow_preview BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_routing_rules ADD COLUMN IF NOT EXISTS allow_premium BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_routing_rules ADD COLUMN IF NOT EXISTS stable_only BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ai_routing_rules ADD COLUMN IF NOT EXISTS max_escalation_depth INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_ai_routing_rules_stage_key
    ON ai_routing_rules(stage_key, is_enabled, priority DESC);

-- Backfill stage_key from legacy phase -> agent role mapping
UPDATE ai_routing_rules SET stage_key = 'cheap_preprocess'     WHERE phase = 'structuring_agent' AND stage_key IS NULL;
UPDATE ai_routing_rules SET stage_key = 'embedding'            WHERE phase = 'evidence_agent'    AND stage_key IS NULL;
UPDATE ai_routing_rules SET stage_key = 'blueprint_generation' WHERE phase = 'blueprint_agent'   AND stage_key IS NULL;
UPDATE ai_routing_rules SET stage_key = 'question_generation'  WHERE phase = 'generator_agent'   AND stage_key IS NULL;
UPDATE ai_routing_rules SET stage_key = 'grounding_validation' WHERE phase = 'quality_agent'     AND stage_key IS NULL;
UPDATE ai_routing_rules SET stage_key = 'backfill_generation'  WHERE phase = 'backfill_agent'    AND stage_key IS NULL;

-- Backfill allow_premium from actions jsonb
UPDATE ai_routing_rules
SET allow_premium = COALESCE((actions->>'allow_premium')::boolean, false)
WHERE allow_premium = false;


-- 8. Extend ai_manual_overrides with stage_key
ALTER TABLE ai_manual_overrides ADD COLUMN IF NOT EXISTS stage_key TEXT;
ALTER TABLE ai_manual_overrides ADD COLUMN IF NOT EXISTS force_override BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_manual_overrides_stage_key
    ON ai_manual_overrides(stage_key, is_enabled);
