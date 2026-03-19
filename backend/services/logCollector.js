const util = require('util');

const DEFAULT_MAX_LOGS = 2000;

let initialized = false;
let maxLogs = DEFAULT_MAX_LOGS;
const buffer = [];

function redactSecrets(text) {
    if (!text) return text;
    // Прячем ключи формата Google API key (начинается с "AIza").
    return String(text).replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_GEMINI_KEY]');
}

function formatArgs(args) {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            return util.inspect(a, { depth: 4, breakLength: 160 });
        })
        .join(' ');
}

function push(level, args) {
    const raw = formatArgs(args);
    const message = redactSecrets(raw);
    buffer.push({
        ts: new Date().toISOString(),
        level,
        message,
    });
    while (buffer.length > maxLogs) buffer.shift();
}

function init(opts = {}) {
    if (initialized) return;
    initialized = true;

    maxLogs = Number.isFinite(opts.maxLogs) ? opts.maxLogs : DEFAULT_MAX_LOGS;

    // ВНИМАНИЕ: логируем в buffer только в памяти (для UI).
    // В Docker при рестарте все буферы теряются — это нормально для дебага.
    const orig = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
    };

    console.log = (...args) => {
        push('INFO', args);
        orig.log(...args);
    };
    console.info = (...args) => {
        push('INFO', args);
        orig.info(...args);
    };
    console.warn = (...args) => {
        push('WARN', args);
        orig.warn(...args);
    };
    console.error = (...args) => {
        push('ERROR', args);
        orig.error(...args);
    };

    // Unhandled errors тоже будут полезны в UI
    process.on('unhandledRejection', (reason) => {
        push('ERROR', ['[unhandledRejection]', reason]);
    });
    process.on('uncaughtException', (err) => {
        push('ERROR', ['[uncaughtException]', err]);
    });
}

function getLogs(limit = 200) {
    const l = Math.max(0, Number(limit) || 200);
    // Возвращаем в хронологическом порядке
    return buffer.slice(-l);
}

module.exports = {
    init,
    getLogs,
};

