// Player development workspace (issue #324): the one place a player (or a verified guardian) sees what their coach has set and shared.
// It reads GET /me/development, which joins existing coaching goals/actions, training plans, feedback, assessments and reports; every row
// says which record it came from and who made it, and the screen edits nothing itself except finishing a shared action.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { useLayout } from '../layout';
import { c } from '../theme';
import { dateTimeIn } from '../vtime';
import { AthleteBenchmarks } from './player-insights';
import { MyGoalsBlock, MyTrainingBlock } from './player-goals';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const BASIS = { athlete_set: 'set by you', coach_set: 'set by the coach', coach_observed: 'coach-observed', assessor_rated: 'rated by an assessor', staff_set: 'set by staff', derived: 'worked out from your records' };
const URGENCY = { overdue: ['Overdue', c.redSoft], needs_response: ['Needs your answer', c.sunSoft], due_soon: ['Due soon', c.sunSoft], upcoming: ['Coming up', c.violetSoft], none: [null, c.violetSoft] };
const SECTIONS = [
  { key: 'next_actions', title: 'Next actions', empty: ['✅', 'Nothing waiting on you', 'Actions your coach sets, plans to answer and reviews coming up appear here.'] },
  { key: 'my_goals', title: 'My goals', own: true, empty: ['🎯', 'No personal goals yet', 'Set a goal of your own - a skill to build, a number to hit - and log your progress. Share it with a coach only if you want to.'] },
  { key: 'my_training', title: 'My training', own: true, empty: ['🏃', 'No plans of your own yet', 'Plan your own sessions, record how they went, and share the plan with a coach if you like.'] },
  { key: 'goals', title: 'Coach goals', empty: ['🎯', 'No goals shared yet', 'When your coach shares a goal with you, it shows here with the wording written for you.'] },
  { key: 'plans', title: 'Coach plans', empty: ['📋', 'No training plans yet', 'A plan your coach proposes appears here for you to accept or change.'] },
  { key: 'feedback', title: 'Coach feedback', empty: ['💬', 'No feedback shared yet', 'Session feedback, notes and summaries your coach chooses to share appear here.'] },
  { key: 'assessments', title: 'Assessments', empty: ['📊', 'No assessments shared yet', 'Trial and academy assessments released to you appear here.'] },
  { key: 'reports', title: 'Reports', empty: ['📄', 'No reports shared yet', 'Coaching reports published for you can be opened and downloaded from here.'] },
];

/** Where a row came from, in one line: the owning record, who made it, when, and what kind of evidence it is. */
const Provenance = ({ p }) => (
  <T size={11} color={c.mute} style={{ marginTop: 4 }}>
    {p.source_label}{p.by ? ` · ${p.by}` : ''}{p.at ? ` · ${dateTimeIn(p.at, tz)}` : ''} · {BASIS[p.basis] ?? p.basis}
  </T>
);

function ItemCard({ x, self, kind, onOpen, onDone, busy }) {
  const [u] = [URGENCY[x.urgency] ?? URGENCY.none];
  const title = x.title;
  const body = x.text ?? x.detail ?? x.goal ?? null;
  const open = x.link && (self || x.link.screen === 'CoachReportView') ? () => onOpen(x.link) : null;
  const side = kind === 'plans'
    ? `${x.sport ? `${x.sport} · ` : ''}${x.completed}/${x.total} sessions done${x.next_session_at ? ` · next ${dateTimeIn(x.next_session_at, tz)}` : ''}`
    : kind === 'goals' ? (x.review_on ? `Review ${String(x.review_on).slice(0, 10)}` : null)
      : kind === 'assessments' && x.outcome ? `Outcome: ${label(x.outcome)}` : null;
  const status = kind === 'plans' ? (x.can_respond ? 'Needs your answer' : label(x.status)) : kind === 'goals' ? label(x.status) : x.status ? label(x.status) : null;
  return (
    <Card pad={12} style={{ marginBottom: 8 }} onPress={open ?? undefined} accessibilityLabel={`${title}. ${x.provenance.source_label}${x.provenance.by ? ` from ${x.provenance.by}` : ''}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <T weight="700" style={{ flexShrink: 1 }}>{title}</T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
          {u[0] ? <Tag label={u[0]} color={u[1]} /> : null}
          {status && kind !== 'next_actions' ? <Tag label={status} color={x.can_respond ? c.sunSoft : c.violetSoft} /> : null}
        </View>
      </View>
      {body ? <T size={13} style={{ marginTop: 2 }}>{body}</T> : null}
      {x.due_at && kind === 'next_actions' ? <T size={12} color={x.urgency === 'overdue' ? c.red : c.mute}>{x.urgency === 'overdue' ? 'Was due' : 'Due'} {dateTimeIn(x.due_at, tz)}</T> : null}
      {side ? <T size={12} color={c.mute}>{side}</T> : null}
      {kind === 'feedback' && x.context ? <T size={12} color={c.mute}>{x.context}</T> : null}
      <Provenance p={x.provenance} />
      {x.can_complete ? <View style={{ marginTop: 8, flexDirection: 'row' }}><Btn small title="Mark done" loading={busy === x.id} onPress={() => onDone(x)} /></View> : null}
      {open ? <T size={12} weight="700" color={c.pink} style={{ marginTop: 6 }}>Open ›</T> : null}
    </Card>
  );
}

function Block({ def, data, self, athleteId, onOpen, onDone, busy }) {
  const [more, setMore] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState(null);
  const items = [...data.items, ...more];
  const [lastMore, setLastMore] = useState(null);
  const hasMore = lastMore ?? data.has_more;
  const load = async () => {
    setLoadingMore(true); setErr(null);
    try {
      const r = await api.get('/me/development', { section: def.key, offset: items.length, limit: 10, ...(self ? {} : { athlete_id: athleteId }) });
      setMore((m) => [...m, ...r.sections[def.key].items]); setLastMore(r.sections[def.key].has_more);
    } catch (e) { setErr(e); }
    setLoadingMore(false);
  };
  return (
    <View style={{ marginTop: 14 }} accessibilityRole="summary">
      <T size={13} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{def.title.toUpperCase()}{items.length ? ` · ${items.length}${hasMore ? '+' : ''}` : ''}</T>
      <View style={{ marginTop: 6 }}>
        {!items.length ? <Empty emoji={def.empty[0]} title={def.empty[1]} sub={def.empty[2]} /> : items.map((x) => <ItemCard key={`${x.kind ?? def.key}${x.id}${x.version ?? ''}`} x={x} kind={def.key} self={self} onOpen={onOpen} onDone={onDone} busy={busy} />)}
        {err ? <ErrorBox error={err} onRetry={load} /> : null}
        {hasMore ? <Btn small title="Show more" color={c.paper} ink={c.ink} loading={loadingMore} onPress={load} style={{ alignSelf: 'flex-start' }} /> : null}
      </View>
    </View>
  );
}

/** My development (or, with child_id, a verified guardian's read-only view of a young person's). */
export function MyDevelopment({ child_id, name }) {
  const { toast } = useSession();
  const { push } = useNav();
  const { tablet } = useLayout();
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(null);
  const d = useLoad(() => api.get('/me/development', child_id ? { athlete_id: child_id } : {}), [child_id]);
  const data = d.data;
  const self = !child_id;
  const done = async (a) => {
    setBusy(a.id);
    try { await api.patch(`/coaching/actions/${a.id}`, { row_version: a.row_version, status: 'done' }); toast('Marked done'); }
    catch (e) { toast(e.status === 409 ? 'This was changed elsewhere, so it has been reloaded' : e.message ?? 'Could not save, try again'); }
    setBusy(null); d.reload();
  };
  const open = (link) => push(link.screen, link.params ?? {});
  const shown = SECTIONS.filter((s) => !pick || pick === s.key);
  const render = (defs) => defs.map((def) => {
    const k = `${def.key}:${data.generated_at}`;
    if (!def.own) return <Block key={k} def={def} data={data.sections[def.key]} self={self} athleteId={child_id} onOpen={open} onDone={done} busy={busy} />;
    const Own = def.key === 'my_goals' ? MyGoalsBlock : MyTrainingBlock;
    return <Own key={k} def={def} data={data.sections[def.key]} self={self} athleteId={child_id ?? data.athlete_id} reload={d.reload} />;
  });
  const split = tablet && !pick;
  return (
    <Screen onRefresh={d.reload} wide>
      <H1>{child_id ? `${name ?? 'Your child'} · development` : 'My development'}</H1>
      <T size={13} color={c.mute}>
        {child_id ? 'Read-only. Only what their coach chose to share with them. Private notes never appear here.' : 'Everything your coach has set or shared with you, in one place. Each item shows who it is from and what kind of record it is. Private coach notes never appear.'}
      </T>
      {d.loading && !data ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !data.consent ? (
        <>
          <Empty emoji="🔒" title="Coaching sharing is off" sub={data.note} />
          {self ? render(SECTIONS.filter((s) => s.own && data.sections[s.key])) : null}
        </>
      ) : (
        <>
          <View style={{ marginTop: 10 }}>
            <HScroll>
              <Chip label="All" active={!pick} onPress={() => setPick(null)} />
              {SECTIONS.map((s) => <Chip key={s.key} label={`${s.title} · ${data.sections[s.key].items.length}${data.sections[s.key].has_more ? '+' : ''}`} active={pick === s.key} onPress={() => setPick(pick === s.key ? null : s.key)} />)}
            </HScroll>
          </View>
          {split ? (
            <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}>
              <View style={{ flex: 1, minWidth: 0 }}>{render(SECTIONS.filter((s) => ['next_actions', 'my_goals', 'my_training', 'plans', 'goals'].includes(s.key)))}</View>
              <View style={{ flex: 1, minWidth: 0 }}>{render(SECTIONS.filter((s) => ['feedback', 'assessments', 'reports'].includes(s.key)))}</View>
            </View>
          ) : render(shown)}
          {child_id && !pick ? <View style={{ marginTop: 14, gap: 6 }}><T weight="700" size={15}>Benchmarks</T><AthleteBenchmarks athlete_id={child_id} /></View> : null}
        </>
      )}
    </Screen>
  );
}
