// Sponsorship eligibility screening and application validation (#287). Extends the program/application stack (#284-#289); it does not
// create a parallel workflow: rules are versions of the program's own eligibility, missing-information requests reuse the correction flow
// of the application forms (#286), duplicate flags and exceptions are recorded next to the application, and the award gate (#289) reads
// the screening. Reasons are plain language; missing data is reported as missing, never guessed. Nothing is deleted.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { decrypt, encrypt } from '../crypto.js';
import { assertSponsorCan, sponsorAccess } from '../sponsor-access.js';
import { aliasOf, isBlind } from '../sponsorship-evaluation.js';
import { fieldsOf } from '../application-forms.js';
import { roundState } from '../sponsorship-calls.js';
import { appendRules, currentRules, evaluateEligibility, gatherFacts, liveException, rulesOfProgram, screenApplication } from '../sponsorship-screening.js';
import { checkVersion, programFor, targetOwnerOf } from './sponsorship-programs.js';
import { returnForCorrection } from './sponsorship-application-forms.js';

const TAG = 'Sponsors';
const TARGETS = ['event', 'team', 'athlete'];
const REASON = 'sponsorship_screening_exceptions.reason_enc';
const doc = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'lowercase letters, digits and _'), label: z.string().min(2).max(120) });

async function mustFindSports(list) {
  if (!list?.length) return;
  const found = await many('SELECT slug FROM sports WHERE slug = ANY($1)', [list]);
  const missing = list.filter((s) => !found.some((f) => f.slug === s));
  if (missing.length) throw badRequest(`Unknown sport(s): ${missing.join(', ')}`);
}

// ---------------------------------------------------------------- rules (versioned)

cap({
  name: 'publish_eligibility_rules', method: 'POST', path: '/sponsorship-programs/:id/eligibility', tag: TAG, status: 201,
  summary: 'Brand manager/approver: publish a new version of a program\'s eligibility rules (funded target types, sports, regions, verified-only, maximum award, required documents and whether duplicates are flagged). Needs the program\'s current `version` (409 if it changed). Versions are immutable and numbered; every screening keeps the version it was judged under, so a rule change never rewrites an earlier decision, and it applies to new screenings only. The program\'s own eligibility fields are kept in step.',
  input: z.object({
    id, version: z.coerce.number().int().positive().describe('the program version you looked at'),
    target_types: z.array(z.enum(TARGETS)).min(1).max(3), sports: z.array(z.string().min(1).max(60)).max(30).default([]), regions: z.array(z.string().min(1).max(80)).max(30).default([]),
    verified_only: z.boolean().default(false), max_award_cents: money.min(1).nullable().default(null), duplicate_check: z.boolean().default(true),
    required_documents: z.array(doc).max(12).default([]), note: z.string().max(300).optional(),
  }),
  async handler({ user }, i) {
    await mustFindSports(i.sports);
    if (new Set(i.required_documents.map((d) => d.key)).size !== i.required_documents.length) throw badRequest('Each required document needs its own key');
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      checkVersion(p, i.version, 'program');
      if (!['draft', 'published'].includes(p.status)) throw conflict(`A ${p.status} program cannot be edited`);
      if (i.max_award_cents && p.budget_cents && i.max_award_cents > Number(p.budget_cents)) throw badRequest('The maximum award cannot exceed the budget');
      const row = (await c.query(
        `UPDATE sponsorship_programs SET sports=$2, regions=$3, eligibility=$4, max_award_cents=$5, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [p.id, i.sports, i.regions, { ...p.eligibility, target_types: i.target_types, verified_only: i.verified_only }, i.max_award_cents])).rows[0];
      const rules = rulesOfProgram(row, { duplicate_check: i.duplicate_check, required_documents: i.required_documents });
      const before = (await c.query('SELECT version FROM sponsorship_eligibility_versions WHERE program_id=$1 ORDER BY version DESC LIMIT 1', [p.id])).rows[0]?.version ?? 0;
      const version = await appendRules(c, p.id, rules, user.id, i.note ?? null);
      await audit(c, user.id, 'publish_eligibility', 'sponsorship_programs', p.id);
      return { program_version: row.row_version, eligibility_version: version, changed: version !== before, rules };
    });
  },
});

cap({
  name: 'list_eligibility_versions', method: 'GET', path: '/sponsorship-programs/:id/eligibility', tag: TAG,
  summary: 'Brand staff of the program: every version of its eligibility rules, newest first, with who published it and how many applications were screened under each. Deterministic order and pagination.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { p } = await programFor(user, i.id, 'evaluation', pool);
    const items = await many(
      `SELECT v.version, v.rules, v.sha256, v.note, v.created_at, v.created_by,
              (SELECT count(*)::int FROM sponsorship_screenings s WHERE s.program_id=v.program_id AND s.rules_version=v.version) AS screenings
         FROM sponsorship_eligibility_versions v WHERE v.program_id=$1 ORDER BY v.version DESC LIMIT $2 OFFSET $3`, [p.id, i.limit, i.offset]);
    return { current_version: p.eligibility_version, program_version: p.row_version, items };
  },
});

// ---------------------------------------------------------------- applicant pre-check

cap({
  name: 'preview_eligibility', method: 'POST', path: '/program-rounds/:id/eligibility-check', tag: TAG,
  summary: 'Applicant: before applying, see in plain language whether something you own meets the round\'s program rules, which rules are met, not met or cannot be checked yet, and what is missing (including required documents to upload). Read-only: it files nothing, and it never guesses a fact the platform does not hold - that shows as missing. Only the owner of the target can ask (anyone else, and anyone not invited to a private call, gets 404).',
  input: z.object({ id, target_type: z.enum(TARGETS), target_id: id, requested_cents: money.min(1).optional() }),
  async handler({ user }, i) {
    const r = (await pool.query('SELECT * FROM sponsorship_rounds WHERE id=$1', [i.id])).rows[0];
    const p = r && (await pool.query('SELECT * FROM sponsorship_programs WHERE id=$1', [r.program_id])).rows[0];
    if (!p || p.status !== 'published') throw notFound('Round');
    if (p.visibility === 'invitation_only') {
      const inv = (await pool.query("SELECT 1 FROM sponsorship_invitations WHERE program_id=$1 AND target_type=$2 AND target_id=$3 AND invitee_user_id=$4 AND status IN ('invited','viewed','applied')", [p.id, i.target_type, i.target_id, user.id])).rows[0];
      if (!inv) throw notFound('Round');
    }
    if ((await targetOwnerOf(pool, i.target_type, i.target_id)) !== user.id) throw notFound(i.target_type);
    const sp = (await pool.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
    if (!isAdmin(user) && (await sponsorAccess(user, sp, pool))) throw forbidden('Staff of the sponsoring brand cannot apply to its own program');
    const v = await currentRules(pool, p.id);
    const facts = await gatherFacts(pool, { id: null, target_type: i.target_type, target_id: i.target_id, requested_cents: i.requested_cents ?? null });
    const result = evaluateEligibility(v.rules, facts);
    return { rules_version: v.version, round_open: (await pool.query(`SELECT ${roundState('r')} AS s FROM sponsorship_rounds r WHERE id=$1`, [r.id])).rows[0].s === 'open', ...result };
  },
});

// ---------------------------------------------------------------- screening of an application

/** Who may see this application's screening: its applicant, or brand staff of the program once it was submitted. Others get 404. */
async function screeningAccess(c, user, applicationId, { lock = false } = {}) {
  const a = (await c.query(`SELECT * FROM sponsorship_applications WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [applicationId])).rows[0];
  if (!a) throw notFound('Application');
  if (a.applicant_id === user.id) return { a, side: 'applicant' };
  if (a.status === 'draft') throw notFound('Application');
  const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1', [a.program_id])).rows[0];
  const sp = (await c.query('SELECT * FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
  if (isAdmin(user) || (await sponsorAccess(user, sp, c))) return { a, side: 'staff', p, sp };
  throw notFound('Application');
}

async function viewOf(c, user, a, side) {
  const rows = (await c.query('SELECT * FROM sponsorship_screenings WHERE application_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [a.id])).rows;
  const blind = side === 'staff' && (await isBlind(c, a));
  const shape = (s) => ({
    id: s.id, rules_version: s.rules_version, outcome: s.outcome, trigger: s.trigger, created_at: s.created_at, reasons: s.reasons, missing: s.missing,
    // an applicant sees that a possible duplicate was noticed, not which other applications; blind staff see aliases, not identities
    duplicate_flags: side === 'applicant' ? s.duplicate_flags.map((f) => ({ kind: f.kind, note: f.note })) : s.duplicate_flags.map((f) => ({ ...f, application_id: blind ? aliasOf(f.application_id) : f.application_id })),
  });
  const ex = await liveException(c, a.id);
  let exception = null;
  if (ex) {
    exception = { id: ex.id, granted_at: ex.created_at, expires_at: ex.expires_at, authority_role: ex.authority_role };
    if (side === 'staff') { exception.reason = decrypt(ex.reason_enc, REASON); await audit(c, user.id, 'read_pii', 'sponsorship_screening_exceptions', ex.id); }
  }
  return { application_id: a.id, status: a.status, version: a.screening_version, outcome: a.screening_outcome, screened: rows.length > 0, latest: rows[0] ? shape(rows[0]) : null, history: rows.slice(1).map(shape), exception, anonymized: blind };
}

cap({
  name: 'get_application_screening', method: 'GET', path: '/program-applications/:id/screening', tag: TAG,
  summary: 'The applicant, or brand staff of the program once it is submitted: the latest eligibility screening (outcome, plain-language reasons met / not met / not yet known, what is missing, possible duplicates) plus earlier runs under the rule versions they were judged by, and any live exception. The applicant never sees who else applied or the exception reason; staff reading the exception reason are audit-logged; in a blind-scored round staff see aliases, not identities. `version` is what to send when granting an exception. Anyone else gets 404. An application filed before screening existed shows `screened: false` rather than an invented result.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { a, side } = await screeningAccess(pool, user, i.id);
    return viewOf(pool, user, a, side);
  },
});

cap({
  name: 'screen_application', method: 'POST', path: '/program-applications/:id/screen', tag: TAG,
  summary: 'Brand manager/approver: run the eligibility screening again on a submitted or returned application, under the program\'s current rules (or a named earlier `rules_version`). It adds a new screening run and leaves the earlier ones untouched. Needs the screening `version` you last saw (409 if someone screened or changed it since).',
  input: z.object({ id, version: z.coerce.number().int().min(0), rules_version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a, side } = await screeningAccess(c, user, i.id, { lock: true });
      if (side !== 'staff') throw notFound('Application');
      await programFor(user, a.program_id, 'program', c);
      if (!['submitted', 'returned'].includes(a.status)) throw conflict(`Only a submitted or returned application can be screened (this one is ${a.status})`);
      if (a.screening_version !== i.version) throw conflict('This screening was changed by someone else; the latest was loaded, review it and try again', { current_version: a.screening_version });
      if (i.rules_version) {
        const ok = (await c.query('SELECT 1 FROM sponsorship_eligibility_versions WHERE program_id=$1 AND version=$2', [a.program_id, i.rules_version])).rowCount;
        if (!ok) throw notFound('Rules version');
      }
      await screenApplication(c, a, { trigger: 'manual', userId: user.id, rulesVersion: i.rules_version ?? null });
      await audit(c, user.id, 'screen', 'sponsorship_applications', a.id);
      return viewOf(c, user, (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1', [a.id])).rows[0], 'staff');
    });
  },
});

// ---------------------------------------------------------------- missing information

cap({
  name: 'request_missing_information', method: 'POST', path: '/program-applications/:id/request-information', tag: TAG,
  summary: 'Brand manager/approver: ask the applicant for what the latest screening found missing. Items that are questions or document uploads of the application form send the application back for exactly those fields (the same controlled correction as request_application_correction); items the applicant must fix elsewhere (e.g. a sport on their profile or a verification badge) are sent as a notification with your message. Nothing is assumed to be supplied. Needs the screening `version` (409 if stale).',
  input: z.object({ id, version: z.coerce.number().int().min(0), message: z.string().min(1).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a, side } = await screeningAccess(c, user, i.id, { lock: true });
      if (side !== 'staff') throw notFound('Application');
      await programFor(user, a.program_id, 'program', c);
      if (a.screening_version !== i.version) throw conflict('This screening was changed by someone else; the latest was loaded, review it and try again', { current_version: a.screening_version });
      const s = a.screening_id && (await c.query('SELECT * FROM sponsorship_screenings WHERE id=$1', [a.screening_id])).rows[0];
      if (!s || !s.missing.length) throw conflict('The latest screening found nothing missing');
      const formKeys = new Set();
      if (a.form_id) {
        const def = (await c.query('SELECT definition FROM sponsorship_form_versions WHERE form_id=$1 AND version=$2', [a.form_id, a.form_version])).rows[0]?.definition;
        for (const f of def ? fieldsOf(def) : []) formKeys.add(f.key);
        formKeys.add('requested_cents');
      }
      const fields = s.missing.filter((m) => formKeys.has(m.key)).map((m) => m.key);
      const labels = s.missing.map((m) => m.label).join(', ');
      if (fields.length && a.status === 'submitted') await returnForCorrection(user, { id: a.id, reason: `${i.message} (missing: ${labels})`.slice(0, 1000), fields }, c);
      else await notify(c, a.applicant_id, { kind: 'sponsorship_program', title: 'More information needed', body: `${a.receipt_no ?? 'Your application'}: ${i.message} (missing: ${labels})`.slice(0, 300), data: { application_id: a.id } });
      await c.query('UPDATE sponsorship_applications SET screening_version=screening_version+1 WHERE id=$1', [a.id]);
      await c.query("INSERT INTO sponsorship_screening_events(application_id, kind, actor_id, data) VALUES ($1,'info_requested',$2,$3)", [a.id, user.id, { screening_id: s.id, fields, items: s.missing.map((m) => m.key) }]);
      await audit(c, user.id, 'request_information', 'sponsorship_applications', a.id);
      return viewOf(c, user, (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1', [a.id])).rows[0], 'staff');
    });
  },
});

// ---------------------------------------------------------------- manual exceptions

cap({
  name: 'grant_screening_exception', method: 'POST', path: '/program-applications/:id/screening-exception', tag: TAG, status: 201,
  summary: 'Brand manager/approver only: record a manual exception so an application that did not pass screening (needs information or ineligible) can still be awarded. A reason of at least 20 characters is mandatory (stored encrypted, read only by brand staff and audit-logged), it may expire, and it is tied to the screening it overrides. Needs the screening `version` (409 if stale). One live exception per application; revoke it to replace it. Granting does not change the screening result, so the history stays honest.',
  input: z.object({ id, version: z.coerce.number().int().min(0), reason: z.string().min(20).max(1000), expires_at: z.string().datetime().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a, side, sp } = await screeningAccess(c, user, i.id, { lock: true });
      if (side !== 'staff') throw notFound('Application');
      const role = isAdmin(user) ? 'admin' : (await sponsorAccess(user, sp, c))?.role;
      if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, sp, c), 'screening_exception', { departmentId: null, what: 'grant eligibility exceptions' });
      if (!['submitted', 'returned'].includes(a.status)) throw conflict(`An exception applies to a submitted or returned application (this one is ${a.status})`);
      if (a.screening_version !== i.version) throw conflict('This screening was changed by someone else; the latest was loaded, review it and try again', { current_version: a.screening_version });
      if (!['needs_info', 'ineligible'].includes(a.screening_outcome ?? '')) throw conflict('Only an application that needs information or is ineligible needs an exception');
      if (i.expires_at && new Date(i.expires_at) <= new Date()) throw badRequest('The exception must expire in the future');
      let ex;
      try {
        ex = (await c.query(
          `INSERT INTO sponsorship_screening_exceptions(application_id, screening_id, granted_by, authority_role, reason_enc, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [a.id, a.screening_id, user.id, role, encrypt(i.reason, REASON), i.expires_at ?? null])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('This application already has a live exception; revoke it first');
        throw e;
      }
      await c.query('UPDATE sponsorship_applications SET screening_version=screening_version+1 WHERE id=$1', [a.id]);
      await c.query("INSERT INTO sponsorship_screening_events(application_id, kind, actor_id, data) VALUES ($1,'exception_granted',$2,$3)", [a.id, user.id, { exception_id: ex.id, screening_id: a.screening_id, authority_role: role, expires_at: i.expires_at ?? null }]);
      await notify(c, a.applicant_id, { kind: 'sponsorship_program', title: 'Your application can proceed', body: `${a.receipt_no ?? 'Your application'} was reviewed and the program has approved an exception to its eligibility rules.`, data: { application_id: a.id } });
      await audit(c, user.id, 'grant_exception', 'sponsorship_applications', a.id);
      return viewOf(c, user, (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1', [a.id])).rows[0], 'staff');
    });
  },
});

cap({
  name: 'revoke_screening_exception', method: 'POST', path: '/program-applications/:id/screening-exception/revoke', tag: TAG,
  summary: 'Brand manager/approver only: withdraw a live eligibility exception (it is marked revoked, never deleted). Needs the screening `version`. Awarding is blocked again if the application still does not pass screening.',
  input: z.object({ id, version: z.coerce.number().int().min(0) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a, side, sp } = await screeningAccess(c, user, i.id, { lock: true });
      if (side !== 'staff') throw notFound('Application');
      if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, sp, c), 'screening_exception', { departmentId: null, what: 'revoke eligibility exceptions' });
      if (a.screening_version !== i.version) throw conflict('This screening was changed by someone else; the latest was loaded, review it and try again', { current_version: a.screening_version });
      const ex = (await c.query('UPDATE sponsorship_screening_exceptions SET revoked_at=now(), revoked_by=$2 WHERE application_id=$1 AND revoked_at IS NULL RETURNING id', [a.id, user.id])).rows[0];
      if (!ex) throw conflict('There is no live exception to revoke');
      await c.query('UPDATE sponsorship_applications SET screening_version=screening_version+1 WHERE id=$1', [a.id]);
      await c.query("INSERT INTO sponsorship_screening_events(application_id, kind, actor_id, data) VALUES ($1,'exception_revoked',$2,$3)", [a.id, user.id, { exception_id: ex.id }]);
      await audit(c, user.id, 'revoke_exception', 'sponsorship_applications', a.id);
      return viewOf(c, user, (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1', [a.id])).rows[0], 'staff');
    });
  },
});
