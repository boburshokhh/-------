-- Варианты id gemini-2.0-* (в т.ч. -001) → 2.5 в тарифах и реестре

UPDATE ai_routing_stage_rules
SET primary_model_id = 'gemini-2.5-flash',
    updated_at = now()
WHERE primary_model_id ~ '^gemini-2\.0-flash(-|$)';

UPDATE ai_routing_stage_rules
SET primary_model_id = 'gemini-2.5-flash-lite',
    updated_at = now()
WHERE primary_model_id ~ '^gemini-2\.0-flash-lite';

UPDATE ai_routing_stage_rules
SET fallback_model_id = 'gemini-2.5-flash',
    updated_at = now()
WHERE fallback_model_id ~ '^gemini-2\.0-flash(-|$)'
  AND fallback_model_id !~ 'lite';

UPDATE ai_routing_stage_rules
SET fallback_model_id = 'gemini-2.5-flash-lite',
    updated_at = now()
WHERE fallback_model_id ~ '^gemini-2\.0-flash-lite';

UPDATE ai_routing_rules
SET actions = jsonb_set(actions, '{primary_api_model_id}', '"gemini-2.5-flash"'::jsonb, false),
    updated_at = now()
WHERE actions->>'primary_api_model_id' ~ '^gemini-2\.0-flash(-|$)'
  AND actions->>'primary_api_model_id' !~ 'lite';

UPDATE ai_routing_rules
SET actions = jsonb_set(actions, '{primary_api_model_id}', '"gemini-2.5-flash-lite"'::jsonb, false),
    updated_at = now()
WHERE actions->>'primary_api_model_id' ~ '^gemini-2\.0-flash-lite';

UPDATE ai_models
SET is_enabled = false,
    metadata = COALESCE(metadata, '{}'::jsonb) || '{"deprecated":"use gemini-2.5-flash family"}'::jsonb,
    updated_at = now()
WHERE api_model_id ~ '^gemini-2\.0-flash';
