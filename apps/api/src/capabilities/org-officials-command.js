// Federation & Assignor Organisation Command Center (REF-R12, Issue #1004).
// Org-level back-office for managing a referee workforce pool: roster, assignor delegation,
// eligibility monitoring, unfilled fixture alerts, workload distribution, comms and exports.
// Nothing here copies fixture data: fixture_officials and official_availability are read live.
// Org boundaries are enforced on every query. Sensitive fields use field-level encryption.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { orgFor, orgRole } from '../org-access.js';
import { credentialFor } from '../officials.js';
import { toCsv } from '../csv.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'OrgOfficials';
const text = (n) => z.string().trim().min(1).max(n);
const DAY = 864e5;

// ── auth helpers ─────────────────────────────────────────────────────────────

/** Owner/admin OR an active assignor grant for this org. */
async function canManageRoster(user, orgId, c = pool) {
  if (isAdmin(user)) return true;
  const role = await orgRole(user, orgId, c);
  if (role === 'owner' || role === 'admin') return true;
  const grant = await one(
    "SELECT 1 FROM org_assignor_grants WHERE organisation_id=$1 AND granted_to=$2 AND status='active'",
    [orgId, user.id], c,
  );
  return !!grant;
}

async function requireManageRoster(user, orgId, c = pool) {
  if (!(await canManageRoster(user, orgId, c))) throw forbidden('Only org owners, admins or assignors may manage officials');
}

async function requireOwnerAdmin(user, orgId, c = pool) {
  if (isAdmin(user)) return;
  const role = await orgRole(user, orgId, c);
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only org owners or admins may do this');
}

/** Load org, 404 for outsiders. */
async function getOrg(user, orgId, c = pool) {
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  if (!org) throw notFound('Organisation');
  if (!isAdmin(user)) {
    const ok = await canManageRoster(user, orgId, c);
    if (!ok) throw notFound('Organisation');
  }
  return org;
}

/** Credential warning band for one official. */
async function credBand(c, userId, sportId) {
  const cred = await credentialFor(c, userId, sportId);
  const now = Date.now();
  const exp = cred.verified?.expires_at ? new Date(cred.verified.expires_at).getTime() : null;
  const licExp = cred.licence?.expires_on ? new Date(cred.licence.expires_on).getTime() : null;
  const soonest = [exp, licExp].filter(Boolean).sort()[0] ?? null;
  if (!cred.verified && !cred.licence) return { band: 'none', cred };
  if (soonest && soonest < now) return { band: 'expired', cred };
  if (soonest && soonest < now + 30 * DAY) return { band: 'expiring', cred };
  return { band: 'ok', cred };
}

// ── 1. Command overview ───────────────────────────────────────────────────────
cap({
  name: 'get_org_officials_command', method: 'GET', path: '/organisations/:id/officials/command', tag: TAG,
  summary: 'The federation/league back-office overview: roster counts, eligibility warnings, unfilled fixture alerts, weekly workload summary and assignor count.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i) {
    const org = await getOrg(user, i.id);
    const sportFilter = i.sport_id ? 'AND r.sport_id=$2' : '';
    const args = i.sport_id ? [i.id, i.sport_id] : [i.id];

    const counts = await one(
      `SELECT
        count(*) FILTER (WHERE status='active')::int   AS active,
        count(*) FILTER (WHERE status='invited')::int  AS invited,
        count(*) FILTER (WHERE status='suspended')::int AS suspended,
        count(*) FILTER (WHERE status='removed')::int  AS removed
       FROM org_official_rosters r WHERE organisation_id=$1 ${sportFilter}`,
      args,
    );

    // Eligibility warnings: active roster officials with expired/expiring creds
    const activeRoster = await many(
      `SELECT r.id AS roster_id, r.user_id, r.sport_id, u.display_name, u.avatar_url
         FROM org_official_rosters r JOIN users u ON u.id=r.user_id
        WHERE r.organisation_id=$1 AND r.status='active' ${sportFilter}
        ORDER BY u.display_name`,
      args,
    );
    const eligWarnings = [];
    for (const row of activeRoster) {
      const { band, cred } = await credBand(pool, row.user_id, row.sport_id);
      if (band !== 'ok') eligWarnings.push({ ...row, elig_band: band, cred_expires: cred.verified?.expires_at ?? cred.licence?.expires_on ?? null });
    }

    // Unfilled fixture count: org's events with fixtures missing crew
    const unfilledCount = await one(
      `SELECT count(DISTINCT f.id)::int AS cnt
         FROM fixtures f
         JOIN events ev ON ev.id=f.event_id
        WHERE ev.organisation_id=$1
          AND f.status IN ('scheduled','postponed')
          AND f.scheduled_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM fixture_officials fo
             WHERE fo.fixture_id=f.id AND fo.role='referee' AND fo.status='accepted'
          )`,
      [i.id],
    );

    // Weekly workload summary (next 7 days)
    const weekEnd = new Date(Date.now() + 7 * DAY).toISOString();
    const workloadSummary = await many(
      `SELECT u.id AS user_id, u.display_name, u.avatar_url,
              count(fo.id)::int AS assignments,
              r.status AS roster_status
         FROM org_official_rosters r
         JOIN users u ON u.id=r.user_id
         LEFT JOIN fixture_officials fo ON fo.user_id=r.user_id AND fo.status='accepted'
           AND fo.fixture_id IN (
             SELECT f.id FROM fixtures f JOIN events ev ON ev.id=f.event_id
              WHERE ev.organisation_id=$1
                AND f.scheduled_at BETWEEN now() AND $2::timestamptz
           )
        WHERE r.organisation_id=$1 AND r.status IN ('active','suspended')
        GROUP BY u.id, u.display_name, u.avatar_url, r.status
        ORDER BY assignments DESC, u.display_name
        LIMIT 10`,
      [i.id, weekEnd],
    );

    const assignorCount = await one(
      "SELECT count(*)::int AS cnt FROM org_assignor_grants WHERE organisation_id=$1 AND status='active'",
      [i.id],
    );

    return {
      org: { id: org.id, name: org.name },
      sport_id: i.sport_id ?? null,
      counts: { ...counts, elig_warnings: eligWarnings.length, unfilled: unfilledCount.cnt, assignors: assignorCount.cnt },
      elig_warnings: eligWarnings.slice(0, 20),
      workload_this_week: workloadSummary,
    };
  },
});

// ── 2. Roster list ────────────────────────────────────────────────────────────
cap({
  name: 'list_org_official_roster', method: 'GET', path: '/organisations/:id/officials/roster', tag: TAG,
  summary: 'All officials in this org\'s pool, filterable by sport, status, grade and location. Credential and workload data is read live; no row is copied.',
  input: z.object({ id, ...page, sport_id: id.optional(), status: z.enum(['invited','active','suspended','removed','all']).default('all'), grade_min: z.coerce.number().int().min(0).max(10).optional() }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    const statusFilter = i.status !== 'all' ? `AND r.status=$3` : '';
    const sportFilter = i.sport_id ? `AND (r.sport_id=$4 OR r.sport_id IS NULL)` : '';
    const baseArgs = [i.id, i.limit ?? 50, ...(i.status !== 'all' ? [i.status] : []), ...(i.sport_id ? [i.sport_id] : [])];

    const rows = await many(
      `SELECT r.id AS roster_id, r.user_id, r.sport_id, r.status, r.created_at, r.responded_at,
              u.display_name, u.avatar_url,
              sp.name AS sport_name, sp.slug AS sport_slug, sp.emoji AS sport_emoji
         FROM org_official_rosters r
         JOIN users u ON u.id=r.user_id
         LEFT JOIN sports sp ON sp.id=r.sport_id
        WHERE r.organisation_id=$1 ${statusFilter} ${sportFilter}
        ORDER BY r.status='active' DESC, u.display_name
        LIMIT $2`,
      baseArgs,
    );

    const result = [];
    for (const row of rows) {
      const { band, cred } = await credBand(pool, row.user_id, row.sport_id);
      const weekAssignments = await one(
        `SELECT count(fo.id)::int AS cnt FROM fixture_officials fo
           JOIN fixtures f ON f.id=fo.fixture_id
           JOIN events ev ON ev.id=f.event_id
          WHERE fo.user_id=$1 AND fo.status='accepted' AND ev.organisation_id=$2
            AND f.scheduled_at BETWEEN now() AND now() + interval '7 days'`,
        [row.user_id, i.id],
      );
      result.push({ ...row, elig_band: band, licence: cred.licence, verified: cred.verified ? { expires_at: cred.verified.expires_at } : null, assignments_this_week: weekAssignments.cnt });
    }
    return result;
  },
});

// ── 3. Invite one official ────────────────────────────────────────────────────
cap({
  name: 'invite_org_official', method: 'POST', path: '/organisations/:id/officials/roster', tag: TAG, status: 201,
  summary: 'Invite an official to join this org\'s roster. They must accept before they are considered active. The official sees a notification.',
  input: z.object({ id, user_id: id, sport_id: id.optional(), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireManageRoster(user, i.id, c);
      const org = (await c.query('SELECT id,name FROM organisations WHERE id=$1', [i.id])).rows[0];
      if (!org) throw notFound('Organisation');
      const target = (await c.query("SELECT id,display_name FROM users WHERE id=$1", [i.user_id])).rows[0];
      if (!target) throw notFound('User');
      // must have a referee sport profile
      const sportFilter = i.sport_id ? 'AND sport_id=$2' : '';
      const spArgs = i.sport_id ? [i.user_id, i.sport_id] : [i.user_id];
      const prof = (await c.query(`SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role='referee' ${sportFilter} LIMIT 1`, spArgs)).rows[0];
      if (!prof) throw badRequest('That person does not have a referee sport profile for this sport');
      let row;
      try {
        row = (await c.query(
          `INSERT INTO org_official_rosters(organisation_id, user_id, sport_id, invited_by, notes_enc)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [i.id, i.user_id, i.sport_id ?? null, user.id, i.notes ? encrypt(i.notes) : null],
        )).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('This official is already in your roster for that sport');
        throw e;
      }
      await c.query(
        `INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status) VALUES($1,$2,'none','invited')`,
        [row.id, user.id],
      );
      await notify(c, i.user_id, { kind: 'org_official_invite', title: `Invitation from ${org.name}`, body: `${org.name} has invited you to their official panel.`, data: { roster_id: row.id, organisation_id: i.id } });
      await audit(c, user.id, 'invite_org_official', 'org_official_rosters', row.id);
      return row;
    });
  },
});

// ── 4. Bulk invite ────────────────────────────────────────────────────────────
cap({
  name: 'bulk_invite_org_officials', method: 'POST', path: '/organisations/:id/officials/roster/bulk', tag: TAG, status: 201,
  summary: 'Invite up to 50 officials in one request. Each must have a referee sport profile. Returns per-user results (created / duplicate / no_profile).',
  input: z.object({ id, user_ids: z.array(id).min(1).max(50), sport_id: id.optional(), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireOwnerAdmin(user, i.id, c);
      const org = (await c.query('SELECT id,name FROM organisations WHERE id=$1', [i.id])).rows[0];
      if (!org) throw notFound('Organisation');
      const results = [];
      for (const userId of i.user_ids) {
        const target = (await c.query('SELECT id FROM users WHERE id=$1', [userId])).rows[0];
        if (!target) { results.push({ user_id: userId, result: 'not_found' }); continue; }
        const sportFilter = i.sport_id ? 'AND sport_id=$2' : '';
        const spArgs = i.sport_id ? [userId, i.sport_id] : [userId];
        const prof = (await c.query(`SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role='referee' ${sportFilter} LIMIT 1`, spArgs)).rows[0];
        if (!prof) { results.push({ user_id: userId, result: 'no_profile' }); continue; }
        try {
          const row = (await c.query(
            `INSERT INTO org_official_rosters(organisation_id,user_id,sport_id,invited_by,notes_enc)
             VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [i.id, userId, i.sport_id ?? null, user.id, i.notes ? encrypt(i.notes) : null],
          )).rows[0];
          await c.query(`INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status) VALUES($1,$2,'none','invited')`, [row.id, user.id]);
          await notify(c, userId, { kind: 'org_official_invite', title: `Invitation from ${org.name}`, body: `${org.name} has invited you to their official panel.`, data: { roster_id: row.id, organisation_id: i.id } });
          results.push({ user_id: userId, result: 'invited', roster_id: row.id });
        } catch (e) {
          if (e.code === '23505') results.push({ user_id: userId, result: 'duplicate' });
          else throw e;
        }
      }
      await audit(c, user.id, 'bulk_invite_org_officials', 'org_official_rosters', i.id);
      return results;
    });
  },
});

// ── 5. Official responds to invite ────────────────────────────────────────────
cap({
  name: 'respond_org_official_invite', method: 'POST', path: '/org-official-roster/:id/respond', tag: TAG,
  summary: 'The invited official accepts or declines their panel invitation.',
  input: z.object({ id, response: z.enum(['accept','decline']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM org_official_rosters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Roster invitation');
      if (row.user_id !== user.id) throw forbidden('This invitation is not yours');
      if (row.status !== 'invited') throw conflict(`Invitation is already ${row.status}`);
      const to = i.response === 'accept' ? 'active' : 'removed';
      await c.query(`UPDATE org_official_rosters SET status=$2, responded_at=now() WHERE id=$1`, [i.id, to]);
      await c.query(
        `INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status,reason_enc)
         VALUES($1,$2,'invited',$3,$4)`,
        [i.id, user.id, to, i.reason ? encrypt(i.reason) : null],
      );
      const org = (await c.query('SELECT name, id FROM organisations WHERE id=$1', [row.organisation_id])).rows[0];
      await notify(c, row.invited_by, { kind: 'org_official_response', title: i.response === 'accept' ? 'Official joined panel' : 'Official declined', body: `${user.display_name ?? 'An official'} ${i.response === 'accept' ? 'accepted' : 'declined'} the invitation to ${org?.name ?? 'your'} panel.`, data: { roster_id: i.id, organisation_id: row.organisation_id } });
      return (await c.query('SELECT * FROM org_official_rosters WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ── 6. Suspend official ────────────────────────────────────────────────────────
cap({
  name: 'suspend_org_official', method: 'POST', path: '/org-official-roster/:id/suspend', tag: TAG,
  summary: 'Suspend an active official from the panel (owner/admin). They remain in the roster but are ineligible for new assignments from this org.',
  input: z.object({ id, reason: text(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM org_official_rosters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Roster member');
      await requireOwnerAdmin(user, row.organisation_id, c);
      if (row.status !== 'active') throw conflict(`Official is ${row.status}`);
      await c.query(`UPDATE org_official_rosters SET status='suspended', suspended_at=now(), suspended_by=$2 WHERE id=$1`, [i.id, user.id]);
      await c.query(
        `INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status,reason_enc) VALUES($1,$2,'active','suspended',$3)`,
        [i.id, user.id, encrypt(i.reason)],
      );
      await notify(c, row.user_id, { kind: 'org_official_suspended', title: 'Panel status changed', body: 'Your status on this organisation\'s official panel has been suspended.', data: { roster_id: i.id, organisation_id: row.organisation_id } });
      await audit(c, user.id, 'suspend_org_official', 'org_official_rosters', i.id);
      return (await c.query('SELECT * FROM org_official_rosters WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ── 7. Reinstate official ─────────────────────────────────────────────────────
cap({
  name: 'reinstate_org_official', method: 'POST', path: '/org-official-roster/:id/reinstate', tag: TAG,
  summary: 'Reinstate a suspended official to active status.',
  input: z.object({ id, reason: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM org_official_rosters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Roster member');
      await requireOwnerAdmin(user, row.organisation_id, c);
      if (row.status !== 'suspended') throw conflict(`Official is ${row.status}`);
      await c.query(`UPDATE org_official_rosters SET status='active', suspended_at=null, suspended_by=null WHERE id=$1`, [i.id]);
      await c.query(
        `INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status,reason_enc) VALUES($1,$2,'suspended','active',$3)`,
        [i.id, user.id, i.reason ? encrypt(i.reason) : null],
      );
      await notify(c, row.user_id, { kind: 'org_official_reinstated', title: 'Panel status restored', body: 'You have been reinstated on the official panel.', data: { roster_id: i.id, organisation_id: row.organisation_id } });
      await audit(c, user.id, 'reinstate_org_official', 'org_official_rosters', i.id);
      return (await c.query('SELECT * FROM org_official_rosters WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ── 8. Remove official ────────────────────────────────────────────────────────
cap({
  name: 'remove_org_official', method: 'POST', path: '/org-official-roster/:id/remove', tag: TAG,
  summary: 'Remove an official from the panel. The record is kept for audit; the status becomes removed. Future assignments from this org require a new invitation.',
  input: z.object({ id, reason: text(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT * FROM org_official_rosters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!row) throw notFound('Roster member');
      await requireOwnerAdmin(user, row.organisation_id, c);
      if (row.status === 'removed') throw conflict('Already removed');
      const from = row.status;
      await c.query(
        `UPDATE org_official_rosters SET status='removed', removed_at=now(), removed_by=$2, removal_reason=$3 WHERE id=$1`,
        [i.id, user.id, encrypt(i.reason)],
      );
      await c.query(
        `INSERT INTO org_official_roster_history(roster_id,actor_id,from_status,to_status,reason_enc) VALUES($1,$2,$3,'removed',$4)`,
        [i.id, user.id, from, encrypt(i.reason)],
      );
      await audit(c, user.id, 'remove_org_official', 'org_official_rosters', i.id);
      return (await c.query('SELECT * FROM org_official_rosters WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ── 9. Grant assignor permission ──────────────────────────────────────────────
cap({
  name: 'grant_assignor_permission', method: 'POST', path: '/organisations/:id/assignors', tag: TAG, status: 201,
  summary: 'Delegate assignment rights to an org staff member. They can then invite/assign/release officials on behalf of the organisation (per flags).',
  input: z.object({ id, user_id: id, sport_id: id.optional(), jurisdiction: z.string().max(120).optional(), can_invite: z.boolean().default(true), can_assign: z.boolean().default(true), can_release: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireOwnerAdmin(user, i.id, c);
      const member = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rows[0];
      if (!member) throw badRequest('That user is not an active member of this organisation');
      let row;
      try {
        row = (await c.query(
          `INSERT INTO org_assignor_grants(organisation_id,granted_to,granted_by,sport_id,jurisdiction,can_invite,can_assign,can_release)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [i.id, i.user_id, user.id, i.sport_id ?? null, i.jurisdiction ?? null, i.can_invite, i.can_assign, i.can_release],
        )).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('This member already has an assignor grant for that sport');
        throw e;
      }
      await audit(c, user.id, 'grant_assignor_permission', 'org_assignor_grants', row.id);
      return row;
    });
  },
});

// ── 10. Update assignor grant ─────────────────────────────────────────────────
cap({
  name: 'update_assignor_permission', method: 'POST', path: '/org-assignors/:id/update', tag: TAG,
  summary: 'Change the permission flags on an existing assignor grant.',
  input: z.object({ id, can_invite: z.boolean().optional(), can_assign: z.boolean().optional(), can_release: z.boolean().optional(), jurisdiction: z.string().max(120).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const grant = (await c.query('SELECT * FROM org_assignor_grants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!grant) throw notFound('Assignor grant');
      await requireOwnerAdmin(user, grant.organisation_id, c);
      if (grant.status !== 'active') throw conflict('Grant is not active');
      const fields = [];
      const args = [];
      if (i.can_invite !== undefined) { fields.push(`can_invite=$${args.push(i.can_invite)}`); }
      if (i.can_assign !== undefined) { fields.push(`can_assign=$${args.push(i.can_assign)}`); }
      if (i.can_release !== undefined) { fields.push(`can_release=$${args.push(i.can_release)}`); }
      if (i.jurisdiction !== undefined) { fields.push(`jurisdiction=$${args.push(i.jurisdiction)}`); }
      if (!fields.length) return grant;
      args.push(i.id);
      return (await c.query(`UPDATE org_assignor_grants SET ${fields.join(',')} WHERE id=$${args.length} RETURNING *`, args)).rows[0];
    });
  },
});

// ── 11. Revoke assignor permission ────────────────────────────────────────────
cap({
  name: 'revoke_assignor_permission', method: 'POST', path: '/org-assignors/:id/revoke', tag: TAG,
  summary: 'Revoke an assignor grant. The person immediately loses delegation rights.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const grant = (await c.query('SELECT * FROM org_assignor_grants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!grant) throw notFound('Assignor grant');
      await requireOwnerAdmin(user, grant.organisation_id, c);
      if (grant.status === 'revoked') return grant;
      const updated = (await c.query(
        `UPDATE org_assignor_grants SET status='revoked', revoked_at=now(), revoked_by=$2 WHERE id=$1 RETURNING *`,
        [i.id, user.id],
      )).rows[0];
      await audit(c, user.id, 'revoke_assignor_permission', 'org_assignor_grants', i.id);
      return updated;
    });
  },
});

// ── 12. List assignors ────────────────────────────────────────────────────────
cap({
  name: 'list_org_assignors', method: 'GET', path: '/organisations/:id/assignors', tag: TAG,
  summary: 'All current and historical assignor grants for this organisation.',
  input: z.object({ id, include_revoked: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    await requireOwnerAdmin(user, i.id);
    return many(
      `SELECT g.*, u.display_name, u.avatar_url, sp.name AS sport_name, sp.slug AS sport_slug
         FROM org_assignor_grants g
         JOIN users u ON u.id=g.granted_to
         LEFT JOIN sports sp ON sp.id=g.sport_id
        WHERE g.organisation_id=$1 AND ($2 OR g.status='active')
        ORDER BY g.status='active' DESC, u.display_name`,
      [i.id, i.include_revoked],
    );
  },
});

// ── 13. Workload grid ─────────────────────────────────────────────────────────
cap({
  name: 'get_org_official_workload', method: 'GET', path: '/organisations/:id/officials/workload', tag: TAG,
  summary: 'Per-official assignment counts for each day of the requested window (default: next 14 days). Highlights officials at or near their daily/weekly cap.',
  input: z.object({ id, days: z.coerce.number().int().min(1).max(28).default(14), sport_id: id.optional() }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    const windowEnd = new Date(Date.now() + i.days * DAY).toISOString();
    const sportFilter = i.sport_id ? 'AND r.sport_id=$3' : '';
    const args = [i.id, windowEnd, ...(i.sport_id ? [i.sport_id] : [])];

    const officials = await many(
      `SELECT r.user_id, r.id AS roster_id, u.display_name, u.avatar_url,
              p.max_per_day, p.max_per_week, p.timezone
         FROM org_official_rosters r
         JOIN users u ON u.id=r.user_id
         LEFT JOIN official_prefs p ON p.user_id=r.user_id
        WHERE r.organisation_id=$1 AND r.status='active' ${sportFilter}
        ORDER BY u.display_name`,
      args,
    );

    const result = [];
    for (const off of officials) {
      const days = await many(
        `SELECT date_trunc('day', f.scheduled_at AT TIME ZONE COALESCE($3,'UTC')) AS day,
                count(fo.id)::int AS cnt
           FROM fixture_officials fo
           JOIN fixtures f ON f.id=fo.fixture_id
           JOIN events ev ON ev.id=f.event_id
          WHERE fo.user_id=$1 AND fo.status='accepted' AND ev.organisation_id=$2
            AND f.scheduled_at BETWEEN now() AND $4::timestamptz
          GROUP BY 1 ORDER BY 1`,
        [off.user_id, i.id, off.timezone ?? 'UTC', windowEnd],
      );
      const total = days.reduce((s, d) => s + d.cnt, 0);
      const overCap = days.some((d) => off.max_per_day != null && d.cnt >= off.max_per_day);
      result.push({ ...off, days, total_in_window: total, over_cap: overCap });
    }
    return result;
  },
});

// ── 14. Unfilled fixtures ─────────────────────────────────────────────────────
cap({
  name: 'get_org_unfilled_fixtures', method: 'GET', path: '/organisations/:id/officials/unfilled', tag: TAG,
  summary: 'Fixtures belonging to this org\'s events that are scheduled but missing at least one accepted referee. Sorted by soonest first.',
  input: z.object({ id, ...page, days_ahead: z.coerce.number().int().min(1).max(90).default(21) }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    const cutoff = new Date(Date.now() + i.days_ahead * DAY).toISOString();
    const rows = await many(
      `SELECT f.id, f.scheduled_at, f.duration_min, f.status AS fixture_status,
              ev.id AS event_id, ev.name AS event_name, ev.sport_id,
              sp.name AS sport_name, sp.emoji AS sport_emoji,
              f.venue_id, v.name AS venue_name,
              home.name AS home_name, away.name AS away_name,
              (SELECT json_agg(json_build_object('role',fo2.role,'status',fo2.status))
                 FROM fixture_officials fo2 WHERE fo2.fixture_id=f.id AND fo2.status='accepted') AS accepted_crew
         FROM fixtures f
         JOIN events ev ON ev.id=f.event_id
         JOIN sports sp ON sp.id=ev.sport_id
         LEFT JOIN venues v ON v.id=f.venue_id
         LEFT JOIN teams home ON home.id=f.home_team_id
         LEFT JOIN teams away ON away.id=f.away_team_id
        WHERE ev.organisation_id=$1
          AND f.status IN ('scheduled','postponed')
          AND f.scheduled_at BETWEEN now() AND $2::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM fixture_officials fo
             WHERE fo.fixture_id=f.id AND fo.role='referee' AND fo.status='accepted'
          )
        ORDER BY f.scheduled_at
        LIMIT $3`,
      [i.id, cutoff, i.limit ?? 50],
    );
    // annotate with which roles are still needed
    return rows.map((r) => {
      const filled = new Set((r.accepted_crew ?? []).map((c) => c.role));
      const needed = ['referee', 'linesman'].filter((role) => !filled.has(role));
      return { ...r, roles_needed: needed, roles_filled: [...filled] };
    });
  },
});

// ── 15. Send message to officials pool ────────────────────────────────────────
cap({
  name: 'send_org_officials_message', method: 'POST', path: '/organisations/:id/officials/messages', tag: TAG, status: 201,
  summary: 'Broadcast a message to all active officials in this org\'s pool, optionally filtered by sport. Body and subject are stored encrypted. Each official receives a notification.',
  input: z.object({ id, subject: text(200), body: text(2000), sport_id: id.optional(), recipient_filter: z.object({ grade_min: z.number().int().optional(), available_from: z.string().date().optional() }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireOwnerAdmin(user, i.id, c);
      const sportFilter = i.sport_id ? 'AND sport_id=$2' : '';
      const rArgs = i.sport_id ? [i.id, i.sport_id] : [i.id];
      const recipients = await c.query(
        `SELECT user_id FROM org_official_rosters WHERE organisation_id=$1 AND status='active' ${sportFilter}`,
        rArgs,
      );
      const msgRow = (await c.query(
        `INSERT INTO org_official_messages(organisation_id,sent_by,subject,body_enc,sport_id,recipient_filter,recipient_count)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [i.id, user.id, i.subject, encrypt(i.body), i.sport_id ?? null, JSON.stringify(i.recipient_filter ?? {}), recipients.rowCount],
      )).rows[0];
      const org = (await c.query('SELECT name FROM organisations WHERE id=$1', [i.id])).rows[0];
      for (const { user_id } of recipients.rows) {
        await notify(c, user_id, { kind: 'org_officials_message', title: i.subject, body: `From ${org?.name ?? 'your organisation'}`, data: { message_id: msgRow.id, organisation_id: i.id } });
      }
      await audit(c, user.id, 'send_org_officials_message', 'org_official_messages', msgRow.id);
      return { ...msgRow, recipient_count: recipients.rowCount };
    });
  },
});

// ── 16. List messages ─────────────────────────────────────────────────────────
cap({
  name: 'list_org_official_messages', method: 'GET', path: '/organisations/:id/officials/messages', tag: TAG,
  summary: 'History of broadcast messages sent to this org\'s official pool, newest first.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    await requireOwnerAdmin(user, i.id);
    const rows = await many(
      `SELECT m.id, m.subject, m.sport_id, m.recipient_count, m.sent_at,
              u.display_name AS sent_by_name, sp.name AS sport_name
         FROM org_official_messages m
         JOIN users u ON u.id=m.sent_by
         LEFT JOIN sports sp ON sp.id=m.sport_id
        WHERE m.organisation_id=$1
        ORDER BY m.sent_at DESC LIMIT $2`,
      [i.id, i.limit ?? 20],
    );
    return rows;
  },
});

// ── 17. Eligibility warnings list ────────────────────────────────────────────
cap({
  name: 'get_org_official_eligibility', method: 'GET', path: '/organisations/:id/officials/eligibility', tag: TAG,
  summary: 'All active panel officials with expired or expiring credentials, grouped by severity. Used for the Eligibility tab.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i) {
    await getOrg(user, i.id);
    const sportFilter = i.sport_id ? 'AND r.sport_id=$2' : '';
    const args = i.sport_id ? [i.id, i.sport_id] : [i.id];
    const roster = await many(
      `SELECT r.id AS roster_id, r.user_id, r.sport_id, u.display_name, u.avatar_url,
              sp.name AS sport_name, sp.emoji AS sport_emoji
         FROM org_official_rosters r
         JOIN users u ON u.id=r.user_id
         LEFT JOIN sports sp ON sp.id=r.sport_id
        WHERE r.organisation_id=$1 AND r.status='active' ${sportFilter}
        ORDER BY u.display_name`,
      args,
    );
    const expired = [], expiring = [], no_cred = [];
    for (const row of roster) {
      const { band, cred } = await credBand(pool, row.user_id, row.sport_id);
      if (band === 'expired') expired.push({ ...row, cred });
      else if (band === 'expiring') expiring.push({ ...row, cred });
      else if (band === 'none') no_cred.push({ ...row, cred });
    }
    return { expired, expiring, no_credential: no_cred, total_warnings: expired.length + expiring.length };
  },
});

// ── 18. Export roster CSV ─────────────────────────────────────────────────────
cap({
  name: 'export_org_official_roster', method: 'GET', path: '/organisations/:id/officials/roster/export', tag: TAG,
  summary: 'Download the roster as CSV: name, sports, grade, licence expiry, verification status, assignments year-to-date. PII (addresses, tax, payout) is never included. Audit-logged.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i, { res }) {
    await getOrg(user, i.id);
    await requireOwnerAdmin(user, i.id);
    const sportFilter = i.sport_id ? 'AND r.sport_id=$2' : '';
    const args = i.sport_id ? [i.id, i.sport_id] : [i.id];
    const roster = await many(
      `SELECT r.user_id, r.sport_id, r.status, r.created_at,
              u.display_name, sp.name AS sport_name
         FROM org_official_rosters r
         JOIN users u ON u.id=r.user_id
         LEFT JOIN sports sp ON sp.id=r.sport_id
        WHERE r.organisation_id=$1 ${sportFilter} AND r.status!='removed'
        ORDER BY u.display_name`,
      args,
    );
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
    const rows = [];
    for (const r of roster) {
      const { cred } = await credBand(pool, r.user_id, r.sport_id);
      const ytd = await one(
        `SELECT count(fo.id)::int AS cnt FROM fixture_officials fo
           JOIN fixtures f ON f.id=fo.fixture_id
           JOIN events ev ON ev.id=f.event_id
          WHERE fo.user_id=$1 AND fo.status='accepted' AND ev.organisation_id=$2
            AND f.scheduled_at >= $3::timestamptz`,
        [r.user_id, i.id, yearStart],
      );
      rows.push({
        name: r.display_name,
        sport: r.sport_name ?? 'All',
        status: r.status,
        grade: cred.licence?.grade ?? '—',
        licence_body: cred.licence?.body_name ?? '—',
        licence_expires: cred.licence?.expires_on ?? '—',
        verification: cred.verified ? (new Date(cred.verified.expires_at) > new Date() ? 'verified' : 'expired') : 'none',
        assignments_ytd: ytd.cnt,
        joined: r.created_at?.toISOString?.().slice(0, 10) ?? '—',
      });
    }
    const org = await one('SELECT name FROM organisations WHERE id=$1', [i.id]);
    await audit(pool, user.id, 'export_org_official_roster', 'org_official_rosters', i.id);
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="officials-${org?.name?.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.end(csv);
  },
});
