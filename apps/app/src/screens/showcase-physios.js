import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const TYPES = ['Physiotherapist', 'Sports Doctor'];
const REGIONS = ['Head', 'Shoulder', 'Knee', 'Ankle', 'Back'];
const JOURNEY = ['Appointment', 'Assessment', 'Recovery', 'Clearance'];

const REGION_INFO = {
  Head: { icon: '🧠', physio: 'Concussion protocol, vestibular rehab, cognitive load assessment.', doctor: 'Neurological screening, imaging referral if indicated, return-to-play clearance.' },
  Shoulder: { icon: '💪', physio: 'Rotator cuff strengthening, range-of-motion restoration, sport-specific rehab.', doctor: 'Structural assessment, cortisone if appropriate, surgical referral if needed.' },
  Knee: { icon: '🦵', physio: 'ACL/PCL protocol, quad/hamstring balance, proprioception training.', doctor: 'MRI referral, ligament stability assessment, surgical liaison.' },
  Ankle: { icon: '🦶', physio: 'RICE protocol, balance rehab, graded return-to-sport loading.', doctor: 'Fracture exclusion, ligament grading, immobilisation decision.' },
  Back: { icon: '🏋️', physio: 'Core stabilisation, posture correction, manual therapy.', doctor: 'Structural scan if >6 weeks, red flag screening, pain management.' },
};

export function ShowcasePhysios({ block, manifest, onCta }) {
  const [type, setType] = useState('Physiotherapist');
  const [region, setRegion] = useState('Knee');
  const [step, setStep] = useState(0);

  const info = REGION_INFO[region];

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Physios & Doctors</T>

      {/* Type toggle */}
      <View style={{ flexDirection: 'row', backgroundColor: c.line, borderRadius: r.pill, padding: 3, gap: 2 }}>
        {TYPES.map((tp) => {
          const sel = type === tp;
          return (
            <Pressable key={tp} onPress={() => setType(tp)} accessibilityRole="button" accessibilityLabel={tp} accessibilityState={{ selected: sel }} style={{ flex: 1 }}>
              <View style={{ paddingVertical: 10, borderRadius: r.pill, backgroundColor: sel ? c.paper : 'transparent', alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight="700" color={sel ? c.pink : c.mute}>{tp}</T>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Body region selector — accessible grid */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Select body region</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {REGIONS.map((reg) => {
            const sel = region === reg;
            const ri = REGION_INFO[reg];
            return (
              <Pressable key={reg} onPress={() => setRegion(reg)}
                accessibilityRole="button" accessibilityLabel={reg}
                accessibilityState={{ selected: sel }}
                style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
                <View style={{ width: 90, height: 72, backgroundColor: sel ? c.pinkSoft : c.violetSoft, borderRadius: r.card, alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: sel ? 2 : 1, borderColor: sel ? c.pink : c.line }}>
                  <T size={22}>{ri.icon}</T>
                  <T size={11} weight="700" color={sel ? c.pink : c.mute}>{reg}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* Region detail */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <T size={24}>{info.icon}</T>
          <T weight="800" size={16}>{region} · {type}</T>
        </View>
        <T size={13} color={c.mute} style={{ lineHeight: 20 }}>{type === 'Physiotherapist' ? info.physio : info.doctor}</T>
      </Card>

      {/* Journey steps */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Care pathway</T>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {JOURNEY.map((s, i) => (
            <React.Fragment key={s}>
              <Pressable onPress={() => setStep(i)} accessibilityRole="button" accessibilityLabel={`${s} step`} accessibilityState={{ selected: i === step }}>
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= step ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={i <= step ? '#fff' : c.mute}>{i + 1}</T>
                  </View>
                  <T size={10} weight="600" color={i === step ? c.pink : c.mute}>{s}</T>
                </View>
              </Pressable>
              {i < JOURNEY.length - 1 && <View style={{ flex: 1, height: 2, backgroundColor: i < step ? c.pink : c.line, marginBottom: 16, marginHorizontal: 4 }} />}
            </React.Fragment>
          ))}
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 12 }}>Platform facilitates booking only — not medical advice. Clinicians are independently verified.</T>
      </Card>

      <Btn title="Book a consultation →" onPress={() => onCta('physio-discovery')} />
    </View>
  );
}
