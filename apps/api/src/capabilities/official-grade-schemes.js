// International referee grade schemes: catalogue, official grades, upgrade applications (#1030 R32).
//
// Never competes with official_profiles (sport_profiles, credentials, verification_cases):
//   - official_profiles/credentials = self-declared + document-level verification
//   - grade schemes = governing-body-assigned competitive grade within a formal ladder
//     (FIFA 1-5, ICC Elite/International/First-Class, ITF Gold/Silver/Bronze, etc.)
//
// Tables (migration 206):
//   official_grade_scheme_catalogue → official_grade_scheme_levels → official_scheme_grades
//   official_grade_upgrade_applications, official_grade_audit_log

import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, hasRole, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';

const TAG = 'Official grade schemes';

const assertCanManageSchemes = (user) => {
  if (!isAdmin(user) && !hasRole(user, 'federation'))
    throw forbidden('Only federation administrators or platform admins can manage grade scheme catalogues');
};

const assertOfficial = (user) => {
  if (!hasRole(user, 'referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'))
    throw forbidden('Only a registered official can manage grade applications');
};

// ── CATALOGUE: list / get schemes (public — for pickers) ──────────────────

cap({
  name: 'list_grade_scheme_catalogue', method: 'GET', path: '/official-grade-schemes', tag: TAG,
  auth: 'public',
  summary: 'List active grade schemes. Filter by sport_id, country_scope or governing_body. Used to populate scheme pickers in the official profile wizard and assessment tools.',
  input: z.object({
    sport_id:        id.optional(),
    country_scope:   z.string().length(2).toUpperCase().optional(),
    governing_body:  z.string().max(120).optional(),
    status:          z.enum(['draft','active','retired','all']).default('active'),
    ...page,
  }),
  async handler(_ctx, i) {
    const conditions = [];
    const args = [];
    if (i.status !== 'all') { args.push(i.status); conditions.push(`status=$${args.length}`); }
    if (i.sport_id) { args.push(i.sport_id); conditions.push(`(sport_id=$${args.length} OR sport_id IS NULL)`); }
    if (i.country_scope) { args.push(i.country_scope); conditions.push(`(country_scope=$${args.length} OR country_scope IS NULL)`); }
    if (i.governing_body) { args.push(`%${i.governing_body}%`); conditions.push(`(governing_body ILIKE $${args.length} OR governing_body_abbr ILIKE $${args.length})`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    args.push(i.limit, i.offset);
    const schemes = await many(
      `SELECT s.*, sp.name AS sport_name, sp.emoji AS sport_emoji,
              (SELECT count(*) FROM official_grade_scheme_levels l WHERE l.scheme_id=s.id AND l.archived_at IS NULL)::int AS level_count,
              (SELECT count(*) FROM official_scheme_grades g WHERE g.scheme_id=s.id AND g.status='active')::int AS official_count
       FROM official_grade_scheme_catalogue s LEFT JOIN sports sp ON sp.id=s.sport_id
       ${where} ORDER BY s.effective_from DESC, s.display_name LIMIT $${args.length-1} OFFSET $${args.length}`,
      args,
    );
    return { schemes };
  },
});

cap({
  name: 'get_grade_scheme', method: 'GET', path: '/official-grade-schemes/:id', tag: TAG,
  auth: 'public',
  summary: 'Full details of a grade scheme including all grade levels in rank order.',
  input: z.object({ id }),
  async handler(_ctx, i) {
    const scheme = await one(
      `SELECT s.*, sp.name AS sport_name, sp.emoji AS sport_emoji
       FROM official_grade_scheme_catalogue s LEFT JOIN sports sp ON sp.id=s.sport_id WHERE s.id=$1`,
      [i.id],
    );
    if (!scheme) throw notFound('grade scheme');
    const levels = await many(
      `SELECT * FROM official_grade_scheme_levels WHERE scheme_id=$1 AND archived_at IS NULL ORDER BY rank_order, level_code`,
      [i.id],
    );
    return { scheme, levels };
  },
});

// ── CATALOGUE: create / update / publish (federation/admin) ──────────────

cap({
  name: 'create_grade_scheme', method: 'POST', path: '/official-grade-schemes', tag: TAG, status: 201,
  auth: ['admin','federation'],
  summary: 'Federation/admin: create a new grade scheme. Starts as draft; use publish_grade_scheme to make it active.',
  input: z.object({
    sport_id:            id.optional(),
    governing_body:      z.string().trim().min(1).max(120),
    governing_body_abbr: z.string().trim().max(20).optional(),
    country_scope:       z.string().trim().length(2).toUpperCase().optional(),
    display_name:        z.string().trim().min(1).max(160),
    description:         z.string().trim().max(2000).optional(),
    scheme_version:      z.string().trim().max(20).default('1.0'),
    effective_from:      z.string().date(),
    effective_until:     z.string().date().optional(),
    appeal_window_days:  z.number().int().min(0).max(365).default(30),
    tax_treatment:       z.enum(['per_country','scheme_level','none','unknown']).default('per_country'),
  }),
  async handler({ user }, i) {
    assertCanManageSchemes(user);
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO official_grade_scheme_catalogue(
           sport_id, governing_body, governing_body_abbr, country_scope, display_name, description,
           scheme_version, effective_from, effective_until, appeal_window_days, tax_treatment,
           status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12) RETURNING *`,
        [ i.sport_id ?? null, i.governing_body, i.governing_body_abbr ?? null,
          i.country_scope ?? null, i.display_name, i.description ?? null,
          i.scheme_version, i.effective_from, i.effective_until ?? null,
          i.appeal_window_days, i.tax_treatment, user.id ],
      )).rows[0];
      await audit(c, user.id, 'grade_scheme.created', 'official_grade_scheme_catalogue', row.id);
      return row;
    });
  },
});

cap({
  name: 'add_grade_scheme_level', method: 'POST', path: '/official-grade-schemes/:id/levels', tag: TAG, status: 201,
  auth: ['admin','federation'],
  summary: 'Federation/admin: add a grade level to a scheme. rank_order 0 = highest grade.',
  input: z.object({
    id,
    level_code:                     z.string().trim().min(1).max(30),
    display_name:                   z.string().trim().min(1).max(100),
    description:                    z.string().trim().max(1000).optional(),
    rank_order:                     z.number().int().min(0),
    min_matches_required:           z.number().int().min(0).optional(),
    min_assessment_score:           z.number().int().min(0).max(100).optional(),
    requires_assessor_endorsement:  z.boolean().default(false),
    requires_fitness_cert:          z.boolean().default(false),
    requires_federation_approval:   z.boolean().default(true),
  }),
  async handler({ user }, i) {
    assertCanManageSchemes(user);
    const scheme = await one('SELECT id, status FROM official_grade_scheme_catalogue WHERE id=$1', [i.id]);
    if (!scheme) throw notFound('grade scheme');
    if (scheme.status === 'retired') throw conflict('Cannot add levels to a retired scheme');
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO official_grade_scheme_levels(
           scheme_id, level_code, display_name, description, rank_order,
           min_matches_required, min_assessment_score, requires_assessor_endorsement,
           requires_fitness_cert, requires_federation_approval)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ i.id, i.level_code, i.display_name, i.description ?? null, i.rank_order,
          i.min_matches_required ?? null, i.min_assessment_score ?? null,
          i.requires_assessor_endorsement, i.requires_fitness_cert, i.requires_federation_approval ],
      )).rows[0];
      await audit(c, user.id, 'grade_scheme_level.added', 'official_grade_scheme_catalogue', i.id);
      return row;
    });
  },
});

cap({
  name: 'publish_grade_scheme', method: 'POST', path: '/official-grade-schemes/:id/publish', tag: TAG,
  auth: ['admin','federation'],
  summary: 'Federation/admin: publish a draft scheme. Requires at least one grade level.',
  input: z.object({ id }),
  async handler({ user }, i) {
    assertCanManageSchemes(user);
    return tx(async (c) => {
      const scheme = (await c.query('SELECT * FROM official_grade_scheme_catalogue WHERE id=$1', [i.id])).rows[0];
      if (!scheme) throw notFound('grade scheme');
      if (scheme.status !== 'draft') throw conflict(`Scheme is already ${scheme.status}`);
      const levelCount = (await c.query('SELECT count(*) AS n FROM official_grade_scheme_levels WHERE scheme_id=$1 AND archived_at IS NULL', [i.id])).rows[0].n;
      if (Number(levelCount) === 0) throw badRequest('Add at least one grade level before publishing');
      const row = (await c.query("UPDATE official_grade_scheme_catalogue SET status='active', updated_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
      await audit(c, user.id, 'grade_scheme.published', 'official_grade_scheme_catalogue', i.id);
      return row;
    });
  },
});

// ── OFFICIAL GRADES: read my grades ──────────────────────────────────────

cap({
  name: 'get_my_official_grades', method: 'GET', path: '/me/official-grades', tag: TAG,
  summary: 'Official: return all my current active grades across all schemes, with the grade ladder for each scheme.',
  input: z.object({ sport_id: id.optional() }),
  async handler({ user }, i) {
    assertOfficial(user);
    const whereClause = i.sport_id ? "AND (sc.sport_id=$2 OR sc.sport_id IS NULL)" : '';
    const args = [user.id, ...(i.sport_id ? [i.sport_id] : [])];
    const grades = await many(
      `SELECT g.*, sl.level_code, sl.display_name AS level_name, sl.rank_order,
              sc.display_name AS scheme_name, sc.governing_body, sc.governing_body_abbr,
              sc.country_scope, sc.sport_id, sp.name AS sport_name, sp.emoji AS sport_emoji
       FROM official_scheme_grades g
       JOIN official_grade_scheme_levels sl ON sl.id=g.level_id
       JOIN official_grade_scheme_catalogue sc ON sc.id=g.scheme_id
       LEFT JOIN sports sp ON sp.id=sc.sport_id
       WHERE g.user_id=$1 AND g.status='active' ${whereClause}
       ORDER BY sp.name NULLS LAST, sc.display_name`,
      args,
    );
    // For each grade, attach the full level ladder so the app can render the ladder UI
    const result = await Promise.all(grades.map(async (g) => {
      const levels = await many(
        'SELECT * FROM official_grade_scheme_levels WHERE scheme_id=$1 AND archived_at IS NULL ORDER BY rank_order, level_code',
        [g.scheme_id],
      );
      return { ...g, levels };
    }));
    return { grades: result };
  },
});

cap({
  name: 'get_official_grade_history', method: 'GET', path: '/me/official-grades/:scheme_id/history', tag: TAG,
  summary: 'Official: full grade history for one scheme, oldest first.',
  input: z.object({ scheme_id: id, ...page }),
  async handler({ user }, i) {
    assertOfficial(user);
    const rows = await many(
      `SELECT g.*, sl.level_code, sl.display_name AS level_name, sl.rank_order,
              u.display_name AS assigned_by_name
       FROM official_scheme_grades g
       JOIN official_grade_scheme_levels sl ON sl.id=g.level_id
       LEFT JOIN users u ON u.id=g.assigned_by
       WHERE g.user_id=$1 AND g.scheme_id=$2
       ORDER BY g.effective_from, g.created_at
       LIMIT $3 OFFSET $4`,
      [user.id, i.scheme_id, i.limit, i.offset],
    );
    return { history: rows };
  },
});

// ── ASSIGN GRADE (organiser/assessor/federation/admin) ────────────────────

cap({
  name: 'assign_official_grade', method: 'POST', path: '/officials/:id/grades', tag: TAG, status: 201,
  auth: ['admin','federation','assessor','organizer'],
  summary: 'Assessor/federation/admin: assign or update an official\'s grade in a scheme. Supersedes any previous active grade for the same scheme.',
  input: z.object({
    id,
    scheme_id:         id,
    level_id:          id,
    assigned_reason:   z.string().trim().max(500).optional(),
    effective_from:    z.string().date().optional(),
    effective_until:   z.string().date().optional(),
    verification_status: z.enum(['self_declared','pending','verified','rejected']).default('verified'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const scheme = (await c.query('SELECT * FROM official_grade_scheme_catalogue WHERE id=$1 AND status=$2', [i.scheme_id, 'active'])).rows[0];
      if (!scheme) throw notFound('active grade scheme');
      const level = (await c.query('SELECT * FROM official_grade_scheme_levels WHERE id=$1 AND scheme_id=$2 AND archived_at IS NULL', [i.level_id, i.scheme_id])).rows[0];
      if (!level) throw notFound('grade level');
      const target = (await c.query('SELECT id FROM users WHERE id=$1', [i.id])).rows[0];
      if (!target) throw notFound('official');

      // Supersede previous active grade for this scheme
      const prev = (await c.query(
        "SELECT id, level_id FROM official_scheme_grades WHERE user_id=$1 AND scheme_id=$2 AND status='active'",
        [i.id, i.scheme_id],
      )).rows[0];
      if (prev) {
        await c.query("UPDATE official_scheme_grades SET status='superseded', updated_at=now() WHERE id=$1", [prev.id]);
        const prevLevel = (await c.query('SELECT level_code FROM official_grade_scheme_levels WHERE id=$1', [prev.level_id])).rows[0];
        await c.query(
          `INSERT INTO official_grade_audit_log(user_id, scheme_id, grade_id, actor_id, actor_role, action, from_level_code, to_level_code, reason)
           VALUES ($1,$2,$3,$4,$5,'grade_assigned',$6,$7,$8)`,
          [i.id, i.scheme_id, prev.id, user.id, user.roles?.[0] ?? 'admin', prevLevel?.level_code ?? null, level.level_code, i.assigned_reason ?? null],
        );
      }

      const row = (await c.query(
        `INSERT INTO official_scheme_grades(
           user_id, scheme_id, level_id, status, verification_status, assigned_by, assigned_role,
           assigned_reason, effective_from, effective_until, verified_at)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7,COALESCE($8::date,CURRENT_DATE),$9,$10) RETURNING *`,
        [ i.id, i.scheme_id, i.level_id, i.verification_status, user.id, user.roles?.[0] ?? 'admin',
          i.assigned_reason ?? null, i.effective_from ?? null, i.effective_until ?? null,
          i.verification_status === 'verified' ? new Date() : null ],
      )).rows[0];
      await audit(c, user.id, 'official_grade.assigned', 'official_scheme_grades', row.id);
      await notify(i.id, 'official_grade_assigned', { scheme_name: scheme.display_name, level_name: level.display_name, assigned_by: user.display_name });
      return row;
    });
  },
});

// ── UPGRADE APPLICATIONS ─────────────────────────────────────────────────

cap({
  name: 'submit_grade_upgrade_application', method: 'POST', path: '/me/official-grades/:scheme_id/upgrade', tag: TAG, status: 201,
  summary: 'Official: submit an application to upgrade to a higher grade level in a scheme.',
  input: z.object({
    scheme_id:        id,
    target_level_id:  id,
    evidence_checklist: z.array(z.object({
      key:            z.string().max(60),
      label:          z.string().max(200),
      met:            z.boolean(),
      evidence_note:  z.string().max(500).optional(),
    })).default([]),
  }),
  async handler({ user }, i) {
    assertOfficial(user);
    return tx(async (c) => {
      const current = (await c.query(
        "SELECT g.*, sl.level_id AS level_id FROM official_scheme_grades g JOIN official_grade_scheme_levels sl ON sl.id=g.level_id WHERE g.user_id=$1 AND g.scheme_id=$2 AND g.status='active'",
        [user.id, i.scheme_id],
      )).rows[0];
      if (!current) throw badRequest('You need a current active grade in this scheme before applying for an upgrade');

      const target = (await c.query(
        'SELECT * FROM official_grade_scheme_levels WHERE id=$1 AND scheme_id=$2 AND archived_at IS NULL',
        [i.target_level_id, i.scheme_id],
      )).rows[0];
      if (!target) throw notFound('target grade level');
      if (target.rank_order >= current.rank_order)
        throw badRequest('Target level must be higher (lower rank_order) than your current grade');

      // Reject if an open application already exists
      const open = (await c.query(
        "SELECT id FROM official_grade_upgrade_applications WHERE user_id=$1 AND scheme_id=$2 AND status NOT IN ('approved','rejected','withdrawn')",
        [user.id, i.scheme_id],
      )).rows[0];
      if (open) throw conflict('You already have an open upgrade application for this scheme');

      const scheme = (await c.query('SELECT * FROM official_grade_scheme_catalogue WHERE id=$1', [i.scheme_id])).rows[0];
      const appealDeadline = new Date();
      appealDeadline.setDate(appealDeadline.getDate() + (scheme?.appeal_window_days ?? 30));

      const row = (await c.query(
        `INSERT INTO official_grade_upgrade_applications(
           user_id, scheme_id, current_level_id, target_level_id, evidence_checklist, status, appeal_deadline)
         VALUES ($1,$2,$3,$4,$5::jsonb,'submitted',$6::date) RETURNING *`,
        [ user.id, i.scheme_id, current.level_id, i.target_level_id,
          JSON.stringify(i.evidence_checklist), appealDeadline.toISOString().slice(0, 10) ],
      )).rows[0];
      await audit(c, user.id, 'grade_upgrade.submitted', 'official_grade_upgrade_applications', row.id);
      return row;
    });
  },
});

cap({
  name: 'list_my_grade_upgrade_applications', method: 'GET', path: '/me/official-grades/applications', tag: TAG,
  summary: 'Official: list all my grade upgrade applications (all statuses), newest first.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    assertOfficial(user);
    const rows = await many(
      `SELECT a.*, sc.display_name AS scheme_name, sc.governing_body,
              cl.level_code AS current_level_code, cl.display_name AS current_level_name,
              tl.level_code AS target_level_code, tl.display_name AS target_level_name
       FROM official_grade_upgrade_applications a
       JOIN official_grade_scheme_catalogue sc ON sc.id=a.scheme_id
       JOIN official_grade_scheme_levels cl ON cl.id=a.current_level_id
       JOIN official_grade_scheme_levels tl ON tl.id=a.target_level_id
       WHERE a.user_id=$1
       ORDER BY a.submitted_at DESC LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset],
    );
    return { applications: rows };
  },
});

cap({
  name: 'review_grade_upgrade_application', method: 'PATCH', path: '/official-grade-upgrade-applications/:id', tag: TAG,
  auth: ['admin','federation','assessor'],
  summary: 'Assessor/federation/admin: endorse, request evidence, approve or reject an upgrade application. If approved, the new grade is automatically assigned.',
  input: z.object({
    id,
    action: z.enum(['assessor_endorse','request_evidence','approve','reject']),
    notes:  z.string().trim().max(1000).optional(),
    assessor_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const app = (await c.query('SELECT * FROM official_grade_upgrade_applications WHERE id=$1', [i.id])).rows[0];
      if (!app) throw notFound('upgrade application');

      const STATUS_MAP = { assessor_endorse: 'assessor_endorsed', request_evidence: 'evidence_needed', approve: 'approved', reject: 'rejected' };
      const newStatus = STATUS_MAP[i.action];

      if (i.action === 'approve') {
        // Auto-assign the new grade
        const targetLevel = (await c.query('SELECT * FROM official_grade_scheme_levels WHERE id=$1', [app.target_level_id])).rows[0];
        // Supersede old active grade
        const prev = (await c.query("SELECT id FROM official_scheme_grades WHERE user_id=$1 AND scheme_id=$2 AND status='active'", [app.user_id, app.scheme_id])).rows[0];
        if (prev) await c.query("UPDATE official_scheme_grades SET status='superseded', updated_at=now() WHERE id=$1", [prev.id]);
        const newGrade = (await c.query(
          `INSERT INTO official_scheme_grades(user_id, scheme_id, level_id, status, verification_status, assigned_by, assigned_role, assigned_reason, effective_from, verified_at)
           VALUES ($1,$2,$3,'active','verified',$4,'federation',$5,CURRENT_DATE,now()) RETURNING *`,
          [app.user_id, app.scheme_id, app.target_level_id, user.id, `Upgrade application ${app.id} approved`],
        )).rows[0];
        const prevLevelRow = prev ? (await c.query('SELECT g.*, sl.level_code FROM official_scheme_grades g JOIN official_grade_scheme_levels sl ON sl.id=g.level_id WHERE g.id=$1', [prev.id])).rows[0] : null;
        await c.query(
          `INSERT INTO official_grade_audit_log(user_id, scheme_id, grade_id, application_id, actor_id, actor_role, action, from_level_code, to_level_code, reason)
           VALUES ($1,$2,$3,$4,$5,$6,'upgrade_approved',$7,$8,$9)`,
          [app.user_id, app.scheme_id, newGrade.id, app.id, user.id, user.roles?.[0] ?? 'admin', prevLevelRow?.level_code ?? null, targetLevel.level_code, i.notes ?? null],
        );
        const scheme = (await c.query('SELECT display_name FROM official_grade_scheme_catalogue WHERE id=$1', [app.scheme_id])).rows[0];
        await notify(app.user_id, 'grade_upgrade_approved', { scheme_name: scheme?.display_name, level_name: targetLevel?.display_name });
      } else if (i.action === 'reject') {
        await notify(app.user_id, 'grade_upgrade_rejected', { notes: i.notes });
      }

      const updatedApp = (await c.query(
        `UPDATE official_grade_upgrade_applications SET
           status=$2, decided_by=$3, decided_at=$4, decision_reason=$5,
           assessor_id=COALESCE($6,assessor_id), assessor_endorsed_at=$7, assessor_notes=$8, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [ i.id, newStatus,
          ['approve','reject'].includes(i.action) ? user.id : app.decided_by,
          ['approve','reject'].includes(i.action) ? new Date() : app.decided_at,
          ['approve','reject'].includes(i.action) ? (i.notes ?? null) : app.decision_reason,
          i.action === 'assessor_endorse' ? (i.assessor_id ?? user.id) : null,
          i.action === 'assessor_endorse' ? new Date() : null,
          i.action === 'assessor_endorse' ? (i.notes ?? null) : null ],
      )).rows[0];
      await audit(c, user.id, `grade_upgrade.${i.action}`, 'official_grade_upgrade_applications', i.id);
      return updatedApp;
    });
  },
});

cap({
  name: 'list_grade_upgrade_applications', method: 'GET', path: '/official-grade-upgrade-applications', tag: TAG,
  auth: ['admin','federation','assessor'],
  summary: 'Federation/assessor/admin: list upgrade applications with filter by scheme, status and official. Sorted by most recent.',
  input: z.object({
    scheme_id: id.optional(),
    status:    z.enum(['submitted','assessor_requested','assessor_endorsed','evidence_needed','in_review','approved','rejected','withdrawn','all']).default('submitted'),
    user_id:   id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const conditions = ["a.status != 'withdrawn'"]; const args = [];
    if (i.status !== 'all') { args.push(i.status); conditions.push(`a.status=$${args.length}`); }
    if (i.scheme_id) { args.push(i.scheme_id); conditions.push(`a.scheme_id=$${args.length}`); }
    if (i.user_id) { args.push(i.user_id); conditions.push(`a.user_id=$${args.length}`); }
    args.push(i.limit, i.offset);
    const rows = await many(
      `SELECT a.*, sc.display_name AS scheme_name, sc.governing_body,
              cl.level_code AS current_level_code, cl.display_name AS current_level_name,
              tl.level_code AS target_level_code, tl.display_name AS target_level_name,
              u.display_name AS official_name
       FROM official_grade_upgrade_applications a
       JOIN official_grade_scheme_catalogue sc ON sc.id=a.scheme_id
       JOIN official_grade_scheme_levels cl ON cl.id=a.current_level_id
       JOIN official_grade_scheme_levels tl ON tl.id=a.target_level_id
       JOIN users u ON u.id=a.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.submitted_at DESC LIMIT $${args.length-1} OFFSET $${args.length}`,
      args,
    );
    return { applications: rows };
  },
});

// ── Grade audit log ───────────────────────────────────────────────────────

cap({
  name: 'get_official_grade_audit_log', method: 'GET', path: '/officials/:id/grade-audit-log', tag: TAG,
  auth: ['admin','federation','assessor'],
  summary: 'Federation/admin: full grade change audit trail for an official across all schemes.',
  input: z.object({ id, scheme_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT l.*, sc.display_name AS scheme_name, sc.governing_body,
              u.display_name AS actor_name
       FROM official_grade_audit_log l
       JOIN official_grade_scheme_catalogue sc ON sc.id=l.scheme_id
       JOIN users u ON u.id=l.actor_id
       WHERE l.user_id=$1 ${i.scheme_id ? 'AND l.scheme_id=$2' : ''}
       ORDER BY l.logged_at DESC LIMIT $${i.scheme_id ? 3 : 2} OFFSET $${i.scheme_id ? 4 : 3}`,
      [i.id, ...(i.scheme_id ? [i.scheme_id] : []), i.limit, i.offset],
    );
    return { log: rows };
  },
});

// ── Officials for a scheme (federation/admin/assessor) ────────────────────

cap({
  name: 'list_scheme_officials', method: 'GET', path: '/official-grade-schemes/:id/officials', tag: TAG,
  auth: ['admin','federation','assessor','organizer'],
  summary: 'List officials with an active grade in a scheme, with their current grade level, verification status and pending upgrade.',
  input: z.object({ id, verification_status: z.enum(['self_declared','pending','verified','rejected','all']).default('all'), ...page }),
  async handler({ user }, i) {
    const vs = i.verification_status !== 'all' ? `AND g.verification_status=$2` : '';
    const args = [i.id, ...(i.verification_status !== 'all' ? [i.verification_status] : []), i.limit, i.offset];
    const rows = await many(
      `SELECT g.id AS grade_id, g.user_id, g.level_id, g.verification_status, g.assigned_role, g.effective_from,
              sl.level_code, sl.display_name AS level_name, sl.rank_order,
              u.display_name AS official_name, u.avatar_url,
              (SELECT status FROM official_grade_upgrade_applications a WHERE a.user_id=g.user_id AND a.scheme_id=g.scheme_id AND a.status NOT IN ('approved','rejected','withdrawn') LIMIT 1) AS pending_upgrade_status
       FROM official_scheme_grades g
       JOIN official_grade_scheme_levels sl ON sl.id=g.level_id
       JOIN users u ON u.id=g.user_id
       WHERE g.scheme_id=$1 AND g.status='active' ${vs}
       ORDER BY sl.rank_order, u.display_name
       LIMIT $${args.length-1} OFFSET $${args.length}`,
      args,
    );
    return { officials: rows };
  },
});
