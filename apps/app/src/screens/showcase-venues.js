import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
import { Svg, Rect, Circle, Line, Text as SvgText } from 'react-native-svg';
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
const AMENITIES = ['Floodlights', 'Changing rooms', 'Parking', 'Café', 'Physio room', 'Video analysis'];
const STEPS = ['Select sport', 'Choose venue', 'Pick a slot', 'Confirm booking'];

function TennisCourt() {
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
  const [amenities, setAm]    = useState(['Floodlights', 'Changing rooms']);

  const toggleAm = (a) => setAm((prev) => prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]);

  const CourtSvg = sport === 'Football' ? FootballPitch : sport === 'Basketball' ? BasketballCourt : TennisCourt;

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Venues & Courts</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Find, compare and book sport venues near you</T>

      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 14 }}>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1 }}>
            <View style={{ height: 3, borderRadius: 3, backgroundColor: i <= step ? palette.p2 : 'rgba(255,255,255,0.18)' }} />
            <T style={{ color: i === step ? palette.p3 : 'rgba(255,255,255,0.3)', fontSize: 9, marginTop: 3, textAlign: 'center' }}>{s}</T>
          </View>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS_LIST.map((s) => (
          <TouchableOpacity key={s} onPress={() => { setSport(s); setStep(1); }} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={{ marginBottom: 12, padding: 10, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
        <CourtSvg />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {(SURFACES[sport] || []).map((s) => (
          <View key={s} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: 'rgba(160,210,235,0.15)', borderWidth: 1, borderColor: 'rgba(160,210,235,0.3)' }}>
            <T style={{ color: palette.p4, fontSize: 11, fontWeight: '600' }}>{s}</T>
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity onPress={() => onNavigate?.('venue-discovery')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center', marginTop: 4 }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Book a {sport} venue →</T>
      </TouchableOpacity>
    </View>
  );
}
