-- 0018_max_quality_routing_rules.sql
-- Tiered models per stage for max_quality (replaces flat gemini-3.1-pro on all stages).

-- Remove legacy flat rules that forced premium on every stage
UPDATE ai_routing_rules
SET is_enabled = FALSE, updated_at = now()
WHERE is_enabled = TRUE
  AND (
    name ILIKE 'mode_max_quality%'
    OR name ILIKE '%max_quality_rule%'
    OR (
      conditions::text ILIKE '%max_quality%'
      AND actions::text ILIKE '%gemini-3.1-pro-preview%'
      AND stage_key IS NOT NULL
    )
  );

-- Disable global manual overrides that pin premium for all stages
UPDATE ai_manual_overrides o
SET is_enabled = FALSE, updated_at = now()
FROM ai_models m
WHERE o.model_id = m.id
  AND o.is_enabled = TRUE
  AND LOWER(COALESCE(o.scope, '')) = 'global'
  AND (
    m.api_model_id ILIKE '%3.1-pro%'
    OR m.api_model_id ILIKE '%3-pro-preview%'
  );

INSERT INTO ai_routing_rules (name, phase, stage_key, priority, is_enabled, conditions, actions, allow_premium, allow_preview, stable_only)
SELECT
    'tiered_max_quality_' || s.stage_key,
    s.agent_phase,
    s.stage_key,
    100,
    TRUE,
    jsonb_build_object('routing_mode', 'max_quality'),
    jsonb_build_object(
        'primary_api_model_id', s.primary_model,
        'fallback_api_model_ids', to_jsonb(s.fallback_models),
        'allow_premium', true
    ),
    TRUE,
    TRUE,
    FALSE
FROM (
    VALUES
        ('cheap_preprocess', 'structuring_agent', 'gemini-2.5-flash', ARRAY['gemini-2.5-flash-lite', 'gemini-2.5-pro']::text[]),
        ('embedding', 'evidence_agent', 'gemini-embedding-2', ARRAY['gemini-embedding-001']::text[]),
        ('blueprint_generation', 'blueprint_agent', 'gemini-3.1-pro-preview', ARRAY['gemini-3-pro-preview', 'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-2.5-flash']::text[]),
        ('question_generation', 'generator_agent', 'gemini-3.1-pro-preview', ARRAY['gemini-3-pro-preview', 'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-2.5-flash']::text[]),
        ('grounding_validation', 'quality_agent', 'gemini-2.5-flash', ARRAY['gemini-2.5-pro', 'gemini-pro-latest', 'gemini-3-pro-preview']::text[]),
        ('backfill_generation', 'backfill_agent', 'gemini-2.5-pro', ARRAY['gemini-pro-latest', 'gemini-2.5-flash', 'gemini-3.1-pro-preview']::text[])
) AS s(stage_key, agent_phase, primary_model, fallback_models)
WHERE NOT EXISTS (
    SELECT 1 FROM ai_routing_rules r
    WHERE r.name = 'tiered_max_quality_' || s.stage_key AND r.is_enabled = TRUE
);
