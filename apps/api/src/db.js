import pg from 'pg';
import { config } from './config.js';

// numeric/bigint -> JS numbers (our values stay well inside 2^53)
pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  max: 10,
});

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
export const many = async (text, params) => (await pool.query(text, params)).rows;

export async function tx(fn) {
  const client = await pool.connect();
  const hooks = [];
  client.afterCommit = (f) => hooks.push(f); // side effects (refund attempts …) that must only run once the data is safely committed
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const f of hooks) { try { f(); } catch (e) { console.error('[afterCommit]', e.message); } }
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
