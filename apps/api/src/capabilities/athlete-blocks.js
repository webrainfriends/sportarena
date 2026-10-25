import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

const TAG = 'Athlete';
const KIND = z.enum(['recovery', 'gym', 'rest', 'other', 'travel']);
const COLS = 'id, kind, title, starts_at, ends_at, timezone, version, created_at';
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

cap({
  name: 'update_athlete_block', method: 'PATCH', path: '/me/blocks/:id', tag: TAG,
  summary: 'Move or change a personal block (kind, title, start, end, time zone), for example to resolve a conflict. Send the version you last saw; a stale version is refused (409) so two devices cannot overwrite each other.',
  input: z.object({ id, version: z.number().int().min(1), kind: KIND.optional(), title: z.string().trim().max(80).nullable().optional(), starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(), timezone: zone.optional() }),
  async handler({ user }, i) {
    const cur = await one(`SELECT ${COLS} FROM athlete_blocks WHERE id=$1 AND user_id=$2 AND status='active'`, [i.id, user.id]);
    if (!cur) throw notFound('Block');
    const next = { kind: i.kind ?? cur.kind, title: i.title === undefined ? cur.title : i.title || null, starts_at: i.starts_at ?? cur.starts_at, ends_at: i.ends_at ?? cur.ends_at, timezone: i.timezone ?? cur.timezone };
    if (Date.parse(next.ends_at) <= Date.parse(next.starts_at)) throw badRequest('ends_at must be after starts_at');
    if (Date.parse(next.ends_at) - Date.parse(next.starts_at) > 14 * 86400000) throw badRequest('A block can be at most 14 days long');
    const row = await one(`UPDATE athlete_blocks SET kind=$4, title=$5, starts_at=$6, ends_at=$7, timezone=$8, version=version+1, updated_at=now()
                            WHERE id=$1 AND user_id=$2 AND version=$3 AND status='active' RETURNING ${COLS}`,
      [i.id, user.id, i.version, next.kind, next.title, next.starts_at, next.ends_at, next.timezone]);
    if (!row) throw conflict('This block was changed elsewhere; reload and try again', { code: 'stale_version' });
    return row;
  },
});
