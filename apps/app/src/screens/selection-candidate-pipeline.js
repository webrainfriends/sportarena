// Issue #1194: Candidate pipeline — Kanban board by stage
import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Avatar, Btn, Chip, Empty, Screen } from '../ui';

const KANBAN_COLS = ['nominated','eligibility_check','shortlisted','assessing','comparison','recommended'];

export default function SelectionCandidatePipeline({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId } = route?.params ?? {};
  const { data: campaign } = useApi(`/selection-campaigns/${campaignId}`);
  const { data: nominations, refetch } = useApi(`/selection-campaigns/${campaignId}/nominations`);
  const { mutate: advance } = useApiMutation('POST', `/selection-campaigns/${campaignId}/advance-stage`);
  const S = styles(C);

  useFocusEffect(useCallback(() => { refetch?.(); }, [refetch]));

  const byStage = (stage) => (nominations ?? []).filter(n => n.stage === stage);

  const eligBadge = (status) => ({
    eligible: { label: t('sel.eligible'), color: C.lime },
    ineligible: { label: t('sel.ineligible'), color: C.red },
    provisional: { label: t('sel.provisional'), color: C.sun },
    unchecked: { label: t('sel.unchecked'), color: C.mute },
    expired: { label: t('sel.expired'), color: C.red },
  }[status] ?? { label: status, color: C.mute });

  return (
    <Screen title={campaign?.name ?? t('sel.pipeline.title')} back>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.kanban}>
        {KANBAN_COLS.map(col => (
          <View key={col} style={S.col}>
            <View style={S.colHeader}>
              <Text style={S.colTitle}>{t(`sel.stage.${col}`)}</Text>
              <Text style={S.colCount}>{byStage(col).length}</Text>
            </View>
            <ScrollView style={S.colScroll} nestedScrollEnabled>
              {byStage(col).length === 0 ? (
                <Text style={S.emptyCol}>{t('sel.pipeline.empty')}</Text>
              ) : byStage(col).map(nom => {
                const elig = eligBadge(nom.eligibility_status);
                return (
                  <TouchableOpacity
                    key={nom.id}
                    style={S.nomCard}
                    onPress={() => nav.navigate('SelectionDossier', { nominationId: nom.id, campaignId })}
                    accessibilityLabel={nom.candidate_name ?? nom.candidate_id}
                  >
                    <View style={S.nomRow}>
                      <Avatar userId={nom.candidate_id} size={36} />
                      <View style={S.nomInfo}>
                        <Text style={S.nomName} numberOfLines={1}>{nom.candidate_name ?? '—'}</Text>
                        <Text style={S.nomPos}>{nom.position ?? t('sel.posUnknown')}</Text>
                      </View>
                    </View>
                    <Chip label={elig.label} color={elig.color} size="xs" style={S.eligChip} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <Btn
              label={t('sel.pipeline.addNominee')}
              icon="plus"
              variant="ghost"
              size="sm"
              onPress={() => nav.navigate('SelectionNominateModal', { campaignId, stage: col })}
              style={S.addBtn}
              accessibilityLabel={t('sel.pipeline.addNominee')}
            />
          </View>
        ))}
      </ScrollView>

      <View style={S.footer}>
        <Btn
          label={t('sel.pipeline.advanceStage')}
          onPress={() => advance({}).then(() => refetch?.())}
          icon="arrow-right"
          accessibilityLabel={t('sel.pipeline.advanceStage')}
        />
        <Btn
          label={t('sel.pipeline.comparisonLab')}
          onPress={() => nav.navigate('SelectionComparisonLab', { campaignId })}
          variant="outline"
          accessibilityLabel={t('sel.pipeline.comparisonLab')}
        />
      </View>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  kanban: { flexDirection: 'row', padding: 12, gap: 10, alignItems: 'flex-start' },
  col: { width: 200, backgroundColor: C.bg, borderRadius: 14, overflow: 'hidden' },
  colHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, backgroundColor: C.paper },
  colTitle: { fontSize: 12, fontWeight: '700', color: C.ink, textTransform: 'uppercase', letterSpacing: 0.5 },
  colCount: { fontSize: 12, color: C.mute, fontWeight: '600' },
  colScroll: { maxHeight: 500 },
  emptyCol: { fontSize: 12, color: C.mute, padding: 10, textAlign: 'center' },
  nomCard: { backgroundColor: C.paper, margin: 6, borderRadius: 10, padding: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  nomRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nomInfo: { flex: 1 },
  nomName: { fontSize: 13, fontWeight: '600', color: C.ink },
  nomPos: { fontSize: 11, color: C.mute },
  eligChip: { marginTop: 6 },
  addBtn: { margin: 6 },
  footer: { flexDirection: 'row', padding: 12, gap: 10, backgroundColor: C.paper, borderTopWidth: 1, borderTopColor: C.line },
});
