// Issue #1194: Selection Policy Builder — rubric weights, eligibility rules, approval config
import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet , Switch } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { useNavigation } from '@react-navigation/native';
import { Stepper } from '../pickers';
import { Btn, Card, Chip, Screen } from '../ui';

const RUBRIC_KEYS = ['physical', 'technical', 'tactical', 'mental', 'experience', 'potential'];

export default function SelectionPolicyBuilder({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId } = route?.params ?? {};
  const { data: campaign } = useApi(`/selection-campaigns/${campaignId}`);
  const { mutate: lockCriteria, loading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/lock-criteria`);
  const S = styles(C);

  const pv = campaign?.policy_version;
  const isLocked = !!campaign?.locked_at;

  const defaultWeights = { physical: 20, technical: 25, tactical: 20, mental: 15, experience: 10, potential: 10 };
  const [weights, setWeights] = useState(defaultWeights);
  const [minAge, setMinAge] = useState(14);
  const [maxAge, setMaxAge] = useState(45);
  const [minAppearances, setMinAppearances] = useState(0);
  const [minEvidenceThreshold, setMinEvidenceThreshold] = useState(2);
  const [confidencePenaltyPct, setConfidencePenaltyPct] = useState(10);
  const [sodException, setSodException] = useState(false);

  useEffect(() => {
    if (!pv) return;
    if (pv.weight_snapshot) setWeights({ ...defaultWeights, ...pv.weight_snapshot });
    if (pv.eligibility_rules?.min_age) setMinAge(pv.eligibility_rules.min_age);
    if (pv.eligibility_rules?.max_age) setMaxAge(pv.eligibility_rules.max_age);
    if (pv.eligibility_rules?.min_appearances) setMinAppearances(pv.eligibility_rules.min_appearances);
    if (pv.min_evidence_threshold) setMinEvidenceThreshold(pv.min_evidence_threshold);
    if (pv.confidence_penalty_pct != null) setConfidencePenaltyPct(pv.confidence_penalty_pct);
    if (campaign?.sod_exception != null) setSodException(campaign.sod_exception);
  }, [pv?.id]);

  const totalWeight = Object.values(weights).reduce((s, v) => s + v, 0);

  const setWeight = (key, v) => setWeights(w => ({ ...w, [key]: v }));

  const lock = async () => {
    const result = await lockCriteria({
      rubric_snapshot: RUBRIC_KEYS.map(k => ({ key: k, label: t(`sel.rubric.${k}`) })),
      weight_snapshot: weights,
      eligibility_rules: { min_age: minAge, max_age: maxAge, min_appearances: minAppearances },
      min_evidence_threshold: minEvidenceThreshold,
      confidence_penalty_pct: confidencePenaltyPct,
    });
    if (result) nav.goBack();
  };

  return (
    <Screen title={t('sel.policy.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Campaign header */}
        <Card style={S.headerCard}>
          <View style={S.headerRow}>
            <View style={S.headerInfo}>
              <Text style={S.campaignName} numberOfLines={1}>{campaign?.name ?? '—'}</Text>
              <Text style={S.campaignSub}>{campaign?.sport_name ?? '—'} · {campaign?.purpose ?? '—'}</Text>
            </View>
            <Chip
              label={isLocked ? t('sel.policy.locked') : t('sel.policy.draft')}
              color={isLocked ? C.lime : C.sun}
              size="sm"
            />
          </View>
          {pv && (
            <Text style={S.versionLabel}>{t('sel.policy.version', { n: pv.version_number ?? 1 })}</Text>
          )}
        </Card>

        {/* Rubric weights */}
        <Card style={S.card}>
          <View style={S.sectionHeader}>
            <Text style={S.sectionTitle}>{t('sel.policy.rubricWeights')}</Text>
            <Chip
              label={`${totalWeight}%`}
              color={totalWeight === 100 ? C.lime : C.red}
              size="xs"
            />
          </View>
          <Text style={S.hint}>{t('sel.policy.rubricHint')}</Text>
          {RUBRIC_KEYS.map(key => (
            <Stepper
              key={key}
              label={t(`sel.rubric.${key}`)}
              value={weights[key]}
              min={0}
              max={100}
              step={5}
              onChange={v => setWeight(key, v)}
              disabled={isLocked}
              accessibilityLabel={t(`sel.rubric.${key}`)}
            />
          ))}
        </Card>

        {/* Eligibility rules */}
        <Card style={S.card}>
          <Text style={S.sectionTitle}>{t('sel.policy.eligibility')}</Text>
          <Stepper
            label={t('sel.policy.minAge')}
            value={minAge}
            min={5}
            max={99}
            onChange={setMinAge}
            disabled={isLocked}
            accessibilityLabel={t('sel.policy.minAge')}
          />
          <Stepper
            label={t('sel.policy.maxAge')}
            value={maxAge}
            min={5}
            max={99}
            onChange={setMaxAge}
            disabled={isLocked}
            accessibilityLabel={t('sel.policy.maxAge')}
          />
          <Stepper
            label={t('sel.policy.minAppearances')}
            value={minAppearances}
            min={0}
            max={500}
            onChange={setMinAppearances}
            disabled={isLocked}
            accessibilityLabel={t('sel.policy.minAppearances')}
          />
        </Card>

        {/* Scoring config */}
        <Card style={S.card}>
          <Text style={S.sectionTitle}>{t('sel.policy.scoringConfig')}</Text>
          <Stepper
            label={t('sel.policy.minEvidence')}
            value={minEvidenceThreshold}
            min={1}
            max={20}
            onChange={setMinEvidenceThreshold}
            disabled={isLocked}
            accessibilityLabel={t('sel.policy.minEvidence')}
          />
          <Stepper
            label={t('sel.policy.confidencePenalty')}
            value={confidencePenaltyPct}
            min={0}
            max={50}
            step={5}
            onChange={setConfidencePenaltyPct}
            disabled={isLocked}
            accessibilityLabel={t('sel.policy.confidencePenalty')}
          />
        </Card>

        {/* SoD */}
        <Card style={S.card}>
          <Text style={S.sectionTitle}>{t('sel.policy.sodTitle')}</Text>
          <Switch
            label={t('sel.setup.sodException')}
            value={sodException}
            onValueChange={setSodException}
            disabled={isLocked}
            accessibilityLabel={t('sel.setup.sodException')}
          />
          <Text style={S.hint}>{t('sel.setup.sodExceptionHint')}</Text>
        </Card>

        {!isLocked && (
          <Btn
            label={t('sel.policy.lockAndApply')}
            onPress={lock}
            loading={loading}
            disabled={totalWeight !== 100}
            accessibilityLabel={t('sel.policy.lockAndApply')}
            style={S.lockBtn}
          />
        )}
        {isLocked && (
          <Card style={S.lockedNotice}>
            <Text style={S.lockedText}>{t('sel.policy.lockedNotice')}</Text>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  headerCard: { padding: 14, marginBottom: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  headerInfo: { flex: 1 },
  campaignName: { fontSize: 16, fontWeight: '700', color: C.ink },
  campaignSub: { fontSize: 12, color: C.mute, marginTop: 2 },
  versionLabel: { fontSize: 11, color: C.mute, marginTop: 8 },
  card: { padding: 16, marginBottom: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 10 },
  hint: { fontSize: 12, color: C.mute, marginBottom: 12 },
  lockBtn: { marginBottom: 16 },
  lockedNotice: { padding: 14, backgroundColor: C.lime + '1A', borderLeftWidth: 3, borderLeftColor: C.lime },
  lockedText: { fontSize: 13, color: C.lime, fontWeight: '600' },
});
