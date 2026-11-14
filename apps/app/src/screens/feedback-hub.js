import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, RefreshControl } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { c, r, fam } from '../theme';
import { useTranslation } from '../i18n';
import { useApi } from '../api';

const TABS = ['received', 'given', 'pending', 'private'];

function StarRow({ rating, size = 13 }) {
  return (
    <Text style={{ color: '#F59E0B', fontSize: size, letterSpacing: 1 }}>
      {'★'.repeat(Math.round(rating))}{'☆'.repeat(5 - Math.round(rating))}
    </Text>
  );
}

function VerificationBadge({ verification }) {
  const { t } = useTranslation();
  const verified = verification === 'verified_interaction';
  return (
    <View style={{ backgroundColor: verified ? c.limeSoft : c.line, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: verified ? c.lime : c.mute }}>
        {verified ? t('feedback_verified_badge') : t('feedback_legacy_badge')}
      </Text>
    </View>
  );
}

function ReviewCard({ item, onReply, onReport }) {
  const { t } = useTranslation();
  const dims = item.dimensions_json ? (Array.isArray(item.dimensions_json) ? item.dimensions_json : JSON.parse(item.dimensions_json)) : null;
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={[s.avatar, { backgroundColor: c.pink }]}>
          <Text style={s.avatarText}>{(item.author_name || item.handle || '?').slice(0, 2).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardName}>{item.author_name || item.handle}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            <StarRow rating={item.rating} />
            <Text style={s.meta}>· {new Date(item.created_at).toLocaleDateString()}</Text>
          </View>
        </View>
        <VerificationBadge verification={item.verification} />
      </View>
      {item.author_role ? (
        <View style={s.rolePill}>
          <Text style={s.rolePillText}>{item.author_role}</Text>
        </View>
      ) : null}
      <Text style={s.cardBody}>{item.body}</Text>
      {dims && dims.length > 0 ? (
        <View style={s.dimRow}>
          {dims.map((d) => (
            <View key={d.key} style={s.dimChip}>
              <Text style={s.dimChipText}>{d.label} <Text style={{ color: c.pink, fontWeight: '700' }}>{d.rating}</Text></Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.reply_body ? (
        <View style={s.replyBubble}>
          <Text style={s.replyLabel}>{t('feedback_reply_label')}</Text>
          <Text style={s.replyText}>{item.reply_body}</Text>
        </View>
      ) : null}
      <View style={s.cardActions}>
        {!item.reply_body && onReply ? (
          <TouchableOpacity style={s.cardAction} onPress={() => onReply(item)}>
            <Text style={s.cardActionText}>{t('feedback_reply_cta')}</Text>
          </TouchableOpacity>
        ) : null}
        {onReport ? (
          <TouchableOpacity style={s.cardAction} onPress={() => onReport(item)}>
            <Text style={s.cardActionText}>{t('feedback_report_cta')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function PendingCard({ item, onPress }) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity style={[s.card, { borderLeftWidth: 3, borderLeftColor: c.pink }]} onPress={onPress}>
      <Text style={s.cardName}>{item.context_label}</Text>
      <Text style={s.meta}>{item.subject_label} · {t('feedback_window_days', { days: item.window_days })}</Text>
      <View style={[s.cardAction, { marginTop: 10, alignSelf: 'flex-start' }]}>
        <Text style={s.cardActionText}>{t('feedback_submit_cta')} →</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function FeedbackHub() {
  const { t } = useTranslation();
  const nav = useNavigation();
  const api = useApi();
  const [tab, setTab] = useState('received');
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [agg, feed] = await Promise.all([
        api.get('/feedback/received?type=all&limit=1&offset=0'),
        api.get(`/feedback/received?type=${tab}&limit=20&offset=0`),
      ]);
      setSummary(agg);
      setItems(tab === 'received' ? feed.public_feedback : tab === 'private' ? feed.private_feedback : []);
    } catch (_) {}
    setLoading(false);
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View>
          <Text style={s.sectionLabel}>{t('feedback_hub_my_profile')}</Text>
          <Text style={s.title}>{t('feedback_hub_title')}</Text>
        </View>
        <TouchableOpacity style={s.iconBtn} onPress={() => nav.navigate('FeedbackAnalytics')} accessibilityLabel={t('feedback_analytics_title')}>
          <Text style={{ fontSize: 20 }}>📊</Text>
        </TouchableOpacity>
      </View>

      <View style={s.kpiStrip}>
        {[
          { val: summary?.avg ?? '–', label: t('feedback_analytics_avg') },
          { val: summary?.n ?? 0, label: t('feedback_hub_reviews') },
          { val: summary?.reply_rate_pct != null ? `${summary.reply_rate_pct}%` : '–', label: t('feedback_analytics_reply_rate') },
          { val: summary?.avg_response_days != null ? `${summary.avg_response_days}d` : '–', label: t('feedback_analytics_response_time') },
        ].map((k, i) => (
          <View key={i} style={s.kpiTile}>
            <Text style={s.kpiVal}>{k.val}</Text>
            <Text style={s.kpiLabel}>{k.label}</Text>
          </View>
        ))}
      </View>

      <View style={s.tabRow}>
        {TABS.map((t2) => (
          <TouchableOpacity key={t2} style={[s.tab, tab === t2 && s.tabActive]} onPress={() => setTab(t2)}>
            <Text style={[s.tabText, tab === t2 && s.tabTextActive]}>{t(`feedback_hub_${t2}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {loading ? (
          <ActivityIndicator color={c.pink} style={{ marginTop: 40 }} />
        ) : items.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>⭐</Text>
            <Text style={s.emptyTitle}>{t('feedback_no_reviews_state')}</Text>
          </View>
        ) : (
          items.map((item) => (
            <ReviewCard key={item.id} item={item}
              onReply={tab === 'received' ? (i) => nav.navigate('FeedbackReply', { testimonialId: i.id }) : null}
              onReport={(i) => nav.navigate('FeedbackReport', { testimonialId: i.id })}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 16, paddingBottom: 8 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.08, textTransform: 'uppercase', color: c.mute },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, color: c.ink, ...fam },
  iconBtn: { width: 36, height: 36, borderRadius: r.pill, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' },
  kpiStrip: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  kpiTile: { flex: 1, backgroundColor: c.paper, borderRadius: r.input, padding: 10, alignItems: 'center' },
  kpiVal: { fontSize: 18, fontWeight: '700', color: c.pink, ...fam },
  kpiLabel: { fontSize: 10, color: c.mute, marginTop: 2, textAlign: 'center' },
  tabRow: { flexDirection: 'row', borderBottomWidth: 1.5, borderBottomColor: c.line },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabActive: { borderBottomWidth: 2.5, borderBottomColor: c.pink },
  tabText: { fontSize: 12, fontWeight: '600', color: c.mute },
  tabTextActive: { color: c.pink },
  card: { backgroundColor: c.paper, borderRadius: r.card, padding: 14, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  avatar: { width: 36, height: 36, borderRadius: r.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  cardName: { fontSize: 13, fontWeight: '700', color: c.ink },
  meta: { fontSize: 11, color: c.mute },
  rolePill: { backgroundColor: c.pinkSoft, borderRadius: r.pill, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, marginBottom: 7 },
  rolePillText: { fontSize: 10, fontWeight: '700', color: c.pink },
  cardBody: { fontSize: 13, color: c.ink, lineHeight: 20 },
  dimRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  dimChip: { backgroundColor: c.bg, borderRadius: r.pill, paddingHorizontal: 10, paddingVertical: 3 },
  dimChipText: { fontSize: 10, color: c.mute },
  replyBubble: { backgroundColor: c.pinkSoft, borderRadius: 10, padding: 10, marginTop: 8, borderLeftWidth: 3, borderLeftColor: c.pink },
  replyLabel: { fontSize: 10, fontWeight: '700', color: c.pink, marginBottom: 3 },
  replyText: { fontSize: 12, color: c.ink },
  cardActions: { flexDirection: 'row', gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line },
  cardAction: { flex: 1, alignItems: 'center', padding: 7, backgroundColor: c.bg, borderRadius: r.input },
  cardActionText: { fontSize: 11, fontWeight: '600', color: c.pink },
  emptyState: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: c.mute, textAlign: 'center' },
});
