import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

/** Horizontal strip of key metrics. metrics: [{label, value, color?}] */
export function MetricStrip({ metrics = [] }) {
  const { C } = useTheme();
  return (
    <View style={[s.strip, { backgroundColor: C.paper }]}>
      {metrics.map((m, i) => (
        <View key={i} style={s.cell}>
          <Text style={[s.val, { color: m.color ?? C.ink }]}>{m.value}</Text>
          <Text style={[s.lbl, { color: C.mute }]}>{m.label}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  strip: { flexDirection: 'row', borderRadius: 10, padding: 12, marginBottom: 12, flexWrap: 'wrap' },
  cell: { flex: 1, minWidth: 80, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4 },
  val: { fontSize: 20, fontWeight: '700' },
  lbl: { fontSize: 11, marginTop: 2, textAlign: 'center' },
});
