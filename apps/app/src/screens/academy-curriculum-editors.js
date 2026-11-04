// In-page editors for the Curriculum module (#782): the Objective Studio and the Drill Designer. Both are built for people who write
// curricula for a living: pick from the academy's own methodology (competencies, outcomes, approved drills), see what mastery looks like at
// this stage, watch a completeness meter, and see exactly how the coach and the family will read it before saving.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Btn, Chip, Field, T, Tag } from '../ui';
import { Counter } from '../pickers';
import { MenuField, MultiMenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { useLayout } from '../layout';
import { Eyebrow, Mastery, MASTERY, Panel, PILLARS, PILLAR_ICON, PRIORITIES, INTENSITIES, opt, lbl } from './academy-curriculum-ui';
import { slugOf } from './academy-methodology';

const KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];
const Lbl = ({ children, hint }) => <View style={{ gap: 2 }}><T weight="800" size={13}>{children}</T>{hint ? <T size={12} color={c.mute}>{hint}</T> : null}</View>;
const Step = ({ n, title, children }) => (
  <Panel>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' }}><T size={12} weight="800" color={c.inkOn}>{n}</T></View><T weight="800" size={15}>{title}</T></View>
    {children}
  </Panel>
);

/** Completeness meter: a score and the things still missing, so nothing half-written reaches the approver. */
function Meter({ checks }) {
  const done = checks.filter((x) => x.ok).length, pct = Math.round((done / checks.length) * 100);
  return (
    <View style={{ gap: 6 }} accessible accessibilityLabel={lbl`${t('cur.ed.complete')}: ${pct}%`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={22} style={{ letterSpacing: -0.6 }}>{pct}%</T><T size={12} color={c.mute} style={{ flex: 1 }}>{t('cur.ed.complete')}</T></View>
      <View style={{ height: 8, borderRadius: 5, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 8, backgroundColor: pct === 100 ? c.lime : c.sun }} /></View>
      {checks.filter((x) => !x.ok).map((x) => <T key={x.key} size={12} color={x.must ? c.orange : c.mute}>{x.must ? '⛔' : '○'} {x.label}</T>)}
    </View>
  );
}

/** A list of short text entries (equipment, coaching cues): type, add, remove. */
function TagInput({ label, hint, value, onChange, placeholder }) {
  const [v, setV] = useState('');
  const add = () => { const x = v.trim(); if (x && !value.includes(x)) onChange([...value, x]); setV(''); };
  return (
    <View style={{ gap: 6 }}>
      <Field label={label} hint={hint} value={v} onChangeText={setV} placeholder={placeholder} />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn small title={t('cur.add')} color={c.paper} ink={c.ink} disabled={!v.trim()} onPress={add} />
        {value.map((x) => <Chip key={x} label={lbl`${x}  ✕`} active onPress={() => onChange(value.filter((y) => y !== x))} />)}
      </View>
    </View>
  );
}

function Split({ form, preview }) {
  const { tablet } = useLayout();
  return <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 14, alignItems: 'flex-start' }}><View style={{ flex: tablet ? 3 : undefined, width: tablet ? undefined : '100%', gap: 12, minWidth: 0 }}>{form}</View><View style={{ flex: tablet ? 2 : undefined, width: tablet ? undefined : '100%', gap: 12, minWidth: 0 }}>{preview}</View></View>;
}

// ------------------------------------------------------------------------------------------------ objective studio
export function ObjectiveEditor({ x, meth, stageKey, phases, assessOpts, hasParent, std, taken, onSave, onCancel }) {
  const [f, setF] = useState(() => ({ priority: 'core', mastery_target: 'develop', sessions_target: 3, phase_keys: [], drill_keys: [], op: 'add', ...(x ?? {}), has_rpe: x?.rpe_target != null, assess_pick: x?.assess ? `${x.assess.rubric_id}|${x.assess.dimension_key}` : '' }));
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const comp = meth.competencies.find((k) => k.key === f.competency_key);
  const prof = comp?.proficiency?.find((p) => p.stage_key === stageKey) ?? comp?.proficiency?.[0];
  const outcomes = (meth.outcomes ?? []).filter((o) => o.competency_key === f.competency_key && (!o.stage_key || !stageKey || o.stage_key === stageKey));
  const relevant = meth.drills.filter((d) => d.competency_keys.includes(f.competency_key)), others = meth.drills.filter((d) => !d.competency_keys.includes(f.competency_key));
  const minutes = f.drill_keys.reduce((s, k) => s + (meth.drills.find((d) => d.key === k)?.duration_min ?? 0), 0);
  const crit = (f.success_criteria ?? '').trim();
  const checks = [
    { key: 'title', ok: (f.title ?? '').trim().length >= 2, must: true, label: t('cur.ed.need_title') }, { key: 'comp', ok: !!f.competency_key, must: true, label: t('cur.ed.need_competency') },
    { key: 'crit', ok: crit.length >= 15, must: true, label: t('cur.ed.need_criteria') }, { key: 'drill', ok: f.drill_keys.length > 0, label: t('cur.ed.need_drill') },
    ...(phases.length ? [{ key: 'phase', ok: f.phase_keys.length > 0, label: t('cur.ed.need_phase') }] : []), { key: 'fam', ok: (f.guardian_summary ?? '').trim().length >= 10, label: t('cur.ed.need_family') },
  ];
  const valid = checks.filter((k) => k.must).every((k) => k.ok);
  const save = () => {
    const [rid, dk] = (f.assess_pick ?? '').split('|');
    onSave({ key: x?.key ?? slugOf(f.title, 'o', taken), title: f.title.trim(), competency_key: f.competency_key, priority: f.priority, mastery_target: f.mastery_target, sessions_target: f.sessions_target, rpe_target: f.has_rpe ? f.rpe_target ?? 6 : undefined, phase_keys: f.phase_keys, drill_keys: f.drill_keys, success_criteria: crit, assess: rid && dk ? { rubric_id: rid, dimension_key: dk } : undefined, description: f.description || undefined, guardian_summary: (f.guardian_summary ?? '').trim() || undefined, op: f.op ?? 'add' });
  };
  const drillCard = (d) => { const on = f.drill_keys.includes(d.key); return (
    <Pressable key={d.key} onPress={() => set('drill_keys')(on ? f.drill_keys.filter((k) => k !== d.key) : [...f.drill_keys, d.key])} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={d.title}
      style={{ minHeight: 44, padding: 10, borderRadius: 14, borderWidth: 1.5, borderColor: on ? c.pink : c.line, backgroundColor: on ? c.pinkSoft : c.bg, gap: 2 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T weight="700" size={13.5} style={{ flex: 1 }}>{on ? '✓ ' : ''}{d.title}</T><Tag label={t(`cur.kind.${d.kind}`)} color={c.cyanSoft} /></View>
      <T size={11.5} color={c.mute}>{[d.duration_min ? `${d.duration_min} min` : null, d.area, d.work_rest].filter(Boolean).join(' · ')}</T>
    </Pressable>); };
  const form = (
    <>
      <Step n={1} title={t('cur.ed.s_competency')}>
        <T size={12} color={c.mute}>{t('cur.ed.s_competency_help')}</T>
        {PILLARS.map((p) => { const rows = meth.competencies.filter((k) => k.pillar === p); return rows.length ? (
          <View key={p} style={{ gap: 6 }}><Eyebrow>{`${PILLAR_ICON[p]} ${t(`cur.pillar.${p}`)}`}</Eyebrow>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{rows.map((k) => <Chip key={k.key} label={k.title} active={f.competency_key === k.key} onPress={() => set('competency_key')(k.key)} />)}</View></View>) : null; })}
        {comp ? (
          <View style={{ padding: 12, borderRadius: 14, backgroundColor: c.cyanSoft, gap: 6 }}>
            <Eyebrow>{t('cur.ed.mastery_looks')}</Eyebrow>
            {prof ? <T size={13}>{prof.descriptor}</T> : <T size={12.5} color={c.mute}>{t('cur.ed.no_proficiency')}</T>}
            {outcomes.length ? <><Eyebrow>{t('cur.ed.outcomes_here')}</Eyebrow>{outcomes.map((o, i) => <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T size={12.5} style={{ flex: 1 }}>• {o.outcome}</T><Btn small title={t('cur.ed.use')} color={c.paper} ink={c.ink} onPress={() => set('success_criteria')(o.outcome)} /></View>)}</> : null}
          </View>
        ) : null}
      </Step>
      <Step n={2} title={t('cur.ed.s_define')}>
        <Field label={t('cur.f.title')} value={f.title} onChangeText={set('title')} maxLength={120} />
        <Lbl>{t('cur.f.priority')}</Lbl>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{opt(PRIORITIES, 'cur.priority').map((o) => <Chip key={o.value} label={o.label} active={f.priority === o.value} onPress={() => set('priority')(o.value)} />)}</View>
        <Lbl hint={t('cur.f.mastery_hint')}>{t('cur.f.mastery')}</Lbl>
        <View style={{ flexDirection: 'row', gap: 6 }}>{MASTERY.map((m, i) => (
          <Pressable key={m} onPress={() => set('mastery_target')(m)} accessibilityRole="radio" accessibilityState={{ selected: f.mastery_target === m }} accessibilityLabel={t(`cur.mastery.${m}`)} style={{ flex: 1, minHeight: 56, borderRadius: 14, padding: 8, justifyContent: 'center', gap: 4, backgroundColor: MASTERY.indexOf(f.mastery_target) >= i ? c.pinkSoft : c.bg, borderWidth: 1.5, borderColor: f.mastery_target === m ? c.pink : c.line }}>
            <T size={11} weight="800" color={c.mute}>{i + 1}</T><T size={12} weight="700">{t(`cur.mastery.${m}`)}</T></Pressable>))}</View>
      </Step>
      <Step n={3} title={t('cur.ed.s_load')}>
        <Counter label={t('cur.f.target')} value={f.sessions_target} onChange={set('sessions_target')} min={1} max={200} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Chip label={t('cur.f.rpe_switch')} active={f.has_rpe} onPress={() => set('has_rpe')(!f.has_rpe)} /></View>
        {f.has_rpe ? <><Counter label={t('cur.f.rpe')} value={f.rpe_target ?? 6} onChange={set('rpe_target')} min={1} max={10} />{std?.rpe_target && Math.abs((f.rpe_target ?? 6) - std.rpe_target) > 2 ? <T size={12} color={c.orange}>⚠ {t('cur.ed.rpe_vs_standard', { a: f.rpe_target ?? 6, b: std.rpe_target })}</T> : null}</> : null}
        {phases.length ? <MultiMenuField label={t('cur.f.phases')} hint={t('cur.f.phases_hint')} value={f.phase_keys} onChange={set('phase_keys')} options={phases.map((p) => ({ value: p.key, label: p.title, sub: `${p.starts_on} – ${p.ends_on}` }))} /> : <T size={12} color={c.mute}>{t('cur.ed.no_phases_yet')}</T>}
      </Step>
      <Step n={4} title={t('cur.ed.s_drills')}>
        <T size={12} color={c.mute}>{t('cur.ed.s_drills_help')}</T>
        {relevant.map(drillCard)}
        {others.length ? <><Eyebrow>{t('cur.ed.other_drills')}</Eyebrow>{others.map(drillCard)}</> : null}
        {!meth.drills.length ? <T size={12.5} color={c.mute}>{t('cur.lib.drills_empty')}</T> : null}
        {minutes ? <T size={12.5} weight="700" color={std?.session_minutes && minutes > std.session_minutes ? c.orange : c.ink}>{t('cur.ed.drill_time', { a: minutes, b: std?.session_minutes ?? '–' })}</T> : null}
      </Step>
      <Step n={5} title={t('cur.ed.s_evidence')}>
        <Field label={t('cur.f.criteria')} hint={t('cur.f.criteria_hint')} value={f.success_criteria} onChangeText={set('success_criteria')} multiline maxLength={500} />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{['cur.ed.pat_ratio', 'cur.ed.pat_time', 'cur.ed.pat_unprompted', 'cur.ed.pat_pressure'].map((k) => <Chip key={k} label={t(k)} onPress={() => set('success_criteria')(`${(f.success_criteria ?? '').trim()}${f.success_criteria ? ' ' : ''}${t(`${k}_text`)}`)} />)}</View>
        {assessOpts.length ? <MenuField label={t('cur.f.assess')} hint={t('cur.f.assess_hint')} value={f.assess_pick || null} onChange={set('assess_pick')} options={assessOpts} placeholder={t('cur.ed.none')} /> : null}
        <Field label={t('cur.f.description')} value={f.description} onChangeText={set('description')} multiline maxLength={500} />
      </Step>
      <Step n={6} title={t('cur.ed.s_family')}>
        <Field label={t('cur.f.family_line')} hint={t('cur.ed.family_hint')} value={f.guardian_summary} onChangeText={set('guardian_summary')} maxLength={300} />
        <T size={11} color={c.mute}>{(f.guardian_summary ?? '').length} / 300</T>
        {hasParent ? <><Lbl>{t('cur.f.op')}</Lbl><View style={{ flexDirection: 'row', gap: 6 }}>{opt(['add', 'override', 'exclude'], 'cur.op').map((o) => <Chip key={o.value} label={o.label} active={f.op === o.value} onPress={() => set('op')(o.value)} />)}</View></> : null}
      </Step>
    </>
  );
  const preview = (
    <>
      <Panel><Meter checks={checks} />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn title={t('common.save')} disabled={!valid} onPress={save} /><Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onCancel} /></View></Panel>
      <Panel>
        <Eyebrow>{t('cur.ed.coach_view')}</Eyebrow>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><T size={16}>{PILLAR_ICON[comp?.pillar] ?? '•'}</T><T weight="800" size={15} style={{ flex: 1 }}>{f.title || t('cur.ed.untitled')}</T><Tag label={t(`cur.priority.${f.priority}`)} color={f.priority === 'core' ? c.pinkSoft : undefined} /></View>
        <T size={12} color={c.mute}>{comp?.title ?? '–'} · {t('cur.target_sessions', { n: f.sessions_target })}{f.has_rpe ? ` · RPE ${f.rpe_target ?? 6}` : ''}</T>
        <Mastery level={f.mastery_target} />
        {crit ? <T size={12.5}>✓ {crit}</T> : null}
        {f.drill_keys.length ? <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{f.drill_keys.map((k) => { const d = meth.drills.find((y) => (y.key === k)); return d ? <Tag key={k} label={lbl`${d.title}${d.duration_min ? ` · ${d.duration_min}′` : ''}`} color={c.cyanSoft} /> : null; })}</View> : null}
      </Panel>
      <Panel>
        <Eyebrow>{t('cur.ed.family_view')}</Eyebrow>
        <T size={13.5} weight="700">{f.title || t('cur.ed.untitled')}</T>
        <T size={12.5} color={c.mute}>{(f.guardian_summary ?? '').trim() || t('cur.ed.family_empty')}</T>
      </Panel>
    </>
  );
  return <Split form={form} preview={preview} />;
}

// ------------------------------------------------------------------------------------------------ drill designer
export function DrillEditor({ x, meth, std, taken, onSave, onCancel }) {
  const m0 = (x?.work_rest ?? '').match(/(\d+)\s*s on\s*\/\s*(\d+)\s*s off\s*[x×]\s*(\d+)/i);
  const [f, setF] = useState(() => ({ kind: 'skill_drill', duration_min: 15, competency_keys: [], equipment: [], cues: [], has_wr: !!m0, work: m0 ? +m0[1] : 40, rest: m0 ? +m0[2] : 20, rounds: m0 ? +m0[3] : 6, ...(x ?? {}) }));
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const wr = f.has_wr ? `${f.work} s on / ${f.rest} s off × ${f.rounds}` : (x?.work_rest && !m0 ? x.work_rest : undefined);
  const wrMin = f.has_wr ? Math.round(((f.work + f.rest) * f.rounds) / 60) : null;
  const checks = [{ key: 't', ok: (f.title ?? '').trim().length >= 2, must: true, label: t('cur.ed.need_title') }, { key: 'c', ok: f.competency_keys.length > 0, label: t('cur.ed.need_trains') }, { key: 'i', ok: (f.instructions ?? '').trim().length >= 20, label: t('cur.ed.need_instructions') }, { key: 'k', ok: (f.success_criteria ?? '').trim().length >= 10, label: t('cur.ed.need_criteria_drill') }, { key: 'p', ok: !!f.progression && !!f.regression, label: t('cur.ed.need_progression') }, { key: 'q', ok: f.cues.length > 0, label: t('cur.ed.need_cues') }];
  const save = () => onSave({ ...(x ?? {}), key: x?.key ?? slugOf(f.title, 'd', taken), title: f.title.trim(), kind: f.kind, competency_keys: f.competency_keys, duration_min: f.duration_min, area: f.area || undefined, setup: f.setup || undefined, equipment: f.equipment, work_rest: wr, instructions: f.instructions || undefined, success_criteria: f.success_criteria || undefined, progression: f.progression || undefined, regression: f.regression || undefined, cues: f.cues, group_size: undefined });
  const form = (
    <>
      <Step n={1} title={t('cur.sec.basics')}>
        <Field label={t('cur.f.title')} value={f.title} onChangeText={set('title')} maxLength={120} />
        <Lbl>{t('cur.f.kind')}</Lbl><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{opt(KINDS, 'cur.kind').map((o) => <Chip key={o.value} label={o.label} active={f.kind === o.value} onPress={() => set('kind')(o.value)} />)}</View>
        <MultiMenuField label={t('cur.f.trains')} value={f.competency_keys} onChange={set('competency_keys')} options={meth.competencies.map((k) => ({ value: k.key, label: `${PILLAR_ICON[k.pillar]} ${k.title}`, sub: t(`cur.pillar.${k.pillar}`) }))} />
      </Step>
      <Step n={2} title={t('cur.sec.design')}>
        <Counter label={t('cur.f.minutes')} value={f.duration_min} onChange={set('duration_min')} min={1} max={240} step={5} />
        {std?.session_minutes ? <T size={12} color={f.duration_min > std.session_minutes ? c.orange : c.mute}>{t('cur.ed.of_session', { n: Math.round((f.duration_min / std.session_minutes) * 100) })}</T> : null}
        <Field label={t('cur.f.area')} value={f.area} onChangeText={set('area')} maxLength={120} />
        <Chip label={t('cur.ed.interval')} active={f.has_wr} onPress={() => set('has_wr')(!f.has_wr)} />
        {f.has_wr ? <><Counter label={t('cur.ed.work_s')} value={f.work} onChange={set('work')} min={5} max={600} step={5} suffix=" s" /><Counter label={t('cur.ed.rest_s')} value={f.rest} onChange={set('rest')} min={0} max={600} step={5} suffix=" s" /><Counter label={t('cur.ed.rounds')} value={f.rounds} onChange={set('rounds')} min={1} max={60} /><T size={12} color={c.mute}>{t('cur.ed.interval_total', { n: wrMin })}</T></> : null}
        <TagInput label={t('cur.ed.equipment')} value={f.equipment} onChange={set('equipment')} hint={t('cur.ed.equipment_hint')} />
      </Step>
      <Step n={3} title={t('cur.sec.coaching')}>
        <Field label={t('cur.f.instructions')} value={f.instructions} onChangeText={set('instructions')} multiline maxLength={2000} />
        <Field label={t('cur.ed.setup')} value={f.setup} onChangeText={set('setup')} multiline maxLength={500} minHeight={60} />
        <TagInput label={t('cur.ed.cues')} value={f.cues} onChange={set('cues')} hint={t('cur.ed.cues_hint')} />
        <Field label={t('cur.f.criteria')} value={f.success_criteria} onChangeText={set('success_criteria')} multiline maxLength={500} minHeight={60} />
        <Field label={t('cur.f.progression')} value={f.progression} onChangeText={set('progression')} maxLength={300} /><Field label={t('cur.f.regression')} value={f.regression} onChangeText={set('regression')} maxLength={300} />
      </Step>
    </>
  );
  const preview = (
    <>
      <Panel><Meter checks={checks} /><View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><Btn title={t('common.save')} disabled={!checks[0].ok} onPress={save} /><Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onCancel} /></View></Panel>
      <Panel>
        <Eyebrow>{t('cur.ed.coach_view')}</Eyebrow>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={15} style={{ flex: 1 }}>{f.title || t('cur.ed.untitled')}</T><Tag label={t(`cur.kind.${f.kind}`)} color={c.cyanSoft} /><Tag label={lbl`${f.duration_min} min`} /></View>
        <T size={12} color={c.mute}>{[f.area, wr].filter(Boolean).join(' · ')}</T>
        {f.has_wr ? <View style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden' }}>{Array.from({ length: Math.min(f.rounds, 12) }).map((_, i) => <View key={i} style={{ flex: 1, flexDirection: 'row' }}><View style={{ flex: f.work, backgroundColor: c.pink }} /><View style={{ flex: Math.max(f.rest, 0.01), backgroundColor: c.violetSoft }} /></View>)}</View> : null}
        {f.instructions ? <T size={12.5}>{f.instructions}</T> : null}
        {f.cues.length ? <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{f.cues.map((q) => <Tag key={q} label={q} color={c.sunSoft} />)}</View> : null}
        {f.success_criteria ? <T size={12}>✓ {f.success_criteria}</T> : null}
        {f.progression || f.regression ? <T size={11.5} color={c.mute}>{f.progression ? `↑ ${f.progression}` : ''}  {f.regression ? `↓ ${f.regression}` : ''}</T> : null}
        {f.equipment.length ? <T size={11.5} color={c.mute}>🎒 {f.equipment.join(', ')}</T> : null}
      </Panel>
    </>
  );
  return <Split form={form} preview={preview} />;
}
