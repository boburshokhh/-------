const { calculateQuestionBudget } = require('../services/budgetCalculator');

// Mock data helpers
function createChunks(count, tokensPerChunk, factsPerChunk) {
    return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        token_count: tokensPerChunk,
        summary: Array.from({ length: factsPerChunk }, (_, j) => `Fact ${j}`),
    }));
}

function runTests() {
    console.log('--- Запуск тестов budgetCalculator ---');

    // Тест 1: Короткий плохой скан (Презентация, 1 стр)
    // 2 чанка, 600 токенов (всего), 5 фактов (всего). Quality: 0.5
    // tokensPerChunk = 300, facts = 2.5 (2 и 3)
    const chunks1 = [
        { id: 1, token_count: 300, summary: ['F1', 'F2'] },
        { id: 2, token_count: 300, summary: ['F3', 'F4', 'F5'] }
    ];
    const res1 = calculateQuestionBudget("mock text", chunks1, { extractionQuality: 0.5 });
    console.log('\n[TEST 1] Короткий плохой скан (Quality: 0.5)');
    console.log(`Target Count: ${res1.targetCount}`);
    console.log(`Reasons: ${res1.reductionReasons.join(', ')}`);
    // Ожидаемо: очень маленький бюджет из-за качества и малого числа фактов

    // Тест 2: Научная статья (Плотный, длинный)
    // 30 чанков, 25k токенов, 400 фактов. Quality: 0.95
    const chunks2 = createChunks(30, 833, 13); // 30 * 833 ~= 25000 токенов, 30 * 13 = 390 фактов
    const res2 = calculateQuestionBudget("mock text", chunks2, { extractionQuality: 0.95 });
    console.log('\n[TEST 2] Научная статья (Плотная, Quality: 0.95)');
    console.log(`Target Count: ${res2.targetCount}`);
    console.log(`Logs:\n  ${res2.logs.join('\n  ')}`);

    // Тест 3: Маркетинговая брошюра ("Вода", 10 стр)
    // 12 чанков, 10k токенов, 40 фактов. Quality: 1.0
    const chunks3 = createChunks(12, 833, 3); // ~10k токенов, 36 фактов
    const res3 = calculateQuestionBudget("mock text", chunks3, { extractionQuality: 1.0 });
    console.log('\n[TEST 3] Маркетинговая брошюра ("Вода", Quality: 1.0)');
    console.log(`Target Count: ${res3.targetCount}`);
    console.log(`Reasons: ${res3.reductionReasons.join(', ')}`);
    console.log(`Logs:\n  ${res3.logs.join('\n  ')}`);

    console.log('\n--- Тесты завершены ---');
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
