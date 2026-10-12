import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
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

/** "Sign in with Google" (web). Until the server has a Google client id (GOOGLE_CLIENT_ID) it shows a disabled button that says so, so the option is always visible. */
export default function GoogleButton({ onCredential, onError }) {
  const [clientId, setClientId] = useState(null);
  const [off, setOff] = useState(false);
  const box = useRef(null);
  const cb = useRef({ onCredential, onError });
  cb.current = { onCredential, onError };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    api.get('/auth/config').then((r) => (r.google_client_id ? setClientId(r.google_client_id) : setOff(true)), () => setOff(true));
  }, []);
  useEffect(() => {
    if (!clientId || !box.current) return undefined;
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
  return <View ref={box} style={{ alignItems: 'center', minHeight: 44 }} />;
}
