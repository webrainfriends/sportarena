import React, { useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const DEFAULT_SPORTS = ['Football', 'Cricket', 'Tennis', 'Basketball', 'Badminton'];

const STAGES = [
  { key: 'profile',     label: 'Profile',     icon: '👤', desc: 'Build a verified athlete profile with stats, media and bio.' },
  { key: 'performance', label: 'Performance', icon: '📊', desc: 'Log training data, match performance and progress metrics.', metrics: ['Speed', 'Agility', 'Strength', 'Endurance'] },
  { key: 'achievement', label: 'Achievement', icon: '🏅', desc: 'Showcase verified trophies, records and milestones.' },
  { key: 'scouting',    label: 'Scouting',    icon: '🔭', desc: 'Get shortlisted by coaches and academies based on your data.' },
  { key: 'trials',      label: 'Trials',      icon: '📋', desc: 'Apply to open trials and receive structured feedback.' },
  { key: 'recruitment', label: 'Recruitment', icon: '🤝', desc: 'Convert interest into contracts or academy placements.' },
];

export function ShowcaseAthletes({ block, manifest, onCta }) {
  const sports = block?.config?.sport_options ?? DEFAULT_SPORTS;
  const [sport, setSport] = useState(sports[0] ?? 'Football');
  const [stageIdx, setStageIdx] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const switchStage = (idx) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }).start(() => {
      setStageIdx(idx);
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const stage = STAGES[stageIdx];

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Athletes</T>

      {/* Sport selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {sports.map((s) => {
          const sel = sport === s;
          return (
            <Pressable key={s} onPress={() => setSport(s)} accessibilityRole="button" accessibilityLabel={s} accessibilityState={{ selected: sel }}>
              <View style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{s}</T>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Journey stage rail */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 0 }}>
        {STAGES.map((s, i) => {
          const sel = i === stageIdx;
          return (
            <Pressable key={s.key} onPress={() => switchStage(i)} accessibilityRole="button" accessibilityLabel={s.label} accessibilityState={{ selected: sel }}
              style={{ alignItems: 'center', paddingHorizontal: 4 }}>
              <View style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: r.card, backgroundColor: sel ? c.pinkSoft : 'transparent', minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <T size={18}>{s.icon}</T>
                <T size={11} weight={sel ? '700' : '500'} color={sel ? c.pink : c.mute}>{s.label}</T>
              </View>
              {i < STAGES.length - 1 && <View style={{ position: 'absolute', end: -2, top: 22, width: 8, height: 1, backgroundColor: c.line }} />}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Stage detail card */}
      <Animated.View style={{ opacity: fadeAnim }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
              <T size={22}>{stage.icon}</T>
            </View>
            <T weight="800" size={18}>{stage.label}</T>
          </View>
          <T size={14} color={c.mute} style={{ lineHeight: 21, marginBottom: 12 }}>{stage.desc}</T>
          {stage.metrics && (
            <View style={{ gap: 10 }}>
              {stage.metrics.map((m, i) => (
                <View key={m}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <T size={12} weight="600" color={c.mute}>{m}</T>
                    <T size={12} weight="600" color={c.pink}>{[82, 71, 76, 68][i]}%</T>
                  </View>
                  <View style={{ height: 6, backgroundColor: c.line, borderRadius: 3 }}>
                    <View style={{ width: `${[82, 71, 76, 68][i]}%`, height: 6, backgroundColor: c.pink, borderRadius: 3 }} />
                  </View>
                </View>
              ))}
            </View>
          )}
        </Card>
      </Animated.View>

      <Btn title="Find athletes →" onPress={() => onCta('athlete-discovery')} />
    </View>
  );
}
