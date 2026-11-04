// Athlete development plan (Academy OS P0 / #785). It lives inside Academy → Progress, next to the pathway and assessments it builds on, and it
// owns no athlete, score or clinical record: every figure is read from the record that owns it and carries its source, unit and window.
// Six separate domains, each objective judged on its own metric; "no data" is a state of its own; there is no combined talent score.
// One component tree for web, iOS, iPadOS and Android (shared primitives only, 44pt targets, labels on everything, start/end layout for RTL).
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t as tr } from '../i18n';
import { Block, Fact, Initials, Kpi, Origin, when } from './academy-ui';
import { ObjectiveBuilder, PhasesSheet, SeasonTimeline, SquadBoard } from './academy-dev-builder';
import { DOMAINS, DOMAIN_ICON, countsOf, figure, meterGeometry, missingKey, seriesBars, stateMeta } from './dev-plan-trend';

const Panel = ({ children, style }) => <View style={[{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }, style]}>{children}</View>;
const key = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TONE = { mute: c.mute, cyan: c.cyan, lime: c.lime, orange: c.orange };
const STATUS_TONE = { draft: undefined, active: c.lime, in_review: c.sunSoft, closed: c.violetSoft };
const seasonDefault = () => { const y = new Date().getFullYear(); const m = new Date().getMonth(); const s = m >= 6 ? y : y - 1; return `${s}/${String((s + 1) % 100).padStart(2, '0')}`; };
const addMonths = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); };
const todayStr = () => new Date().toISOString().slice(0, 10);
const people = (opts) => [...(opts?.people ?? []), ...(opts?.providers ?? [])].map((p) => ({ value: p.user_id, label: p.display_name, sub: p.job_title ?? p.provider_type ?? p.role }));

/** A search-and-pick dropdown as a FormSheet field (lists that can grow are never rows of chips). */
const menu = (k, label, options, extra = {}) => ({ key: k, label, type: 'custom', show: extra.show, render: ({ v, set }) => <MenuField label={label} value={v[k]} onChange={(x) => set(k, x)} options={typeof options === 'function' ? options(v) : options} hint={extra.hint} placeholder={extra.placeholder} /> });

const SRC = { coaching_observations: 'dp.src.observations', academy_attendance: 'dp.src.attendance', 'performances (approved competition)': 'dp.src.official', coaching_goals: 'dp.src.goal', 'plan milestones': 'dp.src.milestones', academic_evidence: 'dp.src.school', academy_progression_decisions: 'dp.src.pathway', 'clinical_clearances (minimal share)': 'dp.src.fit' };
const srcLabel = (x) => (SRC[x] ? tr(SRC[x]) : x);

const stateText = (m) => m.icon + ' ' + tr(m.key);
const backText = () => '← ' + tr('dp.all_plans');
const milestoneText = (m) => m.title + ', ' + tr('dp.due_on', { date: when(m.due_on) });
const chipCount = (d, n) => DOMAIN_ICON[d] + ' ' + n;
export const StateTag = ({ state }) => { const m = stateMeta(state); return <Tag label={stateText(m)} color={state === 'on_track' || state === 'achieved' ? c.mint : state === 'behind' ? c.orange : state === 'tracking' ? c.cyan : c.violetSoft} />; };

/** Baseline → now → target on one bar, plus where the season line says the athlete should be by today. Missing values are simply not drawn. */
function FigureBar({ o }) {
  const e = o.evidence, g = meterGeometry({ baseline: o.baseline_value, current: e.value, target: o.target_value, expected: o.expected });
  if (g.span === null) return null;
  const unit = e.unit ?? '';
  const label = `${tr('dp.baseline')} ${figure(o.baseline_value)}, ${tr('dp.now')} ${figure(e.value)}, ${tr('dp.target')} ${figure(o.target_value)}. ${unit}`;
  return (
    <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
      <View style={{ height: 14, borderRadius: 8, backgroundColor: c.line, justifyContent: 'center' }}>
        {g.current !== null && g.baseline !== null ? <View style={{ position: 'absolute', start: `${Math.min(g.baseline, g.current)}%`, width: `${Math.abs(g.current - g.baseline)}%`, height: 14, borderRadius: 8, backgroundColor: TONE[stateMeta(o.state).tone] }} /> : null}
        {g.expected !== null ? <View style={{ position: 'absolute', start: `${g.expected}%`, width: 2, height: 20, top: -3, backgroundColor: c.mute }} /> : null}
        {g.target !== null ? <View style={{ position: 'absolute', start: `${g.target}%`, width: 3, height: 22, top: -4, borderRadius: 2, backgroundColor: c.ink }} /> : null}
        {g.current !== null ? <View style={{ position: 'absolute', start: `${g.current}%`, width: 14, height: 14, marginStart: -7, borderRadius: 7, backgroundColor: c.paper, borderWidth: 3, borderColor: TONE[stateMeta(o.state).tone] }} /> : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <T size={12} color={c.mute}>{tr('dp.baseline')} <T size={12} weight="800">{figure(o.baseline_value)}</T>{o.baseline_on ? <T size={11} color={c.mute}> · {when(o.baseline_on)}</T> : null}</T>
        <T size={12} color={c.mute}>{tr('dp.now')} <T size={12} weight="800">{figure(e.value)}</T></T>
        <T size={12} color={c.mute}>{tr('dp.target')} <T size={12} weight="800">{figure(o.target_value)}</T></T>
      </View>
    </View>
  );
}

function Trend({ series, label }) {
  const bars = seriesBars(series);
  if (!bars.length) return null;
  return (
    <View accessible accessibilityLabel={`${label}: ${bars.map((b) => `${b.month} ${b.value}`).join(', ')}`} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 56 }}>
      {bars.slice(-8).map((b) => (
        <View key={b.month} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <T size={10} weight="800">{figure(b.value)}</T>
          <View style={{ width: '70%', height: Math.max(4, Math.round(b.height * 0.28)), borderRadius: 4, backgroundColor: c.cyan }} />
          <T size={9} color={c.mute}>{b.month.slice(5)}</T>
        </View>
      ))}
    </View>
  );
}

function ObjectiveCard({ o, plan, canEdit, onChange, onSource, onEdit, onTask, onMilestone, toast }) {
  const miss = missingKey(o);
  const ms = o.milestones;
  const toggle = async (m) => { try { await api.post(`/academy/dev-objectives/${o.id}/milestones`, { milestone_id: m.id, status: m.status === 'done' ? 'pending' : 'done' }); onChange(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ padding: 14, borderRadius: 18, backgroundColor: c.bg, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800" size={15}>{o.title}</T>
          <T size={12} color={c.mute}>{[o.competency, o.owner ? tr('dp.owner_is', { name: o.owner.display_name }) : null, o.due_on ? tr('dp.due_on', { date: when(o.due_on) }) : null].filter(Boolean).join(' · ')}</T>
        </View>
        <StateTag state={o.state} />
      </View>
      {o.metric_kind !== 'milestones' && o.metric_kind !== 'coach_goal' ? <FigureBar o={o} /> : null}
      {o.metric_kind === 'coach_goal' && o.evidence.goal ? <T size={13}>🎯 {o.evidence.goal.title} · <T size={13} weight="800">{o.evidence.goal.status}</T>{o.evidence.goal.review_on ? <T size={12} color={c.mute}> · {tr('dp.review_on', { date: when(o.evidence.goal.review_on) })}</T> : null}</T> : null}
      {miss ? <View style={{ padding: 10, borderRadius: 12, backgroundColor: c.violetSoft }}><T size={12} color={c.mute}>{tr(miss)}</T></View> : null}
      {o.evidence.series?.length > 1 ? <Trend series={o.evidence.series} label={tr('dp.trend')} /> : null}
      {o.low_evidence ? <T size={12} color={c.sun} weight="700">⚠ {tr('dp.low_evidence', { n: o.evidence.n })}</T> : null}
      {ms.length ? (
        <View style={{ gap: 4 }}>
          <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{tr('dp.milestones', { done: o.milestone_summary.done, total: o.milestone_summary.total })}</T>
          {ms.map((m) => (
            <Pressable key={m.id} disabled={!canEdit} onPress={() => toggle(m)} accessibilityRole="checkbox" accessibilityState={{ checked: m.status === 'done', disabled: !canEdit }} accessibilityLabel={milestoneText(m)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: m.status === 'done' ? c.lime : c.line, backgroundColor: m.status === 'done' ? c.lime : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{m.status === 'done' ? <T size={13} weight="800" color={c.onAccent}>✓</T> : null}</View>
              <T size={13} style={{ flex: 1, textDecorationLine: m.status === 'done' ? 'line-through' : 'none' }}>{m.title}</T>
              <T size={12} color={m.status === 'pending' && m.due_on < todayStr() ? c.orange : c.mute} weight={m.status === 'pending' && m.due_on < todayStr() ? '800' : '500'}>{when(m.due_on)}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag label={srcLabel(o.evidence.source)} />
        <Origin origin={o.evidence.origin} />
        {o.evidence.n ? <Tag label={tr('dp.n_obs', { n: o.evidence.n })} /> : null}
        <Tag label={o.visibility === 'athlete' ? tr('dp.vis.athlete') : tr('dp.vis.staff')} color={o.visibility === 'athlete' ? c.mint : c.violetSoft} />
      </View>
      {o.evidence.unit ? <T size={11} color={c.mute}>{o.evidence.unit}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {o.evidence.link ? <Btn small title={tr('dp.open_source')} color={c.paper} ink={c.ink} onPress={() => onSource(o)} accessibilityLabel={tr('dp.open_source_for', { title: o.title })} /> : null}
        {canEdit ? <><Btn small title={tr('dp.add_task')} color={c.paper} ink={c.ink} onPress={() => onTask(o)} /><Btn small title={tr('dp.add_milestone')} color={c.paper} ink={c.ink} onPress={() => onMilestone(o)} /><Btn small title={tr('dp.update')} color={c.paper} ink={c.ink} onPress={() => onEdit(o)} /></> : null}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ plan detail
export function PlanDetail({ id, o, archived, toast, onChanged, onOpenPathway, family }) {
  const { tablet, width } = useLayout();
  const wide = tablet && width >= 1000;
  const nav = useNav();
  const me = useSession()?.user;
  const d = useLoad(() => api.get(`/academy/dev-plans/${id}`), [id]);
  const opts = useLoad(() => (o && !family ? api.get(`/organisations/${o.id}/academy/dev-plans/options`, d.data ? { athlete_id: d.data.plan.athlete.id } : {}) : Promise.resolve(null)), [o?.id, d.data?.plan?.athlete?.id]);
  const [dom, setDom] = useState('technical'), [form, setForm] = useState(null), [target, setTarget] = useState(null);
  const refresh = () => { d.reload(); onChanged?.(); };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const v = d.data, p = v.plan, s = v.strip, acc = v.my_access;
  const live = !archived && p.status !== 'closed' && !p.archived_at;
  const canManage = live && acc.can_manage && !family;
  const provider = acc.kind === 'contributor' && !acc.domains.length;
  const canTouch = (ob) => live && !family && (acc.can_manage || (ob.owner?.id === me?.id && acc.domains.includes(ob.domain)));
  const objectives = DOMAINS.flatMap((x) => v.domains[x]?.objectives ?? []);
  const draft = v.reviews.find((r) => r.status === 'draft');
  const signed = v.reviews.filter((r) => r.status === 'signed_off');
  const goSource = (ob) => {
    const l = ob.evidence.link;
    if (l.type === 'rubric') nav?.push('CoachRubrics');
    else if (l.type === 'coaching_goal') nav?.push('CoachGoals', { athlete_id: p.athlete.id, name: p.athlete.display_name });
    else if (l.type === 'attendance') nav?.push('AcademyAgenda');
    else nav?.push('Passport', { id: p.athlete.id });
  };
  const run = async (fn, ok) => { try { await fn(); toast?.(ok); refresh(); } catch (e) { toast?.(e.message); throw e; } };
  const cnt = countsOf(s);

  const header = (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Initials name={p.athlete.display_name} user={p.athlete} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800" size={18}>{p.athlete.display_name}</T>
          <T size={13} color={c.mute}>{p.sport} · {tr('dp.season', { label: p.season_label })} · {when(p.starts_on)} – {when(p.ends_on)}</T>
          <T size={12} color={c.mute}>{tr('dp.lead_is', { name: p.lead.display_name })}{p.status !== 'closed' ? ` · ${tr('dp.days_left', { n: s.days_left })}` : ''}</T>
        </View>
        <Tag label={tr(`dp.status.${p.status}`)} color={STATUS_TONE[p.status]} />
      </View>
      {p.focus ? <T size={13}>“{p.focus}”</T> : null}
      {v.pathway ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag label={`🪜 ${v.pathway.title}${v.pathway.level ? ` · ${v.pathway.level}` : ''}`} color={c.mint} />
          {v.pathway.latest_assessment ? <Tag label={tr('dp.assessment', { outcome: String(v.pathway.latest_assessment.outcome).replace(/_/g, ' ') })} /> : null}
          {onOpenPathway ? <Btn small title={tr('dp.open_pathway')} color={c.paper} ink={c.ink} onPress={() => onOpenPathway(p.pathway_id, p.athlete.id)} /> : null}
        </View>
      ) : null}
      {v.clearance ? <T size={12} color={c.mute}>🩺 {tr('dp.fit_status')}: <T size={12} weight="800">{v.clearance.state === 'shared' ? tr(`dp.clear.${v.clearance.status}`) : tr('dp.clear.not_shared')}</T>{v.clearance.valid_until ? ` · ${tr('dp.valid_until', { date: when(v.clearance.valid_until) })}` : ''} · {tr('dp.fit_note')}</T> : null}
      {canManage && p.status === 'draft' ? <Btn title={tr('dp.activate')} onPress={() => run(() => api.patch(`/academy/dev-plans/${p.id}`, { row_version: p.row_version, status: 'active' }), tr('dp.activated'))} /> : null}
    </Panel>
  );

  const strip = provider ? null : (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <Kpi label={tr('dp.kpi.objectives')} value={cnt.objectives} sub={tr('dp.kpi.objectives_sub')} />
      <Kpi label={tr('dp.kpi.on_track')} value={cnt.on_track} sub={tr('dp.kpi.on_track_sub')} />
      <Kpi label={tr('dp.kpi.behind')} value={cnt.behind} tone={cnt.behind ? 'alert' : undefined} sub={tr('dp.kpi.behind_sub')} />
      <Kpi label={tr('dp.kpi.no_data')} value={cnt.no_data} sub={tr('dp.kpi.no_data_sub')} />
      <Kpi label={tr('dp.kpi.tasks')} value={s.interventions_open} tone={s.interventions_overdue ? 'alert' : undefined} sub={s.interventions_overdue ? tr('dp.kpi.tasks_overdue', { n: s.interventions_overdue }) : tr('dp.kpi.tasks_sub')} />
      <Kpi label={tr('dp.kpi.review')} value={s.review_in_progress ? tr('dp.kpi.review_open') : when(s.next_review_on)} tone={s.review_overdue ? 'alert' : undefined} sub={s.review_in_progress ? tr('dp.review_in_progress') : s.review_overdue ? tr('dp.kpi.review_overdue') : tr('dp.kpi.review_sub', { n: p.review_every_days })} />
    </View>
  );

  const domainTabs = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">
      {DOMAINS.map((x) => {
        const list = v.domains[x]?.objectives ?? [], behind = list.filter((y) => y.state === 'behind').length;
        return <Chip key={x} active={dom === x} onPress={() => setDom(x)} label={`${DOMAIN_ICON[x]} ${tr(`dp.domain.${x}`)} · ${list.length}${behind ? ` · ▼${behind}` : ''}`} />;
      })}
    </View>
  );
  const shown = v.domains[dom]?.objectives ?? [];
  const objectivesPanel = provider ? null : (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.objectives')}</T>{live && !family && (acc.can_manage || acc.write_domains?.length) ? <Btn small title={tr('dp.add_objective')} onPress={() => setForm({ kind: 'objective', domain: dom })} /> : null}</View>
      <T size={12} color={c.mute}>{tr('dp.no_score')}</T>
      {domainTabs}
      {shown.length ? shown.map((ob) => <ObjectiveCard key={ob.id} o={ob} plan={p} canEdit={canTouch(ob)} onChange={refresh} onSource={goSource} onEdit={(x) => setForm({ kind: 'edit', ob: x })} onTask={(x) => setForm({ kind: 'task', ob: x })} onMilestone={(x) => setForm({ kind: 'milestone', ob: x })} toast={(m) => toast?.(m)} />)
        : <Empty emoji={DOMAIN_ICON[dom]} title={tr('dp.domain_empty', { domain: tr(`dp.domain.${dom}`) })} sub={family ? tr('dp.domain_empty_family') : tr('dp.domain_empty_sub')} />}
    </Panel>
  );

  const tasks = v.interventions;
  const tasksPanel = (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.tasks')}</T>{canManage ? <Btn small title={tr('dp.add_task')} onPress={() => setForm({ kind: 'task' })} /> : null}</View>
      {tasks.length ? tasks.map((i) => (
        <View key={i.id} style={{ padding: 12, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="700" size={14} style={{ flex: 1 }}>{i.title}</T><Tag label={tr(`dp.task.${i.status}`)} color={i.status === 'done' ? c.mint : i.overdue ? c.orange : undefined} /></View>
          <T size={12} color={c.mute}>{tr(`dp.kind.${i.kind}`)}{i.owner ? ` · ${i.owner.display_name}` : ''}{i.due_on ? ` · ${tr('dp.due_on', { date: when(i.due_on) })}` : ''}{i.overdue ? ` · ${tr('dp.overdue')}` : ''}</T>
          {i.detail ? <T size={12}>{i.detail}</T> : null}
          {!family && live && (acc.can_manage || i.owner?.id === me?.id) && !['done', 'cancelled'].includes(i.status) ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {i.status === 'open' ? <Btn small title={tr('dp.start')} color={c.paper} ink={c.ink} onPress={() => run(() => api.patch(`/academy/dev-interventions/${i.id}`, { row_version: i.row_version, status: 'in_progress' }), tr('dp.saved'))} /> : null}
              <Btn small title={tr('dp.mark_done')} onPress={() => setForm({ kind: 'done', task: i })} />
            </View>
          ) : null}
        </View>
      )) : <Empty emoji="🗒️" title={tr('dp.tasks_empty')} sub={family ? tr('dp.tasks_empty_family') : tr('dp.tasks_empty_sub')} />}
    </Panel>
  );

  const reviewPanel = provider ? null : (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.reviews')}</T>{canManage && p.status === 'active' ? <Btn small title={tr('dp.start_review')} onPress={() => setForm({ kind: 'review' })} /> : null}</View>
      {draft ? <ReviewCard r={draft} meId={me?.id} live={live} acc={acc} family={family} setForm={setForm} /> : null}
      {signed.map((r) => <ReviewCard key={r.id} r={r} meId={me?.id} live={live} acc={acc} family={family} setForm={setForm} />)}
      {!draft && !signed.length ? <Empty emoji="🧾" title={tr('dp.reviews_empty')} sub={family ? tr('dp.reviews_empty_family') : tr('dp.reviews_empty_sub')} /> : null}
    </Panel>
  );

  const decisionsPanel = provider || family ? null : (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.decisions')}</T>{canManage ? <Btn small title={tr('dp.record_decision')} onPress={() => setForm({ kind: 'decision' })} /> : null}</View>
      {v.decisions.length ? v.decisions.map((x) => (
        <View key={x.id} style={{ gap: 2 }}>
          <T size={13} weight="800">{tr(`dp.decision.${x.kind}`)} <T size={12} color={c.mute}>· {when(x.at)} · {x.by?.display_name}</T></T>
          {x.reason ? <T size={13}>{x.reason}</T> : null}
        </View>
      )) : <T size={13} color={c.mute}>{tr('dp.decisions_empty')}</T>}
      <T size={11} color={c.mute}>{tr('dp.decisions_note')}</T>
    </Panel>
  );

  const peoplePanel = family || provider ? null : (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.team')}</T>{canManage ? <Btn small title={tr('dp.add_person')} onPress={() => setForm({ kind: 'person' })} /> : null}</View>
      <Fact k={tr('dp.lead')} v={p.lead.display_name} />
      {v.contributors.map((x) => (
        <View key={x.user_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
          <T size={13} style={{ flex: 1 }}><T size={13} weight="800">{x.display_name}</T> · {tr(`dp.disc.${x.discipline}`)}{x.domains.length ? ` · ${x.domains.map((y) => tr(`dp.domain.${y}`)).join(', ')}` : ` · ${tr('dp.provider_scope')}`}</T>
          {canManage ? <Btn small title={tr('dp.remove')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/dev-plans/${p.id}/contributors`, { user_id: x.user_id, discipline: x.discipline, remove: true }), tr('dp.saved'))} /> : null}
        </View>
      ))}
      <T size={11} color={c.mute}>{tr('dp.team_note')}</T>
    </Panel>
  );

  const schoolPanel = !v.school ? null : (
    <Panel>
      <T weight="800" size={16}>{tr('dp.school')}</T>
      {family ? <>
        <T size={12} color={c.mute}>{tr('dp.school_family_note')}</T>
        {v.school.available?.length ? v.school.available.map((e) => (
          <Pressable key={e.id} accessibilityRole="switch" accessibilityState={{ checked: !!e.linked }} accessibilityLabel={[e.institution, e.kind].join(' ')} onPress={() => run(() => api.post(`/academy/dev-plans/${p.id}/school-links`, { evidence_id: e.id, shared: !e.linked }), e.linked ? tr('dp.school_off') : tr('dp.school_on'))} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
            <View style={{ flex: 1 }}><T size={14} weight="700">{e.institution}</T><T size={12} color={c.mute}>{e.kind}{e.period_to ? ` · ${when(e.period_from)} – ${when(e.period_to)}` : ''} · {e.provenance === 'institution_issued' ? tr('dp.school_issued') : tr('dp.school_self')}</T></View>
            <Tag label={e.linked ? tr('dp.shown') : tr('dp.hidden')} color={e.linked ? c.mint : undefined} />
          </Pressable>
        )) : <T size={13} color={c.mute}>{tr('dp.school_none_family')}</T>}
      </> : v.school.linked.length ? v.school.linked.map((e) => <Fact key={e.id} k={e.institution} v={`${e.kind}${e.period_to ? ` · ${when(e.period_from)} – ${when(e.period_to)}` : ''} · ${e.provenance === 'institution_issued' ? tr('dp.school_issued') : tr('dp.school_self')}`} />) : <T size={13} color={c.mute}>{tr('dp.school_none_staff')}</T>}
      <T size={11} color={c.mute}>{tr('dp.school_note')}</T>
    </Panel>
  );

  const allMs = DOMAINS.flatMap((x) => (v.domains[x]?.objectives ?? []).flatMap((ob) => ob.milestones));
  const timeline = provider ? null : <Panel><SeasonTimeline plan={p} phases={v.phases} clashes={v.clashes} milestones={allMs} tasks={v.interventions} reviews={v.reviews} canEdit={canManage} onEdit={() => setForm({ kind: 'phases' })} /></Panel>;
  const main = <View style={{ flex: wide ? 3 : undefined, gap: 14, minWidth: 0 }}>{timeline}{objectivesPanel}{decisionsPanel}</View>;
  const side = <View style={{ flex: wide ? 2 : undefined, gap: 14, minWidth: 0 }}>{tasksPanel}{reviewPanel}{peoplePanel}{schoolPanel}</View>;
  return (
    <View style={{ gap: 14 }}>
      {header}{strip}
      {wide ? <View style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>{main}{side}</View> : <>{main}{side}</>}
      <T size={11} color={c.mute}>{tr('dp.sources')}: {v.sources.map(srcLabel).join(' · ')}. {tr('dp.privacy')}</T>
      {family ? null : <PlanForms form={form} setForm={setForm} v={v} opts={opts.data} run={run} />}
      {family ? null : <ObjectiveBuilder visible={form?.kind === 'objective'} onClose={() => setForm(null)} plan={p} view={v} opts={opts.data} onCreated={refresh} toast={toast} />}
      {family ? null : <PhasesSheet visible={form?.kind === 'phases'} onClose={() => setForm(null)} plan={p} phases={v.phases} onSave={async (ph) => { await api.patch(`/academy/dev-plans/${p.id}`, { row_version: p.row_version, phases: ph }); setForm(null); toast?.(tr('dp.saved')); refresh(); }} />}
      {family ? <FamilyForms form={form} setForm={setForm} v={v} run={run} /> : null}
    </View>
  );
}

function ReviewCard({ r, live, acc, family, setForm, meId }) {
  const draft = r.status === 'draft';
  const signedBy = (cap) => r.signoffs.filter((s) => s.capacity === cap);
  const concerns = r.signoffs.filter((s) => s.decision === 'raise_concern');
  const famCap = acc.kind === 'guardian' ? 'guardian' : 'athlete';
  const ackd = r.signoffs.some((s) => s.capacity === famCap && s.by?.id === meId);
  return (
    <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.bg, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={14} style={{ flex: 1 }}>{when(r.period_from)} – {when(r.period_to)}</T>
        <Tag label={draft ? tr('dp.review.draft') : tr('dp.review.signed')} color={draft ? c.sunSoft : c.mint} />
      </View>
      {r.summary ? <T size={13}>{r.summary}</T> : null}
      {!family && r.domain_notes ? Object.entries(r.domain_notes).map(([k, n]) => <T key={k} size={12}><T size={12} weight="800">{tr(`dp.domain.${k}`)}: </T>{n}</T>) : null}
      {r.signoffs.map((s, i) => <T key={i} size={12} color={s.decision === 'raise_concern' ? c.orange : c.mute}>{s.decision === 'raise_concern' ? '⚑' : '✓'} {s.by?.display_name} · {tr(`dp.cap.${s.capacity}`)} · {tr(`dp.sign.${s.decision}`)}{s.comment ? ` — “${s.comment}”` : ''}</T>)}
      {r.status === 'signed_off' ? <T size={11} color={c.mute}>{tr('dp.signed_by', { name: r.signed_off_by?.display_name ?? '', date: when(r.signed_off_at) })}{r.family_visible ? ` · ${tr('dp.shared_family')}` : ` · ${tr('dp.not_shared_family')}`}</T> : null}
      {r.snapshot ? <T size={11} color={c.mute}>{tr('dp.frozen')}</T> : null}
      {live && !family && draft && acc.can_manage ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={tr('dp.write_review')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'write', r })} /><Btn small title={tr('dp.sign_off')} onPress={() => setForm({ kind: 'sign', r, lead: true, concerns: concerns.length })} /></View> : null}
      {live && !family && draft && !acc.can_manage && acc.write_domains?.length ? <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title={tr('dp.write_review')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'write', r })} /><Btn small title={tr('dp.sign_contributor')} onPress={() => setForm({ kind: 'sign', r, lead: false })} /></View> : null}
      {family && r.status === 'signed_off' && !ackd ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={tr('dp.acknowledge')} onPress={() => setForm({ kind: 'ack', r })} /><Btn small title={tr('dp.raise_concern')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'concern', r })} /></View> : null}
      {family && ackd ? <T size={12} color={c.mint} weight="800">✓ {tr('dp.you_acknowledged')}</T> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ forms
const DOMAIN_OPTS = () => DOMAINS.map((x) => ({ value: x, label: `${DOMAIN_ICON[x]} ${tr(`dp.domain.${x}`)}` }));
function PlanForms({ form, setForm, v, opts, run }) {
  const p = v.plan, close = () => setForm(null);
  const rubrics = (opts?.rubrics ?? []).filter((r) => !r.sport || r.sport === p.sport);
  const peopleOpts = people(opts);
  const dims = (rid) => (rubrics.find((r) => r.id === rid)?.dimensions ?? []).map((d) => ({ value: d.key, label: d.name ?? d.key }));
  const metricOpts = [{ value: 'rubric', label: tr('dp.metric.rubric') }, { value: 'attendance', label: tr('dp.metric.attendance') }, { value: 'coach_goal', label: tr('dp.metric.coach_goal') }, { value: 'official', label: tr('dp.metric.official') }, { value: 'milestones', label: tr('dp.metric.milestones') }];
  const f = form?.kind;
  const taskKinds = (opts?.intervention_kinds ?? []).map((k) => ({ value: k, label: tr(`dp.kind.${k}`) }));
  const inSeason = { min: p.starts_on, max: p.ends_on };
  return (
    <>
      <FormSheet visible={f === 'edit'} onClose={close} title={tr('dp.update')} submitLabel={tr('dp.save')} initial={{ status: form?.ob?.status, owner_id: form?.ob?.owner?.id, due_on: form?.ob?.due_on, visibility: form?.ob?.visibility === 'athlete' }}
        fields={[{ key: 'status', label: tr('dp.field.status'), type: 'chips', options: ['planned', 'active', 'achieved', 'deferred', 'dropped'].map((x) => ({ value: x, label: tr(`dp.ostatus.${x}`) })) }, menu('owner_id', tr('dp.field.owner'), peopleOpts), { key: 'due_on', label: tr('dp.field.due'), type: 'date', optional: true, ...inSeason },
          { key: 'visibility', label: tr('dp.field.show_athlete'), type: 'switch' }, { key: 'archive', label: tr('dp.field.archive'), type: 'switch', hint: tr('dp.field.archive_hint') }]}
        onSubmit={(x) => run(() => api.patch(`/academy/dev-objectives/${form.ob.id}`, { row_version: form.ob.row_version, status: x.status, owner_id: x.owner_id || undefined, due_on: x.due_on || undefined, visibility: x.visibility ? 'athlete' : 'staff', archive: x.archive || undefined }), tr('dp.saved'))} />
      <FormSheet visible={f === 'milestone'} onClose={close} title={tr('dp.add_milestone')} submitLabel={tr('dp.save')} fields={[{ key: 'title', label: tr('dp.field.milestone') }, { key: 'due_on', label: tr('dp.field.due'), type: 'date', ...inSeason }]}
        onSubmit={(x) => run(() => api.post(`/academy/dev-objectives/${form.ob.id}/milestones`, { title: x.title, due_on: x.due_on }), tr('dp.saved'))} />
      <FormSheet visible={f === 'task'} onClose={close} title={tr('dp.add_task')} submitLabel={tr('dp.save')} initial={{ kind: 'training_block', objective_id: form?.ob?.id, visibility: false }}
        fields={[{ key: 'kind', label: tr('dp.field.kind'), type: 'chips', options: taskKinds }, { key: 'title', label: tr('dp.field.task') },
          menu('objective_id', tr('dp.field.for_objective'), [...DOMAINS.flatMap((x) => v.domains[x]?.objectives ?? [])].map((o) => ({ value: o.id, label: o.title, sub: tr(`dp.domain.${o.domain}`) })), { hint: tr('dp.field.for_objective_hint') }),
          menu('owner_id', tr('dp.field.owner'), peopleOpts, { hint: tr('dp.field.task_owner_hint') }), { key: 'due_on', label: tr('dp.field.due'), type: 'date', optional: true, ...inSeason },
          { key: 'detail', label: tr('dp.field.detail'), type: 'multiline', optional: true, hint: tr('dp.field.detail_hint') }, { key: 'visibility', label: tr('dp.field.show_athlete'), type: 'switch' }]}
        onSubmit={(x) => run(() => api.post(`/academy/dev-plans/${p.id}/interventions`, { kind: x.kind, title: x.title, objective_id: x.objective_id || undefined, owner_id: x.owner_id || undefined, due_on: x.due_on || undefined, detail: x.detail || undefined, visibility: x.visibility ? 'athlete' : 'staff' }), tr('dp.saved'))} />
      <FormSheet visible={f === 'done'} onClose={close} title={tr('dp.mark_done')} submitLabel={tr('dp.mark_done')} fields={[{ key: 'note', label: tr('dp.field.outcome'), type: 'multiline', optional: true }]}
        onSubmit={(x) => run(() => api.patch(`/academy/dev-interventions/${form.task.id}`, { row_version: form.task.row_version, status: 'done', completion_note: x.note || undefined }), tr('dp.saved'))} />
      <FormSheet visible={f === 'person'} onClose={close} title={tr('dp.add_person')} submitLabel={tr('dp.save')} initial={{ discipline: 'education', domains: ['academic'] }}
        fields={[menu('user_id', tr('dp.field.person'), peopleOpts, { hint: tr('dp.field.person_hint') }), { key: 'discipline', label: tr('dp.field.discipline'), type: 'chips', options: (opts?.disciplines ?? []).map((x) => ({ value: x, label: tr(`dp.disc.${x}`) })) },
          { key: 'domains', label: tr('dp.field.sees'), type: 'multi', optional: true, options: DOMAIN_OPTS(), show: (x) => x.discipline !== 'physio_provider', hint: tr('dp.field.sees_hint') }]}
        onSubmit={(x) => { if (!x.user_id) throw new Error(tr('dp.err.person')); return run(() => api.post(`/academy/dev-plans/${p.id}/contributors`, { user_id: x.user_id, discipline: x.discipline, domains: x.discipline === 'physio_provider' ? [] : x.domains }), tr('dp.saved')); }} />
      <FormSheet visible={f === 'review'} onClose={close} title={tr('dp.start_review')} submitLabel={tr('dp.start_review')} initial={{ from: v.reviews.find((r) => r.status === 'signed_off')?.period_to ?? p.starts_on, to: todayStr() }}
        fields={[{ key: 'from', toKey: 'to', label: tr('dp.field.period'), type: 'daterange' }]} onSubmit={(x) => run(() => api.post(`/academy/dev-plans/${p.id}/reviews`, { period_from: x.from, period_to: x.to }), tr('dp.review_started'))} />
      <FormSheet visible={f === 'write'} onClose={close} title={tr('dp.write_review')} submitLabel={tr('dp.save')} initial={{ summary: form?.r?.summary, ...Object.fromEntries(DOMAINS.map((x) => [`n_${x}`, form?.r?.domain_notes?.[x]])) }}
        fields={[{ key: 'summary', label: tr('dp.field.summary'), type: 'multiline', optional: true, hint: tr('dp.field.summary_hint') }, ...DOMAINS.filter((x) => (v.domains[x]?.objectives ?? []).length).map((x) => ({ key: `n_${x}`, label: `${DOMAIN_ICON[x]} ${tr(`dp.domain.${x}`)}`, type: 'multiline', optional: true, hint: tr('dp.field.note_hint') }))]}
        onSubmit={(x) => run(() => api.patch(`/academy/dev-reviews/${form.r.id}`, { row_version: form.r.row_version, summary: x.summary || undefined, domain_notes: Object.fromEntries(DOMAINS.filter((d) => x[`n_${d}`]).map((d) => [d, x[`n_${d}`]])) }), tr('dp.saved'))} />
      <FormSheet visible={f === 'sign'} onClose={close} title={form?.lead ? tr('dp.sign_off') : tr('dp.sign_contributor')} submitLabel={tr('dp.sign')} initial={{ decision: 'approve', share: true }}
        notice={form?.concerns ? tr('dp.concern_notice') : form?.lead ? tr('dp.sign_notice') : undefined}
        fields={[{ key: 'decision', label: tr('dp.field.decision'), type: 'choice', options: [{ value: 'approve', label: tr('dp.sign.approve') }, { value: 'raise_concern', label: tr('dp.sign.raise_concern') }], },
          { key: 'comment', label: tr('dp.field.comment'), type: 'multiline', optional: true }, { key: 'share', label: tr('dp.field.share_family'), type: 'switch', show: (x) => form?.lead && x.decision === 'approve', hint: tr('dp.field.share_family_hint') }]}
        onSubmit={(x) => run(() => api.post(`/academy/dev-reviews/${form.r.id}/sign`, { decision: x.decision, comment: x.comment || undefined, share_with_family: !!x.share }), tr('dp.signed'))} />
      <FormSheet visible={f === 'decision'} onClose={close} title={tr('dp.record_decision')} submitLabel={tr('dp.record_decision')} initial={{ kind: 'continue_plan', review_id: v.reviews.find((r) => r.status === 'signed_off')?.id }}
        fields={[{ key: 'kind', label: tr('dp.field.decision_kind'), type: 'chips', options: (opts?.decision_kinds ?? []).map((x) => ({ value: x, label: tr(`dp.decision.${x}`) })) },
          menu('review_id', tr('dp.field.on_review'), v.reviews.filter((r) => r.status === 'signed_off').map((r) => ({ value: r.id, label: `${when(r.period_from)} – ${when(r.period_to)}` })), { hint: tr('dp.field.on_review_hint') }),
          { key: 'reason', label: tr('dp.field.reason'), type: 'multiline', hint: tr('dp.field.reason_hint') }]}
        notice={tr('dp.decision_notice')}
        onSubmit={(x) => run(() => api.post(`/academy/dev-plans/${p.id}/decisions`, { kind: x.kind, reason: x.reason, review_id: x.review_id || undefined, idempotency_key: key('dec') }), tr('dp.saved'))} />
    </>
  );
}

function FamilyForms({ form, setForm, v, run }) {
  const close = () => setForm(null), f = form?.kind;
  const sign = (decision) => (x) => run(() => api.post(`/academy/dev-reviews/${form.r.id}/sign`, { decision, comment: x.comment || undefined }), tr('dp.signed'));
  return (
    <>
      <FormSheet visible={f === 'ack'} onClose={close} title={tr('dp.acknowledge')} submitLabel={tr('dp.acknowledge')} fields={[{ key: 'comment', label: tr('dp.field.comment'), type: 'multiline', optional: true }]} onSubmit={sign('acknowledge')} />
      <FormSheet visible={f === 'concern'} onClose={close} title={tr('dp.raise_concern')} submitLabel={tr('dp.raise_concern')} fields={[{ key: 'comment', label: tr('dp.field.concern'), type: 'multiline' }]} onSubmit={sign('raise_concern')} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ the list (staff / coach)
export function DevPlans({ o, role, archived, toast, onOpenPathway }) {
  const { tablet } = useLayout();
  const [q, setQ] = useState(''), [status, setStatus] = useState('all'), [openId, setOpenId] = useState(null), [form, setForm] = useState(false), [view, setView] = useState('plans');
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/dev-plans`, { limit: 100, ...(status === 'all' ? {} : { status }), ...(q.trim() ? { q: q.trim() } : {}) }), [o.id, status, q]);
  const opts = useLoad(() => (form ? api.get(`/organisations/${o.id}/academy/dev-plans/options`) : Promise.resolve(null)), [o.id, form]);
  const me = useSession()?.user;
  const items = list.data?.items ?? [];
  const sums = useMemo(() => items.reduce((a, x) => ({ plans: a.plans + 1, behind: a.behind + x.strip.behind, review: a.review + (x.strip.review_overdue ? 1 : 0), tasks: a.tasks + x.strip.interventions_overdue, nodata: a.nodata + x.strip.no_data }), { plans: 0, behind: 0, review: 0, tasks: 0, nodata: 0 }), [items]);
  const peopleOpts = people(opts.data);
  const athlete = (opts.data?.athletes ?? []);
  if (openId) return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row' }}><Btn small title={backText()} color={c.paper} ink={c.ink} onPress={() => { setOpenId(null); list.reload(); }} /></View>
      <PlanDetail id={openId} o={o} archived={archived} toast={toast} onChanged={list.reload} onOpenPathway={onOpenPathway} />
    </View>
  );
  if (view === 'board') return (
    <View style={{ gap: 12 }}>
      <Seg value={view} onChange={setView} color={c.violet} options={[{ value: 'plans', label: tr('dp.view.plans') }, { value: 'board', label: tr('dp.view.board') }]} />
      <SquadBoard o={o} onOpen={(id) => { setOpenId(id); setView('plans'); }} />
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <Seg value={view} onChange={setView} color={c.violet} options={[{ value: 'plans', label: tr('dp.view.plans') }, { value: 'board', label: tr('dp.view.board') }]} />
      <Panel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}><T weight="800" size={17}>{tr('dp.title')}</T><T size={12} color={c.mute}>{tr('dp.subtitle')}</T></View>
          {!archived ? <Btn small title={tr('dp.new_plan')} onPress={() => setForm(true)} /> : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <Kpi label={tr('dp.sum.plans')} value={sums.plans} sub={tr('dp.sum.plans_sub')} />
          <Kpi label={tr('dp.sum.behind')} value={sums.behind} tone={sums.behind ? 'alert' : undefined} sub={tr('dp.sum.behind_sub')} />
          <Kpi label={tr('dp.sum.nodata')} value={sums.nodata} sub={tr('dp.sum.nodata_sub')} />
          <Kpi label={tr('dp.sum.reviews')} value={sums.review} tone={sums.review ? 'alert' : undefined} sub={tr('dp.sum.reviews_sub')} />
          <Kpi label={tr('dp.sum.tasks')} value={sums.tasks} tone={sums.tasks ? 'alert' : undefined} sub={tr('dp.sum.tasks_sub')} />
        </View>
        <Field value={q} onChangeText={setQ} placeholder={tr('dp.search')} accessibilityLabel={tr('dp.search')} />
        <Seg value={status} onChange={setStatus} color={c.violet} options={['all', 'active', 'in_review', 'draft', 'closed'].map((x) => ({ value: x, label: x === 'all' ? tr('dp.all') : tr(`dp.status.${x}`) }))} />
      </Panel>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : items.length ? (
        <View style={{ gap: 10, flexDirection: tablet ? 'row' : 'column', flexWrap: 'wrap' }}>
          {items.map((x) => (
            <Pressable key={x.id} onPress={() => setOpenId(x.id)} accessibilityRole="button" accessibilityLabel={tr('dp.open_plan_for', { name: x.athlete_name, season: x.season_label })} style={{ flexBasis: tablet ? '48%' : undefined, flexGrow: 1, minWidth: 0 }}>
              <Panel>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Initials name={x.athlete_name} user={x.athlete} size={44} />
                  <View style={{ flex: 1 }}><T weight="800" size={15}>{x.athlete_name}</T><T size={12} color={c.mute}>{x.sport} · {x.season_label} · {tr('dp.lead_is', { name: x.lead.display_name })}</T></View>
                  <Tag label={tr(`dp.status.${x.status}`)} color={STATUS_TONE[x.status]} />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{DOMAINS.map((d) => <Tag key={d} label={chipCount(d, x.domain_counts[d])} color={x.domain_counts[d] ? c.cyan : c.violetSoft} />)}</View>
                {x.strip.objectives ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <StateTag state="on_track" /><T size={12} weight="800">{countsOf(x.strip).on_track}</T>
                    <StateTag state="behind" /><T size={12} weight="800">{x.strip.behind}</T>
                    <StateTag state="no_data" /><T size={12} weight="800">{x.strip.no_data}</T>
                  </View>
                ) : <T size={12} color={c.mute}>{tr('dp.no_objectives_yet')}</T>}
                <T size={12} color={x.strip.review_overdue || x.strip.interventions_overdue ? c.orange : c.mute} weight={x.strip.review_overdue ? '800' : '500'}>
                  {x.strip.review_in_progress ? tr('dp.review_in_progress') : x.strip.review_overdue ? tr('dp.review_overdue_on', { date: when(x.strip.next_review_on) }) : tr('dp.next_review', { date: when(x.strip.next_review_on) })}{x.strip.interventions_overdue ? ` · ${tr('dp.kpi.tasks_overdue', { n: x.strip.interventions_overdue })}` : ''}
                </T>
              </Panel>
            </Pressable>
          ))}
        </View>
      ) : <Panel><Empty emoji="🧭" title={q || status !== 'all' ? tr('dp.none_match') : tr('dp.none')} sub={q || status !== 'all' ? tr('dp.none_match_sub') : role === 'coach' ? tr('dp.none_sub_coach') : tr('dp.none_sub')} /></Panel>}
      <FormSheet visible={form} onClose={() => setForm(false)} title={tr('dp.new_plan')} submitLabel={tr('dp.create')} notice={tr('dp.new_notice')}
        initial={{ season_label: seasonDefault(), from: todayStr(), to: addMonths(todayStr(), 10), lead_id: me?.id, review_every_days: 42 }}
        fields={[menu('athlete_id', tr('dp.field.athlete'), athlete.map((a) => ({ value: a.id, label: a.display_name, sub: [a.sports?.join(', '), a.groups].filter(Boolean).join(' · ') })), { hint: tr('dp.field.athlete_hint') }),
          { key: 'season_label', label: tr('dp.field.season') }, { key: 'from', toKey: 'to', label: tr('dp.field.window'), type: 'daterange' },
          menu('lead_id', tr('dp.field.lead'), peopleOpts.filter((x) => (opts.data?.people ?? []).some((p) => p.user_id === x.value)), { hint: tr('dp.field.lead_hint') }),
          { key: 'review_every_days', label: tr('dp.field.rhythm'), type: 'stepper', min: 7, max: 180, step: 7, suffix: ` ${tr('dp.days')}`, hint: tr('dp.field.rhythm_hint') },
          { key: 'focus', label: tr('dp.field.focus'), type: 'multiline', optional: true, hint: tr('dp.field.focus_hint') }]}
        onSubmit={async (x) => {
          if (!x.athlete_id) throw new Error(tr('dp.err.athlete'));
          const r = await api.post(`/organisations/${o.id}/academy/dev-plans`, { athlete_id: x.athlete_id, season_label: x.season_label, starts_on: x.from, ends_on: x.to, lead_id: x.lead_id || undefined, review_every_days: x.review_every_days, focus: x.focus || undefined, idempotency_key: key('plan') });
          list.reload(); setOpenId(r.id); return tr('dp.created');
        }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ athlete / guardian side
export function FamilyDevPlans({ athlete, toast }) {
  const q = athlete.is_me ? undefined : { athlete_id: athlete.id };
  const d = useLoad(() => api.get('/academy/my-dev-plans', q), [athlete.id]);
  const [openId, setOpenId] = useState(null);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  if (!d.data.length) return <Panel><Empty emoji="🧭" title={tr('dp.family_none')} sub={tr('dp.family_none_sub')} /></Panel>;
  if (openId) return <View style={{ gap: 12 }}><View style={{ flexDirection: 'row' }}><Btn small title={backText()} color={c.paper} ink={c.ink} onPress={() => setOpenId(null)} /></View><PlanDetail id={openId} family toast={toast} onChanged={d.reload} /></View>;
  return (
    <View style={{ gap: 10 }}>
      {d.data.map((x) => (
        <Pressable key={x.id} onPress={() => setOpenId(x.id)} accessibilityRole="button" accessibilityLabel={tr('dp.open_plan_family', { org: x.organisation, season: x.season_label })}>
          <Panel>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1 }}><T weight="800" size={16}>{x.organisation}</T><T size={12} color={c.mute}>{x.sport} · {tr('dp.season', { label: x.season_label })} · {tr('dp.lead_is', { name: x.lead.display_name })}</T></View><Tag label={tr(`dp.status.${x.status}`)} color={STATUS_TONE[x.status]} /></View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}><StateTag state="on_track" /><T size={12} weight="800">{countsOf(x.strip).on_track}</T><StateTag state="behind" /><T size={12} weight="800">{x.strip.behind}</T><StateTag state="no_data" /><T size={12} weight="800">{x.strip.no_data}</T></View>
            {x.latest_review ? <T size={12} color={c.mute}>{tr('dp.latest_review', { date: when(x.latest_review.period_to) })}</T> : <T size={12} color={c.mute}>{tr('dp.no_review_yet')}</T>}
          </Panel>
        </Pressable>
      ))}
    </View>
  );
}
