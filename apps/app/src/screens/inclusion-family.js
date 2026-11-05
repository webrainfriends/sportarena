// My accommodations (#808): what an athlete (or the verified guardian of a young person) has chosen to share with the academy, who can see it, until when,
// and the log of every time staff opened it. Sharing is by catalogue choice, never a diagnosis; withdrawing is immediate. All rules are on the server.
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { Block, Kpi } from './academy-ui';
import { needLabel, typeLabel, dayText } from './academy-inclusion';

const TONE = { active: c.lime, lapsed: c.sun, revoked: c.orange };

export function InclusionFamily({ athleteId, toast }) {
  const wb = useLoad(() => api.get('/me/wellbeing', athleteId ? { athlete_id: athleteId } : undefined), [athleteId]);
  const [orgId, setOrgId] = useState(null);
  if (wb.error) return <LoadError error={wb.error} onRetry={wb.reload} />;
  if (!wb.data) return <Loading />;
  const academies = wb.data.academies ?? [];
  if (!academies.length) return <Card><Empty emoji="🤝" title={t('inc.f_empty_title')} sub={t('inc.f_empty_sub')} /></Card>;
  const oid = orgId ?? academies[0].organisation.id;
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('inc.f_title')}</T><T color={c.mute}>{t('inc.f_sub')}</T></View>
      {academies.length > 1 ? <MenuField label={t('inc.f_academy')} value={oid} onChange={setOrgId} options={academies.map((a) => ({ value: a.organisation.id, label: a.organisation.name }))} /> : null}
      <Shares key={oid} orgId={oid} athleteId={athleteId} toast={toast} />
    </View>
  );
}

function Shares({ orgId, athleteId, toast }) {
  const [add, setAdd] = useState(false);
  const cat = useLoad(() => api.get('/academy/inclusion/catalogue'), []);
  const d = useLoad(() => api.get('/me/accommodations', { organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}) }), [orgId, athleteId]);
  const staff = useLoad(() => api.get('/me/accommodations/audience', { organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}) }).catch(() => []), [orgId, athleteId]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data || !cat.data) return <Loading />;
  const revoke = async (s) => { try { await api.post(`/accommodations/${s.id}/revoke`, {}); toast(t('inc.f_revoked')); } catch (e) { toast(explain(e)); } finally { d.reload(); } };
  const people = (Array.isArray(staff.data) ? staff.data : []).map((m) => ({ value: m.user_id, label: `${m.display_name} · ${m.role}` }));
  const fields = [
    { key: 'need_keys', label: t('inc.f_needs'), type: 'multimenu', options: Object.entries(cat.data.need_types).flatMap(([ty, ks]) => ks.map((k) => ({ value: k, label: `${typeLabel(ty)} · ${needLabel(k)}` }))), hint: t('inc.f_needs_hint') },
    { key: 'audience_roles', label: t('inc.f_roles'), type: 'multi', optional: true, options: [{ value: 'coach', label: t('inc.role_coach') }, { value: 'venue', label: t('inc.role_venue') }] },
    { key: 'audience_user_ids', label: t('inc.f_people'), type: 'multimenu', options: people, optional: true },
    { key: 'expires_on', label: t('inc.f_expires'), type: 'date', hint: t('inc.f_expires_hint') },
    { key: 'note', label: t('inc.f_note'), type: 'multiline', optional: true, maxLength: 300, hint: t('inc.f_note_hint') },
  ];
  const submit = async (v) => {
    try { await api.post('/me/accommodations', { organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}), need_keys: v.need_keys, audience_roles: v.audience_roles ?? [], audience_user_ids: v.audience_user_ids ?? [], expires_on: v.expires_on, ...(v.note ? { note: v.note } : {}) }); toast(t('inc.f_shared')); setAdd(false); d.reload(); } catch (e) { throw new Error(explain(e)); }
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Kpi label={t('inc.f_k_active')} value={d.data.active} /><Kpi label={t('inc.f_k_expiring')} value={d.data.expiring_30d} /></View>
      <Btn title={t('inc.f_share')} onPress={() => setAdd(true)} accessibilityLabel={t('inc.f_share_a11y')} />
      {!d.data.shares.length ? <Card><Empty emoji="🤝" title={t('inc.f_none_title')} sub={t('inc.f_none_sub')} /></Card> : d.data.shares.map((s) => (
        <Card key={s.id}>
          <Block title={s.needs.map((n) => needLabel(n.key)).join(' · ')} right={<Tag label={t(`inc.status_${s.status}`)} color={TONE[s.status]} />}>
            <T size={13} color={c.mute}>{t('inc.f_until', { date: dayText(s.expires_at) })} · {t('inc.f_viewed', { n: s.viewed_count })}</T>
            {s.note ? <T size={13}>{s.note}</T> : null}
            {s.status === 'active' ? <Btn small title={t('inc.f_revoke')} color={c.orange} onPress={() => revoke(s)} accessibilityLabel={t('inc.f_revoke_a11y')} /> : null}
          </Block>
        </Card>
      ))}
      {d.data.log.length ? <Card><Block title={t('inc.f_log')}>{d.data.log.slice(0, 10).map((e, i) => <Row key={i} title={t(`inc.ev_${e.kind}`)} sub={dayText(e.created_at)} />)}</Block></Card> : null}
      <FormSheet visible={add} onClose={() => setAdd(false)} title={t('inc.f_share')} fields={fields} submitLabel={t('inc.f_share_submit')} onSubmit={submit} initial={{ audience_roles: ['coach'] }} />
    </View>
  );
}
