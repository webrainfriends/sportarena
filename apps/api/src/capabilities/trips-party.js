// Team & delegation travel operations (#485), part 2: the travel party. People come from canonical records (team roster, organisation, accepted
// officials, approved guests); the trip keeps only the trip role and the invitation / confirmation state. Being on the team or in the match
// squad is not being on the trip. A young traveller can never confirm for themselves: a verified guardian's trip-specific consent does that.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { guardianLink } from '../youth.js';
import { LIVE_PARTICIPANT, PARTY_ROLES, assertOpen, audienceOf, guardiansOfMany, record, tripCtx, youthIdsAmong } from '../trips.js';

const TAG = 'Team travel';
const YOUTH_ROLES = ['athlete'];

/** Why this person may be invited: a canonical record that already says they belong with this team / organisation / fixture. Never a free-typed identity. */
async function basisFor(c, trip, userId, role, guardianOf) {
  if (role === 'guardian') {
    if (!guardianOf) throw badRequest('Say which young traveller this guardian accompanies');
    const child = (await c.query("SELECT id FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status = ANY($3)", [trip.id, guardianOf, LIVE_PARTICIPANT])).rows[0];
    if (!child) throw badRequest('That young traveller is not on this trip');
    if (!(await guardianLink(userId, guardianOf, c))) throw forbidden('Only a verified guardian of that young person can travel as their guardian');
    return 'guardian_of';
  }
  if (role === 'guest') {
    if (!trip.allow_guests) throw conflict('This trip does not allow guests. The manager can turn that on in the trip policy.');
    return 'approved_guest';
  }
  if (trip.team_id && (await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [trip.team_id, userId])).rowCount) return 'team_roster';
  if (trip.organisation_id && (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [trip.organisation_id, userId])).rowCount) return 'organisation';
  if (['official', 'medical', 'staff'].includes(role) && (await c.query(
    "SELECT 1 FROM fixture_officials fo JOIN trip_events l ON l.fixture_id=fo.fixture_id WHERE l.trip_id=$1 AND l.unlinked_at IS NULL AND fo.user_id=$2 AND fo.status='accepted'", [trip.id, userId])).rowCount) return 'official_assignment';
  throw badRequest('That person is not on the team, the organisation or an accepted official on a linked fixture. Add them there first, or invite them as an approved guest if the trip allows guests.');
}

export async function invite(c, user, trip, { userId, role, guardianOf = null, replacesId = null }) {
  const youth = (await youthIdsAmong(c, [userId])).length > 0;
  if (youth && !YOUTH_ROLES.includes(role)) throw badRequest('A young person can travel only as an athlete');
  if (role === 'guardian' && youth) throw badRequest('A guardian must be an adult');
  const basis = await basisFor(c, trip, userId, role, guardianOf);
  if ((await c.query('SELECT 1 FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status = ANY($3)', [trip.id, userId, LIVE_PARTICIPANT])).rowCount) throw conflict('Already on this trip');
  const p = (await c.query('INSERT INTO trip_participants(trip_id, user_id, role, basis, guardian_of, invited_by, replaces_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [trip.id, userId, role, basis, guardianOf, user.id, replacesId])).rows[0];
  const hear = youth ? [userId, ...(await guardiansOfMany(c, [userId]))] : [userId];
  await record(c, trip, user.id, { entity: 'participant', entityId: p.id, action: 'invited', snapshot: { role, basis }, affected: hear,
    title: youth ? 'A young traveller has been invited' : 'You are invited to travel', body: youth ? `${trip.name}: a trip-specific guardian consent is needed before they can go.` : `${trip.name}: open the trip to confirm.`, kind: 'trip_invitation' });
  return p;
}

const partyRow = async (c, pid) => (await c.query('SELECT p.id, p.user_id, p.role, p.status, p.basis, p.guardian_of, u.display_name FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [pid])).rows[0];

cap({
  name: 'invite_trip_participant', method: 'POST', path: '/trips/:id/party', tag: TAG, status: 201,
  summary: 'Trip manager: invite a person from the team roster, the organisation or an accepted fixture official (or an approved guest / verified guardian where the trip allows). Roles: athlete, coach, staff, official, medical, manager, chaperone, guest, guardian. Young people can travel only as athletes and need trip-specific guardian consent.',
  input: z.object({ id, user_id: id, role: z.enum(PARTY_ROLES), guardian_of: id.optional().describe('role guardian: the young traveller\'s user id') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can invite people');
      assertOpen(ctx.trip);
      const p = await invite(c, user, ctx.trip, { userId: i.user_id, role: i.role, guardianOf: i.guardian_of });
      return partyRow(c, p.id);
    });
  },
});

cap({
  name: 'respond_trip_invitation', method: 'POST', path: '/trips/:id/party/respond', tag: TAG,
  summary: 'Answer your own trip invitation: confirm or decline. A young traveller cannot confirm for themselves (a verified guardian gives trip consent instead) but can always decline.',
  input: z.object({ id, response: z.enum(['confirm', 'decline']), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      const me = ctx.mine;
      if (!me) throw notFound('Invitation');
      assertOpen(ctx.trip);
      if (me.status !== 'invited') throw conflict(`You have already ${me.status === 'confirmed' ? 'confirmed' : 'responded'}`);
      const youth = (await youthIdsAmong(c, [user.id])).length > 0;
      if (i.response === 'confirm' && youth) throw conflict('A verified guardian confirms this for you by giving trip consent. Ask them to open the invitation.', { code: 'guardian_consent_required' });
      const p = (await c.query("UPDATE trip_participants SET status=$2, responded_at=now(), ended_at=CASE WHEN $2='declined' THEN now() ELSE NULL END, ended_reason=$3 WHERE id=$1 RETURNING *", [me.id, i.response === 'confirm' ? 'confirmed' : 'declined', i.note ?? null])).rows[0];
      await record(c, ctx.trip, user.id, { entity: 'participant', entityId: p.id, action: i.response === 'confirm' ? 'confirmed' : 'declined', note: i.note, affected: [ctx.trip.manager_id, ...(youth ? await guardiansOfMany(c, [user.id]) : [])],
        title: i.response === 'confirm' ? 'A traveller confirmed' : 'A traveller declined', body: `${ctx.trip.name}` });
      return partyRow(c, p.id);
    });
  },
});

cap({
  name: 'update_trip_participant', method: 'PATCH', path: '/trips/:id/party/:participant_id', tag: TAG,
  summary: 'Trip manager: change a traveller\'s trip role (a young traveller stays an athlete).',
  input: z.object({ id, participant_id: id, role: z.enum(PARTY_ROLES) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can change roles');
      assertOpen(ctx.trip);
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3)', [i.participant_id, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
      if (!p) throw notFound('Traveller');
      if (['guest', 'guardian'].includes(i.role) !== ['guest', 'guardian'].includes(p.role) || i.role === 'guardian') throw badRequest('Guests and guardians are invited as such; withdraw and invite again to change that');
      if ((await youthIdsAmong(c, [p.user_id])).length && !YOUTH_ROLES.includes(i.role)) throw badRequest('A young person can travel only as an athlete');
      if (p.user_id === ctx.trip.manager_id && i.role !== 'manager') throw badRequest('Change the trip manager first');
      await c.query('UPDATE trip_participants SET role=$2 WHERE id=$1', [p.id, i.role]);
      await record(c, ctx.trip, user.id, { entity: 'participant', entityId: p.id, action: 'role_changed', snapshot: { from: p.role, to: i.role }, affected: [p.user_id], title: 'Your trip role changed', body: `${ctx.trip.name}: you are now ${i.role}.` });
      return partyRow(c, p.id);
    });
  },
});

cap({
  name: 'withdraw_trip_participant', method: 'POST', path: '/trips/:id/party/:participant_id/withdraw', tag: TAG,
  summary: 'Withdraw a traveller (the manager, the traveller, or a young traveller\'s verified guardian) with a reason, optionally naming a replacement from the same canonical sources. Transport and room allocations pass to the replacement; documents and consent never do. Everything stays in the history and only the people affected are told.',
  input: z.object({ id, participant_id: id, reason: z.string().trim().min(2).max(300), replacement_user_id: id.optional(), replacement_role: z.enum(PARTY_ROLES).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const p = (await c.query('SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3) FOR UPDATE', [i.participant_id, ctx.trip.id, LIVE_PARTICIPANT])).rows[0];
      if (!p) throw notFound('Traveller');
      if (!(ctx.manager || p.user_id === user.id || ctx.wardIds.has(p.id))) throw forbidden('Only the trip manager, the traveller or their guardian can withdraw them');
      if (p.user_id === ctx.trip.manager_id) throw badRequest('Change the trip manager before withdrawing them');
      if (i.replacement_user_id && !ctx.manager) throw forbidden('Only the trip manager can name a replacement');
      const audience = await audienceOf(c, ctx.trip, [p.id]);
      const segs = (await c.query('SELECT segment_id FROM trip_segment_passengers WHERE participant_id=$1 AND removed_at IS NULL', [p.id])).rows;
      const rooms = (await c.query('SELECT room_id FROM trip_room_assignments WHERE participant_id=$1 AND released_at IS NULL', [p.id])).rows;
      await c.query('UPDATE trip_segment_passengers SET removed_at=now() WHERE participant_id=$1 AND removed_at IS NULL', [p.id]);
      await c.query('UPDATE trip_room_assignments SET released_at=now() WHERE participant_id=$1 AND released_at IS NULL', [p.id]);
      await c.query("UPDATE trip_consents SET revoked_at=now(), revoked_by=$2 WHERE participant_id=$1 AND revoked_at IS NULL", [p.id, user.id]);
      let repl = null;
      if (i.replacement_user_id) {
        repl = await invite(c, user, ctx.trip, { userId: i.replacement_user_id, role: i.replacement_role ?? p.role, replacesId: p.id });
        for (const s of segs) await c.query('INSERT INTO trip_segment_passengers(segment_id, participant_id) VALUES ($1,$2)', [s.segment_id, repl.id]);
        for (const r of rooms) await c.query('INSERT INTO trip_room_assignments(room_id, participant_id, assigned_by) VALUES ($1,$2,$3)', [r.room_id, repl.id, user.id]);
      }
      await c.query('UPDATE trip_participants SET status=$2, ended_at=now(), ended_reason=$3 WHERE id=$1', [p.id, repl ? 'replaced' : 'withdrawn', i.reason]);
      const gear = (await c.query('SELECT count(*)::int AS n FROM trip_gear WHERE trip_id=$1 AND responsible_id=$2 AND archived_at IS NULL', [ctx.trip.id, p.user_id])).rows[0].n;
      await record(c, ctx.trip, user.id, { entity: 'participant', entityId: p.id, action: repl ? 'replaced' : 'withdrawn', note: i.reason,
        snapshot: { role: p.role, segments_released: segs.length, rooms_released: rooms.length, gear_needing_new_owner: gear, replacement_participant_id: repl?.id ?? null }, affected: [...audience, ctx.trip.manager_id],
        title: repl ? 'A traveller was replaced' : 'A traveller withdrew', body: ctx.trip.name });
      return { withdrawn: await partyRow(c, p.id), replacement: repl ? await partyRow(c, repl.id) : null, segments_released: segs.length, rooms_released: rooms.length, gear_needing_new_owner: gear };
    });
  },
});
