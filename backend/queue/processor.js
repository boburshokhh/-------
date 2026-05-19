'use strict';

/**
 * queue/processor.js
 *
 * BullMQ job processor — executes the AI test generation pipeline
 * for a single job. Called by the Worker (backend/worker.js).
 *
 * Job payload fields (set by routes/upload.js):
 *   jobId           - string, also the BullMQ job id
 *   documentId      - number, already inserted into DB by upload handler
 *   text            - string, parsed document text
 *   displayName     - string, human-readable filename
 *   routingMode     - string (e.g. 'balanced')
 *   model           - string, LLM model id
 *   pageCount       - number|null
 *   lowTextQuality  - boolean
 *   extractionQuality - number|null
 *   complexityScore - number|undefined
 *
 * The upload handler already handles: parse, insertDocument.
 * The worker handles: indexDocument → generateTest → insertTest.
 */

const testRepo = require('../db/repositories/testRepo');
const { generateTest } = require('../services/generator');
const { countTokens } = require('../services/chunker');
const { indexDocument } = require('../services/indexer');
const jobProgress = require('../services/jobProgress');
const { shouldBypassAppLimits } = require('../config/routingModes');
const { logStructured } = require('../utils/observability');
const config = require('../config');

/**
 * Writes a progress update and best-effort persists.
 */
function makeReporter(jobId) {
    return function report(payload) {
        jobProgress.logJobProgress(jobId, payload);
        jobProgress.flushPersist(jobId).catch((e) =>
            console.warn(`[Processor] flushPersist failed: ${e.message}`)
        );
    };
}

/**
 * Main job processor.
 * @param {import('bullmq').Job} job
 */
async function processGenerationJob(job) {
    const {
        jobId, documentId, text, displayName, routingMode, model,
        pageCount, lowTextQuality, extractionQuality,
        complexityScore,
    } = job.data;

    const report = makeReporter(jobId);
    const W = jobProgress.WEIGHT;

    console.log(`[Processor] Job ${jobId}: doc=${documentId} mode=${routingMode} model=${model}`);

    try {
        report({
            phase: 'index', stage: 'indexing',
            workDelta: W.DB_SAVED,
            detail: `Индексация документа #${documentId}…`,
        });

        const stageStart = Date.now();

        const indexedChunks = await indexDocument(documentId, text, report, {
            baseWorkDone: W.PARSE_READ + W.PARSE_PARSED + W.DB_SAVING + W.DB_SAVED,
            routingMode,
            bypassLimits: shouldBypassAppLimits(routingMode),
        });

        logStructured({
            level: 'info', traceId: jobId, documentId: Number(documentId),
            phase: 'index', event: 'indexing_complete',
            metrics: {
                chunk_count: indexedChunks.length,
                text_length: text.length,
                token_count: countTokens(text),
                index_duration_ms: Date.now() - stageStart,
            },
        });

        const testData = await generateTest(text, displayName, indexedChunks, report, {
            model,
            routingMode,
            pageCount,
            lowTextQuality: !!lowTextQuality,
            documentMetadata: {
                page_count: pageCount,
                low_text_quality: !!lowTextQuality,
                extraction_quality: extractionQuality ?? null,
            },
            complexityScore: Number.isFinite(Number(complexityScore)) ? Number(complexityScore) : undefined,
            extractionQuality: extractionQuality ?? null,
            traceId: jobId,
            documentId: Number(documentId),
        });

        const testRow = await testRepo.insertTest({
            document_id: documentId,
            title: testData.title,
            questions: testData.questions,
            total_questions: testData.questions.length,
            generation_metrics: testData.generationMetrics || null,
            generation_run_id: testData.runId || null,
        });

        report({
            phase: 'done', stage: 'completed',
            detail: `Сохранён тест: ${testData.questions.length} вопросов`,
        });

        // Persist final result so polling clients see it.
        jobProgress.logJobProgress(jobId, {
            phase: 'done',
            stage: 'completed',
            detail: `Сохранён тест: ${testData.questions.length} вопросов`,
            testId: testRow.id,
            documentId: Number(documentId),
            totalQuestions: testData.questions.length,
            title: testData.title,
            generationMetrics: testData.generationMetrics ?? null,
        });
        await jobProgress.flushPersist(jobId).catch(() => {});

        logStructured({
            level: 'info', traceId: jobId, documentId: Number(documentId),
            testId: testRow.id, phase: 'worker', event: 'job_completed',
            metrics: { total_questions: testData.questions.length },
        });

        return {
            jobId,
            testId: testRow.id,
            documentId: Number(documentId),
            totalQuestions: testData.questions.length,
            title: testData.title,
        };
    } catch (error) {
        const errMsg = error && error.message ? String(error.message).slice(0, 500) : 'Ошибка обработки';
        jobProgress.logJobProgress(jobId, {
            phase: 'error', stage: 'failed',
            detail: errMsg,
            errorClass: error && error.constructor ? error.constructor.name : 'Error',
        });
        await jobProgress.flushPersist(jobId).catch(() => {});
        logStructured({
            level: 'error', traceId: jobId, documentId: Number(documentId || 0),
            phase: 'worker', event: 'job_failed',
            metadata: { error_message: errMsg },
        });
        throw error;
    }
}

module.exports = { processGenerationJob };
