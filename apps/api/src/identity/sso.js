// The enterprise sign-in decision. Whatever the protocol (OIDC or SAML), a verified IdP result comes in here as a plain identity and
// leaves as one of: a session, a local two-step challenge, a request to confirm linking an existing account, or a refusal.
//
// Rules that hold for every path (each has a test):
//  * the email must sit on a domain this organisation has *verified* (DNS), so an IdP cannot vouch for addresses it does not control;
//  * an existing canonical account is never merged on an email claim alone: its owner must confirm while signed in;
//  * the connection can only create / change / end *its own organisation's* membership, never users.roles or another organisation's rows;
//  * roles come from explicit group mappings inside the connection's role ceiling; owner, legal and platform roles are never granted;
//  * a deprovisioned (SCIM-inactive) person is refused here, and nothing about guardians / youth consent is created or changed.
import { randomBytes } from 'node:crypto';
import { many, one, query, tx } from '../db.js';
import { blindIndex, decrypt, encrypt, hashPassword, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { isPlatformAdminEmail } from '../access.js';
import { startSession, revokeUserSessions } from '../sessions.js';
import { issueToken } from '../account-security.js';
import { freeHandle } from '../social-login.js';
import { isYouth } from '../youth.js';
import { notifySecurity } from '../notify.js';
import { emailDomain, resolveRole } from './policy.js';

const USER_COLS = 'id, handle, display_name, roles, avatar_emoji, avatar_color, avatar_url, avatar_cutout, access_status';

/** Append to the identity decision log and the platform audit log. Never pass assertions, tokens or secrets in `detail`. */
export async function logEvent(c, { orgId = null, connId = null, userId = null, actorId = null, event, outcome = 'ok', reason = null, detail = {} }) {
  const q = c ? c.query.bind(c) : query;
  await q('INSERT INTO sso_events(organisation_id, connection_id, user_id, actor_id, event, outcome, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [orgId, connId, userId, actorId, event, outcome, reason, JSON.stringify(detail)]);
  await q('INSERT INTO audit_log(actor_id, action, entity, entity_id) VALUES ($1,$2,$3,$4)', [actorId ?? userId, `sso_${event}${outcome === 'ok' ? '' : `_${outcome}`}`, 'organisations', orgId]);
}

const deny = async (conn, event, reason, detail = {}, userId = null) => {
  await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, userId, event, outcome: 'denied', reason, detail });
  throw unauthorized('Your organisation sign-in was not accepted. Contact your organisation administrator if you think this is a mistake.');
};

export const verifiedDomains = async (orgId, c) => (await (c ?? { query }).query("SELECT domain FROM org_domain_claims WHERE organisation_id=$1 AND status='verified'", [orgId])).rows.map((r) => r.domain);
export const loadConnection = (id) => one(`SELECT c.*, o.status AS org_status FROM org_sso_connections c JOIN organisations o ON o.id = c.organisation_id WHERE c.id = $1`, [id]);

/** Which connection should this email sign in through? Only verified domains with an active connection are discoverable. */
export const discoverByEmail = (email) => one(
  `SELECT c.id, c.name, c.protocol, o.name AS organisation_name FROM org_domain_claims d
     JOIN org_sso_connections c ON c.organisation_id = d.organisation_id AND c.status = 'active' JOIN organisations o ON o.id = c.organisation_id AND o.status = 'active'
    WHERE d.domain = $1 AND d.status = 'verified'`, [emailDomain(email)]);

/** One-time local-login gate: members provisioned by an organisation that requires SSO may not use password / social sign-in (break-glass owners excepted). */
export async function assertLocalLoginAllowed(userId, { how = 'password' } = {}) {
  const r = await one(
    `SELECT c.id, c.organisation_id, $1::uuid = ANY(c.break_glass_user_ids) AS break_glass
       FROM organisation_members m JOIN org_sso_connections c ON c.organisation_id = m.organisation_id AND c.status = 'active' AND c.local_login = 'sso_required'
      WHERE m.user_id = $1 AND m.status = 'active' AND (m.source <> 'manual' OR $1::uuid = ANY(c.break_glass_user_ids)) ORDER BY break_glass DESC LIMIT 1`, [userId]);
  if (!r) return;
  if (r.break_glass) { await logEvent(null, { orgId: r.organisation_id, connId: r.id, userId, event: 'break_glass_login', detail: { how } }); return; }
  await logEvent(null, { orgId: r.organisation_id, connId: r.id, userId, event: 'local_login', outcome: 'denied', reason: 'sso_required', detail: { how } });
  throw new AppError(403, 'sso_required', 'Your organisation requires you to sign in with single sign-on.');
}

/** Roles from the claims plus any SCIM group membership, through the mappings and the ceiling. */
async function roleFor(conn, claimGroups, scimUserId) {
  const scim = scimUserId ? (await many(
    `SELECT g.display_name FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id AND g.removed_at IS NULL WHERE gm.scim_user_id = $1 AND gm.removed_at IS NULL`, [scimUserId])).map((r) => r.display_name) : [];
  const mappings = await many('SELECT group_value, effect, org_role FROM org_sso_group_mappings WHERE connection_id = $1 AND removed_at IS NULL', [conn.id]);
  return resolveRole({ groups: [...claimGroups, ...scim], mappings, ceiling: conn.allowed_roles, fallback: conn.default_role });
}

/**
 * Apply the resolved role to this organisation's membership only.
 *   manual membership -> never touched (an admin's own decision wins)   provisioned -> created / updated / ended here
 */
export async function applyMembership(c, conn, userId, res, source) {
  const cur = (await c.query("SELECT id, role, status, source FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status IN ('invited','active') FOR UPDATE", [conn.organisation_id, userId])).rows[0];
  if (cur?.source === 'manual') return { kept: 'manual', role: cur.role };
  if (!res.role) {
    if (cur) {
      await c.query("UPDATE organisation_members SET status='left', left_at=now(), deprovisioned_at=now() WHERE id=$1", [cur.id]);
      await logEvent(c, { orgId: conn.organisation_id, connId: conn.id, userId, event: 'membership_ended', reason: res.reason, detail: { role: cur.role } });
    }
    return { role: null };
  }
  if (cur) {
    if (cur.role !== res.role || cur.status !== 'active') {
      await c.query("UPDATE organisation_members SET role=$2, status='active', joined_at=coalesce(joined_at, now()), source=$3 WHERE id=$1", [cur.id, res.role, source]);
      await logEvent(c, { orgId: conn.organisation_id, connId: conn.id, userId, event: 'role_mapped', detail: { from: cur.role, to: res.role } });
    }
    return { role: res.role };
  }
  const last = (await c.query('SELECT status, source FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 ORDER BY invited_at DESC LIMIT 1', [conn.organisation_id, userId])).rows[0];
  if (last?.status === 'left' && last.source === 'manual') return { role: null, reason: 'removed_by_admin' }; // an admin's removal is not undone by a directory
  await c.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, source, provisioned_connection_id) VALUES ($1,$2,$3,'active', now(), $4, $5)", [conn.organisation_id, userId, res.role, source, conn.id]);
  await logEvent(c, { orgId: conn.organisation_id, connId: conn.id, userId, event: 'membership_granted', detail: { role: res.role, via: source } });
  return { role: res.role };
}

/**
 * @param identity {{ subject, email, emailVerified: boolean|null, name?, groups: string[], mfa: boolean, meta? }}
 * emailVerified: true/false for OIDC (email_verified claim); null for SAML, where the signed assertion plus the verified domain is the trust anchor.
 */
export async function finishSso(conn, identity, meta = {}, { linkRequest = null } = {}) {
  const linkUserId = identity.linkUserId ?? null; // a signed-in person adding this organisation to their own account
  if (conn.status !== 'active' || conn.org_status !== 'active') return deny(conn, 'login', 'connection_inactive');
  const email = String(identity.email ?? '').trim().toLowerCase();
  if (!identity.subject) return deny(conn, 'login', 'no_subject');
  if (!email || !email.includes('@')) return deny(conn, 'login', 'no_email');
  if (identity.emailVerified === false) return deny(conn, 'login', 'email_not_verified');
  if (!(await verifiedDomains(conn.organisation_id)).includes(emailDomain(email))) return deny(conn, 'login', 'domain_not_claimed', { domain: emailDomain(email) });
  if (isPlatformAdminEmail(email)) return deny(conn, 'login', 'platform_admin_account');
  if (conn.require_mfa_signal && !identity.mfa) return deny(conn, 'login', 'mfa_signal_missing');

  const idIdx = blindIndex(email);
  const ref = await one('SELECT id, active, user_id FROM scim_users WHERE organisation_id = $1 AND email_idx = $2', [conn.organisation_id, idIdx]);
  if (ref && !ref.active) return deny(conn, 'login', 'deprovisioned', {}, ref.user_id);

  let link = await one('SELECT user_id FROM org_sso_identities WHERE connection_id = $1 AND external_subject = $2 AND status = \'active\'', [conn.id, identity.subject]);
  let linkedHow = null;
  let user = link ? await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [link.user_id]) : null;

  if (!user && linkUserId) {
    // The account owner is already signed in and started this flow themselves, so their account is the controlled confirmation. The email must
    // still be on a verified domain and must not belong to some *other* account.
    const other = await one('SELECT id FROM users WHERE email_idx = $1 AND id <> $2', [idIdx, linkUserId]);
    if (other) return deny(conn, 'login', 'email_belongs_to_other_account', {}, linkUserId);
    user = await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [linkUserId]);
    if (!user) return deny(conn, 'login', 'link_account_missing');
    linkedHow = 'confirmed_by_owner';
  }
  if (!user) {
    const byEmail = await one(`SELECT ${USER_COLS}, email_verified_at FROM users WHERE email_idx = $1`, [idIdx]);
    if (byEmail && !linkRequest) {
      if (byEmail.email_verified_at) {
        // Never merge on the claim: park the match and let the signed-in owner of that account confirm it.
        const token = 'sl_' + randomBytes(32).toString('base64url');
        await query("INSERT INTO sso_link_requests(token_hash, connection_id, user_id, external_subject, groups, mfa_signal, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '15 minutes')",
          [sha256(token), conn.id, byEmail.id, identity.subject, JSON.stringify(identity.groups ?? []), Boolean(identity.mfa)]);
        await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, userId: byEmail.id, event: 'link_requested' });
        return { link_required: true, link_token: token, organisation_id: conn.organisation_id, email_hint: email.replace(/^(.).*(@.*)$/, '$1***$2'),
          message: 'An account with this email already exists. Sign in to it and confirm to link your organisation sign-in.' };
      }
      linkedHow = 'reclaimed_unverified_email';
    } else if (byEmail) {
      linkedHow = 'confirmed_by_owner';
    }
    user = byEmail ? (({ email_verified_at, ...u }) => u)(byEmail) : null;
    if (user && linkedHow === 'reclaimed_unverified_email') {
      // The address was registered but never verified; the organisation controls the domain, so the account is reclaimed and the old password made unusable.
      await query('UPDATE users SET password_hash = $2, email_verified_at = now() WHERE id = $1', [user.id, await hashPassword(randomBytes(24).toString('base64url'))]);
      await revokeUserSessions(user.id, 'sso_reclaim');
    }
    if (!user) {
      if (!conn.jit_enabled && !ref) return deny(conn, 'login', 'no_account_jit_off');
      linkedHow = 'jit_new_account';
    }
  }
  if (user?.access_status === 'rejected') return deny(conn, 'login', 'access_rejected', {}, user.id);
  if (user && (await isYouth(user.id))) return deny(conn, 'login', 'youth_account', {}, user.id); // staff roles are never provisioned onto a minor's account

  const res = await roleFor(conn, identity.groups ?? [], ref?.id);
  if (res.ignored?.length) await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, userId: user?.id, event: 'mapping_exceeds_ceiling', outcome: 'denied', detail: { roles: res.ignored } });
  const existingManual = user ? await one("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND source='manual'", [conn.organisation_id, user.id]) : null;
  if (!res.role && !existingManual) {
    if (user) await tx((c) => applyMembership(c, conn, user.id, res, ref ? 'scim' : 'sso'));
    return deny(conn, 'login', res.reason, {}, user?.id);
  }

  const out = await tx(async (c) => {
    let u = user;
    if (!u) {
      const display = String(identity.name ?? '').trim().slice(0, 60) || email.split('@')[0].slice(0, 60);
      // Created by a domain-verified organisation, so it starts approved (the org vouches for its people); athlete role only, never platform roles.
      u = (await c.query(
        `INSERT INTO users (handle, display_name, roles, password_hash, email_enc, email_idx, email_verified_at, access_status) VALUES ($1,$2,'{athlete}',$3,$4,$5, now(),'approved') RETURNING ${USER_COLS}`,
        [await freeHandle(email, identity.name), display, await hashPassword(randomBytes(24).toString('base64url')), encrypt(email, 'users.email'), idIdx])).rows[0];
      await audit(c, null, 'sso_register', 'users', u.id);
    }
    if (!link) {
      await c.query('INSERT INTO org_sso_identities(connection_id, user_id, external_subject, linked_how) VALUES ($1,$2,$3,$4)', [conn.id, u.id, identity.subject, linkedHow]);
      await logEvent(c, { orgId: conn.organisation_id, connId: conn.id, userId: u.id, event: 'identity_linked', detail: { how: linkedHow } });
    }
    const m = await applyMembership(c, conn, u.id, res, ref ? 'scim' : 'sso');
    if (ref && !ref.user_id) await c.query('UPDATE scim_users SET user_id = $2 WHERE id = $1', [ref.id, u.id]);
    await c.query('UPDATE org_sso_identities SET last_login_at = now(), mfa_signal_at = CASE WHEN $3 THEN now() ELSE mfa_signal_at END WHERE connection_id = $1 AND external_subject = $2', [conn.id, identity.subject, Boolean(identity.mfa)]);
    return { u, m };
  });
  if (!out.m.role && !out.m.kept) return deny(conn, 'login', out.m.reason ?? 'no_role', {}, out.u.id);

  await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, userId: out.u.id, event: 'login', detail: { protocol: conn.protocol, role: out.m.role, mfa_signal: Boolean(identity.mfa) } });
  const sso = { connection_id: conn.id, hours: conn.session_hours };
  if (!identity.mfa && (await one('SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL AND disabled_at IS NULL', [out.u.id]))) {
    const t = await issueToken(out.u.id, 'mfa_login', 5);
    await query('UPDATE account_tokens SET sso_connection_id = $2 WHERE token_hash = $1', [sha256(t), conn.id]);
    return { mfa_required: true, mfa_token: t };
  }
  return { user: out.u, organisation_id: conn.organisation_id, ...(await startSession(out.u, meta, { mfa: Boolean(identity.mfa), sso })) };
}

/** The signed-in owner of an account confirms an SSO link that finishSso parked. Single use; the caller must be that account (and past its own two-step check). */
export async function confirmLink(user, token, meta) {
  if (user.security?.mfa_enabled && !user.security.mfa_verified) throw forbidden('Finish two-step verification before linking an organisation sign-in.');
  const req = await one('UPDATE sso_link_requests SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND user_id = $2 RETURNING *', [sha256(String(token)), user.id]);
  if (!req) throw unauthorized('This link request has expired or belongs to another account.');
  const conn = await loadConnection(req.connection_id);
  const row = await one('SELECT email_enc FROM users WHERE id = $1', [user.id]);
  const email = decrypt(row.email_enc, 'users.email');
  await audit(null, user.id, 'read_pii', 'users', user.id);
  await notifySecurity(user.id, { kind: 'security_sso_linked', title: 'An organisation sign-in was linked to your account', body: 'You confirmed linking your account to your organisation single sign-on. If this was not you, sign out everywhere and change your password.' }).catch(() => {});
  return finishSso(conn, { subject: req.external_subject, email, emailVerified: true, groups: req.groups, mfa: req.mfa_signal }, meta, { linkRequest: req });
}
