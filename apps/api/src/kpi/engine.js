// The semantic-layer engine (#596): resolves who may read a scope, runs a metric's single facts query, and returns the value together with its
// definition version, scope, period, freshness and data-quality warnings. REST, MCP, dashboards, exports and scheduled reports all call computeKpi,
// so the same metric for the same scope and period is the same figure everywhere, with the same traceable provenance.
import { createHash } from 'node:crypto';
import { pool, many, one } from '../db.js';
import { AppError, forbidden, notFound, unprocessable } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { orgRole, hasOrgGrant } from '../org-access.js';
import { canManageTeam, canCoachTeam } from '../capabilities/teams.js';
import { sponsorAccess, SPONSOR_ACTIONS } from '../sponsor-access.js';
import { blindIndex } from '../crypto.js';
import { authority, can, lineage, subtree } from '../federation.js';
import { AUDIENCES, METRICS, byKey, describeMetric, hashOf, AGE_BANDS, GENDERS, STANDING_LABELS } from './catalogue.js';

export const MAX_SPAN_DAYS = 731;
export const STALE_AFTER_DAYS = 45;
export const DIMENSIONS = {
  sport: { expr: 'f.sport_id', table: 'sports', name: 'name' },
  event: { expr: 'f.event_id', table: 'events', name: 'name' },
  venue: { expr: 'f.venue_id', table: 'venues', name: 'name' },
  team: { expr: 'f.team_id', table: 'teams', name: 'name' },
  month: { expr: "to_char(f.at, 'YYYY-MM')" },
  channel: { expr: 'f.channel' },
  // where it happened: the venue's city, else the event's city. Free text in the source, so it is trimmed and capitalised to group "mumbai " with "Mumbai".
  city: { expr: "initcap(btrim(coalesce((SELECT cv.city FROM venues cv WHERE cv.id = f.venue_id), (SELECT ce.city FROM events ce WHERE ce.id = f.event_id))))" },
  // census dimensions (#703): only the federation census metrics list them
  body: { expr: 'f.body_id', lookup: 'SELECT b.id::text AS id, o.name AS name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id = ANY($1::uuid[])' },
  club: { expr: 'f.org_id', table: 'organisations', name: 'name' },
  region: { expr: 'f.region' },
  age_band: { expr: 'f.age_band' },
  gender: { expr: 'f.gender' },
  status: { expr: 'f.status' },
};
const CHANNELS = { venue_booking: 'Venue bookings', academy: 'Academy fees', team: 'Team dues', marketplace: 'Marketplace', services: 'Services', pos: 'Point of sale', other: 'Other',
  // how a person arrived (activation, first activity)
  referral: 'Invited by a member', direct: 'Direct', search: 'Search', social: 'Social', partner: 'Partner', campaign: 'Campaign', email: 'Email', event: 'An event',
  // payment purposes (payment failure rate, provider earnings)
  coach_hire: 'Coaching sessions', marketplace_engagement: 'Marketplace engagements', shop_order: 'Shop orders', shop_checkout: 'Shop checkout', insurance_policy: 'Insurance', venue_invoice: 'Venue invoices', wallet_topup: 'Wallet top-ups',
  gift_card: 'Gift cards', venue_plan: 'Venue plans', appointment: 'Appointments', physio_package: 'Physio packages', sponsorship_payment: 'Sponsorship', academy_charge: 'Academy fees', service_invoice: 'Service invoices',
  media_rights_fee: 'Media rights', pos_sale: 'Point of sale', team_charge: 'Team dues', team_contribution: 'Team contributions', ad_funding: 'Advertising' };
// Labels for dimensions whose values are codes. The gender value is a keyed blind index, so a census can group by it without decrypting anything.
const genderLabels = () => ({ ...Object.fromEntries(GENDERS.map((g) => [blindIndex(`gender|${g.key}`), g.label])), not_stated: 'Not stated' });
const labelsFor = (dim) => (dim === 'channel' ? CHANNELS : dim === 'age_band' ? AGE_BANDS : dim === 'status' ? STANDING_LABELS : dim === 'gender' ? genderLabels() : null);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- definitions (append-only history)
/** Make sure every code definition has its version recorded. A changed definition under an unchanged version is a programming error and fails loudly. */
export async function syncCatalogue(c = pool) {
  const have = (await c.query('SELECT d.key, d.id, d.current_version, v.definition_hash FROM kpi_definitions d LEFT JOIN kpi_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version')).rows;
  const by = new Map(have.map((r) => [r.key, r]));
  for (const m of METRICS) {
    const hash = hashOf(m), cur = by.get(m.key);
    if (cur && cur.definition_hash === hash) continue;
    if (cur && cur.current_version >= m.version) throw new Error(`KPI "${m.key}" was changed without raising its version (v${cur.current_version}); bump version in kpi/catalogue.js`);
    const def = cur ?? (await c.query('INSERT INTO kpi_definitions(key) VALUES ($1) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING id, current_version', [m.key])).rows[0];
    const d = describeMetric(m);
    await c.query(
      `INSERT INTO kpi_definition_versions(definition_id, version, label, domain, unit, formula, dimensions, owner, provenance, audience, definition_hash, change_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [def.id, m.version, m.label, m.domain, m.unit, m.formula, m.dimensions, m.owner, JSON.stringify(d.provenance), m.audience, hash, cur ? `Version ${m.version}` : 'First published']);
    await c.query('UPDATE kpi_definitions SET current_version=GREATEST(current_version, $2) WHERE id=$1', [def.id, m.version]);
  }
}

export async function definitionHistory(key) {
  const m = byKey(key);
  if (!m) throw notFound('Metric');
  await syncCatalogue();
  return many(
    `SELECT v.version, v.label, v.domain, v.unit, v.formula, v.dimensions, v.owner, v.provenance, v.audience, v.definition_hash, v.change_note, v.published_at
       FROM kpi_definitions d JOIN kpi_definition_versions v ON v.definition_id=d.id WHERE d.key=$1 ORDER BY v.version DESC`, [key]);
}

// ---------------------------------------------------------------- period
export function resolveRange({ preset, from, to } = {}, anchor = today()) {
  const t = anchor;
  let r;
  if (preset === 'last_7') r = { from: addDays(t, -6), to: t };
  else if (preset === 'last_90') r = { from: addDays(t, -89), to: t };
  else if (preset === 'year_to_date') r = { from: `${t.slice(0, 4)}-01-01`, to: t };
  else if (preset === 'last_30' || (!from && !to)) r = { from: addDays(t, -29), to: t };
  else r = { from: from ?? addDays(to, -29), to: to ?? t };
  if (r.to < r.from) throw unprocessable('The end of the period is before its start');
  if ((new Date(r.to) - new Date(r.from)) / 864e5 > MAX_SPAN_DAYS) throw unprocessable(`A period can span at most ${MAX_SPAN_DAYS} days`);
  return r;
}

// ---------------------------------------------------------------- scope & authority
const VENUE_FINANCE = ['manager'];
/**
 * Resolve a scope the caller may read for this metric, read live. Anything the caller cannot see is a 404 (existence is not leaked) except where a
 * visible scope's role is too narrow for the metric, which is a 403 that says why.
 * @returns {Promise<{type:string,id:string|null,label:string,filters:object}>}
 */
export async function resolveScope(user, scope, metric) {
  const none = { events: [], venues: [], teams: [], org: null, all: false, sponsors: [], providers: [], bodies: [] };
  const type = scope?.type;
  if (!metric.scopes.includes(type)) throw unprocessable(`"${metric.label}" cannot be reported for a ${type ?? 'missing'} scope. It can be reported for: ${metric.scopes.join(', ')}.`, { scopes: metric.scopes });
  const roles = AUDIENCES[metric.audience];
  const narrow = (why) => forbidden(`${metric.label} is limited to ${why}. Ask the owner of this ${type} to give you that role.`);
  if (type === 'platform') {
    if (!isAdmin(user)) throw forbidden('Platform-wide figures are limited to the platform administrators');
    return { type, id: null, label: 'Whole platform', filters: { ...none, all: true } };
  }
  if (!scope.id && type !== 'provider') throw unprocessable(`Pick the ${type} to report on`);
  if (type === 'organisation') {
    const org = await one('SELECT id, name FROM organisations WHERE id=$1', [scope.id]);
    const role = org ? await orgRole(user, org.id) : null;
    if (!org || !role) throw notFound('Organisation');
    if (!roles.includes(role)) throw narrow(`${roles.join(', ')} roles`);
    return { type, id: org.id, label: org.name, filters: { ...none, org: org.id,
      events: (await many('SELECT id FROM events WHERE organisation_id=$1', [org.id])).map((r) => r.id),
      venues: (await many('SELECT id FROM venues WHERE organisation_id=$1', [org.id])).map((r) => r.id),
      teams: (await many('SELECT id FROM teams WHERE organisation_id=$1', [org.id])).map((r) => r.id) } };
  }
  if (type === 'venue') {
    const v = await one('SELECT id, name, owner_id, organisation_id FROM venues WHERE id=$1', [scope.id]);
    const staff = v ? await one('SELECT role FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [v.id, user.id]) : null;
    const ok = v && (isAdmin(user) || v.owner_id === user.id || staff || (await hasOrgGrant(user, v.organisation_id, roles)));
    if (!ok) throw notFound('Venue');
    if (metric.audience === 'finance' && !(isAdmin(user) || v.owner_id === user.id || VENUE_FINANCE.includes(staff?.role) || (await hasOrgGrant(user, v.organisation_id, roles)))) throw narrow('the venue owner and managers');
    return { type, id: v.id, label: v.name, filters: { ...none, venues: [v.id] } };
  }
  if (type === 'event') {
    const e = await one('SELECT id, name, organizer_id, organisation_id FROM events WHERE id=$1', [scope.id]);
    const ok = e && (isAdmin(user) || e.organizer_id === user.id || (await hasOrgGrant(user, e.organisation_id, roles)));
    if (!ok) throw notFound('Event');
    return { type, id: e.id, label: e.name, filters: { ...none, events: [e.id] } };
  }
  if (type === 'team') {
    const t = await one('SELECT * FROM teams WHERE id=$1', [scope.id]);
    if (!t) throw notFound('Team');
    const ok = metric.audience === 'squad' ? await canCoachTeam(user, t) : await canManageTeam(user, t);
    if (!ok) { if (await canCoachTeam(user, t)) throw narrow('team managers'); throw notFound('Team'); }
    return { type, id: t.id, label: t.name, filters: { ...none, teams: (await many('SELECT id FROM teams WHERE id=$1 OR parent_team_id=$1', [t.id])).map((r) => r.id) } };
  }
  if (type === 'provider') {
    // a person's own earnings: the scope is always the caller, so there is nothing to look up and nothing to leak about anyone else
    if (scope.id && scope.id !== user.id) throw notFound('Provider');
    return { type, id: user.id, label: 'My earnings as a provider', filters: { ...none, providers: [user.id] } };
  }
  if (type === 'sponsor') {
    const sp = await one('SELECT * FROM sponsors WHERE id=$1', [scope.id]);
    const acc = sp ? await sponsorAccess(user, sp) : null;
    if (!sp || (!isAdmin(user) && !acc)) throw notFound('Brand');
    if (!isAdmin(user)) {
      if (!SPONSOR_ACTIONS.report.includes(acc.role)) throw narrow('brand managers, finance, approvers and auditors');
      if (acc.departmentId) throw forbidden('Department-scoped members read the Sponsorship reports for their department; brand-wide analytics need a brand-wide role');
    }
    return { type, id: sp.id, label: sp.name, filters: { ...none, sponsors: [sp.id] } };
  }
  if (type === 'federation') {
    const a = await authority(user, scope.id, { optional: true });
    if (!a) throw notFound('Governing body');
    // census figures are person-level counts: they need a body-wide reports role (not limited to a sport or a jurisdiction), read live, held on this body
    // or on a body above it (whoever may read a federation may read any part of it)
    if (!(await censusRole(user, a.body.id))) throw forbidden(`${metric.label} needs a reports role on ${a.body.name}, or on a body above it, that covers every sport and jurisdiction. Ask the body's administrator for it.`);
    return { type, id: a.body.id, label: a.body.name, filters: { ...none, bodies: await subtree(a.body.id) } };
  }
  throw unprocessable('Unknown scope type');
}
const NO_SPORT = '00000000-0000-0000-0000-000000000000';   // a sport no role is limited to: only a role that covers every sport passes can() with it
/** Does the caller hold a body-wide reports role on this body or any body above it? Read live, one authority check per body on the path up. */
async function censusRole(user, bodyId) {
  for (const id of await lineage(bodyId)) { const a = await authority(user, id, { optional: true }); if (a && !a.viaAncestor && can(a, 'reports', NO_SPORT)) return true; }
  return false;
}

/** Everything the caller could pick in the scope picker, for any metric. A scope is listed when at least one governed metric is readable there. */
export async function listScopes(user) {
  const out = [];
  if (isAdmin(user)) out.push({ type: 'platform', id: null, label: 'Whole platform', sub: 'Platform administrators' });
  const orgs = await many(`SELECT o.id, o.name, m.role FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 AND m.status='active' AND o.status='active' ORDER BY o.name`, [user.id]);
  for (const o of orgs) out.push({ type: 'organisation', id: o.id, label: o.name, sub: `Organisation · ${o.role}` });
  const venues = await many(
    `SELECT DISTINCT v.id, v.name, v.city FROM venues v LEFT JOIN venue_staff s ON s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL
      WHERE v.owner_id=$1 OR s.user_id IS NOT NULL ORDER BY v.name`, [user.id]);
  for (const v of venues) out.push({ type: 'venue', id: v.id, label: v.name, sub: `Venue${v.city ? ` · ${v.city}` : ''}` });
  const events = await many('SELECT id, name, status FROM events WHERE organizer_id=$1 AND archived_at IS NULL ORDER BY starts_on DESC NULLS LAST, name LIMIT 100', [user.id]);
  for (const e of events) out.push({ type: 'event', id: e.id, label: e.name, sub: `Event · ${e.status}` });
  const teams = await many(
    `SELECT DISTINCT t.id, t.name FROM teams t LEFT JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager','coach')
      WHERE t.archived_at IS NULL AND (t.owner_id=$1 OR m.user_id IS NOT NULL) ORDER BY t.name LIMIT 100`, [user.id]);
  for (const t of teams) out.push({ type: 'team', id: t.id, label: t.name, sub: 'Team' });
  const earns = await one('SELECT 1 AS x FROM coach_hires WHERE coach_id=$1 UNION ALL SELECT 1 FROM marketplace_engagements WHERE provider_id=$1 LIMIT 1', [user.id]);
  if (earns || user.roles?.some((r) => ['coach', 'physio', 'doctor', 'supplier', 'venue_manager'].includes(r))) out.push({ type: 'provider', id: user.id, label: 'My earnings as a provider', sub: 'Only you can see this' });
  const brands = await many('SELECT id, name FROM sponsors ORDER BY name LIMIT 500');
  for (const b of brands) {
    if (isAdmin(user)) { out.push({ type: 'sponsor', id: b.id, label: b.name, sub: 'Brand' }); continue; }
    const acc = await sponsorAccess(user, await one('SELECT * FROM sponsors WHERE id=$1', [b.id]));
    if (acc && !acc.departmentId && SPONSOR_ACTIONS.report.includes(acc.role)) out.push({ type: 'sponsor', id: b.id, label: b.name, sub: `Brand · ${acc.repRole}` });
  }
  // governing bodies where the caller holds a census-capable reports role (checked live with the same rule as resolveScope)
  const bodies = await many(
    `SELECT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id
      WHERE EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))
         OR EXISTS (SELECT 1 FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$1 AND r.status='active')
         OR EXISTS (SELECT 1 FROM fed_delegations d WHERE d.body_id=b.id AND d.user_id=$1 AND d.status='active')
      ORDER BY o.name LIMIT 100`, [user.id]);
  for (const b of bodies) { if (await censusRole(user, b.id)) out.push({ type: 'federation', id: b.id, label: b.name, sub: 'Governing body' }); }
  return out;
}

// ---------------------------------------------------------------- SQL
// $10 is the governing-body scope (census metrics); $11 the provider scope, used only by a metric whose facts carry provider_id (the provider's own earnings), so other metrics' SQL is unchanged.
const PRED_BASE = `($5::boolean OR f.event_id = ANY($1::uuid[]) OR f.venue_id = ANY($2::uuid[]) OR f.team_id = ANY($3::uuid[]) OR f.org_id = $4::uuid OR f.sponsor_id = ANY($9::uuid[]) OR f.body_id = ANY($10::uuid[])`;
const predFor = (m) => `${PRED_BASE}${m.facts().includes('AS provider_id') ? ' OR f.provider_id = ANY($11::uuid[])' : ''})
  AND ($8::uuid[] IS NULL OR f.sport_id = ANY($8::uuid[])) AND $6::date IS NOT NULL AND $7::date IS NOT NULL AND $11::uuid[] IS NOT NULL`;
const params = (scope, range, sportIds) => [scope.filters.events, scope.filters.venues, scope.filters.teams, scope.filters.org, scope.filters.all, range.from, range.to, sportIds?.length ? sportIds : null, scope.filters.sponsors, scope.filters.bodies, scope.filters.providers];
/** Every metric's facts get a body_id column; only the census metrics fill it, so a body scope never reaches another metric's rows (and no existing definition changes). */
const factsOf = (m) => (m.census ? m.facts() : `SELECT x.*, NULL::uuid AS body_id FROM (${m.facts()}) x`);

function aggSql(m) {
  if (m.aggregation === 'distinct_count') return 'count(DISTINCT subject)::int AS value';
  if (m.aggregation === 'count') return 'count(*)::int AS value';
  if (m.aggregation === 'sum_money') return 'sum(amount)::bigint AS value';
  return 'sum(num)::float8 AS num, sum(den)::float8 AS den';
}

async function nameOf(dim, ids) {
  const d = DIMENSIONS[dim];
  if (!d?.table && !d?.lookup) return new Map();
  const rows = await many(d.lookup ?? `SELECT id::text AS id, ${d.name} AS name FROM ${d.table} WHERE id = ANY($1::uuid[])`, [ids.filter(Boolean)]);
  return new Map(rows.map((r) => [r.id, r.name]));
}
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

/**
 * Compute a governed metric.
 * @param {object|null} user the caller (access is checked here, live)
 * @param {string} key metric key
 * @param {{scope:{type:string,id?:string}, range?:{preset?:string,from?:string,to?:string}, sport_ids?:string[], group_by?:string}} q
 */
export async function computeKpi(user, key, q) {
  const m = byKey(key);
  if (!m) throw notFound('Metric');
  if (q.group_by && !m.dimensions.includes(q.group_by)) throw unprocessable(`"${m.label}" cannot be split by ${q.group_by}. Available: ${m.dimensions.join(', ')}.`, { dimensions: m.dimensions });
  await syncCatalogue();
  const scope = await resolveScope(user, q.scope, m);
  const range = m.pointInTime ? { from: today(), to: today() } : resolveRange(q.range, q.as_of);
  const sportIds = q.sport_ids ?? [];
  if (m.noSportFilter && sportIds.length) throw unprocessable(`"${m.label}" cannot be limited to a sport: someone who has not yet played has no sport.`);
  const p = params(scope, range, sportIds);
  const g = q.group_by ? DIMENSIONS[q.group_by].expr : null;
  const money = m.aggregation === 'sum_money';
  const cur = money ? ', f.currency AS currency' : '';
  const agg = aggSql(m);
  const sql = `WITH f AS MATERIALIZED (${factsOf(m)}), s AS MATERIALIZED (SELECT f.* FROM f WHERE ${predFor(m)})
    SELECT 'total' AS k, to_jsonb(x) AS j FROM (SELECT ${money ? 'currency, ' : ''}${agg}, count(*)::int AS records FROM s ${money ? 'GROUP BY currency' : ''}) x
    ${g ? `UNION ALL SELECT 'group', to_jsonb(y) FROM (SELECT ${g.replaceAll('f.', 's.')} AS g${money ? ', currency' : ''}, ${agg}, count(*)::int AS records FROM s GROUP BY 1${money ? ', 2' : ''}) y` : ''}
    UNION ALL SELECT 'src', to_jsonb(z) FROM (SELECT rec_kind, count(*)::int AS n, max(at) AS latest FROM s GROUP BY rec_kind) z
    UNION ALL SELECT 'flag', to_jsonb(w) FROM (SELECT flag, count(*)::int AS n FROM s WHERE flag IS NOT NULL GROUP BY flag) w
    UNION ALL SELECT 'cur', to_jsonb(c) FROM (SELECT DISTINCT currency FROM s WHERE currency IS NOT NULL) c`;
  const rows = (await pool.query(sql, p)).rows;
  const of = (k) => rows.filter((r) => r.k === k).map((r) => r.j);
  const suppress = (num, den) => m.minGroup && scope.type !== 'team' && den < m.minGroup;

  const shape = (rs) => {
    if (money) return { amounts: rs.filter((r) => r.value != null).map((r) => ({ currency: r.currency, cents: Number(r.value) })).sort((a, b) => a.currency.localeCompare(b.currency)), records: rs.reduce((a, r) => a + r.records, 0) };
    if (m.aggregation === 'ratio') {
      const r = rs[0] ?? { num: 0, den: 0, records: 0 };
      const hide = suppress(r.num ?? 0, r.den ?? 0);
      return { value: hide ? null : pct(r.num ?? 0, r.den ?? 0), numerator: hide ? null : r.num ?? 0, denominator: hide ? null : r.den ?? 0, suppressed: !!hide && (r.den ?? 0) > 0, records: r.records };
    }
    return { value: rs[0]?.value ?? 0, records: rs[0]?.records ?? 0 };
  };
  let total = shape(of('total'));

  let groups;
  if (g) {
    const byG = new Map();
    for (const r of of('group')) (byG.get(r.g ?? null) ?? byG.set(r.g ?? null, []).get(r.g ?? null)).push(r);
    const names = await nameOf(q.group_by, [...byG.keys()]), labels = labelsFor(q.group_by);
    groups = [...byG.entries()].map(([k, rs]) => ({ key: k, label: k == null ? 'Not attributed' : labels ? labels[k] ?? 'Not stated' : q.group_by === 'month' || q.group_by === 'region' || q.group_by === 'city' ? k : names.get(String(k)) ?? 'Unavailable', ...shape(rs) }))
      .sort((a, b) => (q.group_by === 'month' ? String(a.key).localeCompare(String(b.key)) : (b.value ?? b.amounts?.[0]?.cents ?? 0) - (a.value ?? a.amounts?.[0]?.cents ?? 0)));
  }

  // Small-cell suppression for person counts (#703): a count of 1 to minCell-1 is hidden, and when exactly one group is hidden the smallest visible one goes
  // with it, so a hidden figure cannot be recovered by subtraction. Federation staff see aggregates only, so this applies in every scope.
  let anySuppressed = false;
  if (m.minCell && m.aggregation === 'distinct_count') {
    const hide = (x) => ({ ...x, value: null, records: null, suppressed: true });
    const small = (x) => x.value > 0 && x.value < m.minCell;
    if (small(total)) total = hide(total);
    if (groups) {
      groups = groups.map((x) => (small(x) ? hide(x) : x));
      if (groups.filter((x) => x.suppressed).length === 1 && !total.suppressed) {
        const next = groups.filter((x) => !x.suppressed && x.value > 0).sort((a, b) => a.value - b.value)[0];
        if (next) groups[groups.indexOf(next)] = hide(next);
      }
    }
    anySuppressed = !!total.suppressed || !!groups?.some((x) => x.suppressed);
  }

  const now = Date.now();
  const sources = m.sources.map((s) => {
    const r = of('src').find((x) => x.rec_kind === s.key);
    const latest = r?.latest ?? null;
    const age = latest ? Math.floor((now - new Date(latest).getTime()) / 864e5) : null;
    const open = range.to >= addDays(today(), -1);
    const status = !r ? 'no_records' : open && age > STALE_AFTER_DAYS ? 'stale' : 'current';
    return { key: s.key, label: s.label, records: m.minCell && total.suppressed ? null : r?.n ?? 0, latest_at: m.minCell && total.suppressed ? null : latest, age_days: m.minCell && total.suppressed ? null : age, status };
  });
  const warnings = [];
  if (!sources.some((s) => s.records)) warnings.push({ code: 'no_records', severity: 'info', text: m.pointInTime ? 'There are no records for this scope yet.' : 'No source records fall in this period for this scope, so the figure is a true zero or the data has not been entered.' });
  for (const s of sources) if (s.status === 'stale') warnings.push({ code: 'stale', severity: 'warn', text: `${s.label}: the newest record is ${s.age_days} days old. Check that the source is still being updated.` });
  for (const f of of('flag')) warnings.push({ code: f.flag, severity: 'warn', text: `${f.n} ${f.n === 1 ? 'record is' : 'records are'} ${m.flags[f.flag] ?? f.flag}.`, records: f.n });
  if (money && of('cur').length > 1) warnings.push({ code: 'multiple_currencies', severity: 'info', text: `${of('cur').length} currencies are present. They are shown apart and never added together.` });
  if (g && m.aggregation === 'distinct_count' && q.group_by !== 'month') warnings.push({ code: 'groups_overlap', severity: 'info', text: 'A person or game in more than one group is counted in each, so the groups can add up to more than the total.' });
  if (total.suppressed || groups?.some((x) => x.suppressed)) warnings.push({ code: 'suppressed', severity: 'info', text: m.minCell ? `Counts of fewer than ${m.minCell} people are hidden, and the next smallest figure with them, so no one can be picked out.` : `Groups with fewer than ${m.minGroup} athletes are hidden to protect individuals. Open a team you manage to see its squad.` });
  if (m.pointInTime) warnings.push({ code: 'point_in_time', severity: 'info', text: 'This is a position as of now; the period filter does not apply.' });

  const evidence = {
    metric: { key: m.key, version: m.version, definition_hash: hashOf(m) },
    scope: { type: scope.type, id: scope.id, label: scope.label }, range, sport_ids: sportIds, group_by: q.group_by ?? null,
    computed_at: new Date().toISOString(),
  };
  const reference = createHash('sha256').update(JSON.stringify([evidence.metric, evidence.scope, range, sportIds.slice().sort(), q.group_by ?? null])).digest('hex').slice(0, 16);
  const digest = createHash('sha256').update(JSON.stringify([total.value ?? null, total.amounts ?? null, total.numerator ?? null, total.denominator ?? null])).digest('hex').slice(0, 12);
  return { definition: describeMetric(m), ...evidence, reference, digest, unit: m.unit, ...total, groups: groups ?? null, sources, warnings };
}

/** The same figure for other modules to quote (guarded by the same live authority). */
export const kpiValue = computeKpi;

/** Drill-down: the records behind a figure, from the very same facts query. */
export async function kpiRecords(user, key, q, { limit = 25, offset = 0 } = {}) {
  const m = byKey(key);
  if (!m) throw notFound('Metric');
  if (m.drillScopes && !m.drillScopes.includes(q.scope?.type)) throw forbidden(m.drillNote ?? `Individual records for "${m.label}" are only available inside a team you manage; elsewhere it is an aggregate.`);
  if (q.group_by && !m.dimensions.includes(q.group_by)) throw unprocessable(`"${m.label}" cannot be split by ${q.group_by}`);
  const scope = await resolveScope(user, q.scope, m);
  const range = m.pointInTime ? { from: today(), to: today() } : resolveRange(q.range, q.as_of);
  const p = params(scope, range, q.sport_ids ?? []);
  const g = q.group_by ? DIMENSIONS[q.group_by].expr.replaceAll('f.', 's.') : null;
  const where = [g && q.group_key !== undefined ? (q.group_key === null || q.group_key === '' ? `${g} IS NULL` : `${g}::text = $13`) : null, q.currency ? '(s.currency = $14)' : null].filter(Boolean);
  const args = [...p, limit, offset, ...(g && q.group_key ? [q.group_key] : [null]), q.currency ?? null];
  const sql = `WITH f AS MATERIALIZED (${factsOf(m)}), s AS MATERIALIZED (SELECT f.* FROM f WHERE ${predFor(m)}), t AS (SELECT s.* FROM s ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
    SELECT 'row' AS k, to_jsonb(r) AS j FROM (SELECT rec_id, rec_kind, label, at, currency, amount, num, den, flag, channel, link_kind, link_id FROM t ORDER BY at DESC NULLS LAST, rec_id LIMIT $11 OFFSET $12) r
    UNION ALL SELECT 'sum', to_jsonb(q) FROM (SELECT count(*)::int AS records, count(DISTINCT subject)::int AS distinct_subjects, sum(num)::float8 AS num, sum(den)::float8 AS den FROM t) q
    UNION ALL SELECT 'money', to_jsonb(c) FROM (SELECT currency, sum(amount)::bigint AS cents FROM t WHERE currency IS NOT NULL GROUP BY currency ORDER BY currency) c
    UNION ALL SELECT 'arg', to_jsonb(a) FROM (SELECT $13::text AS a, $14::text AS b) a`;
  const rows = (await pool.query(sql, args)).rows;
  const sum = rows.find((r) => r.k === 'sum').j;
  return {
    metric: { key: m.key, version: m.version, label: m.label, unit: m.unit }, scope: { type: scope.type, id: scope.id, label: scope.label }, range,
    records: rows.filter((r) => r.k === 'row').map((r) => ({ ...r.j, flag_text: r.j.flag ? m.flags[r.j.flag] : null })),
    total_records: sum.records, distinct_subjects: sum.distinct_subjects,
    reconciles_to: m.aggregation === 'distinct_count' ? { distinct_subjects: sum.distinct_subjects } : m.aggregation === 'sum_money' ? { amounts: rows.filter((r) => r.k === 'money').map((r) => ({ currency: r.j.currency, cents: Number(r.j.cents) })) } : { numerator: sum.num ?? 0, denominator: sum.den ?? 0, value: pct(sum.num ?? 0, sum.den ?? 0) },
    limit, offset,
  };
}

export const isAppError = (e) => e instanceof AppError;
