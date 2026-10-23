// Configurable sponsorship application forms (#286). A program publishes immutable versions of a form, a round is pinned to one
// version, and an application (the #284 `sponsorship_applications` record, extended - not a parallel system) keeps the exact version it
// was filled under, with answers, applicant budget, references, uploads, a submission receipt and a controlled correction trail.
// Confidential answers, budget lines and references are stored encrypted; staff reads of them are audit-logged. Nothing is deleted.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { many, one, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { requireApproved } from '../access.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { sponsorAccess, notifySponsor } from '../sponsor-access.js';
import { formDefinition, fieldsOf, validateApplication, splitConfidential, budgetShape, referencesShape } from '../application-forms.js';
import { assertCanApply, checkVersion, iso, programFor, termsOf } from './sponsorship-programs.js';
import { roundState } from '../sponsorship-calls.js';

const TAG = 'Sponsors';
const TARGETS = ['event', 'team', 'athlete'];
const FILES_PER_APPLICATION = 20;
const key = z.string().min(8).max(80).describe('a unique value per attempt, e.g. a UUID; repeating it returns the same result instead of filing twice');
const CONF = 'sponsorship_applications.confidential_enc', REFS = 'sponsorship_applications.refs_enc', PROFILE = 'sponsorship_applicant_profiles.data_enc';
const seal = (v, ctx) => (v == null ? null : encrypt(JSON.stringify(v), ctx));
const open = (v, ctx) => (v ? JSON.parse(decrypt(v, ctx)) : null);

// ---------------------------------------------------------------- helpers

async function formDefinitionOf(c, formId, version) {
  const v = (await c.query('SELECT form_id, version, definition, sha256, published_at FROM sponsorship_form_versions WHERE form_id=$1 AND version=$2', [formId, version])).rows[0];
  if (!v) throw notFound('Form version');
  return v;
}
const invalid = (issues) => unprocessable('Some answers need attention', issues);
/** node-postgres sends a JS array as a Postgres array, so a jsonb array must be sent as text. */
const jsonb = (v) => (v == null ? null : JSON.stringify(v));
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Who the caller is for an application: its applicant, brand staff of the program (not for drafts), or an admin. Anyone else gets 404. */
async function applicationFor(c, user, applicationId, { lock = false } = {}) {
  const a = (await c.query(`SELECT * FROM sponsorship_applications WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [applicationId])).rows[0];
  if (!a) throw notFound('Application');
  if (a.applicant_id === user.id) return { a, side: 'applicant' };
  if (a.status === 'draft') throw notFound('Application');
  const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1', [a.program_id])).rows[0];
  const sp = await mustFind('sponsors', p.sponsor_id, '*', c);
  if (isAdmin(user) || (await sponsorAccess(user, sp, c))) return { a, side: 'staff', p, sp };
  throw notFound('Application');
}
const staffOnly = async (c, user, a, action) => (await programFor(user, a.program_id, action, c)).p;

async function fileCounts(c, applicationId) {
  const rows = (await c.query('SELECT field_key, count(*)::int AS n FROM sponsorship_application_files WHERE application_id=$1 AND removed_at IS NULL GROUP BY field_key', [applicationId])).rows;
  return Object.fromEntries(rows.map((r) => [r.field_key, r.n]));
}
const latestRequest = async (c, applicationId) => (await c.query("SELECT fields, note, created_at FROM sponsorship_application_events WHERE application_id=$1 AND kind='correction_requested' ORDER BY created_at DESC, id DESC LIMIT 1", [applicationId])).rows[0];

/** Everything about one application, for its applicant or (once submitted) brand staff. Reading confidential parts as staff is audit-logged. */
async function applicationView(c, user, a, side) {
  const meta = (await c.query(
    `SELECT p.name AS program_name, p.currency AS program_currency, r.seq AS round_seq, r.name AS round_name FROM sponsorship_programs p JOIN sponsorship_rounds r ON r.id=$2 WHERE p.id=$1`, [a.program_id, a.round_id])).rows[0];
  const out = {
    id: a.id, status: a.status, row_version: a.row_version, program_id: a.program_id, round_id: a.round_id, ...meta,
    target_type: a.target_type, target_id: a.target_id, requested_cents: a.requested_cents, currency: a.currency, pitch: a.pitch,
    form_id: a.form_id, form_version: a.form_version, receipt_no: a.receipt_no, submitted_at: a.submitted_at, created_at: a.created_at, updated_at: a.updated_at,
    awarded_cents: a.awarded_cents, decision_reason: a.decision_reason, sponsorship_id: a.sponsorship_id, terms_snapshot: a.terms_snapshot,
  };
  if (a.form_id) {
    const v = await formDefinitionOf(c, a.form_id, a.form_version);
    const secret = open(a.confidential_enc, CONF), refs = open(a.refs_enc, REFS);
    if (side === 'staff' && (secret || refs || a.budget)) await audit(c, user.id, 'read_pii', 'sponsorship_applications', a.id);
    Object.assign(out, {
      form: { definition: v.definition, sha256: v.sha256, published_at: v.published_at },
      answers: { ...a.answers, ...(secret ?? {}) }, budget: a.budget ?? [], references: refs ?? [],
      files: (await c.query('SELECT id, field_key, original_name, content_type, size_bytes, created_at FROM sponsorship_application_files WHERE application_id=$1 AND removed_at IS NULL ORDER BY created_at, id', [a.id])).rows,
      events: (await c.query('SELECT e.kind, e.form_version, e.note, e.fields, e.created_at, u.display_name AS actor FROM sponsorship_application_events e JOIN users u ON u.id=e.actor_id WHERE e.application_id=$1 ORDER BY e.created_at, e.id', [a.id])).rows,
    });
    if (a.status === 'returned') out.correction = await latestRequest(c, a.id);
  }
  return out;
}

// ---------------------------------------------------------------- builder (brand staff)

cap({
  name: 'create_sponsorship_form', method: 'POST', path: '/sponsorship-programs/:id/forms', tag: TAG, status: 201,
  summary: 'Brand manager/approver: create an application form for a program with its first version. A form is sections of questions (text, long text, number, money, date, choice, multi-choice, yes/no, file upload, applicant budget, references); any question can be required, confidential (stored encrypted) or shown only when an earlier answer matches. Pin it to a round with set_round_form.',
  input: z.object({ id, name: z.string().min(2).max(120), definition: formDefinition }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      if (p.status === 'archived') throw conflict('An archived program cannot get new forms');
      const f = (await c.query('INSERT INTO sponsorship_forms(program_id, name, created_by) VALUES ($1,$2,$3) RETURNING *', [p.id, i.name, user.id])).rows[0];
      const v = (await c.query('INSERT INTO sponsorship_form_versions(form_id, version, definition, sha256, published_by) VALUES ($1,1,$2,$3,$4) RETURNING version, definition, sha256, published_at', [f.id, i.definition, sha256(JSON.stringify(i.definition)), user.id])).rows[0];
      await audit(c, user.id, 'create', 'sponsorship_forms', f.id);
      return { ...f, latest_version: 1, ...v };
    });
  },
});

cap({
  name: 'publish_sponsorship_form_version', method: 'POST', path: '/sponsorship-forms/:id/versions', tag: TAG, status: 201,
  summary: 'Brand manager/approver: publish a new version of a form. Versions never change once published; rounds keep the version they are pinned to and every application keeps the version it was filled under. Needs the form\'s current `version` (409 if someone else published first).',
  input: z.object({ id, version: z.number().int().positive(), name: z.string().min(2).max(120).optional(), definition: formDefinition }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM sponsorship_forms WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Form');
      await programFor(user, f.program_id, 'program', c);
      if (f.archived_at) throw conflict('This form is archived');
      checkVersion(f, i.version, 'form');
      const next = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM sponsorship_form_versions WHERE form_id=$1', [f.id])).rows[0].n;
      const v = (await c.query('INSERT INTO sponsorship_form_versions(form_id, version, definition, sha256, published_by) VALUES ($1,$2,$3,$4,$5) RETURNING version, definition, sha256, published_at', [f.id, next, i.definition, sha256(JSON.stringify(i.definition)), user.id])).rows[0];
      const row = (await c.query('UPDATE sponsorship_forms SET row_version=row_version+1, name=coalesce($2,name), updated_at=now() WHERE id=$1 RETURNING *', [f.id, i.name ?? null])).rows[0];
      await audit(c, user.id, 'publish', 'sponsorship_forms', f.id);
      return { ...row, latest_version: next, ...v };
    });
  },
});

cap({
  name: 'archive_sponsorship_form', method: 'POST', path: '/sponsorship-forms/:id/archive', tag: TAG,
  summary: 'Brand manager/approver: retire a form. It stays on record with every version and the applications made under it; it cannot be archived while a round is still pinned to it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM sponsorship_forms WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Form');
      await programFor(user, f.program_id, 'program', c);
      if (f.archived_at) return f;
      if ((await c.query('SELECT 1 FROM sponsorship_rounds WHERE form_id=$1', [f.id])).rowCount) throw conflict('A round still uses this form; pin the round to another form (or none) first');
      await audit(c, user.id, 'archive', 'sponsorship_forms', f.id);
      return (await c.query('UPDATE sponsorship_forms SET archived_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [f.id])).rows[0];
    });
  },
});

cap({
  name: 'list_sponsorship_forms', method: 'GET', path: '/sponsorship-programs/:id/forms', tag: TAG,
  summary: 'Brand staff: the forms of a program with their latest version and the rounds each one is pinned to. Oldest first.',
  input: z.object({ id, include_archived: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const { p } = await programFor(user, i.id, 'read', pool);
    return many(
      `SELECT f.id, f.name, f.row_version, f.archived_at, f.created_at, (SELECT max(version) FROM sponsorship_form_versions v WHERE v.form_id=f.id) AS latest_version,
              (SELECT coalesce(json_agg(json_build_object('round_id', r.id, 'seq', r.seq, 'form_version', r.form_version) ORDER BY r.seq), '[]') FROM sponsorship_rounds r WHERE r.form_id=f.id) AS rounds
         FROM sponsorship_forms f WHERE f.program_id=$1 AND ($2 OR f.archived_at IS NULL) ORDER BY f.created_at, f.id LIMIT $3 OFFSET $4`, [p.id, !!i.include_archived, i.limit, i.offset]);
  },
});

cap({
  name: 'get_sponsorship_form', method: 'GET', path: '/sponsorship-forms/:id', tag: TAG,
  summary: 'Brand staff: one form with the definition of a version (default: the latest) and the list of versions.',
  input: z.object({ id, version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    const f = (await pool.query('SELECT * FROM sponsorship_forms WHERE id=$1', [i.id])).rows[0];
    if (!f) throw notFound('Form');
    await programFor(user, f.program_id, 'read', pool);
    const versions = (await pool.query('SELECT version, sha256, published_at FROM sponsorship_form_versions WHERE form_id=$1 ORDER BY version', [f.id])).rows;
    const v = await formDefinitionOf(pool, f.id, i.version ?? versions.at(-1).version);
    return { ...f, versions, version: v.version, definition: v.definition, sha256: v.sha256 };
  },
});

cap({
  name: 'set_round_form', method: 'POST', path: '/program-rounds/:id/form', tag: TAG,
  summary: 'Brand manager/approver: pin a round to a version of one of the program\'s forms (or to none, which restores the plain pitch + amount application). Applies to new drafts; an applicant who already started keeps their version and is told when the form changed. Needs the round\'s current `version`.',
  input: z.object({ id, version: z.number().int().positive(), form_id: id.nullable(), form_version: z.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT program_id FROM sponsorship_rounds WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Round');
      const { p } = await programFor(user, r0.program_id, 'program', c, true);
      const r = (await c.query('SELECT * FROM sponsorship_rounds WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      checkVersion(r, i.version, 'round');
      let formId = null, formVersion = null;
      if (i.form_id) {
        const f = (await c.query('SELECT * FROM sponsorship_forms WHERE id=$1', [i.form_id])).rows[0];
        if (!f || f.program_id !== p.id) throw badRequest('That form does not belong to this program');
        if (f.archived_at) throw conflict('That form is archived');
        formId = f.id;
        formVersion = i.form_version ?? (await c.query('SELECT max(version) AS v FROM sponsorship_form_versions WHERE form_id=$1', [f.id])).rows[0].v;
        await formDefinitionOf(c, f.id, formVersion);
      }
      const row = (await c.query('UPDATE sponsorship_rounds SET form_id=$2, form_version=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [r.id, formId, formVersion])).rows[0];
      await audit(c, user.id, 'set_form', 'sponsorship_rounds', r.id);
      return row;
    });
  },
});

// ---------------------------------------------------------------- applicant: form, profile, draft, submit

cap({
  name: 'get_round_application_form', method: 'GET', path: '/program-rounds/:id/application-form', tag: TAG,
  summary: 'Applicant: the form a round is pinned to (exact version, so it cannot change under you), the round state, your reusable-profile values for questions that name a profile key, and your own application(s) for this round (draft, submitted or returned) so you can resume. `form` is null for a round that still uses the plain pitch + amount application. Give target_type and target_id to find the application for one target.',
  input: z.object({ id, target_type: z.enum(TARGETS).optional(), target_id: id.optional() }),
  async handler({ user }, i) {
    const r = (await pool.query(`SELECT r.*, ${roundState('r')} AS state FROM sponsorship_rounds r WHERE r.id=$1`, [i.id])).rows[0];
    if (!r) throw notFound('Round');
    const p = (await pool.query('SELECT * FROM sponsorship_programs WHERE id=$1', [r.program_id])).rows[0];
    const staff = isAdmin(user) || (await sponsorAccess(user, await mustFind('sponsors', p.sponsor_id), pool));
    if (p.status !== 'published' && !staff) throw notFound('Round');
    const out = { round: { id: r.id, name: r.name, seq: r.seq, state: r.state, opens_on: iso(r.opens_on), closes_on: iso(r.closes_on), terms_version: r.terms_version, row_version: r.row_version },
      program: { id: p.id, name: p.name, currency: p.currency, max_award_cents: p.max_award_cents }, form: null, profile: {}, applications: [] };
    if (r.form_id) {
      const v = await formDefinitionOf(pool, r.form_id, r.form_version);
      out.form = { id: r.form_id, version: r.form_version, definition: v.definition, sha256: v.sha256 };
      const prof = open((await pool.query('SELECT data_enc FROM sponsorship_applicant_profiles WHERE user_id=$1', [user.id])).rows[0]?.data_enc, PROFILE) ?? {};
      for (const f of fieldsOf(v.definition)) if (f.profile_key && prof[f.profile_key] !== undefined) out.profile[f.key] = prof[f.profile_key];
    }
    const mine = (await pool.query(`SELECT * FROM sponsorship_applications WHERE round_id=$1 AND applicant_id=$2 AND ($3::text IS NULL OR target_type=$3) AND ($4::uuid IS NULL OR target_id=$4) AND status <> 'withdrawn' ORDER BY created_at, id`, [r.id, user.id, i.target_type ?? null, i.target_id ?? null])).rows;
    for (const a of mine) out.applications.push(await applicationView(pool, user, a, 'applicant'));
    return out;
  },
});

cap({
  name: 'get_applicant_profile', method: 'GET', path: '/me/applicant-profile', tag: TAG,
  summary: 'Your reusable applicant details (name/value pairs you saved once), used to prefill any application question that names the same profile key. They are stored encrypted, only you can read them, and nothing is ever submitted from them automatically.',
  async handler({ user }) {
    const row = (await pool.query('SELECT data_enc, row_version, updated_at FROM sponsorship_applicant_profiles WHERE user_id=$1', [user.id])).rows[0];
    return { data: row ? open(row.data_enc, PROFILE) : {}, row_version: row?.row_version ?? 0, updated_at: row?.updated_at ?? null };
  },
});

cap({
  name: 'set_applicant_profile', method: 'POST', path: '/me/applicant-profile', tag: TAG,
  summary: 'Save your reusable applicant details (replaces the saved set). Needs the current `version` (0 the first time); a stale version is rejected (409).',
  input: z.object({ version: z.number().int().min(0), data: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(2000), z.number(), z.boolean()])).refine((d) => Object.keys(d).length <= 60, 'Up to 60 details') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT row_version FROM sponsorship_applicant_profiles WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      if ((cur?.row_version ?? 0) !== i.version) throw conflict(`Your profile was changed elsewhere (now version ${cur?.row_version ?? 0}); reload it and try again`, { current_version: cur?.row_version ?? 0 });
      const row = (await c.query(
        `INSERT INTO sponsorship_applicant_profiles(user_id, data_enc) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET data_enc=$2, row_version=sponsorship_applicant_profiles.row_version+1, updated_at=now() RETURNING row_version, updated_at`, [user.id, seal(i.data, PROFILE)])).rows[0];
      return { data: i.data, ...row };
    });
  },
});

const draftBody = {
  requested_cents: z.number().int().min(1).max(1e12).optional(),
  answers: z.record(z.string(), z.unknown()).default({}),
  budget: budgetShape.optional(), references: referencesShape.optional(),
};

/** Check what an applicant typed against the pinned form, keep only visible answers, and split out the confidential part. */
function prepare(def, body, counts, strict) {
  const { issues, answers } = validateApplication(def, { answers: body.answers, budget: body.budget ?? null, references: body.references ?? null, requested_cents: body.requested_cents ?? null, fileCounts: counts }, { strict });
  if (issues.length) throw invalid(issues);
  return splitConfidential(def, answers);
}

cap({
  name: 'save_application_draft', method: 'POST', path: '/program-rounds/:id/draft', tag: TAG,
  summary: 'Applicant: save (or create) your draft for a round and target, so you can leave and resume on any device. The whole draft is replaced each time. The draft is pinned to the form version it started on; if the round\'s form has changed since, the save is refused with `stale_form_version` and you can retry with rebase=true to carry your matching answers onto the new version. A stale `version` is rejected (409). Drafts are never visible to the brand.',
  input: z.object({ id, target_type: z.enum(TARGETS), target_id: id, version: z.number().int().positive().optional().describe('the draft\'s current version; required when a draft already exists'), rebase: z.boolean().optional(), ...draftBody }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = (await c.query('SELECT program_id FROM sponsorship_rounds WHERE id=$1', [i.id])).rows[0];
      if (!r0) throw notFound('Round');
      const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [r0.program_id])).rows[0];
      const r = (await c.query(`SELECT *, ${roundState('r')} AS state FROM sponsorship_rounds r WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (p.status !== 'published') throw conflict('This program is not accepting applications');
      if (r.state !== 'open') throw conflict(r.state === 'scheduled' ? 'This round has not opened yet' : 'This round is closed and no longer accepts applications');
      if (!r.form_id) throw conflict('This round has no application form; apply with the plain application');
      await assertCanApply(c, user, p, i, { draft: true });
      if (i.requested_cents && p.max_award_cents && i.requested_cents > Number(p.max_award_cents)) throw unprocessable(`The request is above the maximum award of ${p.max_award_cents}`);
      const cur = (await c.query('SELECT * FROM sponsorship_applications WHERE round_id=$1 AND target_type=$2 AND target_id=$3 AND status IN (\'draft\',\'submitted\',\'returned\',\'awarded\') FOR UPDATE', [r.id, i.target_type, i.target_id])).rows[0];
      if (cur && cur.status !== 'draft') throw conflict(`There is already an application for this in this round (${cur.status})`);
      if (cur && cur.applicant_id !== user.id) throw conflict('There is already an application for this in this round');
      let formVersion = cur?.form_version ?? r.form_version;
      if (cur) {
        if (i.version == null || cur.row_version !== i.version) throw conflict(`This draft was changed elsewhere (now version ${cur.row_version}); reload it and try again`, { current_version: cur.row_version });
        if (cur.form_id !== r.form_id || cur.form_version !== r.form_version) {
          if (!i.rebase) throw conflict('The application form changed since you started; reload to see the new version', { code: 'stale_form_version', draft_form_version: cur.form_version, current_form_version: r.form_version });
          formVersion = r.form_version;
        }
      }
      const def = (await formDefinitionOf(c, r.form_id, formVersion)).definition;
      const { open: openAnswers, secret } = prepare(def, i, await fileCounts(c, cur?.id ?? '00000000-0000-0000-0000-000000000000'), false);
      const row = cur
        ? (await c.query(
          `UPDATE sponsorship_applications SET form_id=$2, form_version=$3, answers=$4, confidential_enc=$5, budget=$6, refs_enc=$7, requested_cents=$8, round_terms_version=$9, terms_snapshot=$10,
                  row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
          [cur.id, r.form_id, formVersion, openAnswers, seal(Object.keys(secret).length ? secret : null, CONF), jsonb(i.budget), seal(i.references?.length ? i.references : null, REFS), i.requested_cents ?? null, r.terms_version, termsOf(p, r)])).rows[0]
        : (await c.query(
          `INSERT INTO sponsorship_applications(program_id, round_id, round_terms_version, terms_snapshot, applicant_id, target_type, target_id, requested_cents, currency, status, form_id, form_version, answers, confidential_enc, budget, refs_enc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15) RETURNING *`,
          [p.id, r.id, r.terms_version, termsOf(p, r), user.id, i.target_type, i.target_id, i.requested_cents ?? null, p.currency, r.form_id, formVersion, openAnswers, seal(Object.keys(secret).length ? secret : null, CONF), jsonb(i.budget), seal(i.references?.length ? i.references : null, REFS)])).rows[0];
      return applicationView(c, user, row, 'applicant');
    });
  },
});

cap({
  name: 'submit_application', method: 'POST', path: '/program-applications/:id/submit', tag: TAG,
  summary: 'Applicant: submit a saved draft. Requires an `idempotency_key`: repeating the call with the same key (a retry, a double tap, two devices) returns the same receipt and never files twice. Re-checks the round is open and the program published, the form version is still the one you filled (409 `stale_form_version` otherwise), eligibility, required and conditional answers, the budget and uploads. The terms and the exact form version are kept with the application, and you get a receipt number.',
  input: z.object({ id, idempotency_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a || a.applicant_id !== user.id) throw notFound('Application');
      if (a.status !== 'draft') {
        if (a.idempotency_key === i.idempotency_key) return { ...(await applicationView(c, user, a, 'applicant')), replayed: true };
        throw conflict(`This application is already ${a.status}`);
      }
      const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1 FOR UPDATE', [a.program_id])).rows[0];
      const r = (await c.query(`SELECT *, ${roundState('r')} AS state FROM sponsorship_rounds r WHERE id=$1 FOR UPDATE`, [a.round_id])).rows[0];
      if (p.status !== 'published') throw conflict('This program is not accepting applications');
      if (r.state !== 'open') throw conflict(r.state === 'scheduled' ? 'This round has not opened yet' : 'This round is closed and no longer accepts applications');
      if (r.form_id !== a.form_id || r.form_version !== a.form_version) throw conflict('The application form changed since you started; reload your draft to continue on the new version', { code: 'stale_form_version', draft_form_version: a.form_version, current_form_version: r.form_version });
      if (a.requested_cents == null) throw invalid([{ path: 'requested_cents', message: 'Enter the amount you are requesting' }]);
      await assertCanApply(c, user, p, { target_type: a.target_type, target_id: a.target_id, requested_cents: Number(a.requested_cents) });
      const def = (await formDefinitionOf(c, a.form_id, a.form_version)).definition;
      const secret = open(a.confidential_enc, CONF) ?? {};
      prepare(def, { answers: { ...a.answers, ...secret }, budget: a.budget, references: open(a.refs_enc, REFS), requested_cents: Number(a.requested_cents) }, await fileCounts(c, a.id), true);
      let row;
      try {
        row = (await c.query(
          `UPDATE sponsorship_applications SET status='submitted', idempotency_key=$2, receipt_no='SA-'||lpad(nextval('sponsorship_receipt_seq')::text, 6, '0'), submitted_at=now(), round_terms_version=$3, terms_snapshot=$4,
                  row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [a.id, i.idempotency_key, r.terms_version, termsOf(p, r)])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('That idempotency key was already used for another application');
        throw e;
      }
      await c.query("INSERT INTO sponsorship_application_events(application_id, kind, actor_id, form_version) VALUES ($1,'submitted',$2,$3)", [a.id, user.id, a.form_version]);
      const sp = await mustFind('sponsors', p.sponsor_id, '*', c);
      await notify(c, user.id, { kind: 'sponsorship_program', title: 'Application received', body: `Your application ${row.receipt_no} to ${p.name} was submitted.`, data: { application_id: a.id, receipt_no: row.receipt_no }, dedupe_key: `application-receipt:${a.id}` });
      await notifySponsor(c, sp, 'program', { kind: 'sponsorship_program', title: 'New funding application', body: `A new application arrived for ${p.name}. Open the program to review it.`, data: { program_id: p.id, application_id: a.id } });
      await audit(c, user.id, 'submit', 'sponsorship_applications', a.id);
      return applicationView(c, user, row, 'applicant');
    });
  },
});

cap({
  name: 'get_program_application', method: 'GET', path: '/program-applications/:id', tag: TAG,
  summary: 'The applicant, or brand staff of the program once it is submitted: one application with the exact form version it was filled under, answers, budget, references, uploads, receipt, events and (when returned) what to correct. Brand staff reading confidential answers, budget or references is audit-logged. Everyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { a, side } = await applicationFor(pool, user, i.id);
    return applicationView(pool, user, a, side === 'applicant' ? 'applicant' : 'staff');
  },
});

// ---------------------------------------------------------------- controlled corrections

cap({
  name: 'request_application_correction', method: 'POST', path: '/program-applications/:id/request-correction', tag: TAG,
  summary: 'Brand manager/approver: send a submitted application back to its applicant, naming the questions to fix (form field keys, plus `requested_cents` for the amount) and why. The applicant can then change only those answers; everything else stays exactly as submitted. While returned it cannot be awarded or declined.',
  input: z.object({ id, reason: z.string().min(1).max(1000), fields: z.array(z.string().min(1).max(60)).min(1).max(40) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { a } = await applicationFor(c, user, i.id, { lock: true });
      await staffOnly(c, user, a, 'program');
      if (a.status !== 'submitted') throw conflict(`Only a submitted application can be returned (this one is ${a.status})`);
      if (!a.form_id) throw conflict('This application was made without a form; decline it or ask the applicant to apply again');
      const def = (await formDefinitionOf(c, a.form_id, a.form_version)).definition;
      const keys = new Set([...fieldsOf(def).map((f) => f.key), 'requested_cents']);
      const unknown = [...new Set(i.fields)].filter((k) => !keys.has(k));
      if (unknown.length) throw badRequest(`Unknown question(s): ${unknown.join(', ')}`);
      const row = (await c.query("UPDATE sponsorship_applications SET status='returned', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [a.id])).rows[0];
      await c.query("INSERT INTO sponsorship_application_events(application_id, kind, actor_id, form_version, note, fields) VALUES ($1,'correction_requested',$2,$3,$4,$5)", [a.id, user.id, a.form_version, i.reason, [...new Set(i.fields)]]);
      await notify(c, a.applicant_id, { kind: 'sponsorship_program', title: 'Please correct your application', body: `${a.receipt_no}: ${i.reason}`.slice(0, 300), data: { application_id: a.id } });
      await audit(c, user.id, 'request_correction', 'sponsorship_applications', a.id);
      return applicationView(c, user, row, 'staff');
    });
  },
});

cap({
  name: 'submit_application_correction', method: 'POST', path: '/program-applications/:id/correction', tag: TAG,
  summary: 'Applicant: resubmit a returned application. You may only change the questions that were flagged (the form version stays the one you filled); changing anything else is refused. Needs an `idempotency_key` (a retry returns the same result). The previous values of the changed answers are kept in the application\'s history.',
  input: z.object({ id, idempotency_key: key, version: z.number().int().positive(), requested_cents: z.number().int().min(1).max(1e12).optional(), answers: z.record(z.string(), z.unknown()).optional(), budget: budgetShape.optional(), references: referencesShape.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a || a.applicant_id !== user.id) throw notFound('Application');
      if (a.status !== 'returned') {
        if (a.correction_idempotency_key === i.idempotency_key) return { ...(await applicationView(c, user, a, 'applicant')), replayed: true };
        throw conflict(`This application is ${a.status}, not waiting for a correction`);
      }
      checkVersion(a, i.version, 'application');
      const p = (await c.query('SELECT * FROM sponsorship_programs WHERE id=$1', [a.program_id])).rows[0];
      const def = (await formDefinitionOf(c, a.form_id, a.form_version)).definition;
      const allowed = new Set((await latestRequest(c, a.id))?.fields ?? []);
      const fields = fieldsOf(def), byKey = new Map(fields.map((f) => [f.key, f]));
      const secretNow = open(a.confidential_enc, CONF) ?? {}, refsNow = open(a.refs_enc, REFS);
      const nowAnswers = { ...a.answers, ...secretNow };
      const next = { ...nowAnswers }, changed = [], before = {};
      for (const [k, v] of Object.entries(i.answers ?? {})) {
        if (!byKey.has(k)) throw badRequest(`Unknown question: ${k}`);
        if (sameJson(nowAnswers[k], v)) continue;
        if (!allowed.has(k)) throw forbidden(`"${byKey.get(k).label}" was not flagged for correction`);
        changed.push(k); if (!byKey.get(k).confidential) before[k] = nowAnswers[k] ?? null; next[k] = v;
      }
      const budgetKey = fields.find((f) => f.type === 'budget')?.key, refsKey = fields.find((f) => f.type === 'references')?.key;
      if (i.budget !== undefined && !sameJson(i.budget, a.budget ?? [])) { if (!budgetKey || !allowed.has(budgetKey)) throw forbidden('The budget was not flagged for correction'); changed.push(budgetKey); }
      if (i.references !== undefined && !sameJson(i.references, refsNow ?? [])) { if (!refsKey || !allowed.has(refsKey)) throw forbidden('The references were not flagged for correction'); changed.push(refsKey); }
      if (i.requested_cents !== undefined && i.requested_cents !== Number(a.requested_cents)) {
        if (!allowed.has('requested_cents')) throw forbidden('The requested amount was not flagged for correction');
        if (p.max_award_cents && i.requested_cents > Number(p.max_award_cents)) throw unprocessable(`The request is above the maximum award of ${p.max_award_cents}`);
        changed.push('requested_cents'); before.requested_cents = Number(a.requested_cents);
      }
      const requested = i.requested_cents ?? Number(a.requested_cents), budget = i.budget ?? a.budget, refs = i.references ?? refsNow;
      const { open: openAnswers, secret } = prepare(def, { answers: next, budget, references: refs, requested_cents: requested }, await fileCounts(c, a.id), true);
      const row = (await c.query(
        `UPDATE sponsorship_applications SET status='submitted', answers=$2, confidential_enc=$3, budget=$4, refs_enc=$5, requested_cents=$6, correction_idempotency_key=$7, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [a.id, openAnswers, seal(Object.keys(secret).length ? secret : null, CONF), jsonb(budget), seal(refs?.length ? refs : null, REFS), requested, i.idempotency_key])).rows[0];
      await c.query("INSERT INTO sponsorship_application_events(application_id, kind, actor_id, form_version, fields, before) VALUES ($1,'corrected',$2,$3,$4,$5)", [a.id, user.id, a.form_version, changed, before]);
      const sp = await mustFind('sponsors', p.sponsor_id, '*', c);
      await notifySponsor(c, sp, 'program', { kind: 'sponsorship_program', title: 'Application corrected', body: `${a.receipt_no} for ${p.name} was corrected and is ready for review.`, data: { program_id: p.id, application_id: a.id } });
      await audit(c, user.id, 'correct', 'sponsorship_applications', a.id);
      return applicationView(c, user, row, 'applicant');
    });
  },
});

// ---------------------------------------------------------------- uploads and export

cap({
  name: 'remove_application_file', method: 'DELETE', path: '/application-files/:id', tag: TAG,
  summary: 'Applicant: hide a file you uploaded to your own draft (or, while returned, to a flagged question). The file is kept on record but nobody can open it any more. Upload with PUT /program-applications/{id}/files?field=KEY&name=FILENAME (the raw PDF or photo as the body); download with GET /application-files/{id}.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT f.*, a.applicant_id, a.status FROM sponsorship_application_files f JOIN sponsorship_applications a ON a.id=f.application_id WHERE f.id=$1 FOR UPDATE OF f', [i.id])).rows[0];
      if (!f || f.applicant_id !== user.id || f.removed_at) throw notFound('File');
      if (!['draft', 'returned'].includes(f.status)) throw conflict('Files can only be removed from a draft or a returned application');
      if (f.status === 'returned' && !((await latestRequest(c, f.application_id))?.fields ?? []).includes(f.field_key)) throw forbidden('That question was not flagged for correction');
      await c.query('UPDATE sponsorship_application_files SET removed_at=now() WHERE id=$1', [f.id]);
      return { id: f.id, removed: true };
    });
  },
});

cap({
  name: 'export_program_applications', method: 'GET', path: '/sponsorship-programs/:id/applications-export', tag: TAG,
  summary: 'Brand manager/finance/auditor: CSV of the submitted applications of a program (receipt, round, applicant handle, target, status, form version, amount, submitted time and the non-confidential answers as JSON). Drafts, confidential answers, budgets, references and files are never included. The export is audit-logged.',
  input: z.object({ id, round_id: id.optional() }),
  async handler({ user }, i) {
    const { p } = await programFor(user, i.id, 'export', pool);
    const rows = await many(
      `SELECT a.receipt_no, r.seq AS round, ap.handle AS applicant, a.target_type, a.status, a.form_version, a.requested_cents, a.currency, a.submitted_at, a.answers::text AS answers
         FROM sponsorship_applications a JOIN sponsorship_rounds r ON r.id=a.round_id JOIN users ap ON ap.id=a.applicant_id
        WHERE a.program_id=$1 AND a.status <> 'draft' AND ($2::uuid IS NULL OR a.round_id=$2) ORDER BY r.seq, a.submitted_at NULLS LAST, a.id`, [p.id, i.round_id ?? null]);
    await audit(null, user.id, 'export', 'sponsorship_applications', p.id);
    return { filename: `program-${p.id}-applications.csv`, rows: rows.length, csv: toCsv(['receipt_no', 'round', 'applicant', 'target_type', 'status', 'form_version', 'requested_cents', 'currency', 'submitted_at', 'answers'], rows) };
  },
});

/** Binary routes: raw upload/download of application files. Same auth and the same live access checks as the capabilities. */
export function applicationFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 40 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // PUT /api/v1/program-applications/:id/files?field=KEY&name=FILE   body = the raw file
  r.put('/program-applications/:id/files', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const field = String(req.query.field ?? '');
      const a = await one('SELECT * FROM sponsorship_applications WHERE id=$1', [uuid(req.params.id, 'Application')]);
      if (!a || a.applicant_id !== user.id || !a.form_id) throw notFound('Application');
      if (!['draft', 'returned'].includes(a.status)) throw conflict('Files can only be added to a draft or a returned application');
      const f = fieldsOf((await formDefinitionOf(pool, a.form_id, a.form_version)).definition).find((x) => x.key === field && x.type === 'file');
      if (!f) throw badRequest('That question does not take files');
      if (a.status === 'returned' && !((await latestRequest(pool, a.id))?.fields ?? []).includes(field)) throw forbidden('That question was not flagged for correction');
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF photo.');
      const counts = await fileCounts(pool, a.id);
      if ((counts[field] ?? 0) >= (f.max_files ?? 5)) throw badRequest(`"${f.label}" takes up to ${f.max_files ?? 5} files`);
      if (Object.values(counts).reduce((s, n) => s + n, 0) >= FILES_PER_APPLICATION) throw badRequest(`An application can have up to ${FILES_PER_APPLICATION} files`);
      const { id: fid, file } = await saveEncrypted('sponsorship-applications', 'sponsorship_application_files.file', buf);
      const row = await one(
        `INSERT INTO sponsorship_application_files(id, application_id, field_key, uploaded_by, content_type, file_name, original_name, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, application_id, field_key, original_name, content_type, size_bytes, created_at`, [fid, a.id, field, user.id, t.type, file, String(req.query.name ?? '').slice(0, 160) || null, buf.length, createHash('sha256').update(buf).digest('hex')]);
      await audit(null, user.id, 'upload_application_file', 'sponsorship_application_files', fid);
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  r.get('/application-files/:id', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const f = await one('SELECT * FROM sponsorship_application_files WHERE id=$1 AND removed_at IS NULL', [uuid(req.params.id, 'File')]);
      if (!f) throw notFound('File');
      const { side } = await applicationFor(pool, user, f.application_id);
      const bytes = await loadEncrypted('sponsorship-applications', 'sponsorship_application_files.file', f.file_name);
      if (side !== 'applicant') await audit(null, user.id, 'read_application_file', 'sponsorship_application_files', f.id);
      res.set(docHeaders(f.content_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('File') : e); }
  });
  return r;
}
