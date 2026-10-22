// Performance Studio (issue #269, slice 1): today's coaching work, the run-a-session screen and the coaching journal.
// Everything links to canonical records through the /coaching/* capabilities; nothing here edits a booking, plan or score.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { HScroll } from '../pickers';
import { c } from '../theme';
import { dateTimeIn, localToIso } from '../vtime';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const label = (s) => String(s).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const opts = (list) => list.map((value) => ({ value, label: label(value) }));
const ATTENDANCE = ['present', 'late', 'left_early', 'absent', 'excused'];
const OBS_TYPES = ['strength', 'progress', 'development_area', 'tactical', 'technical', 'teamwork', 'behaviour', 'goal_evidence', 'follow_up', 'general'];
const VISIBILITY = [['coach_private', 'Only me'], ['staff', 'Team coaches'], ['player', 'Share with player'], ['team', 'Share with team']];
const BLOCK_KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];
const keyOf = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // idempotency key: a retried save never doubles

const Status = ({ s }) => <Tag label={label(s)} color={s === 'completed' || s === 'present' ? c.lime : c.violetSoft} />;

export function PerformanceStudio() {
  const { push } = useNav();
  const { toast } = useSession();
  const home = useLoad(() => api.get('/coaching/home'), []);
  const coach = useLoad(() => api.get('/coach/home'), []);
  const [creating, setCreating] = useState(false);
  const h = home.data;
  const teams = coach.data?.teams ?? [];
  const openSource = (x) => push('CoachSession', { source_type: x.source_type, source_id: x.source_id });
  return (
    <Screen onRefresh={() => { home.reload(); coach.reload(); }}>
      <H1>Performance Studio</H1>
      <T size={13} color={c.mute}>Plan, run and review sessions, and keep a journal of what you see in each player. Notes are private to you until you choose to share them.</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title="New team session" onPress={() => setCreating(true)} disabled={!teams.length} />
        <Btn small title="My athletes" color={c.paper} ink={c.ink} onPress={() => push('CoachAthletes')} />
      </View>
      {!teams.length && !coach.loading ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Team sessions need a team you coach. Sessions from your hires and plans appear below on the day.</T> : null}
      {home.loading && !h ? <Loading /> : home.error ? <ErrorBox error={home.error} onRetry={home.reload} /> : (
        <>
          <Section title="Running now">
            {!h.running.length ? <Empty emoji="🏟️" title="Nothing running" sub="Start a session from Today to take attendance and notes." /> :
              h.running.map((r) => <Row key={r.id} title={r.title} sub={`Started ${dateTimeIn(r.started_at, tz)}`} right={<Status s="running" />} onPress={() => push('CoachSession', { id: r.id })} />)}
          </Section>
          <Section title="Today">
            {!h.today.length && !h.to_open.length ? <Empty emoji="🗓️" title="No sessions today" sub="Accepted plan sessions and confirmed hires for today show up here." /> : (
              <>
                {h.today.map((r) => <Row key={r.id} title={r.title} sub={dateTimeIn(r.scheduled_at, tz)} right={<Status s={r.status} />} onPress={() => push('CoachSession', { id: r.id })} />)}
                {h.to_open.map((x) => <Row key={`${x.source_type}${x.source_id}`} title={x.title} sub={`${dateTimeIn(x.scheduled_at, tz)} · ${label(x.source_type)}`} right={<T size={12} weight="700" color={c.pink}>Open ›</T>} onPress={() => openSource(x)} />)}
              </>
            )}
          </Section>
          <Section title="Needs your review">
            {!h.needs_review.length ? <T size={13} color={c.mute}>Every finished session has a review.</T> :
              h.needs_review.map((r) => <Row key={r.id} title={r.title} sub={`Ended ${dateTimeIn(r.ended_at, tz)} · no summary yet`} onPress={() => push('CoachSession', { id: r.id })} />)}
          </Section>
          <Section title="Follow up">
            {!h.follow_ups.length ? <T size={13} color={c.mute}>No notes flagged for follow-up.</T> :
              h.follow_ups.map((o) => <Row key={o.id} title={o.athlete_name ?? 'Team'} sub={`${o.skill_tag ? `${o.skill_tag} · ` : ''}${o.note}`} onPress={() => push('CoachJournal', o.athlete_id ? { athlete_id: o.athlete_id, name: o.athlete_name } : { team_id: o.team_id })} />)}
          </Section>
        </>
      )}
      <FormSheet visible={creating} onClose={() => setCreating(false)} title="New team session" submitLabel="Create"
        fields={[
          { key: 'team_id', label: 'Team', type: 'chips', options: teams.map((t) => ({ value: t.id, label: `${t.emoji ?? ''} ${t.name}`.trim() })) },
          { key: 'title', label: 'Session title' },
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'time', label: 'Start time', type: 'time' },
          { key: 'objective', label: 'Objective', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const key = keyOf();
          const rec = await api.post('/coaching/sessions', { source_type: 'team_session', source_id: uuidFrom(key), team_id: v.team_id, title: v.title, objective: v.objective || undefined, scheduled_at: localToIso(v.date, v.time, tz) });
          setCreating(false); toast('Session created'); push('CoachSession', { id: rec.id });
        }} />
    </Screen>
  );
}

// the API wants a uuid for a team session so that a retried create is idempotent
const uuidFrom = (seed) => {
  const hex = Array.from(`${seed}${Math.random()}`).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${hex}-${r()}-4${r().slice(1)}-a${r().slice(1)}-${r()}${r()}${r()}`;
};

export function CoachSession(props) {
  const { toast } = useSession();
  const { push } = useNav();
  const [rid, setRid] = useState(props.id ?? null);
  const ws = useLoad(async () => {
    let id = rid;
    if (!id) { const rec = await api.post('/coaching/sessions', { source_type: props.source_type, source_id: String(props.source_id), team_id: props.team_id }); id = rec.id; setRid(id); }
    return api.get(`/coaching/sessions/${id}`);
  }, [rid]);
  const [note, setNote] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [busy, setBusy] = useState(null);
  const w = ws.data;
  const run = async (name, fn, msg) => { setBusy(name); try { await fn(); await ws.reload(); if (msg) toast(msg); } catch (e) { toast(e.message ?? 'Could not save'); } setBusy(null); };
  if (ws.loading && !w) return <Screen><Loading /></Screen>;
  if (ws.error) return <Screen><ErrorBox error={ws.error} onRetry={ws.reload} /></Screen>;
  const s = w.session, done = s.status === 'completed', blocks = w.plan.blocks;
  const mark = (athlete_id, attendance) => run(`a${athlete_id}`, () => api.post(`/coaching/sessions/${s.id}/attendance`, { entries: [{ athlete_id, attendance }] }));
  const counts = ATTENDANCE.concat('expected').map((a) => [a, w.participants.filter((p) => p.attendance === a).length]).filter(([, n]) => n);
  return (
    <Screen onRefresh={ws.reload}>
      <H1>{s.title}</H1>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Status s={s.status} />
        {s.scheduled_at ? <T size={13} color={c.mute}>{dateTimeIn(s.scheduled_at, tz)}</T> : null}
      </View>
      {s.objective ? <T size={14} style={{ marginTop: 6 }}>{s.objective}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {s.status === 'planned' ? <Btn small title="Start session" loading={busy === 'start'} onPress={() => run('start', () => api.post(`/coaching/sessions/${s.id}/start`), 'Session started')} /> : null}
        {s.status === 'running' ? <Btn small title="Finish & review" onPress={() => setFinishing(true)} /> : null}
        {!done ? <Btn small title={blocks.length ? 'Edit plan' : 'Plan blocks'} color={c.paper} ink={c.ink} onPress={() => setPlanning(true)} /> : null}
        {!done || s.team_summary || s.private_summary ? null : <Btn small title="Add review" onPress={() => setFinishing(true)} />}
      </View>

      <Section title={`Attendance${counts.length ? ` · ${counts.map(([a, n]) => `${n} ${label(a).toLowerCase()}`).join(', ')}` : ''}`}>
        {!w.participants.length ? <Empty emoji="👥" title="No roster" sub="Players on the team (or the athlete of this hire) appear here." /> : w.participants.map((p) => (
          <Card key={p.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T weight="700" style={{ flexShrink: 1 }}>{p.display_name}</T>
              <Status s={p.attendance === 'expected' ? 'not_recorded' : p.attendance} />
            </View>
            <HScroll>
              {ATTENDANCE.map((a) => <Chip key={a} label={label(a)} active={p.attendance === a} onPress={() => mark(p.id, a)} />)}
              <Chip label="Note" onPress={() => setNote({ athlete_id: p.id })} />
            </HScroll>
            {w.previous_notes.filter((x) => x.athlete_id === p.id).slice(0, 2).map((x) => (
              <T key={x.id} size={12} color={c.mute} style={{ marginTop: 4 }}>{x.follow_up ? '↩ Follow up: ' : 'Last time: '}{x.note}</T>
            ))}
          </Card>
        ))}
      </Section>

      <Section title="Plan">
        {!blocks.length ? <T size={13} color={c.mute}>No blocks yet. Break the session into warm-up, drills and review.</T> : blocks.map((b, n) => {
          const st = w.block_log[b.id]?.status;
          return (
            <Card key={b.id} pad={12} style={{ marginBottom: 8 }}>
              <T weight="700">{n + 1}. {b.title}{b.duration_min ? ` · ${b.duration_min} min` : ''}</T>
              <T size={12} color={c.mute}>{label(b.kind)}{b.objective ? ` · ${b.objective}` : ''}</T>
              {b.cues?.length ? <T size={12} color={c.mute}>Cues: {b.cues.join(' · ')}</T> : null}
              {s.status === 'running' ? (
                <HScroll>
                  {['completed', 'skipped', 'modified'].map((x) => <Chip key={x} label={label(x)} active={st === x} onPress={() => run(`b${b.id}`, () => api.post(`/coaching/sessions/${s.id}/blocks/${b.id}`, { status: x }))} />)}
                </HScroll>
              ) : st ? <Status s={st} /> : null}
            </Card>
          );
        })}
      </Section>

      <Section title="Notes from this session" action={done ? undefined : 'Team note'} onAction={() => setNote({ team_id: s.team_id })}>
        {!w.observations.length ? <T size={13} color={c.mute}>Nothing noted yet. Tap Note on a player for a quick observation.</T> : w.observations.map((o) => (
          <Row key={o.id} title={`${w.participants.find((p) => p.id === o.athlete_id)?.display_name ?? 'Team'}${o.skill_tag ? ` · ${o.skill_tag}` : ''}`} sub={`${o.note}`} right={<Tag label={VISIBILITY.find(([v]) => v === o.visibility)[1]} color={c.violetSoft} />} />
        ))}
      </Section>
      {done && (s.team_summary || s.private_summary) ? (
        <Section title="Review">
          {s.team_summary ? <Card pad={12}><T weight="700">Team summary</T><T size={13}>{s.team_summary}</T></Card> : null}
          {s.private_summary ? <Card pad={12} style={{ marginTop: 8 }}><T weight="700">Private summary (only you)</T><T size={13}>{s.private_summary}</T></Card> : null}
        </Section>
      ) : null}
      <View style={{ marginTop: 16 }}>{w.participants.length ? <Btn small title="Open a player's journal" color={c.paper} ink={c.ink} onPress={() => push('CoachJournal', { athlete_id: w.participants[0].id, name: w.participants[0].display_name })} /> : null}</View>

      <FormSheet visible={!!note} onClose={() => setNote(null)} title={note?.athlete_id ? `Note · ${w.participants.find((p) => p.id === note.athlete_id)?.display_name}` : 'Team note'} submitLabel="Save note"
        fields={[
          { key: 'note', label: 'What did you see?', type: 'multiline' },
          { key: 'obs_type', label: 'Type', type: 'chips', options: opts(OBS_TYPES), default: 'general' },
          { key: 'skill_tag', label: 'Skill', optional: true, placeholder: 'e.g. first touch' },
          { key: 'visibility', label: 'Who can see it', type: 'chips', options: VISIBILITY.filter(([v]) => (note?.athlete_id ? v !== 'team' : v !== 'player')).map(([value, lab]) => ({ value, label: lab })), default: 'coach_private' },
          { key: 'follow_up', label: 'Follow up next session', type: 'switch', default: false },
        ]}
        onSubmit={async (v) => {
          const visibility = v.visibility === 'staff' && !s.team_id ? 'coach_private' : v.visibility;
          await api.post('/coaching/observations', { session_record_id: s.id, athlete_id: note.athlete_id, team_id: note.athlete_id && visibility !== 'staff' ? undefined : s.team_id ?? undefined, note: v.note, obs_type: v.obs_type, skill_tag: v.skill_tag || undefined, visibility, follow_up: !!v.follow_up, client_key: keyOf() });
          setNote(null); toast('Note saved'); ws.reload();
        }} />
      <PlanSheet visible={planning} blocks={blocks} version={w.plan.version} onClose={() => setPlanning(false)} onSave={async (next) => { await api.post(`/coaching/sessions/${s.id}/plan`, { blocks: next, expected_version: w.plan.version }); setPlanning(false); toast('Plan saved'); ws.reload(); }} />
      <FormSheet visible={finishing} onClose={() => setFinishing(false)} title="Review the session" submitLabel={done ? 'Save review' : 'Finish session'} initial={{ team_summary: s.team_summary ?? '', private_summary: s.private_summary ?? '' }}
        fields={[{ key: 'team_summary', label: 'Team summary (can be shared)', type: 'multiline', optional: true }, { key: 'private_summary', label: 'Private summary (only you)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          if (done) { toast('A finished session\'s review is already filed'); setFinishing(false); return; }
          const r = await api.post(`/coaching/sessions/${s.id}/complete`, { team_summary: v.team_summary || undefined, private_summary: v.private_summary || undefined });
          setFinishing(false); toast(r.not_recorded ? `Finished · ${r.not_recorded} player${r.not_recorded === 1 ? '' : 's'} had no attendance recorded` : 'Session finished'); ws.reload();
        }} />
    </Screen>
  );
}

// Adds one block at a time and keeps the order; existing blocks keep their ids so their progress stays attached.
function PlanSheet({ visible, blocks, version, onClose, onSave }) {
  const [list, setList] = useState(null);
  const cur = list ?? blocks;
  const [adding, setAdding] = useState(false);
  const move = (n, d) => { const x = [...cur]; const [b] = x.splice(n, 1); x.splice(n + d, 0, b); setList(x); };
  return (
    <>
      <Sheet visible={visible && !adding} onClose={() => { setList(null); onClose(); }} title={`Plan · version ${version + 1}`}>
        {!cur.length ? <T size={13} color={c.mute}>No blocks yet.</T> : null}
        {cur.map((b, n) => (
          <Row key={b.id ?? n} title={`${n + 1}. ${b.title}`} sub={`${label(b.kind)}${b.duration_min ? ` · ${b.duration_min} min` : ''}`} right={(
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Chip label="↑" onPress={() => n > 0 && move(n, -1)} /><Chip label="↓" onPress={() => n < cur.length - 1 && move(n, 1)} /><Chip label="Remove" onPress={() => setList(cur.filter((_, i) => i !== n))} />
            </View>)} />
        ))}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn small title="Add a block" color={c.paper} ink={c.ink} onPress={() => setAdding(true)} />
          <Btn small title="Save plan" onPress={() => onSave(cur).then(() => setList(null))} />
        </View>
      </Sheet>
      <FormSheet visible={visible && adding} onClose={() => setAdding(false)} title="Add a block" submitLabel="Add"
        fields={[
          { key: 'kind', label: 'Type', type: 'chips', options: opts(BLOCK_KINDS), default: 'skill_drill' },
          { key: 'title', label: 'Title' },
          { key: 'duration_min', label: 'Minutes', type: 'stepper', min: 1, max: 240, step: 5, default: 10 },
          { key: 'objective', label: 'Objective', optional: true },
          { key: 'instructions', label: 'Instructions', type: 'multiline', optional: true },
          { key: 'cue', label: 'Coaching cue', optional: true },
        ]}
        onSubmit={async (v) => { setList([...cur, { kind: v.kind, title: v.title, duration_min: v.duration_min, objective: v.objective || undefined, instructions: v.instructions || undefined, cues: v.cue ? [v.cue] : [], tags: [] }]); setAdding(false); }} />
    </>
  );
}

export function CoachJournal({ athlete_id, team_id, name }) {
  const [tag, setTag] = useState(null);
  const path = athlete_id ? `/coaching/athletes/${athlete_id}/timeline` : `/coaching/teams/${team_id}/timeline`;
  const tl = useLoad(() => api.get(`${path}?limit=100${tag ? `&skill_tag=${encodeURIComponent(tag)}` : ''}`), [path, tag]);
  const all = useLoad(() => api.get(`${path}?limit=100`), [path]);
  const tags = [...new Set((all.data ?? []).map((x) => x.skill_tag).filter(Boolean))].sort();
  return (
    <Screen onRefresh={tl.reload}>
      <H1>{name ? `${name} · journal` : athlete_id ? 'Player journal' : 'Team journal'}</H1>
      <T size={13} color={c.mute}>Your notes, attendance and completed sessions in time order. Records are shown from their source; official scores and stats are never changed here.</T>
      {tags.length ? <HScroll><Chip label="All" active={!tag} onPress={() => setTag(null)} />{tags.map((t) => <Chip key={t} label={t} active={tag === t} onPress={() => setTag(t)} />)}</HScroll> : null}
      {tl.loading && !tl.data ? <Loading /> : tl.error ? <ErrorBox error={tl.error} onRetry={tl.reload} /> : !tl.data.length ?
        <Empty emoji="📓" title="Nothing recorded yet" sub="Notes and attendance from your sessions build this story over time." /> :
        tl.data.map((x) => (
          <Card key={`${x.kind}${x.source_id}`} pad={12} style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <T weight="700" style={{ flexShrink: 1 }}>{label(x.title ?? x.kind)}</T>
              <T size={12} color={c.mute}>{dateTimeIn(x.at, tz)}</T>
            </View>
            {x.detail ? <T size={13}>{x.detail}</T> : null}
            <T size={11} color={c.mute}>{label(x.kind)}{x.visibility ? ` · ${VISIBILITY.find(([v]) => v === x.visibility)?.[1]}` : ''}{x.own === false ? ' · by another coach' : ''}{x.edited ? ' · edited' : ''}{x.follow_up ? ' · follow up' : ''}</T>
          </Card>
        ))}
    </Screen>
  );
}
