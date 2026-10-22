// Physio rehab tracking, the physio's counterpart of the coach's performance studio: a patient file (session notes, progress readings, goals,
// home exercise, reports), suggestions drawn from the clinician's own records, practice insights - and the patient's own progress view.
// Every action is a capability that already exists (REST/OpenAPI/MCP); session notes are the same encounters the doctor workspace uses.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { Btn, Card, Empty, ErrorBox, H2, Loading, Row, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { Counter, DateRangeField } from '../pickers';
import { Encounters } from './doctor';
import { c, day } from '../theme';

const label = (v) => String(v).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const REGIONS = ['neck', 'shoulder', 'elbow', 'wrist_hand', 'upper_back', 'lower_back', 'hip', 'knee', 'ankle_foot', 'core', 'full_body'];
const SIDES = [['left', 'Left'], ['right', 'Right'], ['both', 'Both']];
const opts = (list) => list.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: label(x) }));
const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const PRIORITY = { high: [c.red, 'Act soon'], medium: [c.sun, 'Soon'], low: [c.violetSoft, 'When you can'] };
const GOAL_TAG = { active: c.cyan, achieved: c.lime, not_met: c.orangeSoft, discontinued: c.violetSoft };
const fmt = (v, unit) => (v == null ? '–' : unit === '/10' ? `${v}/10` : `${v}${unit && unit !== '%' ? ' ' : ''}${unit ?? ''}`.replace(' °', '°'));
const seriesName = (s) => `${s.label}${s.body_region ? ` · ${label(s.body_region)}` : ''}${s.side ? ` (${s.side})` : ''}`;
const FALLBACK = { pain: { label: 'Pain', unit: '/10', min: 0, max: 10, site: false }, range_of_motion: { label: 'Range of motion', unit: '°', min: 0, max: 360, site: true }, strength: { label: 'Strength', unit: 'kg', min: 0, max: 1000, site: true }, function_score: { label: 'Function score', unit: '%', min: 0, max: 100, site: false }, balance_hold: { label: 'Single-leg balance', unit: 's', min: 0, max: 600, site: true }, swelling: { label: 'Swelling (girth)', unit: 'cm', min: 0, max: 200, site: true } };

function useAct(...reloads) {
  const { toast } = useSession();
  return async (fn, msg) => { try { await fn(); toast(msg); reloads.forEach((r) => r?.()); return true; } catch (e) { toast('' + e.message); return false; } };
}
const Wait = ({ q, children }) => (q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : children(q.data));
const Bar = ({ children }) => <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>{children}</View>;

/** A small bar trend of the readings, oldest left. */
function Trend({ points }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.value), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 34, marginTop: 6 }} accessibilityLabel={`Trend of ${points.length} readings`}>
      {points.slice(-24).map((p) => <View key={p.id} style={{ flex: 1, maxWidth: 14, minHeight: 4, height: 6 + (28 * (p.value - lo)) / span, backgroundColor: c.violet, borderRadius: 3, opacity: 0.85 }} />)}
    </View>
  );
}

const DIRECTION = { improved: ['improved', c.lime], worse: ['worse', c.orangeSoft], unchanged: ['no change', c.violetSoft] };
export function SeriesCard({ s, onVoid }) {
  const dir = s.direction && DIRECTION[s.direction];
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flex: 1 }}><T weight="800">{seriesName(s)}</T><T size={12} color={c.mute}>{s.count} reading{s.count === 1 ? '' : 's'} · latest {day(s.latest.measured_at)}</T></View>
        <View style={{ alignItems: 'flex-end' }}><T weight="900" size={18}>{fmt(s.latest.value, s.unit)}</T>{dir ? <Tag label={`${dir[0]} ${s.change > 0 ? '+' : ''}${s.change}`} color={dir[1]} /> : null}</View>
      </View>
      {s.count > 1 ? <T size={12} color={c.mute}>Started at {fmt(s.baseline.value, s.unit)} on {day(s.baseline.measured_at)}</T> : null}
      <Trend points={s.points} />
      {onVoid ? s.points.slice(-3).reverse().map((p) => (
        <View key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <T size={12} color={c.mute} style={{ flex: 1 }}>{day(p.measured_at)}: {fmt(p.value, s.unit)}{p.note ? ` · ${p.note}` : ''}</T>
          <Btn small title="Wrong?" color={c.paper} ink={c.red} onPress={() => onVoid(p)} />
        </View>)) : null}
    </Card>
  );
}

/** Snapshot of a report (the same shape for the clinician's preview and the patient's copy). */
export function SnapshotView({ s }) {
  return (
    <View style={{ gap: 8 }}>
      <T size={12} color={c.mute}>{s.provider.name} · {day(s.period.from)} to {day(s.period.to)}{s.plan ? ` · ${s.plan.title}` : ''}</T>
      {s.narrative ? <Card pad={12} color={c.mintSoft}><T size={13}>{s.narrative}</T></Card> : null}
      <T size={13}><T weight="800" size={13}>Sessions: </T>{s.sessions.signed_notes} recorded · {s.sessions.appointments_completed} appointment{s.sessions.appointments_completed === 1 ? '' : 's'} completed</T>
      {s.outcomes.map((o) => <T key={o.key} size={13}><T weight="800" size={13}>{seriesName(o)}: </T>{o.count > 1 ? `${fmt(o.baseline.value, o.unit)} → ${fmt(o.latest.value, o.unit)} (${o.direction === 'improved' ? 'improved' : o.direction === 'worse' ? 'worse' : 'no change'} by ${Math.abs(o.change)})` : `${fmt(o.latest.value, o.unit)} (one reading)`}</T>)}
      {s.goals.map((g) => <T key={g.id} size={13}><T weight="800" size={13}>Goal: </T>{g.title} · {label(g.status)}{g.progress?.percent != null ? ` · ${g.progress.percent}%` : ''}</T>)}
      {s.adherence ? <T size={13}><T weight="800" size={13}>Home exercise: </T>{s.adherence.days_done} full and {s.adherence.days_partial} partial day{s.adherence.days_done + s.adherence.days_partial === 1 ? '' : 's'} logged of about {s.adherence.expected_days} expected{s.adherence.percent != null ? ` (${s.adherence.percent}%)` : ''}</T> : null}
      <T size={11} color={c.mute}>{s.note}</T>
    </View>
  );
}

// ------------------------------------------------------------------ value inputs that fit each measure
/** Pain and the function score use steppers; the rest take a typed number. Keys are `${key}_step`, `${key}_step2` and `${key}_num`. */
const valueFields = (key, text, show = () => true) => [
  { key: `${key}_step`, label: text, type: 'stepper', min: 0, max: 10, step: 1, suffix: '/10', show: (v) => show(v) && v.measure === 'pain' },
  { key: `${key}_step2`, label: text, type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', show: (v) => show(v) && v.measure === 'function_score' },
  { key: `${key}_num`, label: text, type: 'number', hint: 'Use the unit shown for this measure: degrees, kg, seconds or cm.', show: (v) => show(v) && !!v.measure && !['pain', 'function_score'].includes(v.measure) },
];
const readValue = (v, key) => (v.measure === 'pain' ? v[`${key}_step`] : v.measure === 'function_score' ? v[`${key}_step2`] : v[`${key}_num`]);
const siteFields = (measures) => [
  { key: 'region_req', label: 'Body region', type: 'chips', options: opts(REGIONS), show: (v) => !!measures[v.measure]?.site },
  { key: 'region_opt', label: 'Body region', type: 'chips', optional: true, options: opts(REGIONS), show: (v) => !!v.measure && !measures[v.measure]?.site },
  { key: 'side', label: 'Side', type: 'chips', optional: true, options: opts(SIDES), show: (v) => !!(v.region_req || v.region_opt) },
];
const siteOf = (v) => ({ ...(v.region_req || v.region_opt ? { body_region: v.region_req || v.region_opt } : {}), ...(v.side && (v.region_req || v.region_opt) ? { side: v.side } : {}) });

// ------------------------------------------------------------------ patient file
function Progress({ id, data, reload }) {
  const [form, setForm] = useState(false), [voiding, setVoiding] = useState(null);
  const measures = data.measures ?? FALLBACK;
  const livePlans = data.plans.filter((p) => ['active', 'paused'].includes(p.status));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><H2>Progress</H2><Btn small title="＋ Record a reading" color={c.mint} ink={c.ink} onPress={() => setForm(true)} /></View>
      <T size={12} color={c.mute}>Measured readings over time. A reading is never edited: if one is wrong, void it with a reason and record it again. "Improved" only describes the recorded numbers.</T>
      {data.outcomes.length ? data.outcomes.map((s) => <SeriesCard key={s.key} s={s} onVoid={setVoiding} />) : <Empty emoji="📈" title="No readings yet" sub="Record pain, range of motion, strength or a function score to start tracking progress." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Record a reading" color={c.mint} submitLabel="Save reading"
        initial={{ measure: 'pain', value_step: 5, value_step2: 50 }}
        fields={[{ key: 'measure', label: 'What was measured', type: 'chips', options: Object.entries(measures).map(([k, m]) => ({ value: k, label: m.label })) },
          ...siteFields(measures), ...valueFields('value', 'Value'),
          { key: 'measured_on', label: 'Measured on', type: 'date', optional: true, max: todayIso(), hint: 'Leave empty for now.' },
          ...(livePlans.length ? [{ key: 'plan_id', label: 'Treatment plan', type: 'chips', optional: true, options: livePlans.map((p) => ({ value: p.id, label: p.title })) }] : []),
          { key: 'note', label: 'Note (only you see this)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          const value = readValue(v, 'value');
          if (value === undefined || value === null || Number.isNaN(Number(value))) throw new Error('Enter the value');
          await api.post('/physio/outcomes', { patient_id: id, measure: v.measure, value: Number(value), ...siteOf(v), ...(v.measured_on && v.measured_on !== todayIso() ? { measured_at: new Date(`${v.measured_on}T12:00:00`).toISOString() } : {}), ...(v.plan_id ? { plan_id: v.plan_id } : {}), ...(v.note ? { note: v.note } : {}) });
          reload(); return 'Reading saved';
        }} />
      <FormSheet visible={!!voiding} onClose={() => setVoiding(null)} title="Void this reading" color={c.red} submitLabel="Void reading"
        fields={[{ key: 'reason', label: 'Why is it wrong?', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/physio/outcomes/${voiding.id}/void`, { reason: v.reason }); reload(); return 'Voided — it no longer counts, but is kept for audit'; }} />
    </View>
  );
}

function Goals({ id, data, reload }) {
  const [form, setForm] = useState(false), [closing, setClosing] = useState(null);
  const act = useAct(reload);
  const measures = data.measures ?? FALLBACK;
  const livePlans = data.plans.filter((p) => ['active', 'paused'].includes(p.status));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><H2>Goals</H2><Btn small title="＋ Set a goal" color={c.mint} ink={c.ink} onPress={() => setForm(true)} /></View>
      <T size={12} color={c.mute}>A measured goal tracks progress from its starting value to its target using the readings you record. Closed goals stay as a record.</T>
      {data.goals.length ? data.goals.map((g) => (
        <Card key={g.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{g.title}</T><Tag label={label(g.status)} color={GOAL_TAG[g.status]} /></View>
          {g.measure ? <T size={12} color={c.mute}>{measures[g.measure]?.label ?? label(g.measure)}{g.body_region ? ` · ${label(g.body_region)}` : ''} · {fmt(g.baseline, g.unit)} → {fmt(g.target, g.unit)}{g.progress.latest ? ` · now ${fmt(g.progress.latest.value, g.unit)} (${g.progress.percent}%)` : ' · no reading since the goal was set'}</T> : null}
          {g.target_date ? <T size={12} color={c.mute}>Aim: {day(g.target_date)}</T> : null}
          {!g.shared ? <T size={11} color={c.mute}>Not shown to the patient</T> : null}
          {g.closing_note ? <T size={12}>{g.closing_note}</T> : null}
          {g.status === 'active' ? <Bar>{g.progress.met ? <Btn small title="Mark achieved" color={c.mint} ink={c.ink} onPress={() => act(() => api.patch(`/physio/goals/${g.id}`, { row_version: g.row_version, status: 'achieved' }), 'Goal achieved')} /> : null}<Btn small title="Close goal…" color={c.paper} ink={c.ink} onPress={() => setClosing(g)} /></Bar> : null}
        </Card>
      )) : <Empty emoji="🎯" title="No goals yet" sub="Set a goal such as getting pain under 2/10 or reaching 40° of ankle movement." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Set a goal" color={c.mint} submitLabel="Set goal"
        initial={{ kind: 'statement', measure: 'pain', base_step: 7, target_step: 2, base_step2: 50, target_step2: 80, shared: true }}
        fields={[{ key: 'title', label: 'Goal' }, { key: 'kind', label: 'How will you know?', type: 'choice', options: [{ value: 'statement', label: 'In words' }, { value: 'measured', label: 'By a measurement' }] },
          { key: 'measure', label: 'Measure', type: 'chips', options: Object.entries(measures).map(([k, m]) => ({ value: k, label: m.label })), show: (v) => v.kind === 'measured' },
          ...siteFields(measures).map((f) => ({ ...f, show: (v) => v.kind === 'measured' && f.show(v) })),
          ...valueFields('base', 'Starting value', (v) => v.kind === 'measured'),
          ...valueFields('target', 'Target', (v) => v.kind === 'measured'),
          { key: 'target_date', label: 'Aim to reach it by', type: 'date', optional: true, min: todayIso() },
          ...(livePlans.length ? [{ key: 'plan_id', label: 'Treatment plan', type: 'chips', optional: true, options: livePlans.map((p) => ({ value: p.id, label: p.title })) }] : []),
          { key: 'shared', label: 'Show to the patient', type: 'switch' }]}
        onSubmit={async (v) => {
          const measured = v.kind === 'measured';
          const baseline = measured ? readValue(v, 'base') : undefined, target = measured ? readValue(v, 'target') : undefined;
          if (measured && (baseline == null || target == null || Number.isNaN(Number(baseline)) || Number.isNaN(Number(target)))) throw new Error('Enter the starting value and the target');
          await api.post('/physio/goals', { patient_id: id, title: v.title, shared: v.shared, ...(v.target_date ? { target_date: v.target_date } : {}), ...(v.plan_id ? { plan_id: v.plan_id } : {}), ...(measured ? { measure: v.measure, baseline: Number(baseline), target: Number(target), ...siteOf(v) } : {}) });
          reload(); return 'Goal set';
        }} />
      <FormSheet visible={!!closing} onClose={() => setClosing(null)} title="Close this goal" color={c.mint} submitLabel="Close goal"
        initial={{ status: 'achieved' }}
        fields={[{ key: 'status', label: 'Outcome', type: 'chips', options: [{ value: 'achieved', label: 'Achieved' }, { value: 'not_met', label: 'Not met' }, { value: 'discontinued', label: 'Stopped' }] }, { key: 'closing_note', label: 'Note', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/physio/goals/${closing.id}`, { row_version: closing.row_version, status: v.status, ...(v.closing_note ? { closing_note: v.closing_note } : {}) }); reload(); return 'Goal closed'; }} />
    </View>
  );
}

function HomeExercise({ data }) {
  const plans = data.plans.filter((p) => p.published_version != null);
  const [open, setOpen] = useState(null);
  return (
    <View style={{ gap: 8 }}>
      <H2>Home exercise</H2>
      <T size={12} color={c.mute}>What the patient says they did, against the days a week your plan asks for. It is their own log: it is not monitored live and does not prove the exercise was done correctly.</T>
      {plans.length ? plans.map((p) => {
        const a = p.adherence;
        return (
          <Card key={p.id} pad={12} onPress={() => setOpen(p.id)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{p.title}</T><T size={12} color={c.mute}>{label(p.status)} · version {p.published_version}</T></View><T weight="900" size={20}>{a?.percent != null ? `${a.percent}%` : '–'}</T></View>
            {a ? <T size={12} color={c.mute}>Last 28 days: {a.days_done} done · {a.days_partial} partial · {a.days_skipped} skipped of about {a.expected_days} expected{a.avg_pain != null ? ` · average pain ${a.avg_pain}/10` : ''}{a.last_logged_on ? ` · last logged ${day(a.last_logged_on)}` : ' · nothing logged yet'}</T> : null}
          </Card>);
      }) : <Empty emoji="🏠" title="No published plans" sub="Publish a treatment plan to see how the patient gets on at home." />}
      {open ? <AdherenceSheet planId={open} onClose={() => setOpen(null)} /> : null}
    </View>
  );
}

function AdherenceSheet({ planId, onClose }) {
  const q = useLoad(() => api.get(`/treatment-plans/${planId}/adherence`), [planId]);
  return (
    <Sheet visible onClose={onClose} title={q.data?.title ?? 'Home exercise'}>
      <Wait q={q}>{(d) => d.days.length ? d.days.map((x) => (
        <Card key={x.id} pad={10}>
          <T weight="800">{day(x.done_on)} · {label(x.status)}</T>
          <T size={12} color={c.mute}>{[x.pain != null ? `pain ${x.pain}/10` : null, x.effort != null ? `effort ${x.effort}/10` : null].filter(Boolean).join(' · ') || 'No pain or effort noted'}</T>
          {x.note ? <T size={13}>{x.note}</T> : null}
        </Card>)) : <Empty emoji="🏠" title="Nothing logged in this period" />}</Wait>
    </Sheet>
  );
}

const REPORT_TAG = { draft: c.sun, published: c.lime };
function Reports({ id, data, reload: reloadFile }) {
  const q = useLoad(() => api.get('/physio/reports', { patient_id: id, limit: 50 }), [id]);
  const [form, setForm] = useState(null), [view, setView] = useState(null);
  const act = useAct(q.reload, reloadFile);
  const { toast } = useSession();
  const plans = data.plans.filter((p) => p.status !== 'draft');
  const reload = () => { q.reload(); reloadFile(); };
  const preview = async (r) => { try { setView({ r, snapshot: await api.get(`/physio/reports/${r.id}/preview`) }); } catch (e) { toast('' + e.message); } };
  const open = async (r) => { try { const d = await api.get(`/physio/reports/${r.id}`); setView({ r, snapshot: d.snapshot, versions: d.versions }); } catch (e) { toast('' + e.message); } };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><H2>Reports</H2><Btn small title="＋ New report" color={c.mint} ink={c.ink} onPress={() => setForm({})} /></View>
      <T size={12} color={c.mute}>A report freezes the figures at the moment you publish it; later changes make a new version. Choose whether the patient can read it. The words in the narrative are yours.</T>
      <Wait q={q}>{(rows) => rows.length ? rows.map((r) => (
        <Card key={r.id} pad={12}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{r.title}</T><Tag label={r.status === 'draft' ? 'draft' : `v${r.latest_version}`} color={REPORT_TAG[r.status]} /></View>
          <T size={12} color={c.mute}>{label(r.kind)} · {day(r.period_from)} to {day(r.period_to)} · {r.audience === 'patient' ? 'patient can read' : 'private to you'}{r.latest_version && r.audience === 'patient' ? (r.latest_read_at ? ' · patient has read it' : ' · not yet read') : ''}</T>
          <Bar>
            <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm(r)} />
            <Btn small title="Preview" color={c.violet} onPress={() => preview(r)} />
            <Btn small title="Publish" color={c.mint} ink={c.ink} onPress={() => act(() => api.post(`/physio/reports/${r.id}/publish`, { row_version: r.row_version }), r.audience === 'patient' ? 'Published — the patient is notified' : 'Published to your file')} />
            {r.latest_version ? <Btn small title="Open issued" color={c.paper} ink={c.ink} onPress={() => open(r)} /> : null}
          </Bar>
        </Card>
      )) : <Empty emoji="📄" title="No reports yet" sub="Write a progress report for the patient, a referrer or your own file." />}</Wait>
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit report' : 'New report'} color={c.mint} submitLabel={form?.id ? 'Save' : 'Create draft'}
        initial={form?.id ? { title: form.title, kind: form.kind, audience: form.audience, plan_id: form.plan_id ?? undefined, period_from: form.period_from, period_to: form.period_to, narrative: form.narrative ?? '' } : { kind: 'progress', audience: 'private', period_from: addDays(todayIso(), -42), period_to: todayIso() }}
        fields={[{ key: 'title', label: 'Title' }, { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'progress', label: 'Progress' }, { value: 'discharge', label: 'Discharge' }] },
          { key: 'period_from', label: 'Period', type: 'daterange', toKey: 'period_to' },
          ...(plans.length ? [{ key: 'plan_id', label: 'Treatment plan', type: 'chips', optional: true, options: plans.map((p) => ({ value: p.id, label: p.title })) }] : []),
          { key: 'audience', label: 'Who can read it', type: 'choice', options: [{ value: 'private', label: 'Only me' }, { value: 'patient', label: 'The patient too' }] },
          { key: 'narrative', label: 'Your summary in words', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          await api.post('/physio/reports', { ...(form?.id ? { id: form.id, row_version: form.row_version } : { patient_id: id }), title: v.title, kind: v.kind, audience: v.audience, period_from: v.period_from, period_to: v.period_to, ...(v.plan_id ? { plan_id: v.plan_id } : {}), ...(v.narrative ? { narrative: v.narrative } : {}) });
          reload(); return form?.id ? 'Draft saved' : 'Draft created — preview it, then publish';
        }} />
      {view ? (
        <Sheet visible onClose={() => setView(null)} title={view.r.title}>
          <Tag label={view.versions ? `Issued version ${view.snapshot.version}` : 'Preview — not published'} color={view.versions ? c.lime : c.sun} />
          <SnapshotView s={view.snapshot} />
          {view.versions ? view.versions.map((x) => <T key={x.version} size={12} color={c.mute}>Version {x.version} · {day(x.published_at)} · {x.audience === 'patient' ? (x.read_at ? `patient read ${day(x.read_at)}` : 'patient has not read it') : 'private'}</T>) : null}
        </Sheet>) : null}
    </View>
  );
}

const FILE_TABS = [{ value: 'sessions', label: 'Sessions', emoji: '📝' }, { value: 'progress', label: 'Progress', emoji: '📈' }, { value: 'goals', label: 'Goals', emoji: '🎯' }, { value: 'home', label: 'Home exercise', emoji: '🏠' }, { value: 'reports', label: 'Reports', emoji: '📄' }];

function PatientFile({ patient, section, onBack }) {
  const [tab, setTab] = useState(section ?? 'sessions');
  const q = useLoad(() => api.get(`/physio/patients/${patient.athlete_id}/progress`), [patient.athlete_id]);
  const s = q.data?.sessions;
  return (
    <View style={{ gap: 10 }}>
      <Btn small title="‹ All patients" color={c.paper} ink={c.ink} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <H2>{patient.display_name}</H2>
      <Card color={c.mintSoft} pad={12}><T weight="800">Shared with you by the patient</T><T size={12} color={c.mute}>You see this file while they keep access on and your verification is current. Reads and writes are logged.</T></Card>
      {s ? <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><StatPill value={s.signed_notes} label="NOTES" /></View><View style={{ flex: 1 }}><StatPill value={s.appointments_completed} label="VISITS" /></View><View style={{ flex: 1 }}><StatPill value={q.data.goals.filter((g) => g.status === 'active').length} label="OPEN GOALS" /></View></View> : null}
      <Seg options={FILE_TABS} value={tab} onChange={setTab} color={c.mint} />
      {tab === 'sessions' ? <Encounters id={patient.athlete_id} title="Session notes" /> : (
        <Wait q={q}>{(d) => (tab === 'progress' ? <Progress id={patient.athlete_id} data={d} reload={q.reload} /> : tab === 'goals' ? <Goals id={patient.athlete_id} data={d} reload={q.reload} /> : tab === 'home' ? <HomeExercise data={d} /> : <Reports id={patient.athlete_id} data={d} reload={q.reload} />)}</Wait>)}
    </View>
  );
}

export function PatientsTab({ focus, onFocusDone }) {
  const q = useLoad(() => api.get('/medical/patients', { limit: 100 }), []);
  const [open, setOpen] = useState(null);
  const target = open ?? (focus && q.data ? { patient: q.data.find((p) => p.athlete_id === focus.patient_id), section: focus.section } : null);
  const back = () => { setOpen(null); onFocusDone?.(); };
  if (target?.patient) return <PatientFile key={target.patient.athlete_id} patient={target.patient} section={target.section} onBack={back} />;
  return (
    <Section title="Patients" color={c.mint}>
      <T size={13} color={c.mute}>People who shared their records with you. Open one to write session notes, record readings, set goals, see their home exercise and send reports.</T>
      <Wait q={q}>{(rows) => {
        const full = rows.filter((p) => p.scope === 'full');
        return full.length ? full.map((p) => <Row key={p.athlete_id} title={p.display_name} sub={p.handle ? `@${p.handle}` : undefined} right={<Tag label="Full access" color={c.lime} />} onPress={() => setOpen({ patient: p })} />)
          : <Empty emoji="🧑‍⚕️" title="No patients yet" sub="Patients appear here after they share their records from an appointment." />;
      }}</Wait>
    </Section>
  );
}

// ------------------------------------------------------------------ suggestions
export function Suggestions({ items, onOpen, reload, empty = true }) {
  const act = useAct(reload);
  if (!items.length) return empty ? <Empty emoji="✅" title="Nothing needs you right now" sub="Prompts appear here from your own records: reviews due, home exercise missed, pain rising, goals due, notes unsigned." /> : null;
  return items.map((x) => (
    <Card key={x.key} pad={12} color={x.priority === 'high' ? c.pinkSoft : c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{x.title}</T><Tag label={PRIORITY[x.priority][1]} color={PRIORITY[x.priority][0]} /></View>
      <T size={12} weight="700">{x.patient_name}</T>
      <T size={12} color={c.mute}>{x.reason}</T>
      <Bar>
        <Btn small title="Open" color={c.violet} onPress={() => onOpen(x)} />
        <Btn small title="Not now (7 days)" color={c.paper} ink={c.ink} onPress={() => act(() => api.post('/physio/suggestions/snooze', { key: x.key, days: 7 }), 'Hidden for a week')} />
      </Bar>
    </Card>
  ));
}

// ------------------------------------------------------------------ insights
const bar = (n, total, color) => <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: `${total ? Math.min(100, (100 * n) / total) : 0}%`, height: 8, backgroundColor: color }} /></View>;

export function Insights({ onOpen }) {
  const [range, setRange] = useState({ from: addDays(todayIso(), -89), to: todayIso() });
  const an = useLoad(() => api.get('/physio/analytics', range), [range.from, range.to]);
  const sug = useLoad(() => api.get('/physio/suggestions'), []);
  return (
    <View style={{ gap: 12 }}>
      <Section title="Suggestions" color={c.pink}>
        <T size={12} color={c.mute}>Reminders drawn from your own records, most urgent first. They are prompts, not clinical advice, and nothing happens automatically.</T>
        <Wait q={sug}>{(d) => <Suggestions items={d.items} onOpen={onOpen} reload={sug.reload} />}</Wait>
      </Section>
      <Section title="Practice insights" color={c.cyan}>
        <DateRangeField label="Period" from={range.from} to={range.to} onChange={(r) => r.from && setRange({ from: r.from, to: r.to ?? r.from })} />
        <Wait q={an}>{(a) => (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}><View style={{ flex: 1 }}><StatPill value={a.appointments.completed} label="VISITS" /></View><View style={{ flex: 1 }}><StatPill value={a.patients.seen} label="PATIENTS" /></View><View style={{ flex: 1 }}><StatPill value={a.patients.return_pct != null ? `${a.patients.return_pct}%` : '–'} label="RETURNING" /></View></View>
            <Card pad={12}><T weight="800">Visits</T><T size={12} color={c.mute}>{a.appointments.hours} hours · {a.patients.new} new patient{a.patients.new === 1 ? '' : 's'} · {a.appointments.cancelled} cancelled{a.appointments.cancellation_pct != null ? ` (${a.appointments.cancellation_pct}%)` : ''} · {a.appointments.upcoming} coming up</T></Card>
            <Card pad={12}><T weight="800">Session notes</T><T size={12} color={c.mute}>{a.notes.completed_with_signed_note} of {a.notes.of_completed} completed visits have a signed note{a.notes.pct != null ? ` (${a.notes.pct}%)` : ''}</T>{bar(a.notes.completed_with_signed_note, a.notes.of_completed, c.mint)}</Card>
            <Card pad={12}><T weight="800">Treatment plans</T><T size={12} color={c.mute}>{a.plans.active} active · {a.plans.paused} paused · {a.plans.completed} completed · {a.plans.discharged} discharged</T>
              <T size={12} color={c.mute}>Home exercise: {a.adherence.avg_percent != null ? `${a.adherence.avg_percent}% of plan on average` : 'not enough logs yet'} · {a.adherence.without_logs} of {a.adherence.plans} older plan{a.adherence.plans === 1 ? '' : 's'} with nothing logged</T></Card>
            <Card pad={12}><T weight="800">Outcomes</T>
              {a.outcomes.by_measure.length ? a.outcomes.by_measure.map((m) => <T key={m.measure} size={12} color={c.mute}>{m.label}: {m.improved} improved · {m.unchanged} no change · {m.worse} worse across {m.series} patient measure{m.series === 1 ? '' : 's'} (average {m.avg_change > 0 ? '+' : ''}{m.avg_change}{m.unit === '/10' ? '' : ` ${m.unit}`})</T>) : <T size={12} color={c.mute}>Needs two or more readings of the same measure in the period.</T>}</Card>
            <Card pad={12}><T weight="800">Goals</T><T size={12} color={c.mute}>{a.goals.achieved} achieved · {a.goals.not_met} not met · {a.goals.discontinued} stopped in this period{a.goals.achieved_pct != null ? ` (${a.goals.achieved_pct}% achieved)` : ''} · {a.goals.open} open{a.goals.overdue ? `, ${a.goals.overdue} past their date` : ''}</T></Card>
            <Card pad={12}><T weight="800">Reports</T><T size={12} color={c.mute}>{a.reports.published_to_patients} sent to patients{a.reports.read_pct != null ? ` · ${a.reports.read_pct}% read` : ''}</T></Card>
            {a.by_month.length > 1 ? <Card pad={12}><T weight="800">By month</T>{a.by_month.map((m) => <T key={m.month} size={12} color={c.mute}>{m.month}: {m.sessions} visit{m.sessions === 1 ? '' : 's'} · {m.signed_notes} signed note{m.signed_notes === 1 ? '' : 's'}</T>)}</Card> : null}
            <T size={11} color={c.mute}>Revenue and tax are in Tax & revenue. Clinical figures count only patients whose consent is still active.</T>
          </View>)}</Wait>
      </Section>
    </View>
  );
}

// ------------------------------------------------------------------ patient side
const LOG_STATUS = [{ value: 'done', label: 'Did it all' }, { value: 'partial', label: 'Some of it' }, { value: 'skipped', label: "Couldn't today" }];
export function LogExercise({ planId, onClose, onDone }) {
  const [status, setStatus] = useState('done'), [pain, setPain] = useState(null), [effort, setEffort] = useState(null);
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.post(`/treatment-plans/${planId}/adherence`, { status, ...(pain != null ? { pain } : {}), ...(effort != null ? { effort } : {}) }); toast('Logged — your clinician will see it at your next review'); onDone?.(); onClose(); } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Log today's exercises">
      <T size={12} color={c.mute}>This is a record for you and your clinician. It is not watched in real time: if you feel worse or unsafe, contact them or emergency services.</T>
      <Seg options={LOG_STATUS} value={status} onChange={setStatus} color={c.mint} />
      <T weight="800" size={13}>Pain after exercise {pain == null ? '(optional)' : ''}</T>
      {pain == null ? <Btn small title="Add pain score" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setPain(0)} /> : <Counter value={pain} min={0} max={10} onChange={setPain} suffix="/10" />}
      <T weight="800" size={13}>How hard it felt {effort == null ? '(optional)' : ''}</T>
      {effort == null ? <Btn small title="Add effort" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => setEffort(5)} /> : <Counter value={effort} min={0} max={10} onChange={setEffort} suffix="/10" />}
      <Btn title="Save" color={c.mint} ink={c.ink} loading={busy} onPress={save} />
    </Sheet>
  );
}

export function MyProgress() {
  const q = useLoad(() => api.get('/me/physio-progress'), []);
  const reports = useLoad(() => api.get('/me/physio-reports', { limit: 20 }), []);
  const [view, setView] = useState(null);
  const [log, setLog] = useState(null);
  const { toast } = useSession();
  const read = async (r) => { setView(r); if (!r.read_at) { try { await api.post(`/me/physio-reports/${r.report_id}/read`, {}); reports.reload(); } catch (e) { toast('' + e.message); } } };
  const d = q.data;
  const active = (d?.plans ?? []).filter((p) => p.status === 'active' && p.published_version != null);
  return (
    <View style={{ gap: 10 }}>
      <Section title="My progress" color={c.mint}>
        <Wait q={q}>{() => (
          <View style={{ gap: 8 }}>
            {active.map((p) => (
              <Card key={p.id} pad={12}>
                <T weight="800">{p.title}</T>
                <T size={12} color={c.mute}>{p.adherence?.percent != null ? `You logged ${p.adherence.days_done + p.adherence.days_partial} of about ${p.adherence.expected_days} days in the last four weeks (${p.adherence.percent}%)` : 'Log what you do at home so your clinician can see how it is going.'}</T>
                <Bar><Btn small title="Log today's exercises" color={c.mint} ink={c.ink} onPress={() => setLog(p.id)} /></Bar>
              </Card>))}
            {d.goals.map((g) => (
              <Card key={g.id} pad={12}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="800" style={{ flex: 1 }}>{g.title}</T><Tag label={label(g.status)} color={GOAL_TAG[g.status]} /></View>
                {g.measure ? <T size={12} color={c.mute}>{fmt(g.baseline, g.unit)} → {fmt(g.target, g.unit)}{g.progress.latest ? ` · now ${fmt(g.progress.latest.value, g.unit)} (${g.progress.percent}%)` : ''}</T> : null}
                {g.target_date ? <T size={12} color={c.mute}>Aim: {day(g.target_date)}</T> : null}
                {g.closing_note ? <T size={12}>{g.closing_note}</T> : null}
              </Card>))}
            {d.outcomes.map((s) => <SeriesCard key={s.key} s={s} />)}
            {!active.length && !d.goals.length && !d.outcomes.length ? <Empty emoji="📈" title="Nothing to track yet" sub="Goals, measurements and your home-exercise log from your physio appear here." /> : null}
          </View>)}</Wait>
      </Section>
      <Section title="Reports from my physio" color={c.cyan}>
        <Wait q={reports}>{(rows) => rows.length ? rows.map((r) => (
          <Card key={r.report_id} pad={12} onPress={() => read(r)}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><View style={{ flex: 1 }}><T weight="800">{r.title}</T><T size={12} color={c.mute}>From {r.provider_name} · {day(r.published_at)}</T></View>{r.read_at ? null : <Tag label="New" color={c.pink} />}</View>
          </Card>)) : <Empty emoji="📄" title="No reports yet" sub="When your physio shares a progress report it appears here." />}</Wait>
      </Section>
      {view ? <Sheet visible onClose={() => setView(null)} title={view.title}><SnapshotView s={view.snapshot} /></Sheet> : null}
      {log ? <LogExercise planId={log} onClose={() => setLog(null)} onDone={q.reload} /> : null}
    </View>
  );
}
