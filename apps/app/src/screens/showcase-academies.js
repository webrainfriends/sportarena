import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const PERSONAS = ['Academy Director', 'Parent', 'Coach'];
const STEPS = ['Enroll', 'Consent', 'Assign Coach', 'Calendar', 'Finance'];

const PERSONA_DETAILS = {
  'Academy Director': [
    'Set up programmes, age groups and fees',
    'Configure guardian consent workflows',
    'Assign coaches and manage staff rosters',
    'Publish term calendars and session schedules',
    'Oversee billing, payroll and revenue reports',
  ],
  Parent: [
    'Browse programmes and submit enrollment',
    'Sign digital guardian consent securely',
    'Review assigned coach profile and credentials',
    'View term schedule and session attendance',
    'Track invoice history and upcoming payments',
  ],
  Coach: [
    'Accept athlete roster assignment',
    'Confirm consent and safeguarding acknowledgements',
    'Review athlete profiles and development plans',
    'Manage personal session schedule',
    'Log attendance and submit session notes',
  ],
};

const CAMPUSES = [
  { name: 'Main Campus', sport: 'Football', athletes: 240 },
  { name: 'East Campus', sport: 'Cricket', athletes: 118 },
  { name: 'West Campus', sport: 'Multi-Sport', athletes: 95 },
];

export function ShowcaseAcademies({ block, manifest, onCta }) {
  const [persona, setPersona] = useState('Academy Director');
  const [step, setStep] = useState(0);
  const details = PERSONA_DETAILS[persona];

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Academies & Organisations</T>

      {/* Persona toggle */}
      <View style={{ flexDirection: 'row', backgroundColor: c.line, borderRadius: r.pill, padding: 3, gap: 2 }}>
        {PERSONAS.map((p) => {
          const sel = persona === p;
          return (
            <Pressable key={p} onPress={() => { setPersona(p); setStep(0); }} accessibilityRole="button" accessibilityLabel={p} accessibilityState={{ selected: sel }} style={{ flex: 1 }}>
              <View style={{ paddingVertical: 10, paddingHorizontal: 8, borderRadius: r.pill, backgroundColor: sel ? c.paper : 'transparent', alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
                <T size={12} weight="700" color={sel ? c.pink : c.mute} numberOfLines={1}>{p}</T>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Campus tiles */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
        {CAMPUSES.map((campus) => (
          <View key={campus.name} style={{ width: 170, backgroundColor: c.pinkSoft, borderRadius: r.card, padding: 16, gap: 6 }}>
            <T weight="800" size={14}>{campus.name}</T>
            <T size={12} color={c.mute}>{campus.sport}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink }} />
              <T size={12} weight="600" color={c.pink}>{campus.athletes} athletes</T>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Enrollment flow stepper */}
      <Card>
        <T weight="700" size={15} style={{ marginBottom: 12 }}>Enrollment flow</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 0, alignItems: 'center' }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <Pressable onPress={() => setStep(i)} accessibilityRole="button" accessibilityLabel={`Step ${i + 1}: ${s}`} accessibilityState={{ selected: i === step }}>
                <View style={{ alignItems: 'center', gap: 4, paddingHorizontal: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= step ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={i <= step ? '#fff' : c.mute}>{i + 1}</T>
                  </View>
                  <T size={10} weight="600" color={i === step ? c.pink : c.mute}>{s}</T>
                </View>
              </Pressable>
              {i < STEPS.length - 1 && <View style={{ width: 20, height: 2, backgroundColor: i < step ? c.pink : c.line, marginBottom: 16 }} />}
            </React.Fragment>
          ))}
        </ScrollView>
        <View style={{ backgroundColor: c.violetSoft, borderRadius: r.card, padding: 14, marginTop: 12 }}>
          <T size={13} weight="700" color={c.pink} style={{ marginBottom: 4 }}>As {persona} · Step {step + 1}: {STEPS[step]}</T>
          <T size={13} color={c.mute}>{details[step]}</T>
        </View>
      </Card>

      <Btn title="Browse academies →" onPress={() => onCta('academy-discovery')} />
    </View>
  );
}
