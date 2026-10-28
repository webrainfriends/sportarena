// Sponsorship ROI & portfolio intelligence (#519): the shared facts layer. Everything here READS the canonical sponsorship, placement, follower and deliverable
// records; money is never recomputed (it comes from `list_sponsorship_obligations`, the one source of finance truth) and nothing is estimated unless the
// brand configured the assumptions itself. Unmeasured things (social reach, brand impressions, media value) are named in NOT_MEASURED and never produced.
import { createHash } from 'node:crypto';
import { capabilities } from './registry.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { isYouth } from './youth.js';
import { mustOwn } from './helpers.js';
import { eventForOrganizer } from './capabilities/events.js';

export const RUNNING = ['active', 'paused', 'ended', 'term_expired', 'completed'];
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;

export const INVENTORY_KINDS = {
  title_partner: 'Event title partner', associate_partner: 'Event associate partner', team_association: 'Team association', athlete_association: 'Athlete association',
  kit_placement: 'Jersey / kit / logo placement', event_page: 'Public event page placement', leaderboard: 'Leaderboard placement', scorecard: 'Scorecard placement',
  livestream_overlay: 'Livestream overlay', replay: 'Replay placement', social_content: 'Social / content placement', hospitality: 'Hospitality / tickets',
  sponsored_challenge: 'Sponsored challenge or reward', appearance: 'Agreed appearance', content_deliverable: 'Agreed content deliverable',
};
/** The public-page slot (#501) an event inventory kind sells; only these kinds can back a placement on the public pages. */
export const SLOT_OF = { title_partner: 'title_partner', scorecard: 'scorecard', leaderboard: 'leaderboard', event_page: 'fixture' };
export const CATEGORIES = ['beverage', 'nutrition', 'apparel', 'footwear', 'equipment', 'banking_finance', 'insurance', 'telecom', 'automotive', 'technology', 'healthcare', 'education', 'travel_hospitality', 'media', 'retail', 'other'];
export const DELIVERABLE_KINDS = ['appearance', 'content', 'hospitality', 'challenge_reward', 'activation', 'other'];
/** Media-licence deliverable kinds (media rights, #482) -> the inventory kinds that authorise them once an event sells such inventory. */
export const MR_UNIT_KINDS = { graphic_overlay: ['livestream_overlay'], naming_mention: ['livestream_overlay', 'replay', 'title_partner'], content_piece: ['replay', 'social_content', 'content_deliverable'], signage: ['kit_placement', 'associate_partner', 'title_partner'] };

/**
 * Governed metric catalogue. `basis`: platform_measured = counted by Sportarena itself; provider_reported = a figure the beneficiary entered from a named provider
 * report (labelled as such everywhere, never merged with a platform count). `period_bound` false = a point-in-time count, not a figure for the window.
 */
export const METRICS = [
  { key: 'placement_impressions', label: 'Placement impressions served', unit: 'impressions', basis: 'platform_measured', period_bound: true, additive: true,
    definition: 'Times a public response carried this sponsor\'s placement on the public event pages. Polling reads are not counted. This counts responses, not unique people.', dedupe: 'One counter per placement per day; polling refreshes excluded.' },
  { key: 'placement_clicks', label: 'Call-to-action clicks', unit: 'clicks', basis: 'platform_measured', period_bound: true, additive: true,
    definition: 'Times a visitor followed the call to action of the sponsor\'s placement. Youth events show no call to action.', dedupe: 'Raw follows; the same person may click twice.' },
  { key: 'event_followers', label: 'Followers of the sponsored event, team or athlete', unit: 'accounts', basis: 'platform_measured', period_bound: false, additive: false,
    definition: 'Signed-in accounts currently following the sponsored event or team (or an adult athlete) at the time of reading. A point-in-time count of distinct accounts.', dedupe: 'Distinct accounts (one follow per account); never summed across agreements because the same people can follow several sponsored subjects.' },
  { key: 'broadcast_views', label: 'Broadcast / stream views', unit: 'views', basis: 'provider_reported', source: 'media_rights', period_bound: true, additive: true,
    definition: 'Views a named provider reported for a media-licence deliverable that names this agreement (recorded in Media & broadcast, not entered again here).', dedupe: 'One source per deliverable and metric (the first to report); the same reference and dates are never counted twice.' },
  { key: 'broadcast_impressions', label: 'Broadcast / overlay impressions', unit: 'impressions', basis: 'provider_reported', source: 'media_rights', period_bound: true, additive: true,
    definition: 'Impressions a named provider reported for a media-licence deliverable that names this agreement.', dedupe: 'One source per deliverable and metric; the same reference and dates are never counted twice.' },
  { key: 'broadcast_watch_minutes', label: 'Broadcast watch minutes', unit: 'minutes', basis: 'provider_reported', source: 'media_rights', period_bound: true, additive: true,
    definition: 'Watch minutes a named provider reported for a media-licence deliverable that names this agreement.', dedupe: 'One source per deliverable and metric; the same reference and dates are never counted twice.' },
  { key: 'broadcast_unique_viewers', label: 'Broadcast unique viewers (highest reported)', unit: 'viewers', basis: 'provider_reported', source: 'media_rights', period_bound: false, additive: false,
    definition: 'The highest unique-viewer figure a named provider reported for a deliverable that names this agreement. Unique viewers of different periods overlap, so figures are never summed.', dedupe: 'Highest single reported figure; never summed.' },
  { key: 'broadcast_peak_concurrent', label: 'Broadcast peak concurrent viewers', unit: 'viewers', basis: 'provider_reported', source: 'media_rights', period_bound: false, additive: false,
    definition: 'The highest concurrent-viewer peak a named provider reported for a deliverable that names this agreement.', dedupe: 'Highest single reported figure; never summed.' },
  { key: 'page_views', label: 'Page views (external)', unit: 'views', basis: 'provider_reported', period_bound: true, additive: true,
    definition: 'Page views of an external page that carries the sponsor, as reported by that site\'s analytics.', dedupe: 'One live value per agreement, metric and day.' },
  { key: 'attendance', label: 'Attendance', unit: 'people', basis: 'provider_reported', period_bound: true, additive: true,
    definition: 'People who attended, from the organiser\'s gate or ticketing record.', dedupe: 'One live value per agreement, metric and day.' },
  { key: 'tickets_scanned', label: 'Tickets scanned', unit: 'tickets', basis: 'provider_reported', period_bound: true, additive: true,
    definition: 'Tickets scanned at entry, from the ticketing system.', dedupe: 'One live value per agreement, metric and day.' },
  { key: 'hospitality_guests', label: 'Hospitality guests hosted', unit: 'guests', basis: 'provider_reported', period_bound: true, additive: true,
    definition: 'Guests the sponsor hosted in hospitality, from the guest list.', dedupe: 'One live value per agreement, metric and day.' },
];
export const PROVIDER_METRICS = METRICS.filter((m) => m.basis === 'provider_reported' && m.source !== 'media_rights').map((m) => m.key); // entered here; broadcast reach is read from media rights
export const VALUABLE_METRICS = METRICS.filter((m) => m.additive && m.period_bound).map((m) => m.key);
export const NOT_MEASURED = [
  'Social-media reach and impressions outside Sportarena', 'Unique audience reach', 'Brand awareness, sentiment or sales lift',
  'Advertising-value-equivalent (AVE) or any media value, unless the brand configured valuation assumptions (shown as an estimate)',
];
/** Which measured metrics a kind of inventory is expected to produce; an expected metric with no data is reported as missing, never as zero. */
const EXPECTS = { title_partner: ['placement_impressions'], associate_partner: [], event_page: ['placement_impressions'], leaderboard: ['placement_impressions'], scorecard: ['placement_impressions'],
  livestream_overlay: ['broadcast_impressions', 'broadcast_views'], replay: ['broadcast_views'], social_content: [], hospitality: ['hospitality_guests'] }; // social content is never measured here (see NOT_MEASURED)
const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m]));
export const metricOf = (k) => METRIC[k];

/** Stable JSON (sorted keys) so a snapshot hashes the same however it is read back. */
export const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export const sha = (v) => createHash('sha256').update(canon(v)).digest('hex');

const through = (name, user, input) => capabilities.find((x) => x.name === name).handler({ user }, input);

/** Who may manage the inventory of a target: the event organiser (or its organisation owners/admins), the team owner, or an adult athlete themself. */
export async function manageTarget(c, user, type, id) {
  if (type === 'event') { const ev = await eventForOrganizer(user, id, c); return { name: ev.name, youth: ev.max_age != null && ev.max_age < 18 }; }
  if (type === 'team') {
    const t = (await c.query('SELECT id, name, owner_id FROM teams WHERE id=$1', [id])).rows[0];
    if (!t) throw notFound('Team');
    mustOwn(user, t.owner_id, 'team');
    return { name: t.name, youth: false };
  }
  if (type === 'athlete') {
    if (user.id !== id) throw forbidden('Only the athlete manages their own sponsor inventory');
    if (await isYouth(id, c)) throw conflict('A young athlete\'s sponsorship is managed through their guardian and is not sold as inventory');
    return { name: user.display_name, youth: false };
  }
  throw badRequest('Inventory is for events, teams and adult athletes');
}

export async function targetLabel(c, d) {
  const q = async (sql) => (await c.query(sql, [d.target_id])).rows[0]?.n ?? null;
  if (d.target_type === 'event') return q('SELECT name AS n FROM events WHERE id=$1');
  if (d.target_type === 'team') return q('SELECT name AS n FROM teams WHERE id=$1');
  if (d.target_type === 'organisation') return q('SELECT name AS n FROM organisations WHERE id=$1');
  if (d.target_type === 'group') return q('SELECT name AS n FROM org_cohorts WHERE id=$1');
  return (await isYouth(d.target_id, c)) ? 'Youth athlete' : q('SELECT display_name AS n FROM users WHERE id=$1');
}

/** The window an agreement can be measured over: the requested period clipped to its own term. */
export function windowOf(d, from, to) {
  const f = [from, d.starts].filter(Boolean).sort().pop();
  const t = [to, d.ends].filter(Boolean).sort()[0];
  return { from: f, to: t, days: t && f && t >= f ? daysBetween(f, t) : 0 };
}

/**
 * Measured exposure of one agreement over a window. Platform counts come from the placements it holds (#501) and the follower table; provider figures come from
 * the signal ledger. Metrics a booked inventory kind should produce but that have no figures are listed under `missing` (never shown as zero).
 */
export async function exposureFor(c, d, { from, to }) {
  const w = windowOf(d, from, to);
  const out = [];
  const bookings = (await c.query(`SELECT b.id, u.kind, u.name FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.sponsorship_id=$1 AND b.status='confirmed'`, [d.id])).rows;
  const pl = (await c.query(`SELECT count(DISTINCT p.id)::int AS placements, coalesce(sum(x.impressions),0)::bigint AS impressions, coalesce(sum(x.clicks),0)::bigint AS clicks, count(DISTINCT x.day) FILTER (WHERE x.impressions > 0)::int AS days
      FROM event_sponsor_placements p LEFT JOIN placement_daily_counts x ON x.placement_id=p.id AND x.day BETWEEN $2::date AND $3::date WHERE p.sponsorship_id=$1`, [d.id, w.from ?? '0001-01-01', w.to ?? '9999-12-31'])).rows[0];
  if (pl.placements > 0) {
    out.push({ key: 'placement_impressions', value: Number(pl.impressions), days_with_data: pl.days, sources: ['Sportarena public pages'] });
    out.push({ key: 'placement_clicks', value: Number(pl.clicks), days_with_data: pl.days, sources: ['Sportarena public pages'] });
  }
  if (['event', 'team'].includes(d.target_type) || (d.target_type === 'athlete' && !(await isYouth(d.target_id, c)))) {
    const f = (await c.query(`SELECT count(*)::int AS n FROM spectator_follows WHERE subject_type=$1 AND subject_id=$2 AND removed_at IS NULL`, [d.target_type, d.target_id])).rows[0];
    out.push({ key: 'event_followers', value: f.n, days_with_data: null, sources: ['Sportarena followers (distinct accounts, now)'] });
  }
  const sig = (await c.query(`SELECT metric, sum(value)::bigint AS value, count(*)::int AS days, array_agg(DISTINCT source) AS sources FROM sponsor_exposure_signals
      WHERE sponsorship_id=$1 AND superseded_at IS NULL AND day BETWEEN $2::date AND $3::date GROUP BY metric ORDER BY metric`, [d.id, w.from ?? '0001-01-01', w.to ?? '9999-12-31'])).rows;
  for (const s of sig) out.push({ key: s.metric, value: Number(s.value), days_with_data: s.days, sources: s.sources });
  // broadcast reach: media-rights measurements recorded against deliverables that name this agreement (one source per deliverable and metric, first reporter wins)
  const mr = (await c.query(`WITH m AS (
      SELECT DISTINCT ON (x.deliverable_id, x.metric, x.source_ref, x.period_start::date, x.period_end::date) x.deliverable_id, x.metric, x.value, x.source_name, x.created_at
        FROM mr_measurements x JOIN mr_deliverables md ON md.id=x.deliverable_id
       WHERE md.sponsorship_id=$1 AND x.period_end::date >= $2::date AND x.period_start::date <= $3::date ORDER BY x.deliverable_id, x.metric, x.source_ref, x.period_start::date, x.period_end::date, x.created_at),
     first AS (SELECT DISTINCT ON (deliverable_id, metric) deliverable_id, metric, source_name FROM m ORDER BY deliverable_id, metric, created_at)
    SELECT m.metric, count(*)::int AS rows, sum(m.value)::bigint AS total, max(m.value)::bigint AS peak, array_agg(DISTINCT m.source_name) AS sources FROM m JOIN first f USING (deliverable_id, metric) WHERE m.source_name=f.source_name GROUP BY m.metric`, [d.id, w.from ?? '0001-01-01', w.to ?? '9999-12-31'])).rows;
  const MRK = { views: 'broadcast_views', impressions: 'broadcast_impressions', watch_minutes: 'broadcast_watch_minutes', unique_viewers: 'broadcast_unique_viewers', peak_concurrent: 'broadcast_peak_concurrent' };
  for (const r of mr) out.push({ key: MRK[r.metric], value: Number(['unique_viewers', 'peak_concurrent'].includes(r.metric) ? r.peak : r.total), days_with_data: null, sources: r.sources });
  const have = new Set(out.map((m) => m.key));
  const missing = [];
  for (const b of bookings) for (const k of EXPECTS[b.kind] ?? []) if (!have.has(k) && !missing.some((m) => m.metric === k && m.inventory === b.name)) {
    missing.push({ metric: k, inventory: b.name, reason: METRIC[k].basis === 'platform_measured' ? 'No placement on the public pages is linked to this booking yet' : 'No figures have been supplied by the provider yet' });
  }
  return { window: w, metrics: out.map((m) => ({ ...METRIC[m.key], ...m, definition: METRIC[m.key].definition })).map(({ key, label, unit, basis, period_bound, additive, definition, dedupe, value, days_with_data, sources }) => ({ key, label, unit, basis, period_bound, additive, definition, dedupe, value, days_with_data, sources })), missing, not_measured: NOT_MEASURED };
}

/** Derived state of a deliverable; "overdue" is the clock, "accepted" is only ever a reviewer's decision. */
export const deliverableState = (x) => (['accepted', 'excepted', 'cancelled'].includes(x.status) ? x.status : x.status === 'submitted' ? 'awaiting_review' : x.due_on < today() ? 'overdue' : x.status === 'rework' ? 'rework' : 'upcoming');

const MR_STATE = (d) => (d.status === 'verified' ? 'accepted' : d.status === 'delivered' ? 'awaiting_review' : d.status === 'missed' ? 'overdue' : d.due_at && new Date(d.due_at) < new Date() ? 'overdue' : 'upcoming');
/** Deliverable health = the agreement's own deliverables + the media-licence deliverables (media rights) that name it; one count, each source labelled. */
export async function deliverableHealth(c, sponsorshipId, { to = today() } = {}) {
  const own = (await c.query('SELECT status, due_on::text AS due_on FROM sponsorship_deliverables WHERE sponsorship_id=$1', [sponsorshipId])).rows;
  const mr = (await c.query('SELECT status, due_at FROM mr_deliverables WHERE sponsorship_id=$1', [sponsorshipId])).rows;
  const n = { total: own.length + mr.length, accepted: 0, awaiting_review: 0, overdue: 0, rework: 0, upcoming: 0, excepted: 0, cancelled: 0, media_licence_items: mr.length };
  for (const x of own) n[deliverableState(x)]++;
  for (const x of mr) n[MR_STATE(x)]++;
  const dueOwn = own.filter((x) => x.due_on <= to && !['cancelled', 'excepted'].includes(x.status));
  const dueMr = mr.filter((x) => x.due_at && new Date(x.due_at).toISOString().slice(0, 10) <= to);
  const accepted = dueOwn.filter((x) => x.status === 'accepted').length + dueMr.filter((x) => x.status === 'verified').length;
  const missed = dueOwn.filter((x) => x.status !== 'accepted' && x.due_on < today()).length + dueMr.filter((x) => x.status !== 'verified' && (x.status === 'missed' || new Date(x.due_at) < new Date())).length;
  return { ...n, due_to_date: dueOwn.length + dueMr.length, accepted_of_due: accepted, missed };
}

/** An assumption-based estimate: every line shows the measured figure, the customer's own rate and the version of the model. Never a fact, never without a model. */
export function estimateFrom(version, exposure, spend) {
  const lines = [];
  for (const [key, a] of Object.entries(version.assumptions)) {
    const m = exposure.metrics.find((x) => x.key === key);
    if (!m || !m.value) continue;
    lines.push({ metric: key, measured_value: m.value, measured_basis: m.basis, rate: `${a.value_cents} minor units per ${a.per === 1 ? 'unit' : `${a.per} units`}`, rate_cents: a.value_cents, rate_per: a.per, value_cents: Math.round((m.value / a.per) * a.value_cents) });
  }
  const total = lines.reduce((s, l) => s + l.value_cents, 0);
  const paid = (spend ?? []).find((t) => t.currency === version.currency);
  return {
    label: 'ESTIMATE — assumption-based, not a measured fact', kind: 'assumption_based',
    model: { id: version.model_id, name: version.name, version: version.version, version_id: version.id, currency: version.currency, basis_note: version.basis_note, assumptions: version.assumptions, configured_at: version.created_at },
    lines, estimated_value_cents: total, currency: version.currency,
    return_on_spend: paid && Number(paid.confirmed_cents) > 0 ? { confirmed_spend_cents: Number(paid.confirmed_cents), ratio: Number((total / Number(paid.confirmed_cents)).toFixed(4)), label: 'estimated value ÷ confirmed spend, both in ' + version.currency } : { note: 'No confirmed spend in this currency, so no ratio is shown.' },
    excluded: exposure.metrics.filter((m) => !version.assumptions[m.key]).map((m) => m.key),
  };
}

/** Everything the sponsor decides on, for one agreement, from canonical records only. `ctx` is an authorised dealContext. */
export async function agreementFacts(c, user, ctx, { from, to, view, version = null }) {
  const d = ctx.d;
  const w = windowOf(d, from ?? d.starts ?? '1970-01-01', to ?? today());
  const exposure = await exposureFor(c, d, { from: w.from, to: w.to });
  const fin = await through('list_sponsorship_obligations', user, { sponsorship_id: d.id, limit: 100, offset: 0 });
  const upcoming = fin.obligations.filter((o) => o.status === 'scheduled').slice(0, 5).map((o) => ({ id: o.id, kind: o.kind, due_on: o.due_on, amount_cents: o.amount_cents ?? null, currency: o.currency ?? null }));
  const dl = await deliverableHealth(c, d.id, { to: w.to ?? today() });
  const disputes = (await c.query("SELECT count(*) FILTER (WHERE status IN ('open','under_review','appealed'))::int AS open, count(*)::int AS total FROM sponsorship_disputes WHERE sponsorship_id=$1", [d.id])).rows[0];
  const renewal = (await c.query("SELECT id, status FROM sponsorships WHERE renews_id=$1 AND status NOT IN ('declined','withdrawn') LIMIT 1", [d.id])).rows[0] ?? null;
  const left = d.ends ? Math.round((Date.parse(`${d.ends}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 864e5) : null;
  const facts = {
    agreement: { id: d.id, ref: d.agreement_ref ?? null, status: d.status, sponsor: ctx.sp.name, beneficiary: await targetLabel(c, d), beneficiary_type: d.target_type, starts_on: d.starts ?? null, ends_on: d.ends ?? null, currency: d.currency ?? null, days_left: left },
    window: w,
    finance: { source: 'list_sponsorship_obligations (the finance truth; not recomputed here)', totals: fin.totals.map((t) => ({ currency: t.currency, committed_cents: Number(t.committed_cents), confirmed_cents: Number(t.confirmed_cents), reported_unverified_cents: Number(t.reported_unverified_cents), outstanding_cents: Number(t.outstanding_cents), overdue_cents: Number(t.overdue_cents) })), upcoming },
    deliverables: dl, exposure,
    disputes: { open: disputes.open, total: disputes.total },
    renewal: { renews_id: d.renews_id ?? null, successor: renewal, window_open: left != null && left <= 90 },
  };
  if (view === 'sponsor' && version) facts.valuation = estimateFrom(version, exposure, facts.finance.totals);
  return facts;
}

/** Recipient outcomes the sponsor is authorised to see: delegated to the performance review, so the athlete's live sharing switch and youth rules apply. */
export async function sharedOutcomes(user, d) {
  try {
    const p = await through('get_sponsorship_performance', user, { id: d.id });
    return { status: 'shared', scope: p.access?.scope ?? null, metrics: (p.metrics ?? []).length, objectives: (p.objectives ?? []).length, summary: p.metrics ?? [] };
  } catch (e) { return { status: 'not_shared', note: e.status === 403 || e.status === 409 ? 'The beneficiary has not shared results with this sponsor (or sharing has stopped).' : 'Results are not available.' }; }
}
