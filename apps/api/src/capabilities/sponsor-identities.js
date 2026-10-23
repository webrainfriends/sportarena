// Sponsor identities (#282): the legal/billing identity behind sponsor brands, the people authorised to act for it, and portfolios.
// One sponsor entity (individual, company or organization) can own many brands; a person can run several entities, each with its own
// roles. Access is decided in sponsor-identity-access.js on every call. Private identity fields (legal name, registration, tax, billing) are
// never returned by the public directory; encrypted ones are audit-logged when decrypted. Nothing here is deleted: people leave
// (status), portfolios archive, and each agreement keeps its own frozen identity snapshot.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { decryptFields, encryptFields } from '../crypto.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { CAN, ROLES, entityRole, sponsorRole, createEntity, sponsorTeamSql } from '../sponsor-identity-access.js';

const TAG = 'Sponsors';
const PRIVATE = ['registration_number', 'tax_id', 'billing_email', 'billing_address'];
const TYPE = z.enum(['individual', 'company', 'organization']);
const ROLE = z.enum(ROLES);

const lockEntity = async (c, entityId) => {
  const e = (await c.query('SELECT * FROM sponsor_entities WHERE id=$1 FOR UPDATE', [entityId])).rows[0];
  if (!e) throw notFound('Sponsor entity');
  return e;
};
/** The caller's role in an entity; 404 for outsiders (existence is not leaked), 403 if the role is too weak. */
async function entityFor(c, user, entityId, need) {
  const e = await one('SELECT * FROM sponsor_entities WHERE id=$1', [entityId]);
  const role = e ? await entityRole(c, user, entityId) : null;
  if (!e || !role) throw notFound('Sponsor entity');
  if (!need.includes(role)) throw forbidden('Your role in this sponsor does not allow that');
  return { entity: e, role };
}

/** Identity as one authorised caller may see it. Registration/tax/billing only for owner/admin, with an audit row. */
async function identityView(c, user, sp, role) {
  const e = sp.entity_id ? (await c.query('SELECT * FROM sponsor_entities WHERE id=$1', [sp.entity_id])).rows[0] : null;
  const canSeePrivate = !!e && CAN.identity.includes(role);
  const out = {
    sponsor_id: sp.id, display_name: sp.name, entity_id: e?.id ?? null, identity_confirmed: !!e,
    sponsor_type: e?.sponsor_type ?? null, legal_name: e?.legal_name ?? null, registration_country: e?.registration_country ?? null, organisation_id: e?.organisation_id ?? null,
    row_version: e?.row_version ?? null, my_role: role, can_edit: CAN.identity.includes(role),
  };
  if (canSeePrivate) {
    await audit(c, user.id, 'read_pii', 'sponsor_entities', e.id);
    Object.assign(out, Object.fromEntries(PRIVATE.map((f) => [f, null])), decryptFields(e, 'sponsor_entities', PRIVATE));
  }
  out.brands = e ? (await c.query('SELECT id, name, emoji FROM sponsors WHERE entity_id=$1 ORDER BY name, id', [e.id])).rows : [];
  return out;
}

async function brandFor(c, user, sponsorId, need, { lock = false } = {}) {
  const sp = (await c.query(`SELECT id, name, owner_id, entity_id FROM sponsors WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [sponsorId])).rows[0];
  const role = sp ? await sponsorRole(c, user, sp) : null;
  if (!sp || !role) throw notFound('Sponsor');
  if (!need.includes(role)) throw forbidden('Your role in this sponsor does not allow that');
  return { sp, role };
}

// ------------------------------------------------------------------ identity
cap({
  name: 'get_sponsor_identity', method: 'GET', path: '/sponsors/:id/identity', tag: TAG,
  summary: 'The sponsor behind a brand: type, legal name, registration country and version. Owners and admins of the entity also get the encrypted registration number, tax id and billing contact (the read is audit-logged). Everyone else who acts for the brand sees the non-sensitive part only. Never public. A brand that has no confirmed identity yet returns identity_confirmed=false and no invented data.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { sp, role } = await brandFor(pool, user, i.id, CAN.read);
    return identityView(pool, user, sp, role);
  },
});

cap({
  name: 'set_sponsor_identity', method: 'POST', path: '/sponsors/:id/identity', tag: TAG,
  summary: 'Owner/admin: confirm or update the legal and billing identity of a brand. The first save creates the sponsor entity (you become its owner); later saves must send the current `row_version` and a stale one is rejected with 409 so nobody overwrites a colleague. Individuals have no registration number. An organization may link an organisation you own or administer. Registration, tax and billing details are encrypted. Agreements already proposed keep the identity they were proposed with.',
  input: z.object({
    id, sponsor_type: TYPE.optional(), legal_name: z.string().min(2).max(160).nullable().optional(),
    registration_country: z.string().regex(/^[A-Za-z]{2}$/, 'two-letter country code').toUpperCase().nullable().optional().describe('ISO 3166-1 alpha-2 country of registration or residence'),
    registration_number: z.string().min(2).max(60).nullable().optional(), tax_id: z.string().min(2).max(60).nullable().optional(),
    billing_email: z.string().email().nullable().optional(), billing_address: z.string().min(5).max(400).nullable().optional(),
    organisation_id: id.nullable().optional(), row_version: z.coerce.number().int().positive().optional().describe('required once the identity exists'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { sp, role } = await brandFor(c, user, i.id, CAN.identity, { lock: true });
      let e;
      if (!sp.entity_id) {
        if (!i.sponsor_type) throw badRequest('sponsor_type is required to confirm an identity');
        e = await lockEntity(c, await createEntity(c, sp.owner_id, { sponsor_type: i.sponsor_type, legal_name: null }));
        await c.query('UPDATE sponsors SET entity_id=$2 WHERE id=$1', [sp.id, e.id]);
      } else {
        e = await lockEntity(c, sp.entity_id);
        if (i.row_version == null) throw badRequest('row_version is required to change an existing identity');
        if (i.row_version !== e.row_version) throw conflict(`This identity changed (now version ${e.row_version}); reload it and try again`, { row_version: e.row_version });
      }
      const type = i.sponsor_type ?? e.sponsor_type;
      if (type === 'individual' && i.registration_number) throw badRequest('An individual has no company registration number');
      if (i.organisation_id && type !== 'organization') throw badRequest('Only an organization sponsor can link an organisation');
      if (i.organisation_id && !isAdmin(user) && !(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c))) throw forbidden('You must own or administer that organisation to link it');
      const enc = encryptFields(i, 'sponsor_entities', PRIVATE);
      const set = { sponsor_type: type };
      for (const k of ['legal_name', 'registration_country', 'organisation_id']) if (i[k] !== undefined) set[k] = i[k];
      for (const [k, v] of Object.entries(enc)) set[k] = v;
      if (type === 'individual' && e.registration_number_enc && i.registration_number !== null) throw conflict('This identity has a registration number; clear it explicitly (registration_number: null) before changing to an individual');
      if (type !== 'organization' && e.organisation_id && i.organisation_id !== null) throw conflict('This identity is linked to an organisation; unlink it explicitly (organisation_id: null) before changing the type');
      const keys = Object.keys(set);
      await c.query(`UPDATE sponsor_entities SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1`, [e.id, ...keys.map((k) => set[k])]);
      const fresh = (await c.query('SELECT * FROM sponsors WHERE id=$1', [sp.id])).rows[0];
      return identityView(c, user, fresh, role);
    });
  },
});

cap({
  name: 'attach_sponsor_brand', method: 'POST', path: '/sponsors/:id/entity', tag: TAG,
  summary: 'Move a brand that has no confirmed identity under a sponsor entity you own or administer (so one entity can run several brands). From then on the entity\'s representatives, not the original owner, control the brand. Existing agreements, payments and history are untouched.',
  input: z.object({ id, entity_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { sp } = await brandFor(c, user, i.id, ['owner'], { lock: true });
      if (sp.entity_id) throw conflict('This brand already belongs to a sponsor entity');
      await entityFor(c, user, i.entity_id, CAN.identity);
      const mine = await c.query("SELECT 1 FROM sponsor_representatives WHERE entity_id=$1 AND user_id=$2 AND status='active'", [i.entity_id, sp.owner_id]);
      if (!mine.rowCount) throw forbidden('The brand owner must be an active representative of the entity first');
      await c.query('UPDATE sponsors SET entity_id=$2 WHERE id=$1', [sp.id, i.entity_id]);
      return identityView(c, user, { ...sp, entity_id: i.entity_id }, await sponsorRole(c, user, { ...sp, entity_id: i.entity_id }));
    });
  },
});

cap({
  name: 'list_my_sponsor_identities', method: 'GET', path: '/me/sponsor-identities', tag: TAG,
  summary: 'Every sponsor entity you act for (individual, company or organization) with your role, its brands you can reach, and — on the first page — invitations waiting for your answer. Ordered by legal name.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const entities = await many(
      `SELECT e.id, e.sponsor_type, e.legal_name, e.registration_country, e.row_version, r.role AS my_role, r.id AS representative_id
         FROM sponsor_entities e JOIN sponsor_representatives r ON r.entity_id=e.id AND r.user_id=$1 AND r.status='active'
        ORDER BY lower(coalesce(e.legal_name,'')), e.created_at, e.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    for (const e of entities) {
      e.brands = await many(`SELECT sp.id, sp.name, sp.emoji FROM sponsors sp WHERE sp.entity_id=$2 AND ${sponsorTeamSql('$1')} ORDER BY sp.name, sp.id`, [user.id, e.id]);
      e.identity_complete = !!e.legal_name;
    }
    const invitations = i.offset ? [] : await many(
      `SELECT r.id AS representative_id, r.entity_id, e.sponsor_type, e.legal_name, r.role, r.title, r.created_at, u.display_name AS invited_by
         FROM sponsor_representatives r JOIN sponsor_entities e ON e.id=r.entity_id LEFT JOIN users u ON u.id=r.invited_by
        WHERE r.user_id=$1 AND r.status='invited' ORDER BY r.created_at, r.id`, [user.id]);
    const legacy = i.offset ? [] : await many(`SELECT sp.id, sp.name, sp.emoji FROM sponsors sp WHERE sp.entity_id IS NULL AND sp.owner_id=$1 ORDER BY sp.name, sp.id`, [user.id]);
    return { entities, invitations, brands_without_identity: legacy };
  },
});

// ------------------------------------------------------------------ representatives
const repRow = (c, repId) => c.query('SELECT * FROM sponsor_representatives WHERE id=$1', [repId]).then((r) => r.rows[0]);

cap({
  name: 'list_sponsor_representatives', method: 'GET', path: '/sponsor-entities/:id/representatives', tag: TAG,
  summary: 'Owner/admin: the people authorised for a sponsor entity — role, status (invited, active, declined, left), title and, for portfolio managers, the portfolios they manage. People who left stay listed, so the record of who was authorised is never lost.',
  input: z.object({ id, status: z.enum(['invited', 'active', 'declined', 'left']).optional(), ...page }),
  async handler({ user }, i) {
    await entityFor(pool, user, i.id, CAN.identity);
    return many(
      `SELECT r.id, r.user_id, u.handle, u.display_name, r.role, r.title, r.status, r.joined_at, r.left_at, r.created_at,
              coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name) FROM sponsor_portfolio_assignments a JOIN sponsor_portfolios p ON p.id=a.portfolio_id
                         WHERE a.representative_id=r.id AND a.ended_at IS NULL AND p.archived_at IS NULL), '[]') AS portfolios
         FROM sponsor_representatives r JOIN users u ON u.id=r.user_id
        WHERE r.entity_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY (r.status='active') DESC, r.created_at, r.id LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});

/** Admins may not hand out or touch the owner/admin roles; only owners do. */
const mayGrant = (actorRole, role) => actorRole === 'owner' || !['owner', 'admin'].includes(role);

cap({
  name: 'invite_sponsor_representative', method: 'POST', path: '/sponsor-entities/:id/representatives', tag: TAG, status: 201,
  summary: 'Invite a person (an adult account) to act for a sponsor entity as owner, admin, finance, portfolio manager or viewer. Owners can invite any role; admins can invite finance, portfolio managers and viewers. The person must accept before they get any access. Inviting someone who is already invited with the same role returns that invitation; one person can hold different roles in different entities.',
  input: z.object({ id, user_id: id, role: ROLE, title: z.string().max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { role: mine } = await entityFor(c, user, i.id, CAN.identity);
      await lockEntity(c, i.id);
      if (!mayGrant(mine, i.role)) throw forbidden('Only an owner can appoint owners and admins');
      const u = (await c.query(`SELECT u.id, u.display_name FROM users u WHERE u.id=$1 AND ${NOT_YOUTH_SQL}`, [i.user_id])).rows[0];
      if (!u) throw badRequest('That person cannot be invited (not found, or a youth account: representatives must be adults)');
      const live = (await c.query("SELECT * FROM sponsor_representatives WHERE entity_id=$1 AND user_id=$2 AND status IN ('invited','active')", [i.id, i.user_id])).rows[0];
      if (live?.status === 'active') throw conflict('This person already acts for the entity; change their role instead');
      if (live) { if (live.role === i.role) return live; throw conflict('This person already has a pending invitation with a different role; cancel it first'); }
      const row = (await c.query("INSERT INTO sponsor_representatives(entity_id, user_id, role, title, invited_by) VALUES ($1,$2,$3,$4,$5) RETURNING *", [i.id, i.user_id, i.role, i.title ?? null, user.id])).rows[0];
      await notify(c, i.user_id, { kind: 'sponsor_invite', title: 'You were invited to act for a sponsor', body: 'Open Sponsors to accept or decline.', data: { representative_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'respond_sponsor_invite', method: 'POST', path: '/sponsor-representatives/:id/response', tag: TAG,
  summary: 'The invited person accepts or declines. Access starts only when accepted. A decided invitation cannot be answered again.',
  input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM sponsor_representatives WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r || r.user_id !== user.id) throw notFound('Invitation');
      if (r.status !== 'invited') throw conflict(`This invitation is already ${r.status}`);
      const row = (await c.query(`UPDATE sponsor_representatives SET status=$2, joined_at=CASE WHEN $2='active' THEN now() END WHERE id=$1 RETURNING *`, [r.id, i.accept ? 'active' : 'declined'])).rows[0];
      if (r.invited_by) await notify(c, r.invited_by, { kind: 'sponsor_invite', title: `Invitation ${i.accept ? 'accepted' : 'declined'}`, body: 'Open Sponsors to see your team.', data: { representative_id: r.id } });
      return row;
    });
  },
});

/** Count of other active owners — an entity must always keep one. */
const otherOwners = async (c, entityId, repId) => Number((await c.query("SELECT count(*) AS n FROM sponsor_representatives WHERE entity_id=$1 AND role='owner' AND status='active' AND id<>$2", [entityId, repId])).rows[0].n);

cap({
  name: 'update_sponsor_representative', method: 'PATCH', path: '/sponsor-representatives/:id', tag: TAG,
  summary: 'Change a representative\'s role or title. Only owners change owners and admins; the last owner cannot be demoted. A portfolio manager who becomes another role loses their portfolio assignments (the history stays).',
  input: z.object({ id, role: ROLE.optional(), title: z.string().max(80).nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = await repRow(c, i.id);
      if (!r0) throw notFound('Representative');
      const { role: mine } = await entityFor(c, user, r0.entity_id, CAN.identity);
      await lockEntity(c, r0.entity_id);
      const r = (await c.query('SELECT * FROM sponsor_representatives WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['invited', 'active'].includes(r.status)) throw conflict(`This person has ${r.status}`);
      if (!mayGrant(mine, r.role) || (i.role && !mayGrant(mine, i.role))) throw forbidden('Only an owner can change owners and admins');
      if (i.role && i.role !== r.role && r.role === 'owner' && r.status === 'active' && await otherOwners(c, r.entity_id, r.id) === 0) throw conflict('An entity must keep at least one owner');
      const row = (await c.query('UPDATE sponsor_representatives SET role=coalesce($2, role), title=CASE WHEN $4 THEN $3 ELSE title END WHERE id=$1 RETURNING *', [r.id, i.role ?? null, i.title ?? null, i.title !== undefined])).rows[0];
      if (i.role && i.role !== 'portfolio_manager') await c.query('UPDATE sponsor_portfolio_assignments SET ended_at=now() WHERE representative_id=$1 AND ended_at IS NULL', [r.id]);
      return row;
    });
  },
});

cap({
  name: 'remove_sponsor_representative', method: 'POST', path: '/sponsor-representatives/:id/remove', tag: TAG,
  summary: 'End a representative\'s access (or cancel an invitation), or leave yourself. Their record, and the agreements and history they were part of, are kept; access stops at once. The last owner cannot leave.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r0 = await repRow(c, i.id);
      if (!r0) throw notFound('Representative');
      const own = r0.user_id === user.id;
      let mine = null;
      if (own) { if (!(await entityRole(c, user, r0.entity_id)) && r0.status !== 'invited') throw notFound('Representative'); }
      else mine = (await entityFor(c, user, r0.entity_id, CAN.identity)).role;
      await lockEntity(c, r0.entity_id);
      const r = (await c.query('SELECT * FROM sponsor_representatives WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['invited', 'active'].includes(r.status)) throw conflict(`This person has already ${r.status === 'left' ? 'left' : r.status}`);
      if (!own && !mayGrant(mine, r.role)) throw forbidden('Only an owner can remove owners and admins');
      if (r.role === 'owner' && r.status === 'active' && await otherOwners(c, r.entity_id, r.id) === 0) throw conflict('An entity must keep at least one owner');
      const row = (await c.query("UPDATE sponsor_representatives SET status='left', left_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      await c.query('UPDATE sponsor_portfolio_assignments SET ended_at=now() WHERE representative_id=$1 AND ended_at IS NULL', [r.id]);
      if (!own) await notify(c, r.user_id, { kind: 'sponsor_invite', title: 'Your access to a sponsor ended', body: 'You can no longer act for that sponsor.', data: { representative_id: r.id } });
      return row;
    });
  },
});

// ------------------------------------------------------------------ portfolios
const portfolioRows = async (c, where, params) => {
  const rows = (await c.query(`SELECT p.id, p.entity_id, p.name, p.archived_at, p.created_at FROM sponsor_portfolios p WHERE ${where} ORDER BY p.archived_at IS NOT NULL, lower(p.name), p.id`, params)).rows;
  for (const p of rows) {
    p.brands = (await c.query('SELECT sp.id, sp.name, sp.emoji FROM sponsor_portfolio_brands b JOIN sponsors sp ON sp.id=b.sponsor_id WHERE b.portfolio_id=$1 AND b.removed_at IS NULL ORDER BY sp.name, sp.id', [p.id])).rows;
    p.managers = (await c.query("SELECT r.id AS representative_id, u.display_name FROM sponsor_portfolio_assignments a JOIN sponsor_representatives r ON r.id=a.representative_id JOIN users u ON u.id=r.user_id WHERE a.portfolio_id=$1 AND a.ended_at IS NULL AND r.status='active' ORDER BY u.display_name, r.id", [p.id])).rows;
  }
  return rows;
};

async function setBrands(c, p, sponsorIds) {
  const ids = [...new Set(sponsorIds)];
  if (ids.length) {
    const ok = (await c.query('SELECT id FROM sponsors WHERE entity_id=$1 AND id = ANY($2::uuid[])', [p.entity_id, ids])).rows.length;
    if (ok !== ids.length) throw badRequest('Every brand in a portfolio must belong to the same sponsor entity');
  }
  await c.query('UPDATE sponsor_portfolio_brands SET removed_at=now() WHERE portfolio_id=$1 AND removed_at IS NULL AND NOT (sponsor_id = ANY($2::uuid[]))', [p.id, ids]);
  await c.query('INSERT INTO sponsor_portfolio_brands(portfolio_id, sponsor_id) SELECT $1, x FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING', [p.id, ids]);
}
async function setManagers(c, p, repIds) {
  const ids = [...new Set(repIds)];
  if (ids.length) {
    const ok = (await c.query("SELECT id FROM sponsor_representatives WHERE entity_id=$1 AND role='portfolio_manager' AND status='active' AND id = ANY($2::uuid[])", [p.entity_id, ids])).rows.length;
    if (ok !== ids.length) throw badRequest('Managers must be active portfolio managers of this entity');
  }
  await c.query('UPDATE sponsor_portfolio_assignments SET ended_at=now() WHERE portfolio_id=$1 AND ended_at IS NULL AND NOT (representative_id = ANY($2::uuid[]))', [p.id, ids]);
  await c.query('INSERT INTO sponsor_portfolio_assignments(portfolio_id, representative_id, assigned_by) SELECT $1, x, $3 FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING', [p.id, ids, p.actor]);
}

cap({
  name: 'create_sponsor_portfolio', method: 'POST', path: '/sponsor-entities/:id/portfolios', tag: TAG, status: 201,
  summary: 'Owner/admin: group some of an entity\'s brands into a named portfolio and assign portfolio managers (active representatives with the portfolio_manager role). A portfolio manager can propose, revise, withdraw and follow deals only for brands in a portfolio assigned to them, and cannot change identity, billing or representatives. A brand can be in several portfolios.',
  input: z.object({ id, name: z.string().min(2).max(80), sponsor_ids: z.array(id).max(100).default([]), manager_ids: z.array(id).max(50).default([]).describe('representative ids (not user ids)') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await entityFor(c, user, i.id, CAN.identity);
      await lockEntity(c, i.id);
      if ((await c.query('SELECT 1 FROM sponsor_portfolios WHERE entity_id=$1 AND archived_at IS NULL AND lower(name)=lower($2)', [i.id, i.name])).rowCount) throw conflict('A portfolio with that name already exists');
      const p = (await c.query('INSERT INTO sponsor_portfolios(entity_id, name, created_by) VALUES ($1,$2,$3) RETURNING *', [i.id, i.name, user.id])).rows[0];
      await setBrands(c, p, i.sponsor_ids); await setManagers(c, { ...p, actor: user.id }, i.manager_ids);
      return (await portfolioRows(c, 'p.id=$1', [p.id]))[0];
    });
  },
});

cap({
  name: 'list_sponsor_portfolios', method: 'GET', path: '/sponsor-entities/:id/portfolios', tag: TAG,
  summary: 'Portfolios of a sponsor entity with their brands and managers. Owners, admins, finance and viewers see all; a portfolio manager sees only the portfolios assigned to them.',
  input: z.object({ id, archived: z.coerce.boolean().optional() }),
  async handler({ user }, i) {
    const { role } = await entityFor(pool, user, i.id, CAN.read);
    const mineOnly = role === 'portfolio_manager' && !isAdmin(user);
    return portfolioRows(pool, `p.entity_id=$1 AND (p.archived_at IS NULL OR $2) AND (NOT $4 OR EXISTS (SELECT 1 FROM sponsor_portfolio_assignments a JOIN sponsor_representatives r ON r.id=a.representative_id WHERE a.portfolio_id=p.id AND a.ended_at IS NULL AND r.user_id=$3 AND r.status='active'))`, [i.id, !!i.archived, user.id, mineOnly]);
  },
});

cap({
  name: 'update_sponsor_portfolio', method: 'PATCH', path: '/sponsor-portfolios/:id', tag: TAG,
  summary: 'Owner/admin: rename, archive or restore a portfolio, replace its set of brands (`sponsor_ids`) and its portfolio managers (`manager_ids`, representative ids). Removing a brand or manager ends access immediately; the history is kept.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), archived: z.boolean().optional(), sponsor_ids: z.array(id).max(100).optional(), manager_ids: z.array(id).max(50).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p0 = await mustFind('sponsor_portfolios', i.id, '*', c);
      await entityFor(c, user, p0.entity_id, CAN.identity);
      await lockEntity(c, p0.entity_id);
      const p = (await c.query('SELECT * FROM sponsor_portfolios WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const activeAfter = i.archived === undefined ? !p.archived_at : !i.archived;
      if (activeAfter && (await c.query('SELECT 1 FROM sponsor_portfolios WHERE entity_id=$1 AND archived_at IS NULL AND lower(name)=lower($2) AND id<>$3', [p.entity_id, i.name ?? p.name, p.id])).rowCount) throw conflict('A portfolio with that name already exists');
      await c.query('UPDATE sponsor_portfolios SET name=coalesce($2,name), archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1', [p.id, i.name ?? null, i.archived ?? null]);
      if (i.sponsor_ids) await setBrands(c, p, i.sponsor_ids);
      if (i.manager_ids) await setManagers(c, { ...p, actor: user.id }, i.manager_ids);
      return (await portfolioRows(c, 'p.id=$1', [p.id]))[0];
    });
  },
});

// ------------------------------------------------------------------ export
cap({
  name: 'export_sponsor_identity', method: 'GET', path: '/sponsor-entities/:id/export', tag: TAG,
  summary: 'Owner/admin: a complete export of a sponsor entity — identity (including the decrypted private fields), every representative with status and dates, portfolios, brands and the frozen identity of each agreement version. The export is audit-logged. Nothing is exported to anyone who does not act for the entity.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { entity: e } = await entityFor(pool, user, i.id, CAN.identity);
    await audit(null, user.id, 'export_pii', 'sponsor_entities', e.id);
    const { created_by, ...rest } = e;
    const identity = { ...Object.fromEntries(Object.entries(rest).filter(([k]) => !k.endsWith('_enc'))), ...decryptFields(e, 'sponsor_entities', PRIVATE), created_by };
    const [representatives, brands, snapshots] = await Promise.all([
      many('SELECT r.id, r.user_id, u.display_name, r.role, r.title, r.status, r.joined_at, r.left_at FROM sponsor_representatives r JOIN users u ON u.id=r.user_id WHERE r.entity_id=$1 ORDER BY r.created_at, r.id', [e.id]),
      many('SELECT id, name, industry, website FROM sponsors WHERE entity_id=$1 ORDER BY name, id', [e.id]),
      many('SELECT s.sponsorship_id, s.version, s.sponsor_id, s.display_name, s.legal_name, s.sponsor_type, s.signed_by, s.captured_at FROM sponsorship_identity_snapshots s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE sp.entity_id=$1 ORDER BY s.captured_at, s.sponsorship_id, s.version', [e.id])]);
    return { identity, representatives, brands, portfolios: await portfolioRows(pool, 'p.entity_id=$1', [e.id]), agreement_identities: snapshots };
  },
});
