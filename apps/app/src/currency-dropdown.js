// One currency control for the whole app: a searchable dropdown that starts on the currency of the person's region and can be changed.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Field, T } from './ui';
import { c } from './theme';
import { locale } from './locale';

const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const REGION_CURRENCY = {
  ...Object.fromEntries(EURO.map((r) => [r, 'EUR'])),
  IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', SA: 'SAR', QA: 'QAR', SG: 'SGD', MY: 'MYR', TH: 'THB', ID: 'IDR', PH: 'PHP', VN: 'VND', JP: 'JPY', KR: 'KRW', CN: 'CNY',
  HK: 'HKD', TW: 'TWD', AU: 'AUD', NZ: 'NZD', CA: 'CAD', CH: 'CHF', LI: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', TR: 'TRY', IL: 'ILS',
  ZA: 'ZAR', NG: 'NGN', KE: 'KES', EG: 'EGP', BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR',
};
/** The currency people in this locale's region use, or null when it is not one we support (then the person picks). */
export const localeCurrency = (tag = locale) => { try { return REGION_CURRENCY[new Intl.Locale(tag).region] ?? null; } catch { return null; } };

/**
 * @param {{ label?: string, value?: string, onChange: (code: string) => void, hint?: string, suggest?: boolean, disabled?: boolean }} p
 * `suggest`: while no value is set, choose the currency of the person's region (they can change it).
 */
export function CurrencyDropdown({ label = 'Currency', value, onChange, hint, suggest = true, disabled }) {
  const cur = useLoad(() => api.get('/currencies'), []);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const mine = localeCurrency();
  const list = cur.data ?? [];
  useEffect(() => { if (suggest && !value && mine && (!cur.data || cur.data.some((x) => x.code === mine))) onChange(mine); }, [suggest, value, mine, cur.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((x) => !t || `${x.code} ${x.name} ${x.symbol}`.toLowerCase().includes(t)).sort((a, b) => (b.code === mine) - (a.code === mine) || a.name.localeCompare(b.name));
  }, [list, q, mine]);
  const now = list.find((x) => x.code === value);
  return (
    <View style={{ gap: 6 }}>
      <T weight="800" size={13}>{label}</T>
      <Pressable disabled={disabled} onPress={() => { setOpen(!open); setQ(''); }} accessibilityRole="button" accessibilityLabel={`${label}: ${now ? `${now.code}, ${now.name}` : value ?? 'none chosen'}. ${open ? 'Close' : 'Change'}`} accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: open ? c.ink : c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 14, minHeight: 50, opacity: disabled ? 0.55 : 1 }}>
        <T weight="800" style={{ minWidth: 44 }}>{value ?? 'Choose'}</T>
        <T size={13} color={c.mute} style={{ flex: 1 }} numberOfLines={1}>{now ? `${now.name} · ${now.symbol}` : cur.loading ? 'Loading…' : 'Choose a currency'}</T>
        <T size={12} color={c.mute}>{open ? '▲' : '▼'}</T>
      </Pressable>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, padding: 8, gap: 8 }}>
          <Field value={q} onChangeText={setQ} placeholder="Search by code, name or symbol" accessibilityLabel="Search currencies" />
          <ScrollView style={{ maxHeight: 250 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {shown.length ? shown.map((x) => (
              <Pressable key={x.code} onPress={() => { onChange(x.code); setOpen(false); }} accessibilityRole="button" accessibilityLabel={`${x.code}, ${x.name}`} accessibilityState={{ selected: x.code === value }}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8, backgroundColor: x.code === value ? c.violetSoft : pressed ? c.bg : 'transparent' })}>
                <T weight="800" size={14} style={{ width: 44 }}>{x.code}</T>
                <View style={{ flex: 1 }}>
                  <T size={13} numberOfLines={1}>{x.name}</T>
                  {x.code === mine ? <T size={11} color={c.pink} weight="700">Your region</T> : null}
                </View>
                <T size={13} color={c.mute}>{x.symbol}</T>
                <T size={14} color={c.pink} weight="800" style={{ width: 16 }}>{x.code === value ? '✓' : ''}</T>
              </Pressable>
            )) : <T size={13} color={c.mute} style={{ padding: 10 }}>{cur.error ? 'Currencies could not be loaded. Try again in a moment.' : 'No currency matches that search.'}</T>}
          </ScrollView>
        </View>
      ) : null}
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}
