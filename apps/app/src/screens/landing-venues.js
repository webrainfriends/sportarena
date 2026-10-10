import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { T } from '../ui';
import { c } from '../theme';
import { addDays, dayLabel, moneyIn, timeIn, todayIn } from '../vtime';

/** Horizontal scroller with ◀ ▶ buttons, so every chip is reachable without a trackpad or touch. */
export function HScroll({ children, gap = 8, style }) {
  const ref = useRef(null);
  const [m, setM] = useState({ x: 0, w: 0, cw: 0 });
  const left = m.x > 4, right = m.cw - m.w - m.x > 4;
  const by = (dir) => ref.current?.scrollTo({ x: Math.max(0, m.x + dir * Math.max(160, m.w * 0.7)), animated: true });
  const Arrow = ({ dir, show }) => (show ? (
    <Pressable onPress={() => by(dir)} accessibilityRole="button" accessibilityLabel={dir < 0 ? 'Scroll left' : 'Scroll right'}
      style={{ position: 'absolute', top: 0, bottom: 0, [dir < 0 ? 'left' : 'right']: 0, width: 34, alignItems: dir < 0 ? 'flex-start' : 'flex-end', justifyContent: 'center', zIndex: 2 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
        <T weight="800" size={15} color={c.ink}>{dir < 0 ? '‹' : '›'}</T>
      </View>
    </Pressable>
  ) : null);
  return (
    <View style={[{ position: 'relative', minWidth: 0 }, style]}>
      <ScrollView ref={ref} horizontal showsHorizontalScrollIndicator={false} scrollEventThrottle={32}
        onScroll={(e) => setM((p) => ({ ...p, x: e.nativeEvent.contentOffset.x }))}
        onLayout={(e) => setM((p) => ({ ...p, w: e.nativeEvent.layout.width }))}
        onContentSizeChange={(cw) => setM((p) => ({ ...p, cw }))}
        contentContainerStyle={{ gap, alignItems: 'center', paddingHorizontal: 2 }}>
        {children}
      </ScrollView>
      <Arrow dir={-1} show={left} /><Arrow dir={1} show={right} />
    </View>
  );
}

const Pill = ({ on, onPress, children }) => (
  <Pressable onPress={onPress} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: on ? c.ink : c.paper, borderWidth: 1, borderColor: on ? c.ink : c.line }}>
    <T size={13} weight="700" color={on ? '#fff' : '#334155'}>{children}</T>
  </Pressable>
);

/**
 * Public "Book a venue": pick a venue, a day and see every court's open slots with prices.
 * Tapping a slot (or "Book") asks the visitor to log in / create an account, then drops them into the booking flow.
 */
export function VenueBooking({ wide, sport, onBook }) {
  const list = useLoad(() => api.get('/venues', { sport: sport ?? undefined, limit: 24 }), [sport]);
  const [venueId, setVenueId] = useState(null);
  const venues = list.data ?? [];
  const vid = venues.some((v) => v.id === venueId) ? venueId : venues[0]?.id ?? null;
  const venue = venues.find((v) => v.id === vid);
  const [date, setDate] = useState(null);
  const day = date ?? todayIn(venue?.timezone ?? 'UTC');
  const days = Array.from({ length: 14 }, (_, i) => addDays(todayIn(venue?.timezone ?? 'UTC'), i));
  const grid = useLoad(() => (vid ? api.get(`/venues/${vid}/availability`, { date: day, sport: sport ?? undefined }) : Promise.resolve(null)), [vid, day, sport]);
  const g = grid.data;
  const tz = g?.venue.timezone ?? 'UTC';

  if (!list.loading && !venues.length) return (
    <View style={{ padding: 28, backgroundColor: c.paper, borderRadius: 24, borderWidth: 1, borderColor: c.line, alignItems: 'center', gap: 6 }}>
      <T size={40}>🏟️</T><T weight="800" size={18}>{sport ? 'No venues for this sport yet' : 'No venues have joined yet'}</T>
      <T color={c.mute} style={{ textAlign: 'center' }}>Own a facility? Join free and list your courts so players can book them.</T>
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <HScroll gap={10}>
        {venues.map((v) => (
          <Pressable key={v.id} onPress={() => { setVenueId(v.id); setDate(null); }} style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 16, backgroundColor: v.id === vid ? c.pinkSoft : c.paper, borderWidth: 1.5, borderColor: v.id === vid ? c.pink : c.line, minWidth: 150 }}>
            <T weight="800" size={14} numberOfLines={1}>{v.emoji} {v.name}</T>
            <T size={12} color={c.mute} numberOfLines={1}>{[v.city, v.min_hourly_rate_cents != null && `from ${moneyIn(v.min_hourly_rate_cents, v.currency)}/hr`].filter(Boolean).join(' · ') || ' '}</T>
          </Pressable>
        ))}
      </HScroll>
      {venue ? (
        <View style={{ backgroundColor: c.paper, borderRadius: 24, borderWidth: 1, borderColor: c.line, padding: wide ? 22 : 14, gap: 14 }}>
          <HScroll gap={6}>
            {days.map((d, i) => <Pill key={d} on={d === day} onPress={() => setDate(d)}>{dayLabel(d, i)}</Pill>)}
          </HScroll>
          {grid.loading && !g ? <T color={c.mute}>Checking availability…</T> : grid.error ? <T color={c.red} weight="600">{grid.error.message ?? String(grid.error)}</T> : (g?.resources ?? []).filter((r) => r.kind !== 'equipment').map((r) => {
            const free = r.slots.filter((s) => s.status === 'free');
            return (
              <View key={r.id} style={{ gap: 8, borderTopWidth: 1, borderColor: c.line, paddingTop: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T weight="800" size={16}>{r.name}</T>
                    <T size={12} color={c.mute}>{[r.sport && `${r.sport_emoji ?? ''} ${r.sport}`, r.indoor != null && (r.indoor ? 'Indoor' : 'Outdoor'), `${r.slot_minutes}-min slots`].filter(Boolean).join(' · ')}</T>
                  </View>
                  {free.length ? <T size={12} weight="700" color={c.pink}>from {moneyIn(Math.min(...free.map((s) => s.price_cents)), g.venue.currency)}</T> : null}
                </View>
                {free.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {free.map((s) => (
                      <Pressable key={s.starts_at} onPress={() => onBook({ venueId: vid, resourceId: r.id, date: day, venueName: venue.name })} accessibilityRole="button" accessibilityLabel={`Book ${r.name} at ${timeIn(s.starts_at, tz)}`}
                        style={{ borderRadius: 12, borderWidth: 1.5, borderColor: c.line, paddingVertical: 8, paddingHorizontal: 10, minWidth: 84, alignItems: 'center' }}>
                        <T weight="700" size={13}>{timeIn(s.starts_at, tz)}</T>
                        <T size={11} color={c.mute}>{moneyIn(s.price_cents, g.venue.currency)}</T>
                      </Pressable>
                    ))}
                  </View>
                ) : <T color={c.mute} size={13}>{r.slots.length ? 'Fully booked this day — try another date.' : 'Closed this day.'}</T>}
              </View>
            );
          })}
          {g && !g.resources.some((r) => r.kind !== 'equipment') ? <T color={c.mute}>This venue has not listed any courts yet.</T> : null}
          <Pressable onPress={() => onBook({ venueId: vid, date: day, venueName: venue.name })} style={{ alignSelf: 'flex-start', backgroundColor: c.pink, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 24 }}>
            <T color="#fff" weight="800">Log in to book {venue.name}</T>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
