import React, { useState, useRef } from 'react';
import { View, TouchableOpacity, ScrollView, Animated } from 'react-native';
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

export function ShowcaseAthletes({ manifest, block, onNavigate }) {
  const [stageIdx, setStageIdx] = useState(0);
  const [sport, setSport]       = useState('Tennis');
  const anim                    = useRef(new Animated.Value(1)).current;
  const stage                   = STAGES[stageIdx];

  const go = (dir) => {
    const next = stageIdx + dir;
    if (next < 0 || next >= STAGES.length) return;
    Animated.sequence([
      Animated.timing(anim, { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setStageIdx(next);
  };

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Athlete Profiles</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 14 }}>From discovery to international selection — one platform</T>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ gap: 6, flexDirection: 'row' }}>
        {SPORTS.map((s) => (
          <TouchableOpacity key={s} onPress={() => setSport(s)} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: s === sport ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ color: s === sport ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>{s}</T>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 14 }}>
        {STAGES.map((s, i) => (
          <TouchableOpacity
            key={s.key}
            onPress={() => { anim.setValue(0); setStageIdx(i); Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }}
            style={{ flex: 1, height: 3, borderRadius: 3, backgroundColor: i <= stageIdx ? palette.p2 : 'rgba(255,255,255,0.18)' }} />
        ))}
      </View>

      <Animated.View style={{ opacity: anim, padding: 16, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', marginBottom: 14 }}>
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
