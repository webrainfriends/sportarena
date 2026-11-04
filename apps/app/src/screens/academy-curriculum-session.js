// Curriculum on the screens that already own the moment (#782): the academy session (coach / staff) and the family's progress tab.
// No planner here: "Load drills" writes into the coach's own coaching plan through the existing coaching session record, and the completion
// evidence is read back from the blocks the coach marked there.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Empty, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { Block } from './academy-ui';
import { Gauge, devOptions } from './academy-curriculum';
import { Mastery, PILLAR_ICON, lbl } from './academy-curriculum-ui';

const STATUS_TONE = { delivered: c.lime, partly: c.sunSoft, not_delivered: c.orangeSoft, planned: c.cyanSoft };
const Panel = ({ children }) => <View style={{ backgroundColor: c.paper, borderRadius: 20, padding: 16, gap: 10, borderWidth: 1, borderColor: c.line }}>{children}</View>;

/** The session's objectives: what it is meant to teach (frozen as planned), the evidence, and the outcome the coach records. */
export function SessionObjectives({ s, toast, nav, mine }) {
  const d = useLoad(() => api.get(`/academy/sessions/${s.id}/objectives`).catch((e) => ({ denied: e })), [s.id]);
  const [form, setForm] = useState(null);   // 'add' | { outcome: objective }
  if (!d.data) return <Loading />;
  if (d.data.denied) return <Panel><Empty emoji="🔒" title={t('cur.sess.denied')} /></Panel>;
  const { objectives, available } = d.data;
  const started = (new Date(s.starts_at) <= new Date() && s.status === 'published') || s.status === 'completed';
  const run = async (fn, ok) => { try { await fn(); toast(ok); d.reload(); } catch (e) { toast(explain(e)); } };
  const load = () => run(async () => { const r = await api.post(`/academy/sessions/${s.id}/objectives/plan`, {}); if (nav) nav.push('SessionWorkspace', { source_type: 'academy_session', source_id: s.id }); return r; }, t('cur.sess.loaded'));
  const done = objectives.filter((o) => o.status === 'delivered').length;
  return (
    <Panel>
      <Block title={t('cur.sess.title')} right={s.status !== 'cancelled' && available.length ? <Btn small title={t('cur.sess.add')} color={c.paper} ink={c.ink} onPress={() => setForm('add')} /> : null}>
        <T size={12} color={c.mute}>{t('cur.sess.help')}</T>
        {objectives.length ? <Gauge done={done} total={objectives.length} label={t('cur.sess.delivered')} /> : null}
        {objectives.length ? objectives.map((o) => {
          const sn = o.snapshot, ev = o.live_evidence ?? o.evidence;
          return (
            <View key={o.id} style={{ padding: 10, borderRadius: 14, backgroundColor: c.bg, gap: 4 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <T size={16}>{PILLAR_ICON[sn.pillar] ?? '•'}</T><T weight="800" size={14} style={{ flex: 1 }}>{sn.title}</T><Tag label={t(`cur.ostate.${o.status}`)} color={STATUS_TONE[o.status]} />
              </View>
              <T size={12} color={c.mute}>{sn.competency_title} · {sn.curriculum_title} v{sn.version}{sn.rpe_target ? ` · RPE ${sn.rpe_target}` : ''}{ev?.blocks_planned ? ` · ${t('cur.blocks_done', { a: ev.blocks_done ?? 0, b: ev.blocks_planned })}` : ''}{o.evidence?.attested ? ` · ${t('cur.attested')}` : ''}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={t(`cur.priority.${sn.priority ?? 'core'}`)} color={(sn.priority ?? 'core') === 'core' ? c.pinkSoft : undefined} /><Mastery level={sn.mastery_target} /></View>
              {sn.success_criteria ? <T size={12.5}>✓ {sn.success_criteria}</T> : null}
              {sn.drills?.length ? <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>{sn.drills.map((x) => <Tag key={x.key} label={lbl`${x.title}${x.duration_min ? ` · ${x.duration_min}′` : ''}`} color={c.cyanSoft} />)}</View> : null}
              {o.deviation_reason ? <T size={12}>{t(`cur.dev.${o.deviation_reason}`)}{o.deviation_note ? ` · ${o.deviation_note}` : ''}</T> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {started ? <Btn small title={t(o.status === 'planned' ? 'cur.sess.record' : 'cur.sess.change')} onPress={() => setForm({ outcome: o })} /> : null}
                {o.status === 'planned' ? <Btn small title={t('cur.remove')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/academy/sessions/${s.id}/objectives`, { remove_keys: [o.objective_key] }), t('cur.sess.removed'))} /> : null}
              </View>
            </View>
          );
        }) : <Empty emoji="🧭" title={t('cur.sess.empty')} sub={available.length ? t('cur.sess.empty_pick') : t('cur.sess.empty_none')} />}
        {mine && objectives.some((o) => (o.status === 'planned')) && s.status !== 'cancelled' ? <Btn title={t('cur.sess.load')} onPress={load} /> : null}
        {!started && objectives.length ? <T size={11} color={c.mute}>{t('cur.sess.not_started')}</T> : null}
      </Block>
      <FormSheet visible={form === 'add'} onClose={() => setForm(null)} title={t('cur.sess.add')} submitLabel={t('cur.sess.add')}
        fields={[{ key: 'keys', label: t('cur.sess.pick'), type: 'multi', options: available.map((a) => ({ value: a.key, label: `${PILLAR_ICON[a.pillar] ?? ''} ${a.title}`, sub: a.curriculum_title })) }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${s.id}/objectives`, { add_keys: v.keys ?? [] }); d.reload(); return t('cur.sess.added'); }} />
      <FormSheet visible={!!form && form !== 'add'} onClose={() => setForm(null)} title={form?.outcome?.snapshot?.title ?? ''} submitLabel={t('common.save')} initial={{ outcome: 'delivered' }}
        fields={[{ key: 'outcome', label: t('cur.f.result'), type: 'chips', options: ['delivered', 'partly', 'not_delivered'].map((v) => ({ value: v, label: t(`cur.ostate.${v}`) })) },
          { key: 'deviation_reason', label: t('cur.f.why'), type: 'chips', options: devOptions(), show: (v) => v.outcome !== 'delivered' },
          { key: 'deviation_note', label: t('cur.f.note'), type: 'multiline', optional: true, show: (v) => v.outcome !== 'delivered' },
          { key: 'evidence_note', label: t('cur.f.how'), type: 'multiline', optional: true, hint: t('cur.f.how_hint'), show: (v) => v.outcome === 'delivered' }]}
        onSubmit={async (v) => { await api.post(`/academy/sessions/${s.id}/objectives/${form.outcome.objective_key}/outcome`, { outcome: v.outcome, deviation_reason: v.outcome === 'delivered' ? undefined : v.deviation_reason, deviation_note: v.deviation_note || undefined, evidence_note: v.evidence_note || undefined }); d.reload(); return t('cur.sess.recorded'); }} />
    </Panel>
  );
}

/** For the athlete or their verified guardian: in plain language, what each group is working on this season. */
export function FamilyCurriculum({ athlete }) {
  const q = athlete.is_me ? undefined : { athlete_id: athlete.id };
  const d = useLoad(() => api.get('/academy/my-curriculum', q), [athlete.id]);
  if (!d.data) return d.error ? null : <Loading />;
  if (!d.data.curricula.length) return null;
  return (
    <>
      {d.data.curricula.map((k) => (
        <Panel key={`${k.cohort_name}${k.curriculum}`}>
          <Block title={t('cur.fam.title')}>
            <T weight="800" size={15}>{k.curriculum}</T>
            <T size={12} color={c.mute}>{k.academy} · {k.cohort_name}{k.age_min != null || k.age_max != null ? ` · ${t('cur.ages', { a: k.age_min ?? '–', b: k.age_max ?? '–' })}` : ''}</T>
            <Gauge done={k.complete} total={k.total} label={t('cur.fam.progress')} />
            {k.objectives.map((o) => (
              <View key={o.key} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }} accessible accessibilityLabel={lbl`${o.title}: ${t(`cur.state.${o.state}`)}`}>
                <T size={16}>{PILLAR_ICON[o.pillar] ?? '•'}</T>
                <View style={{ flex: 1 }}><T weight="700" size={13}>{o.title}</T>{o.summary ? <T size={12} color={c.mute}>{o.summary}</T> : null}</View>
                <Tag label={t(`cur.state.${o.state}`)} color={o.state === 'complete' ? c.lime : o.state === 'in_progress' ? c.sunSoft : undefined} />
              </View>
            ))}
            <T size={11} color={c.mute}>{t('cur.fam.note')}</T>
          </Block>
        </Panel>
      ))}
    </>
  );
}
