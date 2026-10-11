// The coach's side as a business: what they are good at (specialisations), what each kind of work costs (rate cards for
// individuals, groups, teams and events), what they have signed up to (contracts & commitments with a delivery log),
// testimonials in both directions, and reports. Hires, requests and reviews live in hire.js / coach-market.js.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { sportBySlugOrId } from '../helpers.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { requireRelationship } from '../coaching.js';
import { canCoachTeam } from './teams.js';
import { AUDIENCES } from '../coach-pricing.js';
import { addDays, dateRange, hhmm, validTimezone } from '../booking/time.js';
import { dbDate, isoDate, loggedMap, occurrences, plain } from '../coach-commitments.js';
import { loadCoachSchedule } from '../coach-slots.js';

const TAG = 'Coach business';
const COACH = ['coach'];
const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const weekday = z.number().int().min(0).max(6);

const coachesSport = async (coachId, sportId) => {
  if (!(await one("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [coachId, sportId]))) throw badRequest('Add this sport to your sport profiles with the Coach role first');
};
const ownSpec = async (coachId, specId) => {
  const z2 = await one('SELECT * FROM coach_specialisations WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [specId, coachId]);
  if (!z2) throw notFound('Specialisation');
  return z2;
};

// ----------------------------------------------------------------------------------------------- specialisations
cap({
  name: 'upsert_coach_specialisation', method: 'POST', path: '/coach/specialisations', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach: add or update (pass `id`) a specialisation — a focus within a sport (e.g. goalkeeping, youth development), the levels you serve, years of experience and your certification. Shown on your profile and used to group your reports.',
  input: z.object({ id: id.optional(), sport: z.string(), name: z.string().min(2).max(80), levels: z.array(z.enum(LEVELS)).max(4).default([]), years: z.number().int().min(0).max(80).nullable().optional(), certification: z.string().max(160).nullable().optional() }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw badRequest('Unknown sport');
    await coachesSport(user.id, sport.id);
    if (i.id) {
      await ownSpec(user.id, i.id);
      return one('UPDATE coach_specialisations SET sport_id=$2, name=$3, levels=$4, years=$5, certification=$6 WHERE id=$1 RETURNING *', [i.id, sport.id, i.name, i.levels, i.years ?? null, i.certification ?? null]);
    }
    return one('INSERT INTO coach_specialisations(coach_id, sport_id, name, levels, years, certification) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [user.id, sport.id, i.name, i.levels, i.years ?? null, i.certification ?? null]);
  },
});

cap({
  name: 'list_coach_specialisations', method: 'GET', path: '/coach/specialisations', tag: TAG, auth: COACH,
  summary: 'Your specialisations with how much work each brought: sessions delivered, income and rating (from sessions booked on rate cards tied to the specialisation).',
  async handler({ user }) {
    return many(
      `SELECT z.id, z.name, z.levels, z.years, z.certification, s.slug AS sport_slug, s.name AS sport, s.emoji,
              (SELECT count(*)::int FROM coach_hires h JOIN coach_rate_cards k ON k.id=h.rate_card_id WHERE k.specialisation_id=z.id AND h.status='completed') AS sessions_done,
              coalesce((SELECT sum(h.total_cents) FROM coach_hires h JOIN coach_rate_cards k ON k.id=h.rate_card_id WHERE k.specialisation_id=z.id AND h.status IN ('confirmed','completed') AND h.payment_status IN ('paid','not_required')), 0)::bigint AS income_cents,
              (SELECT round(avg(r.rating)::numeric, 2)::float8 FROM coach_reviews r JOIN coach_hires h ON h.id=r.hire_id JOIN coach_rate_cards k ON k.id=h.rate_card_id WHERE k.specialisation_id=z.id) AS rating
         FROM coach_specialisations z JOIN sports s ON s.id=z.sport_id WHERE z.coach_id=$1 AND z.archived_at IS NULL ORDER BY s.name, z.name`, [user.id]);
  },
});

cap({
  name: 'archive_coach_specialisation', method: 'DELETE', path: '/coach/specialisations/:id', tag: TAG, auth: COACH,
  summary: 'Archive a specialisation (kept, hidden). Rate cards that pointed at it keep working.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coach_specialisations SET archived_at=now() WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Specialisation');
    return r;
  },
});

// ----------------------------------------------------------------------------------------------- rate cards
const cardInput = {
  title: z.string().min(2).max(100), sport: z.string().nullable().optional(), specialisation_id: id.nullable().optional(),
  audience: z.enum(AUDIENCES).default('individual'), delivery: z.enum(['in_person', 'online', 'both']).default('in_person'),
  unit: z.enum(['hour', 'session', 'day', 'month', 'package']).default('hour'), price_cents: money, per_person: z.boolean().default(false),
  duration_min: z.number().int().min(15).max(1440).nullable().optional(), min_participants: z.number().int().min(1).max(500).default(1), max_participants: z.number().int().min(1).max(500).nullable().optional(),
  sessions_included: z.number().int().min(1).max(500).nullable().optional(), is_intro: z.boolean().default(false), description: z.string().max(600).nullable().optional(), active: z.boolean().default(true),
};

async function checkCard(user, v) {
  let sportId = null;
  if (v.sport) { const s = await sportBySlugOrId(v.sport); if (!s) throw badRequest('Unknown sport'); await coachesSport(user.id, s.id); sportId = s.id; }
  if (v.specialisation_id) await ownSpec(user.id, v.specialisation_id);
  if (v.max_participants && v.max_participants < v.min_participants) throw badRequest('Maximum participants is below the minimum');
  if (v.audience === 'individual' && (v.max_participants ?? 1) > 1) throw badRequest('An individual card is for one person — use a group card for more');
  if (v.unit !== 'hour' && !v.duration_min && v.unit !== 'month' && v.unit !== 'package') throw badRequest('Say how long a session or day is');
  if (v.unit === 'package' && !v.sessions_included) throw badRequest('A package needs the number of sessions it includes');
  return sportId;
}

cap({
  name: 'create_coach_rate_card', method: 'POST', path: '/coach/rate-cards', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach: add a rate card — a named price for one kind of work: an individual hour, a group session (optionally per person), a team day, an event engagement, a monthly retainer or a package, with an optional trial offer. Athletes, teams and organisers book from these.',
  input: z.object(cardInput),
  async handler({ user }, i) {
    const sportId = await checkCard(user, i);
    return one(
      `INSERT INTO coach_rate_cards(coach_id, sport_id, specialisation_id, title, audience, delivery, unit, price_cents, per_person, duration_min, min_participants, max_participants, sessions_included, is_intro, description, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [user.id, sportId, i.specialisation_id ?? null, i.title, i.audience, i.delivery, i.unit, i.price_cents, i.per_person, i.duration_min ?? null, i.min_participants, i.max_participants ?? null, i.sessions_included ?? null, i.is_intro, i.description ?? null, i.active]);
  },
});

cap({
  name: 'update_coach_rate_card', method: 'PATCH', path: '/coach/rate-cards/:id', tag: TAG, auth: COACH,
  summary: 'Coach: change a rate card, switch it on/off (`active`) or retire it (`archive: true`, kept so earlier sessions still point at it). A price change applies to new bookings only.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(cardInput).map(([k, v]) => [k, v.optional()])), archive: z.boolean().optional() }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM coach_rate_cards WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!cur) throw notFound('Rate card');
    if (i.archive) return one('UPDATE coach_rate_cards SET archived_at=now(), active=false WHERE id=$1 RETURNING *', [cur.id]);
    const v = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, x]) => x !== undefined && k !== 'id' && k !== 'archive')) };
    if (i.sport === undefined && cur.sport_id) v.sport = cur.sport_id;
    const sportId = await checkCard(user, { ...v, sport: v.sport ?? null });
    return one(
      `UPDATE coach_rate_cards SET sport_id=$2, specialisation_id=$3, title=$4, audience=$5, delivery=$6, unit=$7, price_cents=$8, per_person=$9, duration_min=$10, min_participants=$11, max_participants=$12, sessions_included=$13, is_intro=$14, description=$15, active=$16 WHERE id=$1 RETURNING *`,
      [cur.id, sportId, v.specialisation_id ?? null, v.title, v.audience, v.delivery, v.unit, v.price_cents, v.per_person, v.duration_min ?? null, v.min_participants, v.max_participants ?? null, v.sessions_included ?? null, v.is_intro, v.description ?? null, v.active]);
  },
});

cap({
  name: 'list_coach_rate_cards', method: 'GET', path: '/coach/rate-cards', tag: TAG, auth: COACH,
  summary: 'Your rate cards (live and switched off), each with how often it was booked and what it earned.',
  async handler({ user }) {
    const rows = await many(
      `SELECT k.*, s.slug AS sport_slug, s.name AS sport, z.name AS specialisation,
              (SELECT count(*)::int FROM coach_hires h WHERE h.rate_card_id=k.id AND h.status IN ('confirmed','completed')) AS bookings,
              coalesce((SELECT sum(h.total_cents) FROM coach_hires h WHERE h.rate_card_id=k.id AND h.status IN ('confirmed','completed') AND h.payment_status IN ('paid','not_required')), 0)::bigint AS income_cents
         FROM coach_rate_cards k LEFT JOIN sports s ON s.id=k.sport_id LEFT JOIN coach_specialisations z ON z.id=k.specialisation_id
        WHERE k.coach_id=$1 AND k.archived_at IS NULL ORDER BY k.active DESC, k.audience, k.price_cents`, [user.id]);
    return rows.map((r) => ({ ...r, currency: config.payments.currency }));
  },
});

// ----------------------------------------------------------------------------------------------- contracts & commitments
const commitmentInput = {
  kind: z.enum(['contract', 'retainer', 'team', 'event', 'personal', 'block']), title: z.string().min(2).max(120), sport: z.string().optional(),
  client_user_id: id.optional(), team_id: id.optional(), event_id: id.optional(), client_name: z.string().max(120).optional(), rate_card_id: id.optional(),
  fee_cents: money.optional(), fee_unit: z.enum(['session', 'month', 'total']).optional(),
  starts_on: day, ends_on: day.optional(), weekdays: z.array(weekday).max(7).default([]), start: z.string().describe('HH:MM local time'), duration_min: z.number().int().min(15).max(1440).default(60),
  timezone: z.string().max(60).optional(), notes: z.string().max(1000).optional(),
};

cap({
  name: 'create_coach_commitment', method: 'POST', path: '/coach/commitments', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach: record a contract, retainer, team season, event engagement, personal block or blocked time. A weekly pattern (weekdays + time) or a one-off date. It fills your schedule, blocks those times from athlete booking, and the reply lists clashes with sessions you already have.',
  input: z.object(commitmentInput),
  async handler({ user }, i) {
    const startMin = hhmm(i.start);
    if (Number.isNaN(startMin) || startMin >= 1440) throw badRequest('Start must be a time like 17:30');
    if (i.ends_on && i.ends_on < i.starts_on) throw badRequest('Ends before it starts');
    const prof = await loadCoachSchedule(user.id);
    const tz = i.timezone ?? prof.timezone;
    if (!validTimezone(tz)) throw badRequest('Unknown time zone');
    let sportId = null;
    if (i.sport) { const s = await sportBySlugOrId(i.sport); if (!s) throw badRequest('Unknown sport'); sportId = s.id; }
    if (i.team_id) { const t = await one('SELECT * FROM teams WHERE id=$1', [i.team_id]); if (!t) throw notFound('Team'); if (!(await canCoachTeam(user, t))) throw forbidden('You are not on this team\'s coaching staff'); }
    if (i.event_id && !(await one('SELECT 1 FROM events WHERE id=$1', [i.event_id]))) throw notFound('Event');
    if (i.client_user_id && !(await one('SELECT 1 FROM users WHERE id=$1', [i.client_user_id]))) throw notFound('Client');
    if (i.rate_card_id && !(await one('SELECT 1 FROM coach_rate_cards WHERE id=$1 AND coach_id=$2', [i.rate_card_id, user.id]))) throw notFound('Rate card');
    if (i.fee_cents != null && !i.fee_unit) throw badRequest('Say what the fee is for: per session, per month or in total');
    const row = await one(
      `INSERT INTO coach_commitments(coach_id, kind, title, sport_id, client_user_id, team_id, event_id, client_name, rate_card_id, fee_cents, fee_unit, starts_on, ends_on, weekdays, start_min, duration_min, timezone, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [user.id, i.kind, i.title, sportId, i.client_user_id ?? null, i.team_id ?? null, i.event_id ?? null, i.client_name ?? null, i.rate_card_id ?? null, i.fee_cents ?? null, i.fee_unit ?? null, i.starts_on, i.ends_on ?? null, [...new Set(i.weekdays)].sort(), startMin, i.duration_min, tz, i.notes ?? null]);
    return { ...plain(row), clashes: await clashesOf(user.id, plain(row)) };
  },
});

/** Sessions already on the calendar that this commitment overlaps in the next 8 weeks (a warning, not a block). */
async function clashesOf(coachId, c) {
  const from = c.starts_on > isoDate(new Date()) ? c.starts_on : isoDate(new Date()), to = addDays(from, 56);
  const mine = occurrences(c, from, to);
  if (!mine.length) return [];
  const hires = await many("SELECT id, starts_at, duration_min FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at >= $2::date AND starts_at < $3::date + 1", [coachId, from, to]);
  const others = (await many("SELECT * FROM coach_commitments WHERE coach_id=$1 AND status='active' AND id <> $2 AND starts_on <= $3::date AND (ends_on IS NULL OR ends_on >= $4::date)", [coachId, c.id, to, from])).map(plain);
  const out = [];
  for (const o of mine) {
    const a = +new Date(o.starts_at), b = +new Date(o.ends_at);
    for (const h of hires) if (a < +new Date(h.starts_at) + h.duration_min * 60_000 && +new Date(h.starts_at) < b) out.push({ on_date: o.on_date, with: 'session', id: h.id });
    for (const x of others) for (const y of occurrences(x, o.on_date, o.on_date)) if (a < +new Date(y.ends_at) && +new Date(y.starts_at) < b) out.push({ on_date: o.on_date, with: 'commitment', id: x.id });
  }
  return out;
}

cap({
  name: 'list_coach_commitments', method: 'GET', path: '/coach/commitments', tag: TAG, auth: COACH,
  summary: 'Your contracts and commitments with progress: sessions delivered, skipped, still to come and the next dates.',
  input: z.object({ status: z.enum(['active', 'paused', 'ended', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT c.*, s.slug AS sport_slug, s.name AS sport, t.name AS team_name, e.name AS event_name, u.display_name AS client_user_name, k.title AS rate_card_title
         FROM coach_commitments c LEFT JOIN sports s ON s.id=c.sport_id LEFT JOIN teams t ON t.id=c.team_id LEFT JOIN events e ON e.id=c.event_id LEFT JOIN users u ON u.id=c.client_user_id LEFT JOIN coach_rate_cards k ON k.id=c.rate_card_id
        WHERE c.coach_id=$1 AND ($2::text IS NULL OR c.status=$2) ORDER BY (c.status='active') DESC, c.starts_on DESC, c.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]);
    const log = await loggedMap(rows.map((r) => r.id));
    const today = isoDate(new Date());
    return rows.map((c) => {
      const cs = plain(c);
      const horizon = cs.ends_on ?? addDays(today, 120);
      const all = occurrences({ ...cs, status: cs.status === 'ended' ? 'ended' : 'active' }, cs.starts_on, horizon > addDays(cs.starts_on, 800) ? addDays(cs.starts_on, 800) : horizon, log);
      const done = [...log.values()].filter((l) => l.commitment_id === c.id);
      return {
        ...cs, currency: config.payments.currency,
        delivered: done.filter((l) => l.status === 'delivered').length, skipped: done.filter((l) => ['skipped', 'cancelled'].includes(l.status)).length,
        overdue: all.filter((o) => o.on_date < today && !o.logged).length, to_log: all.filter((o) => o.on_date < today && !o.logged).slice(-5).map((o) => o.on_date), upcoming: all.filter((o) => o.on_date >= today).slice(0, 3).map(({ on_date, starts_at, ends_at }) => ({ on_date, starts_at, ends_at })),
        scheduled_total: cs.ends_on ? all.length + done.filter((l) => ['skipped', 'cancelled'].includes(l.status)).length : null,
      };
    });
  },
});

cap({
  name: 'update_coach_commitment', method: 'PATCH', path: '/coach/commitments/:id', tag: TAG, auth: COACH,
  summary: 'Coach: pause, resume, end or cancel a commitment, change its end date, fee or notes. Nothing is deleted; delivered sessions stay on record.',
  input: z.object({ id, status: z.enum(['active', 'paused', 'ended', 'cancelled']).optional(), ends_on: day.nullable().optional(), fee_cents: money.nullable().optional(), fee_unit: z.enum(['session', 'month', 'total']).nullable().optional(), notes: z.string().max(1000).nullable().optional(), title: z.string().min(2).max(120).optional() }),
  async handler({ user }, i) {
    const cur = await one('SELECT * FROM coach_commitments WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!cur) throw notFound('Commitment');
    const v = (k) => (i[k] === undefined ? cur[k] : i[k]);
    const ends = v('ends_on') ? dbDate(v('ends_on')) : null;
    if (ends && ends < dbDate(cur.starts_on)) throw badRequest('Ends before it starts');
    if (cur.status === 'cancelled' && i.status && i.status !== 'cancelled') throw conflict('A cancelled commitment stays cancelled — create a new one');
    return plain(await one('UPDATE coach_commitments SET status=$2, ends_on=$3, fee_cents=$4, fee_unit=$5, notes=$6, title=$7 WHERE id=$1 RETURNING *', [cur.id, v('status'), ends, v('fee_cents'), v('fee_unit'), v('notes'), v('title')]));
  },
});

cap({
  name: 'log_coach_commitment_session', method: 'POST', path: '/coach/commitments/:id/log', tag: TAG, auth: COACH,
  summary: 'Coach: record what happened on a scheduled date of a commitment — delivered, skipped or cancelled — with an optional note. Skipped and cancelled dates leave the schedule; delivered ones count in reports. Logging the same date again corrects it.',
  input: z.object({ id, on_date: day, status: z.enum(['delivered', 'skipped', 'cancelled']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const c = await one('SELECT * FROM coach_commitments WHERE id=$1 AND coach_id=$2', [i.id, user.id]);
    if (!c) throw notFound('Commitment');
    const cs = { ...plain(c), status: 'active' };
    if (!occurrences(cs, i.on_date, i.on_date).length) throw badRequest('That date is not on this commitment\'s schedule');
    if (i.status === 'delivered' && i.on_date > isoDate(new Date(Date.now() + 864e5))) throw badRequest('You cannot mark a future session as delivered');
    return one('INSERT INTO coach_commitment_log(commitment_id, on_date, status, note) VALUES ($1,$2,$3,$4) ON CONFLICT (commitment_id, on_date) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, logged_at=now() RETURNING commitment_id, on_date, status, note', [c.id, i.on_date, i.status, i.note ?? null]);
  },
});

// ----------------------------------------------------------------------------------------------- testimonials
cap({
  name: 'coach_give_testimonial', method: 'POST', path: '/coach/athletes/:id/testimonial', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach: write (or update) a testimonial and 1-5 rating for an athlete you actively coach. It appears on their public profile like any testimonial. Needs a current coaching relationship.',
  input: z.object({ id, rating: z.number().int().min(1).max(5), body: z.string().min(3).max(1000) }),
  async handler({ user }, i) {
    if (i.id === user.id) throw badRequest('You cannot review yourself');
    await requireRelationship(user, i.id);
    const saved = await one("INSERT INTO testimonials(author_id, subject_type, subject_id, rating, body) VALUES ($1,'user',$2,$3,$4) ON CONFLICT (author_id, subject_type, subject_id) DO UPDATE SET rating=EXCLUDED.rating, body=EXCLUDED.body, created_at=now() RETURNING *", [user.id, i.id, i.rating, i.body]);
    await notify(null, i.id, { kind: 'testimonial_received', title: `${user.display_name} (your coach) wrote about you`, body: i.body.slice(0, 140), data: { testimonial_id: saved.id } });
    return saved;
  },
});

cap({
  name: 'list_coach_testimonials', method: 'GET', path: '/coach/testimonials', tag: TAG, auth: COACH,
  summary: 'Your testimonials. dir=received: reviews of you from athletes, teams and events you coached (with the session, your reply and whether it is pinned). dir=given: testimonials you wrote for athletes.',
  input: z.object({ dir: z.enum(['received', 'given']).default('received'), ...page }),
  async handler({ user }, i) {
    if (i.dir === 'given') return many("SELECT t.id, t.rating, t.body, t.created_at, u.id AS athlete_id, u.display_name AS athlete_name, u.avatar_emoji, u.avatar_color, u.avatar_url FROM testimonials t JOIN users u ON u.id=t.subject_id WHERE t.author_id=$1 AND t.subject_type='user' ORDER BY t.created_at DESC LIMIT $2 OFFSET $3", [user.id, i.limit, i.offset]);
    return many(
      `SELECT r.id, r.rating, r.body, r.reply, r.replied_at, r.pinned, r.created_at, a.display_name AS author_name, a.avatar_emoji, a.avatar_color, a.avatar_url, h.audience, h.starts_at AS session_at, s.name AS sport
         FROM coach_reviews r JOIN users a ON a.id=r.reviewer_id JOIN coach_hires h ON h.id=r.hire_id LEFT JOIN sports s ON s.id=h.sport_id WHERE r.coach_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'pin_coach_review', method: 'POST', path: '/coach-reviews/:id/pin', tag: TAG, auth: COACH,
  summary: 'Coach: pin up to 3 of your reviews to the top of your public profile, or unpin one.', input: z.object({ id, pinned: z.boolean() }),
  async handler({ user }, i) {
    const r = await one('SELECT id, coach_id FROM coach_reviews WHERE id=$1', [i.id]);
    if (!r) throw notFound('Review');
    if (r.coach_id !== user.id) throw forbidden('You can only pin reviews of you');
    if (i.pinned && (await one('SELECT count(*)::int AS n FROM coach_reviews WHERE coach_id=$1 AND pinned AND id <> $2', [user.id, r.id])).n >= 3) throw conflict('You can pin three reviews — unpin one first');
    return one('UPDATE coach_reviews SET pinned=$2 WHERE id=$1 RETURNING id, pinned', [r.id, i.pinned]);
  },
});

cap({
  name: 'request_coach_review', method: 'POST', path: '/hires/:id/request-review', tag: TAG, auth: COACH,
  summary: 'Coach: nudge the person who booked a completed session to review it. Once per session, and only while no review exists.', input: z.object({ id }),
  async handler({ user }, i) {
    const h = await one("SELECT h.*, u.display_name AS coach_name FROM coach_hires h JOIN users u ON u.id=h.coach_id WHERE h.id=$1 AND h.coach_id=$2", [i.id, user.id]);
    if (!h) throw notFound('Session');
    if (h.status !== 'completed') throw conflict('Only completed sessions can be reviewed');
    if (await one('SELECT 1 FROM coach_reviews WHERE hire_id=$1', [h.id])) throw conflict('Already reviewed');
    if (h.review_requested_at) throw conflict('You already asked for a review of this session');
    await one('UPDATE coach_hires SET review_requested_at=now() WHERE id=$1 RETURNING id', [h.id]);
    await notify(null, h.hirer_id, { kind: 'coach_review_request', title: `${h.coach_name} would value your review`, body: 'It takes ten seconds and helps other athletes choose.', data: { hire_id: h.id } });
    return { id: h.id, requested: true };
  },
});

// ----------------------------------------------------------------------------------------------- analytics + report
const range = (i) => {
  const to = i.to ?? isoDate(new Date()), from = i.from ?? addDays(to, -89);
  if (to < from) throw badRequest('to is before from');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw badRequest('Range is limited to 366 days');
  return { from, to };
};
const rangeInput = z.object({ from: day.optional(), to: day.optional() });
const SETTLED = "h.payment_status IN ('paid','not_required') AND h.status IN ('confirmed','completed')";

/** Money from commitments: per delivered session, or per calendar month touched by the range while active. */
async function commitmentFigures(coachId, from, to) {
  const cs = await many("SELECT * FROM coach_commitments WHERE coach_id=$1 AND status <> 'cancelled' AND starts_on <= $3::date AND (ends_on IS NULL OR ends_on >= $2::date)", [coachId, from, to]);
  const log = await loggedMap(cs.map((c) => c.id));
  const today = isoDate(new Date());
  let scheduled = 0, delivered = 0, minutes = 0, income = 0;
  for (const raw of cs) {
    const c = plain(raw);
    const occ = occurrences({ ...c, status: c.status === 'paused' ? 'active' : c.status }, from, to, log);
    const done = occ.filter((o) => o.logged?.status === 'delivered');
    scheduled += occ.length; minutes += occ.length * c.duration_min; delivered += done.length;
    if (c.fee_cents != null && c.kind !== 'block' && c.kind !== 'personal') {
      if (c.fee_unit === 'session') income += done.length * Number(c.fee_cents);
      else if (c.fee_unit === 'month') {
        const a = c.starts_on > from ? c.starts_on : from, b = c.ends_on && c.ends_on < to ? c.ends_on : to;
        income += new Set(dateRange(a, b > today ? today : b).map((d) => d.slice(0, 7))).size * Number(c.fee_cents);
      }
    }
  }
  return { active: cs.filter((c) => c.status === 'active').length, scheduled, delivered, minutes, income_cents: income };
}

cap({
  name: 'coach_analytics', method: 'GET', path: '/coach/analytics', tag: TAG, auth: COACH,
  summary: 'Coach: business analytics for a period (default last 90 days, max 366): sessions, hours, income, clients and repeat clients, ratings, cancellations, request win rate, utilisation of your open hours, and breakdowns by month, audience, sport, rate card and specialisation. Commitment income is separate from session income.',
  input: rangeInput,
  async handler({ user }, i) {
    const { from, to } = range(i);
    const W = [user.id, from, to];
    const inRange = 'h.coach_id=$1 AND h.starts_at >= $2::date AND h.starts_at < $3::date + 1';
    const [tot, months, byAudience, bySport, byCard, bySpec, ratings, ratingMonths, funnel, repeat, sched, cf, cancels] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE h.status='completed')::int AS sessions_completed, count(*) FILTER (WHERE h.status IN ('requested','confirmed'))::int AS sessions_open, count(*) FILTER (WHERE h.status='cancelled')::int AS sessions_cancelled,
                  coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents, coalesce(sum(h.total_cents) FILTER (WHERE h.payment_status='unpaid' AND h.status IN ('requested','confirmed')), 0)::bigint AS outstanding_cents,
                  coalesce(sum(h.duration_min) FILTER (WHERE h.status='completed'), 0)::int AS minutes_delivered, coalesce(sum(h.duration_min) FILTER (WHERE h.status IN ('confirmed','completed')), 0)::int AS minutes_booked,
                  count(DISTINCT h.hirer_id) FILTER (WHERE h.status IN ('confirmed','completed'))::int AS clients FROM coach_hires h WHERE ${inRange}`, W),
      many(`SELECT to_char(date_trunc('month', h.starts_at), 'YYYY-MM') AS month, count(*) FILTER (WHERE h.status='completed')::int AS sessions, coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents, coalesce(sum(h.duration_min) FILTER (WHERE h.status='completed'), 0)::int AS minutes FROM coach_hires h WHERE ${inRange} GROUP BY 1 ORDER BY 1`, W),
      many(`SELECT h.audience AS key, count(*) FILTER (WHERE h.status IN ('confirmed','completed'))::int AS sessions, coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents FROM coach_hires h WHERE ${inRange} GROUP BY 1 ORDER BY 3 DESC`, W),
      many(`SELECT coalesce(s.name, 'Other') AS key, count(*) FILTER (WHERE h.status IN ('confirmed','completed'))::int AS sessions, coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents FROM coach_hires h LEFT JOIN sports s ON s.id=h.sport_id WHERE ${inRange} GROUP BY 1 ORDER BY 3 DESC`, W),
      many(`SELECT coalesce(k.title, 'Standard hourly rate') AS key, count(*) FILTER (WHERE h.status IN ('confirmed','completed'))::int AS sessions, coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents FROM coach_hires h LEFT JOIN coach_rate_cards k ON k.id=h.rate_card_id WHERE ${inRange} GROUP BY 1 ORDER BY 3 DESC`, W),
      many(`SELECT coalesce(z.name, 'No specialisation') AS key, count(*) FILTER (WHERE h.status IN ('confirmed','completed'))::int AS sessions, coalesce(sum(h.total_cents) FILTER (WHERE ${SETTLED}), 0)::bigint AS income_cents FROM coach_hires h LEFT JOIN coach_rate_cards k ON k.id=h.rate_card_id LEFT JOIN coach_specialisations z ON z.id=k.specialisation_id WHERE ${inRange} GROUP BY 1 ORDER BY 3 DESC`, W),
      one('SELECT round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1', W),
      many("SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, round(avg(rating)::numeric, 2)::float8 AS avg, count(*)::int AS n FROM coach_reviews WHERE coach_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1 GROUP BY 1 ORDER BY 1", W),
      one("SELECT count(*)::int AS answered, count(*) FILTER (WHERE status='accepted')::int AS won, count(*) FILTER (WHERE status='declined')::int AS lost, count(*) FILTER (WHERE status='pending')::int AS pending FROM coach_request_responses WHERE coach_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1", W),
      one(`SELECT count(*)::int AS repeat_clients FROM (SELECT h.hirer_id FROM coach_hires h WHERE ${inRange} AND h.status IN ('confirmed','completed') GROUP BY 1 HAVING count(*) >= 2) x`, W),
      loadCoachSchedule(user.id),
      commitmentFigures(user.id, from, to),
      one(`SELECT count(*) FILTER (WHERE h.cancelled_by=h.coach_id)::int AS by_coach, count(*) FILTER (WHERE h.cancelled_by IS DISTINCT FROM h.coach_id)::int AS by_client FROM coach_hires h WHERE ${inRange} AND h.status='cancelled'`, W),
    ]);
    // utilisation: booked + committed minutes against the minutes of open hours in the period
    const perDay = new Map();
    for (const w of sched.windows) perDay.set(w.weekday, (perDay.get(w.weekday) ?? 0) + (w.end_min - w.start_min));
    const available = dateRange(from, to).reduce((n, d) => n + (perDay.get(new Date(`${d}T00:00:00Z`).getUTCDay()) ?? 0), 0);
    const busy = tot.minutes_booked + cf.minutes;
    const totalHires = tot.sessions_completed + tot.sessions_open + tot.sessions_cancelled;
    const money2 = (r) => r.map((x) => ({ ...x, income_cents: Number(x.income_cents) }));
    return {
      from, to, currency: config.payments.currency,
      totals: { ...tot, income_cents: Number(tot.income_cents), outstanding_cents: Number(tot.outstanding_cents), hours_delivered: Math.round((tot.minutes_delivered / 60) * 10) / 10, repeat_clients: repeat.repeat_clients, repeat_rate_pct: tot.clients ? Math.round((100 * repeat.repeat_clients) / tot.clients) : null, avg_session_cents: tot.sessions_completed ? Math.round(Number(tot.income_cents) / Math.max(1, tot.sessions_completed + tot.sessions_open)) : null },
      by_month: months.map((m) => ({ ...m, income_cents: Number(m.income_cents), hours: Math.round((m.minutes / 60) * 10) / 10 })),
      by_audience: money2(byAudience), by_sport: money2(bySport), by_rate_card: money2(byCard), by_specialisation: money2(bySpec),
      ratings: { avg: ratings.avg, count: ratings.n, by_month: ratingMonths },
      cancellations: { ...cancels, rate_pct: totalHires ? Math.round((100 * (cancels.by_coach + cancels.by_client)) / totalHires) : null },
      requests: { ...funnel, win_rate_pct: funnel.answered ? Math.round((100 * funnel.won) / funnel.answered) : null },
      utilisation: { available_hours: Math.round((available / 60) * 10) / 10, committed_hours: Math.round((busy / 60) * 10) / 10, pct: available ? Math.min(100, Math.round((100 * busy) / available)) : null, basis: 'booked sessions and scheduled commitments against your weekly open hours' },
      commitments: { active: cf.active, sessions_scheduled: cf.scheduled, sessions_delivered: cf.delivered, income_cents: cf.income_cents },
    };
  },
});

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@]/.test(s) ? `'${s}` : s; };

cap({
  name: 'coach_report', method: 'GET', path: '/coach/report', tag: TAG, auth: COACH,
  summary: 'Coach: a CSV statement of your sessions and delivered commitment sessions for a period (date, client, audience, sport, rate card, minutes, amount, payment, status) for your own accounts. Returns { filename, rows, csv }.',
  input: rangeInput,
  async handler({ user }, i) {
    const { from, to } = range(i);
    const hires = await many(
      `SELECT h.starts_at, h.audience, h.duration_min, h.total_cents, h.payment_status, h.status, a.display_name AS client, t.name AS team, e.name AS event, s.name AS sport, k.title AS card
         FROM coach_hires h JOIN users a ON a.id=h.hirer_id LEFT JOIN teams t ON t.id=h.team_id LEFT JOIN events e ON e.id=h.event_id LEFT JOIN sports s ON s.id=h.sport_id LEFT JOIN coach_rate_cards k ON k.id=h.rate_card_id
        WHERE h.coach_id=$1 AND h.starts_at >= $2::date AND h.starts_at < $3::date + 1 ORDER BY h.starts_at`, [user.id, from, to]);
    const cs = await many("SELECT c.*, s.name AS sport, t.name AS team, e.name AS event, u.display_name AS user_name FROM coach_commitments c LEFT JOIN sports s ON s.id=c.sport_id LEFT JOIN teams t ON t.id=c.team_id LEFT JOIN events e ON e.id=c.event_id LEFT JOIN users u ON u.id=c.client_user_id WHERE c.coach_id=$1 AND c.starts_on <= $3::date AND (c.ends_on IS NULL OR c.ends_on >= $2::date)", [user.id, from, to]);
    const log = await loggedMap(cs.map((c) => c.id));
    const lines = hires.map((h) => [isoDate(h.starts_at), 'Session', h.team ?? h.event ?? h.client, h.audience, h.sport ?? '', h.card ?? 'Standard hourly rate', h.duration_min, (Number(h.total_cents) / 100).toFixed(2), h.payment_status, h.status]);
    for (const raw of cs) {
      const c = plain(raw);
      for (const o of occurrences(c, from, to, log).filter((x) => x.logged?.status === 'delivered')) lines.push([o.on_date, `Commitment: ${c.title}`, c.team ?? c.event ?? c.user_name ?? c.client_name ?? '', c.kind, c.sport ?? '', '', c.duration_min, c.fee_unit === 'session' && c.fee_cents != null ? (Number(c.fee_cents) / 100).toFixed(2) : '', 'n/a', 'delivered']);
    }
    lines.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const head = ['Date', 'Type', 'Client', 'Audience', 'Sport', 'Rate card', 'Minutes', `Amount (${config.payments.currency})`, 'Payment', 'Status'];
    return { filename: `coaching-statement-${from}-to-${to}.csv`, rows: lines.length, csv: [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n') };
  },
});
