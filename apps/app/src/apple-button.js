import React, { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, API } from './api';
import { T } from './ui';
import { c } from './theme';

/**
 * "Continue with Apple". On web it sends the browser through the server's Apple redirect flow; until the server has an Apple Services ID
 * (APPLE_CLIENT_ID) it shows a disabled button that says so. In the installed iOS app it opens the native Apple sheet and hands the identity
 * token to `onCredential({ credential, name, nonce })` (the App ID is already an accepted audience on the server, so nothing else to set up).
 */
export default function AppleButton({ onCredential, onError }) {
  const native = Platform.OS === 'ios';
  const [state, setState] = useState(null); // null = loading, 'on' | 'off'
  useEffect(() => {
    if (native) {
      const AppleAuth = require('expo-apple-authentication');
      AppleAuth.isAvailableAsync().then((ok) => setState(ok ? 'on' : 'off'), () => setState('off'));
    } else if (Platform.OS === 'web') {
      api.get('/auth/config').then((r) => setState(r.apple_client_id ? 'on' : 'off'), () => setState('off'));
    }
  }, [native]);

  const signInNative = async () => {
    const AppleAuth = require('expo-apple-authentication');
    const Crypto = require('expo-crypto');
    try {
      const nonce = Crypto.randomUUID();
      const r = await AppleAuth.signInAsync({ nonce, requestedScopes: [AppleAuth.AppleAuthenticationScope.FULL_NAME, AppleAuth.AppleAuthenticationScope.EMAIL] });
      // Apple only gives the name on the very first sign-in.
      const name = [r.fullName?.givenName, r.fullName?.familyName].filter(Boolean).join(' ') || undefined;
      await onCredential?.({ credential: r.identityToken, name, nonce });
    } catch (e) {
      if (e?.code !== 'ERR_REQUEST_CANCELED') onError?.('Apple sign-in did not complete. Please try again.');
    }
  };

  if ((!native && Platform.OS !== 'web') || !state) return null;
  const on = state === 'on';
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      <Pressable
        accessibilityRole="button" accessibilityState={{ disabled: !on }} disabled={!on}
        onPress={native ? signInNative : () => { window.location.href = `${API}/auth/apple/start`; }}
        style={{ width: 300, maxWidth: '100%', height: 44, borderRadius: 999, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', opacity: on ? 1 : 0.5 }}>
        <T weight="700" size={14} color="#fff">{''} Continue with Apple</T>
      </Pressable>
      {on ? null : <T size={11} color={c.mute}>Apple sign-in is not switched on for this site yet.</T>}
    </View>
  );
}
