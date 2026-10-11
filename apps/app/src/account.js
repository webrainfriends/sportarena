import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSession } from './session';
import { Btn, Chip, Field, Sheet, T } from './ui';
import { Icon } from './icons';
import { c, themeMode, scheme, THEME_KEY } from './theme';
import { LOCALE_KEY, LOCALES, deviceZone, followsDevice, locale, localeLabel, asLocale, fmtDateTime } from './locale';
import { storage } from './storage';

// Theme and language are read when the app loads (screens bake the tokens in), so a change is stored and the app restarts.
async function restart() {
  if (Platform.OS === 'web') return window.location.reload();
  try { await (await import('expo')).reloadAppAsync(); } catch { /* the choice applies on next launch */ }
}
const remember = async (key, value) => (value ? storage.set(key, value) : storage.del(key));

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

/** Appearance, language & region, and Log out — reachable from every screen via AccountButton. */
export function AccountSheet({ visible, onClose }) {
  const { user, signOut } = useSession();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const pickTheme = async (m) => { if (m === themeMode) return; await remember(THEME_KEY, m === 'system' ? null : m); restart(); };
  const pickLocale = async (tag) => { if (tag === locale && !followsDevice) return; await remember(LOCALE_KEY, tag); restart(); };
  const list = LOCALES.filter((t) => `${localeLabel(t)} ${t}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 40);
  const typed = asLocale(q);
  return (
    <Sheet visible={visible} onClose={onClose} title={user ? `@${user.handle}` : 'Account'}>
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>APPEARANCE</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {THEMES.map(([m, label]) => <Chip key={m} label={label} active={themeMode === m} onPress={() => pickTheme(m)} />)}
        </View>
        <T size={12} color={c.mute}>{themeMode === 'system' ? `Following your device — currently ${scheme}.` : `Always ${scheme}.`}</T>
      </View>
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>LANGUAGE & REGION</T>
        <Pressable onPress={() => setOpen(!open)} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, padding: 14 }}>
          <T weight="600">{localeLabel(locale)}</T>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>{followsDevice ? 'From your device' : 'Your choice'} · {deviceZone} · {fmtDateTime(new Date())}</T>
        </Pressable>
        {open ? (
          <View style={{ gap: 8 }}>
            <Field value={q} onChangeText={setQ} placeholder="Search language or country, e.g. Singapore or en-SG" />
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {typed && !list.includes(typed) ? <Chip key={typed} label={localeLabel(typed)} active={typed === locale && !followsDevice} onPress={() => pickLocale(typed)} /> : null}
              {list.map((t) => <Chip key={t} label={localeLabel(t)} active={t === locale && !followsDevice} onPress={() => pickLocale(t)} />)}
            </View>
            {!list.length && !typed ? <T size={12} color={c.mute}>Nothing matches. Try a country or language name, or a tag like en-SG.</T> : null}
            {!followsDevice ? <Btn small title="Use my device's settings" color={c.paper} ink={c.ink} onPress={() => pickLocale(null)} style={{ alignSelf: 'flex-start' }} /> : null}
          </View>
        ) : null}
        <T size={12} color={c.mute}>Dates, times, numbers and currency follow this and your time zone. Screen text is English for now.</T>
      </View>
      <Btn title="Log out" color={c.ink} onPress={() => { onClose(); signOut(); }} />
    </Sheet>
  );
}

/** Round account button for the top of every signed-in screen. */
export function AccountButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Account, appearance and log out" hitSlop={8}
        style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, opacity: pressed ? 0.6 : 1 })}>
        <Icon name="Me" color={c.ink} size={20} />
      </Pressable>
      <AccountSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
