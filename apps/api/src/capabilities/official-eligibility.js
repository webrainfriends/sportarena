// Official eligibility, conflict-of-interest and safeguarding for tournament officials (issue #1000, REF-R09).
// Extends assertOfficialEligible (src/officials.js) with: active-suspension gate, minimum-age policy,
// training-certificate requirements, safeguarding/youth-access clearance, association neutrality flag,
// undecided conflict-of-interest blocks, and a discretionary event-organiser override with full audit trail.
//
// Privacy contract:
//   • Eligibility responses say ELIGIBLE or INELIGIBLE per factor — never the sanction type, evidence or case detail.
//   • detail_enc fields in official_conflicts are readable only by the declaring official and the event organiser.
//   • Suspension state is from the canonical discipline/integrity modules; no copy is stored here.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, hasRole } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';
import { activeSportingSanction } from '../integrity.js';
import { blocksOn, BLOCKING_KINDS } from '../discipline.js';
import { serviceFor } from '../discipline-live.js';
import { gate as complianceGate, hasObligations } from '../compliance.js';
import { ASSIGNMENT_SQL } from '../officials.js';
import { openCase } from '../cases.js';

const TAG = 'Official eligibility';
const txt = (n) => z.string().trim().max(n);
const dateTime = z.string().datetime({ offset: true });
const today = () => new Date().toISOString().slice(0, 10);

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

/** Load a fixture official row, confirming the caller is either the official or the event organiser. */
async function loadAssignment(c, assignmentId, user, { lock = false, requireOrg = false } = {}) {
  const sql = lock ? 'FOR UPDATE' : '';
  const fo = (await c.query(`SELECT fo.*, f.event_id, f.sport_id AS f_sport_id, f.scheduled_at, f.duration_min, e.sport_id, e.official_policy, e.official_min_grade_rank, e.official_min_age, e.official_training_required, e.official_safeguarding_required, e.official_neutrality_required, e.official_conflict_declaration_required, e.organizer_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.id=$1 ${sql}`, [assignmentId])).rows[0];
  if (!fo) throw notFound('Official assignment');
  const isOfficial = fo.user_id === user.id;
  const isOrg = fo.organizer_id === user.id || hasRole(user, 'admin');
  if (!isOfficial && !isOrg) throw notFound('Official assignment');
  if (requireOrg && !isOrg) throw forbidden('Only the event organiser can do this');
  return { fo, isOrg, isOfficial };
}

/** Active override for a specific factor on this assignment (not revoked, not expired). */
async function activeOverride(c, foId, factorKey) {
  return (await c.query(
    "SELECT id FROM official_eligibility_overrides WHERE fixture_official_id=$1 AND factor_key=$2 AND revoked_at IS NULL AND override_expires_at > now()",
    [foId, factorKey])).rows[0] ?? null;
}

/** Undecided (open) conflicts on this assignment that are still blocking. */
async function openConflicts(c, foId) {
  return (await c.query("SELECT id, kind, serious, counterparty, raised_at FROM official_conflicts WHERE fixture_official_id=$1 AND status='open'", [foId])).rows;
}

/** Is the official suspended for this sport on the assignment date? Returns true = blocked. */
async function isSuspended(c, userId, sportId, day) {
  if (await activeSportingSanction(c, userId, sportId, day)) return true;
  const rows = (await c.query(
    `SELECT s.* FROM disc_sanctions s JOIN comp_competitions k ON k.id=s.competition_id
      WHERE s.subject_user_id=$1 AND s.superseded_at IS NULL AND s.status IN ('interim','active') AND s.kind = ANY($2::text[]) AND COALESCE(s.sport_id, k.sport_id)=$3`,
    [userId, BLOCKING_KINDS, sportId])).rows;
  for (const s of rows) {
    if (blocksOn(s, day, s.kind === 'match_suspension' ? await serviceFor(c, s) : null)) return true;
  }
  return false;
}

/** Evaluate all eligibility factors for one assignment. Returns { eligible, factors, blocking }. */
async function evaluateEligibility(c, fo) {
  const day = fo.scheduled_at ? fo.scheduled_at.toISOString?.().slice(0, 10) ?? String(fo.scheduled_at).slice(0, 10) : today();
  const sportId = fo.sport_id;
  const userId = fo.user_id;
  const factors = [];
  const blocking = [];

  const factor = async (key, label, fn) => {
    const override = await activeOverride(c, fo.id, key);
    let state, detail = null;
    try {
      const result = await fn();
      state = result.state;
      detail = result.detail ?? null;
    } catch (e) {
      state = 'ineligible';
      detail = e.message ?? 'Check failed';
    }
    if (override && state === 'ineligible') { state = 'overridden'; detail = `${detail ?? ''} (override in force)`.trim(); }
    factors.push({ key, label, state, detail, override_id: override?.id ?? null });
    if (state === 'ineligible') blocking.push(key);
  };

  // 1. Sport profile
  await factor('sport_profile', 'Referee sport profile', async () => {
    if (fo.role === 'scorer') return { state: 'eligible' };
    const ok = (await c.query("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [userId, sportId])).rowCount;
    return ok ? { state: 'eligible' } : { state: 'ineligible', detail: 'No active referee sport profile for this sport' };
  });

  // 2. Credential policy
  await factor('credential', 'Licence / credential', async () => {
    const policy = fo.official_policy ?? 'optional';
    if (policy === 'optional') return { state: 'eligible', detail: 'Self-declared accepted' };
    const v = (await c.query("SELECT expires_at FROM verification_cases WHERE type='referee' AND subject_type='user' AND subject_id=$1 AND status='approved' AND expires_at > now() AND (sport_id IS NULL OR sport_id=$2) LIMIT 1", [userId, sportId])).rows[0];
    if (policy === 'verified') return v ? { state: 'eligible' } : { state: 'ineligible', detail: 'Verified official badge required' };
    const l = (await c.query("SELECT t.grade_rank FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.holder_id=$1 AND l.status='active' AND l.expires_on >= current_date AND t.holder_role='official' AND t.sport_id=$2 ORDER BY t.grade_rank DESC LIMIT 1", [userId, sportId])).rows[0];
    if (!l) return { state: 'ineligible', detail: 'Federation licence required' };
    const minRank = fo.official_min_grade_rank ?? 0;
    return l.grade_rank >= minRank ? { state: 'eligible' } : { state: 'ineligible', detail: `Minimum licence grade rank ${minRank} required (yours: ${l.grade_rank})` };
  });

  // 3. Active suspension (cannot be overridden)
  {
    const suspended = await isSuspended(c, userId, sportId, day);
    factors.push({ key: 'suspension', label: 'No active suspension', state: suspended ? 'ineligible' : 'eligible', detail: suspended ? 'An active sporting sanction or match suspension applies' : null, override_id: null });
    if (suspended) blocking.push('suspension');
  }

  // 4. Minimum age
  await factor('min_age', 'Minimum age', async () => {
    const minAge = fo.official_min_age;
    if (!minAge) return { state: 'eligible', detail: 'No minimum age set' };
    const dob = (await c.query("SELECT birth_date FROM profiles WHERE user_id=$1", [userId])).rows[0]?.birth_date;
    if (!dob) return { state: 'pending', detail: 'Date of birth not on record' };
    const age = Math.floor((new Date(day) - new Date(dob)) / (365.25 * 864e5));
    return age >= minAge ? { state: 'eligible' } : { state: 'ineligible', detail: `Must be at least ${minAge} years old (record shows ${age})` };
  });

  // 5. Training certificates
  await factor('training', 'Required training', async () => {
    const required = fo.official_training_required ?? [];
    if (!required.length) return { state: 'eligible', detail: 'No training requirements set' };
    const held = (await c.query(
      "SELECT category FROM compliance_records WHERE subject_id=$1 AND subject_type='user' AND organisation_id IS NULL AND state='active' AND category = ANY($2::text[])",
      [userId, required])).rows.map((r) => r.category);
    const missing = required.filter((r) => !held.includes(r));
    return missing.length ? { state: 'ineligible', detail: `Missing: ${missing.join(', ')}` } : { state: 'eligible' };
  });

  // 6. Safeguarding clearance (youth events)
  await factor('safeguarding', 'Child safeguarding clearance', async () => {
    if (!fo.official_safeguarding_required) return { state: 'eligible', detail: 'Not required for this event' };
    const ctx = {};
    const hasObs = await hasObligations(c, 'youth_access', ctx);
    if (!hasObs) return { state: 'eligible', detail: 'No youth-access obligation configured' };
    const g = await complianceGate(c, userId, 'youth_access', ctx);
    if (g.decision === 'clear') return { state: 'eligible' };
    return { state: g.decision === 'pending' ? 'pending' : 'ineligible', detail: g.reasons?.join('; ') ?? 'Clearance not complete' };
  });

  // 7. Association neutrality
  await factor('neutrality', 'Association neutrality', async () => {
    if (!fo.official_neutrality_required) return { state: 'eligible', detail: 'Not required for this event' };
    const teamIds = (await c.query("SELECT home_team_id, away_team_id FROM fixtures WHERE id=(SELECT fixture_id FROM fixture_officials WHERE id=$1)", [fo.id])).rows[0];
    if (!teamIds) return { state: 'eligible' };
    const tids = [teamIds.home_team_id, teamIds.away_team_id].filter(Boolean);
    if (!tids.length) return { state: 'eligible' };
    const linked = (await c.query(
      `SELECT 1 FROM associations a WHERE a.user_id=$1 AND a.status='active'
         AND a.target_type='team' AND a.target_id = ANY($2::uuid[]) LIMIT 1`, [userId, tids])).rowCount;
    return linked ? { state: 'ineligible', detail: 'Official has an active role with a competing team' } : { state: 'eligible' };
  });

  // 8. Undecided conflicts
  {
    const open = await openConflicts(c, fo.id);
    const needsDecl = fo.official_conflict_declaration_required;
    if (open.length) {
      factors.push({ key: 'conflicts', label: 'No undecided conflicts', state: 'ineligible', detail: `${open.length} undecided conflict declaration${open.length === 1 ? '' : 's'}`, override_id: null });
      blocking.push('conflicts');
    } else if (needsDecl) {
      factors.push({ key: 'conflicts', label: 'No undecided conflicts', state: 'eligible', detail: 'Declaration required; none pending' });
    }
  }

  const eligible = blocking.length === 0;
  return { eligible, factors, blocking };
}

// ─── Capability: eligibility policy on the event ─────────────────────────────────────────────────────

cap({
  name: 'get_eligibility_policy', method: 'GET', path: '/events/:id/official-eligibility-policy', tag: TAG,
  summary: 'Read the official eligibility policy for an event: credential tier, minimum age, required training codes, safeguarding flag, neutrality flag and conflict declaration requirement.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    return { event_id: ev.id, official_policy: ev.official_policy, official_min_grade_rank: ev.official_min_grade_rank, official_min_age: ev.official_min_age, official_training_required: ev.official_training_required, official_safeguarding_required: ev.official_safeguarding_required, official_neutrality_required: ev.official_neutrality_required, official_conflict_declaration_required: ev.official_conflict_declaration_required };
  },
});

cap({
  name: 'update_eligibility_policy', method: 'PUT', path: '/events/:id/official-eligibility-policy', tag: TAG,
  summary: 'Update the official eligibility policy for an event. Set minimum age, required training certificate codes, safeguarding/youth-access check, association neutrality requirement, or whether officials must make a conflict-of-interest declaration before each match.',
  input: z.object({
    id,
    official_min_age: z.number().int().min(16).max(80).nullable().optional(),
    official_training_required: z.array(txt(80)).max(20).optional(),
    official_safeguarding_required: z.boolean().optional(),
    official_neutrality_required: z.boolean().optional(),
    official_conflict_declaration_required: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const sets = [];
    const vals = [ev.id];
    const push = (col, val) => { sets.push(`${col}=$${vals.push(val)}`); };
    if (i.official_min_age !== undefined) push('official_min_age', i.official_min_age);
    if (i.official_training_required !== undefined) push('official_training_required', i.official_training_required);
    if (i.official_safeguarding_required !== undefined) push('official_safeguarding_required', i.official_safeguarding_required);
    if (i.official_neutrality_required !== undefined) push('official_neutrality_required', i.official_neutrality_required);
    if (i.official_conflict_declaration_required !== undefined) push('official_conflict_declaration_required', i.official_conflict_declaration_required);
    if (!sets.length) throw badRequest('No fields to update');
    const row = (await pool.query(`UPDATE events SET ${sets.join(', ')} WHERE id=$1 RETURNING official_policy, official_min_grade_rank, official_min_age, official_training_required, official_safeguarding_required, official_neutrality_required, official_conflict_declaration_required`, vals)).rows[0];
    await audit(null, user.id, 'update_eligibility_policy', 'events', ev.id);
    return { event_id: ev.id, ...row };
  },
});

// ─── Capability: evaluate eligibility ────────────────────────────────────────────────────────────

cap({
  name: 'evaluate_official_eligibility', method: 'GET', path: '/official-assignments/:id/eligibility', tag: TAG,
  summary: 'Evaluate all eligibility factors for an official assignment: credential, suspension, age, training, safeguarding, neutrality and conflict declarations. Returns eligible true/false, per-factor states, and the list of blocking factors. Suspension state is never the sanction detail — only eligible/ineligible.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { fo } = await loadAssignment(pool, i.id, user);
    return evaluateEligibility(pool, fo);
  },
});

cap({
  name: 'list_fixture_eligibility', method: 'GET', path: '/fixtures/:id/officials/eligibility', tag: TAG,
  summary: 'Organiser view: eligibility snapshot for every crew member on a fixture. Each entry has the official name, role, assignment status, and their eligibility evaluation.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = (await pool.query("SELECT organizer_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1", [i.id])).rows[0];
    if (!ev || (ev.organizer_id !== user.id && !hasRole(user, 'admin'))) throw notFound('Fixture');
    const officials = (await pool.query(`SELECT fo.id, fo.role, fo.status, fo.user_id, u.display_name FROM fixture_officials fo JOIN users u ON u.id=fo.user_id WHERE fo.fixture_id=$1 AND fo.status IN ('invited','accepted') ORDER BY fo.created_at`, [i.id])).rows;
    const enriched = (await pool.query(`SELECT fo.*, f.event_id, e.sport_id, e.official_policy, e.official_min_grade_rank, e.official_min_age, e.official_training_required, e.official_safeguarding_required, e.official_neutrality_required, e.official_conflict_declaration_required, f.scheduled_at, f.duration_min FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id JOIN events e ON e.id=f.event_id WHERE fo.fixture_id=$1 AND fo.status IN ('invited','accepted')`, [i.id])).rows;
    const byId = Object.fromEntries(enriched.map((r) => [r.id, r]));
    const results = await Promise.all(officials.map(async (o) => {
      const result = await evaluateEligibility(pool, byId[o.id]);
      return { assignment_id: o.id, user_id: o.user_id, display_name: o.display_name, role: o.role, status: o.status, ...result };
    }));
    return results;
  },
});

// ─── Capability: eligibility overrides ──────────────────────────────────────────────────────────────────

cap({
  name: 'grant_eligibility_override', method: 'POST', path: '/official-assignments/:id/eligibility/override', tag: TAG, status: 201,
  summary: 'Event organiser grants a discretionary override for a blocking eligibility factor other than suspension (suspensions cannot be overridden). The reason is logged. The override lapses when it expires or is revoked.',
  input: z.object({ id, factor_key: txt(60), reason: txt(1000).min(5), override_expires_at: dateTime }),
  async handler({ user }, i) {
    if (i.factor_key === 'suspension') throw badRequest('Active sporting suspensions cannot be overridden here. Contact the governing body.');
    return tx(async (c) => {
      const { fo } = await loadAssignment(c, i.id, user, { requireOrg: true });
      const expires = new Date(i.override_expires_at);
      if (expires <= new Date()) throw badRequest('override_expires_at must be in the future');
      const row = (await c.query(
        'INSERT INTO official_eligibility_overrides(fixture_official_id, factor_key, reason, granted_by, override_expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [fo.id, i.factor_key, i.reason, user.id, expires])).rows[0];
      await audit(c, user.id, 'grant_eligibility_override', 'official_eligibility_overrides', row.id);
      await notify(c, fo.user_id, { kind: 'official_eligibility', title: 'Eligibility override granted', body: `The organiser waived the ${i.factor_key} requirement for your upcoming assignment.`, data: { assignment_id: fo.id } });
      return row;
    });
  },
});

cap({
  name: 'revoke_eligibility_override', method: 'POST', path: '/official-eligibility-overrides/:id/revoke', tag: TAG,
  summary: 'Event organiser revokes a discretionary override they previously granted. The official is notified.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ov = (await c.query('SELECT * FROM official_eligibility_overrides WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ov) throw notFound('Override');
      const { fo } = await loadAssignment(c, ov.fixture_official_id, user, { requireOrg: true });
      if (ov.revoked_at) throw conflict('Already revoked');
      await c.query('UPDATE official_eligibility_overrides SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [ov.id, user.id]);
      await audit(c, user.id, 'revoke_eligibility_override', 'official_eligibility_overrides', ov.id);
      await notify(c, fo.user_id, { kind: 'official_eligibility', title: 'Eligibility override revoked', body: `The organiser has revoked the ${ov.factor_key} override. Your eligibility will be re-checked.`, data: { assignment_id: fo.id } });
      return { id: ov.id, revoked_at: new Date() };
    });
  },
});

cap({
  name: 'list_eligibility_overrides', method: 'GET', path: '/official-assignments/:id/eligibility/overrides', tag: TAG,
  summary: 'Audit log of all eligibility overrides on an assignment, including revoked ones. Readable by the official and the event organiser.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { fo } = await loadAssignment(pool, i.id, user);
    const rows = await many(
      `SELECT o.*, u.display_name AS granted_by_name, r.display_name AS revoked_by_name
         FROM official_eligibility_overrides o JOIN users u ON u.id=o.granted_by LEFT JOIN users r ON r.id=o.revoked_by
        WHERE o.fixture_official_id=$1 ORDER BY o.created_at DESC, o.id LIMIT $2 OFFSET $3`,
      [fo.id, i.limit, i.offset]);
    return rows;
  },
});

// ─── Capability: appeal ────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'appeal_eligibility_decision', method: 'POST', path: '/official-assignments/:id/eligibility/appeal', tag: TAG, status: 201,
  summary: 'Official submits a formal appeal against an ineligibility determination. Opens a support case routed to the event organiser (and governing body contact if set). The appeal does not automatically lift the block; the organiser must grant an override or the sanction must be lifted at source.',
  input: z.object({ id, grounds: txt(2000).min(10), supporting_note: txt(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { fo } = await loadAssignment(c, i.id, user);
      if (fo.user_id !== user.id) throw forbidden('Only the official can submit an appeal for their own assignment');
      const { eligible } = await evaluateEligibility(c, fo);
      if (eligible) throw conflict('No blocking eligibility factors to appeal', { code: 'already_eligible' });
      const caseRow = await openCase(c, {
        kind: 'official_eligibility_appeal', subject_type: 'fixture_official', subject_id: fo.id,
        opened_by: user.id, assigned_to: fo.organizer_id,
        title: 'Eligibility appeal', body_enc: encrypt(i.grounds, 'official_eligibility_appeal.grounds'),
      });
      await audit(c, user.id, 'appeal_eligibility_decision', 'fixture_officials', fo.id);
      await notify(c, fo.organizer_id, { kind: 'official_eligibility', title: 'Official submitted an eligibility appeal', body: `Review the appeal in the Officials Eligibility panel.`, data: { assignment_id: fo.id, case_id: caseRow.id } });
      return { case_id: caseRow.id, status: 'open' };
    });
  },
});
