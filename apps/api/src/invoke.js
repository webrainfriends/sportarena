import { ZodError } from 'zod';
import { AppError, forbidden, unauthorized } from './errors.js';
import { hasRole } from './helpers.js';

/** The one place a capability is executed — REST and MCP both go through here. */
export async function invoke(capability, user, rawInput) {
  const { auth } = capability;
  if (auth !== 'public') {
    if (!user) throw unauthorized();
    if (Array.isArray(auth) && !hasRole(user, ...auth)) throw forbidden(`Requires one of the roles: ${auth.join(', ')}`);
  }
  const input = capability.input.parse(rawInput ?? {});
  return capability.handler({ user }, input);
}

/** Normalise any thrown value into {status, code, message, details}. */
export function toErrorBody(e) {
  if (e instanceof ZodError) return { status: 400, code: 'validation_error', message: 'Invalid input', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  if (e instanceof AppError) return { status: e.status, code: e.code, message: e.message, details: e.details };
  if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return { status: 400, code: 'bad_request', message: 'Malformed value in request' };
  if (e?.code === '23503') return { status: 409, code: 'conflict', message: 'Referenced record does not exist or is still in use' };
  if (e?.code === '23505') return { status: 409, code: 'conflict', message: 'Already exists' };
  console.error('[error]', e);
  return { status: 500, code: 'internal_error', message: 'Something went wrong' };
}
