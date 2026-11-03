// Official verifier desk (#479): the only thing an Official verifier sees. Requests for an official verification of a person's standing wait here; the verifier claims one and
// issues the attestation. The server reads the standing itself: the desk shows who asked and why, never a sanction, a reason or evidence.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, H1, Loading, Screen, Section, T, Tag, Chip } from '../ui';
import { Banner, Metric, fmtDate } from '../federation-ui';
import { LoadError, explain } from '../access';
import { c } from '../theme';
import { t } from '../i18n';

export function VerifierDesk() {
  const { toast } = useSession();
  const [status, setStatus] = useState('submitted');
  const q = useLoad(() => api.get('/verifier/queue', { status, limit: 100 }), [status]);
  const [busy, setBusy] = useState(null);
  const run = async (id, fn, msg) => { setBusy(id); try { await fn(); toast(msg); q.reload(); } catch (e) { toast(explain(e)); } finally { setBusy(null); } };
  if (q.error && !q.data) return <Screen><H1>{t('ver.desk.title')}</H1><LoadError error={q.error} onRetry={q.reload} /></Screen>;
  if (!q.data) return <Screen><Loading /></Screen>;
  return (
    <Screen wide refreshing={q.loading} onRefresh={q.reload}>
      <H1>{t('ver.desk.title')}</H1>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('ver.desk.sub')}</T>
      <View style={{ marginTop: 10 }}><Banner>{t('ver.desk.rule')}</Banner></View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {['submitted', 'in_review', 'decided'].map((s) => <Chip key={s} label={t(`ver.state.${s}`)} active={status === s} onPress={() => setStatus(s)} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}><Metric value={q.data.length} label={t(`ver.state.${status}`)} /></View>
      {q.data.length ? q.data.map((x) => (
        <Section key={x.id} title={[x.request_no, x.subject_name].join(' · ')} color={c.violet}>
          <T size={13} color={c.mute}>{[x.sport_name, t(`ver.purpose.${x.purpose}`), x.competition_name ?? x.organisation_name].filter(Boolean).join(' · ')}</T>
          <T size={13} color={c.mute}>{t('ver.desk.asked_by', { name: x.requester_name, date: fmtDate(x.created_at) })}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {x.status === 'submitted' ? <Btn small title={t('ver.desk.claim')} color={c.violet} loading={busy === x.id} onPress={() => run(x.id, () => api.post(`/verifier/requests/${x.id}/claim`, {}), t('ver.desk.claimed'))} accessibilityLabel={t('ver.desk.claim')} /> : null}
            {x.status === 'in_review' && x.mine ? <>
              <Btn small title={t('ver.desk.issue')} color={c.mint} ink={c.ink} loading={busy === x.id} onPress={() => run(x.id, () => api.post(`/verifier/requests/${x.id}/decision`, {}), t('ver.desk.issued'))} accessibilityLabel={t('ver.desk.issue')} />
              <Btn small title={t('ver.desk.unable')} color={c.paper} ink={c.ink} onPress={() => run(x.id, () => api.post(`/verifier/requests/${x.id}/decision`, { unable_to_verify: true }), t('ver.desk.issued'))} accessibilityLabel={t('ver.desk.unable')} />
            </> : null}
            {x.status === 'decided' ? <Tag label={t('ver.state.decided')} color={c.mint} /> : null}
          </View>
        </Section>
      )) : <View style={{ marginTop: 16 }}><Empty emoji="🪪" title={t('ver.desk.empty')} sub={t('ver.desk.empty_sub')} /></View>}
    </Screen>
  );
}
