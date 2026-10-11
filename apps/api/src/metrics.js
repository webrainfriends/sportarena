// Process-local metrics: event-loop delay, HTTP counters, background step and job counters. No payloads, no personal data.
// Each process reports its own numbers; the worker stores its snapshot in worker_heartbeats so the API can show both.
import { monitorEventLoopDelay } from 'node:perf_hooks';

const started = Date.now();
let loop;
const counters = new Map();
const steps = new Map();   // category -> { runs, failures, last_run_at, last_ok, last_error, last_ms, total_ms }
const http = { requests: 0, errors_5xx: 0, errors_4xx: 0, total_ms: 0, by_status: {} };

export function startMetrics() {
  if (!loop) { loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); }
}

export const inc = (name, by = 1) => counters.set(name, (counters.get(name) ?? 0) + by);

export function recordStep(category, { ok, ms, error }) {
  const s = steps.get(category) ?? { runs: 0, failures: 0, total_ms: 0 };
  s.runs++; s.total_ms += ms; s.last_ms = Math.round(ms); s.last_run_at = new Date().toISOString(); s.last_ok = ok;
  if (!ok) { s.failures++; s.last_error = String(error ?? '').slice(0, 200); }
  steps.set(category, s);
  inc(ok ? 'steps_ok_total' : 'steps_failed_total');
}

export function recordRequest(status, ms) {
  http.requests++; http.total_ms += ms;
  const cls = `${Math.floor(status / 100)}xx`;
  http.by_status[cls] = (http.by_status[cls] ?? 0) + 1;
  if (status >= 500) http.errors_5xx++; else if (status >= 400) http.errors_4xx++;
}

const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;

export function snapshot() {
  const mem = process.memoryUsage();
  return {
    uptime_seconds: Math.round((Date.now() - started) / 1000),
    event_loop_delay_ms: loop ? { mean: ms(loop.mean), p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) } : null,
    memory_mb: { rss: Math.round(mem.rss / 1048576), heap_used: Math.round(mem.heapUsed / 1048576) },
    http: { ...http, avg_ms: http.requests ? Math.round(http.total_ms / http.requests) : 0 },
    counters: Object.fromEntries(counters),
    steps: Object.fromEntries([...steps].map(([k, v]) => [k, { ...v, total_ms: undefined, avg_ms: v.runs ? Math.round(v.total_ms / v.runs) : 0 }])),
  };
}

export const resetEventLoop = () => loop?.reset();
