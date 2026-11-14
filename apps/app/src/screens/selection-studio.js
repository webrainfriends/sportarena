// Issue #1194: Selection Studio — campaign board with stage pipeline ribbon
import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi } from '../api';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Btn, Card, Chip, Empty, Field, Screen, StatPill } from '../ui';

const STAGE_LABELS = [
  'draft','mandate','nominations','eligibility','shortlist',
  'assessment','comparison','scenarios','recommendation','committee','approval','published'
];

const STAGE_COLORS = (c) => [
  c.mute, c.sun, c.sun, c.violet, c.violet,
  c.cyan, c.cyan, c.pink, c.pink, c.lime, c.lime, c.lime
];

export default function SelectionStudio({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { orgId } = route?.params ?? {};
  const { data, loading, refetch } = useApi(`/organisations/${orgId}/selection-campaigns`);
  const [q, setQ] = useState('');
  const S = styles(C);

  useFocusEffect(useCallback(() => { refetch?.(); }, [refetch]));

  const campaigns = (data ?? []).filter(c =>
    !q || c.name.toLowerCase().includes(q.toLowerCase())
  );

  const actionRequired = campaigns.filter(c => [9,10].includes(c.stage));

  return (
    <Screen title={t('sel.studio.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {actionRequired.length > 0 && (
          <Card style={S.actionBanner} accessibilityLabel={t('sel.studio.actionBanner')}>
            <Text style={S.bannerTitle}>{t('sel.studio.actionRequired', { count: actionRequired.length })}</Text>
            <Text style={S.bannerSub}>{actionRequired.map(c => c.name).join(' · ')}</Text>
          </Card>
        )}

        <View style={S.headerRow}>
          <Text style={S.heading}>{t('sel.studio.campaigns')}</Text>
          <Btn
            label={t('sel.studio.newCampaign')}
            onPress={() => nav.navigate('SelectionCampaignSetup', { orgId })}
            icon="plus"
            size="sm"
            accessibilityLabel={t('sel.studio.newCampaign')}
          />
        </View>

        <Field
          value={q}
          onChangeText={setQ}
          placeholder={t('sel.studio.search')}
          style={S.search}
          accessibilityLabel={t('sel.studio.search')}
        />

        {campaigns.length === 0 ? (
          <Empty
            icon="trophy"
            title={t('sel.studio.empty.title')}
            body={t('sel.studio.empty.body')}
            action={{ label: t('sel.studio.newCampaign'), onPress: () => nav.navigate('SelectionCampaignSetup', { orgId }) }}
          />
        ) : campaigns.map(cam => (
          <TouchableOpacity
            key={cam.id}
            style={S.card}
            onPress={() => nav.navigate('SelectionCandidatePipeline', { campaignId: cam.id })}
            accessibilityLabel={cam.name}
          >
            <View style={S.cardHeader}>
              <Text style={S.cardTitle} numberOfLines={1}>{cam.name}</Text>
              <Chip
                label={STAGE_LABELS[cam.stage]}
                color={STAGE_COLORS(C)[cam.stage]}
                size="sm"
              />
            </View>
            <Text style={S.cardSub}>{cam.sport_name ?? '—'} · {cam.team_name ?? t('sel.noTeam')} · {cam.purpose}</Text>

            {/* Stage pipeline ribbon */}
            <View style={S.ribbon} accessibilityLabel={t('sel.studio.stagePipeline')}>
              {STAGE_LABELS.map((label, idx) => (
                <View
                  key={label}
                  style={[S.ribbonStep, { backgroundColor: idx <= cam.stage ? C.pink : C.line }]}
                  accessibilityLabel={label}
                />
              ))}
            </View>

            <StatPill items={[
              { label: t('sel.nominations'), value: cam.nomination_count ?? 0 },
              { label: t('sel.eligible'), value: cam.eligible_count ?? 0 },
              { label: t('sel.stage'), value: `${cam.stage + 1}/12` },
            ]} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32 },
  actionBanner: { backgroundColor: C.sun + '22', borderLeftWidth: 4, borderLeftColor: C.sun, marginBottom: 16, padding: 14 },
  bannerTitle: { color: C.sun, fontWeight: '700', fontSize: 15 },
  bannerSub: { color: C.ink, fontSize: 13, marginTop: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  heading: { fontSize: 20, fontWeight: '700', color: C.ink },
  search: { marginBottom: 16 },
  card: {
    backgroundColor: C.paper, borderRadius: 18, padding: 16, marginBottom: 14,
    shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: C.ink, flex: 1, marginEnd: 8 },
  cardSub: { fontSize: 12, color: C.mute, marginBottom: 10 },
  ribbon: { flexDirection: 'row', gap: 2, marginBottom: 12 },
  ribbonStep: { flex: 1, height: 4, borderRadius: 2 },
});
