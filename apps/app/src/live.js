// Live scoreboards: a Server-Sent Events stream where the platform supports it (browsers), otherwise short polling.
// Either way the screen just gets the latest state. A browser stream reconnects by itself and resumes from the last frame it saw
// (Last-Event-ID), polling covers the gap in between, and every frame carries a `version` so an older frame never overwrites a newer one.
// Officials on the web open the scorer stream instead, which also carries voided events and the scorer lease and closes (`revoked`)
// the moment their scoring authority ends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { API, api } from './api';

const POLL_MS = 4000;
const newer = (prev, next) => !(prev && prev.version != null && next.version != null && next.version < prev.version);

/**
 * One live record (a game or a session). `stream` and `poll` are the spectator stream path and the matching GET; `scorerStream` is the
 * officials' stream, used only on the web and only once the first read says the viewer may score.
 * @returns {{ state: object|null, mode: 'connecting'|'stream'|'polling', error: Error|null, revoked: boolean, push: (s: object) => void, refresh: () => Promise<void> }}
 */
function useLiveFeed({ id, stream, poll, scorerStream }) {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('connecting');
  const [error, setError] = useState(null);
  const [revoked, setRevoked] = useState(false);
  const alive = useRef(true);
  const canScore = !!state?.viewer?.can_score;

  const accept = useCallback((s, viewerFallback) => {
    setState((prev) => (newer(prev, s) ? { ...s, viewer: s.viewer ?? prev?.viewer ?? viewerFallback } : prev));
  }, []);

  const refresh = useCallback(async () => {
    try { const s = await api.get(poll); if (alive.current) { accept(s); setError(null); } }
    catch (e) { if (alive.current) setError(e); }
  }, [poll, accept]);

  const useScorer = Platform.OS === 'web' && typeof EventSource !== 'undefined' && !!scorerStream && canScore;

  useEffect(() => {
    alive.current = true;
    let es = null, timer = null;
    const tick = async () => { await refresh(); if (alive.current) timer = setTimeout(tick, POLL_MS); };
    const startPolling = () => { if (!alive.current || timer) return; setMode('polling'); tick(); };
    const stopPolling = () => { clearTimeout(timer); timer = null; };
    if (Platform.OS === 'web' && typeof EventSource !== 'undefined') {
      es = new EventSource(`${API}${useScorer ? scorerStream : stream}`, { withCredentials: true });
      es.addEventListener('state', (e) => {
        try { if (alive.current) { stopPolling(); accept(JSON.parse(e.data)); setMode('stream'); setError(null); } } catch { /* ignore a bad frame */ }
      });
      es.addEventListener('revoked', () => { if (alive.current) { setRevoked(true); es?.close(); es = null; refresh(); } });
      refresh();
      // the browser reconnects on its own and resumes from the last frame; poll while it does, and for good if the stream is refused
      es.onerror = () => { if (es?.readyState === 2) { es = null; startPolling(); } else startPolling(); };
    } else startPolling();
    return () => { alive.current = false; es?.close(); clearTimeout(timer); };
  }, [id, stream, scorerStream, useScorer, refresh, accept]);

  // actions return the fresh state; feed it in so the screen updates before the next frame arrives
  const push = useCallback((s) => { if (s && (s.fixture || s.session)) accept(s); }, [accept]);
  return { state, mode, error, revoked, push, refresh };
}

/** A game's live state (score, phase, rules, events) for everyone watching, plus void reasons and the scorer lease for officials. */
export const useLiveFixture = (id) => useLiveFeed({ id, stream: `/live/fixtures/${id}`, poll: `/fixtures/${id}/live`, scorerStream: `/live/fixtures/${id}/scorer` });

/** A heat, final or field flight: status, lanes, splits, attempts and provisional places. */
export const useLiveSession = (id) => useLiveFeed({ id, stream: `/live/sessions/${id}`, poll: `/sessions/${id}/live`, scorerStream: `/live/sessions/${id}/scorer` });

/** Poll one loader every few seconds while the screen is mounted (ticker lists, boards). */
export function usePoll(reload, ms = 6000) {
  useEffect(() => { const t = setInterval(reload, ms); return () => clearInterval(t); }, [reload, ms]);
}
