import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { paymentsEnabled, refundFor } from '../payments/service.js';

cap({
  name: 'list_coaches', method: 'GET', path: '/coaches', tag: 'Hire', auth: 'public', summary: 'Find coaches/trainers to hire, by sport, with their hourly rate.',
  input: z.object({ sport: z.string().optional(), q: z.string().optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT ${PUBLIC_USER}, p.level, p.position, p.experience_years, p.club, p.hourly_rate_cents, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji
         FROM sport_profiles p JOIN users u ON u.id=p.user_id JOIN sports s ON s.id=p.sport_id
        WHERE p.role='coach' AND ($1::uuid IS NULL OR p.sport_id=$1) AND ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%' OR u.handle ILIKE $2||'%')
        ORDER BY u.display_name LIMIT $3 OFFSET $4`, [sport?.id ?? null, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'hire_coach', method: 'POST', path: '/hires', tag: 'Hire', status: 201,
  summary: 'Request a coaching/training session. The price is the coach\'s hourly rate for the duration (payment is not charged in this MVP). The coach must confirm.',
  input: z.object({ coach_id: id, sport: z.string(), starts_at: z.string().datetime({ offset: true }), duration_min: z.number().int().min(15).max(480).default(60), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    if (i.coach_id === user.id) throw badRequest('You cannot hire yourself');
    const sport = await sportBySlugOrId(i.sport);
    const prof = sport && await one("SELECT hourly_rate_cents FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='coach'", [i.coach_id, sport.id]);
    if (!prof) throw badRequest('That person does not coach this sport');
    const clash = await one("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2", [i.coach_id, i.starts_at, i.duration_min]);
    if (clash) throw conflict('Coach is not free then');
    const rate = Number(prof.hourly_rate_cents ?? 0);
    const total = Math.round((rate * i.duration_min) / 60);
    return one('INSERT INTO coach_hires(hirer_id, coach_id, sport_id, starts_at, duration_min, rate_cents_hour, total_cents, note, payment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, coach_id, starts_at, duration_min, total_cents, status, payment_status',
      [user.id, i.coach_id, sport.id, i.starts_at, i.duration_min, rate, total, i.note, paymentsEnabled() && total > 0 ? 'unpaid' : 'not_required']);
  },
});

cap({
  name: 'list_my_hires', method: 'GET', path: '/hires', tag: 'Hire', summary: 'Coaching sessions you booked or were booked for.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT h.id, h.starts_at, h.duration_min, h.total_cents, h.note, h.status, h.payment_status, (h.hirer_id=$1) AS i_am_hirer, s.name AS sport, s.emoji AS sport_emoji, uh.display_name AS hirer_name, uc.display_name AS coach_name, (h.coach_id=$1) AS i_am_coach
       FROM coach_hires h JOIN users uh ON uh.id=h.hirer_id JOIN users uc ON uc.id=h.coach_id LEFT JOIN sports s ON s.id=h.sport_id
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
    return one('UPDATE coach_hires SET status=$2 WHERE id=$1 RETURNING id, status, payment_status', [i.id, i.status]);
  },
});
