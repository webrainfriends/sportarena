import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool, tx } from './db.js';

export async function migrate() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async (c) => {
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    console.log('migrated', f);
  }
  // derive youth status for accounts that already have a date of birth (idempotent; nothing is removed or rewritten)
  const n = await (await import('./youth.js')).backfillYouth();
  if (n) console.log('youth status evaluated for', n, 'existing accounts');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  await pool.end();
}
