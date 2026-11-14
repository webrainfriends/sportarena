import React, { useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { T } from '../ui';
import { palette } from '../theme';

const PERSONAS = [
  { key: 'director', label: 'Director', emoji: '🏫', desc: 'Manage every campus, programme, coach and revenue stream from one console. Real-time dashboards, board-ready reports, payroll.' },
  { key: 'parent',   label: 'Parent',   emoji: '👨‍👩‍👧', desc: "Track your child's attendance, progress and upcoming fixtures. Digital consent, secure messaging with coaches, invoice history." },
  { key: 'coach',    label: 'Coach',    emoji: '🏋️', desc: 'Session plans, athlete load monitoring, drills library, attendance, parent communications and CPD portfolio — all in one app.' },
];
const STEPS = [
  { label: 'Enrol',    desc: 'Fill the online form. Guardian consent captured digitally with biometric signature.' },
  { label: 'Consent',  desc: 'Smart consent covers data, media, medical sharing and travel — jurisdiction-aware.' },
  { label: 'Coaches',  desc: 'Assign athlete to group and 1-to-1 coaches based on sport, age and objective.' },
  { label: 'Calendar', desc: 'Term dates, competition fixtures, camps and trials synced to phone calendar.' },
  { label: 'Finance',  desc: 'Fee schedule, sibling discount, payment plan and tax receipt — zero admin.' },
];

export function ShowcaseAcademies({ manifest, block, onNavigate }) {
  const [persona, setPersona] = useState('director');
  const [step, setStep]       = useState(0);
  const p = PERSONAS.find((x) => x.key === persona);

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <T style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Academies & Organisations</T>
      <T style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 12 }}>Every campus, coach and student — one console</T>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {PERSONAS.map((x) => (
          <TouchableOpacity key={x.key} onPress={() => { setPersona(x.key); setStep(0); }} style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 12, backgroundColor: x.key === persona ? palette.p2 : 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' }}>
            <T style={{ fontSize: 18, marginBottom: 2 }}>{x.emoji}</T>
            <T style={{ color: x.key === persona ? '#fff' : 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' }}>{x.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', marginBottom: 12 }}>
        <T style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 18 }}>{p.desc}</T>
      </View>

      <T style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>ENROLMENT JOURNEY</T>
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
        {STEPS.map((s, i) => (
          <TouchableOpacity key={s.label} onPress={() => setStep(i)} style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: i === step ? palette.p2 : i < step ? palette.p3 + '55' : 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
              <T style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{i + 1}</T>
            </View>
            <T style={{ color: i === step ? palette.p3 : 'rgba(255,255,255,0.35)', fontSize: 9, textAlign: 'center' }}>{s.label}</T>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ padding: 12, borderRadius: 12, backgroundColor: 'rgba(132,88,179,0.18)', borderWidth: 1, borderColor: 'rgba(208,189,244,0.25)', marginBottom: 12 }}>
        <T style={{ color: palette.p3, fontWeight: '700', fontSize: 13, marginBottom: 4 }}>{STEPS[step].label}</T>
        <T style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: 18 }}>{STEPS[step].desc}</T>
      </View>

      <TouchableOpacity onPress={() => onNavigate?.('join')} style={{ paddingVertical: 12, borderRadius: 12, backgroundColor: palette.p2, alignItems: 'center' }}>
        <T style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Explore academies →</T>
      </TouchableOpacity>
    </View>
  );
}
