// Team workspace: a board-style home for a team — task board, my tasks, schedule with RSVP / attendance, roster,
// and master team ⇄ event/tournament sub-teams. Managers also get squads, recruiting and rates (from team-manage.js).
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { DateField } from '../pickers';
import { c, when, day } from '../theme';
import { RosterTab, SquadsTab, RecruitTab, MoneyTab, AVAIL } from './team-manage';

const COLUMNS = [['new', 'New', c.cyan], ['in_progress', 'In progress', c.sun], ['review', 'Ready for review', c.violet], ['done', 'Complete', c.mint]];
const RSVP = [['going', '✅ Going'], ['maybe', '🤔 Maybe'], ['no', '🚫 Can’t']];
const RSVP_LABEL = { going: 'Going', maybe: 'Maybe', no: 'Can’t make it', pending: 'No answer yet' };
const asTags = (s) => [...new Set(String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 6);

const Progress = ({ done, total, color = c.pink }) => (
  <View style={{ height: 6, borderRadius: 3, backgroundColor: c.line, overflow: 'hidden' }}>
    <View style={{ height: 6, width: `${total ? Math.round((done / total) * 100) : 0}%`, backgroundColor: color }} />
  </View>
);
const Faces = ({ users, size = 26 }) => (
  <View style={{ flexDirection: 'row' }}>{users.slice(0, 4).map((u, i) => <View key={u.id} style={{ marginLeft: i ? -8 : 0 }}><Avatar user={u} size={size} /></View>)}
    {users.length > 4 ? <T size={12} color={c.mute} weight="700" style={{ marginLeft: 6, alignSelf: 'center' }}>+{users.length - 4}</T> : null}</View>
);

export function TeamWorkspace({ id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const [tab, setTab] = useState('board');
  const team = useLoad(() => api.get(`/teams/${id}`), [id]);
  const ws = useLoad(() => api.get(`/teams/${id}/workspace`), [id]);
  const roster = useLoad(() => api.get(`/teams/${id}/roster`), [id]);
  if (team.error || ws.error) return <Screen><ErrorBox error={team.error ?? ws.error} onRetry={() => { team.reload(); ws.reload(); }} /></Screen>;
  if (!team.data || !ws.data) return <Screen><Loading /></Screen>;
  const t = team.data, w = ws.data, r = roster.data;
  const reload = () => { team.reload(); ws.reload(); roster.reload(); };
  const tabs = [['board', 'Board'], ['mine', `My tasks${w.my_open_tasks ? ` · ${w.my_open_tasks}` : ''}`], ['schedule', 'Schedule'], ['roster', 'Roster'],
    ...(w.can_manage ? [['squads', 'Squads'], ['recruit', 'Recruit']] : []), ...(r?.can_manage_money ? [['money', 'Rates']] : [])];
  const P = { t, r, reload, toast };
  const master = w.master_team;
  return (
    <Screen wide>
      <GradCard colors={[t.color, c.ink]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <T size={44}>{t.emoji}</T>
          <View style={{ flex: 1 }}>
            <H1 color="#fff" style={{ fontSize: 28 }}>{t.name}</H1>
            <T color="#fff" weight="800">{t.sport_emoji} {t.sport}{t.city ? ` · ${t.city}` : ''} · {t.members.length} players{master ? ` · sub-team of ${master.name}` : ''}</T>
          </View>
        </View>
        {t.description ? <T color="#fff" style={{ marginTop: 8 }}>{t.description}</T> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <Faces users={t.members} size={32} />
          {w.can_manage ? <Btn small title="＋ Invite" color={c.paper} ink={c.ink} onPress={() => setTab('roster')} /> : null}
          <Btn small title="💬 Chat" color={c.violet} onPress={() => push('TeamChat', { id })} />
        </View>
      </GradCard>

      {master || w.sub_teams.length ? (
        <View style={{ marginTop: 10 }}>
          <Seg value={id} onChange={(x) => x !== id && push('TeamWorkspace', { id: x })}
            options={[master ?? t, ...(master ? [t] : w.sub_teams)].map((x) => ({ value: x.id, label: `${x.emoji} ${x.name}${x.id === (master ?? t).id ? ' (master)' : ''}` }))} />
        </View>
      ) : null}

      <View style={{ marginTop: 10 }}><Seg options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} /></View>

      {tab === 'board' ? <Board teamId={id} reloadWs={ws.reload} /> : null}
      {tab === 'mine' ? <Board teamId={id} mine reloadWs={ws.reload} /> : null}
      {tab === 'schedule' ? <Schedule t={t} w={w} reload={reload} /> : null}
      {tab === 'roster' ? <RosterPanel {...P} w={w} /> : null}
      {tab === 'squads' && r ? <SquadsTab {...P} /> : null}
      {tab === 'recruit' && r ? <RecruitTab {...P} /> : null}
      {tab === 'money' && r ? <MoneyTab {...P} /> : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ board

function Board({ teamId, mine, reloadWs }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // task id, 'new' or null
  const [startIn, setStartIn] = useState('new');
  const data = useLoad(() => api.get(`/teams/${teamId}/tasks`, { mine: mine || undefined, q: q.trim() || undefined }), [teamId, mine, q]);
  const changed = () => { data.reload(); reloadWs(); };
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const cols = data.data?.columns;
  const total = cols ? Object.values(cols).reduce((n, l) => n + l.length, 0) : 0;
  return (
    <View style={{ marginTop: 10, gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}><Field value={q} onChangeText={setQ} placeholder="Search tasks" /></View>
        <Btn small title="＋ New task" onPress={() => { setStartIn('new'); setOpen('new'); }} />
      </View>
      {!cols ? <Loading /> : total === 0 && !q ? (
        <Empty emoji="📝" title={mine ? 'Nothing assigned to you' : 'No tasks yet'} sub={mine ? 'Tasks assigned to you show up here.' : 'Add the things your team needs to get done — kit, transport, fees, drills — and assign them.'} />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
          {COLUMNS.map(([key, label, color]) => (
            <View key={key} style={{ width: 280, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 3, borderBottomColor: color, paddingBottom: 6 }}>
                <T weight="800" size={15}>{label} <T color={c.mute} size={13}>{cols[key].length}</T></T>
                <Pressable onPress={() => { setStartIn(key); setOpen('new'); }} hitSlop={10}><T weight="800" size={18} color={c.mute}>＋</T></Pressable>
              </View>
              {cols[key].map((k) => <TaskCard key={k.id} k={k} onPress={() => setOpen(k.id)} />)}
              {!cols[key].length ? <T size={12} color={c.mute}>Nothing here</T> : null}
            </View>
          ))}
        </ScrollView>
      )}
      <TaskSheet teamId={teamId} taskId={open === 'new' ? null : open} startStatus={startIn} visible={!!open} workload={data.data?.workload ?? []} onClose={() => setOpen(null)} onChanged={changed} />
    </View>
  );
}

function TaskCard({ k, onPress }) {
  const late = k.due_on && k.status !== 'done' && k.due_on < new Date().toISOString().slice(0, 10);
  return (
    <Card onPress={onPress} pad={12}>
      <View style={{ gap: 8 }}>
        {k.tags.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{k.tags.map((x) => <Tag key={x} label={x} color={c.cyan} />)}</View> : null}
        <T weight="800">{k.title}</T>
        {k.description ? <T size={13} color={c.mute} numberOfLines={2}>{k.description}</T> : null}
        {k.subtasks_total ? <View style={{ gap: 4 }}><Progress done={k.subtasks_done} total={k.subtasks_total} /><T size={11} color={c.mute}>{k.subtasks_done}/{k.subtasks_total} done</T></View> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          {k.assignees.length ? <Faces users={k.assignees} /> : <T size={12} color={c.mute}>Unassigned</T>}
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <T size={12} color={c.mute}>💬 {k.comments}</T><T size={12} color={c.mute}>📎 {k.files}</T>
            {k.due_on ? <T size={12} weight="800" color={late ? c.red : c.mute}>{day(`${k.due_on}T00:00:00Z`)}</T> : null}
          </View>
        </View>
      </View>
    </Card>
  );
}

/** Create or edit a task: details, who it is assigned to (with their open-task count), checklist, comments and files. */
function TaskSheet({ teamId, taskId, startStatus, visible, workload, onClose, onChanged }) {
  const { toast } = useSession();
  const task = useLoad(() => (visible && taskId ? api.get(`/team-tasks/${taskId}`) : null), [visible, taskId]);
  return (
    <Sheet visible={visible} onClose={onClose} title={taskId ? 'Task' : 'Create new task'}>
      {visible && taskId && !task.data ? <Loading /> : visible ? <TaskForm key={taskId ?? 'new'} {...{ teamId, taskId, startStatus, workload, toast, onClose, onChanged }} task={task.data} reloadTask={task.reload} /> : null}
    </Sheet>
  );
}

function TaskForm({ teamId, taskId, startStatus, workload, toast, onClose, onChanged, task, reloadTask }) {
  const { user } = useSession();
  const [title, setTitle] = useState(task?.title ?? '');
  const [desc, setDesc] = useState(task?.description ?? '');
  const [tags, setTags] = useState((task?.tags ?? []).join(', '));
  const [due, setDue] = useState(task?.due_on?.slice(0, 10) ?? undefined);
  const [status, setStatus] = useState(task?.status ?? startStatus ?? 'new');
  const [who, setWho] = useState(new Set((task?.assignees ?? []).map((a) => a.id)));
  const [find, setFind] = useState('');
  const [subs, setSubs] = useState([]);
  const [newSub, setNewSub] = useState('');
  const [comment, setComment] = useState('');
  const [file, setFile] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState(false);
  const canEdit = !taskId || task?.can_edit;
  const people = workload.filter((p) => !find.trim() || `${p.display_name} ${p.handle}`.toLowerCase().includes(find.trim().toLowerCase()));
  const run = async (fn, ok) => { setBusy(true); try { await fn(); if (ok) toast(ok); onChanged(); } catch (e) { toast('' + e.message); } finally { setBusy(false); } };
  const toggle = (uid) => setWho((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });

  const save = () => run(async () => {
    const body = { title: title.trim(), description: desc.trim() || (taskId ? null : undefined), status, tags: asTags(tags), due_on: due ?? (taskId ? null : undefined), assignee_ids: [...who] };
    if (taskId) await api.patch(`/team-tasks/${taskId}`, body); else await api.post(`/teams/${teamId}/tasks`, { ...body, subtasks: subs });
    onClose();
  }, taskId ? 'Task saved' : 'Task added');
  const after = (fn) => run(async () => { await fn(); reloadTask(); });

  return (
    <View style={{ gap: 12 }}>
      <Field label="Task" value={title} onChangeText={setTitle} placeholder="What needs doing?" />
      <Field label="Details" value={desc} onChangeText={setDesc} multiline placeholder="Add notes, links or instructions" />
      <Field label="Tags" value={tags} onChangeText={setTags} placeholder="e.g. Kit, Transport" hint="Separate with commas" />
      <Seg value={status} onChange={setStatus} options={COLUMNS.map(([value, label]) => ({ value, label }))} />
      <DateField label="Due" value={due} onChange={setDue} optional />

      <T weight="800" size={13}>Assign to</T>
      <Field value={find} onChangeText={setFind} placeholder="Search the team" />
      {people.map((p) => (
        <Row key={p.id} onPress={() => toggle(p.id)} color={who.has(p.id) ? c.violetSoft : c.paper} left={<Avatar user={p} size={36} />} title={p.display_name} sub={`${p.open_tasks} open task${p.open_tasks === 1 ? '' : 's'}`} right={who.has(p.id) ? <T weight="900" color={c.pink}>✓</T> : null} />
      ))}

      {taskId && task ? <>
        <T weight="800" size={13}>Checklist{task.subtasks.length ? ` · ${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}` : ''}</T>
        {task.subtasks.length ? <Progress done={task.subtasks.filter((s) => s.done).length} total={task.subtasks.length} /> : null}
        {task.subtasks.map((s) => <Row key={s.id} onPress={() => after(() => api.patch(`/team-task-subtasks/${s.id}`, { done: !s.done }))} left={<T size={20}>{s.done ? '☑️' : '⬜'}</T>} title={s.title} />)}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={newSub} onChangeText={setNewSub} placeholder="Add a checklist item" /></View>
          <Btn small title="Add" disabled={!newSub.trim()} onPress={() => after(async () => { await api.post(`/team-tasks/${taskId}/subtasks`, { title: newSub.trim() }); setNewSub(''); })} />
        </View>

        <T weight="800" size={13}>Files</T>
        {task.files.map((f) => <Row key={f.id} left={<T size={20}>📎</T>} title={f.name} sub={f.url} />)}
        <Field value={file.name} onChangeText={(x) => setFile({ ...file, name: x })} placeholder="File name, e.g. Fixture list.pdf" />
        <Field value={file.url} onChangeText={(x) => setFile({ ...file, url: x })} placeholder="Link (https://…)" />
        <Btn small title="Attach link" color={c.violet} disabled={!file.name.trim() || !file.url.trim()} onPress={() => after(async () => { await api.post(`/team-tasks/${taskId}/files`, { name: file.name.trim(), url: file.url.trim() }); setFile({ name: '', url: '' }); })} />

        <T weight="800" size={13}>Comments · {task.comments.length}</T>
        {task.comments.map((k) => <Row key={k.id} left={<Avatar user={k} size={32} />} title={k.display_name} sub={k.body} />)}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={comment} onChangeText={setComment} placeholder="Write a comment" /></View>
          <Btn small title="Send" disabled={!comment.trim()} onPress={() => after(async () => { await api.post(`/team-tasks/${taskId}/comments`, { body: comment.trim() }); setComment(''); })} />
        </View>
      </> : !taskId ? <>
        <T weight="800" size={13}>Checklist</T>
        {subs.map((s, i) => <Row key={i} left={<T size={20}>⬜</T>} title={s} />)}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={newSub} onChangeText={setNewSub} placeholder="Add a checklist item" /></View>
          <Btn small title="Add" disabled={!newSub.trim()} onPress={() => { setSubs([...subs, newSub.trim()]); setNewSub(''); }} />
        </View>
      </> : null}

      {canEdit ? <Btn title={taskId ? 'Save task' : 'Done'} loading={busy} disabled={title.trim().length < 2} onPress={save} /> : <T size={12} color={c.mute}>Only managers, the creator or assignees can edit this task.</T>}
      {taskId && canEdit ? <Btn title="Archive task" color={c.paper} ink={c.orange} onPress={() => run(async () => { await api.del(`/team-tasks/${taskId}`); onClose(); }, 'Task archived')} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------ schedule, RSVP and attendance

function Schedule({ t, w, reload }) {
  const { toast } = useSession();
  const [att, setAtt] = useState(null);   // { event_id | fixture_id, label }
  const [subFor, setSubFor] = useState(null);
  const items = [
    ...w.schedule.events.map((e) => ({ key: `e${e.event_id}`, scope: { event_id: e.event_id }, title: e.name, sub: `${e.kind}${e.starts_on ? ` · ${day(e.starts_on)}` : ''}`, rsvp: e.my_rsvp, event: e })),
    ...w.schedule.fixtures.map((f) => ({ key: `f${f.fixture_id}`, scope: { fixture_id: f.fixture_id }, title: `${f.home_name ?? 'TBC'} vs ${f.away_name ?? 'TBC'}`, sub: `${f.event_name}${f.round ? ` · ${f.round}` : ''} · ${when(f.scheduled_at)}`, rsvp: f.my_rsvp })),
  ];
  const answer = async (it, rsvp) => { try { await api.post(`/teams/${t.id}/attendance`, { ...it.scope, rsvp }); toast('Thanks — your team can see your answer'); reload(); } catch (e) { toast('' + e.message); } };
  const subsByEvent = new Map(w.sub_teams.map((s) => [s.event_id, s]));
  return (
    <View style={{ marginTop: 10, gap: 10 }}>
      {!items.length ? <Empty emoji="📅" title="Nothing scheduled" sub="Events your team is entered in and its upcoming matches appear here, with RSVP and attendance." /> : null}
      {items.map((it) => (
        <Card key={it.key} pad={14}>
          <View style={{ gap: 10 }}>
            <View>
              <T weight="800" size={16}>{it.title}</T>
              <T size={13} color={c.mute}>{it.sub}</T>
            </View>
            {t.my_membership?.status === 'active' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {RSVP.map(([k, l]) => <Chip key={k} label={l} active={it.rsvp === k} onPress={() => answer(it, k)} />)}
                {!it.rsvp || it.rsvp === 'pending' ? <T size={12} color={c.mute}>Are you coming?</T> : null}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Btn small title="Who’s coming" color={c.violet} onPress={() => setAtt({ ...it.scope, label: it.title })} />
              {w.can_manage && t.kind === 'master' && it.event && !subsByEvent.has(it.scope.event_id) ? <Btn small title="Sub-team for this event" color={c.paper} ink={c.ink} onPress={() => setSubFor(it.event)} /> : null}
              {subsByEvent.has(it.scope?.event_id) ? <Tag label={`Sub-team: ${subsByEvent.get(it.scope.event_id).name}`} color={c.mint} /> : null}
            </View>
          </View>
        </Card>
      ))}
      <Attendance t={t} scope={att} manage={w.can_manage} onClose={() => setAtt(null)} />
      <FormSheet visible={!!subFor} onClose={() => setSubFor(null)} title={`Sub-team for ${subFor?.name ?? ''}`} submitLabel="Create sub-team"
        initial={{ roster: 'same', name: subFor ? `${t.name} · ${subFor.name}`.slice(0, 60) : '' }}
        fields={[
          { key: 'name', label: 'Sub-team name' },
          { key: 'roster', label: 'Players', type: 'choice', options: [{ value: 'same', label: 'Same as master team' }, { value: 'pick', label: 'Choose players' }] },
          { key: 'member_ids', label: 'Players for this event', type: 'multi', show: (v) => v.roster === 'pick', options: t.members.filter((m) => m.id !== t.owner_id).map((m) => ({ value: m.id, label: m.display_name })) },
        ]}
        onSubmit={async (v) => { const s = await api.post(`/teams/${t.id}/sub-teams`, { name: v.name, event_id: subFor.event_id, ...(v.roster === 'pick' ? { member_ids: v.member_ids ?? [] } : { copy_roster: true }) }); reload(); return `${s.name} created`; }} />
    </View>
  );
}

function Attendance({ t, scope, manage, onClose }) {
  const { toast } = useSession();
  const q = scope ? { event_id: scope.event_id, fixture_id: scope.fixture_id } : null;
  const data = useLoad(() => (q ? api.get(`/teams/${t.id}/attendance`, q) : null), [scope?.event_id, scope?.fixture_id]);
  const act = async (fn, msg) => { try { await fn(); toast(msg); data.reload(); } catch (e) { toast('' + e.message); } };
  const d = data.data;
  return (
    <Sheet visible={!!scope} onClose={onClose} title={`Who’s coming · ${scope?.label ?? ''}`}>
      {!d ? <Loading /> : <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={`✅ ${d.counts.going} going`} color={c.mint} /><Tag label={`🤔 ${d.counts.maybe} maybe`} color={c.sun} /><Tag label={`🚫 ${d.counts.no} no`} color={c.orange} /><Tag label={`${d.counts.pending} no answer`} />
          <Tag label={`${d.counts.checked_in} arrived`} color={c.cyan} />
        </View>
        {d.can_manage ? <Btn small title="Ask everyone to RSVP" color={c.violet} onPress={() => act(async () => { const r = await api.post(`/teams/${t.id}/attendance/request`, q); toast(`Asked ${r.asked} people`); }, 'Reminder sent')} /> : null}
        {d.people.map((p) => (
          <Card key={p.id} pad={12}>
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Avatar user={p} size={36} />
                <View style={{ flex: 1 }}>
                  <T weight="800">{p.jersey_no != null ? `#${p.jersey_no} ` : ''}{p.display_name}</T>
                  <T size={12} color={c.mute}>{RSVP_LABEL[p.rsvp]}{p.note ? ` · “${p.note}”` : ''}{p.availability !== 'available' ? ` · ${AVAIL[p.availability][1]}` : ''}</T>
                </View>
                {p.checked_in_at ? <Tag label="Arrived" color={c.cyan} /> : p.confirmed_at ? <Tag label="Confirmed" color={c.mint} /> : null}
              </View>
              {d.can_manage ? (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {p.rsvp === 'going' || p.rsvp === 'maybe' ? <Chip label={p.confirmed_at ? 'Unconfirm' : '✔ Confirm'} onPress={() => act(() => api.patch(`/teams/${t.id}/attendance/${p.id}`, { ...q, confirmed: !p.confirmed_at }), p.confirmed_at ? 'Unconfirmed' : 'Confirmed')} /> : null}
                  <Chip label={p.checked_in_at ? 'Undo check-in' : '📍 Check in'} onPress={() => act(() => api.post(`/teams/${t.id}/attendance/${p.id}/check-in`, { ...q, checked_in: !p.checked_in_at }), p.checked_in_at ? 'Check-in undone' : 'Checked in')} />
                </View>
              ) : null}
            </View>
          </Card>
        ))}
      </>}
    </Sheet>
  );
}

// ------------------------------------------------------------------ roster (+ sub-team player selection)

function RosterPanel({ t, r, reload, toast, w }) {
  const [pick, setPick] = useState(false);
  if (!r) return <Loading />;
  return (
    <View style={{ marginTop: 6 }}>
      {w.can_manage && t.kind === 'sub' ? <Btn small title="Choose players for this event" onPress={() => setPick(true)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
      {w.can_manage ? <RosterTab t={t} r={r} reload={reload} toast={toast} /> : (
        <Section title="Players & staff" color={c.cyan}>
          {r.members.map((m) => <Row key={m.id} left={<Avatar user={m} />} title={`${m.jersey_no != null ? '#' + m.jersey_no + ' ' : ''}${m.display_name}`} sub={[m.team_role, m.position].filter(Boolean).join(' · ')} right={<Tag label={`${AVAIL[m.availability][0]} ${AVAIL[m.availability][1]}`} />} />)}
        </Section>
      )}
      {pick ? <SubRoster t={t} w={w} onClose={() => setPick(false)} onSaved={reload} /> : null}
    </View>
  );
}

function SubRoster({ t, w, onClose, onSaved }) {
  const { toast } = useSession();
  const master = useLoad(() => api.get(`/teams/${w.master_team.id}/roster`), []);
  const [sel, setSel] = useState(() => new Set(t.members.map((m) => m.id)));
  const toggle = (uid) => setSel((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  const save = async () => { try { await api.post(`/teams/${t.id}/sub-roster`, { user_ids: [...sel] }); toast('Sub-team roster saved'); onSaved(); onClose(); } catch (e) { toast('' + e.message); } };
  return (
    <Sheet visible onClose={onClose} title="Players for this event">
      <T size={13} color={c.mute}>Pick from the master team roster. The master roster is not changed.</T>
      {!master.data ? <Loading /> : master.data.members.filter((m) => m.status === 'active' && !m.is_owner).map((m) => (
        <Row key={m.id} onPress={() => toggle(m.id)} color={sel.has(m.id) ? c.violetSoft : c.paper} left={<Avatar user={m} size={36} />} title={m.display_name} sub={m.team_role} right={sel.has(m.id) ? <T weight="900" color={c.pink}>✓</T> : null} />
      ))}
      <Btn title={`Save · ${sel.size} players`} onPress={save} />
    </Sheet>
  );
}
