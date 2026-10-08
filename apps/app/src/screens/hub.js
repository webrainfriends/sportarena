import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { SportSelect } from '../sportpicker';
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
  const prov = useLoad(() => api.get('/providers', { limit: 50 }), []);
  const appts = useLoad(() => api.get('/appointments', { limit: 30 }), []);
  const recs = useLoad(() => api.get('/medical/records', { limit: 30 }), []);
  const isProv = has('physio', 'doctor');
  const act = async (fn, msg) => { try { await fn(); toast(msg); appts.reload(); } catch (e) { toast('' + e.message); } };
  return (
    <Screen>
      <H1>Health</H1>
      <Card color={c.mintSoft} pad={12}><T weight="900">Consent-first medical privacy</T><T size={12} color={c.mute}>Notes are encrypted. Doctors and physios only see your records after you grant access — and every read is logged.</T></Card>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'find', label: 'Find a pro', emoji: '🔎' }, { value: 'appts', label: 'Appointments', emoji: '📅' }, { value: 'records', label: 'My records', emoji: '📋' }]} value={tab} onChange={setTab} color={c.mint} /></View>
      <View style={{ gap: 10, marginTop: 8 }}>
        {tab === 'find' && (prov.loading ? <Loading /> : prov.data?.length ? prov.data.map((p, i) => (
          <Row key={i} left={<Avatar user={p} />} title={p.display_name} sub={`${p.provider_role} · ${p.sport_emoji} ${p.sport}`} right={p.id !== user.id ? <Btn small title="Book" color={c.mint} ink={c.ink} onPress={() => setBook(p)} /> : null} />
        )) : <Empty emoji="🩺" title="No providers yet" />)}
        {tab === 'appts' && (appts.data?.length ? appts.data.map((a) => (
          <Card key={a.id}><T weight="900">{a.athlete_id === user.id ? `With ${a.provider_name}` : `Athlete: ${a.athlete_name}`}</T><T size={13} color={c.mute}>{when(a.starts_at)} · {a.duration_min} min</T>{a.reason ? <T size={13} style={{ marginTop: 4 }}>“{a.reason}”</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={a.status} color={a.status === 'confirmed' ? c.lime : c.sun} />
              {a.provider_id === user.id && a.status === 'requested' ? <Btn small title="Confirm" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/appointments/${a.id}`, { status: 'confirmed' }), 'Confirmed')} /> : null}
              {a.athlete_id === user.id && a.status !== 'cancelled' ? <>
                <Btn small title="Share records" color={c.violet} onPress={() => act(() => api.post('/medical/grants', { provider_id: a.provider_id }), 'Access granted')} />
                <Btn small title="Revoke" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/medical/grants/${a.provider_id}`), 'Access revoked')} /></> : null}
            </View></Card>
        )) : <Empty emoji="📅" title="No appointments" />)}
        {tab === 'records' && (recs.data?.length ? recs.data.map((r) => <Card key={r.id}><View style={{ flexDirection: 'row', gap: 8 }}><Tag label={r.kind} color={c.cyan} />{r.clearance ? <Tag label={r.clearance.replace('_', ' ')} color={r.clearance === 'cleared' ? c.lime : c.orange} /> : null}</View><T weight="900" style={{ marginTop: 6 }}>{r.summary}</T>{r.details ? <T size={13} color={c.mute}>{r.details}</T> : null}<T size={11} color={c.mute}>{r.provider_name} · {day(r.created_at)}</T></Card>) : <Empty emoji="📋" title="No records" sub="Records written by providers you've granted access appear here." />)}
      </View>
      <FormSheet visible={!!book} onClose={() => setBook(null)} title={`Book ${book?.display_name ?? ''}`} fields={[{ key: 'when', label: 'Date & time (YYYY-MM-DD HH:MM)', placeholder: day(new Date(Date.now() + 864e5)) }, { key: 'reason', label: 'What is it about?', type: 'multiline', optional: true, hint: 'Encrypted — only you and the provider can read it.' }]}
        onSubmit={async (v) => { const d = new Date(v.when.replace(' ', 'T')); if (isNaN(d)) throw new Error('Use the format 2026-11-02 17:30'); await api.post('/appointments', { provider_id: book.id, starts_at: d.toISOString(), reason: v.reason }); appts.reload(); setTab('appts'); return 'Requested'; }} />
    </Screen>
  );
}

export function Insurance() {
  const { toast } = useSession();
  const [buy, setBuy] = useState(null);
  const [claim, setClaim] = useState(null);
  const [f, setF] = useState({ q: '', sort: 'premium', cover_for: '', verified: false });
  const [picked, setPicked] = useState([]);
  const [cmp, setCmp] = useState(null);
  const plans = useLoad(() => api.get('/insurance/plans', { sort: f.sort, limit: 50, ...(f.q.trim() ? { q: f.q.trim() } : {}), ...(f.cover_for ? { cover_for: f.cover_for } : {}), ...(f.verified ? { verified_insurer: true } : {}) }), [f.q, f.sort, f.cover_for, f.verified]);
  const claims = useLoad(() => api.get('/insurance/claims', { limit: 20 }), []);
  const pol = useLoad(() => api.get('/insurance/policies'), []);
  const teams = useLoad(() => api.get('/teams', { mine: true }), []);
  const evs = useLoad(() => api.get('/events', { limit: 50 }), []);
  const E = { individual: '🧍', team: '🛡️', event: '🎟️' };
  return (
    <Screen>
      <H1>Insurance</H1><T color={c.mute} weight="700">Cover yourself, your squad or your whole event.</T>
      <Section title="Your policies" color={c.cyan}>
        {pol.data?.length ? pol.data.map((p) => (
          <Card key={p.id} color={c.cyanSoft}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={p.emoji} color={c.paper} /><View style={{ flex: 1 }}><T weight="900">{p.plan_name}</T><T size={12} color={c.mute}>{p.insurer} · {p.policy_no} · until {day(p.ends_on)}</T></View><Tag label={p.effective_status} color={p.effective_status === 'active' ? c.lime : c.orange} /></View>
            <T size={13} style={{ marginTop: 6 }}>Covers up to <T weight="900">{money(p.coverage_cents)}</T> · {E[p.subject_type]} {p.subject_type}</T>
            <Btn small title="File a claim" color={c.ink} onPress={() => setClaim(p)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card>
        )) : <Empty emoji="🛡️" title="Not covered yet" sub="Pick a plan below." />}
      </Section>
      <Section title="Plans" color={c.pink}>
        <Field value={f.q} onChangeText={(q) => setF({ ...f, q })} placeholder="Search plans or insurers…" />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {[['', 'All'], ['individual', 'Individual'], ['team', 'Team'], ['event', 'Event']].map(([v, l]) => <Chip key={v} label={l} active={f.cover_for === v} onPress={() => setF({ ...f, cover_for: v })} />)}
          {[['premium', 'Cheapest'], ['coverage', 'Most cover'], ['deductible', 'Lowest excess']].map(([v, l]) => <Chip key={v} label={l} active={f.sort === v} onPress={() => setF({ ...f, sort: v })} />)}
          <Chip label="✓ Verified insurers" active={f.verified} onPress={() => setF({ ...f, verified: !f.verified })} />
        </View>
        {picked.length >= 2 ? <Btn small title={`Compare ${picked.length} plans`} color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={async () => { try { setCmp(await api.get('/insurance/plan-comparison', { ids: picked.join(',') })); } catch (e) { toast(e.message); } }} /> : null}
        {plans.loading && !plans.data ? <Loading /> : plans.error ? <ErrorBox error={plans.error} onRetry={plans.reload} /> : plans.data?.length ? plans.data.map((p, i) => (
          <Card key={p.id} color={[c.pinkSoft, c.violetSoft, c.limeSoft][i % 3]}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Bubble emoji={p.emoji} color={c.paper} /><View style={{ flex: 1 }}><T weight="900" size={17}>{p.name}</T><T size={12} color={c.mute}>{p.insurer}{p.insurer_verified ? ' ✓ verified' : ''} · for {p.cover_for}</T></View></View>
            {p.description ? <T size={13} style={{ marginTop: 6 }}>{p.description}</T> : null}
            <T size={12} color={c.mute} style={{ marginTop: 6 }}>Excess {money(p.deductible_cents)} · waiting period {p.waiting_period_days} days · {p.term_months.min}–{p.term_months.max} months{p.eligibility.min_age != null || p.eligibility.max_age != null ? ` · ages ${p.eligibility.min_age ?? 0}–${p.eligibility.max_age ?? 'any'}` : ''}{p.eligibility.sports.length ? ` · ${p.eligibility.sports.join(', ')}` : ''}</T>
            {p.exclusions ? <T size={12} style={{ marginTop: 4 }}><T size={12} weight="800">Not covered: </T>{p.exclusions}</T> : null}
            {p.conditions ? <T size={12} style={{ marginTop: 2 }}><T size={12} weight="800">Conditions: </T>{p.conditions}</T> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8, flexWrap: 'wrap' }}><T weight="900">{money(p.premium_cents)}<T size={12} color={c.mute}>/mo · cover {money(p.coverage_cents)}</T></T>
              <View style={{ flexDirection: 'row', gap: 6 }}><Chip label={picked.includes(p.id) ? '✓ Comparing' : 'Compare'} active={picked.includes(p.id)} onPress={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id].slice(-5))} /><Btn small title="Get cover" color={c.pink} onPress={() => setBuy(p)} /></View></View></Card>
        )) : <Empty emoji="🔎" title="No plans match" sub="Try a different search or filter." />}
      </Section>
      <Section title="Your claims" color={c.orange}>
        {claims.data?.length ? claims.data.map((cl) => (
          <Card key={cl.id} color={c.orangeSoft} pad={12}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800">{money(cl.amount_cents)}</T><Tag label={cl.status.replace('_', ' ')} color={cl.status === 'rejected' ? c.pinkSoft : cl.status === 'paid' || cl.status === 'approved' ? c.lime : c.sunSoft} /></View>
            <T size={12} color={c.mute}>Filed {day(cl.created_at)}{cl.incident_on ? ` · incident ${day(cl.incident_on)}` : ''}</T>
            {cl.decision_reason ? <T size={13} style={{ marginTop: 4 }}>Reviewer: {cl.decision_reason}</T> : null}
          </Card>
        )) : <T size={13} color={c.mute}>No claims filed.</T>}
      </Section>
      <Sheet visible={!!cmp} onClose={() => setCmp(null)} title="Compare plans">
        {cmp ? <>
          {cmp.plans.map((p) => (
            <Card key={p.id} pad={12}>
              <T weight="900">{p.name}</T><T size={12} color={c.mute}>{p.insurer}{p.insurer_verified ? ' ✓' : ''}</T>
              <T size={13}>{money(p.premium_cents)}/mo · cover {money(p.coverage_cents)} · excess {money(p.deductible_cents)} · wait {p.waiting_period_days}d</T>
              <T size={12}>Not covered: {p.exclusions ?? 'nothing listed'}</T>
              {p.conditions ? <T size={12}>Conditions: {p.conditions}</T> : null}
              <T size={11} color={c.mute}>{[cmp.highlights.lowest_premium.includes(p.id) && 'lowest premium', cmp.highlights.highest_coverage.includes(p.id) && 'highest cover', cmp.highlights.lowest_deductible.includes(p.id) && 'lowest excess', cmp.highlights.shortest_waiting_period.includes(p.id) && 'shortest wait'].filter(Boolean).join(' · ')}</T>
            </Card>
          ))}
          <T size={12} color={c.mute}>Differences: {cmp.differences.map((d) => d.replace(/_/g, ' ')).join(', ') || 'none'}. Highlights are only a guide — read what is not covered before you buy.</T>
        </> : null}
      </Sheet>
      <FormSheet visible={!!buy} onClose={() => setBuy(null)} title={buy?.name ?? ''} submitLabel="Buy 12 months"
        fields={[...(buy?.cover_for === 'team' ? [{ key: 'subject_id', label: 'Which team?', type: 'choice', options: (teams.data ?? []).map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })) }] : []), ...(buy?.cover_for === 'event' ? [{ key: 'subject_id', label: 'Which event?', type: 'choice', options: (evs.data ?? []).map((t) => ({ value: t.id, label: `${t.banner_emoji} ${t.name}` })) }] : []), { key: 'beneficiary', label: 'Beneficiary', optional: true, hint: 'Encrypted at rest.' }]}
        onSubmit={async (v) => { await api.post('/insurance/policies', { plan_id: buy.id, ...v }); pol.reload(); return 'You are covered'; }} />
      <FormSheet visible={!!claim} onClose={() => setClaim(null)} title="File a claim" submitLabel="Submit claim"
        fields={[{ key: 'amount', label: 'Amount (₹)', type: 'number' }, { key: 'incident_on', label: 'Date of the incident', type: 'date', optional: true }, { key: 'description', label: 'What happened?', type: 'multiline', hint: 'Encrypted at rest.' }]}
        onSubmit={async (v) => { await api.post(`/insurance/policies/${claim.id}/claims`, { description: v.description, amount_cents: Math.round(v.amount * 100), ...(v.incident_on ? { incident_on: v.incident_on } : {}) }); claims.reload(); return 'Claim submitted'; }} />
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
