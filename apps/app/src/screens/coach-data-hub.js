// Coach Data Hub screen (#566). Four tabs: Squad, Load Trends, Session Response, Missing Data.
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

const TABS = ['squad', 'load', 'session', 'missing'];
const LOAD_METRICS = ['training_load', 'distance', 'active_energy', 'steps'];

export default function CoachDataHub({ navigation, route }) {
  const orgId = route?.params?.orgId;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [tab, setTab] = useState('squad');
  const [hub, setHub] = useState(null);
  const [squadMetric, setSquadMetric] = useState({ data: null, metric: 'training_load' });
  const [missing, setMissing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const styles = makeStyles(colors);

  const loadHub = useCallback(async () => {
    if (!orgId) { setLoading(false); return; }
    try {
      const data = await api.get(`/orgs/${orgId}/data-hub`);
      setHub(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId]);

  const loadSquadMetric = useCallback(async (mk) => {
    setSquadMetric((prev) => ({ ...prev, metric: mk, data: null }));
    const data = await api.get(`/orgs/${orgId}/data-hub/squad?metric_key=${mk}`);
    setSquadMetric({ data, metric: mk });
  }, [orgId]);

  const loadMissing = useCallback(async () => {
    if (!orgId || missing) return;
    const data = await api.get(`/orgs/${orgId}/data-hub/missing`);
    setMissing(data);
  }, [orgId, missing]);

  useEffect(() => { loadHub(); }, [loadHub]);
  useEffect(() => { if (tab === 'load' && !squadMetric.data) loadSquadMetric('training_load'); }, [tab]);
  useEffect(() => { if (tab === 'missing') loadMissing(); }, [tab, loadMissing]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadHub(); }, [loadHub]);

  const acwrZone = (ratio) => {
    if (!ratio) return { label: '—', color: colors.textMuted };
    if (ratio <= 1.3) return { label: 'Optimal', color: '#4CAF50' };
    if (ratio <= 1.5) return { label: 'Caution', color: '#FF9800' };
    return { label: 'High risk', color: '#F44336' };
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  const stripItems = [
    { label: t('cdh.squadSize'),    value: hub?.squad_size ?? '—',          warn: false },
    { label: t('cdh.avgReadiness'), value: hub?.avg_readiness ?? '—',       warn: false },
    { label: t('cdh.acwrAlerts'),   value: hub?.acwr_alert_count ?? '—',    warn: (hub?.acwr_alert_count ?? 0) > 0 },
    { label: t('cdh.missingData'),  value: hub?.missing_data_count ?? '—',  warn: (hub?.missing_data_count ?? 0) > 0 },
  ];

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
            accessibilityLabel={t(`cdh.tab.${tKey}`)}
          >
            <Text style={[styles.tabText, tab === tKey && styles.tabTextActive]}>
              {t(`cdh.tab.${tKey}`)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'squad' && (
        <ScrollView
          style={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          <View style={styles.stripRow}>
            {stripItems.map(({ label, value, warn }) => (
              <View key={label} style={[styles.stripCard, { flex: 1 }]}>
                <Text style={styles.stripLabel}>{label}</Text>
                <Text style={[styles.stripValue, warn && { color: '#FF9800' }]}>{String(value)}</Text>
              </View>
            ))}
          </View>
          {(hub?.athletes ?? []).map((a) => {
            const zone = acwrZone(a.acwr?.ratio);
            return (
              <TouchableOpacity
                key={a.id}
                style={styles.athleteRow}
                onPress={() => navigation.push('AthleteDataHub', { athleteId: a.id, orgId })}
                accessibilityLabel={`${a.full_name} readiness ${a.readiness?.score ?? '—'}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.athleteName}>{a.full_name}</Text>
                  <Text style={styles.athleteSub}>
                    {t('cdh.lastSync')}: {a.last_sync ? String(a.last_sync).slice(0, 10) : t('cdh.never')}
                  </Text>
                </View>
                <View style={styles.athleteMetrics}>
                  <Text style={styles.readinessVal}>{a.readiness?.score ?? '—'}</Text>
                  <View style={[styles.acwrChip, { backgroundColor: zone.color + '22' }]}>
                    <Text style={[styles.acwrChipText, { color: zone.color }]}>{zone.label}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {tab === 'load' && (
        <ScrollView style={styles.scroll}>
          <Text style={styles.sectionTitle}>{t('cdh.loadTrends')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {LOAD_METRICS.map((mk) => (
              <TouchableOpacity
                key={mk}
                style={[styles.chip, squadMetric.metric === mk && styles.chipActive]}
                onPress={() => loadSquadMetric(mk)}
                accessibilityRole="button"
                accessibilityLabel={mk}
              >
                <Text style={[styles.chipText, squadMetric.metric === mk && styles.chipTextActive]}>{mk}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {!squadMetric.data ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : (
            (squadMetric.data.rows ?? []).map((r) => {
              const val = r.latest?.value;
              const maxVal = Math.max(...(squadMetric.data.rows.map((x) => Number(x.latest?.value ?? 0))));
              const pct = maxVal > 0 && val != null ? (Number(val) / maxVal) * 100 : 0;
              return (
                <View key={r.id} style={styles.barRow}>
                  <Text style={styles.barName} numberOfLines={1}>{r.full_name}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                  </View>
                  <Text style={styles.barVal}>{val != null ? `${val} ${r.latest?.unit ?? ''}` : '—'}</Text>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {tab === 'session' && (
        <ScrollView style={styles.scroll}>
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{t('cdh.session.selectPrompt')}</Text>
            <Text style={styles.emptyBody}>{t('cdh.session.body')}</Text>
          </View>
        </ScrollView>
      )}

      {tab === 'missing' && (
        <ScrollView style={styles.scroll}>
          {!missing ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : (
            [
              { key: 'today', label: t('cdh.missing.today'),     items: missing.today },
              { key: 'week',  label: t('cdh.missing.thisWeek'),  items: missing.this_week },
              { key: 'month', label: t('cdh.missing.thisMonth'), items: missing.this_month },
            ].map(({ key, label, items }) => (
              <View key={key} style={styles.missingSection}>
                <View style={styles.missingSectionHeader}>
                  <Text style={styles.missingSectionTitle}>{label}</Text>
                  <View style={[styles.countBadge, items.length > 0 && { backgroundColor: '#FF980033' }]}>
                    <Text style={[styles.countBadgeText, items.length > 0 && { color: '#FF9800' }]}>{items.length}</Text>
                  </View>
                </View>
                {items.length === 0 ? (
                  <Text style={styles.allGoodText}>{t('cdh.missing.allPresent')}</Text>
                ) : (
                  items.map((a) => (
                    <View key={a.id} style={styles.missingRow}>
                      <Text style={styles.missingName}>{a.full_name}</Text>
                    </View>
                  ))
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container:            { flex: 1, backgroundColor: colors.bg },
    tabBar:               { flexDirection: 'row', backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
    tab:                  { flex: 1, paddingVertical: 12, alignItems: 'center', minHeight: 44 },
    tabActive:            { borderBottomWidth: 2, borderBottomColor: colors.primary },
    tabText:              { fontSize: 12, color: colors.textMuted },
    tabTextActive:        { color: colors.primary, fontWeight: '600' },
    scroll:               { flex: 1 },
    stripRow:             { flexDirection: 'row', margin: 12, gap: 6 },
    stripCard:            { backgroundColor: colors.card, padding: 10, borderRadius: 10, alignItems: 'center' },
    stripLabel:           { fontSize: 10, color: colors.textMuted, marginBottom: 2, textAlign: 'center' },
    stripValue:           { fontSize: 22, fontWeight: '700', color: colors.text },
    athleteRow:           { flexDirection: 'row', backgroundColor: colors.card, padding: 14, marginBottom: 1, alignItems: 'center' },
    athleteName:          { fontSize: 15, fontWeight: '600', color: colors.text },
    athleteSub:           { fontSize: 11, color: colors.textMuted, marginTop: 2 },
    athleteMetrics:       { alignItems: 'flex-end', gap: 4 },
    readinessVal:         { fontSize: 20, fontWeight: '700', color: colors.text },
    acwrChip:             { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    acwrChipText:         { fontSize: 11, fontWeight: '600' },
    sectionTitle:         { fontSize: 16, fontWeight: '700', color: colors.text, margin: 16, marginBottom: 8 },
    chipRow:              { paddingHorizontal: 12, paddingBottom: 8 },
    chip:                 { backgroundColor: colors.card, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginEnd: 8, minHeight: 44, justifyContent: 'center' },
    chipActive:           { backgroundColor: colors.primary },
    chipText:             { fontSize: 12, color: colors.textMuted },
    chipTextActive:       { color: '#fff', fontWeight: '600' },
    barRow:               { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
    barName:              { width: 100, fontSize: 12, color: colors.text },
    barTrack:             { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, marginHorizontal: 8, overflow: 'hidden' },
    barFill:              { height: 8, borderRadius: 4 },
    barVal:               { width: 70, fontSize: 12, color: colors.textMuted, textAlign: 'right' },
    emptyState:           { alignItems: 'center', padding: 40 },
    emptyTitle:           { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
    emptyBody:            { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
    missingSection:       { margin: 12, backgroundColor: colors.card, borderRadius: 12, overflow: 'hidden' },
    missingSectionHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
    missingSectionTitle:  { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1 },
    countBadge:           { backgroundColor: colors.primaryLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    countBadgeText:       { fontSize: 12, fontWeight: '700', color: colors.primary },
    allGoodText:          { padding: 14, fontSize: 13, color: '#4CAF50' },
    missingRow:           { padding: 14, borderTopWidth: 1, borderTopColor: colors.border },
    missingName:          { fontSize: 14, color: colors.text },
  });
}
