// Guided setup by persona (#514): a launch checklist that walks an academy, club, school, venue, event organiser or coach from an empty
// account to a first live transaction. It owns no progress of its own: every step is derived from the real records the platform already
// holds (organisation, teams, programmes, venues, bookings, imports), so it can never disagree with them and nothing has to be ticked by hand.
// Each step points at the screen that does the job; it never creates anything itself. The only thing stored is which persona a person
// picked (and whether they dismissed the card).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { orgFor } from '../org-access.js';

const TAG = 'Migration';
const PERSONAS = [
  { key: 'academy', label: 'Academy', emoji: '🎓', blurb: 'Programmes, cohorts, fees and your families', scope: 'organisation', kinds: ['academy'] },
  { key: 'club', label: 'Club', emoji: '🛡️', blurb: 'Teams, members, seasons and fixtures', scope: 'organisation', kinds: ['club', 'company', 'other'] },
  { key: 'school', label: 'School or college', emoji: '🏫', blurb: 'Houses, teams and sports days', scope: 'organisation', kinds: ['school', 'college', 'university'] },
  { key: 'venue', label: 'Venue', emoji: '🏟️', blurb: 'Courts, hours, rates and bookings', scope: 'user', kinds: [] },
  { key: 'organiser', label: 'Event organiser', emoji: '🏆', blurb: 'An event, its teams and its games', scope: 'user', kinds: [] },
  { key: 'coach', label: 'Coach', emoji: '📋', blurb: 'Your profile, your team and your players', scope: 'user', kinds: [] },
];
const STAFF = ['owner', 'admin'];
const go = (screen, params = {}) => ({ screen, params });
const tab = (name) => ({ tab: name });
const step = (key, title, why, done, target, extra = {}) => ({ key, title, why, done: !!done, target, ...extra });
const n = async (sql, p) => (await one(sql, p))?.n ?? 0;

async function orgSteps(persona, org) {
  const o = org.id;
  const [members, teams, programmes, cohorts, seasons, events, imports, enrolled, charges] = await Promise.all([
    n("SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id=$1 AND status IN ('active','invited')", [o]),
    n('SELECT count(*)::int AS n FROM teams WHERE organisation_id=$1 AND archived_at IS NULL', [o]),
    n('SELECT count(*)::int AS n FROM academy_programmes WHERE organisation_id=$1', [o]),
    n("SELECT count(*)::int AS n FROM org_cohorts WHERE organisation_id=$1 AND status='active'", [o]),
    n("SELECT count(*)::int AS n FROM org_seasons WHERE organisation_id=$1 AND status='active'", [o]),
    n('SELECT count(*)::int AS n FROM events WHERE organisation_id=$1', [o]),
    n("SELECT count(*)::int AS n FROM migration_projects WHERE organisation_id=$1 AND status IN ('completed','reconciliation')", [o]),
    n("SELECT count(*)::int AS n FROM org_enrolments e JOIN org_cohorts c ON c.id=e.cohort_id WHERE c.organisation_id=$1", [o]),
    n('SELECT count(*)::int AS n FROM academy_charges WHERE organisation_id=$1', [o]),
  ]);
  const org_ = go('Org', { id: o });
  const steps = [
    step('workspace', 'Create your workspace', 'Your name, type and a short description that members and families can read.', true, org_),
    step('legal', 'Add your legal name and tax number', 'They appear on agreements and invoices. Add your GST, VAT or tax number so invoices are valid from day one.', org.legal_name && org.tax_id, go('Org', { id: o, tab: 'overview' })),
    step('contact', 'Add contact details', 'An email or phone number families and sponsors can reach you on.', org.contact_email || org.contact_phone, go('Org', { id: o, tab: 'overview' })),
    step('staff', 'Invite your coaches and admins', 'Give each person a role so they only see what they need.', members > 1, go('Org', { id: o, tab: 'people' })),
  ];
  if (persona === 'academy') steps.push(step('structure', 'Create your first programme', 'Programmes carry the age range, schedule and fee that families apply for.', programmes > 0 || cohorts > 0, go('Org', { id: o, tab: 'academy' })));
  else steps.push(step('structure', 'Create your first team', 'Teams hold your roster, availability and fixtures.', teams > 0, go('Org', { id: o, tab: 'assets' })));
  steps.push(step('season', 'Set up a season', 'A season dates your programmes, teams and attendance.', seasons > 0, go('Org', { id: o, tab: 'cohorts' })));
  steps.push(step('people', 'Bring your people across', 'Import your roster from TeamSnap, SportsEngine or a spreadsheet. You see everything before it is saved.', imports > 0 || enrolled > 0, go('Migrate', { organisation_id: o }), { action: 'import' }));
  steps.push(persona === 'academy'
    ? step('first_transaction', 'Raise your first fee', 'The first fee or invoice proves your money flow works end to end.', charges > 0, go('Org', { id: o, tab: 'academy' }))
    : step('first_transaction', 'Run your first event or fixture', 'Create something your members can see and respond to.', events > 0, go('Org', { id: o, tab: 'assets' })));
  return steps;
}

async function userSteps(persona, user) {
  if (persona === 'venue') {
    const [venues, courts, hours, priced, bookings] = await Promise.all([
      n('SELECT count(*)::int AS n FROM venues WHERE owner_id=$1', [user.id]),
      n('SELECT count(*)::int AS n FROM resources r JOIN venues v ON v.id=r.venue_id WHERE v.owner_id=$1 AND r.active', [user.id]),
      n('SELECT count(*)::int AS n FROM venue_hours h JOIN venues v ON v.id=h.venue_id WHERE v.owner_id=$1', [user.id]),
      n('SELECT count(*)::int AS n FROM resources r JOIN venues v ON v.id=r.venue_id WHERE v.owner_id=$1 AND r.active AND r.hourly_rate_cents>0', [user.id]),
      n("SELECT count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE v.owner_id=$1 AND b.status='confirmed'", [user.id]),
    ]);
    return [
      step('venue', 'Add your venue', 'Name, address and the sports it hosts.', venues > 0, go('VenueWorkspace')),
      step('courts', 'Add your courts, grounds or rooms', 'Each one has its own capacity and slot length.', courts > 0, go('VenueWorkspace')),
      step('hours', 'Set your opening hours', 'People can only book when you are open.', hours > 0, go('VenueWorkspace')),
      step('rates', 'Set your hourly rates', 'Prices include tax. Peak and off-peak rules can be added later.', priced > 0, go('VenueWorkspace')),
      step('first_transaction', 'Take your first booking', 'Make a test booking yourself, or share your venue page.', bookings > 0, go('VenueWorkspace')),
    ];
  }
  if (persona === 'organiser') {
    const [evs, fixtures, open] = await Promise.all([
      n('SELECT count(*)::int AS n FROM events WHERE organizer_id=$1', [user.id]),
      n('SELECT count(*)::int AS n FROM fixtures f JOIN events e ON e.id=f.event_id WHERE e.organizer_id=$1', [user.id]),
      n("SELECT count(*)::int AS n FROM events WHERE organizer_id=$1 AND status IN ('open','ongoing','completed')", [user.id]),
    ]);
    return [
      step('event', 'Create your event', 'Sports, dates, venue and format.', evs > 0, tab('Explore')),
      step('open', 'Open it for entries', 'Teams can only enter once the event is open.', open > 0, tab('Explore')),
      step('first_transaction', 'Schedule your first games', 'The schedule checks referee and team clashes for you.', fixtures > 0, tab('Explore')),
    ];
  }
  const [profile, teams, people] = await Promise.all([
    n('SELECT count(*)::int AS n FROM coach_profiles WHERE user_id=$1', [user.id]),
    n('SELECT count(*)::int AS n FROM teams WHERE owner_id=$1 AND archived_at IS NULL', [user.id]),
    n("SELECT count(*)::int AS n FROM team_members m JOIN teams t ON t.id=m.team_id WHERE t.owner_id=$1 AND m.user_id<>$1 AND m.status IN ('active','invited')", [user.id]),
  ]);
  return [
    step('profile', 'Set up your coach profile', 'Your headline, specialities and hours, so people can find and book you.', profile > 0, go('CoachSetup')),
    step('team', 'Create your team', 'Your roster, availability and schedule live here.', teams > 0, tab('Explore')),
    step('first_transaction', 'Invite your players', 'Invite people you already know, or bring a whole roster across from an organisation workspace.', people > 0, tab('Explore')),
  ];
}

cap({
  name: 'get_launch_checklist', method: 'GET', path: '/me/launch-checklist', tag: TAG,
  summary: 'Guided setup for a persona (academy, club, school, venue, event organiser, coach): the ordered steps from an empty account to a first live transaction, each derived from the real records you already have, with the screen that does it. Academy, club and school steps are for one organisation you own or administer (organisation_id, default the first that fits). Nothing is stored except your chosen persona.',
  input: z.object({ persona: z.enum(PERSONAS.map((p) => p.key)).optional(), organisation_id: id.optional() }),
  async handler({ user }, i) {
    const pref = await one('SELECT persona, dismissed_at FROM setup_preferences WHERE user_id=$1', [user.id]);
    const orgs = await many(
      `SELECT o.id, o.name, o.kind FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id
        WHERE m.user_id=$1 AND m.status='active' AND m.role = ANY($2) AND o.status='active' ORDER BY o.created_at`, [user.id, STAFF]);
    const fits = (p) => orgs.filter((o) => PERSONAS.find((x) => x.key === p)?.kinds.includes(o.kind));
    // a sensible first persona from what the person already runs and the roles they hold
    const suggested = orgs.length ? PERSONAS.find((p) => fits(p.key).length)?.key ?? 'club'
      : user.roles?.includes('venue_manager') ? 'venue' : user.roles?.includes('organizer') ? 'organiser' : user.roles?.includes('coach') ? 'coach' : null;
    const persona = i.persona ?? pref?.persona ?? suggested;
    const base = { personas: PERSONAS.map(({ key, label, emoji, blurb, scope }) => ({ key, label, emoji, blurb, scope })), persona, suggested, dismissed: !!pref?.dismissed_at, organisations: orgs };
    const meta = PERSONAS.find((p) => p.key === persona);
    if (!meta) return { ...base, steps: [], done: 0, total: 0, next: null };
    let steps, organisation = null;
    if (meta.scope === 'organisation') {
      const pick = i.organisation_id ? orgs.find((o) => o.id === i.organisation_id) : fits(persona)[0] ?? orgs[0];
      if (i.organisation_id) await orgFor(user, i.organisation_id, STAFF); // 404 for outsiders, never a hint that it exists
      if (!pick) steps = [step('workspace', 'Create your workspace', 'A workspace holds your teams, people, programmes and money. You become its owner.', false, go('Orgs'))];
      else {
        organisation = pick;
        steps = await orgSteps(persona, await one('SELECT * FROM organisations WHERE id=$1', [pick.id]));
      }
    } else steps = await userSteps(persona, user);
    const done = steps.filter((s) => s.done).length;
    return { ...base, organisation, steps, done, total: steps.length, next: steps.find((s) => !s.done)?.key ?? null, complete: done === steps.length };
  },
});

cap({
  name: 'set_launch_persona', method: 'PATCH', path: '/me/launch-checklist', tag: TAG,
  summary: 'Choose which persona your launch checklist follows, or hide / show the Home card. Changes only this preference.',
  input: z.object({ persona: z.enum(PERSONAS.map((p) => p.key)).optional(), dismissed: z.boolean().optional() }),
  async handler({ user }, i) {
    const r = await one(
      `INSERT INTO setup_preferences(user_id, persona, dismissed_at) VALUES ($1,$2,CASE WHEN $3::boolean THEN now() END)
       ON CONFLICT (user_id) DO UPDATE SET persona=coalesce($2, setup_preferences.persona),
         dismissed_at=CASE WHEN $3::boolean IS NULL THEN setup_preferences.dismissed_at WHEN $3 THEN coalesce(setup_preferences.dismissed_at, now()) ELSE NULL END, updated_at=now()
       RETURNING persona, dismissed_at`, [user.id, i.persona ?? null, i.dismissed ?? null]);
    return { persona: r.persona, dismissed: !!r.dismissed_at };
  },
});
