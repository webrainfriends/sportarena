// Issue #1194: Campaign setup wizard — multi-step mandate, roles, criteria, committee, approval
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { MenuField } from '../components/MenuField';
import { MultiMenuField } from '../components/MultiMenuField';
import { DateField } from '../components/DateField';
import { StepperField } from '../components/StepperField';
import { Switch } from '../components/Switch';
import { useNavigation } from '@react-navigation/native';

const STEPS = ['mandate','roles','criteria','committee','approval','review'];
const PURPOSES = ['academy_admissions','season_roster','matchday_xi','tournament_squad','relay_team','trial_selection','development_squad','emergency_cover','cup_squad'];
const VOTING_RULES = ['majority','unanimous','supermajority'];

export default function SelectionCampaignSetup({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { orgId } = route?.params ?? {};
  const { data: sports } = useApi('/sports');
  const { data: teams } = useApi(`/organisations/${orgId}/teams`);
  const { mutate, loading } = useApiMutation('POST', `/organisations/${orgId}/selection-campaigns`);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    name: '', purpose: 'season_roster', sport_id: null, team_id: null,
    formation: '', min_squad_size: 11, max_squad_size: 25, max_reserve_size: 7,
    age_bracket_min: null, age_bracket_max: null,
    nomination_deadline: null, assessment_deadline: null, decision_deadline: null,
    committee_quorum: 3, voting_rule: 'majority', sod_exception: false,
    approval_config: {},
  });
  const S = styles(C);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    const result = await mutate(form);
    if (result) nav.replace('SelectionCandidatePipeline', { campaignId: result.id });
  };

  const stepContent = [
    // Step 0: mandate
    <View key="mandate">
      <Text style={S.stepTitle}>{t('sel.setup.mandate')}</Text>
      <TextField label={t('sel.setup.name')} value={form.name} onChangeText={v => set('name', v)} accessibilityLabel={t('sel.setup.name')} />
      <MenuField label={t('sel.setup.purpose')} value={form.purpose} options={PURPOSES.map(p => ({ value: p, label: t(`sel.purpose.${p}`) }))} onChange={v => set('purpose', v)} accessibilityLabel={t('sel.setup.purpose')} />
      <MenuField label={t('sel.setup.sport')} value={form.sport_id} options={(sports ?? []).map(s => ({ value: s.id, label: s.name }))} onChange={v => set('sport_id', v)} accessibilityLabel={t('sel.setup.sport')} />
      <MenuField label={t('sel.setup.team')} value={form.team_id} options={(teams ?? []).map(t => ({ value: t.id, label: t.name }))} onChange={v => set('team_id', v)} accessibilityLabel={t('sel.setup.team')} />
    </View>,
    // Step 1: roles / formation
    <View key="roles">
      <Text style={S.stepTitle}>{t('sel.setup.rolesFormation')}</Text>
      <TextField label={t('sel.setup.formation')} value={form.formation} onChangeText={v => set('formation', v)} placeholder="4-3-3" accessibilityLabel={t('sel.setup.formation')} />
      <StepperField label={t('sel.setup.minSquad')} value={form.min_squad_size} min={1} max={100} onChange={v => set('min_squad_size', v)} accessibilityLabel={t('sel.setup.minSquad')} />
      <StepperField label={t('sel.setup.maxSquad')} value={form.max_squad_size} min={1} max={100} onChange={v => set('max_squad_size', v)} accessibilityLabel={t('sel.setup.maxSquad')} />
      <StepperField label={t('sel.setup.maxReserve')} value={form.max_reserve_size} min={0} max={50} onChange={v => set('max_reserve_size', v)} accessibilityLabel={t('sel.setup.maxReserve')} />
      <StepperField label={t('sel.setup.ageMin')} value={form.age_bracket_min ?? 0} min={5} max={99} onChange={v => set('age_bracket_min', v)} accessibilityLabel={t('sel.setup.ageMin')} />
      <StepperField label={t('sel.setup.ageMax')} value={form.age_bracket_max ?? 0} min={5} max={99} onChange={v => set('age_bracket_max', v)} accessibilityLabel={t('sel.setup.ageMax')} />
    </View>,
    // Step 2: criteria / deadlines
    <View key="criteria">
      <Text style={S.stepTitle}>{t('sel.setup.criteriaDeadlines')}</Text>
      <DateField label={t('sel.setup.nominationDeadline')} value={form.nomination_deadline} onChange={v => set('nomination_deadline', v)} accessibilityLabel={t('sel.setup.nominationDeadline')} />
      <DateField label={t('sel.setup.assessmentDeadline')} value={form.assessment_deadline} onChange={v => set('assessment_deadline', v)} accessibilityLabel={t('sel.setup.assessmentDeadline')} />
      <DateField label={t('sel.setup.decisionDeadline')} value={form.decision_deadline} onChange={v => set('decision_deadline', v)} accessibilityLabel={t('sel.setup.decisionDeadline')} />
    </View>,
    // Step 3: committee
    <View key="committee">
      <Text style={S.stepTitle}>{t('sel.setup.committee')}</Text>
      <StepperField label={t('sel.setup.quorum')} value={form.committee_quorum} min={1} max={20} onChange={v => set('committee_quorum', v)} accessibilityLabel={t('sel.setup.quorum')} />
      <MenuField label={t('sel.setup.votingRule')} value={form.voting_rule} options={VOTING_RULES.map(r => ({ value: r, label: t(`sel.votingRule.${r}`) }))} onChange={v => set('voting_rule', v)} accessibilityLabel={t('sel.setup.votingRule')} />
    </View>,
    // Step 4: approval policy
    <View key="approval">
      <Text style={S.stepTitle}>{t('sel.setup.approvalPolicy')}</Text>
      <Switch label={t('sel.setup.sodException')} value={form.sod_exception} onValueChange={v => set('sod_exception', v)} accessibilityLabel={t('sel.setup.sodException')} />
      <Text style={S.hint}>{t('sel.setup.sodExceptionHint')}</Text>
    </View>,
    // Step 5: review
    <View key="review">
      <Text style={S.stepTitle}>{t('sel.setup.review')}</Text>
      <Card style={S.reviewCard}>
        <Text style={S.reviewRow}><Text style={S.reviewLabel}>{t('sel.setup.name')}: </Text>{form.name}</Text>
        <Text style={S.reviewRow}><Text style={S.reviewLabel}>{t('sel.setup.purpose')}: </Text>{form.purpose}</Text>
        <Text style={S.reviewRow}><Text style={S.reviewLabel}>{t('sel.setup.formation')}: </Text>{form.formation || '—'}</Text>
        <Text style={S.reviewRow}><Text style={S.reviewLabel}>{t('sel.setup.squad')}: </Text>{form.min_squad_size}–{form.max_squad_size}</Text>
      </Card>
    </View>,
  ];

  return (
    <Screen title={t('sel.setup.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* step indicator */}
        <View style={S.stepIndicator}>
          {STEPS.map((s, idx) => (
            <View key={s} style={[S.stepDot, { backgroundColor: idx <= step ? C.pink : C.line }]} />
          ))}
        </View>
        <Card style={S.stepCard}>
          {stepContent[step]}
        </Card>
        <View style={S.navRow}>
          {step > 0 && <Button label={t('common.back')} onPress={() => setStep(s => s - 1)} variant="ghost" accessibilityLabel={t('common.back')} />}
          {step < STEPS.length - 1
            ? <Button label={t('common.next')} onPress={() => setStep(s => s + 1)} accessibilityLabel={t('common.next')} />
            : <Button label={t('sel.setup.create')} onPress={submit} loading={loading} accessibilityLabel={t('sel.setup.create')} />
          }
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  stepIndicator: { flexDirection: 'row', gap: 6, marginBottom: 20, justifyContent: 'center' },
  stepDot: { width: 10, height: 10, borderRadius: 5 },
  stepCard: { padding: 20, marginBottom: 16 },
  stepTitle: { fontSize: 18, fontWeight: '700', color: C.ink, marginBottom: 16 },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  hint: { fontSize: 12, color: C.mute, marginTop: 6 },
  reviewCard: { padding: 16 },
  reviewRow: { fontSize: 14, color: C.ink, marginBottom: 8 },
  reviewLabel: { fontWeight: '600' },
});
