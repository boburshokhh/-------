-- Default ai_routing_rules for agent pipeline (phase = agent id). Idempotent by seed name.

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_structuring', 'structuring_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-2.5-flash-lite","fallback_api_model_ids":["gemini-2.5-flash"],"allow_premium":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_structuring');

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_evidence', 'evidence_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-embedding-001","fallback_api_model_ids":[]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_evidence');

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_blueprint', 'blueprint_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-2.5-flash","fallback_api_model_ids":["gemini-2.5-flash-lite"],"allow_premium":true,"escalation":{"to_api_model_id":"gemini-2.5-pro","when":["high_complexity","doc_heavy"],"min_complexity_for_escalation":0.65}}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_blueprint');

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_generator', 'generator_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-2.5-flash","fallback_api_model_ids":["gemini-2.5-flash-lite"],"allow_premium":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_generator');

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_quality', 'quality_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-2.5-flash-lite","fallback_api_model_ids":["gemini-2.5-flash"],"allow_premium":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_quality');

INSERT INTO ai_routing_rules (name, phase, priority, is_enabled, conditions, actions)
SELECT 'seed_v1_backfill', 'backfill_agent', 0, true, '{}'::jsonb,
  '{"primary_api_model_id":"gemini-2.5-flash","fallback_api_model_ids":["gemini-2.5-flash-lite"],"allow_premium":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM ai_routing_rules WHERE name = 'seed_v1_backfill');
