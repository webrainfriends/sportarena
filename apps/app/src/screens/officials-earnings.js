// Referee/umpire earnings dashboard (#1019). Real-time aggregation across all assignment fees,
// payout history, monthly trends and top events — no dummy data.
import React, { useState, useCallback } from 'react';
import { View, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { saveExport, openPdf } from '../open-file';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, StatPill, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { t } from '../i18n';

const cash = (minor, cur) => moneyIn(Number(minor ?? 0), cur);

const PAY_TONE = {
  agreed: c.info,
  due: c.warn,
  paid: c.positive,
  disputed: c.danger,
  pending: c.warn,
  failed: c.danger,
};

const PAGE = 50;

const TABS = [
  { value: 'overview', label: () => t('officialEarnings.tab.overview') },
  { value: 'statement', label: () => t('officialEarnings.tab.statement') },
  { value: 'payouts', label: () => t('officialEarnings.tab.payouts') },
  { value: 'expenses', label: () => t('oi.tab.expenses') },
  { value: 'export', label: () => t('officialEarnings.tab.export') },
  { value: 'bank', label: () => t('officialEarnings.tab.bank') },
];

// ── Overview tab ───────────────────────────────────────────────────────────

function OverviewTab({ currency }) {
  const summary = useLoad(() => api.get('/me/officials/earnings', currency ? { currency } : {}), [currency]);
  const trend = useLoad(() => api.get('/me/officials/earnings/trend', { months: 24, ...(currency ? { currency } : {}) }), [currency]);
  const topEvents = useLoad(() => api.get('/me/officials/earnings/top-events', currency ? { currency } : {}), [currency]);
  const bySport = useLoad(() => api.get('/me/officials/earnings/summary-by', { group_by: 'sport', ...(currency ? { currency } : {}) }), [currency]);

  if (summary.loading) return <Loading />;
  if (summary.error) return <ErrorBox error={summary.error} />;

  const rows = summary.data?.summary ?? [];

  if (!rows.length) {
    return <Empty icon="💰" title={t('officialEarnings.overview.no_data')} />;
  }

  const display = currency ? rows.filter((r) => r.currency === currency) : rows;

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      {display.map((r) => (
        <Section key={r.currency} title={r.currency}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <StatPill value={cash(r.paid.minor, r.currency)} label={t('officialEarnings.overview.lifetime_paid')} color={c.positive} />
            <StatPill value={cash(r.due.minor, r.currency)} label={t('officialEarnings.overview.pending_due')} color={c.warn} />
            <StatPill value={cash(r.payout?.payout_pending_minor, r.currency)} label={t('officialEarnings.overview.payout_pending')} color={c.info} />
            <StatPill value={String(r.paid.count + r.due.count + r.agreed.count)} label={t('officialEarnings.overview.assignments')} />
          </View>
          {r.disputed.count > 0 && (
            <Card pad={12} style={{ backgroundColor: c.dangerSoft, marginBottom: 8 }}>
              <T size={13} color={c.danger}>{r.disputed.count} disputed assignment{r.disputed.count !== 1 ? 's' : ''} — {cash(r.disputed.minor, r.currency)}</T>
            </Card>
          )}
        </Section>
      ))}

      {/* Monthly trend */}
      {!trend.loading && !trend.error && (trend.data?.trend?.length > 0) && (
        <Section title={t('officialEarnings.overview.chart_title')}>
          {trend.data.trend.slice(-12).map((m) => (
            <Row key={m.month + m.currency} label={m.month} right={
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <T size={13} weight="600" color={c.positive}>{cash(m.paid_minor, m.currency)}</T>
                {m.due_minor > 0 && <T size={11} color={c.warn}>{cash(m.due_minor, m.currency)} due</T>}
              </View>
            } />
          ))}
        </Section>
      )}

      {/* By sport */}
      {!bySport.loading && !bySport.error && (bySport.data?.rows?.length > 0) && (
        <Section title={t('officialEarnings.overview.by_sport')}>
          {bySport.data.rows.map((r) => (
            <Row key={r.group_id + r.currency} label={`${r.emoji ?? '🏅'} ${r.label}`} right={
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <T size={13} weight="600" color={c.positive}>{cash(r.paid_minor, r.currency)}</T>
                <T size={11} color={c.mute}>{r.total_assignments} match{r.total_assignments !== 1 ? 'es' : ''}</T>
              </View>
            } />
          ))}
        </Section>
      )}

      {/* Top events */}
      <Section title={t('officialEarnings.overview.by_event')}>
        {topEvents.loading ? <Loading small /> :
         topEvents.error ? <ErrorBox error={topEvents.error} /> :
         !(topEvents.data?.events?.length) ? <T size={13} color={c.mute}>{t('officialEarnings.overview.top_events_empty')}</T> :
         topEvents.data.events.map((e) => (
           <Row key={e.event_id + e.currency}
             label={e.event_name}
             caption={`${e.assignment_count} assignment${e.assignment_count !== 1 ? 's' : ''}`}
             right={<T size={13} weight="600" color={c.positive}>{cash(e.paid_minor, e.currency)}</T>}
           />
         ))
        }
      </Section>
    </ScrollView>
  );
}

// ── Statement tab ──────────────────────────────────────────────────────────

function StatementTab({ currency }) {
  const [filter, setFilter] = useState(null);
  const [offset, setOffset] = useState(0);
  const [extra, setExtra] = useState([]);

  const q = useLoad(
    () => api.get('/me/officials/earnings/entries', {
      limit: PAGE,
      offset: 0,
      ...(currency ? { currency } : {}),
      ...(filter ? { pay_status: filter } : {}),
    }),
    [currency, filter],
  );

  const entries = [...(q.data?.entries ?? []), ...extra];
  const total = q.data?.total ?? 0;
  const hasMore = entries.length < total;

  const loadMore = async () => {
    const nextOffset = offset + PAGE;
    const r = await api.get('/me/officials/earnings/entries', {
      limit: PAGE,
      offset: nextOffset,
      ...(currency ? { currency } : {}),
      ...(filter ? { pay_status: filter } : {}),
    });
    setExtra((prev) => [...prev, ...(r.entries ?? [])]);
    setOffset(nextOffset);
  };

  const STATUS_OPTS = [
    { value: null, label: t('officialEarnings.statement.filter_all') },
    { value: 'paid', label: t('officialEarnings.statement.filter_paid') },
    { value: 'due', label: t('officialEarnings.statement.filter_due') },
    { value: 'agreed', label: t('officialEarnings.statement.filter_agreed') },
    { value: 'disputed', label: t('officialEarnings.statement.filter_disputed') },
  ];

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      <Seg
        options={STATUS_OPTS}
        value={filter}
        onChange={(v) => { setFilter(v); setOffset(0); setExtra([]); }}
        style={{ marginBottom: 4 }}
      />
      {q.loading ? <Loading /> :
       q.error ? <ErrorBox error={q.error} /> :
       !entries.length ? <Empty icon="📄" title={t('officialEarnings.statement.empty')} /> :
       entries.map((e) => (
         <Card key={e.id} pad={14}>
           <Row
             label={e.fixture_name}
             caption={`${e.event_name}${e.sport_name ? ` · ${e.sport_emoji ?? ''} ${e.sport_name}` : ''}`}
             right={
               <View style={{ alignItems: 'flex-end', gap: 4 }}>
                 <T size={15} weight="700" color={e.pay_status === 'paid' ? c.positive : e.pay_status === 'disputed' ? c.danger : c.ink}>
                   {cash(e.fee_minor, e.currency)}
                 </T>
                 <Tag label={e.pay_status ?? 'unpaid'} color={PAY_TONE[e.pay_status] ?? c.mute} />
               </View>
             }
           />
           <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
             <T size={12} color={c.mute}>{e.role}</T>
             {e.scheduled_at && <T size={12} color={c.mute}>{new Date(e.scheduled_at).toLocaleDateString()}</T>}
             {e.payout_item_id && (
               <Btn
                 small
                 title={t('officialEarnings.payouts.view_statement')}
                 color={c.violet}
                 accessibilityLabel={t('officialEarnings.payouts.view_statement')}
                 onPress={() => openPdf(`/payout-items/${e.payout_item_id}/statement.pdf`, 'official-fee-statement').catch(() => {})}
               />
             )}
           </View>
         </Card>
       ))
      }
      {hasMore && (
        <Btn title={t('officialEarnings.statement.load_more')} color={c.paper} ink={c.ink} onPress={loadMore} style={{ minHeight: 44 }} />
      )}
    </ScrollView>
  );
}

// ── Payouts tab ────────────────────────────────────────────────────────────

function PayoutsTab({ currency }) {
  const items = useLoad(
    () => api.get('/me/payout-items', { limit: 50, ...(currency ? { currency } : {}) }),
    [currency],
  );

  const rows = items.data?.items ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      {items.loading ? <Loading /> :
       items.error ? <ErrorBox error={items.error} /> :
       !rows.length ? <Empty icon="💳" title={t('officialEarnings.payouts.empty')} /> :
       rows.map((i) => (
         <Card key={i.id} pad={14}>
           <Row
             label={cash(i.gross_minor, i.currency)}
             caption={i.decided_at ? new Date(i.decided_at).toLocaleDateString() : undefined}
             right={
               <View style={{ alignItems: 'flex-end', gap: 4 }}>
                 <Tag label={i.status} color={PAY_TONE[i.status] ?? c.mute} />
                 {i.status === 'paid' && (
                   <T size={12} color={c.positive}>Net {cash(i.net_minor, i.currency)}</T>
                 )}
               </View>
             }
           />
           <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
             {i.tax_minor > 0 && <T size={12} color={c.mute}>Tax {cash(i.tax_minor, i.currency)}</T>}
             {i.fee_minor > 0 && <T size={12} color={c.mute}>Fee {cash(i.fee_minor, i.currency)}</T>}
           </View>
           {i.status === 'paid' && (
             <Btn
               small
               title={t('officialEarnings.payouts.view_statement')}
               color={c.violet}
               accessibilityLabel={t('officialEarnings.payouts.view_statement')}
               onPress={() => openPdf(`/payout-items/${i.id}/statement.pdf`, 'payout-statement').catch(() => {})}
               style={{ marginTop: 8, minHeight: 44 }}
             />
           )}
           {i.status === 'failed' && i.failure_reason && (
             <T size={12} color={c.danger} style={{ marginTop: 4 }}>{i.failure_reason}</T>
           )}
         </Card>
       ))
      }
    </ScrollView>
  );
}

// ── Export tab ─────────────────────────────────────────────────────────────

function ExportTab({ currency }) {
  const { toast } = useSession();
  const [dateRange, setDateRange] = useState({ from: null, to: null });
  const [statusFilter, setStatusFilter] = useState(null);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setBusy(true);
    try {
      const params = {
        ...(currency ? { currency } : {}),
        ...(dateRange.from ? { from: dateRange.from } : {}),
        ...(dateRange.to ? { to: dateRange.to } : {}),
        ...(statusFilter ? { pay_status: statusFilter } : {}),
      };
      const r = await api.get('/me/officials/earnings/export', params);
      await saveExport({ filename: r.filename, content_type: r.content_type, encoding: r.encoding, content: r.content });
      toast(t('officialEarnings.export.done'));
    } catch (e) {
      toast(e.message ?? 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const STATUS_OPTS = [
    { value: null, label: t('officialEarnings.statement.filter_all') },
    { value: 'paid', label: t('officialEarnings.statement.filter_paid') },
    { value: 'due', label: t('officialEarnings.statement.filter_due') },
    { value: 'agreed', label: t('officialEarnings.statement.filter_agreed') },
    { value: 'disputed', label: t('officialEarnings.statement.filter_disputed') },
  ];

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialEarnings.export.title')}>
        <T size={13} color={c.mute} style={{ marginBottom: 12 }}>
          Exports a CSV of all your assignment fees. Use the filters below to narrow the range.
        </T>
        <DateRangeField
          label={t('officialEarnings.export.date_range')}
          value={dateRange}
          onChange={setDateRange}
        />
        <Seg
          options={STATUS_OPTS}
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ marginTop: 12 }}
        />
        <Btn
          title={busy ? t('officialEarnings.export.exporting') : t('officialEarnings.export.btn_csv')}
          color={c.accent}
          disabled={busy}
          onPress={doExport}
          style={{ marginTop: 16, minHeight: 48 }}
          accessibilityLabel={t('officialEarnings.export.btn_csv')}
        />
      </Section>
    </ScrollView>
  );
}

// ── Expenses tab (#1008) ────────────────────────────────────────────────────

function ExpensesTab() {
  const summary = useLoad(() => api.get('/me/officials/expense-summary'), []);
  const expenses = useLoad(() => api.get('/official-expenses', { limit: 50, offset: 0 }), []);
  const { push: go } = useNav();

  const EXP_STATUS_COLOR = { draft: c.info, submitted: c.warn, approved: c.positive, rejected: c.danger };

  if (summary.loading || expenses.loading) return <Loading />;
  if (summary.error) return <ErrorBox error={summary.error} />;

  const rows = summary.data?.expenses ?? [];
  const expRows = expenses.data?.expenses ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      {rows.map((s) => (
        <Section key={s.currency} title={s.currency}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatPill value={cash(s.submitted_minor, s.currency)} label={t('oi.report.expenses_submitted')} color={c.warn} />
            <StatPill value={cash(s.approved_minor, s.currency)} label={t('oi.report.expenses_reimbursed')} color={c.positive} />
            <StatPill value={cash(s.pending_minor, s.currency)} label="Pending reimbursement" color={c.info} />
          </View>
        </Section>
      ))}
      {!expRows.length ? (
        <Empty emoji="🧾" title={t('oi.empty.expenses')} />
      ) : (
        <Section title="Recent claims">
          <View style={{ gap: 8 }}>
            {expRows.map((e) => (
              <Card key={e.id} accessibilityLabel={`${e.category} expense, ${cash(e.amount_minor, e.currency)}, ${e.status}`}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ gap: 3 }}>
                    <T weight="700">{e.category} · {cash(e.amount_minor, e.currency)}</T>
                    {e.fixture_name ? <T size={12} color={c.mute}>{e.fixture_name}</T> : null}
                  </View>
                  <Tag label={e.status} color={EXP_STATUS_COLOR[e.status] ?? c.info} />
                </View>
              </Card>
            ))}
          </View>
        </Section>
      )}
      <Btn title="View all invoices & expenses" onPress={() => go('OfficialInvoices', { role: 'official' })} style={{ minHeight: 48 }} />
    </ScrollView>
  );
}

// ── Bank & Settings tab ────────────────────────────────────────────────────

function BankTab() {
  const { push: go } = useNav();

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialEarnings.bank.title')}>
        <T size={14} color={c.fg2} style={{ marginBottom: 16 }}>
          {t('officialEarnings.bank.hint')}
        </T>
        <Btn
          title={t('officialEarnings.bank.go_wallet')}
          color={c.accent}
          onPress={() => go('Wallet')}
          style={{ minHeight: 48 }}
          accessibilityLabel={t('officialEarnings.bank.go_wallet')}
        />
      </Section>
    </ScrollView>
  );
}

// ── Root screen ────────────────────────────────────────────────────────────

export function OfficialEarnings() {
  const [tab, setTab] = useState('overview');
  const [currency, setCurrency] = useState(null);

  // Reload summary when screen comes back into focus (e.g. after bank update)
  const summary = useLoad(() => api.get('/me/officials/earnings'), []);

  useFocusEffect(useCallback(() => { summary.reload?.(); }, []));

  const currencies = (summary.data?.summary ?? []).map((r) => r.currency);

  const currencyOpts = currencies.length > 1
    ? [{ value: null, label: 'All' }, ...currencies.map((cur) => ({ value: cur, label: cur }))]
    : [];

  const tabOpts = TABS.map((tab) => ({ value: tab.value, label: tab.label() }));

  return (
    <Screen scroll={false} padH={16}>
      <H1 accessibilityRole="header">{t('officialEarnings.title')}</H1>

      {currencyOpts.length > 0 && (
        <Seg
          options={currencyOpts}
          value={currency}
          onChange={setCurrency}
          style={{ marginBottom: 8 }}
        />
      )}

      <Seg
        options={tabOpts}
        value={tab}
        onChange={setTab}
        style={{ marginBottom: 12 }}
      />

      {tab === 'overview' && <OverviewTab currency={currency} />}
      {tab === 'statement' && <StatementTab currency={currency} />}
      {tab === 'payouts' && <PayoutsTab currency={currency} />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'export' && <ExportTab currency={currency} />}
      {tab === 'bank' && <BankTab />}
    </Screen>
  );
}
