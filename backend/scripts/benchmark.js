/**
 * scripts/benchmark.js
 *
 * Phase-0 benchmark & quality baseline script.
 *
 * Usage:
 *   node scripts/benchmark.js --pdf path/to/doc.pdf [--mode balanced] [--questions 30] [--runs 1]
 *
 * Outputs:
 *   - JSON result to stdout with total_duration_ms + per-stage breakdown
 *   - Summary table to stderr
 *   - Appends a row to benchmark-results.jsonl for trend tracking
 *
 * Quality baseline metrics captured:
 *   - final_question_count  (must match target)
 *   - grounding_pass_rate   (grounding_accepted / (grounding_accepted + grounding_failed))
 *   - dedup_dropped_count   (pre_dedup - post_dedup)
 *   - backfill_rounds_used
 *   - execution_mode        (normal / degraded / emergency_fallback)
 *   - cache_hits            (0 on cold run)
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { parseDocument } = require('../services/parser');
const { indexDocument } = require('../services/indexer');
const { generateTest } = require('../services/generator');
const jobProgress = require('../services/jobProgress');

// ── CLI arg parsing ───────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { pdf: null, mode: 'balanced', questions: 30, runs: 1 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--pdf' && args[i + 1]) { opts.pdf = args[++i]; }
        else if (args[i] === '--mode' && args[i + 1]) { opts.mode = args[++i]; }
        else if (args[i] === '--questions' && args[i + 1]) { opts.questions = parseInt(args[++i], 10); }
        else if (args[i] === '--runs' && args[i + 1]) { opts.runs = parseInt(args[++i], 10); }
    }
    return opts;
}

async function runBenchmark(opts) {
    const { pdf, mode, questions, runs } = opts;

    if (!pdf || !fs.existsSync(pdf)) {
        console.error('[benchmark] ERROR: --pdf <file> required and file must exist');
        process.exit(1);
    }

    const displayName = path.basename(pdf);
    console.error(`[benchmark] PDF: ${displayName}, mode: ${mode}, questions: ${questions}, runs: ${runs}`);
    console.error(`[benchmark] LLM_BATCH_PARALLELISM=${process.env.LLM_BATCH_PARALLELISM || 1}`);
    console.error(`[benchmark] BLUEPRINT_CACHE_ENABLED=${process.env.BLUEPRINT_CACHE_ENABLED || 'false'}`);
    console.error(`[benchmark] EMBEDDING_CACHE_ENABLED=${process.env.EMBEDDING_CACHE_ENABLED || 'false'}`);
    console.error();

    const results = [];

    for (let run = 1; run <= runs; run++) {
        const jobId = `bench-${uuidv4()}`;
        const stageTimings = {};
        const t0 = Date.now();

        function markStageStart(stage) { stageTimings[stage] = { start: Date.now() }; }
        function markStageEnd(stage) {
            if (stageTimings[stage]) stageTimings[stage].ms = Date.now() - stageTimings[stage].start;
        }

        console.error(`[benchmark] Run ${run}/${runs} — jobId=${jobId}`);

        // 1. Parse
        markStageStart('parse');
        const parseResult = await parseDocument(pdf, 'application/pdf');
        const { text, pageCount, diagnostics } = parseResult;
        markStageEnd('parse');
        console.error(`[benchmark]   parse: ${stageTimings.parse.ms}ms, ${text.length} chars, ${pageCount} pages`);

        // 2. Index (mock documentId = 0 for benchmark)
        markStageStart('index');
        const documentId = 0;
        const progressFn = (p) => jobProgress.logJobProgress(jobId, p);
        const indexedChunks = await indexDocument(documentId, text, progressFn, { routingMode: mode });
        markStageEnd('index');
        console.error(`[benchmark]   index: ${stageTimings.index.ms}ms, ${indexedChunks.length} chunks`);

        // 3. Generate
        markStageStart('generate');
        const testData = await generateTest(text, displayName, indexedChunks, progressFn, {
            routingMode: mode,
            pageCount,
            lowTextQuality: !!diagnostics?.lowTextQuality,
            extractionQuality: diagnostics?.extractionQuality,
            traceId: jobId,
            documentId,
        });
        markStageEnd('generate');
        console.error(`[benchmark]   generate: ${stageTimings.generate.ms}ms, ${testData.questions.length} questions`);

        const totalMs = Date.now() - t0;
        const m = testData.generationMetrics || {};

        const groundingPassRate = (m.grounding_accepted != null && m.grounding_failed != null)
            ? m.grounding_accepted / Math.max(1, m.grounding_accepted + m.grounding_failed)
            : null;

        const record = {
            timestamp: new Date().toISOString(),
            run,
            jobId,
            pdf: displayName,
            routing_mode: mode,
            target_questions: questions,
            total_duration_ms: totalMs,
            stage_parse_ms: stageTimings.parse?.ms ?? null,
            stage_index_ms: stageTimings.index?.ms ?? null,
            stage_generate_ms: stageTimings.generate?.ms ?? null,
            // Quality metrics (baseline)
            final_question_count: testData.questions.length,
            grounding_pass_rate: groundingPassRate != null ? Math.round(groundingPassRate * 1000) / 1000 : null,
            dedup_dropped_count: m.pre_dedup_count != null ? (m.pre_dedup_count - (m.post_dedup_count ?? m.pre_dedup_count)) : null,
            backfill_rounds_used: m.backfill_rounds_used ?? null,
            execution_mode: m.execution_mode ?? 'unknown',
            cache_hits: m.cache_hits ?? 0,
            parallel_batches: m.parallel_batches ?? 1,
            grounding_enabled: m.grounding_enabled ?? false,
            // Env fingerprint
            env: {
                LLM_BATCH_PARALLELISM: process.env.LLM_BATCH_PARALLELISM || '1',
                BLUEPRINT_CACHE_ENABLED: process.env.BLUEPRINT_CACHE_ENABLED || 'false',
                EMBEDDING_CACHE_ENABLED: process.env.EMBEDDING_CACHE_ENABLED || 'false',
                BULK_INSERT_ENABLED: process.env.BULK_INSERT_ENABLED || 'false',
                LLM_MODEL: process.env.LLM_MODEL || 'gemini-2.5-flash',
            },
        };

        results.push(record);

        console.error(
            `[benchmark]   TOTAL: ${(totalMs / 1000).toFixed(2)}s | ` +
            `Q: ${record.final_question_count} | ` +
            `grounding_pass: ${record.grounding_pass_rate ?? 'N/A'} | ` +
            `dedup_dropped: ${record.dedup_dropped_count ?? 'N/A'} | ` +
            `cache_hits: ${record.cache_hits} | ` +
            `parallelism: ${record.parallel_batches}`
        );
    }

    // Append to JSONL results file
    const outFile = path.join(__dirname, '..', '..', 'benchmark-results.jsonl');
    for (const r of results) {
        fs.appendFileSync(outFile, JSON.stringify(r) + '\n', 'utf8');
    }
    console.error(`\n[benchmark] Saved ${results.length} record(s) to ${outFile}`);

    // Print summary
    if (results.length > 1) {
        const totalMsArr = results.map(r => r.total_duration_ms);
        const avg = Math.round(totalMsArr.reduce((a, b) => a + b, 0) / totalMsArr.length);
        const min = Math.min(...totalMsArr);
        const max = Math.max(...totalMsArr);
        console.error(`\n[benchmark] Summary (${results.length} runs):`);
        console.error(`  avg=${(avg / 1000).toFixed(2)}s  min=${(min / 1000).toFixed(2)}s  max=${(max / 1000).toFixed(2)}s`);
    }

    // Print JSON to stdout for CI/scripting
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

parseArgs();
runBenchmark(parseArgs()).catch((err) => {
    console.error('[benchmark] FATAL:', err.message, err.stack);
    process.exit(1);
});
