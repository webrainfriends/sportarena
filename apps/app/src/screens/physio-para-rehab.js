// Para-sport specialist physiotherapy and adapted rehabilitation (PS-16).
// Extends canonical PhysioPanel (physio-practice.js) and athlete health (physio-tracking.js).
// Two export surfaces:
//   ParaAdaptiveTab  — the "Adaptive" tab inside PracticePanel (physio-facing)
//   AthleteMyRehab   — the "My Rehab" section inside the athlete's Health hub
// No diagnosis, impairment or classification data is shown here; this is purely a service filter.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { Btn, Card, Chip, Empty, ErrorBox, GradCard, Loading, Section, Seg, Sheet, StatPill, T, Tag } from '../ui';
import { DateField } from '../pickers';
import { c, day } from '../theme';
import { t } from '../i18n';

const lbl = (v) => String(v ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
const opts = (arr) => arr.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: lbl(x) }));
const Wait = ({ q, empty, children }) => {
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data?.length && empty) return empty;
  return children(q.data ?? []);
};
function useAct(reload) {
  const { toast } = useSession();
  return async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg); reload?.(); return r; } catch (e) { toast('' + e.message); return null; } };
}

const SPECIALISATIONS = [
  'wheelchair_load_management', 'prosthetic_sport', 'upper_limb_difference',
  'vision_impairment', 'intellectual_matp', 'acquired_disability',
  'hearing_impairment', 'short_stature', 'les_autres',
];
const OUTCOME_MEASURES = [
  ['wuspi', 'WUSPI (wheelchair)'], ['fim_mobility', 'FIM – mobility'],
  ['dash', 'DASH – upper limb'], ['promis_pain', 'PROMIS – pain'],
  ['ipaq_adapted', 'IPAQ adapted'], ['koos_adapted', 'KOOS adapted'],
  ['whodas_2', 'WHODAS 2.0'], ['wsq', 'WSQ'], ['custom', 'Custom series'],
];
const GOAL_STATUS = { in_progress: c.sunSoft, achieved: c.limeSoft, not_met: c.orangeSoft, discontinued: c.violetSoft };
const GOAL_STATUS_INK = { in_progress: c.sun, achieved: c.lime, not_met: c.orange, discontinued: c.mute };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  PROVIDER SIDE — ParaAdaptiveTab
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function ExpertiseProfile({ reload: parentReload }) {
  const q = useLoad(() => api.get('/me/para-expertise'), []);
  const [form, setForm] = useState(false);
  const act = useAct(async () => { q.reload(); parentReload?.(); });
  return (
    <Section title={t('pr.expertise_title')} color={c.violet}>
      <Card color={c.violetSoft} pad={12}>
        <T size={12} color={c.mute}>{t('pr.expertise_notice')}</T>
      </Card>
      <Wait q={q} empty={<Empty emoji="🏅" title={t('pr.no_expertise')} sub={t('pr.no_expertise_sub')} />}>
        {(items) => (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {items.map((e) => (
                <Chip
                  key={e.id}
                  label={`${lbl(e.specialisation)}${e.case_status === 'approved' ? ' ✓' : ''}`}
                  color={e.case_status === 'approved' ? c.limeSoft : c.pinkSoft}
                  ink={e.case_status === 'approved' ? c.lime : c.pink}
                  onPress={() => act(() => api.post(`/me/para-expertise/${e.id}/archive`), t('pr.expertise_archived'))}
                />
              ))}
            </View>
          </View>
        )}
      </Wait>
      <Btn title={t('pr.add_expertise')} color={c.violet} onPress={() => setForm(true)} />
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.add_expertise')}
        color={c.violet}
        submitLabel={t('pr.save_expertise')}
        fields={[
          { key: 'specialisation', label: t('pr.specialisation'), type: 'chips', options: opts(SPECIALISATIONS) },
          { key: 'credential_note', label: t('pr.credential_note'), type: 'multiline', optional: true, hint: t('pr.credential_note_hint') },
        ]}
        onSubmit={async (v) => { await api.post('/me/para-expertise', v); q.reload(); return t('pr.expertise_saved'); }}
      />
    </Section>
  );
}

function FunctionalGoalsSection({ planId, patientId, onClose }) {
  const q = useLoad(() => api.get(`/treatment-plans/${planId}/functional-goals`), [planId]);
  const measures = useLoad(() => api.get(`/treatment-plans/${planId}/outcome-measures`), [planId]);
  const [form, setForm] = useState(false);
  const [progForm, setProgForm] = useState(null);
  const act = useAct(q.reload);
  const measureOpts = (measures.data ?? []).map((m) => ({ value: m.measure_key, label: m.label ?? lbl(m.measure_key) }));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" style={{ flex: 1 }}>{t('pr.functional_goals')}</T>
        <Btn small title={t('pr.add_goal')} color={c.mint} onPress={() => setForm(true)} />
      </View>
      <Wait q={q} empty={<Empty emoji="🎯" title={t('pr.no_goals')} sub={t('pr.no_goals_sub')} />}>
        {(goals) => goals.map((g) => (
          <Card key={g.id} color={c.limeSoft} pad={10}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" size={13} style={{ flex: 1 }}>{g.title}</T>
              <Tag label={lbl(g.status)} color={GOAL_STATUS[g.status] ?? c.violetSoft} />
            </View>
            {g.measure ? <T size={12} color={c.mute}>{t('pr.measure')}: {g.measure}</T> : null}
            {g.target ? <T size={12} color={c.mute}>{t('pr.target')}: {g.target}</T> : null}
            {g.latest_pct != null ? (
              <View style={{ gap: 4, marginTop: 4 }}>
                <View style={{ height: 7, backgroundColor: c.line, borderRadius: 4, overflow: 'hidden' }} accessibilityLabel={`${g.latest_pct}% progress`}>
                  <View style={{ height: 7, width: `${g.latest_pct}%`, backgroundColor: GOAL_STATUS_INK[g.status] ?? c.mint, borderRadius: 4 }} />
                </View>
                <T size={11} color={c.mute} style={{ textAlign: 'right' }}>{g.latest_pct}% · {g.latest_at ? day(g.latest_at) : '—'}</T>
              </View>
            ) : null}
            <Btn small title={t('pr.update_progress')} color={c.paper} ink={c.ink} onPress={() => setProgForm(g)} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
          </Card>
        ))}
      </Wait>
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.add_goal')}
        color={c.mint}
        submitLabel={t('pr.save_goal')}
        fields={[
          { key: 'title', label: t('pr.goal_title'), hint: t('pr.goal_title_hint') },
          { key: 'measure', label: t('pr.measure'), type: 'multiline', optional: true, hint: t('pr.measure_hint') },
          { key: 'baseline', label: t('pr.baseline'), optional: true },
          { key: 'target', label: t('pr.target'), optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/treatment-plans/${planId}/functional-goals`, { plan_id: planId, ...v }); q.reload(); return t('pr.goal_saved'); }}
      />
      <FormSheet
        visible={!!progForm}
        onClose={() => setProgForm(null)}
        title={t('pr.update_progress')}
        color={c.mint}
        submitLabel={t('pr.save_progress')}
        initial={progForm ? { status: progForm.status, latest_pct: progForm.latest_pct } : {}}
        fields={[
          { key: 'status', label: t('pr.goal_status'), type: 'chips', options: opts(['in_progress', 'achieved', 'not_met', 'discontinued']) },
          { key: 'latest_pct', label: t('pr.pct_complete'), type: 'stepper', min: 0, max: 100, step: 5, suffix: '%', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/treatment-plans/${planId}/functional-goals/${progForm.id}/progress`, { plan_id: planId, id: progForm.id, ...v }); q.reload(); setProgForm(null); return t('pr.progress_saved'); }}
      />
    </View>
  );
}

function OutcomeMeasuresSection({ planId }) {
  const q = useLoad(() => api.get(`/treatment-plans/${planId}/outcome-measures`), [planId]);
  const [form, setForm] = useState(false);
  const act = useAct(q.reload);
  const current = q.data ?? [];
  const currentKeys = current.map((m) => m.measure_key);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={13} style={{ flex: 1 }}>{t('pr.outcome_measures')}</T>
        <Btn small title={t('pr.edit')} color={c.paper} ink={c.ink} onPress={() => setForm(true)} />
      </View>
      <Card color={c.cyanSoft} pad={10}>
        <T size={12} color={c.mute}>{t('pr.outcome_measures_notice')}</T>
      </Card>
      {current.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {current.map((m) => <Chip key={m.id} label={m.label ?? lbl(m.measure_key)} color={c.cyanSoft} ink={c.cyan} />)}
        </View>
      ) : <T size={12} color={c.mute}>{t('pr.no_outcome_measures')}</T>}
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.outcome_measures')}
        color={c.cyan}
        submitLabel={t('pr.save_measures')}
        initial={{ measures: currentKeys }}
        fields={[{ key: 'measures', label: t('pr.select_measures'), type: 'chips', options: opts(OUTCOME_MEASURES), multi: true, optional: true }]}
        onSubmit={async (v) => {
          const measures = (v.measures ?? []).map((k) => ({ measure_key: k }));
          await api.put(`/treatment-plans/${planId}/outcome-measures`, { plan_id: planId, measures });
          q.reload();
          return t('pr.measures_saved');
        }}
      />
    </View>
  );
}

function AdaptedVariantsSection({ planId }) {
  const q = useLoad(() => api.get('/me/adapted-variants', { plan_id: planId }), [planId]);
  const exLib = useLoad(() => api.get('/me/exercises', { limit: 100 }), []);
  const [form, setForm] = useState(false);
  const act = useAct(q.reload);
  const exOpts = (exLib.data?.items ?? []).map((e) => ({ value: e.version_id, label: e.title }));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={13} style={{ flex: 1 }}>{t('pr.adapted_variants')}</T>
        <Btn small title={t('pr.add_variant')} color={c.lime} onPress={() => setForm(true)} />
      </View>
      <Card color={c.mintSoft} pad={10}>
        <T size={12} color={c.mute}>{t('pr.adapted_variants_notice')}</T>
      </Card>
      <Wait q={q} empty={<Empty emoji="🏃" title={t('pr.no_variants')} sub={t('pr.no_variants_sub')} />}>
        {(items) => items.map((v) => (
          <Card key={v.id} color={c.limeSoft} pad={10}>
            <T weight="800" size={13}>{t('pr.adapted_variant_of')}: {v.exercise_version_id}</T>
            {v.position_guidance ? <T size={12}><T weight="700" size={12}>{t('pr.position_guidance')}: </T>{v.position_guidance}</T> : null}
            {v.equipment_note ? <T size={12}><T weight="700" size={12}>{t('pr.equipment_note')}: </T>{v.equipment_note}</T> : null}
            {v.precautions ? <T size={12} color={c.red}><T weight="700" size={12} color={c.red}>{t('pr.precautions')}: </T>{v.precautions}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {v.has_audio ? <Chip label={t('pr.has_audio')} color={c.mintSoft} ink={c.mint} /> : null}
              {v.has_large_print ? <Chip label={t('pr.has_large_print')} color={c.cyanSoft} ink={c.cyan} /> : null}
            </View>
            <Btn small title={t('pr.archive')} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/adapted-variants/${v.id}/archive`), t('pr.variant_archived'))} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
          </Card>
        ))}
      </Wait>
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.add_variant')}
        color={c.lime}
        submitLabel={t('pr.save_variant')}
        fields={[
          { key: 'exercise_version_id', label: t('pr.base_exercise'), type: 'chips', options: exOpts },
          { key: 'position_guidance', label: t('pr.position_guidance'), type: 'multiline', optional: true, hint: t('pr.position_guidance_hint') },
          { key: 'equipment_note', label: t('pr.equipment_note'), type: 'multiline', optional: true, hint: t('pr.equipment_note_hint') },
          { key: 'precautions', label: t('pr.precautions'), type: 'multiline', optional: true, hint: t('pr.precautions_hint') },
          { key: 'has_audio', label: t('pr.has_audio'), type: 'switch', default: false },
          { key: 'has_large_print', label: t('pr.has_large_print'), type: 'switch', default: false },
          { key: 'media_url', label: t('pr.media_url'), optional: true },
          { key: 'media_source', label: t('pr.media_source'), optional: true, show: (v) => !!v.media_url },
          { key: 'media_licence', label: t('pr.media_licence'), optional: true, show: (v) => !!v.media_url },
        ]}
        onSubmit={async (v) => { await api.post('/me/adapted-variants', { plan_id: planId, ...v }); q.reload(); return t('pr.variant_saved'); }}
      />
    </View>
  );
}

function CoachingReadinessSection({ planId }) {
  const q = useLoad(() => api.get(`/treatment-plans/${planId}/coaching-readiness`), [planId]);
  const [form, setForm] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const act = useAct(q.reload);
  const clearance = q.data;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" size={13} style={{ flex: 1 }}>{t('pr.coaching_readiness')}</T>
        {clearance?.status !== 'active' ? <Btn small title={t('pr.issue_clearance')} color={c.mint} onPress={() => setForm(true)} /> : null}
      </View>
      <Card color={c.violetSoft} pad={10}>
        <T size={12} color={c.mute}>{t('pr.coaching_readiness_notice')}</T>
      </Card>
      {q.loading && !q.data ? <Loading /> : null}
      {clearance ? (
        <Card color={clearance.status === 'active' ? c.limeSoft : c.violetSoft} pad={10}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" size={13} style={{ flex: 1 }}>{clearance.status === 'active' ? t('pr.clearance_active') : lbl(clearance.status)}</T>
            <Tag label={clearance.status === 'active' ? '✓' : '—'} color={clearance.status === 'active' ? c.lime : c.violetSoft} />
          </View>
          {clearance.load_restriction ? <T size={12}>{clearance.load_restriction}</T> : null}
          {clearance.review_date ? <T size={12} color={c.mute}>{t('pr.review_date')}: {clearance.review_date}</T> : null}
          <T size={11} color={c.mute}>{t('pr.issued')}: {day(clearance.issued_at)}</T>
          {clearance.status === 'active' ? (
            <Btn small title={t('pr.revoke_clearance')} color={c.paper} ink={c.red} onPress={() => setRevoking(true)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
          ) : null}
        </Card>
      ) : <T size={12} color={c.mute}>{t('pr.no_clearance')}</T>}
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.issue_clearance')}
        color={c.mint}
        submitLabel={t('pr.issue_clearance')}
        fields={[
          { key: 'load_restriction', label: t('pr.load_restriction'), optional: true, hint: t('pr.load_restriction_hint') },
          { key: 'review_date', label: t('pr.review_date'), type: 'date', optional: true },
          { key: 'coach_ids', label: t('pr.coach_ids'), type: 'multiline', hint: t('pr.coach_ids_hint') },
        ]}
        onSubmit={async (v) => {
          const coach_ids = String(v.coach_ids ?? '').split(/[\s,;]+/).filter(Boolean);
          if (!coach_ids.length) throw new Error(t('pr.coach_ids_required'));
          await api.post(`/treatment-plans/${planId}/coaching-readiness`, { plan_id: planId, load_restriction: v.load_restriction || null, review_date: v.review_date || null, coach_ids });
          q.reload();
          return t('pr.clearance_issued');
        }}
      />
      {revoking && clearance ? (
        <Sheet visible onClose={() => setRevoking(false)} title={t('pr.revoke_clearance')}>
          <Card color={c.redSoft} pad={12}><T size={13}>{t('pr.revoke_clearance_confirm')}</T></Card>
          <Btn title={t('pr.revoke_clearance')} color={c.red} onPress={async () => { await act(() => api.post(`/treatment-plans/${planId}/coaching-readiness/${clearance.id}/revoke`, { plan_id: planId, id: clearance.id }), t('pr.clearance_revoked')); setRevoking(false); }} />
        </Sheet>
      ) : null}
    </View>
  );
}

function PlanAdaptiveDetail({ planId, patientId, onClose }) {
  const [sec, setSec] = useState('goals');
  return (
    <Sheet visible onClose={onClose} title={t('pr.adapted_plan_detail')}>
      <Seg
        options={[
          { value: 'goals', label: t('pr.functional_goals') },
          { value: 'measures', label: t('pr.outcome_measures') },
          { value: 'variants', label: t('pr.adapted_variants_short') },
          { value: 'readiness', label: t('pr.coaching_readiness_short') },
        ]}
        value={sec}
        onChange={setSec}
        color={c.violet}
      />
      {sec === 'goals' && <FunctionalGoalsSection planId={planId} patientId={patientId} onClose={onClose} />}
      {sec === 'measures' && <OutcomeMeasuresSection planId={planId} />}
      {sec === 'variants' && <AdaptedVariantsSection planId={planId} />}
      {sec === 'readiness' && <CoachingReadinessSection planId={planId} />}
    </Sheet>
  );
}

function ParaPatientCard({ p, onSelect }) {
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={p.patient_name}>
          <T weight="900" color={c.on}>{p.patient_name.slice(0, 2).toUpperCase()}</T>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{p.patient_name}</T>
          <T size={12} color={c.mute}>{p.plan_count} {t('pr.plans')} · {p.functional_goal_count} {t('pr.goals')} · {p.last_activity ? day(p.last_activity) : '—'}</T>
        </View>
        {p.active_clearances > 0 ? <Tag label={t('pr.cleared')} color={c.limeSoft} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        <Btn small title={t('pr.view_plans')} color={c.violet} onPress={() => onSelect(p.patient_id)} />
      </View>
    </Card>
  );
}

function ParaPatientPlansSheet({ patientId, onClose }) {
  const q = useLoad(() => api.get('/treatment-plans', { patient_id: patientId, limit: 50 }), [patientId]);
  const [planId, setPlanId] = useState(null);
  return (
    <Sheet visible onClose={onClose} title={t('pr.patient_adapted_plans')}>
      <Wait q={q} empty={<Empty emoji="📝" title={t('pr.no_plans')} sub={t('pr.no_plans_sub')} />}>
        {(plans) => plans.filter((p) => p.as === 'provider').map((p) => (
          <Card key={p.id} pad={10}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" style={{ flex: 1 }}>{p.title}</T>
              <Tag label={p.status} color={p.status === 'active' ? c.limeSoft : c.violetSoft} />
            </View>
            <T size={12} color={c.mute}>{day(p.updated_at)}</T>
            <Btn small title={t('pr.adaptive_detail')} color={c.violet} ink={c.on} onPress={() => setPlanId(p.id)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
          </Card>
        ))}
      </Wait>
      {planId ? <PlanAdaptiveDetail planId={planId} patientId={patientId} onClose={() => setPlanId(null)} /> : null}
    </Sheet>
  );
}

export function ParaAdaptiveTab() {
  const q = useLoad(() => api.get('/physio/para/patients', { limit: 50 }), []);
  const [selected, setSelected] = useState(null);
  const [expertiseOpen, setExpertiseOpen] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <GradCard pad={16} accessibilityRole="header">
        <T weight="900" size={18} color={c.on}>{t('pr.adaptive_tab_title')}</T>
        <T size={12} color={c.on} style={{ opacity: 0.85 }}>{t('pr.adaptive_tab_sub')}</T>
      </GradCard>

      <Section title={t('pr.para_expertise')} color={c.violet} right={<Btn small title={t('pr.edit')} color={c.paper} ink={c.ink} onPress={() => setExpertiseOpen(true)} />}>
        <ExpertiseInline />
      </Section>

      <Section title={t('pr.para_patients')} color={c.pink}>
        <Wait q={q} empty={<Empty emoji="🏅" title={t('pr.no_para_patients')} sub={t('pr.no_para_patients_sub')} />}>
          {({ items }) => items.map((p) => <ParaPatientCard key={p.patient_id} p={p} onSelect={setSelected} />)}
        </Wait>
      </Section>

      {selected ? <ParaPatientPlansSheet patientId={selected} onClose={() => setSelected(null)} /> : null}
      {expertiseOpen ? <ExpertiseSheet onClose={() => setExpertiseOpen(false)} /> : null}
    </View>
  );
}

function ExpertiseInline() {
  const q = useLoad(() => api.get('/me/para-expertise'), []);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const items = q.data ?? [];
  if (!items.length) return <T size={13} color={c.mute}>{t('pr.no_expertise_inline')}</T>;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map((e) => (
        <Chip key={e.id} label={`${lbl(e.specialisation)}${e.case_status === 'approved' ? ' ✓' : ''}`} color={e.case_status === 'approved' ? c.limeSoft : c.pinkSoft} ink={e.case_status === 'approved' ? c.lime : c.pink} />
      ))}
    </View>
  );
}

function ExpertiseSheet({ onClose }) {
  const q = useLoad(() => api.get('/me/para-expertise'), []);
  const { toast } = useSession();
  const [form, setForm] = useState(false);
  const act = useAct(q.reload);
  return (
    <Sheet visible onClose={onClose} title={t('pr.expertise_title')}>
      <Card color={c.violetSoft} pad={12}>
        <T size={12} color={c.mute}>{t('pr.expertise_notice')}</T>
      </Card>
      <Wait q={q} empty={<Empty emoji="🏅" title={t('pr.no_expertise')} sub={t('pr.no_expertise_sub')} />}>
        {(items) => items.map((e) => (
          <Card key={e.id} pad={10}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" style={{ flex: 1 }}>{lbl(e.specialisation)}</T>
              <Tag label={e.case_status === 'approved' ? t('pr.verified') : t('pr.self_declared')} color={e.case_status === 'approved' ? c.limeSoft : c.sunSoft} />
            </View>
            {e.credential_note ? <T size={12} color={c.mute}>{e.credential_note}</T> : null}
            <Btn small title={t('pr.archive')} color={c.paper} ink={c.red} onPress={() => act(() => api.post(`/me/para-expertise/${e.id}/archive`), t('pr.expertise_archived'))} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
          </Card>
        ))}
      </Wait>
      <Btn title={t('pr.add_expertise')} color={c.violet} onPress={() => setForm(true)} />
      <FormSheet
        visible={form}
        onClose={() => setForm(false)}
        title={t('pr.add_expertise')}
        color={c.violet}
        submitLabel={t('pr.save_expertise')}
        fields={[
          { key: 'specialisation', label: t('pr.specialisation'), type: 'chips', options: opts(SPECIALISATIONS) },
          { key: 'credential_note', label: t('pr.credential_note'), type: 'multiline', optional: true, hint: t('pr.credential_note_hint') },
        ]}
        onSubmit={async (v) => { await api.post('/me/para-expertise', v); q.reload(); return t('pr.expertise_saved'); }}
      />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  ATHLETE SIDE — AthleteMyRehab
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function AthletePlanCard({ plan }) {
  const [open, setOpen] = useState(false);
  const goals = useLoad(() => (open ? api.get(`/treatment-plans/${plan.id}/functional-goals`) : Promise.resolve(null)), [open, plan.id]);
  const variants = useLoad(() => (open ? api.get('/me/adapted-variants', { plan_id: plan.id }) : Promise.resolve(null)), [open, plan.id]);
  const clearance = useLoad(() => (open ? api.get(`/treatment-plans/${plan.id}/coaching-readiness`) : Promise.resolve(null)), [open, plan.id]);
  const isAdapted = open && ((goals.data?.length ?? 0) > 0 || (variants.data?.total ?? 0) > 0);
  return (
    <Card pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="800" style={{ flex: 1 }}>{plan.title}</T>
        <Tag label={plan.status} color={plan.status === 'active' ? c.limeSoft : c.violetSoft} />
      </View>
      <T size={12} color={c.mute}>{plan.provider_name} · {day(plan.updated_at)}</T>
      <Btn small title={open ? t('pr.hide') : t('pr.open_plan')} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      {open ? (
        <View style={{ marginTop: 10, gap: 10 }}>

          {/* functional goals */}
          {goals.loading && !goals.data ? <Loading /> : null}
          {goals.data?.length ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>{t('pr.functional_goals')}</T>
              {goals.data.map((g) => (
                <Card key={g.id} color={c.limeSoft} pad={8}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T size={13} style={{ flex: 1 }}>🎯 {g.title}</T>
                    <Tag label={lbl(g.status)} color={GOAL_STATUS[g.status] ?? c.violetSoft} />
                  </View>
                  {g.measure ? <T size={12} color={c.mute}>{g.measure}</T> : null}
                  {g.target ? <T size={12} color={c.mute}>{t('pr.target')}: {g.target}</T> : null}
                  {g.latest_pct != null ? (
                    <View style={{ gap: 3, marginTop: 4 }}>
                      <View style={{ height: 7, backgroundColor: c.line, borderRadius: 4, overflow: 'hidden' }} accessibilityLabel={`${g.latest_pct}% progress`}>
                        <View style={{ height: 7, width: `${g.latest_pct}%`, backgroundColor: c.lime, borderRadius: 4 }} />
                      </View>
                      <T size={11} color={c.mute} style={{ textAlign: 'right' }}>{g.latest_pct}% · {g.latest_at ? day(g.latest_at) : '—'}</T>
                    </View>
                  ) : null}
                </Card>
              ))}
            </View>
          ) : null}

          {/* adapted exercise variants */}
          {variants.data?.total > 0 ? (
            <View style={{ gap: 6 }}>
              <T weight="800" size={13}>{t('pr.your_adapted_exercises')}</T>
              {(variants.data?.items ?? []).map((v) => (
                <Card key={v.id} color={c.mintSoft} pad={8}>
                  {v.position_guidance ? <T size={12}><T weight="700" size={12}>{t('pr.position_guidance')}: </T>{v.position_guidance}</T> : null}
                  {v.equipment_note ? <T size={12}><T weight="700" size={12}>{t('pr.equipment_note')}: </T>{v.equipment_note}</T> : null}
                  {v.precautions ? (
                    <Card color={c.redSoft} pad={6}>
                      <T size={12} color={c.red}><T weight="700" size={12} color={c.red}>{t('pr.stop_if')}: </T>{v.precautions}</T>
                    </Card>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {v.has_audio ? <Chip label={t('pr.audio_guide')} color={c.mintSoft} ink={c.mint} /> : null}
                    {v.has_large_print ? <Chip label={t('pr.large_print')} color={c.cyanSoft} ink={c.cyan} /> : null}
                  </View>
                </Card>
              ))}
            </View>
          ) : null}

          {/* coaching readiness */}
          {clearance.data ? (
            <Card color={clearance.data.status === 'active' ? c.limeSoft : c.violetSoft} pad={8}>
              <T weight="800" size={13}>{t('pr.coach_notified_title')}</T>
              <T size={12} color={c.mute}>{t('pr.coach_notified_body')}</T>
              {clearance.data.load_restriction ? <T size={12}>{t('pr.load')}: {clearance.data.load_restriction}</T> : null}
              {clearance.data.review_date ? <T size={12} color={c.mute}>{t('pr.next_review')}: {clearance.data.review_date}</T> : null}
              <T size={11} color={c.mute}>{t('pr.issued')}: {day(clearance.data.issued_at)}</T>
            </Card>
          ) : null}

        </View>
      ) : null}
    </Card>
  );
}

export function AthleteMyRehab() {
  const q = useLoad(() => api.get('/treatment-plans', { limit: 50 }), []);
  const plans = (q.data ?? []).filter((p) => p.as === 'patient' && p.status !== 'draft');
  const adapted = plans.filter((p) => p.status === 'active' || p.status === 'paused');
  return (
    <View style={{ gap: 12 }}>
      <Card color={c.mintSoft} pad={12} accessibilityRole="text">
        <T weight="800">{t('pr.my_rehab_title')}</T>
        <T size={12} color={c.mute}>{t('pr.my_rehab_sub')}</T>
      </Card>
      {q.loading && !q.data ? <Loading /> : null}
      {q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : null}
      {!q.loading && !plans.length ? (
        <Empty emoji="🏥" title={t('pr.no_rehab_plans')} sub={t('pr.no_rehab_plans_sub')} />
      ) : (
        plans.map((p) => <AthletePlanCard key={p.id} plan={p} />)
      )}
    </View>
  );
}
