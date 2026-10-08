// Doctors & physios, public side (SPOR-60, SPOR-128): provider profile, weekly availability, bookable slots and server-side
// search. Everything here is public-safe discovery data. Clinical data stays in medical.js behind explicit, revocable consent.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { config } from '../config.js';
import { PUBLIC_USER } from '../helpers.js';
import { withBadges } from '../verification.js';
import { addDays, fmtMin, hhmm, toLocal, validTimezone } from '../booking/time.js';
import { MAX_RANGE_DAYS, loadSchedule, openSlots } from '../health/slots.js';
import { ADAPTER_IDS, adapterFor } from '../health/external-booking.js';

const TAG = 'Health';
const TYPES = ['physio', 'doctor'];
const SHORT = z.string().min(1).max(60);

const PROFILE_COLS = `pp.headline, pp.bio, pp.clinic, pp.city, pp.in_person, pp.remote_ok, pp.languages, pp.specialties, pp.accepting_patients, pp.timezone, pp.slot_min, pp.external_provider, pp.external_booking_url`;
const external = ({ external_provider, external_booking_url, ...r }) => ({ ...r, external_booking: external_booking_url ? { provider: external_provider, label: adapterFor(external_provider)?.label ?? external_provider, url: external_booking_url } : null });

cap({
  name: 'upsert_provider_profile', method: 'POST', path: '/me/provider-profile', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: create or update your public provider profile (what patients see when searching). Never put clinical or patient information here. Set `listed=false` to hide yourself from search.',
  input: z.object({
    provider_type: z.enum(TYPES), headline: z.string().max(120).nullable().optional(), bio: z.string().max(2000).nullable().optional(), clinic: z.string().max(120).nullable().optional(), city: z.string().max(80).nullable().optional(),
    in_person: z.boolean().optional(), remote_ok: z.boolean().optional(), languages: z.array(SHORT).max(10).optional(), specialties: z.array(SHORT).max(15).optional(), accepting_patients: z.boolean().optional(),
    currency: z.string().length(3).transform((x) => x.toUpperCase()).nullable().optional(), consult_fee_cents: money.nullable().optional(), timezone: z.string().max(60).optional(), slot_min: z.number().int().min(10).max(240).optional(), listed: z.boolean().optional(),
    external_booking: z.object({ provider: z.enum(ADAPTER_IDS), url: z.string() }).nullable().optional().describe('where you take bookings on another site; patients are sent there with a clear notice. null removes it'),
  }),
  async handler({ user }, i) {
    if (!user.roles.includes(i.provider_type) && !user.roles.includes('admin')) throw badRequest(`Add the ${i.provider_type} role to your account first`);
    if (i.timezone && !validTimezone(i.timezone)) throw badRequest('Unknown time zone');
    if (!i.in_person && i.in_person !== undefined && i.remote_ok === false) throw badRequest('Offer in-person, remote or both');
    if (i.external_booking) adapterFor(i.external_booking.provider).check(i.external_booking.url);
    const cur = await one('SELECT * FROM provider_profiles WHERE user_id=$1', [user.id]);
    const v = (k, d) => (i[k] === undefined ? cur?.[k] ?? d : i[k]);
    const ext = i.external_booking === undefined ? [cur?.external_provider ?? null, cur?.external_booking_url ?? null] : i.external_booking ? [i.external_booking.provider, i.external_booking.url] : [null, null];
    return one(
      `INSERT INTO provider_profiles(user_id, provider_type, headline, bio, clinic, city, in_person, remote_ok, languages, specialties, accepting_patients, currency, consult_fee_cents, timezone, slot_min, listed, external_provider, external_booking_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (user_id) DO UPDATE SET provider_type=$2, headline=$3, bio=$4, clinic=$5, city=$6, in_person=$7, remote_ok=$8, languages=$9, specialties=$10, accepting_patients=$11, currency=$12, consult_fee_cents=$13, timezone=$14, slot_min=$15, listed=$16, external_provider=$17, external_booking_url=$18, updated_at=now()
       RETURNING *`,
      [user.id, i.provider_type, v('headline', null), v('bio', null), v('clinic', null), v('city', null), v('in_person', true), v('remote_ok', false), v('languages', []), v('specialties', []), v('accepting_patients', true), v('currency', null), v('consult_fee_cents', null), v('timezone', 'UTC'), v('slot_min', 30), v('listed', true), ext[0], ext[1]]);
  },
});

cap({
  name: 'set_provider_availability', method: 'POST', path: '/me/provider-availability', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: replace your weekly opening hours (local to your profile time zone). Each window is {weekday 0=Sun..6, start "HH:MM", end "HH:MM"}. Patients can then book only slots inside these hours. Previous windows are kept as history.',
  input: z.object({ windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).max(60) }),
  async handler({ user }, i) {
    if (!(await one('SELECT 1 FROM provider_profiles WHERE user_id=$1', [user.id]))) throw badRequest('Create your provider profile first');
    const rows = i.windows.map((w) => ({ ...w, s: hhmm(w.start), e: hhmm(w.end) }));
    if (rows.some((w) => Number.isNaN(w.s) || Number.isNaN(w.e) || w.s >= w.e || w.s >= 1440)) throw badRequest('Each window needs a valid start before its end (HH:MM)');
    for (const day of new Set(rows.map((w) => w.weekday))) {
      const d = rows.filter((w) => w.weekday === day).sort((a, b) => a.s - b.s);
      if (d.some((w, k) => k && w.s < d[k - 1].e)) throw badRequest('Windows on the same day overlap');
    }
    await tx(async (c) => {
      await c.query('UPDATE provider_availability SET removed_at=now() WHERE provider_id=$1 AND removed_at IS NULL', [user.id]);
      for (const w of rows) await c.query('INSERT INTO provider_availability(provider_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [user.id, w.weekday, w.s, w.e]);
    });
    return { windows: rows.map((w) => ({ weekday: w.weekday, start: fmtMin(w.s), end: fmtMin(w.e) })) };
  },
});

cap({
  name: 'add_provider_time_off', method: 'POST', path: '/me/provider-time-off', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: block a period (holiday, conference). It is removed from bookable slots. Existing appointments are not cancelled automatically.',
  input: z.object({ starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }) }),
  async handler({ user }, i) {
    if (Date.parse(i.ends_at) <= Date.parse(i.starts_at)) throw badRequest('ends_at must be after starts_at');
    return one('INSERT INTO provider_time_off(provider_id, starts_at, ends_at) VALUES ($1,$2,$3) RETURNING id, starts_at, ends_at', [user.id, i.starts_at, i.ends_at]);
  },
});

cap({
  name: 'remove_provider_time_off', method: 'DELETE', path: '/me/provider-time-off/:id', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: take a time-off block off your calendar (kept as history).', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE provider_time_off SET removed_at=now() WHERE id=$1 AND provider_id=$2 AND removed_at IS NULL RETURNING id', [i.id, user.id]);
    if (!r) throw notFound('Time off');
    return { ok: true };
  },
});

cap({
  name: 'search_providers', method: 'GET', path: '/providers/search', tag: TAG, auth: 'public',
  summary: 'Search physios and doctors. Filter by type, sport, specialty, language, city, remote, accepting patients, fee range, minimum rating, verified credential, and availability within a time window; sort by rating, fee, name or (with an availability window) soonest. Paged on the server. Returns public-safe fields only plus the ids to continue into the appointment (book_appointment) and consent (grant_medical_access) flows.',
  input: z.object({
    q: z.string().max(80).optional(), type: z.enum(TYPES).optional(), sport: z.string().max(60).optional().describe('sport slug'), specialty: z.string().max(60).optional(), language: z.string().max(40).optional(),
    city: z.string().max(80).optional(), remote: z.coerce.boolean().optional().describe('true = offers remote consultations'), accepting: z.coerce.boolean().optional(),
    min_fee_cents: z.coerce.number().int().min(0).optional(), max_fee_cents: z.coerce.number().int().min(0).optional(), min_rating: z.coerce.number().min(1).max(5).optional(), verified: z.coerce.boolean().optional().describe('only providers with a current verified credential'),
    available_from: z.string().datetime({ offset: true }).optional(), available_to: z.string().datetime({ offset: true }).optional(),
    sort: z.enum(['rating', 'fee', 'name', 'soonest']).default('rating'), ...page,
  }),
  async handler(_, i) {
    const windowed = i.available_from || i.available_to || i.sort === 'soonest';
    const from = new Date(i.available_from ?? Date.now()), to = new Date(i.available_to ?? +from + 14 * 864e5);
    if (windowed && (!(to > from) || to - from > MAX_RANGE_DAYS * 864e5)) throw badRequest(`Availability window must be between 1 and ${MAX_RANGE_DAYS} days`);
    const order = { rating: 'rating DESC NULLS LAST, rating_count DESC, display_name', fee: 'fee_cents NULLS LAST, display_name', name: 'display_name', soonest: 'display_name' }[i.sort];
    const esc = (x) => (x ? x.replace(/[%_\\]/g, '\\$&') : null);
    const sql = `
      SELECT * FROM (
        SELECT ${PUBLIC_USER}, t.provider_type, ${PROFILE_COLS}, coalesce(pp.currency, $1) AS currency,
               coalesce(pp.consult_fee_cents, (SELECT min(x.hourly_rate_cents) FROM sport_profiles x WHERE x.user_id=u.id AND x.role IN ('physio','doctor') AND x.hourly_rate_cents > 0)) AS fee_cents,
               coalesce((SELECT array_agg(DISTINCT s.slug ORDER BY s.slug) FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id AND x.role IN ('physio','doctor')), '{}') AS sports,
               (SELECT round(avg(r.rating)::numeric, 2) FROM testimonials r WHERE r.subject_type='user' AND r.subject_id=u.id) AS rating,
               (SELECT count(*)::int FROM testimonials r WHERE r.subject_type='user' AND r.subject_id=u.id) AS rating_count,
               EXISTS (SELECT 1 FROM verification_cases v WHERE v.subject_type='user' AND v.subject_id=u.id AND v.type=t.provider_type AND v.status='approved' AND v.expires_at > now()) AS credential_verified,
               (SELECT count(*) FROM provider_availability a WHERE a.provider_id=u.id AND a.removed_at IS NULL) > 0 AS has_hours
          FROM users u LEFT JOIN provider_profiles pp ON pp.user_id=u.id
          CROSS JOIN LATERAL (SELECT coalesce(pp.provider_type, (SELECT x.role FROM sport_profiles x WHERE x.user_id=u.id AND x.role IN ('physio','doctor') ORDER BY x.role LIMIT 1)) AS provider_type) t
         WHERE t.provider_type IS NOT NULL AND coalesce(pp.listed, true) AND ($2::text IS NULL OR t.provider_type=$2)
           AND ($3::text IS NULL OR u.display_name ILIKE '%'||$3||'%' OR u.handle ILIKE '%'||$3||'%' OR pp.headline ILIKE '%'||$3||'%' OR pp.clinic ILIKE '%'||$3||'%' OR pp.bio ILIKE '%'||$3||'%')
           AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id AND x.role IN ('physio','doctor') AND s.slug=$4))
           AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM unnest(pp.specialties) z WHERE z ILIKE $5))
           AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM unnest(pp.languages) z WHERE z ILIKE $6))
           AND ($7::text IS NULL OR pp.city ILIKE $7)
           AND ($8::boolean IS NULL OR coalesce(pp.remote_ok, false) = $8)
           AND ($9::boolean IS NULL OR coalesce(pp.accepting_patients, true) = $9)
      ) q
      WHERE ($10::bigint IS NULL OR q.fee_cents >= $10) AND ($11::bigint IS NULL OR q.fee_cents <= $11) AND ($12::numeric IS NULL OR q.rating >= $12)
        AND (NOT $13 OR q.credential_verified) AND (NOT $14 OR q.has_hours)
      ORDER BY ${order}`;
    const params = [config.payments.currency, i.type ?? null, esc(i.q), i.sport ?? null, esc(i.specialty), esc(i.language), esc(i.city), i.remote ?? null, i.accepting ?? null, i.min_fee_cents ?? null, i.max_fee_cents ?? null, i.min_rating ?? null, !!i.verified, !!windowed];
    let rows;
    if (windowed) {
      // availability is computed from each provider's hours, so filter and page after that (bounded candidate set)
      const candidates = await many(`${sql} LIMIT 200`, params);
      const withSlots = [];
      for (const r of candidates) {
        const slots = await openSlots(r.id, from, to);
        if (slots.length) withSlots.push({ ...r, next_available_at: slots[0], open_slots: slots.length });
      }
      if (i.sort === 'soonest') withSlots.sort((a, b) => a.next_available_at.localeCompare(b.next_available_at));
      rows = withSlots.slice(i.offset, i.offset + i.limit);
    } else rows = await many(`${sql} LIMIT $15 OFFSET $16`, [...params, i.limit, i.offset]);
    const out = await withBadges('user', rows);
    return out.map(({ has_hours, ...r0 }) => external(r0)).map((r) => ({ ...r, book: { capability: 'book_appointment', provider_id: r.id }, consent: { capability: 'grant_medical_access', provider_id: r.id } }));
  },
});

cap({
  name: 'get_provider', method: 'GET', path: '/providers/:id', tag: TAG, auth: 'public',
  summary: 'Public provider profile: type, bio, clinic, city, languages, specialties, sports, fee, rating, verification badges and weekly hours. Public-safe fields only; nothing clinical, no contact details.',
  input: z.object({ id }),
  async handler(_, i) {
    const row = await one(
      `SELECT ${PUBLIC_USER}, pp.provider_type, ${PROFILE_COLS}, pp.currency, pp.consult_fee_cents, pp.listed,
              coalesce((SELECT array_agg(DISTINCT s.slug) FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id AND x.role IN ('physio','doctor')), '{}') AS sports,
              (SELECT round(avg(rating)::numeric, 2) FROM testimonials t WHERE t.subject_type='user' AND t.subject_id=u.id) AS rating, (SELECT count(*)::int FROM testimonials t WHERE t.subject_type='user' AND t.subject_id=u.id) AS rating_count
         FROM users u LEFT JOIN provider_profiles pp ON pp.user_id=u.id WHERE u.id=$1 AND (pp.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM sport_profiles x WHERE x.user_id=u.id AND x.role IN ('physio','doctor')))`, [i.id]);
    if (!row || row.listed === false) throw notFound('Provider');
    const sched = await loadSchedule(i.id);
    const [withB] = await withBadges('user', [row]);
    const { listed, ...pub } = external(withB);
    return { ...pub, currency: pub.currency ?? config.payments.currency, hours: { timezone: sched.timezone, slot_min: sched.slot_min, windows: sched.windows.map((w) => ({ weekday: w.weekday, start: fmtMin(w.start_min), end: fmtMin(w.end_min) })) } };
  },
});

cap({
  name: 'list_provider_slots', method: 'GET', path: '/providers/:id/slots', tag: TAG, auth: 'public',
  summary: 'Bookable start times for a provider in a date range (default the next 14 days, max 31): their weekly hours minus time off and booked appointments, at least an hour ahead. Empty when the provider has set no hours; then request a time with book_appointment.',
  input: z.object({ id, from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), duration_min: z.coerce.number().int().min(10).max(240).optional() }),
  async handler(_, i) {
    const from = new Date(i.from ?? Date.now()), to = new Date(i.to ?? +from + 14 * 864e5);
    if (!(to > from) || to - from > MAX_RANGE_DAYS * 864e5) throw badRequest(`Ask for between 1 and ${MAX_RANGE_DAYS} days`);
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [i.id]))) throw notFound('Provider');
    const sched = await loadSchedule(i.id);
    return { provider_id: i.id, timezone: sched.timezone, slot_min: sched.slot_min, grid: sched.windows.length > 0, slots: await openSlots(i.id, from, to, { duration: i.duration_min, schedule: sched }) };
  },
});
