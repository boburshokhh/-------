const pg = require('../pgPool');

async function getSetting(key) {
    const { rows } = await pg.query(
        'SELECT value FROM app_settings WHERE key = $1', [key]
    );
    return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
    await pg.query(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
    `, [key, value]);
}

module.exports = { getSetting, setSetting };
