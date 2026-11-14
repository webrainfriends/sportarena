// Issue #1194: Comparison Lab — 2–12 players, SVG radar chart, percentile bars
import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Dimensions } from 'react-native';
import { Svg, Polygon, Circle, Line, Text as SvgText } from 'react-native-svg';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { MultiMenuField } from '../components/MultiMenuField';
import { useNavigation } from '@react-navigation/native';

const { width: SCREEN_W } = Dimensions.get('window');
const RADAR_SIZE = Math.min(SCREEN_W - 48, 320);
const CX = RADAR_SIZE / 2;
const CY = RADAR_SIZE / 2;
const R = CX - 32;

function radarPoint(angle, r) {
  const rad = (angle - 90) * (Math.PI / 180);
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function RadarChart({ axes, datasets, colors }) {
  if (!axes.length) return null;
  const angleStep = 360 / axes.length;
  const levels = [0.2, 0.4, 0.6, 0.8, 1.0];

  return (
    <Svg width={RADAR_SIZE} height={RADAR_SIZE} accessibilityLabel="Radar chart">
      {levels.map(lvl => {
        const pts = axes.map((_, i) => {
          const p = radarPoint(i * angleStep, R * lvl);
          return `${p.x},${p.y}`;
        }).join(' ');
        return <Polygon key={lvl} points={pts} fill="none" stroke="#CDD5E8" strokeWidth={1} />;
      })}
      {axes.map((axis, i) => {
        const p = radarPoint(i * angleStep, R);
        return <Line key={axis} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="#CDD5E8" strokeWidth={1} />;
      })}
      {axes.map((axis, i) => {
        const p = radarPoint(i * angleStep, R + 18);
        return <SvgText key={axis} x={p.x} y={p.y} textAnchor="middle" fontSize={10} fill="#5F6580">{axis}</SvgText>;
      })}
      {datasets.map((ds, di) => {
        const pts = axes.map((axis, i) => {
          const val = (ds.values[i] ?? 0) / 100;
          const p = radarPoint(i * angleStep, R * val);
          return `${p.x},${p.y}`;
        }).join(' ');
        return (
          <Polygon
            key={di}
            points={pts}
            fill={colors[di] + '44'}
            stroke={colors[di]}
            strokeWidth={2}
          />
        );
      })}
    </Svg>
  );
}

export default function SelectionComparisonLab({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId } = route?.params ?? {};
  const { data: nominations } = useApi(`/selection-campaigns/${campaignId}/nominations`);
  const { mutate: runComparison, data: result, loading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/comparison-scenarios`);
  const [selectedIds, setSelectedIds] = useState([]);
  const S = styles(C);

  const COLORS = [C.pink, C.cyan, C.lime, C.sun, C.red, '#9b59b6', '#e67e22', '#1abc9c', '#3498db', '#e74c3c', '#f39c12', '#2ecc71'];

  const nomOptions = (nominations ?? []).map(n => ({ value: n.id, label: n.candidate_name ?? n.candidate_id }));

  const run = () => runComparison({ candidate_ids: selectedIds, weights: {} });

  const axes = useMemo(() => {
    if (!result?.radar_data?.axes) return [];
    return result.radar_data.axes;
  }, [result]);

  const datasets = useMemo(() => {
    if (!result?.radar_data?.datasets) return [];
    return result.radar_data.datasets;
  }, [result]);

  const rankedCandidates = result?.ranked_candidates ?? [];

  return (
    <Screen title={t('sel.lab.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        <Card style={S.selectorCard}>
          <Text style={S.heading}>{t('sel.lab.selectPlayers')}</Text>
          <MultiMenuField
            label={t('sel.lab.players')}
            value={selectedIds}
            options={nomOptions}
            onChange={setSelectedIds}
            max={12}
            accessibilityLabel={t('sel.lab.players')}
          />
          <Button
            label={t('sel.lab.runComparison')}
            onPress={run}
            loading={loading}
            disabled={selectedIds.length < 2}
            accessibilityLabel={t('sel.lab.runComparison')}
          />
        </Card>

        {result && (
          <>
            <Card style={S.radarCard}>
              <Text style={S.heading}>{t('sel.lab.radarChart')}</Text>
              <View style={S.radarContainer}>
                <RadarChart axes={axes} datasets={datasets} colors={COLORS} />
              </View>
              <View style={S.legend}>
                {datasets.map((ds, i) => (
                  <View key={i} style={S.legendItem}>
                    <View style={[S.legendDot, { backgroundColor: COLORS[i] }]} />
                    <Text style={S.legendLabel}>{ds.label}</Text>
                  </View>
                ))}
              </View>
            </Card>

            <Card style={S.rankCard}>
              <Text style={S.heading}>{t('sel.lab.ranking')}</Text>
              {rankedCandidates.map((c, idx) => (
                <View key={c.candidate_id} style={S.rankRow}>
                  <Text style={S.rankNum}>{idx + 1}</Text>
                  <View style={S.rankBar}>
                    <View style={[S.rankFill, { width: `${Math.round(c.score ?? 0)}%`, backgroundColor: COLORS[idx % COLORS.length] }]} />
                  </View>
                  <Text style={S.rankName}>{c.candidate_name}</Text>
                  <Text style={S.rankScore}>{(c.score ?? 0).toFixed(1)}</Text>
                </View>
              ))}
            </Card>

            {result.sensitivity_analysis && (
              <Card style={S.sensitivityCard}>
                <Text style={S.heading}>{t('sel.lab.sensitivity')}</Text>
                <Text style={S.hint}>{t('sel.lab.sensitivityHint')}</Text>
                {Object.entries(result.sensitivity_analysis).map(([k, v]) => (
                  <View key={k} style={S.sensRow}>
                    <Text style={S.sensKey}>{k}</Text>
                    <Text style={S.sensVal}>{JSON.stringify(v).slice(0, 60)}</Text>
                  </View>
                ))}
              </Card>
            )}

            <Button
              label={t('sel.lab.saveScenario')}
              onPress={() => {/* save handled by API already */}}
              variant="outline"
              style={S.saveBtn}
              accessibilityLabel={t('sel.lab.saveScenario')}
            />
            <Button
              label={t('sel.lab.formationCanvas')}
              onPress={() => nav.navigate('SelectionScenarioSimulator', { campaignId, result })}
              icon="layout"
              style={S.saveBtn}
              accessibilityLabel={t('sel.lab.formationCanvas')}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  selectorCard: { padding: 16, marginBottom: 16 },
  radarCard: { padding: 16, marginBottom: 16, alignItems: 'center' },
  rankCard: { padding: 16, marginBottom: 16 },
  sensitivityCard: { padding: 16, marginBottom: 16 },
  heading: { fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 12 },
  radarContainer: { alignItems: 'center', justifyContent: 'center' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 12, color: C.ink },
  rankRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  rankNum: { fontSize: 13, fontWeight: '700', color: C.mute, width: 20 },
  rankBar: { flex: 1, height: 8, backgroundColor: C.line, borderRadius: 4, overflow: 'hidden' },
  rankFill: { height: 8, borderRadius: 4 },
  rankName: { fontSize: 13, color: C.ink, minWidth: 90 },
  rankScore: { fontSize: 14, fontWeight: '700', color: C.pink, minWidth: 36, textAlign: 'right' },
  hint: { fontSize: 12, color: C.mute, marginBottom: 8 },
  sensRow: { flexDirection: 'row', marginBottom: 4 },
  sensKey: { fontSize: 12, color: C.ink, fontWeight: '600', minWidth: 100 },
  sensVal: { fontSize: 12, color: C.mute },
  saveBtn: { marginBottom: 10 },
});
