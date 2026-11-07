// Wellbeing & development for the athlete and their guardians (#795): what they have chosen to share (revocable at any moment), who the mentor is,
// when the check-ins are and what is open, goals waiting for their agreement, tracks, specialist suggestions waiting for a yes or a no, and the
// log of everything done on the record, including each time a member of staff opened it. A young person acts through a verified guardian.
import { SafeCommunication } from './academy-safeguarding';
import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Empty, Loading, Row, Sheet, T, Tag } from '../ui';
import { c } from '../theme';
import { Block } from './academy-ui';
import { SCOPE_LIST, catLabel, dateTimeText, dayText, eventLabel, outcomeLabel, reasonLabel, scopeHint, scopeLabel, settingLabel, specialtyLabel, statusLabel, topicLabel } from './wellbeing-words';

export function WellbeingFamily({ athleteId, toast }) {
  const d = useLoad(() => api.get('/me/wellbeing', athleteId ? { athlete_id: athleteId } : undefined), [athleteId]);
  if (d.error) return <LoadError error={d.error} onRetry={d.reload} />;
  if (!d.data) return <Loading />;
  const { athlete, acting, academies } = d.data;
  if (!academies.length) return <Card><Empty emoji="💚" title={t('wb.f_empty_title')} sub={t('wb.f_empty_sub')} /></Card>;
  return (
    <View style={{ gap: 14 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('wb.f_title')}</T><T color={c.mute}>{athlete.is_youth ? (acting ? t('wb.f_sub_guardian', { name: athlete.name }) : t('wb.f_sub_youth')) : t('wb.f_sub_adult')}</T></View>
      {academies.map((a) => <AcademyCard key={a.organisation.id} a={a} athlete={athlete} acting={acting} toast={toast} reload={d.reload} />)}
    </View>
  );
}

function AcademyCard({ a, athlete, acting, toast, reload }) {
  const { tablet } = useLayout();
  const [edit, setEdit] = useState(false), [log, setLog] = useState(false);
  const on = a.consent?.scopes ?? [];
  const run = async (fn, ok) => { try { await fn(); toast(ok); reload(); } catch (e) { toast(explain(e)); } };
  const respondGoal = (g, decision) => run(() => api.post(`/me/wellbeing/goals/${g.id}/respond`, { decision }), t('wb.f_answered'));
  const respondRef = (r, decision) => run(() => api.post(`/me/wellbeing/referrals/${r.id}/respond`, { decision }), t('wb.f_answered'));
  const upcoming = a.checkins.filter((k) => k.status === 'scheduled' && new Date(k.scheduled_for) >= new Date()).reverse();
  const past = a.checkins.filter((k) => !upcoming.includes(k)).slice(0, 5);
  const waitingGoals = a.goals.filter((g) => g.status === 'proposed');
  const waitingRefs = a.referrals.filter((r) => r.status === 'proposed');
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><T weight="800" size={17}>{a.organisation.name}</T>{a.consent ? <Tag label={t('wb.f_choices_n', { n: on.length })} color={c.limeSoft} /> : <Tag label={t('wb.f_no_choices')} color={c.sun} />}</View>
      <SafeCommunication o={a.organisation} athleteId={athlete.id} toast={toast} />
      {(waitingGoals.length || waitingRefs.length) && acting ? (
        <Card color={c.sunSoft}><T weight="800">{t('wb.f_attention')}</T><T size={13}>{t('wb.f_attention_sub', { n: waitingGoals.length + waitingRefs.length })}</T></Card>
      ) : null}
      <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, width: tablet ? undefined : '100%', gap: 12 }}>
          <Card>
            <Block title={t('wb.f_choices')} right={acting ? <Btn small title={t('wb.f_change')} onPress={() => setEdit(true)} /> : null}>
              {a.consent ? (
                <>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{on.map((s) => <Tag key={s} label={scopeLabel(s)} color={c.limeSoft} />)}</View>
                  <T size={12} color={c.mute}>{t('wb.f_given_by', { who: a.consent.granted_as === 'guardian' ? t('wb.by_guardian') : t('wb.by_self'), date: dayText(a.consent.granted_at), until: dayText(a.consent.expires_at) })}</T>
                </>
              ) : <T size={13} color={c.mute}>{t('wb.f_none_sub')}</T>}
              <T size={12} color={c.mute}>{acting ? t('wb.f_revocable') : t('wb.f_guardian_decides')}</T>
            </Block>
          </Card>
          <Card>
            <Block title={t('wb.mentor')}>
              {a.mentor ? (
                <Row title={a.mentor.name} sub={`${statusLabel(a.mentor.status)} · ${t('wb.f_rhythm', { n: a.mentor.cadence_days })}${a.mentor.review_on ? ` · ${t('wb.review_by', { date: dayText(a.mentor.review_on) })}` : ''}`} />
              ) : <T size={13} color={c.mute}>{on.includes('mentoring') ? t('wb.f_no_mentor_yet') : t('wb.f_mentor_off')}</T>}
            </Block>
          </Card>
          <Card>
            <Block title={t('wb.tab_checkins')}>
              {upcoming.length ? upcoming.map((k) => <Row key={k.id} title={dateTimeText(k.scheduled_for)} sub={`${t('wb.with', { name: k.mentor_name })} · ${settingLabel(k.setting)}${k.topics?.length ? ` · ${k.topics.map(topicLabel).join(', ')}` : ''}`} right={<Tag label={t('wb.mins', { n: k.duration_min })} />} />) : <T size={13} color={c.mute}>{on.includes('checkins') ? t('wb.f_no_upcoming') : t('wb.f_checkins_off')}</T>}
              {a.follow_ups.length ? <View style={{ gap: 4 }}><T weight="800" size={13}>{t('wb.f_follow_ups')}</T>{a.follow_ups.map((k) => <Row key={k.id} title={k.next_step ?? outcomeLabel(k.outcome)} sub={t('wb.follow_by', { date: dayText(k.follow_up_due) })} right={<Tag label={t('wb.f_open')} color={c.sunSoft} />} />)}</View> : null}
              {past.length ? <View style={{ gap: 4 }}><T weight="800" size={13}>{t('wb.f_past')}</T>{past.map((k) => <Row key={k.id} title={dateTimeText(k.scheduled_for)} sub={`${k.outcome ? `${outcomeLabel(k.outcome)} · ` : ''}${k.next_step ?? ''}`} right={<Tag label={statusLabel(k.status)} />} />)}</View> : null}
            </Block>
          </Card>
        </View>
        <View style={{ flex: 1, width: tablet ? undefined : '100%', gap: 12 }}>
          <Card>
            <Block title={t('wb.tab_goals')}>
              {a.goals.length ? a.goals.map((g) => (
                <View key={g.id} style={{ gap: 6, paddingVertical: 4 }}>
                  <Row title={g.title} sub={`${g.measure ? `${g.measure} · ` : ''}${t('wb.reviewer', { name: g.reviewer_name })}${g.target_date ? ` · ${dayText(g.target_date)}` : ''}`} right={<Tag label={statusLabel(g.status)} color={g.status === 'proposed' ? c.sunSoft : g.status === 'achieved' ? c.limeSoft : undefined} />} />
                  {g.status === 'proposed' && (acting || !athlete.is_youth) ? (
                    <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                      <Btn small title={t('wb.f_not_now')} color={c.paper} ink={c.ink} onPress={() => respondGoal(g, 'decline')} /><Btn small title={t('wb.f_agree')} onPress={() => respondGoal(g, 'agree')} />
                    </View>
                  ) : null}
                </View>
              )) : <T size={13} color={c.mute}>{on.includes('goals') ? t('wb.f_no_goals') : t('wb.f_goals_off')}</T>}
            </Block>
          </Card>
          <Card>
            <Block title={t('wb.tab_tracks')}>
              {a.tracks.length ? a.tracks.map((x) => (
                <View key={x.id} style={{ gap: 4, paddingVertical: 4 }}>
                  <Row title={x.title} sub={`${catLabel(x.category)} · ${t('wb.tr_meta', { min: x.age_min, max: x.age_max, n: x.modules.length })}`} right={<Tag label={x.member_status ? statusLabel(x.member_status) : t('wb.f_available')} color={x.member_status === 'enrolled' ? c.limeSoft : undefined} />} />
                  {x.member_status ? <Progress done={x.modules_done.length} of={x.modules.length} /> : null}
                  {x.member_status === 'enrolled' ? <View style={{ alignItems: 'flex-end' }}><Btn small title={t('wb.f_leave')} color={c.paper} ink={c.ink} onPress={() => run(() => api.post(`/me/wellbeing/tracks/${x.id}/leave`, { athlete_id: athlete.id }), t('wb.f_left'))} /></View> : null}
                </View>
              )) : <T size={13} color={c.mute}>{on.includes('tracks') ? t('wb.f_no_tracks') : t('wb.f_tracks_off')}</T>}
            </Block>
          </Card>
          <Card>
            <Block title={t('wb.f_specialists')}>
              {a.referrals.length ? a.referrals.map((r) => (
                <View key={r.id} style={{ gap: 6, paddingVertical: 4 }}>
                  <Row title={`${specialtyLabel(r.specialty)}${r.provider_name ? ` · ${r.provider_name}` : ''}`} sub={`${reasonLabel(r.reason)} · ${t('wb.f_suggested_by', { name: r.proposed_by_name })}`} right={<Tag label={statusLabel(r.status)} color={r.status === 'proposed' ? c.sunSoft : r.status === 'consented' ? c.limeSoft : undefined} />} />
                  {acting && ['proposed', 'consented'].includes(r.status) ? (
                    <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                      {r.status === 'proposed' ? <><Btn small title={t('wb.f_no')} color={c.paper} ink={c.ink} onPress={() => respondRef(r, 'decline')} /><Btn small title={t('wb.f_yes')} onPress={() => respondRef(r, 'consent')} /></> : <Btn small title={t('wb.f_take_back')} color={c.paper} ink={c.red} onPress={() => respondRef(r, 'withdraw')} />}
                    </View>
                  ) : null}
                </View>
              )) : <T size={13} color={c.mute}>{on.includes('referrals') ? t('wb.f_no_specialists') : t('wb.f_specialists_off')}</T>}
              <T size={12} color={c.mute}>{t('wb.f_specialists_note')}</T>
            </Block>
          </Card>
        </View>
      </View>
      <Card>
        <Block title={t('wb.f_log')} right={<Btn small title={log ? t('wb.f_hide') : t('wb.f_show')} color={c.paper} ink={c.ink} onPress={() => setLog(!log)} />}>
          <T size={12} color={c.mute}>{t('wb.f_log_sub')}</T>
          {log ? (a.timeline.length ? a.timeline.map((e) => <Row key={e.id} title={eventLabel(e.kind)} sub={`${e.actor_name ?? t('wb.f_system')} · ${dateTimeText(e.created_at)}`} />) : <T size={13} color={c.mute}>{t('wb.none_yet')}</T>) : null}
        </Block>
      </Card>
      <ChoicesSheet a={a} athlete={athlete} open={edit} onClose={() => setEdit(false)} toast={toast} reload={reload} />
    </View>
  );
}

const Progress = ({ done, of }) => (
  <View accessible accessibilityLabel={t('wb.tr_progress', { a: done, b: of })} style={{ gap: 3 }}>
    <View style={{ height: 8, borderRadius: 5, backgroundColor: c.violetSoft }}><View style={{ height: 8, borderRadius: 5, width: `${of ? Math.round((100 * done) / of) : 0}%`, backgroundColor: c.lime }} /></View>
    <T size={12} color={c.mute}>{t('wb.tr_progress', { a: done, b: of })}</T>
  </View>
);

/** One switch per thing the academy might do; saving replaces the earlier choice (kept as history) and takes effect at once. */
function ChoicesSheet({ a, athlete, open, onClose, toast, reload }) {
  const [sel, setSel] = useState(null);
  const cur = sel ?? (a.consent?.scopes ?? []);
  const flip = (s) => setSel(cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  const save = async (scopes) => { try { await api.post('/me/wellbeing/consent', { organisation_id: a.organisation.id, athlete_id: athlete.id, scopes }); toast(scopes.length ? t('wb.f_saved') : t('wb.f_withdrawn')); setSel(null); onClose(); reload(); } catch (e) { toast(explain(e)); } };
  return (
    <Sheet visible={open} onClose={() => { setSel(null); onClose(); }} title={t('wb.f_choices')}>
      <T size={13} color={c.mute}>{t('wb.f_choices_intro')}</T>
      {SCOPE_LIST.map((s) => (
        <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
          <View style={{ flex: 1 }}><T weight="700">{scopeLabel(s)}</T><T size={12} color={c.mute}>{scopeHint(s)}</T></View>
          <Switch value={cur.includes(s)} onValueChange={() => flip(s)} accessibilityLabel={scopeLabel(s)} trackColor={{ true: c.lime }} />
        </View>
      ))}
      <T size={12} color={c.mute}>{t('wb.f_choices_note')}</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn title={t('wb.f_save')} onPress={() => save(cur)} style={{ flex: 1 }} />
        {a.consent ? <Btn title={t('wb.f_withdraw_all')} color={c.paper} ink={c.red} onPress={() => save([])} /> : null}
      </View>
    </Sheet>
  );
}
