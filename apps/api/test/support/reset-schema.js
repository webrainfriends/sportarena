// Test-only (loaded with `node --import`): suites reset the throwaway test database with `DROP SCHEMA public CASCADE`, which takes one lock per
// object in a single transaction. With several thousand tables/indexes that exceeds Postgres' default lock table (max_locks_per_transaction = 64).
// Drop the tables first, one statement at a time, so the final DROP SCHEMA has almost nothing left to lock. Never loaded outside `npm test`.
import pg from 'pg';

const original = pg.Pool.prototype.query;
const RESET = /^\s*DROP SCHEMA public CASCADE/i;
pg.Pool.prototype.query = async function patched(text, ...rest) {
  if (typeof text === 'string' && RESET.test(text)) {
    const client = await this.connect();
    try {
      const { rows } = await client.query("SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname='public'");
      for (const r of rows) await client.query(`DROP TABLE IF EXISTS public.${r.t} CASCADE`);
    } finally { client.release(); }
  }
  return original.call(this, text, ...rest);
};
