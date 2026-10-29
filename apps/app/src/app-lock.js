// Optional device lock (issue #599): after the app has been in the background for a while it asks for Face ID / fingerprint / the
// device passcode before showing anything. It protects the session on a shared or lost phone; it does not replace signing in, and
// signing out is always available from the lock screen. Native only: the browser has no equivalent, so the setting is not offered
// there. The choice is kept in the platform keychain (SecureStore) and is per device.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { storage } from './api';
import { useSession } from './session';
import { Btn, T } from './ui';
import { c } from './theme';

let Local = null;
try { Local = require('expo-local-authentication'); } catch { Local = null; }

const KEY = 'appLock';
const AWAY_MS = 30000; // locked again once the app has been away this long
const Ctx = createContext({ supported: false, enabled: false, setEnabled: async () => false });
export const useAppLock = () => useContext(Ctx);

const prompt = (reason) => Local.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel', disableDeviceFallback: false });

export function AppLockProvider({ children }) {
  const { user, signOut } = useSession();
  const [supported, setSupported] = useState(false);
  const [enabled, setOn] = useState(false);
  const [locked, setLocked] = useState(false);
  const left = useRef(0);

  useEffect(() => {
    if (Platform.OS === 'web' || !Local) return;
    (async () => {
      const ok = (await Local.hasHardwareAsync()) && (await Local.isEnrolledAsync());
      setSupported(ok);
      const on = ok && (await storage.get(KEY)) === '1';
      setOn(on);
      if (on) setLocked(true); // cold start: ask before showing the person's data
    })().catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') left.current = left.current || Date.now();
      else if (s === 'active') { if (left.current && Date.now() - left.current > AWAY_MS) setLocked(true); left.current = 0; }
    });
    return () => sub.remove();
  }, [enabled]);

  const unlock = useCallback(async () => { try { const r = await prompt('Unlock Gotmygame'); if (r.success) setLocked(false); } catch { /* stay locked */ } }, []);
  useEffect(() => { if (locked && user) unlock(); }, [locked, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Turning it on needs one successful check, so a person cannot lock themselves out with a method that does not work. */
  const setEnabled = useCallback(async (on) => {
    if (!supported) return false;
    if (on) { const r = await prompt('Turn on the device lock'); if (!r.success) return false; }
    await storage.set(KEY, on ? '1' : '0'); setOn(on); setLocked(false);
    return true;
  }, [supported]);

  const value = useMemo(() => ({ supported, enabled, setEnabled }), [supported, enabled, setEnabled]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {enabled && locked && user ? (
        <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 }}>
          <T size={44}>🔒</T>
          <T size={22} weight="800" accessibilityRole="header">Gotmygame is locked</T>
          <T color={c.mute} style={{ textAlign: 'center' }}>Unlock with Face ID, your fingerprint or your device passcode.</T>
          <Btn title="Unlock" onPress={unlock} />
          <Btn small title="Sign out instead" color={c.paper} ink={c.ink} onPress={async () => { setLocked(false); await signOut(); }} />
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

/** Settings row for Account security. */
export function DeviceLockRow() {
  const { supported, enabled, setEnabled } = useAppLock();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const toggle = async () => { setBusy(true); setMsg(null); try { if (!(await setEnabled(!enabled))) setMsg('That did not work, so nothing was changed.'); } finally { setBusy(false); } };
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1 }}>
        <T weight="800">Device lock {enabled ? 'is on' : 'is off'}</T>
        <T size={12} color={c.mute}>{Platform.OS === 'web' ? 'Available in the iPhone, iPad and Android apps.' : supported ? 'Ask for Face ID, fingerprint or your passcode when you come back to the app.' : 'Set up Face ID, a fingerprint or a passcode in your device settings to use this.'}</T>
        {msg ? <T size={12} color={c.red} accessibilityRole="alert">{msg}</T> : null}
      </View>
      {supported ? <Btn small title={enabled ? 'Turn off' : 'Turn on'} color={enabled ? c.paper : c.pink} ink={enabled ? c.red : '#fff'} loading={busy} onPress={toggle} /> : null}
    </View>
  );
}
