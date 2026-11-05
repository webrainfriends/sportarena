// Academy OS P1 / Gap 20 (#800): a tracked, human-approved promotion / squad transfer / graduation workflow for a #395 progression decision.
// It owns NO enrolment, team, certificate or fee logic. Every action is done by the canonical capability, called AS THE ACTING USER so its own
// permission, consent and capacity checks apply: transfer_academy_enrolment, invite_team_member, set_academy_enrolment_status, issue_credential
// (and transfer back / revoke_credential to undo). A run is only ever "completed" when every step really succeeded; a failure leaves it "partial"
// with the failed step and a retry, and every step first looks at the canonical record, so a retry or a crash can never double up a cohort move,
// invitation or certificate. One decision has at most one run (UNIQUE decision_id). Nothing is deleted: states, compensations and an append-only
// event log keep the history.
import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { invoke } from '../invoke.js';
import { tx, many, one, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF } from '../academy.js';
import { notify } from '../notify.js';
import { encrypt, decrypt } from '../crypto.js';
import { ageOf, guardiansOf, guardianLink, hasConsent, isYouth } from '../youth.js';

const canonical = (name) => { const x = capabilities.find((k) => k.name === name); if (!x) throw new Error(`capability ${name} is not registered`); return x; };
export const PROMOTION_DECISIONS = ['promote', 'move_programme', 'invite_squad', 'graduate'];
const OPEN = ['pending_approval', 'approved', 'in_progress', 'awaiting_acceptance', 'awaiting_final_approval', 'partial'];
const POST = ['graduate_status', 'certificate'];
const LIVE_ENROL = ['enrolled', 'paused'];

/** The steps a run needs, in order, from what was chosen. Squad acceptance is the athlete's / guardian's own answer to the canonical invitation. */
export function stepsFor(r) {
  const k = [];
  if (r.to_cohort_id) k.push('cohort_transfer');
  if (r.team_id) k.push('squad_invite', 'squad_acceptance');
  if (r.decision === 'graduate') k.push('graduate_status', 'certificate');
  return k;
}

const log = (c, runId, actor, event, detail = {}) => c.query('INSERT INTO academy_promotion_events(run_id, actor_id, event, detail) VALUES ($1,$2,$3,$4)', [runId, actor, event, JSON.stringify(detail)]);
const runFor = async (c, rid, lock = false) => { const r = (await c.query(`SELECT * FROM academy_promotion_runs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [rid])).rows[0]; if (!r) throw notFound('Promotion'); return r; };
const stepsOf = async (c, rid) => (await c.query('SELECT * FROM academy_promotion_steps WHERE run_id=$1 ORDER BY seq', [rid])).rows;
const recipientsOf = async (c, athleteId) => ((await isYouth(athleteId, c)) ? guardiansOf(athleteId, c) : [athleteId]);

/** The enrolment the run is about right now: the new one after a cohort move, otherwise the original. */
async function currentEnrolment(c, r) {
  if (r.to_cohort_id) {
    const e = (await c.query("SELECT * FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status IN ('enrolled','paused','graduated','completed')", [r.to_cohort_id, r.athlete_id])).rows[0];
    if (e) return e;
  }
  return r.enrolment_id ? (await c.query('SELECT * FROM org_enrolments WHERE id=$1', [r.enrolment_id])).rows[0] ?? null : null;
}

// ------------------------------------------------------------------ pre-flight: capacity, age, consent, eligibility and obligations, all read-only
export async function preflight(c, r) {
  // Each check carries an English `detail` (for the API and MCP) AND a stable `code` with `p` parameters, so the app shows it in the user's language.
  const out = [], add = (key, status, code, p, detail, data = {}) => out.push({ key, status, code, p: p ?? {}, detail, ...data });
  const d = (await c.query('SELECT criteria_snapshot FROM academy_progression_decisions WHERE id=$1', [r.decision_id])).rows[0];
  const outcome = d?.criteria_snapshot?.outcome ?? null;
  const word = { promote: 'promotion', move_programme: 'group move', invite_squad: 'squad invitation', graduate: 'graduation' }[r.decision] ?? r.decision;
  add('decision', 'pass', r.to_level ? 'decision.to' : 'decision.plain', { decision: r.decision, level: r.to_level }, `Recorded decision: ${word}${r.to_level ? ` to ${r.to_level}` : ''}`);
  if (['promote', 'graduate'].includes(r.decision)) add('criteria', outcome === 'criteria_met' ? 'pass' : 'warn', outcome === 'criteria_met' ? 'criteria.met' : 'criteria.unmet', {}, outcome === 'criteria_met' ? 'Pathway criteria were met at the time of the decision' : 'Pathway criteria were not all met (or evidence was missing) when this was decided');
  const enr = r.enrolment_id ? (await c.query('SELECT e.*, k.organisation_id, k.programme_id AS cohort_programme, k.name AS cohort_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [r.enrolment_id])).rows[0] : null;
  if (r.to_cohort_id || r.decision === 'graduate') {
    if (!enr || enr.organisation_id !== r.organisation_id || enr.user_id !== r.athlete_id) add('enrolment', 'fail', 'enrolment.not_theirs', {}, 'Choose the athlete\'s own enrolment in this academy');
    else if (r.decision === 'graduate' ? !['enrolled', 'paused', 'graduated', 'completed'].includes(enr.status) : !LIVE_ENROL.includes(enr.status) && r.status === 'pending_approval') add('enrolment', 'fail', 'enrolment.not_current', { status: enr.status }, `The enrolment is ${enr.status}; only a current enrolment can move`);
    else add('enrolment', 'pass', 'enrolment.ok', { group: enr.cohort_name }, `Current group: ${enr.cohort_name}`);
  }
  if (r.to_cohort_id) {
    const to = (await c.query('SELECT k.*, p.age_min, p.age_max, p.title AS programme FROM org_cohorts k LEFT JOIN academy_programmes p ON p.id=k.programme_id WHERE k.id=$1', [r.to_cohort_id])).rows[0];
    if (!to || to.organisation_id !== r.organisation_id || to.status !== 'active') add('destination', 'fail', 'destination.inactive', {}, 'The destination group must be an active group of this academy');
    else {
      const same = enr && to.programme_id === enr.programme_id;
      add('destination', same ? 'pass' : 'fail', same ? 'destination.ok' : 'destination.other_programme', { group: to.name }, same ? `Destination: ${to.name}` : 'A transfer stays within one programme; use the admissions flow for a different programme');
      const taken = (await c.query("SELECT count(*)::int AS n FROM org_enrolments WHERE cohort_id=$1 AND status IN ('enrolled','paused')", [to.id])).rows[0].n;
      const free = to.capacity == null ? null : to.capacity - taken;
      add('capacity', free == null || free > 0 ? 'pass' : 'fail', free == null ? 'capacity.unlimited' : free > 0 ? 'capacity.free' : 'capacity.full', { free, capacity: to.capacity }, free == null ? 'No seat limit on this group' : free > 0 ? `${free} of ${to.capacity} seats free` : 'That group is full', { seats_free: free, capacity: to.capacity });
      const u = (await c.query('SELECT dob_enc FROM users WHERE id=$1', [r.athlete_id])).rows[0];
      const age = u?.dob_enc ? ageOf(decrypt(u.dob_enc, 'users.dob')) : null;
      if (to.age_min == null && to.age_max == null) add('age', 'pass', 'age.no_band', {}, 'The programme has no age band');
      else if (age == null) add('age', 'warn', 'age.unknown', {}, 'No date of birth on file, so the age band could not be checked');
      else add('age', (to.age_min != null && age < to.age_min) || (to.age_max != null && age > to.age_max) ? 'fail' : 'pass', 'age.band', { age, min: to.age_min ?? '…', max: to.age_max ?? '…' }, `Age ${age} against the band ${to.age_min ?? '…'}–${to.age_max ?? '…'}`, { age });
    }
  }
  if (r.team_id) {
    const team = (await c.query('SELECT id, name FROM teams WHERE id=$1', [r.team_id])).rows[0];
    if (!team) add('squad', 'fail', 'squad.missing', {}, 'That team does not exist');
    else {
      const m = (await c.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [r.team_id, r.athlete_id])).rows[0];
      add('squad', m?.status === 'active' ? 'fail' : 'pass', m?.status === 'active' ? 'squad.already' : 'squad.ok', { team: team.name }, m?.status === 'active' ? `Already on ${team.name}` : `Squad: ${team.name}`);
    }
    const youth = await isYouth(r.athlete_id, c);
    const consent = await hasConsent(r.athlete_id, 'participation', c);
    add('consent', consent ? 'pass' : 'fail', consent ? (youth ? 'consent.guardian' : 'consent.ok') : 'consent.missing', {}, consent ? (youth ? 'Guardian participation consent is on file' : 'Participation consent is on file') : 'Participation consent is missing, so the canonical invitation would be refused');
    if (youth) { const g = await guardiansOf(r.athlete_id, c); add('guardian', g.length ? 'pass' : 'fail', g.length ? 'guardian.ok' : 'guardian.none', { n: g.length }, g.length ? `${g.length} verified guardian${g.length > 1 ? 's' : ''} will be notified` : 'A young athlete needs a verified guardian'); }
  }
  if (enr) {
    const ch = (await c.query("SELECT count(*)::int AS n, coalesce(sum(gross_minor - discount_minor - funded_minor),0)::bigint AS minor, max(currency) AS currency FROM academy_charges WHERE enrolment_id=$1 AND status='awaiting_payment'", [enr.id])).rows[0];
    add('obligations', 'pass', ch.n ? 'obligations.owed' : 'obligations.none', { n: ch.n }, ch.n ? `${ch.n} unpaid charge${ch.n > 1 ? 's' : ''} stay${ch.n > 1 ? '' : 's'} owed and follow the athlete to the new group` : 'No unpaid charges', { unpaid_charges: ch.n, unpaid_minor: Number(ch.minor), currency: ch.currency, private: true });
  }
  return out;
}
const blocking = (checks) => checks.filter((x) => x.status === 'fail');

// ------------------------------------------------------------------ status from steps (never "completed" unless everything really happened)
function settle(r, steps) {
  const st = (k) => steps.find((s) => s.kind === k)?.state;
  if (steps.some((s) => s.state === 'failed')) return 'partial';
  if (steps.some((s) => s.state === 'declined')) return 'rejected';
  const pre = steps.filter((s) => !POST.includes(s.kind)), post = steps.filter((s) => POST.includes(s.kind));
  const ok = (s) => ['done', 'skipped'].includes(s.state);
  if (pre.every(ok)) {
    if (!post.length || post.every(ok)) return 'completed';
    return r.final_approved_at ? 'in_progress' : 'awaiting_final_approval';
  }
  const pending = pre.filter((s) => !ok(s));
  return pending.every((s) => s.kind === 'squad_acceptance') ? 'awaiting_acceptance' : 'in_progress';
}

/** Read the canonical answer to the squad invitation. Accepting is the athlete's / guardian's own act in the team invitation; this only observes it. */
async function syncAcceptance(c, r, steps) {
  const acc = steps.find((s) => s.kind === 'squad_acceptance');
  if (!acc || ['done', 'declined', 'compensated'].includes(acc.state) || steps.find((s) => s.kind === 'squad_invite')?.state !== 'done') return;
  const m = (await c.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [r.team_id, r.athlete_id])).rows[0];
  if (m?.status === 'active') { await c.query("UPDATE academy_promotion_steps SET state='done', done_at=now() WHERE id=$1", [acc.id]); acc.state = 'done'; }
  else if (m?.status === 'left') { await c.query("UPDATE academy_promotion_steps SET state='declined', done_at=now() WHERE id=$1", [acc.id]); acc.state = 'declined'; }
}

/** Do one step's real work through the canonical capability, as the acting user. It runs on its own connection and looks at the canonical record first,
 *  so a retry, a crash between this and the bookkeeping, or two people pressing the button can never double a cohort move, invitation or certificate. */
async function doStep(user, r, s, pathwayTitle) {
  if (s.kind === 'cohort_transfer') {
    const have = (await pool.query("SELECT id FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status IN ('enrolled','paused')", [r.to_cohort_id, r.athlete_id])).rows[0];
    const out = have ?? await invoke(canonical('transfer_academy_enrolment'), user, { id: r.enrolment_id, to_cohort_id: r.to_cohort_id, reason: `Promotion ${r.from_level ?? ''}${r.to_level ? ` to ${r.to_level}` : ''}`.trim() });
    return { type: 'academy_enrolment', id: out.id };
  }
  if (s.kind === 'squad_invite') {
    const m = (await pool.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2 AND status IN ('invited','active')", [r.team_id, r.athlete_id])).rows[0];
    if (!m) await invoke(canonical('invite_team_member'), user, { id: r.team_id, user_id: r.athlete_id, role: r.team_role, message: 'Academy promotion' });
    return { type: 'team_invitation', id: r.team_id };
  }
  const e = await currentEnrolment(pool, r);
  if (!e) throw badRequest('The enrolment could not be found');
  if (s.kind === 'graduate_status') {
    if (e.status !== 'graduated') await invoke(canonical('set_academy_enrolment_status'), user, { id: e.id, status: 'graduated', reason: 'Graduated through the promotion workflow' });
    return { type: 'academy_enrolment', id: e.id };
  }
  const have = (await pool.query("SELECT id FROM credentials WHERE enrolment_id=$1 AND kind=$2 AND status='issued'", [e.id, r.cert_kind])).rows[0];
  const out = have ?? await invoke(canonical('issue_credential'), user, { id: r.organisation_id, enrolment_id: e.id, kind: r.cert_kind, title: r.cert_title ?? `${pathwayTitle ?? 'Academy pathway'} - graduate` });
  return { type: 'credential', id: out.id };
}

/** The next step that is due (in order, and the certificate only after the final approval), claimed so only one caller runs it. */
const claimNext = (rid) => tx(async (c) => {
  const r = await runFor(c, rid, true);
  const steps = await stepsOf(c, rid);
  const ok = (x) => ['done', 'skipped'].includes(x.state);
  for (const s of steps) {
    if (ok(s) || ['compensated', 'declined'].includes(s.state) || s.kind === 'squad_acceptance') continue;
    if (POST.includes(s.kind) && !r.final_approved_at) return null;
    if (steps.some((x) => x.seq < s.seq && !ok(x))) return null;
    if (s.kind === 'graduate_status' && steps.some((x) => x.kind === 'squad_acceptance' && x.state !== 'done')) return null;
    const got = (await c.query("UPDATE academy_promotion_steps SET state='running', attempts=attempts+1, claimed_at=now() WHERE id=$1 AND (state IN ('pending','failed') OR (state='running' AND claimed_at < now() - interval '2 minutes')) RETURNING *", [s.id])).rows[0];
    return got ? { r, s: got } : null;
  }
  return null;
});

/** Run every step that is due, in order, stopping at the first failure. No transaction is held while a canonical capability runs. */
async function advance(user, rid) {
  const pathwayTitle = (await pool.query('SELECT p.title FROM academy_promotion_runs r JOIN academy_pathways p ON p.id=r.pathway_id WHERE r.id=$1', [rid])).rows[0]?.title;
  for (let guard = 0; guard < 8; guard++) {
    const next = await claimNext(rid);
    if (!next) break;
    const { r, s } = next;
    try {
      const target = await doStep(user, r, s, pathwayTitle);
      await tx(async (c) => { await c.query("UPDATE academy_promotion_steps SET state='done', target_type=$2, target_id=$3, error=NULL, done_at=now() WHERE id=$1", [s.id, target.type, String(target.id)]); await log(c, rid, user.id, `step_${s.kind}_done`, { target }); });
    } catch (e) {
      const msg = String(e.message ?? e).slice(0, 300);
      await tx(async (c) => { await c.query("UPDATE academy_promotion_steps SET state='failed', error=$2 WHERE id=$1", [s.id, msg]); await log(c, rid, user.id, `step_${s.kind}_failed`, { error: msg }); });
      break;
    }
  }
  return tx(async (c) => {
    const r = await runFor(c, rid, true);
    let steps = await stepsOf(c, rid);
    await syncAcceptance(c, r, steps);
    steps = await stepsOf(c, rid);
    const status = ['rolled_back', 'cancelled', 'expired'].includes(r.status) ? r.status : settle(r, steps);
    const closed = ['completed', 'rejected'].includes(status);
    const row = (await c.query('UPDATE academy_promotion_runs SET status=$2, closed_at=CASE WHEN $3 THEN coalesce(closed_at, now()) ELSE closed_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [rid, status, closed])).rows[0];
    if (status !== r.status) {
      await log(c, rid, user.id, `status_${status}`, { from: r.status });
      for (const uid of await recipientsOf(c, r.athlete_id)) await notify(c, uid, { kind: 'academy_promotion', title: `Academy promotion: ${status.replace(/_/g, ' ')}`, body: status === 'awaiting_acceptance' ? 'You have a squad invitation to answer.' : '', data: { run_id: rid, organisation_id: r.organisation_id, status }, dedupe_key: `promo:${rid}:${status}:${uid}` });
      if (r.created_by !== user.id) await notify(c, r.created_by, { kind: 'academy_promotion', title: `Academy promotion: ${status.replace(/_/g, ' ')}`, body: '', data: { run_id: rid, organisation_id: r.organisation_id, status }, dedupe_key: `promo:${rid}:${status}:${r.created_by}` });
    }
    return { run: row, steps };
  });
}

// ------------------------------------------------------------------ role-safe views
const DONE = (s) => ['done', 'skipped'].includes(s.state);
/** staff: everything. coach: status and steps without the money line or the private note. athlete / guardian: only what happens to them and what they must answer. */
function view(r, steps, role, events) {
  const base = { id: r.id, decision: r.decision, from_level: r.from_level, to_level: r.to_level, status: r.status, expires_at: r.expires_at, created_at: r.created_at, closed_at: r.closed_at };
  const stepRows = steps.map((s) => ({ kind: s.kind, state: s.state, done_at: s.done_at, ...(role === 'self' ? {} : { error: s.error, attempts: s.attempts, target_type: s.target_type, target_id: s.target_id }) }));
  if (role === 'self') return { ...base, organisation_id: r.organisation_id, steps: stepRows, needs_my_answer: steps.some((s) => s.kind === 'squad_acceptance' && s.state === 'pending') && steps.some((s) => s.kind === 'squad_invite' && DONE(s)) ? { type: 'team_invitation', team_id: r.team_id } : null };
  const out = { ...base, organisation_id: r.organisation_id, athlete_id: r.athlete_id, athlete_name: r.athlete_name, pathway_id: r.pathway_id, decision_id: r.decision_id, enrolment_id: r.enrolment_id, from_cohort_id: r.from_cohort_id, to_cohort_id: r.to_cohort_id, from_cohort: r.from_cohort, to_cohort: r.to_cohort, team_id: r.team_id, team_name: r.team_name, team_role: r.team_role, cert_kind: r.cert_kind, row_version: r.row_version, approved_at: r.approved_at, final_approved_at: r.final_approved_at, steps: stepRows, progress: { done: steps.filter(DONE).length, total: steps.length } };
  out.checks = role === 'staff' ? r.checks : r.checks.map(({ private: p, unpaid_charges, unpaid_minor, currency, ...k }) => (p ? null : k)).filter(Boolean);
  if (role === 'staff') out.note = r.note_enc ? decrypt(r.note_enc, 'academy_promotion_runs.note') : null;
  if (events) out.events = events;
  return out;
}
const SELECT = `SELECT r.*, a.display_name AS athlete_name, fk.name AS from_cohort, tk.name AS to_cohort, t.name AS team_name
  FROM academy_promotion_runs r JOIN users a ON a.id=r.athlete_id LEFT JOIN org_cohorts fk ON fk.id=r.from_cohort_id LEFT JOIN org_cohorts tk ON tk.id=r.to_cohort_id LEFT JOIN teams t ON t.id=r.team_id`;

/** Staff may see every run of the academy; a coach only the runs of athletes in their own groups. */
async function access(user, orgId, c) {
  const { role } = await orgFor(user, orgId, [...STAFF, 'coach'], { c });
  return STAFF.includes(role) ? 'staff' : 'coach';
}
const coachSees = (user, r, c) => c.query("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=$1 AND k.organisation_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused','graduated','completed') LIMIT 1", [r.athlete_id, r.organisation_id, user.id]);

cap({
  name: 'plan_academy_promotion', method: 'POST', path: '/academy/decisions/:id/promotion', tag: 'Academy', status: 201,
  summary: 'Turn a recorded promote / move_programme / invite_squad / graduate decision into a tracked promotion run (owner/admin). Nothing moves yet: it runs the pre-flight (capacity, age band, guardian consent, existing squad place, unpaid obligations), shows what will happen and waits for a human approval. One decision has one run; repeating returns it.',
  input: z.object({
    id, enrolment_id: id.optional().describe('the athlete\'s current academy enrolment (needed to move cohort or graduate)'), to_cohort_id: id.optional().describe('destination group of the same programme'),
    team_id: id.optional().describe('squad to invite the athlete to'), team_role: z.enum(['player', 'captain']).default('player'),
    cert_kind: z.enum(['certificate', 'badge', 'diploma']).default('certificate'), cert_title: z.string().trim().min(2).max(120).optional(),
    expires_in_days: z.number().int().min(1).max(60).default(14), note: z.string().trim().max(500).optional(), idempotency_key: z.string().min(8).max(80).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM academy_progression_decisions WHERE id=$1', [i.id])).rows[0];
    if (!d) throw notFound('Decision');
    await orgFor(user, d.organisation_id, STAFF, { write: true, c });
    if (!PROMOTION_DECISIONS.includes(d.decision)) throw conflict(`A "${d.decision}" decision has nothing to carry through`);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`promotion:${d.id}`]);
    const prior = (await c.query('SELECT * FROM academy_promotion_runs WHERE decision_id=$1', [d.id])).rows[0];
    if (prior) return { ...view({ ...prior, checks: prior.checks }, await stepsOf(c, prior.id), 'staff'), replayed: true };
    if (d.decision === 'move_programme' && !i.to_cohort_id) throw badRequest('Choose the group to move to');
    if (d.decision === 'invite_squad' && !i.team_id) throw badRequest('Choose the squad');
    if (d.decision === 'graduate' && !i.enrolment_id) throw badRequest('Choose the enrolment that graduates');
    if (d.decision === 'promote' && !i.to_cohort_id && !i.team_id) throw badRequest('A promotion needs a destination group and/or a squad');
    if (d.decision === 'move_programme' && i.team_id) throw badRequest('A programme move does not invite to a squad; record an invite_squad decision for that');
    if (d.decision === 'invite_squad' && i.to_cohort_id) throw badRequest('A squad invitation does not move group; record a move decision for that');
    const enr = i.enrolment_id ? (await c.query('SELECT e.*, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [i.enrolment_id])).rows[0] : null;
    if (i.enrolment_id && (!enr || enr.organisation_id !== d.organisation_id || enr.user_id !== d.athlete_id)) throw badRequest('That enrolment is not this athlete\'s enrolment in this academy');
    const draft = { organisation_id: d.organisation_id, decision_id: d.id, athlete_id: d.athlete_id, decision: d.decision, from_level: d.from_level, to_level: d.to_level, enrolment_id: i.enrolment_id ?? null, to_cohort_id: i.to_cohort_id ?? null, team_id: i.team_id ?? null, status: 'pending_approval' };
    const checks = await preflight(c, draft);
    const row = (await c.query(
      `INSERT INTO academy_promotion_runs(organisation_id, decision_id, athlete_id, pathway_id, decision, from_level, to_level, enrolment_id, from_cohort_id, to_cohort_id, team_id, team_role, cert_kind, cert_title, checks, note_enc, expires_at, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() + make_interval(days => $17), $18, $19) RETURNING *`,
      [d.organisation_id, d.id, d.athlete_id, d.pathway_id, d.decision, d.from_level, d.to_level, i.enrolment_id ?? null, enr?.cohort_id ?? null, i.to_cohort_id ?? null, i.team_id ?? null, i.team_role, i.cert_kind, i.cert_title ?? null, JSON.stringify(checks), i.note ? encrypt(i.note, 'academy_promotion_runs.note') : null, i.expires_in_days, i.idempotency_key ?? null, user.id])).rows[0];
    const kinds = stepsFor(row);
    for (const [n, kind] of kinds.entries()) await c.query('INSERT INTO academy_promotion_steps(run_id, seq, kind) VALUES ($1,$2,$3)', [row.id, n + 1, kind]);
    await log(c, row.id, user.id, 'planned', { steps: kinds, blocking: blocking(checks).map((x) => x.key) });
    await audit(c, user.id, 'plan_academy_promotion', 'academy_promotion_runs', row.id);
    return view({ ...row, athlete_name: undefined }, await stepsOf(c, row.id), 'staff');
  }),
});

cap({
  name: 'approve_academy_promotion', method: 'POST', path: '/academy/promotions/:id/approve', tag: 'Academy',
  summary: 'Human approval (owner/admin). stage "plan" re-runs the pre-flight and, if nothing blocks, performs the cohort move and squad invitation through the canonical capabilities. For a graduation the certificate is only issued after a second, "final" approval once every earlier step is done. Failures leave the run "partial" with a retry; success is never claimed early.',
  input: z.object({ id, stage: z.enum(['plan', 'final']).default('plan'), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    await tx(async (c) => {
    const r = await runFor(c, i.id, true);
    await orgFor(user, r.organisation_id, STAFF, { write: true, c });
    if (r.row_version !== i.row_version) throw conflict('This promotion changed since you opened it. Reload and review it again.', { code: 'stale_version' });
    if (r.expires_at <= new Date() && ['pending_approval', 'approved', 'awaiting_acceptance', 'awaiting_final_approval'].includes(r.status)) throw conflict('This promotion has expired. Plan it again from the decision after an owner reopens it.', { code: 'expired' });
    if (i.stage === 'plan') {
      if (r.status !== 'pending_approval') throw conflict(`This promotion is ${r.status.replace(/_/g, ' ')}, not waiting for approval`);
      const checks = await preflight(c, r);
      await c.query('UPDATE academy_promotion_runs SET checks=$2 WHERE id=$1', [r.id, JSON.stringify(checks)]);
      const bad = blocking(checks);
      if (bad.length) throw conflict(`Cannot approve: ${bad.map((x) => x.detail).join('; ')}`, { code: 'preflight_failed', checks: bad });
      await c.query("UPDATE academy_promotion_runs SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [r.id, user.id]);
      await log(c, r.id, user.id, 'approved', {});
    } else {
      if (r.decision !== 'graduate') throw badRequest('Only a graduation has a final approval');
      if (r.status !== 'awaiting_final_approval') throw conflict('Final approval is only possible once every earlier step is complete');
      if (r.approved_by === user.id && (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role='owner' AND status='active'", [r.organisation_id, user.id])).rows.length === 0) throw conflict('The final approval must come from the academy owner');
      await c.query('UPDATE academy_promotion_runs SET final_approved_by=$2, final_approved_at=now() WHERE id=$1', [r.id, user.id]);
      await log(c, r.id, user.id, 'final_approved', {});
    }
    await audit(c, user.id, `approve_academy_promotion_${i.stage}`, 'academy_promotion_runs', r.id);
    });
    const out = await advance(user, i.id);
    return view({ ...out.run, checks: out.run.checks }, out.steps, 'staff');
  },
});

cap({
  name: 'advance_academy_promotion', method: 'POST', path: '/academy/promotions/:id/advance', tag: 'Academy',
  summary: 'Retry or reconcile an approved promotion (owner/admin): re-reads the canonical records, skips what already happened, retries a failed step and picks up the athlete\'s or guardian\'s answer to the squad invitation. Safe to call repeatedly.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await tx(async (c) => { const x = await runFor(c, i.id); await orgFor(user, x.organisation_id, STAFF, { write: true, c }); return x; });
    if (!['approved', 'in_progress', 'awaiting_acceptance', 'awaiting_final_approval', 'partial'].includes(r.status)) throw conflict(`This promotion is ${r.status.replace(/_/g, ' ')}`);
    const out = await advance(user, r.id);
    await tx((c) => audit(c, user.id, 'advance_academy_promotion', 'academy_promotion_runs', r.id));
    return view({ ...out.run, checks: out.run.checks }, out.steps, 'staff');
  },
});

cap({
  name: 'rollback_academy_promotion', method: 'POST', path: '/academy/promotions/:id/rollback', tag: 'Academy',
  summary: 'Undo a promotion that is not wanted (owner/admin) by compensating the steps already done through the canonical capabilities, newest first: revoke the certificate, withdraw the squad invitation, move the athlete back to the original group. Nothing is deleted and the history is kept. A graduation that has changed the enrolment to graduated cannot be reversed here.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500) }),
  async handler({ user }, i) {
    const { r, steps } = await tx(async (c) => { const x = await runFor(c, i.id); await orgFor(user, x.organisation_id, STAFF, { write: true, c }); return { r: x, steps: await stepsOf(c, i.id) }; });
    if (['rolled_back', 'cancelled'].includes(r.status)) return view(r, steps, 'staff');
    if (steps.some((s) => s.kind === 'graduate_status' && s.state === 'done')) throw conflict('The enrolment has been graduated; that cannot be reversed here. Revoke the certificate if it was issued in error and contact the platform owner.', { code: 'graduation_final' });
    const failures = [];
    for (const s of [...steps].reverse()) {
      if (s.state !== 'done') continue;
      try {
        if (s.kind === 'cohort_transfer') {
          const e = (await pool.query("SELECT id FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status IN ('enrolled','paused')", [r.to_cohort_id, r.athlete_id])).rows[0];
          if (e) await invoke(canonical('transfer_academy_enrolment'), user, { id: e.id, to_cohort_id: r.from_cohort_id, reason: `Promotion rolled back: ${i.reason}` });
        } else if (s.kind === 'squad_invite') {
          await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2 AND status IN ('invited','active')", [r.team_id, r.athlete_id]);
        } else if (s.kind === 'certificate' && s.target_id) {
          if ((await pool.query("SELECT 1 FROM credentials WHERE id=$1 AND status='issued'", [s.target_id])).rows.length) await invoke(canonical('revoke_credential'), user, { id: s.target_id, reason: `Promotion rolled back: ${i.reason}` });
        } else continue;
        await tx(async (c) => { await c.query("UPDATE academy_promotion_steps SET state='compensated', compensated_at=now() WHERE id=$1", [s.id]); await log(c, r.id, user.id, `step_${s.kind}_compensated`, {}); });
      } catch (e) { failures.push(`${s.kind}: ${e.message}`); await tx((c) => log(c, r.id, user.id, `step_${s.kind}_compensation_failed`, { error: String(e.message).slice(0, 300) })); }
    }
    const done = await tx(async (c) => {
      if (failures.length) { await c.query("UPDATE academy_promotion_runs SET status='partial', row_version=row_version+1, updated_at=now() WHERE id=$1", [r.id]); }
      else {
        await c.query("UPDATE academy_promotion_steps SET state='skipped' WHERE run_id=$1 AND state IN ('pending','failed','running')", [r.id]);
        await c.query("UPDATE academy_promotion_steps SET state='compensated' WHERE run_id=$1 AND kind='squad_acceptance' AND state IN ('done','declined')", [r.id]);
        await c.query("UPDATE academy_promotion_runs SET status='rolled_back', closed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [r.id]);
        await log(c, r.id, user.id, 'rolled_back', { reason: i.reason });
        for (const uid of await recipientsOf(c, r.athlete_id)) await notify(c, uid, { kind: 'academy_promotion', title: 'Academy promotion was reversed', body: '', data: { run_id: r.id, organisation_id: r.organisation_id, status: 'rolled_back' }, dedupe_key: `promo:${r.id}:rolled_back:${uid}` });
        await audit(c, user.id, 'rollback_academy_promotion', 'academy_promotion_runs', r.id);
      }
      return view((await runFor(c, r.id)), await stepsOf(c, r.id), 'staff');
    });
    if (failures.length) throw conflict(`Rollback is incomplete and can be retried: ${failures.join('; ')}`, { code: 'rollback_incomplete' });
    return done;
  },
});

cap({
  name: 'cancel_academy_promotion', method: 'POST', path: '/academy/promotions/:id/cancel', tag: 'Academy',
  summary: 'Stop a promotion that has not started moving anything (owner/admin): a plan waiting for approval. Once a step has run, use rollback so it is undone through the canonical capabilities.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = await runFor(c, i.id, true);
    await orgFor(user, r.organisation_id, STAFF, { write: true, c });
    if (r.status === 'cancelled') return view(r, await stepsOf(c, r.id), 'staff');
    const steps = await stepsOf(c, r.id);
    if (r.status !== 'pending_approval' || steps.some((s) => s.state !== 'pending')) throw conflict('Steps have already run; roll the promotion back instead', { code: 'use_rollback' });
    const row = (await c.query("UPDATE academy_promotion_runs SET status='cancelled', closed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
    await c.query("UPDATE academy_promotion_steps SET state='skipped' WHERE run_id=$1", [r.id]);
    await log(c, r.id, user.id, 'cancelled', { reason: i.reason });
    await audit(c, user.id, 'cancel_academy_promotion', 'academy_promotion_runs', r.id);
    return view(row, await stepsOf(c, r.id), 'staff');
  }),
});

cap({
  name: 'list_academy_promotions', method: 'GET', path: '/organisations/:id/academy/promotions', tag: 'Academy',
  summary: 'Promotion runs of this academy with a status summary (owner/admin: everything; a coach: runs of athletes in their own groups, without the money line or private note).',
  input: z.object({ id, status: z.enum(['open', 'completed', 'closed']).optional(), athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const role = await access(user, i.id, undefined);
    const f = i.status === 'open' ? OPEN : i.status === 'completed' ? ['completed'] : i.status === 'closed' ? ['rejected', 'expired', 'cancelled', 'rolled_back'] : null;
    const rows = await many(`${SELECT} WHERE r.organisation_id=$1 AND ($2::text[] IS NULL OR r.status = ANY($2)) AND ($3::uuid IS NULL OR r.athlete_id=$3) ORDER BY r.created_at DESC, r.id LIMIT $4 OFFSET $5`, [i.id, f, i.athlete_id ?? null, i.limit, i.offset]);
    const counts = await many(`SELECT r.status, count(*)::int AS n FROM academy_promotion_runs r WHERE r.organisation_id=$1
      AND ($2 OR EXISTS (SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=r.athlete_id AND k.organisation_id=r.organisation_id AND k.coach_id=$3 AND e.status IN ('enrolled','paused','graduated','completed'))) GROUP BY r.status`, [i.id, role === 'staff', user.id]);
    const out = [];
    for (const r of rows) {
      if (role === 'coach' && !(await one("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=$1 AND k.organisation_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused','graduated','completed') LIMIT 1", [r.athlete_id, r.organisation_id, user.id]))) continue;
      out.push(view(r, await many('SELECT * FROM academy_promotion_steps WHERE run_id=$1 ORDER BY seq', [r.id]), role));
    }
    return { items: out, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])), role };
  },
});

cap({
  name: 'get_academy_promotion', method: 'GET', path: '/academy/promotions/:id', tag: 'Academy',
  summary: 'One promotion run with its pre-flight checks, steps and the full audit history (owner/admin; a coach for their own athlete, without the money line or private note).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = (await many(`${SELECT} WHERE r.id=$1`, [i.id]))[0];
    if (!r) throw notFound('Promotion');
    const role = await access(user, r.organisation_id, undefined);
    if (role === 'coach' && !(await one("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=$1 AND k.organisation_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused','graduated','completed') LIMIT 1", [r.athlete_id, r.organisation_id, user.id]))) throw notFound('Promotion');
    const events = await many('SELECT e.event, e.detail, e.created_at, u.display_name AS actor FROM academy_promotion_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.run_id=$1 ORDER BY e.created_at, e.id', [r.id]);
    return view(r, await many('SELECT * FROM academy_promotion_steps WHERE run_id=$1 ORDER BY seq', [r.id]), role, events);
  },
});

cap({
  name: 'get_my_academy_promotions', method: 'GET', path: '/me/academy/promotions', tag: 'Academy',
  summary: 'The athlete\'s own promotions (or their child\'s, for a verified guardian): what is happening, what is done and what they must answer. No fees, checks or staff notes.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.athlete_id && i.athlete_id !== user.id && !(await guardianLink(user.id, i.athlete_id))) throw notFound('Athlete');
    const ids = i.athlete_id ? [i.athlete_id] : [user.id, ...(await many("SELECT l.child_id FROM guardian_links l JOIN users u ON u.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND (u.youth_until IS NOT NULL AND u.youth_until > current_date)", [user.id])).map((x) => x.child_id)];
    const rows = await many(`${SELECT} WHERE r.athlete_id = ANY($1) AND r.status NOT IN ('pending_approval','cancelled') ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [ids, i.limit, i.offset]);
    return Promise.all(rows.map(async (r) => ({ ...view(r, await many('SELECT * FROM academy_promotion_steps WHERE run_id=$1 ORDER BY seq', [r.id]), 'self'), athlete_name: r.athlete_name })));
  },
});
