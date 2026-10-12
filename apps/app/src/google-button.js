import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from './api';

const SRC = 'https://accounts.google.com/gsi/client';
let loading;
const loadScript = () => (loading ??= new Promise((ok, fail) => {
  if (window.google?.accounts?.id) return ok();
  const el = document.createElement('script');
  el.src = SRC; el.async = true; el.onload = () => ok(); el.onerror = () => { loading = null; fail(new Error('Could not load Google sign-in')); };
  document.head.appendChild(el);
}));

/** "Sign in with Google" (web). Renders nothing until the server reports a Google client id, so it is hidden where Google sign-in is not set up. */
export default function GoogleButton({ onCredential, onError }) {
  const [clientId, setClientId] = useState(null);
  const box = useRef(null);
  const cb = useRef({ onCredential, onError });
  cb.current = { onCredential, onError };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    api.get('/auth/config').then((r) => setClientId(r.google_client_id), () => {});
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
  if (!clientId) return null;
  return <View ref={box} style={{ alignItems: 'center', minHeight: 44 }} />;
}
