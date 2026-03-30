const config = require('../config');
const { countMergedFactBullets } = require('./rag/evidenceBuilder');

const CONFIG = {
    HARD_MIN: 5,
    HARD_MAX: 50,
    TOKENS_PER_QUESTION: 350,
    FACTS_PER_QUESTION: 1.5,
    MAX_SAFE_Q_PER_CHUNK: 3,
    OVERLAP_TOKENS_PER_CHUNK: config.CHUNK_OVERLAP_TOKENS || 200,
    /**
     * Технический документ: минимальный бюджет если документ нормально распарсен
     * (chunkCount >= TECH_MIN_CHUNKS и quality >= TECH_MIN_QUALITY).
     * Гарантирует, что одиночный слабый сигнал не убьёт генерацию.
     */
    TECH_DOC_FLOOR: 8,
    TECH_MIN_CHUNKS: 5,
    TECH_MIN_QUALITY: 0.5,
    /** Макс. доля перекрытия, которую разрешаем «вычесть» — предотвращает обнуление uniqueConcepts */
    OVERLAP_RATIO_CAP: 0.75,
};

/**
 * Adaptive Question Budget Strategy — Multi-Factor Scoring
 *
 * Принципы:
 *  - НЕ берём min() трёх ёмкостей как единственное горлышко.
 *  - Строим взвешенный blend (tokens 40%, chunks 30%, facts 30%).
 *  - overlapRatio ограничен сверху (OVERLAP_RATIO_CAP) — раньше > 1.0 обнулял uniqueConcepts.
 *  - Вводим tech_doc_floor для нормально распарсенных технических документов.
 *  - Структурные сигналы (заголовки, процедурный контент, разделы) дают бонус.
 *  - Каждый фактор подробно логируется.
 *
 * @param {string} fullText
 * @param {Array}  indexedChunks
 * @param {Object} options - { extractionQuality, questionTypes: ['multiple_choice'] }
 * @returns {{ targetCount: number, metrics: object, logs: string[], reductionReasons: string[] }}
 */
function calculateQuestionBudget(fullText, indexedChunks, options = {}) {
    const { extractionQuality = 1.0, questionTypes = ['multiple_choice'] } = options;
    const logs = [];
    const reductionReasons = [];

    // ── 1. Сбор сырой статистики ──────────────────────────────────────────────
    const chunkCount = indexedChunks?.length || 0;
    let totalTokens = 0;
    let summaryFacts = 0;

    // Структурные сигналы для технического контента
    let headingChunks = 0;
    const uniqueSections = new Set();
    let proceduralSignals = 0;

    const PROCEDURAL_PATTERNS = [
        /шаг\s*\d+/i, /step\s*\d+/i, /процедура/i, /procedure/i,
        /установка/i, /install/i, /настройка/i, /configure/i,
        /алгоритм/i, /algorithm/i, /^\s*\d+\.\s/m, /^\s*[-•]\s/m,
    ];

    if (chunkCount > 0) {
        indexedChunks.forEach(c => {
            totalTokens += (c.token_count || 0);
            summaryFacts += countMergedFactBullets(c, 99);

            if (c.heading || c.section) {
                headingChunks++;
                const sectionKey = (c.section || c.heading || '').trim().toLowerCase();
                if (sectionKey) uniqueSections.add(sectionKey);
            }

            const text = typeof c.text === 'string' ? c.text.slice(0, 600) : '';
            if (PROCEDURAL_PATTERNS.some(re => re.test(text))) proceduralSignals++;
        });
    } else {
        totalTokens = Math.floor((fullText?.length || 0) / 4);
    }

    // ── 2. Оценка atomicFacts ─────────────────────────────────────────────────
    let atomicFacts;
    let factsSource;
    if (summaryFacts > 0) {
        atomicFacts = summaryFacts;
        factsSource = 'merged_facts';
    } else if (chunkCount > 0) {
        // Нет извлечённых опорных фактов — оцениваем по токенам.
        // ~1 тестируемый факт на 150 токенов (реальная плотность технических текстов).
        // Гарантируем минимум chunkCount*2 (хотя бы 2 факта на чанк).
        atomicFacts = Math.max(chunkCount * 2, Math.floor(totalTokens / 150));
        factsSource = 'token_estimate';
        logs.push(`[facts] No fact bullets — estimate: ${totalTokens} tokens / 150 = ${Math.floor(totalTokens / 150)}, min=chunks*2=${chunkCount * 2} → atomicFacts=${atomicFacts}`);
    } else {
        atomicFacts = Math.max(1, Math.floor((fullText?.length || 0) / 400));
        factsSource = 'text_length';
    }

    // ── 3. Overlap и uniqueConcepts ───────────────────────────────────────────
    const overlapTokens = Math.max(0, (chunkCount - 1) * CONFIG.OVERLAP_TOKENS_PER_CHUNK);
    const effectiveTokens = Math.max(100, totalTokens - overlapTokens);

    // КРИТИЧЕСКИЙ FIX:
    // При малом totalTokens (напр. 2639) и большом chunkCount (19),
    // overlapTokens = 18 * 200 = 3600 > totalTokens → ratio = 1.36+
    // Это делало uniqueConcepts ≤ 0 и обрушивало budget до 1.
    const rawOverlapRatio = totalTokens > 0 ? overlapTokens / totalTokens : 0;
    const overlapRatio = Math.min(rawOverlapRatio, CONFIG.OVERLAP_RATIO_CAP);

    if (rawOverlapRatio > CONFIG.OVERLAP_RATIO_CAP) {
        logs.push(`[overlap] CAPPED: rawRatio=${rawOverlapRatio.toFixed(2)} → ${CONFIG.OVERLAP_RATIO_CAP} (prevents uniqueConcepts collapse)`);
    }

    // Гарантируем минимум 30% фактов всегда уникальны
    const uniqueConcepts = Math.max(
        Math.ceil(atomicFacts * 0.30),
        Math.floor(atomicFacts * (1 - overlapRatio * 0.5))
    );

    logs.push(`[concepts] atomicFacts=${atomicFacts} overlapRatio=${overlapRatio.toFixed(2)} uniqueConcepts=${uniqueConcepts}`);

    // ── 4. Три независимые ёмкости ────────────────────────────────────────────
    const capacityByTokens = Math.max(1, Math.floor(effectiveTokens / CONFIG.TOKENS_PER_QUESTION));
    const capacityByFacts  = Math.max(1, Math.floor(uniqueConcepts / CONFIG.FACTS_PER_QUESTION));
    const capacityByChunks = chunkCount > 0
        ? chunkCount * CONFIG.MAX_SAFE_Q_PER_CHUNK
        : capacityByTokens;

    logs.push(`[capacity] tokens=${capacityByTokens} facts=${capacityByFacts} chunks=${capacityByChunks} | effectiveTokens=${effectiveTokens}`);

    // ── 5. Базовый бюджет: взвешенный blend вместо strict-min ────────────────
    // Старый min() убивал budget если ЛЮБАЯ из трёх ёмкостей падала в 0.
    // Теперь: взвешенное среднее (tokens 40%, chunks 30%, facts 30%).
    const blendedBase = Math.round(
        capacityByTokens * 0.40 +
        capacityByChunks * 0.30 +
        capacityByFacts  * 0.30
    );
    // Soft cap: не превышаем наибольшую из "оффлайн" ёмкостей (без facts, т.к. они оцениваются)
    const softCap = Math.max(capacityByTokens, capacityByChunks);
    let rawBudget = Math.min(blendedBase, softCap);

    logs.push(`[base] blend(T*0.4 + C*0.3 + F*0.3)=${blendedBase} softCap=${softCap} → rawBudget=${rawBudget} (facts_source=${factsSource})`);

    // ── 6. Структурный бонус ──────────────────────────────────────────────────
    const headingDensity  = chunkCount > 0 ? headingChunks / chunkCount : 0;
    const sectionCount    = uniqueSections.size;
    const proceduralRatio = chunkCount > 0 ? proceduralSignals / chunkCount : 0;

    let structuralBonus = 0;
    const bonusLog = [];

    if (headingDensity >= 0.4) {
        structuralBonus += 0.10;
        bonusLog.push(`headings(+10%, density=${headingDensity.toFixed(2)})`);
    }
    if (sectionCount >= 3) {
        structuralBonus += 0.10;
        bonusLog.push(`sections(+10%, count=${sectionCount})`);
    }
    if (proceduralRatio >= 0.2) {
        structuralBonus += 0.10;
        bonusLog.push(`procedural(+10%, ratio=${proceduralRatio.toFixed(2)})`);
    }

    if (structuralBonus > 0) {
        rawBudget = Math.round(rawBudget * (1 + structuralBonus));
        logs.push(`[structural] bonus +${Math.round(structuralBonus * 100)}%: ${bonusLog.join(', ')} → rawBudget=${rawBudget}`);
    } else {
        logs.push(`[structural] no bonus (headingDensity=${headingDensity.toFixed(2)}, sections=${sectionCount}, proceduralRatio=${proceduralRatio.toFixed(2)})`);
    }

    // ── 7. Коэффициент качества парсинга ─────────────────────────────────────
    const qualityCoeff = Math.max(0.4, extractionQuality);
    if (qualityCoeff < 0.8) {
        reductionReasons.push(`Низкое качество текста (${Math.round(qualityCoeff * 100)}%). Риск галлюцинаций.`);
    }
    logs.push(`[quality] extractionQuality=${extractionQuality.toFixed(2)} → qualityCoeff=${qualityCoeff.toFixed(2)}`);

    // ── 8. Коэффициент тестируемости (плотность фактов) ──────────────────────
    const factDensity = effectiveTokens > 0 ? (uniqueConcepts / (effectiveTokens / 1000)) : 0;
    let testabilityCoeff = 1.0;
    let testabilityReason = 'normal';

    if (factDensity < 5) {
        // При наличии достаточного числа чанков — не режем так агрессивно
        testabilityCoeff = chunkCount >= CONFIG.TECH_MIN_CHUNKS ? 0.80 : 0.65;
        testabilityReason = `very_low_density(${factDensity.toFixed(1)}/1k)`;
        reductionReasons.push(`Очень низкая плотность фактов (${factDensity.toFixed(1)}/1k токенов).`);
    } else if (factDensity < 10) {
        testabilityCoeff = 0.90;
        testabilityReason = `low_density(${factDensity.toFixed(1)}/1k)`;
    } else if (factDensity > 30) {
        testabilityCoeff = 1.20;
        testabilityReason = `high_density(${factDensity.toFixed(1)}/1k)`;
        logs.push(`Высокая плотность фактов (${factDensity.toFixed(1)}/1k токенов) — разрешено больше вопросов.`);
    }
    logs.push(`[testability] factDensity=${factDensity.toFixed(1)}/1k uniqueConcepts=${uniqueConcepts} effectiveTokens=${effectiveTokens} → coeff=${testabilityCoeff.toFixed(2)} (${testabilityReason})`);

    // ── 9. Question Type Mix ──────────────────────────────────────────────────
    const isOnlyMCQ = questionTypes.length === 1 && questionTypes[0] === 'multiple_choice';
    const typeMixCoeff = isOnlyMCQ ? 1.0 : 1.2;

    // ── 10. Применение коэффициентов ──────────────────────────────────────────
    let adjustedBudget = Math.round(rawBudget * qualityCoeff * testabilityCoeff * typeMixCoeff);
    logs.push(`[adjusted] ${rawBudget} * Q${qualityCoeff.toFixed(2)} * T${testabilityCoeff.toFixed(2)} * M${typeMixCoeff.toFixed(2)} = ${adjustedBudget}`);

    // ── 11. Technical Document Lower Bound ────────────────────────────────────
    // Если документ нормально распарсен И содержит достаточно чанков,
    // budget НЕ должен падать ниже TECH_DOC_FLOOR.
    // Это страхует от ситуации: summaries=0, overlapRatio>1 → budget=1.
    const isQualifiedTechDoc = (
        chunkCount >= CONFIG.TECH_MIN_CHUNKS &&
        extractionQuality >= CONFIG.TECH_MIN_QUALITY
    );

    let techFloor = 0;
    if (isQualifiedTechDoc) {
        // Масштабируем floor пропорционально размеру документа
        techFloor = Math.max(CONFIG.TECH_DOC_FLOOR, Math.floor(chunkCount / 2));
        logs.push(`[tech_floor] Qualified tech doc (chunks=${chunkCount} >= ${CONFIG.TECH_MIN_CHUNKS}, quality=${extractionQuality.toFixed(2)} >= ${CONFIG.TECH_MIN_QUALITY}) → floor=${techFloor}`);
        if (adjustedBudget < techFloor) {
            logs.push(`[tech_floor] APPLIED: adjustedBudget=${adjustedBudget} raised to floor=${techFloor}`);
        }
    } else {
        logs.push(`[tech_floor] Not applied (chunks=${chunkCount}, quality=${extractionQuality.toFixed(2)})`);
    }

    // ── 12. Hard Limits и финальный бюджет ────────────────────────────────────
    const configuredMin = config.TARGET_QUESTIONS_MIN || 20;
    const configuredMax = config.TARGET_QUESTIONS_MAX || 30;

    const documentHardMin = Math.max(
        techFloor,
        Math.min(CONFIG.HARD_MIN, Math.max(1, uniqueConcepts))
    );

    // adaptiveMin — не заставляем систему делать 20 вопросов из 2-страничного документа
    const adaptiveMin = Math.max(documentHardMin, Math.min(configuredMin, adjustedBudget));
    const finalBudget = Math.max(adaptiveMin, Math.min(configuredMax, CONFIG.HARD_MAX, adjustedBudget));

    logs.push(`[final] techFloor=${techFloor} hardMin=${documentHardMin} adaptiveMin=${adaptiveMin} configuredMax=${configuredMax} → finalBudget=${finalBudget}`);

    if (finalBudget > adjustedBudget) {
        const lift = finalBudget - adjustedBudget;
        logs.push(`[correction] Budget RAISED by ${lift}: ${adjustedBudget} → ${finalBudget} (reason: ${techFloor > adjustedBudget ? 'tech_doc_floor' : 'hard_min'})`);
        if (reductionReasons.length === 0 && techFloor > 0) {
            reductionReasons.push(`tech_doc_floor применён: budget поднят с ${adjustedBudget} до ${finalBudget}.`);
        }
    } else if (finalBudget < adjustedBudget) {
        logs.push(`[correction] Budget CAPPED: ${adjustedBudget} → ${finalBudget} (configuredMax=${configuredMax})`);
    }

    // ── Итоговые метрики ──────────────────────────────────────────────────────
    const metrics = {
        effectiveTokens,
        uniqueConcepts,
        factDensity,
        factsSource,
        headingDensity,
        sectionCount,
        proceduralRatio,
        structuralBonus,
        isQualifiedTechDoc,
        techFloor,
        overlapRatio,
        rawOverlapRatio,
        capacities: { tokens: capacityByTokens, facts: capacityByFacts, chunks: capacityByChunks },
        coeffs: { quality: qualityCoeff, testability: testabilityCoeff, mix: typeMixCoeff },
    };

    return { targetCount: finalBudget, metrics, logs, reductionReasons };
}

module.exports = { calculateQuestionBudget, CONFIG };