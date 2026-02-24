const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// CORS
app.use(cors());

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

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        hasApiKey: !!config.GEMINI_API_KEY && config.GEMINI_API_KEY !== 'your-gemini-api-key-here'
    });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Error handler
app.use(errorHandler);

// Start server
app.listen(config.PORT, () => {
    console.log(`\n🚀 AI Test Generator запущен на http://localhost:${config.PORT}`);
    console.log(`📁 Загрузки: ${config.UPLOAD_DIR}`);
    console.log(`🗄️  БД: ${config.DB_PATH}`);
    console.log(`🤖 Модель: ${config.LLM_MODEL}`);
    console.log(`🔑 API ключ: ${config.GEMINI_API_KEY ? 'настроен ✅' : 'НЕ НАСТРОЕН ❌'}\n`);
});
