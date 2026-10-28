// RFP builder: a guided flow from context to approval. Every structured answer uses the control that fits it (date and time pickers in the
// tender's own time zone, money fields in the right currency, steppers for numbers, chips for fixed choices, search-and-pick for people,
// organisations, events and venues). Each step saves to the draft; the server validates before approval and the rubric freezes on approval.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Screen, Sheet, T } from '../ui';
import { Counter, DateField, TimeField } from '../pickers';
import { CurrencyDropdown } from '../currency-dropdown';
import { EntityPicker } from '../entity-picker';
import { SportSelect } from '../sportpicker';
import { Head } from './coaching';
import { c } from '../theme';
import { explain } from '../access';
import { CATEGORIES } from './tender-zone';
import { Checks, Chips, DataTable, KV, Notice, Panel, Split, StageTag, Status, amount, blobOf, day, fromMinor, nice, openStored, toMinor, wallOf, when, zonedIso, openDocument } from '../tender-ui';

const STEPS = ['Context', 'Scope and lots', 'Schedule', 'Eligibility', 'Questionnaire', 'Evaluation', 'Terms and access', 'Review'];
const UNITS = ['hour', 'shift', 'day', 'person-hour', 'person-shift', 'visit', 'area', 'job', 'trip', 'room-night', 'site', 'month'];
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Colombo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'Australia/Sydney', 'UTC'];
const CRED = ['insurance', 'safeguarding', 'safety_certificate', 'trade_licence', 'tax_registration', 'qualification'];
const QTYPES = [['text', 'Text'], ['yes_no', 'Yes or no'], ['single_select', 'Choose one'], ['multi_select', 'Choose several'], ['number', 'Number'], ['date', 'Date'], ['currency', 'Amount'], ['table', 'Table'], ['attachment', 'File']];
const SECTIONS = [['qualification', 'Qualification'], ['technical', 'Technical'], ['commercial', 'Commercial'], ['legal', 'Legal']];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'item';

const Row2 = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{React.Children.map(children, (x) => <View style={{ flexGrow: 1, flexBasis: 220, minWidth: 0 }}>{x}</View>)}</View>;
const Lbl = ({ children }) => <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.7, textTransform: 'uppercase' }}>{children}</T>;
const Choice = ({ label, hint, children }) => <View style={{ gap: 6 }}><Lbl>{label}</Lbl>{children}{hint ? <T size={12} color={c.mute}>{hint}</T> : null}</View>;

/** Date and time in the tender's own zone -> one instant. */
function When({ label, value, tz, onChange, optional = true }) {
  const w = wallOf(value, tz);
  const set = (date, time) => onChange(date ? zonedIso(date, time ?? w.time ?? '17:00', tz) : null);
  return (
    <View style={{ gap: 8 }}>
      <DateField label={label} optional={optional} value={w.date} onChange={(d) => set(d, w.time)} />
      {w.date ? <TimeField label="Time" optional step={15} value={w.time} onChange={(tm) => set(w.date, tm)} hint={value ? `In ${tz.replace(/_/g, ' ')}; ${new Date(value).toISOString().slice(11, 16)} UTC` : undefined} /> : null}
    </View>
  );
}

const defaultRubric = () => ({ weights: { technical: 60, commercial: 40 }, technical_pass_mark: 50, min_reviewers: 1, commercial_method: 'lowest_ratio', na_policy: 'exclude_and_reweight', tie_break: ['commercial_score', 'technical_score', 'earlier_submission'], criteria: [] });


const AUDIENCES = [{ value: 'public', label: 'Public notice' }, { value: 'participants', label: 'Participants' }, { value: 'buyer', label: 'Buying team only' }];

/** The tender pack while drafting: upload the RFP document and annexes, open one, amend it by uploading the new version (the earlier one is kept), or add another. */
function PackDocuments({ id, toast }) {
  const docs = useLoad(() => api.get(`/rfps/${id}/documents`, { include_archived: 'true' }), [id]);
  const [aud, setAud] = useState('participants');
  const [visit, setVisit] = useState(false);
  const [busy, setBusy] = useState(null);
  const [history, setHistory] = useState(false);
  const all = docs.data?.documents ?? [], editable = !!docs.data?.editable;
  const current = all.filter((d) => d.current), old = all.filter((d) => !d.current);
  const version = (d) => { let n = 1, x = d; while (x?.replaces_id) { x = all.find((y) => y.id === x.replaces_id); n += 1; } return n; };
  const pick = async (replace) => {
    try {
      const { pickEvidence } = await import('../evidence');
      const f = await pickEvidence('files', { documents: true });
      if (!f) return;
      setBusy(replace?.id ?? 'new');
      await api.upload(`/rfps/${id}/files`, await blobOf(f), { name: f.file_name, ...(replace ? { replaces: replace.id } : { audience: aud, ...(visit && aud === 'participants' ? { visit_pack: 'true' } : {}) }) });
      toast(replace ? 'Document replaced. The earlier version is kept in the history.' : 'Document added');
      docs.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  const act = async (fn, msg) => { try { await fn(); toast(msg); docs.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Panel title="Tender documents" right={docs.data ? <Status tone="neutral" label={`${current.length} document${current.length === 1 ? '' : 's'}`} /> : null}>
      <T size={13} color={c.mute}>Upload the RFP document and any annexes now or later. PDF, Word, Excel (without macros) or images, up to 10 MB each. Open a document to review it, amend it by uploading the new version (the earlier version is kept), or add another.</T>
      {docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : null}
      {current.map((d) => (
        <View key={d.id} style={{ gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T size={14} weight="700" style={{ flex: 1, minWidth: 180 }}>{d.name}</T>
            <Status tone="neutral" label={AUDIENCES.find((a) => a.value === d.audience)?.label ?? d.audience} />
            {d.visit_pack ? <Status tone="warn" label="Site-visit document" /> : null}
            {version(d) > 1 ? <Status tone="info" label={`Version ${version(d)}`} /> : null}
          </View>
          <T size={12} color={c.mute}>{Math.max(1, Math.round(d.bytes / 1024))} KB · added {day(d.created_at)}{d.added_by ? ` by @${d.added_by}` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title="Open" color={c.violet} onPress={() => openStored(`/tender-files/${d.id}`, d.name).catch((e) => toast(explain(e)))} accessibilityLabel={`Open ${d.name}`} />
            {editable ? <Btn small title={busy === d.id ? 'Uploading…' : 'Amend (upload new version)'} color={c.paper} ink={c.ink} disabled={!!busy} onPress={() => pick(d)} accessibilityLabel={`Replace ${d.name} with an amended version`} /> : null}
            {editable && d.audience === 'participants' ? <Btn small title={d.visit_pack ? 'Not a site-visit document' : 'Make it a site-visit document'} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/rfps/${id}/visit-documents`, { file_id: d.id, visit_pack: !d.visit_pack }), d.visit_pack ? 'No longer a site-visit document' : 'Suppliers must acknowledge it')} /> : null}
            {editable ? <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/rfps/${id}/documents/${d.id}/archive`), 'Removed from the pack. It stays in the history.')} accessibilityLabel={`Remove ${d.name}`} /> : null}
          </View>
        </View>
      ))}
      {!current.length && docs.data ? <T size={13} color={c.mute}>No documents yet.</T> : null}
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: c.line, paddingTop: 12 }}>
        <Lbl>Add a document for</Lbl>
        <Chips options={AUDIENCES} value={aud} onChange={(v) => { setAud(v); if (v !== 'participants') setVisit(false); }} />
        {aud === 'participants' ? <Chips options={[{ value: false, label: 'Ordinary document' }, { value: true, label: 'Site-visit document' }]} value={visit} onChange={setVisit} /> : null}
        <Btn title={busy === 'new' ? 'Uploading…' : 'Upload a document'} disabled={!!busy} onPress={() => pick(null)} style={{ alignSelf: 'flex-start' }} accessibilityLabel="Upload a tender document" />
        {!editable && docs.data ? <Notice tone="info">This tender is no longer a draft. New documents can still be added, but an existing one cannot be replaced or removed: add the amended document and issue an addendum that says what changed.</Notice> : null}
      </View>
      {old.length ? <><Btn small title={history ? 'Hide earlier versions' : `Earlier versions (${old.length})`} color={c.paper} ink={c.ink} onPress={() => setHistory(!history)} style={{ alignSelf: 'flex-start' }} />{history ? old.map((d) => <T key={d.id} size={12} color={c.mute}>{d.name} · {day(d.created_at)} · replaced or removed {day(d.archived_at)}</T>) : null}</> : null}
    </Panel>
  );
}

export function TenderBuilder({ id: openId, event_id, organisation_id, venue_id }) {
  const { toast } = useSession();
  const { push, back } = useNav();
  const [id, setId] = useState(openId ?? null);
  const [step, setStep] = useState(0);
  const [t, setT] = useState(null);
  const [lots, setLots] = useState([]);
  const [qs, setQs] = useState([]);
  const [rubric, setRubric] = useState(defaultRubric());
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState(null);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState({ kind: 'rfp', title: '', category: CATEGORIES[0], organisation_id: organisation_id ?? null, event_id: event_id ?? null, venue_id: venue_id ?? null, currency: 'INR', timezone: 'Asia/Kolkata', contract_type: 'one_off' });
  const [tplId, setTplId] = useState(null);
  const orgs = useLoad(() => api.get('/organisations').catch(() => []), []);
  const events = useLoad(() => api.get('/events', { mine: true, limit: 100 }).catch(() => []), []);
  const venues = useLoad(() => api.get('/me/venues').catch(() => []), []);
  const tpls = useLoad(() => api.get('/tender-templates', { kind: 'rfp_template', limit: 50 }).catch(() => []), []);
  const sets = useLoad(() => api.get('/tender-templates', { kind: 'question_set', limit: 50 }).catch(() => []), []);
  const loaded = useLoad(async () => (id ? api.get(`/rfps/${id}`) : null), [id]);
  useEffect(() => { const d = loaded.data; if (d && !t) { setT(d); setLots(d.lots.map((l) => ({ ...l, qty: Number(l.qty) }))); setQs(d.questions); setRubric(d.rubric ?? defaultRubric()); } }, [loaded.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const tz = t?.timezone ?? form.timezone;
  const set = (patch) => setT((x) => ({ ...x, ...patch }));
  const locked = t && t.status !== 'draft';

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/rfps', { kind: form.kind, title: form.title.trim(), category: form.category, organisation_id: form.organisation_id ?? undefined, event_id: form.event_id ?? undefined, venue_id: form.venue_id ?? undefined, template_id: tplId ?? undefined, sport: form.sport || undefined, currency: form.currency, contract_type: form.contract_type, timezone: form.timezone });
      setId(r.id); setT(null); setStep(1); toast('Draft created');
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const save = async (extra = {}) => {
    const body = { row_version: t.row_version, title: t.title, objective: t.objective ?? null, scope: t.scope ?? null, inclusions: t.inclusions ?? null, exclusions: t.exclusions ?? null, category: t.category, location: t.location ?? null, contract_type: t.contract_type,
      prep_start: t.prep_start ? String(t.prep_start).slice(0, 10) : null, service_start: t.service_start ? String(t.service_start).slice(0, 10) : null, service_end: t.service_end ? String(t.service_end).slice(0, 10) : null, teardown_end: t.teardown_end ? String(t.teardown_end).slice(0, 10) : null,
      currency: t.currency, budget_minor: t.budget_minor ?? null, budget_public: !!t.budget_public, ceiling_minor: t.ceiling_minor ?? null, cost_basis: t.cost_basis, publication: t.publication, envelope_mode: t.envelope_mode, timezone: t.timezone,
      publish_at: t.publish_at ?? null, clarification_deadline: t.clarification_deadline ?? null, site_visit_at: t.site_visit_at ?? null, site_visit_mandatory: !!t.site_visit_mandatory, closes_at: t.closes_at ?? null, opens_at: t.opens_at ?? null, evaluation_due: t.evaluation_due ?? null, award_target: t.award_target ?? null,
      standstill_days: t.standstill_days ?? 0, allow_revision: !!t.allow_revision, allow_withdrawal: !!t.allow_withdrawal, allow_alternatives: !!t.allow_alternatives, quorum: t.quorum ?? 1, required_credentials: t.required_credentials ?? [], disclosure: t.disclosure ?? { rank: false, bidder_count: false, award_public: false }, fx: t.fx ?? null, sites: t.sites ?? [],
      renewal_options: t.renewal_options ?? 0, renewal_term_months: t.renewal_options > 0 ? (t.renewal_term_months ?? null) : null, renewal_ceiling_minor: t.renewal_options > 0 ? (t.renewal_ceiling_minor ?? null) : null, notice_days: t.notice_days ?? 0,
      milestones: (t.milestones ?? []).filter((m) => m.name?.trim() && m.due_on).map((m) => ({ name: m.name.trim(), due_on: String(m.due_on).slice(0, 10), description: m.description || undefined })), reserve_policy: t.reserve_policy ?? 'none',
      lots: lots.map((l) => ({ code: l.code, title: l.title, description: l.description || undefined, qty: Number(l.qty), unit: l.unit || undefined, supply_kind: l.supply_kind || 'service', estimate_minor: l.estimate_minor ?? undefined, allow_partial: l.allow_partial !== false, bundle_with: l.bundle_with ?? [] })),
      questions: qs.map((q) => ({ key: q.key, section: q.section, prompt: q.prompt, type: q.type, options: q.options ?? undefined, unit: q.unit ?? undefined, required: q.required !== false, pass_fail: !!q.pass_fail, pass_value: q.pass_fail ? q.pass_value : undefined, evidence_required: !!q.evidence_required, lot_code: q.lot_code ?? undefined })),
      rubric: t.kind === 'rfi' ? null : (rubric.criteria.length || rubric.weights ? rubric : null), ...extra };
    try { const r = await api.patch(`/rfps/${id}`, body); setT((x) => ({ ...x, row_version: r.row_version })); return true; } catch (e) { toast(explain(e)); if (e.status === 409) { setT(null); loaded.reload(); } return false; }
  };
  const next = async () => { if (!locked && step > 0) { setBusy(true); const ok = await save(); setBusy(false); if (!ok) return; } if (step === 7) return; setStep(step + 1); };

  if (loaded.error) return <Screen><ErrorBox error={loaded.error} onRetry={loaded.reload} /></Screen>;
  if (id && !t) return <Screen><Loading /></Screen>;

  // ---------------------------------------------------------------- step bodies
  const ctx = (
    <>
      <Panel title="What are you sourcing?">
        <Choice label="Procurement type" hint={{ rfi: 'RFI: find out who can do it and qualify suppliers.', rfp: 'RFP: evaluate proposed solutions against criteria and price.', rfq: 'RFQ: compare prices for a clearly defined requirement.' }[form.kind]}><Chips options={[{ value: 'rfp', label: 'RFP' }, { value: 'rfq', label: 'RFQ' }, { value: 'rfi', label: 'RFI' }]} value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} /></Choice>
        <Field label="Title" value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder="What is being sourced, and for what" />
        <Choice label="Category"><Chips options={CATEGORIES} value={form.category} onChange={(v) => setForm({ ...form, category: v })} /></Choice>
        <SportSelect label="Sport (optional)" optional allLabel="Any sport" value={form.sport} onChange={(v) => setForm({ ...form, sport: v })} />
      </Panel>
      <Panel title="Who is buying">
        <EntityPicker label="Acting organisation" optional noun="organisation" options={(orgs.data ?? []).filter((o) => o.status !== 'archived').map((o) => ({ id: o.id, label: o.name, sub: o.kind }))} value={form.organisation_id ? [{ id: form.organisation_id, label: (orgs.data ?? []).find((o) => o.id === form.organisation_id)?.name ?? 'Organisation' }] : []} onChange={(l) => setForm({ ...form, organisation_id: l[0]?.id ?? null })} />
        <EntityPicker label="For an event (optional)" optional noun="event" options={(events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: `${e.starts_on ?? ''}` }))} value={form.event_id ? [{ id: form.event_id, label: (events.data ?? []).find((e) => e.id === form.event_id)?.name ?? 'Event' }] : []} onChange={(l) => setForm({ ...form, event_id: l[0]?.id ?? null })} />
        <EntityPicker label="For a venue you own or manage (optional)" optional noun="venue" options={(venues.data ?? []).filter((v) => v.role !== 'staff').map((v) => ({ id: v.id, label: v.name, sub: [v.city, v.role].filter(Boolean).join(' · ') }))} value={form.venue_id ? [{ id: form.venue_id, label: (venues.data ?? []).find((v) => v.id === form.venue_id)?.name ?? 'Venue' }] : []} onChange={(l) => setForm({ ...form, venue_id: l[0]?.id ?? null })} />
        <T size={12} color={c.mute}>Pick an organisation you own or hold a procurement mandate for, an event you organise, or a venue you own or manage (for example pool or ground maintenance, Wi-Fi, crew). Without any of these the tender is standalone.</T>
      </Panel>
      <Panel title="Settings">
        <CurrencyDropdown label="Currency" value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
        <Choice label="Time zone" hint="All dates you set are wall-clock times in this zone. Suppliers see them in this zone and in UTC."><Chips options={ZONES.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} /></Choice>
        <Choice label="Contract"><Chips options={[{ value: 'one_off', label: 'One-off event' }, { value: 'fixed_term', label: 'Fixed term' }, { value: 'recurring', label: 'Recurring service' }, { value: 'framework', label: 'Framework' }]} value={form.contract_type} onChange={(v) => setForm({ ...form, contract_type: v })} /></Choice>
        {(tpls.data ?? []).length ? <Choice label="Start from a template (optional)" hint="Copies lots, questionnaire and rubric. It never copies suppliers, prices or people."><Chips options={tpls.data.map((x) => ({ value: x.id, label: `${x.name} v${x.version}` }))} value={tplId} onChange={(v) => setTplId(tplId === v ? null : v)} /></Choice> : null}
      </Panel>
    </>
  );

  const lotEditor = (
    <>
      <Panel title="Scope of work">
        <Field label="Objective" multiline value={t?.objective ?? ''} onChangeText={(v) => set({ objective: v })} hint="Why this is being sourced." />
        <Field label="Scope" multiline value={t?.scope ?? ''} onChangeText={(v) => set({ scope: v })} hint="What the supplier must deliver, to what standard." />
        <Row2><Field label="Included" multiline value={t?.inclusions ?? ''} onChangeText={(v) => set({ inclusions: v })} /><Field label="Not included" multiline value={t?.exclusions ?? ''} onChangeText={(v) => set({ exclusions: v })} /></Row2>
        <Choice label="Sites"><EntityPicker label="Venues where work happens" optional noun="venue" multi options={(venues.data ?? []).map((v) => ({ id: v.id, label: v.name, sub: v.city }))} value={(t?.sites ?? []).filter((s) => s.venue_id).map((s) => ({ id: s.venue_id, label: s.label }))} onChange={(l) => set({ sites: l.map((x) => ({ venue_id: x.id, label: x.label })) })} /></Choice>
        <Field label="Location (if not a listed venue)" value={t?.location ?? ''} onChangeText={(v) => set({ location: v })} />
        <Choice label="Contract"><Chips options={[{ value: 'one_off', label: 'One-off event' }, { value: 'fixed_term', label: 'Fixed term' }, { value: 'recurring', label: 'Recurring service' }, { value: 'framework', label: 'Framework' }]} value={t?.contract_type} onChange={(v) => set({ contract_type: v })} /></Choice>
      </Panel>
      <Panel title="Lots and line items" right={<Btn small title="+ Add lot" onPress={() => setLots([...lots, { code: `L${lots.length + 1}`, title: '', qty: 1, unit: 'job', allow_partial: true, bundle_with: [] }])} />}>
        {!lots.length ? <Empty emoji="🧱" title="No lots yet" sub="Split the work into lots so different suppliers can win different parts: for example pitch preparation, crew, Wi-Fi, transport." /> : lots.map((l, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="700">Lot {l.code}</T><Btn small title="Remove" color={c.violet} onPress={() => setLots(lots.filter((_, j) => j !== i))} /></View>
            <Field label="What is the lot" value={l.title} onChangeText={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
            <Row2><View style={{ gap: 6 }}><Lbl>Quantity</Lbl><Counter value={Number(l.qty)} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, qty: v } : x)))} min={1} max={1000000} step={l.qty >= 100 ? 10 : 1} /></View>
              <Choice label="Unit"><Chips options={UNITS} value={l.unit} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, unit: v } : x)))} /></Choice></Row2>
            <Choice label="Supply"><Chips options={[{ value: 'service', label: 'Service' }, { value: 'goods', label: 'Goods' }]} value={l.supply_kind ?? 'service'} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, supply_kind: v } : x)))} /></Choice>
            <Field label={`Estimate (${t?.currency ?? form.currency}, optional)`} value={l.estimate_minor != null ? fromMinor(l.estimate_minor, t.currency) : ''} onChangeText={(v) => { const m = toMinor(v, t.currency); setLots(lots.map((x, j) => (j === i ? { ...x, estimate_minor: m ?? undefined } : x))); }} keyboardType="decimal-pad" />
            <Choice label="Partial offers" hint="Off means a supplier must offer the full quantity."><Chips options={[{ value: true, label: 'Allowed' }, { value: false, label: 'Full quantity only' }]} value={l.allow_partial !== false} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, allow_partial: v } : x)))} /></Choice>
            {lots.length > 1 ? <Choice label="Must be bid together with"><Chips multi options={lots.filter((x) => x.code !== l.code).map((x) => ({ value: x.code, label: `${x.code} ${x.title}`.trim() }))} value={l.bundle_with ?? []} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, bundle_with: v } : x)))} /></Choice> : null}
          </View></Card>
        ))}
      </Panel>
    </>
  );

  const sched = (
    <>
      <Panel title="Key dates"><Row2>
        <When label="Publish at (blank = on approval)" value={t?.publish_at} tz={tz} onChange={(v) => set({ publish_at: v })} />
        <When label="Clarifications until" value={t?.clarification_deadline} tz={tz} onChange={(v) => set({ clarification_deadline: v })} />
        <When label="Site visit or pre-bid meeting" value={t?.site_visit_at} tz={tz} onChange={(v) => set({ site_visit_at: v })} />
        <When label="Submission closes" value={t?.closes_at} tz={tz} optional={false} onChange={(v) => set({ closes_at: v })} />
        <When label="Opening not before" value={t?.opens_at} tz={tz} onChange={(v) => set({ opens_at: v })} />
        <When label="Evaluation due" value={t?.evaluation_due} tz={tz} onChange={(v) => set({ evaluation_due: v })} />
        <When label="Award target" value={t?.award_target} tz={tz} onChange={(v) => set({ award_target: v })} />
      </Row2>
        <Choice label="Site visit attendance" hint="When mandatory, a proposal cannot be submitted without recorded attendance or a permitted exemption."><Chips options={[{ value: false, label: 'Optional' }, { value: true, label: 'Mandatory' }]} value={!!t?.site_visit_mandatory} onChange={(v) => set({ site_visit_mandatory: v })} /></Choice>
        {t?.closes_at ? <Notice tone="info">Closes {when(t.closes_at, tz)}. Proposals received at or after that instant, by the server clock, are not accepted.</Notice> : null}
      </Panel>
      <Panel title="Service period">
        <Row2><DateField label="Preparation starts" optional value={t?.prep_start ? String(t.prep_start).slice(0, 10) : null} onChange={(v) => set({ prep_start: v })} /><DateField label="Service starts" optional value={t?.service_start ? String(t.service_start).slice(0, 10) : null} onChange={(v) => set({ service_start: v })} /><DateField label="Service ends" optional value={t?.service_end ? String(t.service_end).slice(0, 10) : null} onChange={(v) => set({ service_end: v })} /><DateField label="Teardown ends" optional value={t?.teardown_end ? String(t.teardown_end).slice(0, 10) : null} onChange={(v) => set({ teardown_end: v })} /></Row2>
        <T size={12} color={c.mute}>The submission deadline, the award date and the service period are separate: the contract duration is not the bidding window.</T>
      </Panel>
    </>
  );

  const elig = (
    <Panel title="What a supplier must hold to qualify">
      <T size={13} color={c.mute}>These are checked when a supplier takes part, again at the qualification gate after opening, and once more before an award is issued, including expiry against the service dates.</T>
      <Chips multi options={CRED.map((k) => ({ value: k, label: nice(k) }))} value={(t?.required_credentials ?? []).map((r) => r.kind)} onChange={(v) => set({ required_credentials: v.map((k) => (t.required_credentials ?? []).find((r) => r.kind === k) ?? { kind: k, title: nice(k)[0].toUpperCase() + nice(k).slice(1), verified_required: false }) })} />
      {(t?.required_credentials ?? []).map((r) => <View key={r.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><T size={13} weight="700" style={{ minWidth: 150 }}>{r.title}</T><Chips options={[{ value: false, label: 'Declared is enough' }, { value: true, label: 'Must be verified' }]} value={!!r.verified_required} onChange={(v) => set({ required_credentials: t.required_credentials.map((x) => (x.kind === r.kind ? { ...x, verified_required: v } : x)) })} /></View>)}
      <T size={12} color={c.mute}>A generic verified badge is not approval to supply. Each requirement states what is needed.</T>
    </Panel>
  );

  const addQ = () => setQs([...qs, { key: `q_${qs.length + 1}`, section: 'technical', prompt: '', type: 'text', required: true }]);
  const quest = (
    <>
      <Panel title="Questionnaire" right={<View style={{ flexDirection: 'row', gap: 6 }}>{(sets.data ?? []).length ? <Btn small title="From library" color={c.violet} onPress={() => setPreview('library')} /> : null}<Btn small title="+ Question" onPress={addQ} /></View>}>
        {!qs.length ? <Empty emoji="❓" title="No questions yet" sub="Ask what you need to evaluate: approach, evidence, qualification answers that pass or fail." /> : qs.map((q, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Status tone="info" label={nice(q.section)} /><Btn small title="Remove" color={c.violet} onPress={() => setQs(qs.filter((_, j) => j !== i))} /></View>
            <Field label="Question" multiline value={q.prompt} onChangeText={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, prompt: v, key: x.key.startsWith('q_') ? slug(v) || x.key : x.key } : x)))} />
            <Choice label="Section"><Chips options={SECTIONS.map(([value, label]) => ({ value, label }))} value={q.section} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, section: v } : x)))} /></Choice>
            <Choice label="Answer type"><Chips options={QTYPES.map(([value, label]) => ({ value, label }))} value={q.type} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, type: v, pass_fail: false, options: ['single_select', 'multi_select', 'table'].includes(v) ? x.options ?? [] : undefined } : x)))} /></Choice>
            {['single_select', 'multi_select', 'table'].includes(q.type) ? <OptionsEditor label={q.type === 'table' ? 'Columns' : 'Options'} value={q.options ?? []} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, options: v } : x)))} /> : null}
            <Row2><Choice label="Required"><Chips options={[{ value: true, label: 'Yes' }, { value: false, label: 'Optional' }]} value={q.required !== false} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, required: v } : x)))} /></Choice><Choice label="Evidence"><Chips options={[{ value: false, label: 'Not needed' }, { value: true, label: 'File required' }]} value={!!q.evidence_required} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, evidence_required: v } : x)))} /></Choice></Row2>
            {['yes_no', 'single_select'].includes(q.type) ? <Choice label="Pass or fail gate" hint="A supplier whose answer differs is ineligible and cannot win."><Chips options={[{ value: false, label: 'Scored or informational' }, { value: true, label: 'Pass or fail' }]} value={!!q.pass_fail} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_fail: v, pass_value: v ? (q.type === 'yes_no' ? true : (q.options ?? [])[0]) : undefined } : x)))} />
              {q.pass_fail ? <View style={{ gap: 6, marginTop: 6 }}><Lbl>Passing answer</Lbl>{q.type === 'yes_no' ? <Chips options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} value={q.pass_value} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_value: v } : x)))} /> : <Chips options={q.options ?? []} value={q.pass_value} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_value: v } : x)))} />}</View> : null}</Choice> : null}
            {lots.length > 1 ? <Choice label="Applies to lot (optional)"><Chips options={lots.map((l) => ({ value: l.code, label: l.code }))} value={q.lot_code} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, lot_code: q.lot_code === v ? undefined : v } : x)))} /></Choice> : null}
          </View></Card>
        ))}
      </Panel>
      <Panel title="Pricing">
        <T size={13} color={c.mute}>Suppliers price every lot with a quantity, unit rate, discount and tax. Pricing is always in the commercial envelope.</T>
        <Choice label="Compare costs" hint="Declare the tax assumption once: costs are compared before tax or including tax, for every bid."><Chips options={[{ value: 'net', label: 'Before tax (net)' }, { value: 'gross', label: 'Including tax (gross)' }]} value={t?.cost_basis} onChange={(v) => set({ cost_basis: v })} /></Choice>
        <FxEditor fx={t?.fx} cur={t?.currency} onChange={(v) => set({ fx: v })} />
      </Panel>
    </>
  );

  const rb = rubric;
  const critSum = rb.criteria.reduce((a, x) => a + Number(x.weight || 0), 0);
  const evalStep = t?.kind === 'rfi' ? <Notice tone="info">An RFI qualifies suppliers; it has no scoring rubric.</Notice> : (
    <>
      <Panel title="How the winner is chosen">
        <T size={13} color={c.mute}>The rubric is frozen when the tender is approved and cannot change after proposals arrive. Ineligible bids never win, whatever their price. Missing scores block the final ranking; they are never treated as zero.</T>
        <Row2><View style={{ gap: 6 }}><Lbl>Technical weight %</Lbl><Counter value={rb.weights.technical} onChange={(v) => setRubric({ ...rb, weights: { technical: v, commercial: 100 - v } })} min={0} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>Commercial weight %</Lbl><Counter value={rb.weights.commercial} onChange={(v) => setRubric({ ...rb, weights: { technical: 100 - v, commercial: v } })} min={0} max={100} step={5} /></View></Row2>
        <Row2><View style={{ gap: 6 }}><Lbl>Technical pass mark (0 to 100)</Lbl><Counter value={rb.technical_pass_mark} onChange={(v) => setRubric({ ...rb, technical_pass_mark: v })} min={0} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>Reviewers needed per criterion</Lbl><Counter value={rb.min_reviewers} onChange={(v) => setRubric({ ...rb, min_reviewers: v })} min={1} max={10} /></View></Row2>
        <Choice label="Tie-break order" hint="Used only when total scores are exactly equal."><Chips options={[{ value: 'commercial_score', label: 'Commercial score' }, { value: 'technical_score', label: 'Technical score' }, { value: 'earlier_submission', label: 'Earlier submission' }]} multi value={rb.tie_break} onChange={(v) => setRubric({ ...rb, tie_break: v })} /></Choice>
      </Panel>
      <Panel title="Technical criteria" right={<Btn small title="+ Criterion" onPress={() => setRubric({ ...rb, criteria: [...rb.criteria, { key: `criterion_${rb.criteria.length + 1}`, title: '', weight: Math.max(0, 100 - critSum), scale_min: 0, scale_max: 10, evidence_required: false }] })} />}>
        {rb.criteria.map((x, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700" size={13}>Criterion {i + 1}</T><Btn small title="Remove" color={c.violet} onPress={() => setRubric({ ...rb, criteria: rb.criteria.filter((_, j) => j !== i) })} /></View>
            <Field label="Name" value={x.title} onChangeText={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, title: v, key: y.key.startsWith('criterion_') ? slug(v) : y.key } : y)) })} />
            <Row2><View style={{ gap: 6 }}><Lbl>Weight %</Lbl><Counter value={x.weight} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, weight: v } : y)) })} min={1} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>Top score</Lbl><Counter value={x.scale_max} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, scale_max: v } : y)) })} min={1} max={100} /></View></Row2>
            <Row2><Choice label="Evidence"><Chips options={[{ value: false, label: 'Not required' }, { value: true, label: 'Required to lock a score' }]} value={!!x.evidence_required} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, evidence_required: v } : y)) })} /></Choice>
              <View style={{ gap: 6 }}><Lbl>Mandatory minimum (% of top score, 0 = none)</Lbl><Counter value={x.min_normalised ?? 0} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, min_normalised: v || undefined } : y)) })} min={0} max={100} step={5} /></View></Row2>
          </View></Card>
        ))}
        {rb.weights.technical > 0 ? <Notice tone={Math.abs(critSum - 100) < 1e-9 ? 'info' : 'warn'}>{Math.abs(critSum - 100) < 1e-9 ? 'Criteria weights add up to 100.' : `Criteria weights add up to ${critSum}. They must add up to 100.`}</Notice> : null}
        <T size={12} color={c.mute}>Commercial score: the lowest comparable evaluated cost scores 100; other bids score 100 times the lowest cost divided by their own.</T>
      </Panel>
    </>
  );

  const terms = (
    <>
      <Panel title="Access and envelopes">
        <Choice label="Who can take part" hint="A public notice still keeps attachments, proposals and bidder identities private."><Chips options={[{ value: 'public', label: 'Public notice' }, { value: 'restricted', label: 'Restricted: approved suppliers' }, { value: 'invite_only', label: 'Invite only' }, { value: 'private', label: 'Private organisation sourcing' }]} value={t?.publication} onChange={(v) => set({ publication: v })} /></Choice>
        <Choice label="Envelopes" hint="Sealed envelopes cannot be read by anyone, including the buying team, before the deadline and the recorded opening."><Chips options={[{ value: 'sealed_dual', label: 'Technical and commercial sealed' }, { value: 'sealed_single', label: 'One sealed envelope' }, { value: 'open', label: 'Open evaluation' }]} value={t?.envelope_mode} onChange={(v) => set({ envelope_mode: v })} /></Choice>
        <View style={{ gap: 6 }}><Lbl>Openers needed (quorum)</Lbl><Counter value={t?.quorum ?? 1} onChange={(v) => set({ quorum: v })} min={1} max={10} /></View>
        <View style={{ gap: 6 }}><Lbl>Standstill before suppliers can accept an award (days)</Lbl><Counter value={t?.standstill_days ?? 0} onChange={(v) => set({ standstill_days: v })} min={0} max={60} /></View>
      </Panel>
      <Panel title="Budget">
        <Field label={`Budget (${t?.currency}, optional)`} value={t?.budget_minor != null ? fromMinor(t.budget_minor, t.currency) : ''} onChangeText={(v) => { const m = toMinor(v, t.currency); set({ budget_minor: v === '' ? null : m ?? t.budget_minor }); }} keyboardType="decimal-pad" />
        <Choice label="Show the budget to suppliers"><Chips options={[{ value: false, label: 'Keep it private' }, { value: true, label: 'Publish it' }]} value={!!t?.budget_public} onChange={(v) => set({ budget_public: v })} /></Choice>
        {t?.contract_type === 'framework' ? <Field label={`Framework ceiling (${t.currency})`} value={t.ceiling_minor != null ? fromMinor(t.ceiling_minor, t.currency) : ''} onChangeText={(v) => set({ ceiling_minor: toMinor(v, t.currency) })} keyboardType="decimal-pad" hint="A ceiling is not guaranteed spend. Call-offs can never exceed it." /> : null}
      </Panel>
      {t?.contract_type !== 'one_off' ? (
        <Panel title="Contract terms">
          <T size={13} color={c.mute}>Published with the tender and copied onto each order. They cannot change after approval except by reissuing the tender.</T>
          <View style={{ gap: 6 }}><Lbl>Renewal options</Lbl><Counter value={t?.renewal_options ?? 0} onChange={(v) => set({ renewal_options: v })} min={0} max={10} /></View>
          {(t?.renewal_options ?? 0) > 0 ? (
            <>
              <View style={{ gap: 6 }}><Lbl>Each renewal lasts (months)</Lbl><Counter value={t?.renewal_term_months ?? 6} onChange={(v) => set({ renewal_term_months: v })} min={1} max={60} /></View>
              {t?.contract_type === 'framework' ? <Field label={`Spend ceiling added by each renewal (${t.currency}, optional)`} value={t.renewal_ceiling_minor != null ? fromMinor(t.renewal_ceiling_minor, t.currency) : ''} onChangeText={(v) => set({ renewal_ceiling_minor: v === '' ? null : toMinor(v, t.currency) })} keyboardType="decimal-pad" hint="Renewing never adds spend beyond what is published here." /> : null}
            </>
          ) : null}
          <View style={{ gap: 6 }}><Lbl>Notice period (days)</Lbl><Counter value={t?.notice_days ?? 0} onChange={(v) => set({ notice_days: v })} min={0} max={365} /><T size={12} color={c.mute}>Renewals must be exercised before it begins, and a notice of termination or non-renewal takes effect after it.</T></View>
        </Panel>
      ) : null}
      <Panel title="Milestones" right={<Btn small title="Add milestone" color={c.violet} onPress={() => set({ milestones: [...(t?.milestones ?? []), { name: '', due_on: null }] })} accessibilityLabel="Add a contract milestone" />}>
        <T size={13} color={c.mute}>Dates the contract commits to inside the preparation-to-teardown window. They are records on the order, not payment triggers.</T>
        {(t?.milestones ?? []).length === 0 ? <T size={13} color={c.mute}>No milestones.</T> : null}
        {(t?.milestones ?? []).map((m, i) => (
          <View key={i} style={{ gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12 }}>
            <Row2>
              <Field label="Milestone" value={m.name} onChangeText={(v) => set({ milestones: t.milestones.map((x, j) => (j === i ? { ...x, name: v } : x)) })} accessibilityLabel={`Milestone ${i + 1} name`} />
              <DateField label="Due" value={m.due_on ? String(m.due_on).slice(0, 10) : null} min={(t?.prep_start ?? t?.service_start) ? String(t.prep_start ?? t.service_start).slice(0, 10) : undefined} max={(t?.teardown_end ?? t?.service_end) ? String(t.teardown_end ?? t.service_end).slice(0, 10) : undefined} onChange={(v) => set({ milestones: t.milestones.map((x, j) => (j === i ? { ...x, due_on: v } : x)) })} />
            </Row2>
            <Btn small title="Remove" color={c.paper} ink={c.ink} onPress={() => set({ milestones: t.milestones.filter((_, j) => j !== i) })} accessibilityLabel={`Remove milestone ${i + 1}`} />
          </View>
        ))}
      </Panel>
      <Panel title="If a winning supplier declines or does not respond">
        <Choice label="Reserve bidders" hint="Published with the tender. Offering a lot to a reserve bidder is never automatic: it needs a new scenario, recommendation and approval.">
          <Chips options={[{ value: 'none', label: 'Do not offer it to anyone else' }, { value: 'next_ranked', label: 'Offer it to the next ranked bidder' }]} value={t?.reserve_policy ?? 'none'} onChange={(v) => set({ reserve_policy: v })} />
        </Choice>
      </Panel>
      <Panel title="Rules for suppliers">
        <Choice label="Revisions before the deadline"><Chips options={[{ value: true, label: 'Allowed' }, { value: false, label: 'Not allowed' }]} value={!!t?.allow_revision} onChange={(v) => set({ allow_revision: v })} /></Choice>
        <Choice label="Withdrawal before the deadline"><Chips options={[{ value: true, label: 'Allowed' }, { value: false, label: 'Not allowed' }]} value={!!t?.allow_withdrawal} onChange={(v) => set({ allow_withdrawal: v })} /></Choice>
        <Choice label="Alternative proposals"><Chips options={[{ value: false, label: 'Not allowed' }, { value: true, label: 'Allowed' }]} value={!!t?.allow_alternatives} onChange={(v) => set({ allow_alternatives: v })} /></Choice>
      </Panel>
      <Panel title="What suppliers are told afterwards">
        <T size={13} color={c.mute}>By default a supplier sees only its own scores and outcome. Turn these on only if your published policy discloses them.</T>
        {[['rank', 'Show each supplier its own rank'], ['bidder_count', 'Show the number of bidders'], ['award_public', 'Publish the winners and lots']].map(([k, label]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><T size={13} style={{ flex: 1, minWidth: 200 }}>{label}</T><Chips options={[{ value: false, label: 'No' }, { value: true, label: 'Yes' }]} value={!!t?.disclosure?.[k]} onChange={(v) => set({ disclosure: { ...(t.disclosure ?? {}), [k]: v } })} /></View>)}
      </Panel>
    </>
  );

  const review = (
    <>
      <Panel title="Checks" right={<Btn small title="Run checks" color={c.violet} onPress={async () => { if (await save()) { try { setIssues(await api.post(`/rfps/${id}/validate`)); } catch (e) { toast(explain(e)); } } }} />}>
        {issues ? <Checks items={issues.issues.map((x) => ({ key: x.field + x.message, state: x.severity === 'error' ? 'bad' : 'warn', title: x.message, detail: x.field }))} empty="Everything checks out." /> : <T size={13} color={c.mute}>Run the checks to see what must be fixed before approval.</T>}
        {issues?.ok ? <Status tone="ok" label="Ready for approval" /> : issues ? <Status tone="bad" label="Fix the errors first" /> : null}
      </Panel>
      <Panel title="Preview as a supplier"><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{['public', 'restricted', 'supplier'].map((v) => <Btn key={v} small color={c.violet} title={nice(v)} onPress={async () => { try { setPreview(await api.get(`/rfps/${id}/preview`, { view: v })); } catch (e) { toast(explain(e)); } }} />)}</View></Panel>
      <Panel title="Send for approval">
        <T size={13} color={c.mute}>Publication needs a human approval from someone other than you. Larger budgets need more approvals. The rubric freezes at approval.</T>
        {t?.status === 'draft' ? <Btn title="Request approval" onPress={async () => { if (!(await save())) return; try { await api.post(`/rfps/${id}/request-approval`); toast('Sent for approval'); push('TenderConsole', { id }); } catch (e) { if (e.details?.issues) setIssues({ ok: false, issues: e.details.issues }); toast(explain(e)); } }} /> : <Notice tone="info">This tender is {t?.status}. Open the console to continue.</Notice>}
        <Btn small title="Open the console" color={c.violet} onPress={() => push('TenderConsole', { id })} />
      </Panel>
    </>
  );

  const docsPanel = id ? <PackDocuments id={id} toast={toast} /> : null;
  const bodies = [ctx, <>{docsPanel}{lotEditor}</>, sched, elig, quest, evalStep, terms, review];
  return (
    <Screen wide>
      <Head eyebrow={t ? `${t.ref} · ${t.kind.toUpperCase()}` : 'NEW TENDER'} title={t?.title ?? (form.title.trim() || 'Create an RFP')} sub={t ? `Draft saved to ${t.ref}. Each step saves when you continue.` : 'A guided flow from context to approval.'} right={t ? <StageTag stage={t.status === 'draft' ? 'draft' : t.status} /> : null} />
      <View style={{ marginTop: 14, flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => <Btn key={s} small title={`${i + 1}  ${s}`} color={i === step ? c.ink : i < step ? c.lime : c.violet} onPress={() => (i === 0 || t ? setStep(i) : toast('Create the draft first'))} accessibilityLabel={`Step ${i + 1}: ${s}`} />)}
      </View>
      {locked ? <View style={{ marginTop: 12 }}><Notice tone="info">This tender is {t.status}. It can no longer be edited; use an addendum from the console.</Notice></View> : null}
      <View style={{ marginTop: 14, gap: 14 }}>{bodies[step]}</View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        {step > 0 ? <Btn title="Back" color={c.violet} onPress={() => setStep(step - 1)} /> : null}
        {step === 0 && !t ? <Btn title="Create draft and continue" loading={busy} disabled={busy || form.title.trim().length < 3} onPress={create} /> : step < 7 ? <Btn title="Save and continue" loading={busy} disabled={busy || locked} onPress={next} /> : null}
        {t ? <Btn title="Save draft" color={c.violet} disabled={busy || locked} onPress={async () => { setBusy(true); if (await save()) toast('Draft saved'); setBusy(false); }} /> : null}
      </View>
      <Sheet visible={!!preview && preview !== 'library'} onClose={() => setPreview(null)} title={`Preview · ${preview?.view ?? ''}`}>
        {preview?.card ? <KV items={[['Reference', preview.card.ref], ['Title', preview.card.title], ['Issuer', preview.card.issuer.name], ['Category', preview.card.category], ['Closes', when(preview.card.closes_at, preview.card.timezone)], ['Budget', preview.card.budget ? amount(preview.card.budget.amount_minor, preview.card.budget.currency) : 'Not published'], ['Who can take part', nice(preview.card.participation)]]} /> : null}
        {preview?.notice ? <><T size={13}>{preview.notice.scope}</T><T size={12} color={c.mute}>{preview.notice.lots.length} lot(s), {preview.notice.questions.length} question(s)</T></> : null}
        {preview?.note ? <T size={12} color={c.mute}>{preview.note}</T> : null}
      </Sheet>
      <Sheet visible={preview === 'library'} onClose={() => setPreview(null)} title="Question library">
        {(sets.data ?? []).map((s) => <Card key={s.id} onPress={() => { const add = (s.body.questions ?? []).filter((q) => !qs.some((x) => x.key === q.key)); setQs([...qs, ...add]); setPreview(null); toast(`${add.length} question(s) added`); }}><T weight="700">{s.name}</T><T size={12} color={c.mute}>{(s.body.questions ?? []).length} questions · v{s.version}</T></Card>)}
      </Sheet>
    </Screen>
  );
}

function OptionsEditor({ label, value, onChange }) {
  const [x, setX] = useState('');
  return (
    <View style={{ gap: 6 }}><Lbl>{label}</Lbl>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((o) => <Btn key={o} small color={c.violet} title={`${o}  ✕`} onPress={() => onChange(value.filter((y) => y !== o))} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={x} onChangeText={setX} placeholder="Add one and tap Add" /></View><Btn small title="Add" disabled={!x.trim() || value.includes(x.trim())} onPress={() => { onChange([...value, x.trim()]); setX(''); }} /></View>
    </View>
  );
}

/** Dated exchange rates for comparing foreign-currency bids. Comparison only: contract amounts are never rewritten from these. */
function FxEditor({ fx, cur, onChange }) {
  const [code, setCode] = useState(null), [rate, setRate] = useState('');
  const rates = fx?.rates ?? {};
  const add = () => { if (!code || !/^\d+(\.\d{1,8})?$/.test(rate)) return; onChange({ date: fx?.date ?? new Date().toISOString().slice(0, 10), base: cur, rates: { [cur]: '1', ...rates, [code]: rate } }); setCode(null); setRate(''); };
  return (
    <View style={{ gap: 8 }}>
      <Lbl>Exchange rates for foreign-currency bids (optional)</Lbl>
      {Object.entries(rates).filter(([k]) => k !== cur).map(([k, v]) => <View key={k} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={13} style={{ flex: 1 }}>1 {k} = {v} {cur}</T><Btn small color={c.violet} title="Remove" onPress={() => { const r = { ...rates }; delete r[k]; onChange(Object.keys(r).filter((x) => x !== cur).length ? { ...fx, rates: r } : null); }} /></View>)}
      <CurrencyDropdown label="Currency" value={code} onChange={setCode} suggest={false} />
      <Field label={`Value of 1 unit in ${cur}`} value={rate} onChangeText={(x) => setRate(x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" />
      <DateField label="Rates dated" value={fx?.date ?? null} onChange={(d) => onChange({ date: d, base: cur, rates: { [cur]: '1', ...rates } })} optional />
      <Btn small title="Add rate" color={c.violet} disabled={!code || !rate} onPress={add} style={{ alignSelf: 'flex-start' }} />
      <T size={12} color={c.mute}>Used only to compare bids on one basis. Original bid currencies and contract amounts are never rewritten from these rates.</T>
    </View>
  );
}
