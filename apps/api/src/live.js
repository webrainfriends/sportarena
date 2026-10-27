// Live scoreboards over Server-Sent Events. The API runs as one process, so an in-memory bus is enough;
// with several processes, replace publish/subscribe with Postgres LISTEN/NOTIFY and nothing else changes.
// Clients that cannot hold a stream open fall back to polling get_live_fixture.
import { Router } from 'express';
import { EventEmitter } from 'node:events';
import { pool } from './db.js';
import { liveState } from './scoring/state.js';

const bus = new EventEmitter();
bus.setMaxListeners(0);
const MAX_STREAMS = 2000;
let open = 0;

export const publish = (channel, data) => bus.emit(channel, data);
export const streamCount = () => open;

function stream(req, res, channel, snapshot, shape = async (d) => d) {
  if (open >= MAX_STREAMS) return res.status(503).json({ error: { code: 'busy', message: 'Too many live viewers right now; poll instead' } });
  open++;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const on = (data) => { shape(data).then((d) => send('state', d)).catch(() => {}); };
  bus.on(channel, on);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  let closed = false;
  req.on('close', () => { if (closed) return; closed = true; open--; clearInterval(beat); bus.off(channel, on); });
  snapshot().then(shape).then((s) => send('state', s)).catch(() => { send('error', { message: 'snapshot failed' }); res.end(); });
}

export function liveRouter() {
  const r = Router();
  const visible = async (sql, id) => (await pool.query(sql, [id])).rows[0];
  r.get('/live/fixtures/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    const f = await visible("SELECT f.id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1 AND e.status <> 'draft' AND e.public_visibility <> 'private'", req.params.id);
    if (!f) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    stream(req, res, `fixture:${f.id}`, () => liveState(f.id));
  });
  // the spectator stream: the same live feed reshaped to the allow-listed public view (no player ids of young people, no void events, no notes)
  r.get('/live/public/fixtures/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    const f = await visible("SELECT f.id, f.event_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1 AND e.status <> 'draft' AND e.public_visibility <> 'private'", req.params.id);
    if (!f) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    const { publicLiveFrom } = await import('./spectator.js');
    const ev = await visible('SELECT id, max_age, public_show_officials FROM events WHERE id=$1', f.event_id);
    stream(req, res, `fixture:${f.id}`, () => liveState(f.id), (state) => publicLiveFrom(ev, state));
  });
  return r;
}
