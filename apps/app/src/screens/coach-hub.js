import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Empty, ErrorBox, Loading, Screen, Tag, T } from '../ui';
import { TrendChart } from '../eval-charts';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';

// The coach's front door: ten quick actions that each open the screen that already does the job (calendar, academies, events, sponsors,
// evaluations and feedback, venues, community, physio/doctor, insurance and its status). Previews read the same endpoints those screens use,
// so nothing is copied and the server stays the only place that decides who may see what. The athlete's front door is a separate file.
const when = (iso) => { try { return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

/** One spoken label from the parts that exist: name, detail, status. */
const spoken = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join('. ');

function Tile({ icon, title, sub, onPress, children, wide, badge }) {
  const label = spoken(title, sub, badge);
  return (
    <Card onPress={onPress} pad={14} accessibilityLabel={label} style={{ alignSelf: 'stretch', flex: 1, minHeight: 88, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <T weight="800" size={wide ? 17 : 15} style={{ flexShrink: 1 }}>{icon} {title}</T>
        {badge ? <Tag label={badge} /> : null}
      </View>
      {sub ? <T size={13} color={c.mute} numberOfLines={wide ? undefined : 2}>{sub}</T> : null}
      {children}
    </Card>
  );
}

/** Days until the nearest active cover ends, or null when the coach holds none. */
const nearestCover = (policies) => (policies ?? []).filter((p) => p.status === 'active' && !p.renewed_by).reduce((m, p) => (m === null || p.days_left < m.days_left ? p : m), null);

export function CoachHub() {
  const { push, goTab } = useNav();
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const sched = useLoad(() => api.get('/me/sport-schedule', { from, to }), []);
  const fb = useLoad(() => api.get('/coach/feedback-overview'), []);
  const pol = useLoad(() => api.get('/insurance/policies', { limit: 20 }), []);
  const next = (sched.data?.items ?? []).slice(0, 3);
  const cover = nearestCover(pol.data);
  const owed = fb.data?.session_feedback?.owed ?? 0;
  const waiting = (fb.data?.evaluations?.waiting_on_me ?? []).length;
  const coverBadge = cover ? (cover.days_left <= 30 ? (cover.days_left < 0 ? t('ch.cover_ended') : t('ch.cover_days', { n: cover.days_left })) : null) : null;
  const cards = [
    { icon: '🏫', title: t('ch.academy'), sub: t('ch.academy_sub'), onPress: () => goTab('Explore', { tab: 'academies' }) },
    { icon: '🏟️', title: t('ws.hub.event'), sub: t('ws.hub.event_sub'), onPress: () => goTab('Explore') },
    { icon: '💼', title: t('ws.hub.sponsor'), sub: t('ws.hub.sponsor_sub'), onPress: () => push('FundingOpportunities') },
    { icon: '📋', title: t('ch.feedback'), sub: t('ch.feedback_sub'), onPress: () => push('CoachFeedback'), badge: owed + waiting ? String(owed + waiting) : undefined },
    { icon: '📍', title: t('ch.venue'), sub: t('ws.hub.venue_sub_any'), onPress: () => goTab('Schedule', { section: 'book' }) },
    { icon: '🩺', title: t('ch.physio'), sub: t('ws.hub.physio_sub'), onPress: () => push('Health', { tab: 'find' }) },
    { icon: '🛡️', title: t('ch.insurance'), sub: t('ch.insurance_sub'), onPress: () => push('Insurance') },
    { icon: '⏰', title: t('ch.cover'), sub: cover ? `${cover.plan_name}` : pol.data ? t('ch.cover_none') : t('ch.cover_sub'), onPress: () => push(cover ? 'Insure' : 'Insurance'), badge: coverBadge ?? undefined },
  ];
  return (
    <View style={{ gap: 12 }}>
      <Tile wide icon="📅" title={t('ws.hub.calendar')} sub={next.length ? undefined : t('ws.hub.calendar_empty')} onPress={() => goTab('Schedule', { section: 'agenda' })}>
        {next.map((x) => (
          <View key={`${x.source_type}${x.source_id}`} style={{ paddingVertical: 4, borderTopWidth: 1, borderTopColor: c.line }}>
            <T weight="700" size={14} numberOfLines={1}>{x.title}</T>
            <T size={12} color={c.mute}>{when(x.starts_at)}</T>
          </View>
        ))}
        <Btn small title={t('ch.appointments')} color={c.paper} ink={c.ink} onPress={() => push('Health', { tab: 'appts' })} />
      </Tile>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {cards.map((p) => <View key={p.title} style={{ flexGrow: 1, flexBasis: '47%', minWidth: 140, display: 'flex' }}><Tile {...p} /></View>)}
      </View>
      <Tile wide icon="💬" title={t('ws.hub.community')} sub={t('ws.community_sub')} onPress={() => push('Community')} />
    </View>
  );
}

const Stat = ({ label, value, tone }) => (
  <View style={{ flexGrow: 1, flexBasis: 140, minHeight: 80, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 12, justifyContent: 'space-between' }}>
    <T size={12} weight="600" color={c.mute} numberOfLines={2}>{label}</T>
    <T size={28} weight="800" color={tone} style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
  </View>
);

/** All of the coach's evaluations and feedback on one page: evaluation status, what is waiting, session feedback owed, reviews and a 6-month trend. */
export function CoachFeedback() {
  const { push } = useNav();
  const { tablet } = useLayout();
  const fb = useLoad(() => api.get('/coach/feedback-overview'), []);
  const d = fb.data;
  if (fb.error) return <Screen><ErrorBox error={fb.error} onRetry={fb.reload} /></Screen>;
  if (!d) return <Screen><Loading /></Screen>;
  const ev = d.evaluations;
  const empty = !ev.total && !d.session_feedback.owed && !d.reviews.count;
  const months = d.trend.evaluations;
  const width = tablet ? 480 : 300;
  return (
    <Screen onRefresh={fb.reload} refreshing={fb.loading} wide>
      <T size={22} weight="800" accessibilityRole="header">{t('ch.fb.title')}</T>
      {empty ? (
        <View style={{ gap: 12 }}>
          <Empty emoji="📋" title={t('ch.fb.title')} sub={t('ch.fb.empty')} />
          <Btn title={t('ch.fb.start')} onPress={() => push('Evaluations')} />
        </View>
      ) : (
        <View style={{ gap: 16, marginTop: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <Stat label={t('ch.fb.drafts')} value={ev.draft} />
            <Stat label={t('ch.fb.shared')} value={ev.shared} />
            <Stat label={t('ch.fb.responded')} value={ev.responded} tone={ev.responded ? c.pink : undefined} />
            <Stat label={t('ch.fb.closed')} value={ev.closed} />
            <Stat label={t('ch.fb.rating')} value={d.reviews.average ? `${d.reviews.average.toFixed(1)}★` : '–'} />
          </View>
          {d.session_feedback.owed ? (
            <Card pad={14} onPress={() => push('CoachCalendar')} accessibilityLabel={t('ch.fb.owed_n', { n: d.session_feedback.owed })}>
              <T weight="800">{t('ch.fb.owed')}</T>
              <T size={13} color={c.mute}>{t('ch.fb.owed_n', { n: d.session_feedback.owed })}</T>
            </Card>
          ) : null}
          {ev.waiting_on_me.length ? (
            <View style={{ gap: 8 }}>
              <T weight="800" size={17}>{t('ch.fb.waiting')}</T>
              {ev.waiting_on_me.map((e) => (
                <Card key={e.id} pad={14} onPress={() => push('Evaluation', { id: e.id })} accessibilityLabel={spoken(e.athlete_name, e.title)}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <T weight="700" style={{ flexShrink: 1 }}>{e.athlete_name}</T>
                    <Tag label={e.status === 'responded' ? t('ch.fb.responded') : t('ch.fb.drafts')} />
                  </View>
                  <T size={13} color={c.mute} numberOfLines={1}>{e.title}</T>
                </Card>
              ))}
            </View>
          ) : null}
          {months.length ? (
            <Card pad={14}>
              <T weight="800">{t('ch.fb.trend')}</T>
              <TrendChart width={width} domain={[0, Math.max(5, ...months.map((m) => m.n))]} lines={[{ key: 'n', label: t('ch.fb.shared'), color: c.pink }]}
                points={months.map((m) => ({ at: m.month, values: { n: m.n } }))} a11y={`${t('ch.fb.trend')}: ${months.map((m) => `${m.month} ${m.n}`).join(', ')}`} />
            </Card>
          ) : null}
          <View style={{ gap: 8 }}>
            <T weight="800" size={17}>{t('ch.fb.reviews')}</T>
            {d.reviews.recent.length ? d.reviews.recent.map((r) => (
              <Card key={r.id} pad={14} onPress={() => push('CoachReviews')} accessibilityLabel={spoken(r.author_name, r.rating)}>
                <T weight="700">{r.author_name} · {r.rating}★</T>
                {r.body ? <T size={13} color={c.mute} numberOfLines={3}>{r.body}</T> : null}
              </Card>
            )) : <T size={13} color={c.mute}>{t('ch.fb.no_reviews')}</T>}
          </View>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Btn title={t('ch.fb.all_evals')} onPress={() => push('Evaluations')} />
            <Btn title={t('ch.fb.all_reviews')} color={c.paper} ink={c.ink} onPress={() => push('CoachReviews')} />
          </View>
        </View>
      )}
    </Screen>
  );
}
