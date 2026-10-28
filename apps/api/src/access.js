// Access approval: accounts created through Google sign-in start 'pending' and are read-only until the super admin approves them.
import { config } from './config.js';
import { AppError } from './errors.js';

/** The super admin: the only Google account that is approved on sight and that holds the platform owner role. */
export const superAdminEmail = () => String(config.superAdminEmail ?? '').trim().toLowerCase();

/** The complete list of accounts allowed to hold `admin` / `platform_admin` (PLATFORM_ADMIN_EMAILS, else SUPER_ADMIN_EMAIL). Nobody else ever can. */
export const platformAdminEmails = () => [...new Set(String(config.platformAdminEmails ?? '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
export const isPlatformAdminEmail = (email) => Boolean(email) && platformAdminEmails().includes(String(email).trim().toLowerCase());

/** Read-only means no add/change/delete (any non-GET capability), except the account's own sign-in and security housekeeping. */
const ACCOUNT_SAFE = new Set([
  'logout', 'logout_all', 'refresh_session', 'revoke_login_session', 'change_my_password',
  'request_email_verification', 'verify_email', 'mfa_setup', 'mfa_enable', 'verify_mfa', 'mfa_disable',
]);

export function enforceApproved(user, capability) {
  if (!user || !user.access_status || user.access_status === 'approved') return;
  if (capability.method === 'GET' || ACCOUNT_SAFE.has(capability.name)) return;
  throw new AppError(403, 'approval_pending', user.access_status === 'rejected'
    ? 'Your access request was declined, so your account is read-only.'
    : 'Your account is waiting for approval by the administrator. You can look around, but you cannot add or change anything yet.');
}

/** For upload routes that live outside invoke(): refuse writes from accounts that are not approved. */
export const requireApproved = (user) => enforceApproved(user, { method: 'PUT', name: 'upload' });
