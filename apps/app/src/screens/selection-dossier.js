// Issue #1194: 360° athlete intelligence dossier
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Avatar } from '../components/Avatar';
import { Chip } from '../components/Chip';
import { Button } from '../components/Button';
import { MetricStrip } from '../components/MetricStrip';
import { TabBar } from '../components/TabBar';
import { useNavigation } from '@react-navigation/native';

export default function SelectionDossier({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { nominationId, campaignId } = route?.params ?? {};
  const { data: dossier } = useApi(`/selection-campaigns/${campaignId}/nominations/${nominationId}/dossier`);
  const [tab, setTab] = useState(0);
  const S = styles(C);

  if (!dossier) return <Screen title={t('sel.dossier.title')} back><View /></Screen>;

  const tabs = [
    t('sel.dossier.tabOverview'),
    t('sel.dossier.tabPerformance'),
    t('sel.dossier.tabScouting'),
    t('sel.dossier.tabVideo'),
    t('sel.dossier.tabEligibility'),
  ];

  const elig = dossier.eligibility_summary ?? {};
  const eligColor = elig.status === 'eligible' ? C.lime : elig.status === 'ineligible' ? C.red : C.sun;

  return (
    <Screen title={t('sel.dossier.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Hero card */}
        <Card style={S.hero}>
          <View style={S.heroRow}>
            <Avatar userId={dossier.candidate_id} size={64} />
            <View style={S.heroInfo}>
              <Text style={S.heroName}>{dossier.display_name ?? '—'}</Text>
              <Text style={S.heroSub}>{dossier.position ?? '—'} · {dossier.age ?? '—'} {t('sel.dossier.yrs')}</Text>
              <View style={S.heroBadges}>
                <Chip label={elig.status ?? 'unchecked'} color={eligColor} size="sm" />
                {dossier.verified && <Chip label={t('sel.verified')} color={C.lime} size="sm" />}
              </View>
            </View>
          </View>
          <MetricStrip items={[
            { label: t('sel.dossier.completeness'), value: `${dossier.evidence_quality?.completeness ?? 0}%` },
            { label: t('sel.dossier.observations'), value: dossier.evidence_quality?.observation_count ?? 0 },
            { label: t('sel.dossier.sources'), value: dossier.evidence_quality?.source_count ?? 0 },
            { label: t('sel.dossier.freshness'), value: dossier.evidence_quality?.freshness_days != null ? `${dossier.evidence_quality.freshness_days}d` : '—' },
          ]} />
          {(dossier.evidence_quality?.missing_data_warnings ?? []).length > 0 && (
            <View style={S.warnings}>
              {dossier.evidence_quality.missing_data_warnings.map((w, idx) => (
                <Text key={idx} style={S.warning}>⚠ {w}</Text>
              ))}
            </View>
          )}
        </Card>

        <TabBar tabs={tabs} selected={tab} onSelect={setTab} style={S.tabs} />

        {tab === 0 && (
          <Card style={S.section}>
            <Text style={S.sectionTitle}>{t('sel.dossier.overview')}</Text>
            {(dossier.performance_metrics ?? []).slice(0, 6).map(m => (
              <View key={m.metric_key} style={S.metricRow}>
                <Text style={S.metricLabel}>{m.metric_label}</Text>
                <Text style={S.metricValue}>{m.value ?? '—'}</Text>
                <Text style={S.metricSource}>{m.source}</Text>
              </View>
            ))}
          </Card>
        )}

        {tab === 1 && (
          <Card style={S.section}>
            <Text style={S.sectionTitle}>{t('sel.dossier.tabPerformance')}</Text>
            {(dossier.performance_metrics ?? []).map(m => (
              <View key={m.metric_key} style={S.metricRow}>
                <Text style={S.metricLabel}>{m.metric_label}</Text>
                <View style={S.metricBar}>
                  <View style={[S.metricFill, { width: `${Math.min(100, (m.percentile ?? 0))}%`, backgroundColor: C.pink }]} />
                </View>
                <Text style={S.metricPerc}>{m.percentile != null ? `P${Math.round(m.percentile)}` : '—'}</Text>
              </View>
            ))}
          </Card>
        )}

        {tab === 2 && (
          <Card style={S.section}>
            <Text style={S.sectionTitle}>{t('sel.dossier.tabScouting')}</Text>
            {(dossier.scouting_evaluations ?? []).map(ev => (
              <View key={ev.id} style={S.evalRow}>
                <Text style={S.evalName}>{ev.evaluator_name}</Text>
                <Text style={S.evalScore}>{ev.total_score}/{ev.max_score}</Text>
                <Text style={S.evalDate}>{ev.observed_on ?? ev.submitted_at?.slice(0,10)}</Text>
              </View>
            ))}
            {(!dossier.scouting_evaluations?.length) && <Text style={S.none}>{t('sel.dossier.noScouting')}</Text>}
          </Card>
        )}

        {tab === 3 && (
          <Card style={S.section}>
            <Text style={S.sectionTitle}>{t('sel.dossier.tabVideo')}</Text>
            {(dossier.video_highlights ?? []).map(v => (
              <View key={v.id} style={S.vidRow}>
                <Text style={S.vidLabel}>{v.title ?? v.kind}</Text>
                <Text style={S.vidDate}>{v.created_at?.slice(0,10)}</Text>
              </View>
            ))}
            {(!dossier.video_highlights?.length) && <Text style={S.none}>{t('sel.dossier.noVideo')}</Text>}
          </Card>
        )}

        {tab === 4 && (
          <Card style={S.section}>
            <Text style={S.sectionTitle}>{t('sel.dossier.tabEligibility')}</Text>
            {(dossier.eligibility_checks ?? []).map(chk => (
              <View key={chk.id} style={S.chkRow}>
                <Text style={[S.chkResult, { color: chk.result === 'pass' ? C.lime : chk.result === 'fail' ? C.red : C.sun }]}>{chk.result.toUpperCase()}</Text>
                <Text style={S.chkType}>{chk.check_type}</Text>
                {chk.reason && <Text style={S.chkReason}>{chk.reason}</Text>}
              </View>
            ))}
          </Card>
        )}

        <Button
          label={t('sel.dossier.addToComparison')}
          onPress={() => nav.navigate('SelectionComparisonLab', { campaignId, addNominationId: nominationId })}
          icon="bar-chart"
          style={S.cta}
          accessibilityLabel={t('sel.dossier.addToComparison')}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32 },
  hero: { padding: 16, marginBottom: 16 },
  heroRow: { flexDirection: 'row', gap: 14, marginBottom: 14 },
  heroInfo: { flex: 1 },
  heroName: { fontSize: 20, fontWeight: '800', color: C.ink },
  heroSub: { fontSize: 13, color: C.mute, marginTop: 2 },
  heroBadges: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  warnings: { marginTop: 10 },
  warning: { fontSize: 12, color: C.sun, marginBottom: 4 },
  tabs: { marginBottom: 12 },
  section: { padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  metricRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  metricLabel: { flex: 1, fontSize: 13, color: C.ink },
  metricValue: { fontSize: 14, fontWeight: '700', color: C.pink, minWidth: 50, textAlign: 'right' },
  metricSource: { fontSize: 11, color: C.mute, minWidth: 60, textAlign: 'right', marginStart: 6 },
  metricBar: { flex: 1, height: 6, backgroundColor: C.line, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  metricFill: { height: 6, borderRadius: 3 },
  metricPerc: { fontSize: 12, color: C.mute, minWidth: 32, textAlign: 'right' },
  evalRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  evalName: { flex: 1, fontSize: 13, color: C.ink },
  evalScore: { fontSize: 14, fontWeight: '700', color: C.pink },
  evalDate: { fontSize: 11, color: C.mute, marginStart: 8 },
  vidRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  vidLabel: { flex: 1, fontSize: 13, color: C.ink },
  vidDate: { fontSize: 11, color: C.mute },
  chkRow: { marginBottom: 10 },
  chkResult: { fontSize: 12, fontWeight: '700' },
  chkType: { fontSize: 13, color: C.ink },
  chkReason: { fontSize: 12, color: C.mute },
  none: { color: C.mute, fontSize: 13 },
  cta: { marginTop: 8 },
});
