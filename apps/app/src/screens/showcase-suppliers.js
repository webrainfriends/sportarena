import React, { useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const CATEGORIES = [
  { key: 'equipment',   label: 'Equipment',   emoji: '⚽' },
  { key: 'apparel',     label: 'Apparel',     emoji: '👕' },
  { key: 'nutrition',   label: 'Nutrition',   emoji: '🥗' },
  { key: 'tech',        label: 'Technology',  emoji: '📱' },
  { key: 'media',       label: 'Media',       emoji: '📹' },
  { key: 'logistics',   label: 'Logistics',   emoji: '🚛' },
  { key: 'medical',     label: 'Medical',     emoji: '⚕️' },
  { key: 'hospitality', label: 'Hospitality', emoji: '🏨' },
  { key: 'security',    label: 'Security',    emoji: '🔒' },
];
const RFQ = [
  { label: 'Request', desc: 'Post your requirement with specs, quantity, timeline and budget.' },
  { label: 'Quote',   desc: 'Verified suppliers respond with itemised quotes in 24 hours.' },
  { label: 'Award',   desc: 'Compare, negotiate and award via the platform. Contract generated.' },
  { label: 'Fulfil',  desc: 'Track delivery, sign off on receipt, release payment from escrow.' },
];

export function ShowcaseSuppliers({ manifest, block, onNavigate }) {
  const [selected, setSelected] = useState(['equipment', 'nutrition', 'tech']);
  const [rfqStep, setRfqStep]   = useState(0);
  const toggle = (k) => setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Suppliers</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Every equipment and service provider for elite events</T>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>SELECT CATEGORIES YOU NEED</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {CATEGORIES.map((c) => {
          const sel = selected.includes(c.key);
          return (
            <TouchableOpacity key={c.key} onPress={() => toggle(c.key)} style={{ width: '30%', alignItems: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: sel ? palette.p2 : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: sel ? palette.p2 : 'rgba(255,255,255,0.14)' }}>
              <T style={{ fontSize: 18, marginBottom: 2 }}>{c.emoji}</T>
              <T style={{ color: sel ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 10, fontWeight: '600', textAlign: 'center' }}>{c.label}</T>
            </TouchableOpacity>
          );
        })}
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>RFQ PIPELINE</T>
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
        {RFQ.map((s, i) => (
          <TouchableOpacity key={s.label} onPress={() => setRfqStep(i)} style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: i === rfqStep ? palette.p2 : i < rfqStep ? palette.p3 + '55' : 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 3 }}>
              <T style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{i + 1}</T>
            </View>
            <T style={{ color: i === rfqStep ? palette.p3 : 'rgba(255,255,255,0.35)', fontSize: 9, textAlign: 'center' }}>{s.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ padding: 10, borderRadius: 10, backgroundColor: 'rgba(132,88,179,0.12)', borderWidth: 1, borderColor: 'rgba(208,189,244,0.2)', marginBottom: 12 }}>
        <T style={{ color: palette.p3, fontWeight: '700', fontSize: 12, marginBottom: 3 }}>{RFQ[rfqStep].label}</T>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 17 }}>{RFQ[rfqStep].desc}</T>
      </View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>List as a supplier →</T>
      </TouchableOpacity>
    </View>
  );
}
