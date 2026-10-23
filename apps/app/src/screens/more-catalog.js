// Every module the More wheel offers: [route, title, sub, group]. The route is the PAGES key in App.js.
export const MODULES = [
  ['Leaderboard', 'Leaderboard', 'Points & glory', 'play'], ['Awards', 'Trophy room', 'Cups, medals, MVPs', 'play'],
  ['MyPlans', 'Training plans', 'Your plans & sessions', 'play'], ['Pathways', 'Learn & study', 'Rules, courses & colleges', 'play'],
  ['Health', 'Health', 'Physio · doctors · fit to play', 'care'], ['Insure', 'My cover', 'What covers me today', 'care'],
  ['Insurance', 'Insurance', 'You · your team · your event', 'care'], ['Legal', 'Legal', 'Verified lawyers & matters', 'care'], ['Family', 'Family', 'Guardians & consents', 'care'],
  ['Wallet', 'Wallet', 'Balance, gift cards, loyalty', 'money'], ['Earnings', 'Earnings', 'Sales, fees & payouts', 'money'], ['Shop', 'Shop', 'Kit, gear & orders', 'money'],
  ['Billboard', 'Billboard', 'Wanted, for sale & ads', 'money'], ['Sponsors', 'Sponsors', 'Brands & deals', 'money'], ['Supply', 'Supply chain', 'Kit, stock & orders', 'money'],
  ['Openings', 'Open positions', 'Jobs, stalls & contracts at events', 'community'], ['EventInbox', 'Event requests', 'Invites & quotes for you', 'community'],
  ['Orgs', 'Organisations', 'Clubs & associations', 'community'], ['Support', 'Support', 'Cases & disputes', 'community'],
];

export const GROUP_COLOR = { play: '#FDA481', care: '#8A9BC4', money: '#FFE4D8', community: '#8697BC', work: '#4C9A7A' };

// The Workspace module: one entry per role that has its own working area, [role, route, sub, tab?] (a `tab` target goes to that tab instead of pushing the route). A person holding several of
// these gets a submenu in the wheel to pick which workspace to open; with one, the tile opens it directly.
export const WORKSPACE_MODULE = ['Workspace', 'Workspace', 'Your tools for each role', 'work'];
export const WORKSPACES = [
  ['organizer', 'Schedule', 'Your events, teams & requests', { tab: 'Schedule', section: 'manage' }],
  ['venue_manager', 'VenueWorkspace', 'Your venues, revenue & partner account'],
  ['coach', 'CoachHome', 'Athletes, plans & sessions'],
  ['referee', 'Openings', 'Games to officiate & open positions'],
  ['sponsor', 'Sponsors', 'Brands, deals & agreements'],
  ['supplier', 'Supply', 'Kit, stock & orders'],
  ['physio', 'Health', 'Your practice & rehab plans'],
  ['doctor', 'DoctorHome', 'Patients, records & results'],
  ['lawyer', 'Legal', 'Matters & clients'],
  ['insurer', 'InsurerDesk', 'Products, quotes & claims'],
  ['athlete', 'Passport', 'Player passport & QR'],
  ['admin', 'PartnerConsole', 'Partners & platform team'],
];

/** The workspaces this person can open: [role, route, sub, tab?], in catalogue order. */
export const workspacesFor = (roles = []) => WORKSPACES.filter(([r]) => roles.includes(r));

// Modules lifted to the front of the wheel for people who hold these roles (first match wins; everyone else: player set).
export const PRIORITY = [
  [['organizer', 'venue_manager'], ['EventInbox', 'Openings', 'Orgs', 'Earnings', 'Billboard', 'Support']],
  [['sponsor', 'supplier'], ['Sponsors', 'Supply', 'Wallet', 'Earnings', 'Billboard', 'Shop']],
  [['physio', 'doctor', 'lawyer', 'insurer'], ['Health', 'Insure', 'Legal', 'Wallet', 'Leaderboard', 'Support']],
];
export const PRIORITY_DEFAULT = ['Leaderboard', 'Health', 'Insure', 'Wallet', 'Shop', 'Billboard'];

/** The wheel's order for someone with these roles: their priority modules first, then the rest in catalogue order. */
export function orderedModules(roles = []) {
  const first = (PRIORITY.find(([rs]) => rs.some((r) => roles.includes(r))) ?? [null, PRIORITY_DEFAULT])[1];
  const byName = Object.fromEntries(MODULES.map((m) => [m[0], m]));
  const work = workspacesFor(roles).length ? [WORKSPACE_MODULE] : [];
  return [...work, ...first.map((n) => byName[n]), ...MODULES.filter((m) => !first.includes(m[0]))];
}
