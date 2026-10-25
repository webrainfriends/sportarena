// The one role vocabulary for everyone who acts for a sponsor brand (#347), exactly as the API and MCP return it as `my_role`.
// Owners, admins and portfolio managers act as a brand's manager; the server still enforces every action.
export const SPONSOR_TEAM_ROLES = [
  { value: 'owner', label: 'Owner', help: 'Everything, including owners' },
  { value: 'admin', label: 'Admin', help: 'Identity, team, portfolios, offers' },
  { value: 'manager', label: 'Manager', help: 'Runs the brand, its deals and contacts; no team or identity changes' },
  { value: 'approver', label: 'Approver', help: 'Proposes, revises, withdraws and signs for the brand; cannot pay' },
  { value: 'finance', label: 'Finance', help: 'Payments, budgets and exports' },
  { value: 'legal', label: 'Legal', help: 'Reviews and changes terms and contracts; cannot pay' },
  { value: 'evaluator', label: 'Evaluator', help: 'Objectives and reviews; cannot pay or sign' },
  { value: 'auditor', label: 'Auditor', help: 'Read-only, with exports' },
  { value: 'portfolio_manager', label: 'Portfolio manager', help: 'Offers for assigned portfolios only' },
  { value: 'viewer', label: 'Viewer', help: 'Read only' },
];
export const SPONSOR_ROLE_LABEL = Object.fromEntries(SPONSOR_TEAM_ROLES.map((r) => [r.value, r.label]));
export const SPONSOR_ROLE_HELP = Object.fromEntries(SPONSOR_TEAM_ROLES.map((r) => [r.value, r.help]));
/** Owners and admins manage the whole sponsor, so they are never limited to a department. */
export const WHOLE_SPONSOR_ROLES = ['owner', 'admin'];
/** The role the action rules are written for: owner, admin and portfolio manager act as manager. */
export const asSponsorRole = (r) => (['owner', 'admin', 'portfolio_manager'].includes(r) ? 'manager' : r);
