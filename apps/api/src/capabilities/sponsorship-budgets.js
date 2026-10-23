// Sponsorship budget controls (#293): annual / program / department / event budgets for a brand, with derived planned / reserved /
// committed / paid / refunded / available balances, approval thresholds and an explicit, sourced FX policy. See src/sponsorship-budgets.js
// for the invariants (budgets are locked before anything is reserved or committed, so concurrent awards cannot overspend).
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { logHistory } from '../sponsor-agreements.js';
import { sponsorAccess, assertSponsorCan, actionsFor, notifySponsor, sponsorRecipients } from '../sponsor-access.js';
import { budgetFor, budgetEvent, usageOf, rateFor, rollup, traceOf, KINDS, convert } from '../sponsorship-budgets.js';
import { programFor, checkVersion } from './sponsorship-programs.js';

const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD');
const date = z.string().date();
const REF_KINDS = ['approval', 'board_minutes', 'forecast', 'purchase_order', 'contract', 'policy', 'other'];
const httpsUrl = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'Links must be https');
const reference = z.object({ kind: z.enum(REF_KINDS), title: z.string().trim().min(2).max(160), url: httpsUrl.optional(), ref_no: z.string().trim().min(1).max(80).optional() })
  .refine((r) => r.url || r.ref_no, 'A reference needs a link or a reference number');
const MAX_REFS = 50;
const insertReference = (c, budgetId, r, userId) => c.query(
  'INSERT INTO sponsorship_budget_references(budget_id, kind, title, url, ref_no, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, title, url, ref_no, created_at', [budgetId, r.kind, r.title, r.url ?? null, r.ref_no ?? null, userId]).then((x) => x.rows[0]);
const ORDER = "CASE b.kind WHEN 'annual' THEN 0 WHEN 'department' THEN 1 WHEN 'program' THEN 2 ELSE 3 END";
const shape = (b, u) => ({ ...b, authorized_cents: Number(b.authorized_cents), approval_over_cents: b.approval_over_cents == null ? null : Number(b.approval_over_cents), ...u });
const stale = (b, v) => { if (b.row_version !== v) throw conflict(`This budget was changed by someone else (now version ${b.row_version}); the latest was loaded, review it and try again`, { current_version: b.row_version }); };

/** The caller's access to a brand for budgets: brand-wide staff see every budget, a department-scoped member only their department's. */
async function brandView(user, sponsorId, action, c) {
  const sp = await mustFind('sponsors', sponsorId, '*', c);
  if (isAdmin(user)) return { sp, access: { role: 'admin', departmentId: null } };
  const access = await sponsorAccess(user, sp, c);
  if (!access) throw notFound('Sponsor');
  assertSponsorCan(access, action, { departmentId: access.departmentId, what: action === 'budget_read' ? 'see budgets' : 'manage budgets' });
  return { sp, access };
}

cap({
  name: 'create_sponsorship_budget', method: 'POST', path: '/sponsorship-budgets', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/finance: authorize a budget for a brand -- an annual budget (needs a fiscal year), a program budget, a department budget (a department of the brand\'s organisation) or an event budget. A child budget (`parent_id`) is carved out of its parent in the same currency and can never exceed the parent\'s unallocated amount. `approval_over_cents` makes any offer above it wait for a second approver. `fx_policy` is `none` (this currency only) or `explicit` (other currencies only at a sourced rate you set). `notes` is the rationale; `basis_budget_id` the earlier budget this one was built from (see get_budget_guidance); `references` (up to 10) are approval memos, board minutes, PO or forecast links. Upload files with PUT /documents (subject_type `budget`).',
  input: z.object({
    sponsor_id: id, kind: z.enum(KINDS), name: z.string().min(2).max(120), fiscal_year: z.coerce.number().int().min(2000).max(2200).optional(), currency, authorized_cents: money,
    parent_id: id.optional(), department_id: id.optional(), event_id: id.optional(), approval_over_cents: money.optional(), fx_policy: z.enum(['none', 'explicit']).default('none'),
    notes: z.string().trim().max(2000).optional(), basis_budget_id: id.optional(), references: z.array(reference).max(10).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { sp, access } = await brandView(user, i.sponsor_id, 'budget', c);
      if (access.departmentId) throw forbidden('Authorizing budgets is brand-wide work');
      if (i.basis_budget_id && !(await c.query('SELECT 1 FROM sponsorship_budgets WHERE id=$1 AND sponsor_id=$2', [i.basis_budget_id, sp.id])).rowCount) throw badRequest('The budget this one is based on does not belong to this brand');
      let fiscal = i.fiscal_year ?? null, parent = null;
      if (i.parent_id) {
        parent = (await c.query('SELECT * FROM sponsorship_budgets WHERE id=$1 AND sponsor_id=$2 FOR UPDATE', [i.parent_id, sp.id])).rows[0]; // the parent is locked first
        if (!parent) throw badRequest('That parent budget does not belong to this brand');
        if (parent.status !== 'active') throw conflict('The parent budget is archived');
        if (parent.kind === 'event') throw unprocessable('An event budget cannot have child budgets');
        if (parent.currency !== i.currency) throw unprocessable(`A child budget uses its parent's currency (${parent.currency}); currencies are never mixed inside a budget tree`);
        fiscal ??= parent.fiscal_year;
        const free = (await usageOf(c, parent)).available_cents;
        if (i.authorized_cents > free) throw conflict(`The parent budget "${parent.name}" has only ${free} ${parent.currency} minor units left to allocate`, { available_cents: free });
      }
      if (i.kind === 'annual') {
        if (i.parent_id) throw unprocessable('An annual budget is the top of a budget tree');
        if (fiscal == null) throw badRequest('An annual budget needs a fiscal_year');
      }
      if (i.kind === 'department') {
        if (!i.department_id) throw badRequest('A department budget needs a department_id');
        if (!(sp.organisation_id && (await c.query('SELECT 1 FROM org_departments WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.department_id, sp.organisation_id])).rowCount)) throw badRequest('That department does not belong to this brand\'s organisation');
      } else if (i.department_id) throw badRequest('Only a department budget has a department');
      if (i.kind === 'event') {
        if (!i.event_id) throw badRequest('An event budget needs an event_id');
        await mustFind('events', i.event_id, 'id', c);
      } else if (i.event_id) throw badRequest('Only an event budget has an event');
      const row = (await c.query(
        `INSERT INTO sponsorship_budgets(sponsor_id, parent_id, kind, name, fiscal_year, currency, authorized_cents, department_id, event_id, approval_over_cents, fx_policy, created_by, notes, basis_budget_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [sp.id, i.parent_id ?? null, i.kind, i.name, fiscal, i.currency, i.authorized_cents, i.department_id ?? null, i.event_id ?? null, i.approval_over_cents ?? null, i.fx_policy, user.id, i.notes || null, i.basis_budget_id ?? null])
        .catch((e) => { if (e.code === '23505') throw conflict('A budget with that name, department or event already exists for this brand'); throw e; })).rows[0];
      for (const r of i.references ?? []) await insertReference(c, row.id, r, user.id);
      await budgetEvent(c, row.id, 'created', user.id, { authorized_cents: i.authorized_cents, currency: i.currency, parent_id: i.parent_id ?? null, basis_budget_id: i.basis_budget_id ?? null, references: (i.references ?? []).length });
      await audit(c, user.id, 'create', 'sponsorship_budgets', row.id);
      return shape(row, await usageOf(c, row));
    });
  },
});

cap({
  name: 'update_sponsorship_budget', method: 'PATCH', path: '/sponsorship-budgets/:id', tag: 'Sponsors',
  summary: 'Brand manager/finance: change a budget\'s name, rationale (`notes`), authorized amount, approval threshold or FX policy, or archive it. Needs the current `version` (409 if stale). The authorized amount can never drop below what is allocated to child budgets, reserved or committed, and a child can never grow past its parent\'s unallocated amount. Archiving needs nothing reserved, committed or still planned and no active child; archived budgets keep their history. Budgets are never deleted.',
  input: z.object({
    id, version: z.coerce.number().int().positive(), name: z.string().min(2).max(120).optional(), authorized_cents: money.optional(), approval_over_cents: money.nullable().optional(),
    fx_policy: z.enum(['none', 'explicit']).optional(), status: z.literal('archived').optional(), notes: z.string().trim().max(2000).nullable().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const b0 = (await c.query('SELECT parent_id FROM sponsorship_budgets WHERE id=$1', [i.id])).rows[0];
      if (!b0) throw notFound('Budget');
      if (b0.parent_id) await c.query('SELECT 1 FROM sponsorship_budgets WHERE id=$1 FOR UPDATE', [b0.parent_id]); // parent before child
      const { b } = await budgetFor(user, i.id, 'budget', c, true);
      stale(b, i.version);
      if (b.status === 'archived') throw conflict('This budget is archived');
      const u = await usageOf(c, b);
      const next = { name: i.name ?? b.name, authorized: i.authorized_cents ?? Number(b.authorized_cents), over: i.approval_over_cents === undefined ? b.approval_over_cents : i.approval_over_cents, fx: i.fx_policy ?? b.fx_policy, notes: i.notes === undefined ? b.notes : (i.notes || null) };
      if (next.authorized < u.allocated_cents + u.reserved_cents + u.committed_cents)
        throw conflict(`The budget cannot be lower than what is allocated, reserved and committed (${u.allocated_cents + u.reserved_cents + u.committed_cents} ${b.currency} minor units)`, { floor_cents: u.allocated_cents + u.reserved_cents + u.committed_cents });
      if (b.parent_id && next.authorized > Number(b.authorized_cents)) {
        const parent = (await c.query('SELECT * FROM sponsorship_budgets WHERE id=$1', [b.parent_id])).rows[0];
        const room = (await usageOf(c, parent)).available_cents;
        if (next.authorized - Number(b.authorized_cents) > room) throw conflict(`The parent budget "${parent.name}" has only ${room} ${b.currency} minor units left to allocate`, { available_cents: room });
      }
      if (next.fx === 'none' && b.fx_policy === 'explicit') {
        const used = (await c.query(
          `SELECT 1 FROM sponsorship_budget_fx_rates f WHERE f.budget_id=$1 AND (EXISTS (SELECT 1 FROM sponsorships s WHERE s.budget_fx_rate_id=f.id)
             OR EXISTS (SELECT 1 FROM sponsorship_award_reservations r WHERE r.budget_fx_rate_id=f.id)) LIMIT 1`, [b.id])).rowCount;
        if (used) throw conflict('Other currencies are already committed at an FX rate; the policy cannot go back to this currency only');
      }
      if (i.status === 'archived') {
        const kids = (await c.query("SELECT 1 FROM sponsorship_budgets WHERE parent_id=$1 AND status='active'", [b.id])).rowCount;
        if (kids) throw conflict('Archive the child budgets first');
        if (u.reserved_cents || u.committed_cents || u.planned_cents) throw conflict('This budget still has reserved, committed or planned money; it can be archived once those are settled, released or withdrawn');
        if ((await c.query('SELECT 1 FROM sponsorship_program_budgets l JOIN sponsorship_programs p ON p.id=l.program_id WHERE l.budget_id=$1 AND l.unlinked_at IS NULL AND p.status IN (\'draft\',\'published\') LIMIT 1', [b.id])).rowCount) throw conflict('A live program is still linked to this budget; unlink it first');
      }
      const row = (await c.query(
        `UPDATE sponsorship_budgets SET name=$2, authorized_cents=$3, approval_over_cents=$4, fx_policy=$5, status=coalesce($6,status), archived_at=CASE WHEN $6='archived' THEN now() ELSE archived_at END, notes=$7,
                row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [b.id, next.name, next.authorized, next.over, next.fx, i.status ?? null, next.notes]).catch((e) => { if (e.code === '23505') throw conflict('A budget with that name already exists for this brand'); throw e; })).rows[0];
      await budgetEvent(c, b.id, i.status === 'archived' ? 'archived' : 'updated', user.id, { from: { authorized_cents: Number(b.authorized_cents), approval_over_cents: b.approval_over_cents == null ? null : Number(b.approval_over_cents), fx_policy: b.fx_policy }, to: { authorized_cents: next.authorized, approval_over_cents: next.over == null ? null : Number(next.over), fx_policy: next.fx } });
      await audit(c, user.id, i.status === 'archived' ? 'archive' : 'update', 'sponsorship_budgets', b.id);
      return shape(row, await usageOf(c, row));
    });
  },
});

cap({
  name: 'list_sponsorship_budgets', method: 'GET', path: '/sponsorship-budgets', tag: 'Sponsors',
  summary: 'The budgets of one brand with planned / reserved / committed / paid / refunded / available balances in each budget\'s own currency, and a roll-up that adds a budget\'s children (same currency only -- different currencies are never added together). Brand finance/manager/approver/auditor; a department-scoped member only sees their department\'s budget. Deterministic order: fiscal year (newest first), kind, name, id.',
  input: z.object({ sponsor_id: id, fiscal_year: z.coerce.number().int().optional(), kind: z.enum(KINDS).optional(), status: z.enum(['active', 'archived']).default('active'), ...page }),
  async handler({ user }, i) {
    const { access } = await brandView(user, i.sponsor_id, 'budget_read', pool);
    const rows = (await pool.query(`SELECT b.* FROM sponsorship_budgets b WHERE b.sponsor_id=$1 ORDER BY b.fiscal_year DESC NULLS LAST, ${ORDER}, lower(b.name), b.id`, [i.sponsor_id])).rows;
    const withUse = [];
    for (const b of rows) withUse.push(shape(b, await usageOf(pool, b)));
    const tree = rollup(withUse);
    return tree
      .filter((b) => b.status === i.status && (i.fiscal_year == null || b.fiscal_year === i.fiscal_year) && (!i.kind || b.kind === i.kind) && (!access.departmentId || b.department_id === access.departmentId))
      .slice(i.offset, i.offset + i.limit);
  },
});

/** Everything that draws on a budget, one row per reservation / agreement / unanswered offer. */
async function commitments(c, b, { limit, offset }) {
  const { rows } = await c.query(
    `SELECT * FROM (
       SELECT 'reservation'::text AS kind, w.id, 'award' AS ref, w.status, r.currency, r.amount_cents, fx.rate, 0::bigint AS paid_cents, 0::bigint AS refunded_cents, r.created_at,
              ap.handle AS who, p.name AS program, NULL::text AS approval
         FROM sponsorship_award_reservations r JOIN sponsorship_awards w ON w.id=r.award_id JOIN sponsorship_applications a ON a.id=w.application_id JOIN users ap ON ap.id=a.applicant_id
         JOIN sponsorship_programs p ON p.id=r.program_id LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=r.budget_fx_rate_id
        WHERE r.budget_id=$1 AND r.status='held'
       UNION ALL
       SELECT 'agreement', ss.id, ss.agreement_ref, ss.status, o.currency,
              coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint, fx.rate,
              coalesce(sum((SELECT sum(x.amount_cents) FROM sponsorship_payments x WHERE x.obligation_id=o.id AND x.status='confirmed')),0)::bigint,
              coalesce(sum((SELECT sum(x.amount_cents) FROM sponsorship_payments x WHERE x.obligation_id=o.id AND x.status='reversed')),0)::bigint,
              ss.created_at, CASE ss.target_type WHEN 'athlete' THEN (SELECT handle FROM users WHERE id=ss.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=ss.target_id) ELSE (SELECT name FROM events WHERE id=ss.target_id) END,
              (SELECT name FROM sponsorship_programs WHERE id=ss.program_id), NULL::text
         FROM sponsorships ss JOIN sponsorship_obligations o ON o.sponsorship_id=ss.id AND o.kind='money' LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=ss.budget_fx_rate_id
        WHERE ss.budget_id=$1 GROUP BY ss.id, o.currency, fx.id
       UNION ALL
       SELECT 'planned', ss.id, ss.agreement_ref, ss.status, coalesce(ss.currency, b.currency), ss.amount_cents, fx.rate, 0, 0, ss.created_at,
              CASE ss.target_type WHEN 'athlete' THEN (SELECT handle FROM users WHERE id=ss.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=ss.target_id) ELSE (SELECT name FROM events WHERE id=ss.target_id) END, NULL, ss.budget_approval
         FROM sponsorships ss JOIN sponsorship_budgets b ON b.id=ss.budget_id LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=ss.budget_fx_rate_id
        WHERE ss.budget_id=$1 AND ss.status='proposed' AND ss.accepted_version IS NULL AND coalesce(ss.budget_approval,'') <> 'rejected'
     ) x ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [b.id, limit, offset]);
  return rows.map((r) => ({
    kind: r.kind, id: r.id, ref: r.ref, status: r.status, approval: r.approval, who: r.who, program: r.program, currency: r.currency, amount_cents: Number(r.amount_cents),
    budget_amount_cents: convert(r.amount_cents, r.currency, b.currency, r.rate ?? 1), paid_cents: Number(r.paid_cents), refunded_cents: Number(r.refunded_cents), fx_rate: r.rate == null ? null : Number(r.rate), created_at: r.created_at,
  }));
}

cap({
  name: 'get_sponsorship_budget', method: 'GET', path: '/sponsorship-budgets/:id', tag: 'Sponsors',
  summary: 'One budget: balances (authorized, allocated to children, planned, reserved, committed, paid, refunded, outstanding, available), the same per original currency with the rate used, child budgets, linked programs, the sourced FX rates, and the recent history. `can` lists what the caller may do. Proposals are planned only, never income. Brand staff with budget access; anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { b, sp } = await budgetFor(user, i.id, 'budget_read', pool);
    const access = isAdmin(user) ? { role: 'admin' } : await sponsorAccess(user, sp);
    const use = await usageOf(pool, b);
    const kids = [];
    for (const k of (await many("SELECT * FROM sponsorship_budgets WHERE parent_id=$1 AND status='active' ORDER BY lower(name), id", [b.id]))) kids.push(shape(k, await usageOf(pool, k)));
    const [programs, rates, history, references] = await Promise.all([
      many("SELECT p.id, p.name, p.status, p.currency, p.row_version, p.budget_cents::bigint AS budget_cents, (p.budget_id=$1) AS is_default FROM sponsorship_program_budgets l JOIN sponsorship_programs p ON p.id=l.program_id WHERE l.budget_id=$1 AND l.unlinked_at IS NULL ORDER BY p.created_at DESC, p.id", [b.id]),
      many('SELECT id, currency, rate::text AS rate, source, source_ref, as_of::text AS as_of, created_at, superseded_at FROM sponsorship_budget_fx_rates WHERE budget_id=$1 ORDER BY created_at DESC, id', [b.id]),
      many('SELECT e.id, e.kind, e.detail, e.created_at, u.display_name AS actor FROM sponsorship_budget_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.budget_id=$1 ORDER BY e.id DESC LIMIT 25', [b.id]),
      many('SELECT r.id, r.kind, r.title, r.url, r.ref_no, r.created_at, u.display_name AS added_by FROM sponsorship_budget_references r JOIN users u ON u.id=r.created_by WHERE r.budget_id=$1 AND r.removed_at IS NULL ORDER BY r.created_at DESC, r.id', [b.id])]);
    const basis = b.basis_budget_id ? await many('SELECT id, name, fiscal_year FROM sponsorship_budgets WHERE id=$1 AND sponsor_id=$2', [b.basis_budget_id, b.sponsor_id]) : [];
    const parent = b.parent_id ? await many('SELECT id, name, kind FROM sponsorship_budgets WHERE id=$1', [b.parent_id]) : [];
    const event = b.event_id ? await many('SELECT id, name FROM events WHERE id=$1', [b.event_id]) : [];
    const department = b.department_id ? await many('SELECT id, name FROM org_departments WHERE id=$1', [b.department_id]) : [];
    return { ...shape(b, use), sponsor_name: sp.name, my_role: access.role, can: isAdmin(user) ? ['budget_read', 'budget', 'budget_approve', 'export'] : actionsFor(access.role).filter((a) => ['budget_read', 'budget', 'budget_approve', 'export'].includes(a)), parent: parent[0] ?? null, event: event[0] ?? null, department: department[0] ?? null, children: kids, programs, fx_rates: rates, history, references, basis: basis[0] ?? null };
  },
});

cap({
  name: 'list_budget_commitments', method: 'GET', path: '/sponsorship-budgets/:id/commitments', tag: 'Sponsors',
  summary: 'What draws on a budget, newest first with deterministic pages: held reservations (awards not yet accepted), agreements (committed, with paid and refunded), and unanswered offers (planned only). Each row shows its own currency and the amount in the budget currency at the rate it was committed at.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { b } = await budgetFor(user, i.id, 'budget_read', pool);
    return commitments(pool, b, i);
  },
});

cap({
  name: 'set_budget_fx_rate', method: 'POST', path: '/sponsorship-budgets/:id/fx-rates', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/finance: record a sourced conversion rate (1 unit of `currency` = `rate` units of the budget currency) so another currency may be counted against an explicit-FX budget. A source is required (who published it, with an optional https reference and an as-of date). A new rate supersedes the old one for FUTURE commitments only; everything already committed keeps the rate it was committed at, so balances always reconcile. Needs the budget to have `fx_policy` explicit.',
  input: z.object({ id, currency, rate: z.coerce.number().min(0.00000001).max(1e9), source: z.string().min(2).max(200), source_ref: z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'source_ref must be an https link').optional(), as_of: date }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { b } = await budgetFor(user, i.id, 'budget', c, true);
      if (b.status !== 'active') throw conflict('This budget is archived');
      if (b.fx_policy !== 'explicit') throw conflict('This budget counts only its own currency; switch its FX policy to explicit first');
      if (i.currency === b.currency) throw badRequest(`${i.currency} is the budget currency and needs no rate`);
      await c.query('UPDATE sponsorship_budget_fx_rates SET superseded_at=now() WHERE budget_id=$1 AND currency=$2 AND superseded_at IS NULL', [b.id, i.currency]);
      const row = (await c.query(
        `INSERT INTO sponsorship_budget_fx_rates(budget_id, currency, rate, source, source_ref, as_of, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, currency, rate::text AS rate, source, source_ref, as_of::text AS as_of, created_at`,
        [b.id, i.currency, i.rate.toFixed(8), i.source, i.source_ref ?? null, i.as_of, user.id])).rows[0];
      await budgetEvent(c, b.id, 'fx_rate', user.id, { currency: i.currency, rate: row.rate, source: i.source, as_of: i.as_of });
      await audit(c, user.id, 'fx_rate', 'sponsorship_budgets', b.id);
      return row;
    });
  },
});

cap({
  name: 'link_program_budget', method: 'POST', path: '/sponsorship-programs/:id/budget', tag: 'Sponsors',
  summary: 'Brand manager/approver: let a sponsorship program\'s awards draw on an authorized budget. A program can be linked to several budgets and a budget to several programs (a budget funds any subset of spending); each award then names the budget it draws on (`budget_id` when deciding an application), defaulting to the program\'s default budget. The first budget linked becomes the default and takes over the program\'s existing unbudgeted reservations and agreements (they must fit it); pass `make_default` to change the default for new awards. Linking again is a no-op. The program\'s currency must be the budget\'s, or the budget needs an explicit sourced rate for it. Needs the program `version` (409 if stale).',
  input: z.object({ id, budget_id: id, version: z.coerce.number().int().positive(), make_default: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      checkVersion(p, i.version, 'program');
      if (['closed', 'archived'].includes(p.status)) throw conflict(`A ${p.status} program cannot change its budgets`);
      const { b } = await budgetFor(user, i.budget_id, 'budget_read', c, true);
      if (b.sponsor_id !== p.sponsor_id) throw badRequest('That budget belongs to another brand');
      if (b.status !== 'active') throw conflict('That budget is archived');
      if (b.kind === 'event') throw unprocessable('An event budget funds one event; a program draws on an annual, program or department budget');
      const linked = (await c.query('SELECT budget_id FROM sponsorship_program_budgets WHERE program_id=$1 AND unlinked_at IS NULL', [p.id])).rows.map((r) => r.budget_id);
      const already = linked.includes(b.id), first = linked.length === 0;
      if (already && !(i.make_default && p.budget_id !== b.id)) return p;
      if (!already) {
        const rateId = (await rateFor(c, b, p.currency)).id; // linking needs a sourced rate for the program's currency
        await c.query('INSERT INTO sponsorship_program_budgets(program_id, budget_id, created_by) VALUES ($1,$2,$3)', [p.id, b.id, user.id]);
        if (first) { // money the program already holds with no budget now belongs to its first budget
          await c.query("UPDATE sponsorship_award_reservations SET budget_id=$2, budget_fx_rate_id=$3 WHERE program_id=$1 AND status='held' AND budget_id IS NULL", [p.id, b.id, rateId]);
          await c.query('UPDATE sponsorships SET budget_id=$2, budget_fx_rate_id=$3 WHERE program_id=$1 AND budget_id IS NULL', [p.id, b.id, rateId]);
          await c.query("UPDATE sponsorship_awards SET budget_id=$2 WHERE program_id=$1 AND budget_id IS NULL AND status IN ('waitlisted','pending_approval','approved','issued','accepted')", [p.id, b.id]);
          const u = await usageOf(c, b);
          if (u.over_committed) throw conflict(`The program's reservations and agreements do not fit the authorized budget "${b.name}" (${-u.available_cents} ${b.currency} minor units over)`, { over_by_cents: -u.available_cents });
        }
        await budgetEvent(c, b.id, 'program_linked', user.id, { program_id: p.id });
      }
      const row = (await c.query('UPDATE sponsorship_programs SET budget_id=CASE WHEN $3 OR budget_id IS NULL THEN $2 ELSE budget_id END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [p.id, b.id, !!i.make_default])).rows[0];
      await audit(c, user.id, 'link_budget', 'sponsorship_programs', p.id);
      return row;
    });
  },
});

cap({
  name: 'unlink_program_budget', method: 'DELETE', path: '/sponsorship-programs/:id/budgets/:budget_id', tag: 'Sponsors',
  summary: 'Brand manager/approver: stop a program drawing on a budget. Refused while the program holds a reservation, an agreement or a live award on that budget (release or settle those first). The link is kept on record (`unlinked_at`). If it was the program\'s default budget, the oldest remaining link becomes the default, else the program has none. Needs the program `version`.',
  input: z.object({ id, budget_id: id, version: z.coerce.number().int().positive() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p } = await programFor(user, i.id, 'program', c, true);
      checkVersion(p, i.version, 'program');
      const { b } = await budgetFor(user, i.budget_id, 'budget_read', c, true);
      if (!(await c.query('SELECT 1 FROM sponsorship_program_budgets WHERE program_id=$1 AND budget_id=$2 AND unlinked_at IS NULL', [p.id, b.id])).rowCount) throw notFound('Budget link');
      const used = (await c.query(
        `SELECT 1 FROM sponsorship_award_reservations WHERE program_id=$1 AND budget_id=$2 AND status='held'
         UNION ALL SELECT 1 FROM sponsorships WHERE program_id=$1 AND budget_id=$2
         UNION ALL SELECT 1 FROM sponsorship_awards WHERE program_id=$1 AND budget_id=$2 AND status IN ('waitlisted','pending_approval','approved','issued','accepted') LIMIT 1`, [p.id, b.id])).rowCount;
      if (used) throw conflict('This program has money reserved, committed or waiting on that budget, so it cannot be unlinked');
      await c.query('UPDATE sponsorship_program_budgets SET unlinked_at=now() WHERE program_id=$1 AND budget_id=$2 AND unlinked_at IS NULL', [p.id, b.id]);
      const next = p.budget_id === b.id ? (await c.query('SELECT budget_id FROM sponsorship_program_budgets WHERE program_id=$1 AND unlinked_at IS NULL ORDER BY created_at, id LIMIT 1', [p.id])).rows[0]?.budget_id ?? null : p.budget_id;
      const row = (await c.query('UPDATE sponsorship_programs SET budget_id=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [p.id, next])).rows[0];
      await budgetEvent(c, b.id, 'program_unlinked', user.id, { program_id: p.id });
      await audit(c, user.id, 'unlink_budget', 'sponsorship_programs', p.id);
      return row;
    });
  },
});

cap({
  name: 'list_program_budgets', method: 'GET', path: '/sponsorship-programs/:id/budgets', tag: 'Sponsors',
  summary: 'The budgets a program draws on: code, name, kind, currency, what is still available on each and what THIS program has reserved, committed and paid on it (in the budget\'s currency), and which is the default for new awards. Brand staff with budget access; others get an empty list (budgets are internal to the brand and never shown to applicants).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { p, sp } = await programFor(user, i.id, 'read', pool);
    if (!isAdmin(user)) {
      const access = await sponsorAccess(user, sp);
      if (!access || access.departmentId || !actionsFor(access.role).includes('budget_read')) return [];
    }
    const rows = await many('SELECT b.* FROM sponsorship_program_budgets l JOIN sponsorship_budgets b ON b.id=l.budget_id WHERE l.program_id=$1 AND l.unlinked_at IS NULL ORDER BY l.created_at, l.id', [p.id]);
    const out = [];
    for (const b of rows) {
      const node = (await traceOf(pool, b)).programs.find((x) => x.program.id === p.id)?.totals ?? { reserved_cents: 0, committed_cents: 0, paid_cents: 0 };
      const u = await usageOf(pool, b);
      out.push({ id: b.id, code: b.code, name: b.name, kind: b.kind, fiscal_year: b.fiscal_year, currency: b.currency, authorized_cents: Number(b.authorized_cents), available_cents: u.available_cents, is_default: p.budget_id === b.id, reserved_cents: node.reserved_cents, committed_cents: node.committed_cents, paid_cents: node.paid_cents });
    }
    return out;
  },
});

cap({
  name: 'decide_budget_approval', method: 'POST', path: '/sponsorships/:id/budget-approval', tag: 'Sponsors',
  summary: 'Brand manager/approver/finance: approve or reject an offer that is above its budget\'s approval threshold. The recipient is told about the offer only when it is approved; a rejected offer is withdrawn and the recipient never sees it. The person who proposed the offer cannot approve it unless the brand has nobody else who may.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d?.budget_id) throw notFound('Sponsorship');
      const sp = await mustFind('sponsors', d.sponsor_id, '*', c);
      if (!isAdmin(user)) {
        const access = await sponsorAccess(user, sp, c);
        if (!access) throw notFound('Sponsorship');
        assertSponsorCan(access, 'budget_approve', { departmentId: d.department_id, what: 'approve budget spending' });
        if (access.archived && !access.owner) throw conflict('This brand\'s organisation is archived and read-only');
      }
      if (d.budget_approval !== 'pending') throw conflict(d.budget_approval ? `This offer is already ${d.budget_approval}` : 'This offer does not need budget approval');
      if (i.decision === 'reject' && !i.note) throw badRequest('Give a reason for rejecting');
      if (d.proposed_by === user.id) {
        const others = (await sponsorRecipients(c, sp, 'budget_approve', d.department_id)).filter((u) => u !== user.id);
        if (others.length) throw forbidden('Another approver must decide an offer you proposed');
      }
      const approved = i.decision === 'approve';
      const row = (await c.query(
        `UPDATE sponsorships SET budget_approval=$2, budget_approval_by=$3, budget_approval_at=now(), budget_approval_note=$4, status=CASE WHEN $2='rejected' THEN 'withdrawn' ELSE status END WHERE id=$1 RETURNING *`,
        [d.id, approved ? 'approved' : 'rejected', user.id, i.note ?? null])).rows[0];
      await logHistory(c, d.id, d.terms_version, user.id, approved ? 'budget_approved' : 'budget_rejected', i.note);
      await budgetEvent(c, d.budget_id, approved ? 'offer_approved' : 'offer_rejected', user.id, { sponsorship_id: d.id });
      if (approved) {
        const owner = d.target_type === 'event' ? (await c.query('SELECT organizer_id AS u FROM events WHERE id=$1', [d.target_id])).rows[0]?.u : d.target_type === 'team' ? (await c.query('SELECT owner_id AS u FROM teams WHERE id=$1', [d.target_id])).rows[0]?.u : d.target_id;
        await notify(c, owner, { kind: 'sponsorship_offer', title: 'You have a sponsorship offer', body: `${sp.name} sent an offer. Open it to review and answer.`, data: { sponsorship_id: d.id } });
      } else await notifySponsor(c, sp, 'read', { kind: 'sponsorship_budget', title: 'An offer was not approved', body: 'An offer above a budget threshold was rejected and withdrawn.', data: { sponsorship_id: d.id } }, d.department_id, user.id);
      await audit(c, user.id, approved ? 'budget_approve' : 'budget_reject', 'sponsorships', d.id);
      return { id: row.id, status: row.status, budget_approval: row.budget_approval };
    });
  },
});

cap({
  name: 'export_sponsorship_budget', method: 'GET', path: '/sponsorship-budgets/:id/export', tag: 'Sponsors',
  summary: 'Brand manager/finance/auditor: CSV of everything that draws on a budget (kind, reference, status, own currency amount, amount in the budget currency, rate, paid, refunded) plus the balance lines. No contact or personal data. The export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { b } = await budgetFor(user, i.id, 'export', pool);
    const use = await usageOf(pool, b);
    const rows = [];
    for (let off = 0; ; off += 100) { const part = await commitments(pool, b, { limit: 100, offset: off }); rows.push(...part); if (part.length < 100) break; }
    await audit(null, user.id, 'export', 'sponsorship_budgets', b.id);
    const lines = [
      ...rows.map((r) => ({ section: 'commitment', kind: r.kind, ref: r.ref ?? '', status: r.status, currency: r.currency, amount_cents: r.amount_cents, fx_rate: r.fx_rate ?? '', budget_currency: b.currency, budget_amount_cents: r.budget_amount_cents, paid_cents: r.paid_cents, refunded_cents: r.refunded_cents })),
      ...Object.entries({ authorized: use.authorized_cents, allocated: use.allocated_cents, planned: use.planned_cents, reserved: use.reserved_cents, committed: use.committed_cents, paid: use.paid_cents, refunded: use.refunded_cents, available: use.available_cents })
        .map(([k, v]) => ({ section: 'balance', kind: k, ref: '', status: '', currency: b.currency, amount_cents: v, fx_rate: '', budget_currency: b.currency, budget_amount_cents: v, paid_cents: '', refunded_cents: '' })),
    ];
    return { filename: `budget-${b.id}.csv`, rows: lines.length, csv: toCsv(['section', 'kind', 'ref', 'status', 'currency', 'amount_cents', 'fx_rate', 'budget_currency', 'budget_amount_cents', 'paid_cents', 'refunded_cents'], lines) };
  },
});

cap({
  name: 'add_budget_reference', method: 'POST', path: '/sponsorship-budgets/:id/references', tag: 'Sponsors', status: 201,
  summary: 'Brand manager/finance: attach a reference to a budget -- where the authority for it is recorded (an approval memo, board minutes, a forecast, a purchase order, a contract or a policy). Give an https link, a reference number, or both. Files themselves go in the budget\'s documents folder (PUT /documents, subject_type `budget`). Up to 50 per budget; removing one only hides it.',
  input: z.object({ id, kind: z.enum(REF_KINDS), title: z.string().trim().min(2).max(160), url: httpsUrl.optional(), ref_no: z.string().trim().min(1).max(80).optional() })
    .refine((r) => r.url || r.ref_no, 'A reference needs a link or a reference number'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { b } = await budgetFor(user, i.id, 'budget', c, true);
      if ((await c.query('SELECT count(*)::int AS n FROM sponsorship_budget_references WHERE budget_id=$1 AND removed_at IS NULL', [b.id])).rows[0].n >= MAX_REFS) throw conflict(`A budget can have up to ${MAX_REFS} references`);
      const row = await insertReference(c, b.id, i, user.id);
      await budgetEvent(c, b.id, 'reference_added', user.id, { reference_id: row.id, kind: i.kind, title: i.title });
      await audit(c, user.id, 'add_reference', 'sponsorship_budgets', b.id);
      return row;
    });
  },
});

cap({
  name: 'remove_budget_reference', method: 'DELETE', path: '/sponsorship-budgets/:id/references/:ref_id', tag: 'Sponsors',
  summary: 'Brand manager/finance: hide a reference from a budget. It stays on record (and in the budget history); it just stops appearing.',
  input: z.object({ id, ref_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { b } = await budgetFor(user, i.id, 'budget', c, true);
      const r = (await c.query('UPDATE sponsorship_budget_references SET removed_at=now() WHERE id=$1 AND budget_id=$2 AND removed_at IS NULL RETURNING id, title', [i.ref_id, b.id])).rows[0];
      if (!r) throw notFound('Reference');
      await budgetEvent(c, b.id, 'reference_removed', user.id, { reference_id: r.id, title: r.title });
      await audit(c, user.id, 'remove_reference', 'sponsorship_budgets', b.id);
      return { id: r.id, removed: true };
    });
  },
});

cap({
  name: 'get_budget_guidance', method: 'GET', path: '/budget-guidance', tag: 'Sponsors',
  summary: 'Brand finance/manager/approver/auditor: what to learn from before authorizing a budget. For a kind (and department or fiscal year), the brand\'s earlier comparable budgets -- including archived ones -- with what was authorized against what was actually used (committed + reserved, children included, in each budget\'s own currency) and the unspent or overspent difference; a suggested figure (the latest comparable\'s actual use, in the currency asked for) with the budget it comes from; whether an active budget for the same scope already exists; and the brand\'s total authorized for that fiscal year per currency. Currencies are never added together or converted.',
  input: z.object({ sponsor_id: id, kind: z.enum(KINDS), fiscal_year: z.coerce.number().int().min(2000).max(2200).optional(), department_id: id.optional(), event_id: id.optional(), currency: currency.optional() }),
  async handler({ user }, i) {
    const { access } = await brandView(user, i.sponsor_id, 'budget_read', pool);
    const rows = (await pool.query(`SELECT b.* FROM sponsorship_budgets b WHERE b.sponsor_id=$1 ORDER BY b.fiscal_year DESC NULLS LAST, b.created_at DESC, b.id`, [i.sponsor_id])).rows;
    const withUse = [];
    for (const b of rows) withUse.push(shape(b, await usageOf(pool, b)));
    const tree = rollup(withUse).filter((b) => !access.departmentId || b.department_id === access.departmentId);
    const dept = i.kind === 'department' ? i.department_id ?? null : null;
    const sameScope = (b) => b.kind === i.kind && (dept == null || b.department_id === dept);
    const earlier = (b) => i.kind !== 'annual' && i.kind !== 'department' ? true : i.fiscal_year == null || b.fiscal_year == null || b.fiscal_year < i.fiscal_year;
    const comparable = tree.filter((b) => sameScope(b) && earlier(b)).slice(0, 6).map((b) => {
      const used = b.rollup.committed_cents + b.rollup.reserved_cents;
      return {
        id: b.id, name: b.name, kind: b.kind, fiscal_year: b.fiscal_year, status: b.status, currency: b.currency, authorized_cents: b.authorized_cents, used_cents: used,
        committed_cents: b.rollup.committed_cents, reserved_cents: b.rollup.reserved_cents, paid_cents: b.rollup.paid_cents, unspent_cents: b.authorized_cents - used,
        utilisation_pct: b.authorized_cents > 0 ? Math.round((used / b.authorized_cents) * 1000) / 10 : null, over_committed: used > b.authorized_cents,
      };
    });
    const want = i.currency ?? comparable[0]?.currency ?? null;
    const basis = comparable.find((b) => b.currency === want && b.used_cents > 0) ?? null;
    const rated = comparable.filter((b) => b.currency === want && b.utilisation_pct != null);
    const existing = tree.find((b) => b.status === 'active' && sameScope(b) && (i.kind === 'annual' ? b.fiscal_year === (i.fiscal_year ?? null) : i.kind === 'event' ? i.event_id != null && b.event_id === i.event_id : i.kind === 'department' ? b.fiscal_year === (i.fiscal_year ?? null) : false));
    const year = {};
    for (const b of tree) if (b.kind === 'annual' && b.status === 'active' && b.fiscal_year === (i.fiscal_year ?? null)) year[b.currency] = (year[b.currency] ?? 0) + b.authorized_cents;
    return {
      comparable,
      suggestion: basis ? { basis_budget_id: basis.id, basis_name: basis.name, currency: basis.currency, suggested_cents: basis.used_cents, last_authorized_cents: basis.authorized_cents } : null,
      average_utilisation_pct: rated.length ? Math.round((rated.reduce((a, b) => a + b.utilisation_pct, 0) / rated.length) * 10) / 10 : null,
      existing: existing ? { id: existing.id, name: existing.name } : null,
      year_authorized: Object.entries(year).map(([cur, cents]) => ({ currency: cur, authorized_cents: cents })),
    };
  },
});

cap({
  name: 'get_budget_trace', method: 'GET', path: '/sponsorship-budgets/:id/trace', tag: 'Sponsors',
  summary: 'Follow a budget\'s money end to end: each program that draws on it, its awards (reserved), agreements (committed, or planned when still only an offer), every scheduled due and every payment (reported, confirmed, reversed) -- amounts in the budget currency per program and agreement, in their own currency per due and payment. `reconciles` is true when the traced reserved / committed / paid / refunded add up exactly to the budget\'s balances. Agreements that draw on the budget without a program are listed as `direct`; child budgets are listed with their own codes. Brand staff with budget access; anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { b } = await budgetFor(user, i.id, 'budget_read', pool);
    return { budget: { id: b.id, code: b.code, name: b.name, kind: b.kind, currency: b.currency, fiscal_year: b.fiscal_year }, ...(await traceOf(pool, b)) };
  },
});

cap({
  name: 'get_budget_coverage', method: 'GET', path: '/budget-coverage', tag: 'Sponsors',
  summary: 'Brand-wide finance/manager/approver/auditor: spending that is not under any budget -- programs (not archived) that draw on no budget and the awards reserved, agreements committed and payments confirmed on them (per currency), plus direct agreements with neither a program nor a budget -- and how many programs are mapped. Use it to link every program to a budget (link_program_budget). Department-scoped staff cannot see it.',
  input: z.object({ sponsor_id: id }),
  async handler({ user }, i) {
    const { access } = await brandView(user, i.sponsor_id, 'budget_read', pool);
    if (access.departmentId) throw forbidden('Budget coverage is a brand-wide view');
    const progs = await many("SELECT id, name, status, currency, budget_cents::bigint AS budget_cents, row_version FROM sponsorship_programs WHERE sponsor_id=$1 AND status <> 'archived' AND NOT EXISTS (SELECT 1 FROM sponsorship_program_budgets l WHERE l.program_id=sponsorship_programs.id AND l.unlinked_at IS NULL) ORDER BY lower(name), id", [i.sponsor_id]);
    const mapped = (await pool.query('SELECT count(*)::int AS n FROM sponsorship_programs p WHERE p.sponsor_id=$1 AND EXISTS (SELECT 1 FROM sponsorship_program_budgets l WHERE l.program_id=p.id AND l.unlinked_at IS NULL)', [i.sponsor_id])).rows[0].n;
    const held = await many("SELECT program_id, currency, sum(amount_cents)::bigint AS cents FROM sponsorship_award_reservations WHERE program_id = ANY($1) AND status='held' GROUP BY 1,2", [progs.map((p) => p.id)]);
    const dues = await many(
      `SELECT ss.program_id, o.currency, coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS committed,
              coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed')),0)::bigint AS paid
         FROM sponsorships ss JOIN sponsorship_obligations o ON o.sponsorship_id=ss.id AND o.kind='money'
        WHERE ss.program_id = ANY($1) AND ss.budget_id IS NULL GROUP BY 1,2`, [progs.map((p) => p.id)]);
    const spend = (pid) => {
      const m = {};
      const slot = (cur) => (m[cur] ??= { currency: cur, reserved_cents: 0, committed_cents: 0, paid_cents: 0 });
      for (const h of held.filter((x) => x.program_id === pid)) slot(h.currency).reserved_cents += Number(h.cents);
      for (const d of dues.filter((x) => x.program_id === pid)) { slot(d.currency).committed_cents += Number(d.committed); slot(d.currency).paid_cents += Number(d.paid); }
      return Object.values(m);
    };
    const direct = await many(
      `SELECT ss.id, ss.agreement_ref, ss.status, o.currency, coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS committed,
              CASE ss.target_type WHEN 'athlete' THEN (SELECT handle FROM users WHERE id=ss.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=ss.target_id) ELSE (SELECT name FROM events WHERE id=ss.target_id) END AS who
         FROM sponsorships ss LEFT JOIN sponsorship_obligations o ON o.sponsorship_id=ss.id AND o.kind='money'
        WHERE ss.sponsor_id=$1 AND ss.program_id IS NULL AND ss.budget_id IS NULL AND ss.status IN ('proposed','active','paused') GROUP BY ss.id, o.currency ORDER BY ss.created_at DESC, ss.id LIMIT 50`, [i.sponsor_id]);
    return {
      mapped_programs: mapped,
      unmapped_programs: progs.map((p) => ({ ...p, budget_cents: Number(p.budget_cents), spend: spend(p.id) })),
      unmapped_agreements: direct.map((d) => ({ id: d.id, ref: d.agreement_ref, status: d.status, who: d.who, currency: d.currency, committed_cents: Number(d.committed) })),
    };
  },
});
