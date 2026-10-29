// Compliance engine data layer (#568): resolves a subject to facts, loads the rules in force (the engine's own library plus the federation's
// versioned policies, #68), reads evidence from where it already lives (engine records, supplier credentials, federation licences, guardian
// consent), judges it with ./engine.js, and records the decision. No rule text lives in a module: modules only call `gate()` or `evaluate()`.
import { pool } from '../db.js';
import { decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { lineage, policyAt, paramsOf, LIC_STATUS } from '../federation.js';
import { ageOf, guardianLink, hasConsent } from '../youth.js';
import { engagementsOf } from '../accreditation.js';
import { isOrganiser } from '../capabilities/event-departments.js';
import { buyerRoles, entityRole, venueAuthority } from '../tender/core.js';
import { orgRole } from '../org-access.js';
import { day, evaluateVersions, explain, inForce, summarise } from './engine.js';
import { domainsFor } from './catalogue.js';

const q = (c) => c ?? pool;
export const SUBJECTS = ['event', 'person', 'supplier_entity', 'tender', 'organisation', 'venue'];
const today = () => day(new Date());

// ------------------------------------------------------------------ facts
const addressOf = async (c, kind, id) => (id ? (await q(c).query(
  "SELECT country, region, locality FROM addresses WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1", [kind, id])).rows[0] ?? null : null);

/** Where something is: the venue's address, else the organisation's. Each fact says where it came from, so a gap points at the record to fix. */
async function placeFacts(c, { venue_id, organisation_id, region, city }, facts, sources) {
  const v = await addressOf(c, 'venue', venue_id), o = v?.country ? null : await addressOf(c, 'organisation', organisation_id);
  const a = v?.country ? v : o ?? v;
  const from = v?.country ? 'venue address' : o ? 'organisation address' : 'venue address';
  if (a?.country) { facts.country = a.country; sources.country = from; }
  if (a?.region || region) { facts.region = a?.region ?? region; sources.region = a?.region ? from : 'event record'; }
  if (a?.locality || city) { facts.municipality = a?.locality ?? city; sources.municipality = a?.locality ? from : 'event record'; }
}

async function eventContext(c, eventId, facts, sources, holders) {
  const e = (await q(c).query("SELECT e.*, s.slug AS sport_slug, e.starts_on::text AS d0, e.ends_on::text AS d1 FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1", [eventId])).rows[0];
  if (!e) throw notFound('Event');
  facts.event_id = e.id; facts.event_type = e.kind; facts.sport = e.sport_slug; sources.event_type = sources.sport = 'event record';
  if (e.organisation_id) { facts.organisation_id = e.organisation_id; sources.organisation_id = 'event record'; holders.organisation = e.organisation_id; }
  if (e.venue_id) { facts.venue_id = e.venue_id; sources.venue_id = 'event record'; holders.venue = e.venue_id; }
  holders.event = e.id;
  await placeFacts(c, { venue_id: e.venue_id, organisation_id: e.organisation_id, region: e.region, city: e.city }, facts, sources);
  const bodies = (await q(c).query("SELECT DISTINCT body_id FROM fed_sanctions WHERE event_id=$1 AND status='approved'", [eventId])).rows.map((r) => r.body_id);
  if (bodies.length) { facts.federation_ids = bodies; sources.federation_ids = 'approved sanction'; }
  return { row: e, start: e.d0, end: e.d1 ?? e.d0 };
}

/**
 * Turn a subject (and the event or tender it is judged in) into facts, evidence holders and dates. Pure reads; the one personal read (date of
 * birth, for an age band) is audit-logged and only the age in years is kept.
 */
export async function resolve(c, actor, { subject_type, subject_id, context = {}, as_of }) {
  c ??= pool;
  const facts = {}, sources = {}, holders = {};
  let label = null, start = null, end = null, eventRow = null, tenderRow = null;
  const withEvent = async (id) => { const r = await eventContext(c, id, facts, sources, holders); eventRow = r.row; start ??= r.start; end ??= r.end; };
  const withTender = async (id) => {
    const p = (await q(c).query("SELECT *, service_start::text AS d0, service_end::text AS d1 FROM proc_projects WHERE id=$1", [id])).rows[0];
    if (!p) throw notFound('Tender');
    tenderRow = p; holders.tender = p.id; start ??= p.d0; end ??= p.d1 ?? p.d0;
    if (p.event_id) await withEvent(p.event_id);
    if (p.organisation_id) { facts.organisation_id = p.organisation_id; sources.organisation_id = 'tender record'; holders.organisation = p.organisation_id; }
    if (p.venue_id && !facts.venue_id) { facts.venue_id = p.venue_id; sources.venue_id = 'tender record'; holders.venue = p.venue_id; }
    if (!facts.country) await placeFacts(c, { venue_id: p.venue_id, organisation_id: p.organisation_id }, facts, sources);
    if (p.sport_id && !facts.sport) { facts.sport = (await q(c).query('SELECT slug FROM sports WHERE id=$1', [p.sport_id])).rows[0]?.slug; sources.sport = 'tender record'; }
    return p;
  };

  if (subject_type === 'event') { await withEvent(subject_id); label = eventRow.name; }
  else if (subject_type === 'tender') { const p = await withTender(subject_id); label = `${p.ref} · ${p.title}`; }
  else if (subject_type === 'organisation') {
    const o = (await q(c).query('SELECT id, name FROM organisations WHERE id=$1', [subject_id])).rows[0];
    if (!o) throw notFound('Organisation');
    label = o.name; facts.organisation_id = o.id; sources.organisation_id = 'organisation record'; holders.organisation = o.id;
    await placeFacts(c, { organisation_id: o.id }, facts, sources);
  } else if (subject_type === 'venue') {
    const v = (await q(c).query('SELECT id, name, organisation_id FROM venues WHERE id=$1', [subject_id])).rows[0];
    if (!v) throw notFound('Venue');
    label = v.name; facts.venue_id = v.id; sources.venue_id = 'venue record'; holders.venue = v.id;
    if (v.organisation_id) { facts.organisation_id = v.organisation_id; holders.organisation = v.organisation_id; sources.organisation_id = 'venue record'; }
    await placeFacts(c, { venue_id: v.id, organisation_id: v.organisation_id }, facts, sources);
  } else if (subject_type === 'supplier_entity') {
    const s = (await q(c).query('SELECT id, legal_name, country, organisation_id FROM supplier_entities WHERE id=$1', [subject_id])).rows[0];
    if (!s) throw notFound('Supplier');
    label = s.legal_name; holders.supplier_entity = s.id; facts.roles = ['supplier']; sources.roles = 'supplier record';
    if (context.tender_id) await withTender(context.tender_id); else if (context.event_id) await withEvent(context.event_id);
    if (!facts.country && /^[A-Za-z]{2}$/.test(s.country ?? '')) { facts.country = s.country.toUpperCase(); sources.country = 'supplier record'; }
  } else if (subject_type === 'person') {
    const u = (await q(c).query('SELECT id, display_name, dob_enc FROM users WHERE id=$1', [subject_id])).rows[0];
    if (!u) throw notFound('Person');
    label = u.display_name; holders.person = u.id;
    if (context.event_id) await withEvent(context.event_id);
    const asOfDate = as_of ?? start ?? today();
    if (u.dob_enc) {
      await audit(c, actor?.id ?? null, 'read_dob_compliance', 'users', u.id);
      facts.age = ageOf(decrypt(u.dob_enc, 'users.dob'), new Date(`${asOfDate}T12:00:00Z`)); sources.age = 'date of birth on file (only the age is kept)';
    }
    if (eventRow) {
      let roles = [...await engagementsOf(c ?? pool, eventRow, u.id)];
      const cat = context.category_roles ?? [];
      if (cat.length) { const m = roles.filter((r) => cat.includes(r)); roles = m.length ? m : cat.includes('guest') ? ['guest'] : roles; } // judged in the role the badge is for
      if (roles.length) { facts.roles = roles; sources.roles = 'event engagements'; }
    }
  } else throw notFound('Subject');

  const asOf = as_of ?? start ?? today();
  const now = today();
  const na = subject_type === 'person' ? [] : subject_type === 'supplier_entity' ? ['age'] : ['age', 'roles'];
  if (subject_type === 'person' && eventRow && !facts.roles) { facts.roles = []; sources.roles = 'event engagements'; }
  return { na, subject_type, subject_id, label, facts, sources, holders, as_of: asOf, cover: end && end > asOf ? end : asOf, ref: asOf < now ? asOf : now, event: eventRow, tender: tenderRow };
}

// ------------------------------------------------------------------ rules in force
/** Federation policies (#68) read as rules, so a federation keeps authoring them in one place. Only the kinds the engine can judge are mapped. */
async function federationRules(c, R, asOf) {
  const out = [];
  for (const bodyId of R.facts.federation_ids ?? []) {
    const sportId = (await q(c).query('SELECT id FROM sports WHERE slug=$1', [R.facts.sport])).rows[0]?.id ?? null;
    const body = (await q(c).query('SELECT o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id=$1', [bodyId])).rows[0];
    const make = (p, suffix, topic, title, extra) => out.push({ rule_id: `${p.policy_id}:${suffix}`, key: `fed.${p.policy_id.slice(0, 8)}.${suffix}`, topic, source: 'federation_policy', version_id: p.version_id, version: p.version,
      title, classification: 'federation_mandated', effective_from: p.effective_from, effective_to: null, approval_owner: body?.name ?? 'Governing body', scope_label: body?.name ?? null,
      source_title: `${p.title} (version ${p.version})`, status: 'approved', waivable: false, summary: p.summary ?? null, ...extra });
    const reg = await policyAt(bodyId, 'registration', { sportId, date: asOf }, c);
    if (reg && paramsOf('registration', reg).requires_guardian_consent_under_18) {
      make(reg, 'guardian', 'federation.guardian_consent', 'Guardian consent for under-18 participants', { applies: { max_age: 17 },
        requirements: [{ key: 'guardian_consent', kind: 'signed_document', label: 'Guardian consent for participation', holder: 'person' }] });
    }
    const entry = await policyAt(bodyId, 'competition_entry', { sportId, date: asOf }, c);
    if (entry && paramsOf('competition_entry', entry).requires_licensed_players) {
      make(entry, 'licence', 'federation.player_licence', 'Licensed players only', { applies: {}, requirements: [{ key: 'player_licence', kind: 'licence', label: 'Current federation licence', holder: 'person' }] });
    }
  }
  return out;
}

async function loadRules(c, domains, R) {
  const orgs = [R.facts.organisation_id].filter(Boolean);
  const rows = (await q(c).query(
    `SELECT r.id AS rule_id, r.key, r.topic, r.scope_kind, o.name AS scope_label, v.id AS version_id, v.version, v.status, v.repeals, v.title, v.summary, v.classification, v.country, v.region, v.municipality,
            v.applies, v.effective_from::text AS effective_from, v.effective_to::text AS effective_to, v.source_title, v.source_url, v.approval_owner, v.requirements, v.waivable
       FROM cmp_rules r JOIN cmp_rule_versions v ON v.rule_id=r.id LEFT JOIN organisations o ON o.id=r.organisation_id
      WHERE v.status='approved' AND r.domains && $1::text[] AND v.effective_from <= $2::date AND (v.effective_to IS NULL OR v.effective_to > $2::date)
        AND (r.scope_kind='platform' OR r.organisation_id = ANY($3::uuid[]))`, [domains, R.as_of, orgs])).rows;
  const library = inForce(rows, R.as_of).map((v) => ({ ...v, source: 'library' }));
  const fed = domains.includes('federation_eligibility') ? await federationRules(c, R, R.as_of) : [];
  return [...library, ...fed];
}

// ------------------------------------------------------------------ evidence (read from where it lives)
const CRED_KIND = { insurance: 'insurance', safeguarding: 'certificate', safety_certificate: 'certificate', trade_licence: 'licence', tax_registration: 'licence', qualification: 'certificate' };
const LIC_MAP = { active: 'verified', expired: 'verified', submitted: 'submitted', under_review: 'submitted', needs_info: 'submitted', rejected: 'rejected', suspended: 'revoked', revoked: 'revoked' };

async function loadEvidence(c, R) {
  const out = {};
  const eventId = R.facts.event_id ?? null;
  for (const [type, hid] of Object.entries(R.holders)) {
    const items = (await q(c).query(
      `SELECT id, kind, requirement_key, title, status, issued_on::text AS issued_on, valid_from::text AS valid_from, valid_to::text AS valid_to
         FROM cmp_evidence WHERE holder_type=$1 AND holder_id=$2 AND (context_event_id IS NULL OR context_event_id=$3) ORDER BY submitted_at`, [type, hid, eventId])).rows.map((e) => ({ ...e, source: 'evidence' }));
    if (type === 'supplier_entity') {
      for (const k of (await q(c).query("SELECT id, kind, title, status, valid_from::text AS valid_from, valid_to::text AS valid_to FROM supplier_credentials WHERE entity_id=$1 AND archived_at IS NULL", [hid])).rows) {
        if (CRED_KIND[k.kind]) items.push({ id: k.id, kind: CRED_KIND[k.kind], requirement_key: null, title: k.title, status: { declared: 'submitted', verified: 'verified', rejected: 'rejected' }[k.status], valid_from: k.valid_from, valid_to: k.valid_to, issued_on: k.valid_from, source: 'supplier_credential' });
      }
    }
    if (type === 'person') {
      const bodies = [];
      for (const b of R.facts.federation_ids ?? []) bodies.push(...await lineage(b, c));
      for (const l of (await q(c).query(
        `SELECT l.id, ${LIC_STATUS('l')} AS eff, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, t.name AS title
           FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.holder_id=$1 AND l.status <> 'draft' AND ($2::uuid[] IS NULL OR l.body_id = ANY($2))`, [hid, bodies.length ? bodies : null])).rows) {
        if (LIC_MAP[l.eff]) items.push({ id: l.id, kind: 'licence', requirement_key: null, title: l.title, status: LIC_MAP[l.eff], valid_from: l.issued_on, valid_to: l.expires_on, issued_on: l.issued_on, source: 'federation_licence' });
      }
      if (await hasConsent(hid, 'participation', c) && (await q(c).query('SELECT 1 FROM users u WHERE u.id=$1 AND u.youth_until IS NOT NULL AND u.youth_until > current_date', [hid])).rows.length) {
        items.push({ id: hid, kind: 'signed_document', requirement_key: 'guardian_consent', title: 'Guardian participation consent', status: 'verified', valid_from: null, valid_to: null, issued_on: null, source: 'guardian_consent' });
      }
    }
    out[type] = items;
  }
  return out;
}

async function loadExceptions(c, R) {
  const types = Object.keys(R.holders);
  if (!types.length) return [];
  return (await q(c).query(
    `SELECT id, rule_id::text AS rule_id, holder_type, holder_id, valid_to::text AS valid_to FROM cmp_exceptions
      WHERE revoked_at IS NULL AND valid_from <= now() AND valid_to > now() AND (holder_type, holder_id) IN (SELECT * FROM unnest($1::text[], $2::uuid[]))
        AND (context_event_id IS NULL OR context_event_id IS NOT DISTINCT FROM $3::uuid)`, [types, types.map((t) => R.holders[t]), R.facts.event_id ?? null])).rows;
}

// ------------------------------------------------------------------ evaluate / record / gate
/**
 * Evaluate a subject for one or more domains. `record: true` writes the audit decision. Returns facts (with where each came from), every rule's
 * outcome, the summary and a plain-language explanation that never asserts legal compliance.
 */
export async function evaluate(c, { actor = null, domain, domains, subject_type, subject_id, context = {}, as_of, trigger = 'manual', record = false, resolved = null }) {
  c ??= pool;
  const R = resolved ?? await resolve(c, actor, { subject_type, subject_id, context, as_of });
  const doms = domains?.length ? domains : domainsFor(domain);
  const versions = await loadRules(c, doms, R);
  const evidence = await loadEvidence(c, R);
  const exceptions = await loadExceptions(c, R);
  const holder = (h) => (h === 'subject' || !h ? subject_type : h);
  const results = evaluateVersions(versions, R.facts, {
    ref: R.ref, cover: R.cover, na: R.na,
    evidenceFor: (h) => evidence[holder(h)] ?? [],
    exceptionFor: (v, h) => exceptions.find((x) => x.rule_id === String(v.rule_id) && x.holder_type === holder(h) && x.holder_id === R.holders[holder(h)]) ?? null,
  });
  const summary = summarise(results);
  const out = { domain: domain ?? null, subject: { type: subject_type, id: subject_id, label: R.label }, domains: doms, as_of: R.as_of, valid_on: R.cover, context, facts: { values: R.facts, sources: R.sources }, results, summary, explanation: explain(results, summary), decision_id: null };
  if (record && results.some((r) => r.outcome !== 'does_not_apply')) out.decision_id = await recordDecision(c, actor, { domain: domain ?? doms.join(','), subject_type, subject_id, trigger, out, event_id: R.facts.event_id ?? null });
  return out;
}

export async function recordDecision(c, actor, { domain, subject_type, subject_id, trigger, out, event_id }) {
  const ex = [...new Set(out.results.flatMap((r) => r.exception_ids ?? []))];
  const r = await q(c).query(
    `INSERT INTO cmp_decisions(domain, subject_type, subject_id, context_event_id, trigger, as_of, facts, results, overall, blocked, override_exception_ids, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [domain, subject_type, subject_id, event_id, trigger, out.as_of, JSON.stringify(out.facts), JSON.stringify(out.results), out.summary.overall, out.summary.blocked, ex, actor?.id ?? null]);
  return r.rows[0].id;
}

/**
 * The one call a module makes before it acts. No rule in force for the subject = no effect, so a module that nobody has written rules for behaves
 * exactly as before. A blocked attempt is recorded on a separate connection (the caller's transaction is about to roll back) and then refused.
 */
export async function gate(c, args) {
  const out = await evaluate(c, { ...args, record: false });
  const live = out.results.some((r) => r.outcome !== 'does_not_apply');
  if (!live) return out;
  if (out.summary.blocked) {
    try { out.decision_id = await recordDecision(pool, args.actor, { domain: out.domain ?? out.domains.join(','), subject_type: args.subject_type, subject_id: args.subject_id, trigger: args.trigger ?? 'gate', out, event_id: out.facts.values.event_id ?? null }); } catch { /* the refusal must not depend on the log */ }
    throw conflict('Compliance rules are not met yet', { code: 'compliance_blocked', decision_id: out.decision_id, subject: out.subject, blockers: out.summary.blockers, explanation: out.explanation.text });
  }
  out.decision_id = await recordDecision(c, args.actor, { domain: out.domain ?? out.domains.join(','), subject_type: args.subject_type, subject_id: args.subject_id, trigger: args.trigger ?? 'gate', out, event_id: out.facts.values.event_id ?? null });
  return out;
}

// ------------------------------------------------------------------ who may do what (read live, outsiders get 404)
/** May the user act for this holder (submit evidence, read its obligations)? */
export async function manages(c, user, type, id) {
  c ??= pool;
  if (isAdmin(user)) return true;
  if (type === 'person') return user.id === id || !!(await guardianLink(user.id, id, c));
  if (type === 'organisation') return ['owner', 'admin'].includes(await orgRole(user, id, c));
  if (type === 'event') { const e = (await q(c).query('SELECT id, organizer_id, organisation_id FROM events WHERE id=$1', [id])).rows[0]; return !!e && isOrganiser(user, e, c); }
  if (type === 'venue') return venueAuthority(user, id, c);
  if (type === 'tender') { const p = (await q(c).query('SELECT * FROM proc_projects WHERE id=$1', [id])).rows[0]; return !!p && (await buyerRoles(user, p, c)).length > 0; }
  if (type === 'supplier_entity') return ['owner', 'bid_manager', 'signatory'].includes(await entityRole(user, id, c));
  return false;
}

/** May the user see this subject's obligations? The holder side, and the side that has to decide on it (event organiser for people in their event, buyers for suppliers). */
export async function mayView(c, user, type, id, context = {}) {
  c ??= pool;
  if (await manages(c, user, type, id)) return true;
  if (type === 'organisation') return !!(await orgRole(user, id, c));
  if (type === 'person' && context.event_id) {
    const e = (await q(c).query('SELECT * FROM events WHERE id=$1', [context.event_id])).rows[0];
    return !!e && (await isOrganiser(user, e, c)) && (await engagementsOf(c ?? pool, e, id)).size > 0;
  }
  if (type === 'supplier_entity' && context.tender_id) return manages(c, user, 'tender', context.tender_id);
  return false;
}

/** Reviewers of evidence: the organiser of the event it is filed for, or the platform team for evidence that counts everywhere. Never the person who filed it. */
export async function mayReview(c, user, ev) {
  c ??= pool;
  if (user.id === ev.submitted_by) return false;
  if (isAdmin(user)) return true;
  if (!ev.context_event_id) return false;
  const e = (await q(c).query('SELECT id, organizer_id, organisation_id FROM events WHERE id=$1', [ev.context_event_id])).rows[0];
  return !!e && isOrganiser(user, e, c);
}

export const assertView = async (c, user, type, id, context) => { if (!(await mayView(c, user, type, id, context))) throw notFound('Subject'); };
export { forbidden };

// ------------------------------------------------------------------ eligibility (#477) reads the engine as one more set of checks
/** Is there any rule the engine could judge competition eligibility with? Cheap, so competitions nobody has written rules for pay nothing. */
export async function eligibilityRulesExist(c) {
  return (await q(c).query(
    `SELECT 1 FROM cmp_rule_versions v JOIN cmp_rules r ON r.id=v.rule_id WHERE v.status='approved' AND r.domains && $1::text[]
     UNION ALL SELECT 1 FROM fed_policies WHERE status='active' AND kind IN ('registration','competition_entry') LIMIT 1`, [domainsFor('federation_eligibility')])).rows.length > 0;
}

/** The engine's result for one player in one competition, shaped as match-day eligibility checks. Advisory (recommended) rules are left out. */
export async function eligibilityChecks(c, actor, eventId, userId) {
  const out = await evaluate(c, { actor, domain: 'federation_eligibility', subject_type: 'person', subject_id: userId, context: { event_id: eventId }, trigger: 'eligibility' });
  const status = { compliant: 'pass', expiring: 'pass', exception: 'waived', pending: 'pending', missing: 'fail', non_compliant: 'fail', unknown: 'unknown' };
  return out.results.filter((r) => r.outcome !== 'does_not_apply' && r.classification !== 'recommended_standard').map((r) => ({
    rule: `policy:${r.key}`, status: status[r.status],
    reason: r.status === 'compliant' || r.status === 'expiring' ? `${r.title}: requirements met` : r.reason ?? `${r.title}: ${r.requirements.filter((x) => x.status !== 'compliant').map((x) => `${x.label} (${x.detail.toLowerCase()})`).join('; ')}`,
    source: { kind: 'policy', id: r.version_id, label: `${r.title} (version ${r.version})` },
  }));
}
