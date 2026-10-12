// End-to-end load evidence against a REAL PostgreSQL database: enqueue N durable jobs, run the separate worker
// process on them, and at the same time fire a burst of concurrent logins over HTTP. Records the oldest-due job lag,
// per-job queue latency, drain time and login latency (with and without the worker/job load).
//
// Usage: MEASURE_DB_OK=1 DATABASE_URL=postgres://... node scripts/measure-load.mjs [jobs=500] [logins=50] [hashConcurrency=2]
//
// It WRITES rows (users with handle `loadtest_*`, jobs in category `loadtest`) and never deletes anything, so point it at a
// throwaway database only (MEASURE_DB_OK=1 is the acknowledgement). Nothing here touches the production database.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER = process.argv.includes('--worker');
const nums = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JOBS = Number(nums[0] ?? 500), LOGINS = Number(nums[1] ?? 50);
process.env.HASH_CONCURRENCY = nums[2] ?? process.env.HASH_CONCURRENCY ?? '2';
process.env.HASH_MAX_QUEUE = process.env.HASH_MAX_QUEUE ?? String(Math.max(64, LOGINS * 2));
process.env.SPORTARENA_MASTER_KEY ??= randomBytes(32).toString('base64');
process.env.SPORTARENA_JWT_SECRET ??= randomBytes(32).toString('base64');
process.env.ACCESS_LOG = 'false';
process.env.NOTIFY_INTERVAL_SECONDS = '1';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
if (!WORKER && process.env.MEASURE_DB_OK !== '1') { console.error('This script writes rows. Set MEASURE_DB_OK=1 and point DATABASE_URL at a throwaway database.'); process.exit(2); }

const { pool } = await import('../apps/api/src/db.js');

if (WORKER) {
  // The worker process: drains the `loadtest` jobs (a ~15 ms simulated I/O handler) and runs the real maintenance cycle each tick.
  const { runJobs } = await import('../apps/api/src/jobs.js');
  const { maintenanceCycle } = await import('../apps/api/src/worker.js');
  const { createWorker, onShutdown } = await import('../apps/api/src/worker-runtime.js');
  const handlers = { 'loadtest.noop': async () => { await new Promise((r) => setTimeout(r, 15)); } };
  const cycle = async () => {
    for (let n = 1; n;) n = (await runJobs('loadtest', handlers, { limit: 25 })).claimed;
    return maintenanceCycle();
  };
  const w = createWorker({ mode: 'external', intervalSeconds: 1, cycle });
  await w.start();
  w.tick().catch(() => {});
  onShutdown(async () => { await w.stop(); await pool.end(); });
} else {
  const { migrate } = await import('../apps/api/src/migrate.js');
  const { createApp } = await import('../apps/api/src/http.js');
  const { hashPassword, blindIndex, hashingStats } = await import('../apps/api/src/crypto.js');
  const { enqueue } = await import('../apps/api/src/jobs.js');
  await migrate();
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  const stats = (a) => { a = [...a].sort((x, y) => x - y); return a.length ? { p50: Math.round(pct(a, 50)), p95: Math.round(pct(a, 95)), max: Math.round(a.at(-1)) } : null; };

  const tag = randomBytes(4).toString('hex'), password = 'load-test-password-1';
  const stored = await hashPassword(password);
  const emails = Array.from({ length: LOGINS }, (_, i) => `loadtest_${tag}_${i}@example.com`);
  for (const [i, e] of emails.entries()) {
    await pool.query("INSERT INTO users(handle, display_name, roles, password_hash, email_enc, email_idx) VALUES ($1,$1,'{athlete}',$2,'x',$3)", [`loadtest_${tag}_${i}`, stored, blindIndex(e)]);
  }

  async function burst() {
    const lat = [], codes = {};
    const t0 = performance.now();
    await Promise.all(emails.map(async (email) => {
      const s = performance.now();
      const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      await r.arrayBuffer();
      lat.push(performance.now() - s); codes[r.status] = (codes[r.status] ?? 0) + 1;
    }));
    return { logins: LOGINS, statuses: codes, wall_ms: Math.round(performance.now() - t0), latency_ms: stats(lat) };
  }

  await burst(); // warm-up (JIT, decoy hash, connection pool)
  const baseline = await burst();

  // enqueue, start the worker process, and fire the login burst while it drains
  const cat = 'loadtest', kind = 'loadtest.noop';
  for (let i = 0; i < JOBS; i++) await enqueue(null, { category: cat, kind, payload: { n: i }, dedupeKey: `${tag}-${i}` });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = new Promise((r) => child.on('exit', r));
  let maxLagMs = 0, loginRun = null;
  const t0 = performance.now();
  const sampler = setInterval(async () => {
    const r = await pool.query("SELECT coalesce(extract(epoch FROM now() - min(run_at)) * 1000, 0)::int AS lag FROM jobs WHERE category=$1 AND status IN ('queued','running') AND dedupe_key LIKE $2", [cat, `${tag}-%`]).catch(() => null);
    if (r) maxLagMs = Math.max(maxLagMs, r.rows[0].lag);
  }, 100);
  const open = async () => Number((await pool.query("SELECT count(*) FROM jobs WHERE category=$1 AND status<>'succeeded' AND dedupe_key LIKE $2", [cat, `${tag}-%`])).rows[0].count);
  setTimeout(async () => { loginRun = await burst(); }, 500);   // let the worker get going, then burst
  while (await open() > 0 || !loginRun) { if (performance.now() - t0 > 300_000) { console.error('timed out'); break; } await new Promise((r) => setTimeout(r, 100)); }
  const drainMs = Math.round(performance.now() - t0);
  clearInterval(sampler);
  const { rows: [q] } = await pool.query(
    `SELECT count(*)::int AS n, coalesce(max(extract(epoch FROM finished_at - run_at)) * 1000, 0)::int AS max_ms,
            coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - run_at)) * 1000, 0)::int AS p50_ms,
            coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - run_at)) * 1000, 0)::int AS p95_ms
       FROM jobs WHERE category=$1 AND status='succeeded' AND dedupe_key LIKE $2`, [cat, `${tag}-%`]);
  child.kill('SIGTERM'); await exited;
  console.log(JSON.stringify({
    env: { cpus: availableParallelism(), node: process.version, hash_concurrency: Number(process.env.HASH_CONCURRENCY), note: 'API + load client share one process; worker is a separate process; same host as the database' },
    jobs: { enqueued: JOBS, succeeded: q.n, drain_ms: drainMs, jobs_per_s: +(q.n / (drainMs / 1000)).toFixed(1), oldest_due_lag_ms_max_sampled: maxLagMs, enqueue_to_done_ms: { p50: q.p50_ms, p95: q.p95_ms, max: q.max_ms } },
    login_baseline_no_jobs: baseline,
    login_during_worker_drain: loginRun,
    hashing: hashingStats(),
  }, null, 1));
  server.close(); await pool.end();
}
