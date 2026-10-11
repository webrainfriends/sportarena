// Courts for coaching. Either the coach or the athlete can book a venue and attach the coaching / training session(s) to it —
// one session, a recurring series, a bulk selection or a custom list of dates.
//   TrainingVenue   wizard: choose sessions -> choose venue and court -> review, price and book (sessions are linked)
//   RecurringVenue  wizard: choose court -> repeat pattern -> review (optionally picks up your coaching sessions)
//   SeriesBookingSheet  book a coach for a series of dates, then offer a court for all of them
//   AttachSessionsSheet attach sessions to a reservation you already have
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Field, GradCard, Loading, Screen, Seg, Sheet, T } from '../ui';
import { Counter, DateField, HScroll, Stepper, TimeField } from '../pickers';
import { Pill } from './marketplace';
import { c, grad } from '../theme';
import { addDays, dateTimeIn, moneyIn, todayIn, WEEKDAYS } from '../vtime';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const plainDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const useDebounced = (value, ms = 350) => { const [v, setV] = useState(value); useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]); return v; };
const AUD = { individual: 'One-to-one', group: 'Group', team: 'Team', event: 'Event' };

// ================================================================================== REPEAT PATTERN
/** The same rules as the server's expandDates, so the preview matches what is booked. */
export function expand(p) {
  const out = new Set(p.extra_dates ?? []);
  if (p.mode === 'weekly' && p.weekdays?.length) {
    const limit = p.endMode === 'until' && p.ends_on ? p.ends_on : addDays(p.starts_on, 730);
    const startDow = new Date(`${p.starts_on}T00:00:00Z`).getUTCDay();
    let n = 0;
    for (let d = p.starts_on, i = 0; d <= limit && i < 800; d = addDays(d, 1), i++) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (!p.weekdays.includes(dow) || Math.floor((i + startDow) / 7) % p.every_n_weeks !== 0) continue;
      out.add(d);
      if (p.endMode === 'count' && ++n >= p.count) break;
    }
  } else if (p.mode === 'once') out.add(p.starts_on);
  for (const x of p.exclude_dates ?? []) out.delete(x);
  return [...out].sort();
}
export const newPattern = (start) => ({ mode: 'weekly', starts_on: start, weekdays: [], every_n_weeks: 1, endMode: 'count', count: 8, ends_on: undefined, extra_dates: [], exclude_dates: [] });
/** API fields for a pattern (the server applies the exclusions itself). */
export const patternBody = (p) => ({
  starts_on: p.starts_on, exclude_dates: p.exclude_dates, extra_dates: p.mode === 'custom' ? p.extra_dates : p.mode === 'once' ? [p.starts_on] : [],
  weekdays: p.mode === 'weekly' ? p.weekdays : [], every_n_weeks: p.every_n_weeks,
  ...(p.mode === 'weekly' ? (p.endMode === 'until' && p.ends_on ? { ends_on: p.ends_on } : { count: p.count }) : {}),
});

/** Once / weekly / custom dates, with every resulting date shown as a chip you can switch off. `checked` maps date -> problem text. */
export function RepeatPicker({ value: p, onChange, min, checked }) {
  const set = (patch) => onChange({ ...p, ...patch });
  const dates = useMemo(() => { try { return expand({ ...p, exclude_dates: [] }); } catch { return []; } }, [p.mode, p.starts_on, p.weekdays, p.every_n_weeks, p.endMode, p.count, p.ends_on, p.extra_dates]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (d) => set({ exclude_dates: p.exclude_dates.includes(d) ? p.exclude_dates.filter((x) => x !== d) : [...p.exclude_dates, d] });
  return (
    <View style={{ gap: 12 }}>
      <Seg options={[{ value: 'once', label: 'One date' }, { value: 'weekly', label: 'Repeats weekly' }, { value: 'custom', label: 'Pick dates' }]} value={p.mode} onChange={(mode) => set({ mode })} color={c.pink} />
      {p.mode !== 'custom' ? <DateField label={p.mode === 'once' ? 'Date' : 'First date'} value={p.starts_on} onChange={(x) => set({ starts_on: x })} min={min} /> : null}
      {p.mode === 'weekly' ? (
        <>
          <View style={{ gap: 6 }}>
            <T weight="800" size={13}>Repeats on</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Chip label="Weekdays" onPress={() => set({ weekdays: [1, 2, 3, 4, 5] })} /><Chip label="Weekend" onPress={() => set({ weekdays: [6, 0] })} />
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => <Chip key={d} label={WEEKDAYS[d]} active={p.weekdays.includes(d)} onPress={() => set({ weekdays: p.weekdays.includes(d) ? p.weekdays.filter((x) => x !== d) : [...p.weekdays, d] })} />)}
            </View>
          </View>
          <Counter label="Every" value={p.every_n_weeks} onChange={(x) => set({ every_n_weeks: x })} min={1} max={8} suffix={p.every_n_weeks === 1 ? ' week' : ' weeks'} />
          <Seg options={[{ value: 'count', label: 'For a number of sessions' }, { value: 'until', label: 'Until a date' }]} value={p.endMode} onChange={(endMode) => set({ endMode })} color={c.violet} />
          {p.endMode === 'count' ? <Counter label="Sessions" value={p.count} onChange={(x) => set({ count: x })} min={1} max={60} /> : <DateField label="Until" value={p.ends_on} onChange={(x) => set({ ends_on: x })} min={p.starts_on} />}
        </>
      ) : null}
      {p.mode === 'custom' ? (
        <View style={{ gap: 8 }}>
          <DateField label="Add a date" value={undefined} onChange={(x) => x && !p.extra_dates.includes(x) && set({ extra_dates: [...p.extra_dates, x].sort() })} min={min} hint="Add as many as you need; tap a date below to remove it." />
        </View>
      ) : null}
      {dates.length ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>{dates.length} date{dates.length === 1 ? '' : 's'}{p.exclude_dates.length ? ` · ${p.exclude_dates.length} switched off` : ''}</T>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {dates.map((d) => {
              const off = p.exclude_dates.includes(d), bad = checked?.[d];
              return <Chip key={d} label={`${off ? '✕ ' : bad ? '⚠ ' : ''}${plainDay(d)}`} active={!off && !bad} onPress={() => (p.mode === 'custom' && !off ? set({ extra_dates: p.extra_dates.filter((x) => x !== d) }) : toggle(d))} />;
            })}
          </View>
          <T size={12} color={c.mute}>{p.mode === 'custom' ? 'Tap a date to remove it.' : 'Tap a date to switch it off for this booking.'}{checked && Object.values(checked).some(Boolean) ? ' ⚠ marks dates that cannot be booked.' : ''}</T>
        </View>
      ) : <T size={13} color={c.mute}>{p.mode === 'weekly' ? 'Choose the days it repeats on.' : p.mode === 'custom' ? 'No dates yet.' : ''}</T>}
    </View>
  );
}

// ================================================================================== COURT PICKER
/** Venue search (optionally only venues free at a time) and the courts of the chosen venue. */
function CourtPicker({ sport, window, venueId, resourceId, onVenue, onResource }) {
  const [q, setQ] = useState(''), [free, setFree] = useState(!!window);
  const dq = useDebounced(q);
  const list = useLoad(() => api.get('/venues', { q: dq || undefined, sport: sport || undefined, limit: 20, ...(free && window ? { available_from: window.from, available_to: window.to } : {}) }), [dq, sport, free, window?.from]);
  const venue = useLoad(() => (venueId ? api.get(`/venues/${venueId}`) : Promise.resolve(null)), [venueId]);
  const courts = (venue.data?.resources ?? []).filter((r) => r.kind !== 'equipment' && (!sport || !r.sport_slug || r.sport_slug === sport));
  return (
    <View style={{ gap: 10 }}>
      {venueId && venue.data ? (
        <Card pad={12} color={c.pinkSoft}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={26}>{venue.data.emoji ?? '🏟️'}</T>
            <View style={{ flex: 1 }}><T weight="800">{venue.data.name}</T><T size={12} color={c.mute}>{[venue.data.city, venue.data.address].filter(Boolean).join(' · ')}</T></View>
            <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => { onVenue(null); onResource(null); }} />
          </View>
        </Card>
      ) : (
        <>
          <Field value={q} onChangeText={setQ} placeholder="Search venues by name…" />
          {window ? <HScroll><Chip label="✓ Free at the first session" active={free} onPress={() => setFree(!free)} /></HScroll> : null}
          {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty emoji="🏟️" title="No venue matches" sub={free ? 'Try switching off “Free at the first session”.' : 'Try a different name.'} /> : list.data.map((v) => (
            <Card key={v.id} pad={12} onPress={() => { onVenue(v.id); onResource(null); }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T size={26}>{v.emoji ?? '🏟️'}</T>
                <View style={{ flex: 1 }}>
                  <T weight="800">{v.name}</T>
                  <T size={12} color={c.mute}>{[v.city, v.rating ? `★ ${Number(v.rating).toFixed(1)} (${v.reviews})` : null, v.distance_km != null ? `${v.distance_km} km` : null].filter(Boolean).join(' · ')}</T>
                </View>
                {v.min_hourly_rate_cents != null ? <T weight="800" size={13}>from {moneyIn(v.min_hourly_rate_cents, v.currency)}/hr</T> : null}
              </View>
            </Card>
          ))}
        </>
      )}
      {venueId ? (
        <View style={{ gap: 6 }}>
          <T weight="800" size={13}>Which court</T>
          {venue.loading && !venue.data ? <Loading /> : !courts.length ? <T size={13} color={c.mute}>This venue has no court for that sport.</T> : (
            <View style={{ gap: 8 }}>
              {courts.map((r) => (
                <Card key={r.id} pad={12} color={resourceId === r.id ? c.pinkSoft : c.paper} onPress={() => onResource(r.id)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1 }}><T weight="700">{r.name}</T><T size={12} color={c.mute}>{[r.sport, r.kind, r.max_players ? `up to ${r.max_players} players` : null].filter(Boolean).join(' · ')}</T></View>
                    {r.hourly_rate_cents != null ? <T weight="800">{moneyIn(r.hourly_rate_cents, venue.data.currency)}/hr</T> : null}
                    {resourceId === r.id ? <T color={c.pink} weight="800">✓</T> : null}
                  </View>
                </Card>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const Problem = ({ text }) => <T size={12} color={c.red} weight="700">⚠ {text}</T>;

// ================================================================================== TRAINING VENUE WIZARD
const STEPS = ['Sessions', 'Court', 'Review'];

export function TrainingVenue({ ids }) {
  const { push, back } = useNav();
  const { toast } = useSession();
  const board = useLoad(() => api.get('/training/venues/board'), []);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState(() => new Set(ids ?? []));
  const [venueId, setVenueId] = useState(null), [resourceId, setResourceId] = useState(null), [override, setOverride] = useState({});
  const [before, setBefore] = useState(0), [after, setAfter] = useState(0), [skip, setSkip] = useState(true), [note, setNote] = useState('');
  const [quote, setQuote] = useState(null), [qErr, setQErr] = useState(null), [busy, setBusy] = useState(false), [done, setDone] = useState(null);
  const need = board.data?.needs_venue ?? [];
  const chosen = need.filter((s) => picked.has(s.id));
  const sports = [...new Set(chosen.map((s) => s.sport_slug).filter(Boolean))];
  const first = chosen[0];
  const venue = useLoad(() => (venueId ? api.get(`/venues/${venueId}`) : Promise.resolve(null)), [venueId]);
  const courts = (venue.data?.resources ?? []).filter((r) => r.kind !== 'equipment');
  const toggle = (s) => setPicked((p) => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; });
  const body = (extra = {}) => ({ sessions: chosen.map((s) => ({ type: s.type, id: s.id, ...(override[s.id] ? { resource_id: override[s.id] } : {}) })), resource_id: resourceId, buffer_before_min: before, buffer_after_min: after, on_conflict: skip ? 'skip' : 'fail', ...(note.trim() ? { note: note.trim() } : {}), ...extra });
  const runQuote = async () => { setQErr(null); try { setQuote(await api.post('/training/venues/quote', body())); } catch (e) { setQuote(null); setQErr(e); } };
  useEffect(() => { if (step === 2 && chosen.length && resourceId) runQuote(); }, [step, before, after, skip, resourceId, JSON.stringify(override), picked.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const book = async () => {
    setBusy(true);
    try { const r = await api.post('/training/venues/book', body()); setDone(r); await board.reload(); toast(`Booked ${r.lines_placed} session${r.lines_placed === 1 ? '' : 's'}`); }
    catch (e) { toast(e.message); await runQuote(); } finally { setBusy(false); }
  };
  const weeks = {};
  for (const s of need) { const k = new Date(s.starts_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); (weeks[k] ??= []).push(s); }
  const problemOf = (s) => quote?.problems?.find((p) => p.session_id === s.id);
  const lineOf = (s) => quote?.lines?.find((l) => l.session_id === s.id);
  const canNext = step === 0 ? chosen.length > 0 : step === 1 ? !!resourceId : false;

  if (done) {
    return (
      <Screen>
        <GradCard colors={grad.fresh} style={{ marginTop: 10 }}>
          <T color="#fff" size={34}>✅</T>
          <T color="#fff" weight="800" size={22}>Court booked for {done.lines_placed} session{done.lines_placed === 1 ? '' : 's'}</T>
          <T color="#fff" size={13} style={{ opacity: 0.9 }}>Booking code {done.code}. {done.awaiting_payment ? `Pay within ${done.pay_within_minutes} minutes to keep the slots.` : 'The other person has been told where you will train.'}</T>
        </GradCard>
        {done.problems.length ? <Card color={c.sunSoft} pad={12} style={{ marginTop: 10 }}><T weight="800">{done.problems.length} could not be booked</T>{done.problems.map((p, n) => <T key={n} size={12} color={c.mute}>{p.title ?? p.date}: {p.message}</T>)}</Card> : null}
        <View style={{ gap: 8, marginTop: 14 }}>
          <Btn title="Open the booking" onPress={() => push('Reservation', { id: done.reservation_id })} />
          <Btn title="Done" color={c.paper} ink={c.ink} onPress={back} />
        </View>
      </Screen>
    );
  }
  return (
    <Screen onRefresh={board.reload}>
      <View style={{ marginTop: 6 }}>
        <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>COACHING</T>
        <T weight="800" size={26}>Book a court for your sessions</T>
        <T size={13} color={c.mute}>Choose the sessions, pick a venue, and every one is attached to its court booking. The coach or the athlete can do this; the other is told.</T>
      </View>
      <Stepper steps={STEPS} current={step} onJump={setStep} />

      {step === 0 ? (
        board.error ? <ErrorBox error={board.error} onRetry={board.reload} /> : board.loading && !board.data ? <Loading /> : !need.length ? (
          <Empty emoji="🗓️" title="No sessions waiting for a venue" sub={board.data.has_venue.length ? `${board.data.has_venue.length} of your sessions already have a court.` : 'Book a coach, or ask a coach to book you in, and the sessions appear here.'} />
        ) : (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip label={`Select all (${need.length})`} onPress={() => setPicked(new Set(need.map((s) => s.id)))} />
              <Chip label="Next 4" onPress={() => setPicked(new Set(need.slice(0, 4).map((s) => s.id)))} />
              <Chip label="Clear" onPress={() => setPicked(new Set())} />
            </View>
            {Object.entries(weeks).map(([m, list]) => (
              <View key={m} style={{ gap: 6 }}>
                <T weight="800" size={13} color={c.mute}>{m.toUpperCase()}</T>
                {list.map((s) => (
                  <Card key={s.id} pad={12} color={picked.has(s.id) ? c.pinkSoft : c.paper} onPress={() => toggle(s)}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <T size={20}>{picked.has(s.id) ? '☑️' : '⬜'}</T>
                      <View style={{ flex: 1 }}>
                        <T weight="700">{s.title}</T>
                        <T size={12} color={c.mute}>{dateTimeIn(s.starts_at, deviceTz)} · {s.duration_min} min · {s.sport_emoji} {s.sport}</T>
                      </View>
                      {s.audience !== 'individual' ? <Pill label={AUD[s.audience].toUpperCase()} /> : null}
                    </View>
                  </Card>
                ))}
              </View>
            ))}
          </View>
        )
      ) : null}

      {step === 1 ? (
        <View style={{ gap: 12 }}>
          <T size={13} color={c.mute}>{chosen.length} session{chosen.length === 1 ? '' : 's'} · first {first ? dateTimeIn(first.starts_at, deviceTz) : ''}</T>
          <CourtPicker sport={sports.length === 1 ? sports[0] : undefined} window={first ? { from: first.starts_at, to: first.ends_at } : null} venueId={venueId} resourceId={resourceId} onVenue={setVenueId} onResource={setResourceId} />
          <Card pad={12}>
            <T weight="800" size={13}>Set-up time</T>
            <Counter label="Book the court before" value={before} onChange={setBefore} min={0} max={120} step={15} suffix=" min" />
            <Counter label="and keep it after" value={after} onChange={setAfter} min={0} max={120} step={15} suffix=" min" />
            <T size={12} color={c.mute} style={{ marginTop: 4 }}>For warm-up, setting out equipment or a cool-down. The court booking is longer than the session; the session stays attached.</T>
          </Card>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: 10 }}>
          {qErr ? <Card color={c.redSoft} pad={12}><T weight="800" color={c.red}>{qErr.message}</T>{(qErr.details?.problems ?? []).map((p, n) => <T key={n} size={12} color={c.mute}>{p.title ?? ''}: {p.message}</T>)}</Card> : null}
          <Card pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="800">{venue.data?.name}</T><T size={12} color={c.mute}>{courts.find((r) => r.id === resourceId)?.name}{before || after ? ` · ${before} min before, ${after} min after` : ''}</T></View>
              <Btn small title="Change" color={c.paper} ink={c.ink} onPress={() => setStep(1)} />
            </View>
          </Card>
          {chosen.map((s) => {
            const p = problemOf(s), l = lineOf(s);
            return (
              <Card key={s.id} pad={12} color={p ? c.redSoft : c.paper}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}><T weight="700">{s.title}</T><T size={12} color={c.mute}>{dateTimeIn(s.starts_at, deviceTz)} · {s.duration_min} min</T></View>
                  {l?.price_cents != null ? <T weight="800">{moneyIn(l.price_cents, quote.currency)}</T> : null}
                  {!quote && !qErr ? <T size={12} color={c.mute}>checking…</T> : p ? null : quote ? <T color={c.lime} weight="800">✓</T> : null}
                </View>
                {p ? <Problem text={p.message} /> : null}
                {(p || override[s.id]) && courts.length > 1 ? (
                  <View style={{ marginTop: 6 }}>
                    <T size={12} color={c.mute}>Use another court for this session:</T>
                    <HScroll>{courts.map((r) => <Chip key={r.id} label={r.name} active={(override[s.id] ?? resourceId) === r.id} onPress={() => setOverride({ ...override, [s.id]: r.id === resourceId ? undefined : r.id })} />)}</HScroll>
                  </View>
                ) : null}
              </Card>
            );
          })}
          <Card pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="700">Skip sessions where the court is taken</T><T size={12} color={c.mute}>{skip ? 'The rest are booked.' : 'If any session cannot be booked, nothing is.'}</T></View>
              <Chip label={skip ? 'On' : 'Off'} active={skip} onPress={() => setSkip(!skip)} />
            </View>
          </Card>
          <Field label="Note for the venue (optional)" value={note} onChangeText={setNote} multiline />
          {quote ? (
            <Card color={c.pinkSoft} pad={14}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">{quote.lines_placed} of {chosen.length} sessions bookable</T><T weight="800" size={16}>{moneyIn(quote.payable_cents, quote.currency)}</T></View>
              <T size={12} color={c.mute}>You pay the venue as for any booking{quote.pay_within_minutes ? `; pay within ${quote.pay_within_minutes} minutes` : ''}.</T>
            </Card>
          ) : null}
          <Btn title={quote ? `Book ${quote.lines_placed} session${quote.lines_placed === 1 ? '' : 's'}` : 'Book'} loading={busy} disabled={!quote || !quote.lines_placed} onPress={book} />
        </View>
      ) : null}

      {step < 2 ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
          <Btn title={step === 0 ? `Continue with ${chosen.length}` : 'Review'} disabled={!canNext} onPress={() => setStep(step + 1)} style={{ flex: 2 }} />
        </View>
      ) : null}
    </Screen>
  );
}

// ================================================================================== RECURRING VENUE BOOKING
export function RecurringVenue() {
  const { push, back } = useNav();
  const { toast } = useSession();
  const today = todayIn(deviceTz);
  const [step, setStep] = useState(0);
  const [venueId, setVenueId] = useState(null), [resourceId, setResourceId] = useState(null);
  const [pat, setPat] = useState(() => newPattern(today));
  const [start, setStart] = useState('18:00'), [end, setEnd] = useState('19:00');
  const [attach, setAttach] = useState(true), [skip, setSkip] = useState(true), [note, setNote] = useState('');
  const [quote, setQuote] = useState(null), [qErr, setQErr] = useState(null), [busy, setBusy] = useState(false), [done, setDone] = useState(null);
  const dates = useMemo(() => { try { return expand(pat); } catch { return []; } }, [pat]);
  const venue = useLoad(() => (venueId ? api.get(`/venues/${venueId}`) : Promise.resolve(null)), [venueId]);
  const body = () => ({ resource_id: resourceId, start, end, ...patternBody(pat), on_conflict: skip ? 'skip' : 'fail', attach_sessions: attach, ...(note.trim() ? { note: note.trim() } : {}) });
  const runQuote = async () => { setQErr(null); try { setQuote(await api.post('/reservations/recurring/quote', body())); } catch (e) { setQuote(null); setQErr(e); } };
  useEffect(() => { if (step === 2 && resourceId && dates.length) runQuote(); }, [step, skip, attach]); // eslint-disable-line react-hooks/exhaustive-deps
  const checked = {};
  for (const p of quote?.problems ?? []) if (p.date) checked[p.date] = p.message;
  const book = async () => {
    setBusy(true);
    try { const r = await api.post('/reservations/recurring', body()); setDone(r); toast(`Booked ${r.lines_placed} date${r.lines_placed === 1 ? '' : 's'}`); }
    catch (e) { toast(e.message); await runQuote(); } finally { setBusy(false); }
  };
  const timeOk = start < end;
  if (done) {
    return (
      <Screen>
        <GradCard colors={grad.fresh} style={{ marginTop: 10 }}>
          <T color="#fff" size={34}>🔁</T>
          <T color="#fff" weight="800" size={22}>{done.lines_placed} booking{done.lines_placed === 1 ? '' : 's'} made</T>
          <T color="#fff" size={13} style={{ opacity: 0.9 }}>{done.resource_name} at {done.venue_name}. Code {done.code}.{done.sessions_attached ? ` ${done.sessions_attached} coaching session${done.sessions_attached === 1 ? '' : 's'} attached.` : ''}</T>
        </GradCard>
        {done.problems.length ? <Card color={c.sunSoft} pad={12} style={{ marginTop: 10 }}><T weight="800">{done.problems.length} date{done.problems.length === 1 ? '' : 's'} skipped</T>{done.problems.map((p, n) => <T key={n} size={12} color={c.mute}>{p.date ? plainDay(p.date) : ''}: {p.message}</T>)}</Card> : null}
        <View style={{ gap: 8, marginTop: 14 }}>
          <Btn title="Open the booking" onPress={() => push('Reservation', { id: done.reservation_id })} />
          <Btn title="Done" color={c.paper} ink={c.ink} onPress={back} />
        </View>
      </Screen>
    );
  }
  return (
    <Screen>
      <View style={{ marginTop: 6 }}>
        <T weight="700" size={12} color={c.pink} style={{ letterSpacing: 1.2 }}>BOOK</T>
        <T weight="800" size={26}>Recurring or bulk booking</T>
        <T size={13} color={c.mute}>The same court at the same time on many dates: every week, every other week, or dates you pick. One booking, one invoice.</T>
      </View>
      <Stepper steps={['Court', 'When', 'Review']} current={step} onJump={setStep} />
      {step === 0 ? <CourtPicker venueId={venueId} resourceId={resourceId} onVenue={setVenueId} onResource={setResourceId} /> : null}
      {step === 1 ? (
        <View style={{ gap: 14 }}>
          <RepeatPicker value={pat} onChange={setPat} min={today} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><TimeField label="From" value={start} onChange={setStart} step={30} /></View>
            <View style={{ flex: 1 }}><TimeField label="Until" value={end} onChange={setEnd} step={30} /></View>
          </View>
          <T size={12} color={c.mute}>Times are at the venue{venue.data?.timezone ? ` (${venue.data.timezone})` : ''}.</T>
          {!timeOk ? <Problem text="The end time must be after the start time." /> : null}
        </View>
      ) : null}
      {step === 2 ? (
        <View style={{ gap: 10 }}>
          <Card pad={12}>
            <T weight="800">{venue.data?.name}</T>
            <T size={12} color={c.mute}>{venue.data?.resources?.find((r) => r.id === resourceId)?.name} · {start}–{end} · {dates.length} date{dates.length === 1 ? '' : 's'}</T>
          </Card>
          {qErr ? <Card color={c.redSoft} pad={12}><T weight="800" color={c.red}>{qErr.message}</T>{(qErr.details?.problems ?? []).map((p, n) => <T key={n} size={12} color={c.mute}>{p.date ? plainDay(p.date) : ''}: {p.message}</T>)}</Card> : null}
          {!quote && !qErr ? <Loading /> : null}
          {quote ? dates.map((d) => {
            const bad = checked[d], line = quote.lines.find((l) => l.date === d);
            return (
              <Card key={d} pad={12} color={bad ? c.redSoft : c.paper}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}><T weight="700">{plainDay(d)}</T>{bad ? <Problem text={bad} /> : null}</View>
                  {line?.price_cents != null ? <T weight="800">{moneyIn(line.price_cents, quote.currency)}</T> : null}
                  {!bad ? <T color={c.lime} weight="800">✓</T> : null}
                </View>
              </Card>
            );
          }) : null}
          <Card pad={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="700">Attach my coaching sessions</T><T size={12} color={c.mute}>{attach ? `${quote?.sessions_attached ?? 0} session${quote?.sessions_attached === 1 ? '' : 's'} that fall inside these bookings will be attached.` : 'Bookings only.'}</T></View>
              <Chip label={attach ? 'On' : 'Off'} active={attach} onPress={() => setAttach(!attach)} />
            </View>
            <View style={{ height: 8 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}><T weight="700">Skip dates that are taken</T><T size={12} color={c.mute}>{skip ? 'The rest are booked.' : 'If any date is taken, nothing is booked.'}</T></View>
              <Chip label={skip ? 'On' : 'Off'} active={skip} onPress={() => setSkip(!skip)} />
            </View>
          </Card>
          <Field label="Note for the venue (optional)" value={note} onChangeText={setNote} multiline />
          {quote ? <Card color={c.pinkSoft} pad={14}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">{quote.lines_placed} of {dates.length} dates bookable</T><T weight="800" size={16}>{moneyIn(quote.payable_cents, quote.currency)}</T></View></Card> : null}
          <Btn title={quote ? `Book ${quote.lines_placed} date${quote.lines_placed === 1 ? '' : 's'}` : 'Book'} loading={busy} disabled={!quote || !quote.lines_placed} onPress={book} />
        </View>
      ) : null}
      {step < 2 ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          {step > 0 ? <Btn title="Back" color={c.paper} ink={c.ink} onPress={() => setStep(step - 1)} style={{ flex: 1 }} /> : null}
          <Btn title={step === 0 ? 'Choose dates' : 'Review'} disabled={step === 0 ? !resourceId : !dates.length || !timeOk} onPress={() => { setQuote(null); setStep(step + 1); }} style={{ flex: 2 }} />
        </View>
      ) : null}
    </Screen>
  );
}

// ================================================================================== COACHING SERIES
/** Book a coach for several dates at once. Shows which dates work; afterwards offers a court for all of them. */
export function SeriesBookingSheet({ coach, card, people = 1, teamId, eventId, minutes, onClose, onDone, onFinish }) {
  const { toast } = useSession();
  const { push } = useNav();
  const today = todayIn(deviceTz);
  const [pat, setPat] = useState(() => newPattern(today));
  const [time, setTime] = useState('17:00'), [note, setNote] = useState(''), [skip, setSkip] = useState(true);
  const [prev, setPrev] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false), [made, setMade] = useState(null);
  const dates = useMemo(() => { try { return expand(pat); } catch { return []; } }, [pat]);
  const body = (extra = {}) => ({ coach_id: coach.id, sport: coach.sport_slug, start: time, timezone: deviceTz, duration_min: minutes, participants: people, ...(card ? { rate_card_id: card.id } : {}), ...(teamId ? { team_id: teamId } : {}), ...(eventId ? { event_id: eventId } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...patternBody(pat), on_conflict: skip ? 'skip' : 'fail', ...extra });
  const check = async () => { setErr(null); try { setPrev(await api.post('/hires/series', body({ preview: true }))); } catch (e) { setPrev(null); setErr(e); } };
  useEffect(() => { setPrev(null); if (dates.length && time) { const t = setTimeout(check, 400); return () => clearTimeout(t); } return undefined; }, [JSON.stringify(pat), time, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  const checked = {};
  for (const d of prev?.dates ?? err?.details?.dates ?? []) if (!d.ok) checked[d.date] = d.problem;
  const send = async () => {
    setBusy(true);
    try { const r = await api.post('/hires/series', body()); setMade(r); await onDone?.(r); toast(`Requested ${r.hires.length} session${r.hires.length === 1 ? '' : 's'}`); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  if (made) {
    return (
      <Sheet visible onClose={onClose} title="Sessions requested">
        <T size={14}>{made.hires.length} session{made.hires.length === 1 ? '' : 's'} with {coach.display_name} requested{made.skipped.length ? `; ${made.skipped.length} skipped` : ''}. Each is confirmed (and paid) on its own.</T>
        {made.skipped.map((s) => <T key={s.date} size={12} color={c.mute}>{plainDay(s.date)}: {s.problem}</T>)}
        <Card color={c.pinkSoft} pad={14}>
          <T weight="800">Need a court for these?</T>
          <T size={13} color={c.mute}>Book one venue for every session in a single go, or pick a court per session.</T>
          <Btn small title="Book a court for all" onPress={() => { onClose(); onFinish?.(); push('TrainingVenue', { ids: made.hires.map((h) => h.id) }); }} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
        <Btn title="Done" color={c.paper} ink={c.ink} onPress={() => { onClose(); onFinish?.(); }} />
      </Sheet>
    );
  }
  return (
    <Sheet visible onClose={onClose} title={`Repeat with ${coach.display_name}`}>
      <RepeatPicker value={pat} onChange={setPat} min={today} checked={checked} />
      <TimeField label="Start time" value={time} onChange={setTime} step={15} hint="Each session starts at this time, in your time zone." />
      <Card pad={12}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}><T weight="700">Skip dates the coach cannot do</T><T size={12} color={c.mute}>{skip ? 'The rest are requested.' : 'If any date fails, nothing is requested.'}</T></View>
          <Chip label={skip ? 'On' : 'Off'} active={skip} onPress={() => setSkip(!skip)} />
        </View>
      </Card>
      <Field label="What do you want to work on? (optional)" value={note} onChangeText={setNote} multiline />
      {err && !prev ? <T color={c.red} weight="700" size={13}>{err.message}</T> : null}
      {!prev && !err && dates.length ? <Loading /> : null}
      {prev ? (
        <Card color={c.pinkSoft} pad={14}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight="700">{prev.bookable} of {prev.requested} sessions available</T><T weight="800" size={16}>{moneyIn(prev.total_cents, prev.currency)}</T></View>
          {prev.skipped.slice(0, 4).map((s) => <T key={s.date} size={12} color={c.mute}>{plainDay(s.date)}: {s.problem}</T>)}
          <T size={12} color={c.mute}>Each session is confirmed by the coach; you pay for each as you would for a single booking.</T>
        </Card>
      ) : null}
      <Btn title={prev ? `Request ${prev.bookable} session${prev.bookable === 1 ? '' : 's'}` : 'Request sessions'} loading={busy} disabled={!prev || !prev.bookable} onPress={send} />
    </Sheet>
  );
}

// ================================================================================== ATTACH TO A BOOKING
/** From a reservation: pick which of your sessions it should host (those inside the booked time are matched). */
export function AttachSessionsSheet({ reservation, onClose, onDone }) {
  const { toast } = useSession();
  const board = useLoad(() => api.get('/training/venues/board'), []);
  const lines = reservation.bookings.filter((b) => b.status === 'confirmed');
  const fits = (board.data?.needs_venue ?? []).filter((s) => lines.some((b) => +new Date(b.starts_at) <= +new Date(s.starts_at) && +new Date(b.ends_at) >= +new Date(s.ends_at)));
  const [picked, setPicked] = useState(null), [busy, setBusy] = useState(false);
  const sel = picked ?? new Set(fits.map((s) => s.id));
  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/training/venues/attach', { reservation_id: reservation.id, sessions: fits.filter((s) => sel.has(s.id)).map((s) => ({ type: s.type, id: s.id })) }); toast(`Attached ${r.linked.length} session${r.linked.length === 1 ? '' : 's'}`); await onDone(); onClose(); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="Attach coaching sessions">
      <T size={13} color={c.mute}>Your sessions that fall inside the booked time. The coach or athlete is told where you will train.</T>
      {board.loading && !board.data ? <Loading /> : !fits.length ? <Empty emoji="🗓️" title="No session fits this booking" sub="A session must start and end inside a booked slot. Book a coach for those times first, or book a venue for your sessions." /> : fits.map((s) => (
        <Card key={s.id} pad={12} color={sel.has(s.id) ? c.pinkSoft : c.paper} onPress={() => { const n = new Set(sel); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setPicked(n); }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <T size={20}>{sel.has(s.id) ? '☑️' : '⬜'}</T>
            <View style={{ flex: 1 }}><T weight="700">{s.title}</T><T size={12} color={c.mute}>{dateTimeIn(s.starts_at, deviceTz)} · {s.duration_min} min</T></View>
          </View>
        </Card>
      ))}
      {fits.length ? <Btn title={`Attach ${[...sel].length} session${[...sel].length === 1 ? '' : 's'}`} loading={busy} disabled={!sel.size} onPress={go} /> : null}
    </Sheet>
  );
}

/** "📍 Venue · Court" under a session, or a nudge to book one. */
export function VenueLine({ venue, onBook }) {
  return venue
    ? <T size={12} color={c.lime} weight="700">📍 {venue}</T>
    : <Pressable onPress={onBook} hitSlop={6}><T size={12} color={c.pink} weight="800">＋ Book a court for this</T></Pressable>;
}
