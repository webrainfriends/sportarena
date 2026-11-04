// Development plan: the guided objective builder, the season timeline and the squad board. All three read the API (frameworks, evidence, anonymised
// peer quartiles, projections, attention rules); nothing here computes a judgement of its own. Shared primitives only, so it runs on web, iOS, iPadOS and Android.
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Field, Loading, Sheet, T, Tag } from '../ui';
import { DateField } from '../pickers';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t as tr } from '../i18n';
import { Initials, Kpi, when } from './academy-ui';
import { DOMAINS, DOMAIN_ICON, figure, stateMeta } from './dev-plan-trend';

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const pct = (d, a, b) => Math.min(100, Math.max(0, ((new Date(`${d}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / (new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`))) * 100));
const TONE = { mute: c.mute, cyan: c.cyan, lime: c.lime, orange: c.orange };
const Card = ({ children, on, onPress, label, style }) => (
  <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} accessibilityLabel={label} onPress={onPress} style={[{ padding: 14, borderRadius: 16, backgroundColor: on ? c.violetSoft : c.paper, borderWidth: 2, borderColor: on ? c.ink : c.line, gap: 4, minHeight: 56 }, style]}>{children}</Pressable>
);
const BAND = { top_quartile: 'dp.band.top_quartile', upper_middle: 'dp.band.upper_middle', lower_middle: 'dp.band.lower_middle', bottom_quartile: 'dp.band.bottom_quartile' };

/** A value scale with the peer quartile band, the athlete's dot and the proposed target, labels always printed. */
function PeerScale({ evidence, benchmark, target }) {
  const pts = [evidence.value, target, benchmark.q1, benchmark.q3, benchmark.median].filter((x) => x !== null && x !== undefined).map(Number);
  const lo = Math.min(...pts), hi = Math.max(...pts), pad = (hi - lo || 1) * 0.15, a = lo - pad, b = hi + pad;
  const at = (v) => `${Math.round(((Number(v) - a) / (b - a)) * 1000) / 10}%`;
  return (
    <View accessible accessibilityLabel={tr('dp.b.scale_label', { value: figure(evidence.value), q1: figure(benchmark.q1), median: figure(benchmark.median), q3: figure(benchmark.q3), peers: benchmark.peers })} style={{ gap: 6, paddingVertical: 6 }}>
      <View style={{ height: 16, borderRadius: 8, backgroundColor: c.line }}>
        <View style={{ position: 'absolute', start: at(benchmark.q1), width: `${((benchmark.q3 - benchmark.q1) / (b - a)) * 100}%`, height: 16, borderRadius: 8, backgroundColor: c.cyanSoft, borderWidth: 1, borderColor: c.cyan }} />
        <View style={{ position: 'absolute', start: at(benchmark.median), width: 2, height: 16, backgroundColor: c.cyan }} />
        {target != null ? <View style={{ position: 'absolute', start: at(target), width: 3, height: 24, top: -4, borderRadius: 2, backgroundColor: c.ink }} /> : null}
        <View style={{ position: 'absolute', start: at(evidence.value), width: 16, height: 16, marginStart: -8, borderRadius: 8, backgroundColor: c.pink, borderWidth: 3, borderColor: c.paper }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={11} color={c.mute}>{tr('dp.b.q1')} {figure(benchmark.q1)}</T><T size={11} color={c.mute}>{tr('dp.b.median')} {figure(benchmark.median)}</T><T size={11} color={c.mute}>{tr('dp.b.q3')} {figure(benchmark.q3)}</T>
      </View>
    </View>
  );
}

const STEPS = ['domain', 'competency', 'target', 'support', 'review'];

export function ObjectiveBuilder({ visible, onClose, plan, view, opts, onCreated, toast }) {
  const [step, setStep] = useState(0), [domain, setDomain] = useState(null), [comp, setComp] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const [f, setF] = useState({ title: '', target: '', owner_id: undefined, due_on: undefined, visibility: true, milestones: [], tasks: [], useMeasure: true });
  const ins = useLoad(() => (visible && domain ? api.get(`/academy/dev-plans/${plan.id}/insight`, { domain }) : Promise.resolve(null)), [visible, domain, plan.id]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const reset = () => { setStep(0); setDomain(null); setComp(null); setErr(null); setF({ title: '', target: '', owner_id: undefined, due_on: undefined, visibility: true, milestones: [], tasks: [], useMeasure: true }); };
  const close = () => { reset(); onClose(); };
  const people = useMemo(() => [...(opts?.people ?? []), ...(opts?.providers ?? [])].map((p) => ({ value: p.user_id, label: p.display_name, sub: p.job_title ?? p.provider_type ?? p.role })), [opts]);
  const list = ins.data?.competencies ?? [];
  const cur = list.find((x) => x.key === comp);
  const measured = cur?.measure?.kind === 'rubric' && f.useMeasure;
  const end = f.due_on ?? plan.ends_on;
  const season = { min: plan.starts_on, max: plan.ends_on };
  const checkpoints = () => { const a = todayStr() > plan.starts_on ? todayStr() : plan.starts_on, span = Math.max(14, Math.round((new Date(`${end}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5)); return [1, 2, 3, 4].map((k) => ({ title: tr('dp.b.checkpoint', { n: k }), due_on: addDays(a, Math.round((span * k) / 4)) })).filter((m) => m.due_on <= plan.ends_on); };
  const choose = (x) => {
    setComp(x.key);
    setF((o) => ({ ...o, title: tr('dp.b.title_for', { label: x.label }), target: x.suggestion ? String(x.suggestion.target) : '', useMeasure: x.measure.kind === 'rubric', tasks: [], milestones: checkpoints() }));
  };
  const toggleTask = (tk) => set('tasks', f.tasks.some((y) => y.title === tk.title) ? f.tasks.filter((y) => y.title !== tk.title) : [...f.tasks, { kind: tk.kind, title: tk.title, due_on: addDays(todayStr() > plan.starts_on ? todayStr() : plan.starts_on, 21) }]);
  const can = step === 0 ? !!domain : step === 1 ? !!comp : step === 2 ? (!measured || (f.target !== '' && !Number.isNaN(Number(f.target)))) && f.title.trim().length >= 3 : step === 3 ? true : true;
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { domain, competency: cur?.label, competency_key: cur?.key, title: f.title.trim(), visibility: f.visibility ? 'athlete' : 'staff', owner_id: f.owner_id || undefined, due_on: f.due_on || undefined,
        milestones: f.milestones.filter((m) => m.title.trim() && m.due_on).map((m) => ({ title: m.title.trim(), due_on: m.due_on })), tasks: f.tasks.map((x) => ({ kind: x.kind, title: x.title, due_on: x.due_on || undefined, owner_id: f.owner_id || undefined })),
        ...(measured ? { metric_kind: 'rubric', rubric_id: cur.measure.rubric_id, dimension_key: cur.measure.dimension_key, target_value: Number(f.target) } : { metric_kind: 'milestones' }) };
      await api.post(`/academy/dev-plans/${plan.id}/objectives`, body);
      toast?.(tr('dp.saved')); close(); onCreated();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const counts = (d) => (view.domains[d]?.objectives ?? []).length;

  return (
    <Sheet visible={visible} onClose={close} title={tr('dp.b.title')}>
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 6 }} accessible accessibilityLabel={tr('dp.b.step_of', { n: step + 1, total: STEPS.length, name: tr(`dp.b.step.${STEPS[step]}`) })}>
          {STEPS.map((s, k) => <View key={s} style={{ flex: 1, gap: 4 }}><View style={{ height: 6, borderRadius: 3, backgroundColor: k <= step ? c.pink : c.line }} /><T size={10} weight={k === step ? '800' : '500'} color={k === step ? c.ink : c.mute} numberOfLines={1}>{tr(`dp.b.step.${s}`)}</T></View>)}
        </View>

        {step === 0 ? (
          <View style={{ gap: 8 }}>
            <T size={13} color={c.mute}>{tr('dp.b.domain_intro', { sport: plan.sport })}</T>
            {DOMAINS.map((d) => (
              <Card key={d} on={domain === d} label={tr(`dp.domain.${d}`)} onPress={() => { setDomain(d); setComp(null); }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <T size={22}>{DOMAIN_ICON[d]}</T>
                  <View style={{ flex: 1 }}><T weight="800" size={15}>{tr(`dp.domain.${d}`)}</T><T size={12} color={c.mute}>{tr(`dp.b.domain_hint.${d}`)}</T></View>
                  <Tag label={counts(d) ? tr('dp.b.n_objectives', { n: counts(d) }) : tr('dp.b.uncovered')} color={counts(d) ? c.mint : c.sunSoft} />
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {step === 1 ? (
          ins.error ? <ErrorBox error={ins.error} onRetry={ins.reload} /> : !ins.data ? <Loading /> : (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <Tag label={ins.data.framework.label} color={ins.data.framework.fallback ? c.sunSoft : c.mint} />
                {ins.data.framework.fallback ? <T size={12} color={c.sun} weight="700">{tr('dp.b.fallback_note')}</T> : null}
              </View>
              <T size={13} color={c.mute}>{tr('dp.b.competency_intro')}</T>
              {list.map((x) => {
                const ev = x.evidence, bm = x.benchmark;
                return (
                  <Card key={x.key} on={comp === x.key} label={x.label} onPress={() => choose(x)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ flex: 1 }}><T weight="800" size={14}>{x.label}</T><T size={12} color={c.mute}>{x.measure.kind === 'rubric' ? tr('dp.b.measured_by', { name: `${x.measure.rubric} · ${x.measure.dimension}` }) : tr('dp.b.by_milestones')}</T></View>
                      {x.measure.kind === 'rubric' ? <View style={{ alignItems: 'flex-end' }}>
                        <T weight="800" size={18}>{ev?.state === 'measured' ? figure(ev.value) : '—'}</T>
                        <T size={11} color={c.mute}>{ev?.state === 'measured' ? tr('dp.n_obs', { n: ev.n }) : ev?.state === 'no_consent' ? tr('dp.b.no_consent_short') : tr('dp.state.no_data')}</T>
                      </View> : null}
                    </View>
                    {bm?.state === 'ok' && bm.athlete_band ? <Tag label={tr(BAND[bm.athlete_band])} color={bm.athlete_band === 'top_quartile' ? c.mint : bm.athlete_band === 'bottom_quartile' ? c.orange : c.violetSoft} /> : null}
                  </Card>
                );
              })}
            </View>
          )
        ) : null}

        {step === 2 && cur ? (
          <View style={{ gap: 12 }}>
            <Field label={tr('dp.field.objective')} value={f.title} onChangeText={(x) => set('title', x)} hint={tr('dp.field.objective_hint')} />
            {cur.measure.kind === 'rubric' ? (
              <View style={{ gap: 10, padding: 14, borderRadius: 16, backgroundColor: c.bg }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 1 }}>{tr('dp.b.where_now').toUpperCase()}</T>
                  <T size={28} weight="800">{cur.evidence?.state === 'measured' ? figure(cur.evidence.value) : '—'}</T>
                  <T size={12} color={c.mute}>{cur.evidence?.state === 'measured' ? tr('dp.n_obs', { n: cur.evidence.n }) : tr('dp.missing.no_observations')}</T>
                </View>
                {cur.evidence?.series?.length > 1 ? <T size={12} color={c.mute}>{cur.evidence.series.map((s) => `${s.month.slice(5)}: ${figure(s.value)}`).join('  ·  ')}</T> : null}
                {cur.benchmark?.state === 'ok' ? <>
                  <T size={13} weight="700">{tr('dp.b.peers_title', { n: cur.benchmark.peers })}</T>
                  <PeerScale evidence={cur.evidence} benchmark={cur.benchmark} target={f.target === '' ? null : Number(f.target)} />
                  <T size={11} color={c.mute}>{tr('dp.b.peers_note')}</T>
                </> : cur.benchmark ? <T size={12} color={c.mute}>{tr('dp.b.no_benchmark', { have: cur.benchmark.peers, need: cur.benchmark.needed })}</T> : null}
                {cur.evidence?.projection?.state === 'projected' ? <T size={13}>{tr('dp.b.projection', { value: figure(cur.evidence.projection.end_value), slope: figure(cur.evidence.projection.slope_per_month), conf: tr(`dp.b.conf.${cur.evidence.projection.confidence}`) })}</T>
                  : cur.evidence?.projection ? <T size={12} color={c.mute}>{tr('dp.b.no_projection')}</T> : null}
                {cur.suggestion ? (
                  <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, gap: 4 }}>
                    <T size={13} weight="800">{tr('dp.b.suggested', { target: figure(cur.suggestion.target) })}</T>
                    <T size={12} color={c.mute}>{tr('dp.b.method')}: {cur.suggestion.method}</T>
                    <Btn small title={tr('dp.b.use_suggestion')} color={c.paper} ink={c.ink} onPress={() => set('target', String(cur.suggestion.target))} style={{ alignSelf: 'flex-start' }} />
                  </View>
                ) : null}
                <Field label={tr('dp.field.target')} value={f.target} onChangeText={(x) => set('target', x.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" hint={tr('dp.field.target_hint')} />
              </View>
            ) : (
              <View style={{ padding: 14, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
                <T size={13} weight="800">{tr('dp.b.milestone_only')}</T>
                <T size={12} color={c.mute}>{tr('dp.b.milestone_only_why')}</T>
              </View>
            )}
          </View>
        ) : null}

        {step === 3 && cur ? (
          <View style={{ gap: 12 }}>
            <MenuField label={tr('dp.field.owner')} value={f.owner_id} onChange={(x) => set('owner_id', x)} options={people} hint={tr('dp.b.owner_hint')} />
            <DateField label={tr('dp.field.due')} value={f.due_on} onChange={(x) => set('due_on', x)} optional min={season.min} max={season.max} />
            <View style={{ gap: 6 }}>
              <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{tr('dp.b.checkpoints').toUpperCase()}</T>
              {f.milestones.map((m, k) => (
                <View key={k} style={{ gap: 6, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: c.line }}>
                  <Field value={m.title} onChangeText={(x) => set('milestones', f.milestones.map((y, j) => (j === k ? { ...y, title: x } : y)))} accessibilityLabel={tr('dp.field.milestone')} />
                  <DateField label={tr('dp.field.due')} value={m.due_on} onChange={(x) => set('milestones', f.milestones.map((y, j) => (j === k ? { ...y, due_on: x } : y)))} min={season.min} max={season.max} />
                  <Btn small title={tr('dp.remove')} color={c.paper} ink={c.ink} onPress={() => set('milestones', f.milestones.filter((_, j) => j !== k))} style={{ alignSelf: 'flex-start' }} />
                </View>
              ))}
              <Btn small title={tr('dp.add_milestone')} color={c.paper} ink={c.ink} onPress={() => set('milestones', [...f.milestones, { title: '', due_on: season.min }])} style={{ alignSelf: 'flex-start' }} />
              <T size={12} color={c.mute}>{tr('dp.b.checkpoints_hint')}</T>
            </View>
            {cur.tasks?.length ? (
              <View style={{ gap: 6 }}>
                <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{tr('dp.b.suggested_tasks').toUpperCase()}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{cur.tasks.map((tk) => <Chip key={tk.title} label={(f.tasks.some((y) => y.title === tk.title) ? '✓ ' : '+ ') + tk.title} active={f.tasks.some((y) => y.title === tk.title)} onPress={() => toggleTask(tk)} />)}</View>
                <T size={12} color={c.mute}>{tr('dp.b.tasks_hint')}</T>
              </View>
            ) : null}
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: f.visibility }} accessibilityLabel={tr('dp.field.show_athlete')} onPress={() => set('visibility', !f.visibility)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
              <View style={{ flex: 1 }}><T weight="700" size={14}>{tr('dp.field.show_athlete')}</T><T size={12} color={c.mute}>{tr('dp.field.show_athlete_hint')}</T></View>
              <Tag label={f.visibility ? tr('dp.shown') : tr('dp.hidden')} color={f.visibility ? c.mint : undefined} />
            </Pressable>
          </View>
        ) : null}

        {step === 4 && cur ? (
          <View style={{ gap: 8, padding: 14, borderRadius: 16, backgroundColor: c.bg }}>
            <T weight="800" size={16}>{f.title}</T>
            <T size={12} color={c.mute}>{DOMAIN_ICON[domain]} {tr(`dp.domain.${domain}`)} · {cur.label}</T>
            <T size={13}>{measured ? tr('dp.b.sum_measured', { measure: `${cur.measure.rubric} · ${cur.measure.dimension}`, from: figure(cur.evidence?.value), target: figure(Number(f.target)) }) : tr('dp.b.sum_milestones')}</T>
            <T size={13}>{tr('dp.b.sum_owner', { name: people.find((p) => p.value === f.owner_id)?.label ?? tr('dp.b.you') })}{f.due_on ? ` · ${tr('dp.due_on', { date: when(f.due_on) })}` : ''}</T>
            <T size={13}>{tr('dp.b.sum_counts', { m: f.milestones.filter((m) => m.title.trim()).length, t: f.tasks.length })}</T>
            <T size={12} color={c.mute}>{f.visibility ? tr('dp.b.sum_visible') : tr('dp.b.sum_staff')}</T>
          </View>
        ) : null}

        {err ? <ErrorBox error={err} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {step > 0 ? <Btn title={tr('common.back')} color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : <Btn title={tr('common.cancel')} color={c.paper} ink={c.ink} onPress={close} style={{ flex: 1 }} />}
          {step < 4 ? <Btn title={tr('common.next')} onPress={() => setStep(step + 1)} disabled={!can} style={{ flex: 2 }} /> : <Btn title={tr('dp.b.create')} onPress={create} loading={busy} style={{ flex: 2 }} />}
        </View>
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ season timeline
const PHASE_TONE = { pre_season: c.cyanSoft, competition: c.limeSoft, exams: c.sunSoft, recovery: c.mintSoft, transition: c.violetSoft, camp: c.pinkSoft };
export function SeasonTimeline({ plan, phases, clashes, milestones, tasks, reviews, canEdit, onEdit }) {
  const a = plan.starts_on, b = plan.ends_on, now = todayStr();
  const marks = [
    ...milestones.map((m) => ({ id: m.id, d: m.due_on, glyph: m.status === 'done' ? '●' : '○', tone: m.status === 'done' ? c.lime : m.due_on < now ? c.orange : c.cyan, label: `${m.title}, ${when(m.due_on)}` })),
    ...tasks.filter((x) => x.due_on && !['done', 'cancelled'].includes(x.status)).map((x) => ({ id: x.id, d: x.due_on, glyph: '▪', tone: x.overdue ? c.orange : c.violet, label: `${x.title}, ${when(x.due_on)}` })),
    ...reviews.filter((r) => r.status === 'signed_off').map((r) => ({ id: r.id, d: r.period_to, glyph: '◆', tone: c.pink, label: `${tr('dp.reviews')}, ${when(r.period_to)}` })),
  ].filter((m) => m.d >= a && m.d <= b);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={16} style={{ flex: 1 }}>{tr('dp.t.title')}</T>{canEdit ? <Btn small title={phases.length ? tr('dp.t.edit') : tr('dp.t.add')} color={c.paper} ink={c.ink} onPress={onEdit} /> : null}</View>
      <View accessible accessibilityLabel={`${tr('dp.t.title')}: ${phases.map((p) => `${p.label ?? tr(`dp.phase.${p.kind}`)} ${when(p.from)} – ${when(p.to)}`).join(', ')}`} style={{ height: 34, borderRadius: 10, backgroundColor: c.line, overflow: 'hidden' }}>
        {phases.map((p, k) => <View key={k} style={{ position: 'absolute', start: `${pct(p.from, a, b)}%`, width: `${Math.max(1.5, pct(p.to, a, b) - pct(p.from, a, b))}%`, top: 0, bottom: 0, backgroundColor: PHASE_TONE[p.kind], borderStartWidth: 2, borderColor: c.paper, justifyContent: 'center', paddingHorizontal: 4 }}><T size={10} weight="800" numberOfLines={1}>{p.label ?? tr(`dp.phase.${p.kind}`)}</T></View>)}
        {now >= a && now <= b ? <View style={{ position: 'absolute', start: `${pct(now, a, b)}%`, width: 3, top: 0, bottom: 0, backgroundColor: c.ink }} /> : null}
      </View>
      <View style={{ height: 22 }}>{marks.map((m) => <T key={m.id} accessibilityLabel={m.label} size={12} color={m.tone} style={{ position: 'absolute', start: `${pct(m.d, a, b)}%`, marginStart: -5 }}>{m.glyph}</T>)}</View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={11} color={c.mute}>{when(a)}</T><T size={11} color={c.mute}>{tr('dp.t.today')} {when(now)}</T><T size={11} color={c.mute}>{when(b)}</T></View>
      <T size={11} color={c.mute}>● {tr('dp.t.done')}  ○ {tr('dp.t.milestone')}  ▪ {tr('dp.t.task')}  ◆ {tr('dp.t.review')}</T>
      {!phases.length ? <T size={12} color={c.mute}>{tr('dp.t.none')}</T> : null}
      {clashes.length ? (
        <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.sunSoft, gap: 4 }} accessibilityRole="alert">
          <T size={13} weight="800">⚠ {tr('dp.t.clash', { n: clashes.length })}</T>
          {clashes.map((x) => <T key={x.id} size={12}>{x.title} · {when(x.due_on)} · {x.phase.label ?? tr(`dp.phase.${x.phase.kind}`)}</T>)}
          <T size={12} color={c.mute}>{tr('dp.t.clash_hint')}</T>
        </View>
      ) : null}
    </View>
  );
}

export function PhasesSheet({ visible, onClose, plan, phases, onSave }) {
  const [rows, setRows] = useState(phases);
  const [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  React.useEffect(() => { if (visible) { setRows(phases.map((p) => ({ ...p }))); setErr(null); } }, [visible]);
  const upd = (k, patch) => setRows(rows.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  const KINDS = ['pre_season', 'competition', 'exams', 'recovery', 'transition', 'camp'];
  const save = async () => { setBusy(true); setErr(null); try { await onSave(rows.map((r) => ({ kind: r.kind, label: r.label || undefined, from: r.from, to: r.to }))); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <Sheet visible={visible} onClose={onClose} title={tr('dp.t.edit')}>
      <View style={{ gap: 12 }}>
        <T size={12} color={c.mute}>{tr('dp.t.edit_hint')}</T>
        {rows.map((r, k) => (
          <View key={k} style={{ gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.line }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{KINDS.map((x) => <Chip key={x} label={tr(`dp.phase.${x}`)} active={r.kind === x} onPress={() => upd(k, { kind: x })} />)}</View>
            <Field value={r.label ?? ''} onChangeText={(x) => upd(k, { label: x })} placeholder={tr('dp.t.label_ph')} accessibilityLabel={tr('dp.t.label_ph')} />
            <DateField label={tr('dp.t.from')} value={r.from} onChange={(x) => upd(k, { from: x })} min={plan.starts_on} max={plan.ends_on} />
            <DateField label={tr('dp.t.to')} value={r.to} onChange={(x) => upd(k, { to: x })} min={r.from ?? plan.starts_on} max={plan.ends_on} />
            <Btn small title={tr('dp.remove')} color={c.paper} ink={c.ink} onPress={() => setRows(rows.filter((_, j) => j !== k))} style={{ alignSelf: 'flex-start' }} />
          </View>
        ))}
        <Btn small title={tr('dp.t.add_phase')} color={c.paper} ink={c.ink} onPress={() => setRows([...rows, { kind: 'competition', from: plan.starts_on, to: plan.starts_on }])} style={{ alignSelf: 'flex-start' }} />
        {err ? <ErrorBox error={err} /> : null}
        <Btn title={tr('dp.save')} onPress={save} loading={busy} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------ squad board
const REASON = { review_overdue: 'dp.r.review_overdue', behind: 'dp.r.behind', no_data: 'dp.r.no_data', tasks_overdue: 'dp.r.tasks_overdue', domains_uncovered: 'dp.r.domains_uncovered', phase_clash: 'dp.r.phase_clash', fit_status: 'dp.r.fit_status' };
const CELL = { behind: ['▼', c.orange, c.orangeSoft], no_data: ['∅', c.mute, c.violetSoft], tracking: ['〰', c.cyan, c.cyanSoft], on_track: ['▲', c.lime, c.limeSoft], achieved: ['✓', c.lime, c.limeSoft], empty: ['·', c.mute, c.bg] };

export function SquadBoard({ o, onOpen }) {
  const [sport, setSport] = useState(undefined);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/dev-plans/board`, sport ? { sport } : {}), [o.id, sport]);
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const items = d.data.items;
  const attention = items.filter((x) => x.reasons.length).length;
  const gaps = items.reduce((n, x) => n + x.reasons.filter((r) => r.code === 'domains_uncovered').reduce((m, r) => m + r.domains.length, 0), 0);
  const reason = (r) => tr(REASON[r.code], { n: r.n ?? 0, domains: (r.domains ?? []).map((x) => tr(`dp.domain.${x}`)).join(', '), date: r.on ? when(r.on) : '', status: r.status ? tr(`dp.clear.${r.status}`) : '' });
  return (
    <View style={{ gap: 12 }}>
      <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>
        <T weight="800" size={17}>{tr('dp.board.title')}</T>
        <T size={12} color={c.mute}>{tr('dp.board.subtitle')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <Kpi label={tr('dp.board.athletes')} value={items.length} sub={tr('dp.board.athletes_sub')} />
          <Kpi label={tr('dp.board.attention')} value={attention} tone={attention ? 'alert' : undefined} sub={tr('dp.board.attention_sub')} />
          <Kpi label={tr('dp.board.gaps')} value={gaps} sub={tr('dp.board.gaps_sub')} />
        </View>
        {d.data.sports.length > 1 ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}><Chip label={tr('dp.all')} active={!sport} onPress={() => setSport(undefined)} />{d.data.sports.map((s) => <Chip key={s} label={s} active={sport === s} onPress={() => setSport(s)} />)}</View> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{['behind', 'no_data', 'on_track', 'achieved'].map((k) => <T key={k} size={11} color={c.mute}>{CELL[k][0]} {tr(stateMeta(k).key)}</T>)}<T size={11} color={c.mute}>· {tr('dp.board.empty')}</T></View>
      </View>
      {items.length ? items.map((x) => (
        <Pressable key={x.plan_id} onPress={() => onOpen(x.plan_id)} accessibilityRole="button" accessibilityLabel={tr('dp.open_plan_for', { name: x.athlete_name, season: x.season_label })} style={{ backgroundColor: c.paper, borderRadius: 18, padding: 14, gap: 10, borderWidth: 1, borderColor: x.reasons.length ? c.orange : c.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Initials name={x.athlete_name} user={x.athlete} size={40} />
            <View style={{ flex: 1 }}><T weight="800" size={15}>{x.athlete_name}</T><T size={12} color={c.mute}>{x.sport} · {tr('dp.lead_is', { name: x.lead.display_name })}{x.phase_now ? ` · ${x.phase_now.label ?? tr(`dp.phase.${x.phase_now.kind}`)}` : ''}</T></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {DOMAINS.map((dm) => {
              const cell = x.cells[dm], [g, fg, bg] = CELL[cell.worst];
              return (
                <View key={dm} accessible accessibilityLabel={`${tr(`dp.domain.${dm}`)}: ${cell.objectives ? tr(stateMeta(cell.worst).key) : tr('dp.board.empty')}`} style={{ flexGrow: 1, flexBasis: 92, padding: 8, borderRadius: 12, backgroundColor: bg, gap: 2, minHeight: 56 }}>
                  <T size={11} weight="800" color={c.mute} numberOfLines={1}>{DOMAIN_ICON[dm]} {tr(`dp.domain.${dm}`)}</T>
                  <T size={15} weight="800" color={fg}>{g} {cell.objectives || ''}</T>
                  {cell.objectives ? <T size={10} color={c.mute}>{['behind', 'no_data'].filter((k) => cell.states[k]).map((k) => `${CELL[k][0]}${cell.states[k]}`).join(' ')}</T> : null}
                </View>
              );
            })}
          </View>
          {x.reasons.length ? <View style={{ gap: 2 }}>{x.reasons.map((r, k) => <T key={k} size={12} color={c.orange} weight="700">• {reason(r)}</T>)}</View> : <T size={12} color={c.mint} weight="700">✓ {tr('dp.board.clear')}</T>}
        </Pressable>
      )) : <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: c.line }}><Empty emoji="🧭" title={tr('dp.board.none')} sub={tr('dp.board.none_sub')} /></View>}
    </View>
  );
}
