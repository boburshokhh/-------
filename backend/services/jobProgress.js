const { logStructured } = require('../utils/observability');
const jobProgressRepo = require('../db/repositories/jobProgressRepo');
const config = require('../config');

// ── Redis Pub/Sub publisher (lazy, best-effort) ───────────────────────────────
let _publisher = null;
let _pubAvailable = false;
let _pubChecked = false;

function getPublisher() {
    if (!config.SSE_ENABLED || !config.JOB_QUEUE_ENABLED) return null;
    if (!_pubChecked) {
        _pubChecked = true;
        try {
            const { newConnection } = require('../db/redisClient');
            _publisher = newConnection(config.REDIS_DB_QUEUE ?? 0);
            _publisher.on('connect', () => { _pubAvailable = true; });
            _publisher.on('error', () => { _pubAvailable = false; });
        } catch { _pubAvailable = false; }
    }
    return _pubAvailable ? _publisher : null;
}

function publishProgress(jobId, data) {
    const pub = getPublisher();
    if (!pub) return;
    const channel = `job:${jobId}:progress`;
    pub.publish(channel, JSON.stringify(data)).catch(() => {});
}

/**
 * In-memory прогресс длительных задач (загрузка → индекс → генерация).
 * Дублируется в PostgreSQL (таблица job_progress), чтобы GET /api/jobs/:id работал
 * при нескольких инстансах за балансировщиком и не терялся при рестарте в пределах TTL.
 * Клиент передаёт X-Job-Id и опрашивает GET /api/jobs/:jobId
 *
 * Процент считается от объёма работ (workDone / workTotal), а не «на глаз».
 * До первого известного workTotal — volumeReady: false (процент на кольце не показываем как достоверный).
 */

const store = new Map();
const workAccum = new Map();
const progressHistory = new Map();

const TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY = 100;
const PERSIST_DEBOUNCE_MS = 80;

const persistTimers = new Map();
let persistWarned = false;

function buildSnapshot(jobId) {
    const e = store.get(jobId);
    if (!e) return null;
    const hist = progressHistory.get(jobId) || [];
    return {
        current: { ...e },
        history: hist.map((h) => ({ ...h })),
    };
}

function clearPersistTimer(jobId) {
    const t = persistTimers.get(jobId);
    if (t) {
        clearTimeout(t);
        persistTimers.delete(jobId);
    }
}

async function persistToDb(jobId) {
    const snapshot = buildSnapshot(jobId);
    if (!snapshot) return;
    try {
        await jobProgressRepo.upsert(jobId, snapshot);
    } catch (err) {
        if (!persistWarned) {
            persistWarned = true;
            console.warn('[JOB_PROGRESS] Не удалось сохранить прогресс в БД (будет только в памяти процесса):', err.message);
        }
    }
}

function schedulePersist(jobId) {
    clearPersistTimer(jobId);
    const t = setTimeout(() => {
        persistTimers.delete(jobId);
        void persistToDb(jobId);
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(jobId, t);
}

/**
 * Сразу записать текущее состояние задачи в БД (после первого log в middleware upload).
 */
async function flushPersist(jobId) {
    clearPersistTimer(jobId);
    await persistToDb(jobId);
}

/** Веса этапов (условные единицы «тяжёлых» шагов) — согласованы с indexer + generator */
const WEIGHT = {
    PARSE_READ: 2,
    PARSE_PARSED: 1,
    DB_SAVING: 1,
    DB_SAVED: 1,
    INDEX_SPLIT: 1,
    INDEX_EMBED_BATCH: 1,
    INDEX_SUMMARY: 1,
    INDEX_TAIL: 1,
    INDEX_CACHE_HIT: 1,
    GEN_LANG: 1,
    GEN_THEMES: 2,
    GEN_BLUEPRINT: 2,
    GEN_BATCH: 3,
    GEN_DEDUP: 2,
    GEN_FINALIZE: 1,
    GEN_READY: 1,
};

function getAccum(jobId) {
    let a = workAccum.get(jobId);
    if (!a) {
        a = {
            workDone: 0,
            workTotal: null,
            planEstMainBatches: null,
        };
        workAccum.set(jobId, a);
    }
    return a;
}

function cleanupJob(jobId) {
    clearPersistTimer(jobId);
    store.delete(jobId);
    workAccum.delete(jobId);
    progressHistory.delete(jobId);
    void jobProgressRepo.remove(jobId).catch(() => {});
}

function appendHistory(jobId, row) {
    const list = progressHistory.get(jobId) || [];
    const entry = {
        updatedAt: row.updatedAt,
        phase: row.phase,
        stage: row.stage,
        percent: row.percent,
        detail: row.detail,
        workDone: row.workDone,
        workTotal: row.workTotal,
        volumeReady: row.volumeReady,
    };
    list.push(entry);
    while (list.length > MAX_HISTORY) list.shift();
    progressHistory.set(jobId, list);
}

/**
 * После blueprint: уточняем workTotal, если реальное число LLM-батчей отличается от оценки при индексации.
 */
function refineMainBatchPlan(jobId, actualMainBatches) {
    const a = workAccum.get(jobId);
    if (!a || a.workTotal == null || actualMainBatches == null) return;
    const actual = Math.max(0, Math.floor(Number(actualMainBatches) || 0));
    const oldEst = a.planEstMainBatches;
    if (oldEst == null) return;
    const delta = (actual - oldEst) * WEIGHT.GEN_BATCH;
    a.planEstMainBatches = actual;
    if (delta <= 0) {
        return;
    }
    a.workTotal = Math.max(a.workDone + 1, a.workTotal + delta);
    logJobProgress(jobId, {
        phase: 'generate',
        stage: 'blueprint',
        detail: `План уточнён: ${actual} пакет(ов) генерации`,
    });
}

/**
 * Оценка суммарного веса этапа генерации (до первого батча), main-батчи — по верхней границе из конфига.
 */
function estimateGenerationTailUnits(config) {
    const batchSize = Math.max(3, Math.min(5, config.LLM_BATCH_SIZE || 4));
    const targetMax = config.TARGET_QUESTIONS_MAX || 30;
    const estMainBatches = Math.max(1, Math.ceil(targetMax / batchSize));
    const maxBf = config.BACKFILL_MAX_ROUNDS || 3;
    const backfillIntentCap = 20;
    const estBackfillBatches = maxBf * Math.max(1, Math.ceil(backfillIntentCap / batchSize));
    const genUnits = WEIGHT.GEN_LANG
        + WEIGHT.GEN_THEMES
        + WEIGHT.GEN_BLUEPRINT
        + estMainBatches * WEIGHT.GEN_BATCH
        + WEIGHT.GEN_DEDUP
        + WEIGHT.GEN_FINALIZE
        + WEIGHT.GEN_READY
        + estBackfillBatches * WEIGHT.GEN_BATCH;
    return { genUnits, estMainBatches };
}

/**
 * Вес индексации новых чанков (после split).
 */
function indexWorkloadUnits(newChunksLength, embedBatchSize) {
    if (newChunksLength <= 0) {
        return WEIGHT.INDEX_SPLIT + WEIGHT.INDEX_CACHE_HIT;
    }
    const embedBatches = Math.ceil(newChunksLength / Math.max(1, embedBatchSize));
    return WEIGHT.INDEX_SPLIT
        + embedBatches * WEIGHT.INDEX_EMBED_BATCH
        + newChunksLength * WEIGHT.INDEX_SUMMARY
        + WEIGHT.INDEX_TAIL;
}

function setJob(jobId, data) {
    store.set(jobId, { ...data, updatedAt: Date.now() });
}

async function getJob(jobId) {
    const e = store.get(jobId);
    if (e) {
        if (Date.now() - e.updatedAt > TTL_MS) {
            logStructured({
                level: 'warn',
                traceId: jobId,
                phase: e.phase || null,
                event: 'job_state_expired',
                metadata: {
                    last_updated_at: e.updatedAt,
                    ttl_ms: TTL_MS,
                },
            });
            cleanupJob(jobId);
            return null;
        }
        const hist = progressHistory.get(jobId) || [];
        return { ...e, history: hist };
    }

    let row;
    try {
        row = await jobProgressRepo.getById(jobId);
    } catch (err) {
        if (!persistWarned) {
            persistWarned = true;
            console.warn('[JOB_PROGRESS] Чтение прогресса из БД недоступно:', err.message);
        }
        return null;
    }
    if (!row) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > TTL_MS) {
        void jobProgressRepo.remove(jobId).catch(() => {});
        return null;
    }
    const cur = row.payload && row.payload.current;
    const hist = Array.isArray(row.payload?.history) ? row.payload.history : [];
    if (!cur || typeof cur !== 'object') return null;
    return { ...cur, history: hist };
}

function clearJob(jobId) {
    cleanupJob(jobId);
}

/**
 * @param {string} jobId
 * @param {object} payload
 * @param {number} [payload.workDelta] — прибавить к workDone
 * @param {number} [payload.workDone] — задать workDone абсолютно
 * @param {number} [payload.workTotal] — полный объём (устанавливается при первом известном плане)
 */
function logJobProgress(jobId, payload) {
    const {
        phase: phaseIn,
        stage: stageIn,
        percent: percentIn,
        detail,
        workDelta,
        workDone: workDoneIn,
        workTotal: workTotalIn,
        planEstMainBatches: planEstIn,
    } = payload;

    const a = getAccum(jobId);

    if (workTotalIn != null && Number(workTotalIn) > 0) {
        a.workTotal = Math.floor(Number(workTotalIn));
    }
    if (planEstIn != null) {
        a.planEstMainBatches = Math.floor(Number(planEstIn));
    }
    if (workDoneIn != null) {
        a.workDone = Math.max(0, Math.floor(Number(workDoneIn)));
    }
    if (workDelta != null && Number(workDelta) !== 0) {
        a.workDone = Math.max(0, a.workDone + Math.floor(Number(workDelta)));
    }

    const phase = phaseIn || 'unknown';
    const stage = stageIn || '';

    let percent;
    if (phase === 'done') {
        if (a.workTotal != null && a.workTotal > 0) {
            a.workDone = a.workTotal;
        }
        percent = 100;
    } else if (phase === 'error') {
        percent = Math.max(0, Math.min(100, Math.round(Number(percentIn) || 0)));
    } else if (a.workTotal != null && a.workTotal > 0) {
        percent = Math.min(100, Math.round((100 * a.workDone) / a.workTotal));
    } else {
        percent = Math.max(0, Math.min(100, Math.round(Number(percentIn) || 0)));
    }

    const volumeReady = phase !== 'error' && a.workTotal != null && a.workTotal > 0;

    const row = {
        jobId,
        phase,
        stage,
        percent,
        detail: detail != null ? String(detail) : '',
        workDone: a.workDone,
        workTotal: a.workTotal,
        volumeReady,
        updatedAt: Date.now(),
    };

    setJob(jobId, row);
    appendHistory(jobId, row);
    console.log(`[PROGRESS] ${JSON.stringify(row)}`);
    schedulePersist(jobId);

    // Publish to Redis for SSE subscribers on other API instances
    publishProgress(jobId, { jobId, phase: row.phase, percent: row.percent, message: row.detail });
}

module.exports = {
    logJobProgress,
    getJob,
    flushPersist,
    clearJob,
    refineMainBatchPlan,
    estimateGenerationTailUnits,
    indexWorkloadUnits,
    WEIGHT,
};
