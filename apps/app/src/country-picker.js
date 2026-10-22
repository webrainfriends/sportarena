import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
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

/** Pick a country by searching its name; the value is the two-letter ISO code. One value. */
export function CountryPicker({ label, value, onChange, optional, hint }) {
  const [q, setQ] = useState('');
  const all = useMemo(regionList, []);
  const typed = q.trim().toLowerCase();
  const found = typed ? all.filter((x) => x.name.toLowerCase().includes(typed) || x.code.toLowerCase() === typed).slice(0, 8) : [];
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T>
      {value ? <View style={{ flexDirection: 'row', gap: 6 }}><Chip label={`🌍 ${countryName(value)} (${value})  ✕`} active onPress={() => onChange('')} /></View> : null}
      <Field value={q} onChangeText={(x) => setQ(all.length ? x : x.toUpperCase().slice(0, 2))} placeholder={all.length ? 'Search a country' : 'Two-letter country code'} maxLength={all.length ? undefined : 2} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {all.length ? found.filter((x) => x.code !== value).map((x) => <Chip key={x.code} label={x.name} onPress={() => { onChange(x.code); setQ(''); }} />)
          : /^[A-Z]{2}$/.test(q) ? <Chip label={`Use ${q}`} onPress={() => { onChange(q); setQ(''); }} /> : null}
      </View>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}
