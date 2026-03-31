const pg = require('../db/pgPool');

const COST_PER_1M_TOKENS = {
    'gemini-2.5-pro': 1.25,
    'gemini-2.5-flash': 0.075,
    'gemini-2.5-flash-lite': 0.075
};

function getDays(periodStr) {
    const match = periodStr.match(/^(\d+)d$/);
    return match ? parseInt(match[1], 10) : 7;
}

async function getUsageOverview(periodStr = '7d') {
    const days = getDays(periodStr);
    const dateLimit = `NOW() - INTERVAL '${days} days'`;

    // 1. Model Usage Aggregation
    const { rows: usageRows } = await pg.query(`
        SELECT 
            m.api_model_id,
            m.model_role,
            SUM(u.requests) as total_requests,
            SUM(u.tpm_estimated) as total_tokens
        FROM ai_model_usage u
        JOIN ai_models m ON m.id = u.ai_model_id
        WHERE u.usage_date >= ${dateLimit}
        GROUP BY m.api_model_id, m.model_role
    `);

    let totalRequests = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    const breakdownByModel = [];

    for (const row of usageRows) {
        const reqs = Number(row.total_requests || 0);
        const toks = Number(row.total_tokens || 0);
        
        totalRequests += reqs;
        totalTokens += toks;
        
        let costRate = COST_PER_1M_TOKENS[row.api_model_id] || 0.1;
        let modelCost = (toks / 1000000) * costRate;
        totalCostUsd += modelCost;

        breakdownByModel.push({
            model_id: row.api_model_id,
            model_role: row.model_role,
            requests: reqs,
            tokens: toks,
            cost: Number(modelCost.toFixed(3))
        });
    }

    breakdownByModel.sort((a,b) => b.requests - a.requests);

    // 2. Routing Decisions Analytics
    const { rows: routingRows } = await pg.query(`
        SELECT 
            COUNT(id) as total_decisions,
            COUNT(CASE WHEN was_fallback = true THEN 1 END) as fallback_count,
            COUNT(CASE WHEN premium_blocked = true THEN 1 END) as premium_blocked_count
        FROM ai_routing_decisions
        WHERE created_at >= ${dateLimit}
    `);

    const routingData = routingRows[0];
    const totalDecisions = parseInt(routingData.total_decisions || 0, 10);
    const fallbackCount = parseInt(routingData.fallback_count || 0, 10);
    const premiumBlockedCount = parseInt(routingData.premium_blocked_count || 0, 10);

    const fallbackRatePercent = totalDecisions > 0 ? (fallbackCount / totalDecisions) * 100 : 0;

    // 3. Breakdown by Stage
    const { rows: stageRows } = await pg.query(`
        SELECT 
            stage_key,
            COUNT(id) as requests,
            COUNT(CASE WHEN was_fallback = true THEN 1 END) as fallback_count
        FROM ai_routing_decisions
        WHERE created_at >= ${dateLimit}
        GROUP BY stage_key
        ORDER BY COUNT(id) DESC
    `);

    const breakdownByStage = stageRows.map(r => {
        const reqs = parseInt(r.requests || 0, 10);
        const fallbacks = parseInt(r.fallback_count || 0, 10);
        return {
            stage: r.stage_key,
            requests: reqs,
            was_fallback_percent: reqs > 0 ? Number(((fallbacks / reqs) * 100).toFixed(1)) : 0
        };
    });

    // 4. Top Blocker Reasons
    const { rows: blockerRows } = await pg.query(`
        SELECT 
            decision_reason,
            COUNT(id) as count
        FROM ai_routing_decisions
        WHERE created_at >= ${dateLimit} AND (was_fallback = true OR decision_reason != 'auto' AND decision_reason != 'engine')
        GROUP BY decision_reason
        ORDER BY COUNT(id) DESC
        LIMIT 5
    `);

    const topBlockerReasons = blockerRows.map(r => ({
        reason: r.decision_reason,
        count: parseInt(r.count, 10)
    }));

    // 5. Timeseries (Simple Daily Requests)
    const { rows: timeseriesRows } = await pg.query(`
        SELECT 
            DATE(created_at) as date,
            COUNT(id) as total_requests,
            COUNT(CASE WHEN was_fallback = true THEN 1 END) as downgrades
        FROM ai_routing_decisions
        WHERE created_at >= ${dateLimit}
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at) ASC
    `);

    const timeseries = timeseriesRows.map(r => ({
        date: r.date,
        economy_requests: Math.floor(parseInt(r.total_requests, 10) * 0.4), // Mocked partition for UI
        standard_requests: Math.floor(parseInt(r.total_requests, 10) * 0.5),
        premium_requests: Math.floor(parseInt(r.total_requests, 10) * 0.1),
        downgrades: parseInt(r.downgrades, 10)
    }));

    // Smart Alerts Engine
    const alerts = [];
    if (premiumBlockedCount > 100) {
        alerts.push({
            type: "warning",
            message: `Premium Guard сработал ${premiumBlockedCount} раз за период. Подумайте об отключении премиум-доступа на тяжелых стадиях.`
        });
    }
    const strugglingStage = breakdownByStage.find(s => s.was_fallback_percent > 30 && s.requests > 10);
    if (strugglingStage) {
        alerts.push({
            type: "recommendation",
            message: `Стадия '${strugglingStage.stage}' постоянно вызывает Fallback (${strugglingStage.was_fallback_percent}% случаев). Жестко закрепите более дешевую или стабильную модель в Tariffs.`
        });
    }

    return {
        hero_metrics: {
            total_requests: totalRequests || totalDecisions,
            total_tokens: totalTokens,
            estimated_cost_usd: Number(totalCostUsd.toFixed(3)),
            fallback_rate_percent: Number(fallbackRatePercent.toFixed(1)),
            premium_blocked_count: premiumBlockedCount
        },
        alerts_and_recommendations: alerts,
        timeseries,
        breakdown_by_model: breakdownByModel,
        breakdown_by_stage: breakdownByStage,
        top_blocker_reasons: topBlockerReasons
    };
}

module.exports = {
    getUsageOverview
};
