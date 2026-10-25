// Pathway plan (Learn & study sport → My plan): targets, sport and academic goals, deadlines, scholarships and their evidence, offer comparison,
// outcome history, and sharing with a coach. It extends the bucket list; trials, enquiries, credentials and evidence are read where they live.
// A verified guardian opens the same screens for their child (athleteId). Coaches read what athletes shared in SharedPathways / SharedPathway.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Sheet, Field } from '../ui';
import { Counter, DateField } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';
import { locale } from '../locale';
import { saveCsv } from './academy-ui';

const STAGE_LIST = [['saved', 'Saved'], ['shortlisted', 'Shortlisted'], ['applying', 'Applying'], ['applied', 'Applied'], ['offered', 'Offered'], ['accepted', 'Accepted'], ['enrolled', 'Enrolled'], ['declined', 'Declined'], ['not_for_me', 'Not for me']];
const SOURCES = { own: 'You added', target: 'Application date', trial: 'Trial booking', offer: 'Offer reply', scholarship: 'Scholarship' };
const KIND_LABEL = { application: 'Application', trial: 'Trial', scholarship: 'Scholarship', documents: 'Documents', other: 'Other', offer_reply: 'Offer reply' };
const PERIOD = { per_year: 'per year', total: 'in total' };
const SCOPES = [['targets', 'Targets'], ['goals', 'Goals'], ['deadlines', 'Deadlines'], ['scholarships', 'Scholarships'], ['offers', 'Offers'], ['outcomes', 'Outcomes']];
const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? String(v).replace(/_/g, ' ');
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));
const day = (d) => (d ? new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const iso = (d) => (d ? String(d).slice(0, 10) : undefined);
const when = (x) => (x.overdue ? `Overdue by ${-x.days_left} day${x.days_left === -1 ? '' : 's'}` : x.days_left === 0 ? 'Today' : x.days_left > 0 ? `In ${x.days_left} day${x.days_left === 1 ? '' : 's'}` : 'Past');
const PROV_COLOR = { self_reported: c.sun, institution_issued: c.mint, coach_reference: c.mint, athlete_video_approved: c.mint, approved_competition: c.mint };

const Bar = ({ value }) => (
  <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round((value ?? 0) * 100) }} style={{ height: 8, borderRadius: 8, backgroundColor: c.line, overflow: 'hidden', marginTop: 6 }}>
    <View style={{ width: `${Math.round((value ?? 0) * 100)}%`, height: 8, backgroundColor: c.mint }} />
  </View>
);

/** The screen a guardian opens for a child, and the body of the My plan tab. */
export function PathwayPlan({ athlete_id: forAthlete }) {
  return <Screen><Plan athleteId={forAthlete} /></Screen>;
}

export function Plan({ athleteId, onExplore }) {
  const { toast } = useSession();
  const [tab, setTab] = useState('targets');
  const q = athleteId ? { athlete_id: athleteId } : {};
  const out = useLoad(() => api.get('/me/pathway/outcomes', { ...q, limit: 100 }), [athleteId]);
  const summary = useLoad(() => api.get('/me/pathway', q), [athleteId]);
  const reload = () => { out.reload(); summary.reload(); };
  useEffect(() => { if (tab !== 'targets') reload(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps -- fresh counts and history whenever another part changed things
  const fail = (e) => toast(e.details?.code === 'stale_version' ? 'This changed elsewhere — reload to see the latest.' : e.details?.code === 'guardian_consent_required' ? `${e.message}` : '' + e.message);
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); return true; } catch (e) { fail(e); return false; } };
  const targets = out.data?.targets ?? [];
  const s = summary.data;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Card pad={12} style={{ flex: 1 }}><T weight="800" size={22}>{s ? s.targets : '–'}</T><T size={12} color={c.mute}>Targets</T></Card>
        <Card pad={12} style={{ flex: 1 }}><T weight="800" size={22}>{s ? s.next_deadlines.filter((d) => d.days_left <= 30).length : '–'}</T><T size={12} color={c.mute}>Deadlines ≤ 30 days</T></Card>
        <Card pad={12} style={{ flex: 1 }}><T weight="800" size={22}>{s ? s.offers.open : '–'}</T><T size={12} color={c.mute}>Open offers</T></Card>
      </View>
      <View style={{ marginTop: 12 }}>
        <Seg value={tab} onChange={setTab} color={c.violet} options={[{ value: 'targets', label: 'Targets' }, { value: 'goals', label: 'Goals' }, { value: 'deadlines', label: 'Deadlines' }, { value: 'scholarships', label: 'Scholarships' }, { value: 'offers', label: 'Offers' }, { value: 'outcomes', label: 'Outcomes' }, { value: 'sharing', label: 'Sharing' }]} />
      </View>
      {tab === 'targets' ? <Targets athleteId={athleteId} out={out} onExplore={onExplore} act={act} reload={reload} /> : null}
      {tab === 'goals' ? <Goals athleteId={athleteId} targets={targets} act={act} /> : null}
      {tab === 'deadlines' ? <Deadlines athleteId={athleteId} targets={targets} act={act} /> : null}
      {tab === 'scholarships' ? <Scholarships athleteId={athleteId} targets={targets} act={act} /> : null}
      {tab === 'offers' ? <Offers athleteId={athleteId} targets={targets} act={act} /> : null}
      {tab === 'outcomes' ? <Outcomes out={out} /> : null}
      {tab === 'sharing' ? <Sharing athleteId={athleteId} act={act} /> : null}
    </>
  );
}

const targetOptions = (targets) => targets.map((t) => ({ value: t.id, label: t.institution && t.institution !== t.title ? `${t.title} · ${t.institution}` : t.title }));

// ------------------------------------------------------------------ targets
function Targets({ athleteId, out, onExplore, act }) {
  const { toast } = useSession();
  const [edit, setEdit] = useState(null);
  const [addTeam, setAddTeam] = useState(false);
  const list = useLoad(() => (athleteId ? Promise.resolve(null) : api.get('/me/bucket', { limit: 100 })), [athleteId, out.data]);
  if (out.error) return <ErrorBox error={out.error} onRetry={out.reload} />;
  if (!out.data || (!athleteId && !list.data && !list.error)) return <Loading />;
  const rows = athleteId ? out.data.targets : list.data ?? [];
  return (
    <Section title={`Targets${rows.length ? ` (${rows.length})` : ''}`} color={c.mint}>
      {athleteId ? null : (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {onExplore ? <Btn small title="🔎 Find an institution" color={c.violet} onPress={onExplore} /> : null}
          <Btn small title="🏅 Add a team" color={c.paper} ink={c.ink} onPress={() => setAddTeam(true)} />
        </View>
      )}
      {rows.length ? rows.map((x) => (
        <Card key={x.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="800" size={16}>{x.target_type === 'team' ? '🏅' : x.target_type?.endsWith('programme') ? '📜' : '🏛️'} {x.title}</T>
              <T size={12} color={c.mute}>{[x.institution !== x.title ? x.institution : null, [x.city, x.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</T>
            </View>
            <Tag label={label(STAGE_LIST, x.status)} color={['accepted', 'enrolled'].includes(x.status) ? c.mint : c.violetSoft} />
          </View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {x.listed_on_platform === false ? <Tag label="AI suggestion · unverified" color={c.sun} /> : null}
            {x.enquiry_status ? <Tag label={`Enquiry: ${label([], x.enquiry_status)}`} /> : null}
            {x.target_date ? <Tag label={`Deadline ${day(x.target_date)}`} /> : null}
          </View>
          {x.note ? <T size={13} style={{ marginTop: 6 }}>{x.note}</T> : null}
          {athleteId ? null : <Btn small title="Update stage" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => setEdit(x)} />}
        </Card>
      )) : <Empty emoji="🎯" title="No targets yet" sub="Search institutions and teams, then save the ones you are aiming for. Each can carry deadlines, scholarships and offers." />}
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.title ?? 'Target'} submitLabel="Save"
        fields={[
          { key: 'status', label: 'Where are you with this?', type: 'chips', options: opts(STAGE_LIST) },
          { key: 'target_date', label: 'Application deadline or target date', type: 'date', optional: true },
          { key: 'note', label: 'Notes', type: 'multiline', optional: true },
          { key: 'remove', label: 'Remove from my targets', type: 'switch', default: false, hint: 'Kept in your history; you can save it again later.' },
        ]}
        initial={{ status: edit?.status, target_date: iso(edit?.target_date), note: edit?.note ?? '' }}
        onSubmit={async (v) => {
          await api.patch(`/me/bucket/${edit.id}`, v.remove ? { remove: true, row_version: edit.row_version } : { status: v.status, target_date: v.target_date ?? null, note: v.note ?? null, row_version: edit.row_version });
          out.reload(); list.reload(); return v.remove ? 'Removed' : 'Saved';
        }} />
      <FormSheet visible={addTeam} onClose={() => setAddTeam(false)} title="Add a team" submitLabel="Add target"
        fields={[
          { key: 'team', label: 'Team', type: 'entity', entityKind: 'team', noun: 'team' },
          { key: 'status', label: 'Where are you with it?', type: 'chips', options: opts(STAGE_LIST.slice(0, 5)) },
          { key: 'target_date', label: 'Trial or application date', type: 'date', optional: true },
        ]}
        initial={{ status: 'saved' }}
        onSubmit={async (v) => { await api.post('/me/bucket', { target_type: 'team', target_id: v.team, status: v.status, target_date: v.target_date }); out.reload(); list.reload(); toast('Team added'); return 'Added'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ goals
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const num = (v, step) => (step < 1 ? Number(v).toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v)));
const Group = ({ title, hint, children }) => (<View style={{ gap: 6 }}><T weight="800" size={13}>{title}</T>{hint ? <T size={12} color={c.mute}>{hint}</T> : null}{children}</View>);
const ChipRow = ({ children }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{children}</View>;

/** Big-number picker for a target: − / + in the metric's own step, a coarse pair for wide scales, and the suggested targets as one-tap chips. */
function TargetPicker({ opt, value, onChange }) {
  const wide = (opt.max - opt.min) / opt.step > 60;
  return (
    <Group title="Aim for" hint={opt.direction === 'lower' ? 'Lower is better for this one.' : 'Higher is better for this one.'}>
      <Card pad={14}>
        <T weight="800" size={30} style={{ textAlign: 'center' }}>{num(value, opt.step)} <T size={14} color={c.mute}>{opt.unit}</T></T>
        <View style={{ alignItems: 'center', marginTop: 6 }}><Counter value={value} onChange={onChange} min={opt.min} max={opt.max} step={opt.step} /></View>
        {wide ? <View style={{ alignItems: 'center', marginTop: 8 }}><T size={11} color={c.mute}>Big steps</T><Counter value={value} onChange={onChange} min={opt.min} max={opt.max} step={opt.step * 10} /></View> : null}
      </Card>
      {opt.suggestions?.length ? <ChipRow>{opt.suggestions.map((sg) => <Chip key={sg.label} label={`${sg.label} · ${num(sg.value, opt.step)}`} active={Math.abs(sg.value - value) < opt.step / 2} onPress={() => onChange(sg.value)} />)}</ChipRow> : null}
      {opt.suggestions?.some((sg) => sg.basis !== 'your own figure') ? <T size={11} color={c.mute}>Cohort suggestions use only totals and averages of {opt.suggestions.find((sg) => sg.basis !== 'your own figure').basis}.</T> : null}
    </Group>
  );
}

/** Build a goal by picking, not typing: sport → metric (with your real figure) → target → date → which target. */
function GoalWizard({ visible, onClose, targets, x, onDone }) {
  const { toast } = useSession();
  const [kind, setKind] = useState('sporting');
  const [sport, setSport] = useState(null);
  const [pick, setPick] = useState(null);   // {type:'metric'|'academic'|'milestone', key}
  const [target, setTarget] = useState(null);
  const [date, setDate] = useState(null);
  const [bucket, setBucket] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const base = useLoad(() => (visible ? api.get('/me/pathway/goal-options', x) : Promise.resolve(null)), [visible]);
  const opts = useLoad(() => (visible && sport ? api.get('/me/pathway/goal-options', { ...x, sport_slug: sport }) : Promise.resolve(null)), [visible, sport]);
  const reset = () => { setKind('sporting'); setSport(null); setPick(null); setTarget(null); setDate(null); setBucket(null); setNote(''); };
  const close = () => { reset(); onClose(); };
  if (!visible) return null;
  const metric = pick?.type === 'metric' ? opts.data?.metrics.find((m) => m.key === pick.key) : null;
  const acad = pick?.type === 'academic' ? base.data?.academic.find((m) => m.key === pick.key) : null;
  const range = metric ?? acad;
  const choose = (p) => { setPick(p); const r = p.type === 'metric' ? opts.data.metrics.find((m) => m.key === p.key) : p.type === 'academic' ? base.data.academic.find((m) => m.key === p.key) : null; setTarget(r ? (r.suggestions?.[0]?.value ?? r.current ?? (r.min + r.max) / 2) : null); };
  const ready = pick && (pick.type === 'milestone' || target !== null);
  const save = async () => {
    setBusy(true);
    try {
      const body = { kind, bucket_id: bucket ?? undefined, target_date: date ?? undefined, notes: note.trim() || undefined, ...x };
      if (pick.type === 'metric') Object.assign(body, { sport_slug: sport, metric_key: pick.key, target });
      else if (pick.type === 'academic') Object.assign(body, { academic_measure: pick.key, target, sport_slug: undefined });
      else Object.assign(body, { milestone: pick.key, sport_slug: sport ?? undefined });
      await api.post('/me/pathway/goals', body);
      toast('Goal added'); onDone(); close();
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };
  const dateChips = [['In 3 months', 90], ['In 6 months', 180], ['In a year', 365]];
  const known = targets.filter((t) => t.target_date).map((t) => [`Before ${t.title}`, iso(t.target_date)]);
  return (
    <Sheet visible onClose={close} title="New goal" footer={<Btn title="Add goal" color={c.violet} disabled={!ready} loading={busy} onPress={save} accessibilityLabel="Add goal" />}>
      {base.error ? <ErrorBox error={base.error} onRetry={base.reload} /> : !base.data ? <Loading /> : (
        <View style={{ gap: 16 }}>
          <Group title="What kind of goal?"><ChipRow><Chip label="🏅 Sporting" active={kind === 'sporting'} onPress={() => { setKind('sporting'); setPick(null); }} /><Chip label="🎓 Academic" active={kind === 'academic'} onPress={() => { setKind('academic'); setPick(null); setSport(null); }} /></ChipRow></Group>
          {kind === 'sporting' ? (
            <Group title="Sport" hint={base.data.sports.length ? undefined : 'Add a sport profile first to see its metrics. You can still choose a milestone.'}>
              <ChipRow>{base.data.sports.map((sp) => <Chip key={sp.slug} label={`${sp.emoji ?? ''} ${sp.name}`} active={sport === sp.slug} onPress={() => { setSport(sp.slug); setPick(null); }} />)}</ChipRow>
            </Group>
          ) : null}
          {kind === 'sporting' && sport ? (
            <Group title="What do you want to improve?" hint="Your current figure comes from your own results; nothing is typed.">
              {opts.error ? <ErrorBox error={opts.error} onRetry={opts.reload} /> : !opts.data ? <Loading /> : opts.data.metrics.length ? opts.data.metrics.map((m) => (
                <Card key={`${m.source}-${m.key}`} pad={12} onPress={() => choose({ type: 'metric', key: m.key })} accessibilityLabel={`Choose ${m.label}`} color={pick?.key === m.key ? c.violetSoft : c.paper}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <View style={{ flex: 1 }}><T weight="800">{m.label}</T><T size={12} color={c.mute}>{m.direction === 'lower' ? 'Lower is better' : 'Higher is better'} · {m.unit}</T></View>
                    <View style={{ alignItems: 'flex-end' }}>{m.current != null ? <><T weight="800">{num(m.current, m.step)} {m.unit}</T><T size={11} color={c.mute}>{m.evidence_label}</T></> : <T size={12} color={c.mute}>No result yet</T>}</View>
                  </View>
                </Card>
              )) : <T size={12} color={c.mute}>No tracked metrics for this sport yet. Choose a milestone below, or log matches and results to unlock metrics.</T>}
            </Group>
          ) : null}
          {kind === 'academic' ? (
            <Group title="What are you measured on?"><ChipRow>{base.data.academic.map((m) => <Chip key={m.key} label={m.label} active={pick?.key === m.key} onPress={() => choose({ type: 'academic', key: m.key })} />)}</ChipRow></Group>
          ) : null}
          {!range ? <Group title="Or a milestone"><ChipRow>{base.data.milestones.map((m) => <Chip key={m} label={m} active={pick?.type === 'milestone' && pick.key === m} onPress={() => choose({ type: 'milestone', key: m })} />)}</ChipRow></Group> : null}
          {range && target !== null ? <TargetPicker opt={{ ...range, suggestions: metric?.suggestions }} value={target} onChange={setTarget} /> : null}
          {pick ? (
            <>
              <Group title="By when?">
                <ChipRow>
                  {dateChips.map(([l, n]) => <Chip key={l} label={l} active={date === addDays(n)} onPress={() => setDate(addDays(n))} />)}
                  {known.map(([l, d]) => <Chip key={l} label={l} active={date === d} onPress={() => setDate(d)} />)}
                </ChipRow>
                <DateField label="Or pick a date" value={date ?? undefined} onChange={setDate} optional min={addDays(0)} />
              </Group>
              {targets.length ? <Group title="For which target?"><ChipRow>{targetOptions(targets).map((t) => <Chip key={t.value} label={t.label} active={bucket === t.value} onPress={() => setBucket(bucket === t.value ? null : t.value)} />)}</ChipRow></Group> : null}
              <Field label="Private note (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} />
            </>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

function Goals({ athleteId, targets, act }) {
  const list = useLoad(() => api.get('/me/pathway/goals', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const [form, setForm] = useState(false);
  const [edit, setEdit] = useState(null);
  const x = athleteId ? { athlete_id: athleteId } : {};
  const range = useLoad(() => (edit && edit.current_source === 'manual' && edit.measure === 'number' ? (edit.academic_measure ? api.get('/me/pathway/goal-options', x).then((o) => o.academic.find((m) => m.key === edit.academic_measure)) : edit.sport_slug ? api.get('/me/pathway/goal-options', { ...x, sport_slug: edit.sport_slug }).then((o) => o.metrics.find((m) => m.key === edit.metric_key)) : null) : Promise.resolve(null)), [edit?.id]);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Sport & academic goals" color={c.cyan} action="Add goal" onAction={() => setForm(true)}>
      {list.data.length ? list.data.map((g) => (
        <Card key={g.id} pad={14} onPress={() => setEdit(g)} accessibilityLabel={`Update goal ${g.title}`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{g.kind === 'academic' ? '🎓' : g.sport_emoji ?? '🏅'} {g.title}</T><T size={12} color={c.mute}>{g.kind === 'academic' ? 'Academic' : 'Sporting'}{g.sport ? ` · ${g.sport}` : ''}{g.target_date ? ` · by ${day(g.target_date)}` : ''}</T></View>
            <Tag label={g.status} color={g.status === 'achieved' ? c.mint : c.violetSoft} />
          </View>
          {g.measure === 'number' ? <T size={13} style={{ marginTop: 6 }}>{g.current ?? '–'} → {g.target} {g.unit ?? ''}{g.baseline != null ? ` · started at ${g.baseline}` : ''}{g.current_source === 'live' ? ' · follows your results' : ''}</T> : <T size={13} style={{ marginTop: 6 }}>{g.status === 'achieved' ? 'Done' : 'Not yet'}</T>}
          {g.progress != null ? <Bar value={g.progress} /> : null}
        </Card>
      )) : <Empty emoji="🏁" title="No goals yet" sub="Pick a metric from your sport (your current figure is filled in) or an academic measure, and aim for a number by a date." />}
      <GoalWizard visible={form} onClose={() => setForm(false)} targets={targets} x={x} onDone={list.reload} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.title ?? 'Goal'} submitLabel="Save"
        fields={[
          ...(edit?.current_source === 'live' ? [{ key: '_live', type: 'section', label: 'Follows your best approved result automatically' }] : edit?.measure === 'number' && range.data ? [{ key: 'current', label: `Where you are now (${edit.unit ?? ''})`, type: 'stepper', min: range.data.min, max: range.data.max, step: range.data.step }] : []),
          { key: 'status', label: 'Status', type: 'chips', options: [{ value: 'active', label: 'Active' }, { value: 'achieved', label: edit?.measure === 'yes_no' ? 'Done' : 'Achieved' }, { value: 'paused', label: 'Paused' }, { value: 'dropped', label: 'Dropped' }] },
          { key: 'target_date', label: 'Aim to reach it by', type: 'date', optional: true },
          { key: 'remove', label: 'Remove this goal', type: 'switch', default: false, hint: 'Kept in your records, hidden from the list.' },
        ]}
        initial={{ current: edit?.current ?? range.data?.min, status: edit?.status, target_date: iso(edit?.target_date) }}
        onSubmit={async (v) => { await api.patch(`/me/pathway/goals/${edit.id}`, { row_version: edit.row_version, ...(v.current !== undefined && edit.current_source === 'manual' && edit.measure === 'number' ? { current: v.current } : {}), status: v.status, target_date: v.target_date ?? null, remove: v.remove || undefined, ...x }); list.reload(); return 'Saved'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ deadlines
function Deadlines({ athleteId, targets, act }) {
  const [past, setPast] = useState(false);
  const list = useLoad(() => api.get('/me/pathway/deadlines', { ...(athleteId ? { athlete_id: athleteId } : {}), include_past: past, limit: 100 }), [athleteId, past]);
  const [form, setForm] = useState(false);
  const [edit, setEdit] = useState(null);
  const x = athleteId ? { athlete_id: athleteId } : {};
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Deadlines" color={c.sun} action="Add deadline" onAction={() => setForm(true)}>
      <View style={{ flexDirection: 'row', gap: 6 }}><Chip label="Upcoming" active={!past} onPress={() => setPast(false)} /><Chip label="Include finished" active={past} onPress={() => setPast(true)} /></View>
      {list.data.length ? list.data.map((d) => (
        <Row key={`${d.source}-${d.id}`} title={`${KIND_LABEL[d.kind] ?? d.kind}${d.title ? ` · ${d.title}` : ''}${d.target ? ` · ${d.target}` : ''}`}
          sub={`${day(d.due_on)} · ${SOURCES[d.source]}${d.done ? ' · done' : ''}`} onPress={d.source === 'own' ? () => setEdit(d) : undefined}
          right={<Tag label={d.done ? 'Done' : when(d)} color={d.overdue ? c.pink : d.days_left <= 7 && !d.done ? c.sun : c.violetSoft} />} />
      )) : <Empty emoji="📅" title="No deadlines" sub="Add application, trial, scholarship or document dates. Your trial bookings, offer replies and target dates appear here too." />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="New deadline" submitLabel="Add deadline"
        fields={[
          { key: 'kind', label: 'What is it for?', type: 'chips', options: [['application', 'Application'], ['trial', 'Trial'], ['scholarship', 'Scholarship'], ['documents', 'Documents'], ['other', 'Other']].map(([value, l]) => ({ value, label: l })) },
          { key: 'title', label: 'What is it?', show: (v) => v.kind === 'other' },
          { key: 'bucket_id', label: 'For which target?', type: 'chips', optional: true, options: targetOptions(targets) },
          { key: 'due_on', label: 'Due on', type: 'date' },
          { key: 'remind_days', label: 'Remind me this many days before', type: 'stepper', min: 0, max: 60, default: 7, suffix: ' days' },
        ]}
        initial={{ kind: 'application', remind_days: 7 }}
        onSubmit={async (v) => { await api.post('/me/pathway/deadlines', { ...v, ...x }); list.reload(); return 'Deadline added'; }} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title="Deadline" submitLabel="Save"
        fields={[
          { key: 'due_on', label: 'Due on', type: 'date' },
          { key: 'remind_days', label: 'Remind me this many days before', type: 'stepper', min: 0, max: 60, suffix: ' days' },
          { key: 'done', label: 'Finished', type: 'switch', default: false },
          { key: 'remove', label: 'Remove this deadline', type: 'switch', default: false },
        ]}
        initial={{ due_on: iso(edit?.due_on), remind_days: edit?.remind_days ?? 7, done: !!edit?.done }}
        onSubmit={async (v) => { await api.patch(`/me/pathway/deadlines/${edit.id}`, { row_version: edit.row_version, due_on: v.due_on, remind_days: v.remind_days, done: v.done, remove: v.remove || undefined, ...x }); list.reload(); return 'Saved'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ scholarships
const EVIDENCE_LISTS = [
  ['academic_evidence', 'Academic records', '/me/academic-evidence', (r) => `${r.kind} · ${r.institution}`],
  ['credential', 'Credentials', '/me/credentials', (r) => r.title, (r) => r.status === 'issued'],
  ['passport_reference', 'Coach references', '/me/passport-references', (r) => `Reference from ${r.coach_name ?? 'a coach'}`, (r) => r.status === 'approved'],
  ['passport_video', 'Videos', '/me/passport-videos', (r) => r.title, (r) => r.status === 'approved'],
];

function AttachEvidence({ item, onClose, onDone, x }) {
  const { toast } = useSession();
  const lists = useLoad(async () => Promise.all(EVIDENCE_LISTS.map(async ([type, , path, , keep]) => { try { return (await api.get(path, { limit: 50 })).filter((r) => !keep || keep(r)); } catch { return []; } })), [item?.id]);
  if (!item) return null;
  const pick = async (type, id) => { try { await api.post(`/me/pathway/scholarship-items/${item.id}/evidence`, { source_type: type, source_id: id, ...x }); toast('Evidence attached'); onDone(); onClose(); } catch (e) { toast('' + e.message); } };
  return (
    <Sheet visible onClose={onClose} title={`Evidence for “${item.requirement}”`}>
      {!lists.data ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <T size={12} color={c.mute}>Pick something you already hold. It stays where it is; only its title and where it came from are ever shared.</T>
          {EVIDENCE_LISTS.map(([type, title, , name], n) => (
            <View key={type} style={{ gap: 6 }}>
              <T weight="800" size={13}>{title}</T>
              {lists.data[n].length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{lists.data[n].map((r) => <Chip key={r.id} label={name(r)} onPress={() => pick(type, r.id)} />)}</View> : <T size={12} color={c.mute}>Nothing here yet.</T>}
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

function Scholarships({ athleteId, targets, act }) {
  const list = useLoad(() => api.get('/me/pathway/scholarships', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const [form, setForm] = useState(false);
  const [edit, setEdit] = useState(null);
  const [attach, setAttach] = useState(null);
  const [req, setReq] = useState(null);
  const x = athleteId ? { athlete_id: athleteId } : {};
  const run = async (fn, msg) => { try { await fn(); msg && toast(msg); list.reload(); } catch (e) { toast('' + e.message); } };
  const { toast } = useSession();
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Scholarships & evidence" color={c.mint} action={targets.length ? 'Add scholarship' : undefined} onAction={() => setForm(true)}>
      {list.data.length ? list.data.map((s) => (
        <Card key={s.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{s.name}</T><T size={12} color={c.mute}>{targets.find((t) => t.id === s.bucket_id)?.title ?? ''}{s.amount_minor != null ? ` · ${moneyIn(s.amount_minor, s.currency)} ${PERIOD[s.period]}` : ''}{s.due_on ? ` · due ${day(s.due_on)}` : ''}</T></View>
            <Tag label={s.status} color={s.status === 'awarded' ? c.mint : c.violetSoft} />
          </View>
          <T size={12} color={c.mute} style={{ marginTop: 6 }}>{s.met} of {s.total} requirements met</T>
          <Bar value={s.total ? s.met / s.total : 0} />
          {s.items.map((it) => (
            <View key={it.id} style={{ marginTop: 8, gap: 4 }}>
              <T weight="700" size={13}>{it.met ? '✔' : '○'} {it.requirement}</T>
              {it.met ? <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><T size={12}>{it.evidence_label}</T><Tag label={it.provenance_label} color={PROV_COLOR[it.provenance] ?? c.sun} /></View> : null}
              {athleteId ? null : (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <Btn small title={it.met ? 'Change evidence' : 'Attach evidence'} color={c.paper} ink={c.ink} onPress={() => setAttach(it)} />
                  {it.met ? <Btn small title="Unlink" color={c.paper} ink={c.red} onPress={() => run(() => api.del(`/me/pathway/scholarship-items/${it.id}/evidence`, x), 'Unlinked')} /> : null}
                </View>
              )}
            </View>
          ))}
          {athleteId ? null : <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' }}><Btn small title="Add requirement" color={c.paper} ink={c.ink} onPress={() => setReq(s)} /><Btn small title="Update" color={c.paper} ink={c.ink} onPress={() => setEdit(s)} /></View>}
        </Card>
      )) : <Empty emoji="🎓" title="No scholarships yet" sub={targets.length ? 'Track a scholarship for one of your targets, list what it asks for and attach the evidence you already have.' : 'Add a target first, then track its scholarships here.'} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="New scholarship" submitLabel="Add scholarship"
        fields={[
          { key: 'bucket_id', label: 'For which target?', type: 'chips', options: targetOptions(targets) },
          { key: 'name', label: 'Scholarship name' },
          { key: 'currency', label: 'Currency', type: 'currency', optional: true },
          { key: 'amount_minor', label: 'Value', type: 'money', currency: (v) => v.currency, optional: true },
          { key: 'period', label: 'Is that', type: 'chips', options: [{ value: 'per_year', label: 'Per year' }, { value: 'total', label: 'In total' }] },
          { key: 'due_on', label: 'Application due', type: 'date', optional: true },
          { key: 'requirements', label: 'It asks for', type: 'multi', optional: true, options: ['Latest transcript', 'Coach reference', 'Match video', 'Test scores', 'Proof of income', 'Personal statement'] },
        ]}
        initial={{ period: 'per_year' }}
        onSubmit={async (v) => { const b = { ...v, ...x }; if (b.amount_minor === undefined) delete b.currency; await api.post('/me/pathway/scholarships', b); list.reload(); return 'Scholarship added'; }} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={edit?.name ?? 'Scholarship'} submitLabel="Save"
        fields={[
          { key: 'status', label: 'Status', type: 'chips', options: ['exploring', 'applied', 'awarded', 'declined', 'withdrawn'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
          { key: 'due_on', label: 'Application due', type: 'date', optional: true },
          { key: 'remove', label: 'Remove this scholarship', type: 'switch', default: false },
        ]}
        initial={{ status: edit?.status, due_on: iso(edit?.due_on) }}
        onSubmit={async (v) => { await api.patch(`/me/pathway/scholarships/${edit.id}`, { row_version: edit.row_version, status: v.status, due_on: v.due_on ?? null, remove: v.remove || undefined, ...x }); list.reload(); return 'Saved'; }} />
      <FormSheet visible={!!req} onClose={() => setReq(null)} title="Add a requirement" submitLabel="Add"
        fields={[{ key: 'requirement', label: 'What does it ask for?' }]} initial={{}}
        onSubmit={async (v) => { await api.post(`/me/pathway/scholarships/${req.id}/requirements`, { requirement: v.requirement, ...x }); list.reload(); return 'Added'; }} />
      <AttachEvidence item={attach} x={x} onClose={() => setAttach(null)} onDone={list.reload} />
    </Section>
  );
}

// ------------------------------------------------------------------ offers
function Compare({ data }) {
  return (
    <View style={{ gap: 10 }}>
      {data.notice ? <Card pad={12}><T size={12} color={c.mute}>{data.notice}</T></Card> : null}
      {data.groups.map((g) => (
        <Card key={`${g.currency}/${g.period}`} pad={12}>
          <T weight="800">{g.currency} · {PERIOD[g.period]}</T>
          {g.offers.map((o) => (
            <View key={o.id} accessibilityLabel={`${o.title}, net ${moneyIn(o.net_minor, o.currency)}`} style={{ marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: o.lowest_net_cost ? c.mintSoft : c.line + '55' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="800" style={{ flex: 1 }}>{o.title}</T>{o.lowest_net_cost ? <Tag label="Lowest net cost" color={c.mint} /> : null}</View>
              <T size={12} color={c.mute}>{o.institution ?? o.target}</T>
              <T size={13} style={{ marginTop: 4 }}>Tuition {moneyIn(o.tuition_minor, o.currency)} + other {moneyIn(o.other_minor, o.currency)} − scholarship {moneyIn(o.scholarship_minor, o.currency)}</T>
              <T weight="800" style={{ marginTop: 2 }}>Net {moneyIn(o.net_minor, o.currency)}</T>
              <T size={12} color={c.mute}>{o.reply_by ? `Reply by ${day(o.reply_by)}` : 'No reply date'} · {o.status}{o.conditions ? ` · Conditions: ${o.conditions}` : ''}</T>
              <T size={11} color={c.mute}>{o.source_label}</T>
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}

function Offers({ athleteId, targets, act }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get('/me/pathway/offers', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const [compare, setCompare] = useState(false);
  const cmp = useLoad(() => (compare ? api.get('/me/pathway/offers/compare', athleteId ? { athlete_id: athleteId } : {}) : Promise.resolve(null)), [compare, athleteId, list.data]);
  const [form, setForm] = useState(false);
  const [decide, setDecide] = useState(null);
  const x = athleteId ? { athlete_id: athleteId } : {};
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Offers" color={c.violet} action={targets.length ? 'Record an offer' : undefined} onAction={() => setForm(true)}>
      {list.data.length > 1 ? <View style={{ flexDirection: 'row', gap: 6 }}><Chip label="List" active={!compare} onPress={() => setCompare(false)} /><Chip label="Compare side by side" active={compare} onPress={() => setCompare(true)} /></View> : null}
      {compare ? (cmp.error ? <ErrorBox error={cmp.error} onRetry={cmp.reload} /> : !cmp.data ? <Loading /> : <Compare data={cmp.data} />) : list.data.length ? list.data.map((o) => (
        <Card key={o.id} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}><T weight="800">{o.title}</T><T size={12} color={c.mute}>{o.institution ?? o.target}</T></View>
            <Tag label={o.status} color={o.status === 'accepted' ? c.mint : o.status === 'declined' ? c.pink : c.violetSoft} />
          </View>
          <T size={13} style={{ marginTop: 6 }}>Net {moneyIn(o.net_minor, o.currency)} {PERIOD[o.period]}</T>
          <T size={12} color={c.mute}>{o.reply_by ? `Reply by ${day(o.reply_by)}${o.status === 'open' && o.days_left != null ? ` (${o.days_left < 0 ? 'passed' : `${o.days_left} days`})` : ''}` : 'No reply date'}{o.conditions ? ` · ${o.conditions}` : ''}</T>
          <T size={11} color={c.mute}>{o.source_label}</T>
          <Btn small title={o.status === 'open' ? 'Decide' : 'Change decision'} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => setDecide(o)} />
        </Card>
      )) : <Empty emoji="📬" title="No offers yet" sub={targets.length ? 'When an institution or team makes you an offer, record its costs and conditions here to compare it with the others.' : 'Add a target first, then record its offers here.'} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Record an offer" submitLabel="Save offer"
        fields={[
          { key: 'bucket_id', label: 'Which target made it?', type: 'chips', options: targetOptions(targets) },
          { key: 'title', label: 'What is offered? (for example BSc place)' },
          { key: 'currency', label: 'Currency', type: 'currency' },
          { key: 'period', label: 'Costs are', type: 'chips', options: [{ value: 'per_year', label: 'Per year' }, { value: 'total', label: 'In total' }] },
          { key: 'tuition_minor', label: 'Tuition', type: 'money', currency: (v) => v.currency, optional: true },
          { key: 'other_minor', label: 'Other costs (housing, fees)', type: 'money', currency: (v) => v.currency, optional: true },
          { key: 'scholarship_minor', label: 'Scholarship or discount', type: 'money', currency: (v) => v.currency, optional: true },
          { key: 'reply_by', label: 'Reply by', type: 'date', optional: true },
          { key: 'starts_on', label: 'Starts on', type: 'date', optional: true },
          { key: 'conditions', label: 'Conditions that come with it', type: 'multi', optional: true, options: ['Minimum grade', 'Final exam results', 'Trial performance', 'Medical clearance', 'Visa', 'Proof of funds', 'Deposit by a date'] },
        ]}
        initial={{ period: 'per_year' }}
        onSubmit={async (v) => { await api.post('/me/pathway/offers', { ...v, conditions: v.conditions?.length ? v.conditions.join('; ') : undefined, ...x }); list.reload(); return 'Offer recorded'; }} />
      <FormSheet visible={!!decide} onClose={() => setDecide(null)} title={decide?.title ?? 'Decision'} submitLabel="Record decision"
        fields={[
          { key: 'decision', label: 'Your decision', type: 'chips', options: [{ value: 'accept', label: 'Accept' }, { value: 'decline', label: 'Decline' }, { value: 'defer', label: 'Not yet' }] },
          { key: 'reply_by', label: 'New reply date', type: 'date', optional: true, show: (v) => v.decision === 'defer' },
        ]}
        initial={{ decision: decide?.status === 'accepted' ? 'accept' : decide?.status === 'declined' ? 'decline' : 'accept' }}
        onSubmit={async (v) => {
          try { await api.post(`/me/pathway/offers/${decide.id}/decision`, { row_version: decide.row_version, decision: v.decision, reply_by: v.reply_by, ...x }); }
          catch (e) { throw new Error(e.details?.code === 'guardian_consent_required' ? 'A guardian must allow “Recruiters & scouts” under Family & guardians before a young person can accept, or a guardian can decide for them.' : e.message); }
          list.reload(); return 'Decision recorded';
        }} />
    </Section>
  );
}

// ------------------------------------------------------------------ outcomes
const eventText = (e) => ({
  stage: `${e.from_value ? `${label(STAGE_LIST, e.from_value)} → ` : 'Saved as '}${label(STAGE_LIST, e.to_value)}`,
  offer_added: 'offer recorded', offer_decided: `offer ${e.to_value}`, scholarship: `scholarship ${e.to_value}`, goal: `goal ${e.to_value}`,
}[e.kind] ?? e.kind);
function Outcomes({ out }) {
  if (out.error) return <ErrorBox error={out.error} onRetry={out.reload} />;
  if (!out.data) return <Loading />;
  const { counts, timeline } = out.data;
  return (
    <Section title="Outcomes" color={c.orange}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{STAGE_LIST.filter(([k]) => counts[k]).map(([k, l]) => <Tag key={k} label={`${l} ${counts[k]}`} />)}</View>
      {timeline.length ? timeline.map((e) => (
        <Row key={e.id} title={`${e.target ?? 'Plan'}: ${eventText(e)}`} sub={`${day(e.at)}${e.detail ? ` · ${e.detail}` : ''}`} />
      )) : <Empty emoji="🧭" title="Nothing yet" sub="Every stage change, offer, scholarship decision and goal result is recorded here and never deleted." />}
    </Section>
  );
}

// ------------------------------------------------------------------ sharing with a coach
function Sharing({ athleteId, act }) {
  const { toast } = useSession();
  const x = athleteId ? { athlete_id: athleteId } : {};
  const list = useLoad(() => api.get('/me/pathway/shares', x), [athleteId]);
  const [form, setForm] = useState(false);
  const exportCsv = async () => { try { const r = await api.get('/me/pathway/export', x); await saveCsv(r.filename, r.csv); toast(`Exported ${r.rows} rows`); } catch (e) { toast('' + e.message); } };
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Who can see my plan" color={c.cyan} action="Share with a coach" onAction={() => setForm(true)}>
      <T size={12} color={c.mute}>Only a coach you work with can be added, and only the parts you choose. Private notes, evidence content and enquiry messages are never shared. You can stop sharing at any time.</T>
      {list.data.length ? list.data.map((s) => (
        <Card key={s.id} pad={14}>
          <T weight="800">{s.recipient_name} <T size={12} color={c.mute}>@{s.recipient_handle}</T></T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>{s.scopes.map((k) => <Tag key={k} label={label(SCOPES, k)} />)}</View>
          {s.expires_at ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Until {day(s.expires_at)}</T> : null}
          <Btn small title="Stop sharing" color={c.paper} ink={c.red} style={{ alignSelf: 'flex-start', marginTop: 10 }} onPress={() => act(() => api.post(`/me/pathway/shares/${s.id}/revoke`, {}), 'Sharing stopped').then(list.reload)} />
        </Card>
      )) : <Empty emoji="🔒" title="Not shared with anyone" sub="Your plan is private until you share it." />}
      <Btn small title="Export my plan (CSV)" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={exportCsv} />
      <FormSheet visible={form} onClose={() => setForm(false)} title="Share with a coach" submitLabel="Share"
        fields={[
          { key: 'recipient_id', label: 'Coach', type: 'entity', entityKind: 'person', role: 'coach', noun: 'coach' },
          { key: 'scopes', label: 'What can they see?', type: 'multi', options: opts(SCOPES) },
          { key: 'expires_on', label: 'Stop sharing on', type: 'date', optional: true },
        ]}
        initial={{ scopes: ['goals', 'deadlines'] }}
        onSubmit={async (v) => { await api.post('/me/pathway/shares', { recipient_id: v.recipient_id, scopes: v.scopes, expires_on: v.expires_on, ...x }); list.reload(); return 'Shared'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ coaches: what athletes shared
export function SharedPathways({ push }) {
  const list = useLoad(() => api.get('/pathway/shared', { limit: 100 }), []);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Section title="Athletes' plans shared with me" color={c.cyan}>
      {list.data.length ? list.data.map((s) => (
        <Row key={s.id} title={`${s.avatar_emoji ?? '🏅'} ${s.athlete_name}`} sub={s.scopes.map((k) => label(SCOPES, k)).join(' · ') + (s.expires_at ? ` · until ${day(s.expires_at)}` : '')} onPress={() => push('SharedPathway', { athlete_id: s.athlete_id })} />
      )) : <Empty emoji="🔒" title="Nothing shared with you" sub="When an athlete you coach shares their pathway plan, it appears here. Access ends as soon as they stop sharing." />}
    </Section>
  );
}

export function SharedPathway({ athlete_id: athleteId }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get(`/pathway/shared/${athleteId}`), [athleteId]);
  const exportCsv = async () => { try { const r = await api.get(`/pathway/shared/${athleteId}/export`); await saveCsv(r.filename, r.csv); toast(`Exported ${r.rows} rows`); } catch (e) { toast('' + e.message); } };
  if (q.error) return <Screen><Empty emoji="🔒" title="Not available" sub="This plan is no longer shared with you, or you do not work with this athlete any more." /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  const d = q.data;
  return (
    <Screen>
      <Card pad={14}><T weight="800" size={18}>{d.athlete.avatar_emoji} {d.athlete.display_name}</T><T size={12} color={c.mute}>Shared with you: {d.scopes.map((k) => label(SCOPES, k)).join(', ')}{d.expires_at ? ` · until ${day(d.expires_at)}` : ''}. Read only; each view is logged.</T><Btn small title="Export CSV" color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start', marginTop: 8 }} onPress={exportCsv} /></Card>
      {d.targets ? <Section title="Targets" color={c.mint}>{d.targets.length ? d.targets.map((t) => <Row key={t.id} title={t.title} sub={`${t.institution ?? ''}${t.target_date ? ` · ${day(t.target_date)}` : ''}`} right={<Tag label={label(STAGE_LIST, t.status)} />} />) : <Empty emoji="🎯" title="No targets" />}</Section> : null}
      {d.goals ? <Section title="Goals" color={c.cyan}>{d.goals.length ? d.goals.map((g) => <Card key={g.id} pad={12}><T weight="800">{g.title}</T><T size={12} color={c.mute}>{g.kind} · {g.status}{g.measure === 'number' ? ` · ${g.current ?? '–'} of ${g.target} ${g.unit ?? ''}` : ''}</T>{g.progress != null ? <Bar value={g.progress} /> : null}</Card>) : <Empty emoji="🏁" title="No goals" />}</Section> : null}
      {d.deadlines ? <Section title="Deadlines" color={c.sun}>{d.deadlines.length ? d.deadlines.map((x) => <Row key={`${x.source}-${x.id}`} title={`${KIND_LABEL[x.kind] ?? x.kind}${x.title ? ` · ${x.title}` : ''}`} sub={`${day(x.due_on)} · ${SOURCES[x.source]}`} right={<Tag label={x.done ? 'Done' : when(x)} />} />) : <Empty emoji="📅" title="No deadlines" />}</Section> : null}
      {d.scholarships ? <Section title="Scholarships" color={c.mint}>{d.scholarships.length ? d.scholarships.map((s) => <Card key={s.id} pad={12}><T weight="800">{s.name}</T><T size={12} color={c.mute}>{s.status} · {s.met} of {s.total} requirements met{s.amount_minor != null ? ` · ${moneyIn(s.amount_minor, s.currency)} ${PERIOD[s.period]}` : ''}</T>{s.items.map((it) => <T key={it.id} size={12}>{it.met ? '✔' : '○'} {it.requirement}{it.met ? ` — ${it.provenance_label}` : ''}</T>)}</Card>) : <Empty emoji="🎓" title="No scholarships" />}</Section> : null}
      {d.offers ? <Section title="Offers" color={c.violet}>{d.offers.length ? <Compare data={{ groups: d.offers, notice: d.offers.length > 1 ? 'Shown per currency and period; never converted.' : null }} /> : <Empty emoji="📬" title="No offers" />}</Section> : null}
      {d.outcomes ? <Outcomes out={{ data: d.outcomes }} /> : null}
    </Screen>
  );
}
