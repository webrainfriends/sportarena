// A dropdown field: one 50pt row that shows the current choice and opens a sheet of options (with optional search once the list is long).
// Used wherever the choice is one of a known set, so the screen shows one control instead of a row of chips. Same look as DateField / CurrencyDropdown.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { c } from './theme';
import { Field, Sheet, T } from './ui';

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
