'use strict';

/**
 * Один активный процесс генерации на инстанс (Redis NX, иначе in-memory).
 * Без очереди BullMQ: второй upload получает 409 с именем файла и этапом.
 */

const config = require('../config');

const LOCK_KEY = 'atg:generation:active';
const LOCK_TTL_SEC = 2 * 60 * 60;

/** @type {{ jobId: string, fileName: string, phase: string, stage: string, detail: string, startedAt: number } | null} */
let memoryLock = null;

const PHASE_LABELS = {
    upload: 'Загрузка',
    parse: 'Разбор PDF',
    db: 'Сохранение',
    index: 'Индексация',
    generate: 'Генерация вопросов',
    validate: 'Проверка',
    done: 'Завершение',
    error: 'Ошибка',
};

const STAGE_LABELS = {
    receiving: 'приём файла',
    reading: 'чтение файла',
    parsed: 'разбор текста',
    saving: 'запись в БД',
    saved: 'документ сохранён',
    indexing: 'индексация',
    themes: 'темы',
    blueprint: 'план вопросов',
    llm_batch: 'пакеты LLM',
    dedup: 'дедупликация',
    ready: 'финализация',
    saved_test: 'сохранение теста',
};

function getRedis() {
    try {
        const { getClient } = require('../db/redisClient');
        return getClient(config.REDIS_DB_QUEUE ?? 0);
    } catch {
        return null;
    }
}

function parseLock(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

function snapshot(jobId, fileName, phase, stage, detail) {
    return {
        jobId: String(jobId),
        fileName: String(fileName || 'документ'),
        phase: String(phase || 'upload'),
        stage: String(stage || ''),
        detail: String(detail || ''),
        startedAt: Date.now(),
    };
}

function formatStep(busy) {
    if (busy?.detail) return busy.detail;
    const p = PHASE_LABELS[busy?.phase] || busy?.phase || 'обработка';
    const s = STAGE_LABELS[busy?.stage] || busy?.stage;
    return s ? `${p}: ${s}` : p;
}

function buildBusyMessage(busy) {
    const file = busy?.fileName || 'другой документ';
    const step = formatStep(busy);
    return `Сейчас уже идёт генерация теста по файлу «${file}» — этап: ${step}. Дождитесь завершения, затем загрузите новый файл.`;
}

async function readBusy() {
    const redis = getRedis();
    if (redis) {
        try {
            const raw = await redis.get(LOCK_KEY);
            return parseLock(raw);
        } catch {
            /* fallback */
        }
    }
    return memoryLock;
}

/**
 * @returns {Promise<{ acquired: boolean, busy?: object }>}
 */
async function tryAcquire(jobId, fileName) {
    const payload = snapshot(jobId, fileName, 'upload', 'receiving', 'Приём файла на сервер');

    const redis = getRedis();
    if (redis) {
        try {
            const existing = parseLock(await redis.get(LOCK_KEY));
            if (existing && existing.jobId !== jobId) {
                return { acquired: false, busy: existing };
            }
            const ok = await redis.set(LOCK_KEY, JSON.stringify(payload), 'EX', LOCK_TTL_SEC, 'NX');
            if (ok === 'OK' || existing?.jobId === jobId) {
                if (existing?.jobId === jobId) {
                    await redis.set(LOCK_KEY, JSON.stringify(payload), 'EX', LOCK_TTL_SEC);
                }
                memoryLock = payload;
                return { acquired: true };
            }
            return { acquired: false, busy: parseLock(await redis.get(LOCK_KEY)) || existing };
        } catch (e) {
            console.warn('[GEN_LOCK] Redis unavailable, in-memory lock:', e.message);
        }
    }

    if (memoryLock && memoryLock.jobId !== jobId) {
        return { acquired: false, busy: memoryLock };
    }
    memoryLock = payload;
    return { acquired: true };
}

async function touch(jobId, { phase, stage, detail, fileName } = {}) {
    const current = await readBusy();
    if (!current || current.jobId !== jobId) return;

    const next = {
        ...current,
        phase: phase != null ? String(phase) : current.phase,
        stage: stage != null ? String(stage) : current.stage,
        detail: detail != null ? String(detail) : current.detail,
        fileName: fileName != null ? String(fileName) : current.fileName,
    };

    memoryLock = next;
    const redis = getRedis();
    if (redis) {
        try {
            await redis.set(LOCK_KEY, JSON.stringify(next), 'EX', LOCK_TTL_SEC);
        } catch { /* ignore */ }
    }
}

async function release(jobId) {
    const current = await readBusy();
    if (!current || current.jobId !== jobId) return;

    memoryLock = null;
    const redis = getRedis();
    if (redis) {
        try {
            const raw = await redis.get(LOCK_KEY);
            const parsed = parseLock(raw);
            if (parsed?.jobId === jobId) {
                await redis.del(LOCK_KEY);
            }
        } catch { /* ignore */ }
    }
}

async function getActive() {
    const busy = await readBusy();
    if (!busy) return { busy: false };
    return {
        busy: true,
        jobId: busy.jobId,
        fileName: busy.fileName,
        phase: busy.phase,
        stage: busy.stage,
        detail: busy.detail,
        stepLabel: formatStep(busy),
        message: buildBusyMessage(busy),
        startedAt: busy.startedAt,
    };
}

module.exports = {
    tryAcquire,
    touch,
    release,
    getActive,
    buildBusyMessage,
    formatStep,
};
