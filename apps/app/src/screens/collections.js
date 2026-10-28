// Collections: the finance desk for money that is owed repeatedly (academy fees, club dues, venue memberships). One component serves an academy's
// Finance tab, a club's Collections tab and a venue's memberships; it only calls the collections API. What is owed stays on the canonical charge /
// invoice / payment; this screen is the work queue, the recurring schedules, the policy and the report around them.
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { explain } from '../access';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Row, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { Bars, Block, Fact, Kpi, Split, Timeline, openInvoicePdf, when } from './academy-ui';

const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;
const idem = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const plusMonths = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

// State words always carry an icon and a label, never colour alone.
const STATE = {
  upcoming: ['🗓️', 'Upcoming'], due: ['🔔', 'Due'], attempted: ['⏳', 'Payment started'], failed: ['⚠️', 'Payment failed'], retrying: ['🔁', 'Asked to retry'], overdue: ['⏰', 'Overdue'],
  escalated: ['🚨', 'Escalated'], paid: ['✅', 'Paid'], resolved: ['✅', 'Recovered'], waived: ['🤝', 'Waived'], cancelled: ['✖️', 'Cancelled'],
};
const STATE_TONE = { overdue: c.orangeSoft, escalated: c.orangeSoft, failed: c.orangeSoft, retrying: c.orangeSoft, attempted: c.sunSoft, due: c.sunSoft, paid: c.lime, resolved: c.lime };
const StateTag = ({ state }) => <Tag label={`${STATE[state]?.[0] ?? ''} ${STATE[state]?.[1] ?? state}`.trim()} color={STATE_TONE[state]} />;
const KIND = { instalment: 'Instalment', dues: 'Dues', tuition: 'Tuition', registration: 'Joining fee', deposit: 'Deposit', trial: 'Trial fee', pack: 'Session pack', late_fee: 'Late fee', membership: 'Membership renewal' };
const offsetWords = (o) => (o < 0 ? `${-o} day${o === -1 ? '' : 's'} before it was due` : o === 0 ? 'on the due date' : `${o} day${o === 1 ? '' : 's'} after`);

/** One line of the case history, in words a finance person would use. */
function eventLine(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'reminder_sent': return [`Reminder sent ${offsetWords(d.offset)}`, d.recipients ? `reached ${d.recipients} ${d.recipients === 1 ? 'person' : 'people'}` : 'nobody reachable on their notification settings'];
    case 'retry_requested': return ['Asked the payer to try again', `after failed attempt ${d.attempt}`];
    case 'attempt_started': return ['A payment was started', null];
    case 'attempt_failed': return ['The payment did not go through', 'still owed'];
    case 'payment_received': return ['Payment confirmed', null];
    case 'auto_debit_unavailable': return ['Automatic debit is not connected', 'the invoice stays open and the payer is asked to pay'];
    case 'auto_debit_started': return ['Automatic debit requested from the provider', 'not paid until the provider confirms'];
    case 'auto_debit_failed': return ['Automatic debit failed', d.reason ?? null];
    case 'promise': return [`Promise to pay by ${when(d.promised_on)}`, null];
    case 'promise_broken': return [`Promise to pay by ${when(d.promised_on)} was not kept`, null];
    case 'hold': return [`On hold until ${when(d.until)}`, null];
    case 'hold_released': return ['Hold released', null];
    case 'note': return ['Internal note', null];
    case 'next_action': return [`Next: ${d.next_action}`, d.on ? `by ${when(d.on)}` : null];
    case 'plan_approved': return ['Payment plan approved', `${d.instalments} instalments`];
    case 'plan_broken': return ['Payment plan broken', `missed ${when(d.missed_on)}`];
    case 'plan_cancelled': return ['Payment plan cancelled', null];
    case 'late_fee_added': return ['Late fee added as its own charge', null];
    case 'suspended': return [d.automatic ? 'Access paused by policy' : 'Access paused by staff', 'future sessions only'];
    case 'reinstated': return [d.automatic ? 'Access restored automatically' : 'Access restored by staff', null];
    case 'escalated': return ['Escalated to finance staff', `${d.days_past_due} days past due`];
    case 'state_change': return [`${STATE[d.from]?.[1] ?? d.from ?? ''} → ${STATE[d.to]?.[1] ?? d.to}`.trim(), d.recovered ? 'recovered after trouble' : null];
    default: return [e.kind.replaceAll('_', ' '), null];
  }
}

export function Collections({ target, archived = false }) {
  const isOrg = !!target.organisation_id;
  const [tab, setTab] = useState('queue');
  const options = [{ value: 'queue', label: 'Work queue' }, ...(isOrg ? [{ value: 'schedules', label: 'Schedules' }] : []), { value: 'policy', label: 'Policy' }, ...(isOrg ? [{ value: 'report', label: 'Report' }] : [])];
  return (
    <View style={{ gap: 12 }}>
      <Seg value={tab} onChange={setTab} color={c.violet} options={options} />
      {tab === 'queue' ? <Queue target={target} archived={archived} /> : null}
      {tab === 'schedules' && isOrg ? <Schedules target={target} archived={archived} /> : null}
      {tab === 'policy' ? <PolicyTab target={target} archived={archived} /> : null}
      {tab === 'report' && isOrg ? <ReportTab target={target} /> : null}
      <T size={11} color={c.mute}>Money owed lives on the charge, invoice and payment records. This desk records who was told, what was promised and what staff decided; it never marks anything paid on its own.</T>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ work queue
const FILTERS = [
  { key: 'action', label: 'Needs action', query: { state: 'open', needs_action: true } },
  { key: 'open', label: 'All open', query: { state: 'open' } },
  { key: 'late', label: 'Overdue', query: { state: 'overdue,escalated' } },
  { key: 'trouble', label: 'Payment trouble', query: { state: 'failed,retrying,attempted' } },
  { key: 'closed', label: 'Closed', query: { state: 'closed' } },
];

function Queue({ target, archived }) {
  const [filter, setFilter] = useState('action'), [q, setQ] = useState(''), [term, setTerm] = useState(''), [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const f = FILTERS.find((x) => x.key === filter);
  const list = useLoad(() => api.get('/collections/cases', { ...target, ...f.query, q: term || undefined, limit: 100 }), [JSON.stringify(target), filter, term]);
  const reload = () => list.reload();
  const items = list.data?.items ?? [];
  const L = (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {(list.data?.totals ?? []).map((t) => <Kpi key={t.currency} label={`${t.currency} still owed`} value={moneyIn(t.balance_minor, t.currency)} sub={`${t.cases} open · ${moneyIn(t.overdue_minor, t.currency)} overdue`} tone={Number(t.overdue_minor) ? 'alert' : undefined} />)}
        {list.data && !list.data.totals.length ? <Kpi label="Still owed" value="–" sub="Nothing is waiting for payment" /> : null}
      </View>
      <Panel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{FILTERS.map((x) => <Chip key={x.key} label={x.label} active={filter === x.key} onPress={() => setFilter(x.key)} />)}</ScrollView>
        <Field value={q} onChangeText={setQ} placeholder="Search a payer or athlete…" accessibilityLabel="Search the collections queue" />
        {list.error ? <ErrorBox error={list.error} onRetry={reload} /> : !list.data ? <Loading /> : items.length ? items.map((x) => (
          <Row key={x.id} title={`${x.athlete_name} · ${KIND[x.kind] ?? x.kind}`}
            sub={[`${moneyIn(x.balance_minor, x.currency)} due ${when(x.due_on)}`, x.days_past_due > 0 && !['paid', 'resolved', 'waived', 'cancelled'].includes(x.state) ? `${x.days_past_due} days late` : null, Number(x.settled_minor) > 0 ? `${moneyIn(x.settled_minor, x.currency)} paid` : null, x.failed_attempts ? `${x.failed_attempts} failed` : null, x.promised_on ? `promised ${when(x.promised_on)}` : null, x.hold_until ? `on hold to ${when(x.hold_until)}` : null, x.has_plan ? 'payment plan' : null, x.suspended ? 'access paused' : null, x.payer_name !== x.athlete_name ? `payer ${x.payer_name}` : null].filter(Boolean).join(' · ')}
            right={<StateTag state={x.state} />} color={open === x.id ? c.violetSoft : c.paper} onPress={() => setOpen(x.id)} />
        )) : <Empty emoji={filter === 'closed' ? '🗄️' : '🎉'} title={filter === 'closed' ? 'Nothing closed yet' : filter === 'action' ? 'Nothing needs you right now' : 'Nothing here'} sub="Cases open by themselves when a charge is raised or a membership renewal is waiting for payment." />}
      </Panel>
    </View>
  );
  return <Split list={L} open={!!open} onClose={() => setOpen(null)} detailTitle="Case" detail={open ? <CaseDetail id={open} target={target} archived={archived} onChanged={reload} /> : null} />;
}

function CaseDetail({ id, target, archived, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/collections/cases/${id}`), [id]);
  const [form, setForm] = useState(null);
  const key = useRef(idem('c'));
  const openForm = (name) => { key.current = idem('c'); setForm(name); };
  const done = (msg) => async () => { d.reload(); onChanged?.(); return msg; };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const x = d.data, s = x.source, org = x.owner_type === 'organisation', openCase = !['paid', 'resolved', 'waived', 'cancelled'].includes(x.state);
  const cur = s?.currency ?? x.currency;
  const act = (body) => api.post(`/collections/cases/${id}/actions`, { ...body, idempotency_key: key.current });
  const can = openCase && !archived;
  const timeline = x.events.map((e) => {
    const [title, sub] = eventLine(e);
    const money = ['waiver', 'concession'].includes(e.kind) ? `${moneyIn(e.data.amount_minor, cur)}${e.kind === 'waiver' ? ' waived' : ' reduced'} · balance ${moneyIn(e.data.balance_minor, cur)}` : null;
    return { title: money ?? title, sub: [when(e.created_at), e.actor ? `by ${e.actor}` : 'automatic', sub, e.note ? `🔒 ${e.note}` : null].filter(Boolean).join(' · ') };
  });
  const balance = Number(s?.balance_minor ?? s?.amount_minor ?? 0);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StateTag state={x.state} />{x.suspension?.status === 'active' ? <Tag label="⏸️ Access paused" color={c.orangeSoft} /> : null}{x.payment_plan?.status === 'active' ? <Tag label="📅 Payment plan" /> : null}</View>
      {org && s ? (
        <>
          <Fact k="Athlete" v={s.athlete_name} /><Fact k="Payer" v={s.payer_name} /><Fact k="For" v={`${KIND[s.kind] ?? s.kind}${s.programme ? ` · ${s.programme}` : ''}`} />
          <Fact k="Charged" v={moneyIn(s.amount_minor, cur)} /><Fact k="Received" v={moneyIn(s.settled_minor, cur)} /><Fact k="Waived or reduced" v={Number(s.adjusted_minor) ? moneyIn(s.adjusted_minor, cur) : null} />
          <Fact k="Still owed" v={moneyIn(balance, cur)} /><Fact k="Due" v={`${when(x.due_on)}${x.days_past_due > 0 && openCase ? ` · ${x.days_past_due} days late` : ''}`} />
          <Fact k="Invoice" v={s.invoice_number} />
          {s.invoice_id ? <Btn small title={s.status === 'paid' ? 'Receipt (PDF)' : 'Invoice (PDF)'} color={c.paper} ink={c.ink} onPress={() => openInvoicePdf(s.invoice_id, toast)} style={{ alignSelf: 'flex-start' }} /> : null}
        </>
      ) : s ? (<><Fact k="Membership" v={s.name} /><Fact k="Renewal price" v={moneyIn(s.amount_minor, cur)} /><Fact k="Due" v={`${when(x.due_on)}${x.days_past_due > 0 && openCase ? ` · ${x.days_past_due} days late` : ''}`} /></>) : null}
      {x.schedule ? <Fact k="Recurring" v={`${x.schedule.label} · payment ${x.schedule.period_no} of ${x.schedule.periods}${x.schedule.has_mandate ? ` · mandate ${x.schedule.mandate_status}` : ''}`} /> : null}
      {x.schedule?.has_mandate ? <T size={11} color={c.mute}>A mandate is the payer’s permission to collect. It is not a payment: nothing counts as paid until the provider confirms the money.</T> : null}
      {x.payment_plan?.instalments ? <Fact k="Plan" v={x.payment_plan.instalments.map((i) => `${moneyIn(i.amount_minor, cur)} by ${when(i.due_on)}`).join(' · ')} /> : null}
      {x.promised_on ? <Fact k="Promised" v={`by ${when(x.promised_on)}`} /> : null}{x.hold_until ? <Fact k="On hold" v={`until ${when(x.hold_until)}`} /> : null}{x.next_action ? <Fact k="Next" v={`${x.next_action}${x.next_action_on ? ` · ${when(x.next_action_on)}` : ''}`} /> : null}
      {can || (!archived && !openCase) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {can && org && s?.status === 'awaiting_payment' ? <Btn small title="Record a payment" onPress={() => openForm('pay')} /> : null}
          {can && org && s?.status === 'awaiting_payment' ? <Btn small title="Waive or reduce" color={c.paper} ink={c.ink} onPress={() => openForm('adjust')} /> : null}
          {can && org && s?.status === 'awaiting_payment' && x.payment_plan?.status !== 'active' ? <Btn small title="Payment plan" color={c.paper} ink={c.ink} onPress={() => openForm('plan')} /> : null}
          {can && x.payment_plan?.status === 'active' ? <Btn small title="Cancel plan" color={c.paper} ink={c.ink} onPress={() => openForm('cancelplan')} /> : null}
          {can ? <Btn small title="Promise to pay" color={c.paper} ink={c.ink} onPress={() => openForm('promise')} /> : null}
          {can ? <Btn small title={x.hold_until ? 'Release hold' : 'Put on hold'} color={c.paper} ink={c.ink} onPress={() => (x.hold_until ? act({ action: 'release_hold' }).then(() => { d.reload(); onChanged?.(); toast('Hold released'); }).catch((e) => toast(explain(e))) : openForm('hold'))} /> : null}
          {can ? <Btn small title="Set next step" color={c.paper} ink={c.ink} onPress={() => openForm('next')} /> : null}
          {can && org && x.suspension?.status === 'active' ? <Btn small title="Restore access" onPress={() => openForm('reinstate')} /> : null}
          {can && org && x.policy?.suspension_enabled && x.suspension?.status !== 'active' ? <Btn small title="Pause access" color={c.orange} onPress={() => openForm('suspend')} /> : null}
          {!archived ? <Btn small title="Add a note" color={c.paper} ink={c.ink} onPress={() => openForm('note')} /> : null}
        </View>
      ) : null}
      <Block title="History">{timeline.length ? <Timeline items={timeline} /> : <T size={13} color={c.mute}>Nothing has happened yet.</T>}</Block>
      <T size={11} color={c.mute}>🔒 Notes are internal: they are encrypted, never sent to the payer, and reading them is logged.</T>

      <FormSheet visible={form === 'pay'} onClose={() => setForm(null)} title="Record a payment" submitLabel="Record" initial={{ method: 'cash' }}
        fields={[{ key: 'method', label: 'How was it paid?', type: 'chips', options: [['cash', 'Cash'], ['card', 'Card machine'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['other', 'Other']].map(([value, label]) => ({ value, label })) },
          { key: 'amount_minor', label: 'Amount', type: 'money', currency: () => cur, optional: true, hint: `Leave empty for everything still owed (${moneyIn(balance, cur)}). Enter less to record a part payment: the invoice and charge stay as they are.` }]}
        onSubmit={async (v) => { const r = await api.post(`/academy-charges/${s.id}/paid`, { ...v, idempotency_key: key.current }); return (await done(r.completed ? 'Paid in full — receipt ready' : `Part payment recorded — ${moneyIn(r.balance_minor, cur)} still owed`)()); }} />
      <FormSheet visible={form === 'adjust'} onClose={() => setForm(null)} title="Waive or reduce" submitLabel="Apply" initial={{ kind: 'waiver' }}
        fields={[{ key: 'kind', label: 'What is it?', type: 'chips', options: [{ value: 'waiver', label: 'Waive (forgive)' }, { value: 'concession', label: 'Reduce (goodwill)' }] },
          { key: 'amount_minor', label: 'Amount', type: 'money', currency: () => cur, hint: `Up to ${moneyIn(balance, cur)}. The price and the numbered invoice are not edited.` },
          { key: 'reason', label: 'Reason (internal)', type: 'multiline', hint: 'Only finance staff see this.' }]}
        onSubmit={async (v) => { const r = await api.post(`/academy-charges/${s.id}/adjustments`, { ...v, idempotency_key: key.current }); return (await done(r.balance_minor === 0 ? 'Nothing more is owed' : `Balance now ${moneyIn(r.balance_minor, cur)}`)()); }} />
      <FormSheet visible={form === 'plan'} onClose={() => setForm(null)} title="Payment plan" submitLabel="Approve plan" initial={{ first: plusDays(todayStr(), 7), count: 3, every: 'month' }}
        fields={[{ key: 'first', label: 'First instalment', type: 'date' }, { key: 'count', label: 'Number of instalments', type: 'stepper', min: 2, max: 12 },
          { key: 'every', label: 'Every', type: 'chips', options: [{ value: 'week', label: 'Week' }, { value: 'fortnight', label: 'Two weeks' }, { value: 'month', label: 'Month' }], hint: `Splits the ${moneyIn(balance, cur)} still owed equally; the last instalment takes any rounding. The original charge and invoice stay as they were.` }]}
        onSubmit={async (v) => {
          const base = Math.floor(balance / v.count), list = Array.from({ length: v.count }, (_, n) => ({ due_on: v.every === 'month' ? plusMonths(v.first, n) : plusDays(v.first, n * (v.every === 'week' ? 7 : 14)), amount_minor: base }));
          list[list.length - 1].amount_minor += balance - base * v.count;
          await api.post(`/academy-charges/${s.id}/payment-plan`, { instalments: list, idempotency_key: key.current }); return (await done('Payment plan approved')());
        }} />
      <FormSheet visible={form === 'cancelplan'} onClose={() => setForm(null)} title="Cancel the payment plan" submitLabel="Cancel plan"
        fields={[{ key: 'reason', label: 'Why?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/payment-plans/${x.payment_plan.id}/cancel`, v); return (await done('Plan cancelled — the original due date applies again')()); }} />
      <FormSheet visible={form === 'promise'} onClose={() => setForm(null)} title="Promise to pay" submitLabel="Record promise" initial={{ promised_on: plusDays(todayStr(), 7) }}
        fields={[{ key: 'promised_on', label: 'Promised date', type: 'date', hint: 'Reminders pause until this date. If it passes unpaid, the broken promise is recorded.' }, { key: 'note', label: 'Note (internal)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await act({ action: 'promise', ...v }); return (await done('Promise recorded')()); }} />
      <FormSheet visible={form === 'hold'} onClose={() => setForm(null)} title="Put on hold" submitLabel="Hold" initial={{ until: plusDays(todayStr(), 14) }}
        fields={[{ key: 'until', label: 'Hold until', type: 'date', hint: 'No reminders, late fees or access pausing until then. At most 90 days.' }, { key: 'reason', label: 'Why (internal)', type: 'multiline' }]}
        onSubmit={async (v) => { await act({ action: 'hold', ...v }); return (await done('On hold')()); }} />
      <FormSheet visible={form === 'next'} onClose={() => setForm(null)} title="Next step" submitLabel="Save"
        fields={[{ key: 'next_action', label: 'What happens next?', hint: 'For example “Call the parent”.' }, { key: 'next_action_on', label: 'By when', type: 'date', optional: true }]}
        onSubmit={async (v) => { await act({ action: 'next_action', ...v }); return (await done('Saved')()); }} />
      <FormSheet visible={form === 'note'} onClose={() => setForm(null)} title="Internal note" submitLabel="Add note"
        fields={[{ key: 'note', label: 'Note', type: 'multiline', hint: 'Never shown to the payer.' }]}
        onSubmit={async (v) => { await act({ action: 'note', ...v }); return (await done('Note added')()); }} />
      <FormSheet visible={form === 'suspend'} onClose={() => setForm(null)} title="Pause access" submitLabel="Pause access"
        fields={[{ key: 'reason', label: 'Why?', type: 'multiline', hint: 'Only future session check-in and passes pause. Enrolment, history and any health or safety records are untouched. Paying or waiving restores it.' }]}
        onSubmit={async (v) => { await act({ action: 'suspend', ...v }); return (await done('Access paused')()); }} />
      <FormSheet visible={form === 'reinstate'} onClose={() => setForm(null)} title="Restore access" submitLabel="Restore"
        fields={[{ key: 'reason', label: 'Why?', type: 'multiline' }, { key: 'until', label: 'Keep the case on hold until', type: 'date', optional: true, hint: 'Default two weeks, so the policy does not pause access again straight away.' }]}
        onSubmit={async (v) => { await act({ action: 'reinstate', ...v }); return (await done('Access restored')()); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ schedules
function Schedules({ target, archived }) {
  const { toast } = useSession();
  const orgId = target.organisation_id;
  const [status, setStatus] = useState('active'), [form, setForm] = useState(false), [sel, setSel] = useState(null);
  const key = useRef(idem('sch'));
  const list = useLoad(() => api.get('/billing-schedules', { organisation_id: orgId, status, limit: 100 }), [orgId, status]);
  const people = useLoad(async () => {
    const cohorts = await api.get(`/organisations/${orgId}/cohorts`).catch(() => []);
    const rows = await Promise.all(cohorts.filter((k) => k.status !== 'archived').map((k) => api.get(`/cohorts/${k.id}/enrolments`, { limit: 100 }).then((r) => r.map((p) => ({ id: p.enrolment_id, label: p.display_name, sub: k.name }))).catch(() => [])));
    return rows.flat();
  }, [orgId]);
  const profile = useLoad(() => api.get(`/organisations/${orgId}/academy`).catch(() => null), [orgId]);
  const change = async (body, msg) => { try { await api.patch(`/billing-schedules/${sel.id}`, body); toast(msg); setSel(null); list.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Panel>
      <Block title="Recurring schedules" right={!archived ? <Btn small title="＋ New schedule" onPress={() => { key.current = idem('sch'); setForm(true); }} /> : null}>
        <T size={12} color={c.mute}>A schedule freezes the amount and every due date. Each period raises one charge and one numbered invoice a few days before it is due, however many times it runs. An enrolment that already renews through a subscription is billed there, not here.</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{[['active', 'Active'], ['paused', 'Paused'], ['ended', 'Ended']].map(([v, l]) => <Chip key={v} label={l} active={status === v} onPress={() => setStatus(v)} />)}</ScrollView>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((s) => (
          <Row key={s.id} title={`${s.athlete_name} · ${s.label}`} sub={`${moneyIn(s.amount_minor, s.currency)} × ${s.due_dates.length} · ${s.periods_raised} raised · next ${when(s.due_dates[s.periods_raised] ?? s.due_dates.at(-1))} · payer ${s.payer_name}${s.has_mandate ? ` · mandate ${s.mandate_status}` : ''}`}
            right={<Tag label={s.status} color={s.status === 'active' ? c.lime : undefined} />} onPress={() => setSel(s)} />
        )) : <Empty emoji="🔁" title="No recurring schedules" sub="Set one up for monthly dues, a term or a season. Nothing is billed until you do." />}
      </Block>
      <Sheet visible={!!sel} onClose={() => setSel(null)} title={sel ? `${sel.athlete_name} · ${sel.label}` : ''}>
        {sel ? (
          <View style={{ gap: 10 }}>
            <Fact k="Amount" v={`${moneyIn(sel.amount_minor, sel.currency)} × ${sel.due_dates.length}${sel.tax_rate_bp ? ` · tax included ${sel.tax_rate_bp / 100}%` : ''}`} />
            <Fact k="Due dates" v={sel.due_dates.map((d) => when(d)).join(' · ')} />
            <Fact k="Raised" v={`${sel.periods_raised} of ${sel.due_dates.length} — the rest are raised ${sel.raise_days_before} days before each is due`} />
            <Fact k="Mandate" v={sel.has_mandate ? `${sel.mandate_status} — a permission to collect, not a payment` : 'None: the payer is asked to pay each invoice'} />
            {sel.ended_reason ? <Fact k="Ended" v={sel.ended_reason.replaceAll('_', ' ')} /> : null}
            {!archived && sel.status !== 'ended' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {sel.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => change({ action: 'pause' }, 'Paused')} /> : <Btn small title="Resume" onPress={() => change({ action: 'resume' }, 'Resumed')} />}
                <Btn small title="End schedule" color={c.orange} onPress={() => change({ action: 'end', reason: 'Ended by staff' }, 'Ended — raised charges are kept')} />
              </View>
            ) : null}
            <T size={11} color={c.mute}>Pausing or ending raises no more charges. Charges and invoices already raised are kept.</T>
          </View>
        ) : null}
      </Sheet>
      <FormSheet visible={form} onClose={() => setForm(false)} title="New recurring schedule" submitLabel="Create schedule" initial={{ kind: 'monthly', currency: profile.data?.currency ?? undefined, periods: 10, every_months: 1, first_due_on: plusDays(todayStr(), 7), tax_pct: 0, raise_days_before: 7 }}
        fields={[
          { key: 'enrolment_id', label: 'Who is billed for', type: 'entity', entityKind: 'person', noun: 'person', options: people.data ?? [] },
          { key: 'kind', label: 'Rhythm', type: 'chips', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'term', label: 'Termly' }, { value: 'season', label: 'Seasonal' }, { value: 'custom', label: 'Every N months' }] },
          { key: 'every_months', label: 'Months between payments', type: 'stepper', min: 1, max: 12, show: (v) => v.kind === 'custom' },
          { key: 'label', label: 'What it is for', hint: 'Shown on the invoice, e.g. “Membership 2030/31”.' },
          { key: 'currency', label: 'Currency', type: 'currency' }, { key: 'amount_minor', label: 'Amount each time', type: 'money', currency: (v) => v.currency ?? 'GBP' },
          { key: 'first_due_on', label: 'First due date', type: 'date' }, { key: 'periods', label: 'Number of payments', type: 'stepper', min: 1, max: 60 },
          { key: 'tax_pct', label: 'Tax included in the amount', type: 'stepper', min: 0, max: 50, suffix: '%' },
          { key: 'raise_days_before', label: 'Raise the invoice this many days early', type: 'stepper', min: 0, max: 60 },
          { key: 'payer_id', label: 'Billed to', type: 'entity', entityKind: 'person', noun: 'guardian', optional: true, hint: 'Only needed for a young person with more than one guardian. Young people are always billed to a verified guardian, never to the child.' },
          { key: 'mandate_ref', label: 'Provider mandate reference', optional: true, hint: 'Optional. A mandate is a permission to collect, kept apart from the invoice and its payment. Until a payment provider is connected, the invoice is raised and the payer is asked to pay.' },
        ]}
        onSubmit={async (v) => {
          const { tax_pct, ...rest } = v;
          const r = await api.post('/billing-schedules', { organisation_id: orgId, ...rest, tax_rate_bp: Math.round((tax_pct ?? 0) * 100), ...(v.kind === 'custom' ? {} : { every_months: undefined }), idempotency_key: key.current });
          list.reload(); return r.replay ? 'Already created' : `Schedule created — ${r.raised_now} charge${r.raised_now === 1 ? '' : 's'} raised now`;
        }} />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ policy
const OFFSET_OPTIONS = [-7, -3, -1, 0, 1, 3, 7, 14, 21, 30].map((n) => ({ value: n, label: n < 0 ? `${-n}d before` : n === 0 ? 'On the day' : `${n}d after` }));
const RETRY_OPTIONS = [1, 2, 3, 5, 7, 10].map((n) => ({ value: n, label: `${n} day${n === 1 ? '' : 's'} later` }));

function PolicyTab({ target, archived }) {
  const isOrg = !!target.organisation_id;
  const p = useLoad(() => api.get('/collections/policy', target), [JSON.stringify(target)]);
  const [edit, setEdit] = useState(false);
  if (p.error) return <ErrorBox error={p.error} onRetry={p.reload} />;
  if (!p.data) return <Loading />;
  const x = p.data;
  const offsets = (x.reminder_offsets ?? []).map((n) => OFFSET_OPTIONS.find((o) => o.value === n)?.label ?? `${n}d`).join(' · ');
  return (
    <Panel>
      <Block title="How we chase money" right={!archived ? <Btn small title="Change" onPress={() => setEdit(true)} /> : null}>
        <T size={12} color={c.mute}>{x.customised ? 'Your policy.' : 'The standard policy. Nothing is charged or paused beyond reminders until you choose it.'}</T>
        <Fact k="Reminders" v={offsets} /><Fact k="Grace" v={`${x.grace_days} days after the due date before it is overdue`} />
        <Fact k="After a failed payment" v={x.retry_days.length ? `ask again ${x.retry_days.map((n) => `${n}d`).join(', ')} after` : 'do not ask again automatically'} />
        <Fact k="Escalates to finance" v={`${x.escalate_after_days} days after the due date`} />
        {isOrg ? <Fact k="Late fee" v={x.late_fee_enabled ? `${moneyIn(x.late_fee_minor, x.late_fee_currency ?? 'GBP')} after ${x.late_fee_after_days} days — basis: ${x.late_fee_basis}` : 'Off'} /> : null}
        {isOrg ? <Fact k="Pause access" v={x.suspension_enabled ? `Future session check-in pauses ${x.suspend_after_days} days after the due date; paying or waiving restores it` : 'Off'} /> : null}
        <T size={11} color={c.mute}>Reminders reach the payer (or a young person’s verified guardian) through their own notification settings, once per step. A human hold or a promise to pay pauses everything on one case.</T>
      </Block>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Collections policy" submitLabel="Save policy"
        initial={{ ...x, late_fee_currency: x.late_fee_currency ?? undefined }}
        fields={[
          { key: 'reminder_offsets', label: 'Send a reminder', type: 'multi', options: OFFSET_OPTIONS },
          { key: 'grace_days', label: 'Grace days before overdue', type: 'stepper', min: 0, max: 30 },
          { key: 'retry_days', label: 'After a failed payment, ask again', type: 'multi', options: RETRY_OPTIONS, optional: true },
          { key: 'escalate_after_days', label: 'Escalate to finance after', type: 'stepper', min: 1, max: 90, step: 7, suffix: ' days' },
          ...(isOrg ? [
            { key: 'late_fee_enabled', label: 'Add a late fee', type: 'switch', hint: 'Only where your terms allow it. It is added once, as its own charge with its own invoice, in the currency below.' },
            { key: 'late_fee_currency', label: 'Late fee currency', type: 'currency', show: (v) => v.late_fee_enabled }, { key: 'late_fee_minor', label: 'Late fee', type: 'money', currency: (v) => v.late_fee_currency ?? 'GBP', show: (v) => v.late_fee_enabled },
            { key: 'late_fee_after_days', label: 'After how many days late', type: 'stepper', min: 1, max: 90, show: (v) => v.late_fee_enabled },
            { key: 'late_fee_basis', label: 'Where your terms allow it', hint: 'The clause or policy the fee rests on (required).', show: (v) => v.late_fee_enabled },
            { key: 'suspension_enabled', label: 'Pause access for non-payment', type: 'switch', hint: 'Pauses check-in and passes for future sessions only. It never removes the enrolment, attendance history or health and safety records, and is lifted when the money is paid or waived.' },
            { key: 'suspend_after_days', label: 'Pause after how many days late', type: 'stepper', min: 1, max: 90, show: (v) => v.suspension_enabled },
          ] : []),
        ]}
        onSubmit={async (v) => {
          const body = { ...target, reminder_offsets: v.reminder_offsets, grace_days: v.grace_days, retry_days: v.retry_days ?? [], escalate_after_days: v.escalate_after_days };
          if (isOrg) Object.assign(body, { late_fee_enabled: !!v.late_fee_enabled, suspension_enabled: !!v.suspension_enabled, ...(v.late_fee_enabled ? { late_fee_minor: v.late_fee_minor, late_fee_currency: v.late_fee_currency, late_fee_after_days: v.late_fee_after_days, late_fee_basis: v.late_fee_basis } : {}), ...(v.suspension_enabled ? { suspend_after_days: v.suspend_after_days } : {}) });
          await api.patch('/collections/policy', body); p.reload(); return 'Policy saved';
        }} />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ report
function ReportTab({ target }) {
  const [from, setFrom] = useState(plusDays(todayStr(), -90)), [to, setTo] = useState(todayStr()), [asOf, setAsOf] = useState(todayStr());
  const r = useLoad(() => api.get('/collections/report', { organisation_id: target.organisation_id, from, to, as_of: asOf }), [target.organisation_id, from, to, asOf]);
  return (
    <View style={{ gap: 12 }}>
      <Panel>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 150 }}><DateField label="From" value={from} onChange={setFrom} max={to} /></View>
          <View style={{ flex: 1, minWidth: 150 }}><DateField label="To" value={to} onChange={setTo} min={from} /></View>
          <View style={{ flex: 1, minWidth: 150 }}><DateField label="Still owed as of" value={asOf} onChange={setAsOf} max={todayStr()} /></View>
        </View>
        <T size={12} color={c.mute}>Each currency is reported on its own and never added to another. Every figure comes from charges, receipts, adjustments and payments.</T>
        {r.data ? <Tag label={r.data.reconciles ? '✅ Reconciles to receipts, payments and invoices' : '⚠️ Does not reconcile — see the checks'} color={r.data.reconciles ? c.lime : c.orangeSoft} style={{ alignSelf: 'flex-start' }} /> : null}
        {r.data && !r.data.reconciles ? <T size={12}>{Object.entries(r.data.checks).filter(([, v]) => v).map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`).join(' · ')}</T> : null}
      </Panel>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data ? <Loading /> : !r.data.currencies.length ? <Panel><Empty emoji="📊" title="Nothing to report yet" sub="Figures appear once charges are raised." /></Panel> : r.data.currencies.map((x) => {
        const k = x.currency, M = (v) => moneyIn(v, k);
        return (
          <Panel key={k}>
            <Block title={`${k} collections`}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Kpi label="Billed" value={M(x.billed_minor)} sub="charges due in the period" />
                <Kpi label="Collected" value={M(x.collected_minor)} sub={x.collection_rate_pct == null ? null : `${x.collection_rate_pct}% of billed`} />
                <Kpi label="Still owed" value={M(x.outstanding_minor)} sub={`${M(x.overdue_minor)} overdue`} tone={x.overdue_minor ? 'alert' : undefined} />
                <Kpi label="Waived or reduced" value={M(x.waived_minor + x.conceded_minor)} sub={`waived ${M(x.waived_minor)} · reduced ${M(x.conceded_minor)}`} />
              </View>
              <Bars label={`Ageing in ${k}`} rows={[['Not yet due', 'not_yet_due'], ['1–30 days', 'd1_30'], ['31–60 days', 'd31_60'], ['61–90 days', 'd61_90'], ['90+ days', 'd90_plus']].map(([l, b]) => ({ label: l, value: x.buckets[b].amount_minor, text: `${M(x.buckets[b].amount_minor)} · ${x.buckets[b].count}`, tone: b === 'not_yet_due' ? c.cyan : c.orange }))} />
              <Bars label={`Forecast in ${k}`} rows={[['Next 30 days', x.forecast.next_30_minor], ['31–60 days', x.forecast.next_60_minor], ['61–90 days', x.forecast.next_90_minor]].map(([l, v]) => ({ label: l, value: v, text: M(v) }))} />
              <T size={11} color={c.mute}>Forecast is what is scheduled to fall due, not a prediction of cash.{x.scheduled_not_yet_raised_minor ? ` ${M(x.scheduled_not_yet_raised_minor)} more is scheduled but not yet invoiced.` : ''}</T>
              <Fact k="Recovered" v={`${M(x.recovered_minor)} from ${x.recovery_days.cases} late payment${x.recovery_days.cases === 1 ? '' : 's'}${x.recovery_days.average == null ? '' : ` · paid ${x.recovery_days.average} days after the due date on average`}`} />
              <Fact k="Failed payments" v={x.payment_attempts.total ? `${x.payment_attempts.failed} of ${x.payment_attempts.total} (${x.payment_failure_rate_pct}%)` : 'No online payments in the period'} />
              <Fact k="Failed automatic debits" v={x.auto_debit.attempts ? `${x.auto_debit.failed} of ${x.auto_debit.attempts} (${x.auto_debit_failure_rate_pct}%)` : 'None attempted — no payment provider is connected for automatic debit'} />
            </Block>
          </Panel>
        );
      })}
    </View>
  );
}
