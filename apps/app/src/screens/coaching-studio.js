// Performance Studio (issue #269, slice 1): today's coaching work, the run-a-session screen and the coaching journal.
// Everything links to canonical records through the /coaching/* capabilities; nothing here edits a booking, plan or score.
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { HScroll } from '../pickers';
import { send, useOutbox } from '../outbox';
import { c } from '../theme';
import { dateTimeIn, localToIso } from '../vtime';

const GOAL_CATEGORIES = ['technical', 'tactical', 'physical', 'mental_performance', 'teamwork', 'match_objective', 'custom'];
const GOAL_STATUS = ['planned', 'active', 'achieved', 'paused', 'stopped'];

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
  const [flt, setFlt] = useState({ scope: null, open_actions: false, skill_tag: '', from: null, to: null, team_id: null });
  const [filtering, setFiltering] = useState(false);
  const qs = Object.entries({ scope: flt.scope, open_actions: flt.open_actions || null, skill_tag: flt.skill_tag || null, from: flt.from, to: flt.to ?? flt.from, team_id: flt.team_id }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const home = useLoad(() => api.get(`/coaching/home${qs ? `?${qs}` : ''}`), [qs]);
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
      <HScroll>
        {[[null, 'All'], ['individual', 'Individual'], ['group', 'Group'], ['team', 'Team']].map(([v, l]) => <Chip key={l} label={l} active={flt.scope === v} onPress={() => setFlt({ ...flt, scope: v })} />)}
        <Chip label="Open actions only" active={flt.open_actions} onPress={() => setFlt({ ...flt, open_actions: !flt.open_actions })} />
        <Chip label={flt.from || flt.skill_tag || flt.team_id ? 'More filters ●' : 'More filters'} active={!!(flt.from || flt.skill_tag || flt.team_id)} onPress={() => setFiltering(true)} />
      </HScroll>
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
          <Section title="Overdue actions">
            {!h.overdue_actions.length ? <T size={13} color={c.mute}>Nothing overdue.</T> :
              h.overdue_actions.map((a) => <Row key={a.id} title={a.title} sub={`${a.athlete_name ?? 'Team'} · due ${dateTimeIn(a.due_at, tz)}`} onPress={() => push('CoachGoals', a.athlete_id ? { athlete_id: a.athlete_id, name: a.athlete_name } : { team_id: a.team_id })} />)}
          </Section>
          <Section title="Goals to review">
            {!h.goals_due.length ? <T size={13} color={c.mute}>No goal reviews due this week.</T> :
              h.goals_due.map((g) => <Row key={g.id} title={g.title} sub={`${g.athlete_name ?? 'Team'} · review ${g.review_on}`} onPress={() => push('CoachGoals', g.athlete_id ? { athlete_id: g.athlete_id, name: g.athlete_name } : { team_id: g.team_id })} />)}
          </Section>
          {h.matches_to_prepare?.length ? <Section title="Matches to prepare">{h.matches_to_prepare.map((m) => <Row key={m.fixture_id} title={`${m.home_name} v ${m.away_name}`} sub={`${dateTimeIn(m.scheduled_at, tz)} · ${m.team_name} · no plan yet`} onPress={() => push('CoachMatch', { fixture_id: m.fixture_id, team_id: m.team_id })} />)}</Section> : null}
          {h.matches_to_debrief?.length ? <Section title="Matches to debrief">{h.matches_to_debrief.map((m) => <Row key={m.fixture_id} title={`${m.home_name} v ${m.away_name}`} sub={`${dateTimeIn(m.scheduled_at, tz)} · ${m.team_name} · no review yet`} onPress={() => push('CoachMatch', { fixture_id: m.fixture_id, team_id: m.team_id })} />)}</Section> : null}
          {h.goals_stale?.length ? <Section title="Goals not reviewed for a month">{h.goals_stale.map((g) => <Row key={g.id} title={g.title} sub={g.athlete_name ?? 'Team'} onPress={() => push('CoachGoals', g.athlete_id ? { athlete_id: g.athlete_id, name: g.athlete_name } : { team_id: g.team_id })} />)}</Section> : null}
          {h.draft_reports?.length ? <Section title="Draft reports">{h.draft_reports.map((r) => <Row key={r.id} title={r.title} sub="Not published yet" onPress={() => push('CoachReport', { id: r.id })} />)}</Section> : null}
          {h.ai_waiting?.length ? <Section title="AI drafts waiting for you">{h.ai_waiting.map((d) => <Row key={d.id} title={TASK_TITLE[d.task] ?? d.task} sub={d.headline ?? ''} onPress={() => push('CoachCopilot', { draft_id: d.id })} />)}</Section> : null}
          <Section title="Follow up">
            {!h.follow_ups.length ? <T size={13} color={c.mute}>No notes flagged for follow-up.</T> :
              h.follow_ups.map((o) => <Row key={o.id} title={o.athlete_name ?? 'Team'} sub={`${o.skill_tag ? `${o.skill_tag} · ` : ''}${o.note}`} onPress={() => push('CoachJournal', o.athlete_id ? { athlete_id: o.athlete_id, name: o.athlete_name } : { team_id: o.team_id })} />)}
          </Section>
        </>
      )}
      <FormSheet visible={filtering} onClose={() => setFiltering(false)} title="Filters" submitLabel="Apply" initial={{ ...flt, skill_tag: flt.skill_tag }}
        fields={[
          { key: 'team_id', label: 'Team', type: 'chips', optional: true, options: teams.map((t) => ({ value: t.id, label: `${t.emoji ?? ''} ${t.name}`.trim() })) },
          { key: 'skill_tag', label: 'Skill tag', optional: true, placeholder: 'e.g. first touch' },
          { key: 'from', toKey: 'to', label: 'Dates', type: 'daterange', optional: true },
        ]}
        onSubmit={async (v) => { setFlt({ ...flt, team_id: v.team_id ?? null, skill_tag: v.skill_tag ?? '', from: v.from ?? null, to: v.to ?? null }); setFiltering(false); }} />
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
  const [more, setMore] = useState(null); // null | 'menu' | 'groups' | 'template' | 'use' | 'clone' | 'help' | {summary: athlete}
  const [busy, setBusy] = useState(null);
  const w = ws.data;
  const outbox = useOutbox();
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
      {outbox.pending ? <Card pad={10} color={c.cyanSoft} style={{ marginTop: 8 }}><T size={12} weight="700">{outbox.pending} note{outbox.pending === 1 ? '' : 's'} waiting to send</T><T size={12} color={c.mute}>Kept in memory only, so keep the app open until they send. Retries by itself; nothing is saved twice.</T><View style={{ marginTop: 6 }}><Btn small title="Retry now" onPress={outbox.flush} /></View></Card> : null}
      {outbox.rejected ? <Card pad={10} color={c.violetSoft} style={{ marginTop: 8 }}><T size={12} weight="700">A saved note was refused</T><T size={12} color={c.mute}>{outbox.rejected}</T></Card> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {s.status === 'planned' ? <Btn small title="Start session" loading={busy === 'start'} onPress={() => run('start', () => api.post(`/coaching/sessions/${s.id}/start`), 'Session started')} /> : null}
        {s.status === 'running' ? <Btn small title="Finish & review" onPress={() => setFinishing(true)} /> : null}
        {!done ? <Btn small title={blocks.length ? 'Edit plan' : 'Plan blocks'} color={c.paper} ink={c.ink} onPress={() => setPlanning(true)} /> : null}
        <Btn small title="More" color={c.paper} ink={c.ink} onPress={() => setMore('menu')} />
        {!done ? <Btn small title="Draft a plan (AI)" color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'plan_session', session_record_id: s.id })} /> : <Btn small title="Draft a summary (AI)" color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'summarise_session', session_record_id: s.id })} />}
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
              <Chip label="Player summary" onPress={() => setMore({ summary: p })} />
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
              <T size={12} color={c.mute}>{label(b.kind)}{b.unit ? ` · for ${b.unit}` : ''}{b.objective ? ` · ${b.objective}` : ''}</T>
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
          const r = await send('/coaching/observations', { session_record_id: s.id, athlete_id: note.athlete_id, team_id: note.athlete_id && visibility !== 'staff' ? undefined : s.team_id ?? undefined, note: v.note, obs_type: v.obs_type, skill_tag: v.skill_tag || undefined, visibility, follow_up: !!v.follow_up, client_key: keyOf() });
          setNote(null); toast(r.status === 'saved' ? 'Note saved' : 'No signal: note kept and will send automatically'); ws.reload();
        }} />
      <MoreSheet more={more} setMore={setMore} w={w} reload={ws.reload} />
      <PlanSheet visible={planning} blocks={blocks} version={w.plan.version} groups={s.groups} onClose={() => setPlanning(false)} onSave={async (next) => { await api.post(`/coaching/sessions/${s.id}/plan`, { blocks: next, expected_version: w.plan.version }); setPlanning(false); toast('Plan saved'); ws.reload(); }} />
      <FormSheet visible={finishing} onClose={() => setFinishing(false)} title="Review the session" submitLabel={done ? 'Save review' : 'Finish session'} initial={{ team_summary: s.team_summary ?? '', private_summary: s.private_summary ?? '' }}
        fields={[{ key: 'team_summary', label: 'Team summary (can be shared)', type: 'multiline', optional: true }, { key: 'share_team_summary', label: 'Let the players read the team summary', type: 'switch', default: !!s.team_summary_shared }, { key: 'private_summary', label: 'Private summary (only you)', type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          if (done) { await api.post(`/coaching/sessions/${s.id}/review`, { team_summary: v.team_summary || undefined, private_summary: v.private_summary || undefined, share_team_summary: !!v.share_team_summary }); setFinishing(false); toast('Review saved'); ws.reload(); return; }
          const r = await api.post(`/coaching/sessions/${s.id}/complete`, { team_summary: v.team_summary || undefined, private_summary: v.private_summary || undefined });
          setFinishing(false); toast(r.not_recorded ? `Finished · ${r.not_recorded} player${r.not_recorded === 1 ? '' : 's'} had no attendance recorded` : 'Session finished'); ws.reload();
        }} />
    </Screen>
  );
}

// Adds one block at a time and keeps the order; existing blocks keep their ids so their progress stays attached.
function PlanSheet({ visible, blocks, version, groups, onClose, onSave }) {
  const [list, setList] = useState(null);
  const cur = list ?? blocks;
  const [adding, setAdding] = useState(false);
  const move = (n, d) => { const x = [...cur]; const [b] = x.splice(n, 1); x.splice(n + d, 0, b); setList(x); };
  return (
    <>
      <Sheet visible={visible && !adding} onClose={() => { setList(null); onClose(); }} title={`Plan · version ${version + 1}`}>
        {!cur.length ? <T size={13} color={c.mute}>No blocks yet.</T> : null}
        {cur.map((b, n) => (
          <Row key={b.id ?? n} title={`${n + 1}. ${b.title}`} sub={`${label(b.kind)}${b.duration_min ? ` · ${b.duration_min} min` : ''}${b.unit ? ` · ${b.unit}` : ''}`} right={(
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
          { key: 'target_rpe', label: 'Target effort 1–10 (optional, not medical)', type: 'stepper', min: 1, max: 10, step: 1, default: 6, optional: true },
          ...(groups?.length ? [{ key: 'unit', label: 'For which group?', type: 'chips', optional: true, options: groups.map((g) => ({ value: g.name, label: g.name })) }] : []),
        ]}
        onSubmit={async (v) => { setList([...cur, { kind: v.kind, title: v.title, duration_min: v.duration_min, objective: v.objective || undefined, instructions: v.instructions || undefined, cues: v.cue ? [v.cue] : [], tags: [], target_rpe: v.target_rpe || undefined, unit: v.unit || undefined }]); setAdding(false); }} />
    </>
  );
}

export function CoachJournal({ athlete_id, team_id, name }) {
  const { push } = useNav();
  const [tag, setTag] = useState(null);
  const path = athlete_id ? `/coaching/athletes/${athlete_id}/timeline` : `/coaching/teams/${team_id}/timeline`;
  const tl = useLoad(() => api.get(`${path}?limit=100${tag ? `&skill_tag=${encodeURIComponent(tag)}` : ''}`), [path, tag]);
  const all = useLoad(() => api.get(`${path}?limit=100`), [path]);
  const tags = [...new Set((all.data ?? []).map((x) => x.skill_tag).filter(Boolean))].sort();
  return (
    <Screen onRefresh={tl.reload}>
      <H1>{name ? `${name} · journal` : athlete_id ? 'Player journal' : 'Team journal'}</H1>
      <T size={13} color={c.mute}>Your notes, attendance and completed sessions in time order. Records are shown from their source; official scores and stats are never changed here.</T>
      {athlete_id ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}><Btn small title="Goals & actions" onPress={() => push('CoachGoals', { athlete_id, name })} /><Btn small title="Reports" color={c.paper} ink={c.ink} onPress={() => push('CoachReports', { athlete_id, name })} /><Btn small title="Progress summary (AI)" color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'player_progress', athlete_id })} /><Btn small title="Ask about notes (AI)" color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'ask', athlete_id })} /></View> : <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Goals & actions" onPress={() => push('CoachGoals', { team_id })} /><Btn small title="Reports" color={c.paper} ink={c.ink} onPress={() => push('CoachReports', { team_id })} /><Btn small title="Team patterns (AI)" color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'team_patterns', team_id })} /></View>}
      {athlete_id ? <Metrics athlete_id={athlete_id} /> : null}
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

// Every metric says what it is, where it comes from and how many records stand behind it; missing data is "no data", never zero.
function Metrics({ athlete_id }) {
  const m = useLoad(() => api.get(`/coaching/athletes/${athlete_id}/metrics`), [athlete_id]);
  if (m.loading && !m.data) return null;
  if (m.error || !m.data) return null;
  return (
    <Section title={`Trends · ${m.data.from} to ${m.data.to}`}>
      {m.data.metrics.map((x) => (
        <Card key={x.key} pad={12} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T weight="700" style={{ flexShrink: 1 }}>{x.label}</T>
            <T weight="800">{x.value == null ? 'No data' : `${x.value}${x.unit === '%' ? '%' : ` ${x.unit ?? ''}`}`}</T>
          </View>
          <T size={11} color={c.mute}>{x.provenance_label} · {x.sample} record{x.sample === 1 ? '' : 's'}{x.excluded?.not_recorded ? ` · ${x.excluded.not_recorded} not recorded` : ''}{x.excluded?.excused ? ` · ${x.excluded.excused} excused` : ''}</T>
          <T size={11} color={c.mute}>{x.definition}</T>
        </Card>
      ))}
    </Section>
  );
}

export function CoachGoals({ athlete_id, team_id, name }) {
  const { toast } = useSession();
  const q = athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`;
  const goals = useLoad(() => api.get(`/coaching/goals?${q}`), [q]);
  const actions = useLoad(() => api.get(`/coaching/actions?${q}`), [q]);
  const [form, setForm] = useState(null); // 'goal' | { goal } | 'action'
  const [reviewing, setReviewing] = useState(null);
  const reload = () => { goals.reload(); actions.reload(); };
  const subject = athlete_id ? { athlete_id } : { team_id };
  return (
    <Screen onRefresh={reload}>
      <H1>{name ? `${name} · goals` : 'Goals & actions'}</H1>
      <T size={13} color={c.mute}>Coaching goals only. You decide when a goal is achieved; evidence and completed actions never change it on their own.</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title="New goal" onPress={() => setForm('goal')} /><Btn small title="New action" color={c.paper} ink={c.ink} onPress={() => setForm('action')} />
      </View>
      <Section title="Goals">
        {goals.loading && !goals.data ? <Loading /> : goals.error ? <ErrorBox error={goals.error} onRetry={goals.reload} /> : !goals.data.length ? <Empty emoji="🎯" title="No goals yet" sub="Set a measurable goal and review it on a date." /> :
          goals.data.map((g) => <Row key={g.id} title={g.title} sub={`${label(g.category)} · ${label(g.priority)} priority${g.review_on ? ` · review ${g.review_on}` : ''} · ${g.evidence_count} evidence`} right={<Status s={g.status} />} onPress={() => setReviewing(g)} />)}
      </Section>
      <Section title="Actions">
        {actions.loading && !actions.data ? <Loading /> : actions.error ? <ErrorBox error={actions.error} onRetry={actions.reload} /> : !actions.data.length ? <Empty emoji="✅" title="No actions" sub="Turn an observation into a follow-up." /> :
          actions.data.map((a) => (
            <Card key={a.id} pad={12} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flexShrink: 1 }}>{a.title}</T><Status s={a.overdue ? 'overdue' : a.status} /></View>
              <T size={12} color={c.mute}>{a.due_at ? `Due ${dateTimeIn(a.due_at, tz)}` : 'No due date'}{a.shared ? ' · shared with athlete' : ''}</T>
              {a.status === 'open' || a.status === 'in_progress' ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                  <Btn small title="Done" onPress={async () => { try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'done' }); reload(); } catch (e) { toast(e.message); reload(); } }} />
                  <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={async () => { try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'cancelled' }); reload(); } catch (e) { toast(e.message); reload(); } }} />
                </View>
              ) : null}
            </Card>
          ))}
      </Section>
      <FormSheet visible={form === 'goal'} onClose={() => setForm(null)} title="New goal" submitLabel="Create goal"
        fields={[
          { key: 'title', label: 'Goal' },
          { key: 'category', label: 'Category', type: 'chips', options: opts(GOAL_CATEGORIES), default: 'technical' },
          { key: 'criterion', label: 'How will we know? (measurable)', type: 'multiline', optional: true },
          { key: 'priority', label: 'Priority', type: 'chips', options: opts(['low', 'medium', 'high']), default: 'medium' },
          { key: 'review_on', label: 'Review on', type: 'date', optional: true },
          { key: 'athlete_text', label: 'Wording to show the athlete (leave empty to keep private)', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post('/coaching/goals', { ...subject, title: v.title, category: v.category, criterion: v.criterion || undefined, priority: v.priority, review_on: v.review_on || undefined, athlete_text: v.athlete_text || undefined }); setForm(null); toast('Goal created'); reload(); }} />
      <FormSheet visible={form === 'action'} onClose={() => setForm(null)} title="New action" submitLabel="Create action"
        fields={[
          { key: 'title', label: 'Action' },
          { key: 'detail', label: 'Detail', type: 'multiline', optional: true },
          { key: 'due', label: 'Due date', type: 'date', optional: true },
          { key: 'priority', label: 'Priority', type: 'chips', options: opts(['low', 'medium', 'high']), default: 'medium' },
          ...(athlete_id ? [{ key: 'owner', label: 'Who does it', type: 'chips', options: [{ value: 'me', label: 'Me' }, { value: 'athlete', label: 'The athlete' }], default: 'me' }] : []),
          { key: 'repeat', label: 'Repeat every … days after it is done', type: 'stepper', min: 1, max: 365, step: 1, default: 7, optional: true },
          { key: 'follow_up_next_session', label: 'Show at the start of the next session', type: 'switch', default: true },
        ]}
        onSubmit={async (v) => {
          await api.post('/coaching/actions', { recurrence_days: v.due && v.repeat ? v.repeat : undefined, ...subject, title: v.title, detail: v.detail || undefined, due_at: v.due ? localToIso(v.due, '18:00', tz) : undefined, priority: v.priority, owner_id: v.owner === 'athlete' ? athlete_id : undefined, shared: v.owner === 'athlete', follow_up_next_session: !!v.follow_up_next_session, client_key: keyOf() });
          setForm(null); toast('Action created'); reload();
        }} />
      <FormSheet visible={!!reviewing} onClose={() => setReviewing(null)} title={reviewing?.title ?? 'Review goal'} submitLabel="Save review" initial={{ status: reviewing?.status }}
        fields={[
          { key: 'status', label: 'Status', type: 'chips', options: opts(GOAL_STATUS) },
          { key: 'review_note', label: 'Why? (required to mark achieved)', type: 'multiline', optional: true },
          { key: 'review_on', label: 'Next review', type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { await api.patch(`/coaching/goals/${reviewing.id}`, { row_version: reviewing.row_version, status: v.status, review_note: v.review_note || undefined, review_on: v.review_on || undefined }); setReviewing(null); toast('Review saved'); reload(); }} />
    </Screen>
  );
}

// What the coach chose to show the athlete: shared notes, goal wording and shared actions. Nothing private reaches this screen.
export function MyCoaching() {
  const { toast } = useSession();
  const { push } = useNav();
  const notes = useLoad(() => api.get('/me/coaching-notes'), []);
  const goals = useLoad(() => api.get('/me/coaching-goals'), []);
  const actions = useLoad(() => api.get('/me/coaching-actions'), []);
  const reports = useLoad(() => api.get('/me/coaching-reports'), []);
  const summaries = useLoad(() => api.get('/me/coaching-session-summaries'), []);
  const reload = () => { notes.reload(); goals.reload(); actions.reload(); reports.reload(); summaries.reload(); };
  return (
    <Screen onRefresh={reload}>
      <H1>From my coach</H1>
      <Section title="Reports">
        {!reports.data?.length ? <T size={13} color={c.mute}>No reports shared with you yet.</T> : reports.data.map((r) => <Row key={r.report_id} title={r.title} sub={`From ${r.coach_name} · ${dateTimeIn(r.published_at, tz)}`} onPress={() => push('CoachReportView', { id: r.report_id, version: r.version })} />)}
      </Section>
      <Section title="Session summaries">
        {!summaries.data?.length ? <T size={13} color={c.mute}>Nothing shared yet.</T> : summaries.data.map((x) => <Row key={`${x.session_record_id}${x.kind}`} title={x.title} sub={`${x.kind === 'team' ? 'Team summary' : 'Just for you'} — ${x.summary} (${x.coach_name})`} />)}
      </Section>
      <Section title="Goals">
        {!goals.data?.length ? <T size={13} color={c.mute}>No goals shared with you yet.</T> : goals.data.map((g) => <Row key={g.id} title={g.title} sub={`${g.text}${g.review_on ? ` · review ${g.review_on}` : ''}`} right={<Status s={g.status} />} />)}
      </Section>
      <Section title="Actions">
        {!actions.data?.length ? <T size={13} color={c.mute}>No actions assigned to you.</T> : actions.data.map((a) => (
          <Card key={a.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flexShrink: 1 }}>{a.title}</T><Status s={a.status} /></View>
            {a.detail ? <T size={13}>{a.detail}</T> : null}
            <T size={12} color={c.mute}>{a.due_at ? `Due ${dateTimeIn(a.due_at, tz)}` : 'No due date'} · from {a.coach_name}</T>
            {a.status === 'open' || a.status === 'in_progress' ? <View style={{ marginTop: 6 }}><Btn small title="Mark done" onPress={async () => { try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'done' }); } catch (e) { toast(e.message); } reload(); }} /></View> : null}
          </Card>
        ))}
      </Section>
      <Section title="Notes shared with me">
        {!notes.data?.length ? <T size={13} color={c.mute}>Nothing shared yet.</T> : notes.data.map((n) => <Row key={n.id} title={`${n.skill_tag ? `${n.skill_tag} · ` : ''}${label(n.obs_type)}`} sub={`${n.note} — ${n.coach_name}`} />)}
      </Section>
    </Screen>
  );
}

// AI copilot (draft only). The coach decides what the AI may read, sees which records it used and what it could not know,
// and nothing is saved until Accept. Without an AI provider the same screen shows a plain summary of the coach's own records.
const TASK_TITLE = { plan_session: 'Plan this session', player_focus: 'Player focus', summarise_session: 'Summarise this session', player_progress: 'Progress summary', team_patterns: 'Team patterns', suggest_actions: 'Suggested actions', match_debrief: 'Match debrief', ask: 'Ask about my notes' };

export function CoachCopilot({ task: taskProp = 'player_progress', athlete_id, team_id, session_record_id, draft_id }) {
  const { toast } = useSession();
  const { back } = useNav();
  const [priv, setPriv] = useState(false);
  const [question, setQuestion] = useState('');
  const [draft, setDraft] = useState(null);
  const loaded = useLoad(() => (draft_id ? api.get(`/coaching/ai/drafts/${draft_id}`) : Promise.resolve(null)), [draft_id]);
  useEffect(() => { if (loaded.data) setDraft(loaded.data); }, [loaded.data]);
  const task = draft?.task ?? taskProp;
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState({});
  const [err, setErr] = useState(null);
  const generate = async () => {
    setBusy(true); setErr(null);
    try { setDraft(await api.post('/coaching/ai/drafts', { task, athlete_id, team_id, session_record_id, include_private_summaries: priv, question: task === 'ask' ? question : undefined })); }
    catch (e) { setErr(e); }
    setBusy(false);
  };
  const resolve = async (decision) => {
    setBusy(true);
    try {
      const body = { decision };
      if (decision === 'accept' && task === 'suggest_actions') body.actions = draft.output.items.filter((x) => picked[x.id] && x.action).map((x) => ({ title: x.action.title, athlete_id: x.action.athlete_id }));
      if (decision === 'accept' && task === 'summarise_session') body.summary_text = draft.output.headline;
      await api.post(`/coaching/ai/drafts/${draft.id}/resolve`, body);
      toast(decision === 'accept' ? 'Saved' : 'Discarded'); back();
    } catch (e) { toast(e.message ?? 'Could not save'); }
    setBusy(false);
  };
  const o = draft?.output;
  const acceptLabel = { plan_session: 'Accept as session plan', suggest_actions: 'Create chosen actions', summarise_session: 'Save as my private summary' }[task] ?? 'Mark as read';
  return (
    <Screen>
      <T size={12} weight="700" color={c.pink} style={{ letterSpacing: 1.2 }}>AI DRAFT</T>
      <H1>{TASK_TITLE[task]}</H1>
      <T size={13} color={c.mute}>A suggestion from your own notes, goals and actions. Players appear to the AI as labels; medical information is never read. Nothing is saved until you accept.</T>
      {!draft ? (
        <>
          <Card pad={14} style={{ marginTop: 10 }}>
            <T weight="700">What the AI may read</T>
            <T size={13} color={c.mute}>Your notes, goals and open actions for this {session_record_id ? 'session' : athlete_id ? 'player' : 'team'}, and attendance. Last 8 weeks.</T>
            <View style={{ marginTop: 8 }}><HScroll><Chip label={priv ? 'Private summaries: shared' : 'Private summaries: not shared'} active={priv} onPress={() => setPriv(!priv)} /></HScroll></View>
          </Card>
          {task === 'ask' ? <View style={{ marginTop: 10 }}><Field label="Your question" value={question} onChangeText={setQuestion} multiline maxLength={400} /></View> : null}
          {err ? <ErrorBox error={err} onRetry={generate} /> : null}
          <View style={{ marginTop: 12 }}><Btn title="Draft it" loading={busy} disabled={task === 'ask' && !question.trim()} onPress={generate} /></View>
        </>
      ) : (
        <>
          <Card pad={14} style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={draft.ai ? 'AI suggestion' : 'Plain summary (no AI)'} color={c.violetSoft} /></View>
            <T weight="700" style={{ marginTop: 6 }}>{o.headline}</T>
          </Card>
          {o.items.map((x) => (
            <Card key={x.id} pad={12} style={{ marginTop: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <T weight="700" style={{ flexShrink: 1 }}>{x.title}</T>
                <Tag label={x.basis === 'observed' ? 'From your notes' : 'Suggestion'} color={x.basis === 'observed' ? c.lime : c.violetSoft} />
              </View>
              {x.detail ? <T size={13}>{x.detail}</T> : null}
              {x.why ? <T size={12} color={c.mute}>Why: {x.why}</T> : null}
              {x.source_refs.length ? <T size={11} color={c.mute}>Sources: {x.source_refs.map((r) => { const s = draft.sources.find((y) => y.ref === r); return s ? `${s.label ?? s.type}${s.at ? ` · ${dateTimeIn(s.at, tz)}` : ''}` : r; }).join(' · ')}</T> : <T size={11} color={c.mute}>No source — treat as an idea.</T>}
              {task === 'suggest_actions' && x.action ? <View style={{ marginTop: 6 }}><Chip label={picked[x.id] ? 'Will create' : 'Create this action'} active={!!picked[x.id]} onPress={() => setPicked({ ...picked, [x.id]: !picked[x.id] })} /></View> : null}
            </Card>
          ))}
          <Card pad={12} color={c.cyanSoft} style={{ marginTop: 10 }}>
            <T weight="700" size={13}>Limits of this draft</T>
            {draft.limitations.map((l) => <T key={l} size={12} color={c.mute}>• {l}</T>)}
          </Card>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn title={acceptLabel} loading={busy} disabled={(task === 'suggest_actions' && !Object.values(picked).some(Boolean)) || (task === 'plan_session' && !o.items.some((x) => x.block))} onPress={() => resolve('accept')} />
            <Btn title="Discard" color={c.paper} ink={c.red} onPress={() => resolve('discard')} />
          </View>
        </>
      )}
    </Screen>
  );
}

// Reports: choose an audience, see exactly what that audience will get, then publish a frozen version.
const AUD = [['coach_private', 'Just me'], ['athlete', 'Athlete'], ['guardian', 'Guardian'], ['team_staff', 'Team coaches']];
const KIND = ['athlete_progress', 'session', 'goal_review', 'team_training', 'match_debrief', 'period_review', 'action_summary'];

export function CoachReports({ athlete_id, team_id, name }) {
  const { push } = useNav();
  const { toast } = useSession();
  const q = athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`;
  const list = useLoad(() => api.get(`/coaching/reports?${q}`), [q]);
  const [creating, setCreating] = useState(false);
  return (
    <Screen onRefresh={list.reload}>
      <H1>{name ? `${name} · reports` : 'Reports'}</H1>
      <T size={13} color={c.mute}>Build a report for the person who will read it. Private notes can never go into a shared report, and a published version never changes.</T>
      <View style={{ marginTop: 10 }}><Btn small title="New report" onPress={() => setCreating(true)} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="📄" title="No reports yet" sub="Pick an audience and a period and the report builds itself from your records." /> :
        list.data.map((r) => <Row key={r.id} title={r.title} sub={`${AUD.find(([v]) => v === r.audience)?.[1]} · ${r.period_from.slice(0, 10)} to ${r.period_to.slice(0, 10)} · ${r.latest_version ? `v${r.latest_version} published` : 'draft'}`} onPress={() => push('CoachReport', { id: r.id })} />)}
      <FormSheet visible={creating} onClose={() => setCreating(false)} title="New report" submitLabel="Create"
        fields={[
          { key: 'title', label: 'Title' },
          { key: 'kind', label: 'Kind', type: 'chips', options: opts(KIND), default: 'athlete_progress' },
          { key: 'audience', label: 'Who will read it', type: 'chips', options: AUD.filter(([v]) => (athlete_id ? true : v === 'coach_private' || v === 'team_staff')).map(([value, lab]) => ({ value, label: lab })), default: 'coach_private' },
          { key: 'from', toKey: 'to', label: 'Period', type: 'daterange' },
          { key: 'goals', label: 'Include goals', type: 'switch', default: true },
          { key: 'metrics', label: 'Include numbers (attendance, measurements)', type: 'switch', default: true },
          { key: 'actions', label: 'Include next steps', type: 'switch', default: true },
          { key: 'narrative', label: 'Your summary', type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const r = await api.post('/coaching/reports', { athlete_id, team_id, title: v.title, kind: v.kind, audience: v.audience, from: v.from, to: v.to, selection: { goals: !!v.goals, metrics: athlete_id ? !!v.metrics : false, actions: !!v.actions }, narrative: v.narrative || undefined });
          setCreating(false); toast('Report created'); push('CoachReport', { id: r.id });
        }} />
    </Screen>
  );
}

export function CoachReport({ id }) {
  const { toast } = useSession();
  const rep = useLoad(() => api.get(`/coaching/reports/${id}`), [id]);
  const prev = useLoad(() => api.get(`/coaching/reports/${id}/preview`), [id]);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const r = rep.data, snap = prev.data?.snapshot;
  const act = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); rep.reload(); prev.reload(); } catch (e) { toast(e.message ?? 'Could not do that'); } setBusy(false); };
  if ((rep.loading && !r) || (prev.loading && !snap)) return <Screen><Loading /></Screen>;
  if (rep.error || prev.error) return <Screen><ErrorBox error={rep.error ?? prev.error} onRetry={() => { rep.reload(); prev.reload(); }} /></Screen>;
  const aud = AUD.find(([v]) => v === r.audience)[1];
  return (
    <Screen onRefresh={() => { rep.reload(); prev.reload(); }}>
      <H1>{r.title}</H1>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={`For: ${aud}`} color={c.violetSoft} /><Tag label={r.latest_version ? `v${r.latest_version} published` : 'Not published'} color={r.latest_version ? c.lime : c.violetSoft} /></View>
      <T size={13} color={c.mute} style={{ marginTop: 6 }}>{snap.disclosure}</T>
      {prev.data.needs_ai_review ? <Card pad={10} color={c.cyanSoft} style={{ marginTop: 8 }}><T size={12} weight="700">Your summary started as an AI draft</T><T size={12} color={c.mute}>Read it carefully before publishing; you will be asked to confirm.</T></Card> : null}
      <Section title="Preview — exactly what this audience will receive">
        {snap.sections.map((sec) => (
          <Card key={sec.key} pad={12} style={{ marginBottom: 8 }}>
            <T weight="800">{sec.title}</T>
            {sec.kind === 'text' ? <T size={13}>{sec.body}</T> : sec.items.map((it, n) => (
              <View key={n} style={{ marginTop: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" size={13} style={{ flexShrink: 1 }}>{it.title}</T>{it.value ? <T weight="800" size={13}>{it.value}</T> : null}</View>
                {it.meta ? <T size={11} color={c.mute}>{it.meta}</T> : null}
                {it.body ? <T size={12}>{it.body}</T> : null}
              </View>
            ))}
          </Card>
        ))}
        {!snap.sections.length ? <T size={13} color={c.mute}>Nothing selected yet.</T> : null}
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Btn title={`Publish v${prev.data.next_version}`} loading={busy} onPress={() => (prev.data.needs_ai_review ? setSure(true) : act(async () => { const v = await api.post(`/coaching/reports/${id}/publish`, { row_version: r.row_version }); if (v.unchanged) throw new Error('Nothing has changed since the last version'); }, 'Published'))} />
        {r.latest_version ? <Btn title="Make branded PDF" color={c.paper} ink={c.ink} loading={busy} onPress={() => act(async () => {
          const d = await api.post('/branded-documents/coaching-report', { report_id: id });
          if (typeof window !== 'undefined' && window.open) { const url = URL.createObjectURL(await api.download(`/branded-documents/${d.id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); }
        }, 'PDF ready')} /> : null}
      </View>
      {r.versions.length ? <Section title="Published versions">{r.versions.map((v) => <Row key={v.version} title={`Version ${v.version}`} sub={`${dateTimeIn(v.published_at, tz)} · for ${AUD.find(([x]) => x === v.audience)[1]}`} />)}</Section> : null}
      <FormSheet visible={sure} onClose={() => setSure(false)} title="Publish an AI-assisted summary?" submitLabel="I have read it — publish" fields={[]}
        onSubmit={async () => { await api.post(`/coaching/reports/${id}/publish`, { row_version: r.row_version, confirm_reviewed: true }); setSure(false); toast('Published'); rep.reload(); prev.reload(); }} />
    </Screen>
  );
}

// A published, frozen version as its audience (the athlete, a guardian or team coaches) sees it.
export function CoachReportView({ id, version }) {
  const v = useLoad(() => api.get(`/coaching/reports/${id}/versions/${version}`), [id, version]);
  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const s = v.data.snapshot;
  return (
    <Screen>
      <H1>{s.title}</H1>
      <T size={13} color={c.mute}>{s.subject} · {s.period.from} to {s.period.to} · Coach {s.coach_name} · version {v.data.version}</T>
      {s.sections.map((sec) => (
        <Section key={sec.key} title={sec.title}>
          {sec.kind === 'text' ? <T size={14}>{sec.body}</T> : sec.items.map((it, n) => (
            <Card key={n} pad={12} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flexShrink: 1 }}>{it.title}</T>{it.value ? <T weight="800">{it.value}</T> : null}</View>
              {it.meta ? <T size={11} color={c.mute}>{it.meta}</T> : null}
              {it.body ? <T size={13}>{it.body}</T> : null}
            </Card>
          ))}
        </Section>
      ))}
    </Screen>
  );
}

// Match preparation and debrief over the canonical fixture: the fixture and its official result are only read; everything the coach
// writes lives in the coaching session record opened for it.
export function CoachMatch({ fixture_id, team_id }) {
  const { push } = useNav();
  const ctx = useLoad(() => api.get(`/coaching/fixtures/${fixture_id}?team_id=${team_id}`), [fixture_id, team_id]);
  const [busy, setBusy] = useState(false);
  if (ctx.loading && !ctx.data) return <Screen><Loading /></Screen>;
  if (ctx.error) return <Screen><ErrorBox error={ctx.error} onRetry={ctx.reload} /></Screen>;
  const m = ctx.data, f = m.fixture;
  const open = async () => {
    setBusy(true);
    try { const r = m.session_record ?? await api.post('/coaching/sessions', { source_type: 'fixture', source_id: fixture_id, team_id }); push('CoachSession', { id: r.id }); } catch (e) { /* shown by the screen on retry */ }
    setBusy(false);
  };
  return (
    <Screen onRefresh={ctx.reload}>
      <T size={12} weight="700" color={c.pink} style={{ letterSpacing: 1.2 }}>MATCH</T>
      <H1>{f.home} v {f.away}</H1>
      <T size={13} color={c.mute}>{f.event}{f.round ? ` · ${f.round}` : ''} · {dateTimeIn(f.scheduled_at, tz)} · you coach the {f.you_are} side</T>
      {f.official_result ? <Card pad={12} color={c.cyanSoft} style={{ marginTop: 8 }}><T weight="800">Official result: {f.official_result.home_score} – {f.official_result.away_score}</T><T size={12} color={c.mute}>From the official match record. Your notes never change it.</T></Card> : null}
      <View style={{ marginTop: 10 }}><Btn title={m.session_record ? 'Open my prep and review' : 'Start match prep'} loading={busy} onPress={open} /></View>
      <Section title="Squad availability">
        {m.squad.map((p) => <Row key={p.id} title={p.display_name} sub={`${p.availability ?? 'no answer'}${p.availability_note ? ` · ${p.availability_note}` : ''}`} />)}
      </Section>
      <Section title="Active goals">{!m.goals.length ? <T size={13} color={c.mute}>None.</T> : m.goals.map((g) => <Row key={g.id} title={g.title} sub={label(g.category)} />)}</Section>
      <Section title="Open actions">{!m.actions.length ? <T size={13} color={c.mute}>None.</T> : m.actions.map((a) => <Row key={a.id} title={a.title} sub={a.due_at ? `Due ${dateTimeIn(a.due_at, tz)}` : 'No due date'} />)}</Section>
    </Screen>
  );
}

// Less-used session tools, kept off the main field screen: groups, templates, cloning, delegation and per-player summaries.
function MoreSheet({ more, setMore, w, reload }) {
  const { toast } = useSession();
  const { push } = useNav();
  const s = w.session;
  const tpls = useLoad(() => (more === 'use' ? api.get('/coach/templates?scope=session') : Promise.resolve([])), [more === 'use']);
  const roster = useLoad(() => (more === 'help' && s.team_id ? api.get(`/coach/teams/${s.team_id}/roster`) : Promise.resolve(null)), [more === 'help']);
  const close = () => setMore(null);
  const players = w.participants.map((p) => ({ value: p.id, label: p.display_name }));
  const call = (fn, msg) => async (v) => { await fn(v); close(); toast(msg); reload(); };
  return (
    <>
      <Sheet visible={more === 'menu'} onClose={close} title="Session tools">
        {[
          ['Split into groups (defenders, forwards …)', 'groups', s.status !== 'completed' && s.team_id],
          ['Save plan as a template', 'template', true], ['Use a template', 'use', s.status !== 'completed'],
          ['Start a new session from this one', 'clone', true], ['Let another coach help', 'help', s.team_id && w.you_are === 'owner'],
        ].filter(([, , show]) => show).map(([label_, key]) => <Row key={key} title={label_} onPress={() => setMore(key)} />)}
        {w.delegates?.length ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Helping: {w.delegates.map((d) => `${d.display_name} (${d.permissions.join(', ')})`).join('; ')}</T> : null}
        <View style={{ marginTop: 10 }}><Btn small title="Save my own notes about the whole team" color={c.paper} ink={c.ink} onPress={() => { close(); push('CoachReports', { team_id: s.team_id }); }} disabled={!s.team_id} /></View>
      </Sheet>
      <FormSheet visible={more === 'groups'} onClose={close} title="Groups" submitLabel="Save groups" initial={{ n1: s.groups?.[0]?.name, m1: s.groups?.[0]?.athlete_ids, n2: s.groups?.[1]?.name, m2: s.groups?.[1]?.athlete_ids, n3: s.groups?.[2]?.name, m3: s.groups?.[2]?.athlete_ids }}
        fields={[1, 2, 3].flatMap((k) => [{ key: `n${k}`, label: `Group ${k} name`, optional: true, placeholder: k === 1 ? 'e.g. Defenders' : undefined }, { key: `m${k}`, label: `Group ${k} players`, type: 'multi', options: players, optional: true }])}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/groups`, { groups: [1, 2, 3].filter((k) => v[`n${k}`] && v[`m${k}`]?.length).map((k) => ({ name: v[`n${k}`], athlete_ids: v[`m${k}`] })) }), 'Groups saved')} />
      <FormSheet visible={more === 'template'} onClose={close} title="Save as template" submitLabel="Save"
        fields={[{ key: 'title', label: 'Template name' }]} onSubmit={call(async (v) => api.post('/coaching/templates', { title: v.title, session_record_id: s.id }), 'Template saved (no player details are kept)')} />
      <Sheet visible={more === 'use'} onClose={close} title="Use a template">
        {tpls.loading ? <Loading /> : !tpls.data?.length ? <T size={13} color={c.mute}>No session templates yet. Save a plan as a template first.</T> :
          tpls.data.map((t) => <Row key={t.id} title={t.title} sub={`${t.blocks.length} blocks${t.mine ? '' : ` · shared by ${t.shared_by}`}`} onPress={async () => { try { await api.post(`/coaching/sessions/${s.id}/apply-template`, { template_id: t.id }); close(); toast('Blocks added to the plan'); reload(); } catch (e) { toast(e.message); } }} />)}
      </Sheet>
      <FormSheet visible={more === 'clone'} onClose={close} title="New session from this one" submitLabel="Create"
        fields={[{ key: 'title', label: 'Title' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'time', label: 'Start time', type: 'time' }]} initial={{ title: s.title }}
        onSubmit={async (v) => { const r = await api.post(`/coaching/sessions/${s.id}/clone`, { source_type: 'team_session', source_id: uuidFrom(Date.now()), team_id: s.team_id ?? undefined, title: v.title, scheduled_at: localToIso(v.date, v.time, tz) }); close(); toast('Created. Plan blocks were copied; notes and attendance were not.'); push('CoachSession', { id: r.id }); }} />
      <FormSheet visible={more === 'help'} onClose={close} title="Let another coach help" submitLabel="Save"
        fields={[
          { key: 'user_id', label: 'Coach', type: 'chips', options: (roster.data?.members ?? []).filter((m) => m.role === 'coach').map((m) => ({ value: m.id, label: m.display_name })) },
          { key: 'permissions', label: 'They may', type: 'multi', options: [{ value: 'attendance', label: 'Record attendance' }, { value: 'observe', label: 'Write notes about players' }], optional: true, hint: 'Leave empty to remove their access.' },
        ]}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/delegates`, { user_id: v.user_id, permissions: v.permissions ?? [] }), 'Saved')} />
      <FormSheet visible={!!more?.summary} onClose={close} title={`Summary · ${more?.summary?.display_name ?? ''}`} submitLabel="Save"
        fields={[{ key: 'summary', label: 'How did this player get on?', type: 'multiline' }, { key: 'shared', label: 'Show it to the player', type: 'switch', default: false }]}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/player-summaries`, { athlete_id: more.summary.id, summary: v.summary, shared: !!v.shared }), 'Saved')} />
    </>
  );
}
