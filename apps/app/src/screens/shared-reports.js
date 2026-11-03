// What an organisation's owners and admins read: performance reports coaches have shared with their academy, club or sponsor organisation.
// Aggregate only, frozen at the moment the coach published, readable until the coach revokes or the share expires (checked on every read).
import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Screen, T, Tag } from '../ui';
import { saveExport } from '../open-file';
import { ReportSections } from './report-sections';
import { explain } from '../access';
import { t } from '../i18n';
import { c } from '../theme';

export function SharedReports() {
  const { push } = useNav();
  const list = useLoad(() => api.get('/me/shared-coaching-reports'), []);
  return (
    <Screen wide onRefresh={list.reload}>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('rsh.eyebrow').toUpperCase()}</T>
      <H1>{t('rsh.inbox_title')}</H1>
      <T color={c.mute}>{t('rsh.inbox_sub')}</T>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data ? <Loading /> : !list.data.length ? <Empty emoji="📊" title={t('rsh.inbox_empty')} sub={t('rsh.inbox_empty_sub')} /> : (
        <View style={{ gap: 10, marginTop: 12 }}>
          {list.data.map((s) => (
            <Card key={s.id} pad={16} onPress={() => push('SharedReport', { id: s.id })} accessibilityLabel={[s.title, s.organisation_name].join(', ')}>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><Tag label={s.organisation_name} color={c.cyanSoft} /><Tag label={t('rsh.expires_on', { date: s.expires_on.slice(0, 10) })} color={c.violetSoft} /></View>
              <T weight="800" size={17} style={{ marginTop: 6 }}>{s.title}</T>
              <T size={13} color={c.mute}>{[s.subject, `${s.period?.from} – ${s.period?.to}`, s.coach_name].filter(Boolean).join(' · ')}</T>
              {s.note ? <T size={13} style={{ marginTop: 6 }}>“{s.note}”</T> : null}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

export function SharedReport({ id }) {
  const { toast } = useSession();
  const v = useLoad(() => api.get(`/me/shared-coaching-reports/${id}`), [id]);
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  if (!v.data) return <Screen><Loading /></Screen>;
  const s = v.data.snapshot;
  return (
    <Screen wide>
      <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>{t('rsh.eyebrow').toUpperCase()}</T>
      <H1>{s.title}</H1>
      <T color={c.mute}>{t('cs.view_line', { subject: s.subject, from: s.period.from, to: s.period.to, coach: s.coach_name, v: v.data.version })}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginVertical: 10, alignItems: 'center' }}>
        <Tag label={v.data.organisation_name} color={c.cyanSoft} />
        <Tag label={t('rsh.expires_on', { date: v.data.expires_on.slice(0, 10) })} color={c.violetSoft} />
        <Btn small title={t('rsh.pdf')} color={c.paper} ink={c.ink} accessibilityLabel={t('rsh.pdf')} onPress={() => api.get(`/me/shared-coaching-reports/${id}/export`).then(saveExport).then(() => toast(t('rsh.pdf_ready'))).catch((e) => toast(explain(e)))} />
      </View>
      {v.data.note ? <Card pad={12} color={c.violetSoft}><T size={13}>“{v.data.note}”</T></Card> : null}
      <T size={13} color={c.mute} style={{ marginTop: 6 }}>{s.disclosure}</T>
      <ReportSections sections={s.sections} />
    </Screen>
  );
}
