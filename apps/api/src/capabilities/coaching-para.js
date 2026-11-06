// PS-13 (#843): Adapted coaching programmes and performance sessions.
// Bridges the existing coaching journal (#269) with the para-sport inclusion layer (#808).
// No clinical data, no duplicate session/plan tables; extends block JSON and adds guide assignments.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { NEEDS_SUPPORT, SPORT_TEMPLATES } from '../inclusion.js';
import { block, ownRecord } from './coaching-journal.js';
import { scrub } from './coaching-templates.js';

const TAG = 'Para coaching';
const COACH = ['coach'];
const text = (n) => z.string().trim().max(n);

// ------------------------------------------------------------------ support requirements

cap({
  name: 'get_session_support_requirements', method: 'GET', path: '/coaching/sessions/:id/para-needs', tag: TAG, auth: COACH,
  summary: 'Return the consented operational support-need keys for every athlete in a coaching session, read from inclusion_shares where the audience is "coach". Only keys the athlete chose to share with coaches are returned; no diagnosis, impairment code or clinical record. Every call is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);

    // athletes currently in this session
    const athletes = await many(
      `SELECT p.athlete_id, u.display_name
         FROM coaching_session_participants p
         JOIN users u ON u.id = p.athlete_id
        WHERE p.session_record_id = $1
        ORDER BY u.display_name`,
      [rec.id],
    );
    if (!athletes.length) return { athletes: [] };

    const athleteIds = athletes.map((a) => a.athlete_id);

    // read consented operational flags shared with 'coach' audience that are still live
    const shares = await many(
      `SELECT s.athlete_id, s.need_keys
         FROM academy_accommodation_shares s
        WHERE s.athlete_id = ANY($1)
          AND 'coach' = ANY(s.audience_roles)
          AND $2 = ANY(s.audience_users)
          AND s.expires_at > now()
          AND s.revoked_at IS NULL`,
      [athleteIds, user.id],
    );

    // audit every retrieval — the athlete's chosen sharing record is sensitive
    for (const a of shares) {
      await audit(null, user.id, 'para.read_session_needs', 'academy_accommodation_shares', a.athlete_id, { session_record_id: rec.id });
    }

    const needsByAthlete = new Map(shares.map((s) => [s.athlete_id, s.need_keys ?? []]));

    return {
      athletes: athletes.map((a) => ({
        athlete_id: a.athlete_id,
        display_name: a.display_name,
        need_keys: needsByAthlete.get(a.athlete_id) ?? [],
        support_needs: (needsByAthlete.get(a.athlete_id) ?? []).filter((k) => NEEDS_SUPPORT.includes(k)),
      })),
      disclaimer: 'Need keys reflect only what the athlete chose to share with this coach. No clinical or diagnostic information is held here.',
    };
  },
});

// ------------------------------------------------------------------ guide assignments

cap({
  name: 'assign_session_guide', method: 'POST', path: '/coaching/sessions/:id/guides', tag: TAG, auth: COACH, status: 201,
  summary: 'Assign a guide or personal assistant to a specific athlete for a coaching session. The guide role must be one of the support-person types from the inclusion vocabulary. The coach operational note (why this guide, any logistics) is encrypted. guide_user_id is optional — an unnamed/external guide is allowed.',
  input: z.object({
    id,
    athlete_id: id,
    guide_user_id: id.optional(),
    guide_role: z.enum(NEEDS_SUPPORT),
    note: text(500).optional().describe('coach operational note, encrypted at rest; never shown to other athletes'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const rec = (await c.query('SELECT * FROM coaching_session_records WHERE id=$1 AND coach_id=$2', [i.id, user.id])).rows[0];
    if (!rec) throw notFound('Coaching session');
    if (rec.status === 'completed') throw conflict('Cannot assign a guide to a completed session');

    // athlete must be in this session
    const participant = (await c.query(
      'SELECT 1 FROM coaching_session_participants WHERE session_record_id=$1 AND athlete_id=$2',
      [rec.id, i.athlete_id],
    )).rows[0];
    if (!participant) throw notFound('Athlete is not in this session');

    // guide_user_id must exist if provided
    if (i.guide_user_id) {
      const g = (await c.query('SELECT 1 FROM users WHERE id=$1', [i.guide_user_id])).rows[0];
      if (!g) throw notFound('Guide user');
    }

    const encNote = i.note ? encrypt(i.note, 'coaching_session_guides.note') : null;

    // upsert: re-activating a previously removed assignment is fine
    const existing = (await c.query(
      `SELECT id FROM coaching_session_guides
        WHERE session_record_id=$1 AND athlete_id=$2 AND (guide_user_id=$3 OR (guide_user_id IS NULL AND $3::uuid IS NULL)) AND removed_at IS NOT NULL`,
      [rec.id, i.athlete_id, i.guide_user_id ?? null],
    )).rows[0];

    let row;
    if (existing) {
      row = (await c.query(
        'UPDATE coaching_session_guides SET guide_role=$2, note=$3, removed_at=NULL, assigned_at=now() WHERE id=$1 RETURNING *',
        [existing.id, i.guide_role, encNote],
      )).rows[0];
    } else {
      row = (await c.query(
        'INSERT INTO coaching_session_guides(session_record_id, athlete_id, guide_user_id, guide_role, note, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [rec.id, i.athlete_id, i.guide_user_id ?? null, i.guide_role, encNote, user.id],
      )).rows[0];
    }

    await audit(c, user.id, 'para.assign_guide', 'coaching_session_guides', row.id, { guide_role: i.guide_role });
    return { id: row.id, session_record_id: rec.id, athlete_id: i.athlete_id, guide_user_id: i.guide_user_id ?? null, guide_role: i.guide_role, assigned_at: row.assigned_at };
  }),
});

cap({
  name: 'remove_session_guide', method: 'DELETE', path: '/coaching/sessions/:session_id/guides/:guide_id', tag: TAG, auth: COACH,
  summary: 'Remove a guide assignment from a session. Sets removed_at; the record is kept for audit. The coach must own the session.',
  input: z.object({ session_id: id, guide_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = (await c.query(
      `UPDATE coaching_session_guides g SET removed_at=now()
         FROM coaching_session_records r
        WHERE g.id=$1 AND g.session_record_id=r.id AND r.coach_id=$2 AND g.removed_at IS NULL
        RETURNING g.id`,
      [i.guide_id, user.id],
    )).rows[0];
    if (!row) throw notFound('Guide assignment');
    await audit(c, user.id, 'para.remove_guide', 'coaching_session_guides', row.id);
    return { id: row.id, removed: true };
  }),
});

cap({
  name: 'list_session_guides', method: 'GET', path: '/coaching/sessions/:id/guides', tag: TAG, auth: COACH,
  summary: 'List active guide assignments for a coaching session. The coach must own the session. Guide names are shown only if the guide is a platform user; unnamed/external guides show null for display_name.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await ownRecord(user, i.id);
    const rows = await many(
      `SELECT g.id, g.athlete_id, ap.display_name AS athlete_name,
              g.guide_user_id, gu.display_name AS guide_name,
              g.guide_role, g.assigned_at
         FROM coaching_session_guides g
         JOIN users ap ON ap.id = g.athlete_id
         LEFT JOIN users gu ON gu.id = g.guide_user_id
        WHERE g.session_record_id = $1 AND g.removed_at IS NULL
        ORDER BY ap.display_name, g.assigned_at`,
      [rec.id],
    );
    return { guides: rows };
  },
});

// ------------------------------------------------------------------ para session templates

const PARA_TEMPLATE_KEYS = Object.keys(SPORT_TEMPLATES).filter((k) => k !== 'generic').concat(['generic']);

cap({
  name: 'save_para_session_template', method: 'POST', path: '/coaching/para-templates', tag: TAG, auth: COACH, status: 201,
  summary: 'Save a session or block template tagged with a para sport family (wheelchair_basketball, goalball_boccia, para_athletics, etc.). The template is stored in the shared coach_templates table with a para_template tag so it appears in the para-template picker. Personal athlete data is stripped before saving.',
  input: z.object({
    title: text(120).min(2),
    scope: z.enum(['block', 'session']).default('session'),
    para_template: z.enum(PARA_TEMPLATE_KEYS),
    blocks: z.array(block).min(1).max(30),
    sport: text(80).optional().describe('sport slug or id'),
  }),
  async handler({ user }, i) {
    let sportId = null;
    if (i.sport) {
      const sp = await one('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport]);
      if (!sp) throw notFound('Sport');
      sportId = sp.id;
    }

    const clean = i.blocks.map(scrub).map((b) => JSON.parse(JSON.stringify(b)));
    if (!clean.length) throw badRequest('No blocks to save');

    const tpl = await one(
      'INSERT INTO coach_templates(coach_id, sport_id, title, scope, blocks, para_template) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, title, scope, para_template, version, created_at',
      [user.id, sportId, i.title, i.scope, JSON.stringify(clean), i.para_template],
    );
    return tpl;
  },
});

cap({
  name: 'list_para_session_templates', method: 'GET', path: '/coaching/para-templates', tag: TAG, auth: COACH,
  summary: 'List session templates tagged for a para sport family, including templates shared with teams the coach coaches and organisations where they hold a coaching grant. Returns all para templates when para_template is omitted.',
  input: z.object({ para_template: z.enum(PARA_TEMPLATE_KEYS).optional(), scope: z.enum(['block', 'session', 'any']).default('any'), ...page }),
  async handler({ user }, i) {
    const ptFilter = i.para_template ? ' AND t.para_template=$3' : '';
    const params = i.para_template ? [user.id, i.limit ?? 60, i.para_template] : [user.id, i.limit ?? 60];
    const rows = await many(
      `SELECT t.id, t.coach_id, t.title, t.scope, t.para_template, t.sport_id, s.name AS sport_name,
              jsonb_array_length(t.blocks) AS block_count, t.version, t.created_at,
              (t.coach_id = $1) AS mine,
              u.display_name AS shared_by
         FROM coach_templates t
         LEFT JOIN sports s ON s.id = t.sport_id
         LEFT JOIN users u ON u.id = t.coach_id
        WHERE t.archived_at IS NULL
          AND t.para_template IS NOT NULL
          AND (
            t.coach_id = $1
            OR (t.shared_team_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=t.shared_team_id AND tm.user_id=$1 AND tm.status='active' AND tm.role='coach'))
            OR (t.shared_organisation_id IS NOT NULL AND EXISTS (SELECT 1 FROM organisation_members om WHERE om.organisation_id=t.shared_organisation_id AND om.user_id=$1 AND om.role IN ('owner','admin','coach') AND om.status='active' AND om.left_at IS NULL))
          )
          ${ptFilter}
          ${i.scope !== 'any' ? `AND t.scope=$${params.length + 1}` : ''}
        ORDER BY t.para_template, t.title
        LIMIT $2`,
      i.scope !== 'any' ? [...params, i.scope] : params,
    );
    return { templates: rows };
  },
});
