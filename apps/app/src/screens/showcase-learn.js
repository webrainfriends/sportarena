import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const ROLES = ['Athlete', 'Coach', 'Referee', 'Manager'];

const ROLE_OBJECTIVES = {
  Athlete: ['Earn a scholarship', 'Degree in Sport Science', 'Elite pathway', 'Nutrition & Recovery'],
  Coach: ['Get UEFA licence', 'Sports psychology', 'Talent ID course', 'Academy management'],
  Referee: ['Officiating licence', 'Laws of the game', 'Fitness standards', 'Video review training'],
  Manager: ['FA Youth award', 'Leadership & comms', 'Club operations', 'Finance & governance'],
};

const ROLE_PATHWAYS = {
  Athlete: ['Sport Science BSc', 'Elite Academy', 'Scholarship Fund', 'Nutrition Certificate', 'Psychology Diploma', 'Performance Analysis'],
  Coach: ['UEFA B Licence', 'FA Youth Award', 'Sports Psychology', 'Academy Management', 'Talent ID Course', 'Video Analysis'],
  Referee: ['FA Referee Licence', 'Laws of the Game', 'Video Review', 'Fitness Programme', 'Match Assessor', 'Elite Panel'],
  Manager: ['FA Youth Award', 'Club Leadership', 'Operations Cert', 'Finance Course', 'Governance Module', 'Media & Comms'],
};

export function ShowcaseLearn({ block, manifest, onCta }) {
  const [role, setRole] = useState('Athlete');
  const [objective, setObjective] = useState(ROLE_OBJECTIVES['Athlete'][0]);
  const pathways = ROLE_PATHWAYS[role];

  const handleRoleChange = (r) => {
    setRole(r);
    setObjective(ROLE_OBJECTIVES[r][0]);
  };

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Learn & Study</T>

      {/* Role selector */}
      <View style={{ flexDirection: 'row', backgroundColor: c.line, borderRadius: r.pill, padding: 3, gap: 2 }}>
        {ROLES.map((rl) => {
          const sel = role === rl;
          return (
            <Pressable key={rl} onPress={() => handleRoleChange(rl)} accessibilityRole="button" accessibilityLabel={rl} accessibilityState={{ selected: sel }} style={{ flex: 1 }}>
              <View style={{ paddingVertical: 10, borderRadius: r.pill, backgroundColor: sel ? c.paper : 'transparent', alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
                <T size={12} weight="700" color={sel ? c.pink : c.mute}>{rl}</T>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Objective chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {ROLE_OBJECTIVES[role].map((obj) => {
          const sel = objective === obj;
          return (
            <Pressable key={obj} onPress={() => setObjective(obj)} accessibilityRole="button" accessibilityLabel={obj} accessibilityState={{ selected: sel }}>
              <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.violet : c.paper, borderWidth: 1, borderColor: sel ? c.violet : c.line, minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{obj}</T>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Pathway constellation grid */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Pathway constellation · {role}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {pathways.map((path, i) => {
            const isHighlighted = i < 2;
            return (
              <View key={path} style={{ width: '45%', backgroundColor: isHighlighted ? c.pinkSoft : c.violetSoft, borderRadius: r.card, padding: 12, borderWidth: isHighlighted ? 2 : 1, borderColor: isHighlighted ? c.pink : c.line, gap: 4 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isHighlighted ? c.pink : c.mute, marginBottom: 4 }} />
                <T size={12} weight="700" color={isHighlighted ? c.pink : c.ink}>{path}</T>
                {isHighlighted && <T size={10} color={c.mute}>Recommended for {role}</T>}
              </View>
            );
          })}
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 10 }}>Only source-verified, published listings shown. No fake certifications.</T>
      </Card>

      <Btn title="Explore learning →" onPress={() => onCta('learning-discovery')} />
    </View>
  );
}
