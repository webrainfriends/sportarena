// Insurance for people, teams and events: find an insurer, compare plans, ask for a quote, track it, accept (cover is assigned),
// pay, renew, keep the paperwork, claim. Insurers run their side from the Insurer desk (./insurer.js).
import React, { useState } from 'react';
import { Image, Linking, Modal, Platform, Pressable, View } from 'react-native';
import { api, API, authHeader } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { PaySheet } from '../PaySheet';
import { c, day, money } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';

const COVER = { individual: 'Me', team: 'A team', event: 'Event or tournament', venue: 'A venue' };
const EMOJI = { individual: '🧍', team: '🛡️', event: '🎟️', venue: '🏟️' };
export const nice = (s = '') => String(s).replace(/_/g, ' ');
const TONE = { offered: c.cyan, accepted: c.mint, active: c.mint, approved: c.mint, paid: c.mint, quoted: c.cyan, open: c.sun, submitted: c.sun, under_review: c.sun, pending_payment: c.sun, declined: c.violetSoft, withdrawn: c.violetSoft, cancelled: c.violetSoft, expired: c.violetSoft, rejected: c.red };
export const StatusTag = ({ s }) => <Tag label={nice(s)} color={TONE[s] ?? c.violetSoft} />;
const cur = (cents, currency) => (currency ? moneyIn(Number(cents), currency) : money(Number(cents)));
export const dayY = (v) => new Date(v).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
const ACTION = { requested: 'Request sent', quote_sent: 'Quote received', quote_accepted: 'Quote accepted, cover assigned', quote_declined: 'Quote declined', quote_withdrawn: 'Quote withdrawn', quote_expired: 'Quote expired', accepted: 'Request closed', cancelled: 'Request cancelled', insurer_declined: 'Insurer passed' };

// ----------------------------------------------------------------------------------------------------------- documents

export async function pickDocument() {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/pdf,image/jpeg,image/png,image/webp,image/gif';
      input.onchange = () => resolve(input.files?.[0] ? { blob: input.files[0], name: input.files[0].name } : null);
      input.click();
    });
  }
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
  if (r.canceled || !r.assets?.[0]) return null;
  return { blob: await (await fetch(r.assets[0].uri)).blob(), name: r.assets[0].fileName };
}

const KIND_LABEL = { policy: 'Policy', policy_schedule: 'Policy schedule', certificate: 'Certificate', receipt: 'Receipt', quote: 'Quote', claim_evidence: 'Claim evidence', other: 'Other' };

/**
 * The locker for one policy, quote or claim (`parent` is { policy_id } | { quote_id } | { claim_id }), or the documents folder of a
 * team, event or venue (`subject` is { subject_type, subject_id }; `canEdit` says whether this person may add and hide files).
 * `linkable` (policy lockers of a team / event / venue): each file can be saved to that folder.
 */
export function DocumentsSheet({ parent, subject, canEdit, linkable, title, kinds, onClose, onChanged, readOnly }) {
  const { user, toast } = useSession();
  const scope = subject ?? parent;
  const base = subject ? '/documents' : '/insurance/documents';
  const docs = useLoad(() => (scope ? api.get(base, scope) : Promise.resolve([])), [JSON.stringify(scope)]);
  const mayRemove = (d) => (subject ? !!canEdit : d.uploaded_by === user.id);
  const [kind, setKind] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState(null);
  const k = kind ?? kinds[0];
  const add = async () => {
    const f = await pickDocument();
    if (!f) return;
    setBusy(true);
    try { await api.upload(base, f.blob, { ...scope, kind: k, title: name.trim() || (f.name ?? '').slice(0, 120) }); setName(''); await docs.reload(); onChanged?.(); toast('Saved to your documents'); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const open = async (d) => {
    try {
      if (Platform.OS === 'web') { const url = URL.createObjectURL(await api.download(`${base}/${d.id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); }
      else if (d.content_type.startsWith('image/')) setImg(d);
      else toast('Open PDFs in the web app');
    } catch (e) { toast(e.message); }
  };
  const remove = async (d) => { try { await api.del(`${base}/${d.id}`); await docs.reload(); onChanged?.(); } catch (e) { toast(e.message); } };
  const save = async (d) => { try { const r = await api.post('/documents/link', { insurance_document_id: d.id }); toast(r.already_linked ? 'Already in the documents folder' : 'Saved to the documents folder'); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible={!!scope} onClose={onClose} title={title}>
      <T size={12} color={c.mute}>{subject ? 'PDF or photo, up to 10 MB each. Files are encrypted on the server. Everyone in the team, event or venue can open them; the people who manage it add and hide them. Removing one only hides it.' : 'PDF or photo, up to 10 MB each. Files are encrypted on the server and only the policy holder, the people who manage what is covered, and the insurer can open them. Removing one only hides it.'}</T>
      {docs.loading ? <Loading /> : docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : docs.data?.length ? docs.data.map((d) => (
        <Card key={d.id} pad={12}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={22}>{d.content_type === 'application/pdf' ? '📄' : '🖼️'}</T>
            <View style={{ flex: 1 }}><T weight="700">{d.title}</T><T size={12} color={c.mute}>{KIND_LABEL[d.kind]} · {Math.max(1, Math.round(d.size_bytes / 1024))} KB · {day(d.created_at)}{d.uploaded_by !== user.id ? ` · from ${d.uploaded_by_name}` : ''}{d.from_insurance ? ' · policy paperwork' : ''}</T></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Open" color={c.violet} onPress={() => open(d)} />
            {linkable ? <Btn small title="Save to documents" color={c.paper} ink={c.violet} onPress={() => save(d)} /> : null}
            {mayRemove(d) ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => remove(d)} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🗂️" title="No documents yet" sub={subject ? 'Add the approved or paid policy, certificate and receipts so everyone can find them.' : 'Add your schedule, certificate or receipts so they are always at hand.'} />}
      {readOnly || (subject && !canEdit) ? null : <View style={{ gap: 8 }}>
        <T weight="800" size={13}>Add a document</T>
        {kinds.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{kinds.map((x) => <Chip key={x} label={KIND_LABEL[x]} active={x === k} onPress={() => setKind(x)} />)}</View> : null}
        <Field value={name} onChangeText={setName} placeholder="Name (optional)" />
        <Btn title="Choose a file" onPress={add} loading={busy} />
      </View>}
      <Modal visible={!!img} transparent animationType="fade" onRequestClose={() => setImg(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', padding: 12 }}>
          <Pressable onPress={() => setImg(null)} style={{ position: 'absolute', top: 24, right: 20, zIndex: 2, padding: 8 }}><T size={26} color="#fff">✕</T></Pressable>
          {img ? <Image source={{ uri: `${API}${base}/${img.id}/file`, headers: authHeader() }} resizeMode="contain" style={{ width: '100%', height: 520 }} /> : null}
        </View>
      </Modal>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------- team / event / venue panel

/** Insurance and documents for a team, event or venue: its policies, open requests, "ask for quotes" and the documents folder. */
export function SubjectPanel({ type, id, name, canEdit = true }) {
  const { push } = useNav();
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState(null);
  const pol = useLoad(() => api.get('/insurance/policies', { limit: 50 }), [id]);
  const reqs = useLoad(() => api.get('/insurance/quote-requests', { limit: 50 }), [id]);
  const mine = (pol.data ?? []).filter((p) => p.subject_type === type && p.subject_id === id);
  const asked = (reqs.data ?? []).filter((x) => x.cover_for === type && x.subject_id === id && ['open', 'quoted'].includes(x.status));
  return (
    <>
      <Section title="Insurance" color={c.cyan}>
        {pol.loading && !pol.data ? <Loading /> : mine.length ? mine.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.plan_name}</T><StatusTag s={p.effective_status} /></View>
            <T size={12} color={c.mute}>{p.insurer} · {dayY(p.starts_on)} to {dayY(p.ends_on)}</T>
          </Card>
        )) : <Empty emoji="🛡️" title="Not insured yet" sub="Ask insurers for quotes, compare what comes back and keep the approved policy with the documents." />}
        {asked.map((x) => <Card key={x.id} pad={12} onPress={() => push('Insurance')}><T weight="800">Quote request open</T><T size={12} color={c.mute}>{x.open_quotes ? `${x.open_quotes} quote${x.open_quotes === 1 ? '' : 's'} to review` : 'Waiting for quotes'} · {x.insurer ? `to ${x.insurer}` : 'open to all insurers'}</T></Card>)}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Btn small title="Ask for insurance quotes" onPress={() => setQuote({ cover_for: type, subject_id: id })} />
          <Btn small title="Open Insurance" color={c.paper} ink={c.ink} onPress={() => push('Insurance')} />
        </View>
      </Section>
      <Section title="Documents" color={c.violet}>
        <T size={13} color={c.mute}>Approved or paid policies, certificates and receipts. Everyone involved can open them{canEdit ? '; you add and hide them' : ''}.</T>
        <Btn title="Open documents" onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <DocumentsSheet subject={open ? { subject_type: type, subject_id: id } : null} canEdit={canEdit} title={`${name}: documents`} kinds={['policy', 'certificate', 'receipt', 'quote', 'other']} onClose={() => setOpen(false)} />
      <QuoteRequestSheet target={quote} onClose={() => setQuote(null)} onDone={() => { setQuote(null); reqs.reload(); }} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------- asking and buying

/** "Get a quote": for me, a team I play or work in, an event I organise or a venue I run. target = { plan?, insurer? } (either narrows who is asked). */
export function QuoteRequestSheet({ target, onClose, onDone }) {
  const { user } = useSession();
  const teams = useLoad(() => api.get('/teams', { mine: true }), []);
  const evs = useLoad(() => api.get('/events', { organizer_id: user.id, limit: 50 }), []);
  const venues = useLoad(() => api.get('/me/venues').catch(() => []), []);
  const plan = target?.plan, insurer = target?.insurer;
  const mineTeams = teams.data ?? [];
  return (
    <FormSheet visible={!!target} onClose={onClose} title={plan ? `Quote for ${plan.name}` : insurer ? `Ask ${insurer.name}` : 'Ask for a quote'} submitLabel="Send request"
      initial={{ cover_for: plan?.cover_for ?? target?.cover_for ?? 'individual', ...(target?.subject_id ? { subject_id: target.subject_id } : {}), months: plan ? Math.min(Math.max(12, plan.term_months.min), plan.term_months.max) : 12 }}
      fields={[
        ...(plan ? [] : [{ key: 'cover_for', label: 'What do you want covered?', type: 'choice', options: Object.entries(COVER).map(([value, label]) => ({ value, label })), hint: insurer ? undefined : 'Without picking an insurer this goes to every insurer on the Billboard, and you can compare all the quotes that come back.' }]),
        { key: 'subject_id', label: 'Which team?', type: 'choice', options: mineTeams.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })), show: (v) => v.cover_for === 'team', hint: mineTeams.length ? 'Players and coaches can ask; the team\'s managers compare and accept.' : 'You are not in a team yet.' },
        { key: 'subject_id', label: 'Which event or tournament?', type: 'choice', options: (evs.data ?? []).map((e) => ({ value: e.id, label: `${e.banner_emoji ?? '🏆'} ${e.name}` })), show: (v) => v.cover_for === 'event', hint: evs.data?.length ? undefined : 'You do not organise an event yet.' },
        { key: 'subject_id', label: 'Which venue?', type: 'choice', options: (venues.data ?? []).map((x) => ({ value: x.id, label: `${x.emoji ?? '🏟️'} ${x.name}` })), show: (v) => v.cover_for === 'venue', hint: venues.data?.length ? undefined : 'You do not run a venue yet.' },
        { key: 'months', label: 'How long (months)', type: 'stepper', min: plan?.term_months.min ?? 1, max: plan?.term_months.max ?? 36, suffix: ' mo' },
        { key: 'participants', label: 'How many people are covered?', type: 'number', optional: true, show: (v) => v.cover_for !== 'individual', hint: 'Squad size or expected entrants: insurers price on this.' },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true },
        { key: 'city', label: 'City', type: 'text', optional: true, hint: 'So insurers near you find the request. Defaults to your team\'s or venue\'s city.' },
        { key: 'message', label: 'Anything the insurer should know', type: 'multiline', optional: true, hint: 'Encrypted. Only the insurers this goes to can read it.' },
      ]}
      onSubmit={async (v) => {
        await api.post('/insurance/quote-requests', { ...v, ...(plan ? { plan_id: plan.id } : {}), ...(!plan && insurer ? { insurer_id: insurer.id } : {}), ...(v.cover_for === 'individual' ? { subject_id: undefined } : {}) });
        onDone?.(); return 'Request sent: follow it under Quotes & requests';
      }} />
  );
}

/** Buy a plan at its listed premium. */
function BuySheet({ plan, onClose, onBought }) {
  const { user } = useSession();
  const teams = useLoad(() => api.get('/teams', { mine: true }), []);
  const evs = useLoad(() => api.get('/events', { organizer_id: user.id, limit: 50 }), []);
  return (
    <FormSheet visible={!!plan} onClose={onClose} title={plan?.name ?? ''} submitLabel="Buy cover" initial={{ months: plan ? Math.min(Math.max(12, plan.term_months.min), plan.term_months.max) : 12 }}
      fields={[
        ...(plan?.cover_for === 'team' ? [{ key: 'subject_id', label: 'Which team?', type: 'choice', options: (teams.data ?? []).map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })) }] : []),
        ...(plan?.cover_for === 'event' ? [{ key: 'subject_id', label: 'Which event or tournament?', type: 'choice', options: (evs.data ?? []).map((e) => ({ value: e.id, label: `${e.banner_emoji ?? '🏆'} ${e.name}` })) }] : []),
        { key: 'months', label: `Months (${plan ? cur(plan.premium_cents, plan.currency) : ''} a month)`, type: 'stepper', min: plan?.term_months.min ?? 1, max: plan?.term_months.max ?? 36, suffix: ' mo' },
        { key: 'beneficiary', label: 'Beneficiary', optional: true, hint: 'Encrypted.' },
      ]}
      onSubmit={async (v) => { const p = await api.post('/insurance/policies', { plan_id: plan.id, ...v }); return onBought(p, plan); }} />
  );
}

/** The two sheets a plan card opens. state = { buy?, quote? }. */
export function PlanSheets({ state, setState, onChanged, onPay }) {
  const close = () => setState({});
  return (
    <>
      <BuySheet plan={state.buy} onClose={close} onBought={(p, plan) => { onChanged?.(); if (p.status === 'pending_payment') { onPay({ type: 'insurance_policy', id: p.id, amount: p.premium_cents, currency: plan.currency, label: plan.name }); return 'Policy created: pay to activate it'; } return `You are covered: ${cur(p.premium_cents, plan.currency)} for ${plan.name}`; }} />
      <QuoteRequestSheet target={state.quote} onClose={close} onDone={onChanged} />
    </>
  );
}

export function PlanCard({ p, i = 0, picked, onPick, onBuy, onQuote, onInsurer }) {
  return (
    <Card color={[c.pinkSoft, c.violetSoft, c.limeSoft][i % 3]}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={p.emoji} color={c.paper} />
        <View style={{ flex: 1 }}><T weight="900" size={17}>{p.name}</T>
          <Pressable disabled={!onInsurer} onPress={() => onInsurer?.(p)}><T size={12} color={c.mute}>{p.insurer}{p.insurer_verified ? ' ✓ verified' : ''} · for {p.cover_for}{onInsurer ? ' ›' : ''}</T></Pressable></View></View>
      {p.offer ? <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, alignItems: 'center' }}><Tag label="Offer" color={c.sun} /><T size={13} weight="700" style={{ flex: 1 }}>{p.offer}{p.offer_ends_on ? ` · until ${day(p.offer_ends_on)}` : ''}</T></View> : null}
      {p.description ? <T size={13} style={{ marginTop: 6 }}>{p.description}</T> : null}
      <T size={12} color={c.mute} style={{ marginTop: 6 }}>Excess {cur(p.deductible_cents, p.currency)} · waiting period {p.waiting_period_days} days · {p.term_months.min}–{p.term_months.max} months{p.eligibility.min_age != null || p.eligibility.max_age != null ? ` · ages ${p.eligibility.min_age ?? 0}–${p.eligibility.max_age ?? 'any'}` : ''}{p.eligibility.sports.length ? ` · ${p.eligibility.sports.join(', ')}` : ''}</T>
      {p.exclusions ? <T size={12} style={{ marginTop: 4 }}><T size={12} weight="800">Not covered: </T>{p.exclusions}</T> : null}
      {p.conditions ? <T size={12} style={{ marginTop: 2 }}><T size={12} weight="800">Conditions: </T>{p.conditions}</T> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
        <T weight="900">{cur(p.premium_cents, p.currency)}<T size={12} color={c.mute}>/mo · cover {cur(p.coverage_cents, p.currency)}</T></T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {onPick ? <Chip label={picked ? '✓ Comparing' : 'Compare'} active={picked} onPress={() => onPick(p)} /> : null}
          <Btn small title="Get a quote" color={c.paper} ink={c.pink} onPress={() => onQuote(p)} />
          <Btn small title="Get cover" color={c.pink} onPress={() => onBuy(p)} />
        </View>
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ quotes and requests

/** One quote in full: the terms (with what is not covered), what happened to it, and accept / decline. */
export function QuoteSheet({ id, onClose, onChanged, onPay }) {
  const { toast } = useSession();
  const q = useLoad(() => (id ? api.get(`/insurance/quotes/${id}`) : Promise.resolve(null)), [id]);
  const [busy, setBusy] = useState(false);
  const [ben, setBen] = useState('');
  const d = q.data;
  const live = d?.status === 'offered';
  const act = async (fn) => { setBusy(true); try { await fn(); } catch (e) { toast(e.message); } finally { setBusy(false); } };
  return (
    <Sheet visible={!!id} onClose={onClose} title="Quote">
      {q.loading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : d ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Bubble emoji={d.emoji} color={c.cyanSoft} /><View style={{ flex: 1 }}><T weight="900" size={17}>{d.plan_name}</T><T size={12} color={c.mute}>{d.insurer}{d.insurer_verified ? ' ✓ verified' : ''} · {EMOJI[d.cover_for]} {d.subject_name ?? COVER[d.cover_for]}</T></View><StatusTag s={d.status} /></View>
          <Card color={c.cyanSoft} pad={14}>
            <T weight="900" size={22}>{cur(d.total_cents, d.currency)}<T size={13} color={c.mute}> for {d.months} months</T></T>
            <T size={13} color={c.mute}>{cur(d.premium_cents, d.currency)} a month</T>
            <T size={13} style={{ marginTop: 6 }}>Cover up to <T weight="800">{cur(d.coverage_cents, d.currency)}</T> · excess {cur(d.deductible_cents, d.currency)} · waiting period {d.waiting_period_days} days</T>
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>Valid until {day(d.valid_until)}</T>
            {d.note ? <T size={13} style={{ marginTop: 6 }}>“{d.note}”</T> : null}
            {d.details ? <T size={13} style={{ marginTop: 6 }}><T size={13} weight="800">Insurer's own terms: </T>{d.details}</T> : null}
          </Card>
          {d.exclusions ? <T size={13}><T size={13} weight="800">Not covered: </T>{d.exclusions}</T> : null}
          {d.conditions ? <T size={13}><T size={13} weight="800">Conditions: </T>{d.conditions}</T> : null}
          {d.events.map((e) => <T key={e.id} size={12} color={c.mute}>• {ACTION[e.action] ?? nice(e.action)} · {e.actor ?? 'SportArena'} · {day(e.created_at)}{e.detail ? ` · ${e.detail}` : ''}</T>)}
          {live ? (
            <View style={{ gap: 8 }}>
              <Field value={ben} onChangeText={setBen} placeholder="Beneficiary (optional, encrypted)" />
              <Btn title="Accept and get covered" loading={busy} onPress={() => act(async () => {
                const p = await api.post(`/insurance/quotes/${d.id}/accept`, { ...(ben.trim() ? { beneficiary: ben.trim() } : {}) });
                onChanged?.(); onClose();
                if (p.status === 'pending_payment') { onPay?.({ type: 'insurance_policy', id: p.id, amount: p.premium_cents, currency: d.currency, label: d.plan_name }); toast('Cover assigned: pay to activate it'); } else toast('You are covered');
              })} />
              <Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(async () => { await api.post(`/insurance/quotes/${d.id}/decline`, {}); onChanged?.(); onClose(); toast('Quote declined'); })} />
            </View>
          ) : d.status === 'accepted' ? <T size={13} color={c.mute}>Accepted: find the policy under Your policies.</T> : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** A quote request: the tracker, the quotes it has, the conversation. Buyer view by default; asInsurer adds quote / decline. */
export function RequestSheet({ id, asInsurer, onClose, onChanged, onQuote, onOpenQuote }) {
  const { toast } = useSession();
  const r = useLoad(() => (id ? api.get(`/insurance/quote-requests/${id}`) : Promise.resolve(null)), [id]);
  const [text, setText] = useState('');
  const [to, setTo] = useState(null);
  const d = r.data;
  const insurers = d ? [...new Map([...(d.insurer_id ? [[d.insurer_id, d.insurer]] : []), ...d.quotes.map((q) => [q.insurer_id, q.insurer]), ...d.messages.map((m) => [m.insurer_id, m.insurer])]).entries()] : [];
  const target = asInsurer ? null : (to ?? insurers[0]?.[0] ?? null);
  const live = d && ['open', 'quoted'].includes(d.status);
  const send = async () => {
    try { await api.post(`/insurance/quote-requests/${id}/messages`, { body: text.trim(), ...(target ? { insurer_id: target } : {}) }); setText(''); await r.reload(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible={!!id} onClose={onClose} title={d?.subject_name ?? 'Quote request'}>
      {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StatusTag s={d.status} /><T size={13} color={c.mute}>{EMOJI[d.cover_for]} {COVER[d.cover_for]} · {d.months} months{d.participants ? ` · ${d.participants} people` : ''}{d.sport ? ` · ${d.sport}` : ''}</T></View>
          <T size={13} color={c.mute}>{asInsurer ? `From ${d.requester}` : d.insurer ? `Sent to ${d.insurer}` : 'Open to every insurer taking requests'}{d.plan_name ? ` · about ${d.plan_name}` : ''}</T>
          {d.message ? <Card pad={12} color={c.violetSoft}><T size={13}>{d.message}</T></Card> : null}
          <T weight="800" size={13}>Where it stands</T>
          {d.events.map((e) => <T key={e.id} size={12} color={c.mute}>• {ACTION[e.action] ?? nice(e.action)}{e.actor && e.action !== 'requested' ? ` · ${e.actor}` : ''} · {day(e.created_at)}{e.detail && e.action !== 'requested' ? ` · ${e.detail}` : ''}</T>)}
          <T weight="800" size={13} style={{ marginTop: 4 }}>{asInsurer ? 'Your quote' : 'Quotes'} ({d.quotes.length})</T>
          {d.quotes.length ? d.quotes.map((q) => (
            <Card key={q.id} pad={12} color={c.cyanSoft}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{q.insurer}{q.insurer_verified ? ' ✓' : ''} · {q.plan_name}</T><StatusTag s={q.status} /></View>
              <T size={14} weight="900">{cur(q.total_cents, q.currency)}<T size={12} color={c.mute}> / {q.months} mo · cover {cur(q.coverage_cents, q.currency)}</T></T>
              <T size={12} color={c.mute}>Excess {cur(q.deductible_cents, q.currency)} · wait {q.waiting_period_days} days · valid until {day(q.valid_until)}</T>
              {!asInsurer && q.status === 'offered' ? <Btn small title="Review and accept" onPress={() => onOpenQuote?.(q.id)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
              {asInsurer && q.status === 'offered' ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/insurance/quotes/${q.id}/withdraw`); await r.reload(); onChanged?.(); } catch (e) { toast(e.message); } }} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
            </Card>
          )) : <T size={13} color={c.mute}>{asInsurer ? 'You have not quoted yet.' : 'No quotes yet. Insurers are notified; you will be told when one arrives.'}</T>}
          {(asInsurer || insurers.length) && ['open', 'quoted', 'accepted'].includes(d.status) ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={13}>Messages</T>
              {d.messages.map((m) => <Card key={m.id} pad={10} color={c.violetSoft}><T size={12} color={c.mute}>{m.sender}{!asInsurer ? ` · ${m.insurer}` : ''} · {day(m.created_at)}</T><T size={13}>{m.body}</T></Card>)}
              {!asInsurer && insurers.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{insurers.map(([iid, name]) => <Chip key={iid} label={name} active={iid === target} onPress={() => setTo(iid)} />)}</View> : null}
              <Field value={text} onChangeText={setText} multiline placeholder={asInsurer ? `Reply to ${d.requester}` : 'Ask the insurer a question'} />
              <Btn small title="Send" disabled={!text.trim()} onPress={send} style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : null}
          {live && asInsurer ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn title={d.quotes?.length ? 'Quote with another plan' : 'Send a quote'} onPress={() => onQuote?.(d)} />
              <Btn title="Pass" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/insurance/quote-requests/${d.id}/decline`, {}); onChanged?.(); onClose(); toast('Passed on this request'); } catch (e) { toast(e.message); } }} />
            </View>
          ) : null}
          {live && !asInsurer ? <Btn small title="Cancel this request" color={c.paper} ink={c.red} onPress={async () => { try { await api.post(`/insurance/quote-requests/${d.id}/cancel`); await r.reload(); onChanged?.(); } catch (e) { toast(e.message); } }} style={{ alignSelf: 'flex-start' }} /> : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** Requests I made and offers sent to me, with where each one stands. */
function QuotesSection({ reloadKey, onChanged, onPay }) {
  const { user } = useSession();
  const reqs = useLoad(() => api.get('/insurance/quote-requests', { limit: 30 }), [reloadKey]);
  const offers = useLoad(() => api.get('/insurance/quotes', { limit: 50 }), [reloadKey]);
  const [open, setOpen] = useState(null);
  const [quote, setQuote] = useState(null);
  const direct = (offers.data ?? []).filter((q) => !q.request_id && q.status === 'offered');
  const reload = () => { reqs.reload(); offers.reload(); onChanged?.(); };
  return (
    <Section title="Quotes & requests" color={c.sun}>
      {direct.map((q) => (
        <Card key={q.id} color={c.sunSoft} pad={12} onPress={() => setQuote(q.id)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="800" style={{ flex: 1 }}>{q.insurer} sent you a quote</T><StatusTag s={q.status} /></View>
          <T size={13}>{q.plan_name} · {cur(q.total_cents, q.currency)} for {q.months} months · valid until {day(q.valid_until)}</T>
        </Card>
      ))}
      {reqs.data?.length ? reqs.data.map((r) => (
        <Card key={r.id} pad={12} onPress={() => setOpen(r.id)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{EMOJI[r.cover_for]} {r.subject_name ?? COVER[r.cover_for]}</T><StatusTag s={r.status} /></View>
          <T size={12} color={c.mute}>{r.insurer ? `To ${r.insurer}` : 'Open to all insurers (Billboard)'} · {r.months} months · asked {day(r.created_at)}{r.requester_id !== user.id ? ` by ${r.requester}` : ''}</T>
          <T size={13} weight="700" color={r.open_quotes ? c.pink : c.mute}>{r.open_quotes ? `${r.open_quotes} quote${r.open_quotes === 1 ? '' : 's'} to review` : r.quotes ? `${r.quotes} quote${r.quotes === 1 ? '' : 's'} so far` : 'Waiting for quotes'}</T>
        </Card>
      )) : !direct.length ? <Empty emoji="📨" title="No requests yet" sub="Ask an insurer for a quote on yourself, your team or your event." /> : null}
      <RequestSheet id={open} onClose={() => setOpen(null)} onChanged={reload} onOpenQuote={(id) => { setOpen(null); setQuote(id); }} />
      <QuoteSheet id={quote} onClose={() => setQuote(null)} onChanged={reload} onPay={onPay} />
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------------ policies

function PolicyCard({ p, onClaim, onDocs, onRenew, onPay }) {
  const lapsed = p.effective_status === 'expired';
  const left = p.days_left;
  return (
    <Card color={c.cyanSoft}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={p.emoji} color={c.paper} />
        <View style={{ flex: 1 }}><T weight="900">{p.plan_name}</T><T size={12} color={c.mute}>{p.insurer} · {p.policy_no} · {dayY(p.starts_on)} to {dayY(p.ends_on)}</T></View><StatusTag s={p.effective_status} /></View>
      <T size={13} style={{ marginTop: 6 }}>Covers up to <T weight="900">{cur(p.coverage_cents, p.terms?.currency)}</T> · {EMOJI[p.subject_type]} {p.subject_name ?? COVER[p.subject_type]}</T>
      {p.status === 'active' ? <T size={13} weight="700" color={lapsed ? c.red : left <= 30 ? c.orange : c.mute} style={{ marginTop: 4 }}>{lapsed ? `Ended ${-left} day${left === -1 ? '' : 's'} ago` : left === 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`}{p.renewed_by ? ' · renewed ✓' : ''}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {p.status === 'pending_payment' ? <Btn small title="Pay now" onPress={() => onPay({ type: 'insurance_policy', id: p.id, amount: p.amount_cents, currency: p.terms?.currency, label: p.plan_name })} /> : null}
        {p.status === 'active' && !p.renewed_by && left <= 60 && left >= -30 ? <Btn small title={p.renewal_due || lapsed ? 'Renew now' : 'Renew early'} color={p.renewal_due || lapsed ? c.pink : c.paper} ink={c.pink} onPress={() => onRenew(p)} /> : null}
        {p.status === 'active' && !lapsed ? <Btn small title="File a claim" color={c.ink} onPress={() => onClaim(p)} /> : null}
        <Btn small title={`Documents${p.documents ? ` (${p.documents})` : ''}`} color={c.paper} ink={c.ink} onPress={() => onDocs(p)} />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------- screen

export function Insurance() {
  const { toast, has } = useSession();
  const { push } = useNav();
  const [state, setState] = useState({});
  const [paying, setPaying] = useState(null);
  const [claim, setClaim] = useState(null);
  const [renew, setRenew] = useState(null);
  const [docs, setDocs] = useState(null);
  const [tick, setTick] = useState(0);
  const [f, setF] = useState({ q: '', sort: 'premium', cover_for: '', verified: false });
  const [picked, setPicked] = useState([]);
  const [cmp, setCmp] = useState(null);
  const plans = useLoad(() => api.get('/insurance/plans', { sort: f.sort, limit: 50, ...(f.q.trim() ? { q: f.q.trim() } : {}), ...(f.cover_for ? { cover_for: f.cover_for } : {}), ...(f.verified ? { verified_insurer: true } : {}) }), [f.q, f.sort, f.cover_for, f.verified]);
  const insurers = useLoad(() => api.get('/insurance/insurers', { limit: 30 }), []);
  const claims = useLoad(() => api.get('/insurance/claims', { limit: 20 }), []);
  const pol = useLoad(() => api.get('/insurance/policies', { limit: 50 }), [tick]);
  const changed = () => { pol.reload(); setTick((x) => x + 1); };
  const due = (pol.data ?? []).filter((p) => p.renewal_due);
  const monthsOf = (p) => Math.max(1, Math.round((new Date(p.ends_on) - new Date(p.starts_on)) / 2629800000));
  return (
    <Screen>
      <H1>Insurance</H1><T color={c.mute} weight="700">Cover yourself, your squad or your whole event. Ask insurers for quotes and keep it all in one place.</T>
      {has('insurer') ? <Btn small title="Open my insurer desk" color={c.violet} onPress={() => push('InsurerDesk')} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}
      {due.length ? <Card color={c.sunSoft} style={{ marginTop: 14 }} pad={12}><T weight="800">⏰ {due.length === 1 ? '1 policy is' : `${due.length} policies are`} due for renewal</T><T size={13} color={c.mute}>Renew before the end date so there is no gap in cover.</T></Card> : null}

      <Section title="Your policies" color={c.cyan}>
        {pol.data?.length ? pol.data.map((p) => <PolicyCard key={p.id} p={p} onPay={setPaying} onClaim={setClaim} onRenew={setRenew} onDocs={(x) => setDocs({ policy_id: x.id, name: x.plan_name, linkable: x.subject_type !== 'individual' })} />) : <Empty emoji="🛡️" title="Not covered yet" sub="Pick a plan below, or ask for a quote." />}
      </Section>

      <QuotesSection reloadKey={tick} onChanged={changed} onPay={setPaying} />
      <Btn small title="Ask for a quote" color={c.paper} ink={c.pink} onPress={() => setState({ quote: {} })} style={{ alignSelf: 'flex-start', marginTop: 10 }} />

      <Section title="Insurers" color={c.violet}>
        {insurers.data?.length ? insurers.data.map((i) => (
          <Card key={i.id} pad={12} onPress={() => push('InsurerPage', { id: i.id })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{i.name}{i.verified ? ' ✓' : ''}</T>{i.accepting_requests ? <Tag label="Takes requests" color={c.mint} /> : null}</View>
            {i.headline ? <T size={13}>{i.headline}</T> : null}
            <T size={12} color={c.mute}>{i.active_plans} plan{i.active_plans === 1 ? '' : 's'}{i.regions.length ? ` · ${i.regions.join(', ')}` : ''}{i.sports.length ? ` · ${i.sports.join(', ')}` : ''}</T>
          </Card>
        )) : <T size={13} color={c.mute}>No insurers have joined yet.</T>}
      </Section>

      <Section title="Plans" color={c.pink}>
        <Field value={f.q} onChangeText={(q) => setF({ ...f, q })} placeholder="Search plans or insurers…" />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {[['', 'All'], ['individual', 'Individual'], ['team', 'Team'], ['event', 'Event'], ['venue', 'Venue']].map(([v, l]) => <Chip key={v} label={l} active={f.cover_for === v} onPress={() => setF({ ...f, cover_for: v })} />)}
          {[['premium', 'Cheapest'], ['coverage', 'Most cover'], ['deductible', 'Lowest excess']].map(([v, l]) => <Chip key={v} label={l} active={f.sort === v} onPress={() => setF({ ...f, sort: v })} />)}
          <Chip label="✓ Verified insurers" active={f.verified} onPress={() => setF({ ...f, verified: !f.verified })} />
        </View>
        {picked.length >= 2 ? <Btn small title={`Compare ${picked.length} plans`} color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={async () => { try { setCmp(await api.get('/insurance/plan-comparison', { ids: picked.join(',') })); } catch (e) { toast(e.message); } }} /> : null}
        {plans.loading && !plans.data ? <Loading /> : plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : plans.data?.length ? plans.data.map((p, i) => (
          <PlanCard key={p.id} p={p} i={i} picked={picked.includes(p.id)} onPick={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id].slice(-5))}
            onBuy={(x) => setState({ buy: x })} onQuote={(x) => setState({ quote: { plan: x } })} onInsurer={(x) => push('InsurerPage', { id: x.insurer_id })} />
        )) : <Empty emoji="🔎" title="No plans match" sub="Try a different search or filter." />}
      </Section>

      <Section title="Your claims" color={c.orange}>
        {claims.data?.length ? claims.data.map((cl) => (
          <Card key={cl.id} color={c.orangeSoft} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{money(cl.amount_cents)}</T><StatusTag s={cl.status} /></View>
            <T size={12} color={c.mute}>Filed {day(cl.created_at)}{cl.incident_on ? ` · incident ${day(cl.incident_on)}` : ''}</T>
            {cl.decision_reason ? <T size={13} style={{ marginTop: 4 }}>Reviewer: {cl.decision_reason}</T> : null}
            <Btn small title="Evidence" color={c.paper} ink={c.ink} onPress={() => setDocs({ claim_id: cl.id, name: 'Claim evidence' })} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
          </Card>
        )) : <T size={13} color={c.mute}>No claims filed.</T>}
      </Section>

      <Sheet visible={!!cmp} onClose={() => setCmp(null)} title="Compare plans">
        {cmp ? <>
          {cmp.plans.map((p) => (
            <Card key={p.id} pad={12}>
              <T weight="900">{p.name}</T><T size={12} color={c.mute}>{p.insurer}{p.insurer_verified ? ' ✓' : ''}</T>
              <T size={13}>{cur(p.premium_cents, p.currency)}/mo · cover {cur(p.coverage_cents, p.currency)} · excess {cur(p.deductible_cents, p.currency)} · wait {p.waiting_period_days}d</T>
              <T size={12}>Not covered: {p.exclusions ?? 'nothing listed'}</T>
              {p.conditions ? <T size={12}>Conditions: {p.conditions}</T> : null}
              <T size={11} color={c.mute}>{[cmp.highlights.lowest_premium.includes(p.id) && 'lowest premium', cmp.highlights.highest_coverage.includes(p.id) && 'highest cover', cmp.highlights.lowest_deductible.includes(p.id) && 'lowest excess', cmp.highlights.shortest_waiting_period.includes(p.id) && 'shortest wait'].filter(Boolean).join(' · ')}</T>
            </Card>
          ))}
          <T size={12} color={c.mute}>Differences: {cmp.differences.map((d) => d.replace(/_/g, ' ')).join(', ') || 'none'}. Highlights are only a guide: read what is not covered before you buy.</T>
        </> : null}
      </Sheet>

      <PlanSheets state={state} setState={setState} onChanged={changed} onPay={setPaying} />
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={changed} /> : null}
      <DocumentsSheet linkable={!!docs?.linkable} parent={docs ? (docs.policy_id ? { policy_id: docs.policy_id } : { claim_id: docs.claim_id }) : null} title={docs?.name ?? ''} kinds={docs?.policy_id ? ['policy_schedule', 'certificate', 'receipt', 'other'] : ['claim_evidence']} onClose={() => setDocs(null)} onChanged={changed} />
      <FormSheet visible={!!claim} onClose={() => setClaim(null)} title="File a claim" submitLabel="Submit claim"
        fields={[{ key: 'amount', label: 'Amount (₹)', type: 'number' }, { key: 'incident_on', label: 'Date of the incident', type: 'date', optional: true }, { key: 'description', label: 'What happened?', type: 'multiline', hint: 'Encrypted at rest. Add photos or reports under Evidence once it is filed.' }]}
        onSubmit={async (v) => { await api.post(`/insurance/policies/${claim.id}/claims`, { description: v.description, amount_cents: Math.round(v.amount * 100), ...(v.incident_on ? { incident_on: v.incident_on } : {}) }); claims.reload(); return 'Claim submitted'; }} />
      <FormSheet visible={!!renew} onClose={() => setRenew(null)} title={renew ? `Renew ${renew.plan_name}` : ''} submitLabel="Renew" initial={{ months: renew ? Math.min(36, monthsOf(renew)) : 12 }}
        fields={[{ key: 'months', label: 'Months', type: 'stepper', min: 1, max: 36, suffix: ' mo', hint: 'Priced on the plan\'s current premium and terms. Cover continues the day after your current policy ends.' }, { key: 'beneficiary', label: 'Beneficiary', optional: true, hint: 'Encrypted.' }]}
        onSubmit={async (v) => { const p = await api.post(`/insurance/policies/${renew.id}/renew`, v); changed(); if (p.status === 'pending_payment') { setPaying({ type: 'insurance_policy', id: p.id, amount: p.amount_cents ?? p.premium_cents, currency: renew.terms?.currency, label: renew.plan_name }); return 'Renewal created: pay to confirm it'; } return 'Renewed: you stay covered'; }} />
    </Screen>
  );
}

// -------------------------------------------------------------------------------------------------- insurer's page

export function InsurerPage({ id }) {
  const { user } = useSession();
  const d = useLoad(() => api.get(`/insurance/insurers/${id}`), [id]);
  const [state, setState] = useState({});
  const [paying, setPaying] = useState(null);
  if (d.loading) return <Screen><Loading /></Screen>;
  if (d.error) return <Screen><ErrorBox error={d.error} onRetry={d.reload} /></Screen>;
  const i = d.data;
  const mine = i.owner_id === user.id;
  return (
    <Screen>
      <H1>{i.name}{i.verified ? ' ✓' : ''}</H1>
      {i.headline ? <T weight="700" color={c.mute}>{i.headline}</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <Tag label={i.verified ? 'Licence verified' : 'Licence not verified yet'} color={i.verified ? c.mint : c.sun} />
        {i.accepting_requests ? <Tag label="Takes quote requests" color={c.cyan} /> : <Tag label="Not taking requests" color={c.violetSoft} />}
      </View>
      {i.description ? <T style={{ marginTop: 10 }}>{i.description}</T> : null}
      <T size={13} color={c.mute} style={{ marginTop: 8 }}>{i.regions.length ? `Sells in ${i.regions.join(', ')}` : 'Sells everywhere'} · {i.sports.length ? i.sports.join(', ') : 'all sports'}</T>
      {i.website ? <Pressable onPress={() => (Platform.OS === 'web' ? window.open(i.website, '_blank', 'noopener') : Linking.openURL(i.website))}><T size={13} color={c.pink} weight="700" style={{ marginTop: 4 }}>{i.website.replace(/^https?:\/\//, '')} ↗</T></Pressable> : null}
      {i.accepting_requests && !mine ? <Btn title={`Ask ${i.name} for a quote`} onPress={() => setState({ quote: { insurer: i } })} style={{ marginTop: 14 }} /> : null}
      <Section title="Plans" color={c.pink}>
        {i.plans.length ? i.plans.map((p, k) => <PlanCard key={p.id} p={p} i={k} onBuy={(x) => setState({ buy: x })} onQuote={(x) => setState({ quote: { plan: x } })} />) : <Empty emoji="🛡️" title="No plans yet" sub="This insurer has not published a plan." />}
      </Section>
      <PlanSheets state={state} setState={setState} onChanged={() => {}} onPay={setPaying} />
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={() => {}} /> : null}
    </Screen>
  );
}
