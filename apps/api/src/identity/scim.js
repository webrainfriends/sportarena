// SCIM 2.0 (RFC 7643/7644) service provider for one organisation's directory. Authenticated by an org-scoped SCIM token, which is a service
// identity of its own: it can be revoked without touching any person's session, and a person's SSO state never affects it.
//
//  * Users are the enterprise's *reference* to a person (scim_users); the canonical `users` row is linked only when that person signs in.
//  * POST is idempotent: the same userName / externalId again returns the existing resource (200) instead of an error, so retried
//    provisioning calls are safe. A userName that is already used by a different externalId is a 409.
//  * active=false (or DELETE) deprovisions: membership closed, this connection's sessions and org-only tokens revoked, history kept.
//  * ETag / If-Match (weak, from `version`), startIndex/count paging, and `eq` filters on userName / externalId / displayName.
import express from 'express';
import { many, one, query, tx } from '../db.js';
import { blindIndex, decrypt, encrypt, sha256 } from '../crypto.js';
import { audit } from '../helpers.js';
import { emailDomain } from './policy.js';
import { applyMembership, logEvent, verifiedDomains, loadConnection } from './sso.js';
import { deprovisionMember } from './offboard.js';
import { resolveRole } from './policy.js';

const U = 'urn:ietf:params:scim:schemas:core:2.0:User';
const G = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const MAX_COUNT = 200;

class ScimError extends Error { constructor(status, detail, scimType) { super(detail); this.status = status; this.scimType = scimType; } }
const bad = (d, t = 'invalidValue') => new ScimError(400, d, t);
const etag = (v) => `W/"${v}"`;
const base = (req) => `${req.protocol}://${req.get('host')}${req.baseUrl}`;

const userJson = async (req, r) => {
  const email = decrypt(r.email_enc, 'scim_users.email');
  const groups = await many("SELECT g.id, g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id AND g.removed_at IS NULL WHERE m.scim_user_id = $1 AND m.removed_at IS NULL ORDER BY g.display_name", [r.id]);
  return { schemas: [U], id: r.id, ...(r.external_id ? { externalId: r.external_id } : {}), userName: email, displayName: r.display_name ?? undefined,
    emails: [{ value: email, primary: true, type: 'work' }], active: r.active, groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${base(req)}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: r.created_at, lastModified: r.updated_at, version: etag(r.version), location: `${base(req)}/Users/${r.id}` } };
};
const groupJson = async (req, r) => {
  const members = await many("SELECT u.id, u.email_enc FROM scim_group_members m JOIN scim_users u ON u.id = m.scim_user_id WHERE m.group_id = $1 AND m.removed_at IS NULL ORDER BY u.created_at", [r.id]);
  return { schemas: [G], id: r.id, ...(r.external_id ? { externalId: r.external_id } : {}), displayName: r.display_name,
    members: members.map((m) => ({ value: m.id, display: decrypt(m.email_enc, 'scim_users.email'), $ref: `${base(req)}/Users/${m.id}` })),
    meta: { resourceType: 'Group', created: r.created_at, lastModified: r.updated_at, version: etag(r.version), location: `${base(req)}/Groups/${r.id}` } };
};

/** Parse the one filter shape clients actually use for lookups: `attr eq "value"`. */
function eqFilter(filter, allowed) {
  if (!filter) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m && allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
  if (!attr) throw bad(`Only "eq" filters on ${allowed.join(', ')} are supported`, 'invalidFilter');
  return { attr, value: m[2].replace(/\\(.)/g, '$1') };
}
const paging = (q) => ({ start: Math.max(1, Number.parseInt(q.startIndex, 10) || 1), count: Math.min(MAX_COUNT, Math.max(0, Number.parseInt(q.count, 10) || 100)) });
const boolOf = (v) => (typeof v === 'boolean' ? v : /^true$/i.test(String(v)) ? true : /^false$/i.test(String(v)) ? false : (() => { throw bad('active must be true or false'); })());

function parseUserName(raw, domains) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw bad('userName must be an email address', 'invalidValue');
  if (!domains.includes(emailDomain(e))) throw bad('That email domain is not verified for this organisation', 'invalidValue');
  return e;
}
const checkMatch = (req, version) => { const h = req.get('if-match'); if (h && h !== '*' && h !== etag(version)) throw new ScimError(412, 'The resource was modified; fetch it again', 'invalidVers'); };

/** Re-evaluate one linked person's role after their directory state changed. Ends access (and sessions) when nothing allows it any more. */
async function syncMember(c, conn, su) {
  if (!su.active) {
    // a person who has an account but never signed in through SSO is matched by email, so offboarding still reaches their access
    const uid = su.user_id ?? (await c.query('SELECT id FROM users WHERE email_idx = $1', [su.email_idx])).rows[0]?.id;
    if (uid) await deprovisionMember(c, { orgId: conn.organisation_id, userId: uid, connectionId: conn.id, reason: 'scim_inactive' });
    return;
  }
  if (!su.user_id) return;
  const groups = (await c.query("SELECT g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id=m.group_id AND g.removed_at IS NULL WHERE m.scim_user_id=$1 AND m.removed_at IS NULL", [su.id])).rows.map((r) => r.display_name);
  const mappings = (await c.query('SELECT group_value, effect, org_role FROM org_sso_group_mappings WHERE connection_id=$1 AND removed_at IS NULL', [conn.id])).rows;
  const res = resolveRole({ groups, mappings, ceiling: conn.allowed_roles, fallback: conn.default_role });
  const m = await applyMembership(c, conn, su.user_id, res, 'scim');
  if (!m.role && !m.kept) await deprovisionMember(c, { orgId: conn.organisation_id, userId: su.user_id, connectionId: conn.id, reason: `scim_${res.reason}` });
}

async function setMembers(c, conn, group, ids) {
  const valid = ids.length ? (await c.query('SELECT id FROM scim_users WHERE organisation_id=$1 AND id = ANY($2::uuid[])', [conn.organisation_id, ids])).rows.map((r) => r.id) : [];
  if (valid.length !== new Set(ids).size) throw bad('A member id is not a user of this organisation', 'invalidValue');
  const before = (await c.query('SELECT scim_user_id FROM scim_group_members WHERE group_id=$1 AND removed_at IS NULL', [group.id])).rows.map((r) => r.scim_user_id);
  const add = valid.filter((i) => !before.includes(i)), drop = before.filter((i) => !valid.includes(i));
  for (const i of add) await c.query('INSERT INTO scim_group_members(group_id, scim_user_id) VALUES ($1,$2) ON CONFLICT (group_id, scim_user_id) DO UPDATE SET removed_at = NULL, added_at = now()', [group.id, i]);
  for (const i of drop) await c.query('UPDATE scim_group_members SET removed_at = now() WHERE group_id=$1 AND scim_user_id=$2 AND removed_at IS NULL', [group.id, i]);
  const changed = [...add, ...drop];
  if (changed.length) await c.query('UPDATE scim_groups SET version = version + 1, updated_at = now() WHERE id=$1', [group.id]);
  for (const i of changed) await syncMember(c, conn, (await c.query('SELECT * FROM scim_users WHERE id=$1', [i])).rows[0]);
  return changed.length;
}

export function scimRouter() {
  const r = express.Router();
  r.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
  r.use((req, res, next) => { res.set('Content-Type', 'application/scim+json; charset=utf-8'); next(); });

  // Bearer SCIM token -> organisation + connection
  r.use(async (req, res, next) => {
    try {
      const m = /^Bearer\s+(scim_[A-Za-z0-9_-]{20,})$/.exec(req.get('authorization') ?? '');
      const t = m && await one(
        `UPDATE scim_tokens t SET last_used_at = now() FROM org_sso_connections c, organisations o
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND c.id = t.connection_id AND c.status <> 'disabled' AND o.id = t.organisation_id AND o.status = 'active'
        RETURNING t.id, t.organisation_id, t.connection_id`, [sha256(m[1])]);
      if (!t) throw new ScimError(401, 'Invalid or revoked SCIM token');
      req.scim = t; req.conn = await loadConnection(t.connection_id);
      next();
    } catch (e) { next(e); }
  });

  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  const send = (res, status, body, version, location) => { if (version != null) res.set('ETag', etag(version)); if (location) res.set('Location', location); res.status(status).json(body); };

  r.get('/ServiceProviderConfig', (req, res) => res.json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_COUNT }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Organisation SCIM token', primary: true }] }));
  r.get('/ResourceTypes', (req, res) => res.json({ schemas: [LIST], totalResults: 2, Resources: [
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: U },
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: G }] }));
  r.get('/Schemas', (req, res) => res.json({ schemas: [LIST], totalResults: 2, Resources: [{ id: U, name: 'User' }, { id: G, name: 'Group' }] }));

  // ---- Users
  r.get('/Users', wrap(async (req, res) => {
    const f = eqFilter(req.query.filter, ['userName', 'externalId']);
    const { start, count } = paging(req.query);
    const where = ['organisation_id = $1']; const args = [req.scim.organisation_id];
    if (f?.attr === 'userName') { args.push(blindIndex(f.value)); where.push(`email_idx = $${args.length}`); }
    if (f?.attr === 'externalId') { args.push(f.value); where.push(`external_id = $${args.length}`); }
    const total = (await one(`SELECT count(*)::int AS n FROM scim_users WHERE ${where.join(' AND ')}`, args)).n;
    const rows = await many(`SELECT * FROM scim_users WHERE ${where.join(' AND ')} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`, args);
    await audit(null, null, 'read_pii', 'scim_users', null);
    res.json({ schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: await Promise.all(rows.map((u) => userJson(req, u))) });
  }));

  r.post('/Users', wrap(async (req, res) => {
    const b = req.body ?? {};
    const domains = await verifiedDomains(req.scim.organisation_id);
    const email = parseUserName(b.userName ?? b.emails?.find((e) => e.primary)?.value ?? b.emails?.[0]?.value, domains);
    const idx = blindIndex(email);
    const externalId = b.externalId ? String(b.externalId).slice(0, 200) : null;
    const out = await tx(async (c) => {
      await c.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [req.scim.organisation_id]); // serialises concurrent retries of the same create
      const hit = (await c.query('SELECT * FROM scim_users WHERE organisation_id=$1 AND (email_idx=$2 OR ($3::text IS NOT NULL AND external_id=$3))', [req.scim.organisation_id, idx, externalId])).rows;
      if (hit.length > 1 || (hit[0] && hit[0].email_idx !== idx) || (hit[0] && externalId && hit[0].external_id && hit[0].external_id !== externalId)) throw new ScimError(409, 'userName or externalId already belongs to a different user', 'uniqueness');
      if (hit[0]) return { row: hit[0], created: false };
      const row = (await c.query('INSERT INTO scim_users(organisation_id, connection_id, external_id, email_enc, email_idx, display_name, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [req.scim.organisation_id, req.scim.connection_id, externalId, encrypt(email, 'scim_users.email'), idx, b.displayName ? String(b.displayName).slice(0, 120) : null, b.active === undefined ? true : boolOf(b.active)])).rows[0];
      await logEvent(c, { orgId: req.scim.organisation_id, connId: req.scim.connection_id, event: 'scim_user_created', detail: { scim_user: row.id, active: row.active } });
      return { row, created: true };
    });
    await audit(null, null, 'read_pii', 'scim_users', out.row.id);
    send(res, out.created ? 201 : 200, await userJson(req, out.row), out.row.version, `${base(req)}/Users/${out.row.id}`);
  }));

  const loadUser = async (req) => {
    const row = /^[0-9a-f-]{36}$/i.test(req.params.id) && await one('SELECT * FROM scim_users WHERE id=$1 AND organisation_id=$2', [req.params.id, req.scim.organisation_id]);
    if (!row) throw new ScimError(404, 'User not found');
    return row;
  };

  r.get('/Users/:id', wrap(async (req, res) => { const row = await loadUser(req); await audit(null, null, 'read_pii', 'scim_users', row.id); send(res, 200, await userJson(req, row), row.version); }));

  /** Apply a desired state to a user inside a transaction; returns the fresh row. Only real changes bump the version. */
  const changeUser = (req, mutate) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM scim_users WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [req.params.id, req.scim.organisation_id])).rows[0];
    if (!cur) throw new ScimError(404, 'User not found');
    checkMatch(req, cur.version);
    const want = await mutate({ ...cur }, c);
    const set = []; const args = [cur.id];
    const put = (col, v) => { args.push(v); set.push(`${col} = $${args.length}`); };
    if (want.email_idx !== cur.email_idx) {
      if ((await c.query('SELECT 1 FROM scim_users WHERE organisation_id=$1 AND email_idx=$2 AND id<>$3', [cur.organisation_id, want.email_idx, cur.id])).rowCount) throw new ScimError(409, 'userName already in use', 'uniqueness');
      put('email_idx', want.email_idx); put('email_enc', want.email_enc);
    }
    if (want.external_id !== cur.external_id) {
      if (want.external_id && (await c.query('SELECT 1 FROM scim_users WHERE organisation_id=$1 AND external_id=$2 AND id<>$3', [cur.organisation_id, want.external_id, cur.id])).rowCount) throw new ScimError(409, 'externalId already in use', 'uniqueness');
      put('external_id', want.external_id);
    }
    if (want.display_name !== cur.display_name) put('display_name', want.display_name);
    if (want.active !== cur.active) { put('active', want.active); set.push(want.active ? 'deactivated_at = NULL' : 'deactivated_at = now()'); }
    if (!set.length) return cur;
    const row = (await c.query(`UPDATE scim_users SET ${set.join(', ')}, version = version + 1, updated_at = now() WHERE id=$1 RETURNING *`, args)).rows[0];
    if (want.active !== cur.active) await logEvent(c, { orgId: cur.organisation_id, connId: req.scim.connection_id, userId: row.user_id, event: want.active ? 'scim_user_activated' : 'scim_user_deactivated', detail: { scim_user: row.id } });
    if (want.active !== cur.active || want.email_idx !== cur.email_idx) await syncMember(c, req.conn, row);
    return row;
  });

  r.put('/Users/:id', wrap(async (req, res) => {
    const b = req.body ?? {};
    const domains = await verifiedDomains(req.scim.organisation_id);
    const row = await changeUser(req, (u) => {
      const email = parseUserName(b.userName, domains);
      return { ...u, email_idx: blindIndex(email), email_enc: encrypt(email, 'scim_users.email'), external_id: b.externalId ? String(b.externalId).slice(0, 200) : null, display_name: b.displayName ? String(b.displayName).slice(0, 120) : null, active: b.active === undefined ? true : boolOf(b.active) };
    });
    send(res, 200, await userJson(req, row), row.version);
  }));

  r.patch('/Users/:id', wrap(async (req, res) => {
    const ops = req.body?.Operations;
    if (!Array.isArray(req.body?.schemas) || !req.body.schemas.includes(PATCH) || !Array.isArray(ops) || !ops.length) throw bad('A PatchOp with Operations is required', 'invalidSyntax');
    const domains = await verifiedDomains(req.scim.organisation_id);
    const row = await changeUser(req, (u) => {
      const apply = (path, value) => {
        const p = String(path ?? '').toLowerCase();
        if (p === 'active') u.active = boolOf(value);
        else if (p === 'displayname') u.display_name = value ? String(value).slice(0, 120) : null;
        else if (p === 'externalid') u.external_id = value ? String(value).slice(0, 200) : null;
        else if (p === 'username' || p === 'emails' || p.startsWith('emails[')) { const v = Array.isArray(value) ? value[0]?.value : value; const e = parseUserName(v, domains); u.email_idx = blindIndex(e); u.email_enc = encrypt(e, 'scim_users.email'); }
        else throw bad(`Cannot patch ${path}`, 'noTarget');
      };
      for (const op of ops) {
        const kind = String(op.op ?? '').toLowerCase();
        if (!['add', 'replace', 'remove'].includes(kind)) throw bad('Unknown op', 'invalidSyntax');
        if (kind === 'remove') { if (String(op.path ?? '').toLowerCase() === 'externalid') u.external_id = null; else throw bad('Only externalId can be removed', 'mutability'); continue; }
        if (op.path) apply(op.path, op.value);
        else for (const [k, v] of Object.entries(op.value ?? {})) { if (['schemas', 'id', 'meta', 'groups'].includes(k)) continue; apply(k, v); }
      }
      return u;
    });
    send(res, 200, await userJson(req, row), row.version);
  }));

  // DELETE deprovisions (the reference is kept, inactive, so retried deletes are harmless and history is intact)
  r.delete('/Users/:id', wrap(async (req, res) => {
    await changeUser(req, (u) => ({ ...u, active: false }));
    res.status(204).end();
  }));

  // ---- Groups
  const loadGroup = async (req, c) => {
    const row = /^[0-9a-f-]{36}$/i.test(req.params.id) && (await (c ?? { query }).query('SELECT * FROM scim_groups WHERE id=$1 AND organisation_id=$2 AND removed_at IS NULL', [req.params.id, req.scim.organisation_id])).rows[0];
    if (!row) throw new ScimError(404, 'Group not found');
    return row;
  };
  const memberIds = (v) => (Array.isArray(v) ? v : []).map((m) => String(m?.value ?? '')).filter(Boolean);

  r.get('/Groups', wrap(async (req, res) => {
    const f = eqFilter(req.query.filter, ['displayName']);
    const { start, count } = paging(req.query);
    const args = [req.scim.organisation_id]; let extra = '';
    if (f) { args.push(f.value.toLowerCase()); extra = ' AND lower(display_name) = $2'; }
    const total = (await one(`SELECT count(*)::int AS n FROM scim_groups WHERE organisation_id=$1 AND removed_at IS NULL${extra}`, args)).n;
    const rows = await many(`SELECT * FROM scim_groups WHERE organisation_id=$1 AND removed_at IS NULL${extra} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`, args);
    res.json({ schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: await Promise.all(rows.map((g) => groupJson(req, g))) });
  }));

  r.post('/Groups', wrap(async (req, res) => {
    const name = String(req.body?.displayName ?? '').trim();
    if (!name || name.length > 200) throw bad('displayName is required');
    const out = await tx(async (c) => {
      await c.query('SELECT id FROM organisations WHERE id=$1 FOR UPDATE', [req.scim.organisation_id]);
      let g = (await c.query('SELECT * FROM scim_groups WHERE organisation_id=$1 AND lower(display_name)=lower($2) AND removed_at IS NULL', [req.scim.organisation_id, name])).rows[0];
      const created = !g;
      if (!g) g = (await c.query('INSERT INTO scim_groups(organisation_id, connection_id, display_name, external_id) VALUES ($1,$2,$3,$4) RETURNING *', [req.scim.organisation_id, req.scim.connection_id, name, req.body.externalId ? String(req.body.externalId).slice(0, 200) : null])).rows[0];
      if (created) await logEvent(c, { orgId: req.scim.organisation_id, connId: req.scim.connection_id, event: 'scim_group_created', detail: { group: g.id } });
      if (req.body.members) await setMembers(c, req.conn, g, memberIds(req.body.members));
      return { g: (await c.query('SELECT * FROM scim_groups WHERE id=$1', [g.id])).rows[0], created };
    });
    send(res, out.created ? 201 : 200, await groupJson(req, out.g), out.g.version, `${base(req)}/Groups/${out.g.id}`);
  }));

  r.get('/Groups/:id', wrap(async (req, res) => { const g = await loadGroup(req); send(res, 200, await groupJson(req, g), g.version); }));

  r.put('/Groups/:id', wrap(async (req, res) => {
    const g = await tx(async (c) => {
      const cur = await loadGroup(req, c); checkMatch(req, cur.version);
      if (req.body?.displayName && req.body.displayName !== cur.display_name) await c.query('UPDATE scim_groups SET display_name=$2, version=version+1, updated_at=now() WHERE id=$1', [cur.id, String(req.body.displayName).slice(0, 200)]);
      await setMembers(c, req.conn, cur, memberIds(req.body?.members));
      return (await c.query('SELECT * FROM scim_groups WHERE id=$1', [cur.id])).rows[0];
    });
    send(res, 200, await groupJson(req, g), g.version);
  }));

  r.patch('/Groups/:id', wrap(async (req, res) => {
    const ops = req.body?.Operations;
    if (!Array.isArray(ops) || !ops.length) throw bad('Operations are required', 'invalidSyntax');
    const g = await tx(async (c) => {
      const cur = await loadGroup(req, c); checkMatch(req, cur.version);
      let ids = (await c.query('SELECT scim_user_id FROM scim_group_members WHERE group_id=$1 AND removed_at IS NULL', [cur.id])).rows.map((x) => x.scim_user_id);
      for (const op of ops) {
        const kind = String(op.op ?? '').toLowerCase(); const path = String(op.path ?? '');
        if (/^members$/i.test(path) || (!path && kind !== 'remove' && op.value?.members)) {
          const v = memberIds(path ? op.value : op.value.members);
          if (kind === 'add') ids = [...new Set([...ids, ...v])]; else if (kind === 'replace') ids = v; else if (kind === 'remove') ids = ids.filter((i) => !v.includes(i)); else throw bad('Unknown op', 'invalidSyntax');
        } else if (/^members\[value eq "([0-9a-f-]{36})"\]$/i.test(path) && kind === 'remove') {
          const target = /"([0-9a-f-]{36})"/i.exec(path)[1].toLowerCase(); ids = ids.filter((i) => i.toLowerCase() !== target);
        } else if (/^displayName$/i.test(path) && kind === 'replace') {
          await c.query('UPDATE scim_groups SET display_name=$2, version=version+1, updated_at=now() WHERE id=$1', [cur.id, String(op.value).slice(0, 200)]);
        } else throw bad(`Cannot patch ${path || 'that value'}`, 'noTarget');
      }
      await setMembers(c, req.conn, cur, ids);
      return (await c.query('SELECT * FROM scim_groups WHERE id=$1', [cur.id])).rows[0];
    });
    send(res, 200, await groupJson(req, g), g.version);
  }));

  r.delete('/Groups/:id', wrap(async (req, res) => {
    await tx(async (c) => {
      const cur = await loadGroup(req, c); checkMatch(req, cur.version);
      await setMembers(c, req.conn, cur, []);
      await c.query('UPDATE scim_groups SET removed_at = now(), version = version + 1, updated_at = now() WHERE id=$1', [cur.id]);
      await logEvent(c, { orgId: cur.organisation_id, connId: req.scim.connection_id, event: 'scim_group_removed', detail: { group: cur.id } });
    });
    res.status(204).end();
  }));

  r.use((req, res) => res.status(404).json({ schemas: [ERR], status: '404', detail: 'Unknown SCIM endpoint' }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, _next) => {
    const status = err instanceof ScimError ? err.status : err?.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) console.error('[scim]', err);
    res.status(status).json({ schemas: [ERR], status: String(status), ...(err.scimType ? { scimType: err.scimType } : status === 400 ? { scimType: 'invalidSyntax' } : {}), detail: status === 500 ? 'Server error' : err.message });
  });
  return r;
}
