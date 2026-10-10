// Sport picker: a dropdown that filters by type (team / individual / board & card / online games) and search,
// with the user's favourites on top and a star on every row to add/remove one. The value is the sport's slug.
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from './api';
import { useLoad } from './hooks';
import { useSession } from './session';
import { Chip, Field, T } from './ui';
import { c } from './theme';

let cache = null;
export const useSports = () => useLoad(() => (cache ??= api.get('/sports')), []);

// favourites are shared by every picker on screen: one module-level store, pickers subscribe
let favs = null; const subs = new Set();
const publish = (x) => { favs = x; subs.forEach((f) => f(x)); };
export function useFavSports() {
  const { user } = useSession();
  const [slugs, setSlugs] = useState(favs ?? []);
  useEffect(() => {
    subs.add(setSlugs);
    if (user && favs === null) api.get('/me/favourite-sports').then((l) => publish(l.map((s) => s.slug))).catch(() => {});
    return () => { subs.delete(setSlugs); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = useCallback(async (slug) => {
    const on = (favs ?? []).includes(slug);
    publish(on ? favs.filter((x) => x !== slug) : [slug, ...(favs ?? [])]); // optimistic
    try { await (on ? api.del(`/sports/${slug}/favourite`) : api.post(`/sports/${slug}/favourite`, {})); }
    catch { publish(on ? [slug, ...(favs ?? [])] : (favs ?? []).filter((x) => x !== slug)); }
  }, []);
  return { slugs: user ? slugs : [], toggle, signedIn: !!user };
}

export const TYPES = [
  { value: 'team', label: '👥 Team' },
  { value: 'individual', label: '🏃 Individual' },
  { value: 'board', label: '♟️ Board & card' },
  { value: 'esports', label: '🎮 Online games' },
];

function Panel({ all, value, onPick, allLabel }) {
  const { slugs, toggle, signedIn } = useFavSports();
  const [type, setType] = useState(null); // null = all, 'fav' = favourites
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const favSet = new Set(slugs);
  const base = type === 'fav' ? all.filter((s) => favSet.has(s.slug)) : type ? all.filter((s) => s.play_type === type) : all;
  const rows = term ? base.filter((s) => s.name.toLowerCase().includes(term)) : base;
  const ordered = type === 'fav' || term ? rows : [...rows.filter((s) => favSet.has(s.slug)), ...rows.filter((s) => !favSet.has(s.slug))];
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 10, backgroundColor: c.paper }}>
      <Field value={q} onChangeText={setQ} placeholder={`Search ${all.length} sports & games…`} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {signedIn ? <Chip label={`★ Favourites${slugs.length ? ` (${slugs.length})` : ''}`} active={type === 'fav'} onPress={() => setType('fav')} /> : null}
        <Chip label="All" active={type === null} onPress={() => setType(null)} />
        {TYPES.map((t) => <Chip key={t.value} label={t.label} active={type === t.value} onPress={() => setType(t.value)} />)}
      </ScrollView>
      <ScrollView style={{ maxHeight: 280 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {allLabel ? <Pressable onPress={() => onPick(null)} style={rowStyle(value == null)}><T weight="700">✨ {allLabel}</T></Pressable> : null}
        {ordered.map((s) => (
          <Pressable key={s.slug} onPress={() => onPick(s.slug)} style={rowStyle(s.slug === value)}>
            <T weight="700" style={{ flex: 1 }}>{s.emoji} {s.name}</T>
            <T size={11} color={c.mute} style={{ marginRight: 8 }}>{TYPES.find((t) => t.value === s.play_type)?.label.replace(/^\S+ /, '')}</T>
            {signedIn ? <Pressable onPress={() => toggle(s.slug)} hitSlop={10}><T size={20} color={favSet.has(s.slug) ? '#F59E0B' : c.mute}>{favSet.has(s.slug) ? '★' : '☆'}</T></Pressable> : null}
          </Pressable>
        ))}
        {!ordered.length ? <T size={12} color={c.mute} style={{ padding: 10 }}>{type === 'fav' && !term ? 'No favourites yet — tap ☆ on any sport to add it.' : `No sport matches${term ? ` "${q}"` : ''}.`}</T> : null}
      </ScrollView>
    </View>
  );
}
const rowStyle = (on) => ({ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 10, borderRadius: 12, backgroundColor: on ? c.violetSoft : 'transparent' });

/** Dropdown sport selector. `allLabel` (e.g. "All sports") adds a "no filter" row and makes null the empty value. */
export function SportSelect({ label, value, onChange, optional, allLabel }) {
  const sports = useSports();
  const [open, setOpen] = useState(false);
  const all = sports.data ?? [];
  const picked = all.find((s) => s.slug === value);
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T> : null}
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: open ? c.ink : c.line, borderRadius: 14, backgroundColor: c.paper, paddingHorizontal: 14, paddingVertical: 12 }}>
        <T weight="700">{picked ? `${picked.emoji} ${picked.name}` : allLabel ? `✨ ${allLabel}` : 'Choose a sport…'}</T>
        <T color={c.mute}>{open ? '▴' : '▾'}</T>
      </Pressable>
      {open ? <Panel all={all} value={value} allLabel={allLabel ?? (optional ? 'Any / none' : null)} onPick={(slug) => { onChange(slug ?? (allLabel ? null : '')); setOpen(false); }} /> : null}
    </View>
  );
}

/** Several sports: chips for what is chosen (tap to remove) and a dropdown to add more. value is an array of slugs. */
export function SportsMulti({ label, value = [], onChange, optional }) {
  const sports = useSports();
  const by = new Map((sports.data ?? []).map((x) => [x.slug, x]));
  return (
    <View style={{ gap: 8 }}>
      {label ? <T weight="800" size={13}>{label}{optional ? ' (optional)' : ''}</T> : null}
      {value.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((slug) => <Chip key={slug} active label={`${by.get(slug)?.emoji ?? ''} ${by.get(slug)?.name ?? slug}  ✕`} onPress={() => onChange(value.filter((x) => x !== slug))} />)}</View> : null}
      <SportSelect value={null} label={value.length ? 'Add another sport' : undefined} onChange={(slug) => { if (slug && !value.includes(slug)) onChange([...value, slug]); }} />
    </View>
  );
}

// form field (FormSheet type 'sport')
export const SportPicker = (p) => <SportSelect {...p} />;

/** Profile section: the user's starred sports/games, removable, with a dropdown to add more. */
export function FavouriteSports() {
  const sports = useSports();
  const { slugs, toggle } = useFavSports();
  const by = new Map((sports.data ?? []).map((s) => [s.slug, s]));
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>Starred sports and games show first in every picker. Add as many as you like.</T>
      {slugs.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {slugs.map((slug) => by.get(slug) ? <Chip key={slug} label={`${by.get(slug).emoji} ${by.get(slug).name}  ✕`} active onPress={() => toggle(slug)} /> : null)}
        </View>
      ) : <T size={13} weight="700">No favourites yet.</T>}
      <SportSelect value={null} label="Add a favourite" onChange={(slug) => { if (slug && !slugs.includes(slug)) toggle(slug); }} />
    </View>
  );
}
