const { validateQuestions } = require('../validator');

function pickChunkSnippet(c) {
    if (c && Array.isArray(c.summary) && c.summary.length > 0) {
        const s = String(c.summary[0]).trim();
        if (s.length >= 12) return s.slice(0, 200);
    }
    if (!c || typeof c.text !== 'string') return '';
    const t = c.text.replace(/\s+/g, ' ').trim();
    const m = t.match(/[^.!?]{15,150}[.!?]/);
    if (m) return m[0].trim();
    return `${t.slice(0, 140)}…`;
}

function buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax) {
    let pool = (indexedChunks || []).filter((c) => c && typeof c.text === 'string' && c.text.trim().length >= 50);
    if (pool.length === 0 && fullText && String(fullText).trim().length > 80) {
        pool = [{
            id: indexedChunks[0]?.id ?? 0,
            text: fullText,
            summary: [],
            chunk_index: 0,
        }];
    }
    if (pool.length === 0) {
        throw new Error('Нет текста для автоматических вопросов');
    }
    const want = Math.min(
        targetMax,
        Math.max(3, targetMin),
        Math.max(15, pool.length),
    );
    const raw = [];
    for (let i = 0; i < want; i++) {
        const c = pool[i % pool.length];
        const correct = pickChunkSnippet(c);
        const options = [correct];
        let off = 1;
        while (options.length < 4 && off < pool.length + 5) {
            const o = pool[(i + off) % pool.length];
            const w = pickChunkSnippet(o);
            if (w && w !== correct && !options.includes(w)) options.push(w);
            off++;
        }
        while (options.length < 4) {
            options.push(`Вариант ${options.length + 1} (не относится к этому фрагменту).`);
        }
        const shuffled = options.slice(0, 4);
        for (let j = shuffled.length - 1; j > 0; j--) {
            const r = Math.floor(Math.random() * (j + 1));
            [shuffled[j], shuffled[r]] = [shuffled[r], shuffled[j]];
        }
        const correctIndex = shuffled.indexOf(correct);
        const ctx = String(c.text).replace(/\s+/g, ' ').trim().slice(0, 320);
        raw.push({
            type: 'multiple_choice',
            question:
                `По фрагменту: «${ctx}${ctx.length >= 320 ? '…' : ''}» — какое утверждение лучше всего соответствует этому фрагменту?`,
            explanation:
                'Собрано без LLM: дневная квота generateContent исчерпана. Варианты из выжимок и предложений чанков.',
            difficulty: 'remember',
            options: shuffled,
            correctIndex,
            sources: [{ chunk_id: c.id, quote: correct.slice(0, 280) }],
        });
    }
    return validateQuestions(raw);
}

module.exports = {
    pickChunkSnippet,
    buildOfflineMcqFromChunks,
};
