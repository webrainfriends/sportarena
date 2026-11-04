// Academy wellbeing & personal development (#795): the staff side inside Organisation → Academy. The director sees what is due and how participation
// is going (counts and rates, never content); a mentor sees their own mentees; nobody sees counselling or safeguarding narrative here.
// Every rule is enforced by the API (capabilities academy-wellbeing*.js); this screen only calls it. All text goes through t().
import React, { useState } from 'react';
import { View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { explain, LoadError } from '../access';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { Bars, Block, Initials, Kpi } from './academy-ui';
import { Tracks } from './academy-wellbeing-tracks';
import { SCOPE_LIST, TOPIC_LIST, scopeLabel, topicLabel, settingLabel, outcomeLabel, specialtyLabel, reasonLabel, statusLabel, actionLabel, catLabel, tplLabel, sevLabel, dayText, dateTimeText, opts } from './wellbeing-words';

const TABS = () => [['overview', t('wb.tab_overview')], ['people', t('wb.tab_people')], ['checkins', t('wb.tab_checkins')], ['goals', t('wb.tab_goals')], ['tracks', t('wb.tab_tracks')], ['referrals', t('wb.tab_referrals')]];
const TAB_OF = { checkin_to_record: 'checkins', follow_up_due: 'checkins', checkin_not_booked: 'people', goal_review_due: 'goals', goal_awaiting_family: 'goals', referral_waiting: 'referrals', needs_mentor: 'people', consent_expiring: 'people', mentor_review_due: 'people' };
const lineOf = (a, b) => `${a} · ${b}`;
const pc = (v) => (v == null ? '–' : `${v}%`);

export function WellbeingDesk({ o, role, toast }) {
  const [tab, setTab] = useState('overview');
  const { tablet } = useLayout();
  const ov = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing`), [o.id]);
  if (ov.error) return <LoadError error={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return <Loading />;
  const d = ov.data, k = d.kpis, oversight = d.scope === 'organisation', admin = role === 'owner' || role === 'admin';
  const P = { o, toast, oversight, admin, reload: ov.reload };
  const hasTrend = d.trend.some((x) => x.checkins_held);
  const weeks = d.trend.map((x) => ({ label: x.week, value: x.checkins_held, text: String(x.checkins_held) }));
  return (
    <View style={{ gap: 12 }}>
      <View><T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{t('wb.title')}</T><T color={c.mute}>{oversight ? t('wb.subtitle') : t('wb.subtitle_mentor')}</T></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="tablist">{TABS().map(([key, label]) => <Chip key={key} label={label} active={tab === key} onPress={() => setTab(key)} />)}</View>
      {tab === 'overview' ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Kpi label={t('wb.k_athletes')} value={k.academy_athletes} /><Kpi label={t('wb.k_mentor_cov')} value={pc(k.mentor_coverage_pct)} sub={t('wb.k_mentor_cov_sub', { n: d.mentors.athletes_mentored })} /><Kpi label={t('wb.k_rhythm')} value={pc(k.on_rhythm_pct)} />
            <Kpi label={t('wb.k_held')} value={k.checkins_held_30d} sub={t('wb.k_upcoming', { n: k.checkins_upcoming_14d })} /><Kpi label={t('wb.k_follow')} value={k.follow_ups_open} sub={k.follow_ups_overdue ? t('wb.k_overdue', { n: k.follow_ups_overdue }) : undefined} tone={k.follow_ups_overdue ? 'alert' : undefined} />
            <Kpi label={t('wb.k_reviews')} value={k.goal_reviews_due} tone={k.goal_reviews_due ? 'alert' : undefined} /><Kpi label={t('wb.k_referrals')} value={k.referrals_awaiting_family} />
          </View>
          <View style={{ flexDirection: tablet ? 'row' : 'column', gap: 12, alignItems: 'flex-start' }}>
            <Card style={{ flex: 1.2, width: tablet ? undefined : '100%' }}>
              <Block title={t('wb.due_title', { n: d.actions.length })}>
                {d.actions.length ? d.actions.slice(0, 12).map((x, i) => (
                  <Row key={`${x.kind}${x.ref_id ?? x.athlete_id}${i}`} left={<Initials name={x.athlete_name} user={{ avatar_emoji: null }} size={34} />} title={x.athlete_name} sub={`${actionLabel(x.kind)}${x.owner_name ? ` · ${x.owner_name}` : ''}${x.due_on ? ` · ${dayText(x.due_on)}` : ''}`}
                    onPress={() => setTab(TAB_OF[x.kind] ?? 'people')} right={x.due_on && new Date(x.due_on) < new Date() ? <Tag label={t('wb.overdue')} color={c.orange} /> : null} />
                )) : <Empty emoji="🌱" title={t('wb.due_empty_title')} sub={t('wb.due_empty_sub')} />}
              </Block>
            </Card>
            <View style={{ flex: 1, width: tablet ? undefined : '100%', gap: 12 }}>
              <Card>
                <Block title={t('wb.cov_title')}>
                  <Bars label={t('wb.cov_title')} rows={SCOPE_LIST.map((s) => ({ label: scopeLabel(s), value: d.coverage[s].pct ?? 0, text: `${d.coverage[s].athletes} · ${pc(d.coverage[s].pct)}` }))} />
                  <T size={12} color={c.mute}>{t('wb.cov_note')}</T>
                </Block>
              </Card>
              <Card>
                <Block title={t('wb.trend_title', { n: d.trend.length })}>
                  {hasTrend ? <Bars label={t('wb.trend_title', { n: d.trend.length })} rows={weeks} /> : <Empty emoji="📈" title={t('wb.trend_empty_title')} sub={t('wb.trend_empty_sub')} />}
                </Block>
              </Card>
            </View>
          </View>
          <Card color={c.violetSoft} pad={12}><T weight="800" size={13}>{t('wb.privacy_title')}</T><T size={13}>{t('wb.privacy_body', { n: d.min_group })}</T></Card>
        </>
      ) : null}
      {tab === 'people' ? <People {...P} /> : null}
      {tab === 'checkins' ? <Checkins {...P} /> : null}
      {tab === 'goals' ? <Goals {...P} /> : null}
      {tab === 'tracks' ? <Tracks {...P} /> : null}
      {tab === 'referrals' ? <Referrals {...P} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ people
function People({ o, toast, oversight, admin, reload }) {
  const [q, setQ] = useState(''), [flt, setFlt] = useState('all'), [open, setOpen] = useState(null), [assign, setAssign] = useState(null);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing/athletes`, { q: q || undefined, consent: flt === 'no_consent' ? 'none' : undefined, mentor: flt === 'no_mentor' ? 'none' : undefined, limit: 100 }), [o.id, q, flt]);
  const staff = useLoad(() => (oversight ? api.get(`/organisations/${o.id}/academy/staff`).catch(() => []) : Promise.resolve([])), [o.id, oversight]);
  const mentors = (Array.isArray(staff.data) ? staff.data : staff.data?.staff ?? staff.data?.members ?? []).filter((m) => ['owner', 'admin'].includes(m.role) || (m.permissions ?? []).includes('wellbeing'));
  const ask = async (ids) => { try { const r = await api.post(`/organisations/${o.id}/academy/wellbeing/consent-requests`, { athlete_ids: ids }); toast(t('wb.asked', { n: r.asked })); } catch (e) { toast(explain(e)); } };
  const rows = d.data ?? [];
  return (
    <Card>
      <View style={{ gap: 8 }}>
        <Field value={q} onChangeText={setQ} placeholder={t('wb.search')} accessibilityLabel={t('wb.search')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {[['all', t('wb.f_all')], ['no_consent', t('wb.f_no_consent')], ['no_mentor', t('wb.f_no_mentor')]].map(([k, l]) => <Chip key={k} label={l} active={flt === k} onPress={() => setFlt(k)} />)}
          {oversight && rows.some((r) => !r.scopes.length) ? <Btn small title={t('wb.ask_all')} color={c.paper} ink={c.ink} onPress={() => ask(rows.filter((r) => !r.scopes.length).map((r) => r.athlete_id))} /> : null}
        </View>
      </View>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : !rows.length ? <Empty emoji="🧑‍🤝‍🧑" title={t('wb.people_empty_title')} sub={t('wb.people_empty_sub')} /> : (
        <View style={{ gap: 4, marginTop: 8 }}>
          {rows.map((r) => (
            <Row key={r.athlete_id} left={<Initials name={r.display_name} user={r} size={38} />} title={r.display_name}
              sub={`${r.scopes.length ? t('wb.shares_n', { n: r.scopes.length }) : t('wb.no_choices')} · ${r.mentor_name ? t('wb.mentor_is', { name: r.mentor_name }) : t('wb.no_mentor')}${r.next_checkin_at ? ` · ${t('wb.next', { when: dateTimeText(r.next_checkin_at) })}` : ''}`}
              onPress={() => setOpen(r)} right={<View style={{ gap: 4, alignItems: 'flex-end' }}>{r.is_youth ? <Tag label={t('wb.youth')} color={c.cyanSoft} /> : null}{r.scopes.length ? null : <Tag label={t('wb.consent_needed')} color={c.sun} />}</View>} />
          ))}
        </View>
      )}
      <AthleteSheet o={o} row={open} onClose={() => setOpen(null)} toast={toast} oversight={oversight} admin={admin} onAsk={ask} onAssign={(r) => { setOpen(null); setAssign(r); }} reload={() => { d.reload(); reload?.(); }} />
      <FormSheet visible={!!assign} onClose={() => setAssign(null)} title={assign ? t('wb.assign_title', { name: assign.display_name }) : ''} submitLabel={t('wb.assign')}
        initial={{ mentor: [], cadence_days: 14 }}
        fields={[
          { key: 'mentor', label: t('wb.mentor'), type: 'multimenu', max: 1, options: mentors.map((m) => ({ value: m.user_id, label: m.display_name ?? m.handle, sub: m.job_title })), hint: t('wb.mentor_hint') },
          { key: 'cadence_days', label: t('wb.cadence'), type: 'stepper', min: 3, max: 120, step: 1, suffix: ` ${t('wb.days')}`, default: 14 },
          { key: 'review_on', label: t('wb.review_on'), type: 'date', optional: true },
        ]}
        onSubmit={async (v) => { await api.post(`/organisations/${o.id}/academy/wellbeing/mentors`, { athlete_id: assign.athlete_id, mentor_id: v.mentor[0], cadence_days: v.cadence_days, review_on: v.review_on || undefined, replace: !!assign.mentor_id }); d.reload(); reload?.(); return t('wb.assigned'); }} />
    </Card>
  );
}

function AthleteSheet({ o, row, onClose, toast, oversight, admin, onAsk, onAssign, reload }) {
  const rec = useLoad(() => (row ? api.get(`/organisations/${o.id}/academy/wellbeing/athletes/${row.athlete_id}`) : Promise.resolve(null)), [o.id, row?.athlete_id]);
  const [form, setForm] = useState(null);
  const r = rec.data;
  const mine = r?.role === 'mentor';
  const base = `/organisations/${o.id}/academy/wellbeing`;
  const tracks = useLoad(() => (row ? api.get(`${base}/tracks`).catch(() => []) : Promise.resolve([])), [o.id, row?.athlete_id]);
  return (
    <Sheet visible={!!row} onClose={onClose} title={row?.display_name ?? ''}>
      {!row ? null : rec.error ? <LoadError error={rec.error} onRetry={rec.reload} /> : !r ? <Loading /> : (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {r.consent ? r.consent.scopes.map((s) => <Tag key={s} label={scopeLabel(s)} color={c.limeSoft} />) : <Tag label={t('wb.no_choices')} color={c.sun} />}
          </View>
          <T size={12} color={c.mute}>{r.consent ? t('wb.consent_by', { who: r.consent.granted_as === 'guardian' ? t('wb.by_guardian') : t('wb.by_self'), date: dayText(r.consent.expires_at) }) : t('wb.consent_none_sub')}</T>
          <Row title={t('wb.mentor')} sub={row.mentor_name ? `${row.mentor_name} · ${statusLabel(r.mentor?.status)}` : t('wb.no_mentor')} right={oversight ? <Btn small title={row.mentor_name ? t('wb.change') : t('wb.assign')} color={c.paper} ink={c.ink} disabled={!r.consent?.scopes.includes('mentoring')} onPress={() => onAssign(row)} /> : null} />
          {!r.consent ? <Btn title={t('wb.ask_one')} onPress={() => onAsk([row.athlete_id])} /> : null}
          {mine ? (
            <>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn small title={t('wb.schedule')} disabled={!r.consent?.scopes.includes('checkins')} onPress={() => setForm('checkin')} />
                <Btn small title={t('wb.propose_goal')} disabled={!r.consent?.scopes.includes('goals')} onPress={() => setForm('goal')} color={c.paper} ink={c.ink} />
                <Btn small title={t('wb.suggest')} disabled={!r.consent?.scopes.includes('referrals')} onPress={() => setForm('referral')} color={c.paper} ink={c.ink} />
                <Btn small title={t('wb.update_family')} disabled={!r.consent?.scopes.includes('guardian_updates')} onPress={() => setForm('update')} color={c.paper} ink={c.ink} />
              </View>
              <Block title={t('wb.tab_checkins')}>{r.checkins.length ? r.checkins.slice(0, 6).map((k) => <Row key={k.id} title={dateTimeText(k.scheduled_for)} sub={`${statusLabel(k.status)}${k.outcome ? ` · ${outcomeLabel(k.outcome)}` : ''}${k.next_step ? ` · ${k.next_step}` : ''}`} />) : <T size={13} color={c.mute}>{t('wb.none_yet')}</T>}</Block>
              <Block title={t('wb.tab_goals')}>{r.goals.length ? r.goals.map((g) => <Row key={g.id} title={g.title} sub={`${statusLabel(g.status)}${g.target_date ? ` · ${dayText(g.target_date)}` : ''}`} />) : <T size={13} color={c.mute}>{t('wb.none_yet')}</T>}</Block>
            </>
          ) : <Card color={c.violetSoft} pad={12}><T size={13}>{t('wb.oversight_note')}</T></Card>}
          <T size={11} color={c.mute}>{t('wb.looked_note')}</T>
          <FormSheet visible={form === 'checkin'} onClose={() => setForm(null)} title={t('wb.schedule')} submitLabel={t('wb.schedule')}
            initial={{ scheduled_for: '', duration_min: 20, setting: 'academy_room', topics: [], repeat: 1, every_days: 14 }}
            fields={[
              { key: 'scheduled_for', label: t('wb.when'), type: 'datetime', min: new Date().toISOString() },
              { key: 'duration_min', label: t('wb.duration'), type: 'stepper', min: 5, max: 120, step: 5, suffix: ` ${t('wb.min')}`, default: 20 },
              { key: 'setting', label: t('wb.setting'), type: 'chips', options: opts(['academy_room', 'training_venue', 'video_with_guardian_aware', 'phone_with_guardian_aware'], settingLabel), hint: row.is_youth ? t('wb.setting_hint_youth') : undefined },
              { key: 'topics', label: t('wb.topics'), type: 'multi', options: opts(TOPIC_LIST, topicLabel), optional: true },
              { key: 'repeat', label: t('wb.repeat'), type: 'stepper', min: 1, max: 12, step: 1, default: 1, hint: t('wb.repeat_hint') },
              { key: 'every_days', label: t('wb.every'), type: 'stepper', min: 1, max: 60, step: 1, suffix: ` ${t('wb.days')}`, default: 14, show: (v) => v.repeat > 1 },
            ]}
            onSubmit={async (v) => { await api.post(`${base}/checkins`, { athlete_id: row.athlete_id, scheduled_for: v.scheduled_for, duration_min: v.duration_min, setting: v.setting, topics: v.topics, repeat: v.repeat, every_days: v.every_days, idempotency_key: `ck-${row.athlete_id}-${Date.now()}` }); rec.reload(); reload?.(); return t('wb.scheduled'); }} />
          <FormSheet visible={form === 'goal'} onClose={() => setForm(null)} title={t('wb.propose_goal')} submitLabel={t('wb.propose')}
            fields={[
              { key: 'title', label: t('wb.goal_title'), hint: t('wb.goal_title_hint') }, { key: 'measure', label: t('wb.goal_measure'), type: 'multiline', optional: true, hint: t('wb.goal_measure_hint') },
              { key: 'target_date', label: t('wb.target_date'), type: 'date', optional: true, min: new Date().toISOString().slice(0, 10) },
              { key: 'track', label: t('wb.track'), type: 'multimenu', max: 1, optional: true, options: (tracks.data ?? []).filter((x) => x.status === 'active').map((x) => ({ value: x.id, label: x.title, sub: catLabel(x.category) })) },
            ]}
            onSubmit={async (v) => { await api.post(`${base}/goals`, { athlete_id: row.athlete_id, title: v.title, measure: v.measure || undefined, target_date: v.target_date || undefined, track_id: v.track?.[0] }); rec.reload(); reload?.(); return t('wb.goal_proposed'); }} />
          <FormSheet visible={form === 'referral'} onClose={() => setForm(null)} title={t('wb.suggest')} submitLabel={t('wb.suggest_send')} notice={t('wb.suggest_notice')}
            initial={{ specialty: 'sports_psychology', reason: 'general_wellbeing', urgent: false }}
            fields={[
              { key: 'specialty', label: t('wb.specialty'), type: 'chips', options: opts(['sports_psychology', 'counselling', 'nutrition', 'sports_medicine', 'physiotherapy', 'learning_support', 'other_specialist'], specialtyLabel) },
              { key: 'reason', label: t('wb.reason'), type: 'chips', options: opts(['performance_pressure', 'load_and_recovery', 'nutrition_support', 'school_balance', 'general_wellbeing', 'transition_support', 'other'], reasonLabel), hint: t('wb.reason_hint') },
              { key: 'urgent', label: t('wb.soon'), type: 'switch' },
            ]}
            onSubmit={async (v) => { await api.post(`${base}/referrals`, { athlete_id: row.athlete_id, specialty: v.specialty, reason: v.reason, urgency: v.urgent ? 'soon' : 'routine' }); rec.reload(); reload?.(); return t('wb.suggested'); }} />
          <FormSheet visible={form === 'update'} onClose={() => setForm(null)} title={t('wb.update_family')} submitLabel={t('wb.send')}
            initial={{ template: 'track_progress' }}
            fields={[
              { key: 'template', label: t('wb.template'), type: 'chips', options: opts(['track_progress', 'goal_outcome', 'checkin_rhythm', 'thank_you', 'review_invitation'], tplLabel) },
              { key: 'note', label: t('wb.note'), type: 'multiline', optional: true, hint: t('wb.note_hint') },
            ]}
            onSubmit={async (v) => { await api.post(`${base}/updates`, { athlete_id: row.athlete_id, template: v.template, note: v.note || undefined }); return t('wb.sent'); }} />
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ check-ins
function Checkins({ o, toast, oversight, reload }) {
  const [st, setSt] = useState('scheduled'), [open, setOpen] = useState(null);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing/checkins`, { status: st, limit: 100 }), [o.id, st]);
  const rows = d.data ?? [];
  const done = () => { setOpen(null); d.reload(); reload?.(); };
  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{[['scheduled', t('wb.f_upcoming')], ['overdue', t('wb.f_overdue')], ['open_follow_up', t('wb.f_follow')], ['completed', t('wb.f_done')], ['missed', t('wb.st_missed')]].map(([k, l]) => <Chip key={k} label={l} active={st === k} onPress={() => setSt(k)} />)}</View>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : !rows.length ? <Empty emoji="🗓️" title={t('wb.ck_empty_title')} sub={t('wb.ck_empty_sub')} /> : rows.map((k) => (
        <Row key={k.id} title={lineOf(k.athlete_name, dateTimeText(k.scheduled_for))} sub={`${t('wb.with', { name: k.mentor_name })} · ${settingLabel(k.setting)}${k.follow_up_status === 'open' ? ` · ${t('wb.follow_by', { date: dayText(k.follow_up_due) })}` : ''}`}
          onPress={() => setOpen(k)} right={<Tag label={statusLabel(k.status)} color={k.status === 'completed' ? c.limeSoft : k.status === 'missed' ? c.orangeSoft : undefined} />} />
      ))}
      <CheckinSheet k={open} oversight={oversight} onClose={() => setOpen(null)} toast={toast} onDone={done} />
    </Card>
  );
}

function CheckinSheet({ k, oversight, onClose, toast, onDone }) {
  const [form, setForm] = useState(null);
  const patch = async (body, ok) => { try { await api.patch(`/academy/wellbeing/checkins/${k.id}`, { row_version: k.row_version, ...body }); toast(ok); onDone(); } catch (e) { toast(explain(e)); } };
  const mine = !!k && ('topics' in k);
  return (
    <Sheet visible={!!k} onClose={onClose} title={k ? `${k.athlete_name} · ${dateTimeText(k.scheduled_for)}` : ''}>
      {k ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Tag label={statusLabel(k.status)} />{k.follow_up_status === 'open' ? <Tag label={t('wb.follow_by', { date: dayText(k.follow_up_due) })} color={c.sunSoft} /> : null}{k.follow_up_status === 'done' ? <Tag label={t('wb.follow_done')} color={c.limeSoft} /> : null}</View>
          <T size={13} color={c.mute}>{t('wb.with', { name: k.mentor_name })} · {settingLabel(k.setting)} · {t('wb.mins', { n: k.duration_min })}</T>
          {mine ? <>{k.topics?.length ? <T size={13}>{k.topics.map(topicLabel).join(' · ')}</T> : null}{k.outcome ? <T size={13} weight="700">{outcomeLabel(k.outcome)}</T> : null}{k.next_step ? <Card color={c.violetSoft} pad={12}><T weight="800" size={12}>{t('wb.next_step')}</T><T size={14}>{k.next_step}</T></Card> : null}</> : <Card color={c.violetSoft} pad={12}><T size={13}>{t('wb.oversight_note')}</T></Card>}
          {k.status === 'scheduled' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {mine ? <Btn small title={t('wb.record')} onPress={() => setForm('complete')} /> : null}
              <Btn small title={t('wb.reschedule')} color={c.paper} ink={c.ink} onPress={() => setForm('move')} />
              {new Date(k.scheduled_for) < new Date() ? <Btn small title={t('wb.mark_missed')} color={c.paper} ink={c.ink} onPress={() => patch({ action: 'missed' }, t('wb.updated'))} /> : null}
              <Btn small title={t('wb.cancel')} color={c.paper} ink={c.red} onPress={() => patch({ action: 'cancel' }, t('wb.updated'))} />
            </View>
          ) : null}
          {mine && k.follow_up_status === 'open' ? <Btn small title={t('wb.follow_close')} onPress={() => patch({ action: 'follow_up_done' }, t('wb.updated'))} /> : null}
          <FormSheet visible={form === 'complete'} onClose={() => setForm(null)} title={t('wb.record')} submitLabel={t('wb.save_record')} notice={t('wb.record_notice')}
            initial={{ outcome: 'on_track', topics: k.topics ?? [] }}
            fields={[
              { key: 'outcome', label: t('wb.outcome'), type: 'chips', options: opts(['on_track', 'follow_up', 'referral_suggested', 'concern_raised'], outcomeLabel) },
              { key: 'topics', label: t('wb.topics_covered'), type: 'multi', options: opts(TOPIC_LIST, topicLabel), optional: true },
              { key: 'next_step', label: t('wb.next_step'), type: 'multiline', optional: true, hint: t('wb.next_step_hint') },
              { key: 'follow_up_due', label: t('wb.follow_due'), type: 'date', optional: true, min: new Date().toISOString().slice(0, 10), show: (v) => ['follow_up', 'referral_suggested'].includes(v.outcome) },
              { key: 'concern_severity', label: t('wb.concern_severity'), type: 'chips', options: opts(['low', 'medium', 'high'], sevLabel), default: 'medium', show: (v) => v.outcome === 'concern_raised' },
              { key: 'concern_summary', label: t('wb.concern'), type: 'multiline', hint: t('wb.concern_hint'), show: (v) => v.outcome === 'concern_raised' },
            ]}
            onSubmit={async (v) => { await api.patch(`/academy/wellbeing/checkins/${k.id}`, { row_version: k.row_version, action: 'complete', outcome: v.outcome, topics: v.topics, next_step: v.next_step || undefined, follow_up_due: v.follow_up_due || undefined, concern_summary: v.outcome === 'concern_raised' ? v.concern_summary : undefined, concern_severity: v.concern_severity ?? 'medium' }); onDone(); return t('wb.recorded'); }} />
          <FormSheet visible={form === 'move'} onClose={() => setForm(null)} title={t('wb.reschedule')} submitLabel={t('wb.reschedule')} fields={[{ key: 'scheduled_for', label: t('wb.when'), type: 'datetime', min: new Date().toISOString() }]}
            onSubmit={async (v) => { await api.patch(`/academy/wellbeing/checkins/${k.id}`, { row_version: k.row_version, action: 'reschedule', scheduled_for: v.scheduled_for }); onDone(); return t('wb.updated'); }} />
        </View>
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ goals
function Goals({ o, toast, reload }) {
  const [st, setSt] = useState('active'), [open, setOpen] = useState(null);
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing/goals`, { status: st, limit: 100 }), [o.id, st]);
  const rows = d.data ?? [];
  const act = async (g, body, ok) => { try { await api.patch(`/academy/wellbeing/goals/${g.id}`, { row_version: g.row_version, ...body }); toast(ok); setOpen(null); d.reload(); reload?.(); } catch (e) { toast(explain(e)); } };
  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{[['proposed', t('wb.gs_proposed')], ['agreed', t('wb.gs_agreed')], ['active', t('wb.gs_active')], ['review_due', t('wb.gs_review')], ['achieved', t('wb.gs_achieved')]].map(([k, l]) => <Chip key={k} label={l} active={st === k} onPress={() => setSt(k)} />)}</View>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : !rows.length ? <Empty emoji="🎯" title={t('wb.goals_empty_title')} sub={t('wb.goals_empty_sub')} /> : rows.map((g) => (
        <Row key={g.id} title={g.title ?? g.athlete_name} sub={`${g.title ? `${g.athlete_name} · ` : ''}${t('wb.reviewer', { name: g.reviewer_name })}${g.next_review_on ? ` · ${t('wb.review_by', { date: dayText(g.next_review_on) })}` : ''}`} onPress={g.title ? () => setOpen(g) : undefined} right={<Tag label={statusLabel(g.status)} color={g.status === 'achieved' ? c.limeSoft : undefined} />} />
      ))}
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open?.title ?? ''}>
        {open ? (
          <View style={{ gap: 8 }}>
            <T size={13} color={c.mute}>{open.athlete_name} · {statusLabel(open.status)}</T>
            {open.measure ? <T size={14}>{open.measure}</T> : null}
            <T size={12} color={c.mute}>{open.athlete_agreed_at || open.guardian_agreed_at ? t('wb.agreed_by_family') : t('wb.waiting_family')}</T>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {open.status === 'agreed' ? <Btn small title={t('wb.start')} onPress={() => act(open, { action: 'start' }, t('wb.updated'))} /> : null}
              {open.status === 'active' ? <Btn small title={t('wb.achieved')} onPress={() => setOpen({ ...open, ask: 'achieve' })} /> : null}
              {open.status === 'active' ? <Btn small title={t('wb.pause')} color={c.paper} ink={c.ink} onPress={() => act(open, { action: 'pause' }, t('wb.updated'))} /> : null}
              {open.status === 'paused' ? <Btn small title={t('wb.resume')} onPress={() => act(open, { action: 'resume' }, t('wb.updated'))} /> : null}
              {['proposed', 'agreed', 'active', 'paused'].includes(open.status) ? <Btn small title={t('wb.drop')} color={c.paper} ink={c.red} onPress={() => act(open, { action: 'drop' }, t('wb.updated'))} /> : null}
            </View>
          </View>
        ) : null}
        <FormSheet visible={open?.ask === 'achieve'} onClose={() => setOpen({ ...open, ask: null })} title={t('wb.achieved')} submitLabel={t('wb.achieved')} fields={[{ key: 'note', label: t('wb.why_achieved'), type: 'multiline', hint: t('wb.note_hint') }]}
          onSubmit={async (v) => { await api.patch(`/academy/wellbeing/goals/${open.id}`, { row_version: open.row_version, action: 'achieve', note: v.note }); setOpen(null); d.reload(); reload?.(); return t('wb.updated'); }} />
      </Sheet>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------------------------ referrals
function Referrals({ o, toast, reload }) {
  const d = useLoad(() => api.get(`/organisations/${o.id}/academy/wellbeing/referrals`, { limit: 100 }), [o.id]);
  const rows = d.data ?? [];
  const act = async (r, action) => { try { await api.patch(`/academy/wellbeing/referrals/${r.id}`, { action }); toast(t('wb.updated')); d.reload(); reload?.(); } catch (e) { toast(explain(e)); } };
  return (
    <Card>
      <Card color={c.violetSoft} pad={12}><T size={13}>{t('wb.ref_note')}</T></Card>
      {d.error ? <LoadError error={d.error} onRetry={d.reload} /> : !d.data ? <Loading /> : !rows.length ? <Empty emoji="🤝" title={t('wb.ref_empty_title')} sub={t('wb.ref_empty_sub')} /> : rows.map((r) => (
        <View key={r.id} style={{ gap: 6, paddingVertical: 6 }}>
          <Row title={lineOf(r.athlete_name, specialtyLabel(r.specialty))} sub={`${r.reason ? `${reasonLabel(r.reason)} · ` : ''}${dayText(r.created_at)}${r.urgency === 'soon' ? ` · ${t('wb.soon')}` : ''}`} right={<Tag label={statusLabel(r.status)} color={r.status === 'consented' ? c.limeSoft : r.status === 'proposed' ? c.sunSoft : undefined} />} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {r.status === 'consented' ? <Btn small title={t('wb.hand_over')} onPress={() => act(r, 'hand_over')} /> : null}
            {['proposed', 'consented'].includes(r.status) ? <Btn small title={t('wb.withdraw')} color={c.paper} ink={c.red} onPress={() => act(r, 'withdraw')} /> : null}
            {r.status === 'handed_over' ? <Btn small title={t('wb.close')} color={c.paper} ink={c.ink} onPress={() => act(r, 'close')} /> : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

