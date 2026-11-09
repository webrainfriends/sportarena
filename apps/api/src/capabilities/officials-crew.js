import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { OFFICIAL_ROLES, lockOfficial, assertOfficialEligible, recordHistory, closeOfficial } from '../officials.js';
import { eventForOrganizer } from './events.js';
import { notify } from '../notify.js';

const role = z.enum(OFFICIAL_ROLES);

const crewOrOrganiser = async (c, fixtureId, userId) => {
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  if (!f) throw notFound('fixture');
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
  const isOrg = ev?.organizer_id === userId;
  if (!isOrg) {
    const on = (await c.query("SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted'", [fixtureId, userId])).rowCount;
    if (!on) throw forbidden('Only the organiser or an accepted official may access the crew hub');
  }
  return { f, ev };
};

const refreshCompleteness = async (c, fixtureId) => {
  const reqs = (await c.query(
    `SELECT r.role, r.min_count, r.mandatory
       FROM fixtures f
       JOIN event_crew_requirements r ON r.event_id = f.event_id
      WHERE f.id = $1`, [fixtureId])).rows;
  if (!reqs.length) {
    await c.query(`INSERT INTO fixture_crew_completeness(fixture_id, is_complete, missing_roles, total_slots, filled_slots, checked_at)
                   VALUES ($1, true, '{}', 0, 0, now())
                   ON CONFLICT (fixture_id) DO UPDATE SET is_complete=true, missing_roles='{}', total_slots=0, filled_slots=0, checked_at=now()`, [fixtureId]);
    return;
  }
  const counts = (await c.query(
    `SELECT role, count(*)::int AS n FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' GROUP BY role`, [fixtureId])).rows;
  const countMap = Object.fromEntries(counts.map((r) => [r.role, r.n]));
  const missing = reqs.filter((r) => r.mandatory && (countMap[r.role] ?? 0) < r.min_count).map((r) => r.role);
  const totalSlots = reqs.reduce((s, r) => s + r.min_count, 0);
  const filledSlots = reqs.reduce((s, r) => s + Math.min(countMap[r.role] ?? 0, r.min_count), 0);
  await c.query(`INSERT INTO fixture_crew_completeness(fixture_id, is_complete, missing_roles, total_slots, filled_slots, checked_at)
                 VALUES ($1, $2, $3, $4, $5, now())
                 ON CONFLICT (fixture_id) DO UPDATE SET is_complete=$2, missing_roles=$3, total_slots=$4, filled_slots=$5, checked_at=now()`,
    [fixtureId, missing.length === 0, missing, totalSlots, filledSlots]);
};

cap({
  name: 'set_event_crew_requirements', method: 'POST', path: '/events/:id/crew-requirements', tag: 'Officials', status: 200,
  summary: 'Organiser defines how many of each official role a fixture in this event needs. Replaces the full set for the event.',
  input: z.object({
    id,
    requirements: z.array(z.object({
      role,
      min_count: z.number().int().min(0).max(20).default(1),
      max_count: z.number().int().min(1).max(20).default(1),
      mandatory: z.boolean().default(true),
      notes: z.string().max(300).optional(),
    })).min(1).max(11),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      await c.query('DELETE FROM event_crew_requirements WHERE event_id=$1', [ev.id]);
      const rows = [];
      for (const r of i.requirements) {
        if (r.max_count < r.min_count) throw badRequest(`max_count must be >= min_count for role ${r.role}`);
        const row = (await c.query(
          `INSERT INTO event_crew_requirements(event_id, role, min_count, max_count, mandatory, notes)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [ev.id, r.role, r.min_count, r.max_count, r.mandatory, r.notes ?? null])).rows[0];
        rows.push(row);
      }
      return { event_id: ev.id, requirements: rows };
    });
  },
});

cap({
  name: 'get_event_crew_requirements', method: 'GET', path: '/events/:id/crew-requirements', tag: 'Officials',
  summary: 'Return crew requirements and per-fixture completeness stats for an event.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = (await one(`SELECT * FROM events WHERE id=$1`, [i.id]));
    if (!ev) throw notFound('event');
    const isOrg = ev.organizer_id === user.id;
    if (!isOrg) {
      const on = await many(
        `SELECT 1 FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE f.event_id=$1 AND fo.user_id=$2 AND fo.status='accepted' LIMIT 1`,
        [i.id, user.id]);
      if (!on.length) throw forbidden('Not an organiser or accepted crew member for this event');
    }
    const requirements = await many('SELECT * FROM event_crew_requirements WHERE event_id=$1 ORDER BY role', [i.id]);
    const completeness = await many(
      `SELECT fcc.* FROM fixture_crew_completeness fcc JOIN fixtures f ON f.id=fcc.fixture_id WHERE f.event_id=$1`, [i.id]);
    return { event_id: i.id, requirements, completeness };
  },
});

cap({
  name: 'get_crew_hub', method: 'GET', path: '/fixtures/:id/crew-hub', tag: 'Officials',
  summary: 'Full crew hub: all assignments, duties, completeness, broadcast messages and substitution history for a fixture.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { f, ev } = await tx(async (c) => crewOrOrganiser(c, i.id, user.id));
    const assignments = await many(
      `SELECT fo.id, fo.role, fo.status, fo.duties, fo.emergency_accept, fo.substitution_of, fo.created_at,
              fo.responded_at, fo.ended_at, fo.fee_minor, fo.fee_currency, fo.pay_status,
              u.name AS official_name, u.avatar_url,
              sp.id AS substituted_by_id, sp.name AS substituted_by_name
         FROM fixture_officials fo
         JOIN users u ON u.id = fo.user_id
         LEFT JOIN fixture_officials orig ON orig.substitution_of = fo.id AND orig.status = 'accepted'
         LEFT JOIN users sp ON sp.id = (SELECT user_id FROM fixture_officials WHERE substitution_of=fo.id AND status='accepted' LIMIT 1)
        WHERE fo.fixture_id = $1
        ORDER BY fo.role, fo.created_at`, [i.id]);
    const requirements = await many(
      `SELECT * FROM event_crew_requirements WHERE event_id=$1`, [ev.id]);
    const completeness = (await many('SELECT * FROM fixture_crew_completeness WHERE fixture_id=$1', [i.id]))[0] ?? null;
    const broadcast = await many(
      `SELECT cb.id, cb.body, cb.pinned, cb.created_at, u.name AS author_name, u.avatar_url AS author_avatar
         FROM crew_broadcast_messages cb JOIN users u ON u.id = cb.author_id
        WHERE cb.fixture_id=$1 ORDER BY cb.pinned DESC, cb.created_at DESC LIMIT 50`, [i.id]);
    return {
      fixture_id: i.id,
      event_id: ev.id,
      event_name: ev.name,
      sport_id: ev.sport_id,
      fixture_status: f.status,
      scheduled_at: f.scheduled_at,
      duration_min: f.duration_min,
      assignments,
      requirements,
      completeness,
      broadcast,
    };
  },
});

cap({
  name: 'update_official_duties', method: 'PATCH', path: '/official-assignments/:id/duties', tag: 'Officials',
  summary: 'Organiser sets or updates the specific duties for an assignment slot (e.g. "VAR monitor 2", "Goal north side").',
  input: z.object({
    id,
    duties: z.array(z.string().min(1).max(80)).max(10),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!fo) throw notFound('official assignment');
      await eventForOrganizer(user, (await c.query('SELECT event_id FROM fixtures WHERE id=$1', [fo.fixture_id])).rows[0]?.event_id, c);
      await c.query('UPDATE fixture_officials SET duties=$2 WHERE id=$1', [i.id, i.duties]);
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
    });
  },
});

cap({
  name: 'emergency_substitute_official', method: 'POST', path: '/official-assignments/:id/substitute', tag: 'Officials', status: 201,
  summary: 'Organiser replaces a confirmed official mid-match. Closes the original as substituted, creates a new emergency-accepted assignment. No time-clash check for the replacement.',
  input: z.object({
    id,
    replacement_user_id: id,
    reason: z.string().min(2).max(500),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!fo) throw notFound('official assignment');
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fo.fixture_id])).rows[0];
      const ev = await eventForOrganizer(user, f.event_id, c);
      if (fo.status !== 'accepted') throw conflict('Only an accepted official can be substituted');
      if (!['live', 'scheduled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);

      await lockOfficial(c, i.replacement_user_id);
      await assertOfficialEligible(c, {
        event: ev, fixtureId: f.id, userId: i.replacement_user_id, role: fo.role,
        start: f.scheduled_at, durationMin: f.duration_min, checkClash: false,
      });

      await closeOfficial(c, fo, user.id, 'substituted', i.reason);

      const newFo = (await c.query(
        `INSERT INTO fixture_officials(fixture_id, user_id, role, status, duties, emergency_accept, substitution_of, responded_at, fee_minor, fee_currency)
         VALUES ($1,$2,$3,'accepted',$4,true,$5,now(),$6,$7) RETURNING *`,
        [f.id, i.replacement_user_id, fo.role, fo.duties, fo.id, fo.fee_minor, fo.fee_currency])).rows[0];
      await recordHistory(c, newFo.id, user.id, null, 'accepted', `Emergency substitution: ${i.reason}`);

      if (fo.role === 'referee') {
        await c.query('UPDATE fixtures SET referee_id=$1 WHERE id=$2', [i.replacement_user_id, f.id]);
      }

      await refreshCompleteness(c, f.id);

      await notify(c, i.replacement_user_id, {
        kind: 'official_assignment',
        title: 'Emergency assignment',
        body: `You have been assigned as ${fo.role} for ${ev.name}. Please confirm.`,
        data: { fixture_id: f.id, official_id: newFo.id },
      });

      return { original: fo, replacement: newFo };
    });
  },
});

cap({
  name: 'post_crew_broadcast', method: 'POST', path: '/fixtures/:id/crew-broadcast', tag: 'Officials', status: 201,
  summary: 'Send a message to the full accepted crew of a fixture (organiser or any accepted crew member).',
  input: z.object({
    id,
    body: z.string().min(1).max(1000),
    pinned: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { f } = await crewOrOrganiser(c, i.id, user.id);
      const msg = (await c.query(
        `INSERT INTO crew_broadcast_messages(fixture_id, author_id, body, pinned) VALUES ($1,$2,$3,$4) RETURNING *`,
        [f.id, user.id, i.body, i.pinned])).rows[0];
      const crew = await many(
        `SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' AND user_id<>$2`,
        [f.id, user.id]);
      for (const m of crew) {
        await notify(c, m.user_id, { kind: 'crew_broadcast', title: 'Crew message', body: i.body.substring(0, 120), data: { fixture_id: f.id } });
      }
      return msg;
    });
  },
});
