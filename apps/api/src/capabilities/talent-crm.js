// Talent CRM & Recruiting Pipeline (issue #582). Club-side pipeline owned by an organisation,
// covering a 10-stage lifecycle: prospect → identified → watching → scouted → trial →
// shortlisted → negotiating → offered → signed/rejected. Reuses existing athlete profiles,
// passport videos, contracts and transfers — never creates duplicate identities.
// Personal data (notes, comms, off-platform athlete names) is field-level encrypted.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { toCsv } from '../csv.js';

const TAG = 'TalentCRM';
const CLUB_ROLES = ['club_admin', 'team_manager', 'coach', 'club_director'];
const STAGES = ['prospect', 'identified', 'watching', 'scouted', 'trial', 'shortlisted', 'negotiating', 'offered', 'signed', 'rejected'];
const TERMINAL = new Set(['signed', 'rejected']);
const SOURCE_KINDS = ['manual', 'billboard', 'scouting', 'transfer', 'academy', 'referral'];
const PRIORITIES = ['high', 'normal', 'low', 'watchlist'];
const SCOUT_ROLES = ['lead', 'secondary', 'observer'];
const EVAL_BASES = ['live_viewing', 'video', 'match_report', 'trial', 'profile_only'];
const COMM_KINDS = ['note', 'call', 'meeting', 'email', 'message', 'decision', 'trial_outcome', 'offer_sent', 'offer_response'];
const SLA_DAYS = { prospect: 7, identified: 14, watching: 21, scouted: 28, trial: 10, shortlisted: 14, negotiating: 21, offered: 7 };

const stale = (cur) => conflict('Changed elsewhere — reload and retry.', { code: 'stale_version', row_version: cur.row_version });
const version = z.number().int().min(1);
const isoDate = z.string().date();
const noteKey = z.string().min(8).max(80);

async function requireCrmAccess(user, orgId, write = false) {
  const member = await one('SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND left_at IS NULL', [orgId, user.id]);
  if (!member && !(await isAdmin(user))) throw forbidden('Not a member of this organisation');
  if (write && member && !CLUB_ROLES.includes(member.role) && !(await isAdmin(user))) throw forbidden('Insufficient role for this action');
}
async function requireCrmWrite(user, orgId) { return requireCrmAccess(user, orgId, true); }

async function prospectOrg(prospectId) {
  const p = await one('SELECT id, org_id, row_version, stage, archived_at FROM talent_crm_prospects WHERE id=$1', [prospectId]);
  if (!p) throw notFound('Prospect');
  return p;
}

function decryptName(p) {
  if (p.display_name) return p.display_name;
  if (p.athlete_name_enc) {
    try { return decrypt(p.athlete_name_enc, 'talent_crm_prospects.athlete_name'); } catch { return '[encrypted]'; }
  }
  return 'Unknown';
}

async function writeEvent(c, prospectId, action, actorId, fromStage, toStage, note) {
  const noteEnc = note ? encrypt(note, 'talent_crm_prospect_events.note') : null;
  await c.query(
    'INSERT INTO talent_crm_prospect_events(prospect_id, action, from_stage, to_stage, actor_id, note_enc) VALUES($1,$2,$3,$4,$5,$6)',
    [prospectId, action, fromStage ?? null, toStage ?? null, actorId, noteEnc],
  );
}

// ── 1. list_talent_crm_prospects ───────────────────────────────────────────
cap({
  name: 'list_talent_crm_prospects', method: 'GET', path: '/organisations/:id/talent-crm/prospects', tag: TAG,
  summary: 'List prospects in this organisation\'s talent CRM, grouped by pipeline stage with KPIs and per-card metrics.',
  input: z.object({
    id,
    sport_id: id.optional(),
    stage: z.enum(STAGES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    scout_id: id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    await requireCrmAccess(user, i.id);
    const wheres = ['p.org_id=$1', 'p.archived_at IS NULL'];
    const vals = [i.id];
    let idx = 2;
    if (i.sport_id) { wheres.push(`p.sport_id=$${idx++}`); vals.push(i.sport_id); }
    if (i.stage) { wheres.push(`p.stage=$${idx++}`); vals.push(i.stage); }
    if (i.priority) { wheres.push(`p.priority=$${idx++}`); vals.push(i.priority); }
    if (i.scout_id) {
      wheres.push(`EXISTS (SELECT 1 FROM talent_crm_scout_assignments a WHERE a.prospect_id=p.id AND a.scout_id=$${idx++} AND a.archived_at IS NULL)`);
      vals.push(i.scout_id);
    }
    const rows = await many(
      `SELECT p.id, p.stage, p.priority, p.position, p.source_kind, p.sport_id, p.athlete_id, p.athlete_name_enc,
              p.created_at, p.updated_at,
              u.display_name,
              s.name AS sport_name, s.emoji AS sport_emoji,
              EXTRACT(EPOCH FROM (now() - p.updated_at))/86400 AS days_in_stage,
              (SELECT e.overall FROM talent_crm_evaluations e WHERE e.prospect_id=p.id AND e.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 1) AS last_eval_overall,
              (SELECT string_agg(us.display_name, ', ' ORDER BY a.assigned_at) FROM talent_crm_scout_assignments a JOIN users us ON us.id=a.scout_id WHERE a.prospect_id=p.id AND a.archived_at IS NULL AND a.completed_at IS NULL) AS scout_names
         FROM talent_crm_prospects p
         LEFT JOIN users u ON u.id=p.athlete_id
         LEFT JOIN sports s ON s.id=p.sport_id
        WHERE ${wheres.join(' AND ')}
        ORDER BY p.priority='high' DESC, p.updated_at DESC
        LIMIT $${idx++} OFFSET $${idx}`,
      [...vals, i.limit, i.offset],
    );

    const kpis = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE stage='signed')::int AS signed,
              count(*) FILTER (WHERE stage NOT IN ('signed','rejected') AND EXTRACT(EPOCH FROM (now()-updated_at))/86400 > COALESCE((CASE stage WHEN 'prospect' THEN 7 WHEN 'identified' THEN 14 WHEN 'watching' THEN 21 WHEN 'scouted' THEN 28 WHEN 'trial' THEN 10 WHEN 'shortlisted' THEN 14 WHEN 'negotiating' THEN 21 WHEN 'offered' THEN 7 END),99))::int AS overdue,
              round(avg(CASE WHEN stage='signed' THEN EXTRACT(EPOCH FROM (updated_at-created_at))/86400 END))::int AS median_days_signed
         FROM talent_crm_prospects WHERE org_id=$1 AND archived_at IS NULL`,
      [i.id],
    );

    const total_active = kpis.total || 0;
    const conversion_rate = total_active > 0 ? Math.round((kpis.signed / total_active) * 1000) / 10 : 0;

    const prospects = rows.map((r) => ({
      id: r.id,
      stage: r.stage,
      priority: r.priority,
      position: r.position,
      source_kind: r.source_kind,
      sport: { id: r.sport_id, name: r.sport_name, emoji: r.sport_emoji },
      display_name: decryptName(r),
      days_in_stage: Math.floor(Number(r.days_in_stage)),
      last_eval_overall: r.last_eval_overall,
      scout_names: r.scout_names,
      sla_overdue: SLA_DAYS[r.stage] ? Number(r.days_in_stage) > SLA_DAYS[r.stage] : false,
    }));

    const by_stage = {};
    for (const s of STAGES) by_stage[s] = [];
    for (const p of prospects) by_stage[p.stage].push(p);
    const stage_counts = {};
    for (const s of STAGES) stage_counts[s] = by_stage[s].length;

    return { prospects, by_stage, stage_counts, kpis: { total: total_active, signed: kpis.signed, overdue: kpis.overdue, median_days_signed: kpis.median_days_signed, conversion_rate } };
  },
});

// ── 2. add_talent_crm_prospect ─────────────────────────────────────────────
cap({
  name: 'add_talent_crm_prospect', method: 'POST', path: '/organisations/:id/talent-crm/prospects', tag: TAG,
  summary: 'Add a new prospect to this organisation\'s talent CRM pipeline. Provide athlete_id if they are on the platform, otherwise provide athlete_name.',
  input: z.object({
    id,
    athlete_id: id.optional(),
    athlete_name: z.string().trim().min(1).max(200).optional(),
    sport_id: id,
    source_kind: z.enum(SOURCE_KINDS).default('manual'),
    source_ref_id: id.optional(),
    priority: z.enum(PRIORITIES).default('normal'),
    position: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).refine((d) => d.athlete_id || d.athlete_name, { message: 'Provide athlete_id (on-platform) or athlete_name (off-platform)' }),
  async handler({ user }, i) {
    await requireCrmWrite(user, i.id);
    if (!(await one('SELECT 1 FROM organisations WHERE id=$1', [i.id]))) throw notFound('Organisation');
    if (!(await one('SELECT 1 FROM sports WHERE id=$1', [i.sport_id]))) throw notFound('Sport');
    if (i.athlete_id && !(await one('SELECT 1 FROM users WHERE id=$1', [i.athlete_id]))) throw notFound('Athlete');

    const nameEnc = !i.athlete_id && i.athlete_name ? encrypt(i.athlete_name, 'talent_crm_prospects.athlete_name') : null;
    const notesEnc = i.notes ? encrypt(i.notes, 'talent_crm_prospects.notes') : null;

    return tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO talent_crm_prospects(org_id, athlete_id, athlete_name_enc, sport_id, source_kind, source_ref_id, priority, position, notes_enc, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.id, i.athlete_id ?? null, nameEnc, i.sport_id, i.source_kind, i.source_ref_id ?? null, i.priority, i.position ?? null, notesEnc, user.id],
      );
      const p = rows[0];
      await writeEvent(c, p.id, 'created', user.id, null, 'prospect', null);
      await audit(c, user.id, 'talent_crm_prospect.created', { prospect_id: p.id, org_id: i.id });
      return { id: p.id, stage: p.stage, priority: p.priority, source_kind: p.source_kind, row_version: p.row_version };
    });
  },
});

// ── 3. get_talent_crm_prospect ─────────────────────────────────────────────
cap({
  name: 'get_talent_crm_prospect', method: 'GET', path: '/talent-crm/prospects/:id', tag: TAG,
  summary: 'Full prospect record including evaluations, communications, assignments and event history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one(
      `SELECT p.*, u.display_name, s.name AS sport_name, s.emoji AS sport_emoji,
              o.name AS org_name,
              EXTRACT(EPOCH FROM (now()-p.updated_at))/86400 AS days_in_stage
         FROM talent_crm_prospects p
         LEFT JOIN users u ON u.id=p.athlete_id
         LEFT JOIN sports s ON s.id=p.sport_id
         LEFT JOIN organisations o ON o.id=p.org_id
        WHERE p.id=$1`, [i.id],
    );
    if (!p) throw notFound('Prospect');
    await requireCrmAccess(user, p.org_id);

    const [assignments, evals, comms, events] = await Promise.all([
      many(`SELECT a.*, u.display_name AS scout_name FROM talent_crm_scout_assignments a JOIN users u ON u.id=a.scout_id WHERE a.prospect_id=$1 AND a.archived_at IS NULL ORDER BY a.assigned_at DESC`, [i.id]),
      many(`SELECT e.*, u.display_name AS scout_name, t.name AS template_name FROM talent_crm_evaluations e JOIN users u ON u.id=e.scout_id LEFT JOIN talent_crm_evaluation_templates t ON t.id=e.template_id WHERE e.prospect_id=$1 AND e.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 3`, [i.id]),
      many(`SELECT c.*, u.display_name AS actor_name FROM talent_crm_communications c JOIN users u ON u.id=c.actor_id WHERE c.prospect_id=$1 ORDER BY c.created_at DESC LIMIT 5`, [i.id]),
      many(`SELECT e.action, e.from_stage, e.to_stage, e.created_at, u.display_name AS actor_name FROM talent_crm_prospect_events e JOIN users u ON u.id=e.actor_id WHERE e.prospect_id=$1 ORDER BY e.created_at DESC LIMIT 50`, [i.id]),
    ]);

    const decNotes = p.notes_enc ? (() => { try { return decrypt(p.notes_enc, 'talent_crm_prospects.notes'); } catch { return null; } })() : null;
    const decRationale = p.decision_rationale_enc ? (() => { try { return decrypt(p.decision_rationale_enc, 'talent_crm_prospects.decision_rationale'); } catch { return null; } })() : null;
    const displayName = decryptName({ ...p });

    return {
      ...p,
      display_name: displayName,
      notes: decNotes,
      decision_rationale: decRationale,
      notes_enc: undefined,
      decision_rationale_enc: undefined,
      athlete_name_enc: undefined,
      days_in_stage: Math.floor(Number(p.days_in_stage)),
      sla_overdue: SLA_DAYS[p.stage] ? Number(p.days_in_stage) > SLA_DAYS[p.stage] : false,
      sla_days: SLA_DAYS[p.stage] ?? null,
      assignments,
      evaluations: evals.map((e) => ({
        ...e,
        notes: e.notes_enc ? (() => { try { return decrypt(e.notes_enc, 'talent_crm_evaluations.notes'); } catch { return null; } })() : null,
        notes_enc: undefined,
      })),
      communications: comms.map((c) => ({
        ...c,
        summary: c.summary_enc ? (() => { try { return decrypt(c.summary_enc, 'talent_crm_communications.summary'); } catch { return null; } })() : null,
        summary_enc: undefined,
      })),
      history: events,
    };
  },
});

// ── 4. update_talent_crm_prospect ──────────────────────────────────────────
cap({
  name: 'update_talent_crm_prospect', method: 'PATCH', path: '/talent-crm/prospects/:id', tag: TAG,
  summary: 'Update priority, position, notes or decision rationale on a prospect.',
  input: z.object({
    id,
    priority: z.enum(PRIORITIES).optional(),
    position: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(2000).optional(),
    decision_rationale: z.string().trim().max(2000).optional(),
    row_version: version,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM talent_crm_prospects WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Prospect');
      await requireCrmWrite(user, cur.org_id);
      if (cur.row_version !== i.row_version) throw stale(cur);
      const notesEnc = i.notes !== undefined ? (i.notes ? encrypt(i.notes, 'talent_crm_prospects.notes') : null) : cur.notes_enc;
      const ratEnc = i.decision_rationale !== undefined ? (i.decision_rationale ? encrypt(i.decision_rationale, 'talent_crm_prospects.decision_rationale') : null) : cur.decision_rationale_enc;
      const { rows } = await c.query(
        `UPDATE talent_crm_prospects SET priority=COALESCE($2,priority), position=COALESCE($3,position), notes_enc=$4, decision_rationale_enc=$5, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.priority ?? null, i.position ?? null, notesEnc, ratEnc],
      );
      await writeEvent(c, i.id, 'updated', user.id, null, null, null);
      return { row_version: rows[0].row_version };
    });
  },
});

// ── 5. move_talent_crm_stage ───────────────────────────────────────────────
cap({
  name: 'move_talent_crm_stage', method: 'POST', path: '/talent-crm/prospects/:id/stage', tag: TAG,
  summary: 'Advance or adjust a prospect\'s stage in the pipeline. Terminal stages (signed/rejected) cannot be moved from.',
  input: z.object({ id, to_stage: z.enum(STAGES), note: z.string().trim().max(500).optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Prospect');
      await requireCrmWrite(user, cur.org_id);
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (TERMINAL.has(cur.stage)) throw badRequest(`Cannot move from terminal stage '${cur.stage}'`);
      const fromIdx = STAGES.indexOf(cur.stage);
      const toIdx = STAGES.indexOf(i.to_stage);
      if (fromIdx - toIdx > 2) throw badRequest('Cannot move backward more than 2 stages');
      const { rows } = await c.query(
        `UPDATE talent_crm_prospects SET stage=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.to_stage],
      );
      await writeEvent(c, i.id, 'stage_moved', user.id, cur.stage, i.to_stage, i.note);
      await audit(c, user.id, 'talent_crm_prospect.stage_moved', { prospect_id: i.id, from: cur.stage, to: i.to_stage });
      return { stage: i.to_stage, row_version: rows[0].row_version };
    });
  },
});

// ── 6. archive_talent_crm_prospect ─────────────────────────────────────────
cap({
  name: 'archive_talent_crm_prospect', method: 'POST', path: '/talent-crm/prospects/:id/archive', tag: TAG,
  summary: 'Archive a prospect (soft delete). The record and all history are retained.',
  input: z.object({ id, note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT org_id FROM talent_crm_prospects WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Prospect');
      await requireCrmWrite(user, cur.org_id);
      await c.query('UPDATE talent_crm_prospects SET archived_at=now() WHERE id=$1', [i.id]);
      await writeEvent(c, i.id, 'archived', user.id, null, null, i.note);
      return { archived: true };
    });
  },
});

// ── 7. assign_talent_crm_scout ─────────────────────────────────────────────
cap({
  name: 'assign_talent_crm_scout', method: 'POST', path: '/talent-crm/prospects/:id/assignments', tag: TAG,
  summary: 'Assign a scout to watch this prospect. The scout must be a member of the organisation.',
  input: z.object({ id, scout_id: id, role: z.enum(SCOUT_ROLES).default('lead') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT org_id FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL', [i.id])).rows[0];
      if (!cur) throw notFound('Prospect');
      await requireCrmWrite(user, cur.org_id);
      const scout = await one('SELECT id FROM org_members WHERE org_id=$1 AND user_id=$2 AND left_at IS NULL', [cur.org_id, i.scout_id]);
      if (!scout && !(await isAdmin({ id: i.scout_id }))) throw badRequest('Scout must be a member of the organisation');
      const { rows } = await c.query(
        'INSERT INTO talent_crm_scout_assignments(prospect_id, scout_id, role, assigned_by) VALUES($1,$2,$3,$4) RETURNING id',
        [i.id, i.scout_id, i.role, user.id],
      );
      await writeEvent(c, i.id, 'scout_assigned', user.id, null, null, null);
      return { assignment_id: rows[0].id };
    });
  },
});

// ── 8. list_talent_crm_assignments ─────────────────────────────────────────
cap({
  name: 'list_talent_crm_assignments', method: 'GET', path: '/talent-crm/prospects/:id/assignments', tag: TAG,
  summary: 'List active scout assignments for a prospect.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cur = await one('SELECT org_id FROM talent_crm_prospects WHERE id=$1', [i.id]);
    if (!cur) throw notFound('Prospect');
    await requireCrmAccess(user, cur.org_id);
    return many(
      `SELECT a.id, a.scout_id, a.role, a.assigned_at, a.completed_at, u.display_name AS scout_name
         FROM talent_crm_scout_assignments a JOIN users u ON u.id=a.scout_id
        WHERE a.prospect_id=$1 AND a.archived_at IS NULL ORDER BY a.assigned_at DESC`,
      [i.id],
    );
  },
});

// ── 9. complete_talent_crm_assignment ──────────────────────────────────────
cap({
  name: 'complete_talent_crm_assignment', method: 'POST', path: '/talent-crm/assignments/:id/complete', tag: TAG,
  summary: 'Mark a scout assignment as complete.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query(`SELECT a.id, a.prospect_id, p.org_id FROM talent_crm_scout_assignments a JOIN talent_crm_prospects p ON p.id=a.prospect_id WHERE a.id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!a) throw notFound('Assignment');
      await requireCrmWrite(user, a.org_id);
      await c.query('UPDATE talent_crm_scout_assignments SET completed_at=now() WHERE id=$1', [i.id]);
      await writeEvent(c, a.prospect_id, 'assignment_completed', user.id, null, null, null);
      return { completed: true };
    });
  },
});

// ── 10. save_talent_crm_evaluation ─────────────────────────────────────────
cap({
  name: 'save_talent_crm_evaluation', method: 'POST', path: '/talent-crm/prospects/:id/evaluations', tag: TAG,
  summary: 'Record a scout evaluation for a prospect. Optionally use a saved evaluation template.',
  input: z.object({
    id,
    template_id: id.optional(),
    basis: z.enum(EVAL_BASES),
    observed_on: isoDate.optional(),
    ratings: z.record(z.string(), z.number().min(0).max(10)).default({}),
    overall: z.number().int().min(0).max(10).optional(),
    notes: z.string().trim().max(2000).optional(),
    idempotency_key: noteKey,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const existing = (await c.query('SELECT id, overall FROM talent_crm_evaluations WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
      if (existing) return { id: existing.id, overall: existing.overall, duplicate: true };

      const p = (await c.query('SELECT org_id FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL', [i.id])).rows[0];
      if (!p) throw notFound('Prospect');
      await requireCrmWrite(user, p.org_id);

      const vals = Object.values(i.ratings);
      const autoOverall = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
      const overall = i.overall ?? autoOverall;
      const notesEnc = i.notes ? encrypt(i.notes, 'talent_crm_evaluations.notes') : null;

      const { rows } = await c.query(
        `INSERT INTO talent_crm_evaluations(prospect_id, scout_id, template_id, basis, observed_on, ratings, overall, notes_enc, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, overall`,
        [i.id, user.id, i.template_id ?? null, i.basis, i.observed_on ?? null, JSON.stringify(i.ratings), overall, notesEnc, i.idempotency_key],
      );
      await writeEvent(c, i.id, 'evaluation_added', user.id, null, null, null);
      return { id: rows[0].id, overall: rows[0].overall };
    });
  },
});

// ── 11. list_talent_crm_evaluations ────────────────────────────────────────
cap({
  name: 'list_talent_crm_evaluations', method: 'GET', path: '/talent-crm/prospects/:id/evaluations', tag: TAG,
  summary: 'List all evaluations for a prospect, most recent first.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT org_id FROM talent_crm_prospects WHERE id=$1', [i.id]);
    if (!p) throw notFound('Prospect');
    await requireCrmAccess(user, p.org_id);
    const rows = await many(
      `SELECT e.id, e.basis, e.observed_on, e.ratings, e.overall, e.notes_enc, e.created_at,
              u.display_name AS scout_name, t.name AS template_name
         FROM talent_crm_evaluations e
         JOIN users u ON u.id=e.scout_id
         LEFT JOIN talent_crm_evaluation_templates t ON t.id=e.template_id
        WHERE e.prospect_id=$1 AND e.archived_at IS NULL
        ORDER BY e.created_at DESC`,
      [i.id],
    );
    return rows.map((e) => ({
      ...e,
      notes: e.notes_enc ? (() => { try { return decrypt(e.notes_enc, 'talent_crm_evaluations.notes'); } catch { return null; } })() : null,
      notes_enc: undefined,
    }));
  },
});

// ── 12. archive_talent_crm_evaluation ──────────────────────────────────────
cap({
  name: 'archive_talent_crm_evaluation', method: 'POST', path: '/talent-crm/evaluations/:id/archive', tag: TAG,
  summary: 'Archive (soft-delete) an evaluation.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query(`SELECT e.id, p.org_id FROM talent_crm_evaluations e JOIN talent_crm_prospects p ON p.id=e.prospect_id WHERE e.id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!e) throw notFound('Evaluation');
      await requireCrmWrite(user, e.org_id);
      await c.query('UPDATE talent_crm_evaluations SET archived_at=now() WHERE id=$1', [i.id]);
      return { archived: true };
    });
  },
});

// ── 13. list_talent_crm_evaluation_templates ───────────────────────────────
cap({
  name: 'list_talent_crm_evaluation_templates', method: 'GET', path: '/organisations/:id/talent-crm/evaluation-templates', tag: TAG,
  summary: 'List evaluation templates for this organisation, optionally filtered by sport.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i) {
    await requireCrmAccess(user, i.id);
    const rows = await many(
      `SELECT t.id, t.name, t.criteria, t.sport_id, s.name AS sport_name, t.row_version, t.created_by
         FROM talent_crm_evaluation_templates t
         LEFT JOIN sports s ON s.id=t.sport_id
        WHERE t.org_id=$1 AND t.archived_at IS NULL ${i.sport_id ? 'AND (t.sport_id=$2 OR t.sport_id IS NULL)' : ''}
        ORDER BY t.name`,
      i.sport_id ? [i.id, i.sport_id] : [i.id],
    );
    return rows;
  },
});

// ── 14. save_talent_crm_evaluation_template ────────────────────────────────
cap({
  name: 'save_talent_crm_evaluation_template', method: 'POST', path: '/organisations/:id/talent-crm/evaluation-templates', tag: TAG,
  summary: 'Create a custom evaluation template with weighted criteria for this organisation.',
  input: z.object({
    id,
    sport_id: id.optional(),
    name: z.string().trim().min(2).max(80),
    criteria: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), weight: z.number().min(0).max(1) })).min(1).max(20),
  }),
  async handler({ user }, i) {
    await requireCrmWrite(user, i.id);
    const { rows } = await query(
      'INSERT INTO talent_crm_evaluation_templates(org_id, sport_id, name, criteria, created_by) VALUES($1,$2,$3,$4,$5) RETURNING id, row_version',
      [i.id, i.sport_id ?? null, i.name, JSON.stringify(i.criteria), user.id],
    );
    return rows[0];
  },
});

// ── 15. update_talent_crm_evaluation_template ──────────────────────────────
cap({
  name: 'update_talent_crm_evaluation_template', method: 'PATCH', path: '/talent-crm/evaluation-templates/:id', tag: TAG,
  summary: 'Update the name or criteria of an evaluation template.',
  input: z.object({
    id,
    name: z.string().trim().min(2).max(80).optional(),
    criteria: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), weight: z.number().min(0).max(1) })).min(1).max(20).optional(),
    row_version: version,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM talent_crm_evaluation_templates WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Template');
      await requireCrmWrite(user, cur.org_id);
      if (cur.row_version !== i.row_version) throw stale(cur);
      const { rows } = await c.query(
        `UPDATE talent_crm_evaluation_templates SET name=COALESCE($2,name), criteria=COALESCE($3::jsonb,criteria), row_version=row_version+1 WHERE id=$1 RETURNING row_version`,
        [i.id, i.name ?? null, i.criteria ? JSON.stringify(i.criteria) : null],
      );
      return { row_version: rows[0].row_version };
    });
  },
});

// ── 16. list_talent_crm_shortlist_boards ───────────────────────────────────
cap({
  name: 'list_talent_crm_shortlist_boards', method: 'GET', path: '/organisations/:id/talent-crm/boards', tag: TAG,
  summary: 'List shortlist comparison boards for this organisation.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireCrmAccess(user, i.id);
    const boards = await many(
      `SELECT b.id, b.name, b.sport_id, b.position, b.row_version,
              s.name AS sport_name,
              count(e.id) FILTER (WHERE e.removed_at IS NULL)::int AS entry_count
         FROM talent_crm_shortlist_boards b
         LEFT JOIN sports s ON s.id=b.sport_id
         LEFT JOIN talent_crm_shortlist_board_entries e ON e.board_id=b.id
        WHERE b.org_id=$1 AND b.archived_at IS NULL
        GROUP BY b.id, s.name ORDER BY b.name`,
      [i.id],
    );
    for (const board of boards) {
      board.preview_names = (await many(
        `SELECT p.id, p.athlete_id, p.athlete_name_enc, u.display_name
           FROM talent_crm_shortlist_board_entries e
           JOIN talent_crm_prospects p ON p.id=e.prospect_id
           LEFT JOIN users u ON u.id=p.athlete_id
          WHERE e.board_id=$1 AND e.removed_at IS NULL ORDER BY e.rank NULLS LAST, e.added_at LIMIT 4`,
        [board.id],
      )).map(decryptName);
    }
    return boards;
  },
});

// ── 17. create_talent_crm_shortlist_board ──────────────────────────────────
cap({
  name: 'create_talent_crm_shortlist_board', method: 'POST', path: '/organisations/:id/talent-crm/boards', tag: TAG,
  summary: 'Create a new shortlist comparison board for a position and sport.',
  input: z.object({ id, sport_id: id.optional(), position: z.string().trim().max(80).optional(), name: z.string().trim().min(2).max(80) }),
  async handler({ user }, i) {
    await requireCrmWrite(user, i.id);
    const { rows } = await query(
      'INSERT INTO talent_crm_shortlist_boards(org_id, sport_id, position, name, created_by) VALUES($1,$2,$3,$4,$5) RETURNING id, row_version',
      [i.id, i.sport_id ?? null, i.position ?? null, i.name, user.id],
    );
    return rows[0];
  },
});

// ── 18. get_talent_crm_shortlist_board ─────────────────────────────────────
cap({
  name: 'get_talent_crm_shortlist_board', method: 'GET', path: '/talent-crm/boards/:id', tag: TAG,
  summary: 'Get a shortlist board with full comparison data: prospect profiles and their latest evaluation scores per criterion.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const board = await one('SELECT * FROM talent_crm_shortlist_boards WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!board) throw notFound('Board');
    await requireCrmAccess(user, board.org_id);
    const entries = await many(
      `SELECT e.id AS entry_id, e.rank, e.notes_enc, e.added_at,
              p.id AS prospect_id, p.stage, p.priority, p.position, p.athlete_id, p.athlete_name_enc,
              u.display_name,
              ev.overall AS last_overall, ev.ratings AS last_ratings, ev.observed_on AS eval_date, ev.basis AS eval_basis,
              su.display_name AS last_scout_name
         FROM talent_crm_shortlist_board_entries e
         JOIN talent_crm_prospects p ON p.id=e.prospect_id
         LEFT JOIN users u ON u.id=p.athlete_id
         LEFT JOIN LATERAL (
           SELECT ev2.overall, ev2.ratings, ev2.observed_on, ev2.basis, ev2.scout_id
             FROM talent_crm_evaluations ev2
            WHERE ev2.prospect_id=p.id AND ev2.archived_at IS NULL
            ORDER BY ev2.created_at DESC LIMIT 1
         ) ev ON true
         LEFT JOIN users su ON su.id=ev.scout_id
        WHERE e.board_id=$1 AND e.removed_at IS NULL
        ORDER BY e.rank NULLS LAST, e.added_at`,
      [i.id],
    );
    return {
      board,
      entries: entries.map((e) => ({
        ...e,
        display_name: decryptName(e),
        notes: e.notes_enc ? (() => { try { return decrypt(e.notes_enc, 'talent_crm_shortlist_board_entries.notes'); } catch { return null; } })() : null,
        notes_enc: undefined,
        athlete_name_enc: undefined,
      })),
    };
  },
});

// ── 19. add_to_shortlist_board ─────────────────────────────────────────────
cap({
  name: 'add_to_shortlist_board', method: 'POST', path: '/talent-crm/boards/:id/entries', tag: TAG,
  summary: 'Add a prospect to a shortlist comparison board.',
  input: z.object({ id, prospect_id: id, rank: z.number().int().min(1).optional(), notes: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const board = (await c.query('SELECT org_id FROM talent_crm_shortlist_boards WHERE id=$1 AND archived_at IS NULL', [i.id])).rows[0];
      if (!board) throw notFound('Board');
      await requireCrmWrite(user, board.org_id);
      const p = (await c.query('SELECT org_id FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL', [i.prospect_id])).rows[0];
      if (!p) throw notFound('Prospect');
      if (p.org_id !== board.org_id) throw badRequest('Prospect belongs to a different organisation');
      const notesEnc = i.notes ? encrypt(i.notes, 'talent_crm_shortlist_board_entries.notes') : null;
      const { rows } = await c.query(
        'INSERT INTO talent_crm_shortlist_board_entries(board_id, prospect_id, rank, notes_enc, added_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [i.id, i.prospect_id, i.rank ?? null, notesEnc, user.id],
      );
      return { entry_id: rows[0].id };
    });
  },
});

// ── 20. remove_from_shortlist_board ────────────────────────────────────────
cap({
  name: 'remove_from_shortlist_board', method: 'POST', path: '/talent-crm/boards/:id/entries/:entry_id/remove', tag: TAG,
  summary: 'Remove a prospect from a shortlist board (soft remove).',
  input: z.object({ id, entry_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query(`SELECT e.id, b.org_id FROM talent_crm_shortlist_board_entries e JOIN talent_crm_shortlist_boards b ON b.id=e.board_id WHERE e.id=$1 AND e.board_id=$2 FOR UPDATE`, [i.entry_id, i.id])).rows[0];
      if (!e) throw notFound('Entry');
      await requireCrmWrite(user, e.org_id);
      await c.query('UPDATE talent_crm_shortlist_board_entries SET removed_at=now() WHERE id=$1', [i.entry_id]);
      return { removed: true };
    });
  },
});

// ── 21. log_talent_crm_communication ───────────────────────────────────────
cap({
  name: 'log_talent_crm_communication', method: 'POST', path: '/talent-crm/prospects/:id/communications', tag: TAG,
  summary: 'Log a communication touchpoint or decision for a prospect.',
  input: z.object({
    id,
    kind: z.enum(COMM_KINDS),
    summary: z.string().trim().min(1).max(2000),
    follow_up_on: isoDate.optional(),
    idempotency_key: noteKey,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const existing = (await c.query('SELECT id FROM talent_crm_communications WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
      if (existing) return { id: existing.id, duplicate: true };
      const p = (await c.query('SELECT org_id FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL', [i.id])).rows[0];
      if (!p) throw notFound('Prospect');
      await requireCrmWrite(user, p.org_id);
      const summaryEnc = encrypt(i.summary, 'talent_crm_communications.summary');
      const { rows } = await c.query(
        `INSERT INTO talent_crm_communications(prospect_id, actor_id, kind, summary_enc, follow_up_on, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [i.id, user.id, i.kind, summaryEnc, i.follow_up_on ?? null, i.idempotency_key],
      );
      if (i.kind === 'decision') {
        await writeEvent(c, i.id, 'decision_logged', user.id, null, null, i.summary.slice(0, 200));
      }
      return { id: rows[0].id };
    });
  },
});

// ── 22. list_talent_crm_communications ─────────────────────────────────────
cap({
  name: 'list_talent_crm_communications', method: 'GET', path: '/talent-crm/prospects/:id/communications', tag: TAG,
  summary: 'List all communications for a prospect, most recent first.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT org_id FROM talent_crm_prospects WHERE id=$1', [i.id]);
    if (!p) throw notFound('Prospect');
    await requireCrmAccess(user, p.org_id);
    const rows = await many(
      `SELECT c.id, c.kind, c.summary_enc, c.follow_up_on, c.created_at, u.display_name AS actor_name
         FROM talent_crm_communications c JOIN users u ON u.id=c.actor_id
        WHERE c.prospect_id=$1 ORDER BY c.created_at DESC`,
      [i.id],
    );
    return rows.map((c) => ({
      ...c,
      summary: c.summary_enc ? (() => { try { return decrypt(c.summary_enc, 'talent_crm_communications.summary'); } catch { return null; } })() : null,
      summary_enc: undefined,
    }));
  },
});

// ── 23. get_talent_crm_analytics ───────────────────────────────────────────
cap({
  name: 'get_talent_crm_analytics', method: 'GET', path: '/organisations/:id/talent-crm/analytics', tag: TAG,
  summary: 'Pipeline analytics: funnel, conversion rate, ageing alerts, source quality, and scout performance.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i) {
    await requireCrmAccess(user, i.id);
    const filter = i.sport_id ? 'AND sport_id=$2' : '';
    const vals = i.sport_id ? [i.id, i.sport_id] : [i.id];

    const [stageCounts, ageing, bySrc, bySport, byScout] = await Promise.all([
      many(
        `SELECT stage, count(*)::int AS count FROM talent_crm_prospects WHERE org_id=$1 ${filter} AND archived_at IS NULL GROUP BY stage`,
        vals,
      ),
      many(
        `SELECT id AS prospect_id, stage,
                EXTRACT(EPOCH FROM (now()-updated_at))/86400 AS days_in_stage,
                CASE stage WHEN 'prospect' THEN 7 WHEN 'identified' THEN 14 WHEN 'watching' THEN 21
                           WHEN 'scouted' THEN 28 WHEN 'trial' THEN 10 WHEN 'shortlisted' THEN 14
                           WHEN 'negotiating' THEN 21 WHEN 'offered' THEN 7 END AS sla_days
           FROM talent_crm_prospects
          WHERE org_id=$1 ${filter} AND archived_at IS NULL AND stage NOT IN ('signed','rejected')
            AND EXTRACT(EPOCH FROM (now()-updated_at))/86400 > CASE stage
              WHEN 'prospect' THEN 7 WHEN 'identified' THEN 14 WHEN 'watching' THEN 21
              WHEN 'scouted' THEN 28 WHEN 'trial' THEN 10 WHEN 'shortlisted' THEN 14
              WHEN 'negotiating' THEN 21 WHEN 'offered' THEN 7 ELSE 999 END
          ORDER BY days_in_stage DESC`,
        vals,
      ),
      many(
        `SELECT source_kind, count(*)::int AS count, count(*) FILTER (WHERE stage='signed')::int AS signed FROM talent_crm_prospects WHERE org_id=$1 ${filter} AND archived_at IS NULL GROUP BY source_kind ORDER BY count DESC`,
        vals,
      ),
      many(
        `SELECT s.id, s.name, s.emoji, count(p.id)::int AS prospects, count(p.id) FILTER (WHERE p.stage='signed')::int AS signed FROM talent_crm_prospects p JOIN sports s ON s.id=p.sport_id WHERE p.org_id=$1 ${filter ? filter.replace('sport_id', 'p.sport_id') : ''} AND p.archived_at IS NULL GROUP BY s.id, s.name, s.emoji ORDER BY prospects DESC`,
        vals,
      ),
      many(
        `SELECT u.id, u.display_name, count(DISTINCT e.id)::int AS evaluations, count(DISTINCT pe.prospect_id) FILTER (WHERE pe.action='stage_moved')::int AS prospects_advanced
           FROM talent_crm_evaluations e
           JOIN users u ON u.id=e.scout_id
           JOIN talent_crm_prospects p ON p.id=e.prospect_id AND p.org_id=$1 ${filter ? filter.replace('sport_id', 'p.sport_id') : ''}
           LEFT JOIN talent_crm_prospect_events pe ON pe.prospect_id=e.prospect_id AND pe.actor_id=e.scout_id AND pe.action='stage_moved'
          WHERE e.archived_at IS NULL
          GROUP BY u.id, u.display_name ORDER BY evaluations DESC LIMIT 20`,
        vals,
      ),
    ]);

    const countByStage = {};
    for (const r of stageCounts) countByStage[r.stage] = r.count;
    const total = Object.values(countByStage).reduce((s, v) => s + v, 0);
    const signed = countByStage['signed'] || 0;

    const funnel = STAGES.map((s, idx) => {
      const count = countByStage[s] || 0;
      const prev = idx > 0 ? (countByStage[STAGES[idx - 1]] || 0) : null;
      return { stage: s, count, pct_from_prev: prev ? (prev > 0 ? Math.round((count / prev) * 100) : 0) : null };
    });

    return {
      funnel,
      total,
      signed,
      conversion_rate: total > 0 ? Math.round((signed / total) * 1000) / 10 : 0,
      ageing: ageing.map((r) => ({ ...r, days_in_stage: Math.floor(Number(r.days_in_stage)) })),
      by_source: bySrc,
      by_sport: bySport,
      by_scout: byScout,
    };
  },
});

// ── 24. export_talent_crm_analytics ────────────────────────────────────────
cap({
  name: 'export_talent_crm_analytics', method: 'GET', path: '/organisations/:id/talent-crm/analytics/export', tag: TAG,
  summary: 'Export all prospects as CSV with stage, priority, source, days in stage, scout and last eval score.',
  input: z.object({ id, sport_id: id.optional() }),
  async handler({ user }, i) {
    await requireCrmAccess(user, i.id);
    const filter = i.sport_id ? 'AND p.sport_id=$2' : '';
    const rows = await many(
      `SELECT p.id, p.stage, p.priority, p.source_kind, p.position,
              EXTRACT(EPOCH FROM (now()-p.updated_at))/86400 AS days_in_stage,
              COALESCE(u.display_name, '') AS athlete_name,
              s.name AS sport_name,
              (SELECT e.overall FROM talent_crm_evaluations e WHERE e.prospect_id=p.id AND e.archived_at IS NULL ORDER BY e.created_at DESC LIMIT 1) AS last_eval_overall,
              (SELECT string_agg(us.display_name, '; ' ORDER BY a.assigned_at) FROM talent_crm_scout_assignments a JOIN users us ON us.id=a.scout_id WHERE a.prospect_id=p.id AND a.archived_at IS NULL) AS scouts,
              p.created_at::date AS added_date
         FROM talent_crm_prospects p
         LEFT JOIN users u ON u.id=p.athlete_id
         LEFT JOIN sports s ON s.id=p.sport_id
        WHERE p.org_id=$1 ${filter} AND p.archived_at IS NULL
        ORDER BY p.stage, p.priority='high' DESC, p.updated_at DESC`,
      i.sport_id ? [i.id, i.sport_id] : [i.id],
    );
    const cols = ['id', 'athlete', 'sport', 'stage', 'priority', 'position', 'source', 'days_in_stage', 'last_eval', 'scouts', 'added'];
    const data = rows.map((r) => ({
      id: r.id,
      athlete: r.athlete_name,
      sport: r.sport_name,
      stage: r.stage,
      priority: r.priority,
      position: r.position ?? '',
      source: r.source_kind,
      days_in_stage: Math.floor(Number(r.days_in_stage)),
      last_eval: r.last_eval_overall ?? '',
      scouts: r.scouts ?? '',
      added: r.added_date,
    }));
    const csv = toCsv(cols, data);
    return { csv, filename: `talent-crm-export-${new Date().toISOString().slice(0, 10)}.csv` };
  },
});

// ── 25. handoff_talent_crm_prospect ────────────────────────────────────────
cap({
  name: 'handoff_talent_crm_prospect', method: 'POST', path: '/talent-crm/prospects/:id/handoff', tag: TAG,
  summary: 'Hand off a signed prospect to the contracts or transfers workflow. Marks the prospect with handoff metadata and returns navigation context for the client.',
  input: z.object({
    id,
    kind: z.enum(['opportunity', 'contract', 'transfer']),
    note: z.string().trim().max(500).optional(),
    row_version: version,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM talent_crm_prospects WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Prospect');
      await requireCrmWrite(user, cur.org_id);
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (!cur.athlete_id && i.kind !== 'opportunity') throw badRequest('Athlete must be on the platform for contract or transfer handoff');

      const toStage = STAGES.indexOf(cur.stage) < STAGES.indexOf('offered') ? 'offered' : cur.stage;
      const { rows } = await c.query(
        `UPDATE talent_crm_prospects SET handoff_kind=$2, stage=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.kind, toStage],
      );
      await writeEvent(c, i.id, 'handoff_initiated', user.id, cur.stage, toStage, i.note);
      await audit(c, user.id, 'talent_crm_prospect.handoff', { prospect_id: i.id, kind: i.kind });

      let navigation;
      if (i.kind === 'contract') {
        navigation = { screen: 'PlayerContracts', params: { athlete_id: cur.athlete_id, org_id: cur.org_id } };
      } else if (i.kind === 'transfer') {
        navigation = { screen: 'Competitions', params: { athlete_id: cur.athlete_id, hint: 'transfer' } };
      } else {
        navigation = { screen: 'Billboard', params: { org_id: cur.org_id, athlete_id: cur.athlete_id } };
      }
      return { handoff_kind: i.kind, stage: toStage, row_version: rows[0].row_version, navigation };
    });
  },
});
