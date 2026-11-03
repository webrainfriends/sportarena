// Official verification, requester side (#479): an organiser, official or academy that holds the platform-reports plan asks for a verified statement of a person's standing.
// The answer is an attestation (eligible / not eligible as of a date, with an expiry): never the reason. Used in the Event console's Discipline tab.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useDo } from './console-utils';
import { A, ABtn, ACard, AEmpty, ARow, ASection, AT, ATag } from '../arena';
import { FormSheet } from '../FormSheet';
import { ErrorBox, Loading } from '../ui';
import { explain } from '../access';
import { t } from '../i18n';
import { locale } from '../locale';

const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const PURPOSES = ['event_entry', 'tournament_selection', 'academy_admission', 'official_appointment', 'other'];
export const RESULT_TONE = { eligible: A.green, not_eligible: A.red, unable_to_verify: A.sun };

export function VerificationPanel({ competitionId }) {
  const r = useLoad(() => api.get('/me/official-verifications', { limit: 50 }), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const act = useDo(r.reload);
  const [form, setForm] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <>
      <ACard tone={A.violet}>
        <AT size={15} weight="900">{t('ver.title')}</AT>
        <AT size={13} weight="600" color={A.mute} style={{ marginTop: 4 }}>{t('ver.sub')}</AT>
        <ABtn small title={t('ver.request')} onPress={() => { setErr(null); setForm(true); }} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
      </ACard>
      <ASection title={t('ver.mine')} />
      {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (r.data ?? []).length ? r.data.map((x) => (
        <ARow key={x.id} title={[x.request_no, x.subject_name].join(' · ')} sub={[x.sport_name, t(`ver.purpose.${x.purpose}`)].join(' · ')}
          right={x.result ? <><ATag label={t(`ver.result.${x.result}`)} tone={RESULT_TONE[x.result]} /><AT size={11.5} weight="700" color={A.mute}>{x.valid && !x.revoked ? t('ver.valid_until', { date: day(x.valid_until) }) : t('ver.not_valid')}</AT></>
            : <><ATag label={t(`ver.state.${x.status}`)} />{['submitted', 'in_review'].includes(x.status) ? <ABtn small tone="ghost" title={t('ver.withdraw')} onPress={() => act(() => api.post(`/official-verifications/${x.id}/withdraw`, {}), t('disc.updated'))} /> : null}</>} />
      )) : <AEmpty emoji="🪪" title={t('ver.empty')} sub={t('ver.empty_sub')} />}
      <FormSheet visible={form} onClose={() => setForm(false)} title={t('ver.request')} submitLabel={t('ver.request')} notice={err ?? t('ver.notice')} initial={{ purpose: 'tournament_selection' }}
        fields={[
          { key: 'subject_user_id', label: t('disc.f.person'), type: 'entity', entityKind: 'person', noun: t('disc.f.person') },
          { key: 'sport', label: t('ver.f.sport'), type: 'sport' },
          { key: 'purpose', label: t('ver.f.purpose'), type: 'chips', options: PURPOSES.map((v) => ({ value: v, label: t(`ver.purpose.${v}`) })) },
          { key: 'note', label: t('ver.f.note'), type: 'multiline', optional: true },
        ]}
        onSubmit={async (v) => {
          try {
            const sp = (sports.data ?? []).find((x) => x.slug === v.sport);
            if (!sp) throw new Error(t('ver.f.sport'));
            const { sport, ...rest } = v;
            await api.post('/official-verifications', { ...rest, sport_id: sp.id, competition_id: competitionId }); setForm(false); r.reload(); }
          catch (e) { setErr(e.status === 402 ? t('ver.not_entitled') : explain(e)); throw e; }
        }} />
    </>
  );
}
