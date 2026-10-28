// Role-based command centres (#562): the shared read model behind Today / Actions / Calendar / Inbox / Work / Insights.
//
// Nothing here is stored or copied. A person's roles and scopes (the teams, organisations, events, venues ... they act for) are derived
// live from the canonical memberships, and every list is a projection over canonical records, so revoking a membership removes the
// role, its scopes and its queue on the very next call. Mutations are never performed here: an action carries the existing
// capability (`quick`) that does the job, so authorization, validation and audit stay where they already live.
import { many, one } from './db.js';
import { hasConsent } from './youth.js';

/** Personas in display order. `section` is the role's own console, the one place "Open my workspace" goes. */
export const PERSONAS = [
  { key: 'athlete', label: 'Athlete', emoji: '🏃', home: { tab: 'Player' } },
  { key: 'guardian', label: 'Guardian', emoji: '👨‍👧', home: { screen: 'Family' } },
  { key: 'coach', label: 'Coach', emoji: '🧑‍🏫', home: { screen: 'CoachHome' } },
  { key: 'team_manager', label: 'Team manager', emoji: '👥', home: { tab: 'Schedule', params: { section: 'manage' } } },
  { key: 'org_admin', label: 'Club / academy / federation admin', emoji: '🏛️', home: { screen: 'Orgs' } },
  { key: 'event_manager', label: 'Competition / event manager', emoji: '🏆', home: { tab: 'Schedule', params: { section: 'manage' } } },
  { key: 'official', label: 'Official', emoji: '🏅', home: { screen: 'OfficialsHome' } },
  { key: 'doctor', label: 'Doctor', emoji: '🩺', home: { screen: 'DoctorHome' } },
  { key: 'physio', label: 'Physio', emoji: '💆', home: { screen: 'Health' } },
  { key: 'sponsor', label: 'Sponsor', emoji: '🤝', home: { screen: 'Sponsors' } },
  { key: 'supplier', label: 'Supplier', emoji: '📦', home: { screen: 'SupplierWorkspace' } },
  { key: 'venue_operator', label: 'Venue operator', emoji: '📍', home: { screen: 'VenueWorkspace' } },
  { key: 'agent', label: 'Agent / scout', emoji: '🔎', home: { screen: 'RecruiterHome' } },
  { key: 'media', label: 'Media', emoji: '🎥', home: { screen: 'MediaWorkspace' } },
  { key: 'volunteer', label: 'Volunteer', emoji: '🙌', home: { screen: 'Openings' } },
];
export const PERSONA_KEYS = PERSONAS.map((p) => p.key);
export const SECTIONS = ['today', 'actions', 'calendar', 'inbox', 'work', 'insights'];

/** Which schedule kinds make up a persona's own calendar (the rest of the person's calendar stays one tap away). */
export const CALENDAR_KINDS = {
  athlete: ['match', 'team', 'event', 'training', 'health', 'recovery', 'venue'],
  guardian: ['match', 'team', 'event'],
  coach: ['training', 'team', 'match', 'event', 'venue'],
  team_manager: ['team', 'match', 'event', 'venue'],
  org_admin: ['event', 'venue', 'team'],
  event_manager: ['event', 'duty', 'venue'],
  official: ['duty', 'match', 'event'],
  doctor: ['health', 'duty'],
  physio: ['health', 'duty', 'recovery'],
  sponsor: ['event'],
  supplier: ['event', 'duty'],
  venue_operator: ['venue', 'event'],
  agent: ['event', 'match'],
  media: ['event', 'duty', 'match'],
  volunteer: ['duty', 'event'],
};

// ------------------------------------------------------------------------------------------------ deep links
/** The exact screen and record for a notification or task: one resolver, shared by the inbox, the action queue and the app. */
export function linkFor(kind = '', d = {}) {
  const has = (k) => d && d[k];
  if (has('trip_id')) return { screen: 'Trip', params: { id: d.trip_id } };
  if (has('open_game_id')) return { screen: 'OpenGame', params: { id: d.open_game_id } };
  if (has('reservation_id')) return { screen: 'Reservation', params: { id: d.reservation_id } };
  if (has('sponsorship_id')) return { screen: 'SponsorDeal', params: { id: d.sponsorship_id } };
  if (has('followup_id') || has('appointment_id')) return { screen: 'Health', params: {} };
  if (has('staff_id') && has('event_id')) return { screen: 'EventCommand', params: { id: d.event_id } };
  if (has('event_id')) return { screen: 'Event', params: { id: d.event_id } };
  if (has('fixture_id') && /official/.test(kind)) return { screen: 'OfficialMatch', params: { id: d.fixture_id } };
  if (has('team_id')) return { screen: 'Team', params: { id: d.team_id } };
  if (has('hire_id') || has('review_id') || kind.startsWith('coach_')) return { screen: 'CoachDesk', params: {} };
  if (has('request_id')) return { screen: 'CoachRequest', params: { id: d.request_id } };
  return null;
}

const act = (id, kind, title, sub, link, extra = {}) => ({ id, kind, title, sub, link, due: null, urgent: false, quick: [], ...extra });
const patch = (label, path, body, tone = 'primary') => ({ label, method: 'PATCH', path, body, tone });
const post = (label, path, body, tone = 'primary') => ({ label, method: 'POST', path, body, tone });
const day = (v) => (v ? new Date(v).toISOString() : null);
const fx = (r) => (r.home_name ? `${r.home_name} v ${r.away_name}` : r.event_name ?? 'Selection');

// ------------------------------------------------------------------------------------------------ context derivation
/** One query per persona. `scopes` are the records the person acts for; an empty list is a persona without a scope. */
const HOLDERS = {
  athlete: (u) => (u.roles.includes('athlete') ? [] : null),
  guardian: async (u) => {
    const links = await many(
      `SELECT l.child_id AS id, c.display_name AS label, l.status FROM guardian_links l JOIN users c ON c.id=l.child_id
        WHERE l.guardian_id=$1 AND l.revoked_at IS NULL AND l.status IN ('invited','accepted','pending_review','active') AND (l.status <> 'active' OR l.expires_at IS NULL OR l.expires_at > now())`, [u.id]);
    return links.length ? links.filter((l) => l.status === 'active').map(({ id, label }) => ({ id, label, type: 'child' })) : null;
  },
  coach: async (u) => {
    const t = await many("SELECT t.id, t.name AS label FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.role='coach' AND m.status='active' AND t.archived_at IS NULL ORDER BY t.name", [u.id]);
    return u.roles.includes('coach') || t.length ? t.map((x) => ({ ...x, type: 'team' })) : null;
  },
  team_manager: async (u) => {
    const t = await many(
      `SELECT t.id, t.name AS label FROM teams t WHERE t.archived_at IS NULL AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.role='manager' AND m.status='active')) ORDER BY t.name`, [u.id]);
    return t.length ? t.map((x) => ({ ...x, type: 'team' })) : null;
  },
  org_admin: async (u) => {
    const o = await many(
      `SELECT o.id, o.name AS label, o.kind FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
        WHERE m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active' ORDER BY o.name`, [u.id]);
    return o.length ? o.map((x) => ({ ...x, type: 'org' })) : null;
  },
  event_manager: async (u) => {
    const e = await many("SELECT id, name AS label FROM events WHERE organizer_id=$1 AND status NOT IN ('cancelled','completed') ORDER BY starts_on NULLS LAST, name LIMIT 50", [u.id]);
    return u.roles.includes('organizer') || e.length ? e.map((x) => ({ ...x, type: 'event' })) : null;
  },
  official: async (u) => (u.roles.includes('referee') || (await one("SELECT 1 FROM fixture_officials WHERE user_id=$1 AND status IN ('invited','accepted','completed') LIMIT 1", [u.id])) ? [] : null),
  doctor: (u) => (u.roles.includes('doctor') ? [] : null),
  physio: (u) => (u.roles.includes('physio') ? [] : null),
  sponsor: async (u) => (u.roles.includes('sponsor') || (await one("SELECT 1 FROM sponsors s WHERE s.owner_id=$1 OR s.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active') LIMIT 1", [u.id])) ? [] : null),
  supplier: async (u) => {
    const p = await many(
      `SELECT id, coalesce(trading_name, legal_name) AS label FROM svc_profiles p
        WHERE p.owner_id=$1 OR p.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active')
           OR p.id IN (SELECT e.svc_profile_id FROM supplier_entities e JOIN supplier_entity_members m ON m.entity_id=e.id WHERE m.user_id=$1 AND m.status='active') ORDER BY 2`, [u.id]);
    return u.roles.includes('supplier') || p.length ? p.map((x) => ({ ...x, type: 'supplier' })) : null;
  },
  venue_operator: async (u) => {
    const v = await many(
      `SELECT v.id, v.name AS label FROM venues v WHERE v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff s WHERE s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL) ORDER BY v.name`, [u.id]);
    return u.roles.includes('venue_manager') || v.length ? v.map((x) => ({ ...x, type: 'venue' })) : null;
  },
  agent: (u) => (u.roles.includes('recruiter') ? [] : null),
  media: async (u) => {
    const m = await many(
      `SELECT p.id, o.name AS label FROM media_partners p JOIN organisations o ON o.id=p.organisation_id
        WHERE p.status='active' AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=p.organisation_id AND m.user_id=$1 AND m.status='active') ORDER BY o.name`, [u.id]);
    return m.length ? m.map((x) => ({ ...x, type: 'media' })) : null;
  },
  volunteer: async (u) => (await one("SELECT 1 FROM event_staff WHERE user_id=$1 AND role='volunteer' AND status IN ('invited','accepted') LIMIT 1", [u.id])) ? [] : null,
};

/** The roles this person holds right now and the records each one acts for. Never trusts anything the client says about roles. */
export async function contextsFor(user) {
  const u = { id: user.id, roles: user.roles ?? [] };
  const held = await Promise.all(PERSONAS.map(async (p) => ({ p, scopes: await HOLDERS[p.key](u) })));
  return held.filter((h) => h.scopes).map(({ p, scopes }) => ({ key: p.key, label: p.label, emoji: p.emoji, home: p.home, scopes }));
}

// ------------------------------------------------------------------------------------------------ action queues
// $1 = the person, $2 = the chosen scope (uuid) or null for "everything I act for in this role".
const S = '($2::uuid IS NULL OR';
const ACTIONS = {
  athlete: async (u) => {
    const [squads, avail, follow] = await Promise.all([
      many(`SELECT q.id, q.team_id, t.name AS team, f.scheduled_at, h.name AS home_name, a.name AS away_name, e.name AS event_name
              FROM team_squads q JOIN teams t ON t.id=q.team_id LEFT JOIN fixtures f ON f.id=q.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN events e ON e.id=q.event_id
             WHERE q.user_id=$1 AND q.status='selected' AND (f.id IS NULL OR f.status='scheduled') ORDER BY f.scheduled_at NULLS LAST LIMIT 20`, [u.id]),
      many(`SELECT t.id, t.name, min(f.scheduled_at) AS next_at FROM team_members m JOIN teams t ON t.id=m.team_id JOIN fixtures f ON (f.home_team_id=t.id OR f.away_team_id=t.id)
             WHERE m.user_id=$1 AND m.status='active' AND m.role IN ('player','captain','vice_captain','substitute') AND m.availability_set_at IS NULL AND f.status='scheduled' AND f.scheduled_at BETWEEN now() AND now() + interval '7 days'
             GROUP BY t.id, t.name ORDER BY 3 LIMIT 10`, [u.id]),
      many(`SELECT id, instruction_summary, due_on, coalesce(window_end, due_on) < current_date AS overdue FROM appointment_followups WHERE athlete_id=$1 AND status IN ('due','booked') AND due_on <= current_date + 7 ORDER BY due_on LIMIT 10`, [u.id]),
    ]);
    return [
      ...squads.map((r) => act(`squad:${r.id}`, 'selection', `Selected: ${fx(r)}`, `${r.team} · confirm or decline`, { screen: 'Team', params: { id: r.team_id } }, {
        due: day(r.scheduled_at), urgent: !!r.scheduled_at && new Date(r.scheduled_at) - Date.now() < 48 * 36e5,
        quick: [patch('Confirm', `/squads/${r.id}`, { status: 'confirmed' }), patch('Decline', `/squads/${r.id}`, { status: 'declined' }, 'quiet')] })),
      ...avail.map((r) => act(`availability:${r.id}`, 'availability', `Are you available for ${r.name}?`, 'Match within 7 days · tell the team', { screen: 'Team', params: { id: r.id } }, {
        due: day(r.next_at), quick: [patch('Available', `/teams/${r.id}/members/${u.id}/availability`, { availability: 'available' }), patch('Not available', `/teams/${r.id}/members/${u.id}/availability`, { availability: 'unavailable' }, 'quiet')] })),
      ...follow.map((r) => act(`followup:${r.id}`, 'followup', r.instruction_summary, r.overdue ? 'Follow-up overdue' : 'Follow-up due', { screen: 'Health', params: {} }, { due: day(r.due_on), urgent: r.overdue })),
    ];
  },

  guardian: async (u, scope) => {
    const [invites, kids] = await Promise.all([
      many("SELECT l.id, c.display_name AS child FROM guardian_links l JOIN users c ON c.id=l.child_id WHERE l.guardian_id=$1 AND l.status IN ('invited','accepted','pending_review') AND l.revoked_at IS NULL ORDER BY l.created_at LIMIT 10", [u.id]),
      many(`SELECT l.child_id AS id, c.display_name AS name FROM guardian_links l JOIN users c ON c.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND ${S} l.child_id=$2) ORDER BY c.display_name`, [u.id, scope]),
    ]);
    const lapsed = [];
    for (const k of kids) if (!(await hasConsent(k.id, 'participation'))) lapsed.push(k);
    return [
      ...invites.map((r) => act(`guardian-link:${r.id}`, 'guardian_link', `Guardian link for ${r.child}`, 'Waiting to be completed', { screen: 'Family', params: {} }, { urgent: true })),
      ...lapsed.map((k) => act(`consent:${k.id}`, 'consent', `${k.name} has no participation consent`, 'They cannot be selected until you give it', { screen: 'Family', params: {} }, { urgent: true })),
    ];
  },

  coach: async (u, scope) => {
    const [hires, tasks] = await Promise.all([
      many("SELECT h.id, h.starts_at, p.display_name AS who FROM coach_hires h JOIN users p ON p.id=h.hirer_id WHERE h.coach_id=$1 AND h.status='requested' AND h.starts_at > now() ORDER BY h.starts_at LIMIT 10", [u.id]),
      teamTasks(u, scope, 'coach'),
    ]);
    return [...hires.map((r) => act(`hire:${r.id}`, 'coach_hire', `Session request from ${r.who}`, 'Confirm once paid, or decline', { screen: 'CoachDesk', params: {} }, { due: day(r.starts_at) })), ...tasks];
  },

  team_manager: async (u, scope) => {
    const [waiting, invites, tasks] = await Promise.all([
      many(`SELECT t.id, t.name, count(*)::int AS n, min(f.scheduled_at) AS next_at FROM team_squads q JOIN teams t ON t.id=q.team_id JOIN fixtures f ON f.id=q.fixture_id
             WHERE q.status='selected' AND f.status='scheduled' AND f.scheduled_at > now() AND t.archived_at IS NULL AND ${S} t.id=$2) AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.role='manager' AND m.status='active'))
             GROUP BY t.id, t.name ORDER BY 4 LIMIT 10`, [u.id, scope]),
      many(`SELECT t.id, t.name, count(*)::int AS n FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.status='invited' AND t.archived_at IS NULL AND ${S} t.id=$2) AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members x WHERE x.team_id=t.id AND x.user_id=$1 AND x.role='manager' AND x.status='active')) GROUP BY t.id, t.name LIMIT 10`, [u.id, scope]),
      teamTasks(u, scope, 'manager'),
    ]);
    return [
      ...waiting.map((r) => act(`squad-wait:${r.id}`, 'squad_waiting', `${r.n} player${r.n === 1 ? ' has' : 's have'} not answered · ${r.name}`, 'Selected for an upcoming match', { screen: 'TeamManage', params: { id: r.id } }, { due: day(r.next_at), urgent: !!r.next_at && new Date(r.next_at) - Date.now() < 48 * 36e5 })),
      ...invites.map((r) => act(`team-invites:${r.id}`, 'team_invites', `${r.n} invitation${r.n === 1 ? '' : 's'} not yet accepted · ${r.name}`, 'Open the roster to chase or withdraw', { screen: 'TeamManage', params: { id: r.id } })),
      ...tasks,
    ];
  },

  org_admin: async (u, scope) => {
    const [apps, lic] = await Promise.all([
      many(`SELECT o.id, o.name, count(*)::int AS n FROM academy_applications a JOIN organisations o ON o.id=a.organisation_id
             WHERE a.stage IN ('submitted','under_review') AND ${S} o.id=$2) AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=o.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')) GROUP BY o.id, o.name LIMIT 10`, [u.id, scope]),
      many(`SELECT b.id, o.name, count(*)::int AS n FROM fed_licences l JOIN governing_bodies b ON b.id=l.body_id JOIN organisations o ON o.id=b.organisation_id
             WHERE l.status IN ('submitted','under_review','needs_info') AND ${S} o.id=$2) AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=o.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')) GROUP BY b.id, o.name LIMIT 10`, [u.id, scope]),
    ]);
    return [
      ...apps.map((r) => act(`applications:${r.id}`, 'admissions', `${r.n} application${r.n === 1 ? '' : 's'} to review · ${r.name}`, 'Academy admissions', { screen: 'Org', params: { id: r.id } })),
      ...lic.map((r) => act(`licences:${r.id}`, 'licences', `${r.n} licence${r.n === 1 ? '' : 's'} awaiting a decision · ${r.name}`, 'Federation licensing', { screen: 'FederationHome', params: { id: r.id } }, { urgent: true })),
    ];
  },

  event_manager: async (u, scope) => {
    const [entries, tasks, applied] = await Promise.all([
      many(`SELECT x.id, e.id AS event_id, e.name, coalesce(t.name, p.display_name) AS who FROM event_entries x JOIN events e ON e.id=x.event_id LEFT JOIN teams t ON t.id=x.team_id LEFT JOIN users p ON p.id=x.user_id
             WHERE x.status='pending' AND e.organizer_id=$1 AND e.status NOT IN ('cancelled','completed') AND ${S} e.id=$2) ORDER BY x.created_at LIMIT 15`, [u.id, scope]),
      many(`SELECT k.id, k.title, k.due_on, e.id AS event_id, e.name FROM event_tasks k JOIN events e ON e.id=k.event_id
             WHERE e.organizer_id=$1 AND k.status IN ('todo','doing','blocked') AND k.due_on IS NOT NULL AND k.due_on <= current_date + 3 AND ${S} e.id=$2) ORDER BY k.due_on LIMIT 15`, [u.id, scope]),
      many(`SELECT e.id, e.name, count(*)::int AS n FROM event_staff_assignments a JOIN events e ON e.id=a.event_id WHERE a.status='applied' AND e.organizer_id=$1 AND ${S} e.id=$2) GROUP BY e.id, e.name LIMIT 10`, [u.id, scope]),
    ]);
    return [
      ...entries.map((r) => act(`entry:${r.id}`, 'entry', `${r.who} wants to enter ${r.name}`, 'Accept or reject the registration', { screen: 'EventCommand', params: { id: r.event_id } }, {
        quick: [patch('Accept', `/entries/${r.id}`, { status: 'accepted' }), patch('Reject', `/entries/${r.id}`, { status: 'rejected' }, 'quiet')] })),
      ...tasks.map((r) => act(`event-task:${r.id}`, 'event_task', r.title, `${r.name} · ${new Date(r.due_on) < new Date(new Date().toDateString()) ? 'overdue' : 'due soon'}`, { screen: 'EventCommand', params: { id: r.event_id } }, { due: day(r.due_on), urgent: new Date(r.due_on) < new Date(new Date().toDateString()) })),
      ...applied.map((r) => act(`event-applied:${r.id}`, 'staff_applications', `${r.n} crew application${r.n === 1 ? '' : 's'} · ${r.name}`, 'Review and contract', { screen: 'EventCommand', params: { id: r.id } })),
    ];
  },

  official: async (u) => {
    const [fo, es] = await Promise.all([
      many(`SELECT o.id, o.fixture_id, o.role, o.status, f.scheduled_at, h.name AS home_name, a.name AS away_name FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
             WHERE o.user_id=$1 AND f.status='scheduled' AND f.scheduled_at > now() AND (o.status='invited' OR (o.status='accepted' AND o.needs_ack)) ORDER BY f.scheduled_at LIMIT 15`, [u.id]),
      crewInvites(u, ['referee', 'umpire', 'judge', 'starter', 'timekeeper', 'scorer', 'linesman']),
    ]);
    return [
      ...fo.map((r) => act(`official:${r.id}`, 'assignment', `${r.status === 'invited' ? 'Appointment' : 'Time changed'}: ${r.home_name} v ${r.away_name}`, `${r.role} · accept or decline`, { screen: 'OfficialMatch', params: { id: r.fixture_id } }, {
        due: day(r.scheduled_at), urgent: new Date(r.scheduled_at) - Date.now() < 48 * 36e5,
        quick: [post('Accept', `/official-assignments/${r.id}/respond`, { response: 'accept' }), post('Decline', `/official-assignments/${r.id}/respond`, { response: 'decline' }, 'quiet')] })),
      ...es,
    ];
  },

  doctor: (u) => providerQueue(u, 'doctor'),
  physio: (u) => providerQueue(u, 'physio'),

  sponsor: async (u) => {
    const [deals, tasks] = await Promise.all([
      many(`SELECT s.id, sp.name FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.status='proposed' AND s.proposed_by <> $1 AND (sp.owner_id=$1 OR sp.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active')) ORDER BY s.created_at LIMIT 15`, [u.id]),
      many("SELECT id, sponsorship_id, title, due_on FROM sponsorship_tasks WHERE assignee_id=$1 AND status='open' AND (due_on IS NULL OR due_on <= current_date + 7) ORDER BY due_on NULLS LAST LIMIT 15", [u.id]),
    ]);
    return [
      ...deals.map((r) => act(`deal:${r.id}`, 'sponsorship', `Proposal for ${r.name}`, 'Decide on the agreement', { screen: 'SponsorDeal', params: { id: r.id } }, { urgent: true })),
      ...tasks.map((r) => act(`sponsor-task:${r.id}`, 'sponsor_task', r.title, r.due_on && new Date(r.due_on) < new Date(new Date().toDateString()) ? 'Overdue' : 'Sponsorship task', { screen: 'SponsorDeal', params: { id: r.sponsorship_id } }, { due: day(r.due_on), urgent: !!r.due_on && new Date(r.due_on) < new Date(new Date().toDateString()) })),
    ];
  },

  supplier: async (u, scope) => {
    const mine = `(SELECT p.id FROM svc_profiles p WHERE (p.owner_id=$1 OR p.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active')
        OR p.id IN (SELECT e.svc_profile_id FROM supplier_entities e JOIN supplier_entity_members m ON m.entity_id=e.id WHERE m.user_id=$1 AND m.status='active')) AND ${S} p.id=$2))`;
    const [inv, ord] = await Promise.all([
      many(`SELECT i.id, r.title, r.quote_deadline FROM svc_invites i JOIN svc_rfqs r ON r.id=i.rfq_id WHERE i.status='invited' AND i.profile_id IN ${mine} ORDER BY r.quote_deadline NULLS LAST LIMIT 15`, [u.id, scope]),
      many(`SELECT o.id, o.number, o.status FROM svc_orders o WHERE o.status IN ('pending_supplier','changes_proposed') AND o.profile_id IN ${mine} ORDER BY o.created_at LIMIT 15`, [u.id, scope]),
    ]);
    return [
      ...inv.map((r) => act(`rfq-invite:${r.id}`, 'rfq', `Invitation to quote: ${r.title}`, 'Accept or decline the invitation', { screen: 'SupplierWorkspace', params: {} }, { due: day(r.quote_deadline), urgent: !!r.quote_deadline && new Date(r.quote_deadline) - Date.now() < 72 * 36e5 })),
      ...ord.map((r) => act(`svc-order:${r.id}`, 'svc_order', `Order ${r.number} ${r.status === 'pending_supplier' ? 'awaits your confirmation' : 'has proposed changes'}`, 'Supplier readiness', { screen: 'SupplierWorkspace', params: {} }, { urgent: true })),
    ];
  },

  venue_operator: async (u, scope) => {
    const mine = `(SELECT v.id FROM venues v WHERE (v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff s WHERE s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL)) AND ${S} v.id=$2))`;
    const [maint, unpaid] = await Promise.all([
      many(`SELECT m.id, m.title, m.due_on, m.priority, v.id AS venue_id, v.name FROM venue_maintenance m JOIN venues v ON v.id=m.venue_id WHERE m.venue_id IN ${mine} AND m.status IN ('scheduled','in_progress') AND m.due_on IS NOT NULL AND m.due_on <= current_date + 3 ORDER BY m.due_on LIMIT 15`, [u.id, scope]),
      many(`SELECT v.id, v.name, count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE v.id IN ${mine} AND b.status='confirmed' AND b.payment_status='unpaid' AND b.starts_at >= date_trunc('day', now()) AND b.starts_at < date_trunc('day', now()) + interval '1 day' GROUP BY v.id, v.name LIMIT 10`, [u.id, scope]),
    ]);
    return [
      ...maint.map((r) => act(`maintenance:${r.id}`, 'maintenance', r.title, `${r.name} · ${new Date(r.due_on) < new Date(new Date().toDateString()) ? 'overdue' : 'due soon'}`, { screen: 'Manage', params: { id: r.venue_id, tab: 'maintenance' } }, { due: day(r.due_on), urgent: r.priority === 'high' || new Date(r.due_on) < new Date(new Date().toDateString()),
        quick: [patch('Mark done', `/maintenance/${r.id}`, { status: 'done' })] })),
      ...unpaid.map((r) => act(`unpaid:${r.id}`, 'unpaid_bookings', `${r.n} unpaid booking${r.n === 1 ? '' : 's'} today · ${r.name}`, 'Take payment at the desk', { screen: 'Manage', params: { id: r.id, tab: 'frontdesk' } })),
    ];
  },

  agent: async (u) => {
    const exp = await many("SELECT r.id, a.display_name AS athlete, r.expires_at FROM recruiter_access_requests r JOIN users a ON a.id=r.athlete_id WHERE r.recruiter_id=$1 AND r.status='approved' AND r.expires_at IS NOT NULL AND r.expires_at BETWEEN now() AND now() + interval '14 days' ORDER BY r.expires_at LIMIT 15", [u.id]);
    return exp.map((r) => act(`access:${r.id}`, 'access_expiring', `Access to ${r.athlete} ends soon`, 'Ask again to keep seeing their profile', { screen: 'RecruiterAccess', params: {} }, { due: day(r.expires_at) }));
  },

  media: async (u, scope) => {
    const rows = await many(
      `SELECT l.id, l.licence_no, l.stage, o.name FROM mr_licences l JOIN media_partners p ON p.id=l.partner_id JOIN organisations o ON o.id=p.organisation_id
        WHERE l.stage IN ('proposed','negotiating') AND l.proposed_by_side <> 'partner' AND ${S} p.id=$2) AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=p.organisation_id AND m.user_id=$1 AND m.status='active') ORDER BY l.created_at LIMIT 15`, [u.id, scope]);
    return rows.map((r) => act(`licence:${r.id}`, 'rights_licence', `Rights licence ${r.licence_no ?? ''} needs your response`.replace('  ', ' '), `${r.name} · ${r.stage}`, { screen: 'MediaWorkspace', params: {} }, { urgent: true }));
  },

  volunteer: (u) => crewInvites(u, ['volunteer']),
};

/** Crew posts offered to the person (referee, volunteer ...) from the canonical event_staff table; answered through respond_event_staff. */
async function crewInvites(u, kinds) {
  const rows = await many("SELECT s.id, s.role, s.event_id, e.name, e.starts_on FROM event_staff s JOIN events e ON e.id=s.event_id WHERE s.user_id=$1 AND s.status='invited' AND s.role = ANY($2) AND e.status NOT IN ('cancelled','completed') ORDER BY e.starts_on NULLS LAST LIMIT 15", [u.id, kinds]);
  return rows.map((r) => act(`crew:${r.id}`, 'crew_post', `${r.role} post at ${r.name}`, 'Accept or decline', { screen: 'Event', params: { id: r.event_id } }, {
    due: day(r.starts_on), quick: [post('Accept', `/event-staff/${r.id}/respond`, { response: 'accept' }), post('Decline', `/event-staff/${r.id}/respond`, { response: 'decline' }, 'quiet')] }));
}

/** Appointment requests and overdue follow-ups for a doctor or physio. Clinical detail is never listed here: only that something is waiting. */
async function providerQueue(u) {
  const [reqs, follow] = await Promise.all([
    many("SELECT a.id, a.starts_at FROM appointments a WHERE a.provider_id=$1 AND a.status='requested' AND a.starts_at > now() ORDER BY a.starts_at LIMIT 15", [u.id]),
    many("SELECT id, due_on FROM appointment_followups WHERE provider_id=$1 AND status='due' AND coalesce(window_end, due_on) < current_date ORDER BY due_on LIMIT 10", [u.id]),
  ]);
  return [
    ...reqs.map((r) => act(`appointment:${r.id}`, 'appointment_request', 'Appointment request', 'Confirm or decline', { screen: u.roles.includes('doctor') ? 'DoctorHome' : 'Health', params: {} }, {
      due: day(r.starts_at), quick: [patch('Confirm', `/appointments/${r.id}`, { status: 'confirmed' }), patch('Decline', `/appointments/${r.id}`, { status: 'cancelled', reason: 'Declined by provider' }, 'quiet')] })),
    ...follow.map((r) => act(`provider-followup:${r.id}`, 'followup', 'Follow-up overdue', 'The patient has not been seen yet', { screen: u.roles.includes('doctor') ? 'DoctorHome' : 'Health', params: {} }, { due: day(r.due_on), urgent: true })),
  ];
}

/** Open team tasks assigned to the person (or all of the team's, for a manager), due within a week. */
async function teamTasks(u, scope, as) {
  const rows = await many(
    `SELECT k.id, k.title, k.due_on, t.id AS team_id, t.name FROM team_tasks k JOIN teams t ON t.id=k.team_id
      WHERE k.archived_at IS NULL AND k.status NOT IN ('done') AND (k.due_on IS NULL OR k.due_on <= current_date + 7) AND ${S} t.id=$2)
        AND ((EXISTS (SELECT 1 FROM team_task_assignees a WHERE a.task_id=k.id AND a.user_id=$1))
          OR ($3 = 'manager' AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.role='manager' AND m.status='active'))))
      ORDER BY k.due_on NULLS LAST LIMIT 15`, [u.id, scope, as]);
  return rows.map((r) => act(`team-task:${r.id}`, 'team_task', r.title, `${r.name} · ${r.due_on && new Date(r.due_on) < new Date(new Date().toDateString()) ? 'overdue' : 'task'}`, { screen: 'TeamWorkspace', params: { id: r.team_id } }, { due: day(r.due_on), urgent: !!r.due_on && new Date(r.due_on) < new Date(new Date().toDateString()) }));
}

/** The prioritised action queue for one role: urgent first, then soonest due. Fixes the athlete squad link to the real team. */
export async function actionsFor(user, persona, scope) {
  const u = { id: user.id, roles: user.roles ?? [] };
  const items = await ACTIONS[persona](u, scope ?? null);
  return items.sort((a, b) => (b.urgent - a.urgent) || ((a.due ?? '9') < (b.due ?? '9') ? -1 : 1)).slice(0, 40);
}

// ------------------------------------------------------------------------------------------------ work queues and insights
// Declarative: label + a count query ($1 person, $2 scope or null) + where it opens. Counts only, so no personal data is exposed.
const MINE_TEAM = "(t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members mm WHERE mm.team_id=t.id AND mm.user_id=$1 AND mm.role='manager' AND mm.status='active'))";
const MINE_ORG = "EXISTS (SELECT 1 FROM organisation_members mm WHERE mm.organisation_id=o.id AND mm.user_id=$1 AND mm.status='active' AND mm.role IN ('owner','admin'))";
const MINE_VENUE = "(v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff ss WHERE ss.venue_id=v.id AND ss.user_id=$1 AND ss.removed_at IS NULL))";
const W = (label, sql, link, sub) => ({ label, sql, link, sub });
export const WORK = {
  athlete: [
    W('My teams', "SELECT count(*) FROM team_members WHERE user_id=$1 AND status='active'", { tab: 'Schedule', params: { section: 'manage' } }),
    W('Upcoming matches (30 days)', "SELECT count(*) FROM team_squads q JOIN fixtures f ON f.id=q.fixture_id WHERE q.user_id=$1 AND q.status IN ('selected','confirmed') AND f.status='scheduled' AND f.scheduled_at BETWEEN now() AND now() + interval '30 days'", { tab: 'Schedule', params: { section: 'agenda' } }),
    W('Open applications', "SELECT count(*) FROM academy_applications WHERE athlete_id=$1 AND stage IN ('submitted','under_review','offered','waitlisted')", { screen: 'MyApplications', params: {} }),
  ],
  guardian: [W('Children linked', "SELECT count(*) FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND ($2::uuid IS NULL OR child_id=$2)", { screen: 'Family', params: {} })],
  coach: [
    W('Athletes I coach', "SELECT count(DISTINCT m.user_id) FROM team_members c JOIN team_members m ON m.team_id=c.team_id AND m.status='active' AND m.role IN ('player','captain','vice_captain','substitute') WHERE c.user_id=$1 AND c.role='coach' AND c.status='active' AND ($2::uuid IS NULL OR c.team_id=$2)", { screen: 'CoachAthletes', params: {} }),
    W('Session requests', "SELECT count(*) FROM coach_hires WHERE coach_id=$1 AND status='requested' AND starts_at > now()", { screen: 'CoachDesk', params: {} }),
    W('Sessions this week', "SELECT count(*) FROM coach_hires WHERE coach_id=$1 AND status='confirmed' AND starts_at BETWEEN now() AND now() + interval '7 days'", { screen: 'CoachCalendar', params: {} }),
  ],
  team_manager: [
    W('Players on the roster', "SELECT count(*) FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.status='active' AND t.archived_at IS NULL AND ($2::uuid IS NULL OR t.id=$2) AND " + MINE_TEAM, { screen: 'TeamManage', params: {} }),
    W('Open team tasks', "SELECT count(*) FROM team_tasks k JOIN teams t ON t.id=k.team_id WHERE k.archived_at IS NULL AND k.status <> 'done' AND ($2::uuid IS NULL OR t.id=$2) AND " + MINE_TEAM, { screen: 'TeamWorkspace', params: {} }),
    W('Upcoming matches (14 days)', "SELECT count(*) FROM fixtures f JOIN teams t ON t.id IN (f.home_team_id, f.away_team_id) WHERE f.status='scheduled' AND f.scheduled_at BETWEEN now() AND now() + interval '14 days' AND ($2::uuid IS NULL OR t.id=$2) AND " + MINE_TEAM, { screen: 'TeamManage', params: {} }),
  ],
  org_admin: [
    W('Active members', "SELECT count(*) FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.status='active' AND ($2::uuid IS NULL OR o.id=$2) AND " + MINE_ORG, { screen: 'Orgs', params: {} }),
    W('Pending invitations', "SELECT count(*) FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.status='invited' AND ($2::uuid IS NULL OR o.id=$2) AND " + MINE_ORG, { screen: 'Orgs', params: {} }),
    W('Applications in review', "SELECT count(*) FROM academy_applications a JOIN organisations o ON o.id=a.organisation_id WHERE a.stage IN ('submitted','under_review') AND ($2::uuid IS NULL OR o.id=$2) AND " + MINE_ORG, { screen: 'Orgs', params: {} }),
  ],
  event_manager: [
    W('Live and upcoming events', "SELECT count(*) FROM events WHERE organizer_id=$1 AND status IN ('open','ongoing') AND ($2::uuid IS NULL OR id=$2)", { tab: 'Schedule', params: { section: 'manage' } }),
    W('Registrations to decide', "SELECT count(*) FROM event_entries x JOIN events e ON e.id=x.event_id WHERE x.status='pending' AND e.organizer_id=$1 AND ($2::uuid IS NULL OR e.id=$2)", { tab: 'Schedule', params: { section: 'manage' } }),
    W('Open event tasks', "SELECT count(*) FROM event_tasks k JOIN events e ON e.id=k.event_id WHERE e.organizer_id=$1 AND k.status IN ('todo','doing','blocked') AND ($2::uuid IS NULL OR e.id=$2)", { tab: 'Schedule', params: { section: 'manage' } }),
  ],
  official: [
    W('Appointments to answer', "SELECT count(*) FROM fixture_officials WHERE user_id=$1 AND status='invited'", { screen: 'OfficialsHome', params: {} }),
    W('Matches this month', "SELECT count(*) FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id WHERE o.user_id=$1 AND o.status='accepted' AND f.scheduled_at BETWEEN now() AND now() + interval '30 days'", { screen: 'OfficialsHome', params: {} }),
  ],
  doctor: [
    W('Requests to answer', "SELECT count(*) FROM appointments WHERE provider_id=$1 AND status='requested' AND starts_at > now()", { screen: 'DoctorHome', params: {} }),
    W('Confirmed this week', "SELECT count(*) FROM appointments WHERE provider_id=$1 AND status='confirmed' AND starts_at BETWEEN now() AND now() + interval '7 days'", { screen: 'DoctorHome', params: {} }),
  ],
  physio: [
    W('Requests to answer', "SELECT count(*) FROM appointments WHERE provider_id=$1 AND status='requested' AND starts_at > now()", { screen: 'Health', params: {} }),
    W('Confirmed this week', "SELECT count(*) FROM appointments WHERE provider_id=$1 AND status='confirmed' AND starts_at BETWEEN now() AND now() + interval '7 days'", { screen: 'Health', params: {} }),
  ],
  sponsor: [
    W('Active sponsorships', "SELECT count(*) FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.status='active' AND (sp.owner_id=$1 OR sp.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))", { screen: 'SponsorPortfolio', params: {} }),
    W('Open tasks', "SELECT count(*) FROM sponsorship_tasks WHERE assignee_id=$1 AND status='open'", { screen: 'Sponsors', params: {} }),
  ],
  supplier: [
    W('Invitations to quote', "SELECT count(*) FROM svc_invites i JOIN svc_profiles p ON p.id=i.profile_id WHERE i.status='invited' AND ($2::uuid IS NULL OR p.id=$2) AND (p.owner_id=$1 OR p.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))", { screen: 'SupplierWorkspace', params: {} }),
    W('Orders in progress', "SELECT count(*) FROM svc_orders o JOIN svc_profiles p ON p.id=o.profile_id WHERE o.status IN ('confirmed','in_progress') AND ($2::uuid IS NULL OR p.id=$2) AND (p.owner_id=$1 OR p.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))", { screen: 'SupplierWorkspace', params: {} }),
  ],
  venue_operator: [
    W('Bookings today', "SELECT count(*) FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.status='confirmed' AND b.starts_at >= date_trunc('day', now()) AND b.starts_at < date_trunc('day', now()) + interval '1 day' AND ($2::uuid IS NULL OR v.id=$2) AND " + MINE_VENUE, { screen: 'VenueWorkspace', params: {} }),
    W('Open maintenance', "SELECT count(*) FROM venue_maintenance m JOIN venues v ON v.id=m.venue_id WHERE m.status IN ('scheduled','in_progress') AND ($2::uuid IS NULL OR v.id=$2) AND " + MINE_VENUE, { screen: 'VenueWorkspace', params: {} }),
  ],
  agent: [
    W('Approved access', "SELECT count(*) FROM recruiter_access_requests WHERE recruiter_id=$1 AND status='approved' AND (expires_at IS NULL OR expires_at > now())", { screen: 'RecruiterAccess', params: {} }),
    W('Requests waiting for an answer', "SELECT count(*) FROM recruiter_access_requests WHERE recruiter_id=$1 AND status='requested'", { screen: 'RecruiterAccess', params: {} }),
  ],
  media: [
    W('Active rights licences', "SELECT count(*) FROM mr_licences l JOIN media_partners p ON p.id=l.partner_id WHERE l.stage='active' AND ($2::uuid IS NULL OR p.id=$2) AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=p.organisation_id AND m.user_id=$1 AND m.status='active')", { screen: 'MediaWorkspace', params: {} }),
  ],
  volunteer: [
    W('Posts I have accepted', "SELECT count(*) FROM event_staff s JOIN events e ON e.id=s.event_id WHERE s.user_id=$1 AND s.role='volunteer' AND s.status='accepted' AND e.status NOT IN ('cancelled','completed')", { screen: 'Openings', params: {} }),
    W('Open positions to browse', "SELECT count(*) FROM event_staff_roles r JOIN events e ON e.id=r.event_id WHERE r.role='volunteer' AND e.status IN ('open','ongoing')", { screen: 'Openings', params: {} }),
  ],
};

async function counts(defs, user, scope) {
  return Promise.all(defs.map(async (d) => ({ label: d.label, count: Number((await one(d.sql, [user.id, scope ?? null].slice(0, d.sql.includes('$2') ? 2 : d.sql.includes('$1') ? 1 : 0))).count), link: d.link, sub: d.sub ?? null })));
}
export const workFor = (user, persona, scope) => counts(WORK[persona], user, scope);

/** Insights reuse the same counted queues plus one trend per role, so a number on screen always matches the queue it opens. */
const INSIGHT_EXTRA = {
  athlete: [W('Points this season', "SELECT coalesce(sum(official_points),0) AS count FROM performances WHERE user_id=$1 AND provenance='approved_competition' AND status='approved'", { tab: 'Player', params: {} })],
  coach: [W('Sessions completed (30 days)', "SELECT count(*) FROM coach_hires WHERE coach_id=$1 AND status='completed' AND starts_at > now() - interval '30 days'", { screen: 'CoachAnalytics', params: {} })],
  official: [W('Matches officiated (season)', "SELECT count(*) FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id WHERE o.user_id=$1 AND o.status='completed' AND f.scheduled_at > now() - interval '365 days'", { screen: 'OfficialsHome', params: {} })],
  event_manager: [W('Events run (all time)', "SELECT count(*) FROM events WHERE organizer_id=$1 AND status NOT IN ('cancelled')", { tab: 'Schedule', params: { section: 'manage' } })],
  venue_operator: [W('Bookings (30 days)', "SELECT count(*) FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.status IN ('confirmed') AND b.starts_at > now() - interval '30 days' AND b.starts_at < now() AND ($2::uuid IS NULL OR v.id=$2) AND " + MINE_VENUE, { screen: 'VenueWorkspace', params: {} })],
  supplier: [W('Orders completed', "SELECT count(*) FROM svc_orders o JOIN svc_profiles p ON p.id=o.profile_id WHERE o.status='completed' AND ($2::uuid IS NULL OR p.id=$2) AND (p.owner_id=$1 OR p.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))", { screen: 'SupplierWorkspace', params: {} })],
  sponsor: [W('Sponsorships ended or completed', "SELECT count(*) FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.status IN ('ended','completed') AND (sp.owner_id=$1 OR sp.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))", { screen: 'SponsorRoi', params: {} })],
};
export const insightsFor = (user, persona, scope) => counts([...WORK[persona], ...(INSIGHT_EXTRA[persona] ?? [])], user, scope);

// ------------------------------------------------------------------------------------------------ pins
/** Whether the person may pin a record: only the teams, events, venues and organisations they already act for. */
export async function canPin(user, type, id) {
  const q = {
    team: "SELECT 1 FROM teams t WHERE t.id=$2 AND (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active'))",
    event: "SELECT 1 FROM events e WHERE e.id=$2 AND (e.organizer_id=$1 OR EXISTS (SELECT 1 FROM event_entries x WHERE x.event_id=e.id AND x.user_id=$1 AND x.status IN ('pending','accepted')) OR EXISTS (SELECT 1 FROM event_staff s WHERE s.event_id=e.id AND s.user_id=$1 AND s.status IN ('invited','accepted')))",
    venue: "SELECT 1 FROM venues v WHERE v.id=$2 AND (v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff s WHERE s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL))",
    org: "SELECT 1 FROM organisation_members m WHERE m.organisation_id=$2 AND m.user_id=$1 AND m.status='active'",
  }[type];
  return !!(q && (await one(q, [user.id, id])));
}

/** Names for pinned records, read live (so a renamed or archived record never shows stale text) and only for ones the person can still reach. */
export async function resolvePins(user, pins) {
  const out = [];
  for (const p of pins) {
    const name = { team: 'SELECT name FROM teams WHERE id=$1', event: 'SELECT name FROM events WHERE id=$1', venue: 'SELECT name FROM venues WHERE id=$1', org: 'SELECT name FROM organisations WHERE id=$1' }[p.type];
    if (!name || !(await canPin(user, p.type, p.id))) continue;
    const r = await one(name, [p.id]);
    if (r) out.push({ ...p, name: r.name, link: { screen: { team: 'Team', event: 'Event', venue: 'Manage', org: 'Org' }[p.type], params: { id: p.id } } });
  }
  return out;
}
