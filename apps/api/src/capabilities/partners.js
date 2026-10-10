// Partner management: onboarding, modification, suspension and offboarding of partners, venue approval, and the platform team.
// Platform staff hold the `admin` role; only the platform owner (`platform_admin`) can add or remove platform staff.
// Contacts, tax id and payout details are encrypted at rest and every read of them is audit-logged. Nothing is deleted:
// partners are suspended / offboarded and venues are paused, so history, bookings and settlements stay intact.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { blindIndex, decrypt, encrypt, hashPassword } from '../crypto.js';
import { notify } from '../notify.js';
import { isPlatform, isPlatformOwner, reviewApplication } from '../platform.js';
import { createContract } from './partner-contracts.js';

const TAG = 'Partner management';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };
const KINDS = ['venue_operator', 'club', 'academy', 'school', 'other'];

const profile = {
  name: z.string().min(2).max(120), legal_name: z.string().max(160).optional(), kind: z.enum(KINDS).optional(),
  city: z.string().max(80).optional(), country: z.string().max(60).optional(),
  contact_name: z.string().max(120).optional(), contact_email: z.string().email().optional(), contact_phone: z.string().max(30).optional(),
  tax_id: z.string().max(40).optional(),
  payout: z.object({ account_holder: z.string().min(2).max(120), account_number: z.string().min(4).max(40), bank_code: z.string().max(30).optional() }).optional(),
  notes: z.string().max(2000).optional(),
};
const ENC = { contact_name: 'contact_name_enc', contact_email: 'contact_email_enc', contact_phone: 'contact_phone_enc', tax_id: 'tax_id_enc' };
const PLAIN = ['name', 'legal_name', 'kind', 'city', 'country', 'notes'];

const event = (c, partnerId, actor, action, detail = {}) => c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [partnerId, actor, action, JSON.stringify(detail)]);
const newCode = async (c) => `PTR-${String((await c.query("SELECT nextval('partner_code_seq') AS n")).rows[0].n).padStart(6, '0')}`;

/** Columns for the encrypted / plain profile fields present in `i`. */
function profileColumns(i) {
  const cols = {};
  for (const k of PLAIN) if (i[k] !== undefined) cols[k] = i[k];
  for (const [k, col] of Object.entries(ENC)) if (i[k] !== undefined) cols[col] = encrypt(i[k], `partners.${k}`);
  if (i.payout) { cols.payout_enc = encrypt(JSON.stringify(i.payout), 'partners.payout'); cols.payout_last4 = i.payout.account_number.slice(-4); }
  return cols;
}
const setSql = (cols, from = 2) => Object.keys(cols).map((k, n) => `${k}=$${n + from}`).join(', ');

/** Used by create_venue: the owner's partner record (created as an application the first time they register a venue). */
export async function ensurePartnerFor(c, user, venueInput) {
  const have = (await c.query("SELECT id, status FROM partners WHERE owner_id=$1 AND status <> 'offboarded' ORDER BY applied_at LIMIT 1", [user.id])).rows[0];
  if (have) {
    if (have.status === 'suspended' && !isPlatform(user)) throw forbidden('Your partner account is suspended — contact the platform team');
    return have.id;
  }
  const r = (await c.query(
    `INSERT INTO partners(code, name, legal_name, kind, status, owner_id, city, created_by) VALUES ($1,$2,$3,'venue_operator',$4,$5,$6,$5) RETURNING id`,
    [await newCode(c), user.display_name, venueInput.legal_name ?? null, isPlatform(user) ? 'active' : 'applied', user.id, venueInput.city ?? null])).rows[0];
  await event(c, r.id, user.id, 'applied', { via: 'venue_registration' });
  return r.id;
}

const canSeePartner = (user, p) => isPlatform(user) || p.owner_id === user.id;
async function loadPartner(user, partnerId) {
  const p = await one('SELECT * FROM partners WHERE id=$1', [partnerId]);
  if (!p || !canSeePartner(user, p)) throw notFound('Partner');
  return p;
}
function view(p, { contacts = false } = {}) {
  const { contact_name_enc, contact_email_enc, contact_phone_enc, tax_id_enc, payout_enc, ...rest } = p;
  const out = { ...rest, has_tax_id: !!tax_id_enc, has_payout: !!payout_enc, has_contact: !!(contact_email_enc || contact_phone_enc) };
  if (contacts) {
    const d = (v, k) => (v ? decrypt(v, `partners.${k}`) : null);
    Object.assign(out, { contact_name: d(contact_name_enc, 'contact_name'), contact_email: d(contact_email_enc, 'contact_email'), contact_phone: d(contact_phone_enc, 'contact_phone'), tax_id: d(tax_id_enc, 'tax_id') });
  }
  return out;
}

// ------------------------------------------------------------------ partner onboarding and management
cap({
  name: 'onboard_partner', method: 'POST', path: '/admin/partners', tag: TAG, status: 201,
  summary: 'Platform team: onboard a partner for an existing user (the partner owner). Starts in `onboarding`; tick the checklist, send a contract, then approve with decide_partner.',
  input: z.object({ owner: z.string().describe('owner user id or handle'), ...profile }),
  async handler({ user }, i) {
    platformOnly(user);
    const owner = /^[0-9a-f-]{36}$/.test(i.owner) ? await one('SELECT id FROM users WHERE id=$1', [i.owner]) : await one('SELECT id FROM users WHERE handle=$1', [i.owner.toLowerCase()]);
    if (!owner) throw notFound('Owner user');
    const { owner: _o, ...rest } = i;
    const cols = profileColumns(rest);
    return tx(async (c) => {
      const code = await newCode(c);
      const keys = Object.keys(cols);
      const row = (await c.query(`INSERT INTO partners(code, status, owner_id, created_by${keys.length ? ', ' + keys.join(',') : ''}) VALUES ($1,'onboarding',$2,$3${keys.map((_, n) => `,$${n + 4}`).join('')}) RETURNING *`, [code, owner.id, user.id, ...keys.map((k) => cols[k])])).rows[0];
      await event(c, row.id, user.id, 'onboarded');
      await notify(c, owner.id, { kind: 'partner_onboarding', title: 'You are being onboarded as a SportArena partner', body: 'The platform team started your partner account. Complete your details to go live.', data: { partner_id: row.id } });
      return view(row);
    });
  },
});

cap({
  name: 'list_partners', method: 'GET', path: '/admin/partners', tag: TAG,
  summary: 'Platform team: all partners with status, venue counts and 30-day revenue. Filter by status, city or search text.',
  input: z.object({ status: z.enum(['applied', 'onboarding', 'active', 'suspended', 'offboarded', 'rejected']).optional(), city: z.string().optional(), q: z.string().optional(), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    return many(
      `SELECT p.id, p.code, p.name, p.kind, p.status, p.city, p.risk_score, p.applied_at, p.activated_at, p.owner_id, u.handle AS owner_handle,
              (SELECT count(*)::int FROM venues v WHERE v.partner_id=p.id) AS venues,
              (SELECT count(*)::int FROM venues v WHERE v.partner_id=p.id AND v.approval_status='pending') AS venues_pending,
              (SELECT count(*)::int FROM partner_contracts k WHERE k.partner_id=p.id AND k.status='active') AS active_contracts
         FROM partners p JOIN users u ON u.id=p.owner_id
        WHERE ($1::text IS NULL OR p.status=$1) AND ($2::text IS NULL OR p.city ILIKE $2) AND ($3::text IS NULL OR p.name ILIKE '%'||$3||'%' OR p.code ILIKE '%'||$3||'%')
        ORDER BY (p.status IN ('applied','onboarding')) DESC, p.applied_at DESC LIMIT $4 OFFSET $5`,
      [i.status ?? null, i.city ?? null, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_partner', method: 'GET', path: '/partners/:id', tag: TAG,
  summary: 'One partner: profile with decrypted contacts (audit-logged), checklist, venues, contracts, recent settlements and timeline. The platform team and the partner owner can read it; payout details show only the last 4 digits.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await loadPartner(user, i.id);
    await audit(null, user.id, 'read_pii', 'partners', p.id);
    const [venues, contracts, settlements, events] = await Promise.all([
      many(`SELECT v.id, v.name, v.city, v.active, v.approval_status, v.approval_note, v.paused_by_partner,
                   (SELECT count(*)::int FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources FROM venues v WHERE v.partner_id=$1 ORDER BY v.created_at`, [p.id]),
      many('SELECT id, contract_no, version, venue_id, status, effective_from, effective_to, terms, sent_at, accepted_at FROM partner_contracts WHERE partner_id=$1 ORDER BY created_at DESC', [p.id]),
      many('SELECT id, settlement_no, venue_id, period_end, status, sales_cents, commission_cents, net_payable_cents, currency FROM settlements WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 10', [p.id]),
      many('SELECT e.id, e.action, e.detail, e.created_at, u.handle AS actor FROM partner_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.partner_id=$1 ORDER BY e.id DESC LIMIT 30', [p.id]),
    ]);
    return { ...view(p, { contacts: true }), venues_list: venues, contracts, settlements, timeline: events };
  },
});

cap({
  name: 'get_my_partner', method: 'GET', path: '/me/partner', tag: TAG, auth: ['venue_manager', 'organizer'],
  summary: 'Your partner account (created when you register your first venue): status, venues awaiting approval, contracts to review, settlements and pending price requests.',
  async handler({ user }) {
    const p = await one("SELECT * FROM partners WHERE owner_id=$1 AND status <> 'offboarded' ORDER BY applied_at LIMIT 1", [user.id])
      ?? await one('SELECT * FROM partners WHERE owner_id=$1 ORDER BY applied_at DESC LIMIT 1', [user.id]);
    if (!p) return null;
    const [venues, contracts, settlements, requests] = await Promise.all([
      many('SELECT id, name, city, active, approval_status, approval_note, paused_by_partner FROM venues WHERE partner_id=$1 ORDER BY created_at', [p.id]),
      many("SELECT id, contract_no, version, venue_id, status, effective_from, effective_to, terms, sent_at, accepted_at FROM partner_contracts WHERE partner_id=$1 AND status <> 'draft' ORDER BY created_at DESC", [p.id]),
      many('SELECT id, settlement_no, venue_id, period_end, status, sales_cents, commission_cents, net_payable_cents, currency, paid_at FROM settlements WHERE partner_id=$1 AND status <> \'draft\' ORDER BY created_at DESC LIMIT 10', [p.id]),
      many("SELECT id, venue_id, kind, status, payload, counter, created_at FROM price_requests WHERE venue_id IN (SELECT id FROM venues WHERE partner_id=$1) AND status IN ('pending','countered') ORDER BY created_at DESC", [p.id]),
    ]);
    return { ...view(p, { contacts: true }), venues_list: venues, contracts, settlements, price_requests: requests };
  },
});

cap({
  name: 'update_partner', method: 'PATCH', path: '/partners/:id', tag: TAG,
  summary: 'Modify a partner. The owner edits their own profile, contacts, tax id and payout account; the platform team can also edit any partner, tick onboarding checklist steps (`checklist`: tax_id, payout, contract_signed, site_visit, photos…) and change the kind.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, v.optional()])), checklist: z.record(z.string().max(40), z.boolean()).optional() }),
  async handler({ user }, i) {
    const p = await loadPartner(user, i.id);
    if (p.status === 'offboarded') throw conflict('This partner is offboarded');
    const { id: _id, checklist, ...rest } = i;
    if (checklist && !isPlatform(user)) throw forbidden('Only the platform team ticks the onboarding checklist');
    if (!isPlatform(user)) delete rest.notes;
    const cols = profileColumns(rest);
    if (checklist) cols.checklist = JSON.stringify({ ...p.checklist, ...checklist });
    if (!Object.keys(cols).length) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const row = (await c.query(`UPDATE partners SET ${setSql(cols)}, updated_at=now() WHERE id=$1 RETURNING *`, [p.id, ...Object.values(cols)])).rows[0];
      await event(c, p.id, user.id, 'updated', { fields: Object.keys(rest).concat(checklist ? ['checklist'] : []) });
      return view(row);
    });
  },
});

async function setVenuesPaused(c, partnerId, paused) {
  if (paused) await c.query("UPDATE venues SET active=false, paused_by_partner=true WHERE partner_id=$1 AND active", [partnerId]);
  else await c.query("UPDATE venues SET active=true, paused_by_partner=false WHERE partner_id=$1 AND paused_by_partner AND approval_status='approved'", [partnerId]);
}

cap({
  name: 'decide_partner', method: 'POST', path: '/admin/partners/:id/decision', tag: TAG,
  summary: 'Platform team: move a partner through its life — `approve` (go live), `reject` an application, `suspend` (pauses all its venues, keeps data), `reinstate`, or `offboard` (pauses venues, terminates contracts, blocked while upcoming bookings exist). Always with a reason; nothing is deleted.',
  input: z.object({ id, action: z.enum(['approve', 'reject', 'suspend', 'reinstate', 'offboard']), reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM partners WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Partner');
      const allowed = { approve: ['applied', 'onboarding'], reject: ['applied', 'onboarding'], suspend: ['active'], reinstate: ['suspended'], offboard: ['active', 'suspended', 'onboarding', 'applied'] };
      if (!allowed[i.action].includes(p.status)) throw conflict(`A ${p.status} partner cannot be ${i.action === 'approve' ? 'approved' : i.action + 'ed'}`);
      const to = { approve: 'active', reject: 'rejected', suspend: 'suspended', reinstate: 'active', offboard: 'offboarded' }[i.action];
      if (i.action === 'offboard') {
        const upcoming = (await c.query("SELECT count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE v.partner_id=$1 AND b.status='confirmed' AND b.starts_at > now()", [p.id])).rows[0].n;
        if (upcoming) throw conflict(`${upcoming} upcoming booking(s) remain — let them run or cancel them first, then offboard`, { upcoming });
        await c.query("UPDATE partner_contracts SET status='terminated', terminated_at=now(), termination_reason=$2 WHERE partner_id=$1 AND status IN ('sent','active','draft')", [p.id, i.reason]);
      }
      const stamp = { approve: 'activated_at', suspend: 'suspended_at', offboard: 'offboarded_at' }[i.action];
      await c.query(`UPDATE partners SET status=$2, decision_reason=$3, updated_at=now()${stamp ? `, ${stamp}=now()` : ''} WHERE id=$1`, [p.id, to, i.reason]);
      if (i.action === 'suspend' || i.action === 'offboard') await setVenuesPaused(c, p.id, true);
      if (i.action === 'reinstate') await setVenuesPaused(c, p.id, false);
      await event(c, p.id, user.id, i.action, { reason: i.reason, from: p.status, to });
      await notify(c, p.owner_id, { kind: 'partner_status', title: `Your partner account is now ${to}`, body: i.reason, data: { partner_id: p.id } });
      return { id: p.id, status: to, final_settlement_due: i.action === 'offboard' };
    });
  },
});

cap({
  name: 'review_partner', method: 'GET', path: '/admin/partners/:id/review', tag: TAG,
  summary: 'Onboarding assistant: checks completeness, scores risk (every point explained), flags what is missing, and recommends commission, reserve and settlement cycle for the contract. Advisory only — the platform team decides.',
  input: z.object({ id }),
  async handler({ user }, i) {
    platformOnly(user);
    const p = await one('SELECT * FROM partners WHERE id=$1', [i.id]);
    if (!p) throw notFound('Partner');
    const venues = await many(
      `SELECT v.latitude, (SELECT count(*)::int FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources, (SELECT count(*)::int FROM venue_hours h WHERE h.venue_id=v.id AND h.removed_at IS NULL) AS hours,
              EXISTS (SELECT 1 FROM verification_cases vc WHERE vc.subject_id=v.id AND vc.status='approved') AS verified FROM venues v WHERE v.partner_id=$1`, [p.id]);
    const r = reviewApplication({ partner: p, venues, docs: { tax_id: !!p.tax_id_enc, payout: !!p.payout_enc, contact: !!(p.contact_email_enc && p.contact_phone_enc) }, checklist: p.checklist });
    await one('UPDATE partners SET risk_score=$2 WHERE id=$1 RETURNING id', [p.id, r.risk_score]);
    return r;
  },
});

// ------------------------------------------------------------------ venue approval
cap({
  name: 'list_venue_approvals', method: 'GET', path: '/admin/venue-approvals', tag: TAG,
  summary: 'Platform team: venues awaiting approval (default), or any approval state, with their partner, areas, proposed rate card and amenities so they can be reviewed in one place.',
  input: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'changes_requested']).default('pending'), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    return many(
      `SELECT v.id, v.name, v.city, v.address, v.approval_status, v.approval_note, v.amenities, v.currency, v.created_at, p.id AS partner_id, p.name AS partner_name, p.code AS partner_code, p.status AS partner_status,
              (SELECT coalesce(json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'hourly_rate_cents', r.hourly_rate_cents) ORDER BY r.name), '[]') FROM resources r WHERE r.venue_id=v.id AND r.active) AS resources,
              (SELECT count(*)::int FROM price_rules pr WHERE pr.venue_id=v.id AND pr.active) AS price_rules
         FROM venues v LEFT JOIN partners p ON p.id=v.partner_id WHERE v.approval_status=$1 ORDER BY v.created_at LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]);
  },
});

const termsIn = z.object({}).passthrough();
cap({
  name: 'decide_venue', method: 'POST', path: '/admin/venues/:id/decision', tag: TAG,
  summary: 'Platform team: approve a venue (it goes live), reject it, or ask for changes. When approving you can activate the partner and, as part of onboarding, send the partner a customised contract (`contract`: terms, custom clauses, effective dates). Prices: set the platform price list with apply_pricing_plan before or after approving.',
  input: z.object({
    id, decision: z.enum(['approve', 'reject', 'request_changes']), note: z.string().max(500).optional(), activate_partner: z.boolean().default(true),
    contract: z.object({ terms: termsIn.optional(), clauses: z.array(z.object({ title: z.string().max(80).optional(), text: z.string().min(3).max(2000) })).max(20).optional(), template_id: id.optional(), effective_from: z.string().date().optional(), effective_to: z.string().date().optional() }).optional(),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    if (i.decision !== 'approve' && !i.note) throw badRequest('Give the partner a note explaining the decision');
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM venues WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!v) throw notFound('Venue');
      const status = { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' }[i.decision];
      if (i.decision === 'approve') {
        const p = v.partner_id ? (await c.query('SELECT * FROM partners WHERE id=$1 FOR UPDATE', [v.partner_id])).rows[0] : null;
        if (p && ['applied', 'onboarding'].includes(p.status)) {
          if (!i.activate_partner) throw conflict('Approve the partner first (decide_partner) or set activate_partner');
          await c.query("UPDATE partners SET status='active', activated_at=now(), updated_at=now() WHERE id=$1", [p.id]);
          await event(c, p.id, user.id, 'approve', { via: 'venue_approval' });
        } else if (p && p.status !== 'active') throw conflict(`The partner is ${p.status}`);
      }
      await c.query('UPDATE venues SET approval_status=$2, approval_note=$3, approved_by=$4, approved_at=now(), active=$5 WHERE id=$1', [v.id, status, i.note ?? null, user.id, i.decision === 'approve']);
      let contract = null;
      if (i.decision === 'approve' && i.contract && v.partner_id) {
        contract = await createContract(c, user, { partner_id: v.partner_id, venue_id: v.id, send: true, ...i.contract });
      }
      if (v.partner_id) await event(c, v.partner_id, user.id, `venue_${status}`, { venue_id: v.id, note: i.note ?? null });
      await notify(c, v.owner_id, { kind: 'venue_approval', title: i.decision === 'approve' ? `${v.name} is approved and live` : `${v.name}: ${i.decision === 'reject' ? 'not approved' : 'changes requested'}`, body: i.note ?? (contract ? `Review and accept your contract ${contract.contract_no}.` : 'Your venue is live.'), data: { venue_id: v.id } });
      return { id: v.id, approval_status: status, active: i.decision === 'approve', contract };
    });
  },
});

// ------------------------------------------------------------------ platform team
cap({
  name: 'list_platform_users', method: 'GET', path: '/admin/platform-users', tag: TAG,
  summary: 'Platform team: everyone with platform rights (the owner is marked).',
  async handler({ user }) {
    platformOnly(user);
    return many("SELECT id, handle, display_name, ('platform_admin' = ANY(roles)) AS is_owner, roles FROM users WHERE 'admin' = ANY(roles) ORDER BY ('platform_admin' = ANY(roles)) DESC, display_name");
  },
});

cap({
  name: 'create_platform_user', method: 'POST', path: '/admin/platform-users', tag: TAG, status: 201,
  summary: 'Platform owner only: create another platform team account (rights to approve venues, set prices, decide partners and run settlements). Everyone else registers as an ordinary app user and can never hold platform rights.',
  input: z.object({ handle: z.string().regex(/^[a-z0-9_]{3,24}$/, '3-24 chars: a-z, 0-9, _'), display_name: z.string().min(1).max(60), email: z.string().email(), password: z.string().min(10).max(200) }),
  async handler({ user }, i) {
    if (!isPlatformOwner(user)) throw forbidden('Only the platform owner can create platform users');
    if (await one('SELECT 1 AS x FROM users WHERE email_idx=$1 OR handle=$2', [blindIndex(i.email), i.handle])) throw conflict('Email or handle already registered');
    const row = await tx(async (c) => {
      const u = (await c.query(
        `INSERT INTO users(handle, display_name, roles, password_hash, email_enc, email_idx, avatar_emoji, avatar_color) VALUES ($1,$2,'{admin}',$3,$4,$5,'🏛️','#4F46E5') RETURNING id, handle, display_name, roles`,
        [i.handle, i.display_name, hashPassword(i.password), encrypt(i.email, 'users.email'), blindIndex(i.email)])).rows[0];
      await audit(c, user.id, 'create_platform_user', 'users', u.id);
      return u;
    });
    return row;
  },
});

cap({
  name: 'remove_platform_user', method: 'DELETE', path: '/admin/platform-users/:id', tag: TAG,
  summary: 'Platform owner only: take platform rights away from a team member. The account and its history are kept; it becomes an ordinary user. The owner account cannot be changed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!isPlatformOwner(user)) throw forbidden('Only the platform owner can remove platform users');
    const u = await one('SELECT id, roles FROM users WHERE id=$1', [i.id]);
    if (!u || !u.roles.includes('admin')) throw notFound('Platform user');
    if (u.roles.includes('platform_admin')) throw forbidden('The platform owner account cannot be changed');
    const roles = u.roles.filter((r) => r !== 'admin');
    await tx(async (c) => {
      await c.query('UPDATE users SET roles=$2 WHERE id=$1', [u.id, roles.length ? roles : ['athlete']]);
      await audit(c, user.id, 'remove_platform_user', 'users', u.id);
    });
    return { ok: true };
  },
});
