// Partner contracts and revenue settlement. A contract is generated from a template plus the commercial terms negotiated during
// venue onboarding (commission, settlement cycle, reserve, payment costs, custom clauses). The partner accepts it digitally
// (the accepted text is fingerprinted). Settlements then split every paid invoice and credit note of the venue per the active
// contract; each invoice can be settled once, voiding a draft frees its invoices, and nothing is ever deleted.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { DEFAULT_TEMPLATE, DEFAULT_TERMS, isPlatform, renderContract, settlementFlags, sha } from '../platform.js';

const TAG = 'Partner contracts & settlements';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };

export const termsSchema = z.object({
  commission_bp: z.number().int().min(0).max(10000), commission_tax_bp: z.number().int().min(0).max(10000), gateway_fee_bp: z.number().int().min(0).max(2000),
  reserve_bp: z.number().int().min(0).max(5000), reserve_days: z.number().int().min(0).max(365), settlement_cycle: z.enum(['weekly', 'biweekly', 'monthly']),
  settlement_delay_days: z.number().int().min(0).max(60), term_months: z.number().int().min(1).max(120), auto_renew: z.boolean(), notice_days: z.number().int().min(0).max(365),
  exclusivity: z.boolean(), governing_law: z.string().min(2).max(120),
}).partial().strict();
const clauseSchema = z.object({ title: z.string().max(80).optional(), text: z.string().min(3).max(2000) });

export const csvEscape = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const addMonths = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

/** Create (and optionally send) a contract. Reused by venue approval so the contract is part of onboarding. `c` is a transaction client. */
export async function createContract(c, user, i) {
  const partner = (await c.query('SELECT * FROM partners WHERE id=$1', [i.partner_id])).rows[0];
  if (!partner) throw notFound('Partner');
  const venue = i.venue_id ? (await c.query('SELECT id, name, city, partner_id FROM venues WHERE id=$1', [i.venue_id])).rows[0] : null;
  if (i.venue_id && (!venue || venue.partner_id !== partner.id)) throw badRequest('That venue does not belong to this partner');
  const tpl = i.template_id ? (await c.query('SELECT * FROM contract_templates WHERE id=$1 AND active', [i.template_id])).rows[0] : null;
  if (i.template_id && !tpl) throw notFound('Contract template');
  const parsed = termsSchema.safeParse(i.terms ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
  const terms = { ...DEFAULT_TERMS, ...(tpl?.default_terms ?? {}), ...parsed.data };
  const clauses = (i.clauses ?? []).map((x) => clauseSchema.parse(x));
  const from = i.effective_from ?? today(), to = i.effective_to ?? null;
  if (to && to < from) throw badRequest('effective_to is before effective_from');
  const prev = (await c.query("SELECT id, version FROM partner_contracts WHERE partner_id=$1 AND venue_id IS NOT DISTINCT FROM $2 AND status IN ('active','sent','draft') ORDER BY version DESC LIMIT 1", [partner.id, i.venue_id ?? null])).rows[0];
  const version = ((await c.query('SELECT coalesce(max(version),0)::int AS v FROM partner_contracts WHERE partner_id=$1 AND venue_id IS NOT DISTINCT FROM $2', [partner.id, i.venue_id ?? null])).rows[0].v) + 1;
  const contractNo = `CTR-${String((await c.query("SELECT nextval('contract_no_seq') AS n")).rows[0].n).padStart(6, '0')}`;
  const body = renderContract({ template: tpl?.body ?? DEFAULT_TEMPLATE, contractNo, partner, venue, terms, clauses, effectiveFrom: from, effectiveTo: to ?? (terms.auto_renew ? null : addMonths(from, terms.term_months)) });
  const row = (await c.query(
    `INSERT INTO partner_contracts(contract_no, partner_id, venue_id, version, supersedes_id, template_id, status, terms, clauses, body, body_sha256, effective_from, effective_to, sent_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [contractNo, partner.id, i.venue_id ?? null, version, prev?.id ?? null, tpl?.id ?? null, i.send ? 'sent' : 'draft', JSON.stringify(terms), JSON.stringify(clauses), body, sha(body), from, to, i.send ? new Date() : null, user.id])).rows[0];
  await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [partner.id, user.id, i.send ? 'contract_sent' : 'contract_drafted', JSON.stringify({ contract_no: contractNo, version })]);
  if (i.send) await notify(c, partner.owner_id, { kind: 'contract', title: `Contract ${contractNo} is ready for your review`, body: 'Review the terms and accept to start revenue settlement.', data: { contract_id: row.id } });
  return row;
}

const canSeeContract = (user, partner) => isPlatform(user) || partner.owner_id === user.id;
async function loadContract(user, cid) {
  const k = await one('SELECT k.*, p.owner_id, p.name AS partner_name FROM partner_contracts k JOIN partners p ON p.id=k.partner_id WHERE k.id=$1', [cid]);
  if (!k || !canSeeContract(user, k)) throw notFound('Contract');
  if (!isPlatform(user) && k.status === 'draft') throw notFound('Contract');
  return k;
}

const create = {
  partner_id: id, venue_id: id.optional().describe('omit = covers every venue of the partner'), terms: z.record(z.string(), z.any()).optional().describe('commission_bp, commission_tax_bp, gateway_fee_bp, reserve_bp, reserve_days, settlement_cycle (weekly|biweekly|monthly), settlement_delay_days, term_months, auto_renew, notice_days, exclusivity, governing_law'),
  clauses: z.array(clauseSchema).max(20).optional(), template_id: id.optional(), effective_from: z.string().date().optional(), effective_to: z.string().date().optional(),
};

cap({
  name: 'generate_contract', method: 'POST', path: '/admin/contracts', tag: TAG, status: 201,
  summary: 'Platform team: generate a partner contract from the standard template (or a custom one) plus the negotiated terms and custom clauses, as a draft or sent straight to the partner. `preview: true` only renders the text. Generating a new one for the same venue creates the next version; the old one stays active until the partner accepts the new one.',
  input: z.object({ ...create, send: z.boolean().default(false), preview: z.boolean().default(false) }),
  async handler({ user }, i) {
    platformOnly(user);
    const { preview, ...rest } = i;
    if (preview) {
      let out;
      try { await tx(async (c) => { out = await createContract(c, user, rest); throw Object.assign(new Error('rollback'), { preview: true }); }); } catch (e) { if (!e.preview) throw e; }
      return { preview: true, body: out.body, terms: out.terms, version: out.version };
    }
    return tx((c) => createContract(c, user, rest));
  },
});

cap({
  name: 'update_contract', method: 'PATCH', path: '/admin/contracts/:id', tag: TAG,
  summary: 'Platform team: edit the terms, clauses or dates of a contract that is still a draft (the text is regenerated). A sent contract is changed by generating a new version instead.',
  input: z.object({ id, terms: create.terms, clauses: create.clauses, effective_from: create.effective_from, effective_to: create.effective_to }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const k = (await c.query('SELECT * FROM partner_contracts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!k) throw notFound('Contract');
      if (k.status !== 'draft') throw conflict('Only a draft can be edited — generate a new version instead');
      const out = await createContract(c, user, { partner_id: k.partner_id, venue_id: k.venue_id, terms: { ...k.terms, ...(i.terms ?? {}) }, clauses: i.clauses ?? k.clauses, template_id: k.template_id, effective_from: i.effective_from ?? iso(k.effective_from), effective_to: i.effective_to ?? iso(k.effective_to) ?? undefined });
      // the regenerated draft replaces the old draft (kept as superseded history)
      await c.query("UPDATE partner_contracts SET status='superseded' WHERE id=$1", [k.id]);
      return out;
    });
  },
});

cap({
  name: 'list_contracts', method: 'GET', path: '/admin/contracts', tag: TAG,
  summary: 'Platform team: contracts, filterable by partner, venue or status.',
  input: z.object({ partner_id: id.optional(), venue_id: id.optional(), status: z.enum(['draft', 'sent', 'active', 'declined', 'terminated', 'superseded']).optional(), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    return many(`SELECT k.id, k.contract_no, k.version, k.status, k.partner_id, p.name AS partner_name, k.venue_id, v.name AS venue_name, k.terms, k.effective_from, k.effective_to, k.sent_at, k.accepted_at
                   FROM partner_contracts k JOIN partners p ON p.id=k.partner_id LEFT JOIN venues v ON v.id=k.venue_id
                  WHERE ($1::uuid IS NULL OR k.partner_id=$1) AND ($2::uuid IS NULL OR k.venue_id=$2) AND ($3::text IS NULL OR k.status=$3) ORDER BY k.created_at DESC LIMIT $4 OFFSET $5`,
      [i.partner_id ?? null, i.venue_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_contract', method: 'GET', path: '/contracts/:id', tag: TAG,
  summary: 'A contract with its full text and fingerprint. The platform team and the partner owner can read it (drafts are platform-only).',
  input: z.object({ id }),
  async handler({ user }, i) { return loadContract(user, i.id); },
});

cap({
  name: 'send_contract', method: 'POST', path: '/admin/contracts/:id/send', tag: TAG,
  summary: 'Platform team: send a draft contract to the partner owner for acceptance.',
  input: z.object({ id }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const k = (await c.query('SELECT k.*, p.owner_id FROM partner_contracts k JOIN partners p ON p.id=k.partner_id WHERE k.id=$1 FOR UPDATE OF k', [i.id])).rows[0];
      if (!k) throw notFound('Contract');
      if (k.status !== 'draft') throw conflict(`This contract is already ${k.status}`);
      await c.query("UPDATE partner_contracts SET status='sent', sent_at=now() WHERE id=$1", [k.id]);
      await notify(c, k.owner_id, { kind: 'contract', title: `Contract ${k.contract_no} is ready for your review`, body: 'Review the terms and accept to start revenue settlement.', data: { contract_id: k.id } });
      return { id: k.id, status: 'sent' };
    });
  },
});

cap({
  name: 'respond_contract', method: 'POST', path: '/contracts/:id/response', tag: TAG,
  summary: 'Partner owner: accept (digital acceptance of the exact text, which then becomes the active contract and supersedes the earlier version) or decline a contract sent to you. Add a note if you decline.',
  input: z.object({ id, action: z.enum(['accept', 'decline']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = (await c.query('SELECT k.*, p.owner_id, p.id AS pid FROM partner_contracts k JOIN partners p ON p.id=k.partner_id WHERE k.id=$1 FOR UPDATE OF k', [i.id])).rows[0];
      if (!k || k.owner_id !== user.id) throw notFound('Contract');
      if (k.status !== 'sent') throw conflict(`This contract is ${k.status}, not awaiting your answer`);
      if (i.action === 'decline') {
        await c.query("UPDATE partner_contracts SET status='declined', termination_reason=$2 WHERE id=$1", [k.id, i.note ?? null]);
        await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [k.pid, user.id, 'contract_declined', JSON.stringify({ contract_no: k.contract_no, note: i.note ?? null })]);
        return { id: k.id, status: 'declined' };
      }
      await c.query("UPDATE partner_contracts SET status='superseded' WHERE partner_id=$1 AND venue_id IS NOT DISTINCT FROM $2 AND status='active' AND id <> $3", [k.pid, k.venue_id, k.id]);
      await c.query("UPDATE partner_contracts SET status='active', accepted_by=$2, accepted_at=now() WHERE id=$1", [k.id, user.id]);
      await c.query("UPDATE partners SET checklist = checklist || '{\"contract_signed\": true}'::jsonb, updated_at=now() WHERE id=$1", [k.pid]);
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [k.pid, user.id, 'contract_accepted', JSON.stringify({ contract_no: k.contract_no, sha256: k.body_sha256 })]);
      return { id: k.id, status: 'active', body_sha256: k.body_sha256 };
    });
  },
});

cap({
  name: 'terminate_contract', method: 'POST', path: '/admin/contracts/:id/terminate', tag: TAG,
  summary: 'Platform team: end a contract with a reason. Past settlements are untouched; no new settlement can be generated for the venue until another contract is active.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const k = (await c.query('SELECT * FROM partner_contracts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!k) throw notFound('Contract');
      if (!['draft', 'sent', 'active'].includes(k.status)) throw conflict(`This contract is already ${k.status}`);
      await c.query("UPDATE partner_contracts SET status='terminated', terminated_at=now(), termination_reason=$2 WHERE id=$1", [k.id, i.reason]);
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [k.partner_id, user.id, 'contract_terminated', JSON.stringify({ contract_no: k.contract_no, reason: i.reason })]);
      return { id: k.id, status: 'terminated' };
    });
  },
});

cap({
  name: 'create_contract_template', method: 'POST', path: '/admin/contract-templates', tag: TAG, status: 201,
  summary: 'Platform team: save a reusable contract template (plain text with {{placeholders}} such as {{contract_no}}, {{partner_legal_name}}, {{commission_pct}}, {{custom_clauses}}) and its default terms. Without one the built-in standard agreement is used.',
  input: z.object({ name: z.string().min(2).max(80), body: z.string().min(50).max(20000), default_terms: z.record(z.string(), z.any()).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    const t = termsSchema.safeParse(i.default_terms ?? {});
    if (!t.success) throw badRequest(t.error.issues.map((x) => x.message).join('; '));
    return one('INSERT INTO contract_templates(name, body, default_terms, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.name, i.body, JSON.stringify(t.data), user.id]);
  },
});
cap({
  name: 'list_contract_templates', method: 'GET', path: '/admin/contract-templates', tag: TAG,
  summary: 'Platform team: saved contract templates plus the built-in standard text and default terms.',
  async handler({ user }) {
    platformOnly(user);
    return { builtin: { body: DEFAULT_TEMPLATE, terms: DEFAULT_TERMS }, templates: await many('SELECT * FROM contract_templates WHERE active ORDER BY created_at DESC') };
  },
});

// ------------------------------------------------------------------ settlements
const PLATFORM_METHODS = ['online', 'wallet'];

/** The contract that governs a venue today: venue-specific over partner-wide, newest first. */
export async function activeContract(c, venue) {
  return (await c.query(
    `SELECT * FROM partner_contracts WHERE partner_id=$1 AND status='active' AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date) AND (venue_id=$2 OR venue_id IS NULL)
      ORDER BY (venue_id IS NOT NULL) DESC, version DESC LIMIT 1`, [venue.partner_id, venue.id])).rows[0] ?? null;
}

/** Unsettled paid invoices and credit notes of a venue up to (excluding) `before`, as signed settlement lines. */
async function unsettledLines(c, venueId, before) {
  const rows = (await c.query(
    `SELECT i.id, i.kind, i.number, i.total_cents, i.tax_cents, i.payment_method, i.refund_status, i.parent_id, pi.payment_method AS parent_method
       FROM invoices i LEFT JOIN invoices pi ON pi.id = i.parent_id
      WHERE i.venue_id=$1 AND ((i.kind='invoice' AND i.status='paid' AND i.paid_at < $2) OR (i.kind='credit_note' AND i.status='paid' AND i.issued_at < $2))
        AND NOT EXISTS (SELECT 1 FROM settlement_lines l WHERE l.invoice_id=i.id AND l.live) ORDER BY i.issued_at`, [venueId, before])).rows;
  return rows.map((r) => {
    const sign = r.kind === 'credit_note' ? -1 : 1;
    const method = r.kind === 'credit_note' ? (r.parent_method ?? (r.refund_status === 'manual' ? 'cash' : 'online')) : r.payment_method;
    return { invoice_id: r.id, kind: r.kind, description: `${r.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${r.number}`, sales_cents: sign * (r.total_cents - r.tax_cents), tax_cents: sign * r.tax_cents,
      collected_cents: sign * r.total_cents, collected_by: PLATFORM_METHODS.includes(method) ? 'platform' : 'venue' };
  });
}

const rnd = (n) => Math.round(n);
function figures(lines, terms, reserveReleased, adjustments) {
  const sum = (f, pick = () => true) => lines.filter(pick).reduce((s, l) => s + f(l), 0);
  const sales = sum((l) => l.sales_cents), tax = sum((l) => l.tax_cents);
  const platform = sum((l) => l.collected_cents, (l) => l.collected_by === 'platform'), venue = sum((l) => l.collected_cents, (l) => l.collected_by === 'venue');
  const commission = rnd((sales * terms.commission_bp) / 10000);
  const commissionTax = rnd((commission * terms.commission_tax_bp) / 10000);
  const gateway = Math.max(0, rnd((platform * terms.gateway_fee_bp) / 10000));
  const reserve = platform > 0 ? rnd((platform * terms.reserve_bp) / 10000) : 0;
  const refunds = -sum((l) => l.sales_cents, (l) => l.kind === 'credit_note');
  return { invoices_count: lines.length, sales_cents: sales, tax_cents: tax, platform_collected_cents: platform, venue_collected_cents: venue, commission_cents: commission, commission_tax_cents: commissionTax,
    gateway_fee_cents: gateway, reserve_held_cents: reserve, reserve_released_cents: reserveReleased, adjustments_cents: adjustments, refunds_cents: refunds,
    net_payable_cents: platform - commission - commissionTax - gateway - reserve + reserveReleased + adjustments };
}

cap({
  name: 'generate_settlement', method: 'POST', path: '/admin/settlements', tag: TAG, status: 201,
  summary: 'Platform team: settle a venue up to a period end per its active contract. Takes every paid invoice and credit note not yet settled (so nothing is missed or counted twice): commission and its tax, online payment costs and reserve come off what the platform collected; reserves from earlier settlements past their hold period are released. `dry_run: true` previews without saving. Flags unusual figures (negative payout, high refunds, mostly-cash, big swings). Needs an accepted contract.',
  input: z.object({ venue_id: id, period_end: z.string().date(), dry_run: z.boolean().default(false), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settle:${i.venue_id}`]);
      const venue = (await c.query('SELECT id, name, partner_id, currency FROM venues WHERE id=$1', [i.venue_id])).rows[0];
      if (!venue) throw notFound('Venue');
      if (!venue.partner_id) throw conflict('This venue has no partner — link it to one first');
      const contract = await activeContract(c, venue);
      if (!contract) throw conflict('No accepted, in-force contract covers this venue — generate one and have the partner accept it');
      const end = new Date(`${i.period_end}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
      const lines = await unsettledLines(c, venue.id, end.toISOString());
      const terms = contract.terms;
      const releasable = (await c.query(
        `SELECT id, reserve_held_cents FROM settlements WHERE venue_id=$1 AND status IN ('approved','paid') AND reserve_held_cents > 0 AND reserve_released_by IS NULL AND period_end <= ($2::date - $3::int)`, [venue.id, i.period_end, terms.reserve_days ?? 0])).rows;
      const released = releasable.reduce((s, r) => s + r.reserve_held_cents, 0);
      const f = figures(lines, terms, released, 0);
      const prev = (await c.query("SELECT sales_cents FROM settlements WHERE venue_id=$1 AND status <> 'void' ORDER BY period_end DESC, created_at DESC LIMIT 1", [venue.id])).rows[0];
      const flags = settlementFlags(f, prev);
      const { refunds_cents, ...cols } = f;
      if (i.dry_run) return { dry_run: true, venue_id: venue.id, contract_no: contract.contract_no, currency: venue.currency, period_end: i.period_end, ...f, flags, lines };
      const last = (await c.query("SELECT period_end FROM settlements WHERE venue_id=$1 AND status <> 'void' ORDER BY period_end DESC LIMIT 1", [venue.id])).rows[0];
      const no = `STL-${String((await c.query("SELECT nextval('settlement_no_seq') AS n")).rows[0].n).padStart(6, '0')}`;
      const s = (await c.query(
        `INSERT INTO settlements(settlement_no, partner_id, venue_id, contract_id, currency, period_start, period_end, commission_bp, flags, notes, created_by,
           invoices_count, sales_cents, tax_cents, platform_collected_cents, venue_collected_cents, commission_cents, commission_tax_cents, gateway_fee_cents, reserve_held_cents, reserve_released_cents, adjustments_cents, net_payable_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [no, venue.partner_id, venue.id, contract.id, venue.currency, last ? new Date(new Date(last.period_end).getTime() + 864e5).toISOString().slice(0, 10) : null, i.period_end, terms.commission_bp, JSON.stringify(flags), i.notes ?? null, user.id,
          cols.invoices_count, cols.sales_cents, cols.tax_cents, cols.platform_collected_cents, cols.venue_collected_cents, cols.commission_cents, cols.commission_tax_cents, cols.gateway_fee_cents, cols.reserve_held_cents, cols.reserve_released_cents, cols.adjustments_cents, cols.net_payable_cents])).rows[0];
      for (const l of lines) await c.query('INSERT INTO settlement_lines(settlement_id, invoice_id, kind, description, sales_cents, collected_cents, collected_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [s.id, l.invoice_id, l.kind, l.description, l.sales_cents, l.collected_cents, l.collected_by]);
      if (releasable.length) await c.query('UPDATE settlements SET reserve_released_by=$2 WHERE id = ANY($1::uuid[])', [releasable.map((r) => r.id), s.id]);
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [venue.partner_id, user.id, 'settlement_drafted', JSON.stringify({ settlement_no: no, net_payable_cents: s.net_payable_cents })]);
      return { ...s, refunds_cents, flags };
    });
  },
});

async function loadSettlement(user, sid) {
  const s = await one('SELECT s.*, p.owner_id, p.name AS partner_name, v.name AS venue_name FROM settlements s JOIN partners p ON p.id=s.partner_id JOIN venues v ON v.id=s.venue_id WHERE s.id=$1', [sid]);
  if (!s || (!isPlatform(user) && (s.owner_id !== user.id || s.status === 'draft'))) throw notFound('Settlement');
  return s;
}
const LIST_COLS = `s.id, s.settlement_no, s.partner_id, p.name AS partner_name, s.venue_id, v.name AS venue_name, s.currency, s.period_start, s.period_end, s.status, s.invoices_count, s.sales_cents, s.commission_cents,
  s.commission_tax_cents, s.gateway_fee_cents, s.reserve_held_cents, s.reserve_released_cents, s.adjustments_cents, s.net_payable_cents, s.flags, s.payout_ref, s.paid_at, s.created_at`;

cap({
  name: 'list_settlements', method: 'GET', path: '/settlements', tag: TAG,
  summary: 'Settlements. The platform team sees all (filter by partner, venue, status); a partner owner sees their own approved and paid ones.',
  input: z.object({ partner_id: id.optional(), venue_id: id.optional(), status: z.enum(['draft', 'approved', 'paid', 'void']).optional(), ...page }),
  async handler({ user }, i) {
    const own = !isPlatform(user);
    return many(`SELECT ${LIST_COLS} FROM settlements s JOIN partners p ON p.id=s.partner_id JOIN venues v ON v.id=s.venue_id
                  WHERE ($1::uuid IS NULL OR s.partner_id=$1) AND ($2::uuid IS NULL OR s.venue_id=$2) AND ($3::text IS NULL OR s.status=$3)
                    AND (NOT $4 OR (p.owner_id=$5 AND s.status IN ('approved','paid'))) ORDER BY s.created_at DESC LIMIT $6 OFFSET $7`,
      [i.partner_id ?? null, i.venue_id ?? null, i.status ?? null, own, user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_settlement', method: 'GET', path: '/settlements/:id', tag: TAG,
  summary: 'One settlement with every invoice / credit note line behind it. `format: csv` returns the statement as CSV text.',
  input: z.object({ id, format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    const s = await loadSettlement(user, i.id);
    const lines = await many('SELECT invoice_id, kind, description, sales_cents, collected_cents, collected_by, amount_cents FROM settlement_lines WHERE settlement_id=$1 ORDER BY kind, description', [s.id]);
    if (i.format === 'csv') {
      const head = ['settlement', 'kind', 'description', 'sales', 'collected', 'collected_by', 'adjustment'];
      const rows = lines.map((l) => [s.settlement_no, l.kind, l.description, l.sales_cents, l.collected_cents, l.collected_by ?? '', l.amount_cents]);
      rows.push([s.settlement_no, 'summary', 'commission', s.commission_cents, '', '', ''], [s.settlement_no, 'summary', 'commission tax', s.commission_tax_cents, '', '', ''], [s.settlement_no, 'summary', 'payment costs', s.gateway_fee_cents, '', '', ''],
        [s.settlement_no, 'summary', 'reserve held', s.reserve_held_cents, '', '', ''], [s.settlement_no, 'summary', 'reserve released', s.reserve_released_cents, '', '', ''], [s.settlement_no, 'summary', 'net payable', s.net_payable_cents, '', '', '']);
      return { csv: [head, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') };
    }
    return { ...s, lines };
  },
});

cap({
  name: 'add_settlement_adjustment', method: 'POST', path: '/admin/settlements/:id/adjustments', tag: TAG, status: 201,
  summary: 'Platform team: add a signed manual adjustment (credit or debit, e.g. a goodwill credit, a penalty, a dispute outcome) to a draft settlement. The reason is kept on the line.',
  input: z.object({ id, amount_cents: z.number().int().refine((n) => n !== 0, 'amount cannot be zero'), reason: z.string().min(3).max(300) }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM settlements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Settlement');
      if (s.status !== 'draft') throw conflict('Only a draft settlement can be adjusted');
      await c.query("INSERT INTO settlement_lines(settlement_id, kind, description, amount_cents) VALUES ($1,'adjustment',$2,$3)", [s.id, i.reason, i.amount_cents]);
      return (await c.query('UPDATE settlements SET adjustments_cents = adjustments_cents + $2, net_payable_cents = net_payable_cents + $2 WHERE id=$1 RETURNING *', [s.id, i.amount_cents])).rows[0];
    });
  },
});

cap({
  name: 'decide_settlement', method: 'POST', path: '/admin/settlements/:id/decision', tag: TAG,
  summary: 'Platform team: `approve` a draft (the partner can now see it), `mark_paid` an approved one with the payout reference, or `void` a draft/approved one (its invoices become settleable again and any reserve it released is freed). Paid settlements are final.',
  input: z.object({ id, action: z.enum(['approve', 'mark_paid', 'void']), payout_ref: z.string().min(2).max(120).optional(), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const s = (await c.query('SELECT s.*, p.owner_id FROM settlements s JOIN partners p ON p.id=s.partner_id WHERE s.id=$1 FOR UPDATE OF s', [i.id])).rows[0];
      if (!s) throw notFound('Settlement');
      const from = { approve: ['draft'], mark_paid: ['approved'], void: ['draft', 'approved'] }[i.action];
      if (!from.includes(s.status)) throw conflict(`A ${s.status} settlement cannot be ${i.action === 'mark_paid' ? 'marked paid' : i.action + 'd'}`);
      if (i.action === 'mark_paid' && !i.payout_ref) throw badRequest('Give the payout reference (bank transfer id)');
      if (i.action === 'void' && !i.reason) throw badRequest('Give a reason');
      if (i.action === 'approve') await c.query("UPDATE settlements SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1", [s.id, user.id]);
      if (i.action === 'mark_paid') await c.query("UPDATE settlements SET status='paid', payout_ref=$2, paid_at=now() WHERE id=$1", [s.id, i.payout_ref]);
      if (i.action === 'void') {
        await c.query("UPDATE settlements SET status='void', notes = coalesce(notes || E'\\n', '') || $2 WHERE id=$1", [s.id, `Voided: ${i.reason}`]);
        await c.query('UPDATE settlement_lines SET live=false WHERE settlement_id=$1', [s.id]);
        await c.query('UPDATE settlements SET reserve_released_by=NULL WHERE reserve_released_by=$1', [s.id]);
      }
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [s.partner_id, user.id, `settlement_${i.action}`, JSON.stringify({ settlement_no: s.settlement_no, payout_ref: i.payout_ref ?? null, reason: i.reason ?? null })]);
      if (i.action !== 'void') await notify(c, s.owner_id, { kind: 'settlement', title: `Settlement ${s.settlement_no} ${i.action === 'approve' ? 'is ready' : 'has been paid'}`, body: `Net ${s.net_payable_cents >= 0 ? 'payable to you' : 'owed to the platform'}: ${(Math.abs(s.net_payable_cents) / 100).toFixed(2)} ${s.currency}`, data: { settlement_id: s.id } });
      return { id: s.id, status: { approve: 'approved', mark_paid: 'paid', void: 'void' }[i.action] };
    });
  },
});
