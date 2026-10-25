// Offline capture and reliable sync for the player (issue #336).
// A match log, a workout result or a training load is first saved as an encrypted draft on this device (offline-store.js), then
// uploaded in order through POST /me/sync. Every draft has its own client_key, so an upload that was cut off half way can be sent
// again without creating a second record. What the server answers decides what happens to the draft:
//   applied / duplicate  -> removed from this device
//   conflict             -> the record changed elsewhere; the server keeps the draft and the player settles it (Offline & sync)
//   rejected             -> not accepted (invalid, or a guardian's consent was withdrawn). Retryable ones stay here to be sent again.
//   network / 5xx        -> stays queued and is retried
// The coaching outbox (outbox.js) stays memory-only on purpose; this queue is for the player's own records and is the only one that
// survives closing the app.
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { api } from './api';
import { storage } from './storage';
import { offlineStore } from './offline-store';

const DEVICE_KEY = 'sa_device_id';
const MODE_KEY = 'sa_signout_mode';        // 'sync' (default): upload what can be uploaded, keep the rest locked to this account | 'wipe': remove everything
const BATCH = 50;
const KIND_LABEL = { match_create: 'Match log', match_update: 'Match edit', workout_log: 'Workout log', load_log: 'Training load' };
export const kindLabel = (k) => KIND_LABEL[k] ?? 'Item';

const rnd = () => {
  try { return globalThis.crypto.randomUUID().replace(/-/g, ''); } catch { /* fall through */ }
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
};

let state = { items: [], recent: [], online: true, syncing: false, ready: false, persistent: false, notice: null, owner: null };
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(state));
const set = (patch) => { state = { ...state, ...patch }; emit(); };
export const offlineState = () => state;

const platform = () => (Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? (Platform.isPad ? 'ipados' : 'ios') : 'android');
const defaultLabel = () => ({ web: 'Web browser', ios: 'iPhone', ipados: 'iPad', android: 'Android device' }[platform()]);
async function deviceId(renew) {
  let id = renew ? null : await storage.get(DEVICE_KEY);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) { id = `dev${rnd()}`.slice(0, 40); await storage.set(DEVICE_KEY, id); }
  return id;
}
export const getSignOutMode = async () => ((await storage.get(MODE_KEY)) === 'wipe' ? 'wipe' : 'sync');
export const setSignOutMode = (m) => storage.set(MODE_KEY, m === 'wipe' ? 'wipe' : 'sync');

const persist = (item) => offlineStore.write(item).catch(() => {});
const retryableNet = (e) => !e?.status || e.status >= 500 || e.status === 429;
const isNetwork = (e) => !e?.status;

/** Called when the signed-in person is known. Drafts that belong to someone else are removed; this person's are picked up again. */
export async function initOffline(userId) {
  if (!userId) { set({ items: [], ready: false, owner: null }); return; }
  const persistent = await offlineStore.isPersistent();
  const all = await offlineStore.readAll();
  const mine = [];
  for (const d of all) { if (d.owner === userId) mine.push(d); else await offlineStore.erase(d.id); }
  mine.sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));
  set({ items: mine.map((d) => ({ ...d, status: d.status === 'syncing' ? 'queued' : d.status })), ready: true, persistent, owner: userId });
  api.post('/me/sync/devices', { id: await deviceId(), label: defaultLabel(), platform: platform() }).catch((e) => { if (e?.code === 'device_revoked') revokedHere(); });
  flush();
}

async function revokedHere() {
  await offlineStore.eraseAll();
  await deviceId(true);
  set({ items: [], notice: 'This device was signed out of offline sync, so the drafts saved on it were removed.' });
}

const body = (it) => ({ kind: it.kind, client_key: it.client_key, captured_at: it.captured_at, ...it.payload });

let flushing = null;
/** Upload queued drafts in the order they were captured. Safe to call any time; only one upload runs at once. */
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      for (;;) {
        const due = state.items.filter((i) => i.status === 'queued').slice(0, BATCH);
        if (!due.length || !state.owner) break;
        set({ syncing: true, items: state.items.map((i) => (due.includes(i) ? { ...i, status: 'syncing' } : i)) });
        let res;
        try {
          res = await api.post('/me/sync', { device: { id: await deviceId(), label: defaultLabel(), platform: platform() }, queued: state.items.length, ops: due.map(body) });
        } catch (e) {
          if (e?.code === 'device_revoked') { await revokedHere(); break; }
          const back = (i) => (due.includes(i) ? { ...i, status: 'queued', tries: (i.tries ?? 0) + 1 } : i);
          if (!retryableNet(e)) { // the whole request was refused (for example a field the server no longer accepts): keep the drafts, tell the player
            set({ items: state.items.map((i) => (due.includes(i) ? { ...i, status: 'rejected', message: e.message, retryable: false } : i)) });
            await Promise.all(due.map((i) => persist(state.items.find((x) => x.id === i.id))));
            break;
          }
          set({ online: !isNetwork(e) && state.online, items: state.items.map(back) });
          break;
        }
        const byKey = new Map(res.results.map((r) => [r.client_key, r]));
        const keep = [], done = [];
        for (const it of state.items) {
          const r = byKey.get(it.client_key);
          if (!due.includes(it) || !r) { keep.push(it); continue; }
          if (r.status === 'applied' || r.status === 'duplicate') { done.push({ ...it, outcome: r.status, at: new Date().toISOString() }); continue; }
          if (r.status === 'conflict') { done.push({ ...it, outcome: 'conflict', at: new Date().toISOString() }); continue; } // the server holds the draft now
          if (r.status === 'rejected' && r.retryable) { keep.push({ ...it, status: 'rejected', code: r.code, message: r.message, retryable: true, op: r.operation_id }); continue; }
          if (r.status === 'rejected') { done.push({ ...it, outcome: 'rejected', code: r.code, message: r.message, at: new Date().toISOString() }); continue; }
          keep.push({ ...it, status: 'queued', tries: (it.tries ?? 0) + 1 });
        }
        for (const d of done) await offlineStore.erase(d.id);
        for (const k of keep) await persist(k);
        set({ online: true, items: keep, recent: [...done.filter((d) => d.outcome === 'applied' || d.outcome === 'duplicate' || d.outcome === 'conflict'), ...state.recent].slice(0, 8), lastResults: res.results });
        if (res.results.some((r) => r.status === 'error')) break; // the server asked for a retry later
      }
    } finally { flushing = null; set({ syncing: false }); }
  })();
  return flushing;
}

/**
 * Save a draft on this device and upload it now if possible.
 * Resolves { outcome: 'saved' | 'queued' | 'conflict' | 'waiting', message? }. Throws when the server refuses it outright
 * (invalid, not allowed), so the form can show what to fix; nothing is kept for those.
 */
export async function saveDraft({ kind, payload, label, sub }) {
  if (!state.owner) throw new Error('Sign in to save this');
  const item = { id: `d${rnd()}`.slice(0, 36), client_key: `sa-${rnd()}`.slice(0, 60), kind, payload, label, sub, owner: state.owner, captured_at: new Date().toISOString(), status: 'queued', tries: 0 };
  await persist(item);
  set({ items: [...state.items, item] });
  await flush();
  const now = state.items.find((i) => i.id === item.id);
  if (now?.status === 'rejected') return { outcome: 'waiting', message: now.message };
  if (now) return { outcome: 'queued' };
  const r = state.recent.find((x) => x.id === item.id);
  if (r?.outcome === 'conflict') return { outcome: 'conflict' };
  const refused = state.lastResults?.find((x) => x.client_key === item.client_key && x.status === 'rejected');
  if (refused) throw new Error(refused.message ?? 'The server did not accept this');
  return { outcome: 'saved' };
}

/** Toast text for the result of saveDraft, so every form says the same thing. */
export const saveMessage = (r, saved) => ({
  saved, queued: 'Saved on this device. It uploads when you are back online.',
  conflict: 'Saved, but it changed on another device. Open Offline & sync to choose.',
  waiting: `Kept on this device, not uploaded: ${r.message ?? 'a guardian must allow it first'}.`,
}[r.outcome] ?? saved);

export async function retryItem(id) {
  set({ items: state.items.map((i) => (i.id === id ? { ...i, status: 'queued' } : i)) });
  await flush();
}
/** Remove a draft from this device. If the server already holds a refused copy it is discarded there too. */
export async function discardItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (it?.op) { try { await api.post(`/me/sync/operations/${it.op}/discard`); } catch { /* already gone */ } }
  await offlineStore.erase(id);
  set({ items: state.items.filter((i) => i.id !== id) });
}
export async function wipeDrafts() { await offlineStore.eraseAll(); set({ items: [] }); }

/** Sign-out: upload what can be uploaded, then either keep the rest locked to this account ('sync') or remove everything ('wipe'). */
export async function beforeSignOut() {
  const mode = await getSignOutMode();
  if (mode === 'wipe') { await wipeDrafts(); return { left: 0 }; }
  if (state.items.some((i) => i.status === 'queued')) await Promise.race([flush(), new Promise((r) => setTimeout(r, 6000))]);
  return { left: state.items.length };
}
export const clearNotice = () => set({ notice: null });

// connectivity: the browser says so directly; on a phone the first failed or successful upload tells us
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('online', () => { set({ online: true }); flush(); });
  window.addEventListener('offline', () => set({ online: false }));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) state.online = false;
} else {
  try { AppState.addEventListener('change', (s) => { if (s === 'active') flush(); }); } catch { /* not available */ }
}
setInterval(() => { if (state.items.some((i) => i.status === 'queued')) flush(); }, 15000);

export function useOffline() {
  const [s, setS] = useState(state);
  useEffect(() => { listeners.add(setS); setS(state); return () => { listeners.delete(setS); }; }, []);
  const waiting = s.items.filter((i) => i.status === 'queued' || i.status === 'syncing').length;
  return { ...s, waiting, flush, retry: retryItem, discard: discardItem };
}
