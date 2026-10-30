// Compliance policy layer (#568), on top of the compliance platform (#595). The platform says WHAT is required (a requirement), of WHOM (an obligation)
// and what has been provided (a record). This layer adds the facts a rule can depend on and the order in which rules rank:
//
//   * Applicability: an obligation may name a country, state or province, municipality, governing bodies, competitions, venues, event types and an age band.
//     Each is checked against FACTS read live from the event, venue, organisation and person. A dimension the facts cannot answer makes the rule UNKNOWN,
//     never silently "does not apply". A kind of subject that has no such fact (an event has no age) is "does not apply".
//   * Precedence: requirements of the same TOPIC compete. The highest classification wins (legal > regulatory > federation mandated > contractual >
//     organisation policy > recommended standard), then the narrower jurisdiction (municipality > state or province > country), then the more specific
//     applicability, then the later effective date, then the higher version. Topics that differ add up. A higher-ranked rule that is UNKNOWN is never skipped.
//   * Effective dates: an obligation is in force between its starts_on and ends_on (a repeal is an end date); the requirement text in force on a date is the
//     version saved on or before it. Nothing is deleted, so an old date gives the rules of that time.
//   * Statuses for dashboards: compliant, expiring, pending, missing, exception, non-compliant, plus unknown.
// Pure functions first (no database), then the fact resolver.
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { ageOf } from './youth.js';
import { engagementsOf } from './accreditation.js';

export const CLASSIFICATIONS = ['legal_mandatory', 'regulatory', 'federation_mandated', 'contractual', 'organisation_policy', 'recommended_standard'];
export const CLASS_RANK = { legal_mandatory: 6, regulatory: 5, federation_mandated: 4, contractual: 3, organisation_policy: 2, recommended_standard: 1 };
export const CLASS_LABEL = {
  legal_mandatory: 'Legal (mandatory)', regulatory: 'Regulatory', federation_mandated: 'Federation mandated', contractual: 'Contractual', organisation_policy: 'Organisation policy', recommended_standard: 'Recommended standard',
};
/** Who may author which class. Laws and regulations only the platform team (and a second administrator approves them); federation rules are a governing body's own. */
export const SCOPE_CLASSES = {
  platform: ['legal_mandatory', 'regulatory', 'organisation_policy', 'contractual', 'recommended_standard'],
  body: ['federation_mandated', 'contractual', 'recommended_standard'],
  organisation: ['organisation_policy', 'contractual', 'recommended_standard'],
  event: ['organisation_policy', 'contractual', 'recommended_standard'],
};
export const DEFAULT_CLASS = { platform: 'organisation_policy', body: 'federation_mandated', organisation: 'organisation_policy', event: 'organisation_policy' };
/** A law or a regulation takes effect only after a second platform administrator approves it, and is never waivable. */
export const NEEDS_SECOND_APPROVER = ['legal_mandatory', 'regulatory'];
export const OUTCOMES = ['applies', 'does_not_apply', 'unknown', 'exception_required'];
export const STATUSES = ['compliant', 'expiring', 'pending', 'missing', 'exception', 'non_compliant', 'unknown'];
export const EVENT_TYPES = ['tournament', 'league', 'friendly', 'camp', 'trial'];
/** Packs are designed for these first; any ISO country works the same way (a pack is a set of rules, so a new country needs no code). */
export const FIRST_JURISDICTIONS = [
  { code: 'IN', name: 'India' }, { code: 'US', name: 'United States' }, { code: 'CA', name: 'Canada' }, { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' }, { code: 'LK', name: 'Sri Lanka' }, { code: 'AU', name: 'Australia' }, { code: 'GB', name: 'United Kingdom' },
];

/** The dashboard status of a platform state. */
export const STATUS_OF = {
  met: 'compliant', expiring: 'expiring', grace: 'expiring', pending_review: 'pending', missing: 'missing', waived: 'exception',
  expired: 'non_compliant', rejected: 'non_compliant', revoked: 'non_compliant', unknown: 'unknown',
};
export const statusCounts = (items) => {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1;
  return out;
};

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** The dimensions an obligation names beyond roles and sport. */
export const namesDimension = (o) => !!(o.ob_country || o.ob_region || o.ob_municipality || o.body_ids?.length || o.competition_ids?.length || o.venue_ids?.length || o.event_types?.length || o.min_age != null || o.max_age != null);

/**
 * Does this obligation apply to these facts? `na` lists the facts a kind of subject cannot have (an event has no age).
 * Returns { result: 'yes' | 'no' | 'unknown', no: [labels], unknown: [labels] }.
 */
export function applicability(o, facts, na = []) {
  const no = [], unknown = [];
  for (const [col, key, label] of [['ob_country', 'country', 'country'], ['ob_region', 'region', 'state or province'], ['ob_municipality', 'municipality', 'municipality']]) {
    if (!o[col]) continue;
    const have = facts[key];
    if (have == null || have === '') unknown.push(label);
    else if (norm(have) !== norm(o[col])) no.push(label);
  }
  for (const [col, key, label] of [['body_ids', 'federation_ids', 'federation'], ['competition_ids', 'event_id', 'competition'], ['venue_ids', 'venue_id', 'venue'], ['event_types', 'event_type', 'event type']]) {
    const want = (o[col] ?? []).map(norm);
    if (!want.length) continue;
    const raw = facts[key];
    if (raw == null) { if (na.includes(key)) no.push(label); else unknown.push(label); continue; }
    const have = [].concat(raw).filter((x) => x != null && x !== '').map(norm);
    if (!have.length || !have.some((x) => want.includes(x))) no.push(label);
  }
  if (o.min_age != null || o.max_age != null) {
    if (na.includes('age')) no.push('age');
    else if (facts.age == null) unknown.push('age');
    else if ((o.min_age != null && facts.age < o.min_age) || (o.max_age != null && facts.age > o.max_age)) no.push('age');
  }
  return no.length ? { result: 'no', no, unknown } : unknown.length ? { result: 'unknown', no, unknown } : { result: 'yes', no, unknown };
}

const specificity = (o) => (o.ob_municipality ? 3 : o.ob_region ? 2 : o.ob_country ? 1 : 0);
const narrowing = (o) => [o.ob_country, o.ob_region, o.ob_municipality, o.min_age, o.max_age].filter((x) => x != null && x !== '').length
  + [o.body_ids, o.competition_ids, o.venue_ids, o.event_types, o.ob_roles].filter((a) => a?.length).length + (o.ob_sport_id ? 1 : 0);
/** Negative when `a` outranks `b`: classification, then narrower jurisdiction, then more specific applicability, then the later effective date, then the higher version. */
export const byPrecedence = (a, b) =>
  (CLASS_RANK[b.classification] - CLASS_RANK[a.classification]) || (specificity(b) - specificity(a)) || (narrowing(b) - narrowing(a))
  || String(b.starts_on).localeCompare(String(a.starts_on)) || (b.version - a.version) || String(a.ob_id).localeCompare(String(b.ob_id));

/**
 * Settle the topics. `rows` are obligations that could apply (policy result yes or unknown). Within a topic, only the highest-ranked requirement stays;
 * the others are superseded. If the winner is unknown, the others are unknown too (we cannot tell yet which of them governs). Two obligations of the
 * SAME requirement never compete. Returns { kept, superseded: [{ row, by }] }.
 */
export function settleTopics(rows) {
  const kept = [], superseded = [];
  const groups = new Map();
  for (const r of rows) {
    if (!r.topic) { kept.push(r); continue; }
    (groups.get(r.topic) ?? groups.set(r.topic, []).get(r.topic)).push(r);
  }
  for (const list of groups.values()) {
    list.sort(byPrecedence);
    const win = list[0];
    for (const r of list) {
      if (r.id === win.id) { kept.push(r); continue; }       // the winner's other obligations stay with it
      if (win.policy.result === 'unknown') { kept.push({ ...r, policy: { ...r.policy, result: 'unknown', unknown: [...new Set([...r.policy.unknown, ...win.policy.unknown])], dependsOn: win } }); continue; }
      superseded.push({ row: r, by: win });
    }
  }
  return { kept, superseded };
}

// ---------------------------------------------------------------- facts (read live, each says where it came from)
const addressOf = async (c, kind, id) => (id ? (await c.query(
  'SELECT country, region, locality FROM addresses WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1', [kind, id])).rows[0] ?? null : null);

/** Where something is: the venue's address, else the organisation's, else what the event itself says. */
async function placeFacts(c, { venue_id, organisation_id, region, city }, facts, sources) {
  const v = await addressOf(c, 'venue', venue_id), o = v?.country ? null : await addressOf(c, 'organisation', organisation_id);
  const a = v?.country ? v : o ?? v;
  const from = v?.country ? 'venue address' : o ? 'organisation address' : 'venue address';
  if (a?.country && !facts.country) { facts.country = String(a.country).toUpperCase(); sources.country = from; }
  if ((a?.region || region) && !facts.region) { facts.region = a?.region ?? region; sources.region = a?.region ? from : 'event record'; }
  if ((a?.locality || city) && !facts.municipality) { facts.municipality = a?.locality ?? city; sources.municipality = a?.locality ? from : 'event record'; }
}

async function bodiesOf(c, orgId, eventId) {
  const ids = new Set();
  if (eventId) for (const r of (await c.query("SELECT DISTINCT body_id FROM fed_sanctions WHERE event_id=$1 AND status='approved'", [eventId])).rows) ids.add(r.body_id);
  if (orgId) for (const r of (await c.query("SELECT DISTINCT body_id FROM fed_affiliations WHERE organisation_id=$1 AND status IN ('approved','suspended')", [orgId])).rows) ids.add(r.body_id);
  return [...ids];
}

/**
 * The facts a rule can depend on for this subject in this context ({ event_id, tender_id, organisation_id, venue_id }). Pure reads; the one personal
 * read (date of birth, for an age band) is audit-logged and only the age in years on the as-of date is kept.
 * Returns { values, sources, na, start, end }.
 */
export async function factsFor(c, subject, ctx = {}, { asOf = null, actor = null } = {}) {
  const values = {}, sources = {};
  let start = null, end = null, eventRow = null;
  const withEvent = async (eventId) => {
    const e = (await c.query('SELECT e.*, s.slug AS sport_slug, e.starts_on::text AS d0, e.ends_on::text AS d1 FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId])).rows[0];
    if (!e) return;
    eventRow = e; start ??= e.d0; end ??= e.d1 ?? e.d0;
    values.event_id = e.id; values.event_type = e.kind; values.sport = e.sport_slug; sources.event_type = sources.sport = 'event record';
    if (e.organisation_id && !values.organisation_id) { values.organisation_id = e.organisation_id; sources.organisation_id = 'event record'; }
    if (e.venue_id && !values.venue_id) { values.venue_id = e.venue_id; sources.venue_id = 'event record'; }
    await placeFacts(c, { venue_id: e.venue_id, organisation_id: e.organisation_id, region: e.region, city: e.city }, values, sources);
    const bodies = await bodiesOf(c, e.organisation_id, e.id);
    if (bodies.length) { values.federation_ids = bodies; sources.federation_ids = 'sanctions and affiliations'; }
  };
  const withTender = async (tenderId) => {
    const p = (await c.query('SELECT *, service_start::text AS d0, service_end::text AS d1 FROM proc_projects WHERE id=$1', [tenderId])).rows[0];
    if (!p) return;
    start ??= p.d0; end ??= p.d1 ?? p.d0;
    if (p.event_id) await withEvent(p.event_id);
    if (p.organisation_id && !values.organisation_id) { values.organisation_id = p.organisation_id; sources.organisation_id = 'tender record'; }
    if (p.venue_id && !values.venue_id) { values.venue_id = p.venue_id; sources.venue_id = 'tender record'; }
    await placeFacts(c, { venue_id: p.venue_id, organisation_id: p.organisation_id }, values, sources);
    if (p.organisation_id && !values.federation_ids) { const b = await bodiesOf(c, p.organisation_id, null); if (b.length) { values.federation_ids = b; sources.federation_ids = 'affiliations'; } }
  };

  if (ctx.event_id) await withEvent(ctx.event_id);
  if (ctx.tender_id) await withTender(ctx.tender_id);
  if (subject.kind === 'event') {
    await withEvent(subject.id);
  } else if (subject.kind === 'organisation') {
    if (!values.organisation_id) { values.organisation_id = subject.id; sources.organisation_id = 'organisation record'; }
    // a supplier or organisation judged in a tender or event is placed where the tender or event is; on its own, where its own address is
    if (!values.country) await placeFacts(c, { organisation_id: subject.id }, values, sources);
  } else if (subject.kind === 'person') {
    const u = (await c.query('SELECT id, dob_enc FROM users WHERE id=$1', [subject.id])).rows[0];
    const ref = asOf ?? start ?? new Date().toISOString().slice(0, 10);
    if (u?.dob_enc) {
      await audit(c, actor?.id ?? null, 'read_dob_compliance', 'users', u.id);
      values.age = ageOf(decrypt(u.dob_enc, 'users.dob'), new Date(`${ref}T12:00:00Z`)); sources.age = 'date of birth on file (only the age is kept)';
    }
    if (eventRow) { const eng = [...await engagementsOf(c, eventRow, subject.id)]; values.roles = eng; sources.roles = 'event engagements'; }
  }
  if (!values.country && /^[A-Za-z]{2}$/.test(ctx.country_hint ?? '')) { values.country = ctx.country_hint.toUpperCase(); sources.country = 'supplier record'; }
  const na = subject.kind === 'person' ? [] : ['age'];
  return { values, sources, na, start, end };
}

// ---------------------------------------------------------------- explanation
/** A deterministic plain-language explanation. It states what the rules ask and what is missing; it never says "you are legally compliant". */
export function explainItems(items, excluded = []) {
  const lines = [];
  if (!items.length) lines.push('No rule in force applies to this on the date checked. That does not mean nothing is required: it only means no rule has been written for this place, role or date.');
  for (const i of items) {
    const cls = (CLASS_LABEL[i.policy.classification] ?? i.policy.classification).toLowerCase();
    if (i.outcome === 'unknown') lines.push(`${i.requirement.name} (${cls}) might apply, but ${i.policy.missing_facts.join(', ')} ${i.policy.missing_facts.length > 1 ? 'are' : 'is'} not on record, so it cannot be judged yet.`);
    else if (['compliant'].includes(i.status)) lines.push(`${i.requirement.name} (${cls}) is in order.`);
    else lines.push(`${i.requirement.name} (${cls}): ${i.explanation}`);
  }
  const over = excluded.filter((x) => x.superseded_by);
  if (over.length) lines.push(`${over.length} rule${over.length === 1 ? ' is' : 's are'} overridden by a higher-ranked rule on the same topic.`);
  lines.push('This explains the rules and the evidence on file. Whether a requirement is legally met is decided by a human reviewer, not by this tool, and an uploaded document counts only after someone has verified it.');
  return { text: lines.join(' '), lines, assertion: 'none' };
}
