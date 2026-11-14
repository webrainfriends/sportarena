import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const TIERS = [
  { key: 'presenting', label: 'Presenting',       rights: 'Logo on all event collateral, naming rights, 60 s activation slot, media partner access', value: '£50 000+' },
  { key: 'associate',  label: 'Associate',        rights: 'Logo on digital assets, 30 s activation, social media mentions, athlete meet', value: '£15 000+' },
  { key: 'media',      label: 'Media partner',    rights: 'Broadcast credits, editorial placement, athlete interview access, digital banner', value: '£8 000+' },
  { key: 'supplier',   label: 'Official supplier', rights: 'Product placement, kit branding, locker room supply, B2B hospitality', value: '£5 000+' },
];
const CATEGORIES = ['Academies', 'Tournaments', 'Athletes', 'Venues', 'National federations'];
const OUTCOMES   = ['Brand reach', 'Youth engagement', 'B2B hospitality', 'Media placement', 'Data & insights'];

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
  const accent = 'rgba(255,215,0,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>🤝</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Sponsorship</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Connect your brand with athletes, academies and events</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

function FloatingTierCard({ x, tier, selected, onPress, delay }) {
  const floatY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(floatY, { toValue: -4, duration: 1800, useNativeDriver: true }),
      Animated.timing(floatY, { toValue: 0, duration: 1800, useNativeDriver: true }),
    ])).start();
  }, [delay]);

  const glass = {
    flex: 1, minWidth: 80, padding: 8, borderRadius: 10,
    backgroundColor: selected ? palette.p2 : 'rgba(255,255,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', alignItems: 'center',
    ...(Platform.OS === 'web' ? { backdropFilter: selected ? 'blur(10px)' : 'none', WebkitBackdropFilter: selected ? 'blur(10px)' : 'none' } : {}),
  };

  return (
    <Animated.View style={{ flex: 1, minWidth: 80, transform: [{ translateY: floatY }] }}>
      <TouchableOpacity onPress={() => onPress(x.key)} style={glass}>
        <T style={{ color: x.key === selected ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{x.label}</T>
        <T style={{ color: x.key === selected ? palette.p3 : 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '600', marginTop: 2 }}>{x.value}</T>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function ShowcaseSponsors({ manifest, block, onNavigate }) {
  const [tier, setTier]         = useState('presenting');
  const [cat, setCat]           = useState('Academies');
  const [outcomes, setOutcomes] = useState(['Brand reach', 'Youth engagement']);
  const t = TIERS.find((x) => x.key === tier);
  const toggle = (o) => setOutcomes((prev) => prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]);

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

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {CATEGORIES.map((c) => (
          <TouchableOpacity key={c} onPress={() => setCat(c)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: c === cat ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: c === cat ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{c}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>SPONSORSHIP TIER</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {TIERS.map((x, i) => (
          <FloatingTierCard key={x.key} x={x} tier={tier} selected={x.key === tier} onPress={setTier} delay={i * 400} />
        ))}
      </View>

      <View style={[glass, { padding: 12, marginBottom: 12 }]}>
        <T style={{ color: palette.p3, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>WHAT YOU GET — {t.label.toUpperCase()}</T>
        <T style={{ color: 'rgba(255,255,255,0.78)', fontSize: 12, lineHeight: 18 }}>{t.rights}</T>
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>YOUR OBJECTIVES</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {OUTCOMES.map((o) => {
          const sel = outcomes.includes(o);
          return (
            <TouchableOpacity key={o} onPress={() => toggle(o)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: sel ? palette.p3 + '40' : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: sel ? palette.p3 : 'rgba(255,255,255,0.15)' }}>
              <T style={{ color: sel ? palette.p3 : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{o}</T>
            </TouchableOpacity>
          );
        })}
      </View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Become a sponsor →</T>
      </TouchableOpacity>
    </View>
  );
}
