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

function stream(req, res, channel, snapshot) {
  if (open >= MAX_STREAMS) return res.status(503).json({ error: { code: 'busy', message: 'Too many live viewers right now; poll instead' } });
  open++;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const on = (data) => send('state', data);
  bus.on(channel, on);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  let closed = false;
  req.on('close', () => { if (closed) return; closed = true; open--; clearInterval(beat); bus.off(channel, on); });
  snapshot().then((s) => send('state', s)).catch(() => { send('error', { message: 'snapshot failed' }); res.end(); });
}

export function liveRouter() {
  const r = Router();
  const visible = async (sql, id) => (await pool.query(sql, [id])).rows[0];
  r.get('/live/fixtures/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    const f = await visible("SELECT f.id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1 AND e.status <> 'draft'", req.params.id);
    if (!f) return res.status(404).json({ error: { code: 'not_found', message: 'Fixture not found' } });
    stream(req, res, `fixture:${f.id}`, () => liveState(f.id));
  });
  return r;
}
