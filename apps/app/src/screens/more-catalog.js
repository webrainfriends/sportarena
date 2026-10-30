// Every module the More wheel offers: [route, title, sub, group]. The route is the PAGES key in App.js.
export const MODULES = [
  ['Leaderboard', 'Leaderboard', 'Points & glory', 'play'], ['Awards', 'Trophy room', 'Cups, medals, MVPs', 'play'],
  ['CareerTimeline', 'Career & clubs', 'Your clubs, verified by them', 'play'], ['SportsGraph', 'Sports graph', 'Search people, clubs, teams & events', 'play'], ['MyLicences', 'My licences', 'Federation licences & standing', 'play'], ['MyIntegrity', 'My integrity', 'Notices, exemptions & education', 'play'],
  ['FindGames', 'Find a game', 'Open games near you, today & this weekend', 'play'], ['MyApplications', 'My applications', 'Trials, offers & answers', 'play'],
  ['MyAccreditations', 'My badges', 'Event accreditation & QR', 'play'],
  ['MyPasses', 'My passes', 'Rotating QR pass, cards & wristbands', 'play'],
  ['Following', 'Following', 'Events, teams & games you follow', 'play'],
  ['RecruiterAccess', 'Recruiter access', 'Who may see your profile', 'play'],
  ['MyDevelopment', 'My development', 'Goals, plans, feedback & reports', 'play'], ['MyPlans', 'Training plans', 'Your plans & sessions', 'play'], ['ToolsHome', 'Tools', 'Scoring sheets & documents', 'play'], ['Pathways', 'Learn & study', 'Rules, courses & colleges', 'play'], ['OpportunityMatches', 'Opportunities for me', 'Teams, trials, study & sponsors that fit you', 'play'],
  ['MyCompliance', 'Compliance', 'Requirements, expiries & safeguarding', 'care'],
  ['Health', 'Health', 'Physio · doctors · fit to play', 'care'], ['Insure', 'My cover', 'What covers me today', 'care'],
  ['Insurance', 'Insurance', 'You · your team · your event', 'care'], ['Legal', 'Legal', 'Verified lawyers & matters', 'care'], ['Family', 'Family', 'Guardians & consents', 'care'],
  ['Finance', 'Finance', 'Revenue, receivables & reconciliation', 'money'], ['Wallet', 'Wallet', 'Balance, gift cards & passes', 'money'], ['PlansBilling', 'Plans & billing', 'Your plan, upgrades & payment', 'money'], ['Rewards', 'Rewards', 'Points, invites & statement', 'money'], ['Cover', 'Who pays', 'Sponsor, club & family payments', 'money'], ['Advertising', 'Advertising', 'Promote your venue, event or business', 'money'], ['Earnings', 'Earnings', 'Sales, fees & payouts', 'money'], ['PlayerContracts', 'Contracts', 'Fees, bonuses, expenses & pay', 'money'], ['Representation', 'Representation', 'Your agent, what they can see & commission', 'money'], ['PlayerFunding', 'Funding', 'Needs, applications & sponsor support', 'money'], ['Shop', 'Shop', 'Kit, gear & orders', 'money'],
  ['Billboard', 'Billboard', 'Wanted, for sale & ads', 'money'], ['Sponsors', 'Sponsor home', 'Offers, dues & agreements', 'money'], ['Supply', 'Supply chain', 'Kit, stock & orders', 'money'], ['Marketplace', 'Marketplace', 'Find, quote, contract & pay any sports service', 'work'], ['ServicesBuyer', 'Services & suppliers', 'Buy grounds, crew, Wi-Fi, travel…', 'work'], ['Trips', 'Trips & travel', 'Itineraries, travel party, stays & movement', 'play'],
  ['Openings', 'Open positions', 'Jobs, stalls & contracts at events', 'community'], ['EventInbox', 'Event requests', 'Invites & quotes for you', 'community'],
  ['Orgs', 'Organisations', 'Clubs & associations', 'community'], ['Federations', 'Federations', 'Affiliations, licences & sanctions', 'community'], ['RegistrationHome', 'Registration', 'Join, register and run registrations', 'community'], ['MediaWorkspace', 'Media & broadcast', 'Rights, production & data feeds', 'work'], ['Analytics', 'Analytics', 'KPIs, dashboards & scheduled reports', 'work'], ['Support', 'Support', 'Cases & disputes', 'community'],
];

export const GROUP_COLOR = { play: '#D0BDF4', care: '#A0D2EB', money: '#E5EAF5', community: '#A0D2EB', work: '#4C9A7A' };

// The Workspace module: one entry per role that has its own working area, [role, route, sub, tab?] (a `tab` target goes to that tab instead of pushing the route). A person holding several of
// these gets a submenu in the wheel to pick which workspace to open; with one, the tile opens it directly.
export const WORKSPACE_MODULE = ['Workspace', 'Workspace', 'Your tools for each role', 'work'];
export const WORKSPACES = [
  ['organizer', 'Schedule', 'Your events, teams & requests', { tab: 'Schedule', section: 'manage' }],
  ['venue_manager', 'VenueWorkspace', 'Your venues, revenue & partner account'],
  ['coach', 'CoachHome', 'Athletes, plans & sessions'],
  ['referee', 'OfficialsHome', 'Matches, requests, calendar & rules'],
  ['sponsor', 'Sponsors', 'Offers, dues & agreements'],
  ['supplier', 'SupplierWorkspace', 'Services, quotes, orders & invoices'],
  ['physio', 'Health', 'Your practice & rehab plans'],
  ['doctor', 'DoctorHome', 'Patients, records & results'],
  ['lawyer', 'Legal', 'Matters & clients'],
  ['recruiter', 'RecruiterHome', 'Pipeline, requests & messages'],
  ['agent', 'Representation', 'Clients, mandates, negotiations & commission'],
  ['insurer', 'InsurerDesk', 'Products, quotes & claims'],
  ['athlete', 'Passport', 'Player passport & QR'],
  ['admin', 'PartnerConsole', 'Partners & platform team'],
  ['platform_admin', 'CommercialConsole', 'Catalogue, pricing & entitlements'],
];

/** The workspaces this person can open: [role, route, sub, tab?], in catalogue order. */
export const workspacesFor = (roles = []) => WORKSPACES.filter(([r]) => roles.includes(r));

// Modules lifted to the front of the wheel for people who hold these roles (first match wins; everyone else: player set).
export const PRIORITY = [
  [['organizer', 'venue_manager'], ['Analytics', 'EventInbox', 'Openings', 'Orgs', 'Federations', 'RegistrationHome', 'MediaWorkspace', 'Finance', 'Earnings', 'PlayerContracts', 'Billboard', 'Support', 'ToolsHome']],
  [['sponsor', 'supplier'], ['Sponsors', 'Analytics', 'Supply', 'Wallet', 'Earnings', 'Billboard', 'Shop', 'ToolsHome']],
  [['physio', 'doctor', 'lawyer', 'insurer'], ['Health', 'Insure', 'Legal', 'Wallet', 'Leaderboard', 'Support', 'ToolsHome']],
];
export const PRIORITY_DEFAULT = ['FindGames', 'Leaderboard', 'MyApplications', 'PlayerContracts', 'Representation', 'Health', 'Insure', 'Wallet', 'Shop', 'Billboard', 'ToolsHome'];

/** The wheel's order for someone with these roles: their priority modules first, then the rest in catalogue order. */
export function orderedModules(roles = []) {
  const first = (PRIORITY.find(([rs]) => rs.some((r) => roles.includes(r))) ?? [null, PRIORITY_DEFAULT])[1];
  const byName = Object.fromEntries(MODULES.map((m) => [m[0], m]));
  const work = workspacesFor(roles).length ? [WORKSPACE_MODULE] : [];
  return [...work, ...first.map((n) => byName[n]), ...MODULES.filter((m) => !first.includes(m[0]))];
}
