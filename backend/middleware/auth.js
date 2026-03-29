const jwt = require('jsonwebtoken');
const config = require('../config');
const userRepo = require('../db/repositories/userRepo');

/**
 * Проверяет наличие Bearer токена и декодирует его.
 * Прикрепляет пользователя к req.user.
 * Возвращает 401, если токен недействителен или отсутствует.
 */
async function requireAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Необходимо авторизоваться. Токен отсутствует.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, config.JWT_SECRET);
        
        // Опционально: можно проверять существует ли еще пользователь в БД
        const user = await userRepo.findById(decoded.id);
        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }

        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            fullName: user.full_name,
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Недействительный или истекший токен', details: err.message });
    }
}

/**
 * Пытается распознать токен, но не блокирует доступ, если его нет.
 * Прикрепляет req.user = null, если токена нет или он не валиден.
 */
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, config.JWT_SECRET);
            const user = await userRepo.findById(decoded.id);
            if (user) {
                req.user = {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    fullName: user.full_name,
                };
            }
        } else {
            req.user = null;
        }
    } catch (err) {
        req.user = null; // Игнорируем ошибки при опциональной аутентификации
    }
    next();
}

/**
 * Проверяет, что пользователь имеет роль admin.
 * Должен использоваться ПОСЛЕ requireAuth.
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ разрешен только администраторам.' });
    }
    next();
}

module.exports = {
    requireAuth,
    optionalAuth,
    requireAdmin,
};
