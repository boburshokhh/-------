/**
 * In-memory прогресс длительных задач (загрузка → индекс → генерация).
 * Клиент передаёт X-Job-Id и опрашивает GET /api/jobs/:jobId
 */

const store = new Map();
const TTL_MS = 30 * 60 * 1000;

function setJob(jobId, data) {
    store.set(jobId, { ...data, updatedAt: Date.now() });
}

function getJob(jobId) {
    const e = store.get(jobId);
    if (!e) return null;
    if (Date.now() - e.updatedAt > TTL_MS) {
        store.delete(jobId);
        return null;
    }
    return e;
}

function clearJob(jobId) {
    store.delete(jobId);
}

/**
 * Обновляет состояние и пишет строку в console → logCollector для панели логов.
 */
function logJobProgress(jobId, payload) {
    const { phase, stage, percent, detail } = payload;
    const row = {
        jobId,
        phase: phase || 'unknown',
        stage: stage || '',
        percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
        detail: detail != null ? String(detail) : '',
        updatedAt: Date.now(),
    };
    setJob(jobId, row);
    console.log(`[PROGRESS] ${JSON.stringify(row)}`);
}

module.exports = {
    logJobProgress,
    getJob,
    clearJob,
};
