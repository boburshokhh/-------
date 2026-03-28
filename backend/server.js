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

app.use('/api/upload', uploadLimiter, require('./routes/upload'));
app.use('/api/tests', apiLimiter, require('./routes/tests'));
app.use('/api/results', apiLimiter, require('./routes/results'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/_hidden/settings', require('./routes/settings'));

app.get('/api/health', async (req, res) => {
    let dbOk = false;
    try {
        await pgPool.query('SELECT 1');
        dbOk = true;
    } catch { /* ignore */ }

    const hasKey = await runtimeConfig.hasGeminiApiKey();
    const quota = await quotaGuard.getUsageSummaryPublic();

    res.json({
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
    try {
        console.log('[INIT] Running PostgreSQL migrations...');
        await runMigrations();
        console.log('[INIT] PostgreSQL ready');
    } catch (err) {
        console.error('[INIT] PostgreSQL init failed:', err.message);
        process.exit(1);
    }

    try {
        await fileStorage.init();
    } catch (err) {
        console.warn('[INIT] Storage init warning:', err.message);
    }

    app.listen(config.PORT, () => {
        const hasKey = config.GEMINI_API_KEY ? true : false;
        console.log(`\n  AI Test Generator запущен на http://localhost:${config.PORT}`);
        console.log(`  БД: PostgreSQL ${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE}`);
        console.log(`  Хранилище: ${config.STORAGE_BACKEND}`);
        console.log(`  Загрузки: ${config.UPLOAD_DIR}`);
        console.log(`  Модель: ${config.LLM_MODEL}`);
        console.log(`  API ключ: ${hasKey ? 'настроен' : 'НЕ НАСТРОЕН'}\n`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
