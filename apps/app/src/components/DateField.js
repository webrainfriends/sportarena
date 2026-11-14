import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Platform, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

/** Date picker field — native date input on web, text fallback on native. */
export function DateField({ label, value, onChange, accessibilityLabel }) {
  const { C } = useTheme();
  const [focused, setFocused] = useState(false);
  const display = value ? new Date(value).toLocaleDateString() : '—';
  if (Platform.OS === 'web') {
    return (
      <View style={s.wrap}>
        {label ? <Text style={[s.lbl, { color: C.mute }]}>{label}</Text> : null}
        <input
          type="date"
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          aria-label={accessibilityLabel ?? label}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: `1px solid ${C.border}`, background: C.paper, color: C.ink, fontSize: 15, boxSizing: 'border-box' }}
        />
      </View>
    );
  }
  return (
    <View style={s.wrap}>
      {label ? <Text style={[s.lbl, { color: C.mute }]}>{label}</Text> : null}
      <TouchableOpacity style={[s.btn, { backgroundColor: C.paper, borderColor: focused ? C.accent : C.border }]} onPress={() => setFocused(true)} accessibilityLabel={accessibilityLabel ?? label}>
        <Text style={[s.val, { color: value ? C.ink : C.mute }]}>{display}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 12 },
  lbl: { fontSize: 12, marginBottom: 4 },
  btn: { borderWidth: 1, borderRadius: 8, padding: 12 },
  val: { fontSize: 15 },
});
