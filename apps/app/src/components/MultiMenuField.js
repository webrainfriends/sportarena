import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { useTheme } from '../theme';

/** Multi-select searchable dropdown. options: [{value, label}], value: array of values */
export function MultiMenuField({ label, value = [], options = [], onChange, placeholder, accessibilityLabel }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  const toggle = (v) => {
    const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
    onChange?.(next);
  };
  const summary = value.length ? options.filter((o) => value.includes(o.value)).map((o) => o.label).join(', ') : (placeholder ?? '—');
  return (
    <View style={s.wrap}>
      {label ? <Text style={[s.lbl, { color: C.mute }]}>{label}</Text> : null}
      <TouchableOpacity style={[s.btn, { backgroundColor: C.paper, borderColor: C.border }]} onPress={() => setOpen(true)} accessibilityLabel={accessibilityLabel ?? label}>
        <Text style={[s.val, { color: value.length ? C.ink : C.mute }]} numberOfLines={1}>{summary}</Text>
        <Text style={{ color: C.mute }}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.sheet, { backgroundColor: C.bg }]}>
          <FlatList
            data={options}
            keyExtractor={(o) => String(o.value)}
            renderItem={({ item }) => {
              const checked = value.includes(item.value);
              return (
                <TouchableOpacity style={[s.opt, { borderBottomColor: C.border }]} onPress={() => toggle(item.value)}>
                  <Text style={{ marginRight: 8, color: C.accent }}>{checked ? '✓' : '○'}</Text>
                  <Text style={[s.optTxt, { color: C.ink }]}>{item.label}</Text>
                </TouchableOpacity>
              );
            }}
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
  val: { flex: 1, fontSize: 15, marginRight: 8 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { margin: 20, borderRadius: 12, overflow: 'hidden', maxHeight: 400, marginTop: 'auto' },
  opt: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  optTxt: { fontSize: 15 },
});
