// PS-03: Athlete/guardian support preferences hub — extends #808 inclusion-family.
// Shows all active accommodation shares grouped by context (academy / event), allows adding,
// editing and revoking shares, and links to contact preferences and full history.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { Kpi } from './academy-ui';
import { needLabel, typeLabel, dayText } from './academy-inclusion';

const TONE = { active: c.lime, lapsed: c.sun, revoked: c.orange };
const CTX_TAG = { event: c.cyan };

const PURPOSE_OPTIONS = [
  { value: 'competition_day', label: t('inc.purpose_competition_day') },
  { value: 'training_session', label: t('inc.purpose_training_session') },
  { value: 'transport', label: t('inc.purpose_transport') },
  { value: 'arrival', label: t('inc.purpose_arrival') },
  { value: 'other', label: t('inc.purpose_other') },
];

export function SupportPreferences({ athleteId, toast, navigation }) {
  const wb = useLoad(() => api.get('/me/wellbeing', athleteId ? { athlete_id: athleteId } : undefined), [athleteId]);
  const [orgId, setOrgId] = useState(null);
  if (wb.error) return <LoadError error={wb.error} onRetry={wb.reload} />;
  if (!wb.data) return <Loading />;
  const academies = wb.data.academies ?? [];
  if (!academies.length) return <Card><Empty emoji="🤝" title={t('inc.f_empty_title')} sub={t('inc.sp_no_academy_sub')} /></Card>;
  const oid = orgId ?? academies[0].organisation.id;
  return (
    <View style={{ gap: 12 }}>
      <View>
        <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('inc.sp_title')}</T>
        <T color={c.mute}>{t('inc.sp_sub')}</T>
      </View>
      {academies.length > 1 ? (
        <MenuField label={t('inc.f_academy')} value={oid} onChange={setOrgId} options={academies.map((a) => ({ value: a.organisation.id, label: a.organisation.name }))} />
      ) : null}
      <ShareHub key={oid} orgId={oid} athleteId={athleteId} toast={toast} navigation={navigation} />
    </View>
  );
}

function ShareHub({ orgId, athleteId, toast, navigation }) {
  const [adding, setAdding] = useState(false);
  const [editShare, setEditShare] = useState(null);
  const [tab, setTab] = useState('all');
  const cat = useLoad(() => api.get('/academy/inclusion/catalogue'), []);
  const d = useLoad(() => api.get('/me/accommodations', { organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}) }), [orgId, athleteId]);
  const staff = useLoad(() => api.get('/me/accommodations/audience', { organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}) }).catch(() => []), [orgId, athleteId]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data || !cat.data) return <Loading />;

  const revoke = async (s) => {
    try { await api.post(`/accommodations/${s.id}/revoke`, {}); toast(t('inc.f_revoked')); d.reload(); } catch (e) { toast(explain(e)); }
  };
  const people = (Array.isArray(staff.data) ? staff.data : []).map((m) => ({ value: m.user_id, label: `${m.display_name} · ${m.role}` }));

  const needOptions = Object.entries(cat.data.need_types).flatMap(([ty, ks]) => ks.map((k) => ({ value: k, label: `${typeLabel(ty)} · ${needLabel(k)}` })));
  const roleOptions = [
    { value: 'coach', label: t('inc.role_coach') },
    { value: 'venue', label: t('inc.role_venue') },
    { value: 'event_staff', label: t('inc.role_event_staff') },
  ];
  const contextOptions = [{ value: 'academy', label: t('inc.ctx_academy') }, { value: 'event', label: t('inc.ctx_event') }];

  const addFields = [
    { key: 'context', label: t('inc.sp_context'), type: 'menu', options: contextOptions, hint: t('inc.sp_context_hint') },
    { key: 'purpose_key', label: t('inc.sp_purpose'), type: 'menu', options: PURPOSE_OPTIONS, optional: true },
    { key: 'need_keys', label: t('inc.f_needs'), type: 'multimenu', options: needOptions, hint: t('inc.f_needs_hint') },
    { key: 'audience_roles', label: t('inc.f_roles'), type: 'multi', optional: true, options: roleOptions },
    { key: 'audience_user_ids', label: t('inc.f_people'), type: 'multimenu', options: people, optional: true },
    { key: 'expires_on', label: t('inc.f_expires'), type: 'date', hint: t('inc.f_expires_hint') },
    { key: 'note', label: t('inc.f_note'), type: 'multiline', optional: true, maxLength: 300, hint: t('inc.f_note_hint') },
  ];

  const editFields = addFields.map((f) => ({ ...f, key: f.key }));

  const submitAdd = async (v) => {
    try {
      await api.post('/me/accommodations', {
        organisation_id: orgId, ...(athleteId ? { athlete_id: athleteId } : {}),
        need_keys: v.need_keys, audience_roles: v.audience_roles ?? [], audience_user_ids: v.audience_user_ids ?? [],
        expires_on: v.expires_on, context: v.context ?? 'academy', purpose_key: v.purpose_key || undefined,
        ...(v.note ? { note: v.note } : {}),
      });
      toast(t('inc.f_shared')); setAdding(false); d.reload();
    } catch (e) { throw new Error(explain(e)); }
  };

  const submitEdit = async (v) => {
    try {
      await api.patch(`/accommodations/${editShare.id}`, {
        need_keys: v.need_keys, audience_roles: v.audience_roles ?? [], audience_user_ids: v.audience_user_ids ?? [],
        expires_on: v.expires_on, purpose_key: v.purpose_key || undefined, ...(v.note ? { note: v.note } : {}),
      });
      toast(t('inc.sp_updated')); setEditShare(null); d.reload();
    } catch (e) { throw new Error(explain(e)); }
  };

  const shares = d.data.shares ?? [];
  const filtered = tab === 'all' ? shares : shares.filter((s) => (tab === 'event' ? s.context === 'event' : s.context !== 'event'));
  const activeCount = shares.filter((s) => s.status === 'active').length;
  const expiringCount = shares.filter((s) => s.status === 'active' && new Date(s.expires_at) < new Date(Date.now() + 30 * 864e5)).length;
  const eventCount = shares.filter((s) => s.context === 'event' && s.status === 'active').length;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Kpi label={t('inc.f_k_active')} value={activeCount} />
        <Kpi label={t('inc.f_k_expiring')} value={expiringCount} />
        <Kpi label={t('inc.sp_k_event')} value={eventCount} />
      </View>

      {/* context tabs */}
      <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderRadius: 999, padding: 4, gap: 4 }}>
        {['all', 'academy', 'event'].map((tk) => (
          <Btn key={tk} small title={t(`inc.sp_tab_${tk}`)} onPress={() => setTab(tk)}
            color={tab === tk ? c.pink : undefined}
            style={{ flex: 1, borderRadius: 999 }}
            accessibilityLabel={t(`inc.sp_tab_${tk}_a11y`)} />
        ))}
      </View>

      <Btn title={t('inc.f_share')} onPress={() => setAdding(true)} accessibilityLabel={t('inc.f_share_a11y')} />

      {!filtered.length ? (
        <Card><Empty emoji="🤝" title={t('inc.f_none_title')} sub={tab === 'event' ? t('inc.sp_none_event_sub') : t('inc.f_none_sub')} /></Card>
      ) : filtered.map((s) => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T weight="700" size={15}>{s.needs.map((n) => needLabel(n.key)).join(' · ')}</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                {s.context === 'event' ? <Tag small label={t('inc.ctx_event')} color={c.cyan} /> : null}
                {s.purpose_key ? <T size={12} color={c.mute}>{t(`inc.purpose_${s.purpose_key}`)}</T> : null}
              </View>
              <T size={13} color={c.mute}>{t('inc.f_until', { date: dayText(s.expires_at) })} · {t('inc.f_viewed', { n: s.viewed_count })}</T>
            </View>
            <Tag label={t(`inc.status_${s.status}`)} color={TONE[s.status]} />
          </View>
          {s.status === 'active' ? (
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <Btn small title={t('inc.sp_edit')} color={c.mute} onPress={() => setEditShare(s)} accessibilityLabel={t('inc.sp_edit_a11y', { needs: s.needs.map((n) => needLabel(n.key)).join(', ') })} />
              <Btn small title={t('inc.f_revoke')} color={c.orange} onPress={() => revoke(s)} accessibilityLabel={t('inc.f_revoke_a11y')} />
            </View>
          ) : null}
        </Card>
      ))}

      {/* access log */}
      {d.data.log?.length ? (
        <Card>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('inc.f_log')}</T>
          {d.data.log.slice(0, 5).map((e, idx) => (
            <Row key={idx} title={t(`inc.ev_${e.kind}`)} sub={dayText(e.created_at)} />
          ))}
        </Card>
      ) : null}

      {/* footer quick links */}
      <Card style={{ padding: 0 }}>
        <Btn style={{ padding: 14 }} title={t('inc.sp_contact_prefs')} onPress={() => navigation?.navigate('AccessibleContactPreferences', { athleteId })} />
        <Btn style={{ padding: 14, borderTopWidth: 1, borderTopColor: c.line }} title={t('inc.sp_history')} onPress={() => navigation?.navigate('AccommodationHistory', { athleteId })} />
      </Card>

      <FormSheet visible={adding} onClose={() => setAdding(false)} title={t('inc.f_share')} fields={addFields} submitLabel={t('inc.f_share_submit')} onSubmit={submitAdd} initial={{ audience_roles: ['coach'], context: 'academy' }} />
      {editShare ? (
        <FormSheet visible={!!editShare} onClose={() => setEditShare(null)} title={t('inc.sp_edit_title')} fields={editFields} submitLabel={t('inc.sp_edit_submit')} onSubmit={submitEdit}
          initial={{ need_keys: editShare.needs.map((n) => n.key), audience_roles: editShare.audience_roles, audience_user_ids: editShare.audience_user_ids, expires_on: editShare.expires_at?.slice(0, 10), purpose_key: editShare.purpose_key, context: editShare.context }}
        />
      ) : null}
    </View>
  );
}
