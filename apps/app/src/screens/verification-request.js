// Official verification, requester side (#479): inside the competition's Discipline tab. An organiser or official who holds the platform-reports plan asks the platform for a
// verified statement of a person's standing; the answer is a result and its dates, never a sanction. The API enforces who may ask and what the answer contains.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, H2, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { explain } from '../access';
import { c } from '../theme';
import { t } from '../i18n';
import { fmtDate } from '../federation-ui';
import { useDo } from './console-utils';

export const PURPOSES = ['event_entry', 'tournament_selection', 'academy_admission', 'official_appointment', 'other'];
const RESULT_TONE = { eligible: c.limeSoft, not_eligible: c.redSoft, unable_to_verify: c.sunSoft };

export function VerificationPanel({ competitionId }) {
  const r = useLoad(() => api.get('/me/official-verifications', { limit: 50 }), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const act = useDo(r.reload);
  const [form, setForm] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <View style={{ gap: 10 }}>
      <Card>
        <H2>{t('ver.title')}</H2>
        <T size={13} color={c.mute}>{t('ver.sub')}</T>
        <Btn small title={t('ver.request')} onPress={() => { setErr(null); setForm(true); }} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
      </Card>
      <H2>{t('ver.mine')}</H2>
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (r.data ?? []).length ? r.data.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <T weight="700" style={{ flex: 1, minWidth: 140 }}>{[x.request_no, x.subject_name].join(' · ')}</T>
            {x.result ? <Tag label={t(`ver.result.${x.result}`)} color={RESULT_TONE[x.result]} /> : <Tag label={t(`ver.state.${x.status}`)} color={c.violetSoft} />}
          </View>
          <T size={13} color={c.mute}>{[x.sport_name, t(`ver.purpose.${x.purpose}`)].join(' · ')}</T>
          {x.result ? <T size={12} color={c.mute}>{x.valid && !x.revoked ? t('ver.valid_until', { date: fmtDate(x.valid_until) }) : t('ver.not_valid')}</T> : null}
          {['submitted', 'in_review'].includes(x.status) ? <Btn small color={c.paper} ink={c.ink} title={t('ver.withdraw')} onPress={() => act(() => api.post(`/official-verifications/${x.id}/withdraw`, {}))} style={{ alignSelf: 'flex-start', marginTop: 6 }} /> : null}
        </Card>
      )) : <Empty emoji="🪪" title={t('ver.empty')} sub={t('ver.empty_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('ver.request')} submitLabel={t('ver.request')} notice={err ?? t('ver.notice')} initial={{ purpose: 'tournament_selection' }}
        fields={[
          { key: 'subject_user_id', label: t('ver.f.person'), type: 'entity', entityKind: 'person', noun: t('ver.f.person') },
          { key: 'sport', label: t('ver.f.sport'), type: 'sport' },
          { key: 'purpose', label: t('ver.f.purpose'), type: 'chips', options: PURPOSES.map((v) => ({ value: v, label: t(`ver.purpose.${v}`) })) },
          { key: 'note', label: t('ver.f.note'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          try {
            const sp = (sports.data ?? []).find((x) => x.slug === v.sport);
            if (!sp) throw new Error(t('ver.f.sport'));
            const { sport, ...rest } = v;
            await api.post('/official-verifications', { ...rest, sport_id: sp.id, competition_id: competitionId });
            setForm(false); r.reload();
          } catch (e) { setErr(e.status === 402 ? t('ver.not_entitled') : explain(e)); throw e; }
        }} />
    </View>
  );
}
