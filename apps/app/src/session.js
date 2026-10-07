import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { api, setToken, setUnauthorizedHandler, storage } from './api';
import { c } from './theme';

const Ctx = createContext(null);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ ready: false, user: null });
  const [toastMsg, setToastMsg] = useState(null);

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
  const value = useMemo(() => ({ ...state, signIn, signOut, refresh, toast, has: (...r) => state.user?.roles?.some((x) => r.includes(x) || x === 'admin') }), [state, signIn, signOut, refresh, toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg ? (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 110, left: 0, right: 0, alignItems: 'center' }}>
          <View style={{ backgroundColor: c.ink, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 20, maxWidth: '88%' }}><Text style={{ color: '#fff', fontWeight: '800' }}>{toastMsg}</Text></View>
        </View>
      ) : null}
    </Ctx.Provider>
  );
}
