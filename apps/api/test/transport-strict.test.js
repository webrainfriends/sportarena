import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Production-mode transport policy (separate file = separate process, so config is read fresh).
process.env.NODE_ENV = 'production';
process.env.SPORTARENA_MASTER_KEY = randomBytes(32).toString('base64');
process.env.SPORTARENA_JWT_SECRET = randomBytes(32).toString('hex');
process.env.TRUST_PROXY = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
before(async () => { await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('production refuses plain HTTP, accepts it only when the proxy says the client used HTTPS', async () => {
  const plain = await fetch(`${base}/api/v1/sports`);
  assert.equal(plain.status, 426);
  assert.equal((await plain.json()).error.code, 'https_required');
  const viaProxy = await fetch(`${base}/api/v1/sports`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(viaProxy.status, 200);
  assert.match(viaProxy.headers.get('strict-transport-security'), /max-age=63072000/);
});
