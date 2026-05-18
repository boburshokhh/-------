'use strict';

/**
 * Публичный снимок настроек маршрутизации для страницы генерации (без admin).
 */

const modelRouter = require('./modelRouter');
const routingEngine = require('./routingEngine');
const quotaGuard = require('./quotaGuard');
const aiRoutingConfigRepo = require('../db/repositories/aiRoutingConfigRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const customModeProfilesRepo = require('../db/repositories/customModeProfilesRepo');
const customModeService = require('./customModeService');
const operationalGuardrails = require('./operationalGuardrails');
const { STAGE_KEYS } = require('../config/stageTaxonomy');
const { BUILT_IN_ROUTING_MODES, isMaxQualityMode } = require('../config/routingModes');

const VALID_MODES = new Set(BUILT_IN_ROUTING_MODES);
const CUSTOM_MODE_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

function normalizeMode(raw) {
    const m = String(raw || 'auto').toLowerCase().trim();
    if (VALID_MODES.has(m)) return m;
    if (CUSTOM_MODE_CODE_RE.test(m)) return m;
    return 'auto';
}

/**
 * @param {object} opts
 * @param {string} [opts.requestedMode] — auto | economy | balanced | quality | manual
 * @returns {Promise<object>}
 */
async function getPublicGenerationRoutingSnapshot({ requestedMode = 'auto' } = {}) {
    const mode = normalizeMode(requestedMode);
    let customModeProfile = null;
    if (!VALID_MODES.has(mode)) {
        try {
            customModeProfile = await customModeProfilesRepo.getProfileWithAssignmentsById(
                (await customModeProfilesRepo.getProfileByCode(mode))?.id,
            );
            if (!customModeProfile || customModeProfile.is_archived || customModeProfile.is_disabled) {
                customModeProfile = null;
            }
        } catch {
            customModeProfile = null;
        }
    }

    let baseConfig = null;
    let globalPolicies = null;
    try {
        baseConfig = await aiRoutingConfigRepo.getRoutingConfig();
    } catch { /* ignore */ }
    try {
        globalPolicies = await aiGlobalPoliciesRepo.getPolicies();
    } catch { /* ignore */ }

    let effectiveMode = mode;
    try {
        effectiveMode = await modelRouter.resolveEffectiveMode(mode);
    } catch {
        effectiveMode = mode === 'auto' ? (baseConfig?.routing_mode || 'auto') : mode;
    }

    const quotaSnap = await quotaGuard.getUsageSnapshot().catch(() => ({ flags: {} }));

    let premiumBudget = { allowed: true, reason: 'unknown' };
    try {
        premiumBudget = await operationalGuardrails.checkPremiumBudget({});
    } catch (e) {
        premiumBudget = { allowed: true, reason: 'check_failed', error: e.message };
    }

    const explanations = [];
    if (mode === 'auto') {
        const gm = baseConfig?.routing_mode || 'auto';
        if (gm && gm !== 'auto') {
            explanations.push(
                `Режим «auto» подставляет базовый режим администратора: «${gm}».`,
            );
        } else {
            explanations.push(
                'Режим «auto»: в конфиге указан «auto» — эффективный режим выбирается эвристиками и лимитами (см. effective_mode).',
            );
        }
    } else if (isMaxQualityMode(mode)) {
        explanations.push(
            'Режим «max_quality»: топ-модели (Gemini 3.1 Pro) на плане теста и генерации вопросов; на остальных стадиях — подходящие по задаче модели (Flash/Pro).',
        );
    } else if (mode !== 'manual') {
        explanations.push(`Выбран режим «${mode}»: приоритет у стоимости/качества в зависимости от режима.`);
    } else {
        explanations.push('Режим «manual»: используется модель из вашего выбора (если разрешено квотой и политиками).');
    }

    const downgradeActive = !!(globalPolicies?.emergency_downgrade);
    if (downgradeActive) {
        explanations.push('Включён аварийный downgrade: приоритет у стабильных экономичных моделей.');
    }

    const stableOnly = !!(globalPolicies?.stable_only);
    if (stableOnly) {
        explanations.push('Включено «только стабильные модели»: preview-модели не используются.');
    }

    if (!isMaxQualityMode(mode) && globalPolicies?.premium_guard_enabled && premiumBudget.warning) {
        explanations.push(
            `Расход premium приближается к мягкому лимиту (~${premiumBudget.premiumPercent ?? '?'}% сегодня).`,
        );
    }
    if (!isMaxQualityMode(mode) && globalPolicies?.premium_guard_enabled && premiumBudget.allowed === false) {
        explanations.push('Premium сейчас ограничен политикой дневного бюджета.');
    }

    const flags = quotaSnap.flags || {};
    if (!isMaxQualityMode(mode) && flags.premiumBudgetTight) {
        explanations.push('Система снизила использование premium из‑за лимитов бюджета (premium_budget_tight).');
    }
    if (!isMaxQualityMode(mode) && flags.flashBudgetTightForCheap) {
        explanations.push('Flash-class под нагрузкой по бюджету — дешёвые стадии могут перейти на другую модель.');
    }
    if (!isMaxQualityMode(mode) && flags.previewRoutingBlocked) {
        explanations.push('Preview-модели временно отключены из‑за высокой ошибки (preview_routing_blocked).');
    }

    /** Предпросмотр моделей по стадиям для UI. */
    const stagePreview = {};
    try {
        if (customModeProfile) {
            const preview = await customModeService.buildEffectivePreview({
                profile: customModeProfile,
                assignments: customModeProfile.assignments || [],
                requestedContext: {},
            });
            for (const row of preview.rows || []) {
                stagePreview[row.stage_key] = {
                    selected: row.effective_primary || null,
                    fallback: (row.effective_fallbacks && row.effective_fallbacks[0]) || null,
                    reason: row.fallback_reason || null,
                    cost_tier: null,
                    premium_blocked: !!row.premium_blocked,
                    preview_blocked: !!row.preview_blocked,
                    configured_primary: row.configured_primary || null,
                    configured_fallbacks: row.configured_fallbacks || [],
                    blocked_by: row.blocked_by || [],
                };
            }
        } else {
            const v2 = await modelRouter.resolvePipelineModelsV2({
                routingMode: mode,
                documentMetadata: { page_count: 1 },
                complexityScore: 0.4,
                quotaSnapshot: quotaSnap,
                adminOverrides: {},
                traceId: 'ui-preview',
                documentId: null,
                runId: null,
            });
            if (v2?.decisions) {
                const keys = [
                    STAGE_KEYS.question_generation,
                    STAGE_KEYS.blueprint_generation,
                    STAGE_KEYS.grounding_validation,
                    STAGE_KEYS.embedding,
                ];
                for (const k of keys) {
                    const d = v2.decisions[k];
                    if (d) {
                        stagePreview[k] = {
                            selected: d.selectedModel,
                            fallback: d.fallbackModel,
                            reason: d.reason,
                            cost_tier: d.costTier,
                            premium_blocked: !!d.premiumBlocked,
                            preview_blocked: !!d.previewBlocked,
                        };
                    }
                }
            }
        }
    } catch (e) {
        stagePreview._error = e.message;
    }

    return {
        requested_mode: mode,
        effective_mode: effectiveMode,
        custom_mode: customModeProfile
            ? {
                code: customModeProfile.code,
                name: customModeProfile.name,
                config_version: customModeProfile.config_version,
                parent_mode: customModeProfile.parent_mode || null,
            }
            : null,
        base_config_routing_mode: baseConfig?.routing_mode ?? 'auto',
        policies: globalPolicies
            ? {
                stable_only: !!globalPolicies.stable_only,
                emergency_downgrade: !!globalPolicies.emergency_downgrade,
                premium_guard_enabled: globalPolicies.premium_guard_enabled !== false,
                premium_soft_limit_percent: globalPolicies.premium_soft_limit_percent ?? 20,
                max_premium_percent_per_day: globalPolicies.max_premium_percent_per_day ?? 25,
                preview_canary_percent: globalPolicies.preview_canary_percent ?? 0,
            }
            : null,
        quota_flags: flags,
        premium_budget: {
            allowed: premiumBudget.allowed !== false,
            reason: premiumBudget.reason || null,
            premium_percent: premiumBudget.premiumPercent ?? null,
            warning: !!premiumBudget.warning,
        },
        downgrade_active: downgradeActive,
        stage_preview: stagePreview,
        explanations,
    };
}

module.exports = { getPublicGenerationRoutingSnapshot, normalizeMode };
