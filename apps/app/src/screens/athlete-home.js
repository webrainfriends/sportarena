import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Seg, Tag, T } from '../ui';
import { HScroll } from '../pickers';
import { c } from '../theme';
import { dateTimeIn, localDate } from '../vtime';
import { locale } from '../locale';
import { AddBlockButton, BlockSheet, MonthGrid, RsvpBar } from './schedule-calendar';

export const KINDS = [['match', 'Matches'], ['team', 'Team'], ['event', 'Events'], ['training', 'Coaching'], ['health', 'Health'], ['venue', 'Venues'], ['duty', 'Duty'], ['recovery', 'Recovery']];
const ICON = { match: '🏟️', team: '👥', event: '🏆', training: '🏋️', venue: '📍', health: '🩺', duty: '📋', recovery: '🧘' };
// Colour-coded pills: match = red, training/coaching = blue, recovery/health = green, everything else neutral.
const TONE = { match: [c.red, c.redSoft], training: [c.cyan, c.cyanSoft], health: [c.mint, c.mintSoft], recovery: [c.mint, c.mintSoft] };
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
  const archive = async () => {
    setBusy(true);
    try { await api.post(`/me/blocks/${x.source_id}/archive`); toast('Removed from your calendar'); await reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const open = () => {
    const { screen, params = {} } = x.link ?? {};
    if (x.kind === 'recovery') return;
    if (screen === 'Health') nav.push('Health');
    else if (screen === 'Event' && params.id) nav.push('Event', params);
    else if (['CoachCommitments', 'CoachPlan', 'MyPlans', 'Games'].includes(screen) && (screen !== 'CoachPlan' || params.id)) nav.push(screen, params);
    else if (x.kind === 'duty' || x.kind === 'event') nav.goTab('Play');
    else nav.goTab(x.kind === 'training' ? 'Player' : x.kind === 'venue' ? 'Book' : 'Play');
  };
  const when = x.all_day ? new Date(x.starts_at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : dateTimeIn(x.starts_at, x.timezone);
  const label = `${x.title}. ${when}. ${STATUS[x.status] ?? x.status}${x.conflict ? '. Overlaps another commitment' : ''}`;
  return (
    <Card onPress={open} style={{ minHeight: 44, borderLeftWidth: 4, borderLeftColor: (TONE[x.kind] ?? [c.line])[0] }}>
      <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <T size={22}>{ICON[x.kind]}</T>
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={2}>{x.title}</T>
            <T size={13} color={c.mute}>{when}{x.timezone && x.timezone !== 'UTC' ? ` (${x.timezone})` : ''}{x.context ? ` · ${x.context}` : ''}</T>
          </View>
          <Tag label={STATUS[x.status] ?? x.status} color={x.action_required ? c.sunSoft : (TONE[x.kind] ?? [0, c.violetSoft])[1]} />
        </View>
        {x.conflict ? <T size={13} weight="700" color={c.red}>⚠ Overlaps another commitment. Nothing was changed, so check each one.</T> : null}
        {x.rsvp ? <RsvpBar x={x} reload={reload} /> : null}
        {x.actions?.includes('archive_athlete_block') ? <View style={{ flexDirection: 'row' }}><Btn small title="Remove" color={c.paper} ink={c.ink} disabled={busy} onPress={archive} /></View> : null}
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

const RANGES = [['today', 'Today', 1], ['week', '7 days', 7], ['month', '30 days', 30]];
const VIEWS = [...RANGES.map(([value, label]) => ({ value, label })), { value: 'month-view', label: 'Calendar' }];
const addDaysIso = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/**
 * Everything on the person's calendar, whatever their roles: matches, team fixtures, events and tournaments, coaching sessions and
 * commitments, physio/doctor appointments (as patient or provider), venue bookings and duty. Grouped by day, filterable by kind.
 */
export function HomeSchedule() {
  const [range, setRange] = useState('today'), [kind, setKind] = useState(null);
  const [month, setMonth] = useState(null), [picked, setPicked] = useState(null), [block, setBlock] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date().toISOString(), zone);
  const days = (RANGES.find((r) => r[0] === range) ?? [0, 0, 1])[2];
  const inMonth = range === 'month-view';
  const mon = month ?? today.slice(0, 7);
  const lastOfMonth = `${mon}-${String(new Date(Date.UTC(+mon.slice(0, 4), +mon.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
  const sched = useLoad(() => api.get('/me/sport-schedule', inMonth ? { from: `${mon}-01`, to: lastOfMonth } : { from: today, to: addDaysIso(today, days - 1) }), [range, mon]);
  const all = sched.data?.items ?? [];
  const items = all.filter((x) => (!kind || x.kind === kind) && (!inMonth || !picked || localDate(x.starts_at, x.all_day ? 'UTC' : zone) === picked));
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
        <AddBlockButton onPress={() => setBlock(true)} />
      </View>
      <Seg options={VIEWS} value={range} onChange={(v) => { setRange(v); if (v === 'month-view') setPicked(today); }} color={c.pink} />
      {inMonth ? <MonthGrid month={mon} onMonth={(m) => { setMonth(m); setPicked(null); }} items={all} selected={picked} onSelect={(d) => setPicked(picked === d ? null : d)} /> : null}
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
          {!items.length ? <Empty emoji="🗓️" title={kind ? 'Nothing of this kind' : range === 'today' ? 'Rest day' : 'A clear stretch'} sub={kind ? 'Try another filter or a longer range.' : range === 'today' ? 'Nothing scheduled today. Recovery counts too. Switch to 7 or 30 days to see what is coming.' : 'Matches, events, coaching, appointments and bookings all land here as soon as you add them.'} /> : null}
        </>
      )}
      <BlockSheet visible={block} date={inMonth ? picked ?? undefined : undefined} onClose={() => setBlock(false)} onDone={sched.reload} />
    </View>
  );
}
