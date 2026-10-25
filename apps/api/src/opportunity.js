// Sports opportunity marketplace rules (issue #67): what a Billboard post must state about the work, its pay and who may apply, and how an
// accepted application becomes a canonical engagement (team roster, event/game association, settlement record). Shared by the Billboard and
// recruitment capabilities so every route enforces the same rules on the server.
import { badRequest, conflict, forbidden } from './errors.js';
import { isSupportedCurrency } from './currency.js';
import { roles as roleDefs } from './ontology/iptc.js';
import { badgesFor } from './verification.js';
import { requireConsent } from './youth.js';
import { loadTarget, canManageTarget } from './capabilities/games.js';

export const TYPES = ['trial', 'paid_assignment', 'volunteering', 'sponsorship', 'team_role'];
export const COMPENSATION = ['paid', 'unpaid', 'expenses', 'in_kind'];
/** The passport sections an applicant may share with a post's selectors. Only the recruitment sections exist as shareable evidence. */
export const SECTIONS = ['video', 'references', 'preferences', 'availability', 'academic'];
export const scopeOf = (sections) => Object.fromEntries(SECTIONS.map((k) => [`show_${k}`, sections.includes(k)]));
export const SPONSOR_KINDS = ['sponsorship_wanted', 'sponsor_call'];
/** Roles a post may hand out. Managing roles (manager, organizer ...) are never granted by an application: they carry edit rights over the event or game. */
export const ENGAGEMENT_ROLES = ['volunteer', 'referee', 'umpire', 'linesman', 'scorer', 'physio'];
/** Post kinds that are filled from the roster pipeline with versioned offers. */
export const OFFER_KINDS = ['match_players', 'team_recruiting', 'coach_wanted'];

const defaultType = (kind) => (SPONSOR_KINDS.includes(kind) ? 'sponsorship' : kind === 'assignment' ? 'volunteering' : kind === 'match_players' ? 'trial' : 'team_role');

/**
 * Validate and normalise the opportunity terms of a new post. Returns the columns to store.
 * Pay is stated honestly: paid work needs an amount and currency, unpaid work carries none, and an unstated pay is stored as such (shown as "not stated").
 */
export async function termsOf(user, i) {
  const type = i.opportunity_type ?? defaultType(i.kind);
  if (type === 'sponsorship' !== SPONSOR_KINDS.includes(i.kind)) throw badRequest(SPONSOR_KINDS.includes(i.kind) ? 'Sponsorship posts have the sponsorship type' : 'Use a sponsorship post for sponsor calls');
  if ((type === 'paid_assignment' || type === 'volunteering') && i.kind !== 'assignment') throw badRequest('Assignments and volunteering are posted as an assignment');
  if (i.kind === 'assignment' && !['paid_assignment', 'volunteering'].includes(type)) throw badRequest('An assignment is either paid or volunteering');
  let compensation = i.compensation ?? (type === 'volunteering' ? 'unpaid' : type === 'paid_assignment' ? 'paid' : null);
  if (type === 'sponsorship') compensation = null;
  if (type === 'paid_assignment' && compensation !== 'paid') throw badRequest('A paid assignment must be paid; use volunteering for unpaid or expenses-only work');
  if (type === 'volunteering' && compensation === 'paid') throw badRequest('Volunteering is not paid; post a paid assignment instead');
  if (compensation === 'paid' && !(i.budget_cents > 0)) throw badRequest('Say how much the work pays');
  if (compensation && compensation !== 'paid' && i.budget_cents != null && type !== 'sponsorship') throw badRequest(`Unpaid work carries no amount; choose "Paid" or remove the amount`);
  const currency = i.budget_cents != null ? (i.currency ?? 'INR') : null;
  if (currency && !isSupportedCurrency(currency)) throw badRequest(`Currency ${currency} is not supported`);
  if (i.currency && i.budget_cents == null) throw badRequest('A currency needs an amount');
  if (type === 'paid_assignment' && !i.team_id) throw badRequest('Pick the team that pays for this assignment');
  if (i.closes_at && new Date(i.closes_at) <= new Date()) throw badRequest('Applications must close in the future');
  if (i.closes_at && i.starts_at && new Date(i.closes_at) > new Date(i.starts_at)) throw badRequest('Applications must close before the work starts');
  if (i.ends_at && i.starts_at && new Date(i.ends_at) < new Date(i.starts_at)) throw badRequest('The end is before the start');

  let target = { target_type: null, target_id: null, target_role: null };
  if (i.target_id || i.target_role) {
    if (!['paid_assignment', 'volunteering'].includes(type)) throw badRequest('Only assignments and volunteering attach to an event or game');
    if (!i.target_type || !i.target_id) throw badRequest('Pick the event or game this work is for');
    const row = await loadTarget(i.target_type, i.target_id);
    if (!(await canManageTarget(user, i.target_type, row))) throw forbidden(`You do not manage that ${i.target_type}`);
    const role = i.target_role ?? 'volunteer';
    const def = roleDefs[role];
    if (!ENGAGEMENT_ROLES.includes(role) || !def.targets.includes(i.target_type)) throw badRequest(`The ${role} role cannot be filled from a post on a ${i.target_type}; choose one of: ${ENGAGEMENT_ROLES.filter((r) => roleDefs[r].targets.includes(i.target_type)).join(', ')}`);
    target = { target_type: i.target_type, target_id: i.target_id, target_role: role };
  }
  return { opportunity_type: type, compensation, currency, ...target, required_sections: [...new Set(i.required_sections ?? [])], verified_applicants_only: !!i.verified_applicants_only };
}

/** Closed, filled and expired posts take no new applications; the answer says which. */
export function assertOpen(post) {
  if (post.status !== 'open') throw conflict(post.status === 'filled' ? 'All positions on this post are filled' : 'This post is no longer open', { code: post.status === 'filled' ? 'positions_filled' : 'opportunity_closed' });
  if (post.closes_at && new Date(post.closes_at) <= new Date()) throw conflict('Applications for this opportunity have closed', { code: 'opportunity_closed' });
}

/** What the applicant must have and share to apply, checked against the post on the server. */
export async function assertEligible(post, subjectId, subjectRoles, sections) {
  const missing = (post.required_sections ?? []).filter((s) => !sections.includes(s));
  if (missing.length) throw badRequest(`This post asks you to share: ${missing.join(', ')}`, { code: 'evidence_required', missing });
  if (post.verified_applicants_only && !((await badgesFor('user', [subjectId])).get(subjectId) ?? []).length) throw forbidden('Only verified applicants can apply to this post. Get verified first.');
  const need = post.target_role && roleDefs[post.target_role]?.profile;
  if (need && !subjectRoles.includes(need)) throw conflict(`This role needs a ${need} profile`, { code: 'profile_required', profile: need });
}

/**
 * An accepted application becomes a canonical engagement, never a copy: a team roster member is already one; an event/game role is an
 * association; fixed-fee paid work is a team_payouts row (the team's settlement ledger). Returns what was linked.
 */
export async function linkEngagement(c, post, resp, member) {
  const link = { engagement_type: null, engagement_id: null, payout_id: null };
  if (member) Object.assign(link, { engagement_type: 'team_member', engagement_id: member.id });
  if (post.target_type) {
    await requireConsent(resp.responder_id, 'participation', 'taking part', c);
    await c.query(
      `INSERT INTO associations(user_id, role, target_type, target_id, status, invited_by, started_at) VALUES ($1,$2,$3,$4,'active',$5,now())
       ON CONFLICT (user_id, role, target_type, target_id) WHERE status IN ('invited','requested','active') DO NOTHING`,
      [resp.responder_id, post.target_role ?? 'volunteer', post.target_type, post.target_id, post.author_id]);
    const a = (await c.query("SELECT id FROM associations WHERE user_id=$1 AND role=$2 AND target_type=$3 AND target_id=$4 AND status IN ('invited','requested','active') ORDER BY created_at DESC LIMIT 1",
      [resp.responder_id, post.target_role ?? 'volunteer', post.target_type, post.target_id])).rows[0];
    Object.assign(link, { engagement_type: 'association', engagement_id: a.id });
  }
  if (post.opportunity_type === 'paid_assignment' && post.compensation === 'paid' && post.team_id && post.budget_cents > 0) {
    const due = post.ends_at ?? post.starts_at;
    const { rows: [p] } = await c.query(
      `INSERT INTO team_payouts(team_id, user_id, event_id, kind, amount_cents, currency, note, due_on, created_by) VALUES ($1,$2,$3,'other',$4,$5,$6,$7,$8) RETURNING id`,
      [post.team_id, resp.responder_id, post.target_type === 'event' ? post.target_id : null, post.budget_cents, post.currency ?? 'INR', `Opportunity: ${post.title}`.slice(0, 200), due ? new Date(due).toISOString().slice(0, 10) : null, post.author_id]);
    link.payout_id = p.id;
  }
  if (link.engagement_type || link.payout_id) {
    await c.query('UPDATE billboard_responses SET engagement_type=$2, engagement_id=$3, payout_id=$4 WHERE id=$1', [resp.id, link.engagement_type, link.engagement_id, link.payout_id]);
    await c.query("INSERT INTO recruitment_events(response_id, kind, from_stage, to_stage, actor_id, note, created_at) VALUES ($1,'engagement',NULL,NULL,$2,$3,clock_timestamp())",
      [resp.id, post.author_id, [link.engagement_type === 'team_member' ? 'Joined the team roster' : link.engagement_type ? `Linked as ${post.target_role ?? 'volunteer'} on the ${post.target_type}` : null, link.payout_id ? 'Payment recorded as due in the team ledger' : null].filter(Boolean).join(' · ')]);
  }
  return link;
}

/** Publisher verification: any current verified badge on the post's author, as a map authorId -> badge types. */
export async function publisherBadges(rows) {
  const ids = [...new Set(rows.map((r) => r.author_id))];
  const m = ids.length ? await badgesFor('user', ids) : new Map();
  return (id) => (m.get(id) ?? []).map((b) => b.type);
}
