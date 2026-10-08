// Roles a person can hold on their own account (admin is assigned by the platform).
export const ROLES = [
  ['athlete', 'Athlete'], ['coach', 'Coach'], ['referee', 'Referee'], ['organizer', 'Organizer'],
  ['venue_manager', 'Venue'], ['sponsor', 'Sponsor'], ['physio', 'Physio'], ['doctor', 'Doctor'], ['supplier', 'Supplier'], ['insurer', 'Insurer'],
];
export const roleLabel = (k) => ROLES.find(([x]) => x === k)?.[1] ?? k.replace('_', ' ');
