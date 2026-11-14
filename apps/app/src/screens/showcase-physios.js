import React, { useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const REGIONS = [
  { key: 'head',     label: 'Head & neck',     emoji: '🧠', conditions: ['Concussion', 'Cervical strain', 'Headache'] },
  { key: 'shoulder', label: 'Shoulder',        emoji: '💪', conditions: ['Rotator cuff', 'AC joint', 'Impingement'] },
  { key: 'elbow',    label: 'Elbow & forearm', emoji: '🦾', conditions: ["Tennis elbow", "Golfer's elbow", 'UCL sprain'] },
  { key: 'wrist',    label: 'Wrist & hand',    emoji: '✋', conditions: ['TFCC tear', 'Scaphoid fracture', "De Quervain's"] },
  { key: 'spine',    label: 'Spine & core',    emoji: '🏋️', conditions: ['Disc herniation', 'Facet syndrome', 'Core weakness'] },
  { key: 'hip',      label: 'Hip & groin',     emoji: '🦵', conditions: ['FAI', 'Adductor strain', 'Labral tear'] },
  { key: 'knee',     label: 'Knee',            emoji: '🦿', conditions: ['ACL', 'Meniscus', 'Patellar tendinopathy'] },
  { key: 'ankle',    label: 'Ankle & foot',    emoji: '🦶', conditions: ['Ankle sprain', 'Achilles', 'Plantar fasciitis'] },
];
const TYPES = ['Physiotherapist', 'Sports doctor'];

export function ShowcasePhysios({ manifest, block, onNavigate }) {
  const [region, setRegion] = useState('knee');
  const [type, setType]     = useState('Physiotherapist');
  const reg = REGIONS.find((r) => r.key === region);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Physios & Doctors</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Book the right specialist for every part of your body</T>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {TYPES.map((t) => (
          <TouchableOpacity key={t} onPress={() => setType(t)} style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: t === type ? palette.p2 : 'rgba(255,255,255,0.08)', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: t === type ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '600' }}>{t}</T>
          </TouchableOpacity>
        ))}
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>SELECT BODY REGION</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {REGIONS.map((r) => (
          <TouchableOpacity
            key={r.key}
            onPress={() => setRegion(r.key)}
            accessibilityRole="button"
            accessibilityLabel={`Select ${r.label}`}
            style={{ width: '23%', alignItems: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: r.key === region ? palette.p2 : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: r.key === region ? palette.p2 : 'rgba(255,255,255,0.15)' }}>
            <T style={{ fontSize: 18, marginBottom: 2 }}>{r.emoji}</T>
            <T style={{ color: r.key === region ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '600', textAlign: 'center' }}>{r.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      {reg && (
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: 'rgba(132,88,179,0.15)', borderWidth: 1, borderColor: 'rgba(208,189,244,0.25)', marginBottom: 12 }}>
          <T style={{ color: palette.p3, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>{reg.emoji} {reg.label}</T>
          <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginBottom: 6 }}>Common conditions treated by {type.toLowerCase()}:</T>
          {reg.conditions.map((cond) => (
            <View key={cond} style={{ flexDirection: 'row', gap: 6, marginBottom: 3 }}>
              <T style={{ color: palette.p3 }}>·</T>
              <T style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>{cond}</T>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Book a {type.toLowerCase()} →</T>
      </TouchableOpacity>
    </View>
  );
}
