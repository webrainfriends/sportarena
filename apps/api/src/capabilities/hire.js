import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { paymentsEnabled, refundFor } from '../payments/service.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { notify } from '../notify.js';
import { config } from '../config.js';
import { coachSlotOk } from '../coach-slots.js';
import { AUDIENCES, cardFor, clientFor, priceFor } from '../coach-pricing.js';
import { commitmentBusy } from '../coach-commitments.js';

const esc = (x) => (x ? x.replace(/[%_\\]/g, '\\$&') : null);

cap({
  name: 'list_coaches', method: 'GET', path: '/coaches', tag: 'Hire', auth: 'public',
  summary: 'Find coaches/trainers to hire. Filter by sport, name or speciality, city, online/in-person, hourly rate, minimum rating, verified credential and whether they publish open hours; sort by rating, rate, most sessions or name. Each row carries rating, review count, verification and next open slot hint.',
  input: z.object({
    sport: z.string().optional(), q: z.string().optional(), city: z.string().optional(), delivery: z.enum(['in_person', 'online']).optional(),
    max_rate_cents: z.coerce.number().int().min(0).optional(), min_rating: z.coerce.number().min(1).max(5).optional(),
    verified: z.coerce.boolean().optional(), has_hours: z.coerce.boolean().optional(), audience: z.enum(AUDIENCES).optional().describe('only coaches with a live rate card for this kind of client'), intro_offer: z.coerce.boolean().optional(),
    sort: z.enum(['rating', 'rate', 'sessions', 'name']).default('rating'), ...page,
  }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const order = { rating: 'rating DESC NULLS LAST, rating_count DESC, display_name', rate: 'hourly_rate_cents NULLS LAST, display_name', sessions: 'sessions_done DESC, display_name', name: 'display_name' }[i.sort];
    const rows = await many(
      `SELECT * FROM (
         SELECT ${PUBLIC_USER}, p.level, p.position, p.experience_years, p.club, p.hourly_rate_cents, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
                cp.headline, cp.tagline, cp.city, coalesce(cp.serves, '{individual}') AS serves, coalesce(cp.delivery, 'in_person') AS delivery, coalesce(cp.accepting, true) AS accepting, cp.specialties,
                (SELECT round(avg(r.rating)::numeric, 2)::float8 FROM coach_reviews r WHERE r.coach_id=u.id) AS rating,
                (SELECT count(*)::int FROM coach_reviews r WHERE r.coach_id=u.id) AS rating_count,
                (SELECT count(*)::int FROM coach_hires h WHERE h.coach_id=u.id AND h.status='completed') AS sessions_done,
                EXISTS (SELECT 1 FROM verification_cases v WHERE v.subject_type='user' AND v.subject_id=u.id AND v.type='coach' AND v.status='approved' AND v.expires_at > now()) AS credential_verified,
                EXISTS (SELECT 1 FROM coach_availability a WHERE a.coach_id=u.id AND a.removed_at IS NULL) AS has_hours,
                EXISTS (SELECT 1 FROM coach_rate_cards k WHERE k.coach_id=u.id AND k.archived_at IS NULL AND k.active AND k.is_intro AND (k.sport_id IS NULL OR k.sport_id=p.sport_id)) AS has_intro,
                coalesce((SELECT array_agg(DISTINCT k.audience) FROM coach_rate_cards k WHERE k.coach_id=u.id AND k.archived_at IS NULL AND k.active AND (k.sport_id IS NULL OR k.sport_id=p.sport_id)), '{}') AS audiences
           FROM sport_profiles p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id LEFT JOIN coach_profiles cp ON cp.user_id=u.id
          WHERE p.role='coach' AND ${NOT_YOUTH_SQL} AND coalesce(cp.listed, true) AND ($1::uuid IS NULL OR p.sport_id=$1)
            AND ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%' OR u.handle ILIKE $2||'%' OR cp.headline ILIKE '%'||$2||'%' OR EXISTS (SELECT 1 FROM unnest(cp.specialties) z WHERE z ILIKE '%'||$2||'%') OR cp.tagline ILIKE '%'||$2||'%' OR EXISTS (SELECT 1 FROM coach_specialisations z WHERE z.coach_id=u.id AND z.archived_at IS NULL AND z.name ILIKE '%'||$2||'%'))
            AND ($3::text IS NULL OR cp.city ILIKE $3)
            AND ($4::text IS NULL OR coalesce(cp.delivery, 'in_person') IN ($4, 'both'))
       ) q
       WHERE ($5::bigint IS NULL OR q.hourly_rate_cents <= $5) AND ($6::numeric IS NULL OR q.rating >= $6) AND (NOT $7 OR q.credential_verified) AND (NOT $8 OR q.has_hours) AND ($9::text IS NULL OR $9 = ANY(q.audiences)) AND (NOT $10 OR q.has_intro)
       ORDER BY ${order} LIMIT $11 OFFSET $12`,
      [sport?.id ?? null, esc(i.q) ?? null, esc(i.city) ?? null, i.delivery ?? null, i.max_rate_cents ?? null, i.min_rating ?? null, !!i.verified, !!i.has_hours, i.audience ?? null, !!i.intro_offer, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, currency: config.payments.currency }));
  },
});

cap({
  name: 'hire_coach', method: 'POST', path: '/hires', tag: 'Hire', status: 201,
  summary: 'Request a coaching session. Without a rate card the price is the coach\'s hourly rate for the duration (individual, one person). With `rate_card_id` the price, session length and audience come from that card, for an individual, a group, a team you manage (`team_id`) or your event (`event_id`). The coach must confirm; payment confirms an answer-based booking.',
  input: z.object({
    coach_id: id, sport: z.string().optional(), starts_at: z.string().datetime({ offset: true }), duration_min: z.number().int().min(15).max(1440).optional(), note: z.string().max(500).optional(),
    rate_card_id: id.optional(), participants: z.number().int().min(1).max(500).default(1), team_id: id.optional(), event_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (i.coach_id === user.id) throw badRequest('You cannot hire yourself');
    const card = i.rate_card_id ? await cardFor(i.coach_id, i.rate_card_id, { participants: i.participants }) : null;
    const sport = await sportBySlugOrId(i.sport ?? card?.sport_id ?? '');
    if (!sport) throw badRequest('Choose a sport');
    if (card?.sport_id && card.sport_id !== sport.id) throw badRequest('That rate card is for a different sport');
    const prof = await one("SELECT hourly_rate_cents FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [i.coach_id, sport.id]);
    if (!prof) throw badRequest('That person does not coach this sport');
    const audience = card?.audience ?? 'individual';
    const mins = card && card.unit !== 'hour' ? card.duration_min ?? i.duration_min ?? 60 : i.duration_min ?? card?.duration_min ?? 60;
    if (!card && mins > 480) throw badRequest('Choose a rate card for sessions longer than 8 hours');
    if (audience === 'individual' && !card && i.participants > 1) throw badRequest('Choose a group rate card for more than one person');
    const client = await clientFor(user, { audience, team_id: i.team_id, event_id: i.event_id });
    if ((await one('SELECT accepting FROM coach_profiles WHERE user_id=$1', [i.coach_id]))?.accepting === false) throw badRequest('This coach is not taking new athletes right now');
    const grid = await coachSlotOk(i.coach_id, i.starts_at, mins);
    if (grid.grid && !grid.ok) throw conflict("That time is not one of the coach's open slots");
    const clash = await one("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2", [i.coach_id, i.starts_at, mins]);
    if (clash) throw conflict('Coach is not free then');
    const start = new Date(i.starts_at);
    if ((await commitmentBusy(i.coach_id, start, new Date(+start + mins * 60_000))).length) throw conflict('The coach has another commitment then');
    const total = card ? priceFor(card, mins, i.participants) : Math.round((Number(prof.hourly_rate_cents ?? 0) * mins) / 60);
    const rate = card ? Math.round((total * 60) / mins) : Number(prof.hourly_rate_cents ?? 0);
    const hire = await one('INSERT INTO coach_hires(hirer_id, coach_id, sport_id, starts_at, duration_min, rate_cents_hour, total_cents, note, payment_status, audience, participants, team_id, event_id, rate_card_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, coach_id, starts_at, duration_min, total_cents, status, payment_status, audience, participants',
      [user.id, i.coach_id, sport.id, i.starts_at, mins, rate, total, i.note, paymentsEnabled() && total > 0 ? 'unpaid' : 'not_required', audience, i.participants, client.team_id, client.event_id, card?.id ?? null]);
    await notify(null, i.coach_id, { kind: 'coach_hire_request', title: `${client.name ?? user.display_name} wants a ${sport.name} ${audience === 'individual' ? 'session' : `${audience} booking`}`, body: hire.payment_status === 'unpaid' ? 'Waiting for their payment, then you can confirm.' : 'Open your coach desk to confirm.', data: { hire_id: hire.id } });
    return hire;
  },
});

cap({
  name: 'list_my_hires', method: 'GET', path: '/hires', tag: 'Hire', summary: 'Coaching sessions you booked or were booked for.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT h.id, h.starts_at, h.duration_min, h.total_cents, h.note, h.status, h.payment_status, (h.hirer_id=$1) AS i_am_hirer, s.name AS sport, s.emoji AS sport_emoji, uh.display_name AS hirer_name, uc.display_name AS coach_name, (h.coach_id=$1) AS i_am_coach, h.coach_id, h.hirer_id, h.duration_min, h.rate_cents_hour, h.completed_at, s.slug AS sport_slug, r.id AS review_id, r.rating AS review_rating, (h.request_response_id IS NOT NULL) AS from_request, h.audience, h.participants, h.team_id, h.event_id, h.review_requested_at
       FROM coach_hires h LEFT JOIN coach_reviews r ON r.hire_id=h.id JOIN users uh ON uh.id=h.hirer_id JOIN users uc ON uc.id=h.coach_id LEFT JOIN sports s ON s.id=h.sport_id
      WHERE h.hirer_id=$1 OR h.coach_id=$1 ORDER BY h.starts_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'update_hire', method: 'PATCH', path: '/hires/:id', tag: 'Hire', summary: 'Coach confirms (once the session is paid) and completes; either party can cancel — a paid session is refunded.',
  input: z.object({ id, status: z.enum(['confirmed', 'completed', 'cancelled']) }),
  async handler({ user }, i) {
    const h = await mustFind('coach_hires', i.id);
    const isCoach = h.coach_id === user.id, isHirer = h.hirer_id === user.id;
    if (!isCoach && !isHirer && !isAdmin(user)) throw forbidden();
    if (i.status !== 'cancelled' && !isCoach) throw forbidden('Only the coach can confirm or complete');
    if (['completed', 'cancelled'].includes(h.status)) throw conflict(`Already ${h.status}`);
    if (i.status === 'confirmed' && h.payment_status === 'unpaid') throw conflict('Waiting for the hirer to pay');
    if (i.status === 'cancelled' && h.payment_status === 'paid') {
      await refundFor('coach_hire', h.id);
      await one("UPDATE coach_hires SET payment_status='refunded' WHERE id=$1", [h.id]);
    }
    const out = await one("UPDATE coach_hires SET status=$2, completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END, cancelled_by=CASE WHEN $2='cancelled' THEN $3::uuid ELSE cancelled_by END WHERE id=$1 RETURNING id, status, payment_status", [i.id, i.status, user.id]);
    const other = isCoach ? h.hirer_id : h.coach_id;
    const verb = { confirmed: 'confirmed your coaching session', completed: 'marked your session complete — leave a review', cancelled: 'cancelled the coaching session' }[i.status];
    if (other !== user.id) await notify(null, other, { kind: `coach_hire_${i.status}`, title: `${user.display_name} ${verb}`, body: '', data: { hire_id: h.id } });
    return out;
  },
});
