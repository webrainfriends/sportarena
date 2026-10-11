// Venue & courts tab of the event console: the venues it uses, the court bookings (made here, by the tournament scheduler or by a
// finalized venue request), and a guided flow: pick a venue (photo cards), pick days / times / courts with live
// availability, review, confirm.
import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { A, ABtn, ACard, AEmpty, AT, ATag } from '../arena';
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
    <View style={{ height, borderRadius: 18, overflow: 'hidden', backgroundColor: A.panel2 }}>
      {v.cover_url ? <Image source={{ uri: mediaUrl(v.cover_url) }} resizeMode="cover" style={{ position: 'absolute', width: '100%', height: '100%' }} />
        : <LinearGradient colors={['#7C3AED', '#EC4899']} style={{ position: 'absolute', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}><T size={48}>{v.emoji ?? '🏟️'}</T></LinearGradient>}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.55)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.6 }} />
      {badge ? <View style={{ position: 'absolute', right: 10, bottom: 10, backgroundColor: A.magenta, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}><T color="#fff" weight="800" size={13}>{badge}</T></View> : null}
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
      <ABtn title={list.data?.length ? 'Book more courts' : 'Find a venue & book courts'} onPress={() => setBook(true)} />
      {list.data?.length ? <FitCard id={id} version={list.data} toast={toast} onChange={refresh} /> : null}
      {!list.data ? <Loading /> : !list.data.length ? (
        <AEmpty emoji="🏟️" title="No venue yet" sub="Pick a venue that has courts for your sport, see which days are free, and book them in one go." />
      ) : list.data.map((v) => {
        const live = v.bookings.filter((b) => b.status === 'confirmed');
        const days = [...new Set(live.map((b) => b.starts_at.slice(0, 10)))];
        return (
          <ACard key={v.id} pad={12} style={{ gap: 10 }}>
            <Photo v={v} badge={v.summary.total_cents ? moneyIn(v.summary.total_cents, v.currency) : undefined}>
              <View style={{ position: 'absolute', left: 12, bottom: 10, right: 90 }}>
                <T color="#fff" weight="800" size={18} numberOfLines={1}>{v.name}</T>
                <T color="rgba(255,255,255,0.85)" size={12} numberOfLines={1}>{[v.city, v.address].filter(Boolean).join(' · ')}</T>
              </View>
              {v.chosen ? <View style={{ position: 'absolute', left: 10, top: 10, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T size={11} weight="800" color="#0F172A">EVENT VENUE</T></View> : null}
            </Photo>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <ATag tone={A.cyan} label={`${v.summary.courts} court${v.summary.courts === 1 ? '' : 's'}`} />
              <ATag tone={A.violet} label={`${v.summary.slots} booking${v.summary.slots === 1 ? '' : 's'}`} />
              {v.requests.map((r) => <ATag key={r.id} tone={A.magenta} label={`request ${r.status}`} />)}
            </View>
            {days.map((d) => (
              <View key={d} style={{ gap: 6 }}>
                <AT weight="800" size={13} color={A.mute}>{fmtDay(d)}</AT>
                {live.filter((b) => b.starts_at.slice(0, 10) === d).map((b) => (
                  <View key={b.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: A.panel2, borderRadius: 14, padding: 10 }}>
                    <View style={{ flex: 1 }}>
                      <AT size={14} weight="800">{b.resource_name}</AT>
                      <AT size={12} weight="600" color={A.mute}>{fmtTime(b.starts_at, v.timezone)} – {fmtTime(b.ends_at, v.timezone)}{b.price_cents ? ` · ${moneyIn(b.price_cents, v.currency)}` : ''}</AT>
                    </View>
                    {new Date(b.starts_at) > new Date() ? <ABtn small tone="ghost" title="Release" onPress={() => release(b)} /> : <ATag tone={A.mute} label="past" />}
                  </View>
                ))}
              </View>
            ))}
          </ACard>
        );
      })}
      {book ? <BookSheet e={e} toast={toast} onClose={() => setBook(false)} onBooked={() => { setBook(false); refresh(); }} /> : null}
    </>
  );
}

const SEV = { high: [A.red, '⚠️'], medium: [A.sun, '⚡'], info: [A.cyan, 'ℹ️'] };

/** Does the booked court time match what the event plays? Wasted time before the first game / after the last one is highlighted with the saving. */
function FitCard({ id, version, toast, onChange }) {
  const fit = useLoad(() => api.get(`/events/${id}/fit`), [id, version]);
  const [busy, setBusy] = useState(false);
  const f = fit.data;
  if (!f) return fit.loading ? <Loading /> : null;
  const money = (cents, cur) => moneyIn(cents, cur);
  const cur = f.venues[0]?.currency;
  const releaseAll = async (ids) => {
    setBusy(true);
    try { for (const bid of ids) await api.post(`/event-bookings/${bid}/release`, { reason: 'Idle slot released after the efficiency check' }); toast(`${ids.length} idle slot${ids.length === 1 ? '' : 's'} released`); onChange?.(); } catch (x) { toast('' + x.message); } finally { setBusy(false); }
  };
  return (
    <ACard tone={f.rating === 'efficient' ? A.green : f.rating === 'wasteful' ? A.red : A.sun} style={{ gap: 8 }}>
      <AT size={16} weight="900">{f.rating === 'efficient' ? '✅' : f.rating === 'wasteful' ? '⚠️' : '⚡'} Schedule & budget fit</AT>
      <AT size={14} weight="600">{f.headline}</AT>
      {f.totals.booked_cents ? <AT size={12} weight="600" color={A.mute}>{money(f.totals.booked_cents, cur)} booked · {f.totals.utilisation_pct}% in use{f.totals.wasted_cents ? ` · ${money(f.totals.wasted_cents, cur)} wasted` : ''}</AT> : null}
      <View style={{ gap: 8 }}>
        {f.findings.map((x, k) => <View key={k} style={{ backgroundColor: `${SEV[x.severity][0]}22`, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: `${SEV[x.severity][0]}66` }}><AT size={13} weight="600">{SEV[x.severity][1]} {x.message}</AT></View>)}
        {f.venues.filter((v) => v.compare.length > 1).map((v) => {
          const keep = v.compare[0], rel = v.compare[1];
          return (
            <View key={v.venue_id} style={{ gap: 6 }}>
              <AT weight="800" size={13}>{v.venue_name}: compare</AT>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, backgroundColor: A.panel2, borderRadius: 12, padding: 10 }}><AT size={12} color={A.mute} weight="700">{keep.label}</AT><AT weight="800">{money(keep.cost_cents, v.currency)}</AT><AT size={12} color={A.red}>{money(keep.wasted_cents, v.currency)} wasted</AT></View>
                <View style={{ flex: 1, backgroundColor: A.panel2, borderRadius: 12, padding: 10, borderWidth: 2, borderColor: A.green }}><AT size={12} color={A.mute} weight="700">{rel.label} · recommended</AT><AT weight="800">{money(rel.cost_cents, v.currency)}</AT><AT size={12} color={A.green}>saves up to {money(rel.saves_cents, v.currency)}</AT></View>
              </View>
              <ABtn small title={`Release ${rel.release_booking_ids.length} idle slot${rel.release_booking_ids.length === 1 ? '' : 's'}`} loading={busy} onPress={() => releaseAll(rel.release_booking_ids)} style={{ alignSelf: 'flex-start' }} />
            </View>
          );
        })}
      </View>
    </ACard>
  );
}

function BookSheet({ e, toast, onClose, onBooked }) {
  const id = e.id;
  const [q, setQ] = useState(''), [venue, setVenue] = useState(null), [step, setStep] = useState('setup');
  const found = useLoad(() => (venue ? Promise.resolve([]) : api.get(`/events/${id}/partners`, { kind: 'venue', q: q || undefined, limit: 30 })), [q, venue]);
  const [range, setRange] = useState(() => { const s = e.starts_on?.slice(0, 10), z = e.ends_on?.slice(0, 10); return s && z && z >= todayLocal() ? { from: s < todayLocal() ? todayLocal() : s, to: z } : { from: undefined, to: undefined }; });
  const [consent, setConsent] = useState(false);
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
    try { const r = await api.post(`/events/${id}/venue-bookings`, { ...body, skip_unavailable: skip, accept_mismatch: consent }); toast(`${r.booked} court booking${r.booked === 1 ? '' : 's'} made`); onBooked(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const dates = plan ? [...new Set(plan.rows.map((r) => r.date))] : [];
  const free = plan?.rows.filter((r) => r.status === 'free') ?? [];
  const bookedCourts = [...new Set(free.map((r) => r.resource_name))];
  const sub = plan?.summary.total_cents ?? 0, cur = plan?.venue.currency;
  const al = plan?.alignment, mismatch = !!al?.consent_required;
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
          {mismatch ? (
            <>
              <MismatchNote al={al} cur={cur} onTrim={() => { setRange({ from: al.suggested_window.from_date, to: al.suggested_window.to_date }); setConsent(false); setStep('setup'); }} />
              <Chip label={consent ? '✓ I understand — book these days anyway' : 'I understand — book these days anyway'} active={consent} onPress={() => setConsent(!consent)} />
            </>
          ) : null}
          <Btn title={mismatch ? 'Confirm anyway & book' : 'Confirm & book'} loading={busy} disabled={mismatch && !consent} onPress={() => submit(plan.summary.unavailable > 0)} />
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
              {mismatch ? <MismatchNote al={al} cur={cur} onTrim={() => { setRange({ from: al.suggested_window.from_date, to: al.suggested_window.to_date }); setConsent(false); }} /> : null}
              <Btn title="Review booking" disabled={!plan.summary.free} onPress={() => { setConsent(false); setStep('confirm'); }} />
            </View>
          ) : !range.from ? <T color={c.mute}>Pick the event days to see which courts are free.</T> : null}
        </>
      )}
    </Sheet>
  );
}

/** The requested days do not line up with the event's dates: say what is wasted and offer the matching alternative. */
function MismatchNote({ al, cur, onTrim }) {
  return (
    <Card color={c.redSoft} pad={12}>
      <T weight="800">⚠️ These days don’t match your event ({al.event.starts_on} → {al.event.ends_on})</T>
      {al.issues.map((x) => <T key={x.code} size={13} style={{ marginTop: 4 }}>{x.message}</T>)}
      <T size={13} weight="700" style={{ marginTop: 6 }}>{al.verdict}</T>
      {al.suggested_window ? <Btn small title={`Use ${al.suggested_window.from_date} → ${al.suggested_window.to_date} instead`} onPress={onTrim} style={{ alignSelf: 'flex-start', marginTop: 8 }} /> : null}
    </Card>
  );
}
