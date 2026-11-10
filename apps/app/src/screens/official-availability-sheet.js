// The organiser's side of official availability (#994): "can I ask this person for this match?".
// Reads get_fixture_official_availability, which answers only for whoever runs the event and returns free / busy with no reason,
// note, address or detail of the official's other matches. This sheet shows that and nothing more: the slot's state, the plain reasons,
// their load against their own caps, three days of free / busy in their own time zone, and how well the match fits what they prefer.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Card, Empty, Loading, Sheet, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { LoadError } from '../access';
import { c } from '../theme';
import { Metric } from '../federation-ui';
import { Row2 } from '../federation-bits';
import { addDays, localToIso, longDay, timeIn } from '../vtime';
import { t } from '../i18n';

const STATE_TONE = { available: c.mint, check: c.sun, limited: c.sun, unavailable: c.red };
const LEVEL_TONE = { blocked: c.red, limit: c.sun, note: c.violetSoft };
const SPAN = { busy: [c.cyan, 'oavo.span.busy'], tentative: [c.sun, 'oavo.span.tentative'], unavailable: [c.red, 'oavo.span.unavailable'] };
const HOUR_MARKS = [0, 6, 12, 18, 24];
const pct = (n) => String(Math.max(0, Math.min(100, n))) + '%';

/** One local day as a 24-hour bar: busy, tentative and unavailable spans, with this match outlined. Spoken as a sentence for screen readers. */
function DayBar({ day, tz, spans, match }) {
  const from = new Date(localToIso(day, '00:00', tz)).getTime(), to = new Date(localToIso(addDays(day, 1), '00:00', tz)).getTime();
  const len = to - from;
  const cut = (s) => {
    const a = Math.max(new Date(s.starts_at).getTime(), from), b = Math.min(new Date(s.ends_at).getTime(), to);
    return b > a ? { ...s, a, b } : null;
  };
  const parts = spans.map(cut).filter(Boolean);
  const mine = cut(match);
  const spoken = parts.length
    ? parts.map((p) => [t(SPAN[p.state][1]), timeIn(new Date(p.a).toISOString(), tz), timeIn(new Date(p.b).toISOString(), tz)].join(' ')).join('; ')
    : t('oavo.day_free');
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={[longDay(day), spoken].join(': ')} style={{ gap: 4 }}>
      <T size={12.5} weight={mine ? '800' : '600'}>{longDay(day)}</T>
      <View style={{ height: 26, borderRadius: 8, backgroundColor: c.mintSoft, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        {parts.map((p, i) => <View key={String(i)} style={{ position: 'absolute', top: 0, bottom: 0, start: pct(((p.a - from) / len) * 100), width: pct(((p.b - p.a) / len) * 100), backgroundColor: SPAN[p.state][0], opacity: p.state === 'tentative' ? 0.75 : 1 }} />)}
        {mine ? <View style={{ position: 'absolute', top: 0, bottom: 0, start: pct(((mine.a - from) / len) * 100), width: pct(((mine.b - mine.a) / len) * 100), borderWidth: 2.5, borderColor: c.ink, borderRadius: 4 }} /> : null}
      </View>
    </View>
  );
}

function Body({ fixtureId, userId }) {
  const q = useLoad(() => api.get('/fixtures/' + fixtureId + '/officials/' + userId + '/availability'), [fixtureId, userId]);
  if (q.error && !q.data) return <LoadError error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const a = q.data, tz = a.timezone, day = a.fixture.official_local_date;
  const match = { starts_at: a.fixture.scheduled_at, ends_at: new Date(new Date(a.fixture.scheduled_at).getTime() + a.fixture.duration_min * 60000).toISOString() };
  const cap = (n) => (n ? t('oavo.cap', { n }) : t('oavo.no_cap'));
  const hours = a.inside_hours === true ? 'oavo.hours.inside' : a.inside_hours === false ? 'oavo.hours.outside' : 'oavo.hours.none';
  const sport = a.preferences.sport === true ? 'oavo.fit.sport_yes' : a.preferences.sport === false ? 'oavo.fit.sport_no' : 'oavo.fit.sport_any';
  const range = a.travel.within_range === true ? 'oavo.fit.within' : a.travel.within_range === false ? 'oavo.fit.beyond' : 'oavo.fit.range_unknown';
  const list = (xs, ns) => (xs?.length ? xs.map((x) => t(ns + x)).join(', ') : null);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6 }}>
        <T weight="800" size={18}>{a.official.display_name}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Tag label={t('oav.state.' + a.state)} color={STATE_TONE[a.state] ?? c.violetSoft} />
          <Tag label={t(hours)} color={a.inside_hours === false ? c.sun : c.violetSoft} />
        </View>
        <T size={12.5} color={c.mute}>{timeIn(match.starts_at, tz)} – {timeIn(match.ends_at, tz)} · {t('oavo.tz', { tz })}</T>
      </View>

      {!a.has_set_availability ? <Empty emoji="🗓️" title={t('oavo.unset_title')} sub={t('oavo.unset_sub')} /> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={a.load.day} label={t('oavo.m.day')} sub={cap(a.load.max_per_day)} tone={a.load.max_per_day && a.load.day >= a.load.max_per_day ? c.sunSoft : undefined} />
        <Metric value={a.load.week} label={t('oavo.m.week')} sub={cap(a.load.max_per_week)} tone={a.load.max_per_week && a.load.week >= a.load.max_per_week ? c.sunSoft : undefined} />
        <Metric value={a.min_notice_hours ? t('oav.n_hours', { n: a.min_notice_hours }) : t('oav.none')} label={t('oavo.m.notice')} />
        <Metric value={a.buffer_min ? t('oav.n_min', { n: a.buffer_min }) : t('oav.none')} label={t('oavo.m.gap')} />
      </View>

      <Card>
        <View style={{ gap: 8 }}>
          <T weight="800" size={15}>{t('oavo.reasons')}</T>
          {a.reasons.length ? a.reasons.map((r) => (
            <View key={r.code} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
              <Tag label={t('oavo.level.' + r.level)} color={LEVEL_TONE[r.level] ?? c.violetSoft} />
              <T size={13.5} style={{ flex: 1 }}>{t('oavo.reason.' + r.code)}</T>
            </View>
          )) : <T size={13.5} color={c.mute}>{t('oavo.clear')}</T>}
        </View>
      </Card>

      <Card>
        <View style={{ gap: 10 }}>
          <View><T weight="800" size={15}>{t('oavo.timeline')}</T><T size={12} color={c.mute}>{t('oavo.timeline_sub')}</T></View>
          {[addDays(day, -1), day, addDays(day, 1)].map((d) => <DayBar key={d} day={d} tz={tz} spans={a.free_busy.spans} match={match} />)}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>{HOUR_MARKS.map((h) => <T key={String(h)} size={10.5} color={c.mute}>{String(h).padStart(2, '0')}</T>)}</View>
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            {[[c.mintSoft, c.line, 'oavo.span.free'], [c.cyan, c.cyan, 'oavo.span.busy'], [c.sun, c.sun, 'oavo.span.tentative'], [c.red, c.red, 'oavo.span.unavailable'], [c.paper, c.ink, 'oavo.span.match']].map(([bg, bd, k]) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: bg, borderWidth: k === 'oavo.span.match' ? 2 : 1, borderColor: bd }} /><T size={11} color={c.mute}>{t(k)}</T></View>
            ))}
          </View>
        </View>
      </Card>

      <Card>
        <View style={{ gap: 2 }}>
          <T weight="800" size={15} style={{ marginBottom: 6 }}>{t('oavo.fit')}</T>
          <Row2 k={t('oavo.fit.sport')} v={t(sport)} />
          <Row2 k={t('oav.pref.levels')} v={list(a.preferences.levels, 'oav.level.')} />
          <Row2 k={t('oav.pref.roles')} v={list(a.preferences.roles, 'oav.role.')} />
          <Row2 k={t('oav.pref.ages')} v={list(a.preferences.age_bands, 'oav.age.')} />
          <Row2 k={t('oavo.fit.area')} v={a.travel.region} />
          <Row2 k={t('oavo.fit.distance')} v={a.travel.band !== 'unknown' ? t('oav.band.' + a.travel.band) : null} />
          <Row2 k={t('oavo.fit.range')} v={t(range)} />
        </View>
      </Card>

      <T size={12} color={c.mute}>🔒 {t('oavo.privacy')}</T>
    </View>
  );
}

/** fixtures: [{ id, label }]. With more than one, the organiser picks which match to check. */
export function OfficialAvailabilitySheet({ visible, onClose, fixtures = [], userId }) {
  const [picked, setPicked] = useState(null);
  const fixtureId = fixtures.some((f) => f.id === picked) ? picked : fixtures[0]?.id;
  return (
    <Sheet visible={!!visible} onClose={onClose} title={t('oavo.title')}>
      {fixtures.length > 1 ? <MenuField label={t('oavo.match_pick')} value={fixtureId} onChange={setPicked} options={fixtures.map((f) => ({ value: f.id, label: f.label }))} /> : null}
      {visible && fixtureId && userId ? <Body key={fixtureId + userId} fixtureId={fixtureId} userId={userId} /> : null}
    </Sheet>
  );
}
