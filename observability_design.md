# Система метрик и наблюдаемости: AI Test Generator
> Инженерный проект. Версия 2.0. На основе аудита текущего `observability.js` + анализа пайплайна.

---

## Контекст: Что уже есть

Существующий `observability.js` содержит:
- `logStructured()` — JSON-лог в stdout ✅
- `REASON_CODES` — 11 кодов отказа ✅
- `buildGenerationMetrics()` — агрегация метрик при завершении ✅
- `schema_version: 1` — версионирование ✅

**Проблемы текущей реализации:**
1. Нет `upload_success_rate` — фаза `upload` не логируется структурированно
2. `parse_quality_score` попадает в метрики только в конце генерации, а не в момент парсинга
3. Нет `evidence_precision` — есть только `retrieval_hit_rate`
4. `chunk_usefulness_score` вычисляется правильно, но в логах появляется только в `generation_complete`
5. `reason_code` у многих событий = `null` — теряется диагностика
6. Отсутствует `session_id` для корреляции нескольких документов одной сессии
7. `schema_version: 1` не обновляется при изменении структуры

---

## 1. JSON Schema для структурированных логов (v2)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema",
  "title": "AITestGenerator.LogEvent",
  "version": "2",
  "type": "object",
  "required": ["ts", "level", "service", "schema_version", "trace_id", "event", "phase"],
  "properties": {
    "ts":             { "type": "string", "format": "date-time", "description": "ISO 8601 UTC" },
    "level":          { "type": "string", "enum": ["debug", "info", "warn", "error"] },
    "service":        { "type": "string", "const": "ai-test-generator" },
    "schema_version": { "type": "integer", "const": 2 },

    "trace_id":    { "type": ["string", "null"], "description": "Correlation ID: gen-{timestamp}-{random}" },
    "session_id":  { "type": ["string", "null"], "description": "Browser/API session ID (NEW)" },
    "document_id": { "type": ["integer", "null"] },
    "test_id":     { "type": ["integer", "null"] },

    "phase": {
      "type": "string",
      "enum": ["upload", "parse", "index", "generate", "validate", "dedup", "backfill", "finalize"]
    },
    "event": { "type": "string", "description": "machine-readable, snake_case" },

    "reason_code": { "type": ["string", "null"], "description": "Из REASON_CODES taxonomy" },
    "defect_class": {
      "type": ["string", "null"],
      "enum": [
        null,
        "INPUT_QUALITY",
        "RETRIEVAL_MISS",
        "GENERATION_MISS",
        "VALIDATION_FAIL",
        "DUPLICATE",
        "BUDGET_OVERFLOW",
        "SYSTEM_ERROR"
      ]
    },

    "metrics": {
      "type": "object",
      "description": "Числовые dashboard-ready поля. Все float 0–1 если ratio.",
      "additionalProperties": { "type": ["number", "string", "boolean", "null"] }
    },
    "metadata": {
      "type": "object",
      "description": "Нечисловой контекст: превью текстов, имена файлов и т.д.",
      "additionalProperties": true
    },
    "fallback_triggered": {
      "type": ["string", "null"],
      "description": "Имя сработавшего fallback-решения (NEW)"
    }
  }
}
```

---

## 2. Таблица метрик: Формулы, источники, пороги

### 2.1 upload_success_rate
| Поле | Значение |
|---|---|
| **Формула** | `успешных_загрузок / всего_попыток_загрузки` (скользящее окно 1h) |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `routes/upload.js` — счётчик в памяти / Redis |
| **Логируемые поля** | `file_size_bytes`, `mime_type`, `extraction_method`, `parse_quality_score`, `page_count` |
| **Threshold** | ⚠️ warn < 0.90 · 🔴 error < 0.70 |
| **Fallback** | При < 0.70 — включать OCR fallback принудительно |
| **Event names** | `upload_success`, `upload_failed` |

### 2.2 parse_quality_score
| Поле | Значение |
|---|---|
| **Формула** | Уже реализовано в `scoreExtraction()`: учёт `charsPerPage`, `replacementRatio`, `mojibakeRatio`, метода |
| **Тип** | Float, 0–1 |
| **Источник данных** | `utils/extractionQuality.js` → вызывается в `routes/upload.js` |
| **Логируемые поля** | `parse_quality_score`, `chars_per_page`, `replacement_ratio`, `mojibake_ratio`, `extraction_method`, `page_count` |
| **Threshold** | ⚠️ warn < 0.60 · 🔴 error < 0.42 (уже есть `lowQuality` флаг!) |
| **Fallback** | < 0.42 → переключить extraction_method на `pdfjs` или `ocr`; < 0.60 → снизить `targetCount` на 30% |

### 2.3 chunk_usefulness_score
| Поле | Значение |
|---|---|
| **Формула** | `chunks_with_facts / total_chunks` (chunks_with_facts = summary.length > 0) |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `indexer.js` после генерации всех summary |
| **Логируемые поля** | `chunk_count`, `chunks_with_facts`, `chunks_with_embeddings`, `chunk_usefulness_score` |
| **Threshold** | ⚠️ warn < 0.60 · 🔴 error < 0.30 |
| **Fallback** | < 0.30 → снизить `targetCount` на 40% + логировать `defect_class: INPUT_QUALITY` |

### 2.4 atomic_facts_extracted
| Поле | Значение |
|---|---|
| **Формула** | `SUM(chunk.summary.length)` по всем чанкам документа |
| **Тип** | Абсолютное целое |
| **Источник данных** | `indexer.js` (считается в `budgetCalculator.js`) |
| **Логируемые поля** | `atomic_facts_extracted`, `fact_density` (факты/1k токенов), `unique_concepts` |
| **Threshold** | ⚠️ warn < 10 (документ, вероятно, не содержательный) |
| **Fallback** | < 5 → skip generation, вернуть ошибку `ERR_CONTENT_TOO_SPARSE` |

### 2.5 retrieval_hit_rate
| Поле | Значение |
|---|---|
| **Формула** | `intents_passed_evidence_check / total_intents_sent_to_retrieval` |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `generator.js` — счётчики `statsRetrievalPassed` / `(statsRetrievalPassed + statsSkippedEvidence)` |
| **Логируемые поля** | `retrieval_passed`, `retrieval_skipped`, `retrieval_hit_rate`, `top_k` |
| **Threshold** | ⚠️ warn < 0.60 · 🔴 error < 0.40 |
| **Fallback** | < 0.40 → увеличить `RAG_TOP_K` с 5 до 8, снизить `EVIDENCE_MIN_CHARS` |

### 2.6 evidence_precision *(NEW — отсутствует в текущей системе)*
| Поле | Значение |
|---|---|
| **Формула** | `AVG(scoreEvidenceQuality.score)` по всем intents, где score ≥ 0.3 |
| **Тип** | Float, 0–1 |
| **Источник данных** | `generator.js` функция `scoreEvidenceQuality()` — нужно собирать scores в массив, не только бинарный фильтр |
| **Логируемые поля** | `evidence_precision`, `evidence_scores_p25`, `evidence_scores_p75`, `evidence_scores_min` |
| **Threshold** | ⚠️ warn < 0.55 · 🔴 error < 0.40 |
| **Fallback** | < 0.40 → включить backfill early, снизить качество grounding (ENABLE_GROUNDING=false) |

### 2.7 grounded_question_rate
| Поле | Значение |
|---|---|
| **Формула** | `grounding_accepted / (grounding_accepted + grounding_failed)` |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `generator.js` — `checkGrounding()`, счётчики `statsGroundingFailed` |
| **Логируемые поля** | `grounded_question_rate`, `grounding_accepted`, `grounding_failed`, `grounding_enabled` |
| **Threshold** | ⚠️ warn < 0.80 · 🔴 error < 0.60 |
| **Fallback** | < 0.60 → отключить grounding-check (он сам не работает), логировать `defect_class: VALIDATION_FAIL` |

### 2.8 accepted_question_rate
| Поле | Значение |
|---|---|
| **Формула** | `final_count / blueprint_intents` |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `generator.js` — `finalQuestions.length / blueprintWithDifficulty.length` |
| **Логируемые поля** | `accepted_question_rate`, `final_count`, `blueprint_intents`, `target_min`, `target_max` |
| **Threshold** | ⚠️ warn < 0.50 · 🔴 error < 0.30 |
| **Fallback** | < 0.30 → заблокировать backfill (бесполезен), вернуть частичный результат с предупреждением |

### 2.9 dedup_loss_ratio
| Поле | Значение |
|---|---|
| **Формула** | `dedup_dropped / pre_dedup_count` |
| **Тип** | Ratio, 0–1 |
| **Источник данных** | `generator.js` — `preDedupCount - initialDedup.length` |
| **Логируемые поля** | `dedup_loss_ratio`, `pre_dedup_count`, `post_dedup_count`, `dedup_threshold` |
| **Threshold** | ⚠️ warn > 0.35 · 🔴 error > 0.60 |
| **Fallback** | > 0.60 → blueprint некачественный, пересмотр theme extraction; `defect_class: DUPLICATE` |

### 2.10 final_quality_score
| Поле | Значение |
|---|---|
| **Формула** | `min(1, final_count / target_min) * retrieval_hit_rate_weight * grounded_rate_weight`. Текущая формула `= min(1, final_count / target_count)` — слишком упрощена. |
| **Новая формула** | `min(1, final_count / target_min) * 0.5 + grounded_question_rate * 0.3 + parse_quality_score * 0.2` |
| **Тип** | Float, 0–1 (composite score) |
| **Источник данных** | `buildGenerationMetrics()` — финальное агрегирование |
| **Логируемые поля** | `final_quality_score`, `quality_components` (JSON с весами) |
| **Threshold** | ⚠️ warn < 0.65 · 🔴 error < 0.40 |
| **Fallback** | < 0.40 → пометить тест как `low_confidence`, не публиковать автоматически |

---

## 3. Taxonomy дефектов (Defect Classes)

Это надстройка над `REASON_CODES` — укрупнённые классы для dashboard:

| defect_class | reason_codes | Описание |
|---|---|---|
| `INPUT_QUALITY` | `ERR_PARSE_MOJIBAKE`, `ERR_LOW_TEXT_QUALITY`, `ERR_TOO_MANY_PAGES` | Проблема в источнике: плохой PDF, сканы без OCR |
| `RETRIEVAL_MISS` | `ERR_EVIDENCE_TOO_SHORT`, `ERR_EVIDENCE_NOT_RELEVANT`, `ERR_WEAK_EVIDENCE` | RAG не нашёл релевантный контент |
| `GENERATION_MISS` | `ERR_JSON_MALFORMED`, `ERR_BATCH_EMPTY`, `ERR_LLM_SKIPPED_INTENT` | LLM не смог сгенерировать по причинам промпта |
| `VALIDATION_FAIL` | `ERR_QUESTION_VALIDATION`, `ERR_GROUNDING_FAILED` | Структурная ошибка или галлюцинация |
| `DUPLICATE` | `ERR_SEMANTIC_DUPLICATE` | Blueprint породил дублирующиеся intents |
| `BUDGET_OVERFLOW` | *(NEW)* `ERR_CONTENT_TOO_SPARSE`, `ERR_QUOTA_EXCEEDED` | Слишком мало контента или rate limit |
| `SYSTEM_ERROR` | *(NEW)* `ERR_DB_WRITE`, `ERR_TIMEOUT` | Инфраструктурные сбои |

**Новые reason codes к добавлению в `REASON_CODES`:**
```js
ERR_CONTENT_TOO_SPARSE: 'ERR_CONTENT_TOO_SPARSE',   // < 5 atomic facts
ERR_QUOTA_EXCEEDED:     'ERR_QUOTA_EXCEEDED',         // Gemini rate limit 429
ERR_DB_WRITE:           'ERR_DB_WRITE',               // SQLite insert failed
ERR_TIMEOUT:            'ERR_TIMEOUT',                // LLM call timeout
ERR_MODEL_UNAVAILABLE:  'ERR_MODEL_UNAVAILABLE',      // Fallback model needed
```

---

## 4. Решения по существующим метрикам

| Текущая метрика | Действие | Обоснование |
|---|---|---|
| `parse_quality_score` | ✅ **Оставить**, сдвинуть в фазу `parse` | Сейчас логируется только в `generation_complete` — поздно |
| `atomic_facts_extracted` | ✅ **Оставить**, добавить `fact_density` | Уже есть, но нет производного |
| `chunk_usefulness_score` | ✅ **Оставить** | Правильно вычисляется |
| `retrieval_hit_rate` | ✅ **Оставить** | Ключевая метрика |
| `grounded_question_rate` | ✅ **Оставить** | Ключевая |
| `accepted_question_rate` | ✅ **Оставить** | Ключевая |
| `dedup_loss_ratio` | ✅ **Оставить** | Ключевая |
| `final_quality_score` | ⚠️ **Переписать формулу** | Текущая = `count/target` — слишком тупая |
| `batch_validated_total` | 🔄 **Переименовать** в `batch_questions_generated` | Старое название двусмысленно |
| `retrieval_passed` / `retrieval_skipped` | 🔄 **Переименовать** в `intents_retrieval_passed` / `intents_retrieval_skipped` | Уточнить объект |
| `budget_target` | 🔄 **Переименовать** в `target_count` | `budget_target` == `target_count`, дублирование |
| `schema_version: 1` | ⚠️ **Поднять до 2** | При добавлении новых полей |
| `llm_skipped_intents` | ✅ **Оставить** | Важно для диагностики |
| `grounding_accepted` / `grounding_failed` | ✅ **Оставить** | Raw counts нужны |
| `validation_failed` | ✅ **Оставить** | Диагностика структурных ошибок |
| `backfill_rounds_used` | ✅ **Оставить** | Сигнал неэффективного пайплайна |

**Удалить (избыточные/дублирующиеся):**
| Поле | Причина |
|---|---|
| `budget_target` | Дублирует `target_count` |
| `test_id` в `logStructured` (в phase != finalize) | Нет смысла до конца генерации |

---

## 5. Метрики → Автоматические Fallback Decisions

| Метрика | Условие | Автоматическое действие |
|---|---|---|
| `parse_quality_score` | < 0.42 | Переключить extraction_method на `ocr`; выставить `reason_code: ERR_LOW_TEXT_QUALITY` |
| `parse_quality_score` | < 0.60 | Снизить `targetCount * 0.70`; логировать `defect_class: INPUT_QUALITY` |
| `chunk_usefulness_score` | < 0.30 | Остановить pipeline, вернуть `ERR_CONTENT_TOO_SPARSE` |
| `retrieval_hit_rate` | < 0.40 | Увеличить `RAG_TOP_K` +3, снизить `EVIDENCE_MIN_CHARS` на 20% |
| `evidence_precision` | < 0.40 | Отключить grounding-check (`ENABLE_GROUNDING = false` для этого run), `defect_class: RETRIEVAL_MISS` |
| `grounded_question_rate` | < 0.60 | Отключить `checkGrounding`, включить `ERR_GROUNDING_FAILED` log |
| `accepted_question_rate` | < 0.30 | Прервать backfill немедленно; вернуть частичный результат |
| `dedup_loss_ratio` | > 0.60 | Логировать `defect_class: DUPLICATE`; уменьшить `blueprint_size / 2` |
| `final_quality_score` | < 0.40 | Пометить тест флагом `low_confidence = true` в БД, не показывать без review |
| HTTP 429 от Gemini | любой вызов | `fallback_triggered: switch_to_flash_lite`; `reason_code: ERR_QUOTA_EXCEEDED`; backoff 60s |

---

## 6. Примеры логов: До / После

### 6.1 Фаза Upload

**До (текущее — неструктурированный console.log):**
```
[UPLOAD] Файл test.pdf сохранён как abc123.pdf
```

**После (v2):**
```json
{
  "ts": "2026-03-27T03:41:52.123Z",
  "level": "info",
  "service": "ai-test-generator",
  "schema_version": 2,
  "trace_id": "gen-1743039712-x7n2q",
  "session_id": "sess-a4f2bc",
  "document_id": 42,
  "test_id": null,
  "phase": "upload",
  "event": "upload_success",
  "reason_code": null,
  "defect_class": null,
  "fallback_triggered": null,
  "metrics": {
    "file_size_bytes": 2458624,
    "page_count": 18,
    "parse_quality_score": 0.87,
    "chars_per_page": 1843,
    "replacement_ratio": 0.0002,
    "extraction_method": "pdf-parse"
  },
  "metadata": {
    "original_filename": "Лекция_5.pdf",
    "stored_filename": "abc123.pdf"
  }
}
```

### 6.2 Фаза Intent Skip (Retrieval Miss)

**До:**
```
[GENERATOR] Soft-skip intent "Проверить знание факта…" — Evidence не релевантен intent (совпадение: 8%)
```

**После (v2):**
```json
{
  "ts": "2026-03-27T03:42:10.456Z",
  "level": "warn",
  "service": "ai-test-generator",
  "schema_version": 2,
  "trace_id": "gen-1743039712-x7n2q",
  "document_id": 42,
  "phase": "generate",
  "event": "intent_skipped_weak_evidence",
  "reason_code": "ERR_EVIDENCE_NOT_RELEVANT",
  "defect_class": "RETRIEVAL_MISS",
  "fallback_triggered": null,
  "metrics": {
    "evidence_score": 0.20,
    "relevance_overlap_pct": 8
  },
  "metadata": {
    "intent_preview": "Проверить знание факта: «Температура плавления вольфрама составляет 3422°C»"
  }
}
```

### 6.3 Фаза Generation Complete

**До (v1):**
```json
{
  "ts": "...", "level": "info", "service": "ai-test-generator",
  "trace_id": "gen-...", "document_id": 42,
  "phase": "generate", "event": "generation_complete",
  "metrics": {
    "duration_ms": 84200, "final_question_count": 17,
    "final_quality_score": 0.85, "grounded_question_rate": 0.94,
    "retrieval_hit_rate": 0.78, "dedup_loss_ratio": 0.06
  }
}
```

**После (v2) — полная картина:**
```json
{
  "ts": "2026-03-27T03:43:15.789Z",
  "level": "info",
  "service": "ai-test-generator",
  "schema_version": 2,
  "trace_id": "gen-1743039712-x7n2q",
  "session_id": "sess-a4f2bc",
  "document_id": 42,
  "test_id": 17,
  "phase": "finalize",
  "event": "generation_complete",
  "reason_code": null,
  "defect_class": null,
  "fallback_triggered": null,
  "metrics": {
    "duration_ms": 84200,
    "parse_quality_score": 0.87,
    "chunk_count": 36,
    "chunks_with_facts": 31,
    "chunk_usefulness_score": 0.861,
    "atomic_facts_extracted": 187,
    "fact_density": 14.2,
    "unique_concepts": 162,
    "intents_retrieval_passed": 22,
    "intents_retrieval_skipped": 6,
    "retrieval_hit_rate": 0.786,
    "evidence_precision": 0.71,
    "batch_questions_generated": 19,
    "llm_skipped_intents": 2,
    "validation_failed": 0,
    "grounding_accepted": 18,
    "grounding_failed": 1,
    "grounded_question_rate": 0.947,
    "pre_dedup_count": 18,
    "post_dedup_count": 17,
    "dedup_loss_ratio": 0.056,
    "final_question_count": 17,
    "target_min": 20,
    "target_max": 30,
    "accepted_question_rate": 0.773,
    "final_quality_score": 0.782,
    "quality_components": {
      "count_weight": 0.425,
      "grounding_weight": 0.284,
      "parse_weight": 0.174
    },
    "backfill_rounds_used": 1,
    "backfill_questions_added": 0,
    "low_confidence": false,
    "model": "gemini-2.5-flash"
  }
}
```

---

## 7. Новые Phase Events (полный список)

```
upload:    upload_success | upload_failed | upload_ocr_fallback_triggered
parse:     parse_complete | parse_quality_low | parse_fallback_triggered
index:     index_start | chunk_embedding_batch | chunk_summary_batch | index_complete | index_cache_hit
generate:  generation_start | budget_calculated | themes_extracted | blueprint_built
           | intent_skipped_weak_evidence | batch_all_intents_skipped | batch_complete
           | question_dropped_grounding | quota_exceeded_fallback
validate:  question_validation_failed | grounding_check_complete
dedup:     dedup_complete
backfill:  backfill_round_start | backfill_round_complete | backfill_aborted
finalize:  generation_complete | generation_low_confidence
```

---

## 8. Plan внедрения (без полной переписки)

### Этап 1: Минимальные изменения `observability.js` (~1ч)
- [ ] Поднять `schema_version` до `2`
- [ ] Добавить поля `session_id`, `defect_class`, `fallback_triggered` в `logStructured()`
- [ ] Добавить 5 новых `REASON_CODES` (`ERR_CONTENT_TOO_SPARSE`, `ERR_QUOTA_EXCEEDED`, etc.)
- [ ] Переименовать `budget_target` → `target_count` в `buildGenerationMetrics()`
- [ ] Переписать формулу `final_quality_score` (weighted composite)
- [ ] Добавить `evidence_precision` в `buildGenerationMetrics()` (требует накопления scores)

### Этап 2: Логирование Upload/Parse (~30мин)
- [ ] В `routes/upload.js`: вызвать `logStructured` с `phase: 'upload'` событиями `upload_success` / `upload_failed`
- [ ] Передать `parse_quality_score` в лог немедленно, не ждать finalize

### Этап 3: evidence_precision в Generator (~30мин)
- [ ] В `generator.js` заменить бинарный фильтр на накопление массива `evidenceScores[]`
- [ ] После main-loop вычислить `evidence_precision = avg(evidenceScores.filter(s >= 0.3))`
- [ ] Добавить percentile snapshot `p25`, `p75` для dashboard

### Этап 4: Fallback Auto-Decisions (~2ч)
- [ ] В `generator.js` после расчёта метрик добавить блок `applyFallbackDecisions(metrics)`:
  ```js
  function applyFallbackDecisions(metrics, runConfig) {
    if (metrics.parse_quality_score < 0.42) {
      runConfig.forceOCR = true;
      return 'force_ocr';
    }
    if (metrics.retrieval_hit_rate < 0.40) {
      runConfig.ragTopK = (runConfig.ragTopK || 5) + 3;
      return 'expand_top_k';
    }
    if (metrics.accepted_question_rate < 0.30) {
      runConfig.abortBackfill = true;
      return 'abort_backfill';
    }
    return null;
  }
  ```

### Этап 5: `low_confidence` флаг в БД (~30мин)
- [ ] Добавить колонку `low_confidence BOOLEAN DEFAULT 0` в таблицу тестов
- [ ] После `generation_complete`: если `final_quality_score < 0.40`, выставить флаг
- [ ] В API `GET /tests/:id` вернуть поле `low_confidence`

> [!NOTE]
> Всё внедрение рассчитано на **~4-5 часов работы** без миграции БД (кроме Этапа 5) и без изменения публичного API.
> `schema_version: 2` — обратно-совместим: Loki/ELK просто добавят новые поля в индекс.

---

## 9. Dashboard-Ready поля (для Grafana / Datadog)

Все числовые поля из секции `metrics` можно пробрасывать как label-value:
```
ai_test_generator_parse_quality_score{document_id, model}
ai_test_generator_retrieval_hit_rate{document_id, model}
ai_test_generator_grounded_question_rate{document_id, model}
ai_test_generator_final_quality_score{document_id, model}
ai_test_generator_dedup_loss_ratio{document_id, model}
ai_test_generator_accepted_question_rate{document_id, model}
ai_test_generator_defect_class_count{defect_class, phase}     ← по reason_code
ai_test_generator_fallback_triggered_count{fallback_triggered}
```
