import React, { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, API } from './api';
import { T } from './ui';
import { c } from './theme';

/** "Continue with Apple" (web). Sends the browser through the server's Apple redirect flow; until the server has an Apple Services ID (APPLE_CLIENT_ID) it shows a disabled button that says so. */
export default function AppleButton() {
  const [state, setState] = useState(null); // null = loading, 'on' | 'off'
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    api.get('/auth/config').then((r) => setState(r.apple_client_id ? 'on' : 'off'), () => setState('off'));
  }, []);
  if (Platform.OS !== 'web' || !state) return null;
  const on = state === 'on';
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      <Pressable
        accessibilityRole="button" accessibilityState={{ disabled: !on }} disabled={!on}
        onPress={() => { window.location.href = `${API}/auth/apple/start`; }}
        style={{ width: 300, maxWidth: '100%', height: 44, borderRadius: 999, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', opacity: on ? 1 : 0.5 }}>
        <T weight="700" size={14} color="#fff">{''} Continue with Apple</T>
      </Pressable>
      {on ? null : <T size={11} color={c.mute}>Apple sign-in is not switched on for this site yet.</T>}
    </View>
  );
}
