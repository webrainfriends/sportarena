// Curriculum Studio (#782): the guided flow for writing one version: scope → periodisation → objectives → review. Nothing is final until the
// Technical Director approves; saving only ever writes the open draft. The review step asks the server whether the version is ready and shows
// exactly what it changes against the version it follows.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { Block, Fact, when } from './academy-ui';
import { slugOf } from './academy-methodology';
import { ObjectiveEditor } from './academy-curriculum-editors';
import { Diff, Eyebrow, Mastery, Panel, PhaseTimeline, PILLARS, PILLAR_ICON, PRIORITIES, MASTERY, INTENSITIES, Readiness, Steps, INT_TONE, opt, lbl } from './academy-curriculum-ui';

const todayStr = () => new Date().toISOString().slice(0, 10);

export function Studio({ cur, d, o, toast, onClose }) {
  const meth = d.methodology;
  const open = d.versions.find((v) => v.status === 'draft');
  const base = open ?? d.versions.find((v) => v.status !== 'rejected');
  const [list, setList] = useState(() => base?.objectives ?? []);
  const [phases, setPhases] = useState(() => base?.phases ?? []);
  const [from, setFrom] = useState(open?.effective_from ? String(open.effective_from).slice(0, 10) : todayStr());
  const [note, setNote] = useState(open?.note ?? '');
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(null);   // { kind: 'objective'|'phase'|'scope', at, x }
  const [saved, setSaved] = useState(open?.id ?? null);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const rubrics = useLoad(() => api.get(`/organisations/${o.id}/academy/rubrics`).catch(() => []), [o.id]);
  const hasParent = !!cur.parent_id;
  const inherited = (d.objectives ?? []).filter((x) => x.inherited_from && !list.some((l) => l.key === x.key));
  const comps = meth.competencies.map((k) => ({ value: k.key, label: `${PILLAR_ICON[k.pillar]} ${k.title}`, sub: t(`cur.pillar.${k.pillar}`) }));
  const drills = meth.drills.map((x) => ({ value: x.key, label: x.title, sub: `${t(`cur.kind.${x.kind}`)}${x.duration_min ? ` · ${x.duration_min} min` : ''}` }));
  const assessOpts = (rubrics.data ?? []).flatMap((r) => (r.dimensions ?? []).map((dm) => ({ value: `${r.id}|${dm.key}`, label: `${r.name} · ${dm.name ?? dm.key}` })));
  const body = () => ({ objectives: list, phases, effective_from: from, note: note || undefined });
  const save = async () => { setBusy(true); try { const v = await api.post(`/academy/curricula/${cur.id}/versions`, body()); setSaved(v.id); toast(t('cur.draft_saved')); return v; } catch (e) { toast(explain(e)); return null; } finally { setBusy(false); } };
  const check = async () => { const v = await save(); if (v) setReview(await api.get(`/academy/curriculum-versions/${v.id}/readiness`)); };
  const submit = async () => { try { await api.post(`/academy/curriculum-versions/${saved}/submit`, {}); toast(t('cur.submitted')); onClose(); } catch (e) { toast(e?.details?.blockers ? t('cur.not_ready') : explain(e)); } };
  const core = list.filter((x) => (x.priority ?? 'core') === 'core').length;
  const pillarsHit = new Set(list.map((x) => meth.competencies.find((k) => k.key === x.competency_key)?.pillar).filter(Boolean));
  const nav = (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      {step > 0 ? <Btn small title={t('common.back')} color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} /> : <Btn small title={t('common.cancel')} color={c.paper} ink={c.ink} onPress={onClose} />}
      {step < 3 ? <Btn small title={t('common.next')} onPress={() => setStep(step + 1)} /> : null}
      {step < 3 ? <Btn small title={t('cur.save_draft')} color={c.paper} ink={c.ink} loading={busy} disabled={!list.length} onPress={save} /> : null}
    </View>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><T size={17} weight="800" style={{ flex: 1 }}>{t('cur.studio.title', { name: cur.title })}</T>{saved ? <Tag label={t('cur.studio.saved')} color={c.lime} /> : <Tag label={t('cur.studio.unsaved')} color={c.sunSoft} />}</View>
      <Steps steps={[t('cur.step.scope'), t('cur.step.phases'), t('cur.step.objectives'), t('cur.step.review')]} at={step} onGo={setStep} />

      {step === 0 ? (
        <Panel>
          <Block title={t('cur.step.scope')}>
            <T size={12.5} color={c.mute}>{t('cur.editor_help', { v: meth.version ?? '–' })}</T>
            <Fact k={t('cur.methodology')} v={`${meth.title} · v${meth.version ?? '–'}`} />
            <Fact k={t('cur.f.stage')} v={cur.stage_key} />
            <Fact k={t('cur.f.age_band')} v={cur.age_min != null || cur.age_max != null ? t('cur.ages', { a: cur.age_min ?? '–', b: cur.age_max ?? '–' }) : null} />
            <Fact k={t('cur.in_force')} v={d.in_force ? `v${d.in_force.version}` : t('cur.none_published')} />
            {hasParent ? <T size={12} color={c.mute}>{t('cur.inherits_from', { name: cur.parent_title })}</T> : null}
            <Btn small title={lbl`${t('cur.effective_from')}: ${when(from)}`} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'scope' })} />
            {note ? <T size={13}>“{note}”</T> : <T size={12} color={c.mute}>{t('cur.f.why_version_hint')}</T>}
          </Block>
        </Panel>
      ) : null}

      {step === 1 ? (
        <Panel>
          <Block title={t('cur.step.phases')} right={<Btn small title={t('cur.add_phase')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'phase', at: phases.length })} />}>
            <T size={12.5} color={c.mute}>{t('cur.phases_help')}</T>
            {phases.length ? <PhaseTimeline phases={phases} /> : <Empty emoji="🗓️" title={t('cur.no_phases')} sub={t('cur.no_phases_sub')} />}
            {phases.map((p, n) => (
              <View key={p.key} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T weight="800" size={14} style={{ flex: 1 }}>{p.title}</T><Tag label={t(`cur.intensity.${p.intensity}`)} color={INT_TONE[p.intensity]} /></View>
                <T size={12} color={c.mute}>{when(p.starts_on)} – {when(p.ends_on)}{p.focus_keys?.length ? ` · ${t('cur.focus_n', { n: p.focus_keys.length })}` : ''}</T>
                <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'phase', at: n, x: p })} /><Btn small title={t('cur.remove')} color={c.paper} ink={c.ink} onPress={() => { setPhases((l) => l.filter((_, i) => i !== n)); setList((l) => l.map((x) => ({ ...x, phase_keys: (x.phase_keys ?? []).filter((k) => k !== p.key) }))); }} /></View>
              </View>
            ))}
          </Block>
        </Panel>
      ) : null}

      {step === 2 && form?.kind === 'objective' ? (
        <ObjectiveEditor x={form.x} meth={meth} stageKey={cur.stage_key} phases={phases} assessOpts={assessOpts} hasParent={hasParent} std={meth.standards} taken={new Set(list.map((l) => l.key))}
          onCancel={() => setForm(null)} onSave={(row) => { setList((l) => { const a = [...l]; const at = form.x ? l.findIndex((x) => x.key === form.x.key) : -1; if (at >= 0) a[at] = row; else a.push(row); return a; }); setForm(null); }} />
      ) : null}
      {step === 2 && form?.kind !== 'objective' ? (
        <Panel>
          <Block title={t('cur.step.objectives')} right={<Btn small title={t('cur.add_objective')} onPress={() => setForm({ kind: 'objective', at: list.length })} />}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={lbl`${list.length} ${t('cur.objectives').toLowerCase()}`} /><Tag label={lbl`${core} ${t('cur.priority.core').toLowerCase()}`} color={c.pinkSoft} /><Tag label={lbl`${pillarsHit.size}/${new Set(meth.competencies.map((k) => k.pillar)).size} ${t('cur.pillars_covered')}`} color={c.cyanSoft} /></View>
            {PILLARS.map((p) => {
              const rows = list.map((x, n) => ({ x, n })).filter(({ x }) => (meth.competencies.find((k) => k.key === x.competency_key)?.pillar ?? 'technical') === p);
              return rows.length ? (
                <View key={p} style={{ gap: 6 }}>
                  <Eyebrow>{`${PILLAR_ICON[p]} ${t(`cur.pillar.${p}`)}`}</Eyebrow>
                  {rows.map(({ x, n }) => (
                    <View key={x.key} style={{ padding: 12, borderRadius: 16, backgroundColor: c.bg, gap: 4 }}>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><T weight="800" size={14} style={{ flex: 1, minWidth: 150 }}>{x.op && x.op !== 'add' ? `${t(`cur.op.${x.op}`)} · ` : ''}{x.title}</T>{x.op !== 'exclude' ? <Tag label={t(`cur.priority.${x.priority ?? 'core'}`)} color={(x.priority ?? 'core') === 'core' ? c.pinkSoft : undefined} /> : null}</View>
                      {x.op !== 'exclude' ? <><T size={12} color={c.mute}>{meth.competencies.find((k) => k.key === x.competency_key)?.title} · {t('cur.target_sessions', { n: x.sessions_target ?? 1 })}{x.rpe_target ? ` · RPE ${x.rpe_target}` : ''}</T><Mastery level={x.mastery_target} />{x.success_criteria ? <T size={12}>✓ {x.success_criteria}</T> : <T size={12} color={c.orange}>⛔ {t('cur.missing_criteria')}</T>}</> : null}
                      <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title={t('cur.edit')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'objective', at: n, x })} /><Btn small title={t('cur.remove')} color={c.paper} ink={c.ink} onPress={() => setList((l) => l.filter((_, i) => i !== n))} /></View>
                    </View>
                  ))}
                </View>
              ) : null;
            })}
            {!list.length ? <Empty emoji="🧩" title={t('cur.no_objectives')} sub={t('cur.no_objectives_sub')} /> : null}
            {inherited.length ? (
              <View style={{ gap: 6 }}>
                <Eyebrow>{t('cur.inherited_from_parent', { name: cur.parent_title })}</Eyebrow>
                {inherited.map((x) => (
                  <View key={x.key} style={{ padding: 10, borderRadius: 14, backgroundColor: c.cyanSoft, gap: 4 }}>
                    <T weight="700" size={13}>{PILLAR_ICON[x.pillar]} {x.title}</T>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Btn small title={t('cur.change_here')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'objective', at: list.length, x: { ...x, op: 'override', drills: undefined, inherited_from: undefined, inherited_title: undefined, pillar: undefined, competency_title: undefined, overrides_parent: undefined } })} />
                      <Btn small title={t('cur.leave_out')} color={c.paper} ink={c.ink} onPress={() => setList((l) => [...l, { key: x.key, title: x.title, competency_key: x.competency_key, op: 'exclude', sessions_target: 1, drill_keys: [], phase_keys: [], priority: 'core', mastery_target: 'develop' }])} />
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </Block>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel>
          <Block title={t('cur.step.review')}>
            <T size={12.5} color={c.mute}>{t('cur.review_help')}</T>
            <Btn title={t('cur.check_ready')} loading={busy} disabled={!list.length} onPress={check} />
            {review ? (
              <>
                <Eyebrow>{t('cur.ready.title')}</Eyebrow><Readiness r={review.readiness} />
                <Eyebrow>{t('cur.diff.title')}</Eyebrow><Diff d={review.diff} against={review.against} />
                <T size={12} color={c.mute}>{t('cur.impact', { g: review.impact.groups, s: review.impact.sessions_keep_old_wording })}</T>
                <Btn title={t('cur.submit')} disabled={!review.readiness.ready} onPress={submit} />
                {!review.readiness.ready ? <T size={12} color={c.orange}>{t('cur.fix_blockers')}</T> : null}
              </>
            ) : <Loading />}
          </Block>
        </Panel>
      ) : null}
      {form?.kind === 'objective' ? null : nav}

      <FormSheet visible={form?.kind === 'scope'} onClose={() => setForm(null)} title={t('cur.step.scope')} submitLabel={t('common.save')} initial={{ from, note }}
        fields={[{ key: 'from', label: t('cur.effective_from'), type: 'date', hint: t('cur.effective_hint') }, { key: 'note', label: t('cur.f.why_version'), type: 'multiline', optional: true, hint: t('cur.f.why_version_hint') }]}
        onSubmit={async (v) => { setFrom(v.from); setNote(v.note ?? ''); }} />
      <FormSheet visible={form?.kind === 'phase'} onClose={() => setForm(null)} title={t('cur.phase')} submitLabel={t('common.save')}
        initial={form?.x ? { ...form.x } : { intensity: 'medium', starts_on: from }}
        fields={[{ key: 'title', label: t('cur.f.title'), hint: t('cur.f.phase_hint') }, { key: 'starts_on', label: t('cur.f.dates'), type: 'daterange', toKey: 'ends_on' },
          { key: 'intensity', label: t('cur.f.intensity'), type: 'chips', options: opt(INTENSITIES, 'cur.intensity') }, { key: 'focus_keys', label: t('cur.f.focus'), type: 'multi', optional: true, options: comps }, { key: 'note', label: t('cur.f.note'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => {
          const key = form.x?.key ?? slugOf(v.title, 'p', new Set(phases.map((p) => p.key)));
          const row = { key, title: v.title, starts_on: v.starts_on, ends_on: v.ends_on ?? v.starts_on, intensity: v.intensity ?? 'medium', focus_keys: v.focus_keys ?? [], note: v.note || undefined };
          setPhases((l) => { const a = [...l]; a[form.at] = row; return a.sort((x, y) => x.starts_on.localeCompare(y.starts_on)); });
        }} />
    </View>
  );
}
