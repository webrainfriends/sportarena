// Tender reporting. One function builds each report object; the dashboard, the CSV/XLSX exports and the PDFs all use it, so they reconcile
// by construction. Amounts are integer minor units kept per currency (currencies are never added together). Every figure states its basis.
import { many, one } from '../db.js';
import { stageOf } from './core.js';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const addTo = (o, k, v) => { o[k] = (o[k] ?? 0) + Number(v); };

/** Tenders the user runs (owner, organisation owner/admin or procurement admin, or team member), with optional filters. */
export async function buyerProjects(user, f = {}) {
  const basis = { created: 'p.created_at', published: 'p.published_at', closing: 'p.closes_at' }[f.date_basis ?? 'published'];
  return many(`SELECT p.* FROM proc_projects p WHERE ($2::uuid IS NULL OR p.organisation_id=$2) AND ($3::uuid IS NULL OR p.event_id=$3) AND ($4::text IS NULL OR lower(p.category)=lower($4)) AND ($5::text IS NULL OR p.currency=$5)
      AND ($6::date IS NULL OR ${basis} >= $6) AND ($7::date IS NULL OR ${basis} < $7::date + 1)
      AND (p.owner_user_id=$1 OR EXISTS (SELECT 1 FROM proc_members m WHERE m.project_id=p.id AND m.user_id=$1 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()))
        OR (p.venue_id IS NOT NULL AND EXISTS (SELECT 1 FROM venues vv WHERE vv.id=p.venue_id AND (vv.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff vs WHERE vs.venue_id=vv.id AND vs.user_id=$1 AND vs.role='manager' AND vs.removed_at IS NULL))))
        OR (p.organisation_id IS NOT NULL AND (EXISTS (SELECT 1 FROM organisation_members om WHERE om.organisation_id=p.organisation_id AND om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin')) OR EXISTS (SELECT 1 FROM proc_mandates pm WHERE pm.organisation_id=p.organisation_id AND pm.user_id=$1 AND pm.role IN ('procurement_admin','auditor') AND pm.revoked_at IS NULL AND (pm.expires_at IS NULL OR pm.expires_at > now())))))
      ORDER BY p.created_at DESC LIMIT 2000`, [user.id, f.organisation_id ?? null, f.event_id ?? null, f.category ?? null, f.currency ?? null, f.from ?? null, f.to ?? null]);
}

export async function buyerReport(user, f = {}) {
  const projects = (await buyerProjects(user, f)).filter((p) => !f.stage || stageOf(p) === f.stage);
  const ids = projects.map((p) => p.id);
  const pipeline = {};
  for (const p of projects) addTo(pipeline, stageOf(p), 1);
  const part = await one(`SELECT (SELECT count(*)::int FROM proc_participants WHERE project_id = ANY($1) AND status <> 'declined') AS interested,
      (SELECT count(*)::int FROM proc_proposals WHERE project_id = ANY($1) AND status='submitted' AND round=1) AS submitted,
      (SELECT count(DISTINCT entity_id)::int FROM proc_award_lines WHERE project_id = ANY($1) AND status='accepted') AS awarded_entities,
      (SELECT count(*)::int FROM proc_proposals WHERE project_id = ANY($1) AND status='submitted' AND round=1 AND eligibility='eligible') AS eligible,
      (SELECT count(*)::int FROM proc_proposals WHERE project_id = ANY($1) AND status='submitted' AND round=1 AND eligibility='ineligible') AS ineligible,
      (SELECT count(*)::int FROM proc_proposals WHERE project_id = ANY($1) AND status='submitted' AND round=1 AND eligibility='pending') AS pending`, [ids]);
  const closed = projects.filter((p) => p.closes_at && new Date(p.closes_at) <= new Date() && p.status !== 'cancelled');
  const subs = ids.length ? await many("SELECT project_id, count(*)::int AS n FROM proc_proposals WHERE project_id = ANY($1) AND status='submitted' AND round=1 GROUP BY project_id", [ids]) : [];
  const nBy = new Map(subs.map((r) => [r.project_id, r.n]));
  const cycle = ids.length ? (await many("SELECT p.published_at, max(l.responded_at) AS done FROM proc_projects p JOIN proc_award_lines l ON l.project_id=p.id AND l.status='accepted' WHERE p.id = ANY($1) AND p.published_at IS NOT NULL GROUP BY p.id", [ids])).map((r) => (new Date(r.done) - new Date(r.published_at)) / 864e5) : [];
  const workload = ids.length ? await many("SELECT u.handle, count(*) FILTER (WHERE s.status='locked')::int AS locked, count(*)::int AS started FROM proc_scores s JOIN users u ON u.id=s.reviewer_id WHERE s.project_id = ANY($1) GROUP BY u.handle ORDER BY u.handle", [ids]) : [];
  // money: committed per currency from orders; baseline = the tender's own published budget; observed savings only where a tender is fully awarded
  const spend = { committed_minor: {}, call_offs_minor: {}, baseline_minor: {}, observed_saving_minor: {}, forecast_saving_minor: {} };
  for (const r of ids.length ? await many("SELECT o.currency, sum(c.amount_minor)::bigint AS s FROM proc_orders o JOIN proc_commitments c ON c.order_id=o.id WHERE o.project_id = ANY($1) AND o.status <> 'cancelled' GROUP BY o.currency", [ids]) : []) addTo(spend.committed_minor, r.currency, r.s);
  for (const r of ids.length ? await many("SELECT o.currency, sum(k.amount_minor)::bigint AS s FROM proc_calloffs k JOIN proc_orders o ON o.id=k.order_id WHERE o.project_id = ANY($1) AND k.status='approved' GROUP BY o.currency", [ids]) : []) addTo(spend.call_offs_minor, r.currency, r.s);
  for (const p of projects.filter((x) => x.status === 'awarded' && x.budget_minor !== null)) {
    const c = (await one("SELECT coalesce(sum(c.amount_minor),0)::bigint AS s FROM proc_orders o JOIN proc_commitments c ON c.order_id=o.id WHERE o.project_id=$1 AND o.status <> 'cancelled'", [p.id])).s;
    addTo(spend.baseline_minor, p.currency, p.budget_minor); addTo(spend.observed_saving_minor, p.currency, Number(p.budget_minor) - Number(c));
  }
  for (const p of projects.filter((x) => x.status === 'award' && x.budget_minor !== null)) {
    const a = await one("SELECT (snapshot->'scenario'->>'cost_minor')::bigint AS c FROM proc_awards WHERE project_id=$1 AND status IN ('approval_pending','approved','notified') ORDER BY created_at DESC LIMIT 1", [p.id]);
    if (a) addTo(spend.forecast_saving_minor, p.currency, Number(p.budget_minor) - Number(a.c));
  }
  const unfilled = [];
  for (const p of projects.filter((x) => ['evaluation', 'award', 'awarded'].includes(x.status))) {
    for (const r of await many("SELECT lo.code, lo.qty::float - coalesce((SELECT sum(l.qty) FROM proc_award_lines l WHERE l.project_id=lo.project_id AND l.lot_code=lo.code AND l.status='accepted'),0)::float AS missing FROM proc_lots lo WHERE lo.project_id=$1 AND lo.archived_at IS NULL", [p.id])) if (r.missing > 1e-9) unfilled.push({ ref: p.ref, lot: r.code, missing_qty: r.missing });
  }
  const warnings = [];
  for (const p of projects.filter((x) => ['published', 'evaluation', 'award', 'awarded'].includes(x.status) && x.service_start && x.service_end)) {
    for (const s of (p.sites ?? []).filter((x) => x.venue_id)) {
      const clash = await many("SELECT q.ref FROM proc_projects q WHERE q.id <> $1 AND q.status IN ('published','evaluation','award','awarded') AND q.sites @> $2::jsonb AND q.service_start <= $4 AND q.service_end >= $3", [p.id, JSON.stringify([{ venue_id: s.venue_id }]), p.service_start, p.service_end]);
      for (const c of clash) warnings.push({ ref: p.ref, other: c.ref, venue: s.label, message: `Service dates overlap with ${c.ref} at ${s.label ?? 'the same venue'}` });
    }
  }
  return {
    basis: { date_basis: f.date_basis ?? 'published', note: 'Tenders are filtered on the chosen date basis. Amounts stay in their own currency and are never added across currencies.' },
    filters: f, tenders: projects.length, pipeline,
    upcoming_deadlines: projects.filter((p) => p.status === 'published' && p.closes_at && new Date(p.closes_at) > new Date() && new Date(p.closes_at) < new Date(Date.now() + 14 * 864e5)).map((p) => ({ ref: p.ref, title: p.title, closes_at: p.closes_at })).sort((a, b) => new Date(a.closes_at) - new Date(b.closes_at)),
    participation: { ...part, submitted_per_interested: part.interested ? Math.round((1000 * part.submitted) / part.interested) / 10 : null, awarded_per_submitted: part.submitted ? Math.round((1000 * part.awarded_entities) / part.submitted) / 10 : null, denominators: 'interested = every supplier that took part and did not decline; submitted = first-round proposals currently submitted (withdrawn proposals excluded)' },
    qualification: { eligible: part.eligible, ineligible: part.ineligible, pending: part.pending },
    competition: { closed_tenders: closed.length, average_proposals: closed.length ? Math.round((10 * closed.reduce((a, p) => a + (nBy.get(p.id) ?? 0), 0)) / closed.length) / 10 : null },
    cycle_time_days: { median_publish_to_award: median(cycle) === null ? null : Math.round(median(cycle) * 10) / 10, awarded_tenders: cycle.length },
    reviewer_workload: workload, spend: { ...spend, note: 'Committed = order commitments (not delivery or payment). Observed saving = published budget minus committed, for fully awarded tenders only. Forecast saving uses the pending recommended award.' },
    coverage: { unfilled_lots: unfilled }, conflict_warnings: warnings,
  };
}

export async function supplierReport(user, f = {}) {
  const ents = (await many("SELECT entity_id FROM supplier_entity_members WHERE user_id=$1 AND status='active'", [user.id])).map((r) => r.entity_id);
  const use = f.entity_id ? ents.filter((e) => e === f.entity_id) : ents;
  const basis = f.from || f.to ? 'AND pr.updated_at >= coalesce($2::date,\'-infinity\') AND pr.updated_at < coalesce($3::date + 1, \'infinity\')' : '';
  const args = basis ? [use, f.from ?? null, f.to ?? null] : [use];
  const stat = await one(`SELECT count(*) FILTER (WHERE pr.status='draft')::int AS drafts, count(*) FILTER (WHERE pr.status='submitted')::int AS submitted, count(*) FILTER (WHERE pr.status='withdrawn')::int AS withdrawn FROM proc_proposals pr WHERE pr.entity_id = ANY($1) AND pr.round=1 ${basis}`, args);
  const won = await one("SELECT count(DISTINCT l.proposal_id)::int AS n FROM proc_award_lines l WHERE l.entity_id = ANY($1) AND l.status='accepted'", [use]);
  const decided = await one("SELECT count(DISTINCT pr.id)::int AS n FROM proc_proposals pr JOIN proc_projects p ON p.id=pr.project_id WHERE pr.entity_id = ANY($1) AND pr.status='submitted' AND pr.round=1 AND p.status IN ('awarded','closed')", [use]);
  const invitations = await one("SELECT count(*) FILTER (WHERE status='invited')::int AS open_invitations, count(*)::int AS tenders_joined FROM proc_participants WHERE entity_id = ANY($1)", [use]);
  const clar = await many("SELECT p.ref, p.title, coalesce(p.clarification_deadline, p.closes_at) AS clarification_by, p.closes_at FROM proc_participants pa JOIN proc_projects p ON p.id=pa.project_id WHERE pa.entity_id = ANY($1) AND p.status='published' AND p.closes_at > now() AND pa.status <> 'declined' ORDER BY p.closes_at LIMIT 20", [use]);
  const pipe = { by_currency: {}, orders: {} };
  for (const r of await many("SELECT o.currency, o.status, sum(o.amount_minor)::bigint AS s, count(*)::int AS n FROM proc_orders o WHERE o.entity_id = ANY($1) AND o.status <> 'cancelled' GROUP BY o.currency, o.status", [use])) { (pipe.by_currency[r.currency] ??= {})[r.status] = Number(r.s); addTo(pipe.orders, r.status, r.n); }
  return { basis: { note: 'Success rate = proposals that won at least one lot divided by submitted proposals on tenders that have been decided. Amounts stay per currency.' }, filters: f, proposals: stat, invitations, success: { won: won.n, decided: decided.n, rate_percent: decided.n ? Math.round((1000 * won.n) / decided.n) / 10 : null }, clarification_deadlines: clar, awarded_pipeline: pipe };
}

/** Flat rows for CSV/XLSX: one row per section/metric so the file reconciles with the dashboard object. */
export function flatten(report) {
  const rows = [];
  const walk = (prefix, v) => { if (v === null || v === undefined) rows.push({ metric: prefix, value: '' }); else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? walk(`${prefix}[${i}]`, x) : rows.push({ metric: `${prefix}[${i}]`, value: x }))); else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x); else rows.push({ metric: prefix, value: v }); };
  walk('', report);
  return rows.slice(0, 5000);
}
