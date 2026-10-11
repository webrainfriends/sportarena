import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, H2, Loading, Screen, Section, Seg, Tag, T } from '../ui';
import { HScroll } from '../pickers';
import { c } from '../theme';
import { dateTimeIn, localDate } from '../vtime';
import { locale } from '../locale';

export const KINDS = [['match', 'Matches'], ['team', 'Team'], ['event', 'Events'], ['training', 'Coaching'], ['health', 'Health'], ['venue', 'Venues'], ['duty', 'Duty']];
const ICON = { match: '🏟️', team: '👥', event: '🏆', training: '🏋️', venue: '📍', health: '🩺', duty: '📋' };
const STATUS = { proposed: 'Proposed', awaiting_response: 'Awaiting your response', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', open: 'Open', ongoing: 'Ongoing' };

export const ACTIONS = [
  ['🔎', 'Find a match', (n) => n.goTab('Play')],
  ['🧑‍🏫', 'Find a coach', (n) => n.goTab('Player')],
  ['👥', 'Create team', (n) => n.goTab('Play')],
  ['📍', 'Book venue', (n) => n.goTab('Book')],
  ['🏆', 'Create event', (n) => n.goTab('Play')],
  ['🩺', 'Physio / doctor', (n) => n.push('Health')],
  ['💼', 'Open positions', (n) => n.push('Openings')],
];

export function Item({ x, reload }) {
  const nav = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const respond = async (status) => {
    setBusy(true);
    try { await api.patch(`/squads/${x.source_id}`, { status }); toast(status === 'confirmed' ? 'Confirmed' : 'Declined'); await reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const open = () => {
    const { screen, params = {} } = x.link ?? {};
    if (screen === 'Health') nav.push('Health');
    else if (screen === 'Event' && params.id) nav.push('Event', params);
    else if (['CoachCommitments', 'CoachPlan', 'MyPlans', 'Games'].includes(screen) && (screen !== 'CoachPlan' || params.id)) nav.push(screen, params);
    else if (x.kind === 'duty' || x.kind === 'event') nav.goTab('Play');
    else nav.goTab(x.kind === 'training' ? 'Player' : x.kind === 'venue' ? 'Book' : 'Play');
  };
  const when = x.all_day ? new Date(x.starts_at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : dateTimeIn(x.starts_at, x.timezone);
  const label = `${x.title}. ${when}. ${STATUS[x.status] ?? x.status}${x.conflict ? '. Overlaps another commitment' : ''}`;
  return (
    <Card onPress={open} style={{ minHeight: 44 }}>
      <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <T size={22}>{ICON[x.kind]}</T>
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={2}>{x.title}</T>
            <T size={13} color={c.mute}>{when}{x.timezone && x.timezone !== 'UTC' ? ` (${x.timezone})` : ''}{x.context ? ` · ${x.context}` : ''}</T>
          </View>
          <Tag label={STATUS[x.status] ?? x.status} color={x.action_required ? c.sunSoft : c.violetSoft} />
        </View>
        {x.conflict ? <T size={13} weight="700" color={c.red}>⚠ Overlaps another commitment. Nothing was changed, so check each one.</T> : null}
        {x.actions?.includes('respond_to_selection') ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn small title="Confirm" disabled={busy} onPress={() => respond('confirmed')} />
            <Btn small title="Decline" color={c.paper} ink={c.ink} disabled={busy} onPress={() => respond('declined')} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export function AthleteToday() {
  const nav = useNav();
  const [kind, setKind] = useState(null);
  const sched = useLoad(() => api.get('/me/sport-schedule', kind ? { kinds: kind } : {}), [kind]);
  const items = sched.data?.items ?? [];
  const today = localDate(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const isToday = (x) => localDate(x.starts_at, x.all_day ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone) === today;
  const todays = items.filter(isToday);
  const inbox = items.filter((x) => x.action_required);

  return (
    <Screen refreshing={sched.loading && !!sched.data} onRefresh={sched.reload}>
      <H2>My sport</H2>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {ACTIONS.map(([emoji, label, go]) => <Btn key={label} small color={c.paper} ink={c.ink} title={`${emoji} ${label}`} onPress={() => go(nav)} />)}
      </View>

      {sched.loading && !sched.data ? <Loading /> : sched.error ? <ErrorBox error={sched.error} onRetry={sched.reload} /> : (
        <>
          {inbox.length ? <Section title={`Needs your response (${inbox.length})`}><View style={{ gap: 10 }}>{inbox.map((x) => <Item key={`i${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />)}</View></Section> : null}
          <Section title="Today"><View style={{ gap: 10 }}>
            {todays.length ? todays.map((x) => <Item key={`t${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />) : <Empty emoji="🗓️" title="Nothing scheduled today" sub="Find a match, book a venue or hire a coach to fill your week." />}
          </View></Section>
          <Section title="Next 14 days">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }} accessibilityRole="toolbar">
              <Chip label="All" active={!kind} onPress={() => setKind(null)} />
              {KINDS.map(([k, l]) => <Chip key={k} label={l} active={kind === k} onPress={() => setKind(kind === k ? null : k)} />)}
            </View>
            {sched.data?.conflicts ? <T size={13} weight="700" color={c.red} style={{ marginBottom: 8 }}>⚠ {sched.data.conflicts} overlapping commitments</T> : null}
            <View style={{ gap: 10 }}>{items.length ? items.map((x) => <Item key={`w${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />) : <Empty emoji="✨" title="A clear fortnight" sub="Nothing on your calendar yet." />}</View>
          </Section>
        </>
      )}
    </Screen>
  );
}

const RANGES = [['today', 'Today', 1], ['week', '7 days', 7], ['month', '30 days', 30]];
const addDaysIso = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/**
 * Everything on the person's calendar, whatever their roles: matches, team fixtures, events and tournaments, coaching sessions and
 * commitments, physio/doctor appointments (as patient or provider), venue bookings and duty. Grouped by day, filterable by kind.
 */
export function HomeSchedule({ onFull }) {
  const [range, setRange] = useState('week'), [kind, setKind] = useState(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date().toISOString(), zone);
  const days = RANGES.find((r) => r[0] === range)[2];
  const sched = useLoad(() => api.get('/me/sport-schedule', { from: today, to: addDaysIso(today, days - 1) }), [range]);
  const all = sched.data?.items ?? [];
  const items = all.filter((x) => !kind || x.kind === kind);
  const need = items.filter((x) => x.action_required);
  const rest = items.filter((x) => !x.action_required);
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, all.filter((x) => x.kind === k).length]));
  const byDay = new Map();
  for (const x of rest) { const d = localDate(x.starts_at, x.all_day ? 'UTC' : zone); byDay.set(d, [...(byDay.get(d) ?? []), x]); }
  const label = (d) => (d === today ? 'Today' : d === addDaysIso(today, 1) ? 'Tomorrow' : new Date(`${d}T12:00:00`).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'short' }));
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T size={19} weight="700" style={{ letterSpacing: -0.3 }}>My schedule</T>
        {onFull ? <Pressable onPress={onFull}><T size={13} weight="700" color={c.pink}>Full schedule  ›</T></Pressable> : null}
      </View>
      <Seg options={RANGES.map(([value, l]) => ({ value, label: l }))} value={range} onChange={setRange} color={c.pink} />
      <HScroll>
        <Chip label={`All · ${all.length}`} active={!kind} onPress={() => setKind(null)} />
        {KINDS.filter(([k]) => counts[k] || kind === k).map(([k, l]) => <Chip key={k} label={`${ICON[k]} ${l} · ${counts[k]}`} active={kind === k} onPress={() => setKind(kind === k ? null : k)} />)}
      </HScroll>
      {sched.error ? <ErrorBox error={sched.error} onRetry={sched.reload} /> : sched.loading && !sched.data ? <Loading /> : (
        <>
          {sched.data.conflicts ? <T size={13} weight="700" color={c.red}>⚠ {sched.data.conflicts} overlapping commitment{sched.data.conflicts === 1 ? '' : 's'}</T> : null}
          {need.length ? <View style={{ gap: 10 }}><T size={13} weight="800" color={c.sun}>NEEDS YOUR RESPONSE · {need.length}</T>{need.map((x) => <Item key={`n${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />)}</View> : null}
          {[...byDay.entries()].map(([d, xs]) => (
            <View key={d} style={{ gap: 10 }}>
              <T size={13} weight="800" color={d === today ? c.pink : c.mute}>{label(d).toUpperCase()}</T>
              {xs.map((x) => <Item key={`${d}${x.source_type}${x.source_id}`} x={x} reload={sched.reload} />)}
            </View>
          ))}
          {!items.length ? <Empty emoji="🗓️" title={kind ? 'Nothing of this kind' : range === 'today' ? 'Nothing scheduled today' : 'A clear stretch'} sub={kind ? 'Try another filter or a longer range.' : 'Matches, events, coaching, appointments and bookings all land here as soon as you add them.'} /> : null}
        </>
      )}
    </View>
  );
}
