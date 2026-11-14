import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Btn, Card, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { useApiMutation } from '../api';

function ProposalField({ label, value }) {
  if (value === null || value === undefined) return null;
  const display = typeof value === 'number'
    ? value.toLocaleString()
    : String(value);
  return (
    <View style={styles.field} accessibilityLabel={`${label}: ${display}`}>
      <T style={styles.fieldLabel}>{label}</T>
      <T style={styles.fieldValue}>{display}</T>
    </View>
  );
}

function formatPriceCents(cents, currency) {
  if (cents == null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: 2 }).format(cents / 100);
  } catch { return `${cents / 100} ${currency ?? ''}`.trim(); }
}

/**
 * Concierge approval sheet rendered inline in the chat.
 * Props:
 *   approval   — {id, capability_name, proposal, proposal_hash, status, expires_at, display_name}
 *   onDone(result) — called with {confirmed: true|false, result?}
 */
export function ConciergeApproval({ approval, onDone }) {
  const [staleProposal, setStaleProposal] = useState(null);
  const { mutate: approve, loading: approving, error: approveError } = useApiMutation('approve_concierge_action');
  const { mutate: reject, loading: rejecting } = useApiMutation('reject_concierge_action');

  const proposal = staleProposal ?? approval.proposal ?? {};
  const isExpired = new Date(approval.expires_at) < new Date();
  const busy = approving || rejecting;

  const handleApprove = useCallback(async () => {
    try {
      const result = await approve({ id: approval.id, proposal_hash: staleProposal ? undefined : approval.proposal_hash });
      onDone?.({ confirmed: true, result });
    } catch (err) {
      if (err?.code === 'stale_blocked' && err?.new_proposal) {
        setStaleProposal(err.new_proposal);
      }
      // Other errors surfaced via approveError
    }
  }, [approve, approval, staleProposal, onDone]);

  const handleReject = useCallback(async () => {
    try {
      await reject({ id: approval.id });
      onDone?.({ confirmed: false });
    } catch { /* ignore */ }
  }, [reject, approval.id, onDone]);

  const displayName = approval.display_name ?? approval.capability_name?.replace(/_/g, ' ') ?? t('concierge.approval.title');

  if (approval.status === 'approved') {
    return (
      <Card style={styles.card}>
        <View style={styles.doneBadge}>
          <T style={styles.doneBadgeText}>{t('concierge.tool.approved')}</T>
        </View>
      </Card>
    );
  }
  if (approval.status === 'rejected') {
    return (
      <Card style={styles.card}>
        <T style={[styles.statusText, { color: c.mute }]}>{t('concierge.tool.rejected')}</T>
      </Card>
    );
  }

  return (
    <Card style={[styles.card, styles.pendingCard]} accessibilityLabel={t('concierge.a11y.approval_card').replace('{capability}', displayName)}>
      <View style={styles.headerRow}>
        <T style={styles.cardTitle}>{t('concierge.tool.proposed')}</T>
        <T style={styles.capName}>{displayName}</T>
      </View>

      {staleProposal ? (
        <View style={styles.staleWarning}>
          <T style={styles.staleText}>{t('concierge.approval.stale')}</T>
        </View>
      ) : null}

      {/* Warning strip */}
      <View style={styles.warning}>
        <T style={styles.warningText}>{t('concierge.approval.warning')}</T>
      </View>

      <ScrollView style={styles.fields} nestedScrollEnabled>
        {Object.entries(proposal).map(([k, v]) => {
          if (k === 'action') return null;
          if (k === 'price_cents') return <ProposalField key={k} label={t('concierge.proposal.price')} value={formatPriceCents(v, proposal.currency)} />;
          if (k === 'currency') return null; // shown with price
          const label = k.replace(/_/g, ' ');
          return <ProposalField key={k} label={label} value={v} />;
        })}
      </ScrollView>

      {approveError && approveError.code !== 'stale_blocked' ? (
        <T style={styles.errorText}>{approveError?.message ?? t('concierge.error.generic')}</T>
      ) : null}

      {isExpired ? (
        <T style={styles.expiredText}>{t('concierge.approval.expired')}</T>
      ) : (
        <View style={[styles.actions, Platform.OS !== 'ios' && styles.actionsRTL]}>
          <Btn
            label={t('concierge.approval.reject')}
            variant="outline"
            onPress={handleReject}
            loading={rejecting}
            disabled={busy}
            style={styles.rejectBtn}
            accessibilityLabel={t('concierge.approval.reject')}
          />
          <Btn
            label={t('concierge.approval.confirm')}
            onPress={handleApprove}
            loading={approving}
            disabled={busy}
            style={styles.confirmBtn}
            accessibilityLabel={t('concierge.approval.confirm')}
          />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 6, borderWidth: 1, borderColor: c.line, borderRadius: 12, overflow: 'hidden' },
  pendingCard: { borderColor: c.pink, borderWidth: 1.5 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  cardTitle: { fontSize: 12, fontWeight: '600', color: c.pink, textTransform: 'uppercase', letterSpacing: 0.5 },
  capName: { fontSize: 13, fontWeight: '600', color: c.ink },
  warning: { backgroundColor: c.sunSoft, paddingHorizontal: 14, paddingVertical: 8, marginHorizontal: 10, marginBottom: 8, borderRadius: 8 },
  warningText: { fontSize: 12, color: c.ink },
  staleWarning: { backgroundColor: c.sunSoft, paddingHorizontal: 14, paddingVertical: 8, marginHorizontal: 10, marginBottom: 4, borderRadius: 8 },
  staleText: { fontSize: 12, color: c.sun, fontWeight: '600' },
  fields: { maxHeight: 180, paddingHorizontal: 14 },
  field: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  fieldLabel: { fontSize: 12, color: c.mute, flex: 1, textTransform: 'capitalize' },
  fieldValue: { fontSize: 13, color: c.ink, flex: 2, textAlign: 'right' },
  actions: { flexDirection: 'row', gap: 10, padding: 12, paddingTop: 8 },
  actionsRTL: {},
  rejectBtn: { flex: 1 },
  confirmBtn: { flex: 2 },
  expiredText: { fontSize: 13, color: c.mute, fontStyle: 'italic', padding: 12 },
  errorText: { fontSize: 13, color: c.pink, paddingHorizontal: 12, paddingBottom: 6 },
  statusText: { padding: 12, fontSize: 13 },
  doneBadge: { flexDirection: 'row', alignItems: 'center', padding: 10 },
  doneBadgeText: { fontSize: 13, color: c.mint, fontWeight: '600' },
});
