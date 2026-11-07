// Team-level volunteer self-signup and coordinator dashboard (gaps audit, feature 1).
// Extends team staffing beyond event-level volunteers (event-staff.js) to recurring team needs:
// check-in marshals, coaching assistants, first aid, transport, admin roles.
// All free-text PII is encrypted. Location decryption is audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { isYouth, requireConsent, requireGuardian } from '../youth.js';
import { canManageTeam } from './teams.js';

const TAG = 'Team volunteers';
const CATEGORIES = ['general', 'check_in', 'coaching_assistant', 'first_aid', 'transport', 'admin'];

async function requireManager(user, teamId) {
  const team = await one('SELECT * FROM teams WHERE id=$1', [teamId]);
  if (!team) throw notFound('Team');
  if (!await canManageTeam(user, team)) throw forbidden('Team manager access required');
  return team;
}

// Encryption contexts bind each ciphertext to its column (AAD), like every other *_enc column in the platform.
const PCTX = (f) => `team_volunteer_positions.${f}`;
const ACTX = (f) => `team_volunteer_applications.${f}`;
const POSITION_COLS = `p.id, p.team_id, p.created_by, p.title, p.role_category, p.shift_start, p.shift_end, p.capacity,
  p.meal_provided, p.briefing_url, p.archived_at, p.created_at`;

/** Managers who should hear about new volunteer applications: the owner plus active captains, managers and coaches. */
const teamManagerIds = async (teamId) => (await many(
  `SELECT owner_id AS id FROM teams WHERE id=$1
   UNION SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('captain','manager','coach')`,
  [teamId])).map((r) => r.id);

const clean = (row) => { const { note_enc, ...rest } = row; return rest; };

async function requireOwnApplication(user, appId) {
  const app = await one('SELECT * FROM team_volunteer_applications WHERE id=$1', [appId]);
  if (!app) throw notFound('Application');
  if (app.applicant_id !== user.id) throw forbidden('Not your application');
  return app;
}

cap({
  name: 'create_volunteer_position', method: 'POST', path: '/teams/:team_id/volunteer-positions', tag: TAG,
  summary: 'Create a volunteer position for a team (manager only)',
  auth: 'user',
  input: z.object({
    team_id: id,
    title: z.string().min(2).max(120),
    role_category: z.enum(CATEGORIES),
    shift_start: z.string().datetime(),
    shift_end: z.string().datetime(),
    capacity: z.number().int().min(1).max(100).default(1),
    description: z.string().max(2000).optional(),
    requirements: z.string().max(2000).optional(),
    uniform_desc: z.string().max(500).optional(),
    meal_provided: z.boolean().default(false),
    location: z.string().max(500).optional(),
    briefing_url: z.string().url().optional(),
  }),
  handler: async ({ user }, { team_id, title, role_category, shift_start, shift_end, capacity, description, requirements, uniform_desc, meal_provided, location, briefing_url }) => {
    await requireManager(user, team_id);
    if (new Date(shift_end) <= new Date(shift_start)) throw badRequest('shift_end must be after shift_start');
    const pos = await one(
      `INSERT INTO team_volunteer_positions(team_id,created_by,title,description_enc,role_category,shift_start,shift_end,capacity,requirements_enc,uniform_desc_enc,meal_provided,location_enc,briefing_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [team_id, user.id, title,
        description ? encrypt(description, PCTX('description')) : null, role_category, shift_start, shift_end, capacity,
        requirements ? encrypt(requirements, PCTX('requirements')) : null, uniform_desc ? encrypt(uniform_desc, PCTX('uniform_desc')) : null,
        meal_provided, location ? encrypt(location, PCTX('location')) : null, briefing_url ?? null]
    );
    const { description_enc, requirements_enc, uniform_desc_enc, location_enc, ...pub } = pos;
    return { position: { ...pub, description: description ?? null, requirements: requirements ?? null, uniform_desc: uniform_desc ?? null, location: location ?? null } };
  },
});

cap({
  name: 'list_volunteer_positions', method: 'GET', path: '/teams/:team_id/volunteer-positions', tag: TAG,
  summary: 'List open volunteer positions for a team',
  auth: 'user',
  input: z.object({
    team_id: id,
    category: z.enum(CATEGORIES).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    availability: z.enum(['open', 'full']).optional(),
  }),
  handler: async ({ user }, { team_id, category, date, availability }) => {
    if (!(await one('SELECT 1 FROM teams WHERE id=$1', [team_id]))) throw notFound('Team');
    const params = [team_id, user.id];
    let where = 'p.team_id=$1 AND p.archived_at IS NULL';
    if (category) { params.push(category); where += ` AND p.role_category=$${params.length}`; }
    if (date) { params.push(date); where += ` AND p.shift_start::date = $${params.length}::date`; }
    const positions = await many(
      `SELECT ${POSITION_COLS},
        COUNT(a.id) FILTER(WHERE a.status='approved') AS filled_count,
        (SELECT json_agg(json_build_object('id',u.id,'display_name',u.display_name,'avatar_url',u.avatar_url,'avatar_emoji',u.avatar_emoji,'avatar_color',u.avatar_color))
         FROM (SELECT u2.id, u2.display_name, u2.avatar_url, u2.avatar_emoji, u2.avatar_color FROM team_volunteer_applications a2 JOIN users u2 ON u2.id=a2.applicant_id WHERE a2.position_id=p.id AND a2.status='approved' LIMIT 3) u
        ) AS applicant_avatars,
        (SELECT a3.id FROM team_volunteer_applications a3 WHERE a3.position_id=p.id AND a3.applicant_id=$2 LIMIT 1) AS my_application_id,
        (SELECT a3.status FROM team_volunteer_applications a3 WHERE a3.position_id=p.id AND a3.applicant_id=$2 LIMIT 1) AS my_status
       FROM team_volunteer_positions p
       LEFT JOIN team_volunteer_applications a ON a.position_id=p.id
       WHERE ${where}
       GROUP BY p.id ORDER BY p.shift_start`,
      params
    );
    const filtered = positions.filter(p => {
      if (availability === 'open') return Number(p.filled_count) < p.capacity;
      if (availability === 'full') return Number(p.filled_count) >= p.capacity;
      return true;
    });
    return { positions: filtered };
  },
});

cap({
  name: 'get_volunteer_position', method: 'GET', path: '/volunteer-positions/:id', tag: TAG,
  summary: 'Get full detail of a volunteer position',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: posId }) => {
    const pos = await one('SELECT * FROM team_volunteer_positions WHERE id=$1', [posId]);
    if (!pos) throw notFound('Position');
    const team = await one('SELECT * FROM teams WHERE id=$1', [pos.team_id]);
    const isManager = await canManageTeam(user, team);
    const { description_enc, requirements_enc, uniform_desc_enc, location_enc, ...pub } = pos;
    const result = {
      ...pub,
      description: description_enc ? decrypt(description_enc, PCTX('description')) : null,
      requirements: requirements_enc ? decrypt(requirements_enc, PCTX('requirements')) : null,
      uniform_desc: uniform_desc_enc ? decrypt(uniform_desc_enc, PCTX('uniform_desc')) : null,
    };
    // the venue/meeting point is only for the people who run or work the shift
    const mine = await one("SELECT 1 FROM team_volunteer_applications WHERE position_id=$1 AND applicant_id=$2 AND status='approved'", [posId, user.id]);
    if (location_enc && (isManager || mine)) {
      result.location = decrypt(location_enc, PCTX('location'));
      await audit(null, user.id, 'volunteer_position_location_viewed', 'team_volunteer_positions', posId);
    }
    if (isManager) {
      const rows = await many(
        `SELECT a.*, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
         FROM team_volunteer_applications a JOIN users u ON u.id=a.applicant_id
         WHERE a.position_id=$1 ORDER BY a.created_at`,
        [posId]
      );
      if (rows.some((r) => r.note_enc)) await audit(null, user.id, 'volunteer_application_notes_viewed', 'team_volunteer_positions', posId);
      result.applicants = rows.map((r) => ({ ...clean(r), note: r.note_enc ? decrypt(r.note_enc, ACTX('note')) : null }));
    }
    return { position: result };
  },
});

cap({
  name: 'apply_volunteer_position', method: 'POST', path: '/volunteer-positions/:id/apply', tag: TAG,
  summary: 'Apply to volunteer for a position',
  auth: 'user',
  input: z.object({
    id,
    on_behalf_of: id.optional(),
    shirt_size: z.enum(['XS','S','M','L','XL','XXL']).optional(),
    note: z.string().max(500).optional(),
  }),
  handler: async ({ user }, { id: posId, on_behalf_of, shirt_size, note }) => {
    const pos = await one('SELECT * FROM team_volunteer_positions WHERE id=$1 AND archived_at IS NULL', [posId]);
    if (!pos) throw notFound('Position');
    if (new Date(pos.shift_start) < new Date()) throw badRequest('This shift has already started');
    if (on_behalf_of) {
      const child = await one('SELECT id, managed_by_guardian_id FROM users WHERE id=$1', [on_behalf_of]);
      if (!child) throw notFound('Child');
      if (child.managed_by_guardian_id !== user.id) await requireGuardian(user, on_behalf_of, null, 'register'); // co-guardians need a live link that covers registering
    } else if (await isYouth(user.id)) {
      await requireConsent(user.id, 'participation', 'volunteering');
    }
    const app = await tx(async (c) => {
      await c.query('SELECT id FROM team_volunteer_positions WHERE id=$1 FOR UPDATE', [posId]); // serialise capacity checks
      if ((await c.query('SELECT 1 FROM team_volunteer_applications WHERE position_id=$1 AND applicant_id=$2', [posId, user.id])).rows.length) throw conflict('Already applied to this position');
      const filled = (await c.query("SELECT COUNT(*)::int AS n FROM team_volunteer_applications WHERE position_id=$1 AND status='approved'", [posId])).rows[0];
      if (filled.n >= pos.capacity) throw badRequest('No capacity remaining');
      return (await c.query(
        `INSERT INTO team_volunteer_applications(position_id,applicant_id,on_behalf_of,shirt_size,note_enc)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [posId, user.id, on_behalf_of ?? null, shirt_size ?? null, note ? encrypt(note, ACTX('note')) : null]
      )).rows[0];
    });
    for (const mid of await teamManagerIds(pos.team_id)) {
      if (mid === user.id) continue;
      await notify(null, mid, { kind: 'volunteer_application', title: 'New volunteer application', body: `${user.display_name} applied to: ${pos.title}`, data: { type: 'volunteer_application', position_id: posId, application_id: app.id } });
    }
    return { application: { ...clean(app), note: note ?? null } };
  },
});

cap({
  name: 'withdraw_volunteer_application', method: 'POST', path: '/volunteer-applications/:id/withdraw', tag: TAG,
  summary: 'Withdraw a volunteer application',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: appId }) => {
    const app = await requireOwnApplication(user, appId);
    if (!['pending', 'approved'].includes(app.status)) throw badRequest('Application cannot be withdrawn in current status');
    await one('UPDATE team_volunteer_applications SET status=\'withdrawn\' WHERE id=$1 RETURNING id', [appId]);
    return { withdrawn: true };
  },
});

cap({
  name: 'respond_volunteer_application', method: 'PATCH', path: '/volunteer-applications/:id', tag: TAG,
  summary: 'Approve or decline a volunteer application (manager)',
  auth: 'user',
  input: z.object({
    id,
    decision: z.enum(['approved', 'declined']),
    note: z.string().max(500).optional(),
  }),
  handler: async ({ user }, { id: appId, decision, note }) => {
    const app = await one(
      `SELECT a.*, p.team_id, p.capacity, p.title FROM team_volunteer_applications a
       JOIN team_volunteer_positions p ON p.id=a.position_id WHERE a.id=$1`,
      [appId]
    );
    if (!app) throw notFound('Application');
    await requireManager(user, app.team_id);
    if (app.status !== 'pending') throw badRequest('This application has already been decided or withdrawn');
    await tx(async (c) => {
      await c.query('SELECT id FROM team_volunteer_positions WHERE id=$1 FOR UPDATE', [app.position_id]);
      if (decision === 'approved') {
        const filled = (await c.query("SELECT COUNT(*)::int AS n FROM team_volunteer_applications WHERE position_id=$1 AND status='approved'", [app.position_id])).rows[0];
        if (filled.n >= app.capacity) throw badRequest('Position is already at capacity');
      }
      const r = await c.query(
        "UPDATE team_volunteer_applications SET status=$1,decided_by=$2,decided_at=now(),note_enc=COALESCE($3,note_enc) WHERE id=$4 AND status='pending'",
        [decision, user.id, note ? encrypt(note, ACTX('note')) : null, appId]
      );
      if (!r.rowCount) throw conflict('This application was just changed by someone else');
    });
    await notify(null, app.applicant_id, {
      kind: 'volunteer_decision',
      title: decision === 'approved' ? 'Volunteer application approved!' : 'Volunteer application update',
      body: decision === 'approved' ? `You have been approved to volunteer: ${app.title}` : `Your application was not taken forward for: ${app.title}`,
      data: { type: 'volunteer_decision', application_id: appId, decision },
    });
    return { decision };
  },
});

cap({
  name: 'get_volunteer_coordinator_dashboard', method: 'GET', path: '/teams/:team_id/volunteer-dashboard', tag: TAG,
  summary: 'Coordinator dashboard: fill rates, roster, leaderboard (manager)',
  auth: 'user',
  input: z.object({ team_id: id }),
  handler: async ({ user }, { team_id }) => {
    await requireManager(user, team_id);
    const positions = await many(
      `SELECT p.*,
        COUNT(a.id) FILTER(WHERE a.status='approved') AS filled_count,
        COUNT(a.id) FILTER(WHERE a.status='pending') AS pending_count
       FROM team_volunteer_positions p
       LEFT JOIN team_volunteer_applications a ON a.position_id=p.id
       WHERE p.team_id=$1 AND p.archived_at IS NULL
       GROUP BY p.id ORDER BY p.shift_start`,
      [team_id]
    );
    const todayRoster = await many(
      `SELECT a.*, p.title, p.role_category, p.shift_start, p.shift_end,
              u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
       FROM team_volunteer_applications a
       JOIN team_volunteer_positions p ON p.id=a.position_id
       JOIN users u ON u.id=a.applicant_id
       WHERE p.team_id=$1 AND a.status='approved'
         AND p.shift_start::date = CURRENT_DATE
       ORDER BY p.shift_start`,
      [team_id]
    );
    const pending = await one('SELECT COUNT(*) AS n FROM team_volunteer_applications a JOIN team_volunteer_positions p ON p.id=a.position_id WHERE p.team_id=$1 AND a.status=\'pending\'', [team_id]);
    const seasonHours = await one('SELECT COALESCE(SUM(hours),0) AS total FROM team_volunteer_hours WHERE team_id=$1', [team_id]);
    const leaderboard = await many(
      `SELECT u.id, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color,
              SUM(h.hours) AS total_hours
       FROM team_volunteer_hours h JOIN users u ON u.id=h.applicant_id
       WHERE h.team_id=$1 GROUP BY u.id ORDER BY total_hours DESC LIMIT 5`,
      [team_id]
    );
    return {
      positions,
      today_roster: todayRoster,
      pending_count: Number(pending.n),
      season_hours_total: Number(seasonHours.total),
      leaderboard,
    };
  },
});

cap({
  name: 'volunteer_check_in', method: 'POST', path: '/volunteer-applications/:id/check-in', tag: TAG,
  summary: 'Check in a volunteer (manager)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: appId }) => {
    const app = await one('SELECT a.*, p.team_id FROM team_volunteer_applications a JOIN team_volunteer_positions p ON p.id=a.position_id WHERE a.id=$1', [appId]);
    if (!app) throw notFound('Application');
    await requireManager(user, app.team_id);
    if (app.status !== 'approved') throw badRequest('Volunteer is not approved');
    if (app.checked_in_at) throw badRequest('Already checked in');
    await one('UPDATE team_volunteer_applications SET checked_in_at=now() WHERE id=$1 RETURNING id', [appId]);
    return { checked_in: true };
  },
});

cap({
  name: 'volunteer_check_out', method: 'POST', path: '/volunteer-applications/:id/check-out', tag: TAG,
  summary: 'Check out a volunteer and log hours (manager)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: appId }) => {
    const app = await one(
      `SELECT a.*, p.team_id, p.id AS pos_id
       FROM team_volunteer_applications a JOIN team_volunteer_positions p ON p.id=a.position_id WHERE a.id=$1`,
      [appId]
    );
    if (!app) throw notFound('Application');
    await requireManager(user, app.team_id);
    if (!app.checked_in_at) throw badRequest('Volunteer has not checked in');
    if (app.checked_out_at) throw badRequest('Already checked out');
    // a forgotten check-out must not log days of "volunteering": one shift is capped at 24 h
    const result = await tx(async (c) => {
      const r = (await c.query(
        `UPDATE team_volunteer_applications
         SET checked_out_at=now(), hours_logged=ROUND(LEAST(EXTRACT(EPOCH FROM (now()-checked_in_at))/3600, 24)::numeric, 2)
         WHERE id=$1 AND checked_out_at IS NULL RETURNING *`,
        [appId]
      )).rows[0];
      if (!r) throw badRequest('Already checked out');
      await c.query(
        'INSERT INTO team_volunteer_hours(applicant_id,team_id,position_id,hours) VALUES($1,$2,$3,$4)',
        [app.applicant_id, app.team_id, app.pos_id, r.hours_logged]
      );
      return r;
    });
    const hours = Number(result.hours_logged);
    await notify(null, app.applicant_id, {
      kind: 'volunteer_hours',
      title: 'Volunteer hours logged',
      body: `${hours.toFixed(2)} hours recorded. Thank you for volunteering!`,
      data: { type: 'volunteer_hours', application_id: appId },
    });
    return { checked_out: true, hours_logged: hours };
  },
});

cap({
  name: 'get_my_volunteer_schedule', method: 'GET', path: '/me/volunteer-schedule', tag: TAG,
  summary: 'Get my upcoming approved volunteer duties',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    const apps = await many(
      `SELECT a.*, p.title, p.role_category, p.shift_start, p.shift_end, p.briefing_url,
              p.location_enc, p.team_id, t.name AS team_name, t.emoji AS team_emoji
       FROM team_volunteer_applications a
       JOIN team_volunteer_positions p ON p.id=a.position_id
       JOIN teams t ON t.id=p.team_id
       WHERE a.applicant_id=$1 AND a.status='approved' AND p.shift_start > now()
       ORDER BY p.shift_start`,
      [user.id]
    );
    const result = apps.map(({ location_enc, note_enc, ...a }) => ({
      ...a,
      location: location_enc ? decrypt(location_enc, PCTX('location')) : null,
    }));
    if (result.some(a => a.location)) {
      await audit(null, user.id, 'volunteer_schedule_location_viewed', 'team_volunteer_applications', null);
    }
    return { schedule: result };
  },
});

cap({
  name: 'archive_volunteer_position', method: 'DELETE', path: '/volunteer-positions/:id', tag: TAG,
  summary: 'Archive (soft-delete) a volunteer position (manager)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: posId }) => {
    const pos = await one('SELECT * FROM team_volunteer_positions WHERE id=$1', [posId]);
    if (!pos) throw notFound('Position');
    await requireManager(user, pos.team_id);
    await one('UPDATE team_volunteer_positions SET archived_at=now() WHERE id=$1 RETURNING id', [posId]);
    return { archived: true };
  },
});

cap({
  name: 'broadcast_volunteer_message', method: 'POST', path: '/teams/:team_id/volunteer-broadcast', tag: TAG,
  summary: 'Send a push message to all approved volunteers (manager)',
  auth: 'user',
  input: z.object({
    team_id: id,
    message: z.string().min(1).max(500),
    position_id: id.optional(),
  }),
  handler: async ({ user }, { team_id, message, position_id }) => {
    await requireManager(user, team_id);
    let query = `SELECT DISTINCT a.applicant_id FROM team_volunteer_applications a
                 JOIN team_volunteer_positions p ON p.id=a.position_id
                 WHERE p.team_id=$1 AND a.status='approved'`;
    const params = [team_id];
    if (position_id) { params.push(position_id); query += ` AND a.position_id=$${params.length}`; }
    const recipients = await many(query, params);
    for (const r of recipients) {
      await notify(null, r.applicant_id, {
        kind: 'volunteer_broadcast',
        title: 'Message from team coordinator',
        body: message,
        data: { type: 'volunteer_broadcast', team_id },
      });
    }
    await audit(null, user.id, 'volunteer_broadcast_sent', 'teams', team_id);
    return { sent_to: recipients.length };
  },
});
