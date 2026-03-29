function detectSectionHint(text) {
    const lines = text.split('\n').slice(0, 6);
    for (const line of lines) {
        const t = line.trim();
        if (t.length < 4 || t.length > 90) continue;
        if (/[.,:;]$/.test(t)) continue;
        if (t === t.toUpperCase() || /^[0-9]+[.\s]/.test(t) ||
            /^(Глава|Раздел|Тема|Chapter|Section|Part|Unit)\b/i.test(t)) return t;
    }
    return null;
}

/**
 * Unified multi-source evidence builder for a single chunk.
 */
function resolveChunkEvidence(chunk, opts = {}) {
    const excerptChars = opts.excerptChars || 400;
    const maxFacts    = opts.maxFacts    || 10;

    const hasSummary = Array.isArray(chunk.summary) && chunk.summary.length > 0;
    const heading    = chunk.heading || detectSectionHint(chunk.text) || chunk.section || null;
    const rawText    = typeof chunk.text === 'string' ? chunk.text : '';

    function extractSentences(text, n) {
        const sents = text
            .replace(/\r\n/g, '\n')
            .split(/(?<=[.!?…])[\s\n]+|\n{2,}/)
            .map(s => s.trim())
            .filter(s => s.length > 25);
        const rich = sents.filter(s => s.length >= 50);
        return (rich.length >= 2 ? rich : sents).slice(0, n);
    }

    const excerpt = rawText.length > excerptChars
        ? rawText.slice(0, excerptChars) + '…'
        : rawText;

    if (hasSummary) {
        const facts = chunk.summary.slice(0, maxFacts);
        return { facts, source: 'summary', excerpt, heading };
    }

    const sentences = extractSentences(rawText, 5);
    let facts;
    if (sentences.length > 0) {
        facts = heading
            ? [`[${heading}] ${sentences[0]}`, ...sentences.slice(1)]
            : sentences;
    } else {
        facts = excerpt ? [excerpt] : [];
    }

    return { facts, source: 'text', excerpt, heading };
}

function buildSummaryDigest(indexedChunks, fullText, maxTotalChars = 18000) {
    if (!indexedChunks || indexedChunks.length === 0) {
        const third = Math.floor(fullText.length / 3);
        return [fullText.slice(0, 3000), '...', fullText.slice(third, third + 3000), '...', fullText.slice(-3000)].join('\n');
    }

    const sectionMap = new Map();
    for (const chunk of indexedChunks) {
        const sectionKey = chunk.section || chunk.heading || 'Документ';
        if (!sectionMap.has(sectionKey)) sectionMap.set(sectionKey, []);
        sectionMap.get(sectionKey).push(chunk);
    }

    let summaryChunks = 0, textChunks = 0;
    const blocks = [];
    let totalChars = 0;

    for (const [sectionName, chunks] of sectionMap) {
        const sectionHeader = `\n══════════════════════════════════\nРАЗДЕЛ: ${sectionName}\n══════════════════════════════════`;
        let sectionBlock = sectionHeader;

        for (const chunk of chunks) {
            const ev = resolveChunkEvidence(chunk, { excerptChars: 350, maxFacts: 6 });
            const chunkHeader = ev.heading && ev.heading !== sectionName
                ? `\n--- Чанк ${chunk.chunk_index + 1} [${ev.heading}] (${ev.source}) ---`
                : `\n--- Чанк ${chunk.chunk_index + 1} (${ev.source}) ---`;
            const content = ev.facts.map(f => `  • ${f}`).join('\n');
            sectionBlock += `${chunkHeader}\n${content}`;
            if (ev.source === 'summary') summaryChunks++; else textChunks++;
        }

        if (totalChars + sectionBlock.length > maxTotalChars) {
            const remaining = maxTotalChars - totalChars;
            if (remaining > 150) {
                blocks.push(sectionBlock.slice(0, remaining) + '\n...[Раздел усечён из-за лимита контекста]');
            }
            break;
        }
        blocks.push(sectionBlock);
        totalChars += sectionBlock.length;
    }

    console.log(`[RAG] buildSummaryDigest: ${blocks.length} разделов из ${sectionMap.size}`);
    return blocks.join('\n');
}

function buildEvidencePackets(chunks, _intent, opts = {}) {
    const { maxTextChars = 800 } = opts;
    return chunks.map(chunk => {
        const ev = resolveChunkEvidence(chunk, { excerptChars: maxTextChars, maxFacts: 10 });
        const text = chunk.text.length > maxTextChars ? chunk.text.slice(0, maxTextChars) + '…' : chunk.text;
        return {
            chunk_id:          chunk.id,
            facts:             ev.facts,
            text,
            excerpt:           ev.excerpt,
            heading:           ev.heading,
            downstream_source: ev.source,
            page:              chunk.page    ?? null,
            section:           chunk.section ?? null,
        };
    });
}

function formatEvidenceForPrompt(packets) {
    return packets.map((p, i) => {
        const metaParts = [`chunk_id=${p.chunk_id}`];
        if (p.page    != null) metaParts.push(`стр. ${p.page}`);
        if (p.section)         metaParts.push(`раздел: "${p.section}"`);
        if (p.heading)         metaParts.push(`секция: "${p.heading}"`);
        metaParts.push(`src=${p.downstream_source || 'unknown'}`);
        const parts = [`[Источник ${i + 1}, ${metaParts.join(' | ')}]`];
        if (p.facts.length > 0) parts.push(`Факты:\n${p.facts.map(f => `  • ${f}`).join('\n')}`);
        parts.push(`Текст:\n${p.text}`);
        return parts.join('\n');
    }).join('\n\n');
}

module.exports = {
    detectSectionHint,
    resolveChunkEvidence,
    buildSummaryDigest,
    buildEvidencePackets,
    formatEvidenceForPrompt,
};
