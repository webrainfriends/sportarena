import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
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

function PitchSvg({ sport }) {
  if (sport === 'Football') return (
    <Svg width="100%" height={90} viewBox="0 0 300 120">
      <Rect x="5" y="5" width="290" height="110" rx="4" fill="rgba(47,143,95,0.12)" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="150" y1="5" x2="150" y2="115" stroke={palette.p3} strokeWidth="1" />
      <Circle cx="150" cy="60" r="22" fill="none" stroke={palette.p3} strokeWidth="1" />
      <Rect x="5" y="38" width="40" height="44" fill="none" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <Rect x="255" y="38" width="40" height="44" fill="none" stroke="rgba(208,189,244,0.4)" strokeWidth="1" />
      <SvgText x="150" y="4" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8">TACTICAL VIEW</SvgText>
    </Svg>
  );
  return (
    <Svg width="100%" height={90} viewBox="0 0 300 120">
      <Rect x="5" y="5" width="290" height="110" rx="4" fill="rgba(132,88,179,0.12)" stroke={palette.p3} strokeWidth="1.5" />
      <Line x1="5" y1="60" x2="295" y2="60" stroke={palette.p3} strokeWidth="1" />
      <Line x1="150" y1="5" x2="150" y2="115" stroke={palette.p3} strokeWidth="1" />
      <SvgText x="150" y="4" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="8">TACTICAL VIEW — {sport.toUpperCase()}</SvgText>
    </Svg>
  );
}

export function ShowcaseCoaches({ manifest, block, onNavigate }) {
  const [sport, setSport] = useState('Tennis');
  const [tab, setTab]     = useState('plan');

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Coaching</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Expert coaches, real session plans, certified credentials</T>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS.map((s) => (
          <TouchableOpacity key={s} onPress={() => setSport(s)} style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {[['plan', 'Session plan'], ['pitch', 'Tactical'], ['creds', 'Credentials']].map(([t, lbl]) => (
          <TouchableOpacity key={t} onPress={() => setTab(t)} style={{ flex: 1, paddingVertical: 7, borderRadius: 10, backgroundColor: t === tab ? palette.p2 : 'rgba(255,255,255,0.08)', alignItems: 'center' }}>
            <T style={{ color: t === tab ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '700' }}>{lbl}</T>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'plan' && (
        <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
          {DEMO_SESSION.map((ph) => (
            <View key={ph.phase} style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
              <View style={{ width: 60, alignItems: 'center', paddingTop: 2 }}>
                <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700' }}>{ph.duration}</T>
              </View>
              <View style={{ flex: 1, padding: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }}>
                <T style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginBottom: 2 }}>{ph.phase}</T>
                <T style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, lineHeight: 16 }}>{ph.desc}</T>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {tab === 'pitch' && (
        <View style={{ padding: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
          <PitchSvg sport={sport} />
        </View>
      )}

      {tab === 'creds' && (
        <View style={{ gap: 6 }}>
          {CREDS.map((cr) => (
            <View key={cr} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 9, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
              <T style={{ color: palette.p3, fontSize: 16 }}>✓</T>
              <T style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' }}>{cr}</T>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ marginTop: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Find a {sport} coach →</T>
      </TouchableOpacity>
    </View>
  );
}
