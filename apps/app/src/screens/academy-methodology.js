// Methodology library (#782): one per academy and sport. Philosophy and how-we-coach principles, the game model by phase of play, the stage
// ladder (age / level), competencies by pillar with what mastery looks like at each stage (optionally measured by an existing Coach
// Performance Studio rubric), approved drills, and outcomes by stage / age / position. Versions are append-only; curricula keep the version they
// were written against. The same screens serve every sport; nothing here is a scoring model.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { Block, Split } from './academy-ui';
import { DrillEditor } from './academy-curriculum-editors';
import { Eyebrow, GAME_PHASES, Hero, Panel, PILLARS, PILLAR_ICON, WrapTabs, opt, lbl } from './academy-curriculum-ui';

const KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'match_play', 'conditioning', 'recovery', 'review', 'custom'];

/** A stable key from a title; scripts without Latin letters fall back to a numbered key. */
export function slugOf(title, prefix, taken) {
  const base = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  let k = base || `${prefix}1`, n = 1;
  while (taken.has(k)) k = `${base || prefix}${++n}`.slice(0, 40);
  return k;
}

/** One editable list inside the draft: rows with edit / remove and a form sheet built from `fields`. */
function Items({ title, help, empty, items, onChange, fields, initial, build, line, form, setForm, name }) {
  return (
    <Block title={title} right={<Btn small title={t('cur.add')} color={c.paper} ink={c.ink} onPress={() => setForm({ name, at: items.length })} />}>
      {help ? <T size={12} color={c.mute}>{help}</T> : null}
      {items.length ? items.map((x, n) => (
        <Row key={x.key ?? n} title={line(x).title} sub={line(x).sub} right={<View style={{ flexDirection: 'row', gap: 6 }}><Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ name, at: n, x })} /><Btn small title={t('cur.remove')} color={c.paper} ink={c.ink} onPress={() => onChange(items.filter((_, i) => i !== n))} /></View>} />
      )) : <T size={13} color={c.mute}>{empty}</T>}
      <FormSheet visible={form?.name === name} onClose={() => setForm(null)} title={title} submitLabel={t('common.save')} initial={initial(form?.x)} fields={fields}
        onSubmit={async (v) => { const row = build(v, form?.x, items); const a = [...items]; a[form.at] = row; onChange(a); }} />
    </Block>
  );
}

function Editor({ m, version, onDone, toast, o }) {
  const [d, setD] = useState(() => ({ statement: version?.philosophy?.statement ?? '', values: version?.philosophy?.values ?? [], principles: version?.philosophy?.principles ?? [], standards: version?.standards ?? {}, stages: version?.stages ?? [], game_model: version?.game_model ?? [], competencies: version?.competencies ?? [], outcomes: version?.outcomes ?? [], drills: version?.drills ?? [] }));
  const [tab, setTab] = useState('philosophy');
  const [form, setForm] = useState(null);
  const paths = useLoad(() => api.get(`/organisations/${o.id}/academy/pathways`).catch(() => []), [o.id]);
  const rubrics = useLoad(() => api.get(`/organisations/${o.id}/academy/rubrics`).catch(() => []), [o.id]);
  const levels = (paths.data ?? []).flatMap((p) => p.levels.map((l) => ({ value: l.key, label: `${p.title} · ${l.title}` })));
  const set = (k) => (v) => setD((s) => ({ ...s, [k]: v }));
  const stageOpts = d.stages.map((s) => ({ value: s.key, label: s.title }));
  const compOpts = d.competencies.map((k) => ({ value: k.key, label: `${PILLAR_ICON[k.pillar]} ${k.title}` }));
  const taken = (k) => new Set(d[k].map((x) => x.key));
  const publish = async () => {
    try { await api.post(`/academy/methodologies/${m.id}/versions`, { row_version: m.row_version, philosophy: { statement: d.statement || undefined, values: d.values, principles: d.principles }, standards: d.standards, stages: d.stages, game_model: d.game_model, competencies: d.competencies, outcomes: d.outcomes, drills: d.drills }); toast(t('cur.lib.published')); onDone(); }
    catch (e) { toast(explain(e)); }
  };
  const tabs = [['philosophy', t('cur.lib.philosophy')], ['game', t('cur.lib.game_model')], ['stages', t('cur.lib.stages')], ['competencies', t('cur.lib.competencies')], ['drills', t('cur.lib.drills')], ['outcomes', t('cur.lib.outcomes')]];
  const st = d.standards;
  return (
    <View style={{ gap: 12 }}>
      <Hero title={t('cur.lib.draft_title', { n: (m.current_version ?? 0) + 1 })} sub={t('cur.lib.draft_sub')} stats={[{ label: t('cur.lib.stages'), value: d.stages.length }, { label: t('cur.lib.competencies'), value: d.competencies.length }, { label: t('cur.lib.drills'), value: d.drills.length }, { label: t('cur.lib.outcomes'), value: d.outcomes.length }]} />
      <WrapTabs value={tab} onChange={setTab} options={tabs.map(([value, label]) => ({ value, label }))} />

      {tab === 'philosophy' ? (
        <Panel>
          <Block title={t('cur.lib.statement')} right={<Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ name: 'statement' })} />}>
            {d.statement ? <T size={14}>“{d.statement}”</T> : <T size={13} color={c.mute}>{t('cur.lib.statement_hint')}</T>}
          </Block>
          <Items name="values" form={form} setForm={setForm} title={t('cur.lib.values')} empty={t('cur.lib.values_empty')} items={d.values} onChange={set('values')} line={(x) => ({ title: x.title, sub: x.description })}
            initial={(x) => x ?? {}} fields={[{ key: 'title', label: t('cur.f.title') }, { key: 'description', label: t('cur.f.description'), type: 'multiline', optional: true }]}
            build={(v, x, items) => ({ key: x?.key ?? slugOf(v.title, 'v', new Set(items.map((i) => i.key))), title: v.title, description: v.description || undefined })} />
          <Items name="principles" form={form} setForm={setForm} title={t('cur.lib.principles')} help={t('cur.lib.principles_help')} empty={t('cur.lib.principles_empty')} items={d.principles} onChange={set('principles')} line={(x) => ({ title: x.title, sub: x.description })}
            initial={(x) => x ?? {}} fields={[{ key: 'title', label: t('cur.f.title') }, { key: 'description', label: t('cur.f.description'), type: 'multiline', optional: true }]}
            build={(v, x, items) => ({ key: x?.key ?? slugOf(v.title, 'p', new Set(items.map((i) => i.key))), title: v.title, description: v.description || undefined })} />
          <Block title={t('cur.lib.standards')} right={<Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ name: 'standards' })} />}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {st.session_minutes ? <Tag label={lbl`${st.session_minutes} min`} color={c.cyanSoft} /> : null}{st.rpe_target ? <Tag label={lbl`RPE ${st.rpe_target}`} color={c.sunSoft} /> : null}{st.max_group_size ? <Tag label={t('cur.lib.max_group', { n: st.max_group_size })} color={c.pinkSoft} /> : null}{st.coach_ratio ? <Tag label={t('cur.lib.ratio', { n: st.coach_ratio })} color={c.mintSoft} /> : null}
            </View>
            {st.notes ? <T size={12.5}>{st.notes}</T> : !Object.keys(st).length ? <T size={13} color={c.mute}>{t('cur.lib.standards_hint')}</T> : null}
          </Block>
          <FormSheet visible={form?.name === 'statement'} onClose={() => setForm(null)} title={t('cur.lib.statement')} initial={{ s: d.statement }} fields={[{ key: 's', label: t('cur.lib.statement_label'), type: 'multiline', optional: true, hint: t('cur.lib.statement_hint') }]} onSubmit={async (v) => set('statement')(v.s ?? '')} />
          <FormSheet visible={form?.name === 'standards'} onClose={() => setForm(null)} title={t('cur.lib.standards')} initial={{ ...st }}
            fields={[{ key: 'session_minutes', label: t('cur.f.session_minutes'), type: 'stepper', min: 10, max: 300, step: 5, default: 75, optional: true }, { key: 'rpe_target', label: t('cur.f.rpe'), type: 'stepper', min: 1, max: 10, default: 6, optional: true }, { key: 'max_group_size', label: t('cur.f.max_group'), type: 'stepper', min: 1, max: 100, default: 16, optional: true }, { key: 'coach_ratio', label: t('cur.f.ratio'), type: 'stepper', min: 1, max: 60, default: 8, optional: true }, { key: 'notes', label: t('cur.f.note'), type: 'multiline', optional: true }]}
            onSubmit={async (v) => set('standards')(Object.fromEntries(Object.entries({ session_minutes: v.session_minutes, rpe_target: v.rpe_target, max_group_size: v.max_group_size, coach_ratio: v.coach_ratio, notes: v.notes || undefined }).filter(([, x]) => x != null)))} />
        </Panel>
      ) : null}

      {tab === 'game' ? (
        <Panel>
          <Items name="game" form={form} setForm={setForm} title={t('cur.lib.game_model')} help={t('cur.lib.game_help')} empty={t('cur.lib.game_empty')} items={d.game_model} onChange={set('game_model')} line={(x) => ({ title: x.title, sub: `${t(`cur.gphase.${x.phase}`)}${x.description ? ` · ${x.description}` : ''}` })}
            initial={(x) => x ?? { phase: 'in_possession' }} fields={[{ key: 'phase', label: t('cur.f.game_phase'), type: 'chips', options: opt(GAME_PHASES, 'cur.gphase') }, { key: 'title', label: t('cur.f.title') }, { key: 'description', label: t('cur.f.description'), type: 'multiline', optional: true }]}
            build={(v, x, items) => ({ key: x?.key ?? slugOf(v.title, 'g', new Set(items.map((i) => i.key))), phase: v.phase, title: v.title, description: v.description || undefined })} />
        </Panel>
      ) : null}

      {tab === 'stages' ? (
        <Panel>
          <Items name="stages" form={form} setForm={setForm} title={t('cur.lib.stages')} help={t('cur.lib.stages_help')} empty={t('cur.lib.stages_empty')} items={d.stages} onChange={set('stages')}
            line={(x) => ({ title: x.title, sub: `${x.age_min != null ? t('cur.ages', { a: x.age_min, b: x.age_max ?? '–' }) : ''}${x.hours_per_week ? ` · ${t('cur.lib.hours', { n: x.hours_per_week })}` : ''}${x.focus ? ` · ${x.focus}` : ''}` })}
            initial={(x) => (x ? { ...x, has_age: x.age_min != null } : {})} fields={[{ key: 'title', label: t('cur.f.title'), hint: t('cur.f.stage_title_hint') }, { key: 'has_age', label: t('cur.f.age_band'), type: 'switch' }, { key: 'age_min', label: t('cur.f.age_from'), type: 'stepper', min: 3, max: 99, default: 8, show: (v) => v.has_age }, { key: 'age_max', label: t('cur.f.age_to'), type: 'stepper', min: 3, max: 99, default: 10, show: (v) => v.has_age }, { key: 'hours_per_week', label: t('cur.f.hours'), type: 'stepper', min: 0, max: 60, default: 6, optional: true }, { key: 'focus', label: t('cur.f.focus_text'), optional: true }]}
            build={(v, x, items) => ({ key: x?.key ?? slugOf(v.title, 's', new Set(items.map((i) => i.key))), title: v.title, age_min: v.has_age ? v.age_min ?? 8 : undefined, age_max: v.has_age ? v.age_max ?? 10 : undefined, hours_per_week: v.hours_per_week ?? undefined, focus: v.focus || undefined })} />
        </Panel>
      ) : null}

      {tab === 'competencies' ? (
        <Panel>
          <Items name="competencies" form={form} setForm={setForm} title={t('cur.lib.competencies')} empty={t('cur.lib.competencies_empty')} items={d.competencies} onChange={set('competencies')}
            line={(x) => ({ title: `${PILLAR_ICON[x.pillar]} ${x.title}`, sub: `${t(`cur.pillar.${x.pillar}`)}${x.rubric_id ? ` · ${t('cur.lib.measured')}` : ''}${x.proficiency?.length ? ` · ${t('cur.lib.stages_described', { n: x.proficiency.length })}` : ''}` })}
            initial={(x) => (x ? { ...x, ...Object.fromEntries((x.proficiency ?? []).map((p) => [`prof_${p.stage_key}`, p.descriptor])), rubric_pick: x.rubric_id ? `${x.rubric_id}|${x.dimension_key ?? ''}` : undefined } : { pillar: 'technical' })}
            fields={[{ key: 'sA', type: 'section', label: t('cur.sec.basics') }, { key: 'title', label: t('cur.f.title') }, { key: 'pillar', label: t('cur.f.pillar'), type: 'chips', options: PILLARS.map((p) => ({ value: p, label: `${PILLAR_ICON[p]} ${t(`cur.pillar.${p}`)}` })) }, { key: 'description', label: t('cur.f.description'), type: 'multiline', optional: true },
              ...(d.stages.length ? [{ key: 'sB', type: 'section', label: t('cur.sec.proficiency') }, ...d.stages.map((s) => ({ key: `prof_${s.key}`, label: s.title, type: 'multiline', optional: true, hint: t('cur.f.proficiency_hint') }))] : []),
              ...((rubrics.data ?? []).length ? [{ key: 'sC', type: 'section', label: t('cur.sec.measure') }, { key: 'rubric_pick', label: t('cur.f.measured_by'), type: 'chips', optional: true, hint: t('cur.f.measured_hint'), options: (rubrics.data ?? []).flatMap((r) => (r.dimensions ?? []).map((dm) => ({ value: `${r.id}|${dm.key}`, label: `${r.name} · ${dm.name ?? dm.key}` }))) }] : [])]}
            build={(v, x, items) => { const [rid, dk] = (v.rubric_pick ?? '').split('|'); return { key: x?.key ?? slugOf(v.title, 'c', new Set(items.map((i) => i.key))), pillar: v.pillar, title: v.title, description: v.description || undefined, rubric_id: rid || undefined, dimension_key: dk || undefined, proficiency: d.stages.filter((s) => v[`prof_${s.key}`]).map((s) => ({ stage_key: s.key, descriptor: v[`prof_${s.key}`] })) }; }} />
        </Panel>
      ) : null}

      {tab === 'drills' ? (form?.name === 'drills' ? (
        <DrillEditor x={form.x} meth={{ competencies: d.competencies }} std={d.standards} taken={taken('drills')} onCancel={() => setForm(null)} onSave={(row) => { const a = [...d.drills]; a[form.at] = row; set('drills')(a); setForm(null); }} />
      ) : (
        <Panel>
          <Block title={t('cur.lib.drills')} right={<Btn small title={t('cur.add')} color={c.paper} ink={c.ink} onPress={() => setForm({ name: 'drills', at: d.drills.length })} />}>
            <T size={12} color={c.mute}>{t('cur.lib.drills_help')}</T>
            {d.drills.length ? d.drills.map((x, n) => <Row key={x.key} title={x.title} sub={`${t(`cur.kind.${x.kind}`)}${x.duration_min ? ` · ${x.duration_min} min` : ''}${x.area ? ` · ${x.area}` : ''}${x.competency_keys?.length ? ` · ${x.competency_keys.map((k) => d.competencies.find((y) => y.key === k)?.title ?? k).join(', ')}` : ''}`} right={<View style={{ flexDirection: 'row', gap: 6 }}><Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ name: 'drills', at: n, x })} /><Btn small title={t('cur.remove')} color={c.paper} ink={c.ink} onPress={() => set('drills')(d.drills.filter((_, i) => i !== n))} /></View>} />) : <T size={13} color={c.mute}>{t('cur.lib.drills_empty')}</T>}
          </Block>
        </Panel>
      )) : null}

      {tab === 'outcomes' ? (
        <Panel>
          <Items name="outcomes" form={form} setForm={setForm} title={t('cur.lib.outcomes')} help={t('cur.lib.outcomes_help')} empty={t('cur.lib.outcomes_empty')} items={d.outcomes} onChange={set('outcomes')}
            line={(x) => ({ title: x.outcome, sub: [d.competencies.find((k) => k.key === x.competency_key)?.title ?? x.competency_key, d.stages.find((s) => s.key === x.stage_key)?.title, x.age_min != null ? t('cur.ages', { a: x.age_min, b: x.age_max ?? '–' }) : null, x.level_key, x.position].filter(Boolean).join(' · ') })}
            initial={(x) => (x ? { ...x, has_age: x.age_min != null } : {})}
            fields={[{ key: 'competency_key', label: t('cur.f.competency'), type: 'chips', options: compOpts }, { key: 'outcome', label: t('cur.f.outcome_text'), type: 'multiline' }, ...(d.stages.length ? [{ key: 'stage_key', label: t('cur.f.stage'), type: 'chips', optional: true, options: stageOpts }] : []),
              { key: 'has_age', label: t('cur.f.age_band'), type: 'switch' }, { key: 'age_min', label: t('cur.f.age_from'), type: 'stepper', min: 3, max: 99, default: 8, show: (v) => v.has_age }, { key: 'age_max', label: t('cur.f.age_to'), type: 'stepper', min: 3, max: 99, default: 12, show: (v) => v.has_age },
              ...(levels.length ? [{ key: 'level_key', label: t('cur.f.level'), type: 'chips', optional: true, options: levels }] : []), { key: 'position', label: t('cur.f.position'), optional: true, hint: t('cur.f.position_hint') }]}
            build={(v) => ({ competency_key: v.competency_key, stage_key: v.stage_key || undefined, outcome: v.outcome, age_min: v.has_age ? v.age_min ?? 8 : undefined, age_max: v.has_age ? v.age_max ?? 12 : undefined, level_key: v.level_key || undefined, position: v.position || undefined })} />
        </Panel>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title={t('cur.lib.publish')} disabled={!d.competencies.length} onPress={publish} /><Btn title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onDone} />
      </View>
      {!d.competencies.length ? <T size={12} color={c.mute}>{t('cur.lib.competencies_empty')}</T> : null}
    </View>
  );
}

function Detail({ id, o, staff, archived, toast, onChanged, edit, setEdit }) {
  const d = useLoad(() => api.get(`/academy/methodologies/${id}`), [id]);
  const [tab, setTab] = useState('overview');
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { methodology: m, versions } = d.data, v = versions[0];
  if (edit) return <Editor m={m} version={v} o={o} toast={toast} onDone={() => { setEdit(false); d.reload(); onChanged(); }} />;
  if (!v) return <View style={{ gap: 10 }}><Empty emoji="📖" title={t('cur.lib.not_started')} sub={staff ? t('cur.lib.not_started_staff') : t('cur.lib.not_started_coach')} />{staff && !archived ? <Btn title={t('cur.lib.start')} onPress={() => setEdit(true)} /> : null}</View>;
  const tabs = [['overview', t('cur.lib.philosophy')], ['game', t('cur.lib.game_model')], ['ladder', t('cur.lib.stages')], ['matrix', t('cur.lib.competencies')], ['drills', t('cur.lib.drills')], ['history', t('cur.versions')]];
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={m.sport} /><Tag label={lbl`v${v.version}`} color={c.lime} />{staff && !archived ? <Btn small title={t('cur.new_version')} onPress={() => setEdit(true)} /> : null}</View>
      <WrapTabs value={tab} onChange={setTab} options={tabs.map(([value, label]) => ({ value, label }))} />
      {tab === 'overview' ? (
        <View style={{ gap: 10 }}>
          {v.philosophy?.statement ? <T size={15} weight="600">“{v.philosophy.statement}”</T> : null}
          {v.philosophy?.values?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{v.philosophy.values.map((x) => <Tag key={x.key} label={x.title} color={c.pinkSoft} />)}</View> : null}
          {v.philosophy?.principles?.length ? <Block title={t('cur.lib.principles')}>{v.philosophy.principles.map((x) => <View key={x.key}><T weight="700" size={13}>{x.title}</T>{x.description ? <T size={12} color={c.mute}>{x.description}</T> : null}</View>)}</Block> : null}
          {Object.keys(v.standards ?? {}).length ? <Block title={t('cur.lib.standards')}><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{v.standards.session_minutes ? <Tag label={lbl`${v.standards.session_minutes} min`} color={c.cyanSoft} /> : null}{v.standards.rpe_target ? <Tag label={lbl`RPE ${v.standards.rpe_target}`} color={c.sunSoft} /> : null}{v.standards.max_group_size ? <Tag label={t('cur.lib.max_group', { n: v.standards.max_group_size })} color={c.pinkSoft} /> : null}{v.standards.coach_ratio ? <Tag label={t('cur.lib.ratio', { n: v.standards.coach_ratio })} color={c.mintSoft} /> : null}</View>{v.standards.notes ? <T size={12.5}>{v.standards.notes}</T> : null}</Block> : null}
          {!v.philosophy?.statement && !v.philosophy?.values?.length ? <T size={13} color={c.mute}>{t('cur.lib.statement_hint')}</T> : null}
        </View>
      ) : null}
      {tab === 'game' ? (v.game_model.length ? GAME_PHASES.map((ph) => { const rows = v.game_model.filter((x) => (x.phase === ph)); return rows.length ? <Block key={ph} title={t(`cur.gphase.${ph}`)}>{rows.map((x) => <View key={x.key}><T weight="700" size={13}>{x.title}</T>{x.description ? <T size={12} color={c.mute}>{x.description}</T> : null}</View>)}</Block> : null; }) : <T size={13} color={c.mute}>{t('cur.lib.game_empty')}</T>) : null}
      {tab === 'ladder' ? (v.stages.length ? v.stages.map((s, i) => (
        <View key={s.key} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 3 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}><T size={12} weight="800" color="#fff">{i + 1}</T></View><T weight="800" size={14} style={{ flex: 1 }}>{s.title}</T>{s.age_min != null ? <Tag label={t('cur.ages', { a: s.age_min, b: s.age_max ?? '–' })} color={c.cyanSoft} /> : null}</View>
          {s.hours_per_week ? <T size={12} color={c.mute}>{t('cur.lib.hours', { n: s.hours_per_week })}</T> : null}{s.focus ? <T size={12.5}>{s.focus}</T> : null}
        </View>)) : <T size={13} color={c.mute}>{t('cur.lib.stages_empty')}</T>) : null}
      {tab === 'matrix' ? PILLARS.map((p) => {
        const rows = v.competencies.filter((k) => k.pillar === p);
        return rows.length ? (
          <Block key={p} title={lbl`${PILLAR_ICON[p]} ${t(`cur.pillar.${p}`)}`}>
            {rows.map((k) => (
              <View key={k.key} style={{ gap: 3, paddingVertical: 4 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={13.5}>{k.title}</T>{k.rubric_id ? <Tag label={t('cur.lib.measured')} color={c.lime} /> : null}</View>
                {k.description ? <T size={12} color={c.mute}>{k.description}</T> : null}
                {(k.proficiency ?? []).map((pr) => <T key={pr.stage_key} size={12}><T size={12} weight="800">{v.stages.find((s) => s.key === pr.stage_key)?.title ?? pr.stage_key}: </T>{pr.descriptor}</T>)}
                <T size={11} color={c.mute}>{t('cur.drills_n', { n: v.drills.filter((x) => x.competency_keys.includes(k.key)).length })} · {t('cur.outcomes_n', { n: v.outcomes.filter((x) => x.competency_key === k.key).length })}</T>
              </View>
            ))}
          </Block>
        ) : null;
      }) : null}
      {tab === 'drills' ? (v.drills.length ? v.drills.map((x) => (
        <View key={x.key} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 3 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={14} style={{ flex: 1 }}>{x.title}</T><Tag label={t(`cur.kind.${x.kind}`)} color={c.cyanSoft} />{x.duration_min ? <Tag label={lbl`${x.duration_min} min`} /> : null}</View>
          <T size={12} color={c.mute}>{[x.area, x.work_rest].filter(Boolean).join(' · ')}</T>
          {x.instructions ? <T size={12.5}>{x.instructions}</T> : null}
          {x.success_criteria ? <T size={12}>✓ {x.success_criteria}</T> : null}
          {x.progression || x.regression ? <T size={11.5} color={c.mute}>{x.progression ? `↑ ${x.progression}` : ''}{x.progression && x.regression ? '  ' : ''}{x.regression ? `↓ ${x.regression}` : ''}</T> : null}
          <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{x.competency_keys.map((k) => <Tag key={k} label={v.competencies.find((y) => y.key === k)?.title ?? k} color={c.pinkSoft} />)}</View>
        </View>)) : <T size={13} color={c.mute}>{t('cur.lib.drills_empty')}</T>) : null}
      {tab === 'history' ? <Block title={t('cur.versions')}>{versions.map((x) => <Row key={x.version} title={lbl`v${x.version}`} sub={`${x.competencies.length} ${t('cur.lib.competencies').toLowerCase()} · ${x.drills.length} ${t('cur.lib.drills').toLowerCase()}${x.note ? ` · ${x.note}` : ''}`} />)}<T size={11} color={c.mute}>{t('cur.history_note')}</T></Block> : null}
    </View>
  );
}

export function Library({ o, staff, archived, toast }) {
  const list = useLoad(() => api.get(`/organisations/${o.id}/academy/methodologies`), [o.id]);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(false);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Loading />;
  const sel = list.data.find((x) => x.id === open);
  const body = (
    <View style={{ gap: 10 }}>
      {staff && !archived ? <Btn title={t('cur.lib.new')} onPress={() => setForm(true)} /> : null}
      {list.data.length ? list.data.map((m) => (
        <Card key={m.id} pad={14} color={open === m.id ? c.pinkSoft : c.paper} onPress={() => setOpen(m.id)} accessibilityLabel={lbl`${m.title}, ${m.sport}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T weight="800" size={15} style={{ flex: 1 }}>{m.title}</T><Tag label={m.sport} />{m.current_version ? <Tag label={lbl`v${m.current_version}`} color={c.lime} /> : null}</View>
          <T size={12} color={c.mute}>{t('cur.lib.counts', { c: m.competencies ?? 0, d: m.drills ?? 0, v: m.stages ?? 0, k: m.curricula })}</T>
        </Card>
      )) : <Empty emoji="📖" title={t('cur.lib.empty_title')} sub={staff ? t('cur.lib.empty_staff') : t('cur.lib.empty_coach')} />}
    </View>
  );
  if (edit && open) return <Detail key={`e${open}`} id={open} o={o} staff={staff} archived={archived} toast={toast} onChanged={list.reload} edit setEdit={setEdit} />;
  return (
    <>
      <Split list={body} open={!!open} onClose={() => setOpen(null)} detailTitle={sel?.title} detail={open ? <Detail key={open} id={open} o={o} staff={staff} archived={archived} toast={toast} onChanged={list.reload} edit={false} setEdit={setEdit} /> : null} />
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('cur.lib.new')} submitLabel={t('cur.create')}
        fields={[{ key: 'sport', label: t('cur.f.sport'), type: 'sport' }, { key: 'title', label: t('cur.f.title'), hint: t('cur.lib.title_hint') }]}
        onSubmit={async (v) => { const r = await api.post(`/organisations/${o.id}/academy/methodologies`, { sport: v.sport, title: v.title }); list.reload(); setOpen(r.id); return t('cur.created'); }} />
    </>
  );
}
