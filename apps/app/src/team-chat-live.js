// Live team chat for one team, the same on the web, iOS, iPadOS and Android.
//  * Web: a Server-Sent Events stream (resumes by itself with Last-Event-ID after a drop).
//  * Phones / tablets (React Native has no EventSource): a long poll - the server holds `list_team_messages` open until something arrives.
// Either way the server is the only source of truth: messages are kept by message_id (a repeat changes nothing), the cursor is the highest
// seq seen, and a reconnect re-reads the latest page so a reaction or removal missed while offline is picked up. Memory is bounded.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { API, api } from './api';

const PAGE = 50;
const KEEP = 300;   // messages held in memory; older ones are fetched again on "Earlier messages"
const bySeq = (a, b) => a.seq - b.seq;

export function useTeamChat(teamId) {
  const [msgs, setMsgs] = useState(null);       // oldest -> newest
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [link, setLink] = useState('connecting');   // connecting | live | reconnecting | revoked
  const cursor = useRef(0);
  const alive = useRef(true);
  const [attempt, setAttempt] = useState(0);

  const merge = useCallback((incoming, removed = []) => {
    setMsgs((cur) => {
      const byId = new Map((cur ?? []).map((m) => [m.message_id, m]));
      for (const id of removed) byId.delete(id);
      for (const m of incoming) byId.set(m.message_id, m);
      let all = [...byId.values()].sort(bySeq);
      if (all.length > KEEP) all = all.slice(all.length - KEEP);
      cursor.current = all.length ? Math.max(cursor.current, all[all.length - 1].seq) : cursor.current;
      return all;
    });
  }, []);

  const latest = useCallback(async () => {
    const page = await api.get(`/teams/${teamId}/messages`, { limit: PAGE });
    if (!alive.current) return;
    merge(page);
    return page;
  }, [teamId, merge]);

  useEffect(() => {
    alive.current = true;
    let es = null, stopped = false, timer = null, polling = false;
    const revoked = () => { stopped = true; setLink('revoked'); es?.close(); };

    const poll = async () => {
      if (polling) return;
      polling = true;
      let wait = 1000;
      while (!stopped && alive.current) {
        if (AppState.currentState !== 'active') { await new Promise((r) => { timer = setTimeout(r, 1500); }); continue; }
        try {
          const rows = await api.get(`/teams/${teamId}/messages`, { after_seq: cursor.current, wait_seconds: 20, limit: 100 });
          if (stopped) break;
          setLink('live'); wait = 1000;
          if (rows.length) merge(rows);
        } catch (e) {
          if (e.status === 403 || e.status === 404) return revoked();
          setLink('reconnecting');
          await new Promise((r) => { timer = setTimeout(r, wait); });
          wait = Math.min(wait * 2, 15000);
          try { await latest(); } catch { /* next loop */ }
        }
      }
      polling = false;
    };

    const stream = () => {
      es = new EventSource(`${API}/teams/${teamId}/messages/stream?cursor=${cursor.current}`, { withCredentials: true });
      es.addEventListener('ready', () => setLink('live'));
      es.addEventListener('messages', (e) => { try { const d = JSON.parse(e.data); merge(d.messages ?? [], d.removed ?? []); } catch { /* ignore a bad frame */ } });
      es.addEventListener('revoked', revoked);
      es.onerror = () => {
        if (stopped) return;
        setLink('reconnecting');
        latest().catch(() => {});   // catch up on anything (a reaction, a removal) that happened while the stream was down
        // a stream that keeps failing (an old proxy, a blocked connection) falls back to the long poll
        if (es.readyState === 2) { es.close(); poll(); }
      };
    };

    (async () => {
      try {
        const first = await latest();
        if (!alive.current) return;
        setMore((first?.length ?? 0) === PAGE);
        api.post(`/teams/${teamId}/messages/read`).catch(() => {});
        if (Platform.OS === 'web' && typeof EventSource !== 'undefined') stream(); else poll();
      } catch (e) { if (alive.current) setError(e); }
    })();

    const sub = AppState.addEventListener?.('change', (s) => { if (s === 'active' && !stopped) latest().catch(() => {}); });
    return () => { alive.current = false; stopped = true; clearTimeout(timer); es?.close(); sub?.remove?.(); };
  }, [teamId, merge, latest, attempt]);

  const loadOlder = useCallback(async (channel) => {
    const oldest = msgs?.[0];
    if (!oldest) return;
    const page = await api.get(`/teams/${teamId}/messages`, { before_seq: oldest.seq, limit: PAGE, channel });
    merge(page);
    setMore(page.length === PAGE);
  }, [teamId, msgs, merge]);

  const markRead = useCallback(() => api.post(`/teams/${teamId}/messages/read`).catch(() => {}), [teamId]);
  return { msgs, more, error, link, merge, loadOlder, markRead, retry: () => { setError(null); setMsgs(null); setAttempt((n) => n + 1); } };
}
