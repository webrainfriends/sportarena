import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const CATEGORIES = [
  { key: 'equipment', label: 'Equipment', icon: '⚽' },
  { key: 'grounds', label: 'Grounds', icon: '🏟️' },
  { key: 'medics', label: 'Medics', icon: '🩺' },
  { key: 'catering', label: 'Catering', icon: '🍽️' },
  { key: 'security', label: 'Security', icon: '🛡️' },
  { key: 'travel', label: 'Travel', icon: '✈️' },
  { key: 'maintenance', label: 'Maintenance', icon: '🔧' },
  { key: 'electrical', label: 'Electrical', icon: '⚡' },
  { key: 'connectivity', label: 'Connectivity', icon: '📡' },
];

const WORKFLOW = ['RFQ', 'Responses', 'Evaluate', 'Award', 'Fulfil', 'Invoice'];

export function ShowcaseSuppliers({ block, manifest, onCta }) {
  const [selected, setSelected] = useState(new Set(['equipment', 'grounds']));
  const [wfStep, setWfStep] = useState(0);

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Suppliers</T>

      {/* Category grid */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Select your event needs</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {CATEGORIES.map(({ key, label, icon }) => {
            const sel = selected.has(key);
            return (
              <Pressable key={key} onPress={() => toggle(key)}
                accessibilityRole="checkbox" accessibilityLabel={label}
                accessibilityState={{ checked: sel }}
                style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
                <View style={{ width: 88, height: 76, backgroundColor: sel ? c.pinkSoft : c.violetSoft, borderRadius: r.card, alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: sel ? 2 : 1, borderColor: sel ? c.pink : c.line }}>
                  <T size={22}>{icon}</T>
                  <T size={10} weight="700" color={sel ? c.pink : c.mute}>{label}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
        <T size={12} color={c.pink} weight="600" style={{ marginTop: 10 }}>
          {selected.size} categor{selected.size === 1 ? 'y' : 'ies'} selected · Start your RFQ
        </T>
      </Card>

      {/* Workflow steps */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Supplier workflow</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
          {WORKFLOW.map((s, i) => (
            <React.Fragment key={s}>
              <Pressable onPress={() => setWfStep(i)} accessibilityRole="button" accessibilityLabel={`${s} phase`} accessibilityState={{ selected: i === wfStep }}>
                <View style={{ alignItems: 'center', paddingHorizontal: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= wfStep ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={i <= wfStep ? '#fff' : c.mute}>{i + 1}</T>
                  </View>
                  <T size={10} weight="600" color={i === wfStep ? c.pink : c.mute} style={{ marginTop: 4 }}>{s}</T>
                </View>
              </Pressable>
              {i < WORKFLOW.length - 1 && <View style={{ width: 16, height: 2, backgroundColor: i < wfStep ? c.pink : c.line, marginBottom: 16 }} />}
            </React.Fragment>
          ))}
        </ScrollView>
      </Card>

      <Btn title="Find suppliers →" onPress={() => onCta('supplier-rfq')} />
    </View>
  );
}
