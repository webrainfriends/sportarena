// Event ↔ venue fit: compares what an event has booked (courts, dates, money) with what it actually plays and with its own
// start/end dates, and says where booked time is wasted before the first game or idle after the last one.
// Two entry points share the same vocabulary:
//   * windowFit()      – before booking: do the requested days match the event's dates? (the booking needs the organiser's consent if not)
//   * analyzeEventFit() – after: every venue booking vs every activity (fixtures, programme sessions, requests) with options + savings.
// It is a deterministic comparison (no model call), so the same answer comes back for people, the app and MCP agents.
import { pool } from './db.js';
import { addDays, toLocal } from './booking/time.js';
import { toMajor } from './currency.js';

const MIN = 60000;
const rowsOf = async (c, text, params) => (await (c ?? pool).query(text, params)).rows;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const money = (cents, cur = 'INR') => `${cur} ${toMajor(cents, cur)}`;
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/** The event's own dates as plain 'YYYY-MM-DD' strings (the pg driver would hand back Date objects). */
export const eventWindow = async (c, eventId) => (await rowsOf(c, 'SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM events WHERE id=$1', [eventId]))[0] ?? { starts_on: null, ends_on: null };

/** Local dates (venue time) and cost of the event's live court bookings, optionally excluding some venues' days already counted. */
export async function bookedDays(c, eventId) {
  const rows = await rowsOf(c, `SELECT b.id, b.starts_at, b.price_cents, r.venue_id, v.timezone FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.event_id=$1 AND b.status IN ('confirmed','no_show')`, [eventId]);
  return rows.map((b) => ({ date: toLocal(b.starts_at, b.timezone).date, cents: Number(b.price_cents), venue_id: b.venue_id }));
}

/**
 * Compare the days a booking would cover with the event's dates.
 * @param {{starts_on?:string|null, ends_on?:string|null}} win event dates
 * @param {{date:string, cents:number}[]} requested days (one entry per court-day)
 * @param {{date:string}[]} existing days already booked for the event (any venue)
 * @param {Set<string>|string[]} skipped event days that need no booking (blackouts, holidays, days off)
 * @param {{edges?:boolean}} o edges=false: only days outside the event matter (a knockout stage need not cover the opening day)
 */
export function windowFit(win, requested, existing = [], skipped = [], currency = 'INR', { edges = true } = {}) {
  const out = { applicable: !!(win.starts_on && win.ends_on), event: { starts_on: win.starts_on ?? null, ends_on: win.ends_on ?? null }, matches: true, consent_required: false, before: [], after: [], uncovered: [], wasted_cents: 0, issues: [], options: [], suggested_window: null };
  if (!out.applicable || !requested.length) return out;
  const skip = new Set(skipped);
  const cost = (list) => list.reduce((s, d) => s + d.cents, 0);
  const early = requested.filter((d) => d.date < win.starts_on), late = requested.filter((d) => d.date > win.ends_on), inside = requested.filter((d) => d.date >= win.starts_on && d.date <= win.ends_on);
  out.before = [...new Set(early.map((d) => d.date))].sort(); out.after = [...new Set(late.map((d) => d.date))].sort();
  const covered = new Set([...existing.map((d) => d.date), ...requested.map((d) => d.date)]);
  for (let d = win.starts_on; d <= win.ends_on; d = addDays(d, 1)) if (!covered.has(d) && !skip.has(d)) out.uncovered.push(d);
  // only the edges matter for "does the booking start and end with the event"; gaps in the middle are listed but not blocking
  const edgeGap = (d) => out.uncovered.includes(d);
  out.wasted_cents = cost(early) + cost(late);
  if (out.before.length) out.issues.push({ code: 'booked_before_event', severity: 'high', dates: out.before, cents: cost(early), message: `${days(out.before.length)} booked before the event starts on ${win.starts_on} (${money(cost(early), currency)}) — nothing can be played there until the event begins.` });
  if (out.after.length) out.issues.push({ code: 'booked_after_event', severity: 'high', dates: out.after, cents: cost(late), message: `${days(out.after.length)} booked after the event ends on ${win.ends_on} (${money(cost(late), currency)}) — the courts would sit idle once the event is over.` });
  if (edges && edgeGap(win.starts_on)) out.issues.push({ code: 'opening_day_uncovered', severity: 'medium', dates: [win.starts_on], cents: 0, message: `No court is booked for the opening day, ${win.starts_on}.` });
  if (edges && edgeGap(win.ends_on)) out.issues.push({ code: 'closing_day_uncovered', severity: 'medium', dates: [win.ends_on], cents: 0, message: `No court is booked for the final day, ${win.ends_on}.` });
  out.matches = !out.issues.length;
  out.consent_required = !out.matches;
  if (out.matches) return out;
  const keep = cost(requested);
  out.options.push({ key: 'keep', label: 'Book exactly what you asked for', booked_cents: keep, wasted_cents: out.wasted_cents, wasted_pct: pct(out.wasted_cents, keep), recommended: false });
  if (inside.length) {
    const trimmed = [...new Set(inside.map((d) => d.date))].sort();
    out.suggested_window = { from_date: trimmed[0], to_date: trimmed[trimmed.length - 1] };
    out.options.push({ key: 'trim', label: `Book only the event days (${out.suggested_window.from_date} → ${out.suggested_window.to_date})`, booked_cents: cost(inside), wasted_cents: 0, wasted_pct: 0, saves_cents: out.wasted_cents, recommended: true });
  }
  const best = out.options.find((o) => o.recommended);
  out.verdict = best
    ? `The requested days do not match the event dates. Booking only the event days saves ${money(best.saves_cents, currency)} (${pct(best.saves_cents, keep)}% of this booking).`
    : `None of the requested days fall inside the event (${win.starts_on} → ${win.ends_on}); this whole booking (${money(keep, currency)}) would be unused unless the event dates change.`;
  return out;
}

/** Throw-ready payload when a booking does not match the event and the organiser has not consented. */
export const consentNeeded = (fit) => ({ consent_required: true, message: fit.verdict, alignment: fit, how: 'Repeat the request with accept_mismatch=true to confirm anyway, or adjust the dates.' });

// ------------------------------------------------------------------ whole-event analysis

/** Minutes of [a,b) covered by the union of intervals. */
function covered(a, b, intervals) {
  const parts = intervals.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  let total = 0, cur = null;
  for (const [s, e] of parts) { if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e); }
  return (total + (cur ? cur[1] - cur[0] : 0)) / MIN;
}

export async function analyzeEventFit(c, ev) {
  const win = await eventWindow(c, ev.id);
  const now = Date.now();
  const bookings = await rowsOf(c, `SELECT b.id, b.resource_id, r.name AS resource_name, r.venue_id, v.name AS venue_name, v.timezone, v.currency, b.starts_at, b.ends_at, b.price_cents, b.status
       FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
      WHERE b.event_id=$1 AND b.status IN ('confirmed','no_show') ORDER BY b.starts_at`, [ev.id]);
  const fixtures = await rowsOf(c, "SELECT id, resource_id, scheduled_at, duration_min, round, 'fixture' AS kind FROM fixtures WHERE event_id=$1 AND status <> 'cancelled' AND scheduled_at IS NOT NULL", [ev.id]);
  const sessions = await rowsOf(c, `SELECT s.id, s.resource_id, s.venue_id, s.scheduled_at, s.duration_min, s.label AS round, 'session' AS kind, sp.name AS sport
       FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id JOIN sports sp ON sp.id=d.sport_id
      WHERE s.event_id=$1 AND s.status <> 'cancelled' AND s.scheduled_at IS NOT NULL`, [ev.id]);
  const requests = await rowsOf(c, "SELECT id, kind, title, target_name, starts_on::text AS starts_on, ends_on::text AS ends_on, coalesce(quote_cents, offer_cents, 0) AS cents, currency, status FROM event_requests WHERE event_id=$1 AND status IN ('sent','quoted','accepted','finalized') AND (starts_on IS NOT NULL OR ends_on IS NOT NULL)", [ev.id]);
  const resVenue = new Map((await rowsOf(c, 'SELECT r.id, r.venue_id FROM resources r WHERE r.id = ANY($1::uuid[])', [[...new Set([...fixtures, ...sessions].map((a) => a.resource_id).filter(Boolean))]])).map((r) => [r.id, r.venue_id]));
  const tzOf = new Map(bookings.map((b) => [b.venue_id, b.timezone]));
  const activities = [...fixtures, ...sessions].map((a) => {
    const venue_id = a.resource_id ? resVenue.get(a.resource_id) : a.venue_id;
    const start = +new Date(a.scheduled_at);
    return { ...a, venue_id, start, end: start + (a.duration_min ?? 60) * MIN, date: venue_id && tzOf.has(venue_id) ? toLocal(a.scheduled_at, tzOf.get(venue_id)).date : new Date(a.scheduled_at).toISOString().slice(0, 10) };
  });

  const findings = [];
  const venues = [];
  for (const vid of [...new Set(bookings.map((b) => b.venue_id))]) {
    const mine = bookings.filter((b) => b.venue_id === vid), v = mine[0], tz = v.timezone, cur = v.currency;
    const acts = activities.filter((a) => a.venue_id === vid);
    const first = acts.length ? acts.reduce((m, a) => (a.date < m ? a.date : m), acts[0].date) : null;
    const last = acts.length ? acts.reduce((m, a) => (a.date > m ? a.date : m), acts[0].date) : null;
    const rows = mine.map((b) => {
      const date = toLocal(b.starts_at, tz).date, s = +new Date(b.starts_at), e = +new Date(b.ends_at);
      const mins = (e - s) / MIN, used = acts.length ? covered(s, e, acts.filter((a) => (a.resource_id ? a.resource_id === b.resource_id : true)).map((a) => [a.start, a.end])) : 0;
      let state = 'used', why = null;
      if (win.starts_on && date < win.starts_on) { state = 'wasted_before'; why = `Booked before the event starts (${win.starts_on})`; }
      else if (win.ends_on && date > win.ends_on) { state = 'idle_after'; why = `Booked after the event ends (${win.ends_on})`; }
      else if (!acts.length) { state = 'unplanned'; why = 'No games scheduled at this venue yet'; }
      else if (date < first) { state = 'wasted_before'; why = `Booked ${days((Date.parse(first) - Date.parse(date)) / 864e5)} before the first game here (${first})`; }
      else if (date > last) { state = 'idle_after'; why = `Booked ${days((Date.parse(date) - Date.parse(last)) / 864e5)} after the last game here (${last})`; }
      else if (!used) { state = 'unused'; why = 'No game is scheduled on this court in this slot'; }
      else if (used / mins < 0.5) { state = 'underused'; why = `Only ${pct(used, mins)}% of the slot has games`; }
      const cents = Number(b.price_cents), wasteShare = state === 'used' || state === 'unplanned' ? 0 : state === 'underused' ? Math.round(cents * (1 - used / mins)) : cents;
      return { id: b.id, resource_id: b.resource_id, resource_name: b.resource_name, date, starts_at: b.starts_at, ends_at: b.ends_at, price_cents: cents, state, reason: why, used_pct: pct(used, mins), wasted_cents: wasteShare, releasable: new Date(b.starts_at).getTime() > now && ['wasted_before', 'idle_after', 'unused'].includes(state) };
    });
    const total = rows.reduce((s, r) => s + r.price_cents, 0), wasted = rows.reduce((s, r) => s + r.wasted_cents, 0);
    const rel = rows.filter((r) => r.releasable), saves = rel.reduce((s, r) => s + r.price_cents, 0);
    const bad = rows.filter((r) => !['used', 'unplanned'].includes(r.state));
    const unplanned = rows.filter((r) => r.state === 'unplanned');
    venues.push({
      venue_id: vid, venue_name: v.venue_name, currency: cur, booked_cents: total, wasted_cents: wasted, utilisation_pct: pct(total - wasted, total),
      first_activity: first, last_activity: last, activities: acts.length, bookings: rows,
      compare: [
        { key: 'keep', label: 'Keep every booking', cost_cents: total, wasted_cents: wasted },
        ...(rel.length ? [{ key: 'release_idle', label: `Release the ${rel.length} idle slot${rel.length === 1 ? '' : 's'} that cannot be used`, cost_cents: total - saves, wasted_cents: Math.max(0, wasted - saves), saves_cents: saves, release_booking_ids: rel.map((r) => r.id), recommended: true }] : []),
      ],
    });
    if (bad.length) findings.push({
      severity: wasted / (total || 1) > 0.25 ? 'high' : 'medium', code: 'venue_time_wasted', venue_id: vid,
      message: `${v.venue_name}: ${bad.length} of ${rows.length} booked slots are not being used, ${money(wasted, cur)} of ${money(total, cur)} wasted (${pct(wasted, total)}%). ${rel.length ? `Releasing the ${rel.length} future idle slot${rel.length === 1 ? '' : 's'} could save up to ${money(saves, cur)} (the venue's cancellation policy decides any refund).` : 'They are in the past or cannot be released any more.'}`,
      booking_ids: bad.map((r) => r.id),
    });
    if (unplanned.length) findings.push({ severity: 'info', code: 'awaiting_schedule', venue_id: vid, message: `${v.venue_name}: ${unplanned.length} slot${unplanned.length === 1 ? ' is' : 's are'} booked but no games are scheduled there yet — build the schedule to see how well they are used.`, booking_ids: unplanned.map((r) => r.id) });
  }

  // activities that fall outside the event dates, or sit at a venue with no booking for them
  const outside = win.starts_on && win.ends_on ? activities.filter((a) => a.date < win.starts_on || a.date > win.ends_on) : [];
  if (outside.length) findings.push({ severity: 'high', code: 'activity_outside_event_dates', message: `${outside.length} game${outside.length === 1 ? ' is' : 's are'} scheduled outside the event dates (${win.starts_on} → ${win.ends_on}). Move them or change the event dates.`, activity_ids: outside.map((a) => a.id) });
  const bookedRes = new Set(bookings.map((b) => b.resource_id));
  const unbooked = activities.filter((a) => a.kind === 'session' && a.resource_id && !bookedRes.has(a.resource_id));
  if (unbooked.length) findings.push({ severity: 'medium', code: 'activity_without_booking', message: `${unbooked.length} programme session${unbooked.length === 1 ? ' uses' : 's use'} a court that has no booking under this event — the slot could be taken by someone else.`, activity_ids: unbooked.map((a) => a.id) });
  // venue / vendor / staff requests dated outside the event
  const stray = win.starts_on && win.ends_on ? requests.filter((r) => (r.starts_on && r.starts_on < win.starts_on) || (r.ends_on && r.ends_on > win.ends_on)) : [];
  for (const r of stray) findings.push({
    severity: 'medium', code: 'request_outside_event_dates', request_id: r.id,
    message: `${r.kind === 'venue' ? 'Venue' : r.kind[0].toUpperCase() + r.kind.slice(1)} request "${r.title}" (${r.target_name}) runs ${r.starts_on ?? '…'} → ${r.ends_on ?? '…'}, beyond the event (${win.starts_on} → ${win.ends_on})${r.cents ? ` — ${money(Number(r.cents), r.currency)} is committed for days that are not needed` : ''}.`,
  });

  const total = venues.reduce((s, v) => s + v.booked_cents, 0), wasted = venues.reduce((s, v) => s + v.wasted_cents, 0);
  const rank = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const rating = !venues.length && !findings.length ? 'no_bookings' : findings.some((f) => f.severity === 'high') ? 'wasteful' : findings.some((f) => f.severity === 'medium') ? 'needs_attention' : 'efficient';
  const headline = {
    no_bookings: 'No courts are booked for this event yet.',
    efficient: total ? `Bookings line up with the event: ${pct(total - wasted, total)}% of the booked spend is in use.` : 'Everything lines up.',
    needs_attention: 'Some booked time or requests do not line up with the event schedule.',
    wasteful: `Booked time is being wasted: ${pct(wasted, total)}% of the venue spend (${venues[0] ? money(wasted, venues[0].currency) : ''}) is outside what the event plays.`,
  }[rating];
  return {
    event: { id: ev.id, name: ev.name, starts_on: win.starts_on, ends_on: win.ends_on }, rating, headline,
    totals: { booked_cents: total, wasted_cents: wasted, utilisation_pct: pct(total - wasted, total), releasable_cents: venues.reduce((s, v) => s + (v.compare.find((o) => o.key === 'release_idle')?.saves_cents ?? 0), 0) },
    findings, venues, method: 'Rule-based comparison of bookings, games, programme sessions and requests against the event dates. No data is changed.',
  };
}

/** Games/slots the scheduler wants to place, as court-days in the venue's time zone. */
export const daysOf = (items, tz) => items.map((it) => ({ date: toLocal(it.at, tz).date, cents: it.cents ?? 0 }));
