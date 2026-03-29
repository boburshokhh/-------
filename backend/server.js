/* Самый ранний лог: если пусто в `docker logs`, смотрите предыдущий инстанс: docker logs ai-testgen-app --previous */
console.error('[BOOT]', new Date().toISOString(), 'cwd=', process.cwd(), 'NODE_ENV=', process.env.NODE_ENV || '');

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const logCollector = require('./services/logCollector');
const runtimeConfig = require('./services/runtimeConfig');
const quotaGuard = require('./services/quotaGuard');
const pgPool = require('./db/pgPool');
const { runMigrations } = require('./db/migrations/runner');
const fileStorage = require('./services/storage/fileStorage');

const app = express();

logCollector.init();

app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

const corsOptions = {
    origin(origin, callback) {
        if (!origin) { callback(null, true); return; }
        if (!config.CORS_ORIGINS.length || config.CORS_ORIGINS.includes(origin)) {
            callback(null, true); return;
        }
        callback(new Error('CORS origin is not allowed'));
    },
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Слишком много запросов, попробуйте позже' },
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Слишком много загрузок, попробуйте позже' },
});

/**
 * Тяжёлый граф (generator, rag, pdf-parse, indexer, Gemini SDK) не грузим при старте —
 * иначе на VPS с малым RAM возможен OOM / немой краш сразу после [BOOT], без [INIT].
 */
function lazyRouter(modulePath) {
    let router;
    return (req, res, next) => {
        if (!router) {
            console.error('[LOAD]', modulePath, new Date().toISOString());
            router = require(modulePath);
        }
        return router(req, res, next);
    };
}

app.use('/api/upload', uploadLimiter, lazyRouter('./routes/upload'));
app.use('/api/tests', apiLimiter, require('./routes/tests'));
app.use('/api/results', apiLimiter, require('./routes/results'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/_hidden/settings', require('./routes/settings'));

/** Не даём /api/health зависнуть при «залипшем» Postgres — иначе Docker healthcheck падает по timeout. */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(
                () => reject(new Error(`${label || 'health'} timeout after ${ms}ms`)),
                ms,
            );
        }),
    ]);
}

app.get('/api/health', async (req, res) => {
    const dbTimeoutMs = Math.min(8000, parseInt(process.env.HEALTH_DB_TIMEOUT_MS, 10) || 4000);
    let dbOk = false;
    try {
        await withTimeout(pgPool.query('SELECT 1'), dbTimeoutMs, 'db_ping');
        dbOk = true;
    } catch { /* ignore — отдаём degraded */ }

    let hasKey = false;
    let quota = { tier: config.GEMINI_QUOTA_TIER || 'free', usageDateUtc: '', perModel: {} };
    try {
        await withTimeout(
            (async () => {
                hasKey = await runtimeConfig.hasGeminiApiKey();
                quota = await quotaGuard.getUsageSummaryPublic();
            })(),
            6000,
            'health_optional',
        );
    } catch (e) {
        console.warn('[HEALTH] optional checks failed:', e.message);
    }

    res.status(200).json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'connected' : 'error',
        storage: config.STORAGE_BACKEND,
        timestamp: new Date().toISOString(),
        hasApiKey: hasKey,
        uploadLimits: {
            allowedMimes: config.ALLOWED_MIMES || [],
            maxPages: config.MAX_PAGES,
            maxFileSizeMb: config.MAX_FILE_SIZE_MB,
        },
        geminiQuota: quota,
    });
});

app.get('/api/models', async (req, res) => {
    const models = (config.LLM_MODELS || []).map((m) => ({
        ...m,
        limits: quotaGuard.getLimitsForModel(m.id),
    }));
    res.json({
        models,
        defaultModel: config.LLM_MODEL,
        quotaTier: config.GEMINI_QUOTA_TIER || 'free',
        embeddingModel: config.EMBEDDING_MODEL,
        embeddingLimits: quotaGuard.getLimitsForModel(config.EMBEDDING_MODEL),
    });
});

const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDistPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

app.use(errorHandler);

async function start() {
    const dbLabel = config.DATABASE_URL
        ? 'DATABASE_URL'
        : `${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE} (user=${config.PGUSER})`;
    console.log('[INIT] PostgreSQL target:', dbLabel);

    try {
        console.log('[INIT] Running PostgreSQL migrations...');
        await runMigrations(pgPool);
        console.log('[INIT] PostgreSQL ready');
    } catch (err) {
        console.error('[INIT] PostgreSQL init failed:', err.message);
        if (/password authentication failed|28P01/i.test(String(err.message))) {
            console.error(
                '[INIT] Пароль БД: роль в Postgres задаётся при первом создании тома. POSTGRES_PASSWORD в .env на хосте должен совпадать с реальным паролем; смена в .env без пересоздания тома пароль внутри БД не обновляет.',
            );
        }
        process.exit(1);
    }

    // Порт до init хранилища: при STORAGE_BACKEND=minio вызов MinIO до listen мог долго висеть → Docker healthcheck unhealthy, сайт недоступен.
    app.listen(config.PORT, '0.0.0.0', () => {
        const hasKey = config.GEMINI_API_KEY ? true : false;
        console.log(`\n  AI Test Generator запущен на http://0.0.0.0:${config.PORT}`);
        console.log(`  БД: PostgreSQL ${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE}`);
        console.log(`  Хранилище: ${config.STORAGE_BACKEND}`);
        console.log(`  Загрузки: ${config.UPLOAD_DIR}`);
        console.log(`  Модель: ${config.LLM_MODEL}`);
        console.log(`  API ключ: ${hasKey ? 'настроен' : 'НЕ НАСТРОЕН'}\n`);
    });

    fileStorage.init().catch((err) => {
        console.warn('[INIT] Storage init warning:', err.message);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
