import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { Svg, Rect, Line, Circle, Text as SvgText } from 'react-native-svg';
import { T } from '../ui';
import { palette } from '../theme';

const SPORTS = ['Tennis', 'Football', 'Cricket', 'Basketball', 'Swimming'];
const CREDS = ['Level 4 Head Coach', 'ITF Licensed', 'Sports Science MSc', 'First Aid & Safeguarding'];
const DEMO_SESSION = [
  { phase: 'Warm-up',   duration: '15 min', desc: 'Dynamic mobility, sport-specific movement patterns, reaction drills.' },
  { phase: 'Technical', duration: '30 min', desc: 'Forehand mechanics: open-stance baseline to cross-court winner — video feedback loop.' },
  { phase: 'Tactical',  duration: '25 min', desc: 'Point construction from deuce court — building to pattern 3 finish.' },
  { phase: 'Cool-down', duration: '10 min', desc: 'Static stretch, breathing protocol, session debrief & metrics review.' },
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
  const accent = 'rgba(80,220,120,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>📋</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Coaching</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Expert coaches, real session plans, certified credentials</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

function PitchSvg({ sport, dotX, dotY }) {
  if (sport === 'Football') return (
    <Svg width="100%" height={90} viewBox="0 0 300 120">
      <Rect x="5" y="5" width="290" height="110" rx="4" fill="rgba(47,143,95,0.12)" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="150" y1="5" x2="150" y2="115" stroke={palette.p3} strokeWidth="1" />
      <Circle cx="150" cy="60" r="22" fill="none" stroke={palette.p3} strokeWidth="1" />
      <Rect x="5" y="38" width="40" height="44" fill="none" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Rect x="255" y="38" width="40" height="44" fill="none" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <SvgText x="150" y="4" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8">TACTICAL VIEW</SvgText>
      <Circle cx={dotX} cy={dotY} r="5" fill={palette.p2} />
    </Svg>
  );
  return (
    <Svg width="100%" height={90} viewBox="0 0 300 120">
      <Rect x="5" y="5" width="290" height="110" rx="4" fill="rgba(132,88,179,0.12)" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="5" y1="60" x2="295" y2="60" stroke={palette.p3} strokeWidth="1" />
      <Line x1="150" y1="5" x2="150" y2="115" stroke={palette.p3} strokeWidth="1" />
      <SvgText x="150" y="4" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8">TACTICAL VIEW — {sport.toUpperCase()}</SvgText>
      <Circle cx={dotX} cy={dotY} r="5" fill={palette.p2} />
    </Svg>
  );
}

export function ShowcaseCoaches({ manifest, block, onNavigate }) {
  const [sport, setSport] = useState('Tennis');
  const [tab, setTab]     = useState('plan');
  const tabAnim           = useRef(new Animated.Value(1)).current;

  // Animated player dot on pitch
  const dotX = useRef(new Animated.Value(50)).current;
  const dotY = useRef(new Animated.Value(60)).current;
  const dotLoop = useRef(null);

  useEffect(() => {
    const path = sport === 'Football'
      ? [[50,60],[150,30],[250,60],[150,90],[50,60]]
      : [[50,60],[150,30],[250,60],[150,90],[50,60]];
    const steps = path.flatMap(([x, y]) => [
      Animated.timing(dotX, { toValue: x, duration: 600, useNativeDriver: false }),
      Animated.timing(dotY, { toValue: y, duration: 600, useNativeDriver: false }),
    ]);
    if (dotLoop.current) dotLoop.current.stop();
    dotLoop.current = Animated.loop(Animated.sequence(steps));
    dotLoop.current.start();
    return () => dotLoop.current && dotLoop.current.stop();
  }, [sport]);

  const switchTab = (t) => {
    Animated.sequence([
      Animated.timing(tabAnim, { toValue: 0, duration: 80, useNativeDriver: true }),
      Animated.timing(tabAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setTab(t);
  };

  const anims = useRef(DEMO_SESSION.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(55, anims.map((a) => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))).start();
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

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS.map((s) => (
          <TouchableOpacity key={s} onPress={() => setSport(s)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {[['plan', 'Session plan'], ['pitch', 'Tactical'], ['creds', 'Credentials']].map(([t, lbl]) => (
          <TouchableOpacity key={t} onPress={() => switchTab(t)} style={{ flex: 1, paddingVertical: 7, borderRadius: 10, backgroundColor: t === tab ? palette.p2 : 'rgba(255,255,255,0.08)', alignItems: 'center' }}>
            <T style={{ color: t === tab ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '700' }}>{lbl}</T>
          </TouchableOpacity>
        ))}
      </View>

      <Animated.View style={{ opacity: tabAnim }}>
        {tab === 'plan' && (
          <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
            {DEMO_SESSION.map((ph, i) => (
              <Animated.View
                key={ph.phase}
                style={{
                  opacity: anims[i],
                  transform: [{ translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
                  flexDirection: 'row', gap: 10, marginBottom: 8,
                }}>
                <View style={{ width: 60, alignItems: 'center', paddingTop: 2 }}>
                  <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700' }}>{ph.duration}</T>
                </View>
                <View style={[glass, { flex: 1, padding: 8 }]}>
                  <T style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginBottom: 2 }}>{ph.phase}</T>
                  <T style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, lineHeight: 16 }}>{ph.desc}</T>
                </View>
              </Animated.View>
            ))}
          </ScrollView>
        )}

        {tab === 'pitch' && (
          <View style={[glass, { padding: 10 }]}>
            <PitchSvg sport={sport} dotX={dotX} dotY={dotY} />
            <T style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, textAlign: 'center', marginTop: 4 }}>Animated player movement</T>
          </View>
        )}

        {tab === 'creds' && (
          <View style={{ gap: 6 }}>
            {CREDS.map((cr, i) => (
              <Animated.View
                key={cr}
                style={{
                  opacity: anims[Math.min(i, anims.length - 1)],
                  transform: [{ translateY: anims[Math.min(i, anims.length - 1)].interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
                }}>
                <View style={[glass, { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 9 }]}>
                  <T style={{ color: palette.p3, fontSize: 16 }}>✓</T>
                  <T style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' }}>{cr}</T>
                </View>
              </Animated.View>
            ))}
          </View>
        )}
      </Animated.View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ marginTop: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Find a {sport} coach →</T>
      </TouchableOpacity>
    </View>
  );
}
