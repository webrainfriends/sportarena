// Measures login-path latency and event-loop delay under concurrent password verifications.
// Usage: node scripts/measure-login.mjs [logins=50] [hashConcurrency=2]
// Runs in-process (no DB, no HTTP): it exercises exactly the CPU-heavy part of POST /auth/login and
// compares it with the old synchronous scryptSync behaviour.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { scryptSync, randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';

process.env.SPORTARENA_MASTER_KEY ??= randomBytes(32).toString('base64');
process.env.SPORTARENA_JWT_SECRET ??= randomBytes(32).toString('base64');
const N = Number(process.argv[2] ?? 50);
process.env.HASH_CONCURRENCY = process.argv[3] ?? process.env.HASH_CONCURRENCY ?? '2';
process.env.HASH_MAX_QUEUE = String(N * 2);
const { hashPassword, verifyPassword, hashingStats } = await import('../apps/api/src/crypto.js');

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const stored = await hashPassword('benchmark-password');

async function run(label, fn) {
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const lat = [];
  // independent probe: a 10ms timer; its worst lateness is how long the loop was unresponsive
  let last = performance.now(), maxGap = 0;
  const probe = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last - 10); last = n; }, 10);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: N }, async () => { await Promise.resolve(); const s = performance.now(); await fn(); lat.push(performance.now() - s); }));
  await new Promise((r) => setTimeout(r, 20));
  const wall = performance.now() - t0 - 20; h.disable(); clearInterval(probe);
  lat.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode: label, logins: N, hash_concurrency: Number(process.env.HASH_CONCURRENCY), cpus: availableParallelism(),
    wall_ms: Math.round(wall), throughput_per_s: +(N / (wall / 1000)).toFixed(1),
    latency_ms: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), max: Math.round(lat.at(-1)) },
    max_loop_stall_ms: Math.round(Math.max(0, maxGap)),
    event_loop_delay_ms: { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) },
  }));
}

await run('sync-baseline(scryptSync)', async () => { scryptSync('benchmark-password', Buffer.from('0123456789abcdef'), 64, { N: 16384, r: 8, p: 1 }); });
await run('async-bounded', () => verifyPassword('benchmark-password', stored));
console.log(JSON.stringify({ hashing: hashingStats() }));
