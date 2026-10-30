// "What this service needs" (follow-up to #591): the list a buyer picks from is built from the event, never typed in from a fixed list.
//   rule       a live requirement from the compliance module (platform, the buyer's organisation, the event) that applies to this sport and subject
//   catalogue  what suppliers of this service family usually have to hold (the credential kinds the supplier profile can carry)
//   ai         an unverified draft from the event's facts: shown with a "verify" tag, never legally asserted, never enforced
//   custom     the buyer's own item
// Only an item with a credential kind that is not an AI draft is enforced (when quoting and at award); everything else is stated to suppliers in the RFQ scope.
// Weather, traffic and health advisories need a data source this installation does not have: the response says so instead of inventing alerts.
import { z } from 'zod';
import { many, one } from '../db.js';
import { badRequest } from '../errors.js';
import { ask, askJson, aiConfigured, quoteData, AI_RULES } from '../ai.js';
import { CREDENTIAL_KINDS } from '../capabilities/svc-supplier.js';

export const needItem = z.object({
  key: z.string().min(1).max(80), label: z.string().min(1).max(120), detail: z.string().max(300).optional(),
  source: z.enum(['rule', 'catalogue', 'ai', 'custom']), kind: z.enum(CREDENTIAL_KINDS).optional(), rule_id: z.string().uuid().optional(),
});

/** What suppliers of each family usually hold. Reference data about the service families, not demo data; unknown families fall back to insurance. */
const FAMILY_CREDENTIALS = {
  pool_maintenance: [['pool_operator', 'Pool operator certificate', 'Water treatment and pool plant work'], ['insurance', 'Public liability insurance', 'Work on a public facility']],
  event_crew: [['safeguarding', 'Safeguarding clearance', 'Crew work next to players, often young people'], ['first_aid', 'First aid certificate', 'Crew on the field of play']],
  electrical: [['electrical', 'Electrical qualification', 'Installation and testing'], ['insurance', 'Public liability insurance', 'Work on a public facility']],
  travel: [['vehicle', 'Vehicle and driver documents', 'Passenger transport'], ['insurance', 'Passenger insurance', 'Passenger transport']],
  catering: [['food_safety', 'Food safety certificate', 'Food served to teams and crowds'], ['business_registration', 'Business registration', 'Trading entity']],
  accommodation: [['business_registration', 'Business registration', 'Trading entity']],
};
const DEFAULT_CREDENTIALS = [['insurance', 'Public liability insurance', 'Work on a public facility']];
const sentence = (k) => k.replace(/_/g, ' ');

/** Keep only well-formed items; AI drafts can never carry an enforceable kind; rule ids must exist. Returns the items plus the enforceable credential kinds. */
export async function normaliseNeeds(c, items = []) {
  const seen = new Set(), out = [];
  for (const raw of items) {
    if (seen.has(raw.key)) continue;
    seen.add(raw.key);
    const it = { ...raw, label: quoteData(raw.label, 120), ...(raw.detail ? { detail: quoteData(raw.detail, 300) } : {}) };
    if (it.source === 'ai') delete it.kind;
    if (it.rule_id) {
      if (it.source !== 'rule') throw badRequest('Only a rule item can name a rule');
      if (!(await c.query('SELECT 1 FROM comp_requirements WHERE id=$1 AND archived_at IS NULL', [it.rule_id])).rowCount) throw badRequest(`The rule “${it.label}” no longer exists`);
    }
    out.push({ ...it, enforced: Boolean(it.kind) && it.source !== 'ai' });
  }
  return { needs: out, kinds: [...new Set(out.filter((x) => x.enforced).map((x) => x.kind))] };
}

async function eventFacts(buyer, input) {
  const eventId = input.event_id ?? buyer.event_id ?? null, venueId = input.venue_id ?? buyer.venue_id ?? null;
  const ev = eventId ? await one('SELECT e.id, e.kind, e.starts_on, e.ends_on, e.organisation_id, e.venue_id, s.name AS sport FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId]) : null;
  const sports = ev ? await many('SELECT DISTINCT s.id, s.name FROM sports s WHERE s.id IN (SELECT sport_id FROM events WHERE id=$1 UNION SELECT sport_id FROM event_disciplines WHERE event_id=$1)', [ev.id]) : [];
  const venue = (venueId ?? ev?.venue_id) ? await one('SELECT city FROM venues WHERE id=$1', [venueId ?? ev.venue_id]) : null;
  return { ev, sports, city: venue?.city ?? null };
}

const aiSchema = z.object({ items: z.array(z.object({ label: z.string().min(3).max(120), why: z.string().max(240).default('') })).max(8) });

/** The suggestion groups for one requirement-in-the-making. `ai` asks the model for extra drafts; without it, or if it fails, the other groups are unaffected. */
export async function suggestNeeds(buyer, input) {
  const { ev, sports, city } = await eventFacts(buyer, input);
  const orgs = [buyer.organisation_id, ev?.organisation_id].filter(Boolean);
  const rules = await many(
    `SELECT DISTINCT ON (r.id) r.id, r.code, r.name, r.description, r.source, r.scope_kind, coalesce(o.mandatory, true) AS mandatory
       FROM comp_requirements r LEFT JOIN comp_obligations o ON o.requirement_id=r.id AND o.archived_at IS NULL AND (o.ends_on IS NULL OR o.ends_on >= current_date)
      WHERE r.archived_at IS NULL AND r.subject_kind IN ('organisation','event')
        AND (r.scope_kind='platform' OR (r.scope_kind='organisation' AND r.scope_id = ANY($1)) OR (r.scope_kind='event' AND r.scope_id=$2))
        AND (o.sport_id IS NULL OR o.sport_id = ANY($3)) ORDER BY r.id`, [orgs, ev?.id ?? null, sports.map((s) => s.id)]);
  const ruleItems = rules.map((r) => ({
    key: `rule:${r.id}`, label: r.name, detail: [r.scope_kind === 'platform' ? 'Platform rule' : r.scope_kind === 'event' ? 'Set for this event' : 'Set by your organisation', r.mandatory ? null : 'recommended', r.description].filter(Boolean).join(' · ').slice(0, 300),
    source: 'rule', rule_id: r.id, ...(r.source?.kind === 'service_credential' && CREDENTIAL_KINDS.includes(r.source.credential_kind) ? { kind: r.source.credential_kind } : {}),
  }));
  const taken = new Set(ruleItems.map((x) => x.kind).filter(Boolean));
  const family = FAMILY_CREDENTIALS[input.category] ?? DEFAULT_CREDENTIALS;
  const catalogueItems = family.filter(([k]) => !taken.has(k)).map(([kind, label, why]) => ({ key: `catalogue:${input.category}:${kind}`, label, detail: `${why} · usual for ${sentence(input.category)}`, source: 'catalogue', kind }));

  let ai = { available: aiConfigured(), used: false, items: [] };
  if (input.ai && ai.available) {
    const facts = { service: sentence(input.category), purpose: ev?.kind ?? null, sports: sports.map((s) => quoteData(s.name, 60)), city: city ? quoteData(city, 60) : null, starts: input.starts_at?.slice(0, 10) ?? ev?.starts_on ?? null, ends: input.ends_at?.slice(0, 10) ?? ev?.ends_on ?? null,
      already: [...ruleItems, ...catalogueItems].map((x) => x.label) };
    const out = await askJson({
      system: `You help a sports event buyer think of checks, permits, certificates or conditions to ask a supplier about. Draft up to 6 short items that are specific to the facts given (the sport, the kind of event, the service, the place and season). Phrase each as something to check or hold, for example "Check local noise limits for setup hours". Never state that anything is legally required and never cite a specific law or number: you cannot verify local law, so every item is a prompt for a person to verify. Skip anything in "already". ${AI_RULES}`,
      user: `<data>${JSON.stringify(facts)}</data>`, schema: aiSchema, shape: '{"items":[{"label":"...","why":"..."}]}', maxTokens: 700 });
    if (out) {
      const have = new Set(facts.already.map((x) => x.toLowerCase()));
      ai = { available: true, used: true, items: out.items.filter((x) => !have.has(x.label.toLowerCase())).map((x, n) => ({ key: `ai:${Buffer.from(x.label).toString('base64url').slice(0, 40)}`, label: quoteData(x.label, 120), detail: quoteData(x.why, 240), source: 'ai', n })).map(({ n, ...x }) => x) };
    }
  }
  return {
    context: { sports: sports.map((s) => s.name), purpose: ev?.kind ?? null, city, starts_on: ev?.starts_on ?? null, ends_on: ev?.ends_on ?? null, category: input.category },
    groups: { rules: ruleItems, suggested: catalogueItems, ai: ai.items },
    ai: { available: ai.available, used: ai.used, note: 'AI drafts are unverified prompts for a person to check. They are never marked as legally required and never block a quote or award.' },
    live: { connected: false, sources: [], note: 'Weather, traffic and health advisories need a connected data source; none is connected, so none are shown.' },
  };
}
