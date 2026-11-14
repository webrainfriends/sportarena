// Issue #1211: Organization Selection Policy Builder — approval routing, sport templates, SoD, quorum
import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Switch, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Svg, Circle, Line, Text as SvgText } from 'react-native-svg';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Card, Chip, Empty, Field, Screen } from '../ui';
import { MenuField } from '../menu-field';
import { useApi, useApiMutation } from '../api';
import { useNavigation } from '@react-navigation/native';

const ROLE_OPTIONS = [
  { value: 'org_owner', label: 'org_owner' },
  { value: 'club_owner', label: 'club_owner' },
  { value: 'academy_director', label: 'academy_director' },
  { value: 'team_manager', label: 'team_manager' },
  { value: 'head_coach', label: 'head_coach' },
  { value: 'named_delegate', label: 'named_delegate' },
];

const TEAM_TYPE_OPTIONS = [
  { value: 'academy', label: 'academy' },
  { value: 'club', label: 'club' },
  { value: 'school', label: 'school' },
];

const DEFAULT_STEP = () => ({ role: 'org_owner', sla_hours: 72, parallel: false, required: true });

function ApprovalChainPreview({ chain, C }) {
  if (!chain?.length) return null;
  const nodeW = 80;
  const svgW = chain.length * nodeW + 40;
  const svgH = 80;
  return (
    <Svg width={svgW} height={svgH} accessibilityLabel="Approval chain preview">
      {chain.map((r, i) => {
        const cx = 20 + i * nodeW + nodeW / 2;
        const cy = 40;
        return (
          <React.Fragment key={r.id ?? i}>
            {i > 0 && <Line x1={cx - nodeW} y1={cy} x2={cx - 10} y2={cy} stroke={C.line} strokeWidth={2} />}
            <Circle cx={cx} cy={cy} r={18} fill={C.pink} />
            <SvgText x={cx} y={cy + 4} textAnchor="middle" fontSize={9} fill="white" fontWeight="700">
              {(r.approver_role ?? r.role ?? '').slice(0, 6)}
            </SvgText>
            <SvgText x={cx} y={cy + 24} textAnchor="middle" fontSize={8} fill={C.mute}>
              {r.display_name ?? r.approver_role ?? r.role}
            </SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

export default function SelectionPolicyBuilder({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { orgId, orgName, sportId } = route?.params ?? {};

  const { data: existing } = useApi(orgId ? `/organisations/${orgId}/selection-policies` : null);
  const { mutate: savePolicy, loading: saving } = useApiMutation('POST', `/organisations/${orgId}/selection-policies`);

  const [steps, setSteps] = useState([DEFAULT_STEP()]);
  const [sodRules, setSodRules] = useState({ coach: true, team_manager: true, academy_director: true });
  const [sportWeights, setSportWeights] = useState({ technical: 20, tactical: 20, physical: 20, mental: 20, teamwork: 20 });
  const [evidenceMin, setEvidenceMin] = useState(2);
  const [changelog, setChangelog] = useState('');
  const [simChain, setSimChain] = useState(null);
  const [teamType, setTeamType] = useState('academy');
  const { mutate: simulate, loading: simLoading } = useApiMutation('GET', `/organisations/${orgId}/selection-policies/simulate`);

  const S = styles(C);

  useEffect(() => {
    if (existing?.steps?.length) setSteps(existing.steps);
    if (existing?.sod_rules) setSodRules(existing.sod_rules);
    if (existing?.sport_weights) setSportWeights(existing.sport_weights);
    if (existing?.evidence_min) setEvidenceMin(existing.evidence_min);
  }, [existing]);

  const weightSum = Object.values(sportWeights).reduce((a, b) => a + Number(b), 0);

  const addStep = () => setSteps(s => [...s, DEFAULT_STEP()]);
  const removeStep = (idx) => setSteps(s => s.filter((_, i) => i !== idx));
  const updateStep = (idx, key, val) => setSteps(s => s.map((step, i) => i === idx ? { ...step, [key]: val } : step));
  const updateWeight = (key, val) => setSportWeights(w => ({ ...w, [key]: Number(val) || 0 }));
  const toggleSod = (role) => setSodRules(r => ({ ...r, [role]: !r[role] }));

  const onSimulate = async () => {
    const res = await simulate({ org_id: orgId, team_type: teamType });
    setSimChain(res?.chain ?? []);
  };

  const onSave = async () => {
    if (!changelog.trim()) return;
    await savePolicy({ steps, sod_rules: sodRules, sport_weights: sportWeights, evidence_min: evidenceMin, changelog, sport_id: sportId });
    nav.goBack();
  };

  return (
    <Screen title={t('sel.policy.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>

        {/* Policy header */}
        <Card style={S.card}>
          <Text style={S.heading}>{orgName ?? t('sel.policy.title')}</Text>
          <View style={S.row}>
            <Text style={S.label}>{t('sel.policy.policyVersion')}</Text>
            <Chip label={`v${existing?.version ?? 1}`} color={C.violet} size="xs" />
          </View>
          <View style={S.row}>
            <Text style={S.label}>{t('sel.policy.effectiveDate')}</Text>
            <Chip label={existing?.effective_date?.slice(0, 10) ?? '—'} color={C.lime} size="xs" />
          </View>
          {existing?.updated_at && (
            <Text style={S.muted}>{existing.updated_at.slice(0, 16)}</Text>
          )}
        </Card>

        {/* Approval chain */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.policy.approvalChain')}</Text>
          {steps.map((step, idx) => (
            <View key={idx} style={S.stepCard}>
              <View style={S.stepHeader}>
                <View style={[S.stepBadge, { backgroundColor: C.pink }]}>
                  <Text style={S.stepBadgeText}>{idx + 1}</Text>
                </View>
                <MenuField
                  label={t('sel.policy.approverRole')}
                  value={step.role}
                  options={ROLE_OPTIONS}
                  onChange={v => updateStep(idx, 'role', v)}
                  style={S.roleField}
                  accessibilityLabel={`${t('sel.policy.step')} ${idx + 1} ${t('sel.policy.approverRole')}`}
                />
              </View>
              <View style={S.stepRow}>
                <View style={S.slaContainer}>
                  <Text style={S.fieldLabel}>{t('sel.policy.sla')}</Text>
                  <TextInput
                    style={[S.slaInput, { color: C.ink, borderColor: C.line, backgroundColor: C.bg }]}
                    value={String(step.sla_hours)}
                    onChangeText={v => updateStep(idx, 'sla_hours', Number(v) || 72)}
                    keyboardType="number-pad"
                    accessibilityLabel={t('sel.policy.sla')}
                  />
                </View>
                <View style={S.toggleContainer}>
                  <Text style={S.fieldLabel}>{t('sel.policy.parallel')}</Text>
                  <Switch
                    value={step.parallel}
                    onValueChange={v => updateStep(idx, 'parallel', v)}
                    trackColor={{ true: C.pink, false: C.line }}
                    accessibilityLabel={t('sel.policy.parallel')}
                  />
                </View>
                <View style={S.toggleContainer}>
                  <Text style={S.fieldLabel}>{t('sel.policy.required')}</Text>
                  <Switch
                    value={step.required}
                    onValueChange={v => updateStep(idx, 'required', v)}
                    trackColor={{ true: C.lime, false: C.line }}
                    accessibilityLabel={t('sel.policy.required')}
                  />
                </View>
              </View>
              {steps.length > 1 && (
                <Button
                  label={t('sel.policy.removeStep')}
                  variant="outline"
                  size="xs"
                  onPress={() => removeStep(idx)}
                  style={[S.removeBtn, { borderColor: C.red }]}
                  labelStyle={{ color: C.red }}
                  accessibilityLabel={t('sel.policy.removeStep')}
                />
              )}
            </View>
          ))}
          <Button
            label={t('sel.policy.addStep')}
            variant="outline"
            icon="plus"
            onPress={addStep}
            style={S.addStepBtn}
            accessibilityLabel={t('sel.policy.addStep')}
          />
        </Card>

        {/* SoD rules */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.policy.sodRules')}</Text>
          {(['coach', 'team_manager', 'academy_director']).map(role => (
            <View key={role} style={S.sodRow}>
              <Text style={S.sodLabel}>{role}</Text>
              <Switch
                value={sodRules[role] ?? false}
                onValueChange={() => toggleSod(role)}
                trackColor={{ true: C.pink, false: C.line }}
                accessibilityLabel={`${role} ${t('sel.policy.sodRules')}`}
              />
            </View>
          ))}
        </Card>

        {/* Sport template */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.policy.sportTemplate')}</Text>
          {[
            { key: 'technical', label: t('sel.policy.techWeight') },
            { key: 'tactical', label: t('sel.policy.tacticWeight') },
            { key: 'physical', label: t('sel.policy.physWeight') },
            { key: 'mental', label: t('sel.policy.mentalWeight') },
            { key: 'teamwork', label: t('sel.policy.teamworkWeight') },
          ].map(({ key, label }) => (
            <View key={key} style={S.weightRow}>
              <Text style={S.weightLabel}>{label}</Text>
              <TextInput
                style={[S.weightInput, { color: C.ink, borderColor: C.line, backgroundColor: C.bg }]}
                value={String(sportWeights[key])}
                onChangeText={v => updateWeight(key, v)}
                keyboardType="number-pad"
                accessibilityLabel={label}
              />
              <Text style={S.weightPct}>%</Text>
            </View>
          ))}
          <View style={S.weightSumRow}>
            <Text style={S.fieldLabel}>{t('sel.policy.weightSum')}</Text>
            <Chip label={`${weightSum}%`} color={weightSum === 100 ? C.lime : C.red} size="sm" />
          </View>
          <View style={S.row}>
            <Text style={S.label}>{t('sel.policy.evidenceMin')}</Text>
            <View style={S.stepperRow}>
              <TouchableOpacity
                style={[S.stepperBtn, { backgroundColor: C.line }]}
                onPress={() => setEvidenceMin(m => Math.max(1, m - 1))}
                accessibilityLabel="decrease"
              >
                <Text style={S.stepperTxt}>−</Text>
              </TouchableOpacity>
              <Text style={[S.stepperVal, { color: C.ink }]}>{evidenceMin}</Text>
              <TouchableOpacity
                style={[S.stepperBtn, { backgroundColor: C.line }]}
                onPress={() => setEvidenceMin(m => m + 1)}
                accessibilityLabel="increase"
              >
                <Text style={S.stepperTxt}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Card>

        {/* Policy simulator */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.policy.simulator')}</Text>
          <MenuField
            label={t('sel.policy.teamType')}
            value={teamType}
            options={TEAM_TYPE_OPTIONS}
            onChange={setTeamType}
            style={S.teamTypeField}
            accessibilityLabel={t('sel.policy.teamType')}
          />
          <Button
            label={t('sel.policy.simulate')}
            onPress={onSimulate}
            loading={simLoading}
            icon="eye"
            style={S.simBtn}
            accessibilityLabel={t('sel.policy.simulate')}
          />
          {simChain !== null && (
            simChain.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.chainScroll}>
                <ApprovalChainPreview chain={simChain} C={C} />
              </ScrollView>
            ) : (
              <Empty icon="user-x" title={t('sel.policy.simulate')} body="—" />
            )
          )}
        </Card>

        {/* Save & activate */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.policy.activate')}</Text>
          <TextField
            label={t('sel.policy.changelog')}
            value={changelog}
            onChangeText={setChangelog}
            multiline
            numberOfLines={3}
            placeholder={t('sel.policy.changelog')}
            style={S.changelogField}
            accessibilityLabel={t('sel.policy.changelog')}
          />
          <Button
            label={t('sel.policy.save')}
            onPress={onSave}
            loading={saving}
            disabled={!changelog.trim() || weightSum !== 100}
            style={S.saveBtn}
            accessibilityLabel={t('sel.policy.save')}
          />
          <Button
            label={t('sel.policy.versionHistory')}
            variant="outline"
            onPress={() => {}}
            style={S.histBtn}
            accessibilityLabel={t('sel.policy.versionHistory')}
          />
        </Card>

      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  card: { padding: 16, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  label: { fontSize: 13, color: C.mute },
  muted: { fontSize: 11, color: C.mute, marginTop: 4 },
  stepCard: {
    backgroundColor: C.bg, borderRadius: 12, padding: 12, marginBottom: 10,
    borderWidth: 1, borderColor: C.line,
  },
  stepHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  stepBadge: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBadgeText: { color: 'white', fontWeight: '800', fontSize: 13 },
  roleField: { flex: 1 },
  stepRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  slaContainer: { alignItems: 'center', gap: 4 },
  slaInput: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6,
    fontSize: 14, fontWeight: '700', width: 64, textAlign: 'center',
  },
  toggleContainer: { alignItems: 'center', gap: 4 },
  fieldLabel: { fontSize: 11, color: C.mute, marginBottom: 2 },
  removeBtn: { marginTop: 10, alignSelf: 'flex-end' },
  addStepBtn: { marginTop: 4 },
  sodRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  sodLabel: { fontSize: 13, color: C.ink },
  weightRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 10 },
  weightLabel: { flex: 1, fontSize: 13, color: C.ink },
  weightInput: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6,
    fontSize: 14, fontWeight: '700', width: 56, textAlign: 'center',
  },
  weightPct: { fontSize: 13, color: C.mute, width: 16 },
  weightSumRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 12 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stepperTxt: { fontSize: 18, fontWeight: '700', color: C.ink },
  stepperVal: { fontSize: 16, fontWeight: '700', minWidth: 24, textAlign: 'center' },
  teamTypeField: { marginBottom: 10 },
  simBtn: { marginBottom: 12 },
  chainScroll: { marginTop: 4 },
  changelogField: { marginBottom: 12 },
  saveBtn: { marginBottom: 10 },
  histBtn: {},
});
