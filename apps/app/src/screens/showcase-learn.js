import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
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

export function ShowcaseLearn({ manifest, block, onNavigate }) {
  const [role, setRole] = useState('athlete');
  const [obj, setObj]   = useState('Performance analytics');
  const objs            = OBJECTIVES[role] || [];
  const levelIdx        = Math.min(objs.indexOf(obj) + 1, LEVELS.length - 1);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Learn & Develop</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Courses, certifications and career pathways in sport</T>

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
        {objs.map((o) => (
          <TouchableOpacity key={o} onPress={() => setObj(o)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: o === obj ? palette.p2 : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: o === obj ? palette.p2 : 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: o === obj ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{o}</T>
          </TouchableOpacity>
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
