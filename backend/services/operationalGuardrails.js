'use strict';

/**
 * Operational Guardrails Service
 *
 * Centralizes runtime safety checks that the RoutingEngine consults:
 *  - Premium burn guard (soft-limit and daily cap)
 *  - Emergency downgrade enforcement
 *  - Override precedence resolution
 *  - Proactive model suppression before provider failure
 */

const config = require('../config');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const aiModelUsageRepo = require('../db/repositories/aiModelUsageRepo');
const { logStructured } = require('../utils/observability');

const CACHE_TTL = 10_000;
let _policiesCache = null;

async function loadPolicies() {
    if (_policiesCache && Date.now() - _policiesCache.ts < CACHE_TTL) return _policiesCache.data;
    let data;
    try { data = await aiGlobalPoliciesRepo.getPolicies(); } catch { data = null; }
    if (!data) {
        data = {
            routing_mode: 'auto',
            stable_only: false,
            premium_guard_enabled: true,
            premium_soft_limit_percent: 20,
            max_premium_percent_per_day: 25,
            max_pro_calls_per_run: 10,
            preview_canary_percent: 0,
            emergency_downgrade: false,
        };
    }
    _policiesCache = { ts: Date.now(), data };
    return data;
}

function invalidateCache() { _policiesCache = null; }

// ---------------------------------------------------------------------------
// Premium Burn Guard
// ---------------------------------------------------------------------------

/**
 * Check if premium usage is within safe limits.
 * Returns { allowed, reason, premiumPercent, limit }.
 */
async function checkPremiumBudget({ keyFingerprint, usageDate } = {}) {
    const policies = await loadPolicies();
    if (!policies.premium_guard_enabled) {
        return { allowed: true, reason: 'guard_disabled' };
    }

    const date = usageDate || new Date().toISOString().slice(0, 10);
    let rows;
    try {
        rows = await aiModelUsageRepo.listUsageWithModelsForDate({
            keyFingerprint: keyFingerprint || await getKeyFingerprint(),
            usageDate: date,
        });
    } catch {
        return { allowed: true, reason: 'usage_unavailable' };
    }

    let totalReqs = 0;
    let premiumReqs = 0;
    for (const r of rows) {
        totalReqs += Number(r.requests || 0);
        const id = String(r.api_model_id || '').toLowerCase();
        if (id.includes('pro') && !id.includes('flash')) {
            premiumReqs += Number(r.requests || 0);
        }
    }

    if (totalReqs === 0) {
        return { allowed: true, reason: 'no_usage_yet', premiumPercent: 0 };
    }

    const premiumPercent = (premiumReqs / totalReqs) * 100;
    const maxPercent = policies.max_premium_percent_per_day || 25;
    const softPercent = policies.premium_soft_limit_percent || 20;

    if (premiumPercent >= maxPercent) {
        logStructured({
            level: 'warn', phase: 'generate', event: 'premium_hard_limit_reached',
            metrics: { premium_percent: premiumPercent, max: maxPercent, premium_reqs: premiumReqs, total_reqs: totalReqs },
        });
        return {
            allowed: false,
            reason: 'premium_hard_limit',
            premiumPercent: Math.round(premiumPercent),
            limit: maxPercent,
        };
    }

    if (premiumPercent >= softPercent) {
        return {
            allowed: true,
            reason: 'premium_soft_warning',
            premiumPercent: Math.round(premiumPercent),
            limit: softPercent,
            warning: true,
        };
    }

    return {
        allowed: true,
        reason: 'within_budget',
        premiumPercent: Math.round(premiumPercent),
    };
}

/**
 * Check per-run premium call limit.
 */
async function checkRunPremiumLimit({ currentProCalls = 0 } = {}) {
    const policies = await loadPolicies();
    const maxPerRun = policies.max_pro_calls_per_run || 10;
    if (currentProCalls >= maxPerRun) {
        return { allowed: false, reason: 'run_pro_limit', current: currentProCalls, max: maxPerRun };
    }
    return { allowed: true, reason: 'within_run_limit', current: currentProCalls, max: maxPerRun };
}

// ---------------------------------------------------------------------------
// Emergency Downgrade
// ---------------------------------------------------------------------------

/**
 * Check if emergency downgrade is active.
 * When active, all non-critical stages should use economy/stable models.
 */
async function isEmergencyDowngradeActive() {
    const policies = await loadPolicies();
    return !!policies.emergency_downgrade;
}

/**
 * Stages that are still allowed premium during emergency.
 * (None by default — emergency means full economy.)
 */
const EMERGENCY_EXEMPT_STAGES = [];

function isStageExemptFromEmergency(stageKey) {
    return EMERGENCY_EXEMPT_STAGES.includes(stageKey);
}

// ---------------------------------------------------------------------------
// Override Precedence
// ---------------------------------------------------------------------------

/**
 * Resolve the highest-priority override from a list.
 * Order: run > document > stage > global.
 *
 * @param {Array} overrides - sorted by priority DESC
 * @param {object} ctx - { stageKey, agentRole, documentId, runId }
 * @returns {object|null} the winning override
 */
function resolveOverridePrecedence(overrides, ctx) {
    if (!overrides || overrides.length === 0) return null;

    const { stageKey, agentRole, documentId, runId } = ctx;

    const buckets = { run: [], document: [], stage: [], global: [] };

    for (const o of overrides) {
        const scope = String(o.scope || '');
        const target = String(o.target || '');

        if (scope === 'document' && documentId != null && target === String(documentId)) {
            buckets.document.push(o);
        } else if (scope === 'agent' && agentRole && target === agentRole) {
            buckets.stage.push(o);
        } else if (scope === 'phase' && (target === stageKey || target === agentRole)) {
            buckets.stage.push(o);
        } else if (o.stage_key && o.stage_key === stageKey) {
            buckets.stage.push(o);
        } else if (scope === 'global') {
            buckets.global.push(o);
        }
    }

    for (const level of ['run', 'document', 'stage', 'global']) {
        const list = buckets[level];
        if (list.length > 0) {
            list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
            return { ...list[0], _precedence_level: level };
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Proactive Model Suppression
// ---------------------------------------------------------------------------

/**
 * Given usage snapshot and health data, determine if a model should be
 * proactively suppressed (before it actually fails).
 */
function shouldSuppressModel({ usageSnapshot, healthSnapshot, modelId }) {
    if (!modelId) return false;

    if (healthSnapshot) {
        if (healthSnapshot.is_suppressed) return true;
        if (healthSnapshot.error_rate > 0.2 && healthSnapshot.total_requests >= 3) return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getKeyFingerprint() {
    try {
        const crypto = require('crypto');
        const runtimeConfig = require('./runtimeConfig');
        const key = await runtimeConfig.getGeminiApiKey();
        if (!key) return '';
        return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    } catch {
        return '';
    }
}

module.exports = {
    checkPremiumBudget,
    checkRunPremiumLimit,
    isEmergencyDowngradeActive,
    isStageExemptFromEmergency,
    resolveOverridePrecedence,
    shouldSuppressModel,
    loadPolicies,
    invalidateCache,
};
