const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const userRepo = require('../db/repositories/userRepo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function generateToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        config.JWT_SECRET,
        { expiresIn: config.JWT_EXPIRES_IN }
    );
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, fullName } = req.body;

        if (!email || !password || !fullName) {
            return res.status(400).json({ error: 'Пожалуйста, заполните все поля' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
        }

        // Проверяем, существует ли пользователь с таким email
        const existingUser = await userRepo.findByEmail(email);
        if (existingUser) {
            return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
        }

        // Хэшируем пароль
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Создаем пользователя. Первого пользователя можно сделать админом вручную через БД
        const newUser = await userRepo.create({
            email,
            passwordHash,
            fullName,
            role: 'user', 
        });

        // Генерируем токен
        const token = generateToken(newUser);

        res.status(201).json({
            message: 'Регистрация успешна',
            token,
            user: {
                id: newUser.id,
                email: newUser.email,
                fullName: newUser.full_name,
                role: newUser.role,
            }
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Пожалуйста, введите email и пароль' });
        }

        // Проверяем пользователя
        const user = await userRepo.findByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        // Проверяем пароль
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        const token = generateToken(user);

        res.json({
            message: 'Успешный вход',
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                role: user.role,
            }
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
    try {
        // req.user добавляется в middleware requireAuth
        res.json({
            user: req.user,
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Заполните текущий и новый пароли' });
        }

        const user = await userRepo.findById(req.user.id);
        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        
        if (!isMatch) {
            return res.status(400).json({ error: 'Текущий пароль неверен' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Новый пароль должен содержать минимум 6 символов' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        await userRepo.updatePassword(req.user.id, passwordHash);

        res.json({ message: 'Пароль успешно изменён' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
