// Inclusive & adaptive academy programmes (#808): the staff side inside Organisation → Academy ("Inclusion"). The director sees counts and what needs attention,
// a coach or venue contact sees only what was shared with them for a session, and a programme lead sets what a programme offers. No diagnosis is asked for or shown.
// Every rule is enforced by the API (capabilities academy-inclusion.js); this screen only calls it. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { Bars, Block, Initials, Kpi } from './academy-ui';
import { AdaptedAssessments } from './academy-inclusion-assess';

const TYPES = ['access', 'equipment', 'support_person', 'transport', 'communication', 'schedule'];
export const typeLabel = (k) => t(`inc.type_${k}`);
export const needLabel = (k) => t(`inc.need_${k}`);
export const featureLabel = (k) => t(`inc.feature_${k}`);
const modeLabel = (k) => t(`inc.mode_${k}`);
const variantLabel = (k) => t(`inc.variant_${k}`);
const templateLabel = (k) => t(`inc.tpl_${k}`);
const schemeLabel = (k) => t(`inc.scheme_${k}`);
export const dayText = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATE_TONE = { met: c.lime, short: c.sun, gap: c.orange, manual: c.cyan };
const reqLabel = (r) => (r.kind === 'venue_feature' ? t('inc.req_venue', { feature: featureLabel(r.feature) }) : r.kind === 'support' ? t('inc.req_support', { assigned: r.assigned, needed: r.needed })
  : r.kind === 'duty' ? t('inc.req_duty', { duty: r.duty.replace(/_/g, ' ') }) : r.kind === 'credential' ? t('inc.req_credential', { credential: r.credential.replace(/_/g, ' ') }) : t('inc.req_equipment', { n: r.athletes }));
const pc = (v) => (v == null ? '–' : `${v}%`);

export function InclusionDesk({ o, role, athleteId, toast }) {
  const [tab, setTab] = useState(role === 'owner' || role === 'admin' ? 'overview' : role === 'guardian' ? 'guardian_progress' : 'session');
  const [pick, setPick] = useState(null);
  const director = role === 'owner' || role === 'admin';
  const guardian = role === 'guardian';
  const tabs = [
    ...(director ? [['overview', t('inc.tab_overview')]] : []),
    ...(!guardian ? [['session', t('inc.tab_session')]] : []),
    ...(!guardian ? [['assess', t('inc.tab_assess')]] : []),
    ...(director ? [['programmes', t('inc.tab_programmes')]] : []),
    ...(guardian ? [['guardian_progress', t('incops.guardian_progress_title')]] : []),
  ];
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('inc.title')}</T><T color={c.mute}>{director ? t('inc.subtitle') : t('inc.subtitle_staff')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{tabs.map(([k, label]) => <Chip key={k} label={label} active={tab === k} onPress={() => setTab(k)} />)}</View>
      {tab === 'overview' ? <Overview o={o} openSession={(id) => { setPick(id); setTab('session'); }} /> : null}
      {tab === 'session' ? <SessionReadiness o={o} initial={pick} /> : null}
      {tab === 'assess' ? <AdaptedAssessments o={o} toast={toast} /> : null}
      {tab === 'programmes' ? <ProgrammeSetup o={o} toast={toast} /> : null}
      {tab === 'guardian_progress' ? <GuardianProgress o={o} athleteId={athleteId} /> : null}
    </View>
  );
}

function Overview({ o, openSession }) {
  const { tablet } = useLayout();
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/inclusion`), [o.id]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const v = d.data;
  const rows = TYPES.map((k) => ({ label: typeLabel(k), value: v.by_type[k] ?? 0, text: v.by_type[k] == null ? t('inc.withheld') : String(v.by_type[k]) }));
  const empty = !v.adaptive_programmes.length && v.athletes_with_shares == null && !v.sessions_checked;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('inc.k_athletes')} value={v.athletes_with_shares ?? '–'} sub={v.athletes_with_shares == null ? t('inc.k_withheld', { n: v.min_group }) : undefined} />
        <Kpi label={t('inc.k_ready')} value={pc(v.sessions_ready_pct)} sub={t('inc.k_checked', { n: v.sessions_checked })} />
        <Kpi label={t('inc.k_gaps')} value={v.sessions_attention.length} tone={v.sessions_attention.length ? 'alert' : undefined} />
        <Kpi label={t('inc.k_expiring')} value={v.expiring_30d ?? '–'} />
        <Kpi label={t('inc.k_class_due')} value={v.classifications_due_90d ?? '–'} />
      </View>
      {empty ? <Card><Empty emoji="🤝" title={t('inc.empty_title')} sub={t('inc.empty_sub')} /></Card> : null}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
        <Card style={{ flex: 1.2, width: tablet ? undefined : '100%' }}>
          <Block title={t('inc.attention_title', { n: v.sessions_attention.length })}>
            {v.sessions_attention.length ? v.sessions_attention.map((s) => (
              <Row key={s.session_id} left={<Tag label={s.level === 'gap' ? t('inc.state_gap') : t('inc.state_short')} color={s.level === 'gap' ? c.orange : c.sun} />} title={s.title} sub={`${dayText(s.starts_at)} · ${t('inc.open_n', { n: s.open.length })}`} onPress={() => openSession(s.session_id)} />
            )) : <T color={c.mute}>{t('inc.attention_none')}</T>}
          </Block>
        </Card>
        <View style={{ flex: 1, width: tablet ? undefined : '100%', gap: 12 }}>
          <Card><Block title={t('inc.types_title')}><Bars label={t('inc.types_title')} rows={rows} /><T size={12} color={c.mute}>{t('inc.counts_only', { n: v.min_group })}</T></Block></Card>
          <Card>
            <Block title={t('inc.programmes_title')}>
              {v.adaptive_programmes.length ? v.adaptive_programmes.map((p) => <Row key={p.id} title={p.title} sub={`${modeLabel(p.eligibility_mode)} · v${p.version}`} />) : <T color={c.mute}>{t('inc.programmes_none')}</T>}
            </Block>
          </Card>
        </View>
      </View>
    </View>
  );
}

function SessionReadiness({ o, initial }) {
  const [sid, setSid] = useState(initial);
  const list = useLoad(() => { const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10); return api.get(`/organisations/${o.id}/academy/sessions`, { from, to, status: 'published' }); }, [o.id]);
  const sessions = (Array.isArray(list.data) ? list.data : list.data?.items ?? []);
  const options = sessions.map((s) => ({ value: s.id, label: `${s.title} · ${dayText(s.starts_at)}` }));
  const r = useLoad(() => (sid ? api.get(`/academy/sessions/${sid}/readiness`).catch((e) => ({ error: e })) : Promise.resolve(null)), [sid]);
  const sh = useLoad(() => (sid ? api.get(`/academy/sessions/${sid}/accommodations`).catch(() => null) : Promise.resolve(null)), [sid]);
  const sm = useLoad(() => (sid ? api.get(`/academy/sessions/${sid}/staff-match`).catch(() => null) : Promise.resolve(null)), [sid]);
  const MATCH_TONE = { full: c.lime, partial: c.sun, none: c.line };
  if (list.error) return <LoadError error={list.error} onRetry={list.reload} />;
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('inc.pick_session')} value={sid} onChange={setSid} options={options} placeholder={t('inc.pick_session_ph')} />
      {!sid ? <Card><Empty emoji="🗓️" title={t('inc.session_empty_title')} sub={t('inc.session_empty_sub')} /></Card> : null}
      {sid && !r.data && !r.error ? <Loading /> : null}
      {r.data?.error ? <LoadError error={r.data.error} onRetry={r.reload} /> : null}
      {r.data && !r.data.error ? (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('inc.k_enrolled')} value={r.data.enrolled} />
            <Kpi label={t('inc.k_with_needs')} value={r.data.athletes_with_needs} />
            <Kpi label={t('inc.k_status')} value={t(`inc.level_${r.data.level}`)} tone={r.data.level === 'gap' ? 'alert' : undefined} />
          </View>
          <Card>
            <Block title={t('inc.req_title')}>
              {r.data.requirements.length ? r.data.requirements.map((x) => <Row key={x.code} left={<Tag label={t(`inc.state_${x.state}`)} color={STATE_TONE[x.state]} />} title={reqLabel(x)} sub={x.kind === 'equipment' ? t('inc.equipment_hint') : x.kind === 'venue_feature' && !x.venue_booked ? t('inc.no_venue') : undefined} />) : <T color={c.mute}>{t('inc.req_none')}</T>}
            </Block>
          </Card>
          {sm.data?.staff?.length ? (
            <Card>
              <Block title={t('incops.session_staff_match')}>
                <T size={12} color={c.mute}>{t('incops.consented_access_note')}</T>
                {sm.data.staff.map((p) => (
                  <Row key={p.user_id} left={<Tag label={t(`incops.staff_match_${p.match_state}`)} color={MATCH_TONE[p.match_state]} />} title={p.name} sub={p.expertise.join(' · ') || '—'} />
                ))}
              </Block>
            </Card>
          ) : null}
          <Card>
            <Block title={t('inc.you_see_title')}>
              <T size={12} color={c.mute}>{t('inc.you_see_note')}</T>
              {sh.data?.athletes?.length ? sh.data.athletes.map((a) => (
                <Row key={a.athlete_id} left={<Initials name={a.athlete_name} user={{ avatar_emoji: null }} size={34} />} title={a.athlete_name} sub={`${a.needs.map((n) => needLabel(n.key)).join(' · ')}${a.notes.length ? ` — ${a.notes.join('; ')}` : ''}`} right={<Tag label={t('inc.shared')} color={c.cyan} />} />
              )) : <T color={c.mute}>{t('inc.you_see_none')}</T>}
            </Block>
          </Card>
        </View>
      ) : null}
    </View>
  );
}

function GuardianProgress({ o, athleteId }) {
  const { tablet } = useLayout();
  const d = useLoad(() => (athleteId ? api.get(`/organisations/${o.id}/academy/inclusion/guardian-progress`, { athlete_id: athleteId }) : Promise.resolve(null)), [o.id, athleteId]);
  if (!athleteId) return <View style={{ gap: 12 }}><Card><Empty emoji="👤" title={t('incops.guardian_progress_title')} sub={t('incops.guardian_progress_programme')} /></Card></View>;
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const v = d.data;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('incops.guardian_progress_programme')} value={v.programme?.title ?? '–'} sub={v.cohort?.name} />
        <Kpi label={t('incops.guardian_progress_attendance')} value={v.attendance.rate_pct != null ? `${v.attendance.rate_pct}%` : '–'} sub={`${v.attendance.present}/${v.attendance.held} ${t('incops.guardian_progress_assessments_note')}`} />
        {v.billing.outstanding_minor > 0 ? <Kpi label={t('incops.guardian_progress_credits')} value={`${(v.billing.outstanding_minor / 100).toFixed(2)} ${v.billing.currency ?? ''}`} tone="alert" /> : null}
      </View>
      {v.milestones.length ? (
        <Card>
          <Block title={t('incops.guardian_progress_assessments')}>
            {v.milestones.map((m, i) => (
              <Row key={i} left={<Tag label={t('incops.milestone_achieved')} color={c.lime} />} title={m.descriptor} sub={m.level_key} right={<T size={11} color={c.mute}>{dayText(m.achieved_at)}</T>} />
            ))}
          </Block>
        </Card>
      ) : null}
      {v.upcoming_sessions.length ? (
        <Card>
          <Block title={t('incops.guardian_progress_upcoming')}>
            {v.upcoming_sessions.map((s) => <Row key={s.session_id} title={s.title} sub={dayText(s.starts_at)} />)}
          </Block>
        </Card>
      ) : null}
      <Card>
        <Block title={t('incops.guardian_progress_accommodations')}>
          <T size={13} color={c.mute}>{v.accommodations_shared ? `${v.accommodation_count} ${t('incops.enrolment_prompt_already_shared')}` : t('incops.enrolment_prompt_body')}</T>
          <T size={11} color={c.mute}>{t('incops.enrolment_prompt_privacy')}</T>
        </Block>
      </Card>
    </View>
  );
}

function ProgrammeSetup({ o, toast }) {
  const [pid, setPid] = useState(null), [edit, setEdit] = useState(false);
  const cat = useLoad(() => api.get('/academy/inclusion/catalogue'), []);
  const progs = useLoad(() => api.get(`/organisations/${o.id}/academy/programmes`), [o.id]);
  const cur = useLoad(() => (pid ? api.get(`/academy/programmes/${pid}/inclusion`) : Promise.resolve(null)), [pid]);
  if (progs.error) return <LoadError error={progs.error} onRetry={progs.reload} />;
  if (!progs.data || !cat.data) return <Loading />;
  const list = Array.isArray(progs.data) ? progs.data : progs.data.items ?? [];
  const C = cat.data, p = cur.data;
  const unionNeeds = (keys) => [...new Set(keys.flatMap((k) => C.sport_templates.find((x) => x.key === k)?.needs ?? []))];
  const fields = [
    { key: 'eligibility_mode', label: t('inc.f_mode'), type: 'chips', options: C.eligibility_modes.map((m) => ({ value: m, label: modeLabel(m) })) },
    { key: 'sport_templates', label: t('inc.f_templates'), type: 'multimenu', options: C.sport_templates.map((x) => ({ value: x.key, label: `${templateLabel(x.key)}${x.fallback ? ` (${t('inc.fallback')})` : ''}` })), hint: t('inc.f_templates_hint') },
    { key: 'class_schemes', label: t('inc.f_schemes'), type: 'multimenu', options: C.class_schemes.map((k) => ({ value: k, label: schemeLabel(k) })), hint: t('inc.f_schemes_hint') },
    { key: 'offered_needs', label: t('inc.f_offered'), type: 'multimenu', options: Object.entries(C.need_types).flatMap(([ty, ks]) => ks.map((k) => ({ value: k, label: `${typeLabel(ty)} · ${needLabel(k)}` }))), hint: t('inc.f_offered_hint') },
    { key: 'venue_features', label: t('inc.f_features'), type: 'multimenu', options: C.venue_features.map((k) => ({ value: k, label: featureLabel(k) })) },
    { key: 'staff_credential', label: t('inc.f_credential'), optional: true },
    { key: 'support_ratio', label: t('inc.f_ratio'), type: 'stepper', min: 0, max: 20, default: 0 },
    { key: 'pathway_variants', label: t('inc.f_variants'), type: 'multimenu', options: C.pathway_variants.map((k) => ({ value: k, label: variantLabel(k) })) },
  ];
  const save = async (v) => {
    const sports = v.sport_templates ?? [];
    const body = { row_version: p.row_version, eligibility_mode: v.eligibility_mode, class_schemes: v.class_schemes ?? [], sport_templates: sports, offered_needs: v.offered_needs?.length ? v.offered_needs : unionNeeds(sports),
      requirements: { venue_features: v.venue_features ?? [], ...(v.staff_credential ? { staff_credential: v.staff_credential } : {}), ...(v.support_ratio ? { support_ratio: v.support_ratio } : {}), duty_cover: p.requirements?.duty_cover ?? [] }, pathway_variants: v.pathway_variants?.length ? v.pathway_variants : ['standard'] };
    try { await api.patch(`/academy/programmes/${pid}/inclusion`, body); toast(t('inc.saved')); setEdit(false); cur.reload(); } catch (e) { throw new Error(explain(e)); }
  };
  return (
    <View style={{ gap: 12 }}>
      <MenuField label={t('inc.pick_programme')} value={pid} onChange={setPid} options={list.map((x) => ({ value: x.id, label: x.title }))} placeholder={t('inc.pick_programme_ph')} />
      {!list.length ? <Card><Empty emoji="🏅" title={t('inc.no_programmes_title')} sub={t('inc.no_programmes_sub')} /></Card> : null}
      {pid && !p ? <Loading /> : null}
      {p ? (
        <Card>
          <Block title={t('inc.setup_title')} right={<Btn small title={t('inc.edit')} onPress={() => setEdit(true)} accessibilityLabel={t('inc.edit_a11y')} />}>
            <Row title={t('inc.f_mode')} sub={modeLabel(p.eligibility_mode)} />
            <Row title={t('inc.f_templates')} sub={p.sport_templates.length ? p.sport_templates.map((k) => `${templateLabel(k)}${C.sport_templates.find((x) => x.key === k)?.fallback ? ` (${t('inc.fallback')})` : ''}`).join(' · ') : t('inc.none_set')} />
            <Row title={t('inc.f_offered')} sub={p.offered_needs.length ? p.offered_needs.map(needLabel).join(' · ') : t('inc.none_set')} />
            <Row title={t('inc.f_features')} sub={p.requirements?.venue_features?.length ? p.requirements.venue_features.map(featureLabel).join(' · ') : t('inc.none_set')} />
            <Row title={t('inc.f_variants')} sub={p.pathway_variants.map(variantLabel).join(' · ')} />
            <T size={12} color={c.mute}>{t('inc.no_diagnosis')}</T>
          </Block>
        </Card>
      ) : null}
      {p ? <FormSheet visible={edit} onClose={() => setEdit(false)} title={t('inc.setup_title')} fields={fields} onSubmit={save}
        initial={{ eligibility_mode: p.eligibility_mode, sport_templates: p.sport_templates, class_schemes: p.class_schemes, offered_needs: p.offered_needs, venue_features: p.requirements?.venue_features ?? [], staff_credential: p.requirements?.staff_credential, support_ratio: p.requirements?.support_ratio ?? 0, pathway_variants: p.pathway_variants }} /> : null}
    </View>
  );
}
