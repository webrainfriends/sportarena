// My discipline (#479): the person's own disciplinary matters (and a young person's, for a verified guardian): what is alleged, what was decided, how many matches are left to
// serve and the appeal window. Strictly private: nothing here is on a public profile, roster or export.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Card, Empty, H1, Loading, Screen, Section, T, Tag, Btn } from '../ui';
import { Banner, Metric, fmtDate } from '../federation-ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c } from '../theme';
import { t } from '../i18n';

export function MyDiscipline() {
  const { toast } = useSession();
  const r = useLoad(() => api.get('/me/discipline'), []);
  const [appeal, setAppeal] = useState(null);
  if (r.error && !r.data) return <Screen><H1>{t('disc.my.title')}</H1><LoadError error={r.error} onRetry={r.reload} /></Screen>;
  if (!r.data) return <Screen><Loading /></Screen>;
  const rows = r.data;
  const open = rows.filter((k) => ['opened', 'under_review'].includes(k.status)).length;
  const serving = rows.reduce((n, k) => n + k.sanctions.filter((s) => s.service?.remaining > 0).length, 0);
  return (
    <Screen wide refreshing={r.loading} onRefresh={r.reload}>
      <H1>{t('disc.my.title')}</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('disc.my.sub')}</T>
      <View style={{ marginTop: 10 }}><Banner>{t('disc.notfinding')}</Banner></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        <Metric value={rows.length} label={t('disc.my.matters')} />
        <Metric value={open} label={t('disc.m.open')} />
        <Metric value={serving} label={t('disc.my.serving')} tone={serving ? c.pinkSoft : undefined} />
      </View>
      {rows.length ? rows.map((k) => (
        <Section key={k.id} title={[k.case_no, k.competition_name].join(' · ')} color={c.violet}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Tag label={t(`disc.state.${k.status}`)} color={c.violet} />
            <Tag label={t(`disc.cat.${k.category}`)} color={c.cyan} />
            {k.interim_status !== 'none' ? <Tag label={t(`disc.interim_s.${k.interim_status}`)} color={c.pink} /> : null}
          </View>
          {k.sanctions.map((s) => (
            <Card key={s.id} style={{ marginTop: 8 }}>
              <T weight="900">{s.label || t(`disc.sanction.${s.kind}`)}</T>
              {s.service ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('disc.served', { served: s.service.served, matches: s.service.matches, remaining: s.service.remaining })}</T> : null}
              {s.effective_to ? <T size={13} color={c.mute}>{t('disc.until', { date: fmtDate(s.effective_to) })}</T> : null}
            </Card>
          ))}
          {k.appeal_deadline && k.status === 'decided' ? (
            <Btn small title={t('disc.my.appeal', { date: fmtDate(k.appeal_deadline) })} color={c.violet} onPress={() => setAppeal(k.id)} style={{ marginTop: 10, alignSelf: 'flex-start' }} accessibilityLabel={t('disc.my.appeal', { date: fmtDate(k.appeal_deadline) })} />
          ) : null}
        </Section>
      )) : <View style={{ marginTop: 16 }}><Empty emoji="🕊️" title={t('disc.my.empty')} sub={t('disc.my.empty_sub')} /></View>}
      <FormSheet visible={!!appeal} onClose={() => setAppeal(null)} title={t('disc.appeal.title')} submitLabel={t('disc.appeal.submit')} color={c.violet} notice={t('disc.appeal.notice')}
        fields={[{ key: 'grounds', label: t('disc.appeal.grounds'), type: 'multiline', hint: t('disc.appeal.grounds_hint') }]}
        onSubmit={async (v) => { await api.post(`/discipline/cases/${appeal}/appeals`, v); setAppeal(null); toast(t('disc.appeal.done')); r.reload(); }} />
    </Screen>
  );
}
