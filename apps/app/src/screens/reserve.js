import React, { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useBasket } from '../basket';
import { Bubble, Btn, Card, Chip, Empty, ErrorBox, Field, H1, H2, Loading, Row, Screen, Seg, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { KIND } from './book';
import { addDays, dateTimeIn, dayLabel, hoursSummary, localToIso, moneyIn, timeIn, todayIn } from '../vtime';

const open = (url) => (Platform.OS === 'web' ? window.open(url, '_blank', 'noopener') : Linking.openURL(url));
const Line = ({ k, v, strong }) => <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T color={c.mute} weight={strong ? '700' : '500'}>{k}</T><T weight={strong ? '700' : '600'}>{v}</T></View>;

// ------------------------------------------------------------------ basket / checkout
export function Basket() {
  const { items, remove, clear } = useBasket();
  const { toast } = useSession();
  const { replace, back } = useNav();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState([]);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ items: items.map(({ resource_id, starts_at, ends_at, quantity }) => ({ resource_id, starts_at, ends_at, quantity })), promo_codes: codes });
  const sig = JSON.stringify(body());

  useEffect(() => {
    let live = true;
    setQuote(null);
    if (!items.length) return undefined;
    api.post('/reservations/quote', body()).then((q) => live && setQuote(q)).catch((e) => live && setQuote({ error: e.message }));
    return () => { live = false; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = items[0]?.currency ?? 'INR';
  const mixed = new Set(items.map((i) => i.currency)).size > 1;
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post('/reservations', body());
      clear(); toast(`Booked ${r.code} 🎉`); replace('Reservation', { id: r.id });
    } catch (e) { toast(e.message); setQuote(null); api.post('/reservations/quote', body()).then(setQuote).catch(() => {}); } finally { setBusy(false); }
  };
  const byVenue = [...new Map(items.map((i) => [i.venue_id, i.venue_name])).entries()];
  const problem = (idx) => quote?.problems?.find((p) => p.index === idx);

  if (!items.length) return <Screen><Empty emoji="🧺" title="Your basket is empty" sub="Pick slots on any venue — you can mix courts and venues in one booking." /><Btn title="Find a venue" onPress={back} style={{ marginTop: 12 }} /></Screen>;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Your basket</H1>
      <T color={c.mute} weight="700">One booking for all of it. If any slot is taken in the meantime, nothing is booked.</T>
      {byVenue.map(([vid, vname]) => (
        <Section key={vid} title={vname} color={c.cyan}>
          {items.map((i, idx) => (i.venue_id === vid ? (
            <Card key={i.key} color={problem(idx) ? c.orangeSoft : c.paper}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <T weight="700">{i.resource_name}{i.quantity > 1 ? ` × ${i.quantity}` : ''}</T>
                  <T size={13} color={c.mute}>{dateTimeIn(i.starts_at, i.timezone)} → {timeIn(i.ends_at, i.timezone)}</T>
                  {problem(idx) ? <T size={12} color={c.red} weight="700" style={{ marginTop: 4 }}>{problem(idx).message}</T> : null}
                </View>
                <T weight="700">{moneyIn(quote?.lines?.find((l) => l.resource_id === i.resource_id && l.starts_at === i.starts_at)?.price_cents ?? i.est_cents, i.currency)}</T>
                <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => remove(i.key)} />
              </View>
            </Card>
          ) : null))}
        </Section>
      ))}
      <Section title="Promo code" color={c.sun}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={code} onChangeText={setCode} placeholder="Have a code?" /></View>
          <Btn small title="Apply" color={c.violet} onPress={() => { if (code.trim()) { setCodes([...new Set([...codes, code.trim()])]); setCode(''); } }} />
        </View>
        {codes.length ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{codes.map((x) => <Chip key={x} label={`${x} ✕`} active onPress={() => setCodes(codes.filter((y) => y !== x))} />)}</View> : null}
        {quote?.unapplied_codes?.length ? <T size={12} color={c.mute}>Not applied (a better offer is already used, or the code's conditions aren't met): {quote.unapplied_codes.join(', ')}</T> : null}
      </Section>
      <Card style={{ marginTop: 20 }}>
        {mixed ? <T color={c.red} weight="700">These venues use different currencies — book them separately.</T> : !quote ? <Loading /> : quote.error ? <T color={c.red} weight="700">{quote.error}</T> : (
          <>
            <Line k="Subtotal" v={moneyIn(quote.subtotal_cents, currency)} />
            {quote.discount_cents ? <Line k="Discount" v={`− ${moneyIn(quote.discount_cents, currency)}`} /> : null}
            <Line k="Total · pay at the venue" v={moneyIn(quote.total_cents, currency)} strong />
            {quote.problems?.filter((p) => p.index === undefined).map((p, k) => <T key={k} color={c.red} weight="700" size={13}>{p.message}</T>)}
          </>
        )}
      </Card>
      <Btn title={quote?.ok ? `Confirm booking · ${moneyIn(quote.total_cents, currency)}` : 'Fix the highlighted slots to continue'} disabled={!quote?.ok || mixed} loading={busy} onPress={confirm} style={{ marginTop: 14 }} />
      <Btn small title="Empty basket" color={c.paper} onPress={clear} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
    </Screen>
  );
}

// ------------------------------------------------------------------ reservation detail
export function Reservation({ id }) {
  const { toast } = useSession();
  const { push } = useNav();
  const r = useLoad(() => api.get(`/reservations/${id}`), [id]);
  const [moving, setMoving] = useState(null);
  const [cancelAll, setCancelAll] = useState(false);
  if (r.loading && !r.data) return <Screen><Loading /></Screen>;
  if (r.error) return <Screen><ErrorBox error={r.error} onRetry={r.reload} /></Screen>;
  const x = r.data;
  const active = x.bookings.filter((b) => b.status === 'confirmed');
  const cancelLine = async (b) => {
    try { const out = await api.del(`/bookings/${b.id}`); toast(out.refund_cents ? `Cancelled — refund due ${moneyIn(out.refund_cents, b.currency)}` : 'Cancelled — no refund under the venue policy'); r.reload(); } catch (e) { toast(e.message); }
  };
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Booking {x.code}</H1>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}><Tag label={x.status} color={x.status === 'confirmed' ? c.mint : c.red} /></View>
      <Section title="Your slots" color={c.lime}>
        {x.bookings.map((b) => (
          <Card key={b.id} color={b.status === 'confirmed' ? c.paper : c.violetSoft}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Bubble emoji={KIND[b.kind] ?? '📍'} color={c.limeSoft} />
              <View style={{ flex: 1 }}>
                <T weight="700">{b.resource_name}{b.quantity > 1 ? ` × ${b.quantity}` : ''} · {b.venue_name}</T>
                <T size={13} color={c.mute}>{dateTimeIn(b.starts_at, b.timezone)} → {timeIn(b.ends_at, b.timezone)}</T>
                <T size={12} color={c.mute}>{b.slots} slot{b.slots === 1 ? '' : 's'}{b.discount_cents ? ` · saved ${moneyIn(b.discount_cents, b.currency)}` : ''}{b.status === 'cancelled' && b.refund_cents ? ` · refund ${moneyIn(b.refund_cents, b.currency)}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="700">{moneyIn(b.price_cents, b.currency)}</T><Tag label={b.status.replace('_', ' ')} color={b.status === 'confirmed' ? c.mint : c.red} /></View>
            </View>
            {b.status === 'confirmed' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Btn small title="Change time" color={c.violet} onPress={() => setMoving(b)} />
                <Btn small title="Cancel this slot" color={c.paper} ink={c.red} onPress={() => cancelLine(b)} />
              </View>
            ) : null}
          </Card>
        ))}
      </Section>
      <Card style={{ marginTop: 16 }}>
        <Line k="Subtotal" v={moneyIn(x.subtotal_cents, x.currency)} />
        {x.discount_cents ? <Line k="Discount" v={`− ${moneyIn(x.discount_cents, x.currency)}`} /> : null}
        <Line k="Total · pay at the venue" v={moneyIn(x.total_cents, x.currency)} strong />
      </Card>
      {active.length ? <Btn title="Cancel the whole booking" color={c.paper} ink={c.red} onPress={() => setCancelAll(true)} style={{ marginTop: 14 }} /> : null}
      {active.length ? <Btn small title={`Add more at ${active[0].venue_name}`} color={c.paper} onPress={() => push('Venue', { id: active[0].venue_id })} style={{ marginTop: 10, alignSelf: 'flex-start' }} /> : null}

      <MoveSheet booking={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); r.reload(); }} />
      <FormSheet visible={cancelAll} onClose={() => setCancelAll(false)} title="Cancel the whole booking?" submitLabel="Yes, cancel everything" color={c.red}
        fields={[{ key: 'reason', label: 'Reason', optional: true }]}
        onSubmit={async (v) => { const out = await api.del(`/reservations/${id}`, v); r.reload(); return out.refund_cents ? `Cancelled — refund due ${moneyIn(out.refund_cents, x.currency)}` : 'Cancelled'; }} />
    </Screen>
  );
}

/** Pick a new day / start / length for one booking line, using the live slot grid so only free times show. */
function MoveSheet({ booking, onClose, onDone }) {
  const { toast } = useSession();
  const [dayIdx, setDayIdx] = useState(0);
  const tz = booking?.timezone ?? 'UTC';
  const date = booking ? addDays(todayIn(tz), dayIdx) : null;
  const grid = useLoad(() => (booking ? api.get(`/venues/${booking.venue_id}/availability`, { date, resource_id: booking.resource_id }) : Promise.resolve(null)), [booking?.id, date]);
  const slots = grid.data?.resources?.[0]?.slots ?? [];
  const len = booking ? new Date(booking.ends_at) - new Date(booking.starts_at) : 0;
  const mine = (s) => booking && s.starts_at < booking.ends_at && s.ends_at > booking.starts_at;
  const move = async (s) => {
    try { await api.patch(`/bookings/${booking.id}`, { starts_at: s.starts_at, ends_at: new Date(new Date(s.starts_at).getTime() + len).toISOString() }); toast('Booking moved'); onDone(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible={!!booking} onClose={onClose} title="Change time">
      <T color={c.mute} size={13}>Same length ({Math.round(len / 60000)} min). Tap a start time — it's re-checked and repriced.</T>
      <Seg options={Array.from({ length: 14 }, (_, i) => ({ value: i, label: dayLabel(addDays(todayIn(tz), i), i) }))} value={dayIdx} onChange={setDayIdx} color={c.pink} />
      {grid.loading ? <Loading /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {slots.filter((s) => s.status === 'free' || mine(s)).map((s) => <Chip key={s.starts_at} label={timeIn(s.starts_at, tz)} active={mine(s)} onPress={() => move(s)} />)}
          {!slots.length ? <T color={c.mute}>Closed that day.</T> : null}
        </View>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ compare
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6);
export function Compare({ ids }) {
  const { push } = useNav();
  const { add, toggleCompare } = useBasket();
  const { toast } = useSession();
  const [dayIdx, setDayIdx] = useState(1);
  const [hour, setHour] = useState(18);
  const [dur, setDur] = useState(1);
  const [useWindow, setUseWindow] = useState(true);
  // the first venue's zone anchors the window; venues in other zones will simply show "closed"
  const first = useLoad(() => api.get(`/venues/${ids[0]}`), []);
  const vtz = first.data?.timezone ?? 'UTC';
  const date = addDays(todayIn(vtz), dayIdx);
  const from = localToIso(date, `${String(hour).padStart(2, '0')}:00`, vtz);
  const to = new Date(new Date(from).getTime() + dur * 3600e3).toISOString();
  const cmp = useLoad(() => (first.data ? api.get('/venue-comparison', { ids: ids.join(','), ...(useWindow ? { from, to } : {}) }) : Promise.resolve(null)), [ids.join(','), first.data?.id, useWindow, from, to]);

  const best = cmp.data?.highlights ?? {};
  const badges = (id) => [id === best.cheapest_venue_id && '💰 Cheapest', id === best.nearest_venue_id && '📍 Nearest', id === best.top_rated_venue_id && '⭐ Top rated', id === best.most_available_venue_id && '✅ Most open', id === best.earliest_free_venue_id && '⏱️ Earliest free'].filter(Boolean);
  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>Compare venues</H1>
      <Section title="When do you want to play?" color={c.sun}>
        <Seg options={[{ value: true, label: 'Pick a time' }, { value: false, label: 'Just compare' }]} value={useWindow} onChange={setUseWindow} color={c.violet} />
        {useWindow ? (
          <>
            <Seg options={Array.from({ length: 14 }, (_, i) => ({ value: i, label: dayLabel(addDays(todayIn(vtz), i), i) }))} value={dayIdx} onChange={setDayIdx} color={c.pink} />
            <Seg options={HOURS.map((h) => ({ value: h, label: `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}` }))} value={hour} onChange={setHour} color={c.violet} />
            <Seg options={[1, 2, 3].map((d) => ({ value: d, label: `${d}h` }))} value={dur} onChange={setDur} color={c.cyan} />
          </>
        ) : null}
      </Section>
      {cmp.loading && !cmp.data ? <Loading /> : cmp.error ? <ErrorBox error={cmp.error} onRetry={cmp.reload} /> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 14 }}>
          {cmp.data?.venues.map((col) => {
            const v = col.venue;
            return (
              <Card key={v.id} style={{ width: 290 }}>
                <T size={36}>{v.emoji}</T>
                <H2>{v.name}</H2>
                <T size={13} color={c.mute}>{[v.city, col.distance_km != null && `${col.distance_km} km`].filter(Boolean).join(' · ')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 }}>{badges(v.id).map((b) => <Tag key={b} label={b} color={c.sun} />)}</View>
                <Line k="Rating" v={col.rating ? `⭐ ${col.rating} (${col.reviews})` : 'No reviews'} />
                <Line k="Areas" v={`${col.totals.areas} · fits ${col.totals.players || '—'} players`} />
                <Line k="Price / hour" v={col.pricing ? (col.pricing.from_hourly_cents === col.pricing.to_hourly_cents ? moneyIn(col.pricing.from_hourly_cents, v.currency) : `${moneyIn(col.pricing.from_hourly_cents, v.currency)} – ${moneyIn(col.pricing.to_hourly_cents, v.currency)}`) : '—'} />
                <Line k="Hours" v={hoursSummary(col.hours)} />
                <Line k="Free cancel" v={`${col.policy.cancel_free_hours}h before`} />
                {v.amenities?.length ? <T size={12} color={c.mute} style={{ marginTop: 4 }}>{v.amenities.join(' · ')}</T> : null}
                {col.offers.map((o) => <T key={o.id} size={12} color={c.lime} weight="700" style={{ marginTop: 4 }}>🏷️ {o.name}: {o.kind === 'percent' ? `${o.value}% off` : moneyIn(o.value, v.currency) + ' off'}</T>)}
                {col.window ? (
                  <View style={{ marginTop: 10, gap: 6 }}>
                    <T weight="700">{col.window.bookable_areas ? `${col.window.bookable_areas} free at your time` : 'Nothing free at your time'}</T>
                    {col.window.areas.map((a) => (
                      <View key={a.resource_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <T size={13} style={{ flex: 1 }} color={a.bookable ? c.ink : c.mute}>{a.name}{a.bookable ? '' : ` · ${a.reason}`}</T>
                        {a.bookable ? <><T size={13} weight="700">{moneyIn(a.estimated_price_cents, v.currency)}</T>
                          <Btn small title="Add" color={c.violet} onPress={() => { add([{ key: `${a.resource_id}|${from}|${to}`, resource_id: a.resource_id, resource_name: a.name, venue_id: v.id, venue_name: v.name, timezone: v.timezone, currency: v.currency, starts_at: from, ends_at: to, quantity: 1, est_cents: a.estimated_price_cents }]); toast(`${a.name} added`); }} /></> : null}
                      </View>
                    ))}
                  </View>
                ) : null}
                {col.next_free ? <T size={12} color={c.mute} style={{ marginTop: 8 }}>Next free: {col.next_free.resource_name}, {dateTimeIn(col.next_free.starts_at, v.timezone)}</T> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <Btn small title="Open" onPress={() => push('Venue', { id: v.id })} />
                  {v.map_links ? <Btn small title="Map" color={c.paper} onPress={() => open(v.map_links.google)} /> : null}
                </View>
              </Card>
            );
          })}
        </ScrollView>
      )}
      <Btn title="Go to basket" color={c.pink} onPress={() => push('Basket')} />
      <T size={12} color={c.mute} style={{ marginTop: 8 }}>Add a court from each venue to book them together — one booking, one total.</T>
    </Screen>
  );
}

// ------------------------------------------------------------------ notifications
export function Notifications() {
  const { toast } = useSession();
  const { push } = useNav();
  const list = useLoad(() => api.get('/notifications', { limit: 50 }), []);
  const prefs = useLoad(() => api.get('/me/notification-preferences'), []);
  const setPref = async (patch) => { try { await api.patch('/me/notification-preferences', patch); prefs.reload(); } catch (e) { toast(e.message); } };
  const readAll = async () => { await api.post('/notifications/read', {}); list.reload(); };
  const tap = async (n) => {
    if (!n.read_at) { await api.post('/notifications/read', { ids: [n.id] }); list.reload(); }
    if (n.data?.reservation_id) push('Reservation', { id: n.data.reservation_id });
  };
  const p = prefs.data;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Notifications</H1>
      <Section title="How you hear from us" color={c.cyan}>
        {p ? (
          <Card>
            <Line k="In the app" v="" />
            <Seg options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} value={p.in_app} onChange={(v) => setPref({ in_app: v })} color={c.pink} />
            <Line k="Email" v="" />
            <Seg options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} value={p.email} onChange={(v) => setPref({ email: v })} color={c.pink} />
            <Line k="Remind me before a booking" v="" />
            <Seg options={[2, 6, 12, 24, 48].map((h) => ({ value: h, label: `${h}h` }))} value={p.reminder_hours} onChange={(v) => setPref({ reminder_hours: v })} color={c.violet} />
          </Card>
        ) : <Loading />}
      </Section>
      <Section title="Inbox" action={list.data?.unread ? 'Mark all read' : undefined} onAction={readAll} color={c.pink}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.items.length ? list.data.items.map((n) => (
          <Row key={n.id} onPress={() => tap(n)} color={n.read_at ? c.paper : c.pinkSoft} left={<Bubble emoji={n.kind.includes('cancel') ? '❌' : n.kind.includes('remind') ? '⏰' : n.kind.includes('modif') ? '✏️' : '✅'} />}
            title={n.title} sub={`${n.body} · ${new Date(n.created_at).toLocaleString()}`} />
        )) : <Empty emoji="🔕" title="Nothing yet" sub="Booking confirmations, changes and reminders land here." />}
      </Section>
    </Screen>
  );
}
