'use strict';

const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiModelHealthRepo = require('../db/repositories/aiModelHealthRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const { ALL_STAGE_KEYS, STAGE_CATALOG, AGENT_ROLE_TO_STAGE } = require('../config/stageTaxonomy');
const { MAX_QUALITY_MODE } = require('../config/routingModes');

const VALID_STRENGTH = new Set(['soft', 'hard']);
const VALID_STATUS = new Set(['active', 'draft', 'archived', 'disabled']);

function toBool(v, fallback = false) {
    if (v == null) return fallback;
    return !!v;
}

async function getModelMap() {
    const models = await aiModelsRepo.listModels({
        provider: 'google',
        includeDisabled: true,
        includePreviews: true,
    });
    const byId = new Map();
    for (const m of models) byId.set(Number(m.id), m);
    return byId;
}

function normalizeAgentRoleByStage(stageKey, rawRole) {
    if (rawRole) return String(rawRole);
    for (const [role, stage] of Object.entries(AGENT_ROLE_TO_STAGE)) {
        if (stage === stageKey) return role;
    }
    return 'unmapped_agent';
}

function normalizeMission(stageKey, missionKey) {
    if (missionKey) return String(missionKey);
    const stage = STAGE_CATALOG[stageKey];
    if (!stage) return 'general';
    if (stage.task_type === 'embedding') return 'evidence';
    if (stage.task_type === 'cheap_generation') return 'preprocess';
    if (stage.task_type === 'audit') return 'audit';
    return 'generation';
}

function validateProfilePayload(payload = {}) {
    const errors = [];
    if (!payload.code || typeof payload.code !== 'string') {
        errors.push('Поле code обязательно');
    }
    if (!payload.name || typeof payload.name !== 'string') {
        errors.push('Поле name обязательно');
    }
    if (payload.status && !VALID_STATUS.has(String(payload.status))) {
        errors.push('Некорректный status');
    }
    const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
    for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i] || {};
        if (!a.stage_key || !ALL_STAGE_KEYS.includes(String(a.stage_key))) {
            errors.push(`assignments[${i}].stage_key некорректный`);
        }
        if (a.override_strength && !VALID_STRENGTH.has(String(a.override_strength))) {
            errors.push(`assignments[${i}].override_strength некорректный`);
        }
    }
    return errors;
}

function createSystemProfileSnapshot(code) {
    return {
        code,
        name: `${code} (system)`,
        description: 'Системный режим',
        parent_mode: code,
        status: 'active',
        default_routing_behavior: 'stage_based',
        allow_premium: code === 'quality' || code === 'balanced' || code === 'auto' || code === 'manual' || code === MAX_QUALITY_MODE,
        allow_preview: code === 'manual' || code === MAX_QUALITY_MODE,
        stable_only: code !== 'manual' && code !== MAX_QUALITY_MODE,
        emergency_fallback: true,
    };
}

function mergeWithParent(profile, parent) {
    return {
        ...parent,
        ...profile,
        allow_premium: profile.allow_premium ?? parent.allow_premium,
        allow_preview: profile.allow_preview ?? parent.allow_preview,
        stable_only: profile.stable_only ?? parent.stable_only,
        emergency_fallback: profile.emergency_fallback ?? parent.emergency_fallback,
    };
}

function isPremiumModel(model) {
    const id = String(model?.api_model_id || '').toLowerCase();
    return id.includes('pro') && !id.includes('flash');
}

function isPreviewModel(model) {
    if (!model) return false;
    if (model.is_preview) return true;
    const id = String(model.api_model_id || '').toLowerCase();
    return id.includes('preview') || id.includes('experimental');
}

async function buildEffectivePreview({ profile, assignments, requestedContext = {} }) {
    const [modelMap, healthRows, policies] = await Promise.all([
        getModelMap(),
        aiModelHealthRepo.listAllLatest({ limit: 300 }),
        aiGlobalPoliciesRepo.getPolicies(),
    ]);
    const healthMap = new Map();
    for (const h of healthRows || []) healthMap.set(Number(h.ai_model_id), h);

    const merged = mergeWithParent(
        profile || {},
        createSystemProfileSnapshot(profile?.parent_mode || 'quality'),
    );
    const rows = [];
    const warnings = [];

    for (const raw of assignments || []) {
        const assignment = {
            mission_key: normalizeMission(raw.stage_key, raw.mission_key),
            stage_key: raw.stage_key,
            agent_role: normalizeAgentRoleByStage(raw.stage_key, raw.agent_role),
            primary_model_id: raw.primary_model_id,
            fallback_model_ids: Array.isArray(raw.fallback_model_ids) ? raw.fallback_model_ids : [],
            preferred_cost_tier: raw.preferred_cost_tier || null,
            allow_premium: raw.allow_premium,
            allow_preview: raw.allow_preview,
            stable_only: raw.stable_only,
            enabled: raw.enabled !== false,
            override_strength: raw.override_strength || 'soft',
            notes: raw.notes || null,
        };

        const localAllowPremium = assignment.allow_premium == null
            ? toBool(merged.allow_premium, false)
            : toBool(assignment.allow_premium, false);
        const localAllowPreview = assignment.allow_preview == null
            ? toBool(merged.allow_preview, false)
            : toBool(assignment.allow_preview, false);
        const localStableOnly = assignment.stable_only == null
            ? toBool(merged.stable_only, true)
            : toBool(assignment.stable_only, true);

        const blockedBy = [];
        const rejected = [];
        const configuredPrimary = modelMap.get(Number(assignment.primary_model_id)) || null;
        const configuredFallbacks = assignment.fallback_model_ids
            .map((id) => modelMap.get(Number(id)))
            .filter(Boolean);
        const chain = [configuredPrimary, ...configuredFallbacks].filter(Boolean);
        let effectivePrimary = null;
        let effectiveFallbacks = [];
        let wasFallback = false;
        let fallbackReason = null;

        if (!assignment.enabled) {
            blockedBy.push('assignment_disabled');
        }

        for (const m of chain) {
            if (!m.api_model_id) {
                rejected.push({ model_id: m.id, api_model_id: null, reason: 'missing_api_model_id' });
                continue;
            }
            if (!m.is_enabled) {
                rejected.push({ model_id: m.id, api_model_id: m.api_model_id, reason: 'model_disabled' });
                continue;
            }
            const h = healthMap.get(Number(m.id));
            if (h && (!h.is_healthy || h.is_suppressed)) {
                rejected.push({ model_id: m.id, api_model_id: m.api_model_id, reason: 'model_unhealthy' });
                blockedBy.push('health');
                continue;
            }
            if (isPreviewModel(m) && (localStableOnly || !localAllowPreview)) {
                rejected.push({ model_id: m.id, api_model_id: m.api_model_id, reason: 'preview_blocked' });
                blockedBy.push('preview_guard');
                continue;
            }
            if (isPremiumModel(m) && !localAllowPremium) {
                rejected.push({ model_id: m.id, api_model_id: m.api_model_id, reason: 'premium_blocked' });
                blockedBy.push('premium_guard');
                continue;
            }
            if (!effectivePrimary) {
                effectivePrimary = m;
            } else {
                effectiveFallbacks.push(m);
            }
        }

        if (!effectivePrimary && merged.emergency_fallback) {
            const emergencyModel = Array.from(modelMap.values())
                .find((m) => m.is_enabled && !isPreviewModel(m) && String(m.model_role) === 'llm');
            if (emergencyModel) {
                effectivePrimary = emergencyModel;
                blockedBy.push('emergency_downgrade');
                fallbackReason = 'all_candidates_rejected';
                wasFallback = true;
            }
        }

        if (effectivePrimary && configuredPrimary && effectivePrimary.id !== configuredPrimary.id) {
            wasFallback = true;
            fallbackReason = fallbackReason || 'primary_rejected';
        }

        const premiumBlocked = rejected.some((r) => r.reason === 'premium_blocked');
        const previewBlocked = rejected.some((r) => r.reason === 'preview_blocked');

        if (configuredPrimary && isPreviewModel(configuredPrimary)) {
            warnings.push({
                stage_key: assignment.stage_key,
                type: 'preview_model',
                message: `Primary model ${configuredPrimary.api_model_id || configuredPrimary.id} является preview`,
            });
        }
        const configuredPreviewModels = [configuredPrimary, ...configuredFallbacks].filter((m) => isPreviewModel(m));
        if (configuredPreviewModels.length > 0 && (localStableOnly || !localAllowPreview)) {
            const blockedReason = localStableOnly
                ? 'в профиле включён stable_only'
                : 'для этапа запрещён preview';
            const modelList = configuredPreviewModels
                .map((m) => m.api_model_id || `id=${m.id}`)
                .join(', ');
            warnings.push({
                stage_key: assignment.stage_key,
                type: 'preview_blocked_by_profile',
                message: `Preview-кандидаты (${modelList}) будут отфильтрованы: ${blockedReason}`,
            });
        }
        if (configuredPrimary && !configuredPrimary.api_model_id) {
            warnings.push({
                stage_key: assignment.stage_key,
                type: 'missing_api_model_id',
                message: `Primary model id=${configuredPrimary.id} не имеет подтвержденного api_model_id`,
            });
        }

        rows.push({
            stage_key: assignment.stage_key,
            mission_key: assignment.mission_key,
            agent_role: assignment.agent_role,
            configured_source: 'custom_mode_config',
            configured_primary: configuredPrimary?.api_model_id || null,
            configured_fallbacks: configuredFallbacks.map((m) => m.api_model_id).filter(Boolean),
            effective_primary: effectivePrimary?.api_model_id || null,
            effective_fallbacks: effectiveFallbacks.map((m) => m.api_model_id).filter(Boolean),
            blocked_by: Array.from(new Set(blockedBy)),
            rejected_candidates: rejected,
            premium_blocked: premiumBlocked,
            preview_blocked: previewBlocked,
            was_fallback: wasFallback,
            fallback_reason: fallbackReason,
            health_reason: blockedBy.includes('health') ? 'health_guard' : null,
            quota_reason: requestedContext.quotaPressure ? 'quota_pressure' : null,
            policy_reason: blockedBy.includes('premium_guard') || blockedBy.includes('preview_guard')
                ? 'policy_guard'
                : null,
        });
    }

    return {
        global: merged,
        warnings,
        rows,
        can_publish: warnings.length === 0 && rows.every((r) => !!r.effective_primary),
        generated_at: new Date().toISOString(),
        policy_snapshot: policies || {},
    };
}

module.exports = {
    validateProfilePayload,
    buildEffectivePreview,
};
