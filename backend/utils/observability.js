/**
 * Structured observability: correlation id, reason codes, dashboard-ready metrics.
 * Логи — одна JSON-строка на событие в stdout (удобно для Loki/Datadog/ELK).
 * Schema version: 2
 */

/** @enum {string} Taxonomy отказов / предупреждений */
const REASON_CODES = {
    // Ingestion / parsing
    ERR_PARSE_MOJIBAKE:        'ERR_PARSE_MOJIBAKE',
    ERR_LOW_TEXT_QUALITY:      'ERR_LOW_TEXT_QUALITY',
    ERR_TOO_MANY_PAGES:        'ERR_TOO_MANY_PAGES',
    // Retrieval / evidence
    ERR_EVIDENCE_TOO_SHORT:    'ERR_EVIDENCE_TOO_SHORT',
    ERR_EVIDENCE_NOT_RELEVANT: 'ERR_EVIDENCE_NOT_RELEVANT',
    ERR_WEAK_EVIDENCE:         'ERR_WEAK_EVIDENCE',
    // Generation
    ERR_JSON_MALFORMED:        'ERR_JSON_MALFORMED',
    ERR_BATCH_EMPTY:           'ERR_BATCH_EMPTY',
    ERR_LLM_SKIPPED_INTENT:    'ERR_LLM_SKIPPED_INTENT',
    ERR_QUESTION_VALIDATION:   'ERR_QUESTION_VALIDATION',
    // Validation
    ERR_GROUNDING_FAILED:      'ERR_GROUNDING_FAILED',
    ERR_SEMANTIC_DUPLICATE:    'ERR_SEMANTIC_DUPLICATE',
    // Budget / system (NEW v2)
    ERR_CONTENT_TOO_SPARSE:    'ERR_CONTENT_TOO_SPARSE',
    ERR_QUOTA_EXCEEDED:        'ERR_QUOTA_EXCEEDED',
    ERR_DB_WRITE:              'ERR_DB_WRITE',
    ERR_TIMEOUT:               'ERR_TIMEOUT',
    ERR_MODEL_UNAVAILABLE:     'ERR_MODEL_UNAVAILABLE',
};

/** @enum {string} Укрупнённые классы дефектов для dashboard (NEW v2) */
const DEFECT_CLASSES = {
    INPUT_QUALITY:   'INPUT_QUALITY',   // ERR_PARSE_MOJIBAKE, ERR_LOW_TEXT_QUALITY, ERR_TOO_MANY_PAGES
    RETRIEVAL_MISS:  'RETRIEVAL_MISS',  // ERR_EVIDENCE_TOO_SHORT, ERR_EVIDENCE_NOT_RELEVANT, ERR_WEAK_EVIDENCE
    GENERATION_MISS: 'GENERATION_MISS', // ERR_JSON_MALFORMED, ERR_BATCH_EMPTY, ERR_LLM_SKIPPED_INTENT
    VALIDATION_FAIL: 'VALIDATION_FAIL', // ERR_QUESTION_VALIDATION, ERR_GROUNDING_FAILED
    DUPLICATE:       'DUPLICATE',       // ERR_SEMANTIC_DUPLICATE
    BUDGET_OVERFLOW: 'BUDGET_OVERFLOW', // ERR_CONTENT_TOO_SPARSE, ERR_QUOTA_EXCEEDED
    SYSTEM_ERROR:    'SYSTEM_ERROR',    // ERR_DB_WRITE, ERR_TIMEOUT
};

/**
 * @param {object} p
 * @param {'debug'|'info'|'warn'|'error'} p.level
 * @param {string}  [p.traceId]          — correlation id (job / trace)
 * @param {string}  [p.sessionId]        — NEW: browser/API session ID
 * @param {number|string|null} [p.documentId]
 * @param {number|string|null} [p.testId]
 * @param {string}  [p.phase]            — upload|parse|index|generate|validate|dedup|backfill|finalize
 * @param {string}  p.event              — machine-readable, snake_case
 * @param {string}  [p.reasonCode]       — из REASON_CODES
 * @param {string}  [p.defectClass]      — NEW: из DEFECT_CLASSES
 * @param {string}  [p.fallbackTriggered]— NEW: имя сработавшего fallback-решения
 * @param {Record<string, number|string|boolean|null>} [p.metrics]
 * @param {Record<string, unknown>} [p.metadata]
 */
function logStructured(p) {
    const line = {
        ts:               new Date().toISOString(),
        level:            p.level || 'info',
        service:          'ai-test-generator',
        schema_version:   2,
        trace_id:         p.traceId          ?? null,
        session_id:       p.sessionId        ?? null,
        document_id:      p.documentId       ?? null,
        test_id:          p.testId           ?? null,
        phase:            p.phase            ?? null,
        event:            p.event,
        reason_code:      p.reasonCode       ?? null,
        defect_class:     p.defectClass      ?? null,
        fallback_triggered: p.fallbackTriggered ?? null,
        metrics:  p.metrics  && Object.keys(p.metrics).length  ? p.metrics  : undefined,
        metadata: p.metadata && Object.keys(p.metadata).length ? p.metadata : undefined,
    };
    const out = JSON.stringify(line);
    if (line.level === 'error') {
        console.error(out);
    } else if (line.level === 'warn') {
        console.warn(out);
    } else {
        console.log(out);
    }
}

/**
 * Маппинг эвристики scoreEvidenceQuality → reason_code для логов.
 * @param {string|null} reason — human-readable из scoreEvidenceQuality
 * @returns {string}
 */
function evidenceReasonToCode(reason) {
    if (!reason) return REASON_CODES.ERR_WEAK_EVIDENCE;
    const r = String(reason).toLowerCase();
    if (r.includes('коротк')) return REASON_CODES.ERR_EVIDENCE_TOO_SHORT;
    if (r.includes('релевант') || r.includes('совпадение')) return REASON_CODES.ERR_EVIDENCE_NOT_RELEVANT;
    return REASON_CODES.ERR_WEAK_EVIDENCE;
}

/**
 * Percentile helper (input: sorted ascending array).
 * @param {number[]} sorted
 * @param {number}   p  — 0–100
 * @returns {number|null}
 */
function _percentile(sorted, p) {
    if (!sorted || sorted.length === 0) return null;
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    const v = sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    return Math.round(v * 1000) / 1000;
}

/**
 * Собирает итоговый объект метрик генерации для БД и API.
 * Schema version: 2
 *
 * @param {object} raw
 * @param {string}   raw.traceId
 * @param {string}   [raw.sessionId]
 * @param {number}   raw.documentId
 * @param {string}   raw.model
 * @param {number}   raw.durationMs
 * @param {number}   raw.targetCount
 * @param {number}   raw.targetMin
 * @param {number}   raw.targetMax
 * @param {number}   raw.blueprintIntents
 * @param {number}   [raw.parseQualityScore]
 * @param {number}   raw.chunkCount
 * @param {number}   [raw.chunksWithFacts]
 * @param {number}   raw.atomicFactsExtracted
 * @param {number}   raw.retrievalPassed
 * @param {number}   raw.retrievalSkipped
 * @param {number}   raw.groundingAccepted
 * @param {number}   raw.groundingFailed
 * @param {number}   raw.batchValidated
 * @param {number}   raw.llmSkipped
 * @param {number}   raw.validationFailed
 * @param {number}   raw.preDedupCount
 * @param {number}   raw.postDedupCount
 * @param {number}   raw.finalCount
 * @param {number}   raw.backfillRounds
 * @param {number}   [raw.backfillQuestionsAdded]
 * @param {number[]} [raw.evidenceScores]    — NEW: накопленные scores из scoreEvidenceQuality
 * @param {number}   [raw.uniqueConcepts]    — NEW: optional unique concept count
 */
function buildGenerationMetrics(raw) {
    const {
        traceId,
        sessionId,
        documentId,
        model,
        durationMs,
        targetCount,
        targetMin,
        targetMax,
        blueprintIntents,
        parseQualityScore,
        chunkCount,
        atomicFactsExtracted,
        retrievalPassed,
        retrievalSkipped,
        groundingAccepted,
        groundingFailed,
        batchValidated,
        llmSkipped,
        validationFailed,
        preDedupCount,
        postDedupCount,
        finalCount,
        backfillRounds,
        backfillQuestionsAdded,
        evidenceScores,
        uniqueConcepts,
    } = raw;

    const chunksWithFacts      = raw.chunksWithFacts ?? 0;
    const chunkUsefulnessScore = chunkCount > 0 ? chunksWithFacts / chunkCount : null;

    const retrievalTotal  = retrievalPassed + retrievalSkipped;
    const retrievalHitRate = retrievalTotal > 0 ? retrievalPassed / retrievalTotal : null;

    const groundingTotal      = groundingAccepted + groundingFailed;
    const groundedQuestionRate = groundingTotal > 0 ? groundingAccepted / groundingTotal : null;

    const dedupDropped   = Math.max(0, preDedupCount - postDedupCount);
    const dedupLossRatio = preDedupCount > 0 ? dedupDropped / preDedupCount : null;

    const acceptedQuestionRate = blueprintIntents > 0 ? finalCount / blueprintIntents : null;

    // ── Weighted composite final_quality_score (v2 formula) ─────────────────
    const countComponent    = targetMin > 0 ? Math.min(1, finalCount / targetMin) : 0;
    const groundingComponent = groundedQuestionRate ?? 0;
    const parseComponent     = parseQualityScore    ?? 0;
    const finalQualityScore  = countComponent * 0.5 + groundingComponent * 0.3 + parseComponent * 0.2;
    const qualityComponents  = {
        count_weight:    Math.round(countComponent    * 0.5 * 1000) / 1000,
        grounding_weight: Math.round(groundingComponent * 0.3 * 1000) / 1000,
        parse_weight:    Math.round(parseComponent    * 0.2 * 1000) / 1000,
    };

    // ── evidence_precision (NEW v2) ──────────────────────────────────────────
    let evidencePrecision = null;
    let evidenceP25 = null;
    let evidenceP75 = null;
    let evidenceMinVal = null;
    if (Array.isArray(evidenceScores) && evidenceScores.length > 0) {
        const passing = evidenceScores.filter(s => s >= 0.3);
        if (passing.length > 0) {
            evidencePrecision = Math.round(
                (passing.reduce((a, b) => a + b, 0) / passing.length) * 1000,
            ) / 1000;
        }
        const sorted = [...evidenceScores].sort((a, b) => a - b);
        evidenceP25   = _percentile(sorted, 25);
        evidenceP75   = _percentile(sorted, 75);
        evidenceMinVal = sorted[0] ?? null;
    }

    // ── fact_density  ────────────────────────────────────────────────────────
    const factDensity = chunkCount > 0 && atomicFactsExtracted > 0
        ? Math.round((atomicFactsExtracted / chunkCount) * 10) / 10
        : null;

    const lowConfidence = Math.round(finalQualityScore * 1000) / 1000 < 0.40;

    return {
        trace_id:    traceId,
        session_id:  sessionId ?? null,
        document_id: documentId,
        model,
        duration_ms:     durationMs,
        target_count:    targetCount,       // renamed from budget_target
        target_min:      targetMin,
        target_max:      targetMax,
        blueprint_intents: blueprintIntents,

        parse_quality_score:  parseQualityScore ?? null,
        chunk_count:          chunkCount,
        chunks_with_facts:    chunksWithFacts,
        chunk_usefulness_score: chunkUsefulnessScore,
        atomic_facts_extracted: atomicFactsExtracted,
        fact_density:           factDensity,
        unique_concepts:        uniqueConcepts ?? null,

        intents_retrieval_passed:  retrievalPassed,   // renamed
        intents_retrieval_skipped: retrievalSkipped,  // renamed
        retrieval_hit_rate:        retrievalHitRate,

        evidence_precision:   evidencePrecision,
        evidence_scores_p25:  evidenceP25,
        evidence_scores_p75:  evidenceP75,
        evidence_scores_min:  evidenceMinVal,

        grounding_accepted:    groundingAccepted,
        grounding_failed:      groundingFailed,
        grounded_question_rate: groundedQuestionRate,

        batch_questions_generated: batchValidated,   // renamed from batch_validated_total
        llm_skipped_intents:       llmSkipped,
        validation_failed:         validationFailed,

        pre_dedup_count:   preDedupCount,
        post_dedup_count:  postDedupCount,
        dedup_dropped:     dedupDropped,
        dedup_loss_ratio:  dedupLossRatio,

        final_question_count:  finalCount,
        accepted_question_rate: acceptedQuestionRate,
        final_quality_score:   Math.round(finalQualityScore * 1000) / 1000,
        quality_components:    qualityComponents,

        backfill_rounds_used:    backfillRounds,
        backfill_questions_added: backfillQuestionsAdded ?? 0,
        low_confidence:          lowConfidence,

        schema_version: 2,
    };
}

module.exports = {
    REASON_CODES,
    DEFECT_CLASSES,
    logStructured,
    evidenceReasonToCode,
    buildGenerationMetrics,
};
