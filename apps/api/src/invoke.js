import { ZodError } from 'zod';
import { AppError, forbidden, unauthorized } from './errors.js';
import { hasRole } from './helpers.js';
import { enforceResources, enforceScope } from './scopes.js';
import { enforceMfa } from './account-security.js';
import { enforceApproved } from './access.js';
import { query } from './db.js';
import { sha256 } from './crypto.js';

// UUID pattern: used to detect IDOR attempts (access to a specific resource by id)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CLINICAL_FINANCE_RE = /clinical|health|medical|invoice|payout|finance|tax|rate.agr/i;

function classifySeverity(e, capPath) {
  if (e.status === 404 && UUID_RE.test(capPath ?? '')) return 'high'; // probable IDOR
  if (CLINICAL_FINANCE_RE.test(capPath ?? '')) return 'high';
  if (e.status === 403) return 'medium';
  return 'low';
}

function templatePath(p) {
  return (p ?? '').replace(UUID_RE, ':id').replace(/\/[0-9]+(?=\/|$)/g, '/:n');
}

function blockReason(e, capPath) {
  if (e.status === 404 && UUID_RE.test(capPath ?? '')) return 'IDOR — resource not found for actor';
  if (e.message?.includes('role')) return 'Role boundary';
  if (e.message?.includes('organisation') || e.message?.includes('organization')) return 'Cross-tenant — not a member';
  if (CLINICAL_FINANCE_RE.test(capPath ?? '')) return 'Clinical/Finance scope denied';
  return e.message ?? 'Access denied';
}

function logAccessDenied(user, capability, meta, e) {
  const path = templatePath(capability?.path);
  const severity = classifySeverity(e, path);
  const ipHash = meta?.ip ? sha256(String(meta.ip)) : null;
  query(
    `INSERT INTO access_denied_events
      (actor_id, active_role, acting_org_id, error_code, http_status, capability, method, path,
       block_reason, ip_hash, user_agent_summary, mcp_call, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      user?.id ?? null,
      meta?.role ?? null,
      meta?.orgId ?? null,
      e.code ?? 'unknown',
      e.status,
      capability?.name ?? null,
      capability?.method ?? null,
      path || null,
      blockReason(e, path),
      ipHash,
      meta?.userAgent ?? null,
      !!meta?.mcp,
      severity,
    ],
  ).catch(() => {}); // fire-and-forget; never let telemetry break a request
}

/** The one place a capability is executed — REST and MCP both go through here. */
export async function invoke(capability, user, rawInput, meta = {}) {
  const { auth } = capability;
  try {
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
    return await capability.handler({ user, meta }, input);
  } catch (e) {
    if (e instanceof AppError && (e.status === 403 || e.status === 404)) {
      logAccessDenied(user, capability, meta, e);
    }
    throw e;
  }
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
