// Billboard > Tender zone: discovery with filters, saved tenders and alerts, the notice a supplier reads (stage strip, countdown, eligibility,
// lots, requirements, documents, clarifications, addenda), participation, and the supplier entities people bid as. Everything here calls the
// API; the server decides who may see or do what, so the UI only shows what it is given.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Empty, ErrorBox, Field, H1, Loading, Screen, Seg, Sheet, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { Head } from './coaching';
import { c } from '../theme';
import { explain } from '../access';
import { DateField, DateRangeField } from '../pickers';
import { SportSelect } from '../sportpicker';
import { Chips, Checks, Countdown, DataTable, KV, Notice, Panel, Split, Stages, StageTag, Status, Tabs, amount, day, nice, openDocument, openStored, when } from '../tender-ui';

export const CATEGORIES = ['Ground maintenance', 'Pitch maintenance', 'Pool maintenance', 'Crew and ball crew', 'Electrical', 'Wi-Fi and connectivity', 'Travel and transport', 'Accommodation', 'Catering', 'Security', 'Cleaning', 'Equipment rental', 'Other'];

const q2 = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false));

function TenderCard({ t, onOpen, onSave }) {
  const closes = t.closes_at ? new Date(t.closes_at) : null;
  const days = closes ? Math.ceil((closes - Date.now()) / 864e5) : null;
  return (
    <Card onPress={onOpen} accessibilityLabel={`${t.title}, ${t.stage}`}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <StageTag stage={days !== null && days <= 2 && t.stage === 'open' ? 'closing soon' : t.stage} />
          <Status tone="info" label={t.kind.toUpperCase()} />
          <Status tone="neutral" label={t.participation === 'open' ? 'Public notice' : t.participation === 'approved_suppliers' ? 'Restricted' : 'Invite only'} />
          <T size={12} color={c.mute} style={{ marginLeft: 'auto' }}>{t.ref}</T>
        </View>
        <T weight="700" size={16}>{t.title}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <T size={13} color={c.mute}>{t.issuer.name}</T>{t.issuer.verified ? <Status tone="ok" label="Verified issuer" /> : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {[['Category', t.category], ['Sites', t.sites.length ? t.sites.join(', ') : t.location], ['Service', t.service_start ? `${day(t.service_start)} to ${day(t.service_end)}` : null], ['Lots', t.lots], ['Budget', t.budget ? amount(t.budget.amount_minor, t.budget.currency) : null]].filter(([, v]) => v).map(([k, v]) => <T key={k} size={12} color={c.mute}>{k} <T size={12} weight="700">{String(v)}</T></T>)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <T size={12} weight="700" style={{ flex: 1, minWidth: 200 }}>Closes {when(t.closes_at, t.timezone)}</T>
          <Btn small title={t.saved ? 'Saved ✓' : 'Save'} color={t.saved ? c.lime : c.violet} onPress={onSave} accessibilityLabel={t.saved ? 'Remove from saved' : 'Save tender'} />
          <Btn small title="View notice" onPress={onOpen} />
        </View>
      </View>
    </Card>
  );
}

function Filters({ f, set, reset }) {
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}><T weight="700" size={12} color={c.mute}>CATEGORY</T><Chips options={CATEGORIES.slice(0, 9)} value={f.category} onChange={(v) => set({ category: f.category === v ? null : v })} /></View>
      <SportSelect label="Sport" optional allLabel="Any sport" value={f.sport} onChange={(v) => set({ sport: v })} />
      <Field label="Location" value={f.location ?? ''} onChangeText={(v) => set({ location: v })} placeholder="City, venue or region" />
      <DateRangeField label="Service period" optional from={f.service_from} to={f.service_to} onChange={({ from, to }) => set({ service_from: from, service_to: to })} />
      <View style={{ gap: 6 }}><T weight="700" size={12} color={c.mute}>PROCUREMENT TYPE</T><Chips options={[{ value: 'rfp', label: 'RFP' }, { value: 'rfq', label: 'RFQ' }, { value: 'rfi', label: 'RFI' }]} value={f.kind} onChange={(v) => set({ kind: f.kind === v ? null : v })} /></View>
      <View style={{ gap: 6 }}><T weight="700" size={12} color={c.mute}>SHOW</T><Chips options={[{ value: 'saved', label: 'Saved' }, { value: 'mine', label: 'I take part' }]} multi value={[f.saved && 'saved', f.mine && 'mine'].filter(Boolean)} onChange={(v) => set({ saved: v.includes('saved'), mine: v.includes('mine') })} /></View>
      <Btn small title="Clear filters" color={c.violet} onPress={reset} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}

const STAGES = [{ value: 'open', label: 'Open' }, { value: 'closing_soon', label: 'Closing soon' }, { value: 'closed', label: 'Closed' }, { value: 'awarded', label: 'Awarded' }];
const EMPTY = { stage: 'open', sort: 'closes_at' };

/** The Tender zone inside the Billboard. `embedded` drops the screen chrome so the Billboard can host it. */
export function TenderZone({ embedded }) {
  const { toast } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const [f, setF] = useState(EMPTY);
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(null);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const list = useLoad(() => api.get('/tenders', q2({ ...f, q: q.trim() || undefined, limit: 50 })), [JSON.stringify(f), q]);
  const mine = useLoad(async () => {
    const [approvals, rfps, props, alerts] = await Promise.all([api.get('/approvals', { limit: 20 }).catch(() => []), api.get('/rfps', { limit: 50 }).catch(() => []), api.get('/proposals', { limit: 50 }).catch(() => []), api.get('/tender-alerts').catch(() => [])]);
    return { approvals, drafts: rfps.filter((r) => r.stage === 'draft').length, proposals: props.filter((p) => p.status === 'draft' && p.tender_status === 'published'), alerts };
  }, []);
  const save = async (t) => { try { await api.post(`/tenders/${t.id}/save`, { saved: !t.saved }); list.reload(); } catch (e) { toast(explain(e)); } };
  const wide = L.width >= 1000;
  const body = (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 220 }}><Field value={q} onChangeText={setQ} placeholder="Search title, reference or issuer" accessibilityLabel="Search tenders" /></View>
        {!wide ? <Btn small title={`Filters${Object.keys(q2({ ...f, stage: null, sort: null })).length ? ` · ${Object.keys(q2({ ...f, stage: null, sort: null })).length}` : ''}`} color={c.violet} onPress={() => setSheet('filters')} accessibilityLabel="Open filters" /> : null}
      </View>
      <View style={{ marginTop: 10 }}><Seg options={STAGES} value={f.stage} onChange={(v) => set({ stage: v })} /></View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}><Chips options={[{ value: 'closes_at', label: 'Closes first' }, { value: 'published', label: 'Newest' }, { value: 'title', label: 'A to Z' }]} value={f.sort} onChange={(v) => set({ sort: v })} /></View>
    </>
  );
  const results = list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !(list.data ?? []).length ? (
    <Empty emoji="📋" title="No tenders match" sub={Object.keys(q2({ ...f, stage: null, sort: null })).length || q ? 'Try clearing a filter.' : 'Published tenders you are allowed to see appear here. Organisations and event organisers can publish one from Create RFP.'} />
  ) : <View style={{ gap: 12 }}>{list.data.map((t) => <TenderCard key={t.id} t={t} onOpen={() => push('TenderNotice', { id: t.id })} onSave={() => save(t)} />)}</View>;
  const side = (
    <View style={{ gap: 14 }}>
      <Panel title="Your sourcing">
        <Checks items={[
          { state: mine.data?.approvals.length ? 'warn' : 'ok', title: `${mine.data?.approvals.length ?? 0} approval${mine.data?.approvals.length === 1 ? '' : 's'} waiting`, action: mine.data?.approvals.length ? 'Review' : null, onAction: () => push('TenderHome') },
          { state: 'info', title: `${mine.data?.drafts ?? 0} draft RFP${mine.data?.drafts === 1 ? '' : 's'}`, action: 'My RFPs', onAction: () => push('TenderHome') },
          { state: mine.data?.proposals.length ? 'warn' : 'ok', title: `${mine.data?.proposals.length ?? 0} proposal${mine.data?.proposals.length === 1 ? '' : 's'} in progress`, detail: mine.data?.proposals[0] ? `Next closes ${when(mine.data.proposals[0].closes_at, mine.data.proposals[0].timezone)}` : 'Receipts show once submitted', action: 'Proposals', onAction: () => push('TenderProposals') },
        ]} />
      </Panel>
      <Panel title="Alerts" right={<Btn small title="+ Add" color={c.violet} onPress={() => setSheet('alert')} />}>
        {(mine.data?.alerts ?? []).length ? <View style={{ gap: 6 }}>{mine.data.alerts.map((a) => <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={13} style={{ flex: 1 }}>{[a.category, a.sport_slug, a.region].filter(Boolean).join(' · ')}</T><Btn small title="Stop" color={c.violet} onPress={async () => { try { await api.post(`/tender-alerts/${a.id}/remove`); mine.reload(); } catch (e) { toast(explain(e)); } }} /></View>)}</View> : <T size={13} color={c.mute}>Get told when a new public tender matches a category, sport or region.</T>}
      </Panel>
      <Panel title="Take part as a supplier">
        <T size={13} color={c.mute}>Individuals, sole traders and companies bid as a supplier entity. Several people can work on one proposal.</T>
        <Btn small title="My supplier entities" color={c.violet} onPress={() => push('SupplierEntities')} />
      </Panel>
    </View>
  );
  const main = <View style={{ gap: 12 }}>{body}{results}</View>;
  const content = wide ? (
    <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
      <View style={{ width: 250, gap: 14 }}><Panel title="Filters"><Filters f={f} set={set} reset={() => setF(EMPTY)} /></Panel></View>
      <View style={{ flex: 1, minWidth: 0 }}>{main}</View>
      <View style={{ width: 290 }}>{side}</View>
    </View>
  ) : <Split main={main} side={side} sideWidth={300} />;
  const sheets = (
    <>
      <Sheet visible={sheet === 'filters'} onClose={() => setSheet(null)} title="Filters" footer={<><Btn title="Show results" onPress={() => setSheet(null)} style={{ flex: 1 }} /></>}><Filters f={f} set={set} reset={() => setF(EMPTY)} /></Sheet>
      <FormSheet visible={sheet === 'alert'} onClose={() => setSheet(null)} title="New tender alert" submitLabel="Create alert"
        fields={[{ key: 'category', label: 'Category', type: 'chips', options: CATEGORIES, optional: true }, { key: 'sport', label: 'Sport', type: 'sport', optional: true }, { key: 'region', label: 'Region', type: 'region', optional: true }]}
        onSubmit={async (v) => { await api.post('/tender-alerts', q2(v)); mine.reload(); return 'Alert created'; }} />
    </>
  );
  if (embedded) return <View style={{ marginTop: 14, gap: 14 }}>{content}{sheets}</View>;
  return (
    <Screen wide>
      <Head eyebrow="BILLBOARD · TENDER ZONE" title="Tenders" sub="Sourcing for sports services and goods: discover notices, check you qualify, and bid."
        right={<View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title="My RFPs" color={c.violet} onPress={() => push('TenderHome')} /><Btn small title="Create RFP" onPress={() => push('TenderBuilder')} /></View>} />
      <View style={{ marginTop: 14 }}>{content}</View>
      {sheets}
    </Screen>
  );
}

/** The Tender zone as its own page (links, notifications and the event console open it here; the Billboard hosts the same component). */
export const TenderZonePage = () => <TenderZone />;

// ------------------------------------------------------------------ the notice
function Terms({ visible, onClose, onAccept, t }) {
  const [nda, setNda] = useState(false), [ok, setOk] = useState(false);
  return (
    <Sheet visible={visible} onClose={onClose} title="Terms to take part" footer={<Btn title="Accept and continue" disabled={!ok} onPress={() => onAccept(nda)} style={{ flex: 1 }} />}>
      <T size={14}>By taking part in tender {t.card.ref} your supplier entity agrees to the tender rules: proposals are binding offers for the stated validity, prices are submitted in the commercial envelope only, the deadline is decided by the server clock, and you will not discuss prices with other suppliers.</T>
      <Chips multi options={[{ value: 'ok', label: 'I am authorised to accept these terms' }, { value: 'nda', label: 'I also accept the confidentiality terms (NDA)' }]} value={[ok && 'ok', nda && 'nda'].filter(Boolean)} onChange={(v) => { setOk(v.includes('ok')); setNda(v.includes('nda')); }} />
    </Sheet>
  );
}

export function TenderNotice({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [tab, setTab] = useState('overview');
  const [sheet, setSheet] = useState(null);
  const [entityId, setEntityId] = useState(null);
  const n = useLoad(() => api.get(`/tenders/${id}`), [id]);
  const ents = useLoad(() => api.get('/supplier-entities', { limit: 50 }), []);
  const entity = entityId ?? ents.data?.[0]?.id ?? null;
  const elig = useLoad(() => (entity && n.data && !n.data.is_buyer ? api.get(`/tenders/${id}/eligibility`, { entity_id: entity }).catch(() => null) : Promise.resolve(null)), [id, entity, !!n.data]);
  const qa = useLoad(() => (n.data && !n.data.restricted_view ? api.get(`/tenders/${id}/questions`, { limit: 100 }) : Promise.resolve([])), [id, !!n.data]);
  const mineProps = useLoad(() => (entity ? api.get('/proposals', { entity_id: entity, limit: 50 }) : Promise.resolve([])), [entity]);
  if (n.error) return <Screen><ErrorBox error={n.error} onRetry={n.reload} /></Screen>;
  if (n.loading && !n.data) return <Screen><Loading /></Screen>;
  const d = n.data, card = d.card, part = d.my_participation, notice = d.notice;
  const act = async (action, extra = {}) => { try { await api.post(`/tenders/${id}/participation`, { entity_id: entity, action, ...extra }); toast(action === 'accept_terms' ? 'Terms accepted' : 'Done'); n.reload(); } catch (e) { toast(explain(e)); } };
  const proposal = (mineProps.data ?? []).find((p) => p.tender_id === id && p.round === 1 && p.alt_key === 'base');
  const stageSteps = (() => {
    const order = ['open', 'closed', 'evaluation', 'award', 'awarded'];
    const idx = Math.max(0, order.indexOf(d.stage === 'submission' ? 'open' : d.stage));
    const mk = (label, i, sub) => ({ label, sub, state: i < idx ? 'done' : i === idx ? 'on' : 'next' });
    return [{ label: 'Published', sub: card.published_at ? day(card.published_at) : null, state: 'done' }, { label: 'Clarifications', sub: notice ? `until ${day(notice.schedule.clarification_deadline?.utc)}` : null, state: idx > 0 || (notice?.schedule.clarification_deadline && new Date(notice.schedule.clarification_deadline.utc) < new Date()) ? 'done' : 'on' }, { label: 'Submission', sub: `closes ${day(card.closes_at)}`, state: idx > 0 ? 'done' : 'on' }, mk('Opening', 1), mk('Evaluation', 2), mk('Award', 3)];
  })();
  const credItems = (elig.data?.checks ?? []).map((x) => ({ key: x.kind, state: x.state === 'ok' ? 'ok' : x.state === 'missing' || x.state === 'expired' ? 'bad' : 'warn', title: x.title, detail: x.detail }));
  const canBid = part && ['interested', 'invited', 'approved'].includes(part.status) && part.terms_accepted_at;
  const actions = d.is_buyer ? (
    <Panel title="Buying team"><Btn title="Open tender console" onPress={() => push('TenderConsole', { id })} /></Panel>
  ) : (
    <Panel title="Take part">
      {!ents.data?.length ? <><Notice tone="info">Register the supplier entity you bid as (individual, sole trader or company).</Notice><Btn title="Register supplier entity" onPress={() => push('SupplierEntities')} /></> : (
        <>
          {ents.data.length > 1 ? <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute}>BIDDING AS</T><Chips options={ents.data.map((e) => ({ value: e.id, label: e.legal_name }))} value={entity} onChange={setEntityId} /></View> : <T size={13} color={c.mute}>Acting as <T size={13} weight="700">{ents.data[0].legal_name}</T></T>}
          {part ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Status tone={part.status === 'declined' ? 'bad' : 'ok'} label={nice(part.status)} />{part.terms_accepted_at ? <Status tone="ok" label="Terms accepted" /> : null}{part.nda_accepted_at ? <Status tone="ok" label="NDA accepted" /> : null}</View> : null}
          {!part ? (card.participation === 'open' ? <Btn title="Register interest" onPress={() => act('interest')} /> : card.participation === 'approved_suppliers' ? <Btn title="Request access" onPress={() => act('request')} /> : <Notice tone="info">This tender is by invitation only.</Notice>) : null}
          {part?.status === 'requested' ? <Notice tone="info">Your request is with the buyer. You will be told when it is decided.</Notice> : null}
          {part && !part.terms_accepted_at && part.status !== 'requested' && part.status !== 'declined' ? <Btn title="Accept terms and NDA" onPress={() => setSheet('terms')} /> : null}
          {canBid ? <Btn title={proposal ? 'Continue proposal' : 'Start proposal'} onPress={() => (proposal ? push('TenderProposal', { id: proposal.id }) : setSheet('start'))} /> : null}
          {part && !['declined', 'withdrawn', 'requested'].includes(part.status) ? <Btn small title="Ask a question" color={c.violet} onPress={() => setSheet('ask')} /> : null}
          {part && ['invited', 'interested', 'approved'].includes(part.status) ? <Btn small title="Decline to bid" color={c.violet} onPress={() => setSheet('decline')} /> : null}
          {d.unacknowledged_addenda?.length ? <Notice>Addendum {d.unacknowledged_addenda.join(', ')} needs your acknowledgement before you can submit.</Notice> : null}
        </>
      )}
    </Panel>
  );
  const tabs = d.restricted_view ? [{ value: 'overview', label: 'Overview' }] : [{ value: 'overview', label: 'Overview' }, { value: 'lots', label: `Lots (${notice.lots.length})` }, { value: 'requirements', label: 'Requirements' }, { value: 'documents', label: 'Documents' }, { value: 'qa', label: 'Q&A' }, { value: 'addenda', label: `Addenda (${d.addenda.length})` }];
  return (
    <Screen wide>
      <Head eyebrow={`${card.ref} · ${card.kind.toUpperCase()}`} title={card.title} sub={`${card.issuer.name}${card.issuer.verified ? ' · verified issuer' : ''}`} right={<View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><StageTag stage={d.stage} /><Btn small title={d.saved ? 'Saved ✓' : 'Save'} color={d.saved ? c.lime : c.violet} onPress={async () => { await api.post(`/tenders/${id}/save`, { saved: !d.saved }).catch((e) => toast(explain(e))); n.reload(); }} /><Btn small title="Notice PDF" color={c.violet} onPress={() => openDocument('notice', id, {}, card.ref).catch((e) => toast(explain(e)))} /></View>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <View style={{ marginTop: 14 }}>
        <Split main={<>
          {tab === 'overview' ? (
            <>
              <Card><View style={{ gap: 12 }}><Stages steps={stageSteps} />{card.closes_at && ['open', 'submission'].includes(d.stage) ? <View style={{ gap: 8 }}><Countdown to={card.closes_at} /><T size={12} color={c.mute}>The countdown is a guide. The server clock at the moment your proposal is received decides, and the tender is closed at the exact deadline: {when(card.closes_at, card.timezone)}.</T></View> : null}</View></Card>
              {d.restricted_view ? <Notice tone="info">This tender is restricted. Request access to see the full notice, lots and documents.</Notice> : (
                <>
                  <Panel title="Scope">{notice.objective ? <T size={14}>{notice.objective}</T> : null}<T size={14}>{notice.scope}</T>{notice.inclusions ? <T size={13} color={c.mute}>Included: {notice.inclusions}</T> : null}{notice.exclusions ? <T size={13} color={c.mute}>Not included: {notice.exclusions}</T> : null}</Panel>
                  <Panel title="Key facts"><KV items={[['Contract', nice(notice.contract_type)], ['Envelopes', notice.envelope_mode === 'sealed_dual' ? 'Technical and commercial sealed' : notice.envelope_mode === 'sealed_single' ? 'One sealed envelope' : 'Open evaluation'], ['Currency', `${notice.currency}, costs compared ${notice.cost_basis} of tax`], ['Service period', card.service_start ? `${day(card.service_start)} to ${day(card.service_end)}` : null], ['Preparation', card.prep_start ? day(card.prep_start) : null], ['Teardown', card.teardown_end ? day(card.teardown_end) : null], ['Clarifications until', notice.schedule.clarification_deadline ? when(notice.schedule.clarification_deadline.utc, card.timezone) : null], ['Site visit', notice.schedule.site_visit_at ? `${when(notice.schedule.site_visit_at.utc, card.timezone)}${notice.site_visit_mandatory ? ' (mandatory)' : ''}` : null], ['Alternatives', notice.allow_alternatives ? 'Allowed' : 'Not allowed'], ['Revision', notice.allow_revision ? 'Allowed until close' : 'Not allowed']]} /></Panel>
                </>
              )}
            </>
          ) : null}
          {tab === 'lots' ? <Panel title="Lots"><DataTable cols={[{ key: 'code', label: 'Lot', min: 60, flex: 0.4, bold: true }, { key: 'title', label: 'Scope', flex: 2, min: 160 }, { key: 'qty', label: 'Quantity', render: (l) => `${l.qty} ${l.unit ?? ''}`, min: 120 }, { key: 'p', label: 'Partial bids', render: (l) => (l.bundle_with?.length ? `Bundle with ${l.bundle_with.join(', ')}` : l.allow_partial ? 'Allowed' : 'Full quantity only'), min: 140 }]} rows={notice.lots} keyOf={(l) => l.code} /></Panel> : null}
          {tab === 'requirements' ? (
            <>
              <Panel title="To qualify"><Checks items={credItems.length ? credItems : (notice.required_credentials ?? []).map((r) => ({ state: 'info', title: r.title ?? nice(r.kind), detail: r.verified_required ? 'Must be verified' : 'Declared is enough at entry' }))} empty="No certificates or insurance are required to qualify." /></Panel>
              {d.questionnaire ? <Panel title="Questionnaire"><DataTable cols={[{ key: 'section', label: 'Section', render: (q) => nice(q.section), min: 110 }, { key: 'prompt', label: 'Question', flex: 3, min: 220 }, { key: 'type', label: 'Answer', render: (q) => `${nice(q.type)}${q.required ? '' : ' (optional)'}`, min: 130 }, { key: 'pf', label: 'Rule', render: (q) => (q.pass_fail ? 'Pass or fail' : q.evidence_required ? 'Evidence needed' : ''), min: 110 }]} rows={d.questionnaire} keyOf={(q) => q.key} /></Panel> : <Notice tone="info">The questionnaire opens after you accept the terms.</Notice>}
            </>
          ) : null}
          {tab === 'documents' ? <Panel title="Tender pack">{d.files.length ? d.files.map((f) => <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><View style={{ flex: 1 }}><T weight="600" size={13}>{f.name}</T><T size={12} color={c.mute}>{f.audience === 'public' ? 'Public' : 'Participants'} · {Math.max(1, Math.round(f.bytes / 1024))} KB</T></View><Btn small title="Open" color={c.violet} onPress={() => openStored(`/tender-files/${f.id}`, f.name).catch((e) => toast(explain(e)))} /></View>) : <T size={13} color={c.mute}>No documents yet. Participants see more after accepting the terms.</T>}</Panel> : null}
          {tab === 'qa' ? (
            <Panel title="Clarifications" right={part ? <Btn small title="Ask" onPress={() => setSheet('ask')} /> : null}>
              {(qa.data ?? []).length ? qa.data.map((x) => <View key={x.id} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}><T weight="700" size={13}>{x.question}</T>{x.answer ? <T size={13}>{x.answer}</T> : <T size={12} color={c.mute}>Waiting for the buyer{x.mine ? ' (your question)' : ''}</T>}</View>) : <T size={13} color={c.mute}>No clarifications yet. Material answers are shared with everyone without naming who asked.</T>}
            </Panel>
          ) : null}
          {tab === 'addenda' ? <Panel title="Addenda">{d.addenda.length ? d.addenda.map((a) => <View key={a.n} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="700" size={13}>Addendum {a.n}</T>{a.material ? <Status tone="warn" label="Material change" /> : null}{d.unacknowledged_addenda?.includes(a.n) ? <Btn small title="Acknowledge" onPress={async () => { try { await api.post(`/tenders/${id}/addenda/${a.n}/acknowledge`, { entity_id: entity }); n.reload(); } catch (e) { toast(explain(e)); } }} /> : null}</View><T size={13}>{a.summary}</T><T size={12} color={c.mute}>Issued {day(a.issued_at)} · tender version {a.rfp_version}</T></View>) : <T size={13} color={c.mute}>No addenda have been issued.</T>}</Panel> : null}
        </>} side={<>{actions}{elig.data && tab === 'overview' ? <Panel title="Your eligibility"><Checks items={credItems} empty="No certificates are required." />{elig.data.meets_requirements ? <Status tone="ok" label="You meet the requirements" /> : null}</Panel> : null}</>} />
      </View>
      <Terms visible={sheet === 'terms'} onClose={() => setSheet(null)} t={d} onAccept={async (nda) => { setSheet(null); await act('accept_terms'); if (nda) await act('accept_nda'); }} />
      <FormSheet visible={sheet === 'ask'} onClose={() => setSheet(null)} title="Ask a clarification" submitLabel="Send question" fields={[{ key: 'question', label: 'Your question', type: 'multiline', hint: 'Do not include your prices or anything confidential. Material answers are shared with every participant without naming you.' }, { key: 'private', label: 'Ask privately', type: 'switch', hint: 'The buyer can still publish a material answer to everyone.' }]} initial={{ private: false }}
        onSubmit={async (v) => { await api.post(`/tenders/${id}/questions`, { entity_id: entity, question: v.question, private: !!v.private }); qa.reload(); return 'Question sent'; }} />
      <FormSheet visible={sheet === 'decline'} onClose={() => setSheet(null)} title="Decline to bid" submitLabel="Decline" fields={[{ key: 'reason', label: 'Reason', type: 'multiline' }]} onSubmit={async (v) => { await act('decline', { reason: v.reason }); }} />
      <FormSheet visible={sheet === 'start'} onClose={() => setSheet(null)} title="Start your proposal" submitLabel="Start"
        fields={[{ key: 'lots', label: 'Lots you will bid on', type: 'multi', options: (notice?.lots ?? []).map((l) => ({ value: l.code, label: `${l.code} · ${l.title}` })) }, ...(notice?.allow_alternatives ? [{ key: 'alt', label: 'Alternative proposal', type: 'switch', hint: 'Submit a second, different offer alongside your main proposal.' }] : [])]} initial={{ lots: (notice?.lots ?? []).map((l) => l.code) }}
        onSubmit={async (v) => { const p = await api.post(`/tenders/${id}/proposals`, { entity_id: entity, lots: v.lots, alt_key: v.alt ? 'alt1' : 'base' }); setTimeout(() => push('TenderProposal', { id: p.id }), 0); }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ supplier entities
const KINDS = [{ value: 'individual', label: 'Individual' }, { value: 'sole_trader', label: 'Sole trader' }, { value: 'company', label: 'Company' }];
const CRED = ['insurance', 'safeguarding', 'safety_certificate', 'trade_licence', 'tax_registration', 'qualification', 'other'];

export function SupplierEntities() {
  const { toast } = useSession();
  const [open, setOpen] = useState(null);
  const [sheet, setSheet] = useState(null);
  const list = useLoad(() => api.get('/supplier-entities', { limit: 50 }), []);
  const creds = useLoad(() => (open ? api.get(`/supplier-entities/${open}/credentials`) : Promise.resolve([])), [open]);
  const members = useLoad(() => (open ? api.get(`/supplier-entities/${open}/members`) : Promise.resolve([])), [open, sheet]);
  const cur = (list.data ?? []).find((e) => e.id === open);
  return (
    <Screen wide>
      <Head eyebrow="TENDER ZONE" title="Supplier entities" sub="The legal entity you bid as. Colleagues share one proposal; the owner or signatory submits." right={<Btn small title="Register entity" onPress={() => setSheet('new')} />} />
      <View style={{ marginTop: 14 }}>
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !(list.data ?? []).length ? <Empty emoji="🏷️" title="No supplier entity yet" sub="Register yourself as an individual or sole trader, or your company, to bid on tenders." /> : (
          <Split main={<View style={{ gap: 10 }}>{list.data.map((e) => <Card key={e.id} onPress={() => setOpen(e.id)}><View style={{ gap: 4 }}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="700" size={15} style={{ flexShrink: 1 }}>{e.legal_name}</T><Status tone="info" label={nice(e.kind)} />{e.credentials_expiring ? <Status tone="warn" label={`${e.credentials_expiring} expiring`} /> : null}</View><T size={12} color={c.mute}>Your role: {nice(e.my_role)} · {e.categories.join(', ') || 'no categories yet'}</T></View></Card>)}</View>}
            side={cur ? <>
              <Panel title={cur.legal_name} right={<Btn small title="Add certificate" color={c.violet} onPress={() => setSheet('cred')} />}>
                <DataTable cols={[{ key: 'title', label: 'Certificate', flex: 2, min: 140 }, { key: 'valid_to', label: 'Valid to', render: (x) => day(x.valid_to), min: 100 }, { key: 'status', label: 'Status', render: (x) => <Status tone={x.expired ? 'bad' : x.status === 'verified' ? 'ok' : 'warn'} label={x.expired ? 'Expired' : nice(x.status)} />, min: 100 }]} rows={creds.data ?? []} empty="No certificates yet. Add the insurance and safety certificates tenders ask for." />
                <T size={12} color={c.mute}>Declared means you stated it; verified means the platform checked it. Each tender says which it needs, and rechecks before an award.</T>
              </Panel>
              <Panel title="Collaborators" right={cur.my_role === 'owner' ? <Btn small title="Add" color={c.violet} onPress={() => setSheet('member')} /> : null}>
                {(members.data ?? []).map((m) => <View key={m.user_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={13} style={{ flex: 1 }}>{m.display_name} <T size={12} color={c.mute}>@{m.handle}</T></T><Status tone="neutral" label={nice(m.role)} /></View>)}
              </Panel>
            </> : null} />
        )}
      </View>
      <FormSheet visible={sheet === 'new'} onClose={() => setSheet(null)} title="Register supplier entity" submitLabel="Register"
        fields={[{ key: 'kind', label: 'You bid as', type: 'choice', options: KINDS }, { key: 'legal_name', label: 'Legal name' }, { key: 'trading_name', label: 'Trading name', optional: true }, { key: 'country', label: 'Country', type: 'country', optional: true }, { key: 'tax_id', label: 'Tax or business registration number', optional: true, hint: 'Stored encrypted. Never shown to other suppliers.' }, { key: 'categories', label: 'What you supply', type: 'multi', options: CATEGORIES, optional: true }, { key: 'currencies', label: 'Currencies you price in', type: 'multi', options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'], optional: true }, { key: 'coverage', label: 'Where you work', type: 'region', optional: true }]}
        initial={{ kind: 'company' }} onSubmit={async (v) => { const e = await api.post('/supplier-entities', v); list.reload(); setOpen(e.id); return 'Supplier entity registered'; }} />
      <FormSheet visible={sheet === 'cred'} onClose={() => setSheet(null)} title="Add certificate" submitLabel="Add"
        fields={[{ key: 'kind', label: 'Type', type: 'chips', options: CRED.map((v) => ({ value: v, label: nice(v) })) }, { key: 'title', label: 'Name', hint: 'For example: Public liability insurance' }, { key: 'issuer', label: 'Issued by', optional: true }, { key: 'number', label: 'Reference number', optional: true }, { key: 'valid_to', label: 'Valid until', type: 'date', optional: true }]}
        onSubmit={async (v) => { await api.post(`/supplier-entities/${open}/credentials`, v); creds.reload(); list.reload(); return 'Certificate added as declared'; }} />
      <FormSheet visible={sheet === 'member'} onClose={() => setSheet(null)} title="Add a collaborator" submitLabel="Add"
        fields={[{ key: 'handle', label: 'Their handle' }, { key: 'role', label: 'Role', type: 'choice', options: [{ value: 'bid_manager', label: 'Bid manager' }, { value: 'contributor', label: 'Contributor' }, { value: 'signatory', label: 'Signatory' }] }]} initial={{ role: 'contributor' }}
        onSubmit={async (v) => { await api.post(`/supplier-entities/${open}/members`, v); return 'Collaborator added'; }} />
    </Screen>
  );
}
