import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

export function StepperField({ label, value = 0, onChange, min = 0, max = 100, step = 1, accessibilityLabel }) {
  const { C } = useTheme();
  return (
    <View style={s.wrap}>
      {label ? <Text style={[s.lbl, { color: C.mute }]}>{label}</Text> : null}
      <View style={[s.row, { backgroundColor: C.paper, borderColor: C.border }]}>
        <TouchableOpacity style={[s.btn, { borderRightColor: C.border }]} onPress={() => onChange?.(Math.max(min, value - step))} accessibilityLabel="-">
          <Text style={[s.btnTxt, { color: C.ink }]}>−</Text>
        </TouchableOpacity>
        <Text style={[s.val, { color: C.ink }]} accessibilityLabel={accessibilityLabel ?? label}>{value}</Text>
        <TouchableOpacity style={[s.btn, { borderLeftColor: C.border }]} onPress={() => onChange?.(Math.min(max, value + step))} accessibilityLabel="+">
          <Text style={[s.btnTxt, { color: C.ink }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 12 },
  lbl: { fontSize: 12, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  btn: { padding: 12, borderWidth: 0 },
  btnTxt: { fontSize: 20, fontWeight: '600', paddingHorizontal: 4 },
  val: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
});
