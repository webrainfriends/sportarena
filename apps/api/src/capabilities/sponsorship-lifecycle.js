// One lifecycle view of a sponsorship (#589): the rights an agreement holds, what it contracts, what has been delivered with evidence, the hospitality it unlocks and where
// it stands for renewal. These are READS composed over the canonical records (#519 inventory/deliverables/exposure, finance `list_sponsorship_obligations`, #480 ticket
// allocations, #482 media-licence deliverables, #299 renewals); nothing is stored here, money is never recomputed, and no ROI figure is produced. Every figure carries its provenance:
// recorded (counted from platform records), measured (by Sportarena), imported (named provider) or estimated (the customer's own assumption model).
import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { tx, many } from '../db.js';
import { notFound } from '../errors.js';
import { dealContext } from '../sponsor-agreements.js';
import { RUNNING, INVENTORY_KINDS, deliverableState, exposureFor, today } from '../sponsor-roi.js';
import { localToday, renewalStage } from '../sponsor-renewals.js';

const TAG = 'Sponsors';
const date = z.string().date();
const through = (name, user, input) => capabilities.find((x) => x.name === name).handler({ user }, input);
const sideOf = (ctx) => (ctx.role === 'sponsor' ? 'sponsor' : ctx.role === 'recipient' ? 'recipient' : null);
const SHOWN = [...RUNNING, 'proposed'];

async function openCtx(c, user, sponsorshipId) {
  const ctx = await dealContext(c, sponsorshipId, user).catch((e) => { throw e.status === 403 ? notFound('Sponsorship lifecycle') : e; });   // a stranger learns nothing, not even that it exists
  if (ctx.role === 'sponsor') ctx.need('roi', 'read the sponsorship lifecycle');
  if (!SHOWN.includes(ctx.d.status) || !ctx.d.accepted_version) throw notFound('Sponsorship lifecycle');   // an offer nobody accepted holds no rights and owes nothing yet
  return ctx;
}

cap({
  name: 'get_sponsorship_lifecycle', method: 'GET', path: '/sponsorships/:id/lifecycle', tag: TAG,
  summary: 'The whole lifecycle of one accepted agreement, for the sponsor and the rights-holder alike: the rights it holds (units, categories, territory, platforms, period), the obligation matrix (every contracted due — money, goods, endorsement — against what is fulfilled), activation (deliverables with owner, due date, state and evidence, plus open tasks), hospitality/ticket allocations and how many were issued, measured/imported exposure with its provenance, and renewal stage with the expiry alert. Contracted vs delivered are counts of recorded facts; nothing is estimated unless a valuation model exists, and then it is labelled estimated. Sponsor-side members need the roi permission; anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await openCtx(c, user, i.id);
      const { d } = ctx;
      const side = sideOf(ctx);
      const left = d.ends ? Math.round((Date.parse(`${d.ends}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 864e5) : null;
      const fin = await through('list_sponsorship_obligations', user, { sponsorship_id: d.id, limit: 100, offset: 0 });
      const rights = (await c.query(`SELECT b.id, b.category, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on, b.status, b.countries, b.platforms, u.id AS unit_id, u.kind, u.name AS unit_name, u.territory_mode, u.exclusivity_scope,
          (SELECT count(*)::int FROM sponsorship_deliverables x WHERE x.booking_id=b.id AND x.status <> 'cancelled') AS deliverables
        FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.sponsorship_id=$1 ORDER BY b.starts_on, b.id`, [d.id])).rows.map((r) => ({ ...r, kind_label: INVENTORY_KINDS[r.kind] }));
      const dels = (await c.query(`SELECT x.id, x.kind, x.title, x.owed_by, x.due_on::text AS due_on, x.status, x.booking_id, x.evidence_required, u.display_name AS owner_name, rv.display_name AS reviewed_by_name, x.reviewed_at,
          (SELECT count(*)::int FROM sponsorship_deliverable_evidence e WHERE e.deliverable_id=x.id) AS evidence_count
        FROM sponsorship_deliverables x LEFT JOIN users u ON u.id=x.owner_user_id LEFT JOIN users rv ON rv.id=x.reviewed_by WHERE x.sponsorship_id=$1 ORDER BY x.due_on, x.id`, [d.id])).rows
        .map((x) => ({ ...x, state: deliverableState(x) }));
      const mr = (await c.query("SELECT id, kind, title, status, due_at FROM mr_deliverables WHERE sponsorship_id=$1 ORDER BY due_at NULLS LAST, id", [d.id])).rows;
      const tasks = (await c.query(`SELECT t.id, t.title, t.kind, t.due_on::text AS due_on, t.status, t.side, t.visibility, u.display_name AS assignee_name FROM sponsorship_tasks t LEFT JOIN users u ON u.id=t.assignee_id
        WHERE t.sponsorship_id=$1 AND t.status='open' AND (t.visibility='shared' OR t.side=$2) ORDER BY t.due_on NULLS LAST, t.id LIMIT 100`, [d.id, side ?? ''])).rows;
      const hospitality = (await c.query(`SELECT a.id, a.kind, a.label, a.quota, a.status, a.booking_id, p.name AS product,
          (SELECT count(*)::int FROM tickets t WHERE t.allocation_id=a.id AND t.supersedes_id IS NULL AND t.status <> 'void') AS issued
        FROM ticket_allocations a JOIN ticket_products p ON p.id=a.product_id WHERE a.sponsorship_id=$1 ORDER BY a.created_at`, [d.id])).rows;
      const exposure = await exposureFor(c, d, { from: d.starts ?? '1970-01-01', to: today() });
      const renewal = (await c.query(`SELECT (SELECT n.status FROM sponsorships n WHERE n.renews_id=s.id AND n.status NOT IN ('declined','withdrawn') LIMIT 1) AS successor_status,
          (SELECT n.id FROM sponsorships n WHERE n.renews_id=s.id AND n.status NOT IN ('declined','withdrawn') LIMIT 1) AS successor_id,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('side', a.side, 'intent', a.intent)), '[]') FROM sponsorship_renewal_assessments a WHERE a.sponsorship_id=s.id) AS assessments,
          (s.ends_on - ${localToday('s')})::int AS days_left FROM sponsorships s WHERE s.id=$1`, [d.id])).rows[0];
      const obl = fin.obligations ?? [];
      const dueN = (k) => obl.filter((o) => o.kind === k && o.status !== 'cancelled');
      const matrix = [
        ...['money', 'goods', 'endorsement'].map((k) => ({ area: `dues_${k}`, contracted: dueN(k).length, delivered: dueN(k).filter((o) => o.status === 'fulfilled').length, provenance: 'recorded' })),
        { area: 'rights', contracted: rights.filter((r) => r.status === 'confirmed').length, delivered: rights.filter((r) => r.status === 'confirmed' && r.starts_on <= today()).length, provenance: 'recorded' },
        { area: 'deliverables', contracted: dels.filter((x) => !['cancelled', 'excepted'].includes(x.status)).length, delivered: dels.filter((x) => x.status === 'accepted').length, provenance: 'recorded' },
        { area: 'hospitality', contracted: hospitality.reduce((n, a) => n + a.quota, 0), delivered: hospitality.reduce((n, a) => n + a.issued, 0), provenance: 'recorded' },
      ];
      return {
        agreement: { id: d.id, ref: d.agreement_ref ?? null, status: d.status, sponsor: ctx.sp.name, starts_on: d.starts ?? null, ends_on: d.ends ?? null, days_left: left, viewer_side: side ?? 'admin' },
        rights, obligations: { source: 'list_sponsorship_obligations (the finance truth; not recomputed here)', totals: fin.totals, rows: obl },
        activation: { deliverables: dels, media_licence_deliverables: mr, open_tasks: tasks }, hospitality,
        exposure: { provenance_note: 'measured = counted by Sportarena; imported = supplied by the named provider; estimated = the customer\'s own assumption model. ROI is never invented.', metrics: exposure.metrics, missing: exposure.missing, not_measured: exposure.not_measured },
        renewal: { ...renewalStage({ status: d.status, days_left: renewal.days_left, assessments: renewal.assessments, successor_status: renewal.successor_status }), successor_id: renewal.successor_id, assessments: renewal.assessments, days_left: renewal.days_left },
        matrix,
      };
    });
  },
});

cap({
  name: 'get_sponsorship_activation_calendar', method: 'GET', path: '/sponsorship-activation-calendar', tag: TAG,
  summary: 'A date-ordered activation calendar over the agreements you are part of (or one `sponsorship_id`): deliverables due (with owner and state), open tasks you may see, inventory bookings starting and ending, and contractual dues. Pure read over the canonical records, limited to what you may see; to add work use the task and deliverable capabilities.',
  input: z.object({ sponsorship_id: id.optional(), from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      i.from ??= today();
      const to = i.to ?? new Date(Date.parse(`${i.from}T00:00:00Z`) + 90 * 864e5).toISOString().slice(0, 10);
      const ids = i.sponsorship_id ? [i.sponsorship_id] : (await through('list_sponsorships', user, { limit: 100, offset: 0 })).filter((s) => s.accepted_version != null).map((s) => s.id);
      const items = [];
      for (const sid of ids) {
        let ctx;
        try { ctx = await openCtx(c, user, sid); } catch (e) { if (i.sponsorship_id) throw e; continue; }
        const d = ctx.d, side = sideOf(ctx), ref = d.agreement_ref ?? null, base = { sponsorship_id: d.id, agreement_ref: ref, sponsor: ctx.sp.name };
        for (const x of (await c.query(`SELECT x.id, x.title, x.kind, x.due_on::text AS due_on, x.status, u.display_name AS owner_name FROM sponsorship_deliverables x LEFT JOIN users u ON u.id=x.owner_user_id
          WHERE x.sponsorship_id=$1 AND x.due_on BETWEEN $2::date AND $3::date AND x.status <> 'cancelled'`, [d.id, i.from, to])).rows) items.push({ ...base, type: 'deliverable', on: x.due_on, id: x.id, title: x.title, state: deliverableState(x), owner: x.owner_name });
        for (const x of (await c.query(`SELECT t.id, t.title, t.due_on::text AS due_on, u.display_name AS owner_name FROM sponsorship_tasks t LEFT JOIN users u ON u.id=t.assignee_id
          WHERE t.sponsorship_id=$1 AND t.status='open' AND t.due_on BETWEEN $2::date AND $3::date AND (t.visibility='shared' OR t.side=$4)`, [d.id, i.from, to, side ?? ''])).rows) items.push({ ...base, type: 'task', on: x.due_on, id: x.id, title: x.title, state: 'open', owner: x.owner_name });
        for (const x of (await c.query(`SELECT b.id, b.starts_on::text AS starts_on, b.ends_on::text AS ends_on, u.name FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.sponsorship_id=$1 AND b.status='confirmed'`, [d.id])).rows) {
          if (x.starts_on >= i.from && x.starts_on <= to) items.push({ ...base, type: 'rights_start', on: x.starts_on, id: x.id, title: x.name, state: 'scheduled' });
          if (x.ends_on >= i.from && x.ends_on <= to) items.push({ ...base, type: 'rights_end', on: x.ends_on, id: x.id, title: x.name, state: 'scheduled' });
        }
        for (const x of (await c.query(`SELECT o.id, o.kind, o.due_on::text AS due_on, o.status FROM sponsorship_obligations o WHERE o.sponsorship_id=$1 AND o.status='scheduled' AND o.due_on BETWEEN $2::date AND $3::date`, [d.id, i.from, to])).rows) items.push({ ...base, type: 'due', on: x.due_on, id: x.id, title: x.kind, state: x.due_on < today() ? 'overdue' : 'upcoming' });
      }
      items.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.type < b.type ? -1 : 1));
      return { from: i.from, to, items: items.slice(0, 500), truncated: items.length > 500 };
    });
  },
});

cap({
  name: 'get_sponsor_relationship_history', method: 'GET', path: '/sponsor-relationship-history', tag: TAG,
  summary: 'The history between one sponsor and one rights-holder (event, team or athlete): every agreement between them that you may see, how each ended or renewed, and the recorded actions across them in time order (offers, sign-offs, inventory booked/released, renewal steps, disputes). Limited to agreements you are part of; 404 when you can see none.',
  input: z.object({ sponsor_id: id, target_type: z.enum(['event', 'team', 'athlete', 'organisation', 'group']), target_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const all = (await many('SELECT id FROM sponsorships WHERE sponsor_id=$1 AND target_type=$2 AND target_id=$3 ORDER BY created_at', [i.sponsor_id, i.target_type, i.target_id]));
      const agreements = [];
      for (const { id: sid } of all) {
        try {
          const ctx = await dealContext(c, sid, user);
          agreements.push({ id: sid, ref: ctx.d.agreement_ref ?? null, status: ctx.d.status, starts_on: ctx.d.starts ?? null, ends_on: ctx.d.ends ?? null, renews_id: ctx.d.renews_id ?? null });
        } catch { /* not a party to this one: it is not shown, and its existence is not revealed */ }
      }
      if (!agreements.length) throw notFound('Relationship history');
      const events = (await c.query(`SELECT h.id, h.sponsorship_id, h.action, h.reason, h.created_at FROM sponsorship_history h WHERE h.sponsorship_id = ANY($1::uuid[]) ORDER BY h.id DESC LIMIT 200`, [agreements.map((a) => a.id)])).rows;
      return { sponsor_id: i.sponsor_id, target_type: i.target_type, target_id: i.target_id, agreements, events };
    });
  },
});
