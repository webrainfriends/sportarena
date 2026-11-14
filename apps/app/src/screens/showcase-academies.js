import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, Animated, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { T } from '../ui';
import { palette } from '../theme';

const PERSONAS = [
  { key: 'director', label: 'Director', emoji: '🏫', desc: 'Manage every campus, programme, coach and revenue stream from one console. Real-time dashboards, board-ready reports, payroll.' },
  { key: 'parent',   label: 'Parent',   emoji: '👨‍👩‍👧', desc: "Track your child's attendance, progress and upcoming fixtures. Digital consent, secure messaging with coaches, invoice history." },
  { key: 'coach',    label: 'Coach',    emoji: '🏋️', desc: 'Session plans, athlete load monitoring, drills library, attendance, parent communications and CPD portfolio — all in one app.' },
];
const STEPS = [
  { label: 'Enrol',    desc: 'Fill the online form. Guardian consent captured digitally with biometric signature.' },
  { label: 'Consent',  desc: 'Smart consent covers data, media, medical sharing and travel — jurisdiction-aware.' },
  { label: 'Coaches',  desc: 'Assign athlete to group and 1-to-1 coaches based on sport, age and objective.' },
  { label: 'Calendar', desc: 'Term dates, competition fixtures, camps and trials synced to phone calendar.' },
  { label: 'Finance',  desc: 'Fee schedule, sibling discount, payment plan and tax receipt — zero admin.' },
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
  const accent = 'rgba(100,160,255,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -10, left: -10, right: -10, bottom: -10, borderRadius: 42, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 32 }}>🎓</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 4, textAlign: 'center', letterSpacing: -0.5 }}>Academies & Organisations</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 14 }}>Every campus, coach and student — one console</T>
      <Animated.View style={{ height: 3, borderRadius: 2, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

export function ShowcaseAcademies({ manifest, block, onNavigate }) {
  const [persona, setPersona] = useState('director');
  const [step, setStep]       = useState(0);
  const p = PERSONAS.find((x) => x.key === persona);

  const progressAnim = useRef(new Animated.Value(0)).current;
  const stepIconScale = useRef(new Animated.Value(1)).current;
  const descAnim = useRef(new Animated.Value(1)).current;

  const goStep = (i) => {
    Animated.timing(progressAnim, { toValue: i / (STEPS.length - 1), duration: 350, useNativeDriver: false }).start();
    Animated.sequence([
      Animated.spring(stepIconScale, { toValue: 1.2, tension: 200, friction: 5, useNativeDriver: true }),
      Animated.spring(stepIconScale, { toValue: 1.0, tension: 200, friction: 5, useNativeDriver: true }),
    ]).start();
    Animated.sequence([
      Animated.timing(descAnim, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(descAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setStep(i);
  };

  const switchPersona = (k) => {
    setPersona(k);
    goStep(0);
  };

  const glass = {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  };
const glassWeb = { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderRadius: 14 };
const CardWrap = Platform.OS === 'web'
  ? ({ children, style }) => React.createElement(View, { style: [glassWeb, { overflow: 'hidden' }, style] }, children)
  : ({ children, style }) => React.createElement(BlurView, { intensity: 12, tint: 'dark', style: [{ borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }, style] }, children);


  return (
    <View style={{ padding: 16, flex: 1 }}>
      <ChapterHero />

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {PERSONAS.map((x) => (
          <TouchableOpacity key={x.key} onPress={() => switchPersona(x.key)} style={[glass, { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 12, backgroundColor: x.key === persona ? palette.p2 : 'rgba(255,255,255,0.08)', borderColor: x.key === persona ? palette.p2 : 'rgba(255,255,255,0.15)' }]}>
            <T style={{ fontSize: 18, marginBottom: 2 }}>{x.emoji}</T>
            <T style={{ color: x.key === persona ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{x.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={[glass, { padding: 12, marginBottom: 12 }]}>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 18 }}>{p.desc}</T>
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6 }}>ENROLMENT JOURNEY</T>

      {/* Animated progress bar */}
      <View style={{ height: 3, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: 8, overflow: 'hidden' }}>
        <Animated.View style={{
          height: '100%', borderRadius: 3, backgroundColor: palette.p2,
          width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }} />
      </View>

      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
        {STEPS.map((s, i) => (
          <TouchableOpacity key={s.label} onPress={() => goStep(i)} style={{ flex: 1, alignItems: 'center' }}>
            <Animated.View style={{
              width: 28, height: 28, borderRadius: 14,
              backgroundColor: i === step ? palette.p2 : i < step ? palette.p3 + '55' : 'rgba(255,255,255,0.12)',
              alignItems: 'center', justifyContent: 'center', marginBottom: 4,
              transform: [{ scale: i === step ? stepIconScale : 1 }],
            }}>
              <T style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{i + 1}</T>
            </Animated.View>
            <T style={{ color: i === step ? palette.p3 : 'rgba(255,255,255,0.35)', fontSize: 9, textAlign: 'center' }}>{s.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <Animated.View style={[glass, { padding: 12, marginBottom: 12, opacity: descAnim, backgroundColor: 'rgba(132,88,179,0.18)', borderColor: 'rgba(208,189,244,0.25)' }]}>
        <T style={{ color: palette.p3, fontWeight: '700', fontSize: 13, marginBottom: 4 }}>{STEPS[step].label}</T>
        <T style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: 18 }}>{STEPS[step].desc}</T>
      </Animated.View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Explore academies →</T>
      </TouchableOpacity>
    </View>
  );
}
