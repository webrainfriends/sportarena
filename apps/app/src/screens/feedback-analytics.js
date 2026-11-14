import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, Dimensions } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { c, r, fam } from '../theme';
import { useTranslation } from '../i18n';
import { useApi } from '../api';

const PERIODS = [30, 90, 365];

function NpsWheel({ nps }) {
  const pct = ((nps + 100) / 200) * 100;
  const color = nps >= 50 ? c.lime : nps >= 0 ? '#D97706' : c.red;
  return (
    <View style={{ alignItems: 'center', paddingVertical: 12 }}>
      <View style={[s.npsRing, { borderColor: color }]}>
        <Text style={[s.npsVal, { color }]}>{nps >= 0 ? `+${nps}` : nps}</Text>
        <Text style={s.npsLabel}>NPS</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
        {[['Promoters', '#2F8F5F'], ['Passives', '#D97706'], ['Detractors', '#E11D48']].map(([l, col]) => (
          <View key={l} style={{ alignItems: 'center' }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: col, marginBottom: 2 }} />
            <Text style={{ fontSize: 10, color: c.mute }}>{l}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function DistBar({ label, count, total, pct }) {
  const { t } = useTranslation();
  return (
    <View style={s.distRow}>
      <Text style={s.distLabel}>{label}★</Text>
      <View style={s.distTrack}>
        <View style={[s.distFill, { width: `${total > 0 ? (count / total) * 100 : 0}%` }]} />
      </View>
      <Text style={s.distCount}>{count}</Text>
    </View>
  );
}

function DimBar({ label, value }) {
  return (
    <View style={s.dimBarRow}>
      <Text style={s.dimBarLabel}>{label}</Text>
      <View style={s.dimBarTrack}>
        <View style={[s.dimBarFill, { width: `${(value / 5) * 100}%` }]} />
      </View>
      <Text style={s.dimBarVal}>{value?.toFixed(1)}</Text>
    </View>
  );
}

export default function FeedbackAnalytics() {
  const { t } = useTranslation();
  const nav = useNavigation();
  const route = useRoute();
  const api = useApi();
  const { subjectType, subjectId } = route.params ?? {};

  const [period, setPeriod] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/feedback/analytics/${subjectType}/${subjectId}?days=${period}`);
      setData(res);
    } catch (_) {}
    setLoading(false);
  }, [period, subjectType, subjectId]);

  useEffect(() => { load(); }, [load]);

  const dist = data?.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  const dimData = data?.dimensions ?? [];
  const byRole = data?.by_role ?? [];

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} style={s.backBtn}>
          <Text style={{ fontSize: 18, color: c.pink }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionLabel}>{t('feedback_hub_my_profile')}</Text>
          <Text style={s.title}>{t('feedback_analytics_title')}</Text>
        </View>
      </View>

      <View style={s.periodRow}>
        {PERIODS.map((p) => (
          <TouchableOpacity key={p} style={[s.periodChip, period === p && s.periodChipActive]} onPress={() => setPeriod(p)}>
            <Text style={[s.periodChipText, period === p && s.periodChipTextActive]}>{p}{t('feedback_days_suffix')}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {loading ? (
          <ActivityIndicator color={c.pink} style={{ marginTop: 60 }} />
        ) : !data ? (
          <View style={s.empty}>
            <Text style={{ fontSize: 40 }}>📊</Text>
            <Text style={{ fontSize: 15, color: c.mute, marginTop: 10, textAlign: 'center' }}>{t('feedback_no_analytics_state')}</Text>
          </View>
        ) : (
          <>
            {/* KPI strip */}
            <View style={s.kpiStrip}>
              {[
                { val: data.avg?.toFixed(1) ?? '–', sub: '★★★★★', label: t('feedback_analytics_avg') },
                { val: data.n ?? 0, label: t('feedback_hub_reviews') },
                { val: data.nps != null ? (data.nps >= 0 ? `+${data.nps}` : data.nps) : '–', label: 'NPS' },
                { val: data.reply_rate_pct != null ? `${data.reply_rate_pct}%` : '–', label: t('feedback_analytics_reply_rate') },
              ].map((k, i) => (
                <View key={i} style={s.kpiTile}>
                  <Text style={s.kpiVal}>{k.val}</Text>
                  {k.sub ? <Text style={{ fontSize: 10, color: '#F59E0B' }}>{k.sub}</Text> : null}
                  <Text style={s.kpiLabel}>{k.label}</Text>
                </View>
              ))}
            </View>

            {/* Distribution */}
            <View style={s.card}>
              <Text style={s.cardTitle}>{t('feedback_analytics_distribution')}</Text>
              {[5, 4, 3, 2, 1].map((star) => (
                <DistBar key={star} label={star} count={dist[star] ?? 0} total={total} />
              ))}
            </View>

            {/* NPS wheel */}
            {data.nps != null && (
              <View style={s.card}>
                <Text style={s.cardTitle}>Net Promoter Score</Text>
                <NpsWheel nps={data.nps} />
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                  {[['Promoters (9–10)', data.nps_promoters, '#2F8F5F'], ['Passives (7–8)', data.nps_passives, '#D97706'], ['Detractors (0–6)', data.nps_detractors, '#E11D48']].map(([l, v, col]) => (
                    <View key={l} style={{ flex: 1, backgroundColor: c.bg, borderRadius: r.input, padding: 8, alignItems: 'center' }}>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: col }}>{v ?? 0}%</Text>
                      <Text style={{ fontSize: 10, color: c.mute, textAlign: 'center', marginTop: 2 }}>{l}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Dimensions */}
            {dimData.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardTitle}>{t('feedback_analytics_dimensions')}</Text>
                {dimData.map((d) => (
                  <DimBar key={d.key} label={d.label} value={d.avg} />
                ))}
              </View>
            )}

            {/* Reply metrics */}
            <View style={s.card}>
              <Text style={s.cardTitle}>{t('feedback_analytics_reply_metrics')}</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {[
                  { val: `${data.reply_rate_pct ?? 0}%`, label: t('feedback_analytics_reply_rate') },
                  { val: data.avg_response_days != null ? `${data.avg_response_days}d` : '–', label: t('feedback_analytics_response_time') },
                ].map((m, i) => (
                  <View key={i} style={{ flex: 1, backgroundColor: c.bg, borderRadius: r.input, padding: 12, alignItems: 'center' }}>
                    <Text style={{ fontSize: 20, fontWeight: '700', color: c.pink }}>{m.val}</Text>
                    <Text style={{ fontSize: 11, color: c.mute, textAlign: 'center', marginTop: 4 }}>{m.label}</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* By role breakdown */}
            {byRole.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardTitle}>{t('feedback_analytics_by_role')}</Text>
                {byRole.map((row) => (
                  <View key={row.author_role} style={s.roleRow}>
                    <View style={s.rolePill}>
                      <Text style={s.rolePillText}>{row.author_role}</Text>
                    </View>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#F59E0B' }}>
                      {'★'.repeat(Math.round(row.avg))}
                    </Text>
                    <Text style={{ fontSize: 12, color: c.ink, fontWeight: '700' }}>{row.avg?.toFixed(1)}</Text>
                    <Text style={{ fontSize: 11, color: c.mute }}>({row.n})</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Trend note */}
            {data.trend != null && (
              <View style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                <Text style={{ fontSize: 24 }}>{data.trend > 0 ? '📈' : data.trend < 0 ? '📉' : '➡️'}</Text>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>
                    {data.trend > 0 ? t('feedback_trend_up') : data.trend < 0 ? t('feedback_trend_down') : t('feedback_trend_flat')}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.mute }}>
                    {`${data.trend > 0 ? '+' : ''}${data.trend?.toFixed(2)} vs previous period`}
                  </Text>
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 16, paddingBottom: 8, gap: 10 },
  backBtn: { width: 36, height: 36, borderRadius: r.pill, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.08, textTransform: 'uppercase', color: c.mute },
  title: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: c.ink, ...fam },
  periodRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  periodChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: r.pill, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper },
  periodChipActive: { backgroundColor: c.pink, borderColor: c.pink },
  periodChipText: { fontSize: 12, fontWeight: '600', color: c.mute },
  periodChipTextActive: { color: '#fff' },
  kpiStrip: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  kpiTile: { flex: 1, backgroundColor: c.paper, borderRadius: r.input, padding: 10, alignItems: 'center' },
  kpiVal: { fontSize: 18, fontWeight: '700', color: c.pink, ...fam },
  kpiLabel: { fontSize: 10, color: c.mute, marginTop: 2, textAlign: 'center' },
  card: { backgroundColor: c.paper, borderRadius: r.card, padding: 14, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: c.ink, marginBottom: 12 },
  distRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  distLabel: { fontSize: 11, color: c.mute, width: 18, textAlign: 'right' },
  distTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: c.bg, overflow: 'hidden' },
  distFill: { height: '100%', backgroundColor: '#F59E0B', borderRadius: 4 },
  distCount: { fontSize: 11, color: c.mute, width: 24, textAlign: 'right' },
  dimBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dimBarLabel: { fontSize: 12, color: c.ink, flex: 1 },
  dimBarTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: c.bg, overflow: 'hidden' },
  dimBarFill: { height: '100%', backgroundColor: c.pink, borderRadius: 4 },
  dimBarVal: { fontSize: 12, fontWeight: '700', color: c.pink, width: 28, textAlign: 'right' },
  npsRing: { width: 100, height: 100, borderRadius: 50, borderWidth: 8, alignItems: 'center', justifyContent: 'center' },
  npsVal: { fontSize: 24, fontWeight: '800', ...fam },
  npsLabel: { fontSize: 10, color: c.mute },
  roleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.bg },
  rolePill: { backgroundColor: c.pinkSoft, borderRadius: r.pill, paddingHorizontal: 10, paddingVertical: 3 },
  rolePillText: { fontSize: 10, fontWeight: '700', color: c.pink },
  empty: { alignItems: 'center', paddingTop: 60 },
});
