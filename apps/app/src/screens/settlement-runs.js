// Settlement runs (#697): scheduled settlement dashboard and statement view.
// Platform-admin only for the management views; partners see their own summary in venue-payouts.
// API-first: all data from /admin/settlement-schedules, /admin/failed-payouts, /admin/settlements.
import React, { useState, useCallback } from 'react';
import { FlatList, Platform, Share, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { c, money } from '../theme';
import { t } from '../i18n';

const fmt = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '–';
const rows = (d) => (Array.isArray(d) ? d : d?.items ?? []);
const fmtMoney = (minor, currency) => minor != null ? money(minor, currency ?? 'INR') : '–';

const TONE = {
  upcoming: c.cyanSoft, running: c.limeSoft, completed: c.violetSoft, failed: c.redSoft,
  approved: c.limeSoft, paid: c.limeSoft, draft: c.sunSoft, void: c.violetSoft, on_hold: c.orangeSoft,
};
const CHIP_COLOR = {
  upcoming: c.cyan, running: c.lime, completed: c.violet, failed: c.red,
  approved: c.lime, paid: c.lime, draft: c.sun, void: c.mute, on_hold: c.orange,
};

function StatusChip({ status, label }) {
  return (
    <View style={{ backgroundColor: TONE[status] ?? c.violetSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <T style={{ fontSize: 12, fontWeight: '700', color: CHIP_COLOR[status] ?? c.mute }}>{label ?? status}</T>
    </View>
  );
}

function MetricTile({ label, value, color }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8 }}>
      <T style={{ fontSize: 20, fontWeight: '800', color: color ?? c.ink }}>{value}</T>
      <T style={{ fontSize: 11, color: c.mute, marginTop: 2, textAlign: 'center' }}>{label}</T>
    </View>
  );
}

function MetricStrip({ children }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.line, borderRadius: 14, overflow: 'hidden', marginHorizontal: 16, marginBottom: 4 }}>
      {React.Children.map(children, (child, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: c.paper, margin: i > 0 ? 0 : 0, borderLeftWidth: i > 0 ? 1 : 0, borderColor: c.line }}>{child}</View>
      ))}
    </View>
  );
}

// ─── Schedule Card ────────────────────────────────────────────────────────────
function ScheduleCard({ item, onRunNow, onPauseToggle }) {
  const { toast } = useSession();
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try { await api.post(`/admin/settlement-schedules/${item.id}/run`); onRunNow?.(); }
    catch (e) { toast('' + e.message); }
    finally { setLoading(false); }
  };
  const cycleLabel = { weekly: t('sstl.cycle_weekly'), biweekly: t('sstl.cycle_biweekly'), monthly: t('sstl.cycle_monthly') }[item.cycle] ?? item.cycle;
  return (
    <Card style={{ marginHorizontal: 16, marginBottom: 12, overflow: 'hidden', padding: 0 }}>
      <View style={{ backgroundColor: item.paused ? c.violetSoft : c.violet, padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <T style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{item.venue_name}</T>
          <T style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 }}>{item.partner_name} · {cycleLabel}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={{ color: '#fff', fontWeight: '800', fontSize: 17 }}>{fmtMoney(item.last_payout_cents, item.currency)}</T>
          <StatusChip status={item.paused ? 'void' : 'upcoming'} label={item.paused ? 'Paused' : cycleLabel} />
        </View>
      </View>
      <View style={{ padding: 12, flexDirection: 'row', gap: 8 }}>
        <T style={{ fontSize: 12, color: c.mute, flex: 1, alignSelf: 'center' }}>
          {t('sstl.upcoming', { date: fmt(item.next_run_at) })}
        </T>
        <TouchableOpacity onPress={() => onPauseToggle?.(item)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: c.line }}>
          <T style={{ fontSize: 13, fontWeight: '600', color: c.mute }}>{item.paused ? t('sstl.resume') : t('sstl.pause')}</T>
        </TouchableOpacity>
        <TouchableOpacity onPress={run} disabled={loading} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pink }}>
          <T style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{loading ? '…' : t('sstl.generate_now')}</T>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ─── Failed Payout Card ───────────────────────────────────────────────────────
function FailedPayoutCard({ item, onAction }) {
  const { toast } = useSession();
  const [loading, setLoading] = useState(false);
  const act = async (action) => {
    setLoading(true);
    try { await api.post(`/admin/failed-payouts/${item.id}/action`, { action }); onAction?.(); }
    catch (e) { toast('' + e.message); }
    finally { setLoading(false); }
  };
  return (
    <Card style={{ marginHorizontal: 16, marginBottom: 12, overflow: 'hidden', padding: 0, borderWidth: 1, borderColor: c.red }}>
      <View style={{ backgroundColor: '#7F1D1D', padding: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <T style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{item.venue_name}</T>
          <T style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 }}>
            {item.period ?? '–'} · {t('sstl.attempts', { n: item.attempt_count ?? 1, max: 3 })}
          </T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T style={{ color: '#fff', fontWeight: '800', fontSize: 17 }}>{fmtMoney(item.amount_cents, item.currency)}</T>
          <StatusChip status="failed" label="Failed" />
        </View>
      </View>
      {item.failure_reason ? (
        <View style={{ backgroundColor: c.redSoft, padding: 10, borderLeftWidth: 3, borderColor: c.red }}>
          <T style={{ fontSize: 12, color: c.red }}>{t('sstl.bank_error', { error: item.failure_reason })}</T>
        </View>
      ) : null}
      <View style={{ padding: 12, flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity onPress={() => act('hold')} disabled={loading} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.red, alignItems: 'center' }}>
          <T style={{ fontSize: 13, fontWeight: '600', color: c.red }}>{t('sstl.hold_escalate')}</T>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => act('request_new_account')} disabled={loading} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: c.violet, alignItems: 'center' }}>
          <T style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{t('sstl.notify_partner')}</T>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => act('retry')} disabled={loading} style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: c.red, alignItems: 'center' }}>
          <T style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{t('sstl.retry')}</T>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function SettlementRunsScreen() {
  const { user, toast } = useSession();
  const nav = useNav();
  const [tab, setTab] = useState(0);
  const schedulesR = useLoad(() => api.get('/admin/settlement-schedules'), []);
  const failedR = useLoad(() => api.get('/admin/failed-payouts'), []);
  // /settlements takes one status at a time: fetch approved and paid and merge, newest first.
  const historyR = useLoad(async () => {
    const [a, p] = await Promise.all(['approved', 'paid'].map((status) => api.get('/settlements', { status, limit: '20' })));
    return [...rows(a), ...rows(p)].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 20);
  }, []);

  const refresh = useCallback(() => { schedulesR.reload(); failedR.reload(); historyR.reload(); }, [schedulesR, failedR, historyR]);

  const schedules = rows(schedulesR.data);
  const failed = rows(failedR.data);
  const history = rows(historyR.data);

  // Never add different currencies together: the strip shows a total only when every schedule settles in one currency.
  const currencies = [...new Set(schedules.filter((x) => x.last_payout_cents != null).map((x) => x.currency))];
  const thisWeekTotal = currencies.length === 1 ? fmtMoney(schedules.reduce((s, x) => s + (x.last_payout_cents ?? 0), 0), currencies[0]) : '–';
  const pending = schedules.filter(s => !s.paused && new Date(s.next_run_at) <= new Date()).length;

  const TABS = [t('sstl.tab_scheduled'), t('sstl.tab_history'), t('sstl.tab_failed')];

  const pauseToggle = async (item) => {
    try { await api.patch(`/admin/settlement-schedules/${item.id}`, { paused: !item.paused }); refresh(); }
    catch (e) { toast('' + e.message); }
  };

  const renderContent = () => {
    if (tab === 0) {
      if (schedulesR.loading) return <Loading />;
      if (schedulesR.error) return <ErrorBox error={schedulesR.error} />;
      if (!schedules.length) return <Empty title={t('sstl.tab_scheduled')} sub="No settlement schedules configured yet." />;
      return (
        <FlatList
          data={schedules}
          keyExtractor={i => i.id}
          renderItem={({ item }) => <ScheduleCard item={item} onRunNow={refresh} onPauseToggle={pauseToggle} />}
          contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}
        />
      );
    }
    if (tab === 1) {
      if (historyR.loading) return <Loading />;
      if (historyR.error) return <ErrorBox error={historyR.error} />;
      if (!history.length) return <Empty title={t('sstl.tab_history')} sub="No settled statements yet." />;
      return (
        <FlatList
          data={history}
          keyExtractor={i => i.id}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => nav.push('SettlementStatement', { settlementId: item.id })} style={{ marginHorizontal: 16, marginBottom: 10 }}>
              <Card>
                <Row>
                  <View style={{ flex: 1 }}>
                    <T style={{ fontWeight: '700', color: c.ink }}>{item.venue_name ?? '–'}</T>
                    <T style={{ fontSize: 12, color: c.mute }}>{fmt(item.period_start)} – {fmt(item.period_end)}</T>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <T style={{ fontWeight: '800', fontSize: 16, color: c.ink }}>{fmtMoney(item.net_payable_cents, item.currency)}</T>
                    <StatusChip status={item.status} label={item.status} />
                  </View>
                </Row>
              </Card>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}
        />
      );
    }
    // Failed tab
    if (failedR.loading) return <Loading />;
    if (failedR.error) return <ErrorBox error={failedR.error} />;
    if (!failed.length) return <Empty title={t('sstl.tab_failed')} sub="No failed payouts." />;
    return (
      <FlatList
        data={failed}
        keyExtractor={i => i.id}
        renderItem={({ item }) => <FailedPayoutCard item={item} onAction={refresh} />}
        contentContainerStyle={{ paddingBottom: 32, paddingTop: 8 }}
      />
    );
  };

  return (
    <Screen>
      <H1 style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 }}>{t('sstl.title')}</H1>

      <MetricStrip>
        <MetricTile label={t('sstl.this_week')} value={thisWeekTotal} />
        <MetricTile label={t('sstl.pending')} value={String(pending)} color={pending > 0 ? c.sun : c.ink} />
        <MetricTile label={t('sstl.failed')} value={String(failed.length)} color={failed.length > 0 ? c.red : c.ink} />
      </MetricStrip>

      <Seg
        style={{ marginHorizontal: 16, marginVertical: 8 }}
        options={TABS.map((label, value) => ({ value, label }))}
        value={tab}
        onChange={setTab}
        color={c.pink}
      />

      {renderContent()}
    </Screen>
  );
}

// ─── Settlement Statement ─────────────────────────────────────────────────────
export function SettlementStatement({ settlementId }) {
  const r = useLoad(() => api.get(`/settlements/${settlementId}`), [settlementId]);
  const { user, toast } = useSession();
  const [approving, setApproving] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (r.loading) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} /></Screen>;
  const s = r.data;
  if (!s) return null;

  const approve = async () => {
    setApproving(true);
    try { await api.post(`/admin/settlements/${settlementId}/decision`, { action: 'approve' }); r.reload(); }
    catch (e) { toast('' + e.message); }
    finally { setApproving(false); }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const x = await api.get(`/settlements/${settlementId}`, { format: 'csv' });
      if (Platform.OS === 'web') {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' })); a.download = `settlement-${s.settlement_no}.csv`; a.click();
      } else await Share.share({ title: `settlement-${s.settlement_no}.csv`, message: x.csv });
    } catch (e) { toast('' + e.message); } finally { setExporting(false); }
  };

  const lines = s.lines ?? [];
  const credits = lines.filter((l) => l.kind === 'credit_note');
  const refundCents = -credits.reduce((n, l) => n + (l.sales_cents ?? 0), 0);
  // Reconciliation: the net must equal what the platform collected less commission, its tax, payment costs and reserve, plus released reserve and adjustments.
  const varianceCents = s.net_payable_cents - (s.platform_collected_cents - s.commission_cents - s.commission_tax_cents - s.gateway_fee_cents - s.reserve_held_cents + s.reserve_released_cents + s.adjustments_cents);
  const linesBg = s.status === 'approved' || s.status === 'paid' ? '#065F46' : c.violet;
  const heroText = '#fff';

  const ReconRow = ({ label, value, negative, bold }) => (
    <Row style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
      <T style={{ color: bold ? c.ink : c.mute, fontWeight: bold ? '800' : '400', flex: 1 }}>{label}</T>
      <T style={{ fontWeight: bold ? '800' : '700', fontSize: bold ? 18 : 14, color: negative ? c.red : bold ? c.lime : c.ink }}>{value}</T>
    </Row>
  );

  return (
    <Screen scroll>
      {/* Hero */}
      <View style={{ background: `linear-gradient(135deg, ${linesBg}, #1a1d26)`, backgroundColor: linesBg, padding: 24 }}>
        <T style={{ color: heroText, fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.settlement_no}</T>
        <T style={{ color: heroText, fontSize: 26, fontWeight: '800', marginTop: 4 }}>{fmtMoney(s.net_payable_cents, s.currency)}</T>
        <T style={{ color: heroText, fontSize: 13, opacity: 0.8, marginTop: 4 }}>{s.venue_name} · {fmt(s.period_start)}–{fmt(s.period_end)}</T>
        <StatusChip status={s.status} label={s.status} />
      </View>

      {/* Reconciliation */}
      <Section title={t('sstl.recon_title')} style={{ marginTop: 0 }}>
        <ReconRow label={t('sstl.recon_gross', { n: s.invoices_count ?? '?' })} value={fmtMoney(s.sales_cents, s.currency)} />
        {(refundCents > 0) && <ReconRow label={t('sstl.recon_refunds', { n: credits.length })} value={`−${fmtMoney(refundCents, s.currency)}`} negative />}
        <ReconRow label={t('sstl.recon_commission', { pct: ((s.commission_bp ?? 0) / 100).toFixed(0) })} value={`−${fmtMoney(s.commission_cents, s.currency)}`} negative />
        {(s.commission_tax_cents > 0) && <ReconRow label={t('sstl.recon_gst')} value={`−${fmtMoney(s.commission_tax_cents, s.currency)}`} negative />}
        {(s.gateway_fee_cents > 0) && <ReconRow label="Gateway fee" value={`−${fmtMoney(s.gateway_fee_cents, s.currency)}`} negative />}
        <ReconRow label={t('sstl.recon_net')} value={fmtMoney(s.net_payable_cents, s.currency)} bold />
        <Row style={{ paddingTop: 8 }}>
          <T style={{ color: c.mute, fontSize: 12, flex: 1 }}>{t('sstl.recon_variance')}</T>
          <View style={{ backgroundColor: varianceCents === 0 ? c.limeSoft : c.redSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
            <T style={{ fontSize: 12, fontWeight: '700', color: varianceCents === 0 ? c.lime : c.red }}>
              {varianceCents === 0 ? t('sstl.recon_zero') : fmtMoney(Math.abs(varianceCents), s.currency)}
            </T>
          </View>
        </Row>
      </Section>

      {/* Booking lines */}
      <Section title={t('sstl.booking_lines', { n: s.invoices_count ?? '?' })}>
        {lines.map((line, n) => (
          <Row key={line.invoice_id ?? n} style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
            <T style={{ color: c.mute, fontSize: 12, flex: 1 }}>{line.description ?? line.invoice_id?.slice(0, 8) ?? '–'}</T>
            <T style={{ fontWeight: '700', color: line.kind === 'credit_note' ? c.red : c.lime, fontSize: 13 }}>
              {line.kind === 'credit_note' ? '−' : ''}{fmtMoney(Math.abs(line.kind === 'adjustment' ? line.amount_cents : line.collected_cents), s.currency)}
            </T>
          </Row>
        ))}
      </Section>

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, marginBottom: 32 }}>
        {s.status === 'draft' && (
          <Btn onPress={approve} loading={approving} style={{ flex: 1 }} color={c.lime}>{t('sstl.approve')}</Btn>
        )}
        <Btn onPress={exportCsv} loading={exporting} style={{ flex: 1 }} variant="outline">{t('sstl.csv_export')}</Btn>
      </View>
    </Screen>
  );
}
