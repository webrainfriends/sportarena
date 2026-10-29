// Buyer procurement (#458): plan services for an event, school / academy or venue, request and compare quotes, approve and award, place and confirm
// orders, accept delivered work, match invoices and pay. One component serves every context (the event console embeds it) so there is one place for it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { c } from '../theme';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Sheet, T } from '../ui';
import { localToIso } from '../vtime';
import { useDo } from './console-utils';
import { ChainTrace, DocButton, ExportsPanel, Kpi, Kv, Note, PerformanceRecord, Status, Tabs, Wrap, catLabel, collectScope, day, label, money, scopeFields, useCatalogue, when } from './svc-common';

const TABS = [['plan', 'Plan'], ['rfqs', 'Quotes'], ['orders', 'Orders'], ['invoices', 'Invoices'], ['team', 'People & policy'], ['reports', 'Reports']];

export function ServicesBuyer({ event_id, venue_id, organisation_id, embedded }) {
  const cat = useCatalogue();
  const mine = useLoad(() => api.get('/me/service-buyers'), [event_id, venue_id, organisation_id]);
  const [tab, setTab] = useState('plan'), [setup, setSetup] = useState(false);
  const act = useDo(mine.reload);
  if (!cat || mine.loading) return embedded ? <Loading /> : <Screen><Loading /></Screen>;
  const b = (mine.data ?? []).find((x) => (event_id ? x.event_id === event_id : venue_id ? x.venue_id === venue_id : organisation_id ? x.organisation_id === organisation_id && !x.event_id && !x.venue_id : !x.event_id && !x.venue_id && !x.organisation_id));
  const Wrapper = embedded ? View : Screen;
  const open = (currency) => act(() => api.post('/service-buyers', { ...(event_id ? { event_id } : venue_id ? { venue_id } : organisation_id ? { organisation_id } : {}), ...(currency ? { currency } : {}) }), 'Procurement is set up');
  return (
    <Wrapper style={embedded ? { gap: 12, paddingTop: 12 } : undefined}>
      {embedded ? null : <H1>Services & suppliers</H1>}
      {mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : !b ? (
        <Card><T weight="800">Buy services for {event_id ? 'this event' : venue_id ? 'this venue' : organisation_id ? 'your school or academy' : 'yourself'}</T>
          <Note>Plan what you need — groundsmen, pool care, ball crew, power and Wi-Fi, travel, rooms — request quotes, compare, approve and pay in one place.</Note>
          <Btn title="Set up procurement" onPress={() => (event_id || venue_id ? open() : setSetup(true))} style={{ marginTop: 10, alignSelf: 'flex-start' }} /></Card>
      ) : (
        <>
          <T size={13} color={c.mute}>{b.name} · {b.currency} · your roles: {b.my_roles.join(', ')}</T>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          {tab === 'plan' ? <Plan b={b} cat={cat} event_id={event_id} /> : null}
          {tab === 'rfqs' ? <Rfqs b={b} cat={cat} /> : null}
          {tab === 'orders' ? <Orders b={b} cat={cat} /> : null}
          {tab === 'invoices' ? <Invoices b={b} /> : null}
          {tab === 'team' ? <Team b={b} /> : null}
          {tab === 'reports' ? <Reports b={b} /> : null}
        </>
      )}
      <FormSheet visible={setup} onClose={() => setSetup(false)} title="Which currency do you buy in?" fields={[{ key: 'currency', label: 'Currency', type: 'currency', endpoint: '/service-currencies' }]} onSubmit={async (v) => { await open(v.currency); setSetup(false); }} />
    </Wrapper>
  );
}

const CREDENTIALS = ['insurance', 'electrical', 'pool_operator', 'first_aid', 'safeguarding', 'vehicle', 'food_safety', 'business_registration', 'other'].map((k) => ({ value: k, label: label(k).replace(/^./, (x) => x.toUpperCase()) }));
const loadCompetitions = async (q) => (await api.get('/events', { q: q || undefined, limit: 20 })).map((e) => ({ value: e.id, label: e.name, sub: [e.kind, String(e.starts_on ?? '').slice(0, 10)].filter(Boolean).join(' · ') }));

function Plan({ b, cat }) {
  const plan = useLoad(() => api.get(`/service-buyers/${b.id}/plan`), [b.id]);
  const reqs = useLoad(() => api.get(`/service-buyers/${b.id}/requirements`, { limit: 100 }), [b.id]);
  const lots = useLoad(() => api.get(`/service-buyers/${b.id}/lots`, { limit: 100 }), [b.id]);
  const act = useDo(() => { plan.reload(); reqs.reload(); lots.reload(); });
  const [form, setForm] = useState(null);
  const tz = b.timezone || 'UTC';
  const fields = [
    { key: 'category', label: 'Service', type: 'chips', options: cat.categories.map((k) => ({ value: k.slug, label: k.label })) },
    { key: 'title', label: 'What exactly' },
    ...(lots.data?.length ? [{ key: 'lot_id', label: 'Lot', type: 'chips', options: lots.data.map((l) => ({ value: l.id, label: l.name })), optional: true }] : []),
    { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'unit', label: 'Priced per', type: 'chips', options: (v) => (cat.categories.find((k) => k.slug === v.category)?.units ?? []).map((u) => ({ value: u, label: label(u) })) },
    { key: 'headcount', label: 'People needed', type: 'stepper', min: 0, max: 10000, default: 0, optional: true },
    { key: 'from', label: 'Dates', type: 'daterange', toKey: 'to', optional: true }, { key: 'start_t', label: 'Start time', type: 'time', optional: true }, { key: 'end_t', label: 'End time', type: 'time', optional: true },
    { key: 'freq', label: 'Repeats', type: 'chips', options: [{ value: 'none', label: 'One-off' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }], default: 'none' },
    { key: 'until', label: 'Repeat until', type: 'date', show: (v) => v.freq && v.freq !== 'none' },
    { key: 'budget', label: 'Budget', type: 'money', currency: b.currency, optional: true }, { key: 'deadline', label: 'Needed ready by', type: 'date', optional: true },
    { key: 'competition', label: 'Competition it supports', type: 'multimenu', max: 1, optional: true, hint: 'Search a league or tournament this work is for', load: loadCompetitions },
    { key: 'compliance', label: 'Credentials the supplier must hold', type: 'multimenu', optional: true, options: CREDENTIALS, hint: 'Checked when they quote and again when you award' },
    { key: 'criteria', label: 'How you will accept it (one measurable check per line)', type: 'multiline', optional: true },
    ...scopeFields(cat, tz),
  ];
  const submit = async (v) => {
    const startD = v.from, endD = v.to ?? v.from;
    await api.post(`/service-buyers/${b.id}/requirements`, { category: v.category, title: v.title, lot_id: v.lot_id, quantity: Number(v.quantity), unit: v.unit, headcount: v.headcount || undefined,
      ...(startD ? { starts_at: localToIso(startD, v.start_t || '08:00', tz), ends_at: localToIso(endD, v.end_t || '18:00', tz) } : {}), timezone: tz,
      ...(v.freq && v.freq !== 'none' ? { recurrence: { freq: v.freq, until: v.until } } : {}), budget_minor: v.budget || undefined, currency: b.currency, deadline: v.deadline,
      competition_id: v.competition?.[0], compliance_kinds: v.compliance ?? [], acceptance_criteria: v.criteria ? String(v.criteria).split('\n').map((x) => x.trim()).filter(Boolean) : [], scope: collectScope(cat, v.category, v, tz) });
    act(async () => null); return 'Requirement saved';
  };
  if (plan.loading) return <Loading />;
  if (plan.error) return <ErrorBox error={plan.error} onRetry={plan.reload} />;
  const p = plan.data;
  return (
    <>
      <Wrap>{p.money.map((m) => <Kpi key={m.currency} title={`${m.currency} · committed`} value={money(m.committed, m.currency)} sub={`est. ${money(m.estimated, m.currency)} · quoted ${money(m.quoted, m.currency)} · invoiced ${money(m.invoiced, m.currency)} · paid ${money(m.paid, m.currency)} · due ${money(m.outstanding, m.currency)}`} />)}</Wrap>
      {p.problems.length ? <Card color={c.sunSoft}>{p.problems.map((x, n) => <T key={n} size={13}>⚠ {x.detail}</T>)}</Card> : null}
      <Wrap><Btn small title="Plan a service" onPress={() => setForm({})} /><Btn small color={c.paper} ink={c.ink} title="Add a lot" onPress={() => setForm('lot')} /></Wrap>
      <Section title="Coverage">
        {reqs.data?.length ? reqs.data.map((r) => {
          const cv = p.coverage.find((x) => x.requirement_id === r.id);
          return <Row key={r.id} title={r.title} sub={`${catLabel(cat, r.category)} · ${Number(r.quantity)} ${label(r.unit)}${r.starts_at ? ` · ${when(r.starts_at)}` : ''}${cv?.lot ? ` · lot ${cv.lot}` : ''}`} right={<><Status s={cv?.flag ?? r.status} />{r.status === 'draft' ? <Btn small title="Request quotes" onPress={() => setForm({ rfq: r })} /> : null}{r.status === 'draft' ? <Btn small color={c.paper} ink={c.ink} title="Copy" onPress={() => act(() => api.post(`/service-requirements/${r.id}/copy`, {}), 'Copied as a draft')} /> : null}</>} />;
        }) : <Empty emoji="📝" title="Nothing planned yet" sub="Break a tournament into lots — pitch preparation, ball crew, Wi-Fi, transport, rooms — and plan each service." />}
      </Section>
      <Note>A maintenance booking records work done; it never certifies a venue as safe.</Note>
      <FormSheet visible={form !== null && form !== 'lot' && !form?.rfq} onClose={() => setForm(null)} title="Plan a service" fields={fields} initial={{}} onSubmit={submit} />
      <FormSheet visible={form === 'lot'} onClose={() => setForm(null)} title="New lot" fields={[{ key: 'name', label: 'Lot name' }, { key: 'budget', label: 'Lot budget', type: 'money', currency: b.currency, optional: true }]} onSubmit={async (v) => { await api.post(`/service-buyers/${b.id}/lots`, { name: v.name, budget_minor: v.budget || undefined }); act(async () => null); return 'Lot added'; }} />
      {form?.rfq ? <RfqCreate b={b} req={form.rfq} cat={cat} onClose={() => setForm(null)} onDone={() => { setForm(null); act(async () => null); }} /> : null}
    </>
  );
}

function RfqCreate({ b, req, cat, onClose, onDone }) {
  const [q, setQ] = useState('');
  const sup = useLoad(() => api.get('/suppliers', { category: req.category, q: q || undefined, limit: 30 }), [req.category, q]);
  const [picked, setPicked] = useState([]), [form, setForm] = useState(false);
  return (
    <Sheet visible onClose={onClose} title={`Request quotes — ${req.title}`}>
      <Note>Pick the suppliers to invite (active suppliers in this category), then set the deadlines.</Note>
      {sup.loading ? <Loading /> : sup.data?.length ? sup.data.map((s) => <Row key={s.id} title={s.trading_name ?? s.legal_name} sub={`${s.categories.map((k) => catLabel(cat, k)).join(', ')}${s.lead_time_days ? ` · lead ${s.lead_time_days}d` : ''}`} right={<Chip label={picked.includes(s.id) ? 'Invited ✓' : 'Invite'} active={picked.includes(s.id)} onPress={() => setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id])} />} />) : <Empty emoji="🔎" title="No suppliers in this category yet" sub="Publish the RFQ to open it to every eligible supplier." />}
      <Btn title={`Continue (${picked.length} invited)`} onPress={() => setForm(true)} />
      <FormSheet visible={form} onClose={() => setForm(false)} title="RFQ details"
        fields={[{ key: 'audience', label: 'Who can quote', type: 'choice', options: [{ value: 'invited', label: 'Only invited' }, { value: 'published', label: 'Any eligible supplier' }] }, { key: 'quote_d', label: 'Quotes due', type: 'date' }, { key: 'quote_t', label: 'Quotes due at', type: 'time' }, { key: 'q_d', label: 'Questions close', type: 'date', optional: true },
          { key: 'price_w', label: 'Price weight (%)', type: 'stepper', min: 0, max: 100, step: 5, default: 60 }, { key: 'quality_w', label: 'Quality weight (%)', type: 'stepper', min: 0, max: 100, step: 5, default: 40 }, { key: 'partial', label: 'Allow awarding part to several suppliers', type: 'switch', default: false }]}
        onSubmit={async (v) => {
          const r = await api.post(`/service-requirements/${req.id}/rfq`, { audience: v.audience, quote_deadline: localToIso(v.quote_d, v.quote_t, b.timezone || 'UTC'), ...(v.q_d ? { question_deadline: localToIso(v.q_d, '12:00', b.timezone || 'UTC') } : {}), rubric: [{ key: 'price', label: 'Price', weight: v.price_w || 1 }, { key: 'quality', label: 'Quality', weight: v.quality_w || 1 }], allow_partial: v.partial });
          if (picked.length) await api.post(`/rfqs/${r.id}/invites`, { profile_ids: picked });
          await api.post(`/rfqs/${r.id}/issue`, {}); onDone(); return 'RFQ issued';
        }} />
    </Sheet>
  );
}

function Rfqs({ b, cat }) {
  const list = useLoad(() => api.get(`/service-buyers/${b.id}/rfqs`, { limit: 50 }), [b.id]);
  const [open, setOpen] = useState(null);
  return (
    <>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((r) => <Row key={r.id} title={r.title} sub={`${catLabel(cat, r.scope.category)} · ${r.responded}/${r.invited} responded${r.quote_deadline ? ` · due ${day(r.quote_deadline)}` : ''}`} right={<Status s={r.status} />} onPress={() => setOpen(r)} />) : <Empty emoji="📨" title="No requests for quotation" sub="Plan a service, then request quotes from suppliers." />}
      {open ? <RfqSheet b={b} id={open.id} cat={cat} onClose={() => { setOpen(null); list.reload(); }} /> : null}
    </>
  );
}

function RfqSheet({ b, id, cat, onClose }) {
  const r = useLoad(() => api.get(`/rfqs/${id}`), [id]);
  const cmp = useLoad(() => api.get(`/rfqs/${id}/comparison`).catch(() => null), [id, r.data?.row_version]);
  const act = useDo(() => { r.reload(); cmp.reload(); });
  const [form, setForm] = useState(null), [sel, setSel] = useState([]);
  const x = r.data;
  if (!x) return <Sheet visible onClose={onClose} title="RFQ">{r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <Loading />}</Sheet>;
  const can = (role) => x.my_roles?.includes(role);
  const open = ['issued', 'quoting', 'evaluation'].includes(x.status);
  return (
    <Sheet visible onClose={onClose} title={x.title}>
      <Wrap><Status s={x.status} /><T size={12} color={c.mute}>scope v{x.scope_version} · {x.currency}</T></Wrap>
      <Wrap><DocButton type="rfq" id={x.id} title="RFQ PDF" /><DocButton type="comparison" id={x.id} title="Comparison PDF" /></Wrap>
      {x.status === 'draft' ? <Btn small title="Issue RFQ" onPress={() => act(() => api.post(`/rfqs/${x.id}/issue`, {}), 'Issued')} style={{ alignSelf: 'flex-start' }} /> : null}
      <Section title="Suppliers">{x.invites.map((i) => <Row key={i.id} title={i.supplier_name} sub={i.reason ?? ''} right={<Status s={i.status} />} />)}</Section>
      <Section title="Compare quotes">
        {cmp.data?.quotes?.length ? cmp.data.quotes.map((q) => (
          <Card key={q.quote_id} pad={12} color={sel.includes(q.quote_id) ? c.mintSoft : c.paper}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800">{q.supplier} · v{q.version}</T><Status s={q.status} /></View>
            <T size={13}>{money(q.net_minor, q.currency)} + tax {money(q.tax_minor, q.currency)} = <T weight="800" size={13}>{money(q.gross_minor, q.currency)}</T></T>
            <T size={12} color={c.mute}>{q.scope_compliant ? 'matches current scope' : 'older scope — re-quote needed'} · {q.available ? 'available' : 'not available on those dates'} · {q.required_credentials_ok ? 'credentials ok' : 'credential expired'}{q.sla ? ` · SLA: ${q.sla}` : ''}{q.evaluation ? ` · score ${q.evaluation.score.toFixed(1)}` : ''}</T>
            <Wrap>
              <DocButton type="quote" id={q.quote_id} title="Quote PDF" />
              {open && can('evaluator') ? <Btn small color={c.paper} ink={c.ink} title="Score" onPress={() => setForm({ score: q })} /> : null}
              {open && ['submitted', 'shortlisted'].includes(q.status) ? <><Btn small color={c.paper} ink={c.ink} title={q.status === 'shortlisted' ? 'Shortlisted ✓' : 'Shortlist'} onPress={() => act(() => api.post(`/quotes/${q.quote_id}/decision`, { decision: 'shortlisted' }))} /><Btn small color={c.paper} ink={c.red} title="Reject" onPress={() => setForm({ reject: q })} />{can('purchaser') ? <Chip label={sel.includes(q.quote_id) ? 'Selected ✓' : 'Select to award'} active={sel.includes(q.quote_id)} onPress={() => setSel(sel.includes(q.quote_id) ? sel.filter((i) => i !== q.quote_id) : [...sel, q.quote_id])} /> : null}</> : null}
            </Wrap>
          </Card>
        )) : <Note>No quotes yet.</Note>}
        {cmp.data ? <Note>Different currencies are shown as quoted and never added together.</Note> : null}
      </Section>
      <Wrap>
        {open && x.status !== 'evaluation' && can('evaluator') ? <Btn small color={c.paper} ink={c.ink} title="Start evaluation" onPress={() => act(() => api.post(`/rfqs/${x.id}/status`, { status: 'evaluation' }))} /> : null}
        {open && can('requester') ? <Btn small color={c.paper} ink={c.ink} title="Change scope" onPress={() => setForm('scope')} /> : null}
        {open && sel.length && can('purchaser') ? <Btn small title={`Award ${sel.length} quote${sel.length > 1 ? 's' : ''}`} onPress={() => setForm('award')} /> : null}
        {['issued', 'quoting', 'evaluation'].includes(x.status) && can('purchaser') ? <Btn small color={c.paper} ink={c.red} title="Cancel RFQ" onPress={() => setForm('cancel')} /> : null}
      </Wrap>
      <Section title="Clarifications">
        {x.clarifications.map((q) => <Card key={q.id} pad={10}><T size={11} color={c.mute}>{q.author_side}{q.shared ? ' · shared with all' : ''}</T><T size={13}>{q.body}</T>{q.author_side === 'supplier' && !x.clarifications.some((a) => a.answers_id === q.id) ? <Btn small color={c.paper} ink={c.ink} title="Answer" onPress={() => setForm({ answer: q })} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}</Card>)}
        {open ? <Btn small color={c.paper} ink={c.ink} title="Post a notice to all suppliers" onPress={() => setForm('notice')} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      <FormSheet visible={!!form?.score} onClose={() => setForm(null)} title={`Score ${form?.score?.supplier ?? ''}`}
        fields={[...(x.rubric ?? []).map((k) => ({ key: `s_${k.key}`, label: `${k.label} (0–10, weight ${k.weight})`, type: 'stepper', min: 0, max: 10, default: 5 })), { key: 'rationale', label: 'Why (kept with the award record)', type: 'multiline' }, { key: 'compliant', label: 'Compliant with the scope', type: 'switch', default: true }]}
        onSubmit={async (v) => { await api.post(`/quotes/${form.score.quote_id}/evaluate`, { scores: Object.fromEntries((x.rubric ?? []).map((k) => [k.key, v[`s_${k.key}`]])), rationale: v.rationale, compliant: v.compliant }); cmp.reload(); return 'Saved'; }} />
      <FormSheet visible={!!form?.reject} onClose={() => setForm(null)} title="Reject quote" fields={[{ key: 'reason', label: 'Reason (shared with that supplier only)', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/quotes/${form.reject.quote_id}/decision`, { decision: 'rejected', reason: v.reason }); act(async () => null); return 'Rejected'; }} />
      <FormSheet visible={form === 'award'} onClose={() => setForm(null)} title="Award" fields={[{ key: 'justification', label: 'Why these suppliers (recorded)', type: 'multiline' }]}
        onSubmit={async (v) => { const o = await api.post(`/rfqs/${x.id}/award`, { row_version: x.row_version, awards: sel.map((quote_id) => ({ quote_id })), justification: v.justification }); setSel([]); act(async () => null); return o.status === 'approval_pending' ? 'Sent for approval — an approver must decide' : 'Awarded — the supplier has been asked to confirm'; }} />
      <FormSheet visible={form === 'cancel'} onClose={() => setForm(null)} title="Cancel RFQ" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/rfqs/${x.id}/status`, { status: 'cancelled', reason: v.reason }); act(async () => null); return 'Cancelled'; }} />
      <FormSheet visible={form === 'notice'} onClose={() => setForm(null)} title="Notice to all suppliers" fields={[{ key: 'body', label: 'Clarification', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/rfqs/${x.id}/clarifications`, { body: v.body, shared: true }); act(async () => null); return 'Shared'; }} />
      <FormSheet visible={!!form?.answer} onClose={() => setForm(null)} title="Answer" fields={[{ key: 'body', label: 'Answer' }, { key: 'shared', label: 'Share with every supplier (without saying who asked)', type: 'switch', default: true }]} onSubmit={async (v) => { await api.post(`/rfqs/${x.id}/clarifications`, { body: v.body, answers_id: form.answer.id, shared: v.shared }); act(async () => null); return 'Answered'; }} />
      <FormSheet visible={form === 'scope'} onClose={() => setForm(null)} title="Change the scope" fields={[{ key: 'reason', label: 'Why', type: 'multiline' }, { key: 'quantity', label: 'New quantity', type: 'number', optional: true }, { key: 'headcount', label: 'New headcount', type: 'stepper', min: 0, max: 10000, default: 0, optional: true }]}
        onSubmit={async (v) => { await api.post(`/rfqs/${x.id}/scope`, { row_version: x.row_version, reason: v.reason, changes: { ...(v.quantity ? { quantity: Number(v.quantity) } : {}), ...(v.headcount ? { headcount: v.headcount } : {}) } }); act(async () => null); return 'New scope version — every supplier must re-quote'; }} />
    </Sheet>
  );
}

function Orders({ b, cat }) {
  const list = useLoad(() => api.get('/service-orders', { side: 'buyer', buyer_id: b.id, limit: 50 }), [b.id]);
  const [open, setOpen] = useState(null);
  return (
    <>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((o) => <Row key={o.id} title={`${o.number} · ${o.title ?? catLabel(cat, o.category)}`} sub={`${o.supplier_name} · ${money(o.gross_minor, o.currency)} · fulfilment ${label(o.fulfilment)} · billing ${label(o.billing)} · ${label(o.settlement)}`} right={<Status s={o.status} />} onPress={() => setOpen(o)} />) : <Empty emoji="📋" title="No orders yet" sub="Awarded quotes become orders the supplier confirms." />}
      {open ? <OrderSheet b={b} id={open.id} onClose={() => { setOpen(null); list.reload(); }} /> : null}
    </>
  );
}

function OrderSheet({ b, id, onClose }) {
  const r = useLoad(() => api.get(`/service-orders/${id}`), [id]);
  const vis = useLoad(() => api.get(`/service-orders/${id}/visits`, { limit: 100 }), [id]);
  const act = useDo(() => { r.reload(); vis.reload(); });
  const [form, setForm] = useState(null);
  const o = r.data;
  if (!o) return <Sheet visible onClose={onClose} title="Order">{r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : <Loading />}</Sheet>;
  const can = (role) => o.my_roles.buyer.includes(role);
  const live = ['confirmed', 'in_progress', 'paused'].includes(o.status);
  return (
    <Sheet visible onClose={onClose} title={o.number}>
      <Wrap><Status s={o.status} /><Status s={o.fulfilment} /><T size={12} color={c.mute}>billing {label(o.billing)} · {label(o.settlement)}</T></Wrap>
      <Kv k="supplier" v={o.supplier?.trading_name ?? o.supplier?.legal_name} /><Kv k="total" v={money(o.gross_minor, o.currency)} /><Kv k="agreement" v={label(o.agreement_status)} />
      {o.travel_confirmation ? <Kv k="booking" v={`${label(o.travel_confirmation)}${o.third_party_ref ? ` · ref ${o.third_party_ref}` : ''} — not a live airline/hotel reservation`} /> : null}
      <Wrap><DocButton type="service_order" id={o.id} title="Order PDF" /><DocButton type="agreement" id={o.id} title="Agreement / SOW" /><DocButton type="service_receipt" id={o.id} title="Service receipt" /><DocButton type="completion_report" id={o.id} title="Completion report" /></Wrap>
      {!['not_required', 'fully_signed', 'signed_by_buyer'].includes(o.agreement_status) && can('purchaser') ? <Btn small color={c.paper} ink={c.ink} title="Acknowledge agreement" onPress={() => setForm('sign')} style={{ alignSelf: 'flex-start' }} /> : null}
      <Section title="Commercial chain"><ChainTrace path={`/service-orders/${o.id}/chain`} /></Section>
      <Section title="Lines">{o.lines.map((l) => <Row key={l.id} title={`${l.line_no}. ${l.description}`} sub={`ordered ${Number(l.qty_ordered)} ${label(l.unit)} · accepted ${Number(l.qty_accepted)} · invoiced ${Number(l.qty_invoiced)}`} right={live && can('acceptor') && Number(l.qty_accepted) < Number(l.qty_ordered) ? <Btn small title="Accept work" onPress={() => setForm({ accept: l })} /> : null} />)}</Section>
      <Section title="Visits & shifts">
        {vis.data?.length ? vis.data.map((v) => <Row key={v.id} title={when(v.starts_at)} sub={`${v.site_label ?? ''} ${v.crew_count ? `· ${v.crew_count} crew` : ''} ${v.actual_qty ? `· reported ${Number(v.actual_qty)}` : ''}`} right={<><Status s={v.status} />{v.status === 'submitted_for_acceptance' && can('acceptor') ? <><Btn small title="Accept" onPress={() => setForm({ visit: v, decision: 'accepted' })} /><Btn small color={c.paper} ink={c.red} title="Reject" onPress={() => setForm({ visit: v, decision: 'rejected' })} /></> : null}</>} />) : <Note>No visits yet.</Note>}
      </Section>
      <Section title="Changes">
        {o.variations.map((v) => <Row key={v.id} title={`${label(v.kind)} · v${v.version}`} sub={`${v.reason} · by ${v.proposed_side}${Number(v.delta_net_minor) ? ` · ${money(v.delta_net_minor, o.currency)} net` : ''}`} right={<><Status s={v.status} />{v.status === 'proposed' && v.proposed_side === 'supplier' && can('purchaser') ? <><Btn small title="Accept" onPress={() => act(() => api.post(`/service-variations/${v.id}/respond`, { accept: true }), 'Applied (or sent for approval)')} /><Btn small color={c.paper} ink={c.red} title="Reject" onPress={() => setForm({ rejectVar: v })} /></> : null}</>} />)}
        {live && can('purchaser') ? <Wrap><Btn small color={c.paper} ink={c.ink} title="Request a change" onPress={() => setForm('variation')} /><Btn small color={c.paper} ink={c.red} title="End this order" onPress={() => setForm('terminate')} /></Wrap> : null}
        {['pending_supplier', 'changes_proposed', 'confirmed'].includes(o.status) && can('purchaser') && o.lines.every((l) => Number(l.qty_accepted) === 0) ? <Btn small color={c.paper} ink={c.red} title="Cancel order" onPress={() => setForm('cancel')} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>
      <Section title="This supplier, with you">
        <PerformanceRecord profileId={o.profile_id} buyerId={o.buyer_id} />
        {(can('acceptor') || can('purchaser')) && o.lines.some((l) => Number(l.qty_accepted) > 0) ? <Btn small color={c.paper} ink={c.ink} title="Rate this supplier" onPress={() => setForm('rate')} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Rate this supplier" /> : null}
      </Section>
      <FormSheet visible={form === 'rate'} onClose={() => setForm(null)} title="Rate the supplier" submitLabel="Save rating" initial={{ stars: 5 }}
        notice="One rating per order. It is kept as written and shown to the supplier with how many orders it rests on; it is not a hidden score."
        fields={[{ key: 'stars', label: 'How did the supplier do?', type: 'chips', options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} ★` })) }, { key: 'comment', label: 'Comment (optional)', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/rating`, { stars: Number(v.stars), comment: v.comment || undefined }); r.reload(); return 'Thank you — rating recorded'; }} />
      <FormSheet visible={form === 'sign'} onClose={() => setForm(null)} title="Acknowledge agreement" fields={[{ key: 'typed_name', label: 'Type your full name to acknowledge' }]} onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/agreement`, v); r.reload(); return 'Recorded (an acknowledgement, not a qualified e-signature)'; }} />
      <FormSheet visible={!!form?.accept} onClose={() => setForm(null)} title="Accept work" fields={[{ key: 'quantity', label: `Quantity accepted (up to ${form?.accept ? Number(form.accept.qty_ordered) - Number(form.accept.qty_accepted) : ''})`, type: 'number' }]}
        onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/acceptance`, { line_no: form.accept.line_no, decision: 'accepted', quantity: Number(v.quantity) }); act(async () => null); return 'Accepted'; }} />
      <FormSheet visible={!!form?.visit} onClose={() => setForm(null)} title={form?.decision === 'accepted' ? 'Accept this visit' : 'Reject this visit'}
        fields={[{ key: 'quantity', label: 'Quantity', type: 'number', default: form?.visit ? Number(form.visit.actual_qty ?? form.visit.planned_qty) : undefined }, ...(form?.decision === 'rejected' ? [{ key: 'reason', label: 'What needs fixing', type: 'multiline' }, { key: 'rework_due', label: 'Rework due by', type: 'date' }] : [])]}
        initial={{ quantity: form?.visit ? String(Number(form.visit.actual_qty ?? form.visit.planned_qty)) : '' }}
        onSubmit={async (v) => { const l = o.lines.find((x) => x.id === form.visit.line_id); await api.post(`/service-orders/${o.id}/acceptance`, { line_no: l.line_no, visit_id: form.visit.id, decision: form.decision, quantity: Number(v.quantity), reason: v.reason, rework_due: v.rework_due }); act(async () => null); return form.decision === 'accepted' ? 'Accepted' : 'Sent back for rework'; }} />
      <FormSheet visible={!!form?.rejectVar} onClose={() => setForm(null)} title="Reject change" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/service-variations/${form.rejectVar.id}/respond`, { accept: false, reason: v.reason }); act(async () => null); return 'Rejected'; }} />
      <FormSheet visible={form === 'variation'} onClose={() => setForm(null)} title="Request a change"
        fields={[{ key: 'kind', label: 'What changes', type: 'chips', options: ['scope', 'cost', 'date', 'headcount', 'pause', 'resume', 'reschedule', 'partial_cancellation'].map((k) => ({ value: k, label: label(k) })) }, { key: 'reason', label: 'Reason', type: 'multiline' }, { key: 'effective_on', label: 'Effective from', type: 'date', optional: true },
          { key: 'line_no', label: 'Order line', type: 'chips', options: o.lines.map((l) => ({ value: l.line_no, label: `${l.line_no}. ${l.description.slice(0, 24)}` })), show: (v) => ['scope', 'cost', 'partial_cancellation'].includes(v.kind), optional: true }, { key: 'qty', label: 'New quantity', type: 'number', show: (v) => ['scope', 'partial_cancellation'].includes(v.kind), optional: true }, { key: 'rate', label: 'New rate', type: 'money', currency: o.currency, show: (v) => v.kind === 'cost', optional: true }, { key: 'shift_days', label: 'Move by (days)', type: 'stepper', min: -365, max: 365, default: 0, show: (v) => ['date', 'reschedule'].includes(v.kind), optional: true }]}
        onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/variations`, { kind: v.kind, reason: v.reason, effective_on: v.effective_on, changes: { ...(v.line_no ? { lines: [{ line_no: Number(v.line_no), ...(v.qty ? { qty_ordered: Number(v.qty) } : {}), ...(v.rate ? { rate_minor: v.rate } : {}) }] } : {}), ...(v.shift_days ? { shift_days: v.shift_days } : {}) } }); r.reload(); return 'Sent — the supplier must accept'; }} />
      <FormSheet visible={form === 'terminate'} onClose={() => setForm(null)} title="End this order" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }, { key: 'effective_on', label: 'Ends on', type: 'date' }]} submitLabel="End order — accepted work stays billable"
        onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/variations`, { kind: 'termination', reason: v.reason, effective_on: v.effective_on }); act(async () => null); return 'Order ended; future visits released'; }} />
      <FormSheet visible={form === 'cancel'} onClose={() => setForm(null)} title="Cancel order" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/service-orders/${o.id}/cancel`, { reason: v.reason }); act(async () => null); return 'Cancelled'; }} />
    </Sheet>
  );
}

function Invoices({ b }) {
  const list = useLoad(() => api.get('/service-invoices', { side: 'buyer', buyer_id: b.id, limit: 50 }), [b.id]);
  const act = useDo(list.reload);
  const [form, setForm] = useState(null);
  const can = (r) => b.my_roles.includes(r);
  return (
    <>
      {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data?.length ? list.data.map((i) => (
        <Row key={i.id} title={`${i.supplier_number} · ${label(i.doc_type)}`} sub={`${i.order_number} · ${money(i.gross_minor, i.currency)}${Number(i.withholding_minor) ? ` (payable ${money(i.payable_minor, i.currency)})` : ''}${Number(i.paid_minor) ? ` · paid ${money(i.paid_minor, i.currency)}` : ''} · match ${label(i.match_status)}${i.due_on ? ` · due ${day(i.due_on)}` : ''}`}
          right={<><Status s={i.pay_status} />
            {i.match_status === 'exception' && can('finance') ? <Btn small color={c.paper} ink={c.ink} title="Ask approver" onPress={() => setForm({ exc: i })} /> : null}
            {i.doc_type === 'invoice' && i.pay_status !== 'paid' && can('finance') && ['matched', 'exception_approved'].includes(i.match_status) ? <><Btn small title="Record payment" onPress={() => setForm({ pay: i })} /><Btn small color={c.paper} ink={c.ink} title="Pay online" onPress={() => act(async () => { const s = await api.post(`/service-invoices/${i.id}/pay`, { provider: 'stripe' }); if (s.checkout_url && typeof window !== 'undefined') window.open(s.checkout_url, '_blank'); return s; })} /></> : null}
            <DocButton type="invoice" id={i.id} title="PDF" /></>} />
      )) : <Empty emoji="🧾" title="No invoices yet" sub="Supplier invoices are matched to the order and your acceptance before they can be paid." />}
      <Note>An invoice matches only when the quantity billed is covered by work you accepted. A deposit or prepayment needs an approver’s sign-off.</Note>
      <FormSheet visible={!!form?.exc} onClose={() => setForm(null)} title="Why pay this before it matches?" fields={[{ key: 'reason', label: 'Reason (audited)', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/service-invoices/${form.exc.id}/exception`, { reason: v.reason }); list.reload(); return 'Sent to an approver'; }} />
      <FormSheet visible={!!form?.pay} onClose={() => setForm(null)} title="Record a payment you made"
        fields={[{ key: 'source', label: 'How', type: 'choice', options: [{ value: 'manual_bank', label: 'Bank' }, { value: 'manual_cash', label: 'Cash' }, { value: 'manual_other', label: 'Other' }] }, { key: 'amount', label: 'Amount', type: 'money', currency: form?.pay?.currency }, { key: 'paid_on', label: 'Paid on', type: 'date' }, { key: 'reference', label: 'Bank / receipt reference' }, { key: 'evidence', label: 'Evidence', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/service-invoices/${form.pay.id}/payments`, { source: v.source, amount_minor: v.amount, paid_on: v.paid_on, reference: v.reference, evidence: v.evidence }); list.reload(); return 'Recorded — this is a ledger entry; no money moved'; }} />
    </>
  );
}

function Team({ b }) {
  const roles = useLoad(() => api.get(`/service-buyers/${b.id}/roles`), [b.id]);
  const aps = useLoad(() => api.get(`/service-buyers/${b.id}/approvals`, { status: 'pending', limit: 50 }).catch(() => []), [b.id]);
  const act = useDo(() => { roles.reload(); aps.reload(); });
  const [form, setForm] = useState(null);
  return (
    <>
      <Section title="Waiting for a decision">
        {aps.data?.length ? aps.data.map((a) => <Row key={a.id} title={`${label(a.subject_type)} · ${money(a.amount_minor, a.currency)}`} sub={a.exception_reason ?? ''} right={b.my_roles.includes('approver') ? <><Btn small title="Approve" onPress={() => act(() => api.post(`/service-approvals/${a.id}/decision`, { approve: true }), 'Approved')} /><Btn small color={c.paper} ink={c.red} title="Reject" onPress={() => setForm({ rej: a })} /></> : <Status s="pending" />} />) : <Note>Nothing waiting.</Note>}
      </Section>
      <Section title="Procurement roles">
        <Note>Being a member of an organisation does not let anyone place orders, approve their own spend or see all invoices — grant those roles here. An approver can never approve their own request.</Note>
        {roles.data?.map((r) => <Row key={r.id} title={r.display_name} sub={`${label(r.role)}${r.limit_minor != null ? ` · limit ${money(r.limit_minor, b.currency)}` : ''}`} right={<Btn small color={c.paper} ink={c.red} title="Revoke" onPress={() => act(() => api.del(`/service-buyer-roles/${r.id}`), 'Revoked')} />} />)}
        <Btn small color={c.paper} ink={c.ink} title="Give a role" onPress={() => setForm('role')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Approval policy"><Btn small color={c.paper} ink={c.ink} title="Set approval threshold" onPress={() => setForm('policy')} style={{ alignSelf: 'flex-start' }} /><Note>Spending above the threshold needs a different person with the approver role.</Note></Section>
      <FormSheet visible={form === 'role'} onClose={() => setForm(null)} title="Give a role" fields={[{ key: 'user_id', label: 'Person', type: 'entity', entityKind: 'person', noun: 'person' }, { key: 'role', label: 'Role', type: 'chips', options: ['requester', 'evaluator', 'approver', 'purchaser', 'acceptor', 'finance'].map((k) => ({ value: k, label: label(k) })) }, { key: 'limit', label: 'Spending limit', type: 'money', currency: b.currency, optional: true }]}
        onSubmit={async (v) => { await api.post(`/service-buyers/${b.id}/roles`, { user_id: v.user_id, role: v.role, ...(v.limit ? { limit_minor: v.limit } : {}) }); roles.reload(); return 'Granted'; }} />
      <FormSheet visible={form === 'policy'} onClose={() => setForm(null)} title="Approval policy" fields={[{ key: 'above', label: 'Needs an approver above', type: 'money', currency: b.currency, optional: true }, { key: 'single', label: 'Require a reason when only one supplier is chosen', type: 'switch', default: true }, { key: 'match', label: 'Require invoice matching before payment', type: 'switch', default: true }]}
        onSubmit={async (v) => { await api.patch(`/service-buyers/${b.id}/policy`, { thresholds: v.above ? [{ above_minor: v.above }] : [], single_supplier_justification: v.single, require_invoice_match: v.match }); return 'Saved'; }} />
      <FormSheet visible={!!form?.rej} onClose={() => setForm(null)} title="Reject" fields={[{ key: 'note', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/service-approvals/${form.rej.id}/decision`, { approve: false, note: v.note }); aps.reload(); return 'Rejected'; }} />
    </>
  );
}

function Reports({ b }) {
  const d = useLoad(() => api.get(`/service-buyers/${b.id}/dashboard`), [b.id]);
  const [csv, setCsv] = useState(null);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const x = d.data;
  return (
    <>
      <Wrap>
        <Kpi title="Requirement coverage" value={x.coverage.rate == null ? '—' : `${Math.round(x.coverage.rate * 100)}%`} sub={`${x.coverage.covered}/${x.coverage.requirements} covered`} />
        <Kpi title="Suppliers responded" value={x.sourcing.response_rate == null ? '—' : `${Math.round(x.sourcing.response_rate * 100)}%`} sub={`${x.sourcing.suppliers_responded}/${x.sourcing.suppliers_invited} invited`} />
        <Kpi title="Invoice exceptions" value={String(x.invoices.open_exceptions)} sub={`${x.invoices.approved_exceptions} approved`} />
      </Wrap>
      <Section title="Spend (per currency)">{x.spend.by_currency.map((m) => <Row key={m.currency} title={m.currency} sub={`planned ${money(m.planned_minor, m.currency)} · committed ${money(m.committed_minor, m.currency)} · invoiced ${money(m.invoiced_minor, m.currency)} · paid ${money(m.paid_minor, m.currency)}`} right={<T weight="800">{money(m.outstanding_minor, m.currency)} due</T>} />)}</Section>
      {x.spend.savings.length ? <Section title="Savings against other quotes">{x.spend.savings.map((s) => <Row key={s.currency} title={s.currency} sub={`${s.rfqs} comparable RFQ${s.rfqs === 1 ? '' : 's'}`} right={<T weight="800">{money(s.saved_minor, s.currency)}</T>} />)}<Note>{x.definitions.savings}</Note></Section> : null}
      <Section title="Supplier performance">{x.supplier_performance.map((p) => <Row key={p.profile_id} title={p.supplier} sub={`${p.orders} order(s) · ${p.accepted} accepted · ${p.rework} rework · ${p.no_show} no-show · ${p.incidents} incident(s)`} />)}</Section>
      <Section title="Next 14 days">{x.work.upcoming.length ? x.work.upcoming.map((v) => <Row key={v.id} title={`${v.number} · ${when(v.starts_at)}`} sub={v.site_label ?? ''} right={<Status s={v.status} />} />) : <Note>No visits scheduled.</Note>}</Section>
      {x.work.overdue.length ? <Section title="Overdue">{x.work.overdue.map((v) => <Row key={v.id} title={`${v.number} · ${when(v.starts_at)}`} right={<Status s={v.status} />} />)}</Section> : null}
      <Wrap>{['orders', 'invoices', 'payments', 'tax'].map((k) => <Btn key={k} small color={c.paper} ink={c.ink} title={`CSV: ${k}`} onPress={async () => setCsv(await api.get('/service-reports/export', { side: 'buyer', scope_id: b.id, report: k }))} />)}<DocButton type="buyer_report" id={b.id} title="Dashboard PDF" small={false} /></Wrap>
      <ExportsPanel side="buyer" scopeId={b.id} />
      <Sheet visible={!!csv} onClose={() => setCsv(null)} title={csv?.filename ?? ''}><Note>{csv?.rows} rows{csv?.truncated ? ' (truncated — narrow the dates)' : ''}. Copy into a spreadsheet.</Note><T size={11} selectable>{csv?.csv}</T></Sheet>
    </>
  );
}
