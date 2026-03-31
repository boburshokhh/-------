-- Migration 0013: AI Routing Tariffs

-- 1. Перечисления для стратегий поведения при лимитах или непрохождении guard-проверок
CREATE TYPE action_strategy AS ENUM ('fail_fast', 'queue', 'fallback_model', 'graceful_degrade', 'skip');

-- 2. Справочник профилей (тарифов)
CREATE TABLE IF NOT EXISTS ai_routing_profiles (
  code VARCHAR(50) PRIMARY KEY, -- 'economy', 'standard', 'premium' (immutable)
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed defaults
INSERT INTO ai_routing_profiles (code, display_name, description)
VALUES 
  ('economy', 'Economy', 'Cheapest models (flash-8b). Fails fast on limits. No fallback to expensive models.'),
  ('standard', 'Standard', 'Default balance of cost/quality. Uses Flash, degrades gracefully. May use Pro for specific stages.'),
  ('premium', 'Premium', 'Highest quality. Primary models are Pro level, except for embeddings and preprocessing.')
ON CONFLICT (code) DO NOTHING;

-- 3. Правила маршрутизации по стадиям для каждого профиля
CREATE TABLE IF NOT EXISTS ai_routing_stage_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_code VARCHAR(50) REFERENCES ai_routing_profiles(code) ON DELETE CASCADE,
  stage_name VARCHAR(50) NOT NULL REFERENCES ai_stage_catalog(stage_key) ON DELETE CASCADE,
  
  primary_model_id VARCHAR(100) NOT NULL,
  fallback_model_id VARCHAR(100),
  
  allow_premium BOOLEAN DEFAULT FALSE,
  allow_preview BOOLEAN DEFAULT FALSE,
  
  on_quota_limit action_strategy DEFAULT 'fallback_model',
  on_guard_blocked action_strategy DEFAULT 'fail_fast',
  
  -- Ограничение: нельзя завести два разных правила для одной стадии в одном тарифе
  UNIQUE (profile_code, stage_name)
);

-- Seed economy rules
INSERT INTO ai_routing_stage_rules (profile_code, stage_name, primary_model_id, fallback_model_id, allow_premium, allow_preview, on_quota_limit, on_guard_blocked)
VALUES
 ('economy', 'embedding', 'text-embedding-004', NULL, false, false, 'queue', 'fail_fast'),
 ('economy', 'cheap_preprocess', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'fallback_model', 'fail_fast'),
 ('economy', 'blueprint_generation', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'fallback_model', 'fail_fast'),
 ('economy', 'question_generation', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'fallback_model', 'fail_fast'),
 ('economy', 'grounding_validation', 'gemini-1.5-flash', NULL, false, false, 'fail_fast', 'fail_fast'),
 ('economy', 'backfill_generation', 'gemini-1.5-flash-8b', NULL, false, true, 'skip', 'skip')
ON CONFLICT DO NOTHING;

-- Seed standard rules
INSERT INTO ai_routing_stage_rules (profile_code, stage_name, primary_model_id, fallback_model_id, allow_premium, allow_preview, on_quota_limit, on_guard_blocked)
VALUES
 ('standard', 'embedding', 'text-embedding-004', NULL, false, false, 'queue', 'fail_fast'),
 ('standard', 'cheap_preprocess', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'fallback_model', 'fail_fast'),
 ('standard', 'blueprint_generation', 'gemini-1.5-flash', 'gemini-1.5-pro', false, true, 'queue', 'fail_fast'),
 ('standard', 'question_generation', 'gemini-1.5-flash', 'gemini-1.5-pro', false, true, 'queue', 'fail_fast'),
 ('standard', 'grounding_validation', 'gemini-1.5-flash', 'gemini-1.5-pro', true, false, 'fallback_model', 'fail_fast'),
 ('standard', 'backfill_generation', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'skip', 'skip')
ON CONFLICT DO NOTHING;

-- Seed premium rules
INSERT INTO ai_routing_stage_rules (profile_code, stage_name, primary_model_id, fallback_model_id, allow_premium, allow_preview, on_quota_limit, on_guard_blocked)
VALUES
 ('premium', 'embedding', 'text-embedding-004', NULL, false, false, 'queue', 'fail_fast'),
 ('premium', 'cheap_preprocess', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', false, true, 'fallback_model', 'fail_fast'),
 ('premium', 'blueprint_generation', 'gemini-1.5-pro', 'gemini-1.5-flash', true, true, 'fallback_model', 'fail_fast'),
 ('premium', 'question_generation', 'gemini-1.5-pro', 'gemini-1.5-flash', true, true, 'fallback_model', 'fail_fast'),
 ('premium', 'grounding_validation', 'gemini-1.5-pro', 'gemini-1.5-flash', true, false, 'fallback_model', 'fail_fast'),
 ('premium', 'backfill_generation', 'gemini-1.5-flash', 'gemini-1.5-pro', true, true, 'fallback_model', 'skip')
ON CONFLICT DO NOTHING;

-- Add profile_code to global policies or run payload?
-- This is mainly passed per request, but let's add default_profile to global policies.
ALTER TABLE ai_global_policies ADD COLUMN IF NOT EXISTS default_routing_profile VARCHAR(50) DEFAULT 'standard' REFERENCES ai_routing_profiles(code);
