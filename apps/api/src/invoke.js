import { ZodError } from 'zod';
import { AppError, forbidden, unauthorized } from './errors.js';
import { hasRole } from './helpers.js';
import { enforceResources, enforceScope } from './scopes.js';
import { enforceMfa } from './account-security.js';
import { enforceApproved } from './access.js';

/** The one place a capability is executed — REST and MCP both go through here. */
export async function invoke(capability, user, rawInput, meta = {}) {
  const { auth } = capability;
  if (auth !== 'public') {
    if (!user) throw unauthorized();
    if (Array.isArray(auth) && !hasRole(user, ...auth)) throw forbidden(`Requires one of the roles: ${auth.join(', ')}`);
  }
  if (auth !== 'public') enforceScope(user?.credential, capability); // public capabilities need no token at all
  if (auth !== 'public') enforceMfa(user, capability); // step-up for sensitive roles' clinical/admin actions (MFA_ENFORCE)
  if (auth !== 'public') enforceApproved(user, capability); // people awaiting approval can look but not add or change anything
  const input = capability.input.parse(rawInput ?? {});
  // API tokens: the token's scope/resources AND the user's own permissions must both allow it (checked before the handler runs).
  enforceResources(user?.credential, capability, input);
  return capability.handler({ user, meta }, input);
}

/** Normalise any thrown value into {status, code, message, details}. */
export function toErrorBody(e) {
  if (e instanceof ZodError) return { status: 400, code: 'validation_error', message: 'Invalid input', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  if (e instanceof AppError) return { status: e.status, code: e.code, message: e.message, details: e.details };
  if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return { status: 400, code: 'bad_request', message: 'Malformed value in request' };
  if (e?.code === '23503') return { status: 409, code: 'conflict', message: 'Referenced record does not exist or is still in use' };
  if (e?.code === '23505') return { status: 409, code: 'conflict', message: 'Already exists' };
  if (e?.code === '42703') return { status: 400, code: 'schema_mismatch',  message: 'A field in the request does not exist in the database — schema may be out of date' };
  if (e?.code === '42804') return { status: 400, code: 'type_mismatch',    message: 'A field value could not be stored — type mismatch' };
  if (e?.code === '42846') return { status: 400, code: 'type_mismatch',    message: 'Cannot cast a field value to the required type' };
  if (e?.code === '22003') return { status: 400, code: 'out_of_range',     message: 'A numeric value is out of range for its field type' };
  if (e?.code === '23502') return { status: 400, code: 'missing_value',    message: 'A required field has no value' };
  console.error('[error]', { code: e?.code, detail: e?.detail, message: e?.message }, e);
  return { status: 500, code: 'internal_error', message: 'Something went wrong' };
}
