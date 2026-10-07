import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Production-mode transport policy (separate file = separate process, so config is read fresh).
process.env.NODE_ENV = 'production';
process.env.SPORTARENA_MASTER_KEY = randomBytes(32).toString('base64');
process.env.SPORTARENA_JWT_SECRET = randomBytes(32).toString('hex');
process.env.TRUST_PROXY = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.ALLOW_INSECURE_HTTP = 'true';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
before(async () => { await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('ALLOW_INSECURE_HTTP=true serves plain HTTP in production, without HSTS (so a later switch to TLS is not blocked)', async () => {
  const r = await fetch(`${base}/api/v1/sports`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('strict-transport-security'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});
