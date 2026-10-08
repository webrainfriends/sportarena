import React, { useMemo, useState } from 'react';
import { Image, Linking, Platform, Pressable, View } from 'react-native';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useBasket } from '../basket';
import { Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, H1, H2, Loading, Row, Screen, Seg, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Gallery, VenueReviews } from './venue-media';
import { c, grad } from '../theme';
import { addDays, dateTimeIn, dayLabel, hoursSummary, moneyIn, timeIn, todayIn } from '../vtime';

export const KIND = { court: '🏀', ground: '⚽', pool: '🏊', track: '🏃', room: '🧘', equipment: '🎒', table: '🏓', lane: '🎳', rink: '🏒', range: '🎯', studio: '🧘', other: '📍' };
const open = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));

/** Floating-style bar shown while the basket has slots. */
export function BasketBar() {
  const { items } = useBasket();
  const { push } = useNav();
  if (!items.length) return null;
  return <Btn title={`Review basket · ${items.length} slot${items.length === 1 ? '' : 's'}`} color={c.pink} onPress={() => push('Basket')} style={{ marginTop: 14 }} />;
}

export function Book() {
  const { push } = useNav();
  const { has } = useSession();
  const { compare, toggleCompare, clearCompare } = useBasket();
  const [form, setForm] = useState(false);
  const [q, setQ] = useState('');
  const [sport, setSport] = useState('');
  const [sort, setSort] = useState('name');
  const [near, setNear] = useState(null);
  const mine = useLoad(() => api.get('/reservations', { limit: 20 }), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const note = useLoad(() => api.get('/notifications', { unread: true, limit: 1 }), []);
  const venues = useLoad(() => api.get('/venues', { q, sport, sort: near ? sort : sort === 'distance' ? 'name' : sort, lat: near?.lat, lng: near?.lng, limit: 50 }), [q, sport, sort, near]);

  const useMyLocation = () => {
    if (Platform.OS === 'web' && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { setNear({ lat: p.coords.latitude, lng: p.coords.longitude }); setSort('distance'); }, () => {});
  };
  const canLocate = Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.geolocation;

  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Book a spot</H1>
      <T color={c.mute} weight="700">Courts, tables, grounds & kit — compare venues, grab several slots at once, no double-bookings.</T>
      <BasketBar />
      <Pressable onPress={() => push('Notifications')} style={{ marginTop: 12 }}>
        <Card color={c.paper} pad={12}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">🔔 Notifications</T><T weight="700" color={note.data?.unread ? c.pink : c.mute}>{note.data?.unread ? `${note.data.unread} new ›` : '›'}</T></View></Card>
      </Pressable>

      <Section title="Your reservations" color={c.lime}>
        {mine.loading && !mine.data ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : mine.data.length ? mine.data.map((r) => {
          const active = r.bookings.filter((b) => b.status === 'confirmed');
          const first = active[0] ?? r.bookings[0];
          return (
            <Row key={r.id} onPress={() => push('Reservation', { id: r.id })} left={<Bubble emoji={KIND[first?.kind] ?? '📍'} color={c.lime} />}
              title={`${r.code} · ${first?.venue_name ?? ''}${new Set(r.bookings.map((b) => b.venue_id)).size > 1 ? ' +more' : ''}`}
              sub={`${active.length} slot${active.length === 1 ? '' : 's'} · ${first ? dateTimeIn(first.starts_at, first.timezone) : ''}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="700">{moneyIn(r.total_cents, r.currency)}</T><Tag label={r.status} color={r.status === 'confirmed' ? c.mint : c.red} /></View>} />
          );
        }) : <Empty emoji="🗓️" title="No upcoming reservations" sub="Pick a venue below." />}
      </Section>

      <Section title="Find a venue" color={c.cyan}>
        <Field value={q} onChangeText={setQ} placeholder="Search venues by name" />
        <Seg options={[{ value: '', label: 'All sports' }, ...(sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` }))]} value={sport} onChange={setSport} color={c.cyan} />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {[['name', 'A–Z'], ['rating', 'Top rated'], ['price', 'Cheapest']].map(([v, l]) => <Chip key={v} label={l} active={sort === v} onPress={() => setSort(v)} />)}
          {canLocate ? <Chip label={near ? '📍 Nearest' : '📍 Near me'} active={sort === 'distance'} onPress={() => (near ? setSort('distance') : useMyLocation())} /> : null}
        </View>
        {compare.length ? (
          <Card color={c.sunSoft} pad={12}>
            <T weight="700">{compare.length} venue{compare.length === 1 ? '' : 's'} picked to compare</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Btn small title="Compare" disabled={compare.length < 2} onPress={() => push('Compare', { ids: compare })} />
              <Btn small title="Clear" color={c.paper} onPress={clearCompare} />
            </View>
            {compare.length < 2 ? <T size={12} color={c.mute} style={{ marginTop: 6 }}>Pick at least two.</T> : null}
          </Card>
        ) : null}
        {venues.loading && !venues.data ? <Loading /> : venues.error ? <ErrorBox error={venues.error} onRetry={venues.reload} /> : venues.data?.length ? venues.data.map((v) => (
          <Row key={v.id} onPress={() => push('Venue', { id: v.id })} left={v.cover_url ? <Image source={{ uri: mediaUrl(v.cover_url) }} style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: c.violetSoft }} /> : <Bubble emoji={v.emoji} color={c.cyan} />} title={v.name}
            sub={[v.city, `${v.resources} area${v.resources === 1 ? '' : 's'}`, v.distance_km != null ? `${v.distance_km} km` : null, v.min_hourly_rate_cents != null ? `from ${moneyIn(v.min_hourly_rate_cents, v.currency)}/h` : null].filter(Boolean).join(' · ')}
            right={<View style={{ alignItems: 'flex-end', gap: 6 }}>{v.rating ? <T weight="700">⭐ {v.rating}</T> : null}
              <Chip label={compare.includes(v.id) ? '✓ Compare' : '+ Compare'} active={compare.includes(v.id)} onPress={() => toggleCompare(v.id)} /></View>} />
        )) : <Empty emoji="🔎" title="No venues match" sub={has('venue_manager', 'organizer') ? 'Register yours below.' : 'Try another sport or clear the search.'} />}
      </Section>

      {has('venue_manager', 'organizer') ? (
        <Section title="Run a venue" color={c.violet}>
          <Btn title="Register a venue" color={c.violet} onPress={() => setForm(true)} />
          <Row onPress={() => push('OwnerSummary')} left={<Bubble emoji="📊" color={c.violet} />} title="All my venues" sub="Revenue, tax and payments per venue and per currency" right={<T color={c.pink} weight="700">Open ›</T>} />
          <MyVenues />
        </Section>
      ) : null}

      <FormSheet visible={form} onClose={() => setForm(false)} title="Register a venue"
        fields={[{ key: 'name', label: 'Venue name' }, { key: 'city', label: 'City', optional: true }, { key: 'address', label: 'Address', optional: true },
          { key: 'timezone', label: 'Time zone', placeholder: 'Asia/Kolkata', hint: 'IANA name; opening hours and slots follow it', optional: true },
          { key: 'latitude', label: 'Latitude', type: 'number', optional: true }, { key: 'longitude', label: 'Longitude', type: 'number', optional: true }]}
        onSubmit={async (v) => { const x = await api.post('/venues', v); venues.reload(); push('Manage', { id: x.id }); return 'Venue added — now add hours and courts'; }} />
    </Screen>
  );
}

/** Venues the signed-in user owns or staffs: jump to their management console. */
function MyVenues() {
  const { push } = useNav();
  const list = useLoad(() => api.get('/me/venues'), []);
  return (list.data ?? []).map((v) => <Row key={v.id} onPress={() => push('Manage', { id: v.id })} left={<Bubble emoji={v.emoji} color={c.violet} />} title={v.name} sub={`${v.role} · manage bookings, pricing, blocks, reports`} right={<T color={c.pink} weight="700">Manage ›</T>} />);
}

const mergeRuns = (slots) => {
  const runs = [];
  for (const s of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const last = runs[runs.length - 1];
    if (last && last.ends_at === s.starts_at) { last.ends_at = s.ends_at; last.est_cents += s.price_cents; } else runs.push({ starts_at: s.starts_at, ends_at: s.ends_at, est_cents: s.price_cents });
  }
  return runs;
};

export function Venue({ id }) {
  const { user, toast } = useSession();
  const { push } = useNav();
  const { add, items, compare, toggleCompare } = useBasket();
  const v = useLoad(() => api.get(`/venues/${id}`), [id]);
  const mine = useLoad(() => api.get('/me/venues').catch(() => []), []);
  const contacts = useLoad(() => api.get(`/venues/${id}/contacts`).catch(() => []), [id]);
  const [dayIdx, setDayIdx] = useState(0);
  const [sport, setSport] = useState('');
  const [sel, setSel] = useState({}); // `${resourceId}|${starts_at}` -> { resource, slot }
  const [qty, setQty] = useState({}); // resourceId -> units
  const tz = v.data?.timezone ?? 'UTC';
  const date = useMemo(() => addDays(todayIn(tz), dayIdx), [tz, dayIdx]);
  const grid = useLoad(() => (v.data ? api.get(`/venues/${id}/availability`, { date, sport }) : Promise.resolve(null)), [id, date, sport, v.data?.id, items.length]);

  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const x = v.data;
  const team = x.owner_id === user.id || mine.data?.some((m) => m.id === x.id);
  const sportsHere = [...new Map(x.resources.filter((r) => r.sport_slug).map((r) => [r.sport_slug, r])).values()];
  const picked = Object.values(sel);

  const toggle = (res, slot) => {
    const key = `${res.id}|${slot.starts_at}`;
    setSel((s) => { const n = { ...s }; if (n[key]) delete n[key]; else n[key] = { res, slot }; return n; });
  };
  const addToBasket = () => {
    const byRes = {};
    for (const { res, slot } of picked) (byRes[res.id] ??= { res, slots: [] }).slots.push(slot);
    const list = [];
    for (const { res, slots } of Object.values(byRes)) {
      const units = qty[res.id] ?? 1;
      for (const run of mergeRuns(slots)) list.push({ key: `${res.id}|${run.starts_at}|${run.ends_at}`, resource_id: res.id, resource_name: res.name, venue_id: x.id, venue_name: x.name, timezone: tz, currency: x.currency, starts_at: run.starts_at, ends_at: run.ends_at, quantity: units, est_cents: run.est_cents * units });
    }
    add(list); setSel({}); toast(`${list.length} added to your basket`);
  };

  return (
    <Screen>
      <GradCard colors={grad.fresh}>
        <T size={52}>{x.emoji}</T><H1 color="#fff" style={{ fontSize: 28 }}>{x.name}</H1>
        <T color="#fff" weight="800">{[x.address, x.city].filter(Boolean).join(', ')}</T>
        {x.reviews ? <T color="#fff" weight="700" style={{ marginTop: 4 }}>★ {x.rating} · {x.reviews} review{x.reviews === 1 ? '' : 's'}</T> : null}
        {x.description ? <T color="#fff" style={{ marginTop: 6 }}>{x.description}</T> : null}
      </GradCard>
      {x.media?.length ? <View style={{ marginTop: 12 }}><Gallery media={x.media} /></View> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {x.map_links ? <Btn small title="📍 Open in Maps" color={c.violet} onPress={() => open(x.map_links.google)} /> : null}
        {x.map_links ? <Btn small title="Directions" color={c.paper} onPress={() => open(x.map_links.directions)} /> : null}
        {x.phone ? <Btn small title={`Call ${x.phone}`} color={c.paper} onPress={() => open(`tel:${x.phone.replace(/\s/g, '')}`)} /> : null}
        {x.website ? <Btn small title="Website" color={c.paper} onPress={() => open(x.website)} /> : null}
        <Btn small title={compare.includes(x.id) ? '✓ In compare' : '+ Compare'} color={c.paper} onPress={() => toggleCompare(x.id)} />
        {team ? <Btn small title="Manage venue" color={c.pink} onPress={() => push('Manage', { id: x.id })} /> : null}
      </View>

      <Card style={{ marginTop: 12 }}>
        <T weight="700">🕒 {hoursSummary(x.hours)}</T>
        <T size={13} color={c.mute} style={{ marginTop: 4 }}>Free cancellation until {x.cancel_free_hours}h before{x.late_cancel_refund_percent ? `, then ${x.late_cancel_refund_percent}% back` : ', then no refund'}. Book up to {x.max_advance_days} days ahead.</T>
        {x.amenities?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{x.amenities.map((a) => <Tag key={a} label={a} />)}</View> : null}
        {x.offers?.length ? x.offers.map((o) => <T key={o.id} size={13} color={c.lime} weight="700" style={{ marginTop: 6 }}>🏷️ {o.name} · {o.kind === 'percent' ? `${o.value}% off` : `${moneyIn(o.value, x.currency)} off`}</T>) : null}
        {contacts.data?.length ? contacts.data.map((ct) => <T key={ct.id} size={13} style={{ marginTop: 6 }}>☎️ {ct.role}: {[ct.name, ct.phone, ct.email].filter(Boolean).join(' · ')}</T>) : null}
      </Card>

      <Section title="Pick your slots" color={c.lime}>
        <Seg options={Array.from({ length: 14 }, (_, i) => ({ value: i, label: dayLabel(addDays(todayIn(tz), i), i) }))} value={dayIdx} onChange={setDayIdx} color={c.pink} />
        {sportsHere.length > 1 ? <Seg options={[{ value: '', label: 'All sports' }, ...sportsHere.map((r) => ({ value: r.sport_slug, label: `${r.sport_emoji ?? ''} ${r.sport}` }))]} value={sport} onChange={setSport} color={c.cyan} /> : null}
        {grid.loading && !grid.data ? <Loading /> : grid.error ? <ErrorBox error={grid.error} onRetry={grid.reload} /> : grid.data?.resources.length ? grid.data.resources.map((r) => (
          <Card key={r.id}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Bubble emoji={KIND[r.kind] ?? '📍'} color={c.limeSoft} />
              <View style={{ flex: 1 }}>
                <T weight="700">{r.name}</T>
                <T size={12} color={c.mute}>{[r.sport_emoji && `${r.sport_emoji} ${r.sport}`, r.capacity > 1 && `${r.capacity} ${r.kind === 'equipment' ? 'units' : 'at once'}`, r.max_players && `${r.max_players} players${r.capacity > 1 ? ' each' : ''}`, `${r.slot_minutes} min slots`, r.indoor != null && (r.indoor ? 'indoor' : 'outdoor'), r.surface].filter(Boolean).join(' · ')}</T>
              </View>
            </View>
            {r.capacity > 1 ? (
              <View style={{ marginTop: 8 }}><T size={12} weight="700">{r.kind === 'equipment' ? 'Units' : 'How many'}</T>
                <Seg options={Array.from({ length: Math.min(r.capacity, 8) }, (_, i) => ({ value: i + 1, label: `${i + 1}` }))} value={qty[r.id] ?? 1} onChange={(n) => setQty((q0) => ({ ...q0, [r.id]: n }))} color={c.orange} /></View>
            ) : null}
            {r.slots.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {r.slots.map((s) => {
                  const on = !!sel[`${r.id}|${s.starts_at}`];
                  const free = s.status === 'free' && s.free_units >= (qty[r.id] ?? 1);
                  return (
                    <Pressable key={s.starts_at} disabled={!free} onPress={() => toggle(r, s)}
                      style={{ borderRadius: 12, borderWidth: 1.5, borderColor: on ? c.pink : c.line, backgroundColor: on ? c.pink : free ? c.paper : c.violetSoft, paddingVertical: 8, paddingHorizontal: 10, minWidth: 82, alignItems: 'center', opacity: free ? 1 : 0.5 }}>
                      <T weight="700" size={13} color={on ? '#fff' : c.ink}>{timeIn(s.starts_at, tz)}</T>
                      <T size={11} color={on ? '#fff' : c.mute}>{free ? moneyIn(s.price_cents * (qty[r.id] ?? 1), x.currency) : s.status === 'blocked' ? 'closed' : s.status === 'booked' ? 'taken' : s.status.replace('_', ' ')}</T>
                    </Pressable>
                  );
                })}
              </View>
            ) : <T color={c.mute} style={{ marginTop: 8 }}>Closed this day.</T>}
          </Card>
        )) : <Empty emoji="🏟️" title="Nothing to book here yet" sub={x.active ? 'The venue has not added courts for this sport.' : 'This venue is not taking bookings.'} />}
        {picked.length ? <Btn title={`Add ${picked.length} slot${picked.length === 1 ? '' : 's'} to basket`} onPress={addToBasket} /> : null}
        <BasketBar />
      </Section>

      <Section title="Ratings & reviews" color={c.pink}><VenueReviews venueId={id} /></Section>
    </Screen>
  );
}
