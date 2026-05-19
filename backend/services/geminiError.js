/**
 * Разбор ошибок Gemini / Generative Language API (429, RESOURCE_EXHAUSTED, RetryInfo).
 */

const MAX_RETRY_WAIT_MS = 120_000;

function tryParseJsonObject(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim();
    if (!t.startsWith('{')) return null;
    try {
        return JSON.parse(t);
    } catch {
        return null;
    }
}

function extractErrorPayload(err) {
    if (!err) return null;
    if (err.error && (err.error.code != null || err.error.status)) return err.error;
    const fromMsg = tryParseJsonObject(err.message);
    if (fromMsg) {
        if (fromMsg.error) return fromMsg.error;
        if (fromMsg.code != null || fromMsg.status) return fromMsg;
    }
    if (typeof err.message === 'string') {
        const m = err.message.match(/\{[\s\S]*"code"\s*:\s*429[\s\S]*\}/);
        if (m) {
            const p = tryParseJsonObject(m[0]);
            if (p?.error) return p.error;
        }
    }
    return null;
}

function parseRetryDelaySeconds(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const rd = detail.retryDelay;
    if (rd == null) return null;
    if (typeof rd === 'number' && !Number.isNaN(rd)) return rd;
    if (typeof rd === 'string') {
        const m = rd.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return parseFloat(m[1], 10);
        const n = parseFloat(rd, 10);
        if (!Number.isNaN(n)) return n;
    }
    return null;
}

/**
 * @param {unknown} err
 * @returns {{
 *   isResourceExhausted: boolean,
 *   retryDelayMs: number | null,
 *   isDailyFreeTierQuota: boolean,
 *   quotaId: string | null,
 *   isTransientUnavailable: boolean,
 * }}
 */
function parseGeminiApiError(err) {
    const payload = extractErrorPayload(err);
    const code = payload?.code;
    const status = payload?.status;
    const is429 = code === 429 || status === 'RESOURCE_EXHAUSTED';

    let retryDelayMs = null;
    let isDailyFreeTierQuota = false;
    let quotaId = null;

    const details = Array.isArray(payload?.details) ? payload.details : [];
    for (const d of details) {
        const t = d && d['@type'];
        if (t && String(t).includes('RetryInfo')) {
            const sec = parseRetryDelaySeconds(d);
            if (sec != null && sec >= 0) {
                const ms = Math.ceil(sec * 1000);
                retryDelayMs = Math.min(MAX_RETRY_WAIT_MS, ms);
            }
        }
        if (t && String(t).includes('QuotaFailure')) {
            for (const v of d.violations || []) {
                const qid = v.quotaId || v.quota_id;
                if (qid) quotaId = String(qid);
                if (/PerDay|per_day|DayPerProject/i.test(String(qid || ''))) {
                    isDailyFreeTierQuota = true;
                }
                if (/free_tier|FreeTier/i.test(String(v.quotaMetric || ''))) {
                    isDailyFreeTierQuota = true;
                }
            }
        }
    }

    const msg = String(payload?.message || err?.message || '');
    if (!isDailyFreeTierQuota && /per day|PerDay|сутк/i.test(msg)) {
        isDailyFreeTierQuota = true;
    }

    const st = String(status || '').toUpperCase();
    const isTransientUnavailable = code === 503
        || st === 'UNAVAILABLE'
        || /\b503\b|UNAVAILABLE|high demand|temporarily unavailable|overload/i.test(msg);
    const isModelNotFound = code === 404
        || st === 'NOT_FOUND'
        || /no longer available|not found|is not supported/i.test(msg);

    return {
        isResourceExhausted: Boolean(is429),
        retryDelayMs,
        isDailyFreeTierQuota,
        quotaId,
        /** Перегрузка / недоступность модели на стороне Google — не квота, нужны длинные паузы между повторами */
        isTransientUnavailable: Boolean(isTransientUnavailable),
        /** Модель снята с API (например gemini-2.0-flash для новых ключей) */
        isModelNotFound: Boolean(isModelNotFound),
    };
}

/**
 * @param {ReturnType<typeof parseGeminiApiError>} parsed
 * @param {number} attempt 1-based
 * @param {number} maxAttempts
 */
async function sleepForGeminiRetry(parsed, attempt, maxAttempts, sleepFn) {
    const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (attempt >= maxAttempts) return;
    // Daily quota is NOT a transient error — Google will not serve us until tomorrow.
    // Retrying immediately wastes calls and time. Break out immediately.
    if (parsed.isDailyFreeTierQuota) return;
    if (parsed.retryDelayMs != null && parsed.retryDelayMs > 0) {
        await sleep(parsed.retryDelayMs);
        return;
    }
    if (parsed.isTransientUnavailable) {
        const ms = Math.min(MAX_RETRY_WAIT_MS, 8000 * Math.pow(2, attempt - 1));
        await sleep(ms);
        return;
    }
    await sleep(1000 * Math.pow(2, attempt - 1));
}

/**
 * Оборачивает промис таймаутом.
 * При использовании AbortSignal оригинальный HTTP-запрос к Google реально отменяется
 * (нет orphaned connections при большом числе параллельных вызовов).
 *
 * @param {(signal?: AbortSignal) => Promise<T>} promiseFactory - фабрика, принимающая signal
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promiseFactory, ms, label = 'Gemini') {
    // Backward-compat: если передан готовый Promise (а не фабрика) — обернуть как раньше
    // без AbortController. Новые вызовы должны передавать фабрику.
    if (ms <= 0 || !ms) {
        const p = typeof promiseFactory === 'function' ? promiseFactory() : promiseFactory;
        return p;
    }
    if (typeof promiseFactory !== 'function') {
        // Legacy: plain promise — старое поведение (таймер, без abort)
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}: превышен таймаут ${ms} мс`)), ms);
        });
        return Promise.race([promiseFactory, timeoutPromise]).finally(() => clearTimeout(timer));
    }
    const controller = new AbortController();
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`${label}: превышен таймаут ${ms} мс`));
        }, ms);
    });
    const work = promiseFactory(controller.signal);
    return Promise.race([work, timeoutPromise]).finally(() => clearTimeout(timer));
}

module.exports = {
    parseGeminiApiError,
    sleepForGeminiRetry,
    withTimeout,
    MAX_RETRY_WAIT_MS,
};
