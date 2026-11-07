// Session workspace: where a coach plans any session they run (a class, a 1:1 or team booking, an academy session, a game or a team session), runs it,
// scores the people in it on any of their evaluation sheets and reviews it. One screen for every source, three working areas.
//   Plan      a timed session: objective, a timeline whose clock times follow the blocks, each block edited in place (setup, instructions, cues, what good
//             looks like, effort, skills worked), a time budget against the class length, a personal drill library, copy from an earlier class, preview, share.
//   Students  the coach's own rubric as a scoring grid (per person, per skill) with the last scores and the change, attendance, a practice task, a goal,
//             a private note and a summary that is shared only when the coach says so.
//   Review    how the class went, a message to the class, a private reflection, and what to carry into the next class.
// The same drills, plans and evaluation sheets are reused across sessions: nothing is tied to one class or one athlete.
// It is the coaching journal underneath (plan versions, observations, rubrics, goals, actions): nothing is copied. Shared cross-platform kit only; all text
// goes through t(); the server decides who may see what.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Avatar, Btn, Chip, Empty, ErrorBox, Field, H1, HScroll, Loading, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { Counter } from '../pickers';
import { t } from '../i18n';
import { c, when } from '../theme';
import { explain } from '../access';
const say = (...parts) => parts.filter((x) => x !== null && x !== undefined && x !== '').join(', ');
const rpeText = (n) => `RPE ${n}`;

const KINDS = ['warm_up', 'skill_drill', 'tactical_drill', 'conditioned_game', 'conditioning', 'recovery', 'review', 'custom'];
const KIND_TONE = { warm_up: c.sun, skill_drill: c.cyan, tactical_drill: c.cyan, conditioned_game: c.lime, conditioning: c.orange, recovery: c.mint, review: c.violet, custom: c.mute };
const QUICK = ['warm_up', 'skill_drill', 'conditioned_game', 'conditioning', 'recovery'];
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clean = (b) => ({ ...(b.id && !String(b.id).startsWith('new-') ? { id: b.id } : {}), kind: b.kind, title: b.title, duration_min: b.duration_min, ...(b.setup ? { setup: b.setup } : {}), ...(b.instructions ? { instructions: b.instructions } : {}), cues: b.cues ?? [], ...(b.success_criteria ? { success_criteria: b.success_criteria } : {}), ...(b.target_rpe ? { target_rpe: b.target_rpe } : {}), tags: b.tags ?? [], ...(b.coach_notes ? { coach_notes: b.coach_notes } : {}), ...(b.drill_id ? { drill_id: b.drill_id, drill_version: b.drill_version } : {}), ...(b.trains?.length ? { trains: b.trains } : {}), ...(b.area ? { area: b.area } : {}), ...(b.equipment?.length ? { equipment: b.equipment } : {}), ...(b.work_rest ? { work_rest: b.work_rest } : {}), ...(b.progression ? { progression: b.progression } : {}), ...(b.regression ? { regression: b.regression } : {}) });


// ------------------------------------------------------------------ pro-grade building blocks

const minutes = (blocks) => blocks.reduce((s, b) => s + (b.duration_min ?? 0), 0);
/** Planned load in arbitrary units (minutes x target effort), and the minute-weighted average effort, over the blocks that have an effort set. */
const loadOf = (blocks) => { const w = blocks.filter((b) => b.target_rpe); const mins = minutes(w); const au = w.reduce((s, b) => s + (b.duration_min ?? 0) * b.target_rpe, 0); return { au, avg: mins ? au / mins : null, mins }; };
const PHASE_TONE = { planned: c.cyan, running: c.orange, completed: c.mint };

export function Metric({ label, value, sub, tone = c.ink, wide }) {
  return (
    <View accessible accessibilityLabel={[label, value, sub].filter(Boolean).join(', ')} style={{ flexGrow: 1, flexBasis: 160, minWidth: 150, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, gap: 2 }}>
      <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.8 }}>{label.toUpperCase()}</T>
      <T size={24} weight="800" color={tone}>{value}</T>
      {sub ? <T size={12} color={c.mute}>{sub}</T> : null}
    </View>
  );
}

function Brief({ d }) {
  const saved = d.plan.blocks;
  const { au, avg } = loadOf(saved);
  const mins = minutes(saved);
  const recorded = d.roster.filter((r) => r.attendance && r.attendance !== 'expected');
  const present = recorded.filter((r) => ['present', 'late', 'left_early'].includes(r.attendance)).length;
  const scored = d.roster.filter((r) => r.last_score != null || r.evaluation_status).length;
  return (
    <View style={{ gap: 12, marginTop: 4 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric label={t('swk.m.duration')} value={d.duration_min ? `${mins}/${d.duration_min}` : String(mins)} sub={t('cls.min')} />
        <Metric label={t('swk.m.load')} value={au ? String(au) : '—'} sub={au ? t('swk.m.load_unit') : t('swk.m.load_hint')} tone={au ? c.violet : c.mute} />
        <Metric label={t('swk.m.intensity')} value={avg ? avg.toFixed(1) : '—'} sub={avg ? t('swk.m.rpe') : t('swk.m.load_hint')} tone={avg ? (avg >= 7.5 ? c.red : avg >= 5 ? c.orange : c.cyan) : c.mute} />
        <Metric label={t('swk.m.people')} value={String(d.roster.length)} sub={recorded.length ? t('swk.m.present_of', { a: present, n: d.roster.length }) : t('swk.m.not_recorded')} />
        <Metric label={t('swk.m.scored')} value={`${scored}/${d.roster.length}`} sub={t('swk.m.scored_sub')} />
        <Metric label={t('swk.m.plan')} value={d.shared ? `v${d.shared_version}` : t('swk.m.draft')} sub={d.shared ? (d.plan_changed_since_share ? t('swk.m.changed') : t('swk.m.shared')) : t('swk.m.not_shared')} tone={d.shared ? (d.plan_changed_since_share ? c.sun : c.mint) : c.mute} />
      </View>
    </View>
  );
}

/** Block length across, target effort up: the shape of the session at a glance. */
function IntensityProfile({ blocks, total, onPick }) {
  const sum = minutes(blocks);
  if (!blocks.length) return null;
  const H = 76;
  return (
    <View accessible accessibilityLabel={[t('swk.profile.title'), blocks.map((b) => `${b.title || t('st.untitled')} ${b.duration_min ?? 0} ${t('cls.min')}${b.target_rpe ? ` RPE ${b.target_rpe}` : ''}`).join(', ')].join(': ')} style={{ gap: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800">{t('swk.profile.title')}</T>
        <T size={12} color={c.mute}>{t('swk.profile.sub')}</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap: 3, borderBottomWidth: 1, borderBottomColor: c.line }}>
        {blocks.map((b, i) => {
          const h = b.target_rpe ? 10 + Math.round((b.target_rpe / 10) * (H - 12)) : 8;
          return (
            <Pressable key={b.id ?? i} onPress={() => onPick?.(b)} accessibilityRole="button" accessibilityLabel={say(b.title || t('st.untitled'), `${b.duration_min ?? 0} ${t('cls.min')}`)} style={{ flexGrow: b.duration_min ?? 1, flexBasis: 0, minWidth: 18, height: h, borderTopLeftRadius: 6, borderTopRightRadius: 6, backgroundColor: b.target_rpe ? (KIND_TONE[b.kind] ?? c.mute) : c.violetSoft, borderWidth: b.target_rpe ? 0 : 1, borderColor: c.line, borderStyle: 'dashed', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 2 }}>
              {b.target_rpe ? <T size={11} weight="800" color={c.inkOn}>{b.target_rpe}</T> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {blocks.map((b, i) => <View key={b.id ?? i} style={{ flexGrow: b.duration_min ?? 1, flexBasis: 0, minWidth: 18, alignItems: 'center' }}><T size={11} color={c.mute} weight="600">{b.duration_min ?? 0}′</T></View>)}
      </View>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {[...new Set(blocks.map((b) => b.kind))].map((k) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: KIND_TONE[k] ?? c.mute }} /><T size={12} color={c.mute}>{t(`cp.kind.${k}`)}</T></View>)}
        {total ? <T size={12} color={c.mute} style={{ marginLeft: 'auto' }}>{sum}/{total} {t('cls.min')}</T> : null}
      </View>
    </View>
  );
}

/** Which evaluation criteria the plan actually spends time on. */
function FocusMap({ blocks, names }) {
  const by = {};
  for (const b of blocks) for (const k of b.trains ?? []) by[k] = (by[k] ?? 0) + (b.duration_min ?? 0);
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  return (
    <Section title={t('swk.focus.title')} color={c.cyan}>
      <T size={12} color={c.mute}>{t('swk.focus.sub')}</T>
      {rows.length ? rows.map(([k, m]) => (
        <View key={k} accessible accessibilityLabel={say(names[k] ?? k, `${m} ${t('cls.min')}`)} style={{ gap: 4, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700" size={13}>{names[k] ?? k}</T><T size={12} color={c.mute}>{m} {t('cls.min')}</T></View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ height: 8, width: `${Math.round((m / max) * 100)}%`, backgroundColor: c.cyan }} /></View>
        </View>
      )) : <T size={13} color={c.mute} style={{ marginTop: 8 }}>{t('swk.focus.none')}</T>}
    </Section>
  );
}

/** Squad heat-map: every person against every criterion of the chosen sheet, with the current score on a colour scale. */
function SquadMatrix({ g, roster }) {
  if (!g?.rows?.length) return null;
  const dims = g.rubric.dimensions;
  const shade = (dim, v) => { if (v == null) return c.violetSoft; const f = (v - dim.scale_min) / ((dim.scale_max - dim.scale_min) || 1); const a = Math.round(35 + Math.max(0, Math.min(1, dim.direction === 'lower_is_better' ? 1 - f : f)) * 200).toString(16).padStart(2, '0'); return `${c.cyan}${a}`; };
  return (
    <Section title={t('swk.squad.title')} color={c.violet}>
      <HScroll gap={0}>
        <View accessible={false} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-end' }}>
            <View style={{ width: 130 }} />
            {dims.map((x) => <View key={x.key} style={{ width: 64 }}><T size={11} weight="700" color={c.mute} numberOfLines={2}>{x.name}</T></View>)}
          </View>
          {g.rows.map((row) => {
            const r = roster.find((x) => x.user_id === row.athlete_id);
            return (
              <View key={row.athlete_id} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <View style={{ width: 130, flexDirection: 'row', alignItems: 'center', gap: 6 }}><Avatar user={{ display_name: row.display_name, avatar_emoji: r?.avatar_emoji, avatar_color: r?.avatar_color }} size={28} /><T size={13} weight="700" numberOfLines={1} style={{ flex: 1 }}>{row.display_name}</T></View>
                {dims.map((x) => { const h = row.dimensions[x.key]; return (
                  <View key={x.key} accessible accessibilityLabel={say(row.display_name, `${x.name}: ${h?.score ?? t('swk.squad.no_scores')}`)} style={{ width: 64, height: 44, borderRadius: 10, backgroundColor: shade(x, h?.score), alignItems: 'center', justifyContent: 'center' }}>
                    <T weight="800" color={h?.score != null ? c.ink : c.mute}>{h?.score ?? '–'}</T>
                    {h?.change != null ? <T size={10} weight="800" color={h.change > 0 ? c.lime : h.change < 0 ? c.red : c.mute}>{h.change > 0 ? `+${h.change}` : String(h.change)}</T> : null}
                  </View>); })}
              </View>
            );
          })}
        </View>
      </HScroll>
    </Section>
  );
}

const SOURCE_TONE = { coach_class: c.cyan, coach_hire: c.mint, academy_session: c.violet, fixture: c.orange, team_session: c.sun, training_session: c.lime };
const EVAL_CONTEXT = { coach_class: 'class', coach_hire: 'booking', academy_session: 'academy', fixture: 'game' };

export function SessionWorkspace({ source_type, source_id, team_id }) {
  const { tablet } = useLayout();
  const w = useLoad(() => api.post('/coaching/workspace', { source_type, source_id, team_id }), [source_type, source_id, team_id]);
  const [tab, setTab] = useState('plan');
  if (w.error) return <Screen><ErrorBox error={w.error} onRetry={w.reload} /></Screen>;
  if (!w.data) return <Screen><Loading /></Screen>;
  const d = w.data;
  return (
    <Screen wide>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('swk.title').toUpperCase()}</T>
        <Tag label={t(`swk.source.${d.source_type}`)} color={SOURCE_TONE[d.source_type]} />
        <Tag label={t(`swk.phase.${d.phase}`)} color={PHASE_TONE[d.phase]} />
      </View>
      <H1 style={{ fontSize: tablet ? 30 : 26 }}>{d.title}</H1>
      <T color={c.mute}>{[d.scheduled_at ? when(d.scheduled_at) : null, d.duration_min ? `${d.duration_min} ${t('cls.min')}` : null, `${d.roster.length} ${t('swk.m.people').toLowerCase()}`].filter(Boolean).join(' · ')}</T>
      <Brief d={d} />
      <View style={{ marginVertical: 12 }}><Seg value={tab} onChange={setTab} options={[{ value: 'plan', label: t('cp.tab.plan') }, { value: 'students', label: t('swk.m.people') }, { value: 'review', label: t('st.tab.review') }]} /></View>
      {tab === 'plan' ? <PlanArea d={d} reload={w.reload} wide={tablet} /> : tab === 'students' ? <StudentsArea d={d} reload={w.reload} /> : <ReviewArea d={d} reload={w.reload} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ plan

function PlanArea({ d, reload, wide }) {
  const { toast } = useSession();
  const locked = d.locked;
  const [blocks, setBlocks] = useState(() => d.plan.blocks.map((b) => ({ cues: [], tags: [], ...b })));
  const [objective, setObjective] = useState(d.objective ?? '');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const saved = JSON.stringify(d.plan.blocks.map(clean));
  const dirty = JSON.stringify(blocks.map(clean)) !== saved || objective !== (d.objective ?? '');
  const rubrics = useLoad(() => api.get('/coaching/rubrics', { limit: 50 }), []);
  const library = useLoad(() => api.get('/coach/templates', { scope: 'block', limit: 100 }), []);
  const criteria = useMemo(() => (rubrics.data ?? []).flatMap((r) => (r.dimensions ?? []).map((x) => ({ value: x.key, label: x.name, sub: r.name }))), [rubrics.data]);
  const names = useMemo(() => Object.fromEntries(criteria.map((x) => [x.value, x.label])), [criteria]);
  const skills = criteria;
  const planned = blocks.reduce((s, b) => s + (b.duration_min ?? 0), 0);
  const left = d.duration_min ? d.duration_min - planned : null;
  const starts = useMemo(() => { if (!d.scheduled_at) return blocks.map(() => null); let at = new Date(d.scheduled_at); return blocks.map((b) => { const from = at; at = new Date(+at + (b.duration_min ?? 0) * 6e4); return [from, at]; }); }, [blocks, d.scheduled_at]);
  const patch = (i, p) => setBlocks((x) => x.map((b, j) => (j === i ? { ...b, ...p } : b)));
  const move = (i, to) => setBlocks((x) => { const n = x.slice(); const [b] = n.splice(i, 1); n.splice(to, 0, b); return n; });
  const add = (kind, from = {}) => { const b = { id: `new-${uid()}`, kind, title: from.title ?? '', duration_min: from.duration_min ?? Math.max(5, Math.min(30, left != null && left > 0 ? left : 10)), cues: [], tags: [], ...from, id: `new-${uid()}` }; setBlocks((x) => [...x, b]); setOpen(b.id); };
  const run = async (fn, done) => { setBusy(true); try { const r = await fn(); if (done) toast(typeof done === 'function' ? done(r) : done); return r; } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  const save = () => run(async () => { await api.post(`/coaching/sessions/${d.record_id}/plan`, { blocks: blocks.map(clean), objective: objective || undefined, expected_version: d.plan.version }); await reload(); }, t('cp.plan_saved'));
  const toLibrary = (b) => run(() => api.post('/coaching/templates', { title: b.title, scope: 'block', blocks: [clean(b)] }).then(() => library.reload()), t('st.saved_library'));
  const bad = blocks.some((b) => !b.title || b.title.trim().length < 2);

  const timeline = (
    <View style={{ gap: 10 }}>
      {d.duration_min ? <Budget planned={planned} total={d.duration_min} left={left} /> : null}
      <IntensityProfile blocks={blocks} total={d.duration_min} onPick={(b) => setOpen(b.id)} />
      {blocks.length === 0 ? <Empty emoji="📝" title={t('cp.no_blocks')} /> : blocks.map((b, i) => (
        <BlockCard key={b.id} b={b} i={i} n={blocks.length} range={starts[i]} open={open === b.id} locked={locked} skills={skills} names={names}
          onToggle={() => setOpen(open === b.id ? null : b.id)} onPatch={(p) => patch(i, p)} onMove={(to) => move(i, to)}
          onDuplicate={() => { const copy = { ...b, id: `new-${uid()}`, title: b.title }; setBlocks((x) => [...x.slice(0, i + 1), copy, ...x.slice(i + 1)]); setOpen(copy.id); }}
          onRemove={() => { setBlocks((x) => x.filter((_, j) => j !== i)); setOpen(null); }} onLibrary={() => toLibrary(b)} />
      ))}
      {!locked ? (
        <View style={{ gap: 8 }}>
          <T weight="700" size={12} color={c.mute} style={{ letterSpacing: 0.6 }}>{t('st.add_block').toUpperCase()}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{QUICK.map((k) => <Chip key={k} label={`+ ${t(`cp.kind.${k}`)}`} onPress={() => add(k)} />)}</View>
          <MenuField value="" onChange={(x) => { const tpl = (library.data ?? []).find((y) => y.id === x); if (tpl) tpl.blocks.forEach((b) => add(b.kind ?? 'skill_drill', { ...b, drill_id: tpl.id, drill_version: tpl.version })); }} title={t('st.from_library')} placeholder={t('st.from_library')}
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
      <FocusMap blocks={blocks} names={names} />
      <Section title={t('swk.share.title')} color={c.mint}>
        <T color={c.mute} size={13}>{d.shared ? t('swk.share.shared_v', { v: d.shared_version }) : t('swk.share.none')}</T>
        {d.plan_changed_since_share ? <T size={13} color={c.sun} weight="700">{t('cp.shared_changed')}</T> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <Btn small title={t('swk.sheet.title')} color={c.paper} ink={c.ink} onPress={() => setPreview(true)} disabled={!blocks.length} />
          {d.plan.version > 0 && !dirty && (!d.shared || d.plan_changed_since_share) ? <Btn small title={t('swk.share.title')} loading={busy} disabled={locked} onPress={() => run(async () => { const r = await api.post(`/coaching/sessions/${d.record_id}/plan/share`, { share: true }); await reload(); return r; }, (r) => t('cp.shared_told', { n: r.told }))} /> : null}
          {d.shared ? <Btn small title={t('cp.unshare')} color={c.paper} ink={c.ink} loading={busy} onPress={() => run(async () => { await api.post(`/coaching/sessions/${d.record_id}/plan/share`, { share: false }); await reload(); }, t('cp.stopped'))} /> : null}
        </View>
        {dirty ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('st.save_first')}</T> : null}
      </Section>
      {!locked && d.copy_from.length ? (
        <Section title={t('swk.share.copy')} color={c.cyan}>
          <MenuField value="" onChange={(x) => x && run(async () => { await api.post(`/coaching/sessions/${d.record_id}/plan/copy`, { from_record_id: x }); await reload(); }, t('cp.copied'))} title={t('swk.share.copy')} placeholder={t('swk.share.copy')}
            options={d.copy_from.map((o) => ({ value: o.record_id, label: o.title, sub: [t(`swk.source.${o.source_type}`), o.scheduled_at ? when(o.scheduled_at) : null].filter(Boolean).join(' · ') }))} />
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
      {preview ? <PlanPreview d={d} objective={objective} blocks={blocks} names={names} onClose={() => setPreview(false)} /> : null}
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

function BlockCard({ b, i, n, range, open, locked, skills, names, onToggle, onPatch, onMove, onDuplicate, onRemove, onLibrary }) {
  const [cue, setCue] = useState(''), [kit, setKit] = useState('');
  const tone = KIND_TONE[b.kind] ?? c.mute;
  const head = range ? [hhmm(range[0]), hhmm(range[1])].join(' – ') : `${b.duration_min} ${t('cls.min')}`;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: open ? c.ink : c.line, backgroundColor: c.paper, overflow: 'hidden' }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={[head, b.title || t('cp.block_title'), t(`cp.kind.${b.kind}`)].join(', ')} style={{ flexDirection: 'row', gap: 12, padding: 14, alignItems: 'center', minHeight: 56 }}>
        <View style={{ width: 6, alignSelf: 'stretch', borderRadius: 3, backgroundColor: tone }} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={12} color={c.mute} weight="700">{range ? `${head} · ${b.duration_min} ${t('cls.min')}` : head}</T>
          <T weight="800" size={16}>{b.title || t('st.untitled')}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={t(`cp.kind.${b.kind}`)} />{b.target_rpe ? <Tag label={rpeText(b.target_rpe)} color={c.orangeSoft} /> : null}{b.drill_id ? <Tag label={t('swk.from_drill')} /> : null}{(b.tags ?? []).includes('licensed') ? <Tag label={t('cl.sess.licensed_tag')} color={c.cyanSoft} /> : null}{b.area ? <T size={12} color={c.mute}>{b.area}</T> : null}{b.equipment?.length ? <T size={12} color={c.mute}>🎽 {b.equipment.length}</T> : null}{(b.trains ?? []).slice(0, 3).map((x) => <T key={x} size={12} color={c.cyan} weight="700">#{names?.[x] ?? x}</T>)}</View>
        </View>
        <T size={14} color={c.mute}>{open ? '▲' : '▼'}</T>
      </Pressable>
      {open ? (
        <View style={{ padding: 14, gap: 12, borderTopWidth: 1, borderTopColor: c.line }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{KINDS.map((k) => <Chip key={k} label={t(`cp.kind.${k}`)} active={b.kind === k} onPress={() => !locked && onPatch({ kind: k })} />)}</View>
          <Field label={t('cp.block_title')} value={b.title} onChangeText={(x) => onPatch({ title: x })} maxLength={120} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><T weight="600" style={{ flex: 1 }}>{t('cp.block_minutes')}</T><Counter value={b.duration_min ?? 10} min={1} max={240} step={5} onChange={(x) => onPatch({ duration_min: x })} a11y={t('cp.block_minutes')} /></View>
          <Field label={t('swk.b.area')} value={b.area} onChangeText={(x) => onPatch({ area: x })} maxLength={120} />
          <Field label={t('st.setup')} value={b.setup} onChangeText={(x) => onPatch({ setup: x })} multiline minHeight={60} maxLength={500} />
          <Field label={t('swk.b.work_rest')} value={b.work_rest} onChangeText={(x) => onPatch({ work_rest: x })} maxLength={60} />
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('swk.b.equipment').toUpperCase()}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{(b.equipment ?? []).map((x, j) => <Chip key={`${x}${j}`} label={`${x}  ✕`} active onPress={() => onPatch({ equipment: b.equipment.filter((_, k) => k !== j) })} />)}</View>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={kit} onChangeText={setKit} placeholder={t('swk.b.equipment_add')} maxLength={60} accessibilityLabel={t('swk.b.equipment_add')} /></View><Btn small title={t('cp.add_cue_btn')} disabled={!kit.trim()} onPress={() => { onPatch({ equipment: [...(b.equipment ?? []), kit.trim()] }); setKit(''); }} /></View>
          </View>
          <Field label={t('cp.block_instructions')} value={b.instructions} onChangeText={(x) => onPatch({ instructions: x })} multiline minHeight={90} maxLength={2000} />
          <View style={{ gap: 6 }}>
            <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{t('st.cues').toUpperCase()}</T>
            {(b.cues ?? []).map((x, j) => <View key={`${x}${j}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><T style={{ flex: 1 }}>• {x}</T><Btn small title="✕" color={c.paper} ink={c.ink} onPress={() => onPatch({ cues: b.cues.filter((_, k) => k !== j) })} accessibilityLabel={t('cp.remove')} /></View>)}
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}><View style={{ flex: 1 }}><Field value={cue} onChangeText={setCue} placeholder={t('st.add_cue')} maxLength={200} accessibilityLabel={t('st.add_cue')} /></View><Btn small title={t('cp.add_cue_btn')} disabled={!cue.trim()} onPress={() => { onPatch({ cues: [...(b.cues ?? []), cue.trim()] }); setCue(''); }} /></View>
          </View>
          <Field label={t('st.success')} value={b.success_criteria} onChangeText={(x) => onPatch({ success_criteria: x })} multiline minHeight={60} maxLength={500} />
          <Field label={t('swk.b.progression')} value={b.progression} onChangeText={(x) => onPatch({ progression: x })} multiline minHeight={50} maxLength={300} />
          <Field label={t('swk.b.regression')} value={b.regression} onChangeText={(x) => onPatch({ regression: x })} multiline minHeight={50} maxLength={300} />
          <MultiMenuField label={t('swk.b.trains')} value={b.trains ?? []} onChange={(x) => onPatch({ trains: x })} options={skills} placeholder={t('common.choose')} hint={skills.length ? undefined : t('st.no_skills')} />
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

function PlanPreview({ d, objective, blocks, names, onClose }) {
  const kit = [...new Set(blocks.flatMap((b) => b.equipment ?? []))];
  let at = d.scheduled_at ? new Date(d.scheduled_at) : null;
  return (
    <Sheet visible onClose={onClose} title={t('swk.sheet.title')}>
      <View style={{ gap: 12 }}>
        <View style={{ gap: 2 }}>
          <T weight="800" size={18}>{d.title}</T>
          <T size={12} color={c.mute}>{[t(`swk.source.${d.source_type}`), d.scheduled_at ? when(d.scheduled_at) : null, `${d.roster.length} ${t('swk.m.people').toLowerCase()}`].filter(Boolean).join(' · ')}</T>
        </View>
        {objective ? <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.violetSoft }}><T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.8 }}>{t('cp.objective').toUpperCase()}</T><T weight="700">{objective}</T></View> : null}
        <IntensityProfile blocks={blocks} total={d.duration_min} />
        {blocks.map((b, i) => {
          const from = at; if (at) at = new Date(+at + (b.duration_min ?? 0) * 6e4);
          const meta = [from ? `${hhmm(from)} – ${hhmm(at)}` : null, `${b.duration_min ?? 0} ${t('cls.min')}`, b.target_rpe ? `RPE ${b.target_rpe}` : null, b.work_rest].filter(Boolean).join(' · ');
          return (
            <View key={b.id ?? i} style={{ gap: 4, padding: 12, borderRadius: 12, borderLeftWidth: 5, borderLeftColor: KIND_TONE[b.kind] ?? c.mute, backgroundColor: c.violetSoft }}>
              <T weight="800">{[i + 1, b.title].join('. ')}</T>
              <T size={12} color={c.mute}>{[t(`cp.kind.${b.kind}`), meta].join(' · ')}</T>
              {b.area ? <T size={13}>{b.area}</T> : null}
              {b.setup ? <T size={13}>{b.setup}</T> : null}
              {b.instructions ? <T size={13}>{b.instructions}</T> : null}
              {(b.cues ?? []).map((x, j) => <T key={j} size={13}>• {x}</T>)}
              {b.success_criteria ? <T size={13} weight="700">{b.success_criteria}</T> : null}
              {b.progression ? <T size={12} color={c.mute}>↑ {b.progression}</T> : null}
              {b.regression ? <T size={12} color={c.mute}>↓ {b.regression}</T> : null}
              {(b.trains ?? []).length ? <T size={12} color={c.cyan} weight="700">{b.trains.map((k) => names?.[k] ?? k).join(' · ')}</T> : null}
            </View>
          );
        })}
        {kit.length ? <View style={{ gap: 6 }}><T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.8 }}>{t('swk.sheet.kit').toUpperCase()}</T><View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{kit.map((x) => <Tag key={x} label={x} />)}</View></View> : null}
        <T size={12} color={c.mute}>{t('st.preview_note')}</T>
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
  const grid = useLoad(() => (rubricId ? api.get(`/coaching/sessions/${d.record_id}/scores`, { rubric_id: rubricId }) : Promise.resolve(null)), [rubricId]);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState(null), [goal, setGoal] = useState(null), [note, setNote] = useState(null), [sum, setSum] = useState(null);
  const [bulk, setBulk] = useState(false), [res, setRes] = useState(null);
  useEffect(() => setDraft({}), [rubricId]);
  const g = grid.data;
  const set = (a, k, v) => setDraft((x) => ({ ...x, [`${a}:${k}`]: v }));
  const cell = (r, dim) => draft[`${r.athlete_id}:${dim.key}`] ?? r.dimensions[dim.key]?.score ?? null;
  const changes = Object.entries(draft).map(([k, score]) => { const [athlete_id, dimension_key] = k.split(':'); return { athlete_id, dimension_key, score }; });
  const saveScores = async () => { setBusy(true); try { const r = await api.post(`/coaching/sessions/${d.record_id}/scores`, { rubric_id: rubricId, scores: changes }); toast(t('st.scores_saved', { n: r.saved })); setDraft({}); await grid.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(false); } };
  // attendance is one fact, taken where its source keeps it: the class for a class, the academy session for an academy session, here for everything else
  const here = d.source_type !== 'academy_session';
  const mark = async (r, present) => {
    try {
      if (d.source_type === 'coach_class') await api.post(`/coach/classes/${d.source_id}/seats/${r.seat_id}/attendance`, { attendance: present ? 'attended' : 'no_show' });
      else await api.post(`/coaching/sessions/${d.record_id}/attendance`, { entries: [{ athlete_id: r.user_id, attendance: present ? 'present' : 'absent' }] });
      await reload();
    } catch (e) { toast(explain(e)); }
  };
  const started = d.scheduled_at ? new Date(d.scheduled_at) <= new Date() : true;
  // open this person's evaluation for the class (the one already in progress, or a new one that starts from the scores given here)
  const evaluate = async (r) => {
    try {
      const have = await api.get('/coaching/evaluations', { athlete_id: r.user_id, session_record_id: d.record_id, rubric_id: rubricId, limit: 1 });
      const ev = have[0] ?? await api.post('/coaching/evaluations', { athlete_id: r.user_id, rubric_id: rubricId, context_type: EVAL_CONTEXT[d.source_type] ?? 'session', session_record_id: d.record_id });
      push('Evaluation', { id: ev.id });
    } catch (e) { toast(explain(e)); }
  };
  if (!d.roster.length) return <Empty emoji="🧑‍🤝‍🧑" title={t('cp.no_roster')} />;
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('st.rubric')} value={rubricId ?? ''} onChange={setRubricId} placeholder={t('st.rubric_pick')} options={list.map((r) => ({ value: r.id, label: r.name, sub: (r.dimensions ?? []).map((x) => x.name).join(', ') }))} />
      {rubricId ? <View style={{ alignItems: 'flex-start' }}><Btn small title={t('swk.eval_all')} onPress={() => setBulk(true)} accessibilityLabel={t('swk.eval_all')} /></View> : null}
      {changes.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.sun, backgroundColor: c.paper }}>
          <T weight="700" color={c.sun} style={{ flex: 1, minWidth: 140 }}>{t('st.unsaved')}</T>
          <Btn small title={t('st.discard')} color={c.paper} ink={c.ink} onPress={() => setDraft({})} /><Btn small title={t('st.score_save')} loading={busy} onPress={saveScores} />
        </View>
      ) : null}
      <SquadMatrix g={g} roster={d.roster} />
      {g ? <T size={12} color={c.mute}>{t('st.rubric_note')}</T> : null}
      {d.evaluations?.length ? (
        <Section title={t('swk.evals')} color={c.violet}>
          {d.evaluations.map((e) => (
            <Pressable key={e.id} onPress={() => push('Evaluation', { id: e.id })} accessibilityRole="button" accessibilityLabel={[e.title, t(`swk.eval.${e.status}`)].join(', ')} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <T weight="700" style={{ flex: 1 }}>{e.title}</T><Tag label={t(`swk.eval.${e.status}`)} />
            </Pressable>
          ))}
        </Section>
      ) : null}
      {d.roster.map((r) => {
        const row = g?.rows.find((x) => x.athlete_id === r.user_id);
        return (
          <View key={r.user_id} style={{ gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Avatar user={{ display_name: r.display_name, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color }} size={40} />
              <T weight="800" size={16} style={{ flex: 1, minWidth: 120 }}>{r.display_name}{r.is_youth ? ` · ${t('cls.young')}` : ''}</T>
              {r.attendance_rate != null ? <Tag label={t('swk.squad.rate', { n: r.attendance_rate })} color={r.attendance_rate >= 80 ? c.limeSoft : r.attendance_rate >= 50 ? c.sunSoft : c.redSoft} /> : null}
              {r.evaluation_status ? <Tag label={`${t('swk.squad.eval')} · ${t(`swk.eval.${r.evaluation_status}`)}`} color={c.violetSoft} /> : null}
              {r.attendance && r.attendance !== 'expected' ? <Tag label={t(`swk.att.${r.attendance}`)} /> : null}
              {r.open_goals ? <Tag label={t('cp.goals_n', { n: r.open_goals })} /> : null}{r.notes ? <Tag label={t('swk.squad.notes', { n: r.notes })} /> : null}
            </View>
            {row ? g.rubric.dimensions.map((dim) => <ScoreRow key={dim.key} dim={dim} cur={cell(row, dim)} h={row.dimensions[dim.key]} onPick={(v) => set(r.user_id, dim.key, v)} name={r.display_name} />) : (grid.loading ? null : <T size={13} color={c.mute}>{t('st.rubric_pick')}</T>)}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {started && here ? <><Btn small title={t('cls.attended')} color={['present', 'late', 'left_early'].includes(r.attendance) ? c.mint : c.paper} ink={c.ink} onPress={() => mark(r, true)} accessibilityLabel={[t('cls.attended'), r.display_name].join(': ')} /><Btn small title={t('cls.no_show')} color={r.attendance === 'absent' ? c.red : c.paper} ink={c.ink} onPress={() => mark(r, false)} accessibilityLabel={[t('cls.no_show'), r.display_name].join(': ')} /></> : null}
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
      {bulk ? (
        <FormSheet visible onClose={() => setBulk(false)} title={t('swk.eval_all')} submitLabel={t('cs.create')} initial={{ draft: true, ai: false }} notice={t('swk.eval_note')}
          fields={[{ key: 'draft', label: t('swk.eval_draft'), type: 'switch', default: true }, { key: 'ai', label: t('swk.eval_ai'), type: 'switch', default: false }]}
          onSubmit={async (v) => { const r = await api.post(`/coaching/sessions/${d.record_id}/evaluations`, { rubric_id: rubricId, draft_narrative: !!v.draft, use_ai: !!v.ai }); setBulk(false); setRes(r); await reload(); return t('swk.eval_done', { n: r.created }); }} />
      ) : null}
      {res ? (
        <Sheet visible onClose={() => setRes(null)} title={t('swk.eval_all')}>
          <View style={{ gap: 8 }}>
            {res.ai_used ? <T size={13} weight="700" color={c.sun}>{t('swk.eval_ai_review')}</T> : null}
            {res.evaluations.map((e) => (
              <Pressable key={e.id} onPress={() => { setRes(null); push('Evaluation', { id: e.id }); }} accessibilityRole="button" accessibilityLabel={[e.display_name, t(e.created ? 'swk.eval_res_created' : 'swk.eval_res_existing')].join(', ')} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
                <T weight="700" style={{ flex: 1 }}>{e.display_name}</T>
                <Tag label={t(e.created ? 'swk.eval_res_created' : 'swk.eval_res_existing')} color={e.created ? c.limeSoft : c.violetSoft} />
                {e.ai_drafted ? <Tag label={t('tpf.ai_label')} color={c.sunSoft} /> : null}
              </Pressable>
            ))}
            {res.skipped.map((x) => <View key={x.athlete_id} style={{ gap: 2 }}><T weight="700">{x.display_name}</T><T size={12} color={c.mute}>{t('swk.eval_res_skipped')}: {x.reason}</T></View>)}
          </View>
        </Sheet>
      ) : null}
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


/** Planned against delivered: which blocks were run as planned, modified or skipped, the attendance split, and the load that was planned. */
function DeliveryPanel({ d }) {
  const blocks = d.plan.blocks, log = d.block_log ?? {};
  const count = (k) => blocks.filter((b) => log[b.id]?.status === k).length;
  const items = [['completed', c.mint], ['modified', c.sun], ['skipped', c.red]].map(([k, tone]) => ({ k, tone, n: count(k) }));
  const notLogged = blocks.length - items.reduce((x, i) => x + i.n, 0);
  const att = ['present', 'late', 'left_early', 'excused', 'absent', 'expected'].map((k) => ({ k, n: d.roster.filter((r) => r.attendance === k).length })).filter((x) => x.n);
  const total = d.roster.length || 1;
  const AT_TONE = { present: c.mint, late: c.sun, left_early: c.orange, excused: c.cyan, absent: c.red, expected: c.line };
  const { au } = loadOf(blocks);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric label={t('swk.dlv.planned')} value={String(blocks.length)} sub={t('swk.dlv.blocks')} />
        {items.map((i) => <Metric key={i.k} label={t(`swk.dlv.${i.k}`)} value={String(i.n)} tone={i.n ? i.tone : c.mute} />)}
        <Metric label={t('swk.dlv.pending')} value={String(notLogged)} tone={c.mute} />
        <Metric label={t('swk.m.load')} value={au ? String(au) : '—'} sub={au ? t('swk.m.load_unit') : undefined} />
      </View>
      {att.length ? (
        <View accessible accessibilityLabel={att.map((x) => `${t(`swk.att.${x.k}`)} ${x.n}`).join(', ')} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: c.violetSoft }}>{att.map((x) => <View key={x.k} style={{ flexGrow: x.n / total, flexBasis: 0, backgroundColor: AT_TONE[x.k] }} />)}</View>
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>{att.map((x) => <View key={x.k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: AT_TONE[x.k] }} /><T size={12} color={c.mute}>{t(`swk.att.${x.k}`)} {x.n}</T></View>)}</View>
        </View>
      ) : null}
    </View>
  );
}

function ReviewArea({ d, reload }) {
  const { toast } = useSession();
  const [team, setTeam] = useState(''), [priv, setPriv] = useState(''), [share, setShare] = useState(false), [carry, setCarry] = useState('');
  const [busy, setBusy] = useState(false);
  const attended = d.roster.filter((r) => ['present', 'late', 'left_early'].includes(r.attendance)).length;
  const recorded = d.roster.filter((r) => r.attendance && r.attendance !== 'expected').length;
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
      <Section title={t('swk.dlv.title')} color={c.cyan}>
        <DeliveryPanel d={d} />
        <T size={13} color={c.mute} style={{ marginTop: 8 }}>{recorded ? t('st.attendance_stat', { a: attended, n: d.roster.length }) : t('cp.nothing_yet')}</T>
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

/** The class studio route, kept so every existing link opens the same workspace. */
export function ClassStudio({ id }) { return <SessionWorkspace source_type="coach_class" source_id={id} />; }

/** What the coach shared from a booking, for the person who booked it (or their guardian): the plan, feedback and evaluations; nothing else. */
export function SharedSessionSheet({ hireId, onClose }) {
  const { push } = useNav();
  const tl = useLoad(() => api.get(`/hires/${hireId}/timeline`, { limit: 1 }), [hireId]);
  const w = tl.data?.workspace;
  const empty = !w || (!w.shared && !w.evaluations?.length && !w.people?.some((p) => p.summary));
  return (
    <Sheet visible onClose={onClose} title={t('swk.athlete.plan')}>
      {tl.error ? <ErrorBox error={tl.error} onRetry={tl.reload} /> : !tl.data ? <Loading /> : empty ? <Empty emoji="📝" title={t('swk.athlete.none')} /> : (
        <View style={{ gap: 10 }}>
          {w.shared ? (
            <View style={{ gap: 8 }}>
              {w.objective ? <T weight="700">{w.objective}</T> : null}
              {w.blocks.map((b, i) => (
                <View key={b.id ?? i} style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.violetSoft }}>
                  <T weight="800">{[i + 1, b.title].join('. ')}</T>
                  <T size={12} color={c.mute}>{[t(`cp.kind.${b.kind}`), b.duration_min ? `${b.duration_min} ${t('cls.min')}` : null].filter(Boolean).join(' · ')}</T>
                  {b.instructions ? <T size={13}>{b.instructions}</T> : null}
                  {(b.cues ?? []).map((x, j) => <T key={j} size={13}>• {x}</T>)}
                </View>
              ))}
            </View>
          ) : null}
          {w.people.filter((p) => p.summary).map((p) => <Section key={p.user_id} title={t('swk.athlete.feedback')} color={c.mint}><T>{p.summary}</T></Section>)}
          {w.evaluations.map((e) => (
            <Pressable key={e.id} onPress={() => { onClose(); push('MyEvaluation', { id: e.id }); }} accessibilityRole="button" accessibilityLabel={[e.title, t(`swk.eval.${e.status}`)].join(', ')} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <T weight="700" style={{ flex: 1 }}>{e.title}</T><Tag label={t(`swk.eval.${e.status}`)} />
            </Pressable>
          ))}
        </View>
      )}
    </Sheet>
  );
}
