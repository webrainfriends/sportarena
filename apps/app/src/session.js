import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { api, setToken, setUnauthorizedHandler, storage } from './api';
import { c } from './theme';

const Ctx = createContext(null);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ ready: false, user: null });
  const [toastMsg, setToastMsg] = useState(null);
  const [activeRole, setActive] = useState(null); // which of the user's roles the app is currently showing (view mode)
  const setActiveRole = useCallback((r) => { setActive(r); storage.set('activeRole', r); }, []);

  const signOut = useCallback(async () => { setToken(null); await storage.del('token'); setState({ ready: true, user: null }); }, []);
  const signIn = useCallback(async ({ token, user }) => {
    setToken(token); await storage.set('token', token);
    // load the full (decrypted) /me so private fields are available straight away
    let me = user; try { me = await api.get('/me'); } catch {}
    setState({ ready: true, user: me });
  }, []);
  const refresh = useCallback(async () => { const me = await api.get('/me'); setState((s) => ({ ...s, user: me })); return me; }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    (async () => {
      const t = await storage.get('token');
      if (!t) return setState({ ready: true, user: null });
      setToken(t);
      try { setState({ ready: true, user: await api.get('/me') }); } catch { await signOut(); }
    })();
  }, [signOut]);

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
