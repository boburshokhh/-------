const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const config = require('../config');
const aiModelsRepo = require('../db/repositories/aiModelsRepo');
const aiRoutingRulesRepo = require('../db/repositories/aiRoutingRulesRepo');
const { ALL_AGENT_IDS } = require('../config/agentRoles');
const { ALL_STAGE_KEYS, STAGE_CATALOG } = require('../config/stageTaxonomy');
const aiModelRegistryService = require('../services/aiModelRegistryService');
const { syncFromGemini } = require('../services/aiModelSyncService');
const aiStageCatalogRepo = require('../db/repositories/aiStageCatalogRepo');
const aiGlobalPoliciesRepo = require('../db/repositories/aiGlobalPoliciesRepo');
const aiRoutingDecisionsRepo = require('../db/repositories/aiRoutingDecisionsRepo');
const aiModelHealthRepo = require('../db/repositories/aiModelHealthRepo');
const routingMatrixService = require('../services/routingMatrixService');
const runRepo = require('../db/repositories/runRepo');
const aiUsageAnalyticsService = require('../services/aiUsageAnalyticsService');

const router = express.Router();

const ROUTING_MODES = new Set(['auto', 'economy', 'balanced', 'quality', 'manual']);
const OVERRIDE_SCOPES = new Set(['global', 'agent', 'phase', 'document']);

function parsePositiveInt(raw, fieldName) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        const err = new Error(`Некорректный ${fieldName}`);
        err.status = 400;
        throw err;
    }
    return n;
}

function optionalPositiveInt(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function optionalNonNegativeInt(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function buildAuditMeta(req) {
    return {
        ip: req.ip || null,
        user_agent: req.get('user-agent') || null,
        method: req.method,
        path: req.originalUrl || req.url,
    };
}

async function appendAudit(req, {
    action,
    entityType,
    entityId = null,
    beforeState = null,
    afterState = null,
}) {
    return aiModelRegistryService.appendAuditEvent({
        actorUserId: req.user?.id || null,
        action,
        entityType,
        entityId,
        beforeState,
        afterState,
        requestMeta: buildAuditMeta(req),
    });
}

function validateRoutingMode(value) {
    if (!ROUTING_MODES.has(String(value || '').trim())) {
        const err = new Error('Некорректный routing_mode');
        err.status = 400;
        throw err;
    }
}

function validatePhase(phase) {
    if (!ALL_AGENT_IDS.includes(phase) && !ALL_STAGE_KEYS.includes(phase)) {
        const err = new Error('Некорректный phase / stage_key');
        err.status = 400;
        throw err;
    }
}

function validateRoutingActions(actions) {
    if (actions == null || typeof actions !== 'object' || Array.isArray(actions)) {
        const err = new Error('Некорректный actions');
        err.status = 400;
        throw err;
    }
    if (actions.primary_api_model_id != null && typeof actions.primary_api_model_id !== 'string') {
        const err = new Error('actions.primary_api_model_id должен быть строкой');
        err.status = 400;
        throw err;
    }
    if (actions.fallback_api_model_ids != null && !Array.isArray(actions.fallback_api_model_ids)) {
        const err = new Error('actions.fallback_api_model_ids должен быть массивом');
        err.status = 400;
        throw err;
    }
}

router.get(
    '/models',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const snapshot = await aiModelRegistryService.getRegistrySnapshot({
                provider: 'google',
                tier: config.GEMINI_QUOTA_TIER || 'free',
                includeDisabled: true,
                includePreviews: true,
            });
            res.json({ ok: true, ...snapshot });
        } catch (e) {
            next(e);
        }
    },
);

router.post(
    '/models/sync',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const disableMissingFromApi = !!req.body?.disableMissingFromApi;
            const result = await syncFromGemini({ disableMissingFromApi });
            await appendAudit(req, {
                action: 'models_sync',
                entityType: 'ai_models',
                entityId: null,
                afterState: { disableMissingFromApi, result },
            });
            res.json(result);
        } catch (e) {
            next(e);
        }
    },
);

router.patch(
    '/models/:id',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'Некорректный id' });
            }
            const existing = await aiModelsRepo.getModelById(id);
            if (!existing) {
                const err = new Error('Модель не найдена');
                err.status = 404;
                throw err;
            }

            const body = req.body || {};
            const patch = {};
            if (body.ui_name !== undefined) patch.ui_name = body.ui_name;
            if (body.category !== undefined) patch.category = body.category;
            if (body.model_role !== undefined) patch.model_role = body.model_role;
            if (body.is_enabled !== undefined) patch.is_enabled = !!body.is_enabled;
            if (body.is_preview !== undefined) patch.is_preview = !!body.is_preview;
            if (body.api_model_id !== undefined) patch.api_model_id = body.api_model_id;
            if (body.base_model_id !== undefined) {
                if (body.base_model_id === null) {
                    patch.base_model_id = null;
                } else {
                    const bid = parseInt(body.base_model_id, 10);
                    if (!Number.isFinite(bid) || bid <= 0) {
                        return res.status(400).json({ error: 'Некорректный base_model_id' });
                    }
                    patch.base_model_id = bid;
                }
            }
            if (body.metadata !== undefined && typeof body.metadata === 'object') {
                patch.metadata = body.metadata;
            }

            if (Object.keys(patch).length === 0) {
                return res.status(400).json({ error: 'Нет полей для обновления' });
            }

            const before = { ...existing };
            const updated = await aiModelsRepo.updateModelById(id, patch, { mergeMetadata: true });
            aiModelRegistryService.invalidateRegistryCache();
            await appendAudit(req, {
                action: 'model_updated',
                entityType: 'ai_model',
                entityId: id,
                beforeState: before,
                afterState: updated,
            });
            res.json({ ok: true, model: updated });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/routing-matrix',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const previewMode = String(req.query.preview_mode || req.query.mode || 'auto').trim();
            const includeLastDecision = req.query.include_last_decision !== 'false';
            const data = await routingMatrixService.getRoutingMatrix({
                previewMode,
                includeLastDecision,
            });
            res.json(data);
        } catch (e) {
            next(e);
        }
    },
);

router.post(
    '/routing-rules/bulk-patch',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const items = Array.isArray(req.body?.items) ? req.body.items : [];
            if (!items.length) {
                return res.status(400).json({ error: 'items обязателен (непустой массив)' });
            }
            const results = [];
            for (const item of items) {
                const rawId = item.rule_id ?? item.ruleId;
                if (rawId == null || rawId === '') {
                    results.push({ ok: false, error: 'rule_id обязателен' });
                    continue;
                }
                let ruleId;
                try {
                    ruleId = parsePositiveInt(rawId, 'rule_id');
                } catch (err) {
                    results.push({ ok: false, error: err.message || 'Некорректный rule_id' });
                    continue;
                }
                const patch = item.patch || {};
                try {
                    const patchSvc = {};
                    if (patch.name !== undefined) patchSvc.name = patch.name;
                    if (patch.phase !== undefined) {
                        validatePhase(patch.phase);
                        patchSvc.phase = patch.phase;
                    }
                    if (patch.priority !== undefined) patchSvc.priority = Number(patch.priority || 0);
                    if (patch.is_enabled !== undefined) patchSvc.isEnabled = !!patch.is_enabled;
                    if (patch.conditions !== undefined) patchSvc.conditions = patch.conditions;
                    if (patch.actions !== undefined) {
                        validateRoutingActions(patch.actions);
                        patchSvc.actions = patch.actions;
                    }
                    if (patch.stage_key !== undefined) patchSvc.stageKey = patch.stage_key;
                    if (patch.allow_premium !== undefined) patchSvc.allowPremium = !!patch.allow_premium;
                    if (patch.allow_preview !== undefined) patchSvc.allowPreview = !!patch.allow_preview;
                    if (patch.stable_only !== undefined) patchSvc.stableOnly = !!patch.stable_only;
                    if (patch.max_escalation_depth !== undefined) {
                        patchSvc.maxEscalationDepth = Number(patch.max_escalation_depth);
                    }
                    const before = await aiRoutingRulesRepo.getRuleById(ruleId);
                    if (!before) {
                        results.push({ rule_id: ruleId, ok: false, error: 'Rule не найден' });
                        continue;
                    }
                    await aiModelRegistryService.updateRoutingRule(ruleId, patchSvc);
                    const after = await aiRoutingRulesRepo.getRuleById(ruleId);
                    await appendAudit(req, {
                        action: 'routing_rule_bulk_patch',
                        entityType: 'ai_routing_rule',
                        entityId: ruleId,
                        beforeState: before,
                        afterState: after,
                    });
                    results.push({ rule_id: ruleId, ok: true, rule: after });
                } catch (err) {
                    results.push({ rule_id: ruleId, ok: false, error: err.message || String(err) });
                }
            }
            res.json({ ok: true, results });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/routing-rules/:phase',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const phase = String(req.params.phase || '').trim();
            validatePhase(phase);
            const enabledOnly = req.query.enabled_only !== 'false';
            const rules = await aiModelRegistryService.listRoutingRules(phase, { enabledOnly });
            res.json({ ok: true, phase, enabled_only: enabledOnly, rules });
        } catch (e) {
            next(e);
        }
    },
);

router.post(
    '/routing-rules',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const body = req.body || {};
            if (!body.name || typeof body.name !== 'string') {
                return res.status(400).json({ error: 'name обязателен' });
            }
            validatePhase(body.phase);
            if (body.conditions != null && typeof body.conditions !== 'object') {
                return res.status(400).json({ error: 'conditions должен быть объектом' });
            }
            validateRoutingActions(body.actions || {});
            const id = await aiModelRegistryService.createRoutingRule({
                name: body.name.trim(),
                phase: body.phase,
                priority: Number(body.priority || 0),
                isEnabled: body.is_enabled !== false,
                conditions: body.conditions || {},
                actions: body.actions || {},
                stageKey: body.stage_key != null ? body.stage_key : null,
                allowPremium: body.allow_premium === true,
                allowPreview: body.allow_preview === true,
                stableOnly: body.stable_only !== false,
                maxEscalationDepth: Number(body.max_escalation_depth ?? 1),
            });
            const rule = await aiModelRegistryService.listRoutingRules(body.phase, { enabledOnly: false });
            const created = rule.find((r) => r.id === id) || { id };
            await appendAudit(req, {
                action: 'routing_rule_created',
                entityType: 'ai_routing_rule',
                entityId: id,
                afterState: created,
            });
            res.json({ ok: true, rule: created });
        } catch (e) {
            next(e);
        }
    },
);

router.patch(
    '/routing-rules/:id',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            const body = req.body || {};
            const patch = {};
            if (body.name !== undefined) patch.name = body.name;
            if (body.phase !== undefined) { validatePhase(body.phase); patch.phase = body.phase; }
            if (body.priority !== undefined) patch.priority = Number(body.priority || 0);
            if (body.is_enabled !== undefined) patch.isEnabled = !!body.is_enabled;
            if (body.conditions !== undefined) {
                if (typeof body.conditions !== 'object' || Array.isArray(body.conditions)) {
                    return res.status(400).json({ error: 'conditions должен быть объектом' });
                }
                patch.conditions = body.conditions;
            }
            if (body.actions !== undefined) {
                validateRoutingActions(body.actions);
                patch.actions = body.actions;
            }
            if (body.stage_key !== undefined) patch.stageKey = body.stage_key;
            if (body.allow_premium !== undefined) patch.allowPremium = !!body.allow_premium;
            if (body.allow_preview !== undefined) patch.allowPreview = !!body.allow_preview;
            if (body.stable_only !== undefined) patch.stableOnly = !!body.stable_only;
            if (body.max_escalation_depth !== undefined) {
                patch.maxEscalationDepth = Number(body.max_escalation_depth);
            }
            const before = await aiRoutingRulesRepo.getRuleById(id);
            if (!before) {
                const err = new Error('Rule не найден');
                err.status = 404;
                throw err;
            }
            await aiModelRegistryService.updateRoutingRule(id, patch);
            const after = await aiRoutingRulesRepo.getRuleById(id);
            await appendAudit(req, {
                action: 'routing_rule_updated',
                entityType: 'ai_routing_rule',
                entityId: id,
                beforeState: before,
                afterState: after,
            });
            res.json({ ok: true, rule: after });
        } catch (e) {
            next(e);
        }
    },
);

router.patch(
    '/routing-rules/:id/enabled',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            if (typeof req.body?.is_enabled === 'undefined') {
                return res.status(400).json({ error: 'is_enabled обязателен' });
            }
            const before = await aiRoutingRulesRepo.getRuleById(id);
            if (!before) {
                const err = new Error('Rule не найден');
                err.status = 404;
                throw err;
            }
            await aiModelRegistryService.enableRoutingRule(id, !!req.body.is_enabled);
            const after = await aiRoutingRulesRepo.getRuleById(id);
            await appendAudit(req, {
                action: 'routing_rule_enabled_toggle',
                entityType: 'ai_routing_rule',
                entityId: id,
                beforeState: before,
                afterState: after,
            });
            res.json({ ok: true, rule: after });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/usage',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const rows = await aiModelRegistryService.listUsage({
                fromDate: req.query.from || null,
                toDate: req.query.to || null,
                phase: req.query.phase || null,
                apiModelId: req.query.model_id || null,
                keyFingerprint: req.query.key_fingerprint || null,
                limit: optionalPositiveInt(req.query.limit, 100),
                offset: optionalNonNegativeInt(req.query.offset, 0),
            });
            res.json({ ok: true, rows });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/routing-mode',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const cfg = await aiModelRegistryService.getRoutingMode();
            res.json({ ok: true, routing_mode: cfg.routing_mode, updated_at: cfg.updated_at, metadata: cfg.metadata });
        } catch (e) {
            next(e);
        }
    },
);

router.put(
    '/routing-mode',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const routingMode = String(req.body?.routing_mode || '').trim();
            validateRoutingMode(routingMode);
            const before = await aiModelRegistryService.getRoutingMode();
            const row = await aiModelRegistryService.setRoutingMode({
                routingMode,
                updatedBy: req.user?.id || null,
                metadata: req.body?.metadata || {},
            });
            await appendAudit(req, {
                action: 'routing_mode_changed',
                entityType: 'ai_routing_config',
                entityId: 1,
                beforeState: before,
                afterState: row,
            });
            res.json({ ok: true, routing_mode: row.routing_mode, updated_at: row.updated_at, metadata: row.metadata });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/manual-overrides',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const rows = await aiModelRegistryService.listManualOverrides({
                includeDisabled: req.query.include_disabled === 'true',
                scope: req.query.scope || null,
                activeOnly: req.query.active_only === 'true',
                limit: optionalPositiveInt(req.query.limit, 100),
                offset: optionalNonNegativeInt(req.query.offset, 0),
            });
            res.json({ ok: true, rows });
        } catch (e) {
            next(e);
        }
    },
);

router.post(
    '/manual-overrides',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const body = req.body || {};
            const scope = String(body.scope || '').trim();
            if (!OVERRIDE_SCOPES.has(scope)) {
                return res.status(400).json({ error: 'Некорректный scope' });
            }
            const target = body.target == null ? '' : String(body.target);
            if (scope !== 'global' && !target) {
                return res.status(400).json({ error: 'target обязателен для scope != global' });
            }
            const modelId = parsePositiveInt(body.model_id, 'model_id');
            const model = await aiModelsRepo.getModelById(modelId);
            if (!model) {
                return res.status(400).json({ error: 'model_id не найден' });
            }
            const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;
            if (body.expires_at && Number.isNaN(Date.parse(body.expires_at))) {
                return res.status(400).json({ error: 'Некорректный expires_at (ISO date expected)' });
            }
            const row = await aiModelRegistryService.createManualOverride({
                scope,
                target,
                modelId,
                isEnabled: body.is_enabled !== false,
                priority: Number(body.priority || 0),
                conditions: body.conditions || {},
                expiresAt,
                reason: body.reason || null,
                createdBy: req.user?.id || null,
            });
            await appendAudit(req, {
                action: 'manual_override_created',
                entityType: 'ai_manual_override',
                entityId: row.id,
                afterState: row,
            });
            res.json({ ok: true, override: row });
        } catch (e) {
            next(e);
        }
    },
);

router.patch(
    '/manual-overrides/:id',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            const before = await aiModelRegistryService.getManualOverrideById(id);
            if (!before) {
                const err = new Error('Override не найден');
                err.status = 404;
                throw err;
            }
            const body = req.body || {};
            const patch = {};
            if (body.scope !== undefined) {
                if (!OVERRIDE_SCOPES.has(String(body.scope || '').trim())) {
                    return res.status(400).json({ error: 'Некорректный scope' });
                }
                patch.scope = String(body.scope).trim();
            }
            if (body.target !== undefined) patch.target = String(body.target || '');
            if (body.model_id !== undefined) {
                const modelId = parsePositiveInt(body.model_id, 'model_id');
                const model = await aiModelsRepo.getModelById(modelId);
                if (!model) return res.status(400).json({ error: 'model_id не найден' });
                patch.modelId = modelId;
            }
            if (body.is_enabled !== undefined) patch.isEnabled = !!body.is_enabled;
            if (body.priority !== undefined) patch.priority = Number(body.priority || 0);
            if (body.conditions !== undefined) {
                if (typeof body.conditions !== 'object' || Array.isArray(body.conditions)) {
                    return res.status(400).json({ error: 'conditions должен быть объектом' });
                }
                patch.conditions = body.conditions;
            }
            if (body.expires_at !== undefined) {
                if (body.expires_at === null || body.expires_at === '') patch.expiresAt = null;
                else if (Number.isNaN(Date.parse(body.expires_at))) {
                    return res.status(400).json({ error: 'Некорректный expires_at (ISO date expected)' });
                } else {
                    patch.expiresAt = new Date(body.expires_at).toISOString();
                }
            }
            if (body.reason !== undefined) patch.reason = body.reason == null ? null : String(body.reason);
            patch.updatedBy = req.user?.id || null;

            const row = await aiModelRegistryService.updateManualOverride(id, patch);
            await appendAudit(req, {
                action: 'manual_override_updated',
                entityType: 'ai_manual_override',
                entityId: id,
                beforeState: before,
                afterState: row,
            });
            res.json({ ok: true, override: row });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/audit',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const rows = await aiModelRegistryService.listAudit({
                entityType: req.query.entity_type || null,
                actorUserId: optionalPositiveInt(req.query.actor_user_id, null),
                limit: optionalPositiveInt(req.query.limit, 100),
                offset: optionalNonNegativeInt(req.query.offset, 0),
            });
            res.json({ ok: true, rows });
        } catch (e) {
            next(e);
        }
    },
);

// ─── Stage Catalog ──────────────────────────────────────────────────────────

router.get(
    '/stages',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const activeOnly = req.query.active_only !== 'false';
            const rows = await aiStageCatalogRepo.listStages({ activeOnly });
            res.json({ ok: true, stages: rows });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/stages/:stageKey',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const row = await aiStageCatalogRepo.getStageByKey(req.params.stageKey);
            if (!row) return res.status(404).json({ error: 'Stage not found' });
            res.json({ ok: true, stage: row });
        } catch (e) {
            next(e);
        }
    },
);

// ─── Global Policies ────────────────────────────────────────────────────────

router.get(
    '/global-policies',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const policies = await aiGlobalPoliciesRepo.getPolicies();
            res.json({ ok: true, policies: policies || {} });
        } catch (e) {
            next(e);
        }
    },
);

router.patch(
    '/global-policies',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const body = req.body || {};
            if (body.routing_mode !== undefined) validateRoutingMode(body.routing_mode);
            const before = await aiGlobalPoliciesRepo.getPolicies();
            const after = await aiGlobalPoliciesRepo.updatePolicies(body, {
                updatedBy: req.user?.id || null,
            });

            try {
                const routingEngine = require('../services/routingEngine');
                routingEngine.invalidatePolicies();
            } catch { /* optional */ }

            await appendAudit(req, {
                action: 'global_policies_updated',
                entityType: 'ai_global_policies',
                entityId: 1,
                beforeState: before,
                afterState: after,
            });
            res.json({ ok: true, policies: after });
        } catch (e) {
            next(e);
        }
    },
);

// ─── Routing Decisions (explainable log) ────────────────────────────────────

router.get(
    '/routing-decisions',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const rows = await aiRoutingDecisionsRepo.listDecisions({
                runId: req.query.run_id ? Number(req.query.run_id) : null,
                documentId: req.query.document_id ? Number(req.query.document_id) : null,
                stageKey: req.query.stage_key || null,
                selectedApiModelId: req.query.model_id || null,
                limit: optionalPositiveInt(req.query.limit, 100),
                offset: optionalNonNegativeInt(req.query.offset, 0),
            });
            res.json({ ok: true, rows });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/routing-decisions/:id',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            const row = await aiRoutingDecisionsRepo.getDecisionById(id);
            if (!row) return res.status(404).json({ error: 'Decision not found' });
            res.json({ ok: true, decision: row });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/routing-decisions/:id/explain',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            const row = await aiRoutingDecisionsRepo.getDecisionById(id);
            if (!row) return res.status(404).json({ error: 'Decision not found' });
            
            let status = 'matched';
            if (row.was_fallback || row.selected_api_model_id !== (row.candidate_snapshot?.target_model || row.candidate_snapshot?.primary_api_model_id)) {
                status = 'downgraded';
            }
            if (!row.selected_api_model_id) {
                status = 'skipped';
            }
            if (row.decision_reason === 'fail_fast' || row.decision_reason?.includes('error')) {
                status = 'failed';
            }

            const targetModel = row.candidate_snapshot?.target_model || row.candidate_snapshot?.primary_api_model_id || 'auto';

            let parsedChain = row.fallback_chain;
            if (typeof parsedChain === 'string') {
                try { parsedChain = JSON.parse(parsedChain); } catch(e) { parsedChain = []; }
            }

            const response = {
                decision_id: row.id,
                timestamp: row.created_at,
                summary: {
                    status,
                    target_model: targetModel,
                    effective_model: row.selected_api_model_id
                },
                flags: {
                    was_fallback: !!row.was_fallback,
                    premium_blocked: !!row.premium_blocked,
                    preview_blocked: !!row.preview_blocked,
                    manual_override_active: !!row.manual_override_id
                },
                chain: [
                    {
                        step: 'intention',
                        title: 'Pipeline Request',
                        details: {
                            stage: row.stage_key,
                            routing_mode: row.candidate_snapshot?.routing_mode || row.policy_snapshot?.routing_mode || 'auto',
                            complexity_score: row.candidate_snapshot?.complexity_score || null,
                            estimated_tokens: row.candidate_snapshot?.estimated_tokens || null
                        }
                    },
                    {
                        step: 'resolution',
                        title: 'Applied Rule',
                        details: {
                            source: row.decision_source,
                            profile_name: row.candidate_snapshot?.profile || null,
                            selected_primary: targetModel,
                            premium_eligible: row.candidate_snapshot?.premium_eligible || false
                        }
                    },
                    {
                        step: 'guards',
                        title: 'Quota & Guard Check',
                        details: {
                            passed: !row.was_fallback && !row.premium_blocked,
                            block_reason: row.fallback_reason || (row.premium_blocked ? 'premium_blocked_by_limits' : null),
                            fallback_triggered: row.was_fallback ? row.selected_api_model_id : null
                        }
                    },
                    {
                        step: 'health_check',
                        title: 'Model Health / Execution',
                        details: {
                            model: row.selected_api_model_id,
                            status: row.latency_ms ? 'healthy' : (row.selected_api_model_id ? 'resolved' : 'skipped'),
                            ping_ms: row.latency_ms || null
                        }
                    }
                ],
                diagnostics: {
                    quota_pressure: row.quota_snapshot || {},
                    policy_snapshot: row.policy_snapshot || {},
                    fallback_chain_attempted: parsedChain || []
                }
            };
            
            res.json({ ok: true, explain: response });
        } catch (e) {
            next(e);
        }
    }
);

// ─── Model Health ───────────────────────────────────────────────────────────

router.get(
    '/model-health',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const rows = await aiModelHealthRepo.listAllLatest({
                limit: optionalPositiveInt(req.query.limit, 200),
            });
            res.json({ ok: true, rows });
        } catch (e) {
            next(e);
        }
    },
);

router.get(
    '/model-health/:modelId',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const modelId = parsePositiveInt(req.params.modelId, 'modelId');
            const row = await aiModelHealthRepo.getLatestHealth(modelId);
            res.json({ ok: true, health: row });
        } catch (e) {
            next(e);
        }
    },
);

// ─── Routing Rules with stage_key support ───────────────────────────────────

router.get(
    '/routing-rules-by-stage/:stageKey',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const stageKey = req.params.stageKey;
            if (!ALL_STAGE_KEYS.includes(stageKey)) {
                return res.status(400).json({ error: 'Некорректный stage_key' });
            }
            const enabledOnly = req.query.enabled_only !== 'false';
            const allRules = await aiRoutingRulesRepo.listRules({ enabledOnly });
            const filtered = allRules.filter(r => r.stage_key === stageKey);
            res.json({ ok: true, stage_key: stageKey, rules: filtered });
        } catch (e) {
            next(e);
        }
    },
);
// ─── Routing Tariffs ────────────────────────────────────────────────────────
const aiRoutingTariffsRepo = require('../db/repositories/aiRoutingTariffsRepo');
const routingService = require('../services/generation/routingService');

router.get(
    '/routing-profiles',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const profiles = await aiRoutingTariffsRepo.getAllProfiles();
            for (let p of profiles) {
                p.rules = (await aiRoutingTariffsRepo.getProfileWithRules(p.code))?.rules || [];
            }
            res.json({ ok: true, profiles });
        } catch (e) {
            next(e);
        }
    }
);

router.put(
    '/routing-profiles/:code/rules/:stage_name',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const code = req.params.code;
            const stage = req.params.stage_name;
            const body = req.body || {};
            const rule = await aiRoutingTariffsRepo.updateStageRule(code, stage, body);
            res.json({ ok: true, rule });
        } catch (e) {
            next(e);
        }
    }
);

router.post(
    '/router/resolve',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const profile = req.body.profile;
            const stage = req.body.stage;
            const estimatedTokens = req.body.context_size_estimated || 0;
            
            const resolution = await routingService.resolveRoute(profile, stage, { estimatedTokens });
            res.json({ ok: true, resolution });
        } catch (e) {
            res.status(400).json({ ok: false, error: e.message });
        }
    }
);

// ─── Observability (Runs) ───────────────────────────────────────────────────

router.get(
    '/runs',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const { status, document_id, limit, offset } = req.query;
            const docId = document_id ? parseInt(document_id, 10) : null;
            
            const result = await runRepo.listRuns({
                status,
                documentId: docId && !isNaN(docId) ? docId : null,
                limit: optionalPositiveInt(limit, 50),
                offset: optionalNonNegativeInt(offset, 0)
            });

            const runsWithSummary = result.rows.map(r => {
                let fallbacks = [];
                try {
                    fallbacks = typeof r.fallback_decisions === 'string' ? JSON.parse(r.fallback_decisions) : (r.fallback_decisions || []);
                } catch(e) {}
                
                return {
                    id: r.id,
                    document_id: r.document_id,
                    status: (r.status === 'completed' && fallbacks.length > 0) ? 'degraded' : r.status,
                    target_count: r.target_count,
                    language: r.language,
                    created_at: r.created_at,
                    finished_at: r.finished_at,
                    duration_ms: r.duration_ms,
                    summary: {
                        fallback_triggered: fallbacks.length > 0,
                        errors_count: r.error_message ? 1 : 0
                    }
                };
            });

            res.json({ ok: true, runs: runsWithSummary, total: result.total });
        } catch (e) {
            next(e);
        }
    }
);

router.get(
    '/runs/:id',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const id = parsePositiveInt(req.params.id, 'id');
            const run = await runRepo.getRunById(id);
            if (!run) return res.status(404).json({ error: 'Run not found' });

            const [events, intents, questions, routingDecisions] = await Promise.all([
                runRepo.getPipelineEventsForRun(id),
                runRepo.getIntentsForRun(id),
                runRepo.getQuestionsForRun(id),
                aiRoutingDecisionsRepo.listDecisions({ runId: id, limit: 100 })
            ]);

            // Map routing decisions by stage
            const decisionsByStage = {};
            for (const dec of routingDecisions) {
                decisionsByStage[dec.stage_key] = dec;
            }

            // Build Timeline
            const timelineMap = new Map();
            for (const ev of events) {
                if (!timelineMap.has(ev.phase)) {
                    timelineMap.set(ev.phase, {
                        stage_name: ev.phase,
                        status: 'success', // will be overwritten if errors occur
                        events: [],
                        routing: decisionsByStage[ev.phase] ? {
                            decision_id: decisionsByStage[ev.phase].id,
                            selected_model: decisionsByStage[ev.phase].selected_api_model_id,
                            was_fallback: decisionsByStage[ev.phase].was_fallback,
                            reason: decisionsByStage[ev.phase].decision_reason
                        } : null
                    });
                }
                const phaseGroup = timelineMap.get(ev.phase);
                phaseGroup.events.push({ time: ev.created_at, event: ev.event, level: ev.level });
                
                if (ev.level === 'error' || ev.level === 'fatal') {
                    phaseGroup.status = 'error';
                } else if (ev.level === 'warn' && phaseGroup.status === 'success') {
                    phaseGroup.status = 'warning';
                }
            }

            let fallbacks = [];
            try { fallbacks = typeof run.fallback_decisions === 'string' ? JSON.parse(run.fallback_decisions) : (run.fallback_decisions || []); } catch(e) {}

            const response = {
                run: {
                    ...run,
                    status: (run.status === 'completed' && fallbacks.length > 0) ? 'degraded' : run.status,
                },
                stats: {
                    intents_planned: intents.length,
                    questions_accepted: questions.length,
                    fallback_rate_percent: fallbacks.length > 0 ? 100 : 0 // Simplified
                },
                timeline: Array.from(timelineMap.values())
            };

            res.json({ ok: true, ...response });
        } catch (e) {
            next(e);
        }
    }
);

// ─── Usage / Cost Breakdown ─────────────────────────────────────────────────

router.get(
    '/usage-overview',
    requireAuth,
    requireAdmin,
    async (req, res, next) => {
        try {
            const period = req.query.period || '7d';
            const data = await aiUsageAnalyticsService.getUsageOverview(period);
            res.json({ ok: true, period, ...data });
        } catch (e) {
            next(e);
        }
    }
);

module.exports = router;
