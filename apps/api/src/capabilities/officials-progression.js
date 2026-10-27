// Officials Development & Assessment (#486) 3/4: grade requirements, demotion, fitness/competency results and CPD. Grades and licences live in the federation
// OS: promotion and renewal go through its existing licence application and decision (which now also runs the requirements saved here), so nothing is
// copied and a raw score never promotes anyone. Demotion is its own explicit, reasoned decision with an effective date.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { bodyById, mustBeActive, nextNumber, logFed, today, addMonths, plain, LIC_STATUS } from '../federation.js';
import { subjectFor, needStaff } from '../federation-subjects.js';
import { devStaff, logOff, sealText, unsealText, CTX, holdsLicenceUnder, liveRequirement, fitnessStanding, cpdHours, developmentChecks } from '../officials-development.js';

const TAG = 'Officials development';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const num = (max) => z.number().min(0).max(max);

// ------------------------------------------------------------------ grade requirements
const REQ_COLS = `r.id, r.body_id, r.licence_type_id, t.name AS licence_type_name, t.grade, t.grade_rank, s.name AS sport_name, t.sport_id, r.version, r.prerequisite_type_id, pt.name AS prerequisite_name, r.min_months_at_prerequisite,
  r.min_assessments, r.min_favourable, r.require_promotion_assessment, r.assessment_window_months, r.cpd_hours::float AS cpd_hours, r.cpd_window_months, r.fitness_test_type_id, ft.name AS fitness_test_name, r.created_at`;
const REQ_FROM = 'off_grade_requirements r JOIN fed_licence_types t ON t.id=r.licence_type_id JOIN sports s ON s.id=t.sport_id LEFT JOIN fed_licence_types pt ON pt.id=r.prerequisite_type_id LEFT JOIN off_fitness_test_types ft ON ft.id=r.fitness_test_type_id';

cap({
  name: 'save_grade_requirement', method: 'POST', path: '/officials-development/bodies/:id/requirements', tag: TAG, status: 201,
  summary: 'Set what a licence grade asks of an official beyond the licence\'s own checks (licensing officer/admin): the grade held before it and for how long, how many formal assessments (and how many supportive ones, and whether one must be for promotion) in a window, verified CPD hours in a window, and a current fitness/competency test. The existing licence approval then checks these live for promotion, first issue and renewal; nothing is copied onto the licence. Saving again supersedes the previous version, which is kept.',
  input: z.object({ id, licence_type_id: id, prerequisite_type_id: id.nullish(), min_months_at_prerequisite: z.number().int().min(0).max(240).default(0), min_assessments: z.number().int().min(0).max(100).default(0), min_favourable: z.number().int().min(0).max(100).default(0),
    require_promotion_assessment: z.boolean().default(false), assessment_window_months: z.number().int().min(1).max(120).default(12), cpd_hours: num(5000).default(0), cpd_window_months: z.number().int().min(1).max(120).default(12), fitness_test_type_id: id.nullish() })
    .refine((r) => r.min_favourable <= r.min_assessments, 'Supportive assessments cannot exceed the number required'),
  handler: ({ user }, i) => tx(async (c) => {
    const t = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.licence_type_id, i.id])).rows[0];
    if (!t) throw notFound('Licence type');
    await devStaff(user, i.id, { c, sportId: t.sport_id });
    if (t.holder_role !== 'official') throw badRequest('Requirements apply to official licences');
    if (i.prerequisite_type_id) {
      const p = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1 AND body_id=$2', [i.prerequisite_type_id, i.id])).rows[0];
      if (!p || p.sport_id !== t.sport_id || p.holder_role !== 'official') throw badRequest('The prerequisite must be an official licence of this body and sport');
      if (p.grade_rank >= t.grade_rank) throw badRequest('The prerequisite grade must be lower than the grade it leads to');
    }
    if (i.fitness_test_type_id && !(await c.query('SELECT 1 FROM off_fitness_test_types WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.fitness_test_type_id, i.id])).rowCount) throw badRequest('That fitness test is not one of this body\'s');
    const prev = (await c.query('SELECT id, version FROM off_grade_requirements WHERE licence_type_id=$1 AND superseded_at IS NULL FOR UPDATE', [i.licence_type_id])).rows[0];
    if (prev) await c.query('UPDATE off_grade_requirements SET superseded_at=now() WHERE id=$1', [prev.id]);
    const r = (await c.query(`INSERT INTO off_grade_requirements(body_id, licence_type_id, version, prerequisite_type_id, min_months_at_prerequisite, min_assessments, min_favourable, require_promotion_assessment, assessment_window_months, cpd_hours, cpd_window_months, fitness_test_type_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [i.id, i.licence_type_id, (prev?.version ?? 0) + 1, i.prerequisite_type_id ?? null, i.min_months_at_prerequisite, i.min_assessments, i.min_favourable, i.require_promotion_assessment, i.assessment_window_months, i.cpd_hours, i.cpd_window_months, i.fitness_test_type_id ?? null, user.id])).rows[0];
    await logOff(c, i.id, 'requirement', r.id, prev ? 'superseded_previous' : 'created', { actor: user.id, detail: { licence_type_id: i.licence_type_id, supersedes: prev?.id ?? null } });
    return (await c.query(`SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.id=$1`, [r.id])).rows[0];
  }),
});

cap({
  name: 'list_grade_requirements', method: 'GET', path: '/officials-development/bodies/:id/requirements', tag: TAG, auth: 'public',
  summary: 'What each official grade of a body asks of an official, so the path is transparent. Public; `include_superseded` also returns earlier versions.',
  input: z.object({ id, sport_id: id.optional(), include_superseded: z.coerce.boolean().default(false) }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    return many(`SELECT ${REQ_COLS}, r.superseded_at FROM ${REQ_FROM} WHERE r.body_id=$1 AND ($2::uuid IS NULL OR t.sport_id=$2) AND ($3 OR r.superseded_at IS NULL) ORDER BY s.name, t.grade_rank, r.version DESC`, [i.id, i.sport_id ?? null, i.include_superseded]);
  },
});

// ------------------------------------------------------------------ demotion (explicit, reasoned, dated)
cap({
  name: 'demote_official', method: 'POST', path: '/officials-development/licences/:id/demotion', tag: TAG,
  summary: 'Demote an official (licensing officer/admin): ends the higher-grade licence with a written reason and an effective date up to 60 days back, and, if `new_type_id` is given, issues the lower-grade licence in the same step. It is an explicit human decision recorded in the licence history; an assessment or score never triggers it. Promotion and renewal use the normal licence application and decision.',
  input: z.object({ id, reason: text(500).min(10), effective_on: day.optional(), new_type_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    needStaff(s, 'licences');
    const l = s.row;
    const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1', [l.type_id])).rows[0];
    if (type.holder_role !== 'official') throw badRequest('Only an official licence can be demoted here');
    const st = (await c.query(`SELECT (${LIC_STATUS('l')}) AS st FROM fed_licences l WHERE l.id=$1`, [l.id])).rows[0].st;
    if (!['active', 'suspended'].includes(st)) throw conflict(`This licence is ${st}`);
    const eff = i.effective_on ?? today();
    const earliest = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    if (eff > today()) throw badRequest('The effective date cannot be in the future');
    if (eff < earliest) throw badRequest('The effective date is more than 60 days back');
    let lower = null;
    if (i.new_type_id) {
      lower = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.new_type_id, l.body_id])).rows[0];
      if (!lower || lower.holder_role !== 'official' || lower.sport_id !== type.sport_id) throw badRequest('Pick a lower official grade of this body and sport');
      if (lower.grade_rank >= type.grade_rank) throw badRequest('The new grade must be lower than the current one');
      if ((await c.query("SELECT 1 FROM fed_licences WHERE body_id=$1 AND type_id=$2 AND holder_id=$3 AND (status IN ('draft','submitted','under_review','needs_info') OR (status IN ('active','suspended') AND expires_on >= current_date)) LIMIT 1", [l.body_id, lower.id, l.holder_id])).rowCount) throw conflict('That person already has an open or current licence at that grade');
    }
    await c.query("UPDATE fed_licences SET status='revoked', decision_reason=$2, decided_by=$3, decided_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [l.id, i.reason, user.id]);
    await logFed(c, l.body_id, 'licence', l.id, 'demoted', { from: st, to: 'revoked', actor: user.id, reason: i.reason, detail: { effective_on: eff, to_type_id: lower?.id ?? null, to_grade: lower?.grade ?? null } });
    let nl = null;
    if (lower) {
      const expires = String(l.expires_on).slice(0, 10) >= today() ? String(l.expires_on).slice(0, 10) : addMonths(eff, lower.duration_months);
      nl = (await c.query(`INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, grade, issued_on, expires_on, decided_by, decided_at, decision_reason, note, submitted_at)
        VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,now(),$11,$12,now()) RETURNING id, licence_no`,
        [l.body_id, lower.id, l.holder_id, user.id, await nextNumber(c, l.body_id, 'licence', eff.slice(0, 4)), randomBytes(6).toString('hex').toUpperCase(), lower.grade, eff, expires, user.id, i.reason, `Regraded from ${type.grade || type.name}`])).rows[0];
      await logFed(c, l.body_id, 'licence', nl.id, 'approve', { to: 'active', actor: user.id, reason: i.reason, detail: { regraded_from: l.id, licence_no: nl.licence_no, issued_on: eff, expires_on: expires } });
    }
    await notify(c, l.holder_id, { kind: 'official_demoted', title: 'Your official grade changed', body: i.reason.slice(0, 200), data: { licence_id: l.id, new_licence_id: nl?.id ?? null }, dedupe_key: `off-demote:${l.id}` });
    await audit(c, user.id, 'official_demoted', 'fed_licences', l.id);
    return { demoted_licence_id: l.id, effective_on: eff, new_licence_id: nl?.id ?? null, new_licence_no: nl?.licence_no ?? null };
  }),
});

cap({
  name: 'check_my_progression', method: 'GET', path: '/officials-development/licences/:id/readiness', tag: TAG,
  summary: 'Where a licence stands against the development requirements of its grade (for renewal) or of a higher grade you are considering: each check passes or fails with the numbers behind it. The holder, or the body\'s licensing staff. This only reports; applying and deciding happen in the licence application.',
  input: z.object({ id, type_id: id.optional().describe('check readiness for this other grade of the same body instead') }),
  async handler({ user }, i) {
    const s = await subjectFor(user, 'licence', i.id);
    if (!s.party && !s.auth) throw notFound('Licence');
    const type = (await pool.query('SELECT * FROM fed_licence_types WHERE id=$1 AND body_id=$2', [i.type_id ?? s.row.type_id, s.row.body_id])).rows[0];
    if (!type) throw notFound('Licence type');
    const req = await liveRequirement(pool, type.id);
    const asLicence = i.type_id ? { holder_id: s.row.holder_id, body_id: s.row.body_id, previous_id: null } : { holder_id: s.row.holder_id, body_id: s.row.body_id, previous_id: s.row.previous_id ?? s.row.id };
    const checks = await developmentChecks(pool, asLicence, type, { issuedOn: today() });
    return { licence_type_id: type.id, licence_type_name: type.name, grade: type.grade, has_requirements: !!req, ready: checks.every((x) => x.status === 'pass'), checks };
  },
});

// ------------------------------------------------------------------ fitness / competency
cap({
  name: 'save_fitness_test_type', method: 'POST', path: '/officials-development/bodies/:id/fitness-tests', tag: TAG, status: 201,
  summary: 'Define a fitness or competency test the body requires of officials (licensing officer/admin): its name and version, how long a result stays valid, and whether it is a plain pass/fail or a measured value with a pass threshold. Pass `test_id` to retire or revise. Only an operational result is ever stored, never clinical data.',
  input: z.object({ id, test_id: id.optional(), sport_id: id.nullish(), name: text(80).min(2), version: text(20).min(1).default('1'), result_kind: z.enum(['pass_fail', 'measured']).default('pass_fail'), unit: text(20).optional(),
    pass_direction: z.enum(['at_least', 'at_most']).optional(), pass_threshold: z.number().min(0).max(100000).optional(), validity_months: z.number().int().min(1).max(60).default(12), archived: z.boolean().optional() })
    .refine((t) => t.result_kind === 'pass_fail' || (t.unit && t.pass_direction && t.pass_threshold != null), 'A measured test needs a unit, a direction and a pass threshold'),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c, sportId: i.sport_id ?? null });
    const v = [i.sport_id ?? null, i.name, i.version, i.result_kind, i.result_kind === 'measured' ? i.unit : null, i.result_kind === 'measured' ? i.pass_direction : null, i.result_kind === 'measured' ? i.pass_threshold : null, i.validity_months];
    let r;
    try {
      if (i.test_id) {
        r = (await c.query('UPDATE off_fitness_test_types SET sport_id=$3, name=$4, version=$5, result_kind=$6, unit=$7, pass_direction=$8, pass_threshold=$9, validity_months=$10, archived_at=CASE WHEN $11::boolean THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 AND body_id=$2 RETURNING *', [i.test_id, i.id, ...v, !!i.archived])).rows[0];
        if (!r) throw notFound('Fitness test');
      } else r = (await c.query('INSERT INTO off_fitness_test_types(body_id, sport_id, name, version, result_kind, unit, pass_direction, pass_threshold, validity_months, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [i.id, ...v, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already a test with that name and version'); throw e; }
    await logOff(c, i.id, 'fitness', r.id, i.test_id ? 'test_updated' : 'test_created', { actor: user.id });
    return r;
  }),
});

cap({
  name: 'list_fitness_tests', method: 'GET', path: '/officials-development/bodies/:id/fitness-tests', tag: TAG, auth: 'public',
  summary: 'The fitness and competency tests a body requires of officials, with validity and pass rule. Public.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    return many('SELECT t.*, s.name AS sport_name FROM off_fitness_test_types t LEFT JOIN sports s ON s.id=t.sport_id WHERE t.body_id=$1 AND ($2 OR t.archived_at IS NULL) ORDER BY t.name, t.version', [i.id, i.include_archived]);
  },
});

cap({
  name: 'record_fitness_result', method: 'POST', path: '/officials-development/bodies/:id/fitness-results', tag: TAG, status: 201,
  summary: 'Record a fitness/competency result for an official the body licenses (licensing officer/admin): the date, who ran it (provider or reference), and either pass/fail/completed or, for a measured test, the value (the outcome follows the pass threshold). Validity follows the test type. A mistake is voided with a reason, never deleted. The measured value is visible only to the official and the body\'s licensing staff.',
  input: z.object({ id, test_id: id, official_id: id, taken_on: day, outcome: z.enum(['pass', 'fail', 'completed']).optional(), measured_value: z.number().min(0).max(100000).optional(), provider: text(120).optional(), reference: text(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c });
    const t = (await c.query('SELECT * FROM off_fitness_test_types WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.test_id, i.id])).rows[0];
    if (!t) throw notFound('Fitness test');
    if (!(await holdsLicenceUnder(c, i.official_id, i.id))) throw badRequest('That person is not licensed by this body');
    if (i.taken_on > today()) throw badRequest('The test date is in the future');
    let outcome = i.outcome, value = null;
    if (t.result_kind === 'measured') {
      if (i.measured_value == null) throw badRequest('Record the measured value');
      value = i.measured_value;
      outcome = (t.pass_direction === 'at_least' ? value >= Number(t.pass_threshold) : value <= Number(t.pass_threshold)) ? 'pass' : 'fail';
    } else {
      if (!outcome) throw badRequest('Record the outcome');
      if (i.measured_value != null) throw badRequest('This test records only an outcome');
    }
    const r = (await c.query('INSERT INTO off_fitness_results(body_id, test_type_id, official_id, taken_on, outcome, measured_value, provider, reference_enc, valid_until, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [i.id, t.id, i.official_id, i.taken_on, outcome, value, i.provider || null, sealText(i.reference, CTX.fitness), addMonths(i.taken_on, t.validity_months), user.id])).rows[0];
    await logOff(c, i.id, 'fitness', r.id, 'result_recorded', { actor: user.id, detail: { test_id: t.id, outcome } });
    await notify(c, i.official_id, { kind: 'official_fitness_result', title: `${t.name}: result recorded`, body: outcome === 'fail' ? 'Open Officials development for the next steps.' : 'Your result is on file.', data: { result_id: r.id }, dedupe_key: `off-fit:${r.id}` });
    await audit(c, user.id, 'official_fitness_recorded', 'off_fitness_results', r.id);
    return (await resultRows(c, { id: r.id, staff: true }))[0];
  }),
});

const resultRows = (c, { id: rid = null, officialId = null, bodyId = null, staff = false }) => c.query(
  `SELECT r.id, r.body_id, r.test_type_id, t.name AS test_name, t.version AS test_version, t.result_kind, t.unit, r.official_id, u.display_name AS official_name, r.taken_on::text AS taken_on, r.outcome, r.measured_value::float AS measured_value, r.provider,
          r.valid_until::text AS valid_until, r.voided_at, r.void_reason, r.created_at,
          CASE WHEN r.voided_at IS NOT NULL THEN 'voided' WHEN r.outcome='fail' THEN 'failed' WHEN r.valid_until < current_date THEN 'expired' WHEN r.valid_until <= current_date + 30 THEN 'expiring' ELSE 'valid' END AS standing
     FROM off_fitness_results r JOIN off_fitness_test_types t ON t.id=r.test_type_id JOIN users u ON u.id=r.official_id
    WHERE ($1::uuid IS NULL OR r.id=$1) AND ($2::uuid IS NULL OR r.official_id=$2) AND ($3::uuid IS NULL OR r.body_id=$3) ORDER BY r.taken_on DESC, r.created_at DESC LIMIT 200`, [rid, officialId, bodyId]).then((x) => x.rows);

cap({
  name: 'void_fitness_result', method: 'POST', path: '/officials-development/fitness-results/:id/void', tag: TAG,
  summary: 'Void a fitness result entered by mistake (licensing officer/admin) with a reason. The record stays, marked void, and stops counting.',
  input: z.object({ id, reason: text(300).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM off_fitness_results WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r) throw notFound('Fitness result');
    await devStaff(user, r.body_id, { c });
    if (r.voided_at) throw conflict('Already voided');
    await c.query('UPDATE off_fitness_results SET voided_at=now(), void_reason=$2 WHERE id=$1', [r.id, i.reason]);
    await logOff(c, r.body_id, 'fitness', r.id, 'result_voided', { actor: user.id, reason: i.reason });
    return (await resultRows(c, { id: r.id }))[0];
  }),
});

cap({
  name: 'list_fitness_results', method: 'GET', path: '/officials-development/fitness-results', tag: TAG,
  summary: 'Fitness/competency results. Pass `mine` for your own (with measured values), or `body_id` as the body\'s licensing staff (optionally one `official_id`). Nobody else, including assessors and mentors, can read them.',
  input: z.object({ mine: z.coerce.boolean().optional(), body_id: id.optional(), official_id: id.optional() }),
  async handler({ user }, i) {
    if (!i.mine && !i.body_id) throw badRequest('Give mine, or body_id');
    if (i.body_id && !i.mine) { await devStaff(user, i.body_id); return resultRows(pool, { bodyId: i.body_id, officialId: i.official_id ?? null, staff: true }); }
    return resultRows(pool, { officialId: user.id, bodyId: i.body_id ?? null });
  },
});

// ------------------------------------------------------------------ CPD
const CPD_COLS = `r.id, r.body_id, bo.name AS body_name, r.user_id, u.display_name AS holder_name, r.sport_id, r.kind, r.title, r.provider_name, r.provider_org_id, po.name AS provider_org_name, r.credential_id, r.completed_on::text AS completed_on,
  r.hours::float AS hours, r.credits::float AS credits, r.expires_on::text AS expires_on, r.status, r.decision_reason, r.decided_at, r.created_at, (r.evidence_enc IS NOT NULL) AS has_evidence,
  (r.expires_on IS NOT NULL AND r.expires_on < current_date) AS expired`;
const CPD_FROM = 'off_cpd_records r JOIN governing_bodies b ON b.id=r.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN users u ON u.id=r.user_id LEFT JOIN organisations po ON po.id=r.provider_org_id';
const cpdRow = async (c, rid) => (await c.query(`SELECT ${CPD_COLS} FROM ${CPD_FROM} WHERE r.id=$1`, [rid])).rows[0];

cap({
  name: 'record_cpd', method: 'POST', path: '/officials-development/cpd', tag: TAG, status: 201,
  summary: 'Record a continuing-professional-development activity (course, module, workshop, conference): the body it counts for, provider, date, hours and credits, expiry where it has one, and evidence. When it is backed by an education credential issued to you, link it with `credential_id`: the issuing institution is the source, so it counts at once. Otherwise it counts after the body\'s licensing staff verify it. You must hold or have held a licence from that body.',
  input: z.object({ body_id: id, sport_id: id.optional(), kind: z.enum(['course', 'module', 'workshop', 'conference', 'mentoring', 'other']), title: text(160).min(2), provider_name: text(120).optional(), provider_org_id: id.optional(), credential_id: id.optional(),
    completed_on: day, hours: num(500), credits: num(500).default(0), expires_on: day.optional(), evidence: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    mustBeActive(await bodyById(i.body_id, c));
    if (!(await holdsLicenceUnder(c, user.id, i.body_id))) throw forbidden('CPD is recorded with a body that licenses you');
    if (i.completed_on > today()) throw badRequest('The completion date is in the future');
    if (i.expires_on && i.expires_on < i.completed_on) throw badRequest('It expires before it was completed');
    let provider = i.provider_org_id ?? null, title = i.title, status = 'recorded';
    if (i.credential_id) {
      const cr = (await c.query("SELECT c.*, o.name AS org_name FROM credentials c JOIN organisations o ON o.id=c.organisation_id WHERE c.id=$1 AND c.user_id=$2 AND c.status='issued' AND (c.expires_on IS NULL OR c.expires_on >= current_date)", [i.credential_id, user.id])).rows[0];
      if (!cr) throw badRequest('That credential is not an issued, current credential of yours');
      provider = cr.organisation_id; status = 'verified';
    }
    if (provider && !(await c.query('SELECT 1 FROM organisations WHERE id=$1', [provider])).rowCount) throw notFound('Provider organisation');
    let r;
    try {
      r = (await c.query(`INSERT INTO off_cpd_records(body_id, user_id, sport_id, kind, title, provider_name, provider_org_id, credential_id, completed_on, hours, credits, expires_on, evidence_enc, status, decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $14='verified' THEN now() END) RETURNING id`,
        [i.body_id, user.id, i.sport_id ?? null, i.kind, title, i.provider_name || null, provider, i.credential_id ?? null, i.completed_on, i.hours, i.credits, i.expires_on ?? null, sealText(i.evidence, CTX.cpd), status])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('That credential is already recorded as CPD for this body'); throw e; }
    await logOff(c, i.body_id, 'cpd', r.id, 'recorded', { to: status, actor: user.id, detail: { credential_id: i.credential_id ?? null } });
    return cpdRow(c, r.id);
  }),
});

cap({
  name: 'decide_cpd', method: 'POST', path: '/officials-development/cpd/:id/decision', tag: TAG,
  summary: 'Verify or reject a self-reported CPD record (licensing officer/admin), with a reason when rejecting. Only verified hours count toward a grade\'s requirements.',
  input: z.object({ id, action: z.enum(['verify', 'reject']), reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM off_cpd_records WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r) throw notFound('CPD record');
    await devStaff(user, r.body_id, { c, sportId: r.sport_id });
    if (r.status !== 'recorded') throw conflict(`This record is ${r.status}`);
    if (i.action === 'reject' && !i.reason?.trim()) throw badRequest('Give a reason; the official is shown it');
    const to = i.action === 'verify' ? 'verified' : 'rejected';
    await c.query('UPDATE off_cpd_records SET status=$2, decision_reason=$3, decided_by=$4, decided_at=now() WHERE id=$1', [r.id, to, i.reason || null, user.id]);
    await logOff(c, r.body_id, 'cpd', r.id, i.action, { from: 'recorded', to, actor: user.id, reason: i.reason });
    await notify(c, r.user_id, { kind: `official_cpd_${i.action}`, title: i.action === 'verify' ? 'CPD verified' : 'CPD not accepted', body: i.action === 'verify' ? `${r.title} now counts.` : (i.reason ?? ''), data: { cpd_id: r.id }, dedupe_key: `off-cpd:${r.id}:${to}` });
    return cpdRow(c, r.id);
  }),
});

cap({
  name: 'withdraw_cpd', method: 'POST', path: '/officials-development/cpd/:id/withdraw', tag: TAG,
  summary: 'Withdraw a CPD record you entered. It stays in your history and stops counting.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query('SELECT * FROM off_cpd_records WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!r || r.user_id !== user.id) throw notFound('CPD record');
    if (!['recorded', 'verified'].includes(r.status)) throw conflict(`This record is ${r.status}`);
    await c.query("UPDATE off_cpd_records SET status='withdrawn', decided_at=now() WHERE id=$1", [r.id]);
    await logOff(c, r.body_id, 'cpd', r.id, 'withdrawn', { from: r.status, to: 'withdrawn', actor: user.id });
    return cpdRow(c, r.id);
  }),
});

cap({
  name: 'list_cpd', method: 'GET', path: '/officials-development/cpd', tag: TAG,
  summary: 'CPD records. Pass `mine` for yours (any status), or `body_id` as the body\'s licensing staff (optionally `status=recorded` for the verification queue). Evidence text is only returned to its owner.',
  input: z.object({ mine: z.coerce.boolean().optional(), body_id: id.optional(), user_id: id.optional(), status: z.enum(['recorded', 'verified', 'rejected', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    if (!i.mine && !i.body_id) throw badRequest('Give mine, or body_id');
    if (i.body_id && !i.mine) await devStaff(user, i.body_id);
    const w = '($1::uuid IS NULL OR r.user_id=$1) AND ($2::uuid IS NULL OR r.body_id=$2) AND ($3::text IS NULL OR r.status=$3)';
    const a = [i.mine ? user.id : (i.user_id ?? null), i.body_id ?? null, i.status ?? null];
    const total = await one(`SELECT count(*)::int AS n FROM ${CPD_FROM} WHERE ${w}`, a);
    const rows = await many(`SELECT ${CPD_COLS}${i.mine ? ', r.evidence_enc' : ''} FROM ${CPD_FROM} WHERE ${w} ORDER BY (r.status='recorded') DESC, r.completed_on DESC LIMIT $4 OFFSET $5`, [...a, i.limit, i.offset]);
    return { total: total.n, items: rows.map((r) => { const { evidence_enc, ...rest } = r; return plain({ ...rest, ...(i.mine ? { evidence: unsealText(evidence_enc, CTX.cpd) } : {}) }); }) };
  },
});

export { resultRows, cpdHours, fitnessStanding };
