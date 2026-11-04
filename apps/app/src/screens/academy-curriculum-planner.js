// Forward planner (#782): which objectives each upcoming session of a group should work on, suggested from the phase of the year, what that
// phase prioritises, how far each objective is from its sessions target and its priority. The person reviews and applies; nothing is written
// until then, and each session keeps a frozen snapshot of what it was planned with.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Chip, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { explain } from '../access';
import { dateTimeIn } from '../vtime';
import { Eyebrow, Hero, INT_TONE, Panel, PILLAR_ICON, PILLARS, lbl } from './academy-curriculum-ui';

export function Planner({ o, toast, archived }) {
  const cohorts = useLoad(() => api.get(`/organisations/${o.id}/cohorts`, { limit: 100 }), [o.id]);
  const [cohort, setCohort] = useState(null);
  const [weeks, setWeeks] = useState(4);
  const [off, setOff] = useState({});        // `${session}|${key}` -> true when the person unticks a suggestion
  const cid = cohort ?? cohorts.data?.[0]?.id ?? null;
  const plan = useLoad(() => (cid ? api.get(`/organisations/${o.id}/academy/cohorts/${cid}/objective-plan`, { weeks }) : Promise.resolve(null)), [o.id, cid, weeks]);
  const [busy, setBusy] = useState(false);
  if (cohorts.error) return <ErrorBox error={cohorts.error} onRetry={cohorts.reload} />;
  if (!cohorts.data) return <Loading />;
  if (!cohorts.data.length) return <Panel><Empty emoji="🗓️" title={t('cur.plan.no_groups')} /></Panel>;
  const picked = (plan.data?.sessions ?? []).map((s) => ({ s, keys: s.suggestions.filter((x) => !off[`${s.session_id}|${x.key}`]) }));
  const total = picked.reduce((n, p) => n + p.keys.length, 0), withAny = picked.filter((p) => p.keys.length).length;
  const mix = Object.fromEntries(PILLARS.map((p) => [p, picked.flatMap((x) => x.keys).filter((k) => k.pillar === p).length]));
  const apply = async () => {
    setBusy(true);
    try { await api.post(`/organisations/${o.id}/academy/cohorts/${cid}/objective-plan`, { items: picked.filter((p) => p.keys.length).map((p) => ({ session_id: p.s.session_id, keys: p.keys.map((k) => k.key) })) }); toast(t('cur.plan.applied', { n: withAny })); setOff({}); plan.reload(); }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 14 }}>
      <Hero title={t('cur.plan.title')} sub={t('cur.plan.sub')} stats={[{ label: t('cur.plan.sessions'), value: plan.data?.sessions.length ?? '–' }, { label: t('cur.plan.suggested'), value: total }, ...PILLARS.filter((p) => mix[p]).map((p) => ({ label: t(`cur.pillar.${p}`), value: mix[p] }))]} />
      <Panel>
        <MenuField label={t('cur.f.cohort')} value={cid} onChange={setCohort} options={cohorts.data.map((k) => ({ value: k.id, label: k.name, sub: t('cur.athletes_n', { n: k.enrolled }) }))} />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[2, 4, 8].map((w) => <Chip key={w} label={t('cur.plan.weeks', { n: w })} active={weeks === w} onPress={() => setWeeks(w)} />)}</View>
      </Panel>
      {plan.error ? <ErrorBox error={plan.error} onRetry={plan.reload} /> : !plan.data ? <Loading /> : plan.data.sessions.length ? (
        <>
          {picked.map(({ s, keys }) => (
            <Panel key={s.session_id}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 160 }}><T weight="800" size={15}>{s.title}</T><T size={12} color={c.mute}>{dateTimeIn(s.starts_at, 'UTC')}</T></View>
                {s.phase ? <Tag label={lbl`${s.phase.title} · ${t(`cur.intensity.${s.phase.intensity}`)}`} color={INT_TONE[s.phase.intensity]} /> : <Tag label={t('cur.plan.no_phase')} />}
              </View>
              {s.already.length ? <T size={12} color={c.mute}>✓ {t('cur.plan.already', { n: s.already.length })}</T> : null}
              {s.suggestions.length ? s.suggestions.map((x) => {
                const on = !off[`${s.session_id}|${x.key}`];
                return (
                  <Chip key={x.key} label={lbl`${on ? '✓' : '○'} ${PILLAR_ICON[x.pillar] ?? ''} ${x.title}`} active={on} onPress={() => setOff((m) => ({ ...m, [`${s.session_id}|${x.key}`]: on }))} />
                );
              }) : <T size={12.5} color={c.mute}>{s.already.length ? t('cur.plan.enough') : t('cur.plan.nothing')}</T>}
              {s.suggestions.map((x) => (!off[`${s.session_id}|${x.key}`] ? <T key={x.key} size={11.5} color={c.mute}>{x.title}: {x.reasons.map((r) => t(`cur.reason.${r}`)).join(' · ')} · {t('cur.plan.remaining', { n: x.remaining })}</T> : null))}
            </Panel>
          ))}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Btn title={t('cur.plan.apply', { n: total })} disabled={!total || archived} loading={busy} onPress={apply} /><T size={12} color={c.mute}>{t('cur.plan.apply_help')}</T>
          </View>
        </>
      ) : <Panel><Empty emoji="🗓️" title={t('cur.plan.empty')} sub={t('cur.plan.empty_sub')} /></Panel>}
    </View>
  );
}
