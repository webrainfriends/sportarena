import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api } from './api';
import { T } from './ui';
import { c } from './theme';

const SRC = 'https://accounts.google.com/gsi/client';
let loading;
const loadScript = () => (loading ??= new Promise((ok, fail) => {
  if (window.google?.accounts?.id) return ok();
  const el = document.createElement('script');
  el.src = SRC; el.async = true; el.onload = () => ok(); el.onerror = () => { loading = null; fail(new Error('Could not load Google sign-in')); };
  document.head.appendChild(el);
}));

/** "Sign in with Google" (web: Google's button; iOS/Android app: the system browser sheet with PKCE, using the iOS OAuth client id from /auth/config). Until the server has a Google client id (GOOGLE_CLIENT_ID) it shows a disabled button that says so, so the option is always visible. */
export default function GoogleButton({ onCredential, onError }) {
  const [clientId, setClientId] = useState(null);
  const [off, setOff] = useState(false);
  const box = useRef(null);
  const cb = useRef({ onCredential, onError });
  cb.current = { onCredential, onError };
  const native = Platform.OS === 'ios';
  useEffect(() => {
    if (Platform.OS !== 'web' && !native) return;
    api.get('/auth/config').then((r) => {
      const id = native ? r.google_ios_client_id : r.google_client_id;
      return id ? setClientId(id) : setOff(true);
    }, () => setOff(true));
  }, [native]);
  const signInNative = async () => {
    const AuthSession = require('expo-auth-session');
    const WebBrowser = require('expo-web-browser');
    WebBrowser.maybeCompleteAuthSession();
    try {
      const redirectUri = `com.googleusercontent.apps.${clientId.replace('.apps.googleusercontent.com', '')}:/oauthredirect`;
      const discovery = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' };
      const req = new AuthSession.AuthRequest({ clientId, redirectUri, scopes: ['openid', 'profile', 'email'], responseType: AuthSession.ResponseType.Code, usePKCE: true });
      const res = await req.promptAsync(discovery);
      if (res.type !== 'success') return;
      const tok = await AuthSession.exchangeCodeAsync({ clientId, code: res.params.code, redirectUri, extraParams: { code_verifier: req.codeVerifier } }, discovery);
      await cb.current.onCredential(tok.idToken);
    } catch { cb.current.onError?.('Google sign-in did not complete. Please try again.'); }
  };
  useEffect(() => {
    if (native || !clientId || !box.current) return undefined;
    let gone = false;
    loadScript().then(() => {
      if (gone || !box.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => cb.current.onCredential(r.credential) });
      window.google.accounts.id.renderButton(box.current, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
    }).catch((e) => cb.current.onError?.(e.message));
    return () => { gone = true; };
  }, [clientId]);
  if (!clientId) {
    if (!off) return null;
    return (
      <View accessibilityRole="button" accessibilityState={{ disabled: true }} style={{ alignItems: 'center', gap: 4 }}>
        <View style={{ width: 300, maxWidth: '100%', height: 44, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', opacity: 0.7 }}>
          <T weight="700" size={14} color={c.mute}>Continue with Google</T>
        </View>
        <T size={11} color={c.mute}>Google sign-in is not switched on for this site yet.</T>
      </View>
    );
  }
  if (native) {
    return (
      <Pressable accessibilityRole="button" onPress={signInNative} style={{ alignSelf: 'center', width: 300, maxWidth: '100%', height: 44, borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
        <T weight="700" size={14}>Continue with Google</T>
      </Pressable>
    );
  }
  return <View ref={box} style={{ alignItems: 'center', minHeight: 44 }} />;
}
