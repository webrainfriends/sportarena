// Academy Curriculum (#782): the performance board, versioned curricula with periodisation and Technical-Director approval, and the methodology
// library. Configuration and evidence only: sessions stay in Operations, lesson plans in the coach's own coaching tools (the session screen loads
// an objective's approved drills into that plan) and measurement in Coach Performance Studio rubrics. The server decides what each role may do.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { Block, Fact, Split, saveCsv, when } from './academy-ui';
import { Library, slugOf } from './academy-methodology';
import { Studio } from './academy-curriculum-studio';
import { Planner } from './academy-curriculum-planner';
import { Diff, Eyebrow, Hero, HeatStrip, Mastery, Panel, PhaseTimeline, Pipeline, PILLARS, PILLAR_ICON, PillarBars, Readiness, STATE_TONE, TrendBars, INT_TONE, WrapTabs, lbl } from './academy-curriculum-ui';

export { PILLARS, PILLAR_ICON };
const DEVIATIONS = ['weather', 'venue_unavailable', 'coach_absent', 'athlete_needs', 'low_attendance', 'safeguarding', 'time_overrun', 'schedule_change', 'other'];
export const devOptions = () => DEVIATIONS.map((v) => ({ value: v, label: t(`cur.dev.${v}`) }));
const VERSION_TONE = { published: c.lime, approved: c.cyanSoft, submitted: c.sunSoft, draft: undefined, rejected: c.orangeSoft, superseded: undefined };

/** A progress bar with its number written out, so meaning never rests on colour or length alone. */
export function Gauge({ done, total, label }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <View style={{ gap: 4 }} accessible accessibilityLabel={lbl`${label}: ${done} / ${total}`}>
      <View style={{ height: 10, borderRadius: 6, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 10, backgroundColor: c.lime }} /></View>
      <T size={12} color={c.mute}>{label} · {done} / {total}{total ? ` · ${pct}%` : ''}</T>
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ performance board
function Board({ o, cov, staff, go, pending, toast, reload }) {
  const [rej, setRej] = useState(null);
  if (cov.error) return <ErrorBox error={cov.error} onRetry={cov.reload} />;
  if (!cov.data) return <Loading />;
  const d = cov.data, tt = d.totals, an = d.analytics;
  const decide = async (v, decision, note) => { try { await api.post(`/academy/curriculum-versions/${v.id}/decision`, { decision, note }); toast(t(decision === 'approve' ? 'cur.approved' : 'cur.rejected')); reload(); cov.reload(); } catch (e) { toast(explain(e)); } };
  const dev = d.items.flatMap((x) => x.deviations).reduce((m, x) => ({ ...m, [x.reason]: (m[x.reason] ?? 0) + x.n }), {});
  const devTotal = Object.values(dev).reduce((s, n) => s + n, 0);
  const recorded = an.trend.reduce((s, x) => s + x.delivered + x.deviated, 0);
  const planned = tt.sessions_held ? Math.round(((tt.sessions_held - tt.sessions_without_objective) / tt.sessions_held) * 100) : null;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}><Btn small title={t('cur.export')} color={c.paper} ink={c.ink} onPress={async () => { try { const x = await api.get(`/organisations/${o.id}/academy/curriculum-coverage/export`); await saveCsv(x.filename, x.csv); } catch (e) { toast(explain(e)); } }} /></View>
      <Hero title={t('cur.board.title')} sub={t('cur.board.sub', { n: tt.cohorts })}
        stats={[{ label: t('cur.kpi.coverage'), value: tt.coverage_pct == null ? '–' : `${tt.coverage_pct}%`, sub: `${tt.complete} / ${tt.objectives} ${t('cur.objectives').toLowerCase()}` },
          { label: t('cur.kpi.planned'), value: planned == null ? '–' : `${planned}%`, sub: t('cur.kpi.unplanned_sub', { n: tt.sessions_held }) },
          { label: t('cur.kpi.deviation'), value: recorded ? `${Math.round((devTotal / recorded) * 100)}%` : '–', sub: t('cur.kpi.deviation_sub', { n: devTotal }) },
          ...(staff ? [{ label: t('cur.kpi.waiting'), value: pending.length, sub: t('cur.kpi.waiting_sub') }] : [])]} />
      {staff && pending.length ? (
        <Panel>
          <Block title={t('cur.awaiting')}>
            {pending.map(({ cur, v, rv }) => (
              <View key={v.id} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={15} style={{ flex: 1 }}>{cur.title} · v{v.version}</T>{cur.stage_key ? <Tag label={cur.stage_key} color={c.pinkSoft} /> : null}</View>
                <T size={12} color={c.mute}>{t('cur.submitted_by', { name: v.submitted_by_name ?? '–' })}{v.note ? ` · ${v.note}` : ''}</T>
                {rv ? <><Diff d={rv.diff} against={rv.against} /><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={lbl`${rv.readiness.warnings.length} ${t('cur.ready.warnings')}`} color={rv.readiness.warnings.length ? c.sunSoft : c.lime} /></View><T size={12} color={c.mute}>{t('cur.impact', { g: rv.impact.groups, s: rv.impact.sessions_keep_old_wording })}</T></> : null}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn small title={t('cur.approve')} onPress={() => decide(v, 'approve')} /><Btn small title={t('cur.reject')} color={c.paper} ink={c.ink} onPress={() => setRej(v)} /><Btn small title={t('cur.review_changes')} color={c.paper} ink={c.ink} onPress={() => go('curricula', cur.id)} />
                </View>
              </View>
            ))}
          </Block>
        </Panel>
      ) : null}
      {d.items.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}><Block title={t('cur.board.pillars')}><PillarBars rows={d.by_pillar} /></Block></Panel>
          <Panel style={{ flexGrow: 1, flexBasis: 300 }}><Block title={t('cur.board.trend')}>{an.trend.length ? <TrendBars rows={an.trend} /> : <T size={13} color={c.mute}>{t('cur.board.trend_empty')}</T>}
            <View style={{ flexDirection: 'row', gap: 12 }}>{[[c.lime, 'delivered'], [c.orange, 'deviated']].map(([col, k]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: col }} /><T size={11} color={c.mute}>{t(`cur.legend.${k}`)}</T></View>)}</View></Block></Panel>
        </View>
      ) : null}
      {d.items.length ? d.items.map((it) => (
        <Panel key={it.assignment_id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 180 }}><T weight="800" size={17}>{it.cohort_name}</T><T size={12.5} color={c.mute}>{it.curriculum_title}{it.coach_name ? ` · ${it.coach_name}` : ''}</T></View>
            <Tag label={it.sport} />{it.version ? <Tag label={lbl`v${it.version}`} color={c.pinkSoft} /> : null}
            <View style={{ alignItems: 'flex-end' }}><T size={30} weight="800" style={{ letterSpacing: -1 }}>{it.totals.coverage_pct == null ? '–' : `${it.totals.coverage_pct}%`}</T><T size={11} color={c.mute}>{t('cur.kpi.coverage')}</T></View>
          </View>
          <HeatStrip objectives={it.objectives} />
          <Gauge done={it.totals.complete} total={it.totals.objectives} label={t('cur.objectives_complete')} />
          <T size={12} color={c.mute}>{t('cur.sessions_with', { a: it.totals.sessions_with_objective, b: it.totals.sessions_held })}</T>
          {['core', 'support', 'stretch'].map((pr) => {
            const rows = it.objectives.filter((o) => o.priority === pr);
            return rows.length ? (
              <View key={pr} style={{ gap: 4 }}>
                <Eyebrow>{t(`cur.priority.${pr}`)}</Eyebrow>
                {rows.map((ob) => (
                  <View key={ob.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 }} accessible accessibilityLabel={lbl`${ob.title}: ${t(`cur.state.${ob.state}`)}, ${ob.delivered} / ${ob.sessions_target}`}>
                    <T size={16}>{PILLAR_ICON[ob.pillar] ?? '•'}</T>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T weight="700" size={13}>{ob.title}</T>
                      <T size={11.5} color={c.mute}>{t('cur.delivered_of', { a: ob.delivered, b: ob.sessions_target })}{ob.evidence.blocks_planned ? ` · ${t('cur.blocks_done', { a: ob.evidence.blocks_done, b: ob.evidence.blocks_planned })}` : ''}{ob.rpe_target ? ` · RPE ${ob.rpe_target}` : ''}{ob.inherited ? ` · ${t('cur.inherited')}` : ''}</T>
                      {ob.success_criteria ? <T size={11.5} color={c.mute}>✓ {ob.success_criteria}</T> : null}
                      <Mastery level={ob.mastery_target} />
                    </View>
                    <Tag label={t(`cur.state.${ob.state}`)} color={STATE_TONE[ob.state]} />
                  </View>
                ))}
              </View>
            ) : null;
          })}
          {it.deviations.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{it.deviations.map((x) => <Tag key={x.reason} label={lbl`${t(`cur.dev.${x.reason}`)} · ${x.n}`} color={c.orangeSoft} />)}</View> : null}
        </Panel>
      )) : <Panel><Empty emoji="🧭" title={t('cur.cov_empty')} sub={staff ? t('cur.cov_empty_staff') : t('cur.cov_empty_coach')} />{staff ? <Btn title={t('cur.go_curricula')} onPress={() => go('curricula')} /> : null}</Panel>}
      {an.coaches.length ? (
        <Panel>
          <Block title={t('cur.board.coaches')}>
            <T size={12} color={c.mute}>{t('cur.board.coaches_help')}</T>
            {an.coaches.map((k) => {
              const p1 = k.sessions ? Math.round((k.with_objective / k.sessions) * 100) : 0, p2 = k.mapped ? Math.round((k.recorded / k.mapped) * 100) : null;
              return (
                <View key={k.coach_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, flexWrap: 'wrap' }} accessible accessibilityLabel={lbl`${k.coach_name}: ${p1}% ${t('cur.board.sessions_planned')}, ${p2 ?? '–'}% ${t('cur.board.outcomes_recorded')}`}>
                  <T weight="700" size={13} style={{ flex: 1, minWidth: 120 }}>{k.coach_name}</T>
                  <Tag label={lbl`${t('cur.board.sessions_planned')} ${p1}%`} color={p1 >= 80 ? c.lime : c.sunSoft} /><Tag label={lbl`${t('cur.board.outcomes_recorded')} ${p2 == null ? '–' : `${p2}%`}`} color={p2 != null && p2 >= 80 ? c.lime : c.sunSoft} />{k.attested ? <Tag label={lbl`${k.attested} ${t('cur.attested')}`} color={c.orangeSoft} /> : null}
                </View>
              );
            })}
          </Block>
        </Panel>
      ) : null}
      {an.drills.length ? <Panel><Block title={t('cur.board.drills')}>{an.drills.map((x) => <Row key={x.key} title={x.title} right={<Tag label={lbl`${x.n}×`} color={c.pinkSoft} />} />)}</Block></Panel> : null}
      <FormSheet visible={!!rej} onClose={() => setRej(null)} title={t('cur.reject_title')} submitLabel={t('cur.reject')} fields={[{ key: 'note', label: t('cur.reject_reason'), type: 'multiline' }]} onSubmit={async (v) => { await decide(rej, 'reject', v.note); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ one curriculum
function Blueprint({ list, onFeedback }) {
  if (!list.length) return <Empty emoji="🧩" title={t('cur.no_objectives')} />;
  return PILLARS.map((p) => {
    const rows = list.filter((x) => (x.pillar ?? 'technical') === p);
    return rows.length ? (
      <View key={p} style={{ gap: 6 }}>
        <Eyebrow>{`${PILLAR_ICON[p]} ${t(`cur.pillar.${p}`)} · ${rows.length}`}</Eyebrow>
        {rows.map((x) => (
          <View key={x.key} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 5 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <T weight="800" size={14} style={{ flex: 1, minWidth: 160 }}>{x.title}</T><Tag label={t(`cur.priority.${x.priority ?? 'core'}`)} color={(x.priority ?? 'core') === 'core' ? c.pinkSoft : undefined} />
              {x.inherited_from ? <Tag label={t('cur.inherited')} color={c.cyanSoft} /> : null}{x.overrides_parent ? <Tag label={t('cur.override')} color={c.sunSoft} /> : null}
            </View>
            <T size={12} color={c.mute}>{x.competency_title} · {t('cur.target_sessions', { n: x.sessions_target ?? 1 })}{x.rpe_target ? ` · RPE ${x.rpe_target}` : ''}</T>
            <Mastery level={x.mastery_target} />
            {x.success_criteria ? <T size={12.5}>✓ {x.success_criteria}</T> : null}
            {x.drills?.length ? <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{x.drills.map((d) => <Tag key={d.key} label={d.title} color={c.cyanSoft} />)}</View> : null}
            {x.phase_keys?.length ? <T size={11.5} color={c.mute}>{t('cur.runs_in', { n: x.phase_keys.length })}</T> : null}
            {x.guardian_summary ? <T size={12} color={c.mute}>“{x.guardian_summary}”</T> : null}
            {onFeedback ? <Btn small title={t('cur.fb.give')} color={c.paper} ink={c.ink} style={{ alignSelf: 'flex-start' }} onPress={() => onFeedback(x)} /> : null}
          </View>
        ))}
      </View>
    ) : null;
  });
}

/** Coach feedback on this curriculum, with the Technical Director's resolution. Coaches see their own; directors resolve. */
function Feedback({ curriculumId, orgId, staff, toast }) {
  const f = useLoad(() => api.get(`/organisations/${orgId}/academy/curriculum-feedback`, { curriculum_id: curriculumId }), [orgId, curriculumId]);
  const [res, setRes] = useState(null);
  const resolve = async (x, status, note) => { try { await api.post(`/academy/curriculum-feedback/${x.id}/resolve`, { status, note: note || undefined }); toast(t('cur.fb.resolved')); f.reload(); } catch (e) { toast(explain(e)); } };
  if (!f.data) return null;
  return (
    <Block title={lbl`${t('cur.fb.title')}${f.data.filter((x) => x.status === 'open').length ? ` · ${f.data.filter((x) => x.status === 'open').length}` : ''}`}>
      {f.data.length ? f.data.map((x) => (
        <View key={x.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Tag label={t(`cur.fb.k.${x.kind}`)} color={c.sunSoft} />{x.objective_key ? <Tag label={x.objective_key} /> : null}<T size={12} color={c.mute} style={{ flex: 1 }}>{x.author_name} · {when(x.created_at)}</T><Tag label={t(`cur.fb.s.${x.status}`)} color={x.status === 'open' ? c.sunSoft : x.status === 'declined' ? c.orangeSoft : c.lime} /></View>
          <T size={13}>{x.note}</T>{x.resolution_note ? <T size={12} color={c.mute}>↳ {x.resolution_note}</T> : null}
          {staff && x.status === 'open' ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn small title={t('cur.fb.accept')} onPress={() => resolve(x, 'accepted')} /><Btn small title={t('cur.fb.decline')} color={c.paper} ink={c.ink} onPress={() => setRes(x)} /><Btn small title={t('cur.fb.done')} color={c.paper} ink={c.ink} onPress={() => resolve(x, 'done')} /></View> : null}
        </View>
      )) : <T size={13} color={c.mute}>{t('cur.fb.none')}</T>}
      <FormSheet visible={!!res} onClose={() => setRes(null)} title={t('cur.fb.decline')} submitLabel={t('cur.fb.decline')} fields={[{ key: 'note', label: t('cur.reject_reason'), type: 'multiline' }]} onSubmit={async (v) => { await resolve(res, 'declined', v.note); }} />
    </Block>
  );
}

function CurriculumDetail({ id, o, staff, archived, toast, onChanged, onOpen, studio, onStudio }) {
  const d = useLoad(() => api.get(`/academy/curricula/${id}`), [id]);
  const cohorts = useLoad(() => (staff ? api.get(`/organisations/${o.id}/cohorts`, { limit: 100 }) : Promise.resolve([])), [o.id, staff]);
  const members = useLoad(() => (staff ? api.get(`/organisations/${o.id}/members`, { limit: 100 }) : Promise.resolve([])), [o.id, staff]);
  const seasons = useLoad(() => (staff ? api.get(`/organisations/${o.id}/seasons`, { limit: 50 }) : Promise.resolve([])), [o.id, staff]);
  const [sub, setSub] = useState('blueprint');
  const [mode, setMode] = useState(null);   // 'studio' | 'assign' | 'review' | 'reject'
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { curriculum: cur, versions, objectives, assignments, reviews, in_force: inForce, open_review: rv } = d.data;
  const openV = versions.find((v) => ['draft', 'submitted', 'approved'].includes(v.status));
  const shown = versions.find((v) => v.id === (openV ?? inForce)?.id) ?? versions[0];
  const phases = (openV ?? shown)?.phases ?? [];
  const refresh = () => { d.reload(); onChanged(); };
  const call = async (path, body, ok) => { try { await api.post(path, body ?? {}); toast(ok); refresh(); } catch (e) { toast(e?.details?.blockers ? t('cur.not_ready') : explain(e)); setSub('approval'); } };
  const canWrite = staff && !archived;
  const coaches = members.data?.filter((m) => ['owner', 'admin', 'coach'].includes(m.org_role)) ?? [];
  if (studio) return <Studio cur={cur} d={d.data} o={o} toast={toast} onClose={() => { onStudio(false); refresh(); }} />;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Tag label={cur.sport} />{cur.stage_key ? <Tag label={cur.stage_key} color={c.pinkSoft} /> : null}{cur.level_key ? <Tag label={cur.level_key} color={c.pinkSoft} /> : null}
        {cur.age_min != null || cur.age_max != null ? <Tag label={t('cur.ages', { a: cur.age_min ?? '–', b: cur.age_max ?? '–' })} color={c.cyanSoft} /> : null}
        {cur.season_name ? <Tag label={cur.season_name} color={c.sunSoft} /> : null}{cur.campus_name ? <Tag label={lbl`📍 ${cur.campus_name}`} color={c.mintSoft} /> : null}
      </View>
      {cur.parent_title ? <T size={12} color={c.mute}>{t('cur.inherits_from', { name: cur.parent_title })}</T> : null}
      <Fact k={t('cur.methodology')} v={`${d.data.methodology.title} · v${d.data.methodology.version ?? '–'}`} />
      <Fact k={t('cur.in_force')} v={inForce ? `v${inForce.version} · ${when(inForce.effective_from)}` : t('cur.none_published')} />
      {d.data.needs_ack ? (
        <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.sunSoft, gap: 6 }}><T weight="800" size={13}>{t('cur.ack.title', { v: inForce.version })}</T><T size={12}>{t('cur.ack.help')}</T><Btn small title={t('cur.ack.confirm')} onPress={() => call(`/academy/curriculum-versions/${d.data.in_force_id}/acknowledge`, {}, t('cur.ack.done'))} /></View>
      ) : null}
      {canWrite ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{!openV || openV.status === 'draft' ? <Btn small title={openV ? t('cur.continue_draft') : t('cur.new_version')} onPress={() => onStudio(true)} /> : null}{cur.current_version ? <Btn small title={t('cur.rollover')} color={c.paper} ink={c.ink} onPress={() => setMode('rollover')} /> : null}</View> : null}
      <WrapTabs value={sub} onChange={setSub} options={[{ value: 'blueprint', label: t('cur.sub.blueprint') }, { value: 'periodisation', label: t('cur.sub.periodisation') }, { value: 'approval', label: `${t('cur.sub.approval')}${openV ? ' •' : ''}` }, { value: 'groups', label: t('cur.sub.groups') }]} />

      {sub === 'blueprint' ? <Blueprint list={openV ? d.data.open_objectives : objectives} onFeedback={!openV && inForce && !archived ? (x) => setMode({ fb: x }) : null} /> : null}

      {sub === 'periodisation' ? (
        <Block title={t('cur.sub.periodisation')}>
          {phases.length ? <><PhaseTimeline phases={phases} />{phases.map((p) => (
            <View key={p.key} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 3 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{p.title}</T><Tag label={t(`cur.intensity.${p.intensity}`)} color={INT_TONE[p.intensity]} /></View>
              <T size={12} color={c.mute}>{when(p.starts_on)} – {when(p.ends_on)}</T>
              {p.focus_keys?.length ? <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{p.focus_keys.map((k) => <Tag key={k} label={d.data.methodology.competencies.find((x) => x.key === k)?.title ?? k} color={c.pinkSoft} />)}</View> : null}
              {p.note ? <T size={12}>{p.note}</T> : null}
            </View>))}</> : <Empty emoji="🗓️" title={t('cur.no_phases')} sub={t('cur.no_phases_sub')} />}
        </Block>
      ) : null}

      {sub === 'approval' ? (
        <View style={{ gap: 12 }}>
          {openV ? (
            <Panel>
              <T weight="800" size={14}>{t('cur.version_status', { v: openV.version, s: t(`cur.vs.${openV.status}`) })}</T>
              <Pipeline v={openV} />
              {openV.decision_note ? <T size={12.5}>{openV.decision_note}</T> : null}
              {rv ? <><Eyebrow>{t('cur.ready.title')}</Eyebrow><Readiness r={rv.readiness} /><Eyebrow>{t('cur.diff.title')}</Eyebrow><Diff d={rv.diff} against={rv.against} /><T size={12} color={c.mute}>{t('cur.impact', { g: rv.impact.groups, s: rv.impact.sessions_keep_old_wording })}</T></> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {canWrite && openV.status === 'draft' ? <Btn small title={t('cur.submit')} disabled={rv && !rv.readiness.ready} onPress={() => call(`/academy/curriculum-versions/${openV.id}/submit`, {}, t('cur.submitted'))} /> : null}
                {canWrite && openV.status === 'submitted' ? <><Btn small title={t('cur.approve')} onPress={() => call(`/academy/curriculum-versions/${openV.id}/decision`, { decision: 'approve' }, t('cur.approved'))} /><Btn small title={t('cur.reject')} color={c.paper} ink={c.ink} onPress={() => setMode('reject')} /></> : null}
                {canWrite && openV.status === 'approved' ? <Btn small title={t('cur.publish')} onPress={() => call(`/academy/curriculum-versions/${openV.id}/publish`, {}, t('cur.published'))} /> : null}
              </View>
            </Panel>
          ) : <T size={13} color={c.mute}>{t('cur.no_open_version')}</T>}
          <Block title={t('cur.versions')}>
            {versions.map((v) => (
              <View key={v.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T weight="700" size={13} style={{ flex: 1 }}>v{v.version} · {when(v.effective_from)}{v.effective_to ? ` – ${when(v.effective_to)}` : ''}</T>
                <Tag label={t(`cur.vs.${v.status}`)} color={VERSION_TONE[v.status]} />{v.self_approved ? <Tag label={t('cur.self_approved')} color={c.sunSoft} /> : null}
              </View>
            ))}
            <T size={11} color={c.mute}>{t('cur.history_note')}</T>
          </Block>
        </View>
      ) : null}

      {sub === 'groups' ? (
        <View style={{ gap: 12 }}>
          <Block title={t('cur.assignments')} right={canWrite && cur.current_version ? <Btn small title={t('cur.assign')} color={c.paper} ink={c.ink} onPress={() => setMode('assign')} /> : null}>
            {assignments.length ? assignments.map((a) => <Row key={a.id} title={a.cohort_name} sub={`${a.coach_name ?? t('cur.no_coach')} · ${t('cur.athletes_n', { n: a.athletes })}${a.acknowledged === true ? ` · ✓ ${t('cur.ack.read')}` : a.acknowledged === false ? ` · ${t('cur.ack.unread')}` : ''}`} right={canWrite ? <Btn small title={t('cur.end')} color={c.paper} ink={c.ink} onPress={() => call(`/academy/curriculum-assignments/${a.id}/end`, {}, t('cur.ended'))} /> : null} />)
              : <T size={13} color={c.mute}>{cur.current_version ? t('cur.no_assignments') : t('cur.publish_first')}</T>}
          </Block>
          <Feedback curriculumId={cur.id} orgId={o.id} staff={canWrite} toast={toast} />
          {staff ? (
            <Block title={t('cur.reviews')} right={canWrite && cur.current_version ? <Btn small title={t('cur.review_now')} color={c.paper} ink={c.ink} onPress={() => setMode('review')} /> : null}>
              {reviews.length ? reviews.map((r) => <Row key={r.id} title={t(`cur.review.${r.outcome}`)} sub={`${r.reviewer_name} · ${when(r.created_at)}${r.note ? ` · ${r.note}` : ''}${r.coverage?.cohorts?.[0]?.coverage_pct != null ? ` · ${r.coverage.cohorts[0].coverage_pct}%` : ''}`} />) : <T size={13} color={c.mute}>{t('cur.no_reviews')}</T>}
            </Block>
          ) : null}
        </View>
      ) : null}

      <FormSheet visible={!!mode?.fb} onClose={() => setMode(null)} title={mode?.fb?.title ?? ''} submitLabel={t('cur.fb.send')} initial={{ kind: 'suggestion' }}
        fields={[{ key: 'kind', label: t('cur.fb.kind'), type: 'chips', options: ['too_easy', 'too_hard', 'too_long', 'unclear', 'missing_drill', 'suggestion', 'other'].map((v) => ({ value: v, label: t(`cur.fb.k.${v}`) })) }, { key: 'note', label: t('cur.f.note'), type: 'multiline', hint: t('cur.fb.hint') }]}
        onSubmit={async (v) => { await api.post(`/academy/curricula/${cur.id}/feedback`, { objective_key: mode.fb.key, kind: v.kind, note: v.note }); refresh(); return t('cur.fb.sent'); }} />
      <FormSheet visible={mode === 'rollover'} onClose={() => setMode(null)} title={t('cur.rollover')} submitLabel={t('cur.rollover')} initial={{ title: `${cur.title} · ${new Date().getFullYear() + 1}`, shift_days: 365 }}
        fields={[{ key: 'title', label: t('cur.f.title') }, { key: 'season_id', label: t('cur.f.season'), type: 'chips', optional: true, options: (seasons.data ?? []).map((x) => ({ value: x.id, label: x.name })) }, { key: 'shift_days', label: t('cur.rollover_shift'), type: 'stepper', min: -3650, max: 3650, step: 7, default: 365, suffix: ` ${t('cur.days')}`, hint: t('cur.rollover_hint') }]}
        onSubmit={async (v) => { const r = await api.post(`/academy/curricula/${cur.id}/rollover`, { title: v.title, season_id: v.season_id || undefined, shift_days: v.shift_days ?? 365 }); onChanged(); onOpen?.(r.curriculum.id); return t('cur.rollover_done'); }} />
      <FormSheet visible={mode === 'assign'} onClose={() => setMode(null)} title={t('cur.assign')} submitLabel={t('cur.assign')}
        fields={[{ key: 'cohort_id', label: t('cur.f.cohort'), type: 'chips', options: (cohorts.data ?? []).map((k) => ({ value: k.id, label: `${k.name} (${k.enrolled})` })) },
          { key: 'coach_id', label: t('cur.f.coach'), type: 'chips', optional: true, options: coaches.map((m) => ({ value: m.id, label: m.display_name })) }]}
        onSubmit={async (v) => { await api.post(`/academy/curricula/${cur.id}/assignments`, { cohort_id: v.cohort_id, coach_id: v.coach_id || undefined }); refresh(); return t('cur.assigned'); }} />
      <FormSheet visible={mode === 'reject'} onClose={() => setMode(null)} title={t('cur.reject_title')} submitLabel={t('cur.reject')} fields={[{ key: 'note', label: t('cur.reject_reason'), type: 'multiline' }]}
        onSubmit={async (v) => { await api.post(`/academy/curriculum-versions/${openV.id}/decision`, { decision: 'reject', note: v.note }); refresh(); return t('cur.rejected'); }} />
      <FormSheet visible={mode === 'review'} onClose={() => setMode(null)} title={t('cur.review_now')} submitLabel={t('common.save')} initial={{ outcome: 'on_track' }}
        fields={[{ key: 'outcome', label: t('cur.f.outcome'), type: 'chips', options: ['on_track', 'needs_attention', 'revise'].map((v) => ({ value: v, label: t(`cur.review.${v}`) })) }, { key: 'note', label: t('cur.f.note'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post(`/academy/curricula/${cur.id}/reviews`, { outcome: v.outcome, note: v.note || undefined }); refresh(); return t('cur.review_saved'); }} />
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ curricula list
function Curricula({ o, staff, archived, toast, focusId, list }) {
  const [open, setOpen] = useState(focusId ?? null);
  const [studio, setStudio] = useState(false);
  const [form, setForm] = useState(false);
  const meths = useLoad(() => api.get(`/organisations/${o.id}/academy/methodologies`), [o.id]);
  const seasons = useLoad(() => (staff ? api.get(`/organisations/${o.id}/seasons`, { limit: 50 }) : Promise.resolve([])), [o.id, staff]);
  const venues = useLoad(() => (staff ? api.get(`/organisations/${o.id}/assets`, { kind: 'venue' }).catch(() => []) : Promise.resolve([])), [o.id, staff]);
  const paths = useLoad(() => (staff ? api.get(`/organisations/${o.id}/academy/pathways`).catch(() => []) : Promise.resolve([])), [o.id, staff]);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const usable = (meths.data ?? []).filter((m) => m.current_version > 0);
  const sel = list.data.find((x) => x.id === open);
  const bySport = [...new Set(list.data.map((k) => k.sport))];
  const body = (
    <View style={{ gap: 10 }}>
      {staff && !archived ? <Btn title={t('cur.new_curriculum')} onPress={() => setForm(true)} disabled={!usable.length} /> : null}
      {staff && !usable.length ? <T size={12} color={c.mute}>{t('cur.need_methodology')}</T> : null}
      {bySport.map((sp) => (
        <View key={sp} style={{ gap: 8 }}>
          <Eyebrow>{sp}</Eyebrow>
          {list.data.filter((k) => k.sport === sp).map((k) => (
            <Pressable key={k.id} onPress={() => setOpen(k.id)} accessibilityRole="button" accessibilityLabel={lbl`${k.title}, ${k.sport}`}>
              <Card pad={14} color={open === k.id ? c.pinkSoft : c.paper}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <T weight="800" size={15} style={{ flex: 1 }}>{k.title}</T>
                  {k.open_version ? <Tag label={t(`cur.vs.${k.open_version.status}`)} color={k.open_version.status === 'submitted' ? c.sunSoft : undefined} /> : null}
                  {k.published ? <Tag label={lbl`v${k.published.version}`} color={c.lime} /> : <Tag label={t('cur.vs.draft')} />}
                </View>
                <T size={12} color={c.mute}>{k.stage_key ? `${k.stage_key} · ` : ''}{k.level_key ? `${k.level_key} · ` : ''}{k.age_min != null || k.age_max != null ? `${t('cur.ages', { a: k.age_min ?? '–', b: k.age_max ?? '–' })} · ` : ''}{k.season_name ? `${k.season_name} · ` : ''}{k.campus_name ? `📍 ${k.campus_name} · ` : ''}{t('cur.assignments_n', { n: k.assignments })}</T>
                {k.parent_title ? <T size={11} color={c.mute}>↳ {t('cur.inherits_from', { name: k.parent_title })}</T> : null}
                {k.last_review ? <Tag label={t(`cur.review.${k.last_review}`)} color={k.last_review === 'on_track' ? c.lime : c.sunSoft} style={{ alignSelf: 'flex-start', marginTop: 4 }} /> : null}
              </Card>
            </Pressable>
          ))}
        </View>
      ))}
      {!list.data.length ? <Empty emoji="📚" title={t('cur.empty_title')} sub={staff ? t('cur.empty_staff') : t('cur.empty_coach')} /> : null}
    </View>
  );
  if (studio && open) return <CurriculumDetail key={`s${open}`} id={open} o={o} staff={staff} archived={archived} toast={toast} onChanged={list.reload} onOpen={setOpen} studio onStudio={setStudio} />;
  return (
    <>
      <Split list={body} open={!!open} onClose={() => setOpen(null)} detailTitle={sel?.title} detail={open ? <CurriculumDetail key={open} id={open} o={o} staff={staff} archived={archived} toast={toast} onChanged={list.reload} onOpen={setOpen} studio={false} onStudio={setStudio} /> : null} />
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('cur.new_curriculum')} submitLabel={t('cur.create')} initial={{ methodology_id: usable[0]?.id }}
        fields={[{ key: 'sec1', type: 'section', label: t('cur.sec.scope') },
          { key: 'title', label: t('cur.f.title') },
          { key: 'methodology_id', label: t('cur.methodology'), type: 'chips', options: usable.map((m) => ({ value: m.id, label: `${m.sport} · ${m.title}` })) },
          { key: 'stage_key', label: t('cur.f.stage'), type: 'chips', optional: true, hint: t('cur.f.stage_hint'), options: (v) => (usable.find((m) => m.id === v.methodology_id)?.stage_list ?? []).map((s) => ({ value: s.key, label: `${s.title}${s.age_min != null ? ` · ${s.age_min}–${s.age_max ?? '+'}` : ''}` })) },
          { key: 'has_age', label: t('cur.f.age_band'), type: 'switch' }, { key: 'age_min', label: t('cur.f.age_from'), type: 'stepper', min: 3, max: 99, default: 8, show: (v) => v.has_age }, { key: 'age_max', label: t('cur.f.age_to'), type: 'stepper', min: 3, max: 99, default: 12, show: (v) => v.has_age },
          { key: 'sec2', type: 'section', label: t('cur.sec.where') },
          { key: 'season_id', label: t('cur.f.season'), type: 'chips', optional: true, options: (seasons.data ?? []).map((s) => ({ value: s.id, label: s.name })) },
          { key: 'venue_id', label: t('cur.f.campus'), type: 'chips', optional: true, options: (venues.data ?? []).map((x) => ({ value: x.id, label: x.name })) },
          { key: 'sec3', type: 'section', label: t('cur.sec.links') },
          { key: 'parent_id', label: t('cur.f.parent'), type: 'chips', optional: true, hint: t('cur.f.parent_hint'), options: (v) => list.data.filter((k) => k.methodology_id === v.methodology_id).map((k) => ({ value: k.id, label: k.title })) },
          { key: 'pathway_id', label: t('cur.f.pathway'), type: 'chips', optional: true, options: (paths.data ?? []).map((p) => ({ value: p.id, label: p.title })) },
          { key: 'level_key', label: t('cur.f.level'), type: 'chips', optional: true, show: (v) => !!v.pathway_id, options: (v) => ((paths.data ?? []).find((p) => p.id === v.pathway_id)?.levels ?? []).map((l) => ({ value: l.key, label: l.title })) }]}
        onSubmit={async (v) => {
          const r = await api.post(`/organisations/${o.id}/academy/curricula`, { title: v.title, methodology_id: v.methodology_id, stage_key: v.stage_key || undefined, parent_id: v.parent_id || undefined, season_id: v.season_id || undefined, venue_id: v.venue_id || undefined, pathway_id: v.pathway_id || undefined, level_key: v.level_key || undefined, age_min: v.has_age ? v.age_min ?? 8 : undefined, age_max: v.has_age ? v.age_max ?? 12 : undefined });
          list.reload(); setOpen(r.id); return t('cur.created');
        }} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ the tab
export function Curriculum({ o, role, archived, toast, focus }) {
  const [tab, setTab] = useState(focus?.open ? 'curricula' : 'overview');
  const [focusId, setFocusId] = useState(focus?.open ?? null);
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/curricula`), [o.id]);
  const cov = useLoad(() => api.get(`/organisations/${o.id}/academy/curriculum-coverage`), [o.id]);
  const staff = role === 'owner' || role === 'admin' || !!cov.data?.can_govern;
  const waiting = (list.data ?? []).filter((k) => k.open_version?.status === 'submitted');
  const pending = useLoad(async () => {
    if (!staff || !waiting.length) return [];
    return Promise.all(waiting.map(async (k) => { const x = await api.get(`/academy/curricula/${k.id}`); return { cur: k, v: x.versions.find((v) => v.status === 'submitted'), rv: x.open_review }; }));
  }, [waiting.map((k) => k.id).join(','), staff]);
  const go = (to, id) => { setTab(to); if (id) setFocusId(id); };
  const options = [{ value: 'overview', label: t('cur.tab.overview') }, { value: 'plan', label: t('cur.tab.plan') }, { value: 'curricula', label: t('cur.tab.curricula') }, { value: 'library', label: t('cur.tab.library') }];
  return (
    <View style={{ gap: 12 }}>
      <Seg value={tab} onChange={setTab} color={c.violet} options={options} />
      {tab === 'overview' ? <Board o={o} cov={cov} staff={staff} go={go} pending={(pending.data ?? []).filter((x) => x.v)} toast={toast} reload={() => { list.reload(); cov.reload(); }} /> : null}
      {tab === 'plan' ? <Planner o={o} toast={toast} archived={archived} /> : null}
      {tab === 'curricula' ? <Curricula o={o} staff={staff} archived={archived} toast={toast} focusId={focusId} list={list} /> : null}
      {tab === 'library' ? <Library o={o} staff={staff} archived={archived} toast={toast} /> : null}
    </View>
  );
}
