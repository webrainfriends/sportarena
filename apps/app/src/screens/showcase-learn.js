import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Svg, Circle as SvgCircle, Line as SvgLine } from 'react-native-svg';
import { T } from '../ui';
import { palette } from '../theme';

const ROLES = [
  { key: 'athlete',  label: 'Athlete',       emoji: '🏃' },
  { key: 'coach',    label: 'Coach',         emoji: '👨‍🏫' },
  { key: 'official', label: 'Official',      emoji: '🏁' },
  { key: 'manager',  label: 'Team manager',  emoji: '📋' },
  { key: 'admin',    label: 'Administrator', emoji: '🏛' },
];
const OBJECTIVES = {
  athlete:  ['Performance analytics', 'Strength & conditioning', 'Mental resilience', 'Nutrition science', 'Sports law', 'Doping regulations'],
  coach:    ['Periodisation', 'Tactical frameworks', 'Athlete psychology', 'Safeguarding', 'Video analysis', 'CPD portfolio'],
  official: ['Laws of the sport', 'VAR/technology', 'Fitness standards', 'Communication', 'Ethics & integrity', 'Appointment system'],
  manager:  ['Budget & finance', 'Contracts', 'Travel logistics', 'Media relations', 'Player welfare', 'Federation rules'],
  admin:    ['Governance', 'Commercial rights', 'Event management', 'Digital transformation', 'HR & recruitment', 'Compliance'],
};
const LEVELS = ['Foundation', 'Intermediate', 'Advanced', 'Professional', 'Elite'];

const CONSTELLATION = [
  { cx: 30, cy: 30 }, { cx: 70, cy: 20 }, { cx: 110, cy: 40 },
  { cx: 150, cy: 15 }, { cx: 190, cy: 35 }, { cx: 230, cy: 20 },
  { cx: 270, cy: 40 }, { cx: 310, cy: 25 },
];
const LINES = [
  [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[1,3],[3,5],
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
  const accent = 'rgba(180,120,255,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -10, left: -10, right: -10, bottom: -10, borderRadius: 42, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 32 }}>📚</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 4, textAlign: 'center', letterSpacing: -0.5 }}>Learn & Develop</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 14 }}>Courses, certifications and career pathways in sport</T>
      <Animated.View style={{ height: 3, borderRadius: 2, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

function ConstellationView() {
  const starAnims = useRef(CONSTELLATION.map(() => new Animated.Value(0.4))).current;
  useEffect(() => {
    starAnims.forEach((a, i) => {
      Animated.loop(Animated.sequence([
        Animated.delay(i * 300),
        Animated.timing(a, { toValue: 1.0, duration: 1200, useNativeDriver: true }),
        Animated.timing(a, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
      ])).start();
    });
  }, []);

  return (
    <View style={{ height: 60, marginBottom: 12, overflow: 'hidden' }}>
      <Svg width="100%" height={60} viewBox="0 0 320 60">
        {LINES.map(([a, b], i) => (
          <SvgLine
            key={i}
            x1={CONSTELLATION[a].cx} y1={CONSTELLATION[a].cy}
            x2={CONSTELLATION[b].cx} y2={CONSTELLATION[b].cy}
            stroke="rgba(208,189,244,0.25)" strokeWidth="1"
          />
        ))}
        {CONSTELLATION.map((s, i) => (
          <SvgCircle key={i} cx={s.cx} cy={s.cy} r="3" fill={palette.p3} opacity={0.6} />
        ))}
      </Svg>
      {/* Animated glow stars layered over SVG */}
      {starAnims.map((a, i) => (
        <Animated.View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: `${(CONSTELLATION[i].cx / 320) * 100}%`,
            top: `${(CONSTELLATION[i].cy / 60) * 100}%`,
            width: 6, height: 6, borderRadius: 3,
            backgroundColor: palette.p3,
            marginLeft: -3, marginTop: -3,
            opacity: a,
          }}
        />
      ))}
    </View>
  );
}

export function ShowcaseLearn({ manifest, block, onNavigate }) {
  const [role, setRole] = useState('athlete');
  const [obj, setObj]   = useState('Performance analytics');
  const objs            = OBJECTIVES[role] || [];
  const levelIdx        = Math.min(objs.indexOf(obj) + 1, LEVELS.length - 1);

  const objAnims = useRef(Array(6).fill(0).map(() => new Animated.Value(0))).current;
  useEffect(() => {
    objAnims.forEach((a) => a.setValue(0));
    Animated.stagger(55, objAnims.map((a) => Animated.timing(a, { toValue: 1, duration: 280, useNativeDriver: true }))).start();
  }, [role]);

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

      <ConstellationView />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {ROLES.map((r) => (
          <TouchableOpacity key={r.key} onPress={() => { setRole(r.key); setObj(OBJECTIVES[r.key][0]); }} style={{ alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: r.key === role ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ fontSize: 18, marginBottom: 2 }}>{r.emoji}</T>
            <T style={{ color: r.key === role ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 10, fontWeight: '600' }}>{r.label}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>LEARNING OBJECTIVES</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {objs.map((o, i) => (
          <Animated.View
            key={o}
            style={{
              opacity: objAnims[Math.min(i, objAnims.length - 1)],
              transform: [{ translateY: objAnims[Math.min(i, objAnims.length - 1)].interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
            }}>
            <TouchableOpacity onPress={() => setObj(o)} style={[glass, { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: o === obj ? palette.p2 : 'rgba(255,255,255,0.07)', borderColor: o === obj ? palette.p2 : 'rgba(255,255,255,0.15)' }]}>
              <T style={{ color: o === obj ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{o}</T>
            </TouchableOpacity>
          </Animated.View>
        ))}
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>CAREER PATHWAY — {obj.toUpperCase()}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 14 }}>
        {LEVELS.map((lv, i) => (
          <React.Fragment key={lv}>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= levelIdx ? palette.p2 : 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <T style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{i + 1}</T>
              </View>
              <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 8, textAlign: 'center' }}>{lv}</T>
            </View>
            {i < LEVELS.length - 1 && (
              <View style={{ width: 12, height: 2, backgroundColor: i < levelIdx ? palette.p3 : 'rgba(255,255,255,0.15)', marginBottom: 16 }} />
            )}
          </React.Fragment>
        ))}
      </View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Start learning →</T>
      </TouchableOpacity>
    </View>
  );
}
