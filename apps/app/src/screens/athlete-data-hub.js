// Athlete Data Hub screen (#566). Four tabs: Overview, Metrics, Assessments, Sources.
// Works on iOS, iPadOS, Android and web from one React Native / Expo codebase.
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from '../i18n/core.js';
import { useTheme } from '../theme.js';
import { api } from '../api.js';

const TABS = ['overview', 'metrics', 'assessments', 'sources'];

const METRIC_FAMILIES = {
  performance: ['max_speed', 'acceleration', 'sprint_10m', 'sprint_30m', 'sprint_40m'],
  jump:        ['jump_height', 'jump_power', 'peak_force', 'rate_of_force_dev'],
  load:        ['training_load', 'distance', 'sprint_distance', 'steps', 'active_energy'],
  recovery:    ['resting_hr', 'hrv_rmssd', 'sleep_duration', 'sleep_quality', 'spo2', 'vo2max'],
  body:        ['body_fat_pct', 'lean_mass', 'muscle_mass', 'squat_1rm', 'deadlift_1rm', 'bench_1rm'],
};

export default function AthleteDataHub({ navigation }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [tab, setTab] = useState('overview');
  const [hub, setHub] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [selectedMetric, setSelectedMetric] = useState(null);
  const [assessments, setAssessments] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const styles = makeStyles(colors);

  const loadHub = useCallback(async () => {
    try {
      const data = await api.get('/me/data-hub');
      setHub(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadAssessments = useCallback(async () => {
    const data = await api.get('/me/assessments?limit=50');
    setAssessments(data);
  }, []);

  const loadTimeline = useCallback(async (mk) => {
    setSelectedMetric(mk);
    setTimeline(null);
    const data = await api.get(`/me/data-hub/metrics/${mk}`);
    setTimeline(data);
  }, []);

  useEffect(() => { loadHub(); }, [loadHub]);
  useEffect(() => { if (tab === 'assessments' && !assessments) loadAssessments(); }, [tab, assessments, loadAssessments]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadHub(); }, [loadHub]);

  const qualityColor = (quality = []) => quality.includes('out_of_range') ? '#FF9800' : colors.text;

  const acwrZoneColor = (ratio) => {
    if (!ratio) return colors.textMuted;
    if (ratio <= 1.3) return '#4CAF50';
    if (ratio <= 1.5) return '#FF9800';
    return '#F44336';
  };

  const readinessColor = (score) => {
    if (score == null) return colors.textMuted;
    if (score >= 70) return '#4CAF50';
    if (score >= 50) return '#FF9800';
    return '#F44336';
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((tKey) => (
          <TouchableOpacity
            key={tKey}
            style={[styles.tab, tab === tKey && styles.tabActive]}
            onPress={() => setTab(tKey)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === tKey }}
            accessibilityLabel={t(`adhub.tab.${tKey}`)}
          >
            <Text style={[styles.tabText, tab === tKey && styles.tabTextActive]}>
              {t(`adhub.tab.${tKey}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'overview' && (
        <ScrollView
          style={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          <View style={styles.disclaimerBand}>
            <Text style={styles.disclaimerText}>{hub?.disclaimer ?? t('adhub.disclaimer')}</Text>
          </View>
          <View style={styles.stripRow}>
            <View style={[styles.stripCard, { flex: 1 }]}>
              <Text style={styles.stripLabel}>{t('adhub.readiness')}</Text>
              <Text style={[styles.stripValue, { color: readinessColor(hub?.readiness?.score) }]}>
                {hub?.readiness?.score != null ? String(hub.readiness.score) : '—'}
              </Text>
              <Text style={styles.stripUnit}>{t('adhub.score')}</Text>
            </View>
            <View style={[styles.stripCard, { flex: 1 }]}>
              <Text style={styles.stripLabel}>{t('adhub.acwr')}</Text>
              <Text style={[styles.stripValue, { color: acwrZoneColor(hub?.acwr?.ratio) }]}>
                {hub?.acwr?.ratio != null ? hub.acwr.ratio.toFixed(2) : '—'}
              </Text>
              <Text style={styles.stripUnit}>{t('adhub.ratio')}</Text>
            </View>
          </View>
          {Object.entries(METRIC_FAMILIES).map(([family, keys]) => {
            const familyMetrics = (hub?.metrics ?? []).filter((m) => keys.includes(m.metric_key));
            if (!familyMetrics.length) return null;
            return (
              <View key={family} style={styles.familySection}>
                <Text style={styles.familyTitle}>{t(`adhub.family.${family}`)}</Text>
                <View style={styles.metricGrid}>
                  {familyMetrics.map((m) => (
                    <TouchableOpacity
                      key={m.metric_key}
                      style={styles.metricTile}
                      onPress={() => { setTab('metrics'); loadTimeline(m.metric_key); }}
                      accessibilityLabel={`${m.label} ${m.value} ${m.unit}`}
                    >
                      <Text style={styles.metricLabel} numberOfLines={1}>{m.label}</Text>
                      <Text style={[styles.metricValue, { color: qualityColor(m.quality) }]}>
                        {m.value != null ? String(m.value) : '—'}
                        <Text style={styles.metricUnit}> {m.unit}</Text>
                      </Text>
                      <Text style={styles.metricSource} numberOfLines={1}>{m.provider} · {m.recorded_on}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            );
          })}
          {(hub?.assessments ?? []).length > 0 && (
            <View style={styles.familySection}>
              <Text style={styles.familyTitle}>{t('adhub.assessmentHistory')}</Text>
              {hub.assessments.map((a) => (
                <View key={a.assessment_family} style={styles.assessmentRow}>
                  <Text style={styles.assessmentFamily}>{a.assessment_family}</Text>
                  <Text style={styles.assessmentCount}>{a.count} {t('adhub.tests')} · {t('adhub.latest')} {a.latest}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {tab === 'metrics' && (
        <ScrollView style={styles.scroll}>
          {selectedMetric && timeline ? (
            <View>
              <TouchableOpacity style={styles.backRow} onPress={() => { setSelectedMetric(null); setTimeline(null); }}>
                <Text style={styles.backText}>← {t('common.back')}</Text>
              </TouchableOpacity>
              <Text style={styles.sectionTitle}>{selectedMetric}</Text>
              <Text style={styles.bodyText}>{t('adhub.last90days')}</Text>
              {(timeline.points ?? []).map((p, i) => (
                <View key={i} style={styles.timelineRow}>
                  <Text style={styles.timelineDate}>{String(p.on)}</Text>
                  <Text style={styles.timelineVal}>{p.value} {p.unit}</Text>
                  <Text style={styles.timelineProv}>{p.provider}</Text>
                  {(p.quality ?? []).length > 0 && (
                    <Text style={styles.qualityFlag}>{p.quality.join(', ')}</Text>
                  )}
                </View>
              ))}
            </View>
          ) : (
            Object.entries(METRIC_FAMILIES).map(([family, keys]) => (
              <View key={family} style={styles.familySection}>
                <Text style={styles.familyTitle}>{t(`adhub.family.${family}`)}</Text>
                {keys.map((mk) => {
                  const m = (hub?.metrics ?? []).find((x) => x.metric_key === mk);
                  return (
                    <TouchableOpacity
                      key={mk}
                      style={styles.metricListRow}
                      onPress={() => loadTimeline(mk)}
                      accessibilityLabel={`${mk} ${m?.value ?? '—'}`}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.metricLabel}>{m?.label ?? mk}</Text>
                        <Text style={styles.metricSource}>{m ? `${m.provider} · ${m.recorded_on}` : t('adhub.noData')}</Text>
                      </View>
                      <Text style={[styles.metricValue, { color: qualityColor(m?.quality) }]}>
                        {m?.value != null ? `${m.value} ${m.unit}` : '—'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))
          )}
        </ScrollView>
      )}

      {tab === 'assessments' && (
        <ScrollView style={styles.scroll}>
          {!assessments ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : assessments.total === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>{t('adhub.assessments.empty.title')}</Text>
              <Text style={styles.emptyBody}>{t('adhub.assessments.empty.body')}</Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => navigation.push('CreateAssessment')}
                accessibilityRole="button"
                accessibilityLabel={t('adhub.addAssessment')}
              >
                <Text style={styles.primaryBtnText}>{t('adhub.addAssessment')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              <TouchableOpacity
                style={[styles.primaryBtn, { margin: 16 }]}
                onPress={() => navigation.push('CreateAssessment')}
                accessibilityRole="button"
                accessibilityLabel={t('adhub.addAssessment')}
              >
                <Text style={styles.primaryBtnText}>{t('adhub.addAssessment')}</Text>
              </TouchableOpacity>
              {(assessments.items ?? []).map((a) => (
                <TouchableOpacity
                  key={a.id}
                  style={styles.assessmentCard}
                  onPress={() => navigation.push('AssessmentDetail', { id: a.id })}
                  accessibilityLabel={`${a.test_protocol} ${a.assessed_on}`}
                >
                  <View style={styles.assessmentCardHeader}>
                    <View style={styles.chip}><Text style={styles.chipText}>{a.assessment_family}</Text></View>
                    <Text style={styles.assessmentDate}>{a.assessed_on}</Text>
                  </View>
                  <Text style={styles.assessmentProtocol}>{a.test_protocol}</Text>
                  <Text style={styles.assessmentCount}>{a.measurement_count} {t('adhub.measurements')} · {a.provider}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {tab === 'sources' && (
        <ScrollView style={styles.scroll}>
          <Text style={styles.sectionTitle}>{t('adhub.sources.wearables')}</Text>
          {(hub?.sources ?? []).length === 0 ? (
            <Text style={[styles.emptyBody, { margin: 16 }]}>{t('adhub.sources.empty')}</Text>
          ) : (
            (hub?.sources ?? []).map((s) => (
              <View key={s.id} style={styles.sourceRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sourceProvider}>{s.provider_key}</Text>
                  <Text style={styles.sourceStatus}>
                    {s.status} · {s.last_success_at ? String(s.last_success_at).slice(0, 10) : t('adhub.neverSynced')}
                  </Text>
                </View>
                <View style={[styles.statusDot, { backgroundColor: s.status === 'connected' ? '#4CAF50' : '#FF9800' }]} />
              </View>
            ))
          )}
          <TouchableOpacity
            style={[styles.primaryBtn, { margin: 16 }]}
            onPress={() => navigation.push('ConnectProvider')}
            accessibilityRole="button"
            accessibilityLabel={t('adhub.addSource')}
          >
            <Text style={styles.primaryBtnText}>{t('adhub.addSource')}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container:           { flex: 1, backgroundColor: colors.bg },
    tabBar:              { flexDirection: 'row', backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
    tab:                 { flex: 1, paddingVertical: 12, alignItems: 'center', minHeight: 44 },
    tabActive:           { borderBottomWidth: 2, borderBottomColor: colors.primary },
    tabText:             { fontSize: 12, color: colors.textMuted },
    tabTextActive:       { color: colors.primary, fontWeight: '600' },
    scroll:              { flex: 1 },
    disclaimerBand:      { backgroundColor: colors.cardMuted, margin: 12, padding: 10, borderRadius: 8 },
    disclaimerText:      { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
    stripRow:            { flexDirection: 'row', marginHorizontal: 12, gap: 8, marginBottom: 8 },
    stripCard:           { backgroundColor: colors.card, padding: 14, borderRadius: 12, alignItems: 'center' },
    stripLabel:          { fontSize: 11, color: colors.textMuted, marginBottom: 4 },
    stripValue:          { fontSize: 32, fontWeight: '700' },
    stripUnit:           { fontSize: 11, color: colors.textMuted },
    familySection:       { marginHorizontal: 12, marginBottom: 16 },
    familyTitle:         { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
    metricGrid:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    metricTile:          { backgroundColor: colors.card, padding: 12, borderRadius: 10, minWidth: 140, flex: 1 },
    metricLabel:         { fontSize: 11, color: colors.textMuted, marginBottom: 2 },
    metricValue:         { fontSize: 20, fontWeight: '700', color: colors.text },
    metricUnit:          { fontSize: 11, fontWeight: '400', color: colors.textMuted },
    metricSource:        { fontSize: 10, color: colors.textMuted, marginTop: 4 },
    metricListRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, padding: 14, marginBottom: 1, borderRadius: 8 },
    assessmentRow:       { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
    assessmentFamily:    { fontSize: 14, color: colors.text, fontWeight: '600' },
    assessmentCount:     { fontSize: 12, color: colors.textMuted },
    assessmentCard:      { backgroundColor: colors.card, margin: 12, marginBottom: 0, padding: 14, borderRadius: 12 },
    assessmentCardHeader:{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    assessmentDate:      { fontSize: 12, color: colors.textMuted },
    assessmentProtocol:  { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
    chip:                { backgroundColor: colors.primaryLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    chipText:            { fontSize: 11, color: colors.primary, fontWeight: '600' },
    timelineRow:         { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, marginHorizontal: 16 },
    timelineDate:        { width: 90, fontSize: 12, color: colors.textMuted },
    timelineVal:         { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
    timelineProv:        { fontSize: 11, color: colors.textMuted },
    qualityFlag:         { fontSize: 10, color: '#FF9800', marginStart: 6 },
    sectionTitle:        { fontSize: 16, fontWeight: '700', color: colors.text, margin: 16, marginBottom: 8 },
    bodyText:            { fontSize: 13, color: colors.textMuted, marginHorizontal: 16, marginBottom: 8 },
    backRow:             { paddingHorizontal: 16, paddingVertical: 10 },
    backText:            { color: colors.primary, fontSize: 14 },
    emptyState:          { alignItems: 'center', padding: 40 },
    emptyTitle:          { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
    emptyBody:           { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
    primaryBtn:          { backgroundColor: colors.primary, padding: 14, borderRadius: 10, alignItems: 'center', minHeight: 44 },
    primaryBtnText:      { color: '#fff', fontWeight: '700', fontSize: 15 },
    sourceRow:           { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, padding: 14, marginBottom: 1 },
    sourceProvider:      { fontSize: 14, fontWeight: '600', color: colors.text },
    sourceStatus:        { fontSize: 12, color: colors.textMuted },
    statusDot:           { width: 10, height: 10, borderRadius: 5 },
  });
}
