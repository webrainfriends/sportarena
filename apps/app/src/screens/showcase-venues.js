import React, { useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Svg, Rect, Circle, Line, Text as SvgText, Path } from 'react-native-svg';
import { T } from '../ui';
import { palette } from '../theme';

const SPORTS_LIST = ['Tennis', 'Football', 'Basketball', 'Cricket', 'Badminton', 'Squash', 'Hockey', 'Swimming'];
const SURFACES = {
  Tennis:     ['Hard court', 'Clay', 'Grass', 'Carpet'],
  Football:   ['Natural grass', 'Artificial turf', 'Hybrid'],
  Basketball: ['Hardwood', 'Synthetic'],
  Cricket:    ['Natural pitch', 'Drop-in pitch'],
  Badminton:  ['Synthetic', 'Wooden'],
  Squash:     ['Glass back', 'Hardwood'],
  Hockey:     ['Astroturf', 'Water-based'],
  Swimming:   ['50 m Olympic', '25 m pool'],
};
const TIME_SLOTS = ['Morning (6–10 am)', 'Afternoon (12–4 pm)', 'Evening (5–9 pm)'];
const STEPS = ['Select sport', 'Pick a slot', 'Capacity', 'Confirm'];

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
  const accent = 'rgba(0,180,160,0.4)';
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 16 }}>
      <View style={{ position: 'relative', marginBottom: 12 }}>
        <Animated.View style={{ position: 'absolute', top: -10, left: -10, right: -10, bottom: -10, borderRadius: 42, backgroundColor: accent, opacity: glow }} />
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
          <T style={{ fontSize: 32 }}>🏟️</T>
        </View>
      </View>
      <T style={{ color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 4, textAlign: 'center', letterSpacing: -0.5 }}>Venues & Courts</T>
      <T style={{ color: 'rgba(208,189,244,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 14 }}>Find, compare and book sport venues near you</T>
      <Animated.View style={{ height: 3, borderRadius: 2, backgroundColor: accent, width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
    </View>
  );
}

function TennisCourt({ drawAnim }) {
  return (
    <Svg width="100%" height={110} viewBox="0 0 320 130">
      <Rect x="10" y="10" width="300" height="110" rx="4" fill="rgba(132,88,179,0.12)" stroke={palette.p3} strokeWidth="2" />
      <Line x1="10" y1="65" x2="310" y2="65" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="160" y1="10" x2="160" y2="120" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="10" y1="38" x2="310" y2="38" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Line x1="10" y1="92" x2="310" y2="92" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Line x1="80" y1="10" x2="80" y2="120" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Line x1="240" y1="10" x2="240" y2="120" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Circle cx="160" cy="65" r="4" fill={palette.p2} />
      <SvgText x="160" y="8" textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize="8">TENNIS COURT</SvgText>
    </Svg>
  );
}

function FootballPitch() {
  return (
    <Svg width="100%" height={110} viewBox="0 0 320 130">
      <Rect x="10" y="10" width="300" height="110" rx="4" fill="rgba(47,143,95,0.12)" stroke={palette.p3} strokeWidth="2" />
      <Line x1="160" y1="10" x2="160" y2="120" stroke={palette.p3} strokeWidth="1.5" />
      <Circle cx="160" cy="65" r="24" fill="none" stroke={palette.p3} strokeWidth="1.5" />
      <Rect x="10" y="43" width="44" height="44" fill="none" stroke="rgba(208,189,244,0.5)" strokeWidth="1" />
      <Rect x="266" y="43" width="44" height="44" fill="none" stroke="rgba(208,189,244,0.5)" strokeWidth="1" />
      <SvgText x="160" y="8" textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize="8">FOOTBALL PITCH</SvgText>
    </Svg>
  );
}

function BasketballCourt() {
  return (
    <Svg width="100%" height={110} viewBox="0 0 320 130">
      <Rect x="10" y="10" width="300" height="110" rx="4" fill="rgba(214,119,6,0.12)" stroke={palette.p3} strokeWidth="2" />
      <Line x1="160" y1="10" x2="160" y2="120" stroke={palette.p3} strokeWidth="1.5" />
      <Circle cx="160" cy="65" r="20" fill="none" stroke={palette.p3} strokeWidth="1.5" />
      <Rect x="10" y="38" width="60" height="54" rx="2" fill="none" stroke="rgba(208,189,244,0.5)" strokeWidth="1" />
      <Rect x="250" y="38" width="60" height="54" rx="2" fill="none" stroke="rgba(208,189,244,0.5)" strokeWidth="1" />
      <SvgText x="160" y="8" textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize="8">BASKETBALL COURT</SvgText>
    </Svg>
  );
}

export function ShowcaseVenues({ manifest, block, onNavigate }) {
  const [sport, setSport]     = useState('Tennis');
  const [step, setStep]       = useState(0);
  const [slot, setSlot]       = useState(null);
  const [capacity, setCap]    = useState(8);
  const [confirmed, setConf]  = useState(false);
  const checkScale            = useRef(new Animated.Value(0)).current;
  const stepAnim              = useRef(new Animated.Value(1)).current;

  const goStep = (next) => {
    Animated.sequence([
      Animated.timing(stepAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(stepAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setStep(next);
    if (next === 3) {
      setConf(false);
    }
  };

  const confirmBooking = () => {
    setConf(true);
    checkScale.setValue(0);
    Animated.spring(checkScale, { toValue: 1, tension: 60, friction: 6, useNativeDriver: true }).start();
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


  const CourtSvg = sport === 'Football' ? FootballPitch : sport === 'Basketball' ? BasketballCourt : TennisCourt;

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <ChapterHero />

      {/* Step indicator */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 14 }}>
        {STEPS.map((s, i) => (
          <TouchableOpacity key={s} onPress={() => goStep(i)} style={{ flex: 1 }}>
            <View style={{ height: 3, borderRadius: 3, backgroundColor: i <= step ? palette.p2 : 'rgba(255,255,255,0.18)' }} />
            <T style={{ color: i === step ? palette.p3 : 'rgba(255,255,255,0.3)', fontSize: 9, marginTop: 3, textAlign: 'center' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </View>

      <Animated.View style={{ opacity: stepAnim }}>
        {/* Step 0: sport picker + court */}
        {step === 0 && (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
              {SPORTS_LIST.map((s) => (
                <TouchableOpacity key={s} onPress={() => { setSport(s); goStep(1); }} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
                  <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' }}>{s}</T>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={[glass, { padding: 10, marginBottom: 10 }]}>
              <CourtSvg />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
              {(SURFACES[sport] || []).map((s) => (
                <View key={s} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: 'rgba(160,210,235,0.15)', borderWidth: 1, borderColor: 'rgba(160,210,235,0.3)' }}>
                  <T style={{ color: palette.p4, fontSize: 11, fontWeight: '600' }}>{s}</T>
                </View>
              ))}
            </ScrollView>
          </>
        )}

        {/* Step 1: time slot */}
        {step === 1 && (
          <View>
            <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginBottom: 10 }}>Select a time slot for your {sport} session:</T>
            {TIME_SLOTS.map((t) => (
              <TouchableOpacity key={t} onPress={() => { setSlot(t); goStep(2); }} style={[glass, { padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderColor: slot === t ? palette.p2 : 'rgba(255,255,255,0.12)' }]}>
                <T style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{t}</T>
                {slot === t && <T style={{ color: palette.p3, fontSize: 16 }}>✓</T>}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Step 2: capacity stepper */}
        {step === 2 && (
          <View>
            <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginBottom: 16 }}>How many players?</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 20 }}>
              <TouchableOpacity onPress={() => setCap((c) => Math.max(1, c - 1))} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>−</T>
              </TouchableOpacity>
              <T style={{ color: '#fff', fontSize: 36, fontWeight: '800', minWidth: 50, textAlign: 'center' }}>{capacity}</T>
              <TouchableOpacity onPress={() => setCap((c) => Math.min(20, c + 1))} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: palette.p2, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>+</T>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => goStep(3)} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
              <T style={{ color: '#fff', fontWeight: '700' }}>Review booking →</T>
            </TouchableOpacity>
          </View>
        )}

        {/* Step 3: review + confirm */}
        {step === 3 && (
          <View>
            <View style={[glass, { padding: 16, marginBottom: 12 }]}>
              <T style={{ color: palette.p3, fontWeight: '700', fontSize: 13, marginBottom: 10 }}>BOOKING SUMMARY</T>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Sport</T>
                  <T style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{sport}</T>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Time slot</T>
                  <T style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{slot || '—'}</T>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Players</T>
                  <T style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{capacity}</T>
                </View>
              </View>
            </View>
            {confirmed ? (
              <View style={{ alignItems: 'center', paddingVertical: 16 }}>
                <Animated.View style={{ transform: [{ scale: checkScale }] }}>
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(80,200,120,0.3)', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'rgba(80,200,120,0.6)' }}>
                    <T style={{ color: '#5fc878', fontSize: 28 }}>✓</T>
                  </View>
                </Animated.View>
                <T style={{ color: '#5fc878', fontSize: 14, fontWeight: '700', marginTop: 10 }}>Booking confirmed!</T>
              </View>
            ) : (
              <TouchableOpacity onPress={confirmBooking} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
                <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Confirm booking →</T>
              </TouchableOpacity>
            )}
          </View>
        )}
      </Animated.View>

      {step !== 3 && (
        <TouchableOpacity onPress={() => onNavigate?.('venue-discovery')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', marginTop: 10 }}>
          <T style={{ color: 'rgba(255,255,255,0.7)', fontWeight: '600', fontSize: 13 }}>Browse all venues →</T>
        </TouchableOpacity>
      )}
    </View>
  );
}
