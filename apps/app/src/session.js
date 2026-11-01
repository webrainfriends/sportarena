import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { Platform } from 'react-native';
import { api, setSessionTokens, setTokensHandler, setUnauthorizedHandler, storage } from './api';
import { c } from './theme';
import { clearOutbox } from './outbox';
import { beforeSignOut, initOffline } from './offline';
import { clearPack } from './scorer/pack';

const Ctx = createContext(null);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ ready: false, user: null });
  const [toastMsg, setToastMsg] = useState(null);
  const [activeRole, setActive] = useState(null); // which of the user's roles the app is currently showing (view mode)
  const setActiveRole = useCallback((r) => { setActive(r); storage.set('activeRole', r); }, []);

  const signOut = useCallback(async () => {
    await beforeSignOut().catch(() => {}); // upload the player's saved drafts, then keep or remove the rest as they chose (offline.js)
    clearOutbox(); // queued coaching writes belong to this account and must not outlive the session
    await clearPack(); // the match-day pack holds lineups: it goes with the account (the games can be saved again)
    try { await api.post('/auth/logout'); } catch { /* already signed out, or offline: still clear this device */ }
    setSessionTokens(null);
    await Promise.all([storage.del('token'), storage.del('refresh')]);
    setState({ ready: true, user: null });
  }, []);
  const signIn = useCallback(async (res) => {
    // Web: the server set HttpOnly cookies, so the response carries no secret and nothing is stored by the page.
    // Native: keep the tokens in the platform keychain (SecureStore).
    if (res.token) { setSessionTokens(res); await storage.set('token', res.token); if (res.refresh_token) await storage.set('refresh', res.refresh_token); }
    const user = res.user;
    // load the full (decrypted) /me so private fields are available straight away
    let me = user; try { me = await api.get('/me'); } catch {}
    setState({ ready: true, user: me });
  }, []);
  const refresh = useCallback(async () => { const me = await api.get('/me'); setState((s) => ({ ...s, user: me })); return me; }, []);

  useEffect(() => {
    // Local-only reset used when the server already says we're signed out (no logout round trip).
    setUnauthorizedHandler(async () => { clearOutbox(); setSessionTokens(null); await Promise.all([storage.del('token'), storage.del('refresh')]); setState({ ready: true, user: null }); });
    setTokensHandler(async (t) => { await storage.set('token', t.token); await storage.set('refresh', t.refresh_token); });
    (async () => {
      if (Platform.OS === 'web') {
        // Migration: earlier builds kept the bearer token in localStorage where any script could read it. Remove it; the
        // HttpOnly cookie session (if any) takes over, otherwise the person signs in once more.
        await storage.del('token'); await storage.del('refresh');
        try { setState({ ready: true, user: await api.get('/me') }); } catch { setState({ ready: true, user: null }); }
        return;
      }
      const [t, r] = await Promise.all([storage.get('token'), storage.get('refresh')]);
      if (!t) return setState({ ready: true, user: null });
      setSessionTokens({ token: t, refresh_token: r });
      try { setState({ ready: true, user: await api.get('/me') }); } catch { setState({ ready: true, user: null }); }
    })();
  }, []);

  const userId = state.user?.id ?? null;
  useEffect(() => { initOffline(userId).catch(() => {}); }, [userId]); // loads this person's saved drafts and removes anyone else's

  const toast = useCallback((msg) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), 2600); }, []);
  useEffect(() => {
    const roles = state.user?.roles;
    if (!roles?.length) return;
    if (activeRole && roles.includes(activeRole)) return;
    (async () => { const saved = await storage.get('activeRole'); setActive(saved && roles.includes(saved) ? saved : roles[0]); })();
  }, [state.user, activeRole]);

  // `has` follows the active role (admin always passes); `hasAny` checks every role the account holds.
  const value = useMemo(() => ({
    ...state, signIn, signOut, refresh, toast, activeRole, setActiveRole,
    has: (...r) => state.user?.roles?.includes('admin') || r.includes(activeRole),
    hasAny: (...r) => state.user?.roles?.some((x) => r.includes(x) || x === 'admin'),
  }), [state, signIn, signOut, refresh, toast, activeRole, setActiveRole]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 110, left: 0, right: 0, alignItems: 'center' }}>
          <View style={{ backgroundColor: c.violet, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18, maxWidth: '88%', borderLeftWidth: 4, borderLeftColor: c.lime }}><Text style={{ color: '#fff', fontWeight: '600' }}>{toastMsg}</Text></View>
        </View>
      ) : null}
    </Ctx.Provider>
  );
}
