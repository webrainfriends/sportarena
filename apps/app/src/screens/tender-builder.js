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
import { t, tEnum } from '../i18n';
import { CATEGORIES } from './tender-zone';
import { Checks, Chips, DataTable, KV, Notice, Panel, Split, StageTag, Status, amount, blobOf, day, fromMinor, nice, openStored, toMinor, wallOf, when, zonedIso, openDocument } from '../tender-ui';

const STEPS = [t('tb.step_context'), t('tb.step_scope'), t('tb.step_schedule'), t('tb.step_elig'), t('tb.step_quest'), t('tb.step_eval'), t('tb.step_terms'), t('access.review')];
// stored values stay English; only the label is translated
const UNITS = [['hour', t('tb.u_hour')], ['shift', t('tb.u_shift')], ['day', t('tb.u_day')], ['person-hour', t('tb.u_person_hour')], ['person-shift', t('tb.u_person_shift')], ['visit', t('tb.u_visit')], ['area', t('tb.u_area')], ['job', t('tb.u_job')], ['trip', t('tb.u_trip')], ['room-night', t('tb.u_room_night')], ['site', t('tb.u_site')], ['month', t('tb.u_month')]].map(([value, label]) => ({ value, label }));
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Colombo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'Australia/Sydney', 'UTC'];
const CRED = ['insurance', 'safeguarding', 'safety_certificate', 'trade_licence', 'tax_registration', 'qualification'];
const QTYPES = [['text', t('tb.q_text')], ['yes_no', t('tb.q_yes_no')], ['single_select', t('tb.q_single')], ['multi_select', t('tb.q_multi')], ['number', t('cs.number')], ['date', t('cs.date')], ['currency', t('tb.q_currency')], ['table', t('tb.q_table')], ['attachment', t('tb.q_attachment')]];
const SECTIONS = ['qualification', 'technical', 'commercial', 'legal'].map((v) => [v, tEnum(v)]);
const CONTRACTS = [{ value: 'one_off', label: t('tb.ct_one_off') }, { value: 'fixed_term', label: t('tb.ct_fixed_term') }, { value: 'recurring', label: t('tb.ct_recurring') }, { value: 'framework', label: t('tb.ct_framework') }];
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
      {w.date ? <TimeField label={t('rd.time')} optional step={15} value={w.time} onChange={(tm) => set(w.date, tm)} hint={value ? t('tb.when_hint', { tz: tz.replace(/_/g, ' '), utc: new Date(value).toISOString().slice(11, 16) }) : undefined} /> : null}
    </View>
  );
}

const defaultRubric = () => ({ weights: { technical: 60, commercial: 40 }, technical_pass_mark: 50, min_reviewers: 1, commercial_method: 'lowest_ratio', na_policy: 'exclude_and_reweight', tie_break: ['commercial_score', 'technical_score', 'earlier_submission'], criteria: [] });


const AUDIENCES = [{ value: 'public', label: t('tb.aud_public') }, { value: 'participants', label: t('tb.aud_participants') }, { value: 'buyer', label: t('tb.aud_buyer') }];

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
      toast(replace ? t('tb.doc_replaced') : t('tb.doc_added'));
      docs.reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(null); }
  };
  const act = async (fn, msg) => { try { await fn(); toast(msg); docs.reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Panel title={t('tb.docs_title')} right={docs.data ? <Status tone="neutral" label={current.length === 1 ? t('tb.docs_one', { n: current.length }) : t('tb.docs_many', { n: current.length })} /> : null}>
      <T size={13} color={c.mute}>{t('tb.docs_intro')}</T>
      {docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : null}
      {current.map((d) => (
        <View key={d.id} style={{ gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T size={14} weight="700" style={{ flex: 1, minWidth: 180 }}>{d.name}</T>
            <Status tone="neutral" label={AUDIENCES.find((a) => a.value === d.audience)?.label ?? d.audience} />
            {d.visit_pack ? <Status tone="warn" label={t('tb.site_visit_doc')} /> : null}
            {version(d) > 1 ? <Status tone="info" label={t('tb.version_n', { n: version(d) })} /> : null}
          </View>
          <T size={12} color={c.mute}>{t('tb.doc_meta', { kb: Math.max(1, Math.round(d.bytes / 1024)), day: day(d.created_at) })}{d.added_by ? ` ${t('tb.by_user', { name: d.added_by })}` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Btn small title={t('enum.open')} color={c.violet} onPress={() => openStored(`/tender-files/${d.id}`, d.name).catch((e) => toast(explain(e)))} accessibilityLabel={t('tb.a11y_open_doc', { name: d.name })} />
            {editable ? <Btn small title={busy === d.id ? t('tb.uploading') : t('tb.amend')} color={c.paper} ink={c.ink} disabled={!!busy} onPress={() => pick(d)} accessibilityLabel={t('tb.a11y_replace_doc', { name: d.name })} /> : null}
            {editable && d.audience === 'participants' ? <Btn small title={d.visit_pack ? t('tb.not_visit') : t('tb.make_visit')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/rfps/${id}/visit-documents`, { file_id: d.id, visit_pack: !d.visit_pack }), d.visit_pack ? t('tb.visit_off') : t('tb.visit_on'))} /> : null}
            {editable ? <Btn small title={t('access.remove')} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/rfps/${id}/documents/${d.id}/archive`), t('tb.removed'))} accessibilityLabel={t('tb.a11y_remove_doc', { name: d.name })} /> : null}
          </View>
        </View>
      ))}
      {!current.length && docs.data ? <T size={13} color={c.mute}>{t('tb.no_docs')}</T> : null}
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: c.line, paddingTop: 12 }}>
        <Lbl>{t('tb.add_doc_for')}</Lbl>
        <Chips options={AUDIENCES} value={aud} onChange={(v) => { setAud(v); if (v !== 'participants') setVisit(false); }} />
        {aud === 'participants' ? <Chips options={[{ value: false, label: t('tb.ordinary_doc') }, { value: true, label: t('tb.site_visit_doc') }]} value={visit} onChange={setVisit} /> : null}
        <Btn title={busy === 'new' ? t('tb.uploading') : t('tb.upload_doc')} disabled={!!busy} onPress={() => pick(null)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={t('tb.a11y_upload')} />
        {!editable && docs.data ? <Notice tone="info">{t('tb.not_draft_notice')}</Notice> : null}
      </View>
      {old.length ? <><Btn small title={history ? t('tb.hide_earlier') : t('tb.earlier_n', { n: old.length })} color={c.paper} ink={c.ink} onPress={() => setHistory(!history)} style={{ alignSelf: 'flex-start' }} />{history ? old.map((d) => <T key={d.id} size={12} color={c.mute}>{t('tb.old_line', { name: d.name, day: day(d.created_at), archived: day(d.archived_at) })}</T>) : null}</> : null}
    </Panel>
  );
}

export function TenderBuilder({ id: openId, event_id, organisation_id, venue_id }) {
  const { toast } = useSession();
  const { push, back } = useNav();
  const [id, setId] = useState(openId ?? null);
  const [step, setStep] = useState(0);
  const [tn, setT] = useState(null);
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
  useEffect(() => { const d = loaded.data; if (d && !tn) { setT(d); setLots(d.lots.map((l) => ({ ...l, qty: Number(l.qty) }))); setQs(d.questions); setRubric(d.rubric ?? defaultRubric()); } }, [loaded.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const tz = tn?.timezone ?? form.timezone;
  const set = (patch) => setT((x) => ({ ...x, ...patch }));
  const locked = tn && tn.status !== 'draft';

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post('/rfps', { kind: form.kind, title: form.title.trim(), category: form.category, organisation_id: form.organisation_id ?? undefined, event_id: form.event_id ?? undefined, venue_id: form.venue_id ?? undefined, template_id: tplId ?? undefined, sport: form.sport || undefined, currency: form.currency, contract_type: form.contract_type, timezone: form.timezone });
      setId(r.id); setT(null); setStep(1); toast(t('tb.draft_created'));
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const save = async (extra = {}) => {
    const body = { row_version: tn.row_version, title: tn.title, objective: tn.objective ?? null, scope: tn.scope ?? null, inclusions: tn.inclusions ?? null, exclusions: tn.exclusions ?? null, category: tn.category, location: tn.location ?? null, contract_type: tn.contract_type,
      prep_start: tn.prep_start ? String(tn.prep_start).slice(0, 10) : null, service_start: tn.service_start ? String(tn.service_start).slice(0, 10) : null, service_end: tn.service_end ? String(tn.service_end).slice(0, 10) : null, teardown_end: tn.teardown_end ? String(tn.teardown_end).slice(0, 10) : null,
      currency: tn.currency, budget_minor: tn.budget_minor ?? null, budget_public: !!tn.budget_public, ceiling_minor: tn.ceiling_minor ?? null, cost_basis: tn.cost_basis, publication: tn.publication, envelope_mode: tn.envelope_mode, timezone: tn.timezone,
      publish_at: tn.publish_at ?? null, clarification_deadline: tn.clarification_deadline ?? null, site_visit_at: tn.site_visit_at ?? null, site_visit_mandatory: !!tn.site_visit_mandatory, closes_at: tn.closes_at ?? null, opens_at: tn.opens_at ?? null, evaluation_due: tn.evaluation_due ?? null, award_target: tn.award_target ?? null,
      standstill_days: tn.standstill_days ?? 0, allow_revision: !!tn.allow_revision, allow_withdrawal: !!tn.allow_withdrawal, allow_alternatives: !!tn.allow_alternatives, quorum: tn.quorum ?? 1, required_credentials: tn.required_credentials ?? [], disclosure: tn.disclosure ?? { rank: false, bidder_count: false, award_public: false }, fx: tn.fx ?? null, sites: tn.sites ?? [],
      renewal_options: tn.renewal_options ?? 0, renewal_term_months: tn.renewal_options > 0 ? (tn.renewal_term_months ?? null) : null, renewal_ceiling_minor: tn.renewal_options > 0 ? (tn.renewal_ceiling_minor ?? null) : null, notice_days: tn.notice_days ?? 0,
      milestones: (tn.milestones ?? []).filter((m) => m.name?.trim() && m.due_on).map((m) => ({ name: m.name.trim(), due_on: String(m.due_on).slice(0, 10), description: m.description || undefined })), reserve_policy: tn.reserve_policy ?? 'none',
      lots: lots.map((l) => ({ code: l.code, title: l.title, description: l.description || undefined, qty: Number(l.qty), unit: l.unit || undefined, supply_kind: l.supply_kind || 'service', estimate_minor: l.estimate_minor ?? undefined, allow_partial: l.allow_partial !== false, bundle_with: l.bundle_with ?? [] })),
      questions: qs.map((q) => ({ key: q.key, section: q.section, prompt: q.prompt, type: q.type, options: q.options ?? undefined, unit: q.unit ?? undefined, required: q.required !== false, pass_fail: !!q.pass_fail, pass_value: q.pass_fail ? q.pass_value : undefined, evidence_required: !!q.evidence_required, lot_code: q.lot_code ?? undefined })),
      rubric: tn.kind === 'rfi' ? null : (rubric.criteria.length || rubric.weights ? rubric : null), ...extra };
    try { const r = await api.patch(`/rfps/${id}`, body); setT((x) => ({ ...x, row_version: r.row_version })); return true; } catch (e) { toast(explain(e)); if (e.status === 409) { setT(null); loaded.reload(); } return false; }
  };
  const next = async () => { if (!locked && step > 0) { setBusy(true); const ok = await save(); setBusy(false); if (!ok) return; } if (step === 7) return; setStep(step + 1); };

  if (loaded.error) return <Screen><ErrorBox error={loaded.error} onRetry={loaded.reload} /></Screen>;
  if (id && !tn) return <Screen><Loading /></Screen>;

  // ---------------------------------------------------------------- step bodies
  const ctx = (
    <>
      <Panel title={t('tb.ctx_title')}>
        <Choice label={t('tb.proc_type')} hint={{ rfi: t('tb.hint_rfi'), rfp: t('tb.hint_rfp'), rfq: t('tb.hint_rfq') }[form.kind]}><Chips options={[{ value: 'rfp', label: 'RFP' }, { value: 'rfq', label: 'RFQ' }, { value: 'rfi', label: 'RFI' }]} value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} /></Choice>
        <Field label={t('cs.title_label')} value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder={t('tb.title_ph')} />
        <Choice label={t('cs.category')}><Chips options={CATEGORIES} value={form.category} onChange={(v) => setForm({ ...form, category: v })} /></Choice>
        <SportSelect label={t('tb.sport_opt')} optional allLabel={t('tb.any_sport')} value={form.sport} onChange={(v) => setForm({ ...form, sport: v })} />
      </Panel>
      <Panel title={t('tb.who_buying')}>
        <EntityPicker label={t('tb.acting_org')} optional noun="organisation" options={(orgs.data ?? []).filter((o) => o.status !== 'archived').map((o) => ({ id: o.id, label: o.name, sub: o.kind }))} value={form.organisation_id ? [{ id: form.organisation_id, label: (orgs.data ?? []).find((o) => o.id === form.organisation_id)?.name ?? t('tb.org_fallback') }] : []} onChange={(l) => setForm({ ...form, organisation_id: l[0]?.id ?? null })} />
        <EntityPicker label={t('tb.event_opt')} optional noun="event" options={(events.data ?? []).map((e) => ({ id: e.id, label: e.name, sub: `${e.starts_on ?? ''}` }))} value={form.event_id ? [{ id: form.event_id, label: (events.data ?? []).find((e) => e.id === form.event_id)?.name ?? t('hub.event') }] : []} onChange={(l) => setForm({ ...form, event_id: l[0]?.id ?? null })} />
        <EntityPicker label={t('tb.venue_opt')} optional noun="venue" options={(venues.data ?? []).filter((v) => v.role !== 'staff').map((v) => ({ id: v.id, label: v.name, sub: [v.city, v.role].filter(Boolean).join(' · ') }))} value={form.venue_id ? [{ id: form.venue_id, label: (venues.data ?? []).find((v) => v.id === form.venue_id)?.name ?? t('tb.venue_fallback') }] : []} onChange={(l) => setForm({ ...form, venue_id: l[0]?.id ?? null })} />
        <T size={12} color={c.mute}>{t('tb.buying_note')}</T>
      </Panel>
      <Panel title={t('tb.settings')}>
        <CurrencyDropdown label={t('spl.currency')} value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
        <Choice label={t('tb.time_zone')} hint={t('tb.tz_hint')}><Chips options={ZONES.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} /></Choice>
        <Choice label={t('tb.contract')}><Chips options={CONTRACTS} value={form.contract_type} onChange={(v) => setForm({ ...form, contract_type: v })} /></Choice>
        {(tpls.data ?? []).length ? <Choice label={t('tb.template_opt')} hint={t('tb.template_hint')}><Chips options={tpls.data.map((x) => ({ value: x.id, label: `${x.name} v${x.version}` }))} value={tplId} onChange={(v) => setTplId(tplId === v ? null : v)} /></Choice> : null}
      </Panel>
    </>
  );

  const lotEditor = (
    <>
      <Panel title={t('tb.scope_work')}>
        <Field label={t('tb.objective')} multiline value={tn?.objective ?? ''} onChangeText={(v) => set({ objective: v })} hint={t('tb.objective_hint')} />
        <Field label={t('tb.scope')} multiline value={tn?.scope ?? ''} onChangeText={(v) => set({ scope: v })} hint={t('tb.scope_hint')} />
        <Row2><Field label={t('tb.included')} multiline value={tn?.inclusions ?? ''} onChangeText={(v) => set({ inclusions: v })} /><Field label={t('tb.not_included')} multiline value={tn?.exclusions ?? ''} onChangeText={(v) => set({ exclusions: v })} /></Row2>
        <Choice label={t('tb.sites')}><EntityPicker label={t('tb.sites_venues')} optional noun="venue" multi options={(venues.data ?? []).map((v) => ({ id: v.id, label: v.name, sub: v.city }))} value={(tn?.sites ?? []).filter((s) => s.venue_id).map((s) => ({ id: s.venue_id, label: s.label }))} onChange={(l) => set({ sites: l.map((x) => ({ venue_id: x.id, label: x.label })) })} /></Choice>
        <Field label={t('tb.location_opt')} value={tn?.location ?? ''} onChangeText={(v) => set({ location: v })} />
        <Choice label={t('tb.contract')}><Chips options={CONTRACTS} value={tn?.contract_type} onChange={(v) => set({ contract_type: v })} /></Choice>
      </Panel>
      <Panel title={t('tb.lots_title')} right={<Btn small title={t('tb.add_lot')} onPress={() => setLots([...lots, { code: `L${lots.length + 1}`, title: '', qty: 1, unit: 'job', allow_partial: true, bundle_with: [] }])} />}>
        {!lots.length ? <Empty emoji="🧱" title={t('tb.no_lots')} sub={t('tb.no_lots_sub')} /> : lots.map((l, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><T weight="700">{t('tb.lot_n', { code: l.code })}</T><Btn small title={t('access.remove')} color={c.violet} onPress={() => setLots(lots.filter((_, j) => j !== i))} /></View>
            <Field label={t('tb.lot_what')} value={l.title} onChangeText={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
            <Row2><View style={{ gap: 6 }}><Lbl>{t('hub.f_quantity')}</Lbl><Counter value={Number(l.qty)} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, qty: v } : x)))} min={1} max={1000000} step={l.qty >= 100 ? 10 : 1} /></View>
              <Choice label={t('tb.unit')}><Chips options={UNITS} value={l.unit} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, unit: v } : x)))} /></Choice></Row2>
            <Choice label={t('tb.supply')}><Chips options={[{ value: 'service', label: t('tb.s_service') }, { value: 'goods', label: t('tb.s_goods') }]} value={l.supply_kind ?? 'service'} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, supply_kind: v } : x)))} /></Choice>
            <Field label={t('tb.estimate', { cur: tn?.currency ?? form.currency })} value={l.estimate_minor != null ? fromMinor(l.estimate_minor, tn.currency) : ''} onChangeText={(v) => { const m = toMinor(v, tn.currency); setLots(lots.map((x, j) => (j === i ? { ...x, estimate_minor: m ?? undefined } : x))); }} keyboardType="decimal-pad" />
            <Choice label={t('tb.partial')} hint={t('tb.partial_hint')}><Chips options={[{ value: true, label: t('tb.allowed') }, { value: false, label: t('tb.full_only') }]} value={l.allow_partial !== false} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, allow_partial: v } : x)))} /></Choice>
            {lots.length > 1 ? <Choice label={t('tb.bid_with')}><Chips multi options={lots.filter((x) => x.code !== l.code).map((x) => ({ value: x.code, label: `${x.code} ${x.title}`.trim() }))} value={l.bundle_with ?? []} onChange={(v) => setLots(lots.map((x, j) => (j === i ? { ...x, bundle_with: v } : x)))} /></Choice> : null}
          </View></Card>
        ))}
      </Panel>
    </>
  );

  const sched = (
    <>
      <Panel title={t('tb.key_dates')}><Row2>
        <When label={t('tb.d_publish')} value={tn?.publish_at} tz={tz} onChange={(v) => set({ publish_at: v })} />
        <When label={t('tb.d_clarif')} value={tn?.clarification_deadline} tz={tz} onChange={(v) => set({ clarification_deadline: v })} />
        <When label={t('tb.d_visit')} value={tn?.site_visit_at} tz={tz} onChange={(v) => set({ site_visit_at: v })} />
        <When label={t('tb.d_closes')} value={tn?.closes_at} tz={tz} optional={false} onChange={(v) => set({ closes_at: v })} />
        <When label={t('tb.d_opens')} value={tn?.opens_at} tz={tz} onChange={(v) => set({ opens_at: v })} />
        <When label={t('tb.d_eval')} value={tn?.evaluation_due} tz={tz} onChange={(v) => set({ evaluation_due: v })} />
        <When label={t('tb.d_award')} value={tn?.award_target} tz={tz} onChange={(v) => set({ award_target: v })} />
      </Row2>
        <Choice label={t('tb.visit_attend')} hint={t('tb.visit_attend_hint')}><Chips options={[{ value: false, label: t('tb.optional') }, { value: true, label: t('tb.mandatory') }]} value={!!tn?.site_visit_mandatory} onChange={(v) => set({ site_visit_mandatory: v })} /></Choice>
        {tn?.closes_at ? <Notice tone="info">{t('tb.closes_notice', { when: when(tn.closes_at, tz) })}</Notice> : null}
      </Panel>
      <Panel title={t('tb.service_period')}>
        <Row2><DateField label={t('tb.d_prep')} optional value={tn?.prep_start ? String(tn.prep_start).slice(0, 10) : null} onChange={(v) => set({ prep_start: v })} /><DateField label={t('tb.d_service_start')} optional value={tn?.service_start ? String(tn.service_start).slice(0, 10) : null} onChange={(v) => set({ service_start: v })} /><DateField label={t('tb.d_service_end')} optional value={tn?.service_end ? String(tn.service_end).slice(0, 10) : null} onChange={(v) => set({ service_end: v })} /><DateField label={t('tb.d_teardown')} optional value={tn?.teardown_end ? String(tn.teardown_end).slice(0, 10) : null} onChange={(v) => set({ teardown_end: v })} /></Row2>
        <T size={12} color={c.mute}>{t('tb.period_note')}</T>
      </Panel>
    </>
  );

  const elig = (
    <Panel title={t('tb.elig_title')}>
      <T size={13} color={c.mute}>{t('tb.elig_note')}</T>
      <Chips multi options={CRED.map((k) => ({ value: k, label: tEnum(k) }))} value={(tn?.required_credentials ?? []).map((r) => r.kind)} onChange={(v) => set({ required_credentials: v.map((k) => (tn.required_credentials ?? []).find((r) => r.kind === k) ?? { kind: k, title: nice(k)[0].toUpperCase() + nice(k).slice(1), verified_required: false }) })} />
      {(tn?.required_credentials ?? []).map((r) => <View key={r.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><T size={13} weight="700" style={{ minWidth: 150 }}>{r.title}</T><Chips options={[{ value: false, label: t('tb.declared_ok') }, { value: true, label: t('tb.must_verified') }]} value={!!r.verified_required} onChange={(v) => set({ required_credentials: tn.required_credentials.map((x) => (x.kind === r.kind ? { ...x, verified_required: v } : x)) })} /></View>)}
      <T size={12} color={c.mute}>{t('tb.badge_note')}</T>
    </Panel>
  );

  const addQ = () => setQs([...qs, { key: `q_${qs.length + 1}`, section: 'technical', prompt: '', type: 'text', required: true }]);
  const quest = (
    <>
      <Panel title={t('tb.questionnaire')} right={<View style={{ flexDirection: 'row', gap: 6 }}>{(sets.data ?? []).length ? <Btn small title={t('tb.from_library')} color={c.violet} onPress={() => setPreview('library')} /> : null}<Btn small title={t('tb.add_question')} onPress={addQ} /></View>}>
        {!qs.length ? <Empty emoji="❓" title={t('tb.no_questions')} sub={t('tb.no_questions_sub')} /> : qs.map((q, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Status tone="info" label={tEnum(q.section)} /><Btn small title={t('access.remove')} color={c.violet} onPress={() => setQs(qs.filter((_, j) => j !== i))} /></View>
            <Field label={t('tb.question')} multiline value={q.prompt} onChangeText={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, prompt: v, key: x.key.startsWith('q_') ? slug(v) || x.key : x.key } : x)))} />
            <Choice label={t('tb.section')}><Chips options={SECTIONS.map(([value, label]) => ({ value, label }))} value={q.section} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, section: v } : x)))} /></Choice>
            <Choice label={t('tb.answer_type')}><Chips options={QTYPES.map(([value, label]) => ({ value, label }))} value={q.type} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, type: v, pass_fail: false, options: ['single_select', 'multi_select', 'table'].includes(v) ? x.options ?? [] : undefined } : x)))} /></Choice>
            {['single_select', 'multi_select', 'table'].includes(q.type) ? <OptionsEditor label={q.type === 'table' ? t('tb.columns') : t('tb.options')} value={q.options ?? []} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, options: v } : x)))} /> : null}
            <Row2><Choice label={t('tb.required')}><Chips options={[{ value: true, label: t('tb.yes') }, { value: false, label: t('tb.optional') }]} value={q.required !== false} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, required: v } : x)))} /></Choice><Choice label={t('tb.evidence')}><Chips options={[{ value: false, label: t('tb.not_needed') }, { value: true, label: t('tb.file_required') }]} value={!!q.evidence_required} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, evidence_required: v } : x)))} /></Choice></Row2>
            {['yes_no', 'single_select'].includes(q.type) ? <Choice label={t('tb.gate')} hint={t('tb.gate_hint')}><Chips options={[{ value: false, label: t('tb.scored_info') }, { value: true, label: t('tb.pass_fail') }]} value={!!q.pass_fail} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_fail: v, pass_value: v ? (q.type === 'yes_no' ? true : (q.options ?? [])[0]) : undefined } : x)))} />
              {q.pass_fail ? <View style={{ gap: 6, marginTop: 6 }}><Lbl>{t('tb.passing_answer')}</Lbl>{q.type === 'yes_no' ? <Chips options={[{ value: true, label: t('tb.yes') }, { value: false, label: t('tb.no') }]} value={q.pass_value} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_value: v } : x)))} /> : <Chips options={q.options ?? []} value={q.pass_value} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, pass_value: v } : x)))} />}</View> : null}</Choice> : null}
            {lots.length > 1 ? <Choice label={t('tb.applies_lot')}><Chips options={lots.map((l) => ({ value: l.code, label: l.code }))} value={q.lot_code} onChange={(v) => setQs(qs.map((x, j) => (j === i ? { ...x, lot_code: q.lot_code === v ? undefined : v } : x)))} /></Choice> : null}
          </View></Card>
        ))}
      </Panel>
      <Panel title={t('tb.pricing')}>
        <T size={13} color={c.mute}>{t('tb.pricing_note')}</T>
        <Choice label={t('tb.compare_costs')} hint={t('tb.compare_hint')}><Chips options={[{ value: 'net', label: t('tb.net') }, { value: 'gross', label: t('tb.gross') }]} value={tn?.cost_basis} onChange={(v) => set({ cost_basis: v })} /></Choice>
        <FxEditor fx={tn?.fx} cur={tn?.currency} onChange={(v) => set({ fx: v })} />
      </Panel>
    </>
  );

  const rb = rubric;
  const critSum = rb.criteria.reduce((a, x) => a + Number(x.weight || 0), 0);
  const evalStep = tn?.kind === 'rfi' ? <Notice tone="info">{t('tb.rfi_notice')}</Notice> : (
    <>
      <Panel title={t('tb.how_winner')}>
        <T size={13} color={c.mute}>{t('tb.rubric_note')}</T>
        <Row2><View style={{ gap: 6 }}><Lbl>{t('tb.tech_weight')}</Lbl><Counter value={rb.weights.technical} onChange={(v) => setRubric({ ...rb, weights: { technical: v, commercial: 100 - v } })} min={0} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>{t('tb.comm_weight')}</Lbl><Counter value={rb.weights.commercial} onChange={(v) => setRubric({ ...rb, weights: { technical: 100 - v, commercial: v } })} min={0} max={100} step={5} /></View></Row2>
        <Row2><View style={{ gap: 6 }}><Lbl>{t('tb.tech_pass')}</Lbl><Counter value={rb.technical_pass_mark} onChange={(v) => setRubric({ ...rb, technical_pass_mark: v })} min={0} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>{t('tb.reviewers')}</Lbl><Counter value={rb.min_reviewers} onChange={(v) => setRubric({ ...rb, min_reviewers: v })} min={1} max={10} /></View></Row2>
        <Choice label={t('tb.tiebreak')} hint={t('tb.tiebreak_hint')}><Chips options={[{ value: 'commercial_score', label: t('tb.tb_commercial') }, { value: 'technical_score', label: t('tb.tb_technical') }, { value: 'earlier_submission', label: t('tb.tb_earlier') }]} multi value={rb.tie_break} onChange={(v) => setRubric({ ...rb, tie_break: v })} /></Choice>
      </Panel>
      <Panel title={t('tb.tech_criteria')} right={<Btn small title={t('tb.add_criterion')} onPress={() => setRubric({ ...rb, criteria: [...rb.criteria, { key: `criterion_${rb.criteria.length + 1}`, title: '', weight: Math.max(0, 100 - critSum), scale_min: 0, scale_max: 10, evidence_required: false }] })} />}>
        {rb.criteria.map((x, i) => (
          <Card key={i}><View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700" size={13}>{t('tb.criterion_n', { n: i + 1 })}</T><Btn small title={t('access.remove')} color={c.violet} onPress={() => setRubric({ ...rb, criteria: rb.criteria.filter((_, j) => j !== i) })} /></View>
            <Field label={t('access.name')} value={x.title} onChangeText={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, title: v, key: y.key.startsWith('criterion_') ? slug(v) : y.key } : y)) })} />
            <Row2><View style={{ gap: 6 }}><Lbl>{t('tb.weight')}</Lbl><Counter value={x.weight} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, weight: v } : y)) })} min={1} max={100} step={5} /></View><View style={{ gap: 6 }}><Lbl>{t('tb.top_score')}</Lbl><Counter value={x.scale_max} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, scale_max: v } : y)) })} min={1} max={100} /></View></Row2>
            <Row2><Choice label={t('tb.evidence')}><Chips options={[{ value: false, label: t('tb.ev_not_required') }, { value: true, label: t('tb.ev_lock') }]} value={!!x.evidence_required} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, evidence_required: v } : y)) })} /></Choice>
              <View style={{ gap: 6 }}><Lbl>{t('tb.min_mandatory')}</Lbl><Counter value={x.min_normalised ?? 0} onChange={(v) => setRubric({ ...rb, criteria: rb.criteria.map((y, j) => (j === i ? { ...y, min_normalised: v || undefined } : y)) })} min={0} max={100} step={5} /></View></Row2>
          </View></Card>
        ))}
        {rb.weights.technical > 0 ? <Notice tone={Math.abs(critSum - 100) < 1e-9 ? 'info' : 'warn'}>{Math.abs(critSum - 100) < 1e-9 ? t('tb.weights_ok') : t('tb.weights_bad', { sum: critSum })}</Notice> : null}
        <T size={12} color={c.mute}>{t('tb.comm_note')}</T>
      </Panel>
    </>
  );

  const terms = (
    <>
      <Panel title={t('tb.access_env')}>
        <Choice label={t('tb.who_part')} hint={t('tb.who_part_hint')}><Chips options={[{ value: 'public', label: t('tb.aud_public') }, { value: 'restricted', label: t('tb.pub_restricted') }, { value: 'invite_only', label: t('tb.pub_invite') }, { value: 'private', label: t('tb.pub_private') }]} value={tn?.publication} onChange={(v) => set({ publication: v })} /></Choice>
        <Choice label={t('tb.envelopes')} hint={t('tb.envelopes_hint')}><Chips options={[{ value: 'sealed_dual', label: t('tb.env_dual') }, { value: 'sealed_single', label: t('tb.env_single') }, { value: 'open', label: t('tb.env_open') }]} value={tn?.envelope_mode} onChange={(v) => set({ envelope_mode: v })} /></Choice>
        <View style={{ gap: 6 }}><Lbl>{t('tb.quorum')}</Lbl><Counter value={tn?.quorum ?? 1} onChange={(v) => set({ quorum: v })} min={1} max={10} /></View>
        <View style={{ gap: 6 }}><Lbl>{t('tb.standstill')}</Lbl><Counter value={tn?.standstill_days ?? 0} onChange={(v) => set({ standstill_days: v })} min={0} max={60} /></View>
      </Panel>
      <Panel title={t('tb.budget_title')}>
        <Field label={t('tb.budget_label', { cur: tn?.currency })} value={tn?.budget_minor != null ? fromMinor(tn.budget_minor, tn.currency) : ''} onChangeText={(v) => { const m = toMinor(v, tn.currency); set({ budget_minor: v === '' ? null : m ?? tn.budget_minor }); }} keyboardType="decimal-pad" />
        <Choice label={t('tb.show_budget')}><Chips options={[{ value: false, label: t('tb.keep_private') }, { value: true, label: t('tb.publish_it') }]} value={!!tn?.budget_public} onChange={(v) => set({ budget_public: v })} /></Choice>
        {tn?.contract_type === 'framework' ? <Field label={t('tb.ceiling', { cur: tn.currency })} value={tn.ceiling_minor != null ? fromMinor(tn.ceiling_minor, tn.currency) : ''} onChangeText={(v) => set({ ceiling_minor: toMinor(v, tn.currency) })} keyboardType="decimal-pad" hint={t('tb.ceiling_hint')} /> : null}
      </Panel>
      {tn?.contract_type !== 'one_off' ? (
        <Panel title={t('tb.contract_terms')}>
          <T size={13} color={c.mute}>{t('tb.terms_note')}</T>
          <View style={{ gap: 6 }}><Lbl>{t('tb.renewal_options')}</Lbl><Counter value={tn?.renewal_options ?? 0} onChange={(v) => set({ renewal_options: v })} min={0} max={10} /></View>
          {(tn?.renewal_options ?? 0) > 0 ? (
            <>
              <View style={{ gap: 6 }}><Lbl>{t('tb.renewal_months')}</Lbl><Counter value={tn?.renewal_term_months ?? 6} onChange={(v) => set({ renewal_term_months: v })} min={1} max={60} /></View>
              {tn?.contract_type === 'framework' ? <Field label={t('tb.renewal_ceiling', { cur: tn.currency })} value={tn.renewal_ceiling_minor != null ? fromMinor(tn.renewal_ceiling_minor, tn.currency) : ''} onChangeText={(v) => set({ renewal_ceiling_minor: v === '' ? null : toMinor(v, tn.currency) })} keyboardType="decimal-pad" hint={t('tb.renewal_hint')} /> : null}
            </>
          ) : null}
          <View style={{ gap: 6 }}><Lbl>{t('tb.notice_days')}</Lbl><Counter value={tn?.notice_days ?? 0} onChange={(v) => set({ notice_days: v })} min={0} max={365} /><T size={12} color={c.mute}>{t('tb.notice_hint')}</T></View>
        </Panel>
      ) : null}
      <Panel title={t('tb.milestones')} right={<Btn small title={t('tb.add_milestone')} color={c.violet} onPress={() => set({ milestones: [...(tn?.milestones ?? []), { name: '', due_on: null }] })} accessibilityLabel={t('tb.a11y_add_milestone')} />}>
        <T size={13} color={c.mute}>{t('tb.milestones_note')}</T>
        {(tn?.milestones ?? []).length === 0 ? <T size={13} color={c.mute}>{t('tb.no_milestones')}</T> : null}
        {(tn?.milestones ?? []).map((m, i) => (
          <View key={i} style={{ gap: 8, borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12 }}>
            <Row2>
              <Field label={t('tb.milestone')} value={m.name} onChangeText={(v) => set({ milestones: tn.milestones.map((x, j) => (j === i ? { ...x, name: v } : x)) })} accessibilityLabel={t('tb.a11y_ms_name', { n: i + 1 })} />
              <DateField label={t('cs.due_short')} value={m.due_on ? String(m.due_on).slice(0, 10) : null} min={(tn?.prep_start ?? tn?.service_start) ? String(tn.prep_start ?? tn.service_start).slice(0, 10) : undefined} max={(tn?.teardown_end ?? tn?.service_end) ? String(tn.teardown_end ?? tn.service_end).slice(0, 10) : undefined} onChange={(v) => set({ milestones: tn.milestones.map((x, j) => (j === i ? { ...x, due_on: v } : x)) })} />
            </Row2>
            <Btn small title={t('access.remove')} color={c.paper} ink={c.ink} onPress={() => set({ milestones: tn.milestones.filter((_, j) => j !== i) })} accessibilityLabel={t('tb.a11y_ms_remove', { n: i + 1 })} />
          </View>
        ))}
      </Panel>
      <Panel title={t('tb.reserve_title')}>
        <Choice label={t('tb.reserve_label')} hint={t('tb.reserve_hint')}>
          <Chips options={[{ value: 'none', label: t('tb.reserve_none') }, { value: 'next_ranked', label: t('tb.reserve_next') }]} value={tn?.reserve_policy ?? 'none'} onChange={(v) => set({ reserve_policy: v })} />
        </Choice>
      </Panel>
      <Panel title={t('tb.rules_suppliers')}>
        <Choice label={t('tb.revisions')}><Chips options={[{ value: true, label: t('tb.allowed') }, { value: false, label: t('tb.not_allowed') }]} value={!!tn?.allow_revision} onChange={(v) => set({ allow_revision: v })} /></Choice>
        <Choice label={t('tb.withdrawal')}><Chips options={[{ value: true, label: t('tb.allowed') }, { value: false, label: t('tb.not_allowed') }]} value={!!tn?.allow_withdrawal} onChange={(v) => set({ allow_withdrawal: v })} /></Choice>
        <Choice label={t('tb.alternatives')}><Chips options={[{ value: false, label: t('tb.not_allowed') }, { value: true, label: t('tb.allowed') }]} value={!!tn?.allow_alternatives} onChange={(v) => set({ allow_alternatives: v })} /></Choice>
      </Panel>
      <Panel title={t('tb.disclose_title')}>
        <T size={13} color={c.mute}>{t('tb.disclose_note')}</T>
        {[['rank', t('tb.disc_rank')], ['bidder_count', t('tb.disc_count')], ['award_public', t('tb.disc_award')]].map(([k, label]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><T size={13} style={{ flex: 1, minWidth: 200 }}>{label}</T><Chips options={[{ value: false, label: t('tb.no') }, { value: true, label: t('tb.yes') }]} value={!!tn?.disclosure?.[k]} onChange={(v) => set({ disclosure: { ...(tn.disclosure ?? {}), [k]: v } })} /></View>)}
      </Panel>
    </>
  );

  const review = (
    <>
      <Panel title={t('tb.checks')} right={<Btn small title={t('tb.run_checks')} color={c.violet} onPress={async () => { if (await save()) { try { setIssues(await api.post(`/rfps/${id}/validate`)); } catch (e) { toast(explain(e)); } } }} />}>
        {issues ? <Checks items={issues.issues.map((x) => ({ key: x.field + x.message, state: x.severity === 'error' ? 'bad' : 'warn', title: x.message, detail: x.field }))} empty={t('tb.all_ok')} /> : <T size={13} color={c.mute}>{t('tb.run_hint')}</T>}
        {issues?.ok ? <Status tone="ok" label={t('tb.ready')} /> : issues ? <Status tone="bad" label={t('tb.fix_first')} /> : null}
      </Panel>
      <Panel title={t('tb.preview_supplier')}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{['public', 'restricted', 'supplier'].map((v) => <Btn key={v} small color={c.violet} title={tEnum(v)} onPress={async () => { try { setPreview(await api.get(`/rfps/${id}/preview`, { view: v })); } catch (e) { toast(explain(e)); } }} />)}</View></Panel>
      <Panel title={t('tb.send_approval')}>
        <T size={13} color={c.mute}>{t('tb.approval_note')}</T>
        {tn?.status === 'draft' ? <Btn title={t('tb.request_approval')} onPress={async () => { if (!(await save())) return; try { await api.post(`/rfps/${id}/request-approval`); toast(t('tb.sent_approval')); push('TenderConsole', { id }); } catch (e) { if (e.details?.issues) setIssues({ ok: false, issues: e.details.issues }); toast(explain(e)); } }} /> : <Notice tone="info">{t('tb.status_notice', { status: tEnum(tn?.status) })}</Notice>}
        <Btn small title={t('tb.open_console')} color={c.violet} onPress={() => push('TenderConsole', { id })} />
      </Panel>
    </>
  );

  const docsPanel = id ? <PackDocuments id={id} toast={toast} /> : null;
  const bodies = [ctx, <>{docsPanel}{lotEditor}</>, sched, elig, quest, evalStep, terms, review];
  return (
    <Screen wide>
      <Head eyebrow={tn ? `${tn.ref} · ${tn.kind.toUpperCase()}` : t('tb.new_tender')} title={tn?.title ?? (form.title.trim() || t('tb.create_rfp'))} sub={tn ? t('tb.draft_saved_sub', { ref: tn.ref }) : t('tb.guided')} right={tn ? <StageTag stage={tn.status === 'draft' ? 'draft' : tn.status} /> : null} />
      <View style={{ marginTop: 14, flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => <Btn key={s} small title={`${i + 1}  ${s}`} color={i === step ? c.ink : i < step ? c.lime : c.violet} onPress={() => (i === 0 || tn ? setStep(i) : toast(t('tb.create_first')))} accessibilityLabel={t('tb.a11y_step', { n: i + 1, name: s })} />)}
      </View>
      {locked ? <View style={{ marginTop: 12 }}><Notice tone="info">{t('tb.locked_notice', { status: tEnum(tn.status) })}</Notice></View> : null}
      <View style={{ marginTop: 14, gap: 14 }}>{bodies[step]}</View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        {step > 0 ? <Btn title={t('common.back')} color={c.violet} onPress={() => setStep(step - 1)} /> : null}
        {step === 0 && !tn ? <Btn title={t('tb.create_continue')} loading={busy} disabled={busy || form.title.trim().length < 3} onPress={create} /> : step < 7 ? <Btn title={t('tb.save_continue')} loading={busy} disabled={busy || locked} onPress={next} /> : null}
        {tn ? <Btn title={t('tb.save_draft')} color={c.violet} disabled={busy || locked} onPress={async () => { setBusy(true); if (await save()) toast(t('tb.draft_saved')); setBusy(false); }} /> : null}
      </View>
      <Sheet visible={!!preview && preview !== 'library'} onClose={() => setPreview(null)} title={t('tb.preview_title', { view: tEnum(preview?.view ?? '') })}>
        {preview?.card ? <KV items={[[t('tb.kv_ref'), preview.card.ref], [t('cs.title_label'), preview.card.title], [t('tb.kv_issuer'), preview.card.issuer.name], [t('cs.category'), preview.card.category], [t('tb.kv_closes'), when(preview.card.closes_at, preview.card.timezone)], [t('tb.budget_title'), preview.card.budget ? amount(preview.card.budget.amount_minor, preview.card.budget.currency) : t('tb.not_published')], [t('tb.who_part'), tEnum(preview.card.participation)]]} /> : null}
        {preview?.notice ? <><T size={13}>{preview.notice.scope}</T><T size={12} color={c.mute}>{t('tb.lots_questions', { lots: preview.notice.lots.length, qs: preview.notice.questions.length })}</T></> : null}
        {preview?.note ? <T size={12} color={c.mute}>{preview.note}</T> : null}
      </Sheet>
      <Sheet visible={preview === 'library'} onClose={() => setPreview(null)} title={t('tb.library_title')}>
        {(sets.data ?? []).map((s) => <Card key={s.id} onPress={() => { const add = (s.body.questions ?? []).filter((q) => !qs.some((x) => x.key === q.key)); setQs([...qs, ...add]); setPreview(null); toast(t('tb.added_n', { n: add.length })); }}><T weight="700">{s.name}</T><T size={12} color={c.mute}>{t('tb.questions_ver', { n: (s.body.questions ?? []).length, v: s.version })}</T></Card>)}
      </Sheet>
    </Screen>
  );
}

function OptionsEditor({ label, value, onChange }) {
  const [x, setX] = useState('');
  return (
    <View style={{ gap: 6 }}><Lbl>{label}</Lbl>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{value.map((o) => <Btn key={o} small color={c.violet} title={`${o}  ✕`} onPress={() => onChange(value.filter((y) => y !== o))} />)}</View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={x} onChangeText={setX} placeholder={t('tb.opt_ph')} /></View><Btn small title={t('access.add')} disabled={!x.trim() || value.includes(x.trim())} onPress={() => { onChange([...value, x.trim()]); setX(''); }} /></View>
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
      <Lbl>{t('tb.fx_title')}</Lbl>
      {Object.entries(rates).filter(([k]) => k !== cur).map(([k, v]) => <View key={k} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={13} style={{ flex: 1 }}>1 {k} = {v} {cur}</T><Btn small color={c.violet} title={t('access.remove')} onPress={() => { const r = { ...rates }; delete r[k]; onChange(Object.keys(r).filter((x) => x !== cur).length ? { ...fx, rates: r } : null); }} /></View>)}
      <CurrencyDropdown label={t('spl.currency')} value={code} onChange={setCode} suggest={false} />
      <Field label={t('tb.fx_value', { cur })} value={rate} onChangeText={(x) => setRate(x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" />
      <DateField label={t('tb.fx_dated')} value={fx?.date ?? null} onChange={(d) => onChange({ date: d, base: cur, rates: { [cur]: '1', ...rates } })} optional />
      <Btn small title={t('tb.add_rate')} color={c.violet} disabled={!code || !rate} onPress={add} style={{ alignSelf: 'flex-start' }} />
      <T size={12} color={c.mute}>{t('tb.fx_note')}</T>
    </View>
  );
}
