// Where offline drafts are kept on the device, encrypted at rest.
//   Native (iOS, iPadOS, Android): the platform keychain / keystore (SecureStore). It is hardware-backed and locked with the device,
//     so a draft is as safe as a saved password. Long drafts are split into small pieces because a single value has a size limit.
//   Web: IndexedDB. Each draft is encrypted with AES-GCM using a key that the browser creates once and will not let any script read
//     (a non-extractable WebCrypto key), so copying the stored data off the machine yields nothing readable.
// The same store is made once per namespace: drafts ('sa_off') and the referee's match-day pack ('sa_pack') never see each other's records.
// If neither is available (an insecure web page, or a browser with storage turned off) `persistent` is false: drafts then live only
// in memory and the screens say so, instead of pretending they are safe across a restart.
import { Platform } from 'react-native';

const CHUNK = 1500;
const okId = (id) => /^[A-Za-z0-9_-]{6,64}$/.test(id);

// ------------------------------------------------------------------------------------------------ web
const idb = (ns) => new Promise((resolve, reject) => {
  const r = indexedDB.open(ns.db, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('keys'); r.result.createObjectStore('drafts'); };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const run = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode); const s = t.objectStore(store);
  const req = fn(s);
  t.oncomplete = () => resolve(req?.result);
  t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
});
async function webKey(db) {
  const have = await run(db, 'keys', 'readonly', (s) => s.get('k1'));
  if (have) return have;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await run(db, 'keys', 'readwrite', (s) => s.put(key, 'k1'));
  return key;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const makeWeb = (ns) => ({
  async available() { try { return typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle && (await idb(ns), true); } catch { return false; } },
  async readAll() {
    const db = await idb(ns); const key = await webKey(db);
    const ids = await run(db, 'drafts', 'readonly', (s) => s.getAllKeys());
    const out = [];
    for (const id of ids) {
      const row = await run(db, 'drafts', 'readonly', (s) => s.get(id));
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv), additionalData: new TextEncoder().encode(id) }, key, unb64(row.ct));
        out.push(JSON.parse(new TextDecoder().decode(plain)));
      } catch { await run(db, 'drafts', 'readwrite', (s) => s.delete(id)); } // unreadable (key lost): remove it rather than keep dead data
    }
    return out;
  },
  async write(d) {
    const db = await idb(ns); const key = await webKey(db);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(d.id) }, key, new TextEncoder().encode(JSON.stringify(d)));
    await run(db, 'drafts', 'readwrite', (s) => s.put({ iv: b64(iv), ct: b64(ct) }, d.id));
  },
  async erase(id) { const db = await idb(ns); await run(db, 'drafts', 'readwrite', (s) => s.delete(id)); },
  async eraseAll() { const db = await idb(ns); await run(db, 'drafts', 'readwrite', (s) => s.clear()); await run(db, 'keys', 'readwrite', (s) => s.clear()); },
});

// ------------------------------------------------------------------------------------------------ native
let SS = null;
const ss = () => (SS ??= require('expo-secure-store'));
const makeNative = (ns) => {
  const IDX = `${ns.prefix}_idx`;
  const readIdx = async () => { try { return JSON.parse((await ss().getItemAsync(IDX)) ?? '[]'); } catch { return []; } };
  const writeIdx = (ids) => ss().setItemAsync(IDX, JSON.stringify(ids));
  const dropChunks = async (id) => {
    const n = Number(await ss().getItemAsync(`${ns.prefix}_${id}_n`)) || 0;
    for (let i = 0; i < n; i++) await ss().deleteItemAsync(`${ns.prefix}_${id}_${i}`);
    await ss().deleteItemAsync(`${ns.prefix}_${id}_n`);
  };
  const native = {
    async available() { try { await ss().getItemAsync(IDX); return true; } catch { return false; } },
    async readAll() {
      const out = [];
      for (const id of await readIdx()) {
        try {
          const n = Number(await ss().getItemAsync(`${ns.prefix}_${id}_n`)) || 0;
          let s = '';
          for (let i = 0; i < n; i++) s += (await ss().getItemAsync(`${ns.prefix}_${id}_${i}`)) ?? '';
          out.push(JSON.parse(s));
        } catch { await native.erase(id); }
      }
      return out;
    },
    async write(d) {
      const s = JSON.stringify(d);
      const before = Number(await ss().getItemAsync(`${ns.prefix}_${d.id}_n`)) || 0;
      const parts = []; for (let i = 0; i < s.length; i += CHUNK) parts.push(s.slice(i, i + CHUNK));
      for (let i = 0; i < parts.length; i++) await ss().setItemAsync(`${ns.prefix}_${d.id}_${i}`, parts[i]);
      await ss().setItemAsync(`${ns.prefix}_${d.id}_n`, String(parts.length));
      for (let i = parts.length; i < before; i++) await ss().deleteItemAsync(`${ns.prefix}_${d.id}_${i}`); // a shorter record leaves no stale tail
      const ids = await readIdx(); if (!ids.includes(d.id)) await writeIdx([...ids, d.id]);
    },
    async erase(id) { await dropChunks(id); await writeIdx((await readIdx()).filter((x) => x !== id)); },
    async eraseAll() { for (const id of await readIdx()) await dropChunks(id); await writeIdx([]); },
  };
  return native;
};

// ------------------------------------------------------------------------------------------------ one surface
const makeMem = () => {
  const memory = new Map();
  return {
    memory,
    async available() { return true; },
    async readAll() { return [...memory.values()]; },
    async write(d) { memory.set(d.id, d); },
    async erase(id) { memory.delete(id); },
    async eraseAll() { memory.clear(); },
  };
};

/** One encrypted store. `persistent` is false when the device offers no safe storage and records live in memory only. */
export function makeStore(ns) {
  const mem = makeMem();
  let impl = null, persistent = false;
  async function pick() {
    if (impl) return impl;
    const real = Platform.OS === 'web' ? makeWeb(ns) : makeNative(ns);
    try { persistent = await real.available(); } catch { persistent = false; }
    impl = persistent ? real : mem;
    return impl;
  }
  return {
    async readAll() { return (await (await pick()).readAll()); },
    async write(d) { if (!okId(d.id)) throw new Error('bad draft id'); await (await pick()).write(d); },
    async erase(id) { if (okId(id)) await (await pick()).erase(id); },
    async eraseAll() { await (await pick()).eraseAll(); mem.memory.clear(); },
    async isPersistent() { await pick(); return persistent; },
  };
}

// the player's offline drafts: the original names, so everything already saved on a device is still found
export const offlineStore = makeStore({ db: 'sa_offline', prefix: 'sa_off' });
// the referee's match-day pack (lineups and live state of the games they may score)
export const packStore = makeStore({ db: 'sa_scorer_pack', prefix: 'sa_pack' });
