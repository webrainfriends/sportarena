// Offline handovers (#788). A custody record must never be lost to a dead signal or a closed app, so, unlike the in-memory coaching outbox, this queue
// is written to the encrypted device store (keychain on iOS / iPadOS / Android, a non-extractable WebCrypto key in IndexedDB on the web). Each item carries
// its own idempotency key and the time it really happened, and is judged by the server as of that time (a permission withdrawn earlier is refused and
// raised for review), so retrying the whole queue is always safe. The queue holds the staff member's own records only and is emptied on sign-out.
import { useEffect, useState } from 'react';
import { api } from './api';
import { makeStore } from './offline-store';

const store = makeStore({ db: 'sa_pickup', prefix: 'sa_pk' });
let items = [];
let owner = null;
let busy = false;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(items));
const persist = (item) => store.write(item).catch(() => {});

export const newKey = () => `pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
/** True for a dropped connection or a server fault (retry later); a refusal from the server is final and is shown to the supervisor. */
export const isOffline = (e) => !e?.status || e.status >= 502;

export async function loadQueue(userId) {
  owner = userId;
  const all = await store.readAll();
  items = [];
  for (const d of all) { if (d.owner === userId) items.push(d); else await store.erase(d.id); }   // never show or send another person's records
  emit();
  return items;
}

export async function queueHandover(userId, sessionId, label, body) {
  const item = { id: body.idempotency_key, owner: userId, session_id: sessionId, label, body, state: 'waiting', at: body.captured_at, message: null };
  items = [...items.filter((x) => x.id !== item.id), item];
  await persist(item); emit();
  return item;
}

/** Send everything waiting. Items the server answered with synced/already_synced are removed; conflicts stay, marked, for a supervisor. */
export async function flushQueue() {
  if (busy) return items;
  const todo = items.filter((x) => x.state === 'waiting');
  if (!todo.length) return items;
  busy = true;
  try {
    const out = await api.post('/academy/pickup/sync', { items: todo.map((x) => ({ session_id: x.session_id, ...x.body })) });
    for (const r of out.results) {
      const it = items.find((x) => x.id === r.idempotency_key);
      if (!it) continue;
      if (r.status === 'synced' || r.status === 'already_synced') { await store.erase(it.id); items = items.filter((x) => x.id !== it.id); }
      else { const next = { ...it, state: 'conflict', message: r.message ?? r.code }; items = items.map((x) => (x.id === it.id ? next : x)); await persist(next); }
    }
  } catch (e) { if (!isOffline(e)) throw e; } finally { busy = false; emit(); }
  return items;
}

export async function dismissItem(id) { await store.erase(id); items = items.filter((x) => x.id !== id); emit(); }
export async function clearQueue() { await store.eraseAll(); items = []; owner = null; emit(); }

export function useQueue(userId) {
  const [list, setList] = useState(items);
  useEffect(() => {
    listeners.add(setList);
    if (userId && owner !== userId) loadQueue(userId).catch(() => {});
    else setList(items);
    return () => { listeners.delete(setList); };
  }, [userId]);
  return list;
}
