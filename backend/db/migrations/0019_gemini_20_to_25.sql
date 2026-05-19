-- Gemini 2.0 Flash недоступен для новых API-ключей (404). Переводим правила и профили на 2.5.

UPDATE ai_routing_rules
SET actions = jsonb_set(
    actions,
    '{primary_api_model_id}',
    to_jsonb('gemini-2.5-flash'::text),
    false
)
WHERE actions->>'primary_api_model_id' = 'gemini-2.0-flash';

UPDATE ai_routing_rules
SET actions = jsonb_set(
    actions,
    '{primary_api_model_id}',
    to_jsonb('gemini-2.5-flash-lite'::text),
    false
)
WHERE actions->>'primary_api_model_id' = 'gemini-2.0-flash-lite';

UPDATE ai_routing_rules
SET actions = jsonb_set(
    actions,
    '{escalation,to_api_model_id}',
    to_jsonb('gemini-2.5-flash'::text),
    true
)
WHERE actions #>> '{escalation,to_api_model_id}' = 'gemini-2.0-flash';

UPDATE ai_models
SET is_enabled = false,
    metadata = COALESCE(metadata, '{}'::jsonb) || '{"deprecated":"use gemini-2.5-flash"}'::jsonb,
    updated_at = now()
WHERE api_model_id IN ('gemini-2.0-flash', 'gemini-2.0-flash-lite');

UPDATE custom_mode_stage_assignments cma
SET primary_model_id = m25.id,
    updated_at = now()
FROM ai_models old_m
JOIN ai_models m25 ON m25.api_model_id = 'gemini-2.5-flash'
WHERE cma.primary_model_id = old_m.id
  AND old_m.api_model_id = 'gemini-2.0-flash';

UPDATE custom_mode_stage_assignments cma
SET primary_model_id = m25l.id,
    updated_at = now()
FROM ai_models old_m
JOIN ai_models m25l ON m25l.api_model_id = 'gemini-2.5-flash-lite'
WHERE cma.primary_model_id = old_m.id
  AND old_m.api_model_id = 'gemini-2.0-flash-lite';

UPDATE ai_manual_overrides mo
SET model_id = m25.id,
    updated_at = now()
FROM ai_models old_m
JOIN ai_models m25 ON m25.api_model_id = 'gemini-2.5-flash'
WHERE mo.model_id = old_m.id
  AND old_m.api_model_id IN ('gemini-2.0-flash', 'gemini-2.0-flash-lite');
