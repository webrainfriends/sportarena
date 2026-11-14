// Issue #1194: Outcomes Review — forecast vs actual, calibration, post-campaign analysis
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { Avatar } from '../components/Avatar';
import { MetricStrip } from '../components/MetricStrip';
import { useNavigation } from '@react-navigation/native';

function ForecastRow({ nom, C, S, t }) {
  const delta = (nom.actual_rank ?? 0) - (nom.forecast_rank ?? 0);
  const deltaColor = delta === 0 ? C.mute : delta < 0 ? C.lime : C.red;
  const deltaLabel = delta === 0 ? '—' : delta > 0 ? `+${delta}` : `${delta}`;
  return (
    <View style={S.forecastRow}>
      <Avatar userId={nom.candidate_id} size={32} />
      <View style={S.forecastInfo}>
        <Text style={S.forecastName} numberOfLines={1}>{nom.candidate_name ?? '—'}</Text>
        <Text style={S.forecastPos}>{nom.position ?? ''}</Text>
      </View>
      <View style={S.rankCol}>
        <Text style={S.rankLabel}>{t('sel.outcomes.forecast')}</Text>
        <Text style={S.rankVal}>{nom.forecast_rank ?? '—'}</Text>
      </View>
      <View style={S.rankCol}>
        <Text style={S.rankLabel}>{t('sel.outcomes.actual')}</Text>
        <Text style={S.rankVal}>{nom.actual_rank ?? '—'}</Text>
      </View>
      <Chip label={deltaLabel} color={deltaColor} size="xs" />
    </View>
  );
}

export default function SelectionOutcomesReview({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId } = route?.params ?? {};
  const { data: campaign } = useApi(`/selection-campaigns/${campaignId}`);
  const { data: pack } = useApi(`/selection/campaigns/${campaignId}/decision-pack`);
  const { data: nominations } = useApi(`/selection-campaigns/${campaignId}/nominations`);
  const S = styles(C);

  const starters = (pack?.roster_snapshot?.starters ?? []).length;
  const reserves = (pack?.roster_snapshot?.reserves ?? []).length;
  const development = (pack?.roster_snapshot?.development_list ?? []).length;

  const withForecast = (nominations ?? []).filter(n => n.forecast_rank != null);

  const mae = campaign?.forecast_mae;
  const confidence = campaign?.forecast_confidence_pct;
  const modelVersion = campaign?.forecast_model_version;

  return (
    <Screen title={t('sel.outcomes.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Campaign header */}
        <Card style={S.headerCard}>
          <Text style={S.campaignName} numberOfLines={1}>{campaign?.name ?? '—'}</Text>
          <Text style={S.campaignSub}>{campaign?.sport_name ?? '—'} · {campaign?.purpose ?? '—'}</Text>
        </Card>

        {/* Summary strip */}
        <MetricStrip items={[
          { label: t('sel.outcomes.starters'), value: starters },
          { label: t('sel.outcomes.reserves'), value: reserves },
          { label: t('sel.outcomes.development'), value: development },
        ]} />

        {/* Forecast vs actual */}
        {withForecast.length > 0 && (
          <Card style={S.card}>
            <Text style={S.sectionTitle}>{t('sel.outcomes.forecastVsActual')}</Text>
            <Text style={S.hint}>{t('sel.outcomes.forecastHint')}</Text>
            {withForecast.map(nom => (
              <ForecastRow key={nom.id} nom={nom} C={C} S={S} t={t} />
            ))}
          </Card>
        )}

        {/* Calibration */}
        {(mae != null || confidence != null) && (
          <Card style={S.card}>
            <Text style={S.sectionTitle}>{t('sel.outcomes.calibration')}</Text>
            <View style={S.calibRow}>
              {mae != null && (
                <View style={S.calibMetric}>
                  <Text style={S.calibVal}>{mae.toFixed(1)}</Text>
                  <Text style={S.calibLabel}>{t('sel.outcomes.mae')}</Text>
                </View>
              )}
              {confidence != null && (
                <View style={S.calibMetric}>
                  <Text style={S.calibVal}>{confidence}%</Text>
                  <Text style={S.calibLabel}>{t('sel.outcomes.confidence')}</Text>
                </View>
              )}
              {modelVersion && (
                <View style={S.calibMetric}>
                  <Text style={S.calibVal}>{modelVersion}</Text>
                  <Text style={S.calibLabel}>{t('sel.outcomes.modelVersion')}</Text>
                </View>
              )}
            </View>
          </Card>
        )}

        {/* Published roster summary */}
        {pack?.roster_snapshot && (
          <Card style={S.card}>
            <Text style={S.sectionTitle}>{t('sel.outcomes.publishedRoster')}</Text>
            {['starters', 'reserves', 'development_list'].map(cat => {
              const list = pack.roster_snapshot[cat] ?? [];
              if (!list.length) return null;
              return (
                <View key={cat} style={S.rosterSection}>
                  <Text style={S.rosterCat}>{t(`sel.outcomes.${cat}`)}</Text>
                  {list.map((p, i) => (
                    <View key={p.id ?? i} style={S.rosterRow}>
                      <Avatar userId={p.id} size={28} />
                      <Text style={S.rosterName}>{p.name ?? p.id ?? '—'}</Text>
                      {p.position && <Text style={S.rosterPos}>{p.position}</Text>}
                    </View>
                  ))}
                </View>
              );
            })}
          </Card>
        )}

        {/* Published but no forecast data yet */}
        {withForecast.length === 0 && mae == null && (
          <Card style={S.emptyCard}>
            <Text style={S.emptyText}>{t('sel.outcomes.noForecastData')}</Text>
          </Card>
        )}

        <Button
          label={t('sel.outcomes.viewDecisionPack')}
          onPress={() => nav.navigate('SelectionDecisionPack', { campaignId })}
          variant="outline"
          icon="file-text"
          accessibilityLabel={t('sel.outcomes.viewDecisionPack')}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  headerCard: { padding: 14, marginBottom: 14 },
  campaignName: { fontSize: 16, fontWeight: '700', color: C.ink },
  campaignSub: { fontSize: 12, color: C.mute, marginTop: 2 },
  card: { padding: 16, marginBottom: 14 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 10 },
  hint: { fontSize: 12, color: C.mute, marginBottom: 10 },
  forecastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  forecastInfo: { flex: 1 },
  forecastName: { fontSize: 13, fontWeight: '600', color: C.ink },
  forecastPos: { fontSize: 11, color: C.mute },
  rankCol: { alignItems: 'center', minWidth: 44 },
  rankLabel: { fontSize: 10, color: C.mute },
  rankVal: { fontSize: 14, fontWeight: '700', color: C.ink },
  calibRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  calibMetric: { alignItems: 'center', minWidth: 80, padding: 12, backgroundColor: C.bg, borderRadius: 10 },
  calibVal: { fontSize: 22, fontWeight: '800', color: C.ink },
  calibLabel: { fontSize: 11, color: C.mute, marginTop: 2 },
  rosterSection: { marginBottom: 12 },
  rosterCat: { fontSize: 12, fontWeight: '700', color: C.mute, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  rosterName: { flex: 1, fontSize: 13, color: C.ink },
  rosterPos: { fontSize: 11, color: C.mute },
  emptyCard: { padding: 16, marginBottom: 14 },
  emptyText: { fontSize: 13, color: C.mute, textAlign: 'center' },
});
