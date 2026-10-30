// Small controls shared by the bracket screens.
import React from 'react';
import { Pressable, View } from 'react-native';
import { T } from './ui';

/** − / + for a small whole number, on the light sheet background; 44pt touch targets. */
export function AStepperLite({ label, value, onChange, min = 0, max = 99 }) {
  const btn = (txt, d, name) => (
    <Pressable onPress={() => onChange(Math.max(min, Math.min(max, value + d)))} accessibilityRole="button" accessibilityLabel={name} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#EEF2FF', alignItems: 'center', justifyContent: 'center' }}><T size={20} weight="800">{txt}</T></Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityRole="adjustable" accessibilityLabel={`${label}: ${value}`}>
      {label ? <T size={12.5} color="#475569" style={{ maxWidth: 120 }}>{label}</T> : null}
      {btn('−', -1, `Fewer: ${label}`)}<T weight="900" style={{ minWidth: 22, textAlign: 'center' }}>{value}</T>{btn('+', 1, `More: ${label}`)}
    </View>
  );
}
