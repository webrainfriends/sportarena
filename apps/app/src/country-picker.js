import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Chip, Field, T } from './ui';
import { c } from './theme';

/** Every ISO 3166 region the device can name, as { code, name }. Empty when the runtime has no Intl.DisplayNames (then a code is typed). */
export function regionList() {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const out = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { const code = String.fromCharCode(a, b); const name = dn.of(code); if (name && name !== code && !/Unknown Region/i.test(name)) out.push({ code, name }); }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  } catch { return []; }
}
export const countryName = (code) => { try { return code ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code) : ''; } catch { return code ?? ''; } };

/** A country dropdown (combo box): the field opens a short list right under it, with a filter box on top. Typing narrows the list to the matching countries. Value: two-letter ISO code. */
export function CountryPicker({ label, value, onChange, optional, hint }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const all = useMemo(regionList, []);
  const typed = q.trim().toLowerCase();
  const list = typed ? all.filter((x) => x.name.toLowerCase().includes(typed) || x.code.toLowerCase() === typed) : all;
  const pick = (code) => { onChange(code); setOpen(false); setQ(''); };
  return (
    <View style={{ gap: 6 }}>
      <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T>
      <Pressable onPress={() => { setQ(''); setOpen((o) => !o); }} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${label}. ${value ? countryName(value) : 'Choose a country'}`}
        style={{ borderWidth: 1.5, borderColor: open ? c.ink : c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={{ flex: 1 }} color={value ? c.ink : c.mute} weight="600">{value ? `🌍 ${countryName(value)} (${value})` : 'Choose a country'}</T><T size={16} color={c.mute}>{open ? '▴' : '▾'}</T>
      </Pressable>
      {open ? (
        <View style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, overflow: 'hidden' }}>
          <View style={{ padding: 8, borderBottomWidth: 1, borderColor: c.line }}>
            <Field value={q} onChangeText={(x) => setQ(all.length ? x : x.toUpperCase().slice(0, 2))} placeholder={all.length ? 'Type to filter the list' : 'Two-letter country code'} maxLength={all.length ? undefined : 2} accessibilityLabel={`Filter ${label}`} />
          </View>
          {all.length ? (
            <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {optional && value ? <Pressable onPress={() => pick('')} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 }}><T weight="700" color={c.red}>Clear selection</T></Pressable> : null}
              {list.map((x) => (
                <Pressable key={x.code} onPress={() => pick(x.code)} accessibilityRole="button" accessibilityState={{ selected: x.code === value }} accessibilityLabel={x.name}
                  style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: x.code === value || pressed ? c.violetSoft : 'transparent' })}>
                  <T style={{ flex: 1 }} weight={x.code === value ? '800' : '500'}>{x.name}</T><T size={12} color={c.mute}>{x.code}</T>{x.code === value ? <T color={c.violet}>✓</T> : null}
                </Pressable>))}
              {!list.length ? <View style={{ padding: 14 }}><T color={c.mute} size={13}>No country matches “{q.trim()}”.</T></View> : null}
            </ScrollView>
          ) : /^[A-Z]{2}$/.test(q) ? <View style={{ padding: 10 }}><Chip label={`Use ${q}`} onPress={() => pick(q)} /></View> : null}
        </View>
      ) : null}
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

/** Several countries: the chosen ones as removable chips, and a search to add more. The value is a list of two-letter ISO codes. */
export function CountriesMulti({ label, value = [], onChange, optional, hint }) {
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T>
      {value.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((code) => <Chip key={code} label={`🌍 ${countryName(code)}  ✕`} active onPress={() => onChange(value.filter((x) => x !== code))} />)}</View> : null}
      <CountryPicker label="Add a country" value="" onChange={(code) => { if (code && !value.includes(code)) onChange([...value, code]); }} optional hint={hint} />
    </View>
  );
}
