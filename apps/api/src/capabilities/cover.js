// Cover: another person or organisation pays your bills (a sponsor, a club, a family member, a friend) under an agreement both sides approve.
// Request it or offer it; the other side approves; then bills reach the payer automatically or one by one. One time, for a period, or unlimited, with
// optional per-bill and total caps. Either side can end it at any time and the next use is refused. See docs/cover-payments.md.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { isSupportedCurrency } from '../currency.js';
import { notify } from '../notify.js';
import { isYouth, NOT_YOUTH_SQL } from '../youth.js';
import { describePurpose } from '../payments/service.js';
import {
  COVER_KINDS, billLabel, billsFor, beneficiarySide, isLive, logEvent, notifyPayers, orgsOf, payerMandates, payerName, payerRecipients, payerSide, usage, whyNot,
} from '../cover.js';

const TAG = 'Cover';
const db = { query: async (q, a) => { const rows = await many(q, a); return { rows, rowCount: rows.length }; } };
const today = () => new Date().toISOString().slice(0, 10);

const terms = {
  purposes: z.array(z.enum(COVER_KINDS)).min(1).describe('which kinds of bill the payer will cover'),
  term: z.enum(['one_time', 'duration', 'unlimited']).describe('one_time = a single payment; duration = until valid_until; unlimited = until someone ends it'),
  valid_until: z.string().date().optional(),
  bill: z.object({ purpose_type: z.enum(COVER_KINDS), purpose_id: id }).optional().describe('cover exactly this one bill (always one time)'),
  auto_send: z.boolean().default(false).describe('true: every open bill in scope reaches the payer on its own; false: only bills the beneficiary sends'),
  currency: z.string().length(3).transform((x) => x.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency').optional(),
  max_per_bill_minor: z.number().int().min(1).optional(),
  max_total_minor: z.number().int().min(1).optional(),
  sponsorship_id: id.optional().describe('link an active sponsorship of the payer that names the beneficiary'),
  note: z.string().trim().max(300).optional(),
};

/** Validate the terms and the bill/sponsorship links; returns the row values. */
async function normalise(c, i, { beneficiaryId, payerUserId, payerOrgId }) {
  if (i.term === 'duration' && !i.valid_until) throw badRequest('Choose the date the cover runs until');
  if (i.valid_until && i.valid_until < today()) throw badRequest('That end date has passed');
  if (i.term !== 'duration' && i.valid_until) throw badRequest('An end date only applies to a cover for a period');
  let purposes = i.purposes, term = i.term, currency = i.currency ?? null, billType = null, billId = null, auto = i.auto_send;
  if (i.bill) {
    const d = await describePurpose(c, i.bill.purpose_type, i.bill.purpose_id);
    if (!d || d.payerId !== beneficiaryId) throw notFound('Bill');
    if (!d.payable) throw conflict('That bill cannot be paid right now');
    purposes = [i.bill.purpose_type]; term = 'one_time'; billType = i.bill.purpose_type; billId = i.bill.purpose_id; currency = currency ?? d.currency ?? null;
    if (i.max_per_bill_minor && !currency) throw badRequest('Choose the currency for the cap');
  }
  if (term === 'one_time') auto = false;
  if ((i.max_per_bill_minor || i.max_total_minor) && !currency) throw badRequest('Choose the currency the caps are in');
  if (i.max_per_bill_minor && i.max_total_minor && i.max_per_bill_minor > i.max_total_minor) throw badRequest('The per-bill cap cannot exceed the total cap');
  if (i.sponsorship_id) {
    const s = (await c.query(
      `SELECT s.id FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.id=$1 AND s.status='active' AND s.target_type='athlete' AND s.target_id=$2
          AND ((sp.owner_id=$3::uuid) OR (sp.organisation_id=$4::uuid))`, [i.sponsorship_id, beneficiaryId, payerUserId ?? null, payerOrgId ?? null])).rows[0];
    if (!s) throw badRequest('That is not an active sponsorship from this payer to this person');
  }
  return { purposes, term, currency, billType, billId, auto, validUntil: i.valid_until ?? null };
}

const insertMandate = async (c, o, v, i) => (await c.query(
  `INSERT INTO cover_mandates(beneficiary_id, payer_user_id, payer_org_id, initiated_by, requested_by, purposes, term, valid_until, bill_type, bill_id, auto_send, currency, max_per_bill_minor, max_total_minor, sponsorship_id, note)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
  [o.beneficiaryId, o.payerUserId ?? null, o.payerOrgId ?? null, o.initiatedBy, o.requestedBy, v.purposes, v.term, v.validUntil, v.billType, v.billId, v.auto, v.currency, i.max_per_bill_minor ?? null, i.max_total_minor ?? null, i.sponsorship_id ?? null, i.note ?? null])).rows[0];

async function mustOpenLimit(c, userId) {
  const n = Number((await c.query("SELECT count(*) AS n FROM cover_mandates WHERE requested_by=$1 AND status='requested'", [userId])).rows[0].n);
  if (n >= 30) throw conflict('You already have 30 requests waiting for an answer');
}

const terseTerms = (m) => (m.term === 'one_time' ? (m.bill_type ? 'this bill' : 'one payment') : m.term === 'duration' ? `until ${String(m.valid_until).slice(0, 10)}` : 'until ended');

// ============================================================================================================== start it
cap({
  name: 'request_cover', method: 'POST', path: '/cover/requests', tag: TAG, status: 201,
  summary: 'Ask a person or an organisation (a sponsor, club, academy, family member) to pay your bills: choose the kinds of bill and the term — one time, for a period, or unlimited — with optional caps, or ask them to pay one specific bill. They approve or decline. A parent or guardian asks for a young person (beneficiary_id); a young person cannot ask alone.',
  input: z.object({ beneficiary_id: id.optional(), payer_user_id: id.optional(), payer_org_id: id.optional(), ...terms }).refine((i) => !!i.payer_user_id !== !!i.payer_org_id, 'Choose one person or one organisation to ask'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const beneficiaryId = i.beneficiary_id ?? user.id;
      const probe = { beneficiary_id: beneficiaryId };
      if (!(await beneficiarySide(c, user, probe))) throw forbidden(beneficiaryId === user.id ? 'A verified guardian asks for you' : 'You are not a verified guardian of this person');
      if (i.payer_user_id === beneficiaryId) throw badRequest('You cannot ask yourself');
      if (i.payer_user_id && !(await c.query('SELECT 1 FROM users WHERE id=$1', [i.payer_user_id])).rowCount) throw notFound('Person');
      if (i.payer_org_id && !(await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.payer_org_id])).rowCount) throw notFound('Organisation');
      await mustOpenLimit(c, user.id);
      const v = await normalise(c, i, { beneficiaryId, payerUserId: i.payer_user_id, payerOrgId: i.payer_org_id });
      const m = await insertMandate(c, { beneficiaryId, payerUserId: i.payer_user_id, payerOrgId: i.payer_org_id, initiatedBy: 'beneficiary', requestedBy: user.id }, v, i);
      await logEvent(c, m.id, user.id, 'requested', i.note);
      const who = (await c.query('SELECT display_name AS n FROM users WHERE id=$1', [beneficiaryId])).rows[0].n;
      for (const r of await payerRecipients(c, { ...m, payer_user_id: m.payer_user_id, payer_org_id: m.payer_org_id })) {
        if (m.payer_org_id && !(await orgsOf(c, r, true)).includes(m.payer_org_id)) continue;   // only owners/admins decide for an organisation
        await notify(c, r, { kind: 'cover_request', title: `${who} asked you to cover their ${m.bill_type ? billLabel(m.bill_type).toLowerCase() : 'bills'}`, body: `${terseTerms(m)}. Open Cover to approve or decline.`, data: { cover_id: m.id }, dedupe_key: `cover:req:${m.id}:${r}` });
      }
      await audit(c, user.id, 'request_cover', 'cover_mandates', m.id);
      return m;
    });
  },
});

cap({
  name: 'offer_cover', method: 'POST', path: '/cover/offers', tag: TAG, status: 201,
  summary: 'Offer to pay for a person\'s bills — as yourself, or as an organisation you own or administer (a sponsor, club or academy). The person accepts or declines (a young person\'s guardian answers). Same terms as a request: kinds of bill, one time / a period / unlimited, optional caps, optional link to your active sponsorship of them.',
  input: z.object({ beneficiary_id: id, as_org_id: id.optional(), ...terms }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.beneficiary_id === user.id) throw badRequest('You cannot offer to pay for yourself');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.beneficiary_id])).rowCount) throw notFound('Person');
      if (i.as_org_id && !(await orgsOf(c, user.id, true)).includes(i.as_org_id)) throw forbidden('Only an owner or admin can offer cover for an organisation');
      await mustOpenLimit(c, user.id);
      const payerUserId = i.as_org_id ? null : user.id;
      const v = await normalise(c, i, { beneficiaryId: i.beneficiary_id, payerUserId, payerOrgId: i.as_org_id });
      const m = await insertMandate(c, { beneficiaryId: i.beneficiary_id, payerUserId, payerOrgId: i.as_org_id, initiatedBy: 'payer', requestedBy: user.id }, v, i);
      await logEvent(c, m.id, user.id, 'offered', i.note);
      const who = await payerName(c, m);
      const youth = await isYouth(i.beneficiary_id, c);
      const to = youth ? (await c.query("SELECT guardian_id AS id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL", [i.beneficiary_id])).rows.map((r) => r.id) : [i.beneficiary_id];
      for (const r of to.length ? to : [i.beneficiary_id]) await notify(c, r, { kind: 'cover_offer', title: `${who} offered to pay ${youth ? 'for a young person\'s ' : 'your '}${m.bill_type ? billLabel(m.bill_type).toLowerCase() : 'bills'}`, body: `${terseTerms(m)}. Open Cover to accept or decline.`, data: { cover_id: m.id }, dedupe_key: `cover:offer:${m.id}:${r}` });
      await audit(c, user.id, 'offer_cover', 'cover_mandates', m.id);
      return m;
    });
  },
});

const mustMandate = async (c, mid, lock = false) => {
  const m = (await c.query(`SELECT * FROM cover_mandates WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [mid])).rows[0];
  if (!m) throw notFound('Cover agreement');
  return m;
};
/** 404 unless the caller is on one side of the agreement. */
async function sides(c, user, m) {
  const pay = await payerSide(c, user, m), ben = await beneficiarySide(c, user, m);
  if (!pay && !ben && user.id === m.beneficiary_id) throw forbidden('Your guardian answers for you');
  if (!pay && !ben) throw notFound('Cover agreement');
  return { pay, ben };
}

cap({
  name: 'decide_cover', method: 'POST', path: '/cover/:id/decision', tag: TAG,
  summary: 'The other side answers a request or an offer: accept (the agreement becomes active now) or decline. For a request the payer (or the organisation\'s owner/admin) answers; for an offer the person (or a young person\'s guardian) answers. You cannot answer your own request.',
  input: z.object({ id, decision: z.enum(['accept', 'decline']), reason: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = await mustMandate(c, i.id, true);
      const { pay, ben } = await sides(c, user, m);
      if (m.status !== 'requested') throw conflict('That agreement is not waiting for an answer');
      const mayAnswer = m.initiated_by === 'beneficiary' ? pay === 'manage' : !!ben;
      if (!mayAnswer || m.requested_by === user.id) throw forbidden('The other side answers this one');
      if (i.decision === 'accept' && m.valid_until && String(m.valid_until).slice(0, 10) < today()) throw conflict('The end date has already passed');
      const next = i.decision === 'accept' ? 'active' : 'declined';
      await c.query('UPDATE cover_mandates SET status=$2::text, decided_by=$3, decided_at=now(), valid_from = CASE WHEN $2::text = \'active\' THEN current_date END WHERE id=$1', [m.id, next, user.id]);
      await logEvent(c, m.id, user.id, i.decision === 'accept' ? 'accepted' : 'declined', i.reason);
      await notify(c, m.requested_by, { kind: 'cover_decided', title: `Your cover ${m.initiated_by === 'beneficiary' ? 'request' : 'offer'} was ${i.decision === 'accept' ? 'accepted' : 'declined'}`, body: i.reason ?? '', data: { cover_id: m.id }, dedupe_key: `cover:decided:${m.id}` });
      await audit(c, user.id, `cover_${i.decision}`, 'cover_mandates', m.id);
      return (await c.query('SELECT * FROM cover_mandates WHERE id=$1', [m.id])).rows[0];
    });
  },
});

cap({
  name: 'end_cover', method: 'POST', path: '/cover/:id/end', tag: TAG,
  summary: 'End an agreement at any time, from either side. Takes effect on the very next payment; payments already completed stay as they are. You can also withdraw your own request or offer before it is answered.',
  input: z.object({ id, reason: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = await mustMandate(c, i.id, true);
      const { pay, ben } = await sides(c, user, m);
      if (!['requested', 'active'].includes(m.status)) throw conflict('That agreement has already ended');
      if (m.status === 'requested' && m.requested_by !== user.id && !(pay === 'manage' || ben)) throw forbidden('Only a person on this agreement can end it');
      if (m.status === 'active' && !(pay === 'manage' || ben)) throw forbidden('Only the payer or the person covered can end it');
      const next = m.status === 'requested' && m.requested_by === user.id ? 'cancelled' : 'revoked';
      await c.query('UPDATE cover_mandates SET status=$2, ended_by=$3, ended_at=now(), end_reason=$4 WHERE id=$1', [m.id, next, user.id, i.reason ?? null]);
      await c.query("UPDATE cover_bills SET status='withdrawn' WHERE mandate_id=$1 AND status='sent'", [m.id]);
      await logEvent(c, m.id, user.id, next === 'cancelled' ? 'withdrawn' : 'ended', i.reason);
      const others = new Set([m.beneficiary_id, ...(await payerRecipients(c, m))]); others.delete(user.id);
      for (const r of others) await notify(c, r, { kind: 'cover_ended', title: 'A cover agreement ended', body: i.reason ?? '', data: { cover_id: m.id }, dedupe_key: `cover:ended:${m.id}:${r}` });
      await audit(c, user.id, 'end_cover', 'cover_mandates', m.id);
      return (await c.query('SELECT * FROM cover_mandates WHERE id=$1', [m.id])).rows[0];
    });
  },
});

// ============================================================================================================== read it
const shape = async (c, user, m) => {
  const { pay, ben } = await sides(c, user, m);
  const u = await usage(c, m.id);
  const names = (await c.query(
    `SELECT (SELECT display_name FROM users WHERE id=$1) AS beneficiary_name, (SELECT display_name FROM users WHERE id=$2) AS payer_user_name, (SELECT name FROM organisations WHERE id=$3) AS payer_org_name`,
    [m.beneficiary_id, m.payer_user_id, m.payer_org_id])).rows[0];
  const waiting = m.status === 'requested';
  const mayAnswer = waiting && m.requested_by !== user.id && (m.initiated_by === 'beneficiary' ? pay === 'manage' : !!ben);
  return {
    id: m.id, status: isLive(m) || m.status !== 'active' ? m.status : 'expired', initiated_by: m.initiated_by, beneficiary_id: m.beneficiary_id, beneficiary_name: names.beneficiary_name,
    payer_kind: m.payer_org_id ? 'organisation' : 'person', payer_name: names.payer_org_name ?? names.payer_user_name, purposes: m.purposes.map((k) => ({ key: k, label: billLabel(k) })),
    term: m.term, valid_from: m.valid_from, valid_until: m.valid_until, bill_type: m.bill_type, bill_id: m.bill_id, auto_send: m.auto_send, currency: m.currency,
    max_per_bill_minor: m.max_per_bill_minor == null ? null : Number(m.max_per_bill_minor), max_total_minor: m.max_total_minor == null ? null : Number(m.max_total_minor),
    used_minor: u.used_minor, uses: u.uses, note: m.note, created_at: m.created_at, ended_at: m.ended_at, end_reason: m.end_reason, sponsorship_id: m.sponsorship_id,
    i_am: { payer: !!pay, beneficiary: !!ben, requester: m.requested_by === user.id }, can_answer: mayAnswer,
    can_end: ['requested', 'active'].includes(m.status) && (pay === 'manage' || !!ben || m.requested_by === user.id),
  };
};

cap({
  name: 'list_cover', method: 'GET', path: '/cover', tag: TAG,
  summary: 'Your cover agreements. view=for_me: where someone pays for you (or for a young person you are the guardian of). view=i_pay: where you pay for others, as yourself or for an organisation you work for. Each shows the terms, what has been used, and what you can do next.',
  input: z.object({ view: z.enum(['for_me', 'i_pay']).default('for_me'), status: z.enum(['requested', 'active', 'ended']).optional(), ...page }),
  async handler({ user }, i) {
    const orgs = await orgsOf(db, user.id, false);
    const kids = (await many("SELECT child_id AS id FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id])).map((r) => r.id);
    const filter = '($1::text IS NULL OR ($1 = \'ended\' AND status NOT IN (\'requested\',\'active\')) OR status = $1)';
    const rows = i.view === 'for_me'
      ? await many(`SELECT * FROM cover_mandates WHERE beneficiary_id = ANY($2::uuid[]) AND ${filter} ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [i.status ?? null, [user.id, ...kids], i.limit, i.offset])
      : await many(`SELECT * FROM cover_mandates WHERE (payer_user_id = $2 OR payer_org_id = ANY($3::uuid[])) AND ${filter} ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [i.status ?? null, user.id, orgs, i.limit, i.offset]);
    const out = [];
    for (const m of rows) { try { out.push(await shape(db, user, m)); } catch { /* not on a side that may see it */ } }
    return out;
  },
});

cap({
  name: 'cover_inbox', method: 'GET', path: '/cover/inbox', tag: TAG,
  summary: 'Payer side: bills waiting for you to pay — every open bill in scope of an auto-send agreement, plus bills people sent you — each with the agreement that covers it and whether it can be paid now (caps, term and dates are checked). Pay one with create_payment using its purpose_type and purpose_id; the checkout recognises your agreement. Labels are generic (no provider or service detail).',
  async handler({ user }) {
    const out = [];
    for (const m of await payerMandates(db, user)) {
      const who = (await db.query('SELECT display_name AS n FROM users WHERE id=$1', [m.beneficiary_id])).rows[0]?.n;
      for (const b of await billsFor(db, m)) {
        const reason = await whyNot(db, m, { purposeType: b.purpose_type, purposeId: b.purpose_id, amount: b.amount, currency: b.currency });
        if (reason === 'kind_not_covered' || reason === 'other_bill') continue;
        out.push({ mandate_id: m.id, beneficiary_name: who, purpose_type: b.purpose_type, purpose_id: b.purpose_id, label: billLabel(b.purpose_type), amount_minor: b.amount, currency: b.currency, since: b.at, payable: !reason, blocked_by: reason, note: m.note });
      }
    }
    return out;
  },
});

cap({
  name: 'cover_options', method: 'GET', path: '/cover/options', tag: TAG,
  summary: 'At checkout, for a bill you owe (or a young person you are the guardian of): which active cover agreements could take it, and who the payer is. Used to offer "send this to my sponsor / family".',
  input: z.object({ purpose_type: z.enum(COVER_KINDS), purpose_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await describePurpose(c, i.purpose_type, i.purpose_id);
      if (!d) throw notFound('Bill');
      if (!(await beneficiarySide(c, user, { beneficiary_id: d.payerId }))) throw notFound('Bill');
      const { rows } = await c.query("SELECT * FROM cover_mandates WHERE beneficiary_id=$1 AND status='active' ORDER BY created_at", [d.payerId]);
      const out = [];
      for (const m of rows) {
        const reason = await whyNot(c, m, { purposeType: i.purpose_type, purposeId: i.purpose_id, amount: d.amount, currency: d.currency ?? (await import('../config.js')).config.payments.currency });
        if (reason) continue;
        out.push({ mandate_id: m.id, payer_name: await payerName(c, m), term: m.term, valid_until: m.valid_until, auto_send: m.auto_send, sent: !!(await c.query("SELECT 1 FROM cover_bills WHERE mandate_id=$1 AND purpose_type=$2 AND purpose_id=$3 AND status='sent'", [m.id, i.purpose_type, i.purpose_id])).rowCount });
      }
      return { payable: d.payable, amount_minor: d.amount, bill_owner_is_me: d.payerId === user.id, options: out };
    });
  },
});

cap({
  name: 'send_bill_to_payer', method: 'POST', path: '/cover/:id/bills', tag: TAG, status: 201,
  summary: 'Send one of your open bills to the person or organisation that covers you. It appears in their inbox and they are notified; they pay it at the normal checkout. Refused if the agreement does not cover it (kind, caps, term, dates). Sending twice does nothing.',
  input: z.object({ id, purpose_type: z.enum(COVER_KINDS), purpose_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = await mustMandate(c, i.id, true);
      if (!(await beneficiarySide(c, user, m))) throw notFound('Cover agreement');
      const d = await describePurpose(c, i.purpose_type, i.purpose_id);
      if (!d || d.payerId !== m.beneficiary_id) throw notFound('Bill');
      if (!d.payable) throw conflict('That bill cannot be paid right now');
      const currency = d.currency ?? (await import('../config.js')).config.payments.currency;
      const why = await whyNot(c, m, { purposeType: i.purpose_type, purposeId: i.purpose_id, amount: d.amount, currency });
      if (why) throw conflict(`This agreement does not cover that bill (${why.replace(/_/g, ' ')})`);
      const made = await c.query("INSERT INTO cover_bills(mandate_id, purpose_type, purpose_id, sent_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [m.id, i.purpose_type, i.purpose_id, user.id]);
      if (made.rowCount) { await logEvent(c, m.id, user.id, 'bill_sent', billLabel(i.purpose_type)); await notifyPayers(c, m, { purposeType: i.purpose_type, purposeId: i.purpose_id, amount: d.amount, currency }); }
      return { sent: true, already: !made.rowCount, label: billLabel(i.purpose_type), amount_minor: d.amount, currency, payer_name: await payerName(c, m) };
    });
  },
});

cap({
  name: 'search_cover_payers', method: 'GET', path: '/cover/payers', tag: TAG,
  summary: 'Find a person or an organisation to ask for cover, by name. Public identity only (name, handle, kind); young people are never listed.',
  input: z.object({ q: z.string().trim().min(3).max(60) }),
  async handler({ user }, i) {
    const like = `%${i.q.replace(/[%_]/g, '')}%`;
    const people = await many(`SELECT u.id, u.display_name, u.handle, u.avatar_emoji FROM users u WHERE u.id <> $1 AND ${NOT_YOUTH_SQL} AND (u.display_name ILIKE $2 OR u.handle ILIKE $2) ORDER BY u.display_name LIMIT 8`, [user.id, like]);
    const orgs = await many("SELECT o.id, o.name, o.kind FROM organisations o WHERE o.status='active' AND o.name ILIKE $1 ORDER BY o.name LIMIT 8", [like]);
    return { people, organisations: orgs };
  },
});

cap({
  name: 'get_cover', method: 'GET', path: '/cover/:id', tag: TAG,
  summary: 'One agreement with its history (who requested, accepted, ended, each payment made under it). Only the two sides can see it; bills are shown by generic kind, never by provider or service.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await mustMandate(db, i.id);
    const s = await shape(db, user, m);
    const events = await many('SELECT e.action, e.note, e.created_at, u.display_name AS by FROM cover_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.mandate_id=$1 ORDER BY e.created_at, e.id', [m.id]);
    const uses = await many('SELECT purpose_type, amount_minor, currency, status, created_at, settled_at FROM cover_uses WHERE mandate_id=$1 ORDER BY created_at DESC LIMIT 100', [m.id]);
    return { ...s, events, uses: uses.map((u) => ({ ...u, label: billLabel(u.purpose_type), amount_minor: Number(u.amount_minor) })) };
  },
});
