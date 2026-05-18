-- 0016_max_quality_mode.sql
-- Built-in mode: maximum quality, with top Gemini models per pipeline stage.

ALTER TABLE ai_routing_config
    DROP CONSTRAINT IF EXISTS ai_routing_config_routing_mode_check;
ALTER TABLE ai_routing_config
    ADD CONSTRAINT ai_routing_config_routing_mode_check
    CHECK (routing_mode IN ('auto', 'economy', 'balanced', 'quality', 'max_quality', 'manual'));

ALTER TABLE ai_global_policies
    DROP CONSTRAINT IF EXISTS ai_global_policies_routing_mode_check;
ALTER TABLE ai_global_policies
    ADD CONSTRAINT ai_global_policies_routing_mode_check
    CHECK (routing_mode IN ('auto', 'economy', 'balanced', 'quality', 'max_quality', 'manual'));

INSERT INTO custom_mode_profiles (
    code, name, description, parent_mode, is_system, is_active, is_archived, is_disabled, status,
    default_routing_behavior, allow_premium, allow_preview, stable_only, emergency_fallback
)
VALUES (
    'max_quality',
    'Максимум качества (System)',
    'Системный режим: максимальное качество без экономии, premium/preview разрешены.',
    'max_quality',
    TRUE,
    TRUE,
    FALSE,
    FALSE,
    'active',
    'stage_based',
    TRUE,
    TRUE,
    FALSE,
    FALSE
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    parent_mode = EXCLUDED.parent_mode,
    is_system = TRUE,
    is_archived = FALSE,
    is_disabled = FALSE,
    status = 'active',
    default_routing_behavior = 'stage_based',
    allow_premium = TRUE,
    allow_preview = TRUE,
    stable_only = FALSE,
    emergency_fallback = FALSE,
    updated_at = now(),
    config_version = custom_mode_profiles.config_version + 1;

WITH profile AS (
    SELECT id FROM custom_mode_profiles WHERE code = 'max_quality'
),
models AS (
    SELECT
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-3.1-pro-preview' LIMIT 1) AS pro31,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-3-pro-preview' LIMIT 1) AS pro3,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-pro-latest' LIMIT 1) AS pro_latest,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-2.5-pro' LIMIT 1) AS pro25,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-2.5-flash' LIMIT 1) AS flash25,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-embedding-2' LIMIT 1) AS emb2,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-embedding-001' LIMIT 1) AS emb1
),
llm_chain AS (
    SELECT ARRAY_REMOVE(ARRAY[pro3, pro_latest, pro25, flash25], NULL)::BIGINT[] AS fallback_ids
    FROM models
),
embedding_chain AS (
    SELECT ARRAY_REMOVE(ARRAY[emb1], NULL)::BIGINT[] AS fallback_ids
    FROM models
),
assignments AS (
    SELECT 'evidence' AS mission_key, 'embedding' AS stage_key, 'evidence_agent' AS agent_role,
           emb2 AS primary_model_id, embedding_chain.fallback_ids, TRUE AS allow_premium, TRUE AS allow_preview, FALSE AS stable_only
    FROM models, embedding_chain
    UNION ALL
    SELECT 'preprocess', 'cheap_preprocess', 'structuring_agent',
           pro31, llm_chain.fallback_ids, TRUE, TRUE, FALSE
    FROM models, llm_chain
    UNION ALL
    SELECT 'generation', 'blueprint_generation', 'blueprint_agent',
           pro31, llm_chain.fallback_ids, TRUE, TRUE, FALSE
    FROM models, llm_chain
    UNION ALL
    SELECT 'generation', 'question_generation', 'generator_agent',
           pro31, llm_chain.fallback_ids, TRUE, TRUE, FALSE
    FROM models, llm_chain
    UNION ALL
    SELECT 'validation', 'grounding_validation', 'quality_agent',
           pro31, llm_chain.fallback_ids, TRUE, TRUE, FALSE
    FROM models, llm_chain
    UNION ALL
    SELECT 'generation', 'backfill_generation', 'backfill_agent',
           pro31, llm_chain.fallback_ids, TRUE, TRUE, FALSE
    FROM models, llm_chain
)
INSERT INTO custom_mode_stage_assignments (
    mode_profile_id, mission_key, stage_key, agent_role, primary_model_id, fallback_model_ids,
    allow_premium, allow_preview, stable_only, preferred_cost_tier, preferred_provider,
    override_strength, enabled, notes
)
SELECT
    profile.id,
    assignments.mission_key,
    assignments.stage_key,
    assignments.agent_role,
    assignments.primary_model_id,
    assignments.fallback_ids,
    assignments.allow_premium,
    assignments.allow_preview,
    assignments.stable_only,
    'premium',
    'google',
    'hard',
    TRUE,
    'Seeded by 0016_max_quality_mode.sql'
FROM profile, assignments
WHERE assignments.primary_model_id IS NOT NULL
ON CONFLICT (mode_profile_id, mission_key, stage_key, agent_role) DO UPDATE SET
    primary_model_id = EXCLUDED.primary_model_id,
    fallback_model_ids = EXCLUDED.fallback_model_ids,
    allow_premium = TRUE,
    allow_preview = TRUE,
    stable_only = FALSE,
    preferred_cost_tier = 'premium',
    preferred_provider = 'google',
    override_strength = 'hard',
    enabled = TRUE,
    notes = EXCLUDED.notes,
    updated_at = now();
