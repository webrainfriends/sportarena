// Sports medicine & RTP (issue #584): coach-safe injury availability views.
// Coaches, team owners and managers see ONLY: availability status, expected return range, and
// load restrictions from an approved RTP decision. Zero diagnosis, zero body region, zero
// clinical notes, zero provider identity is ever returned from these endpoints.
// Shares are athlete- or clinician-initiated and revocable at any time.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt } from '../crypto.js';
import { hasGrant } from './medical.js';
import { hasRole } from '../helpers.js';

const TAG = 'Team injury status';
const COACH_ROLES = ['coach', 'manager', 'team_owner', 'team_manager', 'assistant_coach'];

/** Confirm user is a team staff member with one of the coaching roles. */
async function requireTeamStaff(userId, teamId) {
  const row = await one(
    `SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND left_at IS NULL
     AND role IN ('owner','manager','coach','assistant_coach','team_manager','admin')`,
    [teamId, userId],
  ).catch(() => null);
  if (!row) throw forbidden('You are not a staff member of this team');
}

cap({
  name: 'share_episode_with_team',
  method: 'POST',
  path: '/injury-episodes/:id/coach-share',
  tag: TAG,
  auth: ['athlete', 'physio', 'doctor'],
  status: 201,
  summary:
    'Athlete or consented clinician opts a team in to see minimal injury availability info: ' +
    'expected return date and (optionally) load restrictions from the most recent approved RTP decision. ' +
    'Zero clinical detail — no diagnosis, body region, mechanism, severity, provider name or clinical notes — ' +
    'is ever included. The share can be revoked at any time.',
  input: z.object({
    id,
    team_id: id,
    show_expected_return: z.boolean().default(true),
    show_restrictions: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id, status FROM injury_episodes WHERE id=$1 AND archived_at IS NULL', [i.id]).catch(() => null);
    if (!ep) throw notFound('Episode');
    if (ep.status === 'cancelled' || ep.status === 'closed') throw badRequest('Cannot share a closed or cancelled episode');

    const isAthlete = user.id === ep.athlete_id;
    if (!isAthlete) {
      // Clinician must have active full consent
      if (!hasRole(user, 'physio', 'doctor')) throw forbidden('Only the athlete or their clinician can share an episode');
      if (!(await hasGrant(ep.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    }

    // Verify the team exists and athlete or clinician is connected to it
    const team = await one('SELECT id FROM teams WHERE id=$1 AND archived_at IS NULL', [i.team_id]).catch(() => null);
    if (!team) throw notFound('Team');

    const r = await tx(async (c) => {
      // Upsert: revive if previously revoked
      const existing = (await c.query(
        'SELECT id, revoked_at FROM injury_episode_coach_shares WHERE episode_id=$1 AND team_id=$2',
        [i.id, i.team_id],
      )).rows[0];
      if (existing && !existing.revoked_at) throw badRequest('Already shared with this team');
      let row;
      if (existing) {
        row = (await c.query(
          `UPDATE injury_episode_coach_shares
           SET revoked_at=NULL, shared_by=$3, show_expected_return=$4, show_restrictions=$5
           WHERE id=$1 RETURNING id, episode_id, team_id, show_expected_return, show_restrictions, created_at`,
          [existing.id, i.id, user.id, i.show_expected_return, i.show_restrictions],
        )).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO injury_episode_coach_shares(episode_id, team_id, shared_by, show_expected_return, show_restrictions)
           VALUES($1,$2,$3,$4,$5) RETURNING id, episode_id, team_id, show_expected_return, show_restrictions, created_at`,
          [i.id, i.team_id, user.id, i.show_expected_return, i.show_restrictions],
        )).rows[0];
      }
      return row;
    });
    await audit(null, user.id, 'write_episode_share', 'injury_episode_coach_shares', r.id);
    return r;
  },
});

cap({
  name: 'revoke_episode_share',
  method: 'DELETE',
  path: '/injury-episodes/:id/coach-share/:teamId',
  tag: TAG,
  auth: ['athlete', 'physio', 'doctor'],
  summary: 'Revoke a team\'s access to injury availability info. Takes effect immediately.',
  input: z.object({ id, teamId: id }),
  async handler({ user }, i) {
    const ep = await one('SELECT athlete_id FROM injury_episodes WHERE id=$1 AND archived_at IS NULL', [i.id]).catch(() => null);
    if (!ep) throw notFound('Episode');
    const isAthlete = user.id === ep.athlete_id;
    if (!isAthlete) {
      if (!hasRole(user, 'physio', 'doctor')) throw forbidden('Only the athlete or their clinician can revoke a share');
      if (!(await hasGrant(ep.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    }
    const share = await one(
      'SELECT id FROM injury_episode_coach_shares WHERE episode_id=$1 AND team_id=$2 AND revoked_at IS NULL',
      [i.id, i.teamId],
    ).catch(() => null);
    if (!share) throw notFound('Share');
    await one(
      'UPDATE injury_episode_coach_shares SET revoked_at=now() WHERE id=$1 RETURNING id',
      [share.id],
    );
    await audit(null, user.id, 'write_episode_share', 'injury_episode_coach_shares', share.id);
    return { revoked: true };
  },
});

cap({
  name: 'get_team_injury_status',
  method: 'GET',
  path: '/teams/:teamId/injury-status',
  tag: TAG,
  auth: COACH_ROLES,
  summary:
    'Team coaching staff view of current injury availability for each active member. ' +
    'Returns ONLY: member user ID, display name, availability status, expected return date ' +
    '(when shared), and load restrictions (when an approved RTP decision was shared). ' +
    'Zero clinical detail — no diagnosis, body region, mechanism, severity, clinical notes or ' +
    'provider identity — is ever included. Only episodes the athlete or their clinician ' +
    'explicitly shared with this team are shown.',
  input: z.object({ teamId: id }),
  async handler({ user }, i) {
    await requireTeamStaff(user.id, i.teamId);

    const rows = await many(
      `SELECT
         u.id AS user_id,
         u.display_name,
         tm.availability,
         ie.id AS episode_id,
         ie.status AS episode_status,
         ie.expected_return_on,
         ecs.show_expected_return,
         ecs.show_restrictions,
         rtp.load_restrictions_enc,
         rtp.valid_until AS rtp_valid_until
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN injury_episode_coach_shares ecs ON ecs.team_id = $1 AND ecs.revoked_at IS NULL
       LEFT JOIN injury_episodes ie ON ie.id = ecs.episode_id AND ie.athlete_id = tm.user_id
                                    AND ie.archived_at IS NULL
                                    AND ie.status NOT IN ('closed','cancelled')
       LEFT JOIN LATERAL (
         SELECT load_restrictions_enc, valid_until
         FROM injury_rtp_approvals
         WHERE episode_id = ie.id AND status = 'approved' AND revoked_at IS NULL
           AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
         ORDER BY created_at DESC LIMIT 1
       ) rtp ON true
       WHERE tm.team_id = $1 AND tm.left_at IS NULL
         AND tm.availability = 'injured'
       ORDER BY u.display_name`,
      [i.teamId],
    );

    await audit(null, user.id, 'read_team_injury_status', 'injury_episode_coach_shares', i.teamId);

    return rows.map((r) => ({
      user_id: r.user_id,
      display_name: r.display_name,
      availability: r.availability,
      episode_status: r.episode_id ? r.episode_status : null,
      expected_return_on: r.episode_id && r.show_expected_return ? r.expected_return_on : null,
      load_restrictions: r.show_restrictions && r.load_restrictions_enc
        ? (() => {
            try { return JSON.parse(decrypt(r.load_restrictions_enc, 'injury_rtp_approvals.load_restrictions')); }
            catch { return []; }
          })()
        : [],
      rtp_valid_until: r.show_restrictions ? r.rtp_valid_until : null,
    }));
  },
});

cap({
  name: 'get_athlete_availability_detail',
  method: 'GET',
  path: '/teams/:teamId/members/:userId/availability-detail',
  tag: TAG,
  auth: COACH_ROLES,
  summary:
    'Coach/manager: detailed availability for one team member currently marked injured. ' +
    'Returns all shared episodes for this athlete in this team context, with status, ' +
    'expected return, and any load restrictions from approved RTP decisions. ' +
    'No clinical detail is ever exposed.',
  input: z.object({ teamId: id, userId: id }),
  async handler({ user }, i) {
    await requireTeamStaff(user.id, i.teamId);

    // Confirm member is on this team
    const member = await one(
      'SELECT user_id, display_name, availability FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 AND tm.user_id=$2 AND tm.left_at IS NULL',
      [i.teamId, i.userId],
    ).catch(() => null);
    if (!member) throw notFound('Team member');

    const episodes = await many(
      `SELECT
         ie.id, ie.status, ie.expected_return_on, ie.occurred_on,
         ecs.show_expected_return, ecs.show_restrictions,
         rtp.load_restrictions_enc, rtp.valid_until AS rtp_valid_until,
         rtp.conditions_enc
       FROM injury_episode_coach_shares ecs
       JOIN injury_episodes ie ON ie.id = ecs.episode_id AND ie.athlete_id = $2
                                AND ie.archived_at IS NULL
       LEFT JOIN LATERAL (
         SELECT load_restrictions_enc, valid_until, conditions_enc
         FROM injury_rtp_approvals
         WHERE episode_id = ie.id AND status IN ('approved','conditional')
           AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) rtp ON true
       WHERE ecs.team_id = $1 AND ecs.revoked_at IS NULL
         AND ie.status NOT IN ('closed','cancelled')
       ORDER BY ie.occurred_on DESC`,
      [i.teamId, i.userId],
    );

    await audit(null, user.id, 'read_team_injury_status', 'injury_episode_coach_shares', i.userId);

    return {
      user_id: member.user_id,
      display_name: member.display_name,
      availability: member.availability,
      episodes: episodes.map((ep) => ({
        id: ep.id,
        status: ep.status,
        occurred_on: ep.occurred_on,
        expected_return_on: ep.show_expected_return ? ep.expected_return_on : null,
        load_restrictions: ep.show_restrictions && ep.load_restrictions_enc
          ? (() => {
              try { return JSON.parse(decrypt(ep.load_restrictions_enc, 'injury_rtp_approvals.load_restrictions')); }
              catch { return []; }
            })()
          : [],
        rtp_valid_until: ep.show_restrictions ? ep.rtp_valid_until : null,
        conditions: ep.show_restrictions && ep.conditions_enc
          ? decrypt(ep.conditions_enc, 'injury_rtp_approvals.conditions')
          : null,
      })),
    };
  },
});
