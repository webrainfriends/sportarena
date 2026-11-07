// Document library: searchable list of all issued documents for the user's organisation.
// Part of the branded documents feature (issue #249).
import React, { useCallback, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { c, fam, font, r } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';

const FAMILIES = [
  { key: null, label: t('documents.library.filter_all') },
  { key: 'invoice', label: t('documents.families.invoice') },
  { key: 'coaching_plan', label: t('documents.families.coaching_plan') },
  { key: 'coaching_report', label: t('documents.families.coaching_report') },
  { key: 'coach_agreement', label: t('documents.families.coach_agreement') },
  { key: 'event_timetable', label: t('documents.families.event_timetable') },
  { key: 'booking_confirmation', label: t('documents.families.booking_confirmation') },
  { key: 'hire_agreement', label: t('documents.families.hire_agreement') },
  { key: 'purchase_order', label: t('documents.families.purchase_order') },
  { key: 'business_letter', label: t('documents.families.business_letter') },
  { key: 'enrolment_letter', label: t('documents.families.enrolment_letter') },
  { key: 'sponsorship_agreement', label: t('documents.families.sponsorship_agreement') },
  { key: 'rehab_plan', label: t('documents.families.rehab_plan') },
  { key: 'care_plan', label: t('documents.families.care_plan') },
  { key: 'referee_letter', label: t('documents.families.referee_letter') },
];

const ABBR = {
  invoice: 'IN', coaching_plan: 'CP', coaching_report: 'CR', coach_agreement: 'CA',
  event_timetable: 'ET', booking_confirmation: 'BC', hire_agreement: 'HA',
  purchase_order: 'PO', business_letter: 'BL', enrolment_letter: 'EL',
  sponsorship_agreement: 'SP', rehab_plan: 'RP', care_plan: 'CP',
  referee_letter: 'RL', season_report: 'SR', federation_document: 'FD',
  academy_progress_report: 'AP', academy_management_review: 'AM',
  academy_finance_pack: 'AF', academy_term_report: 'AT', academy_campus_quality: 'AQ',
};

const STATUS_COLORS = { draft: c.sunSoft, issued: c.limeSoft, archived: c.violetSoft };
const STATUS_INK = { draft: c.sun, issued: c.lime, archived: c.mute };

const when = (d) => (d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function FamilyIcon({ family }) {
  const abbr = ABBR[family] ?? family?.slice(0, 2)?.toUpperCase() ?? '??';
  return (
    <View style={{ width: 44, height: 44, borderRadius: r.card, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
      <T style={{ ...font.black, fontSize: 13, color: c.pink }}>{abbr}</T>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: c.paper, borderRadius: r.card, marginBottom: 8 }}>
      <View style={{ width: 44, height: 44, borderRadius: r.card, backgroundColor: c.line }} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ height: 14, width: '60%', borderRadius: 4, backgroundColor: c.line }} />
        <View style={{ height: 11, width: '40%', borderRadius: 4, backgroundColor: c.line }} />
      </View>
      <View style={{ height: 22, width: 50, borderRadius: r.pill, backgroundColor: c.line }} />
    </View>
  );
}

function DocRow({ doc, onPress, onDownload, onShare, onRegenerate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusColor = STATUS_COLORS[doc.status] ?? c.pinkSoft;
  const statusInk = STATUS_INK[doc.status] ?? c.mute;
  const familyLabel = FAMILIES.find((f) => f.key === doc.family)?.label ?? doc.family;
  return (
    <Card pad={12} onPress={onPress} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <FamilyIcon family={doc.family} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="700" numberOfLines={1}>{doc.title ?? familyLabel}</T>
          <T size={12} color={c.mute} numberOfLines={1}>{[doc.source_label, when(doc.created_at)].filter(Boolean).join(' · ')}</T>
          {doc.pages ? <T size={11} color={c.mute}>{doc.pages} {doc.pages === 1 ? 'page' : 'pages'}</T> : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: r.pill, backgroundColor: statusColor }}>
            <T size={11} style={{ ...font.bold, color: statusInk }}>{doc.status ?? 'issued'}</T>
          </View>
          <Pressable
            onPress={() => setMenuOpen((v) => !v)}
            hitSlop={10}
            accessibilityLabel={t('common.more_options')}
            accessibilityRole="button"
          >
            <T style={{ fontSize: 18, color: c.mute, lineHeight: 22 }}>⋯</T>
          </Pressable>
        </View>
      </View>
      {menuOpen ? (
        <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title={t('documents.viewer.download')} color={c.violet} onPress={() => { setMenuOpen(false); onDownload?.(); }} />
          <Btn small title={t('documents.viewer.share')} color={c.pink} onPress={() => { setMenuOpen(false); onShare?.(); }} />
          <Btn small title={t('documents.viewer.regenerate')} color={c.paper} ink={c.ink} onPress={() => { setMenuOpen(false); onRegenerate?.(); }} />
        </View>
      ) : null}
    </Card>
  );
}

export function DocumentLibrary({ navigation, embedded = false }) {
  const { toast } = useSession();
  const [family, setFamily] = useState(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const docs = useLoad(
    () => api.get('/documents', { ...(family ? { family } : {}), per_page: 50 }),
    [family],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await docs.reload(); } finally { setRefreshing(false); }
  }, [docs]);

  const filtered = (docs.data?.documents ?? []).filter((d) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (d.title ?? '').toLowerCase().includes(q) || (d.family ?? '').includes(q) || (d.source_label ?? '').toLowerCase().includes(q);
  });

  const handleDownload = async (doc) => {
    try {
      const { url } = await api.get(`/documents/${doc.id}/download-url`);
      if (Platform.OS === 'web') { window.open(url, '_blank'); }
      else { const { openURL } = require('react-native').Linking; await openURL(url); }
    } catch (e) { toast(e.message); }
  };

  const handleRegenerate = async (doc) => {
    try {
      await api.post(`/documents/${doc.id}/regenerate`);
      toast(t('documents.generate.in_progress'));
      docs.reload();
    } catch (e) { toast(e.message); }
  };

  const content = (
    <>
      <View style={{ marginBottom: 10 }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('documents.library.search_placeholder')}
          placeholderTextColor={c.mute}
          style={{ backgroundColor: c.paper, borderRadius: r.input, paddingHorizontal: 14, paddingVertical: Platform.OS === 'web' ? 10 : 8, ...fam, fontSize: 15, color: c.ink, borderWidth: 1, borderColor: c.line }}
          accessibilityLabel={t('documents.library.search_placeholder')}
          clearButtonMode="while-editing"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} contentContainerStyle={{ gap: 6, paddingRight: 16 }}>
        {FAMILIES.map((f) => (
          <Chip key={String(f.key)} label={f.label} active={family === f.key} onPress={() => setFamily(f.key)} />
        ))}
      </ScrollView>
      {docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : null}
      {!docs.data && !docs.error ? (
        <View style={{ gap: 0 }}>
          {[1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
        </View>
      ) : filtered.length === 0 ? (
        <Empty
          emoji="📄"
          title={t('documents.library.empty')}
          sub={t('documents.library.generate_hint')}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => (
            <DocRow
              doc={item}
              onPress={() => navigation?.navigate('DocumentViewer', { documentId: item.id })}
              onDownload={() => handleDownload(item)}
              onShare={() => navigation?.navigate('DocumentViewer', { documentId: item.id, openShare: true })}
              onRegenerate={() => handleRegenerate(item)}
            />
          )}
          refreshing={refreshing}
          onRefresh={onRefresh}
          scrollEnabled={!embedded}
          showsVerticalScrollIndicator={false}
        />
      )}
    </>
  );

  if (embedded) return <View style={{ flex: 1 }}>{content}</View>;

  return (
    <Screen>
      <H1>{t('documents.hub.my_documents')}</H1>
      {content}
    </Screen>
  );
}
