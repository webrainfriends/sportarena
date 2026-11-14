import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useTheme } from '../theme';

/** Horizontal tab bar. tabs: [{key, label}], activeKey, onSelect */
export function TabBar({ tabs = [], activeKey, onSelect }) {
  const { C } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[s.scroll, { borderBottomColor: C.border }]} contentContainerStyle={s.row}>
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <TouchableOpacity key={tab.key} style={[s.tab, active && [s.active, { borderBottomColor: C.accent }]]} onPress={() => onSelect?.(tab.key)} accessibilityLabel={tab.label} accessibilityRole="tab" accessibilityState={{ selected: active }}>
            <Text style={[s.lbl, { color: active ? C.accent : C.mute }]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { borderBottomWidth: StyleSheet.hairlineWidth, flexGrow: 0, marginBottom: 8 },
  row: { flexDirection: 'row' },
  tab: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  active: {},
  lbl: { fontSize: 14, fontWeight: '600' },
});
