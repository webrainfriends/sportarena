import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Loading, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { explain, LoadError } from '../access';

const KINDS = [{ value: 'task', label: 'Task' }, { value: 'review', label: 'Review' }, { value: 'expiry', label: 'Expiry / renewal' }];
const KIND = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const FILTERS = [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }];
const when = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const STALE = 'This task was changed by someone else while you were editing. The latest version is shown now — review it and try again.';

/**
 * Tasks, assignments and working notes for an agreement or a funding program (#306), in one place. Internal items are visible to your own
 * side only; a shared item (agreements) is visible to the other side too but only the owning side changes it. The server enforces all of it;
 * this screen only hides what would be refused. Reminders and escalation are sent by the worker and never contain the task text.
 * @param {{ target: { sponsorship_id?: string, program_id?: string }, ends_on?: string, shareable?: boolean }} p
 */
export function SponsorTasks({ target, ends_on, shareable = true }) {
  const { toast } = useSession();
  const [filter, setFilter] = useState('open');
  const [mineOnly, setMineOnly] = useState(false);
  const [form, setForm] = useState(null); // { kind: 'new' } | { kind: 'edit', t } | { kind: 'escalate', t }
  const [notes, setNotes] = useState(null); // task whose notes are open
  const key = JSON.stringify(target);
  const list = useLoad(() => api.get('/sponsorship-tasks', mineOnly ? { mine: true, status: filter, limit: 100 } : { ...target, status: filter, limit: 100 }), [key, filter, mineOnly]);
  const [busy, setBusy] = useState(null);
  const d = list.data;
  const act = async (id, fn, ok) => {
    setBusy(id);
    try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.status === 409 && e.details?.code === 'stale_version' ? STALE : explain(e)); } finally { setBusy(null); list.reload(); }
  };
  const people = (d?.assignable ?? []).map((p) => ({ value: p.id, label: p.name }));
  const canWrite = !!d?.can_write;

  return (
    <Section title="Tasks & notes" color={c.orange} action={canWrite ? '+ Task' : undefined} onAction={() => setForm({ kind: 'new' })}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }} accessibilityRole="tablist">
        {FILTERS.map((f) => <Chip key={f.value} label={f.label} active={filter === f.value} onPress={() => setFilter(f.value)} />)}
        <Chip label="Assigned to me" active={mineOnly} onPress={() => setMineOnly(!mineOnly)} />
      </View>
      <Btn small title={target.program_id ? 'Program notes' : 'Discussion & notes'} color={c.violet} style={{ alignSelf: 'flex-start' }} onPress={() => setNotes({ scope: true })} accessibilityLabel={target.program_id ? 'Open the internal notes of this program' : 'Open the discussion and notes of this agreement'} />
      {list.loading && !d ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !d.items.length ? (
        <Empty emoji="✅" title={mineOnly ? 'Nothing is assigned to you here' : filter === 'open' ? 'No open tasks' : 'No tasks yet'} sub={canWrite ? 'Add a task to track who does what by when. Assignees and managers are reminded before it is due.' : 'Your role can read tasks here; managers and colleagues with a working role add them.'} />
      ) : d.items.map((t) => {
        const isMine = !mineOnly ? t.mine : true;
        return (
          <Card key={t.id} color={t.status === 'done' ? c.limeSoft : t.overdue ? c.pinkSoft : c.paper}>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'space-between' }}>
              <T weight="900" style={{ flex: 1 }} accessibilityRole="header">{t.title}</T>
              <Tag label={t.status === 'open' ? (t.overdue ? 'overdue' : 'open') : t.status} color={t.status === 'done' ? c.lime : t.overdue ? c.pinkSoft : c.sunSoft} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <Tag label={t.visibility === 'shared' ? 'Shared with the other side' : 'Internal'} color={t.visibility === 'shared' ? c.cyan : c.violetSoft} />
              <Tag label={KIND[t.kind]} color={c.paper} />
              {t.escalation_level ? <Tag label="Escalated" color={c.pinkSoft} /> : null}
              {!isMine ? <Tag label="Added by the other side" color={c.paper} /> : null}
            </View>
            {t.detail ? <T size={13} style={{ marginTop: 6 }}>{t.detail}</T> : null}
            <T size={12} color={c.mute} style={{ marginTop: 6 }} accessibilityRole="text">
              {t.assignee ? `${t.assignee.name}${t.assignee.active === false ? ' (no longer on the team)' : ''}` : isMine ? 'Unassigned' : 'Assigned on their side'}{t.due_on ? ` · due ${when(t.due_on)}` : ' · no due date'}{t.created_by ? ` · added by ${t.created_by}` : ''}
            </T>
            {isMine && t.assignee?.active === false && t.status === 'open' ? <T size={12} weight="700" color={c.red} accessibilityRole="alert">Nobody is doing this now. Pick someone else.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {t.can_edit && t.status === 'open' ? <Btn small title="Mark done" color={c.mint} ink={c.ink} loading={busy === t.id} onPress={() => act(t.id, () => api.patch(`/sponsorship-tasks/${t.id}`, { expected_version: t.row_version, status: 'done' }), 'Marked done')} /> : null}
              {t.can_edit && t.status === 'done' ? <Btn small title="Reopen" color={c.paper} ink={c.ink} loading={busy === t.id} onPress={() => act(t.id, () => api.patch(`/sponsorship-tasks/${t.id}`, { expected_version: t.row_version, status: 'open' }), 'Reopened')} /> : null}
              {t.can_edit && t.status === 'open' ? <Btn small title="Edit" color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'edit', t })} /> : null}
              {t.can_edit && t.status === 'open' ? <Btn small title="Escalate" color={c.paper} ink={c.red} onPress={() => setForm({ kind: 'escalate', t })} accessibilityLabel={`Escalate ${t.title} to the managers`} /> : null}
              <Btn small title={t.notes ? `Notes (${t.notes})` : 'Notes'} color={c.violet} onPress={() => setNotes(t)} />
            </View>
          </Card>);
      })}
      {d && !d.items.length && canWrite && !mineOnly ? <Btn title="Add the first task" color={c.pink} onPress={() => setForm({ kind: 'new' })} /> : null}
      {d?.total > d?.items.length ? <T size={12} color={c.mute}>Showing {d.items.length} of {d.total}.</T> : null}
      {d && !canWrite && !mineOnly ? <T size={12} color={c.mute} accessibilityRole="text">Your role cannot change tasks here{d.side ? '' : ' (platform admins read shared items only)'}.</T> : null}
      <T size={12} color={c.mute}>Reminders go to the assignee before the due date, on it and when it is overdue; a task still open two days late goes to the managers. Messages never include the task text.</T>

      <FormSheet visible={form?.kind === 'new'} onClose={() => setForm(null)} title="New task" submitLabel="Add task"
        fields={taskFields({ people, shareable, ends_on })}
        onSubmit={async (v) => { await api.post('/sponsorship-tasks', clean({ ...target, ...v })); list.reload(); return 'Task added'; }} />
      <FormSheet visible={form?.kind === 'edit'} onClose={() => setForm(null)} title="Edit task" submitLabel="Save"
        initial={form?.t ? { title: form.t.title, detail: form.t.detail ?? '', kind: form.t.kind, assignee_id: form.t.assignee?.active === false ? undefined : form.t.assignee?.id, due_on: form.t.due_on ?? undefined, remind_days: form.t.remind_days } : {}}
        fields={taskFields({ people, shareable: false, ends_on, editing: true })}
        onSubmit={async (v) => {
          const t = form.t;
          try { await api.patch(`/sponsorship-tasks/${t.id}`, { expected_version: t.row_version, ...clean(v, true) }); } catch (e) { list.reload(); throw e.status === 409 && e.details?.code === 'stale_version' ? new Error(STALE) : e; }
          list.reload(); return 'Saved';
        }} />
      <FormSheet visible={form?.kind === 'escalate'} onClose={() => setForm(null)} title="Escalate to the managers" submitLabel="Escalate now"
        fields={[{ key: 'reason', label: 'Why does this need a manager?', type: 'multiline', optional: true, hint: 'Optional. Kept as an internal note on the task; the notification itself never shows it.' }]}
        onSubmit={async (v) => {
          const t = form.t;
          try { await api.post(`/sponsorship-tasks/${t.id}/escalate`, { expected_version: t.row_version, reason: v.reason || undefined }); } catch (e) { list.reload(); throw e.status === 409 && e.details?.code === 'stale_version' ? new Error(STALE) : e; }
          list.reload(); return 'The managers have been told';
        }} />
      {notes ? <NotesSheet task={notes.scope ? null : notes} target={target} shareable={shareable} canWrite={canWrite} onClose={() => { setNotes(null); list.reload(); }} /> : null}
    </Section>
  );
}

const clean = (v, editing) => Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== '_hint' && (editing || (x !== '' && x !== undefined))).map(([k, x]) => [k, x === '' ? null : x]));

function taskFields({ people, shareable, ends_on, editing }) {
  return [
    { key: 'title', label: 'What needs doing?' },
    { key: 'kind', label: 'Type', type: 'chips', options: KINDS, default: 'task' },
    { key: 'assignee_id', label: 'Assigned to', type: 'choice', options: people.length ? people : [{ value: '', label: 'Nobody on your team yet' }], optional: true, hint: 'Only people who work on this for your side right now.' },
    { key: 'due_on', label: 'Due', type: 'date', optional: true, hint: ends_on ? `The term ends ${when(ends_on)}.` : undefined },
    { key: 'remind_days', label: 'Remind them this many days before', type: 'stepper', min: 0, max: 30, default: 3 },
    ...(shareable && !editing ? [{ key: 'visibility', label: 'Who can see it', type: 'chips', options: [{ value: 'internal', label: 'Only my side' }, { value: 'shared', label: 'Both sides' }], default: 'internal' }] : []),
    { key: 'detail', label: 'Details', type: 'multiline', optional: true },
  ];
}

/** The notes on one task: your side's internal notes and the shared discussion, oldest first, with a composer. */
function NotesSheet({ task, target, shareable, canWrite, onClose }) {
  const { toast } = useSession();
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => api.get('/sponsorship-notes', task ? { task_id: task.id, limit: 100 } : { ...target, limit: 100 }), [task?.id, JSON.stringify(target)]);
  const d = list.data;
  const may = canWrite && d?.can_write;
  return (
    <Sheet visible onClose={onClose} title={task ? task.title : target.program_id ? 'Program notes' : 'Discussion & notes'}>
      {list.loading && !d ? <Loading /> : list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !d.items.length ? <Empty emoji="📝" title="No notes yet" sub="Notes are kept for the record and cannot be edited or removed." /> : d.items.map((n) => (
        <Card key={n.id} color={n.visibility === 'shared' ? c.paper : c.violetSoft}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T size={12} weight="800">{n.author}</T><Tag label={n.visibility === 'shared' ? 'Shared' : 'Internal'} color={n.visibility === 'shared' ? c.cyan : c.violetSoft} /></View>
          <T style={{ marginTop: 4 }}>{n.body}</T>
          <T size={11} color={c.mute} style={{ marginTop: 4 }}>{new Date(n.created_at).toLocaleString()}</T>
        </Card>))}
      {may ? <Btn title="Write a note" color={c.pink} onPress={() => setAdding(true)} /> : <T size={12} color={c.mute}>You can read these notes; your role cannot add to them.</T>}
      <FormSheet visible={adding} onClose={() => setAdding(false)} title="Write a note" submitLabel="Add note"
        fields={[
          { key: 'body', label: 'Note', type: 'multiline' },
          ...(shareable && (!task || task.visibility === 'shared') ? [{ key: 'visibility', label: 'Who can see it', type: 'chips', options: [{ value: 'internal', label: 'Only my side' }, { value: 'shared', label: 'Both sides' }], default: 'internal' }] : []),
        ]}
        onSubmit={async (v) => { await api.post('/sponsorship-notes', { ...(task ? { task_id: task.id } : target), ...v }); list.reload(); toast('Note added'); return 'Note added'; }} />
    </Sheet>
  );
}
