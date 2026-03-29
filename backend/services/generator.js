const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');
const quotaGuard = require('./quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry } = require('./geminiError');
const { chunkText } = require('./chunker');
const { validateQuestions, extractJSON } = require('./validator');
const rag = require('./rag');
const { calculateQuestionBudget } = require('./budgetCalculator');
const {
    logStructured,
    evidenceReasonToCode,
    buildGenerationMetrics,
    REASON_CODES,
    DEFECT_CLASSES,
} = require('../utils/observability');
const jobProgress = require('./jobProgress');
const runRepo = require('../db/repositories/runRepo');
const PW = jobProgress.WEIGHT;

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

const { getBatchSystemPrompt, GROUNDING_SYSTEM } = require('./llm/prompts');
const { detectLanguageWithDiagnostics, detectLanguage } = require('./nlp/languagePredictor');
const { scoreEvidenceQuality, assignDifficulties } = require('./nlp/scoring');
const { semanticDedup, levenshteinSimilarity } = require('./nlp/similarity');
const {
    pickChunkSnippet, buildOfflineMcqFromChunks, buildBatchPrompt,
    normalizeQuestion, generateBatchQuestions, checkGroundingBatched, createBackfillIntents
} = require('./generation/generationService');


// Fallback decisions imported from observability
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

async function generateTest(fullText, docName, indexedChunks, onProgress, opts = {}) {
    const startTime = Date.now();
    let requestedModel = opts.model || config.LLM_MODEL;
    const model = await quotaGuard.getAvailableModel(requestedModel);
    const traceId = opts.traceId || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const documentId = opts.documentId != null ? opts.documentId : null;

    const progress = (p) => {
        if (typeof onProgress === 'function') onProgress(p);
    };

    // Create generation_run record
    let runId = null;
    const { lang: detectedLang, diagnostics: langDiagnostics } = detectLanguageWithDiagnostics(fullText);

    if (!indexedChunks || indexedChunks.length === 0) {
        const chunks = chunkText(fullText);
        indexedChunks = chunks.map((c, i) => ({
            id: i + 1,
            chunk_index: c.index,
            text: c.text,
            token_count: c.tokens,
            page: c.page ?? null,
            section: c.section ?? null,
            heading: c.heading ?? null,
            embedding: null,
            summary: [],
        }));
    }

    const budgetPlan = calculateQuestionBudget(fullText, indexedChunks, {
        extractionQuality: opts.extractionQuality,
        questionTypes: ['multiple_choice'],
    });

    const targetCount = budgetPlan.targetCount;
    const targetMin = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;

    try {
        const runRow = await runRepo.insertRun({
            document_id: documentId,
            status: 'running',
            model,
            target_min: targetMin,
            target_max: targetMax,
            target_count: targetCount,
            language: detectedLang,
            budget_metrics: budgetPlan.metrics,
        });
        runId = runRow.id;
    } catch (e) {
        console.warn(`[GENERATOR] Could not create generation_run: ${e.message}`);
    }

    logStructured({
        level: 'info', traceId, documentId,
        phase: 'generate', event: 'generation_start',
        metrics: { model, run_id: runId },
    });

    console.log(`[GENERATOR] Определён язык документа: ${detectedLang} (${langDiagnostics.resolved_by})`);
    progress({ phase: 'generate', stage: 'language', workDelta: PW.GEN_LANG, detail: `Язык: ${detectedLang}` });

    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'document_language_detected',
        metrics: {
            lang: detectedLang,
            indexed_chunk_count: indexedChunks.length,
            full_text_length: langDiagnostics.full_text_length,
            sample_chars: langDiagnostics.sample_chars,
            cyrillic_count: langDiagnostics.cyrillic_count,
            latin_count: langDiagnostics.latin_count,
            ru_word_hits: langDiagnostics.ru_word_hits,
            en_word_hits: langDiagnostics.en_word_hits,
        },
        metadata: { resolved_by: String(langDiagnostics.resolved_by) },
    });

    budgetPlan.logs.forEach(l => console.log(`[BUDGET] ${l}`));
    if (budgetPlan.reductionReasons.length > 0) {
        console.log(`[BUDGET] Урезание объёма: ${budgetPlan.reductionReasons.join(' | ')}`);
    }

    const atomicFactsExtracted = indexedChunks.reduce((s, c) => s + (Array.isArray(c.summary) ? c.summary.length : 0), 0);
    const chunksWithFacts      = indexedChunks.filter(c => Array.isArray(c.summary) && c.summary.length > 0).length;
    const chunksWithTextOnly   = indexedChunks.length - chunksWithFacts;

    // Compute downstream_source flag for observability
    const downstreamSource = chunksWithFacts === indexedChunks.length ? 'summary'
        : chunksWithFacts === 0                                        ? 'text'
        : 'mixed';

    const pipelineContext = {
        executionMode: 'normal',
        degradedReasons: [],
        degradedStages: []
    };
    
    const hasIndexerIssues = (indexedChunks || []).some(c => c.summary_status === 'quota_skip' || c.summary_status === 'error' || c.summary_source === 'extractive');
    if (hasIndexerIssues) {
        pipelineContext.executionMode = 'degraded';
        pipelineContext.degradedReasons.push('indexer_fallback');
        pipelineContext.degradedStages.push('indexer');
    }

    if (chunksWithFacts < indexedChunks.length) {
        console.log(`[GENERATOR] downstream_source=${downstreamSource}: ${chunksWithFacts} summary-чанков, ${chunksWithTextOnly} text-only-чанков`);
    }

    logStructured({
        level: 'info', traceId, documentId,
        phase: 'generate', event: 'budget_calculated',
        metrics: {
            budget_target: targetCount, target_min: targetMin, target_max: targetMax,
            chunk_count: indexedChunks.length, atomic_facts_extracted: atomicFactsExtracted,
            chunks_with_facts: chunksWithFacts,
            downstream_source: downstreamSource,
        },
        metadata: budgetPlan.reductionReasons.length ? { reduction_reasons: budgetPlan.reductionReasons } : undefined,
    });

    console.log(`[GENERATOR] Цель (config: ${targetMin}–${targetMax}): выбран ${targetCount}, чанков: ${indexedChunks.length}, модель: ${model}`);

    const llmRpdExhausted = await quotaGuard.isRpdExhaustedForModel(model);
    if (llmRpdExhausted) {
        console.warn('[GENERATOR] Дневной лимит generateContent исчерпан — тест из чанков/выжимок без новых вызовов LLM');
        progress({
            phase: 'generate',
            stage: 'quota_offline',
            detail: 'Квота LLM на сутки исчерпана — вопросы из текста и сохранённых выжимок',
        });

        const themes = [{
            topic: 'Содержание документа',
            section: 'Документ',
            importance: 2,
            suggestedCount: Math.min(5, Math.max(3, Math.ceil(Math.max(1, targetCount) / 2))),
            difficultyCandidates: ['remember', 'understand'],
        }];
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: `Тем: ${themes.length} (режим без LLM)` });

        const blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, model, {});
        progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT, detail: `План: ${blueprint.length} intent-ов (без LLM)` });

        if (runId) {
            try {
                await runRepo.insertIntents(runId, blueprint);
            } catch (e) {
                console.warn(`[GENERATOR] Could not persist intents: ${e.message}`);
            }
        }

        let validatedOffline = [];
        try {
            validatedOffline = buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax);
        } catch (e) {
            console.error(`[GENERATOR] Офлайн-сборка вопросов: ${e.message}`);
        }

        const finalQuestions = validatedOffline.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
        const durationMs = Date.now() - startTime;
        progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY, detail: `Готово: ${finalQuestions.length} вопросов (без LLM)` });

        const generationMetrics = buildGenerationMetrics({
            traceId,
            sessionId: opts.sessionId,
            documentId,
            model,
            durationMs,
            targetCount,
            targetMin,
            targetMax,
            blueprintIntents: blueprint.length,
            parseQualityScore: opts.extractionQuality,
            chunkCount: indexedChunks.length,
            chunksWithFacts,
            atomicFactsExtracted,
            retrievalPassed: 0,
            retrievalSkipped: 0,
            groundingAccepted: finalQuestions.length,
            groundingFailed: 0,
            batchValidated: 0,
            llmSkipped: blueprint.length,
            validationFailed: 0,
            preDedupCount: finalQuestions.length,
            postDedupCount: finalQuestions.length,
            finalCount: finalQuestions.length,
            backfillRounds: 0,
            backfillQuestionsAdded: 0,
            evidenceScores: [],
            quotaOffline: true,
        });

        const fallbackDecision = applyFallbackDecisions({
            retrievalPassed: 0,
            retrievalSkipped: 0,
            finalCount: finalQuestions.length,
            blueprintIntents: blueprint.length,
            preDedupCount: finalQuestions.length,
            postDedupCount: finalQuestions.length,
        }, { traceId, documentId });

        if (runId) {
            try {
                for (let i = 0; i < finalQuestions.length; i++) {
                    const q = finalQuestions[i];
                    const qRow = await runRepo.insertQuestion(runId, i, q);
                    if (q.sources && q.sources.length > 0) {
                        await runRepo.insertQuestionSources(qRow.id, q.sources);
                    }
                }
                await runRepo.updateRunFinished(runId, {
                    status: 'completed',
                    final_metrics: generationMetrics,
                    fallback_decisions: {
                        decision: fallbackDecision,
                        quota_offline: true,
                    },
                    duration_ms: durationMs,
                });
            } catch (e) {
                console.warn(`[GENERATOR] Could not persist run results: ${e.message}`);
            }
        }

        logStructured({
            level: 'warn',
            traceId,
            sessionId: opts.sessionId,
            documentId,
            testId: null,
            phase: 'finalize',
            event: 'generation_quota_offline',
            metrics: {
                duration_ms: durationMs,
                final_question_count: finalQuestions.length,
                run_id: runId,
            },
        });

        const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
        return {
            title: `Тест по документу: ${cleanName} (без LLM — квота)`,
            questions: finalQuestions,
            generationMetrics,
            runId,
        };
    }

    const count = Math.round((targetMin + targetMax) / 2);

    console.log('[GENERATOR] Формирование тем и плана вопросов...');
    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_begin',
        metadata: { step: 'build_themes_and_blueprint', model },
    });

    let blueprint;
    try {
        blueprint = await rag.buildThemesAndBlueprint(indexedChunks, fullText, model, count, {
            onRetry: ({ attempt, maxAttempts, parsed }) => {
                let detail = `Повтор запроса к модели (${attempt}/${maxAttempts})…`;
                if (parsed.isTransientUnavailable) detail = `Модель перегружена (Google), ждём… (${attempt}/${maxAttempts})`;
                else if (parsed.isResourceExhausted) detail = `Лимит запросов к API, ждём… (${attempt}/${maxAttempts})`;
                progress({ phase: 'generate', stage: 'blueprint', detail });
            },
        });
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: `Темы извлечены` });
    } catch (err) {
        logStructured({
            level: 'error',
            traceId,
            documentId,
            phase: 'generate',
            event: 'generate_phase_failed',
            defectClass: DEFECT_CLASSES.SYSTEM_ERROR,
            metadata: { step: 'build_themes_and_blueprint', error_message: String(err.message || '').slice(0, 500) },
        });
        console.warn(`[GENERATOR] buildThemesAndBlueprint throw: ${err.message}. Переход на fallback.`);
        pipelineContext.executionMode = err.type === 'QUOTA_EXCEEDED' ? 'degraded' : 'emergency_fallback';
        pipelineContext.degradedReasons.push('blueprint_fallback');
        pipelineContext.degradedStages.push('blueprint');
        
        const localThemes = rag.buildLocalThemesFromSections(indexedChunks);
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: `Темы собраны из заголовков (fallback)` });

        const richThemes = localThemes.map(t => typeof t === 'string'
            ? { topic: t, section: 'Документ', importance: 2, suggestedCount: 3 } : t
        );
        const perTheme = rag.computeIntentsPerTheme(richThemes, count);
        blueprint = rag.buildBlueprintFallbackLocal(richThemes, perTheme);
    }

    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_end',
        metrics: { blueprint_intent_count: blueprint.length },
        metadata: { step: 'build_themes_and_blueprint' },
    });
    console.log(`[GENERATOR] Blueprint (совмещённый план): ${blueprint.length} intent-ов`);
    progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT, detail: `План: ${blueprint.length} intent-ов` });

    // Persist intents
    if (runId) {
        try { await runRepo.insertIntents(runId, blueprint); } catch (e) {
            console.warn(`[GENERATOR] Could not persist intents: ${e.message}`);
        }
    }

    const topK = config.RAG_TOP_K || 5;
    const batchSize = Math.max(3, Math.min(5, config.LLM_BATCH_SIZE || 4));
    const allQuestions = [];
    const enableGrounding = config.ENABLE_GROUNDING !== false;

    const blueprintWithDifficulty = assignDifficulties(blueprint);
    const coverageMap = rag.buildCoverageMap(indexedChunks);

    let statsValidated = 0;
    let statsSkippedEvidence = 0;
    let statsSkippedLLM = 0;
    let statsValidationFailed = 0;
    let statsGroundingFailed = 0;
    let statsRetrievalPassed = 0;
    const evidenceScores = [];

    const totalBatches = Math.ceil(blueprintWithDifficulty.length / batchSize);
    console.log(`[GENERATOR] Batch-режим: ${blueprintWithDifficulty.length} intents → ${totalBatches} batch(ей) по ≤${batchSize}`);

    if (opts.traceId) {
        jobProgress.refineMainBatchPlan(String(opts.traceId), totalBatches);
    }

    for (let batchStart = 0; batchStart < blueprintWithDifficulty.length; batchStart += batchSize) {
        const batch = blueprintWithDifficulty.slice(batchStart, batchStart + batchSize);
        const batchNum = Math.floor(batchStart / batchSize) + 1;
        console.log(`[GENERATOR] Batch ${batchNum}/${totalBatches}: ${batch.length} intents`);

        const filteredBatch = [];
        const evidenceList = [];
        const chunkIdsList = [];

        for (const intent of batch) {
            const relevantChunks = await rag.hybridRetrieve(
                `${intent.theme}: ${intent.intent}`,
                indexedChunks, topK
            );
            const packets = rag.buildEvidencePackets(relevantChunks, intent.intent);
            const evidenceText = rag.formatEvidenceForPrompt(packets);
            const ids = relevantChunks.map(c => c.id);

            const quality = scoreEvidenceQuality(evidenceText, intent.intent);
            evidenceScores.push(quality.score);
            if (quality.score < 0.3) {
                console.log(`[GENERATOR] Soft-skip intent "${intent.intent.slice(0, 60)}…" — ${quality.reason}`);
                statsSkippedEvidence++;
                logStructured({
                    level: 'warn', traceId, documentId,
                    phase: 'generate', event: 'intent_skipped_weak_evidence',
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
            console.warn(`[GENERATOR] Batch ${batchNum}: все intents пропущены (weak evidence)`);
            continue;
        }

        const { results: batchResults, stats: batchStats } = await generateBatchQuestions(
            filteredBatch, evidenceList, chunkIdsList, null, model, detectedLang,
        );
        statsValidated += batchResults.length;
        statsSkippedLLM += batchStats.llmSkipped;
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
                console.warn(`[GENERATOR] Batch ${batchNum}, intent[${intentIdx + 1}]: не прошёл groundedness`);
                continue;
            }
            allQuestions.push(question);
        }

        progress({
            phase: 'generate', stage: 'llm_batch', workDelta: PW.GEN_BATCH,
            detail: `Генерация вопросов: пакет ${batchNum}/${totalBatches} (накоплено ${allQuestions.length})`,
        });

        if (batchStart + batchSize < blueprintWithDifficulty.length) await sleep(1200);
    }

    console.log(`[GENERATOR] Покрытие: ${rag.formatCoverageReport(coverageMap)}`);
    console.log(`[GENERATOR] Статистика: blueprint=${blueprintWithDifficulty.length}, skipped_evidence=${statsSkippedEvidence}, validated=${statsValidated}, grounded=${allQuestions.length}, target=${targetMin}`);

    if (allQuestions.length === 0) {
        console.warn('[GENERATOR] Главный цикл не сгенерировал ни одного вопроса. Переход в emergency_fallback (offline MCQ).');
        pipelineContext.executionMode = 'emergency_fallback';
        pipelineContext.degradedReasons.push('llm_generation_failed');
        pipelineContext.degradedStages.push('generation');
        try {
            const offlineQs = buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax);
            offlineQs.forEach(q => allQuestions.push(q));
        } catch (err) {
            console.error('[GENERATOR] Offline MCQ тоже вернул ошибку:', err.message);
        }
    }

    const preDedupCount = allQuestions.length;
    const groundedPreDedup = allQuestions.length;

    console.log('[GENERATOR] Семантическая дедупликация...');
    const initialDedup = await semanticDedup(allQuestions, rag.getBatchEmbeddings, config.DEDUP_THRESHOLD || 0.88);
    console.log(`[GENERATOR] После дедупликации: ${initialDedup.length} (было ${allQuestions.length})`);

    const dedupDropped = preDedupCount - initialDedup.length;
    if (dedupDropped > 0) {
        logStructured({
            level: 'info', traceId, documentId,
            phase: 'dedup', event: 'dedup_complete',
            metrics: { pre_dedup: preDedupCount, post_dedup: initialDedup.length, dedup_dropped: dedupDropped },
        });
    }
    progress({ phase: 'generate', stage: 'dedup', workDelta: PW.GEN_DEDUP, detail: `После дедупликации: ${initialDedup.length} вопросов` });

    // ── Backfill ──
    const maxBackfillRounds = config.BACKFILL_MAX_ROUNDS || 3;
    let workingQuestions = [...initialDedup];
    let backfillRoundsUsed = 0;
    let backfillQuestionsAdded = 0;
    let backfillGroundedAccepted = 0;

    for (let round = 1; round <= maxBackfillRounds && workingQuestions.length < targetMin; round++) {
        backfillRoundsUsed = round;
        const gap = targetMin - workingQuestions.length;
        const uncoveredChunks = indexedChunks.filter(c => !coverageMap.usedChunkIds.has(c.id));
        const poolChunks = uncoveredChunks.length > 0 ? uncoveredChunks : indexedChunks;

        console.log(`[GENERATOR] Backfill round ${round}/${maxBackfillRounds}: gap=${gap}, непокрытых чанков: ${uncoveredChunks.length}/${indexedChunks.length}`);
        progress({ phase: 'generate', stage: 'backfill', detail: `Добор вопросов: раунд ${round}/${maxBackfillRounds}, сейчас ${workingQuestions.length}` });

        const intentsNeeded = Math.min(gap * 2, poolChunks.length * 3, 20);
        if (intentsNeeded === 0) { console.warn('[GENERATOR] Backfill: нет доступных чанков'); break; }

        const backfillIntents = createBackfillIntents(poolChunks, intentsNeeded, workingQuestions.length);
        const backfillWithDiff = assignDifficulties(backfillIntents);
        const newRawQuestions = [];
        const totalBackfillBatches = Math.ceil(backfillWithDiff.length / batchSize);

        for (let bs = 0; bs < backfillWithDiff.length; bs += batchSize) {
            const batchIntents = backfillWithDiff.slice(bs, bs + batchSize);
            const bNum = Math.floor(bs / batchSize) + 1;
            const bfEvidenceList = [];
            const bfChunkIdsList = [];
            const bfFilteredBatch = [];

            for (const intent of batchIntents) {
                const chunkRef = intent._chunkRef;
                const packets = rag.buildEvidencePackets([chunkRef], intent.intent);
                const evidenceText = rag.formatEvidenceForPrompt(packets);
                const quality = scoreEvidenceQuality(evidenceText, intent.intent);
                if (quality.score < 0.3) { statsSkippedEvidence++; continue; }
                bfFilteredBatch.push(intent);
                bfEvidenceList.push(evidenceText);
                bfChunkIdsList.push([chunkRef.id]);
                rag.updateCoverageMap(coverageMap, [chunkRef.id]);
            }

            if (bfFilteredBatch.length === 0) continue;

            const { results: batchResults, stats: bfStats } = await generateBatchQuestions(
                bfFilteredBatch, bfEvidenceList, bfChunkIdsList, null, model, detectedLang,
            );
            statsSkippedLLM += bfStats.llmSkipped;
            statsValidationFailed += bfStats.validationFailed;

            let bfGroundedMask = new Array(batchResults.length).fill(true);
            if (enableGrounding && pipelineContext.executionMode === 'normal') {
                const bQuestions = batchResults.map(r => r.question);
                const bEvidences = batchResults.map(r => bfEvidenceList[r.intentIdx]);
                bfGroundedMask = await checkGroundingBatched(bQuestions, bEvidences, model);
            }

            for (let i = 0; i < batchResults.length; i++) {
                const { question, intentIdx } = batchResults[i];
                if (!bfGroundedMask[i]) { statsGroundingFailed++; continue; }
                newRawQuestions.push(question);
                backfillGroundedAccepted++;
            }

            progress({
                phase: 'generate', stage: 'backfill_batch', workDelta: PW.GEN_BATCH,
                detail: `Добор: раунд ${round}, пакет ${bNum}/${totalBackfillBatches}`,
            });
            if (bs + batchSize < backfillWithDiff.length) await sleep(1200);
        }

        if (newRawQuestions.length === 0) { console.warn(`[GENERATOR] Backfill round ${round}: нет новых вопросов`); break; }

        const dedupedNew = newRawQuestions.length > 1
            ? await semanticDedup(newRawQuestions, rag.getBatchEmbeddings, config.DEDUP_THRESHOLD || 0.88)
            : newRawQuestions;

        const filtered = dedupedNew.filter(q =>
            !workingQuestions.some(existing =>
                levenshteinSimilarity(q.question.toLowerCase(), existing.question.toLowerCase()) > 0.8
            )
        );

        console.log(`[GENERATOR] Backfill round ${round}: получено=${newRawQuestions.length}, dedup=${dedupedNew.length}, уникальных=${filtered.length}`);
        backfillQuestionsAdded += filtered.length;
        logStructured({
            level: 'info', traceId, documentId,
            phase: 'backfill', event: 'backfill_round_complete',
            metrics: { round, new_questions: filtered.length, total_now: workingQuestions.length + filtered.length },
        });
        workingQuestions = [...workingQuestions, ...filtered];
    }

    progress({ phase: 'generate', stage: 'finalize', workDelta: PW.GEN_FINALIZE, detail: 'Финализация списка вопросов…' });
    const finalQuestions = workingQuestions.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
    progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY, detail: `Готово к сохранению: ${finalQuestions.length} вопросов` });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const durationMs = Date.now() - startTime;
    console.log(
        `[GENERATOR] Итог → запрошено: ${targetMin}–${targetMax} | blueprint: ${blueprintWithDifficulty.length} | ` +
        `skipped(evidence): ${statsSkippedEvidence} | validated: ${statsValidated} | grounded: ${allQuestions.length} | ` +
        `после dedup: ${initialDedup.length} | финальных: ${finalQuestions.length} | время: ${elapsed}s`
    );

    const fallbackDecision = applyFallbackDecisions({
        retrievalPassed: statsRetrievalPassed,
        retrievalSkipped: statsSkippedEvidence,
        finalCount: finalQuestions.length,
        blueprintIntents: blueprintWithDifficulty.length,
        preDedupCount,
        postDedupCount: initialDedup.length,
    }, { traceId, documentId });

    const generationMetrics = buildGenerationMetrics({
        traceId, sessionId: opts.sessionId, documentId, model, durationMs,
        targetCount, targetMin, targetMax,
        blueprintIntents: blueprintWithDifficulty.length,
        parseQualityScore: opts.extractionQuality,
        chunkCount: indexedChunks.length, chunksWithFacts, atomicFactsExtracted,
        retrievalPassed: statsRetrievalPassed, retrievalSkipped: statsSkippedEvidence,
        groundingAccepted: groundedPreDedup + backfillGroundedAccepted, groundingFailed: statsGroundingFailed,
        batchValidated: statsValidated, llmSkipped: statsSkippedLLM, validationFailed: statsValidationFailed,
        preDedupCount, postDedupCount: initialDedup.length, finalCount: finalQuestions.length,
        backfillRounds: backfillRoundsUsed, backfillQuestionsAdded, evidenceScores,
        executionMode: pipelineContext.executionMode,
        degradedReasons: pipelineContext.degradedReasons,
        degradedStages: pipelineContext.degradedStages,
    });

    // Persist questions and update run
    if (runId) {
        try {
            for (let i = 0; i < finalQuestions.length; i++) {
                const q = finalQuestions[i];
                const qRow = await runRepo.insertQuestion(runId, i, q);
                if (q.sources && q.sources.length > 0) {
                    await runRepo.insertQuestionSources(qRow.id, q.sources);
                }
            }
            await runRepo.updateRunFinished(runId, {
                status: 'completed',
                final_metrics: generationMetrics,
                fallback_decisions: fallbackDecision ? { decision: fallbackDecision } : null,
                duration_ms: durationMs,
            });
        } catch (e) {
            console.warn(`[GENERATOR] Could not persist run results: ${e.message}`);
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

module.exports = { generateTest, detectLanguage, scoreEvidenceQuality, BLOOM_LEVELS };
