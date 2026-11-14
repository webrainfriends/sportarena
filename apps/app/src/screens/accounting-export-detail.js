// Accounting export detail screen (#513 — CA-grade): full lifecycle view with GST breakdown,
// amount summary, Tally TDL XML preview, and audit timeline.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { t } from '../i18n';
import { c, day } from '../theme';
import { money, atLeast } from './finance-parts';
import { useSession } from '../session';
import { useLayout } from '../layout';

/* ─────────────────────── constants ─────────────────────── */
const STATUS_BG  = { eligible: '#e0e3ec', queued: c.sunSoft,  exported: c.mintSoft, reconciled: c.limeSoft, failed: c.red, review: c.orangeSoft };
const STATUS_INK = { eligible: c.mute,    queued: c.ink,       exported: c.ink,      reconciled: c.ink,      failed: '#fff', review: c.ink };
const TAX_BG     = { cgst: c.sunSoft, sgst: c.sunSoft, igst: c.violetSoft, cess: c.orangeSoft, tds_194c: c.cyanSoft, tds_194j: c.cyanSoft };

/* ─────────────────────── atoms ─────────────────────── */
function StatusBadge({ status }) {
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: STATUS_BG[status] ?? '#e0e3ec', alignSelf: 'flex-start' }}>
      <T size={15} weight="800" color={STATUS_INK[status] ?? c.mute}>{t(`acct.status.${status}`)}</T>
    </View>
  );
}

function FactRow({ label, value, mono, color, right }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T size={13} color={c.mute} style={{ width: 150 }}>{label}</T>
      {right ?? <T size={14} weight="600" color={color ?? c.ink} style={mono ? { fontFamily: 'monospace', fontSize: 13 } : {}} numberOfLines={1} ellipsizeMode="middle">{value ?? '—'}</T>}
    </View>
  );
}

function AmountSummaryCard({ exp, lines, tablet }) {
  const currency = exp.currency ?? 'INR';
  const taxable  = (lines ?? []).filter((l) => !l.tax_component || l.tax_component === 'none').reduce((s, l) => s + (l.amount ?? 0), 0);
  const cgst     = (lines ?? []).filter((l) => l.tax_component === 'cgst').reduce((s, l) => s + (l.amount ?? 0), 0);
  const sgst     = (lines ?? []).filter((l) => l.tax_component === 'sgst').reduce((s, l) => s + (l.amount ?? 0), 0);
  const igst     = (lines ?? []).filter((l) => l.tax_component === 'igst').reduce((s, l) => s + (l.amount ?? 0), 0);
  const cess     = (lines ?? []).filter((l) => l.tax_component === 'cess').reduce((s, l) => s + (l.amount ?? 0), 0);
  const tds      = (lines ?? []).filter((l) => l.tax_component?.startsWith('tds')).reduce((s, l) => s + (l.amount ?? 0), 0);
  const total    = taxable + cgst + sgst + igst + cess;
  const intra    = exp.gst_treatment === 'intra_state';

  return (
    <Card style={{ gap: 2 }}>
      <T size={12} weight="700" color={c.mute} style={{ marginBottom: 6 }}>{t('acct.detail.amount_summary')}</T>
      <FactRow label={t('acct.detail.taxable_value')} value={money(taxable, currency)} />
      {cgst  ? <FactRow label="CGST"   value={money(cgst,  currency)} color={c.sun} /> : null}
      {sgst  ? <FactRow label="SGST"   value={money(sgst,  currency)} color={c.sun} /> : null}
      {igst  ? <FactRow label="IGST"   value={money(igst,  currency)} color={c.violet} /> : null}
      {cess  ? <FactRow label="GST Cess" value={money(cess, currency)} color={c.orange} /> : null}
      {tds   ? <FactRow label="TDS Deducted" value={`− ${money(tds, currency)}`} color={c.red} /> : null}
      <View style={{ marginTop: 6, paddingTop: 8, borderTopWidth: 2, borderTopColor: c.line }}>
        <FactRow label={t('acct.detail.total')} value={money(total, currency)} color={c.pink} />
        {tds ? <FactRow label={t('acct.detail.net_payable')} value={money(total - tds, currency)} color={c.mint} /> : null}
      </View>
      {exp.buyer_state_code ? (
        <Tag label={intra ? t('acct.detail.intra_state') : t('acct.detail.inter_state')} color={intra ? c.limeSoft : c.violetSoft} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      ) : null}
    </Card>
  );
}

function AuditTimeline({ exp }) {
  const events = [
    { label: t('acct.timeline.created'),    at: exp.created_at,     done: true },
    { label: t('acct.timeline.queued'),     at: exp.queued_at,      done: exp.status !== 'eligible' },
    { label: t('acct.timeline.exported'),   at: exp.exported_at,    done: ['exported','reconciled'].includes(exp.status) },
    { label: t('acct.timeline.reconciled'), at: exp.reconciled_at,  done: exp.status === 'reconciled' },
  ];
  return (
    <Card style={{ gap: 0 }}>
      <T size={12} weight="700" color={c.mute} style={{ marginBottom: 8 }}>{t('acct.timeline.title')}</T>
      {events.map((e, i) => (
        <View key={e.label} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6 }}>
          <View style={{ alignItems: 'center', width: 20 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: e.done ? c.mint : c.line, marginTop: 2 }} />
            {i < events.length - 1 ? <View style={{ width: 2, flex: 1, backgroundColor: c.line, marginTop: 2, minHeight: 16 }} /> : null}
          </View>
          <View style={{ flex: 1 }}>
            <T size={13} weight={e.done ? '700' : '400'} color={e.done ? c.ink : c.mute}>{e.label}</T>
            {e.at ? <T size={12} color={c.mute}>{day(e.at)}</T> : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

function LinesSection({ lines, currency }) {
  if (!lines?.length) return <Empty title={t('acct.empty.lines')} />;
  const total = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  return (
    <View>
      <T size={13} weight="700" color={c.mute} style={{ padding: 16, paddingBottom: 6 }}>{t('acct.export.lines', { n: lines.length })}</T>
      {lines.map((ln) => (
        <View key={ln.id ?? ln.line_no} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, minHeight: 44, gap: 8 }}>
          <T size={12} color={c.mute} style={{ width: 24, textAlign: 'right' }}>{ln.line_no}</T>
          <T size={14} style={{ flex: 1 }}>{ln.ledger_account}</T>
          {ln.tax_component && ln.tax_component !== 'none' ? (
            <View style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: TAX_BG[ln.tax_component] ?? c.paper }}>
              <T size={11} weight="700">{ln.tax_component.toUpperCase()}</T>
            </View>
          ) : null}
          <T size={14} weight="700" style={{ width: 100, textAlign: 'right' }} accessibilityLabel={`${ln.amount}`}>{money(ln.amount ?? 0, currency ?? 'INR')}</T>
        </View>
      ))}
      <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 2, borderTopColor: c.line }}>
        <T size={14} weight="800" style={{ flex: 1 }}>{t('acct.export.total')}</T>
        <T size={14} weight="800" color={c.pink} style={{ width: 100, textAlign: 'right' }}>{money(total, currency ?? 'INR')}</T>
      </View>
    </View>
  );
}

function TallyXmlPreview({ xml }) {
  const [expanded, setExpanded] = useState(false);
  if (!xml) return null;
  return (
    <Card style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('acct.detail.tally_xml')} onPress={() => setExpanded((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
        <T size={13} weight="700" color={c.mute} style={{ flex: 1 }}>{t('acct.detail.tally_xml')}</T>
        <T size={12} color={c.pink}>{expanded ? t('common.collapse') : t('common.expand')}</T>
      </Pressable>
      {expanded ? (
        <ScrollView horizontal style={{ maxHeight: 200 }} showsHorizontalScrollIndicator>
          <T size={11} style={{ fontFamily: 'monospace', color: c.cyan, lineHeight: 18 }}>{xml.slice(0, 4000)}</T>
        </ScrollView>
      ) : null}
    </Card>
  );
}

/* ─────────────────────── Root screen ─────────────────────── */
export function AccountingExportDetail({ id, orgId }) {
  const { user } = useSession();
  const { tablet } = useLayout();
  const [busy,   setBusy]   = useState(false);
  const [toast,  setToast]  = useState(null);
  const [reason, setReason] = useState('');
  const [extRef, setExtRef] = useState('');
  const [sheet,  setSheet]  = useState(null); // 'retry' | 'resolve'

  const level = user?.finance_level ?? 'viewer';
  const data  = useLoad(() => api.get(`/accounting/exports/${id}`), [id]);

  const doAction = async (action) => {
    setBusy(true);
    try {
      if (action === 'retry') {
        await api.post(`/accounting/exports/${id}/retry`, {});
        setToast(t('acct.export.retry_queued'));
      } else if (action === 'reconcile') {
        await api.post(`/accounting/exports/${id}/resolve`, { action: 'reconcile', external_ref: extRef });
        setToast(t('acct.export.resolved'));
      } else {
        await api.post(`/accounting/exports/${id}/resolve`, { action: 'write_off', reason });
        setToast(t('acct.export.resolved'));
      }
      setSheet(null);
      data.reload();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  };

  if (data.error) return <Screen><ErrorBox error={data.error} onRetry={data.reload} /></Screen>;
  if (!data.data) return <Screen><Loading /></Screen>;

  const exp      = data.data;
  const lines    = exp.lines ?? [];
  const currency = exp.currency ?? 'INR';
  const canRetry   = atLeast(level, 'accountant') && (exp.status === 'failed' || exp.status === 'review');
  const canResolve = atLeast(level, 'controller') && (exp.status === 'exported' || exp.status === 'failed' || exp.status === 'review');

  return (
    <Screen scroll>
      <View style={{ gap: 16, paddingBottom: 32 }}>

        {/* Status + ref row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 16, paddingBottom: 0 }}>
          <StatusBadge status={exp.status} />
          <View style={{ flex: 1 }}>
            <T size={13} weight="700" color={c.mute}>{t(`acct.doc.${exp.document_type}`)}</T>
            <T size={12} color={c.mute} style={{ fontFamily: 'monospace' }}>{exp.document_id?.slice(0, 8).toUpperCase()}</T>
          </View>
          {exp.external_ref ? <Tag label={exp.external_ref} color={c.mintSoft} /> : null}
        </View>

        {/* Error banner */}
        {exp.error_message ? (
          <View style={{ backgroundColor: c.orangeSoft, borderRadius: 12, padding: 14, marginHorizontal: 16 }}>
            <T size={13} weight="700" color={c.orange}>{exp.error_message}</T>
          </View>
        ) : null}

        {toast ? <T size={13} color={c.mint} style={{ paddingHorizontal: 16 }}>{toast}</T> : null}

        {/* Amount summary (CA primary view) */}
        <View style={{ paddingHorizontal: 16 }}>
          <AmountSummaryCard exp={exp} lines={lines} tablet={tablet} />
        </View>

        {/* Core facts */}
        <Card style={{ marginHorizontal: 16, gap: 0 }}>
          <T size={12} weight="700" color={c.mute} style={{ marginBottom: 6 }}>{t('acct.detail.document_details')}</T>
          <FactRow label={t('acct.export.document_type')}  value={t(`acct.doc.${exp.document_type}`)} />
          <FactRow label={t('acct.export.provider')}       value={exp.provider?.replace('accounting_', '').replace('_', ' ')} />
          <FactRow label={t('acct.export.external_ref')}   value={exp.external_ref} />
          {exp.party_name   ? <FactRow label={t('acct.detail.party_name')}  value={exp.party_name} /> : null}
          {exp.party_gstin  ? <FactRow label={t('acct.detail.party_gstin')} value={exp.party_gstin} mono /> : null}
          <FactRow label={t('acct.export.payload_version')} value={String(exp.payload_version ?? 1)} />
          <FactRow label={t('acct.export.payload_hash')}   value={exp.payload_hash?.slice(0, 20)} mono />
          <FactRow label={t('acct.export.document_id')}    value={exp.document_id} mono />
        </Card>

        {/* Audit timeline */}
        <View style={{ paddingHorizontal: 16 }}>
          <AuditTimeline exp={exp} />
        </View>

        {/* Lines */}
        <Card style={{ marginHorizontal: 16, padding: 0, overflow: 'hidden' }}>
          <LinesSection lines={lines} currency={currency} />
        </Card>

        {/* Tally TDL XML preview */}
        {exp.tally_xml ? (
          <View style={{ paddingHorizontal: 16 }}>
            <TallyXmlPreview xml={exp.tally_xml} />
          </View>
        ) : null}

        {/* Actions */}
        {(canRetry || canResolve) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16 }}>
            {canRetry   ? <Btn title={t('acct.export.retry')} color={c.sun} ink={c.ink} onPress={() => setSheet('retry')} accessibilityLabel={t('acct.export.retry')} /> : null}
            {canResolve ? <Btn title={t('acct.export.mark_reconciled')} color={c.mint} ink={c.ink} onPress={() => { setExtRef(''); setSheet('resolve'); }} accessibilityLabel={t('acct.export.mark_reconciled')} /> : null}
            {canResolve ? <Btn title={t('acct.export.write_off')} color={c.paper} ink={c.red} onPress={() => { setReason(''); setSheet('write_off'); }} accessibilityLabel={t('acct.export.write_off')} /> : null}
          </View>
        ) : null}
      </View>

      {/* Retry confirm sheet */}
      <Sheet visible={sheet === 'retry'} onClose={() => setSheet(null)} title={t('acct.export.retry_title')}>
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>{t('acct.export.retry_confirm')}</T>
          <Btn title={t('acct.export.retry')} loading={busy} color={c.sun} ink={c.ink} onPress={() => doAction('retry')} accessibilityLabel={t('acct.export.retry')} />
        </View>
      </Sheet>

      {/* Reconcile sheet */}
      <Sheet visible={sheet === 'resolve'} onClose={() => setSheet(null)} title={t('acct.export.mark_reconciled')}>
        <View style={{ gap: 14 }}>
          <T size={13} color={c.mute}>{t('acct.resolve.external_ref_desc')}</T>
          <Field label={t('acct.resolve.external_ref')} value={extRef} onChangeText={setExtRef}
            placeholder={t('acct.resolve.external_ref_placeholder')} autoCapitalize="characters"
            accessibilityLabel={t('acct.resolve.external_ref')} />
          <Btn title={t('acct.export.mark_reconciled')} loading={busy} color={c.mint} ink={c.ink} onPress={() => doAction('reconcile')} accessibilityLabel={t('acct.export.mark_reconciled')} />
        </View>
      </Sheet>

      {/* Write-off sheet */}
      <Sheet visible={sheet === 'write_off'} onClose={() => setSheet(null)} title={t('acct.export.write_off')}>
        <View style={{ gap: 14 }}>
          <T size={13} color={c.mute}>{t('acct.resolve.write_off_desc')}</T>
          <Field label={t('acct.resolve.reason')} value={reason} onChangeText={setReason}
            placeholder={t('acct.resolve.reason_placeholder')} multiline
            accessibilityLabel={t('acct.resolve.reason')} />
          <Btn title={t('acct.export.write_off')} loading={busy} color={c.paper} ink={c.red} onPress={() => doAction('write_off')} accessibilityLabel={t('acct.export.write_off')} />
        </View>
      </Sheet>
    </Screen>
  );
}
