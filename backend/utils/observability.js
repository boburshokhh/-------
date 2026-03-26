/**
 * Structured observability: correlation id, reason codes, dashboard-ready metrics.
 * Логи — одна JSON-строка на событие в stdout (удобно для Loki/Datadog/ELK).
 */

/** @enum {string} Taxonomy отказов / предупреждений */
const REASON_CODES = {
    // Ingestion / parsing
    ERR_PARSE_MOJIBAKE: 'ERR_PARSE_MOJIBAKE',
    ERR_LOW_TEXT_QUALITY: 'ERR_LOW_TEXT_QUALITY',
    ERR_TOO_MANY_PAGES: 'ERR_TOO_MANY_PAGES',
    // Retrieval / evidence
    ERR_EVIDENCE_TOO_SHORT: 'ERR_EVIDENCE_TOO_SHORT',
    ERR_EVIDENCE_NOT_RELEVANT: 'ERR_EVIDENCE_NOT_RELEVANT',
    ERR_WEAK_EVIDENCE: 'ERR_WEAK_EVIDENCE',
    // Generation
    ERR_JSON_MALFORMED: 'ERR_JSON_MALFORMED',
    ERR_BATCH_EMPTY: 'ERR_BATCH_EMPTY',
    ERR_LLM_SKIPPED_INTENT: 'ERR_LLM_SKIPPED_INTENT',
    ERR_QUESTION_VALIDATION: 'ERR_QUESTION_VALIDATION',
    // Validation
    ERR_GROUNDING_FAILED: 'ERR_GROUNDING_FAILED',
    ERR_SEMANTIC_DUPLICATE: 'ERR_SEMANTIC_DUPLICATE',
};

/**
 * @param {object} p
 * @param {'debug'|'info'|'warn'|'error'} p.level
 * @param {string} [p.traceId] — correlation id (job / trace)
 * @param {number|string|null} [p.documentId]
 * @param {number|string|null} [p.testId]
 * @param {string} [p.phase] — upload | index | generate | validate | dedup | backfill
 * @param {string} p.event — machine-readable имя события
 * @param {string} [p.reasonCode] — из REASON_CODES
 * @param {Record<string, number|string|boolean|null>} [p.metrics]
 * @param {Record<string, unknown>} [p.metadata]
 */
function logStructured(p) {
    const line = {
        ts: new Date().toISOString(),
        level: p.level || 'info',
        service: 'ai-test-generator',
        trace_id: p.traceId ?? null,
        document_id: p.documentId ?? null,
        test_id: p.testId ?? null,
        phase: p.phase ?? null,
        event: p.event,
        reason_code: p.reasonCode ?? null,
        metrics: p.metrics && Object.keys(p.metrics).length ? p.metrics : undefined,
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
 * Собирает итоговый объект метрик генерации для БД и API.
 * @param {object} raw
 */
function buildGenerationMetrics(raw) {
    const {
        traceId,
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
    } = raw;

    const chunksWithFacts = raw.chunksWithFacts ?? 0;
    const chunkUsefulnessScore = chunkCount > 0 ? chunksWithFacts / chunkCount : null;

    const retrievalTotal = retrievalPassed + retrievalSkipped;
    const retrievalHitRate = retrievalTotal > 0 ? retrievalPassed / retrievalTotal : null;

    const groundingTotal = groundingAccepted + groundingFailed;
    const groundedQuestionRate = groundingTotal > 0 ? groundingAccepted / groundingTotal : null;

    const dedupDropped = Math.max(0, preDedupCount - postDedupCount);
    const dedupLossRatio = preDedupCount > 0 ? dedupDropped / preDedupCount : null;

    const acceptedQuestionRate = blueprintIntents > 0 ? finalCount / blueprintIntents : null;
    const finalQualityScore = targetCount > 0 ? Math.min(1, finalCount / targetCount) : null;

    return {
        trace_id: traceId,
        document_id: documentId,
        model,
        duration_ms: durationMs,
        budget_target: targetCount,
        target_min: targetMin,
        target_max: targetMax,
        blueprint_intents: blueprintIntents,
        parse_quality_score: parseQualityScore ?? null,
        atomic_facts_extracted: atomicFactsExtracted,
        chunk_count: chunkCount,
        chunks_with_facts: chunksWithFacts,
        chunk_usefulness_score: chunkUsefulnessScore,
        retrieval_passed: retrievalPassed,
        retrieval_skipped: retrievalSkipped,
        retrieval_hit_rate: retrievalHitRate,
        grounding_accepted: groundingAccepted,
        grounding_failed: groundingFailed,
        grounded_question_rate: groundedQuestionRate,
        batch_validated_total: batchValidated,
        llm_skipped_intents: llmSkipped,
        validation_failed: validationFailed,
        pre_dedup_count: preDedupCount,
        post_dedup_count: postDedupCount,
        dedup_dropped: dedupDropped,
        dedup_loss_ratio: dedupLossRatio,
        final_question_count: finalCount,
        accepted_question_rate: acceptedQuestionRate,
        final_quality_score: finalQualityScore,
        backfill_rounds_used: backfillRounds,
        backfill_questions_added: backfillQuestionsAdded ?? 0,
        schema_version: 1,
    };
}

module.exports = {
    REASON_CODES,
    logStructured,
    evidenceReasonToCode,
    buildGenerationMetrics,
};
