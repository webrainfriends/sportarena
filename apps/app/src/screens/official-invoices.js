// Official invoices, expenses and reimbursement batches (#1008).
// Dual-role: official sees their own invoices/expenses; organiser sees pending approvals.
// All state transitions happen server-side; this screen only calls the API and shows what comes back.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Seg, StatPill, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { t } from '../i18n';

const cash = (minor, cur) => moneyIn(Number(minor ?? 0), cur);

const INV_STATUS_COLOR = {
  draft: c.violetSoft,
  submitted: c.sunSoft,
  approved: c.mintSoft,
  queried: c.sunSoft,
  disputed: c.redSoft,
  void: c.paper,
};

const EXP_STATUS_COLOR = {
  draft: c.violetSoft,
  submitted: c.sunSoft,
  approved: c.mintSoft,
  rejected: c.redSoft,
};

const BATCH_STATUS_COLOR = {
  draft: c.violetSoft,
  submitted: c.sunSoft,
  approved: c.mintSoft,
  rejected: c.redSoft,
  paid: c.cyanSoft,
};

const CAT_ICON = {
  travel: '✈️',
  accommodation: '🏨',
  subsistence: '🍽️',
  equipment: '🎒',
  other: '📋',
};

const PAGE = 50;

// ── Invoice card ────────────────────────────────────────────────────────────

function InvoiceCard({ inv, onPress }) {
  return (
    <Card onPress={onPress} accessibilityLabel={`Invoice ${inv.invoice_number ?? 'draft'}, ${inv.status}, ${cash(inv.total_minor, inv.currency)}`}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={t(`oi.status.${inv.status}`)} color={INV_STATUS_COLOR[inv.status] ?? c.paper} />
          {inv.kind === 'rci' && <Tag label={t('oi.kind.rci')} color={c.cyanSoft} />}
        </View>
        <T weight="800" size={18}>{inv.invoice_number ?? t('oi.status.draft')}</T>
        <T size={22} weight="900" color={c.pink}>{cash(inv.total_minor, inv.currency)}</T>
        {inv.fixture_name ? <T size={13} color={c.mute}>📋 {inv.fixture_name}</T> : null}
        {inv.event_name ? <T size={13} color={c.mute}>🏟️ {inv.event_name}</T> : null}
        <T size={12} color={c.mute}>{new Date(inv.created_at).toLocaleDateString()}</T>
      </View>
    </Card>
  );
}

// ── Expense card ────────────────────────────────────────────────────────────

function ExpenseCard({ exp, onApprove, onReject, showActions }) {
  return (
    <Card accessibilityLabel={`${exp.category} expense, ${cash(exp.amount_minor, exp.currency)}, ${exp.status}`}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={`${CAT_ICON[exp.category] ?? '📋'} ${t(`oi.expense.category.${exp.category}`)}`} color={c.pinkSoft} />
          <Tag label={t(`oi.expense.status.${exp.status}`)} color={EXP_STATUS_COLOR[exp.status] ?? c.paper} />
        </View>
        <T weight="800" size={18}>{cash(exp.amount_minor, exp.currency)}</T>
        {exp.fixture_name ? <T size={13} color={c.mute}>📋 {exp.fixture_name}</T> : null}
        {exp.submitted_at ? <T size={12} color={c.mute}>Submitted {new Date(exp.submitted_at).toLocaleDateString()}</T> : null}
        {showActions && exp.status === 'submitted' ? (
          <Row style={{ gap: 8, marginTop: 4 }}>
            <Btn label={t('oi.action.approve')} onPress={() => onApprove(exp.id)} style={{ flex: 1 }} />
            <Btn label="Reject" variant="outline" onPress={() => onReject(exp.id)} style={{ flex: 1 }} />
          </Row>
        ) : null}
      </View>
    </Card>
  );
}

// ── Official tabs ────────────────────────────────────────────────────────────

function OfficialInvoicesTab() {
  const data = useLoad(() => api.get('/official-invoices', { limit: PAGE, offset: 0 }), []);
  const { go } = useNav();

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const invoices = data.data?.invoices ?? [];
  if (!invoices.length) return <Empty icon="🧾" title={t('oi.empty.invoices')} />;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      {invoices.map((inv) => (
        <InvoiceCard key={inv.id} inv={inv} onPress={() => go('OfficialInvoiceDetail', { id: inv.id })} />
      ))}
    </ScrollView>
  );
}

function OfficialExpensesTab() {
  const summary = useLoad(() => api.get('/me/officials/expense-summary'), []);
  const data = useLoad(() => api.get('/official-expenses', { limit: PAGE, offset: 0 }), []);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const expenses = data.data?.expenses ?? [];
  const sumRows = summary.data?.expenses ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16, paddingBottom: 32 }}>
      {sumRows.map((s) => (
        <Section key={s.currency} title={s.currency}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatPill label={t('oi.report.expenses_submitted')} value={cash(s.submitted_minor, s.currency)} color={c.sunSoft} />
            <StatPill label={t('oi.report.expenses_reimbursed')} value={cash(s.reimbursed_minor, s.currency)} color={c.mintSoft} />
            <StatPill label="Pending" value={cash(s.pending_minor, s.currency)} color={c.cyanSoft} />
          </View>
        </Section>
      ))}
      {!expenses.length ? <Empty icon="🧾" title={t('oi.empty.expenses')} /> : null}
      {expenses.map((exp) => (
        <ExpenseCard key={exp.id} exp={exp} showActions={false} />
      ))}
    </ScrollView>
  );
}

function OfficialBatchesTab() {
  const data = useLoad(() => api.get('/official-expense-batches', { limit: PAGE, offset: 0 }), []);
  const { go } = useNav();

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const batches = data.data?.batches ?? [];
  if (!batches.length) return <Empty icon="📦" title={t('oi.empty.batches')} />;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      {batches.map((b) => (
        <Card key={b.id} onPress={() => go('OfficialExpenseBatchDetail', { id: b.id })}
          accessibilityLabel={`Expense batch ${cash(b.total_minor, b.currency)}, ${b.status}`}>
          <View style={{ gap: 6 }}>
            <Tag label={b.status} color={BATCH_STATUS_COLOR[b.status] ?? c.paper} />
            <T weight="800" size={18}>{cash(b.total_minor, b.currency)}</T>
            <T size={13} color={c.mute}>{b.expense_count} expenses · {new Date(b.created_at).toLocaleDateString()}</T>
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

// ── Organiser tabs ───────────────────────────────────────────────────────────

function OrgPendingTab() {
  const data = useLoad(() => api.get('/official-invoices', { status: 'submitted', limit: PAGE, offset: 0 }), []);
  const { toast } = useSession();
  const { go } = useNav();

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const invoices = data.data?.invoices ?? [];
  if (!invoices.length) return <Empty icon="✅" title="No invoices awaiting approval." />;

  const approve = async (id) => {
    try {
      await api.post(`/official-invoices/${id}/approve`);
      data.reload();
      toast('Invoice approved');
    } catch (e) { toast(e?.message ?? 'Error', 'error'); }
  };

  const query = async (id) => {
    try {
      await api.post(`/official-invoices/${id}/query`, { note: 'Please clarify this invoice' });
      data.reload();
      toast('Query sent to official');
    } catch (e) { toast(e?.message ?? 'Error', 'error'); }
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      {invoices.map((inv) => (
        <Card key={inv.id} accessibilityLabel={`Invoice ${inv.invoice_number ?? 'draft'} from official`}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Tag label={t(`oi.status.${inv.status}`)} color={INV_STATUS_COLOR[inv.status] ?? c.paper} />
              {inv.kind === 'rci' && <Tag label={t('oi.kind.rci')} color={c.cyanSoft} />}
            </View>
            <T weight="800" size={17}>{inv.invoice_number ?? 'Draft'}</T>
            <T size={22} weight="900" color={c.pink}>{cash(inv.total_minor, inv.currency)}</T>
            {inv.fixture_name ? <T size={13} color={c.mute}>📋 {inv.fixture_name}</T> : null}
            <Row style={{ gap: 8, marginTop: 4 }}>
              <Btn label={t('oi.action.approve')} onPress={() => approve(inv.id)} style={{ flex: 1 }} />
              <Btn label={t('oi.action.query')} variant="outline" onPress={() => query(inv.id)} style={{ flex: 1 }} />
              <Btn label="Detail" variant="ghost" onPress={() => go('OfficialInvoiceDetail', { id: inv.id })} />
            </Row>
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

function OrgExpensesTab() {
  const data = useLoad(() => api.get('/official-expenses', { status: 'submitted', limit: PAGE, offset: 0 }), []);
  const { toast } = useSession();

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const expenses = data.data?.expenses ?? [];

  const approve = async (id) => {
    try {
      await api.post(`/official-expenses/${id}/approve`);
      data.reload();
      toast('Expense approved');
    } catch (e) { toast(e?.message ?? 'Error', 'error'); }
  };

  const reject = async (id) => {
    try {
      await api.post(`/official-expenses/${id}/reject`, { reason: 'Does not meet reimbursement policy' });
      data.reload();
      toast('Expense rejected');
    } catch (e) { toast(e?.message ?? 'Error', 'error'); }
  };

  if (!expenses.length) return <Empty icon="✅" title="No expense claims awaiting review." />;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      {expenses.map((exp) => (
        <ExpenseCard key={exp.id} exp={exp} onApprove={approve} onReject={reject} showActions />
      ))}
    </ScrollView>
  );
}

function OrgPaidTab() {
  const data = useLoad(() => api.get('/official-invoices', { status: 'approved', limit: PAGE, offset: 0 }), []);
  const { go } = useNav();

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const invoices = data.data?.invoices ?? [];
  if (!invoices.length) return <Empty icon="💸" title="No approved invoices yet." />;

  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
      {invoices.map((inv) => (
        <InvoiceCard key={inv.id} inv={inv} onPress={() => go('OfficialInvoiceDetail', { id: inv.id })} />
      ))}
    </ScrollView>
  );
}

function OrgReportsTab() {
  const [range, setRange] = useState({ from: null, to: null });
  const report = useLoad(
    () => api.get('/me/officials/reconciliation', range.from && range.to ? { from: range.from, to: range.to } : {}),
    [range.from, range.to],
  );

  const data = report.data?.reconciliation ?? report.data ?? {};

  return (
    <ScrollView contentContainerStyle={{ gap: 16, padding: 16, paddingBottom: 32 }}>
      <DateRangeField value={range} onChange={setRange} label="Date Range" />
      {report.loading ? <Loading /> : null}
      {report.error ? <ErrorBox error={report.error} /> : null}
      {!report.loading ? (
        <Section title="Reconciliation Summary">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatPill label={t('oi.report.invoices_raised')} value={String(data.invoices_raised_count ?? 0)} color={c.cyanSoft} />
            <StatPill label={t('oi.report.invoices_paid')} value={String(data.invoices_paid_count ?? 0)} color={c.mintSoft} />
            <StatPill label={t('oi.report.invoices_outstanding')} value={String(data.invoices_outstanding_count ?? 0)} color={c.sunSoft} />
            <StatPill label={t('oi.report.expenses_submitted')} value={String(data.expenses_submitted_count ?? 0)} color={c.sunSoft} />
            <StatPill label={t('oi.report.expenses_reimbursed')} value={String(data.expenses_reimbursed_count ?? 0)} color={c.mintSoft} />
            <StatPill label={t('oi.report.withholding_deducted')} value={String(data.withholding_total ?? 0)} color={c.pinkSoft} />
          </View>
        </Section>
      ) : null}
    </ScrollView>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export function OfficialInvoicesScreen({ route }) {
  const role = route?.params?.role ?? 'official';

  const OFFICIAL_TABS = [
    { value: 'my_invoices', label: () => t('oi.tab.my_invoices') },
    { value: 'expenses', label: () => t('oi.tab.expenses') },
    { value: 'batches', label: () => t('oi.tab.batches') },
  ];

  const ORGANISER_TABS = [
    { value: 'pending', label: () => t('oi.tab.pending') },
    { value: 'expenses', label: () => t('oi.tab.expenses') },
    { value: 'paid', label: () => t('oi.tab.paid') },
    { value: 'reports', label: () => t('oi.tab.reports') },
  ];

  const tabs = role === 'organiser' ? ORGANISER_TABS : OFFICIAL_TABS;
  const [tab, setTab] = useState(tabs[0].value);

  const renderContent = () => {
    if (role === 'organiser') {
      if (tab === 'pending') return <OrgPendingTab />;
      if (tab === 'expenses') return <OrgExpensesTab />;
      if (tab === 'paid') return <OrgPaidTab />;
      if (tab === 'reports') return <OrgReportsTab />;
    } else {
      if (tab === 'my_invoices') return <OfficialInvoicesTab />;
      if (tab === 'expenses') return <OfficialExpensesTab />;
      if (tab === 'batches') return <OfficialBatchesTab />;
    }
    return null;
  };

  return (
    <Screen>
      <H1>{role === 'organiser' ? 'Referee Invoices' : 'My Invoices & Expenses'}</H1>
      <Seg value={tab} onChange={setTab} options={tabs} />
      {renderContent()}
    </Screen>
  );
}
