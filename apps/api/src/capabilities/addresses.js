// Addresses: one place for where a person, organisation or team is. Several per owner, one default,
// optionally tied to an organisation/event/academy/team. A person's street lines are encrypted.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { canManageTeam } from './teams.js';
import { badRequest, forbidden, notFound } from '../errors.js';

const TAG = 'Addresses';
const STAFF = ['owner', 'admin'];
const KINDS = ['home', 'training', 'billing', 'venue', 'other'];
const OWNERS = ['user', 'organisation', 'team'];
const CONTEXTS = ['organisation', 'event', 'academy', 'team'];
const PII_CTX = 'addresses.pii';
const text = (n) => z.string().trim().max(n);

const fields = {
  kind: z.enum(KINDS).default('other'),
  label: text(60).optional(),
  line1: text(120).optional(),
  line2: text(120).optional(),
  locality: text(80).optional().describe('city or town'),
  area: text(80).optional().describe('area or district'),
  region: text(80).optional().describe('state or province'),
  postal_code: text(20).optional(),
  country: z.union([z.string().regex(/^[A-Z]{2}$/, 'two-letter country code'), z.literal('')]).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  timezone: text(60).optional(),
  sport_id: id.optional().describe('the sport this is where you play'),
  context_kind: z.enum(CONTEXTS).optional(),
  context_id: id.optional(),
};
const owner = { owner_kind: z.enum(OWNERS).default('user'), owner_id: id.optional().describe('defaults to you for owner_kind=user') };

/** May the caller read / change addresses of this owner? Returns the owner id. */
async function authorise(user, kind, ownerId, write) {
  if (kind === 'user') {
    if (ownerId && ownerId !== user.id) throw forbidden('You can only manage your own addresses');
    return user.id;
  }
  if (!ownerId) throw badRequest('owner_id is required');
  if (kind === 'organisation') { await orgFor(user, ownerId, write ? STAFF : undefined, { write }); return ownerId; }
  const team = await one('SELECT * FROM teams WHERE id=$1', [ownerId]);
  if (!team) throw notFound('Team');
  if (write ? !(await canManageTeam(user, team)) : false) throw forbidden('Only people who run this team can change its addresses');
  return ownerId;
}

const PUBLIC = 'id, owner_kind, owner_id, kind, label, line1, line2, locality, area, region, postal_code, country, latitude, longitude, timezone, pii_enc, sport_id, context_kind, context_id, is_default, created_at, updated_at';

/** Street lines of a person's address live encrypted; everyone else's are plain. */
function seal(kind, a) {
  if (kind !== 'user') return a;
  const { line1, line2, postal_code, ...rest } = a;
  const pii = JSON.stringify({ line1: line1 ?? null, line2: line2 ?? null, postal_code: postal_code ?? null });
  return { ...rest, line1: null, line2: null, postal_code: null, pii_enc: line1 || line2 || postal_code ? encrypt(pii, PII_CTX) : null };
}

async function open(rows, c, actor) {
  const withPii = rows.filter((r) => r.pii_enc);
  if (withPii.length) await audit(c, actor.id, 'read_pii', 'addresses', withPii[0].id);
  return rows.map(({ pii_enc, ...r }) => (pii_enc ? { ...r, ...JSON.parse(decrypt(pii_enc, PII_CTX)) } : r));
}

async function checkContext(user, i) {
  if (!i.context_kind) return;
  if (!i.context_id) throw badRequest('context_id is required with context_kind');
  if (i.context_kind === 'organisation') await orgFor(user, i.context_id);
  if (i.context_kind === 'team' && !(await one('SELECT 1 FROM teams WHERE id=$1', [i.context_id]))) throw notFound('Team');
  if (i.context_kind === 'event' && !(await one('SELECT 1 FROM events WHERE id=$1', [i.context_id]))) throw notFound('Event');
}

const COLS = ['kind', 'label', 'line1', 'line2', 'locality', 'area', 'region', 'postal_code', 'country', 'latitude', 'longitude', 'timezone', 'pii_enc', 'sport_id', 'context_kind', 'context_id'];

cap({
  name: 'list_addresses', method: 'GET', path: '/addresses', tag: TAG, auth: 'user',
  summary: 'The addresses of you (default), an organisation you belong to, or a team, default first. Street lines of personal addresses are decrypted and the read is audit-logged.',
  input: z.object({ owner_kind: z.enum(OWNERS).default('user'), owner_id: id.optional() }),
  async handler({ user }, i) {
    const oid = await authorise(user, i.owner_kind, i.owner_id, false);
    return tx(async (c) => open((await c.query(`SELECT ${PUBLIC} FROM addresses WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY is_default DESC, created_at`, [i.owner_kind, oid])).rows, c, user));
  },
});

cap({
  name: 'create_address', method: 'POST', path: '/addresses', tag: TAG, auth: 'user', status: 201,
  summary: 'Add an address (city/area required, full street address optional). The first one becomes the default; pass is_default to make this one the default.',
  input: z.object({ ...owner, ...fields, is_default: z.boolean().optional() })
    .refine((v) => v.locality || v.area || v.line1, { message: 'Give at least a city, an area or a street address' }),
  async handler({ user }, i) {
    const oid = await authorise(user, i.owner_kind, i.owner_id, true);
    await checkContext(user, i);
    const a = seal(i.owner_kind, i);
    return tx(async (c) => {
      const first = !(await c.query('SELECT 1 FROM addresses WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL', [i.owner_kind, oid])).rowCount;
      const makeDefault = first || !!i.is_default;
      if (makeDefault) await c.query('UPDATE addresses SET is_default=false, updated_at=now() WHERE owner_kind=$1 AND owner_id=$2 AND is_default AND archived_at IS NULL', [i.owner_kind, oid]);
      const row = (await c.query(
        `INSERT INTO addresses (owner_kind, owner_id, ${COLS.join(',')}, is_default, created_by)
         VALUES ($1,$2,${COLS.map((_, n) => `$${n + 3}`).join(',')},$${COLS.length + 3},$${COLS.length + 4}) RETURNING ${PUBLIC}`,
        [i.owner_kind, oid, ...COLS.map((k) => (a[k] === '' ? null : a[k] ?? null)), makeDefault, user.id])).rows[0];
      return (await open([row], c, user))[0];
    });
  },
});

async function mine(user, addressId, c, write = true) {
  const a = (await c.query('SELECT * FROM addresses WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [addressId])).rows[0];
  if (!a) throw notFound('Address');
  await authorise(user, a.owner_kind, a.owner_id, write);
  return a;
}

cap({
  name: 'update_address', method: 'PATCH', path: '/addresses/:id', tag: TAG, auth: 'user',
  summary: 'Change an address. Send only the fields to change; send null-like empty strings to clear one.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await mine(user, i.id, c);
      await checkContext(user, { context_kind: i.context_kind ?? a.context_kind, context_id: i.context_id ?? a.context_id });
      const plain = a.owner_kind === 'user' && a.pii_enc ? JSON.parse(decrypt(a.pii_enc, PII_CTX)) : {};
      const next = { ...a, ...plain, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'id' && v !== undefined)) };
      const s = seal(a.owner_kind, next);
      await c.query(
        `UPDATE addresses SET ${COLS.map((k, n) => `${k}=$${n + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
        [i.id, ...COLS.map((k) => (s[k] === '' ? null : s[k] ?? null))]);
      return (await open([(await c.query(`SELECT ${PUBLIC} FROM addresses WHERE id=$1`, [i.id])).rows[0]], c, user))[0];
    });
  },
});

cap({
  name: 'set_default_address', method: 'POST', path: '/addresses/:id/default', tag: TAG, auth: 'user',
  summary: 'Make this address the default for its owner.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await mine(user, i.id, c);
      await c.query('UPDATE addresses SET is_default=false, updated_at=now() WHERE owner_kind=$1 AND owner_id=$2 AND is_default AND archived_at IS NULL', [a.owner_kind, a.owner_id]);
      await c.query('UPDATE addresses SET is_default=true, updated_at=now() WHERE id=$1', [a.id]);
      return { id: a.id, is_default: true };
    });
  },
});

cap({
  name: 'archive_address', method: 'DELETE', path: '/addresses/:id', tag: TAG, auth: 'user',
  summary: 'Remove an address from your lists (kept on record, not deleted). If it was the default, the oldest remaining one takes over.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await mine(user, i.id, c);
      await c.query('UPDATE addresses SET archived_at=now(), is_default=false, updated_at=now() WHERE id=$1', [a.id]);
      if (a.is_default) {
        await c.query(
          `UPDATE addresses SET is_default=true, updated_at=now() WHERE id = (SELECT id FROM addresses WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY created_at LIMIT 1)`,
          [a.owner_kind, a.owner_id]);
      }
      return { id: a.id, archived: true };
    });
  },
});
