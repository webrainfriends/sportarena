// Venue + coach services. A venue and a coach agree a tie-up (in-house staff or an independent coach) and keep a shared roster of
// coaching slots. Either side proposes; the other side agrees, amends (a counter-proposal that hands the turn back) or rejects, and
// either side can cancel. An agreed slot holds the court (a venue block) and the coach's time. Nothing is deleted: every move is kept in
// venue_coach_events and a finished tie or slot keeps its row.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { notify, venueTeam } from '../notify.js';
import { blockedBy, canManage, lockResource, mustManage, usedUnits } from '../booking/engine.js';
import { commitmentBusy } from '../coach-commitments.js';
import { expandDates, patternFields } from '../recurrence.js';
import { fromLocal, hhmm, validTimezone } from '../booking/time.js';
import { encrypt, decrypt } from '../crypto.js';
import { isYouth } from '../youth.js';

const TAG = 'Venue coaches';
const NOTE = 'venue_coach.note';
const terms = {
  kind: z.enum(['staff', 'independent']).optional(), pay_model: z.enum(['revenue_share', 'flat_fee', 'staff']).optional(),
  share_bp: z.number().int().min(0).max(10000).optional().describe("the coach's share of a coached session, in basis points"), flat_fee_cents: z.number().int().min(0).optional(),
  sports: z.array(z.string().min(1).max(60)).max(30).optional().describe('sport slugs the tie covers; empty = every sport the coach coaches'),
};

// ---------------------------------------------------------------- who is who
const isCoach = async (userId, c) => !!(await c.query("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role='coach' LIMIT 1", [userId])).rows.length;
const sidesOf = async (user, row, c) => ({ venue: await canManage(user, row.venue_id, c), coach: row.coach_id === user.id });
/** The side the caller acts for. A caller who is both (an owner who also coaches) can act for either, so they pick via `proposed_by` semantics. */
const mayAnswer = (s, row) => (row.proposed_by === 'venue' ? s.coach : s.venue);
const sideName = (s, prefer) => (s[prefer] ? prefer : s.venue ? 'venue' : 'coach');
const log = (c, type, subjectId, action, user, side, from, to, detail, reason) => c.query(
  'INSERT INTO venue_coach_events(subject_type, subject_id, action, actor_id, side, from_status, to_status, detail, reason_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [type, subjectId, action, user?.id ?? null, side, from, to, detail ? JSON.stringify(detail) : null, reason?.trim() ? encrypt(reason.trim(), NOTE) : null]);
const tellOther = async (c, row, side, msg) => {
  const to = side === 'venue' ? [row.coach_id] : await venueTeam(c, row.venue_id);
  for (const u of to) await notify(c, u, msg);
};
const venueName = async (c, venueId) => (await c.query('SELECT name FROM venues WHERE id=$1', [venueId])).rows[0]?.name ?? 'the venue';

async function sportIds(list) {
  const out = [];
  for (const s of list ?? []) { const sp = await sportBySlugOrId(s); if (!sp) throw badRequest(`Unknown sport: ${s}`); out.push(sp.id); }
  return out;
}
function checkTerms(t) {
  const model = t.pay_model ?? (t.kind === 'staff' ? 'staff' : 'revenue_share');
  if (model === 'revenue_share' && t.share_bp == null) throw badRequest("Say the coach's share of each session");
  if (model === 'flat_fee' && t.flat_fee_cents == null) throw badRequest('Say the flat fee');
  return model;
}
const tieView = (r) => ({ ...r, note: decrypt(r.note_enc, NOTE), note_enc: undefined });
const slotView = (r) => ({ ...r, note: decrypt(r.note_enc, NOTE), note_enc: undefined });

// ---------------------------------------------------------------- ties
cap({
  name: 'propose_venue_coach_tie', method: 'POST', path: '/venue-coach-ties', tag: TAG, status: 201,
  summary: 'Propose a tie-up between a venue and a coach. A venue manager proposes to a coach (`coach_id`); a coach proposes to a venue (their own id is used). The other side agrees, amends or rejects. `kind`: in-house `staff` or an `independent` coach; terms are a revenue share or a flat fee.',
  input: z.object({ venue_id: id, coach_id: id.optional(), kind: z.enum(['staff', 'independent']), ...terms, note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const venueSide = await canManage(user, i.venue_id, c);
      if (venueSide && !i.coach_id) throw badRequest('Choose the coach');
      const coachId = venueSide ? i.coach_id : user.id;
      if (!venueSide && !(await one('SELECT 1 FROM venues WHERE id=$1', [i.venue_id]))) throw notFound('Venue');
      if (!(await isCoach(coachId, c))) throw badRequest('That person is not a coach');
      if (await isYouth(coachId, c)) throw badRequest('That person cannot take on venue work');
      const model = checkTerms(i), side = venueSide ? 'venue' : 'coach';
      const sports = await sportIds(i.sports);
      let tie;
      try {
        tie = (await c.query(
          `INSERT INTO venue_coach_ties(venue_id, coach_id, kind, proposed_by, pay_model, share_bp, flat_fee_cents, sport_ids, note_enc, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [i.venue_id, coachId, i.kind, side, model, i.share_bp ?? null, i.flat_fee_cents ?? null, sports, i.note ? encrypt(i.note, NOTE) : null, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('There is already an open or agreed tie-up between this venue and coach'); throw e; }
      await log(c, 'tie', tie.id, 'propose', user, side, null, 'proposed', { kind: i.kind, pay_model: model, share_bp: i.share_bp, flat_fee_cents: i.flat_fee_cents, sports: i.sports });
      await tellOther(c, tie, side, { kind: 'venue_coach_tie', title: `${await venueName(c, tie.venue_id)}: tie-up proposed`, body: 'Open Coaches to agree, amend or reject.', data: { tie_id: tie.id, venue_id: tie.venue_id } });
      return tieView(tie);
    });
  },
});

cap({
  name: 'respond_venue_coach_tie', method: 'POST', path: '/venue-coach-ties/:id/respond', tag: TAG,
  summary: 'Answer an open tie-up proposal from the other side: `agree`, `reject`, or `amend` (change the terms; the turn goes back to the other side). You cannot answer your own proposal.',
  input: z.object({ id, decision: z.enum(['agree', 'reject', 'amend']), ...terms, reason: z.string().max(500).optional(), expected_version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM venue_coach_ties WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Tie-up');
      const s = await sidesOf(user, t, c);
      if (!s.venue && !s.coach) throw notFound('Tie-up');
      if (t.status !== 'proposed') throw conflict(`This tie-up is already ${t.status}`);
      if (i.expected_version != null && i.expected_version !== t.row_version) throw conflict('This proposal changed; reload and look again');
      if (!mayAnswer(s, t)) throw forbidden('The other side answers your proposal');
      const side = t.proposed_by === 'venue' ? 'coach' : 'venue';
      if (i.decision === 'amend') {
        const next = { kind: i.kind ?? t.kind, pay_model: i.pay_model ?? t.pay_model, share_bp: i.share_bp ?? t.share_bp, flat_fee_cents: i.flat_fee_cents ?? t.flat_fee_cents };
        if (next.kind === t.kind && next.pay_model === t.pay_model && next.share_bp === t.share_bp && next.flat_fee_cents === t.flat_fee_cents && !i.sports) throw badRequest('Change at least one term to amend');
        const model = checkTerms(next);
        const sports = i.sports ? await sportIds(i.sports) : t.sport_ids;
        await c.query('UPDATE venue_coach_ties SET kind=$2, pay_model=$3, share_bp=$4, flat_fee_cents=$5, sport_ids=$6, proposed_by=$7, row_version=row_version+1 WHERE id=$1',
          [t.id, next.kind, model, next.share_bp ?? null, next.flat_fee_cents ?? null, sports, side]);
        await log(c, 'tie', t.id, 'amend', user, side, 'proposed', 'proposed', { ...next, sports: i.sports }, i.reason);
        await tellOther(c, { ...t, proposed_by: side }, side, { kind: 'venue_coach_tie', title: `${await venueName(c, t.venue_id)}: tie-up amended`, body: 'New terms are waiting for your answer.', data: { tie_id: t.id, venue_id: t.venue_id } });
      } else {
        const to = i.decision === 'agree' ? 'agreed' : 'rejected';
        await c.query('UPDATE venue_coach_ties SET status=$2, decided_at=now(), decided_by=$3, row_version=row_version+1 WHERE id=$1', [t.id, to, user.id]);
        await log(c, 'tie', t.id, i.decision, user, side, 'proposed', to, null, i.reason);
        await tellOther(c, t, side, { kind: 'venue_coach_tie', title: `${await venueName(c, t.venue_id)}: tie-up ${to}`, body: '', data: { tie_id: t.id, venue_id: t.venue_id } });
      }
      return tieView((await c.query('SELECT * FROM venue_coach_ties WHERE id=$1', [t.id])).rows[0]);
    });
  },
});

/** Cancel the slots of a tie (kept, status cancelled) and free the courts they were holding. */
async function cancelSlotRows(c, rows, user, side, reason) {
  for (const r of rows) {
    await c.query("UPDATE venue_coach_slots SET status='cancelled', decided_at=now(), row_version=row_version+1 WHERE id=$1", [r.id]);
    if (r.block_id) await c.query('UPDATE venue_blocks SET released_at=now() WHERE batch_id=$1 AND released_at IS NULL', [r.block_id]);
    await log(c, 'slot', r.id, 'cancel', user, side, r.status, 'cancelled', null, reason);
  }
}

cap({
  name: 'cancel_venue_coach_tie', method: 'POST', path: '/venue-coach-ties/:id/cancel', tag: TAG,
  summary: 'Either side ends a tie-up (or withdraws its own open proposal). Its upcoming roster slots are cancelled too and the courts they held are freed. History is kept.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM venue_coach_ties WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Tie-up');
      const s = await sidesOf(user, t, c);
      if (!s.venue && !s.coach) throw notFound('Tie-up');
      if (!['proposed', 'agreed'].includes(t.status)) throw conflict(`This tie-up is already ${t.status}`);
      const side = sideName(s, t.proposed_by === 'venue' ? 'venue' : 'coach');
      await c.query("UPDATE venue_coach_ties SET status='cancelled', ended_at=now(), decided_at=now(), decided_by=$2, row_version=row_version+1 WHERE id=$1", [t.id, user.id]);
      await log(c, 'tie', t.id, 'cancel', user, side, t.status, 'cancelled', null, i.reason);
      const slots = (await c.query("SELECT * FROM venue_coach_slots WHERE tie_id=$1 AND status IN ('proposed','agreed') AND ends_at > now() FOR UPDATE", [t.id])).rows;
      await cancelSlotRows(c, slots, user, side, i.reason ?? 'tie-up ended');
      await tellOther(c, t, side, { kind: 'venue_coach_tie', title: `${await venueName(c, t.venue_id)}: tie-up ended`, body: slots.length ? `${slots.length} upcoming roster slot(s) were cancelled.` : '', data: { tie_id: t.id, venue_id: t.venue_id } });
      return { id: t.id, status: 'cancelled', cancelled_slots: slots.length };
    });
  },
});

cap({
  name: 'list_venue_coach_ties', method: 'GET', path: '/venue-coach-ties', tag: TAG,
  summary: 'Tie-ups. With `venue_id` (venue team only): that venue\'s coaches. Without: your own tie-ups as a coach. Includes whose turn it is (`waiting_on`).',
  input: z.object({ venue_id: id.optional(), status: z.enum(['proposed', 'agreed', 'rejected', 'cancelled']).optional() }),
  async handler({ user }, i) {
    if (i.venue_id) await mustManage(user, i.venue_id);
    const rows = await many(
      `SELECT t.*, u.display_name AS coach_name, u.avatar_emoji, u.avatar_color, u.avatar_url, v.name AS venue_name
         FROM venue_coach_ties t JOIN users u ON u.id=t.coach_id JOIN venues v ON v.id=t.venue_id
        WHERE ($1::uuid IS NULL OR t.venue_id=$1) AND ($1::uuid IS NOT NULL OR t.coach_id=$2) AND ($3::text IS NULL OR t.status=$3)
        ORDER BY t.created_at DESC, t.id LIMIT 200`, [i.venue_id ?? null, user.id, i.status ?? null]);
    return rows.map((r) => ({ ...tieView(r), waiting_on: r.status === 'proposed' ? (r.proposed_by === 'venue' ? 'coach' : 'venue') : null }));
  },
});

// ---------------------------------------------------------------- roster slots
cap({
  name: 'propose_coach_roster_slots', method: 'POST', path: '/venue-coach-slots', tag: TAG, status: 201,
  summary: 'Propose coaching slots on the shared roster: one date, a weekly pattern or custom dates, at a time of day for `duration_min`, optionally on a fixed court. A venue manager proposes for a coach (`coach_id`); a coach proposes to a venue. Slots are linked to an agreed tie-up when there is one; otherwise this is an ad-hoc request. Times are in `timezone` (default: the venue\'s).',
  input: z.object({
    venue_id: id, coach_id: id.optional(), sport: z.string().max(60).optional(), resource_id: id.optional(), start: z.string().describe('HH:MM local time'), duration_min: z.number().int().min(15).max(480),
    ...patternFields, timezone: z.string().max(60).optional(), price_cents: z.number().int().min(0).optional(), note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const venue = (await c.query('SELECT id, name, timezone FROM venues WHERE id=$1', [i.venue_id])).rows[0];
      if (!venue) throw notFound('Venue');
      const venueSide = await canManage(user, i.venue_id, c);
      if (venueSide && !i.coach_id) throw badRequest('Choose the coach');
      const coachId = venueSide ? i.coach_id : user.id;
      if (!(await isCoach(coachId, c))) throw badRequest('That person is not a coach');
      const side = venueSide ? 'venue' : 'coach';
      const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
      if (i.sport && !sport) throw badRequest('Unknown sport');
      if (i.resource_id && !(await c.query('SELECT 1 FROM resources WHERE id=$1 AND venue_id=$2', [i.resource_id, i.venue_id])).rows.length) throw badRequest('That court is not at this venue');
      const startMin = hhmm(i.start);
      if (Number.isNaN(startMin) || startMin >= 1440) throw badRequest('Start must be a time like 17:30');
      const tz = i.timezone ?? venue.timezone;
      if (!validTimezone(tz)) throw badRequest('Unknown time zone');
      const tie = (await c.query("SELECT * FROM venue_coach_ties WHERE venue_id=$1 AND coach_id=$2 AND status='agreed'", [i.venue_id, coachId])).rows[0] ?? null;
      if (tie && sport && tie.sport_ids.length && !tie.sport_ids.includes(sport.id)) throw badRequest('That sport is not covered by the tie-up');
      const dates = expandDates(i);
      if (!dates.length) throw badRequest('Pick at least one date');
      const seriesId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id, out = [];
      for (const d of dates) {
        const starts = fromLocal(d, startMin, tz);
        if (starts <= new Date()) throw badRequest(`${d} is in the past`);
        const row = (await c.query(
          `INSERT INTO venue_coach_slots(tie_id, venue_id, coach_id, sport_id, resource_id, starts_at, ends_at, proposed_by, price_cents, note_enc, series_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [tie?.id ?? null, i.venue_id, coachId, sport?.id ?? null, i.resource_id ?? null, starts, new Date(+starts + i.duration_min * 60_000), side, i.price_cents ?? null, i.note ? encrypt(i.note, NOTE) : null, seriesId, user.id])).rows[0];
        await log(c, 'slot', row.id, 'propose', user, side, null, 'proposed', { starts_at: row.starts_at, ends_at: row.ends_at, resource_id: i.resource_id, price_cents: i.price_cents });
        out.push(slotView(row));
      }
      await tellOther(c, { venue_id: i.venue_id, coach_id: coachId }, side, { kind: 'venue_coach_slot', title: `${venue.name}: ${out.length === 1 ? 'a coaching slot' : `${out.length} coaching slots`} proposed`, body: 'Open Coaches to agree, amend or reject.', data: { venue_id: i.venue_id, series_id: seriesId } });
      return { series_id: seriesId, tie_id: tie?.id ?? null, slots: out };
    });
  },
});

/** The coach and the court must both be free; checked under locks when a slot is agreed. */
async function assertFree(c, s) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coach:${s.coach_id}`]);
  if (s.resource_id) await lockResource(c, s.resource_id);
  const mine = (await c.query("SELECT 1 FROM venue_coach_slots WHERE coach_id=$1 AND status='agreed' AND id<>$2 AND starts_at < $4 AND ends_at > $3 LIMIT 1", [s.coach_id, s.id, s.starts_at, s.ends_at])).rows.length;
  const hire = (await c.query("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2 LIMIT 1", [s.coach_id, s.starts_at, s.ends_at])).rows.length;
  if (mine || hire || (await commitmentBusy(s.coach_id, new Date(s.starts_at), new Date(s.ends_at))).length) throw conflict('The coach is not free then');
  if (s.resource_id) {
    if (await blockedBy(c, s.venue_id, s.resource_id, s.starts_at, s.ends_at)) throw conflict('The court is blocked then');
    if (await usedUnits(c, s.resource_id, s.starts_at, s.ends_at)) throw conflict('The court is already booked then');
  }
}

cap({
  name: 'respond_coach_roster_slot', method: 'POST', path: '/venue-coach-slots/:id/respond', tag: TAG,
  summary: 'Answer an open roster slot from the other side: `agree` (checks the coach and the court are free, then holds the court), `reject`, or `amend` (change time, court or price; the turn goes back). You cannot answer your own proposal.',
  input: z.object({ id, decision: z.enum(['agree', 'reject', 'amend']), starts_at: z.string().datetime({ offset: true }).optional(), duration_min: z.number().int().min(15).max(480).optional(), resource_id: id.nullable().optional(), price_cents: z.number().int().min(0).nullable().optional(), reason: z.string().max(500).optional(), expected_version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM venue_coach_slots WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Slot');
      const s = await sidesOf(user, r, c);
      if (!s.venue && !s.coach) throw notFound('Slot');
      if (r.status !== 'proposed') throw conflict(`This slot is already ${r.status}`);
      if (i.expected_version != null && i.expected_version !== r.row_version) throw conflict('This proposal changed; reload and look again');
      if (!mayAnswer(s, r)) throw forbidden('The other side answers your proposal');
      const side = r.proposed_by === 'venue' ? 'coach' : 'venue';
      if (i.decision === 'amend') {
        const starts = i.starts_at ? new Date(i.starts_at) : new Date(r.starts_at);
        const mins = i.duration_min ?? Math.round((+new Date(r.ends_at) - +new Date(r.starts_at)) / 60_000);
        const resource = i.resource_id === undefined ? r.resource_id : i.resource_id;
        const price = i.price_cents === undefined ? r.price_cents : i.price_cents;
        if (starts <= new Date()) throw badRequest('Pick a time in the future');
        if (resource && !(await c.query('SELECT 1 FROM resources WHERE id=$1 AND venue_id=$2', [resource, r.venue_id])).rows.length) throw badRequest('That court is not at this venue');
        const ends = new Date(+starts + mins * 60_000);
        if (+starts === +new Date(r.starts_at) && +ends === +new Date(r.ends_at) && resource === r.resource_id && price === r.price_cents) throw badRequest('Change at least one thing to amend');
        await c.query('UPDATE venue_coach_slots SET starts_at=$2, ends_at=$3, resource_id=$4, price_cents=$5, proposed_by=$6, row_version=row_version+1 WHERE id=$1', [r.id, starts, ends, resource, price, side]);
        await log(c, 'slot', r.id, 'amend', user, side, 'proposed', 'proposed', { starts_at: starts, ends_at: ends, resource_id: resource, price_cents: price }, i.reason);
        await tellOther(c, r, side, { kind: 'venue_coach_slot', title: `${await venueName(c, r.venue_id)}: coaching slot amended`, body: 'The new time is waiting for your answer.', data: { slot_id: r.id, venue_id: r.venue_id } });
      } else if (i.decision === 'agree') {
        await assertFree(c, r);
        let blockId = null;
        if (r.resource_id) {
          blockId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
          await c.query("INSERT INTO venue_blocks(venue_id, resource_id, starts_at, ends_at, kind, reason, batch_id, created_by) VALUES ($1,$2,$3,$4,'other',$5,$6,$7)",
            [r.venue_id, r.resource_id, r.starts_at, r.ends_at, 'Coaching', blockId, user.id]);
        }
        await c.query("UPDATE venue_coach_slots SET status='agreed', decided_at=now(), block_id=$2, row_version=row_version+1 WHERE id=$1", [r.id, blockId]);
        await log(c, 'slot', r.id, 'agree', user, side, 'proposed', 'agreed', null, i.reason);
        await tellOther(c, r, side, { kind: 'venue_coach_slot', title: `${await venueName(c, r.venue_id)}: coaching slot agreed`, body: '', data: { slot_id: r.id, venue_id: r.venue_id } });
      } else {
        await c.query("UPDATE venue_coach_slots SET status='rejected', decided_at=now(), row_version=row_version+1 WHERE id=$1", [r.id]);
        await log(c, 'slot', r.id, 'reject', user, side, 'proposed', 'rejected', null, i.reason);
        await tellOther(c, r, side, { kind: 'venue_coach_slot', title: `${await venueName(c, r.venue_id)}: coaching slot rejected`, body: '', data: { slot_id: r.id, venue_id: r.venue_id } });
      }
      return slotView((await c.query('SELECT * FROM venue_coach_slots WHERE id=$1', [r.id])).rows[0]);
    });
  },
});

cap({
  name: 'cancel_coach_roster_slot', method: 'POST', path: '/venue-coach-slots/:id/cancel', tag: TAG,
  summary: 'Either side cancels a proposed or agreed slot (or withdraws their own proposal). An agreed slot frees the court and the coach\'s time. History is kept.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM venue_coach_slots WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Slot');
      const s = await sidesOf(user, r, c);
      if (!s.venue && !s.coach) throw notFound('Slot');
      if (!['proposed', 'agreed'].includes(r.status)) throw conflict(`This slot is already ${r.status}`);
      const side = sideName(s, r.proposed_by);
      await cancelSlotRows(c, [r], user, side, i.reason);
      await tellOther(c, r, side, { kind: 'venue_coach_slot', title: `${await venueName(c, r.venue_id)}: coaching slot cancelled`, body: '', data: { slot_id: r.id, venue_id: r.venue_id } });
      return { id: r.id, status: 'cancelled' };
    });
  },
});

cap({
  name: 'get_venue_coach_roster', method: 'GET', path: '/venue-coach-roster', tag: TAG,
  summary: 'The shared roster between `from` and `to`: proposed, agreed and recent slots with the court, the coach, and whose turn it is. With `venue_id` (venue team only) it is the venue\'s roster; without, the roster of your own slots as a coach. `get_venue_coach_slot_history` shows one slot\'s moves.',
  input: z.object({ venue_id: id.optional(), coach_id: id.optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), status: z.enum(['proposed', 'agreed', 'rejected', 'cancelled', 'expired']).optional() }),
  async handler({ user }, i) {
    if (i.venue_id) await mustManage(user, i.venue_id);
    const from = i.from ? new Date(i.from) : new Date(Date.now() - 864e5), to = i.to ? new Date(i.to) : new Date(Date.now() + 42 * 864e5);
    if (+to - +from > 120 * 864e5) throw badRequest('Ask for 120 days or fewer');
    const rows = await many(
      `SELECT s.*, u.display_name AS coach_name, u.avatar_emoji, u.avatar_color, u.avatar_url, v.name AS venue_name, r.name AS court_name, sp.slug AS sport_slug, sp.name AS sport
         FROM venue_coach_slots s JOIN users u ON u.id=s.coach_id JOIN venues v ON v.id=s.venue_id LEFT JOIN resources r ON r.id=s.resource_id LEFT JOIN sports sp ON sp.id=s.sport_id
        WHERE ($1::uuid IS NULL OR s.venue_id=$1) AND ($1::uuid IS NOT NULL OR s.coach_id=$2) AND ($3::uuid IS NULL OR s.coach_id=$3)
          AND s.starts_at < $5 AND s.ends_at > $4 AND ($6::text IS NULL OR s.status=$6)
        ORDER BY s.starts_at, s.id LIMIT 500`, [i.venue_id ?? null, user.id, i.coach_id ?? null, from, to, i.status ?? null]);
    return rows.map((r) => ({ ...slotView(r), waiting_on: r.status === 'proposed' ? (r.proposed_by === 'venue' ? 'coach' : 'venue') : null }));
  },
});

cap({
  name: 'get_venue_coach_history', method: 'GET', path: '/venue-coach-history/:type/:id', tag: TAG,
  summary: 'The append-only history of one tie-up or roster slot (who proposed, amended, agreed, rejected or cancelled, when and why), oldest first. Only the venue team and the coach can read it.',
  input: z.object({ type: z.enum(['tie', 'slot']), id }),
  async handler({ user }, i) {
    const row = await one(i.type === 'tie' ? 'SELECT venue_id, coach_id FROM venue_coach_ties WHERE id=$1' : 'SELECT venue_id, coach_id FROM venue_coach_slots WHERE id=$1', [i.id]);
    if (!row) throw notFound('Record');
    const s = await sidesOf(user, row);
    if (!s.venue && !s.coach) throw notFound('Record');
    const rows = await many('SELECT e.*, u.display_name AS actor_name FROM venue_coach_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.subject_type=$1 AND e.subject_id=$2 ORDER BY e.at, e.id', [i.type, i.id]);
    if (rows.some((r) => r.reason_enc)) await audit(null, user.id, 'read_venue_coach_reason', i.type === 'tie' ? 'venue_coach_ties' : 'venue_coach_slots', i.id);
    return rows.map(({ reason_enc, ...r }) => ({ ...r, reason: decrypt(reason_enc, NOTE) }));
  },
});
