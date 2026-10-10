// Partner management — a separate console for the platform team (onboard / manage / modify / offboard partners, approve venues,
// negotiate and set prices, contracts, settlements, reports, platform staff) and a "My partner account" page for venue owners.
// Everything here is the same REST API agents use over MCP; the platform-only actions are rejected by the server for anyone else.
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const cash = (cents, cur = 'INR') => moneyIn(Number(cents ?? 0), cur);
const d10 = (d) => (d ? String(d).slice(0, 10) : '');
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const pct = (bp) => `${(Number(bp) / 100).toFixed(2).replace(/\.00$/, '')}%`;
const iso = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const TONE = { active: c.lime, approved: c.lime, paid: c.lime, applied: c.sunSoft, onboarding: c.cyanSoft, pending: c.sunSoft, sent: c.cyanSoft, draft: c.violetSoft, countered: c.orangeSoft, changes_requested: c.orangeSoft, suspended: c.orangeSoft, rejected: c.pinkSoft, offboarded: c.pinkSoft, terminated: c.pinkSoft, void: c.pinkSoft, declined: c.pinkSoft, superseded: c.violetSoft, withdrawn: c.violetSoft };
const St = ({ s }) => <Tag label={label(s)} color={TONE[s] ?? c.violetSoft} />;

function download(name, text) {
  if (Platform.OS !== 'web') return false;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click();
  return true;
}

/** Runs an API call and reports the outcome; reloads on success. */
function useAct(reload) {
  const { toast } = useSession();
  return async (fn, ok) => { try { const r = await fn(); toast(ok ?? 'Done'); reload?.(); return r; } catch (e) { toast(e.message); return null; } };
}
const Block = ({ state, children, empty }) => (state.loading && !state.data ? <Loading /> : state.error ? <ErrorBox error={state.error} onRetry={state.reload} /> : state.data?.length === 0 && empty ? <Empty emoji="📭" title={empty} /> : children);

/** Search a venue by name and pick it. */
function VenuePicker({ visible, onClose, onPick, title = 'Pick a venue' }) {
  const [q, setQ] = useState('');
  const res = useLoad(() => (visible ? api.get('/venues', { q: q || undefined, limit: 20 }) : Promise.resolve([])), [visible, q]);
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <Field value={q} onChangeText={setQ} placeholder="Search by venue name…" />
      {(res.data ?? []).map((v) => <Row key={v.id} title={v.name} sub={[v.city, v.currency].filter(Boolean).join(' · ')} onPress={() => { onClose(); onPick(v); }} />)}
      {res.data?.length === 0 ? <T color={c.mute} size={13}>Only live venues are listed here. Pending ones are in Venue approvals.</T> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ pricing assistant (shared)
function SuggestionSheet({ venue, onClose, onDone }) {
  const s = useLoad(() => (venue ? api.get(`/admin/venues/${venue.id}/pricing-suggestion`) : Promise.resolve(null)), [venue?.id]);
  const act = useAct(onDone);
  const d = s.data;
  const apply = () => act(async () => {
    await api.post(`/admin/venues/${venue.id}/pricing`, {
      base_rates: d.resources.filter((r) => r.suggested_cents).map((r) => ({ resource_id: r.resource_id, hourly_rate_cents: r.suggested_cents })),
      rules: d.suggested_rules.map(({ area, ...r }) => r), factors: Object.fromEntries(d.factors.map((f) => [f.key, f.adjust_pct])), note: 'Platform price list from the pricing assistant',
    });
    onClose();
  }, 'Price list applied: it now overrides the venue\'s own prices');
  return (
    <Sheet visible={!!venue} onClose={onClose} title={`Price list · ${venue?.name ?? ''}`}>
      {s.loading ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : d ? <>
        <T size={13} color={c.mute}>Built from comparable venues, demand, rating, facilities and discounts. You decide; nothing changes until you apply.</T>
        {d.factors.map((f) => <Row key={f.key} title={`${f.label}  ${f.adjust_pct > 0 ? '+' : ''}${f.adjust_pct}%`} sub={f.detail} color={c.violetSoft} />)}
        <T weight="800" style={{ marginTop: 6 }}>Base rates (×{d.multiplier})</T>
        {d.resources.map((r) => <Row key={r.resource_id} title={r.name} sub={`now ${cash(r.current_cents, d.currency)} · ${r.baseline_source} ${r.baseline_cents ? cash(r.baseline_cents, d.currency) : '—'}`} right={<T weight="800">{r.suggested_cents ? cash(r.suggested_cents, d.currency) : 'set manually'}</T>} />)}
        <T size={12} color={c.mute}>Plus {d.suggested_rules.length} peak / weekend / off-peak rules (platform rules always win over venue rules).</T>
        <Btn title="Apply as the platform price list" onPress={apply} style={{ marginTop: 8 }} />
      </> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ platform tabs
function Overview({ go }) {
  const s = useLoad(() => api.get('/admin/partner-dashboard'), []);
  const d = s.data;
  return (
    <Block state={s}>
      {d ? <>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <StatPill value={d.partners.active ?? 0} label="ACTIVE PARTNERS" color={c.lime} />
          <StatPill value={d.partners_to_onboard} label="TO ONBOARD" />
          <StatPill value={d.venues_pending} label="VENUES PENDING" />
          <StatPill value={d.price_requests_awaiting_platform} label="PRICE REQUESTS" />
          <StatPill value={d.contracts_awaiting_partner} label="CONTRACTS SENT" />
        </View>
        <Section title="Last 30 days" color={c.cyan}>
          {d.last_30_days.sales.length ? d.last_30_days.sales.map((x) => <Row key={x.currency} title={`Sales ${cash(x.sales_cents, x.currency)}`} sub={`${x.invoices} paid invoices${d.last_30_days.commission_settled.find((k) => k.currency === x.currency) ? ` · commission settled ${cash(d.last_30_days.commission_settled.find((k) => k.currency === x.currency).commission_cents, x.currency)}` : ''}`} />) : <T color={c.mute}>No paid bookings yet.</T>}
        </Section>
        <Section title="Top venues" color={c.sun}>{d.top_venues.map((v) => <Row key={v.id + v.currency} title={v.name} sub={v.city} right={<T weight="800">{cash(v.sales_cents, v.currency)}</T>} />)}</Section>
        {d.contracts_ending_soon.length ? <Section title="Contracts ending in 30 days" color={c.orange}>{d.contracts_ending_soon.map((k) => <Row key={k.id} title={`${k.partner_name} · ${k.contract_no}`} sub={`ends ${d10(k.effective_to)}`} />)}</Section> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <Btn small title="Venue approvals" onPress={() => go('approvals')} /><Btn small title="Price requests" color={c.violet} onPress={() => go('pricing')} /><Btn small title="Settlements" color={c.cyan} ink={c.ink} onPress={() => go('settlements')} />
        </View>
      </> : null}
    </Block>
  );
}

function PartnerSheet({ id, onClose, onChanged }) {
  const p = useLoad(() => (id ? api.get(`/partners/${id}`) : Promise.resolve(null)), [id]);
  const rev = useLoad(() => (id ? api.get(`/admin/partners/${id}/review`) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState(null);
  const act = useAct(() => { p.reload(); rev.reload(); onChanged(); });
  const x = p.data;
  const decide = (action, hint) => setForm({ title: `${label(action)} partner`, submit: label(action), fields: [{ key: 'reason', label: 'Reason (kept in the timeline and sent to the partner)', type: 'multiline', hint }], run: (v) => api.post(`/admin/partners/${id}/decision`, { action, reason: v.reason }) });
  const edit = () => setForm({ title: 'Modify partner', submit: 'Save', initial: { name: x.name, legal_name: x.legal_name ?? '', city: x.city ?? '', country: x.country ?? '', notes: x.notes ?? '' },
    fields: [{ key: 'name', label: 'Name' }, { key: 'legal_name', label: 'Legal name', optional: true }, { key: 'city', label: 'City', optional: true }, { key: 'country', label: 'Country', optional: true }, { key: 'contact_name', label: 'Contact name (encrypted)', optional: true }, { key: 'contact_email', label: 'Contact email (encrypted)', optional: true, type: 'email' }, { key: 'contact_phone', label: 'Contact phone (encrypted)', optional: true, type: 'phone' }, { key: 'tax_id', label: 'Tax id (encrypted)', optional: true }, { key: 'notes', label: 'Internal notes', type: 'multiline', optional: true }],
    run: (v) => api.patch(`/partners/${id}`, Object.fromEntries(Object.entries(v).filter(([, val]) => val !== '' && val != null))) });
  const contract = (venue) => setForm({ title: 'Generate contract', submit: 'Send to partner', initial: { commission_pct: (rev.data?.recommended_terms.commission_bp ?? 1500) / 100, reserve_pct: (rev.data?.recommended_terms.reserve_bp ?? 0) / 100, cycle: rev.data?.recommended_terms.settlement_cycle ?? 'weekly', term_months: 12 },
    fields: [{ key: 'commission_pct', label: 'Commission %', type: 'stepper', min: 0, max: 100, step: 1 }, { key: 'reserve_pct', label: 'Reserve held on online payouts %', type: 'stepper', min: 0, max: 50, step: 1 }, { key: 'cycle', label: 'Settlement cycle', type: 'choice', options: ['weekly', 'biweekly', 'monthly'] }, { key: 'term_months', label: 'Term (months)', type: 'stepper', min: 1, max: 60 }, { key: 'clause', label: 'Custom clause (optional)', type: 'multiline', optional: true }],
    run: (v) => api.post('/admin/contracts', { partner_id: id, venue_id: venue?.id, send: true, terms: { commission_bp: Math.round(v.commission_pct * 100), reserve_bp: Math.round(v.reserve_pct * 100), settlement_cycle: v.cycle, term_months: v.term_months }, clauses: v.clause ? [{ text: v.clause }] : [] }) });
  return (
    <Sheet visible={!!id} onClose={onClose} title={x?.name ?? 'Partner'}>
      {p.loading && !x ? <Loading /> : p.error ? <ErrorBox error={p.error} onRetry={p.reload} /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><St s={x.status} /><Tag label={x.code} />{x.risk_score != null ? <Tag label={`risk ${x.risk_score}`} color={x.risk_score > 60 ? c.pinkSoft : c.lime} /> : null}</View>
        <T size={13} color={c.mute}>{[x.legal_name, x.city, x.contact_email, x.contact_phone, x.has_tax_id ? 'tax id ✓' : 'no tax id', x.has_payout ? `payout ••••${x.payout_last4}` : 'no payout account'].filter(Boolean).join(' · ')}</T>
        {rev.data ? <Card color={c.violetSoft} pad={12}>
          <T weight="800">Onboarding assistant · {rev.data.risk_band} risk</T>
          <T size={13}>{rev.data.recommendation}</T>
          <T size={12} color={c.mute}>Suggested: {pct(rev.data.recommended_terms.commission_bp)} commission, {pct(rev.data.recommended_terms.reserve_bp)} reserve, {rev.data.recommended_terms.settlement_cycle} settlement. {rev.data.reasons.map((r) => `${r.delta > 0 ? '+' : ''}${r.delta} ${r.why}`).join(' · ')}</T>
        </Card> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {['applied', 'onboarding'].includes(x.status) ? <><Btn small title="Approve" onPress={() => decide('approve')} /><Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => decide('reject')} /></> : null}
          {x.status === 'active' ? <Btn small title="Suspend" color={c.orange} onPress={() => decide('suspend', 'All its venues are paused; bookings and data are kept.')} /> : null}
          {x.status === 'suspended' ? <Btn small title="Reinstate" onPress={() => decide('reinstate')} /> : null}
          {!['offboarded', 'rejected'].includes(x.status) ? <Btn small title="Offboard" color={c.paper} ink={c.red} onPress={() => decide('offboard', 'Blocked while upcoming bookings exist. Contracts end; history is kept.')} /> : null}
          {x.status !== 'offboarded' ? <Btn small title="Modify" color={c.violet} onPress={edit} /> : null}
          <Btn small title="Contract" color={c.cyan} ink={c.ink} onPress={() => contract(null)} />
        </View>
        <T weight="800">Onboarding checklist</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {['tax_id', 'payout', 'contract_signed', 'site_visit', 'photos'].map((k) => <Chip key={k} label={label(k)} active={!!x.checklist?.[k]} onPress={() => act(() => api.patch(`/partners/${id}`, { checklist: { [k]: !x.checklist?.[k] } }), 'Checklist updated')} />)}
        </View>
        <Section title={`Venues (${x.venues_list.length})`} color={c.sun}>
          {x.venues_list.map((v) => <Row key={v.id} title={v.name} sub={`${v.city ?? ''} · ${v.resources} areas${v.paused_by_partner ? ' · paused' : ''}`} right={<St s={v.approval_status} />} />)}
        </Section>
        <Section title="Contracts" color={c.cyan}>{x.contracts.length ? x.contracts.map((k) => <Row key={k.id} title={`${k.contract_no} · v${k.version}`} sub={`${pct(k.terms.commission_bp)} · ${k.terms.settlement_cycle} · from ${d10(k.effective_from)}`} right={<St s={k.status} />} />) : <T color={c.mute}>No contract yet.</T>}</Section>
        <Section title="Timeline" color={c.violet}>{x.timeline.slice(0, 10).map((e) => <T key={e.id} size={12} color={c.mute}>{new Date(e.created_at).toLocaleString(locale)} · {e.actor ?? 'system'} · {label(e.action)}{e.detail?.reason ? ` — ${e.detail.reason}` : ''}</T>)}</Section>
      </> : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.title ?? ''} submitLabel={form?.submit} initial={form?.initial} fields={form?.fields ?? []}
        onSubmit={async (v) => { await form.run(v); p.reload(); rev.reload(); onChanged(); return 'Saved'; }} />
    </Sheet>
  );
}

function Partners() {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null);
  const [add, setAdd] = useState(false);
  const l = useLoad(() => api.get('/admin/partners', { status: status ?? undefined, limit: 100 }), [status]);
  return (
    <>
      <Seg options={[{ value: null, label: 'All' }, ...['applied', 'onboarding', 'active', 'suspended', 'offboarded', 'rejected'].map((s) => ({ value: s, label: label(s) }))]} value={status} onChange={setStatus} />
      <Btn small title="Onboard a partner" onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start', marginVertical: 8 }} />
      <Block state={l} empty="No partners here yet.">
        {(l.data ?? []).map((p) => <Row key={p.id} onPress={() => setOpen(p.id)} title={`${p.name} · ${p.code}`} sub={`${p.city ?? '—'} · ${p.venues} venue(s)${p.venues_pending ? ` (${p.venues_pending} pending)` : ''} · @${p.owner_handle}`} right={<St s={p.status} />} />)}
      </Block>
      <PartnerSheet id={open} onClose={() => setOpen(null)} onChanged={l.reload} />
      <FormSheet visible={add} onClose={() => setAdd(false)} title="Onboard a partner" submitLabel="Start onboarding"
        fields={[{ key: 'owner', label: 'Owner\'s SportArena handle', hint: 'They must have an account (venue manager). They are told and can complete their details.' }, { key: 'name', label: 'Partner name' }, { key: 'legal_name', label: 'Legal name', optional: true }, { key: 'kind', label: 'Type', type: 'chips', options: ['venue_operator', 'club', 'academy', 'school', 'other'].map((k) => ({ value: k, label: label(k) })), default: 'venue_operator' }, { key: 'city', label: 'City', optional: true }]}
        onSubmit={async (v) => { const r = await api.post('/admin/partners', Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null))); l.reload(); setOpen(r.id); return `${r.code} created`; }} />
    </>
  );
}

function Approvals() {
  const [status, setStatus] = useState('pending');
  const l = useLoad(() => api.get('/admin/venue-approvals', { status, limit: 50 }), [status]);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(null);
  const [price, setPrice] = useState(null);
  const decide = (v, decision) => setForm(decision === 'approve'
    ? { title: `Approve ${v.name}`, submit: 'Approve & send contract', initial: { commission_pct: 15, reserve_pct: 5, cycle: 'weekly', send_contract: true },
      fields: [{ key: 'note', label: 'Note to the partner', optional: true, type: 'multiline' }, { key: 'send_contract', label: 'Send a contract with approval', type: 'switch' }, { key: 'commission_pct', label: 'Commission %', type: 'stepper', min: 0, max: 100, step: 1, show: (f) => f.send_contract }, { key: 'reserve_pct', label: 'Reserve %', type: 'stepper', min: 0, max: 50, show: (f) => f.send_contract }, { key: 'cycle', label: 'Settlement cycle', type: 'choice', options: ['weekly', 'biweekly', 'monthly'], show: (f) => f.send_contract }, { key: 'clause', label: 'Custom clause (optional)', type: 'multiline', optional: true, show: (f) => f.send_contract }],
      run: (f) => api.post(`/admin/venues/${v.id}/decision`, { decision, note: f.note || undefined, contract: f.send_contract ? { terms: { commission_bp: Math.round(f.commission_pct * 100), reserve_bp: Math.round(f.reserve_pct * 100), settlement_cycle: f.cycle }, clauses: f.clause ? [{ text: f.clause }] : [] } : undefined }) }
    : { title: `${label(decision)} · ${v.name}`, submit: label(decision), fields: [{ key: 'note', label: 'What should the partner know?', type: 'multiline' }], run: (f) => api.post(`/admin/venues/${v.id}/decision`, { decision, note: f.note }) });
  return (
    <>
      <Seg options={['pending', 'changes_requested', 'approved', 'rejected'].map((s) => ({ value: s, label: label(s) }))} value={status} onChange={setStatus} />
      <Block state={l} empty="Nothing waiting for approval.">
        {(l.data ?? []).map((v) => <Card key={v.id} pad={12} onPress={() => setSel(sel === v.id ? null : v.id)}>
          <T weight="800">{v.name}</T><T size={13} color={c.mute}>{[v.city, v.partner_name, v.partner_status].filter(Boolean).join(' · ')}</T>
          {sel === v.id ? <>
            {v.resources.map((r) => <T key={r.id} size={13}>• {r.name} ({r.kind}) {cash(r.hourly_rate_cents, v.currency)}/h</T>)}
            <T size={12} color={c.mute}>{v.price_rules} proposed price rule(s) · {(v.amenities ?? []).join(', ') || 'no amenities listed'}</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <Btn small title="Price list" color={c.violet} onPress={() => setPrice(v)} />
              {v.approval_status !== 'approved' ? <Btn small title="Approve" onPress={() => decide(v, 'approve')} /> : null}
              {v.approval_status === 'pending' ? <Btn small title="Request changes" color={c.orange} onPress={() => decide(v, 'request_changes')} /> : null}
              {v.approval_status !== 'rejected' ? <Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => decide(v, 'reject')} /> : null}
            </View>
          </> : null}
        </Card>)}
      </Block>
      <SuggestionSheet venue={price} onClose={() => setPrice(null)} onDone={l.reload} />
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.title ?? ''} submitLabel={form?.submit} initial={form?.initial} fields={form?.fields ?? []} onSubmit={async (v) => { await form.run(v); l.reload(); return 'Decision saved'; }} />
    </>
  );
}

function Pricing() {
  const [status, setStatus] = useState('open');
  const l = useLoad(() => api.get('/price-requests', { status, limit: 50 }), [status]);
  const [pick, setPick] = useState(false);
  const [price, setPrice] = useState(null);
  const [form, setForm] = useState(null);
  const summary = (q) => (q.kind.startsWith('rule') ? `${q.payload.name ?? 'rule'} ${q.payload.hourly_rate_cents != null ? cash(q.payload.hourly_rate_cents, q.currency) : ''}${q.payload.start ? ` ${q.payload.start}–${q.payload.end}` : ''}` : `${label(q.kind)} ${q.payload.hourly_rate_cents != null ? cash(q.payload.hourly_rate_cents, q.currency) : ''}`);
  const decide = (q, action) => setForm({ title: `${label(action)} · ${q.venue_name}`, submit: label(action), initial: { rate: q.payload.hourly_rate_cents },
    fields: [...(action === 'reject' ? [] : [{ key: 'rate', label: action === 'counter' ? 'Counter-offer hourly rate' : 'Platform rate (change it to override the request)', type: 'money', currency: q.currency, optional: action === 'approve' }]), { key: 'note', label: 'Note to the venue', type: 'multiline', optional: action === 'approve' }],
    run: (v) => api.post(`/admin/price-requests/${q.id}/decision`, { action, note: v.note || undefined, adjust: v.rate != null && v.rate !== q.payload.hourly_rate_cents ? { hourly_rate_cents: v.rate } : action === 'counter' ? { hourly_rate_cents: v.rate } : undefined }) });
  return (
    <>
      <T size={13} color={c.mute}>Venues cannot change live prices. Their peak, off-peak and custom prices arrive here; you approve, counter or reject. Only the price list you approve is shown to customers.</T>
      <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}><Btn small title="Set a venue's price list" color={c.violet} onPress={() => setPick(true)} /></View>
      <Seg options={[{ value: 'open', label: 'Open' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} value={status} onChange={setStatus} />
      <Block state={l} empty="No price requests.">
        {(l.data ?? []).map((q) => <Card key={q.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{q.venue_name}</T><St s={q.status} /></View>
          <T size={13}>{summary(q)}{q.current?.hourly_rate_cents != null ? `  (live ${cash(q.current.hourly_rate_cents, q.currency)})` : ''}</T>
          {q.counter ? <T size={12} color={c.mute}>Counter: {cash(q.counter.hourly_rate_cents, q.currency)}</T> : null}
          {q.thread.filter((t) => t.note).map((t, i) => <T key={i} size={12} color={c.mute}>{t.role}: {t.note}</T>)}
          {['pending', 'countered'].includes(q.status) ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <Btn small title="Approve" onPress={() => decide(q, 'approve')} /><Btn small title="Counter" color={c.orange} onPress={() => decide(q, 'counter')} /><Btn small title="Reject" color={c.paper} ink={c.red} onPress={() => decide(q, 'reject')} />
          </View> : null}
        </Card>)}
      </Block>
      <VenuePicker visible={pick} onClose={() => setPick(false)} onPick={setPrice} />
      <SuggestionSheet venue={price} onClose={() => setPrice(null)} onDone={l.reload} />
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.title ?? ''} submitLabel={form?.submit} initial={form?.initial} fields={form?.fields ?? []} onSubmit={async (v) => { await form.run(v); l.reload(); return 'Saved'; }} />
    </>
  );
}

function ContractView({ id, onClose, onChanged, platform }) {
  const k = useLoad(() => (id ? api.get(`/contracts/${id}`) : Promise.resolve(null)), [id]);
  const act = useAct(() => { k.reload(); onChanged?.(); });
  const [form, setForm] = useState(null);
  const x = k.data;
  return (
    <Sheet visible={!!id} onClose={onClose} title={x?.contract_no ?? 'Contract'}>
      {k.loading && !x ? <Loading /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 6 }}><St s={x.status} /><Tag label={`v${x.version}`} /></View>
        <Card color={c.paper} pad={12}><T size={13} style={{ lineHeight: 20 }}>{x.body}</T></Card>
        <T size={11} color={c.mute}>Fingerprint {x.body_sha256.slice(0, 16)}… {x.accepted_at ? `· accepted ${new Date(x.accepted_at).toLocaleString(locale)}` : ''}</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {!platform && x.status === 'sent' ? <><Btn small title="Accept contract" onPress={() => act(() => api.post(`/contracts/${id}/response`, { action: 'accept' }), 'Contract accepted')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/contracts/${id}/response`, { action: 'decline' }), 'Declined')} /></> : null}
          {platform && x.status === 'draft' ? <Btn small title="Send to partner" onPress={() => act(() => api.post(`/admin/contracts/${id}/send`), 'Sent')} /> : null}
          {platform && ['draft', 'sent', 'active'].includes(x.status) ? <Btn small title="Terminate" color={c.paper} ink={c.red} onPress={() => setForm(true)} /> : null}
        </View>
      </> : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title="Terminate contract" submitLabel="Terminate" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await api.post(`/admin/contracts/${id}/terminate`, v); k.reload(); onChanged?.(); return 'Terminated'; }} />
    </Sheet>
  );
}

function Contracts() {
  const [status, setStatus] = useState(null);
  const l = useLoad(() => api.get('/admin/contracts', { status: status ?? undefined, limit: 100 }), [status]);
  const [open, setOpen] = useState(null);
  return (
    <>
      <Seg options={[{ value: null, label: 'All' }, ...['draft', 'sent', 'active', 'terminated'].map((s) => ({ value: s, label: s }))]} value={status} onChange={setStatus} />
      <Block state={l} empty="No contracts yet. Generate one from a partner or while approving a venue.">
        {(l.data ?? []).map((k) => <Row key={k.id} onPress={() => setOpen(k.id)} title={`${k.contract_no} · v${k.version} · ${k.partner_name}`} sub={`${k.venue_name ?? 'all venues'} · ${pct(k.terms.commission_bp)} · ${k.terms.settlement_cycle}`} right={<St s={k.status} />} />)}
      </Block>
      <ContractView id={open} platform onClose={() => setOpen(null)} onChanged={l.reload} />
    </>
  );
}

function SettlementView({ id, onClose, onChanged, platform }) {
  const s = useLoad(() => (id ? api.get(`/settlements/${id}`) : Promise.resolve(null)), [id]);
  const act = useAct(() => { s.reload(); onChanged?.(); });
  const [form, setForm] = useState(null);
  const x = s.data;
  const row = (t, v, strong) => <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} weight={strong ? '800' : '500'}>{t}</T><T size={13} weight={strong ? '800' : '500'}>{v}</T></View>;
  const csv = async () => { const r = await api.get(`/settlements/${id}`, { format: 'csv' }); if (!download(`${x.settlement_no}.csv`, r.csv)) await act(async () => r, 'CSV ready (open on web to download)'); };
  return (
    <Sheet visible={!!id} onClose={onClose} title={x?.settlement_no ?? 'Settlement'}>
      {s.loading && !x ? <Loading /> : x ? <>
        <View style={{ flexDirection: 'row', gap: 6 }}><St s={x.status} /><Tag label={x.venue_name} /></View>
        {x.flags?.map((f) => <Card key={f.code} color={c.orangeSoft} pad={10}><T size={13}>⚠️ {f.text}</T></Card>)}
        <Card pad={12}>
          {row('Sales (ex-tax)', cash(x.sales_cents, x.currency))}{row('Collected by platform', cash(x.platform_collected_cents, x.currency))}{row('Collected at venue', cash(x.venue_collected_cents, x.currency))}
          {row(`Commission ${pct(x.commission_bp)}`, `− ${cash(x.commission_cents, x.currency)}`)}{row('Tax on commission', `− ${cash(x.commission_tax_cents, x.currency)}`)}{row('Payment costs', `− ${cash(x.gateway_fee_cents, x.currency)}`)}
          {row('Reserve held', `− ${cash(x.reserve_held_cents, x.currency)}`)}{row('Reserve released', `+ ${cash(x.reserve_released_cents, x.currency)}`)}{row('Adjustments', cash(x.adjustments_cents, x.currency))}
          {row(x.net_payable_cents >= 0 ? 'Payable to partner' : 'Owed by partner', cash(Math.abs(x.net_payable_cents), x.currency), true)}
        </Card>
        <T size={12} color={c.mute}>{x.invoices_count} invoices and credit notes · up to {d10(x.period_end)}{x.payout_ref ? ` · payout ${x.payout_ref}` : ''}</T>
        {x.lines.filter((l) => l.kind === 'adjustment').map((l, i) => <T key={i} size={12} color={c.mute}>Adjustment {cash(l.amount_cents, x.currency)} — {l.description}</T>)}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="CSV" color={c.cyan} ink={c.ink} onPress={csv} />
          {platform && x.status === 'draft' ? <><Btn small title="Approve" onPress={() => act(() => api.post(`/admin/settlements/${id}/decision`, { action: 'approve' }), 'Approved')} /><Btn small title="Adjust" color={c.violet} onPress={() => setForm('adjust')} /></> : null}
          {platform && x.status === 'approved' ? <Btn small title="Mark paid" onPress={() => setForm('paid')} /> : null}
          {platform && ['draft', 'approved'].includes(x.status) ? <Btn small title="Void" color={c.paper} ink={c.red} onPress={() => setForm('void')} /> : null}
        </View>
      </> : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={{ adjust: 'Add adjustment', paid: 'Mark as paid', void: 'Void settlement' }[form] ?? ''} submitLabel="Save"
        fields={form === 'adjust' ? [{ key: 'amount', label: 'Amount (negative = debit the partner)', type: 'money', currency: x?.currency }, { key: 'reason', label: 'Reason' }] : form === 'paid' ? [{ key: 'payout_ref', label: 'Payout reference (bank transfer id)' }] : [{ key: 'reason', label: 'Reason' }]}
        onSubmit={async (v) => {
          if (form === 'adjust') await api.post(`/admin/settlements/${id}/adjustments`, { amount_cents: v.amount, reason: v.reason });
          else await api.post(`/admin/settlements/${id}/decision`, { action: form === 'paid' ? 'mark_paid' : 'void', ...v });
          s.reload(); onChanged?.(); return 'Saved';
        }} />
    </Sheet>
  );
}

function Settlements() {
  const [status, setStatus] = useState(null);
  const l = useLoad(() => api.get('/settlements', { status: status ?? undefined, limit: 100 }), [status]);
  const [open, setOpen] = useState(null);
  const [pick, setPick] = useState(false);
  const [venue, setVenue] = useState(null);
  const [prev, setPrev] = useState(null);
  const act = useAct(l.reload);
  const run = async (dry) => { const r = await act(() => api.post('/admin/settlements', { venue_id: venue.id, period_end: iso(0), dry_run: dry }), dry ? 'Preview ready' : 'Draft settlement created'); if (r && dry) setPrev(r); else if (r) { setPrev(null); setVenue(null); setOpen(r.id); } };
  return (
    <>
      <Btn small title="New settlement" onPress={() => setPick(true)} style={{ alignSelf: 'flex-start', marginBottom: 8 }} />
      {venue ? <Card color={c.violetSoft} pad={12}>
        <T weight="800">Settle {venue.name} up to today</T>
        {prev ? <><T size={13}>{prev.invoices_count} invoices · sales {cash(prev.sales_cents, prev.currency)} · commission {cash(prev.commission_cents, prev.currency)} · net {cash(prev.net_payable_cents, prev.currency)} ({prev.contract_no})</T>{prev.flags.map((f) => <T key={f.code} size={12} color={c.orange}>⚠️ {f.text}</T>)}</> : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Btn small title="Preview" color={c.violet} onPress={() => run(true)} /><Btn small title="Create draft" onPress={() => run(false)} disabled={!prev} /><Btn small title="Cancel" color={c.paper} ink={c.ink} onPress={() => { setVenue(null); setPrev(null); }} /></View>
      </Card> : null}
      <Seg options={[{ value: null, label: 'All' }, ...['draft', 'approved', 'paid', 'void'].map((s) => ({ value: s, label: s }))]} value={status} onChange={setStatus} />
      <Block state={l} empty="No settlements yet.">
        {(l.data ?? []).map((s) => <Row key={s.id} onPress={() => setOpen(s.id)} title={`${s.settlement_no} · ${s.venue_name}`} sub={`to ${d10(s.period_end)} · sales ${cash(s.sales_cents, s.currency)} · commission ${cash(s.commission_cents, s.currency)}${s.flags?.length ? ` · ⚠️ ${s.flags.length}` : ''}`} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><St s={s.status} /><T weight="800" size={13}>{cash(s.net_payable_cents, s.currency)}</T></View>} />)}
      </Block>
      <VenuePicker visible={pick} onClose={() => setPick(false)} onPick={(v) => { setVenue(v); setPrev(null); }} title="Which venue?" />
      <SettlementView id={open} platform onClose={() => setOpen(null)} onChanged={l.reload} />
    </>
  );
}

function Reports() {
  const [days, setDays] = useState(30);
  const from = iso(-days), to = iso(0);
  const rev = useLoad(() => api.get('/admin/reports/revenue', { from, to, group_by: days > 120 ? 'month' : 'week', dimension: 'partner' }), [days]);
  const pnl = useLoad(() => api.get('/admin/reports/pnl', { from, to }), [days]);
  const sett = useLoad(() => api.get('/admin/reports/settlements', { from, to }), [days]);
  const [led, setLed] = useState(false);
  const csv = async (path, name) => { const r = await api.get(path, { from, to, format: 'csv' }); download(name, r.csv); };
  return (
    <>
      <Seg options={[{ value: 30, label: '30 days' }, { value: 90, label: '90 days' }, { value: 365, label: 'Year' }]} value={days} onChange={setDays} />
      <Section title="Revenue" color={c.cyan}>
        <Block state={rev}>{(rev.data?.totals ?? []).map((t) => <Card key={t.currency} pad={12}><T weight="800">{t.currency}: sales {cash(t.sales_cents, t.currency)}</T><T size={13} color={c.mute}>refunds {cash(t.refunds_cents, t.currency)} · tax {cash(t.tax_cents, t.currency)} · {t.bookings_invoices} invoices · est. commission {cash(t.estimated_commission_cents, t.currency)}</T></Card>)}
          {(rev.data?.rows ?? []).slice(0, 12).map((r, i) => <Row key={i} title={`${r.dimension} · ${r.period}`} sub={`platform ${cash(r.collected_by_platform_cents, r.currency)} · venue ${cash(r.collected_by_venue_cents, r.currency)}`} right={<T weight="800">{cash(r.sales_cents, r.currency)}</T>} />)}
          {rev.data && !rev.data.rows.length ? <T color={c.mute}>No paid bookings in this range.</T> : null}</Block>
        <Btn small title="Revenue CSV" color={c.paper} ink={c.ink} onPress={() => csv('/admin/reports/revenue', 'revenue.csv')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Profit & loss" color={c.lime}>
        <Block state={pnl}>{(pnl.data?.by_currency ?? []).map((p) => <Card key={p.currency} pad={12}>
          <T weight="800">{p.currency}: net {cash(p.net_profit_cents, p.currency)}{p.margin_pct != null ? ` (${p.margin_pct}% margin)` : ''}</T>
          <T size={13}>Revenue {cash(p.revenue.total_cents, p.currency)} — commission {cash(p.revenue.commission_cents, p.currency)}, payment costs recovered {cash(p.revenue.payment_costs_recovered_cents, p.currency)}</T>
          <T size={13}>Costs {cash(p.costs.total_cents, p.currency)}{p.costs.entries.map((e) => ` · ${label(e.category)} ${cash(e.amount_cents, p.currency)}`).join('')}</T>
          <T size={12} color={c.mute}>Take rate {p.take_rate_pct ?? '—'}% of {cash(p.gross_booking_sales_cents, p.currency)} sales · tax on commission owed {cash(p.commission_tax_liability_cents, p.currency)}</T>
        </Card>)}
          {(pnl.data?.by_partner ?? []).slice(0, 8).map((p, i) => <Row key={i} title={p.partner} sub={`sales ${cash(p.sales_cents, p.currency)}`} right={<T weight="800">{cash(p.commission_cents, p.currency)}</T>} />)}</Block>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="Record cost / revenue" onPress={() => setLed(true)} /><Btn small title="P&L CSV" color={c.paper} ink={c.ink} onPress={() => csv('/admin/reports/pnl', 'pnl.csv')} /></View>
      </Section>
      <Section title="Settlements" color={c.sun}>
        <Block state={sett}>{(sett.data?.by_status ?? []).map((s, i) => <Row key={i} title={`${label(s.status)} · ${s.settlements}`} sub={`sales ${cash(s.sales_cents, s.currency)} · commission ${cash(s.commission_cents, s.currency)}`} right={<T weight="800">{cash(s.net_payable_cents, s.currency)}</T>} />)}</Block>
        <Btn small title="Settlement CSV" color={c.paper} ink={c.ink} onPress={() => csv('/admin/reports/settlements', 'settlements.csv')} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <FormSheet visible={led} onClose={() => setLed(false)} title="Ledger entry" submitLabel="Record" initial={{ kind: 'cost', currency: 'INR', entry_date: iso(0) }}
        fields={[{ key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'cost', label: 'Cost' }, { value: 'revenue', label: 'Revenue' }] }, { key: 'category', label: 'Category', hint: 'e.g. marketing, payment_gateway, onboarding_incentive, subscription_fee' }, { key: 'amount', label: 'Amount', type: 'money', currency: 'INR' }, { key: 'currency', label: 'Currency' }, { key: 'entry_date', label: 'Date', type: 'date' }, { key: 'description', label: 'Note', optional: true }]}
        onSubmit={async (v) => { await api.post('/admin/ledger', { kind: v.kind, category: v.category.toLowerCase().replace(/\s+/g, '_'), amount_cents: v.amount, currency: v.currency, entry_date: v.entry_date, description: v.description || undefined }); pnl.reload(); return 'Recorded'; }} />
    </>
  );
}

function Team() {
  const { user } = useSession();
  const l = useLoad(() => api.get('/admin/platform-users'), []);
  const [add, setAdd] = useState(false);
  const act = useAct(l.reload);
  const owner = user.roles.includes('platform_admin');
  return (
    <>
      <T size={13} color={c.mute}>Platform team members can approve venues, set prices, decide partners and run settlements. Only the platform owner can add or remove them; everyone else is an ordinary app user.</T>
      {owner ? <Btn small title="Add platform user" onPress={() => setAdd(true)} style={{ alignSelf: 'flex-start', marginVertical: 8 }} /> : null}
      <Block state={l}>
        {(l.data ?? []).map((u) => <Row key={u.id} title={u.display_name} sub={`@${u.handle}`} right={u.is_owner ? <Tag label="owner" color={c.lime} /> : owner ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/admin/platform-users/${u.id}`), 'Platform rights removed')} /> : <Tag label="team" />} />)}
      </Block>
      <FormSheet visible={add} onClose={() => setAdd(false)} title="New platform user" submitLabel="Create"
        fields={[{ key: 'display_name', label: 'Name' }, { key: 'handle', label: 'Handle (a-z, 0-9, _)' }, { key: 'email', label: 'Email', type: 'email' }, { key: 'password', label: 'Temporary password (10+ characters)', type: 'secret' }]}
        onSubmit={async (v) => { await api.post('/admin/platform-users', { ...v, handle: v.handle.toLowerCase() }); l.reload(); return 'Platform user created'; }} />
    </>
  );
}

const TABS = [['overview', 'Overview'], ['partners', 'Partners'], ['approvals', 'Venue approvals'], ['pricing', 'Pricing'], ['contracts', 'Contracts'], ['settlements', 'Settlements'], ['reports', 'Reports'], ['team', 'Platform team']];

/** The platform team's partner-management console. */
export function PartnerConsole() {
  const { user } = useSession();
  const [tab, setTab] = useState('overview');
  if (!user.roles.includes('admin')) return <Screen><H1>Partner management</H1><Empty emoji="🔒" title="Platform team only" sub="This console is for SportArena platform staff." /></Screen>;
  const body = { overview: <Overview go={setTab} />, partners: <Partners />, approvals: <Approvals />, pricing: <Pricing />, contracts: <Contracts />, settlements: <Settlements />, reports: <Reports />, team: <Team /> }[tab];
  return (
    <Screen wide>
      <H1>Partner management</H1>
      <T color={c.mute} weight="700">Onboard, price, contract and settle with venue partners.</T>
      <View style={{ marginVertical: 8 }}><Seg options={TABS.map(([value, l]) => ({ value, label: l }))} value={tab} onChange={setTab} /></View>
      {body}
    </Screen>
  );
}

// ------------------------------------------------------------------ the partner's own page
/** "My partner account": status, contract to accept, price requests and counter-offers, settlements and earnings. */
export function MyPartner() {
  const m = useLoad(() => api.get('/me/partner'), []);
  const [contract, setContract] = useState(null);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(false);
  const act = useAct(m.reload);
  const p = m.data;
  return (
    <Screen>
      <H1>Partner account</H1>
      <Block state={m}>
        {!p ? <Empty emoji="🏟️" title="No partner account yet" sub="Register your first venue and the platform team will review it." /> : <>
          <View style={{ flexDirection: 'row', gap: 6 }}><St s={p.status} /><Tag label={p.code} /></View>
          <T size={13} color={c.mute}>{[p.legal_name, p.city, p.has_tax_id ? 'tax id ✓' : 'tax id missing', p.has_payout ? `payout ••••${p.payout_last4}` : 'payout account missing'].filter(Boolean).join(' · ')}</T>
          {['applied', 'onboarding', 'active'].includes(p.status) ? <Btn small title="Update my details" color={c.violet} onPress={() => setEdit(true)} style={{ alignSelf: 'flex-start', marginVertical: 6 }} /> : null}
          <Section title="My venues" color={c.sun}>{p.venues_list.map((v) => <Row key={v.id} title={v.name} sub={v.approval_note ?? v.city} right={<St s={v.paused_by_partner ? 'suspended' : v.approval_status} />} />)}</Section>
          <Section title="Contracts" color={c.cyan}>{p.contracts.length ? p.contracts.map((k) => <Row key={k.id} onPress={() => setContract(k.id)} title={`${k.contract_no} · v${k.version}`} sub={`${pct(k.terms.commission_bp)} commission · ${k.terms.settlement_cycle} settlement`} right={<St s={k.status} />} />) : <T color={c.mute}>You will receive your contract when the platform approves your venue.</T>}</Section>
          <Section title="Price requests" color={c.orange}>
            <T size={12} color={c.mute}>Customers see the price list set by the platform. Changes you ask for wait here for approval.</T>
            {p.price_requests.length ? p.price_requests.map((q) => <Card key={q.id} pad={12}><T weight="800">{label(q.kind)} {q.payload.hourly_rate_cents != null ? cash(q.payload.hourly_rate_cents) : ''}</T><St s={q.status} />
              {q.status === 'countered' ? <><T size={13}>Platform counter-offer: {cash(q.counter.hourly_rate_cents)}</T><View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Btn small title="Accept" onPress={() => act(() => api.post(`/price-requests/${q.id}/response`, { action: 'accept' }), 'Accepted: the price is live')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/price-requests/${q.id}/response`, { action: 'decline' }), 'Declined')} /></View></> : <Btn small title="Withdraw" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/price-requests/${q.id}/response`, { action: 'withdraw' }), 'Withdrawn')} style={{ alignSelf: 'flex-start', marginTop: 6 }} />}</Card>) : <T color={c.mute}>No open requests.</T>}
          </Section>
          <Section title="Settlements" color={c.lime}>{p.settlements.length ? p.settlements.map((s) => <Row key={s.id} onPress={() => setOpen(s.id)} title={s.settlement_no} sub={`to ${d10(s.period_end)} · sales ${cash(s.sales_cents, s.currency)} · commission ${cash(s.commission_cents, s.currency)}`} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><St s={s.status} /><T weight="800" size={13}>{cash(s.net_payable_cents, s.currency)}</T></View>} />) : <T color={c.mute}>Settlements appear here once approved.</T>}</Section>
        </>}
      </Block>
      <ContractView id={contract} onClose={() => setContract(null)} onChanged={m.reload} />
      <SettlementView id={open} onClose={() => setOpen(null)} onChanged={m.reload} />
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="My partner details" submitLabel="Save" initial={{ legal_name: p?.legal_name ?? '', city: p?.city ?? '' }}
        fields={[{ key: 'legal_name', label: 'Legal name', optional: true }, { key: 'city', label: 'City', optional: true }, { key: 'contact_name', label: 'Contact name', optional: true }, { key: 'contact_email', label: 'Contact email', optional: true, type: 'email' }, { key: 'contact_phone', label: 'Contact phone', optional: true, type: 'phone' }, { key: 'tax_id', label: 'Tax id (encrypted)', optional: true }, { key: 'account_holder', label: 'Payout account holder (encrypted)', optional: true }, { key: 'account_number', label: 'Payout account number (encrypted)', optional: true }]}
        onSubmit={async ({ account_holder, account_number, ...v }) => {
          const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
          if (account_holder && account_number) body.payout = { account_holder, account_number };
          await api.patch(`/partners/${p.id}`, body); m.reload(); return 'Saved';
        }} />
    </Screen>
  );
}
