// Protocol routes that cannot be JSON capabilities: the IdP's browser POST to the SAML ACS, and the SP metadata document.
// Both only hand the verified result to the same code the capabilities use; the app collects the outcome with complete_sso.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { query } from '../db.js';
import { sha256 } from '../crypto.js';
import { loadConnection, logEvent } from './sso.js';
import { completeSaml, spMetadata } from './saml.js';
import { mfaSignal } from './policy.js';
import { acsUrl } from '../capabilities/enterprise-identity.js';

export function ssoRouter() {
  const r = express.Router();
  r.get('/auth/sso/:id/saml/metadata', async (req, res, next) => {
    try {
      const conn = /^[0-9a-f-]{36}$/i.test(req.params.id) && await loadConnection(req.params.id);
      if (!conn || conn.protocol !== 'saml' || conn.status === 'disabled') return res.status(404).json({ error: { code: 'not_found', message: 'SSO connection not found' } });
      res.type('application/samlmetadata+xml').send(spMetadata(conn, acsUrl(conn.id)));
    } catch (e) { next(e); }
  });
  r.post('/auth/sso/:id/saml/acs', express.urlencoded({ extended: false, limit: '512kb' }), async (req, res, next) => {
    try {
      const conn = /^[0-9a-f-]{36}$/i.test(req.params.id) && await loadConnection(req.params.id);
      if (!conn || conn.protocol !== 'saml' || conn.status !== 'active' || conn.org_status !== 'active') return res.status(404).json({ error: { code: 'not_found', message: 'SSO connection not found' } });
      const st = await query('SELECT redirect_uri FROM sso_login_states WHERE state_hash = $1 AND connection_id = $2', [sha256(String(req.body?.RelayState ?? '')), conn.id]);
      const back = st.rows[0]?.redirect_uri;
      try {
        const v = await completeSaml(conn, acsUrl(conn.id), req.body ?? {});
        const ticket = 'st_' + randomBytes(32).toString('base64url');
        const claims = { subject: v.subject, email: v.email, emailVerified: null, name: v.name, groups: v.groups, mfa: mfaSignal({ authnContext: v.authnContext }), linkUserId: v.linkUserId };
        await query("INSERT INTO sso_tickets(ticket_hash, connection_id, claims, expires_at) VALUES ($1,$2,$3, now() + interval '2 minutes')", [sha256(ticket), conn.id, JSON.stringify(claims)]);
        res.redirect(303, `${v.redirect}${v.redirect.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}&connection_id=${conn.id}`);
      } catch (e) {
        // the library's short verdict (e.g. "Invalid signature") helps an admin fix a misconfigured IdP; it never contains assertion content
        await logEvent(null, { orgId: conn.organisation_id, connId: conn.id, event: 'login', outcome: 'denied', reason: 'assertion_invalid', detail: { error: String(e.cause?.message ?? e.message).slice(0, 120) } });
        if (back) return res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}error=sso_failed`);
        res.status(401).json({ error: { code: 'unauthorized', message: 'Sign-in could not be verified.' } });
      }
    } catch (e) { next(e); }
  });
  return r;
}
