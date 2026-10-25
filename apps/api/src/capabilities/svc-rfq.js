// Supplier services (#458) 3/5 — RFQ, invitations, clarifications, versioned quotes, evaluation, comparison, approval and award.
// Competing bids are private: a supplier only ever sees its own invitation, its own quotes and clarifications the buyer chose to share.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { assertCurrency, checkQty, priced } from '../svc/money.js';
import { assertUnit, CATEGORY } from '../svc/catalogue.js';
import { supplierAccess, buyerAccess, myProfileIds, nextNumber, log } from '../svc/access.js';
import { approvalNeeded, decide } from '../svc/approvals.js';
import { credentialState } from './svc-supplier.js';

const TAG = 'Service procurement';
const cur = z.string().length(3).transform((s) => s.toUpperCase());
const ts = z.string().datetime({ offset: true });
const OPEN = ['issued', 'quoting', 'evaluation'];

/** Staff who should hear about an RFQ / order: the owner plus sales and scheduler roles. */
export const supplierAudience = async (c, profileId) => (await c.query("SELECT owner_id AS u FROM svc_profiles WHERE id=$1 UNION SELECT user_id FROM svc_staff WHERE profile_id=$1 AND status='active' AND role IN ('owner','sales','scheduler')", [profileId])).rows.map((r) => r.u);
export const buyerAudience = async (c, buyerId, roles = ['purchaser']) => (await c.query("SELECT b.owner_id AS u FROM svc_buyers b WHERE b.id=$1 UNION SELECT user_id FROM svc_buyer_roles WHERE buyer_id=$1 AND status='active' AND role = ANY($2)", [buyerId, roles])).rows.map((r) => r.u);
const tell = async (c, users, msg, actor) => { for (const u of new Set(users)) if (u !== actor) await notify(c, u, msg); };   // previews carry no amounts, bids, passenger or youth data

const taxRule = async (c, profileId, code, on = new Date().toISOString().slice(0, 10)) =>
  (await c.query('SELECT * FROM svc_tax_rules WHERE profile_id=$1 AND code=$2 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3) ORDER BY effective_from DESC LIMIT 1', [profileId, code, on])).rows[0] ?? null;

/** Mark submitted quotes whose validity passed as expired (idempotent; called wherever quotes are read or acted on). */
export const expireStale = (c, rfqId) => c.query("UPDATE svc_quotes SET status='expired' WHERE rfq_id=$1 AND status IN ('submitted','shortlisted') AND valid_until IS NOT NULL AND valid_until < now()", [rfqId]);

const rfqFor = async (c, rfqId, { lock = false } = {}) => {
  const r = (await c.query(`SELECT * FROM svc_rfqs WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [rfqId])).rows[0];
  if (!r) throw notFound('RFQ');
  return r;
};

// ---------------------------------------------------------------- RFQ lifecycle (buyer)
cap({
  name: 'create_rfq', method: 'POST', path: '/service-requirements/:id/rfq', tag: TAG, status: 201,
  summary: 'Draft an RFQ from a requirement: freezes the scope as version 1, with invitation/question/quote deadlines and an evaluation rubric. An existing supplier event request can be linked so the inbox stays canonical and is never finalised twice.',
  input: z.object({ id, title: z.string().min(1).max(160).optional(), audience: z.enum(['invited', 'published']).default('invited'), invite_deadline: ts.optional(), question_deadline: ts.optional(), quote_deadline: ts.optional(), rubric: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().max(80), weight: z.number().positive().max(100) })).max(12).default([]), allow_partial: z.boolean().default(false), event_request_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rq = (await c.query('SELECT * FROM svc_requirements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rq) throw notFound('Requirement');
      const { buyer } = await buyerAccess(user, rq.buyer_id, ['requester'], c);
      if (['cancelled', 'closed'].includes(rq.status)) throw conflict(`Requirement is ${rq.status}`);
      if ((await c.query("SELECT 1 FROM svc_rfqs WHERE requirement_id=$1 AND status NOT IN ('closed','declined','withdrawn','cancelled','expired')", [rq.id])).rowCount) throw conflict('This requirement already has a live RFQ');
      if (i.invite_deadline && i.quote_deadline && i.quote_deadline < i.invite_deadline) throw badRequest('The quote deadline is before the invitation deadline');
      if (i.question_deadline && i.quote_deadline && i.question_deadline > i.quote_deadline) throw badRequest('Questions must close before quotes do');
      if (i.event_request_id) {
        const er = (await c.query("SELECT * FROM event_requests WHERE id=$1 AND kind='supplier'", [i.event_request_id])).rows[0];
        if (!er || er.event_id !== buyer.event_id) throw badRequest('That supplier request does not belong to this event');
      }
      const scope = { category: rq.category, subcategory: rq.subcategory, scope: rq.scope, quantity: Number(rq.quantity), unit: rq.unit, headcount: rq.headcount, starts_at: rq.starts_at, ends_at: rq.ends_at, timezone: rq.timezone, recurrence: rq.recurrence, site_access: rq.site_access, qualifications: rq.qualifications, acceptance_criteria: rq.acceptance_criteria, title: rq.title };
      const r = (await c.query(
        `INSERT INTO svc_rfqs(buyer_id, requirement_id, lot_id, event_request_id, title, scope, currency, audience, invite_deadline, question_deadline, quote_deadline, rubric, allow_partial, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [buyer.id, rq.id, rq.lot_id, i.event_request_id ?? null, i.title ?? rq.title, scope, rq.currency, i.audience, i.invite_deadline ?? null, i.question_deadline ?? null, i.quote_deadline ?? null, JSON.stringify(i.rubric), i.allow_partial, user.id])).rows[0];
      await c.query('INSERT INTO svc_rfq_versions(rfq_id, version, scope, changed_by, reason) VALUES ($1,1,$2,$3,$4)', [r.id, scope, user.id, 'Initial scope']);
      await log(c, 'rfq', r.id, user.id, 'created');
      return r;
    });
  },
});

cap({
  name: 'invite_rfq_suppliers', method: 'POST', path: '/rfqs/:id/invites', tag: TAG, status: 201,
  summary: 'Invite eligible suppliers (active, not suspended). Invitations become visible to suppliers when the RFQ is issued; inviting after issue notifies them at once.',
  input: z.object({ id, profile_ids: z.array(id).min(1).max(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id, { lock: true });
      const { buyer } = await buyerAccess(user, r.buyer_id, ['requester'], c);
      if (!['draft', ...OPEN].includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      const ps = (await c.query('SELECT id, status, owner_id FROM svc_profiles WHERE id = ANY($1)', [i.profile_ids])).rows;
      if (ps.length !== new Set(i.profile_ids).size) throw notFound('Supplier');
      const out = [];
      for (const p of ps) {
        if (p.status !== 'active') throw conflict('A supplier you chose is suspended or archived and cannot be invited');
        if (p.owner_id === user.id) throw badRequest('You cannot invite your own supplier profile');
        const inv = (await c.query('INSERT INTO svc_invites(rfq_id, profile_id) VALUES ($1,$2) ON CONFLICT (rfq_id, profile_id) DO NOTHING RETURNING *', [r.id, p.id])).rows[0];
        if (inv) { out.push(inv); if (r.status !== 'draft') await tell(c, await supplierAudience(c, p.id), { kind: 'svc_rfq_invited', title: 'New request for quotation', body: `${buyer.name} invited you to quote. Open Gotmygame to respond.`, data: { rfq_id: r.id, invite_id: inv.id }, dedupe_key: `svc:inv:${inv.id}` }, user.id); }
      }
      return out;
    });
  },
});

cap({
  name: 'issue_rfq', method: 'POST', path: '/rfqs/:id/issue', tag: TAG,
  summary: 'Issue the RFQ: invited suppliers are told and the requirement moves to quoting. Needs at least one invited supplier, or an audience of published.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id, { lock: true });
      const { buyer } = await buyerAccess(user, r.buyer_id, ['requester'], c);
      if (r.status !== 'draft') throw conflict(`RFQ is already ${r.status}`);
      const invs = (await c.query('SELECT * FROM svc_invites WHERE rfq_id=$1', [r.id])).rows;
      if (!invs.length && r.audience === 'invited') throw badRequest('Invite at least one supplier, or publish the RFQ');
      const row = (await c.query("UPDATE svc_rfqs SET status='issued', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      await c.query("UPDATE svc_requirements SET status='needs_quotes', updated_at=now() WHERE id=$1 AND status='draft'", [r.requirement_id]);
      for (const inv of invs) await tell(c, await supplierAudience(c, inv.profile_id), { kind: 'svc_rfq_invited', title: 'New request for quotation', body: `${buyer.name} invited you to quote. Open Gotmygame to respond.`, data: { rfq_id: r.id, invite_id: inv.id }, dedupe_key: `svc:inv:${inv.id}` }, user.id);
      await log(c, 'rfq', r.id, user.id, 'issued');
      return row;
    });
  },
});

cap({
  name: 'amend_rfq_scope', method: 'POST', path: '/rfqs/:id/scope', tag: TAG,
  summary: 'Change the scope of an issued RFQ. This creates a new scope version, keeps the old snapshot, and marks submitted quotes stale — every supplier re-quotes against the same version. Clarifications that apply to all are better shared than amended.',
  input: z.object({ id, row_version: z.number().int(), reason: z.string().min(1).max(500), changes: z.object({ quantity: z.number().positive().optional(), starts_at: ts.optional(), ends_at: ts.optional(), headcount: z.number().int().positive().optional(), site_access: z.string().max(500).optional(), acceptance_criteria: z.array(z.string().max(300)).max(20).optional(), scope: z.record(z.string(), z.any()).optional(), quote_deadline: ts.optional() }) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id, { lock: true });
      await buyerAccess(user, r.buyer_id, ['requester'], c);
      if (r.row_version !== i.row_version) throw conflict('This RFQ changed since you opened it — reload and try again');
      if (!['draft', ...OPEN].includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      const { quote_deadline, ...ch } = i.changes;
      if (ch.quantity) checkQty(ch.quantity);
      const scope = { ...r.scope, ...ch, scope: ch.scope ? { ...r.scope.scope, ...ch.scope } : r.scope.scope };
      const v = r.status === 'draft' ? r.scope_version : r.scope_version + 1;
      if (r.status !== 'draft') await c.query('INSERT INTO svc_rfq_versions(rfq_id, version, scope, changed_by, reason) VALUES ($1,$2,$3,$4,$5)', [r.id, v, scope, user.id, i.reason]);
      const row = (await c.query('UPDATE svc_rfqs SET scope=$2, scope_version=$3, quote_deadline=coalesce($4, quote_deadline), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [r.id, scope, v, quote_deadline ?? null])).rows[0];
      if (r.status !== 'draft') {
        const stale = await c.query("UPDATE svc_quotes SET status='superseded' WHERE rfq_id=$1 AND status IN ('submitted','shortlisted','draft') AND scope_version < $2 RETURNING profile_id", [r.id, v]);
        await c.query("UPDATE svc_invites SET status='accepted' WHERE rfq_id=$1 AND status='quoted'", [r.id]);
        for (const p of new Set(stale.rows.map((x) => x.profile_id))) await tell(c, await supplierAudience(c, p), { kind: 'svc_rfq_scope_changed', title: 'RFQ scope changed', body: 'The scope was updated. Please review and re-quote.', data: { rfq_id: r.id }, dedupe_key: `svc:scope:${r.id}:${v}:${p}` }, user.id);
      }
      await log(c, 'rfq', r.id, user.id, 'scope_amended', { version: v, reason: i.reason });
      return row;
    });
  },
});

cap({
  name: 'set_rfq_status', method: 'POST', path: '/rfqs/:id/status', tag: TAG,
  summary: 'Move an RFQ to evaluation, or close / cancel / withdraw it (reason recorded). Awarding goes through award_rfq. Nothing is deleted.',
  input: z.object({ id, status: z.enum(['evaluation', 'closed', 'cancelled', 'withdrawn', 'expired']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id, { lock: true });
      await buyerAccess(user, r.buyer_id, i.status === 'evaluation' ? ['requester', 'evaluator'] : ['purchaser'], c);
      if (['closed', 'cancelled', 'withdrawn', 'expired', 'declined'].includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      if (i.status === 'evaluation' && !OPEN.includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      if (['cancelled', 'withdrawn'].includes(i.status) && !i.reason) throw badRequest('Give a reason');
      if (['cancelled', 'withdrawn'].includes(i.status) && (await c.query("SELECT 1 FROM svc_orders WHERE rfq_id=$1 AND status NOT IN ('cancelled','rejected','terminated')", [r.id])).rowCount) throw conflict('Orders already exist from this RFQ; cancel or terminate them first');
      const row = (await c.query('UPDATE svc_rfqs SET status=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [r.id, i.status])).rows[0];
      if (['closed', 'cancelled', 'withdrawn', 'expired'].includes(i.status)) {
        await c.query("UPDATE svc_invites SET status='closed' WHERE rfq_id=$1 AND status IN ('invited','accepted','site_visit_requested','quoted')", [r.id]);
        if (['cancelled', 'withdrawn', 'expired'].includes(i.status)) await c.query("UPDATE svc_requirements SET status='draft' WHERE id=$1 AND status IN ('needs_quotes','quoting','evaluating')", [r.requirement_id]);
      }
      await log(c, 'rfq', r.id, user.id, `status_${i.status}`, { reason: i.reason ?? null });
      return row;
    });
  },
});

// ---------------------------------------------------------------- reading RFQs (buyer sees everything; a supplier only its own side)
const supplierSide = async (user, rfqId, c) => {
  const ids = await myProfileIds(user, c);
  return (await c.query("SELECT i.* FROM svc_invites i WHERE i.rfq_id=$1 AND i.profile_id = ANY($2)", [rfqId, ids])).rows;
};
cap({
  name: 'get_rfq', method: 'GET', path: '/rfqs/:id', tag: TAG,
  summary: 'An RFQ. Buyer staff see invitations and all quotes. An invited supplier sees the scope, deadlines, shared clarifications and only its own invitation and quotes — never a competitor’s.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT * FROM svc_rfqs WHERE id=$1', [i.id]);
    if (!r) throw notFound('RFQ');
    let buyerSide = null; try { buyerSide = await buyerAccess(user, r.buyer_id, null); } catch { /* maybe a supplier */ }
    if (buyerSide) {
      await tx((cc) => expireStale(cc, r.id));
      const [invites, quotes, clar] = await Promise.all([
        many('SELECT i.*, coalesce(p.trading_name, p.legal_name) AS supplier_name FROM svc_invites i JOIN svc_profiles p ON p.id=i.profile_id WHERE i.rfq_id=$1 ORDER BY i.created_at', [r.id]),
        many('SELECT q.id, q.profile_id, q.version, q.scope_version, q.status, q.currency, q.net_minor, q.tax_minor, q.gross_minor, q.valid_until, q.submitted_at FROM svc_quotes q WHERE q.rfq_id=$1 ORDER BY q.profile_id, q.version', [r.id]),
        many('SELECT * FROM svc_clarifications WHERE rfq_id=$1 ORDER BY created_at, id', [r.id]),
      ]);
      return { ...r, side: 'buyer', my_roles: [...buyerSide.roles], invites, quotes, clarifications: clar };
    }
    const mine = await supplierSide(user, r.id, pool);
    if (!mine.length || r.status === 'draft') throw notFound('RFQ');
    const inv = mine[0];
    await tx((cc) => expireStale(cc, r.id));
    const [quotes, clar, b] = await Promise.all([
      many('SELECT * FROM svc_quotes WHERE rfq_id=$1 AND invite_id=$2 ORDER BY version', [r.id, inv.id]),
      many('SELECT id, author_side, body, answers_id, created_at, (invite_id = $2) AS mine FROM svc_clarifications WHERE rfq_id=$1 AND (shared OR invite_id=$2) ORDER BY created_at, id', [r.id, inv.id]),
      one('SELECT name FROM svc_buyers WHERE id=$1', [r.buyer_id]),
    ]);
    const { single_supplier_justification, rubric, ...pub } = r;
    return { ...pub, side: 'supplier', buyer_name: b?.name, invite: inv, quotes, clarifications: clar };
  },
});
cap({
  name: 'list_rfqs', method: 'GET', path: '/service-buyers/:id/rfqs', tag: TAG, summary: 'RFQs of a procurement context.',
  input: z.object({ id, status: z.string().optional(), ...page }),
  async handler({ user }, i) {
    await buyerAccess(user, i.id, null);
    return many('SELECT r.*, (SELECT count(*)::int FROM svc_invites v WHERE v.rfq_id=r.id) AS invited, (SELECT count(DISTINCT q.profile_id)::int FROM svc_quotes q WHERE q.rfq_id=r.id AND q.status IN (\'submitted\',\'shortlisted\',\'awarded\',\'partially_awarded\')) AS responded FROM svc_rfqs r WHERE r.buyer_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC, r.id LIMIT $3 OFFSET $4', [i.id, i.status ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'list_my_rfq_invitations', method: 'GET', path: '/me/rfq-invitations', tag: TAG,
  summary: 'Supplier inbox: RFQs your supplier profiles are invited to (drafts are never shown).',
  input: z.object({ profile_id: id.optional(), status: z.enum(['invited', 'accepted', 'declined', 'site_visit_requested', 'quoted', 'withdrawn', 'closed']).optional(), ...page }),
  async handler({ user }, i) {
    const ids = await myProfileIds(user);
    const use = i.profile_id ? ids.filter((x) => x === i.profile_id) : ids;
    if (i.profile_id && !use.length) throw notFound('Supplier');
    return many(`SELECT v.*, r.title, r.status AS rfq_status, r.quote_deadline, r.question_deadline, r.scope_version, r.scope->>'category' AS category, b.name AS buyer_name
                   FROM svc_invites v JOIN svc_rfqs r ON r.id=v.rfq_id JOIN svc_buyers b ON b.id=r.buyer_id
                  WHERE v.profile_id = ANY($1) AND r.status <> 'draft' AND ($2::text IS NULL OR v.status=$2) ORDER BY v.created_at DESC, v.id LIMIT $3 OFFSET $4`, [use, i.status ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'list_published_rfqs', method: 'GET', path: '/rfq-opportunities', tag: TAG,
  summary: 'Open RFQs published to an audience in the categories your supplier profile serves (no buyer finance or competitor data).',
  input: z.object({ profile_id: id, ...page }),
  async handler({ user }, i) {
    const { profile } = await supplierAccess(user, i.profile_id, ['owner', 'sales']);
    return many("SELECT r.id, r.title, r.currency, r.quote_deadline, r.scope_version, r.scope->>'category' AS category FROM svc_rfqs r WHERE r.audience='published' AND r.status IN ('issued','quoting') AND r.scope->>'category' = ANY($1) AND NOT EXISTS (SELECT 1 FROM svc_invites v WHERE v.rfq_id=r.id AND v.profile_id=$2) ORDER BY r.created_at DESC, r.id LIMIT $3 OFFSET $4", [profile.categories, profile.id, i.limit, i.offset]);
  },
});

// ---------------------------------------------------------------- supplier: respond, ask
const inviteFor = async (user, inviteId, roles, c) => {
  const inv = (await c.query('SELECT * FROM svc_invites WHERE id=$1 FOR UPDATE', [inviteId])).rows[0];
  if (!inv) throw notFound('Invitation');
  const { profile } = await supplierAccess(user, inv.profile_id, roles, c);
  const r = await rfqFor(c, inv.rfq_id);
  if (r.status === 'draft') throw notFound('Invitation');
  return { inv, profile, r };
};
cap({
  name: 'join_published_rfq', method: 'POST', path: '/rfqs/:id/join', tag: TAG, status: 201,
  summary: 'Express interest in an RFQ published to an audience: creates your invitation (needs a category your supplier serves).',
  input: z.object({ id, profile_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { profile } = await supplierAccess(user, i.profile_id, ['owner', 'sales'], c);
      const r = await rfqFor(c, i.id, { lock: true });
      if (r.audience !== 'published' || !['issued', 'quoting'].includes(r.status)) throw notFound('RFQ');
      if (profile.status !== 'active') throw conflict('This supplier is suspended');
      if (!profile.categories.includes(r.scope.category)) throw badRequest('Add this service category to your supplier profile first');
      if (r.invite_deadline && new Date(r.invite_deadline) < new Date()) throw conflict('The invitation deadline has passed');
      const inv = (await c.query("INSERT INTO svc_invites(rfq_id, profile_id, status, responded_at) VALUES ($1,$2,'accepted',now()) ON CONFLICT (rfq_id, profile_id) DO NOTHING RETURNING *", [r.id, profile.id])).rows[0];
      if (!inv) throw conflict('You are already part of this RFQ');
      return inv;
    });
  },
});
cap({
  name: 'respond_rfq_invitation', method: 'POST', path: '/rfq-invites/:id/respond', tag: TAG,
  summary: 'Accept the invitation, decline with a reason, or request a site visit before quoting.',
  input: z.object({ id, action: z.enum(['accept', 'decline', 'request_site_visit']), reason: z.string().max(500).optional(), site_visit_at: ts.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { inv, r } = await inviteFor(user, i.id, ['owner', 'sales'], c);
      if (!OPEN.includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      if (['quoted'].includes(inv.status) && i.action !== 'decline') throw conflict('You already quoted');
      if (i.action === 'decline' && !i.reason) throw badRequest('Give a reason for declining');
      if (i.action === 'decline' && (await c.query("SELECT 1 FROM svc_quotes WHERE invite_id=$1 AND status IN ('awarded','partially_awarded')", [inv.id])).rowCount) throw conflict('Your quote was already awarded');
      if (r.invite_deadline && new Date(r.invite_deadline) < new Date() && i.action !== 'decline') throw conflict('The invitation deadline has passed');
      const status = { accept: 'accepted', decline: 'declined', request_site_visit: 'site_visit_requested' }[i.action];
      const row = (await c.query('UPDATE svc_invites SET status=$2, reason=$3, site_visit_at=$4, responded_at=now() WHERE id=$1 RETURNING *', [inv.id, status, i.reason ?? null, i.site_visit_at ?? null])).rows[0];
      if (i.action === 'decline') await c.query("UPDATE svc_quotes SET status='withdrawn' WHERE invite_id=$1 AND status IN ('draft','submitted','shortlisted')", [inv.id]);
      await tell(c, await (await import('./svc-rfq.js')).buyerAudience(c, r.buyer_id, ['requester', 'purchaser']), { kind: 'svc_rfq_response', title: 'A supplier responded to your RFQ', body: 'Open Gotmygame to see the response.', data: { rfq_id: r.id }, dedupe_key: `svc:resp:${inv.id}:${status}` }, user.id);
      return row;
    });
  },
});
cap({
  name: 'ask_rfq_clarification', method: 'POST', path: '/rfqs/:id/clarifications', tag: TAG, status: 201,
  summary: 'Buyer: post a notice or answer (shared = visible to every invited supplier, without saying who asked). Supplier: ask a question before the question deadline (private to the buyer until answered as shared).',
  input: z.object({ id, body: z.string().min(1).max(4000), invite_id: id.optional().describe('supplier side: your invitation'), answers_id: id.optional(), shared: z.boolean().default(false), attachments: z.array(z.object({ name: z.string().max(160), ref: z.string().max(300) })).max(10).default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id);
      let buyerSide = null; try { buyerSide = await buyerAccess(user, r.buyer_id, ['requester'], c); } catch (e) { if (e.status === 403) throw e; }
      if (buyerSide) {
        if (!['draft', ...OPEN].includes(r.status)) throw conflict(`RFQ is ${r.status}`);
        const row = (await c.query("INSERT INTO svc_clarifications(rfq_id, author_id, author_side, body, shared, answers_id, attachments) VALUES ($1,$2,'buyer',$3,$4,$5,$6) RETURNING *", [r.id, user.id, i.body, i.shared || !i.answers_id, i.answers_id ?? null, JSON.stringify(i.attachments)])).rows[0];
        if (row.shared) for (const v of (await c.query("SELECT profile_id FROM svc_invites WHERE rfq_id=$1 AND status NOT IN ('declined','closed')", [r.id])).rows) await tell(c, await supplierAudience(c, v.profile_id), { kind: 'svc_rfq_clarification', title: 'RFQ clarification', body: 'The buyer shared a clarification. Open Gotmygame to read it.', data: { rfq_id: r.id }, dedupe_key: `svc:clar:${row.id}:${v.profile_id}` }, user.id);
        else if (i.answers_id) { const q0 = (await c.query('SELECT invite_id FROM svc_clarifications WHERE id=$1', [i.answers_id])).rows[0]; if (q0?.invite_id) await c.query('UPDATE svc_clarifications SET invite_id=$2 WHERE id=$1', [row.id, q0.invite_id]); }
        return row;
      }
      if (!i.invite_id) throw badRequest('Say which invitation you are asking through');
      const { inv } = await inviteFor(user, i.invite_id, ['owner', 'sales'], c);
      if (inv.rfq_id !== r.id) throw notFound('Invitation');
      if (inv.status === 'declined' || !OPEN.includes(r.status)) throw conflict('You can no longer ask questions on this RFQ');
      if (r.question_deadline && new Date(r.question_deadline) < new Date()) throw conflict('The question deadline has passed');
      return (await c.query("INSERT INTO svc_clarifications(rfq_id, invite_id, author_id, author_side, body, shared, attachments) VALUES ($1,$2,$3,'supplier',$4,false,$5) RETURNING *", [r.id, inv.id, user.id, i.body, JSON.stringify(i.attachments)])).rows[0];
    });
  },
});

// ---------------------------------------------------------------- quotes
const lineSchema = z.object({
  line_type: z.enum(['service', 'goods']), charge_kind: z.enum(['labour', 'material', 'travel', 'equipment', 'other']).default('labour'), description: z.string().min(1).max(400),
  quantity: z.number().positive().max(1e9), unit: z.string(), rate_minor: money, discount_minor: money.default(0), tax_code: z.string().max(24).optional(), milestone: z.string().max(80).optional(), delivery_on: z.string().date().optional(),
});
const termsSchema = z.object({
  cancellation: z.string().max(1000).optional(), warranty: z.string().max(1000).optional(), sla: z.string().max(1000).optional(), payment_terms: z.string().max(500).optional(), deposit_bp: z.number().int().min(0).max(10000).optional(),
  assumptions: z.array(z.string().max(300)).max(20).optional(), inclusions: z.array(z.string().max(200)).max(30).optional(), exclusions: z.array(z.string().max(200)).max(30).optional(),
  staffing: z.string().max(500).optional(), capacity_available: z.boolean().optional(), schedule: z.string().max(500).optional(), covers_quantity: z.number().positive().optional(),
  withholding_note: z.string().max(300).optional(), third_party: z.enum(['supplier_booking', 'third_party_reservation']).optional(),
}).strict();

cap({
  name: 'submit_quote', method: 'POST', path: '/rfq-invites/:id/quote', tag: TAG, status: 201,
  summary: 'Submit (or save as draft) a new quote version against the RFQ’s current scope version: goods/service lines with quantity/unit/rate, discounts, tax from your configured rules (effective-dated; inclusive or exclusive), terms, validity. Submitting supersedes your earlier version. Totals are computed on the server in integer minor units.',
  input: z.object({ id, lines: z.array(lineSchema).min(1).max(100), valid_until: ts, prices_include_tax: z.boolean().optional(), currency: cur.optional(), terms: termsSchema.default({}), submit: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { inv, profile, r } = await inviteFor(user, i.id, ['owner', 'sales'], c);
      if (profile.status !== 'active') throw conflict('This supplier is suspended');
      if (!OPEN.includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      if (inv.status === 'declined' || inv.status === 'closed') throw conflict(`Your invitation is ${inv.status}`);
      if (r.quote_deadline && new Date(r.quote_deadline) < new Date()) throw conflict('The quote deadline has passed');
      const currency = assertCurrency(i.currency ?? r.currency);
      if (profile.currencies.length && !profile.currencies.includes(currency)) throw badRequest(`${currency} is not one of your accepted currencies`);
      if (i.submit && new Date(i.valid_until) <= new Date()) throw badRequest('valid_until must be in the future');
      const cat = r.scope.category;
      const rules = new Map(); let first = null;
      const lines = [];
      for (const l of i.lines) {
        checkQty(l.quantity);
        if (l.line_type === 'service' && !CATEGORY[cat].units.includes(l.unit) && l.charge_kind === 'labour') assertUnit(cat, l.unit);
        let tax_bp = 0, tax_treatment = 'standard';
        if (l.tax_code) {
          if (!rules.has(l.tax_code)) rules.set(l.tax_code, await taxRule(c, profile.id, l.tax_code));
          const rule = rules.get(l.tax_code);
          if (!rule) throw badRequest(`No tax rule “${l.tax_code}” is in force for you — configure it first`);
          first ??= rule; tax_bp = rule.rate_bp; tax_treatment = rule.treatment;
        }
        lines.push({ ...l, tax_bp, tax_treatment });
      }
      const inclusive = i.prices_include_tax ?? first?.prices_include_tax ?? false;
      const t = priced(lines, { inclusive, rounding: first?.rounding ?? 'per_line' });
      const prev = (await c.query('SELECT max(version) AS v FROM svc_quotes WHERE rfq_id=$1 AND profile_id=$2', [r.id, profile.id])).rows[0].v ?? 0;
      if (prev) await c.query("UPDATE svc_quotes SET status='superseded' WHERE rfq_id=$1 AND profile_id=$2 AND status IN ('submitted','shortlisted','draft')", [r.id, profile.id]);
      const terms = { ...i.terms, covers_quantity: i.terms.covers_quantity ?? r.scope.quantity };
      const q = (await c.query(
        `INSERT INTO svc_quotes(rfq_id, invite_id, profile_id, version, scope_version, status, currency, valid_until, prices_include_tax, net_minor, tax_minor, gross_minor, terms, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [r.id, inv.id, profile.id, prev + 1, r.scope_version, 'draft', currency, i.valid_until, inclusive, t.net, t.tax, t.gross, terms, null])).rows[0];
      let n = 0;
      for (const l of t.lines) await c.query('INSERT INTO svc_quote_lines(quote_id, line_no, line_type, charge_kind, description, quantity, unit, rate_minor, discount_minor, tax_code, tax_bp, tax_treatment, net_minor, tax_minor, gross_minor, milestone, delivery_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
        [q.id, ++n, l.line_type, l.charge_kind, l.description, l.quantity, l.unit, l.rate_minor, l.discount_minor, l.tax_code ?? null, l.tax_bp, l.tax_treatment, l.net_minor, l.tax_minor, l.gross_minor, l.milestone ?? null, l.delivery_on ?? null]);
      if (i.submit) {
        q.status = (await c.query("UPDATE svc_quotes SET status='submitted', submitted_at=now() WHERE id=$1 RETURNING status", [q.id])).rows[0].status;
        await c.query("UPDATE svc_invites SET status='quoted', responded_at=coalesce(responded_at, now()) WHERE id=$1", [inv.id]);
        await c.query("UPDATE svc_rfqs SET status='quoting', updated_at=now() WHERE id=$1 AND status='issued'", [r.id]);
        await c.query("UPDATE svc_requirements SET status='quoting', updated_at=now() WHERE id=$1 AND status='needs_quotes'", [r.requirement_id]);
        await tell(c, await buyerAudience(c, r.buyer_id, ['requester', 'evaluator', 'purchaser']), { kind: 'svc_quote_submitted', title: 'A quote arrived', body: 'A supplier submitted a quote. Open Gotmygame to review it.', data: { rfq_id: r.id }, dedupe_key: `svc:quote:${q.id}` }, user.id);
      }
      await log(c, 'quote', q.id, user.id, i.submit ? 'submitted' : 'drafted', { version: q.version });
      return { ...q, lines: t.lines };
    });
  },
});
cap({
  name: 'withdraw_service_quote', method: 'POST', path: '/quotes/:id/withdraw', tag: TAG,
  summary: 'Withdraw a submitted quote before the deadline and before it is awarded.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM svc_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q) throw notFound('Quote');
      await supplierAccess(user, q.profile_id, ['owner', 'sales'], c);
      const r = await rfqFor(c, q.rfq_id, { lock: true });
      if (!['submitted', 'shortlisted', 'draft'].includes(q.status)) throw conflict(`Quote is ${q.status}`);
      if (r.quote_deadline && new Date(r.quote_deadline) < new Date()) throw conflict('The quote deadline has passed; the quote now stands until it expires');
      if ((await c.query("SELECT 1 FROM svc_approvals WHERE subject_type='award' AND subject_id=$1 AND status='pending' AND payload->'awards' @> $2::jsonb", [r.id, JSON.stringify([{ quote_id: q.id }])])).rowCount) throw conflict('This quote is part of an award awaiting approval');
      await c.query("UPDATE svc_invites SET status='accepted' WHERE id=$1 AND status='quoted'", [q.invite_id]);
      return (await c.query("UPDATE svc_quotes SET status='withdrawn' WHERE id=$1 RETURNING *", [q.id])).rows[0];
    });
  },
});
cap({
  name: 'get_service_quote', method: 'GET', path: '/quotes/:id', tag: TAG, summary: 'A quote with its lines: visible to its own supplier and to the buyer’s procurement staff only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const q = await one('SELECT * FROM svc_quotes WHERE id=$1', [i.id]);
    if (!q) throw notFound('Quote');
    const r = await one('SELECT * FROM svc_rfqs WHERE id=$1', [q.rfq_id]);
    let ok = false;
    try { await supplierAccess(user, q.profile_id, null); ok = true; } catch { /* not the supplier */ }
    if (!ok) { try { await buyerAccess(user, r.buyer_id, ['requester', 'evaluator', 'purchaser', 'approver']); ok = q.status !== 'draft'; } catch { /* no */ } }
    if (!ok) throw notFound('Quote');
    return { ...q, lines: await many('SELECT * FROM svc_quote_lines WHERE quote_id=$1 ORDER BY line_no', [q.id]) };
  },
});

// ---------------------------------------------------------------- evaluation + comparison
const SCALE = 1000000n;
const fxConvert = (minor, rate) => Number((BigInt(minor) * BigInt(Math.round(Number(rate) * 1e6)) + SCALE / 2n) / SCALE);
cap({
  name: 'get_rfq_comparison', method: 'GET', path: '/rfqs/:id/comparison', tag: TAG,
  summary: 'Side-by-side comparison for evaluators: current submitted quote per supplier with net/tax/gross, scope compliance, validity, certifications, availability, SLA and evaluation score. Different currencies stay separate; pass fx_rates (dated snapshot) only to add a comparison-only converted gross.',
  input: z.object({ id, fx_base: cur.optional(), fx_as_of: z.string().date().optional(), fx_rates: z.string().max(400).optional().describe('JSON object {"EUR":1.09} meaning 1 EUR = 1.09 base') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id);
      const { buyer } = await buyerAccess(user, r.buyer_id, ['evaluator', 'requester', 'purchaser'], c);
      await expireStale(c, r.id);
      let fx = null; if (i.fx_rates) { try { fx = JSON.parse(i.fx_rates); } catch { throw badRequest('fx_rates must be JSON'); } if (!i.fx_base || !i.fx_as_of) throw badRequest('A comparison snapshot needs fx_base and fx_as_of'); }
      const qs = (await c.query(
        `SELECT DISTINCT ON (q.profile_id) q.*, coalesce(p.trading_name, p.legal_name) AS supplier_name, p.lead_time_days, p.status AS profile_status FROM svc_quotes q JOIN svc_profiles p ON p.id=q.profile_id
          WHERE q.rfq_id=$1 AND q.status IN ('submitted','shortlisted','awarded','partially_awarded','expired','rejected') ORDER BY q.profile_id, q.version DESC`, [r.id])).rows;
      const out = [];
      for (const q of qs) {
        const creds = (await c.query("SELECT * FROM svc_credentials WHERE profile_id=$1 AND status='active'", [q.profile_id])).rows;
        const required = creds.filter((x) => x.required_for_award);
        const ev = (await c.query('SELECT avg(total)::float AS score, count(*)::int AS n, bool_and(compliant) AS compliant FROM svc_evaluations WHERE quote_id=$1', [q.id])).rows[0];
        const blackout = r.scope.starts_at ? (await c.query('SELECT 1 FROM svc_blackouts WHERE profile_id=$1 AND day BETWEEN $2::date AND coalesce($3::date, $2::date)', [q.profile_id, r.scope.starts_at, r.scope.ends_at ?? null])).rowCount > 0 : false;
        out.push({ quote_id: q.id, profile_id: q.profile_id, supplier: q.supplier_name, version: q.version, status: q.status, currency: q.currency, net_minor: Number(q.net_minor), tax_minor: Number(q.tax_minor), gross_minor: Number(q.gross_minor),
          scope_compliant: q.scope_version === r.scope_version, valid_until: q.valid_until, expired: q.status === 'expired', credentials: creds.map((x) => ({ kind: x.kind, title: x.title, verification: x.verification, state: credentialState(x) })), required_credentials_ok: required.every((x) => ['valid', 'no_expiry', 'expiring'].includes(credentialState(x))),
          available: !blackout && q.terms.capacity_available !== false, lead_time_days: q.lead_time_days, sla: q.terms.sla ?? null, covers_quantity: q.terms.covers_quantity ?? null, evaluation: ev.n ? { score: ev.score, evaluators: ev.n, compliant: ev.compliant } : null,
          ...(fx ? { comparable_gross_minor: q.currency === i.fx_base ? Number(q.gross_minor) : fx[q.currency] ? fxConvert(q.gross_minor, fx[q.currency]) : null } : {}) });
      }
      const byCurrency = {}; for (const q of out) (byCurrency[q.currency] ??= []).push(q.quote_id);
      return { rfq_id: r.id, scope_version: r.scope_version, buyer_currency: buyer.currency, rubric: r.rubric, quotes: out, by_currency: byCurrency, ...(fx ? { fx_snapshot: { base: i.fx_base, rates: fx, as_of: i.fx_as_of, purpose: 'comparison only — never used for awards, tax or invoices' } } : {}) };
    });
  },
});
cap({
  name: 'evaluate_quote', method: 'POST', path: '/quotes/:id/evaluate', tag: TAG, status: 201,
  summary: 'Score a quote against the RFQ rubric (0–10 per criterion, weighted to 100) with a recorded rationale. One evaluation per evaluator; re-scoring replaces your own.',
  input: z.object({ id, scores: z.record(z.string(), z.number().min(0).max(10)).default({}), rationale: z.string().min(1).max(2000), compliant: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM svc_quotes WHERE id=$1', [i.id])).rows[0];
      if (!q || q.status === 'draft') throw notFound('Quote');
      const r = await rfqFor(c, q.rfq_id);
      await buyerAccess(user, r.buyer_id, ['evaluator'], c);
      if (!OPEN.includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      const rub = r.rubric ?? [];
      for (const k of Object.keys(i.scores)) if (!rub.some((x) => x.key === k)) throw badRequest(`${k} is not a criterion of this RFQ`);
      const wsum = rub.reduce((s, x) => s + Number(x.weight), 0);
      const total = wsum ? rub.reduce((s, x) => s + ((i.scores[x.key] ?? 0) / 10) * Number(x.weight), 0) * (100 / wsum) : 0;
      return (await c.query(
        'INSERT INTO svc_evaluations(rfq_id, quote_id, evaluator_id, scores, total, rationale, compliant) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (quote_id, evaluator_id) DO UPDATE SET scores=EXCLUDED.scores, total=EXCLUDED.total, rationale=EXCLUDED.rationale, compliant=EXCLUDED.compliant, created_at=now() RETURNING *',
        [r.id, q.id, user.id, i.scores, Math.round(total * 100) / 100, i.rationale, i.compliant])).rows[0];
    });
  },
});
cap({
  name: 'decide_quote', method: 'POST', path: '/quotes/:id/decision', tag: TAG,
  summary: 'Shortlist or reject a quote (a rejection reason is kept and shared with that supplier only).',
  input: z.object({ id, decision: z.enum(['shortlisted', 'rejected']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = (await c.query('SELECT * FROM svc_quotes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!q) throw notFound('Quote');
      const r = await rfqFor(c, q.rfq_id);
      await buyerAccess(user, r.buyer_id, ['evaluator', 'purchaser'], c);
      if (!['submitted', 'shortlisted'].includes(q.status)) throw conflict(`Quote is ${q.status}`);
      if (i.decision === 'rejected' && !i.reason) throw badRequest('Give a reason');
      const row = (await c.query('UPDATE svc_quotes SET status=$2, terms = terms || $3::jsonb WHERE id=$1 RETURNING *', [q.id, i.decision, JSON.stringify(i.reason ? { decision_reason: i.reason } : {})])).rows[0];
      await log(c, 'quote', q.id, user.id, i.decision, { reason: i.reason ?? null });
      return row;
    });
  },
});

// ---------------------------------------------------------------- award (the one place a quote becomes a commitment)
const awardItem = z.object({ quote_id: id, covers_quantity: z.number().positive().optional() });
const eligible = async (c, rfq, q, profile) => {
  if (!['submitted', 'shortlisted'].includes(q.status)) throw conflict(q.status === 'expired' ? 'That quote has expired' : `That quote is ${q.status}`);
  if (q.scope_version !== rfq.scope_version) throw conflict('That quote was made against an older scope; ask for a new quote');
  if (q.valid_until && new Date(q.valid_until) < new Date()) { await c.query("UPDATE svc_quotes SET status='expired' WHERE id=$1", [q.id]); throw conflict('That quote has expired'); }
  if (profile.status !== 'active') throw conflict('That supplier is suspended and cannot receive new awards');
  const creds = (await c.query("SELECT * FROM svc_credentials WHERE profile_id=$1 AND status='active' AND required_for_award", [q.profile_id])).rows;
  const bad = creds.find((x) => !['valid', 'no_expiry', 'expiring'].includes(credentialState(x)));
  if (bad) throw conflict(`That supplier’s required credential “${bad.title}” has expired; new awards are blocked until it is renewed`);
};

/** Create the purchase / service orders for approved awards. Runs inside the award (or approval) transaction with the RFQ row locked. */
export async function createOrders(c, rfq, awards, actor, { approvalId = null, justification = null } = {}) {
  const buyer = (await c.query('SELECT * FROM svc_buyers WHERE id=$1', [rfq.buyer_id])).rows[0];
  const need = Number(rfq.scope.quantity);
  const used = Number((await c.query("SELECT coalesce(sum((terms->>'covers_quantity')::numeric),0) AS s FROM svc_orders WHERE rfq_id=$1 AND status NOT IN ('cancelled','rejected','terminated')", [rfq.id])).rows[0].s);
  let add = 0; const orders = [];
  for (const a of awards) {
    const q = (await c.query('SELECT * FROM svc_quotes WHERE id=$1 FOR UPDATE', [a.quote_id])).rows[0];
    if (!q || q.rfq_id !== rfq.id) throw notFound('Quote');
    const profile = (await c.query('SELECT * FROM svc_profiles WHERE id=$1', [q.profile_id])).rows[0];
    await eligible(c, rfq, q, profile);
    if ((await c.query("SELECT 1 FROM svc_orders WHERE quote_id=$1 AND status NOT IN ('cancelled','rejected','terminated')", [q.id])).rowCount) throw conflict('That quote has already been awarded');
    const qCovers = Number(q.terms.covers_quantity ?? need);
    const covers = a.covers_quantity ?? qCovers;
    if (covers > qCovers + 1e-9) throw badRequest('You cannot award more than the quote covers');
    if (covers < qCovers && !rfq.allow_partial) throw badRequest('This RFQ does not allow partial awards');
    add += covers;
    if (used + add > need + 1e-9) throw conflict('That would award more than the requirement needs');
    const ratio = covers / qCovers;
    const ql = (await c.query('SELECT * FROM svc_quote_lines WHERE quote_id=$1 ORDER BY line_no', [q.id])).rows;
    const lines = ql.map((l) => ({ ...l, quantity: Math.round(Number(l.quantity) * ratio * 1000) / 1000, rate_minor: Number(l.rate_minor), discount_minor: Math.round(Number(l.discount_minor) * ratio) }));
    const rule = (await c.query('SELECT rounding FROM svc_tax_rules WHERE profile_id=$1 AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date) ORDER BY effective_from DESC LIMIT 1', [q.profile_id])).rows[0];
    const t = priced(lines.map((l) => ({ ...l, tax_bp: l.tax_bp, tax_treatment: l.tax_treatment })), { inclusive: q.prices_include_tax, rounding: rule?.rounding ?? 'per_line' });
    const prefix = `PO-${buyer.id.replace(/-/g, '').slice(0, 5).toUpperCase()}`;
    const number = await nextNumber(c, buyer.id, 'po', prefix);
    const taxRules = {}; for (const l of ql) if (l.tax_code) taxRules[l.tax_code] = { rate_bp: l.tax_bp, treatment: l.tax_treatment };
    const o = (await c.query(
      `INSERT INTO svc_orders(number, buyer_id, profile_id, rfq_id, quote_id, quote_version, scope_version, requirement_id, lot_id, event_id, venue_id, currency, net_minor, tax_minor, gross_minor, tax_snapshot, terms, approval_id, agreement_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending_signature',$19) RETURNING *`,
      [number, buyer.id, q.profile_id, rfq.id, q.id, q.version, q.scope_version, rfq.requirement_id, rfq.lot_id, buyer.event_id, buyer.venue_id, q.currency, t.net, t.tax, t.gross, { inclusive: q.prices_include_tax, rules: taxRules, rounding: rule?.rounding ?? 'per_line' }, { ...q.terms, covers_quantity: covers, justification }, approvalId, actor.id])).rows[0];
    let n = 0;
    for (const l of t.lines) await c.query('INSERT INTO svc_order_lines(order_id, line_no, line_type, charge_kind, description, unit, rate_minor, discount_minor, tax_code, tax_bp, tax_treatment, qty_ordered, milestone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [o.id, ++n, l.line_type, l.charge_kind, l.description, l.unit, l.rate_minor, l.discount_minor, l.tax_code, l.tax_bp, l.tax_treatment, l.quantity, l.milestone]);
    await c.query("UPDATE svc_quotes SET status=$2 WHERE id=$1", [q.id, covers < qCovers ? 'partially_awarded' : 'awarded']);
    await c.query("UPDATE svc_invites SET status='closed' WHERE id=$1", [q.invite_id]);
    await tell(c, await supplierAudience(c, q.profile_id), { kind: 'svc_order_placed', title: 'You have a new service order', body: `Order ${number} awaits your confirmation.`, data: { order_id: o.id }, dedupe_key: `svc:order:${o.id}` }, actor.id);
    await log(c, 'order', o.id, actor.id, 'placed', { quote_id: q.id, version: q.version, scope_version: q.scope_version, approval_id: approvalId });
    orders.push(o);
  }
  const full = used + add >= need - 1e-9;
  await c.query('UPDATE svc_rfqs SET status=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [rfq.id, full ? 'awarded' : 'partially_awarded']);
  await c.query("UPDATE svc_requirements SET status='awarded', updated_at=now() WHERE id=$1 AND status IN ('needs_quotes','quoting','evaluating')", [rfq.requirement_id]);
  return orders;
}

cap({
  name: 'award_rfq', method: 'POST', path: '/rfqs/:id/award', tag: TAG, status: 201,
  summary: 'Award one or more quotes (whole, or part of the requirement for distinct quantities). The exact accepted quote and scope version is bound; expired, stale or over-awarding requests fail atomically. Above your approval threshold/limit it opens an approval instead and awards on a different approver’s decision. A single-supplier award needs a written justification when policy says so.',
  input: z.object({ id, row_version: z.number().int(), awards: z.array(awardItem).min(1).max(20), justification: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await rfqFor(c, i.id, { lock: true });
      const acc = await buyerAccess(user, r.buyer_id, ['purchaser'], c);
      if (r.row_version !== i.row_version) throw conflict('This RFQ changed since you opened it — reload and try again');
      if (![...OPEN, 'partially_awarded'].includes(r.status)) throw conflict(`RFQ is ${r.status}`);
      if (r.status === 'partially_awarded' && !r.allow_partial) throw conflict('RFQ is already awarded');
      if ((await c.query("SELECT 1 FROM svc_approvals WHERE subject_type='award' AND subject_id=$1 AND status='pending'", [r.id])).rowCount) throw conflict('An award for this RFQ is already waiting for approval');
      await expireStale(c, r.id);
      const ids = i.awards.map((a) => a.quote_id);
      if (new Set(ids).size !== ids.length) throw badRequest('A quote can only be awarded once');
      const qs = (await c.query('SELECT * FROM svc_quotes WHERE id = ANY($1) AND rfq_id=$2', [ids, r.id])).rows;
      if (qs.length !== ids.length) throw notFound('Quote');
      for (const q of qs) await eligible(c, r, q, (await c.query('SELECT * FROM svc_profiles WHERE id=$1', [q.profile_id])).rows[0]);
      const respondents = Number((await c.query("SELECT count(DISTINCT profile_id)::int AS n FROM svc_quotes WHERE rfq_id=$1 AND status IN ('submitted','shortlisted','expired','rejected')", [r.id])).rows[0].n);
      const policy = acc.buyer.approval_policy ?? {};
      if (ids.length === 1 && policy.single_supplier_justification !== false && !i.justification) throw badRequest('Say why this supplier was chosen (single-supplier award justification)');
      const sameCur = qs.every((q) => q.currency === r.currency);
      const buyerSum = qs.filter((q) => q.currency === acc.buyer.currency).reduce((s, q) => s + Number(q.gross_minor), 0);
      const total = qs.reduce((s, q) => s + Number(q.gross_minor), 0);
      const needs = approvalNeeded(acc.buyer, acc, sameCur ? total : buyerSum, qs.every((q) => q.currency === acc.buyer.currency) ? acc.buyer.currency : 'MIXED');
      if (needs) {
        const ap = (await c.query("INSERT INTO svc_approvals(buyer_id, subject_type, subject_id, rfq_id, amount_minor, currency, requested_by, payload) VALUES ($1,'award',$2,$2,$3,$4,$5,$6) RETURNING *", [r.buyer_id, r.id, total, sameCur ? r.currency : 'MIXED', user.id, { awards: i.awards, justification: i.justification ?? null, respondents }])).rows[0];
        await c.query("UPDATE svc_rfqs SET status='approval_pending', row_version=row_version+1, updated_at=now() WHERE id=$1", [r.id]);
        await tell(c, await buyerAudience(c, r.buyer_id, ['approver']), { kind: 'svc_approval_requested', title: 'An award needs your approval', body: 'Open Gotmygame to review and decide.', data: { approval_id: ap.id }, dedupe_key: `svc:ap:${ap.id}` }, user.id);
        return { status: 'approval_pending', approval: ap };
      }
      const orders = await createOrders(c, r, i.awards, user, { justification: i.justification });
      return { status: 'awarded', orders };
    });
  },
});
cap({
  name: 'decide_service_approval', method: 'POST', path: '/service-approvals/:id/decision', tag: TAG,
  summary: 'An approver (not the requester, within their limit) approves or rejects a pending award, variation, termination or invoice exception. Approving an award re-validates the quotes (expiry, scope, capacity of the requirement) before placing orders.',
  input: z.object({ id, approve: z.boolean(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT buyer_id FROM svc_approvals WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Approval');
      if (!i.approve && !i.note) throw badRequest('Give a reason when rejecting');
      return decide(c, user, i.id, i.approve, i.note, (bid) => buyerAccess(user, bid, ['approver'], c));
    });
  },
});
cap({
  name: 'list_service_approvals', method: 'GET', path: '/service-buyers/:id/approvals', tag: TAG, summary: 'Approvals of a procurement context (approvers, requesters, finance).',
  input: z.object({ id, status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) { await buyerAccess(user, i.id, ['approver', 'requester', 'purchaser', 'finance']); return many('SELECT * FROM svc_approvals WHERE buyer_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [i.id, i.status ?? null, i.limit, i.offset]); },
});

// award approval handler: place the orders the requester asked for, now that a different person approved
import('../svc/approvals.js').then(({ handlers, onReject }) => {
  handlers.set('award', async (c, ap, actor) => {
    const r = await rfqFor(c, ap.subject_id, { lock: true });
    if (r.status !== 'approval_pending') throw conflict(`RFQ is ${r.status}`);
    await expireStale(c, r.id);
    const req = { id: ap.requested_by };
    return createOrders(c, r, ap.payload.awards, req, { approvalId: ap.id, justification: ap.payload.justification });
  });
  onReject.set('award', async (c, ap) => { await c.query("UPDATE svc_rfqs SET status='evaluation', row_version=row_version+1, updated_at=now() WHERE id=$1 AND status='approval_pending'", [ap.subject_id]); });
});
