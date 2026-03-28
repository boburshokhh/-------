const fs = require('fs');
const path = require('path');

// SQL-файлы лежат в этой же папке, что и runner.js
const MIGRATIONS_DIR = __dirname;

/**
 * @param {{ query: Function, transaction: Function }} pg — модуль `db/pgPool` (передаётся из server.js / скриптов)
 */
async function runMigrations(pg) {
    if (!pg || typeof pg.query !== 'function' || typeof pg.transaction !== 'function') {
        throw new Error('runMigrations(pg): ожидается pgPool с методами query и transaction');
    }

    await pg.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT now()
        )
    `);

    const { rows } = await pg.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(rows.map((r) => r.version));

    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    let count = 0;
    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        console.log(`[MIGRATION] Applying ${file}...`);

        await pg.transaction(async (client) => {
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        });

        count++;
        console.log(`[MIGRATION] Applied ${file}`);
    }

    if (count === 0) {
        console.log('[MIGRATION] All migrations are up to date');
    } else {
        console.log(`[MIGRATION] Applied ${count} migration(s)`);
    }
}

module.exports = { runMigrations };
