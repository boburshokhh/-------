const { GoogleGenAI } = require('@google/genai');
const config = require('../../config');
const { extractJSON } = require('../validator');
const runtimeConfig = require('../runtimeConfig');
const quotaGuard = require('../quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry, withTimeout } = require('../geminiError');
const { buildSummaryDigest, getMergedFactsForChunk } = require('../rag/evidenceBuilder');

/** Компактное оглавление по section/heading чанков (без LLM). */
function buildDocumentOutline(indexedChunks) {
    const lines = [];
    const seen = new Set();
    for (const c of indexedChunks || []) {
        const sec = (c.section || '').trim();
        const hd = (c.heading || '').trim();
        if (!sec && !hd) continue;
        const key = `${sec}\n${hd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (sec && hd && sec !== hd) lines.push(`- ${sec} → ${hd}`);
        else if (sec) lines.push(`- ${sec}`);
        else lines.push(`- ${hd}`);
    }
    if (lines.length === 0) return '';
    return `\n\nОГЛАВЛЕНИЕ (структура чанков, ${Math.min(lines.length, 80)} пунктов):\n${lines.slice(0, 80).join('\n')}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveBlueprintModelTarget(model) {
    const requested = typeof model === 'string' ? model.trim() : '';
    return requested || config.LLM_FAST_MODEL || config.LLM_MODEL;
}

async function getAiClient() {
    return new GoogleGenAI({ apiKey: await runtimeConfig.getGeminiApiKey() });
}

function throwAfterGeminiRetriesFailed(stepHuman, lastError) {
    console.error(`[BLUEPRINT] ${stepHuman}: попытки исчерпаны`, lastError && lastError.message);
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

function estimateThemeCount(indexedChunks, fullText) {
    if (indexedChunks && indexedChunks.length > 0) {
        const chunkCount = indexedChunks.length;
        const uniqueSections = new Set();
        for (const chunk of indexedChunks) {
            const sec = (chunk.section || chunk.heading || '').trim();
            if (sec && sec !== 'Документ') uniqueSections.add(sec);
        }
        const sectionCount = uniqueSections.size;

        let factsCount = 0;
        for (const chunk of indexedChunks) {
            const merged = getMergedFactsForChunk(chunk, 99);
            if (merged.length > 0) {
                factsCount += merged.length;
            } else {
                const text = typeof chunk.text === 'string' ? chunk.text : '';
                const sentenceEst = Math.max(2, Math.min(6,
                    Math.ceil((text.match(/[.!?]/g) || []).length / 2)
                ));
                factsCount += sentenceEst;
            }
        }

        const bySection = sectionCount >= 2 ? sectionCount : 0;
        const byChunks  = Math.ceil(chunkCount / 3);
        const byFacts   = Math.ceil(factsCount / 5);

        const hardMin = chunkCount >= 5 ? 3 : 1;
        const estimate = Math.max(hardMin, bySection, byChunks, byFacts);

        console.log(`[BLUEPRINT] estimateThemeCount: sections=${sectionCount} chunks=${chunkCount} facts=${factsCount} → bySection=${bySection} byChunks=${byChunks} byFacts=${byFacts} → estimate=${Math.min(14, estimate)}`);
        return Math.min(14, estimate);
    }
    const lenBasedMin = Math.max(2, Math.floor(fullText.length / 5000));
    return Math.min(8, Math.max(3, Math.floor(fullText.length / 3000)));
}

function buildLocalThemesFromSections(indexedChunks) {
    const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

    const CONTENT_SIGNALS = [
        { re: /(?:ВНИМАНИЕ|ОСТОРОЖНО|warning|caution|danger)/i, bloom: ['remember', 'apply'],     importance: 3, label: 'safety' },
        { re: /(?:неисправн|диагностик|troubleshoot|fault)/i,   bloom: ['analyze', 'apply'],      importance: 3, label: 'troubleshooting' },
        { re: /(?:техническ|обслужива|maintenance|service)/i,   bloom: ['remember', 'apply'],     importance: 2, label: 'maintenance' },
        { re: /(?:установк|монтаж|install|assembly)/i,          bloom: ['understand', 'apply'],   importance: 2, label: 'installation' },
        { re: /(?:настройк|регулировк|настрой|calibrat)/i,      bloom: ['apply', 'analyze'],      importance: 2, label: 'configuration' },
        { re: /(?:эксплуатац|работ|операц|operation|usage)/i,   bloom: ['understand', 'apply'],   importance: 2, label: 'operation' },
        { re: /(?:параметр|характеристик|specification|spec)/i, bloom: ['remember', 'understand'], importance: 2, label: 'parameters' },
    ];

    const sectionMap = new Map();
    for (const chunk of indexedChunks) {
        const sec = (chunk.section || chunk.heading || 'Документ').trim();
        if (!sectionMap.has(sec)) sectionMap.set(sec, []);
        sectionMap.get(sec).push(chunk);
    }

    const themes = [];
    let idx = 0;

    for (const [section, chunks] of sectionMap) {
        const sectionText = chunks.map(c => c.text || '').join(' ');
        const summaryFacts = chunks.flatMap(c => getMergedFactsForChunk(c, 24));

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

        let topic;
        if (summaryFacts.length > 0) {
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

    if (themes.length === 1 && indexedChunks.length >= 4) {
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
            const firstFact = (getMergedFactsForChunk(group[0], 8)[0] || '');
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

    console.log(`[BLUEPRINT] buildLocalThemesFromSections: ${themes.length} тем из ${sectionMap.size} разделов (without LLM)`);
    return themes;
}

function computeIntentsPerTheme(richThemes, totalTarget) {
    const weights = richThemes.map(t => (t.importance || 2) * (t.suggestedCount || 3));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    // Minimum 1 intent per theme (was 2 — forced intents from sparse sections
    // that couldn't pass evidence quality and just wasted retrieval quota).
    const counts = weights.map(w => Math.max(1, Math.round((w / totalWeight) * totalTarget)));
    let diff = counts.reduce((s, n) => s + n, 0) - totalTarget;
    let idx = 0;
    let loopGuard = 0;
    while (diff > 0) {
        const i = idx % counts.length;
        if (counts[i] > 1 || loopGuard > counts.length * 2) { counts[i]--; diff--; }
        idx++;
        loopGuard++;
        if (idx > counts.length * 100) break;
    }
    idx = 0;
    while (diff < 0) { counts[idx % counts.length]++; diff++; idx++; }
    return counts;
}

/**
 * Локальный fallback-blueprint без LLM.
 *
 * Изменение: интенты теперь варьируются по уровням Bloom Taxonomy вместо
 * одинакового "Проверить понимание: X" для каждого слота темы.
 * Это создаёт семантически разные embedding-запросы для каждого интента
 * в рамках одной темы → hybridRetrieve возвращает разные чанки → меньше
 * дубликатов в generation stage.
 */
function buildBlueprintFallbackLocal(richThemes, perTheme) {
    const BLOOM_VERBS = {
        remember:  'Назвать и воспроизвести',
        understand: 'Объяснить принцип',
        apply:     'Применить на практике',
        analyze:   'Проанализировать и сравнить',
    };
    const DEFAULT_VERB = 'Проверить знание';

    const fallback = [];
    for (let ti = 0; ti < richThemes.length; ti++) {
        const t = richThemes[ti];
        const candidates = Array.isArray(t.difficultyCandidates) && t.difficultyCandidates.length > 0
            ? t.difficultyCandidates
            : ['understand'];
        for (let i = 0; i < perTheme[ti]; i++) {
            const level = candidates[i % candidates.length];
            const verb = BLOOM_VERBS[level] || DEFAULT_VERB;
            fallback.push({
                theme: t.topic,
                section: t.section,
                intent: `${verb}: ${t.topic}`,
                type: 'multiple_choice',
            });
        }
    }
    return fallback;
}

async function buildThemesAndBlueprint(indexedChunks, fullText, model = null, targetCount = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const targetFastModel = resolveBlueprintModelTarget(model);
    const llmModel = await quotaGuard.getAvailableModel(targetFastModel);

    const structuralEstimate = estimateThemeCount(indexedChunks, fullText);
    const targetThemes = targetCount ? Math.max(structuralEstimate, Math.min(10, Math.ceil(targetCount / 3))) : structuralEstimate;
    const totalQuestions = targetCount || 10;

    if (await quotaGuard.isRpdExhaustedForModel(llmModel)) {
        console.warn('[BLUEPRINT] buildThemesAndBlueprint: RPD exhausted — local fallback');
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
    const outlineText = buildDocumentOutline(indexedChunks);

    const reqTimeout = config.GEMINI_REQUEST_TIMEOUT_MS || 30000;
    // Reduced from 5 to 2: if the model fails twice, the improved local fallback
    // is faster and more reliable than 3+ more retries with exponential backoff.
    const maxAttempts = 2;
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
1. Выдели примерно ${targetThemes} конкретных тем из документа.${sectionListText}${outlineText}
2. Суммарно для всех тем ты должен сгенерировать ровно ${totalQuestions} намерений (intents). Распредели их по темам пропорционально их важности.
3. Intent — это что конкретно будет проверять вопрос (1-2 предложения, например "Проверить знание шагов процедуры отключения питания" или "Проверить выбор допустимого интервала замены при заданной температуре"). Запрещены намерения про оглавление: не пиши «что в Главе N», «содержание раздела X» — только предметные факты и процессы.
4. Для технических текстов отдавай приоритет intents, где проверяются числа, нормы, последовательность операций, условия применения, сравнение режимов — а не перечисление названий блоков документа.

Материал (разбит по разделам):
${digest}

Верни строго JSON массив объектов (ровно ${totalQuestions} объектов). Формат:
[
  { "theme": "Название темы", "section": "Раздел", "intent": "Что проверить (намерение)", "type": "multiple_choice" },
  ...
]`,
                config: { temperature: 0.2, responseMimeType: 'application/json' },
            });

            const response = await withTimeout(genPromise, reqTimeout, '[BLUEPRINT] buildThemesAndBlueprint generateContent');
            await quotaGuard.recordGeminiCall(llmModel);

            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

            if (list && list.length > 0) {
                const normalized = list.map(item => ({ ...item, type: 'multiple_choice' }));
                // Accept any result with at least 5 intents (was 80% of totalQuestions).
                // A partial blueprint with 5-20 intents is far more valuable than
                // 3 more retries + exponential backoff that can add 60-120 seconds.
                const minAcceptable = Math.min(5, totalQuestions);
                if (normalized.length < minAcceptable) {
                    throw new Error(`Blueprint слишком мал: ${normalized.length} intents (минимум ${minAcceptable})`);
                }
                return normalized.slice(0, totalQuestions);
            }
            throw new Error('Пустой план вопросов');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, err);
            console.warn(`[BLUEPRINT] buildThemesAndBlueprint попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) onRetry({ attempt, maxAttempts, parsed: g, message: String(err.message || '') });
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }
    throwAfterGeminiRetriesFailed('buildThemesAndBlueprint', lastError);
}

module.exports = {
    estimateThemeCount,
    buildLocalThemesFromSections,
    buildThemesAndBlueprint,
    buildQuestionBlueprint,
    computeIntentsPerTheme,
    buildBlueprintFallbackLocal
};
