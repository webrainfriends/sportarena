// Sports agent & player representation (issue #484) 5/5a: commission. An agreed term is applied to a deal the athlete confirmed (a #333 contract or a
// sponsorship agreement made with them), computed from that deal's own canonical facts, never from private or unrelated earnings, never twice for an
// amendment. Each figure is one thing: owed, invoiced, reported by the payer, settled (only when the agent confirms receipt). Corrections are new lines.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { toCsv } from '../csv.js';
import {
  accrueDeal, athleteSideOf, canDecide, dealFacts, detectDealConflicts, inForce, ladderOf, loadAgent, loadMandate, logEvent, notifyAgentSide, notifyAthleteSide, requireLive, summariseTerm, actingFor, todayIso,
} from '../representation.js';

const TAG = 'Representation';
const text = (n) => z.string().trim().max(n);
const cents = z.coerce.number().int().min(1).max(10_000_000_000_000);
const stale = () => conflict('This record changed; reload it and try again', { code: 'stale_version' });
const DEAL_PURPOSE = { player_contract: 'contract_negotiation', sponsorship: 'sponsorship_commercial' };
const DEAL_CATEGORY = { player_contract: 'contract_workflow', sponsorship: 'sponsorship_discussions' };

/** Who the caller is on a deal's mandate, and whether the agent side may touch commission (principal, or staff with the permission the athlete allowed). */
async function dealContext(c, user, dealId, { lock = false } = {}) {
  const deal = (await c.query(`SELECT * FROM representation_deals WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [dealId])).rows[0];
  if (!deal) throw notFound('Deal');
  const ctx = await loadMandate(c, user, deal.mandate_id);
  let agentOk = false;
  if (ctx.acting?.via === 'principal') agentOk = true;
  else if (ctx.acting?.via === 'staff') { const v = await inForce(c, ctx.mandate); agentOk = !!v?.allow_staff && ctx.acting.perms.includes('commission'); }
  if (ctx.acting && !agentOk && !ctx.side) throw notFound('Deal'); // staff without the permission do not see commission at all
  return { deal, ...ctx, agentOk };
}
const termOf = async (c, deal) => (await c.query('SELECT commission FROM representation_mandate_versions WHERE mandate_id=$1 AND version=$2', [deal.mandate_id, deal.term_version])).rows[0]?.commission.find((t) => t.key === deal.term_key) ?? null;
const sideLabel = (ctx) => ctx.side ?? (ctx.acting?.via === 'staff' ? 'staff' : 'agent');

async function dealView(c, ctx, { entries = false } = {}) {
  const { deal } = ctx;
  const term = await termOf(c, deal);
  const [ladder, stm, miles] = await Promise.all([
    ladderOf(c, deal.id),
    c.query('SELECT id, statement_no, amount_cents, currency, due_on::text AS due_on, status, issued_at, voided_at FROM representation_statements WHERE deal_id=$1 ORDER BY issued_at', [deal.id]).then((r) => r.rows),
    c.query('SELECT id, milestone_key, status, evidence_note, claimed_by, decided_at, created_at FROM representation_milestones WHERE deal_id=$1 ORDER BY created_at', [deal.id]).then((r) => r.rows),
  ]);
  const out = { id: deal.id, mandate_id: deal.mandate_id, deal_type: deal.deal_type, deal_id: deal.deal_id, deal_ref: deal.deal_ref, status: deal.status, currency: deal.currency, term_key: deal.term_key, term_version: deal.term_version, term: term ? { ...term, text: summariseTerm(term) } : null, row_version: deal.row_version, ladder, statements: stm, milestones: miles, created_at: deal.created_at };
  if (entries) out.entries = (await c.query('SELECT seq, kind, amount_cents, basis_cents, calc, reference, reason, statement_id, created_at FROM representation_commission_entries WHERE deal_id=$1 ORDER BY seq', [deal.id])).rows;
  return out;
}

// ------------------------------------------------------------------ linking a deal
cap({
  name: 'link_representation_deal', method: 'POST', path: '/representation/mandates/:id/deals', tag: TAG, status: 201,
  summary: 'Propose that a commission term of the agreed mandate applies to one deal: a player contract or a sponsorship agreement of the athlete\'s that has been shared under the mandate. The other side must confirm before anything accrues. The term is frozen at the mandate version in force now; amendments to the deal do not create a second commission. A deal can be linked once per agent and athlete.',
  input: z.object({ id, deal_type: z.enum(['player_contract', 'sponsorship']), deal_id: id, term_key: z.string().regex(/^[a-z0-9_]{1,40}$/) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const m = ctx.mandate;
      if (m.status !== 'active') throw conflict('Only a mandate in force can link new deals', { code: 'not_active' });
      const v = await inForce(c, m);
      const term = v.commission.find((t) => t.key === i.term_key);
      if (!term || !term.applies_to.includes(i.deal_type)) throw badRequest('That commission term does not apply to this kind of deal');
      if (ctx.acting) {
        await requireLive(c, user, i.id, { purpose: DEAL_PURPOSE[i.deal_type], category: DEAL_CATEGORY[i.deal_type], staff: 'commission', subject: { type: i.deal_type, id: i.deal_id, level: 'view' } });
      } else {
        if (!canDecide(ctx.side)) throw forbidden('A guardian decides for a young person');
        if (!(await c.query("SELECT 1 FROM representation_grants WHERE mandate_id=$1 AND subject_type=$2 AND subject_id=$3 AND revoked_at IS NULL", [m.id, i.deal_type, i.deal_id])).rowCount) throw conflict('Share the deal with the agent first; only a deal shared under the mandate can carry commission', { code: 'no_grant' });
      }
      const facts = await dealFacts(c, { deal_type: i.deal_type, deal_id: i.deal_id }, term, m);
      if (facts.missing) throw notFound('Deal');
      if (facts.currency !== term.currency) throw conflict(`This deal is in ${facts.currency ?? 'an unlabelled currency'} but the commission term is in ${term.currency}; no conversion is ever applied`, { code: 'currency_mismatch' });
      const dup = (await c.query(
        `SELECT d.id FROM representation_deals d JOIN representation_mandates mm ON mm.id=d.mandate_id WHERE mm.agent_id=$1 AND mm.athlete_id=$2 AND d.deal_type=$3 AND d.deal_id=$4 AND d.status IN ('proposed','confirmed')`, [m.agent_id, m.athlete_id, i.deal_type, i.deal_id])).rows[0];
      if (dup) {
        if ((await c.query('SELECT mandate_id FROM representation_deals WHERE id=$1', [dup.id])).rows[0].mandate_id === m.id) return dealView(c, { ...ctx, deal: (await c.query('SELECT * FROM representation_deals WHERE id=$1', [dup.id])).rows[0] });
        throw conflict('This deal is already linked to this agent under another mandate; it is counted once', { code: 'already_linked' });
      }
      const row = (await c.query(
        'INSERT INTO representation_deals(mandate_id, term_key, term_version, deal_type, deal_id, deal_ref, currency, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [m.id, i.term_key, m.current_version, i.deal_type, i.deal_id, facts.ref, term.currency, user.id])).rows[0];
      await detectDealConflicts(c, { mandate: m, agent: ctx.agent, subjectType: i.deal_type, subjectId: i.deal_id, actor: user.id });
      await logEvent(c, m.id, user.id, sideLabel(ctx), 'deal_proposed', { subject_type: i.deal_type, subject_id: i.deal_id, detail: { term_key: i.term_key, term_version: m.current_version } });
      const msg = { kind: 'representation_deal', title: 'Commission on a deal needs confirming', body: `${facts.ref}: ${summariseTerm(term)}`, data: { deal_id: row.id } };
      if (ctx.side) await notifyAgentSide(c, m, msg, user.id, 'commission'); else await notifyAthleteSide(c, m, msg, user.id);
      return dealView(c, { ...ctx, deal: row });
    });
  },
});

cap({
  name: 'decide_representation_deal', method: 'POST', path: '/representation/deals/:id/decision', tag: TAG,
  summary: 'Confirm or decline a proposed deal link. The side that did not propose it confirms (the athlete or guardian for an agent\'s proposal; the agent for the athlete\'s). Confirming starts the commission account. Only the agent can end a confirmed link (waiving future commission); money already owed stays.',
  input: z.object({ id, decision: z.enum(['confirm', 'decline', 'end']), reason: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, user, i.id, { lock: true });
      const { deal } = ctx;
      const proposerAthlete = !!(await athleteSideOf(c, { id: deal.proposed_by }, ctx.mandate.athlete_id));
      const mineAthlete = canDecide(ctx.side);
      if (i.decision === 'end') {
        if (!ctx.agentOk || ctx.acting.via !== 'principal') throw forbidden('Only the agent can end a confirmed link');
        if (deal.status === 'ended') return dealView(c, ctx);
        if (deal.status !== 'confirmed') throw conflict(`That link is ${deal.status}`, { code: 'not_confirmed' });
        await c.query("UPDATE representation_deals SET status='ended', ended_at=now(), row_version=row_version+1 WHERE id=$1", [deal.id]);
        await logEvent(c, deal.mandate_id, user.id, 'agent', 'deal_ended', { subject_type: deal.deal_type, subject_id: deal.deal_id, detail: { reason: i.reason ?? null } });
        return dealView(c, { ...ctx, deal: { ...deal, status: 'ended' } });
      }
      if (deal.status !== 'proposed') {
        if ((i.decision === 'confirm' && deal.status === 'confirmed') || (i.decision === 'decline' && deal.status === 'declined')) return dealView(c, ctx);
        throw conflict(`That link is ${deal.status}`, { code: 'not_proposed' });
      }
      if (i.decision === 'decline') {
        if (!(mineAthlete || ctx.agentOk)) throw forbidden('You cannot decide this');
        await c.query("UPDATE representation_deals SET status='declined', row_version=row_version+1 WHERE id=$1", [deal.id]);
        await logEvent(c, deal.mandate_id, user.id, sideLabel(ctx), 'deal_declined', { subject_type: deal.deal_type, subject_id: deal.deal_id });
        return dealView(c, { ...ctx, deal: { ...deal, status: 'declined' } });
      }
      if (proposerAthlete ? !ctx.agentOk : !mineAthlete) throw forbidden(proposerAthlete ? 'The agent confirms a link the athlete proposed' : 'The athlete or a guardian confirms a link the agent proposed');
      await c.query("UPDATE representation_deals SET status='confirmed', confirmed_by=$2, confirmed_at=now(), row_version=row_version+1 WHERE id=$1", [deal.id, user.id]);
      await logEvent(c, deal.mandate_id, user.id, sideLabel(ctx), 'deal_confirmed', { subject_type: deal.deal_type, subject_id: deal.deal_id, detail: { term_key: deal.term_key } });
      await accrueDeal(c, deal.id, user.id);
      await audit(c, user.id, 'confirm_representation_deal', 'representation_deals', deal.id);
      return dealView(c, { ...ctx, deal: (await c.query('SELECT * FROM representation_deals WHERE id=$1', [deal.id])).rows[0] });
    });
  },
});

cap({
  name: 'list_representation_deals', method: 'GET', path: '/representation/mandates/:id/deals', tag: TAG,
  summary: 'Deals linked to a mandate with their commission account: owed, invoiced, reported by the payer, settled and outstanding. Athlete side and agent side (staff only with the commission permission).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ctx = await loadMandate(pool, user, i.id);
    if (ctx.acting?.via === 'staff') { const v = await inForce(pool, ctx.mandate); if (!v?.allow_staff || !ctx.acting.perms.includes('commission')) throw notFound('Mandate'); }
    const rows = await many('SELECT * FROM representation_deals WHERE mandate_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
    return Promise.all(rows.map((d) => dealView(pool, { ...ctx, deal: d })));
  },
});

cap({
  name: 'get_representation_deal', method: 'GET', path: '/representation/deals/:id', tag: TAG,
  summary: 'One deal\'s commission account in full: the term as agreed, the exact deal version and basis each accrual used, every ledger line, statements and milestones. Reads by the agent side are audit-logged because they show the athlete\'s earnings on that deal.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, user, i.id);
    if (ctx.acting) await audit(null, user.id, 'read_representation_deal', 'representation_deals', i.id);
    return dealView(pool, ctx, { entries: true });
  },
});

cap({
  name: 'accrue_representation_commission', method: 'POST', path: '/representation/deals/:id/accrue', tag: TAG,
  summary: 'Bring a confirmed deal\'s commission up to date with its canonical facts (contract ledger fees or payments; sponsorship payments the athlete confirmed). Posts only the difference, after threshold and cap, and a correction is a new line. Safe to repeat; the worker also does this each cycle.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, user, i.id, { lock: true });
      if (ctx.acting && !ctx.agentOk) throw forbidden('You do not have the commission permission');
      const r = await accrueDeal(c, i.id, user.id);
      return { ...r, deal: await dealView(c, { ...ctx, deal: (await c.query('SELECT * FROM representation_deals WHERE id=$1', [i.id])).rows[0] }) };
    });
  },
});

// ------------------------------------------------------------------ milestones
cap({
  name: 'claim_commission_milestone', method: 'POST', path: '/representation/deals/:id/milestones', tag: TAG, status: 201,
  summary: 'Agent: claim that an agreed milestone of a milestone-based commission term was met, with a short evidence note. It accrues only after the athlete or a guardian confirms it.',
  input: z.object({ id, milestone_key: z.string().regex(/^[a-z0-9_]{1,40}$/), evidence_note: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, user, i.id, { lock: true });
      if (!ctx.agentOk) throw forbidden('Only the agent claims a milestone');
      if (ctx.deal.status !== 'confirmed') throw conflict('The deal link is not confirmed', { code: 'not_confirmed' });
      const term = await termOf(c, ctx.deal);
      if (term?.basis !== 'milestone' || !term.milestones.some((m) => m.key === i.milestone_key)) throw badRequest('That milestone is not part of the agreed term');
      const r = await c.query("INSERT INTO representation_milestones(deal_id, milestone_key, claimed_by, evidence_note) VALUES ($1,$2,$3,$4) ON CONFLICT (deal_id, milestone_key) DO NOTHING RETURNING *", [i.id, i.milestone_key, user.id, i.evidence_note ?? null]);
      if (!r.rowCount) return (await c.query('SELECT * FROM representation_milestones WHERE deal_id=$1 AND milestone_key=$2', [i.id, i.milestone_key])).rows[0];
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'milestone_claimed', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { milestone: i.milestone_key } });
      await notifyAthleteSide(c, ctx.mandate, { kind: 'representation_milestone', title: 'Your agent claimed a milestone', body: `${term.milestones.find((m) => m.key === i.milestone_key).label}. Confirm it only if it was met.`, data: { deal_id: i.id } }, user.id);
      return r.rows[0];
    });
  },
});

cap({
  name: 'decide_commission_milestone', method: 'POST', path: '/representation/milestones/:id/decision', tag: TAG,
  summary: 'Athlete side: confirm or reject a claimed milestone. Confirming adds its agreed amount to what is owed (within any cap). A guardian decides for a young person.',
  input: z.object({ id, decision: z.enum(['confirm', 'reject']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ms = (await c.query('SELECT * FROM representation_milestones WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ms) throw notFound('Milestone');
      const ctx = await dealContext(c, user, ms.deal_id, { lock: true });
      if (!canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian confirms a milestone');
      const next = i.decision === 'confirm' ? 'confirmed' : 'rejected';
      if (ms.status === next) return ms;
      if (ms.status !== 'claimed') throw conflict(`That milestone is ${ms.status}`, { code: 'not_claimed' });
      const r = (await c.query('UPDATE representation_milestones SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *', [i.id, next, user.id])).rows[0];
      await logEvent(c, ctx.deal.mandate_id, user.id, ctx.side, `milestone_${next}`, { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { milestone: ms.milestone_key } });
      if (next === 'confirmed') await accrueDeal(c, ctx.deal.id, user.id);
      return r;
    });
  },
});

// ------------------------------------------------------------------ statements and money states
async function lockedLadder(c, user, dealId, who) {
  const ctx = await dealContext(c, user, dealId, { lock: true });
  if (who === 'agent' && !ctx.agentOk) throw forbidden('Only the agent (or staff with the commission permission) can do this');
  if (who === 'athlete' && !canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian can do this');
  if (ctx.deal.status !== 'confirmed' && ctx.deal.status !== 'ended') throw conflict('The deal link is not confirmed', { code: 'not_confirmed' });
  return { ctx, ladder: await ladderOf(c, dealId) };
}
const dupRef = async (c, dealId, idem, what) => { if ((await c.query('SELECT 1 FROM representation_commission_entries WHERE deal_id=$1 AND idem_key=$2', [dealId, idem])).rowCount) throw conflict(`That ${what} reference was already recorded`, { code: 'duplicate_reference' }); };
const ins = (c, dealId, currency, kind, amount, { reference = null, reason = null, statement = null, idem, user }) => c.query(
  'INSERT INTO representation_commission_entries(deal_id, currency, kind, amount_cents, statement_id, reference, reason, idem_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (deal_id, idem_key) DO NOTHING RETURNING id',
  [dealId, currency, kind, amount, statement, reference, reason, idem, user]);

cap({
  name: 'issue_commission_statement', method: 'POST', path: '/representation/deals/:id/statements', tag: TAG, status: 201,
  summary: 'Agent: issue a numbered statement for the commission that is owed and not yet invoiced on one deal. It is an immutable snapshot (lines and a SHA-256). Issuing a statement does not mean anything was paid. Nothing to invoice is refused.',
  input: z.object({ id, due_on: z.string().date().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, ladder } = await lockedLadder(c, user, i.id, 'agent');
      if (ladder.uninvoiced_cents <= 0) throw conflict('There is nothing new to invoice', { code: 'nothing_to_invoice' });
      const no = (await c.query("SELECT 'REP-STM-' || to_char(now(),'YYYY') || '-' || lpad(nextval('representation_statement_no_seq')::text, 4, '0') AS n")).rows[0].n;
      const lines = (await c.query("SELECT seq, kind, amount_cents, basis_cents, calc, reason, created_at FROM representation_commission_entries WHERE deal_id=$1 AND kind IN ('accrual','adjustment') ORDER BY seq", [i.id])).rows;
      const snapshot = { deal_ref: ctx.deal.deal_ref, term_key: ctx.deal.term_key, term_version: ctx.deal.term_version, currency: ctx.deal.currency, owed_cents: ladder.owed_cents, previously_invoiced_cents: ladder.invoiced_cents, this_statement_cents: ladder.uninvoiced_cents, lines };
      const sha = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const s = (await c.query('INSERT INTO representation_statements(statement_no, deal_id, currency, amount_cents, due_on, lines, sha256, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [no, i.id, ctx.deal.currency, ladder.uninvoiced_cents, i.due_on ?? null, JSON.stringify(snapshot), sha, user.id])).rows[0];
      await ins(c, i.id, ctx.deal.currency, 'invoiced', ladder.uninvoiced_cents, { statement: s.id, idem: `stm:${s.id}`, user: user.id });
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'statement_issued', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { statement_no: no } });
      await notifyAthleteSide(c, ctx.mandate, { kind: 'representation_statement', title: 'A commission statement was issued', body: `${no}. Issuing a statement does not mean anything is paid yet.`, data: { deal_id: i.id } }, user.id);
      return { ...s, lines: snapshot };
    });
  },
});

cap({
  name: 'void_commission_statement', method: 'POST', path: '/representation/statements/:id/void', tag: TAG,
  summary: 'Agent: void a statement that no payment has been applied against, with a reason. The amount becomes uninvoiced again; nothing is deleted.',
  input: z.object({ id, reason: text(500).min(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM representation_statements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Statement');
      const { ctx, ladder } = await lockedLadder(c, user, s.deal_id, 'agent');
      if (s.status === 'void') return s;
      if (ladder.invoiced_cents - Number(s.amount_cents) < Math.max(ladder.settled_cents, ladder.reported_cents)) throw conflict('Payments have been reported or settled against this amount; adjust instead of voiding', { code: 'payments_applied' });
      await c.query("UPDATE representation_statements SET status='void', voided_at=now(), void_reason=$2 WHERE id=$1", [s.id, i.reason]);
      await ins(c, s.deal_id, s.currency, 'invoiced', -Number(s.amount_cents), { statement: s.id, reason: i.reason, idem: `void:${s.id}`, user: user.id });
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'statement_voided', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { statement_no: s.statement_no } });
      return { ...s, status: 'void' };
    });
  },
});

cap({
  name: 'report_commission_payment', method: 'POST', path: '/representation/deals/:id/payments-reported', tag: TAG, status: 201,
  summary: 'Athlete side: say you paid some of an invoiced commission, with a reference. This is only your report: it is not settled until the agent confirms they received it. Cannot exceed what has been invoiced; the same reference cannot be reported twice.',
  input: z.object({ id, amount_cents: cents, reference: text(120).min(2), paid_on: z.string().date().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, ladder } = await lockedLadder(c, user, i.id, 'athlete');
      await dupRef(c, i.id, `rpt:${i.reference}`, 'payment');
      if (i.amount_cents > ladder.invoiced_cents - ladder.reported_cents) throw conflict('That is more than has been invoiced and not yet reported', { code: 'exceeds_invoiced' });
      const r = await ins(c, i.id, ctx.deal.currency, 'payment_reported', i.amount_cents, { reference: i.reference, reason: i.paid_on ? `paid on ${i.paid_on}` : null, idem: `rpt:${i.reference}`, user: user.id });
      if (!r.rowCount) throw conflict('That payment reference was already reported', { code: 'duplicate_reference' });
      await logEvent(c, ctx.deal.mandate_id, user.id, ctx.side, 'payment_reported', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { amount_cents: i.amount_cents } });
      await notifyAgentSide(c, ctx.mandate, { kind: 'representation_payment_reported', title: 'A commission payment was reported', body: 'Confirm it once you have received it. Until then it is not settled.', data: { deal_id: i.id } }, user.id, 'commission');
      return dealView(c, ctx);
    });
  },
});

cap({
  name: 'confirm_commission_payment', method: 'POST', path: '/representation/deals/:id/payments', tag: TAG, status: 201,
  summary: 'Agent: confirm that you received a payment of invoiced commission, with the bank or payment reference. Only this makes money "settled" - an invoice or a reported payment never does. Cannot exceed what is invoiced and unsettled; the same reference cannot be recorded twice.',
  input: z.object({ id, amount_cents: cents, reference: text(120).min(2) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, ladder } = await lockedLadder(c, user, i.id, 'agent');
      await dupRef(c, i.id, `set:${i.reference}`, 'payment');
      if (i.amount_cents > ladder.invoiced_cents - ladder.settled_cents) throw conflict('That is more than has been invoiced and not yet settled', { code: 'exceeds_invoiced' });
      const r = await ins(c, i.id, ctx.deal.currency, 'payment_settled', i.amount_cents, { reference: i.reference, idem: `set:${i.reference}`, user: user.id });
      if (!r.rowCount) throw conflict('That payment reference was already recorded', { code: 'duplicate_reference' });
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'payment_settled', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { amount_cents: i.amount_cents } });
      await notifyAthleteSide(c, ctx.mandate, { kind: 'representation_payment_settled', title: 'A commission payment was confirmed', body: 'Your agent confirmed they received it.', data: { deal_id: i.id } }, user.id);
      return dealView(c, ctx);
    });
  },
});

cap({
  name: 'adjust_commission', method: 'POST', path: '/representation/deals/:id/adjustments', tag: TAG, status: 201,
  summary: 'Agent: reduce what is owed (a waiver, a correction or a discount) with a reason. An agent can only reduce commission; increases come from the agreed term and the deal\'s facts. Safe to retry with the same client_key.',
  input: z.object({ id, credit_cents: cents, reason: text(500).min(3), client_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, ladder } = await lockedLadder(c, user, i.id, 'agent');
      if (i.credit_cents > ladder.owed_cents) throw conflict('That is more than is owed', { code: 'exceeds_owed' });
      const n = Number((await c.query("SELECT count(*) AS n FROM representation_commission_entries WHERE deal_id=$1 AND kind='adjustment'", [i.id])).rows[0].n);
      await ins(c, i.id, ctx.deal.currency, 'adjustment', -i.credit_cents, { reason: i.reason, idem: i.client_key ? `adj:${i.client_key}` : `adj:${n + 1}`, user: user.id });
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'commission_adjusted', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { credit_cents: i.credit_cents, reason: i.reason } });
      return dealView(c, ctx);
    });
  },
});

cap({
  name: 'record_commission_refund', method: 'POST', path: '/representation/deals/:id/refunds', tag: TAG, status: 201,
  summary: 'Agent: record money you returned to the athlete (for example after a credit), with a reference and reason. It lowers what counts as settled; it cannot exceed what was settled.',
  input: z.object({ id, amount_cents: cents, reference: text(120).min(2), reason: text(500).min(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, ladder } = await lockedLadder(c, user, i.id, 'agent');
      await dupRef(c, i.id, `ref:${i.reference}`, 'refund');
      if (i.amount_cents > ladder.settled_cents) throw conflict('That is more than was settled', { code: 'exceeds_settled' });
      const r = await ins(c, i.id, ctx.deal.currency, 'refund', -i.amount_cents, { reference: i.reference, reason: i.reason, idem: `ref:${i.reference}`, user: user.id });
      if (!r.rowCount) throw conflict('That refund reference was already recorded', { code: 'duplicate_reference' });
      await logEvent(c, ctx.deal.mandate_id, user.id, sideLabel(ctx), 'commission_refunded', { subject_type: ctx.deal.deal_type, subject_id: ctx.deal.deal_id, detail: { amount_cents: i.amount_cents } });
      return dealView(c, ctx);
    });
  },
});

cap({
  name: 'get_commission_statement', method: 'GET', path: '/representation/statements/:id', tag: TAG,
  summary: 'One statement: its number, amount, status and the exact lines it was issued with. Add format=csv for a file. Athlete side and agent side.',
  input: z.object({ id, format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM representation_statements WHERE id=$1', [i.id]);
    if (!s) throw notFound('Statement');
    const ctx = await dealContext(pool, user, s.deal_id);
    if (ctx.acting) await audit(null, user.id, 'read_commission_statement', 'representation_statements', s.id);
    if (i.format === 'json') return s;
    const rows = s.lines.lines.map((l) => ({ line: l.seq, kind: l.kind, amount: (Number(l.amount_cents) / 100).toFixed(2), basis: l.basis_cents == null ? '' : (Number(l.basis_cents) / 100).toFixed(2), note: l.reason ?? '' }));
    return { filename: `${s.statement_no}.csv`, rows: rows.length, csv: toCsv(['line', 'kind', 'amount', 'basis', 'note'], rows), sha256: s.sha256, currency: s.currency, total: (Number(s.amount_cents) / 100).toFixed(2) };
  },
});
