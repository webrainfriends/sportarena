// Beneficiaries, representatives, payees and allocations of an organisation / group sponsorship (#291).
// Hangs off the canonical `sponsorships` row; the payee's money still moves through the existing obligations and payments (no second ledger).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { notifySponsor } from '../sponsor-access.js';
import { ORG_TARGETS, PAYEE_ROLES, resolveAllocations, writeAllocations } from '../sponsor-beneficiaries.js';

const like = (q) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

cap({
  name: 'search_sponsorship_beneficiaries', method: 'GET', path: '/sponsorship-beneficiaries', tag: 'Sponsors', auth: ['sponsor'],
  summary: 'Sponsor: find organisations (and their groups) that opted in to sponsorship, by name. Only a name, kind and city are shown; rosters, members and counts never are. Organisations are private until an owner/admin turns on open_to_sponsors.',
  input: z.object({ q: z.string().max(80).optional(), type: z.enum(['organisation', 'group']).default('organisation'), ...page }),
  handler: async (_ctx, i) => (i.type === 'organisation'
    ? many(`SELECT o.id, o.name, o.kind, o.city, 'organisation' AS type, NULL::text AS organisation_name FROM organisations o
             WHERE o.status='active' AND o.open_to_sponsors AND ($1::text IS NULL OR o.name ILIKE $1) ORDER BY lower(o.name), o.id LIMIT $2 OFFSET $3`, [i.q ? like(i.q) : null, i.limit, i.offset])
    : many(`SELECT g.id, g.name, o.kind, o.city, 'group' AS type, o.name AS organisation_name FROM org_cohorts g JOIN organisations o ON o.id=g.organisation_id
             WHERE g.status='active' AND o.status='active' AND o.open_to_sponsors AND ($1::text IS NULL OR g.name ILIKE $1 OR o.name ILIKE $1) ORDER BY lower(g.name), g.id LIMIT $2 OFFSET $3`, [i.q ? like(i.q) : null, i.limit, i.offset])),
});

/** The allocation view. Candidates (groups, teams, payees) are only for the representative who can change them. */
async function view(c, ctx) {
  const { d } = ctx;
  const orgId = ctx.beneficiary.orgId;
  const org = (await c.query('SELECT id, name FROM organisations WHERE id=$1', [orgId])).rows[0];
  const target = d.target_type === 'group' ? (await c.query('SELECT id, name FROM org_cohorts WHERE id=$1', [d.target_id])).rows[0] : org;
  const rows = (await c.query(
    `SELECT id, beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name, terms_version, status, created_at, released_at
       FROM sponsorship_allocations WHERE sponsorship_id=$1 ORDER BY created_at, lower(beneficiary_name), id`, [d.id])).rows;
  const active = rows.filter((r) => r.status === 'active');
  const out = {
    sponsorship_id: d.id, rev: d.allocation_rev, status: d.status,
    beneficiary: { type: d.target_type, id: target.id, name: target.name, organisation: { id: org.id, name: org.name } },
    my_role: ctx.beneficiary.representative ? 'representative' : ctx.beneficiary.payee ? 'payee' : null,
    can_edit: ctx.beneficiary.representative && ['proposed', 'active'].includes(d.status),
    allocations: active, allocated_bp: active.reduce((s, r) => s + r.share_bp, 0), unallocated_bp: 10000 - active.reduce((s, r) => s + r.share_bp, 0),
    history: rows.filter((r) => r.status === 'released'),
  };
  if (ctx.beneficiary.representative) {
    out.candidates = {
      groups: (await c.query("SELECT id, name FROM org_cohorts WHERE organisation_id=$1 AND status='active' ORDER BY lower(name), id", [orgId])).rows.filter((g) => d.target_type === 'organisation' || g.id === d.target_id),
      teams: d.target_type === 'organisation' ? (await c.query('SELECT id, name FROM teams WHERE organisation_id=$1 ORDER BY lower(name), id', [orgId])).rows : [],
      payees: (await c.query("SELECT u.id, u.display_name, m.role FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role = ANY($2) ORDER BY lower(u.display_name), u.id", [orgId, PAYEE_ROLES])).rows,
    };
  }
  return out;
}

const need = (ctx) => {
  if (!ORG_TARGETS.includes(ctx.d.target_type)) throw badRequest('Allocations apply to organisation and group sponsorships');
};

cap({
  name: 'get_sponsorship_allocations', method: 'GET', path: '/sponsorships/:id/allocations', tag: 'Sponsors',
  summary: 'Who a sponsorship is for and who is paid: the beneficiary (organisation or group), each allocation with its share and the payee frozen on it, what is unallocated, and the released history. The sponsor sees names and shares only; the organisation\'s representative also gets the groups, teams and payees they can choose from. No roster, member or enrolment data is ever included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    need(ctx);
    return view(pool, ctx);
  },
});

const ALLOC = z.object({
  beneficiary_type: z.enum(['organisation', 'group', 'team']), beneficiary_id: id,
  share_bp: z.number().int().min(1).max(10000).describe('share of every money line in basis points (2500 = 25%)'),
  payee_user_id: id.describe('a live owner, admin or finance member of the organisation who receives and confirms the money'),
});

cap({
  name: 'set_sponsorship_allocations', method: 'POST', path: '/sponsorships/:id/allocations', tag: 'Sponsors',
  summary: 'Organisation owner/admin (the representative): set the full allocation of this sponsorship across the organisation, its groups and its teams, each with a share and a payee. All-or-nothing in one transaction: shares above 100%, the same beneficiary twice, a payee who is not a live finance-capable member, or a stale `rev` all fail and change nothing. Replaced allocations are released, never edited or deleted, so earlier payees stay on record.',
  input: z.object({ id, rev: z.number().int().positive().describe('the allocation rev you read; a stale one is rejected'), allocations: z.array(ALLOC).max(20), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = (await c.query('SELECT id FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!lock) throw badRequest('Unknown sponsorship');
      const ctx = await dealContext(c, i.id, user);
      need(ctx);
      const { d } = ctx;
      if (!ctx.beneficiary?.representative) throw forbidden('Only an owner or admin of the organisation can set allocations');
      if (!['proposed', 'active'].includes(d.status)) throw conflict(`This sponsorship is ${d.status}; its allocations can no longer change`);
      if (i.rev !== d.allocation_rev) throw conflict('These allocations changed while you were editing; reload and try again', { rev: d.allocation_rev });
      const orgId = ctx.beneficiary.orgId;
      if ((await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [orgId])).rowCount === 0) throw conflict('This organisation is archived');
      const { wanted, total } = await resolveAllocations(c, d, orgId, i.allocations);
      const changed = await writeAllocations(c, d, wanted, user.id);
      if (changed) {
        d.allocation_rev += 1;
        await logHistory(c, d.id, d.terms_version, user.id, 'allocations_set', i.reason ?? `${wanted.length} allocation${wanted.length === 1 ? '' : 's'}, ${total / 100}% allocated`);
        await notifySponsor(c, ctx.sp, 'read', { kind: 'sponsorship_update', title: 'Sponsorship allocations updated', body: `Open the ${ctx.sp.name} agreement to see who it supports.`, data: { sponsorship_id: d.id } }, d.department_id, user.id);
      }
      return view(c, ctx);
    });
  },
});
