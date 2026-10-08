// Pick a sport: quick picks for the common ones, search for the rest. The value is the sport's slug.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { Chip, Field, T } from './ui';
import { c } from './theme';

const POPULAR = ['badminton', 'tennis', 'football', 'cricket', 'basketball', 'table-tennis', 'squash', 'swimming', 'volleyball', 'hockey', 'pickleball', 'padel'];
let cache = null;
export const useSports = () => useLoad(() => (cache ??= api.get('/sports')), []);

export function SportPicker({ label, value, onChange, optional }) {
  const sports = useSports();
  const [q, setQ] = useState('');
  const all = sports.data ?? [];
  const picked = all.find((s) => s.slug === value);
  const term = q.trim().toLowerCase();
  const shown = term ? all.filter((s) => s.name.toLowerCase().includes(term)).slice(0, 16) : POPULAR.map((slug) => all.find((s) => s.slug === slug)).filter(Boolean);
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T> : null}
      {picked ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Chip label={`${picked.emoji} ${picked.name}  ✕`} active onPress={() => onChange('')} /></View> : null}
      <Field value={q} onChangeText={setQ} placeholder="Search a sport…" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {shown.map((s) => <Chip key={s.slug} label={`${s.emoji} ${s.name}`} active={s.slug === value} onPress={() => { onChange(s.slug); setQ(''); }} />)}
        {term && !shown.length ? <T size={12} color={c.mute}>No sport matches "{q}".</T> : null}
      </View>
    </View>
  );
}
