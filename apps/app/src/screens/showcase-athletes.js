import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { T } from '../ui';
import { palette } from '../theme';

const STAGES = [
  { key: 'profile',     label: 'Build profile',       icon: '👤', desc: 'Sport history, PBs, club affiliations, media uploads — your complete sporting identity in one place.' },
  { key: 'performance', label: 'Log performance',     icon: '📊', desc: 'GPS sessions, strength blocks, match stats synced from wearables. AI flags trend breaks and injury risk.' },
  { key: 'achievement', label: 'Record achievements', icon: '🏅', desc: 'Rankings, medals, records, qualifications — with verified provenance from the governing body.' },
  { key: 'scouting',    label: 'Get scouted',         icon: '🔭', desc: 'Discovery feed for 2 400+ academies and clubs. Opt-in visibility by sport, age and geography.' },
  { key: 'trials',      label: 'Apply to trials',     icon: '📋', desc: 'One-tap application to open trials. Academies see your verified profile before you arrive.' },
  { key: 'recruitment', label: 'Secure recruitment',  icon: '🤝', desc: 'Digital contract, guardian consent and payment schedule — from offer to enrolled in 24 hours.' },
];
const SPORTS = ['Tennis', 'Football', 'Cricket', 'Athletics', 'Swimming', 'Basketball', 'Badminton', 'Hockey'];

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
  const accent = 'rgba(132,88,179,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -10, left: -10, right: -10, bottom: -10, borderRadius: 42, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 32 }}>🏃</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 4, textAlign: 'center', letterSpacing: -0.5 }}>Athlete Profiles</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 14 }}>From discovery to international selection — one platform</T>
      <Animated.View style={{ height: 3, borderRadius: 2, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

export function ShowcaseAthletes({ manifest, block, onNavigate }) {
  const [stageIdx, setStageIdx] = useState(0);
  const [sport, setSport]       = useState('Tennis');
  const anim                    = useRef(new Animated.Value(1)).current;
  const progressAnim            = useRef(new Animated.Value(0)).current;
  const sportScale              = useRef(new Animated.Value(1)).current;
  const stage                   = STAGES[stageIdx];

  const anims = useRef(STAGES.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(55, anims.map((a) => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))).start();
    Animated.timing(progressAnim, { toValue: stageIdx / (STAGES.length - 1), duration: 400, useNativeDriver: false }).start();
  }, []);

  const go = (dir) => {
    const next = stageIdx + dir;
    if (next < 0 || next >= STAGES.length) return;
    Animated.sequence([
      Animated.timing(anim, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    Animated.timing(progressAnim, { toValue: next / (STAGES.length - 1), duration: 300, useNativeDriver: false }).start();
    setStageIdx(next);
  };

  const pickSport = (s) => {
    setSport(s);
    Animated.sequence([
      Animated.spring(sportScale, { toValue: 0.85, useNativeDriver: true, tension: 300, friction: 5 }),
      Animated.spring(sportScale, { toValue: 1.1, useNativeDriver: true, tension: 300, friction: 5 }),
      Animated.spring(sportScale, { toValue: 1.0, useNativeDriver: true, tension: 300, friction: 5 }),
    ]).start();
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

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS.map((s) => (
          <TouchableOpacity key={s} onPress={() => pickSport(s)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <Animated.View style={{ transform: [{ scale: s === sport ? sportScale : 1 }] }}>
              <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{s}</T>
            </Animated.View>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Animated progress bar */}
      <View style={{ height: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: 6, overflow: 'hidden' }}>
        <Animated.View style={{
          height: '100%',
          borderRadius: 4,
          backgroundColor: palette.p2,
          width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }} />
      </View>

      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 14 }}>
        {STAGES.map((s, i) => (
          <TouchableOpacity
            key={s.key}
            onPress={() => {
              Animated.timing(progressAnim, { toValue: i / (STAGES.length - 1), duration: 300, useNativeDriver: false }).start();
              Animated.sequence([
                Animated.timing(anim, { toValue: 0, duration: 80, useNativeDriver: true }),
                Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }),
              ]).start();
              setStageIdx(i);
            }}
            style={{ flex: 1, height: 3, borderRadius: 3, backgroundColor: i <= stageIdx ? palette.p2 : 'rgba(255,255,255,0.18)' }} />
        ))}
      </View>

      <Animated.View style={[glass, { opacity: anim, padding: 16, marginBottom: 14 }]}>
        <T style={{ fontSize: 28, marginBottom: 8 }}>{stage.icon}</T>
        <T style={{ color: palette.p3, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 }}>Stage {stageIdx + 1} of {STAGES.length}</T>
        <T style={{ color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 8 }}>{stage.label}</T>
        <T style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 19 }}>{stage.desc}</T>
      </Animated.View>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <TouchableOpacity onPress={() => go(-1)} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', opacity: stageIdx === 0 ? 0.4 : 1 }}>
          <T style={{ color: '#fff', fontWeight: '600' }}>← Prev</T>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => go(1)} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: stageIdx === STAGES.length - 1 ? palette.p2 : 'rgba(255,255,255,0.14)', alignItems: 'center' }}>
          <T style={{ color: '#fff', fontWeight: '600' }}>{stageIdx === STAGES.length - 1 ? 'Join free →' : 'Next →'}</T>
        </TouchableOpacity>
      </View>

      {stageIdx === STAGES.length - 1 && (
        <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
          <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Create your {sport} profile →</T>
        </TouchableOpacity>
      )}
    </View>
  );
}
