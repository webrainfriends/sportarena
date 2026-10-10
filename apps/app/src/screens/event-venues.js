// Venue & courts for an event: the venues it uses, the court bookings (made here, by the tournament scheduler or by a
// finalized venue request), and a guided flow to find a venue and book courts for the event's days.
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { DateRangeField, TimeField, todayLocal } from '../pickers';
import { c } from '../theme';
import { moneyIn } from '../vtime';

const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso, tz) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
const STATUS = { free: ['Free', c.limeSoft, c.ink], booked: ['Booked', c.orange, '#fff'], blocked: ['Blocked', c.sunSoft, c.ink], closed: ['Closed', c.violetSoft, c.mute], skipped: ['Skipped', c.violetSoft, c.mute] };

/** The venues of an event with their bookings. `onChange` lets the parent refresh its own numbers. */
export function EventVenues({ e, toast, onChange }) {
  const id = e.id;
  const list = useLoad(() => api.get(`/events/${id}/venues`), [id]);
  const [book, setBook] = useState(false);
  const refresh = () => { list.reload(); onChange?.(); };
  const release = async (b) => { try { await api.post(`/event-bookings/${b.id}/release`, {}); toast('Court released'); refresh(); } catch (x) { toast('' + x.message); } };
  return (
    <>
      <Btn title={list.data?.length ? 'Book more courts' : 'Find a venue & book courts'} onPress={() => setBook(true)} />
      {!list.data ? <Loading /> : !list.data.length ? (
        <Empty emoji="🏟️" title="No venue yet" sub="Pick a venue that has courts for your sport, see which days are free, and book them in one go." />
      ) : list.data.map((v) => {
        const live = v.bookings.filter((b) => b.status === 'confirmed');
        const days = [...new Set(live.map((b) => b.starts_at.slice(0, 10)))];
        return (
          <Card key={v.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T size={30}>{v.emoji ?? '🏟️'}</T>
              <View style={{ flex: 1 }}>
                <T weight="800" size={17}>{v.name}</T>
                <T color={c.mute} size={13}>{[v.city, v.address].filter(Boolean).join(' · ')}</T>
              </View>
              {v.chosen ? <Tag label="Event venue" color={c.limeSoft} /> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <Tag label={`${v.summary.courts} court${v.summary.courts === 1 ? '' : 's'}`} color={c.cyanSoft} />
              <Tag label={`${v.summary.slots} booking${v.summary.slots === 1 ? '' : 's'}`} color={c.violetSoft} />
              {v.summary.total_cents ? <Tag label={moneyIn(v.summary.total_cents, v.currency)} color={c.sunSoft} /> : null}
              {v.requests.map((r) => <Tag key={r.id} label={`request ${r.status}`} color={c.pinkSoft} />)}
            </View>
            {days.map((d) => (
              <View key={d} style={{ marginTop: 10, gap: 6 }}>
                <T weight="700" size={13} color={c.mute}>{fmtDay(d)}</T>
                {live.filter((b) => b.starts_at.slice(0, 10) === d).map((b) => (
                  <Row key={b.id} title={b.resource_name} sub={`${fmtTime(b.starts_at, v.timezone)} – ${fmtTime(b.ends_at, v.timezone)}${b.price_cents ? ` · ${moneyIn(b.price_cents, v.currency)}` : ''}${b.source === 'fixture' && b.note?.startsWith('Event') ? '' : ''}`}
                    right={new Date(b.starts_at) > new Date() ? <Btn small title="Release" color={c.paper} ink={c.ink} onPress={() => release(b)} /> : <Tag label="past" />} />
                ))}
              </View>
            ))}
          </Card>
        );
      })}
      {book ? <BookSheet e={e} toast={toast} onClose={() => setBook(false)} onBooked={() => { setBook(false); refresh(); }} /> : null}
    </>
  );
}

function BookSheet({ e, toast, onClose, onBooked }) {
  const id = e.id;
  const [q, setQ] = useState(''), [venue, setVenue] = useState(null);
  const found = useLoad(() => (venue ? Promise.resolve([]) : api.get(`/events/${id}/partners`, { kind: 'venue', q: q || undefined, limit: 30 })), [q, venue]);
  const [range, setRange] = useState({ from: undefined, to: undefined });
  const [start, setStart] = useState('09:00'), [end, setEnd] = useState('18:00');
  const [holidays, setHolidays] = useState(true);
  const [courts, setCourts] = useState(null);           // null = all
  const [plan, setPlan] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const body = useMemo(() => venue && range.from ? { venue_id: venue.id, from_date: range.from, to_date: range.to ?? range.from, start_time: start, end_time: end, respect_holidays: holidays, resource_ids: courts?.length ? courts : undefined } : null, [venue, range, start, end, holidays, courts]);
  useEffect(() => {
    if (!body) { setPlan(null); return; }
    let live = true; setBusy(true); setErr(null);
    api.post(`/events/${id}/venue-bookings/preview`, body).then((p) => { if (live) setPlan(p); }).catch((x) => { if (live) { setPlan(null); setErr(x.message); } }).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [body && JSON.stringify(body)]);
  const toggle = (cid) => setCourts((cur) => { const all = plan.courts.map((x) => x.id); const base = cur ?? all; const next = base.includes(cid) ? base.filter((x) => x !== cid) : [...base, cid]; return next.length === all.length ? null : next; });
  const free = plan?.rows.filter((r) => r.status === 'free') ?? [];
  const submit = async (skip) => {
    setBusy(true);
    try { const r = await api.post(`/events/${id}/venue-bookings`, { ...body, skip_unavailable: skip }); toast(`${r.booked} court booking${r.booked === 1 ? '' : 's'} made`); onBooked(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const dates = plan ? [...new Set(plan.rows.map((r) => r.date))] : [];
  return (
    <Sheet visible onClose={onClose} title={venue ? `Book courts at ${venue.name}` : 'Choose a venue'}>
      {!venue ? (
        <>
          <Field value={q} onChangeText={setQ} placeholder="Search venues by name or city…" />
          <T size={12} color={c.mute}>Venues with courts for this event’s sport come first; all-purpose courts count too.</T>
          {found.loading ? <Loading /> : (found.data ?? []).length ? found.data.map((x) => (
            <Row key={x.id} left={<T size={26}>{x.emoji ?? '🏟️'}</T>} title={x.name} onPress={() => setVenue(x)}
              sub={`${x.city ?? ''} · ${x.detail_count} court${x.detail_count === 1 ? '' : 's'}${x.sport_courts ? ` (${x.sport_courts} for this sport)` : ''}${x.from_rate_cents ? ` · from ${moneyIn(x.from_rate_cents)}/h` : ''}`}
              right={x.already_asked ? <Tag label="asked" /> : null} />
          )) : <Empty emoji="🔎" title="No venues found" sub="Only live venues with courts show up. Venues awaiting platform approval are hidden." />}
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Chip label={`${venue.emoji ?? '🏟️'} ${venue.name}  ✕`} active onPress={() => { setVenue(null); setPlan(null); setCourts(null); }} /></View>
          <DateRangeField label="Event days" from={range.from} to={range.to} min={todayLocal()} onChange={setRange} hint="Pick the first and last day you need the courts." />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><TimeField label="From" value={start} onChange={setStart} step={30} /></View>
            <View style={{ flex: 1 }}><TimeField label="Until" value={end} onChange={setEnd} step={30} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Chip label={holidays ? '✓ Skip public holidays' : 'Include public holidays'} active={holidays} onPress={() => setHolidays(!holidays)} />
          </View>
          {plan ? (
            <>
              <T weight="700" size={13} color={c.mute}>COURTS</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {plan.courts.map((x) => <Chip key={x.id} label={x.name} active={!courts || courts.includes(x.id)} onPress={() => toggle(x.id)} />)}
              </View>
            </>
          ) : null}
          {busy && !plan ? <Loading /> : null}
          {err ? <Card color={c.sunSoft}><T>{err}</T></Card> : null}
          {plan ? (
            <View style={{ gap: 8 }}>
              {dates.map((d) => (
                <View key={d} style={{ gap: 6 }}>
                  <T weight="700" size={13}>{fmtDay(`${d}T12:00:00Z`)}{plan.skipped_dates[d] ? <T color={c.mute} size={12}>{`  · ${plan.skipped_dates[d]}`}</T> : null}</T>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {plan.rows.filter((r) => r.date === d).map((r) => {
                      const [label, bg, ink] = STATUS[r.status];
                      return <View key={r.resource_id + d} style={{ backgroundColor: bg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 }}><T size={12} weight="700" color={ink}>{r.resource_name} · {label}{r.status === 'free' && r.price_cents ? ` · ${moneyIn(r.price_cents, plan.venue.currency)}` : r.reason && r.status !== 'free' ? ` (${r.reason})` : ''}</T></View>;
                    })}
                  </View>
                </View>
              ))}
              <Card color={c.limeSoft}><T weight="800">{plan.summary.free} court-day{plan.summary.free === 1 ? '' : 's'} free · {moneyIn(plan.summary.total_cents, plan.venue.currency)}</T>{plan.summary.unavailable ? <T size={12} color={c.mute}>{plan.summary.unavailable} not available (see above)</T> : null}</Card>
              <Btn title={`Book ${plan.summary.free} court-day${plan.summary.free === 1 ? '' : 's'}`} disabled={!plan.summary.free || plan.summary.unavailable > 0} loading={busy} onPress={() => submit(false)} />
              {plan.summary.unavailable > 0 && plan.summary.free > 0 ? <Btn title={`Book only the ${plan.summary.free} free ones`} color={c.violet} loading={busy} onPress={() => submit(true)} /> : null}
              <T size={12} color={c.mute}>Booking adds a planned “venue” line to the event budget. You can release a booking later; the venue’s cancellation policy decides any refund.</T>
            </View>
          ) : !range.from ? <T color={c.mute}>Pick the event days to see which courts are free.</T> : null}
        </>
      )}
    </Sheet>
  );
}
