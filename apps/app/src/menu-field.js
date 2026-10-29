// A dropdown field: one 50pt row that shows the current choice and opens a sheet of options (with optional search once the list is long).
// Used wherever the choice is one of a known set, so the screen shows one control instead of a row of chips. Same look as DateField / CurrencyDropdown.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { c } from './theme';
import { Btn, Field, Sheet, T } from './ui';

/** options: [{ value, label, sub? }]. `value` may be '' for a real "none" choice. */
export function MenuField({ label, value, onChange, options, placeholder = 'Choose', hint, disabled, title }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const now = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(t)) : options;
  }, [options, q]);
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{label.toUpperCase()}</T> : null}
      <Pressable disabled={disabled} onPress={() => { setQ(''); setOpen(true); }} accessibilityRole="button" accessibilityLabel={`${label ?? title ?? 'Choice'}: ${now?.label ?? placeholder}. Change`} accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, opacity: disabled ? 0.55 : 1 }}>
        <T weight="600" style={{ flex: 1 }} color={now ? c.ink : c.mute} numberOfLines={1}>{now?.label ?? placeholder}</T>
        <T size={12} color={c.mute}>▼</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={title ?? label ?? 'Choose'}>
        {options.length > 8 ? <Field value={q} onChangeText={setQ} placeholder="Search" accessibilityLabel="Search the list" /> : null}
        {shown.length ? shown.map((o) => (
          <Pressable key={String(o.value)} onPress={() => { onChange(o.value); setOpen(false); }} accessibilityRole="button" accessibilityLabel={o.label} accessibilityState={{ selected: o.value === value }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, backgroundColor: o.value === value ? c.violetSoft : pressed ? c.bg : 'transparent' })}>
            <View style={{ flex: 1 }}><T weight="600">{o.label}</T>{o.sub ? <T size={12} color={c.mute}>{o.sub}</T> : null}</View>
            <T size={14} color={c.pink} weight="800" style={{ width: 16 }}>{o.value === value ? '✓' : ''}</T>
          </Pressable>
        )) : <T size={13} color={c.mute}>Nothing matches that search.</T>}
      </Sheet>
    </View>
  );
}

/**
 * A searchable multi-select dropdown (#591). Same look as MenuField, for lists that can grow (events, venues, competitions…): a 50pt row showing
 * the current choice, a sheet with a search box and tick boxes. Give it `options` for a list you already hold, or `load(q)` to search the server as you type.
 * `max` = 1 behaves as a single choice. value is an array of ids; labels of chosen items are remembered so the row can name them after the list changes.
 */
export function MultiMenuField({ label, value = [], onChange, options, load, max, placeholder = 'All', hint, title, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState({});
  useEffect(() => {
    if (!open || !load) return undefined;
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try { const rows = await load(q.trim()); if (live) setFound(rows); } catch { if (live) setFound([]); } finally { if (live) setBusy(false); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, load]);
  const list = useMemo(() => {
    if (load) return found;
    const t = q.trim().toLowerCase();
    return t ? (options ?? []).filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(t)) : options ?? [];
  }, [load, found, options, q]);
  const nameOf = (v) => names[v] ?? (options ?? []).find((o) => o.value === v)?.label ?? 'Selected';
  const toggle = (o) => {
    setNames((n) => ({ ...n, [o.value]: o.label }));
    if (max === 1) { onChange(value.includes(o.value) ? [] : [o.value]); setOpen(false); return; }
    onChange(value.includes(o.value) ? value.filter((x) => x !== o.value) : max && value.length >= max ? value : [...value, o.value]);
  };
  const shown = !value.length ? placeholder : value.length <= 2 ? value.map(nameOf).join(', ') : `${value.length} selected`;
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{label.toUpperCase()}</T> : null}
      <Pressable disabled={disabled} onPress={() => { setQ(''); setOpen(true); }} accessibilityRole="button" accessibilityLabel={`${label ?? title ?? 'Choice'}: ${shown}. Change`} accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: value.length ? c.pink : c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, opacity: disabled ? 0.55 : 1 }}>
        <T weight="600" style={{ flex: 1 }} color={value.length ? c.ink : c.mute} numberOfLines={1}>{shown}</T>
        <T size={12} color={c.mute}>▼</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={title ?? label ?? 'Choose'}
        footer={max === 1 ? null : <View style={{ flexDirection: 'row', gap: 8 }}>{value.length ? <Btn small color={c.paper} ink={c.ink} title="Clear" onPress={() => onChange([])} accessibilityLabel="Clear the selection" /> : null}<Btn small title={value.length ? `Done (${value.length})` : 'Done'} onPress={() => setOpen(false)} accessibilityLabel="Done choosing" /></View>}>
        {(load || (options ?? []).length > 8) ? <Field value={q} onChangeText={setQ} placeholder="Search" accessibilityLabel="Search the list" /> : null}
        {busy ? <T size={12} color={c.mute}>Searching…</T> : null}
        {list.map((o) => {
          const on = value.includes(o.value);
          return (
            <Pressable key={String(o.value)} onPress={() => toggle(o)} accessibilityRole="checkbox" accessibilityLabel={o.label} accessibilityState={{ checked: on }}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, backgroundColor: on ? c.violetSoft : pressed ? c.bg : 'transparent' })}>
              <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: c.pink, backgroundColor: on ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <T size={12} weight="800" color={c.onAccent}>✓</T> : null}</View>
              <View style={{ flex: 1 }}><T weight="600">{o.label}</T>{o.sub ? <T size={12} color={c.mute}>{o.sub}</T> : null}</View>
            </Pressable>
          );
        })}
        {!busy && !list.length ? <T size={13} color={c.mute}>{load && !q.trim() ? 'Nothing to choose from yet.' : 'Nothing matches that search.'}</T> : null}
      </Sheet>
    </View>
  );
}
