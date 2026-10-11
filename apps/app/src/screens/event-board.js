// Department plans as kanban boards. Each department follows its own board; "My day" gathers the tasks assigned to you across
// events; "Run sheet" lines up every dated task of the event in time order. Move cards with the arrows (and reorder with up/down).
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { A, AAvatar, ABtn, ACard, AChip, AEmpty, ASection, AT, ATabs, DeptChip, ReasonSheet } from '../arena';
import { EntityPicker } from '../entity-picker';
import { ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { DateField, TimeField } from '../pickers';

const PRIO = { low: ['Low', A.mute], normal: ['Normal', A.cyan], high: ['High', A.sun], urgent: ['Urgent', A.red] };
const dayName = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// a local calendar date + time of day -> an instant the API accepts
const instant = (date, time) => (date && time ? new Date(`${date}T${time}:00`).toISOString() : undefined);

/** The older planning checklist (a plain task list) lives on a board now: one place for tasks. Offered once, safe to repeat, nothing is removed. */
function ChecklistImport({ id, onDone }) {
  const { toast } = useSession();
  const pending = useLoad(() => api.post(`/events/${id}/tasks/import`, { dry_run: true }), [id]);
  const [busy, setBusy] = useState(false);
  if (!pending.data?.pending) return null;
  const go = async () => {
    setBusy(true);
    try { const r = await api.post(`/events/${id}/tasks/import`, {}); toast(`${r.imported} task${r.imported === 1 ? '' : 's'} are on the board`); pending.reload(); onDone(); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <ACard tone={A.cyan} style={{ gap: 8 }}>
      <AT size={16} weight="900">📋 {pending.data.pending} task{pending.data.pending === 1 ? '' : 's'} in your planning checklist</AT>
      <AT size={13} color={A.mute}>Bring them onto a board so the whole team works from one place. The original list is kept.</AT>
      <ABtn small title="Bring them onto a board" tone="neon" onPress={go} loading={busy} style={{ alignSelf: 'flex-start' }} />
    </ACard>
  );
}

export function BoardTab({ id, isOrg }) {
  const [view, setView] = useState('board');
  const [version, setVersion] = useState(0);
  return (
    <>
      <ATabs value={view} onChange={setView} tabs={[{ key: 'board', label: 'Boards', icon: '🗂️' }, { key: 'mine', label: 'My day', icon: '☀️' }, { key: 'timeline', label: 'Run sheet', icon: '⏱️' }]} />
      {view === 'board' && isOrg ? <ChecklistImport id={id} onDone={() => setVersion((v) => v + 1)} /> : null}
      {view === 'board' && <Boards key={version} id={id} isOrg={isOrg} />}
      {view === 'mine' && <MyDay id={id} />}
      {view === 'timeline' && <RunSheet id={id} />}
    </>
  );
}

function Boards({ id, isOrg }) {
  const { toast } = useSession();
  const depts = useLoad(() => api.get(`/events/${id}/departments`), [id]);
  const plans = useLoad(() => api.get(`/events/${id}/plans`), [id]);
  const [dept, setDept] = useState(null);
  const [newPlan, setNewPlan] = useState(false);
  const [title, setTitle] = useState('');
  if (depts.error || plans.error) return <ErrorBox error={depts.error ?? plans.error} onRetry={() => { depts.reload(); plans.reload(); }} />;
  if (!depts.data || !plans.data) return <Loading />;
  const ds = depts.data;
  const d = ds.find((x) => x.id === dept) ?? ds[0];
  const plan = d ? plans.data.find((p) => p.department_id === d.id) : null;
  const createPlan = async () => {
    try { await api.post(`/departments/${d.id}/plans`, { title: title.trim() || `${d.name} plan` }); setNewPlan(false); setTitle(''); plans.reload(); toast('Board created'); } catch (x) { toast('' + x.message); }
  };
  if (!ds.length) return <AEmpty emoji="🧩" title="No departments yet" sub="Create departments first, then give each its own board." />;
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{ds.map((x) => <DeptChip key={x.id} dept={x} active={d.id === x.id} onPress={() => setDept(x.id)} />)}</View>
      {plan ? <Kanban key={plan.id} planId={plan.id} deptId={d.id} eventId={id} onChanged={plans.reload} />
        : <AEmpty emoji="🗂️" title={`${d.name} has no board yet`} sub={isOrg || d.lead_user_id ? 'A board holds the department\'s tasks.' : 'Its lead will set one up.'} action="Create the board" onAction={() => setNewPlan(true)} />}
      <Sheet visible={newPlan} onClose={() => setNewPlan(false)} title={`${d?.name ?? ''} board`}>
        <Field label="Plan name" value={title} onChangeText={setTitle} placeholder={`${d?.name ?? ''} plan`} />
        <ABtn title="Create board" onPress={createPlan} />
      </Sheet>
    </>
  );
}

function Kanban({ planId, deptId, eventId, onChanged }) {
  const { toast } = useSession();
  const board = useLoad(() => api.get(`/plans/${planId}/board`), [planId]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(null);   // column key
  const [blocking, setBlocking] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const { user } = useSession();
  const reload = () => { board.reload(); onChanged?.(); };
  if (board.error) return <ErrorBox error={board.error} onRetry={board.reload} />;
  if (!board.data) return <Loading />;
  const b = board.data, cols = b.columns;
  const move = async (card, colKey, reason) => { try { await api.post(`/cards/${card.id}/move`, { column_key: colKey, reason }); reload(); } catch (x) { toast('' + x.message); } };
  const shift = (card, d) => {
    const i = cols.findIndex((c) => c.key === card.column_key), to = cols[i + d];
    if (!to) return;
    if (to.key === 'blocked') setBlocking({ card, to }); else move(card, to.key);
  };
  const reorder = async (col, card, d) => {
    const at = col.cards.findIndex((x) => x.id === card.id) + d;
    if (at < 0 || at >= col.cards.length) return;
    try { await api.post(`/cards/${card.id}/move`, { column_key: col.key, position: at }); reload(); } catch (x) { toast('' + x.message); }
  };
  const total = cols.reduce((n, c) => n + c.cards.length, 0), done = cols[cols.length - 1].cards.length;
  return (
    <>
      <ACard tone={b.department.colour} pad={14} style={{ gap: 6 }}>
        <AT size={17} weight="900">{b.plan.title}</AT>
        {b.plan.goal ? <AT size={13} color={A.mute}>{b.plan.goal}</AT> : null}
        <View style={{ height: 8, borderRadius: 4, backgroundColor: A.panel2, overflow: 'hidden', marginTop: 4 }}><View style={{ width: `${total ? (done / total) * 100 : 0}%`, height: 8, backgroundColor: A.green }} /></View>
        <AT size={12} weight="700" color={A.mute}>{done} of {total} done</AT>
        <View style={{ flexDirection: 'row', gap: 8 }}><AChip label={mineOnly ? 'Showing mine' : 'Only mine'} active={mineOnly} onPress={() => setMineOnly(!mineOnly)} /></View>
      </ACard>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 6 }}>
        {cols.map((col, ci) => {
          const cards = col.cards.filter((c) => !mineOnly || c.assignee_ids.includes(user?.id));
          return (
            <View key={col.key} style={{ width: 272, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <AT size={13} weight="900" color={col.key === 'blocked' ? A.red : ci === cols.length - 1 ? A.green : A.ink} style={{ letterSpacing: 0.8 }}>{col.label.toUpperCase()}  <AT size={12} color={A.mute}>{col.cards.length}</AT></AT>
                <Pressable onPress={() => setAdding(col.key)} hitSlop={10}><AT size={20} weight="900" color={A.cyan}>＋</AT></Pressable>
              </View>
              {cards.map((card) => (
                <ACard key={card.id} pad={12} onPress={() => setOpen(card.id)} tone={card.overdue ? A.red : undefined} style={{ gap: 8 }}>
                  <AT size={14.5} weight="800" style={ci === cols.length - 1 ? { textDecorationLine: 'line-through', color: A.mute } : null}>{card.title}</AT>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <AT size={10.5} weight="900" color={PRIO[card.priority][1]}>{PRIO[card.priority][0].toUpperCase()}</AT>
                    {card.due_on ? <AT size={11.5} weight="700" color={card.overdue ? A.red : A.mute}>📅 {dayName(card.due_on)}</AT> : null}
                    {card.starts_at ? <AT size={11.5} weight="700" color={A.mute}>⏰ {hhmm(card.starts_at)}</AT> : null}
                    {card.checklist_total ? <AT size={11.5} weight="700" color={A.mute}>☑ {card.checklist_done}/{card.checklist_total}</AT> : null}
                    {card.comment_count ? <AT size={11.5} weight="700" color={A.mute}>💬 {card.comment_count}</AT> : null}
                  </View>
                  {card.blocked_reason && col.key === 'blocked' ? <AT size={12} color={A.red}>⛔ {card.blocked_reason}</AT> : null}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', marginLeft: 6 }}>{card.assignees.slice(0, 4).map((u) => <View key={u.id} style={{ marginLeft: -6 }}><AAvatar user={u} size={26} /></View>)}</View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {col.cards.length > 1 ? <><Mini label="↑" onPress={() => reorder(col, card, -1)} /><Mini label="↓" onPress={() => reorder(col, card, 1)} /></> : null}
                      {ci > 0 ? <Mini label="◀" onPress={() => shift(card, -1)} /> : null}
                      {ci < cols.length - 1 ? <Mini label="▶" hot onPress={() => shift(card, 1)} /> : null}
                    </View>
                  </View>
                </ACard>
              ))}
              {!cards.length ? <AT size={12.5} color={A.mute}>Empty</AT> : null}
            </View>
          );
        })}
      </ScrollView>
      <AddCard visible={!!adding} column={adding} planId={planId} deptId={deptId} eventId={eventId} onClose={() => setAdding(null)} onDone={reload} />
      <CardSheet id={open} deptId={deptId} eventId={eventId} onClose={() => setOpen(null)} onChanged={reload} />
      <ReasonSheet visible={!!blocking} onClose={() => setBlocking(null)} title="What is blocking it?" presets={['Waiting on someone', 'Missing equipment', 'Needs approval', 'Venue issue']} confirmLabel="Mark blocked" tone="live" onConfirm={(r) => move(blocking.card, blocking.to.key, r)} />
    </>
  );
}

const Mini = ({ label, onPress, hot }) => (
  <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${label}`} style={({ pressed }) => ({ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: hot ? `${A.violet}55` : A.panel2, opacity: pressed ? 0.6 : 1 })}>
    <AT size={12} weight="900">{label}</AT>
  </Pressable>
);

/** The department's active members, as options for the assignee picker. */
function useMembers(eventId, deptId, enabled) {
  const r = useLoad(() => (enabled ? api.get(`/events/${eventId}/roster`, { department_id: deptId, status: 'active', limit: 100 }) : Promise.resolve([])), [eventId, deptId, enabled]);
  return (r.data ?? []).map((m) => ({ id: m.id, label: m.display_name, sub: `@${m.handle}`, emoji: m.avatar_emoji, color: m.avatar_color }));
}

function AddCard({ visible, column, planId, deptId, eventId, onClose, onDone }) {
  const { toast } = useSession();
  const members = useMembers(eventId, deptId, visible);
  const [title, setTitle] = useState('');
  const [prio, setPrio] = useState('normal');
  const [due, setDue] = useState(undefined);
  const [day, setDay] = useState(undefined);
  const [time, setTime] = useState(undefined);
  const [who, setWho] = useState([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/plans/${planId}/cards`, { title: title.trim(), column_key: column, priority: prio, due_on: due, starts_at: instant(day, time), assignee_ids: who.map((w) => w.id) });
      setTitle(''); setDue(undefined); setDay(undefined); setTime(undefined); setWho([]); setPrio('normal'); onClose(); onDone(); toast('Task added');
    } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="New task">
      <Field label="What needs doing?" value={title} onChangeText={setTitle} />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{Object.entries(PRIO).map(([k, [l, col]]) => <AChip key={k} label={l} color={col} active={prio === k} onPress={() => setPrio(k)} />)}</View>
      <DateField label="Due date" value={due} onChange={setDue} optional />
      <DateField label="Starts on" value={day} onChange={setDay} optional />
      {day ? <TimeField label="Start time" value={time} onChange={setTime} optional /> : null}
      <EntityPicker kind="person" multi label="Assign to" optional options={members} value={who} onChange={setWho} />
      <ABtn title="Add task" onPress={save} loading={busy} disabled={title.trim().length < 2 || (day && !time)} />
    </Sheet>
  );
}

function CardSheet({ id, deptId, eventId, onClose, onChanged }) {
  const { toast, user } = useSession();
  const card = useLoad(() => (id ? api.get(`/cards/${id}`) : Promise.resolve(null)), [id]);
  const [msg, setMsg] = useState('');
  const c = card.data;
  const act = async (fn) => { try { await fn(); card.reload(); onChanged(); } catch (x) { toast('' + x.message); } };
  const tick = (i) => act(() => api.patch(`/cards/${id}`, { checklist: c.checklist.map((x, k) => (k === i ? { ...x, done: !x.done } : x)) }));
  return (
    <Sheet visible={!!id} onClose={onClose} title={c?.title ?? 'Task'}>
      {!c ? <T color="#64748B">Loading…</T> : (
        <>
          {c.description ? <T color="#334155">{c.description}</T> : null}
          <T size={12} color="#64748B">{[PRIO[c.priority][0], c.due_on ? `due ${dayName(c.due_on)}` : null, c.starts_at ? `${dayName(c.starts_at)} ${hhmm(c.starts_at)}` : null].filter(Boolean).join(' · ')}</T>
          {c.checklist?.length ? c.checklist.map((x, i) => <Pressable key={i} onPress={() => tick(i)}><T weight="600">{x.done ? '☑' : '☐'} {x.text}</T></Pressable>) : null}
          <T weight="800">Comments</T>
          {c.comments.length ? c.comments.map((m) => <T key={m.comment_id} size={13}><T weight="800" size={13}>{m.display_name}: </T>{m.body}</T>) : <T size={13} color="#64748B">No comments yet.</T>}
          <Field value={msg} onChangeText={setMsg} placeholder="Write a comment…" />
          <ABtn small title="Comment" disabled={!msg.trim()} onPress={() => act(async () => { await api.post(`/cards/${id}/comments`, { body: msg.trim() }); setMsg(''); })} />
          <T weight="800" style={{ marginTop: 6 }}>History</T>
          {c.history.map((h) => <T key={h.id} size={12} color="#64748B">{new Date(h.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {h.actor_name} · {h.action}{h.from_column ? ` ${h.from_column} → ${h.to_column}` : ''}{h.note ? ` (${h.note})` : ''}</T>)}
          <ABtn small tone="ghost" title="Archive task" onPress={() => act(async () => { await api.patch(`/cards/${id}`, { archived: true }); onClose(); })} />
        </>
      )}
    </Sheet>
  );
}

function MyDay({ id }) {
  const mine = useLoad(() => api.get('/me/event-schedule', { event_id: id }), [id]);
  if (mine.error) return <ErrorBox error={mine.error} onRetry={mine.reload} />;
  if (!mine.data) return <Loading />;
  if (!mine.data.length) return <AEmpty emoji="☀️" title="Nothing assigned to you" sub="Tasks assigned to you show up here, soonest first." />;
  const groups = new Map();
  for (const t of mine.data) { const k = t.starts_at ?? t.due_on; const key = k ? dayName(k) : 'No date'; groups.set(key, [...(groups.get(key) ?? []), t]); }
  return [...groups.entries()].map(([day, items]) => (
    <View key={day} style={{ gap: 8 }}>
      <ASection title={day} />
      {items.map((t) => (
        <ACard key={t.id} pad={12} tone={t.overdue ? A.red : t.colour}>
          <AT size={14.5} weight="800">{t.title}</AT>
          <AT size={12} color={A.mute}>{t.department} · {t.column_key.replace(/_/g, ' ')}{t.starts_at ? ` · ${hhmm(t.starts_at)}` : ''}{t.overdue ? ' · overdue' : ''}</AT>
          {t.blocked_reason && t.column_key === 'blocked' ? <AT size={12} color={A.red}>⛔ {t.blocked_reason}</AT> : null}
        </ACard>
      ))}
    </View>
  ));
}

function RunSheet({ id }) {
  const tl = useLoad(() => api.get(`/events/${id}/timeline`), [id]);
  if (tl.error) return <ErrorBox error={tl.error} onRetry={tl.reload} />;
  if (!tl.data) return <Loading />;
  if (!tl.data.length) return <AEmpty emoji="⏱️" title="No dated tasks yet" sub="Tasks with a date or start time line up here across departments." />;
  return (
    <View style={{ gap: 8 }}>
      {tl.data.map((t) => {
        const at = t.starts_at ?? t.due_on;
        return (
          <ACard key={t.id} pad={12} tone={t.colour} style={{ opacity: t.done_at ? 0.55 : 1 }}>
            <AT size={11.5} weight="800" color={A.cyan}>{dayName(at)}{t.starts_at ? ` · ${hhmm(t.starts_at)}` : ''}</AT>
            <AT size={14.5} weight="800" style={t.done_at ? { textDecorationLine: 'line-through' } : null}>{t.title}</AT>
            <AT size={12} color={A.mute}>{t.department}</AT>
          </ACard>
        );
      })}
    </View>
  );
}
