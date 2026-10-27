import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card as BaseCard, Chip, Empty, ErrorBox, H1, HScroll, Loading, Screen, Seg, T, Tag } from '../ui';
import { SportSelect } from '../sportpicker';
import { currentPosition } from '../location';
import { c, when } from '../theme';
import { locale } from '../locale';
import { useCols } from './marketplace';
import { HostGameSheet } from './host-game';

/** A card whose content is spaced, so a title never touches the line under it. */
const Card = ({ children, gap = 6, ...p }) => <BaseCard {...p}><View style={{ gap }}>{children}</View></BaseCard>;

const LEVELS = [['beginner', 'Beginner'], ['amateur', 'Amateur'], ['semi_pro', 'Semi-pro'], ['pro', 'Pro']];
const WHEN = [['now', 'Now'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'This weekend'], ['week', 'This week'], ['any', 'Any day']];
const SORT = [['soonest', 'Soonest'], ['distance', 'Nearest'], ['best_match', 'Best match']];
export const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** Money in the game's own currency; nothing is assumed to be rupees. */
export const price = (cents, currency) => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100); } catch { return `${currency} ${(cents / 100).toFixed(2)}`; } };
export const costLabel = (g) => (g.cost.mode === 'free' ? 'Free' : `${price(g.cost.per_player_cents, g.cost.currency)} each`);
export const BOOKING = { confirmed: ['Court booked ✓', c.mint], unbooked: ['Court not booked yet', c.sun], cancelled: ['Booking cancelled', c.red], no_venue: ['Public place', c.violetSoft] };
export const STATUS = { confirmed: ['You are in', c.mint], requested: ['Waiting for host', c.sun], waitlisted: ['On the waitlist', c.sun], guardian_pending: ['Waiting for a guardian', c.sun], declined: ['Declined', c.red], removed: ['Removed', c.red], cancelled: ['You left', c.violetSoft] };

/** Row of seat dots: filled = taken. Never more than 12 so it stays readable on a phone. */
export function Seats({ g }) {
  const n = Math.min(g.max_players, 12), filled = Math.min(g.taken, n);
  return (
    <View accessible accessibilityLabel={`${g.taken} of ${g.max_players} seats taken`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>{Array.from({ length: n }, (_, k) => <View key={k} style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: k < filled ? c.ink : 'transparent', borderWidth: 1.5, borderColor: c.ink }} />)}</View>
      <T size={13} weight="700" color={g.is_full ? c.red : c.ink}>{g.is_full ? `Full${g.waitlist ? ` · ${g.waitlist} waiting` : ''}` : `${g.slots_left} seat${g.slots_left === 1 ? '' : 's'} left`}</T>
    </View>
  );
}

export function GameCard({ g, width, onOpen }) {
  const km = g.distance_km != null ? (g.distance_km < 1 ? 'under 1 km' : `~${Math.round(g.distance_km)} km`) : null;
  const [bl, bc] = BOOKING[g.booking_state] ?? BOOKING.no_venue;
  const mine = g.my_status && STATUS[g.my_status];
  return (
    <View style={{ width }}>
      <Card onPress={onOpen} accessibilityLabel={`${g.sport} game, ${when(g.starts_at)}, ${g.place.name}, ${g.slots_left} seats left`} pad={16}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <T size={22}>{g.sport_emoji}</T>
            <T weight="800" size={13} color={c.mute} style={{ flex: 1 }}>{g.sport}{g.format ? ` · ${g.format}` : ''}</T>
            {mine ? <Tag label={mine[0]} color={mine[1]} /> : <Tag label={costLabel(g)} color={g.cost.mode === 'free' ? c.mint : c.violetSoft} />}
          </View>
          <T weight="800" size={17}>{g.title}</T>
          <T weight="700" color={c.pink}>{when(g.starts_at)}</T>
          <T size={13} color={c.mute}>📍 {g.place.name}{g.place.city ? `, ${g.place.city}` : ''}{km ? ` · ${km}` : ''}</T>
          <Seats g={g} />
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            <Tag label={g.skill.label} />
            {g.audience !== 'adults' ? <Tag label={g.audience === 'youth' ? 'Young players' : 'All ages'} color={c.cyan} /> : null}
            {g.venue_id ? <Tag label={bl} color={bc} /> : null}
            {g.has_team ? <Tag label={`${g.team_emoji ?? ''} ${g.team_name}`.trim()} color={c.sun} /> : null}
          </View>
          {g.reasons?.length ? (
            <View style={{ gap: 3 }} accessible accessibilityLabel={`Why suggested: ${g.reasons.map((r) => r.text).join('. ')}`}>
              <T size={11} weight="800" color={c.mute} style={{ letterSpacing: 0.8 }}>WHY THIS GAME</T>
              {g.reasons.map((r) => <T key={r.kind} size={12} color={r.ok ? c.ink : c.red}>{r.ok ? '✓' : '•'} {r.text}</T>)}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <Avatar user={{ ...g.host, avatar_emoji: g.host.avatar_emoji }} size={28} />
            <T size={13} style={{ flex: 1 }}>Hosted by <T weight="800" size={13}>{g.host.display_name}</T>{g.host.verified ? ' ✓' : ''}</T>
          </View>
        </View>
      </Card>
    </View>
  );
}

/** A guardian's queue: young people they look after who asked to join a game. Approving needs their current consent for taking part. */
function GuardianRequests() {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/me/open-game-guardian-requests', { limit: 20 }), []);
  const { push } = useNav();
  const decide = async (r, decision) => { try { await api.post(`/open-games/${r.open_game_id}/members/${r.member_id}/guardian-decision`, { decision }); toast(decision === 'approve' ? 'Approved' : 'Declined'); q.reload(); } catch (e) { toast(e.message); } };
  if (!q.data?.length) return null;
  return (
    <View style={{ gap: 10, marginTop: 14 }}>
      <T weight="800" size={13} color={c.mute} style={{ letterSpacing: 0.8 }}>WAITING FOR YOUR APPROVAL</T>
      {q.data.map((r) => (
        <Card key={r.member_id} pad={14} color={c.sunSoft} style={{ gap: 4 }}>
          <T weight="800">{r.child_name} asked to join {r.title}</T>
          <T size={13}>{r.sport} · {when(r.starts_at)} · {r.venue_name ?? r.location}{r.cost_mode !== 'free' ? ' · costs money' : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Btn small title="Approve" onPress={() => decide(r, 'approve')} /><Btn small title="Decline" color={c.paper} ink={c.red} onPress={() => decide(r, 'decline')} /><Btn small title="View game" color={c.paper} ink={c.ink} onPress={() => push('OpenGame', { id: r.open_game_id })} />
          </View>
        </Card>
      ))}
    </View>
  );
}

/** Find & join games: phone-first journeys (now / today / this weekend), distance only from a point sent for the search, reasons for every suggestion. */
export function FindGames() {
  const { user, toast } = useSession();
  const { push } = useNav();
  const { w, gap } = useCols();
  const [tab, setTab] = useState('find');
  const [whenKey, setWhen] = useState('week');
  const [sport, setSport] = useState(null);
  const [pos, setPos] = useState(null);
  const [radius, setRadius] = useState(25);
  const [level, setLevel] = useState(null);
  const [free, setFree] = useState(false);
  const [seats, setSeats] = useState(false);
  const [verified, setVerified] = useState(false);
  const [sort, setSort] = useState('soonest');
  const [host, setHost] = useState(false);
  const [locating, setLocating] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => { if (sort === 'distance' && !pos) setSort('soonest'); }, [pos, sort]);

  const q = tab === 'mine' ? { mine: true, limit: 50 } : {
    sport: sport || undefined, when: whenKey === 'any' ? undefined : whenKey, tz: deviceZone(), level: level || undefined, free_only: free || undefined, has_slots: seats || undefined, verified_host: verified || undefined,
    ...(pos ? { lat: pos.lat, lng: pos.lng, radius_km: radius } : {}), sort, limit: 40,
  };
  const games = useLoad(() => api.get('/open-games', q), [JSON.stringify(q)]);
  const near = async () => {
    if (pos) { setPos(null); return; }
    setLocating(true);
    const p = await currentPosition();
    setLocating(false);
    if (p) setPos(p); else toast('Location is off. Allow it in your settings, or search by sport and day instead.');
  };
  const extra = [level, free, seats, verified, sort !== 'soonest'].filter(Boolean).length;
  const sorts = SORT.filter(([k]) => (k !== 'distance' || pos) && (k !== 'best_match' || user));

  return (
    <Screen wide>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
        <View style={{ flexShrink: 1 }}>
          <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>FIND A GAME</T>
          <H1 style={{ fontSize: 28 }}>Where can I play?</H1>
          <T size={14} color={c.mute} style={{ marginTop: 2 }}>Open games at real venues. Your location is used for this search only.</T>
        </View>
        <Btn small title="+ Host a game" onPress={() => (user ? setHost(true) : toast('Sign in to host a game'))} accessibilityLabel="Host a game" />
      </View>
      {user ? <View style={{ marginTop: 14 }}><Seg options={[{ value: 'find', label: 'Find games' }, { value: 'mine', label: 'My games' }]} value={tab} onChange={setTab} /></View> : null}
      {user ? <GuardianRequests /> : null}
      {tab === 'find' ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          <HScroll>{WHEN.map(([k, label]) => <Chip key={k} label={label} active={whenKey === k} onPress={() => setWhen(k)} />)}</HScroll>
          <SportSelect value={sport} onChange={setSport} allLabel="All sports" />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip label={locating ? 'Finding you…' : pos ? '📍 Near me ✕' : '📍 Near me'} active={!!pos} onPress={near} />
            {pos ? [5, 10, 25, 50].map((km) => <Chip key={km} label={`${km} km`} active={radius === km} onPress={() => setRadius(km)} />) : null}
            <Chip label={more ? 'Fewer filters ▴' : `More filters${extra ? ` (${extra})` : ''} ▾`} active={more || extra > 0} onPress={() => setMore(!more)} />
          </View>
          {more ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {LEVELS.map(([k, label]) => <Chip key={k} label={label} active={level === k} onPress={() => setLevel(level === k ? null : k)} />)}
                <Chip label="Free" active={free} onPress={() => setFree(!free)} />
                <Chip label="Seats left" active={seats} onPress={() => setSeats(!seats)} />
                <Chip label="Verified host" active={verified} onPress={() => setVerified(!verified)} />
              </View>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <T size={12} weight="700" color={c.mute}>SORT</T>
                {sorts.map(([k, label]) => <Chip key={k} label={label} active={sort === k} onPress={() => setSort(k)} />)}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
      {games.error ? <ErrorBox error={games.error} onRetry={games.reload} /> : games.loading && !games.data ? <Loading /> : !games.data?.length ? (
        <View style={{ marginTop: 18 }}>
          <Empty emoji="🏟️" title={tab === 'mine' ? 'You are not in any games yet' : 'No games match'} sub={tab === 'mine' ? 'Find a game, or host one and invite people.' : 'Try another day, a bigger distance or fewer filters — or host the game yourself.'} />
          {tab === 'find' && user ? <Btn title="Host a game" onPress={() => setHost(true)} style={{ marginTop: 10, alignSelf: 'center' }} /> : null}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, marginTop: 14 }}>
          {games.data.map((g) => <GameCard key={g.id} g={g} width={w} onOpen={() => push('OpenGame', { id: g.id })} />)}
        </View>
      )}
      {host ? <HostGameSheet onClose={() => setHost(false)} onDone={(g) => { setHost(false); games.reload(); push('OpenGame', { id: g.id }); }} /> : null}
      {Platform.OS === 'web' ? null : <View style={{ height: 8 }} />}
    </Screen>
  );
}
