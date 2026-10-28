// Front desk back office: the cash drawer, rental kit, stock & prices, the reconciled report, and the desk rules with manager approvals.
// Everything here is a thin form over the API; the server enforces who may do what.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { dateTimeIn, localToIso, moneyIn, addDays, todayIn } from '../vtime';
import { useApproval } from './front-desk-kit';

const REVIEW = { none: ['Counted', c.mintSoft], pending: ['Variance to review', c.sunSoft], approved: ['Variance accepted', c.mintSoft], disputed: ['Variance disputed', c.orangeSoft] };

// ------------------------------------------------------------------ cash drawer
export function DeskDrawer({ v, desk, reloadDesk }) {
  const { toast } = useSession();
  const [run, approvalSheet] = useApproval();
  const [form, setForm] = useState(null);
  const shifts = useLoad(() => api.get(`/venues/${v.id}/pos/shifts`, { limit: 30 }), [v.id, desk.shift?.id]);
  const s = useLoad(() => (desk.shift ? api.get(`/pos/shifts/${desk.shift.id}`) : Promise.resolve(null)), [desk.shift?.id, form]);
  const cur = v.currency;
  const sh = s.data;
  const after = () => { reloadDesk(); shifts.reload(); s.reload(); };
  const move = (kind, title, reasons) => setForm({
    title, submit: 'Record', fields: [{ key: 'amount_cents', label: 'Amount', type: 'money', currency: cur }, { key: 'reason', label: 'Why', type: 'chips', options: reasons }],
    go: async (x) => { await run((a) => api.post(`/pos/shifts/${desk.shift.id}/cash-moves`, { kind, amount_cents: x.amount_cents, reason: x.reason, approval_id: a })); after(); return 'Recorded'; },
  });
  return (
    <View style={{ gap: 12 }}>
      <Section title="Cash drawer" color={c.mint}>
        {!desk.shift ? (
          <Card color={c.paper}>
            <T weight="700">The drawer is closed.</T>
            <T size={13} color={c.mute}>Open it with the cash already in the till (the float). Cash taken and paid back on sales is then tracked against it, and you count it at the end of the shift.</T>
            <Btn title="Open the drawer" onPress={() => setForm({ title: 'Open the drawer', submit: 'Open', fields: [{ key: 'opening_float_cents', label: 'Cash in the till (float)', type: 'money', currency: cur }, { key: 'note', label: 'Note', optional: true }],
              go: async (x) => { await api.post(`/venues/${v.id}/pos/shifts`, x); after(); return 'Drawer open'; } })} style={{ marginTop: 10 }} />
          </Card>
        ) : s.loading && !sh ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : sh ? (
          <>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <StatPill color={c.lime} label="SHOULD BE IN THE DRAWER" value={moneyIn(Number(sh.expected_cash_cents), cur)} />
              <StatPill label="CASH TAKEN" value={moneyIn(Number(sh.cash_received_cents), cur)} />
              <StatPill label="CASH PAID BACK" value={moneyIn(Number(sh.cash_refunded_cents), cur)} />
            </View>
            <T size={12} color={c.mute}>Float {moneyIn(Number(sh.opening_float_cents), cur)} + cash taken − cash refunds − paid-outs − drops to the safe. Opened {dateTimeIn(sh.opened_at, v.timezone)} by {sh.opened_by_name}. {sh.sales_count} sale{sh.sales_count === 1 ? '' : 's'}.</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="Paid out" color={c.paper} ink={c.ink} onPress={() => move('paid_out', 'Pay money out of the drawer', ['Supplier', 'Petty cash', 'Staff expense', 'Refund to a customer elsewhere', 'Other'])} />
              <Btn small title="Drop to the safe" color={c.paper} ink={c.ink} onPress={() => move('cash_drop', 'Drop cash to the safe', ['Drawer getting full', 'End of day', 'Other'])} />
              {desk.role === 'manager' ? <Btn small title="Add to the float" color={c.paper} ink={c.ink} onPress={() => move('float_added', 'Add cash to the float', ['Change needed', 'Other'])} /> : null}
              <Btn small title="Count & close" color={c.violet} onPress={() => setForm({
                title: 'Count the drawer and close the shift', submit: 'Close the shift', notice: 'Count the cash in the drawer and enter the total. The count and any difference are saved and cannot be changed.',
                fields: [{ key: 'counted_cash_cents', label: 'Cash counted', type: 'money', currency: cur }, { key: 'note', label: 'Note (needed if the count is different)', optional: true }],
                go: async (x) => { const r = await api.post(`/pos/shifts/${sh.id}/close`, x); after(); return Number(r.variance_cents) === 0 ? 'Shift closed — the drawer balances ✓' : `Shift closed · ${Number(r.variance_cents) < 0 ? 'short' : 'over'} by ${moneyIn(Math.abs(Number(r.variance_cents)), cur)} — a manager will review it`; } })} />
            </View>
            {sh.cash_moves.length ? sh.cash_moves.map((m) => <Row key={m.id} left={<T size={20}>{m.kind === 'paid_out' ? '⬆️' : m.kind === 'cash_drop' ? '🔒' : '➕'}</T>} title={`${m.kind.replace('_', ' ')} · ${moneyIn(Number(m.amount_cents), cur)}`} sub={`${m.reason} · ${m.actor}${m.approved_by ? ` · approved by ${m.approved_by}` : ''}`} />) : null}
          </>
        ) : null}
      </Section>
      <Section title="Past shifts" color={c.violet}>
        {shifts.loading && !shifts.data ? <Loading /> : shifts.data?.filter((x) => x.status === 'closed').length ? shifts.data.filter((x) => x.status === 'closed').map((x) => (
          <Row key={x.id} left={<T size={20}>{Number(x.variance_cents) === 0 ? '✅' : '⚠️'}</T>} title={`${dateTimeIn(x.opened_at, v.timezone)} · ${x.opened_by_name}`}
            sub={`Expected ${moneyIn(Number(x.expected_cash_cents), cur)} · counted ${moneyIn(Number(x.counted_cash_cents), cur)} · ${Number(x.variance_cents) === 0 ? 'balanced' : `${Number(x.variance_cents) < 0 ? 'short' : 'over'} ${moneyIn(Math.abs(Number(x.variance_cents)), cur)}`}`}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={REVIEW[x.review_status][0]} color={REVIEW[x.review_status][1]} />
              {x.review_status === 'pending' && desk.role === 'manager' ? <View style={{ flexDirection: 'row', gap: 4 }}>
                <Btn small title="Accept" onPress={() => setForm({ title: 'Accept the variance', submit: 'Accept', fields: [{ key: 'note', label: 'Why is this acceptable?', type: 'chips', options: ['Counting error found', 'Within tolerance', 'Change given in error', 'Other'] }], go: async (n) => { await api.post(`/pos/shifts/${x.id}/review`, { decision: 'approve', note: n.note }); after(); return 'Accepted'; } })} />
                <Btn small title="Dispute" color={c.orange} onPress={() => setForm({ title: 'Dispute the variance', submit: 'Dispute', fields: [{ key: 'note', label: 'What will you do about it?', type: 'chips', options: ['Recount tomorrow', 'Speak to the cashier', 'Check the cameras', 'Other'] }], go: async (n) => { await api.post(`/pos/shifts/${x.id}/review`, { decision: 'dispute', note: n.note }); after(); return 'Recorded'; } })} /></View> : null}</View>} />
        )) : <Empty emoji="🧮" title="No closed shifts yet" sub="Each closed shift keeps its expected cash, the count and the difference." />}
      </Section>
      {form ? <FormSheet visible onClose={() => setForm(null)} title={form.title} fields={form.fields} submitLabel={form.submit} notice={form.notice} color={c.violet} onSubmit={form.go} /> : null}
      {approvalSheet}
    </View>
  );
}

// ------------------------------------------------------------------ rentals
const KIT = { reserved: ['Reserved', c.violetSoft], issued: ['Out now', c.sunSoft], returned: ['Returned', c.mintSoft], damaged: ['Damaged', c.orangeSoft], lost: ['Lost', c.orangeSoft], cancelled: ['Cancelled', c.violetSoft] };

export function DeskRentals({ v }) {
  const { toast } = useSession();
  const [filter, setFilter] = useState('issued');
  const list = useLoad(() => api.get(`/venues/${v.id}/pos/rentals`, { status: filter === 'overdue' ? 'issued' : filter, overdue: filter === 'overdue' || undefined, limit: 100 }), [v.id, filter]);
  const [form, setForm] = useState(null);
  const cur = v.currency;
  const close = (r) => setForm({
    title: `Take back · ${r.item_name}`, submit: 'Save',
    fields: [
      { key: 'outcome', label: 'Condition', type: 'chips', options: [{ value: 'returned', label: '✅ Returned fine' }, { value: 'damaged', label: '🛠️ Damaged' }, { value: 'lost', label: '❌ Not returned' }] },
      { key: 'note', label: 'What happened', type: 'chips', options: ['Cracked frame', 'Torn strings', 'Heavily worn', 'Never came back', 'Other'], show: (x) => x.outcome !== 'returned' },
      { key: 'keep_all', label: Number(r.deposit_cents) ? `Keep the whole ${moneyIn(Number(r.deposit_cents), cur)} deposit` : 'No deposit was taken', type: 'switch', default: true, show: (x) => x.outcome !== 'returned' && Number(r.deposit_cents) > 0 },
      { key: 'keep', label: 'Deposit to keep', type: 'money', currency: cur, show: (x) => x.outcome !== 'returned' && Number(r.deposit_cents) > 0 && x.keep_all === false },
      { key: 'method', label: 'Pay the deposit back', type: 'choice', options: [{ value: 'cash', label: 'Cash from the drawer' }, { value: 'original', label: 'To how it was paid' }], default: 'cash', show: (x) => Number(r.deposit_cents) > 0 && (x.outcome === 'returned' || x.keep_all === false) },
    ],
    go: async (x) => {
      const body = { outcome: x.outcome, method: x.method ?? 'cash', note: x.note };
      if (x.outcome !== 'returned' && Number(r.deposit_cents) > 0 && x.keep_all === false) body.forfeit_cents = Math.min(Number(r.deposit_cents), x.keep ?? 0);
      await api.post(`/pos/rentals/${r.id}/close`, body); list.reload(); return 'Saved';
    },
  });
  return (
    <Section title="Rental kit" color={c.sun}>
      <T size={13} color={c.mute}>Kit that goes out comes back, comes back damaged, or is lost — each has its own state and deposit. It is never counted as sold.</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['issued', 'Out now'], ['overdue', 'Overdue'], ['reserved', 'Waiting to hand over'], ['returned', 'Returned'], ['damaged', 'Damaged'], ['lost', 'Lost']].map(([k, l]) => <Chip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />)}</View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((r) => (
        <Row key={r.id} left={<T size={22}>🏸</T>} title={`${r.item_name} · ${r.customer}`} sub={`${r.issued_at ? `Out ${dateTimeIn(r.issued_at, v.timezone)} · due ${dateTimeIn(r.due_at, v.timezone)}` : 'Not handed over yet'}${Number(r.deposit_cents) ? ` · deposit ${moneyIn(Number(r.deposit_cents), cur)} ${r.deposit_status.replace('_', ' ')}` : ''}${r.condition_note ? ` · ${r.condition_note}` : ''}`}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Tag label={r.overdue ? 'Overdue' : KIT[r.status][0]} color={r.overdue ? c.orangeSoft : KIT[r.status][1]} />
            {r.status === 'issued' ? <Btn small title="Take back" onPress={() => close(r)} /> : null}
            {r.status === 'reserved' ? <Btn small title="Hand over" onPress={async () => { try { await api.post(`/pos/rentals/${r.id}/issue`, {}); list.reload(); } catch (e) { toast(e.message); } }} /> : null}</View>} />
      )) : <Empty emoji="🏸" title="Nothing here" sub="Rental kit appears when you rent it at the Sell tab." />}
      {form ? <FormSheet visible onClose={() => setForm(null)} title={form.title} fields={form.fields} submitLabel={form.submit} color={c.violet} onSubmit={form.go} /> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ stock & prices (managers)
const CATS = [{ value: 'merch', label: 'Merchandise' }, { value: 'equipment', label: 'Equipment' }, { value: 'apparel', label: 'Apparel' }, { value: 'food_beverage', label: 'Food & drink' }, { value: 'nutrition', label: 'Nutrition' }, { value: 'medical', label: 'First aid' }, { value: 'other', label: 'Other' }];

export function DeskStock({ v, reloadDesk }) {
  const cur = v.currency;
  const list = useLoad(() => api.get('/inventory', { venue_id: v.id, limit: 100 }), [v.id]);
  const [form, setForm] = useState(null);
  const done = () => { list.reload(); reloadDesk(); };
  const terms = (it) => [
    { key: 'stock_kind', label: 'This item is', type: 'choice', options: [{ value: 'consumable', label: 'Sold' }, { value: 'rental', label: 'Rented out (comes back)' }], default: it?.stock_kind ?? 'consumable' },
    { key: 'sell_price_cents', label: 'Selling price', type: 'money', currency: cur, show: (x) => x.stock_kind !== 'rental', optional: true },
    { key: 'rental_fee_cents', label: 'Rental fee (0 for free loan kit)', type: 'money', currency: cur, show: (x) => x.stock_kind === 'rental', optional: true },
    { key: 'deposit_cents', label: 'Refundable deposit', type: 'money', currency: cur, show: (x) => x.stock_kind === 'rental', optional: true },
    { key: 'unit_cost_cents', label: 'What it costs you (for margin)', type: 'money', currency: cur, optional: true },
    { key: 'sellable', label: 'Offer it at the front desk', type: 'switch', default: it?.sellable ?? true },
  ];
  const clean = (x) => ({ ...x, sell_price_cents: x.stock_kind === 'rental' ? null : x.sell_price_cents ?? null, rental_fee_cents: x.stock_kind === 'rental' ? x.rental_fee_cents ?? 0 : null, deposit_cents: x.stock_kind === 'rental' ? x.deposit_cents ?? 0 : 0 });
  const add = () => setForm({
    title: 'Add stock', submit: 'Add', fields: [{ key: 'name', label: 'Name' }, { key: 'category', label: 'Type', type: 'chips', options: CATS, default: 'merch' }, ...terms(), { key: 'quantity', label: 'How many do you have', type: 'stepper', min: 0, max: 999, default: 0 }, { key: 'reorder_level', label: 'Warn me when this few are left', type: 'stepper', min: 0, max: 999, default: 0 }],
    go: async (x) => { await api.post('/inventory', { ...clean(x), venue_id: v.id }); done(); return 'Added'; },
  });
  const edit = (it) => setForm({
    title: it.name, submit: 'Save', initial: { ...it, sell_price_cents: it.sell_price_cents ?? undefined, rental_fee_cents: it.rental_fee_cents ?? undefined, unit_cost_cents: it.unit_cost_cents || undefined },
    fields: [{ key: 'name', label: 'Name' }, ...terms(it)],
    go: async (x) => { await api.patch(`/inventory/${it.id}`, clean(x)); done(); return 'Saved'; },
  });
  const adjust = (it) => setForm({
    title: `Stock · ${it.name}`, submit: 'Update', notice: `Now ${it.quantity}. Every change is kept in the stock history.`,
    fields: [{ key: 'dir', label: 'What happened', type: 'chips', options: [{ value: 1, label: '📦 Stock received' }, { value: -1, label: '🛠️ Breakage or loss' }, { value: 0, label: '🔢 Count correction' }], default: 1 }, { key: 'n', label: 'How many', type: 'stepper', min: 1, max: 999, default: 1 }, { key: 'reason', label: 'Note', optional: true }],
    go: async (x) => { await api.post(`/inventory/${it.id}/adjust`, { delta: (x.dir === 0 ? -1 : x.dir) * x.n, reason: x.reason || (x.dir > 0 ? 'Stock received' : x.dir < 0 ? 'Breakage or loss' : 'Count correction') }); done(); return 'Updated'; },
  });
  return (
    <Section title="Stock & prices" color={c.pink} action="＋ Add" onAction={add}>
      <T size={13} color={c.mute}>This is the venue's own stock — the same items appear in Supply chain. Sales, returns, rentals and corrections are all written to each item's history.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((it) => (
        <Row key={it.id} onPress={() => edit(it)} left={<T size={22}>{it.stock_kind === 'rental' ? '🏸' : '📦'}</T>} title={it.name}
          sub={`${it.stock_kind === 'rental' ? `Rent ${moneyIn(Number(it.rental_fee_cents ?? 0), cur)}${Number(it.deposit_cents) ? ` + ${moneyIn(Number(it.deposit_cents), cur)} deposit` : ''}` : it.sell_price_cents == null ? 'No price yet' : moneyIn(Number(it.sell_price_cents), cur)} · ${it.quantity} in stock${it.damaged_qty ? ` · ${it.damaged_qty} damaged` : ''}${it.sellable ? '' : ' · hidden from the desk'}`}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{it.low_stock ? <Tag label="Low" color={c.orangeSoft} /> : null}<Btn small title="Stock" color={c.paper} ink={c.ink} onPress={() => adjust(it)} accessibilityLabel={`Change stock of ${it.name}`} /></View>} />
      )) : <Empty emoji="📦" title="No stock yet" sub="Tap ＋ Add to put a drink, a tube of shuttlecocks or a rental racket on the front desk." />}
      {form ? <FormSheet visible onClose={() => setForm(null)} title={form.title} fields={form.fields} initial={form.initial} submitLabel={form.submit} notice={form.notice} color={c.violet} onSubmit={form.go} /> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ report (managers)
const Bar = ({ label, value, max, text, color = c.violet }) => (
  <View style={{ gap: 3 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={13} weight="600" style={{ flex: 1 }}>{label}</T><T size={13} weight="800">{text}</T></View>
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line }}><View style={{ height: 8, borderRadius: 4, backgroundColor: color, width: `${Math.max(2, Math.round((value / (max || 1)) * 100))}%` }} /></View>
  </View>
);
const CATEGORY = { court: 'Court time', merch: 'Merchandise', equipment: 'Equipment', apparel: 'Apparel', food_beverage: 'Food & drink', nutrition: 'Nutrition', medical: 'First aid', other: 'Other', rental: 'Rental fees', deposit: 'Rental deposits', membership: 'Memberships', pass: 'Passes', fee: 'Fees collected', academy: 'Academy fees' };
const METHOD = { cash: 'Cash', card_terminal: 'Card terminal (by hand)', upi_manual: 'UPI (by hand)', bank_manual: 'Bank transfer (by hand)', other_manual: 'Other (by hand)', online: 'Online (provider-confirmed)' };

export function DeskReport({ v }) {
  const tz = v.timezone, cur = v.currency, today = todayIn(tz);
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const q = useMemo(() => ({ from: localToIso(range.from, '00:00', tz), to: localToIso(addDays(range.to ?? range.from, 1), '00:00', tz) }), [range, tz]);
  const r = useLoad(() => api.get(`/venues/${v.id}/pos/report`, q), [v.id, q.from, q.to]);
  const d = r.data;
  const max = (rows, k) => Math.max(1, ...rows.map((x) => Number(x[k])));
  return (
    <View style={{ gap: 12 }}>
      <Section title="Front-desk report" color={c.violet}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Chip label="Today" active={range.from === today && range.to === today} onPress={() => setRange({ from: today, to: today })} />
          <Chip label="Last 7 days" onPress={() => setRange({ from: addDays(today, -6), to: today })} />
          <Chip label="Last 30 days" onPress={() => setRange({ from: addDays(today, -29), to: today })} />
        </View>
        <DateRangeField label="Period" from={range.from} to={range.to ?? range.from} onChange={({ from, to }) => setRange({ from, to })} />
        {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d ? (
          <>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <StatPill color={c.lime} label="NET SALES" value={moneyIn(d.net_cents, cur)} />
              <StatPill label="SALES" value={String(d.totals.sales)} />
              <StatPill label="DISCOUNTS" value={moneyIn(Number(d.totals.discount_cents), cur)} />
              <StatPill label="REFUNDED" value={moneyIn(Number(d.refunds.refunded_cents), cur)} />
              <StatPill label={`${v.tax_name ?? 'TAX'} IN SALES`} value={moneyIn(Number(d.totals.tax_cents), cur)} />
            </View>
            <Card color={d.reconciliation.reconciled ? c.mintSoft : c.orangeSoft} pad={12}>
              <T weight="800">{d.reconciliation.reconciled ? '✓ Reconciled' : '⚠ Does not reconcile'}</T>
              <T size={12} color={c.mute}>Sale lines {moneyIn(Number(d.reconciliation.owed_cents), cur)} = payments {moneyIn(Number(d.reconciliation.received_cents), cur)} + credit applied {moneyIn(Number(d.reconciliation.credits_cents), cur)}; invoices say {moneyIn(Number(d.reconciliation.invoiced_cents), cur)} against {moneyIn(Number(d.reconciliation.billed_cents), cur)} billed. Totals are read from the numbered invoices, payments and stock — there is no separate till total.</T>
            </Card>
            {d.open_items.online_pending || d.open_items.variances_to_review || d.open_items.refunds_for_desk || d.open_items.rentals_overdue ? (
              <Card color={c.sunSoft} pad={12}><T weight="800">Needs attention</T>
                {d.open_items.online_pending ? <T size={13}>• {d.open_items.online_pending} online payment{d.open_items.online_pending > 1 ? 's' : ''} waiting for the provider</T> : null}
                {d.open_items.variances_to_review ? <T size={13}>• {d.open_items.variances_to_review} cash variance{d.open_items.variances_to_review > 1 ? 's' : ''} to review</T> : null}
                {d.open_items.refunds_for_desk ? <T size={13}>• {d.open_items.refunds_for_desk} refund{d.open_items.refunds_for_desk > 1 ? 's' : ''} to pay back at the desk</T> : null}
                {d.open_items.rentals_overdue ? <T size={13}>• {d.open_items.rentals_overdue} rental{d.open_items.rentals_overdue > 1 ? 's' : ''} overdue</T> : null}</Card>
            ) : null}
            <Card color={c.paper}><T weight="800" size={15}>By category</T><View style={{ gap: 10, marginTop: 8 }}>{d.by_category.length ? d.by_category.map((x) => <Bar key={x.category} label={`${CATEGORY[x.category] ?? x.category} · ${x.qty}`} value={Number(x.total_cents)} max={max(d.by_category, 'total_cents')} text={`${moneyIn(Number(x.total_cents), cur)}${x.margin_cents != null ? ` · margin ${moneyIn(Number(x.margin_cents), cur)}` : ''}`} color={c.pink} />) : <T size={13} color={c.mute}>No sales in this period.</T>}</View></Card>
            <Card color={c.paper}><T weight="800" size={15}>By payment method</T><View style={{ gap: 10, marginTop: 8 }}>{d.by_method.map((x) => <Bar key={x.method} label={METHOD[x.method] ?? x.method} value={Number(x.taken_cents)} max={max(d.by_method, 'taken_cents')} text={`${moneyIn(Number(x.taken_cents), cur)}${Number(x.returned_cents) ? ` · back ${moneyIn(Number(x.returned_cents), cur)}` : ''}`} color={c.mint} />)}</View></Card>
            <Card color={c.paper}><T weight="800" size={15}>By cashier</T><View style={{ gap: 10, marginTop: 8 }}>{d.by_staff.map((x) => <Bar key={x.id} label={`${x.cashier} · ${x.sales} sale${x.sales === 1 ? '' : 's'}`} value={Number(x.total_cents)} max={max(d.by_staff, 'total_cents')} text={moneyIn(Number(x.total_cents), cur)} />)}</View></Card>
            {d.by_shift.length ? <Card color={c.paper}><T weight="800" size={15}>By shift</T>{d.by_shift.map((x) => <Row key={x.id} title={dateTimeIn(x.opened_at, tz)} sub={`${x.sales} sale${x.sales === 1 ? '' : 's'} · ${moneyIn(Number(x.total_cents), cur)}${x.status === 'closed' ? ` · variance ${moneyIn(Number(x.variance_cents), cur)}` : ' · open'}`} />)}</Card> : null}
          </>
        ) : null}
      </Section>
    </View>
  );
}

// ------------------------------------------------------------------ rules & approvals (managers)
const ALL_TENDERS = [{ value: 'cash', label: 'Cash' }, { value: 'card_terminal', label: 'Card terminal' }, { value: 'upi_manual', label: 'UPI (checked on your phone)' }, { value: 'bank_manual', label: 'Bank transfer' }, { value: 'other_manual', label: 'Other' }];

export function DeskRules({ v, reloadDesk }) {
  const { toast } = useSession();
  const cur = v.currency;
  const st = useLoad(() => api.get(`/venues/${v.id}/pos/settings`), [v.id]);
  const [form, setForm] = useState(null);
  const [code, setCode] = useState(null);
  const s = st.data;
  const limitText = (n) => (n == null ? 'Always needs a manager' : `Up to ${moneyIn(Number(n), cur)}`);
  const edit = () => setForm({
    title: 'Desk rules', submit: 'Save',
    initial: { ...s, discount_pct: s.cashier_discount_max_bp / 100, refund_mode: s.refund_limit_cents == null ? 'ask' : 'limit', paid_mode: s.paid_out_limit_cents == null ? 'ask' : 'limit', refund_limit: s.refund_limit_cents ?? undefined, paid_limit: s.paid_out_limit_cents ?? undefined },
    fields: [
      { key: 'manual_methods', label: 'Payments staff may record by hand', type: 'multi', options: ALL_TENDERS },
      { key: 'require_shift', label: 'Cash needs an open drawer shift', type: 'switch' },
      { key: 'discount_pct', label: 'Biggest discount a cashier can give alone', type: 'stepper', min: 0, max: 100, suffix: '%' },
      { key: 'refund_mode', label: 'Cashier refunds', type: 'chips', options: [{ value: 'ask', label: 'Always need a manager' }, { value: 'limit', label: 'Allowed up to a limit' }] },
      { key: 'refund_limit', label: 'Refund limit', type: 'money', currency: cur, show: (x) => x.refund_mode === 'limit', optional: true },
      { key: 'paid_mode', label: 'Cashier paid-outs', type: 'chips', options: [{ value: 'ask', label: 'Always need a manager' }, { value: 'limit', label: 'Allowed up to a limit' }] },
      { key: 'paid_limit', label: 'Paid-out limit', type: 'money', currency: cur, show: (x) => x.paid_mode === 'limit', optional: true },
      { key: 'variance_tolerance_cents', label: 'A count this far off is accepted without review', type: 'money', currency: cur, optional: true },
      { key: 'offline_cash_allowed', label: 'Accept cash sales made while the device was offline', type: 'switch' },
    ],
    go: async (x) => {
      await api.patch(`/venues/${v.id}/pos/settings`, { manual_methods: x.manual_methods, require_shift: x.require_shift, cashier_discount_max_bp: Math.round(x.discount_pct * 100),
        refund_limit_cents: x.refund_mode === 'limit' ? x.refund_limit ?? 0 : null, paid_out_limit_cents: x.paid_mode === 'limit' ? x.paid_limit ?? 0 : null, variance_tolerance_cents: x.variance_tolerance_cents ?? 0, offline_cash_allowed: x.offline_cash_allowed });
      st.reload(); reloadDesk(); return 'Saved';
    },
  });
  const approve = () => setForm({
    title: 'Approve something for a cashier', submit: 'Get the code', notice: 'The code works once, only here, for this kind of thing and up to this amount. It expires.',
    fields: [{ key: 'kind', label: 'What', type: 'chips', options: [{ value: 'discount', label: 'A bigger discount' }, { value: 'refund', label: 'A refund' }, { value: 'paid_out', label: 'A paid-out' }, { value: 'void', label: 'Cancelling a sale' }], default: 'discount' },
      { key: 'max_amount_cents', label: 'Up to', type: 'money', currency: cur }, { key: 'reason', label: 'Why', type: 'chips', options: ['Regular customer', 'Damaged goods', 'Customer complaint', 'Supplier payment', 'Other'] },
      { key: 'valid_minutes', label: 'Valid for', type: 'stepper', min: 1, max: 60, default: 10, suffix: ' min' }],
    go: async (x) => { const a = await api.post(`/venues/${v.id}/pos/approvals`, x); setCode(a); return undefined; },
  });
  return (
    <View style={{ gap: 12 }}>
      <Section title="Approvals" color={c.orange}>
        <T size={13} color={c.mute}>When a cashier needs your OK, make a one-time code and tell it to them. Nothing above their limits goes through without it, and every approval is logged.</T>
        <Btn title="Approve something for a cashier" color={c.violet} onPress={approve} />
      </Section>
      <Section title="Desk rules" color={c.violet} action="Edit" onAction={s ? edit : undefined}>
        {st.loading && !s ? <Loading /> : st.error ? <ErrorBox error={st.error} onRetry={st.reload} /> : s ? (
          <>
            <Row left={<T size={20}>💵</T>} title="Payments staff can record by hand" sub={s.manual_methods.map((m) => ALL_TENDERS.find((x) => x.value === m)?.label ?? m).join(', ') + ' — online payments are always confirmed by the provider'} />
            <Row left={<T size={20}>🧮</T>} title="Cash needs an open drawer" sub={s.require_shift ? 'Yes' : 'No — the drawer is optional'} />
            <Row left={<T size={20}>🏷️</T>} title="Cashier discount limit" sub={`${s.cashier_discount_max_bp / 100}% — above that a manager approves`} />
            <Row left={<T size={20}>↩︎</T>} title="Cashier refunds" sub={limitText(s.refund_limit_cents)} />
            <Row left={<T size={20}>⬆️</T>} title="Cashier paid-outs" sub={limitText(s.paid_out_limit_cents)} />
            <Row left={<T size={20}>⚖️</T>} title="Cash variance review" sub={Number(s.variance_tolerance_cents) ? `Reviewed when off by more than ${moneyIn(Number(s.variance_tolerance_cents), cur)}` : 'Every difference is reviewed by a manager'} />
            <Row left={<T size={20}>📴</T>} title="Offline cash sales" sub={s.offline_cash_allowed ? 'Accepted and uploaded when back online' : 'Not accepted'} />
          </>
        ) : null}
      </Section>
      {form ? <FormSheet visible onClose={() => setForm(null)} title={form.title} fields={form.fields} initial={form.initial} submitLabel={form.submit} notice={form.notice} color={c.violet} onSubmit={form.go} /> : null}
      <Sheet visible={!!code} onClose={() => setCode(null)} title="Approval code">
        {code ? (
          <View style={{ alignItems: 'center', gap: 8 }}>
            <T weight="800" size={44} style={{ letterSpacing: 8 }} accessibilityLabel={`Approval code ${String(code.code).split('').join(' ')}`}>{code.code}</T>
            <T color={c.mute} size={13} style={{ textAlign: 'center' }}>Tell the cashier. One use, up to {moneyIn(Number(code.max_amount_cents), cur)}, expires {dateTimeIn(code.expires_at, v.timezone)}.</T>
            <Btn title="Done" onPress={() => setCode(null)} />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
