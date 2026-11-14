import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const FORMATS = [
  { key: 'knockout',    label: 'Knockout',    desc: 'Single-elimination bracket. Lose once and you are out. Maximum drama.' },
  { key: 'league',      label: 'League',      desc: 'Full round-robin. Every team plays every other team once. Points table decides the champion.' },
  { key: 'round_robin', label: 'Round Robin', desc: 'Group stage then knockout. 4–6 teams per group, top 2 advance to knock-out rounds.' },
  { key: 'swiss',       label: 'Swiss',       desc: 'No eliminations. Paired by score after each round. Best record after N rounds wins.' },
];
const BRACKET = [
  ['Nadal Academy', 'Rafa Elite'],
  ['FC Barcelona B', 'Ajax Youth'],
  ['Mumbai CC', 'Chennai Stars'],
  ['Seoul Tigers', 'Tokyo Knights'],
];
const SPORTS = ['Tennis', 'Football', 'Cricket', 'Basketball', 'Badminton', 'Hockey'];

function ChapterHero() {
  const glow = useRef(new Animated.Value(0.3)).current;
  const bar  = useRef(new Animated.Value(0)).current;
  const titleScale = useRef(new Animated.Value(0.85)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(glow, { toValue: 0.8, duration: 1800, useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0.3, duration: 1800, useNativeDriver: true }),
    ])).start();
    Animated.timing(bar, { toValue: 1, duration: 600, delay: 200, useNativeDriver: false }).start();
    Animated.spring(titleScale, { toValue: 1.0, tension: 60, friction: 8, useNativeDriver: true }).start();
  }, []);
  const accent = 'rgba(255,180,0,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -8, left: -8, right: -8, bottom: -8, borderRadius: 36, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 28 }}>🏆</T>
        </View>
      </View>
      <Animated.View style={{ transform: [{ scale: titleScale }] }}>
        <T style={{ color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4, textAlign: 'center' }}>Matches & Tournaments</T>
      </Animated.View>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>Enter, organise and follow results across every format</T>
      <Animated.View style={{ height: 2, borderRadius: 1, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

export function ShowcaseMatches({ manifest, block, onNavigate }) {
  const [format, setFormat] = useState('knockout');
  const [sport, setSport]   = useState('Tennis');
  const f = FORMATS.find((x) => x.key === format);

  const bracketAnims = useRef(BRACKET.map(() => new Animated.Value(0))).current;
  const finalPulse   = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.stagger(80, bracketAnims.map((a) => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))).start();
    Animated.loop(Animated.sequence([
      Animated.timing(finalPulse, { toValue: 1.0, duration: 900, useNativeDriver: true }),
      Animated.timing(finalPulse, { toValue: 0.6, duration: 900, useNativeDriver: true }),
    ])).start();
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
          <TouchableOpacity key={s} onPress={() => setSport(s)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {FORMATS.map((x) => (
          <TouchableOpacity key={x.key} onPress={() => setFormat(x.key)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: x.key === format ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: x.key === format ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '600' }}>{x.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={[glass, { padding: 10, marginBottom: 12 }]}>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 18 }}>{f.desc}</T>
      </View>

      {format === 'knockout' && (
        <View style={{ marginBottom: 12 }}>
          <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>QUARTER-FINALS — {sport.toUpperCase()}</T>
          {BRACKET.map(([a, b], i) => {
            const isFinal = i === 0;
            return (
              <Animated.View
                key={i}
                style={{
                  opacity: bracketAnims[i],
                  transform: [{ translateY: bracketAnims[i].interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
                  flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6,
                }}>
                <Animated.View style={[{ flex: 1, padding: 8, borderRadius: 8, borderWidth: 1 }, isFinal ? { borderColor: 'rgba(255,180,0,0.5)', backgroundColor: 'rgba(255,180,0,0.08)', opacity: finalPulse } : { borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)' }]}>
                  <T style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>{a}</T>
                </Animated.View>
                <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700' }}>vs</T>
                <Animated.View style={[{ flex: 1, padding: 8, borderRadius: 8, borderWidth: 1 }, isFinal ? { borderColor: 'rgba(255,180,0,0.5)', backgroundColor: 'rgba(255,180,0,0.08)', opacity: finalPulse } : { borderColor: 'rgba(255,255,255,0.15)', backgroundColor: 'rgba(255,255,255,0.08)' }]}>
                  <T style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>{b}</T>
                </Animated.View>
              </Animated.View>
            );
          })}
        </View>
      )}

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Enter a tournament →</T>
      </TouchableOpacity>
    </View>
  );
}
