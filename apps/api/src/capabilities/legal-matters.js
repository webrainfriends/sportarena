// Legal Services (issue #231), part 2: private intake with conflict checks, versioned quotes, engagement and matter activation.
// Four separate steps, none implied by another: quote accepted -> engagement signed -> lawyer confirms -> conflict clear and credential
// current -> matter activated. Posting, chatting, booking or paying never creates a professional relationship.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { blindIndex, decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';
import { canManageTeam } from './teams.js';
import { hasOrgGrant } from '../org-access.js';
import { FEE_MODELS, PACK_CODES, PACK_VERSION, PRACTICE_AREAS } from '../legal/packs.js';
import { latestConflict, norm, requireCredential, requireFeature } from '../legal/core.js';

const TAG = 'Legal';
const country = z.string().trim().toUpperCase().refine((v) => PACK_CODES.includes(v), { message: `Choose from: ${PACK_CODES.join(', ')}` });
const area = z.enum(Object.keys(PRACTICE_AREAS));
const party = z.object({ role: z.enum(['client', 'counterparty', 'other']), name: z.string().trim().min(2).max(160) });
const CTX = 'legal_intake_parties.name';

// ---------- helpers ----------

async function lockIntake(c, intakeId) {
  const r = (await c.query('SELECT * FROM legal_intakes WHERE id=$1 FOR UPDATE', [intakeId])).rows[0];
  if (!r) throw notFound('Intake');
  return r;
}
/** Intake visible to its client or its lawyer only. Platform admins and support get a 404 like everybody else. */
async function mineIntake(c, user, intakeId, as) {
  const r = await lockIntake(c, intakeId);
  const ok = as === 'lawyer' ? r.lawyer_id === user.id : as === 'client' ? r.client_id === user.id : (r.lawyer_id === user.id || r.client_id === user.id);
  if (!ok) throw notFound('Intake');
  return r;
}
const setStatus = (c, intakeId, status) => c.query('UPDATE legal_intakes SET status=$2, updated_at=now() WHERE id=$1', [intakeId, status]);

/** Add names, then flag any name this lawyer already holds in another client's intake. Identities are never returned, only a count. */
async function addParties(c, intake, parties) {
  let matches = 0;
  for (const p of parties) {
    const idx = blindIndex(norm(p.name));
    await c.query('INSERT INTO legal_intake_parties(intake_id, lawyer_id, role, name_enc, name_idx) VALUES ($1,$2,$3,$4,$5)', [intake.id, intake.lawyer_id, p.role, encrypt(p.name, CTX), idx]);
    matches += (await c.query(
      `SELECT count(DISTINCT x.intake_id)::int AS n FROM legal_intake_parties x JOIN legal_intakes i ON i.id=x.intake_id
        WHERE x.lawyer_id=$1 AND x.name_idx=$2 AND x.intake_id <> $3 AND i.client_id <> $4`, [intake.lawyer_id, idx, intake.id, intake.client_id])).rows[0].n;
  }
  return matches;
}
const flag = (c, intakeId, matches) => c.query("INSERT INTO legal_conflict_checks(intake_id, outcome, match_count) VALUES ($1,'requires_review',$2)", [intakeId, matches]);

const view = (i, as, extra = {}) => ({
  id: i.id, practice_area: i.practice_area, practice_area_label: PRACTICE_AREAS[i.practice_area], jurisdiction: i.jurisdiction, acting_as: i.acting_as, acting_for_id: i.acting_for_id, payer: i.payer,
  status: i.status, created_at: i.created_at, updated_at: i.updated_at, request_id: i.request_id,
  ...(as === 'lawyer' ? { client_id: i.client_id, client_name: i.client_name } : { lawyer_id: i.lawyer_id, lawyer_name: i.lawyer_name }), ...extra,
});

// ---------- intake and conflicts ----------

cap({
  name: 'start_legal_intake', method: 'POST', path: '/legal/intakes', tag: TAG, status: 201,
  summary: 'Ask one verified lawyer for a consultation, privately. State who the legal client is (yourself, or a team / organisation / event you manage) and who pays, give a short summary and the names needed for the conflict check (you as client, the counterparty). Nothing is shared with other lawyers. The lawyer must hold a current credential for the practice area in that jurisdiction, and the country\'s `intake` workflow must be approved. This does not create an engagement.',
  input: z.object({ lawyer_id: id, practice_area: area, jurisdiction: country, request_id: id.optional(), acting_as: z.enum(['self', 'team', 'organisation', 'event']).default('self'), acting_for_id: id.optional(), payer: z.enum(['client', 'third_party']).default('client'), summary: z.string().trim().min(10).max(2000).describe('What you need help with. Private: only the lawyer sees it.'), parties: z.array(party).min(1).max(12).refine((a) => a.some((p) => p.role === 'client'), { message: 'Include the legal client\'s name' }) }),
  async handler({ user }, i) {
    if (i.lawyer_id === user.id) throw badRequest('You cannot instruct yourself');
    if (await isYouth(user.id)) throw forbidden('A parent or guardian must instruct counsel for a minor');
    await requireFeature(i.jurisdiction, 'intake');
    await requireCredential(i.lawyer_id, i.jurisdiction, i.practice_area);
    if (i.acting_as !== 'self') {
      if (!i.acting_for_id) throw badRequest('Say which team, organisation or event you are instructing for');
      const ok = i.acting_as === 'team' ? await one('SELECT * FROM teams WHERE id=$1', [i.acting_for_id]).then((t) => t && canManageTeam(user, t))
        : i.acting_as === 'organisation' ? await hasOrgGrant(user, i.acting_for_id, ['owner', 'admin'])
        : !!(await one('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [i.acting_for_id, user.id]));
      if (!ok) throw forbidden('You do not hold authority to instruct counsel for that. Staffing or funding something does not give you that authority.');
    }
    return tx(async (c) => {
      const lawyer = (await c.query("SELECT 1 FROM users WHERE id=$1 AND 'lawyer' = ANY(roles)", [i.lawyer_id])).rows[0];
      if (!lawyer) throw notFound('Lawyer');
      const row = (await c.query('INSERT INTO legal_intakes(client_id, lawyer_id, request_id, practice_area, jurisdiction, acting_as, acting_for_id, payer, summary_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [user.id, i.lawyer_id, i.request_id ?? null, i.practice_area, i.jurisdiction, i.acting_as, i.acting_for_id ?? null, i.payer, encrypt(i.summary, 'legal_intakes.summary')])).rows[0];
      const n = await addParties(c, row, i.parties);
      await flag(c, row.id, n);
      await setStatus(c, row.id, 'conflict_review');
      await audit(c, user.id, 'start_legal_intake', 'legal_intakes', row.id);
      await notify(c, i.lawyer_id, { kind: 'legal_intake', title: 'New consultation request', body: 'Open Legal → Consultations. A conflict check is needed before you reply.', data: { intake_id: row.id } });
      return { ...view({ ...row, status: 'conflict_review' }, 'client'), next: 'The lawyer runs a conflict check first. You will be told when they can proceed or decline. No engagement exists yet.' };
    });
  },
});

cap({
  name: 'list_legal_intakes', method: 'GET', path: '/legal/intakes', tag: TAG, scope: 'read',
  summary: 'Your consultation requests: as the client (default) or, for a lawyer, those addressed to you (`as=lawyer`). Summaries and names are not included here.',
  input: z.object({ as: z.enum(['client', 'lawyer']).default('client'), status: z.string().optional(), ...page }),
  async handler({ user }, i) {
    if (i.as === 'lawyer' && !user.roles.includes('lawyer')) throw forbidden('Add the lawyer role first');
    const rows = await many(
      `SELECT i.*, cu.display_name AS client_name, lu.display_name AS lawyer_name FROM legal_intakes i JOIN users cu ON cu.id=i.client_id JOIN users lu ON lu.id=i.lawyer_id
        WHERE ${i.as === 'lawyer' ? 'i.lawyer_id' : 'i.client_id'}=$1 AND ($2::text IS NULL OR i.status=$2) ORDER BY i.created_at DESC, i.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]);
    return rows.map((r) => view(r, i.as));
  },
});

cap({
  name: 'get_legal_intake', method: 'GET', path: '/legal/intakes/:id', tag: TAG, scope: 'read',
  summary: 'One consultation request. The client sees their own summary, the names they gave, the conflict state in words and any quotes; the lawyer also sees the conflict history, match count and reasons. Never anyone else\'s client identity. Reads are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT i.*, cu.display_name AS client_name, lu.display_name AS lawyer_name FROM legal_intakes i JOIN users cu ON cu.id=i.client_id JOIN users lu ON lu.id=i.lawyer_id WHERE i.id=$1', [i.id]);
    if (!r || (r.client_id !== user.id && r.lawyer_id !== user.id)) throw notFound('Intake');
    const as = r.lawyer_id === user.id ? 'lawyer' : 'client';
    const [parties, checks, quotes, eng, matter] = await Promise.all([
      many('SELECT role, name_enc, created_at FROM legal_intake_parties WHERE intake_id=$1 ORDER BY created_at, id', [r.id]),
      many('SELECT * FROM legal_conflict_checks WHERE intake_id=$1 ORDER BY id', [r.id]),
      many('SELECT * FROM legal_quotes WHERE intake_id=$1 ORDER BY version', [r.id]),
      one('SELECT * FROM legal_engagements WHERE intake_id=$1', [r.id]),
      one('SELECT id, status FROM legal_matters WHERE intake_id=$1', [r.id]),
    ]);
    await audit(null, user.id, 'read_legal_intake', 'legal_intakes', r.id);
    const last = checks.at(-1);
    return view(r, as, {
      summary: decrypt(r.summary_enc, 'legal_intakes.summary'),
      parties: parties.map((p) => ({ role: p.role, name: decrypt(p.name_enc, CTX), added_at: p.created_at })),
      conflict: { state: last?.outcome ?? 'requires_review', checked_at: last?.created_at ?? null, ...(as === 'lawyer' ? { match_count: last?.match_count ?? 0, history: checks.map((k) => ({ outcome: k.outcome, match_count: k.match_count, reviewed_by_you: k.reviewer_id === user.id, reason: decrypt(k.reason_enc, 'legal_conflict_checks.reason'), at: k.created_at })) } : {}) },
      quotes: quotes.map(quoteOut), engagement: eng && engOut(eng), matter,
    });
  },
});

cap({
  name: 'add_legal_intake_party', method: 'POST', path: '/legal/intakes/:id/parties', tag: TAG,
  summary: 'Add a name that is now involved (a new counterparty, a co-claimant). A material change re-runs the conflict check and puts the intake back into review; a quote already sent must wait for the lawyer to clear it again. Not possible once the matter is engaged.',
  input: z.object({ id, party }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id);
      if (['declined', 'withdrawn', 'engaged', 'conflict_blocked'].includes(r.status)) throw conflict(`This intake is ${r.status.replace('_', ' ')}`);
      const n = await addParties(c, r, [i.party]);
      await flag(c, r.id, n);
      await setStatus(c, r.id, 'conflict_review');
      await audit(c, user.id, 'add_legal_intake_party', 'legal_intakes', r.id);
      return { id: r.id, status: 'conflict_review' };
    });
  },
});

cap({
  name: 'review_legal_conflict', method: 'POST', path: '/legal/intakes/:id/conflict', tag: TAG, auth: ['lawyer'],
  summary: 'Lawyer: record the conflict decision - clear, blocked, or waived - with a reason (reviewer and time are kept; history is append-only). The automatic name match is only a flag. A waiver needs a reason of at least 20 characters and means informed consent is recorded outside the platform. Blocked ends the intake: no quote, engagement or matter can follow. The client is told only that the lawyer cannot act.',
  input: z.object({ id, outcome: z.enum(['clear', 'blocked', 'waived']), reason: z.string().trim().min(5).max(2000) }),
  async handler({ user }, i) {
    if (i.outcome === 'waived' && i.reason.length < 20) throw badRequest('Describe the waiver: who consented, to what, and where it is recorded (at least 20 characters)');
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'lawyer');
      if (!['conflict_review', 'ready'].includes(r.status)) throw conflict(`Intake is ${r.status.replace('_', ' ')}: nothing to review`);
      const last = await latestConflict(c, r.id);
      await c.query('INSERT INTO legal_conflict_checks(intake_id, outcome, match_count, reviewer_id, reason_enc) VALUES ($1,$2,$3,$4,$5)', [r.id, i.outcome, last?.match_count ?? 0, user.id, encrypt(i.reason, 'legal_conflict_checks.reason')]);
      await setStatus(c, r.id, i.outcome === 'blocked' ? 'conflict_blocked' : 'ready');
      if (i.outcome === 'blocked') await c.query("UPDATE legal_quotes SET status='withdrawn' WHERE intake_id=$1 AND status='sent'", [r.id]);
      await audit(c, user.id, 'review_legal_conflict', 'legal_intakes', r.id);
      await notify(c, r.client_id, i.outcome === 'blocked'
        ? { kind: 'legal_intake', title: 'This lawyer cannot act for you', body: 'You can look for other counsel under Legal → Find Counsel. Your details stay confidential.', data: { intake_id: r.id } }
        : { kind: 'legal_intake', title: 'Your consultation request can go ahead', body: 'The lawyer can now reply. No engagement exists until you accept a quote and sign.', data: { intake_id: r.id } });
      return { id: r.id, status: i.outcome === 'blocked' ? 'conflict_blocked' : 'ready', outcome: i.outcome };
    });
  },
});

cap({
  name: 'decline_legal_intake', method: 'POST', path: '/legal/intakes/:id/decline', tag: TAG, auth: ['lawyer'],
  summary: 'Lawyer: decline a consultation request. What the client shared stays protected like any prospective client\'s information.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'lawyer');
      if (['declined', 'withdrawn', 'engaged'].includes(r.status)) throw conflict(`Intake is already ${r.status}`);
      await c.query("UPDATE legal_intakes SET status='declined', declined_at=now(), updated_at=now() WHERE id=$1", [r.id]);
      await c.query("UPDATE legal_quotes SET status='withdrawn' WHERE intake_id=$1 AND status IN ('sent','accepted')", [r.id]);
      await notify(c, r.client_id, { kind: 'legal_intake', title: 'The lawyer cannot take this on', body: 'You can look for other counsel under Legal → Find Counsel.', data: { intake_id: r.id } });
      return { id: r.id, status: 'declined' };
    });
  },
});

cap({
  name: 'withdraw_legal_intake', method: 'POST', path: '/legal/intakes/:id/withdraw', tag: TAG,
  summary: 'Client: withdraw a consultation request before a matter exists. Kept, not deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'client');
      if (['declined', 'withdrawn', 'engaged'].includes(r.status)) throw conflict(`Intake is already ${r.status}`);
      await c.query("UPDATE legal_intakes SET status='withdrawn', updated_at=now() WHERE id=$1", [r.id]);
      await c.query("UPDATE legal_quotes SET status='withdrawn' WHERE intake_id=$1 AND status IN ('sent','accepted')", [r.id]);
      return { id: r.id, status: 'withdrawn' };
    });
  },
});

// ---------- quotes ----------

const quoteOut = (q) => ({
  id: q.id, intake_id: q.intake_id, version: q.version, fee_model: q.fee_model, fee_model_label: FEE_MODELS[q.fee_model], amount_cents: q.amount_cents, is_estimate: q.is_estimate, currency: q.currency,
  tax_cents: q.tax_cents, disbursements_cents: q.disbursements_cents, total_cents: q.amount_cents + q.tax_cents + q.disbursements_cents,
  scope: decrypt(q.scope_enc, 'legal_quotes.scope'), exclusions: decrypt(q.exclusions_enc, 'legal_quotes.exclusions'), expires_at: q.expires_at, status: q.status, accepted_at: q.accepted_at, created_at: q.created_at,
});

cap({
  name: 'create_legal_quote', method: 'POST', path: '/legal/intakes/:id/quotes', tag: TAG, auth: ['lawyer'], status: 201,
  summary: 'Lawyer: send a quote once the conflict check is clear. State the fee model (flat, hourly, capped, milestone or retainer - contingency is not offered), whether the amount is an estimate or fixed, currency, tax and disbursements, scope and exclusions, and an expiry. Each change is a new version that supersedes the last and needs a new acceptance. A retainer here is an agreed fee concept, not client money held by the platform. Needs the country\'s `quotes` workflow and your current verified credential.',
  input: z.object({ id, fee_model: z.enum(Object.keys(FEE_MODELS)), amount_cents: z.number().int().min(0).max(1e10), is_estimate: z.boolean(), currency: z.string().trim().toUpperCase().length(3), tax_cents: z.number().int().min(0).max(1e10).default(0), disbursements_cents: z.number().int().min(0).max(1e10).default(0), scope: z.string().trim().min(10).max(4000), exclusions: z.string().trim().max(2000).optional(), expires_at: z.string().datetime({ offset: true }) }),
  async handler({ user }, i) {
    if (Date.parse(i.expires_at) <= Date.now() + 6e4) throw badRequest('Choose an expiry in the future');
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'lawyer');
      if (r.status !== 'ready') throw conflict(r.status === 'conflict_review' ? 'Clear the conflict check before quoting' : `Intake is ${r.status.replace('_', ' ')}: no quote can be sent`);
      await requireFeature(r.jurisdiction, 'quotes', c);
      await requireCredential(user.id, r.jurisdiction, r.practice_area, c);
      if ((await c.query("SELECT 1 FROM legal_engagements WHERE intake_id=$1", [r.id])).rowCount) throw conflict('An engagement is already signed for this intake');
      const v = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM legal_quotes WHERE intake_id=$1', [r.id])).rows[0].v;
      await c.query("UPDATE legal_quotes SET status='superseded' WHERE intake_id=$1 AND status IN ('sent','accepted')", [r.id]);
      const q = (await c.query('INSERT INTO legal_quotes(intake_id, version, lawyer_id, fee_model, amount_cents, is_estimate, currency, tax_cents, disbursements_cents, scope_enc, exclusions_enc, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [r.id, v, user.id, i.fee_model, i.amount_cents, i.is_estimate, i.currency, i.tax_cents, i.disbursements_cents, encrypt(i.scope, 'legal_quotes.scope'), encrypt(i.exclusions, 'legal_quotes.exclusions'), i.expires_at])).rows[0];
      await notify(c, r.client_id, { kind: 'legal_quote', title: v > 1 ? 'Updated quote' : 'You have a quote', body: 'Open Legal → Consultations to read it. Accepting a quote does not by itself start the engagement.', data: { intake_id: r.id, quote_id: q.id } });
      return quoteOut(q);
    });
  },
});

cap({
  name: 'accept_legal_quote', method: 'POST', path: '/legal/quotes/:id/accept', tag: TAG,
  summary: 'Client: accept one exact quote version (send the `version` you read). Refused if a newer version exists, the quote expired, the conflict check is no longer clear, or the lawyer\'s credential has lapsed. Accepting a quote is not the engagement: the engagement still has to be signed and confirmed.',
  input: z.object({ id, version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM legal_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q) throw notFound('Quote');
      const r = await mineIntake(c, user, q.intake_id, 'client');
      if (q.version !== i.version) throw conflict(`You read version ${i.version}, but this quote is version ${q.version}`);
      if (q.status !== 'sent') throw conflict(`This quote is ${q.status}`);
      if (Date.parse(q.expires_at) < Date.now()) throw conflict('This quote has expired. Ask the lawyer for a new one.');
      if (r.status !== 'ready') throw conflict('The conflict check is not clear, so this quote cannot be accepted');
      await requireCredential(q.lawyer_id, r.jurisdiction, r.practice_area, c);
      await c.query("UPDATE legal_quotes SET status='accepted', accepted_at=now(), accepted_by=$2 WHERE id=$1", [q.id, user.id]);
      await notify(c, q.lawyer_id, { kind: 'legal_quote', title: 'Quote accepted', body: 'The client must now sign the engagement terms; you then confirm and activate the matter.', data: { intake_id: r.intake_id } });
      return { ...quoteOut({ ...q, status: 'accepted', accepted_at: new Date().toISOString() }), next: 'Sign the engagement terms to continue. No professional relationship exists yet.' };
    });
  },
});

// ---------- engagement and matter ----------

const engOut = (e) => ({ id: e.id, intake_id: e.intake_id, quote_id: e.quote_id, quote_version: e.quote_version, terms_version: e.terms_version, signer_capacity: e.signer_capacity, signed_at: e.signed_at, lawyer_confirmed_at: e.lawyer_confirmed_at });

cap({
  name: 'sign_legal_engagement', method: 'POST', path: '/legal/intakes/:id/engagement', tag: TAG, status: 201,
  summary: 'Client: sign the engagement terms for the accepted quote version, stating your capacity (client, authorised representative, guardian). The record keeps the exact quote version, the terms version, who signed in what capacity and when. This is an in-app acceptance only: court or formal instruments that need another form of execution must be executed outside the platform. Needs the country\'s `engagement` workflow.',
  input: z.object({ id, quote_version: z.number().int().min(1), capacity: z.enum(['client', 'authorised_representative', 'guardian']), accept_terms: z.literal(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'client');
      if (r.status !== 'ready') throw conflict('The conflict check is not clear, so the engagement cannot be signed');
      await requireFeature(r.jurisdiction, 'engagement', c);
      const q = (await c.query("SELECT * FROM legal_quotes WHERE intake_id=$1 AND status='accepted'", [r.id])).rows[0];
      if (!q) throw conflict('Accept a quote first');
      if (q.version !== i.quote_version) throw conflict(`The accepted quote is version ${q.version}, not ${i.quote_version}`);
      if (i.capacity !== 'client' && r.acting_as === 'self') throw badRequest('You instruct for yourself: sign as the client');
      await requireCredential(q.lawyer_id, r.jurisdiction, r.practice_area, c);
      const e = (await c.query('INSERT INTO legal_engagements(intake_id, quote_id, quote_version, terms_version, signer_id, signer_capacity) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (intake_id) DO NOTHING RETURNING *',
        [r.id, q.id, q.version, `${r.jurisdiction}-v${PACK_VERSION}`, user.id, i.capacity])).rows[0];
      if (!e) throw conflict('The engagement is already signed');
      await notify(c, q.lawyer_id, { kind: 'legal_engagement', title: 'Engagement signed by the client', body: 'Confirm the engagement and activate the matter when you are ready.', data: { intake_id: r.id } });
      return { ...engOut(e), next: 'The lawyer confirms the engagement and activates the matter. The professional relationship begins then, not before.' };
    });
  },
});

cap({
  name: 'confirm_legal_engagement', method: 'POST', path: '/legal/intakes/:id/engagement/confirm', tag: TAG, auth: ['lawyer'],
  summary: 'Lawyer: confirm the signed engagement. Re-checks your credential for this jurisdiction and practice area and the conflict state; a lapsed credential or an uncleared conflict stops it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'lawyer');
      if (r.status !== 'ready') throw conflict('The conflict check is not clear');
      await requireFeature(r.jurisdiction, 'engagement', c);
      await requireCredential(user.id, r.jurisdiction, r.practice_area, c);
      const e = (await c.query('UPDATE legal_engagements SET lawyer_confirmed_at=now(), lawyer_confirmed_by=$2 WHERE intake_id=$1 AND lawyer_confirmed_at IS NULL RETURNING *', [r.id, user.id])).rows[0];
      if (!e) throw conflict('There is no signed engagement waiting for your confirmation');
      return engOut(e);
    });
  },
});

const matterOut = (m) => ({ id: m.id, intake_id: m.intake_id, title: m.title, jurisdiction: m.jurisdiction, status: m.status, client_id: m.client_id, client_name: m.client_name, lawyer_id: m.lawyer_id, lawyer_name: m.lawyer_name, activated_at: m.activated_at, closed_at: m.closed_at });

cap({
  name: 'activate_legal_matter', method: 'POST', path: '/legal/intakes/:id/matter', tag: TAG, auth: ['lawyer'], status: 201,
  summary: 'Lawyer: open the matter. Allowed only when the conflict check is clear or waived, the client has signed the accepted quote version, you have confirmed the engagement, and your credential is current. This is the moment the professional relationship begins; booking, messaging or payment before it never did.',
  input: z.object({ id, title: z.string().trim().min(3).max(140) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await mineIntake(c, user, i.id, 'lawyer');
      if (r.status !== 'ready') throw conflict(`Intake is ${r.status.replace('_', ' ')}: conflict must be clear or waived`);
      const last = await latestConflict(c, r.id);
      if (!last || !['clear', 'waived'].includes(last.outcome)) throw conflict('The latest conflict check is not clear or waived');
      await requireFeature(r.jurisdiction, 'engagement', c);
      await requireCredential(user.id, r.jurisdiction, r.practice_area, c);
      const e = (await c.query('SELECT * FROM legal_engagements WHERE intake_id=$1', [r.id])).rows[0];
      if (!e) throw conflict('The client has not signed an engagement');
      if (!e.lawyer_confirmed_at) throw conflict('Confirm the engagement first');
      const q = (await c.query('SELECT status FROM legal_quotes WHERE id=$1', [e.quote_id])).rows[0];
      if (q.status !== 'accepted') throw conflict('The signed quote is no longer current');
      const m = (await c.query('INSERT INTO legal_matters(intake_id, engagement_id, client_id, lawyer_id, title, jurisdiction) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [r.id, e.id, r.client_id, r.lawyer_id, i.title, r.jurisdiction])).rows[0];
      await setStatus(c, r.id, 'engaged');
      await audit(c, user.id, 'activate_legal_matter', 'legal_matters', m.id);
      await notify(c, r.client_id, { kind: 'legal_matter', title: 'Your matter is open', body: 'Open Legal → My Matters.', data: { matter_id: m.id } });
      return matterOut(m);
    });
  },
});

cap({
  name: 'list_my_legal_matters', method: 'GET', path: '/legal/matters', tag: TAG, scope: 'read',
  summary: 'Matters you are the client or the responsible lawyer on. Platform admins and support see only their own, like everyone else.',
  input: z.object({ as: z.enum(['client', 'lawyer']).default('client'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT m.*, cu.display_name AS client_name, lu.display_name AS lawyer_name FROM legal_matters m JOIN users cu ON cu.id=m.client_id JOIN users lu ON lu.id=m.lawyer_id
        WHERE ${i.as === 'lawyer' ? 'm.lawyer_id' : 'm.client_id'}=$1 ORDER BY m.activated_at DESC, m.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    return rows.map(matterOut);
  },
});

cap({
  name: 'get_legal_matter', method: 'GET', path: '/legal/matters/:id', tag: TAG, scope: 'read',
  summary: 'One matter (client or responsible lawyer only) with its engagement and the accepted quote version.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one('SELECT m.*, cu.display_name AS client_name, lu.display_name AS lawyer_name FROM legal_matters m JOIN users cu ON cu.id=m.client_id JOIN users lu ON lu.id=m.lawyer_id WHERE m.id=$1', [i.id]);
    if (!m || (m.client_id !== user.id && m.lawyer_id !== user.id)) throw notFound('Matter');
    const [e, q] = await Promise.all([one('SELECT * FROM legal_engagements WHERE id=$1', [m.engagement_id]), one('SELECT * FROM legal_quotes WHERE id=(SELECT quote_id FROM legal_engagements WHERE id=$1)', [m.engagement_id])]);
    await audit(null, user.id, 'read_legal_matter', 'legal_matters', m.id);
    return { ...matterOut(m), engagement: engOut(e), quote: quoteOut(q) };
  },
});
