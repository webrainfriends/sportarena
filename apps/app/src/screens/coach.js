import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Empty, ErrorBox, GradCard, H1, H2, Loading, Row, Screen, Section, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { useLayout } from '../layout';
import { c, grad } from '../theme';
import { localToIso, dateTimeIn } from '../vtime';
import { locale } from '../locale';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const KINDS = ['skill', 'tactical', 'conditioning', 'strength', 'recovery', 'mobility'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
// status is always written out, never colour-only
const STATUS = { draft: 'Draft', proposed: 'Awaiting athlete', active: 'Active', declined: 'Declined', change_requested: 'Changes requested', closed: 'Closed', pending: 'Awaiting athlete', accepted: 'Accepted', superseded: 'Replaced', scheduled: 'Scheduled', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled', confirmed: 'Confirmed', awaiting_response: 'Awaiting response' };
const Status = ({ s }) => <Tag label={STATUS[s] ?? s} color={s === 'active' || s === 'completed' || s === 'accepted' || s === 'confirmed' ? c.lime : c.violetSoft} />;
const TABS = ['Home', 'Play', 'Player', 'Book', 'Hub', 'Me'];
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
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn small title="My athletes" onPress={() => push('CoachAthletes')} />
        <Btn small title="Calendar" color={c.violet} onPress={() => push('CoachCalendar')} />
        <Btn small title="Training plans" color={c.paper} ink={c.ink} onPress={() => push('MyPlans', { as: 'coach' })} />
        <Btn small title="Find a venue" color={c.paper} ink={c.ink} onPress={() => open({ screen: 'Book' })} />
      </View>
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
  const draftSessions = (rev?.content?.sessions ?? []);
  const saveDraft = (sessions) => api.patch(`/training-plans/${p.id}/draft`, { content: { targets: rev.content.targets ?? [], sessions } });
  return (
    <Screen onRefresh={plan.reload}>
      <H1>{p.title}</H1>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Status s={p.status} /><T size={13} color={c.mute}>{coach ? p.athlete_name : `Coach ${p.coach_name}`} · {p.sport}</T></View>
      {p.goal ? <T>{p.goal}</T> : null}

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
            <Btn small title="Propose to athlete" color={c.violet} onPress={() => act(() => api.post(`/training-plans/${p.id}/propose`), 'Sent to the athlete')} />
          </> : rev?.response !== 'pending' ? <Btn small title="Revise plan" onPress={() => act(() => api.post(`/training-plans/${p.id}/revisions`), 'Revision started')} /> : <T size={13} color={c.mute}>Revision {rev.rev} is with the athlete.</T>}
          <Btn small title="Close plan" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/training-plans/${p.id}/close`), 'Plan closed')} />
        </View>
      ) : null}
      {!coach && p.status !== 'closed' ? <Btn small title="Stop this plan" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/training-plans/${p.id}/close`), 'Plan closed')} style={{ alignSelf: 'flex-start' }} /> : null}

      <Section title="Sessions">
        {!p.sessions.length && !(rev?.response === 'draft' && draftSessions.length) ? <Empty emoji="🗓️" title="No sessions yet" sub={coach ? 'Add sessions, then propose the plan.' : 'Sessions appear once you accept the plan.'} /> : null}
        {p.sessions.map((s) => (
          <Card key={s.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flex: 1 }}>{s.title}</T><Status s={s.status} /></View>
            <T size={12} color={c.mute}>{dateTimeIn(s.starts_at, tz)} · {s.duration_min} min · {s.kind}{s.target_rpe ? ` · target effort ${s.target_rpe}/10` : ''}</T>
            {s.instructions ? <T size={13}>{s.instructions}</T> : null}
            {s.status !== 'scheduled' && s.status !== 'cancelled' ? <T size={12} color={c.mute}>Athlete report: {s.status}{s.athlete_rpe ? ` · effort ${s.athlete_rpe}/10` : ''}{s.athlete_feedback ? ` · “${s.athlete_feedback}”` : ''}</T> : null}
            {s.coach_feedback ? <T size={12}>Coach feedback: {s.coach_feedback}</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {!coach && s.status === 'scheduled' ? <><Btn small title="Mark done" onPress={() => setForm({ mode: 'rate', s })} /><Btn small title="Skipped" color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/training-sessions/${s.id}`, { status: 'skipped' }), 'Marked skipped')} /></> : null}
              {coach && ['completed', 'skipped'].includes(s.status) ? <Btn small title={s.coach_feedback ? 'Edit feedback' : 'Add feedback'} color={c.paper} ink={c.ink} onPress={() => setForm({ mode: 'note', s })} /> : null}
              {coach && s.status === 'scheduled' && rev?.response === 'draft' ? <Btn small title="Drop from revision" color={c.paper} ink={c.ink} onPress={() => act(() => saveDraft(draftSessions.filter((x) => x.session_id !== s.id)), 'Dropped from the draft')} /> : null}
            </View>
          </Card>
        ))}
        {coach && rev?.response === 'draft' && draftSessions.filter((x) => !x.session_id).map((s, i) => <Row key={i} title={s.title} sub={`${dateTimeIn(s.starts_at, tz)} · ${s.duration_min} min · ${s.kind}`} right={<Tag label="Draft" />} />)}
      </Section>

      <Section title="Revisions">
        {p.revisions.map((r) => <Row key={r.rev} title={`Revision ${r.rev}`} sub={`${r.proposed_at ? `Proposed ${dateTimeIn(r.proposed_at, tz)}` : 'Not proposed'}${r.response_note ? ` · “${r.response_note}”` : ''}`} right={<Status s={r.response} />} />)}
      </Section>

      <FormSheet visible={form?.mode === 'add'} onClose={() => setForm(null)} title="Add session" submitLabel="Add to draft" initial={{}} fields={sessionFields}
        onSubmit={async (v) => { await saveDraft([...rev.content.sessions, { starts_at: toIso(v), duration_min: Number(v.duration_min ?? 60), kind: v.kind ?? 'skill', title: v.title, instructions: v.instructions || undefined, target_rpe: v.target_rpe ? Number(v.target_rpe) : undefined }]); setForm(null); plan.reload(); }} />
      <FormSheet visible={form?.mode === 'rate'} onClose={() => setForm(null)} title="How did it go?" submitLabel="Save" initial={{ athlete_rpe: 6 }}
        fields={[{ key: 'athlete_rpe', label: 'Effort 1–10', type: 'stepper', min: 1, max: 10, step: 1, default: 6 }, { key: 'athlete_feedback', label: 'Notes for your coach (no medical details)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/training-sessions/${form.s.id}`, { status: 'completed', athlete_rpe: Number(v.athlete_rpe), athlete_feedback: v.athlete_feedback || undefined }); setForm(null); plan.reload(); }} />
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
