// Issue #1194: Decision pack — signed dossier export, audit trail, appeals
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Share, Platform } from 'react-native';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { TextField } from '../components/TextField';

export default function SelectionDecisionPack({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const { campaignId } = route?.params ?? {};
  const { data: pack } = useApi(`/selection-campaigns/${campaignId}/decision-pack`);
  const { data: audit } = useApi(`/selection-campaigns/${campaignId}/audit`);
  const { mutate: submitAppeal, loading: appealLoading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/appeals`);
  const S = styles(C);

  const [showAppeal, setShowAppeal] = useState(false);
  const [grounds, setGrounds] = useState('');

  const exportPDF = () => {
    if (Platform.OS === 'web') {
      const url = pack?.pdf_url;
      if (url) window.open(url, '_blank');
    } else {
      Share.share({ url: pack?.pdf_url ?? '', title: t('sel.pack.pdfExport') });
    }
  };

  const exportCSV = () => {
    if (Platform.OS === 'web') {
      const url = pack?.csv_url;
      if (url) window.open(url, '_blank');
    } else {
      Share.share({ url: pack?.csv_url ?? '', title: t('sel.pack.csvExport') });
    }
  };

  return (
    <Screen title={t('sel.pack.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Summary */}
        <Card style={S.summaryCard}>
          <Text style={S.heading}>{t('sel.pack.summary')}</Text>
          <View style={S.row}><Text style={S.label}>{t('sel.pack.published')}</Text><Text style={S.val}>{pack?.published_at?.slice(0,10) ?? '—'}</Text></View>
          <View style={S.row}><Text style={S.label}>{t('sel.pack.starters')}</Text><Text style={S.val}>{pack?.roster_snapshot?.starters?.length ?? 0}</Text></View>
          <View style={S.row}><Text style={S.label}>{t('sel.pack.reserves')}</Text><Text style={S.val}>{pack?.roster_snapshot?.reserves?.length ?? 0}</Text></View>
          <View style={S.row}><Text style={S.label}>{t('sel.pack.eligibilityRecheck')}</Text><Chip label={pack?.eligibility_recheck_at ? t('common.done') : t('common.pending')} color={pack?.eligibility_recheck_at ? C.lime : C.sun} size="xs" /></View>
        </Card>

        {/* Export */}
        <Card style={S.exportCard}>
          <Text style={S.heading}>{t('sel.pack.export')}</Text>
          <View style={S.exportRow}>
            <Button label={t('sel.pack.pdfExport')} icon="file-text" onPress={exportPDF} style={{ flex: 1 }} accessibilityLabel={t('sel.pack.pdfExport')} />
            <Button label={t('sel.pack.csvExport')} icon="download" onPress={exportCSV} variant="outline" style={{ flex: 1 }} accessibilityLabel={t('sel.pack.csvExport')} />
          </View>
        </Card>

        {/* Approval decisions */}
        <Card style={S.decisionsCard}>
          <Text style={S.heading}>{t('sel.pack.approvalDecisions')}</Text>
          {(pack?.approval_decisions ?? []).map(d => (
            <View key={d.id} style={S.decisionRow}>
              <Text style={S.decisionActor}>{d.approver_name ?? d.approver_id}</Text>
              <Chip label={d.decision} color={{ approve: C.lime, reject: C.red, return: C.sun, abstain: C.mute }[d.decision] ?? C.mute} size="sm" />
              <Text style={S.decisionDate}>{d.decided_at?.slice(0,10)}</Text>
            </View>
          ))}
          {!pack?.approval_decisions?.length && <Text style={S.empty}>{t('sel.pack.noDecisions')}</Text>}
        </Card>

        {/* Audit trail (last 10) */}
        <Card style={S.auditCard}>
          <Text style={S.heading}>{t('sel.pack.auditTrail')}</Text>
          {(audit ?? []).slice(0, 10).map(e => (
            <View key={e.id} style={S.auditRow}>
              <Text style={S.auditType}>{e.event_type}</Text>
              <Text style={S.auditActor}>{e.actor_name}</Text>
              <Text style={S.auditDate}>{e.occurred_at?.slice(0,16)}</Text>
            </View>
          ))}
        </Card>

        {/* Appeal */}
        <Card style={S.appealCard}>
          <Text style={S.heading}>{t('sel.pack.appeal')}</Text>
          <Text style={S.hint}>{t('sel.pack.appealHint')}</Text>
          {!showAppeal ? (
            <Button label={t('sel.pack.submitAppeal')} onPress={() => setShowAppeal(true)} variant="outline" accessibilityLabel={t('sel.pack.submitAppeal')} />
          ) : (
            <>
              <TextField
                label={t('sel.pack.appealGrounds')}
                value={grounds}
                onChangeText={setGrounds}
                multiline
                numberOfLines={5}
                accessibilityLabel={t('sel.pack.appealGrounds')}
              />
              <Button
                label={t('sel.pack.sendAppeal')}
                onPress={() => submitAppeal({ grounds }).then(() => setShowAppeal(false))}
                loading={appealLoading}
                disabled={grounds.length < 20}
                style={{ marginTop: 10 }}
                accessibilityLabel={t('sel.pack.sendAppeal')}
              />
            </>
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  summaryCard: { padding: 16, marginBottom: 12 },
  exportCard: { padding: 16, marginBottom: 12 },
  decisionsCard: { padding: 16, marginBottom: 12 },
  auditCard: { padding: 16, marginBottom: 12 },
  appealCard: { padding: 16, marginBottom: 12 },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line },
  label: { fontSize: 13, color: C.mute },
  val: { fontSize: 13, fontWeight: '700', color: C.ink },
  exportRow: { flexDirection: 'row', gap: 10 },
  decisionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  decisionActor: { flex: 1, fontSize: 13, color: C.ink },
  decisionDate: { fontSize: 11, color: C.mute },
  auditRow: { flexDirection: 'row', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line },
  auditType: { flex: 1, fontSize: 12, color: C.ink },
  auditActor: { fontSize: 12, color: C.mute, minWidth: 80 },
  auditDate: { fontSize: 11, color: C.mute },
  empty: { color: C.mute, fontSize: 13 },
  hint: { fontSize: 12, color: C.mute, marginBottom: 10 },
});
