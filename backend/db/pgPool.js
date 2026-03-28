const { Pool } = require('pg');
const config = require('../config');

let pool = null;

function getPool() {
    if (!pool) {
        const connectionConfig = config.DATABASE_URL
            ? { connectionString: config.DATABASE_URL }
            : {
                host: config.PGHOST,
                port: config.PGPORT,
                database: config.PGDATABASE,
                user: config.PGUSER,
                password: config.PGPASSWORD,
            };
        pool = new Pool({
            ...connectionConfig,
            max: config.PG_MAX_POOL || 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        pool.on('error', (err) => {
            console.error('[PG] Unexpected pool error:', err.message);
        });
    }
    return pool;
}

async function query(text, params) {
    return getPool().query(text, params);
}

async function transaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function close() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = { getPool, query, transaction, close };
