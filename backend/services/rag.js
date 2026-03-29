const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const { extractJSON } = require('./validator');
const runtimeConfig = require('./runtimeConfig');
const quotaGuard = require('./quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry, withTimeout } = require('./geminiError');

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

/**
 * После исчерпания повторов к Gemini — явная ошибка для API/UI (без молчаливого fallback).
 * @param {string} stepHuman
 * @param {unknown} lastError
 */
function throwAfterGeminiRetriesFailed(stepHuman, lastError) {
    console.error(`[RAG] ${stepHuman}: попытки исчерпаны`, lastError && lastError.message);
    if (lastError && lastError.type === 'QUOTA_EXCEEDED') {
        throw lastError;
    }
    if (!lastError) {
        const e = new Error('Не удалось связаться с моделью генерации. Повторите попытку позже.');
        e.type = 'LLM_ERROR';
        throw e;
    }
    const g = parseGeminiApiError(lastError);
    if (g.isDailyFreeTierQuota) {
        const e = new Error('Достигнут дневной лимит запросов к модели (UTC). Попробуйте завтра или укажите другой API-ключ в настройках.');
        e.type = 'QUOTA_EXCEEDED';
        e.details = lastError.message;
        throw e;
    }
    if (g.isTransientUnavailable) {
        const e = new Error('Выбранная модель временно перегружена или недоступна (Google). Подождите несколько минут или выберите другую модель, например gemini-2.5-flash.');
        e.type = 'LLM_ERROR';
        e.details = lastError.message;
        throw e;
    }
    if (g.isResourceExhausted) {
        const e = new Error('Превышен лимит запросов к API модели. Подождите около минуты и повторите попытку.');
        e.type = 'LLM_ERROR';
        e.details = lastError.message;
        throw e;
    }
    const e = new Error('Модель не вернула корректный ответ. Повторите попытку.');
    e.type = 'LLM_ERROR';
    e.details = lastError.message;
    throw e;
}

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

async function getQueryEmbedding(query, retries = 3) {
    const embedModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(embedModel);
            const ai = await getAiClient();
            const response = await ai.models.embedContent({
                model: embedModel,
                contents: query,
            });
            await quotaGuard.recordGeminiCall(embedModel);
            return Array.isArray(response.embeddings)
                ? response.embeddings[0].values
                : response.embeddings.values || response.embedding.values;
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const parsed = parseGeminiApiError(err);
            if (parsed.isResourceExhausted) {
                await quotaGuard.syncFromGoogle429(embedModel, err);
            }
            if (parsed.isDailyFreeTierQuota) break;
            if (attempt < retries) await sleepForGeminiRetry(parsed, attempt, retries, sleep);
        }
    }
    throw lastError;
}

async function getBatchEmbeddings(texts, retries = 3) {
    if (!texts || texts.length === 0) return [];
    
    // Some endpoints may require limits per batch (e.g. 100), but we handle chunking at the caller if needed.
    const embedModel = config.EMBEDDING_MODEL || 'gemini-embedding-001';
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(embedModel);
            const ai = await getAiClient();
            
            const response = await ai.models.batchEmbedContents({
                model: embedModel,
                contents: texts,
            });
            await quotaGuard.recordGeminiCall(embedModel);
            
            if (response && response.embeddings && Array.isArray(response.embeddings)) {
                return response.embeddings.map(e => e.values);
            }
            throw new Error('Invalid response format from batchEmbedContents');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const parsed = parseGeminiApiError(err);
            if (parsed.isResourceExhausted) {
                await quotaGuard.syncFromGoogle429(embedModel, err);
            }
            if (parsed.isDailyFreeTierQuota) break;
            if (attempt < retries) await sleepForGeminiRetry(parsed, attempt, retries, sleep);
        }
    }
    throw lastError;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function mmrSelect(queryVec, candidates, k, lambda = 0.65, threshold = 0.0) {
    const valid = candidates.filter(c => Array.isArray(c.embedding) && c.embedding.length > 0);
    if (valid.length === 0) return candidates.slice(0, k);
    const withScore = valid.map(c => ({ ...c, queryScore: cosineSimilarity(queryVec, c.embedding) }));
    const aboveThreshold = threshold > 0 ? withScore.filter(c => c.queryScore >= threshold) : withScore;
    const pool = aboveThreshold.length > 0 ? aboveThreshold : withScore;
    const selected = [];
    const remaining = [...pool];

    while (selected.length < k && remaining.length > 0) {
        if (selected.length === 0) {
            const best = remaining.reduce((a, b) => (a.queryScore > b.queryScore ? a : b));
            selected.push(best);
            remaining.splice(remaining.indexOf(best), 1);
        } else {
            let bestScore = -Infinity;
            let bestIdx = 0;
            for (let i = 0; i < remaining.length; i++) {
                const cand = remaining[i];
                const maxSim = selected.reduce(
                    (mx, s) => Math.max(mx, cosineSimilarity(cand.embedding, s.embedding)), 0
                );
                const mmrScore = lambda * cand.queryScore - (1 - lambda) * maxSim;
                if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
            }
            selected.push(remaining[bestIdx]);
            remaining.splice(bestIdx, 1);
        }
    }
    return selected;
}

function lexicalScore(query, text) {
    const queryWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const textLower = text.toLowerCase();
    let hits = 0;
    for (const w of queryWords) {
        const re = new RegExp(`\\b${w}\\b`, 'g');
        const matches = textLower.match(re);
        if (matches) hits += Math.log(1 + matches.length);
    }
    return queryWords.size > 0 ? hits / queryWords.size : 0;
}

async function hybridRetrieve(query, indexedChunks, k, opts = {}) {
    const {
        topN = Math.max(k * 3, 12),
        wVec = 0.75,
        wLex = 0.25,
        lambda = config.MMR_LAMBDA || 0.65,
        threshold = config.RAG_THRESHOLD || 0.0,
    } = opts;

    const queryVec = await getQueryEmbedding(query);
    const scored = indexedChunks.map(c => {
        const vecSim = Array.isArray(c.embedding) ? cosineSimilarity(queryVec, c.embedding) : 0;
        const lexSim = lexicalScore(query, c.text);
        return { ...c, vectorScore: vecSim, lexScore: lexSim, hybridScore: wVec * vecSim + wLex * lexSim };
    });
    scored.sort((a, b) => b.hybridScore - a.hybridScore);
    const candidates = scored.slice(0, topN);
    const selected = mmrSelect(queryVec, candidates, k, lambda, threshold);
    if (selected.length === 0) return indexedChunks.slice(0, k);
    selected.sort((a, b) => a.chunk_index - b.chunk_index);
    return selected;
}

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
 *
 * Priority:
 *   1. chunk.summary (LLM/extractive facts from indexer) — source: 'summary'
 *   2. heading + first meaningful sentences                — source: 'text'
 *   3. raw text excerpt only                              — source: 'text'
 *
 * Returns:
 *   { facts: string[], source: 'summary'|'text'|'mixed', excerpt: string, heading: string|null }
 *
 * NEVER returns empty facts — always provides at least an excerpt as a fallback fact.
 */
function resolveChunkEvidence(chunk, opts = {}) {
    const excerptChars = opts.excerptChars || 400;
    const maxFacts    = opts.maxFacts    || 10;

    const hasSummary = Array.isArray(chunk.summary) && chunk.summary.length > 0;
    const heading    = chunk.heading || detectSectionHint(chunk.text) || chunk.section || null;
    const rawText    = typeof chunk.text === 'string' ? chunk.text : '';

    // Extractive sentences from raw text (for fallback)
    function extractSentences(text, n) {
        const sents = text
            .replace(/\r\n/g, '\n')
            .split(/(?<=[.!?…])[\s\n]+|\n{2,}/)
            .map(s => s.trim())
            .filter(s => s.length > 25);
        const rich = sents.filter(s => s.length >= 50);
        return (rich.length >= 2 ? rich : sents).slice(0, n);
    }

    // Build concise excerpt for prompt context
    const excerpt = rawText.length > excerptChars
        ? rawText.slice(0, excerptChars) + '…'
        : rawText;

    if (hasSummary) {
        const facts = chunk.summary.slice(0, maxFacts);
        return { facts, source: 'summary', excerpt, heading };
    }

    // No summary — build from text
    const sentences = extractSentences(rawText, 5);
    let facts;
    if (sentences.length > 0) {
        facts = heading
            ? [`[${heading}] ${sentences[0]}`, ...sentences.slice(1)]
            : sentences;
    } else {
        // Absolute last resort: use excerpt itself as a single fact
        facts = excerpt ? [excerpt] : [];
    }

    return { facts, source: 'text', excerpt, heading };
}

/**
 * Builds a section-grouped digest for theme extraction.
 * Groups chunks by their section/heading metadata so the LLM
 * can clearly see section boundaries and generate granular topics.
 */
function buildSummaryDigest(indexedChunks, fullText, maxTotalChars = 18000) {
    if (!indexedChunks || indexedChunks.length === 0) {
        const third = Math.floor(fullText.length / 3);
        return [fullText.slice(0, 3000), '...', fullText.slice(third, third + 3000), '...', fullText.slice(-3000)].join('\n');
    }

    // Group chunks by section to make section structure visible to LLM
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

    const mixLabel = summaryChunks > 0 && textChunks > 0 ? 'mixed'
        : summaryChunks > 0 ? 'summary' : 'text';
    console.log(`[RAG] buildSummaryDigest: ${blocks.length} разделов из ${sectionMap.size}, downstream_source=${mixLabel} (summary=${summaryChunks}, text=${textChunks})`);
    return blocks.join('\n');
}

/**
 * Estimates theme count from structural signals.
 * Priority: unique sections > chunk count > text length.
 * NEVER returns 1 if the document has meaningful structure.
 */
function estimateThemeCount(indexedChunks, fullText) {
    if (indexedChunks && indexedChunks.length > 0) {
        const chunkCount = indexedChunks.length;

        // Count unique sections — strongest structural signal
        const uniqueSections = new Set();
        for (const chunk of indexedChunks) {
            const sec = (chunk.section || chunk.heading || '').trim();
            if (sec && sec !== 'Документ') uniqueSections.add(sec);
        }
        const sectionCount = uniqueSections.size;

        // Count facts for density-based estimate (but never let 0 facts → 1 theme)
        let factsCount = 0;
        for (const chunk of indexedChunks) {
            if (Array.isArray(chunk.summary) && chunk.summary.length > 0) {
                factsCount += chunk.summary.length;
            } else {
                // Estimate from text: ~1 testable fact per 3 sentence-ending punctuation marks
                const text = typeof chunk.text === 'string' ? chunk.text : '';
                const sentenceEst = Math.max(2, Math.min(6,
                    Math.ceil((text.match(/[.!?]/g) || []).length / 2)
                ));
                factsCount += sentenceEst;
            }
        }

        // Three signals, take the max so we're never artificially low
        const bySection = sectionCount >= 2 ? sectionCount : 0;       // explicit section structure
        const byChunks  = Math.ceil(chunkCount / 3);                  // ~1 theme per 3 chunks
        const byFacts   = Math.ceil(factsCount / 5);                  // ~1 theme per 5 facts

        // Hard minimum: at least 3 themes for any real document with >5 chunks
        const hardMin = chunkCount >= 5 ? 3 : 1;
        const estimate = Math.max(hardMin, bySection, byChunks, byFacts);

        console.log(`[RAG] estimateThemeCount: sections=${sectionCount} chunks=${chunkCount} facts=${factsCount} → bySection=${bySection} byChunks=${byChunks} byFacts=${byFacts} → estimate=${Math.min(14, estimate)}`);
        return Math.min(14, estimate);
    }
    // No chunks: fall back to text length
    const lenBasedMin = Math.max(2, Math.floor(fullText.length / 5000));
    return Math.min(8, Math.max(3, Math.floor(fullText.length / 3000)));
}

/**
 * Builds themes locally from chunk metadata without LLM.
 * Used as quota-exhausted fallback — ensures at least one theme per section.
 */
function buildLocalThemesFromSections(indexedChunks) {
    const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

    // Classify content type signals for Bloom level selection
    const CONTENT_SIGNALS = [
        { re: /(?:ВНИМАНИЕ|ОСТОРОЖНО|warning|caution|danger)/i, bloom: ['remember', 'apply'],     importance: 3, label: 'safety' },
        { re: /(?:неисправн|диагностик|troubleshoot|fault)/i,   bloom: ['analyze', 'apply'],      importance: 3, label: 'troubleshooting' },
        { re: /(?:техническ|обслужива|maintenance|service)/i,   bloom: ['remember', 'apply'],     importance: 2, label: 'maintenance' },
        { re: /(?:установк|монтаж|install|assembly)/i,          bloom: ['understand', 'apply'],   importance: 2, label: 'installation' },
        { re: /(?:настройк|регулировк|настрой|calibrat)/i,      bloom: ['apply', 'analyze'],      importance: 2, label: 'configuration' },
        { re: /(?:эксплуатац|работ|операц|operation|usage)/i,   bloom: ['understand', 'apply'],   importance: 2, label: 'operation' },
        { re: /(?:параметр|характеристик|specification|spec)/i, bloom: ['remember', 'understand'], importance: 2, label: 'parameters' },
    ];

    // Group chunks by section
    const sectionMap = new Map();
    for (const chunk of indexedChunks) {
        const sec = (chunk.section || chunk.heading || 'Документ').trim();
        if (!sectionMap.has(sec)) sectionMap.set(sec, []);
        sectionMap.get(sec).push(chunk);
    }

    const themes = [];
    let idx = 0;

    for (const [section, chunks] of sectionMap) {
        // Collect all text for signal detection
        const sectionText = chunks.map(c => c.text || '').join(' ');
        const summaryFacts = chunks.flatMap(c => Array.isArray(c.summary) ? c.summary : []);

        // Find first matching content signal
        let bloom = ['understand'];
        let importance = 2;
        let contentLabel = null;
        for (const sig of CONTENT_SIGNALS) {
            if (sig.re.test(sectionText)) {
                bloom = sig.bloom;
                importance = sig.importance;
                contentLabel = sig.label;
                break;
            }
        }

        // Build topic name from section name + content type
        let topic;
        if (summaryFacts.length > 0) {
            // Use first fact as topic hint (strip type tags like [warning])
            const firstFact = summaryFacts[0].replace(/^\[(\w+)\]\s*/, '').slice(0, 80);
            topic = section === 'Документ' ? firstFact : `${section}: ${firstFact}`;
        } else {
            topic = contentLabel ? `${section} (${contentLabel})` : section;
        }

        const suggestedCount = Math.min(5, Math.max(2, Math.ceil(chunks.length * 1.5)));

        themes.push({
            topic: topic.slice(0, 120),
            section,
            importance,
            suggestedCount,
            difficultyCandidates: bloom,
        });
        idx++;
    }

    // Ensure at least 3 meaningful themes even if section map was flat
    if (themes.length === 1 && indexedChunks.length >= 4) {
        // Split the single section into sub-themes by chunk groups
        const all = indexedChunks;
        const groupSize = Math.ceil(all.length / 3);
        themes.length = 0;
        for (let i = 0; i < all.length; i += groupSize) {
            const group = all.slice(i, i + groupSize);
            const groupText = group.map(c => c.text || '').join(' ');
            let bloom = ['understand'];
            let importance = 2;
            for (const sig of CONTENT_SIGNALS) {
                if (sig.re.test(groupText)) { bloom = sig.bloom; importance = sig.importance; break; }
            }
            const firstFact = (group[0].summary || [])[0] || '';
            const topic = firstFact
                ? firstFact.replace(/^\[(\w+)\]\s*/, '').slice(0, 100)
                : `Группа чанков ${Math.floor(i / groupSize) + 1}`;
            themes.push({
                topic,
                section: group[0].section || 'Документ',
                importance,
                suggestedCount: Math.min(5, Math.max(2, group.length)),
                difficultyCandidates: bloom,
            });
        }
    }

    console.log(`[RAG] buildLocalThemesFromSections: ${themes.length} тем из ${sectionMap.size} разделов (without LLM)`);
    return themes;
}
async function buildThemesAndBlueprint(indexedChunks, fullText, model = null, targetCount = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const llmModel = config.LLM_FAST_MODEL || config.LLM_MODEL;

    const structuralEstimate = estimateThemeCount(indexedChunks, fullText);
    const targetThemes = targetCount ? Math.max(structuralEstimate, Math.min(10, Math.ceil(targetCount / 3))) : structuralEstimate;
    const totalQuestions = targetCount || 10;

    if (await quotaGuard.isRpdExhaustedForModel(llmModel)) {
        console.warn('[RAG] buildThemesAndBlueprint: RPD exhausted — local fallback');
        const themes = buildLocalThemesFromSections(indexedChunks);
        const richThemes = themes.map(t => typeof t === 'string' ? { topic: t, section: 'Документ', importance: 2, suggestedCount: 3 } : t);
        const perTheme = computeIntentsPerTheme(richThemes, totalQuestions);
        return buildBlueprintFallbackLocal(richThemes, perTheme);
    }

    const digest = buildSummaryDigest(indexedChunks, fullText);
    const uniqueSections = [...new Set((indexedChunks || []).map(c => (c.section || c.heading || '').trim()).filter(Boolean))];
    const sectionListText = uniqueSections.length > 0
        ? `\n\nРАЗДЕЛЫ ДОКУМЕНТА (${uniqueSections.length}):\n${uniqueSections.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '';

    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 0;
    const maxAttempts = 5;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(llmModel);
            const ai = await getAiClient();
            const genPromise = ai.models.generateContent({
                model: llmModel,
                contents: `Ты анализируешь документацию для создания проверочного теста (формат multiple_choice).
Твоя задача — выделить темы и СРАЗУ создать для них план вопросов (intents).

ТРЕБОВАНИЯ:
1. Выдели примерно ${targetThemes} конкретных тем из документа.${sectionListText}
2. Суммарно для всех тем ты должен сгенерировать ровно ${totalQuestions} намерений (intents). Распредели их по темам пропорционально их важности.
3. Intent — это что конкретно будет проверять вопрос (1-2 предложения, например "Проверить знание шагов процедуры отключения питания").

Материал (разбит по разделам):
${digest}

Верни строго JSON массив объектов (ровно ${totalQuestions} объектов). Формат:
[
  { "theme": "Название темы", "section": "Раздел", "intent": "Что проверить (намерение)", "type": "multiple_choice" },
  ...
]`,
                config: { temperature: 0.2, responseMimeType: 'application/json' },
            });

            const response = await withTimeout(genPromise, reqTimeout, '[RAG] buildThemesAndBlueprint generateContent');
            await quotaGuard.recordGeminiCall(llmModel);

            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

            if (list && list.length > 0) {
                const normalized = list.map(item => ({ ...item, type: 'multiple_choice' }));
                if (normalized.length < Math.floor(totalQuestions * 0.8)) {
                    throw new Error(`Слишком мало intents: ${normalized.length} < ${totalQuestions}`);
                }
                return normalized;
            }
            throw new Error('Пустой план вопросов');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, err);
            console.warn(`[RAG] buildThemesAndBlueprint попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) onRetry({ attempt, maxAttempts, parsed: g, message: String(err.message || '') });
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }
    throwAfterGeminiRetriesFailed('buildThemesAndBlueprint', lastError);
}

async function extractThemes(indexedChunks, fullText, model = null, targetCount = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const llmModel = config.LLM_FAST_MODEL || config.LLM_MODEL;

    const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];
    const OLD_TO_BLOOM = { easy: 'remember', medium: 'understand', hard: 'analyze' };

    // ── Compute target theme count ─────────────────────────────────────────────
    // Do NOT derive from targetCount/2 — that maps targetCount=1 → targetThemes=1.
    // Instead: take max of section-based estimate and a minimum floor.
    const structuralEstimate = estimateThemeCount(indexedChunks, fullText);

    // If caller passed targetCount, use it as a soft upper bound, not hard divisor
    const targetThemes = targetCount
        ? Math.max(structuralEstimate, Math.min(10, Math.ceil(targetCount / 3)))
        : structuralEstimate;

    // ── Quota check → rich local fallback ─────────────────────────────────────
    if (await quotaGuard.isRpdExhaustedForModel(llmModel)) {
        console.warn('[RAG] extractThemes: дневной лимит LLM исчерпан — собираем темы локально из разделов');
        return buildLocalThemesFromSections(indexedChunks);
    }

    // ── Build section-aware digest for the LLM ────────────────────────────────
    const digest = buildSummaryDigest(indexedChunks, fullText);

    // ── Collect unique sections for the prompt ────────────────────────────────
    const uniqueSections = [...new Set(
        (indexedChunks || []).map(c => (c.section || c.heading || '').trim()).filter(Boolean)
    )];
    const sectionListText = uniqueSections.length > 0
        ? `\n\nРАЗДЕЛЫ ДОКУМЕНТА (${uniqueSections.length}):\n${uniqueSections.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '';

    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 0;
    const maxAttempts = 5;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(llmModel);
            const ai = await getAiClient();
            const genPromise = ai.models.generateContent({
                model: llmModel,
                contents: `Ты анализируешь техническую/учебную документацию. Твоя задача — выделить КОНКРЕТНЫЕ, ГРАНУЛЯРНЫЕ темы из документа, представленного секциями с фактами.${sectionListText}

ТРЕБОВАНИЯ К ТЕМАМ:
1. Каждая тема — конкретная подтема из ОДНОГО раздела, НЕ обобщение всего документа.
2. Для технических документов ОБЯЗАТЕЛЬНО выделяй отдельные темы для:
   - Порядок/процедура эксплуатации (если есть)
   - Техническое обслуживание (если есть)
   - Диагностика и устранение неисправностей (если есть)
   - Меры безопасности и предупреждения (если есть)
   - Параметры и технические характеристики (если есть)
   - Отдельные режимы работы (если есть)
3. НЕ создавай тему «Общая информация» или «Основные концепции» — только конкретные темы.
4. Каждая тема должна быть достаточно конкретной для создания 2–5 проверочных вопросов.
5. Выдели ровно ${targetThemes} тем, равномерно охватывающих весь документ.

Для каждой темы укажи:
- topic: конкретное название темы (например: «Порядок замены фильтра», «Коды ошибок системы», «Предельно допустимые температуры»)
- section: название раздела документа (из списка разделов выше или из заголовка чанка)
- importance: важность 1–3 (3 = критически важная для понимания и безопасности)
- suggestedCount: рекомендуемое число вопросов (2–5)
- difficultyCandidates: массив из 1–3 уровней Bloom Taxonomy: "remember", "understand", "apply", "analyze"
  - remember: запоминание фактов и определений
  - understand: объяснение концепции или процедуры
  - apply: применение правила к ситуации
  - analyze: диагностика, сравнение, причинно-следственные связи

Материал (разбит по разделам):
${digest}

Верни JSON массив из ровно ${targetThemes} объектов. Никакого другого текста:
[{"topic":"...","section":"...","importance":2,"suggestedCount":3,"difficultyCandidates":["understand","apply"]},...]`,
                config: { temperature: 0.2, responseMimeType: 'application/json' },
            });
            const response = await withTimeout(genPromise, reqTimeout, '[RAG] extractThemes generateContent');
            await quotaGuard.recordGeminiCall(llmModel);

            const parsed = extractJSON(response.text);
            let themes = Array.isArray(parsed) ? parsed
                : (parsed.themes && Array.isArray(parsed.themes) ? parsed.themes : null);

            if (themes && themes.length > 0) {
                themes = themes.map((t, i) => {
                    let candidates = Array.isArray(t.difficultyCandidates) && t.difficultyCandidates.length > 0
                        ? t.difficultyCandidates : ['understand'];
                    candidates = candidates.map(d => OLD_TO_BLOOM[d] || d).filter(d => BLOOM_LEVELS.includes(d));
                    if (candidates.length === 0) candidates = ['understand'];
                    return {
                        topic: (t.topic || t.name || String(t)).trim(),
                        section: (t.section || `Раздел ${i + 1}`).trim(),
                        importance: Math.min(3, Math.max(1, Number(t.importance) || 2)),
                        suggestedCount: Math.min(5, Math.max(2, Number(t.suggestedCount) || 3)),
                        difficultyCandidates: candidates,
                    };
                });
                console.log(`[RAG] extractThemes: ${themes.length} тем из ${indexedChunks ? indexedChunks.length : 0} чанков (${uniqueSections.length} разделов)`);
                // Warn if LLM collapsed into fewer themes than structural estimate
                if (themes.length < Math.ceil(targetThemes * 0.6)) {
                    console.warn(`[RAG] extractThemes: LLM вернул меньше тем (${themes.length}) чем ожидалось (${targetThemes}) — возможна потеря coverage`);
                }
                return themes;
            }
            throw new Error('Пустой список тем');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, err);
            console.warn(`[RAG] extractThemes попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) {
                    onRetry({
                        attempt,
                        maxAttempts,
                        parsed: g,
                        message: String(err.message || ''),
                    });
                }
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }
    throwAfterGeminiRetriesFailed('extractThemes', lastError);
}

function buildBlueprintFallbackLocal(richThemes, perTheme) {
    const fallback = [];
    for (let ti = 0; ti < richThemes.length; ti++) {
        const t = richThemes[ti];
        for (let i = 0; i < perTheme[ti]; i++) {
            fallback.push({
                theme: t.topic,
                section: t.section,
                intent: `Проверить понимание: ${t.topic}`,
                type: 'multiple_choice',
            });
        }
    }
    return fallback;
}

function computeIntentsPerTheme(richThemes, totalTarget) {
    const weights = richThemes.map(t => (t.importance || 2) * (t.suggestedCount || 3));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const counts = weights.map(w => Math.max(2, Math.round((w / totalWeight) * totalTarget)));
    let diff = counts.reduce((s, n) => s + n, 0) - totalTarget;
    let idx = 0;
    let loopGuard = 0;
    while (diff > 0) {
        const i = idx % counts.length;
        if (counts[i] > 2 || loopGuard > counts.length * 2) { counts[i]--; diff--; }
        idx++;
        loopGuard++;
        if (idx > counts.length * 100) break;
    }
    idx = 0;
    while (diff < 0) { counts[idx % counts.length]++; diff++; idx++; }
    return counts;
}

async function buildQuestionBlueprint(themes, targetMin, targetMax, model = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const llmModel = config.LLM_FAST_MODEL || config.LLM_MODEL;
    const richThemes = themes.map(t => typeof t === 'string'
        ? { topic: t, section: 'Документ', importance: 2, suggestedCount: 3, difficultyCandidates: ['understand'] }
        : t
    );
    const totalTarget = Math.round((targetMin + targetMax) / 2);
    const perTheme = computeIntentsPerTheme(richThemes, totalTarget);
    const expectedCount = perTheme.reduce((s, n) => s + n, 0);
    const themesForPrompt = richThemes.map((t, i) =>
        `${i + 1}. [${t.section}] ${t.topic} → ${perTheme[i]} вопросов`
    ).join('\n');

    if (await quotaGuard.isRpdExhaustedForModel(llmModel)) {
        console.warn('[RAG] buildBlueprint: дневной лимит LLM исчерпан — локальный план без API');
        return buildBlueprintFallbackLocal(richThemes, perTheme);
    }

    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 0;
    const maxAttempts = 5;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(llmModel);
            const ai = await getAiClient();
            const genPromise = ai.models.generateContent({
                model: llmModel,
                contents: `Ты создаёшь план проверочного теста. Все вопросы — формата multiple_choice (4 варианта, 1 правильный).\n\nДля каждой темы придумай РОВНО указанное число конкретных «намерений вопроса» (question intent) — что именно нужно проверить (1–2 предложения).\n\nТемы (формат: N. [Раздел] Тема → кол-во вопросов):\n${themesForPrompt}\n\nВерни JSON массив ровно из ${expectedCount} объектов:\n[\n  {"theme":"...","section":"...","intent":"...","type":"multiple_choice"},\n  ...\n]\nНикакого другого текста.`,
                config: { temperature: 0.3, responseMimeType: 'application/json' },
            });
            const response = await withTimeout(genPromise, reqTimeout, '[RAG] buildBlueprint generateContent');
            await quotaGuard.recordGeminiCall(llmModel);
            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed
                : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

            if (list && list.length > 0) {
                const normalized = list.map(item => ({ ...item, type: 'multiple_choice' }));
                if (normalized.length < Math.floor(expectedCount * 0.8)) {
                    throw new Error(`Слишком мало intents: ${normalized.length} < ${expectedCount}`);
                }
                return normalized;
            }
            throw new Error('Пустой blueprint');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, err);
            console.warn(`[RAG] buildBlueprint попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) {
                    onRetry({
                        attempt,
                        maxAttempts,
                        parsed: g,
                        message: String(err.message || ''),
                    });
                }
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }

    throwAfterGeminiRetriesFailed('buildQuestionBlueprint', lastError);
}

/**
 * Build evidence packets for a set of retrieved chunks.
 * Uses resolveChunkEvidence so packets are never empty even without LLM summaries.
 * Each packet carries downstream_source for observability.
 */
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
        // Note source so LLM has context about evidence quality
        metaParts.push(`src=${p.downstream_source || 'unknown'}`);
        const parts = [`[Источник ${i + 1}, ${metaParts.join(' | ')}]`];
        if (p.facts.length > 0) parts.push(`Факты:\n${p.facts.map(f => `  • ${f}`).join('\n')}`);
        parts.push(`Текст:\n${p.text}`);
        return parts.join('\n');
    }).join('\n\n');
}

function buildCoverageMap(indexedChunks) {
    const map = { totalChunks: indexedChunks.length, usedChunkIds: new Set(), bySection: {} };
    for (const chunk of indexedChunks) {
        const sec = chunk.section || 'Документ';
        if (!map.bySection[sec]) map.bySection[sec] = { chunkIds: [], usedIds: new Set() };
        map.bySection[sec].chunkIds.push(chunk.id);
    }
    return map;
}

function updateCoverageMap(coverageMap, chunkIds) {
    for (const id of chunkIds) {
        coverageMap.usedChunkIds.add(id);
        for (const data of Object.values(coverageMap.bySection)) {
            if (data.chunkIds.includes(id)) { data.usedIds.add(id); break; }
        }
    }
}

function formatCoverageReport(coverageMap) {
    const used = coverageMap.usedChunkIds.size;
    const total = coverageMap.totalChunks;
    const pct = total > 0 ? Math.round(used / total * 100) : 0;
    const sections = Object.entries(coverageMap.bySection).map(([sec, data]) => {
        const sp = data.chunkIds.length > 0 ? Math.round(data.usedIds.size / data.chunkIds.length * 100) : 0;
        return `"${sec}": ${data.usedIds.size}/${data.chunkIds.length} (${sp}%)`;
    }).join(', ');
    return `${used}/${total} чанков (${pct}%) | ${sections}`;
}

module.exports = {
    hybridRetrieve, extractThemes, buildQuestionBlueprint, buildThemesAndBlueprint, buildLocalThemesFromSections, buildBlueprintFallbackLocal, computeIntentsPerTheme,
    buildEvidencePackets, formatEvidenceForPrompt,
    buildCoverageMap, updateCoverageMap, formatCoverageReport,
    cosineSimilarity, getQueryEmbedding, getBatchEmbeddings,
    resolveChunkEvidence,
};
