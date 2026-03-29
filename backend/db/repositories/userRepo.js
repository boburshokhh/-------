const { query } = require('../pgPool');

async function findByEmail(email) {
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0];
}

async function findById(id) {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0];
}

async function create({ email, passwordHash, fullName, role = 'user' }) {
    const { rows } = await query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, full_name, role, created_at`,
        [email, passwordHash, fullName, role]
    );
    return rows[0];
}

async function updatePassword(id, passwordHash) {
    const { rows } = await query(
        `UPDATE users
         SET password_hash = $1, updated_at = now()
         WHERE id = $2
         RETURNING id`,
        [passwordHash, id]
    );
    return rows[0];
}

module.exports = {
    findByEmail,
    findById,
    create,
    updatePassword,
};
