// The insurer's desk: set up the profile, publish and advertise plans, answer quote requests, send quotes, see the book of
// business and renewals, and handle claims on the policies this insurer wrote. Everything here is the same API agents use.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day, money } from '../theme';
import { moneyIn } from '../vtime';
import { DocumentsSheet, QuoteRequestSheet, RequestSheet, StatusTag, dayY, nice } from './insurance';

const cur = (cents, currency) => (currency ? moneyIn(Number(cents), currency) : money(Number(cents)));
const major = (cents, currency) => { let d = 2; try { d = new Intl.NumberFormat('en', { style: 'currency', currency: currency ?? 'INR' }).resolvedOptions().maximumFractionDigits; } catch { /* keep 2 */ } return String(Number(cents) / 10 ** d); };
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const COVER = { individual: 'Individual', team: 'Team', event: 'Event / tournament', venue: 'Venue' };
const TABS = [['today', 'Today'], ['requests', 'Requests'], ['quotes', 'Quotes'], ['policies', 'Policies'], ['claims', 'Claims'], ['plans', 'Plans'], ['profile', 'Profile']];

const profileFields = (cur_) => [
  { key: 'name', label: 'Insurer name' },
  { key: 'headline', label: 'One-line pitch', optional: true, hint: 'Shown on your public page and in search.' },
  { key: 'description', label: 'About you', type: 'multiline', optional: true },
  { key: 'website', label: 'Website', optional: true, type: 'url' },
  { key: 'licence_no', label: cur_?.has_licence ? 'New licence number (leave empty to keep the current one)' : 'Regulator licence number', optional: true, hint: 'Encrypted. Only read by the platform team when they verify you. Changing it removes the verified badge until it is checked again.' },
  { key: 'regions', label: 'Where you sell', optional: true, hint: 'Cities or countries, separated by commas. Leave empty for everywhere.' },
  { key: 'sports', label: 'Sports you specialise in', optional: true, hint: 'Sport names as slugs, separated by commas. Leave empty for all sports.' },
  { key: 'accepting_requests', label: 'Accept new quote requests', type: 'switch' },
];
const profileBody = (v) => ({ ...v, regions: list(v.regions), sports: list(v.sports).map((x) => x.toLowerCase().replace(/\s+/g, '-')), headline: v.headline || null, description: v.description || null, website: v.website || null });

/** First visit: tell people who you are. You can publish plans and answer requests straight away; verification follows. */
function Onboarding({ onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <Screen>
      <H1>Insurer desk</H1>
      <T color={c.mute} weight="700">Offer cover to players, teams and events on SportArena.</T>
      <Card color={c.cyanSoft} style={{ marginTop: 16 }}>
        <T weight="900" size={17}>Get started in four steps</T>
        {['Create your insurer profile', 'Add your licence number so we can verify you', 'Publish your first plan (and advertise it with an offer)', 'Answer quote requests and track your policies'].map((t, i) => <T key={t} size={14} style={{ marginTop: 6 }}>{i + 1}. {t}</T>)}
        <Btn title="Set up my profile" onPress={() => setOpen(true)} style={{ marginTop: 14 }} />
      </Card>
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Your insurer profile" submitLabel="Create profile" initial={{ accepting_requests: true }} fields={profileFields(null)}
        onSubmit={async (v) => { await api.post('/insurance/my-insurer', profileBody(v)); onDone(); return 'Profile created: now publish your first plan'; }} />
    </Screen>
  );
}

// -------------------------------------------------------------------------------------------------- quote on a request

/** Pick one of your active plans that matches what was asked, then price it. */
function QuoteFlow({ ask, onClose, onDone }) {
  const { push } = useNav();
  const plans = useLoad(() => api.get('/insurance/my-plans', { status: 'active', limit: 100 }), []);
  const [picked, setPicked] = useState([]);
  const [step, setStep] = useState(1);
  const fits = (plans.data ?? []).filter((p) => p.cover_for === ask?.cover_for);
  const chosen = fits.filter((p) => picked.includes(p.id));
  const close = () => { setPicked([]); setStep(1); onClose(); };
  const toggle = (pid) => setPicked((x) => (x.includes(pid) ? x.filter((i) => i !== pid) : [...x, pid]));
  const minMonths = Math.max(1, ...chosen.map((p) => p.term_months.min ?? 1)), maxMonths = Math.min(36, ...chosen.map((p) => p.term_months.max ?? 36));
  const fields = chosen.flatMap((p, i) => [
    { type: 'section', label: `${p.emoji} ${p.name}` },
    { key: `premium_${i}`, label: 'Premium per month', type: 'money', currency: p.currency, hint: `Plan price ${cur(p.premium_cents, p.currency)} a month` },
    { key: `coverage_${i}`, label: 'Cover for this quote', type: 'money', currency: p.currency, optional: true, hint: `Leave empty for the plan's ${cur(p.coverage_cents, p.currency)}` },
    { key: `deductible_${i}`, label: 'Excess for this quote', type: 'money', currency: p.currency, optional: true, hint: 'Leave empty for the plan\'s excess.' },
  ]);
  const initial = { months: Math.min(Math.max(ask?.months ?? 12, minMonths), maxMonths), valid_days: 14, ...Object.fromEntries(chosen.map((p, i) => [`premium_${i}`, major(p.premium_cents, p.currency)])) };
  return (
    <>
      <Sheet visible={!!ask && step === 1} onClose={close} title="Quote with which plans?">
        {plans.loading ? <Loading /> : fits.length ? <>
          <T size={12} color={c.mute}>Pick one plan, or several to give the buyer a choice. You set the price and your own terms for each on the next step.</T>
          {fits.map((p) => (
            <Card key={p.id} pad={12} color={picked.includes(p.id) ? c.cyanSoft : undefined} onPress={() => toggle(p.id)}>
              <T weight="800">{picked.includes(p.id) ? '☑' : '☐'} {p.emoji} {p.name}</T>
              <T size={12} color={c.mute}>{cur(p.premium_cents, p.currency)}/mo · cover {cur(p.coverage_cents, p.currency)} · excess {cur(p.deductible_cents, p.currency)}</T>
            </Card>
          ))}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn title={picked.length ? `Continue with ${picked.length} plan${picked.length === 1 ? '' : 's'}` : 'Pick a plan'} disabled={!picked.length} onPress={() => setStep(2)} />
            {fits.length > 1 ? <Btn small title={picked.length === fits.length ? 'Clear' : 'Select all'} color={c.paper} ink={c.ink} onPress={() => setPicked(picked.length === fits.length ? [] : fits.map((p) => p.id))} /> : null}
          </View>
        </> : <Empty emoji="🛡️" title={`No active ${COVER[ask?.cover_for]?.toLowerCase() ?? ''} plan`} sub="Publish a plan of this kind first: a quote is always priced on one of your plans." />}
        {!plans.loading && !fits.length ? <Btn title="Create a plan" onPress={() => { close(); push('InsurerDesk', { tab: 'plans' }); }} /> : null}
      </Sheet>
      <FormSheet visible={!!ask && step === 2 && !!chosen.length} onClose={() => setStep(1)} title={chosen.length === 1 ? `Quote: ${chosen[0].name}` : `Quote: ${chosen.length} plans`} submitLabel={chosen.length === 1 ? 'Send quote' : `Send ${chosen.length} quotes`} initial={initial}
        fields={[
          ...fields,
          { type: 'section', label: 'Terms for all' },
          { key: 'months', label: 'Months', type: 'stepper', min: minMonths, max: maxMonths, suffix: ' mo' },
          { key: 'waiting_period_days', label: 'Waiting period (days)', type: 'number', optional: true, hint: 'Leave empty for each plan\'s waiting period.' },
          { key: 'valid_days', label: 'Valid for (days)', type: 'stepper', min: 1, max: 90, suffix: ' d' },
          { key: 'details', label: 'Your own terms', type: 'multiline', optional: true, hint: 'In your words: what is included, special conditions, club or multi-year discounts. The buyer sees this next to the plan\'s exclusions.' },
          { key: 'note', label: 'Note to the buyer', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const who = ask.request_id ? { request_id: ask.request_id } : { buyer_id: ask.buyer_id, ...(ask.subject_id ? { subject_id: ask.subject_id } : {}) };
          const shared = { months: v.months, valid_days: v.valid_days, waiting_period_days: v.waiting_period_days, details: v.details || undefined, note: v.note || undefined };
          let sent = 0; const failed = [];
          for (const [i, p] of chosen.entries()) {
            try { await api.post('/insurance/quotes', { plan_id: p.id, ...who, ...shared, premium_cents: v[`premium_${i}`], coverage_cents: v[`coverage_${i}`], deductible_cents: v[`deductible_${i}`] }); sent++; }
            catch (e) { failed.push(`${p.name}: ${e.message}`); }
          }
          if (!sent) throw new Error(failed.join('; '));
          onDone?.(); close();
          return failed.length ? `Sent ${sent} of ${chosen.length}. ${failed.join('; ')}` : sent === 1 ? 'Quote sent' : `${sent} quotes sent`;
        }} />
    </>
  );
}

/** Offer cover to someone who has not asked: find a person, team or event, then price it. */
function DirectOffer({ visible, onClose, onPick }) {
  const [kind, setKind] = useState('individual');
  const [q, setQ] = useState('');
  const res = useLoad(() => (q.trim().length < 2 ? Promise.resolve([]) : api.get(kind === 'individual' ? '/people' : kind === 'team' ? '/teams' : '/events', { q: q.trim(), limit: 8 })), [kind, q]);
  const pick = (x) => onPick(kind === 'individual' ? { cover_for: 'individual', buyer_id: x.id, label: x.display_name } : kind === 'team' ? { cover_for: 'team', buyer_id: x.owner_id, subject_id: x.id, label: x.name } : { cover_for: 'event', buyer_id: x.organizer_id, subject_id: x.id, label: x.name });
  return (
    <Sheet visible={visible} onClose={onClose} title="Offer cover to…">
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['individual', 'A person'], ['team', 'A team'], ['event', 'An event']].map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => { setKind(k); setQ(''); }} />)}</View>
      <Field value={q} onChangeText={setQ} placeholder={kind === 'individual' ? 'Search by name or handle…' : 'Search by name…'} />
      {res.loading && q.trim().length >= 2 ? <Loading /> : (res.data ?? []).map((x) => (
        <Card key={x.id} pad={12} onPress={() => pick(x)}><T weight="800">{x.display_name ?? x.name}</T><T size={12} color={c.mute}>{x.handle ? `@${x.handle}` : x.sport ?? ''}</T></Card>
      ))}
      <T size={12} color={c.mute}>The offer goes to them as a quote; nothing is bought until they accept it.</T>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------ marketplace (Billboard)

/** Why the inbox may be empty: paused profile, own requests (you cannot quote yourself), or simply nothing open yet. */
export function InboxHint({ reloadKey }) {
  const s = useLoad(() => api.get('/insurance/insurer/summary'), [reloadKey]);
  const i = s.data?.inbox;
  if (!i) return null;
  const notes = [
    i.status !== 'active' ? 'Your insurer profile is suspended, so you do not receive requests.' : null,
    i.status === 'active' && !i.accepting_requests ? 'You are paused: switch on "Accept new quote requests" in Profile to see the Billboard requests.' : null,
    i.own_requests_hidden ? `${i.own_requests_hidden} open request${i.own_requests_hidden === 1 ? ' is' : 's are'} yours: an insurer cannot quote its own login. Use a separate account to ask for cover.` : null,
    i.status === 'active' && i.accepting_requests && !i.market_open ? 'No one else has an open request right now. New ones appear here and you get a notification.' : null,
  ].filter(Boolean);
  return notes.length ? <Card color={c.sunSoft} pad={12}>{notes.map((t) => <T key={t} size={13}>{t}</T>)}</Card> : null;
}

/** The Billboard's Insurance tab: requests open to every insurer. Insurers answer them here; everyone can ask for cover. */
export function InsuranceMarket({ onAsk }) {
  const { user } = useSession();
  const { push } = useNav();
  const isInsurer = user?.roles?.includes('insurer');
  const [cover, setCover] = useState('');
  const [open, setOpen] = useState(null);
  const [ask, setAsk] = useState(null);
  const [tick, setTick] = useState(0);
  const [planAsk, setPlanAsk] = useState(null);
  const { refresh, setActiveRole, toast } = useSession();
  const offers = useLoad(() => api.get('/insurance/plans', { limit: 30 }), [tick]);
  const becomeInsurer = async () => {
    try { await api.patch('/me/roles', { add: ['insurer'] }); await refresh(); setActiveRole('insurer'); push('InsurerDesk'); toast('Insurer role added: set up your profile'); } catch (e) { toast(e.message); }
  };
  const m = useLoad(() => (isInsurer ? api.get('/insurance/market', { limit: 50, ...(cover ? { cover_for: cover } : {}) }) : Promise.resolve([])), [isInsurer, cover, tick]);
  return (
    <>
      <Card color={c.cyanSoft} pad={14}>
        <T weight="900" size={16}>Insurance marketplace</T>
        <T size={13} color={c.mute}>Players, coaches, teams, venues and event managers ask for cover here. Any insurer can send a quote, and the asker compares them all, chats with the insurers and accepts one.</T>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <Btn small title="Ask for insurance quotes" onPress={onAsk} />
          {isInsurer ? <Btn small title="My insurer desk" color={c.paper} ink={c.ink} onPress={() => push('InsurerDesk')} /> : null}
        </View>
      </Card>
      {!isInsurer ? <Card pad={12}><T size={13} color={c.mute}>Are you an insurer or an agent? You can add the Insurer role next to your other roles (player, coach, referee, sponsor, event or venue manager), publish plans and answer these requests.</T><Btn small title="Become an insurer" onPress={becomeInsurer} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card> : <>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['', 'All'], ...Object.entries(COVER)].map(([v, l]) => <Chip key={v} label={l} active={cover === v} onPress={() => setCover(v)} />)}</View>
        <InboxHint reloadKey={tick} />
        {m.loading && !m.data ? <Loading /> : m.error ? <ErrorBox error={m.error} onRetry={m.reload} /> : m.data?.length ? m.data.map((x) => (
          <Card key={x.id} pad={12} onPress={() => setOpen(x.id)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.subject_name ?? COVER[x.cover_for]}</T>{x.my_quote_status ? <StatusTag s={x.my_quote_status} /> : <Tag label="Needs a quote" color={c.sun} />}</View>
            <T size={12} color={c.mute}>{COVER[x.cover_for]} · {x.months} months{x.participants ? ` · ${x.participants} people` : ''}{x.sport ? ` · ${x.sport}` : ''}{x.city ? ` · ${x.city}` : ''} · {day(x.created_at)}</T>
            <T size={12} color={c.mute}>{x.quotes ? `${x.quotes} quote${x.quotes === 1 ? '' : 's'} so far` : 'No quotes yet'}</T>
            {true ? <Btn small title={x.my_quote_id ? 'Quote with another plan' : 'Send a quote'} onPress={() => setAsk({ request_id: x.id, cover_for: x.cover_for, months: x.months })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
          </Card>
        )) : <Empty emoji="📭" title="No open requests" sub="New requests appear here as soon as someone asks." />}
      </>}
      <Section title="Plans on offer" color={c.pink}>
        {offers.loading && !offers.data ? <Loading /> : offers.data?.length ? offers.data.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.emoji} {p.name}</T><Tag label={COVER[p.cover_for]} color={c.cyan} /></View>
            <T size={12} color={c.mute}>{p.insurer}{p.insurer_verified ? ' ✓' : ''} · {cur(p.premium_cents, p.currency)}/mo · cover {cur(p.coverage_cents, p.currency)}</T>
            {p.offer ? <T size={12} weight="700" color={c.orange}>Offer: {p.offer}</T> : null}
            <Btn small title="Ask for a quote" onPress={() => setPlanAsk({ plan: p })} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
          </Card>
        )) : <Empty emoji="🛡️" title="No plans yet" sub="Insurers publish their plans here. Once one is on sale it is listed on the Billboard." />}
      </Section>
      <QuoteRequestSheet target={planAsk} onClose={() => setPlanAsk(null)} onDone={() => setPlanAsk(null)} />
      <RequestSheet id={open} asInsurer onClose={() => setOpen(null)} onChanged={() => setTick((x) => x + 1)} onQuote={(req) => { setOpen(null); setAsk({ request_id: req.id, cover_for: req.cover_for, months: req.months }); }} />
      <QuoteFlow ask={ask} onClose={() => setAsk(null)} onDone={() => setTick((x) => x + 1)} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------- tabs

function Requests({ onQuote, reloadKey }) {
  const [only, setOnly] = useState(true);
  const [open, setOpen] = useState(null);
  const r = useLoad(() => api.get('/insurance/quote-requests', { view: 'inbox', limit: 50, ...(only ? { unanswered: true } : {}) }), [only, reloadKey]);
  return (
    <Section title="Quote requests" color={c.sun}>
      <View style={{ flexDirection: 'row', gap: 6 }}><Chip label="To answer" active={only} onPress={() => setOnly(true)} /><Chip label="All open" active={!only} onPress={() => setOnly(false)} /></View>
      <InboxHint reloadKey={reloadKey} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.data?.length ? r.data.map((x) => (
        <Card key={x.id} pad={12} onPress={() => setOpen(x.id)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.subject_name ?? COVER[x.cover_for]}</T>{x.my_quote_status ? <StatusTag s={x.my_quote_status} /> : <Tag label="Needs a quote" color={c.sun} />}</View>
          <T size={12} color={c.mute}>{COVER[x.cover_for]} · {x.months} months{x.participants ? ` · ${x.participants} people` : ''}{x.sport ? ` · ${x.sport}` : ''}{x.city ? ` · ${x.city}` : ''} · from {x.requester} · {day(x.created_at)}</T>
          {x.plan_name ? <T size={12} color={c.mute}>About your plan {x.plan_name}</T> : null}
          {!x.insurer_id ? <T size={12} color={c.mute}>Open to all insurers (Billboard)</T> : null}
        </Card>
      )) : <Empty emoji="📭" title={only ? 'Nothing waiting' : 'No open requests'} sub="New requests addressed to you, or open to every insurer, show up here." />}
      <RequestSheet id={open} asInsurer onClose={() => setOpen(null)} onChanged={r.reload} onQuote={(req) => { setOpen(null); onQuote({ request_id: req.id, cover_for: req.cover_for, months: req.months }); }} />
    </Section>
  );
}

function Quotes({ onDirect, reloadKey }) {
  const { toast } = useSession();
  const [status, setStatus] = useState('');
  const q = useLoad(() => api.get('/insurance/quotes', { view: 'sent', limit: 50, ...(status ? { status } : {}) }), [status, reloadKey]);
  return (
    <Section title="Quotes you sent" color={c.cyan}>
      <Btn small title="+ Offer cover directly" onPress={onDirect} style={{ alignSelf: 'flex-start' }} />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['', 'All'], ['offered', 'On offer'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['expired', 'Expired']].map(([v, l]) => <Chip key={v} label={l} active={status === v} onPress={() => setStatus(v)} />)}</View>
      {q.loading && !q.data ? <Loading /> : q.data?.length ? q.data.map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.buyer} · {x.subject_name ?? COVER[x.cover_for]}</T><StatusTag s={x.status} /></View>
          <T size={13}>{x.plan_name} · {cur(x.total_cents, x.currency)} for {x.months} months · cover {cur(x.coverage_cents, x.currency)}</T>
          <T size={12} color={c.mute}>{x.request_id ? 'Answering a request' : 'Direct offer'} · valid until {day(x.valid_until)}</T>
          {x.status === 'offered' ? <Btn small title="Withdraw" color={c.paper} ink={c.red} style={{ marginTop: 8, alignSelf: 'flex-start' }} onPress={async () => { try { await api.post(`/insurance/quotes/${x.id}/withdraw`); q.reload(); toast('Quote withdrawn'); } catch (e) { toast(e.message); } }} /> : null}
        </Card>
      )) : <Empty emoji="🧾" title="No quotes yet" sub="Answer a request, or offer cover directly." />}
    </Section>
  );
}

function Policies() {
  const [f, setF] = useState('all');
  const [docs, setDocs] = useState(null);
  const p = useLoad(() => api.get('/insurance/insurer/policies', { limit: 100, ...(f === 'expiring' ? { expiring_in_days: 30 } : f === 'pending' ? { status: 'pending_payment' } : {}) }), [f]);
  return (
    <Section title="Policies you wrote" color={c.mint}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['all', 'All'], ['expiring', 'Expiring in 30 days'], ['pending', 'Awaiting payment']].map(([v, l]) => <Chip key={v} label={l} active={f === v} onPress={() => setF(v)} />)}</View>
      {p.loading && !p.data ? <Loading /> : p.error ? <ErrorBox error={p.error} onRetry={p.reload} /> : p.data?.length ? p.data.map((x) => (
        <Card key={x.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.holder} · {x.subject_name ?? COVER[x.subject_type]}</T><StatusTag s={x.effective_status} /></View>
          <T size={13}>{x.plan_name} · {x.policy_no} · cover {cur(x.coverage_cents)} · premium {cur(x.amount_cents)}</T>
          <T size={12} color={x.days_left <= 30 && !x.renewed ? c.orange : c.mute} weight={x.days_left <= 30 ? '700' : '500'}>{dayY(x.starts_on)} to {dayY(x.ends_on)}{x.status === 'active' ? ` · ${x.days_left >= 0 ? `${x.days_left} days left` : 'ended'}` : ''}{x.renewed ? ' · renewed ✓' : x.renewed_from ? ' · a renewal' : ''}</T>
          <Btn small title="Documents" color={c.paper} ink={c.ink} style={{ marginTop: 8, alignSelf: 'flex-start' }} onPress={() => setDocs(x)} />
        </Card>
      )) : <Empty emoji="📒" title="No policies yet" sub="Policies appear here once a buyer accepts one of your quotes or buys one of your plans." />}
      <DocumentsSheet parent={docs ? { policy_id: docs.id } : null} title={docs ? `${docs.holder}: documents` : ''} kinds={['policy_schedule', 'certificate', 'receipt', 'other']} onClose={() => setDocs(null)} />
    </Section>
  );
}

const NEXT = { submitted: [['under_review', 'Start review'], ['approved', 'Approve'], ['rejected', 'Reject']], under_review: [['approved', 'Approve'], ['rejected', 'Reject']], approved: [['paid', 'Mark paid']], rejected: [], paid: [] };
function Claims() {
  const { toast } = useSession();
  const [status, setStatus] = useState('');
  const [reject, setReject] = useState(null);
  const [ev, setEv] = useState(null);
  const cl = useLoad(() => api.get('/insurance/claims', { as_insurer: true, limit: 50, ...(status ? { status } : {}) }), [status]);
  const move = async (x, to, reason) => { try { await api.patch(`/insurance/claims/${x.id}`, { status: to, ...(reason ? { reason } : {}) }); cl.reload(); toast(`Claim ${nice(to)}`); } catch (e) { toast(e.message); } };
  return (
    <Section title="Claims" color={c.orange}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[['', 'All'], ['submitted', 'New'], ['under_review', 'In review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['paid', 'Paid']].map(([v, l]) => <Chip key={v} label={l} active={status === v} onPress={() => setStatus(v)} />)}</View>
      {cl.loading && !cl.data ? <Loading /> : cl.error ? <ErrorBox error={cl.error} onRetry={cl.reload} /> : cl.data?.length ? cl.data.map((x) => (
        <Card key={x.id} pad={12} color={c.orangeSoft}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{money(x.amount_cents)}</T><StatusTag s={x.status} /></View>
          <T size={12} color={c.mute}>Filed {day(x.created_at)}{x.incident_on ? ` · incident ${day(x.incident_on)}` : ''}</T>
          <T size={13} style={{ marginTop: 4 }}>{x.description}</T>
          {x.decision_reason ? <T size={12} color={c.mute}>Decision note: {x.decision_reason}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {NEXT[x.status].map(([to, label]) => <Btn key={to} small title={label} color={to === 'rejected' ? c.paper : c.pink} ink={to === 'rejected' ? c.red : '#fff'} onPress={() => (to === 'rejected' ? setReject(x) : move(x, to))} />)}
            <Btn small title="Evidence" color={c.paper} ink={c.ink} onPress={() => setEv(x)} />
          </View>
        </Card>
      )) : <Empty emoji="🩹" title="No claims" sub="Claims on policies you wrote appear here." />}
      <FormSheet visible={!!reject} onClose={() => setReject(null)} title="Reject this claim" submitLabel="Reject" fields={[{ key: 'reason', label: 'Reason the claimant will see', type: 'multiline' }]} onSubmit={async (v) => { await move(reject, 'rejected', v.reason); }} />
      <DocumentsSheet readOnly parent={ev ? { claim_id: ev.id } : null} title="Claim evidence" kinds={['claim_evidence']} onClose={() => setEv(null)} />
    </Section>
  );
}

const PLAN_FIELDS = (p) => [
  { key: 'name', label: 'Plan name' },
  { key: 'cover_for', label: 'Covers', type: 'choice', options: Object.entries(COVER).map(([value, label]) => ({ value, label })) },
  { key: 'description', label: 'What it is', type: 'multiline', optional: true },
  { key: 'premium_cents', label: 'Premium per month', type: 'money', currency: p?.currency },
  { key: 'coverage_cents', label: 'Cover', type: 'money', currency: p?.currency },
  { key: 'deductible_cents', label: 'Excess', type: 'money', currency: p?.currency, optional: true },
  { key: 'waiting_period_days', label: 'Waiting period (days)', type: 'number', optional: true },
  { key: 'term_months_min', label: 'Shortest term (months)', type: 'number', optional: true },
  { key: 'term_months_max', label: 'Longest term (months)', type: 'number', optional: true },
  { key: 'exclusions', label: 'What is not covered', type: 'multiline', optional: true, hint: 'Always shown to buyers next to the price.' },
  { key: 'conditions', label: 'Conditions', type: 'multiline', optional: true },
  { key: 'promo_text', label: 'Advertise an offer', optional: true, hint: 'A short line shown on the plan card, labelled "Offer". It never changes where the plan ranks.' },
  { key: 'promo_ends_on', label: 'Offer ends', type: 'date', optional: true },
];
function Plans() {
  const { toast } = useSession();
  const plans = useLoad(() => api.get('/insurance/my-plans', { limit: 100 }), []);
  const [edit, setEdit] = useState(null);   // {} = new
  const initial = (p) => p ? { name: p.name, cover_for: p.cover_for, description: p.description, premium_cents: major(p.premium_cents, p.currency), coverage_cents: major(p.coverage_cents, p.currency), deductible_cents: major(p.deductible_cents, p.currency), waiting_period_days: p.waiting_period_days, term_months_min: p.term_months.min, term_months_max: p.term_months.max, exclusions: p.exclusions, conditions: p.conditions, promo_text: p.offer, promo_ends_on: p.offer_ends_on?.slice(0, 10) } : { cover_for: 'individual' };
  return (
    <Section title="Your plans" color={c.pink} action="+ New plan" onAction={() => setEdit({})}>
      {plans.loading && !plans.data ? <Loading /> : plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : plans.data?.length ? plans.data.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{p.emoji} {p.name}</T><StatusTag s={p.status} /></View>
          <T size={12} color={c.mute}>{COVER[p.cover_for]} · {cur(p.premium_cents, p.currency)}/mo · cover {cur(p.coverage_cents, p.currency)} · {p.live_policies} live polic{p.live_policies === 1 ? 'y' : 'ies'} · {p.open_quotes} open quote{p.open_quotes === 1 ? '' : 's'}</T>
          {p.offer ? <T size={12} weight="700" color={c.orange}>Offer: {p.offer}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setEdit(p)} />
            {p.status === 'active' ? <Btn small title="Share to community" color={c.paper} ink={c.violet} onPress={async () => { try { await api.post('/market/posts', { kind: 'announcement', title: `${p.name}: ${COVER[p.cover_for]} insurance`.slice(0, 120), body: `${p.description ? `${p.description}\n\n` : ''}${cur(p.premium_cents, p.currency)} a month, cover up to ${cur(p.coverage_cents, p.currency)}.${p.offer ? ` Offer: ${p.offer}.` : ''} Ask for a quote under Billboard → Insurance.`.slice(0, 2000), cta_label: 'Get a quote' }); toast('Shared to the community feed. It is also listed on the Billboard.'); } catch (e) { toast(e.message); } }} /> : null}
            <Btn small title={p.status === 'active' ? 'Retire' : 'Put on sale'} color={c.paper} ink={p.status === 'active' ? c.red : c.pink} onPress={async () => { try { await api.patch(`/insurance/plans/${p.id}`, { status: p.status === 'active' ? 'retired' : 'active' }); plans.reload(); toast(p.status === 'active' ? 'Retired: sold policies keep their cover' : 'On sale again'); } catch (e) { toast(e.message); } }} />
          </View>
        </Card>
      )) : <Empty emoji="🛡️" title="No plans yet" sub="Publish a plan so people can find, compare and buy it, and so you can quote on it." />}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit plan' : 'New plan'} submitLabel={edit?.id ? 'Save' : 'Publish'} initial={initial(edit?.id ? edit : null)} fields={PLAN_FIELDS(edit?.id ? edit : null)}
        onSubmit={async (v) => {
          const body = { ...v, ...(v.promo_text ? {} : { promo_text: null, promo_ends_on: null }), ...(v.promo_text && !v.promo_ends_on ? { promo_ends_on: null } : {}) };
          if (edit?.id) await api.patch(`/insurance/plans/${edit.id}`, body); else await api.post('/insurance/plans', body);
          plans.reload(); return edit?.id ? 'Plan saved' : 'Plan published';
        }} />
    </Section>
  );
}

function Profile({ me, onChanged }) {
  const [edit, setEdit] = useState(false);
  return (
    <Section title="Your profile" color={c.violet} action="Edit" onAction={() => setEdit(true)}>
      <Card>
        <T weight="900" size={18}>{me.name}{me.verified ? ' ✓' : ''}</T>
        {me.headline ? <T weight="700" color={c.mute}>{me.headline}</T> : null}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <Tag label={me.verified ? 'Licence verified' : me.has_licence ? 'Licence waiting for a check' : 'No licence on file'} color={me.verified ? c.mint : c.sun} />
          <Tag label={me.accepting_requests ? 'Taking requests' : 'Requests paused'} color={me.accepting_requests ? c.cyan : c.violetSoft} />
        </View>
        {me.licence_hint ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Licence on file: {me.licence_hint}</T> : null}
        <T size={13} style={{ marginTop: 8 }}>{me.description || 'No description yet.'}</T>
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>{me.regions.length ? `Sells in ${me.regions.join(', ')}` : 'Sells everywhere'} · {me.sports.length ? me.sports.join(', ') : 'all sports'}</T>
      </Card>
      <FormSheet visible={edit} onClose={() => setEdit(false)} title="Edit profile" initial={{ name: me.name, headline: me.headline, description: me.description, website: me.website, regions: me.regions.join(', '), sports: me.sports.join(', '), accepting_requests: me.accepting_requests }} fields={profileFields(me)}
        onSubmit={async (v) => { await api.patch('/insurance/my-insurer', profileBody(v)); onChanged(); return 'Profile saved'; }} />
    </Section>
  );
}

function Today({ me, setTab }) {
  const s = useLoad(() => api.get('/insurance/insurer/summary'), []);
  const plans = useLoad(() => api.get('/insurance/my-plans', { status: 'active', limit: 1 }), []);
  const d = s.data;
  const steps = [['Profile created', true, 'profile'], ['Licence verified', me.verified, 'profile'], ['First plan published', !!plans.data?.length, 'plans'], ['Taking quote requests', me.accepting_requests, 'profile']];
  return (
    <>
      {steps.some(([, ok]) => !ok) && plans.data ? (
        <Card color={c.sunSoft} style={{ marginTop: 14 }}>
          <T weight="900">Finish setting up</T>
          {steps.map(([t, ok, tab]) => <T key={t} size={14} style={{ marginTop: 4 }} onPress={ok ? undefined : () => setTab(tab)}>{ok ? '✅' : '⬜'} {t}</T>)}
          {!me.has_licence ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Add your licence number in Profile and the platform team will verify you.</T> : null}
        </Card>
      ) : null}
      {d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <StatPill value={d.requests_waiting} label="TO QUOTE" color={c.lime} /><StatPill value={d.quotes_out} label="QUOTES OUT" /><StatPill value={d.quotes_accepted} label="ACCEPTED" />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <StatPill value={d.live_policies} label="LIVE POLICIES" /><StatPill value={d.expiring_soon} label="EXPIRING 30D" /><StatPill value={d.open_claims} label="OPEN CLAIMS" />
          </View>
          <T size={13} color={c.mute} style={{ marginTop: 12 }}>Premium on live policies: {cur(d.premium_live_cents, d.currency)}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {d.requests_waiting ? <Btn small title={`Answer ${d.requests_waiting} request${d.requests_waiting === 1 ? '' : 's'}`} onPress={() => setTab('requests')} /> : null}
            {d.expiring_soon ? <Btn small title="See expiring policies" color={c.paper} ink={c.ink} onPress={() => setTab('policies')} /> : null}
            {d.open_claims ? <Btn small title="Review claims" color={c.paper} ink={c.ink} onPress={() => setTab('claims')} /> : null}
          </View>
        </>
      ) : s.loading ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : null}
    </>
  );
}

export function InsurerDesk({ tab: startTab }) {
  const { push } = useNav();
  const me = useLoad(() => api.get('/insurance/my-insurer'), []);
  const [tab, setTab] = useState(startTab ?? 'today');
  const [ask, setAsk] = useState(null);
  const [direct, setDirect] = useState(false);
  const [tick, setTick] = useState(0);
  if (me.loading) return <Screen><Loading /></Screen>;
  if (me.error) return <Screen><ErrorBox error={me.error} onRetry={me.reload} /></Screen>;
  if (!me.data) return <Onboarding onDone={me.reload} />;
  const m = me.data;
  return (
    <Screen>
      <H1>{m.name}{m.verified ? ' ✓' : ''}</H1>
      <T color={c.mute} weight="700">Insurer desk</T>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>{TABS.map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</View>
      {tab === 'today' ? <Today me={m} setTab={setTab} /> : null}
      {tab === 'requests' ? <Requests reloadKey={tick} onQuote={setAsk} /> : null}
      {tab === 'quotes' ? <Quotes reloadKey={tick} onDirect={() => setDirect(true)} /> : null}
      {tab === 'policies' ? <Policies /> : null}
      {tab === 'claims' ? <Claims /> : null}
      {tab === 'plans' ? <Plans /> : null}
      {tab === 'profile' ? <Profile me={m} onChanged={me.reload} /> : null}
      <Btn small title="See my public page" color={c.paper} ink={c.ink} onPress={() => push('InsurerPage', { id: m.id })} style={{ marginTop: 24, alignSelf: 'flex-start' }} />
      <QuoteFlow ask={ask} onClose={() => setAsk(null)} onDone={() => { setTick((x) => x + 1); setTab('quotes'); }} />
      <DirectOffer visible={direct} onClose={() => setDirect(false)} onPick={(t) => { setDirect(false); setAsk(t); }} />
    </Screen>
  );
}
