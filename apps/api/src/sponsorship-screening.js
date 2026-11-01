// Sponsorship eligibility screening (#287). Rules are immutable numbered versions per program; an application is screened against the
// version in force and each run is stored (append-only) with plain-language reasons, missing items and duplicate flags, so a later rule
// change never rewrites an earlier decision. Missing facts give `needs_info` - they are never guessed. A flag never rejects by itself.
import { createHash } from 'node:crypto';
import { conflict } from './errors.js';
import { badgesFor } from './verification.js';

export const OUTCOMES = ['eligible', 'needs_info', 'ineligible', 'review'];
export const EXCEPTION_ROLES = ['manager', 'approver'];

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const sameRules = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export const rulesHash = (programId, version, rules) => createHash('sha256').update(JSON.stringify({ programId, version, rules })).digest('hex');

/** The rule set a program currently carries, in the shape stored in sponsorship_eligibility_versions. */
export function rulesOfProgram(p, extra = {}) {
  const el = p.eligibility ?? {};
  return {
    target_types: el.target_types ?? [], sports: p.sports ?? [], regions: p.regions ?? [], verified_only: !!el.verified_only,
    max_award_cents: p.max_award_cents == null ? null : Number(p.max_award_cents),
    duplicate_check: extra.duplicate_check ?? true, required_documents: extra.required_documents ?? [],
  };
}

/** Append a new immutable version when the rules differ from the latest one (no-op otherwise). Run inside the program's transaction. */
export async function appendRules(c, programId, rules, userId, note = null) {
  const cur = (await c.query('SELECT version, rules FROM sponsorship_eligibility_versions WHERE program_id=$1 ORDER BY version DESC LIMIT 1', [programId])).rows[0];
  if (cur && sameRules(cur.rules, rules)) return cur.version;
  const version = (cur?.version ?? 0) + 1;
  await c.query('INSERT INTO sponsorship_eligibility_versions(program_id, version, rules, sha256, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [programId, version, rules, rulesHash(programId, version, rules), note, userId]);
  await c.query('UPDATE sponsorship_programs SET eligibility_version=$2 WHERE id=$1', [programId, version]);
  return version;
}

export async function currentRules(c, programId) {
  const v = (await c.query('SELECT * FROM sponsorship_eligibility_versions WHERE program_id=$1 ORDER BY version DESC LIMIT 1', [programId])).rows[0];
  if (!v) throw conflict('This program has no eligibility rules yet');
  return v;
}

const list = (a) => a.join(', ');
const met = (rule, message) => ({ code: `${rule}_met`, rule, status: 'met', message });
const unmet = (rule, message) => ({ code: `${rule}_unmet`, rule, status: 'unmet', message });
const unknown = (rule, message) => ({ code: `${rule}_unknown`, rule, status: 'unknown', message });

/**
 * Pure: judge facts against rules. `facts` fields that are `null` mean "we do not know" (never treated as a pass or a fail).
 * facts = { target_type, requested_cents|null, verified|null, sports|null, regions|null (null = unknown; [] = not applicable), documents:Set<string>|null }
 * Returns { outcome, reasons, missing }.
 */
export function evaluateEligibility(rules, facts) {
  const reasons = [], missing = [];
  if (rules.target_types?.length) {
    if (rules.target_types.includes(facts.target_type)) reasons.push(met('target_type', `This program funds ${list(rules.target_types)}; this application is for ${facts.target_type === 'athlete' ? 'an' : 'a'} ${facts.target_type}, which qualifies.`));
    else reasons.push(unmet('target_type', `This program funds ${list(rules.target_types)} only; this application is for ${facts.target_type === 'athlete' ? 'an' : 'a'} ${facts.target_type}.`));
  }
  if (rules.max_award_cents != null) {
    if (facts.requested_cents == null) { reasons.push(unknown('max_award', 'The amount requested has not been entered yet.')); missing.push({ kind: 'data', key: 'requested_cents', label: 'Amount requested' }); }
    else if (facts.requested_cents > rules.max_award_cents) reasons.push(unmet('max_award', `The request is above the program's maximum award of ${rules.max_award_cents / 100}.`));
    else reasons.push(met('max_award', 'The request is within the program maximum.'));
  }
  if (rules.verified_only) {
    if (facts.verified === true) reasons.push(met('verified_only', 'The applicant has a current verification badge.'));
    else { reasons.push(unmet('verified_only', 'This program only funds verified applicants, and no current verification badge was found.')); missing.push({ kind: 'data', key: 'verification', label: 'A current verification badge' }); }
  }
  if (rules.sports?.length) {
    if (facts.sports == null || facts.sports.length === 0) { reasons.push(unknown('sports', `This program funds ${list(rules.sports)}, and no sport is recorded for the applicant.`)); missing.push({ kind: 'data', key: 'sport', label: 'The sport you play or run' }); }
    else if (facts.sports.some((s) => rules.sports.includes(s))) reasons.push(met('sports', 'The applicant\'s sport is one the program funds.'));
    else reasons.push(unmet('sports', `This program funds ${list(rules.sports)} only.`));
  }
  if (rules.regions?.length && facts.regions !== undefined && facts.regions?.length !== 0) {
    if (facts.regions == null) { reasons.push(unknown('regions', `This program funds applicants in ${list(rules.regions)}, and no region is recorded.`)); missing.push({ kind: 'data', key: 'region', label: 'Your region' }); }
    else if (facts.regions.some((x) => rules.regions.map((r) => r.trim().toLowerCase()).includes(String(x).trim().toLowerCase()))) reasons.push(met('regions', 'The applicant is in a region the program funds.'));
    else reasons.push(unmet('regions', `This program funds applicants in ${list(rules.regions)} only.`));
  }
  for (const d of rules.required_documents ?? []) {
    if (facts.documents?.has(d.key)) reasons.push(met(`document:${d.key}`, `${d.label} was provided.`));
    else { reasons.push(unknown(`document:${d.key}`, `${d.label} has not been provided.`)); missing.push({ kind: 'document', key: d.key, label: d.label }); }
  }
  const outcome = reasons.some((r) => r.status === 'unmet') ? 'ineligible' : reasons.some((r) => r.status === 'unknown') ? 'needs_info' : 'eligible';
  return { outcome, reasons, missing };
}

/** Read the facts the platform already holds about the applicant's target. Unknown stays null. */
export async function gatherFacts(c, a) {
  const t = a.target_type;
  const verified = (await badgesFor(t === 'athlete' ? 'user' : t, [a.target_id])).get(a.target_id)?.length > 0;
  const sports = t === 'athlete'
    ? (await c.query('SELECT s.slug FROM active_sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=$1', [a.target_id])).rows.map((r) => r.slug)
    : (await c.query(`SELECT s.slug FROM ${t === 'team' ? 'teams' : 'events'} x JOIN sports s ON s.id=x.sport_id WHERE x.id=$1`, [a.target_id])).rows.map((r) => r.slug);
  let regions;
  if (t === 'athlete') regions = (await c.query('SELECT region AS v FROM active_sport_profiles WHERE user_id=$1 AND region IS NOT NULL', [a.target_id])).rows.map((r) => r.v);
  else if (t === 'team') regions = (await c.query('SELECT city AS v FROM teams WHERE id=$1 AND city IS NOT NULL', [a.target_id])).rows.map((r) => r.v);
  else regions = []; // events carry no region of their own: the region rule does not apply to them
  if (t !== 'event' && regions.length === 0) regions = null;
  const docs = (await c.query('SELECT DISTINCT field_key FROM sponsorship_application_files WHERE application_id=$1 AND removed_at IS NULL', [a.id])).rows.map((r) => r.field_key);
  return { target_type: t, requested_cents: a.requested_cents == null ? null : Number(a.requested_cents), verified, sports, regions, documents: new Set(docs) };
}

/** Possible duplicates: the same target in another live application to this program, and other applications by the same applicant in the same round. */
export async function duplicateFlags(c, a, rules) {
  if (rules.duplicate_check === false) return [];
  const flags = [];
  const same = (await c.query(
    `SELECT id, round_id, status FROM sponsorship_applications WHERE program_id=$1 AND target_type=$2 AND target_id=$3 AND id<>$4 AND status IN ('submitted','returned','awarded') ORDER BY created_at, id LIMIT 20`,
    [a.program_id, a.target_type, a.target_id, a.id])).rows;
  for (const s of same) flags.push({ kind: 'same_target', application_id: s.id, round_id: s.round_id, note: s.round_id === a.round_id ? 'The same applicant already has an application in this round.' : `The same ${a.target_type} applied to another round of this program (${s.status}).` });
  const sameWho = (await c.query(
    `SELECT id, round_id FROM sponsorship_applications WHERE round_id=$1 AND applicant_id=$2 AND id<>$3 AND (target_type<>$4 OR target_id<>$5) AND status IN ('submitted','returned','awarded') ORDER BY created_at, id LIMIT 20`,
    [a.round_id, a.applicant_id, a.id, a.target_type, a.target_id])).rows;
  for (const s of sameWho) flags.push({ kind: 'same_applicant', application_id: s.id, round_id: s.round_id, note: 'The same person applied for another target in this round.' });
  return flags;
}

/**
 * Screen an application (locked by the caller, inside its transaction) against the rules in force, store the run and point the
 * application at it. Append-only: earlier runs stay.
 */
export async function screenApplication(c, a, { trigger, userId = null, rulesVersion = null } = {}) {
  const v = rulesVersion
    ? (await c.query('SELECT * FROM sponsorship_eligibility_versions WHERE program_id=$1 AND version=$2', [a.program_id, rulesVersion])).rows[0]
    : await currentRules(c, a.program_id);
  const { outcome: base, reasons, missing } = evaluateEligibility(v.rules, await gatherFacts(c, a));
  const flags = await duplicateFlags(c, a, v.rules);
  const outcome = base === 'eligible' && flags.length ? 'review' : base; // a flag asks a human to look; it never rejects
  const row = (await c.query(
    `INSERT INTO sponsorship_screenings(application_id, program_id, rules_version, rules_sha256, outcome, reasons, missing, duplicate_flags, trigger, run_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [a.id, a.program_id, v.version, v.sha256, outcome, JSON.stringify(reasons), JSON.stringify(missing), JSON.stringify(flags), trigger, userId])).rows[0];
  await c.query('UPDATE sponsorship_applications SET screening_id=$2, screening_outcome=$3, screening_version=screening_version+1 WHERE id=$1', [a.id, row.id, outcome]);
  await c.query("INSERT INTO sponsorship_screening_events(application_id, kind, actor_id, data) VALUES ($1,'screened',$2,$3)", [a.id, userId, { screening_id: row.id, outcome, rules_version: v.version, trigger }]);
  return row;
}

/** The live (unrevoked, unexpired) exception for an application, or null. */
export async function liveException(c, applicationId) {
  return (await c.query('SELECT * FROM sponsorship_screening_exceptions WHERE application_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [applicationId])).rows[0] ?? null;
}

/** Called by the award handler: an award needs an eligible/review screening, or a live exception. Declining is never blocked. */
export async function gateScreening(c, a, decision) {
  if (decision !== 'award' || a.screening_outcome == null) return; // applications filed before screening existed keep working as they did
  if (['eligible', 'review'].includes(a.screening_outcome)) return;
  if (await liveException(c, a.id)) return;
  throw conflict(a.screening_outcome === 'needs_info'
    ? 'This application is missing information; ask the applicant for it, or record an authorised exception, before awarding'
    : 'This application does not meet the eligibility rules; record an authorised exception before awarding', { code: 'screening_blocks_award', outcome: a.screening_outcome });
}
