/**
 * Каноническая матрица роль агента (phase в ai_routing_rules) ↔ stage_key.
 * Согласовано с backend/config/stageTaxonomy STAGE_TO_AGENT_ROLE.
 */
export const AGENT_STAGE_ROWS = [
  { agent_role: 'evidence_agent', stage_key: 'embedding', label_ru: 'Доказательства / эмбеддинги' },
  { agent_role: 'structuring_agent', stage_key: 'cheap_preprocess', label_ru: 'Структурирование' },
  { agent_role: 'blueprint_agent', stage_key: 'blueprint_generation', label_ru: 'План теста (blueprint)' },
  { agent_role: 'generator_agent', stage_key: 'question_generation', label_ru: 'Генерация вопросов' },
  { agent_role: 'quality_agent', stage_key: 'grounding_validation', label_ru: 'Grounding / качество' },
  { agent_role: 'backfill_agent', stage_key: 'backfill_generation', label_ru: 'Backfill' },
];

export function labelForStage(stageKey) {
  const row = AGENT_STAGE_ROWS.find((r) => r.stage_key === stageKey);
  return row?.label_ru || stageKey;
}
