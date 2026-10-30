// Federation & Governing Body OS (#475) 3/4: federation licences and memberships for athletes, coaches, officials and other roles. A licence belongs to
// the canonical user (never a copy of the person): the holder applies (a verified guardian applies for a young person), the body reviews against its
// published requirements, and the licence is issued, renewed, suspended, revoked or allowed to expire with full history. Standing is always read live.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt } from '../crypto.js';
import { requireApproved } from '../access.js';
import { hasConsent, requireConsent, isYouth } from '../youth.js';
import { authority, need, mustBeActive, bodyById, lockBody, logFed, historyOf, nextNumber, policyAt, paramsOf, check, blocking, LIC_STATUS, AFF_STATUS, addMonths, today, isGuardianOf, subtree } from '../federation.js';
import { developmentChecks } from '../officials-development.js';
import { gate } from '../federation-approvals.js';
import { subjectFor, needStaff, staffCan, staffRecipients, evidenceIn, addEvidence, evidenceList, readEvidence, removeEvidence, missingDocuments } from '../federation-subjects.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const HOLDER_ROLES = ['athlete', 'coach', 'official', 'administrator', 'other'];
const PROFILE_FOR = { athlete: 'athlete', coach: 'coach', official: 'referee' };
const STANDING = { active: 'good_standing', suspended: 'suspended', expired: 'expired', revoked: 'revoked' };

// ------------------------------------------------------------------ types
cap({
  name: 'save_licence_type', method: 'POST', path: '/federation/bodies/:id/licence-types', tag: TAG, status: 201,
  summary: 'Define a licence a body issues (licensing officer/admin): which role holds it, the sport and discipline, the grade (and its rank, so "Level 2 or above" can be required of officials), how long it lasts, an optional fee, and whether it needs a verified coach/physio/doctor profile or an affiliated club. Pass `type_id` to change or archive one; archived types stay on the licences already issued.',
  input: z.object({ id, type_id: id.optional(), name: text(80).min(2), holder_role: z.enum(HOLDER_ROLES), sport_id: id, discipline: text(60).default(''), grade: text(40).default(''), grade_rank: z.number().int().min(0).max(20).default(0),
    duration_months: z.number().int().min(1).max(120).default(12), fee_minor: z.number().int().min(0).max(1_000_000_000).default(0), currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
    requires_verification: z.enum(['gamer', 'coach', 'physio', 'doctor']).nullish(), requires_affiliation: z.boolean().default(false), window_required: z.boolean().default(false), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await authority(user, i.id, { c });
    need(a, 'licences', i.sport_id);
    if (!(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    const v = [i.name, i.holder_role, i.sport_id, i.discipline, i.grade, i.grade_rank, i.duration_months, i.fee_minor, i.currency, i.requires_verification ?? null, i.requires_affiliation, i.window_required];
    let row;
    try {
      if (i.type_id) {
        row = (await c.query(
          `UPDATE fed_licence_types SET name=$3, holder_role=$4, sport_id=$5, discipline=$6, grade=$7, grade_rank=$8, duration_months=$9, fee_minor=$10, currency=$11, requires_verification=$12, requires_affiliation=$13, window_required=$14,
                  archived_at=CASE WHEN $15::boolean THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 AND body_id=$2 RETURNING *`, [i.type_id, i.id, ...v, !!i.archived])).rows[0];
        if (!row) throw notFound('Licence type');
      } else {
        row = (await c.query('INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, discipline, grade, grade_rank, duration_months, fee_minor, currency, requires_verification, requires_affiliation, window_required, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
          [i.id, ...v, user.id])).rows[0];
      }
    } catch (e) { if (e.code === '23505') throw conflict('There is already a licence type with that name for this sport and discipline'); throw e; }
    await logFed(c, i.id, 'body', i.id, i.type_id ? 'licence_type_updated' : 'licence_type_created', { actor: user.id, detail: { type_id: row.id, name: row.name } });
    return row;
  }),
});

cap({
  name: 'list_licence_types', method: 'GET', path: '/federation/bodies/:id/licence-types', tag: TAG, auth: 'public',
  summary: 'The licences a body issues, with grade, duration and fee. Public.',
  input: z.object({ id, sport_id: id.optional(), holder_role: z.enum(HOLDER_ROLES).optional(), include_archived: z.coerce.boolean().default(false) }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    return many(`SELECT t.*, s.name AS sport_name FROM fed_licence_types t JOIN sports s ON s.id=t.sport_id WHERE t.body_id=$1 AND ($2::uuid IS NULL OR t.sport_id=$2) AND ($3::text IS NULL OR t.holder_role=$3) AND ($4 OR t.archived_at IS NULL) ORDER BY s.name, t.holder_role, t.grade_rank, t.name`,
      [i.id, i.sport_id ?? null, i.holder_role ?? null, i.include_archived]);
  },
});

// ------------------------------------------------------------------ views
const LIC_COLS = `l.id, l.body_id, bo.name AS body_name, b.abbreviation AS body_abbreviation, l.type_id, t.name AS type_name, t.holder_role, t.sport_id, s.name AS sport_name, t.discipline, l.grade, t.grade_rank,
  l.holder_id, u.display_name AS holder_name, u.handle AS holder_handle, l.affiliation_id, af.affiliation_no, l.status AS recorded_status, ${LIC_STATUS('l')} AS status,
  l.licence_no, l.public_code, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, l.suspended_until::text AS suspended_until, l.previous_id, l.fee_minor, l.fee_currency, l.fee_status, l.override_reason, l.decision_reason, l.submitted_at, l.decided_at, l.row_version, l.created_at,
  CASE WHEN l.expires_on IS NOT NULL THEN l.expires_on - current_date END AS days_to_expiry`;
const LIC_FROM = `fed_licences l JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN fed_licence_types t ON t.id=l.type_id JOIN sports s ON s.id=t.sport_id JOIN users u ON u.id=l.holder_id
  LEFT JOIN fed_affiliations af ON af.id=l.affiliation_id`;
const withStanding = (r) => ({ ...r, standing: STANDING[r.status] ?? 'pending' });
export const licenceRow = async (lid, c = pool) => { const r = (await c.query(`SELECT ${LIC_COLS} FROM ${LIC_FROM} WHERE l.id=$1`, [lid])).rows[0]; return r ? withStanding(r) : r; };

const ACTIONS = {
  staff: { submitted: ['start_review', 'request_info', 'approve', 'reject'], under_review: ['request_info', 'approve', 'reject'], needs_info: ['reject'], active: ['suspend', 'revoke'], suspended: ['reinstate', 'revoke'] },
  party: { draft: ['submit', 'withdraw'], needs_info: ['submit', 'withdraw'], submitted: ['withdraw'], under_review: ['withdraw'], active: ['withdraw', 'renew'], suspended: ['withdraw'], expired: ['renew'] },
};

/** Does `userId` belong to the organisation behind an affiliation: an active member, or a player/coach on one of its teams? */
async function belongsToOrg(c, userId, orgId) {
  return (await c.query(
    `SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'
     UNION SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE t.organisation_id=$1 AND m.user_id=$2 AND m.status='active' LIMIT 1`, [orgId, userId])).rowCount > 0;
}

/** The checks an issue runs, from the type's own settings and the body's published licence requirements. */
export async function licenceChecks(c, l, type, { issuedOn }) {
  const pol = await policyAt(l.body_id, 'licence', { sportId: type.sport_id, category: type.holder_role, seasonYear: Number(issuedOn.slice(0, 4)), date: today() }, c);
  const p = paramsOf('licence', pol);
  const holder = (await c.query('SELECT id, roles FROM users WHERE id=$1', [l.holder_id])).rows[0];
  const need = PROFILE_FOR[type.holder_role];
  const missing = await missingDocuments(c, 'licence', l.id, p.required_documents);
  const checks = [
    ...(need ? [check('profile', `Holds a ${need} profile`, holder.roles.includes(need), holder.roles.includes(need) ? null : `They need a ${need} profile on Sportarena first`)] : []),
    check('documents', 'Required documents are attached', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : (p.required_documents.length ? `${p.required_documents.length} attached` : 'None required')),
    check('fee', 'Fee settled', ['none', 'paid', 'waived'].includes(l.fee_status), l.fee_status === 'due' ? 'The fee is still due' : null),
  ];
  if (type.requires_verification) {
    const v = (await c.query("SELECT id, expires_at FROM verification_cases WHERE subject_type='user' AND subject_id=$1 AND type=$2 AND status='approved' AND (expires_at IS NULL OR expires_at > now()) ORDER BY decided_at DESC LIMIT 1", [l.holder_id, type.requires_verification])).rows[0];
    checks.push(check('verification', `Platform-verified ${type.requires_verification}`, !!v, v ? null : `No current ${type.requires_verification} verification on file`));
  }
  if (l.affiliation_id) {
    const a = (await c.query(`SELECT a.organisation_id, a.body_id, ${AFF_STATUS('a')} AS st FROM fed_affiliations a WHERE a.id=$1`, [l.affiliation_id])).rows[0];
    const ok = a && a.body_id === l.body_id && a.st === 'approved';
    checks.push(check('affiliation', 'Attached to an affiliated club', !!ok, ok ? null : 'The club\'s affiliation is not in force'));
    checks.push(check('membership', 'Belongs to that club', ok && await belongsToOrg(c, l.holder_id, a.organisation_id), 'Not an active member or player of the club'));
  } else if (type.requires_affiliation) checks.push(check('affiliation', 'Attached to an affiliated club', false, 'This licence needs an affiliated club'));
  if (type.window_required) {
    const w = (await c.query("SELECT 1 FROM fed_dates WHERE body_id=$1 AND kind='registration_window' AND status='active' AND (sport_id IS NULL OR sport_id=$2) AND current_date BETWEEN starts_on AND ends_on LIMIT 1", [l.body_id, type.sport_id])).rowCount > 0;
    checks.push(check('window', 'A registration window is open', w, w ? null : 'Registration is closed right now'));
  }
  checks.push(...await developmentChecks(c, l, type, { issuedOn })); // officials: prerequisite grade, assessments, CPD, fitness (#486), read live from their own records
  if (await isYouth(l.holder_id, c)) checks.push(check('guardian_consent', 'A verified guardian consents', await hasConsent(l.holder_id, 'participation', c), 'Needs current guardian consent for taking part'));
  return { checks, policy: pol };
}

async function detail(s, c = pool) {
  const row = await licenceRow(s.row.id, c);
  const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1', [s.row.type_id])).rows[0];
  const pol = await policyAt(s.row.body_id, 'licence', { sportId: type.sport_id, category: type.holder_role }, c);
  const acts = [...(staffCan(s, 'licences') ? ACTIONS.staff[row.recorded_status] ?? [] : []), ...(s.party ? ACTIONS.party[row.status] ?? ACTIONS.party[row.recorded_status] ?? [] : [])];
  return {
    ...row, as: { party: s.party, staff: !!s.auth && !s.auth.viaAncestor }, actions: [...new Set([...acts, ...(staffCan(s, 'licences') && ['submitted', 'under_review', 'needs_info', 'active', 'suspended'].includes(row.recorded_status) ? ['record_fee'] : [])])],
    type: { requires_verification: type.requires_verification, requires_affiliation: type.requires_affiliation, window_required: type.window_required, duration_months: type.duration_months },
    requirements: pol ? { policy_title: pol.title, version: pol.version, inherited: pol.inherited, ...paramsOf('licence', pol) } : null,
    evidence: await evidenceList('licence', s.row.id, c), history: await historyOf('licence', s.row.id, c), decided_checks: s.row.checks,
    ...(staffCan(s, 'licences') && ['submitted', 'under_review'].includes(row.recorded_status) ? { preview: (await licenceChecks(c, s.row, type, { issuedOn: today() })).checks } : {}),
  };
}

// ------------------------------------------------------------------ apply / submit / withdraw / renew
cap({
  name: 'apply_licence', method: 'POST', path: '/federation/licences', tag: TAG, status: 201,
  summary: 'Apply for a federation licence. You apply for yourself; a verified guardian applies for a young person (who needs current guardian consent for taking part). Optionally attach it to an affiliated club you belong to. Attach the required documents, then submit.',
  input: z.object({ body_id: id, type_id: id, holder_id: id.optional().describe('defaults to you; a young person you are a verified guardian of'), affiliation_id: id.optional(), note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    const holderId = i.holder_id ?? user.id;
    if (holderId !== user.id && !(await isGuardianOf(user.id, holderId, c))) throw forbidden('You can only apply for yourself or for a young person you are a verified guardian of');
    if (holderId === user.id && await isYouth(user.id, c) && !user.roles?.includes('admin')) throw forbidden('A young person\'s licence is applied for by their verified guardian');
    if (await isYouth(holderId, c)) await requireConsent(holderId, 'participation', 'a federation licence', c);
    await lockBody(c, i.body_id);
    mustBeActive(await bodyById(i.body_id, c));
    const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.type_id, i.body_id])).rows[0];
    if (!type) throw notFound('Licence type');
    if (type.requires_affiliation && !i.affiliation_id) throw badRequest('This licence is held through an affiliated club: pick the club');
    if (i.affiliation_id) {
      const a = (await c.query(`SELECT a.organisation_id, a.body_id, ${AFF_STATUS('a')} AS st FROM fed_affiliations a WHERE a.id=$1`, [i.affiliation_id])).rows[0];
      if (!a || a.body_id !== i.body_id || a.st !== 'approved') throw badRequest('That club does not hold an affiliation with this body');
      if (!(await belongsToOrg(c, holderId, a.organisation_id))) throw badRequest('The holder is not a member or player of that club');
    }
    if ((await c.query("SELECT 1 FROM fed_licences WHERE body_id=$1 AND type_id=$2 AND holder_id=$3 AND (status IN ('draft','submitted','under_review','needs_info') OR (status IN ('active','suspended') AND expires_on >= current_date)) LIMIT 1", [i.body_id, i.type_id, holderId])).rowCount) throw conflict('There is already an open or current licence of this type for that person');
    let l;
    try {
      l = (await c.query('INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, affiliation_id, grade, fee_minor, fee_currency, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [i.body_id, i.type_id, holderId, user.id, i.affiliation_id ?? null, type.grade, type.fee_minor, type.currency, i.note || null])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already an open or current licence of this type for that person'); throw e; }
    await logFed(c, i.body_id, 'licence', l.id, 'created', { to: 'draft', actor: user.id });
    return licenceRow(l.id, c);
  }),
});

cap({
  name: 'submit_licence', method: 'POST', path: '/federation/licences/:id/submit', tag: TAG,
  summary: 'Send the licence application to the body once the required documents are attached. The fee, if any, becomes due.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the holder or their verified guardian submits');
    if (!['draft', 'needs_info'].includes(s.row.status)) throw conflict(`This application is ${s.row.status}`);
    const body = await bodyById(s.row.body_id, c);
    mustBeActive(body);
    const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1', [s.row.type_id])).rows[0];
    const p = paramsOf('licence', await policyAt(s.row.body_id, 'licence', { sportId: type.sport_id, category: type.holder_role }, c));
    const missing = await missingDocuments(c, 'licence', s.row.id, p.required_documents);
    if (missing.length) throw conflict(`Attach the required documents first: ${missing.join(', ')}`, { code: 'documents_missing', missing });
    const fee = s.row.fee_minor > 0 && s.row.fee_status === 'none' ? 'due' : s.row.fee_status;
    await c.query("UPDATE fed_licences SET status='submitted', fee_status=$2, submitted_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [s.row.id, fee]);
    await logFed(c, s.row.body_id, 'licence', s.row.id, 'submitted', { from: s.row.status, to: 'submitted', actor: user.id });
    for (const uid of await staffRecipients(c, body, ['licensing'])) await notify(c, uid, { kind: 'federation_licence_submitted', title: 'New licence application', body: `A licence application is waiting at ${body.abbreviation}.`, data: { licence_id: s.row.id, body_id: body.id }, dedupe_key: `fed-lic-sub:${s.row.id}:${s.row.row_version}:${uid}` });
    return licenceRow(s.row.id, c);
  }),
});

cap({
  name: 'withdraw_licence', method: 'POST', path: '/federation/licences/:id/withdraw', tag: TAG,
  summary: 'Withdraw an application or give up a licence you hold (the holder or their verified guardian). The record stays.',
  input: z.object({ id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the holder or their verified guardian withdraws');
    if (!(ACTIONS.party[s.row.status] ?? []).includes('withdraw')) throw conflict(`This licence is ${s.row.status}`);
    await c.query("UPDATE fed_licences SET status='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1", [s.row.id]);
    await logFed(c, s.row.body_id, 'licence', s.row.id, 'withdrawn', { from: s.row.status, to: 'withdrawn', actor: user.id, reason: i.reason });
    return licenceRow(s.row.id, c);
  }),
});

cap({
  name: 'renew_licence', method: 'POST', path: '/federation/licences/:id/renew', tag: TAG, status: 201,
  summary: 'Start the renewal of an active licence (once it is inside the body\'s renewal notice period, 30 days unless the body says otherwise) or an expired one. A new application is created pointing at the old licence, which stays as it was.',
  input: z.object({ id, carry_over_documents: z.boolean().default(true) }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the holder or their verified guardian renews');
    const cur = (await c.query(`SELECT ${LIC_STATUS('l')} AS eff, l.expires_on - current_date AS left FROM fed_licences l WHERE l.id=$1`, [s.row.id])).rows[0];
    if (!['active', 'expired'].includes(cur.eff)) throw conflict(`Only an active or expired licence can be renewed; this one is ${cur.eff}`);
    const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1', [s.row.type_id])).rows[0];
    const notice = paramsOf('licence', await policyAt(s.row.body_id, 'licence', { sportId: type.sport_id, category: type.holder_role }, c)).renewal_notice_days;
    if (cur.eff === 'active' && cur.left > notice) throw conflict(`Renewal opens ${notice} days before the licence expires (${cur.left} days to go)`);
    mustBeActive(await bodyById(s.row.body_id, c));
    if (type.archived_at) throw conflict('That licence type has been retired; apply again for a current one');
    if ((await c.query("SELECT 1 FROM fed_licences WHERE previous_id=$1 AND status NOT IN ('rejected','withdrawn')", [s.row.id])).rowCount) throw conflict('This licence has already been renewed');
    if (await isYouth(s.row.holder_id, c)) await requireConsent(s.row.holder_id, 'participation', 'a federation licence', c);
    let n;
    try {
      n = (await c.query('INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, affiliation_id, grade, previous_id, fee_minor, fee_currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [s.row.body_id, s.row.type_id, s.row.holder_id, user.id, null, type.grade, s.row.id, type.fee_minor, type.currency])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already an open application of this type'); throw e; }
    if (i.carry_over_documents) {
      await c.query(`INSERT INTO fed_evidence(body_id, subject_type, subject_id, requirement, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by)
                     SELECT body_id, subject_type, $2, requirement, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, $3 FROM fed_evidence WHERE subject_type='licence' AND subject_id=$1 AND removed_at IS NULL`, [s.row.id, n.id, user.id]);
    }
    await logFed(c, s.row.body_id, 'licence', n.id, 'created', { to: 'draft', actor: user.id, detail: { renews: s.row.id } });
    await logFed(c, s.row.body_id, 'licence', s.row.id, 'renewal_started', { actor: user.id, detail: { renewal_id: n.id } });
    return licenceRow(n.id, c);
  }),
});

// ------------------------------------------------------------------ decisions
cap({
  name: 'decide_licence', method: 'POST', path: '/federation/licences/:id/decision', tag: TAG,
  summary: 'Review a licence (licensing officer/admin): start_review, request_info, approve (issues the licence and its number), reject, suspend (optionally until a date), reinstate or revoke. Approval runs the type\'s own requirements and the body\'s published licence policy; a failed requirement needs an `override_reason`, recorded as a compliance exception. Pass `version` to refuse a decision on a record that changed meanwhile.',
  input: z.object({ id, action: z.enum(['start_review', 'request_info', 'approve', 'reject', 'suspend', 'reinstate', 'revoke']), reason: text(500).optional(), issued_on: day.optional(), expires_on: day.optional(), suspended_until: day.optional(), override_reason: text(500).min(5).optional(), version: z.number().int().min(1).optional(), approval_id: id.optional().describe('the second person\'s approval, where the body requires four eyes') }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    needStaff(s, 'licences');
    const l = s.row;
    if (i.version && i.version !== l.row_version) throw conflict('This licence changed since you opened it; reload and decide again', { code: 'stale_version' });
    if (!(ACTIONS.staff[l.status] ?? []).includes(i.action)) throw conflict(`You cannot ${i.action.replace('_', ' ')} a licence that is ${l.status}`);
    if (['request_info', 'reject', 'suspend', 'revoke'].includes(i.action) && !i.reason?.trim()) throw badRequest('Give a reason; the holder is shown it');
    const body = await bodyById(l.body_id, c);
    const type = (await c.query('SELECT * FROM fed_licence_types WHERE id=$1', [l.type_id])).rows[0];
    let patch = {}, to;
    if (i.action === 'start_review') to = 'under_review';
    else if (i.action === 'request_info') to = 'needs_info';
    else if (i.action === 'reject') { to = 'rejected'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'revoke') { to = 'revoked'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'suspend') {
      if (l.expires_on < today()) throw conflict('This licence has already expired');
      if (i.suspended_until && i.suspended_until < today()) throw badRequest('The suspension end date is in the past');
      to = 'suspended'; patch = { decision_reason: i.reason, suspended_until: i.suspended_until ?? null };
    } else if (i.action === 'reinstate') {
      if (l.expires_on < today()) throw conflict('This licence has already expired; it needs renewing');
      to = 'active'; patch = { decision_reason: i.reason ?? null, suspended_until: null };
    } else {
      mustBeActive(body);
      const prev = l.previous_id ? (await c.query('SELECT expires_on::text AS expires_on FROM fed_licences WHERE id=$1', [l.previous_id])).rows[0] : null;
      let issued = today();
      if (prev?.expires_on && prev.expires_on >= issued) { const d = new Date(`${String(prev.expires_on).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); issued = d.toISOString().slice(0, 10); }
      issued = i.issued_on ?? issued;
      const expires = i.expires_on ?? addMonths(issued, type.duration_months);
      if (expires < issued) throw badRequest('The expiry date is before the issue date');
      const { checks, policy } = await licenceChecks(c, l, type, { issuedOn: issued });
      const fails = blocking(checks);
      if (fails.length && !i.override_reason) throw conflict(`Not all requirements are met: ${fails.map((x) => x.label).join('; ')}. Fix them, or approve with an override reason.`, { code: 'requirements_not_met', checks });
      if (fails.length) await gate(c, user, { bodyId: l.body_id, actions: ['credential_exception'], subjectType: 'licence', subjectId: l.id, request: { act: 'approve', override: i.override_reason }, approvalId: i.approval_id });
      to = 'active';
      patch = { licence_no: l.licence_no ?? await nextNumber(c, l.body_id, 'licence', issued.slice(0, 4)), public_code: l.public_code ?? randomBytes(6).toString('hex').toUpperCase(), issued_on: issued, expires_on: expires, grade: type.grade,
        checks: JSON.stringify(checks), policy_version_id: policy?.version_id ?? null, override_reason: fails.length ? i.override_reason : null, decision_reason: i.reason ?? null, suspended_until: null };
    }
    const keys = Object.keys(patch);
    await c.query(`UPDATE fed_licences SET status=$2, decided_by=$3, decided_at=now(), row_version=row_version+1, updated_at=now()${keys.map((k, n) => `, ${k}=$${n + 4}`).join('')} WHERE id=$1`, [l.id, to, user.id, ...keys.map((k) => patch[k])]);
    await logFed(c, l.body_id, 'licence', l.id, i.action, { from: l.status, to, actor: user.id, reason: i.reason ?? patch.override_reason,
      detail: { ...(patch.override_reason ? { override_reason: patch.override_reason } : {}), ...(patch.licence_no ? { licence_no: patch.licence_no, issued_on: patch.issued_on, expires_on: patch.expires_on } : {}), ...(patch.suspended_until ? { suspended_until: patch.suspended_until } : {}), ...(patch.policy_version_id ? { policy_version_id: patch.policy_version_id } : {}) } });
    const msg = { start_review: ['Licence under review', 'The federation has started reviewing your licence application.'], request_info: ['More information needed', i.reason], approve: ['Licence issued', `Your licence ${patch.licence_no ?? ''} is active until ${patch.expires_on ?? ''}.`],
      reject: ['Licence not approved', i.reason], suspend: ['Licence suspended', i.reason], reinstate: ['Licence reinstated', 'Your licence is active again.'], revoke: ['Licence revoked', i.reason] }[i.action];
    const people = new Set([l.holder_id, l.applicant_id]);
    for (const uid of people) await notify(c, uid, { kind: `federation_licence_${i.action}`, title: msg[0], body: `${body.abbreviation}: ${msg[1] ?? ''}`, data: { licence_id: l.id }, dedupe_key: `fed-lic:${l.id}:${l.row_version + 1}:${uid}` });
    await audit(c, user.id, `federation_licence_${i.action}`, 'fed_licences', l.id);
    return licenceRow(l.id, c);
  }),
});

cap({
  name: 'record_licence_fee', method: 'POST', path: '/federation/licences/:id/fee', tag: TAG,
  summary: 'Record that the licence fee was paid (date and your reference) or waived (licensing officer/admin). This notes what the holder paid the body outside the platform; it does not move money.',
  input: z.object({ id, status: z.enum(['paid', 'waived']), paid_on: day.optional(), reference: text(120).optional(), reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'licence', i.id, { c, lock: true });
    needStaff(s, 'licences');
    if (s.row.fee_status !== 'due') throw conflict(s.row.fee_status === 'none' ? 'There is no fee on this licence' : `The fee is already ${s.row.fee_status}`);
    if (i.status === 'waived' && !i.reason?.trim()) throw badRequest('Say why the fee is waived');
    await c.query('UPDATE fed_licences SET fee_status=$2, fee_paid_on=$3, fee_reference_enc=$4, fee_recorded_by=$5, row_version=row_version+1, updated_at=now() WHERE id=$1',
      [s.row.id, i.status, i.status === 'paid' ? i.paid_on ?? today() : null, i.reference ? encrypt(i.reference, 'fed_licences.fee_reference') : null, user.id]);
    await logFed(c, s.row.body_id, 'licence', s.row.id, `fee_${i.status}`, { actor: user.id, reason: i.reason, detail: { amount_minor: s.row.fee_minor, currency: s.row.fee_currency } });
    return licenceRow(s.row.id, c);
  }),
});

// ------------------------------------------------------------------ reads
const FILTER = `($1::uuid IS NULL OR l.body_id=$1) AND ($2::uuid[] IS NULL OR l.holder_id = ANY($2)) AND ($3::text IS NULL OR (${LIC_STATUS('l')})=$3) AND ($4::uuid IS NULL OR l.type_id=$4) AND ($5::uuid IS NULL OR t.sport_id=$5)
  AND ($6::int IS NULL OR (l.status='active' AND l.expires_on BETWEEN current_date AND current_date + $6::int)) AND ($7::text IS NULL OR u.display_name ILIKE '%'||$7||'%' OR l.licence_no ILIKE '%'||$7||'%')
  AND ($8::boolean OR l.status <> 'draft') AND ($9::uuid[] IS NULL OR l.body_id = ANY($9))`;
cap({
  name: 'list_licences', method: 'GET', path: '/federation/licences', tag: TAG,
  summary: 'Licences. As a body\'s staff (or staff of a body above it): pass `body_id`, optionally `include_descendants`, and filter by status, type, sport, expiry or holder name. As a person: pass `mine` for your own and those of young people you are a verified guardian of. Status is as of today: an active licence past its expiry reads as expired.',
  input: z.object({ body_id: id.optional(), mine: z.coerce.boolean().optional(), status: z.enum(['draft', 'submitted', 'under_review', 'needs_info', 'active', 'rejected', 'suspended', 'expired', 'revoked', 'withdrawn']).optional(), type_id: id.optional(), sport_id: id.optional(),
    expiring_within_days: z.coerce.number().int().min(1).max(365).optional(), q: text(80).optional(), include_descendants: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    if (!i.body_id && !i.mine) throw badRequest('Give body_id, or mine');
    let ids = null, bodyIds = null;
    if (i.mine) {
      ids = [user.id, ...(await many("SELECT child_id FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id])).map((r) => r.child_id)];
    }
    if (i.body_id) {
      const auth = await authority(user, i.body_id, { optional: true });
      if (!auth && !i.mine) throw notFound('Governing body');
      if (auth) bodyIds = i.include_descendants ? await subtree(i.body_id) : [i.body_id];
    }
    const a = [i.body_id && !i.include_descendants ? i.body_id : null, ids, i.status ?? null, i.type_id ?? null, i.sport_id ?? null, i.expiring_within_days ?? null, i.q || null, !!i.mine, i.include_descendants ? bodyIds : null];
    const total = await one(`SELECT count(*)::int AS n FROM ${LIC_FROM} WHERE ${FILTER}`, a);
    const items = await many(`SELECT ${LIC_COLS} FROM ${LIC_FROM} WHERE ${FILTER} ORDER BY (l.status IN ('submitted','under_review')) DESC, l.submitted_at DESC NULLS LAST, l.created_at DESC, l.id LIMIT $10 OFFSET $11`, [...a, i.limit, i.offset]);
    return { total: total.n, items: items.map(withStanding) };
  },
});

cap({
  name: 'get_licence', method: 'GET', path: '/federation/licences/:id', tag: TAG,
  summary: 'One licence with its requirements, evidence list (metadata only), decision history and the actions you may take (the body\'s staff, the holder or their verified guardian).',
  input: z.object({ id }),
  async handler({ user }, i) { return detail(await subjectFor(user, 'licence', i.id)); },
});
cap({
  name: 'add_licence_evidence', method: 'POST', path: '/federation/licences/:id/evidence', tag: TAG, status: 201,
  summary: 'Attach a document or reference to a licence application that is a draft or waiting for more information. Encrypted; only metadata is ever listed.',
  input: z.object({ id }).and(evidenceIn),
  handler: ({ user }, i) => tx(async (c) => { const s = await subjectFor(user, 'licence', i.id, { c, lock: true }); const { id: _id, ...e } = i; return addEvidence(c, s, user, e); }),
});
cap({
  name: 'read_licence_evidence', method: 'GET', path: '/federation/licences/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Read one evidence item in full (the holder or guardian, or the body\'s licensing officer/compliance/admin). Every read is audit-logged.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => readEvidence(c, await subjectFor(user, 'licence', i.id, { c }), user, i.evidence_id)),
});
cap({
  name: 'remove_licence_evidence', method: 'DELETE', path: '/federation/licences/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Take an item off an application that is still a draft or waiting for information. It is hidden, not erased.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => removeEvidence(c, await subjectFor(user, 'licence', i.id, { c, lock: true }), i.evidence_id)),
});

cap({
  name: 'verify_licence', method: 'GET', path: '/federation/verify/:code', tag: TAG, auth: 'public',
  summary: 'Check a licence from the code printed on it (public, for officials, clubs and organisers). Shows whether it is in good standing today, its type, grade, validity and issuing body; the holder\'s name only for an adult.',
  input: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-F0-9]{12}$/, 'a 12-character licence code') }),
  async handler(_ctx, i) {
    const r = await one(`SELECT l.id, ${LIC_STATUS('l')} AS status, l.licence_no, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, l.grade, t.name AS type_name, t.holder_role, s.name AS sport_name, t.discipline, bo.name AS body_name, b.abbreviation, u.display_name,
        (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS youth FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN sports s ON s.id=t.sport_id JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN users u ON u.id=l.holder_id
        WHERE l.public_code=$1`, [i.code]);
    if (!r) throw notFound('Licence');
    return { valid: r.status === 'active', status: r.status, standing: STANDING[r.status] ?? 'pending', licence_no: r.licence_no, type_name: r.type_name, holder_role: r.holder_role, sport_name: r.sport_name, discipline: r.discipline, grade: r.grade,
      issued_on: r.issued_on, expires_on: r.expires_on, body_name: r.body_name, body_abbreviation: r.abbreviation, holder_name: r.youth ? 'Registered athlete (name withheld)' : r.display_name };
  },
});
