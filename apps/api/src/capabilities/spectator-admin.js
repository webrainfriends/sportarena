// Organiser side of the public tournament page (#501): what the public may see, and which real sponsorships get a placement on it.
// The public page itself is a projection (see spectator.js / capabilities/spectator.js); these capabilities only set its policy and slots.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { eventForOrganizer } from './events.js';
import { isYouthEvent, SLOTS } from '../spectator.js';
import { isIndexable } from '../share-cards.js';

const TAG = 'Public events';
const https = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Use a secure https link');

const settingsOf = (ev) => ({
  visibility: ev.public_visibility, indexable: !!ev.public_indexable, effective_indexable: isIndexable(ev), reactions: !!ev.public_reactions, mvp_vote: !!ev.public_mvp_vote,
  show_officials: !!ev.public_show_officials, archived: !!ev.archived_at, youth_event: isYouthEvent(ev),
});

cap({
  name: 'get_event_public_settings', method: 'GET', path: '/events/:id/public-settings', tag: TAG,
  summary: 'The public-page policy of an event you organise: visibility (public, unlisted = link only, private), whether search engines may index its share page, fan reactions and MVP voting, whether match officials are shown, and archival. `effective_indexable` is what is actually applied (youth events, private events, drafts and archived events are never indexed).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    return { ...settingsOf(ev), history: await many('SELECT l.changes, l.created_at, u.display_name AS by FROM event_public_settings_log l JOIN users u ON u.id=l.actor_id WHERE l.event_id=$1 ORDER BY l.id DESC LIMIT 20', [ev.id]) };
  },
});

cap({
  name: 'set_event_public_settings', method: 'PATCH', path: '/events/:id/public-settings', tag: TAG,
  summary: 'Set what the public may see of an event you organise. Making it private or unlisted switches indexing off; youth events (maximum age under 18) can never be indexed and never get reactions or MVP voting. Reactions and fan MVP voting are off until you enable them. Archiving removes the event from discovery but keeps it reachable by its link. Every change is logged.',
  input: z.object({
    id, visibility: z.enum(['public', 'unlisted', 'private']).optional(), indexable: z.boolean().optional(), reactions: z.boolean().optional(), mvp_vote: z.boolean().optional(),
    show_officials: z.boolean().optional(), archived: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      const youth = isYouthEvent(ev);
      const next = { visibility: i.visibility ?? ev.public_visibility, indexable: i.indexable ?? ev.public_indexable, reactions: i.reactions ?? ev.public_reactions, mvp_vote: i.mvp_vote ?? ev.public_mvp_vote };
      if (youth && (i.indexable || i.reactions || i.mvp_vote)) throw unprocessable('Youth events are never indexed and cannot have fan reactions or MVP voting');
      if (i.indexable && next.visibility !== 'public') throw unprocessable('Only a public event can be indexed by search engines');
      if (next.visibility !== 'public') next.indexable = false; // withdrawing the page withdraws its indexing too
      const archived = i.archived === undefined ? !!ev.archived_at : i.archived;
      await c.query(
        `UPDATE events SET public_visibility=$2, public_indexable=$3, public_reactions=$4, public_mvp_vote=$5, public_show_officials=coalesce($6, public_show_officials),
                archived_at = CASE WHEN $7 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1`,
        [ev.id, next.visibility, youth ? false : next.indexable, youth ? false : next.reactions, youth ? false : next.mvp_vote, i.show_officials ?? null, archived]);
      const changes = Object.fromEntries(Object.entries({ visibility: i.visibility, indexable: i.indexable, reactions: i.reactions, mvp_vote: i.mvp_vote, show_officials: i.show_officials, archived: i.archived }).filter(([, v]) => v !== undefined));
      if (!Object.keys(changes).length) throw unprocessable('Nothing to change');
      await c.query('INSERT INTO event_public_settings_log(event_id, actor_id, changes) VALUES ($1,$2,$3)', [ev.id, user.id, changes]);
      return settingsOf((await c.query('SELECT * FROM events WHERE id=$1', [ev.id])).rows[0]);
    });
  },
});

// ------------------------------------------------------------------ sponsor placements: a slot on the public pages for a real, active sponsorship
cap({
  name: 'save_sponsor_placement', method: 'POST', path: '/events/:id/sponsor-placements', tag: TAG, status: 201,
  summary: 'Give an active sponsorship of the event a placement on its public pages: title partner (event page), fixture sponsor (one game), scorecard sponsor (live centres) or leaderboard sponsor (table). Optionally add a call to action (label + https link); youth events never show one. The sponsorship must be an active agreement for this event — a paused, ended or declined agreement cannot hold a placement. One sponsor per slot per target.',
  input: z.object({ id, sponsorship_id: id, slot: z.enum(SLOTS), fixture_id: id.optional(), cta_label: z.string().trim().min(2).max(40).optional(), cta_url: https.optional() })
    .refine((x) => (x.slot === 'fixture') === !!x.fixture_id, 'A fixture-sponsor placement names the game; other slots do not')
    .refine((x) => !!x.cta_label === !!x.cta_url, 'Give both a call-to-action label and link, or neither'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      const ss = (await c.query("SELECT ss.id, sp.name FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ss.id=$1 AND ss.target_type='event' AND ss.target_id=$2", [i.sponsorship_id, ev.id])).rows[0];
      if (!ss) throw notFound('Sponsorship of this event');
      if (!(await c.query("SELECT 1 FROM sponsorships WHERE id=$1 AND status='active'", [ss.id])).rowCount) throw conflict('Only an active sponsorship can hold a placement');
      if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, ev.id])).rowCount) throw notFound('Game of this event');
      if (isYouthEvent(ev) && i.cta_url) throw unprocessable('Youth events do not show sponsor calls to action');
      try {
        return (await c.query(
          `INSERT INTO event_sponsor_placements(event_id, sponsorship_id, slot, fixture_id, cta_label, cta_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, slot, fixture_id, sponsorship_id, cta_label, cta_url, status, created_at`, [ev.id, ss.id, i.slot, i.fixture_id ?? null, i.cta_label ?? null, i.cta_url ?? null, user.id])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('That slot already has a sponsor — end the current placement first');
        throw e;
      }
    });
  },
});

cap({
  name: 'end_sponsor_placement', method: 'POST', path: '/sponsor-placements/:id/end', tag: TAG, summary: 'End a placement (kept as history with its measured counts).', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT id, event_id, status FROM event_sponsor_placements WHERE id=$1', [i.id]);
    if (!p) throw notFound('Placement');
    await eventForOrganizer(user, p.event_id);
    if (p.status === 'ended') return { ok: true };
    await one("UPDATE event_sponsor_placements SET status='ended', ended_at=now(), ended_by=$2 WHERE id=$1 RETURNING id", [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'list_sponsor_placements', method: 'GET', path: '/events/:id/sponsor-placements', tag: TAG,
  summary: 'The placements of an event with their MEASURED exposure only: how many times a public response carried the placement ("served") and how many times its call to action was followed. Reach is not estimated and no return on investment is inferred. Includes the event\'s active sponsorships that do not hold a placement yet.',
  input: z.object({ id, include_ended: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const placements = await many(
      `SELECT p.id, p.slot, p.fixture_id, p.status, p.cta_label, p.cta_url, p.created_at, p.ended_at, ss.id AS sponsorship_id, ss.status AS sponsorship_status, sp.name AS sponsor_name, sp.emoji,
              coalesce(sum(d.impressions),0)::int AS impressions_served, coalesce(sum(d.clicks),0)::int AS clicks,
              coalesce(sum(d.impressions) FILTER (WHERE d.day >= current_date - 6),0)::int AS impressions_last_7_days
         FROM event_sponsor_placements p JOIN sponsorships ss ON ss.id=p.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id LEFT JOIN placement_daily_counts d ON d.placement_id=p.id
        WHERE p.event_id=$1 AND ($2 OR p.status='active') GROUP BY p.id, ss.id, sp.id ORDER BY p.status, p.created_at`, [ev.id, i.include_ended]);
    const unplaced = await many(
      `SELECT ss.id AS sponsorship_id, sp.name AS sponsor_name, sp.emoji FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
        WHERE ss.target_type='event' AND ss.target_id=$1 AND ss.status='active' AND NOT EXISTS (SELECT 1 FROM event_sponsor_placements p WHERE p.sponsorship_id=ss.id AND p.status='active') ORDER BY sp.name`, [ev.id]);
    return { placements, unplaced_sponsorships: unplaced, measured: 'impressions_served counts public responses that carried the placement; clicks counts follows of its call to action. Unique reach and return on investment are not measured.' };
  },
});
