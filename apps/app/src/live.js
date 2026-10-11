// Live scoreboards: a Server-Sent Events stream where the platform supports it (browsers), otherwise short polling.
// Either way the screen just gets the latest state; polling also covers a stream that drops.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { API, api } from './api';

const POLL_MS = 4000;

/** @returns {{ state: object|null, mode: 'connecting'|'stream'|'polling', error: Error|null, push: (s: object) => void, refresh: () => Promise<void> }} */
export function useLiveFixture(id) {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('connecting');
  const [error, setError] = useState(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try { const s = await api.get(`/fixtures/${id}/live`); if (alive.current) { setState(s); setError(null); } }
    catch (e) { if (alive.current) setError(e); }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    let es = null, timer = null;
    const poll = async () => { await refresh(); if (alive.current) timer = setTimeout(poll, POLL_MS); };
    const startPolling = () => { if (!alive.current) return; setMode('polling'); poll(); };
    if (Platform.OS === 'web' && typeof EventSource !== 'undefined') {
      es = new EventSource(`${API}/live/fixtures/${id}`);
      // stream frames carry the game but not who is looking; keep the viewer flags the first read brought in
      es.addEventListener('state', (e) => { try { if (alive.current) { const f = JSON.parse(e.data); setState((prev) => ({ ...f, viewer: f.viewer ?? prev?.viewer })); setMode('stream'); setError(null); } } catch { /* ignore a bad frame */ } });
      refresh();
      es.onerror = () => { es.close(); es = null; startPolling(); };
    } else startPolling();
    return () => { alive.current = false; es?.close(); clearTimeout(timer); };
  }, [id, refresh]);

  // actions return the fresh state; feed it in so the screen updates before the next frame arrives
  const push = useCallback((s) => { if (s?.fixture) setState((prev) => ({ ...s, viewer: s.viewer ?? prev?.viewer })); }, []);
  return { state, mode, error, push, refresh };
}

/** Poll one loader every few seconds while the screen is mounted (ticker lists, boards). */
export function usePoll(reload, ms = 6000) {
  useEffect(() => { const t = setInterval(reload, ms); return () => clearInterval(t); }, [reload, ms]);
}
