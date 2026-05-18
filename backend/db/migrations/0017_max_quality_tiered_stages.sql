-- 0017_max_quality_tiered_stages.sql
-- Top models only on blueprint + question generation; lighter models on auxiliary stages.

UPDATE custom_mode_profiles
SET
    description = 'Системный режим: топ-модели на плане и генерации вопросов; Flash/Pro на вспомогательных стадиях.',
    updated_at = now(),
    config_version = config_version + 1
WHERE code = 'max_quality';

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
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-2.5-flash-lite' LIMIT 1) AS flash_lite,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-embedding-2' LIMIT 1) AS emb2,
        (SELECT id FROM ai_models WHERE api_model_id = 'gemini-embedding-001' LIMIT 1) AS emb1
),
premium_fb AS (
    SELECT ARRAY_REMOVE(ARRAY[pro3, pro_latest, pro25, flash25], NULL)::BIGINT[] AS ids FROM models
),
standard_fb AS (
    SELECT ARRAY_REMOVE(ARRAY[pro_latest, flash25, pro31, flash_lite], NULL)::BIGINT[] AS ids FROM models
),
economy_fb AS (
    SELECT ARRAY_REMOVE(ARRAY[flash_lite, pro25], NULL)::BIGINT[] AS ids FROM models
),
grounding_fb AS (
    SELECT ARRAY_REMOVE(ARRAY[pro25, pro_latest, pro3, pro31], NULL)::BIGINT[] AS ids FROM models
),
embedding_fb AS (
    SELECT ARRAY_REMOVE(ARRAY[emb1], NULL)::BIGINT[] AS ids FROM models
),
tiered AS (
    SELECT 'embedding' AS stage_key, emb2 AS primary_id, embedding_fb.ids AS fallback_ids FROM models, embedding_fb
    UNION ALL SELECT 'cheap_preprocess', flash25, economy_fb.ids FROM models, economy_fb
    UNION ALL SELECT 'blueprint_generation', pro31, premium_fb.ids FROM models, premium_fb
    UNION ALL SELECT 'question_generation', pro31, premium_fb.ids FROM models, premium_fb
    UNION ALL SELECT 'grounding_validation', flash25, grounding_fb.ids FROM models, grounding_fb
    UNION ALL SELECT 'backfill_generation', pro25, standard_fb.ids FROM models, standard_fb
)
UPDATE custom_mode_stage_assignments a
SET
    primary_model_id = tiered.primary_id,
    fallback_model_ids = tiered.fallback_ids,
    notes = 'Tiered by 0017_max_quality_tiered_stages.sql',
    updated_at = now()
FROM profile, tiered
WHERE a.mode_profile_id = profile.id
  AND a.stage_key = tiered.stage_key
  AND tiered.primary_id IS NOT NULL;
