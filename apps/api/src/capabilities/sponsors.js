import { badgesFor, withBadges } from '../verification.js';
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { decryptFields, encryptFields } from '../crypto.js';
import { notify } from '../notify.js';
import { tx } from '../db.js';
import { PUBLIC_USER } from '../helpers.js';
import { NOT_YOUTH_SQL, guardianLink, guardiansOf, isYouth } from '../youth.js';
import { guardedAthleteSql, isYouthDeal, liveAuthority, notifyRecipient, youthConflict } from '../youth-sponsorship.js';
import { LINE, buildSchedule } from '../sponsor-schedule.js';
import { entityRole, snapshotIdentity, ASSIGNED, CAN } from '../sponsor-identity-access.js';
import { endNow } from '../sponsor-termination.js';
import { saveLines, loadLines, generateObligations, logHistory } from '../sponsor-agreements.js';
import { proposerSide } from '../sponsor-renewals.js';
import { sponsorAccess, assertSponsorCan, notifySponsor, sponsorStaffSql } from '../sponsor-access.js';
import { assertDealFitsBudget, assertFits, convert, costOf, storedRate } from '../sponsorship-budgets.js';
import { ORG_TARGETS, beneficiaryScopeSql, beneficiaryAccess, primaryContact, targetOrgId } from '../sponsor-beneficiaries.js';

const CONTACT = ['contact_name', 'contact_email', 'contact_phone'];
const date = z.string().date();
const LOOKING_FOR = z.enum(['cash', 'equipment', 'travel', 'coaching', 'apparel', 'nutrition', 'media']);
const url = z.string().url().max(200);
/** The brand's public profile. Every field is optional; null clears one on update. */
const PROFILE = {
  tagline: z.string().max(120), about: z.string().max(2000), brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  founded_year: z.number().int().min(1800).max(new Date().getFullYear()), country: z.string().length(2),
  sports: z.array(z.string().min(1).max(60)).max(30), regions: z.array(z.string().min(1).max(80)).max(30),
  offers: z.array(LOOKING_FOR).max(7), backs: z.array(z.enum(['athlete', 'team', 'event'])).max(3),
  budget_currency: z.string().length(3), budget_min_cents: money, budget_max_cents: money,
  links: z.object({ instagram: url, linkedin: url, x: url, youtube: url }).partial().strict(),
};
const PROFILE_IN = Object.fromEntries(Object.entries(PROFILE).map(([k, v]) => [k, ['sports', 'regions', 'offers', 'backs', 'links'].includes(k) ? v.optional() : v.nullable().optional()]));
const ARRAYS = ['sports', 'regions', 'offers', 'backs'];

/** What a manager can still fill in to make the brand easier for athletes and organisers to trust and find. */
function completeness(s) {
  const checks = [
    ['about', 'Tell people about the brand', !!s.about], ['tagline', 'Add a one-line tagline', !!s.tagline], ['industry', 'Pick an industry', !!s.industry],
    ['website', 'Add the website', !!s.website], ['offers', 'Say what you can offer', s.offers?.length > 0], ['backs', 'Say who you back', s.backs?.length > 0],
    ['sports', 'Choose the sports you support', s.sports?.length > 0], ['budget', 'Give a budget range', s.budget_min_cents != null || s.budget_max_cents != null],
    ['country', 'Add the country', !!s.country], ['links', 'Link a social profile', Object.values(s.links ?? {}).some(Boolean)], ['contact', 'Add a contact email', !!s.contact_email_enc || !!s.has_contact],
  ];
  return { percent: Math.round((100 * checks.filter((x) => x[2]).length) / checks.length), missing: checks.filter((x) => !x[2]).map((x) => ({ key: x[0], label: x[1] })) };
}

async function checkProfile(c, i) {
  if (i.budget_min_cents != null && i.budget_max_cents != null && i.budget_min_cents > i.budget_max_cents) throw badRequest('The minimum budget cannot be above the maximum');
  if (i.sports?.length) {
    const found = (await c.query('SELECT slug FROM sports WHERE slug = ANY($1)', [i.sports])).rows.length;
    if (found !== new Set(i.sports).size) throw badRequest('One of those sports does not exist');
  }
}

/** Who has to approve a sponsorship offer aimed at this target. */
async function targetOwner(type, targetId) {
  if (type === 'event') return (await mustFind('events', targetId, 'organizer_id')).organizer_id;
  if (type === 'team') return (await mustFind('teams', targetId, 'owner_id')).owner_id;
  if (ORG_TARGETS.includes(type)) { // an organisation/group: its oldest active owner is notified; any live representative may act (see beneficiaryAccess)
    const owner = await primaryContact(pool, await targetOrgId(pool, type, targetId));
    if (!owner) throw conflict('This organisation has no active owner to answer an offer');
    return owner;
  }
  await mustFind('users', targetId, 'id');
  return targetId;
}

cap({
  name: 'create_sponsor', method: 'POST', path: '/sponsors', tag: 'Sponsors', status: 201,
  summary: 'Create a sponsor brand profile (the public display name). Contact name/email/phone are encrypted. Give `entity_id` to add the brand under a sponsor entity you own or administer; without it the brand has no confirmed identity yet — confirm it with set_sponsor_identity, the one place that creates and edits the sponsor legal identity.',
  input: z.object({ name: z.string().min(2).max(80), industry: z.string().max(60).optional(), website: z.string().url().optional(), emoji: z.string().max(8).optional(), contact_name: z.string().max(80).optional(), contact_email: z.string().email().optional(), contact_phone: z.string().max(30).optional(),
    entity_id: id.optional(), ...PROFILE_IN }),
  async handler({ user }, i) {
    if (!i.entity_id && !user.roles.includes('sponsor') && !isAdmin(user)) throw forbidden('Requires one of the roles: sponsor (or be invited to an existing sponsor entity)');
    const e = encryptFields(i, 'sponsors', CONTACT);
    return tx(async (c) => {
      let entityId = null;
      if (i.entity_id) {
        const role = await entityRole(c, user, i.entity_id);
        if (!role) throw notFound('Sponsor entity');
        if (!CAN.identity.includes(role)) throw forbidden('Only an owner or admin of this entity can add brands to it');
        entityId = i.entity_id;
      }
      await checkProfile(c, i);
      return (await c.query(`INSERT INTO sponsors(owner_id, name, industry, website, emoji, contact_name_enc, contact_email_enc, contact_phone_enc, entity_id,
          tagline, about, brand_color, founded_year, country, sports, regions, offers, backs, budget_currency, budget_min_cents, budget_max_cents, links)
        VALUES ($1,$2,$3,$4,coalesce($5,'💎'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id, name, industry, website, emoji, entity_id`,
        [user.id, i.name, i.industry, i.website, i.emoji, e.contact_name_enc ?? null, e.contact_email_enc ?? null, e.contact_phone_enc ?? null, entityId,
          i.tagline ?? null, i.about ?? null, i.brand_color ?? null, i.founded_year ?? null, i.country?.toUpperCase() ?? null, i.sports ?? [], i.regions ?? [], i.offers ?? [], i.backs ?? [],
          i.budget_currency ?? null, i.budget_min_cents ?? null, i.budget_max_cents ?? null, JSON.stringify(i.links ?? {})])).rows[0];
    });
  },
});

cap({
  name: 'update_sponsor', method: 'PATCH', path: '/sponsors/:id', tag: 'Sponsors',
  summary: 'Brand manager: edit the brand profile (name, tagline, about, industry, website, emoji and accent colour, country, sports, regions, what it offers and who it backs, budget range, social links, contact details). Only the fields you send change; send null to clear one. Contact details stay encrypted.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), industry: z.string().max(60).nullable().optional(), website: url.nullable().optional(), emoji: z.string().max(8).optional(),
    contact_name: z.string().max(80).nullable().optional(), contact_email: z.string().email().nullable().optional(), contact_phone: z.string().max(30).nullable().optional(), ...PROFILE_IN }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.id);
    if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, s), 'manage', { what: 'edit the brand profile' });
    return tx(async (c) => {
      await checkProfile(c, i);
      const sets = [], args = [i.id];
      const set = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
      for (const k of ['name', 'industry', 'website', 'emoji', 'tagline', 'about', 'brand_color', 'founded_year', 'budget_currency', 'budget_min_cents', 'budget_max_cents']) if (i[k] !== undefined) set(k, i[k]);
      if (i.country !== undefined) set('country', i.country?.toUpperCase() ?? null);
      for (const k of ARRAYS) if (i[k] !== undefined) set(k, i[k]);
      if (i.links !== undefined) set('links', JSON.stringify(i.links));
      const enc = encryptFields(Object.fromEntries(CONTACT.filter((k) => i[k]).map((k) => [k, i[k]])), 'sponsors', CONTACT);
      for (const k of CONTACT) { if (i[k] === null) set(`${k}_enc`, null); else if (enc[`${k}_enc`]) set(`${k}_enc`, enc[`${k}_enc`]); }
      if (!sets.length) throw badRequest('Nothing to change');
      const row = (await c.query(`UPDATE sponsors SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING id, name, industry, website, emoji`, args)).rows[0];
      await audit(c, user.id, 'update_profile', 'sponsors', i.id);
      return row;
    });
  },
});

cap({
  name: 'list_sponsors', method: 'GET', path: '/sponsors', tag: 'Sponsors', auth: 'public', summary: 'Sponsor directory: display name, industry, website, emoji, sponsor type and verified badge only; legal name, registration, billing and representatives are never listed. With mine=true (signed in): the brands you can act for as owner/creator, sponsor-entity representative or organisation staff, each with your sponsor role and whether its identity is confirmed.',
  input: z.object({ q: z.string().optional(), mine: z.coerce.boolean().optional().describe('only brands you act for (needs sign-in); each carries your sponsor role'), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT * FROM (SELECT sp.id, sp.name, sp.industry, sp.website, sp.emoji, sp.organisation_id, e.sponsor_type, sp.tagline, sp.brand_color, sp.sports, sp.offers, sp.backs, sp.about, sp.country, sp.links, (sp.contact_email_enc IS NOT NULL) AS has_contact, sp.budget_min_cents, sp.budget_max_cents, (sp.entity_id IS NOT NULL) AS identity_confirmed,
              (SELECT o.name FROM organisations o WHERE o.id=sp.organisation_id) AS organisation_name,
              CASE WHEN $5::uuid IS NULL THEN NULL
                   WHEN sp.entity_id IS NULL AND sp.owner_id=$5 THEN 'manager'
                   ELSE coalesce(
                     (SELECT CASE r.role WHEN 'owner' THEN 'manager' WHEN 'admin' THEN 'manager' WHEN 'portfolio_manager' THEN 'manager' ELSE r.role END FROM sponsor_representatives r
                       WHERE r.entity_id=sp.entity_id AND r.user_id=$5 AND r.status='active' AND (r.role<>'portfolio_manager' OR ${ASSIGNED}sp.id))),
                     (SELECT CASE m.role WHEN 'owner' THEN 'manager' WHEN 'admin' THEN 'manager' ELSE m.role END FROM organisation_members m
                       WHERE sp.entity_id IS NULL AND m.organisation_id=sp.organisation_id AND m.user_id=$5 AND m.status='active' AND m.role <> 'coach')) END AS my_role,
              (SELECT m.department_id FROM organisation_members m WHERE sp.entity_id IS NULL AND m.organisation_id=sp.organisation_id AND m.user_id=$5 AND m.status='active') AS my_department_id
         FROM sponsors sp LEFT JOIN sponsor_entities e ON e.id=sp.entity_id
        WHERE ($1::text IS NULL OR sp.name ILIKE '%'||$1||'%')) x
        WHERE (NOT $4 OR x.my_role IS NOT NULL) ORDER BY x.name, x.id LIMIT $2 OFFSET $3`, [i.q ?? null, i.limit, i.offset, !!i.mine, user?.id ?? null]);
    return withBadges('sponsor', rows.map((r) => {
      if (!i.mine) return { id: r.id, name: r.name, industry: r.industry, website: r.website, emoji: r.emoji, sponsor_type: r.sponsor_type, tagline: r.tagline, brand_color: r.brand_color, sports: r.sports, offers: r.offers };
      const { about, country, links, has_contact, budget_min_cents, budget_max_cents, ...rest } = r;
      return { ...rest, profile: r.my_role === 'manager' ? completeness(r) : null };
    }));
  },
});

cap({
  name: 'get_sponsor', method: 'GET', path: '/sponsors/:id', tag: 'Sponsors', auth: 'public',
  summary: 'Sponsor profile and active sponsorships. Contact details are returned only to the brand\'s managers (owners and admins of its sponsor entity, or its organisation managers); legal and billing identity is never returned here.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustFind('sponsors', i.id);
    const deals = await many("SELECT id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on FROM sponsorships WHERE sponsor_id=$1 AND status='active' AND visibility='public'", [i.id]);
    const type = s.entity_id ? (await one('SELECT sponsor_type FROM sponsor_entities WHERE id=$1', [s.entity_id])).sponsor_type : null;
    const out = { id: s.id, name: s.name, industry: s.industry, website: s.website, emoji: s.emoji, sponsor_type: type, tagline: s.tagline, about: s.about, brand_color: s.brand_color, founded_year: s.founded_year, country: s.country, sports: s.sports, regions: s.regions, offers: s.offers, backs: s.backs, links: s.links, verified: (await badgesFor('sponsor', [s.id])).get(s.id) ?? [], active_sponsorships: deals };
    const access = user ? await sponsorAccess(user, s) : null;
    if (user && (isAdmin(user) || access?.role === 'manager')) {
      await audit(null, user.id, 'read_pii', 'sponsors', s.id);
      Object.assign(out, decryptFields(s, 'sponsors', CONTACT), { my_role: access?.role ?? 'admin', budget_currency: s.budget_currency, budget_min_cents: s.budget_min_cents, budget_max_cents: s.budget_max_cents,
        profile: completeness(s),
        // athletes who opted in, fit what the brand offers and play a sport it supports
        matching_athletes: (await one(`SELECT count(*)::int AS n FROM sponsorship_profiles p JOIN users u ON u.id=p.user_id
           WHERE p.open_to_sponsors AND 'athlete' = ANY(u.roles) AND ${NOT_YOUTH_SQL} AND (cardinality($1::text[])=0 OR p.looking_for && $1::text[])
             AND (cardinality($2::text[])=0 OR EXISTS (SELECT 1 FROM sport_profiles x JOIN sports sp ON sp.id=x.sport_id WHERE x.user_id=u.id AND sp.slug = ANY($2::text[])))`, [s.offers, s.sports])).n });
    }
    return out;
  },
});

const DECLINE_COOLDOWN_DAYS = 30;

cap({
  name: 'get_my_sponsorship_profile', method: 'GET', path: '/me/sponsorship-profile', tag: 'Sponsors',
  summary: 'Your sponsorship discovery settings. Off by default: nobody can find you or send you an offer until you opt in.',
  handler: async ({ user }) => (await one('SELECT open_to_sponsors, pitch, looking_for, verified_sponsors_only, updated_at FROM sponsorship_profiles WHERE user_id=$1', [user.id]))
    ?? { open_to_sponsors: false, pitch: null, looking_for: [], verified_sponsors_only: false, updated_at: null },
});

cap({
  name: 'set_sponsorship_profile', method: 'POST', path: '/me/sponsorship-profile', tag: 'Sponsors',
  summary: 'Opt in or out of sponsorship discovery and set your public pitch. Only a handle, display name, sports, your pitch and what you are looking for are ever shown to sponsors; contact details never are. Turning it off hides you immediately; offers already sent stay yours to answer.',
  input: z.object({ open_to_sponsors: z.boolean(), pitch: z.string().max(600).nullable().optional(), looking_for: z.array(LOOKING_FOR).max(7).optional(), verified_sponsors_only: z.boolean().optional() }),
  async handler({ user }, i) {
    if (i.open_to_sponsors && !user.roles.includes('athlete')) throw forbidden('Add the athlete role to be open to sponsors');
    const cur = await one('SELECT * FROM sponsorship_profiles WHERE user_id=$1', [user.id]);
    const next = { pitch: i.pitch === undefined ? cur?.pitch ?? null : i.pitch, looking_for: i.looking_for ?? cur?.looking_for ?? [], verified_sponsors_only: i.verified_sponsors_only ?? cur?.verified_sponsors_only ?? false };
    return one(
      `INSERT INTO sponsorship_profiles(user_id, open_to_sponsors, pitch, looking_for, verified_sponsors_only) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET open_to_sponsors=$2, pitch=$3, looking_for=$4, verified_sponsors_only=$5, updated_at=now()
       RETURNING open_to_sponsors, pitch, looking_for, verified_sponsors_only, updated_at`,
      [user.id, i.open_to_sponsors, next.pitch, next.looking_for, next.verified_sponsors_only]);
  },
});

cap({
  name: 'discover_sponsorable_athletes', method: 'GET', path: '/sponsorable-athletes', tag: 'Sponsors', auth: ['sponsor'],
  summary: 'Sponsors: athletes who have explicitly opted in to sponsorship offers. Returns only public profile fields, their sports, pitch and what they are looking for; never contact details. Filter by sport, what they need, verified athletes and text.',
  input: z.object({ q: z.string().max(80).optional(), sport: z.string().max(60).optional().describe('sport slug'), looking_for: LOOKING_FOR.optional(), verified: z.coerce.boolean().optional(), ...page }),
  async handler(_, i) {
    const rows = await many(
      `SELECT ${PUBLIC_USER}, sp.pitch, sp.looking_for, sp.verified_sponsors_only,
              coalesce((SELECT array_agg(DISTINCT s.slug) FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id), '{}') AS sports
         FROM sponsorship_profiles sp JOIN users u ON u.id=sp.user_id
        WHERE sp.open_to_sponsors AND 'athlete' = ANY(u.roles) AND ${NOT_YOUTH_SQL}
          AND ($1::text IS NULL OR u.display_name ILIKE '%'||$1||'%' OR u.handle ILIKE '%'||$1||'%' OR sp.pitch ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM sport_profiles x JOIN sports s ON s.id=x.sport_id WHERE x.user_id=u.id AND s.slug=$2))
          AND ($3::text IS NULL OR $3 = ANY(sp.looking_for))
        ORDER BY u.display_name, u.id LIMIT $4 OFFSET $5`,
      [i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.sport ?? null, i.looking_for ?? null, i.limit, i.offset]);
    const out = await withBadges('user', rows);
    return i.verified ? out.filter((r) => r.verified?.length) : out;
  },
});

/**
 * Ties a new offer to an authorized budget (#293). The offer must be money in ONE currency; another currency than the budget's counts only
 * at an explicit sourced rate. An offer above the budget's approval threshold waits for a second person (budget_approval='pending') and the
 * recipient is not told about it until then. Proposals are only "planned": they never reduce what is available -- acceptance does, under lock.
 * Returns true when the offer is held for approval.
 */
export async function controlByBudget(c, user, sponsor, deal, budgetId, cash, input) {
  const b = (await c.query('SELECT * FROM sponsorship_budgets WHERE id=$1 AND sponsor_id=$2', [budgetId, sponsor.id])).rows[0];
  if (!b) throw badRequest('That budget does not belong to this brand');
  assertDealFitsBudget(b, { departmentId: input.department_id ?? deal.department_id, targetType: deal.target_type, targetId: deal.target_id });
  if (cash.length !== 1) throw unprocessable('A budget-controlled offer needs money lines in exactly one currency');
  const [cur, cents] = cash[0];
  const cost = await costOf(c, b, cur, cents);
  const needs = b.approval_over_cents != null && cost.cents > Number(b.approval_over_cents);
  await c.query('UPDATE sponsorships SET budget_id=$2, budget_fx_rate_id=$3, budget_approval=$4, budget_approval_by=NULL, budget_approval_at=NULL, budget_approval_note=NULL WHERE id=$1', [deal.id, b.id, cost.rateId, needs ? 'pending' : null]);
  if (needs) await notifySponsor(c, sponsor, 'budget_approve', { kind: 'sponsorship_budget', title: 'An offer needs budget approval', body: `An offer above the approval threshold of "${b.name}" needs a second approver before it is sent.`, data: { sponsorship_id: deal.id, budget_id: b.id } }, deal.department_id ?? null, user.id);
  return needs;
}

/** A budget is the brand's internal business: the recipient never sees which budget funds an offer, nor its approvals. */
const forRecipient = (r) => {
  if (r.i_am_sponsor) return r;
  const { budget_id, budget_fx_rate_id, budget_approval, budget_approval_by, budget_approval_at, budget_approval_note, ...rest } = r;
  return rest;
};

cap({
  name: 'propose_sponsorship', method: 'POST', path: '/sponsorships', tag: 'Sponsors', status: 201,
  summary: 'Offer sponsorship (money and/or in-kind support) to an event, team or athlete. The target owner must accept. An athlete can only be approached if they opted in (and, if they asked for it, only by verified sponsors); a sponsor cannot repeat an open offer, or re-offer within 30 days of a decline. Athlete offers state objectives, deliverables and a period.',
  input: z.object({
    budget_id: id.optional().describe('the authorized budget (annual, department or event) this offer draws on; its money must be in one currency, and an offer above the budget approval threshold waits for a second approver before the recipient sees it'),
    sponsor_id: id, department_id: id.optional().describe('the brand\'s department this deal belongs to (a department-scoped member can only use their own)'), target_type: z.enum(['event', 'team', 'athlete', 'organisation', 'group']), target_id: id, amount_cents: money.default(0), in_kind: z.string().max(200).optional(),
    starts_on: date.optional(), ends_on: date.optional(), objectives: z.string().max(1000).optional(), deliverables: z.string().max(1500).optional(), message: z.string().max(1000).optional(),
    lines: z.array(LINE).max(12).optional().describe('structured contribution lines (money / goods / endorsement, one-off or fixed-term recurring). Reviewable with preview_sponsorship_schedule; obligations are generated when the recipient accepts this exact version'),
    timezone: z.string().max(60).default('UTC'),
    client_ref: z.string().min(8).max(80).optional().describe('a unique reference the app generates once per offer form; sending the same reference again returns the offer already made instead of a second one (safe retry after a timeout or double tap)'),
  }),
  async handler({ user }, i) {
    if (i.client_ref) { // idempotent retry: the same person re-sending the same form gets the offer they already made
      const prior = (await pool.query('SELECT * FROM sponsorships WHERE proposed_by=$1 AND client_ref=$2', [user.id, i.client_ref])).rows[0];
      if (prior) return { ...prior, replayed: true };
    }
    const s = await mustFind('sponsors', i.sponsor_id);
    if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, s), 'propose', { departmentId: i.department_id ?? null, what: 'propose sponsorships' });
    if (i.department_id && !(s.organisation_id && (await one('SELECT 1 FROM org_departments WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.department_id, s.organisation_id])))) throw badRequest('That department does not belong to this brand\'s organisation');
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    const lines = i.lines ?? [];
    const plan = lines.length ? buildSchedule(lines, { starts_on: i.starts_on, ends_on: i.ends_on }) : null; // validates every line and the whole schedule up front
    const cash = plan ? Object.entries(plan.committed) : [];
    if (i.target_type === 'athlete') {
      if (!i.amount_cents && !i.in_kind && !lines.length) throw badRequest('Offer money, in-kind support, an endorsement, or a mix');
      if (!i.deliverables || !i.starts_on || !i.ends_on) throw badRequest('State the deliverables and the period (starts_on and ends_on) of the sponsorship');
    }
    const owner = await targetOwner(i.target_type, i.target_id);
    if (ORG_TARGETS.includes(i.target_type)) {
      const orgId = await targetOrgId(pool, i.target_type, i.target_id);
      const org = await one('SELECT status, open_to_sponsors FROM organisations WHERE id=$1', [orgId]);
      if (org.status !== 'active' || !org.open_to_sponsors) throw conflict('This organisation is not open to sponsorship offers');
      if (i.target_type === 'group' && !(await one("SELECT 1 FROM org_cohorts WHERE id=$1 AND status='active'", [i.target_id]))) throw conflict('This group is archived');
      if (s.organisation_id === orgId) throw badRequest('A brand cannot sponsor the organisation it belongs to');
      if (!i.deliverables && !lines.length && !i.amount_cents && !i.in_kind) throw badRequest('Offer money, in-kind support, an endorsement, or a mix');
    }
    return tx(async (c) => {
      if (i.target_type === 'athlete') {
        if (i.target_id === user.id) throw badRequest('You cannot sponsor yourself');
        // a young person is only reachable by a sponsor a verified guardian authorized by name; opting in to discovery never opens that door (#307)
        if (await isYouth(i.target_id, c)) { if (!(await liveAuthority(c, s.id, i.target_id))) throw youthConflict(); } else {
          const prof = (await c.query("SELECT sp.open_to_sponsors, sp.verified_sponsors_only FROM sponsorship_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.user_id=$1 AND 'athlete' = ANY(u.roles)", [i.target_id])).rows[0];
          // an institution's introduction (which the athlete consented to) lets that one sponsor make an offer even when discovery is off
          const introduced = !prof?.open_to_sponsors && (await c.query("SELECT 1 FROM enquiry_sponsor_links l JOIN enquiries e ON e.id=l.enquiry_id WHERE l.sponsor_id=$1 AND e.athlete_id=$2 AND l.status='introduced' AND e.sponsor_consent", [s.id, i.target_id])).rowCount > 0;
          if (!prof?.open_to_sponsors && !introduced) throw conflict('This athlete is not open to sponsorship offers');
          if (prof?.verified_sponsors_only && !(await badgesFor('sponsor', [s.id])).get(s.id)?.length) throw forbidden('This athlete only accepts offers from verified sponsors');
        }
        const open = (await c.query("SELECT 1 FROM sponsorships WHERE sponsor_id=$1 AND target_type='athlete' AND target_id=$2 AND status='proposed'", [s.id, i.target_id])).rows[0];
        if (open) throw conflict('You already have an open offer to this athlete');
        const declined = (await c.query("SELECT 1 FROM sponsorships WHERE sponsor_id=$1 AND target_type='athlete' AND target_id=$2 AND status='declined' AND decided_at > now() - make_interval(days => $3)", [s.id, i.target_id, DECLINE_COOLDOWN_DAYS])).rows[0];
        if (declined) throw conflict(`This athlete declined your last offer; you can offer again after ${DECLINE_COOLDOWN_DAYS} days`);
      }
      const row = (await c.query(
        `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, in_kind, starts_on, ends_on, proposed_by, objectives, deliverables, message, visibility, department_id, client_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [i.sponsor_id, i.target_type, i.target_id, i.amount_cents || (cash.length === 1 ? cash[0][1] : 0), i.in_kind, i.starts_on, i.ends_on, user.id, i.objectives ?? null, i.deliverables ?? null, i.message ?? null, i.target_type === 'athlete' ? 'private' : 'public', i.department_id ?? null, i.client_ref ?? null])).rows[0];
      if (lines.length) {
        Object.assign(row, (await c.query("UPDATE sponsorships SET agreement_ref='SPA-'||upper(substr(id::text,1,8)), timezone=$2, currency=$3 WHERE id=$1 RETURNING agreement_ref, timezone, currency, terms_version", [row.id, i.timezone, cash.length === 1 ? cash[0][0] : null])).rows[0]);
        await saveLines(c, row.id, 1, lines);
      }
      await snapshotIdentity(c, row.id, 1, s.id, user.id);
      await logHistory(c, row.id, 1, user.id, 'proposed');
      const held = i.budget_id ? await controlByBudget(c, user, s, row, i.budget_id, cash, i) : false;
      if (!held) await notifyRecipient(c, owner, { kind: 'sponsorship_offer', title: 'You have a sponsorship offer', body: `${s.name} sent an offer. Open it to review and answer.`, data: { sponsorship_id: row.id } });
      return i.budget_id ? { ...row, budget_id: i.budget_id, budget_approval: held ? 'pending' : null } : row;
    });
  },
});

cap({
  name: 'list_sponsorships', method: 'GET', path: '/sponsorships', tag: 'Sponsors',
  summary: 'Deals you are part of: ones you proposed, or offers aimed at things you own (events, teams, yourself), with who/what each is about, the terms, status and decision. `as` narrows to what you sent or what you received.',
  input: z.object({ status: z.enum(['proposed', 'active', 'declined', 'ended', 'withdrawn', 'paused', 'term_expired', 'completed']).optional(), as: z.enum(['sponsor', 'target']).optional(), organisation_id: id.optional().describe('only agreements aimed at this organisation or its groups (still limited to what you may see)'), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ss.*, sp.name AS sponsor_name, sp.emoji AS sponsor_emoji, ${sponsorStaffSql(1)} AS i_am_sponsor,
            CASE ss.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=ss.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=ss.target_id) WHEN 'organisation' THEN (SELECT name FROM organisations WHERE id=ss.target_id) WHEN 'group' THEN (SELECT name FROM org_cohorts WHERE id=ss.target_id) ELSE (SELECT name FROM events WHERE id=ss.target_id) END AS target_name,
            EXISTS (SELECT 1 FROM verification_cases v WHERE v.type='sponsor' AND v.subject_id=sp.id AND v.status='approved' AND v.expires_at > now()) AS sponsor_verified
       FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
      WHERE (($5::text IS DISTINCT FROM 'target' AND ${sponsorStaffSql(1)})
         OR ($5::text IS DISTINCT FROM 'sponsor' AND ((ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
              OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1) OR ${guardedAthleteSql('ss')} OR ${beneficiaryScopeSql('$1')})))
        AND ($2::text IS NULL OR ss.status=$2) AND (coalesce(ss.budget_approval,'') NOT IN ('pending','rejected') OR ${sponsorStaffSql(1)})
        AND ($6::uuid IS NULL OR (ss.target_type='organisation' AND ss.target_id=$6) OR (ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$6)))
      ORDER BY ss.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset, i.as ?? null, i.organisation_id ?? null]).then((rows) => rows.map(forRecipient)),
});

cap({
  name: 'withdraw_sponsorship', method: 'POST', path: '/sponsorships/:id/withdraw', tag: 'Sponsors',
  summary: 'Sponsor owner: take back an offer that has not been answered yet. The offer and its history are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Sponsorship');
      const sp = await mustFind('sponsors', d.sponsor_id);
      const byRecipient = !!d.renews_id && await proposerSide(c, d) === 'recipient'; // a renewal the recipient proposed is theirs to take back (#299)
      if (byRecipient) {
        const ben = ORG_TARGETS.includes(d.target_type) ? await beneficiaryAccess(c, user.id, d) : null;
        if (!isAdmin(user) && !(ben ? ben.representative : user.id === await targetOwner(d.target_type, d.target_id))) throw forbidden('Only the side that proposed the renewal can withdraw it');
      } else if (!isAdmin(user)) assertSponsorCan(await sponsorAccess(user, sp), 'withdraw', { departmentId: d.department_id, what: 'withdraw offers' });
      if (d.status !== 'proposed') throw conflict('Only an offer that has not been answered can be withdrawn');
      const row = (await c.query("UPDATE sponsorships SET status='withdrawn', decided_at=now(), decided_by=$2 WHERE id=$1 RETURNING *", [d.id, user.id])).rows[0];
      const gone = { kind: 'sponsorship_update', title: 'A sponsorship offer was withdrawn', body: `${byRecipient ? 'The recipient' : sp.name} withdrew the offer.`, data: { sponsorship_id: d.id } };
      if (byRecipient) await notifySponsor(c, sp, 'read', gone, d.department_id, user.id);
      else await notify(c, await targetOwner(d.target_type, d.target_id), gone);
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship', method: 'PATCH', path: '/sponsorships/:id', tag: 'Sponsors',
  summary: 'Target owner accepts/declines an offer (athletes can add a reason and choose whether the deal is shown publicly on the sponsor page, default private); either side can end an active deal.',
  input: z.object({ id, status: z.enum(['active', 'declined', 'ended']), reason: z.string().max(500).optional(), show_publicly: z.boolean().optional(), version: z.coerce.number().int().positive().optional().describe('the exact terms version being accepted; required for an agreement with contribution lines, and a stale version is rejected') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Sponsorship');
      const sp = await mustFind('sponsors', d.sponsor_id);
      const owner = await targetOwner(d.target_type, d.target_id);
      const access = await sponsorAccess(user, sp, c);
      const ben = ORG_TARGETS.includes(d.target_type) ? await beneficiaryAccess(c, user.id, d) : null;
      const youthD = await isYouthDeal(c, d), guardian = youthD ? await guardianLink(user.id, d.target_id, c) : null; // a young athlete's verified guardian is the one who answers (#307)
      const isTarget = ben ? ben.representative : user.id === owner || !!guardian, isSponsor = !!access && (!access.departmentId || access.departmentId === d.department_id);
      if (!isSponsor && !isAdmin(user) && ['pending', 'rejected'].includes(d.budget_approval)) throw notFound('Sponsorship'); // an offer awaiting internal budget approval is not the recipient's to see yet
      if (isSponsor && !isTarget && !isAdmin(user) && i.status === 'ended') assertSponsorCan(access, 'end', { departmentId: d.department_id, what: 'end agreements' });
      // Whoever did not write the current terms signs them off (the recipient signs the sponsor's offer, the sponsor signs a counteroffer);
      // you can never accept your own terms, and a platform admin cannot bind a brand to a counteroffer.
      const signsOff = i.status === 'active' && d.terms_side === 'recipient';
      if (signsOff) {
        if (!isSponsor) throw forbidden('Only the sponsor can sign off the recipient\'s counteroffer');
        assertSponsorCan(access, 'sign_off', { departmentId: d.department_id, what: 'sign off a counteroffer' });
      } else if (i.status === 'declined' && d.renews_id && isSponsor && !isTarget && await proposerSide(c, d) === 'recipient') {
        assertSponsorCan(access, 'sign_off', { departmentId: d.department_id, what: 'decline a renewal' }); // a renewal the recipient proposed is the sponsor's to decline (#299)
      } else if (!isAdmin(user)) {
        if (i.status === 'ended' ? !(isSponsor || isTarget) : !isTarget) throw forbidden();
      }
      if (youthD && !guardian && !isSponsor) { // neither the young person nor a platform admin can consent for them
        if (!signsOff && ['active', 'declined'].includes(i.status)) throw forbidden('Only a verified guardian can accept or decline a sponsorship for a young person');
        if (i.status === 'ended' && user.id === owner && (await guardiansOf(d.target_id, c)).length) throw forbidden('Your guardian manages this sponsorship for you');
      }
      if (youthD && i.status === 'active' && !signsOff && !(await liveAuthority(c, d.sponsor_id, d.target_id))) throw conflict('The guardian\'s authority for this sponsor is not in force, so this offer cannot be accepted');
      if (['declined', 'ended', 'withdrawn'].includes(d.status)) throw conflict(`Sponsorship already ${d.status}`);
      if (i.status === 'ended' && !['active', 'paused'].includes(d.status)) throw badRequest('Only active or paused deals can be ended');
      if (i.status !== 'ended' && d.status !== 'proposed') throw conflict(`Sponsorship is already ${d.status}`);
      const hasLines = (await c.query('SELECT 1 FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 LIMIT 1', [d.id, d.terms_version])).rowCount > 0;
      if (i.status === 'active' && hasLines) {
        if (i.version == null) throw badRequest('Accept a specific version of the terms (version)');
        if (i.version !== d.terms_version) throw conflict(`These terms changed (now version ${d.terms_version}); review them again before accepting`);
      }
      if (i.status === 'active' && d.budget_id) { // the authorized budget is checked, and held, under lock before the recipient's acceptance commits it (#293)
        if (d.budget_approval === 'pending') throw conflict('This offer is waiting for internal approval and cannot be accepted yet');
        if (d.budget_approval === 'rejected') throw conflict('This offer was not approved');
        const lines = await loadLines(c, d.id, d.terms_version);
        const span = (await c.query('SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM sponsorships WHERE id=$1', [d.id])).rows[0];
        const [cur, cents] = Object.entries(buildSchedule(lines, { starts_on: span.starts_on, ends_on: span.ends_on }).committed)[0] ?? [];
        if (cur) {
          const b0 = (await c.query('SELECT currency FROM sponsorship_budgets WHERE id=$1', [d.budget_id])).rows[0];
          await assertFits(c, d.budget_id, convert(cents, cur, b0.currency, await storedRate(c, d.budget_fx_rate_id)), { what: 'Accepting this offer' });
        }
      }
      const visibility = youthD ? 'private' : i.status === 'active' && d.target_type === 'athlete' && i.show_publicly !== undefined ? (i.show_publicly ? 'public' : 'private') : d.visibility;
      // Ending is recorded as a termination applied now (same safe debt handling: only untouched future dues stop); the notice workflow is in sponsorship-termination.js (#298)
      if (i.status === 'ended') await endNow(c, { d, sp }, user, isSponsor && !isTarget ? 'sponsor' : 'recipient', { reason: i.reason });
      const row = (await c.query('UPDATE sponsorships SET status=$2, decision_reason=coalesce($3, decision_reason), decided_at=now(), decided_by=$4, visibility=$5 WHERE id=$1 RETURNING *', [i.id, i.status, i.reason ?? null, user.id, visibility])).rows[0];
      if (guardian && ['active', 'declined'].includes(i.status)) await c.query('UPDATE sponsorships SET guardian_id=$2, guardian_decided_at=now() WHERE id=$1', [d.id, user.id]);
      if (i.status === 'active') await c.query('UPDATE sponsorship_versions SET signed_off_by=$3, signed_off_at=now() WHERE sponsorship_id=$1 AND version=$2', [d.id, d.terms_version, user.id]);
      if (i.status === 'active' && signsOff) await snapshotIdentity(c, d.id, d.terms_version, sp.id, user.id); // the brand is frozen as it was when it signed
      if (i.status === 'active' && hasLines) {
        await c.query('UPDATE sponsorships SET accepted_version=terms_version WHERE id=$1', [d.id]);
        await generateObligations(c, d.id);
      }
      if (i.status === 'active' && d.renews_id) { // the renewal was accepted at an exact version: that is the only way a successor starts
        const prev = (await c.query('SELECT accepted_version FROM sponsorships WHERE id=$1', [d.renews_id])).rows[0];
        await logHistory(c, d.renews_id, prev?.accepted_version ?? null, user.id, 'renewed', `successor ${row.agreement_ref ?? d.id} accepted at version ${d.terms_version}`);
        await c.query('UPDATE sponsorships SET renewal_rev=renewal_rev+1 WHERE id=$1', [d.renews_id]);
      }
      if (i.status !== 'ended') await logHistory(c, d.id, d.terms_version, user.id, { active: signsOff ? 'signed_off' : 'accepted', declined: 'declined' }[i.status], i.reason);
      const word = { active: 'accepted', declined: 'declined', ended: 'ended' }[i.status];
      const update = { kind: 'sponsorship_update', title: `Sponsorship ${word}`, body: i.status === 'declined' && i.reason ? i.reason : `A sponsorship with ${sp.name} was ${word}.`, data: { sponsorship_id: d.id } };
      if (isSponsor && !isTarget || signsOff) await notifyRecipient(c, owner, update);
      else await notifySponsor(c, sp, 'read', update, d.department_id, user.id);
      return row;
    });
  },
});
