const { GoogleGenAI } = require('@google/genai');
const config = require('../../config');
const runtimeConfig = require('../runtimeConfig');
const quotaGuard = require('../quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry } = require('../geminiError');
const { validateQuestions, extractJSON } = require('../validator');
const { getBatchSystemPrompt, GROUNDING_SYSTEM } = require('../llm/prompts');
const { resolveChunkEvidence } = require('../rag/evidenceBuilder');
const routingService = require('./routingService');
const { STAGE_KEYS } = require('../../config/stageTaxonomy');
const { getMaxQualityLlmChainForStage } = require('../../config/routingModes');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];


function buildBatchPrompt(intents, evidenceList) {
    const lines = [`Создай ${intents.length} вопрос(а/ов) формата multiple_choice — по одному на каждый intent.\n`];
    // Увеличен контекст: прежние 1500 символов при batch≥3 давали LLM <15% исходного чанка.
    // Теперь передаём достаточно текста для формирования точных дистракторов.
    let maxEvidenceChars;
    if (intents.length === 1) maxEvidenceChars = 7000;
    else if (intents.length === 2) maxEvidenceChars = 5000;
    else maxEvidenceChars = 4000;
    
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

async function generateBatchQuestions(intents, evidenceList, chunkIdsList, retries = null, model = null, lang = 'auto', routeOpts = null) {
    retries = retries || config.LLM_MAX_RETRIES;
    let llmModel = model || config.LLM_MODEL;
    let lastError;

    if (routeOpts && routeOpts.profile && routeOpts.stage) {
        try {
            // Оцениваем размер в токенах приблизительно (1 символ ~ 0.3 токена)
            const estChars = JSON.stringify(intents).length + evidenceList.reduce((acc, text) => acc + text.length, 0);
            const estimatedTokens = Math.ceil(estChars * 0.3);
            
            const route = await routingService.resolveRoute(routeOpts.profile, routeOpts.stage, { estimatedTokens });
            if (route.skipStage) {
                console.log(`[GENERATOR] Stage ${routeOpts.stage} skipped by Tariff Routing.`);
                return { results: [], stats: { llmSkipped: intents.length, validationFailed: 0 } };
            }
            llmModel = route.resolved_model;
            console.log(`[GENERATOR] Router resolved ${llmModel} for stage ${routeOpts.stage}`);
        } catch (e) {
            console.error(`[GENERATOR] Routing error: ${e.message}`);
            // Если FAIL_FAST, кидаем ошибку сразу
            throw e;
        }
    }

    const quotaOpts = routeOpts?.bypassLimits ? { bypassLimits: true } : {};

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await quotaGuard.assertWithinFreeTierQuota(llmModel, quotaOpts);
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
                break; // Не пробуем дальше тот же самый модель. fallback отдает router заранее!
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

function formatGeminiErr(err) {
    if (!err) return 'unknown';
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    try {
        return JSON.stringify(err.error || err);
    } catch {
        return String(err);
    }
}

function buildGroundingModelChain(primary, routeOpts) {
    const seen = new Set();
    const chain = [];
    const add = (id) => {
        const m = String(id || '').trim();
        if (m && !seen.has(m)) {
            seen.add(m);
            chain.push(m);
        }
    };

    if (routeOpts?.bypassLimits) {
        for (const m of getMaxQualityLlmChainForStage(STAGE_KEYS.grounding_validation)) add(m);
        add(primary);
    } else {
        add(primary);
        const fb = config.LLM_FALLBACK_CHAIN?.[primary] || [];
        for (const m of fb) add(m);
        add('gemini-2.5-flash');
    }

    return chain.length ? chain : [primary || config.LLM_MODEL];
}

async function callGroundingOnce(questions, prompt, llmModel, quotaOpts) {
    await quotaGuard.assertWithinFreeTierQuota(llmModel, quotaOpts);
    const ai = await getAiClient();
    const response = await ai.models.generateContent({
        model: llmModel,
        contents: prompt,
        config: {
            systemInstruction: GROUNDING_SYSTEM || 'Ты оцениваешь корректность вопросов по тексту. Отвечай только строгим JSON массивом.',
            temperature: 0.0,
            responseMimeType: 'application/json',
        },
    });
    await quotaGuard.recordGeminiCall(llmModel, quotaOpts);
    const parsed = extractJSON(response.text);
    if (!Array.isArray(parsed) || parsed.length !== questions.length) {
        return null;
    }
    return parsed.map(v => v !== false);
}

async function checkGroundingBatched(questions, evidences, model = null, routeOpts = null) {
    if (questions.length === 0) return [];
    let llmModel = model || config.LLM_MODEL;

    if (routeOpts && routeOpts.profile) {
        try {
            const route = await routingService.resolveRoute(routeOpts.profile, 'grounding_validation');
            if (route.skipStage) return new Array(questions.length).fill(true);
            llmModel = route.resolved_model;
        } catch (e) {
            console.error(`[GENERATOR] Grounding router error: ${e.message}`);
            return new Array(questions.length).fill(true);
        }
    }

    const payload = questions.map((q, i) => {
        const correctOption = Array.isArray(q.options) && q.correctIndex != null
            ? q.options[q.correctIndex]
            : JSON.stringify(q.correctIndex);
        return `Вопрос ${i + 1}:\nQ: ${q.question}\nA: ${correctOption}\nExpl: ${q.explanation || ''}\nEvidence: ${evidences[i] || 'Нет текста'}\n`;
    }).join('\n---\n');

    const prompt = `Проверь фактологическую точность нескольких вопросов на основе их текстов (Evidence).\nДля каждого вопроса верни 'true', если ответ полностью подтверждается текстом, иначе 'false'.\n\n${payload}\n\nВерни ТОЛЬКО JSON-массив булевых значений (размером ровно ${questions.length}): [true, false, true, ...]`;
    const quotaOpts = routeOpts?.bypassLimits ? { bypassLimits: true } : {};
    const modelChain = buildGroundingModelChain(llmModel, routeOpts);
    const maxAttempts = config.LLM_MAX_RETRIES || 3;
    let lastError;

    for (const candidateModel of modelChain) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const mask = await callGroundingOnce(questions, prompt, candidateModel, quotaOpts);
                if (mask) {
                    if (candidateModel !== llmModel) {
                        console.warn(
                            `[GENERATOR] Grounding: ${llmModel} недоступна, использована ${candidateModel}`,
                        );
                    }
                    return mask;
                }
                lastError = new Error('Некорректный JSON grounding-ответ');
            } catch (e) {
                lastError = e;
                if (e.type === 'QUOTA_EXCEEDED') break;
                const parsed = parseGeminiApiError(e);
                if (parsed.isResourceExhausted) {
                    await quotaGuard.syncFromGoogle429(candidateModel, e);
                }
                const retryable = parsed.isTransientUnavailable
                    || (parsed.isResourceExhausted && !parsed.isDailyFreeTierQuota);
                if (retryable && attempt < maxAttempts) {
                    console.warn(
                        `[GENERATOR] Grounding ${candidateModel} попытка ${attempt}/${maxAttempts}: ${formatGeminiErr(e)}`,
                    );
                    await sleepForGeminiRetry(parsed, attempt, maxAttempts, sleep);
                    continue;
                }
                console.warn(
                    `[GENERATOR] Grounding ${candidateModel} не удалась: ${formatGeminiErr(e)}`,
                );
                break;
            }
        }
    }

    console.warn(
        `[GENERATOR] batch grounding: все модели исчерпаны (${modelChain.join(' → ')}): ${formatGeminiErr(lastError)}. Вопросы приняты без проверки.`,
    );
    return new Array(questions.length).fill(true);
}

function createBackfillIntents(poolChunks, count, typeOffset = 0) {
    const intents = [];
    for (let i = 0; i < count; i++) {
        const chunk = poolChunks[i % poolChunks.length];
        const ev = resolveChunkEvidence(chunk, { excerptChars: 200, maxFacts: 3 });
        let intentText;
        if ((ev.source === 'summary' || ev.source === 'layered') && ev.facts.length > 0) {
            const factIdx = Math.floor(i / poolChunks.length) % ev.facts.length;
            intentText = `Проверить знание факта: "${ev.facts[factIdx]}"`;
        } else if ((ev.source === 'text' || ev.source === 'extractive') && ev.facts.length > 0) {
            intentText = `Проверить понимание: "${ev.facts[0].slice(0, 120)}"`;
        } else if (ev.heading) {
            intentText = `Проверить ключевые понятия раздела "${ev.heading}"`;
        } else {
            intentText = `Проверить понимание фрагмента документа (чанк ${chunk.chunk_index + 1})`;
        }
        intents.push({
            theme:     chunk.section || 'Документ',
            section:   chunk.section || 'Документ',
            intent:    intentText,
            type:      'multiple_choice',
            _chunkRef: chunk,
        });
    }
    return intents;
}

module.exports = {
    buildBatchPrompt,
    normalizeQuestion,
    generateBatchQuestions,
    checkGroundingBatched,
    createBackfillIntents
};
