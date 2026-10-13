import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from './api';
import { Chip, Field, T } from './ui';
import { c } from './theme';

/** Say where you play: search the cities of listed venues and areas other players use, or add your own. One value. */
export function RegionPicker({ label, value, onChange, optional, hint }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { api.get('/regions', { q: q.trim() || undefined }).then((r) => { if (live) setFound(r); }).catch(() => {}); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const typed = q.trim();
  const canAdd = typed && !found.some((x) => x.toLowerCase() === typed.toLowerCase());
  return (
    <View style={{ gap: 8 }}>
      <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T>
      {value ? <View style={{ flexDirection: 'row', gap: 6 }}><Chip label={`📍 ${value}  ✕`} active onPress={() => onChange('')} /></View> : null}
      <Field value={q} onChangeText={setQ} placeholder="Search a city or area" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {found.filter((x) => x !== value).map((x) => <Chip key={x} label={x} onPress={() => { onChange(x); setQ(''); }} />)}
        {canAdd ? <Chip label={`Use “${typed}”`} onPress={() => { onChange(typed); setQ(''); }} /> : null}
      </View>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}
