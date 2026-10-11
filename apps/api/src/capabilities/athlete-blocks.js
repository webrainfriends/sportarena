import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';

const TAG = 'Athlete';
const KIND = z.enum(['recovery', 'gym', 'rest', 'other']);
const COLS = 'id, kind, title, starts_at, ends_at, timezone, created_at';
const zone = z.string().max(64).refine((z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }, 'Unknown time zone');

// Personal time the athlete sets aside (recovery, gym, rest). It lands on the same calendar as matches and training
// (get_my_sport_schedule, kind "recovery"), so overlaps are flagged there. Only a kind and an optional short title are kept.
cap({
  name: 'create_athlete_block', method: 'POST', path: '/me/blocks', tag: TAG, status: 201,
  summary: 'Block out personal time on your calendar: a recovery session, gym time or a rest window. It shows on your schedule and is flagged if it overlaps a match or training.',
  input: z.object({ kind: KIND, title: z.string().trim().max(80).optional(), starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }), timezone: zone.default('UTC') }),
  async handler({ user }, i) {
    if (Date.parse(i.ends_at) <= Date.parse(i.starts_at)) throw badRequest('ends_at must be after starts_at');
    if (Date.parse(i.ends_at) - Date.parse(i.starts_at) > 14 * 86400000) throw badRequest('A block can be at most 14 days long');
    return one(`INSERT INTO athlete_blocks(user_id, kind, title, starts_at, ends_at, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
      [user.id, i.kind, i.title || null, i.starts_at, i.ends_at, i.timezone]);
  },
});

cap({
  name: 'list_athlete_blocks', method: 'GET', path: '/me/blocks', tag: TAG,
  summary: 'Your personal calendar blocks (recovery, gym, rest) in a date range, soonest first. Archived blocks are not listed.',
  input: z.object({ from: z.string().date().optional(), to: z.string().date().optional() }),
  handler: ({ user }, i) => many(
    `SELECT ${COLS} FROM athlete_blocks WHERE user_id=$1 AND status='active' AND ends_at >= coalesce($2::date, '-infinity'::date) AND starts_at < coalesce($3::date + 1, 'infinity'::date) ORDER BY starts_at LIMIT 500`,
    [user.id, i.from ?? null, i.to ?? null]),
});

cap({
  name: 'archive_athlete_block', method: 'POST', path: '/me/blocks/:id/archive', tag: TAG,
  summary: 'Remove a personal block from your calendar. It is archived, not deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one(`UPDATE athlete_blocks SET status='archived', archived_at=now() WHERE id=$1 AND user_id=$2 AND status='active' RETURNING id, status, archived_at`, [i.id, user.id]);
    if (!row) throw notFound('Block');
    return row;
  },
});
