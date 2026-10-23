// Sponsorship portfolio reports (#305): financial ageing, award funnel, beneficiary outcomes, fulfilment and renewals.
// Nothing here is stored or a second ledger: every figure is read from the canonical agreements, obligations, payments, awards, deliveries
// and performance records at request time, under the caller's live authority, so a report always reconciles with its source and a revoked
// role or consent stops showing data at once. Exports (CSV / XLSX / PDF) are built from the very same row set as the dashboard.
// Money rules: currencies are never added together; cash (confirmed payments net of refunds) and estimates (goods / endorsement values,
// never cash) are separate columns; a reported-but-unconfirmed payment is its own column and is never counted as settled; delivery and
// endorsement are only "fulfilled" when the recipient confirmed them.
import { z } from 'zod';
import { many } from './db.js';
import { forbidden, unprocessable } from './errors.js';
import { sponsorStaffSql, sponsorBrandSql } from './sponsor-access.js';
import { recipientSql } from './beneficiary-portfolio.js';
import { beneficiaryScopeSql } from './sponsor-beneficiaries.js';
import { YOUTH_SQL } from './youth.js';
import { convert } from './sponsorship-budgets.js';

export const KINDS = ['ageing', 'funnel', 'outcomes', 'fulfilment', 'renewals'];
export const MAX_ROWS = 20000;
const date = z.string().date();
const list = z.preprocess((v) => (typeof v === 'string' ? (v === '' ? undefined : v.split(',')) : v), z.array(z.string().uuid()).max(50).optional());

/** The parameters of a report. Saved filters store exactly this object, so a filter can never carry anything a live call could not. */
export const PARAMS = z.object({
  view: z.enum(['sponsor', 'recipient']).default('sponsor').describe('sponsor: the brands you run; recipient: agreements where you are the beneficiary'),
  as_of: date.optional().describe('reporting date (defaults to today, never in the future)'),
  currency_basis: z.enum(['native', 'reporting']).default('native').describe('native keeps every currency apart; reporting converts only at the sourced budget FX rate recorded on the agreement'),
  currency: z.string().length(3).toUpperCase().optional().describe('the reporting currency when currency_basis is reporting'),
  sponsor_ids: list, program_id: z.string().uuid().optional(), from: date.optional(), to: date.optional(),
  target_type: z.enum(['event', 'team', 'athlete', 'organisation', 'group']).optional(),
  bucket: z.enum(['current', '1_30', '31_60', '61_90', 'over_90', 'on_hold']).optional(),
  state: z.enum(['upcoming', 'overdue', 'in_transit', 'awaiting_review', 'on_hold', 'fulfilled']).optional(),
  window_days: z.coerce.number().int().min(7).max(365).default(90),
}).strict();

const today = () => new Date().toISOString().slice(0, 10);
const LABEL = (a) => `CASE ${a}.target_type WHEN 'event' THEN (SELECT name FROM events WHERE id=${a}.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=${a}.target_id)
  WHEN 'athlete' THEN (SELECT CASE WHEN ${YOUTH_SQL} THEN 'Youth athlete' ELSE u.display_name END FROM users u WHERE u.id=${a}.target_id)
  WHEN 'organisation' THEN (SELECT name FROM organisations WHERE id=${a}.target_id) ELSE (SELECT name FROM org_cohorts WHERE id=${a}.target_id) END`;
const RUNNING = ['active', 'paused', 'ended', 'term_expired', 'completed'];

/** $1 user, $2 as_of, $3 sponsor ids, $4 program, $5 from, $6 to, $7 target type, $8 reporting currency, $9 window days. */
const dealWhere = (view, action) => `${view === 'sponsor' ? sponsorStaffSql(1, action)
  : `(${recipientSql('ss')} OR ${beneficiaryScopeSql('$1')}) AND (ss.budget_approval IS NULL OR ss.budget_approval NOT IN ('pending','rejected'))`}
  AND ss.accepted_version IS NOT NULL AND ss.status = ANY(ARRAY[${RUNNING.map((s) => `'${s}'`).join(',')}])
  AND ($3::uuid[] IS NULL OR ss.sponsor_id = ANY($3)) AND ($4::uuid IS NULL OR ss.program_id=$4) AND ($7::text IS NULL OR ss.target_type=$7)
  AND ($2::date IS NULL OR $5::date IS NULL OR $6::date IS NULL OR $8::text IS NULL OR $9::int IS NULL OR true)`; // the last line only types every parameter, so a query that skips one still runs
const DEALS = (view, action) => `deals AS (SELECT ss.*, sp.name AS sponsor_name, ${LABEL('ss')} AS recipient FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${dealWhere(view, action)})`;

const cell = (key, label, type = 'text') => ({ key, label, type });
const MONEY = (key, label) => ({ key, label, type: 'money' });

/** Authority gate: a sponsor view needs a live role that may read reports on at least one brand; a recipient view is always the caller's own data. */
export async function assertReportAccess(user, view, action = 'report') {
  if (view !== 'sponsor') return;
  const ok = (await many(`SELECT 1 FROM sponsors sp LEFT JOIN sponsorships ss ON ss.sponsor_id=sp.id WHERE ${sponsorStaffSql(1, action)} LIMIT 1`, [user.id])).length;
  if (!ok) throw forbidden(action === 'report' ? 'Your role does not allow sponsorship reports. Ask the brand manager for a finance, approver or auditor role.' : `Your role does not allow you to ${{ export: 'export reports', report_schedule: 'schedule reports' }[action] ?? 'do that'}`);
}

const src = (key, label, status, detail, count = 0) => ({ key, label, status, detail, count });
const fxOf = (r, target) => (r.currency === target ? 1 : (r.fx_rate == null ? null : Number(r.fx_rate)));

/** Re-express a row's money in the reporting currency at the rate recorded on its agreement; rows without a sourced rate stay native and are flagged. */
function toReporting(rows, target, fields) {
  return rows.map((r) => {
    if (r.currency == null) return { ...r, native_currency: null, fx_rate: null, converted: false };
    const rate = fxOf(r, target);
    if (rate == null) return { ...r, native_currency: r.currency, fx_rate: null, converted: false };
    const out = { ...r, native_currency: r.currency, fx_rate: rate, converted: r.currency !== target, currency: target };
    for (const f of fields) if (r[f] != null) out[f] = r.currency === target ? Number(r[f]) : convert(Number(r[f]), r.currency, target, rate);
    return out;
  });
}

const sumBy = (rows, key, fields) => {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] ?? '';
    const t = m.get(k) ?? { [key]: r[key] ?? null, ...Object.fromEntries(fields.map((f) => [f, 0])) };
    for (const f of fields) t[f] += Number(r[f] ?? 0);
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
};

// ---------------------------------------------------------------------------------------------------------------------------------
const fxJoin = (cur) => `LEFT JOIN sponsorship_budgets bu ON bu.id=d.budget_id
   LEFT JOIN sponsorship_budget_fx_rates fx ON fx.id=d.budget_fx_rate_id AND bu.currency=$8::text AND fx.currency=${cur}`;
const CONFIRMED = `coalesce((SELECT sum(p.amount_cents - p.refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed' AND (coalesce(p.decided_at,p.created_at) AT TIME ZONE 'UTC')::date <= $2::date),0)::bigint`;
const REPORTED = `coalesce((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported' AND (p.created_at AT TIME ZONE 'UTC')::date <= $2::date),0)::bigint`;

const AGEING_COLS = [cell('basis', 'Basis'), cell('agreement_ref', 'Agreement'), cell('sponsor_name', 'Sponsor'), cell('recipient', 'Recipient'), cell('label', 'Item'), cell('due_on', 'Due', 'date'), cell('days_past_due', 'Days past due', 'int'), cell('bucket', 'Age bucket'),
  cell('currency', 'Currency'), MONEY('committed_cents', 'Committed'), MONEY('cash_confirmed_cents', 'Cash confirmed'), MONEY('reported_unverified_cents', 'Reported, unverified'), MONEY('conceded_cents', 'Conceded'), MONEY('outstanding_cents', 'Cash outstanding'), MONEY('estimate_cents', 'Estimate (not cash)')];
const BUCKETS = ['current', '1_30', '31_60', '61_90', 'over_90', 'on_hold'];
const bucketOf = (dpd, hold) => (hold ? 'on_hold' : dpd <= 0 ? 'current' : dpd <= 30 ? '1_30' : dpd <= 60 ? '31_60' : dpd <= 90 ? '61_90' : 'over_90');

async function ageing(user, p, a) {
  const raw = await many(
    `WITH ${DEALS(p.view, p._action)}
     SELECT 'cash' AS basis, d.id AS agreement_id, d.agreement_ref, d.sponsor_name, d.recipient, 'Instalment ' || o.seq AS label, o.due_on::text AS due_on, ($2::date - o.due_on)::int AS days_past_due, o.held_by_pause_id IS NOT NULL AS on_hold,
            o.currency, o.amount_cents::bigint AS committed_cents, ${CONFIRMED} AS cash_confirmed_cents, ${REPORTED} AS reported_unverified_cents, coalesce(o.conceded_cents,0)::bigint AS conceded_cents,
            NULL::bigint AS estimate_cents, fx.rate AS fx_rate, o.id::text AS sort_key
       FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id ${fxJoin('o.currency')}
      WHERE o.kind='money' AND o.status <> 'cancelled'
     UNION ALL
     SELECT 'estimate', d.id, d.agreement_ref, d.sponsor_name, d.recipient, l.label, min(o.due_on)::text, ($2::date - min(o.due_on))::int, bool_and(o.held_by_pause_id IS NOT NULL),
            l.currency, NULL, NULL, NULL, NULL, l.estimate_cents::bigint, fx.rate, l.id::text
       FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id JOIN sponsorship_lines l ON l.id=o.line_id ${fxJoin('l.currency')}
      WHERE o.kind IN ('goods','endorsement') AND o.status='scheduled' AND l.estimate_cents > 0 AND l.currency IS NOT NULL
      GROUP BY d.id, d.agreement_ref, d.sponsor_name, d.recipient, l.id, l.label, l.currency, l.estimate_cents, fx.rate
     ORDER BY 1, 3, 6, 17 LIMIT ${MAX_ROWS + 1}`, a);
  if (raw.length > MAX_ROWS) throw unprocessable(`More than ${MAX_ROWS} rows match. Narrow the report by brand, program or target.`);
  const num = ['committed_cents', 'cash_confirmed_cents', 'reported_unverified_cents', 'conceded_cents', 'estimate_cents'];
  let rows = raw.map((r) => ({ ...r, ...Object.fromEntries(num.map((k) => [k, r[k] == null ? null : Number(r[k])])) }));
  for (const r of rows) {
    r.outstanding_cents = r.basis === 'cash' ? Math.max(r.committed_cents - r.cash_confirmed_cents - r.conceded_cents, 0) : null;
    // ageing is a cash measure: an estimate carries a due date but no days past due and no bucket
    if (r.basis === 'cash') { r.bucket = bucketOf(r.days_past_due, r.on_hold); r.days_past_due = Math.max(r.days_past_due, 0); } else { r.bucket = null; r.days_past_due = null; }
  }
  if (p.currency_basis === 'reporting') rows = toReporting(rows, p.currency, [...num, 'outstanding_cents']);
  const cash = rows.filter((r) => r.basis === 'cash');
  const totals = sumBy(rows, 'currency', ['committed_cents', 'cash_confirmed_cents', 'reported_unverified_cents', 'conceded_cents', 'outstanding_cents', 'estimate_cents']).map((t) => {
    const mine = cash.filter((r) => r.currency === t.currency && r.outstanding_cents > 0);
    const b = (k) => mine.filter((r) => r.bucket === k).reduce((s, r) => s + r.outstanding_cents, 0);
    return { ...t, current_cents: b('current'), d1_30_cents: b('1_30'), d31_60_cents: b('31_60'), d61_90_cents: b('61_90'), over_90_cents: b('over_90'), on_hold_cents: b('on_hold'),
      converted: rows.some((r) => r.currency === t.currency && r.converted) };
  });
  const shown = rows.filter((r) => (r.basis === 'cash' ? r.outstanding_cents > 0 : true) && (!p.bucket || r.bucket === p.bucket));
  const reconciles = totals.every((t) => t.outstanding_cents === t.current_cents + t.d1_30_cents + t.d31_60_cents + t.d61_90_cents + t.over_90_cents + t.on_hold_cents);
  const stale = (await many(
    `WITH ${DEALS(p.view, p._action)} SELECT count(*)::int AS n FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN deals d ON d.id=o.sponsorship_id
      WHERE x.status='reported' AND x.created_at < ($2::date - 7)::timestamptz`, a))[0].n;
  const noLedger = (await many(
    `WITH ${DEALS(p.view, p._action)} SELECT count(*)::int AS n FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN deals d ON d.id=o.sponsorship_id
      WHERE x.method='online' AND x.status='confirmed' AND NOT EXISTS (SELECT 1 FROM provider_ledger l WHERE l.purpose_type='sponsorship_payment' AND l.purpose_id=x.id AND l.kind='sale')`, a))[0].n;
  const unconverted = p.currency_basis === 'reporting' ? rows.filter((r) => r.currency != null && r.currency !== p.currency && !r.converted) : [];
  const sources = [
    src('agreements', 'Agreements and instalments', 'ok', `${new Set(rows.map((r) => r.agreement_id)).size} agreements in scope`),
    stale ? src('payments', 'Payment confirmations', 'stale', `${stale} reported payment${stale > 1 ? 's have' : ' has'} waited more than 7 days for the recipient to confirm; they are not counted as cash`, stale) : src('payments', 'Payment confirmations', 'ok', 'No reported payment is waiting more than 7 days'),
    noLedger ? src('provider_ledger', 'Online payment ledger', 'missing', `${noLedger} confirmed online payment${noLedger > 1 ? 's have' : ' has'} no provider ledger entry`, noLedger) : src('provider_ledger', 'Online payment ledger', 'ok', 'Every confirmed online payment has a ledger entry'),
    ...(p.currency_basis === 'reporting' ? [unconverted.length ? src('fx', `FX to ${p.currency}`, 'missing', `${unconverted.length} item${unconverted.length > 1 ? 's' : ''} have no sourced budget FX rate to ${p.currency} and stay in their own currency`, unconverted.length) : src('fx', `FX to ${p.currency}`, 'ok', 'Every item converted at the rate recorded on its agreement')] : []),
  ];
  return { columns: AGEING_COLS, rows: shown, totals, sources, reconciles };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const FUNNEL_COLS = [cell('program', 'Program'), cell('sponsor_name', 'Sponsor'), cell('currency', 'Currency'), cell('applications', 'Applications', 'int'), cell('shortlisted', 'Shortlisted', 'int'), cell('interview', 'Interview', 'int'), cell('finalist', 'Finalist', 'int'),
  cell('awarded', 'Awarded', 'int'), cell('declined', 'Declined', 'int'), cell('withdrawn', 'Withdrawn', 'int'), cell('offers_open', 'Offers open', 'int'), cell('offers_accepted', 'Offers accepted', 'int'), cell('offers_lapsed', 'Offers declined / expired', 'int'),
  MONEY('requested_cents', 'Requested'), MONEY('offered_cents', 'Offered (not committed)'), MONEY('awarded_cents', 'Awarded')];

async function funnel(user, p, a) {
  const scope = p.view === 'sponsor' ? sponsorBrandSql(1, p._action) : `(a.applicant_id=$1 OR ${recipientSql('a')})`;
  const rows = (await many(
    `SELECT pr.id AS program_id, pr.name AS program, sp.name AS sponsor_name, a.currency,
            count(*)::int AS applications,
            count(*) FILTER (WHERE a.stage IN ('shortlisted','interview','finalist'))::int AS shortlisted, count(*) FILTER (WHERE a.stage IN ('interview','finalist'))::int AS interview, count(*) FILTER (WHERE a.stage='finalist')::int AS finalist,
            count(*) FILTER (WHERE a.status='awarded')::int AS awarded, count(*) FILTER (WHERE a.status='declined')::int AS declined, count(*) FILTER (WHERE a.status='withdrawn')::int AS withdrawn,
            coalesce(sum(a.requested_cents),0)::bigint AS requested_cents, coalesce(sum(a.awarded_cents) FILTER (WHERE a.status='awarded'),0)::bigint AS awarded_cents,
            coalesce((SELECT count(*) FROM sponsorship_awards w WHERE w.program_id=pr.id AND w.currency=a.currency AND w.status IN ('pending_approval','approved','issued') AND w.application_id IN (SELECT id FROM sponsorship_applications x WHERE x.program_id=pr.id AND (x.created_at AT TIME ZONE 'UTC')::date <= $2::date)),0)::int AS offers_open,
            coalesce((SELECT count(*) FROM sponsorship_awards w WHERE w.program_id=pr.id AND w.currency=a.currency AND w.status='accepted'),0)::int AS offers_accepted,
            coalesce((SELECT count(*) FROM sponsorship_awards w WHERE w.program_id=pr.id AND w.currency=a.currency AND w.status IN ('declined','expired','rejected','withdrawn')),0)::int AS offers_lapsed,
            coalesce((SELECT sum(w.amount_cents) FROM sponsorship_awards w WHERE w.program_id=pr.id AND w.currency=a.currency AND w.status IN ('pending_approval','approved','issued')),0)::bigint AS offered_cents,
            count(*) FILTER (WHERE a.status='submitted' AND r.closes_on < ($2::date - 30))::int AS undecided_stale
       FROM sponsorship_applications a JOIN sponsorship_programs pr ON pr.id=a.program_id JOIN sponsors sp ON sp.id=pr.sponsor_id JOIN sponsorship_rounds r ON r.id=a.round_id
      WHERE ${scope} AND ($3::uuid[] IS NULL OR pr.sponsor_id = ANY($3)) AND ($4::uuid IS NULL OR pr.id=$4) AND ($7::text IS NULL OR a.target_type=$7)
        AND ($5::date IS NULL OR (a.created_at AT TIME ZONE 'UTC')::date >= $5) AND ($6::date IS NULL OR (a.created_at AT TIME ZONE 'UTC')::date <= $6) AND (a.created_at AT TIME ZONE 'UTC')::date <= $2::date
      GROUP BY pr.id, pr.name, sp.name, a.currency ORDER BY pr.name, pr.id, a.currency LIMIT ${MAX_ROWS + 1}`, a.slice(0, 7))).map((r) => ({ ...r, requested_cents: Number(r.requested_cents), awarded_cents: Number(r.awarded_cents), offered_cents: Number(r.offered_cents) }));
  const stale = rows.reduce((s, r) => s + r.undecided_stale, 0);
  const totals = sumBy(rows, 'currency', ['applications', 'shortlisted', 'interview', 'finalist', 'awarded', 'declined', 'withdrawn', 'offers_open', 'offers_accepted', 'offers_lapsed', 'requested_cents', 'offered_cents', 'awarded_cents']);
  const sources = [
    rows.length ? src('programs', 'Programs and applications', 'ok', `${new Set(rows.map((r) => r.program_id)).size} programs in scope`) : src('programs', 'Programs and applications', 'missing', 'No applications match these filters'),
    stale ? src('decisions', 'Application decisions', 'stale', `${stale} application${stale > 1 ? 's are' : ' is'} still undecided more than 30 days after the round closed`, stale) : src('decisions', 'Application decisions', 'ok', 'No application is undecided 30 days after its round closed'),
  ];
  return { columns: FUNNEL_COLS, rows: rows.map(({ undecided_stale, ...r }) => r), totals, sources, reconciles: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const FULFIL_COLS = [cell('kind', 'Kind'), cell('agreement_ref', 'Agreement'), cell('sponsor_name', 'Sponsor'), cell('recipient', 'Recipient'), cell('label', 'Item'), cell('due_on', 'Due', 'date'), cell('state', 'State'),
  cell('quantity', 'Committed qty', 'int'), cell('received_quantity', 'Received qty', 'int'), cell('in_transit_quantity', 'In transit qty', 'int'), cell('days_overdue', 'Days overdue', 'int')];

async function fulfilment(user, p, a) {
  const raw = await many(
    `WITH ${DEALS(p.view, p._action)}
     SELECT * FROM (SELECT o.kind, d.agreement_ref, d.sponsor_name, d.recipient, l.label, o.due_on::text AS due_on, o.quantity,
        coalesce((SELECT sum(x.received_quantity) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='received' AND (x.decided_at AT TIME ZONE 'UTC')::date <= $2::date),0)::int AS received_quantity,
        coalesce((SELECT sum(x.quantity) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='dispatched'),0)::int AS in_transit_quantity,
        (SELECT max((x.created_at AT TIME ZONE 'UTC')::date) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='dispatched')::text AS last_dispatched_on,
        EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status='submitted') AS submitted,
        (SELECT min((s.created_at AT TIME ZONE 'UTC')::date) FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status='submitted')::text AS submitted_on,
        CASE WHEN o.status='fulfilled' AND (o.fulfilled_at AT TIME ZONE 'UTC')::date <= $2::date THEN 'fulfilled'
             WHEN o.held_by_pause_id IS NOT NULL THEN 'on_hold'
             WHEN o.kind='goods' AND EXISTS (SELECT 1 FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='dispatched') THEN 'in_transit'
             WHEN o.kind='endorsement' AND EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status='submitted') THEN 'awaiting_review'
             WHEN o.due_on < $2::date THEN 'overdue' ELSE 'upcoming' END AS state, greatest($2::date - o.due_on, 0)::int AS days_overdue
       FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id JOIN sponsorship_lines l ON l.id=o.line_id
      WHERE o.kind IN ('goods','endorsement') AND o.status <> 'cancelled' AND ($5::date IS NULL OR o.due_on >= $5) AND ($6::date IS NULL OR o.due_on <= $6)) q
     ORDER BY due_on, agreement_ref, label LIMIT ${MAX_ROWS + 1}`, a);
  if (raw.length > MAX_ROWS) throw unprocessable(`More than ${MAX_ROWS} rows match. Narrow the report.`);
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  const asOf = day(a[1]);
  const rows = raw.map((r) => ({ ...r, days_overdue: r.state === 'overdue' ? r.days_overdue : 0 }));
  const shown = rows.filter((r) => !p.state || r.state === p.state);
  const totals = ['goods', 'endorsement'].flatMap((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    return mine.length ? [{ kind, items: mine.length, ...Object.fromEntries(['fulfilled', 'upcoming', 'overdue', 'in_transit', 'awaiting_review', 'on_hold'].map((s) => [s, mine.filter((r) => r.state === s).length])) }] : [];
  });
  const lateShip = rows.filter((r) => r.state === 'in_transit' && r.last_dispatched_on && (asOf - day(r.last_dispatched_on)) / 864e5 > 14).length;
  const lateReview = rows.filter((r) => r.state === 'awaiting_review' && r.submitted_on && (asOf - day(r.submitted_on)) / 864e5 > 7).length;
  const sources = [
    src('obligations', 'Goods and endorsement dues', rows.length ? 'ok' : 'missing', rows.length ? `${rows.length} dues in scope` : 'No goods or endorsement dues match these filters', rows.length),
    lateShip ? src('deliveries', 'Delivery confirmations', 'stale', `${lateShip} shipment${lateShip > 1 ? 's were' : ' was'} dispatched more than 14 days ago and not confirmed received; they are not counted as delivered`, lateShip) : src('deliveries', 'Delivery confirmations', 'ok', 'No dispatched shipment is waiting more than 14 days'),
    lateReview ? src('endorsements', 'Endorsement reviews', 'stale', `${lateReview} endorsement submission${lateReview > 1 ? 's have' : ' has'} waited more than 7 days for review; they are not counted as delivered`, lateReview) : src('endorsements', 'Endorsement reviews', 'ok', 'No endorsement submission is waiting more than 7 days'),
  ];
  return { columns: FULFIL_COLS, rows: shown.map(({ last_dispatched_on, submitted, submitted_on, ...r }) => r), totals, sources, reconciles: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const RENEW_COLS = [cell('agreement_ref', 'Agreement'), cell('sponsor_name', 'Sponsor'), cell('recipient', 'Recipient'), cell('status', 'Status'), cell('ends_on', 'Ends', 'date'), cell('days_left', 'Days left', 'int'),
  cell('sponsor_intent', 'Sponsor intent'), cell('recipient_intent', 'Recipient intent'), cell('successor', 'Renewal'), cell('open_dues', 'Open dues', 'int')];

async function renewals(user, p, a) {
  const rows = await many(
    `WITH ${DEALS(p.view, p._action)}
     SELECT d.id AS agreement_id, d.agreement_ref, d.sponsor_name, d.recipient, d.status, d.ends_on::text AS ends_on, (d.ends_on - $2::date)::int AS days_left,
            (SELECT x.intent FROM sponsorship_renewal_assessments x WHERE x.sponsorship_id=d.id AND x.side='sponsor') AS sponsor_intent,
            (SELECT x.intent FROM sponsorship_renewal_assessments x WHERE x.sponsorship_id=d.id AND x.side='recipient') AS recipient_intent,
            coalesce((SELECT n.status FROM sponsorships n WHERE n.renews_id=d.id AND n.status NOT IN ('declined','withdrawn') LIMIT 1), 'none') AS successor,
            (SELECT count(*) FROM sponsorship_obligations x WHERE x.sponsorship_id=d.id AND x.status='scheduled')::int AS open_dues
       FROM deals d WHERE d.ends_on IS NOT NULL AND d.status IN ('active','paused','term_expired','completed','ended') AND d.ends_on - $2::date <= $9::int
        AND ($5::date IS NULL OR d.ends_on >= $5) AND ($6::date IS NULL OR d.ends_on <= $6)
      ORDER BY d.ends_on, d.agreement_ref, d.id LIMIT ${MAX_ROWS + 1}`, a);
  const open = rows.length ? await many(
    "SELECT o.currency, sum(o.amount_cents)::bigint AS cents FROM sponsorship_obligations o WHERE o.sponsorship_id = ANY($1::uuid[]) AND o.status='scheduled' AND o.kind='money' GROUP BY o.currency ORDER BY o.currency", [rows.map((r) => r.agreement_id)]) : [];
  const totals = [
    { agreements: rows.length, expired: rows.filter((r) => r.days_left < 0).length, expiring: rows.filter((r) => r.days_left >= 0).length, renewed: rows.filter((r) => r.successor !== 'none').length,
      not_renewing: rows.filter((r) => r.sponsor_intent === 'not_renew' || r.recipient_intent === 'not_renew').length },
    ...open.map((o) => ({ currency: o.currency, open_money_cents: Number(o.cents) })),
  ];
  const missing = rows.filter((r) => r.successor === 'none' && (!r.sponsor_intent || !r.recipient_intent)).length;
  const sources = [
    src('agreements', 'Agreements with an end date', rows.length ? 'ok' : 'missing', rows.length ? `${rows.length} agreements end within ${p.window_days} days or have ended` : `No agreement ends within ${p.window_days} days`, rows.length),
    missing ? src('assessments', 'Renewal intentions', 'missing', `${missing} agreement${missing > 1 ? 's have' : ' has'} no recorded renewal intention from one or both sides`, missing) : src('assessments', 'Renewal intentions', 'ok', 'Both sides have recorded an intention on every open renewal'),
  ];
  return { columns: RENEW_COLS, rows: rows.map(({ agreement_id, ...r }) => r), totals, sources, reconciles: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const OUTCOME_COLS = [cell('agreement_ref', 'Agreement'), cell('sponsor_name', 'Sponsor'), cell('athlete', 'Athlete'), cell('status', 'Agreement status'), cell('consent', 'Results sharing'), cell('scope', 'Evidence shared'),
  cell('agreed_objectives', 'Agreed objectives', 'int'), cell('measured', 'Measured', 'int'), cell('met', 'Met', 'int'), cell('no_results', 'No results yet', 'int'), cell('not_shared', 'Evidence not shared', 'int'), cell('latest_result_on', 'Latest result', 'date')];

async function outcomes(user, p, a) {
  const sponsor = p.view === 'sponsor';
  const mayRead = sponsor ? `(${sponsorStaffSql(1, 'performance')})` : 'true';
  const rows = await many(
    `WITH ${DEALS(p.view, p._action)}
     SELECT d.agreement_ref, d.sponsor_name, d.recipient AS athlete, d.status, d.performance_scope AS scope, d.target_id, ${mayRead} AS may_read, d.performance_access, d.id AS agreement_id
       FROM deals d JOIN sponsors sp ON sp.id=d.sponsor_id JOIN sponsorships ss ON ss.id=d.id
      WHERE d.target_type='athlete' ORDER BY d.agreement_ref, d.id LIMIT ${MAX_ROWS + 1}`, a);
  const out = [];
  for (const r of rows) {
    // the consent gate: the sponsor reads results only while the athlete's sharing switch is on and the agreement is running
    const consent = !sponsor ? (r.performance_access ? 'shared' : 'not_shared') : !r.may_read ? 'no_permission' : !['active', 'ended', 'term_expired'].includes(r.status) ? 'not_running' : r.performance_access ? 'shared' : 'not_shared';
    const visible = !sponsor || consent === 'shared';
    let m = { agreed: null, measured: null, met: null, no_results: null, not_shared: null, latest: null };
    if (visible) {
      const official = sponsor && r.scope === 'official';
      m = (await many(
        `SELECT count(*)::int AS agreed, count(*) FILTER (WHERE allowed AND n>0)::int AS measured, count(*) FILTER (WHERE allowed AND n>0 AND (CASE WHEN direction='lower' THEN best<=target_value ELSE best>=target_value END))::int AS met,
                count(*) FILTER (WHERE allowed AND n=0)::int AS no_results, count(*) FILTER (WHERE NOT allowed)::int AS not_shared, (SELECT max(coalesce(p.achieved_on, p.recorded_at::date))::text FROM performances p WHERE p.user_id=$2 AND ((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded')) AND ${official ? "p.provenance='approved_competition' AND" : ''} coalesce(p.achieved_on, p.recorded_at::date) <= $3::date) AS latest
           FROM (SELECT o.direction, o.target_value, (NOT $4::boolean OR o.evidence='approved_competition') AS allowed, m.n, m.best
                   FROM sponsorship_objectives o CROSS JOIN LATERAL (SELECT count(*)::int AS n, CASE WHEN o.direction='lower' THEN min(x.value) ELSE max(x.value) END AS best FROM performances x
                        WHERE x.user_id=$2 AND x.sport_id=o.sport_id AND x.metric=o.metric AND x.provenance=o.evidence AND ((x.provenance='approved_competition' AND x.status='approved') OR (x.provenance IN ('self_reported','imported') AND x.status='recorded'))
                          AND coalesce(x.achieved_on, x.recorded_at::date) BETWEEN o.window_start AND least(o.window_end, $3::date)) m
                  WHERE o.sponsorship_id=$1 AND o.status='agreed') q`, [r.agreement_id, r.target_id, a[1], official]))[0];
    }
    out.push({ agreement_ref: r.agreement_ref, sponsor_name: r.sponsor_name, athlete: r.athlete, status: r.status, consent, scope: visible ? (r.scope === 'official' && sponsor ? 'official only' : 'all evidence') : null,
      agreed_objectives: m.agreed, measured: m.measured, met: m.met, no_results: m.no_results, not_shared: m.not_shared, latest_result_on: m.latest });
  }
  const totals = [{ agreements: out.length, shared: out.filter((r) => r.consent === 'shared').length, consent_missing: out.filter((r) => r.consent === 'not_shared').length,
    agreed_objectives: out.reduce((s, r) => s + (r.agreed_objectives ?? 0), 0), measured: out.reduce((s, r) => s + (r.measured ?? 0), 0), met: out.reduce((s, r) => s + (r.met ?? 0), 0) }];
  const noConsent = out.filter((r) => r.consent === 'not_shared').length;
  const cutoff = Date.parse(`${a[1]}T00:00:00Z`) - 90 * 864e5;
  const old = out.filter((r) => r.consent === 'shared' && (!r.latest_result_on || Date.parse(`${r.latest_result_on}T00:00:00Z`) < cutoff)).length;
  const sources = [
    out.length ? src('agreements', 'Athlete agreements', 'ok', `${out.length} agreements with an individual athlete`) : src('agreements', 'Athlete agreements', 'missing', 'No agreement with an individual athlete matches these filters'),
    noConsent ? src('consent', 'Athlete consent to share results', 'missing', `${noConsent} athlete${noConsent > 1 ? 's have' : ' has'} not shared results; their outcomes are not shown`, noConsent) : src('consent', 'Athlete consent to share results', 'ok', 'Every athlete in scope shares their results'),
    old ? src('results', 'Athlete results', 'stale', `${old} athlete${old > 1 ? 's have' : ' has'} no result recorded in the last 90 days`, old) : src('results', 'Athlete results', 'ok', 'Every sharing athlete has a result in the last 90 days'),
  ];
  return { columns: OUTCOME_COLS, rows: out, totals, sources, reconciles: true };
}

const BUILDERS = { ageing, funnel, fulfilment, renewals, outcomes };
const NOTES = {
  ageing: ['Cash is confirmed payments net of refunds, counted when confirmed on or before the reporting date. Refunds and concessions are as recorded now.', 'Estimates are goods and endorsement values, never cash, and are not part of any cash column.', 'A reported payment the recipient has not confirmed is shown separately and is never counted as settled.'],
  funnel: ['Counts are as of now for applications submitted on or before the reporting date; offers are not commitments until accepted.'],
  fulfilment: ['A due is fulfilled only when the recipient confirmed it. A dispatched shipment or a submitted endorsement is not counted as delivered.'],
  renewals: ['Agreements ending within the window, or already ended. A renewal is always a new agreement; an intention is not a renewal.'],
  outcomes: ['Results are read live from the athlete\'s own records and shown only while the athlete shares them and the agreement is running. Sports and evidence kinds are never combined.'],
};

/**
 * Build a report under the caller's live authority. Returns the full row set (`all`) so exports and paging use the same data.
 * @returns {Promise<{kind, view, basis, columns, rows, totals, sources, reconciles}>}
 */
export async function buildReport(user, kind, input, { action = 'report' } = {}) {
  const p = { ...PARAMS.parse(input ?? {}), _action: action };
  const asOf = p.as_of ?? today();
  if (asOf > today()) throw unprocessable('The reporting date cannot be in the future');
  if (p.from && p.to && p.to < p.from) throw unprocessable('to is before from');
  if (p.currency_basis === 'reporting' && !p.currency) throw unprocessable('Pick the reporting currency, or use the native basis');
  await assertReportAccess(user, p.view, action);
  const args = [user.id, asOf, p.sponsor_ids ?? null, p.program_id ?? null, p.from ?? null, p.to ?? null, p.target_type ?? null, p.currency ?? null, p.window_days];
  const out = await BUILDERS[kind](user, p, args);
  return {
    kind, view: p.view,
    basis: { as_of: asOf, currency_basis: p.currency_basis, currency: p.currency_basis === 'reporting' ? p.currency : null, generated_at: new Date().toISOString(), cash_and_estimates: 'separate', notes: [...NOTES[kind], p.currency_basis === 'native' ? 'Every currency is kept apart and never added to another.' : `Converted to ${p.currency} only at the sourced budget FX rate recorded on each agreement; nothing else is converted.`] },
    ...out,
  };
}

/** Page a built report without re-reading it. */
export const pageOf = (r, limit, offset) => ({ ...r, total_rows: r.rows.length, limit, offset, rows: r.rows.slice(offset, offset + limit) });
