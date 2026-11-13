// Official Assignment Lifecycle – REF-R01 (#992)
// Adds: proposed state (official self-proposes), confirmed state (organiser locks crew),
// expired state (deadline-based auto-expiry), replaced state (pre-match swap),
// explicit schedule-change acknowledgement, organiser inbox, and assignment detail.
// Reuses inviteOfficial, assertOfficialEligible, recordHistory, closeOfficial, lockOfficial,
// notify from the canonical officials.js and events.js modules.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import {
  OFFICIAL_ROLES, ASSIGNMENT_SQL, lockOfficial, assertOfficialEligible,
  recordHistory, closeOfficial,
} from '../officials.js';
import { eventForOrganizer } from './events.js';

const role = z.enum(OFFICIAL_ROLES);
const reason500 = z.string().min(2).max(500);

const getFo = async (c, fid) => {
  const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1 FOR UPDATE', [fid])).rows[0];
  if (!fo) throw notFound('official assignment');
  return fo;
};
const lockedFixture = async (c, fixtureId) =>
  (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [fixtureId])).rows[0];

/** Expire any past-deadline invited/proposed assignments inline (also callable as a sweep). */
async function expireOverdue(c) {
  const rows = (await c.query(
    `UPDATE fixture_officials SET status='expired', ended_at=now()
      WHERE status IN ('invited','proposed') AND invitation_deadline < now()
      RETURNING id, fixture_id, user_id, role, status`,
  )).rows;
  for (const fo of rows) {
    await recordHistory(c, fo.id, null, fo.status === 'invited' ? 'invited' : 'proposed', 'expired', 'Invitation deadline passed');
    const ev = (await c.query(
      'SELECT e.* FROM events e JOIN fixtures f ON f.id=$1 WHERE e.id=f.event_id', [fo.fixture_id],
    )).rows[0];
    if (ev) {
      // Notify the official the deadline passed
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'Invitation expired',
        body: `Your ${fo.role} invitation for ${ev.name} has expired — the deadline passed without a response.`,
        data: { fixture_id: fo.fixture_id, official_id: fo.id },
      });
      // Notify the organiser the slot is unfilled
      await notify(c, ev.organizer_id, {
        kind: 'official_assignment',
        title: 'Official invitation expired',
        body: `The ${fo.role} invitation for ${ev.name} expired with no response. The slot is unfilled.`,
        data: { fixture_id: fo.fixture_id, official_id: fo.id, needs_replacement: true },
      });
    }
  }
  return rows.length;
}

// ─── propose_fixture_official ─────────────────────────────────────────────────
cap({
  name: 'propose_fixture_official',
  method: 'POST', path: '/fixtures/:id/officials/propose', tag: 'Officials', status: 201,
  summary: 'An eligible official self-proposes for an open slot on a fixture. The organiser reviews and either accepts or declines. Eligibility is checked immediately; the proposal is visible in the organiser\'s inbox.',
  input: z.object({
    id,
    role,
    cover_note: z.string().max(500).optional(),
    proposed_fee_minor: z.number().int().min(0).optional(),
    proposed_fee_currency: z.string().length(3).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = await lockedFixture(c, i.id);
      if (!f) throw notFound('fixture');
      if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      if (!ev) throw notFound('event');
      await lockOfficial(c, user.id);
      // Eligibility gate (hard mode: no invite-only caps like notice period or refused hours,
      // since the official is volunteering; we still check sport profile, credential, suspension, etc.)
      await assertOfficialEligible(c, {
        event: ev, fixtureId: f.id, userId: user.id, role: i.role,
        start: f.scheduled_at, durationMin: f.duration_min, mode: 'hard',
      });
      // No duplicate open slot for this person/role/fixture
      const dup = await c.query(
        "SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND role=$3 AND status IN ('invited','proposed','accepted','confirmed')",
        [f.id, user.id, i.role],
      );
      if (dup.rowCount) throw conflict('You already have an open assignment for this role on this fixture');
      // Run inline expiry sweep before we record the new proposal
      await expireOverdue(c);
      const fo = (await c.query(
        `INSERT INTO fixture_officials(fixture_id, user_id, role, status, requested_by, reason)
         VALUES ($1,$2,$3,'proposed',$4,$5) RETURNING *`,
        [f.id, user.id, i.role, user.id, i.cover_note ?? null],
      )).rows[0];
      if (i.proposed_fee_minor != null) {
        await c.query(
          'UPDATE fixture_officials SET fee_minor=$2, fee_currency=$3 WHERE id=$1',
          [fo.id, i.proposed_fee_minor, i.proposed_fee_currency ?? 'GBP'],
        );
      }
      await recordHistory(c, fo.id, user.id, null, 'proposed', i.cover_note ?? null);
      await notify(c, ev.organizer_id, {
        kind: 'official_assignment',
        title: 'Official proposal received',
        body: `A licensed ${i.role} proposed themselves for ${ev.name}. Review their profile and accept or decline.`,
        data: { fixture_id: f.id, official_id: fo.id, needs_review: true },
      });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

// ─── confirm_official_proposal ────────────────────────────────────────────────
cap({
  name: 'confirm_official_proposal',
  method: 'POST', path: '/official-assignments/:id/confirm-proposal', tag: 'Officials',
  summary: 'Organiser accepts a proposed assignment: moves proposed → accepted and notifies the official. Eligibility is re-checked at accept time.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      await eventForOrganizer(user, f.event_id, c);
      if (fo.status !== 'proposed') throw conflict(`Assignment is ${fo.status} — only proposed assignments can be accepted this way`);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      await lockOfficial(c, fo.user_id);
      await assertOfficialEligible(c, {
        event: ev, fixtureId: f.id, userId: fo.user_id, role: fo.role,
        start: f.scheduled_at, durationMin: f.duration_min,
      });
      await c.query(
        "UPDATE fixture_officials SET status='accepted', responded_at=now(), needs_ack=false WHERE id=$1",
        [fo.id],
      );
      await recordHistory(c, fo.id, user.id, 'proposed', 'accepted', 'Organiser accepted proposal');
      if (fo.role === 'referee') await c.query('UPDATE fixtures SET referee_id=$2 WHERE id=$1', [f.id, fo.user_id]);
      await c.query(
        `INSERT INTO associations(user_id, role, target_type, target_id, status, invited_by, started_at)
         SELECT $1,$2,'game',g.id,'active',$4,now() FROM games g WHERE g.fixture_id=$3 ON CONFLICT DO NOTHING`,
        [fo.user_id, fo.role, f.id, user.id],
      );
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'Proposal accepted',
        body: `Your proposal to officiate as ${fo.role} for ${ev.name} was accepted. You are now on the crew.`,
        data: { fixture_id: f.id, official_id: fo.id },
      });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

// ─── decline_official_proposal ────────────────────────────────────────────────
cap({
  name: 'decline_official_proposal',
  method: 'POST', path: '/official-assignments/:id/decline-proposal', tag: 'Officials',
  summary: 'Organiser declines a proposed assignment with a reason. The official is notified.',
  input: z.object({ id, reason: reason500 }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      await eventForOrganizer(user, f.event_id, c);
      if (fo.status !== 'proposed') throw conflict(`Assignment is ${fo.status}`);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      await closeOfficial(c, fo, user.id, 'declined', i.reason);
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'Proposal declined',
        body: `Your proposal to officiate as ${fo.role} for ${ev.name} was not accepted.`,
        data: { fixture_id: f.id, official_id: fo.id },
      });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

// ─── confirm_fixture_crew ─────────────────────────────────────────────────────
cap({
  name: 'confirm_fixture_crew',
  method: 'POST', path: '/fixtures/:id/officials/confirm-crew', tag: 'Officials',
  summary: 'Organiser confirms the full crew for a fixture: all accepted (and any confirmed) officials move to confirmed. Each official is notified. Can be called once all required roles are accepted, or as a partial confirm.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = await lockedFixture(c, i.id);
      if (!f) throw notFound('fixture');
      await eventForOrganizer(user, f.event_id, c);
      if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      const accepted = (await c.query(
        "SELECT * FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' FOR UPDATE",
        [i.id],
      )).rows;
      if (!accepted.length) throw conflict('No accepted officials to confirm — invite and have them accept first');
      await c.query(
        `UPDATE fixture_officials SET status='confirmed', confirmed_at=now(), confirmed_by=$2
          WHERE fixture_id=$1 AND status='accepted'`,
        [i.id, user.id],
      );
      for (const fo of accepted) {
        await recordHistory(c, fo.id, user.id, 'accepted', 'confirmed', 'Crew confirmed by organiser');
        await notify(c, fo.user_id, {
          kind: 'official_assignment',
          title: 'Crew confirmed',
          body: `You are confirmed as ${fo.role} for ${ev.name}. The full crew is now locked in.`,
          data: { fixture_id: f.id, official_id: fo.id },
        });
      }
      return { confirmed: accepted.length, fixture_id: i.id };
    });
  },
});

// ─── replace_fixture_official ─────────────────────────────────────────────────
cap({
  name: 'replace_fixture_official',
  method: 'POST', path: '/official-assignments/:id/replace', tag: 'Officials',
  summary: 'Organiser replaces an official before match day (withdrawn, released, or still-invited). Marks the existing assignment as replaced and optionally invites a replacement. If replacement_user_id is omitted, the organiser selects one from the board.',
  input: z.object({
    id,
    reason: reason500,
    replacement_user_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      await eventForOrganizer(user, f.event_id, c);
      if (!['invited', 'proposed', 'accepted', 'confirmed', 'withdrawn'].includes(fo.status)) {
        throw conflict(`Cannot replace an assignment with status ${fo.status}`);
      }
      if (f.status === 'live') throw conflict('Use emergency substitution (officials-crew) for a live match');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      // Close the existing assignment as replaced
      await closeOfficial(c, fo, user.id, 'replaced', i.reason);
      // Notify the replaced official
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'You have been replaced',
        body: `Your ${fo.role} assignment for ${ev.name} has been replaced by the organiser. Reason: ${i.reason}`,
        data: { fixture_id: f.id, official_id: fo.id },
      });
      let replacement = null;
      if (i.replacement_user_id) {
        // Inline invite the replacement and link via replace_of
        await lockOfficial(c, i.replacement_user_id);
        await assertOfficialEligible(c, {
          event: ev, fixtureId: f.id, userId: i.replacement_user_id, role: fo.role,
          start: f.scheduled_at, durationMin: f.duration_min, mode: 'invite',
        });
        replacement = (await c.query(
          `INSERT INTO fixture_officials(fixture_id, user_id, role, status, requested_by, replace_of)
           VALUES ($1,$2,$3,'invited',$4,$5) RETURNING *`,
          [f.id, i.replacement_user_id, fo.role, user.id, fo.id],
        )).rows[0];
        await recordHistory(c, replacement.id, user.id, null, 'invited', `Replacement for ${fo.id}`);
        await notify(c, i.replacement_user_id, {
          kind: 'official_assignment',
          title: 'Officiating request (replacement)',
          body: `${ev.name}: you are asked to replace as ${fo.role}.`,
          data: { fixture_id: f.id, official_id: replacement.id },
        });
      }
      return { replaced: fo.id, replacement: replacement?.id ?? null, fixture_id: f.id };
    });
  },
});

// ─── expire_official_assignments ─────────────────────────────────────────────
cap({
  name: 'expire_official_assignments',
  method: 'POST', path: '/official-assignments/expire', tag: 'Officials',
  summary: 'Admin/system sweep: expire all invited or proposed assignments whose invitation_deadline has passed. Safe to call repeatedly (idempotent). Returns the count of expired assignments.',
  input: z.object({}),
  async handler({ user }) {
    if (!isAdmin(user)) throw forbidden('Admin only');
    return tx(async (c) => {
      const count = await expireOverdue(c);
      return { expired: count };
    });
  },
});

// ─── acknowledge_schedule_change ──────────────────────────────────────────────
cap({
  name: 'acknowledge_schedule_change',
  method: 'POST', path: '/official-assignments/:id/acknowledge', tag: 'Officials',
  summary: 'Official explicitly acknowledges a changed schedule (time or venue). Clears needs_ack, records ack_at and the who/when in history. The official must be accepted or confirmed and needs_ack must be true.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      if (fo.user_id !== user.id) throw forbidden('This assignment is not yours');
      if (!['accepted', 'confirmed'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);
      if (!fo.needs_ack) throw conflict('No schedule change is pending acknowledgement on this assignment');
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [f.event_id])).rows[0];
      await lockOfficial(c, user.id);
      // Re-check eligibility at the new time
      await assertOfficialEligible(c, {
        event: ev, fixtureId: f.id, userId: user.id, role: fo.role,
        start: f.scheduled_at, durationMin: f.duration_min,
      });
      await c.query(
        'UPDATE fixture_officials SET needs_ack=false, ack_at=now() WHERE id=$1', [fo.id],
      );
      await recordHistory(c, fo.id, user.id, fo.status, fo.status, `Acknowledged: ${fo.ack_required_reason ?? 'schedule change'}`);
      await notify(c, ev.organizer_id, {
        kind: 'official_assignment',
        title: 'Official acknowledged change',
        body: `${fo.role} acknowledged the schedule change for ${ev.name} and remains on the crew.`,
        data: { fixture_id: f.id, official_id: fo.id },
      });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});

// ─── get_organiser_officials_inbox ────────────────────────────────────────────
cap({
  name: 'get_organiser_officials_inbox',
  method: 'GET', path: '/me/organiser/officials/inbox', tag: 'Officials',
  summary: 'The event organiser\'s unified assignment inbox: proposals to review, withdrawals needing replacement, expired slots, pending acknowledgements, and a recent activity feed. Grouped by action type, most urgent first.',
  input: z.object({ event_id: id.optional(), limit_per_group: z.number().int().min(1).max(50).default(20) }),
  async handler({ user }, i) {
    const baseWhere = i.event_id
      ? 'e.organizer_id=$1 AND e.id=$2'
      : 'e.organizer_id=$1';
    const args = i.event_id ? [user.id, i.event_id] : [user.id];
    const n = args.length;

    const baseJoin = `
      FROM fixture_officials fo
      JOIN fixtures f ON f.id=fo.fixture_id
      JOIN events e ON e.id=f.event_id
      JOIN users u ON u.id=fo.user_id
      WHERE ${baseWhere}`;

    // Proposals awaiting organiser decision
    const proposals = await many(
      `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.reason AS cover_note, fo.fee_minor, fo.fee_currency, fo.created_at,
              u.id AS user_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, u.avatar_url,
              f.scheduled_at, e.id AS event_id, e.name AS event_name, e.sport_id,
              s.name AS sport_name, s.emoji AS sport_emoji
       ${baseJoin} AND fo.status='proposed'
       JOIN sports s ON s.id=e.sport_id
       ORDER BY fo.created_at DESC LIMIT ${n + 1}`, [...args, i.limit_per_group],
    );

    // Withdrawn/released that still have the fixture upcoming (need replacement)
    const needReplacement = await many(
      `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.reason, fo.ended_at,
              u.id AS user_id, u.display_name, u.handle,
              f.scheduled_at, e.id AS event_id, e.name AS event_name
       ${baseJoin} AND fo.status IN ('withdrawn','released','replaced')
         AND f.status IN ('scheduled','postponed') AND f.scheduled_at > now()
       ORDER BY f.scheduled_at ASC LIMIT ${n + 1}`, [...args, i.limit_per_group],
    );

    // Expired invitations where the fixture is still upcoming
    const expired = await many(
      `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.ended_at,
              u.id AS user_id, u.display_name, u.handle,
              f.scheduled_at, e.id AS event_id, e.name AS event_name
       ${baseJoin} AND fo.status='expired' AND f.status IN ('scheduled','postponed') AND f.scheduled_at > now()
       ORDER BY f.scheduled_at ASC LIMIT ${n + 1}`, [...args, i.limit_per_group],
    );

    // Accepted/confirmed officials with pending acks
    const ackPending = await many(
      `SELECT fo.id, fo.fixture_id, fo.role, fo.status, fo.ack_required_reason, fo.needs_ack,
              u.id AS user_id, u.display_name, u.handle,
              f.scheduled_at, e.id AS event_id, e.name AS event_name
       ${baseJoin} AND fo.status IN ('accepted','confirmed') AND fo.needs_ack=true
         AND f.status IN ('scheduled','postponed')
       ORDER BY f.scheduled_at ASC LIMIT ${n + 1}`, [...args, i.limit_per_group],
    );

    // Metrics
    const metrics = (await one(
      `SELECT
         count(*) FILTER (WHERE fo.status='invited') AS awaiting,
         count(*) FILTER (WHERE fo.status='proposed') AS proposals,
         count(*) FILTER (WHERE fo.status='accepted') AS accepted_not_confirmed,
         count(*) FILTER (WHERE fo.status='confirmed') AS confirmed,
         count(*) FILTER (WHERE fo.status='expired' AND f.scheduled_at > now()) AS expired_unfilled,
         count(*) FILTER (WHERE fo.status IN ('accepted','confirmed') AND fo.needs_ack=true) AS ack_pending,
         count(*) FILTER (WHERE fo.status IN ('withdrawn','released') AND f.scheduled_at > now() AND f.status NOT IN ('completed','cancelled')) AS needs_replacement
       FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id
       WHERE ${baseWhere}`, args,
    )) ?? {};

    // Recent activity (last 48 h)
    const activity = await many(
      `SELECT h.id, h.from_status, h.to_status, h.reason, h.at, h.actor_id,
              fo.fixture_id, fo.role, e.name AS event_name,
              u.display_name AS official_name, u.handle AS official_handle
       FROM fixture_official_history h
       JOIN fixture_officials fo ON fo.id=h.fixture_official_id
       JOIN fixtures f ON f.id=fo.fixture_id
       JOIN events e ON e.id=f.event_id
       JOIN users u ON u.id=fo.user_id
       WHERE e.organizer_id=$1 ${i.event_id ? 'AND e.id=$2' : ''} AND h.at > now() - interval '48 hours'
       ORDER BY h.at DESC LIMIT 25`, i.event_id ? [user.id, i.event_id] : [user.id],
    );

    return { proposals, needs_replacement: needReplacement, expired, ack_pending: ackPending, activity, metrics };
  },
});

// ─── get_official_assignment_detail ──────────────────────────────────────────
cap({
  name: 'get_official_assignment_detail',
  method: 'GET', path: '/official-assignments/:id', tag: 'Officials',
  summary: 'Full detail for one assignment: state, deadline, history, fixture, event, pay status. Officials see their own row in full; organisers see any assignment on their events.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const fo = (await one(
      `SELECT fo.*, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, u.avatar_url,
              f.scheduled_at, f.duration_min, f.status AS fixture_status, f.home_team_id, f.away_team_id,
              e.id AS event_id, e.name AS event_name, e.organizer_id, e.sport_id,
              s.name AS sport_name, s.emoji AS sport_emoji,
              h_team.name AS home_name, a_team.name AS away_name,
              ve.name AS venue_name, ve.city AS venue_city
       FROM fixture_officials fo
       JOIN users u ON u.id=fo.user_id
       JOIN fixtures f ON f.id=fo.fixture_id
       JOIN events e ON e.id=f.event_id
       JOIN sports s ON s.id=e.sport_id
       LEFT JOIN teams h_team ON h_team.id=f.home_team_id
       LEFT JOIN teams a_team ON a_team.id=f.away_team_id
       LEFT JOIN resources r ON r.id=f.resource_id
       LEFT JOIN venues ve ON ve.id=r.venue_id
       WHERE fo.id=$1`, [i.id],
    ));
    if (!fo) throw notFound('official assignment');
    const isOwn = fo.user_id === user.id;
    const isOrg = isAdmin(user) || fo.organizer_id === user.id;
    if (!isOwn && !isOrg) throw forbidden('Not your assignment or event');
    const history = await many(
      `SELECT h.id, h.from_status, h.to_status, h.reason, h.at, h.actor_id,
              u.display_name AS actor_name
       FROM fixture_official_history h LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.fixture_official_id=$1 ORDER BY h.at, h.id`, [i.id],
    );
    // Organiser seeing someone else: mask personal fields
    if (!isOwn && !isAdmin(user)) {
      delete fo.fee_minor; delete fo.fee_currency; delete fo.pay_status;
    }
    return { ...fo, history };
  },
});

// ─── set_invitation_deadline ──────────────────────────────────────────────────
cap({
  name: 'set_invitation_deadline',
  method: 'POST', path: '/official-assignments/:id/deadline', tag: 'Officials',
  summary: 'Organiser sets or updates the deadline by which an invited/proposed official must respond. Defaults are not enforced server-side; use this to record a deadline and trigger warnings.',
  input: z.object({ id, deadline: z.string().datetime({ offset: true }), reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT fixture_id FROM fixture_officials WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('official assignment');
      const f = await lockedFixture(c, probe.fixture_id);
      const fo = await getFo(c, i.id);
      await eventForOrganizer(user, f.event_id, c);
      if (!['invited', 'proposed'].includes(fo.status)) throw conflict(`Assignment is ${fo.status} — can only set deadline on invited or proposed`);
      const dl = new Date(i.deadline);
      if (dl <= new Date()) throw badRequest('Deadline must be in the future');
      if (new Date(f.scheduled_at) < dl) throw badRequest('Deadline must be before the fixture start');
      await c.query(
        'UPDATE fixture_officials SET invitation_deadline=$2, deadline_notified_at=NULL WHERE id=$1', [fo.id, i.deadline],
      );
      await recordHistory(c, fo.id, user.id, fo.status, fo.status, `Deadline set: ${i.deadline}${i.reason ? ` — ${i.reason}` : ''}`);
      await notify(c, fo.user_id, {
        kind: 'official_assignment',
        title: 'Response deadline set',
        body: `The organiser has set a deadline of ${new Date(i.deadline).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} for your ${fo.role} invitation.`,
        data: { fixture_id: f.id, official_id: fo.id },
      });
      return (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [fo.id])).rows[0];
    });
  },
});
