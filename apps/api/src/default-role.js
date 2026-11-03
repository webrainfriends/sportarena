import { PLATFORM_ROLES } from './platform.js';

/** The role a person lands in: their explicit choice if still held, else athlete, else their first role.
 *  Platform roles (admin / platform_admin) are never a default. */
export function resolveDefaultRole(roles = [], explicit = null) {
  const held = roles.filter((r) => !PLATFORM_ROLES.includes(r));
  if (explicit && held.includes(explicit)) return explicit;
  if (held.includes('athlete')) return 'athlete';
  return held[0] ?? null;
}
