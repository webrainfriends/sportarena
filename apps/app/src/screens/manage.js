import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Field, H1, Loading, Row, Screen, Seg, Section, Sheet, StatPill, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { KIND } from './book';
import { MediaManager, VenueReviews } from './venue-media';
import { PlansManager } from './plans';
import { useNav } from '../nav';
import { WEEKDAYS, addDays, dateTimeIn, fmtMin, hoursSummary, localToIso, longDay, moneyIn, timeIn, todayIn } from '../vtime';
import { Calendar } from '../pickers';

const YN = [{ value: false, label: 'No' }, { value: true, label: 'Yes' }];
const TABS = [['schedule', 'Schedule'], ['blocks', 'Blocks'], ['pricing', 'Pricing'], ['discounts', 'Discounts'], ['payments', 'Payments'], ['plans', 'Memberships & passes'], ['media', 'Photos & videos'], ['reviews', 'Reviews'], ['reports', 'Reports'], ['setup', 'Setup']];
const num = (x) => (x === undefined || x === '' ? undefined : Number(x));
const days = (s) => (s ? String(s).split(/[,\s]+/).filter(Boolean).map(Number) : undefined);
const daysHint = 'Days as numbers, 0 = Sun … 6 = Sat, e.g. 1,2,3,4,5';

export function Manage({ id }) {
  const v = useLoad(() => api.get(`/venues/${id}`), [id]);
  const [tab, setTab] = useState('schedule');
  if (v.loading && !v.data) return <Screen><Loading /></Screen>;
  if (v.error) return <Screen><ErrorBox error={v.error} onRetry={v.reload} /></Screen>;
  const x = v.data;
  const P = { v: x, reload: v.reload };
  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>{x.emoji} {x.name}</H1>
      <T color={c.mute} weight="700">Venue console · {x.timezone} · {x.currency}{x.active ? '' : ' · HIDDEN'}</T>
      <View style={{ marginTop: 10 }}><Seg options={TABS.map(([value, label]) => ({ value, label }))} value={tab} onChange={setTab} color={c.violet} /></View>
      {tab === 'schedule' ? <Schedule {...P} /> : tab === 'blocks' ? <Blocks {...P} /> : tab === 'pricing' ? <Pricing {...P} /> : tab === 'discounts' ? <Discounts {...P} /> : tab === 'payments' ? <Payments {...P} /> : tab === 'plans' ? <PlansManager {...P} /> : tab === 'media' ? <Section title="Photos & videos" color={c.cyan}><MediaManager venue={x} /></Section> : tab === 'reviews' ? <Section title="Reviews" color={c.pink}><VenueReviews venueId={x.id} /></Section> : tab === 'reports' ? <Reports {...P} /> : <Setup {...P} />}
    </Screen>
  );
}

// ------------------------------------------------------------------ schedule + override
function Schedule({ v }) {
  const { toast } = useSession();
  const tz = v.timezone;
  const [date, setDate] = useState(todayIn(tz));
  const [calOpen, setCalOpen] = useState(false);
  const [month, setMonth] = useState(todayIn(tz).slice(0, 7));
  const [ov, setOv] = useState(false);
  const [cancel, setCancel] = useState(null);
  const from = localToIso(date, '00:00', tz), to = localToIso(addDays(date, 1), '00:00', tz);
  const s = useLoad(() => api.get(`/venues/${v.id}/schedule`, { from, to }), [v.id, date]);
  const act = async (fn, msg) => { try { await fn(); toast(msg); s.reload(); } catch (e) { toast(e.message); } };
  return (
    <>
      <Section title="Day view" color={c.lime}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Btn small title="‹" color={c.paper} onPress={() => setDate(addDays(date, -1))} />
          <Pressable onPress={() => { setMonth(date.slice(0, 7)); setCalOpen(true); }} style={{ flex: 1, minHeight: 40, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}><T weight="700">📅 {longDay(date)}</T></Pressable>
          <Btn small title="›" color={c.paper} onPress={() => setDate(addDays(date, 1))} />
          <Btn small title="Today" color={c.violet} onPress={() => setDate(todayIn(tz))} />
        </View>
        <Btn small title="+ Add booking (override)" color={c.violet} onPress={() => setOv(true)} style={{ alignSelf: 'flex-start' }} />
        {s.loading && !s.data ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : (
          <>
            {s.data.blocks.map((b) => <Card key={b.id} color={c.sunSoft} pad={10}><T weight="700">⛔ {timeIn(b.starts_at, tz)}–{timeIn(b.ends_at, tz)} · {b.kind}{b.reason ? ` · ${b.reason}` : ''}</T><T size={12} color={c.mute}>{b.resource_id ? v.resources.find((r) => r.id === b.resource_id)?.name : 'Whole venue'}</T></Card>)}
            {s.data.bookings.length ? s.data.bookings.map((b) => (
              <Card key={b.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T weight="700">{timeIn(b.starts_at, tz)}–{timeIn(b.ends_at, tz)} · {b.resource_name}{b.quantity > 1 ? ` × ${b.quantity}` : ''}</T>
                    <T size={13} color={c.mute}>{b.guest?.name ? `${b.guest.name}${b.guest.phone ? ` · ${b.guest.phone}` : ''} (walk-in)` : b.customer}{b.reservation_code ? ` · ${b.reservation_code}` : ''}{b.source === 'admin' ? ' · by venue' : ''}</T>
                    {b.cancel_reason ? <T size={12} color={c.mute}>{b.cancel_reason}</T> : null}
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="700">{moneyIn(b.price_cents, v.currency)}</T>
                    <View style={{ flexDirection: 'row', gap: 4 }}><Tag label={b.status.replace('_', ' ')} color={b.status === 'confirmed' ? c.mint : b.status === 'no_show' ? c.orange : c.red} /><Tag label={b.payment_status.replace('_', ' ')} color={b.payment_status === 'paid' ? c.mint : c.sun} /></View></View>
                </View>
                {b.status !== 'cancelled' ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <Btn small title={b.payment_status === 'paid' ? 'Mark unpaid' : 'Mark paid'} color={c.violet} onPress={() => act(() => api.post(`/bookings/${b.id}/payment`, { status: b.payment_status === 'paid' ? 'unpaid' : 'paid' }), 'Updated')} />
                    {new Date(b.starts_at) < new Date() && b.status === 'confirmed' ? <Btn small title="No-show" color={c.paper} onPress={() => act(() => api.post(`/bookings/${b.id}/no-show`), 'Marked no-show')} /> : null}
                    {b.status === 'confirmed' ? <Btn small title="Cancel" color={c.paper} ink={c.red} onPress={() => setCancel(b)} /> : null}
                  </View>
                ) : null}
              </Card>
            )) : <Empty emoji="🗓️" title="No bookings this day" />}
          </>
        )}
      </Section>
      <Sheet visible={calOpen} onClose={() => setCalOpen(false)} title="Pick a day"><Calendar month={month} onMonth={setMonth} value={date} today={todayIn(tz)} onChange={(d) => { setDate(d); setCalOpen(false); }} /></Sheet>
      <FormSheet visible={!!cancel} onClose={() => setCancel(null)} title="Cancel this booking" submitLabel="Cancel & refund in full" color={c.red}
        fields={[{ key: 'reason', label: 'Reason (the customer sees it)', optional: true }]}
        onSubmit={async (f) => { await api.del(`/bookings/${cancel.id}`, f); s.reload(); return 'Cancelled — customer notified and refunded'; }} />
      <FormSheet visible={ov} onClose={() => setOv(false)} title="Add a booking (override)" submitLabel="Book it" initial={{ date }}
        fields={[
          { key: 'resource_id', label: 'Area', type: 'choice', options: v.resources.map((r) => ({ value: r.id, label: `${KIND[r.kind] ?? ''} ${r.name}` })) },
          { key: 'date', label: 'Date', type: 'date' }, { key: 'start', label: 'Start time', type: 'time' }, { key: 'hours', label: 'Length in hours', type: 'number', placeholder: '1' },
          { key: 'quantity', label: 'Units', type: 'number', optional: true }, { key: 'reason', label: 'Reason (audit log)', placeholder: 'League night, phone booking…' },
          { key: 'guest_name', label: 'Walk-in guest name', optional: true }, { key: 'guest_phone', label: 'Guest phone', optional: true },
          { key: 'price_cents', label: 'Price override (minor units; 0 = free)', type: 'number', optional: true },
          { key: 'displace_conflicts', label: 'Cancel bookings in the way?', type: 'choice', options: YN },
        ]}
        onSubmit={async (f) => {
          const starts_at = localToIso(f.date, f.start, tz);
          const ends_at = new Date(new Date(starts_at).getTime() + (f.hours ?? 1) * 3600e3).toISOString();
          const out = await api.post(`/venues/${v.id}/override-bookings`, { items: [{ resource_id: f.resource_id, starts_at, ends_at, quantity: f.quantity ?? 1, price_cents: f.price_cents }], reason: f.reason, guest_name: f.guest_name, guest_phone: f.guest_phone, displace_conflicts: f.displace_conflicts });
          s.reload(); return out.displaced_bookings ? `Booked — ${out.displaced_bookings} booking(s) cancelled and refunded` : 'Booked';
        }} />
    </>
  );
}

// ------------------------------------------------------------------ blocks
function Blocks({ v }) {
  const { toast } = useSession();
  const tz = v.timezone;
  const [form, setForm] = useState(false);
  const from = new Date().toISOString();
  const list = useLoad(() => api.get(`/venues/${v.id}/blocks`, { from, limit: 100 }), [v.id]);
  const batches = [...(list.data ?? []).reduce((m, b) => m.set(b.batch_id, [...(m.get(b.batch_id) ?? []), b]), new Map()).values()];
  return (
    <Section title="Blocked time" color={c.orange}>
      <T color={c.mute} size={13}>Block courts for maintenance, holidays or private hire — in bulk. Customers can't book blocked time.</T>
      <Btn title="Block time" color={c.violet} onPress={() => setForm(true)} />
      {list.loading && !list.data ? <Loading /> : batches.length ? batches.map((g) => (
        <Row key={g[0].batch_id} color={c.sunSoft} title={`${g[0].kind}${g[0].reason ? ` · ${g[0].reason}` : ''}`}
          sub={`${g.length} block${g.length === 1 ? '' : 's'} · ${dateTimeIn(g[0].starts_at, tz)} → ${dateTimeIn(g[g.length - 1].ends_at, tz)} · ${[...new Set(g.map((b) => b.resource_name ?? 'Whole venue'))].join(', ')}`}
          right={<Btn small title="Release" color={c.paper} onPress={async () => { try { const r = await api.del(`/venues/${v.id}/blocks`, { batch_id: g[0].batch_id }); toast(`${r.released} released`); list.reload(); } catch (e) { toast(e.message); } }} />} />
      )) : <Empty emoji="✅" title="Nothing blocked" />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="Block time" submitLabel="Block" initial={{ from_date: todayIn(tz), to_date: todayIn(tz) }}
        fields={[
          { key: 'resource_id', label: 'Which area', type: 'choice', options: [{ value: '', label: 'Whole venue' }, ...v.resources.map((r) => ({ value: r.id, label: r.name }))] },
          { key: 'from_date', label: 'From date', type: 'date' }, { key: 'to_date', label: 'To date', type: 'date' },
          { key: 'start_time', label: 'Daily from', type: 'time', optional: true }, { key: 'end_time', label: 'Daily until', type: 'time', optional: true },
          { key: 'weekdays', label: 'Only on these days', hint: daysHint, optional: true },
          { key: 'kind', label: 'Kind', type: 'choice', options: ['maintenance', 'holiday', 'event', 'private', 'other'] }, { key: 'reason', label: 'Reason', optional: true },
          { key: 'cancel_conflicting', label: 'Cancel & refund bookings already in that time?', type: 'choice', options: YN },
        ]}
        onSubmit={async (f) => {
          const r = await api.post(`/venues/${v.id}/blocks`, { resource_ids: f.resource_id ? [f.resource_id] : [], from_date: f.from_date, to_date: f.to_date, start_time: f.start_time, end_time: f.end_time, weekdays: days(f.weekdays), kind: f.kind, reason: f.reason, cancel_conflicting: f.cancel_conflicting });
          list.reload(); return `${r.blocks} blocks created${r.cancelled_bookings ? `, ${r.cancelled_bookings} booking(s) cancelled` : ''}`;
        }} />
    </Section>
  );
}

// ------------------------------------------------------------------ pricing & areas
function Pricing({ v, reload }) {
  const { toast } = useSession();
  const card = useLoad(() => api.get(`/venues/${v.id}/price-rules`), [v.id]);
  const sports = useLoad(() => api.get('/sports'), []);
  const [rule, setRule] = useState(false);
  const [area, setArea] = useState(false);
  const [edit, setEdit] = useState(null);
  const areaName = (rid) => v.resources.find((r) => r.id === rid)?.name ?? 'All areas';
  const done = () => { card.reload(); reload(); };
  const sportOpts = [{ value: '', label: 'Any' }, ...(sports.data ?? []).map((s) => ({ value: s.slug, label: `${s.emoji} ${s.name}` }))];
  return (
    <>
      <Section title="Courts, tables & areas" color={c.lime}>
        <T color={c.mute} size={13}>Each area has its own capacity (how many bookings at once — or units of kit), players per unit, slot length and base rate.</T>
        {v.resources.map((r) => (
          <Row key={r.id} onPress={() => setEdit(r)} title={`${KIND[r.kind] ?? ''} ${r.name}`}
            sub={[r.sport, `capacity ${r.capacity}`, r.max_players && `${r.max_players} players`, `${r.slot_minutes}-min slots`, `${r.min_slots}–${r.max_slots} slots`].filter(Boolean).join(' · ')}
            right={<T weight="700">{moneyIn(r.hourly_rate_cents, v.currency)}/h</T>} />
        ))}
        <Btn small title="+ Add area" color={c.violet} onPress={() => setArea(true)} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Rate rules" color={c.sun}>
        <T color={c.mute} size={13}>Peak, off-peak, weekend or seasonal rates. The most specific rule wins; otherwise the area's base rate applies.</T>
        {card.data?.rules.length ? card.data.rules.map((r) => (
          <Row key={r.id} title={`${r.name} · ${moneyIn(r.hourly_rate_cents, v.currency)}/h`}
            sub={`${areaName(r.resource_id)} · ${r.start}–${r.end} · ${r.weekdays ? r.weekdays.map((d) => WEEKDAYS[d]).join(' ') : 'every day'}${r.valid_from || r.valid_to ? ` · ${r.valid_from?.slice(0, 10) ?? '…'} → ${r.valid_to?.slice(0, 10) ?? '…'}` : ''}`}
            right={<Btn small title="Delete" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/price-rules/${r.id}`); done(); } catch (e) { toast(e.message); } }} />} />
        )) : <Empty emoji="🏷️" title="No rate rules" sub="Everything is charged at the area's base rate." />}
        <Btn small title="+ Add rate rule" color={c.violet} onPress={() => setRule(true)} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <FormSheet visible={rule} onClose={() => setRule(false)} title="New rate rule"
        fields={[{ key: 'name', label: 'Name', placeholder: 'Weekday evening peak' }, { key: 'resource_id', label: 'Applies to', type: 'choice', options: [{ value: '', label: 'All areas' }, ...v.resources.map((r) => ({ value: r.id, label: r.name }))] },
          { key: 'start', label: 'From', type: 'time' }, { key: 'end', label: 'Until', type: 'time' }, { key: 'hourly_rate_cents', label: 'Rate per hour (minor units)', type: 'number' },
          { key: 'weekdays', label: 'Days', hint: daysHint, optional: true }, { key: 'valid_from', label: 'Valid from', type: 'date', optional: true }, { key: 'valid_to', label: 'Valid until', type: 'date', optional: true }, { key: 'priority', label: 'Priority', type: 'number', optional: true }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/price-rules`, { ...f, resource_id: f.resource_id || undefined, weekdays: days(f.weekdays) }); done(); return 'Rule added'; }} />
      <FormSheet visible={area} onClose={() => setArea(false)} title="Add an area"
        fields={[{ key: 'kind', label: 'Type', type: 'choice', options: ['court', 'table', 'ground', 'pool', 'lane', 'rink', 'range', 'track', 'room', 'studio', 'equipment', 'other'] }, { key: 'name', label: 'Name', placeholder: 'Court 1' },
          { key: 'sport', label: 'Sport', type: 'choice', options: sportOpts },
          { key: 'capacity', label: 'Capacity (bookings at once / units)', type: 'number', optional: true }, { key: 'max_players', label: 'Players per unit', type: 'number', optional: true },
          { key: 'hourly_rate_cents', label: 'Base rate per hour (minor units)', type: 'number', optional: true },
          { key: 'slot_minutes', label: 'Slot length (15, 30, 45, 60, 90, 120)', type: 'number', optional: true }, { key: 'min_slots', label: 'Min slots per booking', type: 'number', optional: true }, { key: 'max_slots', label: 'Max slots per booking', type: 'number', optional: true }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/resources`, { ...f, sport: f.sport || undefined }); done(); return 'Area added'; }} />
      <FormSheet visible={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.name ?? ''}`} initial={edit ? { name: edit.name, capacity: edit.capacity, max_players: edit.max_players ?? '', hourly_rate_cents: edit.hourly_rate_cents, slot_minutes: edit.slot_minutes, min_slots: edit.min_slots, max_slots: edit.max_slots } : {}}
        fields={[{ key: 'name', label: 'Name' }, { key: 'capacity', label: 'Capacity', type: 'number' }, { key: 'max_players', label: 'Players per unit', type: 'number', optional: true }, { key: 'hourly_rate_cents', label: 'Base rate per hour (minor units)', type: 'number' },
          { key: 'slot_minutes', label: 'Slot length (min)', type: 'number' }, { key: 'min_slots', label: 'Min slots', type: 'number' }, { key: 'max_slots', label: 'Max slots', type: 'number' }, { key: 'active', label: 'Available for booking?', type: 'choice', options: [{ value: true, label: 'Yes' }, { value: false, label: 'Retire it' }] }]}
        onSubmit={async (f) => { await api.patch(`/resources/${edit.id}`, f); done(); return 'Saved'; }} />
    </>
  );
}

// ------------------------------------------------------------------ discounts
function Discounts({ v }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/venues/${v.id}/discounts`, { include_inactive: true }), [v.id]);
  const [form, setForm] = useState(false);
  return (
    <Section title="Discounts" color={c.sun}>
      <T color={c.mute} size={13}>Automatic offers (e.g. 3+ slots = 10% off) or promo codes. Customers get the single best discount per venue.</T>
      <Btn small title="+ New discount" color={c.violet} onPress={() => setForm(true)} style={{ alignSelf: 'flex-start' }} />
      {list.loading && !list.data ? <Loading /> : list.data?.length ? list.data.map((d) => (
        <Row key={d.id} color={d.active ? c.paper : c.violetSoft} title={`${d.name} · ${d.kind === 'percent' ? `${d.value}%` : moneyIn(d.value, v.currency)} off${d.code ? ` · code ${d.code}` : ' · automatic'}`}
          sub={[d.min_slots > 1 && `${d.min_slots}+ slots`, d.weekdays && d.weekdays.map((x) => WEEKDAYS[x]).join(' '), d.valid_to && `until ${d.valid_to.slice(0, 10)}`, `used ${d.redemptions}${d.max_redemptions ? `/${d.max_redemptions}` : ''}`, `given ${moneyIn(d.given_cents, v.currency)}`].filter(Boolean).join(' · ')}
          right={<Btn small title={d.active ? 'Stop' : 'Resume'} color={c.paper} onPress={async () => { try { await api.patch(`/discounts/${d.id}`, { active: !d.active }); list.reload(); } catch (e) { toast(e.message); } }} />} />
      )) : <Empty emoji="🏷️" title="No discounts yet" />}
      <FormSheet visible={form} onClose={() => setForm(false)} title="New discount"
        fields={[{ key: 'name', label: 'Name', placeholder: 'Book 3 slots, save 10%' }, { key: 'code', label: 'Promo code (blank = automatic)', optional: true },
          { key: 'kind', label: 'Type', type: 'choice', options: [{ value: 'percent', label: 'Percent' }, { value: 'fixed', label: 'Fixed amount' }] }, { key: 'value', label: 'Value (percent, or minor units)', type: 'number' },
          { key: 'min_slots', label: 'Minimum slots', type: 'number', optional: true }, { key: 'resource_id', label: 'Only for', type: 'choice', options: [{ value: '', label: 'All areas' }, ...v.resources.map((r) => ({ value: r.id, label: r.name }))] },
          { key: 'weekdays', label: 'Only on days', hint: daysHint, optional: true }, { key: 'valid_from', label: 'From', type: 'date', optional: true }, { key: 'valid_to', label: 'Until', type: 'date', optional: true },
          { key: 'max_redemptions', label: 'Max total uses', type: 'number', optional: true }, { key: 'per_user_limit', label: 'Max uses per customer', type: 'number', optional: true }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/discounts`, { ...f, resource_id: f.resource_id || undefined, weekdays: days(f.weekdays) }); list.reload(); return 'Discount created'; }} />
    </Section>
  );
}

// ------------------------------------------------------------------ reports
const Bar = ({ pct, color = c.pink }) => <View style={{ height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden', flex: 1 }}><View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: 8, backgroundColor: color }} /></View>;
const RANGES = [['Last 7 days', -7, 0], ['Last 30 days', -30, 0], ['Last 90 days', -90, 0], ['Next 30 days', 0, 30], ['Custom…', 0, 0]];
function Reports({ v }) {
  const tz = v.timezone;
  const [ri, setRi] = useState(1);
  const [custom, setCustom] = useState(null);
  const [pick, setPick] = useState(false);
  const [, a, b] = RANGES[ri];
  const from = ri === 4 && custom ? custom.from : addDays(todayIn(tz), a), to = ri === 4 && custom ? custom.to : addDays(todayIn(tz), b);
  const r = useLoad(() => api.get(`/venues/${v.id}/reports`, { from, to, group_by: (Date.parse(to) - Date.parse(from)) / 864e5 > 45 ? 'week' : 'day' }), [v.id, ri, custom?.from, custom?.to]);
  const money = (x) => moneyIn(x, v.currency);
  const peak = Math.max(1, ...(r.data?.by_hour ?? []).map((h) => h.bookings));
  const top = Math.max(1, ...(r.data?.series ?? []).map((s) => s.net_cents));
  return (
    <>
      <Section title="Report" color={c.cyan}>
        <Seg options={RANGES.map(([label], value) => ({ value, label: value === 4 && custom ? `${custom.from.slice(5)} → ${custom.to.slice(5)}` : label }))} value={ri} onChange={(i) => { if (i === 4) setPick(true); else setRi(i); }} color={c.cyan} />
        <FormSheet visible={pick} onClose={() => setPick(false)} title="Report period" submitLabel="Show report" initial={{ from: custom?.from ?? addDays(todayIn(tz), -30), to: custom?.to ?? todayIn(tz) }}
          fields={[{ key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]} onSubmit={async (f) => { if (f.to < f.from) throw new Error('The end date is before the start'); setCustom(f); setRi(4); }} />
        {r.loading && !r.data ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (() => {
          const s = r.data.summary;
          return (
            <>
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                <StatPill value={money(s.revenue_cents)} label="REVENUE" color={c.lime} /><StatPill value={s.bookings} label="BOOKINGS" /><StatPill value={s.unit_hours} label="HOURS" /><StatPill value={s.utilisation == null ? '–' : `${Math.round(s.utilisation * 100)}%`} label="UTILISED" />
              </View>
              <Card>
                {[['Gross', money(s.gross_cents)], ['Discounts given', `− ${money(s.discount_cents)}`], ['Net from bookings', money(s.net_cents)], ['Cancellation fees kept', money(s.cancellation_fee_cents)], ['Refunded', money(s.refunded_cents)],
                  ['Paid at the desk', money(s.paid_cents)], ['Still to collect', money(s.outstanding_cents)], ['Average booking', money(s.average_booking_cents)],
                  ['Cancellations', `${s.cancellations} (${Math.round(s.cancellation_rate * 100)}%)`], ['No-shows', s.no_shows]].map(([k, val]) => <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T color={c.mute}>{k}</T><T weight="700">{val}</T></View>)}
              </Card>
              <Section title="Revenue over time" color={c.lime}>
                <Card>{r.data.series.length ? r.data.series.map((x) => <View key={x.period} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}><T size={11} color={c.mute} style={{ width: 70 }}>{x.period.slice(5)}</T><Bar pct={(x.net_cents / top) * 100} color={c.lime} /><T size={12} weight="700" style={{ width: 80, textAlign: 'right' }}>{money(x.net_cents)}</T></View>) : <T color={c.mute}>No bookings in this period.</T>}</Card>
              </Section>
              <Section title="Utilisation by area" color={c.pink}>
                <Card>{r.data.by_resource.map((x) => <View key={x.resource_id} style={{ paddingVertical: 4 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">{x.name}</T><T color={c.mute}>{x.utilisation == null ? '–' : `${Math.round(x.utilisation * 100)}%`} · {x.unit_hours}h of {x.available_unit_hours}h · {money(x.net_cents)}</T></View><Bar pct={(x.utilisation ?? 0) * 100} /></View>)}</Card>
              </Section>
              <Section title="Busiest hours" color={c.orange}>
                <Card><View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 90 }}>{Array.from({ length: 24 }, (_, h) => { const x = r.data.by_hour.find((y) => y.hour === h); return <View key={h} style={{ flex: 1, height: `${Math.max(3, ((x?.bookings ?? 0) / peak) * 100)}%`, backgroundColor: x ? c.orange : c.violetSoft, borderRadius: 3 }} />; })}</View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>{[0, 6, 12, 18, 23].map((h) => <T key={h} size={10} color={c.mute}>{h}:00</T>)}</View>
                  <T size={12} color={c.mute} style={{ marginTop: 6 }}>Peak: {r.data.peak_hours.slice(0, 3).map((p) => `${p.hour}:00 (${p.bookings})`).join(', ') || '—'}</T></Card>
              </Section>
              <Section title="Busiest days" color={c.sun}><Card>{WEEKDAYS.map((d, i) => { const x = r.data.by_weekday.find((y) => y.weekday === i); const mx = Math.max(1, ...r.data.by_weekday.map((y) => y.bookings)); return <View key={d} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}><T size={12} color={c.mute} style={{ width: 34 }}>{d}</T><Bar pct={((x?.bookings ?? 0) / mx) * 100} color={c.sun} /><T size={12} weight="700" style={{ width: 28, textAlign: 'right' }}>{x?.bookings ?? 0}</T></View>; })}</Card></Section>
              {r.data.discounts.length ? <Section title="Discounts" color={c.mint}><Card>{r.data.discounts.map((d) => <View key={d.discount_id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T>{d.name}{d.code ? ` (${d.code})` : ''}</T><T weight="700">{d.uses}× · {money(d.given_cents)}</T></View>)}</Card></Section> : null}
              <Section title="Customers" color={c.violet}>
                <Card><T weight="700">{r.data.customers.unique} customers · {r.data.customers.new} new · {r.data.customers.repeat} returning</T>
                  {r.data.customers.top.map((u) => <View key={u.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T>{u.display_name}</T><T weight="700">{u.bookings}× · {money(u.spent_cents)}</T></View>)}</Card>
              </Section>
            </>
          );
        })()}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ setup: profile, hours, contacts, staff
function Setup({ v, reload }) {
  const { toast, user } = useSession();
  const [prof, setProf] = useState(false);
  const [hrs, setHrs] = useState(false);
  const [ct, setCt] = useState(false);
  const [st, setSt] = useState(false);
  const [money, setMoney] = useState(false);
  const currencies = useLoad(() => api.get('/currencies'), []);
  const contacts = useLoad(() => api.get(`/venues/${v.id}/contacts`), [v.id]);
  const staff = useLoad(() => api.get(`/venues/${v.id}/staff`), [v.id]);
  const owner = v.owner_id === user.id;
  const save = async (f) => { await api.patch(`/venues/${v.id}`, f); reload(); return 'Saved'; };
  return (
    <>
      <Section title="Profile & policy" color={c.pink}>
        <Card>
          <T weight="700">{[v.address, v.city, v.postal_code, v.country].filter(Boolean).join(', ') || 'No address yet'}</T>
          <T size={13} color={c.mute}>{v.latitude != null ? `📍 ${v.latitude}, ${v.longitude}` : 'No map location — add latitude & longitude so people can find you'}</T>
          <T size={13} color={c.mute}>☎ {v.phone ?? '—'} · ✉ {v.email ?? '—'} · {v.website ?? 'no website'}</T>
          <T size={13} color={c.mute}>Notice {v.min_notice_minutes} min · up to {v.max_advance_days} days ahead · free cancel {v.cancel_free_hours}h · late refund {v.late_cancel_refund_percent}%</T>
          <T size={13} color={c.mute}>Staff notifications: {v.notify_owner ? 'on' : 'off'} · Amenities: {v.amenities?.join(', ') || '—'}</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Btn small title="Edit" onPress={() => setProf(true)} />
            <Btn small title={v.active ? 'Hide from search' : 'Show in search'} color={c.paper} onPress={async () => { try { await save({ active: !v.active }); } catch (e) { toast(e.message); } }} />
          </View>
        </Card>
      </Section>
      <Section title="Money, tax & invoices" color={c.sun}>
        <Card>
          <T weight="700">{v.currency} · {v.payment_mode === 'pay_at_venue' ? 'Pay at the venue' : v.payment_mode === 'online_optional' ? 'Pay online or at the venue' : 'Online payment required'}</T>
          <T size={13} color={c.mute}>{v.tax_rate_bp ? `${v.tax_name} ${v.tax_rate_bp / 100}% — prices ${v.tax_inclusive ? 'include' : 'exclude'} it` : 'No tax charged'} · Invoices from {v.legal_name ?? v.name}{v.tax_id ? ` · ${v.tax_name} ID ${v.tax_id}` : ''}</T>
          <T size={12} color={c.mute}>Invoice numbers start {v.invoice_prefix ?? 'with an automatic prefix'}-{new Date().getFullYear()}-000001. Online payment needs Stripe or PayPal switched on for the server.</T>
          <Btn small title="Edit money settings" color={c.violet} onPress={() => setMoney(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
        </Card>
      </Section>
      <Section title="Opening hours" color={c.lime}>
        <Card><T weight="700">🕒 {hoursSummary(v.hours)}</T><Btn small title="Edit hours" color={c.violet} onPress={() => setHrs(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} /></Card>
      </Section>
      <Section title="Contacts" color={c.cyan}>
        <T size={12} color={c.mute}>Names, phones and emails are encrypted. Public contacts are shown to signed-in customers.</T>
        {contacts.data?.map((x) => <Row key={x.id} title={`${x.role}${x.is_public ? ' · public' : ''}`} sub={[x.name, x.phone, x.email].filter(Boolean).join(' · ')} right={<Btn small title="Remove" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/venues/${v.id}/contacts/${x.id}`); contacts.reload(); }} />} />)}
        <Btn small title="+ Add contact" color={c.violet} onPress={() => setCt(true)} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Team" color={c.violet}>
        {staff.data?.map((x) => <Row key={x.id} title={x.display_name} sub={`@${x.handle} · ${x.role}`} right={owner && x.role !== 'owner' ? <Btn small title="Remove" color={c.paper} ink={c.red} onPress={async () => { await api.del(`/venues/${v.id}/staff/${x.id}`); staff.reload(); }} /> : null} />)}
        {owner ? <Btn small title="+ Add team member" color={c.violet} onPress={() => setSt(true)} style={{ alignSelf: 'flex-start' }} /> : null}
      </Section>

      <FormSheet visible={prof} onClose={() => setProf(false)} title="Venue profile" initial={{ name: v.name, city: v.city ?? '', address: v.address ?? '', postal_code: v.postal_code ?? '', country: v.country ?? '', description: v.description ?? '', latitude: v.latitude ?? '', longitude: v.longitude ?? '', timezone: v.timezone, currency: v.currency, phone: v.phone ?? '', email: v.email ?? '', website: v.website ?? '', amenities: (v.amenities ?? []).join(', '), min_notice_minutes: v.min_notice_minutes, max_advance_days: v.max_advance_days, cancel_free_hours: v.cancel_free_hours, late_cancel_refund_percent: v.late_cancel_refund_percent, notify_owner: v.notify_owner }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'description', label: 'About', type: 'multiline', optional: true }, { key: 'address', label: 'Address', optional: true }, { key: 'city', label: 'City', optional: true }, { key: 'postal_code', label: 'Postal code', optional: true }, { key: 'country', label: 'Country', optional: true },
          { key: 'latitude', label: 'Latitude', type: 'number', optional: true, hint: 'Right-click the spot in Google Maps to copy it' }, { key: 'longitude', label: 'Longitude', type: 'number', optional: true },
          { key: 'timezone', label: 'Time zone (IANA)', placeholder: 'Asia/Kolkata' }, { key: 'currency', label: 'Currency (ISO)', placeholder: 'INR' },
          { key: 'phone', label: 'Public phone', optional: true }, { key: 'email', label: 'Public email', optional: true }, { key: 'website', label: 'Website', optional: true }, { key: 'amenities', label: 'Amenities (comma separated)', optional: true },
          { key: 'min_notice_minutes', label: 'Minimum notice (minutes)', type: 'number' }, { key: 'max_advance_days', label: 'Bookable up to (days ahead)', type: 'number' },
          { key: 'cancel_free_hours', label: 'Free cancellation until (hours before)', type: 'number' }, { key: 'late_cancel_refund_percent', label: 'Refund after that (%)', type: 'number' },
          { key: 'notify_owner', label: 'Notify the team of new bookings?', type: 'choice', options: [{ value: true, label: 'Yes' }, { value: false, label: 'No' }] }]}
        onSubmit={(f) => save({ ...f, amenities: f.amenities ? f.amenities.split(',').map((x) => x.trim()).filter(Boolean) : [] })} />
      <FormSheet visible={money} onClose={() => setMoney(false)} title="Money, tax & invoices" initial={{ currency: v.currency, payment_mode: v.payment_mode, tax_name: v.tax_name, tax_pct: v.tax_rate_bp / 100, tax_inclusive: v.tax_inclusive, legal_name: v.legal_name ?? '', tax_id: v.tax_id ?? '', billing_address: v.billing_address ?? '', invoice_prefix: v.invoice_prefix ?? '', loyalty_pct: (v.loyalty_earn_bp ?? 0) / 100, loyalty_expiry_months: v.loyalty_expiry_months ?? 12, loyalty_redeem_pct: (v.loyalty_max_redeem_bp ?? 5000) / 100 }}
        fields={[{ key: 'currency', label: 'Currency (locked once the venue has bookings)', type: 'choice', options: (currencies.data ?? [{ code: v.currency, symbol: '', name: '' }]).map((x) => ({ value: x.code, label: `${x.code} ${x.symbol}` })) },
          { key: 'payment_mode', label: 'How customers pay', type: 'choice', options: [{ value: 'pay_at_venue', label: 'At the venue' }, { value: 'online_optional', label: 'Online or at venue' }, { value: 'online_required', label: 'Online required' }] },
          { key: 'tax_name', label: 'Tax name', placeholder: 'GST, VAT, Sales tax' }, { key: 'tax_pct', label: 'Tax rate (%)', type: 'number', optional: true },
          { key: 'tax_inclusive', label: 'Are your listed prices tax-inclusive?', type: 'choice', options: [{ value: true, label: 'Yes, included' }, { value: false, label: 'No, add on top' }] },
          { key: 'legal_name', label: 'Legal name on invoices', optional: true }, { key: 'tax_id', label: 'Tax / GST / VAT number', optional: true }, { key: 'billing_address', label: 'Billing address on invoices', optional: true, type: 'multiline' },
          { key: 'invoice_prefix', label: 'Invoice prefix (2–8 capitals/digits)', optional: true },
          { key: 'loyalty_pct', label: 'Loyalty: % of what customers pay given back as points (0 = off, max 50)', type: 'number', optional: true },
          { key: 'loyalty_expiry_months', label: 'Points expire after (months)', type: 'number', optional: true },
          { key: 'loyalty_redeem_pct', label: 'Points can pay up to (% of one booking)', type: 'number', optional: true }]}
        onSubmit={async ({ tax_pct, loyalty_pct, loyalty_redeem_pct, ...f }) => save({ ...f, tax_rate_bp: Math.round((tax_pct ?? 0) * 100), loyalty_earn_bp: Math.round((loyalty_pct ?? 0) * 100), loyalty_max_redeem_bp: Math.round((loyalty_redeem_pct ?? 50) * 100) })} />
      <HoursEditor visible={hrs} onClose={() => setHrs(false)} v={v} onSaved={reload} />
      <FormSheet visible={ct} onClose={() => setCt(false)} title="Add a contact" fields={[{ key: 'role', label: 'Role', type: 'choice', options: ['manager', 'reception', 'emergency', 'billing', 'general'] }, { key: 'name', label: 'Name', optional: true }, { key: 'phone', label: 'Phone', optional: true }, { key: 'email', label: 'Email', optional: true }, { key: 'is_public', label: 'Show to customers?', type: 'choice', options: YN }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/contacts`, f); contacts.reload(); return 'Contact added'; }} />
      <FormSheet visible={st} onClose={() => setSt(false)} title="Add a team member" fields={[{ key: 'handle', label: 'Their handle', hint: 'They can then manage bookings, blocks, pricing and reports' }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/staff`, f); staff.reload(); return 'Added'; }} />
    </>
  );
}

/** One row per weekday: open / close times, or closed. */
function HoursEditor({ visible, onClose, v, onSaved }) {
  const { toast } = useSession();
  const init = () => WEEKDAYS.map((_, d) => { const h = v.hours.find((x) => x.weekday === d); return { open: h ? fmtMin(h.opens_min) : v.hours.length ? '' : '06:00', close: h ? fmtMin(h.closes_min) : v.hours.length ? '' : '22:00' }; });
  const [rows, setRows] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = (d, k, x) => setRows((r) => r.map((y, i) => (i === d ? { ...y, [k]: x } : y)));
  const save = async (around) => {
    setBusy(true);
    try {
      const hours = around ? [] : rows.flatMap((r, weekday) => (r.open && r.close ? [{ weekday, opens: r.open, closes: r.close }] : []));
      await api.post(`/venues/${v.id}/hours`, { hours }); onSaved(); onClose(); toast('Hours saved');
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Opening hours">
      <T size={13} color={c.mute}>Venue local time, HH:MM. Leave a day empty for closed.</T>
      {rows.map((r, d) => (
        <View key={d} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <T weight="700" style={{ width: 36, paddingBottom: 14 }}>{WEEKDAYS[d]}</T>
          <View style={{ flex: 1 }}><Field value={r.open} onChangeText={(x) => set(d, 'open', x)} placeholder="06:00" /></View>
          <View style={{ flex: 1 }}><Field value={r.close} onChangeText={(x) => set(d, 'close', x)} placeholder="22:00" /></View>
        </View>
      ))}
      <Btn title="Save hours" onPress={() => save(false)} loading={busy} />
      <Btn small title="Open 24 hours, every day" color={c.paper} onPress={() => save(true)} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ payments: invoices, receipts, refunds
const METHODS = ['cash', 'card', 'upi', 'bank', 'other'];
function LoyaltyPanel({ v }) {
  const [gift, setGift] = useState(false);
  const sum = useLoad(() => api.get(`/venues/${v.id}/loyalty`), [v.id, v.loyalty_earn_bp]);
  const d = sum.data;
  if (!d) return null;
  return (
    <Card color={c.sunSoft}>
      <T weight="700" size={16}>⭐ Loyalty points</T>
      {!d.programme.enabled ? <T size={13} color={c.mute}>Off. Turn it on under Setup → Money settings to give customers a percentage back as points.</T> : (
        <>
          <T size={13} color={c.mute}>{d.programme.earn_bp / 100}% back · expire after {d.programme.expiry_months} months · pay up to {d.programme.max_redeem_bp / 100}% of a booking</T>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <StatPill label="Issued" value={String(d.issued)} />
            <StatPill label="Redeemed" value={String(d.redeemed)} />
            <StatPill label="Expired" value={String(d.expired)} />
            <StatPill label="Outstanding" value={`${d.outstanding.members} people · ${moneyIn(d.outstanding.value_cents, d.currency)}`} />
          </View>
        </>
      )}
      <Btn small title="Give bonus points" color={c.violet} onPress={() => setGift(true)} style={{ marginTop: 10, alignSelf: 'flex-start' }} />
      <FormSheet visible={gift} onClose={() => setGift(false)} title="Give bonus points" submitLabel="Give points"
        fields={[{ key: 'user_handle', label: 'Their handle' }, { key: 'points', label: `Points (1 point = ${v.currency} 0.01)`, type: 'number' }, { key: 'note', label: 'Why (they will see this)', placeholder: 'Sorry about the rained-off game' }]}
        onSubmit={async (f) => { await api.post(`/venues/${v.id}/loyalty/bonus`, f); sum.reload(); return 'Points given'; }} />
    </Card>
  );
}

function Payments({ v }) {
  const { toast } = useSession();
  const { push } = useNav();
  const [status, setStatus] = useState('open');
  const [paying, setPaying] = useState(null);
  const list = useLoad(() => api.get('/invoices', { venue_id: v.id, status: status || undefined, limit: 60 }), [v.id, status]);
  const money = (n, cur = v.currency) => moneyIn(n, cur);
  return (
    <Section title="Invoices & payments" color={c.sun}>
      <T color={c.mute} size={13}>Every booking gets a numbered invoice in {v.currency}. Record payments taken at the venue; online payments and card refunds are handled automatically.</T>
      <LoyaltyPanel v={v} />
      <Seg options={[{ value: 'open', label: 'To collect' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }, { value: '', label: 'All' }]} value={status} onChange={setStatus} color={c.violet} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((i) => (
        <Card key={i.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} {i.number}</T>
              <T size={12} color={c.mute}>Booking {i.reservation_code} · {new Date(i.issued_at).toLocaleDateString()}{i.payment_method ? ` · ${i.payment_method}` : ''}{i.kind === 'credit_note' ? ` · refund ${i.refund_status}` : ''}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}><T weight="700">{i.kind === 'credit_note' ? '−' : ''}{money(i.total_cents, i.currency)}</T><Tag label={i.kind === 'credit_note' ? 'credit' : i.status} color={i.status === 'paid' ? c.mint : i.status === 'void' ? c.violetSoft : c.sun} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {i.kind === 'invoice' && i.status === 'open' ? <Btn small title="Record payment" color={c.violet} onPress={() => setPaying(i)} /> : null}
            {i.kind === 'credit_note' && ['manual', 'failed'].includes(i.refund_status) ? <Btn small title="Mark refund handed back" color={c.violet} onPress={async () => { try { await api.post(`/invoices/${i.id}/refunded`); toast('Marked as refunded'); list.reload(); } catch (e) { toast(e.message); } }} /> : null}
            <Btn small title="View" color={c.paper} onPress={() => push('Invoice', { id: i.id })} />
          </View>
        </Card>
      )) : <Empty emoji="🧾" title="Nothing here" sub={status === 'open' ? 'No unpaid invoices.' : undefined} />}
      <FormSheet visible={!!paying} onClose={() => setPaying(null)} title={`Record payment · ${paying?.number ?? ''}`} submitLabel="Mark as paid"
        fields={[{ key: 'method', label: `How was ${paying ? money(paying.total_cents, paying.currency) : ''} paid?`, type: 'choice', options: METHODS }]}
        onSubmit={async (f) => { await api.post(`/invoices/${paying.id}/paid`, f); list.reload(); return 'Payment recorded — the customer has a receipt'; }} />
    </Section>
  );
}

/** Everything the signed-in person runs, per venue and per currency (currencies are never added together). */
export function OwnerSummary() {
  const { push } = useNav();
  const [r, setR] = useState(1);
  const ranges = [['Last 7 days', -7, 0], ['Last 30 days', -30, 0], ['Last 90 days', -90, 0], ['Next 30 days', 0, 30]];
  const from = addDays(new Date().toISOString().slice(0, 10), ranges[r][1]), to = addDays(new Date().toISOString().slice(0, 10), ranges[r][2]);
  const s = useLoad(() => api.get('/me/venue-summary', { from, to }), [r]);
  return (
    <Screen wide>
      <H1 style={{ marginTop: 8 }}>All my venues</H1>
      <Seg options={ranges.map(([label], value) => ({ value, label }))} value={r} onChange={setR} color={c.cyan} />
      {s.loading && !s.data ? <Loading /> : s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : (
        <>
          <Section title="By currency" color={c.lime}>
            {s.data.by_currency.length ? s.data.by_currency.map((t) => (
              <Card key={t.currency}>
                <T weight="700" size={17}>{t.currency} · {t.venues} venue{t.venues === 1 ? '' : 's'}</T>
                {[['Bookings', t.bookings], ['Revenue', moneyIn(t.revenue_cents, t.currency)], ['Tax in revenue', moneyIn(t.tax_cents, t.currency)], ['Collected', moneyIn(t.collected_cents, t.currency)], ['To collect', moneyIn(t.outstanding_cents, t.currency)], ['Refunds owed', moneyIn(t.refunds_owed_cents, t.currency)]].map(([k, val]) => <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}><T color={c.mute}>{k}</T><T weight="700">{val}</T></View>)}
              </Card>
            )) : <Empty emoji="🏟️" title="No venues yet" />}
          </Section>
          <Section title="By venue" color={c.pink}>
            {s.data.venues.map((x) => <Row key={x.id} onPress={() => push('Manage', { id: x.id })} title={`${x.emoji} ${x.name}`} sub={`${x.currency} · ${x.bookings} bookings · to collect ${moneyIn(x.outstanding_cents, x.currency)}`} right={<T weight="700">{moneyIn(x.revenue_cents, x.currency)}</T>} />)}
          </Section>
        </>
      )}
    </Screen>
  );
}
