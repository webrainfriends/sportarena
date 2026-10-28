// The role-driven workspace the whole shell reads (issue #599): one load of GET /me/workspace for the active role, shared by Home, Work and the
// tab badges. The app owns no business logic here: the API decides the queue, the fast actions and where each one opens.
// Poor connectivity: the last good answer stays on screen (marked as offline) and one-tap answers go through the retry outbox
// (outbox.js: in memory only, emptied on sign-out, every write carries a client_key), so a dropped connection never loses a tap
// and a retry never double-applies. When the queue empties the workspace is read again, so what the server decided wins.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api } from './api';
import { useSession } from './session';
import { useNav } from './nav';
import { send, useOutbox } from './outbox';
import { isEditableRole } from './roles';

const Ctx = createContext(null);
export const useWorkspace = () => useContext(Ctx);
const key = () => `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const REFRESH_MS = 90000;

/** Open a workspace target: a tab (with an optional section) or a screen. */
export function useGo() {
  const { push, goTab } = useNav();
  return useCallback((t) => { if (!t) return; if (t.tab) goTab(t.tab, t.section ? { section: t.section } : {}); else if (t.screen) push(t.screen, t.params ?? {}); }, [push, goTab]);
}

export function WorkspaceProvider({ children }) {
  const { user, activeRole, toast } = useSession();
  const [st, setSt] = useState({ data: null, error: null, loading: true, offlineSince: null });
  const [waiting, setWaiting] = useState({}); // path -> true: answered but not yet sent
  const alive = useRef(true);
  const seq = useRef(0);
  const role = user && activeRole && isEditableRole(activeRole) && user.roles?.includes(activeRole) ? activeRole : undefined;

  const load = useCallback(async () => {
    if (!user) return;
    const n = ++seq.current;
    try {
      const data = await api.get('/me/workspace', role ? { role } : {});
      if (alive.current && n === seq.current) setSt({ data, error: null, loading: false, offlineSince: null });
    } catch (error) {
      // keep the last good answer; a refusal (4xx) is a real error, no connection (status 0) or a server fault is "offline"
      if (alive.current && n === seq.current) setSt((s) => ({ data: s.data, error, loading: false, offlineSince: !error?.status || error.status >= 500 ? (s.offlineSince ?? new Date()) : null }));
    }
  }, [user?.id, role]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSt({ data: null, error: null, loading: !!user, offlineSince: null }); setWaiting({}); load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return undefined;
    const t = setInterval(load, REFRESH_MS);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [user?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const { pending, rejected } = useOutbox();
  const wasPending = useRef(0);
  useEffect(() => { if (wasPending.current && !pending) { setWaiting({}); load(); } wasPending.current = pending; }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (rejected) toast(rejected); }, [rejected]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One-tap answer on a queue item. Resolves 'saved' | 'queued'; a refusal is shown and the queue is read again. */
  const answer = useCallback(async (q) => {
    try {
      const r = await send(q.path, { ...q.body, client_key: key() }, (q.method ?? 'POST').toLowerCase());
      if (r.status === 'queued') { setWaiting((w) => ({ ...w, [q.path]: true })); setSt((x) => ({ ...x, offlineSince: x.offlineSince ?? new Date() })); toast('Saved. It will be sent as soon as you are back online.'); } else { toast('Done ✓'); load(); }
      return r.status;
    } catch (e) { toast(e.message); load(); return 'refused'; }
  }, [load, toast]);

  const value = useMemo(() => ({ ...st, role, reload: load, answer, waiting, queued: pending }), [st, role, load, answer, waiting, pending]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
