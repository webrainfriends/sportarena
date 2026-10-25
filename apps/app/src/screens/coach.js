import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Empty, ErrorBox, GradCard, H1, H2, Loading, Row, Screen, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { CoachToolGrid } from './coaching';
import { useLayout } from '../layout';
import { c, grad } from '../theme';
import { saveDraft as queueDraft, saveMessage } from '../offline';
import { localToIso, dateTimeIn } from '../vtime';
import { locale } from '../locale';
import { WorkoutPlan, Compliance, Phases, WeeklyLoad, FOCUS, phaseFields, saveFile, blockFields, toBlock, resultFields, toActuals } from './workout';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const KINDS = ['skill', 'tactical', 'conditioning', 'strength', 'recovery', 'mobility'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
// status is always written out, never colour-only
const STATUS = { draft: 'Draft', proposed: 'Awaiting athlete', active: 'Active', declined: 'Declined', change_requested: 'Changes requested', closed: 'Closed', pending: 'Awaiting athlete', accepted: 'Accepted', superseded: 'Replaced', scheduled: 'Scheduled', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled', confirmed: 'Confirmed', awaiting_response: 'Awaiting response' };
const Status = ({ s }) => <Tag label={STATUS[s] ?? s} color={s === 'active' || s === 'completed' || s === 'accepted' || s === 'confirmed' ? c.lime : c.violetSoft} />;
const TABS = ['Home', 'Explore', 'Schedule', 'Player', 'Hub', 'Me', 'Play', 'Book']; // Play and Book are the old names of Explore and Schedule
// links may point at a tab (Hub, Me) or a pushed page; tabs must go through goTab or the page lookup is undefined
const useOpen = () => { const { push, goTab } = useNav(); return (l) => (TABS.includes(l.screen) ? goTab(l.screen) : push(l.screen, l.params)); };
const toIso = (v) => localToIso(v.date, v.time, tz);
const sessionFields = [
  { key: 'title', label: 'Session title' },
  { key: 'kind', label: 'Type', type: 'chips', options: KINDS },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Start time', type: 'time' },
  { key: 'duration_min', label: 'Duration (minutes)', type: 'stepper', min: 15, max: 480, step: 15, default: 60 },
  { key: 'target_rpe', label: 'Target effort 1–10 (optional, not medical)', type: 'stepper', min: 1, max: 10, step: 1, default: 6, optional: true },
  { key: 'focus', label: 'Training focus', type: 'chips', options: FOCUS, optional: true },
  { key: 'objective', label: 'Objective (what this session is for)', optional: true },
  { key: 'instructions', label: 'Instructions', type: 'multiline', optional: true },
];

function Actions({ items, open }) {
  if (!items?.length) return <Empty emoji="✅" title="Nothing needs you right now" sub="New coaching requests, athlete replies and session feedback will appear here." />;
  return items.map((a, i) => <Row key={`${a.kind}${i}`} title={a.title} sub={a.detail} right={<Tag label={a.ready ? 'Ready to confirm' : 'Open'} />} onPress={() => open(a.link)} />);
}

export function CoachHome() {
  const { push } = useNav();
  const open = useOpen();
  const { tablet: wide } = useLayout();
  const home = useLoad(() => api.get('/coach/home'), []);
  const cal = useLoad(() => api.get('/coach/calendar'), []);
  const h = home.data;
  if (home.loading && !h) return <Screen><Loading /></Screen>;
  if (home.error) return <Screen><ErrorBox error={home.error} onRetry={home.reload} /></Screen>;
  const today = new Date().toDateString();
  const agenda = (cal.data?.items ?? []).filter((x) => x.status !== 'cancelled');
  return (
    <Screen wide onRefresh={() => { home.reload(); cal.reload(); }}>
      <GradCard colors={grad.hero} style={{ marginTop: 8 }}>
        <T color="#fff" weight="700" size={11} style={{ letterSpacing: 2.5, opacity: 0.8 }}>COACH HOME</T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <StatPill value={h.counts.athletes} label="ATHLETES" />
          <StatPill value={h.counts.teams} label="TEAMS" />
          <StatPill value={h.counts.requests} label="REQUESTS" />
          <StatPill value={h.counts.plans_awaiting_athlete} label="AWAITING ATHLETE" />
        </View>
        <T color="#fff" size={13} style={{ marginTop: 10 }}>
          {h.verification ? `Verified coach · valid until ${new Date(h.verification.expires_at).toLocaleDateString(locale)}` : 'Credential not verified'} · {h.sports.map((s) => s.name).join(', ') || 'No coaching sport yet'}
        </T>
        {h.next_session ? <T color="#fff" weight="700" size={13}>Next: {h.next_session.title ?? 'Coaching session'} · {dateTimeIn(h.next_session.starts_at, tz)}</T> : null}
      </GradCard>
      {h.warnings.map((w) => <Card key={w.kind} onPress={() => open(w.link)}><T weight="700">⚠ {w.title}</T></Card>)}
      <View style={{ marginTop: 14, marginBottom: 6 }}><CoachToolGrid push={push} counts={{ board: h.counts.requests || null }} /></View>
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, width: '100%' }}>
          <Section title="Needs your action"><Actions items={h.inbox} open={open} /></Section>
        </View>
        <View style={{ flex: 1, width: '100%' }}>
          <Section title="Today & this week" action="Full calendar" onAction={() => push('CoachCalendar')}>
            {cal.error ? <ErrorBox error={cal.error} onRetry={cal.reload} /> : !agenda.length ? <Empty emoji="🗓️" title="No sessions scheduled" sub="Accepted plan sessions, confirmed hires and your team's matches show up here." /> :
              agenda.slice(0, 8).map((x) => <Row key={`${x.source_type}${x.source_id}`} title={x.title} sub={`${new Date(x.starts_at).toDateString() === today ? 'Today' : ''} ${dateTimeIn(x.starts_at, tz)}${x.conflict ? ' · Clash with another commitment' : ''}`} right={<Status s={x.status} />} onPress={() => open(x.link)} />)}
          </Section>
          <Section title="My teams">
            {h.teams.length ? h.teams.map((t) => <Row key={t.id} title={`${t.emoji ?? ''} ${t.name}`} sub={`${t.sport} · ${t.members} players`} onPress={() => push('Team', { id: t.id })} />) : <Empty emoji="👥" title="No teams yet" sub="When a team adds you as its coach, it appears here." />}
          </Section>
        </View>
      </View>
    </Screen>
  );
}

export function CoachAthletes() {
  const { push } = useNav();
  const { toast } = useSession();
  const list = useLoad(() => api.get('/coach/athletes'), []);
  const [pick, setPick] = useState(null);
  return (
    <Screen onRefresh={list.reload}>
      <H1>My athletes</H1>
      <T size={13} color={c.mute}>People you actively coach: a confirmed booking, a shared team, a cohort you lead or an accepted plan.</T>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ?
        <Empty emoji="🏃" title="No athletes yet" sub="Accept a coaching request or get added to a team as its coach." /> :
        list.data.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Avatar user={a} />
              <View style={{ flex: 1 }}>
                <T weight="700">{a.display_name}</T>
                <T size={12} color={c.mute}>{a.relationships.join(' · ')} · {a.active_plans} active plan{a.active_plans === 1 ? '' : 's'}{a.plans_in_review ? ` · ${a.plans_in_review} in review` : ''}</T>
                <T size={12} color={c.mute}>{a.next_session_at ? `Next ${dateTimeIn(a.next_session_at, tz)}` : 'No session scheduled'}{a.adherence_pct != null ? ` · ${a.adherence_pct}% completed (athlete-reported)` : ''}</T>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Btn small title="New plan" onPress={() => setPick(a)} />
              <Btn small title="Plans" color={c.paper} ink={c.ink} onPress={() => push('MyPlans', { as: 'coach', athlete_id: a.id })} />
              <Btn small title="Journal" color={c.paper} ink={c.ink} onPress={() => push('CoachJournal', { athlete_id: a.id, name: a.display_name })} />
              <Btn small title="Profile" color={c.paper} ink={c.ink} onPress={() => push('Person', { id: a.id })} />
            </View>
          </Card>
        ))}
      <FormSheet visible={!!pick} onClose={() => setPick(null)} title={`New plan for ${pick?.display_name ?? ''}`} submitLabel="Create draft" initial={{}}
        fields={[{ key: 'sport', label: 'Sport', type: 'sport' }, { key: 'title', label: 'Plan title' }, { key: 'goal', label: 'Goal', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { const p = await api.post('/training-plans', { athlete_id: pick.id, sport: v.sport, title: v.title, goal: v.goal || undefined }); setPick(null); toast('Draft created — add sessions, then propose it'); push('CoachPlan', { id: p.id }); }} />
    </Screen>
  );
}

export function MyPlans({ as = 'athlete', athlete_id }) {
  const { push } = useNav();
  const q = `/training-plans?as=${as}${athlete_id ? `&athlete_id=${athlete_id}` : ''}`;
  const list = useLoad(() => api.get(q), [q]);
  return (
    <Screen onRefresh={list.reload}>
      <H1>{as === 'coach' ? 'Training plans I coach' : 'My training plans'}</H1>
      {as === 'coach' ? null : <View style={{ marginTop: 6 }}><Btn small title="My development" color={c.paper} ink={c.ink} onPress={() => push('MyDevelopment')} /></View>}
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ?
        <Empty emoji="📋" title="No training plans yet" sub={as === 'coach' ? 'Open My athletes and start a plan for someone you coach.' : 'When a coach proposes a plan it appears here for you to accept or change.'} /> :
        list.data.map((p) => <Row key={p.id} title={p.title} sub={`${as === 'coach' ? p.athlete_name : `Coach ${p.coach_name}`} · ${p.completed}/${p.total} done${p.next_session_at ? ` · next ${dateTimeIn(p.next_session_at, tz)}` : ''}`} right={<Status s={p.status} />} onPress={() => push('CoachPlan', { id: p.id })} />)}
    </Screen>
  );
}

export function CoachPlan({ id }) {
  const { user, toast } = useSession();
  const plan = useLoad(() => api.get(`/training-plans/${id}`), [id]);
  const [form, setForm] = useState(null); // { mode: 'add'|'edit'|'rate'|'note'|'change', s? }
  const p = plan.data;
  if (plan.loading && !p) return <Screen><Loading /></Screen>;
  if (plan.error) return <Screen><ErrorBox error={plan.error} onRetry={plan.reload} /></Screen>;
  const coach = user.id === p.coach_id;
  const rev = p.revisions[p.revisions.length - 1];
  const act = async (fn, msg) => { try { await fn(); toast(msg); plan.reload(); } catch (e) { toast('' + e.message); } };
  // an athlete's workout result is saved on the device first and uploaded with a version check, so it survives a dropped connection
  const logWorkout = async (s, fields, done) => {
    try { const r = await queueDraft({ kind: 'workout_log', payload: { session_id: s.id, expected_version: s.version, ...fields }, label: s.title ?? 'Workout', sub: dateTimeIn(s.starts_at, tz) }); toast(saveMessage(r, done)); plan.reload(); }
    catch (e) { toast('' + e.message); }
  };
  const draftSessions = (rev?.content?.sessions ?? []);
  // the draft's sessions with one session's blocks changed (an emptied list means no structure)
  const editBlocks = (at, fn) => draftSessions.map((x, j) => (j === at ? { ...x, blocks: fn(x.blocks ?? []).length ? fn(x.blocks ?? []) : undefined } : x));
  const saveDraft = (sessions, phases = rev.content.phases ?? []) => api.patch(`/training-plans/${p.id}/draft`, { content: { targets: rev.content.targets ?? [], phases, sessions } });
  const exportPdf = () => act(async () => saveFile(await api.get(`/training-plans/${p.id}/export`)), 'PDF ready');
  return (
    <Screen onRefresh={plan.reload}>
      <H1>{p.title}</H1>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Status s={p.status} /><T size={13} color={c.mute}>{coach ? p.athlete_name : `Coach ${p.coach_name}`} · {p.sport}</T></View>
      {p.goal ? <T>{p.goal}</T> : null}
      <Btn small title="Download PDF" color={c.paper} ink={c.ink} onPress={exportPdf} style={{ alignSelf: 'flex-start' }} />

      {rev?.response === 'pending' && !coach ? (
        <Card><T weight="700">Revision {rev.rev} is waiting for your answer</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small title="Accept" onPress={() => act(() => api.post(`/training-plans/${p.id}/respond`, { response: 'accepted' }), 'Plan accepted')} />
            <Btn small title="Ask for changes" color={c.paper} ink={c.ink} onPress={() => setForm({ mode: 'change' })} />
            <Btn small title="Decline" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/training-plans/${p.id}/respond`, { response: 'declined' }), 'Plan declined')} />
          </View></Card>
      ) : null}
      {coach && p.status !== 'closed' ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {rev?.response === 'draft' ? <>
            <Btn small title="Add session" onPress={() => setForm({ mode: 'add' })} />
            <Btn small title="Add phase" color={c.paper} ink={c.ink} onPress={() => setForm({ mode: 'phase' })} />
            <Btn small title="Propose to athlete" color={c.violet} onPress={() => act(() => api.post(`/training-plans/${p.id}/propose`), 'Sent to the athlete')} />
          </> : rev?.response !== 'pending' ? <Btn small title="Revise plan" onPress={() => act(() => api.post(`/training-plans/${p.id}/revisions`), 'Revision started')} /> : <T size={13} color={c.mute}>Revision {rev.rev} is with the athlete.</T>}
          <Btn small title="Close plan" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/training-plans/${p.id}/close`), 'Plan closed')} />
        </View>
      ) : null}
      {!coach && p.status !== 'closed' ? <Btn small title="Stop this plan" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/training-plans/${p.id}/close`), 'Plan closed')} style={{ alignSelf: 'flex-start' }} /> : null}

      {p.targets?.length ? <Section title="Targets"><Card>{p.targets.map((x, i) => <T key={i} size={13}>• {x.label}{x.value ? `: ${x.value}` : ''}</T>)}</Card></Section> : null}
      {p.phases?.length || (coach && rev?.response === 'draft' && (rev.content.phases ?? []).length) ? (
        <Section title="Periodisation">
          <Card><Phases phases={coach && rev?.response === 'draft' ? rev.content.phases : p.phases} onRemove={coach && rev?.response === 'draft' ? (pid) => act(() => saveDraft(draftSessions, (rev.content.phases ?? []).filter((x) => x.id !== pid)), 'Phase removed') : undefined} /></Card>
        </Section>) : null}
      {p.weeks?.length ? <Section title="Weekly load"><Card><WeeklyLoad weeks={p.weeks} /></Card></Section> : null}

      <Section title="Sessions">
        {!p.sessions.length && !(rev?.response === 'draft' && draftSessions.length) ? <Empty emoji="🗓️" title="No sessions yet" sub={coach ? 'Add sessions, then propose the plan.' : 'Sessions appear once you accept the plan.'} /> : null}
        {p.sessions.map((s) => (
          <Card key={s.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{s.title}</T><Status s={s.status} /></View>
            <T size={12} color={c.mute}>{dateTimeIn(s.starts_at, tz)} · {s.duration_min} min · {s.kind}{s.focus ? ` · ${s.focus}` : ''}{s.target_rpe ? ` · target effort ${s.target_rpe}/10` : ''}{s.planned_load ? ` · planned load ${s.planned_load}` : ''}{s.actual_load ? ` · actual load ${s.actual_load}` : ''}</T>
            {s.objective ? <T size={13} weight="700">Objective: {s.objective}</T> : null}
            {s.instructions ? <T size={13}>{s.instructions}</T> : null}
            <WorkoutPlan blocks={s.structure} rules={p.sport_rules} />
            {s.status !== 'scheduled' && s.status !== 'cancelled' ? <T size={12} color={c.mute}>Athlete report: {s.status}{s.athlete_rpe ? ` · effort ${s.athlete_rpe}/10` : ''}{s.athlete_feedback ? ` · “${s.athlete_feedback}”` : ''}</T> : null}
            {s.athlete_data_hidden ? <T size={12} color={c.mute}>{s.athlete_data_hidden === 'guardian_consent' ? 'Results are hidden until a guardian allows coaching records to be shared.' : 'Results are hidden because you no longer coach this athlete.'}</T> : null}
            <Compliance data={s.compliance} rules={p.sport_rules} />
            {s.coach_feedback ? <T size={12}>Coach feedback: {s.coach_feedback}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {!coach && s.status === 'scheduled' && s.structure ? <Btn small title={s.actuals ? 'Update my results' : 'Log my results'} color={c.violet} onPress={() => setForm({ mode: 'log', s })} /> : null}
              {!coach && s.status === 'scheduled' ? <><Btn small title={s.structure ? 'Finish workout' : 'Mark done'} onPress={() => setForm({ mode: s.structure ? 'finish' : 'rate', s })} /><Btn small title="Skipped" color={c.paper} ink={c.ink} onPress={() => logWorkout(s, { status: 'skipped' }, 'Marked skipped')} /></> : null}
              {coach && ['completed', 'skipped'].includes(s.status) ? <Btn small title={s.coach_feedback ? 'Edit feedback' : 'Add feedback'} color={c.paper} ink={c.ink} onPress={() => setForm({ mode: 'note', s })} /> : null}
              {coach && s.status === 'scheduled' && rev?.response === 'draft' && draftSessions.some((x) => x.session_id === s.id) ? <Btn small title="Add workout block" color={c.violet} onPress={() => setForm({ mode: 'block', at: draftSessions.findIndex((x) => x.session_id === s.id) })} /> : null}
              {coach && s.status === 'scheduled' && rev?.response === 'draft' ? <Btn small title="Drop from revision" color={c.paper} ink={c.ink} onPress={() => act(() => saveDraft(draftSessions.filter((x) => x.session_id !== s.id)), 'Dropped from the draft')} /> : null}
            </View>
          </Card>
        ))}
        {coach && rev?.response === 'draft' && draftSessions.map((s, i) => !s.session_id ? (
          <Card key={i}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{s.title}</T><Tag label="Draft" /></View>
            <T size={12} color={c.mute}>{dateTimeIn(s.starts_at, tz)} · {s.duration_min} min · {s.kind}</T>
            <WorkoutPlan blocks={s.blocks} rules={p.sport_rules} onRemove={(b) => act(() => saveDraft(editBlocks(i, (list) => list.filter((_, k) => k !== b))), 'Block removed')} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Btn small title="Add workout block" color={c.violet} onPress={() => setForm({ mode: 'block', at: i })} />
              <Btn small title="Remove session" color={c.paper} ink={c.ink} onPress={() => act(() => saveDraft(draftSessions.filter((_, j) => j !== i)), 'Session removed from the draft')} />
            </View>
          </Card>) : null)}
      </Section>

      <Section title="Revisions">
        {p.revisions.map((r) => <Row key={r.rev} title={`Revision ${r.rev}`} sub={`${r.proposed_at ? `Proposed ${dateTimeIn(r.proposed_at, tz)}` : 'Not proposed'}${r.response_note ? ` · “${r.response_note}”` : ''}`} right={<Status s={r.response} />} />)}
      </Section>

      <FormSheet visible={form?.mode === 'add'} onClose={() => setForm(null)} title="Add session" submitLabel="Add to draft" initial={{}} fields={sessionFields}
        onSubmit={async (v) => { await saveDraft([...rev.content.sessions, { starts_at: toIso(v), duration_min: Number(v.duration_min ?? 60), kind: v.kind ?? 'skill', title: v.title, instructions: v.instructions || undefined, objective: v.objective || undefined, focus: v.focus || undefined, target_rpe: v.target_rpe ? Number(v.target_rpe) : undefined }]); setForm(null); plan.reload(); }} />
      <FormSheet visible={form?.mode === 'phase'} onClose={() => setForm(null)} title="Add phase" submitLabel="Add to draft" initial={{}} fields={phaseFields}
        onSubmit={async (v) => { await saveDraft(draftSessions, [...(rev.content.phases ?? []), { id: `ph${Date.now().toString(36)}`, kind: v.kind, label: v.label, from: v.from, to: v.to, ...(v.focus ? { focus: v.focus } : {}) }]); setForm(null); plan.reload(); return 'Phase added to the draft'; }} />
      <FormSheet visible={form?.mode === 'block'} onClose={() => setForm(null)} title="Add workout block" submitLabel="Add block" initial={{}} fields={blockFields(p.sport_rules)}
        onSubmit={async (v) => { await saveDraft(editBlocks(form.at, (list) => [...list, toBlock(v)])); setForm(null); plan.reload(); return 'Block added to the draft'; }} />
      {form?.s?.structure ? (() => {
        const rf = resultFields(form.s.structure, p.sport_rules, form.s.actuals);
        const save = (finish) => async (v) => {
          const r = await queueDraft({ kind: 'workout_log', label: form.s.title ?? 'Workout', sub: dateTimeIn(form.s.starts_at, tz),
            payload: { session_id: form.s.id, expected_version: form.s.version, actuals: toActuals(v, form.s.structure), ...(finish ? { status: 'completed', athlete_rpe: Number(v.athlete_rpe), athlete_feedback: v.athlete_feedback || undefined } : {}) } });
          setForm(null); plan.reload(); return saveMessage(r, finish ? 'Workout finished — well done' : 'Progress saved');
        };
        return form.mode === 'log'
          ? <FormSheet visible onClose={() => setForm(null)} title="Log my results" submitLabel="Save progress" initial={rf.initial} fields={rf.fields} onSubmit={save(false)} />
          : form.mode === 'finish'
            ? <FormSheet visible onClose={() => setForm(null)} title="Finish workout" submitLabel="Finish workout" initial={{ ...rf.initial, athlete_rpe: 6 }}
              fields={[...rf.fields, { key: 'athlete_rpe', label: 'Effort 1–10', type: 'stepper', min: 1, max: 10, step: 1, default: 6 }, { key: 'athlete_feedback', label: 'Notes for your coach (no medical details)', type: 'multiline', optional: true }]}
              onSubmit={save(true)} />
            : null;
      })() : null}
      <FormSheet visible={form?.mode === 'rate'} onClose={() => setForm(null)} title="How did it go?" submitLabel="Save" initial={{ athlete_rpe: 6 }}
        fields={[{ key: 'athlete_rpe', label: 'Effort 1–10', type: 'stepper', min: 1, max: 10, step: 1, default: 6 }, { key: 'athlete_feedback', label: 'Notes for your coach (no medical details)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { const r = await queueDraft({ kind: 'workout_log', label: form.s.title ?? 'Workout', sub: dateTimeIn(form.s.starts_at, tz), payload: { session_id: form.s.id, expected_version: form.s.version, status: 'completed', athlete_rpe: Number(v.athlete_rpe), athlete_feedback: v.athlete_feedback || undefined } }); setForm(null); plan.reload(); return saveMessage(r, 'Workout saved'); }} />
      <FormSheet visible={form?.mode === 'note'} onClose={() => setForm(null)} title="Coach feedback" submitLabel="Save" initial={{ coach_feedback: form?.s?.coach_feedback ?? '' }}
        fields={[{ key: 'coach_feedback', label: 'Feedback', type: 'multiline' }]}
        onSubmit={async (v) => { await api.patch(`/training-sessions/${form.s.id}`, { coach_feedback: v.coach_feedback }); setForm(null); plan.reload(); }} />
      <FormSheet visible={form?.mode === 'change'} onClose={() => setForm(null)} title="What should change?" submitLabel="Send" initial={{}}
        fields={[{ key: 'note', label: 'Your request', type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/training-plans/${p.id}/respond`, { response: 'change_requested', note: v.note }); setForm(null); plan.reload(); }} />
    </Screen>
  );
}

export function CoachCalendar() {
  const open = useOpen();
  const cal = useLoad(() => api.get('/coach/calendar'), []);
  const items = (cal.data?.items ?? []).filter((x) => x.status !== 'cancelled');
  const byDay = items.reduce((m, x) => { const k = new Date(x.starts_at).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' }); (m[k] ??= []).push(x); return m; }, {});
  return (
    <Screen onRefresh={cal.reload}>
      <H1>Coach calendar</H1>
      <T size={13} color={c.mute}>Next 14 days · times shown in {tz.replace(/_/g, ' ')}</T>
      {cal.loading && !cal.data ? <Loading /> : cal.error ? <ErrorBox error={cal.error} onRetry={cal.reload} /> : !items.length ?
        <Empty emoji="🗓️" title="Nothing scheduled" sub="Confirmed sessions, plan sessions and your team's matches will appear here." /> :
        Object.entries(byDay).map(([d, xs]) => (
          <Section key={d} title={d}>
            {xs.map((x) => <Row key={`${x.source_type}${x.source_id}`} title={x.title} sub={`${dateTimeIn(x.starts_at, tz)}${x.context ? ` · ${x.context}` : ''}${x.conflict ? ' · Clash with another commitment' : ''}`} right={<Status s={x.status} />} onPress={() => open(x.link)} />)}
          </Section>
        ))}
    </Screen>
  );
}
