const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const runtimeConfig = require('../runtimeConfig');
const { inferIsPreview, inferModelRole } = require('../aiModelRegistryService');

function stripModelsPrefix(name) {
    if (!name || typeof name !== 'string') return '';
    const s = name.trim();
    if (s.startsWith('models/')) return s.slice('models/'.length);
    return s;
}

function humanizeModelId(id) {
    if (!id) return 'Unknown model';
    return String(id)
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Heuristic category for catalog (matches models.json conventions).
 */
function inferCategoryFromCapabilities({ capabilities, apiModelId, displayName }) {
    const caps = Array.isArray(capabilities) ? capabilities : [];
    const id = `${apiModelId || ''} ${displayName || ''}`.toLowerCase();

    if (id.includes('embedding') || caps.some((c) => String(c).toLowerCase().includes('embed'))) {
        return 'other';
    }
    if (id.includes('tts') || id.includes('text-to-speech') || id.includes('native-audio')) {
        return 'tts';
    }
    if (id.includes('imagen') || id.includes('image') || id.includes('banana')) {
        return 'image';
    }
    if (id.includes('veo') || id.includes('video')) {
        return 'video';
    }
    if (id.includes('lyria') || id.includes('music') || id.includes('audio_music')) {
        return 'audio_music';
    }
    if (id.includes('live') || id.includes('live_api')) {
        return 'live_api';
    }
    if (id.includes('deep-research') || id.includes('agent')) {
        return 'agent';
    }

    const onlyEmbed = caps.length > 0 && caps.every((c) => /embed/i.test(String(c)));
    if (onlyEmbed) return 'other';

    const hasGenerate = caps.some((c) => /generateContent|generateAnswer|generate|predict/i.test(String(c)));
    if (hasGenerate) return 'text_out';

    return 'other';
}

/**
 * Broader preview detection than legacy inferIsPreview (preview / exp / experimental).
 */
function inferIsPreviewExtended({ uiName, apiModelId, displayName }) {
    if (inferIsPreview({ uiName, apiModelId })) return true;
    const s = `${displayName || ''} ${apiModelId || ''}`.toLowerCase();
    return /\bpreview\b|\bexperimental\b|\bexp\b/.test(s);
}

/**
 * @returns {Promise<Array<object>>} normalized models for sync
 */
async function listNormalizedModels() {
    const apiKey = await runtimeConfig.getGeminiApiKey();
    if (!apiKey || !String(apiKey).trim()) {
        const err = new Error('GEMINI_API_KEY не настроен');
        err.status = 503;
        throw err;
    }

    const ai = new GoogleGenAI({ apiKey: String(apiKey).trim() });
    const pager = await ai.models.list({
        config: { pageSize: 100, queryBase: true },
    });

    const out = [];
    for await (const m of pager) {
        const rawName = m.name || '';
        const apiModelId = stripModelsPrefix(rawName);
        if (!apiModelId) continue;

        const capabilities = Array.isArray(m.supportedActions)
            ? m.supportedActions.map((x) => String(x))
            : [];

        const displayName = m.displayName || '';
        const description = m.description || '';

        const category = inferCategoryFromCapabilities({
            capabilities,
            apiModelId,
            displayName,
        });

        const uiName = displayName || humanizeModelId(apiModelId);
        const isPreview = inferIsPreviewExtended({
            uiName,
            apiModelId,
            displayName,
        });

        const modelRole = inferModelRole({ category, uiName, apiModelId });

        out.push({
            api_model_id: apiModelId,
            raw_name: rawName,
            display_name: displayName,
            description,
            capabilities,
            category,
            ui_name: uiName,
            is_preview: isPreview,
            model_role: modelRole,
        });
    }

    return out;
}

function loadUiNameMapping() {
    const mappingPath = path.join(__dirname, '..', '..', 'config', 'gemini-ui-name-mapping.json');
    try {
        const data = require(mappingPath);
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

function resolveUiNameAndCategory(normalized, mappingByApiId) {
    const id = normalized.api_model_id;
    const entry = mappingByApiId[id];
    if (entry && entry.ui_name) {
        return {
            ui_name: entry.ui_name,
            category: entry.category != null ? entry.category : normalized.category,
        };
    }
    return {
        ui_name: normalized.display_name || humanizeModelId(id),
        category: normalized.category,
    };
}

module.exports = {
    listNormalizedModels,
    loadUiNameMapping,
    resolveUiNameAndCategory,
    stripModelsPrefix,
    humanizeModelId,
    inferCategoryFromCapabilities,
};
