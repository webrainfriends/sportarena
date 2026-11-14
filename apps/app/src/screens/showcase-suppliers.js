import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, Animated, Platform } from 'react-native';
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
  const accent = 'rgba(255,140,0,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>📦</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Suppliers</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Every equipment and service provider for elite events</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

export function ShowcaseSuppliers({ manifest, block, onNavigate }) {
  const [selected, setSelected] = useState(['equipment', 'nutrition', 'tech']);
  const [rfqStep, setRfqStep]   = useState(0);
  const rfqAnim = useRef(new Animated.Value(0)).current;
  const toggle = (k) => setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);

  const setRfqStepAnim = (i) => {
    Animated.sequence([
      Animated.timing(rfqAnim, { toValue: 1, duration: 0, useNativeDriver: true }),
      Animated.timing(rfqAnim, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(rfqAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setRfqStep(i);
  };

  const catAnims = useRef(CATEGORIES.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(45, catAnims.map((a) => Animated.timing(a, { toValue: 1, duration: 280, useNativeDriver: true }))).start();
    rfqAnim.setValue(1);
  }, []);

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

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>SELECT CATEGORIES YOU NEED</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {CATEGORIES.map((c, i) => {
          const sel = selected.includes(c.key);
          return (
            <Animated.View
              key={c.key}
              style={{
                width: '30%',
                opacity: catAnims[i],
                transform: [{ translateX: catAnims[i].interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
              }}>
              <TouchableOpacity
                onPress={() => toggle(c.key)}
                style={[glass, { width: '100%', alignItems: 'center', paddingVertical: 8, borderColor: sel ? palette.p2 : 'rgba(255,255,255,0.14)', backgroundColor: sel ? palette.p2 : 'rgba(255,255,255,0.07)' }]}>
                <T style={{ fontSize: 18, marginBottom: 2 }}>{c.emoji}</T>
                <T style={{ color: sel ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 10, fontWeight: '600', textAlign: 'center' }}>{c.label}</T>
              </TouchableOpacity>
            </Animated.View>
          );
        })}
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>RFQ PIPELINE</T>
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
        {RFQ.map((s, i) => (
          <TouchableOpacity key={s.label} onPress={() => setRfqStepAnim(i)} style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: i === rfqStep ? palette.p2 : i < rfqStep ? palette.p3 + '55' : 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 3 }}>
              <T style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{i + 1}</T>
            </View>
            <T style={{ color: i === rfqStep ? palette.p3 : 'rgba(255,255,255,0.35)', fontSize: 9, textAlign: 'center' }}>{s.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <Animated.View style={[glass, { padding: 10, marginBottom: 12, opacity: rfqAnim, backgroundColor: 'rgba(132,88,179,0.12)', borderColor: 'rgba(208,189,244,0.2)' }]}>
        <T style={{ color: palette.p3, fontWeight: '700', fontSize: 12, marginBottom: 3 }}>{RFQ[rfqStep].label}</T>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 17 }}>{RFQ[rfqStep].desc}</T>
      </Animated.View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>List as a supplier →</T>
      </TouchableOpacity>
    </View>
  );
}
