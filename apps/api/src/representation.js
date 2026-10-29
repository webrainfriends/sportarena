// Sports agent & player representation (issue #484): the mandate layer. Everything an agent may see or do for an athlete is decided here, live, on every
// call (REST, MCP, exports): nothing is cached, so revoking, expiry, a lapsed verification or a withdrawn guardian consent stop access at once while the
// business records (terms, notes, commission, history) stay. A role alone never grants anything: access needs a mandate in force, a purpose in it, a data
// category in it, an action in it and - for private items - a grant the athlete (or guardian) made for that exact item.
import { z } from 'zod';
import { pool } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notify } from './notify.js';
import { guardianLink, guardiansOf, hasConsent, isYouth } from './youth.js';
import { RULES } from './verification.js';
import { decrypt, encrypt } from './crypto.js';

export const db = (c) => c ?? pool;
const iso = (d) => d.toISOString().slice(0, 10);
export const todayIso = () => iso(new Date());
/** A date column read from Postgres (a local-midnight Date) or an ISO string, as yyyy-mm-dd. */
export const dayOf = (v) => (v == null ? null : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

// ------------------------------------------------------------------ vocabulary (the published access matrix is built from these)
export const PURPOSES = {
  opportunity_outreach: 'Opportunity outreach',
  contract_negotiation: 'Contract negotiation assistance',
  transfer_assistance: 'Transfer assistance',
  sponsorship_commercial: 'Sponsorship and commercial representation',
  media_endorsement: 'Media and endorsement representation',
};
export const DATA_ACCESS = {
  public_passport: 'Public Sports Passport (what anyone can already see)',
  recruitment_materials: 'Selected private recruitment materials (videos you pick one by one)',
  opportunity_applications: 'Specific opportunity applications you pick',
  contract_workflow: 'Specific player-contract discussions you pick',
  transfer_workflow: 'Specific transfer or loan workflows you pick',
  sponsorship_discussions: 'Specific sponsorship agreements you pick',
};
export const CONTACT_ACTIONS = {
  share_opportunities: 'Share opportunities with me',
  express_interest: 'Ask me to approve expressing interest',
  draft_applications: 'Draft an application for me to review and submit',
  manage_conversations: 'Log and manage conversations with clubs and sponsors',
  track_pipeline: 'Track my opportunity pipeline',
};
/** Never part of any mandate, whatever is ticked. The schema has no way to name them. */
export const NEVER_SHARED = ['Medical and health records', 'Private coaching notes', 'Family finances', 'Passwords and sign-in details', 'Messages unrelated to the representation'];
/** A purpose that reaches into a private workflow needs that workflow's data category in the same mandate. */
export const PURPOSE_NEEDS = { contract_negotiation: 'contract_workflow', transfer_assistance: 'transfer_workflow', sponsorship_commercial: 'sponsorship_discussions' };
export const CATEGORY_SUBJECT = { recruitment_materials: 'passport_video', opportunity_applications: 'billboard_response', contract_workflow: 'player_contract', transfer_workflow: 'transfer', sponsorship_discussions: 'sponsorship' };
export const SUBJECT_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_SUBJECT).map(([k, v]) => [v, k]));
export const SUBJECT_PURPOSE = { passport_video: 'opportunity_outreach', billboard_response: 'opportunity_outreach', player_contract: 'contract_negotiation', transfer: 'transfer_assistance', sponsorship: 'sponsorship_commercial' };
/** #478 (transfers, loans, clearances) is not on main yet: a transfer cannot be granted until its workflow exists. Flip when it ships and add its ownership check in representation-access.js. */
export const TRANSFER_WORKFLOW_AVAILABLE = false;
export const STAFF_PERMS = ['view', 'outreach', 'negotiate', 'commission'];
/** The guardian consent (youth.js) a young person's mandate needs for each thing; checked live, so withdrawing it stops access at once. */
export const CONSENT_FOR = {
  opportunity_outreach: 'recruitment', recruitment_materials: 'recruitment', opportunity_applications: 'recruitment', public_passport: 'recruitment',
  contract_negotiation: 'participation', contract_workflow: 'participation', transfer_assistance: 'participation', transfer_workflow: 'participation',
  sponsorship_commercial: 'media', sponsorship_discussions: 'media', media_endorsement: 'media', manage_conversations: 'contact',
};
export const CONFLICT_KINDS = ['opposing_sides', 'agent_interest', 'dual_representation', 'related_party'];
/** Conflict kinds an athlete cannot simply accept (policy, configurable). The platform never decides whether a conflict is legally acceptable. */
export const noWaiver = () => (process.env.REPRESENTATION_NO_WAIVER ?? 'opposing_sides').split(',').map((s) => s.trim()).filter(Boolean);
export const APPROVAL_DAYS = () => Number(process.env.REPRESENTATION_APPROVAL_DAYS ?? 14);
/** Things that are never delegated, whatever a mandate says: they stay with the athlete or guardian in the canonical workflow. */
export const ATHLETE_ONLY = ['accept a playing position or offer', 'sign a contract or an amendment', 'approve a transfer or loan for the athlete', 'accept a sponsorship agreement'];

// ------------------------------------------------------------------ terms
const day = z.string().date();
const code = z.string().trim().toUpperCase().regex(/^([A-Z]{2}|WW)$/, 'Use a two-letter country code, or WW for worldwide');
const cur = z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const cents = (min = 0) => z.coerce.number().int().min(min).max(10_000_000_000_000);
const termBase = {
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80).optional(),
  applies_to: z.array(z.enum(['player_contract', 'sponsorship'])).min(1),
  currency: cur,
  effective_from: day, effective_to: day,
  facts_until: day.nullish(),
  cap_cents: cents(1).nullish(),
  threshold_cents: cents(0).nullish(),
};
export const commissionTermSchema = z.discriminatedUnion('basis', [
  z.object({ ...termBase, basis: z.literal('fixed'), fixed_cents: cents(1) }),
  z.object({ ...termBase, basis: z.literal('percentage'), rate_bp: z.coerce.number().int().min(1).max(5000), calc_on: z.enum(['earned', 'paid']).default('earned') }),
  z.object({ ...termBase, basis: z.literal('milestone'), milestones: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(80), amount_cents: cents(1) })).min(1).max(20) }),
]);
export const mandateTermsSchema = z.object({
  sport_ids: z.array(z.string().uuid()).min(1).max(300),
  territories: z.array(code).min(1).max(250),
  purposes: z.array(z.enum(Object.keys(PURPOSES))).min(1),
  exclusive: z.boolean().default(false),
  starts_on: day,
  ends_on: day,
  notice_days: z.coerce.number().int().min(0).max(365).nullish(),
  notice_terms_ref: z.string().trim().max(200).nullish(),
  data_access: z.array(z.enum(Object.keys(DATA_ACCESS))).default([]),
  contact_actions: z.array(z.enum(Object.keys(CONTACT_ACTIONS))).default([]),
  allow_staff: z.boolean().default(false),
  licence_id: z.string().uuid().nullish(),
  commission: z.array(commissionTermSchema).max(10).default([]),
});
const uniq = (a) => [...new Set(a)].sort();

export function normaliseTerms(t) {
  if (t.ends_on < t.starts_on) throw badRequest('The mandate cannot end before it starts');
  const span = (Date.parse(`${t.ends_on}T00:00:00Z`) - Date.parse(`${t.starts_on}T00:00:00Z`)) / 864e5;
  if (span > 366 * 5) throw badRequest('A mandate runs for at most five years; renew it to continue');
  const out = {
    sport_ids: uniq(t.sport_ids), territories: uniq(t.territories), purposes: uniq(t.purposes), exclusive: !!t.exclusive,
    starts_on: t.starts_on, ends_on: t.ends_on, notice_days: t.notice_days ?? null, notice_terms_ref: t.notice_terms_ref || null,
    data_access: uniq(t.data_access ?? []), contact_actions: uniq(t.contact_actions ?? []), allow_staff: !!t.allow_staff, licence_id: t.licence_id ?? null, commission: [],
  };
  if (out.territories.includes('WW') && out.territories.length > 1) throw badRequest('Worldwide (WW) already covers every territory; remove the others');
  for (const p of out.purposes) {
    const need = PURPOSE_NEEDS[p];
    if (need && !out.data_access.includes(need)) throw badRequest(`${PURPOSES[p]} needs "${DATA_ACCESS[need]}" to be allowed in the same mandate`, { code: 'purpose_needs_access', purpose: p, needs: need });
  }
  if (out.purposes.includes('opportunity_outreach') && !out.contact_actions.length) throw badRequest('Opportunity outreach needs at least one allowed action (for example sharing opportunities)');
  if (out.data_access.includes('opportunity_applications') && !out.purposes.includes('opportunity_outreach')) throw badRequest('Application access belongs to opportunity outreach; add that purpose');
  if (out.data_access.includes('recruitment_materials') && !out.purposes.includes('opportunity_outreach')) throw badRequest('Recruitment materials belong to opportunity outreach; add that purpose');
  const keys = new Set();
  for (const c of t.commission ?? []) {
    if (keys.has(c.key)) throw badRequest(`Two commission terms share the key "${c.key}"`);
    keys.add(c.key);
    if (c.effective_to < c.effective_from) throw badRequest(`Commission term "${c.key}" ends before it starts`);
    if (c.effective_from < out.starts_on || c.effective_to > out.ends_on) throw badRequest(`Commission term "${c.key}" must fall inside the mandate period`);
    if (c.applies_to.includes('player_contract') && !out.purposes.includes('contract_negotiation')) throw badRequest(`Commission on player contracts needs the "${PURPOSES.contract_negotiation}" purpose`);
    if (c.applies_to.includes('sponsorship') && !out.purposes.some((p) => p === 'sponsorship_commercial' || p === 'media_endorsement')) throw badRequest('Commission on sponsorship needs the sponsorship or endorsement purpose');
    if (c.basis === 'milestone') { const mk = new Set(c.milestones.map((m) => m.key)); if (mk.size !== c.milestones.length) throw badRequest(`Milestones of "${c.key}" share a key`); }
    out.commission.push({ ...c, applies_to: uniq(c.applies_to), label: c.label ?? c.key, facts_until: c.facts_until ?? null, cap_cents: c.cap_cents ?? null, threshold_cents: c.threshold_cents ?? null });
  }
  return out;
}

const FIELDS = { sport_ids: 'Sports', territories: 'Territories', purposes: 'Purposes', exclusive: 'Exclusive', starts_on: 'Start date', ends_on: 'End date', notice_days: 'Notice (days)', notice_terms_ref: 'Termination terms reference', data_access: 'Data the agent may see', contact_actions: 'Actions the agent may take', allow_staff: 'Agency staff may act', licence_id: 'Licence relied on' };
/** Field-by-field difference between two sets of terms (`from` is null for a first version). */
export function diffTerms(from, to) {
  const out = [];
  for (const [f, label] of Object.entries(FIELDS)) {
    const a = from ? from[f] : undefined, b = to[f];
    if (!from || JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push({ field: f, label, from: from ? a ?? null : null, to: b ?? null });
  }
  const fa = new Map((from?.commission ?? []).map((c) => [c.key, c])), fb = new Map(to.commission.map((c) => [c.key, c]));
  for (const [k, c] of fb) {
    const p = fa.get(k);
    if (!p) out.push({ field: `commission:${k}`, label: `Commission ${c.label}`, from: null, to: summariseTerm(c), change: 'added' });
    else if (JSON.stringify(p) !== JSON.stringify(c)) out.push({ field: `commission:${k}`, label: `Commission ${c.label}`, from: summariseTerm(p), to: summariseTerm(c), change: 'changed' });
  }
  for (const [k, c] of fa) if (!fb.has(k)) out.push({ field: `commission:${k}`, label: `Commission ${c.label}`, from: summariseTerm(c), to: null, change: 'removed' });
  return out;
}
export function summariseTerm(t) {
  const money = (n) => `${(Number(n) / 100).toFixed(2)} ${t.currency}`;
  const base = t.basis === 'fixed' ? `Fixed ${money(t.fixed_cents)}` : t.basis === 'percentage' ? `${(t.rate_bp / 100).toFixed(2)}% of ${t.calc_on === 'paid' ? 'paid' : 'earned'}` : `Milestones: ${t.milestones.map((m) => `${m.label} ${money(m.amount_cents)}`).join(', ')}`;
  return `${base}${t.threshold_cents ? `, above ${money(t.threshold_cents)}` : ''}${t.cap_cents ? `, capped at ${money(t.cap_cents)}` : ''} · deals in force ${t.effective_from} to ${t.effective_to}`;
}
export const termsOf = (v) => ({
  sport_ids: v.sport_ids, territories: v.territories, purposes: v.purposes, exclusive: v.exclusive, starts_on: dayOf(v.starts_on), ends_on: dayOf(v.ends_on), notice_days: v.notice_days, notice_terms_ref: v.notice_terms_ref,
  data_access: v.data_access, contact_actions: v.contact_actions, allow_staff: v.allow_staff, licence_id: v.licence_id, commission: v.commission,
});
export const VERSION_COLS = `id, mandate_id, version, kind, status, based_on, sport_ids, territories, purposes, exclusive, starts_on::text AS starts_on, ends_on::text AS ends_on, notice_days, notice_terms_ref, data_access, contact_actions, allow_staff, licence_id, commission, reason, changes, required_parties, proposed_by, proposed_at, decided_at, row_version, created_at`;
export const requiredParties = ({ youth }) => (youth ? ['guardian', 'athlete', 'agent'] : ['athlete', 'agent']);
export const versionsOf = async (c, mandateId) => (await db(c).query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 ORDER BY version`, [mandateId])).rows;
export const inForce = async (c, mandate) => (mandate.current_version == null ? null : (await db(c).query(`SELECT ${VERSION_COLS} FROM representation_mandate_versions WHERE mandate_id=$1 AND version=$2`, [mandate.id, mandate.current_version])).rows[0] ?? null);

// ------------------------------------------------------------------ agent identity and standing
/** Verification standing, read live: the badge is the platform's own verification case ('agent'); what was checked comes from the reviewer's checklist. */
export async function agentStanding(c, agent) {
  const kase = (await db(c).query(
    `SELECT id, decided_at, expires_at, checklist FROM verification_cases WHERE type='agent' AND subject_type='user' AND subject_id=$1 AND status='approved' AND expires_at > now() ORDER BY decided_at DESC LIMIT 1`, [agent.user_id])).rows[0] ?? null;
  const labels = new Map(RULES.agent.checklist.map((i) => [i.key, i.label]));
  const checked = kase ? (kase.checklist ?? []).filter((x) => x.ok).map((x) => ({ key: x.key, label: labels.get(x.key) ?? x.key, note: x.note ?? null })) : [];
  const lic = (await db(c).query(
    `SELECT l.id, l.issuing_body, l.grade, l.jurisdiction, l.sport_id, l.reference_last4, l.valid_from::text AS valid_from, l.valid_to::text AS valid_to, l.status, l.verified_case_id, l.verified_at,
            EXISTS (SELECT 1 FROM verification_cases k WHERE k.id=l.verified_case_id AND k.status='approved' AND k.expires_at > now()) AS case_current
       FROM agent_licences l WHERE l.agent_id=$1 AND l.status='declared' ORDER BY l.created_at, l.id`, [agent.id])).rows;
  const today = todayIso();
  const licences = lic.map((l) => ({ ...l, standing: l.valid_to && l.valid_to < today ? 'expired' : l.verified_case_id && l.case_current ? 'verified' : 'declared' }));
  return {
    verified: !!kase, case_id: kase?.id ?? null, verified_at: kase?.decided_at ?? null, expires_at: kase?.expires_at ?? null, checked,
    statement: kase ? 'Checked by the SportArena review team against the evidence listed. This is not a statement that the agent is licensed everywhere, nor a legal opinion.' : 'Not verified by SportArena.',
    licences,
  };
}

export async function loadAgent(c, id) {
  const a = (await db(c).query('SELECT * FROM agent_profiles WHERE id=$1', [id])).rows[0];
  return a ?? null;
}
export const agentOfUser = async (c, userId) => (await db(c).query('SELECT * FROM agent_profiles WHERE user_id=$1', [userId])).rows[0] ?? null;

/** Is this person the agent (principal) or active, still-eligible staff of the agent? Staff of an agency must still belong to its organisation. */
export async function actingFor(c, user, agent) {
  if (!user || !agent) return null;
  if (agent.user_id === user.id) return { agent, via: 'principal', perms: [...STAFF_PERMS] };
  const s = (await db(c).query("SELECT permissions FROM agent_staff WHERE agent_id=$1 AND user_id=$2 AND status='active'", [agent.id, user.id])).rows[0];
  if (!s) return null;
  if (agent.kind === 'agency' && !(await db(c).query("SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active'", [agent.organisation_id, user.id])).rowCount) return null;
  return { agent, via: 'staff', perms: s.permissions };
}

/** The athlete side of a mandate: an adult for themselves, a verified guardian for a young person. A young person alone may revoke and look, never grant or approve. */
export async function athleteSideOf(c, user, athleteId) {
  if (!user) return null;
  if (user.id === athleteId) return (await isYouth(athleteId, c)) ? 'youth' : 'athlete';
  return (await guardianLink(user.id, athleteId, c)) ? 'guardian' : null;
}
export const canDecide = (side) => side === 'athlete' || side === 'guardian';

export async function logEvent(c, mandateId, actor, side, action, { subject_type = null, subject_id = null, detail = {} } = {}) {
  if (side === 'youth') side = 'athlete'; // a young person acts as the athlete; the guardian side is recorded as 'guardian'
  await db(c).query('INSERT INTO representation_events(mandate_id, actor_id, actor_side, action, subject_type, subject_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [mandateId, actor ?? null, side, action, subject_type, subject_id, JSON.stringify(detail)]);
}

export async function athleteRecipients(c, mandate) {
  const to = new Set([mandate.athlete_id]);
  if (await isYouth(mandate.athlete_id, c)) for (const g of await guardiansOf(mandate.athlete_id, c)) to.add(g);
  return [...to];
}
export async function agentRecipients(c, mandate, perm = 'view') {
  const agent = await loadAgent(c, mandate.agent_id);
  const to = new Set([agent.user_id]);
  const staff = (await db(c).query("SELECT user_id, permissions FROM agent_staff WHERE agent_id=$1 AND status='active'", [agent.id])).rows;
  const v = await inForce(c, mandate);
  if (v?.allow_staff) for (const s of staff) if (s.permissions.includes(perm)) to.add(s.user_id);
  return [...to];
}
export async function notifyAthleteSide(c, mandate, msg, exceptId) {
  for (const u of await athleteRecipients(c, mandate)) if (u !== exceptId) await notify(c, u, { ...msg, data: { ...(msg.data ?? {}), mandate_id: mandate.id } });
}
export async function notifyAgentSide(c, mandate, msg, exceptId, perm = 'view') {
  for (const u of await agentRecipients(c, mandate, perm)) if (u !== exceptId) await notify(c, u, { ...msg, data: { ...(msg.data ?? {}), mandate_id: mandate.id } });
}

// ------------------------------------------------------------------ live access
const refuse = (reason, message) => { const e = forbidden(message); e.details = { code: 'mandate_not_live', reason }; return e; };
const REASONS = {
  draft: 'This mandate has not been agreed yet', proposed: 'This mandate is waiting for signatures', declined: 'This mandate was declined', withdrawn: 'This mandate was withdrawn',
  revoked: 'This mandate has ended', expired: 'This mandate has expired', no_version: 'This mandate has no agreed version', not_started: 'This mandate has not started yet',
  agent_suspended: 'The agent is suspended', agent_unverified: 'The agent\'s verification is not current', licence_lapsed: 'The licence this mandate relies on has lapsed or is not verified',
  purpose_not_in_mandate: 'That purpose is not part of this mandate', data_not_permitted: 'The athlete has not allowed that kind of information', action_not_permitted: 'The athlete has not allowed that action',
  staff_not_allowed: 'The athlete has not allowed agency staff to act, or your delegation does not cover this', no_grant: 'The athlete has not shared that item with you', conflict_open: 'An open conflict of interest must be resolved first',
  recused: 'You stepped back from, or the athlete rejected, this item', guardian_consent_withdrawn: 'A guardian\'s current consent is needed for this', sport_not_in_mandate: 'That sport is not part of this mandate',
};

/** Whether the mandate is in force right now, and why not. Pure state: no request needed. */
export async function assess(c, mandate, { agent, version, today = todayIso() } = {}) {
  agent ??= await loadAgent(c, mandate.agent_id);
  if (mandate.status !== 'active') return { live: false, reason: mandate.status, agent };
  version ??= await inForce(c, mandate);
  if (!version) return { live: false, reason: 'no_version', agent };
  if (today < version.starts_on) return { live: false, reason: 'not_started', agent, version };
  if (today > version.ends_on) return { live: false, reason: 'expired', agent, version };
  if (agent.status !== 'active') return { live: false, reason: 'agent_suspended', agent, version };
  const standing = await agentStanding(c, agent);
  if (!standing.verified) return { live: false, reason: 'agent_unverified', agent, version, standing };
  if (version.licence_id) {
    const l = standing.licences.find((x) => x.id === version.licence_id);
    if (!l || l.standing !== 'verified') return { live: false, reason: 'licence_lapsed', agent, version, standing };
  }
  return { live: true, reason: null, agent, version, standing };
}

async function youthGate(c, mandate, need, state) {
  if (!(await isYouth(mandate.athlete_id, c))) return;
  const wanted = new Set([need.purpose, need.category, need.action].filter(Boolean).map((k) => CONSENT_FOR[k]).filter(Boolean));
  for (const purpose of wanted) if (!(await hasConsent(mandate.athlete_id, purpose, c))) throw refuse('guardian_consent_withdrawn', REASONS.guardian_consent_withdrawn);
}

/**
 * The one check every agent-facing read or action passes. `need` may name a purpose, a data category, an allowed action, a staff permission, a sport and a
 * subject ({type,id,level}) - all must hold *now*. Agents who are not on the mandate get 404 (existence is not revealed); the rest get 403 with a reason code.
 */
export async function requireLive(c, user, mandateId, need = {}) {
  const mandate = (await db(c).query('SELECT * FROM representation_mandates WHERE id=$1', [mandateId])).rows[0];
  const agent = mandate ? await loadAgent(c, mandate.agent_id) : null;
  const acting = mandate ? await actingFor(c, user, agent) : null;
  if (!mandate || !acting) throw notFound('Mandate');
  const state = await assess(c, mandate, { agent });
  if (!state.live) throw refuse(state.reason, REASONS[state.reason] ?? 'This mandate is not in force');
  const v = state.version;
  if (acting.via === 'staff') {
    if (!v.allow_staff) throw refuse('staff_not_allowed', REASONS.staff_not_allowed);
    if (need.staff && !acting.perms.includes(need.staff)) throw refuse('staff_not_allowed', REASONS.staff_not_allowed);
  }
  if (need.purpose && !v.purposes.includes(need.purpose)) throw refuse('purpose_not_in_mandate', REASONS.purpose_not_in_mandate);
  if (need.category && !v.data_access.includes(need.category)) throw refuse('data_not_permitted', REASONS.data_not_permitted);
  if (need.action && !v.contact_actions.includes(need.action)) throw refuse('action_not_permitted', REASONS.action_not_permitted);
  if (need.sport_id && !v.sport_ids.includes(need.sport_id)) throw refuse('sport_not_in_mandate', REASONS.sport_not_in_mandate);
  await youthGate(c, mandate, need, state);
  const open = (await db(c).query("SELECT status, subject_type, subject_id FROM representation_conflicts WHERE mandate_id=$1 AND status IN ('open','rejected','recused')", [mandate.id])).rows;
  for (const cf of open) {
    const applies = (cf.subject_type === 'mandate' && (need.category || need.subject)) || (need.subject && cf.subject_type === need.subject.type && cf.subject_id === need.subject.id);
    if (!applies) continue;
    if (cf.status === 'open') throw refuse('conflict_open', REASONS.conflict_open);
    throw refuse('recused', REASONS.recused);
  }
  if (need.subject) {
    const g = (await db(c).query('SELECT level FROM representation_grants WHERE mandate_id=$1 AND subject_type=$2 AND subject_id=$3 AND revoked_at IS NULL', [mandate.id, need.subject.type, need.subject.id])).rows[0];
    if (!g || (need.subject.level === 'participate' && g.level !== 'participate')) throw refuse('no_grant', REASONS.no_grant);
    if (acting.via === 'staff' && !v.allow_staff) throw refuse('staff_not_allowed', REASONS.staff_not_allowed);
  }
  return { mandate, version: v, agent, acting, standing: state.standing };
}

/**
 * Any mandate the person may see: the athlete side (athlete, guardian, the young person) or the agent side (agent or delegated staff). The agent side keeps
 * reading its own business record after the mandate ends; only athlete data goes through requireLive.
 */
export async function loadMandate(c, user, id, { lock = false } = {}) {
  const mandate = (await db(c).query(`SELECT * FROM representation_mandates WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!mandate) throw notFound('Mandate');
  const side = await athleteSideOf(c, user, mandate.athlete_id);
  const agent = await loadAgent(c, mandate.agent_id);
  const acting = side ? null : await actingFor(c, user, agent);
  if (!side && !acting) throw notFound('Mandate');
  // delegated staff see only mandates whose agreed version lets staff act
  if (!side && acting.via === 'staff' && !(await inForce(c, mandate))?.allow_staff) throw notFound('Mandate');
  // a draft belongs to the side of whoever wrote it until it is proposed
  if (mandate.status === 'draft' && mandate.created_by !== user.id) {
    const creatorIsAthleteSide = !!(await athleteSideOf(c, { id: mandate.created_by }, mandate.athlete_id));
    if (!(creatorIsAthleteSide ? side : acting)) throw notFound('Mandate');
  }
  return { mandate, agent, side, acting };
}

// ------------------------------------------------------------------ conflicts of interest (flagged, never decided, by the platform)
export async function raiseConflict(c, { agent, mandate, athleteId, kind, subject_type, subject_id, counterparty = null, detail = null, raised_by = 'system', raised_user = null }) {
  const can = !noWaiver().includes(kind);
  const r = await c.query(
    `INSERT INTO representation_conflicts(agent_id, athlete_id, mandate_id, kind, subject_type, subject_id, counterparty, detail_enc, raised_by, raised_user, can_acknowledge)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
    [agent.id, athleteId, mandate?.id ?? null, kind, subject_type ?? null, subject_id ?? null, counterparty, encrypt(detail, 'representation_conflicts.detail'), raised_by, raised_user, can]);
  const row = r.rows[0];
  if (row && mandate) {
    await logEvent(c, mandate.id, raised_user, raised_by === 'system' ? 'system' : raised_by, 'conflict_raised', { subject_type: row.subject_type, subject_id: row.subject_id, detail: { kind, conflict_id: row.id } });
    const msg = { kind: 'representation_conflict', title: 'Possible conflict of interest', body: 'A possible conflict of interest was recorded on a representation. Review it before anything proceeds. SportArena does not decide whether it is acceptable.' };
    await notifyAthleteSide(c, mandate, msg, raised_user);
    await notifyAgentSide(c, mandate, msg, raised_user);
  }
  return row ?? null;
}

/** Compare the people and organisations on a deal with the agent's declared interests and other clients. Flags only; people decide. */
export async function detectDealConflicts(c, { mandate, agent, subjectType, subjectId, actor }) {
  const parties = { userIds: [], teamIds: [], orgIds: [], sponsorIds: [], label: null };
  if (subjectType === 'player_contract') {
    const k = (await c.query('SELECT team_id, event_id FROM player_contracts WHERE id=$1', [subjectId])).rows[0];
    if (k?.team_id) { const t = (await c.query('SELECT id, name, owner_id, organisation_id FROM teams WHERE id=$1', [k.team_id])).rows[0]; if (t) { parties.userIds.push(t.owner_id); parties.teamIds.push(t.id); if (t.organisation_id) parties.orgIds.push(t.organisation_id); parties.label = t.name; } }
    if (k?.event_id) { const e = (await c.query('SELECT id, name, organizer_id, organisation_id FROM events WHERE id=$1', [k.event_id])).rows[0]; if (e) { parties.userIds.push(e.organizer_id); if (e.organisation_id) parties.orgIds.push(e.organisation_id); parties.label = e.name; } }
  } else if (subjectType === 'sponsorship') {
    const s = (await c.query('SELECT sp.id, sp.name, sp.owner_id FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.id=$1', [subjectId])).rows[0];
    if (s) { parties.userIds.push(s.owner_id); parties.sponsorIds.push(s.id); parties.label = s.name; }
  }
  const uid = parties.userIds.filter(Boolean);
  const interests = (await c.query(
    `SELECT id, kind, target_type, target_id, label FROM agent_interests WHERE agent_id=$1 AND ended_at IS NULL AND (
        (target_type='team' AND target_id = ANY($2::uuid[])) OR (target_type='organisation' AND target_id = ANY($3::uuid[])) OR (target_type='sponsor' AND target_id = ANY($4::uuid[])) OR (target_type='user' AND target_id = ANY($5::uuid[])))`,
    [agent.id, parties.teamIds, parties.orgIds, parties.sponsorIds, uid])).rows;
  for (const i of interests) {
    await raiseConflict(c, { agent, mandate, athleteId: mandate.athlete_id, kind: i.kind === 'related_party' ? 'related_party' : 'agent_interest', subject_type: subjectType, subject_id: subjectId, counterparty: i.label, detail: `The agent declared an interest in ${i.label} (${i.kind}), which is a party to this deal.`, raised_by: 'system', raised_user: actor });
  }
  if (uid.length) {
    const other = (await c.query("SELECT 1 FROM representation_mandates WHERE agent_id=$1 AND athlete_id = ANY($2::uuid[]) AND status IN ('proposed','active') LIMIT 1", [agent.id, uid])).rows[0];
    if (other) await raiseConflict(c, { agent, mandate, athleteId: mandate.athlete_id, kind: 'opposing_sides', subject_type: subjectType, subject_id: subjectId, counterparty: parties.label, detail: `The agent also represents a person who runs ${parties.label ?? 'the other side'} of this deal.`, raised_by: 'system', raised_user: actor });
  }
  const dual = (await c.query(
    `SELECT 1 FROM representation_grants g JOIN representation_mandates m ON m.id=g.mandate_id WHERE g.subject_type=$1 AND g.subject_id=$2 AND g.revoked_at IS NULL AND m.id <> $3 AND m.athlete_id=$4 AND m.agent_id <> $5 AND m.status='active' LIMIT 1`,
    [subjectType, subjectId, mandate.id, mandate.athlete_id, mandate.agent_id])).rows[0];
  if (dual) await raiseConflict(c, { agent, mandate, athleteId: mandate.athlete_id, kind: 'dual_representation', subject_type: subjectType, subject_id: subjectId, counterparty: null, detail: 'Another agent already has access to this same item for the same athlete.', raised_by: 'system', raised_user: actor });
}

// ------------------------------------------------------------------ commission
export const COMMISSION_LADDER_SQL = `SELECT
    coalesce(sum(amount_cents) FILTER (WHERE kind IN ('accrual','adjustment')),0)::bigint AS owed_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind='invoiced'),0)::bigint AS invoiced_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind='payment_reported'),0)::bigint AS reported_cents,
    coalesce(sum(amount_cents) FILTER (WHERE kind IN ('payment_settled','refund')),0)::bigint AS settled_cents
  FROM representation_commission_entries`;
/** The commission ladder for one account or a sum of accounts. Each figure is one thing; "settled" means the agent confirmed receipt, never that a payment was merely reported or an invoice sent. */
export function ladderFrom({ owed_cents, invoiced_cents, reported_cents, settled_cents }) {
  const owed = Number(owed_cents), settled = Number(settled_cents), invoiced = Number(invoiced_cents), reported = Number(reported_cents);
  const stage = owed <= 0 && invoiced <= 0 ? (owed === 0 ? 'nothing_owed' : 'credit') : settled >= owed && owed > 0 ? 'settled' : settled > 0 ? 'part_settled' : reported > 0 ? 'payment_reported' : invoiced > 0 ? 'invoiced' : 'accruing';
  return { owed_cents: owed, invoiced_cents: invoiced, reported_cents: reported, settled_cents: settled, outstanding_cents: Math.max(0, owed - settled), uninvoiced_cents: Math.max(0, owed - invoiced), stage };
}
/** Add a ladder into per-currency totals (a total's stage is derived from the sums). */
export function sumLadders(into, currency, l) {
  const t = into[currency] ??= { owed_cents: 0, invoiced_cents: 0, reported_cents: 0, settled_cents: 0 };
  for (const k of Object.keys(t)) t[k] += l[k];
  return into;
}
export const totalsOf = (sums) => Object.fromEntries(Object.entries(sums).map(([cur, t]) => [cur, ladderFrom(t)]));
export async function ladderOf(c, dealId) {
  return ladderFrom((await db(c).query(`${COMMISSION_LADDER_SQL} WHERE deal_id=$1`, [dealId])).rows[0]);
}

/** What a commission term yields from the facts, in whole minor units (rounded down), after threshold and cap. */
export function targetFor(term, facts) {
  let t = 0;
  if (term.basis === 'fixed') t = facts.in_force ? term.fixed_cents : 0;
  else if (term.basis === 'percentage') t = Math.floor(Math.max(0, facts.basis_cents - (term.threshold_cents ?? 0)) * term.rate_bp / 10000);
  else t = term.milestones.filter((m) => facts.confirmed.has(m.key)).reduce((s, m) => s + m.amount_cents, 0);
  if (term.cap_cents != null) t = Math.min(t, term.cap_cents);
  return Math.max(0, t);
}

/** The canonical facts a commission is computed from. Only the athlete's own linked deal; never private or unrelated earnings; each fact is read, not copied. */
export async function dealFacts(c, deal, term, mandate) {
  if (deal.deal_type === 'player_contract') {
    const k = (await c.query('SELECT * FROM player_contracts WHERE id=$1 AND payee_id=$2', [deal.deal_id, mandate.athlete_id])).rows[0];
    if (!k) return { missing: true };
    const first = (await c.query("SELECT decided_at::date::text AS d FROM player_contract_versions WHERE contract_id=$1 AND version=1 AND status IN ('in_force','superseded')", [k.id])).rows[0];
    const until = term.facts_until ?? null;
    const paid = term.calc_on === 'paid';
    const sum = (await c.query(
      paid ? "SELECT coalesce(-sum(amount_cents),0)::bigint AS s FROM player_contract_entries WHERE contract_id=$1 AND kind IN ('payment','refund') AND ($2::date IS NULL OR occurred_on <= $2)"
        : "SELECT coalesce(sum(amount_cents),0)::bigint AS s FROM player_contract_entries WHERE contract_id=$1 AND kind='fee' AND ($2::date IS NULL OR occurred_on <= $2)", [k.id, until])).rows[0].s;
    return { currency: k.currency, ref: k.contract_no, version: k.current_version, in_force: ['active', 'completed', 'terminated'].includes(k.status) && k.current_version != null, in_force_on: first?.d ?? null, basis_cents: Number(sum), source: paid ? 'contract ledger: payments recorded' : 'contract ledger: fees earned' };
  }
  const s = (await c.query("SELECT * FROM sponsorships WHERE id=$1 AND target_type='athlete' AND target_id=$2", [deal.deal_id, mandate.athlete_id])).rows[0];
  if (!s) return { missing: true };
  const sum = (await c.query(
    `SELECT coalesce(sum(p.amount_cents - p.refunded_cents),0)::bigint AS s FROM sponsorship_payments p JOIN sponsorship_obligations o ON o.id=p.obligation_id
      WHERE o.sponsorship_id=$1 AND o.kind='money' AND p.status='confirmed' AND ($2::date IS NULL OR p.paid_on <= $2)`, [s.id, term.facts_until ?? null])).rows[0].s;
  return { currency: s.currency ?? null, ref: s.agreement_ref ?? s.id, version: s.accepted_version, in_force: ['active', 'ended'].includes(s.status) && s.accepted_version != null, in_force_on: s.decided_at ? dayOf(s.decided_at) : null, basis_cents: Number(sum), source: 'sponsorship payments confirmed by the athlete' };
}

/** Bring a deal's commission up to date: post only the difference between what the term yields now and what was already accrued. Repeating it changes nothing. */
export async function accrueDeal(c, dealId, actor = null) {
  const deal = (await c.query('SELECT * FROM representation_deals WHERE id=$1 FOR UPDATE', [dealId])).rows[0];
  if (!deal) throw notFound('Deal');
  if (deal.status !== 'confirmed') return { posted: false, reason: 'not_confirmed' };
  const mandate = (await c.query('SELECT * FROM representation_mandates WHERE id=$1', [deal.mandate_id])).rows[0];
  const ver = (await c.query(`SELECT commission FROM representation_mandate_versions WHERE mandate_id=$1 AND version=$2`, [deal.mandate_id, deal.term_version])).rows[0];
  const term = ver?.commission.find((t) => t.key === deal.term_key);
  if (!term) return { posted: false, reason: 'term_missing' };
  const facts = await dealFacts(c, deal, term, mandate);
  if (facts.missing) return { posted: false, reason: 'deal_not_found' };
  if (facts.currency !== term.currency) return { posted: false, reason: 'currency_mismatch', deal_currency: facts.currency, term_currency: term.currency };
  const confirmed = new Set((await c.query("SELECT milestone_key FROM representation_milestones WHERE deal_id=$1 AND status='confirmed'", [deal.id])).rows.map((r) => r.milestone_key));
  const inWindow = facts.in_force_on && facts.in_force_on >= term.effective_from && facts.in_force_on <= term.effective_to;
  const target = inWindow ? targetFor(term, { ...facts, confirmed }) : 0;
  const accrued = (await c.query("SELECT coalesce(sum(amount_cents),0)::bigint AS s, count(*)::int AS n FROM representation_commission_entries WHERE deal_id=$1 AND kind='accrual'", [deal.id])).rows[0];
  const delta = target - Number(accrued.s);
  if (!delta) return { posted: false, reason: 'up_to_date', target_cents: target };
  const calc = { term_key: term.key, basis: term.basis, rate_bp: term.rate_bp ?? null, calc_on: term.calc_on ?? null, threshold_cents: term.threshold_cents, cap_cents: term.cap_cents, mandate_version: deal.term_version, deal_version: facts.version, deal_ref: facts.ref, in_force_on: facts.in_force_on, source: facts.source, target_cents: target };
  const r = await c.query(
    `INSERT INTO representation_commission_entries(deal_id, currency, kind, amount_cents, basis_cents, calc, reason, idem_key, created_by) VALUES ($1,$2,'accrual',$3,$4,$5,$6,$7,$8) ON CONFLICT (deal_id, idem_key) DO NOTHING RETURNING id`,
    [deal.id, term.currency, delta, facts.basis_cents, JSON.stringify(calc), delta < 0 ? 'Recalculated from the current record' : null, `acc:${Number(accrued.n) + 1}`, actor]);
  return { posted: !!r.rowCount, delta_cents: delta, target_cents: target, basis_cents: facts.basis_cents };
}


/**
 * Called when a player-contract version is put to its parties (#333): agents who were shared that contract and are live get a review item and a short
 * notice. The notice names the contract number only - never the terms - and goes to nobody whose access is not live right now.
 */
export async function onContractRevision(c, contract, versionNo) {
  const rows = (await c.query(
    `SELECT m.* FROM representation_grants g JOIN representation_mandates m ON m.id=g.mandate_id
      WHERE g.subject_type='player_contract' AND g.subject_id=$1 AND g.revoked_at IS NULL AND m.status='active' AND m.athlete_id=$2`, [contract.id, contract.payee_id])).rows;
  for (const m of rows) {
    const st = await assess(c, m);
    if (!st.live || !st.version.purposes.includes('contract_negotiation') || !st.version.data_access.includes('contract_workflow')) continue;
    await c.query("INSERT INTO representation_contract_reviews(mandate_id, contract_id, version_no, state) VALUES ($1,$2,$3,'to_review') ON CONFLICT (mandate_id, contract_id, version_no) DO NOTHING", [m.id, contract.id, versionNo]);
    await logEvent(c, m.id, null, 'system', 'contract_revision', { subject_type: 'player_contract', subject_id: contract.id, detail: { version: versionNo } });
    await notifyAgentSide(c, m, { kind: 'representation_contract_revision', title: 'A contract you follow has a new version', body: `${contract.contract_no} version ${versionNo} is waiting for signatures. Open it under Negotiations to review.`, data: { contract_id: contract.id } }, null, 'negotiate');
  }
}

// ------------------------------------------------------------------ expiry (called by the worker; live checks never depend on it)
export async function runRepresentationSweeps() {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const expired = (await client.query(
      `UPDATE representation_mandates m SET status='expired', ended_at=now(), end_kind='expired', row_version=row_version+1, updated_at=now()
        WHERE m.status='active' AND EXISTS (SELECT 1 FROM representation_mandate_versions v WHERE v.mandate_id=m.id AND v.version=m.current_version AND v.ends_on < current_date) RETURNING *`)).rows;
    for (const m of expired) {
      await logEvent(client, m.id, null, 'system', 'mandate_expired');
      await notifyAthleteSide(client, m, { kind: 'representation_expired', title: 'A representation has expired', body: 'The agent no longer has access. Renew it if you want to continue.' });
      await notifyAgentSide(client, m, { kind: 'representation_expired', title: 'A mandate has expired', body: 'Your access to the athlete\'s information has stopped. Your records and commission history stay.' });
    }
    n += expired.length;
    const ap = (await client.query("UPDATE representation_approvals SET status='expired', row_version=row_version+1 WHERE status='pending' AND expires_at < now() RETURNING id")).rowCount;
    n += ap;
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  // keep commission accounts of confirmed deals current, one transaction each
  const deals = (await pool.query("SELECT id FROM representation_deals WHERE status='confirmed' ORDER BY created_at LIMIT 500")).rows;
  for (const d of deals) {
    const cl = await pool.connect();
    try { await cl.query('BEGIN'); const r = await accrueDeal(cl, d.id, null); await cl.query('COMMIT'); if (r.posted) n++; } catch (e) { await cl.query('ROLLBACK'); } finally { cl.release(); }
  }
  return n;
}

export const decryptSafe = (v, ctx) => { try { return decrypt(v, ctx); } catch { return null; } };
export { conflict };
