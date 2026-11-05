// PS-03: Athlete accessible contact & arrival preferences.
// Allows athlete/guardian to record preferred contact mode, an alternative contact person,
// arrival instructions, and entry point. Shared only with staff holding a live communication need share.
import React, { useState, useEffect } from 'react';
import { View, Switch, ScrollView } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Btn, Card, Loading, Row, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';

const CONTACT_MODES = [
  { value: 'app', icon: '📱', label: 'inc.cprefs_mode_app', sub: 'inc.cprefs_mode_app_sub' },
  { value: 'email', icon: '✉️', label: 'inc.cprefs_mode_email', sub: 'inc.cprefs_mode_email_sub' },
  { value: 'sms', icon: '💬', label: 'inc.cprefs_mode_sms', sub: 'inc.cprefs_mode_sms_sub' },
  { value: 'bsl_interpreter', icon: '🤲', label: 'inc.cprefs_mode_bsl', sub: 'inc.cprefs_mode_bsl_sub' },
];

export function AccessibleContactPreferences({ route, toast }) {
  const athleteId = route?.params?.athleteId;
  const d = useLoad(() => api.get('/me/contact-preferences', athleteId ? { athlete_id: athleteId } : {}), [athleteId]);
  const [mode, setMode] = useState('app');
  const [editing, setEditing] = useState(false);

  useEffect(() => { if (d.data) setMode(d.data.contact_mode ?? 'app'); }, [d.data]);

  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;

  const fields = [
    { key: 'contact_mode', label: t('inc.cprefs_mode_label'), type: 'menu', options: CONTACT_MODES.map((m) => ({ value: m.value, label: t(m.label) })) },
    { key: 'alt_contact_name', label: t('inc.cprefs_alt_name'), type: 'text', optional: true, maxLength: 100, hint: t('inc.cprefs_alt_name_hint') },
    { key: 'alt_contact_phone', label: t('inc.cprefs_alt_phone'), type: 'phone', optional: true, hint: t('inc.cprefs_alt_phone_hint') },
    { key: 'arrival_instructions', label: t('inc.cprefs_arrival'), type: 'multiline', optional: true, maxLength: 500, hint: t('inc.cprefs_arrival_hint') },
    { key: 'entry_point', label: t('inc.cprefs_entry_point'), type: 'text', optional: true, maxLength: 200, hint: t('inc.cprefs_entry_point_hint') },
  ];

  const save = async (v) => {
    try {
      await api.put('/me/contact-preferences', { ...(athleteId ? { athlete_id: athleteId } : {}), ...v });
      toast(t('inc.cprefs_saved')); setEditing(false); d.reload();
    } catch (e) { throw new Error(explain(e)); }
  };

  return (
    <View style={{ gap: 12 }}>
      {/* hero */}
      <View style={{ background: `linear-gradient(135deg,${c.pink},${c.violet})`, backgroundColor: c.pink, borderRadius: 16, padding: 16, gap: 4 }}>
        <T weight="800" size={18} color="#FFF">{t('inc.cprefs_title')}</T>
        <T size={13} color="rgba(255,255,255,0.82)">{t('inc.cprefs_sub')}</T>
      </View>

      {/* contact mode */}
      <Card>
        <T weight="700" size={15} style={{ marginBottom: 10 }}>{t('inc.cprefs_mode_label')}</T>
        {CONTACT_MODES.map((m) => (
          <Btn key={m.value} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line, gap: 12, backgroundColor: 'transparent' }}
            onPress={() => setMode(m.value)} accessibilityLabel={t(m.label)}>
            <T size={22}>{m.icon}</T>
            <View style={{ flex: 1 }}>
              <T weight="600" size={14}>{t(m.label)}</T>
              <T size={12} color={c.mute}>{t(m.sub)}</T>
            </View>
            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: mode === m.value ? c.pink : c.line, backgroundColor: mode === m.value ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {mode === m.value ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFF' }} /> : null}
            </View>
          </Btn>
        ))}
      </Card>

      {/* stored prefs summary */}
      {d.data.updated_at ? (
        <Card>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('inc.cprefs_stored')}</T>
          {d.data.alt_contact_name ? <Row title={t('inc.cprefs_alt_name')} sub={d.data.alt_contact_name} /> : null}
          {d.data.alt_contact_phone ? <Row title={t('inc.cprefs_alt_phone')} sub={d.data.alt_contact_phone} /> : null}
          {d.data.arrival_instructions ? <Row title={t('inc.cprefs_arrival')} sub={d.data.arrival_instructions} /> : null}
          {d.data.entry_point ? <Row title={t('inc.cprefs_entry_point')} sub={d.data.entry_point} /> : null}
        </Card>
      ) : (
        <Card><T size={13} color={c.mute}>{t('inc.cprefs_none_sub')}</T></Card>
      )}

      <Btn title={t('inc.cprefs_edit')} onPress={() => setEditing(true)} accessibilityLabel={t('inc.cprefs_edit_a11y')} />

      <Card style={{ backgroundColor: c.pinkSoft }}>
        <T size={12} color={c.pink} weight="700">{t('inc.cprefs_privacy_note')}</T>
      </Card>

      <FormSheet visible={editing} onClose={() => setEditing(false)} title={t('inc.cprefs_edit')} fields={fields} submitLabel={t('inc.cprefs_save')} onSubmit={save}
        initial={{ contact_mode: d.data.contact_mode ?? 'app', alt_contact_name: d.data.alt_contact_name, alt_contact_phone: d.data.alt_contact_phone, arrival_instructions: d.data.arrival_instructions, entry_point: d.data.entry_point }} />
    </View>
  );
}
