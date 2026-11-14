import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { useTheme } from '../theme';

/** Single-select dropdown. options: [{value, label}] */
export function MenuField({ label, value, options = [], onChange, placeholder, accessibilityLabel }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <View style={s.wrap}>
      {label ? <Text style={[s.lbl, { color: C.mute }]}>{label}</Text> : null}
      <TouchableOpacity style={[s.btn, { backgroundColor: C.paper, borderColor: C.border }]} onPress={() => setOpen(true)} accessibilityLabel={accessibilityLabel ?? label}>
        <Text style={[s.val, { color: selected ? C.ink : C.mute }]}>{selected?.label ?? placeholder ?? '—'}</Text>
        <Text style={{ color: C.mute }}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.sheet, { backgroundColor: C.bg }]}>
          <FlatList
            data={options}
            keyExtractor={(o) => String(o.value)}
            renderItem={({ item }) => (
              <TouchableOpacity style={[s.opt, { borderBottomColor: C.border }]} onPress={() => { onChange?.(item.value); setOpen(false); }}>
                <Text style={[s.optTxt, { color: item.value === value ? C.accent : C.ink }]}>{item.label}</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: 12 },
  lbl: { fontSize: 12, marginBottom: 4 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 8, padding: 12 },
  val: { fontSize: 15 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { margin: 20, borderRadius: 12, overflow: 'hidden', maxHeight: 400, marginTop: 'auto' },
  opt: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  optTxt: { fontSize: 15 },
});
