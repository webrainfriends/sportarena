// Patient physio intake form wizard (#210).
// Steps: reason → body regions → pain scoring → stiffness → goals → submit.
// Pain and stiffness are explicitly nullable: "not reporting" is distinct from zero.
import React, { useState } from 'react';
import { View, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, Card, Chip, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const REGIONS = [
  'neck','shoulder','elbow','wrist','hand','upper_back','lower_back','hip','knee','ankle','foot','core',
];
const regionLabel = (r) => r.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

const STEPS = ['reason', 'regions', 'pain', 'stiffness', 'goals'];

function StepHeader({ step, total }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginBottom: 12 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? c.violet : c.line }} />
      ))}
    </View>
  );
}

function PainSlider({ value, notReporting, onValue, onToggleNotReporting, label }) {
  return (
    <View style={{ gap: 10 }}>
      <T weight="700">{label}</T>
      <TouchableOpacity
        accessibilityRole="checkbox"
        accessibilityLabel={t('physio.intake.not_reporting')}
        onPress={onToggleNotReporting}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <View style={{
          width: 22, height: 22, borderRadius: 4,
          backgroundColor: notReporting ? c.violet : c.line,
          alignItems: 'center', justifyContent: 'center',
        }}>
          {notReporting && <T size={14} color={c.white}>✓</T>}
        </View>
        <T size={13} color={c.mute}>{t('physio.intake.not_reporting')}</T>
      </TouchableOpacity>

      {!notReporting && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <TouchableOpacity
              key={n}
              accessibilityLabel={`${label} ${n}`}
              accessibilityRole="button"
              onPress={() => onValue(n)}
              style={{
                width: 44, height: 44, borderRadius: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: value === n
                  ? (n >= 7 ? c.red : n >= 4 ? c.orange : c.mint)
                  : c.line,
              }}
            >
              <T size={15} weight={value === n ? '800' : '400'} color={value === n ? c.white : c.ink}>{n}</T>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

export function PhysioIntake({ formId, appointmentId, onDone }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [reason, setReason] = useState('');
  const [regions, setRegions] = useState([]);
  const [pain, setPain] = useState(null);
  const [painNR, setPainNR] = useState(false);
  const [stiff, setStiff] = useState(null);
  const [stiffNR, setStiffNR] = useState(false);
  const [goals, setGoals] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const toggleRegion = (r) => setRegions((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post('/physio/intake', {
        form_id: formId,
        appointment_id: appointmentId,
        chief_complaint: reason,
        pain_locations: regions,
        pain_scale: painNR ? null : pain,
        functional_goals: goals,
        answers: { stiffness: stiffNR ? null : stiff },
      });
      toast(t('physio.intake.submitted'));
      onDone?.();
    } catch (e) {
      toast(e.message ?? t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const stepContent = [
    // Step 0: reason
    <View key="reason" style={{ gap: 12 }}>
      <T weight="800" size={16}>{t('physio.intake.reason')}</T>
      <TextInput
        accessibilityLabel={t('physio.intake.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
        numberOfLines={4}
        placeholder={t('physio.intake.reason_placeholder')}
        placeholderTextColor={c.mute}
        style={{ minHeight: 100, padding: 12, borderRadius: 8, backgroundColor: c.line, color: c.ink, textAlignVertical: 'top' }}
      />
      <Btn title={t('common.next')} color={c.violet} disabled={!reason.trim()} onPress={() => setStep(1)} />
    </View>,

    // Step 1: regions
    <View key="regions" style={{ gap: 12 }}>
      <T weight="800" size={16}>{t('physio.intake.region')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {REGIONS.map((r) => (
          <TouchableOpacity
            key={r}
            accessibilityRole="checkbox"
            accessibilityLabel={regionLabel(r)}
            onPress={() => toggleRegion(r)}
            style={{
              paddingHorizontal: 14, height: 44, borderRadius: 22,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: regions.includes(r) ? c.violet : c.line,
            }}
          >
            <T size={13} weight={regions.includes(r) ? '700' : '400'} color={regions.includes(r) ? c.white : c.ink}>
              {regionLabel(r)}
            </T>
          </TouchableOpacity>
        ))}
      </View>
      <Btn title={t('common.next')} color={c.violet} onPress={() => setStep(2)} />
    </View>,

    // Step 2: pain
    <View key="pain" style={{ gap: 16 }}>
      <PainSlider
        label={t('physio.intake.pain_score')}
        value={pain}
        notReporting={painNR}
        onValue={setPain}
        onToggleNotReporting={() => { setPainNR((x) => !x); setPain(null); }}
      />
      <Btn title={t('common.next')} color={c.violet} onPress={() => setStep(3)} />
    </View>,

    // Step 3: stiffness
    <View key="stiffness" style={{ gap: 16 }}>
      <PainSlider
        label={t('physio.intake.stiffness')}
        value={stiff}
        notReporting={stiffNR}
        onValue={setStiff}
        onToggleNotReporting={() => { setStiffNR((x) => !x); setStiff(null); }}
      />
      <Btn title={t('common.next')} color={c.violet} onPress={() => setStep(4)} />
    </View>,

    // Step 4: goals + submit
    <View key="goals" style={{ gap: 12 }}>
      <T weight="800" size={16}>{t('physio.intake.goals')}</T>
      <TextInput
        accessibilityLabel={t('physio.intake.goals')}
        value={goals}
        onChangeText={setGoals}
        multiline
        numberOfLines={3}
        placeholder={t('physio.intake.goals_placeholder')}
        placeholderTextColor={c.mute}
        style={{ minHeight: 80, padding: 12, borderRadius: 8, backgroundColor: c.line, color: c.ink, textAlignVertical: 'top' }}
      />
      <Btn title={submitting ? t('common.loading') : t('physio.intake.submit')} color={c.violet} disabled={submitting} onPress={submit} />
    </View>,
  ];

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Card pad={16} color={c.paper}>
        <T weight="900" size={17}>{t('physio.intake.title')}</T>
        <StepHeader step={step} total={STEPS.length} />
        {stepContent[step]}
        {step > 0 && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            onPress={() => setStep((s) => s - 1)}
            style={{ marginTop: 12, alignSelf: 'flex-start', height: 44, justifyContent: 'center' }}
          >
            <T color={c.mute}>← {t('common.back')}</T>
          </TouchableOpacity>
        )}
      </Card>
    </ScrollView>
  );
}

export default PhysioIntake;
