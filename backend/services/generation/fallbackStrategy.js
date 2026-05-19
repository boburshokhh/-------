const { validateQuestions } = require('../validator');
const { getMergedFactsForChunk } = require('../rag/evidenceBuilder');

/** Доля букв (латиница + кириллица) — отсекает «мусор» из битого PDF без LLM. */
function letterRatio(text) {
    const t = String(text || '');
    if (!t.length) return 0;
    const letters = (t.match(/[\p{L}]/gu) || []).length;
    return letters / t.length;
}

function isReadableSnippet(text, minLen = 12) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length < minLen) return false;
    if (letterRatio(s) < 0.35) return false;
    if ((s.match(/[©®™=<>|~`]{3,}/g) || []).length > 0) return false;
    return true;
}

function pickChunkSnippet(c) {
    if (c) {
        const merged = getMergedFactsForChunk(c, 6);
        if (merged.length > 0) {
            const s = String(merged[0]).trim();
            if (isReadableSnippet(s)) return s.slice(0, 200);
        }
    }
    if (!c || typeof c.text !== 'string') return '';
    const t = c.text.replace(/\s+/g, ' ').trim();
    const m = t.match(/[^.!?]{15,150}[.!?]/);
    if (m && isReadableSnippet(m[0])) return m[0].trim();
    const head = t.slice(0, 140);
    if (isReadableSnippet(head, 20)) return `${head}…`;
    return '';
}

function buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax) {
    let pool = (indexedChunks || []).filter(
        (c) => c && typeof c.text === 'string' && c.text.trim().length >= 50 && isReadableSnippet(c.text, 40),
    );
    if (pool.length === 0 && fullText && String(fullText).trim().length > 80) {
        pool = [{
            id: indexedChunks[0]?.id ?? 0,
            text: fullText,
            summary: [],
            chunk_index: 0,
        }];
    }
    if (pool.length === 0) {
        throw new Error(
            'Оффлайн-сборка невозможна: из PDF не извлечён читаемый текст (нужен текстовый слой или OCR). '
            + 'Сначала исправьте документ или дождитесь сброса квоты LLM для нормальной генерации.',
        );
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
        if (!correct) continue;
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
        const ctx = correct.slice(0, 320);
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
    if (raw.length === 0) {
        throw new Error(
            'Оффлайн-сборка не дала ни одного читаемого вопроса. Используйте PDF с текстовым слоем или дождитесь сброса квоты LLM.',
        );
    }
    return validateQuestions(raw);
}

module.exports = {
    isReadableSnippet,
    pickChunkSnippet,
    buildOfflineMcqFromChunks,
};
