// Performance Studio (issue #269, slice 1): today's coaching work, the run-a-session screen and the coaching journal.
// Everything links to canonical records through the /coaching/* capabilities; nothing here edits a booking, plan or score.
import { ReportSections } from './report-sections';
import { ReportShares } from './report-shares';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { HScroll } from '../pickers';
import { MenuField } from '../menu-field';
import { Platform } from 'react-native';
import { send, useOutbox } from '../outbox';
import { useLayout } from '../layout';
import { c } from '../theme';
import { dateTimeIn, localToIso } from '../vtime';
import { AthleteBenchmarks } from './player-insights';
import { SharedByPlayers } from './player-goals';
import { t, tEnum } from '../i18n';
import { VideoPlayer } from '../video-player';

const GOAL_CATEGORIES = ['technical', 'tactical', 'physical', 'mental_performance', 'teamwork', 'match_objective', 'custom'];
const GOAL_STATUS = ['planned', 'active', 'achieved', 'paused', 'stopped'];

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const label = (s) => tEnum(s);   // enum values (left_early, skill_drill…) read through the enum.* keys
const opts = (list) => list.map((value) => ({ value, label: label(value) }));
const ATTENDANCE = ['present', 'late', 'left_early', 'absent', 'excused'];
const OBS_TYPES = ['strength', 'progress', 'development_area', 'tactical', 'technical', 'teamwork', 'behaviour', 'goal_evidence', 'follow_up', 'general'];
const VISIBILITY = [['coach_private', t('cs.vis_private')], ['staff', t('cs.vis_staff')], ['player', t('cs.vis_player')], ['team', t('cs.vis_team')]];
const BLOCK_KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];
const keyOf = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // idempotency key: a retried save never doubles

/** Chips that wrap onto more lines where there is room (tablet, desktop) and scroll sideways on a phone. */
const Chips = ({ wide, children }) => (wide ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>{children}</View> : <HScroll>{children}</HScroll>);
/** Two columns on a tablet or desktop, one on a phone; each child is one column. */
const Cols = ({ wide, children }) => <View style={{ flexDirection: wide ? 'row' : 'column', gap: 16, alignItems: 'flex-start' }}>{children.map((ch, n) => <View key={n} style={{ flex: 1, width: '100%', minWidth: 0 }}>{ch}</View>)}</View>;
const Status = ({ s }) => <Tag label={label(s)} color={s === 'completed' || s === 'present' ? c.lime : c.violetSoft} />;

function SharedParaPathwaysList({ athlete_id, push }) {
  const d = useLoad(() => api.get(`/coaching/para-pathway/${athlete_id}`), [athlete_id]);
  if (d.error || !d.data) return null;
  const pp = d.data;
  return (
    <Section title={t('pp.coach.shared')} color={c.violet}>
      <Row
        title={`${pp.sport} · ${t(`pp.stage.${pp.current_stage}`)}`}
        sub={`${t('pp.metrics.milestones')}: ${pp.milestone_count ?? 0} · ${t('pp.metrics.done')}: ${pp.done_count ?? 0}`}
        onPress={() => push('SharedParaPathway', { athlete_id })}
      />
    </Section>
  );
}

export function PerformanceStudio() {
  const { push } = useNav();
  const { tablet: wide } = useLayout();
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
      <H1>{t('nav.title.PerformanceStudio')}</H1>
      <T size={13} color={c.mute}>{t('cs.intro')}</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title={t('cs.new_team_session')} onPress={() => setCreating(true)} disabled={!teams.length} />
        <Btn small title={t('nav.title.CoachAthletes')} color={c.paper} ink={c.ink} onPress={() => push('CoachAthletes')} />
        <Btn small title={t('nav.title.CoachGroups')} color={c.paper} ink={c.ink} onPress={() => push('CoachGroups')} />
        <Btn small title={t('nav.title.CoachDrills')} color={c.paper} ink={c.ink} onPress={() => push('CoachDrills')} />
        <Btn small title={t('cs.track_game')} color={c.paper} ink={c.ink} onPress={() => push('ScoringTool', { tab: 'start' })} />
      </View>
      <HScroll>
        {[[null, t('common.all')], ['individual', t('cs.scope_individual')], ['group', t('cs.scope_group')], ['team', t('addr.scope_team')]].map(([v, l]) => <Chip key={l} label={l} active={flt.scope === v} onPress={() => setFlt({ ...flt, scope: v })} />)}
        <Chip label={t('cs.open_only')} active={flt.open_actions} onPress={() => setFlt({ ...flt, open_actions: !flt.open_actions })} />
        <Chip label={flt.from || flt.skill_tag || flt.team_id ? t('cs.more_filters_on') : t('cs.more_filters')} active={!!(flt.from || flt.skill_tag || flt.team_id)} onPress={() => setFiltering(true)} />
      </HScroll>
      {!teams.length && !coach.loading ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('cs.need_team')}</T> : null}
      {home.loading && !h ? <Loading /> : home.error ? <ErrorBox error={home.error} onRetry={home.reload} /> : (
        <Cols wide={wide}>
          <>
          <Section title={t('cs.running_now')}>
            {!h.running.length ? <Empty emoji="🏟️" title={t('cs.nothing_running')} sub={t('cs.nothing_running_sub')} /> :
              h.running.map((r) => <Row key={r.id} title={r.title} sub={t('cs.started', { when: dateTimeIn(r.started_at, tz) })} right={<Status s="running" />} onPress={() => push('CoachSession', { id: r.id })} />)}
          </Section>
          <Section title={t('cs.today')}>
            {!h.today.length && !h.to_open.length ? <Empty emoji="🗓️" title={t('cs.no_sessions_today')} sub={t('cs.no_sessions_today_sub')} /> : (
              <>
                {h.today.map((r) => <Row key={r.id} title={r.title} sub={dateTimeIn(r.scheduled_at, tz)} right={<Status s={r.status} />} onPress={() => push('CoachSession', { id: r.id })} />)}
                {h.to_open.map((x) => <Row key={`${x.source_type}${x.source_id}`} title={x.title} sub={`${dateTimeIn(x.scheduled_at, tz)} · ${label(x.source_type)}`} right={<T size={12} weight="700" color={c.pink}>{t('cs.open_arrow')}</T>} onPress={() => openSource(x)} />)}
              </>
            )}
          </Section>
          <Section title={t('cs.needs_review')}>
            {!h.needs_review.length ? <T size={13} color={c.mute}>{t('cs.all_reviewed')}</T> :
              h.needs_review.map((r) => <Row key={r.id} title={r.title} sub={t('cs.ended_no_summary', { when: dateTimeIn(r.ended_at, tz) })} onPress={() => push('CoachSession', { id: r.id })} />)}
          </Section>
          </>
          <>
          <Section title={t('cs.overdue_actions')}>
            {!h.overdue_actions.length ? <T size={13} color={c.mute}>{t('cs.nothing_overdue')}</T> :
              h.overdue_actions.map((a) => <Row key={a.id} title={a.title} sub={t('cs.due_line', { who: a.athlete_name ?? t('addr.scope_team'), when: dateTimeIn(a.due_at, tz) })} onPress={() => push('CoachGoals', a.athlete_id ? { athlete_id: a.athlete_id, name: a.athlete_name } : { team_id: a.team_id })} />)}
          </Section>
          <Section title={t('cs.goals_to_review')}>
            {!h.goals_due.length ? <T size={13} color={c.mute}>{t('cs.no_goal_reviews')}</T> :
              h.goals_due.map((g) => <Row key={g.id} title={g.title} sub={t('cs.review_line', { who: g.athlete_name ?? t('addr.scope_team'), date: g.review_on })} onPress={() => push('CoachGoals', g.athlete_id ? { athlete_id: g.athlete_id, name: g.athlete_name } : { team_id: g.team_id })} />)}
          </Section>
          {h.matches_to_prepare?.length ? <Section title={t('cs.matches_prepare')}>{h.matches_to_prepare.map((m) => <Row key={m.fixture_id} title={t('cs.match_title', { home: m.home_name, away: m.away_name })} sub={t('cs.no_plan_yet', { when: dateTimeIn(m.scheduled_at, tz), team: m.team_name })} onPress={() => push('CoachMatch', { fixture_id: m.fixture_id, team_id: m.team_id })} />)}</Section> : null}
          {h.matches_to_debrief?.length ? <Section title={t('cs.matches_debrief')}>{h.matches_to_debrief.map((m) => <Row key={m.fixture_id} title={t('cs.match_title', { home: m.home_name, away: m.away_name })} sub={t('cs.no_review_yet', { when: dateTimeIn(m.scheduled_at, tz), team: m.team_name })} onPress={() => push('CoachMatch', { fixture_id: m.fixture_id, team_id: m.team_id })} />)}</Section> : null}
          {h.goals_stale?.length ? <Section title={t('cs.goals_stale')}>{h.goals_stale.map((g) => <Row key={g.id} title={g.title} sub={g.athlete_name ?? t('addr.scope_team')} onPress={() => push('CoachGoals', g.athlete_id ? { athlete_id: g.athlete_id, name: g.athlete_name } : { team_id: g.team_id })} />)}</Section> : null}
          {h.draft_reports?.length ? <Section title={t('cs.draft_reports')}>{h.draft_reports.map((r) => <Row key={r.id} title={r.title} sub={t('cs.not_published')} onPress={() => push('CoachReport', { id: r.id })} />)}</Section> : null}
          {h.ai_waiting?.length ? <Section title={t('cs.ai_waiting')}>{h.ai_waiting.map((d) => <Row key={d.id} title={TASK_TITLE[d.task] ?? d.task} sub={d.headline ?? ''} onPress={() => push('CoachCopilot', { draft_id: d.id })} />)}</Section> : null}
          <Section title={t('cs.follow_up')}>
            {!h.follow_ups.length ? <T size={13} color={c.mute}>{t('cs.no_follow_up')}</T> :
              h.follow_ups.map((o) => <Row key={o.id} title={o.athlete_name ?? t('addr.scope_team')} sub={`${o.skill_tag ? `${o.skill_tag} · ` : ''}${o.note}`} onPress={() => push('CoachJournal', o.athlete_id ? { athlete_id: o.athlete_id, name: o.athlete_name } : { team_id: o.team_id })} />)}
          </Section>
          </>
        </Cols>
      )}
      <FormSheet visible={filtering} onClose={() => setFiltering(false)} title={t('cs.filters')} submitLabel={t('cs.apply')} initial={{ ...flt, skill_tag: flt.skill_tag }}
        fields={[
          { key: 'team_id', label: t('addr.scope_team'), type: 'chips', optional: true, options: teams.map((tm) => ({ value: tm.id, label: `${tm.emoji ?? ''} ${tm.name}`.trim() })) },
          { key: 'skill_tag', label: t('cs.skill_tag'), optional: true, placeholder: t('cs.skill_tag_ph') },
          { key: 'from', toKey: 'to', label: t('cs.dates'), type: 'daterange', optional: true },
        ]}
        onSubmit={async (v) => { setFlt({ ...flt, team_id: v.team_id ?? null, skill_tag: v.skill_tag ?? '', from: v.from ?? null, to: v.to ?? null }); setFiltering(false); }} />
      <FormSheet visible={creating} onClose={() => setCreating(false)} title={t('cs.new_team_session')} submitLabel={t('cs.create')}
        fields={[
          { key: 'team_id', label: t('addr.scope_team'), type: 'chips', options: teams.map((tm) => ({ value: tm.id, label: `${tm.emoji ?? ''} ${tm.name}`.trim() })) },
          { key: 'title', label: t('cs.session_title') },
          { key: 'date', label: t('cs.date'), type: 'date' },
          { key: 'time', label: t('cs.start_time'), type: 'time' },
          { key: 'objective', label: t('cs.objective'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const key = keyOf();
          const rec = await api.post('/coaching/sessions', { source_type: 'team_session', source_id: uuidFrom(key), team_id: v.team_id, title: v.title, objective: v.objective || undefined, scheduled_at: localToIso(v.date, v.time, tz) });
          setCreating(false); toast(t('cs.session_created')); push('CoachSession', { id: rec.id });
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
  const { toast, user } = useSession();
  const { tablet: wide } = useLayout();
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
  const rubrics = useLoad(() => api.get('/coaching/rubrics'), []);
  const myGoals = useLoad(() => api.get('/coaching/goals?limit=100'), []);
  const [voice, setVoice] = useState(false);
  const [more, setMore] = useState(null); // null | 'menu' | 'groups' | 'template' | 'use' | 'clone' | 'help' | {summary: athlete}
  const [busy, setBusy] = useState(null);
  const w = ws.data;
  const outbox = useOutbox();
  const run = async (name, fn, msg) => { setBusy(name); try { await fn(); await ws.reload(); if (msg) toast(msg); } catch (e) { toast(e.message ?? t('cs.could_not_save')); } setBusy(null); };
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
      {outbox.pending ? <Card pad={10} color={c.cyanSoft} style={{ marginTop: 8 }}><T size={12} weight="700">{t(outbox.pending === 1 ? 'cs.notes_waiting_one' : 'cs.notes_waiting_many', { n: outbox.pending })}</T><T size={12} color={c.mute}>{t('cs.outbox_help')}</T><View style={{ marginTop: 6 }}><Btn small title={t('cs.retry_now')} onPress={outbox.flush} /></View></Card> : null}
      {outbox.rejected ? <Card pad={10} color={c.violetSoft} style={{ marginTop: 8 }}><T size={12} weight="700">{t('cs.note_refused')}</T><T size={12} color={c.mute}>{outbox.rejected}</T></Card> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {s.status === 'planned' ? <Btn small title={t('cs.start_session')} loading={busy === 'start'} onPress={() => run('start', () => api.post(`/coaching/sessions/${s.id}/start`), t('cs.session_started'))} /> : null}
        {s.status === 'running' ? <Btn small title={t('cs.finish_review')} onPress={() => setFinishing(true)} /> : null}
        {!done ? <Btn small title={blocks.length ? t('cs.edit_plan') : t('cs.plan_blocks')} color={c.paper} ink={c.ink} onPress={() => setPlanning(true)} /> : null}
        <Btn small title={t('nav.tab.More')} color={c.paper} ink={c.ink} onPress={() => setMore('menu')} />
        {!done ? <Btn small title={t('cs.voice_note')} color={c.paper} ink={c.ink} onPress={() => setVoice(true)} /> : null}
        {!done ? <Btn small title={t('cs.draft_plan_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'plan_session', session_record_id: s.id })} /> : <Btn small title={t('cs.draft_summary_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'summarise_session', session_record_id: s.id })} />}
        {!done || s.team_summary || s.private_summary ? null : <Btn small title={t('cs.add_review')} onPress={() => setFinishing(true)} />}
      </View>

      <Cols wide={wide}>
        <>
      <Section title={counts.length ? t('cs.attendance_counts', { counts: counts.map(([a, n]) => `${n} ${label(a).toLowerCase()}`).join(', ') }) : t('cs.attendance')}>
        {!w.participants.length ? <Empty emoji="👥" title={t('cs.no_roster')} sub={t('cs.no_roster_sub')} /> : w.participants.map((p) => (
          <Card key={p.id} pad={12} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T weight="700" style={{ flexShrink: 1 }}>{p.display_name}</T>
              <Status s={p.attendance === 'expected' ? 'not_recorded' : p.attendance} />
            </View>
            <Chips wide={wide}>
              {ATTENDANCE.map((a) => <Chip key={a} label={label(a)} active={p.attendance === a} onPress={() => mark(p.id, a)} />)}
              <Chip label={t('cs.note')} onPress={() => setNote({ athlete_id: p.id })} />
              <Chip label={t('cs.player_summary')} onPress={() => setMore({ summary: p })} />
            </Chips>
            {w.previous_notes.filter((x) => x.athlete_id === p.id).slice(0, 2).map((x) => (
              <T key={x.id} size={12} color={c.mute} style={{ marginTop: 4 }}>{x.follow_up ? t('cs.follow_up_prefix') : t('cs.last_time')} {x.note}</T>
            ))}
          </Card>
        ))}
      </Section>

        </>
        <>
      <Section title={t('cs.plan')}>
        {!blocks.length ? <T size={13} color={c.mute}>{t('cs.no_blocks')}</T> : blocks.map((b, n) => {
          const st = w.block_log[b.id]?.status;
          return (
            <Card key={b.id} pad={12} style={{ marginBottom: 8 }}>
              <T weight="700">{n + 1}. {b.title}{b.duration_min ? ` · ${t('cs.min', { n: b.duration_min })}` : ''}</T>
              <T size={12} color={c.mute}>{label(b.kind)}{b.unit ? ` · ${t('cs.for_unit', { unit: b.unit })}` : ''}{b.objective ? ` · ${b.objective}` : ''}</T>
              {b.cues?.length ? <T size={12} color={c.mute}>{t('cs.cues', { cues: b.cues.join(' · ') })}</T> : null}
              {s.status === 'running' ? (
                <HScroll>
                  {['completed', 'skipped', 'modified'].map((x) => <Chip key={x} label={label(x)} active={st === x} onPress={() => run(`b${b.id}`, () => api.post(`/coaching/sessions/${s.id}/blocks/${b.id}`, { status: x }))} />)}
                </HScroll>
              ) : st ? <Status s={st} /> : null}
            </Card>
          );
        })}
      </Section>

      <Section title={t('cs.notes_from')} action={done ? undefined : t('cs.team_note')} onAction={() => setNote({ team_id: s.team_id })}>
        {!w.observations.length ? <T size={13} color={c.mute}>{t('cs.nothing_noted')}</T> : w.observations.map((o) => (
          <View key={o.id}>
            <Row title={`${w.participants.find((p) => p.id === o.athlete_id)?.display_name ?? t('addr.scope_team')}${o.skill_tag ? ` · ${o.skill_tag}` : ''}`} sub={`${o.note}`} right={<Tag label={VISIBILITY.find(([v]) => v === o.visibility)[1]} color={c.violetSoft} />} />
            <EvidenceRow obs={o} mine={o.coach_id === user.id} toast={toast} />
          </View>
        ))}
      </Section>
      {done && (s.team_summary || s.private_summary) ? (
        <Section title={t('access.review')}>
          {s.team_summary ? <Card pad={12}><T weight="700">{t('cs.team_summary')}</T><T size={13}>{s.team_summary}</T></Card> : null}
          {s.private_summary ? <Card pad={12} style={{ marginTop: 8 }}><T weight="700">{t('cs.private_summary')}</T><T size={13}>{s.private_summary}</T></Card> : null}
        </Section>
      ) : null}
        </>
      </Cols>
      <View style={{ marginTop: 16 }}>{w.participants.length ? <Btn small title={t('cs.open_journal')} color={c.paper} ink={c.ink} onPress={() => push('CoachJournal', { athlete_id: w.participants[0].id, name: w.participants[0].display_name })} /> : null}</View>

      <NoteSheet note={note} onClose={() => setNote(null)} w={w} rubrics={rubrics.data ?? []} goals={myGoals.data ?? []}
        onSaved={(r) => { setNote(null); toast(r.status === 'saved' ? t('cs.note_saved') : t('cs.note_queued')); ws.reload(); }} />
      <MoreSheet more={more} setMore={setMore} w={w} reload={ws.reload} />
      <VoiceSheet visible={voice} onClose={() => setVoice(false)} w={w} onSaved={(r) => { setVoice(false); toast(r.status === 'saved' ? t('cs.note_saved') : t('cs.note_queued')); ws.reload(); }} />
      <PlanSheet visible={planning} blocks={blocks} version={w.plan.version} groups={s.groups} onClose={() => setPlanning(false)} onSave={async (next) => { await api.post(`/coaching/sessions/${s.id}/plan`, { blocks: next, expected_version: w.plan.version }); setPlanning(false); toast(t('cs.plan_saved')); ws.reload(); }} />
      <FormSheet visible={finishing} onClose={() => setFinishing(false)} title={t('cs.review_session')} submitLabel={done ? t('cs.save_review') : t('cs.finish_session')} initial={{ team_summary: s.team_summary ?? '', private_summary: s.private_summary ?? '' }}
        fields={[{ key: 'team_summary', label: t('cs.team_summary_share'), type: 'multiline', optional: true }, { key: 'share_team_summary', label: t('cs.let_players_read'), type: 'switch', default: !!s.team_summary_shared }, { key: 'private_summary', label: t('cs.private_summary'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          if (done) { await api.post(`/coaching/sessions/${s.id}/review`, { team_summary: v.team_summary || undefined, private_summary: v.private_summary || undefined, share_team_summary: !!v.share_team_summary }); setFinishing(false); toast(t('cs.review_saved')); ws.reload(); return; }
          const r = await api.post(`/coaching/sessions/${s.id}/complete`, { team_summary: v.team_summary || undefined, private_summary: v.private_summary || undefined });
          setFinishing(false); toast(r.not_recorded ? t(r.not_recorded === 1 ? 'cs.finished_one' : 'cs.finished_many', { n: r.not_recorded }) : t('cs.session_finished')); ws.reload();
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
      <Sheet visible={visible && !adding} onClose={() => { setList(null); onClose(); }} title={t('cs.plan_version', { n: version + 1 })}>
        {!cur.length ? <T size={13} color={c.mute}>{t('cs.no_blocks_short')}</T> : null}
        {cur.map((b, n) => (
          <Row key={b.id ?? n} title={`${n + 1}. ${b.title}`} sub={`${label(b.kind)}${b.duration_min ? ` · ${t('cs.min', { n: b.duration_min })}` : ''}${b.unit ? ` · ${b.unit}` : ''}`} right={(
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Chip label="↑" onPress={() => n > 0 && move(n, -1)} /><Chip label="↓" onPress={() => n < cur.length - 1 && move(n, 1)} /><Chip label={t('access.remove')} onPress={() => setList(cur.filter((_, i) => i !== n))} />
            </View>)} />
        ))}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Btn small title={t('cs.add_block')} color={c.paper} ink={c.ink} onPress={() => setAdding(true)} />
          <Btn small title={t('cs.save_plan')} onPress={() => onSave(cur).then(() => setList(null))} />
        </View>
      </Sheet>
      <FormSheet visible={visible && adding} onClose={() => setAdding(false)} title={t('cs.add_block')} submitLabel={t('access.add')}
        fields={[
          { key: 'kind', label: t('access.type'), type: 'chips', options: opts(BLOCK_KINDS), default: 'skill_drill' },
          { key: 'title', label: t('cs.block_title') },
          { key: 'duration_min', label: t('cs.minutes'), type: 'stepper', min: 1, max: 240, step: 5, default: 10 },
          { key: 'objective', label: t('cs.objective'), optional: true },
          { key: 'instructions', label: t('cs.instructions'), type: 'multiline', optional: true },
          { key: 'cue', label: t('cs.coaching_cue'), optional: true },
          { key: 'target_rpe', label: t('cs.target_rpe'), type: 'stepper', min: 1, max: 10, step: 1, default: 6, optional: true },
          ...(groups?.length ? [{ key: 'unit', label: t('cs.for_group'), type: 'chips', optional: true, options: groups.map((g) => ({ value: g.name, label: g.name })) }] : []),
        ]}
        onSubmit={async (v) => { setList([...cur, { kind: v.kind, title: v.title, duration_min: v.duration_min, objective: v.objective || undefined, instructions: v.instructions || undefined, cues: v.cue ? [v.cue] : [], tags: [], target_rpe: v.target_rpe || undefined, unit: v.unit || undefined }]); setAdding(false); }} />
    </>
  );
}

export function CoachJournal({ athlete_id, team_id, name }) {
  const { push } = useNav();
  const { tablet: wide } = useLayout();
  const [tag, setTag] = useState(null);
  const path = athlete_id ? `/coaching/athletes/${athlete_id}/timeline` : `/coaching/teams/${team_id}/timeline`;
  const tl = useLoad(() => api.get(`${path}?limit=100${tag ? `&skill_tag=${encodeURIComponent(tag)}` : ''}`), [path, tag]);
  const all = useLoad(() => api.get(`${path}?limit=100`), [path]);
  const tags = [...new Set((all.data ?? []).map((x) => x.skill_tag).filter(Boolean))].sort();
  return (
    <Screen onRefresh={tl.reload}>
      <H1>{name ? t('cs.journal_named', { name }) : athlete_id ? t('cs.player_journal') : t('cs.team_journal')}</H1>
      <T size={13} color={c.mute}>{t('cs.journal_help')}</T>
      {athlete_id ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}><Btn small title={t('nav.title.CoachGoals')} onPress={() => push('CoachGoals', { athlete_id, name })} /><Btn small title={t('nav.title.CoachReports')} color={c.paper} ink={c.ink} onPress={() => push('CoachReports', { athlete_id, name })} /><Btn small title={t('cs.assistant_ro')} color={c.paper} ink={c.ink} onPress={() => push('PlayerAssistant', { child_id: athlete_id, name, staff: true })} /><Btn small title={t('cs.progress_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'player_progress', athlete_id })} /><Btn small title={t('cs.ask_notes_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'ask', athlete_id })} /></View> : <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title={t('nav.title.CoachGoals')} onPress={() => push('CoachGoals', { team_id })} /><Btn small title={t('nav.title.CoachReports')} color={c.paper} ink={c.ink} onPress={() => push('CoachReports', { team_id })} /><Btn small title={t('cs.patterns_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'team_patterns', team_id })} /></View>}
      <Cols wide={wide && !!athlete_id}>
        <>{athlete_id ? <><Metrics athlete_id={athlete_id} team_id={team_id} /><Section title={t('cs.benchmarks')} color={c.cyan}><AthleteBenchmarks athlete_id={athlete_id} /></Section><ClipsShared athlete_id={athlete_id} /></> : null}</>
        <>
      {tags.length ? <HScroll><Chip label={t('common.all')} active={!tag} onPress={() => setTag(null)} />{tags.map((tg) => <Chip key={tg} label={tg} active={tag === tg} onPress={() => setTag(tg)} />)}</HScroll> : null}
      {tl.loading && !tl.data ? <Loading /> : tl.error ? <ErrorBox error={tl.error} onRetry={tl.reload} /> : !tl.data.length ?
        <Empty emoji="📓" title={t('cs.nothing_recorded')} sub={t('cs.nothing_recorded_sub')} /> :
        tl.data.map((x) => (
          <Card key={`${x.kind}${x.source_id}`} pad={12} style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <T weight="700" style={{ flexShrink: 1 }}>{label(x.title ?? x.kind)}</T>
              <T size={12} color={c.mute}>{dateTimeIn(x.at, tz)}</T>
            </View>
            {x.detail ? <T size={13}>{x.detail}</T> : null}
            <T size={11} color={c.mute}>{label(x.kind)}{x.visibility ? ` · ${VISIBILITY.find(([v]) => v === x.visibility)?.[1]}` : ''}{x.own === false ? ` ${t('cs.by_other')}` : ''}{x.edited ? ` ${t('cs.edited')}` : ''}{x.follow_up ? ` ${t('cs.follow_up_tag')}` : ''}</T>
          </Card>
        ))}
        </>
      </Cols>
    </Screen>
  );
}

// Clips the athlete chose to share or publish (read-only). The API answers 404 when this coach does not coach the athlete or a young person's
// guardian has not given media consent, so the screen says "not available" rather than hinting which.
function ClipsShared({ athlete_id }) {
  const v = useLoad(() => api.get(`/athletes/${athlete_id}/videos`, { limit: 50 }), [athlete_id]);
  return (
    <Section title={t('cs.clips_title')} color={c.violet}>
      <T size={12} color={c.mute}>{t('cs.clips_sub')}</T>
      <T size={11} color={c.mute} style={{ marginTop: 2 }}>{t('cs.clips_logged')}</T>
      {v.loading && !v.data ? <Loading /> : v.error?.status === 404 ? <Empty emoji="🔒" title={t('cs.clips_unavailable')} sub={t('cs.clips_unavailable_sub')} />
        : v.error ? <ErrorBox error={v.error} onRetry={v.reload} /> : !v.data?.length ? <Empty emoji="🎬" title={t('cs.clips_empty')} sub={t('cs.clips_empty_sub')} />
        : v.data.map((x) => (
          <Card key={x.id} pad={12} style={{ marginTop: 8 }}>
            <VideoPlayer video={{ ...x, file_url: x.has_file ? `/passport-videos/${x.id}/file` : null }} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <T weight="700" style={{ flexShrink: 1 }}>{x.title}</T>
              <Tag label={t(`vl.vis_${x.visibility}`)} color={c.violetSoft} />
            </View>
            {x.sport_slug ? <T size={12} color={c.mute}>{label(x.sport_slug)}</T> : null}
            {x.description ? <T size={13} style={{ marginTop: 4 }}>{x.description}</T> : null}
          </Card>
        ))}
    </Section>
  );
}

// Every metric says what it is, where it comes from and how many records stand behind it; missing data is "no data", never zero.
function Metrics({ athlete_id, team_id: teamProp }) {
  const { push } = useNav();
  const m = useLoad(() => api.get(`/coaching/athletes/${athlete_id}/metrics`), [athlete_id]);
  const team_id = teamProp ?? m.data?.teams?.[0]?.id;
  const [cmp, setCmp] = useState({});   // metric key -> result or message
  if (m.loading && !m.data) return null;
  if (m.error || !m.data) return null;
  const run = async (x, mode) => {
    const q = `metric=${encodeURIComponent(x.key)}&mode=${mode}&from=${m.data.from}&to=${m.data.to}${mode === 'team' || mode === 'position' ? `&team_id=${team_id}` : ''}`;
    try { setCmp({ ...cmp, [x.key]: await api.get(`/coaching/athletes/${athlete_id}/compare?${q}`) }); } catch (e) { setCmp({ ...cmp, [x.key]: { error: e.message } }); }
  };
  const say = (r) => {
    if (!r) return null;
    if (r.error) return r.error;
    if (r.result === 'insufficient_data' || r.result === 'no_data' || r.result === 'insufficient_sample') return r.note;
    if (r.cohort) return t('cs.cmp_cohort', { size: r.cohort.size, group: r.cohort.group, median: r.cohort.median, min: r.cohort.min, max: r.cohort.max, diff: r.difference_from_median == null ? '' : t('cs.cmp_diff', { diff: `${r.difference_from_median >= 0 ? '+' : ''}${r.difference_from_median}` }) }).replace('  ', ' ');
    if (r.previous) return t('cs.cmp_prev', { value: r.previous.value, sample: r.previous.sample, diff: `${r.difference >= 0 ? '+' : ''}${r.difference}` });
    return null;
  };
  return (
    <Section title={t('cs.trends', { from: m.data.from, to: m.data.to })}>
      <View style={{ marginBottom: 8 }}><Btn small title={t('cs.explain_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'compare_metrics', athlete_id, metric_keys: m.data.metrics.filter((x) => x.value != null).slice(0, 6).map((x) => x.key) })} /></View>
      {m.data.metrics.map((x) => (
        <Card key={x.key} pad={12} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T weight="700" style={{ flexShrink: 1 }}>{x.label}</T>
            <T weight="800">{x.value == null ? t('cs.no_data') : `${x.value}${x.unit === '%' ? '%' : ` ${x.unit ?? ''}`}`}</T>
          </View>
          <T size={11} color={c.mute}>{x.provenance_label} · {t(x.sample === 1 ? 'cs.records_one' : 'cs.records_many', { n: x.sample })}{x.excluded?.not_recorded ? ` ${t('cs.not_recorded_n', { n: x.excluded.not_recorded })}` : ''}{x.excluded?.excused ? ` ${t('cs.excused_n', { n: x.excluded.excused })}` : ''}</T>
          <T size={11} color={c.mute}>{x.definition}</T>
          <HScroll>
            <Chip label={t('cs.vs_last')} onPress={() => run(x, 'prior_period')} />
            {team_id && /^(measurement|rubric|official:event)/.test(x.key) ? <Chip label={t('cs.vs_team')} onPress={() => run(x, 'team')} /> : null}
            {team_id && /^(measurement|rubric|official:event)/.test(x.key) ? <Chip label={t('cs.vs_position')} onPress={() => run(x, 'position')} /> : null}
          </HScroll>
          {cmp[x.key] ? <T size={12}>{say(cmp[x.key])}</T> : null}
        </Card>
      ))}
    </Section>
  );
}

export function CoachGoals({ athlete_id, team_id, name, programme_id }) {
  const { toast } = useSession();
  const { tablet: wide } = useLayout();
  const { push } = useNav();
  const progs = useLoad(() => api.get(`/coaching/programmes?${athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`}&status=active`), [athlete_id, team_id]);
  const q = athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`;
  const goals = useLoad(() => api.get(`/coaching/goals?${q}${programme_id ? `&programme_id=${programme_id}` : ''}`), [q, programme_id]);
  const actions = useLoad(() => api.get(`/coaching/actions?${q}`), [q]);
  const [form, setForm] = useState(null); // 'goal' | { goal } | 'action'
  const [reviewing, setReviewing] = useState(null);
  const reload = () => { goals.reload(); actions.reload(); };
  const subject = athlete_id ? { athlete_id } : { team_id };
  return (
    <Screen onRefresh={reload}>
      <H1>{name ? t('cs.goals_named', { name }) : t('nav.title.CoachGoals')}</H1>
      <T size={13} color={c.mute}>{t('cs.goals_help')}</T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn small title={t('cs.new_goal')} onPress={() => setForm('goal')} /><Btn small title={t('nav.title.CoachProgrammes')} color={c.paper} ink={c.ink} onPress={() => push('CoachProgrammes', athlete_id ? { athlete_id, name } : { team_id })} /><Btn small title={t('cs.new_action')} color={c.paper} ink={c.ink} onPress={() => setForm('action')} />
      </View>
      <Cols wide={wide}>
        <>
      <Section title={t('cs.goals')}>
        {goals.loading && !goals.data ? <Loading /> : goals.error ? <ErrorBox error={goals.error} onRetry={goals.reload} /> : !goals.data.length ? <Empty emoji="🎯" title={t('cs.no_goals')} sub={t('cs.no_goals_sub')} /> :
          goals.data.map((g) => <Row key={g.id} title={g.title} sub={t('cs.goal_line', { cat: label(g.category), prio: label(g.priority), review: g.review_on ? ` ${t('cs.goal_review_part', { date: g.review_on })}` : '', n: g.evidence_count })} right={<Status s={g.status} />} onPress={() => setReviewing(g)} />)}
      </Section>
        </>
        <>
      <Section title={t('cs.actions')}>
        {actions.loading && !actions.data ? <Loading /> : actions.error ? <ErrorBox error={actions.error} onRetry={actions.reload} /> : !actions.data.length ? <Empty emoji="✅" title={t('cs.no_actions')} sub={t('cs.no_actions_sub')} /> :
          actions.data.map((a) => (
            <Card key={a.id} pad={12} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}><T weight="700" style={{ flexShrink: 1 }}>{a.title}</T><Status s={a.overdue ? 'overdue' : a.status} /></View>
              <T size={12} color={c.mute}>{a.due_at ? t('cs.due_part', { when: dateTimeIn(a.due_at, tz) }) : t('cs.no_due')}{a.shared ? ` ${t('cs.shared_athlete')}` : ''}</T>
              {a.status === 'open' || a.status === 'in_progress' ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                  <Btn small title={t('common.done')} onPress={async () => { try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'done' }); reload(); } catch (e) { toast(e.message); reload(); } }} />
                  <Btn small title={t('common.cancel')} color={c.paper} ink={c.red} onPress={async () => { try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'cancelled' }); reload(); } catch (e) { toast(e.message); reload(); } }} />
                </View>
              ) : null}
            </Card>
          ))}
      </Section>
        </>
      </Cols>
      {athlete_id ? <SharedByPlayers athlete_id={athlete_id} /> : null}
      {athlete_id ? <SharedParaPathwaysList athlete_id={athlete_id} push={push} /> : null}
      <FormSheet visible={form === 'goal'} onClose={() => setForm(null)} title={t('cs.new_goal')} submitLabel={t('cs.create_goal')}
        fields={[
          { key: 'title', label: t('cs.goal_label') },
          { key: 'category', label: t('cs.category'), type: 'chips', options: opts(GOAL_CATEGORIES), default: 'technical' },
          { key: 'criterion', label: t('cs.criterion'), type: 'multiline', optional: true },
          { key: 'priority', label: t('cs.priority'), type: 'chips', options: opts(['low', 'medium', 'high']), default: 'medium' },
          ...(progs.data?.length ? [{ key: 'programme_id', label: t('cs.programme'), type: 'chips', optional: true, default: programme_id, options: progs.data.map((p) => ({ value: p.id, label: p.title })) }] : []),
          { key: 'review_on', label: t('cs.review_on'), type: 'date', optional: true },
          { key: 'athlete_text', label: t('cs.athlete_text'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post('/coaching/goals', { ...subject, programme_id: v.programme_id || undefined, title: v.title, category: v.category, criterion: v.criterion || undefined, priority: v.priority, review_on: v.review_on || undefined, athlete_text: v.athlete_text || undefined }); setForm(null); toast(t('cs.goal_created')); reload(); }} />
      <FormSheet visible={form === 'action'} onClose={() => setForm(null)} title={t('cs.new_action')} submitLabel={t('cs.create_action')}
        fields={[
          { key: 'title', label: t('cs.action_label') },
          { key: 'detail', label: t('cs.detail'), type: 'multiline', optional: true },
          { key: 'due', label: t('cs.due_date'), type: 'date', optional: true },
          { key: 'priority', label: t('cs.priority'), type: 'chips', options: opts(['low', 'medium', 'high']), default: 'medium' },
          ...(athlete_id ? [{ key: 'owner', label: t('cs.who_does'), type: 'chips', options: [{ value: 'me', label: t('cs.me') }, { value: 'athlete', label: t('cs.the_athlete') }], default: 'me' }] : []),
          { key: 'repeat', label: t('cs.repeat'), type: 'stepper', min: 1, max: 365, step: 1, default: 7, optional: true },
          { key: 'follow_up_next_session', label: t('cs.show_next'), type: 'switch', default: true },
        ]}
        onSubmit={async (v) => {
          await api.post('/coaching/actions', { recurrence_days: v.due && v.repeat ? v.repeat : undefined, ...subject, title: v.title, detail: v.detail || undefined, due_at: v.due ? localToIso(v.due, '18:00', tz) : undefined, priority: v.priority, owner_id: v.owner === 'athlete' ? athlete_id : undefined, shared: v.owner === 'athlete', follow_up_next_session: !!v.follow_up_next_session, client_key: keyOf() });
          setForm(null); toast(t('cs.action_created')); reload();
        }} />
      <FormSheet visible={!!reviewing} onClose={() => setReviewing(null)} title={reviewing?.title ?? t('cs.review_goal')} submitLabel={t('cs.save_review')} initial={{ status: reviewing?.status }}
        fields={[
          { key: 'status', label: t('cs.status'), type: 'chips', options: opts(GOAL_STATUS) },
          { key: 'review_note', label: t('cs.why_achieved'), type: 'multiline', optional: true },
          { key: 'review_on', label: t('cs.next_review'), type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { await api.patch(`/coaching/goals/${reviewing.id}`, { row_version: reviewing.row_version, status: v.status, review_note: v.review_note || undefined, review_on: v.review_on || undefined }); setReviewing(null); toast(t('cs.review_saved')); reload(); }} />
    </Screen>
  );
}

// AI copilot (draft only). The coach decides what the AI may read, sees which records it used and what it could not know,
// and nothing is saved until Accept. Without an AI provider the same screen shows a plain summary of the coach's own records.
const TASK_TITLE = { plan_session: t('cs.task_plan_session'), player_focus: t('cs.task_player_focus'), summarise_session: t('cs.task_summarise'), player_progress: t('cs.task_progress'), team_patterns: t('cs.task_patterns'), suggest_actions: t('cs.task_actions'), match_debrief: t('cs.task_match'), ask: t('cs.task_ask'), compare_metrics: t('cs.task_compare') };

export function CoachCopilot({ task: taskProp = 'player_progress', athlete_id, team_id, session_record_id, draft_id, metric_keys }) {
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
    try { setDraft(await api.post('/coaching/ai/drafts', { task, athlete_id, team_id, session_record_id, include_private_summaries: priv, question: task === 'ask' ? question : undefined, metric_keys })); }
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
      toast(decision === 'accept' ? t('access.saved') : t('cs.discarded')); back();
    } catch (e) { toast(e.message ?? t('cs.could_not_save')); }
    setBusy(false);
  };
  const o = draft?.output;
  const acceptLabel = { plan_session: t('cs.accept_plan'), suggest_actions: t('cs.accept_actions'), summarise_session: t('cs.accept_summary') }[task] ?? t('cs.accept_read');
  return (
    <Screen>
      <T size={12} weight="700" color={c.pink} style={{ letterSpacing: 1.2 }}>{t('cs.ai_draft_tag')}</T>
      <H1>{TASK_TITLE[task]}</H1>
      <T size={13} color={c.mute}>{t('cs.ai_intro')}</T>
      {!draft ? (
        <>
          <Card pad={14} style={{ marginTop: 10 }}>
            <T weight="700">{t('cs.ai_may_read')}</T>
            <T size={13} color={c.mute}>{t('cs.ai_reads', { scope: session_record_id ? t('cs.scope_session') : athlete_id ? t('cs.scope_player') : t('cs.scope_team_word') })}</T>
            <View style={{ marginTop: 8 }}><HScroll><Chip label={priv ? t('cs.priv_shared') : t('cs.priv_not_shared')} active={priv} onPress={() => setPriv(!priv)} /></HScroll></View>
          </Card>
          {task === 'ask' ? <View style={{ marginTop: 10 }}><Field label={t('cs.your_question')} value={question} onChangeText={setQuestion} multiline maxLength={400} /></View> : null}
          {err ? <ErrorBox error={err} onRetry={generate} /> : null}
          <View style={{ marginTop: 12 }}><Btn title={t('cs.draft_it')} loading={busy} disabled={task === 'ask' && !question.trim()} onPress={generate} /></View>
        </>
      ) : (
        <>
          <Card pad={14} style={{ marginTop: 10 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={draft.ai ? t('cs.ai_suggestion') : t('cs.plain_summary')} color={c.violetSoft} /></View>
            <T weight="700" style={{ marginTop: 6 }}>{o.headline}</T>
          </Card>
          {o.items.map((x) => (
            <Card key={x.id} pad={12} style={{ marginTop: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <T weight="700" style={{ flexShrink: 1 }}>{x.title}</T>
                <Tag label={x.basis === 'observed' ? t('cs.from_notes') : t('cs.suggestion')} color={x.basis === 'observed' ? c.lime : c.violetSoft} />
              </View>
              {x.detail ? <T size={13}>{x.detail}</T> : null}
              {x.why ? <T size={12} color={c.mute}>{t('cs.why', { why: x.why })}</T> : null}
              {x.source_refs.length ? <T size={11} color={c.mute}>{t('cs.sources', { list: x.source_refs.map((r) => { const s = draft.sources.find((y) => y.ref === r); return s ? `${s.label ?? s.type}${s.at ? ` · ${dateTimeIn(s.at, tz)}` : ''}` : r; }).join(' · ') })}</T> : <T size={11} color={c.mute}>{t('cs.no_source')}</T>}
              {task === 'suggest_actions' && x.action ? <View style={{ marginTop: 6 }}><Chip label={picked[x.id] ? t('cs.will_create') : t('cs.create_this')} active={!!picked[x.id]} onPress={() => setPicked({ ...picked, [x.id]: !picked[x.id] })} /></View> : null}
            </Card>
          ))}
          <Card pad={12} color={c.cyanSoft} style={{ marginTop: 10 }}>
            <T weight="700" size={13}>{t('cs.limits')}</T>
            {draft.limitations.map((l) => <T key={l} size={12} color={c.mute}>• {l}</T>)}
          </Card>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn title={acceptLabel} loading={busy} disabled={(task === 'suggest_actions' && !Object.values(picked).some(Boolean)) || (task === 'plan_session' && !o.items.some((x) => x.block))} onPress={() => resolve('accept')} />
            <Btn title={t('cs.discard')} color={c.paper} ink={c.red} onPress={() => resolve('discard')} />
          </View>
        </>
      )}
    </Screen>
  );
}

// Reports: choose an audience, see exactly what that audience will get, then publish a frozen version.
const AUD = [['coach_private', t('cs.aud_me')], ['athlete', t('cs.aud_athlete')], ['guardian', t('cs.aud_guardian')], ['team_staff', t('cs.vis_staff')], ['organisation', t('rsh.aud_org')]];
const KIND = ['athlete_progress', 'session', 'goal_review', 'team_training', 'match_debrief', 'period_review', 'action_summary', 'team_performance'];

export function CoachReports({ athlete_id, team_id, name }) {
  const { push } = useNav();
  const { toast } = useSession();
  const q = athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`;
  const list = useLoad(() => api.get(`/coaching/reports?${q}`), [q]);
  const [creating, setCreating] = useState(false);
  return (
    <Screen onRefresh={list.reload}>
      <H1>{name ? t('cs.reports_named', { name }) : t('nav.title.CoachReports')}</H1>
      <T size={13} color={c.mute}>{t('cs.reports_help')}</T>
      <View style={{ marginTop: 10 }}><Btn small title={t('cs.new_report')} onPress={() => setCreating(true)} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="📄" title={t('cs.no_reports')} sub={t('cs.no_reports_sub')} /> :
        list.data.map((r) => <Row key={r.id} title={r.title} sub={t('cs.report_line', { aud: AUD.find(([v]) => v === r.audience)?.[1], from: r.period_from.slice(0, 10), to: r.period_to.slice(0, 10), status: r.latest_version ? t('cs.v_published', { n: r.latest_version }) : t('cs.draft_word') })} onPress={() => push('CoachReport', { id: r.id })} />)}
      <FormSheet visible={creating} onClose={() => setCreating(false)} title={t('cs.new_report')} submitLabel={t('cs.create')}
        fields={[
          { key: 'title', label: t('cs.title_label') },
          { key: 'kind', label: t('cs.kind'), type: 'chips', options: opts(KIND), default: 'athlete_progress' },
          { key: 'audience', label: t('cs.who_reads'), type: 'chips', options: AUD.filter(([v]) => (athlete_id ? true : v === 'coach_private' || v === 'team_staff')).map(([value, lab]) => ({ value, label: lab })), default: 'coach_private' },
          { key: 'from', toKey: 'to', label: t('cs.period'), type: 'daterange' },
          { key: 'goals', label: t('cs.inc_goals'), type: 'switch', default: true },
          { key: 'metrics', label: t('cs.inc_numbers'), type: 'switch', default: true },
          { key: 'actions', label: t('cs.inc_steps'), type: 'switch', default: true },
          { key: 'narrative', label: t('cs.your_summary'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          const r = await api.post('/coaching/reports', { athlete_id, team_id, title: v.title, kind: v.kind, audience: v.audience, from: v.from, to: v.to, selection: { goals: !!v.goals, metrics: athlete_id ? !!v.metrics : false, actions: !!v.actions }, narrative: v.narrative || undefined });
          setCreating(false); toast(t('cs.report_created')); push('CoachReport', { id: r.id });
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
  const act = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); rep.reload(); prev.reload(); } catch (e) { toast(e.message ?? t('cs.could_not_do')); } setBusy(false); };
  if ((rep.loading && !r) || (prev.loading && !snap)) return <Screen><Loading /></Screen>;
  if (rep.error || prev.error) return <Screen><ErrorBox error={rep.error ?? prev.error} onRetry={() => { rep.reload(); prev.reload(); }} /></Screen>;
  const aud = AUD.find(([v]) => v === r.audience)[1];
  return (
    <Screen onRefresh={() => { rep.reload(); prev.reload(); }}>
      <H1>{r.title}</H1>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Tag label={t('cs.for_aud', { aud })} color={c.violetSoft} /><Tag label={r.latest_version ? t('cs.v_published', { n: r.latest_version }) : t('cs.not_published_tag')} color={r.latest_version ? c.lime : c.violetSoft} /></View>
      <T size={13} color={c.mute} style={{ marginTop: 6 }}>{snap.disclosure}</T>
      {prev.data.needs_ai_review ? <Card pad={10} color={c.cyanSoft} style={{ marginTop: 8 }}><T size={12} weight="700">{t('cs.ai_started')}</T><T size={12} color={c.mute}>{t('cs.ai_read_first')}</T></Card> : null}
      <Section title={t('cs.preview')}>
        <ReportSections sections={snap.sections} cards />
        {!snap.sections.length ? <T size={13} color={c.mute}>{t('cs.nothing_selected')}</T> : null}
      </Section>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Btn title={t('cs.publish_v', { n: prev.data.next_version })} loading={busy} onPress={() => (prev.data.needs_ai_review ? setSure(true) : act(async () => { const v = await api.post(`/coaching/reports/${id}/publish`, { row_version: r.row_version }); if (v.unchanged) throw new Error(t('cs.unchanged')); }, t('cs.published')))} />
        {r.latest_version ? <Btn title={t('cs.make_pdf')} color={c.paper} ink={c.ink} loading={busy} onPress={() => act(async () => {
          const d = await api.post('/branded-documents/coaching-report', { report_id: id });
          if (typeof window !== 'undefined' && window.open) { const url = URL.createObjectURL(await api.download(`/branded-documents/${d.id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); }
        }, t('cs.pdf_ready'))} /> : null}
      </View>
      {r.latest_version && r.audience === 'organisation' ? <ReportShares report={r} /> : null}
      {r.versions.length ? <Section title={t('cs.published_versions')}>{r.versions.map((v) => <Row key={v.version} title={t('cs.version_n', { n: v.version })} sub={t('cs.version_line', { when: dateTimeIn(v.published_at, tz), aud: AUD.find(([x]) => x === v.audience)[1] })} />)}</Section> : null}
      <FormSheet visible={sure} onClose={() => setSure(false)} title={t('cs.publish_ai_q')} submitLabel={t('cs.publish_read')} fields={[]}
        onSubmit={async () => { await api.post(`/coaching/reports/${id}/publish`, { row_version: r.row_version, confirm_reviewed: true }); setSure(false); toast(t('cs.published')); rep.reload(); prev.reload(); }} />
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
      <T size={13} color={c.mute}>{t('cs.view_line', { subject: s.subject, from: s.period.from, to: s.period.to, coach: s.coach_name, v: v.data.version })}</T>
      <ReportSections sections={s.sections} />
    </Screen>
  );
}

// Match preparation and debrief over the canonical fixture: the fixture, its official result and its events are only read; everything
// the coach writes (opponent notes, checklist, objectives, bookmarks, the review) lives in the coaching session record opened for it.
const OUTCOME = { met: t('cs.out_met'), not_met: t('cs.out_not_met'), pending: t('cs.out_pending'), coach_judged: t('cs.out_coach') };
const METRICS = [['', t('cs.mt_none')], ['score_for', t('cs.mt_for')], ['score_against', t('cs.mt_against')], ['goal_difference', t('cs.mt_diff')], ['clean_sheet', t('cs.mt_clean')], ['events', t('cs.mt_events')]];

export function CoachMatch({ fixture_id, team_id }) {
  const { push } = useNav();
  const { toast } = useSession();
  const ctx = useLoad(() => api.get(`/coaching/fixtures/${fixture_id}?team_id=${team_id}`), [fixture_id, team_id]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  if (ctx.loading && !ctx.data) return <Screen><Loading /></Screen>;
  if (ctx.error) return <Screen><ErrorBox error={ctx.error} onRetry={ctx.reload} /></Screen>;
  const m = ctx.data, f = m.fixture, prep = m.prep;
  const record = async () => m.session_record ?? api.post('/coaching/sessions', { source_type: 'fixture', source_id: fixture_id, team_id });
  const open = async () => { setBusy(true); try { push('CoachSession', { id: (await record()).id }); } catch (e) { toast(e.message); } setBusy(false); };
  const savePrep = async (next) => { const r = await record(); await api.post(`/coaching/sessions/${r.id}/match-prep`, { opponent_notes: next.opponent_notes, checklist: next.checklist, objectives: next.objectives.map((o) => ({ id: o.id, text: o.text, indicator: o.indicator })), expected_version: prep?.row_version }); ctx.reload(); };
  const tick = async (it) => { try { await savePrep({ opponent_notes: prep.opponent_notes, objectives: prep.objectives, checklist: prep.checklist.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) }); } catch (e) { toast(e.message); } };
  const mark = async (ev) => { try { const r = await record(); await api.post(`/coaching/sessions/${r.id}/event-bookmarks`, { match_event_id: ev.id, remove: ev.bookmarked }); ctx.reload(); } catch (e) { toast(e.message); } };
  const init = { opponent_notes: prep?.opponent_notes ?? '' };
  (prep?.checklist ?? []).slice(0, 6).forEach((x, n) => { init[`c${n + 1}`] = x.text; });
  (prep?.objectives ?? []).slice(0, 3).forEach((o, n) => { init[`o${n + 1}`] = o.text; init[`m${n + 1}`] = o.indicator?.metric ?? ''; init[`k${n + 1}`] = o.indicator?.kind; init[`cmp${n + 1}`] = o.indicator?.comparator ?? 'gte'; init[`t${n + 1}`] = o.indicator?.target ?? 1; });
  return (
    <Screen onRefresh={ctx.reload}>
      <T size={12} weight="700" color={c.pink} style={{ letterSpacing: 1.2 }}>{t('cs.match_tag')}</T>
      <H1>{t('cs.match_title', { home: f.home, away: f.away })}</H1>
      <T size={13} color={c.mute}>{t('cs.match_meta', { event: f.event, round: f.round ? ` · ${f.round}` : '', when: dateTimeIn(f.scheduled_at, tz), side: tEnum(f.you_are) })}</T>
      {f.official_result ? <Card pad={12} color={c.cyanSoft} style={{ marginTop: 8 }}><T weight="800">{t('cs.official_result', { home: f.official_result.home_score, away: f.official_result.away_score })}</T><T size={12} color={c.mute}>{t('cs.official_note')}</T></Card> : f.played ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('cs.match_over')}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Btn title={m.session_record ? t('cs.open_record') : t('cs.start_prep')} loading={busy} onPress={open} />
        <Btn title={prep ? t('cs.edit_prep') : t('cs.add_prep')} color={c.paper} ink={c.ink} onPress={() => setEditing(true)} />
        {m.session_record && f.played ? <Btn title={t('cs.debrief_ai')} color={c.paper} ink={c.ink} onPress={() => push('CoachCopilot', { task: 'match_debrief', session_record_id: m.session_record.id, team_id })} /> : null}
      </View>
      {prep?.opponent_notes ? <Section title={t('cs.opponent')}><Card pad={12}><T size={13}>{prep.opponent_notes}</T></Card></Section> : null}
      {prep?.checklist?.length ? <Section title={t('cs.checklist')}>{prep.checklist.map((it) => <Row key={it.id} title={`${it.done ? '☑' : '☐'} ${it.text}`} onPress={() => tick(it)} />)}</Section> : null}
      {prep?.objectives?.length ? <Section title={t('cs.objectives')}>{prep.objectives.map((o) => <Row key={o.id} title={o.text} sub={o.indicator ? `${METRICS.find(([k]) => k === o.indicator.metric)?.[1]}${o.indicator.kind ? ` (${o.indicator.kind})` : ''} ${({ gte: t('cs.cmp_gte'), lte: t('cs.cmp_lte'), eq: t('cs.cmp_eq') })[o.indicator.comparator].toLowerCase()} ${o.indicator.target}${o.actual != null ? ` · ${t('cs.actual_official', { n: o.actual })}` : ''}` : t('cs.judged_you')} right={<Tag label={OUTCOME[o.outcome]} color={o.outcome === 'met' ? c.lime : c.violetSoft} />} />)}</Section> : null}
      <Section title={t('cs.squad')}>
        {m.squad.map((p) => <Row key={p.id} title={p.display_name} sub={`${p.position ? `${p.position} · ` : ''}${p.availability ? tEnum(p.availability) : t('cs.no_answer')}${p.availability_note ? ` · ${p.availability_note}` : ''}`} />)}
      </Section>
      <Section title={t('cs.active_goals')}>{!m.goals.length ? <T size={13} color={c.mute}>{t('cs.none')}</T> : m.goals.map((g) => <Row key={g.id} title={g.title} sub={label(g.category)} />)}</Section>
      <Section title={t('cs.open_actions')}>{!m.actions.length ? <T size={13} color={c.mute}>{t('cs.none')}</T> : m.actions.map((a) => <Row key={a.id} title={a.title} sub={a.due_at ? t('cs.due_part', { when: dateTimeIn(a.due_at, tz) }) : t('cs.no_due')} />)}</Section>
      {m.official_events.length ? <Section title={t('cs.official_events')}>{m.official_events.map((e) => <Row key={e.id} title={`${e.clock_seconds != null ? `${Math.floor(e.clock_seconds / 60)}' ` : ''}${label(e.kind)}${e.player_name ? ` · ${e.player_name}` : ''}`} sub={t('cs.official_record')} right={<Chip label={e.bookmarked ? t('cs.bookmarked') : t('cs.bookmark')} active={e.bookmarked} onPress={() => mark(e)} />} />)}</Section> : null}
      <FormSheet visible={editing} onClose={() => setEditing(false)} title={t('cs.match_prep')} submitLabel={t('common.save')} initial={init}
        fields={[
          { key: 'opponent_notes', label: t('cs.opp_notes'), type: 'multiline', optional: true },
          ...[1, 2, 3, 4, 5, 6].map((k) => ({ key: `c${k}`, label: k === 1 ? t('cs.checklist_first') : t('cs.checklist_item', { k }), optional: true })),
          ...[1, 2, 3].flatMap((k) => [
            { key: `o${k}`, label: t('cs.objective_k', { k }), optional: true },
            { key: `m${k}`, label: t('cs.how_measure'), type: 'chips', options: METRICS.map(([value, lab]) => ({ value, label: lab })), default: '', show: (v) => !!v[`o${k}`] },
            { key: `k${k}`, label: t('cs.which_event'), optional: true, placeholder: t('cs.event_ph'), show: (v) => v[`m${k}`] === 'events' },
            { key: `cmp${k}`, label: t('cs.target'), type: 'chips', options: [{ value: 'gte', label: t('cs.cmp_gte') }, { value: 'lte', label: t('cs.cmp_lte') }, { value: 'eq', label: t('cs.cmp_eq') }], default: 'gte', show: (v) => !!v[`m${k}`] },
            { key: `t${k}`, label: t('cs.number'), type: 'stepper', min: 0, max: 50, step: 1, default: 1, show: (v) => !!v[`m${k}`] },
          ]),
        ]}
        onSubmit={async (v) => {
          const old = prep?.checklist ?? [], oldO = prep?.objectives ?? [];
          await savePrep({
            opponent_notes: v.opponent_notes || undefined,
            checklist: [1, 2, 3, 4, 5, 6].filter((k) => v[`c${k}`]).map((k) => ({ id: old[k - 1]?.id, text: v[`c${k}`], done: old[k - 1]?.text === v[`c${k}`] ? old[k - 1].done : false })),
            objectives: [1, 2, 3].filter((k) => v[`o${k}`]).map((k) => ({ id: oldO[k - 1]?.id, text: v[`o${k}`], indicator: v[`m${k}`] ? { metric: v[`m${k}`], kind: v[`m${k}`] === 'events' ? v[`k${k}`] : undefined, comparator: v[`cmp${k}`] ?? 'gte', target: v[`t${k}`] ?? 1 } : undefined })),
          });
          setEditing(false); toast(t('cs.prep_saved'));
        }} />
    </Screen>
  );
}

// Capture helpers: pick a photo/video/PDF as evidence, or an audio file for speech-to-text. Files go to the private, encrypted store;
// a transcript is only ever a draft you read and edit before it becomes a note.
async function pickFile(accept, { media } = {}) {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.onchange = () => resolve(input.files?.[0] ? { blob: input.files[0], name: input.files[0].name } : null);
      input.click();
    });
  }
  if (media === 'audio') {
    const DocumentPicker = await import('expo-document-picker');
    const r = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (r.canceled || !r.assets?.[0]) return null;
    return { blob: await (await fetch(r.assets[0].uri)).blob(), name: r.assets[0].name };
  }
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 });
  if (r.canceled || !r.assets?.[0]) return null;
  return { blob: await (await fetch(r.assets[0].uri)).blob(), name: r.assets[0].fileName };
}
const EVIDENCE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf';

/** Files on one note: add (author only), open, hide. Rendered inside the session screen under each note. */
function EvidenceRow({ obs, mine, toast }) {
  const list = useLoad(() => api.get(`/coaching/observations/${obs.id}/evidence`), [obs.id]);
  const add = async () => {
    const f = await pickFile(EVIDENCE_ACCEPT);
    if (!f) return;
    try { await api.upload(`/coaching/observations/${obs.id}/evidence`, f.blob, { title: (f.name ?? '').slice(0, 120) }); toast(t('cs.file_attached')); list.reload(); } catch (e) { toast(e.message); }
  };
  const open = async (e) => { try { if (Platform.OS === 'web') { const url = URL.createObjectURL(await api.download(`/coaching/evidence/${e.id}/file`)); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000); } else toast(t('cs.open_on_web')); } catch (err) { toast(err.message); } };
  return (
    <HScroll>
      {(list.data ?? []).map((e) => <Chip key={e.id} label={`${e.kind === 'photo' ? t('cs.ev_photo') : e.kind === 'video' ? t('cs.ev_video') : 'PDF'}${e.title ? `: ${e.title.slice(0, 18)}` : ''}`} onPress={() => open(e)} />)}
      {mine ? <Chip label={t('cs.attach_file')} onPress={add} /> : null}
    </HScroll>
  );
}

/** Speak or record on your phone, pick the audio here, read the text it becomes, fix it, then save it as a note. */
function VoiceSheet({ visible, onClose, w, onSaved }) {
  const { toast } = useSession();
  const opts_ = useLoad(() => api.get('/coaching/capture-options'), []);
  const [draft, setDraft] = useState(null);
  const s = w.session;
  const available = opts_.data?.voice_note?.available;
  const choose = async () => {
    const f = await pickFile('audio/*', { media: 'audio' });
    if (!f) return;
    try { setDraft((await api.postRaw('/coaching/voice-note', f.blob)).transcript); } catch (e) { toast(e.message); }
  };
  return (
    <>
      <Sheet visible={visible && draft == null} onClose={onClose} title={t('cs.voice_note')}>
        {!available ? <T size={13} color={c.mute}>{opts_.data?.voice_note?.reason ?? t('cs.checking')}</T> : (
          <>
            <T size={13} color={c.mute}>{opts_.data.voice_note.note}</T>
            <View style={{ marginTop: 10 }}><Btn title={t('cs.choose_recording')} onPress={choose} /></View>
          </>
        )}
      </Sheet>
      <FormSheet visible={visible && draft != null} onClose={() => { setDraft(null); onClose(); }} title={t('cs.check_text')} submitLabel={t('cs.save_as_note')} initial={{ note: draft ?? '' }}
        fields={[{ key: 'note', label: t('cs.edit_before'), type: 'multiline' }, { key: 'visibility', label: t('cs.who_sees'), type: 'chips', options: VISIBILITY.filter(([v]) => v !== 'player' && v !== 'team').map(([value, lab]) => ({ value, label: lab })), default: 'coach_private' }]}
        onSubmit={async (v) => { const r = await send('/coaching/observations', { session_record_id: s.id, team_id: s.team_id ?? undefined, note: v.note, visibility: v.visibility === 'staff' && !s.team_id ? 'coach_private' : v.visibility, client_key: keyOf() }); setDraft(null); onSaved(r); }} />
    </>
  );
}

// The quick note: free text only for what was seen; everything else is a control. Rubric scores use the rubric's own scale and are
// offered only for rubrics that apply to this player's sport and position.
function NoteSheet({ note, onClose, w, rubrics, goals, onSaved }) {
  const s = w.session;
  const player = note?.athlete_id ? w.participants.find((p) => p.id === note.athlete_id) : null;
  const usable = rubrics.filter((r) => !player || !r.positions?.length || r.positions.some((x) => x.toLowerCase() === (player.position ?? '').toLowerCase()));
  const subject = goals.filter((g) => ['planned', 'active', 'paused'].includes(g.status) && (note?.athlete_id ? g.athlete_id === note.athlete_id : g.team_id === s.team_id && !g.athlete_id));
  const dims = (r) => r.dimensions;
  const fields = [
    { key: 'note', label: t('cs.what_saw'), type: 'multiline' },
    { key: 'obs_type', label: t('access.type'), type: 'chips', options: opts(OBS_TYPES), default: 'general' },
    { key: 'skill_tag', label: t('cs.skill'), optional: true, placeholder: t('cs.skill_tag_ph') },
    ...(usable.length && note?.athlete_id ? [{ key: 'rubric', label: t('cs.score_rubric'), type: 'chips', optional: true, options: usable.map((r) => ({ value: r.id, label: r.name })) }] : []),
    ...usable.flatMap((r) => [
      { key: `dim_${r.id}`, label: t('cs.which_dim'), type: 'chips', options: dims(r).map((d) => ({ value: d.key, label: d.name })), default: dims(r)[0].key, show: (v) => v.rubric === r.id },
      ...dims(r).map((d) => ({ key: `score_${r.id}_${d.key}`, label: `${d.name} (${d.scale_min}–${d.scale_max}${d.unit ? ` ${d.unit}` : ''})`, type: 'stepper', min: d.scale_min, max: d.scale_max, step: 1, default: Math.round((d.scale_min + d.scale_max) / 2), show: (v) => v.rubric === r.id && (v[`dim_${r.id}`] ?? dims(r)[0].key) === d.key })),
    ]),
    ...(subject.length ? [{ key: 'goals', label: t('cs.goal_evidence'), type: 'multi', optional: true, options: subject.map((g) => ({ value: g.id, label: g.title })) }] : []),
    { key: 'visibility', label: t('cs.who_sees'), type: 'chips', options: VISIBILITY.filter(([v]) => (note?.athlete_id ? v !== 'team' : v !== 'player')).map(([value, lab]) => ({ value, label: lab })), default: 'coach_private' },
    { key: 'follow_up', label: t('cs.follow_next'), type: 'switch', default: false },
    { key: 'make_action', label: t('cs.also_action'), type: 'switch', default: false },
    { key: 'action_title', label: t('cs.action_label'), optional: true, show: (v) => !!v.make_action },
    { key: 'action_due', label: t('cs.due_short'), type: 'date', optional: true, show: (v) => !!v.make_action },
  ];
  return (
    <FormSheet visible={!!note} onClose={onClose} title={player ? t('cs.note_for', { name: player.display_name }) : t('cs.team_note')} submitLabel={t('cs.save_note')} fields={fields}
      onSubmit={async (v) => {
        const visibility = v.visibility === 'staff' && !s.team_id ? 'coach_private' : v.visibility;
        const rubric = v.rubric ? usable.find((r) => r.id === v.rubric) : null;
        const dim = rubric ? v[`dim_${rubric.id}`] ?? dims(rubric)[0].key : null;
        const r = await send('/coaching/observations', {
          session_record_id: s.id, athlete_id: note.athlete_id, team_id: note.athlete_id && visibility !== 'staff' ? undefined : s.team_id ?? undefined, note: v.note, obs_type: v.obs_type, skill_tag: v.skill_tag || undefined, visibility, follow_up: !!v.follow_up, client_key: keyOf(),
          goal_ids: v.goals?.length ? v.goals : undefined, ...(rubric ? { rubric_id: rubric.id, dimension_key: dim, score: v[`score_${rubric.id}_${dim}`] } : {}),
        });
        if (v.make_action && v.action_title) await send('/coaching/actions', { athlete_id: note.athlete_id, team_id: note.athlete_id ? undefined : s.team_id, session_record_id: s.id, title: v.action_title, due_at: v.action_due ? localToIso(v.action_due, '18:00', tz) : undefined, follow_up_next_session: true, client_key: keyOf() });
        onSaved(r);
      }} />
  );
}

// Programmes: a season / term / block that goals hang from.
export function CoachProgrammes({ athlete_id, team_id, name }) {
  const { push } = useNav();
  const { toast } = useSession();
  const q = athlete_id ? `athlete_id=${athlete_id}` : `team_id=${team_id}`;
  const list = useLoad(() => api.get(`/coaching/programmes?${q}`), [q]);
  const positions = useLoad(() => api.get(`/coaching/positions${team_id ? `?team_id=${team_id}` : ''}`), [team_id]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const detail = useLoad(() => (open ? api.get(`/coaching/programmes/${open.id}`) : Promise.resolve(null)), [open?.id]);
  return (
    <Screen onRefresh={list.reload}>
      <H1>{name ? t('cs.programmes_named', { name }) : t('nav.title.CoachProgrammes')}</H1>
      <T size={13} color={c.mute}>{t('cs.prog_help')}</T>
      <View style={{ marginTop: 10 }}><Btn small title={t('cs.new_programme')} onPress={() => setCreating(true)} /></View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty emoji="🗓️" title={t('cs.no_programmes')} sub={t('cs.no_programmes_sub')} /> :
        list.data.map((p) => <Row key={p.id} title={p.title} sub={t('cs.prog_line', { kind: label(p.kind), from: String(p.starts_on).slice(0, 10), to: String(p.ends_on).slice(0, 10), done: p.goals_achieved, total: p.goals, pos: p.position ? ` · ${p.position}` : '' })} right={<Status s={p.status} />} onPress={() => setOpen(p)} />)}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open?.title ?? ''}>
        {detail.loading || !detail.data ? <Loading /> : (
          <>
            <T size={13}>{detail.data.programme.objective}</T>
            <T size={12} color={c.mute}>{t('cs.prog_summary', { held: detail.data.summary.sessions_held, reviewed: detail.data.summary.sessions_reviewed, open: detail.data.summary.open_actions, next: detail.data.summary.next_review ? ` ${t('cs.next_review_part', { date: String(detail.data.summary.next_review).slice(0, 10) })}` : '' })}</T>
            {detail.data.goals.map((g) => <Row key={g.id} title={g.title} sub={`${label(g.category)} · ${g.evidence_count}`} right={<Status s={g.status} />} />)}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Btn small title={t('cs.goals')} onPress={() => { setOpen(null); push('CoachGoals', athlete_id ? { athlete_id, name, programme_id: open.id } : { team_id, programme_id: open.id }); }} />
              {open.status !== 'completed' ? <Btn small title={t('cs.mark_completed')} color={c.paper} ink={c.ink} onPress={async () => { try { await api.patch(`/coaching/programmes/${open.id}`, { row_version: open.row_version, status: 'completed' }); setOpen(null); list.reload(); } catch (e) { toast(e.message); } }} /> : null}
            </View>
          </>
        )}
      </Sheet>
      <FormSheet visible={creating} onClose={() => setCreating(false)} title={t('cs.new_programme')} submitLabel={t('cs.create')}
        fields={[
          { key: 'title', label: t('access.name') },
          { key: 'kind', label: t('cs.kind'), type: 'chips', options: opts(['season', 'term', 'block', 'programme']), default: 'season' },
          { key: 'starts_on', toKey: 'ends_on', label: t('cs.dates'), type: 'daterange' },
          { key: 'objective', label: t('cs.objective'), type: 'multiline', optional: true },
          ...(positions.data?.length ? [{ key: 'position', label: t('cs.position'), type: 'chips', optional: true, options: positions.data.map((p) => ({ value: p, label: p })) }] : []),
          { key: 'review_cadence_days', label: t('cs.review_every'), type: 'stepper', min: 7, max: 90, step: 7, default: 14, optional: true },
          { key: 'athlete_text', label: t('cs.athlete_text'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => { await api.post('/coaching/programmes', { athlete_id, team_id, title: v.title, kind: v.kind, starts_on: v.starts_on, ends_on: v.ends_on, objective: v.objective || undefined, position: v.position || undefined, review_cadence_days: v.review_cadence_days || undefined, athlete_text: v.athlete_text || undefined }); setCreating(false); toast(t('cs.programme_created')); list.reload(); }} />
    </Screen>
  );
}

// Rubrics are the coach's evaluation sheets: the editor (pillars, weights, anchors, targets) lives in evaluation-sheets.js, one place for sheets.
export { CoachRubrics } from './evaluation-sheets';

// Saved player groups (issue #580): reusable, named sets of people you already coach. Putting one on a session fills the roster and creates the
// session's named group in one tap; the server re-checks every person's current relationship each time.
export function CoachGroups() {
  const { toast } = useSession();
  const { tablet: wide } = useLayout();
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get(`/coaching/groups${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`), [q]);
  const athletes = useLoad(() => api.get('/coach/athletes'), []);
  const coach = useLoad(() => api.get('/coach/home'), []);
  const [form, setForm] = useState(null);   // null | 'new' | a group being edited
  const edit = form && form !== 'new' ? form : null;
  const teams = coach.data?.teams ?? [];
  const save = async (v) => {
    try {
      await api.post('/coaching/groups', { id: edit?.id, row_version: edit?.row_version, name: v.name, team_id: v.team_id || null, sport: v.sport || null, athlete_ids: v.athlete_ids });
    } catch (e) { if (/changed elsewhere/i.test(e.message)) list.reload(); throw e; }
    toast(edit ? t('cs.group_saved') : t('cs.group_created')); list.reload();
  };
  return (
    <Screen onRefresh={list.reload}>
      <H1>{t('nav.title.CoachGroups')}</H1>
      <T size={13} color={c.mute}>{t('cs.groups_help')}</T>
      <View style={{ marginTop: 10, gap: 10 }}>
        <Btn small title={t('cs.new_group')} onPress={() => setForm('new')} accessibilityLabel={t('cs.create_group_a11y')} style={{ alignSelf: 'flex-start' }} />
        <Field label={t('cs.search_groups')} value={q} onChangeText={setQ} placeholder={t('cs.group_name')} />
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? (
        <Empty emoji="👥" title={q ? t('cs.no_group_match') : t('cs.no_groups')} sub={q ? t('cs.try_other') : athletes.data?.length ? t('cs.groups_empty_a') : t('cs.groups_empty_b')} />
      ) : (
        <View style={{ flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap', gap: 10 }}>
          {list.data.map((g) => (
            <View key={g.id} style={{ width: wide ? '48.8%' : '100%' }}>
              <Row title={g.name} onPress={() => setForm(g)}
                sub={`${t(g.member_count === 1 ? 'cs.players_one' : 'cs.players_many', { n: g.member_count })}${g.team_name ? ` · ${g.team_name}` : ''}${g.sport ? ` · ${g.sport}` : ''}${g.members.some((m) => !m.current) ? ` · ${t('cs.some_gone')}` : ''}`} />
            </View>))}
        </View>
      )}
      <FormSheet visible={!!form} onClose={() => setForm(null)} title={edit ? t('cs.edit_group') : t('cs.new_group')} submitLabel={edit ? t('common.save') : t('cs.create')}
        initial={edit ? { name: edit.name, team_id: edit.team_id, sport: edit.sport_slug, athlete_ids: edit.members.map((m) => m.id) } : {}}
        fields={[
          { key: 'name', label: t('cs.group_name'), placeholder: t('cs.ph_defenders') },
          { key: 'athlete_ids', label: t('cs.players'), type: 'multimenu', options: (athletes.data ?? []).map((a) => ({ value: a.id, label: a.display_name })), placeholder: t('cs.choose_players') },
          ...(teams.length ? [{ key: 'team_id', label: t('addr.scope_team'), type: 'chips', optional: true, options: teams.map((tm) => ({ value: tm.id, label: tm.name })), hint: t('cs.team_group_hint') }] : []),
          { key: 'sport', label: t('cs.sport'), type: 'sport', optional: true },
        ]}
        onSubmit={save} />
    </Screen>
  );
}

const SKILL_TAGS = ['passing', 'receiving', 'shooting', 'defending', 'footwork', 'speed and agility', 'strength', 'endurance', 'set plays', 'decision making', 'communication', 'game awareness', 'mental routine', 'technique'];

/** The drill library: your reusable blocks (and those shared with a team or organisation you coach for), searchable by word, sport and skill. */
export function CoachDrills() {
  const { toast } = useSession();
  const { tablet: wide } = useLayout();
  const [flt, setFlt] = useState({ q: '', sport: '', tag: '' });
  const qs = Object.entries({ scope: 'block', q: flt.q.trim(), sport: flt.sport, tag: flt.tag }).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const list = useLoad(() => api.get(`/coach/templates?${qs}&limit=60`), [qs]);
  const all = useLoad(() => api.get('/coach/templates?scope=block&limit=100'), []); // what filters can offer
  const coach = useLoad(() => api.get('/coach/home'), []);
  const [form, setForm] = useState(false), [open, setOpen] = useState(null);
  const sportOpts = [{ value: '', label: t('cs.all_sports') }, ...[...new Map((all.data ?? []).filter((x) => x.sport_slug).map((x) => [x.sport_slug, x.sport_name ?? x.sport_slug])).entries()].map(([value, name]) => ({ value, label: label(name.replace(/-/g, ' ')) }))];
  const tagOpts = [...new Set((all.data ?? []).flatMap((x) => x.blocks.flatMap((b) => b.tags ?? [])).map((x) => x.toLowerCase()))].sort();
  const teams = coach.data?.teams ?? [];
  const share = async (tpl, v) => {
    await api.post(`/coaching/templates/${tpl.id}/share`, { id: tpl.id, with: v.with, team_id: v.with === 'team' ? v.team_id : undefined });
    toast(v.with === 'private' ? t('cs.only_you_drill') : t('cs.shared_coaches')); setOpen(null); list.reload(); all.reload();
  };
  return (
    <Screen onRefresh={() => { list.reload(); all.reload(); }}>
      <H1>{t('nav.title.CoachDrills')}</H1>
      <T size={13} color={c.mute}>{t('cs.drills_help')}</T>
      <View style={{ marginTop: 10, gap: 10 }}>
        <Btn small title={t('cs.new_drill')} onPress={() => setForm(true)} accessibilityLabel={t('cs.create_drill_a11y')} style={{ alignSelf: 'flex-start' }} />
        <Field label={t('cs.search_drills')} value={flt.q} onChangeText={(q) => setFlt({ ...flt, q })} placeholder={t('cs.drill_search_ph')} />
        <MenuField label={t('cs.sport')} value={flt.sport} onChange={(sport) => setFlt({ ...flt, sport })} options={sportOpts} placeholder={t('cs.all_sports')} />
        {tagOpts.length ? (
          <Chips wide={wide}>
            <Chip label={t('cs.any_skill')} active={!flt.tag} onPress={() => setFlt({ ...flt, tag: '' })} />
            {tagOpts.map((tg) => <Chip key={tg} label={label(tg)} active={flt.tag === tg} onPress={() => setFlt({ ...flt, tag: flt.tag === tg ? '' : tg })} />)}
          </Chips>) : null}
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? (
        <Empty emoji="🧰" title={qs.replace('scope=block', '').replace(/^&|&$/g, '') ? t('cs.no_drill_match') : t('cs.drills_empty')} sub={t('cs.drills_empty_sub')} />
      ) : (
        <View style={{ flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap', gap: 10 }}>
          {list.data.map((tpl) => {
            const b = tpl.blocks[0] ?? {};
            return (
              <View key={tpl.id} style={{ width: wide ? '48.8%' : '100%' }}>
                <Row title={tpl.title} onPress={() => setOpen(tpl)}
                  sub={[label(b.kind ?? 'skill_drill'), b.duration_min ? t('cs.min', { n: b.duration_min }) : null, tpl.sport_slug ? label(tpl.sport_slug.replace(/-/g, ' ')) : null, ...(b.tags ?? []).slice(0, 2).map(label), tpl.mine ? (tpl.shared_team_id ? t('cs.shared_team_part') : null) : t('cs.shared_by', { name: tpl.shared_by })].filter(Boolean).join(' · ')} />
              </View>);
          })}
        </View>
      )}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('cs.new_drill')} submitLabel={t('cs.save_drill')}
        fields={[
          { key: 'title', label: t('cs.drill_name') },
          { key: 'sport', label: t('cs.sport'), type: 'sport', optional: true, hint: t('cs.sport_hint') },
          { key: 'kind', label: t('access.type'), type: 'chips', options: opts(BLOCK_KINDS), default: 'skill_drill' },
          { key: 'duration_min', label: t('cs.minutes'), type: 'stepper', min: 1, max: 240, step: 5, default: 10 },
          { key: 'tags', label: t('cs.skills'), type: 'multimenu', optional: true, options: SKILL_TAGS.map((tg) => ({ value: tg, label: label(tg) })), max: 10 },
          { key: 'objective', label: t('cs.objective'), optional: true },
          { key: 'instructions', label: t('cs.how_runs'), type: 'multiline', optional: true },
          { key: 'setup', label: t('cs.setup_equipment'), optional: true },
          { key: 'cue', label: t('cs.coaching_cue'), optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post('/coaching/templates', { title: v.title, scope: 'block', sport: v.sport || undefined, blocks: [{ kind: v.kind, title: v.title, duration_min: v.duration_min, objective: v.objective || undefined, instructions: v.instructions || undefined, setup: v.setup || undefined, cues: v.cue ? [v.cue] : [], tags: v.tags ?? [] }] });
          toast(t('cs.drill_saved')); list.reload(); all.reload();
        }} />
      <Sheet visible={!!open && !open.sharing} onClose={() => setOpen(null)} title={open?.title ?? ''}>
        {open ? (() => {
          const b = open.blocks[0] ?? {};
          return (
            <View style={{ gap: 8 }}>
              <T size={12} color={c.mute}>{[label(b.kind ?? 'skill_drill'), b.duration_min ? t('cs.min', { n: b.duration_min }) : null, t('cs.version_lc', { n: open.version })].filter(Boolean).join(' · ')}</T>
              {b.objective ? <T size={14}><T weight="700" size={14}>{t('cs.obj_prefix')} </T>{b.objective}</T> : null}
              {b.instructions ? <T size={14}>{b.instructions}</T> : null}
              {b.setup ? <T size={13} color={c.mute}>{t('cs.setup_line', { x: b.setup })}</T> : null}
              {b.cues?.length ? <T size={13}>{t('cs.cues', { cues: b.cues.join(' · ') })}</T> : null}
              {b.tags?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{b.tags.map((tg) => <Tag key={tg} label={label(tg)} color={c.violetSoft} />)}</View> : null}
              {open.mine ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  {teams.length ? <Btn small title={open.shared_team_id ? t('cs.stop_sharing') : t('cs.share_team')} color={c.paper} ink={c.ink} onPress={() => (open.shared_team_id ? share(open, { with: 'private' }).catch((e) => toast(e.message)) : setOpen({ ...open, sharing: true }))} /> : null}
                  <Btn small title={t('access.archive')} color={c.paper} ink={c.ink} onPress={async () => { try { await api.del(`/coach/templates/${open.id}`); toast(t('cs.drill_archived')); setOpen(null); list.reload(); all.reload(); } catch (e) { toast(e.message); } }} />
                </View>) : <T size={12} color={c.mute}>{t('cs.shared_with_you', { name: open.shared_by })}</T>}
            </View>);
        })() : null}
      </Sheet>
      <FormSheet visible={!!open?.sharing} onClose={() => setOpen({ ...open, sharing: false })} title={t('cs.share_team')} submitLabel={t('cs.share')}
        fields={[{ key: 'team_id', label: t('cs.team_you_coach'), type: 'chips', options: teams.map((tm) => ({ value: tm.id, label: tm.name })) }]}
        onSubmit={async (v) => share(open, { with: 'team', team_id: v.team_id })} />
    </Screen>
  );
}

// Less-used session tools, kept off the main field screen: groups, templates, cloning, delegation and per-player summaries.
function MoreSheet({ more, setMore, w, reload }) {
  const { toast } = useSession();
  const { push } = useNav();
  const s = w.session;
  const saved = useLoad(() => (more === 'saved' ? api.get('/coaching/groups') : Promise.resolve([])), [more === 'saved']);
  const tpls = useLoad(() => (more === 'use' ? api.get('/coach/templates?scope=session') : Promise.resolve([])), [more === 'use']);
  const roster = useLoad(() => (more === 'help' && s.team_id ? api.get(`/coach/teams/${s.team_id}/roster`) : Promise.resolve(null)), [more === 'help']);
  const close = () => setMore(null);
  const players = w.participants.map((p) => ({ value: p.id, label: p.display_name }));
  const call = (fn, msg) => async (v) => { await fn(v); close(); toast(msg); reload(); };
  return (
    <>
      <Sheet visible={more === 'menu'} onClose={close} title={t('cs.session_tools')}>
        {[
          [t('cs.use_saved_group'), 'saved', s.status !== 'completed'],
          [t('cs.split_groups'), 'groups', s.status !== 'completed' && s.team_id],
          [t('cs.save_plan_template'), 'template', w.plan.blocks.length > 0], [t('cs.use_template'), 'use', s.status !== 'completed'],
          [t('cs.clone_session'), 'clone', true], [t('cs.coach_help'), 'help', s.team_id && w.you_are === 'owner'],
        ].filter(([, , show]) => show).map(([label_, key]) => <Row key={key} title={label_} onPress={() => setMore(key)} />)}
        {w.delegates?.length ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>{t('cs.helping', { list: w.delegates.map((d) => `${d.display_name} (${d.permissions.map(label).join(', ')})`).join('; ') })}</T> : null}
        <View style={{ marginTop: 10 }}><Btn small title={t('cs.team_notes_btn')} color={c.paper} ink={c.ink} onPress={() => { close(); push('CoachReports', { team_id: s.team_id }); }} disabled={!s.team_id} /></View>
      </Sheet>
      <Sheet visible={more === 'saved'} onClose={close} title={t('cs.use_saved_group')}>
        {saved.loading ? <Loading /> : !saved.data?.length ? (
          <View style={{ gap: 8 }}><T size={13} color={c.mute}>{t('cs.no_saved_groups')}</T><Btn small title={t('cs.create_group')} onPress={() => { close(); push('CoachGroups'); }} /></View>
        ) : saved.data.map((g) => (
          <Row key={g.id} title={g.name} sub={`${t(g.member_count === 1 ? 'cs.players_one' : 'cs.players_many', { n: g.member_count })}${g.team_name ? ` · ${g.team_name}` : ''}`}
            onPress={async () => { try { const r = await api.post(`/coaching/sessions/${s.id}/use-group`, { group_id: g.id }); close(); toast(`${t('cs.on_roster', { n: r.added })}${r.skipped ? t('cs.skipped_part', { n: r.skipped }) : ''}`); reload(); } catch (e) { toast(e.message); } }} />))}
      </Sheet>
      <FormSheet visible={more === 'groups'} onClose={close} title={t('cs.groups_title')} submitLabel={t('cs.save_groups')} initial={{ n1: s.groups?.[0]?.name, m1: s.groups?.[0]?.athlete_ids, n2: s.groups?.[1]?.name, m2: s.groups?.[1]?.athlete_ids, n3: s.groups?.[2]?.name, m3: s.groups?.[2]?.athlete_ids }}
        fields={[1, 2, 3].flatMap((k) => [{ key: `n${k}`, label: t('cs.group_k_name', { k }), optional: true, placeholder: k === 1 ? t('cs.ph_defenders') : undefined }, { key: `m${k}`, label: t('cs.group_k_players', { k }), type: 'multi', options: players, optional: true }])}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/groups`, { groups: [1, 2, 3].filter((k) => v[`n${k}`] && v[`m${k}`]?.length).map((k) => ({ name: v[`n${k}`], athlete_ids: v[`m${k}`] })) }), t('cs.groups_saved'))} />
      <FormSheet visible={more === 'template'} onClose={close} title={t('cs.save_template')} submitLabel={t('common.save')}
        fields={[{ key: 'title', label: t('cs.template_name') }]} onSubmit={call(async (v) => api.post('/coaching/templates', { title: v.title, session_record_id: s.id }), t('cs.template_saved'))} />
      <Sheet visible={more === 'use'} onClose={close} title={t('cs.use_template')}>
        {tpls.loading ? <Loading /> : !tpls.data?.length ? <T size={13} color={c.mute}>{t('cs.no_templates')}</T> :
          tpls.data.map((tpl) => <Row key={tpl.id} title={tpl.title} sub={t('cs.tpl_line', { n: tpl.blocks.length, shared: tpl.mine ? '' : ` · ${t('cs.shared_by', { name: tpl.shared_by })}` })} onPress={async () => { try { await api.post(`/coaching/sessions/${s.id}/apply-template`, { template_id: tpl.id }); close(); toast(t('cs.blocks_added')); reload(); } catch (e) { toast(e.message); } }} />)}
      </Sheet>
      <FormSheet visible={more === 'clone'} onClose={close} title={t('cs.clone_title')} submitLabel={t('cs.create')}
        fields={[{ key: 'title', label: t('cs.block_title') }, { key: 'date', label: t('cs.date'), type: 'date' }, { key: 'time', label: t('cs.start_time'), type: 'time' }]} initial={{ title: s.title }}
        onSubmit={async (v) => { const r = await api.post(`/coaching/sessions/${s.id}/clone`, { source_type: 'team_session', source_id: uuidFrom(Date.now()), team_id: s.team_id ?? undefined, title: v.title, scheduled_at: localToIso(v.date, v.time, tz) }); close(); toast(t('cs.clone_done')); push('CoachSession', { id: r.id }); }} />
      <FormSheet visible={more === 'help'} onClose={close} title={t('cs.coach_help')} submitLabel={t('common.save')}
        fields={[
          { key: 'user_id', label: t('nav.title.CoachProfile'), type: 'chips', options: (roster.data?.members ?? []).filter((m) => m.role === 'coach').map((m) => ({ value: m.id, label: m.display_name })) },
          { key: 'permissions', label: t('cs.they_may'), type: 'multi', options: [{ value: 'attendance', label: label('attendance') }, { value: 'observe', label: label('observe') }], optional: true, hint: t('cs.leave_empty_remove') },
        ]}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/delegates`, { user_id: v.user_id, permissions: v.permissions ?? [] }), t('access.saved'))} />
      <FormSheet visible={!!more?.summary} onClose={close} title={t('cs.summary_for', { name: more?.summary?.display_name ?? '' })} submitLabel={t('common.save')}
        fields={[{ key: 'summary', label: t('cs.how_got_on'), type: 'multiline' }, { key: 'shared', label: t('cs.show_player'), type: 'switch', default: false }]}
        onSubmit={call(async (v) => api.post(`/coaching/sessions/${s.id}/player-summaries`, { athlete_id: more.summary.id, summary: v.summary, shared: !!v.shared }), t('access.saved'))} />
    </>
  );
}
