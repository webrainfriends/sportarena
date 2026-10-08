import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect } from '../sportpicker';
import { AddFollowupSheet, BookProviderSheet, ConsentManager, FollowupsPanel } from './provider';
import { PaySheet } from '../PaySheet';
import { c, grad, money, day, when } from '../theme';

const TILES = [
  ['Leaderboard', '🏅', 'Leaderboard', 'Points & glory', c.lime], ['Health', '🩺', 'Health', 'Physio · doctors · fit to play', c.mint],
  ['Insurance', '🛡️', 'Insurance', 'You · your team · your event', c.cyan], ['Sponsors', '💎', 'Sponsors', 'Brands & deals', c.sun],
  ['Supply', '📦', 'Supply chain', 'Kit, stock & orders', c.orange], ['Awards', '🏆', 'Trophy room', 'Cups, medals, MVPs', c.pink],
];

export function Hub() {
  const { push } = useNav();
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Ecosystem</H1>
      <T color={c.mute} weight="500" style={{ marginTop: 2 }}>Everything around the game, in one place.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 18 }}>
        {TILES.map(([name, e, title, sub]) => (
          <Card key={name} style={{ width: '48%', flexGrow: 1 }} onPress={() => push(name)} pad={16}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{e}</T></View>
            <T weight="700" size={16} style={{ marginTop: 14 }}>{title}</T>
            <T size={12} color={c.mute} style={{ marginTop: 2 }}>{sub}</T>
          </Card>
        ))}
      </View>
    </Screen>
  );
}

export function Leaderboard() {
  const { push } = useNav();
  const [sport, setSport] = useState(null);
  const lb = useLoad(() => api.get('/leaderboard', { sport: sport ?? undefined, limit: 50 }), [sport]);
  return (
    <Screen>
      <H1>Leaderboard</H1>
      <SportSelect allLabel="All sports" value={sport} onChange={setSport} />
      <View style={{ gap: 10, marginTop: 10 }}>
        {lb.loading && !lb.data ? <Loading /> : lb.data?.length ? lb.data.map((a) => (
          <Row key={a.id} color={a.rank === 1 ? c.sunSoft : c.paper} onPress={() => push('Person', { id: a.id })} left={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="900" size={20}>{a.rank === 1 ? '🥇' : a.rank === 2 ? '🥈' : a.rank === 3 ? '🥉' : a.rank}</T><Avatar user={a} /></View>}
            title={a.display_name} sub={`${a.entries} entries`} right={<Tag label={`${a.points} pts`} color={c.lime} />} />
        )) : <Empty emoji="📈" title="No scores yet" />}
      </View>
    </Screen>
  );
}

export function Awards() {
  const aw = useLoad(() => api.get('/awards', { limit: 100 }), []);
  const E = { cup: '🏆', trophy: '🏅', medal_gold: '🥇', medal_silver: '🥈', medal_bronze: '🥉', mvp: '🌟', badge: '🎖️' };
  return (
    <Screen><H1>Trophy room</H1>
      <View style={{ gap: 10, marginTop: 10 }}>{aw.loading && !aw.data ? <Loading /> : aw.data?.length ? aw.data.map((a, i) => <Row key={a.id} color={[c.sunSoft, c.pinkSoft, c.cyanSoft][i % 3]} left={<Bubble emoji={E[a.kind]} color={c.paper} />} title={a.name} sub={`${a.team_name ?? a.display_name ?? ''}${a.event_name ? ' · ' + a.event_name : ''}`} />) : <Empty emoji="🏆" title="Nothing awarded yet" />}</View>
    </Screen>
  );
}

export function Health() {
  const { user, has, toast } = useSession();
  const [tab, setTab] = useState('find');
  const [book, setBook] = useState(null);
  const [paying, setPaying] = useState(null);
  const [fu, setFu] = useState(null);
  const prov = useLoad(() => api.get('/providers/search', { limit: 50, sort: 'rating' }), []);
  const appts = useLoad(() => api.get('/appointments', { limit: 30 }), []);
  const recs = useLoad(() => api.get('/medical/records', { limit: 30 }), []);
  const isProv = has('physio', 'doctor');
  const act = async (fn, msg) => { try { await fn(); toast(msg); appts.reload(); } catch (e) { toast('' + e.message); } };
  return (
    <Screen>
      <H1>Health</H1>
      <Card color={c.mintSoft} pad={12}><T weight="900">Consent-first medical privacy</T><T size={12} color={c.mute}>Notes are encrypted. Doctors and physios only see your records after you grant access — and every read is logged.</T></Card>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'find', label: 'Find a pro', emoji: '🔎' }, { value: 'appts', label: 'Appointments', emoji: '📅' }, { value: 'records', label: 'My records', emoji: '📋' }, { value: 'followups', label: 'Follow-ups', emoji: '🗓️' }, { value: 'consent', label: 'Access', emoji: '🔒' }]} value={tab} onChange={setTab} color={c.mint} /></View>
      <View style={{ gap: 10, marginTop: 8 }}>
        {tab === 'find' && (prov.loading ? <Loading /> : prov.data?.length ? prov.data.map((p, i) => (
          <Row key={i} left={<Avatar user={p} />} title={p.display_name} sub={[p.provider_type, p.sports.join(', '), p.city, p.credential_verified ? '✓ verified' : null, p.rating ? `★ ${Number(p.rating).toFixed(1)}` : null, p.fee_cents ? money(p.fee_cents) : null].filter(Boolean).join(' · ')} right={p.id !== user.id ? <Btn small title="Book" color={c.mint} ink={c.ink} onPress={() => setBook(p)} /> : null} />
        )) : <Empty emoji="🩺" title="No providers yet" />)}
        {tab === 'consent' && <ConsentManager />}
        {tab === 'followups' && <FollowupsPanel />}
        {tab === 'appts' && (appts.data?.length ? appts.data.map((a) => (
          <Card key={a.id}><T weight="900">{a.athlete_id === user.id ? `With ${a.provider_name}` : `Athlete: ${a.athlete_name}`}</T><T size={13} color={c.mute}>{when(a.starts_at)} · {a.duration_min} min</T>{a.reason ? <T size={13} style={{ marginTop: 4 }}>“{a.reason}”</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={a.status} color={a.status === 'confirmed' ? c.lime : c.sun} />{a.payment_status === 'unpaid' ? <Tag label="unpaid" color={c.orangeSoft} /> : a.payment_status === 'paid' ? <Tag label="paid" color={c.lime} /> : null}{a.source === 'external' ? <Tag label="external" color={c.cyanSoft} /> : null}
              {a.athlete_id === user.id && a.payment_status === 'unpaid' && a.status !== 'cancelled' ? <Btn small title={`Pay ${money(a.fee_cents)}`} color={c.pink} onPress={() => setPaying({ type: 'appointment', id: a.id, amount: a.fee_cents, currency: a.currency, label: `Appointment with ${a.provider_name}` })} /> : null}
              {a.provider_id === user.id && ['confirmed', 'completed'].includes(a.status) ? <Btn small title="Add follow-up" color={c.violet} onPress={() => setFu(a)} /> : null}
              {a.provider_id === user.id && a.status === 'requested' ? <Btn small title="Confirm" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'confirmed' }), 'Confirmed')} /> : null}
              {['requested', 'confirmed'].includes(a.status) ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'cancelled' }), 'Cancelled')} /> : null}
              {a.provider_id === user.id && a.status === 'confirmed' ? <Btn small title="Complete" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'completed' }), 'Completed')} /> : null}
              {a.athlete_id === user.id && !['cancelled', 'completed'].includes(a.status) ? <>
                <Btn small title="Share records" color={c.violet} onPress={() => act(() => api.post('/medical/grants', { provider_id: a.provider_id }), 'Access granted')} />
                <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/medical/grants/${a.provider_id}`), 'Access revoked')} /></> : null}
            </View></Card>
        )) : <Empty emoji="📅" title="No appointments" />)}
        {tab === 'records' && (recs.data?.length ? recs.data.map((r) => <Card key={r.id}><View style={{ flexDirection: 'row', gap: 8 }}><Tag label={r.kind} color={c.cyan} />{r.clearance ? <Tag label={r.clearance.replace('_', ' ')} color={r.clearance === 'cleared' ? c.lime : c.orange} /> : null}</View><T weight="900" style={{ marginTop: 6 }}>{r.summary}</T>{r.details ? <T size={13} color={c.mute}>{r.details}</T> : null}<T size={11} color={c.mute}>{r.provider_name} · {day(r.created_at)}</T></Card>) : <Empty emoji="📋" title="No records" sub="Records written by providers you've granted access appear here." />)}
      </View>
      {paying ? <PaySheet target={paying} onClose={() => setPaying(null)} onDone={appts.reload} /> : null}
      <AddFollowupSheet appointment={fu} onClose={() => setFu(null)} onDone={() => { setFu(null); }} />
      {book ? <BookProviderSheet provider={book} onClose={() => setBook(null)} onDone={() => { appts.reload(); setTab('appts'); }} /> : null}
    </Screen>
  );
}

export function Sponsors() {
  const { has, user, toast } = useSession();
  const [form, setForm] = useState(null);
  const [offerTo, setOfferTo] = useState(null);
  const [q, setQ] = useState('');
  const dir = useLoad(() => api.get('/sponsors', { limit: 50 }), []);
  const mine = useLoad(() => api.get('/sponsors', { mine: true, limit: 50 }), []);
  const deals = useLoad(() => api.get('/sponsorships', { limit: 100 }), []);
  const evs = useLoad(() => api.get('/events', { limit: 50 }), []);
  const profile = useLoad(() => api.get('/me/sponsorship-profile'), []);
  const athletes = useLoad(() => (has('sponsor') ? api.get('/sponsorable-athletes', { limit: 30, ...(q.trim() ? { q: q.trim() } : {}) }) : Promise.resolve([])), [q]);
  const act = async (fn, m) => { try { await fn(); toast(m); deals.reload(); } catch (e) { toast('' + e.message); } };
  const pr = profile.data;
  return (
    <Screen>
      <H1>Sponsors</H1>
      {has('sponsor') ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}><Btn small title="Create brand" color={c.violet} onPress={() => setForm('brand')} /><Btn small title="Propose a deal" color={c.pink} onPress={() => setForm('deal')} /></View> : null}
      {has('athlete') ? (
        <Section title="Open to sponsors" color={c.mint}>
          <T size={13} color={c.mute}>Off by default. When you turn it on, sponsors can find your name, sports and pitch — never your contact details — and send you offers you can accept or decline.</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Chip label={pr?.open_to_sponsors ? '✓ Open to offers' : 'Not open to offers'} active={!!pr?.open_to_sponsors} onPress={() => act(() => api.post('/me/sponsorship-profile', { open_to_sponsors: !pr?.open_to_sponsors }).then(profile.reload), pr?.open_to_sponsors ? 'Hidden from sponsors' : 'Sponsors can find you')} />
            <Btn small title="Edit pitch" color={c.violet} onPress={() => setForm('pitch')} />
          </View>
          {pr?.pitch ? <T size={13} style={{ marginTop: 6 }}>{pr.pitch}</T> : null}
          {pr?.verified_sponsors_only ? <T size={12} color={c.mute}>Only verified sponsors can send you offers.</T> : null}
        </Section>
      ) : null}
      <Section title="Your deals" color={c.sun}>
        {deals.data?.length ? deals.data.map((d) => (
          <Card key={d.id} color={c.sunSoft}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={d.sponsor_emoji} color={c.paper} /><View style={{ flex: 1 }}><T weight="900">{d.sponsor_name}{d.sponsor_verified ? ' ✓' : ''} → {d.target_name ?? d.target_type}</T><T size={12} color={c.mute}>{[d.amount_cents ? money(d.amount_cents) : null, d.in_kind].filter(Boolean).join(' + ') || 'Support offered'}{d.starts_on ? ` · ${day(d.starts_on)} to ${d.ends_on ? day(d.ends_on) : 'open'}` : ''}</T></View><Tag label={d.status} color={d.status === 'active' ? c.lime : d.status === 'proposed' ? c.sunSoft : c.pinkSoft} /></View>
            {d.objectives ? <T size={12} style={{ marginTop: 6 }}><T size={12} weight="800">Objectives: </T>{d.objectives}</T> : null}
            {d.deliverables ? <T size={12}><T size={12} weight="800">Deliverables: </T>{d.deliverables}</T> : null}
            {d.message ? <T size={12} color={c.mute}>“{d.message}”</T> : null}
            {d.decision_reason ? <T size={12} color={c.mute}>Reply: {d.decision_reason}</T> : null}
            {d.status === 'proposed' && !d.i_am_sponsor ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active' }), 'Deal on!')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'declined' }), 'Declined')} />{d.target_type === 'athlete' ? <Btn small title="Accept & show on sponsor page" color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'active', show_publicly: true }), 'Deal on, shown publicly')} /> : null}</View> : null}
            {d.status === 'proposed' && d.i_am_sponsor ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Withdraw offer" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/sponsorships/${d.id}/withdraw`), 'Offer withdrawn')} /></View> : null}
            {d.status === 'active' ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="End deal" color={c.paper} ink={c.red} onPress={() => act(() => api.patch(`/sponsorships/${d.id}`, { status: 'ended' }), 'Deal ended')} /></View> : null}
          </Card>
        )) : <Empty emoji="🤝" title="No deals yet" />}
      </Section>
      {has('sponsor') ? (
        <Section title="Athletes open to sponsors" color={c.cyan}>
          <Field value={q} onChangeText={setQ} placeholder="Search athletes by name or pitch…" />
          {athletes.loading && !athletes.data ? <Loading /> : athletes.error ? <ErrorBox error={athletes.error} onRetry={athletes.reload} /> : athletes.data?.length ? athletes.data.map((a) => (
            <Row key={a.id} left={<Avatar user={a} />} title={`${a.display_name}${a.verified?.length ? ' ✓' : ''}`} sub={[a.sports.join(', '), a.looking_for.join(', '), a.pitch].filter(Boolean).join(' · ')} right={<Btn small title="Offer" color={c.pink} onPress={() => setOfferTo(a)} />} />
          )) : <Empty emoji="🏅" title="No athletes found" sub="Athletes only appear here after they opt in." />}
        </Section>
      ) : null}
      <Section title="Brands" color={c.pink}>{dir.data?.map((s) => <Row key={s.id} left={<Bubble emoji={s.emoji} color={c.sun} />} title={s.name} sub={s.industry ?? s.website} />)}</Section>
      <FormSheet visible={form === 'brand'} onClose={() => setForm(null)} title="Create your brand" fields={[{ key: 'name', label: 'Brand name' }, { key: 'industry', label: 'Industry', optional: true }, { key: 'contact_email', label: 'Contact email', optional: true, hint: 'Encrypted — never shown publicly.' }]}
        onSubmit={async (v) => { await api.post('/sponsors', v); dir.reload(); mine.reload(); return 'Brand created'; }} />
      <FormSheet visible={form === 'pitch'} onClose={() => setForm(null)} title="Your sponsor pitch" initial={{ pitch: pr?.pitch ?? '', looking_for: pr?.looking_for ?? [], verified_sponsors_only: !!pr?.verified_sponsors_only }}
        fields={[{ key: 'pitch', label: 'What should sponsors know about you?', type: 'multiline', optional: true, hint: 'Shown to sponsors. Do not include contact details.' }, { key: 'looking_for', label: 'What are you looking for?', type: 'multi', optional: true, options: ['cash', 'equipment', 'travel', 'coaching', 'apparel', 'nutrition', 'media'] }, { key: 'verified_sponsors_only', label: 'Only verified sponsors may send offers', type: 'switch' }]}
        onSubmit={async (v) => { await api.post('/me/sponsorship-profile', { open_to_sponsors: !!pr?.open_to_sponsors, pitch: v.pitch ?? null, looking_for: v.looking_for ?? [], verified_sponsors_only: v.verified_sponsors_only }); profile.reload(); return 'Saved'; }} />
      <FormSheet visible={form === 'deal'} onClose={() => setForm(null)} title="Propose sponsorship" submitLabel="Send offer"
        fields={[{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: (mine.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) }, { key: 'target_id', label: 'Event', type: 'choice', options: (evs.data ?? []).map((e) => ({ value: e.id, label: `${e.banner_emoji} ${e.name}` })) }, { key: 'amount', label: 'Amount (₹)', type: 'number' }, { key: 'in_kind', label: 'In-kind support', optional: true }]}
        onSubmit={async (v) => { await api.post('/sponsorships', { sponsor_id: v.sponsor_id, target_type: 'event', target_id: v.target_id, amount_cents: Math.round(v.amount * 100), in_kind: v.in_kind }); deals.reload(); return 'Offer sent'; }} />
      <FormSheet visible={!!offerTo} onClose={() => setOfferTo(null)} title={`Offer to ${offerTo?.display_name ?? ''}`} submitLabel="Send offer"
        fields={[{ key: 'sponsor_id', label: 'Brand', type: 'choice', options: (mine.data ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` })) },
          { key: 'amount', label: 'Amount (₹, 0 if only in-kind)', type: 'number' }, { key: 'in_kind', label: 'In-kind support', optional: true },
          { key: 'starts_on', label: 'Starts', type: 'date' }, { key: 'ends_on', label: 'Ends', type: 'date' },
          { key: 'objectives', label: 'Objectives', type: 'multiline', optional: true }, { key: 'deliverables', label: 'What you expect from the athlete', type: 'multiline' }, { key: 'message', label: 'Personal message', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/sponsorships', { target_type: 'athlete', target_id: offerTo.id, ...v, amount_cents: Math.round((v.amount ?? 0) * 100), amount: undefined }); deals.reload(); return 'Offer sent — they will be notified'; }} />
    </Screen>
  );
}

export function Supply() {
  const { toast } = useSession();
  const [form, setForm] = useState(null);
  const inv = useLoad(() => api.get('/inventory', { limit: 100 }), []);
  const ord = useLoad(() => api.get('/supply-orders', { limit: 50 }), []);
  const act = async (fn, m) => { try { await fn(); inv.reload(); ord.reload(); if (m) toast(m); } catch (e) { toast('' + e.message); } };
  return (
    <Screen>
      <H1>Supply chain</H1>
      <Btn small title="Add stock item" color={c.orange} onPress={() => setForm('item')} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      <Section title="Inventory" color={c.orange}>
        {inv.data?.length ? inv.data.map((i) => (
          <Card key={i.id} color={i.low_stock ? c.orangeSoft : c.paper} pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="900">{i.name}</T><T size={12} color={c.mute}>{i.category} · reorder at {i.reorder_level}</T>{i.low_stock ? <Tag label="low stock" color={c.red} ink="#fff" style={{ marginTop: 4 }} /> : null}</View>
              <Btn small title="−" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: -1 }))} />
              <T weight="900" size={20} style={{ minWidth: 34, textAlign: 'center' }}>{i.quantity}</T>
              <Btn small title="+" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/inventory/${i.id}/adjust`, { delta: 1 }))} />
            </View>
            {i.low_stock ? <Btn small title="Reorder" color={c.ink} onPress={() => setForm({ order: i })} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
          </Card>
        )) : <Empty emoji="📦" title="No stock tracked" />}
      </Section>
      <Section title="Orders" color={c.cyan}>
        {ord.data?.length ? ord.data.map((o) => (
          <Row key={o.id} left={<Bubble emoji="🚚" color={c.cyanSoft} />} title={`${o.quantity} × ${o.item_name}`} sub={`${o.supplier}${o.expected_on ? ' · by ' + day(o.expected_on) : ''}`}
            right={o.status === 'ordered' || o.status === 'shipped' ? <Btn small title="Received" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/supply-orders/${o.id}`, { status: 'received' }), 'Stock updated')} /> : <Tag label={o.status} color={c.lime} />} />
        )) : <Empty emoji="🚚" title="No orders" />}
      </Section>
      <FormSheet visible={form === 'item'} onClose={() => setForm(null)} title="Add stock" fields={[{ key: 'name', label: 'Item' }, { key: 'category', label: 'Category', type: 'choice', options: ['equipment', 'apparel', 'nutrition', 'medical', 'merch', 'other'] }, { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'reorder_level', label: 'Reorder at', type: 'number', optional: true }]}
        onSubmit={async (v) => { await api.post('/inventory', v); inv.reload(); return 'Added'; }} />
      <FormSheet visible={!!form?.order} onClose={() => setForm(null)} title={`Reorder ${form?.order?.name ?? ''}`} fields={[{ key: 'supplier', label: 'Supplier' }, { key: 'quantity', label: 'Quantity', type: 'number' }]}
        onSubmit={async (v) => { await api.post('/supply-orders', { item_id: form.order.id, ...v }); ord.reload(); return 'Order placed'; }} />
    </Screen>
  );
}
