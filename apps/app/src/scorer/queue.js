// The scorer's offline-safe send queue, shared by every live scoring screen (official games, heats, field flights).
// A tap is queued on the device first, then sent. If the network or the server is down it stays queued (and survives closing the app) and
// is retried; the client_key it carries makes a retry safe, so a tap can never count twice. Rules for what happens to a queued tap:
//   sent                      removed
//   4xx (refused by the rules) removed, and the reason is shown: retrying would be refused again
//   409 stale_state           kept and held: someone else scored since this device last looked. The scorer chooses to send it anyway
//                             or discard it; nothing is decided silently
//   network / 5xx             kept, retried every 8 s, when the device is back online and when the app returns to the foreground
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { storage } from '../storage';

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const CHUNK = 1400;      // SecureStore values are small on some devices, so a queue is kept in pieces
const MAX_QUEUE = 800;   // a whole cricket innings or a long match with no signal fits; beyond that the scorer is told, not buffered forever
const RETRY_MS = 8000;

async function load(key) {
  try {
    const n = Number(await storage.get(`${key}.n`)) || 0;
    if (n) {
      let text = '';
      for (let i = 0; i < n; i++) text += (await storage.get(`${key}.${i}`)) ?? '';
      const list = JSON.parse(text);
      if (Array.isArray(list)) return list;
    }
    // the earlier single-key format (Tools tracker): a queue left by an older build is picked up, never lost
    const legacy = JSON.parse((await storage.get(key)) ?? 'null');
    return Array.isArray(legacy) ? legacy : [];
  } catch { return []; }
}
const written = new Map(); // key -> the pieces last stored, so a tap rewrites only the pieces that changed (a long queue stays cheap on the keychain)
async function save(key, list) {
  const old = Number(await storage.get(`${key}.n`)) || 0;
  const text = list.length ? JSON.stringify(list) : '';
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  const prev = written.get(key) ?? [];
  for (let i = 0; i < parts.length; i++) if (parts[i] !== prev[i]) await storage.set(`${key}.${i}`, parts[i]);
  written.set(key, parts);
  if (parts.length) await storage.set(`${key}.n`, String(parts.length));
  for (let i = parts.length; i < old; i++) await storage.del(`${key}.${i}`);
  if (!parts.length) await storage.del(`${key}.n`);
  await storage.del(key); // the legacy key is retired once the queue is in the new format
}

/**
 * @param {string} key  storage key for this record, e.g. `sa_queue_fx_<id>`
 * @param {(event: object) => Promise<any>} send  sends one queued event; throws ApiError on failure
 * @param {{ onSent?: (result: any, event: object) => void, onDrop?: (error: Error, event: object) => void }} [hooks]
 */
export function useScoreQueue(key, send, { onSent, onDrop, owner } = {}) {
  const [pending, setPending] = useState([]);
  const [conflict, setConflict] = useState(null);
  const ref = useRef([]);
  const flushing = useRef(false);
  const hooks = useRef({ send, onSent, onDrop, owner });
  hooks.current = { send, onSent, onDrop, owner };
  ref.current = pending;

  // the stored queue is read before anything is written back, and writes run one at a time, so a restart can never erase unsent taps
  const [ready, setReady] = useState(false);
  const writing = useRef(Promise.resolve());
  useEffect(() => {
    let on = true;
    load(key).then((q) => {
      if (!on) return;
      if (q.length) { ref.current = [...q.filter((e) => !ref.current.some((x) => x.client_key === e.client_key)), ...ref.current]; setPending(ref.current); }
      setReady(true);
    });
    return () => { on = false; };
  }, [key]);
  useEffect(() => { if (ready) { const list = pending; writing.current = writing.current.then(() => save(key, list)).catch(() => {}); } }, [pending, key, ready]);

  const drop = useCallback((e) => { ref.current = ref.current.filter((x) => x.client_key !== e.client_key); setPending(ref.current); }, []);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (const e of [...ref.current]) {
        // taps made by someone else on this device are kept, never sent under this account and never thrown away
        if (e.owner && hooks.current.owner && e.owner !== hooks.current.owner) break;
        try {
          const r = await hooks.current.send(e);
          drop(e); hooks.current.onSent?.(r, e);
        } catch (err) {
          if (err?.status === 409 && err.details?.code === 'stale_state') { setConflict({ event: e, state: err.details.state, last_seq: err.details.last_seq, missed: err.details.missed ?? [] }); break; }
          if (err?.status && err.status < 500) { drop(e); hooks.current.onDrop?.(err, e); continue; }
          break; // offline or server trouble: keep it, the same client_key makes a retry safe
        }
      }
    } finally { flushing.current = false; }
  }, [drop]);

  /** A tap still waiting on this device can simply be taken back; one already sent has to be voided on the server. */
  const cancel = useCallback((clientKey) => { ref.current = ref.current.filter((x) => x.client_key !== clientKey); setPending(ref.current); }, []);

  const held = !!conflict;
  useEffect(() => {
    if (!pending.length || held) return undefined;
    const t = setInterval(flush, RETRY_MS);
    const on = () => flush();
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('online', on);
    const sub = AppState.addEventListener?.('change', (s) => { if (s === 'active') flush(); });
    flush();
    return () => { clearInterval(t); if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('online', on); sub?.remove?.(); };
  }, [pending.length > 0, held, flush]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Queue an event and try to send it now. `expected_seq` is only kept on the first queued event: the ones behind it follow the same
   * scorer's own taps, so they must not be refused because of them.
   * @returns {Promise<{ queued: boolean }>} queued=true when it is still waiting to be sent
   */
  const enqueue = useCallback(async (event) => {
    if (ref.current.length >= MAX_QUEUE) { hooks.current.onDrop?.(new Error('Too many taps are waiting to be sent. Get back online before scoring more.'), event); return { queued: true, full: true }; }
    // occurred_at: the moment the official pressed it, so a tap sent an hour late is not recorded as an hour late (the server bounds it)
    const e = { ...event, client_key: event.client_key ?? uid(), occurred_at: event.occurred_at ?? new Date().toISOString(), ...(owner ? { owner } : {}) };
    if (ref.current.length) delete e.expected_seq;
    ref.current = [...ref.current, e];
    setPending(ref.current);
    await flush();
    return { queued: ref.current.some((x) => x.client_key === e.client_key) };
  }, [flush, owner]);

  /** Change a tap that is still waiting on this device (a correction of something not yet sent): it simply goes out as it should have been. */
  const edit = useCallback((clientKey, patch) => { ref.current = ref.current.map((x) => (x.client_key === clientKey ? { ...x, ...patch } : x)); setPending(ref.current); }, []);

  /** 'resend' sends the held tap on top of the newer state (the server still checks it against the rules); 'discard' drops it. */
  const resolve = useCallback(async (choice) => {
    const c = conflict;
    if (!c) return;
    setConflict(null);
    if (choice === 'discard') { drop(c.event); return; }
    ref.current = ref.current.map((x) => (x.client_key === c.event.client_key ? (({ expected_seq, ...rest }) => rest)(x) : x));
    setPending(ref.current);
    await flush();
  }, [conflict, drop, flush]);

  const foreign = owner ? pending.filter((e) => e.owner && e.owner !== owner).length : 0;
  return { pending, conflict, enqueue, flush, resolve, cancel, edit, foreign, full: pending.length >= MAX_QUEUE };
}

/** How many taps are waiting on this device for one game (without opening it), for the match-day list. */
export async function waitingCount(key) { return (await load(key)).length; }
