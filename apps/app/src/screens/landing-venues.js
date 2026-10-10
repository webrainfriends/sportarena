import React, { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { T } from '../ui';
import { c } from '../theme';
import { DayStrip, HScroll } from '../pickers';
import { longDay, moneyIn, timeIn, todayIn } from '../vtime';

export { HScroll };

const Stars = ({ v }) => (v.reviews ? <T size={12} weight="700" color="#fff">★ {Number(v.rating).toFixed(1)} <T size={11} color="#E2E8F0">({v.reviews})</T></T> : <T size={11} weight="700" color="#fff">New</T>);

/** Photo card for one venue: cover, rating, price-from. */
function VenueTile({ v, on, onPress }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={v.name}
      style={{ width: 210, borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: on ? c.pink : 'transparent', backgroundColor: c.paper }}>
      <View style={{ height: 118, backgroundColor: c.violetSoft }}>
        {v.cover_url ? <Image source={{ uri: mediaUrl(v.cover_url) }} resizeMode="cover" style={{ width: '100%', height: '100%' }} /> : <LinearGradient colors={['#059669', '#0EA5E9']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><T size={44}>{v.emoji}</T></LinearGradient>}
        <View style={{ position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(15,23,42,0.72)', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}><Stars v={v} /></View>
        {v.offers ? <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: c.pink, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}><T size={11} weight="700" color="#fff">🏷️ {v.offers} offer{v.offers === 1 ? '' : 's'}</T></View> : null}
      </View>
      <View style={{ padding: 11, gap: 2 }}>
        <T weight="800" size={14} numberOfLines={1}>{v.name}</T>
        <T size={12} color={c.mute} numberOfLines={1}>{[v.city, `${v.resources} court${v.resources === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</T>
        <T size={13} weight="800" color={c.pink}>{v.min_hourly_rate_cents != null ? <>from {moneyIn(v.min_hourly_rate_cents, v.currency)}<T size={11} color={c.mute}>/hr</T></> : ' '}</T>
      </View>
    </Pressable>
  );
}

/**
 * Public "Book a venue": venue photo cards → day strip → each court's slots with prices → one sticky "continue".
 * Nothing is booked here: continuing sends the visitor to log in / create an account, then into the booking flow
 * with the venue, court, date and time already chosen.
 */
export function VenueBooking({ wide, sport, onBook }) {
  const list = useLoad(() => api.get('/venues', { sport: sport ?? undefined, limit: 24 }), [sport]);
  const [venueId, setVenueId] = useState(null);
  const [date, setDate] = useState(null);
  const [pick, setPick] = useState(null);   // { res, slot, date }
  const venues = list.data ?? [];
  const vid = venues.some((v) => v.id === venueId) ? venueId : venues[0]?.id ?? null;
  const venue = venues.find((v) => v.id === vid);
  const tz = venue?.timezone ?? 'UTC';
  const today = todayIn(tz);
  const day = date ?? today;
  const grid = useLoad(() => (vid ? api.get(`/venues/${vid}/availability`, { date: day, sport: sport ?? undefined }) : Promise.resolve(null)), [vid, day, sport]);
  const g = grid.data;
  const cur = g?.venue.currency ?? venue?.currency;
  const courts = (g?.resources ?? []).filter((r) => r.kind !== 'equipment');
  const open = courts.flatMap((r) => r.slots.filter((s) => s.status === 'free').map((s) => ({ res: r, slot: s, date: day }))).sort((a, b) => a.slot.starts_at.localeCompare(b.slot.starts_at));
  const next = open[0];
  const cheapest = open.length ? Math.min(...open.map((o) => o.slot.price_cents)) : null;
  const priced = open.some((o) => o.slot.price_cents !== cheapest);
  const choose = (o) => setPick((p) => (p && p.slot.starts_at === o.slot.starts_at && p.res.id === o.res.id ? null : o));
  const cont = () => onBook(pick ? { venueId: vid, resourceId: pick.res.id, date: pick.date, time: pick.slot.starts_at, venueName: venue.name } : { venueId: vid, date: day, venueName: venue.name });

  if (!list.loading && !venues.length) return (
    <View style={{ padding: 28, backgroundColor: c.paper, borderRadius: 24, borderWidth: 1, borderColor: c.line, alignItems: 'center', gap: 6 }}>
      <T size={40}>🏟️</T><T weight="800" size={18}>{sport ? 'No venues for this sport yet' : 'No venues have joined yet'}</T>
      <T color={c.mute} style={{ textAlign: 'center' }}>Own a facility? Join free and list your courts so players can book them.</T>
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <HScroll gap={12}>{venues.map((v) => <VenueTile key={v.id} v={v} on={v.id === vid} onPress={() => { setVenueId(v.id); setDate(null); setPick(null); }} />)}</HScroll>
      {venue ? (
        <View style={{ backgroundColor: c.paper, borderRadius: 24, borderWidth: 1, borderColor: c.line, padding: wide ? 22 : 14, gap: 14 }}>
          <View>
            <T weight="800" size={wide ? 22 : 18} numberOfLines={1}>{venue.emoji} {venue.name}</T>
            <T size={13} color={c.mute}>{longDay(day)}</T>
          </View>
          <DayStrip from={today} value={day} onChange={(d) => { setDate(d); setPick(null); }} />
          {next ? (
            <Pressable onPress={() => choose(next)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.limeSoft, borderRadius: 16, padding: 12 }}>
              <T size={20}>⚡</T>
              <View style={{ flex: 1 }}><T weight="800" size={14} color={c.lime}>Next available</T><T size={13} color={c.ink}>{next.res.name} · {timeIn(next.slot.starts_at, tz)} · {moneyIn(next.slot.price_cents, cur)}</T></View>
              <T weight="800" size={13} color={c.lime}>Pick →</T>
            </Pressable>
          ) : null}
          {grid.loading && !g ? <T color={c.mute}>Checking availability…</T> : grid.error ? <T color={c.red} weight="600">{grid.error.message ?? String(grid.error)}</T> : courts.map((r) => {
            const slots = r.slots.filter((s) => s.status === 'free' || s.status === 'booked');
            const freeN = slots.filter((s) => s.status === 'free').length;
            return (
              <View key={r.id} style={{ gap: 10, backgroundColor: c.bg, borderRadius: 18, padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T weight="800" size={16}>{r.name}</T>
                    <T size={12} color={c.mute}>{[r.sport && `${r.sport_emoji ?? ''} ${r.sport}`, r.indoor != null && (r.indoor ? 'Indoor' : 'Outdoor'), r.surface, `${r.slot_minutes} min`].filter(Boolean).join(' · ')}</T>
                  </View>
                  <T size={12} weight="700" color={freeN ? c.lime : c.red}>{freeN ? `${freeN} slot${freeN === 1 ? '' : 's'} free` : 'Full'}</T>
                </View>
                {slots.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {slots.map((s) => {
                      const free = s.status === 'free';
                      const on = pick?.res.id === r.id && pick.slot.starts_at === s.starts_at;
                      const best = free && priced && s.price_cents === cheapest;
                      return (
                        <Pressable key={s.starts_at} disabled={!free} onPress={() => choose({ res: r, slot: s, date: day })} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !free }} accessibilityLabel={`${r.name} ${timeIn(s.starts_at, tz)} ${free ? moneyIn(s.price_cents, cur) : 'booked'}`}
                          style={{ borderRadius: 999, borderWidth: 1.5, borderColor: on ? c.pink : free ? c.line : 'transparent', backgroundColor: on ? c.pink : free ? c.paper : c.violetSoft, paddingVertical: 8, paddingHorizontal: 14, minWidth: 92, alignItems: 'center', opacity: free ? 1 : 0.55 }}>
                          <T weight="800" size={13} color={on ? '#fff' : c.ink} style={!free ? { textDecorationLine: 'line-through' } : undefined}>{timeIn(s.starts_at, tz)}</T>
                          <T size={11} weight={best ? '800' : '500'} color={on ? '#E0E7FF' : best ? c.lime : c.mute}>{free ? moneyIn(s.price_cents, cur) : 'Booked'}{best ? ' · best' : ''}</T>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : <T color={c.mute} size={13}>{r.slots.length ? 'No free slots this day. Try another date.' : 'Closed this day.'}</T>}
              </View>
            );
          })}
          {g && !courts.length ? <T color={c.mute}>This venue has not listed any courts yet.</T> : null}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.ink, borderRadius: 20, padding: 14 }}>
            <View style={{ flex: 1 }}>
              <T weight="800" size={15} color="#fff" numberOfLines={1}>{pick ? `${pick.res.name} · ${timeIn(pick.slot.starts_at, tz)}` : 'Pick a time to continue'}</T>
              <T size={12} color="#94A3B8">{pick ? `${longDay(pick.date)} · ${moneyIn(pick.slot.price_cents, cur)} · pay after you log in` : 'You only log in once you have chosen.'}</T>
            </View>
            <Pressable onPress={cont} accessibilityRole="button" style={{ backgroundColor: pick ? c.pink : '#334155', borderRadius: 999, paddingVertical: 12, paddingHorizontal: 22 }}>
              <T color="#fff" weight="800">{pick ? 'Book now' : 'Log in to book'}</T>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
