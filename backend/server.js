const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const logCollector = require('./services/logCollector');
const runtimeConfig = require('./services/runtimeConfig');

const app = express();

// Патчим console и копим лог-строки в памяти, чтобы потом показать их во фронте.
logCollector.init();

// Trust proxy (nginx/reverse proxy) — обязательно до rate limit, иначе X-Forwarded-For вызовет ValidationError
app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// CORS
const corsOptions = {
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }
        if (!config.CORS_ORIGINS.length || config.CORS_ORIGINS.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error('CORS origin is not allowed'));
    },
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100,
    message: { error: 'Слишком много запросов, попробуйте позже' }
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Слишком много загрузок, попробуйте позже' }
});

// API routes
app.use('/api/upload', uploadLimiter, require('./routes/upload'));
app.use('/api/tests', apiLimiter, require('./routes/tests'));
app.use('/api/results', apiLimiter, require('./routes/results'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/_hidden/settings', require('./routes/settings'));

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        hasApiKey: runtimeConfig.hasGeminiApiKey(),
        uploadLimits: {
            allowedMimes: config.ALLOWED_MIMES || [],
            maxPages: config.MAX_PAGES,
            maxFileSizeMb: config.MAX_FILE_SIZE_MB,
        },
    });
});

// Список моделей для переключателя
app.get('/api/models', (req, res) => {
    res.json({
        models: config.LLM_MODELS || [],
        defaultModel: config.LLM_MODEL
    });
});

// Serve frontend static files.
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDistPath));

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// Error handler
app.use(errorHandler);

// Start server
app.listen(config.PORT, () => {
    console.log(`\n🚀 AI Test Generator запущен на http://localhost:${config.PORT}`);
    console.log(`📁 Загрузки: ${config.UPLOAD_DIR}`);
    console.log(`🗄️  БД: ${config.DB_PATH}`);
    console.log(`🤖 Модель: ${config.LLM_MODEL}`);
    console.log(`🔑 API ключ: ${runtimeConfig.hasGeminiApiKey() ? 'настроен ✅' : 'НЕ НАСТРОЕН ❌'}\n`);
});
