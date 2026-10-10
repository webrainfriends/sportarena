// Event planning workspace: contact and contract everyone an event needs (requests that end in a finalized booking),
// run the budget, and keep the task list. Plus the inbox where teams, referees, venues, suppliers and sponsors answer.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const fail = (toast) => (e) => toast('' + e.message);
const useDo = (toast, refresh) => async (fn, msg) => { try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); refresh?.(); return r; } catch (e) { fail(toast)(e); return null; } };
const KIND = {
  team: ['👥', 'Team'], coach: ['🧑‍🏫', 'Coach'], referee: ['🟨', 'Referee'], umpire: ['🧑‍⚖️', 'Umpire'], judge: ['⚖️', 'Judge'], scorer: ['📝', 'Scorer'], timekeeper: ['⏱️', 'Timekeeper'],
  physio: ['💆', 'Physio'], doctor: ['🩺', 'Doctor'], first_aider: ['⛑️', 'First aider'], volunteer: ['🙋', 'Volunteer'], supplier: ['📦', 'Supplier'], venue: ['🏟️', 'Venue'], insurer: ['🛡️', 'Insurer'], sponsor: ['💎', 'Sponsor'],
};
const GROUPS = [['Teams & people', ['team', 'coach', 'volunteer']], ['Officials', ['referee', 'umpire', 'judge', 'scorer', 'timekeeper']], ['Medical', ['physio', 'doctor', 'first_aider']], ['Services & money', ['venue', 'supplier', 'insurer', 'sponsor']]];
const STATUS_TAG = { draft: c.violetSoft, sent: c.cyanSoft, quoted: c.sunSoft, accepted: c.limeSoft, declined: c.orange, finalized: c.limeSoft, cancelled: c.violetSoft };
const CATS = ['venue', 'officials', 'medical', 'equipment', 'catering', 'insurance', 'marketing', 'prizes', 'staff', 'transport', 'admin', 'contingency', 'sponsorship', 'entry_fees', 'tickets', 'merchandise', 'other'];
const TASK_CATS = ['general', 'venue', 'people', 'officials', 'medical', 'equipment', 'catering', 'insurance', 'sponsors', 'marketing', 'safety', 'finance', 'legal', 'logistics'];
const m = (cents, cur) => moneyIn(Number(cents ?? 0), cur);
const when = (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' });

export function EventPlan({ id }) {
  const { user, has, toast } = useSession();
  const { push } = useNav();
  const [tab, setTab] = useState('overview');
  const ev = useLoad(() => api.get(`/events/${id}`), [id]);
  const plan = useLoad(() => api.get(`/events/${id}/plan`), [id]);
  if (ev.error || plan.error) return <Screen><ErrorBox error={ev.error ?? plan.error} onRetry={() => { ev.reload(); plan.reload(); }} /></Screen>;
  if (!ev.data || !plan.data) return <Screen><Loading /></Screen>;
  const e = ev.data, p = plan.data;
  const P = { id, e, p, toast, push, reload: plan.reload, user, has };
  return (
    <Screen wide>
      <GradCard colors={[c.violet, c.pink]}>
        <T size={40}>{e.banner_emoji}</T>
        <H1 color="#fff" style={{ fontSize: 26 }}>{e.name}</H1>
        <T color="#fff" weight="800">Planning{p.event.days_to_go != null ? ` · ${p.event.days_to_go >= 0 ? `${p.event.days_to_go} days to go` : `${-p.event.days_to_go} days ago`}` : ''}{e.starts_on ? ` · ${day(e.starts_on)}${e.ends_on && e.ends_on !== e.starts_on ? ` – ${day(e.ends_on)}` : ''}` : ''}</T>
      </GradCard>
      <View style={{ marginTop: 10 }}><Seg options={[['overview', 'Overview'], ['venue', 'Venue & courts'], ['requests', 'Contact & book'], ['budget', 'Budget'], ['tasks', 'Tasks']].map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.pink} /></View>
      {tab === 'overview' ? <Overview {...P} go={setTab} /> : tab === 'venue' ? <View style={{ gap: 12, marginTop: 12 }}><EventVenues e={e} toast={toast} onChange={plan.reload} /></View> : tab === 'requests' ? <Requests {...P} /> : tab === 'budget' ? <Budget {...P} /> : <Tasks {...P} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ id, p, toast, push, reload, go }) {
  const s = p.budget.summary;
  const done = useDo(toast, reload);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
        <StatPill value={p.requests.total} label="REQUESTS" /><StatPill value={p.tasks.open} label="TASKS OPEN" color={p.tasks.overdue ? c.sun : c.paper} />
        <StatPill value={p.tasks.overdue} label="OVERDUE" /><StatPill value={s.cap_used_pct != null ? `${s.cap_used_pct}%` : '—'} label="OF BUDGET CAP" />
      </View>
      {p.event.multi_sport ? <Btn title="Open the games programme (sports, teams, timetable)" color={c.violet} style={{ marginTop: 12 }} onPress={() => push('Games', { id })} /> : null}
      {p.requests.waiting_for_you.length ? (
        <Section title="Waiting for you to finalize" color={c.sun}>
          {p.requests.waiting_for_you.map((r) => <Row key={r.id} left={<T size={24}>{KIND[r.kind]?.[0]}</T>} title={r.title} sub={`${r.target} · ${r.status}${r.quote_cents != null ? ` · quoted ${m(r.quote_cents, s.currency)}` : r.offer_cents ? ` · offer ${m(r.offer_cents, s.currency)}` : ''}`} color={c.sunSoft} onPress={() => go('requests')} />)}
        </Section>
      ) : null}
      <Section title="What is missing" color={c.orange}>
        {p.todo.length ? p.todo.map((t) => <Row key={t} title={t} onPress={/venue/i.test(t) ? () => go('venue') : /request/i.test(t) ? () => go('requests') : /budget/i.test(t) ? () => go('budget') : undefined} />) : <Empty emoji="✅" title="Nothing missing" sub="Venue, cover, crew and budget are in place." />}
      </Section>
      <Section title="Budget at a glance" color={c.mint}>
        <Row title={`Spend forecast ${m(s.expense.forecast_cents, s.currency)}`} sub={`paid ${m(s.expense.paid_cents, s.currency)} · still to pay ${m(s.expense.still_to_pay_cents, s.currency)}`} />
        <Row title={`Income forecast ${m(s.income.forecast_cents, s.currency)}`} sub={`received ${m(s.income.received_cents, s.currency)}`} />
        <Row title={`Net forecast ${m(s.net_forecast_cents, s.currency)}`} sub={s.spend_cap_cents ? `cap ${m(s.spend_cap_cents, s.currency)}` : 'No spend cap set'} color={s.net_forecast_cents < 0 ? c.sunSoft : c.limeSoft} />
        {p.budget.alerts.slice(0, 3).map((a, i) => <T key={i} size={12} color={a.level === 'red' ? c.red : c.mute}>• {a.text}</T>)}
      </Section>
      <Section title="Planning checklist" color={c.cyan}>
        <T color={c.mute} size={13}>{p.tasks.done} done · {p.tasks.open} open{p.tasks.blocked ? ` · ${p.tasks.blocked} blocked` : ''}</T>
        <Btn small title="Create the standard checklist" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => done(() => api.post(`/events/${id}/tasks/checklist`), (r) => `${r.created} task(s) added, dated from the start date`)} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ requests
function Requests({ id, e, p, toast, reload }) {
  const [filter, setFilter] = useState(null), [contact, setContact] = useState(false), [open, setOpen] = useState(null);
  const list = useLoad(() => api.get(`/events/${id}/requests`, { kind: filter ?? undefined, limit: 100 }), [id, filter]);
  const refresh = () => { list.reload(); reload(); };
  const kinds = [...new Set((list.data ?? []).map((r) => r.kind))];
  return (
    <>
      <View style={{ marginTop: 12 }}><Btn title="Contact someone" onPress={() => setContact(true)} /></View>
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>Invite teams, coaches, referees and medical staff; ask venues, suppliers and insurers for quotes; ask sponsors for support. Answers arrive here — you finalize.</T>
      {kinds.length > 1 || filter ? <View style={{ marginTop: 8 }}><Seg options={[{ value: null, label: 'All' }, ...kinds.map((k) => ({ value: k, label: `${KIND[k]?.[0]} ${KIND[k]?.[1]}` }))]} value={filter} onChange={setFilter} color={c.pink} /></View> : null}
      <Section title="Requests" color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((r) => (
          <Row key={r.id} left={<T size={26}>{KIND[r.kind]?.[0]}</T>} title={`${r.target_name}`} onPress={() => setOpen(r)}
            sub={`${r.title}${r.quote_cents != null ? ` · quote ${m(r.quote_cents, r.currency)}` : r.offer_cents ? ` · offer ${m(r.offer_cents, r.currency)}` : ''}${r.messages ? ` · ${r.messages} msg` : ''}`}
            right={<Tag label={r.status} color={STATUS_TAG[r.status]} />} />
        )) : <Empty emoji="📨" title="No requests yet" sub="Tap Contact someone to invite a team, hire a referee or ask a venue for a quote." />}
      </Section>
      {contact ? <ContactSheet id={id} e={e} onClose={() => setContact(false)} onSent={refresh} toast={toast} /> : null}
      {open ? <RequestSheet r={open} cur={p.budget.summary.currency} onClose={() => { setOpen(null); refresh(); }} toast={toast} organiser /> : null}
    </>
  );
}

function ContactSheet({ id, e, onClose, onSent, toast }) {
  const [kind, setKind] = useState(null), [q, setQ] = useState(''), [target, setTarget] = useState(null);
  const disc = useLoad(() => api.get(`/events/${id}/disciplines`).catch(() => []), [id]);
  const sports = useLoad(() => api.get('/sports'), []);
  const found = useLoad(() => (kind && !target ? api.get(`/events/${id}/partners`, { kind, q: q || undefined, limit: 30 }) : Promise.resolve([])), [kind, q, target]);
  const sportOpts = (disc.data?.length ? disc.data.map((d) => ({ value: d.sport, label: `${d.emoji} ${d.name}` })) : (sports.data ?? []).filter((s) => s.id === e.sport_id).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` })));
  const [k0, label0] = kind ? KIND[kind] : [];
  const usesDates = ['venue', 'insurer', 'sponsor'].includes(kind);
  return (
    <Sheet visible onClose={onClose} title={target ? `${label0}: ${target.name}` : 'Contact someone'}>
      {!kind ? GROUPS.map(([g, ks]) => (
        <View key={g} style={{ gap: 6 }}><T weight="800" size={13}>{g}</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{ks.map((k) => <Chip key={k} label={`${KIND[k][0]} ${KIND[k][1]}`} onPress={() => setKind(k)} />)}</View></View>
      )) : !target ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Chip label={`${k0} ${label0}  ✕`} active onPress={() => setKind(null)} /></View>
          <Field value={q} onChangeText={setQ} placeholder={`Search ${label0.toLowerCase()}…`} />
          <T size={12} color={c.mute}>{['venue'].includes(kind) ? 'Only venues with courts or grounds for this event\'s sports.' : kind === 'insurer' ? 'Insurers taking quote requests.' : kind === 'team' ? 'Teams in this event\'s sports.' : ['referee', 'umpire', 'judge', 'timekeeper'].includes(kind) ? 'Referees registered for this event\'s sports.' : ''}</T>
          {found.loading ? <Loading /> : (found.data ?? []).length ? found.data.map((x) => (
            <Row key={x.id} left={<T size={24}>{x.emoji ?? k0}</T>} title={x.name} sub={`${x.city ?? ''}${x.from_rate_cents ? ` ${x.city ? '· ' : ''}from ${m(x.from_rate_cents)}` : ''}${x.entered ? ' · already entered' : x.already_asked ? ' · already asked' : ''}`}
              onPress={x.entered ? undefined : () => setTarget(x)} right={x.already_asked ? <Tag label="asked" /> : null} />
          )) : <Empty emoji="🔎" title="No match" sub="Try another search." />}
        </>
      ) : (
        <FormSheet inline visible onClose={onClose} title="" onBack={() => setTarget(null)}
          fields={[{ key: 'title', label: 'What is this for?', optional: true, placeholder: `${label0} — ${e.name}` },
            ...(usesDates ? [{ key: 'from', toKey: 'to', label: 'Dates', type: 'daterange', optional: true }] : []),
            ...(['venue', 'referee', 'umpire', 'judge', 'timekeeper'].includes(kind) && sportOpts.length ? [{ key: 'sports', label: 'For which sports', type: 'multi', options: sportOpts, optional: true }] : []),
            ...(['supplier', 'insurer', 'sponsor', 'volunteer', 'team'].includes(kind) ? [{ key: 'quantity', label: kind === 'insurer' ? 'People to cover' : kind === 'volunteer' ? 'How many people' : kind === 'supplier' ? 'Quantity' : 'Number', type: 'stepper', min: 1, max: 100000, default: 1 }] : []),
            { key: 'offer', label: kind === 'sponsor' ? 'What you ask for' : kind === 'team' ? 'Entry fee' : 'What you offer to pay', type: 'money', currency: e.currency ?? 'INR', optional: true, hint: kind === 'insurer' ? 'The insurer replies with quotes in the insurance module.' : 'Leave blank to let them quote.' },
            { key: 'message', label: 'Message', type: 'multiline', optional: true }]}
          submitLabel="Send request"
          onSubmit={async (v) => {
            const body = { kind, [{ team: 'team_id', venue: 'venue_id', sponsor: 'sponsor_id', insurer: 'insurer_id' }[kind] ?? 'user_id']: target.id, title: v.title || undefined, message: v.message || undefined, sports: v.sports?.length ? v.sports : undefined, starts_on: v.from, ends_on: v.to, quantity: v.quantity > 1 || ['supplier', 'insurer', 'volunteer'].includes(kind) ? v.quantity : undefined, offer_cents: v.offer };
            await api.post(`/events/${id}/requests`, body);
            onSent(); return 'Request sent';
          }} />
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ one request (organiser or recipient)
export function RequestSheet({ r, cur, onClose, toast, organiser }) {
  const det = useLoad(() => api.get(`/event-requests/${r.id}`), [r.id]);
  const [msg, setMsg] = useState(''), [quote, setQuote] = useState(false), [fin, setFin] = useState(false);
  const d = det.data ?? r;
  const refresh = () => det.reload();
  const done = useDo(toast, refresh);
  const live = ['sent', 'quoted'].includes(d.status);
  return (
    <Sheet visible onClose={onClose} title={`${KIND[d.kind]?.[0]} ${d.target_name ?? d.title}`}>
      <T weight="800">{d.title}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Tag label={d.status} color={STATUS_TAG[d.status]} />{d.starts_on ? <Tag label={`${when(d.starts_on)}${d.ends_on && d.ends_on !== d.starts_on ? ` – ${when(d.ends_on)}` : ''}`} /> : null}
        {d.offer_cents != null ? <Tag label={`offer ${m(d.offer_cents, d.currency)}`} /> : null}{d.quote_cents != null ? <Tag label={`quote ${m(d.quote_cents, d.currency)}`} color={c.sunSoft} /> : null}
      </View>
      {d.message ? <T color={c.mute}>{d.message}</T> : null}
      {d.quote_note ? <T size={13}>Quote note: {d.quote_note}{d.quote_valid_until ? ` (valid until ${when(d.quote_valid_until)})` : ''}</T> : null}
      {d.insurance ? <T size={13}>Insurance: {d.insurance.offers} quote(s) received{d.insurance.accepted_total_cents != null ? ` · accepted ${m(d.insurance.accepted_total_cents, d.currency)}` : ''}. Compare and accept quotes in the Insurance desk.</T> : null}
      {(d.thread ?? []).map((t) => <View key={t.id} style={{ borderLeftWidth: 3, borderLeftColor: c.line, paddingLeft: 10 }}><T size={12} color={c.mute}>{t.sender} · {when(t.created_at)}</T><T>{t.body}</T></View>)}
      {d.status !== 'draft' && d.status !== 'cancelled' && d.status !== 'finalized' && d.status !== 'declined' ? (
        <View style={{ gap: 6 }}><Field value={msg} onChangeText={setMsg} placeholder="Write a message…" /><Btn small title="Send message" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={async () => { if (!msg.trim()) return; await done(() => api.post(`/event-requests/${r.id}/messages`, { body: msg.trim() }), 'Sent'); setMsg(''); }} /></View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {organiser && d.status === 'draft' ? <Btn small title="Send" onPress={() => done(() => api.post(`/event-requests/${r.id}/send`), 'Sent')} /> : null}
        {organiser && ['accepted', 'quoted'].includes(d.status) ? <Btn small title="Finalize booking" color={c.lime} onPress={() => setFin(true)} /> : null}
        {organiser && !['finalized', 'cancelled', 'declined'].includes(d.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => done(() => api.post(`/event-requests/${r.id}/cancel`), 'Withdrawn')} /> : null}
        {!organiser && live && d.status === 'sent' ? <Btn small title="Accept" color={c.lime} onPress={() => done(() => api.post(`/event-requests/${r.id}/respond`, { response: 'accept' }), 'Accepted')} /> : null}
        {!organiser && live ? <Btn small title="Send a quote" color={c.cyan} onPress={() => setQuote(true)} /> : null}
        {!organiser && live ? <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => done(() => api.post(`/event-requests/${r.id}/respond`, { response: 'decline' }), 'Declined')} /> : null}
      </View>
      <FormSheet visible={quote} onClose={() => setQuote(false)} title="Your quote" submitLabel="Send quote"
        fields={[{ key: 'quote', label: 'Amount', type: 'money', currency: d.currency }, { key: 'note', label: 'What it includes', type: 'multiline', optional: true }, { key: 'valid', label: 'Valid until', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/event-requests/${r.id}/respond`, { response: 'quote', quote_cents: v.quote, quote_note: v.note, quote_valid_until: v.valid }); refresh(); return 'Quote sent'; }} />
      <FormSheet visible={fin} onClose={() => setFin(false)} title="Finalize the booking" submitLabel="Confirm" initial={{ amount: d.quote_cents ?? d.offer_cents ?? undefined }}
        fields={[{ key: 'amount', label: 'Agreed amount', type: 'money', currency: d.currency, optional: true, hint: 'It is committed to the budget, and the booking takes effect (team enters, crew joins, sponsor becomes active…).' }]}
        onSubmit={async (v) => { await api.post(`/event-requests/${r.id}/finalize`, v.amount !== undefined ? { amount_cents: v.amount } : {}); refresh(); return 'Booking confirmed'; }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ budget
function Budget({ id, p, toast, reload }) {
  const b = useLoad(() => api.get(`/events/${id}/budget`), [id]);
  const [add, setAdd] = useState(false), [rules, setRules] = useState(false), [line, setLine] = useState(null);
  const refresh = () => { b.reload(); reload(); };
  if (b.error) return <ErrorBox error={b.error} onRetry={b.reload} />;
  if (!b.data) return <Loading />;
  const { summary: s, lines, alerts, settings } = b.data, cur = s.currency;
  const exportCsv = async () => {
    try { const r = await api.get(`/events/${id}/budget/export`); if (typeof document !== 'undefined') { const u = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = r.filename; l.click(); URL.revokeObjectURL(u); } toast(`${r.rows} lines exported`); } catch (x) { fail(toast)(x); }
  };
  const bar = (paid, total) => (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden', marginTop: 6 }}><View style={{ height: 6, width: `${Math.min(100, total ? (paid / total) * 100 : 0)}%`, backgroundColor: paid > total ? c.red : c.lime }} /></View>
  );
  const group = (dir) => lines.filter((l) => l.direction === dir);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <Btn small title="Add a line" onPress={() => setAdd(true)} /><Btn small title="Rules & cap" color={c.violet} onPress={() => setRules(true)} /><Btn small title="Export CSV" color={c.paper} ink={c.ink} onPress={exportCsv} />
      </View>
      {alerts.map((a, i) => <T key={i} size={13} weight="700" color={a.level === 'red' ? c.red : a.level === 'amber' ? c.sun : c.mute} style={{ marginTop: 6 }}>{a.level === 'red' ? '⛔' : a.level === 'amber' ? '⚠️' : 'ℹ️'} {a.text}</T>)}
      <Section title="Position" color={c.mint}>
        <Row title={`Net forecast ${m(s.net_forecast_cents, cur)}`} sub={`Income ${m(s.income.forecast_cents, cur)} − spend ${m(s.expense.forecast_cents, cur)}${s.contingency_cents ? ` − contingency ${m(s.contingency_cents, cur)}` : ''}`} color={s.net_forecast_cents < 0 ? c.sunSoft : c.limeSoft} />
        <Row title={`Cash so far ${m(s.net_cash_cents, cur)}`} sub={`received ${m(s.income.received_cents, cur)} · paid out ${m(s.expense.paid_cents, cur)}`} />
        {s.spend_cap_cents ? <Row title={`${s.cap_used_pct}% of the ${m(s.spend_cap_cents, cur)} cap`} sub={`still to pay ${m(s.expense.still_to_pay_cents, cur)}`} /> : null}
        {s.suggested_entry_fee_income_cents ? <Row title={`${s.entries_accepted} entries × fee = ${m(s.suggested_entry_fee_income_cents, cur)}`} sub="Add it as an income line to include it in the forecast" /> : null}
      </Section>
      {['expense', 'income'].map((dir) => (
        <Section key={dir} title={dir === 'expense' ? 'Spend' : 'Income'} color={dir === 'expense' ? c.orange : c.lime}>
          {group(dir).length ? group(dir).map((l) => {
            const fc = Math.max(l.committed_cents || l.planned_cents, l.paid_cents);
            return (
              <Row key={l.id} title={l.name} onPress={() => setLine(l)} sub={`${l.category.replace('_', ' ')} · plan ${m(l.planned_cents, cur)}${l.committed_cents ? ` · agreed ${m(l.committed_cents, cur)}` : ''} · ${dir === 'expense' ? 'paid' : 'received'} ${m(l.paid_cents, cur)}${l.status === 'closed' ? ' · closed' : ''}`}
                right={<T weight="800">{m(fc, cur)}</T>} />
            );
          }) : <Empty emoji={dir === 'expense' ? '🧾' : '💰'} title={`No ${dir} lines`} sub="Add one, or finalize a booking and it appears here." />}
        </Section>
      ))}
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Budget line" submitLabel="Add" initial={{ direction: 'expense', category: 'venue' }}
        fields={[{ key: 'direction', label: 'Type', type: 'choice', options: [{ value: 'expense', label: 'Spend' }, { value: 'income', label: 'Income' }] }, { key: 'category', label: 'Category', type: 'chips', options: CATS }, { key: 'name', label: 'Name', placeholder: 'e.g. Trophies and medals' }, { key: 'planned', label: 'Planned amount', type: 'money', currency: cur }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/budget/lines`, { direction: v.direction, category: v.category, name: v.name, planned_cents: v.planned }); refresh(); return 'Line added'; }} />
      <FormSheet visible={rules} onClose={() => setRules(false)} title="Budget rules" initial={{ cap: settings.spend_cap_cents == null ? undefined : Number(settings.spend_cap_cents), contingency_pct: settings.contingency_pct }}
        fields={[{ key: 'cap', label: 'Approved spend cap', type: 'money', currency: cur, optional: true }, { key: 'contingency_pct', label: 'Hold back for surprises', type: 'stepper', min: 0, max: 100, step: 5, suffix: '%' }]}
        onSubmit={async (v) => { await api.patch(`/events/${id}/budget`, { spend_cap_cents: v.cap ?? null, contingency_pct: v.contingency_pct }); refresh(); return 'Saved'; }} />
      {line ? <LineSheet l={line} cur={cur} payments={b.data.payments.filter((x) => x.line_id === line.id)} toast={toast} onClose={() => { setLine(null); refresh(); }} /> : null}
    </>
  );
}

function LineSheet({ l, cur, payments, toast, onClose }) {
  const [pay, setPay] = useState(false), [edit, setEdit] = useState(false);
  const done = useDo(toast, onClose);
  const incoming = l.direction === 'income';
  return (
    <Sheet visible onClose={onClose} title={l.name}>
      <T color={c.mute}>{l.category.replace('_', ' ')} · plan {m(l.planned_cents, cur)}{l.committed_cents ? ` · agreed ${m(l.committed_cents, cur)}` : ''} · {incoming ? 'received' : 'paid'} {m(l.paid_cents, cur)}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {l.status !== 'closed' ? <Btn small title={incoming ? 'Record money received' : 'Record a payment'} onPress={() => setPay(true)} /> : null}
        <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setEdit(true)} />
        {l.status !== 'closed' ? <Btn small title="Close line" color={c.paper} ink={c.ink} onPress={() => done(() => api.patch(`/budget-lines/${l.id}`, { status: 'closed' }), 'Closed')} /> : null}
      </View>
      {payments.map((x) => (
        <Row key={x.id} title={`${m(x.amount_cents, cur)} · ${when(x.paid_on)}`} sub={`${x.method ?? ''}${x.reference ? ` · ${x.reference}` : ''}${x.note ? ` · ${x.note}` : ''}`} right={<Btn small title="Void" color={c.paper} ink={c.red} onPress={() => done(() => api.post(`/budget-payments/${x.id}/void`, { reason: 'Entered in error' }), 'Voided — kept on record')} />} />
      ))}
      <FormSheet visible={pay} onClose={() => setPay(false)} title={incoming ? 'Money received' : 'Payment'} submitLabel="Record" initial={{ method: 'bank' }}
        fields={[{ key: 'amount', label: 'Amount', type: 'money', currency: cur }, { key: 'paid_on', label: 'Date', type: 'date', optional: true }, { key: 'method', label: 'How', type: 'chips', options: ['cash', 'bank', 'card', 'upi', 'cheque', 'other'] }, { key: 'reference', label: 'Reference / receipt no.', optional: true }]}
        onSubmit={async (v) => { await api.post(`/budget-lines/${l.id}/payments`, { amount_cents: v.amount, paid_on: v.paid_on, method: v.method, reference: v.reference }); onClose(); return 'Recorded'; }} />
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit line" initial={{ name: l.name, category: l.category, planned: l.planned_cents }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'category', label: 'Category', type: 'chips', options: CATS }, { key: 'planned', label: 'Planned amount', type: 'money', currency: cur }]}
        onSubmit={async (v) => { await api.patch(`/budget-lines/${l.id}`, { name: v.name, category: v.category, planned_cents: v.planned }); onClose(); return 'Saved'; }} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ tasks
function Tasks({ id, toast, reload }) {
  const [filter, setFilter] = useState('open'), [add, setAdd] = useState(false);
  const list = useLoad(() => api.get(`/events/${id}/tasks`), [id]);
  const refresh = () => { list.reload(); reload(); };
  const done = useDo(toast, refresh);
  const rows = (list.data ?? []).filter((t) => (filter === 'open' ? !['done', 'dropped'].includes(t.status) : filter === 'done' ? t.status === 'done' : filter === 'overdue' ? t.overdue : true));
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="Add a task" onPress={() => setAdd(true)} />
        <Btn small title="Standard checklist" color={c.paper} ink={c.ink} onPress={() => done(() => api.post(`/events/${id}/tasks/checklist`), (r) => `${r.created} added`)} />
      </View>
      <View style={{ marginTop: 8 }}><Seg options={[{ value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} value={filter} onChange={setFilter} color={c.pink} /></View>
      <Section title="Tasks" color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : rows.length ? rows.map((t) => (
          <Row key={t.id} title={`${t.status === 'done' ? '✅ ' : t.priority === 'high' ? '🔺 ' : ''}${t.title}`} color={t.overdue ? c.sunSoft : c.paper}
            sub={`${t.category}${t.due_on ? ` · due ${when(t.due_on)}` : ''}${t.owner ? ` · ${t.owner}` : ''}${t.status !== 'todo' && t.status !== 'done' ? ` · ${t.status}` : ''}`}
            right={t.status !== 'done' ? <Btn small title="Done" color={c.lime} onPress={() => done(() => api.patch(`/event-tasks/${t.id}`, { status: 'done' }), 'Done')} /> : <Btn small title="Reopen" color={c.paper} ink={c.ink} onPress={() => done(() => api.patch(`/event-tasks/${t.id}`, { status: 'todo' }), 'Reopened')} />} />
        )) : <Empty emoji="📋" title={filter === 'open' ? 'Nothing open' : 'Nothing here'} sub="Create the standard checklist to start from the usual steps." />}
      </Section>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="New task" submitLabel="Add" initial={{ category: 'general', priority: 'normal' }}
        fields={[{ key: 'title', label: 'Task' }, { key: 'category', label: 'Category', type: 'chips', options: TASK_CATS }, { key: 'due_on', label: 'Due', type: 'date', optional: true }, { key: 'priority', label: 'Priority', type: 'choice', options: ['low', 'normal', 'high'] }, { key: 'notes', label: 'Notes', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/events/${id}/tasks`, v); refresh(); return 'Task added'; }} />
    </>
  );
}

// ------------------------------------------------------------------ inbox: requests addressed to me
export function EventInbox() {
  const { toast } = useSession();
  const [open, setOpen] = useState(null), [status, setStatus] = useState(null);
  const list = useLoad(() => api.get('/me/event-requests', { status: status ?? undefined, limit: 100 }), [status]);
  return (
    <Screen>
      <H1>Event requests</H1>
      <T color={c.mute} style={{ marginTop: 4 }}>Invitations, hires and quote requests from events — for you, or for a team, venue or sponsor you run.</T>
      <View style={{ marginTop: 8 }}><Seg options={[{ value: null, label: 'All' }, { value: 'sent', label: 'To answer' }, { value: 'quoted', label: 'Quoted' }, { value: 'finalized', label: 'Confirmed' }]} value={status} onChange={setStatus} color={c.pink} /></View>
      <Section title="Inbox" color={c.cyan}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : list.data.length ? list.data.map((r) => (
          <Row key={r.id} left={<T size={26}>{KIND[r.kind]?.[0]}</T>} title={`${r.event}`} sub={`${r.title}${r.offer_cents ? ` · offer ${m(r.offer_cents, r.currency)}` : ''}${r.event_starts_on ? ` · ${when(r.event_starts_on)}` : ''}`} right={<Tag label={r.status} color={STATUS_TAG[r.status]} />} onPress={() => setOpen(r)} />
        )) : <Empty emoji="📭" title="Nothing here" sub="When an organiser contacts you it appears here." />}
      </Section>
      {open ? <RequestSheet r={open} cur={open.currency} toast={toast} onClose={() => { setOpen(null); list.reload(); }} /> : null}
    </Screen>
  );
}
