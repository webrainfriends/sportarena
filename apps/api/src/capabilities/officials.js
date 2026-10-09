import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { OFFICIAL_ROLES, lockOfficial, assertOfficialEligible, recordHistory, closeOfficial } from '../officials.js';
import { eventForOrganizer, inviteOfficial } from './events.js';

const role = z.enum(OFFICIAL_ROLES);
const getFo = async (c, fid) => {
  const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [fid])).rows[0];
  if (!fo) throw notFound('official assignment');
  return fo;
};
const lockedFixture = async (c, fixtureId) => (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fixtureId])).rows[0];

cap({
  name: 'request_fixture_official', method: 'POST', path: '/fixtures/:id/officials', tag: 'Officials', status: 201,
  summary: 'Organiser asks a referee, umpire, assistant referee or scorer to officiate a fixture. They must accept before they count as crew.',
  input: z.object({ id, user_id: id, role }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = await lockedFixture(c, i.id);
      if (!f) throw notFound('fixture');
      const ev = await eventForOrganizer(user, f.event_id, c);
      if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
      return inviteOfficial(c, user, ev, f, i.user_id, i.role);
    });
  },
});

cap({
  name: 'respond_fixture_official', method: 'POST', path: '/official-assignments/:id/respond', tag: 'Officials',
  summary: 'The invited official accepts or declines. A confirmed official re-accepts to acknowledge a changed time.',
  input: z.object({ id, response: z.enum(['accept', 'decline']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      if (fo.user_id !== user.id) throw forbidden('This assignment is not yours');
      if (!['invited', 'accepted'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);
      if (i.response === 'decline') {
        if (fo.status === 'accepted') throw conflict('Use withdraw to leave a confirmed assignment');
        await closeOfficial(c, fo, user.id, 'declined', i.reason);
        const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
        await notify(c, ev.organizer_id, { kind: 'official_assignment', title: 'Official declined', body: `A ${fo.role} declined ${ev.name}.`, data: { fixture_id: f.id, official_id: fo.id } });
        return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
      }
      if (f.status === 'cancelled' || f.status === 'completed') throw conflict(`Fixture is ${f.status}`);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      await lockOfficial(c, user.id);
      await assertOfficialEligible(c, { sportId: ev.sport_id, fixtureId: f.id, userId: user.id, role: fo.role, start: f.scheduled_at, durationMin: f.duration_min });
      if (fo.status === 'accepted') {
        await c.query('UPDATE fixture_officials SET needs_ack=false WHERE id=$1', [fo.id]);
        await recordHistory(c, fo.id, user.id, 'accepted', 'accepted', 'Acknowledged change');
      } else {
        await c.query("UPDATE fixture_officials SET status='accepted', needs_ack=false, responded_at=now() WHERE id=$1", [fo.id]);
        await recordHistory(c, fo.id, user.id, 'invited', 'accepted', null);
        if (fo.role === 'referee') await c.query('UPDATE fixtures SET referee_id=$2 WHERE id=$1', [f.id, user.id]);
        await c.query(
          `INSERT INTO associations(user_id, role, target_type, target_id, status, invited_by, started_at)
           SELECT $1, $2, 'game', g.id, 'active', $4, now() FROM games g WHERE g.fixture_id=$3 ON CONFLICT DO NOTHING`, [user.id, fo.role, f.id, fo.requested_by]);
        await notify(c, ev.organizer_id, { kind: 'official_assignment', title: 'Official accepted', body: `A ${fo.role} accepted ${ev.name}.`, data: { fixture_id: f.id, official_id: fo.id } });
      }
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

cap({
  name: 'release_fixture_official', method: 'POST', path: '/official-assignments/:id/release', tag: 'Officials',
  summary: 'Organiser releases an official (with a reason); the official is notified and history is kept.',
  input: z.object({ id, reason: z.string().min(2).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      const ev = await eventForOrganizer(user, f.event_id, c);
      if (!['invited', 'accepted'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);
      await closeOfficial(c, fo, user.id, 'released', i.reason);
      await notify(c, fo.user_id, { kind: 'official_assignment', title: 'Assignment released', body: `You were released as ${fo.role} for ${ev.name}: ${i.reason}`, data: { fixture_id: f.id, official_id: fo.id } });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

cap({
  name: 'withdraw_fixture_official', method: 'POST', path: '/official-assignments/:id/withdraw', tag: 'Officials',
  summary: 'A confirmed official withdraws before the match starts, with a reason; the organiser is notified.',
  input: z.object({ id, reason: z.string().min(2).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      if (fo.user_id !== user.id) throw forbidden('This assignment is not yours');
      if (fo.status !== 'accepted') throw conflict(`Assignment is ${fo.status}`);
      if (f.status !== 'scheduled') throw conflict('The match has already started or finished');
      await closeOfficial(c, fo, user.id, 'withdrawn', i.reason);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      await notify(c, ev.organizer_id, { kind: 'official_assignment', title: 'Official withdrew', body: `A ${fo.role} withdrew from ${ev.name}: ${i.reason}`, data: { fixture_id: f.id, official_id: fo.id } });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

cap({
  name: 'list_fixture_officials', method: 'GET', path: '/fixtures/:id/officials', tag: 'Officials',
  summary: 'The officiating crew. Organisers see every request and the history; officials see confirmed crew plus their own row.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const f = (await many('SELECT f.event_id, e.organizer_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [i.id]))[0];
    if (!f) throw notFound('fixture');
    const organiser = isAdmin(user) || f.organizer_id === user.id;
    return many(
      `SELECT fo.id, fo.fixture_id, fo.user_id, fo.role, fo.status, fo.needs_ack, fo.created_at, fo.responded_at,
              u.display_name, u.handle, u.avatar_emoji, u.avatar_color,
              ${organiser ? "fo.reason, (SELECT coalesce(json_agg(json_build_object('from', h.from_status, 'to', h.to_status, 'reason', h.reason, 'actor_id', h.actor_id, 'at', h.at) ORDER BY h.at, h.id), '[]') FROM fixture_official_history h WHERE h.fixture_official_id=fo.id) AS history" : 'NULL::text AS reason'}
         FROM fixture_officials fo JOIN users u ON u.id=fo.user_id
        WHERE fo.fixture_id=$1 AND ($2::boolean OR fo.status='accepted' OR fo.user_id=$3)
        ORDER BY fo.created_at, fo.id LIMIT $4 OFFSET $5`, [i.id, organiser, user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'list_my_official_assignments', method: 'GET', path: '/me/official-assignments', tag: 'Officials',
  summary: 'My officiating requests and assignments with match, event and crew role, soonest first.',
  input: z.object({ status: z.enum(['invited', 'accepted', 'declined', 'withdrawn', 'released', 'cancelled', 'completed']).optional(), upcoming: z.boolean().optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.needs_ack, fo.reason, f.scheduled_at, f.duration_min, f.status AS fixture_status, f.round, e.id AS event_id, e.name AS event_name,
            h.name AS home_name, a.name AS away_name, r.name AS resource_name
       FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id
       LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id
      WHERE fo.user_id=$1 AND ($2::text IS NULL OR fo.status=$2) AND (NOT coalesce($3::boolean, false) OR f.scheduled_at >= now())
      ORDER BY f.scheduled_at, fo.id LIMIT $4 OFFSET $5`, [user.id, i.status ?? null, i.upcoming ?? null, i.limit, i.offset]),
});
