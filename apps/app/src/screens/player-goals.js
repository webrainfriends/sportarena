// Player-owned goals and self-directed training (issue #325). These live inside My development, the one place a player sees their growth:
// the player writes and owns them, a coach sees one only through a share the player can revoke, and a coach's assessment is shown
// apart from the player's own claim. The coach side (SharedByPlayers) sits in the existing Goals & actions screen.
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { dateTimeIn, localToIso } from '../vtime';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const newKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const CATEGORIES = ['technical', 'tactical', 'physical', 'mental_performance', 'teamwork', 'match_objective', 'custom'].map((value) => ({ value, label: label(value) }));
const UNITS = ['s', 'kg', 'cm', 'm', 'km', 'reps', 'min', '%', 'points', 'of 10', 'times'].map((value) => ({ value, label: value }));
const CADENCE = [{ value: 7, label: 'Weekly' }, { value: 14, label: 'Every 2 weeks' }, { value: 30, label: 'Monthly' }, { value: 90, label: 'Quarterly' }];
const KINDS = ['skill', 'tactical', 'conditioning', 'strength', 'recovery', 'mobility'].map((value) => ({ value, label: label(value) }));
const RATING = { ahead: 'Ahead of plan', on_track: 'On track', needs_attention: 'Needs attention', not_enough_evidence: 'Not enough evidence yet', confirmed_achieved: 'Confirmed achieved' };
const RATING_CHOICES = Object.entries(RATING).map(([value, l]) => ({ value, label: l }));
const MY_STATUS = { active: 'Active', paused: 'Paused', achieved: 'Achieved (my claim)', dropped: 'Dropped', completed: 'Completed', scheduled: 'Scheduled', skipped: 'Skipped', cancelled: 'Cancelled' };
const num = (x) => (x === null || x === undefined ? null : Number(x));

/** The player's own status and the coach's view, always on separate, labelled lines. */
function Views({ item, claim, coachSide }) {
  const a = item.latest_assessment ?? item.my_assessment;
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <T size={11} weight="800" color={c.mute}>{coachSide ? 'PLAYER\'S CLAIM' : 'MY CLAIM'}</T><Tag label={claim} color={c.violetSoft} />
      </View>
      {a ? (
        <View accessible accessibilityLabel={`Coach assessment from ${a.coach_name}: ${RATING[a.rating]}. ${a.note}`} style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <T size={11} weight="800" color={c.mute}>{coachSide ? 'YOUR ASSESSMENT' : `COACH'S VIEW${a.coach_name ? ` · ${a.coach_name}` : ''}`}</T><Tag label={RATING[a.rating] ?? label(a.rating)} color={c.sunSoft} />
          <T size={12} style={{ flexBasis: '100%' }}>{a.note}</T>
        </View>
      ) : null}
    </View>
  );
}

const Shares = ({ item, onRevoke, busy }) => (item.shared_with?.length ? (
  <View style={{ marginTop: 6, gap: 4 }}>
    {item.shared_with.map((s) => (
      <View key={s.share_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T size={12} color={c.mute}>Shared with {s.coach_name}</T>
        <Btn small title="Stop sharing" color={c.paper} ink={c.red} loading={busy === s.share_id} onPress={() => onRevoke(s.share_id)} accessibilityLabel={`Stop sharing with ${s.coach_name}`} />
      </View>
    ))}
  </View>
) : <T size={12} color={c.mute} style={{ marginTop: 6 }}>Private - only you can see this</T>);

/** Shared plumbing for both blocks: run an action, toast, reload; a stale version reloads instead of overwriting. */
function useAct(reload) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(null);
  const act = async (id, fn, ok) => {
    setBusy(id);
    try { await fn(); if (ok) toast(ok); }
    catch (e) { toast(e.status === 409 ? (e.message?.includes('reload') ? 'This was changed elsewhere, so it has been reloaded' : e.message) : e.message ?? 'Could not save, try again'); }
    setBusy(null); reload();
  };
  return { act, busy };
}

function ShareSheet({ form, onClose, onDone }) {
  const coaches = useLoad(() => api.get('/me/coaches'), []);
  const list = coaches.data ?? [];
  return (
    <FormSheet visible={!!form} onClose={onClose} title="Share with a coach" submitLabel="Share" initial={{}}
      fields={list.length ? [{ key: 'coach_id', label: 'Which coach?', type: 'chips', options: list.map((x) => ({ value: x.coach_id, label: x.display_name })), hint: 'They will see only this item. You can stop sharing at any time.' }] : [{ key: 'none', label: 'No coach yet', type: 'section' }]}
      onSubmit={async (v) => { if (!v.coach_id) throw new Error('You have no coach to share with yet - sharing works once you are on a team, hired a coach or accepted their plan.'); await api.post('/me/shares', { [form.kind === 'goal' ? 'goal_id' : 'plan_id']: form.id, coach_id: v.coach_id }); onDone(); return 'Shared'; }} />
  );
}

// ------------------------------------------------------------------------------------------------ goals
function GoalCard({ g, self, act, busy, onProgress, onShare, onEdit }) {
  const [open, setOpen] = useState(false);
  const detail = useLoad(() => (open ? api.get(`/me/goals/${g.id}`, self ? {} : { athlete_id: g.owner_id }) : Promise.resolve(null)), [open, g.id, g.row_version, g.progress_count]);
  const target = g.target_value !== null && g.target_value !== undefined ? `Target ${g.target_value} ${g.unit}` : null;
  const latest = g.latest_value !== null && g.latest_value !== undefined ? `latest ${g.latest_value} ${g.unit}` : null;
  const setStatus = (status, note) => act(g.id, () => api.patch(`/me/goals/${g.id}`, { row_version: g.row_version, status, status_note: note }), `Goal ${status === 'achieved' ? 'marked achieved' : status}`);
  return (
    <Card pad={12} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <T weight="700" style={{ flexShrink: 1 }}>{g.title}</T>
        <Tag label={label(g.category)} color={c.violetSoft} />
      </View>
      {g.measure ? <T size={13} style={{ marginTop: 2 }}>{g.measure}</T> : null}
      <T size={12} color={c.mute}>{[g.sport, target, latest, g.review_on ? `Review ${g.review_on}` : null].filter(Boolean).join(' · ')}</T>
      <Views item={g} claim={MY_STATUS[g.status]} />
      {self ? <Shares item={g} busy={busy} onRevoke={(sid) => act(sid, () => api.del(`/me/shares/${sid}`), 'Sharing stopped')} /> : null}
      {g.adopted_by?.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Adopted into coaching goals by {g.adopted_by.map((a) => a.coach_name).join(', ')}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {self && ['active', 'paused'].includes(g.status) ? <Btn small title="Log progress" onPress={() => onProgress(g)} /> : null}
        {self && ['active', 'paused'].includes(g.status) ? <Btn small title="Share with coach" color={c.paper} ink={c.ink} onPress={() => onShare('goal', g.id)} /> : null}
        {self && g.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} loading={busy === g.id} onPress={() => setStatus('paused')} /> : null}
        {self && g.status === 'paused' ? <Btn small title="Resume" color={c.paper} ink={c.ink} loading={busy === g.id} onPress={() => setStatus('active')} /> : null}
        {self && ['active', 'paused'].includes(g.status) ? <Btn small title="I achieved this" color={c.paper} ink={c.ink} onPress={() => onEdit({ mode: 'achieve', g })} /> : null}
        {self && ['active', 'paused'].includes(g.status) ? <Btn small title="Drop" color={c.paper} ink={c.red} loading={busy === g.id} onPress={() => setStatus('dropped')} /> : null}
        {self && ['achieved', 'dropped'].includes(g.status) ? <Btn small title="Reopen" color={c.paper} ink={c.ink} loading={busy === g.id} onPress={() => setStatus('active')} /> : null}
        <Btn small title={open ? 'Hide history' : 'History'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} />
      </View>
      {open ? (
        <View style={{ marginTop: 8, gap: 4 }}>
          {detail.loading && !detail.data ? <Loading /> : detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : detail.data ? (
            <>
              <T size={11} weight="800" color={c.mute}>MY PROGRESS (SELF-REPORTED)</T>
              {!detail.data.progress.length ? <T size={12} color={c.mute}>Nothing logged yet.</T> : detail.data.progress.map((p) => <T key={p.id} size={12}>{p.logged_on}{p.value !== null ? ` · ${p.value} ${g.unit ?? ''}` : ''}{p.note ? ` · ${p.note}` : ''}</T>)}
              {detail.data.assessments.length ? <T size={11} weight="800" color={c.mute} style={{ marginTop: 6 }}>COACH ASSESSMENTS</T> : null}
              {detail.data.assessments.map((a) => <T key={a.id} size={12}>{a.coach_name} · {RATING[a.rating]} · {a.note}</T>)}
              <T size={11} weight="800" color={c.mute} style={{ marginTop: 6 }}>STATUS HISTORY</T>
              {detail.data.events.map((e, i) => <T key={i} size={12}>{label(e.to_status)}{e.note ? ` · ${e.note}` : ''} · {dateTimeIn(e.created_at, tz)}</T>)}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

export function MyGoalsBlock({ def, data, self, athleteId, reload }) {
  const { act, busy } = useAct(reload);
  const [form, setForm] = useState(null); // { mode: 'new' | 'progress' | 'achieve', g?, key }
  const [share, setShare] = useState(null);
  const items = data.items;
  const open = (mode, extra = {}) => setForm({ mode, key: newKey(), ...extra });
  return (
    <View style={{ marginTop: 14 }} accessibilityRole="summary">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <T size={13} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{def.title.toUpperCase()}{items.length ? ` · ${items.length}${data.has_more ? '+' : ''}` : ''}</T>
        {self ? <Btn small title="New goal" onPress={() => open('new')} accessibilityLabel="Set a new personal goal" /> : null}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>Goals you set yourself. Your status is your own claim; a coach only sees one you share, and their view is shown separately.</T>
      <View style={{ marginTop: 6 }}>
        {!items.length ? <Empty emoji={def.empty[0]} title={def.empty[1]} sub={self ? def.empty[2] : 'This young person has not set any goals of their own.'} /> : items.map((g) => (
          <GoalCard key={g.id} g={{ ...g, owner_id: athleteId }} self={self} act={act} busy={busy} onProgress={(x) => open('progress', { g: x })} onShare={(kind, id) => setShare({ kind, id })} onEdit={(f) => open(f.mode, { g: f.g })} />
        ))}
      </View>
      <FormSheet visible={form?.mode === 'new'} onClose={() => setForm(null)} title="New personal goal" submitLabel="Set goal" initial={{ category: 'technical' }}
        fields={[
          { key: 'title', label: 'What do you want to achieve?' },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'category', label: 'Kind of goal', type: 'chips', options: CATEGORIES },
          { key: 'measure', label: 'How will you know?', type: 'multiline', optional: true, hint: 'For example: "8 of 10 passes land on target".' },
          { key: 'target_value', label: 'Target number', type: 'number', optional: true },
          { key: 'unit', label: 'Measured in', type: 'chips', options: UNITS, optional: true, show: (v) => v.target_value !== undefined && v.target_value !== '' },
          { key: 'review_on', label: 'First review date', type: 'date', optional: true, min: new Date().toISOString().slice(0, 10) },
          { key: 'review_cadence_days', label: 'Then review', type: 'chips', options: CADENCE, optional: true },
        ]}
        onSubmit={async (v) => { await api.post('/me/goals', { ...v, review_cadence_days: v.review_cadence_days ? Number(v.review_cadence_days) : undefined, client_key: form.key }); reload(); return 'Goal set'; }} />
      <FormSheet visible={form?.mode === 'progress'} onClose={() => setForm(null)} title="Log progress" submitLabel="Save" initial={{}}
        fields={[
          ...(form?.g?.unit ? [{ key: 'value', label: `Where are you now? (${form.g.unit})`, type: 'number', optional: true }] : []),
          { key: 'logged_on', label: 'Date', type: 'date', optional: true, max: new Date().toISOString().slice(0, 10) },
          { key: 'note', label: 'Note', type: 'multiline', optional: true, hint: 'What you did or noticed. No medical details.' },
        ]}
        onSubmit={async (v) => { await api.post(`/me/goals/${form.g.id}/progress`, { ...v, client_key: form.key }); reload(); return 'Progress saved'; }} />
      <FormSheet visible={form?.mode === 'achieve'} onClose={() => setForm(null)} title="Mark as achieved" submitLabel="Mark achieved" initial={{}}
        fields={[{ key: 'status_note', label: 'How do you know you got there?', type: 'multiline', hint: 'This is your own claim. A coach can add their view separately.' }]}
        onSubmit={async (v) => { await api.patch(`/me/goals/${form.g.id}`, { row_version: form.g.row_version, status: 'achieved', status_note: v.status_note }); reload(); return 'Marked achieved'; }} />
      <ShareSheet form={share} onClose={() => setShare(null)} onDone={reload} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ self-directed plans
function PlanCard({ p, self, act, busy, onAdd, onShare, onRecord }) {
  const [open, setOpen] = useState(false);
  const detail = useLoad(() => (open ? api.get(`/me/personal-plans/${p.id}`, self ? {} : { athlete_id: p.owner_id }) : Promise.resolve(null)), [open, p.id, p.row_version, p.completed, p.total, p.updated_at]);
  const setStatus = (status) => act(p.id, () => api.patch(`/me/personal-plans/${p.id}`, { row_version: p.row_version, status }), `Plan ${status}`);
  return (
    <Card pad={12} style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <T weight="700" style={{ flexShrink: 1 }}>{p.title}</T>
        <Tag label={MY_STATUS[p.status] ?? label(p.status)} color={c.violetSoft} />
      </View>
      {p.intent ? <T size={13} style={{ marginTop: 2 }}>{p.intent}</T> : null}
      <T size={12} color={c.mute}>{[p.sport, `${p.completed}/${p.total} sessions done`, p.next_session_at ? `next ${dateTimeIn(p.next_session_at, tz)}` : null, p.goal_title ? `for “${p.goal_title}”` : null].filter(Boolean).join(' · ')}</T>
      <Views item={p} claim={MY_STATUS[p.status]} />
      {self ? <Shares item={p} busy={busy} onRevoke={(sid) => act(sid, () => api.del(`/me/shares/${sid}`), 'Sharing stopped')} /> : null}
      {p.adopted_by?.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>Adopted by {p.adopted_by.map((a) => a.coach_name).join(', ')} - they will propose it back to you</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {self && ['active', 'paused'].includes(p.status) ? <Btn small title="Add session" onPress={() => onAdd(p)} /> : null}
        {self && ['active', 'paused'].includes(p.status) ? <Btn small title="Share with coach" color={c.paper} ink={c.ink} onPress={() => onShare('plan', p.id)} /> : null}
        {self && p.status === 'active' ? <Btn small title="Pause" color={c.paper} ink={c.ink} loading={busy === p.id} onPress={() => setStatus('paused')} /> : null}
        {self && p.status === 'paused' ? <Btn small title="Resume" color={c.paper} ink={c.ink} loading={busy === p.id} onPress={() => setStatus('active')} /> : null}
        {self && ['active', 'paused'].includes(p.status) ? <Btn small title="Finish plan" color={c.paper} ink={c.ink} loading={busy === p.id} onPress={() => setStatus('completed')} /> : null}
        {self && ['completed', 'dropped'].includes(p.status) ? <Btn small title="Reopen" color={c.paper} ink={c.ink} loading={busy === p.id} onPress={() => setStatus('active')} /> : null}
        <Btn small title={open ? 'Hide sessions' : 'Sessions'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} />
      </View>
      {open ? (
        <View style={{ marginTop: 8, gap: 6 }}>
          {detail.loading && !detail.data ? <Loading /> : detail.error ? <ErrorBox error={detail.error} onRetry={detail.reload} /> : detail.data ? (
            <>
              {!detail.data.sessions.length ? <T size={12} color={c.mute}>No sessions yet. Add the first one to start the plan.</T> : detail.data.sessions.map((s) => (
                <View key={s.id} style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" size={14} style={{ flexShrink: 1 }}>{s.title}</T><Tag label={MY_STATUS[s.status]} color={c.violetSoft} /></View>
                  <T size={12} color={c.mute}>{dateTimeIn(s.starts_at, tz)} · {s.duration_min} min · {label(s.kind)}{s.target_rpe ? ` · target effort ${s.target_rpe}/10` : ''}</T>
                  {s.instructions ? <T size={12}>{s.instructions}</T> : null}
                  {['completed', 'skipped'].includes(s.status) ? <T size={12} color={c.mute}>Self-reported{s.rpe ? ` · effort ${s.rpe}/10` : ''}{s.note ? ` · “${s.note}”` : ''}</T> : null}
                  {self && s.status === 'scheduled' ? (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                      <Btn small title="Record outcome" onPress={() => onRecord(s)} />
                      <Btn small title="Skip" color={c.paper} ink={c.ink} loading={busy === s.id} onPress={() => act(s.id, () => api.patch(`/me/personal-plan-sessions/${s.id}`, { status: 'skipped' }), 'Marked skipped')} />
                      <Btn small title="Cancel" color={c.paper} ink={c.red} loading={busy === s.id} onPress={() => act(s.id, () => api.patch(`/me/personal-plan-sessions/${s.id}`, { status: 'cancelled' }), 'Session cancelled')} />
                    </View>
                  ) : null}
                </View>
              ))}
              {detail.data.assessments.length ? <T size={11} weight="800" color={c.mute} style={{ marginTop: 6 }}>COACH ASSESSMENTS</T> : null}
              {detail.data.assessments.map((a) => <T key={a.id} size={12}>{a.coach_name} · {RATING[a.rating]} · {a.note}</T>)}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

export function MyTrainingBlock({ def, data, self, athleteId, reload }) {
  const { act, busy } = useAct(reload);
  const [form, setForm] = useState(null); // { mode: 'new' | 'session' | 'record', p?, s?, key }
  const [share, setShare] = useState(null);
  const goals = useLoad(() => (self ? api.get('/me/goals', { limit: 100 }) : Promise.resolve([])), [self, data.items.length]);
  const open = (mode, extra = {}) => setForm({ mode, key: newKey(), ...extra });
  const items = data.items;
  const sessionFields = [
    { key: 'title', label: 'Session' },
    { key: 'kind', label: 'Type', type: 'chips', options: KINDS },
    { key: 'date', label: 'Date', type: 'date', min: new Date().toISOString().slice(0, 10) },
    { key: 'time', label: 'Start time', type: 'time' },
    { key: 'duration_min', label: 'Duration (minutes)', type: 'stepper', min: 15, max: 480, step: 15, default: 45 },
    { key: 'target_rpe', label: 'Target effort 1-10 (optional)', type: 'stepper', min: 1, max: 10, step: 1, default: 6, optional: true },
    { key: 'instructions', label: 'What you will do', type: 'multiline', optional: true },
  ];
  const sessionBody = (v, key) => ({ starts_at: localToIso(v.date, v.time, tz), duration_min: Number(v.duration_min ?? 45), kind: v.kind ?? 'skill', title: v.title, instructions: v.instructions || undefined, target_rpe: v.target_rpe ? Number(v.target_rpe) : undefined, client_key: key });
  return (
    <View style={{ marginTop: 14 }} accessibilityRole="summary">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <T size={13} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{def.title.toUpperCase()}{items.length ? ` · ${items.length}${data.has_more ? '+' : ''}` : ''}</T>
        {self ? <Btn small title="New plan" onPress={() => open('new')} accessibilityLabel="Make a new training plan of your own" /> : null}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>Training you plan yourself. Plans a coach proposes stay under Coach plans.</T>
      <View style={{ marginTop: 6 }}>
        {!items.length ? <Empty emoji={def.empty[0]} title={def.empty[1]} sub={self ? def.empty[2] : 'This young person has no plans of their own.'} /> : items.map((p) => (
          <PlanCard key={p.id} p={{ ...p, owner_id: athleteId }} self={self} act={act} busy={busy} onAdd={(x) => open('session', { p: x })} onShare={(kind, id) => setShare({ kind, id })} onRecord={(s) => open('record', { s })} />
        ))}
      </View>
      <FormSheet visible={form?.mode === 'new'} onClose={() => setForm(null)} title="New training plan" submitLabel="Create plan" initial={{}}
        fields={[
          { key: 'title', label: 'Plan name' },
          { key: 'sport', label: 'Sport', type: 'sport', optional: true },
          { key: 'goal_id', label: 'Which goal is it for?', type: 'chips', optional: true, options: (goals.data ?? []).filter((g) => ['active', 'paused'].includes(g.status)).map((g) => ({ value: g.id, label: g.title })) },
          { key: 'intent', label: 'What is it for?', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post('/me/personal-plans', { ...v, client_key: form.key }); reload(); return 'Plan created - add your first session'; }} />
      <FormSheet visible={form?.mode === 'session'} onClose={() => setForm(null)} title="Add a session" submitLabel="Add session" initial={{}} fields={sessionFields}
        onSubmit={async (v) => { await api.post(`/me/personal-plans/${form.p.id}/sessions`, sessionBody(v, form.key)); reload(); return 'Session added'; }} />
      <FormSheet visible={form?.mode === 'record'} onClose={() => setForm(null)} title="How did it go?" submitLabel="Save" initial={{ rpe: 6 }}
        fields={[{ key: 'rpe', label: 'Effort 1-10', type: 'stepper', min: 1, max: 10, step: 1, default: 6 }, { key: 'note', label: 'Notes (no medical details)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.patch(`/me/personal-plan-sessions/${form.s.id}`, { status: 'completed', rpe: Number(v.rpe), note: v.note || undefined }); reload(); return 'Session recorded'; }} />
      <ShareSheet form={share} onClose={() => setShare(null)} onDone={reload} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ coach side
/** Goals and plans one athlete has shared with the signed-in coach, with the athlete's claims and the coach's own assessment kept apart. */
export function SharedByPlayers({ athlete_id }) {
  const goals = useLoad(() => api.get('/coaching/player-shared', { kind: 'goal', athlete_id }), [athlete_id]);
  const plans = useLoad(() => api.get('/coaching/player-shared', { kind: 'plan', athlete_id }), [athlete_id]);
  const reload = () => { goals.reload(); plans.reload(); };
  const { act, busy } = useAct(reload);
  const { toast } = useSession();
  const [form, setForm] = useState(null); // { kind, item, key }
  const [open, setOpen] = useState(null);
  const key = useRef(null);
  const rows = [...(goals.data ?? []).map((x) => ({ ...x, kind: 'goal' })), ...(plans.data ?? []).map((x) => ({ ...x, kind: 'plan' }))];
  const adopt = (r) => act(r.id, async () => { const out = await api.post(`/coaching/player-shared/${r.kind}/${r.id}/adopt`, {}); toast(out.already_adopted ? 'Already adopted' : r.kind === 'goal' ? 'Adopted as your coaching goal' : 'Adopted as a draft plan - edit it, then propose it back'); });
  return (
    <Section title="Shared by the player">
      <T size={12} color={c.mute} style={{ marginBottom: 6 }}>Goals and plans the player chose to share with you. What they write is their own claim; your assessment is yours and is shown to them labelled as such. They can stop sharing at any time.</T>
      {(goals.loading && !goals.data) || (plans.loading && !plans.data) ? <Loading /> : goals.error || plans.error ? <ErrorBox error={goals.error ?? plans.error} onRetry={reload} /> : !rows.length ? (
        <Empty emoji="🤝" title="Nothing shared with you" sub="When this player shares one of their own goals or plans, it appears here." />
      ) : rows.map((r) => (
        <Card key={`${r.kind}${r.id}`} pad={12} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T weight="700" style={{ flexShrink: 1 }}>{r.title}</T><Tag label={r.kind === 'goal' ? "Player's goal" : "Player's plan"} color={c.violetSoft} />
          </View>
          {r.kind === 'goal' ? <T size={12} color={c.mute}>{[r.measure, r.target_value !== null ? `Target ${r.target_value} ${r.unit}` : null, r.latest_value !== null && r.latest_value !== undefined ? `latest ${r.latest_value} ${r.unit} (self-reported)` : null, r.review_on ? `Review ${r.review_on}` : null].filter(Boolean).join(' · ')}</T>
            : <T size={12} color={c.mute}>{[r.intent, `${r.completed}/${r.total} sessions done (self-reported)`, r.next_session_at ? `next ${dateTimeIn(r.next_session_at, tz)}` : null].filter(Boolean).join(' · ')}</T>}
          <Views item={r} claim={MY_STATUS[r.status]} coachSide />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title="Assess" onPress={() => { key.current = newKey(); setForm({ kind: r.kind, item: r }); }} />
            <Btn small title={r.adopted ? 'Adopted' : r.kind === 'goal' ? 'Adopt as my goal' : 'Adopt as draft plan'} color={c.paper} ink={c.ink} disabled={r.adopted} loading={busy === r.id} onPress={() => adopt(r)} />
            <Btn small title={open === r.id ? 'Hide detail' : 'Detail'} color={c.paper} ink={c.ink} onPress={() => setOpen(open === r.id ? null : r.id)} />
          </View>
          {open === r.id ? <SharedDetail r={r} /> : null}
        </Card>
      ))}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title="Your assessment" submitLabel="Save assessment" initial={{ rating: 'on_track' }}
        fields={[{ key: 'rating', label: 'Where is it?', type: 'chips', options: RATING_CHOICES }, { key: 'note', label: 'Your note for the player', type: 'multiline', hint: 'Shown to the player as your view. It does not change their own status.' }]}
        onSubmit={async (v) => { await api.post(`/coaching/player-shared/${form.kind}/${form.item.id}/assessments`, { rating: v.rating, note: v.note, client_key: key.current }); reload(); return 'Assessment saved'; }} />
    </Section>
  );
}

function SharedDetail({ r }) {
  const d = useLoad(() => api.get(`/coaching/player-shared/${r.kind}/${r.id}`), [r.kind, r.id, r.my_assessment?.id]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const x = d.data;
  return (
    <View style={{ marginTop: 8, gap: 3 }}>
      {r.kind === 'goal' ? (
        <>
          <T size={11} weight="800" color={c.mute}>PLAYER&apos;S PROGRESS (SELF-REPORTED)</T>
          {!x.progress.length ? <T size={12} color={c.mute}>Nothing logged yet.</T> : x.progress.map((p) => <T key={p.id} size={12}>{p.logged_on}{p.value !== null ? ` · ${num(p.value)} ${r.unit ?? ''}` : ''}{p.note ? ` · ${p.note}` : ''}</T>)}
        </>
      ) : (
        <>
          <T size={11} weight="800" color={c.mute}>SESSIONS (OUTCOMES SELF-REPORTED)</T>
          {!x.sessions.length ? <T size={12} color={c.mute}>No sessions yet.</T> : x.sessions.map((s) => <T key={s.id} size={12}>{dateTimeIn(s.starts_at, tz)} · {s.title} · {MY_STATUS[s.status]}{s.rpe ? ` · effort ${s.rpe}/10` : ''}{s.note ? ` · “${s.note}”` : ''}</T>)}
        </>
      )}
      {x.assessments.length ? <T size={11} weight="800" color={c.mute} style={{ marginTop: 6 }}>YOUR ASSESSMENTS</T> : null}
      {x.assessments.map((a) => <T key={a.id} size={12}>{RATING[a.rating]} · {a.note}</T>)}
    </View>
  );
}
