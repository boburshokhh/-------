const config = require('../config');

const CONFIG = {
    HARD_MIN: 5,
    HARD_MAX: 50,
    TOKENS_PER_QUESTION: 350,
    FACTS_PER_QUESTION: 1.5,
    MAX_SAFE_Q_PER_CHUNK: 3,
    OVERLAP_TOKENS_PER_CHUNK: config.CHUNK_OVERLAP_TOKENS || 200,
};

/**
 * Adaptive Question Budget Strategy
 * Рассчитывает оптимальное целевое количество вопросов для документа
 * на основе его объема, качества и плотности фактов.
 * 
 * @param {string} fullText 
 * @param {Array} indexedChunks 
 * @param {Object} options - { extractionQuality, questionTypes: ['multiple_choice'] }
 * @returns {Object} { targetCount, metrics, logs, reductionReasons }
 */
function calculateQuestionBudget(fullText, indexedChunks, options = {}) {
    const { extractionQuality = 1.0, questionTypes = ['multiple_choice'] } = options;
    const logs = [];
    const reductionReasons = [];

    // 1. Сбор сырой статистики
    const chunkCount = indexedChunks?.length || 0;
    let totalTokens = 0;
    let atomicFacts = 0;

    if (chunkCount > 0) {
        indexedChunks.forEach(c => {
            totalTokens += (c.token_count || 0);
            atomicFacts += (Array.isArray(c.summary) ? c.summary.length : 0);
        });
    } else {
        // Fallback для текста без чанков: 1 токен ~= 4 символа, 1 факт ~= 400 символов
        totalTokens = Math.floor((fullText?.length || 0) / 4);
        atomicFacts = Math.floor((fullText?.length || 0) / 400);
    }

    // 2. Учёт перекрытия (Overlap) и уникальных концепций
    const overlapTokens = Math.max(0, (chunkCount - 1) * CONFIG.OVERLAP_TOKENS_PER_CHUNK);
    const effectiveTokens = Math.max(100, totalTokens - overlapTokens);
    
    const overlapRatio = totalTokens > 0 ? (overlapTokens / totalTokens) : 0;
    const uniqueConcepts = Math.floor(atomicFacts * (1 - overlapRatio * 0.5)); // Штраф за перекрытие

    // 3. Вычисление сырых емкостей (Capacities)
    const capacityByTokens = Math.floor(effectiveTokens / CONFIG.TOKENS_PER_QUESTION);
    const capacityByFacts = Math.floor(uniqueConcepts / CONFIG.FACTS_PER_QUESTION);
    const capacityByChunks = chunkCount > 0 ? chunkCount * CONFIG.MAX_SAFE_Q_PER_CHUNK : capacityByTokens;

    // Исходный базовый бюджет берётся по самому узкому горлышку контента
    let rawBudget = Math.min(capacityByTokens, capacityByFacts, capacityByChunks);
    
    // 4. Коэффициенты
    // 4.1 Document Quality Coefficient
    const qualityCoeff = Math.max(0.4, extractionQuality); 
    if (qualityCoeff < 0.8) {
        reductionReasons.push(`Низкое качество текста (${Math.round(qualityCoeff*100)}%). Риск галлюцинаций.`);
    }

    // 4.2 Testability Coefficient (Плотность фактов)
    // Норма: ~15 фактов на 1000 токенов
    const factDensity = (uniqueConcepts / (effectiveTokens / 1000)) || 0;
    let testabilityCoeff = 1.0;
    
    if (factDensity < 8) {
        testabilityCoeff = 0.7; // "Вода"
        reductionReasons.push(`Низкая плотность фактов (${factDensity.toFixed(1)}/1k токенов) — много "воды".`);
    } else if (factDensity > 25) {
        testabilityCoeff = 1.2; // Плотный контент
        logs.push(`Высокая плотность фактов (${factDensity.toFixed(1)}/1k токенов) — разрешено больше вопросов.`);
    }

    // 4.3 Question Type Mix
    const isOnlyMCQ = questionTypes.length === 1 && questionTypes[0] === 'multiple_choice';
    const typeMixCoeff = isOnlyMCQ ? 1.0 : 1.2;

    // 5. Применение коэффициентов
    let adjustedBudget = Math.round(rawBudget * qualityCoeff * testabilityCoeff * typeMixCoeff);

    // 6. Применение Hard Limits
    // Динамический HARD_MIN, ограниченный реальными фактами, чтобы не заставлять систему придумывать 5 вопросов из 2 фактов
    const documentHardMin = Math.min(CONFIG.HARD_MIN, Math.max(1, uniqueConcepts)); 
    
    // Ограничение по конфигам пользователя, но с рамками HARD_MIN и HARD_MAX
    const configuredMin = config.TARGET_QUESTIONS_MIN || 20;
    const configuredMax = config.TARGET_QUESTIONS_MAX || 30;
    
    // Но мы не хотим, чтобы configuredMin насильно заставлял делать 20 вопросов для 1-страничного документа.
    // Поэтому пол (floor) будет адаптивным:
    const adaptiveMin = Math.max(documentHardMin, Math.min(configuredMin, adjustedBudget));
    
    let finalBudget = Math.max(adaptiveMin, Math.min(configuredMax, CONFIG.HARD_MAX, adjustedBudget));

    // Сбор метрик для логов и UI
    const metrics = {
        effectiveTokens, uniqueConcepts, factDensity, 
        capacities: { tokens: capacityByTokens, facts: capacityByFacts, chunks: capacityByChunks },
        coeffs: { quality: qualityCoeff, testability: testabilityCoeff, mix: typeMixCoeff }
    };

    logs.push(`Raw Capacity: min(${capacityByTokens}T, ${capacityByFacts}F, ${capacityByChunks}C) = ${rawBudget}`);
    logs.push(`Budget Adjusted: ${rawBudget} * ${qualityCoeff.toFixed(2)}(Q) * ${testabilityCoeff.toFixed(2)}(T) * ${typeMixCoeff.toFixed(2)}(M) = ${adjustedBudget} -> Clamped: ${finalBudget}`);

    return { targetCount: finalBudget, metrics, logs, reductionReasons };
}

module.exports = { calculateQuestionBudget, CONFIG };