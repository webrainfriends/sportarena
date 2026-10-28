// A small in-memory retry queue for coaching writes made on a field with a weak signal (session notes, measurements, actions).
// It is deliberately NOT written to disk: coaching notes are sensitive, and the platform keychain is the only local store we have.
// So a queued write survives a dropped connection but not closing the app, and it is emptied on sign-out so one person's
// pending notes can never be sent under another account. Every item carries the server's idempotency key (client_key), so a
// retry after a half-completed request cannot create a duplicate.
import { useEffect, useState } from 'react';
import { api } from './api';

let queue = [];            // [{ method, path, body, tries }]
let running = false;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f({ pending: queue.length }));

/** Network failures (status 0) and server errors are retried; a refusal (400-499) is dropped, because retrying cannot fix it. */
const retryable = (e) => !e?.status || e.status >= 500 || e.status === 429;

export async function flush() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue[0];
      try { await api[item.method](item.path, item.body); queue.shift(); }
      catch (e) {
        if (retryable(e) && item.tries < 8) { item.tries++; break; }
        queue.shift();
        rejected = e?.message ?? 'The server refused a saved note';
      }
      emit();
    }
  } finally { running = false; emit(); }
}
export let rejected = null;
export const clearRejected = () => { rejected = null; emit(); };

/** Try now; if the connection is down, keep it and retry later. Resolves 'saved' or 'queued'; throws on a refusal the person must fix.
 *  `method` is 'post' (default) or 'patch'; a patch must be a plain state change (answering a selection), so repeating it is harmless. */
export async function send(path, body, method = 'post') {
  if (!body?.client_key) throw new Error('outbox writes need a client_key');
  try { const r = await api[method](path, body); return { status: 'saved', result: r }; }
  catch (e) {
    if (!retryable(e)) throw e;
    queue.push({ method, path, body, tries: 0 }); emit();
    setTimeout(flush, 4000);
    return { status: 'queued' };
  }
}
export const clearOutbox = () => { queue = []; rejected = null; emit(); }; // called on sign-out

export function useOutbox() {
  const [s, set] = useState({ pending: queue.length });
  useEffect(() => { listeners.add(set); set({ pending: queue.length }); return () => listeners.delete(set); }, []);
  useEffect(() => { if (s.pending) { const t = setInterval(flush, 8000); return () => clearInterval(t); } return undefined; }, [s.pending]);
  return { ...s, flush, rejected };
}
