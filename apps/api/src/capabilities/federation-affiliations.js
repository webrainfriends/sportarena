// Federation & Governing Body OS (#475) 2/4: club affiliation. A club (any organisation) applies to a governing body, the body reviews against its
// published requirements, and the affiliation is approved, renewed, suspended or allowed to expire with full history. Affiliation is a REFERENCE: it
// never changes the organisation's owners, members or teams.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { orgRole } from '../org-access.js';
import { encrypt } from '../crypto.js';
import { requireApproved } from '../access.js';
import { openException, authority, can, need, jurisdictionScope, mustBeJurisdictionOf, mustBeActive, mustRunOrg, bodyById, lockBody, logFed, historyOf, nextNumber, policyAt, paramsOf, check, blocking, AFF_STATUS, addMonths, today, subtree, dateStr } from '../federation.js';
import { subjectFor, needStaff, staffCan, staffRecipients, evidenceIn, addEvidence, evidenceList, readEvidence, removeEvidence, missingDocuments } from '../federation-subjects.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const year = z.number().int().min(1990).max(2200);
const KINDS = ['club', 'academy', 'school', 'league', 'other'];

// ------------------------------------------------------------------ categories
const CAT_COLS = 'c.id, c.body_id, c.name, c.applicant_kind, c.sport_id, s.name AS sport_name, c.description, c.fee_minor, c.currency, c.duration_months, c.archived_at';
cap({
  name: 'save_affiliation_category', method: 'POST', path: '/federation/bodies/:id/affiliation-categories', tag: TAG, status: 201,
  summary: 'Define a kind of affiliation a body offers (e.g. "Full club", "Associate school"): who may apply, the sport, the fee if there is one and how long it lasts (registrar/admin). Pass `category_id` to change or archive an existing one; archived categories stay on the affiliations already issued under them.',
  input: z.object({ id, category_id: id.optional(), name: text(80).min(2), applicant_kind: z.enum(KINDS).default('club'), sport_id: id.optional(), description: text(500).optional(),
    fee_minor: z.number().int().min(0).max(1_000_000_000).default(0), currency: z.string().regex(/^[A-Z]{3}$/).default('USD'), duration_months: z.number().int().min(1).max(60).default(12), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await authority(user, i.id, { c });
    need(a, 'affiliations');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    let row;
    try {
      if (i.category_id) {
        row = (await c.query(
          `UPDATE fed_affiliation_categories SET name=$3, applicant_kind=$4, sport_id=$5, description=$6, fee_minor=$7, currency=$8, duration_months=$9, archived_at=CASE WHEN $10::boolean THEN coalesce(archived_at, now()) ELSE NULL END
            WHERE id=$1 AND body_id=$2 RETURNING *`, [i.category_id, i.id, i.name, i.applicant_kind, i.sport_id ?? null, i.description || null, i.fee_minor, i.currency, i.duration_months, !!i.archived])).rows[0];
        if (!row) throw notFound('Category');
      } else {
        row = (await c.query('INSERT INTO fed_affiliation_categories(body_id, name, applicant_kind, sport_id, description, fee_minor, currency, duration_months, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [i.id, i.name, i.applicant_kind, i.sport_id ?? null, i.description || null, i.fee_minor, i.currency, i.duration_months, user.id])).rows[0];
      }
    } catch (e) { if (e.code === '23505') throw conflict('There is already a category with that name'); throw e; }
    await logFed(c, i.id, 'body', i.id, i.category_id ? 'category_updated' : 'category_created', { actor: user.id, detail: { category_id: row.id, name: row.name } });
    return row;
  }),
});

cap({
  name: 'list_affiliation_categories', method: 'GET', path: '/federation/bodies/:id/affiliation-categories', tag: TAG, auth: 'public',
  summary: 'What a body offers clubs, schools and leagues to affiliate as, with fees and duration. Public.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    return many(`SELECT ${CAT_COLS} FROM fed_affiliation_categories c LEFT JOIN sports s ON s.id=c.sport_id WHERE c.body_id=$1 AND ($2 OR c.archived_at IS NULL) ORDER BY c.name`, [i.id, i.include_archived]);
  },
});

// ------------------------------------------------------------------ views
const AFF_COLS = `a.id, a.body_id, bo.name AS body_name, b.abbreviation AS body_abbreviation, a.organisation_id, o.name AS organisation_name, o.kind AS organisation_kind, o.city AS organisation_city,
  a.jurisdiction_id, (SELECT j.name FROM fed_jurisdictions j WHERE j.id=a.jurisdiction_id) AS jurisdiction_name, a.category_id, c.name AS category_name, c.sport_id, s.name AS sport_name, a.season_year, ${AFF_STATUS('a')} AS status, a.status AS recorded_status, a.affiliation_no, a.effective_from::text AS effective_from, a.effective_to::text AS effective_to,
  a.fee_minor, a.fee_currency, a.fee_status, a.fee_paid_on::text AS fee_paid_on, a.previous_id, a.override_reason, a.decision_reason, a.submitted_at, a.decided_at, a.row_version, a.created_at,
  CASE WHEN a.effective_to IS NOT NULL THEN a.effective_to - current_date END AS days_to_expiry`;
const AFF_FROM = `fed_affiliations a JOIN governing_bodies b ON b.id=a.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN organisations o ON o.id=a.organisation_id
  JOIN fed_affiliation_categories c ON c.id=a.category_id LEFT JOIN sports s ON s.id=c.sport_id`;
export const affiliationRow = async (affId, c = pool) => (await c.query(`SELECT ${AFF_COLS} FROM ${AFF_FROM} WHERE a.id=$1`, [affId])).rows[0];

/** The checks an approval runs, from the body's published requirements (inherited from above when the body has none of its own). */
export async function affiliationChecks(c, a, cat, { from, to }) {
  const pol = await policyAt(a.body_id, 'affiliation', { sportId: cat.sport_id, category: cat.name, seasonYear: a.season_year, date: today() }, c);
  const p = paramsOf('affiliation', pol);
  const org = (await c.query('SELECT status FROM organisations WHERE id=$1', [a.organisation_id])).rows[0];
  const missing = await missingDocuments(c, 'affiliation', a.id, p.required_documents);
  const teams = p.min_teams ? (await c.query("SELECT count(*)::int AS n FROM teams WHERE organisation_id=$1", [a.organisation_id])).rows[0].n : null;
  const overlap = (await c.query("SELECT affiliation_no FROM fed_affiliations WHERE body_id=$1 AND organisation_id=$2 AND id<>$3 AND status IN ('approved','suspended') AND effective_from <= $5 AND effective_to >= $4", [a.body_id, a.organisation_id, a.id, from, to])).rows[0];
  const checks = [
    check('organisation', 'The organisation is active', org?.status === 'active', org?.status === 'active' ? null : 'The organisation is archived'),
    check('documents', 'Required documents are attached', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : (p.required_documents.length ? `${p.required_documents.length} attached` : 'None required')),
    ...(p.min_teams ? [check('teams', `At least ${p.min_teams} team(s) in the organisation`, teams >= p.min_teams, `${teams} team(s)`)] : []),
    check('fee', 'Fee settled', ['none', 'paid', 'waived'].includes(a.fee_status), a.fee_status === 'due' ? 'The fee is still due' : null),
    check('overlap', 'No other affiliation in force for these dates', !overlap, overlap ? `${overlap.affiliation_no} already covers part of this period` : null),
  ];
  return { checks, policy: pol };
}

const ACTIONS = {
  // from -> staff actions, and from -> actions for the applicant
  staff: { submitted: ['start_review', 'request_info', 'approve', 'reject'], under_review: ['request_info', 'approve', 'reject'], needs_info: ['reject'], approved: ['suspend'], suspended: ['reinstate'] },
  party: { draft: ['submit', 'withdraw'], needs_info: ['submit', 'withdraw'], submitted: ['withdraw'], under_review: ['withdraw'], approved: ['withdraw', 'renew'], suspended: ['withdraw'], expired: ['renew'] },
};
const allowedFor = (s, status) => [...(staffCan(s, 'affiliations') ? ACTIONS.staff[status] ?? [] : []), ...(s.party ? ACTIONS.party[status] ?? [] : []), ...(staffCan(s, 'affiliations') && ['submitted', 'under_review', 'needs_info', 'approved', 'suspended'].includes(status) ? ['record_fee'] : [])];

async function detail(user, s, c = pool) {
  const row = await affiliationRow(s.row.id, c);
  const cat = (await c.query('SELECT * FROM fed_affiliation_categories WHERE id=$1', [s.row.category_id])).rows[0];
  const pol = await policyAt(s.row.body_id, 'affiliation', { sportId: cat.sport_id, category: cat.name, seasonYear: s.row.season_year }, c);
  return {
    ...row, as: { party: s.party, staff: !!s.auth && !s.auth.viaAncestor }, actions: allowedFor(s, row.status),
    requirements: pol ? { policy_title: pol.title, version: pol.version, effective_from: pol.effective_from, inherited: pol.inherited, ...paramsOf('affiliation', pol) } : null,
    evidence: await evidenceList('affiliation', s.row.id, c), history: await historyOf('affiliation', s.row.id, c),
    decided_checks: s.row.checks, ...(staffCan(s, 'affiliations') && ['submitted', 'under_review'].includes(row.status) ? { preview: (await affiliationChecks(c, s.row, cat, defaultDates(s.row, cat, null))).checks } : {}),
  };
}
/** Default effective dates: from today (or the season start, if later), continuing straight on from a renewed affiliation that is still running. */
function defaultDates(a, cat, prev) {
  let from = today();
  if (`${a.season_year}-01-01` > from) from = `${a.season_year}-01-01`;
  if (prev?.effective_to && prev.effective_to >= today()) { const d = new Date(`${String(prev.effective_to).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); const nxt = d.toISOString().slice(0, 10); if (nxt > from) from = nxt; }
  return { from, to: addMonths(from, cat.duration_months) };
}
const ds = (d) => dateStr(d);

async function tellApplicant(c, a, kind, title, body) {
  const org = (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [a.organisation_id])).rows;
  for (const m of org) await notify(c, m.user_id, { kind, title, body, data: { affiliation_id: a.id }, dedupe_key: `${kind}:${a.id}:${a.row_version}:${m.user_id}` });
}

// ------------------------------------------------------------------ apply / submit / withdraw / renew
cap({
  name: 'apply_affiliation', method: 'POST', path: '/federation/affiliations', tag: TAG, status: 201,
  summary: 'Start an affiliation application for an organisation you own or administer. Pick the body and one of its categories and the season; attach the required documents, then submit. Nothing about the organisation, its members or its teams changes.',
  input: z.object({ body_id: id, organisation_id: id, category_id: id, season_year: year, jurisdiction_id: id.optional().describe('the region, state or district of the body the club belongs to'), note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    const org = await mustRunOrg(user, i.organisation_id, c);
    const body = await lockBody(c, i.body_id);
    const full = await bodyById(body.id, c);
    mustBeActive(full);
    if (full.organisation_id === org.id) throw badRequest('A body cannot affiliate to itself');
    const cat = (await c.query('SELECT * FROM fed_affiliation_categories WHERE id=$1 AND body_id=$2 AND archived_at IS NULL', [i.category_id, i.body_id])).rows[0];
    if (!cat) throw notFound('Category');
    const kindOk = { club: ['club', 'other', 'company'], academy: ['academy'], school: ['school', 'college', 'university'], league: ['other', 'club', 'company', 'federation'], other: KINDS.concat(['company', 'college', 'university', 'federation']) }[cat.applicant_kind];
    if (!kindOk.includes(org.kind)) throw badRequest(`This category is for ${cat.applicant_kind === 'other' ? 'any organisation' : `a ${cat.applicant_kind}`}; yours is a ${org.kind}`);
    let a;
    try {
      a = (await c.query(
        `INSERT INTO fed_affiliations(body_id, organisation_id, category_id, season_year, applicant_id, fee_minor, fee_currency, note, jurisdiction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.body_id, i.organisation_id, i.category_id, i.season_year, user.id, cat.fee_minor, cat.currency, i.note || null, await mustBeJurisdictionOf(c, i.body_id, i.jurisdiction_id)])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('This organisation already has an open or current affiliation with this body for that season'); throw e; }
    await logFed(c, i.body_id, 'affiliation', a.id, 'created', { to: 'draft', actor: user.id });
    return affiliationRow(a.id, c);
  }),
});

cap({
  name: 'submit_affiliation', method: 'POST', path: '/federation/affiliations/:id/submit', tag: TAG,
  summary: 'Send the application to the body once the required documents are attached. The fee, if any, becomes due.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the organisation\'s owners and admins submit its application');
    if (!['draft', 'needs_info'].includes(s.row.status)) throw conflict(`This application is ${s.row.status}`);
    const body = await bodyById(s.row.body_id, c);
    mustBeActive(body);
    const cat = (await c.query('SELECT * FROM fed_affiliation_categories WHERE id=$1', [s.row.category_id])).rows[0];
    const p = paramsOf('affiliation', await policyAt(s.row.body_id, 'affiliation', { sportId: cat.sport_id, category: cat.name, seasonYear: s.row.season_year }, c));
    const missing = await missingDocuments(c, 'affiliation', s.row.id, p.required_documents);
    if (missing.length) throw conflict(`Attach the required documents first: ${missing.join(', ')}`, { code: 'documents_missing', missing });
    const feeStatus = s.row.fee_minor > 0 && s.row.fee_status === 'none' ? 'due' : s.row.fee_status;
    await c.query("UPDATE fed_affiliations SET status='submitted', fee_status=$2, submitted_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [s.row.id, feeStatus]);
    await logFed(c, s.row.body_id, 'affiliation', s.row.id, 'submitted', { from: s.row.status, to: 'submitted', actor: user.id });
    for (const uid of await staffRecipients(c, body, ['registrar'])) await notify(c, uid, { kind: 'federation_affiliation_submitted', title: 'New affiliation application', body: `An organisation applied to affiliate with ${body.abbreviation}.`, data: { affiliation_id: s.row.id, body_id: body.id }, dedupe_key: `fed-aff-sub:${s.row.id}:${s.row.row_version}:${uid}` });
    return affiliationRow(s.row.id, c);
  }),
});

cap({
  name: 'withdraw_affiliation', method: 'POST', path: '/federation/affiliations/:id/withdraw', tag: TAG,
  summary: 'Withdraw an application, or give up an affiliation you hold. The record and its history stay.',
  input: z.object({ id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the organisation\'s owners and admins withdraw');
    if (!(ACTIONS.party[s.row.status] ?? []).includes('withdraw')) throw conflict(`This affiliation is ${s.row.status}`);
    await c.query("UPDATE fed_affiliations SET status='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1", [s.row.id]);
    await logFed(c, s.row.body_id, 'affiliation', s.row.id, 'withdrawn', { from: s.row.status, to: 'withdrawn', actor: user.id, reason: i.reason });
    return affiliationRow(s.row.id, c);
  }),
});

cap({
  name: 'renew_affiliation', method: 'POST', path: '/federation/affiliations/:id/renew', tag: TAG, status: 201,
  summary: 'Start the next season\'s application from an approved or expired affiliation. A new application is created pointing at the old one (which is kept as it was); documents on file can be carried over.',
  input: z.object({ id, season_year: year.optional(), carry_over_documents: z.boolean().default(true) }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the organisation\'s owners and admins renew');
    const cur = (await c.query(`SELECT ${AFF_STATUS('a')} AS eff FROM fed_affiliations a WHERE a.id=$1`, [s.row.id])).rows[0].eff;
    if (!['approved', 'expired'].includes(cur)) throw conflict(`Only an approved or expired affiliation can be renewed; this one is ${cur}`);
    await mustRunOrg(user, s.row.organisation_id, c);
    mustBeActive(await bodyById(s.row.body_id, c));
    const cat = (await c.query('SELECT * FROM fed_affiliation_categories WHERE id=$1', [s.row.category_id])).rows[0];
    if (cat.archived_at) throw conflict('That category has been retired; apply again under a current category');
    if ((await c.query('SELECT 1 FROM fed_affiliations WHERE previous_id=$1', [s.row.id])).rowCount) throw conflict('This affiliation has already been renewed');
    const season = i.season_year ?? s.row.season_year + 1;
    let n;
    try {
      n = (await c.query('INSERT INTO fed_affiliations(body_id, organisation_id, category_id, season_year, applicant_id, previous_id, fee_minor, fee_currency, jurisdiction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [s.row.body_id, s.row.organisation_id, s.row.category_id, season, user.id, s.row.id, cat.fee_minor, cat.currency, s.row.jurisdiction_id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already an application for that season'); throw e; }
    if (i.carry_over_documents) {
      await c.query(`INSERT INTO fed_evidence(body_id, subject_type, subject_id, requirement, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by)
                     SELECT body_id, subject_type, $2, requirement, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, $3 FROM fed_evidence WHERE subject_type='affiliation' AND subject_id=$1 AND removed_at IS NULL`, [s.row.id, n.id, user.id]);
    }
    await logFed(c, s.row.body_id, 'affiliation', n.id, 'created', { to: 'draft', actor: user.id, detail: { renews: s.row.id } });
    await logFed(c, s.row.body_id, 'affiliation', s.row.id, 'renewal_started', { actor: user.id, detail: { renewal_id: n.id } });
    return affiliationRow(n.id, c);
  }),
});

// ------------------------------------------------------------------ decisions
cap({
  name: 'decide_affiliation', method: 'POST', path: '/federation/affiliations/:id/decision', tag: TAG,
  summary: 'Move an application along (registrar/admin): start_review, request_info (back to the club), approve, reject, suspend or reinstate. Approval runs the body\'s published requirements; if one fails, approval needs an `override_reason`, which is recorded as a compliance exception. Each decision stores the policy version it was made under. Pass `version` (the row_version you saw) to refuse a decision on a record that has since changed.',
  input: z.object({ id, action: z.enum(['start_review', 'request_info', 'approve', 'reject', 'suspend', 'reinstate']), reason: text(500).optional(), effective_from: day.optional(), effective_to: day.optional(), override_reason: text(500).min(5).optional(), version: z.number().int().min(1).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true });
    needStaff(s, 'affiliations');
    const a = s.row;
    if (i.version && i.version !== a.row_version) throw conflict('This application changed since you opened it; reload and decide again', { code: 'stale_version' });
    const body = await bodyById(a.body_id, c);
    if (!(ACTIONS.staff[a.status] ?? []).includes(i.action)) throw conflict(`You cannot ${i.action.replace('_', ' ')} an application that is ${a.status}`);
    if (['request_info', 'reject', 'suspend'].includes(i.action) && !i.reason?.trim()) throw badRequest('Give a reason; the applicant is shown it');
    const cat = (await c.query('SELECT * FROM fed_affiliation_categories WHERE id=$1', [a.category_id])).rows[0];
    let patch = {}, to;
    if (i.action === 'start_review') to = 'under_review';
    else if (i.action === 'request_info') to = 'needs_info';
    else if (i.action === 'reject') { to = 'rejected'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'suspend') { to = 'suspended'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'reinstate') {
      if (a.effective_to < today()) throw conflict('This affiliation has already run out; the club needs to renew');
      to = 'approved'; patch = { decision_reason: i.reason ?? null };
    } else {
      mustBeActive(body);
      const prev = a.previous_id ? (await c.query('SELECT effective_to::text AS effective_to FROM fed_affiliations WHERE id=$1', [a.previous_id])).rows[0] : null;
      const def = defaultDates(a, cat, prev);
      const from = i.effective_from ?? def.from, toD = i.effective_to ?? addMonths(from, cat.duration_months);
      if (toD < from) throw badRequest('The end date is before the start date');
      const { checks, policy } = await affiliationChecks(c, a, cat, { from, to: toD });
      const fails = blocking(checks);
      if (fails.length && !i.override_reason) throw conflict(`Not all requirements are met: ${fails.map((x) => x.label).join('; ')}. Fix them, or approve with an override reason.`, { code: 'requirements_not_met', checks });
      const no = a.affiliation_no ?? await nextNumber(c, a.body_id, 'affiliation', a.season_year);
      to = 'approved';
      patch = { affiliation_no: no, effective_from: from, effective_to: toD, checks: JSON.stringify(checks), policy_version_id: policy?.version_id ?? null, override_reason: fails.length ? i.override_reason : null, decision_reason: i.reason ?? null };
    }
    const sets = Object.keys(patch);
    await c.query(`UPDATE fed_affiliations SET status=$2, decided_by=$3, decided_at=now(), row_version=row_version+1, updated_at=now()${sets.map((k, n) => `, ${k}=$${n + 4}`).join('')} WHERE id=$1`, [a.id, to, user.id, ...sets.map((k) => patch[k])]);
    if (patch.override_reason) await openException(c, a.body_id, 'affiliation', a.id, patch.override_reason, patch.checks, user.id);
    await logFed(c, a.body_id, 'affiliation', a.id, i.action, { from: a.status, to, actor: user.id, reason: i.reason ?? patch.override_reason, detail: { ...(patch.override_reason ? { override_reason: patch.override_reason } : {}), ...(patch.effective_from ? { effective_from: ds(patch.effective_from), effective_to: ds(patch.effective_to), affiliation_no: patch.affiliation_no } : {}), ...(patch.policy_version_id ? { policy_version_id: patch.policy_version_id } : {}) } });
    const updated = await affiliationRow(a.id, c);
    const msg = { start_review: ['Application under review', 'The body has started reviewing your affiliation application.'], request_info: ['More information needed', i.reason], approve: ['Affiliation approved', `Your affiliation ${patch.affiliation_no ?? ''} is approved.`],
      reject: ['Affiliation not approved', i.reason], suspend: ['Affiliation suspended', i.reason], reinstate: ['Affiliation reinstated', 'Your affiliation is active again.'] }[i.action];
    await tellApplicant(c, updated, `federation_affiliation_${i.action}`, msg[0], msg[1] ?? '');
    await audit(c, user.id, `federation_affiliation_${i.action}`, 'fed_affiliations', a.id);
    return updated;
  }),
});

cap({
  name: 'record_affiliation_fee', method: 'POST', path: '/federation/affiliations/:id/fee', tag: TAG,
  summary: 'Record that the affiliation fee was paid (with the date and your reference) or waived (registrar/admin). Recording a payment does not move money: it notes what the club paid the body outside the platform.',
  input: z.object({ id, status: z.enum(['paid', 'waived']), paid_on: day.optional(), reference: text(120).optional(), reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true });
    needStaff(s, 'affiliations');
    if (s.row.fee_status !== 'due') throw conflict(s.row.fee_status === 'none' ? 'There is no fee on this affiliation' : `The fee is already ${s.row.fee_status}`);
    if (i.status === 'waived' && !i.reason?.trim()) throw badRequest('Say why the fee is waived');
    await c.query('UPDATE fed_affiliations SET fee_status=$2, fee_paid_on=$3, fee_reference_enc=$4, fee_recorded_by=$5, row_version=row_version+1, updated_at=now() WHERE id=$1',
      [s.row.id, i.status, i.status === 'paid' ? i.paid_on ?? today() : null, i.reference ? encrypt(i.reference, 'fed_affiliations.fee_reference') : null, user.id]);
    await logFed(c, s.row.body_id, 'affiliation', s.row.id, `fee_${i.status}`, { actor: user.id, reason: i.reason, detail: { amount_minor: s.row.fee_minor, currency: s.row.fee_currency } });
    return affiliationRow(s.row.id, c);
  }),
});

// ------------------------------------------------------------------ reads
cap({
  name: 'list_affiliations', method: 'GET', path: '/federation/affiliations', tag: TAG,
  summary: 'Affiliations. As a body\'s staff (or staff of a body above it): pass `body_id`, optionally `include_descendants`, and filter by status, season or name. As a club: pass `organisation_id` for your own. Status is as of today: an approved affiliation past its end date reads as expired.',
  input: z.object({ body_id: id.optional(), organisation_id: id.optional(), status: z.enum(['draft', 'submitted', 'under_review', 'needs_info', 'approved', 'rejected', 'suspended', 'expired', 'withdrawn']).optional(), season_year: year.optional(), expiring_within_days: z.coerce.number().int().min(1).max(365).optional(), q: text(80).optional(), include_descendants: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    if (!i.body_id && !i.organisation_id) throw badRequest('Give body_id or organisation_id');
    const okOrg = i.organisation_id ? ['owner', 'admin'].includes(await orgRole(user, i.organisation_id)) : false;
    const auth = i.body_id ? await authority(user, i.body_id, { optional: true }) : null;
    if (!okOrg && !auth) throw notFound(i.body_id ? 'Governing body' : 'Organisation');
    if (i.body_id && !auth && !i.organisation_id) throw notFound('Governing body');
    const scope = auth ? jurisdictionScope(auth) : null;     // a role limited to some jurisdictions sees only those, in this body
    const bodyIds = i.body_id ? (i.include_descendants && !scope ? await subtree(i.body_id) : [i.body_id]) : null;
    const total = await one(`SELECT count(*)::int AS n FROM ${AFF_FROM} WHERE ${FILTER}`, args(i, bodyIds, okOrg, scope));
    const items = await many(`SELECT ${AFF_COLS} FROM ${AFF_FROM} WHERE ${FILTER} ORDER BY (a.status IN ('submitted','under_review')) DESC, a.submitted_at DESC NULLS LAST, a.created_at DESC, a.id LIMIT $9 OFFSET $10`, [...args(i, bodyIds, okOrg, scope), i.limit, i.offset]);
    return { total: total.n, items };
  },
});
const FILTER = `($1::uuid[] IS NULL OR a.body_id = ANY($1)) AND ($2::uuid IS NULL OR a.organisation_id=$2) AND ($3::text IS NULL OR (${AFF_STATUS('a')})=$3) AND ($4::int IS NULL OR a.season_year=$4)
  AND ($5::text IS NULL OR o.name ILIKE '%'||$5||'%' OR a.affiliation_no ILIKE '%'||$5||'%') AND ($6::int IS NULL OR (a.status='approved' AND a.effective_to BETWEEN current_date AND current_date + $6::int))
  AND ($7::boolean OR a.status <> 'draft') AND ($8::uuid[] IS NULL OR a.jurisdiction_id = ANY($8))`;
const args = (i, bodyIds, withDrafts, scope) => [bodyIds, i.organisation_id ?? null, i.status ?? null, i.season_year ?? null, i.q || null, i.expiring_within_days ?? null, withDrafts, scope ?? null];

cap({
  name: 'get_affiliation', method: 'GET', path: '/federation/affiliations/:id', tag: TAG,
  summary: 'One affiliation with its requirements, evidence list (metadata only), decision history and the actions you may take (the body\'s staff and the applying organisation\'s owners/admins).',
  input: z.object({ id }),
  async handler({ user }, i) { return detail(user, await subjectFor(user, 'affiliation', i.id)); },
});

cap({
  name: 'add_affiliation_evidence', method: 'POST', path: '/federation/affiliations/:id/evidence', tag: TAG, status: 201,
  summary: 'Attach a document or reference to an application that is a draft or waiting for more information. Files and references are encrypted; only metadata is ever listed.',
  input: z.object({ id }).and(evidenceIn),
  handler: ({ user }, i) => tx(async (c) => { const s = await subjectFor(user, 'affiliation', i.id, { c, lock: true }); const { id: _id, ...e } = i; return addEvidence(c, s, user, e); }),
});
cap({
  name: 'read_affiliation_evidence', method: 'GET', path: '/federation/affiliations/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Read one evidence item in full (the applicant, or the body\'s registrar/compliance/admin). Every read is audit-logged.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => readEvidence(c, await subjectFor(user, 'affiliation', i.id, { c }), user, i.evidence_id)),
});
cap({
  name: 'remove_affiliation_evidence', method: 'DELETE', path: '/federation/affiliations/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Take an item off an application that is still a draft or waiting for information. It is hidden, not erased.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => removeEvidence(c, await subjectFor(user, 'affiliation', i.id, { c, lock: true }), i.evidence_id)),
});

cap({
  name: 'list_affiliated_organisations', method: 'GET', path: '/federation/bodies/:id/affiliated', tag: TAG, auth: 'public',
  summary: 'The public register: organisations holding an approved, in-date affiliation with a body (and, optionally, with the bodies recognised under it). Name, kind, city, number and validity only.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(false), q: text(80).optional(), ...page }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    return many(
      `SELECT a.id, o.id AS organisation_id, o.name, o.kind, o.city, a.affiliation_no, c.name AS category_name, s.name AS sport_name, a.season_year, a.effective_from::text AS effective_from, a.effective_to::text AS effective_to, bo.name AS body_name
         FROM ${AFF_FROM} WHERE a.body_id = ANY($1) AND a.status='approved' AND current_date BETWEEN a.effective_from AND a.effective_to AND o.status='active' AND ($2::text IS NULL OR o.name ILIKE '%'||$2||'%')
        ORDER BY o.name, a.id LIMIT $3 OFFSET $4`, [ids, i.q || null, i.limit, i.offset]);
  },
});
