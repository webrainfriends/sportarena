// Competition registration & player eligibility (issue #477): the one place that decides whether a player may represent a team in a competition
// and in a particular fixture. Canonical players, teams, team membership, contracts, guardian consent and licences stay where they are and are only
// REFERENCED; this module reads them and writes the registration facts (registrations, windows, exceptions, dependency references, snapshots).
//
// Decision semantics (deterministic, no side effects, same inputs -> same output):
//   every rule yields a check { rule, status: pass | fail | pending | unknown | waived, reason, source }.
//   ineligible = any check failed (and was not waived by a live exception); otherwise
//   unknown    = something that must be known could not be established (e.g. no date of birth on file); otherwise
//   pending    = something is awaiting a person (registration under review, clearance not yet confirmed); otherwise eligible.
// Nationality, residency, sex/gender category and classification are NEVER inferred: they are declared by the registrar or recorded as dependencies.
import { z } from 'zod';
import { many } from './db.js';
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { hasConsent, isYouth } from './youth.js';
import { conflict } from './errors.js';

export const LISTS = ['active', 'reserve', 'development'];
export const LIVE = ['submitted', 'under_review', 'registered', 'suspended'];
export const EXCEPTION_RULES = ['window', 'division_age', 'licence', 'transfer', 'loan', 'classification', 'disciplinary', 'contract', 'roster_limit', 'quota', 'guardian_consent'];
export const DEP_KINDS = ['licence', 'transfer', 'loan', 'disciplinary', 'classification'];
export const DECISIONS = ['eligible', 'ineligible', 'pending', 'unknown'];

const nz = z.number().int().min(0).max(500);
/** The versioned rule set. Unknown keys are refused so a typo can never silently disable a rule. */
export const RULES = z.object({
  playing_lists: z.array(z.enum(LISTS)).min(1).default(['active', 'reserve']),
  check_division_age: z.boolean().default(true),
  require_team_affiliation: z.boolean().default(true),
  required_clearances: z.array(z.enum(['licence', 'classification'])).max(2).default([]),
  require_contract: z.boolean().default(false),
  require_guardian_consent: z.boolean().default(true),
  roster: z.object({ max_total: nz.optional(), max_active: nz.optional(), max_reserve: nz.optional(), max_development: nz.optional(), freeze_at: z.string().datetime({ offset: true }).optional() }).strict().default({}),
  quotas: z.object({ max_foreign: nz.optional(), min_homegrown: nz.optional(), min_local: nz.optional() }).strict().default({}),
  waivable: z.array(z.enum(EXCEPTION_RULES)).default([]),
  block_on: z.array(z.enum(['ineligible', 'pending', 'unknown'])).min(1).default(['ineligible']),
  recheck_at_start: z.boolean().default(true),
}).strict();

const q = (c) => c ?? { query: (t, p) => many(t, p).then((rows) => ({ rows })) };
export const latestPolicy = (eventId, c) => q(c).query('SELECT * FROM reg_policies WHERE event_id=$1 ORDER BY version DESC LIMIT 1', [eventId]).then((r) => r.rows[0] ?? null);
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Youth without a current guardian consent are shown as a protected participant in lists, exports and notifications. */
export async function protectedIds(userIds, c) {
  if (!userIds.length) return new Set();
  const { rows } = await q(c).query(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND (u.youth_until IS NOT NULL AND u.youth_until > current_date)`, [userIds]);
  const out = new Set();
  for (const r of rows) if (!(await hasConsent(r.id, 'participation', c))) out.add(r.id);
  return out;
}
export const PROTECTED_NAME = 'Protected participant';

/** Live exceptions of a person for a rule at an instant. Returns the exception row or null. */
async function waiver(c, eventId, userId, rule, at) {
  return (await q(c).query(
    `SELECT id, rule_key, effective_to FROM reg_exceptions WHERE event_id=$1 AND user_id=$2 AND rule_key=$3 AND revoked_at IS NULL AND effective_from <= $4 AND effective_to > $4 ORDER BY created_at DESC LIMIT 1`,
    [eventId, userId, rule, at])).rows[0] ?? null;
}

const check = (rule, status, reason, source) => ({ rule, status, reason, ...(source ? { source } : {}) });

/**
 * The match-day (or any-day) decision for one person in one team of one competition.
 * `ctx` = { event, policy, at, actorId, dobCache }. Pure reads; the only write is the audit entry when a date of birth is decrypted.
 */
export async function evaluate(c, ctx, teamId, userId) {
  const { event, policy, at = new Date() } = ctx;
  const rules = policy.rules;
  const when = at instanceof Date ? at : new Date(at);
  const day = dayOf(when);
  const checks = [];
  const waivable = new Set(rules.waivable ?? []);
  const withWaiver = async (key, result) => {
    if (result.status !== 'fail' && result.status !== 'pending' && result.status !== 'unknown') return result;
    if (!waivable.has(key)) return result;
    const w = await waiver(c, event.id, userId, key, when);
    return w ? { ...result, status: 'waived', reason: `${result.reason} (waived by an authorised exception until ${dayOf(w.effective_to)})`, source: { kind: 'exception', id: w.id } } : result;
  };

  const reg = (await q(c).query(
    `SELECT r.*, d.name AS division_name, d.born_on_or_after, d.born_on_or_before FROM reg_registrations r LEFT JOIN reg_divisions d ON d.id=r.division_id
      WHERE r.event_id=$1 AND r.user_id=$2 ORDER BY (r.status = ANY($3::text[])) DESC, r.created_at DESC LIMIT 1`, [event.id, userId, LIVE])).rows[0];

  // 1 registration
  if (!reg) checks.push(check('registration', 'fail', 'Not registered for this competition', null));
  else if (reg.team_id !== teamId) checks.push(check('registration', 'fail', 'Registered with a different team in this competition', { kind: 'registration', id: reg.id }));
  else if (reg.status === 'registered') {
    if (reg.effective_from && dayOf(reg.effective_from) > day) checks.push(check('registration', 'fail', `Registration starts on ${dayOf(reg.effective_from)}`, { kind: 'registration', id: reg.id }));
    else if (reg.effective_to && dayOf(reg.effective_to) < day) checks.push(check('registration', 'fail', `Registration ended on ${dayOf(reg.effective_to)}`, { kind: 'registration', id: reg.id }));
    else checks.push(check('registration', 'pass', 'Registered', { kind: 'registration', id: reg.id }));
  } else if (['submitted', 'under_review'].includes(reg.status)) checks.push(check('registration', 'pending', 'Registration is awaiting a decision', { kind: 'registration', id: reg.id }));
  else if (reg.status === 'suspended') checks.push(check('registration', 'fail', 'Registration is suspended', { kind: 'registration', id: reg.id }));
  else checks.push(check('registration', 'fail', `Registration is ${reg.status}`, { kind: 'registration', id: reg.id }));

  // 2 roster list
  if (reg && reg.team_id === teamId && reg.status === 'registered') {
    if (rules.playing_lists.includes(reg.roster_list)) checks.push(check('roster_list', 'pass', `On the ${reg.roster_list} list`, { kind: 'registration', id: reg.id }));
    else checks.push(check('roster_list', 'fail', `The ${reg.roster_list} list is not eligible to play`, { kind: 'registration', id: reg.id }));
  }

  // 3 team affiliation (canonical team membership)
  if (rules.require_team_affiliation) {
    const m = (await q(c).query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [teamId, userId])).rows[0];
    checks.push(m ? check('team_affiliation', 'pass', 'Active member of the team', { kind: 'team_member', id: teamId }) : check('team_affiliation', 'fail', 'Not an active member of the team', { kind: 'team', id: teamId }));
  }

  // 4 age / date-of-birth category: the DOB is read only when the division defines a range, and the read is audit-logged
  if (rules.check_division_age && reg?.division_id && (reg.born_on_or_after || reg.born_on_or_before)) {
    const key = `dob:${userId}`;
    if (!(key in (ctx.cache ??= {}))) {
      const u = (await q(c).query('SELECT dob_enc FROM users WHERE id=$1', [userId])).rows[0];
      ctx.cache[key] = u?.dob_enc ? decrypt(u.dob_enc, 'users.dob') : null;
      if (ctx.cache[key]) await audit(c ?? null, ctx.actorId ?? null, 'read_dob_eligibility', 'users', userId);
    }
    const dob = ctx.cache[key] ? dayOf(ctx.cache[key]) : null;
    const src = { kind: 'division', id: reg.division_id };
    let r;
    if (!dob) r = check('division_age', 'unknown', `No date of birth on file to check the ${reg.division_name} category`, src);
    else if (reg.born_on_or_after && dob < dayOf(reg.born_on_or_after)) r = check('division_age', 'fail', `Outside the birth-date range for ${reg.division_name}`, src);
    else if (reg.born_on_or_before && dob > dayOf(reg.born_on_or_before)) r = check('division_age', 'fail', `Outside the birth-date range for ${reg.division_name}`, src);
    else r = check('division_age', 'pass', `Within the birth-date range for ${reg.division_name}`, src);
    checks.push(await withWaiver('division_age', r));
  }

  // 5 clearance dependencies: licence / transfer / loan / disciplinary / classification are references to records held elsewhere
  const deps = (await q(c).query(
    `SELECT DISTINCT ON (kind) id, kind, status, valid_from, valid_until, source_label FROM reg_dependencies
      WHERE event_id=$1 AND user_id=$2 AND superseded_at IS NULL AND (valid_from IS NULL OR valid_from <= $3::date) AND (valid_until IS NULL OR valid_until >= $3::date)
      ORDER BY kind, created_at DESC, id`, [event.id, userId, day])).rows;
  const byKind = new Map(deps.map((d) => [d.kind, d]));
  const NAME = { licence: 'Licence', transfer: 'Transfer clearance', loan: 'Loan clearance', classification: 'Classification', disciplinary: 'Disciplinary status' };
  for (const kind of DEP_KINDS) {
    const d = byKind.get(kind);
    const required = (rules.required_clearances ?? []).includes(kind);
    const src = d ? { kind: 'dependency', id: d.id, label: d.source_label ?? undefined } : null;
    let r = null;
    if (d?.status === 'blocked') r = check(kind === 'disciplinary' ? 'suspension' : kind, 'fail', kind === 'disciplinary' ? `Suspended${d.valid_until ? ` until ${dayOf(d.valid_until)}` : ''}` : `${NAME[kind]} is blocked`, src);
    else if (d?.status === 'pending') r = check(kind, 'pending', `${NAME[kind]} is awaiting confirmation`, src);
    else if (d?.status === 'clear') r = check(kind === 'disciplinary' ? 'suspension' : kind, 'pass', `${NAME[kind]} is clear`, src);
    else if (required) {
      let onFile = false;
      if (kind === 'licence') onFile = !!(await q(c).query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND license_no_enc IS NOT NULL LIMIT 1", [userId, event.sport_id])).rows[0];
      r = onFile ? check(kind, 'pending', 'A licence is on the player\'s profile but has not been confirmed for this competition', { kind: 'sport_profile' }) : check(kind, 'fail', `No ${NAME[kind].toLowerCase()} on record`, null);
    }
    if (!r) continue;
    const key = r.rule === 'suspension' ? 'disciplinary' : r.rule;
    checks.push(await withWaiver(key, r));
  }

  // 6 contract (reference to #333): only when the competition requires it
  if (rules.require_contract) {
    const k = (await q(c).query(
      "SELECT id FROM player_contracts WHERE payee_id=$1 AND role='player' AND status='active' AND (team_id=$2 OR event_id=$3) ORDER BY created_at DESC LIMIT 1", [userId, teamId, event.id])).rows[0];
    checks.push(await withWaiver('contract', k ? check('contract', 'pass', 'Active player contract', { kind: 'contract', id: k.id }) : check('contract', 'fail', 'No active player contract', null)));
  }

  // 7 youth / guardian participation consent
  if (rules.require_guardian_consent && (await isYouth(userId, c))) {
    const ok = await hasConsent(userId, 'participation', c);
    checks.push(await withWaiver('guardian_consent', ok ? check('guardian_consent', 'pass', 'Guardian consent for participation is current', null) : check('guardian_consent', 'fail', 'Guardian consent for participation is not current', null)));
  }

  // roster-level waivers for the window are applied at submission; the registration check itself cannot be waived here
  const decision = checks.some((x) => x.status === 'fail') ? 'ineligible' : checks.some((x) => x.status === 'unknown') ? 'unknown' : checks.some((x) => x.status === 'pending') ? 'pending' : 'eligible';
  return { user_id: userId, team_id: teamId, decision, checks, registration_id: reg?.id ?? null, registration_version: reg?.row_version ?? null };
}

/** People selected for a fixture by a team: a match-level squad wins over the event-level one. Staff roles never need eligibility. */
export async function fixtureSquadIds(c, fixture, teamId) {
  const base = "status IN ('selected','confirmed') AND role IN ('player','captain','vice_captain','substitute')";
  const match = (await q(c).query(`SELECT user_id FROM team_squads WHERE team_id=$1 AND fixture_id=$2 AND ${base}`, [teamId, fixture.id])).rows;
  if (match.length) return match.map((r) => r.user_id);
  return (await q(c).query(`SELECT user_id FROM team_squads WHERE team_id=$1 AND event_id=$2 AND fixture_id IS NULL AND ${base}`, [teamId, fixture.event_id])).rows.map((r) => r.user_id);
}

const blocks = (policy, decision) => policy.enforcement === 'blocking' && (policy.rules.block_on ?? ['ineligible']).includes(decision);

/** Evaluate a list of people for a team in a competition. */
export async function evaluateMany(c, ctx, teamId, userIds) {
  const out = [];
  for (const u of [...new Set(userIds)]) out.push(await evaluate(c, ctx, teamId, u));
  return out;
}

/** Refuse a squad (selection time) that a blocking policy would not allow. No policy = no enforcement (events that do not use registration are unchanged). */
export async function assertSquadEligible(c, event, teamId, userIds, actorId, { fixtureAt } = {}) {
  const policy = await latestPolicy(event.id, c);
  if (!policy) return null;
  const results = await evaluateMany(c, { event, policy, actorId, at: fixtureAt ?? new Date() }, teamId, userIds);
  const bad = results.filter((r) => blocks(policy, r.decision));
  if (bad.length) throw conflict('Some selected players are not eligible for this competition', { code: 'eligibility_blocked', policy_version: policy.version, players: bad.map((b) => ({ user_id: b.user_id, decision: b.decision, reasons: b.checks.filter((x) => x.status !== 'pass').map((x) => x.reason) })) });
  return { policy_version: policy.version, results };
}

/**
 * Lock the eligibility decision for both squads of a fixture, preserving the policy version, the rule set and the decision used. Idempotent per stage.
 * In a blocking policy an ineligible player stops the lock (and the kick-off) with the reasons; nothing is written then.
 */
export async function lockFixtureEligibility(c, event, fixture, actorId, stage) {
  const policy = await latestPolicy(event.id, c);
  if (!policy) return { enforced: false, locked: 0, decisions: [] };
  if (stage === 'start' && policy.rules.recheck_at_start === false && (await q(c).query("SELECT 1 FROM reg_snapshots WHERE fixture_id=$1 AND stage='lock' LIMIT 1", [fixture.id])).rows[0]) return { enforced: true, locked: 0, decisions: [], skipped: true };
  const ctx = { event, policy, actorId, at: new Date() };
  const all = [];
  for (const teamId of [fixture.home_team_id, fixture.away_team_id].filter(Boolean)) {
    const ids = await fixtureSquadIds(c, fixture, teamId);
    all.push(...await evaluateMany(c, ctx, teamId, ids));
  }
  const bad = all.filter((r) => blocks(policy, r.decision));
  if (bad.length) throw conflict('Some players in the squads are not eligible for this match', { code: 'eligibility_blocked', policy_version: policy.version, players: bad.map((b) => ({ user_id: b.user_id, team_id: b.team_id, decision: b.decision, reasons: b.checks.filter((x) => x.status !== 'pass').map((x) => x.reason) })) });
  let locked = 0;
  for (const r of all) {
    const ins = await q(c).query(
      `INSERT INTO reg_snapshots(event_id, fixture_id, team_id, user_id, stage, decision, checks, policy_id, policy_version, rules, registration_id, registration_version, evaluated_at, locked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13) ON CONFLICT (fixture_id, user_id, stage) DO NOTHING`,
      [event.id, fixture.id, r.team_id, r.user_id, stage, r.decision, JSON.stringify(r.checks), policy.id, policy.version, JSON.stringify(policy.rules), r.registration_id, r.registration_version, actorId]);
    locked += ins.rowCount;
  }
  return { enforced: true, locked, decisions: all, policy_version: policy.version };
}

