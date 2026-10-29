// Compliance engine, part 1 (#568): the rule library. A rule is a stable identity; every change is a new immutable, effective-dated version with
// its source, jurisdiction and approval owner. Jurisdiction packs are sets of rules imported as data (never a code fork). Federation policies stay
// in the federation console (#68) and are read by the engine as "federation mandated" rules, so there is exactly one place to author each kind.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { orgRole } from '../org-access.js';
import { CLASSIFICATIONS, DOMAINS, EVIDENCE_KINDS, HOLDERS, day } from '../compliance/engine.js';
import { SCOPE_CLASSES, catalogue } from '../compliance/catalogue.js';

const TAG = 'Compliance';
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,79}$/, 'lower-case letters, digits, dot, dash or underscore (3 to 80)');
const iso2 = z.string().regex(/^[A-Z]{2}$/, 'a two-letter country code');
const date = z.string().date();
const text = (min, max) => z.string().trim().min(min).max(max);

export const REQUIREMENT = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,59}$/), kind: z.enum(EVIDENCE_KINDS), label: text(3, 140),
  holder: z.enum(['subject', ...HOLDERS]).default('subject'), warn_days: z.number().int().min(0).max(365).default(30), max_age_days: z.number().int().min(1).max(3650).optional(),
});
export const APPLIES = z.object({
  federation_ids: z.array(id).max(50), event_ids: z.array(id).max(50), organisation_ids: z.array(id).max(50), venue_ids: z.array(id).max(50),
  event_types: z.array(z.enum(['tournament', 'league', 'friendly', 'camp', 'trial'])).max(5), sports: z.array(text(2, 60)).max(60), roles: z.array(text(2, 40)).max(30),
  min_age: z.number().int().min(0).max(120), max_age: z.number().int().min(0).max(120),
}).partial().strict();

const VERSION = {
  title: text(3, 140), summary: text(1, 1500).optional(), classification: z.enum(CLASSIFICATIONS),
  country: iso2.optional(), region: text(1, 80).optional(), municipality: text(1, 80).optional(),
  applies: APPLIES.default({}), effective_from: date, effective_to: date.optional(),
  source_title: text(1, 200).optional(), source_url: z.string().url().regex(/^https:\/\//, 'use an https link').max(500).optional(), pack_code: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/).optional(),
  approval_owner: text(3, 140).describe('who is accountable for approving this rule, e.g. "Legal counsel, India" or "Club board"'),
  requirements: z.array(REQUIREMENT).max(30).default([]), waivable: z.boolean().default(false), repeals: z.boolean().default(false), change_note: text(1, 500).optional(),
};
const RULE_HEAD = { key: slug, scope: z.enum(['platform', 'organisation']).default('organisation'), organisation_id: id.optional(), domains: z.array(z.enum(DOMAINS)).min(1).max(7), topic: slug };

/** The authority over a rule: the platform admin for platform rules, an owner or admin for an organisation's own. */
async function authorise(c, user, rule) {
  if (rule.scope_kind === 'platform') return mustBePlatformAdmin(user);
  if (!['owner', 'admin'].includes(await orgRole(user, rule.organisation_id, c))) throw forbidden('Only an owner or admin of the organisation can change its rules');
}

function checkVersion(scope, i) {
  if (!SCOPE_CLASSES[scope].includes(i.classification)) throw badRequest(`${scope === 'platform' ? 'A platform' : 'An organisation'} rule cannot be classified as ${i.classification.replace(/_/g, ' ')}. ${i.classification === 'federation_mandated' ? 'Federation rules are authored by the federation in its console.' : 'Allowed: ' + SCOPE_CLASSES[scope].join(', ')}`);
  if (i.waivable && ['legal_mandatory', 'regulatory'].includes(i.classification)) throw badRequest('A legal or regulatory rule cannot be made waivable by a person');
  if (i.effective_to && i.effective_to <= i.effective_from) throw badRequest('effective_to must be after effective_from');
  const keys = i.requirements.map((r) => r.key);
  if (new Set(keys).size !== keys.length) throw badRequest('Requirement keys must be unique within a rule');
  if (i.applies.min_age != null && i.applies.max_age != null && i.applies.min_age > i.applies.max_age) throw badRequest('min_age is above max_age');
  if ((i.region || i.municipality) && !i.country) throw badRequest('A state, province or municipality needs its country');
  if (i.municipality && !i.region) throw badRequest('A municipality needs its state or province');
  if (i.repeals && i.requirements.length) throw badRequest('A repeal carries no requirements');
}

const COLS = 'v.id, v.rule_id, v.version, v.status, v.repeals, v.title, v.summary, v.classification, v.country, v.region, v.municipality, v.applies, v.effective_from::text AS effective_from, v.effective_to::text AS effective_to, v.source_title, v.source_url, v.pack_code, v.approval_owner, v.requirements, v.waivable, v.change_note, v.created_by, v.created_at, v.approved_by, v.approved_at, v.self_approved';

/** Create a rule or add a version to one, always as a draft. Shared by the form and by pack import so both go through the same checks. */
export async function addVersion(c, user, i) {
  let rule;
  if (i.rule_id) {
    rule = (await c.query('SELECT * FROM cmp_rules WHERE id=$1 FOR UPDATE', [i.rule_id])).rows[0];
    if (!rule) throw notFound('Rule');
  } else {
    if (i.scope === 'organisation' && !i.organisation_id) throw badRequest('Choose the organisation this rule belongs to');
    if (i.scope === 'platform' && i.organisation_id) throw badRequest('A platform rule belongs to no organisation');
    if (!i.key || !i.domains || !i.topic) throw badRequest('A new rule needs a key, its domains and a topic');
    rule = { scope_kind: i.scope, organisation_id: i.scope === 'organisation' ? i.organisation_id : null };
  }
  await authorise(c, user, rule);
  checkVersion(rule.scope_kind, i);
  if (!i.rule_id) {
    try {
      rule = (await c.query('INSERT INTO cmp_rules(key, scope_kind, organisation_id, domains, topic, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.key, rule.scope_kind, rule.organisation_id, i.domains, i.topic, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict(`A rule with the key ${i.key} already exists; add a version to it instead`); throw e; }
  }
  const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM cmp_rule_versions WHERE rule_id=$1', [rule.id])).rows[0].n;
  const v = (await c.query(
    `INSERT INTO cmp_rule_versions(rule_id, version, title, summary, classification, country, region, municipality, applies, effective_from, effective_to, source_title, source_url, pack_code,
        approval_owner, requirements, waivable, repeals, change_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, version, status`,
    [rule.id, n, i.title, i.summary ?? null, i.classification, i.country ?? null, i.region ?? null, i.municipality ?? null, JSON.stringify(i.applies ?? {}), i.effective_from, i.effective_to ?? null,
      i.source_title ?? null, i.source_url ?? null, i.pack_code ?? null, i.approval_owner, JSON.stringify(i.requirements ?? []), i.waivable, i.repeals, i.change_note ?? null, user.id])).rows[0];
  await audit(c, user.id, 'compliance_rule_version_created', 'cmp_rule_versions', v.id);
  return { rule_id: rule.id, key: rule.key ?? i.key, version_id: v.id, version: v.version, status: v.status };
}

cap({
  name: 'get_compliance_catalogue', method: 'GET', path: '/compliance/catalogue', tag: TAG,
  summary: 'What the compliance engine governs: its domains, rule classifications with their precedence, evidence kinds, the countries jurisdiction packs are designed for first, and the precedence rules in words.',
  handler: async () => catalogue(),
});

cap({
  name: 'list_policy_rules', method: 'GET', path: '/compliance/rules', tag: TAG,
  summary: 'Rules you can see: the platform library (laws, regulations and recommended standards by jurisdiction) and your organisations\' own. Each shows the version in force today, anything scheduled, and whether a draft waits for approval. Drafts are visible only to those who can approve them.',
  input: z.object({ domain: z.enum(DOMAINS).optional(), country: iso2.optional(), organisation_id: id.optional(), classification: z.enum(CLASSIFICATIONS).optional(), ...page }),
  async handler({ user }, i) {
    const rules = await many(
      `SELECT r.id, r.key, r.scope_kind, r.organisation_id, o.name AS organisation_name, r.domains, r.topic, r.created_at,
              (r.scope_kind='organisation' AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=r.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))) AS org_admin
         FROM cmp_rules r LEFT JOIN organisations o ON o.id=r.organisation_id
        WHERE (r.scope_kind='platform' OR r.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))
          AND ($2::text IS NULL OR $2 = ANY(r.domains)) AND ($3::uuid IS NULL OR r.organisation_id=$3)
        ORDER BY r.key LIMIT 500`, [user.id, i.domain ?? null, i.organisation_id ?? null]);
    const vs = rules.length ? await many(`SELECT ${COLS} FROM cmp_rule_versions v WHERE v.rule_id = ANY($1) ORDER BY v.version DESC`, [rules.map((r) => r.id)]) : [];
    const platformAdmin = isAdmin(user);
    const today = day(new Date());
    const out = [];
    for (const r of rules) {
      const own = vs.filter((v) => v.rule_id === r.id);
      const approved = own.filter((v) => v.status === 'approved');
      const active = approved.find((v) => v.effective_from <= today && (!v.effective_to || v.effective_to > today)) ?? null;
      const upcoming = approved.filter((v) => v.effective_from > today).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const canApprove = r.scope_kind === 'platform' ? platformAdmin : r.org_admin;
      const drafts = own.filter((v) => v.status === 'draft');
      const current = active && !active.repeals ? active : null;
      if (i.country && !(approved.concat(drafts).some((v) => v.country === i.country))) continue;
      if (i.classification && !own.some((v) => v.classification === i.classification)) continue;
      if (!current && !upcoming.length && !(canApprove && drafts.length)) continue; // nothing to show to someone who cannot approve it
      out.push({ id: r.id, key: r.key, scope: r.scope_kind, organisation_id: r.organisation_id, organisation_name: r.organisation_name, domains: r.domains, topic: r.topic, can_manage: canApprove,
        current, repealed: !!active?.repeals, upcoming: upcoming[0] ?? null, drafts: canApprove ? drafts.length : 0, versions: own.length });
    }
    return out.slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'get_policy_rule', method: 'GET', path: '/compliance/rules/:id', tag: TAG,
  summary: 'One rule with every version ever published (the full history is kept so an old decision can be explained with the text that was in force). Drafts appear only to those who can approve them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT r.*, o.name AS organisation_name FROM cmp_rules r LEFT JOIN organisations o ON o.id=r.organisation_id WHERE r.id=$1', [i.id]);
    if (!r) throw notFound('Rule');
    let can = false;
    if (r.scope_kind === 'organisation') { const role = await orgRole(user, r.organisation_id); if (!role) throw notFound('Rule'); can = ['owner', 'admin'].includes(role); } else can = isAdmin(user);
    const versions = await many(`SELECT ${COLS} FROM cmp_rule_versions v WHERE v.rule_id=$1 ORDER BY v.version DESC`, [r.id]);
    return { ...r, can_manage: can, versions: can ? versions : versions.filter((v) => v.status !== 'draft') };
  },
});

cap({
  name: 'publish_policy_rule_version', method: 'POST', path: '/compliance/rules', tag: TAG, status: 201,
  summary: 'Write a rule version as a draft: a new rule (key, domains, topic) or, with rule_id, a new version of an existing one. Say where it applies (country, state, municipality, federation, competition, organisation, venue, event type, sport, role, age), when it takes effect, its source, who approves it and the evidence it requires. A version is immutable once written; changing a rule is a new version. Platform rules need the platform admin; organisation rules an owner or admin. A draft has no effect until approved.',
  input: z.object({ rule_id: id.optional(), ...Object.fromEntries(Object.entries(RULE_HEAD).map(([k, s]) => [k, s.optional()])), scope: RULE_HEAD.scope, ...VERSION }),
  handler: ({ user }, i) => tx((c) => addVersion(c, user, i)),
});

/** Approve or withdraw one draft version. Shared by the form and by approving a whole pack, so both obey the same rules. */
export async function decideVersion(c, user, id, decision) {
  const v = (await c.query('SELECT v.*, r.scope_kind, r.organisation_id FROM cmp_rule_versions v JOIN cmp_rules r ON r.id=v.rule_id WHERE v.id=$1 FOR UPDATE OF v', [id])).rows[0];
  if (!v) throw notFound('Rule version');
  await authorise(c, user, v);
  if (v.status !== 'draft') throw conflict(`This version is already ${v.status}`);
  const self = v.created_by === user.id;
  if (decision === 'approve' && self && ['legal_mandatory', 'regulatory'].includes(v.classification)) throw conflict('A law or regulation must be approved by a second person, not its author');
  const r = (await c.query("UPDATE cmp_rule_versions SET status=$2, approved_by=$3, approved_at=now(), self_approved=$4 WHERE id=$1 RETURNING id, version, status, self_approved, approved_at",
    [id, decision === 'approve' ? 'approved' : 'withdrawn', user.id, decision === 'approve' && self])).rows[0];
  await audit(c, user.id, `compliance_rule_version_${decision}`, 'cmp_rule_versions', id);
  return r;
}

cap({
  name: 'decide_policy_version', method: 'POST', path: '/compliance/versions/:id/decision', tag: TAG,
  summary: 'Approve a draft rule version so it takes part in decisions from its effective date, or withdraw the draft. Laws and regulations need a second person to approve (not their author); other rules may be self-approved, which is recorded and shown. Approved versions are never edited or deleted.',
  input: z.object({ id, decision: z.enum(['approve', 'withdraw']) }),
  handler: ({ user }, i) => tx((c) => decideVersion(c, user, i.id, i.decision)),
});

export const PACK_RULE = z.object({ ...Object.fromEntries(Object.entries(RULE_HEAD).filter(([k]) => ['key', 'domains', 'topic'].includes(k))), ...VERSION });
cap({
  name: 'import_policy_pack', method: 'POST', path: '/compliance/packs', tag: TAG, status: 201,
  summary: 'Platform admin: load a jurisdiction pack (a named set of rules written as data) as drafts, each to be approved on its own. A rule whose key already exists gets a new draft version. Nothing is applied until approved; no code changes are needed for a new country.',
  input: z.object({ pack_code: z.string().regex(/^[A-Za-z0-9._-]{2,40}$/), rules: z.array(PACK_RULE).min(1).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    await mustBePlatformAdmin(user);
    const out = [];
    for (const r of i.rules) {
      const existing = (await c.query("SELECT id FROM cmp_rules WHERE key=$1 AND scope_kind='platform'", [r.key])).rows[0];
      out.push(await addVersion(c, user, existing ? { ...r, rule_id: existing.id, pack_code: i.pack_code } : { ...r, scope: 'platform', pack_code: i.pack_code }));
    }
    return { pack_code: i.pack_code, drafts: out.length, versions: out };
  }),
});

cap({
  name: 'export_policy_pack', method: 'GET', path: '/compliance/packs/:country', tag: TAG,
  summary: 'The platform rules approved for a country (and those with no country) as a portable pack: the same shape import_policy_pack takes, so a pack can be reviewed, versioned elsewhere and loaded into another environment.',
  input: z.object({ country: iso2 }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT r.key, r.domains, r.topic, ${COLS} FROM cmp_rules r JOIN cmp_rule_versions v ON v.rule_id=r.id
        WHERE r.scope_kind='platform' AND v.status='approved' AND (v.country=$1 OR v.country IS NULL) ORDER BY r.key, v.version DESC`, [i.country]);
    const seen = new Set();
    const rules = rows.filter((r) => !seen.has(r.key) && seen.add(r.key)).map(({ key, domains, topic, title, summary, classification, country, region, municipality, applies, effective_from, effective_to, source_title, source_url, approval_owner, requirements, waivable, repeals, change_note }) =>
      ({ key, domains, topic, title, summary, classification, country, region, municipality, applies, effective_from, effective_to, source_title, source_url, approval_owner, requirements, waivable, repeals, change_note }));
    return { country: i.country, exported_at: new Date().toISOString(), note: 'A pack is a set of rules for people to review. It is not legal advice and not a certification.', rules };
  },
});
