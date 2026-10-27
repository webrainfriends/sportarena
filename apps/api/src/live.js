// Live scoreboards over Server-Sent Events.
//  * Spectator streams (/live/fixtures/:id, /live/sessions/:id) are public and read-only: they carry the spectator-safe state (voided events and
//    reasons are never sent) and cannot write anything. Every frame has an id "<last_seq>:<version>"; a reconnecting client sends it back
//    (Last-Event-ID, or ?cursor=) and gets the events it missed. `version` also moves on a void/correction, so a client can tell it is stale.
//  * Scorer streams (/live/fixtures/:id/scorer, /live/sessions/:id/scorer) need a signed-in organiser or match official. They carry voided
//    events and the scorer lease, and authority is re-checked on every update and every 10 s: when it is revoked or reassigned the stream
//    says so and closes, with no need to wait for the next write.
//  * One process uses an in-memory bus. With several processes set LIVE_BRIDGE=pg: each publish also NOTIFYs Postgres and the other
//    processes refresh their own streams from the database.
// Clients that cannot hold a stream open (React Native has no EventSource) poll get_live_fixture / get_live_session with since_seq.
import { Router } from 'express';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { pool } from './db.js';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { liveState } from './scoring/state.js';

const bus = new EventEmitter();
bus.setMaxListeners(0);
const MAX_STREAMS = 2000;
const MAX_PER_IP = 25;
const RECHECK_MS = 10_000;
const NOTIFY_CHANNEL = 'sa_live';
const REFRESH = Symbol('refresh');
let open = 0;
const perIp = new Map();
const processId = Math.random().toString(36).slice(2);

export const publish = (channel, data) => {
  bus.emit(channel, data);
  if (process.env.LIVE_BRIDGE === 'pg') pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify({ channel, from: processId })]).catch(() => {});
};
export const streamCount = () => open;

/** Listen for other processes' publishes (LIVE_BRIDGE=pg) and refresh local streams from the database. */
let bridge = null;
async function startBridge() {
  if (bridge || process.env.LIVE_BRIDGE !== 'pg') return;
  bridge = new pg.Client({ connectionString: config.databaseUrl });
  bridge.on('error', () => { bridge = null; setTimeout(() => startBridge().catch(() => {}), 2000).unref(); });
  bridge.on('notification', (m) => {
    try { const { channel, from } = JSON.parse(m.payload); if (from !== processId) bus.emit(channel, REFRESH); } catch { /* ignore a malformed notification */ }
  });
  await bridge.connect();
  bridge.connection?.stream?.unref?.();
  await bridge.query(`LISTEN ${NOTIFY_CHANNEL}`);
}

const parseCursor = (req) => {
  const raw = req.get('last-event-id') ?? req.query.cursor;
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
const frameId = (s) => (s && s.last_seq != null ? `${s.last_seq}:${s.version ?? s.last_seq}` : undefined);

/**
 * @param snapshot (sinceSeq) => state for this kind of viewer
 * @param recheck async () => boolean; false closes the stream with a `revoked` frame (scorer streams)
 * @param shape async (state) => the view this stream sends (the public spectator stream sends an allow-listed reshaping); frame ids and the cursor follow the full state
 */
function stream(req, res, { channel, snapshot, recheck, shape }) {
  const ip = req.ip;
  if (open >= MAX_STREAMS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) return res.status(503).json({ error: { code: 'busy', message: 'Too many live viewers right now; poll instead' } });
  open++; perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  let closed = false, since = parseCursor(req), queue = Promise.resolve();
  const send = (event, data, id) => { res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const end = () => { if (closed) return; closed = true; open--; perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1)); clearInterval(beat); clearInterval(check); bus.off(channel, on); res.end(); };
  const push = async (state) => {
    if (closed) return;
    if (recheck && !(await recheck())) { send('revoked', { message: 'Your scoring access for this game has ended' }); return end(); }
    send('state', shape ? await shape(state) : state, frameId(state));
    since = state.last_seq ?? since;
  };
  // updates are applied one at a time and in order, so a slow database read never lets an older frame overtake a newer one
  const on = (data) => { queue = queue.then(async () => { if (!closed) await push(recheck || data === REFRESH || typeof data !== 'object' ? await snapshot(since) : data); }).catch(() => {}); };
  bus.on(channel, on);
  const beat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 25_000);
  const check = setInterval(() => { if (recheck) queue = queue.then(async () => { if (!closed && !(await recheck())) { send('revoked', { message: 'Your scoring access for this game has ended' }); end(); } }).catch(() => {}); }, RECHECK_MS);
  req.on('close', end);
  queue = queue.then(async () => push(await snapshot(since))).catch(() => { if (!closed) { send('error', { message: 'snapshot failed' }); end(); } });
}

const UUID = /^[0-9a-f-]{36}$/;
const gone = (res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });

export function liveRouter() {
  const r = Router();
  startBridge().catch(() => {});
  const visible = async (sql, id) => (await pool.query(sql, [id])).rows[0];

  // ---- spectators: public, read-only
  r.get('/live/fixtures/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return gone(res);
    const f = await visible("SELECT f.id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1 AND e.status <> 'draft' AND e.public_visibility <> 'private'", req.params.id);
    if (!f) return gone(res);
    stream(req, res, { channel: `fixture:${f.id}`, snapshot: (since) => liveState(f.id, null, { sinceSeq: since }) });
  });
  // the public web page's stream (#501): the same feed reshaped to the allow-listed public view (no young people's ids, no void events, no notes)
  r.get('/live/public/fixtures/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return gone(res);
    const f = await visible("SELECT f.id, f.event_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1 AND e.status <> 'draft' AND e.public_visibility <> 'private'", req.params.id);
    if (!f) return gone(res);
    const { publicLiveFrom } = await import('./spectator.js');
    const ev = await visible('SELECT id, max_age, public_show_officials FROM events WHERE id=$1', f.event_id);
    stream(req, res, { channel: `fixture:${f.id}`, snapshot: (since) => liveState(f.id, null, { sinceSeq: since }), shape: (state) => publicLiveFrom(ev, state) });
  });
  r.get('/live/sessions/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return gone(res);
    const s = await visible("SELECT s.id FROM event_sessions s JOIN events e ON e.id=s.event_id WHERE s.id=$1 AND e.status <> 'draft' AND e.public_visibility <> 'private'", req.params.id);
    if (!s) return gone(res);
    const { sessionLive } = await import('./capabilities/live-scoring.js');
    stream(req, res, { channel: `session:${s.id}`, snapshot: (since) => sessionLive(s.id, null, { sinceSeq: since }) });
  });

  // ---- scorers: signed in, organiser or match official only; authority is re-checked while the stream is open
  r.get('/live/fixtures/:id/scorer', async (req, res) => {
    if (!UUID.test(req.params.id)) return gone(res);
    const authz = req.headers.authorization;
    const user = await authenticate(authz);
    if (!user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    const { fixtureContext } = await import('./capabilities/match-tracking.js');
    const can = async () => { const u = await authenticate(authz); if (!u) return false; try { return (await fixtureContext(u, req.params.id)).canScore; } catch { return false; } };
    if (!(await can())) return gone(res);   // 404, not 403: a spectator learns nothing about who may score
    stream(req, res, {
      channel: `fixture:${req.params.id}`, recheck: can,
      snapshot: async (since) => {
        const state = await liveState(req.params.id, null, { sinceSeq: since, includeVoided: true });
        const lease = (await pool.query("SELECT l.user_id, u.display_name, l.device, l.expires_at FROM fixture_scorer_leases l JOIN users u ON u.id=l.user_id WHERE l.fixture_id=$1 AND l.expires_at > now()", [req.params.id])).rows[0] ?? null;
        return { ...state, scorer: lease };
      },
    });
  });
  r.get('/live/sessions/:id/scorer', async (req, res) => {
    if (!UUID.test(req.params.id)) return gone(res);
    const authz = req.headers.authorization;
    const user = await authenticate(authz);
    if (!user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    const { sessionLive, canScoreSession } = await import('./capabilities/live-scoring.js');
    const can = async () => { const u = await authenticate(authz); return !!u && canScoreSession(u, req.params.id); };
    if (!(await can())) return gone(res);
    stream(req, res, { channel: `session:${req.params.id}`, recheck: can, snapshot: (since) => sessionLive(req.params.id, user, { sinceSeq: since, includeVoided: true }) });
  });
  return r;
}
