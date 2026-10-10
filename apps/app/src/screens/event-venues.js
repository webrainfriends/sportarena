// Venue & courts for an event: the venues it uses, the court bookings (made here, by the tournament scheduler or by a
// finalized venue request), and a guided flow: pick a venue (photo cards), pick days / times / courts with live
// availability, review, confirm.
import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { DateRangeField, TimeField, todayLocal } from '../pickers';
import { c } from '../theme';
import { locale } from '../locale';
import { moneyIn } from '../vtime';

const fmtDay = (iso) => new Date(iso).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso, tz) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz });
const clockLabel = (t) => { if (t === '24:00') return 'End of day'; const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }); };
const STATUS = { free: ['Free', c.limeSoft, c.ink], booked: ['Booked', c.orange, '#fff'], blocked: ['Blocked', c.sunSoft, c.ink], closed: ['Closed', c.violetSoft, c.mute], skipped: ['Skipped', c.violetSoft, c.mute] };

/** Cover photo (or a gradient with the emoji) with an optional price badge, like a listing card. */
function Photo({ v, height = 130, badge, children }) {
  return (
    <View style={{ height, borderRadius: 18, overflow: 'hidden', backgroundColor: c.violetSoft }}>
      {v.cover_url ? <Image source={{ uri: mediaUrl(v.cover_url) }} resizeMode="cover" style={{ position: 'absolute', width: '100%', height: '100%' }} />
        : <LinearGradient colors={['#059669', '#0EA5E9']} style={{ position: 'absolute', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}><T size={48}>{v.emoji ?? '🏟️'}</T></LinearGradient>}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.55)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.6 }} />
      {badge ? <View style={{ position: 'absolute', right: 10, bottom: 10, backgroundColor: c.pink, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}><T color="#fff" weight="800" size={13}>{badge}</T></View> : null}
      {children}
    </View>
  );
}

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
          <Card key={v.id} pad={12}>
            <Photo v={v} badge={v.summary.total_cents ? moneyIn(v.summary.total_cents, v.currency) : undefined}>
              <View style={{ position: 'absolute', left: 12, bottom: 10, right: 90 }}>
                <T color="#fff" weight="800" size={18} numberOfLines={1}>{v.name}</T>
                <T color="rgba(255,255,255,0.85)" size={12} numberOfLines={1}>{[v.city, v.address].filter(Boolean).join(' · ')}</T>
              </View>
              {v.chosen ? <View style={{ position: 'absolute', left: 10, top: 10, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800" color="#0F172A">EVENT VENUE</T></View> : null}
            </Photo>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <Tag label={`${v.summary.courts} court${v.summary.courts === 1 ? '' : 's'}`} color={c.cyanSoft} />
              <Tag label={`${v.summary.slots} booking${v.summary.slots === 1 ? '' : 's'}`} color={c.violetSoft} />
              {v.requests.map((r) => <Tag key={r.id} label={`request ${r.status}`} color={c.pinkSoft} />)}
            </View>
            {days.map((d) => (
              <View key={d} style={{ marginTop: 10, gap: 6 }}>
                <T weight="700" size={13} color={c.mute}>{fmtDay(d)}</T>
                {live.filter((b) => b.starts_at.slice(0, 10) === d).map((b) => (
                  <Row key={b.id} title={b.resource_name} sub={`${fmtTime(b.starts_at, v.timezone)} – ${fmtTime(b.ends_at, v.timezone)}${b.price_cents ? ` · ${moneyIn(b.price_cents, v.currency)}` : ''}`}
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
  const [q, setQ] = useState(''), [venue, setVenue] = useState(null), [step, setStep] = useState('setup');
  const found = useLoad(() => (venue ? Promise.resolve([]) : api.get(`/events/${id}/partners`, { kind: 'venue', q: q || undefined, limit: 30 })), [q, venue]);
  const [range, setRange] = useState({ from: undefined, to: undefined });
  const [start, setStart] = useState('09:00'), [end, setEnd] = useState('18:00');
  const [holidays, setHolidays] = useState(true);
  const [courts, setCourts] = useState(null);           // null = all
  const [plan, setPlan] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const body = useMemo(() => venue && range.from ? { venue_id: venue.id, from_date: range.from, to_date: range.to ?? range.from, start_time: start, end_time: end, respect_holidays: holidays, resource_ids: courts?.length ? courts : undefined } : null, [venue, range, start, end, holidays, courts]);
  useEffect(() => {
    if (!body) { setPlan(null); return undefined; }
    let live = true; setBusy(true); setErr(null);
    api.post(`/events/${id}/venue-bookings/preview`, body).then((p) => { if (live) setPlan(p); }).catch((x) => { if (live) { setPlan(null); setErr(x.message); } }).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [body && JSON.stringify(body)]);
  const toggle = (cid) => setCourts((cur) => { const all = plan.courts.map((x) => x.id); const base = cur ?? all; const next = base.includes(cid) ? base.filter((x) => x !== cid) : [...base, cid]; return next.length === all.length ? null : next; });
  const submit = async (skip) => {
    setBusy(true);
    try { const r = await api.post(`/events/${id}/venue-bookings`, { ...body, skip_unavailable: skip }); toast(`${r.booked} court booking${r.booked === 1 ? '' : 's'} made`); onBooked(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const dates = plan ? [...new Set(plan.rows.map((r) => r.date))] : [];
  const free = plan?.rows.filter((r) => r.status === 'free') ?? [];
  const bookedCourts = [...new Set(free.map((r) => r.resource_name))];
  const sub = plan?.summary.total_cents ?? 0, cur = plan?.venue.currency;
  const title = !venue ? 'Choose a venue' : step === 'confirm' ? 'Review & confirm' : venue.name;
  return (
    <Sheet visible onClose={onClose} title={title}>
      {!venue ? (
        <>
          <Field value={q} onChangeText={setQ} placeholder="Search venues by name or city…" />
          <T size={12} color={c.mute}>Venues with courts for this event’s sport come first; all-purpose courts count too.</T>
          {found.loading ? <Loading /> : (found.data ?? []).length ? found.data.map((x) => (
            <Pressable key={x.id} onPress={() => setVenue(x)} style={{ gap: 8 }}>
              <Photo v={x} height={120} badge={x.from_rate_cents ? `from ${moneyIn(x.from_rate_cents)}/h` : undefined} />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}><T weight="800" size={16}>{x.name}</T><T size={12} color={c.mute}>{[x.city, `${x.detail_count} court${x.detail_count === 1 ? '' : 's'}`, x.sport_courts ? `${x.sport_courts} for this sport` : null].filter(Boolean).join(' · ')}</T></View>
                {x.already_asked ? <Tag label="asked" /> : <T color={c.pink} weight="800" size={13}>Choose ›</T>}
              </View>
            </Pressable>
          )) : <Empty emoji="🔎" title="No venues found" sub="Only live venues with courts show up. Venues awaiting platform approval are hidden." />}
        </>
      ) : step === 'confirm' && plan ? (
        <>
          <Photo v={venue} height={110}><View style={{ position: 'absolute', left: 12, bottom: 10 }}><T color="#fff" weight="800" size={17}>{venue.name}</T><T color="rgba(255,255,255,0.85)" size={12}>{venue.city}</T></View></Photo>
          <T weight="800" size={16}>Your booking</T>
          {[['Dates', `${fmtDay(`${plan.window.from}T12:00:00`)}${plan.window.to !== plan.window.from ? ` → ${fmtDay(`${plan.window.to}T12:00:00`)}` : ''}`], ['Time', `${clockLabel(plan.window.start_time)} – ${clockLabel(plan.window.end_time)}`], ['Courts', bookedCourts.join(', ')]].map(([k, val]) => (
            <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
              <View style={{ flex: 1 }}><T size={12} color={c.mute} weight="700">{k.toUpperCase()}</T><T weight="700">{val}</T></View>
              <Pressable onPress={() => setStep('setup')} hitSlop={10}><T color={c.pink} weight="800" size={13}>Edit</T></Pressable>
            </View>
          ))}
          <T weight="800" size={16}>Price details</T>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T color={c.mute}>{free.length} court-day{free.length === 1 ? '' : 's'}</T><T weight="700">{moneyIn(sub, cur)}</T></View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderColor: c.line }}><T weight="800">Total</T><T weight="800" size={18}>{moneyIn(sub, cur)}</T></View>
          </View>
          {plan.summary.unavailable ? <T size={12} color={c.mute}>{plan.summary.unavailable} slot(s) were not available and will be left out.</T> : null}
          {err ? <Card color={c.sunSoft}><T>{err}</T></Card> : null}
          <T size={12} color={c.mute}>Adds a planned “venue” line to the event budget. You can release a booking later; the venue’s cancellation policy decides any refund.</T>
          <Btn title="Confirm & book" loading={busy} onPress={() => submit(plan.summary.unavailable > 0)} />
        </>
      ) : (
        <>
          <Pressable onPress={() => { setVenue(null); setPlan(null); setCourts(null); }}>
            <Photo v={venue} height={96}><View style={{ position: 'absolute', left: 12, bottom: 10 }}><T color="#fff" weight="800" size={16}>{venue.name}</T><T color="rgba(255,255,255,0.85)" size={12}>Tap to change venue</T></View></Photo>
          </Pressable>
          <DateRangeField label="Event days" from={range.from} to={range.to} min={todayLocal()} onChange={setRange} hint="Pick the first and last day you need the courts." />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><TimeField label="From" value={start} onChange={setStart} step={30} /></View>
            <View style={{ flex: 1 }}><TimeField label="Until" value={end} onChange={setEnd} step={30} /></View>
          </View>
          <Chip label={holidays ? '✓ Skip public holidays' : 'Include public holidays'} active={holidays} onPress={() => setHolidays(!holidays)} />
          {plan ? (
            <>
              <T weight="700" size={13} color={c.mute}>COURTS</T>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{plan.courts.map((x) => <Chip key={x.id} label={x.name} active={!courts || courts.includes(x.id)} onPress={() => toggle(x.id)} />)}</View>
            </>
          ) : null}
          {busy && !plan ? <Loading /> : null}
          {err ? <Card color={c.sunSoft}><T>{err}</T></Card> : null}
          {plan ? (
            <View style={{ gap: 10 }}>
              {dates.map((d) => (
                <View key={d} style={{ gap: 6 }}>
                  <T weight="700" size={13}>{fmtDay(`${d}T12:00:00`)}{plan.skipped_dates[d] ? <T color={c.mute} size={12}>{`  · ${plan.skipped_dates[d]}`}</T> : null}</T>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    {plan.rows.filter((r) => r.date === d).map((r) => {
                      const [label, bg, ink] = STATUS[r.status];
                      return <View key={r.resource_id + d} style={{ backgroundColor: bg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 }}><T size={12} weight="700" color={ink}>{r.resource_name} · {label}{r.status === 'free' && r.price_cents ? ` · ${moneyIn(r.price_cents, plan.venue.currency)}` : r.reason && r.status !== 'free' ? ` (${r.reason})` : ''}</T></View>;
                    })}
                  </View>
                </View>
              ))}
              <Card color={c.limeSoft}><T weight="800">{plan.summary.free} court-day{plan.summary.free === 1 ? '' : 's'} free · {moneyIn(plan.summary.total_cents, plan.venue.currency)}</T>{plan.summary.unavailable ? <T size={12} color={c.mute}>{plan.summary.unavailable} not available (see above)</T> : null}</Card>
              <Btn title="Review booking" disabled={!plan.summary.free} onPress={() => setStep('confirm')} />
            </View>
          ) : !range.from ? <T color={c.mute}>Pick the event days to see which courts are free.</T> : null}
        </>
      )}
    </Sheet>
  );
}
