// Accounting Integration Hub (#513 — CA-grade rewrite): Tally ERP + Zoho Books with full audit-grade
// lifecycle: overview, effective-dated mappings, export queue, reconciliation, and reporting.
// All canonical finance data is read-only here; this screen only manages the export layer.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, GradCard, H2, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { MenuField } from '../menu-field';
import { t } from '../i18n';
import { c, day } from '../theme';
import { Kpi } from './academy-ui';
import { atLeast, money } from './finance-parts';
import { AccountingMappingEditor } from './accounting-mapping';

/* ─────────────────────── constants ─────────────────────── */
const STATUS_BG  = { eligible: '#e0e3ec', queued: c.sunSoft,  exported: c.mintSoft, reconciled: c.limeSoft, failed: c.red, review: c.orangeSoft };
const STATUS_INK = { eligible: c.mute,    queued: c.ink,       exported: c.ink,      reconciled: c.ink,      failed: '#fff', review: c.ink };

const PROVIDER_OPTS = [
  { value: '', label: t('common.all') },
  { value: 'accounting_tally',      label: t('acct.provider.tally') },
  { value: 'accounting_zoho_books', label: t('acct.provider.zoho_books') },
];
const STATUS_OPTS = [
  { value: '', label: t('common.all') },
  ...['eligible','queued','exported','reconciled','failed','review'].map((v) => ({ value: v, label: t(`acct.status.${v}`) })),
];
const DOC_OPTS = [
  { value: '', label: t('common.all') },
  ...['invoice','credit_note','payment','journal'].map((v) => ({ value: v, label: t(`acct.doc.${v}`) })),
];
const PERIOD_OPTS = [
  { value: 'month',   label: t('acct.period.month') },
  { value: 'quarter', label: t('acct.period.quarter') },
  { value: 'fy',      label: t('acct.period.fy') },
  { value: 'custom',  label: t('acct.period.custom') },
];

/* ─────────────────────── small atoms ─────────────────────── */
function StatusChip({ status, style }) {
  return (
    <View style={[{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: STATUS_BG[status] ?? '#e0e3ec', minWidth: 44, alignItems: 'center', justifyContent: 'center' }, style]}>
      <T size={11} weight="700" color={STATUS_INK[status] ?? c.mute}>{t(`acct.status.${status}`)}</T>
    </View>
  );
}

function CapTags({ capabilities }) {
  if (!capabilities?.length) return null;
  const display = capabilities.slice(0, 4);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
      {display.map((cap) => <Tag key={cap} label={cap.replace(/_/g, ' ')} color={c.violetSoft} />)}
      {capabilities.length > 4 ? <Tag label={`+${capabilities.length - 4}`} color={c.violetSoft} /> : null}
    </View>
  );
}

/* ─────────────────────── Overview tab ─────────────────────── */
function ProviderCard({ p, orgId, onSync, onExportFile, syncing }) {
  const nav = useNav();
  const connected = p.status === 'connected';
  const hasError  = p.status === 'error';
  const bg = connected ? c.mintSoft : hasError ? c.orangeSoft : c.paper;
  const failCount = p.counts?.failed ?? 0;
  return (
    <Card color={bg} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <View style={{ flex: 1 }}>
          <T weight="800" size={17}>{p.provider_name}</T>
          {p.last_sync_at ? <T size={12} color={c.mute} style={{ marginTop: 1 }}>{t('acct.last_sync', { date: day(p.last_sync_at) })}</T> : null}
        </View>
        <Tag label={connected ? t('acct.status.connected') : hasError ? t('acct.status.error') : t('acct.status.not_connected')} color={connected ? c.mintSoft : hasError ? c.orangeSoft : c.violetSoft} />
      </View>
      {p.gst_profile_name ? <T size={12} color={c.mute}>{t('acct.gst_profile')}: {p.gst_profile_name} · {p.gstin}</T> : null}
      <CapTags capabilities={p.capabilities} />
      {hasError && p.last_error ? (
        <View style={{ backgroundColor: c.orangeSoft, borderRadius: 8, padding: 8, marginTop: 2 }}>
          <T size={12} color={c.orange} numberOfLines={2}>{p.last_error}</T>
        </View>
      ) : null}
      {failCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff4', borderRadius: 8, padding: 8 }}>
          <T size={13} color={c.red} weight="700" style={{ flex: 1 }}>{t('acct.failed_badge', { n: failCount })}</T>
          <Tag label={String(failCount)} color={c.red} />
        </View>
      ) : null}
      {/* Metric row */}
      {connected ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
          {(['eligible','queued','exported','reconciled']).map((s) => (
            <View key={s} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: STATUS_BG[s] }}>
              <T size={12} weight="700" color={STATUS_INK[s]}>{p.counts?.[s] ?? 0} {t(`acct.status.${s}`)}</T>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        <Btn small title={connected ? t('acct.configure') : t('acct.connect')} color={c.pink} ink="#fff"
          onPress={() => nav.push('IntegrationHub', { orgId, category: 'accounting', providerKey: p.provider_key })}
          accessibilityLabel={`${t('acct.connect')} ${p.provider_name}`} />
        {connected ? (
          <Btn small title={t('acct.sync_now')} loading={syncing} color={c.paper} ink={c.ink}
            onPress={() => onSync(p.provider_key)} accessibilityLabel={t('acct.sync_now')} />
        ) : null}
        {connected ? (
          <Btn small title={t('acct.test_connection')} color={c.paper} ink={c.ink}
            onPress={() => onSync(p.provider_key + '__test')} accessibilityLabel={t('acct.test_connection')} />
        ) : null}
        {p.provider_key === 'accounting_tally' && connected ? (
          <Btn small title={t('acct.export_file')} color={c.paper} ink={c.ink}
            onPress={() => onExportFile()} accessibilityLabel={t('acct.export_file')} />
        ) : null}
      </View>
    </Card>
  );
}

function OverviewTab({ status, orgId, level, onSync, syncing, onExportFile, onGoRecon, period, setPeriod }) {
  if (status.error) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!status.data)  return <Loading />;
  const { providers, totals, gst_profile } = status.data;

  const eligible    = totals?.eligible    ?? 0;
  const queued      = totals?.queued      ?? 0;
  const exported    = totals?.exported    ?? 0;
  const reconciled  = totals?.reconciled  ?? 0;
  const failed      = totals?.failed      ?? 0;
  const totalValue  = totals?.queued_value_minor ?? 0;
  const reconPct    = exported ? Math.round((reconciled / exported) * 100) : 0;

  return (
    <View style={{ gap: 14 }}>
      <MenuField label={t('acct.period.label')} value={period} onChange={setPeriod} options={PERIOD_OPTS} />

      {/* KPI strip — 2 rows for CA visibility */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 10, paddingBottom: 2 }}>
        <Kpi label={t('acct.kpi.eligible')}   value={String(eligible)} />
        <Kpi label={t('acct.kpi.queued')}     value={String(queued)} />
        <Kpi label={t('acct.kpi.exported')}   value={String(exported)} />
        <Kpi label={t('acct.kpi.reconciled')} value={String(reconciled)} />
        <Kpi label={t('acct.kpi.failed')}     value={String(failed)}    tone={failed > 0 ? 'alert' : undefined} />
        <Kpi label={t('acct.kpi.recon_pct')}  value={`${reconPct}%`} />
        <Kpi label={t('acct.kpi.queued_value')} value={money(totalValue, 'INR')} wide />
      </ScrollView>

      {/* GST Profile summary */}
      {gst_profile ? (
        <Card style={{ gap: 4 }}>
          <T size={12} weight="700" color={c.mute}>{t('acct.gst_profile_summary')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
            <T size={13} weight="700">{gst_profile.legal_name}</T>
            <Tag label={gst_profile.gstin} color={c.violetSoft} />
            <Tag label={`${t('acct.state')}: ${gst_profile.state_code}`} color={c.cyanSoft} />
            <Tag label={gst_profile.filing_frequency === 'monthly' ? t('acct.gst_monthly') : t('acct.gst_quarterly')} color={c.sunSoft} />
          </View>
        </Card>
      ) : null}

      {/* Error banner */}
      {failed > 0 ? (
        <View style={{ backgroundColor: c.orangeSoft, borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T size={13} color={c.orange} weight="700" style={{ flex: 1 }}>{t('acct.failed_summary', { n: failed })}</T>
          <Btn small title={t('acct.review_failed')} onPress={onGoRecon} color={c.red} ink="#fff" accessibilityLabel={t('acct.review_failed')} />
        </View>
      ) : null}

      {/* Quick actions (accountant+) */}
      {atLeast(level, 'accountant') ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Btn small title={t('acct.queue_all_eligible')} color={c.pink} ink="#fff"
            onPress={() => onSync('__queue_all')} accessibilityLabel={t('acct.queue_all_eligible')} />
          {failed > 0 ? (
            <Btn small title={t('acct.retry_all_failed')} color={c.paper} ink={c.red}
              onPress={() => onSync('__retry_all')} accessibilityLabel={t('acct.retry_all_failed')} />
          ) : null}
        </View>
      ) : null}

      {/* Provider cards */}
      {providers.map((p) => (
        <ProviderCard key={p.provider_key} p={p} orgId={orgId} onSync={onSync} onExportFile={onExportFile} syncing={syncing === p.provider_key} />
      ))}
    </View>
  );
}

/* ─────────────────────── Exports tab ─────────────────────── */
function ExportRow({ exp, onPress }) {
  const gross = exp.gross_minor;
  return (
    <Pressable accessibilityRole="button"
      accessibilityLabel={`${exp.document_type} ${exp.document_id?.slice(0, 8)} ${t(`acct.status.${exp.status}`)}`}
      onPress={onPress} style={{ minHeight: 52 }}>
      <Row
        title={`${t(`acct.doc.${exp.document_type}`)} · ${exp.document_id?.slice(0, 8).toUpperCase()}`}
        sub={[exp.external_ref, exp.party_name, exp.exported_at ? day(exp.exported_at) : null].filter(Boolean).join(' · ')}
        right={
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <StatusChip status={exp.status} />
            {gross != null ? <T size={12} weight="700" color={c.mute}>{money(gross, exp.currency ?? 'INR')}</T> : null}
          </View>
        }
      />
    </Pressable>
  );
}

function ExportsTab({ orgId, level }) {
  const nav = useNav();
  const [provider, setProvider] = useState('');
  const [status,   setStatus]   = useState('');
  const [docType,  setDocType]  = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [busy,     setBusy]     = useState(false);
  const [toast,    setToast]    = useState(null);

  const params = {
    ...(provider ? { provider }             : {}),
    ...(status   ? { status }               : {}),
    ...(docType  ? { document_type: docType }: {}),
    ...(dateFrom ? { from: dateFrom }        : {}),
    ...(dateTo   ? { to: dateTo }            : {}),
    limit: 50,
  };
  const data = useLoad(() => api.get(`/organisations/${orgId}/accounting/exports`, params), [JSON.stringify(params)]);

  const queueAll = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/organisations/${orgId}/accounting/exports/queue`, { all_eligible: true });
      setToast(t('acct.sync_done', { n: r.queued ?? 0 }));
      data.reload();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  };

  const totals = data.data?.totals;

  return (
    <View style={{ gap: 12 }}>
      {/* Filters */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 130 }}>
          <MenuField label={t('acct.filter.provider')} value={provider} onChange={setProvider} options={PROVIDER_OPTS} />
        </View>
        <View style={{ flex: 1, minWidth: 130 }}>
          <MenuField label={t('acct.filter.status')} value={status} onChange={setStatus} options={STATUS_OPTS} />
        </View>
        <View style={{ flex: 1, minWidth: 130 }}>
          <MenuField label={t('acct.filter.doc_type')} value={docType} onChange={setDocType} options={DOC_OPTS} />
        </View>
      </View>
      <DateRangeField labelFrom={t('acct.filter.from')} labelTo={t('acct.filter.to')} from={dateFrom} to={dateTo} onChangeFrom={setDateFrom} onChangeTo={setDateTo} />

      {/* Totals row */}
      {totals ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(totals).map(([s, n]) => (
            <View key={s} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: STATUS_BG[s] ?? c.paper }}>
              <T size={12} weight="700" color={STATUS_INK[s] ?? c.mute}>{n} {t(`acct.status.${s}`)}</T>
            </View>
          ))}
        </View>
      ) : null}

      {toast ? <T size={13} color={c.mint}>{toast}</T> : null}

      {/* Bulk actions (accountant+) */}
      {atLeast(level, 'accountant') ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title={t('acct.queue_all_eligible')} color={c.pink} ink="#fff" loading={busy} onPress={queueAll} accessibilityLabel={t('acct.queue_all_eligible')} />
        </View>
      ) : null}

      {!data.data ? <Loading /> : !data.data.items?.length ? (
        <Empty title={t('acct.empty.exports')} sub={t('acct.empty.exports_hint')} />
      ) : (
        data.data.items.map((exp) => (
          <ExportRow key={exp.id} exp={exp} onPress={() => nav.push('AccountingExportDetail', { id: exp.id, orgId })} />
        ))
      )}
    </View>
  );
}

/* ─────────────────────── Reconciliation tab ─────────────────────── */
function ReconRow({ exp, onResolve }) {
  return (
    <Row
      title={`${t(`acct.doc.${exp.document_type}`)} · ${exp.document_id?.slice(0, 8).toUpperCase()}`}
      sub={exp.error_message?.slice(0, 100) ?? (exp.status === 'exported' ? t('acct.recon.no_ref') : t('acct.recon.hash_changed'))}
      right={
        <View style={{ gap: 6, alignItems: 'flex-end' }}>
          <StatusChip status={exp.status} />
          <Btn small title={t('acct.export.resolve')} color={c.paper} ink={c.ink}
            onPress={() => onResolve(exp)} accessibilityLabel={`${t('acct.export.resolve')} ${exp.document_id?.slice(0, 8)}`} />
        </View>
      }
    />
  );
}

function ReconciliationTab({ orgId, level }) {
  const [seg,         setSeg]         = useState('failed');
  const [resolving,   setResolving]   = useState(null);
  const [resolveAct,  setResolveAct]  = useState('reconcile');
  const [externalRef, setExternalRef] = useState('');
  const [reason,      setReason]      = useState('');
  const [busy,        setBusy]        = useState(false);
  const [toast,       setToast]       = useState(null);

  const data = useLoad(() => api.get(`/organisations/${orgId}/accounting/reconciliation`), [orgId]);

  const doResolve = async () => {
    if (!resolving) return;
    setBusy(true);
    try {
      await api.post(`/accounting/exports/${resolving.id}/resolve`, {
        action:       resolveAct,
        external_ref: resolveAct === 'reconcile' ? externalRef : undefined,
        reason:       resolveAct !== 'reconcile' ? reason : undefined,
      });
      setToast(t('acct.recon.resolved'));
      setResolving(null);
      data.reload();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  };

  const doRetry = async (exp) => {
    setBusy(true);
    try {
      await api.post(`/accounting/exports/${exp.id}/retry`, {});
      setToast(t('acct.export.retry_queued'));
      data.reload();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  };

  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const { unmatched, failed, changed, counts } = data.data;

  const segOpts = [
    { value: 'failed',    label: `${t('acct.recon.failed')} (${counts.failed ?? 0})` },
    { value: 'unmatched', label: `${t('acct.recon.unmatched')} (${counts.unmatched ?? 0})` },
    { value: 'changed',   label: `${t('acct.recon.changed')} (${counts.changed ?? 0})` },
  ];
  const list = seg === 'failed' ? failed : seg === 'unmatched' ? unmatched : (changed ?? []);

  return (
    <View style={{ gap: 12 }}>
      {toast ? <T size={13} color={c.mint}>{toast}</T> : null}

      {/* BRS summary */}
      <Card style={{ gap: 6 }}>
        <T size={12} weight="700" color={c.mute}>{t('acct.recon.brs_title')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <View style={{ flex: 1, minWidth: 120 }}>
            <T size={11} color={c.mute}>{t('acct.recon.total_exported')}</T>
            <T size={16} weight="800">{money(counts.exported_value ?? 0, 'INR')}</T>
          </View>
          <View style={{ flex: 1, minWidth: 120 }}>
            <T size={11} color={c.mute}>{t('acct.recon.total_reconciled')}</T>
            <T size={16} weight="800" color={c.mint}>{money(counts.reconciled_value ?? 0, 'INR')}</T>
          </View>
          <View style={{ flex: 1, minWidth: 120 }}>
            <T size={11} color={c.mute}>{t('acct.recon.variance')}</T>
            <T size={16} weight="800" color={counts.variance !== 0 ? c.red : c.mint}>
              {money((counts.exported_value ?? 0) - (counts.reconciled_value ?? 0), 'INR')}
            </T>
          </View>
        </View>
      </Card>

      <Seg options={segOpts} value={seg} onChange={setSeg} />

      {!list.length ? <Empty title={t('acct.empty.reconciliation')} /> : list.map((exp) => (
        seg === 'failed' ? (
          <Row key={exp.id}
            title={`${t(`acct.doc.${exp.document_type}`)} · ${exp.document_id?.slice(0, 8).toUpperCase()}`}
            sub={exp.error_message?.slice(0, 100)}
            right={
              <View style={{ gap: 5, alignItems: 'flex-end' }}>
                <StatusChip status={exp.status} />
                {atLeast(level, 'accountant') ? (
                  <Btn small title={t('acct.export.retry')} color={c.sun} ink={c.ink} loading={busy}
                    onPress={() => doRetry(exp)} accessibilityLabel={t('acct.export.retry')} />
                ) : null}
              </View>
            }
          />
        ) : (
          <ReconRow key={exp.id} exp={exp} onResolve={(e) => { setResolving(e); setExternalRef(''); setReason(''); setResolveAct('reconcile'); }} />
        )
      ))}

      {/* Resolve bottom sheet */}
      <Sheet visible={!!resolving} onClose={() => setResolving(null)} title={t('acct.export.resolve_title')}>
        {resolving ? (
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <T size={13} color={c.mute}>{t(`acct.doc.${resolving.document_type}`)} · {resolving.document_id?.slice(0, 8).toUpperCase()}</T>
              <StatusChip status={resolving.status} />
            </View>
            <Seg
              options={[{ value: 'reconcile', label: t('acct.resolve.action.reconcile') }, { value: 'write_off', label: t('acct.resolve.action.write_off') }]}
              value={resolveAct} onChange={setResolveAct}
            />
            {resolveAct === 'reconcile' ? (
              <Field label={t('acct.resolve.external_ref')} value={externalRef} onChangeText={setExternalRef}
                placeholder={t('acct.resolve.external_ref_placeholder')} autoCapitalize="characters"
                accessibilityLabel={t('acct.resolve.external_ref')} />
            ) : (
              <Field label={t('acct.resolve.reason')} value={reason} onChangeText={setReason}
                placeholder={t('acct.resolve.reason_placeholder')} multiline
                accessibilityLabel={t('acct.resolve.reason')} />
            )}
            <Btn title={t('acct.export.resolve')} loading={busy} onPress={doResolve}
              color={resolveAct === 'reconcile' ? c.mint : c.paper} ink={resolveAct === 'reconcile' ? c.ink : c.red}
              accessibilityLabel={t('acct.export.resolve')} />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

/* ─────────────────────── Reports tab ─────────────────────── */
function TrialBalanceRow({ row }) {
  return (
    <Row
      title={row.ledger_account}
      sub={t(`acct.mapping.type.${row.mapping_type}`)}
      right={
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
          <View style={{ alignItems: 'flex-end' }}>
            <T size={11} color={c.mute}>{t('acct.tb.debit')}</T>
            <T size={14} weight="700">{money(row.debit_minor ?? 0, 'INR')}</T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T size={11} color={c.mute}>{t('acct.tb.credit')}</T>
            <T size={14} weight="700">{money(row.credit_minor ?? 0, 'INR')}</T>
          </View>
        </View>
      }
    />
  );
}

function ReportsTab({ orgId, level }) {
  const [seg,  setSeg]  = useState('trial_balance');
  const [from, setFrom] = useState('');
  const [to,   setTo]   = useState('');
  const [busy, setBusy] = useState(false);

  const params = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const journals = useLoad(() => api.get(`/organisations/${orgId}/accounting/journals`, params), [orgId, JSON.stringify(params)]);

  const download = async (type) => {
    setBusy(true);
    try {
      if (Platform.OS === 'web') {
        const url = `/api/v1/organisations/${orgId}/accounting/tally/export?from=${from}&to=${to}`;
        const a = document.createElement('a');
        a.href = url; a.download = `tally-export-${from}-${to}.xml`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
    } catch (e) { } finally { setBusy(false); }
  };

  const segOpts = [
    { value: 'trial_balance', label: t('acct.report.trial_balance') },
    { value: 'gst_summary',   label: t('acct.report.gst_summary') },
    { value: 'handover',      label: t('acct.report.handover') },
  ];

  if (journals.error) return <ErrorBox error={journals.error} onRetry={journals.reload} />;

  return (
    <View style={{ gap: 14 }}>
      <DateRangeField labelFrom={t('acct.filter.from')} labelTo={t('acct.filter.to')} from={from} to={to} onChangeFrom={setFrom} onChangeTo={setTo} />
      <Seg options={segOpts} value={seg} onChange={setSeg} />

      {seg === 'trial_balance' ? (
        <View>
          {!journals.data ? <Loading /> : !journals.data.rows?.length ? (
            <Empty title={t('acct.empty.trial_balance')} sub={t('acct.empty.trial_balance_hint')} />
          ) : (
            <>
              <Row
                title={t('acct.tb.balance_check')}
                right={<Tag label={journals.data.balanced ? '✓ Balanced' : '✗ Out of balance'} color={journals.data.balanced ? c.mintSoft : c.red} />}
              />
              {journals.data.rows.map((r) => <TrialBalanceRow key={r.ledger_account} row={r} />)}
            </>
          )}
        </View>
      ) : null}

      {seg === 'gst_summary' ? (
        <View style={{ gap: 10 }}>
          {!journals.data ? <Loading /> : !journals.data.gst ? (
            <Empty title={t('acct.empty.gst_summary')} />
          ) : (
            <>
              <Section title={t('acct.gst.b2b_title')}>
                <Row title={t('acct.gst.total_taxable')} right={<T weight="700">{money(journals.data.gst.b2b_taxable ?? 0, 'INR')}</T>} />
                <Row title="CGST" right={<T weight="700">{money(journals.data.gst.cgst ?? 0, 'INR')}</T>} />
                <Row title="SGST" right={<T weight="700">{money(journals.data.gst.sgst ?? 0, 'INR')}</T>} />
                <Row title="IGST" right={<T weight="700">{money(journals.data.gst.igst ?? 0, 'INR')}</T>} />
                <Row title={t('acct.gst.total_liability')} right={<T size={16} weight="800" color={c.pink}>{money((journals.data.gst.cgst ?? 0) + (journals.data.gst.sgst ?? 0) + (journals.data.gst.igst ?? 0), 'INR')}</T>} />
              </Section>
              <Section title={t('acct.gst.hsn_title')}>
                {(journals.data.gst.hsn_rows ?? []).map((h) => (
                  <Row key={h.hsn_code} title={h.hsn_code} sub={h.description} right={<T weight="700">{money(h.taxable_minor ?? 0, 'INR')}</T>} />
                ))}
              </Section>
            </>
          )}
        </View>
      ) : null}

      {seg === 'handover' ? (
        <View style={{ gap: 12 }}>
          <Card style={{ gap: 8 }}>
            <T weight="800" size={15}>{t('acct.handover.title')}</T>
            <T size={13} color={c.mute}>{t('acct.handover.desc')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {[t('acct.handover.includes.trial_balance'), t('acct.handover.includes.gst_workings'), t('acct.handover.includes.export_log'), t('acct.handover.includes.recon_report')].map((item) => (
                <Tag key={item} label={item} color={c.violetSoft} />
              ))}
            </View>
            <Btn title={t('acct.handover.download')} loading={busy} color={c.pink} ink="#fff"
              onPress={() => download('handover')} accessibilityLabel={t('acct.handover.download')} />
          </Card>
          {atLeast(level, 'controller') ? (
            <Card style={{ gap: 8, borderWidth: 1, borderColor: c.line }}>
              <T weight="800" size={15} color={c.orange}>{t('acct.period_lock.title')}</T>
              <T size={13} color={c.mute}>{t('acct.period_lock.desc')}</T>
              <Btn small title={t('acct.period_lock.lock')} color={c.paper} ink={c.orange}
                onPress={() => {}} accessibilityLabel={t('acct.period_lock.lock')} />
            </Card>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/* ─────────────────────── Root screen ─────────────────────── */
export function AccountingIntegration({ orgId }) {
  const { user } = useSession();
  const [tab,     setTab]     = useState('overview');
  const [syncing, setSyncing] = useState(null);
  const [toast,   setToast]   = useState(null);
  const [period,  setPeriod]  = useState('month');

  // Derive finance level from user roles/permissions (mirrors finance.js pattern)
  const level = user?.finance_level ?? 'viewer';

  const status = useLoad(() => api.get(`/organisations/${orgId}/accounting/status`), [orgId]);

  const doSync = async (key) => {
    setSyncing(key);
    try {
      if (key === '__queue_all') {
        const r = await api.post(`/organisations/${orgId}/accounting/exports/queue`, { all_eligible: true });
        setToast(t('acct.sync_done', { n: r.queued ?? 0 }));
      } else if (key === '__retry_all') {
        await api.post(`/organisations/${orgId}/accounting/exports/retry_all`, {});
        setToast(t('acct.retry_all_done'));
      } else {
        const r = await api.post(`/organisations/${orgId}/accounting/sync`, { provider: key });
        setToast(t('acct.sync_done', { n: r.queued ?? 0 }));
      }
      status.reload();
    } catch (e) { setToast(e.message); } finally { setSyncing(null); }
  };

  const doExportFile = () => {
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = `/api/v1/organisations/${orgId}/accounting/tally/export`;
      a.download = `tally-export-${new Date().toISOString().slice(0, 10)}.xml`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } else {
      setToast(t('acct.export_file_native'));
    }
  };

  const tabOpts = [
    { value: 'overview',       label: t('acct.tab.overview') },
    { value: 'mappings',       label: t('acct.tab.mappings') },
    { value: 'exports',        label: t('acct.tab.exports') },
    { value: 'reconciliation', label: t('acct.tab.reconciliation') },
    { value: 'reports',        label: t('acct.tab.reports') },
  ];

  const content = (() => {
    if (tab === 'overview')       return <OverviewTab status={status} orgId={orgId} level={level} onSync={doSync} syncing={syncing} onExportFile={doExportFile} onGoRecon={() => setTab('reconciliation')} period={period} setPeriod={setPeriod} />;
    if (tab === 'mappings')       return <AccountingMappingEditor orgId={orgId} />;
    if (tab === 'exports')        return <ExportsTab orgId={orgId} level={level} />;
    if (tab === 'reconciliation') return <ReconciliationTab orgId={orgId} level={level} />;
    return <ReportsTab orgId={orgId} level={level} />;
  })();

  return (
    <Screen scroll>
      <H2>{t('acct.title')}</H2>
      {toast ? <T size={13} color={c.mint} style={{ marginBottom: 4 }}>{toast}</T> : null}
      <View style={{ marginVertical: 12 }}>
        <Seg options={tabOpts} value={tab} onChange={setTab} />
      </View>
      {content}
    </Screen>
  );
}
