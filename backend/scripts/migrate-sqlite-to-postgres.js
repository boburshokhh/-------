#!/usr/bin/env node
/**
 * One-shot migration: SQLite -> PostgreSQL
 * Usage: node scripts/migrate-sqlite-to-postgres.js [--dry-run]
 *
 * Reads from SQLite at DB_PATH, writes to PostgreSQL at DATABASE_URL / PG* env.
 * Preserves IDs. Resets sequences after migration.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const Database = require('better-sqlite3');
const config = require('../config');
const pg = require('../db/pgPool');
const { runMigrations } = require('../db/migrations/runner');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE) || 500;

async function migrate() {
    console.log(`[MIGRATE] SQLite -> PostgreSQL ${DRY_RUN ? '(DRY RUN)' : ''}`);
    console.log(`[MIGRATE] Source: ${config.DB_PATH}`);
    console.log(`[MIGRATE] Target: ${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE}`);

    const sqlite = new Database(config.DB_PATH, { readonly: true });
    sqlite.pragma('journal_mode = WAL');

    console.log('[MIGRATE] Running PG migrations first...');
    await runMigrations();

    const tables = [
        {
            name: 'documents',
            sqliteTable: 'documents',
            columns: [
                'id', 'filename', 'original_name', 'original_name_raw',
                'page_count', 'text_length', 'extraction_quality',
                'parse_diagnostics_json', 'low_text_quality',
                'text_raw', 'text_clean', 'created_at',
            ],
            pgColumns: [
                'id', 'filename', 'original_name', 'original_name_raw',
                'page_count', 'text_length', 'extraction_quality',
                'parse_diagnostics', 'low_text_quality',
                'text_raw', 'text_clean', 'created_at',
            ],
            transforms: {
                parse_diagnostics_json: (v) => v ? JSON.parse(v) : null,
                low_text_quality: (v) => v === 1 || v === true,
            },
        },
        {
            name: 'tests',
            sqliteTable: 'tests',
            columns: ['id', 'document_id', 'title', 'questions_json', 'total_questions', 'generation_metrics_json', 'created_at'],
            pgColumns: ['id', 'document_id', 'title', 'questions_json', 'total_questions', 'generation_metrics', 'created_at'],
            transforms: {
                questions_json: (v) => v ? JSON.parse(v) : [],
                generation_metrics_json: (v) => v ? JSON.parse(v) : null,
            },
        },
        {
            name: 'results',
            sqliteTable: 'results',
            columns: ['id', 'test_id', 'user_name', 'answers_json', 'score', 'max_score', 'percentage', 'completed_at'],
            pgColumns: ['id', 'test_id', 'user_name', 'answers_json', 'score', 'max_score', 'percentage', 'completed_at'],
            transforms: {
                answers_json: (v) => v ? JSON.parse(v) : [],
            },
        },
        {
            name: 'chunks',
            sqliteTable: 'document_chunks',
            columns: ['id', 'document_id', 'chunk_index', 'text', 'token_count', 'content_hash', 'page', 'section', 'heading', 'created_at'],
            pgColumns: ['id', 'document_id', 'chunk_index', 'text', 'token_count', 'content_hash', 'page', 'section', 'heading', 'created_at'],
        },
        {
            name: 'chunk_embeddings',
            sqliteTable: 'chunk_embeddings',
            columns: ['id', 'chunk_id', 'embedding_model', 'embedding', 'dims', 'created_at'],
            pgColumns: ['id', 'chunk_id', 'embedding_model', 'embedding', 'dims', 'created_at'],
            transforms: {
                embedding: (v) => v ? JSON.parse(v) : null,
            },
        },
        {
            name: 'chunk_summaries',
            sqliteTable: 'chunk_summaries',
            columns: ['id', 'chunk_id', 'summary_text', 'created_at'],
            pgColumns: ['id', 'chunk_id', 'summary_text', 'created_at'],
            transforms: {
                summary_text: (v) => v ? JSON.parse(v) : [],
            },
        },
        {
            name: 'app_settings',
            sqliteTable: 'app_settings',
            columns: ['key', 'value', 'updated_at'],
            pgColumns: ['key', 'value', 'updated_at'],
        },
        {
            name: 'gemini_usage',
            sqliteTable: 'gemini_usage',
            columns: ['key_fingerprint', 'usage_date', 'model_id', 'requests'],
            pgColumns: ['key_fingerprint', 'usage_date', 'model_id', 'requests'],
        },
    ];

    for (const table of tables) {
        await migrateTable(sqlite, table);
    }

    // Reset sequences
    if (!DRY_RUN) {
        console.log('[MIGRATE] Resetting sequences...');
        const seqTables = ['documents', 'tests', 'results', 'chunks', 'chunk_embeddings', 'chunk_summaries'];
        for (const t of seqTables) {
            try {
                await pg.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
            } catch (e) {
                console.warn(`[MIGRATE] Sequence reset for ${t} skipped: ${e.message}`);
            }
        }
    }

    // Verification
    console.log('\n[MIGRATE] Verification:');
    for (const table of tables) {
        const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table.sqliteTable}`).get().cnt;
        let pgCount = 0;
        try {
            const { rows } = await pg.query(`SELECT COUNT(*)::int as cnt FROM ${table.name}`);
            pgCount = rows[0].cnt;
        } catch { /* table may not exist in dry run */ }
        const match = sqliteCount === pgCount;
        console.log(`  ${match ? 'OK' : 'MISMATCH'} ${table.name}: SQLite=${sqliteCount}, PG=${pgCount}`);
    }

    sqlite.close();
    await pg.close();
    console.log(`\n[MIGRATE] ${DRY_RUN ? 'Dry run complete' : 'Migration complete'}`);
}

async function migrateTable(sqlite, tableDef) {
    const { name, sqliteTable, columns, pgColumns, transforms } = tableDef;

    let count;
    try {
        count = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${sqliteTable}`).get().cnt;
    } catch (e) {
        console.warn(`[MIGRATE] Table ${sqliteTable} not found in SQLite, skipping: ${e.message}`);
        return;
    }

    console.log(`[MIGRATE] ${name}: ${count} rows`);
    if (count === 0 || DRY_RUN) return;

    const allRows = sqlite.prepare(`SELECT ${columns.join(',')} FROM ${sqliteTable}`).all();

    for (let offset = 0; offset < allRows.length; offset += BATCH_SIZE) {
        const batch = allRows.slice(offset, offset + BATCH_SIZE);

        await pg.transaction(async (client) => {
            for (const row of batch) {
                const values = pgColumns.map((pgCol, idx) => {
                    const sqliteCol = columns[idx];
                    let val = row[sqliteCol];
                    if (transforms && transforms[sqliteCol]) {
                        val = transforms[sqliteCol](val);
                    }
                    if (val !== null && typeof val === 'object') {
                        val = JSON.stringify(val);
                    }
                    return val;
                });

                const placeholders = pgColumns.map((_, i) => `$${i + 1}`).join(',');
                const onConflict = name === 'app_settings'
                    ? 'ON CONFLICT (key) DO NOTHING'
                    : name === 'gemini_usage'
                        ? 'ON CONFLICT (key_fingerprint, usage_date, model_id) DO NOTHING'
                        : `ON CONFLICT (id) DO NOTHING`;

                const sql = `INSERT INTO ${name} (${pgColumns.join(',')}) VALUES (${placeholders}) ${onConflict}`;
                await client.query(sql, values);
            }
        });

        console.log(`  ${name}: ${Math.min(offset + BATCH_SIZE, allRows.length)}/${allRows.length}`);
    }
}

migrate().catch(err => {
    console.error('[MIGRATE] Fatal error:', err);
    process.exit(1);
});
