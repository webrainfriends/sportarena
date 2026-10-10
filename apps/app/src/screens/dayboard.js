// The reservation desk: a court-by-time board for one day. Tap a free slot to book it for a customer, tap a booking to take payment, mark a no-show or cancel.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Section, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Calendar } from '../pickers';
import { useNav } from '../nav';
import { c } from '../theme';
import { KIND } from './book';
import { addDays, dateTimeIn, localDate, localHHMM, localToIso, longDay, moneyIn, timeIn, todayIn } from '../vtime';

const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank transfer'], ['other', 'Other']];
const ROW_H = 40, COL_W = 112, LABEL_W = 52;

export function DayBoard({ v }) {
  const { toast } = useSession();
  const { push } = useNav();
  const tz = v.timezone;
  const [date, setDate] = useState(todayIn(tz));
  const [calOpen, setCalOpen] = useState(false);
  const [month, setMonth] = useState(todayIn(tz).slice(0, 7));
  const [ov, setOv] = useState(false);
  const [ovInit, setOvInit] = useState({ date });
  const [pick, setPick] = useState(null);       // a booking
  const [cancel, setCancel] = useState(null);
  const [method, setMethod] = useState('cash');
  const from = localToIso(date, '00:00', tz), to = localToIso(addDays(date, 1), '00:00', tz);
  const avail = useLoad(() => api.get(`/venues/${v.id}/availability`, { date }), [v.id, date]);
  const sched = useLoad(() => api.get(`/venues/${v.id}/schedule`, { from, to }), [v.id, date]);
  const board = { reload: () => { avail.reload(); sched.reload(); } };
  const act = async (fn, msg) => { try { await fn(); toast(msg); setPick(null); board.reload(); } catch (e) { toast(e.message); } };

  const courts = avail.data?.resources ?? [];
  const bookings = (sched.data?.bookings ?? []).filter((b) => b.status !== 'cancelled');
  const blocks = sched.data?.blocks ?? [];
  const open = (r, starts_at) => { setOvInit({ date, resource_id: r.id, start: localHHMM(starts_at, tz) }); setOv(true); };

  // rows at the finest slot length among the courts
  const step = Math.min(60, ...courts.map((r) => r.slot_minutes), 60);
  const allSlots = courts.flatMap((r) => r.slots);
  const parse = (iso) => { const [h, m] = localHHMM(iso, tz).split(':').map(Number); return h * 60 + m; };
  const endOf = (iso) => (new Date(iso) >= new Date(to) ? 1440 : parse(iso) || 1440); // midnight, or a later day, closes this one
  const startOf = (iso) => (new Date(iso) < new Date(from) ? 0 : parse(iso)); // started on an earlier day
  const first = allSlots.length ? Math.min(...allSlots.map((s) => parse(s.starts_at))) : 0;
  const last = allSlots.length ? Math.max(...allSlots.map((s) => endOf(s.ends_at))) : 0;
  const rows = []; for (let m = Math.floor(first / step) * step; m < Math.max(last, first + step); m += step) rows.push(m);
  const hhmm = (m) => `${m >= 720 ? ((Math.floor(m / 60) - 1) % 12) + 1 : Math.floor(m / 60) || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m >= 720 ? 'p' : 'a'}`;

  const bookingAt = (r, m) => bookings.find((b) => b.resource_id === r.id && startOf(b.starts_at) <= m && m < endOf(b.ends_at));
  const blockAt = (r, m) => blocks.find((b) => (b.resource_id === null || b.resource_id === r.id) && startOf(b.starts_at) <= m && m < endOf(b.ends_at));
  const slotAt = (r, m) => r.slots.find((s) => parse(s.starts_at) <= m && m < parse(s.starts_at) + r.slot_minutes);

  return (
    <>
      <Section title="Reservations" color={c.lime}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Btn small title="‹" color={c.paper} onPress={() => setDate(addDays(date, -1))} />
          <Pressable onPress={() => { setMonth(date.slice(0, 7)); setCalOpen(true); }} style={{ flex: 1, minHeight: 40, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}><T weight="700">📅 {longDay(date)}</T></Pressable>
          <Btn small title="›" color={c.paper} onPress={() => setDate(addDays(date, 1))} />
          <Btn small title="Today" color={c.violet} onPress={() => setDate(todayIn(tz))} />
        </View>
        <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
          <T size={12} color={c.mute}>⬜ free — tap to book</T><T size={12} color={c.mute}>🟩 booked & paid</T><T size={12} color={c.mute}>🟧 booked, money due</T><T size={12} color={c.mute}>⛔ blocked</T>
        </View>
        {avail.loading && !avail.data ? <Loading /> : avail.error ? <ErrorBox error={avail.error} onRetry={board.reload} /> : !courts.length ? <Empty emoji="🏟️" title="No courts yet" sub="Use the guided setup to add your courts." /> : (
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
              <View style={{ flexDirection: 'row', marginLeft: LABEL_W }}>
                {courts.map((r) => <View key={r.id} style={{ width: COL_W, paddingHorizontal: 4, paddingBottom: 6 }}><T size={12} weight="800" numberOfLines={1}>{r.sport_emoji ?? KIND[r.kind] ?? ''} {r.name}</T></View>)}
              </View>
              {rows.map((m) => (
                <View key={m} style={{ flexDirection: 'row', height: ROW_H }}>
                  <View style={{ width: LABEL_W, justifyContent: 'center' }}><T size={11} color={c.mute}>{hhmm(m)}</T></View>
                  {courts.map((r) => {
                    const s = slotAt(r, m); const b = bookingAt(r, m); const blk = blockAt(r, m);
                    const startsHere = b && parse(b.starts_at) <= m && m < parse(b.starts_at) + Math.max(step, 1);
                    let bg = '#F1F5F9', body = null, onPress = null;
                    if (b) {
                      const paid = b.payment_status === 'paid';
                      bg = paid ? '#BBF7D0' : '#FED7AA';
                      body = startsHere || m === rows[0] ? <T size={11} weight="700" numberOfLines={2}>{b.event_name ? `🏆 ${b.event_name}` : (b.guest?.name ?? b.customer)}{b.quantity > 1 ? ` ×${b.quantity}` : ''}</T> : null;
                      onPress = () => setPick(b);
                    } else if (blk) { bg = '#E2E8F0'; body = <T size={11} color={c.mute}>⛔ {blk.kind}</T>; onPress = () => toast(`Blocked: ${blk.kind}${blk.reason ? ` · ${blk.reason}` : ''}`); }
                    else if (s && s.status === 'free') { bg = '#fff'; body = <T size={11} color={c.mute}>{moneyIn(s.price_cents, v.currency)}</T>; onPress = () => open(r, s.starts_at); }
                    else if (s) { bg = '#F8FAFC'; body = <T size={10} color={c.mute}>{s.status === 'past' ? '' : s.status.replace('_', ' ')}</T>; if (s.status === 'past') onPress = () => open(r, s.starts_at); }
                    else { bg = '#E2E8F0'; }
                    return (
                      <Pressable key={r.id} disabled={!onPress} onPress={onPress} style={{ width: COL_W, height: ROW_H, borderWidth: 0.5, borderColor: c.line, backgroundColor: bg, padding: 4, justifyContent: 'center', borderLeftWidth: s?.category ? 4 : 0.5, borderLeftColor: s?.category?.color ?? c.line }}>{body}</Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        )}
        <Btn small title="+ Add a booking" color={c.violet} onPress={() => { setOvInit({ date }); setOv(true); }} style={{ alignSelf: 'flex-start' }} />
      </Section>

      <Upcoming v={v} tz={tz} reloadKey={sched.data} onOpen={(d) => setDate(d)} />
      <Sheet visible={!!pick} onClose={() => setPick(null)} title={pick ? `${pick.resource_name} · ${timeIn(pick.starts_at, tz)}–${timeIn(pick.ends_at, tz)}` : ''}>
        {pick ? (
          <View style={{ gap: 10 }}>
            <T weight="800" size={16}>{pick.event_name ? `🏆 ${pick.event_name}` : (pick.guest?.name ?? pick.customer)}</T>
            {pick.event_name ? <T size={13} color={c.mute}>Event booking · {pick.event_starts_on ? `${pick.event_starts_on} → ${pick.event_ends_on ?? '…'}` : 'dates not set'} · booked by {pick.customer}</T> : null}
            {pick.guest?.phone ? <T color={c.mute}>☎ {pick.guest.phone}</T> : null}
            <T size={13} color={c.mute}>{pick.reservation_code ? `Booking ${pick.reservation_code}` : pick.event_name ? 'Event court booking' : 'Venue booking'}{pick.source === 'admin' ? ' · made by the venue' : ''}</T>
            <View style={{ flexDirection: 'row', gap: 6 }}><Tag label={pick.status.replace('_', ' ')} color={pick.status === 'confirmed' ? c.mint : c.orange} /><Tag label={pick.payment_status.replace('_', ' ')} color={pick.payment_status === 'paid' ? c.mint : c.sun} /></View>
            <T weight="700">{moneyIn(pick.price_cents, v.currency)}{pick.open_invoice_due_cents ? ` · ${moneyIn(pick.open_invoice_due_cents, v.currency)} due` : ''}</T>
            {pick.open_invoice_id ? (
              <View style={{ gap: 6 }}>
                <T weight="800" size={13}>Take payment</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{METHODS.map(([k, l]) => <Chip key={k} label={l} active={method === k} onPress={() => setMethod(k)} />)}</View>
                <Btn title={`Record ${moneyIn(pick.open_invoice_due_cents, v.currency)} received`} onPress={() => act(() => api.post(`/invoices/${pick.open_invoice_id}/paid`, { method }), 'Payment recorded — receipt sent')} />
              </View>
            ) : !pick.reservation_id && pick.payment_status !== 'paid' ? <Btn title="Mark as paid" onPress={() => act(() => api.post(`/bookings/${pick.id}/payment`, { status: 'paid' }), 'Marked paid')} /> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {pick.reservation_id ? <Btn small title="Open booking" color={c.paper} onPress={() => { setPick(null); push('Reservation', { id: pick.reservation_id }); }} /> : null}
              {new Date(pick.starts_at) < new Date() && pick.status === 'confirmed' ? <Btn small title="No-show" color={c.paper} onPress={() => act(() => api.post(`/bookings/${pick.id}/no-show`), 'Marked no-show')} /> : null}
              {pick.status === 'confirmed' ? <Btn small title="Cancel booking" color={c.paper} ink={c.red} onPress={() => { setCancel(pick); setPick(null); }} /> : null}
            </View>
          </View>
        ) : null}
      </Sheet>
      <Sheet visible={calOpen} onClose={() => setCalOpen(false)} title="Pick a day"><Calendar month={month} onMonth={setMonth} value={date} today={todayIn(tz)} onChange={(d) => { setDate(d); setCalOpen(false); }} /></Sheet>
      <FormSheet visible={!!cancel} onClose={() => setCancel(null)} title="Cancel this booking" submitLabel="Cancel & refund in full" color={c.red}
        fields={[{ key: 'reason', label: 'Why (the customer sees it)', type: 'chips', options: ['Court unavailable', 'Maintenance', 'Weather', 'Customer asked', 'Other'] }]}
        onSubmit={async (f) => { await api.del(`/bookings/${cancel.id}`, f); board.reload(); return 'Cancelled — customer notified and refunded'; }} />
      <FormSheet visible={ov} onClose={() => setOv(false)} title="Add a booking (override)" submitLabel="Book it" initial={ovInit}
        fields={[
          { key: 'resource_id', label: 'Court', type: 'chips', default: ovInit.resource_id, options: v.resources.map((r) => ({ value: r.id, label: `${r.sport_emoji ?? KIND[r.kind] ?? ''} ${r.name}` })) },
          { key: 'date', label: 'Date', type: 'date' }, { key: 'start', label: 'Starts', type: 'time' },
          { key: 'hours', label: 'Length', type: 'chips', default: 1, options: [{ value: 0.5, label: '30 min' }, { value: 1, label: '1 hour' }, { value: 1.5, label: '1½ h' }, { value: 2, label: '2 hours' }, { value: 3, label: '3 hours' }, { value: 4, label: '4 hours' }] },
          { key: 'quantity', label: 'Units', type: 'stepper', min: 1, max: 50, default: 1, show: (x) => (v.resources.find((r) => r.id === x.resource_id)?.capacity ?? 1) > 1, hint: 'This court takes several bookings at once' },
          { key: 'reason', label: 'Why (kept in the audit log)', type: 'chips', options: ['Phone booking', 'Walk-in', 'League / tournament', 'Coaching', 'Member', 'Other'] },
          { key: 'guest_name', label: 'Guest name', optional: true }, { key: 'guest_phone', label: 'Guest phone', input: 'phone', optional: true },
          { key: 'normal_price', label: 'Charge the normal price', type: 'switch', default: true },
          { key: 'price_cents', label: 'Price for this booking (0 = free)', type: 'money', currency: v.currency, show: (x) => !x.normal_price },
          { key: 'displace_conflicts', label: 'Cancel bookings already in the way', type: 'switch', default: false, hint: 'Those customers are refunded and told' },
        ]}
        onSubmit={async (f) => {
          const starts_at = localToIso(f.date, f.start, tz);
          const ends_at = new Date(new Date(starts_at).getTime() + (f.hours ?? 1) * 3600e3).toISOString();
          const out = await api.post(`/venues/${v.id}/override-bookings`, { items: [{ resource_id: f.resource_id, starts_at, ends_at, quantity: f.quantity ?? 1, price_cents: f.normal_price ? undefined : f.price_cents }], reason: f.reason, guest_name: f.guest_name, guest_phone: f.guest_phone, displace_conflicts: f.displace_conflicts });
          board.reload(); return out.displaced_bookings ? `Booked — ${out.displaced_bookings} booking(s) cancelled and refunded` : 'Booked';
        }} />
    </>
  );
}

const AHEAD_DAYS = 30;

/** Everything booked at the venue over the next weeks, day by day — customers, walk-ins and event/tournament court bookings alike. */
function Upcoming({ v, tz, reloadKey, onOpen }) {
  const [only, setOnly] = useState('all');
  const from = new Date().toISOString(), to = localToIso(addDays(todayIn(tz), AHEAD_DAYS), '00:00', tz);
  const list = useLoad(() => api.get(`/venues/${v.id}/schedule`, { from, to }), [v.id, reloadKey]);
  const all = (list.data?.bookings ?? []).filter((b) => b.status !== 'cancelled');
  const rows = only === 'events' ? all.filter((b) => b.event_id) : all;
  const byDay = rows.reduce((m, b) => { const d = localDate(b.starts_at, tz); return m.set(d, [...(m.get(d) ?? []), b]); }, new Map());
  return (
    <Section title={`Next ${AHEAD_DAYS} days`} color={c.cyan}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Chip label={`All (${all.length})`} active={only === 'all'} onPress={() => setOnly('all')} />
        <Chip label={`🏆 Events & tournaments (${all.filter((b) => b.event_id).length})`} active={only === 'events'} onPress={() => setOnly('events')} />
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ? <Empty emoji="🗓️" title="Nothing booked yet" sub={only === 'events' ? 'Court bookings for events and tournaments appear here.' : 'New bookings appear here.'} /> : [...byDay.entries()].map(([d, bs]) => (
        <View key={d} style={{ gap: 6 }}>
          <T weight="800" size={13}>{longDay(d)}</T>
          {bs.map((b) => (
            <Row key={b.id} color={b.event_id ? c.sunSoft : c.paper} onPress={() => onOpen(d)}
              title={`${b.event_name ? `🏆 ${b.event_name}` : (b.guest?.name ?? b.customer)} · ${b.resource_name}`}
              sub={`${dateTimeIn(b.starts_at, tz)} – ${timeIn(b.ends_at, tz)}${b.event_id ? ` · event ${b.event_starts_on ?? '?'} → ${b.event_ends_on ?? '?'}` : ''}`}
              right={<T weight="700" size={12}>{moneyIn(b.price_cents, v.currency)}</T>} />
          ))}
        </View>
      ))}
    </Section>
  );
}
