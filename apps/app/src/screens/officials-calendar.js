// The official's calendar (#994): the Calendar tab of Officials Home. Confirmed matches hold a reserved slot, unanswered requests are a
// tentative hold, and time off (one-off, repeating, public holidays) and extra open windows sit beside them. Every entry is read live from
// its source record; nothing is copied into a second calendar. Times are in the official's own zone, with the venue's time beside it when
// the venue is in another zone.
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { Card, Empty, Loading, Seg, T, Tag } from '../ui';
import { MenuField } from '../menu-field';
import { Calendar, monthOf } from '../pickers';
import { LoadError } from '../access';
import { c } from '../theme';
import { Banner, Metric } from '../federation-ui';
import { addDays, dateTimeIn, localToIso, longDay, timeIn, todayIn } from '../vtime';
import { t } from '../i18n';

const ROLES = ['referee', 'umpire', 'linesman', 'scorer', 'video_assistant_referee', 'fourth_official', 'reserve_assistant_referee', 'shot_clock_operator', 'timekeeper', 'goal_line_official', 'technical_official'];
const TONE = { reserved: [c.mint, c.mintSoft], tentative: [c.sun, c.sunSoft], time_off: [c.cyan, c.cyanSoft], holiday: [c.violet, c.violetSoft], open_window: [c.lime, c.limeSoft], deadline: [c.red, c.redSoft], done: [c.line, c.paper] };
const toneOf = (e) => TONE[e.hold ?? (e.kind === 'assignment' ? 'done' : e.kind)] ?? TONE.done;

function Entry({ e, tz, onOpen }) {
  const [bar] = toneOf(e);
  const flagged = e.clash_with?.length || e.unavailable_with?.length;
  const time = e.all_day ? t('oav.all_day') : e.kind === 'deadline' ? timeIn(e.starts_at, tz) : `${timeIn(e.starts_at, tz)} – ${timeIn(e.ends_at, tz)}`;
  const head = e.kind === 'assignment' ? (e.hold ? t(`oav.hold.${e.hold}`) : t('ocal.completed')) : t(`ocal.kind.${e.kind}`);
  return (
    <Card onPress={e.fixture_id ? onOpen : undefined} pad={0} accessibilityLabel={[head, e.title, dateTimeIn(e.starts_at, tz)].join(', ')}
      style={e.hold === 'tentative' ? { borderStyle: 'dashed', borderWidth: 1.5, borderColor: c.sun } : flagged ? { borderWidth: 1.5, borderColor: c.red } : null}>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: 6, backgroundColor: bar, borderTopStartRadius: 16, borderBottomStartRadius: 16 }} />
        <View style={{ flex: 1, padding: 14, gap: 6 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Tag label={head} color={e.kind === 'holiday' || !e.hold && e.kind === 'assignment' ? c.violetSoft : bar} />
            {e.role ? <Tag label={t(`oav.role.${e.role}`)} color={c.violetSoft} /> : null}
            {e.repeats ? <Tag label={'🔁 ' + t('oav.rep.tag')} color={c.cyan} /> : null}
            {e.category && e.kind === 'time_off' ? <Tag label={t(`oav.cat.${e.category}`)} color={c.violetSoft} /> : null}
            {e.locked_at ? <Tag label={'🔒 ' + t('officials.lock.badge')} color={c.pinkSoft} /> : null}
            {e.hold === 'reserved' && e.reporting_min > 0 ? <Tag label={'⏱ ' + t('officials.arrive_by', { time: timeIn(new Date(new Date(e.starts_at).getTime() - e.reporting_min * 60000).toISOString(), tz) })} color={c.cyan} /> : null}
            {e.needs_ack ? <Tag label={'🔔 ' + t('ocal.flag.changed')} color={c.sun} /> : null}
            {e.clash_with?.length ? <Tag label={'⚠️ ' + t('ocal.flag.clash')} color={c.red} /> : null}
            {e.unavailable_with?.length ? <Tag label={'⚠️ ' + t('ocal.flag.time_off')} color={c.red} /> : null}
            {e.rival_requests?.length ? <Tag label={t('ocal.flag.rival', { n: e.rival_requests.length })} color={c.sun} /> : null}
            {e.outside_availability ? <Tag label={t('ocal.flag.outside')} color={c.sun} /> : null}
          </View>
          <T weight="800" size={16}>{e.kind === 'time_off' ? t('ocal.unavailable') : e.kind === 'open_window' ? t('oav.extra.tag') : e.title}</T>
          <T size={13} weight="700">{time}{e.sport ? ` · ${e.sport.emoji ?? ''} ${e.subtitle ?? ''}` : ''}</T>
          {e.venue_timezone ? <T size={12.5} color={c.mute}>🌍 {t('ocal.venue_time', { time: timeIn(e.starts_at, e.venue_timezone), zone: e.venue_timezone })}</T> : null}
          {e.venue ? <T size={12.5} color={c.mute}>📍 {e.venue}</T> : null}
          {e.kind !== 'assignment' && e.subtitle ? <T size={12.5} color={c.mute}>{e.kind === 'time_off' ? '🔒 ' : ''}{e.subtitle}</T> : null}
        </View>
      </View>
    </Card>
  );
}

export function CalendarTab({ tz, go, sportId }) {
  const L = useLayout();
  const today = todayIn(tz);
  const [view, setView] = useState('week');
  const [role, setRole] = useState('');
  const [show, setShow] = useState('all');
  const [month, setMonth] = useState(monthOf(today));
  const [day, setDay] = useState(today);
  // the range is cut on the official's own midnights, so a match never lands in the wrong day for someone far from the device's zone
  const range = useMemo(() => {
    if (view === 'month') {
      const [y, m] = month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      return [localToIso(`${month}-01`, '00:00', tz), localToIso(`${next}-01`, '00:00', tz)];
    }
    return [localToIso(today, '00:00', tz), localToIso(addDays(today, view === 'today' ? 1 : 7), '00:00', tz)];
  }, [view, month, today, tz]);
  const q = useLoad(() => api.get('/me/officials/calendar', { from: range[0], to: range[1], ...(sportId ? { sport_id: sportId } : {}), ...(role ? { role } : {}) }), [range[0], range[1], sportId, role]);
  const entries = q.data?.entries ?? [];
  const filtered = entries.filter((e) => show === 'all' || (show === 'reserved' && e.hold === 'reserved') || (show === 'tentative' && e.hold === 'tentative') || (show === 'off' && ['time_off', 'holiday'].includes(e.kind)));
  const shown = view === 'month' ? filtered.filter((e) => e.local_date === day) : filtered;
  const marks = useMemo(() => (q.data?.days ?? []).map((d) => ({ date: d.date, status: d.conflicts ? 'full' : d.reserved ? 'available' : d.tentative ? 'limited' : 'closed' })), [q.data]);
  const byDay = useMemo(() => { const m = new Map(); for (const e of shown) { if (!m.has(e.local_date)) m.set(e.local_date, []); m.get(e.local_date).push(e); } return [...m]; }, [shown]);
  const tot = q.data?.totals ?? { reserved: 0, tentative: 0, blocked: 0 };

  const agenda = q.error && !q.data ? <LoadError error={q.error} onRetry={q.reload} /> : !q.data ? <Loading /> : byDay.length ? (
    <View style={{ gap: 14 }}>
      {byDay.map(([d, list]) => (
        <View key={d} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T weight="800" size={14}>{d === today ? t('ocal.today') : longDay(d)}</T>
            <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
            <T size={12} color={c.mute}>{t('ocal.day_count', { n: list.filter((e) => e.kind === 'assignment').length })}</T>
          </View>
          {list.map((e) => <Entry key={`${e.source_type}${e.source_id}${e.occurrence ?? ''}`} e={e} tz={tz} onOpen={() => go('OfficialMatch', { id: e.fixture_id })} />)}
        </View>
      ))}
    </View>
  ) : <Empty emoji="📅" title={t('ocal.empty_title')} sub={view === 'month' ? t('ocal.empty_day') : t('ocal.empty_range')} />;

  const filters = (
    <View style={{ gap: 10 }}>
      <Seg options={[{ value: 'today', label: t('ocal.view.today') }, { value: 'week', label: t('ocal.view.week') }, { value: 'month', label: t('ocal.view.month') }]} value={view} onChange={setView} />
      <Seg options={[{ value: 'all', label: t('ocal.show.all') }, { value: 'reserved', label: t('oav.hold.reserved') }, { value: 'tentative', label: t('oav.hold.tentative') }, { value: 'off', label: t('ocal.show.off') }]} value={show} onChange={setShow} color={c.pink} />
      <MenuField label={t('ocal.role')} value={role} onChange={setRole} options={[{ value: '', label: t('ocal.all_roles') }, ...ROLES.map((r) => ({ value: r, label: t(`oav.role.${r}`) }))]} />
    </View>
  );
  const monthCard = view === 'month' ? (
    <Card>
      <Calendar month={month} onMonth={setMonth} value={day} onChange={setDay} today={today} days={marks} legend={[['available', t('oav.hold.reserved')], ['limited', t('oav.hold.tentative')], ['full', t('ocal.m.conflicts')], ['closed', t('ocal.show.off')]]} />
    </Card>
  ) : null;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Metric value={tot.reserved} label={t('ocal.m.reserved')} tone={c.mintSoft} onPress={() => setShow('reserved')} />
        <Metric value={tot.tentative} label={t('ocal.m.tentative')} tone={tot.tentative ? c.sunSoft : undefined} onPress={() => setShow('tentative')} />
        <Metric value={tot.blocked} label={t('ocal.m.blocked')} tone={tot.blocked ? c.cyanSoft : undefined} onPress={() => setShow('off')} />
        <Metric value={q.data?.conflicts ?? 0} label={t('ocal.m.conflicts')} tone={q.data?.conflicts ? c.redSoft : undefined} />
      </View>
      {q.data?.conflicts ? <Banner tone={c.redSoft}>⚠️ {t('ocal.conflict_banner', { n: q.data.conflicts })}</Banner> : null}
      {L.tablet ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ flex: 2, gap: 12 }}>{filters}{monthCard}</View>
          <View style={{ flex: 3 }}>{agenda}</View>
        </View>
      ) : <>{filters}{monthCard}{agenda}</>}
      <T size={12} color={c.mute}>{t('ocal.foot', { tz, n: q.data?.buffer_min ?? 0 })}</T>
    </View>
  );
}
