function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function levenshteinSimilarity(a, b) {
    if (a === b) return 1;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const costs = [];
    for (let i = 0; i <= longer.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= shorter.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (longer[i - 1] !== shorter[j - 1]) {
                    newValue = Math.min(newValue, lastValue, costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[shorter.length] = lastValue;
    }
    return (longer.length - costs[shorter.length]) / longer.length;
}

/**
 * Семантическая дедубликация массива вопросов с помощью векторов.
 * getEmbeddingsProvider — функция, возвращающая батч векторов для массива строк.
 */
async function semanticDedup(questions, getEmbeddingsProvider, threshold = 0.88) {
    if (questions.length === 0) return questions;
    let embeddings = [];
    
    try {
        const texts = questions.map(q => q.question);
        embeddings = await getEmbeddingsProvider(texts);
    } catch (err) {
        console.warn(`[NLP] semanticDedup batch embedding failed: ${err.message}. Векторная фильтрация работает в degraded (text-only) режиме.`);
        embeddings = new Array(questions.length).fill(null);
    }

    const unique = [];
    const usedIdx = new Set();

    for (let i = 0; i < questions.length; i++) {
        if (usedIdx.has(i)) continue;
        let isDup = false;
        for (let j = 0; j < unique.length; j++) {
            const prevIdx = unique[j]._origIdx;
            if (embeddings[i] && embeddings[prevIdx]) {
                const sim = cosineSimilarity(embeddings[i], embeddings[prevIdx]);
                if (sim > threshold) { isDup = true; break; }
            }
            const textSim = levenshteinSimilarity(
                questions[i].question.toLowerCase(),
                unique[j].question.toLowerCase()
            );
            if (textSim > 0.8) { isDup = true; break; }
        }
        if (!isDup) {
            unique.push({ ...questions[i], _origIdx: i });
        } else {
            usedIdx.add(i);
        }
    }
    return unique.map(({ _origIdx, ...q }, i) => ({ ...q, id: i + 1 }));
}


module.exports = {
    cosineSimilarity,
    levenshteinSimilarity,
    semanticDedup
};
