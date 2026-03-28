const fs = require('fs');
const path = require('path');
const pg = require('./pgPool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
    await pg.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT now()
        )
    `);
}

async function getAppliedMigrations() {
    const { rows } = await pg.query('SELECT version FROM schema_migrations ORDER BY version');
    return new Set(rows.map(r => r.version));
}

async function runMigrations() {
    await ensureMigrationsTable();
    const applied = await getAppliedMigrations();

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    let count = 0;
    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        console.log(`[MIGRATION] Applying ${file}...`);

        await pg.transaction(async (client) => {
            await client.query(sql);
            await client.query(
                'INSERT INTO schema_migrations (version) VALUES ($1)',
                [file]
            );
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
