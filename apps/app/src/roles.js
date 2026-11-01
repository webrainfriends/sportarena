import { t } from './i18n';

// Roles a person can hold on their own account (admin is assigned by the platform).
export const ROLES = ['athlete', 'coach', 'referee', 'organizer', 'venue_manager', 'sponsor', 'physio', 'doctor', 'supplier', 'insurer', 'lawyer', 'recruiter', 'agent'].map((k) => [k, t(`role.${k}`)]);
const PLATFORM_LABELS = { admin: t('role.admin'), platform_admin: t('role.platform_admin') };
export const roleLabel = (k) => ROLES.find(([x]) => x === k)?.[1] ?? PLATFORM_LABELS[k] ?? k.replace('_', ' ');
// the platform roles (admin, platform_admin) are not in ROLES on purpose: they are never offered, added or removed from the app
export const isEditableRole = (k) => ROLES.some(([x]) => x === k);
