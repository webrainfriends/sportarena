import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { ownRecord } from './coaching-journal.js';

// Match preparation and bookmarks of official events (issue #269). The coach's prep sits beside the fixture's session record; the fixture,
// its result and its events are only read, and a bookmark is a pointer that can be removed without touching the event.
const TAG = 'Coaching journal';
const COACH = ['coach'];
const text = (n) => z.string().trim().max(n);

const indicator = z.object({
  metric: z.enum(['score_for', 'score_against', 'goal_difference', 'clean_sheet', 'events']),
  kind: text(40).optional().describe('for metric "events": the kind of official event to count for your team, for example goal or foul'),
  comparator: z.enum(['gte', 'lte', 'eq']), target: z.number().int().min(-100).max(1000),
}).refine((x) => x.metric !== 'events' || !!x.kind, 'Name the kind of event to count');

cap({
  name: 'save_coaching_match_prep', method: 'POST', path: '/coaching/sessions/:id/match-prep', tag: TAG, auth: COACH,
  summary: 'Save the preparation for a match you coach (the session record of a fixture): notes on the opponent, a pre-match checklist, and objectives - each optionally with a measurable indicator that is later checked against the OFFICIAL result and events. Replaces the previous version of the prep; needs expected_version once one exists.',
  input: z.object({
    id, opponent_notes: text(4000).optional(), expected_version: z.number().int().min(1).optional(),
    checklist: z.array(z.object({ id: z.string().max(60).optional(), text: text(200).min(1), done: z.boolean().default(false) })).max(30).default([]),
    objectives: z.array(z.object({ id: z.string().max(60).optional(), text: text(300).min(1), indicator: indicator.optional() })).max(12).default([]),
  }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (rec.source_type !== 'fixture') throw badRequest('Match prep belongs to the session record of a fixture');
    const withIds = (xs) => xs.map((x) => ({ ...x, id: x.id ?? randomUUID() }));
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM coaching_match_prep WHERE session_record_id=$1 FOR UPDATE', [rec.id])).rows[0];
      if (cur && i.expected_version !== cur.row_version) throw conflict('The prep changed since you loaded it');
      return (await c.query(
        `INSERT INTO coaching_match_prep(session_record_id, opponent_notes, checklist, objectives) VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_record_id) DO UPDATE SET opponent_notes=EXCLUDED.opponent_notes, checklist=EXCLUDED.checklist, objectives=EXCLUDED.objectives, row_version=coaching_match_prep.row_version+1, updated_at=now() RETURNING *`,
        [rec.id, i.opponent_notes ?? null, JSON.stringify(withIds(i.checklist)), JSON.stringify(withIds(i.objectives))])).rows[0];
    });
  },
});

cap({
  name: 'bookmark_match_event', method: 'POST', path: '/coaching/sessions/:id/event-bookmarks', tag: TAG, auth: COACH, status: 201,
  summary: 'Bookmark an official match event of your team for the debrief, with a short note. The event itself is not copied or changed. Send remove=true to take the bookmark away (it is kept, hidden).',
  input: z.object({ id, match_event_id: id, athlete_id: id.optional(), note: text(500).optional(), remove: z.boolean().default(false) }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    if (rec.source_type !== 'fixture' || !rec.team_id) throw badRequest('Bookmarks belong to the session record of a fixture');
    const ev = await one('SELECT id, player_id FROM match_events WHERE id=$1 AND fixture_id::text=$2 AND team_id=$3 AND voided_at IS NULL', [i.match_event_id, rec.source_id, rec.team_id]);
    if (!ev) throw notFound('Match event');
    if (i.athlete_id && !(await one('SELECT 1 FROM coaching_session_participants WHERE session_record_id=$1 AND athlete_id=$2', [rec.id, i.athlete_id]))) throw badRequest('That player is not on this session');
    if (i.remove) return (await one('UPDATE coaching_event_bookmarks SET removed_at=now() WHERE session_record_id=$1 AND match_event_id=$2 RETURNING id, removed_at', [rec.id, ev.id])) ?? { removed_at: null };
    return one(
      `INSERT INTO coaching_event_bookmarks(session_record_id, match_event_id, athlete_id, note) VALUES ($1,$2,$3,$4)
       ON CONFLICT (session_record_id, match_event_id) DO UPDATE SET note=EXCLUDED.note, athlete_id=EXCLUDED.athlete_id, removed_at=NULL RETURNING id, match_event_id, athlete_id, note`, [rec.id, ev.id, i.athlete_id ?? ev.player_id ?? null, i.note ?? null]);
  },
});
