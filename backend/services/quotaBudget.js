const config = require('../config');
const quotaGuard = require('./quotaGuard');

/**
 * Оценивает бюджет квоты для pipeline run.
 *
 * @param {object} params
 * @param {number} params.chunkCount    — количество чанков в документе
 * @param {string} params.summaryMode   — режим суммаризации ('extractive' | 'llm' | 'cheap_llm')
 * @param {boolean} params.enableGrounding — включена ли фактологическая проверка
 * @param {number} params.targetCount   — сколько вопросов запланировано (budgetPlan.targetCount)
 * @returns {{ llmCalls: number, embedCalls: number, breakdown: object }}
 */
function estimateQuotaBudget(params) {
    const { chunkCount = 0, summaryMode = 'extractive', enableGrounding = true, targetCount = 10 } = params;

    // ── Indexing: embeddings (1 вызов на чанк) ─────────────────────────────
    const embedIndexCalls = chunkCount;

    // ── Indexing: LLM summaries (только если режим llm/cheap_llm) ──────────
    let llmSummaryCalls = 0;
    if (summaryMode === 'llm' || summaryMode === 'cheap_llm') {
        const batchSize = config.LLM_SUMMARY_BATCH_SIZE || 6;
        llmSummaryCalls = Math.ceil(chunkCount / batchSize);
    }

    // ── Blueprint: темы + интенты (обычно 2–3 вызова) ──────────────────────
    const llmBlueprintCalls = 3;

    // ── Retrieval: 1 embedding на intent ────────────────────────────────────
    const embedRetrieveCalls = targetCount;

    // ── Generation: батчами по LLM_BATCH_SIZE ──────────────────────────────
    const genBatchSize = config.LLM_BATCH_SIZE || 2;
    const llmGenCalls = Math.ceil(targetCount / genBatchSize);

    // ── Grounding: батчами (по размеру генерации) ──────────────────────────
    const llmGroundingCalls = enableGrounding ? Math.ceil(targetCount / genBatchSize) : 0;

    // ── Dedup: embedding-вызовы (batch по 5) ───────────────────────────────
    const embedDedupCalls = Math.ceil(targetCount / 5);

    // ── Backfill padding (1–3 раунда → ~3 LLM + ~5 embed) ─────────────────
    const llmBackfillCalls = 3;
    const embedBackfillCalls = 5;

    const llmCalls   = llmSummaryCalls + llmBlueprintCalls + llmGenCalls + llmGroundingCalls + llmBackfillCalls;
    const embedCalls = embedIndexCalls + embedRetrieveCalls + embedDedupCalls + embedBackfillCalls;

    return {
        llmCalls,
        embedCalls,
        breakdown: {
            llmSummary: llmSummaryCalls,
            llmBlueprint: llmBlueprintCalls,
            llmGeneration: llmGenCalls,
            llmGrounding: llmGroundingCalls,
            llmBackfill: llmBackfillCalls,
            embedIndex: embedIndexCalls,
            embedRetrieve: embedRetrieveCalls,
            embedDedup: embedDedupCalls,
            embedBackfill: embedBackfillCalls,
        },
    };
}

/**
 * Проверяет оставшуюся квоту LLM-модели и решает режим запуска.
 *
 * @param {string} modelId           — основная LLM-модель
 * @param {string} embeddingModelId  — модель эмбеддингов (пока не используется для решения)
 * @param {{ llmCalls: number, embedCalls: number }} estimatedBudget
 * @returns {Promise<{ mode: 'normal'|'quota_exhausted', reason?: string }>}
 */
async function resolveExecutionMode(modelId, embeddingModelId, estimatedBudget) {
    if (!modelId) return { mode: 'normal' };

    const limitInfo = quotaGuard.getLimitsForModel(modelId);
    if (!limitInfo) return { mode: 'normal' };

    // Проверяем, не исчерпан ли уже дневной RPD для основной модели
    const isExhausted = await quotaGuard.isRpdExhaustedForModel(modelId);
    if (isExhausted) {
        return {
            mode: 'quota_exhausted',
            reason: `Дневной лимит RPD (${limitInfo.rpd}) для модели ${modelId} исчерпан`,
        };
    }

    return { mode: 'normal' };
}

module.exports = {
    estimateQuotaBudget,
    resolveExecutionMode,
};
