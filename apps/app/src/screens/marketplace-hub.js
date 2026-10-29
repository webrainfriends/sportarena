// Sports Services & Opportunity Marketplace (#600): the one front door. Discover providers of every kind, shortlist and compare, request a quote,
// and follow every engagement (as buyer or provider) on one timeline. Every rule lives in the API (marketplace capabilities); this screen only asks and shows.
// Paid placement is the existing labelled ad slot (search_sponsored), always drawn apart from the organic results.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { useSession } from '../session';
import { c } from '../theme';
import { AdSlot } from '../ads';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { PlacePicker } from '../place-picker';
import { SportSelect } from '../sportpicker';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, HScroll, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { moneyIn } from '../vtime';
import { useDo } from './console-utils';

const label = (s) => String(s ?? '').replace(/_/g, ' ');
export const STATUS_TONE = { requested: c.sun, quoted: c.cyan, negotiating: c.sun, contracted: c.mint, scheduled: c.mint, delivered: c.cyan, invoiced: c.sun, paid: c.mint, reviewed: c.mint, declined: c.red, cancelled: c.red };
export const StatusTag = ({ s }) => <Tag label={label(s)} color={STATUS_TONE[s] ?? c.violetSoft} />;
const rate = (l) => (l.rate_min_minor == null && l.rate_max_minor == null ? null
  : `${l.rate_min_minor != null ? moneyIn(Number(l.rate_min_minor), l.currency) : ''}${l.rate_max_minor != null && l.rate_max_minor !== l.rate_min_minor ? ` – ${moneyIn(Number(l.rate_max_minor), l.currency)}` : ''}${l.rate_unit ? ` / ${l.rate_unit}` : ''}`);

export function ListingCard({ l, cat, onShortlist, onRequest, onOpen, shortlisted }) {
  const fam = cat?.families.find((f) => f.slug === l.family);
  return (
    <Card pad={14} accessibilityLabel={`${l.organisation_name ?? l.display_name}, ${fam?.label ?? l.family}`}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Tag label={fam?.label ?? l.family} />
          {l.credential_verified ? <Tag label="Verified credential" color={c.mint} /> : fam?.credential_required ? <Tag label="Credential not verified" color={c.sun} /> : null}
          {l.rating ? <T size={12} color={c.mute}>★ {l.rating} ({l.rating_count})</T> : null}
        </View>
        <T weight="800" size={17}>{l.headline}</T>
        <T size={13} color={c.mute}>{[l.organisation_name ?? l.display_name, [l.city, l.country].filter(Boolean).join(', '), l.remote_ok ? 'remote ok' : null].filter(Boolean).join(' · ')}</T>
        {l.sports?.length ? <T size={13} color={c.mute}>{l.sports.map(label).join(', ')}</T> : null}
        {rate(l) ? <T weight="700" size={14}>{rate(l)}</T> : null}
        {l.summary ? <T size={13} numberOfLines={3}>{l.summary}</T> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {onRequest ? <Btn small title="Request a quote" onPress={() => onRequest(l)} accessibilityLabel={`Request a quote from ${l.display_name}`} /> : null}
          {onShortlist ? <Btn small color={c.paper} title={shortlisted ? '★ Shortlisted' : '☆ Shortlist'} onPress={() => onShortlist(l)} /> : null}
          {onOpen ? <Btn small color={c.paper} title="Open" onPress={() => onOpen(l)} /> : null}
        </View>
      </View>
    </Card>
  );
}

function Discover({ cat, onChanged }) {
  const L = useLayout();
  const { push } = useNav();
  const [f, setF] = useState({ family: null, q: '', sport: null, place: null, verified: false, remote: false, available_on: null });
  const [short, setShort] = useState(new Set());
  const [req, setReq] = useState(null);
  const [more, setMore] = useState(false);
  const query = { ...(f.family ? { family: f.family } : {}), ...(f.q ? { q: f.q } : {}), ...(f.sport ? { sport: f.sport } : {}), ...(f.place?.name ? { city: f.place.name } : {}), ...(f.verified ? { verified: true } : {}), ...(f.remote ? { remote: true } : {}), ...(f.available_on ? { available_on: f.available_on } : {}) };
  const res = useLoad(() => api.get('/marketplace/search', query), [JSON.stringify(query)]);
  const mine = useLoad(() => api.get('/me/marketplace/shortlist', { limit: 100 }), []);
  const act = useDo();
  const on = new Set([...(mine.data ?? []).map((x) => x.id), ...short]);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const chips = [<Chip key="all" label="Everyone" active={!f.family} onPress={() => set({ family: null })} />, ...cat.families.map((x) => <Chip key={x.slug} label={x.label} active={f.family === x.slug} onPress={() => set({ family: x.slug })} />)];
  const filters = (
    <View style={{ gap: 12 }}>
      <Field label="Search" value={f.q} onChangeText={(q) => set({ q })} placeholder="Provider, service or sport" accessibilityLabel="Search providers" />
      <View style={{ gap: 6 }}>
        <T weight="600" size={12} color={c.mute}>WHO</T>
        {L.tablet ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{chips}</View>
        ) : <HScroll>{chips}</HScroll>}
      </View>
      {L.tablet ? null : <Chip label={more ? 'Fewer filters ▴' : 'More filters ▾'} active={more} onPress={() => setMore(!more)} />}
      {L.tablet || more ? (
        <View style={{ gap: 12 }}>
          <SportSelect label="Sport" value={f.sport} onChange={(sport) => set({ sport })} optional allLabel="Any sport" />
          <PlacePicker label="Location" value={f.place} onChange={(place) => set({ place })} optional />
          <DateField label="Available on" value={f.available_on} onChange={(available_on) => set({ available_on })} optional />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip label="Verified only" active={f.verified} onPress={() => set({ verified: !f.verified })} />
            <Chip label="Remote ok" active={f.remote} onPress={() => set({ remote: !f.remote })} />
          </View>
        </View>
      ) : null}
    </View>
  );
  const shortlist = (l) => act(async () => { if (on.has(l.id)) { await api.del(`/marketplace/listings/${l.id}/shortlist`); short.delete(l.id); } else { await api.post(`/marketplace/listings/${l.id}/shortlist`, {}); short.add(l.id); } setShort(new Set(short)); await mine.reload(); }, on.has(l.id) ? 'Removed from shortlist' : 'Shortlisted');
  const results = (
    <View style={{ gap: 10, flex: 1 }}>
      <AdSlot placement="search_sponsored" q={f.q || undefined} sport={f.sport || undefined} />
      <T size={12} color={c.mute}>Results are ordered by relevance, then verified credentials and reviews. Paid placement never changes this order.</T>
      {res.loading ? <Loading /> : res.error ? <ErrorBox error={res.error} onRetry={res.reload} />
        : !res.data?.results.length ? <Empty emoji="🔎" title="No providers match yet" sub="Widen the filters, or list your own services from My listings." />
        : res.data.results.map((l) => <ListingCard key={l.id} l={l} cat={cat} shortlisted={on.has(l.id)} onShortlist={shortlist} onRequest={setReq} />)}
    </View>
  );
  return (
    <View style={{ flexDirection: L.tablet ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
      <View style={{ width: L.tablet ? 260 : '100%' }}>{filters}</View>
      <View style={{ flex: 1, width: L.tablet ? undefined : '100%' }}>{results}</View>
      <RequestSheet listing={req} onClose={() => setReq(null)} onDone={(e) => { setReq(null); onChanged?.(); push('MarketplaceEngagement', { id: e.id }); }} />
    </View>
  );
}

export function RequestSheet({ listing, onClose, onDone }) {
  const { toast } = useSession();
  if (!listing) return null;
  const major = listing.currency;
  return (
    <FormSheet visible onClose={onClose} title={`Ask ${listing.organisation_name ?? listing.display_name} for a quote`} submitLabel="Send request"
      fields={[
        { key: 'title', label: 'What do you need?', type: 'text' },
        { key: 'sport', label: 'Sport', type: 'sport', optional: true },
        { key: 'brief', label: 'Details for the provider', type: 'multiline', optional: true, hint: 'Kept private between you and the provider.' },
        { key: 'budget_minor', label: 'Budget', type: 'money', currency: major, optional: true },
      ]}
      onSubmit={async (v) => { const e = await api.post('/marketplace/engagements', { listing_id: listing.id, title: v.title, ...(v.sport ? { sport: v.sport } : {}), ...(v.brief ? { brief: v.brief } : {}), ...(v.budget_minor ? { budget_minor: v.budget_minor, currency: major } : {}) }); toast('Request sent'); onDone(e); }} />
  );
}

function Shortlist({ cat }) {
  const { push } = useNav();
  const s = useLoad(() => api.get('/me/marketplace/shortlist', { limit: 100 }), []);
  const [req, setReq] = useState(null);
  const act = useDo(s.reload);
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  if (!s.data.length) return <Empty emoji="☆" title="Nothing shortlisted yet" sub="Star providers in Discover to compare them here." />;
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={c.mute}>Side by side: rate, credential and rating for everyone you are considering.</T>
      {s.data.map((l) => (
        <ListingCard key={l.id} l={l} cat={cat} shortlisted
          onShortlist={(x) => act(() => api.del(`/marketplace/listings/${x.id}/shortlist`), 'Removed from shortlist')}
          onRequest={l.engagement_id ? null : setReq} onOpen={l.engagement_id ? () => push('MarketplaceEngagement', { id: l.engagement_id }) : null} />
      ))}
      <RequestSheet listing={req} onClose={() => setReq(null)} onDone={(e) => { setReq(null); push('MarketplaceEngagement', { id: e.id }); }} />
    </View>
  );
}

function Engagements({ cat }) {
  const { push } = useNav();
  const [role, setRole] = useState(null);
  const r = useLoad(() => api.get('/me/marketplace/engagements', { ...(role ? { role } : {}), limit: 100 }), [role]);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label="All" active={!role} onPress={() => setRole(null)} /><Chip label="I am buying" active={role === 'buyer'} onPress={() => setRole('buyer')} /><Chip label="I am providing" active={role === 'provider'} onPress={() => setRole('provider')} />
      </View>
      {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} />
        : !r.data.length ? <Empty emoji="🤝" title="No engagements yet" sub="Request a quote from a provider, or wait for requests to your listings." />
        : r.data.map((e) => (
          <Row key={e.id} title={e.title} onPress={() => push('MarketplaceEngagement', { id: e.id })}
            sub={`${e.my_side === 'buyer' ? `With ${e.provider_name}` : `For ${e.buyer_name}`} · ${cat.families.find((f) => f.slug === e.family)?.label ?? e.family}${e.agreed_minor != null ? ` · ${moneyIn(Number(e.agreed_minor), e.currency)}` : ''}`}
            right={<StatusTag s={e.status} />} />
        ))}
    </View>
  );
}

function Listings({ cat }) {
  const mine = useLoad(() => api.get('/me/marketplace/listings'), []);
  const orgs = useLoad(() => api.get('/organisations'), []);
  const [edit, setEdit] = useState(null);
  const act = useDo(mine.reload);
  const fields = (cur) => [
    { key: 'family', label: 'I offer services as', type: 'chips', options: cat.families.map((f) => ({ value: f.slug, label: f.label })) },
    { key: 'organisation_id', label: 'Organisation', type: 'chips', optional: true, hint: 'Required for teams and clubs; optional for others.', options: (orgs.data ?? []).filter((o) => o.my_status === 'active' && ['owner', 'admin'].includes(o.my_role)).map((o) => ({ value: o.id, label: o.name })), show: () => (orgs.data ?? []).length > 0 },
    { key: 'headline', label: 'Headline', type: 'text' },
    { key: 'summary', label: 'About the service', type: 'multiline', optional: true, hint: 'Public. Do not put personal details here.' },
    { key: 'sports', label: 'Sports', type: 'sports', optional: true },
    { key: 'place', label: 'Where', type: 'place', optional: true },
    { key: 'remote_ok', label: 'Can work remotely', type: 'switch', default: cur?.remote_ok ?? false },
    { key: 'currency', label: 'Currency', type: 'currency', default: cur?.currency },
    { key: 'rate_min_minor', label: 'Rate from', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true },
    { key: 'rate_max_minor', label: 'Rate up to', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true },
    { key: 'rate_unit', label: 'Per', type: 'chips', optional: true, options: ['hour', 'session', 'day', 'match', 'project', 'month'].map((u) => ({ value: u, label: u })) },
    { key: 'accepting', label: 'Taking new requests', type: 'switch', default: cur?.accepting ?? true },
  ];
  const save = async (v, cur) => {
    await api.post('/marketplace/listings', {
      family: v.family, ...(v.organisation_id ? { organisation_id: v.organisation_id } : {}), headline: v.headline, ...(v.summary ? { summary: v.summary } : {}), sports: v.sports ?? [],
      ...(v.place?.name ? { city: v.place.name } : {}), ...(v.place?.country ? { country: v.place.country } : {}), remote_ok: !!v.remote_ok, currency: v.currency ?? 'INR',
      ...(v.rate_min_minor ? { rate_min_minor: v.rate_min_minor } : {}), ...(v.rate_max_minor ? { rate_max_minor: v.rate_max_minor } : {}), ...(v.rate_unit ? { rate_unit: v.rate_unit } : {}), accepting: !!v.accepting, status: cur?.status === 'paused' ? 'paused' : 'active',
    });
    setEdit(null); mine.reload();
  };
  return (
    <View style={{ gap: 10 }}>
      <Btn title="＋ List my services" onPress={() => setEdit({})} style={{ alignSelf: 'flex-start' }} />
      {mine.loading ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} />
        : !mine.data.length ? <Empty emoji="🏷️" title="You have no listings" sub="List yourself or your organisation so people can find and request you." />
        : mine.data.map((l) => (
          <View key={l.id} style={{ gap: 6 }}>
            <ListingCard l={l} cat={cat} />
            {l.credential?.required && !l.credential.ok ? <T size={12} color={c.sun}>You need a verified {label(l.credential.type)} credential before a client can contract you. Apply under Me → Verification.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small color={c.paper} title={l.status === 'paused' ? 'Resume' : 'Pause'} onPress={() => act(() => api.post('/marketplace/listings', { family: l.family, ...(l.organisation_id ? { organisation_id: l.organisation_id } : {}), headline: l.headline, summary: l.summary ?? undefined, sports: l.sports, currency: l.currency, remote_ok: l.remote_ok, accepting: l.accepting, status: l.status === 'paused' ? 'active' : 'paused' }), l.status === 'paused' ? 'Listing resumed' : 'Listing paused')} />
              <Btn small color={c.paper} title="Archive" onPress={() => act(() => api.post('/marketplace/listings', { family: l.family, ...(l.organisation_id ? { organisation_id: l.organisation_id } : {}), headline: l.headline, status: 'archived' }), 'Listing archived')} />
            </View>
          </View>
        ))}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title="List my services" fields={fields(edit)} initial={{ currency: 'INR', accepting: true }} onSubmit={(v) => save(v, edit)} />
    </View>
  );
}

function Requests({ cat }) {
  const { push } = useNav();
  const open = useLoad(() => api.get('/billboard', { kind: 'service_request', limit: 50 }), []);
  const [form, setForm] = useState(false);
  const [reply, setReply] = useState(null);
  const [mineOpen, setMineOpen] = useState(null);
  const mine = (open.data ?? []).filter((p) => p.is_mine);
  const others = (open.data ?? []).filter((p) => !p.is_mine);
  return (
    <View style={{ gap: 12 }}>
      <T size={13} color={c.mute}>Post what you need and let providers with a listing respond, or answer a request with your listing. An accepted response becomes an engagement you quote, contract, schedule and pay here.</T>
      <Btn title="＋ Post a request" onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {open.loading ? <Loading /> : open.error ? <ErrorBox error={open.error} onRetry={open.reload} /> : (
        <>
          <Section title="My requests">
            {!mine.length ? <T size={13} color={c.mute}>You have not posted a request.</T> : mine.map((p) => <Row key={p.id} title={p.title} sub={`${p.accepted} accepted${p.budget_cents != null ? ` · budget ${moneyIn(Number(p.budget_cents), p.currency ?? 'INR')}` : ''}`} onPress={() => setMineOpen(p)} right={<Tag label={p.status} />} />)}
          </Section>
          <Section title="Open requests">
            {!others.length ? <Empty emoji="📭" title="No open requests" sub="Requests from other people appear here." /> : others.map((p) => (
              <Card key={p.id} pad={14}><View style={{ gap: 6 }}>
                <T weight="800" size={16}>{p.title}</T>
                <T size={13} color={c.mute}>{[p.author_name, p.city, p.sport, p.budget_cents != null ? `budget ${moneyIn(Number(p.budget_cents), p.currency ?? 'INR')}` : 'budget open'].filter(Boolean).join(' · ')}</T>
                {p.body ? <T size={13}>{p.body}</T> : null}
                <Btn small title={p.my_response ? `Responded (${p.my_response})` : 'Respond with my listing'} disabled={!!p.my_response} onPress={() => setReply(p)} style={{ alignSelf: 'flex-start' }} />
              </View></Card>
            ))}
          </Section>
        </>
      )}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Post a service request" submitLabel="Post request"
        fields={[
          { key: 'title', label: 'What do you need?', type: 'text' },
          { key: 'body', label: 'Details', type: 'multiline', optional: true },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'place', label: 'Where', type: 'place', optional: true },
          { key: 'currency', label: 'Currency', type: 'currency', default: 'INR' },
          { key: 'budget_cents', label: 'Budget', type: 'money', currency: (v) => v.currency ?? 'INR', optional: true },
          { key: 'closes_at', label: 'Responses close', type: 'datetime', optional: true },
        ]}
        initial={{ currency: 'INR' }}
        onSubmit={async (v) => { await api.post('/billboard', { kind: 'service_request', title: v.title, ...(v.body ? { body: v.body } : {}), ...(v.sport ? { sport: v.sport } : {}), ...(v.place?.name ? { city: v.place.name } : {}), ...(v.budget_cents ? { budget_cents: v.budget_cents, currency: v.currency ?? 'INR' } : {}), ...(v.closes_at ? { closes_at: v.closes_at } : {}) }); setForm(false); open.reload(); }} />
      <FormSheet visible={!!reply} onClose={() => setReply(null)} title="Respond to this request" submitLabel="Send response" fields={[{ key: 'message', label: 'Why you are a good fit', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/billboard/${reply.id}/responses`, v.message ? { message: v.message } : {}); setReply(null); open.reload(); }} />
      {mineOpen ? <MyRequest post={mineOpen} cat={cat} onClose={() => { setMineOpen(null); open.reload(); }} onEngaged={(e) => { setMineOpen(null); push('MarketplaceEngagement', { id: e.id }); }} /> : null}
    </View>
  );
}

function MyRequest({ post, cat, onClose, onEngaged }) {
  const r = useLoad(() => api.get(`/billboard/${post.id}/responses`), [post.id]);
  const act = useDo(r.reload);
  const [start, setStart] = useState(null);
  return (
    <Sheet visible onClose={onClose} title={post.title}>
      <View style={{ gap: 10 }}>
        {r.loading ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !r.data.length ? <Empty emoji="⏳" title="No responses yet" sub="Providers with a listing can respond." />
          : r.data.map((x) => x.hidden ? <T key={x.response_id} size={13} color={c.mute}>A response is waiting for guardian consent.</T> : (
            <Card key={x.response_id} pad={12}><View style={{ gap: 6 }}>
              <T weight="700">{x.display_name} <T size={12} color={c.mute}>@{x.handle}</T></T>
              {x.message ? <T size={13}>{x.message}</T> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {x.status === 'pending' ? <Btn small title="Accept" onPress={() => act(() => api.patch(`/billboard/responses/${x.response_id}`, { status: 'accepted' }), 'Accepted')} /> : <Tag label={x.status} />}
                {x.status === 'accepted' ? <Btn small title="Start engagement" onPress={() => setStart(x)} /> : null}
              </View>
            </View></Card>
          ))}
      </View>
      <FormSheet visible={!!start} onClose={() => setStart(null)} title="Start the engagement" submitLabel="Ask for a quote"
        fields={[{ key: 'family', label: 'They are providing', type: 'chips', options: cat.families.map((f) => ({ value: f.slug, label: f.label })) }]}
        onSubmit={async (v) => { const e = await api.post('/marketplace/engagements', { opportunity_response_id: start.response_id, family: v.family, title: post.title }); setStart(null); onEngaged(e); }} />
    </Sheet>
  );
}

export function MarketplaceHub({ tab: first = 'discover' }) {
  const cat = useLoad(() => api.get('/marketplace/catalogue'), []);
  const [tab, setTab] = useState(first);
  if (cat.loading) return <Screen><Loading /></Screen>;
  if (cat.error) return <Screen><ErrorBox error={cat.error} onRetry={cat.reload} /></Screen>;
  const C = cat.data;
  return (
    <Screen wide>
      <H1>Marketplace</H1>
      <T size={14} color={c.mute} style={{ marginBottom: 10 }}>Find, verify, quote, contract, schedule, pay and review: coaches, officials, clubs, medics, venues, sponsors, suppliers, agents, lawyers, insurers and media in one place.</T>
      <HScroll>{[['discover', 'Discover'], ['shortlist', 'Shortlist'], ['engagements', 'My engagements'], ['requests', 'Requests'], ['listings', 'My listings']].map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}</HScroll>
      <View style={{ marginTop: 14 }}>
        {tab === 'discover' ? <Discover cat={C} onChanged={() => {}} /> : null}
        {tab === 'shortlist' ? <Shortlist cat={C} /> : null}
        {tab === 'engagements' ? <Engagements cat={C} /> : null}
        {tab === 'requests' ? <Requests cat={C} /> : null}
        {tab === 'listings' ? <Listings cat={C} /> : null}
      </View>
    </Screen>
  );
}
