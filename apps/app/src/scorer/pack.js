// The referee's match-day pack on the device: the games they may score, kept encrypted (packStore: IndexedDB + AES-GCM on the web, the
// platform keychain on iOS, iPadOS and Android), refreshed while online and removed at sign-out. It holds lineups, so it is never kept in
// plain storage and never survives the account that downloaded it. The server decides what goes in (get_scorer_pack): only games the
// signed-in person may score, with young people hidden exactly as in the lineup.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { packStore } from '../offline-store';
import { mergeLive } from './local';

const idOf = (fixtureId) => `g_${String(fixtureId).replace(/-/g, '')}`;

export async function listSaved(userId) {
  const all = await packStore.readAll().catch(() => []);
  const mine = [];
  for (const d of all) { if (d.owner === userId) mine.push(d); else await packStore.erase(d.id).catch(() => {}); }   // never keep another account's pack
  return mine;
}
export const loadSaved = async (userId, fixtureId) => (await listSaved(userId)).find((d) => d.id === idOf(fixtureId)) ?? null;
export const saveGame = (userId, game) => packStore.write({ id: idOf(game.fixture.id), owner: userId, saved_at: new Date().toISOString(), game });
export const forgetGame = (fixtureId) => packStore.erase(idOf(fixtureId));
/** Sign-out: nothing of a pack outlives the account (the games can be downloaded again). */
export const clearPack = () => packStore.eraseAll().catch(() => {});

/** Download every game the signed-in person may score in the window and keep it; games they no longer may score are removed. */
export async function downloadPack(userId, query = {}) {
  const r = await api.get('/me/scorer-pack', query);
  const keep = new Set(r.games.map((g) => idOf(g.fixture.id)));
  for (const d of await listSaved(userId)) if (!keep.has(d.id)) await packStore.erase(d.id);
  for (const g of r.games) await saveGame(userId, g);
  return r;
}

/**
 * One game for the Match Centre: the live feed's state when it is there, otherwise the saved copy. While online and the viewer may
 * score, the saved copy is kept current (merged from the feed, or downloaded again when the feed cannot join it).
 * @returns {{ saved: object|null, savedAt: string|null, ready: boolean }}
 */
export function useSavedGame(userId, fixtureId, live) {
  const [rec, setRec] = useState(null);
  const [ready, setReady] = useState(false);
  const recRef = useRef(null);
  const busy = useRef(false);
  recRef.current = rec;

  useEffect(() => {
    let on = true;
    if (!userId) { setReady(true); return undefined; }
    loadSaved(userId, fixtureId).then((d) => { if (on) { setRec(d); setReady(true); } }).catch(() => on && setReady(true));
    return () => { on = false; };
  }, [userId, fixtureId]);

  const canScore = !!live?.viewer?.can_score;
  const version = live?.version;
  const refetch = useCallback(async () => {
    if (busy.current || !userId) return;
    busy.current = true;
    try {
      const r = await api.get('/me/scorer-pack', { fixture_id: fixtureId });
      const g = r.games[0];
      if (g) { await saveGame(userId, g); setRec({ id: idOf(fixtureId), owner: userId, saved_at: new Date().toISOString(), game: g }); }
    } catch { /* offline: the copy already held stays */ } finally { busy.current = false; }
  }, [userId, fixtureId]);

  useEffect(() => {
    if (!ready || !userId || !live || !canScore) return;
    const cur = recRef.current?.game;
    const merged = cur ? mergeLive(cur, live) : null;
    if (!merged) { refetch(); return; }
    if (merged === cur) return;
    const next = { id: idOf(fixtureId), owner: userId, saved_at: new Date().toISOString(), game: merged };
    setRec(next);
    saveGame(userId, merged).catch(() => {});
  }, [ready, userId, version, canScore]); // eslint-disable-line react-hooks/exhaustive-deps

  return { saved: rec?.game ?? null, savedAt: rec?.saved_at ?? null, ready, refetch };
}
