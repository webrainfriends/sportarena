import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Platform, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { c, r, fam } from '../theme';
import { useTranslation } from '../i18n';
import { useApi } from '../api';

const CATEGORIES = ['all', 'harassment', 'privacy', 'fabricated', 'spam'];
const CAT_COLORS = {
  harassment: { bg: '#FFEBEE', ink: '#C62828' },
  spam: { bg: '#FFF3E0', ink: '#E65100' },
  fabricated: { bg: '#FFF8E1', ink: '#F9A825' },
  privacy: { bg: '#E3F2FD', ink: '#1565C0' },
  other: { bg: c.bg, ink: c.mute },
};

function ModCard({ item, onUphold, onDismiss }) {
  const { t } = useTranslation();
  const catCol = CAT_COLORS[item.report_category] ?? CAT_COLORS.other;
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <View style={[s.catBadge, { backgroundColor: catCol.bg }]}>
              <Text style={[s.catBadgeText, { color: catCol.ink }]}>{item.report_category}</Text>
            </View>
            {item.report_count > 1 && (
              <View style={s.countBadge}>
                <Text style={s.countBadgeText}>{t('feedback_mod_report_count', { n: item.report_count })}</Text>
              </View>
            )}
          </View>
          <Text style={s.cardSubject}>{item.subject_label}</Text>
          <Text style={s.cardMeta}>{item.context_type} · ★{item.rating} · {new Date(item.created_at).toLocaleDateString()}</Text>
        </View>
        <Text style={s.timeAgo}>{item.time_ago}</Text>
      </View>

      <View style={s.excerpt}>
        <Text style={s.excerptStars}>{'★'.repeat(Math.round(item.rating || 0))}</Text>
        <Text style={s.excerptText} numberOfLines={expanded ? undefined : 3}>{item.body}</Text>
        {!expanded && <TouchableOpacity onPress={() => setExpanded(true)}><Text style={{ fontSize: 11, color: c.pink }}>{t('feedback_mod_show_more')}</Text></TouchableOpacity>}
      </View>

      {item.interaction_id && (
        <View style={s.evidenceRow}>
          <Text style={s.evidenceLabel}>📎 {t('feedback_mod_interaction')}: </Text>
          <Text style={s.evidenceLink}>{item.interaction_label}</Text>
        </View>
      )}

      {/* Reason input */}
      <TextInput
        style={s.reasonInput}
        placeholder={t('feedback_mod_reason_placeholder')}
        placeholderTextColor={c.mute}
        value={reason}
        onChangeText={setReason}
        multiline
        numberOfLines={2}
      />

      <View style={s.decisionRow}>
        <TouchableOpacity style={s.btnUphold} onPress={() => onUphold(item.id, reason)}>
          <Text style={s.btnUpholdText}>{t('feedback_mod_uphold')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnDismiss} onPress={() => onDismiss(item.id, reason)}>
          <Text style={s.btnDismissText}>{t('feedback_mod_dismiss')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function AppealCard({ item, onDecide }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  return (
    <View style={[s.card, { borderLeftWidth: 4, borderLeftColor: c.pink }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Text style={{ fontSize: 20 }}>⚖️</Text>
        <View>
          <Text style={s.cardSubject}>{item.appellant_label} {t('feedback_mod_appeal_title')}</Text>
          <Text style={s.cardMeta}>{t('feedback_mod_original_verdict')}: {item.original_verdict}</Text>
        </View>
      </View>
      <View style={s.excerpt}>
        <Text style={s.excerptText}>{item.appeal_reason}</Text>
      </View>
      <TextInput
        style={s.reasonInput}
        placeholder={t('feedback_mod_appeal_decision_placeholder')}
        placeholderTextColor={c.mute}
        value={reason}
        onChangeText={setReason}
        multiline
        numberOfLines={2}
      />
      <View style={s.decisionRow}>
        <TouchableOpacity style={s.btnUphold} onPress={() => onDecide(item.id, 'upheld', reason)}>
          <Text style={s.btnUpholdText}>{t('feedback_mod_appeal_uphold')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnDismiss} onPress={() => onDecide(item.id, 'dismissed', reason)}>
          <Text style={s.btnDismissText}>{t('feedback_mod_appeal_dismiss')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function FeedbackModeration() {
  const { t } = useTranslation();
  const nav = useNavigation();
  const api = useApi();

  const [tab, setTab] = useState('reports');
  const [category, setCategory] = useState('all');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ reports: 0, appeals: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/feedback/moderation?tab=${tab}&category=${category === 'all' ? '' : category}`);
      setItems(tab === 'reports' ? res.reports : res.appeals);
      setCounts({ reports: res.report_count, appeals: res.appeal_count });
    } catch (_) {}
    setLoading(false);
  }, [tab, category]);

  useEffect(() => { load(); }, [load]);

  const moderate = async (id, verdict, reason) => {
    try {
      await api.post(`/testimonials/${id}/moderate`, { action: verdict === 'dismissed' ? 'dismiss' : 'hide', reason });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { Alert.alert(t('feedback_mod_error'), e.message); }
  };

  const decideAppeal = async (id, decision, reason) => {
    try {
      await api.post(`/feedback/appeals/${id}/decide`, { decision, reason });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { Alert.alert(t('feedback_mod_error'), e.message); }
  };

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} style={s.backBtn}>
          <Text style={{ fontSize: 18, color: c.pink }}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionLabel}>{t('feedback_mod_admin_label')}</Text>
          <Text style={s.title}>{t('feedback_mod_title')}</Text>
        </View>
      </View>

      <View style={s.tabRow}>
        {['reports', 'appeals'].map((tb) => (
          <TouchableOpacity key={tb} style={[s.tab, tab === tb && s.tabActive]} onPress={() => setTab(tb)}>
            <Text style={[s.tabText, tab === tb && s.tabTextActive]}>
              {t(`feedback_mod_tab_${tb}`)}
              {counts[tb] > 0 ? ` (${counts[tb]})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'reports' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 46, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity key={cat} style={[s.filterChip, category === cat && s.filterChipActive]} onPress={() => setCategory(cat)}>
              <Text style={[s.filterChipText, category === cat && s.filterChipTextActive]}>{t(`feedback_mod_cat_${cat}`)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {loading ? (
          <ActivityIndicator color={c.pink} style={{ marginTop: 60 }} />
        ) : items.length === 0 ? (
          <View style={s.empty}>
            <Text style={{ fontSize: 40 }}>🛡️</Text>
            <Text style={{ fontSize: 15, color: c.mute, marginTop: 10, textAlign: 'center' }}>{t('feedback_mod_empty_state')}</Text>
          </View>
        ) : tab === 'reports' ? (
          items.map((item) => (
            <ModCard key={item.id} item={item}
              onUphold={(id, reason) => moderate(id, 'upheld', reason)}
              onDismiss={(id, reason) => moderate(id, 'dismissed', reason)}
            />
          ))
        ) : (
          items.map((item) => (
            <AppealCard key={item.id} item={item} onDecide={decideAppeal} />
          ))
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
  tabRow: { flexDirection: 'row', borderBottomWidth: 1.5, borderBottomColor: c.line },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabActive: { borderBottomWidth: 2.5, borderBottomColor: c.pink },
  tabText: { fontSize: 13, fontWeight: '600', color: c.mute },
  tabTextActive: { color: c.pink },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: r.pill, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper },
  filterChipActive: { backgroundColor: c.pink, borderColor: c.pink },
  filterChipText: { fontSize: 11, fontWeight: '700', color: c.mute },
  filterChipTextActive: { color: '#fff' },
  card: { backgroundColor: c.paper, borderRadius: r.card, padding: 14, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 },
  catBadge: { borderRadius: r.pill, paddingHorizontal: 10, paddingVertical: 3 },
  catBadgeText: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  countBadge: { backgroundColor: c.bg, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 3 },
  countBadgeText: { fontSize: 10, color: c.mute },
  cardSubject: { fontSize: 13, fontWeight: '700', color: c.ink },
  cardMeta: { fontSize: 11, color: c.mute, marginTop: 1 },
  timeAgo: { fontSize: 11, color: c.mute, flexShrink: 0 },
  excerpt: { backgroundColor: c.bg, borderRadius: r.input, padding: 10, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: c.line },
  excerptStars: { fontSize: 11, color: '#F59E0B', marginBottom: 3 },
  excerptText: { fontSize: 12, color: c.ink, lineHeight: 18 },
  evidenceRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  evidenceLabel: { fontSize: 11, color: c.mute },
  evidenceLink: { fontSize: 11, color: c.pink, textDecorationLine: 'underline' },
  reasonInput: { backgroundColor: c.bg, borderRadius: r.input, padding: 10, fontSize: 12, color: c.ink, minHeight: 48, marginBottom: 10 },
  decisionRow: { flexDirection: 'row', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line },
  btnUphold: { flex: 1, padding: 10, borderRadius: r.input, backgroundColor: '#FFEBEE', alignItems: 'center' },
  btnUpholdText: { fontSize: 12, fontWeight: '700', color: '#C62828' },
  btnDismiss: { flex: 1, padding: 10, borderRadius: r.input, backgroundColor: '#E8F5E9', alignItems: 'center' },
  btnDismissText: { fontSize: 12, fontWeight: '700', color: '#2E7D32' },
  empty: { alignItems: 'center', paddingTop: 60 },
});
