import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Section, Sheet, T, Tag } from '../ui';
import { c, day as shortDay } from '../theme';
import { locale } from '../locale';
const day = (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

const COVER = [['individual', 'Individual'], ['team', 'Team'], ['group', 'Group'], ['organisation', 'Organisation'], ['event', 'Event']];
const label = (v) => String(v).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const kinds = (list) => (list?.length ? list.map(label).join(', ') : 'all kinds of cover');
const STATE = { invited: ['Invited', c.sunSoft], requested: ['Requested', c.sunSoft], active: ['Active', c.lime], declined: ['Declined', c.violetSoft], ended: ['Ended', c.violetSoft] };

function useAct(reload) {
  const { toast } = useSession();
  return async (fn, msg) => { try { await fn(); toast(msg); reload?.(); } catch (e) { toast('' + e.message); } };
}

/** Terms an insurer sets for a panel member. `plans` = the insurer's own plans for the multi-select. */
function TermsForm({ visible, onClose, title, initial, plans, submitLabel, onSubmit }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title={title} submitLabel={submitLabel} initial={initial}
      fields={[{ key: 'cashless', label: 'Cashless treatment (billed to the insurer)', type: 'switch', hint: 'Information for patients: how the claim is settled is between you and the provider.' },
        { key: 'cover_types', label: 'Applies to these kinds of cover (none chosen = all)', type: 'multi', optional: true, options: COVER.map(([v, l]) => ({ value: v, label: l })) },
        { key: 'plan_ids', label: 'Applies to these plans (none chosen = all your plans)', type: 'multi', optional: true, options: (plans ?? []).map((p) => ({ value: p.id, label: p.name })) },
        { key: 'valid_from', label: 'Valid from → to', type: 'daterange', toKey: 'valid_to', optional: true },
        { key: 'network_ref', label: 'Network / empanelment reference', optional: true }]}
      onSubmit={onSubmit} />
  );
}
const termsBody = (v) => ({ cashless: !!v.cashless, cover_types: v.cover_types ?? [], plan_ids: v.plan_ids ?? [], valid_from: v.valid_from ?? null, valid_to: v.valid_to ?? null, network_ref: v.network_ref || null });

/** Insurer desk: the panel of physios/doctors. */
export function InsurerPanel() {
  const list = useLoad(() => api.get('/insurance/panel/mine', { limit: 100 }), []);
  const plans = useLoad(() => api.get('/insurance/my-plans', { status: 'active', limit: 100 }), []);
  const [terms, setTerms] = useState(null), [invite, setInvite] = useState(false), [pick, setPick] = useState(null);
  const act = useAct(list.reload);
  const mine = (list.data ?? []).filter((m) => m.as === 'insurer');
  return (
    <Section title="Panel doctors & physios" color={c.mint}>
      <T size={13} color={c.mute}>Providers your policyholders can see under their cover. Both sides agree: you invite, they accept (or they ask, you approve). Only providers with a current professional verification are shown to patients.</T>
      <Btn small title="Invite a provider" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setInvite(true)} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : mine.length ? mine.map((m) => (
        <Card key={m.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar user={{ ...m, id: m.provider_user_id }} size={40} />
            <View style={{ flex: 1 }}><T weight="800">{m.display_name}</T><T size={12} color={c.mute}>{[label(m.provider_type ?? 'provider'), m.city].filter(Boolean).join(' · ')}</T></View>
            <Tag label={STATE[m.status][0]} color={STATE[m.status][1]} />
          </View>
          {m.status === 'active' ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{m.cashless ? 'Cashless' : 'Not cashless'} · {kinds(m.cover_types)}{m.plan_ids.length ? ` · ${m.plan_ids.length} plan(s)` : ''}{m.valid_to ? ` · until ${day(m.valid_to)}` : ''}{m.network_ref ? ` · ref ${m.network_ref}` : ''}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {m.status === 'requested' ? <><Btn small title="Approve…" color={c.mint} ink={c.ink} onPress={() => setTerms({ m, approve: true })} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/insurance/panel/${m.id}/respond`, { accept: false }), 'Declined')} /></> : null}
            {m.status === 'active' ? <Btn small title="Edit terms" color={c.violet} onPress={() => setTerms({ m })} /> : null}
            {['invited', 'requested', 'active'].includes(m.status) ? <Btn small title={m.status === 'active' ? 'Remove from panel' : 'Withdraw'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/insurance/panel/${m.id}/end`, {}), 'Removed — history kept')} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🩺" title="No panel yet" sub="Invite physios and doctors so your policyholders know who to see." />}
      <FindProvider visible={invite} onClose={() => setInvite(false)} onPick={(p) => { setInvite(false); setPick(p); }} />
      <TermsForm visible={!!pick} onClose={() => setPick(null)} title={pick ? `Invite ${pick.display_name}` : ''} submitLabel="Send invitation" initial={{ cashless: false, plan_ids: [], cover_types: [] }} plans={plans.data}
        onSubmit={async (v) => { await api.post('/insurance/panel', { provider_id: pick.id, ...termsBody(v) }); list.reload(); return 'Invitation sent'; }} />
      <TermsForm visible={!!terms} onClose={() => setTerms(null)} title={terms?.approve ? 'Approve with terms' : 'Edit terms'} submitLabel={terms?.approve ? 'Approve' : 'Save'} plans={plans.data}
        initial={terms ? { cashless: terms.m.cashless, cover_types: terms.m.cover_types, plan_ids: terms.m.plan_ids, valid_from: terms.m.valid_from?.slice(0, 10), valid_to: terms.m.valid_to?.slice(0, 10), network_ref: terms.m.network_ref ?? '' } : {}}
        onSubmit={async (v) => { await (terms.approve ? api.post(`/insurance/panel/${terms.m.id}/respond`, { accept: true, ...termsBody(v) }) : api.patch(`/insurance/panel/${terms.m.id}`, termsBody(v))); list.reload(); return terms.approve ? 'Approved' : 'Terms saved'; }} />
    </Section>
  );
}

/** Search-and-pick a physio/doctor. */
function FindProvider({ visible, onClose, onPick }) {
  const [q, setQ] = useState('');
  const res = useLoad(() => (visible ? api.get('/providers/search', { limit: 20, ...(q.trim() ? { q: q.trim() } : {}) }) : Promise.resolve([])), [visible, q]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Find a physio or doctor">
      <Field value={q} onChangeText={setQ} placeholder="Search by name, clinic or city…" />
      {res.loading && !res.data ? <Loading /> : res.data?.length ? res.data.map((p) => (
        <Card key={p.id} pad={10} onPress={() => onPick(p)}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Avatar user={p} size={36} /><View style={{ flex: 1 }}><T weight="800">{p.display_name}{p.credential_verified ? ' ✓' : ''}</T><T size={12} color={c.mute}>{[label(p.provider_type ?? ''), p.clinic, p.city].filter(Boolean).join(' · ')}</T></View></View></Card>
      )) : <Empty emoji="🔎" title="No providers found" />}
    </Sheet>
  );
}

/** Physio/doctor: my insurer links, invitations, and asking to join a panel. */
export function ProviderPanels() {
  const list = useLoad(() => api.get('/insurance/panel/mine', { limit: 100 }), []);
  const insurers = useLoad(() => api.get('/insurance/insurers', { limit: 100 }), []);
  const [ask, setAsk] = useState(false), [insId, setInsId] = useState(null);
  const act = useAct(list.reload);
  const mine = (list.data ?? []).filter((m) => m.as === 'provider');
  return (
    <Section title="Insurance panels" color={c.cyan}>
      <T size={13} color={c.mute}>Insurers whose panel you are on. Patients covered by them can find you through their insurance. You are only listed when you agree, and only while your professional verification is current.</T>
      <Btn small title="Ask to join an insurer's panel" color={c.pink} style={{ alignSelf: 'flex-start' }} onPress={() => setAsk(true)} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : mine.length ? mine.map((m) => (
        <Card key={m.id} pad={12} color={m.waiting_for_me ? c.sunSoft : c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{m.insurer_name}{m.insurer_verified ? ' ✓' : ''}</T><Tag label={STATE[m.status][0]} color={STATE[m.status][1]} /></View>
          {m.status === 'active' ? <T size={12} color={c.mute}>{m.cashless ? 'Cashless' : 'Not cashless'} · {kinds(m.cover_types)}{m.valid_to ? ` · until ${day(m.valid_to)}` : ''}</T> : null}
          {m.status === 'invited' ? <T size={12} color={c.mute}>They invited you. Accepting lists you for their policyholders.</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {m.status === 'invited' ? <><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/insurance/panel/${m.id}/respond`, { accept: true }), 'You are on the panel')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/insurance/panel/${m.id}/respond`, { accept: false }), 'Declined')} /></> : null}
            {['requested', 'active'].includes(m.status) ? <Btn small title={m.status === 'active' ? 'Leave this panel' : 'Withdraw request'} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/insurance/panel/${m.id}/end`, {}), 'Done — history kept')} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🛡️" title="Not on any panel" sub="Ask an insurer to add you, or wait for an invitation." />}
      <Sheet visible={ask} onClose={() => setAsk(false)} title="Ask to join a panel">
        <T size={13} color={c.mute}>Choose the insurer. They decide and set the terms.</T>
        {insurers.loading && !insurers.data ? <Loading /> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(insurers.data ?? []).map((i) => <Chip key={i.id} label={`${i.name}${i.verified ? ' ✓' : ''}`} active={insId === i.id} onPress={() => setInsId(i.id)} />)}</View>}
        <Btn title="Send request" color={c.pink} disabled={!insId} onPress={() => act(async () => { await api.post('/insurance/panel/requests', { insurer_id: insId }); setAsk(false); }, 'Request sent')} />
      </Sheet>
    </Section>
  );
}

/** Patient: providers I can see under my insurance (own, team, event cover). */
export function CoveredProviders({ onBook, filters }) {
  const res = useLoad(() => api.get('/insurance/covered-providers', { limit: 100, ...(filters?.type ? { provider_type: filters.type } : {}) }), [filters?.type]);
  if (res.loading && !res.data) return <Loading />;
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  const { covers, providers } = res.data;
  if (!covers.length) return <Empty emoji="🛡️" title="No active insurance found" sub="When you hold a policy (or belong to a team or event that does), providers on that insurer's panel appear here." />;
  return (
    <View style={{ gap: 8 }}>
      <Card color={c.mintSoft} pad={10}><T weight="800" size={13}>Your cover</T>{covers.map((x) => <T key={x.policy_id} size={12}>{x.insurer} · {x.plan_name}{x.subject_name ? ` · ${x.subject_name}` : ''} ({label(x.cover_for)}) until {day(x.ends_on)}</T>)}</Card>
      {providers.length ? providers.map((p) => (
        <Card key={p.id} pad={12}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar user={p} size={44} />
            <View style={{ flex: 1 }}><T weight="800">{p.display_name} ✓</T><T size={12} color={c.mute}>{[label(p.provider_type), p.clinic, p.city, p.remote_ok ? 'remote' : null].filter(Boolean).join(' · ')}</T>
              {p.covered_by.map((v) => <T key={v.policy_id} size={12} color={c.mute}>Under {v.insurer} · {v.plan}{p.cashless ? ' · cashless' : ''}</T>)}</View>
            {onBook ? <Btn small title="Book" onPress={() => onBook(p)} /> : null}
          </View>
        </Card>
      )) : <Empty emoji="🩺" title="No panel providers yet" sub="Your insurer has not listed any physios or doctors for this cover." />}
      <T size={11} color={c.mute}>Being on a panel is the insurer's arrangement. Check the insurer's terms for what is covered before you book.</T>
    </View>
  );
}
