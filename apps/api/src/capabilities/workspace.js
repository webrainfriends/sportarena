import { z } from 'zod';
import { cap, capabilities } from '../registry.js';
import { one, many } from '../db.js';
import { forbidden } from '../errors.js';
import { invoke } from '../invoke.js';

// The role-driven mobile workspace (issue #599). The app opens on what the signed-in person does, not on the platform's modules:
// Home (today and what needs me), Calendar, Work (the queue and the fast actions of the active role), Inbox and Profile.
// This capability is the one place that decides, per role, which fast actions and which work items to show. It owns no data: every
// number and item is read through the capability that already owns it (coach_home, get_officials_home, list_my_selections,
// venue_operations_overview, ...), so the rules, permissions and encryption of those capabilities apply unchanged and the app,
// REST clients and MCP agents all see the same queue. Items point at the screen that resolves them; nothing is changed here.
const TAG = 'Workspace';

// Roles that have their own workspace. Platform roles (admin, platform_admin) are never listed or switchable.
const ROLE_LABEL = {
  athlete: 'Athlete', coach: 'Coach', organizer: 'Event manager', referee: 'Official', venue_manager: 'Venue operator',
  sponsor: 'Sponsor', physio: 'Physio', doctor: 'Doctor', supplier: 'Supplier', insurer: 'Insurer', lawyer: 'Lawyer', recruiter: 'Recruiter / scout',
};
// Roles whose workspace is built natively below; the others get the labelled generic workspace (their own home screen + inbox).
const NATIVE = ['athlete', 'coach', 'organizer', 'referee', 'venue_manager'];
const ORDER = [...NATIVE, ...Object.keys(ROLE_LABEL).filter((r) => !NATIVE.includes(r))];
const OWN_HOME = { sponsor: 'Sponsors', physio: 'Health', doctor: 'DoctorHome', supplier: 'SupplierWorkspace', insurer: 'InsurerDesk', lawyer: 'Legal', recruiter: 'RecruiterHome' };

const go = (screen, params = {}) => ({ screen, params });
const tab = (name, section) => ({ tab: name, ...(section ? { section } : {}) });
const act = (key, label, icon, target, extra = {}) => ({ key, label, icon, target, ...extra });
const call = async (name, user, input = {}) => {
  const c = capabilities.find((x) => x.name === name);
  try { return await invoke(c, user, input); } catch { return null; } // one source being unavailable must not blank the whole workspace
};
const soon = (iso, hours) => !!iso && new Date(iso).getTime() < Date.now() + hours * 3600000;
// `quick` = one-tap answers an item can carry. They call the owning capability's own endpoint, are plain state changes (so a retry after a
// dropped connection is harmless) and are checked again by that capability: ownership, status and clashes are never decided here.
const item = (kind, title, detail, target, at, urgency = 'info', quick) => ({ kind, title, detail: detail ?? '', target, at: at ?? null, urgency, ...(quick ? { quick } : {}) });
const answer = (label, tone, method, path, body) => ({ label, tone, method, path, body });

// ---------------------------------------------------------------------------------------------------------------- per-role builders
// Each returns { summary: [{key,label,value}], today: [item], work: [item], actions: [action], unavailable?: [string] }.
async function athlete(user) {
  const [sel, staff, passes, invites] = await Promise.all([
    call('list_my_selections', user, { limit: 20 }),
    call('list_my_staff_assignments', user, { status: 'invited', limit: 20 }),
    call('list_my_accreditations', user, {}),
    many("SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='invited' ORDER BY t.name LIMIT 10", [user.id]),
  ]);
  const pending = (sel ?? []).filter((s) => s.status === 'selected');
  const work = [
    ...pending.map((s) => item('selection', `Confirm you can play: ${s.team_name}`, s.event_name ?? s.round ?? '', go('Team', { id: s.team_id }), s.scheduled_at, soon(s.scheduled_at, 48) ? 'now' : 'soon',
      [answer('I can play', 'yes', 'PATCH', `/squads/${s.squad_id}`, { status: 'confirmed' }), answer("I can't", 'no', 'PATCH', `/squads/${s.squad_id}`, { status: 'declined' })])),
    ...invites.map((t) => item('team_invite', `Team invitation: ${t.name}`, '', go('Team', { id: t.id }), null, 'soon')),
    ...(staff ?? []).map((a) => item('staff_offer', `Event role offered: ${a.title ?? a.role}`, a.event_name, go('MyAccreditations'), a.starts_on, 'soon',
      [answer('Accept', 'yes', 'POST', `/staff-assignments/${a.id}/respond`, { accept: true }), answer('Decline', 'no', 'POST', `/staff-assignments/${a.id}/respond`, { accept: false })])),
  ];
  const today = (sel ?? []).filter((s) => s.status === 'confirmed' && soon(s.scheduled_at, 24)).map((s) => item('match', `${s.team_name}${s.event_name ? ` · ${s.event_name}` : ''}`, '', go('Team', { id: s.team_id }), s.scheduled_at, 'now'));
  return {
    summary: [{ key: 'selections', label: 'To confirm', value: pending.length }, { key: 'upcoming', label: 'Upcoming', value: (sel ?? []).filter((s) => s.status === 'confirmed').length }, { key: 'passes', label: 'My passes', value: (passes ?? []).length }],
    today, work,
    actions: [
      act('availability', 'Set availability', 'calendar', tab('Schedule', 'agenda')),
      act('pass', 'Show my pass', 'qr', go('MyPasses')),
      act('log', 'Log a match', 'edit', tab('Player')),
      act('find', 'Find a game', 'search', go('FindGames')),
    ],
    unavailable: [sel, staff, passes].some((x) => x === null) ? ['selections'] : [],
  };
}

async function coach(user) {
  const h = await call('coach_home', user);
  const inbox = h?.inbox ?? [];
  const work = inbox.map((x) => item(x.kind, x.title, x.detail, x.link?.screen ? go(x.link.screen, x.link.params ?? {}) : go('CoachHome'), x.at, x.kind === 'hire_request' ? 'now' : 'soon'));
  const next = h?.next_session;
  return {
    summary: [{ key: 'athletes', label: 'Athletes', value: h?.counts?.athletes ?? 0 }, { key: 'requests', label: 'Requests', value: h?.counts?.requests ?? 0 }, { key: 'revisions', label: 'Plan replies', value: h?.counts?.plans_needing_revision ?? 0 }],
    today: next && soon(next.starts_at, 24) ? [item('session', next.title ?? 'Coaching session', '', go('CoachCalendar'), next.starts_at, 'now')] : [],
    work: [...work, ...(h?.warnings ?? []).map((w) => item('warning', w.title, '', go(w.link?.screen ?? 'CoachHome', w.link?.params ?? {}), null, 'soon'))],
    actions: [
      act('attendance', 'Take attendance', 'check', go('AcademyAgenda')),
      act('calendar', 'My sessions', 'calendar', go('CoachCalendar')),
      act('athletes', 'My athletes', 'people', go('CoachAthletes')),
      act('requests', 'Coaching requests', 'inbox', go('CoachBoard')),
    ],
    unavailable: h ? [] : ['coach_home'],
  };
}

async function organizer(user) {
  const events = await many(
    `SELECT e.id, e.name, e.status, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on,
            (SELECT count(*)::int FROM event_entries n WHERE n.event_id=e.id AND n.status='pending') AS pending_entries,
            (SELECT coalesce(sum(greatest(r.needed - (SELECT count(*) FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='accepted'), 0)), 0)::int FROM event_staff_roles r WHERE r.event_id=e.id AND r.closed_at IS NULL) AS open_positions,
            (SELECT count(*)::int FROM accreditations k WHERE k.event_id=e.id AND k.status IN ('submitted','under_review')) AS pending_badges
       FROM events e WHERE e.organizer_id=$1 AND e.status NOT IN ('cancelled','completed') ORDER BY e.starts_on NULLS LAST, e.created_at DESC LIMIT 12`, [user.id]);
  const todayIso = new Date().toISOString().slice(0, 10);
  const running = events.filter((e) => e.starts_on && e.starts_on <= todayIso && (e.ends_on ?? e.starts_on) >= todayIso);
  const gateEvent = running[0] ?? events[0] ?? null; // the scanner opens on the event happening today, else the nearest one
  const work = events.flatMap((e) => [
    ...(e.pending_entries ? [item('entries', `${e.pending_entries} entr${e.pending_entries === 1 ? 'y' : 'ies'} to approve`, e.name, go('EventCommand', { id: e.id }), e.starts_on, 'now')] : []),
    ...(e.pending_badges ? [item('badges', `${e.pending_badges} badge${e.pending_badges === 1 ? '' : 's'} to decide`, e.name, go('EventCommand', { id: e.id, tab: 'accreditation' }), e.starts_on, 'now')] : []),
    ...(e.open_positions ? [item('positions', `${e.open_positions} position${e.open_positions === 1 ? '' : 's'} still to fill`, e.name, go('EventCommand', { id: e.id }), e.starts_on, 'soon')] : []),
  ]);
  return {
    summary: [{ key: 'events', label: 'Events', value: events.length }, { key: 'running', label: 'Today', value: running.length }, { key: 'approvals', label: 'To approve', value: events.reduce((n, e) => n + e.pending_entries + e.pending_badges, 0) }],
    today: running.map((e) => item('event', e.name, e.status, go('EventCommand', { id: e.id }), e.starts_on, 'now')),
    work,
    actions: [
      act('console', 'Event console', 'event', gateEvent ? go('EventCommand', { id: gateEvent.id }) : tab('Schedule', 'manage'), gateEvent ? {} : { hint: 'Create an event first' }),
      act('scan', 'Scan at the gate', 'scan', gateEvent ? go('GateScan', { id: gateEvent.id }) : null, gateEvent ? { camera: true } : { disabled: 'No event to scan for yet' }),
      act('approvals', 'Approvals', 'check', gateEvent ? go('EventCommand', { id: (events.find((e) => e.pending_entries || e.pending_badges) ?? gateEvent).id, tab: events.some((e) => e.pending_badges) ? 'accreditation' : 'overview' }) : null, gateEvent ? {} : { disabled: 'No event yet' }),
      act('create', 'Create event', 'add', tab('Schedule', 'manage')),
    ],
  };
}

async function referee(user) {
  const h = await call('get_officials_home', user, {});
  const KIND_TAB = { invitation: 'today', changed: 'today', released: 'today', checklist: 'today', report_due: 'history', dispute: 'history', credential: 'credential' };
  const work = (h?.inbox ?? []).map((x) => item(x.kind, x.title, x.detail, go('OfficialsHome', { tab: KIND_TAB[x.kind] ?? 'today' }), x.at, ['invitation', 'changed'].includes(x.kind) ? 'now' : 'soon',
    x.kind === 'invitation' ? [answer('Accept', 'yes', 'POST', `/official-assignments/${x.official_id}/respond`, { response: 'accept' }), answer('Decline', 'no', 'POST', `/official-assignments/${x.official_id}/respond`, { response: 'decline' })]
      : x.kind === 'changed' ? [answer('Acknowledge', 'yes', 'POST', `/official-assignments/${x.official_id}/respond`, { response: 'accept' })] : undefined));
  return {
    summary: [{ key: 'today', label: 'Today', value: h?.today?.length ?? 0 }, { key: 'pending', label: 'Requests', value: h?.stats?.pending ?? 0 }, { key: 'week', label: 'This week', value: h?.stats?.this_week ?? 0 }],
    today: (h?.today ?? []).map((a) => item('assignment', `${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`, `${a.role} · ${a.event_name}`, go('OfficialMatch', { id: a.fixture_id }), a.scheduled_at, 'now')),
    work,
    actions: [
      act('assignments', 'My assignments', 'calendar', go('OfficialsHome', { tab: 'calendar' })),
      act('availability', 'My availability', 'clock', go('OfficialsHome', { tab: 'availability' })),
      act('requests', 'Pending requests', 'inbox', go('OfficialsHome', { tab: 'today' })),
      act('match', 'Match-day console', 'whistle', h?.next ? go('MatchCentre', { id: h.next.fixture_id }) : null, h?.next ? {} : { disabled: 'No upcoming assignment' }),
    ],
    unavailable: h ? [] : ['officials_home'],
  };
}

async function venueManager(user) {
  const venues = (await call('list_my_venues', user)) ?? [];
  const live = venues.filter((v) => v.active !== false).slice(0, 6);
  const ops = await Promise.all(live.map(async (v) => ({ v, o: await call('venue_operations_overview', user, { id: v.id }), today: await one(
    `SELECT count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at::date = current_date`, [v.id]) })));
  const work = ops.flatMap(({ v, o }) => (o?.attention ?? []).map((a) => item(a.key, a.text, v.name, go('Manage', { id: v.id, tab: a.key.startsWith('maintenance') ? 'maintenance' : 'schedule' }), null, a.key.startsWith('maintenance') ? 'now' : 'soon')));
  const first = live[0] ?? null;
  const bookingsToday = ops.reduce((n, x) => n + (x.today?.n ?? 0), 0);
  return {
    summary: [{ key: 'venues', label: 'Venues', value: venues.length }, { key: 'today', label: 'Bookings today', value: bookingsToday }, { key: 'attention', label: 'Need attention', value: work.length }],
    today: ops.filter((x) => x.today?.n).map(({ v, today }) => item('bookings', `${today.n} booking${today.n === 1 ? '' : 's'} today`, v.name, go('Manage', { id: v.id, tab: 'schedule' }), null, 'now')),
    work,
    actions: [
      act('today', 'Today at the venue', 'calendar', first ? go('Manage', { id: first.id, tab: 'schedule' }) : go('VenueWorkspace'), first ? {} : { hint: 'Register a venue first' }),
      act('checkin', 'Check people in', 'scan', first ? go('Manage', { id: first.id, tab: 'access' }) : null, first ? { camera: true } : { disabled: 'No venue yet' }),
      act('checks', 'Venue checks', 'check', first ? go('Manage', { id: first.id, tab: 'maintenance' }) : null, first ? {} : { disabled: 'No venue yet' }),
      act('desk', 'Front desk', 'cash', first ? go('Manage', { id: first.id, tab: 'frontdesk' }) : null, first ? {} : { disabled: 'No venue yet' }),
    ],
  };
}

// Every other role: their own home screen is the workspace (labelled generic: no queue is composed for them yet).
const generic = (role) => ({
  generic: true, summary: [], today: [], work: [],
  actions: [act('home', `Open my ${ROLE_LABEL[role]?.toLowerCase() ?? 'workspace'}`, 'home', OWN_HOME[role] ? go(OWN_HOME[role]) : tab('Explore')), act('find', 'Find a game', 'search', go('FindGames'))],
});
const BUILD = { athlete, coach, organizer, referee, venue_manager: venueManager };

cap({
  name: 'get_my_workspace', method: 'GET', path: '/me/workspace', tag: TAG,
  summary: 'Your role-driven mobile workspace: the roles and organisations you can switch between, then for the active role today\'s items, the queue of things waiting on you, headline numbers and the fast actions (each names the screen that does it). Read-only; it composes the role homes, so it shows only what those already let you see.',
  input: z.object({ role: z.enum(Object.keys(ROLE_LABEL)).optional().describe('which of your roles to show; defaults to your first role') }),
  async handler({ user }, i) {
    const held = ORDER.filter((r) => user.roles?.includes(r)); // admin / platform_admin are never offered
    if (i.role && !held.includes(i.role)) throw forbidden('You do not hold that role');
    const role = i.role ?? held[0] ?? null;
    const [orgs, unread] = await Promise.all([
      many(`SELECT o.id, o.name, m.role AS my_role FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name LIMIT 20`, [user.id]),
      one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id]),
    ]);
    const body = role ? await (BUILD[role]?.(user) ?? generic(role)) : { generic: true, summary: [], today: [], work: [], actions: [act('find', 'Find a game', 'search', go('FindGames')), act('book', 'Book a venue', 'calendar', tab('Schedule', 'book'))] };
    const rank = { now: 0, soon: 1, info: 2 };
    const work = body.work.sort((a, b) => rank[a.urgency] - rank[b.urgency] || String(a.at ?? '9').localeCompare(String(b.at ?? '9'))).slice(0, 50);
    return {
      role, role_label: role ? ROLE_LABEL[role] : null,
      roles: held.map((r) => ({ key: r, label: ROLE_LABEL[r], native: NATIVE.includes(r) })),
      organisations: orgs, unread: unread.n,
      generic: !!body.generic, summary: body.summary, today: body.today.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))), work,
      actions: body.actions, unavailable: body.unavailable ?? [], as_of: new Date().toISOString(),
    };
  },
});
