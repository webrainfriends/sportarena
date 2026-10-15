// Legal Services (issue #231): find verified counsel, ask privately for a consultation, follow the quote -> sign -> confirm -> matter steps.
// Lawyers manage admissions, public presence, conflict checks, quotes and matters here; the platform team records each country's local-counsel
// approval. Every action is a capability that exists over REST / OpenAPI / MCP; this screen adds no rules of its own.
// Regulated steps are off per country until qualified local counsel approves that pack, and the screen says so instead of hiding it.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H1, H2, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day, when } from '../theme';
import { moneyIn } from '../vtime';

const label = (v) => String(v).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const endOf = (d) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
const STATE = { conflict_review: ['Conflict check', c.sunSoft], conflict_pending: ['Conflict check', c.sunSoft], conflict_blocked: ['Cannot act', c.orangeSoft], ready: ['Ready', c.mintSoft], declined: ['Declined', c.line], withdrawn: ['Withdrawn', c.line], engaged: ['Matter open', c.lime] };

function Async({ res, empty, children }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  return res.data?.length === 0 && empty ? empty : children(res.data);
}
function useAct(...reloads) {
  const { toast } = useSession();
  return async (fn, msg) => { try { await fn(); toast(msg); reloads.forEach((r) => r?.()); return true; } catch (e) { toast('' + e.message); return false; } };
}
const Row2 = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>{children}</View>;
const usePacks = () => useLoad(() => api.get('/legal/packs'), []);
const areaOpts = (packs) => Object.entries(packs?.practice_areas ?? {}).map(([value, l]) => ({ value, label: l }));
const curOf = (packs, code) => packs?.packs?.find((p) => p.code === code)?.currency ?? 'USD';
const countryOpts = (packs) => (packs?.packs ?? []).map((p) => ({ value: p.code, label: `${p.name}` }));

// ------------------------------------------------------------------ jurisdiction notice
function PackNote({ packs, country }) {
  const p = packs?.packs?.find((x) => x.code === country);
  if (!p) return null;
  const on = p.enabled.length;
  return (
    <Card pad={12} color={on ? c.mintSoft : c.sunSoft}>
      <T weight="800">{p.name}{p.advertising === 'informational_only' ? ' · restricted, informational directory' : ''}</T>
      <T size={12} color={c.mute}>{on ? `Approved by ${p.approval.reviewer}${p.approval.reviewer_firm ? ` (${p.approval.reviewer_firm})` : ''} on ${day(p.approval.reviewed_on)}: ${p.enabled.join(', ')}.` : 'Search and profiles are available. Requests, consultations, quotes and engagement for this country switch on only after qualified local counsel approves it.'}</T>
    </Card>
  );
}

// ------------------------------------------------------------------ Find counsel
function FindCounsel({ packs, onStarted }) {
  const [jur, setJur] = useState('GB'), [area, setArea] = useState(null), [req, setReq] = useState(false), [ask, setAsk] = useState(null);
  const res = useLoad(() => api.get('/legal/counsel', { jurisdiction: jur, ...(area ? { practice_area: area } : {}) }), [jur, area]);
  const mine = useLoad(() => api.get('/legal/requests/mine'), []);
  const act = useAct(mine.reload);
  const aOpts = areaOpts(packs.data);
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={13} color={c.mute}>Where is the matter?</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{countryOpts(packs.data).map((o) => <Chip key={o.value} label={o.label} active={o.value === jur} onPress={() => setJur(o.value)} />)}</View>
      <T weight="800" size={13} color={c.mute}>What kind of help?</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Chip label="Any" active={!area} onPress={() => setArea(null)} />{aOpts.map((o) => <Chip key={o.value} label={o.label} active={o.value === area} onPress={() => setArea(o.value)} />)}</View>
      <PackNote packs={packs.data} country={jur} />
      <Async res={res} empty={<Empty emoji="⚖️" title="No verified counsel listed here yet" sub="Only lawyers with a current, verified admission in this jurisdiction are shown. International experience is not local admission." />}>
        {(rows) => rows.map((l) => (
          <Card key={l.id} pad={14}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="900" size={16}>{l.display_name}</T>{l.headline ? <T size={13} color={c.mute}>{l.headline}</T> : null}<T size={12} color={c.mute}>{l.firm_name ?? 'Independent lawyer'}{l.languages.length ? ` · ${l.languages.join(', ')}` : ''}</T></View>
              <Tag label="Verified admission" color={c.mintSoft} />
            </View>
            {l.admissions.map((a) => (
              <T key={a.jurisdiction + (a.region ?? '')} size={12} color={c.mute} style={{ marginTop: 4 }}>{a.title}, {a.jurisdiction}{a.region ? ` (${a.region})` : ''} · {a.regulator} · verified {day(a.verified_at)}{a.restrictions ? ` · Restrictions: ${a.restrictions}` : ''}</T>
            ))}
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>Fees: {l.fee_models.length ? l.fee_models.map(label).join(', ') : 'quoted per matter'} · {l.delivery_modes.map(label).join(' + ')}</T>
            <Row2>
              {l.admissions.some((a) => a.jurisdiction === jur && a.can_engage_online)
                ? <Btn small title="Request a consultation" color={c.violet} onPress={() => setAsk(l)} />
                : <Tag label="Online consultation not yet enabled for this country" color={c.sunSoft} />}
            </Row2>
          </Card>
        ))}
      </Async>
      <Card pad={12} color={c.violetSoft}>
        <T weight="800">Not sure who to ask?</T>
        <T size={12} color={c.mute}>Post an anonymous request: only the area of law, country, timeframe and budget. No names or details are shared publicly.</T>
        <Row2><Btn small title="Post a request" color={c.pink} onPress={() => setReq(true)} /></Row2>
      </Card>
      <Async res={mine}>{(rows) => rows.length ? <View style={{ gap: 8 }}><H2>My requests</H2>{rows.map((r) => (
        <Card key={r.id} pad={12}><T weight="800">{r.practice_area_label} · {r.jurisdiction}</T><T size={12} color={c.mute}>{label(r.timeframe)}{r.budget_cents != null ? ` · budget ${moneyIn(r.budget_cents, r.currency)}` : ''} · {r.responses} lawyer{r.responses === 1 ? '' : 's'} available · {r.status}</T>
          {r.status === 'open' ? <Row2><Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/legal/requests/${r.id}/close`, {}), 'Request closed')} /></Row2> : null}</Card>))}</View> : null}</Async>
      <FormSheet visible={req} onClose={() => setReq(false)} title="Post an anonymous request" submitLabel="Post"
        initial={{ jurisdiction: jur, practice_area: area ?? 'sports_contracts', timeframe: 'flexible' }}
        fields={[{ key: 'jurisdiction', label: 'Country of the matter', type: 'chips', options: countryOpts(packs.data) }, { key: 'practice_area', label: 'Area of law', type: 'chips', options: aOpts },
          { key: 'timeframe', label: 'How soon?', type: 'choice', options: [{ value: 'urgent', label: 'Urgent' }, { value: 'this_month', label: 'This month' }, { value: 'flexible', label: 'Flexible' }] },
          { key: 'budget_cents', label: 'Budget (optional)', type: 'money', currency: (v) => curOf(packs.data, v.jurisdiction), optional: true }]}
        onSubmit={async (v) => { await api.post('/legal/requests', { ...v, ...(v.budget_cents != null ? { currency: curOf(packs.data, v.jurisdiction) } : {}) }); mine.reload(); return 'Request posted'; }} />
      <FormSheet visible={!!ask} onClose={() => setAsk(null)} title={ask ? `Consultation with ${ask.display_name}` : ''} submitLabel="Send privately"
        initial={{ practice_area: area ?? 'sports_contracts', payer: 'client' }}
        fields={[{ key: 'practice_area', label: 'Area of law', type: 'chips', options: aOpts },
          { key: 'summary', label: 'What do you need help with?', type: 'multiline', hint: 'Private: only this lawyer sees it. Do not send evidence here.' },
          { key: 'client_name', label: 'Legal client (name)', hint: 'Used only for the conflict check.' }, { key: 'counterparty_name', label: 'Other party (name)', optional: true, hint: 'Opponent, club, brand… used only for the conflict check.' },
          { key: 'payer', label: 'Who pays?', type: 'choice', options: [{ value: 'client', label: 'The client' }, { value: 'third_party', label: 'Someone else' }] }]}
        onSubmit={async (v) => { const r = await api.post('/legal/intakes', { lawyer_id: ask.id, jurisdiction: jur, practice_area: v.practice_area, payer: v.payer, summary: v.summary, parties: [{ role: 'client', name: v.client_name }, ...(v.counterparty_name ? [{ role: 'counterparty', name: v.counterparty_name }] : [])] }); onStarted?.(); return r.next; }} />
    </View>
  );
}

// ------------------------------------------------------------------ Intake detail (client and lawyer)
function IntakeSheet({ id, as, packs, onClose, onChanged }) {
  const res = useLoad(() => api.get(`/legal/intakes/${id}`), [id]);
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  const act = useAct(res.reload, onChanged);
  const i = res.data;
  const accepted = i?.quotes?.find((q) => q.status === 'accepted');
  const sent = i?.quotes?.find((q) => q.status === 'sent');
  return (
    <Sheet visible onClose={onClose} title={i ? `${i.practice_area_label} · ${i.jurisdiction}` : 'Consultation'}>
      {res.loading && !i ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : i ? (
        <View style={{ gap: 10 }}>
          <Row2><Tag label={(STATE[i.status] ?? [label(i.status)])[0]} color={(STATE[i.status] ?? [0, c.line])[1]} /><T size={12} color={c.mute}>{as === 'lawyer' ? `Client: ${i.client_name}` : `Lawyer: ${i.lawyer_name}`} · {day(i.created_at)}</T></Row2>
          <Card pad={12}><T weight="800">Summary (private)</T><T size={13}>{i.summary}</T>{i.parties.map((p, k) => <T key={k} size={12} color={c.mute}>{label(p.role)}: {p.name}</T>)}</Card>
          <Card pad={12} color={i.conflict.state === 'blocked' ? c.orangeSoft : c.paper}>
            <T weight="800">Conflict check: {label(i.conflict.state)}</T>
            <T size={12} color={c.mute}>{as === 'lawyer' ? `${i.conflict.match_count} name match${i.conflict.match_count === 1 ? '' : 'es'} with your other matters. A match is only a flag for you to review; nobody else's identity is shown.` : 'The lawyer checks they can act for you before anything else. No engagement exists until you accept a quote and sign.'}</T>
            {as === 'lawyer' && ['conflict_review', 'ready'].includes(i.status) ? <Row2><Btn small title="Clear" color={c.violet} onPress={() => setForm('clear')} /><Btn small title="Waiver" color={c.paper} ink={c.ink} onPress={() => setForm('waived')} /><Btn small title="Cannot act" color={c.paper} ink={c.red} onPress={() => setForm('blocked')} /></Row2> : null}
          </Card>
          {i.quotes.map((q) => (
            <Card key={q.id} pad={12} color={q.status === 'accepted' ? c.mintSoft : c.paper}>
              <T weight="800">Quote v{q.version} · {moneyIn(q.total_cents, q.currency)} {q.is_estimate ? '(estimate)' : '(fixed)'}</T>
              <T size={12} color={c.mute}>{label(q.fee_model)} · fee {moneyIn(q.amount_cents, q.currency)} + tax {moneyIn(q.tax_cents, q.currency)} + disbursements {moneyIn(q.disbursements_cents, q.currency)} · expires {day(q.expires_at)} · {q.status}</T>
              <T size={13}>{q.scope}</T>{q.exclusions ? <T size={12} color={c.mute}>Not included: {q.exclusions}</T> : null}
              {as === 'client' && q.status === 'sent' ? <Row2><Btn small title={`Accept version ${q.version}`} color={c.violet} onPress={() => act(() => api.post(`/legal/quotes/${q.id}/accept`, { version: q.version }), 'Quote accepted — now sign the engagement')} /></Row2> : null}
            </Card>))}
          {i.engagement ? <Card pad={12} color={c.mintSoft}><T weight="800">Engagement signed {when(i.engagement.signed_at)}</T><T size={12} color={c.mute}>Quote v{i.engagement.quote_version} · terms {i.engagement.terms_version} · as {label(i.engagement.signer_capacity)} · {i.engagement.lawyer_confirmed_at ? `confirmed by the lawyer ${when(i.engagement.lawyer_confirmed_at)}` : 'waiting for the lawyer to confirm'}</T></Card> : null}
          {i.matter ? <Card pad={12} color={c.lime}><T weight="900">Matter open</T></Card> : null}
          <Row2>
            {as === 'client' && accepted && !i.engagement ? <Btn title="Sign engagement" color={c.pink} onPress={() => act(() => api.post(`/legal/intakes/${i.id}/engagement`, { quote_version: accepted.version, capacity: 'client', accept_terms: true }), 'Signed — the lawyer confirms next')} /> : null}
            {as === 'lawyer' && i.status === 'ready' && !i.engagement ? <Btn title={sent ? 'Send a new version' : 'Send a quote'} color={c.pink} onPress={() => setForm('quote')} /> : null}
            {as === 'lawyer' && i.engagement && !i.engagement.lawyer_confirmed_at ? <Btn title="Confirm engagement" color={c.violet} onPress={() => act(() => api.post(`/legal/intakes/${i.id}/engagement/confirm`, {}), 'Engagement confirmed')} /> : null}
            {as === 'lawyer' && i.engagement?.lawyer_confirmed_at && !i.matter ? <Btn title="Open the matter" color={c.pink} onPress={() => setForm('matter')} /> : null}
            {as === 'lawyer' && !['declined', 'withdrawn', 'engaged'].includes(i.status) ? <Btn title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/legal/intakes/${i.id}/decline`, {}), 'Declined')} /> : null}
            {as === 'client' && !['declined', 'withdrawn', 'engaged'].includes(i.status) ? <Btn title="Withdraw" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/legal/intakes/${i.id}/withdraw`, {}), 'Withdrawn')} /> : null}
          </Row2>
          <FormSheet visible={['clear', 'waived', 'blocked'].includes(form)} onClose={() => setForm(null)} title={form === 'clear' ? 'Clear the conflict check' : form === 'waived' ? 'Record a waiver' : 'Cannot act'} submitLabel="Record"
            fields={[{ key: 'reason', label: 'Reason', type: 'multiline', hint: form === 'waived' ? 'Who consented, to what, and where it is recorded.' : 'Kept with your name and the time.' }]}
            onSubmit={async (v) => { await api.post(`/legal/intakes/${i.id}/conflict`, { outcome: form, reason: v.reason }); res.reload(); onChanged?.(); return 'Recorded'; }} />
          <FormSheet visible={form === 'quote'} onClose={() => setForm(null)} title="Quote" submitLabel="Send quote"
            initial={{ fee_model: 'flat', is_estimate: false }}
            fields={[{ key: 'fee_model', label: 'Fee model', type: 'chips', options: [['flat', 'Flat fee'], ['hourly', 'Hourly'], ['capped', 'Capped hourly'], ['milestone', 'Milestone'], ['retainer', 'Retainer']].map(([value, l]) => ({ value, label: l })) },
              { key: 'is_estimate', label: 'Estimate rather than fixed', type: 'switch' }, { key: 'amount_cents', label: 'Fee', type: 'money', currency: () => curOf(packs, i.jurisdiction) }, { key: 'tax_cents', label: 'Tax', type: 'money', currency: () => curOf(packs, i.jurisdiction), optional: true },
              { key: 'disbursements_cents', label: 'Disbursements', type: 'money', currency: () => curOf(packs, i.jurisdiction), optional: true },
              { key: 'scope', label: 'Scope', type: 'multiline' }, { key: 'exclusions', label: 'Not included', type: 'multiline', optional: true }, { key: 'expires', label: 'Valid until', type: 'date' }]}
            onSubmit={async (v) => { await api.post(`/legal/intakes/${i.id}/quotes`, { fee_model: v.fee_model, is_estimate: !!v.is_estimate, currency: curOf(packs, i.jurisdiction), amount_cents: v.amount_cents, tax_cents: v.tax_cents ?? 0, disbursements_cents: v.disbursements_cents ?? 0, scope: v.scope, exclusions: v.exclusions, expires_at: endOf(v.expires) }); res.reload(); onChanged?.(); return 'Quote sent'; }} />
          <FormSheet visible={form === 'matter'} onClose={() => setForm(null)} title="Open the matter" submitLabel="Open matter"
            fields={[{ key: 'title', label: 'Matter title' }]}
            onSubmit={async (v) => { await api.post(`/legal/intakes/${i.id}/matter`, { title: v.title }); res.reload(); onChanged?.(); return 'Matter opened'; }} />
        </View>
      ) : null}
    </Sheet>
  );
}

function Consultations({ as, packs }) {
  const res = useLoad(() => api.get('/legal/intakes', { as }), [as]);
  const [open, setOpen] = useState(null);
  return (
    <View style={{ gap: 8 }}>
      <Async res={res} empty={<Empty emoji="💬" title={as === 'lawyer' ? 'No consultation requests yet' : 'No consultations yet'} sub={as === 'lawyer' ? 'Requests addressed to you appear here, with the conflict check first.' : 'Find counsel and ask for a consultation. It stays private between you and that lawyer.'} />}>
        {(rows) => rows.map((r) => (
          <Card key={r.id} pad={12} onPress={() => setOpen(r.id)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <View style={{ flex: 1 }}><T weight="800">{r.practice_area_label} · {r.jurisdiction}</T><T size={12} color={c.mute}>{as === 'lawyer' ? r.client_name : r.lawyer_name} · {day(r.created_at)}</T></View>
              <Tag label={(STATE[r.status] ?? [label(r.status)])[0]} color={(STATE[r.status] ?? [0, c.line])[1]} />
            </View>
          </Card>))}
      </Async>
      {open ? <IntakeSheet id={open} as={as} packs={packs.data} onClose={() => setOpen(null)} onChanged={res.reload} /> : null}
    </View>
  );
}

function Matters({ as }) {
  const res = useLoad(() => api.get('/legal/matters', { as }), [as]);
  return (
    <Async res={res} empty={<Empty emoji="🗂️" title="No matters yet" sub="A matter opens only after a quote is accepted, the engagement is signed and confirmed, and the conflict check is clear." />}>
      {(rows) => rows.map((m) => (
        <Card key={m.id} pad={12}><T weight="800">{m.title}</T><T size={12} color={c.mute}>{as === 'lawyer' ? m.client_name : m.lawyer_name} · {m.jurisdiction} · opened {day(m.activated_at)}</T><Tag label={label(m.status)} color={c.mintSoft} /></Card>))}
    </Async>
  );
}

// ------------------------------------------------------------------ Lawyer practice
function Practice({ packs }) {
  const creds = useLoad(() => api.get('/legal/me/credentials'), []);
  const prof = useLoad(() => api.get('/legal/me/profile'), []);
  const reqs = useLoad(() => api.get('/legal/requests'), []);
  const [form, setForm] = useState(null);
  const act = useAct(creds.reload, prof.reload, reqs.reload);
  const aOpts = areaOpts(packs.data);
  return (
    <View style={{ gap: 10 }}>
      <H2>Where you are admitted</H2>
      <T size={12} color={c.mute}>Each admission counts only once the platform team has verified it (Me → Verification → Verified lawyer, naming the same country). Admission in one jurisdiction never covers another.</T>
      <Btn small title="Add an admission" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setForm('cred')} />
      <Async res={creds} empty={<Empty emoji="🏛️" title="No admissions yet" sub="Add where you are admitted to practise, then request verification." />}>
        {(rows) => rows.map((r) => (
          <Card key={r.id} pad={12}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{r.title} · {r.jurisdiction}{r.region ? ` (${r.region})` : ''}</T><Tag label={r.verified ? `Verified until ${day(r.verified_until)}` : 'Not verified'} color={r.verified ? c.mintSoft : c.sunSoft} /></View>
            <T size={12} color={c.mute}>{r.regulator} · {r.register_ref} · {r.practice_areas.map(label).join(', ')}</T>
            <Row2><Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/legal/me/credentials/${r.id}/archive`, {}), 'Archived — history is kept')} /></Row2></Card>))}
      </Async>
      <H2>Your public presence</H2>
      <T size={12} color={c.mute}>No ratings, win counts, "specialist" labels or free-consultation badges: they are not permitted claims.</T>
      <Card pad={12}>
        {prof.data ? <><T weight="800">{prof.data.headline || 'No headline'}</T><T size={12} color={c.mute}>{prof.data.listed ? 'Listed in Find Counsel' : 'Not listed'} · {prof.data.fee_models.map(label).join(', ') || 'no fee models'}</T></> : <T size={13} color={c.mute}>Not set up yet.</T>}
        <Row2><Btn small title={prof.data ? 'Edit' : 'Set up'} color={c.violet} onPress={() => setForm('prof')} /></Row2>
      </Card>
      <H2>Public requests you can answer</H2>
      <Async res={reqs} empty={<Empty emoji="📭" title="Nothing to answer" sub="Requests appear when they match a verified admission and a practice area in a country whose lawyer responses are approved." />}>
        {(rows) => rows.map((r) => (
          <Card key={r.id} pad={12}><T weight="800">{r.practice_area_label} · {r.jurisdiction}</T><T size={12} color={c.mute}>{label(r.timeframe)}{r.budget_cents != null ? ` · budget ${moneyIn(r.budget_cents, r.currency)}` : ''}</T>
            <Row2>{r.responded ? <Tag label="You said you are available" color={c.mintSoft} /> : <Btn small title="I'm available" color={c.violet} onPress={() => act(() => api.post(`/legal/requests/${r.id}/respond`, {}), 'The requester was told you are available')} />}</Row2></Card>))}
      </Async>
      <FormSheet visible={form === 'cred'} onClose={() => setForm(null)} title="Add an admission" submitLabel="Save"
        fields={[{ key: 'jurisdiction', label: 'Country', type: 'chips', options: countryOpts(packs.data) }, { key: 'region', label: 'State / province / legal system', optional: true }, { key: 'regulator', label: 'Regulator or bar' },
          { key: 'register_ref', label: 'Register / roll number' }, { key: 'title', label: 'Title', hint: 'e.g. Solicitor, Advocate, Attorney' }, { key: 'practice_areas', label: 'Practice areas', type: 'multi', options: aOpts }, { key: 'restrictions', label: 'Restrictions on your practice', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/legal/me/credentials', v); creds.reload(); return 'Saved — request verification under Me'; }} />
      <FormSheet visible={form === 'prof'} onClose={() => setForm(null)} title="Public presence" submitLabel="Save"
        initial={prof.data ?? { delivery_modes: ['remote'], fee_models: [], languages: [] }}
        fields={[{ key: 'headline', label: 'Headline', optional: true }, { key: 'bio', label: 'About', type: 'multiline', optional: true }, { key: 'firm_name', label: 'Firm (display only)', optional: true },
          { key: 'delivery_modes', label: 'Delivery', type: 'multi', options: [{ value: 'remote', label: 'Remote' }, { value: 'in_person', label: 'In person' }] },
          { key: 'fee_models', label: 'Fee models you offer', type: 'multi', options: [['flat', 'Flat fee'], ['hourly', 'Hourly'], ['capped', 'Capped hourly'], ['milestone', 'Milestone'], ['retainer', 'Retainer']].map(([value, l]) => ({ value, label: l })) },
          { key: 'languages_text', label: 'Languages (comma separated)', optional: true }, { key: 'listed', label: 'List me in Find Counsel', type: 'switch' }]}
        onSubmit={async (v) => { const { languages_text, ...rest } = v; await api.post('/legal/me/profile', { ...rest, languages: languages_text ? languages_text.split(',').map((x) => x.trim()).filter(Boolean) : (rest.languages ?? []) }); prof.reload(); return 'Saved'; }} />
    </View>
  );
}

// ------------------------------------------------------------------ Platform team: country approvals
function Approvals({ packs }) {
  const [form, setForm] = useState(null);
  const act = useAct(packs.reload);
  return (
    <View style={{ gap: 8 }}>
      <T size={12} color={c.mute}>Record qualified local counsel's decision per country. Nothing regulated switches on without it. Decisions are append-only.</T>
      {(packs.data?.packs ?? []).map((p) => (
        <Card key={p.code} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{p.name}</T><T size={12} color={c.mute}>{p.regulators.slice(0, 2).join(' · ')}</T></View><Tag label={p.enabled.length ? p.enabled.join(', ') : 'Not approved'} color={p.enabled.length ? c.mintSoft : c.sunSoft} /></View>
          {p.approval ? <T size={11} color={c.mute}>Latest: {p.approval.status} by {p.approval.reviewer}{p.approval.reviewer_firm ? `, ${p.approval.reviewer_firm}` : ''} · reviewed {day(p.approval.reviewed_on)}</T> : null}
          <Row2><Btn small title="Record decision" color={c.violet} onPress={() => setForm(p)} /></Row2>
        </Card>))}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form ? `${form.name} approval` : ''} submitLabel="Record"
        initial={{ status: 'approved', features: form?.enabled ?? [] }}
        fields={[{ key: 'status', label: 'Decision', type: 'choice', options: [{ value: 'approved', label: 'Approve' }, { value: 'withdrawn', label: 'Withdraw' }] },
          { key: 'features', label: 'Switch on', type: 'multi', options: (packs.data?.regulated_features ?? []).map((v) => ({ value: v, label: label(v) })), show: (v) => v.status === 'approved' },
          { key: 'reviewer_name', label: 'Reviewing lawyer' }, { key: 'reviewer_firm', label: 'Firm or chambers', optional: true }, { key: 'reviewed_on', label: 'Review date', type: 'date' }, { key: 'note', label: 'Note', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await act(() => api.post(`/admin/legal/packs/${form.code}/approval`, { ...v, features: v.status === 'approved' ? v.features : [] }), 'Recorded'); return 'Recorded'; }} />
    </View>
  );
}

function PackList({ packs }) {
  return (
    <View style={{ gap: 8 }}>
      <Card pad={12} color={c.violetSoft}><T weight="800">Country is not compliance</T><T size={12} color={c.mute}>These are research anchors, not legal advice. Each country's regulated steps stay off until qualified local counsel approves them. Never offered anywhere: client or trust money, escrow, referral fees, commission on legal fees, contingency fees, automatic court deadlines, AI legal advice.</T></Card>
      {(packs.data?.packs ?? []).map((p) => (
        <Card key={p.code} pad={12}><T weight="800">{p.name}</T><T size={12} color={c.mute}>{p.instruments.join(' · ')}</T><T size={11} color={c.mute} style={{ marginTop: 4 }}>Open questions: {p.open_questions.join(' ')}</T></Card>))}
    </View>
  );
}

// ------------------------------------------------------------------ Home
export function LegalHome() {
  const { has } = useSession();
  const packs = usePacks();
  const lawyer = has('lawyer'), admin = has('admin');
  const [tab, setTab] = useState(lawyer ? 'inbox' : 'find');
  const tabs = [{ value: 'find', label: 'Find counsel', emoji: '⚖️' }, { value: 'consult', label: 'Consultations', emoji: '💬' }, { value: 'matters', label: 'My matters', emoji: '🗂️' },
    ...(lawyer ? [{ value: 'inbox', label: 'Client requests', emoji: '📥' }, { value: 'lmatters', label: 'Matters I run', emoji: '📁' }, { value: 'practice', label: 'Practice', emoji: '🏛️' }] : []),
    ...(admin ? [{ value: 'approvals', label: 'Country approvals', emoji: '✅' }] : []), { value: 'packs', label: 'Countries', emoji: '🌍' }];
  return (
    <Screen>
      <H1>Legal</H1>
      <T size={13} color={c.mute}>Verified lawyers, private consultations and matters. Messages, documents and billing for matters arrive in the next phase.</T>
      <View style={{ marginTop: 10 }}><Seg options={tabs} value={tab} onChange={setTab} /></View>
      <View style={{ gap: 10, marginTop: 8 }}>
        {packs.error ? <ErrorBox error={packs.error} onRetry={packs.reload} /> : null}
        {tab === 'find' && <FindCounsel packs={packs} onStarted={() => setTab('consult')} />}
        {tab === 'consult' && <Consultations as="client" packs={packs} />}
        {tab === 'matters' && <Matters as="client" />}
        {tab === 'inbox' && lawyer && <Consultations as="lawyer" packs={packs} />}
        {tab === 'lmatters' && lawyer && <Matters as="lawyer" />}
        {tab === 'practice' && lawyer && <Practice packs={packs} />}
        {tab === 'approvals' && admin && <Approvals packs={packs} />}
        {tab === 'packs' && <PackList packs={packs} />}
      </View>
    </Screen>
  );
}
