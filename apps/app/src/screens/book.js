import React, { useMemo, useState } from 'react';
import { Image, Linking, Platform, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useBasket } from '../basket';
import { useLayout } from '../layout';
import { Bubble, Btn, Card, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Gallery, VenueReviews } from './venue-media';
import { VenuePlans } from './plans';
import { AlertSheet } from './alerts';
import { Calendar, StickyBar } from '../pickers';
import { c } from '../theme';
import { WEEKDAYS, addDays, dateTimeIn, dayLabel, fmtMin, moneyIn, offerLabel, openStatus, todayIn } from '../vtime';

export const KIND = { court: '🏀', ground: '⚽', pool: '🏊', track: '🏃', room: '🧘', equipment: '🎒', table: '🏓', lane: '🎳', rink: '🏒', range: '🎯', studio: '🧘', other: '📍' };
const open = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));

/** Button shown while the basket has slots. */
export function BasketBar() {
  const { items } = useBasket();
  const { push } = useNav();
  if (!items.length) return null;
  return <Btn title={`Review basket · ${items.length} slot${items.length === 1 ? '' : 's'}`} color={c.pink} onPress={() => push('Basket')} style={{ marginTop: 14 }} />;
}

const Rating = ({ v }) => (v.reviews ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.mint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T size={12} weight="700" color="#fff">★ {Number(v.rating).toFixed(1)}</T><T size={11} color="#fff">({v.reviews})</T></View> : <View style={{ backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T size={11} weight="700" color={c.mute}>New</T></View>);

/** One venue in the discovery grid: photo, rating, price-from, offers, distance. */
function VenueCard({ v, onOpen, picked, onPick, width, onFav }) {
  return (
    <Pressable onPress={onOpen} style={{ width }} accessibilityRole="button" accessibilityLabel={v.name}>
      <Card pad={0}>
        <View style={{ height: 150, borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden', backgroundColor: c.violetSoft }}>
          {v.cover_url ? <Image source={{ uri: mediaUrl(v.cover_url) }} resizeMode="cover" style={{ width: '100%', height: '100%' }} /> : <LinearGradient colors={['#059669', '#0EA5E9']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><T size={52}>{v.emoji}</T></LinearGradient>}
          <View style={{ position: 'absolute', top: 10, left: 10 }}><Rating v={v} /></View>
          {v.offers ? <View style={{ position: 'absolute', bottom: 10, left: 10, backgroundColor: c.ink, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}><T size={11} weight="700" color="#fff">🏷️ {v.offers} offer{v.offers === 1 ? '' : 's'}</T></View> : null}
          <Pressable onPress={onFav} hitSlop={8} accessibilityLabel={v.is_favourite ? 'Remove from favourites' : 'Save to favourites'} style={{ position: 'absolute', top: 8, right: 100, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 14, width: 30, height: 28, alignItems: 'center', justifyContent: 'center' }}><T size={15} color={v.is_favourite ? c.pink : c.mute}>{v.is_favourite ? '♥' : '♡'}</T></Pressable>
          <Pressable onPress={onPick} hitSlop={8} accessibilityLabel={picked ? 'Remove from compare' : 'Add to compare'} style={{ position: 'absolute', top: 8, right: 8, backgroundColor: picked ? c.pink : 'rgba(255,255,255,0.92)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 }}>
            <T size={11} weight="700" color={picked ? '#fff' : c.ink}>{picked ? '✓ Compare' : '＋ Compare'}</T>
          </Pressable>
        </View>
        <View style={{ padding: 12, gap: 3 }}>
          <T weight="700" size={16} numberOfLines={1}>{v.name}</T>
          <T size={12} color={c.mute} numberOfLines={1}>{[v.city, v.distance_km != null && `${v.distance_km} km`].filter(Boolean).join(' · ') || ' '}</T>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
            <T size={12} color={c.mute} numberOfLines={1} style={{ flex: 1 }}>{v.resources} court{v.resources === 1 ? '' : 's'}{v.amenities?.length ? ` · ${v.amenities.slice(0, 2).join(', ')}` : ''}</T>
            {v.min_hourly_rate_cents != null ? <T weight="700" color={c.pink}>from {moneyIn(v.min_hourly_rate_cents, v.currency)}<T size={11} color={c.mute}>/hr</T></T> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

export function Book() {
  const { push } = useNav();
  const { has } = useSession();
  const L = useLayout();
  const { compare, toggleCompare, clearCompare } = useBasket();
  const [form, setForm] = useState(false);
  const [filters, setFilters] = useState(false);
  const [q, setQ] = useState('');
  const [sport, setSport] = useState('');
  const [sort, setSort] = useState('name');
  const [amenity, setAmenity] = useState('');
  const [near, setNear] = useState(null);
  const [date, setDate] = useState(null);       // YYYY-MM-DD in the device's zone, or null = any day
  const [hour, setHour] = useState(null);       // start hour, or null = any time
  const [pickDate, setPickDate] = useState(false);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const mine = useLoad(() => api.get('/reservations', { limit: 20 }), []);
  const sports = useLoad(() => api.get('/sports'), []);
  const note = useLoad(() => api.get('/notifications', { unread: true, limit: 1 }), []);
  const favs = useLoad(() => api.get('/me/favourites'), []);
  const toggleFav = async (v) => { try { if (v.is_favourite) await api.del(`/venues/${v.id}/favourite`); else await api.post(`/venues/${v.id}/favourite`); venues.reload(); favs.reload(); } catch {} };

  // "available on <date> at <hour>" -> the venue search filters by a free court for that hour
  const win = useMemo(() => {
    if (!date || hour == null) return {};
    const from = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);
    return { available_from: from.toISOString(), available_to: new Date(from.getTime() + 3600e3).toISOString() };
  }, [date, hour]);
  const venues = useLoad(() => api.get('/venues', { q, sport, amenity, sort: near ? sort : sort === 'distance' ? 'name' : sort, lat: near?.lat, lng: near?.lng, ...win, limit: 60 }), [q, sport, sort, amenity, near, win.available_from]);
  const amenities = useMemo(() => [...new Set((venues.data ?? []).flatMap((x) => x.amenities ?? []))].sort(), [venues.data]);

  const canLocate = Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.geolocation;
  const locate = () => navigator.geolocation.getCurrentPosition((p) => { setNear({ lat: p.coords.latitude, lng: p.coords.longitude }); setSort('distance'); }, () => {});
  const cols = L.tablet ? (L.width >= 1100 ? 3 : 2) : 1;
  const cardW = cols === 1 ? '100%' : `${(100 - (cols - 1) * 2) / cols}%`;
  const activeFilters = [amenity, sort !== 'name' && sort, date].filter(Boolean).length;
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>Book a court</H1>
      <T color={c.mute} weight="600">Find a venue, check live availability, book several slots at once.</T>
      <BasketBar />
      <Pressable onPress={() => push('Wallet')} style={{ marginTop: 10 }}><Card pad={10}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">👛 Wallet & gift cards</T><T weight="700" color={c.pink}>Open ›</T></View></Card></Pressable>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}><Field value={q} onChangeText={setQ} placeholder="Search venues…" /></View>
        <Pressable onPress={() => setFilters(true)} style={{ height: 50, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1.5, borderColor: activeFilters ? c.pink : c.line, backgroundColor: c.paper, justifyContent: 'center' }}><T weight="700" color={activeFilters ? c.pink : c.ink}>⚙ Filters{activeFilters ? ` · ${activeFilters}` : ''}</T></Pressable>
        <Pressable onPress={() => push('Notifications')} style={{ height: 50, width: 50, borderRadius: 12, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Notifications"><T size={18}>🔔</T>{note.data?.unread ? <View style={{ position: 'absolute', top: 6, right: 6, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}><T size={10} weight="700" color="#fff">{note.data.unread}</T></View> : null}</Pressable>
      </View>
      <View style={{ marginTop: 6 }}><Seg options={[{ value: '', label: '✨ All sports' }, ...(sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` }))]} value={sport} onChange={setSport} color={c.violet} /></View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Pressable onPress={() => setPickDate(true)} style={{ borderRadius: 999, borderWidth: 1, borderColor: date ? c.pink : c.line, backgroundColor: date ? c.pinkSoft : c.paper, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' }}><T weight="700" size={13} color={date ? c.pink : c.ink}>📅 {date ? dayLabel(date, Math.round((Date.parse(date) - Date.parse(todayStr)) / 864e5)) : 'Any day'}</T></Pressable>
        {date ? <View style={{ flex: 1 }}><Seg options={[{ value: null, label: 'Any time' }, ...Array.from({ length: 16 }, (_, i) => ({ value: i + 6, label: `${(i + 6) % 12 || 12}${i + 6 < 12 ? 'am' : 'pm'}` }))]} value={hour} onChange={setHour} color={c.pink} /></View> : null}
      </View>

      {compare.length ? (
        <Card color={c.sunSoft} pad={12} style={{ marginTop: 10 }}>
          <T weight="700">{compare.length} venue{compare.length === 1 ? '' : 's'} picked to compare{compare.length < 2 ? ' — pick one more' : ''}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Btn small title="Compare" disabled={compare.length < 2} onPress={() => push('Compare', { ids: compare })} /><Btn small title="Clear" color={c.paper} onPress={clearCompare} /></View>
        </Card>
      ) : null}

      {favs.data?.length ? (
        <Section title="Your favourites" color={c.pink}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{favs.data.map((f) => <Pressable key={f.id} onPress={() => push('Venue', { id: f.id })} style={{ borderRadius: 999, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', gap: 6, alignItems: 'center' }}><T size={14}>{f.emoji}</T><T weight="700" size={13}>{f.name}</T>{f.offers ? <T size={11} color={c.lime} weight="700">🏷️ {f.offers}</T> : null}</Pressable>)}</View>
        </Section>
      ) : null}
      <View style={{ marginTop: 14 }}>
        {venues.loading && !venues.data ? <Loading /> : venues.error ? <ErrorBox error={venues.error} onRetry={venues.reload} /> : venues.data?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {venues.data.map((v) => <VenueCard key={v.id} v={v} width={cardW} onFav={() => toggleFav(v)} onOpen={() => push('Venue', { id: v.id, date: date ?? undefined })} picked={compare.includes(v.id)} onPick={() => toggleCompare(v.id)} />)}
          </View>
        ) : <Empty emoji="🔎" title="No venues match" sub={date && hour != null ? 'Nothing is free at that time — try another hour or day.' : has('venue_manager', 'organizer') ? 'Register yours below.' : 'Try another sport or clear the filters.'} />}
      </View>

      <Section title="Your upcoming bookings" color={c.lime}>
        {mine.loading && !mine.data ? <Loading /> : mine.error ? <ErrorBox error={mine.error} onRetry={mine.reload} /> : mine.data.length ? mine.data.map((r) => {
          const active = r.bookings.filter((b) => b.status === 'confirmed');
          const first = active[0] ?? r.bookings[0];
          return (
            <Row key={r.id} onPress={() => push('Reservation', { id: r.id })} left={<Bubble emoji={KIND[first?.kind] ?? '📍'} color={c.lime} />}
              title={`${first?.venue_name ?? ''}${new Set(r.bookings.map((b) => b.venue_id)).size > 1 ? ' +more' : ''}`}
              sub={`${r.code} · ${active.length} slot${active.length === 1 ? '' : 's'} · ${first ? dateTimeIn(first.starts_at, first.timezone) : ''}`}
              right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{r.currency !== 'MULTI' ? <T weight="700">{moneyIn(r.payable_cents, r.currency)}</T> : <T weight="700" size={12}>multi-currency</T>}<Tag label={r.awaiting_payment ? 'pay now' : r.status} color={r.awaiting_payment ? c.orange : r.status === 'confirmed' ? c.mint : c.red} /></View>} />
          );
        }) : <Empty emoji="🗓️" title="No upcoming bookings" sub="Pick a venue above." />}
      </Section>

      {has('venue_manager', 'organizer') ? (
        <Section title="Run a venue" color={c.violet}>
          <Btn title="Register a venue" color={c.violet} onPress={() => setForm(true)} />
          <Row onPress={() => push('OwnerSummary')} left={<Bubble emoji="📊" color={c.violet} />} title="All my venues" sub="Revenue, tax and payments per venue and per currency" right={<T color={c.pink} weight="700">Open ›</T>} />
          <MyVenues />
        </Section>
      ) : null}

      <Sheet visible={filters} onClose={() => setFilters(false)} title="Filters & sort">
        <T weight="700">Sort by</T>
        <Seg options={[['name', 'A–Z'], ['rating', 'Top rated'], ['price', 'Lowest price'], ...(near ? [['distance', 'Nearest']] : [])].map(([value, label]) => ({ value, label }))} value={sort} onChange={setSort} color={c.violet} />
        {canLocate ? <Btn small title={near ? '📍 Using your location' : '📍 Use my location'} color={c.paper} onPress={locate} style={{ alignSelf: 'flex-start' }} /> : null}
        {amenities.length ? <><T weight="700">Facilities</T><Seg options={[{ value: '', label: 'Any' }, ...amenities.map((a) => ({ value: a, label: a }))]} value={amenity} onChange={setAmenity} color={c.cyan} /></> : null}
        <Btn title="Done" onPress={() => setFilters(false)} />
        <Btn small title="Reset" color={c.paper} onPress={() => { setSort('name'); setAmenity(''); setDate(null); setHour(null); setNear(null); }} />
      </Sheet>
      <Sheet visible={pickDate} onClose={() => setPickDate(false)} title="When do you want to play?">
        <Calendar month={month} onMonth={setMonth} value={date} minDate={todayStr} onChange={(d) => { setDate(d); setPickDate(false); }} />
        {date ? <Btn small title="Any day" color={c.paper} onPress={() => { setDate(null); setHour(null); setPickDate(false); }} /> : null}
      </Sheet>
      <FormSheet visible={form} onClose={() => setForm(false)} title="Register a venue"
        fields={[{ key: 'name', label: 'Venue name' }, { key: 'city', label: 'City', optional: true }, { key: 'address', label: 'Address', optional: true },
          { key: 'currency', label: 'Currency (INR, USD, EUR…)', placeholder: 'INR', optional: true }, { key: 'timezone', label: 'Time zone', placeholder: 'Asia/Kolkata', hint: 'IANA name; opening hours and slots follow it', optional: true },
          { key: 'latitude', label: 'Latitude', type: 'number', optional: true }, { key: 'longitude', label: 'Longitude', type: 'number', optional: true }]}
        onSubmit={async (v) => { const x = await api.post('/venues', v); venues.reload(); push('Manage', { id: x.id }); return 'Venue created — follow the checklist to open for bookings'; }} />
    </Screen>
  );
}

/** Venues the signed-in user owns or staffs: jump to their management console. */
function MyVenues() {
  const { push } = useNav();
  const list = useLoad(() => api.get('/me/venues'), []);
  return (list.data ?? []).map((v) => <Row key={v.id} onPress={() => push('Manage', { id: v.id })} left={<Bubble emoji={v.emoji} color={c.violet} />} title={v.name} sub={`${v.role} · manage bookings, pricing, blocks, reports`} right={<T color={c.pink} weight="700">Manage ›</T>} />);
}

/** Static map on the web (OpenStreetMap embed); buttons everywhere. */
function MapBox({ v }) {
  if (v.latitude == null) return null;
  const d = 0.008;
  return (
    <View style={{ gap: 8 }}>
      {Platform.OS === 'web' ? React.createElement('iframe', { title: 'Map', loading: 'lazy', style: { width: '100%', height: 200, border: 0, borderRadius: 14 }, src: `https://www.openstreetmap.org/export/embed.html?bbox=${v.longitude - d * 1.6}%2C${v.latitude - d}%2C${v.longitude + d * 1.6}%2C${v.latitude + d}&layer=mapnik&marker=${v.latitude}%2C${v.longitude}` }) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}><Btn small title="📍 Open in Maps" color={c.violet} onPress={() => open(v.map_links.google)} /><Btn small title="Directions" color={c.paper} onPress={() => open(v.map_links.directions)} /></View>
    </View>
  );
}

const TABS = [['overview', 'Overview'], ['courts', 'Courts'], ['reviews', 'Reviews']];
export function Venue({ id, date }) {
  const { user } = useSession();
  const { push } = useNav();
  const L = useLayout();
  const { compare, toggleCompare } = useBasket();
  const v = useLoad(() => api.get(`/venues/${id}`), [id]);
  const contacts = useLoad(() => api.get(`/venues/${id}/contacts`).catch(() => []), [id]);
  const mine = useLoad(() => api.get('/me/venues').catch(() => []), []);
  const [tab, setTab] = useState('overview');
  const [month, setMonth] = useState(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [fav, setFav] = useState(null);
  const tz = v.data?.timezone ?? 'UTC';
  const m = month ?? (v.data ? todayIn(tz).slice(0, 7) : null);
  const cal = useLoad(() => (v.data ? api.get(`/venues/${id}/calendar`, { month: m }) : Promise.resolve(null)), [id, m, v.data?.id]);
  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const x = v.data;
  const team = x.owner_id === user.id || mine.data?.some((q) => q.id === x.id);
  const status = openStatus(x.hours, tz);
  const cover = x.media?.find((q) => q.kind === 'photo');
  const rates = x.resources.filter((r) => r.kind !== 'equipment').map((r) => r.hourly_rate_cents);
  const from = rates.length ? Math.min(...rates) : null;
  const today = todayIn(tz);
  const book = (extra = {}) => push('BookFlow', { venueId: x.id, ...extra });

  return (
    <View style={{ flex: 1 }}>
      <Screen wide={L.tablet}>
        <View style={{ borderRadius: 20, overflow: 'hidden', height: L.tablet ? 300 : 210, backgroundColor: c.violet }}>
          {cover ? <Image source={{ uri: mediaUrl(cover.url) }} resizeMode="cover" style={{ position: 'absolute', width: '100%', height: '100%' }} /> : <LinearGradient colors={['#059669', '#0EA5E9']} style={{ position: 'absolute', width: '100%', height: '100%' }} />}
          <LinearGradient colors={['rgba(15,23,42,0)', 'rgba(15,23,42,0.78)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '70%' }} />
          {!cover ? <T size={64} style={{ position: 'absolute', top: 24, left: 20 }}>{x.emoji}</T> : null}
          <View style={{ position: 'absolute', left: 16, right: 16, bottom: 14, gap: 4 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Rating v={x} /><View style={{ backgroundColor: status.open ? 'rgba(5,150,105,0.95)' : 'rgba(100,116,139,0.95)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T size={11} weight="700" color="#fff">{status.text}</T></View></View>
            <T size={26} weight="800" color="#fff">{x.name}</T>
            <T size={13} color="#fff" weight="600">{[x.address, x.city].filter(Boolean).join(', ')}</T>
          </View>
        </View>
        {x.media?.length > 1 ? <View style={{ marginTop: 10 }}><Gallery media={x.media} width={150} /></View> : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {x.map_links ? <Btn small title="📍 Maps" color={c.paper} onPress={() => open(x.map_links.google)} /> : null}
          {x.map_links ? <Btn small title="Directions" color={c.paper} onPress={() => open(x.map_links.directions)} /> : null}
          {x.phone ? <Btn small title="📞 Call" color={c.paper} onPress={() => open(`tel:${x.phone.replace(/\s/g, '')}`)} /> : null}
          {x.website ? <Btn small title="Website" color={c.paper} onPress={() => open(x.website)} /> : null}
          <Btn small title={(fav ?? x.is_favourite) ? '♥ Saved' : '♡ Save'} color={c.paper} onPress={async () => { const on = !(fav ?? x.is_favourite); try { if (on) await api.post(`/venues/${x.id}/favourite`); else await api.del(`/venues/${x.id}/favourite`); setFav(on); } catch {} }} />
          <Btn small title="🔔 Alert me" color={c.paper} onPress={() => setAlertOpen(true)} />
          <Btn small title={compare.includes(x.id) ? '✓ In compare' : '＋ Compare'} color={c.paper} onPress={() => toggleCompare(x.id)} />
          {team ? <Btn small title="Manage venue" color={c.pink} onPress={() => push('Manage', { id: x.id })} /> : null}
        </View>
        <View style={{ marginTop: 6 }}><Seg options={TABS.map(([value, label]) => ({ value, label: value === 'reviews' && x.reviews ? `${label} (${x.reviews})` : label }))} value={tab} onChange={setTab} color={c.violet} /></View>

        {tab === 'overview' ? (
          <View style={{ gap: 12, marginTop: 8 }}>
            {x.description ? <Card><T>{x.description}</T></Card> : null}
            <Card>
              <T weight="700" size={16}>Check availability</T>
              <T size={12} color={c.mute} style={{ marginBottom: 8 }}>Tap a day to pick your slots.</T>
              <Calendar month={m} onMonth={setMonth} days={cal.data?.days} currency={x.currency} today={today} value={date} onChange={(d) => book({ date: d })} />
            </Card>
            {x.offers?.length || x.amenities?.length ? (
              <Card>
                {x.offers?.map((o) => <T key={o.id} size={14} color={c.lime} weight="700" style={{ marginBottom: 4 }}>🏷️ {offerLabel(o, x.currency)}</T>)}
                {x.amenities?.length ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{x.amenities.map((a) => <Tag key={a} label={a} />)}</View> : null}
              </Card>
            ) : null}
            <Card>
              <T weight="700" size={16}>Opening hours</T>
              {!x.hours.length ? <T color={c.mute} style={{ marginTop: 4 }}>Open 24 hours, every day.</T> : WEEKDAYS.map((w, d) => {
                const hs = x.hours.filter((h) => h.weekday === d);
                const isToday = new Date(`${today}T00:00:00Z`).getUTCDay() === d;
                return <View key={w} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T weight={isToday ? '700' : '500'} color={isToday ? c.ink : c.mute}>{w}{isToday ? ' (today)' : ''}</T><T weight={isToday ? '700' : '500'}>{hs.length ? hs.map((h) => `${fmtMin(h.opens_min)}–${fmtMin(h.closes_min)}`).join(', ') : 'Closed'}</T></View>;
              })}
            </Card>
            <Card>
              <T weight="700" size={16}>Booking & cancellation</T>
              <T size={13} color={c.mute} style={{ marginTop: 4 }}>Free cancellation until {x.cancel_free_hours}h before{x.late_cancel_refund_percent ? `, then ${x.late_cancel_refund_percent}% refunded` : ', then no refund'}. Book up to {x.max_advance_days} days ahead{x.min_notice_minutes ? `, at least ${x.min_notice_minutes} min before` : ''}.</T>
              <T size={13} color={c.mute}>{x.payment_mode === 'pay_at_venue' ? 'Pay at the venue.' : x.payment_mode === 'online_required' ? 'Pay online to confirm your slot.' : 'Pay online or at the venue.'}{x.tax_rate_bp ? ` ${x.tax_name} ${x.tax_rate_bp / 100}% ${x.tax_inclusive ? 'included' : 'added at checkout'}.` : ''}</T>
            </Card>
            <VenuePlans venue={x} onChanged={v.reload} />
            {x.loyalty_earn_bp > 0 ? <Card color={c.sunSoft}><T weight="700" size={16}>⭐ Rewards</T><T size={13} color={c.mute} style={{ marginTop: 4 }}>Earn {x.loyalty_earn_bp / 100}% back in points on everything you pay here. Points are worth {x.currency} 0.01 each and pay up to {x.loyalty_max_redeem_bp / 100}% of a booking; they expire {x.loyalty_expiry_months} months after you earn them.</T>{x.my_points > 0 ? <T weight="700" style={{ marginTop: 4 }}>You have {x.my_points} points = {moneyIn(x.my_points, x.currency)}</T> : null}</Card> : null}
            {contacts.data?.length ? <Card>{contacts.data.map((ct) => <T key={ct.id} size={13} style={{ marginTop: 2 }}>☎️ {ct.role}: {[ct.name, ct.phone, ct.email].filter(Boolean).join(' · ')}</T>)}</Card> : null}
            <MapBox v={x} />
          </View>
        ) : null}

        {tab === 'courts' ? (
          <View style={{ gap: 10, marginTop: 8 }}>
            {x.resources.length ? x.resources.map((r) => {
              const ph = x.media?.find((q) => q.resource_id === r.id && q.kind === 'photo');
              return (
                <Card key={r.id} pad={12}>
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    {ph ? <Image source={{ uri: mediaUrl(ph.url) }} style={{ width: 84, height: 84, borderRadius: 14 }} /> : <Bubble emoji={KIND[r.kind] ?? '📍'} size={64} />}
                    <View style={{ flex: 1, gap: 2 }}>
                      <T weight="700" size={16}>{r.name}</T>
                      <T size={12} color={c.mute}>{[r.sport && `${r.sport_emoji ?? ''} ${r.sport}`, r.indoor != null && (r.indoor ? 'Indoor' : 'Outdoor'), r.surface, r.max_players && `${r.max_players} players`, r.capacity > 1 && `${r.capacity} ${r.kind === 'equipment' ? 'units' : 'at once'}`, `${r.slot_minutes}-min slots`].filter(Boolean).join(' · ')}</T>
                      <T weight="700" color={c.pink}>{r.hourly_rate_cents ? `${moneyIn(r.hourly_rate_cents, x.currency)}/hr` : 'Free'}</T>
                    </View>
                    <Btn small title="Book" onPress={() => book({ resourceId: r.id })} />
                  </View>
                </Card>
              );
            }) : <Empty emoji="🏟️" title="No courts added yet" sub={team ? 'Add them in the venue console.' : 'Check back soon.'} />}
          </View>
        ) : null}

        {tab === 'reviews' ? <View style={{ marginTop: 8 }}><VenueReviews venueId={id} /></View> : null}
      </Screen>
      <AlertSheet venue={x} visible={alertOpen} onClose={() => setAlertOpen(false)} />
      {x.active && x.resources.length ? <StickyBar title={from != null ? `From ${moneyIn(from, x.currency)}/hr` : x.name} sub={status.text} action="Book now" onAction={() => book()} bottom={L.floatingBar ? 84 : 0} /> : null}
    </View>
  );
}
