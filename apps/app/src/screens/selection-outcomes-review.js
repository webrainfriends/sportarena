// Issue #1211: Post-selection outcomes — forecast vs actual, development feedback, fairness, calibration
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Share, Platform } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Card, Chip, Empty, Field, Screen, StatPill } from '../ui';
import { useApi, useApiMutation } from '../api';

const VERDICT_COLOR = (verdict, C) => ({
  exceeded: C.lime,
  met: C.cyan,
  below: C.red,
  insufficient: C.mute,
})[verdict] ?? C.mute;

export default function SelectionOutcomesReview({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const { campaignId } = route?.params ?? {};

  const { data: outcomes } = useApi(`/selection/campaigns/${campaignId}/outcomes`);
  const { mutate: saveLessons, loading: saving } = useApiMutation('POST', `/selection-campaigns/${campaignId}/audit`);

  const [lessons, setLessons] = useState('');
  const S = styles(C);

  const exportPDF = () => {
    if (Platform.OS === 'web') {
      if (outcomes?.pdf_url) window.open(outcomes.pdf_url, '_blank');
    } else {
      Share.share({ url: outcomes?.pdf_url ?? '', title: t('sel.outcomes.exportPDF') });
    }
  };

  const exportXLSX = () => {
    if (Platform.OS === 'web') {
      if (outcomes?.xlsx_url) window.open(outcomes.xlsx_url, '_blank');
    } else {
      Share.share({ url: outcomes?.xlsx_url ?? '', title: t('sel.outcomes.exportXLSX') });
    }
  };

  const onSaveLessons = async () => {
    if (!lessons.trim()) return;
    await saveLessons({ event_type: 'outcomes_review', payload: { lessons_enc: lessons } });
    setLessons('');
  };

  const camp = outcomes?.campaign;
  const forecastRows = outcomes?.forecast_vs_actual ?? [];
  const devRows = outcomes?.development_outcomes ?? [];
  const fairness = outcomes?.fairness ?? {};
  const calibration = outcomes?.calibration ?? {};

  return (
    <Screen title={t('sel.outcomes.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>

        {/* Campaign summary */}
        <Card style={S.card}>
          <Text style={S.heading}>{camp?.name ?? '—'}</Text>
          <View style={S.row}>
            <Text style={S.label}>{camp?.season ?? '—'}</Text>
            <Chip label={camp?.status ?? 'completed'} color={C.lime} size="xs" />
          </View>
          <Text style={S.muted}>{camp?.team_name ?? '—'} · {camp?.approval_date?.slice(0, 10) ?? '—'}</Text>
          <MetricStrip
            items={[
              { label: t('sel.recommendation.starters'), value: outcomes?.starters_count ?? 0 },
              { label: t('sel.recommendation.reserves'), value: outcomes?.reserves_count ?? 0 },
              { label: t('sel.recommendation.development'), value: outcomes?.development_count ?? 0 },
            ]}
            style={S.metricStrip}
          />
        </Card>

        {/* Forecast vs Actual */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.forecastVsActual')}</Text>
          {forecastRows.length === 0 ? (
            <Empty icon="bar-chart-2" title={t('sel.outcomes.forecastVsActual')} body={t('sel.outcomes.insufficientData')} />
          ) : forecastRows.map((row, idx) => (
            <View key={row.nomination_id ?? idx} style={S.forecastRow}>
              <View style={S.forecastPlayer}>
                <Text style={S.playerName} numberOfLines={1}>{row.player_name}</Text>
                {row.position && <Chip label={row.position} color={C.violet} size="xs" />}
              </View>
              <View style={S.forecastData}>
                <Text style={S.forecastRange}>{row.forecast_range ?? '—'}</Text>
                <Text style={S.arrow}>→</Text>
                <Text style={S.actualVal}>{row.actual_value ?? '—'}</Text>
                <Chip
                  label={t(`sel.outcomes.${row.verdict ?? 'insufficient'}`)}
                  color={VERDICT_COLOR(row.verdict, C)}
                  size="xs"
                />
              </View>
            </View>
          ))}
        </Card>

        {/* Development outcomes */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.developmentOutcomes')}</Text>
          <MetricStrip
            items={[
              { label: t('sel.outcomes.nomVsSelected'), value: `${outcomes?.nominated_count ?? 0} / ${outcomes?.selected_count ?? 0}` },
              { label: t('sel.recommendation.development'), value: devRows.length },
            ]}
            style={S.metricStrip}
          />
          {devRows.length === 0 ? (
            <Text style={S.empty}>—</Text>
          ) : devRows.map((row, idx) => (
            <View key={row.nomination_id ?? idx} style={S.devRow}>
              <View style={S.devPlayer}>
                <Text style={S.playerName} numberOfLines={1}>{row.player_name}</Text>
                {row.position && <Text style={S.posText}>{row.position}</Text>}
              </View>
              <View style={S.devRight}>
                <Chip
                  label={row.dev_progress ?? t('sel.outcomes.developmentPlan')}
                  color={row.dev_plan_assigned ? C.lime : C.mute}
                  size="xs"
                />
              </View>
            </View>
          ))}
        </Card>

        {/* Fairness strip */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.fairnessStrip')}</Text>
          {fairness.disparity_flag && (
            <View style={[S.warningBanner, { backgroundColor: C.sun + '22', borderLeftColor: C.sun }]}>
              <Text style={[S.warningText, { color: C.sun }]}>{t('sel.outcomes.disparityWarning')}</Text>
            </View>
          )}
          <MetricStrip
            items={[
              { label: t('sel.outcomes.ageGroups'), value: fairness.age_groups_covered ?? '—' },
              { label: t('sel.outcomes.positionsCovered'), value: fairness.positions_covered ?? '—' },
              { label: t('sel.outcomes.selectionRate'), value: fairness.selection_rate ? `${fairness.selection_rate}%` : '—' },
            ]}
          />
        </Card>

        {/* Lessons learned */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.lessonsLearned')}</Text>
          <TextField
            value={lessons}
            onChangeText={setLessons}
            multiline
            numberOfLines={5}
            placeholder={t('sel.outcomes.lessonsLearned')}
            style={S.lessonsField}
            accessibilityLabel={t('sel.outcomes.lessonsLearned')}
          />
          <Button
            label={t('sel.outcomes.saveObservations')}
            onPress={onSaveLessons}
            loading={saving}
            disabled={!lessons.trim()}
            accessibilityLabel={t('sel.outcomes.saveObservations')}
          />
        </Card>

        {/* Forecast calibration */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.calibration')}</Text>
          {!calibration.mae && !calibration.confidence_coverage ? (
            <Empty icon="bar-chart-2" title={t('sel.outcomes.calibration')} body={t('sel.outcomes.insufficientData')} />
          ) : (
            <>
              <View style={S.row}>
                <Text style={S.label}>{t('sel.outcomes.maeLabel')}</Text>
                <Text style={S.val}>{calibration.mae ?? '—'}</Text>
              </View>
              <View style={S.row}>
                <Text style={S.label}>{t('sel.outcomes.confidenceCoverage')}</Text>
                <Text style={S.val}>{calibration.confidence_coverage ? `${calibration.confidence_coverage}%` : '—'}</Text>
              </View>
              <View style={S.row}>
                <Text style={S.label}>{t('sel.outcomes.modelVersion')}</Text>
                <Chip label={calibration.model_version ?? '—'} color={C.violet} size="xs" />
              </View>
            </>
          )}
        </Card>

        {/* Export */}
        <Card style={S.card}>
          <Text style={S.heading}>{t('sel.outcomes.export')}</Text>
          <View style={S.exportRow}>
            <Button
              label={t('sel.outcomes.exportPDF')}
              icon="file-text"
              onPress={exportPDF}
              style={{ flex: 1 }}
              accessibilityLabel={t('sel.outcomes.exportPDF')}
            />
            <Button
              label={t('sel.outcomes.exportXLSX')}
              icon="download"
              variant="outline"
              onPress={exportXLSX}
              style={{ flex: 1 }}
              accessibilityLabel={t('sel.outcomes.exportXLSX')}
            />
          </View>
        </Card>

      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  card: { padding: 16, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line },
  label: { fontSize: 13, color: C.mute },
  val: { fontSize: 13, fontWeight: '700', color: C.ink },
  muted: { fontSize: 12, color: C.mute, marginBottom: 8 },
  empty: { fontSize: 13, color: C.mute },
  metricStrip: { marginTop: 8 },
  forecastRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  forecastPlayer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  playerName: { fontSize: 14, fontWeight: '700', color: C.ink, flex: 1 },
  forecastData: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  forecastRange: { fontSize: 12, color: C.mute },
  arrow: { fontSize: 12, color: C.mute },
  actualVal: { fontSize: 13, fontWeight: '700', color: C.ink, flex: 1 },
  devRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  devPlayer: { flex: 1 },
  posText: { fontSize: 11, color: C.mute, marginTop: 2 },
  devRight: { alignItems: 'flex-end' },
  warningBanner: { borderLeftWidth: 4, borderRadius: 6, padding: 10, marginBottom: 12 },
  warningText: { fontSize: 13, fontWeight: '600' },
  lessonsField: { marginBottom: 12 },
  exportRow: { flexDirection: 'row', gap: 10 },
});
