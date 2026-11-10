// REF-R10: Assignor role delegation — a neutral third-party (assignor) may invite officials on behalf of an event organiser.
// Privacy constraints: assignors never see fee amounts, official PII, or team rosters.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { isOrganiser } from './event-departments.js';

const TAG = 'Officials';

async function requireOrganiser(user, eventId) {
  const ev = await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev) throw notFound('Event');
  const ok = isAdmin(user) || await isOrganiser(user, ev, pool);
  if (!ok) throw forbidden('Only the event organiser can manage assignor grants');
  return ev;
}

async function requireAssignorGrant(user, eventId) {
  const grant = await one(
    `SELECT g.* FROM official_assignor_grants g WHERE g.event_id=$1 AND g.assignor_id=$2 AND g.revoked_at IS NULL`,
    [eventId, user.id],
  );
  if (!grant) throw forbidden('You do not have an active assignor grant for this event');
  return grant;
}

cap({
  name: 'grant_assignor_access', method: 'POST', path: '/official-assignor/grant', tag: TAG,
  summary: 'Event organiser grants a neutral assignor rights to invite officials for one event.',
  input: z.object({ event_id: id, assignor_user_id: id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const ev = await requireOrganiser(user, i.event_id);
    const assignee = await one('SELECT id, display_name FROM users WHERE id=$1', [i.assignor_user_id]);
    if (!assignee) throw notFound('User');
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO official_assignor_grants(event_id, assignor_id, granted_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (event_id, assignor_id) DO UPDATE
           SET revoked_at=NULL, revoke_note=NULL, granted_at=now(), granted_by=EXCLUDED.granted_by
         RETURNING *`,
        [i.event_id, i.assignor_user_id, user.id],
      )).rows[0];
      await audit(c, user.id, 'assignor_grant.created', 'official_assignor_grants', row.id);
      return { id: row.id, event_id: row.event_id, assignor_id: row.assignor_id, granted_at: row.granted_at };
    });
  },
});

cap({
  name: 'revoke_assignor_access', method: 'POST', path: '/official-assignor/revoke', tag: TAG,
  summary: 'Event organiser revokes an assignor grant. The assignor can no longer invite officials.',
  input: z.object({ event_id: id, assignor_user_id: id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    await requireOrganiser(user, i.event_id);
    return tx(async (c) => {
      const r = await c.query(
        `UPDATE official_assignor_grants SET revoked_at=now(), revoke_note=$3
          WHERE event_id=$1 AND assignor_id=$2 AND revoked_at IS NULL`,
        [i.event_id, i.assignor_user_id, i.note ?? null],
      );
      if (r.rowCount === 0) throw badRequest('No active grant found for this assignor');
      await audit(c, user.id, 'assignor_grant.revoked', 'official_assignor_grants', `${i.event_id}:${i.assignor_user_id}`);
      return { revoked: true };
    });
  },
});

cap({
  name: 'list_assignor_grants', method: 'GET', path: '/official-assignor/grants', tag: TAG,
  summary: 'List active assignor grants for an event (organiser only). No fee or PII fields returned.',
  input: z.object({ event_id: id, ...page }),
  async handler({ user }, i) {
    await requireOrganiser(user, i.event_id);
    return many(
      `SELECT g.id, g.event_id, g.assignor_id, g.granted_by, g.granted_at,
              u.display_name AS assignor_name, u.handle AS assignor_handle, u.avatar_emoji, u.avatar_color
         FROM official_assignor_grants g
         JOIN users u ON u.id=g.assignor_id
        WHERE g.event_id=$1 AND g.revoked_at IS NULL
        ORDER BY g.granted_at DESC
        LIMIT $2 OFFSET $3`,
      [i.event_id, i.limit, i.offset],
    );
  },
});

cap({
  name: 'assignor_invite_official', method: 'POST', path: '/official-assignor/invite', tag: TAG,
  summary: 'Assignor invites an official for a fixture on behalf of the organiser. Assignor cannot view fees, PII or rosters.',
  input: z.object({ fixture_id: id, user_id: id, role: z.string().min(2).max(60), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const f = await one('SELECT * FROM fixtures WHERE id=$1', [i.fixture_id]);
    if (!f) throw notFound('Fixture');
    await requireAssignorGrant(user, f.event_id);
    const official = await one('SELECT id, display_name FROM users WHERE id=$1', [i.user_id]);
    if (!official) throw notFound('Official');
    // Find event organiser to set as invited_by
    const ev = await one('SELECT organizer_id FROM events WHERE id=$1', [f.event_id]);
    return tx(async (c) => {
      await c.query(
        `INSERT INTO fixture_officials(fixture_id, user_id, role, status, invited_by, assignor_delegated_by)
         VALUES ($1,$2,$3,'invited',$4,$5)
         ON CONFLICT (fixture_id, user_id) DO NOTHING`,
        [i.fixture_id, i.user_id, i.role, ev.organizer_id, user.id],
      );
      await audit(c, user.id, 'assignor.invited_official', 'fixture_officials', `${i.fixture_id}:${i.user_id}`);
      return { invited: true };
    });
  },
});

cap({
  name: 'get_assignor_hub', method: 'GET', path: '/official-assignor/hub', tag: TAG,
  summary: 'Assignor read-only hub: event summary, fixtures with crew status, and invitations made by this assignor. No fee, PII or team roster fields.',
  input: z.object({ event_id: id }),
  async handler({ user }, i) {
    await requireAssignorGrant(user, i.event_id);
    const ev = await one(
      `SELECT e.id, e.name, e.starts_on, e.ends_on, e.city, s.name AS sport_name, s.emoji AS sport_emoji
         FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1`,
      [i.event_id],
    );
    const fixtures = await many(
      `SELECT f.id, f.scheduled_at, f.status, f.round,
              h.name AS home_team, a.name AS away_team,
              COUNT(fo.id) FILTER (WHERE fo.status='accepted') AS accepted_crew,
              COUNT(fo.id) FILTER (WHERE fo.status IN ('accepted','invited')) AS total_crew
         FROM fixtures f
         LEFT JOIN teams h ON h.id=f.home_team_id
         LEFT JOIN teams a ON a.id=f.away_team_id
         LEFT JOIN fixture_officials fo ON fo.fixture_id=f.id
        WHERE f.event_id=$1
        GROUP BY f.id, h.name, a.name
        ORDER BY f.scheduled_at`,
      [i.event_id],
    );
    const myInvitations = await many(
      `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.created_at,
              u.display_name AS official_name, u.handle
         FROM fixture_officials fo
         JOIN users u ON u.id=fo.user_id
        WHERE fo.assignor_delegated_by=$1 AND fo.fixture_id IN (SELECT id FROM fixtures WHERE event_id=$2)
        ORDER BY fo.created_at DESC
        LIMIT 100`,
      [user.id, i.event_id],
    );
    return { event: ev, fixtures, my_invitations: myInvitations };
  },
});
