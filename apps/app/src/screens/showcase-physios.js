import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, Animated, Platform } from 'react-native';
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

function ChapterHero() {
  const glow = useRef(new Animated.Value(0.3)).current;
  const bar  = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 0.8, duration: 1800, useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0.3, duration: 1800, useNativeDriver: true }),
    ])).start();
    Animated.timing(bar, { toValue: 1, duration: 600, delay: 200, useNativeDriver: false }).start();
  }, []);
  const accent = 'rgba(220,80,120,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>🩺</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Physios & Doctors</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Book the right specialist for every part of your body</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

function HotspotButton({ r, selected, onPress }) {
  const halo = useRef(new Animated.Value(0.2)).current;
  useEffect(() => {
    if (selected) {
      Animated.loop(Animated.sequence([
        Animated.timing(halo, { toValue: 0.6, duration: 900, useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0.2, duration: 900, useNativeDriver: true }),
      ])).start();
    } else {
      halo.setValue(0.2);
    }
  }, [selected]);

  const glass = {
    width: '23%', alignItems: 'center', paddingVertical: 8, borderRadius: 10,
    backgroundColor: selected ? palette.p2 : 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: selected ? palette.p2 : 'rgba(255,255,255,0.15)',
    overflow: 'visible',
    ...(Platform.OS === 'web' ? { backdropFilter: selected ? 'blur(10px)' : 'none', WebkitBackdropFilter: selected ? 'blur(10px)' : 'none' } : {}),
  };

  return (
    <TouchableOpacity
      onPress={() => onPress(r.key)}
      accessibilityRole="button"
      accessibilityLabel={`Select ${r.label}`}
      style={{ width: '23%', position: 'relative', alignItems: 'center' }}>
      {selected && (
        <Animated.View style={{
          position: 'absolute', top: -6, left: -6, right: -6, bottom: -6,
          borderRadius: 16, borderWidth: 2, borderColor: 'rgba(220,80,120,0.5)',
          opacity: halo,
        }} />
      )}
      <View style={[glass, { width: '100%' }]}>
        <T style={{ fontSize: 18, marginBottom: 2 }}>{r.emoji}</T>
        <T style={{ color: selected ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '600', textAlign: 'center' }}>{r.label}</T>
      </View>
    </TouchableOpacity>
  );
}

export function ShowcasePhysios({ manifest, block, onNavigate }) {
  const [region, setRegion] = useState('knee');
  const [type, setType]     = useState('Physiotherapist');
  const reg = REGIONS.find((r) => r.key === region);

  const detailAnim = useRef(new Animated.Value(1)).current;
  const setRegionAnim = (k) => {
    Animated.sequence([
      Animated.timing(detailAnim, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(detailAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setRegion(k);
  };

  const glass = {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  };

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <ChapterHero />

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
          <HotspotButton key={r.key} r={r} selected={r.key === region} onPress={setRegionAnim} />
        ))}
      </View>

      {reg && (
        <Animated.View style={[glass, { padding: 12, marginBottom: 12, opacity: detailAnim, backgroundColor: 'rgba(132,88,179,0.15)', borderColor: 'rgba(208,189,244,0.25)' }]}>
          <T style={{ color: palette.p3, fontWeight: '700', fontSize: 13, marginBottom: 6 }}>{reg.emoji} {reg.label}</T>
          <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginBottom: 6 }}>Common conditions treated by {type.toLowerCase()}:</T>
          {reg.conditions.map((cond) => (
            <View key={cond} style={{ flexDirection: 'row', gap: 6, marginBottom: 3 }}>
              <T style={{ color: palette.p3 }}>·</T>
              <T style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>{cond}</T>
            </View>
          ))}
        </Animated.View>
      )}

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Book a {type.toLowerCase()} →</T>
      </TouchableOpacity>
    </View>
  );
}
