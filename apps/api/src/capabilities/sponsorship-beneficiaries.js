// Beneficiaries, representatives, payees and allocations of an organisation / group sponsorship (#291).
// Hangs off the canonical `sponsorships` row; the payee's money still moves through the existing obligations and payments (no second ledger).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { notifySponsor } from '../sponsor-access.js';
import { ORG_TARGETS, PAYEE_ROLES } from '../sponsor-beneficiaries.js';

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
      const seen = new Set(); let total = 0;
      const wanted = [];
      for (const a of i.allocations) {
        const key = `${a.beneficiary_type}:${a.beneficiary_id}`;
        if (seen.has(key)) throw badRequest('The same beneficiary is allocated twice');
        seen.add(key); total += a.share_bp;
        let name;
        if (a.beneficiary_type === 'organisation') {
          if (a.beneficiary_id !== orgId || d.target_type === 'group') throw badRequest('That organisation is not a beneficiary of this sponsorship');
          name = (await c.query('SELECT name FROM organisations WHERE id=$1', [orgId])).rows[0].name;
        } else if (a.beneficiary_type === 'group') {
          const g = (await c.query("SELECT name FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status='active'", [a.beneficiary_id, orgId])).rows[0];
          if (!g || (d.target_type === 'group' && a.beneficiary_id !== d.target_id)) throw badRequest('That group is not a beneficiary of this sponsorship');
          name = g.name;
        } else {
          const t = d.target_type === 'organisation' ? (await c.query('SELECT name FROM teams WHERE id=$1 AND organisation_id=$2', [a.beneficiary_id, orgId])).rows[0] : null;
          if (!t) throw badRequest('That team is not a beneficiary of this sponsorship');
          name = t.name;
        }
        const payee = (await c.query("SELECT u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role = ANY($3)", [orgId, a.payee_user_id, PAYEE_ROLES])).rows[0];
        if (!payee) throw badRequest('The payee must be a live owner, admin or finance member of the organisation');
        wanted.push({ ...a, key, beneficiary_name: name, payee_name: payee.display_name });
      }
      if (total > 10000) throw badRequest(`Allocations total ${total / 100}%; they cannot exceed 100%`);
      const current = (await c.query("SELECT * FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active'", [d.id])).rows;
      let changed = 0;
      for (const r of current) { // release what no longer matches exactly; an unchanged row keeps its original payee snapshot and date
        const w = wanted.find((x) => x.key === `${r.beneficiary_type}:${r.beneficiary_id}`);
        if (w && w.share_bp === r.share_bp && w.payee_user_id === r.payee_user_id) { w.keep = true; continue; }
        await c.query("UPDATE sponsorship_allocations SET status='released', released_by=$2, released_at=now() WHERE id=$1", [r.id, user.id]);
        changed++;
      }
      for (const w of wanted.filter((x) => !x.keep)) {
        await c.query('INSERT INTO sponsorship_allocations(sponsorship_id, beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name, terms_version, set_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [d.id, w.beneficiary_type, w.beneficiary_id, w.beneficiary_name, w.share_bp, w.payee_user_id, w.payee_name, d.terms_version, user.id]);
        changed++;
      }
      if (changed) {
        d.allocation_rev = (await c.query('UPDATE sponsorships SET allocation_rev=allocation_rev+1 WHERE id=$1 RETURNING allocation_rev', [d.id])).rows[0].allocation_rev;
        await logHistory(c, d.id, d.terms_version, user.id, 'allocations_set', i.reason ?? `${wanted.length} allocation${wanted.length === 1 ? '' : 's'}, ${total / 100}% allocated`);
        await notifySponsor(c, ctx.sp, 'read', { kind: 'sponsorship_update', title: 'Sponsorship allocations updated', body: `Open the ${ctx.sp.name} agreement to see who it supports.`, data: { sponsorship_id: d.id } }, d.department_id, user.id);
      }
      return view(c, ctx);
    });
  },
});
