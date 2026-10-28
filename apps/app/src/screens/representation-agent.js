// Agent home (#484): Clients · Mandates · Opportunities · Negotiations · Transfers · Sponsorships · Commissions · Conflicts · Documents · Reports.
// Everything here is the agent's own business record or something an athlete shared under an agreed, live mandate; the server checks that on every call.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { HScroll } from '../pickers';
import { SportPicker } from '../sportpicker';
import { c } from '../theme';
import { saveFile } from '../contracts-ui';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Ladder, LiveTag, Note, Split, StatusTag, TermsSheet, cash, key, nice, plainDate, say, sentence, useMatrix, when } from '../representation-ui';
import { MandateDetail, DealsPanel, ConflictsPanel } from './representation-mandate';

const TABS = [['clients', 'Clients'], ['mandates', 'Mandates'], ['opportunities', 'Opportunities'], ['negotiations', 'Negotiations'], ['transfers', 'Transfers'], ['sponsorships', 'Sponsorships'], ['commissions', 'Commissions'], ['conflicts', 'Conflicts'], ['documents', 'Documents'], ['reports', 'Reports']];
const SECTIONS = [['video', 'Video'], ['references', 'References'], ['preferences', 'Preferences'], ['availability', 'Availability'], ['academic', 'Academic']].map(([value, label]) => ({ value, label }));
const STAGE = { shared: 'Shared', interest_requested: 'Interest requested', drafting: 'Drafting', awaiting_athlete: 'Waiting for the athlete', submitted: 'Submitted', outcome: 'Outcome', dropped: 'Dropped' };

export function AgentHome({ profile, reloadProfile, tab: wantTab }) {
  const [tab, setTab] = useState(wantTab ?? 'clients');
  const [sel, setSel] = useState(null);
  const own = profile?.profile;
  const staffOf = profile?.works_for?.[0];
  if (!own && !staffOf) return <Setup reload={reloadProfile} />;
  const agentId = own ? undefined : staffOf.id;
  return <Home agentId={agentId} own={own} tab={tab} setTab={setTab} sel={sel} setSel={setSel} reloadProfile={reloadProfile} />;
}

function Setup({ reload }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const ids = new Map((sports.data ?? []).map((s) => [s.slug, s.id]));
  const mine = (orgs.data ?? []).filter((o) => ['owner', 'admin'].includes(o.role ?? o.my_role));
  return (
    <View style={{ gap: 12 }}>
      <Empty emoji="🧑‍💼" title="Set up your agent profile" sub="A profile is a business identity, never access to anyone. Athletes find you once SportArena verifies you, and you only ever see what an athlete agrees to share." />
      <Btn title="Create my agent profile" onPress={() => setOpen(true)} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Your agent profile" submitLabel="Create profile"
        fields={[
          { key: 'kind', label: 'You are', type: 'choice', options: [{ value: 'individual', label: 'An individual agent' }, ...(mine.length ? [{ value: 'agency', label: 'An agency' }] : [])] },
          { key: 'organisation_id', label: 'Agency organisation', type: 'chips', options: mine.map((o) => ({ value: o.id, label: o.name })), show: (f) => f.kind === 'agency' },
          { key: 'display_name', label: 'Name athletes see', type: 'text' }, { key: 'bio', label: 'About you', type: 'multiline', optional: true },
          { key: 'sports', label: 'Sports you represent', type: 'sports', optional: true }, { key: 'worldwide', label: 'Worldwide', type: 'switch' }, { key: 'markets', label: 'Markets', type: 'countries', show: (f) => !f.worldwide, optional: true },
          { key: 'is_public', label: 'List me in the directory once verified', type: 'switch', hint: 'You can change this at any time. Listing is not an endorsement and gives no access.' },
        ]}
        initial={{ kind: 'individual', worldwide: true, is_public: false }}
        onSubmit={async (v) => { await api.post('/agents/me', { kind: v.kind, organisation_id: v.kind === 'agency' ? v.organisation_id : undefined, display_name: v.display_name, bio: v.bio || undefined, sport_ids: (v.sports ?? []).map((s) => ids.get(s)).filter(Boolean), markets: v.worldwide ? ['WW'] : v.markets ?? [], is_public: v.is_public }); setOpen(false); toast('Profile created'); reload(); }} />
    </View>
  );
}

function Home({ agentId, own, tab, setTab, sel, setSel, reloadProfile }) {
  const { push } = useNav();
  const home = useLoad(() => api.get('/agent/home', agentId ? { agent_id: agentId } : undefined), [agentId]);
  if (home.loading && !home.data) return <Loading />;
  if (home.error) return <ErrorBox error={home.error} onRetry={home.reload} />;
  const h = home.data;
  const refresh = () => { home.reload(); reloadProfile?.(); };
  const badge = { opportunities: h.pipeline?.awaiting_athlete, negotiations: h.contracts_to_review, conflicts: h.conflicts_open, mandates: h.mandates.proposed };
  return (
    <View style={{ gap: 14 }}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200 }}><T weight="800" size={18}>{h.agent.display_name}</T><T size={13} color={c.mute}>{h.agent.kind === 'agency' ? 'Agency' : 'Individual agent'}{h.acting_as === 'staff' ? ' · you act as delegated staff' : ''}{h.agent.is_public ? ' · listed' : ' · not listed'}</T></View>
          {h.verification.verified ? <Tag label="Verified" color={c.mint} /> : <Tag label="Not verified" color={c.pinkSoft} />}
          {h.agent.status === 'suspended' ? <Tag label="Suspended" color={c.pinkSoft} /> : null}
        </View>
        {h.verification.verified ? (
          <View style={{ marginTop: 8, gap: 2 }}>{h.verification.checked.map((x) => <T key={x.label} size={13}>✓ {x.label}{x.note ? ` - ${x.note}` : ''}</T>)}<T size={12} color={c.mute}>Valid until {plainDate(h.verification.expires_at)}.</T></View>
        ) : <Note tone={c.pinkSoft}>You cannot start or sign a mandate until SportArena verifies you. Open Me → Verification → Verified agent and attach your ID and your business or licence evidence. The review states exactly what it checked.</Note>}
        {h.verification.licences?.length ? <View style={{ marginTop: 8, gap: 4 }}>{h.verification.licences.map((l) => <T key={l.id} size={13}>{l.issuing_body} · {l.grade || 'Registration'} · {l.jurisdiction} - {l.standing}{l.valid_to ? ` (until ${plainDate(l.valid_to)})` : ''}</T>)}</View> : null}
        {own ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}><LicenceButton reload={refresh} /><Btn small title="Declared interests & staff" color={c.paper} ink={c.ink} onPress={() => setTab('conflicts')} /></View> : null}
      </Card>
      {h.not_live?.length ? <Note tone={c.pinkSoft}>{h.not_live.length} mandate{h.not_live.length === 1 ? ' is' : 's are'} in force but not live right now ({[...new Set(h.not_live.map((x) => nice(x.reason)))].join(', ')}). You have no access to those athletes' information until that is fixed.</Note> : null}
      {h.expiring_soon?.length ? <Note>{h.expiring_soon.length} mandate{h.expiring_soon.length === 1 ? ' ends' : 's end'} within 30 days. Ask the athlete to renew, or access stops on the end date.</Note> : null}
      <HScroll>{TABS.map(([k, l]) => <Chip key={k} label={`${l}${badge[k] ? ` (${badge[k]})` : ''}`} active={tab === k} onPress={() => { setTab(k); setSel(null); }} />)}</HScroll>
      {tab === 'clients' ? <Clients agentId={agentId} h={h} own={own} go={(id) => { setSel(id); setTab('mandates'); }} refresh={refresh} /> : null}
      {tab === 'mandates' ? <Mandates agentId={agentId} sel={sel} setSel={setSel} refresh={refresh} /> : null}
      {tab === 'opportunities' ? <WithMandate need="opportunity_outreach">{(m) => <Opportunities m={m} refresh={refresh} />}</WithMandate> : null}
      {tab === 'negotiations' ? <WithMandate need="contract_negotiation">{(m) => <Negotiations m={m} />}</WithMandate> : null}
      {tab === 'transfers' ? <Empty emoji="🔁" title="Transfers and loans" sub={`The transfer and loan workflow is not available yet, so nothing can be shared from it and nothing is pending (${h.transfers_shared} shared). When it ships, a transfer shared with you appears here and you can assist only inside the mandate - never approve for a club or governing body.`} /> : null}
      {tab === 'sponsorships' ? <WithMandate need="sponsorship_commercial">{(m) => <Sponsorships m={m} />}</WithMandate> : null}
      {tab === 'commissions' ? <WithMandate any>{(m) => <DealsPanel id={m.id} />}</WithMandate> : null}
      {tab === 'conflicts' ? <><WithMandate any>{(m) => <ConflictsPanel id={m.id} />}</WithMandate>{own ? <Interests refresh={refresh} /> : null}</> : null}
      {tab === 'documents' ? <Documents agentId={agentId} /> : null}
      {tab === 'reports' ? <Reports h={h} agentId={agentId} /> : null}
    </View>
  );
}

function LicenceButton({ reload }) {
  const { toast } = useSession();
  const [open, setOpen] = useState(false);
  const sports = useLoad(() => api.get('/sports'), []);
  const ids = new Map((sports.data ?? []).map((s) => [s.slug, s.id]));
  return (
    <>
      <Btn small title="Declare a licence" color={c.paper} ink={c.ink} onPress={() => setOpen(true)} />
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Declare a licence or registration" submitLabel="Declare" notice="A declaration is not verification. Add the evidence when you apply for verification and the review team checks it; the reference is stored encrypted and only the last four characters are ever shown."
        fields={[{ key: 'issuing_body', label: 'Issued by', type: 'text' }, { key: 'grade', label: 'Grade or type', type: 'text', optional: true }, { key: 'jurisdiction', label: 'Where it applies', type: 'country' }, { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'reference', label: 'Licence or registration number', type: 'text', optional: true }, { key: 'valid_from', toKey: 'valid_to', label: 'Valid', type: 'daterange', optional: true }]}
        onSubmit={async (v) => { await api.post('/agents/me/licences', { issuing_body: v.issuing_body, grade: v.grade || '', jurisdiction: v.jurisdiction, sport_id: v.sport ? ids.get(v.sport) : undefined, reference: v.reference || undefined, valid_from: v.valid_from || undefined, valid_to: v.valid_to || undefined }); setOpen(false); toast('Declared'); reload(); }} />
    </>
  );
}

/** Per-mandate tabs: choose which athlete's mandate you are working in (only mandates that can do the thing). */
function WithMandate({ need, any, children }) {
  const list = useLoad(() => api.get('/representation/mandates', { as: 'agent', limit: 100 }), []);
  const [pick, setPick] = useState(null);
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  const rows = list.data.filter((m) => (any ? ['active', 'revoked', 'expired'].includes(m.status) : m.status === 'active' && m.purposes.includes(need)));
  if (!rows.length) return <Empty emoji="🤝" title="No mandate for this yet" sub={any ? 'Start a mandate with an athlete first.' : 'None of your mandates includes this purpose.'} />;
  const m = rows.find((x) => x.id === pick) ?? rows[0];
  return (
    <View style={{ gap: 12 }}>
      <HScroll>{rows.map((x) => <Chip key={x.id} label={`${x.athlete.display_name}${x.live ? '' : ' (not live)'}`} active={x.id === m.id} onPress={() => setPick(x.id)} />)}</HScroll>
      {children(m)}
    </View>
  );
}

// ------------------------------------------------------------------ clients and mandates
function Clients({ agentId, h, own, go, refresh }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/agent/clients', agentId ? { agent_id: agentId } : undefined), [agentId]);
  const [step, setStep] = useState(null);
  const [athlete, setAthlete] = useState(null);
  const profile = useLoad(() => api.get('/agents/me'), []);
  if (q.loading && !q.data) return <Loading />;
  return (
    <View style={{ gap: 10 }}>
      {q.data?.length ? q.data.map((cl) => (
        <Card key={cl.athlete.id}>
          <T weight="800">{cl.athlete.display_name}</T>
          {cl.mandates.map((m) => <Row key={m.id} title={m.mandate_no} sub={`${m.sports.map((s) => s.name).join(', ')}${m.ends_on ? ` · until ${plainDate(m.ends_on)}` : ''}`} onPress={() => go(m.id)} right={<View style={{ alignItems: 'flex-end', gap: 4 }}><LiveTag m={m} />{m.open_conflicts ? <Tag label={`${m.open_conflicts} conflict`} color={c.sun} /> : null}</View>} />)}
        </Card>
      )) : <Empty emoji="🧑‍🤝‍🧑" title="No clients yet" sub="An athlete finds you in the directory once you are verified and listed, or you propose a mandate to an athlete. Nobody is a client until they sign." />}
      {own ? <Btn small title="Propose a mandate to an athlete" onPress={() => setStep('pick')} style={{ alignSelf: 'flex-start' }} /> : null}
      <FormSheet visible={step === 'pick'} onClose={() => setStep(null)} title="Who is the athlete?" submitLabel="Next" fields={[{ key: 'athlete', label: 'Athlete', type: 'entity', entityKind: 'person', role: 'athlete', noun: 'athlete' }]}
        onSubmit={async (v) => { setAthlete(v.athlete__pick ?? { id: v.athlete }); setStep('terms'); }} />
      {step === 'terms' && athlete ? (
        <TermsSheet visible onClose={() => setStep(null)} title={`A mandate for ${athlete.label ?? 'the athlete'}`} submitLabel="Send for signature" agent={{ licences: profile.data?.profile?.licences, kind: profile.data?.profile?.kind }}
          notice="Nothing is shared until the athlete (and a guardian for a young person) signs the exact terms."
          onSubmit={async (terms) => { const m = await api.post('/representation/mandates', { athlete_id: athlete.id, terms, send: true, client_key: key() }); setStep(null); toast('Sent for signature'); refresh(); go(m.id); }} />
      ) : null}
    </View>
  );
}

function Mandates({ agentId, sel: sel0, setSel, refresh }) {
  const L = useLayout();
  const q = useLoad(() => api.get('/representation/mandates', { as: 'agent', limit: 100 }), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const sel = sel0 ?? (L.width >= 900 ? (q.data.find((m) => m.needs_my_signature) ?? q.data.find((m) => m.live) ?? q.data[0])?.id : null);
  const list = q.data.length ? q.data.map((m) => (
    <Row key={m.id} title={m.athlete.display_name} sub={`${m.mandate_no} · ${m.sports.map((s) => s.name).join(', ') || 'No sports yet'}${m.ends_on ? ` · until ${plainDate(m.ends_on)}` : ''}`} onPress={() => setSel(m.id)}
      right={<View style={{ alignItems: 'flex-end', gap: 4 }}><LiveTag m={m} />{m.needs_my_signature ? <Tag label="Sign" color={c.sun} /> : null}</View>} />
  )) : <Empty emoji="📄" title="No mandates" sub="Propose one from Clients." />;
  return <Split list={list} selected={sel} emptyTitle="Pick a mandate" emptySub="Terms, signatures, what is shared, commission and history open here." detail={<MandateDetail key={sel} id={sel} onBack={() => setSel(null)} onChanged={() => { q.reload(); refresh(); }} />} />;
}

// ------------------------------------------------------------------ opportunities
function Opportunities({ m, refresh }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/representation/mandates/${m.id}/pipeline`, { limit: 100 }), [m.id]);
  const [find, setFind] = useState(false);
  const [draft, setDraft] = useState(null);
  const [talk, setTalk] = useState(null);
  const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); q.reload(); refresh(); } catch (e) { toast(say(e)); } };
  const rows = q.data ?? [];
  return (
    <View style={{ gap: 10 }}>
      {!m.live ? <Note tone={c.pinkSoft}>This mandate is not live right now, so you cannot add or change anything for {m.athlete.display_name}.</Note> : null}
      {rows.length ? rows.map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 180 }}><T weight="800">{p.post_title}</T><T size={12} color={c.mute}>{p.sport_emoji} {p.sport_name} · {nice(p.post_kind)}{p.closes_at ? ` · closes ${plainDate(p.closes_at)}` : ''}</T></View>
            <Tag label={STAGE[p.stage] ?? p.stage} color={p.stage === 'submitted' ? c.mint : p.stage === 'awaiting_athlete' ? c.sun : c.violetSoft} />
            <Tag label={p.athlete_response === 'pending' ? 'Not answered' : nice(p.athlete_response)} color={p.athlete_response === 'interested' ? c.mint : c.violetSoft} />
          </View>
          {p.note ? <T size={13} style={{ marginTop: 6 }}>Your note: {p.note}</T> : null}
          {p.draft_message ? <T size={13} style={{ marginTop: 6 }}>Draft: "{p.draft_message}" {p.draft_sections?.length ? `· shares ${p.draft_sections.join(', ')}` : ''}</T> : null}
          {m.live && !['submitted', 'dropped', 'outcome'].includes(p.stage) ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Btn small title="Draft the application" color={c.paper} ink={c.ink} onPress={() => setDraft(p)} />
              {p.draft_message || p.draft_sections?.length ? <Btn small title="Ask the athlete to approve sending" onPress={() => act(() => api.post(`/representation/pipeline/${p.id}/approval`, { kind: 'submit_application' }), 'Asked')} /> : null}
              <Btn small title="Ask to express interest" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/representation/pipeline/${p.id}/approval`, { kind: 'express_interest' }), 'Asked')} />
              <Btn small title="Log a conversation" color={c.paper} ink={c.ink} onPress={() => setTalk(p)} />
              <Btn small title="Drop" color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/representation/pipeline/${p.id}`, { row_version: p.row_version, stage: 'dropped' }))} />
            </View>) : null}
        </Card>
      )) : <Empty emoji="🎯" title="Nothing shared yet" sub="Share an open opportunity with the athlete. They say whether they are interested; nothing is sent to the poster without their approval." />}
      {m.live ? <Btn small title="Share an opportunity" onPress={() => setFind(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      <PostFinder visible={find} onClose={() => setFind(false)} onPick={(post) => act(async () => { await api.post(`/representation/mandates/${m.id}/pipeline`, { post_id: post.id }); setFind(false); }, 'Shared with the athlete')} />
      <FormSheet visible={!!draft} onClose={() => setDraft(null)} title="Draft the application" submitLabel="Save draft" notice="This is only a draft. The athlete reads it and decides; nothing is sent until they approve."
        fields={[{ key: 'draft_message', label: 'Message to the poster', type: 'multiline', optional: true }, { key: 'draft_sections', label: 'Passport sections to share', type: 'multi', optional: true, options: SECTIONS }]}
        initial={{ draft_message: draft?.draft_message ?? '', draft_sections: draft?.draft_sections ?? [] }}
        onSubmit={async (v) => { await api.patch(`/representation/pipeline/${draft.id}`, { row_version: draft.row_version, draft_message: v.draft_message ?? '', draft_sections: v.draft_sections ?? [] }); setDraft(null); toast('Draft saved'); q.reload(); }} />
      <FormSheet visible={!!talk} onClose={() => setTalk(null)} title="Log a conversation" submitLabel="Log it" notice="The athlete can read this log. The summary is stored encrypted."
        fields={[{ key: 'channel', label: 'How', type: 'chips', options: ['call', 'email', 'meeting', 'message', 'other'].map((x) => ({ value: x, label: sentence(x) })) }, { key: 'counterparty', label: 'Who', type: 'text' }, { key: 'happened_on', label: 'When', type: 'date' }, { key: 'summary', label: 'What was said', type: 'multiline' }]}
        initial={{ channel: 'call', happened_on: new Date().toISOString().slice(0, 10) }}
        onSubmit={async (v) => { await api.post(`/representation/mandates/${m.id}/contacts`, { pipeline_id: talk.id, channel: v.channel, counterparty: v.counterparty, summary: v.summary, happened_on: v.happened_on }); setTalk(null); toast('Logged'); }} />
    </View>
  );
}

function PostFinder({ visible, onClose, onPick }) {
  const [qText, setQText] = useState('');
  const [sport, setSport] = useState(null);
  const posts = useLoad(() => (visible ? api.get('/billboard', { q: qText.trim() || undefined, sport: sport || undefined, limit: 20 }) : Promise.resolve([])), [visible, qText, sport]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Pick an open opportunity">
      <Field value={qText} onChangeText={setQText} placeholder="Search opportunities" />
      <SportPicker label="Sport" optional value={sport} onChange={setSport} />
      {posts.loading ? <Loading /> : posts.data?.length ? posts.data.map((p) => <Row key={p.id} title={p.title} sub={`${p.sport ?? ''} · ${nice(p.kind)}${p.city ? ` · ${p.city}` : ''}`} onPress={() => onPick(p)} right={<T size={13} weight="700" color={c.pink}>Share ›</T>} />) : <Empty emoji="🔎" title="Nothing open matches" />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ negotiations (#333 contracts the athlete shared)
function Negotiations({ m }) {
  const q = useLoad(() => api.get(`/representation/mandates/${m.id}/contracts`), [m.id]);
  const [sel, setSel] = useState(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const list = q.data.length ? q.data.map((k) => <Row key={k.id} title={k.title} sub={`${k.contract_no} · ${nice(k.status)} · ${k.level === 'participate' ? 'may comment' : 'view only'}`} onPress={() => setSel(k.id)} right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{k.pending_version ? <Tag label={`v${k.pending_version} to sign`} color={c.sun} /> : null}{k.review_state ? <Tag label={nice(k.review_state)} color={k.review_state === 'reviewed' ? c.mint : c.violetSoft} /> : null}</View>} />)
    : <Empty emoji="📑" title="No contract shared" sub={`${m.athlete.display_name} has not shared any player contract with you. Contract discussions you take part in appear here.`} />;
  return <Split list={list} selected={sel} emptyTitle="Pick a contract" emptySub="Its versions, who signed, your review and notes open here." detail={<ContractView mid={m.id} cid={sel} onBack={() => setSel(null)} onChanged={q.reload} />} />;
}

function ContractView({ mid, cid, onBack, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/representation/mandates/${mid}/contracts/${cid}`), [mid, cid]);
  const [note, setNote] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const k = q.data;
  const cur = k.versions.find((v) => v.status === 'in_force');
  const setReview = async (version_no, state) => { try { await api.post(`/representation/mandates/${mid}/contracts/${cid}/review`, { version_no, state }); q.reload(); onChanged?.(); } catch (e) { toast(say(e)); } };
  return (
    <View style={{ gap: 12 }}>
      <Btn small title="‹ All" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <Card><T weight="800" size={17}>{k.title}</T><T size={13} color={c.mute}>{k.contract_no} · {k.payer.name} · {nice(k.status)}</T></Card>
      <Note tone={c.violetSoft}>{k.reminder}</Note>
      {k.versions.map((v) => (
        <Card key={v.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" style={{ flex: 1 }}>Version {v.version} · {nice(v.status)}</T>{v.status === 'proposed' ? <Tag label={`waiting: ${(v.required_parties ?? []).filter((p) => !v.signatures.some((s) => s.party === p && s.decision === 'signed')).map(nice).join(', ')}`} color={c.sun} /> : null}</View>
          <T size={13} color={c.mute}>{plainDate(v.starts_on)} to {plainDate(v.ends_on)}</T>
          {v.components.map((x) => <T key={x.key} size={13}>• {x.label}: {cash(x.amount_cents, v.currency)}{x.due_on ? ` due ${plainDate(x.due_on)}` : ''}</T>)}
          {v.changes?.length && v.version > 1 ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Changed: {v.changes.map((x) => x.label).join(', ')}</T> : null}
          <T size={12} color={c.mute}>Signed by: {v.signatures.filter((s) => s.decision === 'signed').map((s) => nice(s.party)).join(', ') || 'nobody yet'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {[['to_review', 'To review'], ['reviewing', 'Reviewing'], ['reviewed', 'Reviewed'], ['changes_requested', 'Changes requested']].map(([s, l]) => <Chip key={s} label={l} active={k.reviews.find((r) => r.version_no === v.version)?.state === s} onPress={() => setReview(v.version, s)} />)}
          </View>
        </Card>
      ))}
      <Section title="Notes" color={c.violet} action={k.level === 'participate' ? 'Add a note' : undefined} onAction={() => setNote(true)}>
        {k.level !== 'participate' ? <T size={13} color={c.mute}>You can read this contract. The athlete has not allowed you to comment on it.</T> : null}
        {k.notes.length ? k.notes.map((n) => <Card key={n.id}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={n.visibility === 'agent_only' ? 'Only you' : n.visibility === 'athlete' ? 'You and the athlete' : 'All parties incl. the club'} color={c.violetSoft} />{n.kind === 'suggestion' ? <Tag label="Suggestion" color={c.sun} /> : null}</View><T style={{ marginTop: 6 }}>{n.body}</T>{n.suggestion?.proposal ? <T size={13} color={c.mute}>{n.suggestion.topic}: {n.suggestion.proposal}</T> : null}<T size={11} color={c.mute}>{n.author} · {when(n.created_at)}</T></Card>) : <T size={13} color={c.mute}>No notes yet.</T>}
      </Section>
      <FormSheet visible={note} onClose={() => setNote(false)} title="Add a note" submitLabel="Add note" notice="A suggestion is words and numbers; it never changes the contract. A change goes through a normal amendment that the athlete signs."
        fields={[{ key: 'kind', label: 'This is', type: 'choice', options: [{ value: 'note', label: 'A note' }, { value: 'suggestion', label: 'A suggestion' }] },
          { key: 'visibility', label: 'Who can read it', type: 'chips', options: [{ value: 'agent_only', label: 'Only me' }, { value: 'athlete', label: 'Me and the athlete' }, { value: 'all_parties', label: 'All parties incl. the club' }] },
          { key: 'body', label: 'Your note', type: 'multiline' }, { key: 'topic', label: 'Topic', type: 'text', show: (f) => f.kind === 'suggestion' }, { key: 'proposal', label: 'What you suggest', type: 'text', show: (f) => f.kind === 'suggestion' }]}
        initial={{ kind: 'note', visibility: 'athlete' }}
        onSubmit={async (v) => { await api.post(`/representation/mandates/${mid}/contracts/${cid}/notes`, { kind: v.kind, visibility: v.visibility, body: v.body, suggestion: v.kind === 'suggestion' ? { topic: v.topic, proposal: v.proposal } : undefined }); setNote(false); q.reload(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ sponsorships
function Sponsorships({ m }) {
  const q = useLoad(() => api.get(`/representation/mandates/${m.id}/sponsorships`), [m.id]);
  const [sel, setSel] = useState(null);
  const one = useLoad(() => (sel ? api.get(`/representation/mandates/${m.id}/sponsorships/${sel}`) : Promise.resolve(null)), [sel, m.id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data.length) return <Empty emoji="🤝" title="No sponsorship shared" sub={`${m.athlete.display_name} has not shared a sponsorship agreement with you.`} />;
  return (
    <View style={{ gap: 10 }}>
      {q.data.map((s) => <Row key={s.id} title={s.sponsor_name} sub={`${s.agreement_ref ?? 'Agreement'} · ${nice(s.status)}${s.ends_on ? ` · until ${plainDate(s.ends_on)}` : ''}`} onPress={() => setSel(s.id)} right={<StatusTag status={s.status === 'active' ? 'active' : 'proposed'} />} />)}
      {sel && one.data ? (
        <Card>
          <T weight="800">{one.data.sponsor_name}</T>
          {one.data.lines.map((l, i) => <T key={i} size={13}>• {l.label}: {l.total_cents ? cash(l.total_cents, l.currency) : nice(l.kind)} ({nice(l.cadence)})</T>)}
          <T size={13} style={{ marginTop: 6 }}>Money confirmed so far: <T weight="800">{cash(one.data.confirmed_cents, one.data.currency)}</T></T>
          <T size={12} color={c.mute}>{one.data.reminder}</T>
        </Card>) : null}
    </View>
  );
}

// ------------------------------------------------------------------ interests, documents, reports
function Interests({ refresh }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/agents/me'), []);
  const [open, setOpen] = useState(false);
  const p = q.data?.profile;
  if (!p) return null;
  return (
    <Section title="My declared interests" color={c.violet} action="Declare one" onAction={() => setOpen(true)}>
      <T size={13} color={c.mute}>A club, sponsor, supplier or related party you have a stake in. Every deal you join is compared with these; a match opens a conflict the athlete decides.</T>
      {p.interests.length ? p.interests.map((i) => <Row key={i.id} title={i.label} sub={nice(i.kind)} right={<Btn small title="End" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/agents/me/interests/${i.id}`); q.reload(); refresh(); } catch (e) { toast(say(e)); } }} />} />) : null}
      {p.kind === 'agency' ? <><T weight="800" size={13} style={{ marginTop: 8 }}>Delegated staff</T>{p.staff.length ? p.staff.map((s) => <Row key={s.id} title={s.display_name} sub={`@${s.handle} · ${s.permissions.map(nice).join(', ')}`} right={<Btn small title="Remove" color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/agents/me/staff/${s.id}`); q.reload(); } catch (e) { toast(say(e)); } }} />} />) : <T size={13} color={c.mute}>None.</T>}</> : null}
      <FormSheet visible={open} onClose={() => setOpen(false)} title="Declare an interest" submitLabel="Declare"
        fields={[{ key: 'kind', label: 'What kind', type: 'chips', options: ['club', 'sponsor', 'supplier', 'related_party', 'other'].map((x) => ({ value: x, label: sentence(x) })) },
          { key: 'team', label: 'Team (if it is a club)', type: 'entity', entityKind: 'team', noun: 'team', optional: true, show: (f) => f.kind === 'club' }, { key: 'label', label: 'Describe it', type: 'text' }]}
        initial={{ kind: 'club' }}
        onSubmit={async (v) => { await api.post('/agents/me/interests', { kind: v.kind, label: v.label, target_type: v.team ? 'team' : undefined, target_id: v.team || undefined }); setOpen(false); toast('Declared'); q.reload(); }} />
    </Section>
  );
}

function Documents({ agentId }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/agent/documents', agentId ? { agent_id: agentId } : undefined), [agentId]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const open = async (x) => { try { const doc = await api.get(`/representation/mandates/${x.mandate_id}/document`, { version: x.version }); await saveFile(doc.filename, doc.text, 'text/plain'); } catch (e) { toast(say(e)); } };
  const stm = async (x) => { try { const s = await api.get(`/representation/statements/${x.id}`, { format: 'csv' }); await saveFile(s.filename, s.csv); } catch (e) { toast(say(e)); } };
  return (
    <View style={{ gap: 10 }}>
      <Section title="Signed mandates" color={c.violet}>{d.mandates.length ? d.mandates.map((x) => <Row key={`${x.mandate_id}-${x.version}`} title={`${x.mandate_no} · version ${x.version}`} sub={`${nice(x.kind)} · ${nice(x.status)} · ${plainDate(x.decided_at)}`} onPress={() => open(x)} right={<T size={13} weight="700" color={c.pink}>Open ›</T>} />) : <Empty emoji="📄" title="No signed mandates yet" />}</Section>
      <Section title="Commission statements" color={c.violet}>{d.statements.length ? d.statements.map((x) => <Row key={x.id} title={x.statement_no} sub={`${x.mandate_no} · ${cash(x.amount_cents, x.currency)} · ${x.status} · ${plainDate(x.issued_at)}`} onPress={() => stm(x)} right={<T size={13} weight="700" color={c.pink}>CSV ›</T>} />) : <Empty emoji="🧾" title="No statements yet" />}</Section>
    </View>
  );
}

function Reports({ h, agentId }) {
  const { toast } = useSession();
  const stat = (label, v) => <Card key={label} pad={12} style={{ flexGrow: 1, minWidth: 140 }}><T size={11} weight="700" color={c.mute}>{label.toUpperCase()}</T><T weight="800" size={22}>{v}</T></Card>;
  const exp = async () => { try { const r = await api.get('/agent/report', { ...(agentId ? { agent_id: agentId } : {}), format: 'csv' }); await saveFile(r.filename, r.csv); } catch (e) { toast(say(e)); } };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {stat('Clients', h.clients)}{stat('Live mandates', h.live)}{stat('Waiting for athletes', h.approvals_waiting)}{stat('Contracts to review', h.contracts_to_review)}{stat('Open conflicts', h.conflicts_open)}{stat('Deals with commission', h.deals)}
      </View>
      {Object.entries(h.commission).map(([cur, l]) => <Card key={cur}><T weight="800" style={{ marginBottom: 8 }}>Commission · {cur}</T><Ladder ladder={l} currency={cur} /></Card>)}
      <Card><T weight="800">Pipeline</T><T size={13} color={c.mute}>{Object.entries(h.pipeline).map(([k, n]) => `${STAGE[k] ?? k}: ${n}`).join(' · ') || 'Nothing yet'}</T></Card>
      <Btn small title="Download the report (CSV)" color={c.paper} ink={c.ink} onPress={exp} style={{ alignSelf: 'flex-start' }} />
      <T size={12} color={c.mute}>The report covers your own business records only - mandates, deals and statements. Downloads are audit-logged.</T>
    </View>
  );
}
