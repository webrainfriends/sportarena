// Roles a person can hold on their own account (admin is assigned by the platform).
export const ROLES = [
  ['athlete', 'Athlete'], ['coach', 'Coach'], ['referee', 'Referee'], ['organizer', 'Organizer'],
  ['venue_manager', 'Venue'], ['sponsor', 'Sponsor'], ['physio', 'Physio'], ['doctor', 'Doctor'], ['supplier', 'Supplier'], ['insurer', 'Insurer'], ['lawyer', 'Lawyer'], ['recruiter', 'Recruiter / scout'], ['agent', 'Agent'],
];
const PLATFORM_LABELS = { admin: 'Platform team', platform_admin: 'Platform admin' };
export const roleLabel = (k) => ROLES.find(([x]) => x === k)?.[1] ?? PLATFORM_LABELS[k] ?? k.replace('_', ' ');
// the platform roles (admin, platform_admin) are not in ROLES on purpose: they are never offered, added or removed from the app
export const isEditableRole = (k) => ROLES.some(([x]) => x === k);
