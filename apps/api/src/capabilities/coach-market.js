// Coach marketplace, athlete side and coach side of one flow:
//   find a coach (profile, reviews, open hours)  ->  or post what you need and let coaches answer
//   -> accept an answer (becomes a hire)  ->  pay, track the schedule  ->  review the completed session.
// Hires stay in coach_hires (hire.js); this file adds the profile, request board, reviews and the money/schedule overview.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { PUBLIC_USER, isAdmin, sportBySlugOrId } from '../helpers.js';
import { NOT_YOUTH_SQL, isYouth } from '../youth.js';
import { badgesFor } from '../verification.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { paymentsEnabled } from '../payments/service.js';
import { fmtMin, hhmm, validTimezone } from '../booking/time.js';
import { MAX_RANGE_DAYS, loadCoachSchedule, openCoachSlots } from '../coach-slots.js';

const TAG = 'Coach marketplace';
const SHORT = z.string().min(1).max(60);
const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const day = z.number().int().min(0).max(6);
const rated = `(SELECT round(avg(r.rating)::numeric, 2)::float8 FROM coach_reviews r WHERE r.coach_id=u.id) AS rating, (SELECT count(*)::int FROM coach_reviews r WHERE r.coach_id=u.id) AS rating_count`;
const futureOnly = (iso) => { if (new Date(iso) <= new Date()) throw badRequest('Pick a time in the future'); };
const total = (rate, mins) => Math.round((Number(rate) * mins) / 60);

const mustCoach = async (coachId, sportId) => {
  const p = await one("SELECT hourly_rate_cents FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [coachId, sportId]);
  if (!p) throw badRequest('You do not coach this sport — add it to your sport profiles first');
  return p;
};
const CLASH_SQL = "SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2";
const clashes = async (c, coachId, startsAt, mins) => (c ? (await c.query(CLASH_SQL, [coachId, startsAt, mins])).rows : await many(CLASH_SQL, [coachId, startsAt, mins])).length > 0;
const mustCoachTx = async (c, coachId, sportId) => {
  if (!(await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [coachId, sportId])).rows.length) throw conflict('That person no longer coaches this sport');
};
// the athlete who posted a request, as public fields prefixed athlete_
const ATHLETE = PUBLIC_USER.split(', ').map((x) => `${x.replace('u.', 'a.')} AS athlete_${x.slice(2)}`).join(', ');

// ----------------------------------------------------------------------------------------------- profile + hours
cap({
  name: 'upsert_coach_profile', method: 'POST', path: '/me/coach-profile', tag: TAG, auth: ['coach'],
  summary: 'Coach: create or update your public coaching profile (headline, about, city, online/in-person, specialties, languages, time zone, session length, taking new athletes, listed in search).',
  input: z.object({
    headline: z.string().max(120).nullable().optional(), bio: z.string().max(2000).nullable().optional(), city: z.string().max(80).nullable().optional(),
    delivery: z.enum(['in_person', 'online', 'both']).optional(), specialties: z.array(SHORT).max(15).optional(), languages: z.array(SHORT).max(10).optional(),
    timezone: z.string().max(60).optional(), slot_min: z.number().int().min(15).max(240).optional(), accepting: z.boolean().optional(), listed: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    if (i.timezone && !validTimezone(i.timezone)) throw badRequest('Unknown time zone');
    const cur = await one('SELECT * FROM coach_profiles WHERE user_id=$1', [user.id]);
    const v = (k, d) => (i[k] === undefined ? cur?.[k] ?? d : i[k]);
    return one(
      `INSERT INTO coach_profiles(user_id, headline, bio, city, delivery, specialties, languages, timezone, slot_min, accepting, listed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id) DO UPDATE SET headline=$2, bio=$3, city=$4, delivery=$5, specialties=$6, languages=$7, timezone=$8, slot_min=$9, accepting=$10, listed=$11, updated_at=now()
       RETURNING *`,
      [user.id, v('headline', null), v('bio', null), v('city', null), v('delivery', 'in_person'), v('specialties', []), v('languages', []), v('timezone', 'UTC'), v('slot_min', 60), v('accepting', true), v('listed', true)]);
  },
});

cap({
  name: 'set_coach_availability', method: 'POST', path: '/me/coach-availability', tag: TAG, auth: ['coach'],
  summary: 'Coach: replace your weekly open hours (local to your profile time zone). Each window is {weekday 0=Sun..6, start "HH:MM", end "HH:MM"}. Athletes can then book only open slots. Previous windows are kept as history. An empty list removes the grid (athletes propose times instead).',
  input: z.object({ windows: z.array(z.object({ weekday: day, start: z.string(), end: z.string() })).max(60) }),
  async handler({ user }, i) {
    const rows = i.windows.map((w) => ({ ...w, s: hhmm(w.start), e: hhmm(w.end) }));
    if (rows.some((w) => Number.isNaN(w.s) || Number.isNaN(w.e) || w.s >= w.e || w.s >= 1440)) throw badRequest('Each window needs a valid start before its end (HH:MM)');
    for (const d of new Set(rows.map((w) => w.weekday))) {
      const list = rows.filter((w) => w.weekday === d).sort((a, b) => a.s - b.s);
      if (list.some((w, k) => k && w.s < list[k - 1].e)) throw badRequest('Windows on the same day overlap');
    }
    await tx(async (c) => {
      await c.query('UPDATE coach_availability SET removed_at=now() WHERE coach_id=$1 AND removed_at IS NULL', [user.id]);
      for (const w of rows) await c.query('INSERT INTO coach_availability(coach_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)', [user.id, w.weekday, w.s, w.e]);
      await c.query('INSERT INTO coach_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    });
    const s = await loadCoachSchedule(user.id);
    return { timezone: s.timezone, slot_min: s.slot_min, windows: s.windows.map((w) => ({ weekday: w.weekday, start: fmtMin(w.start_min), end: fmtMin(w.end_min) })) };
  },
});

cap({
  name: 'get_coach', method: 'GET', path: '/coaches/:id', tag: TAG, auth: 'public',
  summary: 'Public coach profile: about, sports and hourly rates, rating with breakdown, latest reviews, sessions coached, verification badge, weekly hours. Public-safe fields only.',
  input: z.object({ id }),
  async handler(_, i) {
    const u = await one(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id=$1 AND ${NOT_YOUTH_SQL} AND EXISTS (SELECT 1 FROM sport_profiles p WHERE p.user_id=u.id AND p.role='coach')`, [i.id]);
    if (!u) throw notFound('Coach');
    const [profile, sports, summary, spread, reviews, stats, sched, badges] = await Promise.all([
      one('SELECT headline, bio AS about, city, delivery, specialties, languages, accepting, listed, timezone, slot_min FROM coach_profiles WHERE user_id=$1', [i.id]),
      many("SELECT s.slug, s.name, s.emoji, p.level, p.hourly_rate_cents, p.experience_years, p.club FROM sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.role='coach' ORDER BY s.name", [i.id]),
      one('SELECT round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1', [i.id]),
      many('SELECT rating, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1 GROUP BY rating', [i.id]),
      many('SELECT r.id, r.rating, r.body, r.reply, r.replied_at, r.created_at, a.display_name AS author_name, a.avatar_emoji, a.avatar_color, a.avatar_url FROM coach_reviews r JOIN users a ON a.id=r.reviewer_id WHERE r.coach_id=$1 ORDER BY r.created_at DESC LIMIT 10', [i.id]),
      one("SELECT count(*) FILTER (WHERE status='completed')::int AS sessions_done, count(DISTINCT hirer_id) FILTER (WHERE status IN ('confirmed','completed'))::int AS athletes FROM coach_hires WHERE coach_id=$1", [i.id]),
      loadCoachSchedule(i.id),
      badgesFor('user', [i.id]),
    ]);
    const next = sched.windows.length ? (await openCoachSlots(i.id, new Date(), new Date(Date.now() + 14 * 864e5), { schedule: sched }))[0] ?? null : null;
    return {
      ...u, currency: config.payments.currency, profile: profile ?? { delivery: 'in_person', accepting: true, listed: true, timezone: 'UTC', slot_min: 60, specialties: [], languages: [] }, sports,
      rating: { avg: summary.avg, count: summary.n, breakdown: [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: spread.find((x) => x.rating === r)?.n ?? 0 })) },
      reviews, stats, verified: badges.get(i.id) ?? [], next_available_at: next,
      hours: { timezone: sched.timezone, slot_min: sched.slot_min, windows: sched.windows.map((w) => ({ weekday: w.weekday, start: fmtMin(w.start_min), end: fmtMin(w.end_min) })) },
    };
  },
});

cap({
  name: 'coach_open_slots', method: 'GET', path: '/coaches/:id/slots', tag: TAG, auth: 'public',
  summary: 'Open session start times for a coach between `from` and `to` (default: next 14 days, max 31). `grid:false` means the coach published no hours: propose any time instead.',
  input: z.object({ id, from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), duration_min: z.coerce.number().int().min(15).max(480).optional() }),
  async handler(_, i) {
    const from = i.from ? new Date(i.from) : new Date(), to = i.to ? new Date(i.to) : new Date(+from + 14 * 864e5);
    if (!(to > from) || to - from > MAX_RANGE_DAYS * 864e5) throw badRequest(`Window must be between 1 and ${MAX_RANGE_DAYS} days`);
    const sched = await loadCoachSchedule(i.id);
    return { grid: sched.windows.length > 0, timezone: sched.timezone, slot_min: sched.slot_min, slots: await openCoachSlots(i.id, from, to, { duration: i.duration_min, schedule: sched }) };
  },
});

// ----------------------------------------------------------------------------------------------- the request board
const requestInput = z.object({
  sport: z.string(), title: z.string().min(3).max(120), goal: z.string().max(1000).optional(), level: z.enum(LEVELS).optional(),
  delivery: z.enum(['in_person', 'online', 'either']).default('either'), city: z.string().max(80).optional(), budget_max_cents: money.optional(),
  sessions_per_week: z.number().int().min(1).max(14).optional(), preferred_days: z.array(day).max(7).default([]), start_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

cap({
  name: 'create_coach_request', method: 'POST', path: '/coach-requests', tag: TAG, status: 201,
  summary: 'Post what you are looking for in a coach (sport, goal, level, in-person/online, city, hourly budget, sessions per week, preferred days, start date). Coaches of that sport can answer; you review the answers and accept one. Not available to minors.',
  input: requestInput,
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw forbidden('A parent or guardian needs to arrange coaching for you');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw badRequest('Unknown sport');
    const open = await one("SELECT count(*)::int AS n FROM coach_requests WHERE athlete_id=$1 AND status='open'", [user.id]);
    if (open.n >= 5) throw conflict('You already have 5 open requests — close one first');
    const r = await one(
      `INSERT INTO coach_requests(athlete_id, sport_id, title, goal, level, delivery, city, budget_max_cents, sessions_per_week, preferred_days, start_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [user.id, sport.id, i.title, i.goal ?? null, i.level ?? null, i.delivery, i.city ?? null, i.budget_max_cents ?? null, i.sessions_per_week ?? null, [...new Set(i.preferred_days)].sort(), i.start_by ?? null]);
    // tell coaches of this sport who are accepting athletes (in-app, respects their mute settings)
    const coaches = await many("SELECT DISTINCT p.user_id FROM sport_profiles p LEFT JOIN coach_profiles cp ON cp.user_id=p.user_id JOIN users u ON u.id=p.user_id WHERE p.role='coach' AND p.sport_id=$1 AND p.user_id <> $2 AND coalesce(cp.accepting, true) AND coalesce(cp.listed, true) LIMIT 200", [sport.id, user.id]);
    for (const c of coaches) await notify(null, c.user_id, { kind: 'coach_request_new', title: `New ${sport.name} coaching request`, body: i.title, data: { request_id: r.id } });
    return r;
  },
});

const REQUEST_COLS = `r.id, r.title, r.goal, r.level, r.delivery, r.city, r.budget_max_cents, r.sessions_per_week, r.preferred_days, r.start_by, r.status, r.created_at, r.closed_at, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji`;

cap({
  name: 'my_coach_requests', method: 'GET', path: '/coach-requests/mine', tag: TAG,
  summary: 'Requests you posted, with how many answers are waiting.', input: z.object({ status: z.enum(['open', 'filled', 'closed']).optional(), ...page }),
  handler: async ({ user }, i) => (await many(
    `SELECT ${REQUEST_COLS},
            (SELECT count(*)::int FROM coach_request_responses x WHERE x.request_id=r.id AND x.status='pending') AS pending_responses,
            (SELECT count(*)::int FROM coach_request_responses x WHERE x.request_id=r.id AND x.status <> 'withdrawn') AS responses
       FROM coach_requests r JOIN sports s ON s.id=r.sport_id WHERE r.athlete_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY (r.status='open') DESC, r.created_at DESC, r.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset])).map((r) => ({ ...r, currency: config.payments.currency })),
});

cap({
  name: 'list_coach_requests', method: 'GET', path: '/coach-requests', tag: TAG, auth: ['coach'],
  summary: 'Coach: open requests from athletes. By default only sports you coach. Shows whether you already answered. Athlete contact details are never shown.',
  input: z.object({ sport: z.string().optional(), all_sports: z.coerce.boolean().optional(), q: z.string().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT ${REQUEST_COLS}, ${ATHLETE},
              (SELECT count(*)::int FROM coach_request_responses x WHERE x.request_id=r.id AND x.status <> 'withdrawn') AS responses,
              (SELECT jsonb_build_object('id', x.id, 'status', x.status, 'rate_cents_hour', x.rate_cents_hour) FROM coach_request_responses x WHERE x.request_id=r.id AND x.coach_id=$1) AS my_response
         FROM coach_requests r JOIN sports s ON s.id=r.sport_id JOIN users a ON a.id=r.athlete_id
        WHERE r.status='open' AND r.athlete_id <> $1 AND ($2::uuid IS NULL OR r.sport_id=$2)
          AND ($3 OR $2::uuid IS NOT NULL OR r.sport_id IN (SELECT sport_id FROM sport_profiles WHERE user_id=$1 AND role='coach'))
          AND ($4::text IS NULL OR r.title ILIKE '%'||$4||'%' OR r.goal ILIKE '%'||$4||'%' OR r.city ILIKE '%'||$4||'%')
        ORDER BY r.created_at DESC, r.id LIMIT $5 OFFSET $6`, [user.id, sport?.id ?? null, !!i.all_sports, i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, currency: config.payments.currency }));
  },
});

const responseRows = (requestId, where, params) => many(
  `SELECT x.id, x.coach_id, x.rate_cents_hour, x.message, x.proposed_starts_at, x.duration_min, x.status, x.hire_id, x.created_at, x.decided_at,
          (x.rate_cents_hour * x.duration_min / 60)::bigint AS first_session_cents, ${PUBLIC_USER.replace('u.id, ', '')}, ${rated},
          (SELECT count(*)::int FROM coach_hires h WHERE h.coach_id=u.id AND h.status='completed') AS sessions_done,
          EXISTS (SELECT 1 FROM verification_cases v WHERE v.subject_type='user' AND v.subject_id=u.id AND v.type='coach' AND v.status='approved' AND v.expires_at > now()) AS credential_verified
     FROM coach_request_responses x JOIN users u ON u.id=x.coach_id WHERE x.request_id=$1 ${where} ORDER BY (x.status='pending') DESC, x.created_at, x.id`, [requestId, ...params]);

cap({
  name: 'get_coach_request', method: 'GET', path: '/coach-requests/:id', tag: TAG,
  summary: 'A request. The athlete who posted it sees every answer (rate, first session, message, rating, verification); a coach sees the request and their own answer.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(`SELECT ${REQUEST_COLS}, r.athlete_id, ${ATHLETE} FROM coach_requests r JOIN sports s ON s.id=r.sport_id JOIN users a ON a.id=r.athlete_id WHERE r.id=$1`, [i.id]);
    if (!r) throw notFound('Request');
    const mine = r.athlete_id === user.id;
    if (!mine && !user.roles.includes('coach') && !isAdmin(user)) throw forbidden();
    const responses = mine ? await responseRows(r.id, "AND x.status <> 'withdrawn'", []) : await responseRows(r.id, 'AND x.coach_id=$2', [user.id]);
    return { ...r, currency: config.payments.currency, i_am_owner: mine, responses: mine ? responses : [], my_response: mine ? null : responses[0] ?? null };
  },
});

cap({
  name: 'respond_to_coach_request', method: 'POST', path: '/coach-requests/:id/respond', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Coach: answer an open request with your hourly rate, a message and the first session time you propose. Answering again before the athlete decides updates your answer. The athlete accepts or declines.',
  input: z.object({ id, rate_cents_hour: money.optional().describe('defaults to your rate for this sport'), message: z.string().max(1000).optional(), starts_at: z.string().datetime({ offset: true }), duration_min: z.number().int().min(15).max(480).default(60) }),
  async handler({ user }, i) {
    const r = await one('SELECT r.*, s.name AS sport_name FROM coach_requests r JOIN sports s ON s.id=r.sport_id WHERE r.id=$1', [i.id]);
    if (!r) throw notFound('Request');
    if (r.athlete_id === user.id) throw badRequest('You cannot answer your own request');
    if (r.status !== 'open') throw conflict('This request is no longer open');
    futureOnly(i.starts_at);
    const prof = await mustCoach(user.id, r.sport_id);
    const rate = i.rate_cents_hour ?? Number(prof.hourly_rate_cents ?? 0);
    if (await clashes(null, user.id, i.starts_at, i.duration_min)) throw conflict('You already have a session then');
    const cur = await one('SELECT id, status FROM coach_request_responses WHERE request_id=$1 AND coach_id=$2', [r.id, user.id]);
    if (cur && ['accepted', 'declined'].includes(cur.status)) throw conflict(`Your answer was already ${cur.status}`);
    const saved = cur
      ? await one("UPDATE coach_request_responses SET rate_cents_hour=$2, message=$3, proposed_starts_at=$4, duration_min=$5, status='pending' WHERE id=$1 RETURNING *", [cur.id, rate, i.message ?? null, i.starts_at, i.duration_min])
      : await one('INSERT INTO coach_request_responses(request_id, coach_id, rate_cents_hour, message, proposed_starts_at, duration_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [r.id, user.id, rate, i.message ?? null, i.starts_at, i.duration_min]);
    await notify(null, r.athlete_id, { kind: 'coach_request_response', title: `${user.display_name} answered your ${r.sport_name} request`, body: r.title, data: { request_id: r.id, response_id: saved.id } });
    return saved;
  },
});

cap({
  name: 'withdraw_coach_response', method: 'POST', path: '/coach-responses/:id/withdraw', tag: TAG, auth: ['coach'],
  summary: 'Coach: take back an answer the athlete has not decided on yet (kept as history).', input: z.object({ id }),
  async handler({ user }, i) {
    const x = await one("UPDATE coach_request_responses SET status='withdrawn', decided_at=now() WHERE id=$1 AND coach_id=$2 AND status='pending' RETURNING id, status", [i.id, user.id]);
    if (!x) throw conflict('Only your own pending answer can be withdrawn');
    return x;
  },
});

cap({
  name: 'decide_coach_response', method: 'POST', path: '/coach-responses/:id/decision', tag: TAG,
  summary: 'Athlete: accept or decline a coach\'s answer. Accepting books the proposed first session at the coach\'s rate (the coach has already agreed; pay to lock it in), closes the request and politely declines the other pending answers.',
  input: z.object({ id, decision: z.enum(['accept', 'decline']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = (await c.query(
        `SELECT x.*, r.athlete_id, r.sport_id, r.title, r.status AS request_status, s.name AS sport_name
           FROM coach_request_responses x JOIN coach_requests r ON r.id=x.request_id JOIN sports s ON s.id=r.sport_id WHERE x.id=$1 FOR UPDATE OF x, r`, [i.id])).rows[0];
      if (!x) throw notFound('Answer');
      if (x.athlete_id !== user.id) throw forbidden('Only the athlete who posted the request can decide');
      if (x.status !== 'pending') throw conflict(`This answer is already ${x.status}`);
      if (i.decision === 'decline') {
        await c.query("UPDATE coach_request_responses SET status='declined', decided_at=now() WHERE id=$1", [x.id]);
        await notify(c, x.coach_id, { kind: 'coach_response_declined', title: 'Your answer was not chosen', body: `${x.sport_name}: ${x.title}`, data: { request_id: x.request_id } });
        return { id: x.id, status: 'declined', hire: null };
      }
      if (x.request_status !== 'open') throw conflict('This request is no longer open');
      futureOnly(x.proposed_starts_at);
      await mustCoachTx(c, x.coach_id, x.sport_id);
      if (await clashes(c, x.coach_id, x.proposed_starts_at, x.duration_min)) throw conflict('The coach is no longer free at that time — ask them to propose another');
      const cost = total(x.rate_cents_hour, x.duration_min);
      const pay = paymentsEnabled() && cost > 0 ? 'unpaid' : 'not_required';
      const hire = (await c.query(
        `INSERT INTO coach_hires(hirer_id, coach_id, sport_id, starts_at, duration_min, rate_cents_hour, total_cents, note, payment_status, status, request_response_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, coach_id, starts_at, duration_min, total_cents, status, payment_status`,
        [user.id, x.coach_id, x.sport_id, x.proposed_starts_at, x.duration_min, x.rate_cents_hour, cost, x.title, pay, pay === 'unpaid' ? 'requested' : 'confirmed', x.id])).rows[0];
      await c.query("UPDATE coach_request_responses SET status='accepted', decided_at=now(), hire_id=$2 WHERE id=$1", [x.id, hire.id]);
      await c.query("UPDATE coach_requests SET status='filled', filled_by=$2, closed_at=now() WHERE id=$1", [x.request_id, x.coach_id]);
      const others = (await c.query("UPDATE coach_request_responses SET status='declined', decided_at=now() WHERE request_id=$1 AND status='pending' RETURNING coach_id", [x.request_id])).rows;
      for (const o of others) await notify(c, o.coach_id, { kind: 'coach_response_declined', title: 'The athlete chose another coach', body: `${x.sport_name}: ${x.title}`, data: { request_id: x.request_id } });
      await notify(c, x.coach_id, { kind: 'coach_response_accepted', title: `${user.display_name} chose you`, body: pay === 'unpaid' ? 'The session is confirmed as soon as they pay.' : 'The first session is confirmed.', data: { hire_id: hire.id, request_id: x.request_id } });
      return { id: x.id, status: 'accepted', hire };
    });
  },
});
cap({
  name: 'close_coach_request', method: 'POST', path: '/coach-requests/:id/close', tag: TAG,
  summary: 'Athlete: close your open request (kept as history). Pending answers are declined and those coaches are told.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT id, athlete_id, title, status FROM coach_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (r.athlete_id !== user.id) throw forbidden('Only the athlete who posted the request can close it');
      if (r.status !== 'open') throw conflict(`Already ${r.status}`);
      await c.query("UPDATE coach_requests SET status='closed', closed_at=now() WHERE id=$1", [r.id]);
      const gone = (await c.query("UPDATE coach_request_responses SET status='declined', decided_at=now() WHERE request_id=$1 AND status='pending' RETURNING coach_id", [r.id])).rows;
      for (const g of gone) await notify(c, g.coach_id, { kind: 'coach_response_declined', title: 'A request you answered was closed', body: r.title, data: { request_id: r.id } });
      return { id: r.id, status: 'closed' };
    });
  },
});

// ----------------------------------------------------------------------------------------------- reviews
cap({
  name: 'review_coach_session', method: 'POST', path: '/hires/:id/review', tag: TAG, status: 201,
  summary: 'Athlete: rate a completed coaching session (1-5) with an optional comment. One verified review per session.',
  input: z.object({ id, rating: z.number().int().min(1).max(5), body: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    const h = await one("SELECT h.*, u.display_name AS coach_name FROM coach_hires h JOIN users u ON u.id=h.coach_id WHERE h.id=$1", [i.id]);
    if (!h) throw notFound('Session');
    if (h.hirer_id !== user.id) throw forbidden('Only the athlete who booked can review this session');
    if (h.status !== 'completed') throw conflict('You can review a session once the coach has marked it complete');
    if (await one('SELECT 1 FROM coach_reviews WHERE hire_id=$1', [h.id])) throw conflict('You already reviewed this session');
    const r = await one('INSERT INTO coach_reviews(hire_id, reviewer_id, coach_id, rating, body) VALUES ($1,$2,$3,$4,$5) RETURNING *', [h.id, user.id, h.coach_id, i.rating, i.body?.trim() || null]);
    await notify(null, h.coach_id, { kind: 'coach_review', title: `${user.display_name} rated your session ${i.rating}★`, body: i.body?.slice(0, 140) ?? '', data: { review_id: r.id } });
    return r;
  },
});

cap({
  name: 'reply_to_coach_review', method: 'POST', path: '/coach-reviews/:id/reply', tag: TAG, auth: ['coach'],
  summary: 'Coach: answer a review of you, once. The reply is public under the review.', input: z.object({ id, reply: z.string().min(2).max(600) }),
  async handler({ user }, i) {
    const r = await one('SELECT id, coach_id, reply FROM coach_reviews WHERE id=$1', [i.id]);
    if (!r) throw notFound('Review');
    if (r.coach_id !== user.id) throw forbidden('You can only answer reviews of you');
    if (r.reply) throw conflict('You already replied');
    return one('UPDATE coach_reviews SET reply=$2, replied_at=now() WHERE id=$1 RETURNING id, reply, replied_at', [r.id, i.reply.trim()]);
  },
});

cap({
  name: 'list_coach_reviews', method: 'GET', path: '/coaches/:id/reviews', tag: TAG, auth: 'public',
  summary: 'Reviews of a coach, newest first.', input: z.object({ id, ...page }),
  handler: (_, i) => many('SELECT r.id, r.rating, r.body, r.reply, r.replied_at, r.created_at, a.display_name AS author_name, a.avatar_emoji, a.avatar_color, a.avatar_url FROM coach_reviews r JOIN users a ON a.id=r.reviewer_id WHERE r.coach_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]),
});

// ----------------------------------------------------------------------------------------------- schedule + money
const SESSION_COLS = `h.id, h.starts_at, h.duration_min, h.total_cents, h.status, h.payment_status, h.note, h.coach_id, h.hirer_id, s.name AS sport, s.emoji AS sport_emoji, s.slug AS sport_slug`;

cap({
  name: 'coaching_overview', method: 'GET', path: '/coaching/overview', tag: TAG,
  summary: 'Your coaching at a glance, both sides. As an athlete: upcoming sessions, sessions waiting for your payment, sessions to review, open requests with new answers, what you paid and owe. As a coach (if you are one): upcoming sessions, requests to confirm, earned vs awaiting payment, rating and unanswered reviews, open requests you could answer.',
  async handler({ user }) {
    const isCoach = user.roles.includes('coach');
    const [upcoming, planSessions, unpaid, toReview, openReqs, spend] = await Promise.all([
      many(`SELECT ${SESSION_COLS}, u.display_name AS coach_name, u.avatar_emoji, u.avatar_color, u.avatar_url FROM coach_hires h JOIN users u ON u.id=h.coach_id LEFT JOIN sports s ON s.id=h.sport_id WHERE h.hirer_id=$1 AND h.status IN ('requested','confirmed') AND h.starts_at > now() - interval '3 hours' ORDER BY h.starts_at, h.id LIMIT 20`, [user.id]),
      many(`SELECT t.id, t.title, t.starts_at, t.duration_min, p.id AS plan_id, uc.display_name AS coach_name FROM training_sessions t JOIN training_plans p ON p.id=t.plan_id JOIN users uc ON uc.id=p.coach_id WHERE p.athlete_id=$1 AND t.status='scheduled' AND t.starts_at > now() ORDER BY t.starts_at, t.id LIMIT 10`, [user.id]),
      many(`SELECT ${SESSION_COLS}, u.display_name AS coach_name FROM coach_hires h JOIN users u ON u.id=h.coach_id LEFT JOIN sports s ON s.id=h.sport_id WHERE h.hirer_id=$1 AND h.payment_status='unpaid' AND h.status IN ('requested','confirmed') ORDER BY h.starts_at, h.id LIMIT 20`, [user.id]),
      many(`SELECT ${SESSION_COLS}, u.display_name AS coach_name FROM coach_hires h JOIN users u ON u.id=h.coach_id LEFT JOIN sports s ON s.id=h.sport_id WHERE h.hirer_id=$1 AND h.status='completed' AND NOT EXISTS (SELECT 1 FROM coach_reviews r WHERE r.hire_id=h.id) ORDER BY h.completed_at DESC NULLS LAST, h.id LIMIT 10`, [user.id]),
      one("SELECT count(*)::int AS open, coalesce(sum((SELECT count(*) FROM coach_request_responses x WHERE x.request_id=r.id AND x.status='pending')), 0)::int AS new_answers FROM coach_requests r WHERE r.athlete_id=$1 AND r.status='open'", [user.id]),
      one(`SELECT coalesce(sum(total_cents) FILTER (WHERE payment_status='paid'), 0)::bigint AS paid_cents, coalesce(sum(total_cents) FILTER (WHERE payment_status IN ('paid','not_required') AND status IN ('confirmed','completed')), 0)::bigint AS spent_cents, coalesce(sum(total_cents) FILTER (WHERE payment_status='unpaid' AND status IN ('requested','confirmed')), 0)::bigint AS due_cents,
                  coalesce(sum(total_cents) FILTER (WHERE payment_status='refunded'), 0)::bigint AS refunded_cents, count(*) FILTER (WHERE status='completed')::int AS sessions_completed FROM coach_hires WHERE hirer_id=$1`, [user.id]),
    ]);
    const athlete = { upcoming, plan_sessions: planSessions, awaiting_payment: unpaid, to_review: toReview, requests: openReqs, spend };
    let coach = null;
    if (isCoach) {
      const [cu, toConfirm, money2, rating, unanswered, board] = await Promise.all([
        many(`SELECT ${SESSION_COLS}, a.display_name AS athlete_name, a.avatar_emoji, a.avatar_color, a.avatar_url FROM coach_hires h JOIN users a ON a.id=h.hirer_id LEFT JOIN sports s ON s.id=h.sport_id WHERE h.coach_id=$1 AND h.status IN ('requested','confirmed') AND h.starts_at > now() - interval '3 hours' ORDER BY h.starts_at, h.id LIMIT 20`, [user.id]),
        many(`SELECT ${SESSION_COLS}, a.display_name AS athlete_name FROM coach_hires h JOIN users a ON a.id=h.hirer_id LEFT JOIN sports s ON s.id=h.sport_id WHERE h.coach_id=$1 AND h.status='requested' ORDER BY h.starts_at, h.id LIMIT 20`, [user.id]),
        one(`SELECT coalesce(sum(total_cents) FILTER (WHERE payment_status IN ('paid','not_required') AND status IN ('confirmed','completed')), 0)::bigint AS earned_cents,
                    coalesce(sum(total_cents) FILTER (WHERE payment_status IN ('paid','not_required') AND status='completed'), 0)::bigint AS completed_cents,
                    coalesce(sum(total_cents) FILTER (WHERE payment_status='unpaid' AND status IN ('requested','confirmed')), 0)::bigint AS awaiting_payment_cents,
                    coalesce(sum(total_cents) FILTER (WHERE payment_status='refunded'), 0)::bigint AS refunded_cents, count(*) FILTER (WHERE status='completed')::int AS sessions_completed FROM coach_hires WHERE coach_id=$1`, [user.id]),
        one('SELECT round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1', [user.id]),
        many('SELECT r.id, r.rating, r.body, r.created_at, a.display_name AS author_name FROM coach_reviews r JOIN users a ON a.id=r.reviewer_id WHERE r.coach_id=$1 AND r.reply IS NULL ORDER BY r.created_at DESC LIMIT 10', [user.id]),
        one("SELECT count(*)::int AS open FROM coach_requests r WHERE r.status='open' AND r.athlete_id <> $1 AND r.sport_id IN (SELECT sport_id FROM sport_profiles WHERE user_id=$1 AND role='coach') AND NOT EXISTS (SELECT 1 FROM coach_request_responses x WHERE x.request_id=r.id AND x.coach_id=$1)", [user.id]),
      ]);
      coach = { upcoming: cu, to_confirm: toConfirm, earnings: money2, rating, unanswered_reviews: unanswered, board_open: board.open };
    }
    return { currency: config.payments.currency, athlete, coach };
  },
});

cap({
  name: 'coaching_payments', method: 'GET', path: '/coaching/payments', tag: TAG,
  summary: 'Payment ledger for coaching sessions: what you paid (as athlete) or are owed / were paid (as coach), per session with status, paid date and refund date.',
  input: z.object({ as: z.enum(['athlete', 'coach']).default('athlete'), payment_status: z.enum(['unpaid', 'paid', 'refunded', 'not_required']).optional(), ...page }),
  async handler({ user }, i) {
    if (i.as === 'coach' && !user.roles.includes('coach') && !isAdmin(user)) throw forbidden('You are not a coach');
    const mine = i.as === 'coach' ? 'h.coach_id' : 'h.hirer_id', other = i.as === 'coach' ? 'h.hirer_id' : 'h.coach_id';
    return (await many(
      `SELECT ${SESSION_COLS}, h.rate_cents_hour, o.display_name AS counterparty_name, o.avatar_emoji, o.avatar_color, o.avatar_url, p.paid_at, p.refunded_at, p.provider AS paid_with, $2::text AS as_role
         FROM coach_hires h JOIN users o ON o.id=${other} LEFT JOIN sports s ON s.id=h.sport_id
         LEFT JOIN LATERAL (SELECT paid_at, refunded_at, provider FROM payments WHERE purpose_type='coach_hire' AND purpose_id=h.id AND status IN ('paid','refunded') ORDER BY created_at DESC LIMIT 1) p ON true
        WHERE ${mine}=$1 AND ($3::text IS NULL OR h.payment_status=$3) ORDER BY h.starts_at DESC, h.id LIMIT $4 OFFSET $5`, [user.id, i.as, i.payment_status ?? null, i.limit, i.offset])).map((r) => ({ ...r, currency: config.payments.currency }));
  },
});
