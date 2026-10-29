// Compliance engine core (#568): pure functions, no database. A rule version is judged against facts and evidence, and the outcome is explainable.
//
// Precedence (documented in docs/compliance.md):
//   1. Only approved versions whose effective window contains the as-of date take part; the highest version number wins when versions overlap.
//   2. A rule applies when every dimension it names (country, region, municipality, federation, competition, organisation, venue, event type,
//      sport, role, age) matches the facts. A dimension the facts cannot answer makes the rule UNKNOWN, never silently "does not apply".
//   3. Rules about the same TOPIC compete: the highest classification wins (legal > regulatory > federation > contractual > organisation >
//      recommended), then the narrower jurisdiction (municipality > region > country > none), then the more specific applicability, then the later
//      effective date, then the higher version. Rules of different topics add up. A higher-ranked rule that is UNKNOWN is never skipped.
//   4. Evidence is judged only from reviewed records. An uploaded document that no human has verified is "pending", never "compliant".

export const DOMAINS = ['procurement', 'event_permit', 'federation_eligibility', 'accreditation', 'youth_safeguarding', 'privacy', 'general'];
export const CLASSIFICATIONS = ['legal_mandatory', 'regulatory', 'federation_mandated', 'contractual', 'organisation_policy', 'recommended_standard'];
export const CLASS_RANK = { legal_mandatory: 6, regulatory: 5, federation_mandated: 4, contractual: 3, organisation_policy: 2, recommended_standard: 1 };
export const EVIDENCE_KINDS = ['licence', 'permit', 'declaration', 'certificate', 'training', 'insurance', 'background_check', 'signed_document', 'approval'];
export const HOLDERS = ['person', 'organisation', 'event', 'venue', 'tender', 'supplier_entity'];
export const OUTCOMES = ['applies', 'does_not_apply', 'unknown', 'exception_required'];
export const STATUSES = ['compliant', 'expiring', 'pending', 'missing', 'exception', 'non_compliant'];
/** Higher = worse. `unknown` sits between missing and pending: it is not a pass, but nothing is known to be wrong. */
const SEVERITY = { compliant: 0, expiring: 1, exception: 2, pending: 3, unknown: 4, missing: 5, non_compliant: 6 };
export const worst = (list) => list.reduce((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'compliant');

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' from a pg DATE (handed back as a local-midnight Date) or a string; no time zone can move the day. */
export const day = (d) => (d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : d ? String(d).slice(0, 10) : null);
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const SCALARS = [['country', 'country'], ['region', 'region'], ['municipality', 'municipality']];
const LISTS = [['federation_ids', 'federation_ids', 'federation'], ['event_ids', 'event_id', 'competition'], ['organisation_ids', 'organisation_id', 'organisation'], ['venue_ids', 'venue_id', 'venue'], ['event_types', 'event_type', 'event type'], ['sports', 'sport', 'sport'], ['roles', 'roles', 'role']];

/** Does this rule version apply to these facts? `unknown` lists what the facts could not answer. */
export function applicability(v, facts, na = []) {
  const no = [], unknown = [];
  for (const [key, label] of [['country', 'country'], ['region', 'state or province'], ['municipality', 'municipality']]) {
    if (!v[key]) continue;
    const have = facts[key];
    if (have == null || have === '') unknown.push(label);
    else if (norm(have) !== norm(v[key])) no.push(label);
  }
  const a = v.applies ?? {};
  for (const [ruleKey, factKey, label] of LISTS) {
    const want = (a[ruleKey] ?? []).map(norm);
    if (!want.length) continue;
    if (na.includes(factKey)) { no.push(label); continue; }                        // this kind of subject has no such fact (an event has no role)
    const raw = facts[factKey];
    const have = [].concat(raw ?? []).filter((x) => x != null && x !== '').map(norm);
    if (raw == null) unknown.push(label);
    else if (!have.length) no.push(label);                                           // known to be empty: the person has no role here
    else if (!have.some((x) => want.includes(x))) no.push(label);
  }
  if (a.min_age != null || a.max_age != null) {
    if (na.includes('age')) no.push('age');
    else if (facts.age == null) unknown.push('age');
    else if ((a.min_age != null && facts.age < a.min_age) || (a.max_age != null && facts.age > a.max_age)) no.push('age');
  }
  return no.length ? { result: 'no', no, unknown } : unknown.length ? { result: 'unknown', no, unknown } : { result: 'yes', no, unknown };
}

const specificity = (v) => (v.municipality ? 3 : v.region ? 2 : v.country ? 1 : 0);
const narrowing = (v) => Object.entries(v.applies ?? {}).filter(([, x]) => (Array.isArray(x) ? x.length : x != null)).length;
/** Negative when `a` outranks `b`. */
export const byPrecedence = (a, b) =>
  (CLASS_RANK[b.classification] - CLASS_RANK[a.classification]) || (specificity(b) - specificity(a)) || (narrowing(b) - narrowing(a))
  || String(day(b.effective_from)).localeCompare(String(day(a.effective_from))) || (b.version - a.version) || String(a.key).localeCompare(String(b.key));

/** The versions in force on `asOf`: per rule, the highest approved version whose window contains the date; a repeal removes the rule. */
export function inForce(versions, asOf) {
  const best = new Map();
  for (const v of versions) {
    if (v.status !== 'approved') continue;
    if (day(v.effective_from) > asOf || (v.effective_to && day(v.effective_to) <= asOf)) continue;
    const cur = best.get(v.rule_id);
    if (!cur || v.version > cur.version) best.set(v.rule_id, v);
  }
  return [...best.values()].filter((v) => !v.repeals);
}

/** Judge one requirement against the evidence items for its holder. `ref` = the reference date for "expiring", `cover` = the date it must be valid on. */
export function judgeRequirement(req, items, { ref, cover }) {
  const mine = items.filter((e) => e.kind === req.kind && (!e.requirement_key || e.requirement_key === req.key));
  const validOn = (e) => (!e.valid_from || day(e.valid_from) <= cover) && (!e.valid_to || day(e.valid_to) >= cover)
    && (!req.max_age_days || (e.issued_on && addDays(day(e.issued_on), req.max_age_days) >= cover));
  const ok = mine.filter((e) => e.status === 'verified' && validOn(e));
  if (ok.length) {
    const best = ok.reduce((a, b) => ((day(b.valid_to) ?? '9999') > (day(a.valid_to) ?? '9999') ? b : a));
    const soon = best.valid_to && day(best.valid_to) <= addDays(ref, req.warn_days ?? 30);
    return { status: soon ? 'expiring' : 'compliant', detail: soon ? `Valid, but expires on ${day(best.valid_to)}` : 'Verified', evidence_id: best.id, source: best.source };
  }
  const verified = mine.filter((e) => e.status === 'verified');
  if (verified.length) {
    const last = verified.reduce((a, b) => ((day(b.valid_to) ?? '') > (day(a.valid_to) ?? '') ? b : a));
    return { status: 'non_compliant', detail: last.valid_to && day(last.valid_to) < cover ? `Expired on ${day(last.valid_to)}` : last.valid_from && day(last.valid_from) > cover ? `Not valid until ${day(last.valid_from)}` : 'Verified, but outside the required validity or age', evidence_id: last.id, source: last.source };
  }
  const waiting = mine.filter((e) => e.status === 'submitted');
  if (waiting.length) return { status: 'pending', detail: 'Submitted and waiting for a reviewer', evidence_id: waiting[0].id, source: waiting[0].source };
  const bad = mine.filter((e) => e.status === 'rejected' || e.status === 'revoked');
  if (bad.length) return { status: 'non_compliant', detail: `Evidence was ${bad[0].status}`, evidence_id: bad[0].id, source: bad[0].source };
  return { status: 'missing', detail: 'No evidence on record', evidence_id: null, source: null };
}

/**
 * Evaluate a set of in-force versions.
 * @param {object[]} versions  normalised in-force versions (library rules and adapter rules)
 * @param {object} facts       { country, region, municipality, federation_ids[], event_id, organisation_id, venue_id, event_type, sport, roles[], age }
 * @param {(holder:string)=>object[]} evidenceFor  evidence items for the holder kind
 * @param {(v:object, holder:string)=>object|null} exceptionFor  the live exception for a rule and holder kind, if any
 */
export function evaluateVersions(versions, facts, { evidenceFor, exceptionFor, ref, cover, na = [] }) {
  const judged = versions.map((v) => ({ v, a: applicability(v, facts, na) }));
  const byTopic = new Map();
  for (const j of judged) { if (j.a.result === 'no') continue; (byTopic.get(j.v.topic) ?? byTopic.set(j.v.topic, []).get(j.v.topic)).push(j); }
  const winner = new Map(), loser = new Map();
  for (const [topic, list] of byTopic) {
    list.sort((x, y) => byPrecedence(x.v, y.v));
    winner.set(topic, list[0]);
    for (const l of list.slice(1)) loser.set(l.v.version_id, list[0]);
  }
  const out = [];
  for (const { v, a } of judged) {
    const base = { rule_id: v.rule_id, key: v.key, topic: v.topic, source: v.source, version_id: v.version_id, version: v.version, title: v.title, classification: v.classification,
      country: v.country ?? null, region: v.region ?? null, municipality: v.municipality ?? null, effective_from: day(v.effective_from), effective_to: day(v.effective_to),
      source_title: v.source_title ?? null, source_url: v.source_url ?? null, approval_owner: v.approval_owner ?? null, waivable: !!v.waivable, summary: v.summary ?? null, scope_label: v.scope_label ?? null };
    if (a.result === 'no') { out.push({ ...base, outcome: 'does_not_apply', status: null, reason: `Does not apply: ${a.no.join(', ')} differ`, requirements: [], exception_ids: [] }); continue; }
    const top = loser.get(v.version_id), over = top?.v;
    if (top && top.a.result === 'unknown') { out.push({ ...base, outcome: 'unknown', status: 'unknown', reason: `Depends on whether "${over.title}" applies, which cannot be told yet`, missing_facts: top.a.unknown, requirements: [], exception_ids: [] }); continue; }
    if (over) { out.push({ ...base, outcome: 'does_not_apply', status: null, superseded_by: { key: over.key, version: over.version, title: over.title, classification: over.classification }, reason: `Overridden for topic "${v.topic}" by ${over.title} (${over.classification.replace(/_/g, ' ')})`, requirements: [], exception_ids: [] }); continue; }
    if (a.result === 'unknown') { out.push({ ...base, outcome: 'unknown', status: 'unknown', reason: `Cannot tell yet: no ${a.unknown.join(', ')} on record`, missing_facts: a.unknown, requirements: [], exception_ids: [] }); continue; }
    const reqs = [], exIds = [];
    for (const r of v.requirements ?? []) {
      const holder = r.holder ?? 'subject';
      const j = judgeRequirement(r, evidenceFor(holder), { ref, cover });
      let status = j.status, ex = null;
      if (['missing', 'pending', 'non_compliant'].includes(status) && v.waivable && (ex = exceptionFor(v, holder))) { status = 'exception'; exIds.push(ex.id); }
      reqs.push({ key: r.key, kind: r.kind, label: r.label, holder, status, detail: status === 'exception' ? `Waived by an authorised exception until ${day(ex.valid_to)}` : j.detail, evidence_id: j.evidence_id, evidence_source: j.source, exception_id: ex?.id ?? null });
    }
    const status = reqs.length ? worst(reqs.map((r) => r.status)) : 'compliant';
    const outcome = status === 'non_compliant' && v.waivable ? 'exception_required' : 'applies';
    out.push({ ...base, outcome, status, reason: reqs.length ? null : 'Applies; no evidence is required', requirements: reqs, exception_ids: [...new Set(exIds)] });
  }
  return out.sort((x, y) => byPrecedence(x, y));
}

/** Summarise results: counts per dashboard status, the overall status, and whether an enforcing gate must stop. */
export function summarise(results) {
  const live = results.filter((r) => r.outcome !== 'does_not_apply');
  const counts = Object.fromEntries([...STATUSES, 'unknown'].map((s) => [s, 0]));
  for (const r of live) counts[r.status] += 1;
  const overall = !live.length ? 'no_rules' : worst(live.map((r) => r.status));
  // advisory (recommended standard) rules never stop anything
  const stopping = live.filter((r) => r.classification !== 'recommended_standard' && ['missing', 'pending', 'non_compliant', 'unknown'].includes(r.status));
  return { overall, counts, blocked: stopping.length > 0, blockers: stopping.map((r) => ({ key: r.key, title: r.title, classification: r.classification, status: r.status, outcome: r.outcome, reason: r.reason ?? r.requirements.filter((q) => ['missing', 'pending', 'non_compliant'].includes(q.status)).map((q) => `${q.label}: ${q.detail}`).join('; ') })) };
}

/** A deterministic plain-language explanation. It states what the rules ask and what evidence is missing; it never says "you are legally compliant". */
export function explain(results, summary) {
  const lines = [];
  const live = results.filter((r) => r.outcome !== 'does_not_apply');
  if (!live.length) lines.push('No rule in force applies to this on the date checked. That is not a statement that nothing is required: it only means no rule has been added for this place, role or date.');
  for (const r of live) {
    const cls = r.classification.replace(/_/g, ' ');
    if (r.outcome === 'unknown') { lines.push(`${r.title} (${cls}) might apply, but ${r.missing_facts.join(', ')} ${r.missing_facts.length > 1 ? 'are' : 'is'} not on record, so it cannot be judged yet.`); continue; }
    if (!r.requirements.length) { lines.push(`${r.title} (${cls}) applies. It asks for no evidence from you.`); continue; }
    const open = r.requirements.filter((q) => q.status !== 'compliant');
    if (!open.length) lines.push(`${r.title} (${cls}): every requirement has reviewed evidence on file.`);
    else lines.push(`${r.title} (${cls}) needs: ${open.map((q) => `${q.label} (${q.status.replace(/_/g, ' ')}: ${q.detail.toLowerCase()})`).join('; ')}.`);
  }
  lines.push('This explains the rules and the evidence on file. Whether a requirement is legally met is decided by a human reviewer, not by this tool, and an uploaded document counts only after someone has verified it.');
  return { text: lines.join(' '), lines, assertion: 'none', overall: summary.overall };
}
