import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.DATABASE_URL = DB;
process.env.SPORTARENA_MASTER_KEY ??= randomBytes(32).toString('base64');
process.env.SPORTARENA_JWT_SECRET ??= randomBytes(32).toString('base64');
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { config } = await import('../src/config.js');
const { createWorker, runsMaintenanceInProcess } = await import('../src/worker-runtime.js');
const { runWithContext, log } = await import('../src/logger.js');
const metrics = await import('../src/metrics.js');

let server, base, admin, user;
const get = (path, token, headers = {}) => fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const wait = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };
const mkUser = async (h, roles) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,$2,'x','x',$1) RETURNING id", [h, roles])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles }) }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  metrics.startMetrics();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkUser('ops_root', ['admin']);
  user = await mkUser('ops_user', ['athlete']);
});
after(async () => { server.close(); await pool.end(); });

test('every response carries a correlation id; a sane incoming x-request-id is kept, a bad one is replaced', async () => {
  const a = await get('/health');
  assert.match(a.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const b = await get('/health', null, { 'x-request-id': 'client-trace-12345' });
  assert.equal(b.headers.get('x-request-id'), 'client-trace-12345');
  const c = await get('/health', null, { 'x-request-id': 'bad id <script>' });
  assert.notEqual(c.headers.get('x-request-id'), 'bad id <script>');
  assert.match(c.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.equal((await get('/api/v1/nope')).headers.get('x-request-id').length > 0, true, 'errors too');
});

test('structured logs carry the request/job ids and drop sensitive keys', () => {
  const lines = [];
  const orig = console.log; console.log = (l) => lines.push(l);
  try { runWithContext({ request_id: 'req-1', job_id: 'job-9' }, () => log('info', 'hello', { path: '/x', password: 'hunter2', token: 't', email: 'a@b.co', body: '{}', ms: 3 })); } finally { console.log = orig; }
  const o = JSON.parse(lines[0]);
  assert.equal(o.request_id, 'req-1'); assert.equal(o.job_id, 'job-9'); assert.equal(o.msg, 'hello'); assert.equal(o.ms, 3);
  for (const k of ['password', 'token', 'email', 'body']) assert.equal(k in o, false, `${k} must not be logged`);
  assert.equal(lines[0].includes('hunter2'), false);
});

test('a worker publishes heartbeats, never overlaps cycles, and stops gracefully after the cycle in flight', async () => {
  let running = 0, maxRunning = 0, finished = 0;
  const w = createWorker({ mode: 'inprocess', intervalSeconds: 1, workerId: 'test-graceful', cycle: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 600)); running--; finished++; return {}; } });
  await w.start();
  const first = (await pool.query("SELECT * FROM worker_heartbeats WHERE worker_id='test-graceful'")).rows[0];
  assert.equal(first.status, 'running'); assert.equal(first.mode, 'inprocess');
  w.tick(); // a cycle starts
  await wait(() => w.inflight);
  const stopping = w.stop();   // SIGTERM arrives while the cycle is running
  assert.equal(finished, 0, 'stop was requested mid-cycle');
  await stopping;
  assert.equal(finished, 1, 'the in-flight cycle was awaited, not abandoned');
  assert.equal(maxRunning, 1, 'cycles never overlap');
  const row = (await pool.query("SELECT * FROM worker_heartbeats WHERE worker_id='test-graceful'")).rows[0];
  assert.equal(row.status, 'stopped'); assert.equal(row.cycles, 1); assert.ok(row.last_cycle_at);
  await w.tick();
  assert.equal(finished, 1, 'no new work is claimed after stop');
});

test('a failing cycle is recorded in the heartbeat and does not kill the worker', async () => {
  const w = createWorker({ mode: 'inprocess', intervalSeconds: 60, workerId: 'test-failing', cycle: async () => ({ errors: { email: 'bridge down' } }) });
  await w.start(); await w.tick();
  const row = (await pool.query("SELECT * FROM worker_heartbeats WHERE worker_id='test-failing'")).rows[0];
  assert.equal(row.failed_cycles, 1); assert.match(row.last_error, /email/);
  const boom = createWorker({ mode: 'inprocess', intervalSeconds: 60, workerId: 'test-throwing', cycle: async () => { throw new Error('db gone'); } });
  await boom.start(); await boom.tick();
  assert.match((await pool.query("SELECT last_error FROM worker_heartbeats WHERE worker_id='test-throwing'")).rows[0].last_error, /db gone/);
  await w.stop(); await boom.stop();
});

test('worker health: admin only, shows workers and job lag; the unauthenticated probe goes 503 when beats are stale', async () => {
  assert.equal((await get('/api/v1/admin/worker-health')).status, 401);
  assert.equal((await get('/api/v1/admin/worker-health', user.token)).status, 403);
  await pool.query("UPDATE worker_heartbeats SET status='stopped'");
  assert.equal((await get('/health/worker')).status, 503, 'no live worker');
  const w = createWorker({ mode: 'external', intervalSeconds: 5, workerId: 'test-live', cycle: async () => ({}) });
  await w.start(); await w.tick();
  const probe = await get('/health/worker');
  assert.equal(probe.status, 200);
  const h = await (await get('/api/v1/admin/worker-health', admin.token)).json();
  assert.equal(h.healthy, true);
  const me = h.workers.find((x) => x.worker_id === 'test-live');
  assert.equal(me.alive, true); assert.equal(me.mode, 'external'); assert.equal(me.cycles, 1);
  assert.ok('queue' in h.jobs && 'oldest_due_seconds' in h.jobs);

  // a queued job that is overdue shows up as lag
  await pool.query("INSERT INTO jobs(category, kind, run_at) VALUES ('lag','lag.task', now() - interval '10 minutes')");
  const lagged = await (await get('/api/v1/admin/worker-health', admin.token)).json();
  assert.ok(lagged.jobs.oldest_due_seconds >= 600);
  assert.equal(lagged.healthy, false, 'long-overdue work makes the worker unhealthy');
  await pool.query("DELETE FROM jobs WHERE category='lag'");

  // stale heartbeat
  await pool.query("UPDATE worker_heartbeats SET last_beat_at = now() - interval '1 hour' WHERE worker_id='test-live'");
  assert.equal((await get('/health/worker')).status, 503);
  assert.equal((await (await get('/api/v1/admin/worker-health', admin.token)).json()).healthy, false);
  await w.stop();
});

test('metrics: admin only; event-loop delay, http counters, hashing and job gauges, no payloads', async () => {
  assert.equal((await get('/api/v1/admin/metrics', user.token)).status, 403);
  await get('/health');
  const m = await (await get('/api/v1/admin/metrics', admin.token)).json();
  assert.ok(m.process.event_loop_delay_ms.max >= 0);
  assert.ok(m.process.http.requests > 0);
  assert.ok('concurrency' in m.hashing);
  assert.ok(Array.isArray(m.jobs.queue));
  assert.equal(JSON.stringify(m).includes('payload'), false);
});

test('WORKER_MODE=external stops the API from running maintenance; default stays in-process', () => {
  assert.equal(runsMaintenanceInProcess({ workerMode: 'inprocess', notifyIntervalSeconds: 60 }), true);
  assert.equal(runsMaintenanceInProcess({ workerMode: 'external', notifyIntervalSeconds: 60 }), false);
  assert.equal(runsMaintenanceInProcess({ workerMode: 'inprocess', notifyIntervalSeconds: 0 }), false);
  assert.equal(config.workerMode, 'inprocess');
});

test('the standalone worker process starts, beats, logs JSON with a worker id, and exits 0 on SIGTERM', async () => {
  const entry = fileURLToPath(new URL('../src/worker-main.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DATABASE_URL: DB, NOTIFY_INTERVAL_SECONDS: '1', WORKER_MODE: 'external', ACCESS_LOG: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const row = await wait(async () => (await pool.query("SELECT * FROM worker_heartbeats WHERE mode='external' AND worker_id LIKE $1 AND cycles::int >= 1", [`${child.pid}-%`])).rows[0]);
    assert.equal(row.status, 'running');
    child.kill('SIGTERM');
    const res = await exited;
    assert.deepEqual(res, { code: 0, signal: null }, 'clean exit');
    const after = (await pool.query('SELECT status FROM worker_heartbeats WHERE worker_id=$1', [row.worker_id])).rows[0];
    assert.equal(after.status, 'stopped');
  } finally { child.kill('SIGKILL'); }
  const json = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.ok(json.some((l) => l.msg === 'worker started'));
  assert.ok(json.some((l) => l.msg === 'cycle complete' && l.worker_id && l.cycle_id), 'cycle logs carry worker and cycle ids');
  assert.ok(json.some((l) => l.msg === 'worker stopped'));
  assert.equal(out.includes(process.env.SPORTARENA_MASTER_KEY), false, 'secrets are never logged');
});
