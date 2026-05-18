/**
 * Подписи стадий и режимов для UI «Режим ИИ».
 * Ключи стадий — как в backend/config/stageTaxonomy (STAGE_KEYS) и в stage_preview API.
 *
 * Тяжёлые стадии для premium (MODEL_ROUTING.heavyStages в backend/config.js):
 * pipeline, generation, grounding, backfill, blueprint — в публичном preview используются
 * канонические ключи question_generation, blueprint_generation, grounding_validation, embedding.
 */

/** @type {Record<string, string>} */
export const STAGE_LABELS_RU = {
  embedding: 'Эмбеддинги',
  cheap_preprocess: 'Быстрый препроцесс',
  facts_enrichment: 'Обогащение фактов',
  theme_extraction: 'Извлечение темы',
  blueprint_generation: 'План теста (blueprint)',
  question_generation: 'Генерация вопросов',
  grounding_validation: 'Сверка с источником (grounding)',
  backfill_generation: 'Дозаполнение (backfill)',
  audit_debug: 'Аудит / отладка',
};

/**
 * Стадии, где в политике quality/auto чаще рассматривается premium (смысловое соответствие heavyStages).
 * Для карточек режимов — человекочитаемые чипы.
 */
export const HEAVY_STAGE_LABELS_SHORT = [
  'Генерация вопросов',
  'План (blueprint)',
  'Grounding',
  'Backfill',
];

export const CHEAP_STAGE_LABELS_SHORT = [
  'Препроцесс',
  'Факты',
  'Эмбеддинги',
];

/** Типичный прогноз: фиксированные метаданные на бэкенде (generationRoutingSnapshot.js) */
export const STAGE_PREVIEW_DISCLAIMER =
  'Оценка для документа средней сложности (эвристика сервера). После загрузки файла итоговые модели могут отличаться.';

export const EMPTY_STATE_NO_FILE =
  'Точный прогноз по моделям появится после загрузки документа. Сейчас показаны типичные настройки для выбранного режима.';

export const METRICS_LEGEND =
  'Качество, стоимость и скорость — относительные уровни для сравнения режимов, не цена в валюте.';

/**
 * Карточки режимов: метрики 1–3 (★), premium copy, усиленные этапы (чипы).
 * mode: economy | balanced | quality | max_quality | manual
 */
export const MODE_CARD_COPY = {
  economy: {
    title: 'Экономия',
    tag: 'Минимум затрат',
    subtitle: 'Минимум стоимости, стандартное качество',
    premiumShort: 'Premium не планируется',
    metrics: { quality: 1, cost: 3, speed: 3 },
    stageChips: ['Дешёвые стадии в приоритете', 'Тяжёлые — без premium'],
  },
  balanced: {
    title: 'Сбалансированный',
    tag: 'Универсально',
    subtitle: 'Разумный баланс для большинства документов',
    premiumShort: 'Premium редко, только если документ сложный',
    metrics: { quality: 2, cost: 2, speed: 2 },
    stageChips: ['Баланс cheap / heavy', 'Premium точечно'],
  },
  quality: {
    title: 'Качество',
    tag: 'Выше качество',
    subtitle: 'Выше качество на важных этапах',
    premiumShort: 'Premium возможен на тяжёлых этапах при достаточной сложности',
    metrics: { quality: 3, cost: 1, speed: 1 },
    stageChips: HEAVY_STAGE_LABELS_SHORT.slice(0, 3),
  },
  max_quality: {
    title: 'Максимум',
    tag: 'Без экономии',
    subtitle: 'Самые сильные доступные модели на ключевых этапах',
    premiumShort: 'Premium и preview разрешены, если модель доступна',
    metrics: { quality: 3, cost: 1, speed: 1 },
    stageChips: ['Gemini 3.1 Pro', 'Blueprint + генерация', 'Grounding + backfill'],
  },
  manual: {
    title: 'Ручная настройка',
    tag: 'Полный контроль',
    subtitle: 'Одна модель на все этапы — полный контроль',
    premiumShort: 'Зависит от выбранной модели (в т.ч. Premium)',
    metrics: { quality: 2, cost: 2, speed: 2 },
    stageChips: ['Одна модель на все стадии', 'Без авто-маршрутизации'],
  },
};

/**
 * @param {string} key
 * @returns {string}
 */
export function getStageLabelRu(key) {
  return STAGE_LABELS_RU[key] || key;
}
