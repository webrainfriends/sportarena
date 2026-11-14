import React from 'react';
import { View, Text, Switch as RNSwitch, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

export function Switch({ label, value, onChange, accessibilityLabel }) {
  const { C } = useTheme();
  return (
    <View style={s.row}>
      {label ? <Text style={[s.lbl, { color: C.ink, flex: 1 }]}>{label}</Text> : null}
      <RNSwitch value={!!value} onValueChange={onChange} thumbColor={value ? C.accent : '#fff'} trackColor={{ false: C.border, true: C.accentSoft ?? C.accent }} accessibilityLabel={accessibilityLabel ?? label} />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  lbl: { fontSize: 15 },
});
