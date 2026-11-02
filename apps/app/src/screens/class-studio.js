// Class studio: where a coach plans a class, runs it, scores the people in it and reviews it. One screen, three working areas.
//   Plan      a timed session: objective, a timeline whose clock times follow the blocks, each block edited in place (setup, instructions, cues, what good
//             looks like, effort, skills worked), a time budget against the class length, a personal drill library, copy from an earlier class, preview, share.
//   Students  the coach's own rubric as a scoring grid (per person, per skill) with the last scores and the change, attendance, a practice task, a goal,
//             a private note and a summary that is shared only when the coach says so.
//   Review    how the class went, a message to the class, a private reflection, and what to carry into the next class.
// It is the coaching journal underneath (plan versions, observations, rubrics, goals, actions): nothing is copied. Shared cross-platform kit only; all text
// goes through t(); the server decides who may see what.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Btn, Chip, Empty, ErrorBox, Field, H1, Loading, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { Counter } from '../pickers';
import { t } from '../i18n';
import { c, when } from '../theme';
import { explain } from '../access';

const KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'conditioning', 'recovery', 'review', 'custom'];
const KIND_TONE = { warm_up: c.sun, skill_drill: c.cyan, tactical_drill: c.cyan, conditioned_game: c.lime, conditioning: c.orange, recovery: c.mint, review: c.violet, custom: c.mute };
const QUICK = ['warm_up', 'skill_drill', 'conditioned_game', 'conditioning', 'recovery'];
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clean = (b) => ({ ...(b.id && !String(b.id).startsWith('new-') ? { id: b.id } : {}), kind: b.kind, title: b.title, duration_min: b.duration_min, ...(b.setup ? { setup: b.setup } : {}), ...(b.instructions ? { instructions: b.instructions } : {}), cues: b.cues ?? [], ...(b.success_criteria ? { success_criteria: b.success_criteria } : {}), ...(b.target_rpe ? { target_rpe: b.target_rpe } : {}), tags: b.tags ?? [], ...(b.coach_notes ? { coach_notes: b.coach_notes } : {}) });

export function ClassStudio({ id }) {
  const { tablet } = useLayout();
  const w = useLoad(() => api.post(`/coach/classes/${id}/workspace`), [id]);
  const [tab, setTab] = useState('plan');
  if (w.error) return <Screen><ErrorBox error={w.error} onRetry={w.reload} /></Screen>;
  if (!w.data) return <Screen><Loading /></Screen>;
  const d = w.data;
  return (
    <Screen wide>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('st.title').toUpperCase()}</T>
      <H1 style={{ fontSize: tablet ? 30 : 26 }}>{d.title}</H1>
      <T color={c.mute}>{when(d.starts_at)} · {d.duration_min} {t('cls.min')} · {d.roster.length} {t('cp.roster').toLowerCase()}</T>
      <View style={{ marginVertical: 12 }}><Seg value={tab} onChange={setTab} options={[{ value: 'plan', label: t('cp.tab.plan') }, { value: 'students', label: t('cp.roster') }, { value: 'review', label: t('st.tab.review') }]} /></View>
      {tab === 'plan' ? <PlanArea d={d} reload={w.reload} wide={tablet} /> : tab === 'students' ? <StudentsArea d={d} reload={w.reload} /> : <ReviewArea d={d} reload={w.reload} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ plan

function PlanArea({ d, reload, wide }) {
  const { toast } = useSession();
  const locked = d.status !== 'open';
  const [blocks, setBlocks] = useState(() => d.plan.blocks.map((b) => ({ cues: [], tags: [], ...b })));
  const [objective, setObjective] = useState(d.objective ?? '');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const saved = JSON.stringify(d.plan.blocks.map(clean));
  const dirty = JSON.stringify(blocks.map(clean)) !== saved || objective !== (d.objective ?? '');
  const rubrics = useLoad(() => api.get('/coaching/rubrics', { limit: 50 }), []);
  const library = useLoad(() => api.get('/coach/templates', { scope: 'block', limit: 100 }), []);
  const skills = useMemo(() => [...new Set((rubrics.data ?? []).flatMap((r) => (r.dimensions ?? []).map((x) => x.name)))].sort(), [rubrics.data]);
  const planned = blocks.reduce((s, b) => s + (b.duration_min ?? 0), 0);
  const left = d.duration_min - planned;
  const starts = useMemo(() => { let at = new Date(d.starts_at); return blocks.map((b) => { const from = at; at = new Date(+at + (b.duration_min ?? 0) * 6e4); return [from, at]; }); }, [blocks, d.starts_at]);
  const patch = (i, p) => setBlocks((x) => x.map((b, j) => (j === i ? { ...b, ...p } : b)));
  const move = (i, to) => setBlocks((x) => { const n = x.slice(); const [b] = n.splice(i, 1); n.splice(to, 0, b); return n; });
  const add = (kind, from = {}) => { const b = { id: `new-${uid()}`, kind, title: from.title ?? '', duration_min: from.duration_min ?? Math.max(5, Math.min(30, left > 0 ? left : 10)), cues: [], tags: [], ...from, id: `new-${uid()}` }; setBlocks((x) => [...x, b]); setOpen(b.id); };
  const run = async (fn, done) => { setBusy(true); try { const r = await fn(); if (done) toast(typeof done === 'function' ? done(r) : done); return r; } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const save = () => run(async () => { await api.post(`/coaching/sessions/${d.record_id}/plan`, { blocks: blocks.map(clean), objective: objective || undefined, expected_version: d.plan.version }); await reload(); }, t('cp.plan_saved'));
  const toLibrary = (b) => run(() => api.post('/coaching/templates', { title: b.title, scope: 'block', blocks: [clean(b)] }).then(() => library.reload()), t('st.saved_library'));
  const bad = blocks.some((b) => !b.title || b.title.trim().length < 2);

  const timeline = (
    <View style={{ gap: 10 }}>
      <Budget planned={planned} total={d.duration_min} left={left} />
      {blocks.length === 0 ? <Empty emoji="📝" title={t('cp.no_blocks')} /> : blocks.map((b, i) => (
        <BlockCard key={b.id} b={b} i={i} n={blocks.length} range={starts[i]} open={open === b.id} locked={locked} skills={skills}
          onToggle={() => setOpen(open === b.id ? null : b.id)} onPatch={(p) => patch(i, p)} onMove={(to) => move(i, to)}
          onDuplicate={() => { const copy = { ...b, id: `new-${uid()}`, title: b.title }; setBlocks((x) => [...x.slice(0, i + 1), copy, ...x.slice(i + 1)]); setOpen(copy.id); }}
          onRemove={() => { setBlocks((x) => x.filter((_, j) => j !== i)); setOpen(null); }} onLibrary={() => toLibrary(b)} />
      ))}
      {!locked ? (
        <View style={{ gap: 8 }}>
          <T weight="700" size={12} color={c.mute} style={{ letterSpacing: 0.6 }}>{t('st.add_block').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{QUICK.map((k) => <Chip key={k} label={`+ ${t(`cp.kind.${k}`)}`} onPress={() => add(k)} />)}</View>
          <MenuField value="" onChange={(x) => { const tpl = (library.data ?? []).find((y) => y.id === x); if (tpl) tpl.blocks.forEach((b) => add(b.kind ?? 'skill_drill', b)); }} title={t('st.from_library')} placeholder={t('st.from_library')}
            options={(library.data ?? []).map((x) => ({ value: x.id, label: x.title, sub: [x.sport_name, x.blocks?.[0]?.duration_min ? `${x.blocks[0].duration_min} ${t('cls.min')}` : null].filter(Boolean).join(' · ') }))} hint={library.data?.length ? undefined : t('st.library_empty')} />
        </View>
      ) : null}
    </View>
  );

  const objectiveBlock = (
      <Section title={t('cp.objective')} color={c.violet}>
        <Field value={objective} onChangeText={setObjective} multiline placeholder={t('cp.objective_hint')} accessibilityLabel={t('cp.objective')} minHeight={90} maxLength={1000} />
      </Section>
  );
  const rest = (
    <View style={{ gap: 12 }}>
      <Section title={t('cp.share')} color={c.mint}>
        <T color={c.mute} size={13}>{d.shared ? t('cp.shared_v', { v: d.shared_version }) : t('cp.not_shared')}</T>
        {d.plan_changed_since_share ? <T size={13} color={c.sun} weight="700">{t('cp.shared_changed')}</T> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <Btn small title={t('st.preview')} color={c.paper} ink={c.ink} onPress={() => setPreview(true)} disabled={!blocks.length} />
          {d.plan.version > 0 && !dirty && (!d.shared || d.plan_changed_since_share) ? <Btn small title={t('cp.share')} loading={busy} disabled={locked} onPress={() => run(async () => { const r = await api.post(`/coach/classes/${d.class_id}/plan/share`, { share: true }); await reload(); return r; }, (r) => t('cp.shared_told', { n: r.told }))} /> : null}
          {d.shared ? <Btn small title={t('cp.unshare')} color={c.paper} ink={c.ink} loading={busy} onPress={() => run(async () => { await api.post(`/coach/classes/${d.class_id}/plan/share`, { share: false }); await reload(); }, t('cp.stopped'))} /> : null}
        </View>
        {dirty ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('st.save_first')}</T> : null}
      </Section>
      {!locked && d.copy_from.length ? (
        <Section title={t('cp.copy_from')} color={c.cyan}>
          <MenuField value="" onChange={(x) => x && run(async () => { await api.post(`/coach/classes/${d.class_id}/plan/copy`, { from_class_id: x }); await reload(); }, t('cp.copied'))} title={t('cp.copy_from')} placeholder={t('cp.copy_from')}
            options={d.copy_from.map((o) => ({ value: o.class_id, label: o.title, sub: when(o.starts_at) }))} />
        </Section>
      ) : null}
    </View>
  );

  return (
    <View style={{ gap: 12 }}>
      {dirty ? (
        <View accessible style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.sun, backgroundColor: c.paper }}>
          <T weight="700" color={c.sun} style={{ flex: 1, minWidth: 140 }}>{t('st.unsaved')}</T>
          <Btn small title={t('st.discard')} color={c.paper} ink={c.ink} onPress={() => { setBlocks(d.plan.blocks.map((b) => ({ cues: [], tags: [], ...b }))); setObjective(d.objective ?? ''); setOpen(null); }} />
          <Btn small title={t('cp.save_plan')} loading={busy} disabled={bad || locked} onPress={save} />
        </View>
      ) : null}
      {wide ? <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}><View style={{ flex: 3, minWidth: 0 }}>{timeline}</View><View style={{ flex: 2, minWidth: 280, gap: 12 }}>{objectiveBlock}{rest}</View></View> : <>{objectiveBlock}{timeline}{rest}</>}
      {preview ? <PlanPreview objective={objective} blocks={blocks} onClose={() => setPreview(false)} /> : null}
    </View>
  );
}

function Budget({ planned, total, left }) {
  const pct = total ? Math.min(100, Math.round((planned / total) * 100)) : 0;
  const tone = left < 0 ? c.red : left === 0 ? c.lime : c.cyan;
  const text = left < 0 ? t('st.budget_over', { n: -left }) : left === 0 ? t('st.budget_full') : t('st.budget_left', { n: left });
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={[t('st.budget', { planned, total }), text].join('. ')} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><T weight="800">{t('st.budget', { planned, total })}</T><T size={13} weight="700" color={tone}>{text}</T></View>
      <View style={{ height: 10, borderRadius: 5, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 10, width: `${pct}%`, backgroundColor: tone }} /></View>
    </View>
  );
}

function BlockCard({ b, i, n, range, open, locked, skills, onToggle, onPatch, onMove, onDuplicate, onRemove, onLibrary }) {
  const [cue, setCue] = useState('');
  const tone = KIND_TONE[b.kind] ?? c.mute;
  const head = [hhmm(range[0]), hhmm(range[1])].join(' – ');
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: open ? c.ink : c.line, backgroundColor: c.paper, overflow: 'hidden' }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={[head, b.title || t('cp.block_title'), t(`cp.kind.${b.kind}`)].join(', ')} style={{ flexDirection: 'row', gap: 12, padding: 14, alignItems: 'center', minHeight: 56 }}>
        <View style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, backgroundColor: tone }} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={12} color={c.mute} weight="700">{head} · {b.duration_min} {t('cls.min')}</T>
          <T weight="800" size={16}>{b.title || t('st.untitled')}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={t(`cp.kind.${b.kind}`)} />{(b.tags ?? []).slice(0, 3).map((x) => <T key={x} size={12} color={c.mute}>#{x}</T>)}</View>
        </View>
        <T size={14} color={c.mute}>{open ? '▲' : '▼'}</T>
      </Pressable>
      {open ? (
        <View style={{ padding: 14, gap: 12, borderTopWidth: 1, borderTopColor: c.line }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{KINDS.map((k) => <Chip key={k} label={t(`cp.kind.${k}`)} active={b.kind === k} onPress={() => !locked && onPatch({ kind: k })} />)}</View>
          <Field label={t('cp.block_title')} value={b.title} onChangeText={(x) => onPatch({ title: x })} maxLength={120} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>{t('cp.block_minutes')}</T><Counter value={b.duration_min ?? 10} min={1} max={240} step={5} onChange={(x) => onPatch({ duration_min: x })} a11y={t('cp.block_minutes')} /></View>
          <Field label={t('st.setup')} value={b.setup} onChangeText={(x) => onPatch({ setup: x })} multiline minHeight={60} maxLength={500} />
          <Field label={t('cp.block_instructions')} value={b.instructions} onChangeText={(x) => onPatch({ instructions: x })} multiline minHeight={90} maxLength={2000} />
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('st.cues').toUpperCase()}</T>
            {(b.cues ?? []).map((x, j) => <View key={`${x}${j}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T style={{ flex: 1 }}>• {x}</T><Btn small title="✕" color={c.paper} ink={c.ink} onPress={() => onPatch({ cues: b.cues.filter((_, k) => k !== j) })} accessibilityLabel={t('cp.remove')} /></View>)}
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={cue} onChangeText={setCue} placeholder={t('st.add_cue')} maxLength={200} accessibilityLabel={t('st.add_cue')} /></View><Btn small title={t('cp.add_cue_btn')} disabled={!cue.trim()} onPress={() => { onPatch({ cues: [...(b.cues ?? []), cue.trim()] }); setCue(''); }} /></View>
          </View>
          <Field label={t('st.success')} value={b.success_criteria} onChangeText={(x) => onPatch({ success_criteria: x })} multiline minHeight={60} maxLength={500} />
          <MultiMenuField label={t('st.skills')} value={b.tags ?? []} onChange={(x) => onPatch({ tags: x })} options={skills.map((x) => ({ value: x, label: x }))} placeholder={t('common.choose')} hint={skills.length ? undefined : t('st.no_skills')} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><T weight="600">{t('st.effort')}</T><T size={12} color={c.mute}>{t('st.effort_hint')}</T></View><Counter value={b.target_rpe ?? 0} min={0} max={10} onChange={(x) => onPatch({ target_rpe: x || undefined })} a11y={t('st.effort')} /></View>
          <Field label={t('cp.block_notes')} value={b.coach_notes} onChangeText={(x) => onPatch({ coach_notes: x })} multiline minHeight={60} maxLength={1000} hint={t('cp.block_notes_hint')} />
          {!locked ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Btn small title="↑" color={c.paper} ink={c.ink} disabled={i === 0} onPress={() => onMove(i - 1)} accessibilityLabel={t('cp.move_up')} />
              <Btn small title="↓" color={c.paper} ink={c.ink} disabled={i === n - 1} onPress={() => onMove(i + 1)} accessibilityLabel={t('cp.move_down')} />
              <Btn small title={t('st.duplicate')} color={c.paper} ink={c.ink} onPress={onDuplicate} />
              <Btn small title={t('st.save_to_library')} color={c.paper} ink={c.ink} disabled={!b.title || b.title.trim().length < 2} onPress={onLibrary} />
              <Btn small title={t('cp.remove')} color={c.red} onPress={onRemove} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PlanPreview({ objective, blocks, onClose }) {
  return (
    <Sheet visible onClose={onClose} title={t('cp.plan_title')}>
      <View style={{ gap: 10 }}>
        <T size={12} color={c.mute}>{t('st.preview_note')}</T>
        {objective ? <T weight="700">{objective}</T> : null}
        {blocks.map((b, i) => (
          <View key={b.id} style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.violetSoft }}>
            <T weight="800">{[i + 1, b.title].join('. ')}</T>
            <T size={12} color={c.mute}>{[t(`cp.kind.${b.kind}`), `${b.duration_min} ${t('cls.min')}`].join(' · ')}</T>
            {b.setup ? <T size={13}>{b.setup}</T> : null}
            {b.instructions ? <T size={13}>{b.instructions}</T> : null}
            {(b.cues ?? []).map((x, j) => <T key={j} size={13}>• {x}</T>)}
            {b.success_criteria ? <T size={13} weight="700">{b.success_criteria}</T> : null}
          </View>
        ))}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ students

function StudentsArea({ d, reload }) {
  const { toast } = useSession();
  const { push } = useNav();
  const rubrics = useLoad(() => api.get('/coaching/rubrics', { limit: 50 }), []);
  const [rubricId, setRubricId] = useState(null);
  const list = (rubrics.data ?? []).filter((r) => !r.sport_ids?.length || r.sport_ids.includes(d.sport_id));
  useEffect(() => { if (!rubricId && list.length) setRubricId(list[0].id); }, [list.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  const grid = useLoad(() => (rubricId ? api.get(`/coach/classes/${d.class_id}/scores`, { rubric_id: rubricId }) : Promise.resolve(null)), [rubricId]);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState(null), [goal, setGoal] = useState(null), [note, setNote] = useState(null), [sum, setSum] = useState(null);
  useEffect(() => setDraft({}), [rubricId]);
  const g = grid.data;
  const set = (a, k, v) => setDraft((x) => ({ ...x, [`${a}:${k}`]: v }));
  const cell = (r, dim) => draft[`${r.athlete_id}:${dim.key}`] ?? r.dimensions[dim.key]?.score ?? null;
  const changes = Object.entries(draft).map(([k, score]) => { const [athlete_id, dimension_key] = k.split(':'); return { athlete_id, dimension_key, score }; });
  const saveScores = async () => { setBusy(true); try { const r = await api.post(`/coach/classes/${d.class_id}/scores`, { rubric_id: rubricId, scores: changes }); toast(t('st.scores_saved', { n: r.saved })); setDraft({}); await grid.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const mark = async (r, attendance) => { try { await api.post(`/coach/classes/${d.class_id}/seats/${r.seat_id}/attendance`, { attendance }); await reload(); } catch (e) { toast(explain(e)); } };
  const started = new Date(d.starts_at) <= new Date();
  // open this person's evaluation for the class (the one already in progress, or a new one that starts from the scores given here)
  const evaluate = async (r) => {
    try {
      const have = await api.get('/coaching/evaluations', { athlete_id: r.user_id, class_id: d.class_id, rubric_id: rubricId, limit: 1 });
      const ev = have[0] ?? await api.post('/coaching/evaluations', { athlete_id: r.user_id, rubric_id: rubricId, context_type: 'class', class_id: d.class_id });
      push('Evaluation', { id: ev.id });
    } catch (e) { toast(explain(e)); }
  };
  if (!d.roster.length) return <Empty emoji="🧑‍🤝‍🧑" title={t('cp.no_roster')} />;
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('st.rubric')} value={rubricId ?? ''} onChange={setRubricId} placeholder={t('st.rubric_pick')} options={list.map((r) => ({ value: r.id, label: r.name, sub: (r.dimensions ?? []).map((x) => x.name).join(', ') }))} />
      {changes.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.sun, backgroundColor: c.paper }}>
          <T weight="700" color={c.sun} style={{ flex: 1, minWidth: 140 }}>{t('st.unsaved')}</T>
          <Btn small title={t('st.discard')} color={c.paper} ink={c.ink} onPress={() => setDraft({})} /><Btn small title={t('st.score_save')} loading={busy} onPress={saveScores} />
        </View>
      ) : null}
      {g ? <T size={12} color={c.mute}>{t('st.rubric_note')}</T> : null}
      {d.roster.map((r) => {
        const row = g?.rows.find((x) => x.athlete_id === r.user_id);
        return (
          <View key={r.seat_id} style={{ gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T weight="800" size={16} style={{ flex: 1, minWidth: 140 }}>{r.display_name}{r.is_youth ? ` · ${t('cls.young')}` : ''}</T>
              {r.recorded ? <Tag label={t('cp.attended_of', { a: r.attended, r: r.recorded })} /> : null}
              {r.open_goals ? <Tag label={t('cp.goals_n', { n: r.open_goals })} /> : null}
            </View>
            {row ? g.rubric.dimensions.map((dim) => <ScoreRow key={dim.key} dim={dim} cur={cell(row, dim)} h={row.dimensions[dim.key]} onPick={(v) => set(r.user_id, dim.key, v)} name={r.display_name} />) : (grid.loading ? null : <T size={13} color={c.mute}>{t('st.rubric_pick')}</T>)}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {started ? <><Btn small title={t('cls.attended')} color={r.class_attendance === 'attended' ? c.mint : c.paper} ink={c.ink} onPress={() => mark(r, 'attended')} /><Btn small title={t('cls.no_show')} color={r.class_attendance === 'no_show' ? c.red : c.paper} ink={c.ink} onPress={() => mark(r, 'no_show')} /></> : null}
              {rubricId ? <Btn small title={t('es.evaluate')} onPress={() => evaluate(r)} accessibilityLabel={[t('es.evaluate'), r.display_name].join(': ')} /> : null}
              <Btn small title={t('st.task')} color={c.paper} ink={c.ink} onPress={() => setTask(r)} accessibilityLabel={[t('st.task'), r.display_name].join(': ')} />
              <Btn small title={t('st.goal')} color={c.paper} ink={c.ink} onPress={() => setGoal(r)} accessibilityLabel={[t('st.goal'), r.display_name].join(': ')} />
              <Btn small title={t('cp.add_note')} color={c.paper} ink={c.ink} onPress={() => setNote(r)} accessibilityLabel={[t('cp.add_note'), r.display_name].join(': ')} />
              <Btn small title={t('cp.write_summary')} color={c.paper} ink={c.ink} onPress={() => setSum(r)} accessibilityLabel={[t('cp.write_summary'), r.display_name].join(': ')} />
            </View>
            {r.summary_shared ? <T size={12} color={c.mint} weight="700">{t('cp.summary_shared')}</T> : null}
          </View>
        );
      })}
      {task ? (
        <FormSheet visible onClose={() => setTask(null)} title={[t('st.task'), task.display_name].join(': ')} submitLabel={t('common.save')} initial={{}} notice={task.can_share ? undefined : t('cp.consent_needed')}
          fields={[{ key: 'title', label: t('st.task_title') }, { key: 'detail', label: t('st.task_detail'), type: 'multiline', optional: true }, { key: 'due', label: t('st.task_due'), type: 'date', optional: true, min: new Date().toISOString().slice(0, 10) }]}
          onSubmit={async (v) => { await api.post('/coaching/actions', { athlete_id: task.user_id, title: v.title, detail: v.detail || undefined, due_at: v.due ? new Date(`${v.due}T18:00:00`).toISOString() : undefined, shared: task.can_share, session_record_id: d.record_id }); setTask(null); await reload(); return t('st.task_given'); }} />
      ) : null}
      {goal ? (
        <FormSheet visible onClose={() => setGoal(null)} title={[t('st.goal'), goal.display_name].join(': ')} submitLabel={t('common.save')} initial={{}}
          fields={[{ key: 'title', label: t('st.goal_title') }, { key: 'criterion', label: t('st.goal_criterion'), type: 'multiline' }, { key: 'review_on', label: t('st.goal_review'), type: 'date', min: new Date().toISOString().slice(0, 10) }]}
          onSubmit={async (v) => { await api.post('/coaching/goals', { athlete_id: goal.user_id, title: v.title, criterion: v.criterion, review_on: v.review_on }); setGoal(null); await reload(); return t('st.goal_set'); }} />
      ) : null}
      {note ? (
        <FormSheet visible onClose={() => setNote(null)} title={[t('cp.add_note'), note.display_name].join(': ')} submitLabel={t('common.save')} initial={{ visibility: 'coach_private' }}
          fields={[{ key: 'note', label: t('cp.note'), type: 'multiline' }, { key: 'visibility', label: t('cp.visible_to'), type: 'chips', options: ['coach_private', 'player'].filter((v) => v === 'coach_private' || note.can_share).map((v) => ({ value: v, label: t(`cp.vis.${v}`) })), hint: note.can_share ? undefined : t('cp.consent_needed') }]}
          onSubmit={async (v) => { await api.post('/coaching/observations', { athlete_id: note.user_id, session_record_id: d.record_id, note: v.note, visibility: v.visibility }); setNote(null); await reload(); return t('cp.saved'); }} />
      ) : null}
      {sum ? (
        <FormSheet visible onClose={() => setSum(null)} title={[t('cp.write_summary'), sum.display_name].join(': ')} submitLabel={t('common.save')} initial={{ summary: sum.summary ?? '', shared: sum.summary_shared }}
          fields={[{ key: 'summary', label: t('cp.summary'), type: 'multiline' }, ...(sum.can_share ? [{ key: 'shared', label: t('cp.share_summary'), type: 'switch' }] : [])]} notice={sum.can_share ? undefined : t('cp.consent_needed')}
          onSubmit={async (v) => { await api.post(`/coaching/sessions/${d.record_id}/player-summaries`, { athlete_id: sum.user_id, summary: v.summary, shared: !!v.shared && sum.can_share }); setSum(null); await reload(); return t('cp.saved'); }} />
      ) : null}
    </View>
  );
}

/** One skill: the score buttons across the rubric's own scale, the last scores as bars and the change since last time. */
function ScoreRow({ dim, cur, h, onPick, name }) {
  const values = []; for (let v = dim.scale_min; v <= dim.scale_max && values.length < 11; v += 1) values.push(v);
  const span = dim.scale_max - dim.scale_min || 1;
  const trend = h?.history ?? [];
  const change = h?.change;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="700" style={{ flex: 1, minWidth: 120 }}>{dim.name}</T>
        {trend.length ? <View accessible accessibilityLabel={[t('st.history'), trend.join(', ')].join(': ')} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 22 }}>{trend.map((v, i) => <View key={i} style={{ width: 6, height: 4 + Math.round(((v - dim.scale_min) / span) * 18), borderRadius: 2, backgroundColor: c.cyan }} />)}</View> : null}
        {change != null ? <T size={12} weight="800" color={change > 0 ? c.lime : change < 0 ? c.red : c.mute}>{t('st.change', { n: change > 0 ? `+${change}` : String(change) })}</T> : (cur != null && !trend.length ? <T size={12} color={c.mute}>{t('st.first_score')}</T> : null)}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {values.map((v) => (
          <Pressable key={v} onPress={() => onPick(v)} accessibilityRole="button" accessibilityState={{ selected: cur === v }} accessibilityLabel={[dim.name, name, v].join(': ')}
            style={{ minWidth: 44, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: cur === v ? c.ink : c.line, backgroundColor: cur === v ? c.ink : c.paper }}>
            <T weight="800" color={cur === v ? c.inkOn : c.ink}>{v}</T>
          </Pressable>
        ))}
      </View>
      {dim.labels?.[cur] ? <T size={12} color={c.mute}>{dim.labels[cur]}</T> : null}
    </View>
  );
}

// ------------------------------------------------------------------ review

function ReviewArea({ d, reload }) {
  const { toast } = useSession();
  const [team, setTeam] = useState(''), [priv, setPriv] = useState(''), [share, setShare] = useState(false), [carry, setCarry] = useState('');
  const [busy, setBusy] = useState(false);
  const attended = d.roster.filter((r) => r.class_attendance === 'attended').length;
  const recorded = d.roster.filter((r) => r.class_attendance).length;
  const save = async () => {
    setBusy(true);
    try {
      if (team || priv) await api.post(`/coaching/sessions/${d.record_id}/review`, { ...(team ? { team_summary: team } : {}), ...(priv ? { private_summary: priv } : {}), share_team_summary: share });
      if (carry.trim()) await api.post('/coaching/actions', { title: carry.trim(), follow_up_next_session: true, session_record_id: d.record_id, athlete_id: d.roster[0]?.user_id });
      toast(t('st.review_saved')); await reload();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 12 }}>
      <Section title={t('st.stats')} color={c.cyan}>
        <T>{recorded ? t('st.attendance_stat', { a: attended, n: d.roster.length }) : t('cp.nothing_yet')}</T>
        <T size={13} color={c.mute}>{t('st.review_hint')}</T>
      </Section>
      <Section title={t('st.review_title')} color={c.violet}>
        <View style={{ gap: 12 }}>
          <Field label={t('st.team_summary')} value={team} onChangeText={setTeam} multiline minHeight={100} maxLength={4000} hint={t('st.team_summary_hint')} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T style={{ flex: 1 }}>{t('st.share_team')}</T><Chip label={share ? t('common.yes') : t('common.no')} active={share} onPress={() => setShare(!share)} /></View>
          <Field label={t('st.private_summary')} value={priv} onChangeText={setPriv} multiline minHeight={100} maxLength={4000} />
          <Field label={t('st.next_focus')} value={carry} onChangeText={setCarry} multiline minHeight={70} maxLength={160} hint={t('st.next_focus_hint')} />
          <Btn title={t('common.save')} loading={busy} disabled={!team && !priv && !carry.trim()} onPress={save} />
        </View>
      </Section>
    </View>
  );
}
