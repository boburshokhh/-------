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
const { AGENT_ROLES, AGENT_RESOLUTION_ORDER } = require('../../config/agentRoles');
const { BUILT_IN_ROUTING_MODES, isMaxQualityMode, shouldBypassAppLimits } = require('../../config/routingModes');
const { STAGE_KEYS } = require('../../config/stageTaxonomy');
const { chunkText } = require('../chunker');
const { calculateQuestionBudget } = require('../budgetCalculator');
const quotaGuard   = require('../quotaGuard');
const modelRouter  = require('../modelRouter');
const { resolveExecutionMode, estimateQuotaBudget } = require('../quotaBudget');
const jobProgress  = require('../jobProgress');
const runRepo      = require('../../db/repositories/runRepo');
const pgPool       = require('../../db/pgPool');
const customModeProfilesRepo = require('../../db/repositories/customModeProfilesRepo');
const customModeService = require('../customModeService');

// NLP
const { resolveDocumentLanguage } = require('../nlp/languagePredictor');
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

/**
 * Резолвинг моделей по stage taxonomy через RoutingEngine (primary path).
 *
 * Упрощение агентного слоя:
 *  - evaluation_agent полностью исключён (всегда null, не нужен).
 *  - При успешном V2: только 5 агентов (embedding, structuring, blueprint, generator, backfill).
 *  - quality_agent (grounding) оставлен для совместимости, но grounding отключён по умолчанию.
 *  - Legacy routing отображает предупреждение и используется только когда V2 недоступен.
 */
async function resolvePipelineAgentModels({
    routingMode,
    documentMetadata,
    complexityNorm,
    quotaSnapshot,
    adminOverrides,
    traceId,
    documentId,
}) {
    const v2 = await modelRouter.resolvePipelineModelsV2({
        routingMode,
        documentMetadata,
        complexityScore: complexityNorm,
        quotaSnapshot,
        adminOverrides,
        traceId,
        documentId,
    });

    if (v2) {
        const decisions = {};
        const modelsByAgent = {};
        const skipLocalAvailabilityFallback = isMaxQualityMode(routingMode);
        // Только стадии с реальным LLM; evaluation_agent исключён.
        const stageToAgent = {
            [STAGE_KEYS.embedding]:             AGENT_ROLES.evidence,
            [STAGE_KEYS.cheap_preprocess]:      AGENT_ROLES.structuring,
            [STAGE_KEYS.blueprint_generation]:  AGENT_ROLES.blueprint,
            [STAGE_KEYS.question_generation]:   AGENT_ROLES.generator,
            [STAGE_KEYS.grounding_validation]:  AGENT_ROLES.quality,
            [STAGE_KEYS.backfill_generation]:   AGENT_ROLES.backfill,
        };
        for (const [stageKey, agentRole] of Object.entries(stageToAgent)) {
            const d = v2.decisions[stageKey];
            if (d) {
                decisions[agentRole] = d;
                let m = d.selectedModel;
                if (m && !skipLocalAvailabilityFallback) {
                    const avail = await quotaGuard.getAvailableModel(m);
                    if (avail) m = avail;
                    else if (d.fallbackModel) {
                        const fb = await quotaGuard.getAvailableModel(d.fallbackModel);
                        if (fb) m = fb;
                    }
                }
                modelsByAgent[agentRole] = m;
            }
        }
        // evaluation_agent не нужен — всегда null, исключён из routing loop
        modelsByAgent[AGENT_ROLES.evaluation] = null;
        return { decisions, modelsByAgent };
    }

    // Legacy path: используется только когда V2 (RoutingEngine) недоступен.
    // Это устаревший путь; если вы видите это предупреждение регулярно —
    // проверьте конфигурацию routing rules в БД.
    console.warn('[PIPELINE] resolvePipelineModelsV2 вернул null — fallback на legacy agent routing');
    logStructured({
        level: 'warn', traceId, documentId, phase: 'generate',
        event: 'legacy_routing_fallback',
        metadata: { requested_mode: routingMode, reason: 'routing_engine_v2_unavailable' },
    });

    const base = {
        requestedMode: routingMode,
        documentMetadata,
        complexityScore: complexityNorm,
        quotaSnapshot,
        adminOverrides,
        traceId,
        documentId,
        executionMode: 'normal',
    };
    const decisions = {};
    const modelsByAgent = {};
    // evaluation_agent пропускается — всегда null
    const activeRoles = AGENT_RESOLUTION_ORDER.filter(r => r !== AGENT_ROLES.evaluation);
    for (const agentRole of activeRoles) {
        const d = await modelRouter.routeModelForAgent({ ...base, agentRole });
        decisions[agentRole] = d;
        let m = null;
        if (d.selectedModel != null) {
            if (isMaxQualityMode(routingMode)) {
                m = d.selectedModel;
            } else {
                m = await quotaGuard.getAvailableModel(d.selectedModel);
                if (!m && d.fallbackModel) m = await quotaGuard.getAvailableModel(d.fallbackModel);
            }
            if (!m) m = d.selectedModel;
        }
        modelsByAgent[agentRole] = m;
    }
    modelsByAgent[AGENT_ROLES.evaluation] = null;
    return { decisions, modelsByAgent };
}

async function resolveCustomModeAgentModels({
    routingMode,
    traceId,
    documentId,
}) {
    const builtInModes = new Set(BUILT_IN_ROUTING_MODES);
    const code = String(routingMode || '').toLowerCase().trim();
    if (!code || builtInModes.has(code)) {
        return null;
    }

    const profileBase = await customModeProfilesRepo.getProfileByCode(code);
    if (!profileBase || profileBase.is_archived || profileBase.is_disabled) {
        return null;
    }
    const profile = await customModeProfilesRepo.getProfileWithAssignmentsById(profileBase.id);
    if (!profile) return null;

    const preview = await customModeService.buildEffectivePreview({
        profile,
        assignments: profile.assignments || [],
        requestedContext: {},
    });

    const modelsByAgent = {
        [AGENT_ROLES.structuring]: null,
        [AGENT_ROLES.evidence]: null,
        [AGENT_ROLES.blueprint]: null,
        [AGENT_ROLES.generator]: null,
        [AGENT_ROLES.quality]: null,
        [AGENT_ROLES.backfill]: null,
        [AGENT_ROLES.evaluation]: null,
    };
    const decisions = {};

    const stageToAgent = {
        [STAGE_KEYS.embedding]: AGENT_ROLES.evidence,
        [STAGE_KEYS.cheap_preprocess]: AGENT_ROLES.structuring,
        [STAGE_KEYS.facts_enrichment]: AGENT_ROLES.structuring,
        [STAGE_KEYS.theme_extraction]: AGENT_ROLES.blueprint,
        [STAGE_KEYS.blueprint_generation]: AGENT_ROLES.blueprint,
        [STAGE_KEYS.question_generation]: AGENT_ROLES.generator,
        [STAGE_KEYS.grounding_validation]: AGENT_ROLES.quality,
        [STAGE_KEYS.backfill_generation]: AGENT_ROLES.backfill,
        [STAGE_KEYS.audit_debug]: AGENT_ROLES.evaluation,
    };

    for (const row of preview.rows || []) {
        const agentRole = stageToAgent[row.stage_key];
        if (!agentRole || !row.effective_primary) continue;
        modelsByAgent[agentRole] = row.effective_primary;
        decisions[agentRole] = {
            selectedModel: row.effective_primary,
            fallbackModel: Array.isArray(row.effective_fallbacks) ? (row.effective_fallbacks[0] || null) : null,
            reason: row.fallback_reason || 'custom_mode_assignment',
            costTier: modelRouter.costTierFromModelId(row.effective_primary),
            isPreview: false,
            agentRole,
            fromDbRule: true,
        };
    }

    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'custom_mode_models_applied',
        metadata: {
            mode_code: profile.code,
            mode_profile_id: profile.id,
            mode_profile_version: profile.config_version || 1,
        },
    });

    return {
        profile,
        decisions,
        modelsByAgent,
    };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function derivePipelineComplexity(opts, indexedChunks, documentMetadata) {
    if (typeof opts.complexityScore === 'number' && !Number.isNaN(opts.complexityScore)) {
        return modelRouter.normalizeComplexity(opts.complexityScore);
    }
    const n = (indexedChunks || []).length;
    const meta = documentMetadata || {};
    const pages = Number(meta.page_count) || 0;
    let score = 0.35;
    if (n > 25) score += 0.2;
    if (pages > (config.MODEL_ROUTING?.maxPagesForEasyDoc ?? 15)) score += 0.15;
    if (meta.low_text_quality) score += 0.2;
    const ext = opts.extractionQuality || meta.extraction_quality;
    if (ext === 'low' || ext === 'poor') score += 0.15;
    return Math.min(1, score);
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
    fullText, indexedChunks, model, modelBlueprint, modelsByAgent, targetCount, targetMin, targetMax,
    detectedLang, startTime, runId, traceId, documentId, opts, progress,
    routingModeRequested = 'auto',
    routingModeEffective = 'auto',
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

    const bpModel = modelBlueprint || model;
    const blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, bpModel, {});
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
        modelsByAgent: modelsByAgent || undefined,
        routing_mode_requested: routingModeRequested,
        routing_mode_effective: routingModeEffective,
        pipeline_execution_mode: 'quota_offline',
        degraded_reasons: ['rpd_exhausted'],
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

const blueprintCache = require('../blueprintCache');

async function buildBlueprint({
    indexedChunks, fullText, model, count, pipelineContext, progress, traceId, documentId,
    bypassLimits = false, detectedLang = 'ru', routingMode = 'auto',
}) {
    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'generate_phase_begin',
        metadata: { step: 'build_themes_and_blueprint', model },
    });

    // ── Blueprint cache check ────────────────────────────────────────────────
    let cacheHit = false;
    let docHash = null;
    if (blueprintCache.isEnabled()) {
        docHash = blueprintCache.computeDocumentHash(fullText);
        const cached = await blueprintCache.getBlueprint(docHash, routingMode, count, detectedLang, traceId);
        if (cached.blueprint) {
            cacheHit = true;
            progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES,
                detail: `Темы из кэша (${cached.blueprint.length} intent-ов)` });
            progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT,
                detail: `Blueprint из кэша: ${cached.blueprint.length} intent-ов` });
            logStructured({
                level: 'info', traceId, documentId, phase: 'generate', event: 'generate_phase_end',
                metrics: { blueprint_intent_count: cached.blueprint.length },
                metadata: { step: 'build_themes_and_blueprint', from_cache: true },
            });
            return { blueprint: cached.blueprint, cacheHit: true };
        }
    }

    let blueprint;
    try {
        blueprint = await rag.buildThemesAndBlueprint(indexedChunks, fullText, model, count, {
            bypassLimits,
            onRetry: ({ attempt, maxAttempts, parsed }) => {
                let detail = `Повтор запроса к модели (${attempt}/${maxAttempts})…`;
                if (parsed.isTransientUnavailable) detail = `Модель перегружена, ждём… (${attempt}/${maxAttempts})`;
                else if (parsed.isResourceExhausted)  detail = `Лимит запросов, ждём… (${attempt}/${maxAttempts})`;
                progress({ phase: 'generate', stage: 'blueprint', detail });
            },
        });
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: 'Темы извлечены' });

        // Store in cache for future runs with same document+settings
        if (blueprintCache.isEnabled() && docHash) {
            await blueprintCache.setBlueprint(docHash, routingMode, count, detectedLang, blueprint, traceId);
        }
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

    return { blueprint, cacheHit: false };
}

// Минимальный порог качества evidence для передачи intent на LLM.
// Снижен с 0.3 до 0.15: прежнее значение в связке с SUMMARY_MODE=extractive
// отбрасывало большинство интентов до LLM — главная причина малого числа вопросов.
const EVIDENCE_QUALITY_THRESHOLD = 0.15;

// ─── main batch loop ─────────────────────────────────────────────────────────

/**
 * Process a single LLM batch (retrieval → generation → grounding).
 * Returns structured result so parallel batches can be merged in order.
 */
async function processSingleBatch({
    batch, batchNum, totalBatches, indexedChunks, topK, embedModel, bypassLimits,
    modelGenerate, modelGround, detectedLang, enableGrounding, pipelineContext,
    coverageMap, routeOpts, traceId, documentId,
}) {
    const retrievalResults = await Promise.all(batch.map(async (intent) => {
        const relevantChunks = await rag.hybridRetrieve(
            `${intent.theme}: ${intent.intent}`, indexedChunks, topK,
            { embedModel: embedModel || null, bypassLimits },
        );
        const packets      = rag.buildEvidencePackets(relevantChunks, intent.intent);
        const evidenceText = rag.formatEvidenceForPrompt(packets);
        const ids          = relevantChunks.map(c => c.id);
        const quality      = scoreEvidenceQuality(evidenceText, intent.intent);
        return { intent, evidenceText, ids, quality };
    }));

    const filteredBatch  = [];
    const evidenceList   = [];
    const chunkIdsList   = [];
    const evidenceScores = [];
    let statsSkippedEvidence = 0;
    let statsRetrievalPassed = 0;

    for (const r of retrievalResults) {
        evidenceScores.push(r.quality.score);
        if (r.quality.score < EVIDENCE_QUALITY_THRESHOLD) {
            console.log(`[PIPELINE] Batch ${batchNum}: Soft-skip intent "${r.intent.intent.slice(0, 60)}…" — ${r.quality.reason}`);
            statsSkippedEvidence++;
            logStructured({
                level: 'warn', traceId, documentId, phase: 'generate',
                event: 'intent_skipped_weak_evidence',
                reasonCode: evidenceReasonToCode(r.quality.reason),
                defectClass: DEFECT_CLASSES.RETRIEVAL_MISS,
                metrics: { evidence_score: r.quality.score },
                metadata: { intent_preview: r.intent.intent.slice(0, 120), reason: r.quality.reason },
            });
            continue;
        }
        statsRetrievalPassed++;
        filteredBatch.push(r.intent);
        evidenceList.push(r.evidenceText);
        chunkIdsList.push(r.ids);
        // Coverage map is shared; update is safe (Set operations are sync)
        rag.updateCoverageMap(coverageMap, r.ids);
    }

    if (filteredBatch.length === 0) {
        console.warn(`[PIPELINE] Batch ${batchNum}: все intents пропущены (weak evidence)`);
        return {
            questions: [], evidenceScores,
            statsValidated: 0, statsSkippedLLM: 0, statsValidationFailed: 0,
            statsGroundingFailed: 0, statsSkippedEvidence, statsRetrievalPassed,
        };
    }

    const { results: batchResults, stats: batchStats } = await generateBatchQuestions(
        filteredBatch, evidenceList, chunkIdsList, null, modelGenerate, detectedLang, routeOpts,
    );

    let groundedMask = new Array(batchResults.length).fill(true);
    if (enableGrounding && pipelineContext.executionMode === 'normal') {
        const bQuestions = batchResults.map(r => r.question);
        const bEvidences = batchResults.map(r => evidenceList[r.intentIdx]);
        groundedMask = await checkGroundingBatched(bQuestions, bEvidences, modelGround, routeOpts);
    }

    let statsGroundingFailed = 0;
    const questions = [];
    for (let i = 0; i < batchResults.length; i++) {
        const { question, intentIdx } = batchResults[i];
        if (!groundedMask[i]) {
            statsGroundingFailed++;
            console.warn(`[PIPELINE] Batch ${batchNum}, intent[${intentIdx + 1}]: не прошёл groundedness`);
            continue;
        }
        // Tag with batchNum for deterministic ordering after parallel merge
        questions.push({ ...question, _batchNum: batchNum });
    }

    return {
        questions, evidenceScores,
        statsValidated: batchResults.length,
        statsSkippedLLM: batchStats.llmSkipped,
        statsValidationFailed: batchStats.validationFailed,
        statsGroundingFailed, statsSkippedEvidence, statsRetrievalPassed,
    };
}

async function runMainBatchLoop({
    blueprintWithDifficulty, indexedChunks, coverageMap, modelGenerate, modelGround, embedModel,
    detectedLang,
    enableGrounding, pipelineContext, batchSize, topK, traceId, documentId, progress,
    totalBatches, bypassLimits = false,
}) {
    const routeOpts    = bypassLimits ? { bypassLimits: true } : null;
    const parallelism  = Math.max(1, config.LLM_BATCH_PARALLELISM || 1);
    const allQuestions = [];
    const evidenceScores = [];
    let statsValidated        = 0;
    let statsSkippedEvidence  = 0;
    let statsSkippedLLM       = 0;
    let statsValidationFailed = 0;
    let statsGroundingFailed  = 0;
    let statsRetrievalPassed  = 0;

    // Split all intents into LLM-batch slices first
    const batchSlices = [];
    for (let s = 0; s < blueprintWithDifficulty.length; s += batchSize) {
        batchSlices.push({
            batch:    blueprintWithDifficulty.slice(s, s + batchSize),
            batchNum: Math.floor(s / batchSize) + 1,
        });
    }

    // Process slices in windows of `parallelism`
    for (let w = 0; w < batchSlices.length; w += parallelism) {
        const window = batchSlices.slice(w, w + parallelism);

        if (window.length > 1) {
            console.log(`[PIPELINE] Parallel window: batches ${window.map(b => b.batchNum).join(',')} of ${totalBatches}`);
        } else {
            console.log(`[PIPELINE] Batch ${window[0].batchNum}/${totalBatches}: ${window[0].batch.length} intents`);
        }

        // Run the window in parallel; each batch retries independently on transient error
        const windowResults = await Promise.all(
            window.map(({ batch, batchNum }) =>
                processSingleBatch({
                    batch, batchNum, totalBatches, indexedChunks, topK, embedModel, bypassLimits,
                    modelGenerate, modelGround, detectedLang, enableGrounding, pipelineContext,
                    coverageMap, routeOpts, traceId, documentId,
                }).catch((err) => {
                    // Per-batch retry: log and return empty result so other batches proceed
                    console.error(`[PIPELINE] Batch ${batchNum} failed (will be skipped): ${err.message}`);
                    logStructured({
                        level: 'error', traceId, documentId, phase: 'generate',
                        event: 'batch_failed', metrics: { batch_num: batchNum },
                        metadata: { error: err.message },
                    });
                    return { questions: [], evidenceScores: [], statsValidated: 0,
                        statsSkippedLLM: 0, statsValidationFailed: 0,
                        statsGroundingFailed: 0, statsSkippedEvidence: 0, statsRetrievalPassed: 0 };
                })
            )
        );

        // Merge results in batchNum order (deterministic)
        const sortedResults = windowResults.sort((a, b) => {
            const an = a.questions[0]?._batchNum ?? 0;
            const bn = b.questions[0]?._batchNum ?? 0;
            return an - bn;
        });

        for (const r of sortedResults) {
            for (const q of r.questions) {
                const { _batchNum: _, ...cleanQ } = q;
                allQuestions.push(cleanQ);
            }
            evidenceScores.push(...r.evidenceScores);
            statsValidated        += r.statsValidated;
            statsSkippedEvidence  += r.statsSkippedEvidence;
            statsSkippedLLM       += r.statsSkippedLLM;
            statsValidationFailed += r.statsValidationFailed;
            statsGroundingFailed  += r.statsGroundingFailed;
            statsRetrievalPassed  += r.statsRetrievalPassed;
        }

        const completedBatch = Math.min(w + parallelism, batchSlices.length);
        progress({
            phase: 'generate', stage: 'llm_batch', workDelta: PW.GEN_BATCH * window.length,
            detail: `Пакеты ${w + 1}–${completedBatch}/${totalBatches} (накоплено ${allQuestions.length})`,
        });
    }

    return {
        allQuestions, evidenceScores,
        statsValidated, statsSkippedEvidence, statsSkippedLLM,
        statsValidationFailed, statsGroundingFailed, statsRetrievalPassed,
    };
}

// ─── backfill loop ───────────────────────────────────────────────────────────

async function runBackfillLoop({
    initialDedup, indexedChunks, coverageMap, modelGenerate, modelGround, embedModel,
    detectedLang,
    enableGrounding, pipelineContext, batchSize, targetMin,
    maxBackfillRounds, traceId, documentId, progress, bypassLimits = false,
}) {
    const routeOpts = bypassLimits ? { bypassLimits: true } : null;
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

            // Backfill: retrieval по одному чанку, без embedding API — синхронно достаточно.
            for (const intent of batchIntents) {
                const chunkRef     = intent._chunkRef;
                const packets      = rag.buildEvidencePackets([chunkRef], intent.intent);
                const evidenceText = rag.formatEvidenceForPrompt(packets);
                const quality      = scoreEvidenceQuality(evidenceText, intent.intent);
                if (quality.score < EVIDENCE_QUALITY_THRESHOLD) { statsSkippedEvidence++; continue; }
                bfFiltered.push(intent);
                bfEvidenceList.push(evidenceText);
                bfChunkIdsList.push([chunkRef.id]);
                rag.updateCoverageMap(coverageMap, [chunkRef.id]);
            }

            if (bfFiltered.length === 0) continue;

            const { results: batchResults, stats: bfStats } = await generateBatchQuestions(
                bfFiltered, bfEvidenceList, bfChunkIdsList, null, modelGenerate, detectedLang, routeOpts,
            );
            statsSkippedLLM       += bfStats.llmSkipped;
            statsValidationFailed += bfStats.validationFailed;

            let bfMask = new Array(batchResults.length).fill(true);
            if (enableGrounding && pipelineContext.executionMode === 'normal') {
                const bQuestions = batchResults.map(r => r.question);
                const bEvidences = batchResults.map(r => bfEvidenceList[r.intentIdx]);
                bfMask = await checkGroundingBatched(bQuestions, bEvidences, modelGround, routeOpts);
            }

            for (let i = 0; i < batchResults.length; i++) {
                if (!bfMask[i]) { statsGroundingFailed++; continue; }
                newRawQuestions.push(batchResults[i].question);
                backfillGroundedAccepted++;
            }

            progress({ phase: 'generate', stage: 'backfill_batch', workDelta: PW.GEN_BATCH,
                detail: `Добор: раунд ${round}, пакет ${bNum}/${totalBF}` });
            // sleep(1200) удалён — RPM управляется quotaGuard.
        }

        if (newRawQuestions.length === 0) { console.warn(`[PIPELINE] Backfill round ${round}: нет новых вопросов`); break; }

        const embedBatch = (texts) => rag.getBatchEmbeddings(texts, 3, embedModel || null, bypassLimits ? { bypassLimits: true } : null);
        const dedupedNew = newRawQuestions.length > 1
            ? await semanticDedup(newRawQuestions, embedBatch, config.DEDUP_THRESHOLD || 0.85)
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
    const traceId    = opts.traceId    || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const documentId = opts.documentId != null ? opts.documentId : null;
    const progress   = p => { if (typeof onProgress === 'function') onProgress(p); };

    // ── 1. Language (локальная эвристика или DEFAULT_DOCUMENT_LANGUAGE=ru) ──
    const { lang: detectedLang, diagnostics: langDiagnostics } = resolveDocumentLanguage(fullText, {
        defaultLang: config.DEFAULT_DOCUMENT_LANGUAGE || '',
    });
    const langLabel = langDiagnostics.resolved_by === 'config_default'
        ? `${detectedLang} (задан в конфиге)`
        : `${detectedLang} (${langDiagnostics.resolved_by})`;
    console.log(`[PIPELINE] Язык: ${langLabel}`);
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

    const routingMode = opts.routingMode || 'auto';
    const bypassLimits = shouldBypassAppLimits(routingMode);
    let routingModeEffective = routingMode;
    try {
        routingModeEffective = await modelRouter.resolveEffectiveMode(routingMode);
    } catch (e) {
        console.warn(`[PIPELINE] resolveEffectiveMode: ${e.message}`);
    }

    const documentMetadata = {
        ...opts.documentMetadata,
        page_count: opts.documentMetadata?.page_count ?? opts.pageCount,
        low_text_quality: opts.documentMetadata?.low_text_quality ?? opts.lowTextQuality,
        extraction_quality: opts.documentMetadata?.extraction_quality ?? opts.extractionQuality,
    };
    const complexityNorm = derivePipelineComplexity(opts, indexedChunks, documentMetadata);
    const quotaSnapshot = await quotaGuard.getUsageSnapshot();
    const adminOverrides = routingMode === 'manual' && opts.model
        ? { model: opts.model }
        : {};

    const customModeResolved = await resolveCustomModeAgentModels({
        routingMode,
        traceId,
        documentId,
    });
    let agentDecisions;
    let modelsByAgent;
    if (customModeResolved) {
        agentDecisions = customModeResolved.decisions;
        modelsByAgent = customModeResolved.modelsByAgent;
    } else {
        const resolved = await resolvePipelineAgentModels({
            routingMode,
            documentMetadata,
            complexityNorm,
            quotaSnapshot,
            adminOverrides,
            traceId,
            documentId,
        });
        agentDecisions = resolved.decisions;
        modelsByAgent = resolved.modelsByAgent;
    }

    const modelGenerator = modelsByAgent[AGENT_ROLES.generator] || config.LLM_MODEL || 'gemini-2.5-flash';
    const modelBlueprint = modelsByAgent[AGENT_ROLES.blueprint] || modelGenerator;
    const modelQuality = modelsByAgent[AGENT_ROLES.quality] || modelGenerator;
    const modelBackfill = modelsByAgent[AGENT_ROLES.backfill] || modelGenerator;
    const embedModel = modelsByAgent[AGENT_ROLES.evidence] || config.EMBEDDING_MODEL || 'gemini-embedding-001';

    /** Основная LLM для run row / обратная совместимость логов */
    const model = modelGenerator;

    // ── 3. Budget ────────────────────────────────────────────────────────────
    const budgetPlan = calculateQuestionBudget(fullText, indexedChunks, {
        extractionQuality: opts.extractionQuality,
        questionTypes: ['multiple_choice'],
    });
    const targetCount = budgetPlan.targetCount;
    
    // Don't artificially inflate targetMin to 20 if budget is lower!
    const targetMin   = Math.min(targetCount, config.TARGET_QUESTIONS_MIN || 20);
    const targetMax   = config.TARGET_QUESTIONS_MAX || 30;
    const count       = targetCount; // Base blueprint count exactly on the calculated budget

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

    const estimatedBudget = estimateQuotaBudget({
        chunkCount: nChunks,
        summaryMode: config.SUMMARY_MODE,
        enableGrounding: config.ENABLE_GROUNDING,
        targetCount: count,
    });
    console.log(`[PIPELINE] Оценка бюджета API: ~${estimatedBudget.llmCalls} LLM, ~${estimatedBudget.embedCalls} Embed`);

    const skipLocalPreflight = isMaxQualityMode(routingMode);
    const executionModeRes = skipLocalPreflight
        ? { mode: 'normal', reason: 'max_quality_skips_local_preflight' }
        : await resolveExecutionMode(modelGenerator, embedModel, estimatedBudget);
    if (executionModeRes.mode === 'quota_exhausted') {
        console.warn(`[PIPELINE] ${executionModeRes.reason}`);
        if (!opts.forceOffline) {
            const err = new Error(executionModeRes.reason || 'Дневной лимит квоты исчерпан.');
            err.requiresOfflineConsent = true;
            err.status = 402;
            throw err;
        }
    }

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
    if (hasIndexerIssues && !bypassLimits) {
        pipelineContext.executionMode = 'degraded';
        pipelineContext.degradedReasons.push('indexer_fallback');
        pipelineContext.degradedStages.push('indexer');
    }

    // ── 5. Create generation_run ─────────────────────────────────────────────
    let runId = null;
    try {
        const customProfile = customModeResolved?.profile || null;
        const runRow = await runRepo.insertRun({
            document_id: documentId, status: 'running', model,
            target_min: targetMin, target_max: targetMax, target_count: targetCount,
            language: detectedLang, budget_metrics: budgetPlan.metrics,
            requested_mode_code: routingMode || null,
            mode_profile_id: customProfile?.id || null,
            mode_profile_version: customProfile?.config_version || null,
        });
        runId = runRow.id;
    } catch (e) {
        console.warn(`[PIPELINE] Could not create generation_run: ${e.message}`);
    }

    // Связываем решения роутинга с этим run_id: routing engine записывает их по traceId
    // до создания run (run ещё не существует в момент вызова resolvePipelineModelsV2).
    if (runId && traceId) {
        try {
            await pgPool.query(
                `UPDATE ai_routing_decisions
                    SET run_id = $1
                  WHERE trace_id = $2
                    AND run_id IS NULL`,
                [runId, traceId],
            );
        } catch (e) {
            console.warn(`[PIPELINE] Could not link routing decisions to run: ${e.message}`);
        }
    }

    // Эмитируем pipeline events для агентов (пропускаем evaluation_agent — он всегда null).
    for (const agentRole of AGENT_RESOLUTION_ORDER) {
        if (agentRole === AGENT_ROLES.evaluation) continue; // always null, not needed
        const dec = agentDecisions[agentRole];
        if (dec && dec.selectedModel) await modelRouter.emitRouterDecisionToPipeline(runId, documentId, traceId, dec);
    }

    logStructured({
        level: 'info', traceId, documentId, phase: 'generate', event: 'generation_start',
        metrics: {
            model: modelGenerator,
            model_blueprint: modelBlueprint,
            model_quality: modelQuality,
            model_backfill: modelBackfill,
            embedding_model: embedModel,
            run_id: runId,
        },
    });
    console.log(`[PIPELINE] Цель: ${targetMin}–${targetMax} | чанков: ${indexedChunks.length} | `
        + `gen=${modelGenerator} blueprint=${modelBlueprint} ground=${modelQuality} embed=${embedModel}`);

    // ── 6. Offline branch ────────────────────────────────────────────────────
    const llmRpdExhausted = !skipLocalPreflight && await quotaGuard.isRpdExhaustedForModel(model);
    if (llmRpdExhausted) {
        if (!opts.forceOffline) {
            const limits = quotaGuard.getLimitsForModel(model);
            const err = new Error(
                `Дневной лимит запросов к модели ${model} исчерпан`
                + (limits ? ` (${limits.rpd} запросов/сутки, UTC).` : '.')
                + ' Дождитесь сброса квоты, смените модель в настройках или явно согласитесь на упрощённую сборку без LLM.',
            );
            err.requiresOfflineConsent = true;
            err.status = 402;
            throw err;
        }
        console.warn('[PIPELINE] Дневной лимит исчерпан — offline mode (forceOffline)');
        const result = await runOfflinePipeline({
            fullText, indexedChunks, model: modelGenerator, modelBlueprint, modelsByAgent,
            targetCount, targetMin, targetMax,
            detectedLang, startTime, runId, traceId, documentId, opts, progress,
            routingModeRequested: routingMode,
            routingModeEffective,
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
    const blueprintResult = await buildBlueprint({
        indexedChunks, fullText, model: modelBlueprint, count, pipelineContext, progress, traceId, documentId,
        bypassLimits, detectedLang, routingMode,
    });
    const blueprint = blueprintResult.blueprint;
    const blueprintCacheHit = blueprintResult.cacheHit;

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
        blueprintWithDifficulty, indexedChunks, coverageMap,
        modelGenerate: modelGenerator, modelGround: modelQuality, embedModel,
        detectedLang,
        enableGrounding, pipelineContext, batchSize, topK, traceId, documentId, progress, totalBatches,
        bypassLimits,
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
    const embedQuotaOpts = bypassLimits ? { bypassLimits: true } : null;
    const embedBatchMain = (texts) => rag.getBatchEmbeddings(texts, 3, embedModel || null, embedQuotaOpts);
    const initialDedup = await semanticDedup(allQuestions, embedBatchMain, config.DEDUP_THRESHOLD || 0.88);
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
        initialDedup, indexedChunks, coverageMap,
        modelGenerate: modelBackfill, modelGround: modelQuality, embedModel,
        detectedLang,
        enableGrounding, pipelineContext, batchSize, targetMin,
        maxBackfillRounds: config.BACKFILL_MAX_ROUNDS || 3,
        traceId, documentId, progress, bypassLimits,
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

    const modelsByAgentFlat = {};
    for (const role of AGENT_RESOLUTION_ORDER) {
        modelsByAgentFlat[role] = modelsByAgent[role] ?? null;
    }

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
        modelsByAgent: modelsByAgentFlat,
        routing_mode_requested: routingMode,
        routing_mode_effective: routingModeEffective,
        pipeline_execution_mode: pipelineContext.executionMode,
    });

    // Augment with optimisation metadata for benchmark/observability
    generationMetrics.cache_hits = blueprintCacheHit ? 1 : 0;
    generationMetrics.parallel_batches = config.LLM_BATCH_PARALLELISM || 1;
    generationMetrics.grounding_enabled = enableGrounding;
    generationMetrics.total_duration_ms = durationMs;

    // ── 13. Persist results ──────────────────────────────────────────────────
    if (runId) {
        try {
            await runRepo.insertQuestionsBulk(runId, finalQuestions);
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
            total_duration_ms: durationMs,
            duration_ms: durationMs,
            routing_mode: routingMode,
            question_count: finalQuestions.length,
            cache_hits: generationMetrics.cache_hits,
            parallel_batches: generationMetrics.parallel_batches,
            grounding_enabled: generationMetrics.grounding_enabled,
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
