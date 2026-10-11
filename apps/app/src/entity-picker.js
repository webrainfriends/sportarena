// One search-and-pick control for people and teams (single or multi). Never ask for an id or a typed name where a person
// or a team is meant: search, tap, done. With `options` it filters a list you already have (e.g. a department's members).
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from './api';
import { Field, Sheet, T } from './ui';
import { A, AAvatar, ABtn, AChip, AT } from './arena';

const asItem = (kind) => (x) => (kind === 'team'
  ? { id: x.id, label: x.name, sub: [x.sport, x.city].filter(Boolean).join(' · '), emoji: x.emoji, color: x.color }
  : { id: x.id, label: x.display_name, sub: x.handle ? `@${x.handle}` : '', emoji: x.avatar_emoji, color: x.avatar_color });

/**
 * @param {{ kind?: 'person'|'team', label: string, value: {id:string,label:string}[], onChange: (v: any[]) => void, multi?: boolean,
 *           options?: any[], sport?: string, role?: string, optional?: boolean, mine?: boolean }} p
 */
export function EntityPicker({ kind = 'person', label, value = [], onChange, multi = false, options, sport, role, optional, mine }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [busy, setBusy] = useState(false);
  const known = useMemo(() => (options ? options.map((o) => (o.label ? o : asItem(kind)(o))) : null), [options, kind]);

  useEffect(() => {
    if (!open || known) return undefined;
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const rows = kind === 'team' ? await api.get('/teams', { q: q.trim() || undefined, sport, mine: mine || undefined, limit: 12 }) : await api.get('/people', { q: q.trim() || undefined, sport, role, limit: 12 });
        if (live) setFound(rows.map(asItem(kind)));
      } catch { if (live) setFound([]); } finally { if (live) setBusy(false); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, kind, sport, role, mine, known]);

  const list = known ? known.filter((o) => !q.trim() || `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) : found;
  const has = (id) => value.some((v) => v.id === id);
  const toggle = (it) => {
    if (multi) onChange(has(it.id) ? value.filter((v) => v.id !== it.id) : [...value, it]);
    else { onChange([it]); setOpen(false); }
  };
  return (
    <View style={{ gap: 8 }}>
      <AT size={12} weight="800" color={A.mute} style={{ letterSpacing: 0.6 }}>{`${label}${optional ? ' (OPTIONAL)' : ''}`.toUpperCase()}</AT>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {value.map((v) => <AChip key={v.id} active label={`${v.emoji ?? ''} ${v.label} ✕`.trim()} onPress={() => onChange(value.filter((x) => x.id !== v.id))} />)}
        <AChip label={value.length && !multi ? 'Change' : `+ ${multi ? 'Add' : 'Pick'} ${kind === 'team' ? 'team' : 'person'}`} onPress={() => { setQ(''); setOpen(true); }} />
      </View>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        <Field value={q} onChangeText={setQ} placeholder={kind === 'team' ? 'Search teams…' : 'Search by name or @handle…'} />
        {busy ? <T size={12} color="#94A3B8">Searching…</T> : null}
        {!busy && !list.length ? <T size={13} color="#94A3B8">{known ? 'Nobody matches.' : q.trim() ? 'No results.' : 'Type to search.'}</T> : null}
        <View style={{ gap: 8 }}>
          {list.map((it) => (
            <Pressable key={it.id} onPress={() => toggle(it)} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 16, borderWidth: 1.5, borderColor: has(it.id) ? A.violet : '#E6EAF2', backgroundColor: has(it.id) ? '#EEF0FF' : '#fff' })}>
              <AAvatar user={{ avatar_emoji: it.emoji, avatar_color: it.color }} size={38} ring="#fff" />
              <View style={{ flex: 1 }}><T weight="700">{it.label}</T>{it.sub ? <T size={12} color="#64748B">{it.sub}</T> : null}</View>
              <T weight="800" color={has(it.id) ? A.violet : '#94A3B8'}>{has(it.id) ? '✓' : '+'}</T>
            </Pressable>
          ))}
        </View>
        {multi ? <ABtn title={`Done${value.length ? ` (${value.length})` : ''}`} onPress={() => setOpen(false)} /> : null}
      </Sheet>
    </View>
  );
}
