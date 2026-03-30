/**
 * pipeline/testGeneratorFlow.js
 *
 * Главный оркестратор пайплайна генерации теста.
 * Координирует все фазы:
 *   1. Определение языка (nlp/languagePredictor)
 *   2. Расчёт бюджета (budgetCalculator)
 *   3. Blueprint: темы + intents (generation/blueprintService ← rag.js)
 *   4. Генерация вопросов батчами (generation/generationService)
 *   5. Grounding-проверка (generation/generationService)
 *   6. Семантическая дедупликация (nlp/similarity)
 *   7. Backfill-раунды (generation/generationService)
 *   8. Персистенция (db/repositories/runRepo)
 *   9. Финальные метрики (utils/observability)
 */

'use strict';

const config       = require('../../config');
const { chunkText } = require('../chunker');
const { calculateQuestionBudget } = require('../budgetCalculator');
const quotaGuard   = require('../quotaGuard');
const jobProgress  = require('../jobProgress');
const runRepo      = require('../../db/repositories/runRepo');

// NLP
const { detectLanguageWithDiagnostics } = require('../nlp/languagePredictor');
const { scoreEvidenceQuality, assignDifficulties } = require('../nlp/scoring');
const { semanticDedup, levenshteinSimilarity } = require('../nlp/similarity');

// RAG
const rag = require('../rag');
const { countMergedFactBullets } = require('../rag/evidenceBuilder');

// Generation
const {
    generateBatchQuestions,
    checkGroundingBatched,
    createBackfillIntents,
} = require('../generation/generationService');

const { buildOfflineMcqFromChunks } = require('../generation/fallbackStrategy');

// Observability
const {
    logStructured,
    evidenceReasonToCode,
    buildGenerationMetrics,
    REASON_CODES,
    DEFECT_CLASSES,
} = require('../../utils/observability');

const PW = jobProgress.WEIGHT;

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Если итоговый pipeline выдал 0 вопросов — логирует и возвращает маркер.
 */
function applyFallbackDecisions(stats, ctx) {
    const { retrievalPassed, retrievalSkipped, finalCount, blueprintIntents } = stats;
    if (finalCount === 0 && blueprintIntents > 0) {
        logStructured({
            level: 'error',
            traceId: ctx.traceId,
            documentId: ctx.documentId,
            phase: 'finalize',
            event: 'zero_questions_generated',
            reasonCode: REASON_CODES.ERR_WEAK_EVIDENCE,
            defectClass: DEFECT_CLASSES.RETRIEVAL_MISS,
            metrics: { retrieval_passed: retrievalPassed, retrieval_skipped: retrievalSkipped },
        });
        return 'zero_output';
    }
    return null;
}

// ─── offline branch ──────────────────────────────────────────────────────────

/**
 * Полностью офлайн-ветка: квота исчерпана на уровне RPD.
 * Строит blueprint из заголовков и формирует вопросы из чанков без LLM.
 */
async function runOfflinePipeline({
    fullText, indexedChunks, model, targetCount, targetMin, targetMax,
    detectedLang, startTime, runId, traceId, documentId, opts, progress,
}) {
    progress({ phase: 'generate', stage: 'quota_offline',
        detail: 'Квота LLM на сутки исчерпана — вопросы из текста и сохранённых выжимок' });

    const themes = [{
        topic: 'Содержание документа',
        section: 'Документ',
        importance: 2,
        suggestedCount: Math.min(5, Math.max(3, Math.ceil(Math.max(1, targetCount) / 2))),
        difficultyCandidates: ['remember', 'understand'],
    }];
    progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES,
        detail: `Тем: ${themes.length} (режим без LLM)` });

    const blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, model, {});
    progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT,
        detail: `План: ${blueprint.length} intent-ов (без LLM)` });

    if (runId) {
        try { await runRepo.insertIntents(runId, blueprint); }
        catch (e) { console.warn(`[PIPELINE] Could not persist intents: ${e.message}`); }
    }

    let validatedOffline = [];
    try {
        validatedOffline = buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax);
    } catch (e) {
        console.error(`[PIPELINE] Офлайн-сборка вопросов: ${e.message}`);
    }

    const finalQuestions = validatedOffline.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
    const durationMs     = Date.now() - startTime;
    progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY,
        detail: `Готово: ${finalQuestions.length} вопросов (без LLM)` });

    const generationMetrics = buildGenerationMetrics({
        traceId, sessionId: opts.sessionId, documentId, model, durationMs,
        targetCount, targetMin, targetMax,
        blueprintIntents: blueprint.length,
        parseQualityScore: opts.extractionQuality,
        chunkCount: indexedChunks.length,
        chunksWithFacts: indexedChunks.filter(c => countMergedFactBullets(c, 99) > 0).length,
        atomicFactsExtracted: indexedChunks.reduce((s, c) => s + countMergedFactBullets(c, 99), 0),
        retrievalPassed: 0, retrievalSkipped: 0,
        groundingAccepted: finalQuestions.length, groundingFailed: 0,
        batchValidated: 0, llmSkipped: blueprint.length, validationFailed: 0,
        preDedupCount: finalQuestions.length, postDedupCount: finalQuestions.length,
        finalCount: finalQuestions.length,
        backfillRounds: 0, backfillQuestionsAdded: 0, evidenceScores: [],
        quotaOffline: true,
    });

    const fallbackDecision = applyFallbackDecisions({
        retrievalPassed: 0, retrievalSkipped: 0,
        finalCount: finalQuestions.length, blueprintIntents: blueprint.length,
    }, { traceId, documentId });

    if (runId) {
        try {
            for (let i = 0; i < finalQuestions.length; i++) {
                const q    = finalQuestions[i];
                const qRow = await runRepo.insertQuestion(runId, i, q);
                if (q.sources && q.sources.length > 0) await runRepo.insertQuestionSources(qRow.id, q.sources);
            }
            await runRepo.updateRunFinished(runId, {
                status: 'completed',
                final_metrics: generationMetrics,
                fallback_decisions: { decision: fallbackDecision, quota_offline: true },
                duration_ms: durationMs,
            });
        } catch (e) {
            console.warn(`[PIPELINE] Could not persist run results: ${e.message}`);
        }
    }

    logStructured({
        level: 'warn', traceId, sessionId: opts.sessionId, documentId, testId: null,
        phase: 'finalize', event: 'generation_quota_offline',
        metrics: { duration_ms: durationMs, final_question_count: finalQuestions.length, run_id: runId },
    });

    return { finalQuestions, generationMetrics, runId, offline: true };
}

// ─── blueprint phase ─────────────────────────────────────────────────────────

async function buildBlueprint({
    indexedChunks, fullText, model, count, pipelineContext, progress, traceId, documentId,
}) {
    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'generate_phase_begin',
        metadata: { step: 'build_themes_and_blueprint', model },
    });

    let blueprint;
    try {
        blueprint = await rag.buildThemesAndBlueprint(indexedChunks, fullText, model, count, {
            onRetry: ({ attempt, maxAttempts, parsed }) => {
                let detail = `Повтор запроса к модели (${attempt}/${maxAttempts})…`;
                if (parsed.isTransientUnavailable) detail = `Модель перегружена, ждём… (${attempt}/${maxAttempts})`;
                else if (parsed.isResourceExhausted)  detail = `Лимит запросов, ждём… (${attempt}/${maxAttempts})`;
                progress({ phase: 'generate', stage: 'blueprint', detail });
            },
        });
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: 'Темы извлечены' });
    } catch (err) {
        logStructured({
            level: 'error', traceId, documentId, phase: 'generate', event: 'generate_phase_failed',
            defectClass: DEFECT_CLASSES.SYSTEM_ERROR,
            metadata: { step: 'build_themes_and_blueprint', error_message: String(err.message || '').slice(0, 500) },
        });
        console.warn(`[PIPELINE] buildThemesAndBlueprint failed: ${err.message}. Fallback.`);
        pipelineContext.executionMode = err.type === 'QUOTA_EXCEEDED' ? 'degraded' : 'emergency_fallback';
        pipelineContext.degradedReasons.push('blueprint_fallback');
        pipelineContext.degradedStages.push('blueprint');

        const localThemes = rag.buildLocalThemesFromSections(indexedChunks);
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES,
            detail: 'Темы собраны из заголовков (fallback)' });

        const richThemes = localThemes.map(t => typeof t === 'string'
            ? { topic: t, section: 'Документ', importance: 2, suggestedCount: 3 } : t);
        const perTheme = rag.computeIntentsPerTheme(richThemes, count);
        blueprint = rag.buildBlueprintFallbackLocal(richThemes, perTheme);
    }

    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'generate_phase_end',
        metrics: { blueprint_intent_count: blueprint.length },
        metadata: { step: 'build_themes_and_blueprint' },
    });
    console.log(`[PIPELINE] Blueprint: ${blueprint.length} intent-ов`);
    progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT,
        detail: `План: ${blueprint.length} intent-ов` });

    return blueprint;
}

// ─── main batch loop ─────────────────────────────────────────────────────────

async function runMainBatchLoop({
    blueprintWithDifficulty, indexedChunks, coverageMap, model, detectedLang,
    enableGrounding, pipelineContext, batchSize, topK, traceId, documentId, progress,
    totalBatches,
}) {
    const allQuestions     = [];
    const evidenceScores   = [];
    let statsValidated     = 0;
    let statsSkippedEvidence = 0;
    let statsSkippedLLM    = 0;
    let statsValidationFailed = 0;
    let statsGroundingFailed  = 0;
    let statsRetrievalPassed  = 0;

    for (let batchStart = 0; batchStart < blueprintWithDifficulty.length; batchStart += batchSize) {
        const batch    = blueprintWithDifficulty.slice(batchStart, batchStart + batchSize);
        const batchNum = Math.floor(batchStart / batchSize) + 1;
        console.log(`[PIPELINE] Batch ${batchNum}/${totalBatches}: ${batch.length} intents`);

        const filteredBatch  = [];
        const evidenceList   = [];
        const chunkIdsList   = [];

        for (const intent of batch) {
            const relevantChunks = await rag.hybridRetrieve(
                `${intent.theme}: ${intent.intent}`, indexedChunks, topK
            );
            const packets      = rag.buildEvidencePackets(relevantChunks, intent.intent);
            const evidenceText = rag.formatEvidenceForPrompt(packets);
            const ids          = relevantChunks.map(c => c.id);

            const quality = scoreEvidenceQuality(evidenceText, intent.intent);
            evidenceScores.push(quality.score);

            if (quality.score < 0.3) {
                console.log(`[PIPELINE] Soft-skip intent "${intent.intent.slice(0, 60)}…" — ${quality.reason}`);
                statsSkippedEvidence++;
                logStructured({
                    level: 'warn', traceId, documentId, phase: 'generate',
                    event: 'intent_skipped_weak_evidence',
                    reasonCode: evidenceReasonToCode(quality.reason),
                    defectClass: DEFECT_CLASSES.RETRIEVAL_MISS,
                    metrics: { evidence_score: quality.score },
                    metadata: { intent_preview: intent.intent.slice(0, 120), reason: quality.reason },
                });
                continue;
            }

            statsRetrievalPassed++;
            filteredBatch.push(intent);
            evidenceList.push(evidenceText);
            chunkIdsList.push(ids);
            rag.updateCoverageMap(coverageMap, ids);
        }

        if (filteredBatch.length === 0) {
            console.warn(`[PIPELINE] Batch ${batchNum}: все intents пропущены (weak evidence)`);
            continue;
        }

        const { results: batchResults, stats: batchStats } = await generateBatchQuestions(
            filteredBatch, evidenceList, chunkIdsList, null, model, detectedLang
        );
        statsValidated        += batchResults.length;
        statsSkippedLLM       += batchStats.llmSkipped;
        statsValidationFailed += batchStats.validationFailed;

        let groundedMask = new Array(batchResults.length).fill(true);
        if (enableGrounding && pipelineContext.executionMode === 'normal') {
            const bQuestions = batchResults.map(r => r.question);
            const bEvidences = batchResults.map(r => evidenceList[r.intentIdx]);
            groundedMask = await checkGroundingBatched(bQuestions, bEvidences, model);
        }

        for (let i = 0; i < batchResults.length; i++) {
            const { question, intentIdx } = batchResults[i];
            if (!groundedMask[i]) {
                statsGroundingFailed++;
                console.warn(`[PIPELINE] Batch ${batchNum}, intent[${intentIdx + 1}]: не прошёл groundedness`);
                continue;
            }
            allQuestions.push(question);
        }

        progress({
            phase: 'generate', stage: 'llm_batch', workDelta: PW.GEN_BATCH,
            detail: `Пакет ${batchNum}/${totalBatches} (накоплено ${allQuestions.length})`,
        });

        if (batchStart + batchSize < blueprintWithDifficulty.length) await sleep(1200);
    }

    return {
        allQuestions, evidenceScores,
        statsValidated, statsSkippedEvidence, statsSkippedLLM,
        statsValidationFailed, statsGroundingFailed, statsRetrievalPassed,
    };
}

// ─── backfill loop ───────────────────────────────────────────────────────────

async function runBackfillLoop({
    initialDedup, indexedChunks, coverageMap, model, detectedLang,
    enableGrounding, pipelineContext, batchSize, targetMin,
    maxBackfillRounds, traceId, documentId, progress,
}) {
    let workingQuestions      = [...initialDedup];
    let backfillRoundsUsed    = 0;
    let backfillQuestionsAdded = 0;
    let backfillGroundedAccepted = 0;
    let statsSkippedLLM       = 0;
    let statsValidationFailed = 0;
    let statsSkippedEvidence  = 0;
    let statsGroundingFailed  = 0;

    for (let round = 1; round <= maxBackfillRounds && workingQuestions.length < targetMin; round++) {
        backfillRoundsUsed = round;
        const gap            = targetMin - workingQuestions.length;
        const uncoveredChunks = indexedChunks.filter(c => !coverageMap.usedChunkIds.has(c.id));
        const poolChunks     = uncoveredChunks.length > 0 ? uncoveredChunks : indexedChunks;

        console.log(`[PIPELINE] Backfill round ${round}/${maxBackfillRounds}: gap=${gap}, непокрытых: ${uncoveredChunks.length}/${indexedChunks.length}`);
        progress({ phase: 'generate', stage: 'backfill',
            detail: `Добор: раунд ${round}/${maxBackfillRounds}, сейчас ${workingQuestions.length}` });

        const intentsNeeded = Math.min(gap * 2, poolChunks.length * 3, 20);
        if (intentsNeeded === 0) { console.warn('[PIPELINE] Backfill: нет чанков'); break; }

        const backfillIntents   = createBackfillIntents(poolChunks, intentsNeeded, workingQuestions.length);
        const backfillWithDiff  = assignDifficulties(backfillIntents);
        const newRawQuestions   = [];
        const totalBF           = Math.ceil(backfillWithDiff.length / batchSize);

        for (let bs = 0; bs < backfillWithDiff.length; bs += batchSize) {
            const batchIntents  = backfillWithDiff.slice(bs, bs + batchSize);
            const bNum          = Math.floor(bs / batchSize) + 1;
            const bfEvidenceList = [];
            const bfChunkIdsList = [];
            const bfFiltered     = [];

            for (const intent of batchIntents) {
                const chunkRef     = intent._chunkRef;
                const packets      = rag.buildEvidencePackets([chunkRef], intent.intent);
                const evidenceText = rag.formatEvidenceForPrompt(packets);
                const quality      = scoreEvidenceQuality(evidenceText, intent.intent);
                if (quality.score < 0.3) { statsSkippedEvidence++; continue; }
                bfFiltered.push(intent);
                bfEvidenceList.push(evidenceText);
                bfChunkIdsList.push([chunkRef.id]);
                rag.updateCoverageMap(coverageMap, [chunkRef.id]);
            }

            if (bfFiltered.length === 0) continue;

            const { results: batchResults, stats: bfStats } = await generateBatchQuestions(
                bfFiltered, bfEvidenceList, bfChunkIdsList, null, model, detectedLang
            );
            statsSkippedLLM       += bfStats.llmSkipped;
            statsValidationFailed += bfStats.validationFailed;

            let bfMask = new Array(batchResults.length).fill(true);
            if (enableGrounding && pipelineContext.executionMode === 'normal') {
                const bQuestions = batchResults.map(r => r.question);
                const bEvidences = batchResults.map(r => bfEvidenceList[r.intentIdx]);
                bfMask = await checkGroundingBatched(bQuestions, bEvidences, model);
            }

            for (let i = 0; i < batchResults.length; i++) {
                if (!bfMask[i]) { statsGroundingFailed++; continue; }
                newRawQuestions.push(batchResults[i].question);
                backfillGroundedAccepted++;
            }

            progress({ phase: 'generate', stage: 'backfill_batch', workDelta: PW.GEN_BATCH,
                detail: `Добор: раунд ${round}, пакет ${bNum}/${totalBF}` });
            if (bs + batchSize < backfillWithDiff.length) await sleep(1200);
        }

        if (newRawQuestions.length === 0) { console.warn(`[PIPELINE] Backfill round ${round}: нет новых вопросов`); break; }

        const dedupedNew = newRawQuestions.length > 1
            ? await semanticDedup(newRawQuestions, rag.getBatchEmbeddings, config.DEDUP_THRESHOLD || 0.88)
            : newRawQuestions;

        const filtered = dedupedNew.filter(q =>
            !workingQuestions.some(ex => levenshteinSimilarity(q.question.toLowerCase(), ex.question.toLowerCase()) > 0.8)
        );

        console.log(`[PIPELINE] Backfill round ${round}: получено=${newRawQuestions.length}, dedup=${dedupedNew.length}, уникальных=${filtered.length}`);
        backfillQuestionsAdded += filtered.length;
        logStructured({
            level: 'info', traceId, documentId, phase: 'backfill', event: 'backfill_round_complete',
            metrics: { round, new_questions: filtered.length, total_now: workingQuestions.length + filtered.length },
        });
        workingQuestions = [...workingQuestions, ...filtered];
    }

    return {
        workingQuestions, backfillRoundsUsed, backfillQuestionsAdded, backfillGroundedAccepted,
        statsSkippedLLM, statsValidationFailed, statsSkippedEvidence, statsGroundingFailed,
    };
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Главная точка входа пайплайна.
 *
 * @param {string} fullText
 * @param {string} docName
 * @param {object[]} indexedChunks
 * @param {function} onProgress
 * @param {object} opts
 * @returns {Promise<{ title: string, questions: object[], generationMetrics: object, runId: number|null }>}
 */
async function runTestGeneratorFlow(fullText, docName, indexedChunks, onProgress, opts = {}) {
    const startTime  = Date.now();
    const model      = await quotaGuard.getAvailableModel(opts.model || config.LLM_MODEL);
    const traceId    = opts.traceId    || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const documentId = opts.documentId != null ? opts.documentId : null;
    const progress   = p => { if (typeof onProgress === 'function') onProgress(p); };

    // ── 1. Language detection ────────────────────────────────────────────────
    const { lang: detectedLang, diagnostics: langDiagnostics } = detectLanguageWithDiagnostics(fullText);
    console.log(`[PIPELINE] Язык: ${detectedLang} (${langDiagnostics.resolved_by})`);
    progress({ phase: 'generate', stage: 'language', workDelta: PW.GEN_LANG, detail: `Язык: ${detectedLang}` });
    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'document_language_detected',
        metrics: {
            lang: detectedLang, indexed_chunk_count: (indexedChunks || []).length,
            full_text_length: langDiagnostics.full_text_length, sample_chars: langDiagnostics.sample_chars,
            cyrillic_count: langDiagnostics.cyrillic_count, latin_count: langDiagnostics.latin_count,
            ru_word_hits: langDiagnostics.ru_word_hits, en_word_hits: langDiagnostics.en_word_hits,
        },
        metadata: { resolved_by: String(langDiagnostics.resolved_by) },
    });

    // ── 2. Chunk fallback ────────────────────────────────────────────────────
    if (!indexedChunks || indexedChunks.length === 0) {
        const chunks = chunkText(fullText);
        indexedChunks = chunks.map((c, i) => ({
            id: i + 1, chunk_index: c.index, text: c.text, token_count: c.tokens,
            page: c.page ?? null, section: c.section ?? null, heading: c.heading ?? null,
            embedding: null, summary: [],
        }));
    }

    // ── 3. Budget ────────────────────────────────────────────────────────────
    const budgetPlan = calculateQuestionBudget(fullText, indexedChunks, {
        extractionQuality: opts.extractionQuality,
        questionTypes: ['multiple_choice'],
    });
    const targetCount = budgetPlan.targetCount;
    const targetMin   = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax   = config.TARGET_QUESTIONS_MAX || 30;
    const count       = Math.round((targetMin + targetMax) / 2);

    budgetPlan.logs.forEach(l => console.log(`[BUDGET] ${l}`));
    if (budgetPlan.reductionReasons.length > 0)
        console.log(`[BUDGET] Урезание: ${budgetPlan.reductionReasons.join(' | ')}`);

    const atomicFactsExtracted = indexedChunks.reduce((s, c) => s + countMergedFactBullets(c, 99), 0);
    const chunksWithFacts      = indexedChunks.filter(c => countMergedFactBullets(c, 99) > 0).length;
    const nChunks              = indexedChunks.length;
    const chunksWithLlmFacts   = indexedChunks.filter(c => Array.isArray(c.summary) && c.summary.length > 0).length;
    const downstreamSource     = chunksWithFacts === 0 ? 'text'
        : chunksWithLlmFacts === nChunks ? 'summary'
        : chunksWithLlmFacts === 0 ? 'extractive'
        : 'mixed';

    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'budget_calculated',
        metrics: {
            budget_target: targetCount, target_min: targetMin, target_max: targetMax,
            chunk_count: indexedChunks.length, atomic_facts_extracted: atomicFactsExtracted,
            chunks_with_facts: chunksWithFacts, downstream_source: downstreamSource,
        },
        metadata: budgetPlan.reductionReasons.length ? { reduction_reasons: budgetPlan.reductionReasons } : undefined,
    });

    // ── 4. Pipeline context (degraded mode tracking) ─────────────────────────
    const pipelineContext = { executionMode: 'normal', degradedReasons: [], degradedStages: [] };
    const hasIndexerIssues = (indexedChunks || []).some(c =>
        c.summary_status === 'quota_skip'
        || c.summary_status === 'error'
        || (c.summary_status === 'empty' && countMergedFactBullets(c, 99) === 0));
    if (hasIndexerIssues) {
        pipelineContext.executionMode = 'degraded';
        pipelineContext.degradedReasons.push('indexer_fallback');
        pipelineContext.degradedStages.push('indexer');
    }

    // ── 5. Create generation_run ─────────────────────────────────────────────
    let runId = null;
    try {
        const runRow = await runRepo.insertRun({
            document_id: documentId, status: 'running', model,
            target_min: targetMin, target_max: targetMax, target_count: targetCount,
            language: detectedLang, budget_metrics: budgetPlan.metrics,
        });
        runId = runRow.id;
    } catch (e) {
        console.warn(`[PIPELINE] Could not create generation_run: ${e.message}`);
    }

    logStructured({ level: 'info', traceId, documentId, phase: 'generate', event: 'generation_start',
        metrics: { model, run_id: runId } });
    console.log(`[PIPELINE] Цель: ${targetMin}–${targetMax} | чанков: ${indexedChunks.length} | модель: ${model}`);

    // ── 6. Offline branch ────────────────────────────────────────────────────
    const llmRpdExhausted = await quotaGuard.isRpdExhaustedForModel(model);
    if (llmRpdExhausted) {
        console.warn('[PIPELINE] Дневной лимит isчерпан — offline mode');
        const result = await runOfflinePipeline({
            fullText, indexedChunks, model, targetCount, targetMin, targetMax,
            detectedLang, startTime, runId, traceId, documentId, opts, progress,
        });
        const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
        return {
            title: `Тест по документу: ${cleanName} (без LLM — квота)`,
            questions: result.finalQuestions,
            generationMetrics: result.generationMetrics,
            runId: result.runId,
        };
    }

    // ── 7. Blueprint ─────────────────────────────────────────────────────────
    const blueprint = await buildBlueprint({
        indexedChunks, fullText, model, count, pipelineContext, progress, traceId, documentId,
    });

    if (runId) {
        try { await runRepo.insertIntents(runId, blueprint); }
        catch (e) { console.warn(`[PIPELINE] Could not persist intents: ${e.message}`); }
    }

    // ── 8. Main batch generation ─────────────────────────────────────────────
    const topK            = config.RAG_TOP_K || 5;
    const batchSize       = Math.max(3, Math.min(5, config.LLM_BATCH_SIZE || 4));
    const enableGrounding = config.ENABLE_GROUNDING !== false;
    const blueprintWithDifficulty = assignDifficulties(blueprint);
    const coverageMap     = rag.buildCoverageMap(indexedChunks);
    const totalBatches    = Math.ceil(blueprintWithDifficulty.length / batchSize);

    console.log(`[PIPELINE] Batch-режим: ${blueprintWithDifficulty.length} intents → ${totalBatches} batch(ей) по ≤${batchSize}`);
    if (opts.traceId) jobProgress.refineMainBatchPlan(String(opts.traceId), totalBatches);

    const mainLoop = await runMainBatchLoop({
        blueprintWithDifficulty, indexedChunks, coverageMap, model, detectedLang,
        enableGrounding, pipelineContext, batchSize, topK, traceId, documentId, progress, totalBatches,
    });
    const {
        allQuestions, evidenceScores,
        statsValidated, statsSkippedEvidence, statsSkippedLLM,
        statsValidationFailed, statsGroundingFailed, statsRetrievalPassed,
    } = mainLoop;

    console.log(`[PIPELINE] Покрытие: ${rag.formatCoverageReport(coverageMap)}`);
    console.log(`[PIPELINE] Статистика: blueprint=${blueprintWithDifficulty.length}, ` +
        `skipped_evidence=${statsSkippedEvidence}, validated=${statsValidated}, grounded=${allQuestions.length}`);

    // ── 9. Emergency fallback ────────────────────────────────────────────────
    if (allQuestions.length === 0) {
        console.warn('[PIPELINE] Нет вопросов после main loop → emergency_fallback');
        pipelineContext.executionMode = 'emergency_fallback';
        pipelineContext.degradedReasons.push('llm_generation_failed');
        pipelineContext.degradedStages.push('generation');
        try {
            const offlineQs = buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax);
            offlineQs.forEach(q => allQuestions.push(q));
        } catch (err) {
            console.error('[PIPELINE] Offline MCQ error:', err.message);
        }
    }

    // ── 10. Dedup ────────────────────────────────────────────────────────────
    const preDedupCount  = allQuestions.length;
    const groundedPreDedup = allQuestions.length;
    console.log('[PIPELINE] Семантическая дедупликация...');
    const initialDedup = await semanticDedup(allQuestions, rag.getBatchEmbeddings, config.DEDUP_THRESHOLD || 0.88);
    console.log(`[PIPELINE] После dedup: ${initialDedup.length} (было ${allQuestions.length})`);
    const dedupDropped = preDedupCount - initialDedup.length;
    if (dedupDropped > 0) {
        logStructured({
            level: 'info', traceId, documentId, phase: 'dedup', event: 'dedup_complete',
            metrics: { pre_dedup: preDedupCount, post_dedup: initialDedup.length, dedup_dropped: dedupDropped },
        });
    }
    progress({ phase: 'generate', stage: 'dedup', workDelta: PW.GEN_DEDUP,
        detail: `После дедупликации: ${initialDedup.length} вопросов` });

    // ── 11. Backfill ─────────────────────────────────────────────────────────
    const backfillResult = await runBackfillLoop({
        initialDedup, indexedChunks, coverageMap, model, detectedLang,
        enableGrounding, pipelineContext, batchSize, targetMin,
        maxBackfillRounds: config.BACKFILL_MAX_ROUNDS || 3,
        traceId, documentId, progress,
    });

    // ── 12. Finalize ─────────────────────────────────────────────────────────
    progress({ phase: 'generate', stage: 'finalize', workDelta: PW.GEN_FINALIZE, detail: 'Финализация…' });
    const finalQuestions = backfillResult.workingQuestions.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
    progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY,
        detail: `Готово: ${finalQuestions.length} вопросов` });

    const durationMs = Date.now() - startTime;
    console.log(`[PIPELINE] Итог → запрошено: ${targetMin}–${targetMax} | blueprint: ${blueprintWithDifficulty.length} | ` +
        `skipped(evidence): ${statsSkippedEvidence} | validated: ${statsValidated} | grounded: ${groundedPreDedup} | ` +
        `dedup: ${initialDedup.length} | финальных: ${finalQuestions.length} | ${(durationMs / 1000).toFixed(1)}s`);

    const fallbackDecision = applyFallbackDecisions({
        retrievalPassed: statsRetrievalPassed, retrievalSkipped: statsSkippedEvidence,
        finalCount: finalQuestions.length, blueprintIntents: blueprintWithDifficulty.length,
    }, { traceId, documentId });

    const generationMetrics = buildGenerationMetrics({
        traceId, sessionId: opts.sessionId, documentId, model, durationMs,
        targetCount, targetMin, targetMax,
        blueprintIntents: blueprintWithDifficulty.length,
        parseQualityScore: opts.extractionQuality,
        chunkCount: indexedChunks.length, chunksWithFacts, atomicFactsExtracted,
        retrievalPassed: statsRetrievalPassed, retrievalSkipped: statsSkippedEvidence,
        groundingAccepted: groundedPreDedup + backfillResult.backfillGroundedAccepted,
        groundingFailed: statsGroundingFailed + backfillResult.statsGroundingFailed,
        batchValidated: statsValidated,
        llmSkipped: statsSkippedLLM + backfillResult.statsSkippedLLM,
        validationFailed: statsValidationFailed + backfillResult.statsValidationFailed,
        preDedupCount, postDedupCount: initialDedup.length, finalCount: finalQuestions.length,
        backfillRounds: backfillResult.backfillRoundsUsed,
        backfillQuestionsAdded: backfillResult.backfillQuestionsAdded,
        evidenceScores,
        executionMode: pipelineContext.executionMode,
        degradedReasons: pipelineContext.degradedReasons,
        degradedStages: pipelineContext.degradedStages,
    });

    // ── 13. Persist results ──────────────────────────────────────────────────
    if (runId) {
        try {
            for (let i = 0; i < finalQuestions.length; i++) {
                const q    = finalQuestions[i];
                const qRow = await runRepo.insertQuestion(runId, i, q);
                if (q.sources && q.sources.length > 0) await runRepo.insertQuestionSources(qRow.id, q.sources);
            }
            await runRepo.updateRunFinished(runId, {
                status: 'completed',
                final_metrics: generationMetrics,
                fallback_decisions: fallbackDecision ? { decision: fallbackDecision } : null,
                duration_ms: durationMs,
            });
        } catch (e) {
            console.warn(`[PIPELINE] Could not persist run results: ${e.message}`);
        }
    }

    logStructured({
        level: generationMetrics.low_confidence ? 'warn' : 'info',
        traceId, sessionId: opts.sessionId, documentId, testId: null,
        phase: 'finalize',
        event: generationMetrics.low_confidence ? 'generation_low_confidence' : 'generation_complete',
        defectClass: generationMetrics.low_confidence ? DEFECT_CLASSES.VALIDATION_FAIL : null,
        fallbackTriggered: fallbackDecision || null,
        metrics: {
            duration_ms: durationMs,
            final_question_count: generationMetrics.final_question_count,
            final_quality_score: generationMetrics.final_quality_score,
            run_id: runId,
        },
    });

    const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
    return {
        title: `Тест по документу: ${cleanName}`,
        questions: finalQuestions,
        generationMetrics,
        runId,
    };
}

module.exports = { runTestGeneratorFlow };
