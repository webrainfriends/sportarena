// Universal registration engine (#575): ONE framework for athlete, team, event, competition, membership, course/camp and federation-licence
// registration. A programme (what people register for) owns versioned forms, fees and waivers; an entry is one registration under the version it
// was filled under, with a status history, signed waivers, uploads, an instalment plan paid through canonical finance, change requests, capacity /
// quota / waitlist handling and (for competitions) the #477 eligibility decision. Identities, guardian links, payments, documents and #477 stay
// where they are and are only referenced. Every rule is enforced here, in a transaction that locks the programme, so parallel clients cannot oversell.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin } from '../helpers.js';
import { requireApproved } from '../access.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { validateApplication, splitConfidential } from '../application-forms.js';
import { hasOrgGrant } from '../org-access.js';
import { checkGuardianScope, guardianLink, requireConsent, isYouth, hasConsent } from '../youth.js';
import { evaluate, latestPolicy, protectedIds, PROTECTED_NAME } from '../registration.js';
import { canManageTeam } from './teams.js';
import { isEventStaff } from './registration.js';
import {
  KINDS, KIND_LABEL, TEAM_KINDS, LIVE_STATUSES, SEAT_STATUSES, OPEN_FOR_EDIT, registrationForm, feesSchema, waiversSchema, quotasSchema,
  versionHash, quote, waiversDue, unsigned, seatDecision, waiverHash, fieldsOf,
} from '../registration-engine.js';

const TAG = 'Registration';
const ANSWERS = 'rx_entries.confidential', NOTE = 'rx_history.note', DECISION = 'rx_entries.decision_note', SIGN = 'rx_signatures.signature', CHANGE = 'rx_changes.changes', CHANGE_REASON = 'rx_changes.reason', CHANGE_NOTE = 'rx_changes.decision_note';
const txt = (n) => z.string().trim().max(n);
const iso = z.string().date();
const stamp = z.string().datetime({ offset: true });
const answersIn = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.unknown()).default({});
const today = () => new Date().toISOString().slice(0, 10);
const stale = (cur) => conflict('This record changed since you loaded it. Reload and try again.', { code: 'stale_version', row_version: cur.row_version, status: cur.status });
const isDup = (e) => e?.code === '23505';
const rows = (r) => r.rows;
// Competition roster registrations (#477) and academy admissions are mirrored here read-only until stage B (docs/registration-consolidation.md): their own flows stay the writer.
const WHERE = { event_registration: 'the event console', roster_registration: 'the event console', academy_programme: 'academy admissions', academy_application: 'academy admissions' };
const managed = (x) => conflict(`This is managed in ${WHERE[x.legacy_type] ?? 'its own module'}. Change it there.`, { code: 'managed_elsewhere', legacy_type: x.legacy_type });

// ------------------------------------------------------------------ access

/** Who runs a programme: its owner, an owner/admin of its organisation, the organiser of its event, or the platform team. */
export async function canManageProgramme(user, p, c = pool) {
  if (isAdmin(user) || p.owner_id === user.id) return true;
  if (p.organisation_id && (await hasOrgGrant(user, p.organisation_id, ['owner', 'admin'], c))) return true;
  if (p.event_id) { const ev = (await c.query('SELECT * FROM events WHERE id=$1', [p.event_id])).rows[0]; if (ev && (await isEventStaff(user, ev, c))) return true; }
  return false;
}
const getProgramme = async (c, pid, { lock = false } = {}) => {
  const p = (await c.query(`SELECT * FROM rx_programmes WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [pid])).rows[0];
  if (!p) throw notFound('Registration programme');
  if (lock && p.legacy_type) throw managed(p);
  return p;
};
/** A programme is visible to its staff always, and to everyone else only once it has been opened (never drafts or archived ones). */
async function programmeFor(c, user, pid, opts) {
  const p = await getProgramme(c, pid, opts);
  const staff = await canManageProgramme(user, p, c);
  if (!staff && !['open', 'closed'].includes(p.status)) throw notFound('Registration programme');
  return { p, staff };
}
async function mustManage(c, user, pid, opts) {
  const p = await getProgramme(c, pid, opts);
  if (!(await canManageProgramme(user, p, c))) throw notFound('Registration programme');
  return p;
}
const versionOf = async (c, pid, v) => (await c.query('SELECT * FROM rx_versions WHERE programme_id=$1 AND version=$2', [pid, v])).rows[0] ?? null;

/** The entry plus the caller's relationship to it. Staff never see anyone's draft; everyone else gets 404. */
async function entryAccess(c, user, entryId, { lock = false } = {}) {
  const e = (await c.query(`SELECT * FROM rx_entries WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [entryId])).rows[0];
  if (!e) throw notFound('Registration');
  if (lock && e.legacy_type) throw managed(e);
  const p = await getProgramme(c, e.programme_id);
  const staff = await canManageProgramme(user, p, c);
  const applicant = e.submitted_by === user.id, self = e.participant_id === user.id;
  const guardian = !!e.participant_id && !self && !!(await guardianLink(user.id, e.participant_id, c));
  const manager = !!e.team_id && !applicant && !staff && (await teamManager(user, e.team_id));
  const party = applicant || self || guardian || manager;
  if (!party && !(staff && e.status !== 'draft')) throw notFound('Registration');
  return { e, p, staff, party, applicant, self, guardian, manager };
}
const teamManager = async (user, teamId) => { const t = await one('SELECT * FROM teams WHERE id=$1', [teamId]); return !!t && (await canManageTeam(user, t)); };

// ------------------------------------------------------------------ seats, waitlist, money

async function seatState(c, p, exceptEntryId = null) {
  const held = Number((await c.query('SELECT count(*) AS n FROM rx_entries WHERE programme_id=$1 AND status = ANY($2::text[]) AND id <> coalesce($3::uuid, \'00000000-0000-0000-0000-000000000000\')', [p.id, SEAT_STATUSES, exceptEntryId])).rows[0].n);
  const byAnswer = {};
  for (const q of p.quotas ?? []) {
    byAnswer[q.field] = {};
    for (const r of (await c.query('SELECT answers->>$2 AS v, count(*) AS n FROM rx_entries WHERE programme_id=$1 AND status = ANY($3::text[]) AND id <> coalesce($4::uuid, \'00000000-0000-0000-0000-000000000000\') GROUP BY 1', [p.id, q.field, SEAT_STATUSES, exceptEntryId])).rows) if (r.v != null) byAnswer[q.field][r.v] = Number(r.n);
  }
  return { held, byAnswer };
}
const fits = async (c, p, e) => seatDecision(p, await seatState(c, p, e.id), e.answers);

async function history(c, entryId, action, from, to, actor, note) {
  await c.query('INSERT INTO rx_history(entry_id, action, from_status, to_status, actor_id, note_enc) VALUES ($1,$2,$3,$4,$5,$6)', [entryId, action, from, to, actor, note ? encrypt(note, NOTE) : null]);
}
const tell = (c, userId, entry, p, title, body) => userId && notify(c, userId, { kind: 'registration', title, body: body ?? p.title, data: { rx_programme_id: p.id, rx_entry_id: entry.id } });
const recipients = (e) => [...new Set([e.submitted_by, e.participant_id].filter(Boolean))];

/** Give an entry its money once it holds a seat: the instalment plan (dates counted from today) and the discount uses. Idempotent. */
async function materialise(c, p, e) {
  if ((await c.query('SELECT 1 FROM rx_instalments WHERE entry_id=$1 LIMIT 1', [e.id])).rows[0]) return;
  const sched = e.quote?.instalments ?? [];
  const base = sched[0] ? new Date(`${sched[0].due_on}T00:00:00Z`).getTime() : 0, t0 = new Date(`${today()}T00:00:00Z`).getTime();
  for (const s of sched) {
    const due = new Date(t0 + (new Date(`${s.due_on}T00:00:00Z`).getTime() - base)).toISOString().slice(0, 10);
    await c.query('INSERT INTO rx_instalments(entry_id, seq, due_on, amount_cents, currency) VALUES ($1,$2,$3,$4,$5)', [e.id, s.seq, due, s.amount_cents, e.currency]);
  }
  for (const d of e.quote?.discounts ?? []) if (d.code) await c.query('INSERT INTO rx_discount_uses(programme_id, entry_id, code, amount_cents) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [p.id, e.id, d.code, d.amount_cents]);
}
const cancelUnpaid = (c, entryId) => c.query("UPDATE rx_instalments SET status='cancelled' WHERE entry_id=$1 AND status='unpaid'", [entryId]);

/** The #477 decision for a competition entry. The registration / roster-list checks are skipped: this entry IS the registration. */
async function eligibilityOf(c, user, p, e) {
  if (!p.check_eligibility || !p.event_id || !e.team_id || !e.participant_id) return null;
  const event = (await c.query('SELECT * FROM events WHERE id=$1', [p.event_id])).rows[0];
  const policy = await latestPolicy(event.id, c);
  if (!policy) return { decision: 'unknown', blocking: false, policy_version: null, checks: [{ rule: 'policy', status: 'unknown', reason: 'This competition has no eligibility policy yet' }], at: new Date().toISOString() };
  const d = await evaluate(c, { event, policy, actorId: user.id, at: new Date() }, e.team_id, e.participant_id);
  const checks = d.checks.filter((k) => !['registration', 'roster_list'].includes(k.rule));
  const decision = checks.some((k) => k.status === 'fail') ? 'ineligible' : checks.some((k) => k.status === 'unknown') ? 'unknown' : checks.some((k) => k.status === 'pending') ? 'pending' : 'eligible';
  return { decision, blocking: policy.enforcement === 'blocking' && (policy.rules.block_on ?? ['ineligible']).includes(decision), policy_version: policy.version, checks, at: new Date().toISOString() };
}
const blockedBy = (el) => el?.blocking ? conflict(`Not eligible: ${el.checks.filter((k) => k.status !== 'pass').map((k) => k.reason).join('; ')}`, { code: 'not_eligible', decision: el.decision, reasons: el.checks.filter((k) => k.status !== 'pass').map((k) => k.reason) }) : null;

/** A seat freed: offer it to the oldest waitlisted entries that fit (their own quota bucket included). */
async function promoteWaitlist(c, p, actorId, exceptId = null) {
  const promoted = [];
  for (const w of (await c.query("SELECT * FROM rx_entries WHERE programme_id=$1 AND status='waitlisted' AND id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000') ORDER BY waitlisted_at, id FOR UPDATE", [p.id, exceptId])).rows) {
    if (!(await fits(c, p, w)).ok) continue;
    let to = p.needs_approval ? 'submitted' : 'approved';
    const el = to === 'approved' ? await eligibilityOf(c, { id: actorId ?? w.submitted_by }, p, w) : null;
    if (el?.blocking) to = 'submitted';
    await c.query("UPDATE rx_entries SET status=$2, waitlisted_at=NULL, eligibility=coalesce($3::jsonb, eligibility), decided_at=CASE WHEN $2='approved' THEN now() END, row_version=row_version+1, updated_at=now() WHERE id=$1", [w.id, to, el ? JSON.stringify(el) : null]);
    await history(c, w.id, 'promoted', 'waitlisted', to, actorId, 'A place became available');
    await materialise(c, p, w);
    for (const u of recipients(w)) await tell(c, u, w, p, `A place opened up: ${p.title}`, to === 'approved' ? 'Your registration is confirmed.' : 'Your registration moved off the waiting list and is awaiting review.');
    promoted.push(w.id);
  }
  return promoted;
}

// ------------------------------------------------------------------ views

const ENTRY_SQL = `SELECT e.*, u.display_name AS participant_name, u.handle AS participant_handle, u.avatar_emoji AS participant_emoji, t.name AS team_name, s.display_name AS submitter_name,
  (SELECT coalesce(sum(amount_cents) FILTER (WHERE status='paid'),0)::bigint FROM rx_instalments WHERE entry_id=e.id) AS paid_cents,
  (SELECT coalesce(sum(amount_cents) FILTER (WHERE status='unpaid'),0)::bigint FROM rx_instalments WHERE entry_id=e.id) AS due_cents
  FROM rx_entries e LEFT JOIN users u ON u.id=e.participant_id LEFT JOIN teams t ON t.id=e.team_id JOIN users s ON s.id=e.submitted_by`;
const publicCheck = (k) => ({ rule: k.rule, status: k.status, reason: k.reason });

function entryRow(r, { hidden = new Set() } = {}) {
  const { confidential_enc, decision_note_enc, answers, quote: q, eligibility, ...rest } = r;
  const masked = r.participant_id && hidden.has(r.participant_id);
  return { ...rest, participant_name: masked ? PROTECTED_NAME : r.participant_name, participant_handle: masked ? null : r.participant_handle, participant_emoji: masked ? null : r.participant_emoji,
    paid_cents: Number(r.paid_cents ?? 0), due_cents: Number(r.due_cents ?? 0), fee_cents: Number(r.fee_cents), discount_cents: Number(r.discount_cents), total_cents: Number(r.total_cents),
    eligibility: eligibility ? { decision: eligibility.decision, blocking: eligibility.blocking, at: eligibility.at } : null };
}

async function entryView(c, user, a) {
  const { e, p, staff } = a;
  const row = (await c.query(`${ENTRY_SQL} WHERE e.id=$1`, [e.id])).rows[0];
  const hidden = await protectedIds(e.participant_id ? [e.participant_id] : [], c);
  const ver = await versionOf(c, p.id, e.version);
  const { open, secret } = splitConfidential(ver.form, e.answers);
  const confSecret = e.confidential_enc ? JSON.parse(decrypt(e.confidential_enc, ANSWERS)) : {};
  const viewerIsParty = a.party;
  if (staff && !viewerIsParty && Object.keys(confSecret).length) await audit(c, user.id, 'read_registration_confidential', 'rx_entries', e.id);
  const files = rows(await c.query('SELECT id, field_key, original_name, content_type, size_bytes, created_at FROM rx_documents WHERE entry_id=$1 AND removed_at IS NULL ORDER BY created_at, id', [e.id]));
  const signatures = rows(await c.query('SELECT s.waiver_key, s.waiver_sha256, s.signer_role, s.signed_at, s.signed_by, u.display_name AS signer_name FROM rx_signatures s JOIN users u ON u.id=s.signed_by WHERE s.entry_id=$1 ORDER BY s.signed_at', [e.id]));
  const instalments = rows(await c.query('SELECT id, seq, due_on::text AS due_on, amount_cents, currency, status, paid_at FROM rx_instalments WHERE entry_id=$1 ORDER BY seq', [e.id]));
  const hist = rows(await c.query('SELECT h.id, h.action, h.from_status, h.to_status, h.note_enc, h.created_at, h.actor_id, u.display_name AS actor_name FROM rx_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.entry_id=$1 ORDER BY h.id', [e.id]))
    .map(({ note_enc, ...h }) => ({ ...h, note: note_enc ? decrypt(note_enc, NOTE) : null }));
  const changes = rows(await c.query('SELECT id, requested_by, status, changes_enc, reason_enc, decision_note_enc, decided_at, created_at FROM rx_changes WHERE entry_id=$1 ORDER BY created_at', [e.id]))
    .map((x) => ({ id: x.id, requested_by: x.requested_by, status: x.status, changes: JSON.parse(decrypt(x.changes_enc, CHANGE)), reason: x.reason_enc ? decrypt(x.reason_enc, CHANGE_REASON) : null, decision_note: x.decision_note_enc ? decrypt(x.decision_note_enc, CHANGE_NOTE) : null, decided_at: x.decided_at, created_at: x.created_at }));
  const youth = e.participant_id ? await isYouth(e.participant_id, c) : false;
  const due = waiversDue(ver.waivers, { youth });
  const el = e.eligibility;
  return {
    ...entryRow(row, { hidden }),
    programme: { id: p.id, title: p.title, kind: p.kind, status: p.status, currency: p.currency, current_version: p.current_version, needs_approval: p.needs_approval },
    answers: { ...open, ...(viewerIsParty || staff ? confSecret : {}) }, secret_keys: Object.keys(secret),
    form: ver.form, quote: e.quote, files, signatures, instalments, history: hist, changes,
    eligibility: el ? { decision: el.decision, blocking: el.blocking, at: el.at, policy_version: el.policy_version, checks: staff ? el.checks : el.checks.map(publicCheck) } : null,
    waivers: (ver.waivers ?? []).map((w) => ({ key: w.key, title: w.title, body: w.body, required: w.required, guardian_required: w.guardian_required, sha256: waiverHash(w) })),
    waivers_unsigned: unsigned(due, signatures).map((d) => ({ key: d.key, title: d.title, signer: d.signer })),
    managed_in: e.legacy_type ? { kind: e.legacy_type, event_id: p.event_id, organisation_id: p.organisation_id } : null,
    can: e.legacy_type ? { edit: false, withdraw: false, decide: false, request_change: false, pay: false } : {
      edit: viewerIsParty && OPEN_FOR_EDIT.includes(e.status), withdraw: viewerIsParty && [...LIVE_STATUSES, 'draft'].includes(e.status), decide: staff && ['submitted', 'under_review', 'waitlisted', 'approved', 'info_requested'].includes(e.status),
      request_change: viewerIsParty && ['submitted', 'under_review', 'approved'].includes(e.status), pay: viewerIsParty && instalments.some((i) => i.status === 'unpaid') && ['submitted', 'under_review', 'info_requested', 'approved'].includes(e.status),
    },
  };
}

// ------------------------------------------------------------------ programmes

const programmeFields = {
  title: txt(160).min(2), summary: txt(2000).optional(), sport: txt(60).optional(),
  opens_at: stamp.nullable().optional(), closes_at: stamp.nullable().optional(), capacity: z.number().int().min(1).max(1e6).nullable().optional(),
  quotas: quotasSchema.optional(), waitlist: z.boolean().optional(), needs_approval: z.boolean().optional(), allow_dependents: z.boolean().optional(),
  check_eligibility: z.boolean().optional(), currency: z.string().length(3).toUpperCase().optional(),
};
const PROGRAMME_COLS = 'id, kind, title, summary, owner_id, organisation_id, event_id, sport, status, opens_at, closes_at, capacity, quotas, waitlist, needs_approval, allow_dependents, check_eligibility, currency, current_version, row_version, legacy_type, created_at, updated_at';

async function assertScope(c, user, i) {
  if (i.organisation_id && !(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c))) throw notFound('Organisation');
  if (i.event_id) {
    const ev = (await c.query('SELECT * FROM events WHERE id=$1', [i.event_id])).rows[0];
    if (!ev || !(await isEventStaff(user, ev, c))) throw notFound('Event');
    if (i.organisation_id && ev.organisation_id && ev.organisation_id !== i.organisation_id) throw badRequest('That event belongs to a different organisation');
    return ev;
  }
  return null;
}

cap({
  name: 'create_registration_programme', method: 'POST', path: '/registration-programmes', tag: TAG, status: 201,
  summary: 'Create a registration programme: the one thing people register for, whatever the scenario — an athlete or player registration, a team registration, an event entry, a competition registration (with the #477 eligibility check), a membership, a course or camp, or a federation licence. Starts as a draft; publish its form, fees and waivers with publish_registration_version, then open it. Personal ownership, an organisation you own/admin, or an event you organise decide who may run it.',
  input: z.object({ kind: z.enum(KINDS), organisation_id: id.optional(), event_id: id.optional(), ...programmeFields }),
  async handler({ user }, i) {
    requireApproved(user);
    if (i.kind === 'competition' && !i.event_id) throw badRequest('A competition registration is for a competition: pick the event');
    return tx(async (c) => {
      await assertScope(c, user, i);
      const check = i.check_eligibility ?? i.kind === 'competition';
      if (check && i.kind !== 'competition') throw badRequest('Eligibility checks apply to competition registrations');
      if (i.opens_at && i.closes_at && new Date(i.closes_at) <= new Date(i.opens_at)) throw badRequest('Registration must close after it opens');
      const row = (await c.query(
        `INSERT INTO rx_programmes(kind, title, summary, owner_id, organisation_id, event_id, sport, opens_at, closes_at, capacity, quotas, waitlist, needs_approval, allow_dependents, check_eligibility, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${PROGRAMME_COLS}`,
        [i.kind, i.title, i.summary ?? null, user.id, i.organisation_id ?? null, i.event_id ?? null, i.sport ?? null, i.opens_at ?? null, i.closes_at ?? null, i.capacity ?? null, JSON.stringify(i.quotas ?? []),
          i.waitlist ?? true, i.needs_approval ?? true, i.allow_dependents ?? !TEAM_KINDS.includes(i.kind), check, i.currency ?? 'USD'])).rows[0];
      await audit(c, user.id, 'create_registration_programme', 'rx_programmes', row.id);
      return row;
    });
  },
});

cap({
  name: 'update_registration_programme', method: 'PATCH', path: '/registration-programmes/:id', tag: TAG,
  summary: 'Change a programme\'s settings (title, window, capacity, quotas, waitlist, approval, dependents, currency). Needs the current `row_version` (409 `stale_version` otherwise). Capacity cannot drop below the seats already held; once entries exist the currency cannot change; raising capacity offers the new seats to the waiting list straight away.',
  input: z.object({ id, row_version: z.number().int().min(1), ...Object.fromEntries(Object.entries(programmeFields).map(([k, v]) => [k, k === 'title' ? v.optional() : v])) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustManage(c, user, i.id, { lock: true });
      if (p.row_version !== i.row_version) throw stale(p);
      if (p.status === 'archived') throw conflict('This programme is archived');
      const n = { ...p };
      for (const k of ['title', 'summary', 'sport', 'opens_at', 'closes_at', 'capacity', 'waitlist', 'needs_approval', 'allow_dependents', 'check_eligibility', 'currency']) if (i[k] !== undefined) n[k] = i[k];
      if (i.quotas !== undefined) n.quotas = i.quotas;
      if (n.opens_at && n.closes_at && new Date(n.closes_at) <= new Date(n.opens_at)) throw badRequest('Registration must close after it opens');
      if (n.check_eligibility && p.kind !== 'competition') throw badRequest('Eligibility checks apply to competition registrations');
      const used = Number((await c.query('SELECT count(*) AS n FROM rx_entries WHERE programme_id=$1 AND status <> \'draft\'', [p.id])).rows[0].n);
      if (used && n.currency !== p.currency) throw conflict('The currency cannot change once people have registered');
      if (n.capacity != null && n.capacity < (await seatState(c, p)).held) throw conflict(`${(await seatState(c, p)).held} places are already held, so capacity cannot be lower`, { code: 'capacity_below_held' });
      const row = (await c.query(
        `UPDATE rx_programmes SET title=$2, summary=$3, sport=$4, opens_at=$5, closes_at=$6, capacity=$7, quotas=$8, waitlist=$9, needs_approval=$10, allow_dependents=$11, check_eligibility=$12, currency=$13, row_version=row_version+1, updated_at=now()
          WHERE id=$1 RETURNING ${PROGRAMME_COLS}`,
        [p.id, n.title, n.summary, n.sport, n.opens_at, n.closes_at, n.capacity, JSON.stringify(n.quotas ?? []), n.waitlist, n.needs_approval, n.allow_dependents, n.check_eligibility, n.currency])).rows[0];
      await audit(c, user.id, 'update_registration_programme', 'rx_programmes', p.id);
      await promoteWaitlist(c, row, user.id);
      return row;
    });
  },
});

cap({
  name: 'publish_registration_version', method: 'POST', path: '/registration-programmes/:id/versions', tag: TAG, status: 201,
  summary: 'Publish a new immutable version of the programme\'s form (sections, questions, conditional questions via `when`, file uploads, confidential questions), fee schedule (fee lines, conditional lines, early-bird / additional-participant / coded discounts, instalment plan) and waivers (consents to sign, optionally needing a guardian for a young participant). Entries keep the version they were filled under; a draft on an older version is moved to the new one when edited. Send `expected_version` (the current one) to avoid overwriting a concurrent publish.',
  input: z.object({ id, expected_version: z.number().int().min(0), form: registrationForm, fees: feesSchema.default({ items: [], discounts: [] }), waivers: waiversSchema.default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustManage(c, user, i.id, { lock: true });
      if (p.status === 'archived') throw conflict('This programme is archived');
      if (p.current_version !== i.expected_version) throw conflict('Another version was published meanwhile. Reload and try again.', { code: 'stale_version', current_version: p.current_version });
      const fields = fieldsOf(i.form), keys = new Set(fields.map((f) => f.key));
      for (const q of p.quotas ?? []) { const f = fields.find((x) => x.key === q.field); if (!f || !['choice', 'yesno'].includes(f.type) || f.confidential) throw badRequest(`Quota question "${q.field}" must be a non-confidential choice or yes/no question of the form`); }
      for (const it of i.fees.items) if (it.when && !keys.has(it.when.field)) throw badRequest(`Fee "${it.label}" depends on a question the form does not have`);
      const v = p.current_version + 1;
      await c.query('INSERT INTO rx_versions(programme_id, version, form, fees, waivers, sha256, published_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [p.id, v, JSON.stringify(i.form), JSON.stringify(i.fees), JSON.stringify(i.waivers), versionHash(i.form, i.fees, i.waivers), user.id]);
      await c.query('UPDATE rx_programmes SET current_version=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [p.id, v]);
      await audit(c, user.id, 'publish_registration_version', 'rx_programmes', p.id);
      return { programme_id: p.id, version: v };
    });
  },
});

cap({
  name: 'set_registration_programme_status', method: 'POST', path: '/registration-programmes/:id/status', tag: TAG,
  summary: 'Open, close or archive a programme. Opening needs a published version (and, for a competition with eligibility checks, an eligibility policy on the competition). Closing stops new registrations; existing ones continue. Archiving needs every live registration decided first; nothing is deleted.',
  input: z.object({ id, status: z.enum(['open', 'closed', 'archived']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustManage(c, user, i.id, { lock: true });
      if (p.status === i.status) return { id: p.id, status: p.status };
      if (p.status === 'archived') throw conflict('This programme is archived');
      if (i.status === 'open') {
        if (!p.current_version) throw conflict('Publish the form, fees and waivers first', { code: 'no_version' });
        if (p.check_eligibility && !(await latestPolicy(p.event_id, c))) throw conflict('Publish an eligibility policy for the competition first', { code: 'no_policy' });
      }
      if (i.status === 'archived') {
        const live = Number((await c.query("SELECT count(*) AS n FROM rx_entries WHERE programme_id=$1 AND status IN ('submitted','under_review','info_requested','waitlisted')", [p.id])).rows[0].n);
        if (live) throw conflict(`${live} registrations still wait for a decision`, { code: 'undecided_entries' });
      }
      await c.query('UPDATE rx_programmes SET status=$2, archived_at=CASE WHEN $2=\'archived\' THEN now() ELSE archived_at END, row_version=row_version+1, updated_at=now() WHERE id=$1', [p.id, i.status]);
      await audit(c, user.id, `registration_programme_${i.status}`, 'rx_programmes', p.id);
      return { id: p.id, status: i.status };
    });
  },
});

const availability = async (c, p) => {
  const s = await seatState(c, p);
  const now = Date.now(), notYet = p.opens_at && new Date(p.opens_at).getTime() > now, over = p.closes_at && new Date(p.closes_at).getTime() <= now;
  const full = p.capacity != null && s.held >= p.capacity;
  return { capacity: p.capacity, held: s.held, seats_left: p.capacity == null ? null : Math.max(0, p.capacity - s.held), full, accepting: p.status === 'open' && !notYet && !over, waitlist_open: full && p.waitlist,
    waitlisted: Number((await c.query("SELECT count(*) AS n FROM rx_entries WHERE programme_id=$1 AND status='waitlisted'", [p.id])).rows[0].n),
    reason: p.status !== 'open' ? 'closed' : notYet ? 'not_yet_open' : over ? 'deadline_passed' : null };
};

cap({
  name: 'list_registration_programmes', method: 'GET', path: '/registration-programmes', tag: TAG,
  summary: 'Discover programmes you can register for (`scope=open`, the default) or the ones you run (`scope=managed`, any status). Filter by kind, sport, organisation, event or text. Each row says how many places are left and whether the deadline has passed.',
  input: z.object({ scope: z.enum(['open', 'managed']).default('open'), kind: z.enum(KINDS).optional(), sport: txt(60).optional(), organisation_id: id.optional(), event_id: id.optional(), q: txt(80).optional(), ...page }),
  async handler({ user }, i) {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)); };
    if (i.scope === 'open') where.push("p.status = 'open' AND (p.closes_at IS NULL OR p.closes_at > now())");
    else if (!isAdmin(user)) {
      add("(p.owner_id = ? OR p.organisation_id IN (SELECT m.organisation_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id = ? AND m.status='active' AND o.status='active' AND m.role IN ('owner','admin')) OR p.event_id IN (SELECT id FROM events WHERE organizer_id = ?))", user.id);
    }
    if (i.kind) add('p.kind = ?', i.kind);
    if (i.sport) add('lower(p.sport) = lower(?)', i.sport);
    if (i.organisation_id) add('p.organisation_id = ?', i.organisation_id);
    if (i.event_id) add('p.event_id = ?', i.event_id);
    if (i.q) add("(p.title ILIKE '%' || ? || '%' OR p.summary ILIKE '%' || ? || '%')", i.q);
    const sql = `SELECT ${PROGRAMME_COLS.split(', ').map((c) => `p.${c}`).join(', ')}, o.name AS organisation_name FROM rx_programmes p LEFT JOIN organisations o ON o.id=p.organisation_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC, p.id LIMIT ${i.limit} OFFSET ${i.offset}`;
    const list = await many(sql, args);
    const out = [];
    for (const p of list) out.push({ ...p, kind_label: KIND_LABEL[p.kind], availability: await availability(pool, p) });
    return out;
  },
});

cap({
  name: 'get_registration_programme', method: 'GET', path: '/registration-programmes/:id', tag: TAG,
  summary: 'One programme with its current form, fee schedule and waivers, how many places are left, and (for its staff) the counts by status. Drafts and archived programmes are visible only to the people who run them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p, staff } = await programmeFor(pool, user, i.id);
    const ver = p.current_version ? await versionOf(pool, p.id, p.current_version) : null;
    const counts = staff ? Object.fromEntries((await many('SELECT status, count(*)::int AS n FROM rx_entries WHERE programme_id=$1 AND status <> \'draft\' GROUP BY status', [p.id])).map((r) => [r.status, r.n])) : undefined;
    const mine = await many(`${ENTRY_SQL} WHERE e.programme_id=$1 AND (e.submitted_by=$2 OR e.participant_id=$2) ORDER BY e.created_at DESC`, [p.id, user.id]);
    const org = p.organisation_id ? await one('SELECT name FROM organisations WHERE id=$1', [p.organisation_id]) : null;
    const ev = p.event_id ? await one('SELECT name FROM events WHERE id=$1', [p.event_id]) : null;
    return { ...Object.fromEntries(PROGRAMME_COLS.split(', ').map((k) => [k, p[k]])), kind_label: KIND_LABEL[p.kind], organisation_name: org?.name ?? null, event_name: ev?.name ?? null, can_manage: staff, counts,
      version: ver ? { version: ver.version, form: ver.form, fees: ver.fees, waivers: ver.waivers.map((w) => ({ ...w, sha256: waiverHash(w) })), published_at: ver.published_at } : null,
      availability: await availability(pool, p), my_entries: mine.map((r) => entryRow(r)) };
  },
});

cap({
  name: 'list_registration_participants', method: 'GET', path: '/me/registration-participants', tag: TAG,
  summary: 'Who you can register: yourself and every young person you are a verified guardian of (household / dependents), each with whether a guardian currently consents to participation. Use it to pre-fill the "who is registering" step.',
  input: z.object({}),
  async handler({ user }) {
    const me = await one('SELECT id, display_name, avatar_emoji FROM users WHERE id=$1', [user.id]);
    const kids = await many(
      `SELECT u.id, u.display_name, u.avatar_emoji FROM guardian_links l JOIN users u ON u.id=l.child_id
        WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND (u.youth_until IS NOT NULL AND u.youth_until > current_date) ORDER BY u.display_name`, [user.id]);
    const out = [{ user_id: me.id, display_name: me.display_name, avatar_emoji: me.avatar_emoji, relation: 'self', youth: await isYouth(me.id), consent_ok: await hasConsent(me.id, 'participation') }];
    for (const k of kids) out.push({ user_id: k.id, display_name: k.display_name, avatar_emoji: k.avatar_emoji, relation: 'dependent', youth: true, consent_ok: await hasConsent(k.id, 'participation') });
    return out;
  },
});

// ------------------------------------------------------------------ quote

async function quoteFor(c, p, ver, { answers, codes, plan, submitterId, participantId, exceptEntryId }) {
  const uses = Object.fromEntries((await c.query('SELECT code, count(*)::int AS n FROM rx_discount_uses WHERE programme_id=$1 GROUP BY code', [p.id])).rows.map((r) => [r.code, r.n]));
  const prior = Number((await c.query("SELECT count(*) AS n FROM rx_entries WHERE programme_id=$1 AND submitted_by=$2 AND status = ANY($3::text[]) AND id <> coalesce($4::uuid, '00000000-0000-0000-0000-000000000000')", [p.id, submitterId, [...LIVE_STATUSES], exceptEntryId ?? null])).rows[0].n);
  return quote(ver.fees, { answers, codes, today: today(), uses, plan, priorEntries: prior });
}

cap({
  name: 'quote_registration', method: 'POST', path: '/registration-programmes/:id/quote', tag: TAG,
  summary: 'What this registration will cost: fee lines that apply to the answers, automatic and coded discounts, the total and the instalment schedule if you choose `plan=instalments`. Deterministic and read-only; the same inputs give the same quote. Unknown or used-up codes are reported in `rejected_codes`.',
  input: z.object({ id, answers: answersIn, codes: z.array(txt(24)).max(5).default([]), plan: z.enum(['full', 'instalments']).default('full') }),
  async handler({ user }, i) {
    const { p } = await programmeFor(pool, user, i.id);
    if (!p.current_version) throw conflict('This programme has not published its fees yet');
    const ver = await versionOf(pool, p.id, p.current_version);
    return { currency: p.currency, ...(await quoteFor(pool, p, ver, { answers: i.answers, codes: i.codes, plan: i.plan, submitterId: user.id })) };
  },
});

// ------------------------------------------------------------------ entries: draft, edit, sign, submit

const fileCounts = async (c, entryId) => Object.fromEntries((await c.query('SELECT field_key, count(*)::int AS n FROM rx_documents WHERE entry_id=$1 AND removed_at IS NULL GROUP BY 1', [entryId])).rows.map((r) => [r.field_key, r.n]));
const issues = (list) => badRequest('Please check the form', { issues: list });

async function resolveParty(c, user, p, i) {
  const staff = await canManageProgramme(user, p, c);
  if (TEAM_KINDS.includes(p.kind)) {
    if (!i.team_id) throw badRequest('Pick the team to register');
    const t = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
    if (!t || !(staff || (await canManageTeam(user, t)))) throw notFound('Team');
    if (p.sport && t.sport && t.sport.toLowerCase() !== p.sport.toLowerCase()) throw badRequest(`This programme is for ${p.sport}`);
    return { participant_id: null, team_id: t.id };
  }
  const participant = i.participant_id ?? user.id;
  let team = null;
  if (p.kind === 'competition') {
    if (!i.team_id) throw badRequest('Pick the team this player registers for');
    team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
    if (!team) throw notFound('Team');
    if (!(await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status='accepted'", [p.event_id, team.id])).rows[0]) throw conflict('This team is not entered in the competition');
    if (!(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [team.id, participant])).rows[0]) throw badRequest('The player is not an active member of this team');
  } else if (i.team_id) {
    team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
    if (!team) throw notFound('Team');
  }
  if (participant !== user.id) {
    const manager = team && (await canManageTeam(user, team));
    const guardian = p.allow_dependents && !!(await guardianLink(user.id, participant, c));
    if (!(staff || manager || guardian)) throw notFound('Participant');
    if (guardian && !staff && !manager) await checkGuardianScope(user.id, participant, 'register', null, c);
  }
  if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [participant])).rows[0]) throw notFound('Participant');
  return { participant_id: participant, team_id: team?.id ?? null };
}

const acceptingOrThrow = async (c, p) => {
  const a = await availability(c, p);
  if (!a.accepting) throw conflict(a.reason === 'not_yet_open' ? 'Registration has not opened yet' : a.reason === 'deadline_passed' ? 'The registration deadline has passed' : 'Registration is closed', { code: a.reason ?? 'closed' });
  return a;
};

function cleanAnswers(form, answers, files, strict) {
  const out = validateApplication(form, { answers, fileCounts: files }, { strict });
  if (out.issues.length) throw issues(out.issues);
  return out.answers;
}
const seal = (form, answers) => { const { open, secret } = splitConfidential(form, answers); return { open, enc: Object.keys(secret).length ? encrypt(JSON.stringify(secret), ANSWERS) : null }; };

cap({
  name: 'create_registration_entry', method: 'POST', path: '/registration-programmes/:id/entries', tag: TAG, status: 201,
  summary: 'Start a registration (a private draft) under the programme\'s current form. Register yourself, a young person you are a verified guardian of, a player of a team you manage (competition), or a team you manage (team registration). One live registration per person (or team) per programme: a second one is 409 `duplicate_registration`. A young participant needs current guardian consent for participation. Nothing is held (no seat, no charge) until you submit.',
  input: z.object({ id, participant_id: id.optional(), team_id: id.optional(), answers: answersIn, codes: z.array(txt(24)).max(5).default([]), plan: z.enum(['full', 'instalments']).default('full') }),
  async handler({ user }, i) {
    requireApproved(user);
    return tx(async (c) => {
      const p = await getProgramme(c, i.id, { lock: true });
      if (p.status !== 'open') {
        if (p.status !== 'closed' && !(await canManageProgramme(user, p, c))) throw notFound('Registration programme');
        throw conflict('Registration is closed', { code: 'closed' });
      }
      await acceptingOrThrow(c, p);
      const ver = await versionOf(c, p.id, p.current_version);
      if (!ver) throw conflict('This programme has not published its form yet');
      const party = await resolveParty(c, user, p, i);
      if (party.participant_id) await requireConsent(party.participant_id, 'participation', 'a registration', c);
      const answers = cleanAnswers(ver.form, i.answers, {}, false);
      const { open, enc } = seal(ver.form, answers);
      let row;
      try {
        row = (await c.query('INSERT INTO rx_entries(programme_id, version, submitted_by, participant_id, team_id, answers, confidential_enc, currency, discount_codes, quote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
          [p.id, ver.version, user.id, party.participant_id, party.team_id, JSON.stringify(open), enc, p.currency, i.codes.map((x) => x.toUpperCase()), JSON.stringify({ plan_choice: i.plan })])).rows[0];
      } catch (e) { throw isDup(e) ? conflict('There is already a live registration for this person in this programme', { code: 'duplicate_registration' }) : e; }
      await history(c, row.id, 'drafted', null, 'draft', user.id);
      return entryView(c, user, await entryAccess(c, user, row.id));
    });
  },
});

cap({
  name: 'update_registration_entry', method: 'PATCH', path: '/registration-entries/:id', tag: TAG,
  summary: 'Save answers, discount codes or the payment plan on a draft (or on a registration the organiser sent back with `info_requested`). Needs the current `row_version`. A draft filled under an older form version is moved to the programme\'s current version; answers the new form no longer asks are dropped.',
  input: z.object({ id, row_version: z.number().int().min(1), answers: answersIn.optional(), codes: z.array(txt(24)).max(5).optional(), plan: z.enum(['full', 'instalments']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await entryAccess(c, user, i.id, { lock: true });
      const { e, p } = a;
      if (!a.party) throw notFound('Registration');
      if (!OPEN_FOR_EDIT.includes(e.status)) throw conflict('This registration can no longer be edited. Ask for a change instead.');
      if (e.row_version !== i.row_version) throw stale(e);
      // a sent-back registration keeps the form it was filled under; only a draft follows the programme to its newest version
      const ver = await versionOf(c, p.id, e.status === 'draft' ? p.current_version : e.version);
      const prev = { ...e.answers, ...(e.confidential_enc ? JSON.parse(decrypt(e.confidential_enc, ANSWERS)) : {}) };
      const answers = cleanAnswers(ver.form, i.answers ?? prev, await fileCounts(c, e.id), false);
      const { open, enc } = seal(ver.form, answers);
      const row = (await c.query('UPDATE rx_entries SET answers=$2, confidential_enc=$3, version=$4, discount_codes=coalesce($5,discount_codes), quote=CASE WHEN $6::text IS NULL THEN quote ELSE jsonb_set(coalesce(quote, \'{}\'::jsonb), \'{plan_choice}\', to_jsonb($6::text)) END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id',
        [e.id, JSON.stringify(open), enc, ver.version, i.codes ? i.codes.map((x) => x.toUpperCase()) : null, i.plan ?? null])).rows[0];
      return entryView(c, user, await entryAccess(c, user, row.id));
    });
  },
});

cap({
  name: 'sign_registration_waiver', method: 'POST', path: '/registration-entries/:id/signatures', tag: TAG, status: 201,
  summary: 'Sign a waiver or consent of the programme by typing your legal name. The exact text you signed is recorded by hash, with who signed and when; signatures are never edited. For a young participant a waiver marked guardian-required must be signed by a verified guardian of that young person. Signing again is idempotent.',
  input: z.object({ id, waiver_key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), signature: txt(160).min(2), accept: z.literal(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await entryAccess(c, user, i.id, { lock: true });
      const { e, p } = a;
      if (!a.party) throw notFound('Registration');
      if (!['draft', 'info_requested', 'submitted', 'under_review'].includes(e.status)) throw conflict('This registration is no longer open for signing');
      const ver = await versionOf(c, p.id, e.version);
      const w = (ver.waivers ?? []).find((x) => x.key === i.waiver_key);
      if (!w) throw badRequest('That waiver is not part of this registration');
      const youth = e.participant_id ? await isYouth(e.participant_id, c) : false;
      const guardian = !!e.participant_id && !!(await guardianLink(user.id, e.participant_id, c));
      if (youth && w.guardian_required && !guardian) throw forbidden('A verified guardian of the young person must sign this');
      if (e.participant_id && e.participant_id !== user.id && !guardian && !a.manager && !a.applicant) throw forbidden('You cannot sign for this person');
      const role = guardian && youth ? 'guardian' : a.manager ? 'manager' : 'participant';
      const sig = (await c.query('INSERT INTO rx_signatures(entry_id, waiver_key, waiver_sha256, signed_by, signer_role, signature_enc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (entry_id, waiver_key, signed_by) DO NOTHING RETURNING signed_at',
        [e.id, w.key, waiverHash(w), user.id, role, encrypt(i.signature, SIGN)])).rows[0];
      if (sig) { await history(c, e.id, 'signed', e.status, e.status, user.id, `Signed "${w.title}" as ${role}`); await audit(c, user.id, 'sign_registration_waiver', 'rx_entries', e.id); }
      return { entry_id: e.id, waiver_key: w.key, signer_role: role, signed: true };
    });
  },
});

cap({
  name: 'submit_registration_entry', method: 'POST', path: '/registration-entries/:id/submit', tag: TAG, status: 200,
  summary: 'Submit a draft (or resubmit one that was sent back). Requires an `idempotency_key`: repeating the call with the same key (a retry, a double tap, two devices) returns the same registration and never files twice. Re-checks the programme is open and the deadline, the form version (409 `stale_form_version` if the programme published a new one: edit and submit again), every required answer and upload, every required waiver signed (a guardian for a young participant), the #477 eligibility decision for competitions, and the capacity and quotas under a lock: when full the registration goes to the waiting list (or 409 `programme_full` if the programme has none). The fee is quoted once, here, and an instalment plan is created when the registration holds a place.',
  input: z.object({ id, row_version: z.number().int().min(1), idempotency_key: txt(80).min(8) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = await entryAccess(c, user, i.id);
      if (!a0.party) throw notFound('Registration');
      const p = await getProgramme(c, a0.p.id, { lock: true });
      const a = await entryAccess(c, user, i.id, { lock: true });
      const { e } = a;
      if (e.idempotency_key === i.idempotency_key && !OPEN_FOR_EDIT.includes(e.status)) return entryView(c, user, a);
      if (!OPEN_FOR_EDIT.includes(e.status)) throw conflict('This registration was already submitted');
      if (e.row_version !== i.row_version) throw stale(e);
      const resubmit = e.status === 'info_requested';
      if (!resubmit) { if (p.status !== 'open') throw conflict('Registration is closed', { code: 'closed' }); await acceptingOrThrow(c, p); }
      if (e.version !== p.current_version && !resubmit) throw conflict('The programme published a new form. Open your draft, review it and submit again.', { code: 'stale_form_version', current_version: p.current_version });
      const ver = await versionOf(c, p.id, e.version);
      const all = { ...e.answers, ...(e.confidential_enc ? JSON.parse(decrypt(e.confidential_enc, ANSWERS)) : {}) };
      cleanAnswers(ver.form, all, await fileCounts(c, e.id), true);
      if (e.participant_id) await requireConsent(e.participant_id, 'participation', 'a registration', c);
      const sigs = rows(await c.query('SELECT waiver_key, waiver_sha256, signer_role FROM rx_signatures WHERE entry_id=$1', [e.id]));
      const youth = e.participant_id ? await isYouth(e.participant_id, c) : false;
      const missing = unsigned(waiversDue(ver.waivers, { youth }), sigs);
      if (missing.length) throw conflict(`Sign ${missing.map((m) => `"${m.title}"${m.signer === 'guardian' ? ' (a guardian must sign)' : ''}`).join(', ')} first`, { code: 'waivers_unsigned', waivers: missing.map((m) => m.key) });
      const el = await eligibilityOf(c, user, p, e);
      if (el?.blocking && !p.needs_approval) throw blockedBy(el);
      const from = e.status;
      if (resubmit) {
        await c.query("UPDATE rx_entries SET status='submitted', eligibility=coalesce($2::jsonb, eligibility), idempotency_key=$3, submitted_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [e.id, el ? JSON.stringify(el) : null, i.idempotency_key]);
        await history(c, e.id, 'resubmitted', from, 'submitted', user.id);
      } else {
        const q = await quoteFor(c, p, ver, { answers: all, codes: e.discount_codes, plan: e.quote?.plan_choice ?? 'full', submitterId: e.submitted_by, participantId: e.participant_id, exceptEntryId: e.id });
        if (q.rejected_codes.length) throw conflict(`The code ${q.rejected_codes.join(', ')} is not valid`, { code: 'invalid_code', codes: q.rejected_codes });
        const seat = await fits(c, p, { id: e.id, answers: all });
        let to = p.needs_approval ? 'submitted' : 'approved';
        if (!seat.ok) {
          if (!p.waitlist) throw conflict(seat.why === 'quota' ? `The ${seat.value} places are full` : 'This programme is full', { code: 'programme_full', why: seat.why });
          to = 'waitlisted';
        }
        const receipt = `RX-${String((await c.query("SELECT nextval('rx_receipt_seq') AS n")).rows[0].n).padStart(6, '0')}`;
        await c.query("UPDATE rx_entries SET status=$2, quote=$3, fee_cents=$4, discount_cents=$5, total_cents=$6, eligibility=$7, receipt_no=$8, idempotency_key=$9, waitlisted_at=CASE WHEN $2='waitlisted' THEN now() END, submitted_at=now(), decided_at=CASE WHEN $2='approved' THEN now() END, row_version=row_version+1, updated_at=now() WHERE id=$1",
          [e.id, to, JSON.stringify({ ...q, plan_choice: q.plan }), q.subtotal_cents, q.discount_cents, q.total_cents, el ? JSON.stringify(el) : null, receipt, i.idempotency_key]);
        await history(c, e.id, to === 'waitlisted' ? 'waitlisted' : 'submitted', from, to, user.id, to === 'waitlisted' ? 'The programme is full' : null);
        if (to !== 'waitlisted') await materialise(c, p, { ...e, quote: { ...q } , currency: e.currency });
        if (to === 'approved') await history(c, e.id, 'approved', 'submitted', 'approved', null, 'Approved automatically');
        if (p.owner_id !== user.id) await tell(c, p.owner_id, e, p, `A registration awaits review: ${p.title}`);
      }
      return entryView(c, user, await entryAccess(c, user, e.id));
    });
  },
});

cap({
  name: 'withdraw_registration_entry', method: 'POST', path: '/registration-entries/:id/withdraw', tag: TAG,
  summary: 'Withdraw a registration (or abandon a draft). Unpaid instalments are cancelled, the place is offered to the waiting list, and the history keeps the record. Money already paid is returned through the normal refund process by the organiser; nothing is deleted.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: txt(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = await entryAccess(c, user, i.id);
      if (!a0.party) throw notFound('Registration');
      const p = await getProgramme(c, a0.p.id, { lock: true });
      const { e } = await entryAccess(c, user, i.id, { lock: true });
      if (e.row_version !== i.row_version) throw stale(e);
      if (!['draft', ...LIVE_STATUSES].includes(e.status)) throw conflict(`This registration is already ${e.status}`);
      await c.query("UPDATE rx_entries SET status='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1", [e.id]);
      await cancelUnpaid(c, e.id);
      await history(c, e.id, 'withdrawn', e.status, 'withdrawn', user.id, i.reason);
      if (e.status !== 'draft') {
        if (p.owner_id !== user.id) await tell(c, p.owner_id, e, p, `A registration was withdrawn: ${p.title}`, i.reason);
        await promoteWaitlist(c, p, user.id);
      }
      return entryView(c, user, await entryAccess(c, user, e.id));
    });
  },
});

// ------------------------------------------------------------------ entries: read

cap({
  name: 'get_registration_entry', method: 'GET', path: '/registration-entries/:id', tag: TAG,
  summary: 'One registration: answers (confidential ones only for the people it concerns and, audit-logged, the organiser), the form version it was filled under, signed waivers, uploads, the fee quote and instalments, the eligibility decision for competitions, change requests, and the full status history with decision notes. Only the people it concerns and the programme\'s staff can open it; anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) { return entryView(pool, user, await entryAccess(pool, user, i.id)); },
});

cap({
  name: 'list_my_registration_entries', method: 'GET', path: '/me/registration-entries', tag: TAG,
  summary: 'Every registration you made or that is for you (including your dependents and the teams you manage), newest first, with status, receipt, amount paid and still due.',
  input: z.object({ status: z.enum(['draft', 'submitted', 'under_review', 'info_requested', 'waitlisted', 'approved', 'rejected', 'withdrawn', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const list = await many(`${ENTRY_SQL} WHERE (e.submitted_by=$1 OR e.participant_id=$1) AND ($2::text IS NULL OR e.status=$2) ORDER BY e.created_at DESC, e.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]);
    const progs = new Map((await many('SELECT id, title, kind FROM rx_programmes WHERE id = ANY($1::uuid[])', [[...new Set(list.map((r) => r.programme_id))]])).map((p) => [p.id, p]));
    return list.map((r) => ({ ...entryRow(r), programme_title: progs.get(r.programme_id)?.title, kind: progs.get(r.programme_id)?.kind }));
  },
});

const LIST_COLS = ['receipt_no', 'status', 'participant_name', 'team_name', 'submitted_by_name', 'total_cents', 'paid_cents', 'due_cents', 'submitted_at', 'decided_at'];
async function programmeEntries(c, p, i, hidden) {
  const list = await c.query(`${ENTRY_SQL} WHERE e.programme_id=$1 AND e.status <> 'draft' AND ($2::text IS NULL OR e.status=$2) AND ($3::text IS NULL OR e.receipt_no ILIKE '%' || $3 || '%' OR u.display_name ILIKE '%' || $3 || '%' OR t.name ILIKE '%' || $3 || '%') ORDER BY coalesce(e.submitted_at, e.created_at) DESC, e.id LIMIT $4 OFFSET $5`,
    [p.id, i.status ?? null, i.q ?? null, i.limit, i.offset]);
  const hide = hidden ?? await protectedIds(list.rows.map((r) => r.participant_id).filter(Boolean), c);
  return list.rows.map((r) => ({ ...entryRow(r, { hidden: hide }), submitted_by_name: r.submitter_name }));
}

cap({
  name: 'list_registration_entries', method: 'GET', path: '/registration-programmes/:id/entries', tag: TAG,
  summary: 'Staff: the registrations of a programme (drafts are private and never listed), filterable by status or by receipt / person / team text. Young people without current guardian consent appear as a protected participant.',
  input: z.object({ id, status: z.enum(['submitted', 'under_review', 'info_requested', 'waitlisted', 'approved', 'rejected', 'withdrawn', 'cancelled']).optional(), q: txt(80).optional(), ...page }),
  async handler({ user }, i) { const p = await mustManage(pool, user, i.id); return programmeEntries(pool, p, i); },
});

cap({
  name: 'export_registration_entries', method: 'GET', path: '/registration-programmes/:id/export', tag: TAG,
  summary: 'Staff: CSV of the programme\'s submitted registrations (receipt, status, person, team, total, paid, still due, submitted and decided times). Never includes answers, confidential answers, uploads or signatures. The export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustManage(pool, user, i.id);
    const all = [];
    for (let off = 0; off < 5000; off += 100) { const batch = await programmeEntries(pool, p, { limit: 100, offset: off }); all.push(...batch); if (batch.length < 100) break; }
    await audit(null, user.id, 'export_registration_entries', 'rx_programmes', p.id);
    return { filename: `registrations-${p.id.slice(0, 8)}.csv`, rows: all.length, csv: toCsv(LIST_COLS, all) };
  },
});

// ------------------------------------------------------------------ entries: decide

cap({
  name: 'decide_registration_entry', method: 'POST', path: '/registration-entries/:id/decision', tag: TAG,
  summary: 'Staff: decide a registration. `review` marks it under review; `approve` confirms it (competitions re-run the #477 eligibility decision and a blocking policy refuses an ineligible player with 409 `not_eligible`; a place must be free); `request_info` sends it back to the applicant with a note; `reject` declines it with a reason; `waitlist` moves it to the waiting list; `promote` offers a waitlisted entry a free place. Needs the current `row_version`. The note is shown to the applicant and kept in the history; rejecting or waitlisting frees the place for the waiting list.',
  input: z.object({ id, action: z.enum(['review', 'approve', 'request_info', 'reject', 'waitlist', 'promote']), row_version: z.number().int().min(1), note: txt(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = await entryAccess(c, user, i.id);
      if (!a0.staff) throw notFound('Registration');
      const p = await getProgramme(c, a0.p.id, { lock: true });
      const { e } = await entryAccess(c, user, i.id, { lock: true });
      if (e.row_version !== i.row_version) throw stale(e);
      const from = e.status;
      const allowed = { review: ['submitted'], approve: ['submitted', 'under_review'], request_info: ['submitted', 'under_review'], reject: ['submitted', 'under_review', 'info_requested', 'waitlisted', 'approved'], waitlist: ['submitted', 'under_review'], promote: ['waitlisted'] }[i.action];
      if (!allowed.includes(from)) throw conflict(`Cannot ${i.action.replace('_', ' ')} a registration that is ${from.replace('_', ' ')}`, { code: 'invalid_transition', status: from });
      if (['reject', 'request_info'].includes(i.action) && !(i.note && i.note.length >= 3)) throw badRequest('Give the applicant a reason');
      let to, el = null;
      if (i.action === 'review') to = 'under_review';
      else if (i.action === 'request_info') to = 'info_requested';
      else if (i.action === 'reject') to = 'rejected';
      else if (i.action === 'waitlist') { if (!p.waitlist) throw conflict('This programme has no waiting list'); to = 'waitlisted'; }
      else {
        if (i.action === 'promote' && !(await fits(c, p, e)).ok) throw conflict('There is no free place yet', { code: 'programme_full' });
        el = await eligibilityOf(c, user, p, e);
        if (i.action === 'approve' && el?.blocking) throw blockedBy(el);
        to = i.action === 'approve' ? 'approved' : p.needs_approval ? 'submitted' : 'approved';
      }
      await c.query("UPDATE rx_entries SET status=$2, decision_note_enc=$3, eligibility=coalesce($4::jsonb, eligibility), waitlisted_at=CASE WHEN $2='waitlisted' THEN now() ELSE NULL END, decided_at=CASE WHEN $2 IN ('approved','rejected') THEN now() ELSE decided_at END, decided_by=$5, row_version=row_version+1, updated_at=now() WHERE id=$1",
        [e.id, to, i.note ? encrypt(i.note, DECISION) : null, el ? JSON.stringify(el) : null, user.id]);
      await history(c, e.id, i.action === 'approve' ? 'approved' : i.action === 'reject' ? 'rejected' : i.action === 'promote' ? 'promoted' : i.action === 'waitlist' ? 'waitlisted' : i.action === 'request_info' ? 'info_requested' : 'under_review', from, to, user.id, i.note);
      if (from === 'waitlisted' && to !== 'waitlisted' && to !== 'rejected') await materialise(c, p, e);
      if (['rejected'].includes(to)) await cancelUnpaid(c, e.id);
      const text = { approved: ['Registration confirmed', 'Your registration was approved.'], rejected: ['Registration declined', i.note], info_requested: ['More information needed', i.note], waitlisted: ['You are on the waiting list', 'You will be told as soon as a place opens up.'] }[to];
      if (text) for (const u of recipients(e)) await tell(c, u, e, p, `${text[0]}: ${p.title}`, text[1]);
      if (['rejected', 'waitlisted'].includes(to) && SEAT_STATUSES.includes(from)) await promoteWaitlist(c, p, user.id, e.id);
      return entryView(c, user, await entryAccess(c, user, e.id));
    });
  },
});

// ------------------------------------------------------------------ change requests

cap({
  name: 'request_registration_change', method: 'POST', path: '/registration-entries/:id/changes', tag: TAG, status: 201,
  summary: 'Ask the organiser to change the answers of a submitted registration. Nothing changes until staff approve it; the original answers and the request stay on record. One pending request at a time. Changes follow the same form rules (a change to a quota question needs a free place in the new bucket).',
  input: z.object({ id, answers: answersIn, reason: txt(500).min(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await entryAccess(c, user, i.id, { lock: true });
      const { e, p } = a;
      if (!a.party) throw notFound('Registration');
      if (!['submitted', 'under_review', 'approved'].includes(e.status)) throw conflict('Changes can be requested on a submitted registration');
      if ((await c.query("SELECT 1 FROM rx_changes WHERE entry_id=$1 AND status='pending'", [e.id])).rows[0]) throw conflict('A change request is already waiting for a decision', { code: 'change_pending' });
      const ver = await versionOf(c, p.id, e.version);
      const merged = cleanAnswers(ver.form, { ...e.answers, ...(e.confidential_enc ? JSON.parse(decrypt(e.confidential_enc, ANSWERS)) : {}), ...i.answers }, await fileCounts(c, e.id), true);
      const row = (await c.query('INSERT INTO rx_changes(entry_id, requested_by, changes_enc, reason_enc) VALUES ($1,$2,$3,$4) RETURNING id', [e.id, user.id, encrypt(JSON.stringify({ answers: merged }), CHANGE), encrypt(i.reason, CHANGE_REASON)])).rows[0];
      await history(c, e.id, 'change_requested', e.status, e.status, user.id, i.reason);
      if (p.owner_id !== user.id) await tell(c, p.owner_id, e, p, `A change was requested: ${p.title}`, i.reason);
      return { id: row.id, entry_id: e.id, status: 'pending' };
    });
  },
});

cap({
  name: 'decide_registration_change', method: 'POST', path: '/registration-changes/:id/decision', tag: TAG,
  summary: 'Staff: approve or reject a change request. Approving re-validates the new answers against the form and the quota buckets and then replaces the answers (the earlier answers stay in the history); rejecting leaves the registration untouched. The applicant is told either way.',
  input: z.object({ id, approve: z.boolean(), note: txt(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ch = (await c.query('SELECT * FROM rx_changes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ch) throw notFound('Change request');
      const a0 = await entryAccess(c, user, ch.entry_id);
      if (!a0.staff) throw notFound('Change request');
      const p = await getProgramme(c, a0.p.id, { lock: true });
      const { e } = await entryAccess(c, user, ch.entry_id, { lock: true });
      if (ch.status !== 'pending') throw conflict(`This request is already ${ch.status}`);
      if (!i.approve && !(i.note && i.note.length >= 3)) throw badRequest('Give the applicant a reason');
      if (i.approve) {
        const ver = await versionOf(c, p.id, e.version);
        const next = JSON.parse(decrypt(ch.changes_enc, CHANGE)).answers;
        cleanAnswers(ver.form, next, await fileCounts(c, e.id), true);
        const { open, enc } = seal(ver.form, next);
        if (SEAT_STATUSES.includes(e.status) && !(await fits(c, p, { ...e, answers: open })).ok) throw conflict('There is no free place in the requested option', { code: 'quota' });
        await c.query('UPDATE rx_entries SET answers=$2, confidential_enc=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', [e.id, JSON.stringify(open), enc]);
      }
      await c.query('UPDATE rx_changes SET status=$2, decided_by=$3, decided_at=now(), decision_note_enc=$4 WHERE id=$1', [ch.id, i.approve ? 'approved' : 'rejected', user.id, i.note ? encrypt(i.note, CHANGE_NOTE) : null]);
      await history(c, e.id, i.approve ? 'change_approved' : 'change_rejected', e.status, e.status, user.id, i.note);
      for (const u of recipients(e)) await tell(c, u, e, p, `Change ${i.approve ? 'approved' : 'declined'}: ${p.title}`, i.note);
      return { id: ch.id, status: i.approve ? 'approved' : 'rejected' };
    });
  },
});

// ------------------------------------------------------------------ consolidation parity

cap({
  name: 'get_registration_mirror_report', method: 'GET', path: '/admin/registration-mirror', tag: TAG, auth: ['admin'],
  summary: 'Platform team: parity of the engine\'s read-only mirror against the legacy flows it consolidates (competition roster registrations and academy admissions): legacy rows, mirrored rows, rows missing from the mirror, rows whose mapped status differs, and history rows still to mirror. All zero means the backfill and the live triggers agree. Read-only.',
  async handler() {
    const one1 = async (sql) => Number((await one(sql)).n);
    const roster = { legacy: await one1('SELECT count(*) AS n FROM reg_registrations'), mirrored: await one1("SELECT count(*) AS n FROM rx_entries WHERE legacy_type='roster_registration'"),
      missing: await one1("SELECT count(*) AS n FROM reg_registrations r WHERE NOT EXISTS (SELECT 1 FROM rx_entries e WHERE e.legacy_type='roster_registration' AND e.legacy_id=r.id)"),
      status_mismatch: await one1("SELECT count(*) AS n FROM reg_registrations r JOIN rx_entries e ON e.legacy_type='roster_registration' AND e.legacy_id=r.id WHERE e.status <> rx_map_roster_status(r.status)"),
      history_missing: await one1('SELECT count(*) AS n FROM reg_history h WHERE NOT EXISTS (SELECT 1 FROM rx_history x WHERE x.legacy_id=h.id)') };
    const academy = { legacy: await one1('SELECT count(*) AS n FROM academy_applications'), mirrored: await one1("SELECT count(*) AS n FROM rx_entries WHERE legacy_type='academy_application'"),
      missing: await one1("SELECT count(*) AS n FROM academy_applications a WHERE NOT EXISTS (SELECT 1 FROM rx_entries e WHERE e.legacy_type='academy_application' AND e.legacy_id=a.id)"),
      status_mismatch: await one1("SELECT count(*) AS n FROM academy_applications a JOIN rx_entries e ON e.legacy_type='academy_application' AND e.legacy_id=a.id WHERE e.status <> rx_map_academy_stage(a.stage)"),
      history_missing: await one1('SELECT count(*) AS n FROM academy_application_events h WHERE NOT EXISTS (SELECT 1 FROM rx_history x WHERE x.legacy_id=h.id)') };
    const ok = [roster, academy].every((x) => !x.missing && !x.status_mismatch && !x.history_missing && x.legacy === x.mirrored);
    return { in_parity: ok, roster_registrations: roster, academy_applications: academy, not_mirrored: ['sponsorship_applications (applications for money, not participant registrations)'] };
  },
});

// ------------------------------------------------------------------ uploads

cap({
  name: 'remove_registration_file', method: 'DELETE', path: '/registration-files/:id', tag: TAG,
  summary: 'Hide a file you uploaded to a draft (or to a registration that was sent back). The file stays on record but nobody can open it any more. Upload with PUT /registration-entries/{id}/files?field=KEY&name=FILENAME (the raw PDF or photo as the body); download with GET /registration-files/{id}.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM rx_documents WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('File');
      const a = await entryAccess(c, user, f.entry_id);
      if (!a.party) throw notFound('File');
      if (!OPEN_FOR_EDIT.includes(a.e.status)) throw conflict('Files can only be removed while the registration is a draft or sent back');
      await c.query('UPDATE rx_documents SET removed_at=now() WHERE id=$1', [f.id]);
      await audit(c, user.id, 'remove_registration_file', 'rx_documents', f.id);
      return { id: f.id, removed: true };
    });
  },
});

const FILES_PER_ENTRY = 20;
/** Binary routes: raw upload/download of registration documents. Same auth and the same live access checks as the capabilities. */
export function registrationFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 40 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // PUT /api/v1/registration-entries/:id/files?field=KEY&name=FILE   body = the raw file
  r.put('/registration-entries/:id/files', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const field = String(req.query.field ?? '');
      const a = await entryAccess(pool, user, uuid(req.params.id, 'Registration'));
      if (!a.party) throw notFound('Registration');
      if (!OPEN_FOR_EDIT.includes(a.e.status)) throw conflict('Files can only be added to a draft or a registration that was sent back');
      const ver = await versionOf(pool, a.p.id, a.e.version);
      const f = fieldsOf(ver.form).find((x) => x.key === field && x.type === 'file');
      if (!f) throw badRequest('That question does not take files');
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF photo.');
      const counts = await fileCounts(pool, a.e.id);
      if ((counts[field] ?? 0) >= (f.max_files ?? 5)) throw badRequest(`"${f.label}" takes up to ${f.max_files ?? 5} files`);
      if (Object.values(counts).reduce((s, n) => s + n, 0) >= FILES_PER_ENTRY) throw badRequest(`A registration can have up to ${FILES_PER_ENTRY} files`);
      const { id: fid, file } = await saveEncrypted('registrations', 'rx_documents.file', buf);
      const { createHash } = await import('node:crypto');
      const row = await one(
        `INSERT INTO rx_documents(id, entry_id, field_key, uploaded_by, content_type, file_name, original_name, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, entry_id, field_key, original_name, content_type, size_bytes, created_at`, [fid, a.e.id, field, user.id, t.type, file, String(req.query.name ?? '').slice(0, 160) || null, buf.length, createHash('sha256').update(buf).digest('hex')]);
      await audit(null, user.id, 'upload_registration_file', 'rx_documents', fid);
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  r.get('/registration-files/:id', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const f = await one('SELECT * FROM rx_documents WHERE id=$1 AND removed_at IS NULL', [uuid(req.params.id, 'File')]);
      if (!f) throw notFound('File');
      const a = await entryAccess(pool, user, f.entry_id);
      const bytes = await loadEncrypted('registrations', 'rx_documents.file', f.file_name);
      if (!a.party) await audit(null, user.id, 'read_registration_file', 'rx_documents', f.id);
      res.set(docHeaders(f.content_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('File') : e); }
  });
  return r;
}
