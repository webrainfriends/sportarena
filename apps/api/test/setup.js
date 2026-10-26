// Test preload (node --import). The suites reset the database with `DROP SCHEMA public CASCADE; CREATE SCHEMA public`. That one statement
// locks every table, index and TOAST relation at once, and as the schema grew past ~2000 relations it ran out of the default lock table
// ("out of shared memory" on a stock Postgres). The reset is the same, but the tables are dropped in small batches first, each in its own
// transaction, so it works with default settings. Test infrastructure only: nothing in src/ changes.
import pg from 'pg';

// the reset is sometimes followed by statements that recreate bookkeeping (CREATE TABLE schema_migrations ...); those run after the batched drop
const RESET = /^\s*DROP SCHEMA public CASCADE\s*;\s*CREATE SCHEMA public\s*;?([\s\S]*)$/i;
const original = pg.Pool.prototype.query;

async function chunkedReset(pool, rest) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename DESC");
    for (let i = 0; i < rows.length; i += 60) await client.query(`DROP TABLE IF EXISTS ${rows.slice(i, i + 60).map((r) => `public.${r.t}`).join(', ')} CASCADE`);
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    if (rest.trim()) await client.query(rest);
    return { rows: [], rowCount: null };
  } finally { client.release(); }
}

pg.Pool.prototype.query = function (text, ...rest) {
  const m = typeof text === 'string' ? RESET.exec(text) : null;
  if (m) return chunkedReset(this, m[1]);
  return original.call(this, text, ...rest);
};
