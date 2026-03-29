const { GoogleGenAI } = require('@google/genai');
const config = require('../../config');
const { extractJSON } = require('../validator');
const runtimeConfig = require('../runtimeConfig');
const quotaGuard = require('../quotaGuard');
const { parseGeminiApiError, sleepForGeminiRetry, withTimeout } = require('../geminiError');
const { buildSummaryDigest } = require('../rag/evidenceBuilder');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
            if (Array.isArray(chunk.summary) && chunk.summary.length > 0) {
                factsCount += chunk.summary.length;
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
        const summaryFacts = chunks.flatMap(c => Array.isArray(c.summary) ? c.summary : []);

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

    console.log(`[BLUEPRINT] buildLocalThemesFromSections: ${themes.length} тем из ${sectionMap.size} разделов (without LLM)`);
    return themes;
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

async function buildThemesAndBlueprint(indexedChunks, fullText, model = null, targetCount = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const targetFastModel = config.LLM_FAST_MODEL || config.LLM_MODEL;
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

            const response = await withTimeout(genPromise, reqTimeout, '[BLUEPRINT] buildThemesAndBlueprint generateContent');
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

async function extractThemes(indexedChunks, fullText, model = null, targetCount = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const targetFastModel = config.LLM_FAST_MODEL || config.LLM_MODEL;
    const llmModel = await quotaGuard.getAvailableModel(targetFastModel);

    const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];
    const OLD_TO_BLOOM = { easy: 'remember', medium: 'understand', hard: 'analyze' };

    const structuralEstimate = estimateThemeCount(indexedChunks, fullText);
    const targetThemes = targetCount
        ? Math.max(structuralEstimate, Math.min(10, Math.ceil(targetCount / 3)))
        : structuralEstimate;

    if (await quotaGuard.isRpdExhaustedForModel(llmModel)) {
        console.warn('[BLUEPRINT] extractThemes: дневной лимит LLM исчерпан — собираем темы локально из разделов');
        return buildLocalThemesFromSections(indexedChunks);
    }

    const digest = buildSummaryDigest(indexedChunks, fullText);

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

Материал (разбит по разделам):
${digest}

Верни JSON массив из ровно ${targetThemes} объектов. Никакого другого текста:
[{"topic":"...","section":"...","importance":2,"suggestedCount":3,"difficultyCandidates":["understand","apply"]},...]`,
                config: { temperature: 0.2, responseMimeType: 'application/json' },
            });
            const response = await withTimeout(genPromise, reqTimeout, '[BLUEPRINT] extractThemes generateContent');
            await quotaGuard.recordGeminiCall(llmModel);

            const parsed = extractJSON(response.text);
            let themes = Array.isArray(parsed) ? parsed : (parsed.themes && Array.isArray(parsed.themes) ? parsed.themes : null);

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
                console.log(`[BLUEPRINT] extractThemes: ${themes.length} тем из ${indexedChunks ? indexedChunks.length : 0} чанков (${uniqueSections.length} разделов)`);
                if (themes.length < Math.ceil(targetThemes * 0.6)) {
                    console.warn(`[BLUEPRINT] extractThemes: LLM вернул меньше тем (${themes.length}) чем ожидалось (${targetThemes})`);
                }
                return themes;
            }
            throw new Error('Пустой список тем');
        } catch (err) {
            lastError = err;
            if (err.type === 'QUOTA_EXCEEDED') break;
            const g = parseGeminiApiError(err);
            if (g.isResourceExhausted) await quotaGuard.syncFromGoogle429(llmModel, err);
            console.warn(`[BLUEPRINT] extractThemes попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) onRetry({ attempt, maxAttempts, parsed: g, message: String(err.message || '') });
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }
    throwAfterGeminiRetriesFailed('extractThemes', lastError);
}

async function buildQuestionBlueprint(themes, targetMin, targetMax, model = null, options = null) {
    const opts = options && typeof options === 'object' ? options : {};
    const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    const targetFastModel = config.LLM_FAST_MODEL || config.LLM_MODEL;
    const llmModel = await quotaGuard.getAvailableModel(targetFastModel);
    
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
        console.warn('[BLUEPRINT] buildBlueprint: дневной лимит LLM исчерпан — локальный план без API');
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
            const response = await withTimeout(genPromise, reqTimeout, '[BLUEPRINT] buildBlueprint generateContent');
            await quotaGuard.recordGeminiCall(llmModel);
            const parsed = extractJSON(response.text);
            const list = Array.isArray(parsed) ? parsed : (parsed.intents && Array.isArray(parsed.intents) ? parsed.intents : null);

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
            console.warn(`[BLUEPRINT] buildBlueprint попытка ${attempt}/${maxAttempts}: ${err.message}`);
            if (g.isDailyFreeTierQuota) break;
            if (attempt < maxAttempts) {
                if (onRetry) onRetry({ attempt, maxAttempts, parsed: g, message: String(err.message || '') });
                await sleepForGeminiRetry(g, attempt, maxAttempts, sleep);
            }
        }
    }
    throwAfterGeminiRetriesFailed('buildQuestionBlueprint', lastError);
}

module.exports = {
    estimateThemeCount,
    buildLocalThemesFromSections,
    buildThemesAndBlueprint,
    extractThemes,
    buildQuestionBlueprint,
    computeIntentsPerTheme,
    buildBlueprintFallbackLocal
};
