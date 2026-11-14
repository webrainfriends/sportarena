// Issue #1194: Approval inbox — chain visualization, approve/reject/return/abstain
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Svg, Circle, Line, Text as SvgText } from 'react-native-svg';
import { useTranslation } from '../i18n';
import { useTheme } from '../theme';
import { useApi, useApiMutation } from '../api';
import { Screen } from '../components/Screen';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { Chip } from '../components/Chip';
import { useNavigation } from '@react-navigation/native';

function ApprovalChain({ routes, C }) {
  if (!routes?.length) return null;
  const nodeW = 80;
  const svgW = routes.length * nodeW + 40;
  const svgH = 80;
  const statusColor = { pending: C.mute, active: C.sun, completed: C.lime, skipped: C.red, delegated: C.cyan };
  return (
    <Svg width={svgW} height={svgH} accessibilityLabel="Approval chain">
      {routes.map((r, i) => {
        const cx = 20 + i * nodeW + nodeW / 2;
        const cy = 40;
        const color = statusColor[r.status] ?? C.mute;
        return (
          <React.Fragment key={r.id}>
            {i > 0 && <Line x1={cx - nodeW} y1={cy} x2={cx - 10} y2={cy} stroke={C.line} strokeWidth={2} />}
            <Circle cx={cx} cy={cy} r={18} fill={color} />
            <SvgText x={cx} y={cy + 4} textAnchor="middle" fontSize={9} fill="white" fontWeight="700">{r.approver_role?.slice(0,6)}</SvgText>
            <SvgText x={cx} y={cy + 24} textAnchor="middle" fontSize={8} fill={C.mute}>{r.status}</SvgText>
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

export default function SelectionApprovalInbox({ route }) {
  const { t } = useTranslation();
  const C = useTheme();
  const nav = useNavigation();
  const { campaignId, recommendationId } = route?.params ?? {};
  const { data: routes } = useApi(`/selection-campaigns/${campaignId}/approval-routes`);
  const { mutate: decide, loading } = useApiMutation('POST', `/selection-campaigns/${campaignId}/approval-decision`);
  const S = styles(C);

  const [decision, setDecision] = useState(null);
  const [reason, setReason] = useState('');

  const activeRoute = (routes ?? []).find(r => r.status === 'active');

  const submit = async () => {
    if (!activeRoute || !decision) return;
    await decide({ route_id: activeRoute.id, recommendation_id: recommendationId, decision, reason });
    if (decision === 'approve') nav.navigate('SelectionDecisionPack', { campaignId });
  };

  const decisionColor = { approve: C.lime, reject: C.red, return: C.sun, abstain: C.mute };

  return (
    <Screen title={t('sel.approval.title')} back>
      <ScrollView contentContainerStyle={S.scroll}>
        {/* Approval chain visualization */}
        <Card style={S.chainCard}>
          <Text style={S.heading}>{t('sel.approval.chain')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <ApprovalChain routes={routes} C={C} />
          </ScrollView>
        </Card>

        {activeRoute ? (
          <Card style={S.decisionCard}>
            <Text style={S.heading}>{t('sel.approval.pendingDecision')}</Text>
            <Text style={S.routeInfo}>{t('sel.approval.approver')}: <Text style={S.bold}>{activeRoute.approver_name ?? activeRoute.approver_id}</Text></Text>
            <Text style={S.routeInfo}>{t('sel.approval.role')}: <Text style={S.bold}>{activeRoute.approver_role}</Text></Text>
            <Text style={S.routeInfo}>{t('sel.approval.sla')}: {activeRoute.sla_hours}h</Text>

            <View style={S.decisionRow}>
              {['approve','reject','return','abstain'].map(d => (
                <Button
                  key={d}
                  label={t(`sel.approval.${d}`)}
                  variant={decision === d ? 'primary' : 'outline'}
                  onPress={() => setDecision(d)}
                  size="sm"
                  style={{ flex: 1 }}
                  accessibilityLabel={t(`sel.approval.${d}`)}
                />
              ))}
            </View>

            {decision && (
              <TextField
                label={t('sel.approval.reason')}
                value={reason}
                onChangeText={setReason}
                multiline
                numberOfLines={4}
                placeholder={t('sel.approval.reasonPlaceholder')}
                style={S.reasonField}
                accessibilityLabel={t('sel.approval.reason')}
              />
            )}

            <Button
              label={t('sel.approval.submit')}
              onPress={submit}
              loading={loading}
              disabled={!decision || reason.length < 10}
              style={S.submitBtn}
              accessibilityLabel={t('sel.approval.submit')}
            />
          </Card>
        ) : (
          <Card style={S.decisionCard}>
            <Text style={S.empty}>{t('sel.approval.noActiveStep')}</Text>
          </Card>
        )}

        {/* Completed decisions */}
        {(routes ?? []).filter(r => r.status === 'completed').length > 0 && (
          <Card style={S.historyCard}>
            <Text style={S.heading}>{t('sel.approval.history')}</Text>
            {routes.filter(r => r.status === 'completed').map(r => (
              <View key={r.id} style={S.histRow}>
                <Text style={S.histName}>{r.approver_name ?? r.approver_role}</Text>
                <Chip label={r.last_decision ?? 'completed'} color={decisionColor[r.last_decision] ?? C.lime} size="xs" />
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = (C) => StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 40 },
  chainCard: { padding: 14, marginBottom: 14 },
  decisionCard: { padding: 16, marginBottom: 14 },
  historyCard: { padding: 14, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 12 },
  routeInfo: { fontSize: 13, color: C.mute, marginBottom: 4 },
  bold: { fontWeight: '700', color: C.ink },
  decisionRow: { flexDirection: 'row', gap: 6, marginVertical: 14, flexWrap: 'wrap' },
  reasonField: { marginBottom: 12 },
  submitBtn: {},
  empty: { color: C.mute, fontSize: 13 },
  histRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  histName: { fontSize: 13, color: C.ink },
});
