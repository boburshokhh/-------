const config = require('../../config');

function scoreEvidenceQuality(evidenceText, intent) {
    const minChars = config.EVIDENCE_MIN_CHARS || 80;
    if (!evidenceText || evidenceText.trim().length < minChars) {
        return { score: 0.1, reason: `Evidence слишком короткий (${evidenceText ? evidenceText.trim().length : 0} < ${minChars} символов)` };
    }
    const hasNumbers = /\d+/.test(evidenceText);
    const hasSentences = (evidenceText.match(/[.!?]/g) || []).length >= 2;
    const hasKeyTerms = evidenceText.split(/\s+/).filter(w => w.length > 5).length >= 5;
    let score = 0.5;
    if (hasNumbers) score += 0.15;
    if (hasSentences) score += 0.2;
    if (hasKeyTerms) score += 0.15;
    const intentWords = new Set(intent.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const evidenceLower = evidenceText.toLowerCase();
    let relevanceHits = 0;
    for (const word of intentWords) {
        if (evidenceLower.includes(word)) relevanceHits++;
    }
    const relevance = intentWords.size > 0 ? relevanceHits / intentWords.size : 0;
    if (relevance < 0.15) {
        return { score: 0.2, reason: `Evidence не релевантен intent (совпадение: ${Math.round(relevance * 100)}%)` };
    }
    return { score: Math.min(1, score), reason: null };
}

function assignDifficulties(blueprint, bloomMix = { remember: 0.20, understand: 0.35, apply: 0.25, analyze: 0.20 }) {
    const total = blueprint.length;
    const counts = {
        remember: Math.round(total * (bloomMix.remember ?? 0.20)),
        understand: Math.round(total * (bloomMix.understand ?? 0.35)),
        apply: Math.round(total * (bloomMix.apply ?? 0.25)),
        analyze: Math.round(total * (bloomMix.analyze ?? 0.20)),
    };
    const assigned = counts.remember + counts.understand + counts.apply + counts.analyze;
    counts.understand += total - assigned;
    const pool = [
        ...Array(Math.max(0, counts.remember)).fill('remember'),
        ...Array(Math.max(0, counts.understand)).fill('understand'),
        ...Array(Math.max(0, counts.apply)).fill('apply'),
        ...Array(Math.max(0, counts.analyze)).fill('analyze'),
    ];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return blueprint.map((intent, i) => ({ ...intent, difficulty: pool[i] || 'understand' }));
}

module.exports = {
    scoreEvidenceQuality,
    assignDifficulties,
};
