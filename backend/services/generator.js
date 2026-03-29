const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const runtimeConfig = require('./runtimeConfig');
const quotaGuard = require('./quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry } = require('./geminiError');
const { chunkText } = require('./chunker');
const { validateQuestions, extractJSON } = require('./validator');
const rag = require('./rag');
const { calculateQuestionBudget } = require('./budgetCalculator');
const {
    logStructured,
    evidenceReasonToCode,
    buildGenerationMetrics,
    REASON_CODES,
    DEFECT_CLASSES,
} = require('../utils/observability');
const jobProgress = require('./jobProgress');
const runRepo = require('../db/repositories/runRepo');
const PW = jobProgress.WEIGHT;

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

/**
 * Эвристика языка документа + диагностика для логов (не вызывает сеть).
 * @returns {{ lang: 'ru'|'en'|'auto', diagnostics: Record<string, number|string> }}
 */
function detectLanguageWithDiagnostics(text) {
    const fullTextLength = typeof text === 'string' ? text.length : 0;
    const sample = (text || '').slice(0, 3000);
    const cyrillicCount = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
    const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;
    const ruWords = ['и', 'в', 'на', 'что', 'это', 'для', 'не', 'по', 'как', 'из', 'при'];
    const enWords = ['the', 'and', 'is', 'in', 'to', 'of', 'for', 'with', 'that', 'on', 'are'];
    const lowerSample = sample.toLowerCase();
    const ruHits = ruWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;
    const enHits = enWords.filter(w => new RegExp(`\\b${w}\\b`, 'g').test(lowerSample)).length;

    let lang;
    let resolvedBy;
    if (cyrillicCount > latinCount * 1.5) {
        lang = 'ru';
        resolvedBy = 'cyrillic_ratio';
    } else if (latinCount > cyrillicCount * 1.5) {
        lang = 'en';
        resolvedBy = 'latin_ratio';
    } else if (ruHits > enHits) {
        lang = 'ru';
        resolvedBy = 'stopwords_ru';
    } else if (enHits > ruHits) {
        lang = 'en';
        resolvedBy = 'stopwords_en';
    } else {
        lang = 'auto';
        resolvedBy = 'undetermined';
    }

    return {
        lang,
        diagnostics: {
            full_text_length: fullTextLength,
            sample_chars: sample.length,
            cyrillic_count: cyrillicCount,
            latin_count: latinCount,
            ru_word_hits: ruHits,
            en_word_hits: enHits,
            resolved_by: resolvedBy,
        },
    };
}

function getLanguageInstruction(lang) {
    switch (lang) {
        case 'ru':
            return 'ЯЗЫК: Генерируй все вопросы, варианты ответов, объяснения и подсказки СТРОГО на русском языке.';
        case 'en':
            return 'LANGUAGE: Generate all questions, options, explanations and hints STRICTLY in English.';
        default:
            return 'ЯЗЫК / LANGUAGE: Определи язык evidence и генерируй вопросы на ТОМ ЖЕ языке, что и документ.';
    }
}

function getBatchSystemPrompt(lang = 'auto') {
    const langInstruction = getLanguageInstruction(lang);
    return `Ты — эксперт по генерации учебных тестов по документации.

Твоя задача: создать РОВНО ОДИН вопрос формата multiple_choice для каждого intent на основе предоставленного evidence.

${langInstruction}

ПРАВИЛА:
1. Каждый вопрос генерируй СТРОГО на основе evidence своего intent. НЕ ВЫДУМЫВАЙ факты вне evidence.
2. Каждый вопрос должен проверять полезное понимание документа.
3. Формат — ТОЛЬКО multiple_choice: ровно 4 варианта ответа, один правильный.
4. "correctIndex" — индекс правильного ответа (0–3).
5. Неверные варианты (дистракторы) должны быть ПРАВДОПОДОБНЫМИ, но ОДНОЗНАЧНО неверными. Не используй явно абсурдные варианты.
6. НЕ создавай два почти одинаковых вопроса — проверяй разные аспекты документа.
7. "hint" — подсказка в 1 предложение, которая направляет к ответу, но НЕ раскрывает его.
8. "explanation" — 1–2 предложения, объясняющих правильный ответ с опорой на evidence.
9. "difficulty" — уровень Bloom's Taxonomy из intent: "remember", "understand", "apply" или "analyze".
   - remember: вопрос на запоминание конкретного факта
   - understand: вопрос на понимание концепции/процесса
   - apply: вопрос на применение знания к ситуации
   - analyze: вопрос на сравнение, причинно-следственные связи, выводы
10. "sourceChunkId" — chunk_id из evidence этого вопроса (число).
11. Если evidence НЕДОСТАТОЧЕН для создания качественного вопроса (слишком общий, неконкретный, или нет фактов) — верни для этого intent объект: {"skipped": true, "reason": "краткое объяснение"}.

ФОРМАТ ОТВЕТА — строго JSON массив (столько объектов, сколько intents):
[
  {"type":"multiple_choice","question":"...?","options":["A","B","C","D"],"correctIndex":0,"explanation":"...","hint":"...","sourceChunkId":1,"difficulty":"understand"},
  {"skipped":true,"reason":"Evidence не содержит конкретных фактов для вопроса"}
]

ВАЖНО: Отвечай ТОЛЬКО JSON массивом. Никакого другого текста.`;
}

const GROUNDING_SYSTEM = `Ты проверяешь качество тестового вопроса формата multiple_choice.
Проверь:
1. correct_answer (correctIndex) полностью подтверждается evidence
2. explanation опирается на evidence
3. Все 4 варианта ответа логичны (дистракторы правдоподобны, но неверны)
4. Вопрос не выходит за рамки evidence
Верни JSON: {"grounded": true|false, "reason": "краткое объяснение"}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

/**
 * Валидные multiple_choice без вызова LLM (дневная квота generateContent исчерпана).
 * Правильный вариант — из выжимки или предложения чанка; остальные — из других чанков.
 */
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

function buildBatchPrompt(intents, evidenceList, maxEvidenceChars = 2500) {
    const lines = [`Создай ${intents.length} вопрос(а/ов) формата multiple_choice — по одному на каждый intent.\n`];
    for (let i = 0; i < intents.length; i++) {
        const intent = intents[i];
        let evidence = evidenceList[i] || '';
        if (evidence.length > maxEvidenceChars) {
            evidence = evidence.substring(0, maxEvidenceChars) + '…';
        }
        lines.push(`=== Intent ${i + 1} ===`);
        lines.push(`Тема: "${intent.theme}"`);
        lines.push(`Намерение: "${intent.intent}"`);
        lines.push(`Тип: multiple_choice`);
        lines.push(`Bloom-уровень: ${intent.difficulty || 'understand'}`);
        lines.push(`Evidence:\n${evidence}`);
        lines.push('');
    }
    return lines.join('\n');
}

function normalizeQuestion(q, chunkIds = []) {
    const normalized = { ...q };
    if (normalized.correctIndex == null && normalized.correct_answer != null) {
        normalized.correctIndex = normalized.correct_answer;
    }
    if (normalized.correctIndex != null) {
        normalized.correct_answer = normalized.correctIndex;
    }
    normalized.type = 'multiple_choice';
    if (!BLOOM_LEVELS.includes(normalized.difficulty)) {
        const mapping = { easy: 'remember', medium: 'understand', hard: 'analyze' };
        normalized.difficulty = mapping[normalized.difficulty] || 'understand';
    }
    if (!normalized.sources || !Array.isArray(normalized.sources) || normalized.sources.length === 0) {
        const srcId = normalized.sourceChunkId;
        if (srcId != null) {
            normalized.sources = [{ chunk_id: srcId, quote: '' }];
        } else {
            normalized.sources = chunkIds.map(id => ({ chunk_id: id, quote: '' }));
        }
    }
    return normalized;
}

async function generateBatchQuestions(intents, evidenceList, chunkIdsList, retries = null, model = null, lang = 'auto') {
    retries = retries || config.LLM_MAX_RETRIES;
    const llmModel = model || config.LLM_MODEL;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(llmModel);
            const userPrompt = buildBatchPrompt(intents, evidenceList);
            const ai = await getAiClient();
            const response = await ai.models.generateContent({
                model: llmModel,
                contents: userPrompt,
                config: {
                    systemInstruction: getBatchSystemPrompt(lang),
                    temperature: 0.7,
                    responseMimeType: 'application/json',
                },
            });
            await quotaGuard.recordGeminiCall(llmModel);

            const content = response.text;
            if (!content) throw new Error('Пустой ответ от LLM');

            let parsed = extractJSON(content);
            if (!Array.isArray(parsed)) parsed = [parsed];

            const results = [];
            let llmSkipped = 0;
            let validationFailed = 0;
            const limit = Math.min(parsed.length, intents.length);

            for (let i = 0; i < limit; i++) {
                if (parsed[i] && parsed[i].skipped === true) {
                    console.log(`[GENERATOR] Batch: intent[${i + 1}] пропущен LLM — ${parsed[i].reason || 'недостаточный evidence'}`);
                    llmSkipped++;
                    continue;
                }
                try {
                    const normalized = normalizeQuestion(parsed[i], chunkIdsList[i] || []);
                    const [validated] = validateQuestions([normalized]);
                    results.push({ question: { ...validated, sources: normalized.sources }, intentIdx: i });
                } catch (e) {
                    validationFailed++;
                    console.warn(`[GENERATOR] Batch: вопрос ${i + 1}/${limit} невалиден — ${e.message}`);
                }
            }

            if (results.length > 0) return { results, stats: { llmSkipped, validationFailed } };
            throw new Error('Ни один вопрос в batch не прошёл валидацию');
        } catch (error) {
            lastError = error;
            if (error.type === 'QUOTA_EXCEEDED') {
                console.warn(`[GENERATOR] Batch: лимит free tier — ${error.message}`);
                break;
            }
            const g = parseGeminiApiError(error);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, error);
            if (attempt < retries && !g.isDailyFreeTierQuota) {
                await sleepForGeminiRetry(g, attempt, retries, sleep);
            }
        }
    }

    console.error(`[GENERATOR] Batch пропущен: ${lastError.message}`);
    return { results: [], stats: { llmSkipped: 0, validationFailed: 0 } };
}

async function checkGrounding(question, evidenceText, model = null) {
    const llmModel = model || config.LLM_MODEL;
    try {
        const correctOption = Array.isArray(question.options) && question.correctIndex != null
            ? question.options[question.correctIndex]
            : JSON.stringify(question.correctIndex);
        const prompt = `Вопрос: ${question.question}\nПравильный ответ: ${correctOption}\nОбъяснение: ${question.explanation}\n\nEvidence:\n${evidenceText}`;
        await quotaGuard.assertWithinFreeTierQuota(llmModel);
        const ai = await getAiClient();
        const response = await ai.models.generateContent({
            model: llmModel,
            contents: prompt,
            config: {
                systemInstruction: GROUNDING_SYSTEM,
                temperature: 0.0,
                responseMimeType: 'application/json',
            },
        });
        await quotaGuard.recordGeminiCall(llmModel);
        const parsed = extractJSON(response.text);
        return parsed.grounded !== false;
    } catch {
        return true;
    }
}

async function semanticDedup(questions, threshold = 0.88) {
    if (questions.length === 0) return questions;
    const embeddings = [];
    for (const q of questions) {
        try {
            const emb = await rag.getQueryEmbedding(q.question);
            embeddings.push(emb);
        } catch {
            embeddings.push(null);
        }
        await sleep(200);
    }

    const unique = [];
    const usedIdx = new Set();

    for (let i = 0; i < questions.length; i++) {
        if (usedIdx.has(i)) continue;
        let isDup = false;
        for (let j = 0; j < unique.length; j++) {
            const prevIdx = unique[j]._origIdx;
            if (embeddings[i] && embeddings[prevIdx]) {
                const sim = rag.cosineSimilarity(embeddings[i], embeddings[prevIdx]);
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

function createBackfillIntents(poolChunks, count, typeOffset = 0) {
    const intents = [];
    for (let i = 0; i < count; i++) {
        const chunk = poolChunks[i % poolChunks.length];
        let intentText;
        if (Array.isArray(chunk.summary) && chunk.summary.length > 0) {
            const factIdx = Math.floor(i / poolChunks.length) % chunk.summary.length;
            intentText = `Проверить знание факта: "${chunk.summary[factIdx]}"`;
        } else if (chunk.section && chunk.section !== 'Документ') {
            intentText = `Проверить ключевые понятия раздела "${chunk.section}"`;
        } else {
            intentText = `Проверить понимание фрагмента документа (чанк ${chunk.chunk_index + 1})`;
        }
        intents.push({
            theme: chunk.section || 'Документ',
            section: chunk.section || 'Документ',
            intent: intentText,
            type: 'multiple_choice',
            _chunkRef: chunk,
        });
    }
    return intents;
}

// Fallback decisions imported from observability
function applyFallbackDecisions(stats, ctx) {
    const { retrievalPassed, retrievalSkipped, finalCount, blueprintIntents } = stats;
    if (finalCount === 0 && blueprintIntents > 0) {
        logStructured({
            level: 'error',
            traceId: ctx.traceId,
            documentId: ctx.documentId,
            phase: 'finalize',
            event: 'zero_questions_generated',
            reasonCode: REASON_CODES.ERR_WEAK_EVIDENCE,
            defectClass: DEFECT_CLASSES.RETRIEVAL_MISS,
            metrics: { retrieval_passed: retrievalPassed, retrieval_skipped: retrievalSkipped },
        });
        return 'zero_output';
    }
    return null;
}

async function generateTest(fullText, docName, indexedChunks, onProgress, opts = {}) {
    const startTime = Date.now();
    const model = opts.model || config.LLM_MODEL;
    const traceId = opts.traceId || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const documentId = opts.documentId != null ? opts.documentId : null;

    const progress = (p) => {
        if (typeof onProgress === 'function') onProgress(p);
    };

    // Create generation_run record
    let runId = null;
    const { lang: detectedLang, diagnostics: langDiagnostics } = detectLanguageWithDiagnostics(fullText);

    if (!indexedChunks || indexedChunks.length === 0) {
        const chunks = chunkText(fullText);
        indexedChunks = chunks.map((c, i) => ({
            id: i + 1,
            chunk_index: c.index,
            text: c.text,
            token_count: c.tokens,
            page: c.page ?? null,
            section: c.section ?? null,
            heading: c.heading ?? null,
            embedding: null,
            summary: [],
        }));
    }

    const budgetPlan = calculateQuestionBudget(fullText, indexedChunks, {
        extractionQuality: opts.extractionQuality,
        questionTypes: ['multiple_choice'],
    });

    const targetCount = budgetPlan.targetCount;
    const targetMin = config.TARGET_QUESTIONS_MIN || 20;
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;

    try {
        const runRow = await runRepo.insertRun({
            document_id: documentId,
            status: 'running',
            model,
            target_min: targetMin,
            target_max: targetMax,
            target_count: targetCount,
            language: detectedLang,
            budget_metrics: budgetPlan.metrics,
        });
        runId = runRow.id;
    } catch (e) {
        console.warn(`[GENERATOR] Could not create generation_run: ${e.message}`);
    }

    logStructured({
        level: 'info', traceId, documentId,
        phase: 'generate', event: 'generation_start',
        metrics: { model, run_id: runId },
    });

    console.log(`[GENERATOR] Определён язык документа: ${detectedLang} (${langDiagnostics.resolved_by})`);
    progress({ phase: 'generate', stage: 'language', workDelta: PW.GEN_LANG, detail: `Язык: ${detectedLang}` });

    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'document_language_detected',
        metrics: {
            lang: detectedLang,
            indexed_chunk_count: indexedChunks.length,
            full_text_length: langDiagnostics.full_text_length,
            sample_chars: langDiagnostics.sample_chars,
            cyrillic_count: langDiagnostics.cyrillic_count,
            latin_count: langDiagnostics.latin_count,
            ru_word_hits: langDiagnostics.ru_word_hits,
            en_word_hits: langDiagnostics.en_word_hits,
        },
        metadata: { resolved_by: String(langDiagnostics.resolved_by) },
    });

    budgetPlan.logs.forEach(l => console.log(`[BUDGET] ${l}`));
    if (budgetPlan.reductionReasons.length > 0) {
        console.log(`[BUDGET] Урезание объёма: ${budgetPlan.reductionReasons.join(' | ')}`);
    }

    const atomicFactsExtracted = indexedChunks.reduce((s, c) => s + (Array.isArray(c.summary) ? c.summary.length : 0), 0);
    const chunksWithFacts = indexedChunks.filter(c => Array.isArray(c.summary) && c.summary.length > 0).length;

    logStructured({
        level: 'info', traceId, documentId,
        phase: 'generate', event: 'budget_calculated',
        metrics: {
            budget_target: targetCount, target_min: targetMin, target_max: targetMax,
            chunk_count: indexedChunks.length, atomic_facts_extracted: atomicFactsExtracted,
            chunks_with_facts: chunksWithFacts,
        },
        metadata: budgetPlan.reductionReasons.length ? { reduction_reasons: budgetPlan.reductionReasons } : undefined,
    });

    console.log(`[GENERATOR] Цель (config: ${targetMin}–${targetMax}): выбран ${targetCount}, чанков: ${indexedChunks.length}, модель: ${model}`);

    const llmRpdExhausted = await quotaGuard.isRpdExhaustedForModel(model);
    if (llmRpdExhausted) {
        console.warn('[GENERATOR] Дневной лимит generateContent исчерпан — тест из чанков/выжимок без новых вызовов LLM');
        progress({
            phase: 'generate',
            stage: 'quota_offline',
            detail: 'Квота LLM на сутки исчерпана — вопросы из текста и сохранённых выжимок',
        });

        const themes = [{
            topic: 'Содержание документа',
            section: 'Документ',
            importance: 2,
            suggestedCount: Math.min(5, Math.max(3, Math.ceil(Math.max(1, targetCount) / 2))),
            difficultyCandidates: ['remember', 'understand'],
        }];
        progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: `Тем: ${themes.length} (режим без LLM)` });

        const blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, model);
        progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT, detail: `План: ${blueprint.length} intent-ов (без LLM)` });

        if (runId) {
            try {
                await runRepo.insertIntents(runId, blueprint);
            } catch (e) {
                console.warn(`[GENERATOR] Could not persist intents: ${e.message}`);
            }
        }

        let validatedOffline = [];
        try {
            validatedOffline = buildOfflineMcqFromChunks(fullText, indexedChunks, targetMin, targetMax);
        } catch (e) {
            console.error(`[GENERATOR] Офлайн-сборка вопросов: ${e.message}`);
        }

        const finalQuestions = validatedOffline.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
        const durationMs = Date.now() - startTime;
        progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY, detail: `Готово: ${finalQuestions.length} вопросов (без LLM)` });

        const generationMetrics = buildGenerationMetrics({
            traceId,
            sessionId: opts.sessionId,
            documentId,
            model,
            durationMs,
            targetCount,
            targetMin,
            targetMax,
            blueprintIntents: blueprint.length,
            parseQualityScore: opts.extractionQuality,
            chunkCount: indexedChunks.length,
            chunksWithFacts,
            atomicFactsExtracted,
            retrievalPassed: 0,
            retrievalSkipped: 0,
            groundingAccepted: finalQuestions.length,
            groundingFailed: 0,
            batchValidated: 0,
            llmSkipped: blueprint.length,
            validationFailed: 0,
            preDedupCount: finalQuestions.length,
            postDedupCount: finalQuestions.length,
            finalCount: finalQuestions.length,
            backfillRounds: 0,
            backfillQuestionsAdded: 0,
            evidenceScores: [],
            quotaOffline: true,
        });

        const fallbackDecision = applyFallbackDecisions({
            retrievalPassed: 0,
            retrievalSkipped: 0,
            finalCount: finalQuestions.length,
            blueprintIntents: blueprint.length,
            preDedupCount: finalQuestions.length,
            postDedupCount: finalQuestions.length,
        }, { traceId, documentId });

        if (runId) {
            try {
                for (let i = 0; i < finalQuestions.length; i++) {
                    const q = finalQuestions[i];
                    const qRow = await runRepo.insertQuestion(runId, i, q);
                    if (q.sources && q.sources.length > 0) {
                        await runRepo.insertQuestionSources(qRow.id, q.sources);
                    }
                }
                await runRepo.updateRunFinished(runId, {
                    status: 'completed',
                    final_metrics: generationMetrics,
                    fallback_decisions: {
                        decision: fallbackDecision,
                        quota_offline: true,
                    },
                    duration_ms: durationMs,
                });
            } catch (e) {
                console.warn(`[GENERATOR] Could not persist run results: ${e.message}`);
            }
        }

        logStructured({
            level: 'warn',
            traceId,
            sessionId: opts.sessionId,
            documentId,
            testId: null,
            phase: 'finalize',
            event: 'generation_quota_offline',
            metrics: {
                duration_ms: durationMs,
                final_question_count: finalQuestions.length,
                run_id: runId,
            },
        });

        const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
        return {
            title: `Тест по документу: ${cleanName} (без LLM — квота)`,
            questions: finalQuestions,
            generationMetrics,
            runId,
        };
    }

    console.log('[GENERATOR] Извлечение тем из summaries чанков...');
    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_begin',
        metadata: { step: 'extract_themes', model },
    });
    let themes;
    try {
        themes = await rag.extractThemes(indexedChunks, fullText, model, targetCount);
    } catch (err) {
        logStructured({
            level: 'error',
            traceId,
            documentId,
            phase: 'generate',
            event: 'generate_phase_failed',
            defectClass: DEFECT_CLASSES.SYSTEM_ERROR,
            metadata: {
                step: 'extract_themes',
                error_message: err && err.message ? String(err.message).slice(0, 500) : 'unknown',
            },
        });
        throw err;
    }
    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_end',
        metrics: { theme_count: themes.length },
        metadata: { step: 'extract_themes' },
    });
    console.log(`[GENERATOR] Тем: ${themes.length}`, themes.map(t => `[${t.section}] ${t.topic || t}`).join(', '));
    progress({ phase: 'generate', stage: 'themes', workDelta: PW.GEN_THEMES, detail: `Тем извлечено: ${themes.length}` });

    console.log('[GENERATOR] Построение blueprint...');
    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_begin',
        metadata: { step: 'build_blueprint', model },
    });
    let blueprint;
    try {
        blueprint = await rag.buildQuestionBlueprint(themes, targetCount, targetCount, model);
    } catch (err) {
        logStructured({
            level: 'error',
            traceId,
            documentId,
            phase: 'generate',
            event: 'generate_phase_failed',
            defectClass: DEFECT_CLASSES.SYSTEM_ERROR,
            metadata: {
                step: 'build_blueprint',
                error_message: err && err.message ? String(err.message).slice(0, 500) : 'unknown',
            },
        });
        throw err;
    }
    logStructured({
        level: 'info',
        traceId,
        documentId,
        phase: 'generate',
        event: 'generate_phase_end',
        metrics: { blueprint_intent_count: blueprint.length },
        metadata: { step: 'build_blueprint' },
    });
    console.log(`[GENERATOR] Blueprint: ${blueprint.length} intent-ов`);
    progress({ phase: 'generate', stage: 'blueprint', workDelta: PW.GEN_BLUEPRINT, detail: `План: ${blueprint.length} intent-ов` });

    // Persist intents
    if (runId) {
        try { await runRepo.insertIntents(runId, blueprint); } catch (e) {
            console.warn(`[GENERATOR] Could not persist intents: ${e.message}`);
        }
    }

    const topK = config.RAG_TOP_K || 5;
    const batchSize = Math.max(3, Math.min(5, config.LLM_BATCH_SIZE || 4));
    const allQuestions = [];
    const enableGrounding = config.ENABLE_GROUNDING !== false;

    const blueprintWithDifficulty = assignDifficulties(blueprint);
    const coverageMap = rag.buildCoverageMap(indexedChunks);

    let statsValidated = 0;
    let statsSkippedEvidence = 0;
    let statsSkippedLLM = 0;
    let statsValidationFailed = 0;
    let statsGroundingFailed = 0;
    let statsRetrievalPassed = 0;
    const evidenceScores = [];

    const totalBatches = Math.ceil(blueprintWithDifficulty.length / batchSize);
    console.log(`[GENERATOR] Batch-режим: ${blueprintWithDifficulty.length} intents → ${totalBatches} batch(ей) по ≤${batchSize}`);

    if (opts.traceId) {
        jobProgress.refineMainBatchPlan(String(opts.traceId), totalBatches);
    }

    for (let batchStart = 0; batchStart < blueprintWithDifficulty.length; batchStart += batchSize) {
        const batch = blueprintWithDifficulty.slice(batchStart, batchStart + batchSize);
        const batchNum = Math.floor(batchStart / batchSize) + 1;
        console.log(`[GENERATOR] Batch ${batchNum}/${totalBatches}: ${batch.length} intents`);

        const filteredBatch = [];
        const evidenceList = [];
        const chunkIdsList = [];

        for (const intent of batch) {
            const relevantChunks = await rag.hybridRetrieve(
                `${intent.theme}: ${intent.intent}`,
                indexedChunks, topK
            );
            const packets = rag.buildEvidencePackets(relevantChunks, intent.intent);
            const evidenceText = rag.formatEvidenceForPrompt(packets);
            const ids = relevantChunks.map(c => c.id);

            const quality = scoreEvidenceQuality(evidenceText, intent.intent);
            evidenceScores.push(quality.score);
            if (quality.score < 0.3) {
                console.log(`[GENERATOR] Soft-skip intent "${intent.intent.slice(0, 60)}…" — ${quality.reason}`);
                statsSkippedEvidence++;
                logStructured({
                    level: 'warn', traceId, documentId,
                    phase: 'generate', event: 'intent_skipped_weak_evidence',
                    reasonCode: evidenceReasonToCode(quality.reason),
                    defectClass: DEFECT_CLASSES.RETRIEVAL_MISS,
                    metrics: { evidence_score: quality.score },
                    metadata: { intent_preview: intent.intent.slice(0, 120), reason: quality.reason },
                });
                continue;
            }

            statsRetrievalPassed++;
            filteredBatch.push(intent);
            evidenceList.push(evidenceText);
            chunkIdsList.push(ids);
            rag.updateCoverageMap(coverageMap, ids);
        }

        if (filteredBatch.length === 0) {
            console.warn(`[GENERATOR] Batch ${batchNum}: все intents пропущены (weak evidence)`);
            continue;
        }

        const { results: batchResults, stats: batchStats } = await generateBatchQuestions(
            filteredBatch, evidenceList, chunkIdsList, null, model, detectedLang,
        );
        statsValidated += batchResults.length;
        statsSkippedLLM += batchStats.llmSkipped;
        statsValidationFailed += batchStats.validationFailed;

        for (const { question, intentIdx } of batchResults) {
            if (enableGrounding) {
                const grounded = await checkGrounding(question, evidenceList[intentIdx], model);
                if (!grounded) {
                    statsGroundingFailed++;
                    console.warn(`[GENERATOR] Batch ${batchNum}, intent[${intentIdx + 1}]: не прошёл groundedness`);
                    continue;
                }
            }
            allQuestions.push(question);
        }

        progress({
            phase: 'generate', stage: 'llm_batch', workDelta: PW.GEN_BATCH,
            detail: `Генерация вопросов: пакет ${batchNum}/${totalBatches} (накоплено ${allQuestions.length})`,
        });

        if (batchStart + batchSize < blueprintWithDifficulty.length) await sleep(1200);
    }

    console.log(`[GENERATOR] Покрытие: ${rag.formatCoverageReport(coverageMap)}`);
    console.log(`[GENERATOR] Статистика: blueprint=${blueprintWithDifficulty.length}, skipped_evidence=${statsSkippedEvidence}, validated=${statsValidated}, grounded=${allQuestions.length}, target=${targetMin}`);

    const preDedupCount = allQuestions.length;
    const groundedPreDedup = allQuestions.length;

    console.log('[GENERATOR] Семантическая дедупликация...');
    const initialDedup = await semanticDedup(allQuestions, config.DEDUP_THRESHOLD || 0.88);
    console.log(`[GENERATOR] После дедупликации: ${initialDedup.length} (было ${allQuestions.length})`);

    const dedupDropped = preDedupCount - initialDedup.length;
    if (dedupDropped > 0) {
        logStructured({
            level: 'info', traceId, documentId,
            phase: 'dedup', event: 'dedup_complete',
            metrics: { pre_dedup: preDedupCount, post_dedup: initialDedup.length, dedup_dropped: dedupDropped },
        });
    }
    progress({ phase: 'generate', stage: 'dedup', workDelta: PW.GEN_DEDUP, detail: `После дедупликации: ${initialDedup.length} вопросов` });

    // ── Backfill ──
    const maxBackfillRounds = config.BACKFILL_MAX_ROUNDS || 3;
    let workingQuestions = [...initialDedup];
    let backfillRoundsUsed = 0;
    let backfillQuestionsAdded = 0;
    let backfillGroundedAccepted = 0;

    for (let round = 1; round <= maxBackfillRounds && workingQuestions.length < targetMin; round++) {
        backfillRoundsUsed = round;
        const gap = targetMin - workingQuestions.length;
        const uncoveredChunks = indexedChunks.filter(c => !coverageMap.usedChunkIds.has(c.id));
        const poolChunks = uncoveredChunks.length > 0 ? uncoveredChunks : indexedChunks;

        console.log(`[GENERATOR] Backfill round ${round}/${maxBackfillRounds}: gap=${gap}, непокрытых чанков: ${uncoveredChunks.length}/${indexedChunks.length}`);
        progress({ phase: 'generate', stage: 'backfill', detail: `Добор вопросов: раунд ${round}/${maxBackfillRounds}, сейчас ${workingQuestions.length}` });

        const intentsNeeded = Math.min(gap * 2, poolChunks.length * 3, 20);
        if (intentsNeeded === 0) { console.warn('[GENERATOR] Backfill: нет доступных чанков'); break; }

        const backfillIntents = createBackfillIntents(poolChunks, intentsNeeded, workingQuestions.length);
        const backfillWithDiff = assignDifficulties(backfillIntents);
        const newRawQuestions = [];
        const totalBackfillBatches = Math.ceil(backfillWithDiff.length / batchSize);

        for (let bs = 0; bs < backfillWithDiff.length; bs += batchSize) {
            const batchIntents = backfillWithDiff.slice(bs, bs + batchSize);
            const bNum = Math.floor(bs / batchSize) + 1;
            const bfEvidenceList = [];
            const bfChunkIdsList = [];
            const bfFilteredBatch = [];

            for (const intent of batchIntents) {
                const chunkRef = intent._chunkRef;
                const packets = rag.buildEvidencePackets([chunkRef], intent.intent);
                const evidenceText = rag.formatEvidenceForPrompt(packets);
                const quality = scoreEvidenceQuality(evidenceText, intent.intent);
                if (quality.score < 0.3) { statsSkippedEvidence++; continue; }
                bfFilteredBatch.push(intent);
                bfEvidenceList.push(evidenceText);
                bfChunkIdsList.push([chunkRef.id]);
                rag.updateCoverageMap(coverageMap, [chunkRef.id]);
            }

            if (bfFilteredBatch.length === 0) continue;

            const { results: batchResults, stats: bfStats } = await generateBatchQuestions(
                bfFilteredBatch, bfEvidenceList, bfChunkIdsList, null, model, detectedLang,
            );
            statsSkippedLLM += bfStats.llmSkipped;
            statsValidationFailed += bfStats.validationFailed;

            for (const { question, intentIdx } of batchResults) {
                if (enableGrounding) {
                    const grounded = await checkGrounding(question, bfEvidenceList[intentIdx], model);
                    if (!grounded) { statsGroundingFailed++; continue; }
                }
                newRawQuestions.push(question);
                backfillGroundedAccepted++;
            }

            progress({
                phase: 'generate', stage: 'backfill_batch', workDelta: PW.GEN_BATCH,
                detail: `Добор: раунд ${round}, пакет ${bNum}/${totalBackfillBatches}`,
            });
            if (bs + batchSize < backfillWithDiff.length) await sleep(1200);
        }

        if (newRawQuestions.length === 0) { console.warn(`[GENERATOR] Backfill round ${round}: нет новых вопросов`); break; }

        const dedupedNew = newRawQuestions.length > 1
            ? await semanticDedup(newRawQuestions, config.DEDUP_THRESHOLD || 0.88)
            : newRawQuestions;

        const filtered = dedupedNew.filter(q =>
            !workingQuestions.some(existing =>
                levenshteinSimilarity(q.question.toLowerCase(), existing.question.toLowerCase()) > 0.8
            )
        );

        console.log(`[GENERATOR] Backfill round ${round}: получено=${newRawQuestions.length}, dedup=${dedupedNew.length}, уникальных=${filtered.length}`);
        backfillQuestionsAdded += filtered.length;
        logStructured({
            level: 'info', traceId, documentId,
            phase: 'backfill', event: 'backfill_round_complete',
            metrics: { round, new_questions: filtered.length, total_now: workingQuestions.length + filtered.length },
        });
        workingQuestions = [...workingQuestions, ...filtered];
    }

    progress({ phase: 'generate', stage: 'finalize', workDelta: PW.GEN_FINALIZE, detail: 'Финализация списка вопросов…' });
    const finalQuestions = workingQuestions.slice(0, targetMax).map((q, i) => ({ ...q, id: i + 1 }));
    progress({ phase: 'generate', stage: 'ready', workDelta: PW.GEN_READY, detail: `Готово к сохранению: ${finalQuestions.length} вопросов` });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const durationMs = Date.now() - startTime;
    console.log(
        `[GENERATOR] Итог → запрошено: ${targetMin}–${targetMax} | blueprint: ${blueprintWithDifficulty.length} | ` +
        `skipped(evidence): ${statsSkippedEvidence} | validated: ${statsValidated} | grounded: ${allQuestions.length} | ` +
        `после dedup: ${initialDedup.length} | финальных: ${finalQuestions.length} | время: ${elapsed}s`
    );

    const fallbackDecision = applyFallbackDecisions({
        retrievalPassed: statsRetrievalPassed,
        retrievalSkipped: statsSkippedEvidence,
        finalCount: finalQuestions.length,
        blueprintIntents: blueprintWithDifficulty.length,
        preDedupCount,
        postDedupCount: initialDedup.length,
    }, { traceId, documentId });

    const generationMetrics = buildGenerationMetrics({
        traceId, sessionId: opts.sessionId, documentId, model, durationMs,
        targetCount, targetMin, targetMax,
        blueprintIntents: blueprintWithDifficulty.length,
        parseQualityScore: opts.extractionQuality,
        chunkCount: indexedChunks.length, chunksWithFacts, atomicFactsExtracted,
        retrievalPassed: statsRetrievalPassed, retrievalSkipped: statsSkippedEvidence,
        groundingAccepted: groundedPreDedup + backfillGroundedAccepted, groundingFailed: statsGroundingFailed,
        batchValidated: statsValidated, llmSkipped: statsSkippedLLM, validationFailed: statsValidationFailed,
        preDedupCount, postDedupCount: initialDedup.length, finalCount: finalQuestions.length,
        backfillRounds: backfillRoundsUsed, backfillQuestionsAdded, evidenceScores,
    });

    // Persist questions and update run
    if (runId) {
        try {
            for (let i = 0; i < finalQuestions.length; i++) {
                const q = finalQuestions[i];
                const qRow = await runRepo.insertQuestion(runId, i, q);
                if (q.sources && q.sources.length > 0) {
                    await runRepo.insertQuestionSources(qRow.id, q.sources);
                }
            }
            await runRepo.updateRunFinished(runId, {
                status: 'completed',
                final_metrics: generationMetrics,
                fallback_decisions: fallbackDecision ? { decision: fallbackDecision } : null,
                duration_ms: durationMs,
            });
        } catch (e) {
            console.warn(`[GENERATOR] Could not persist run results: ${e.message}`);
        }
    }

    logStructured({
        level: generationMetrics.low_confidence ? 'warn' : 'info',
        traceId, sessionId: opts.sessionId, documentId, testId: null,
        phase: 'finalize',
        event: generationMetrics.low_confidence ? 'generation_low_confidence' : 'generation_complete',
        defectClass: generationMetrics.low_confidence ? DEFECT_CLASSES.VALIDATION_FAIL : null,
        fallbackTriggered: fallbackDecision || null,
        metrics: {
            duration_ms: durationMs,
            final_question_count: generationMetrics.final_question_count,
            final_quality_score: generationMetrics.final_quality_score,
            run_id: runId,
        },
    });

    const cleanName = docName.replace(/\.(pdf|docx?)$/i, '');
    return {
        title: `Тест по документу: ${cleanName}`,
        questions: finalQuestions,
        generationMetrics,
        runId,
    };
}

module.exports = { generateTest, detectLanguage, scoreEvidenceQuality, BLOOM_LEVELS };
