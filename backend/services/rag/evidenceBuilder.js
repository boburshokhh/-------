const { coerceExtractiveFacts } = require('../nlp/extractiveFacts');

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

function getLlmFacts(chunk) {
    if (!Array.isArray(chunk.summary)) return [];
    return chunk.summary.map(s => String(s)).filter(Boolean);
}

function getExtractiveFacts(chunk) {
    if (Array.isArray(chunk.extractive_facts) && chunk.extractive_facts.length > 0) {
        return chunk.extractive_facts.map(s => String(s)).filter(Boolean);
    }
    const text = typeof chunk.text === 'string' ? chunk.text : '';
    return coerceExtractiveFacts(null, text);
}

/**
 * Extractive bullets first, then LLM facts; skip near-duplicates (prefix key).
 * @param {string[]} llmFacts
 * @param {string[]} extractiveFacts
 * @param {number} maxTotal
 * @returns {string[]}
 */
function mergeFactLayers(llmFacts, extractiveFacts, maxTotal) {
    const seen = new Set();
    const out = [];
    function pushFact(f) {
        const t = String(f).trim();
        if (!t) return;
        const key = t.slice(0, 72).toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) return;
        seen.add(key);
        out.push(t);
    }
    for (const f of extractiveFacts) pushFact(f);
    for (const f of llmFacts) pushFact(f);
    return out.slice(0, maxTotal);
}

function extractSentences(text, n) {
    const sents = text
        .replace(/\r\n/g, '\n')
        .split(/(?<=[.!?…])[\s\n]+|\n{2,}/)
        .map(s => s.trim())
        .filter(s => s.length > 25);
    const rich = sents.filter(s => s.length >= 50);
    return (rich.length >= 2 ? rich : sents).slice(0, n);
}

/**
 * Multi-layer evidence: LLM facts, extractive facts, raw excerpt; merged facts for prompts.
 */
function resolveChunkEvidence(chunk, opts = {}) {
    const excerptChars = opts.excerptChars || 400;
    const maxFacts = opts.maxFacts || 10;

    const llmFactsRaw = getLlmFacts(chunk);
    const extractiveFactsRaw = getExtractiveFacts(chunk);
    const heading = chunk.heading || detectSectionHint(chunk.text) || chunk.section || null;
    const rawText = typeof chunk.text === 'string' ? chunk.text : '';

    const excerpt = rawText.length > excerptChars
        ? rawText.slice(0, excerptChars) + '…'
        : rawText;

    let facts = mergeFactLayers(llmFactsRaw, extractiveFactsRaw, maxFacts);

    let source;
    if (llmFactsRaw.length > 0 && extractiveFactsRaw.length > 0) source = 'layered';
    else if (llmFactsRaw.length > 0) source = 'summary';
    else if (extractiveFactsRaw.length > 0) source = 'extractive';
    else source = 'text';

    if (facts.length === 0) {
        const sentences = extractSentences(rawText, 5);
        if (sentences.length > 0) {
            facts = heading
                ? [`[${heading}] ${sentences[0]}`, ...sentences.slice(1)]
                : sentences;
        } else {
            facts = excerpt ? [excerpt] : [];
        }
        source = 'text';
    }

    return {
        facts,
        llmFacts: llmFactsRaw,
        extractiveFacts: extractiveFactsRaw,
        excerpt,
        heading,
        section: chunk.section ?? null,
        source,
    };
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

    let summaryChunks = 0, layeredChunks = 0, textChunks = 0;
    const blocks = [];
    let totalChars = 0;

    const maxExDigest = 6;
    const maxLlmDigest = 6;
    const snippetChars = 380;

    for (const [sectionName, chunks] of sectionMap) {
        const sectionHeader = `\n══════════════════════════════════\nРАЗДЕЛ: ${sectionName}\n══════════════════════════════════`;
        let sectionBlock = sectionHeader;

        for (const chunk of chunks) {
            const ev = resolveChunkEvidence(chunk, { excerptChars: snippetChars, maxFacts: 12 });
            const chunkHeader = ev.heading && ev.heading !== sectionName
                ? `\n--- Чанк ${chunk.chunk_index + 1} [${ev.heading}] (${ev.source}) ---`
                : `\n--- Чанк ${chunk.chunk_index + 1} (${ev.source}) ---`;
            let chunkBody = '';

            if (chunk.section && chunk.section !== sectionName) {
                chunkBody += `Раздел (метаданные): ${chunk.section}\n`;
            }
            if (ev.heading && ev.heading !== sectionName) {
                chunkBody += `Заголовок чанка: ${ev.heading}\n`;
            }

            const exShow = ev.extractiveFacts.slice(0, maxExDigest);
            const llmShow = ev.llmFacts.slice(0, maxLlmDigest);

            if (exShow.length > 0) {
                chunkBody += 'Опоры из текста:\n';
                chunkBody += exShow.map(f => `  • ${f}`).join('\n') + '\n';
            }
            if (llmShow.length > 0) {
                chunkBody += 'Факты (модель):\n';
                chunkBody += llmShow.map(f => `  • ${f}`).join('\n') + '\n';
            }
            if (exShow.length === 0 && llmShow.length === 0 && ev.facts.length > 0) {
                chunkBody += 'Факты:\n';
                chunkBody += ev.facts.slice(0, 8).map(f => `  • ${f}`).join('\n') + '\n';
            }
            chunkBody += `Фрагмент текста:\n  ${ev.excerpt}\n`;

            sectionBlock += `${chunkHeader}\n${chunkBody}`;

            if (ev.source === 'layered') layeredChunks++;
            else if (ev.source === 'summary') summaryChunks++;
            else textChunks++;
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

    console.log(`[RAG] buildSummaryDigest: ${blocks.length} разделов из ${sectionMap.size} (layered=${layeredChunks}, summary=${summaryChunks}, text/extractive=${textChunks})`);
    return blocks.join('\n');
}

function buildEvidencePackets(chunks, _intent, opts = {}) {
    const { maxTextChars = 800 } = opts;
    return chunks.map(chunk => {
        const ev = resolveChunkEvidence(chunk, { excerptChars: maxTextChars, maxFacts: 10 });
        const t = typeof chunk.text === 'string' ? chunk.text : '';
        const text = t.length > maxTextChars ? t.slice(0, maxTextChars) + '…' : t;
        return {
            chunk_id: chunk.id,
            facts: ev.facts,
            llm_facts: ev.llmFacts.slice(0, 10),
            extractive_facts: ev.extractiveFacts.slice(0, 10),
            text,
            excerpt: ev.excerpt,
            heading: ev.heading,
            downstream_source: ev.source,
            page: chunk.page ?? null,
            section: chunk.section ?? null,
        };
    });
}

function formatEvidenceForPrompt(packets) {
    return packets.map((p, i) => {
        const metaParts = [`chunk_id=${p.chunk_id}`];
        if (p.page != null) metaParts.push(`стр. ${p.page}`);
        if (p.section) metaParts.push(`раздел: "${p.section}"`);
        if (p.heading) metaParts.push(`секция: "${p.heading}"`);
        metaParts.push(`src=${p.downstream_source || 'unknown'}`);
        const parts = [`[Источник ${i + 1}, ${metaParts.join(' | ')}]`];

        const hasE = Array.isArray(p.extractive_facts) && p.extractive_facts.length > 0;
        const hasL = Array.isArray(p.llm_facts) && p.llm_facts.length > 0;

        if (hasE) {
            parts.push(`Опоры из текста:\n${p.extractive_facts.map(f => `  • ${f}`).join('\n')}`);
        }
        if (hasL) {
            parts.push(`Факты (модель):\n${p.llm_facts.map(f => `  • ${f}`).join('\n')}`);
        }
        if (!hasE && !hasL && p.facts.length > 0) {
            parts.push(`Факты:\n${p.facts.map(f => `  • ${f}`).join('\n')}`);
        }
        parts.push(`Текст:\n${p.text}`);
        return parts.join('\n');
    }).join('\n\n');
}

function getMergedFactsForChunk(chunk, max = 25) {
    return mergeFactLayers(getLlmFacts(chunk), getExtractiveFacts(chunk), max);
}

function countMergedFactBullets(chunk, cap = 50) {
    return getMergedFactsForChunk(chunk, cap).length;
}

module.exports = {
    detectSectionHint,
    resolveChunkEvidence,
    buildSummaryDigest,
    buildEvidencePackets,
    formatEvidenceForPrompt,
    mergeFactLayers,
    getMergedFactsForChunk,
    countMergedFactBullets,
};
