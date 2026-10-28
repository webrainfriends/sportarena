// Migration 120 carries the earlier per-venue loyalty into the unified ledger without losing a point or rewriting history.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
after(() => pool.end());

test('earlier venue loyalty lots become ledger lots with the same balance and expiry; nothing is deleted', async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '120').sort()) {
    await pool.query(readFileSync(new URL(f, dir), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
  }
  const u = (h) => pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{athlete}','x','x',$1) RETURNING id", [h]).then((r) => r.rows[0].id);
  const [owner, a, b] = [await u('mig_owner'), await u('mig_a'), await u('mig_b')];
  const v1 = (await pool.query("INSERT INTO venues(name, owner_id, currency, loyalty_earn_bp, loyalty_expiry_months, loyalty_max_redeem_bp) VALUES ('On Arena',$1,'INR',700,9,4000) RETURNING id", [owner])).rows[0].id;
  const v2 = (await pool.query("INSERT INTO venues(name, owner_id, currency) VALUES ('Off Arena',$1,'INR') RETURNING id", [owner])).rows[0].id;
  const lot = (user, venue, kind, points, remaining, days) => pool.query("INSERT INTO loyalty_lots(user_id, venue_id, kind, points, remaining, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))", [user, venue, kind, points, remaining, days]);
  await lot(a, v1, 'bonus', 5000, 3200, 100);
  await lot(a, v1, 'bonus', 1000, 1000, 20);
  await lot(b, v1, 'bonus', 800, 0, 50);
  await lot(b, v2, 'bonus', 400, 400, 30);          // a venue that switched its scheme off but still owes points
  await pool.query("INSERT INTO loyalty_events(user_id, venue_id, delta, kind, note) VALUES ($1,$2,5000,'bonus','welcome'), ($1,$2,-1800,'redeem','invoice')", [a, v1]);
  const before = (await pool.query('SELECT user_id, venue_id, sum(remaining)::int AS n FROM loyalty_lots GROUP BY 1,2 ORDER BY 1,2')).rows;

  await migrate();

  const after_ = (await pool.query(
    `SELECT l.user_id, p.owner_id AS venue_id, sum(l.remaining)::int AS n FROM loyalty_lots_open l JOIN loyalty_programmes p ON p.id=l.programme_id GROUP BY 1,2 HAVING sum(l.remaining) > 0 ORDER BY 1,2`)).rows;
  const nonZero = before.filter((r) => r.n > 0);
  assert.deepEqual(after_.map((r) => [r.user_id, r.venue_id, r.n]).sort(), nonZero.map((r) => [r.user_id, r.venue_id, r.n]).sort(), 'every member keeps exactly their balance');
  const p1 = (await pool.query("SELECT p.*, v.rules FROM loyalty_programmes p JOIN loyalty_programme_versions v ON v.programme_id=p.id AND v.version=p.current_version WHERE p.owner_id=$1", [v1])).rows[0];
  assert.equal(p1.status, 'active');
  assert.equal(p1.rules.earn[0].percent_bp, 700);
  assert.equal(p1.rules.redeem.max_redeem_bp, 4000);
  assert.equal(p1.rules.expiry_months, 9);
  const p2 = (await pool.query("SELECT status FROM loyalty_programmes WHERE owner_id=$1", [v2])).rows[0];
  assert.equal(p2.status, 'paused', 'a venue with its scheme off keeps its members\' points but issues no more');
  // expiries survive
  const exp = (await pool.query("SELECT expires_at FROM loyalty_lots_open WHERE user_id=$1 AND points=1000", [a])).rows[0].expires_at;
  const old = (await pool.query("SELECT expires_at FROM loyalty_lots WHERE user_id=$1 AND points=1000", [a])).rows[0].expires_at;
  assert.equal(new Date(exp).getTime(), new Date(old).getTime());
  // the earlier records are untouched
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM loyalty_lots')).rows[0].n, 4);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM loyalty_events')).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM loyalty_ledger WHERE kind='legacy_use'")).rows[0].n, 2);
});
