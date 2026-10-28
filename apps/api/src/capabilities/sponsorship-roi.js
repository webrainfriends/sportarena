// Sponsorship ROI & portfolio intelligence (#519): metric definitions, provider-reported exposure, the brand's own versioned valuation assumptions, the portfolio
// dashboard, compatible-metric comparison, the factual renewal pack and immutable issued reports. It READS the canonical agreements, dues, placements, followers,
// disputes and deliverables; it never recomputes finance, never invents reach, and a monetary value exists only as a labelled estimate from assumptions the brand wrote.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, many, one, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { dealContext, logHistory } from '../sponsor-agreements.js';
import { sponsorAccess, assertSponsorCan, sponsorStaffSql, SPONSOR_ACTIONS } from '../sponsor-access.js';
import { recipientSql } from '../beneficiary-portfolio.js';
import { exportReport } from '../sponsor-report-export.js';
import { capabilities } from '../registry.js';
import { METRICS, PROVIDER_METRICS, VALUABLE_METRICS, NOT_MEASURED, RUNNING, today, canon, sha, windowOf, exposureFor, agreementFacts, estimateFrom, sharedOutcomes, metricOf } from '../sponsor-roi.js';

const TAG = 'Sponsors';
const date = z.string().date();
const through = (name, user, input) => capabilities.find((x) => x.name === name).handler({ user }, input);
const stale = () => conflict('This changed while you were looking; reload it and try again', { code: 'stale_version' });

// ------------------------------------------------------------------ definitions
cap({
  name: 'list_sponsorship_metric_definitions', method: 'GET', path: '/sponsorship-metric-definitions', tag: TAG,
  summary: 'What every exposure metric means, where it comes from (platform_measured or provider_reported), whether it is a figure for a period or a point in time, how duplicates are avoided, and what Sportarena does NOT measure. The same definitions are embedded in every issued report.',
  async handler() { return { metrics: METRICS, not_measured: NOT_MEASURED, rules: ['A figure is never estimated: a metric with no data is listed as missing, not zero.', 'Platform-measured counts and provider-reported figures are never added together.', 'Money and valuation estimates are separate: a valuation exists only from assumptions the brand configured, is versioned and is always labelled an estimate.'] }; },
});

// ------------------------------------------------------------------ provider-reported exposure
const signalIn = z.object({ metric: z.enum(PROVIDER_METRICS), day: date, value: z.coerce.number().int().min(0).max(1_000_000_000_000), source: z.string().trim().min(2).max(80).describe('who supplied the figure, e.g. the streaming provider'),
  source_ref: z.string().trim().min(2).max(300).describe('where it can be checked: report name, export id or https link'), booking_id: id.optional() });

cap({
  name: 'record_exposure_signal', method: 'POST', path: '/sponsorships/:id/exposure-signals', tag: TAG, status: 201,
  summary: 'The beneficiary records one figure that a provider supplied for one day (stream views, overlay impressions, approved clip views, external page views, attendance, tickets scanned, hospitality guests), naming the provider and where it can be checked. It is shown to the sponsor labelled provider-reported. There is one live value per agreement, metric and day whatever the source (409 if one exists — correct it instead), so two sources are never added together.',
  input: signalIn.extend({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'recipient') throw forbidden('Only the beneficiary records provider figures; a sponsor cannot enter its own exposure');
      if (!RUNNING.includes(ctx.d.status)) throw conflict(`Figures are recorded once the agreement has been accepted (it is ${ctx.d.status})`);
      if (i.day > today()) throw badRequest('day is in the future; record what has already happened');
      if ((ctx.d.starts && i.day < ctx.d.starts) || (ctx.d.ends && i.day > ctx.d.ends)) throw badRequest('That day is outside the agreement term');
      if (i.booking_id && !(await c.query('SELECT 1 FROM sponsor_inventory_bookings WHERE id=$1 AND sponsorship_id=$2', [i.booking_id, ctx.d.id])).rowCount) throw badRequest('That booking is not part of this agreement');
      try {
        return (await c.query(`INSERT INTO sponsor_exposure_signals(sponsorship_id, booking_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING id, metric, day::text AS day, value, source, source_ref, created_at`, [ctx.d.id, i.booking_id ?? null, i.metric, i.day, i.value, i.source, i.source_ref, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('A figure for that metric and day already exists; correct it instead of adding another', { code: 'duplicate_signal' }); throw e; }
    });
  },
});

cap({
  name: 'correct_exposure_signal', method: 'POST', path: '/sponsor-exposure-signals/:id/correction', tag: TAG, status: 201,
  summary: 'Correct a provider figure: the old value is superseded (kept with its reason) and the new value replaces it in every view, report and estimate from now on. Issued reports keep the figure they were issued with.',
  input: z.object({ id, value: z.coerce.number().int().min(0).max(1_000_000_000_000), source: z.string().trim().min(2).max(80).optional(), source_ref: z.string().trim().min(2).max(300).optional(), reason: z.string().trim().min(3).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM sponsor_exposure_signals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Figure');
      const ctx = await dealContext(c, s.sponsorship_id, user, { lock: true });
      if (ctx.role !== 'recipient') throw forbidden('Only the beneficiary corrects provider figures');
      if (s.superseded_at) throw conflict('That figure was already corrected; correct the current one');
      await c.query('UPDATE sponsor_exposure_signals SET superseded_at=now(), superseded_reason=$2 WHERE id=$1', [s.id, i.reason]);
      return (await c.query(`INSERT INTO sponsor_exposure_signals(sponsorship_id, booking_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id, metric, day::text AS day, value, source, source_ref, created_at`, [s.sponsorship_id, s.booking_id, s.metric, s.day, i.value, i.source ?? s.source, i.source_ref ?? s.source_ref, user.id])).rows[0];
    });
  },
});

async function readable(c, user, sponsorshipId, action = 'roi') {
  const ctx = await dealContext(c, sponsorshipId, user);
  if (ctx.role === 'sponsor') ctx.need(action, 'read ROI and exposure for this agreement');
  if (!RUNNING.includes(ctx.d.status)) throw notFound('Exposure');
  if (ctx.d.budget_approval && ['pending', 'rejected'].includes(ctx.d.budget_approval) && ctx.role === 'recipient') throw notFound('Exposure');
  return ctx;
}

cap({
  name: 'get_sponsorship_exposure', method: 'GET', path: '/sponsorships/:id/exposure', tag: TAG,
  summary: 'Measured exposure of one agreement over a period (default: its whole term so far): platform-measured placement impressions and clicks, event/team followers (distinct accounts, a point-in-time count), and provider-reported figures, each with its definition, basis, sources and days with data. Metrics a booked inventory unit should produce but that have no data are listed as `missing`; `not_measured` names what Sportarena never estimates. Both sides (sponsor side needs roi).',
  input: z.object({ id, from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await readable(c, user, i.id);
      const w = windowOf(ctx.d, i.from ?? ctx.d.starts ?? '1970-01-01', i.to ?? today());
      const exposure = await exposureFor(c, ctx.d, { from: w.from, to: w.to });
      const signals = (await c.query(`SELECT id, metric, day::text AS day, value, source, source_ref, created_at, superseded_at, superseded_reason FROM sponsor_exposure_signals WHERE sponsorship_id=$1 AND day BETWEEN $2::date AND $3::date ORDER BY day DESC, metric LIMIT 200`, [ctx.d.id, w.from ?? '0001-01-01', w.to ?? '9999-12-31'])).rows;
      return { agreement_id: ctx.d.id, role: ctx.role, ...exposure, signals };
    });
  },
});

// ------------------------------------------------------------------ valuation assumptions (the brand's own, versioned, never a fact)
const assumptions = z.partialRecord(z.enum(VALUABLE_METRICS), z.object({ per: z.union([z.literal(1), z.literal(1000)]).describe('1 = value per unit, 1000 = value per thousand'), value_cents: z.coerce.number().int().min(0).max(1_000_000_000) })).refine((a) => Object.keys(a).length >= 1, 'Give a rate for at least one measured metric');
const versionIn = { currency: z.string().regex(/^[A-Z]{3}$/), assumptions, basis_note: z.string().trim().min(10).max(1000).describe('why these rates: your own rationale, shown beside every estimate') };
const SV = 'v.id, v.model_id, v.version, v.currency, v.assumptions, v.basis_note, v.created_at, m.name, m.sponsor_id';

/**
 * The caller's live authority over a brand. Brand-wide by default (valuation assumptions belong to the whole brand, so a department-scoped member is refused).
 * `scoped: true` checks the ROLE only: the agreement-level department rules (dealContext / the department-filtered SQL) then decide what the person sees.
 */
async function brand(c, user, sponsorId, action, { scoped = false } = {}) {
  const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [sponsorId])).rows[0];
  if (!sp) throw notFound('Brand');
  const access = await sponsorAccess(user, sp, c);
  if (!access) throw notFound('Brand');
  if (scoped) {
    if (!SPONSOR_ACTIONS[action].includes(access.role)) throw forbidden(`Your role (${access.repRole ?? access.role}) cannot read ROI data for this brand`);
  } else assertSponsorCan(access, action, { what: action === 'valuation' ? 'set valuation assumptions' : 'read ROI data' });
  return { sp, access };
}

cap({
  name: 'create_valuation_model', method: 'POST', path: '/sponsors/:id/valuation-models', tag: TAG, status: 201,
  summary: 'A brand manager or finance member writes the brand\'s OWN valuation assumptions: a rate (per unit or per thousand) for each measured metric it chooses to value, a currency and the rationale. Version 1 is saved; later changes are new versions (earlier ones never change, so old estimates and issued reports stay reproducible). Estimates made from it are always labelled assumption-based.',
  input: z.object({ id, name: z.string().trim().min(2).max(80), ...versionIn }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await brand(c, user, i.id, 'valuation');
      let m;
      try { m = (await c.query('INSERT INTO sponsor_valuation_models(sponsor_id, name, created_by) VALUES ($1,$2,$3) RETURNING id, name, created_at', [i.id, i.name, user.id])).rows[0]; }
      catch (e) { if (e.code === '23505') throw conflict('A model with that name exists; add a version to it'); throw e; }
      const v = (await c.query('INSERT INTO sponsor_valuation_versions(model_id, version, currency, assumptions, basis_note, created_by) VALUES ($1,1,$2,$3,$4,$5) RETURNING id, version, currency, assumptions, basis_note, created_at', [m.id, i.currency, JSON.stringify(i.assumptions), i.basis_note, user.id])).rows[0];
      return { ...m, versions: [v] };
    });
  },
});

cap({
  name: 'add_valuation_version', method: 'POST', path: '/sponsor-valuation-models/:id/versions', tag: TAG, status: 201,
  summary: 'Save new assumptions as the next version of a valuation model. `expected_version` must be the current latest (409 otherwise). Earlier versions are immutable.',
  input: z.object({ id, expected_version: z.coerce.number().int().min(1), ...versionIn }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM sponsor_valuation_models WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Valuation model');
      await brand(c, user, m.sponsor_id, 'valuation');
      if (m.archived_at) throw conflict('This model is archived');
      const latest = (await c.query('SELECT max(version) AS v FROM sponsor_valuation_versions WHERE model_id=$1', [m.id])).rows[0].v;
      if (latest !== i.expected_version) throw stale();
      return (await c.query('INSERT INTO sponsor_valuation_versions(model_id, version, currency, assumptions, basis_note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, currency, assumptions, basis_note, created_at', [m.id, latest + 1, i.currency, JSON.stringify(i.assumptions), i.basis_note, user.id])).rows[0];
    });
  },
});

cap({
  name: 'list_valuation_models', method: 'GET', path: '/sponsors/:id/valuation-models', tag: TAG,
  summary: 'The brand\'s valuation models with every version (roi permission). Valuation assumptions belong to the brand: a beneficiary never sees them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx((c) => brand(c, user, i.id, 'roi'));
    const ms = await many('SELECT id, name, created_at, archived_at FROM sponsor_valuation_models WHERE sponsor_id=$1 ORDER BY name', [i.id]);
    for (const m of ms) m.versions = await many('SELECT id, version, currency, assumptions, basis_note, created_at FROM sponsor_valuation_versions WHERE model_id=$1 ORDER BY version DESC', [m.id]);
    return { models: ms, metrics: METRICS.filter((m) => VALUABLE_METRICS.includes(m.key)).map(({ key, label, unit, basis }) => ({ key, label, unit, basis })) };
  },
});

async function versionFor(c, sponsorId, versionId) {
  const v = (await c.query(`SELECT ${SV} FROM sponsor_valuation_versions v JOIN sponsor_valuation_models m ON m.id=v.model_id WHERE v.id=$1`, [versionId])).rows[0];
  if (!v || v.sponsor_id !== sponsorId) throw notFound('Valuation version');
  return v;
}

cap({
  name: 'get_sponsorship_valuation', method: 'GET', path: '/sponsorships/:id/valuation', tag: TAG,
  summary: 'An ASSUMPTION-BASED ESTIMATE of an agreement\'s value over a period, from a version of the brand\'s own valuation model applied to the MEASURED figures only: each line shows the measured value, its basis and the rate used. Metrics the model does not value are listed as excluded. A return-on-spend ratio (estimated value ÷ confirmed spend, same currency) appears only when there is confirmed spend. Sponsor side only (roi); never a measured fact.',
  input: z.object({ id, version_id: id, from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Valuation assumptions belong to the sponsor');
      ctx.need('roi', 'read a valuation estimate');
      const v = await versionFor(c, ctx.d.sponsor_id, i.version_id);
      const f = await agreementFacts(c, user, ctx, { from: i.from, to: i.to, view: 'sponsor', version: v });
      return { agreement_id: ctx.d.id, window: f.window, valuation: f.valuation, exposure_basis: 'measured figures only; see get_sponsorship_exposure' };
    });
  },
});

// ------------------------------------------------------------------ portfolio dashboard
const DEL_STATE = `CASE WHEN x.status IN ('accepted','excepted','cancelled') THEN x.status WHEN x.status='submitted' THEN 'awaiting_review' WHEN x.due_on < current_date THEN 'overdue' WHEN x.status='rework' THEN 'rework' ELSE 'upcoming' END`;

const MR_DEL_STATE = `CASE x.status WHEN 'verified' THEN 'accepted' WHEN 'delivered' THEN 'awaiting_review' WHEN 'missed' THEN 'overdue' WHEN 'planned' THEN CASE WHEN x.due_at < now() THEN 'overdue' ELSE 'upcoming' END END`; // media-licence deliverables (media rights)

cap({
  name: 'get_sponsorship_portfolio_intelligence', method: 'GET', path: '/sponsorship-intelligence', tag: TAG,
  summary: 'The sponsor\'s portfolio dashboard for one brand (roi permission; department-scoped members see their department): every accepted agreement with beneficiary, term, committed / confirmed / outstanding (read from the dues and payments, the finance truth, per currency), deliverable health, measured exposure with definitions, upcoming obligations, open disputes and renewal state; plus totals for finance and deliverables across all matches. Exposure totals cover only the rows returned and never add follower counts (the same people can follow several sponsored subjects). Youth athletes are masked.',
  input: z.object({ sponsor_id: id, from: date.optional(), to: date.optional(), status: z.enum(RUNNING).optional(), target_type: z.enum(['event', 'team', 'athlete', 'organisation', 'group']).optional(), ...page, limit: z.coerce.number().int().min(1).max(50).default(20) }),
  async handler({ user }, i) {
    const params = [user.id, i.sponsor_id, i.status ?? null, i.target_type ?? null];
    const where = `${sponsorStaffSql(1, 'roi')} AND ss.sponsor_id=$2 AND ss.accepted_version IS NOT NULL AND ss.status = ANY(ARRAY[${RUNNING.map((s) => `'${s}'`).join(',')}]) AND ($3::text IS NULL OR ss.status=$3) AND ($4::text IS NULL OR ss.target_type=$4)
      AND (ss.budget_approval IS NULL OR ss.budget_approval NOT IN ('pending','rejected'))`;
    const base = `FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${where}`;
    await brand(pool, user, i.sponsor_id, 'roi', { scoped: true }); // 404 when you do not run this brand, 403 when your role cannot read ROI; department scope is applied by the query below
    const total = (await one(`SELECT count(*)::int AS n ${base}`, params)).n;
    const ids = (await many(`SELECT ss.id ${base} ORDER BY ss.ends_on NULLS LAST, ss.id LIMIT $5 OFFSET $6`, [...params, i.limit, i.offset])).map((r) => r.id);
    const rows = [];
    for (const sid of ids) rows.push(await agreementFacts(pool, user, await dealContext(pool, sid, user), { from: i.from, to: i.to, view: 'sponsor' }));
    const fin = await through('list_sponsorship_obligations', user, { sponsor_id: i.sponsor_id, ...(i.target_type ? { target_type: i.target_type } : {}), limit: 1, offset: 0 });
    const finance = fin.totals.map((t) => ({ currency: t.currency, committed_cents: Number(t.committed_cents), confirmed_cents: Number(t.confirmed_cents), reported_unverified_cents: Number(t.reported_unverified_cents), outstanding_cents: Number(t.outstanding_cents), overdue_cents: Number(t.overdue_cents) }));
    const del = Object.fromEntries((await many(`SELECT s, count(*)::int AS n FROM (
        SELECT ${DEL_STATE} AS s FROM sponsorship_deliverables x JOIN sponsorships ss ON ss.id=x.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${where}
        UNION ALL
        SELECT ${MR_DEL_STATE} AS s FROM mr_deliverables x JOIN sponsorships ss ON ss.id=x.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${where}) t GROUP BY s`, params)).map((r) => [r.s, r.n]));
    const sums = {};
    for (const r of rows) for (const m of r.exposure.metrics) if (m.additive) (sums[m.key] ??= { key: m.key, label: m.label, unit: m.unit, basis: m.basis, value: 0 }).value += m.value;
    const upcoming = rows.flatMap((r) => r.finance.upcoming.map((u) => ({ ...u, sponsorship_id: r.agreement.id, beneficiary: r.agreement.beneficiary }))).sort((a, b) => (a.due_on < b.due_on ? -1 : 1)).slice(0, 10);
    return { total, limit: i.limit, offset: i.offset, agreements: rows, totals: { finance, finance_source: 'list_sponsorship_obligations totals (the finance truth; follows the target-type filter)', deliverables: del, exposure_this_page: Object.values(sums), exposure_note: 'Summed over the rows returned; follower counts are never added across agreements.' }, upcoming, not_measured: NOT_MEASURED };
  },
});

// ------------------------------------------------------------------ comparison on compatible metrics only
cap({
  name: 'compare_sponsorship_campaigns', method: 'POST', path: '/sponsorship-intelligence/compare', tag: TAG,
  summary: 'Compare 2–10 of your agreements over ONE explicit period (both dates required). A metric is compared only when it is measured, period-based and available for EVERY selected agreement; the rest are listed as not comparable with the agreements that lack them. Spend is compared only within one currency. Values are given per day the agreement was active in the window (partial windows are flagged). The result is in the order you gave: there is deliberately no ranking and no athlete score from exposure.',
  input: z.object({ sponsorship_ids: z.array(id).min(2).max(10), from: date, to: date }).refine((x) => x.to >= x.from, 'to is before from'),
  async handler({ user }, i) {
    if (new Set(i.sponsorship_ids).size !== i.sponsorship_ids.length) throw badRequest('List each agreement once');
    const facts = [];
    for (const sid of i.sponsorship_ids) {
      const ctx = await dealContext(pool, sid, user);
      if (ctx.role !== 'sponsor') throw forbidden('You can compare only your own brand\'s agreements');
      ctx.need('roi', 'compare agreements');
      if (!RUNNING.includes(ctx.d.status)) throw conflict('Only accepted agreements can be compared');
      facts.push(await agreementFacts(pool, user, ctx, { from: i.from, to: i.to, view: 'sponsor' }));
    }
    const keys = [...new Set(facts.flatMap((f) => f.exposure.metrics.map((m) => m.key)))];
    const comparable = [], notComparable = [];
    for (const k of keys) {
      const def = metricOf(k);
      const have = facts.map((f) => f.exposure.metrics.find((m) => m.key === k));
      const lacking = facts.filter((_, n) => !have[n]).map((f) => f.agreement.id);
      if (!def.period_bound) { notComparable.push({ key: k, reason: 'A point-in-time count, not a figure for the period', agreements_lacking: [] }); continue; }
      if (lacking.length) { notComparable.push({ key: k, reason: 'Not measured for every selected agreement', agreements_lacking: lacking }); continue; }
      if (new Set(have.map((m) => m.basis)).size > 1) { notComparable.push({ key: k, reason: 'Mixed bases', agreements_lacking: [] }); continue; }
      comparable.push({ key: k, label: def.label, unit: def.unit, basis: def.basis, definition: def.definition,
        values: facts.map((f, n) => ({ sponsorship_id: f.agreement.id, value: have[n].value, active_days: f.window.days, per_active_day: f.window.days ? Number((have[n].value / f.window.days).toFixed(2)) : null, days_with_data: have[n].days_with_data })) });
    }
    const days = new Set(facts.map((f) => f.window.days));
    const cur = new Set(facts.flatMap((f) => f.finance.totals.map((t) => t.currency)));
    return {
      period: { from: i.from, to: i.to }, ranking: 'none — results are listed in the order you chose and exposure is never turned into a score',
      agreements: facts.map((f) => ({ sponsorship_id: f.agreement.id, beneficiary: f.agreement.beneficiary, beneficiary_type: f.agreement.beneficiary_type, status: f.agreement.status, window: f.window, partial_window: f.window.days !== daysOf(i.from, i.to), deliverables: f.deliverables, finance: f.finance.totals })),
      windows_equal: days.size === 1, comparable_metrics: comparable, not_comparable: notComparable,
      spend: cur.size === 1 ? { currency: [...cur][0], comparable: true, values: facts.map((f) => ({ sponsorship_id: f.agreement.id, confirmed_cents: f.finance.totals[0]?.confirmed_cents ?? 0 })) } : { comparable: false, reason: cur.size ? 'Agreements are in different currencies, which are never combined' : 'No money terms' },
      not_measured: NOT_MEASURED,
    };
  },
});
const daysOf = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;

// ------------------------------------------------------------------ renewal pack
const sentence = (f, out) => {
  const a = f.agreement, d = f.deliverables, s = [];
  s.push(`${a.sponsor} and ${a.beneficiary}: agreement ${a.ref ?? a.id.slice(0, 8)} is ${a.status.replace('_', ' ')}, ${a.starts_on ?? '?'} to ${a.ends_on ?? 'open-ended'}${a.days_left != null ? ` (${a.days_left >= 0 ? `${a.days_left} days left` : `ended ${-a.days_left} days ago`})` : ''}.`);
  for (const t of f.finance.totals) s.push(`Money (${t.currency}): ${t.confirmed_cents} of ${t.committed_cents} committed has been confirmed received; ${t.outstanding_cents} is outstanding${t.overdue_cents ? `, of which ${t.overdue_cents} is overdue` : ''} (minor units).`);
  s.push(d.total ? `Deliverables: ${d.accepted} accepted, ${d.missed} missed, ${d.excepted} excepted by agreement, ${d.awaiting_review} awaiting review, ${d.upcoming} upcoming of ${d.total}.` : 'Deliverables: none were set up for this agreement.');
  for (const m of f.exposure.metrics) s.push(`${m.label}: ${m.value} ${m.unit} (${m.basis === 'platform_measured' ? 'measured by Sportarena' : `reported by ${m.sources.join(', ')}`}${m.period_bound ? '' : ', point in time'}).`);
  for (const m of f.exposure.missing) s.push(`No figures for ${metricOf(m.metric).label} on ${m.inventory}: ${m.reason}.`);
  if (f.disputes.open) s.push(`${f.disputes.open} dispute(s) are still open.`);
  if (out) s.push(out.status === 'shared' ? `The beneficiary shares results with the sponsor: ${out.metrics} metric(s), ${out.objectives} objective(s).` : 'The beneficiary has not shared results with the sponsor, so none are included.');
  if (f.valuation) s.push(`Estimate (assumption-based, model "${f.valuation.model.name}" v${f.valuation.model.version}): ${f.valuation.estimated_value_cents} ${f.valuation.currency} minor units. This is not a measured figure.`);
  s.push(`Not measured by Sportarena: ${NOT_MEASURED.slice(0, 3).join('; ')}.`);
  return s;
};

cap({
  name: 'get_sponsorship_renewal_pack', method: 'GET', path: '/sponsorships/:id/renewal-pack', tag: TAG,
  summary: 'A FACTUAL renewal pack for one agreement over its whole term (both sides; the sponsor side needs roi): terms and dates, money confirmed vs committed, deliverables completed / missed / excepted, measured exposure with its definitions and gaps, open disputes and overdue dues, and — only if the beneficiary shares them — outcomes. `facts` are plain sentences generated from those records; any drafting (human or AI) must stay within them and cannot add ROI. An optional valuation version adds a labelled estimate for the sponsor. `workspace` points at the existing renewal capabilities; the pack proposes nothing by itself.',
  input: z.object({ id, valuation_version_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await readable(c, user, i.id);
      const version = i.valuation_version_id ? (ctx.role === 'sponsor' ? await versionFor(c, ctx.d.sponsor_id, i.valuation_version_id) : (() => { throw forbidden('Valuation assumptions belong to the sponsor'); })()) : null;
      const f = await agreementFacts(c, user, ctx, { view: ctx.role === 'sponsor' ? 'sponsor' : 'recipient', version });
      const outcomes = ctx.role === 'sponsor' ? await sharedOutcomes(user, ctx.d) : { status: 'own', note: 'Your own results stay in your performance workspace.' };
      const open = (await c.query("SELECT count(*) FILTER (WHERE status IN ('planned','rework','submitted') AND due_on < current_date)::int AS overdue, count(*) FILTER (WHERE status='submitted')::int AS awaiting FROM sponsorship_deliverables WHERE sponsorship_id=$1", [ctx.d.id])).rows[0];
      const overdueDues = f.finance.totals.reduce((s, t) => s + (t.overdue_cents ?? 0), 0);
      const pack = { ...f, outcomes,
        unresolved: { open_disputes: f.disputes.open, overdue_deliverables: open.overdue, deliverables_awaiting_review: open.awaiting, overdue_dues_cents: overdueDues },
        workspace: { assess: { method: 'POST', path: `/sponsorships/${ctx.d.id}/renewal-assessment` }, propose: { method: 'POST', path: `/sponsorships/${ctx.d.id}/renewal` }, successor: f.renewal.successor,
          note: 'Renewal is never automatic: the other side accepts the exact terms version of a new, linked agreement.' } };
      pack.facts = sentence(f, ctx.role === 'sponsor' ? outcomes : null);
      pack.role = ctx.role;
      return pack;
    });
  },
});

// ------------------------------------------------------------------ immutable reports
const COLUMNS = [
  { key: 'recipient', label: 'Beneficiary', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'period', label: 'Period', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'committed_cents', label: 'Committed', type: 'money' }, { key: 'confirmed_cents', label: 'Confirmed', type: 'money' }, { key: 'outstanding_cents', label: 'Outstanding', type: 'money' },
  { key: 'deliverables_accepted', label: 'Accepted', type: 'int' }, { key: 'deliverables_missed', label: 'Missed', type: 'int' },
  { key: 'placement_impressions', label: 'Impressions', type: 'int' }, { key: 'placement_clicks', label: 'Clicks', type: 'int' }, { key: 'provider_reported', label: 'Provider-reported', type: 'text' },
  { key: 'estimated_value_cents', label: 'Estimate (assumption-based)', type: 'money' },
];
/** One table row per currency of the agreement (currencies are never combined); the non-money figures are shown once, on the first row. */
const rowsOf = (f) => {
  const m = (k) => f.exposure.metrics.find((x) => x.key === k)?.value ?? null;
  const shared = { recipient: f.agreement.beneficiary, status: f.agreement.status, period: `${f.window.from} to ${f.window.to}` };
  const figures = { deliverables_accepted: f.deliverables.accepted, deliverables_missed: f.deliverables.missed, placement_impressions: m('placement_impressions'), placement_clicks: m('placement_clicks'),
    provider_reported: f.exposure.metrics.filter((x) => x.basis === 'provider_reported').map((x) => `${x.key} ${x.value} (${x.sources.join('/')})`).join('; ') };
  const blank = { deliverables_accepted: null, deliverables_missed: null, placement_impressions: null, placement_clicks: null, provider_reported: '' };
  const cur = f.finance.totals.length ? f.finance.totals : [{ currency: f.agreement.currency ?? null, committed_cents: null, confirmed_cents: null, outstanding_cents: null }];
  const rows = cur.map((t, i) => ({ ...shared, currency: t.currency ?? null, committed_cents: t.committed_cents, confirmed_cents: t.confirmed_cents, outstanding_cents: t.outstanding_cents, ...(i === 0 ? figures : blank),
    estimated_value_cents: f.valuation && f.valuation.currency === t.currency ? f.valuation.estimated_value_cents : null }));
  // the estimate is in the valuation model's own currency: if no money row has that currency it gets its own row, never a mislabelled cell
  if (f.valuation && !rows.some((r) => r.currency === f.valuation.currency)) rows.push({ ...shared, currency: f.valuation.currency, committed_cents: null, confirmed_cents: null, outstanding_cents: null, ...blank, estimated_value_cents: f.valuation.estimated_value_cents });
  return rows;
};

cap({
  name: 'issue_sponsorship_roi_report', method: 'POST', path: '/sponsorship-roi-reports', tag: TAG, status: 201,
  summary: 'Issue an IMMUTABLE ROI & exposure report from a snapshot of the canonical records: agreements, finance (from the dues), deliverables with their evidence links, measured exposure with its definitions, gaps and what is not measured, and — for a sponsor report only, if a valuation version is chosen — a labelled estimate with its assumptions. `view: sponsor` covers up to 50 of one brand\'s agreements (roi permission); `view: recipient` covers one agreement you are the beneficiary of and never includes the sponsor\'s valuation or other agreements. `end_of_agreement` needs an agreement whose term is over. Once issued it cannot be changed or deleted; it carries a SHA-256 of its content.',
  input: z.object({ view: z.enum(['sponsor', 'recipient']).default('sponsor'), kind: z.enum(['period', 'end_of_agreement']).default('period'), sponsorship_ids: z.array(id).min(1).max(50), from: date, to: date, valuation_version_id: id.optional() })
    .refine((x) => x.to >= x.from, 'to is before from').refine((x) => x.view === 'sponsor' || x.sponsorship_ids.length === 1, 'A recipient report covers one agreement'),
  async handler({ user }, i) {
    if (i.to > today()) throw badRequest('to is in the future; a report covers what has happened');
    return tx(async (c) => {
      if (new Set(i.sponsorship_ids).size !== i.sponsorship_ids.length) throw badRequest('List each agreement once');
      let version = null, sponsorId = null;
      const facts = [];
      for (const sid of i.sponsorship_ids) {
        const ctx = await dealContext(c, sid, user);
        if (i.view === 'sponsor') { if (ctx.role !== 'sponsor') throw forbidden('Sponsor reports cover your own brand\'s agreements'); ctx.need('roi', 'issue ROI reports'); }
        else if (ctx.role !== 'recipient') throw forbidden('A recipient report is issued by the beneficiary');
        if (!RUNNING.includes(ctx.d.status) || ctx.d.accepted_version == null) throw conflict('Only accepted agreements are reported on');
        if (sponsorId && sponsorId !== ctx.d.sponsor_id) throw badRequest('A sponsor report covers one brand');
        sponsorId = ctx.d.sponsor_id;
        if (i.kind === 'end_of_agreement' && !(ctx.d.ends && ctx.d.ends < today()) && !['ended', 'completed', 'term_expired'].includes(ctx.d.status)) throw conflict('The term of this agreement is not over yet');
        if (i.valuation_version_id && !version) {
          if (i.view !== 'sponsor') throw forbidden('A recipient report carries no valuation');
          version = await versionFor(c, ctx.d.sponsor_id, i.valuation_version_id);
        }
        const f = await agreementFacts(c, user, ctx, { from: i.from, to: i.to, view: i.view, version });
        f.deliverable_items = (await c.query(`SELECT d.id, d.kind, d.title, d.owed_by, d.due_on::text AS due_on, d.status, d.reviewed_at,
            (SELECT coalesce(json_agg(json_build_object('evidence_id', e.id, 'label', e.label, 'url', e.url, 'sha256', e.sha256, 'file', e.file_enc IS NOT NULL)), '[]') FROM sponsorship_deliverable_evidence e WHERE e.deliverable_id=d.id) AS evidence
          FROM sponsorship_deliverables d WHERE d.sponsorship_id=$1 AND d.due_on BETWEEN $2::date AND $3::date ORDER BY d.due_on, d.id`, [ctx.d.id, i.from, i.to])).rows;
        if (i.view === 'sponsor') f.outcomes = await sharedOutcomes(user, ctx.d);
        facts.push(f);
      }
      const used = new Set(facts.flatMap((f) => f.exposure.metrics.map((m) => m.key)));
      const generated = new Date().toISOString();
      const rows = facts.flatMap(rowsOf);
      const snapshot = {
        schema: 1, view: i.view, kind: i.kind, generated_at: generated, period: { from: i.from, to: i.to }, agreements: facts,
        table: { columns: COLUMNS, rows, totals: [] },
        definitions: METRICS.filter((m) => used.has(m.key)), not_measured: NOT_MEASURED,
        valuation_note: version ? 'The estimate column comes from the brand\'s own assumptions (versioned) and is not a measured fact.' : 'No valuation was applied: no monetary media value or ROI is shown.',
        sources: [{ label: 'Dues and confirmed payments', status: 'ok', detail: 'read from list_sponsorship_obligations at the time of issue' }, { label: 'Deliverables', status: 'ok', detail: 'accepted only by a named reviewer, with evidence links' },
          { label: 'Exposure', status: facts.some((f) => f.exposure.missing.length) ? 'stale' : 'ok', detail: facts.some((f) => f.exposure.missing.length) ? 'Some expected metrics have no figures yet (see each agreement)' : 'Platform-measured and provider-reported figures are labelled and never merged' }],
      };
      const frozen = JSON.parse(JSON.stringify(snapshot)); // what is stored is what is hashed
      const hash = sha(frozen);
      const row = (await c.query(`INSERT INTO sponsor_roi_reports(sponsor_id, view, kind, sponsorship_ids, period_from, period_to, valuation_version_id, snapshot, content_sha256, issued_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, view, kind, period_from::text AS period_from, period_to::text AS period_to, content_sha256, issued_at`, [sponsorId, i.view, i.kind, i.sponsorship_ids, i.from, i.to, version?.id ?? null, JSON.stringify(frozen), hash, user.id])).rows[0];
      for (const sid of i.sponsorship_ids) await logHistory(c, sid, (await c.query('SELECT terms_version FROM sponsorships WHERE id=$1', [sid])).rows[0].terms_version, user.id, 'roi_report_issued', row.id);
      await audit(c, user.id, 'sponsorship.roi_report.issue', 'sponsor_roi_reports', row.id);
      return row;
    });
  },
});

/** A report is readable under the caller's LIVE authority: sponsor staff with roi on the brand, or the agreement's current beneficiary. Otherwise 404. */
async function reportFor(c, user, rid) {
  const r = (await c.query('SELECT * FROM sponsor_roi_reports WHERE id=$1', [rid])).rows[0];
  if (!r) throw notFound('Report');
  try {
    if (r.view === 'sponsor') {
      const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [r.sponsor_id])).rows[0];
      const access = await sponsorAccess(user, sp, c);
      if (!access || !SPONSOR_ACTIONS.roi.includes(access.role)) throw forbidden();
      if (access.departmentId) { const own = (await c.query('SELECT count(*)::int AS n FROM sponsorships WHERE id = ANY($1) AND department_id IS NOT DISTINCT FROM $2', [r.sponsorship_ids, access.departmentId])).rows[0].n; if (own !== r.sponsorship_ids.length) throw forbidden(); }
    } else {
      const ctx = await dealContext(c, r.sponsorship_ids[0], user);
      if (ctx.role !== 'recipient') throw forbidden();
    }
  } catch { throw notFound('Report'); }
  return r;
}
const verified = (r) => sha(r.snapshot) === r.content_sha256;

/** Every agreement a report covers must be inside the caller's (department) scope, exactly as when the report is opened. */
const ALL_MINE = `NOT EXISTS (SELECT 1 FROM unnest(r.sponsorship_ids) AS u(sid) JOIN sponsorships ss2 ON ss2.id=u.sid WHERE NOT (${sponsorStaffSql(1, 'roi').replace(/\bss\./g, 'ss2.')}))`;

cap({
  name: 'list_sponsorship_roi_reports', method: 'GET', path: '/sponsorship-roi-reports', tag: TAG,
  summary: 'Issued ROI reports you may read now: as the brand (roi permission) or as the beneficiary of the agreement. Access is checked live, so losing a role or the agreement removes the report from the list.',
  input: z.object({ view: z.enum(['sponsor', 'recipient']).default('sponsor'), sponsor_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const params = [user.id, i.sponsor_id ?? null, i.limit, i.offset];
    const rows = i.view === 'sponsor'
      ? await many(`SELECT r.id, r.view, r.kind, r.sponsorship_ids, r.period_from::text AS period_from, r.period_to::text AS period_to, r.content_sha256, r.issued_at, r.valuation_version_id IS NOT NULL AS has_estimate, sp.name AS sponsor_name
          FROM sponsor_roi_reports r JOIN sponsors sp ON sp.id=r.sponsor_id JOIN sponsorships ss ON ss.id=r.sponsorship_ids[1] WHERE r.view='sponsor' AND ${sponsorStaffSql(1, 'roi')} AND ${ALL_MINE} AND ($2::uuid IS NULL OR r.sponsor_id=$2) ORDER BY r.issued_at DESC, r.id LIMIT $3 OFFSET $4`, params)
      : await many(`SELECT r.id, r.view, r.kind, r.sponsorship_ids, r.period_from::text AS period_from, r.period_to::text AS period_to, r.content_sha256, r.issued_at, false AS has_estimate, sp.name AS sponsor_name
          FROM sponsor_roi_reports r JOIN sponsors sp ON sp.id=r.sponsor_id JOIN sponsorships ss ON ss.id=r.sponsorship_ids[1] WHERE r.view='recipient' AND ${recipientSql('ss')} AND ($2::uuid IS NULL OR r.sponsor_id=$2) ORDER BY r.issued_at DESC, r.id LIMIT $3 OFFSET $4`, params);
    return rows;
  },
});

cap({
  name: 'get_sponsorship_roi_report', method: 'GET', path: '/sponsorship-roi-reports/:id', tag: TAG,
  summary: 'An issued report exactly as it was issued, with `verified`: true when its stored content still matches its SHA-256. Read under your live authority (404 otherwise); the read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await reportFor(c, user, i.id);
      await audit(c, user.id, 'sponsorship.roi_report.read', 'sponsor_roi_reports', r.id);
      return { id: r.id, view: r.view, kind: r.kind, period: { from: r.snapshot.period.from, to: r.snapshot.period.to }, issued_at: r.issued_at, content_sha256: r.content_sha256, verified: verified(r), snapshot: r.snapshot };
    });
  },
});

cap({
  name: 'export_sponsorship_roi_report', method: 'GET', path: '/sponsorship-roi-reports/:id/export', tag: TAG,
  summary: 'Export an issued report as CSV, XLSX or branded PDF (`kit_id` for a brand kit), built from the stored snapshot — the file always matches what was issued. Audit-logged, CSV-injection safe.',
  input: z.object({ id, format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'), kit_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await reportFor(c, user, i.id);
      if (!verified(r)) throw unprocessable('This report no longer matches its recorded hash and cannot be exported');
      const s = r.snapshot;
      const report = { kind: 'roi', view: r.view, columns: s.table.columns, rows: s.table.rows, totals: [], basis: { as_of: s.period.to, currency_basis: 'native', generated_at: s.generated_at,
          notes: [`Period ${s.period.from} to ${s.period.to}. ${s.valuation_note}`, `Not measured: ${s.not_measured.slice(0, 2).join('; ')}.`, `SHA-256 ${r.content_sha256}`] }, sources: s.sources };
      let kit = null;
      if (i.kit_id && i.format === 'pdf') kit = (await c.query('SELECT * FROM brand_kits WHERE id=$1', [i.kit_id])).rows[0] ?? null;
      const f = await exportReport(report, i.format, { kit });
      await audit(c, user.id, 'sponsorship.roi_report.export', 'sponsor_roi_reports', r.id);
      return { filename: f.filename.replace(/^sponsorship-roi-/, 'sponsorship-roi-report-'), content_type: f.type, encoding: typeof f.body === 'string' ? 'utf8' : 'base64', content: typeof f.body === 'string' ? f.body : f.body.toString('base64'), rows: s.table.rows.length };
    });
  },
});
