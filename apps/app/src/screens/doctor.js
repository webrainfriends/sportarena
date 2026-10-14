// Doctor workspace (issue #212): one home for a doctor's day - overview, patients, results queue, referrals - and a patient file with
// context (problems/allergies/medicines), encounters, care plans, investigations, referrals and clearance. Every action here is a
// capability that already exists (REST/OpenAPI/MCP); this screen adds no rules of its own.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, H2, Loading, Row, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { EntityPicker } from '../entity-picker';
import { ClinicalStatusCard } from './provider';
import { Confirm } from './coaching';
import { c, day, when } from '../theme';

const todayIso = () => new Date().toISOString().slice(0, 10);
const clip = (s, n = 140) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const NEUTRAL = c.violetSoft;

/** Run a capability, toast the outcome, then reload. */
export function useAct(...reloads) {
  const { toast } = useSession();
  return async (fn, msg) => { try { await fn(); toast(msg); reloads.forEach((r) => r?.()); return true; } catch (e) { toast('' + e.message); return false; } };
}
const Label = ({ children }) => <T weight="800" size={13} color={c.mute} style={{ marginTop: 6 }}>{children}</T>;
const Bar = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>{children}</View>;
const Block = ({ title, action, onAction, children }) => (
  <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><H2>{title}</H2>{action ? <Btn small title={action} color={c.mint} ink={c.ink} onPress={onAction} /> : null}</View>
    {children}
  </View>
);
const Wait = ({ q, empty, children }) => (q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data?.length === 0 && empty ? empty : children);

// ---------- Doctor home ----------

/** Entry card for doctors on Home / Health / Me. */
export function DoctorEntry() {
  const { push } = useNav();
  const { user, has } = useSession();
  if (!user?.roles?.includes('doctor') || !has('doctor')) return null;   // has() lets an admin through every role; only a real doctor gets the workspace
  return (
    <Card color={c.mintSoft} pad={14} onPress={() => push('DoctorHome')}>
      <T weight="900" size={16}>🩺 Doctor workspace</T>
      <T size={13} color={c.mute}>Today's patients, results to review, referrals, care plans and clearances — all in one place.</T>
      <Btn small title="Open workspace" color={c.mint} ink={c.ink} onPress={() => push('DoctorHome')} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
    </Card>
  );
}

export function DoctorHome() {
  const { user } = useSession();
  const [tab, setTab] = useState('overview');
  const [open, setOpen] = useState(null);   // { athlete_id, name, section }
  const patients = useLoad(() => api.get('/medical/patients', { limit: 100 }), []);
  const names = Object.fromEntries((patients.data ?? []).map((p) => [p.athlete_id, p.display_name]));
  if (open) return <PatientFile athlete={open} onBack={() => setOpen(null)} />;
  const go = (athlete_id, section) => setOpen({ athlete_id, name: names[athlete_id] ?? 'Patient', section });
  return (
    <Screen>
      <H1>Doctor workspace</H1>
      <T size={13} color={c.mute}>Hello Dr {user.display_name}. You only see patients who have shared access with you; every read is logged.</T>
      <View style={{ marginTop: 10 }}><Seg options={[{ value: 'overview', label: 'Overview', emoji: '🏠' }, { value: 'patients', label: 'Patients', emoji: '🧑‍⚕️' }, { value: 'results', label: 'Results', emoji: '🧪' }, { value: 'referrals', label: 'Referrals', emoji: '↗️' }]} value={tab} onChange={setTab} color={c.mint} /></View>
      <View style={{ gap: 12, marginTop: 10 }}>
        {tab === 'overview' && <Overview patients={patients} go={go} setTab={setTab} />}
        {tab === 'patients' && <Patients patients={patients} go={go} />}
        {tab === 'results' && <ResultsQueue names={names} go={go} />}
        {tab === 'referrals' && <ReferralInbox />}
      </View>
    </Screen>
  );
}

function Counter({ emoji, value, label, hint, color = c.paper, onPress }) {
  return (
    <Card color={color} pad={14} onPress={onPress} style={{ flexGrow: 1, flexBasis: 150 }}>
      <T size={24}>{emoji}</T><T weight="900" size={26}>{value ?? '–'}</T><T weight="800" size={13}>{label}</T>{hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </Card>
  );
}

function Overview({ patients, go, setTab }) {
  const { user } = useSession();
  const { push } = useNav();
  const appts = useLoad(() => api.get('/appointments', { limit: 50 }), []);
  const queue = useLoad(() => api.get('/medical/investigations', { open_only: true, limit: 100 }), []);
  const inbox = useLoad(() => api.get('/medical/referrals', { box: 'received', limit: 50 }), []);
  const mine = (appts.data ?? []).filter((a) => a.provider_id === user.id);
  const requests = mine.filter((a) => a.status === 'requested');
  const todays = mine.filter((a) => a.status === 'confirmed' && new Date(a.starts_at).toDateString() === new Date().toDateString());
  const toReview = (queue.data ?? []).filter((i) => i.status === 'received');
  const overdue = (queue.data ?? []).filter((i) => i.overdue);
  const waiting = (inbox.data ?? []).filter((r) => ['sent', 'acknowledged'].includes(r.status) && r.content_available !== false);
  return (
    <>
      <ClinicalStatusCard />
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Counter emoji="📅" value={requests.length} label="Appointment requests" hint="Confirm or decline in Health" onPress={() => push('Health')} />
        <Counter emoji="🧪" value={toReview.length} label="Results to review" hint={overdue.length ? `${overdue.length} past review date` : 'None overdue'} color={toReview.length ? c.sun : c.paper} onPress={() => setTab('results')} />
        <Counter emoji="↗️" value={waiting.length} label="Referrals to answer" onPress={() => setTab('referrals')} />
        <Counter emoji="🧑‍⚕️" value={patients.data?.length} label="Patients who shared access" onPress={() => setTab('patients')} />
      </View>
      <Block title="Today's consultations">
        <Wait q={appts} empty={null}>{todays.length ? todays.map((a) => (
          <Card key={a.id}><T weight="900">{a.athlete_name}</T><T size={13} color={c.mute}>{when(a.starts_at)} · {a.duration_min} min · {a.mode === 'remote' ? 'remote' : 'in person'}</T>
            <Bar><Btn small title="Open patient file" color={c.mint} ink={c.ink} onPress={() => go(a.athlete_id, 'encounters')} /></Bar></Card>
        )) : <Empty emoji="🗓️" title="Nothing confirmed for today" sub="Confirmed appointments for today appear here." />}</Wait>
      </Block>
      <Block title="Results that need you">
        <Wait q={queue}>{toReview.length ? toReview.slice(0, 5).map((i) => (
          <Row key={i.id} title={i.test} sub={`${(patients.data ?? []).find((p) => p.athlete_id === i.athlete_id)?.display_name ?? 'Patient'} · ${i.priority}${i.overdue ? ' · past review date' : ''}`} right={<Tag label="Review" color={c.sun} />} onPress={() => go(i.athlete_id, 'results')} />
        )) : <T size={13} color={c.mute}>No results are waiting for your review.</T>}</Wait>
      </Block>
    </>
  );
}

function Patients({ patients, go }) {
  return (
    <Wait q={patients} empty={<Empty emoji="🧑‍⚕️" title="No patients yet" sub="Athletes appear here once they share access with you (Health → Access). Nobody is added without their consent." />}>
      {(patients.data ?? []).map((p) => (
        <Row key={p.athlete_id} title={p.display_name} sub={`@${p.handle} · ${p.scope === 'full' ? 'full records' : 'fit-to-play status only'}${p.expires_at ? ` · until ${day(p.expires_at)}` : ''}`}
          right={<Tag label={p.scope === 'full' ? 'Full access' : 'Clearance only'} color={p.scope === 'full' ? c.lime : NEUTRAL} />} onPress={p.scope === 'full' ? () => go(p.athlete_id, 'encounters') : undefined} />
      ))}
    </Wait>
  );
}

// ---------- Results queue & referral inbox ----------

const PRIORITY = { urgent: c.red, priority: c.sun, routine: NEUTRAL };
const STATUS_LABEL = { requested: 'Awaiting result', received: 'Result received - needs review', reviewed: 'Reviewed', patient_informed: 'Patient informed', closed: 'Closed' };

function ResultsQueue({ names, go }) {
  const q = useLoad(() => api.get('/medical/investigations', { open_only: true, limit: 100 }), []);
  return (
    <>
      <T size={13} color={c.mute}>Your review queue across consenting patients: urgent and overdue first. A result counts as reviewed only when you review it.</T>
      <Wait q={q} empty={<Empty emoji="🧪" title="Nothing open" sub="Tests you request appear here until they are reviewed, explained to the patient and closed." />}>
        {(q.data ?? []).map((i) => (
          <Card key={i.id}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{i.test}</T><Tag label={i.priority} color={PRIORITY[i.priority]} />{i.overdue ? <Tag label="Past review date" color={c.orangeSoft} /> : null}</View>
            <T size={13} color={c.mute}>{names[i.athlete_id] ?? 'Patient'} · {STATUS_LABEL[i.status]}{i.review_due ? ` · review by ${day(i.review_due)}` : ''}</T>
            <Bar><Btn small title="Open" color={c.mint} ink={c.ink} onPress={() => go(i.athlete_id, 'results')} /></Bar></Card>
        ))}
      </Wait>
    </>
  );
}

const REF_TAG = { draft: NEUTRAL, sent: c.sun, acknowledged: c.cyan, accepted: c.lime, declined: c.orangeSoft, booked: c.lime, completed: c.lime, closed: NEUTRAL, withdrawn: NEUTRAL };

function ReferralCard({ r, act, onChanged, mine }) {
  const [ret, setRet] = useState(false);
  const step = (action, msg, extra = {}) => act(() => api.post(`/medical/referrals/${r.id}/action`, { action, ...extra }), msg);
  const sent = mine === 'sent';
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{sent ? `To ${r.to_name ?? r.external_recipient}` : `From Dr ${r.from_name}`}</T><Tag label={r.status} color={REF_TAG[r.status]} /><Tag label={r.urgency} color={PRIORITY[r.urgency]} />
        {sent ? <Tag label={r.consent === 'granted' ? 'Patient agreed' : r.consent === 'declined' ? 'Patient declined' : 'Waiting for patient'} color={r.consent === 'granted' ? c.lime : NEUTRAL} /> : null}</View>
      {r.content_available === false ? <T size={13} color={c.mute}>This referral is no longer available to you (withdrawn, expired or not consented).</T> : (
        <>
          <T size={14} style={{ marginTop: 4 }}>{r.reason}</T>{r.requested_action ? <T size={13} color={c.mute}>Requested: {r.requested_action}</T> : null}
          <Label>Shared with the recipient (nothing else)</Label>{(r.shared ?? []).map((s, k) => <T key={k} size={13}>• <T weight="800" size={13}>{s.label}:</T> {s.text}</T>)}
          {r.external ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{r.external.note}</T> : null}
          {r.return_summary ? <><Label>Return summary</Label><T size={13}>{r.return_summary}</T></> : null}
        </>
      )}
      <Bar>
        {sent && r.status === 'draft' ? <Btn small title="Send for patient consent" color={c.mint} ink={c.ink} onPress={() => step('send', 'Sent — the patient will be asked to consent')} /> : null}
        {sent && ['draft', 'sent', 'acknowledged', 'accepted', 'booked'].includes(r.status) ? <Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => step('withdraw', 'Withdrawn')} /> : null}
        {sent && (r.external ? r.status === 'sent' : ['completed', 'declined'].includes(r.status)) ? <Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => step('close', 'Closed')} /> : null}
        {!sent && r.content_available !== false && r.status === 'sent' ? <Btn small title="Acknowledge" color={c.cyan} ink={c.ink} onPress={() => step('acknowledge', 'Acknowledged')} /> : null}
        {!sent && r.content_available !== false && ['sent', 'acknowledged'].includes(r.status) ? <><Btn small title="Accept" color={c.mint} ink={c.ink} onPress={() => step('accept', 'Accepted')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => step('decline', 'Declined')} /></> : null}
        {!sent && ['accepted', 'booked'].includes(r.status) ? <Btn small title="Complete with summary" color={c.mint} ink={c.ink} onPress={() => setRet(true)} /> : null}
      </Bar>
      <FormSheet visible={ret} onClose={() => setRet(false)} title="Return summary" submitLabel="Complete referral" color={c.mint}
        fields={[{ key: 'return_summary', label: 'Summary for the referring doctor and the patient', type: 'multiline', optional: true, hint: 'Progress and recommendations. You do not edit the referrer\'s records.' }]}
        onSubmit={async (v) => { await api.post(`/medical/referrals/${r.id}/action`, { action: 'complete', ...v }); onChanged(); return 'Completed'; }} />
    </Card>
  );
}

function ReferralInbox() {
  const [box, setBox] = useState('received');
  const q = useLoad(() => api.get('/medical/referrals', { box, limit: 50 }), [box]);
  const act = useAct(q.reload);
  return (
    <>
      <Seg options={[{ value: 'received', label: 'Received' }, { value: 'sent', label: 'Sent by me' }]} value={box} onChange={setBox} color={c.mint} />
      <Wait q={q} empty={<Empty emoji="↗️" title={box === 'received' ? 'No referrals received' : 'No referrals sent'} sub={box === 'received' ? 'Referrals appear here only after the patient has agreed to share them with you.' : 'Create one from a patient file.'} />}>
        {(q.data ?? []).map((r) => <ReferralCard key={r.id} r={r} act={act} onChanged={q.reload} mine={box} />)}
      </Wait>
    </>
  );
}

// ---------- Patient file ----------

const SECTIONS = [{ value: 'encounters', label: 'Encounters', emoji: '📝' }, { value: 'context', label: 'Allergies & meds', emoji: '💊' }, { value: 'plans', label: 'Care plans', emoji: '🗂️' }, { value: 'results', label: 'Results', emoji: '🧪' }, { value: 'referrals', label: 'Referrals', emoji: '↗️' }, { value: 'clearance', label: 'Fit to play', emoji: '✅' }];

function PatientFile({ athlete, onBack }) {
  const [sec, setSec] = useState(athlete.section ?? 'encounters');
  const Body = { encounters: Encounters, context: Context, plans: Plans, results: Results, referrals: PatientReferrals, clearance: Clearance }[sec];
  return (
    <Screen>
      <Btn small title="‹ All patients" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <H1>{athlete.name}</H1>
      <Card color={c.mintSoft} pad={12}><T weight="800">Shared with you by the patient</T><T size={12} color={c.mute}>You see this file because they granted access; it stops the moment they withdraw it or your verification lapses. Reads and writes are logged. Nothing here is visible to the clinic's other staff.</T></Card>
      <View style={{ marginTop: 10 }}><Seg options={SECTIONS} value={sec} onChange={setSec} color={c.mint} /></View>
      <View style={{ gap: 12, marginTop: 10 }}><Body key={sec} id={athlete.athlete_id} /></View>
    </Screen>
  );
}

// -- Encounters --

const encFields = (appts) => [
  { key: 'template', label: 'Template', type: 'choice', options: [{ value: 'soap', label: 'SOAP' }, { value: 'free', label: 'Free text' }] },
  ...(appts?.length ? [{ key: 'appointment_id', label: 'Appointment', type: 'chips', optional: true, options: appts.map((a) => ({ value: a.id, label: when(a.starts_at) })), hint: 'Optional. One encounter per appointment.' }] : []),
  { key: 'history', label: 'History / subjective', type: 'multiline', optional: true },
  { key: 'examination', label: 'Examination / objective', type: 'multiline', optional: true },
  { key: 'assessment', label: 'Assessment', type: 'multiline', optional: true },
  { key: 'plan', label: 'Plan', type: 'multiline', optional: true },
  { key: 's0', label: 'One measurement', type: 'section' },
  { key: 'obs_type', label: 'What was measured', type: 'text', optional: true, hint: 'For example heart rate. Needs a value and unit.' },
  { key: 'obs_value', label: 'Value', type: 'number', optional: true, show: (v) => !!v.obs_type },
  { key: 'obs_unit', label: 'Unit', type: 'text', optional: true, show: (v) => !!v.obs_type },
  { key: 's1', label: 'Visit summary the patient will read once you sign', type: 'section' },
  { key: 'sum_problem', label: 'What we found', type: 'multiline', optional: true },
  { key: 'sum_plan', label: 'The plan', type: 'multiline', optional: true },
  { key: 'sum_actions', label: 'What to do next', type: 'multiline', optional: true },
  { key: 'sum_follow_up_date', label: 'Follow-up date', type: 'date', optional: true, min: todayIso() },
  { key: 'sum_escalation', label: 'When to get help sooner', type: 'multiline', optional: true, hint: 'Messages are not monitored in real time.' },
];
const encBody = (v) => {
  const content = {};
  for (const k of ['history', 'examination', 'assessment', 'plan']) if (v[k]) content[k] = v[k];
  if (v.obs_type) { if (v.obs_value === undefined || !v.obs_unit) throw new Error('A measurement needs a value and a unit'); content.observations = [{ type: v.obs_type, value: v.obs_value, unit: v.obs_unit, measured_at: new Date().toISOString() }]; }
  const s = {}; for (const k of ['problem', 'plan', 'actions', 'follow_up_date', 'escalation']) if (v[`sum_${k}`]) s[k] = v[`sum_${k}`];
  return { template: v.template, content, ...(Object.keys(s).length ? { visit_summary: s } : {}), ...(v.appointment_id ? { appointment_id: v.appointment_id } : {}) };
};
const encInitial = (e) => ({ template: e.template ?? 'soap', ...e.content, obs_type: e.content?.observations?.[0]?.type, obs_value: e.content?.observations?.[0]?.value, obs_unit: e.content?.observations?.[0]?.unit,
  ...Object.fromEntries(Object.entries(e.visit_summary ?? {}).map(([k, x]) => [`sum_${k}`, x])) });
const ENC_TAG = { draft: NEUTRAL, ready: c.sun, signed: c.lime, voided: c.orangeSoft };

function Encounters({ id }) {
  const { user } = useSession();
  const q = useLoad(() => api.get('/medical/encounters', { athlete_id: id, limit: 50 }), [id]);
  const appts = useLoad(async () => (await api.get('/appointments', { limit: 50 })).filter((a) => a.athlete_id === id && a.provider_id === user.id && ['confirmed', 'completed'].includes(a.status)), [id]);
  const act = useAct(q.reload);
  const [form, setForm] = useState(null);   // { edit?, amend? }
  const [voiding, setVoiding] = useState(null);
  const used = new Set((q.data ?? []).filter((e) => e.status !== 'voided' && e.kind === 'encounter').map((e) => e.appointment_id));
  const free = (appts.data ?? []).filter((a) => !used.has(a.id) || form?.edit?.appointment_id === a.id);
  return (
    <Block title="Encounters" action="＋ New encounter" onAction={() => setForm({})}>
      <T size={12} color={c.mute}>Draft → ready → signed. Signing is final: later changes are amendments that keep the original. Your working notes are never shown to the patient; they read the visit summary.</T>
      <Wait q={q} empty={<Empty emoji="📝" title="No encounters yet" sub="Start one from a consultation. You can save a draft and finish later." />}>
        {(q.data ?? []).map((e) => (
          <Card key={e.id}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={e.kind === 'amendment' ? `amendment · ${e.status}` : e.status} color={ENC_TAG[e.status]} /><T size={12} color={c.mute}>{when(e.signed_at ?? e.created_at)} · Dr {e.provider_name}</T></View>
            {e.content ? <>
              {e.content.amendment_reason ? <T size={13} weight="800" style={{ marginTop: 6 }}>Amendment: {e.content.amendment_reason}</T> : null}
              {['history', 'examination', 'assessment', 'plan'].filter((k) => e.content[k]).map((k) => <T key={k} size={13} style={{ marginTop: 4 }}><T weight="900" size={13}>{k[0].toUpperCase() + k.slice(1)}: </T>{clip(e.content[k], 220)}</T>)}
              {(e.content.observations ?? []).map((o, k) => <T key={k} size={12} color={c.mute}>{o.type}: {o.value} {o.unit} · {when(o.measured_at)}</T>)}
              {e.content.copied_forward ? <Tag label={e.content.copied_forward.reviewed ? 'copied forward · reviewed' : 'copied forward · review needed'} color={c.sun} style={{ marginTop: 4 }} /> : null}
            </> : null}
            {e.visit_summary ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Patient summary: {clip(e.visit_summary.problem ?? e.visit_summary.plan ?? '', 120)}{e.patient_ack_at ? ' · patient has read it' : e.status === 'signed' ? ' · not yet read' : ''}</T> : null}
            {e.void_reason ? <T size={12} color={c.red}>Voided: {e.void_reason}</T> : null}
            {e.provider_id === user.id ? (
              <Bar>
                {['draft', 'ready'].includes(e.status) ? <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ edit: e })} /> : null}
                {e.status === 'draft' ? <Btn small title="Mark ready for review" color={c.sun} ink={c.ink} onPress={() => act(() => api.patch(`/medical/encounters/${e.id}`, { version: e.version, status: 'ready' }), 'Marked ready')} /> : null}
                {['draft', 'ready'].includes(e.status) ? <Btn small title="Sign" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/encounters/${e.id}/sign`, { version: e.version }), 'Signed')} /> : null}
                {e.status === 'signed' ? <Btn small title="Amend" color={c.violet} onPress={() => setForm({ amend: e })} /> : null}
                {e.status !== 'voided' ? <Btn small title="Void" color={c.paper} ink={c.red} onPress={() => setVoiding(e)} /> : null}
              </Bar>) : null}
          </Card>
        ))}
      </Wait>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.amend ? 'Amend signed encounter' : form?.edit ? 'Edit draft' : 'New encounter'} color={c.mint} submitLabel={form?.amend ? 'Create amendment draft' : form?.edit ? 'Save draft' : 'Save draft'}
        fields={[...(form?.amend ? [{ key: 'reason', label: 'Why are you amending?', type: 'multiline' }] : []), ...encFields(form?.amend ? [] : free)]}
        initial={form?.edit ? { ...encInitial(form.edit), appointment_id: form.edit.appointment_id } : {}}
        onSubmit={async (v) => {
          const b = encBody(v);
          if (form.amend) await api.post(`/medical/encounters/${form.amend.id}/amend`, { reason: v.reason, content: b.content, ...(b.visit_summary ? { visit_summary: b.visit_summary } : {}) });
          else if (form.edit) await api.patch(`/medical/encounters/${form.edit.id}`, { version: form.edit.version, content: b.content, ...(b.visit_summary ? { visit_summary: b.visit_summary } : {}) });
          else await api.post('/medical/encounters', { athlete_id: id, ...b });
          q.reload(); return 'Saved as draft — sign it when you are done';
        }} />
      <Confirm visible={!!voiding} title="Void this encounter?" yes="Void" danger askReason="Why is it being voided?" body="The record is kept for audit but is no longer shown to the patient or other doctors." onClose={() => setVoiding(null)}
        onYes={async (reason) => { await act(() => api.post(`/medical/encounters/${voiding.id}/void`, { reason: reason || 'Voided' }), 'Voided'); setVoiding(null); }} />
    </Block>
  );
}

// -- Allergies, problems, medicines --

const KIND = { problem: 'Problems', allergy: 'Allergies & intolerances', medication: 'Medicines' };
const STATUSES = { problem: ['active', 'resolved', 'uncertain'], allergy: ['active', 'resolved', 'uncertain'], medication: ['active', 'stopped', 'uncertain'] };
const ctxFields = (kind) => [
  { key: 'name', label: kind === 'allergy' ? 'Substance' : kind === 'medication' ? 'Medicine' : 'Problem', type: 'text' },
  { key: 'status', label: 'Status', type: 'choice', options: STATUSES[kind] },
  ...(kind === 'problem' ? [{ key: 'onset', label: 'Onset', type: 'date', optional: true, max: todayIso() }] : []),
  ...(kind === 'allergy' ? [{ key: 'reaction', label: 'Reaction', type: 'text', optional: true }] : []),
  ...(kind === 'medication' ? [{ key: 'strength', label: 'Strength', type: 'text', optional: true }, { key: 'form', label: 'Form', type: 'text', optional: true }, { key: 'route', label: 'Route', type: 'text', optional: true }, { key: 'frequency', label: 'How often', type: 'text', optional: true },
    { key: 'started_on', label: 'Started', type: 'date', optional: true, max: todayIso() }, { key: 'stopped_on', label: 'Stopped', type: 'date', optional: true, max: todayIso(), show: (v) => v.status === 'stopped' }, { key: 'prescriber', label: 'Prescriber (as reported)', type: 'text', optional: true, hint: 'Recording a medicine is not prescribing it.' }] : []),
  { key: 'note', label: 'Note', type: 'text', optional: true },
];
const SRC = { patient_reported: 'Patient reported', clinician_recorded: 'Recorded by clinician' };
const VER = { unverified: ['Not yet reconciled', c.sun], confirmed: ['Confirmed', c.lime], disputed: ['Disputed', c.orangeSoft] };

export function ContextEntry({ e, children }) {
  const [vl, vc] = VER[e.verification];
  const extra = Object.entries(e.detail ?? {}).filter(([k]) => k !== 'note').map(([k, x]) => `${k.replace('_', ' ')}: ${x}`).join(' · ');
  return (
    <Card pad={12}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{e.name}</T><Tag label={e.status} color={NEUTRAL} /><Tag label={SRC[e.source]} color={c.cyan} /><Tag label={vl} color={vc} /></View>
      {extra ? <T size={12} color={c.mute}>{extra}</T> : null}{e.detail?.note ? <T size={12} color={c.mute}>{e.detail.note}</T> : null}{children}</Card>
  );
}
export function ContextState({ kind, state }) {
  const [label, col] = state === 'unknown' ? ['Unknown — not asked or not recorded', c.sun] : state === 'none_reported' ? ['None reported by the patient', NEUTRAL] : ['On record', c.lime];
  return <Tag label={label} color={col} />;
}

function Context({ id }) {
  const q = useLoad(() => api.get('/medical/context', { athlete_id: id, limit: 100 }), [id]);
  const act = useAct(q.reload);
  const [form, setForm] = useState(null);   // { kind, correct? }
  const d = q.data;
  return (
    <Wait q={{ ...q, data: d ? [d] : d }}>
      <T size={12} color={c.mute}>Patients tell you what they have and take; you confirm, dispute or correct it. Missing information is "unknown", never "none". Corrections keep the earlier entry in history. This list does not prescribe or check interactions.</T>
      {d ? ['allergy', 'medication', 'problem'].map((kind) => (
        <Block key={kind} title={KIND[kind]} action="＋ Add" onAction={() => setForm({ kind })}>
          <ContextState kind={kind} state={d.state[kind]} />
          {d.entries.filter((e) => e.kind === kind).map((e) => (
            <ContextEntry key={e.id} e={e}>
              <Bar>
                {e.verification === 'unverified' ? <Btn small title="Confirm" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/context/${e.id}/reconcile`, { action: 'confirm' }), 'Confirmed')} /> : null}
                {e.verification === 'unverified' ? <Btn small title="Dispute" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/medical/context/${e.id}/reconcile`, { action: 'dispute' }), 'Marked as disputed')} /> : null}
                <Btn small title="Correct" color={c.violet} onPress={() => setForm({ kind, correct: e })} />
              </Bar>
            </ContextEntry>
          ))}
          {kind !== 'problem' && d.state[kind] === 'unknown' ? <Btn small title={`Patient confirms no ${kind === 'allergy' ? 'allergies' : 'medicines'}`} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }}
            onPress={() => act(() => api.post('/medical/context/declarations', { athlete_id: id, kind, state: 'none_reported' }), 'Recorded as none reported')} /> : null}
        </Block>
      )) : null}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.correct ? `Correct ${form.kind}` : `Add ${form?.kind ?? ''}`} color={c.mint} fields={form ? ctxFields(form.kind) : []}
        initial={form?.correct ? { name: form.correct.name, status: form.correct.status, ...form.correct.detail } : {}}
        onSubmit={async (v) => {
          const entry = { kind: form.kind, ...v };
          if (form.correct) await api.post(`/medical/context/${form.correct.id}/reconcile`, { action: 'correct', entry });
          else await api.post('/medical/context', { athlete_id: id, entry });
          q.reload(); return 'Saved';
        }} />
    </Wait>
  );
}

// -- Care plans --

const planFields = () => [
  { key: 'title', label: 'Plan title', type: 'text' },
  { key: 'goal', label: 'Goal', type: 'text', optional: true },
  { key: 'baseline', label: 'Where the patient is now (baseline)', type: 'text', optional: true },
  { key: 'instructions', label: 'Instructions the patient will read', type: 'multiline', optional: true },
  { key: 'review_interval_days', label: 'Review every (days)', type: 'stepper', min: 1, max: 365, step: 7, default: 14 },
  ...[1, 2, 3, 4].flatMap((n) => [
    { key: `s${n}`, label: `Action ${n}`, type: 'section' },
    { key: `a${n}_title`, label: 'What needs doing', type: 'text', optional: true },
    { key: `a${n}_who`, label: 'Who does it', type: 'choice', options: [{ value: 'patient', label: 'Patient' }, { value: 'doctor', label: 'Doctor' }, { value: 'other', label: 'Someone else' }], show: (v) => !!v[`a${n}_title`] },
    { key: `a${n}_due`, label: 'Due', type: 'date', optional: true, min: todayIso(), show: (v) => !!v[`a${n}_title`] },
    { key: `a${n}_criteria`, label: 'Done when', type: 'text', optional: true, show: (v) => !!v[`a${n}_title`] },
  ]),
];
const planBody = (v, keys = []) => ({
  goals: v.goal ? [{ text: v.goal, ...(v.baseline ? { baseline: v.baseline } : {}) }] : [], ...(v.instructions ? { instructions: v.instructions } : {}), review_interval_days: v.review_interval_days,
  actions: [1, 2, 3, 4].filter((n) => v[`a${n}_title`]).map((n) => ({ ...(keys[n - 1] ? { key: keys[n - 1] } : {}), title: v[`a${n}_title`], responsible: v[`a${n}_who`] ?? 'patient', ...(v[`a${n}_due`] ? { due_date: v[`a${n}_due`] } : {}), ...(v[`a${n}_criteria`] ? { completion_criteria: v[`a${n}_criteria`] } : {}) })),
});
const planInitial = (b, title) => ({ title, goal: b.goals?.[0]?.text, baseline: b.goals?.[0]?.baseline, instructions: b.instructions, review_interval_days: b.review_interval_days ?? 14,
  ...Object.fromEntries((b.actions ?? []).flatMap((a, k) => [[`a${k + 1}_title`, a.title], [`a${k + 1}_who`, a.responsible], [`a${k + 1}_due`, a.due_date], [`a${k + 1}_criteria`, a.completion_criteria]])) });
const ACT_STATE = { open: ['Open', NEUTRAL], done_reported: ['Patient says done', c.cyan], unable: ['Patient could not', c.sun], confirmed: ['You confirmed', c.lime], cancelled: ['Cancelled', NEUTRAL] };

export function PlanActions({ actions, children }) {
  return (actions ?? []).map((a) => {
    const [l, col] = ACT_STATE[a.state] ?? ACT_STATE.open;
    return (
      <View key={a.key} style={{ paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="800" size={14}>{a.title}</T><Tag label={l} color={col} />{a.overdue ? <Tag label="Date passed" color={c.orangeSoft} /> : null}</View>
        <T size={12} color={c.mute}>{a.responsible}{a.due_date ? ` · due ${day(a.due_date)}` : ''}{a.completion_criteria ? ` · done when: ${a.completion_criteria}` : ''}</T>
        {children ? children(a) : null}
      </View>
    );
  });
}

function PlanCard({ p, act, reload, edit }) {
  const [open, setOpen] = useState(false);
  const d = useLoad(() => (open ? api.get(`/medical/care-plans/${p.id}`) : Promise.resolve(null)), [open, p.updated_at]);
  const draft = d.data?.versions.find((v) => v.status === 'draft'), pub = d.data?.versions.find((v) => v.status === 'published');
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{p.title}</T><Tag label={p.status} color={p.status === 'active' ? c.lime : NEUTRAL} /></View>
      <Bar><Btn small title={open ? 'Hide' : 'Open'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} /></Bar>
      {open && d.data ? (
        <View style={{ marginTop: 8 }}>
          {pub ? <><Label>Published version {pub.version_no}</Label>{pub.body.instructions ? <T size={13}>{pub.body.instructions}</T> : null}{(pub.body.goals ?? []).map((g, k) => <T key={k} size={13}>🎯 {g.text}{g.baseline ? ` (now: ${g.baseline})` : ''}</T>)}
            <PlanActions actions={pub.body.actions}>{(a) => (a.state === 'done_reported' || a.state === 'unable') ? <Bar><Btn small title="Confirm done" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/entries`, { kind: 'clinician_confirmed', action_key: a.key }), 'Confirmed')} /></Bar> : null}</PlanActions></> : <T size={13} color={c.mute}>Not published yet — the patient cannot see it.</T>}
          {draft ? <><Label>Draft version {draft.version_no} (patient does not see this yet)</Label><T size={13}>{(draft.body.actions ?? []).length} action(s), {(draft.body.goals ?? []).length} goal(s)</T></> : null}
          {(d.data.entries ?? []).filter((e) => e.kind === 'symptom').slice(-3).map((e) => <T key={e.id} size={12} color={c.mute}>📝 Patient note {day(e.created_at)}: {e.note}</T>)}
          <Bar>
            {draft ? <Btn small title="Edit draft" color={c.paper} ink={c.ink} onPress={() => edit({ plan: p, draft })} /> : null}
            {draft ? <Btn small title="Publish to patient" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/publish`, { row_version: draft.row_version }), 'Published — the patient is notified')} /> : null}
            {pub && !draft && p.status !== 'completed' ? <Btn small title="Revise" color={c.violet} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/revise`, {}), 'Revision started — edit the draft')} /> : null}
            {p.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/state`, { state: 'paused' }), 'Paused')} /> : null}
            {p.status === 'paused' ? <Btn small title="Resume" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/state`, { state: 'active' }), 'Resumed')} /> : null}
            {['active', 'paused'].includes(p.status) ? <Btn small title="Complete plan" color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/medical/care-plans/${p.id}/state`, { state: 'completed' }), 'Plan completed')} /> : null}
          </Bar>
        </View>) : null}
    </Card>
  );
}

function Plans({ id }) {
  const q = useLoad(() => api.get('/medical/care-plans', { athlete_id: id, limit: 50 }), [id]);
  const act = useAct(q.reload);
  const [form, setForm] = useState(null);
  return (
    <Block title="Care plans" action="＋ New plan" onAction={() => setForm({})}>
      <T size={12} color={c.mute}>Draft first; the patient sees nothing until you publish. Published versions never change — a revision replaces them and the history stays. "Patient says done" is not the same as you confirming it.</T>
      <Wait q={q} empty={<Empty emoji="🗂️" title="No care plans" sub="Create a plan with goals and actions, then publish it to the patient." />}>
        {(q.data ?? []).map((p) => <PlanCard key={`${p.id}${p.updated_at}`} p={p} act={act} reload={q.reload} edit={setForm} />)}
      </Wait>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.draft ? 'Edit draft' : 'New care plan'} color={c.mint} submitLabel="Save draft" fields={form?.draft ? planFields().filter((f) => f.key !== 'title') : planFields()}
        initial={form?.draft ? planInitial(form.draft.body, form.plan.title) : { review_interval_days: 14 }}
        onSubmit={async (v) => {
          if (form.draft) await api.patch(`/medical/care-plans/${form.plan.id}/draft`, { row_version: form.draft.row_version, body: planBody(v, (form.draft.body.actions ?? []).map((a) => a.key)) });
          else await api.post('/medical/care-plans', { athlete_id: id, title: v.title, body: planBody(v) });
          q.reload(); return 'Saved as a draft';
        }} />
    </Block>
  );
}

// -- Investigations & results --

const valueFields = () => [1, 2, 3].flatMap((n) => [
  { key: `s${n}`, label: `Value ${n}`, type: 'section' },
  { key: `v${n}_name`, label: 'Test', type: 'text', optional: n > 1 },
  { key: `v${n}_value`, label: 'Result exactly as printed', type: 'text', optional: n > 1, show: (v) => n === 1 || !!v[`v${n}_name`] },
  { key: `v${n}_unit`, label: 'Unit', type: 'text', optional: true, show: (v) => n === 1 || !!v[`v${n}_name`] },
  { key: `v${n}_ref`, label: "The report's own reference range", type: 'text', optional: true, show: (v) => n === 1 || !!v[`v${n}_name`] },
]);
export const valuesBody = (v) => [1, 2, 3].filter((n) => v[`v${n}_name`]).map((n) => ({ name: v[`v${n}_name`], value: v[`v${n}_value`], ...(v[`v${n}_unit`] ? { unit: v[`v${n}_unit`] } : {}), ...(v[`v${n}_ref`] ? { reference_interval: v[`v${n}_ref`] } : {}) }));

export function ResultVersions({ results }) {
  return (results ?? []).map((r) => (
    <View key={r.id} style={{ paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="800" size={13}>Result v{r.version_no}</T><Tag label={r.doctor_reviewed ? 'Doctor reviewed' : 'Not yet reviewed by a doctor'} color={r.doctor_reviewed ? c.lime : c.sun} />
        {r.extraction === 'unverified_extraction' ? <Tag label="Auto-extracted, unverified" color={c.orangeSoft} /> : null}<T size={11} color={c.mute}>{r.source} · {day(r.created_at)}</T></View>
      {r.values.map((x, k) => <T key={k} size={13}>{x.name}: <T weight="800" size={13}>{x.value}{x.unit ? ` ${x.unit}` : ''}</T>{x.reference_interval ? <T size={12} color={c.mute}> (report range {x.reference_interval})</T> : null}</T>)}
      {r.document_ref ? <T size={12} color={c.mute}>Original: {r.document_ref}</T> : null}
    </View>
  ));
}

function Results({ id }) {
  const q = useLoad(() => api.get('/medical/investigations', { athlete_id: id, limit: 50 }), [id]);
  const act = useAct(q.reload);
  const [req, setReq] = useState(false);
  const [up, setUp] = useState(null), [rev, setRev] = useState(null), [out, setOut] = useState(null), [hist, setHist] = useState(null);
  return (
    <Block title="Tests & results" action="＋ Request a test" onAction={() => setReq(true)}>
      <T size={12} color={c.mute}>This records a test you asked for — it does not send an order to a lab. A result counts as reviewed only after you review it; the patient opening a report never does.</T>
      <Wait q={q} empty={<Empty emoji="🧪" title="No tests" sub="Record a requested test; the result is added by you or the patient." />}>
        {(q.data ?? []).map((i) => {
          const latest = i.results[i.results.length - 1];
          return (
            <Card key={i.id}>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><T weight="900">{i.test}</T><Tag label={i.priority} color={PRIORITY[i.priority]} /><Tag label={STATUS_LABEL[i.status]} color={i.status === 'received' ? c.sun : i.status === 'closed' ? NEUTRAL : c.cyan} />{i.overdue ? <Tag label="Past review date" color={c.orangeSoft} /> : null}</View>
              {i.indication ? <T size={12} color={c.mute}>Why: {i.indication}</T> : null}{i.review_due ? <T size={12} color={c.mute}>Review by {day(i.review_due)}</T> : null}
              <ResultVersions results={i.results} />
              <Bar>
                {i.status !== 'closed' ? <Btn small title="Add result" color={c.paper} ink={c.ink} onPress={() => setUp(i)} /> : null}
                {i.status === 'received' ? <Btn small title="Review latest result" color={c.mint} ink={c.ink} onPress={() => setRev({ i, latest })} /> : null}
                {i.status === 'reviewed' ? <Btn small title="Record: patient informed" color={c.mint} ink={c.ink} onPress={() => setOut({ i, action: 'patient_informed' })} /> : null}
                {['reviewed', 'patient_informed'].includes(i.status) ? <Btn small title="Close" color={c.paper} ink={c.ink} onPress={() => setOut({ i, action: 'closed' })} /> : null}
                <Btn small title="History" color={c.paper} ink={c.mute} onPress={() => setHist(i.id)} />
              </Bar>
            </Card>
          );
        })}
      </Wait>
      <FormSheet visible={req} onClose={() => setReq(false)} title="Request a test" color={c.mint} submitLabel="Save request"
        fields={[{ key: 'test', label: 'Test or investigation', type: 'text' }, { key: 'indication', label: 'Why', type: 'text', optional: true }, { key: 'priority', label: 'Priority (your clinical choice)', type: 'choice', options: ['routine', 'priority', 'urgent'] },
          { key: 'review_due', label: 'Review by', type: 'date', optional: true, min: todayIso() }, { key: 'external_provider', label: 'Lab or imaging centre', type: 'text', optional: true }, { key: 'external_reference', label: 'Their reference', type: 'text', optional: true }]}
        onSubmit={async (v) => { await api.post('/medical/investigations', { athlete_id: id, ...v }); q.reload(); return 'Recorded'; }} />
      <FormSheet visible={!!up} onClose={() => setUp(null)} title="Add a result" color={c.mint} submitLabel="Add result"
        fields={[...valueFields(), { key: 'document_ref', label: 'Original report reference', type: 'text', optional: true }, { key: 'source', label: 'Source', type: 'choice', options: [{ value: 'provider', label: 'Our clinic' }, { value: 'external', label: 'External lab' }] }, { key: 'auto', label: 'Extracted automatically (unverified)', type: 'switch', default: false }]}
        onSubmit={async (v) => { await api.post(`/medical/investigations/${up.id}/results`, { values: valuesBody(v), ...(v.document_ref ? { document_ref: v.document_ref } : {}), source: v.source, extraction: v.auto ? 'unverified_extraction' : 'manual' }); q.reload(); return 'Result added — review it when ready'; }} />
      <FormSheet visible={!!rev} onClose={() => setRev(null)} title={`Review: ${rev?.i.test ?? ''}`} color={c.mint} submitLabel="I have reviewed this result"
        fields={[{ key: 'note', label: 'Your note (private to clinicians)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/medical/investigations/${rev.i.id}/review`, { result_id: rev.latest.id, ...v }); q.reload(); return 'Reviewed'; }} />
      <FormSheet visible={!!out} onClose={() => setOut(null)} title={out?.action === 'closed' ? 'Close this test' : 'Patient informed'} color={c.mint} submitLabel="Save"
        fields={[{ key: 'note', label: out?.action === 'closed' ? 'Outcome / follow-up arranged' : 'How and what the patient was told', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/medical/investigations/${out.i.id}/outcome`, { action: out.action, ...v }); q.reload(); return 'Saved'; }} />
      {hist ? <HistorySheet id={hist} onClose={() => setHist(null)} /> : null}
    </Block>
  );
}

export function HistorySheet({ id, onClose }) {
  const h = useLoad(() => api.get(`/medical/investigations/${id}/history`), [id]);
  return (
    <Sheet visible onClose={onClose} title="History">
      {h.loading ? <Loading /> : (h.data?.events ?? []).map((e) => <T key={e.id} size={13}>• {e.action.replace('_', ' ')} — {e.actor_name}, {when(e.created_at)}{e.note ? ` — ${e.note}` : ''}</T>)}
    </Sheet>
  );
}

// -- Referrals (per patient) --

function ReferralSheet({ athleteId, onClose, onDone }) {
  const [kind, setKind] = useState('platform');
  const [to, setTo] = useState([]);
  const slots = [1, 2, 3];
  return (
    <Sheet visible onClose={onClose} title="Refer this patient">
      <T size={13} color={c.mute}>Only the items you write below are shared — no records, notes or reports come along. The patient must agree before the recipient can see anything.</T>
      <Seg options={[{ value: 'platform', label: 'Doctor / physio here' }, { value: 'external', label: 'Outside provider' }]} value={kind} onChange={setKind} color={c.mint} />
      {kind === 'platform' ? <EntityPicker label="Refer to" value={to} onChange={setTo} noun="doctor or physio" /> : null}
      <FormSheet inline color={c.mint} submitLabel="Save draft" onClose={onClose}
        fields={[...(kind === 'external' ? [{ key: 'external_recipient', label: 'Provider or clinic', type: 'text' }] : []), { key: 'reason', label: 'Reason for referral', type: 'multiline' }, { key: 'requested_action', label: 'What you are asking for', type: 'text', optional: true },
          { key: 'urgency', label: 'Urgency (your clinical choice)', type: 'choice', options: ['routine', 'priority', 'urgent'] },
          ...slots.flatMap((n) => [{ key: `i${n}_label`, label: `Shared item ${n}`, type: 'text', optional: n > 1, hint: n === 1 ? 'A short title, e.g. "MRI summary".' : undefined }, { key: `i${n}_text`, label: 'What is shared', type: 'multiline', optional: n > 1, show: (v) => n === 1 || !!v[`i${n}_label`] }]),
          { key: 'expires_at', label: 'Expires on', type: 'date', optional: true, min: todayIso() }]}
        onSubmit={async (v) => {
          if (kind === 'platform' && !to[0]) throw new Error('Choose who to refer to');
          await api.post('/medical/referrals', { athlete_id: athleteId, ...(kind === 'platform' ? { to_provider_id: to[0].id } : { external_recipient: v.external_recipient }), reason: v.reason, ...(v.requested_action ? { requested_action: v.requested_action } : {}), urgency: v.urgency,
            shared: slots.filter((n) => v[`i${n}_label`]).map((n) => ({ label: v[`i${n}_label`], text: v[`i${n}_text`] })), ...(v.expires_at ? { expires_at: `${v.expires_at}T23:59:00Z` } : {}) });
          onDone(); return 'Draft saved — send it for the patient\'s consent';
        }} />
    </Sheet>
  );
}

function PatientReferrals({ id }) {
  const q = useLoad(async () => (await api.get('/medical/referrals', { box: 'sent', limit: 100 })).filter((r) => r.athlete_id === id), [id]);
  const act = useAct(q.reload);
  const [form, setForm] = useState(false);
  return (
    <Block title="Referrals" action="＋ New referral" onAction={() => setForm(true)}>
      <Wait q={q} empty={<Empty emoji="↗️" title="No referrals for this patient" sub="Choose exactly what to share; the patient agrees before anyone else sees it." />}>
        {(q.data ?? []).map((r) => <ReferralCard key={r.id} r={r} act={act} onChanged={q.reload} mine="sent" />)}
      </Wait>
      {form ? <ReferralSheet athleteId={id} onClose={() => setForm(false)} onDone={q.reload} /> : null}
    </Block>
  );
}

// -- Clearance --

const CLR = { cleared: ['Cleared', c.lime], restricted: ['Restricted', c.sun], not_cleared: ['Not cleared', c.red], expired: ['Expired', c.orangeSoft], unknown: ['Unknown', NEUTRAL] };

export function ClearanceCard({ x, children }) {
  const [l, col] = CLR[x.status];
  return (
    <Card pad={12}><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={l} color={col} /><Tag label={x.state} color={x.state === 'current' ? c.lime : NEUTRAL} />{x.activity ? <T size={12} color={c.mute}>{x.activity}</T> : null}</View>
      <T size={12} color={c.mute}>Assessed {day(x.assessed_on)}{x.valid_until ? ` · valid until ${day(x.valid_until)}` : ''}{x.review_by ? ` · review by ${day(x.review_by)}` : ''}</T>
      {(x.restrictions ?? []).map((r, k) => <T key={k} size={13}>• {r.activity}: {r.limit}</T>)}{children}</Card>
  );
}

function Clearance({ id }) {
  const q = useLoad(() => api.get('/medical/clearances', { athlete_id: id, limit: 50 }), [id]);
  const sports = useLoad(() => api.get('/sports'), []);
  const act = useAct(q.reload);
  const { user } = useSession();
  const [form, setForm] = useState(false), [wd, setWd] = useState(null);
  const sportId = (slug) => (slug ? sports.data?.find((s) => s.slug === slug)?.id : undefined);
  return (
    <Block title="Fit to play" action="＋ New decision" onAction={() => setForm(true)}>
      <T size={12} color={c.mute}>Your decision, separate from payment or rehab progress. Restrictions are shared with the athlete's coaches — say what they may or may not do, never the diagnosis. Past its end date a clearance shows as expired.</T>
      <Wait q={q} empty={<Empty emoji="✅" title="No decisions yet" sub="Until you decide, the athlete's status is unknown." />}>
        {(q.data ?? []).map((x) => (
          <ClearanceCard key={x.id} x={x}>
            {x.internal_note ? <T size={12} color={c.mute}>Private note: {x.internal_note}</T> : null}{x.withdrawn_reason ? <T size={12} color={c.red}>Withdrawn: {x.withdrawn_reason}</T> : null}
            {x.state === 'current' && x.doctor_id === user.id ? <Bar><Btn small title="Withdraw" color={c.paper} ink={c.red} onPress={() => setWd(x)} /></Bar> : null}
          </ClearanceCard>
        ))}
      </Wait>
      <FormSheet visible={form} onClose={() => setForm(false)} title="Fit-to-play decision" color={c.mint} submitLabel="Record decision"
        fields={[{ key: 'status', label: 'Decision', type: 'choice', options: [{ value: 'cleared', label: 'Cleared' }, { value: 'restricted', label: 'Restricted' }, { value: 'not_cleared', label: 'Not cleared' }] },
          { key: 'sport', label: 'Sport (leave empty for all sports)', type: 'sport', optional: true }, { key: 'activity', label: 'Activity context', type: 'text', optional: true, hint: 'For example match play or contact training.' },
          { key: 'assessed_on', label: 'Assessed on', type: 'date', max: todayIso(), default: todayIso() },
          { key: 'valid_until', label: 'Valid until', type: 'date', min: todayIso(), show: (v) => v.status !== 'not_cleared', hint: 'Required so a clearance cannot silently go stale.' },
          { key: 'review_by', label: 'Review by', type: 'date', optional: true, min: todayIso() },
          ...[1, 2, 3].flatMap((n) => [{ key: `r${n}_activity`, label: `Restriction ${n} — activity`, type: 'text', optional: true, show: (v) => v.status === 'restricted' && (n === 1 || !!v[`r${n - 1}_activity`]) }, { key: `r${n}_limit`, label: 'Limit', type: 'text', optional: true, show: (v) => v.status === 'restricted' && !!v[`r${n}_activity`] }]),
          { key: 'internal_note', label: 'Private note (never shared)', type: 'multiline', optional: true }]}
        initial={{ assessed_on: todayIso() }}
        onSubmit={async (v) => {
          const restrictions = [1, 2, 3].filter((n) => v[`r${n}_activity`]).map((n) => ({ activity: v[`r${n}_activity`], limit: v[`r${n}_limit`] }));
          await api.post('/medical/clearances', { athlete_id: id, status: v.status, ...(sportId(v.sport) ? { sport_id: sportId(v.sport) } : {}), ...(v.activity ? { activity: v.activity } : {}), assessed_on: v.assessed_on, ...(v.valid_until ? { valid_until: v.valid_until } : {}), ...(v.review_by ? { review_by: v.review_by } : {}), restrictions, ...(v.internal_note ? { internal_note: v.internal_note } : {}) });
          q.reload(); return 'Recorded — the athlete is notified';
        }} />
      <Confirm visible={!!wd} title="Withdraw this decision?" yes="Withdraw" danger askReason="Why?" body="The athlete's status returns to the previous record or unknown. The decision stays in history." onClose={() => setWd(null)}
        onYes={async (reason) => { await act(() => api.post(`/medical/clearances/${wd.id}/withdraw`, { reason: reason || 'Withdrawn' }), 'Withdrawn'); setWd(null); }} />
    </Block>
  );
}
