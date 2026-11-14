import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
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

export function ShowcaseMatches({ manifest, block, onNavigate }) {
  const [format, setFormat] = useState('knockout');
  const [sport, setSport]   = useState('Tennis');
  const f = FORMATS.find((x) => x.key === format);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Matches & Tournaments</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Enter, organise and follow results across every format</T>

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

      <View style={{ padding: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', marginBottom: 12 }}>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 18 }}>{f.desc}</T>
      </View>

      {format === 'knockout' && (
        <View style={{ marginBottom: 12 }}>
          <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>QUARTER-FINALS — {sport.toUpperCase()}</T>
          {BRACKET.map(([a, b], i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <View style={{ flex: 1, padding: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
                <T style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>{a}</T>
              </View>
              <T style={{ color: palette.p3, fontSize: 10, fontWeight: '700' }}>vs</T>
              <View style={{ flex: 1, padding: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
                <T style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>{b}</T>
              </View>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Enter a tournament →</T>
      </TouchableOpacity>
    </View>
  );
}
