// Two API processes sharing one database with LIVE_BRIDGE=pg: an official scores on process A while a spectator streams from process B.
// B must push the new score without anyone polling. Needs a migrated throwaway database (E2E_DATABASE_URL). Run: node scripts/e2e/live-bridge-check.mjs
import { spawn } from 'node:child_process';
import pg from 'pg';
const URL_ = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e';
const env = (port) => ({ ...process.env, DATABASE_URL: URL_, PORT: String(port), LIVE_BRIDGE: 'pg', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'), PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' });
const cwd = new URL('../../apps/api/', import.meta.url).pathname;
const procs = [4001, 4002].map((p) => spawn('node', ['src/server.js'], { cwd, env: env(p), stdio: 'ignore' }));
const up = async (port) => { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/payments/methods`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`api ${port} did not start`); };
const db = new pg.Pool({ connectionString: URL_ });
let failed = false;
try {
  await Promise.all([up(4001), up(4002)]);
  const call = async (port, method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
  const reg = async (h, roles) => (await call(4001, 'POST', '/auth/register', { body: { handle: `${h}${Date.now()}`, display_name: h, email: `${h}${Date.now()}@example.com`, password: 'correct-horse-battery', roles } }));
  const org = await reg('brgorg', ['organizer']), ref = await reg('brgref', ['referee']), c1 = await reg('brgc1', ['coach']), c2 = await reg('brgc2', ['coach']);
  const ev = await call(4001, 'POST', '/events', { token: org.token, body: { name: `Bridge Cup ${Date.now()}`, sport: 'football' } });
  const home = await call(4001, 'POST', '/teams', { token: c1.token, body: { name: `Bridge Reds ${Date.now()}`, sport: 'football' } }), away = await call(4001, 'POST', '/teams', { token: c2.token, body: { name: `Bridge Blues ${Date.now()}`, sport: 'football' } });
  const fx = (await db.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, home.id, away.id])).rows[0].id;
  await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.user.id]);
  await call(4001, 'POST', `/fixtures/${fx}/start`, { token: ref.token });
  await call(4001, 'POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'period_start' } });

  // a spectator streams from process B
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:4002/api/v1/live/fixtures/${fx}`, { signal: ac.signal });
  const seen = [];
  const reader = (async () => { let buf = ''; try { for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const d = /data: (.*)/.exec(raw); if (d) seen.push(JSON.parse(d[1])); } } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 1500));
  const before = seen.length;
  // an official scores on process A
  await call(4001, 'POST', `/fixtures/${fx}/events`, { token: ref.token, body: { kind: 'goal', side: 'home', client_key: `bridge-${Date.now()}` } });
  for (let i = 0; i < 30 && !seen.some((s) => s.score?.home === 1); i++) await new Promise((r) => setTimeout(r, 200));
  const pushed = seen.some((s) => s.score?.home === 1);
  console.log(`${pushed ? 'PASS' : 'FAIL'}  process B pushed the goal scored on process A (${seen.length - before} frame(s) after the snapshot)`);
  failed = !pushed;
  ac.abort(); await reader;
} catch (e) { console.log('FAIL ', e.message); failed = true; }
finally { procs.forEach((p) => p.kill()); await db.end(); }
process.exit(failed ? 1 : 0);
