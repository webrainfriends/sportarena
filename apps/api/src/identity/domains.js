// Domain claim: an organisation proves it controls an email domain by publishing a DNS TXT record. Verified domains gate discovery,
// account creation and the SSO sign-in itself; owning a domain never grants a role.
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { one } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { PUBLIC_MAIL_DOMAINS } from './policy.js';

export const TXT_HOST = (domain) => `_gotmygame-challenge.${domain}`;
export const TXT_VALUE = (token) => `gotmygame-site-verification=${token}`;
/** Replaceable in tests. Returns the TXT strings (already joined per record). */
export const dnsProbe = { async txt(host) { try { return (await resolveTxt(host)).map((parts) => parts.join('')); } catch { return []; } } };

export function normaliseDomain(input) {
  const d = String(input ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) throw badRequest('Enter a domain such as school.edu.in');
  if (PUBLIC_MAIL_DOMAINS.has(d)) throw badRequest('Free email providers cannot be claimed as an organisation domain');
  return d;
}

export async function addClaim(orgId, domain, actorId) {
  const d = normaliseDomain(domain);
  if (await one("SELECT 1 FROM org_domain_claims WHERE domain = $1 AND status = 'verified'", [d])) throw conflict('This domain is already verified by another organisation');
  return one(`INSERT INTO org_domain_claims(organisation_id, domain, token, created_by) VALUES ($1,$2,$3,$4)
              ON CONFLICT (organisation_id, domain) WHERE status <> 'revoked' DO UPDATE SET domain = excluded.domain RETURNING *`, [orgId, d, randomBytes(18).toString('base64url'), actorId]);
}

/** Look for the TXT record now. The unique index on verified domains makes the first organisation to prove control the only one. */
export async function checkClaim(claim) {
  const found = (await dnsProbe.txt(TXT_HOST(claim.domain))).includes(TXT_VALUE(claim.token));
  if (!found) return { ...(await one('UPDATE org_domain_claims SET last_checked_at = now() WHERE id = $1 RETURNING *', [claim.id])), verified_now: false };
  try {
    return { ...(await one("UPDATE org_domain_claims SET status = 'verified', verified_at = coalesce(verified_at, now()), last_checked_at = now() WHERE id = $1 AND status <> 'revoked' RETURNING *", [claim.id])), verified_now: true };
  } catch (e) { if (e.code === '23505') throw conflict('This domain was just verified by another organisation'); throw e; }
}
