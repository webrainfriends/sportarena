// Supplier services (#458) 1/5 — supplier identity, staff, credentials, tax configuration, the service catalogue and offerings.
// Goods commerce (shop.js) is untouched: a mixed offering may link a shop product, whose stock and shipping stay in the shop.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, hasRole } from '../helpers.js';
import { orgRole } from '../org-access.js';
import { assertCurrency, serviceCurrencies } from '../svc/money.js';
import { CATEGORY, catalogue, validateSpec, assertUnit, UNITS } from '../svc/catalogue.js';
import { supplierAccess, myProfileIds, log } from '../svc/access.js';
import { audit } from '../helpers.js';

const TAG = 'Supplier services';
const cur = z.string().length(3).transform((s) => s.toUpperCase());
const day = z.string().date();
const PUBLIC = 'p.id, p.supplier_type, p.legal_name, p.trading_name, p.description, p.categories, p.coverage, p.operating_hours, p.lead_time_days, p.currencies, p.timezone, p.status, p.created_at';

/** The credential kinds a supplier can hold; a buyer's requirement can demand any of them (#591). */
export const CREDENTIAL_KINDS = ['insurance', 'electrical', 'pool_operator', 'first_aid', 'safeguarding', 'vehicle', 'food_safety', 'business_registration', 'other'];
/** Credential kinds a requirement demands that the supplier has no currently valid credential for. Jurisdiction-neutral: it checks kind and validity, not any regulator's rules. */
export async function complianceGaps(c, profileId, kinds) {
  if (!kinds?.length) return [];
  const rows = (await c.query("SELECT * FROM svc_credentials WHERE profile_id=$1 AND status='active' AND kind = ANY($2)", [profileId, kinds])).rows;
  return kinds.filter((k) => !rows.some((x) => x.kind === k && ['valid', 'no_expiry', 'expiring'].includes(credentialState(x))));
}
export const credentialState = (c, today = new Date()) => {
  if (c.status !== 'active') return 'archived';
  if (!c.valid_to) return 'no_expiry';
  const d = (new Date(c.valid_to) - today) / 86400000;
  return d < 0 ? 'expired' : d <= 30 ? 'expiring' : 'valid';
};
const badge = { self_declared: 'Self-declared — not checked by Gotmygame', document_seen: 'Document uploaded and seen by Gotmygame', verified_by_admin: 'Verified by a Gotmygame administrator' };

cap({
  name: 'list_service_currencies', method: 'GET', path: '/service-currencies', tag: TAG, auth: 'public',
  summary: 'Currencies usable for service procurement: the platform list plus three-decimal currencies (KWD, BHD, OMR, JOD, TND), with their minor-unit exponent. Three-decimal currencies cannot be paid by card online; record a bank or cash payment.',
  handler: () => serviceCurrencies(),
});

cap({
  name: 'list_service_catalogue', method: 'GET', path: '/service-catalogue', tag: TAG, auth: 'public',
  summary: 'The sports-services catalogue: families, categories, permitted pricing units and the typed fields each category captures (used by offerings, requirements and RFQs).',
  handler: () => ({ units: UNITS, categories: catalogue() }),
});

// ---------------------------------------------------------------- profiles
const profileInput = {
  legal_name: z.string().min(1).max(160), trading_name: z.string().max(160).optional(), description: z.string().max(4000).optional(),
  categories: z.array(z.string()).max(30).default([]), coverage: z.record(z.string(), z.any()).default({}), operating_hours: z.record(z.string(), z.any()).default({}),
  lead_time_days: z.number().int().min(0).max(365).default(0), daily_capacity: z.number().min(0).max(100000).optional(), contact_channel: z.string().max(160).optional(),
  currencies: z.array(cur).max(10).default([]), timezone: z.string().max(60).default('UTC'), tax_registration: z.string().max(60).optional(), billing_address: z.string().max(400).optional(),
  terms: z.string().max(4000).optional(), invoice_prefix: z.string().regex(/^[A-Z0-9]{2,8}$/).optional(),
};
const checkCats = (cats) => { for (const c of cats) if (!CATEGORY[c]) throw badRequest(`Unknown service category: ${c}`); };

cap({
  name: 'create_supplier_profile', method: 'POST', path: '/supplier-profiles', tag: TAG, status: 201,
  summary: 'Open a supplier profile: an individual, sole trader or a company acting through an organisation you own/administer. One user may run several profiles (one per legal entity).',
  input: z.object({ supplier_type: z.enum(['individual', 'sole_trader', 'company']), organisation_id: id.optional(), ...profileInput }),
  async handler({ user }, i) {
    if (!hasRole(user, 'supplier')) throw forbidden('Register as a supplier first (add the supplier role to your account)');
    checkCats(i.categories); i.currencies.forEach(assertCurrency);
    if (i.supplier_type === 'company' && !i.organisation_id) throw badRequest('A company supplier acts through an organisation');
    if (i.organisation_id && !['owner', 'admin'].includes(await orgRole(user, i.organisation_id))) throw forbidden('Only an organisation owner or admin can open a supplier profile for it');
    try {
      return await tx(async (c) => {
        const p = (await c.query(
          `INSERT INTO svc_profiles(owner_id, organisation_id, supplier_type, legal_name, trading_name, description, categories, coverage, operating_hours, lead_time_days, daily_capacity, contact_channel, currencies, timezone, tax_registration, billing_address, terms, invoice_prefix)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [user.id, i.organisation_id ?? null, i.supplier_type, i.legal_name, i.trading_name ?? null, i.description ?? null, i.categories, i.coverage, i.operating_hours, i.lead_time_days, i.daily_capacity ?? null, i.contact_channel ?? null, i.currencies, i.timezone, i.tax_registration ?? null, i.billing_address ?? null, i.terms ?? null, i.invoice_prefix ?? null])).rows[0];
        await c.query("INSERT INTO svc_staff(profile_id, user_id, role, created_by) VALUES ($1,$2,'owner',$2)", [p.id, user.id]);
        await log(c, 'profile', p.id, user.id, 'created');
        return p;
      });
    } catch (e) { if (e.code === '23505') throw conflict('You already have a supplier profile for that entity, or the invoice prefix is taken'); throw e; }
  },
});

cap({
  name: 'update_supplier_profile', method: 'PATCH', path: '/supplier-profiles/:id', tag: TAG,
  summary: 'Edit a supplier profile (owner). Send the row_version you read; a stale edit is refused with 409.',
  input: z.object({ id, row_version: z.number().int(), ...Object.fromEntries(Object.entries(profileInput).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    const { row_version, id: pid, ...rest } = i;
    if (rest.categories) checkCats(rest.categories);
    rest.currencies?.forEach(assertCurrency);
    return tx(async (c) => {
      await supplierAccess(user, pid, ['owner'], c);
      const keys = Object.keys(rest).filter((k) => rest[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to change');
      const set = keys.map((k, n) => `${k}=$${n + 3}`).join(', ');
      const r = (await c.query(`UPDATE svc_profiles SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [pid, row_version, ...keys.map((k) => rest[k])])).rows[0];
      if (!r) throw conflict('This profile changed since you opened it — reload and try again');
      await log(c, 'profile', pid, user.id, 'updated', { keys });
      return r;
    });
  },
});

cap({
  name: 'list_my_supplier_profiles', method: 'GET', path: '/me/supplier-profiles', tag: TAG,
  summary: 'The supplier profiles you act for, with your role at each.',
  async handler({ user }) {
    const ids = await myProfileIds(user);
    return many("SELECT p.*, (SELECT array_agg(DISTINCT s.role) FROM svc_staff s WHERE s.profile_id=p.id AND s.user_id=$2 AND s.status='active') AS my_roles FROM svc_profiles p WHERE p.id = ANY($1) ORDER BY p.created_at, p.id", [ids, user.id]);
  },
});

cap({
  name: 'get_supplier_profile', method: 'GET', path: '/supplier-profiles/:id', tag: TAG, auth: 'public',
  summary: 'A supplier profile. The public sees trading details and credential badges (stating exactly what was checked); staff also see tax, billing, capacity and staff.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM svc_profiles WHERE id=$1', [i.id]);
    if (!p || p.status === 'archived') throw notFound('Supplier');
    let staff = false;
    if (user) { try { await supplierAccess(user, i.id, null); staff = true; } catch { /* public view */ } }
    const creds = (await many("SELECT * FROM svc_credentials WHERE profile_id=$1 AND status='active' ORDER BY valid_to NULLS LAST, id", [i.id])).map((c) => ({ id: c.id, kind: c.kind, title: c.title, valid_to: c.valid_to, verification: c.verification, badge: badge[c.verification], state: credentialState(c), ...(staff ? { reference: c.reference, required_for_award: c.required_for_award } : {}) }));
    const pub = { id: p.id, supplier_type: p.supplier_type, legal_name: p.legal_name, trading_name: p.trading_name, description: p.description, categories: p.categories, coverage: p.coverage, operating_hours: p.operating_hours, lead_time_days: p.lead_time_days, currencies: p.currencies, timezone: p.timezone, status: p.status, credentials: creds };
    if (!staff) return pub;
    return { ...p, credentials: creds, staff: await many("SELECT s.id, s.role, s.user_id, u.display_name, u.handle FROM svc_staff s JOIN users u ON u.id=s.user_id WHERE s.profile_id=$1 AND s.status='active' ORDER BY s.created_at", [i.id]), can_award_to: p.status === 'active' };
  },
});

cap({
  name: 'search_suppliers', method: 'GET', path: '/suppliers', tag: TAG, auth: 'public',
  summary: 'Find active suppliers by service category and name. Suspended suppliers are excluded.',
  input: z.object({ category: z.string().optional(), q: z.string().max(80).optional(), ...page }),
  handler: (_, i) => many(
    `SELECT ${PUBLIC}, (SELECT count(*)::int FROM svc_offerings o WHERE o.profile_id=p.id AND o.status='active') AS offerings FROM svc_profiles p
      WHERE p.status='active' AND ($1::text IS NULL OR $1 = ANY(p.categories)) AND ($2::text IS NULL OR p.legal_name ILIKE '%'||$2||'%' OR p.trading_name ILIKE '%'||$2||'%')
      ORDER BY coalesce(p.trading_name, p.legal_name), p.id LIMIT $3 OFFSET $4`, [i.category ?? null, i.q ?? null, i.limit, i.offset]),
});

cap({
  name: 'suspend_supplier', method: 'POST', path: '/supplier-profiles/:id/suspend', tag: TAG,
  summary: 'Platform admin: suspend or reinstate a supplier. A suspended supplier cannot receive new invitations or awards; existing orders and history stay intact.',
  input: z.object({ id, suspended: z.boolean(), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden('Only a platform admin can suspend a supplier');
    if (i.suspended && !i.reason) throw badRequest('Give a reason');
    const r = await one("UPDATE svc_profiles SET status=$2, suspended_reason=$3, row_version=row_version+1 WHERE id=$1 AND status <> 'archived' RETURNING *", [i.id, i.suspended ? 'suspended' : 'active', i.suspended ? i.reason : null]);
    if (!r) throw notFound('Supplier');
    await log({ query: (t, a) => one(t, a) }, 'profile', i.id, user.id, i.suspended ? 'suspended' : 'reinstated', { reason: i.reason ?? null });
    return r;
  },
});

// ---------------------------------------------------------------- staff
cap({
  name: 'add_supplier_staff', method: 'POST', path: '/supplier-profiles/:id/staff', tag: TAG, status: 201,
  summary: 'Give a person a role at your supplier (sales/quotation, scheduler, delivery supervisor, finance, crew).',
  input: z.object({ id, person: z.string().min(1).max(80).optional().describe('handle'), user_id: id.optional().describe('or pick the person by id'), role: z.enum(['sales', 'scheduler', 'supervisor', 'finance', 'crew']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await supplierAccess(user, i.id, ['owner'], c);
      if (!i.person && !i.user_id) throw badRequest('Say who: a handle or a person');
      const u = (await c.query(i.user_id ? 'SELECT id FROM users WHERE id=$1' : 'SELECT id FROM users WHERE handle=$1', [i.user_id ?? i.person.replace(/^@/, '')])).rows[0];
      if (!u) throw notFound('Person');
      try { const r = (await c.query('INSERT INTO svc_staff(profile_id, user_id, role, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, u.id, i.role, user.id])).rows[0]; await log(c, 'profile', i.id, user.id, 'staff_added', { user_id: u.id, role: i.role }); return r; }
      catch (e) { if (e.code === '23505') throw conflict('They already have that role'); throw e; }
    });
  },
});
cap({
  name: 'remove_supplier_staff', method: 'DELETE', path: '/supplier-staff/:id', tag: TAG,
  summary: 'End a staff role. Future access stops at once; records they created are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM svc_staff WHERE id=$1', [i.id])).rows[0];
      if (!s) throw notFound('Staff role');
      await supplierAccess(user, s.profile_id, ['owner'], c);
      if (s.role === 'owner') throw badRequest('The owner role cannot be removed');
      const r = (await c.query("UPDATE svc_staff SET status='left', left_at=now() WHERE id=$1 AND status='active' RETURNING *", [i.id])).rows[0];
      await log(c, 'profile', s.profile_id, user.id, 'staff_left', { user_id: s.user_id, role: s.role });
      return r ?? s;
    });
  },
});

// ---------------------------------------------------------------- credentials
cap({
  name: 'add_supplier_credential', method: 'POST', path: '/supplier-profiles/:id/credentials', tag: TAG, status: 201,
  summary: 'Record a certificate or insurance with its validity. It shows as self-declared until the platform has seen/verified it; expiry is flagged and (where required for award) blocks new awards.',
  input: z.object({ id, kind: z.enum(CREDENTIAL_KINDS), title: z.string().min(1).max(160), reference: z.string().max(120).optional(), valid_from: day.optional(), valid_to: day.optional(), required_for_award: z.boolean().default(false), document_ref: z.string().max(300).optional() }),
  async handler({ user }, i) {
    await supplierAccess(user, i.id, ['owner', 'sales']);
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('valid_to is before valid_from');
    return one('INSERT INTO svc_credentials(profile_id, kind, title, reference, valid_from, valid_to, required_for_award, document_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.kind, i.title, i.reference ?? null, i.valid_from ?? null, i.valid_to ?? null, i.required_for_award, i.document_ref ?? null]);
  },
});
cap({
  name: 'verify_supplier_credential', method: 'POST', path: '/supplier-credentials/:id/verify', tag: TAG,
  summary: 'Platform admin: record what was actually checked for a credential (document seen, or verified by an administrator).',
  input: z.object({ id, verification: z.enum(['document_seen', 'verified_by_admin']) }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden('Only a platform admin can verify credentials');
    const r = await one("UPDATE svc_credentials SET verification=$2, verified_by=$3, verified_at=now() WHERE id=$1 AND status='active' RETURNING *", [i.id, i.verification, user.id]);
    if (!r) throw notFound('Credential');
    return r;
  },
});
cap({
  name: 'archive_supplier_credential', method: 'DELETE', path: '/supplier-credentials/:id', tag: TAG, summary: 'Archive a credential (kept for history).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const c0 = await one('SELECT * FROM svc_credentials WHERE id=$1', [i.id]);
    if (!c0) throw notFound('Credential');
    await supplierAccess(user, c0.profile_id, ['owner']);
    return one("UPDATE svc_credentials SET status='archived' WHERE id=$1 RETURNING *", [i.id]);
  },
});

// ---------------------------------------------------------------- tax configuration (effective-dated, reviewed by the supplier; never one country's rules baked in)
cap({
  name: 'set_supplier_tax_rule', method: 'POST', path: '/supplier-profiles/:id/tax-rules', tag: TAG, status: 201,
  summary: 'Configure a tax treatment for your invoices and quotes: code, jurisdiction, rate (basis points), inclusive/exclusive prices, exemption / zero-rate / reverse charge, buyer withholding, rounding policy and the date it applies from. Rules are effective-dated and never edited — add a new one. Gotmygame does not assert any jurisdiction’s tax is correct; you own this configuration.',
  input: z.object({ id, code: z.string().min(1).max(24), name: z.string().min(1).max(80), jurisdiction: z.string().min(1).max(40), treatment: z.enum(['standard', 'zero_rated', 'exempt', 'reverse_charge']).default('standard'), rate_bp: z.number().int().min(0).max(10000).default(0), withholding_bp: z.number().int().min(0).max(10000).default(0), prices_include_tax: z.boolean().default(false), rounding: z.enum(['per_line', 'per_document']).default('per_line'), effective_from: day, effective_to: day.optional(), evidence: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await supplierAccess(user, i.id, ['owner', 'finance']);
    if (i.treatment !== 'standard' && i.rate_bp) throw badRequest('Exempt, zero-rated and reverse-charge treatments carry no rate');
    const { id: pid, ...r } = i;
    return one('INSERT INTO svc_tax_rules(profile_id, code, name, jurisdiction, treatment, rate_bp, withholding_bp, prices_include_tax, rounding, effective_from, effective_to, evidence, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [pid, r.code, r.name, r.jurisdiction, r.treatment, r.rate_bp, r.withholding_bp, r.prices_include_tax, r.rounding, r.effective_from, r.effective_to ?? null, r.evidence ?? null, user.id]);
  },
});
cap({
  name: 'list_supplier_tax_rules', method: 'GET', path: '/supplier-profiles/:id/tax-rules', tag: TAG, summary: 'Tax rules for a supplier (staff).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) { await supplierAccess(user, i.id, ['owner', 'finance', 'sales']); return many('SELECT * FROM svc_tax_rules WHERE profile_id=$1 ORDER BY code, effective_from DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]); },
});

// ---------------------------------------------------------------- offerings
const offeringInput = {
  category: z.string(), subcategory: z.string().max(80).optional(), title: z.string().min(1).max(160), description: z.string().max(4000).optional(),
  mode: z.enum(['service', 'goods', 'mixed']), pricing_model: z.enum(['quote_only', 'fixed']), unit: z.string(), rate_minor: money.optional(), currency: cur,
  min_quantity: z.number().positive().max(1e9).default(1), inclusions: z.array(z.string().max(200)).max(30).default([]), exclusions: z.array(z.string().max(200)).max(30).default([]),
  deliverables: z.array(z.string().max(200)).max(30).default([]), specs: z.record(z.string(), z.any()).default({}), geography: z.record(z.string(), z.any()).default({}),
  requires_certifications: z.array(z.string().max(80)).max(20).default([]), goods_product_id: id.optional(), media: z.array(z.object({ url: z.string().url().max(500), caption: z.string().max(200).optional() })).max(12).default([]),
};
const checkOffer = async (i) => {
  const c = CATEGORY[i.category];
  if (!c) throw badRequest(`Unknown service category: ${i.category}`);
  assertUnit(i.category, i.unit); assertCurrency(i.currency);
  if (c.goods === 'service' && i.mode !== 'service') throw badRequest(`${c.label} is a service-only category`);
  if (i.pricing_model === 'fixed' && i.rate_minor === undefined) throw badRequest('A fixed-price offering needs a rate');
  if (i.mode === 'service' && i.goods_product_id) throw badRequest('A service-only offering cannot link a goods product');
  return validateSpec(i.category, i.specs);
};

cap({
  name: 'create_service_offering', method: 'POST', path: '/supplier-profiles/:id/offerings', tag: TAG, status: 201,
  summary: 'Publish a service-only, goods-only or mixed offering with typed specs and structured pricing (unit + rate, or quote-only). Services never need stock or shipping; a mixed offering may link a shop product whose stock stays in the shop.',
  input: z.object({ id, ...offeringInput, status: z.enum(['draft', 'active']).default('active') }),
  async handler({ user }, i) {
    const { id: pid, status, ...o } = i;
    return tx(async (c) => {
      const { profile } = await supplierAccess(user, pid, ['owner', 'sales'], c);
      if (profile.status !== 'active') throw conflict('This supplier is suspended');
      o.specs = await checkOffer(o);
      if (o.goods_product_id) { const p = (await c.query('SELECT seller_id FROM shop_products WHERE id=$1', [o.goods_product_id])).rows[0]; if (!p) throw notFound('Product'); if (p.seller_id !== profile.owner_id && !isAdmin(user)) throw forbidden('That product belongs to someone else'); }
      const r = (await c.query(
        `INSERT INTO svc_offerings(profile_id, category, subcategory, title, description, mode, pricing_model, unit, rate_minor, currency, min_quantity, inclusions, exclusions, deliverables, specs, geography, requires_certifications, goods_product_id, media, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [pid, o.category, o.subcategory ?? null, o.title, o.description ?? null, o.mode, o.pricing_model, o.unit, o.rate_minor ?? null, o.currency, o.min_quantity, o.inclusions, o.exclusions, o.deliverables, o.specs, o.geography, o.requires_certifications, o.goods_product_id ?? null, JSON.stringify(o.media), status])).rows[0];
      await c.query('UPDATE svc_profiles SET categories = (SELECT array_agg(DISTINCT x) FROM unnest(categories || $2::text) x) WHERE id=$1', [pid, o.category]);
      return r;
    });
  },
});
cap({
  name: 'update_service_offering', method: 'PATCH', path: '/service-offerings/:id', tag: TAG,
  summary: 'Edit or archive an offering (row_version checked).',
  input: z.object({ id, row_version: z.number().int(), ...Object.fromEntries(Object.entries(offeringInput).map(([k, v]) => [k, v.optional()])), status: z.enum(['draft', 'active', 'archived']).optional() }),
  async handler({ user }, i) {
    const { id: oid, row_version, ...rest } = i;
    return tx(async (c) => {
      const cur0 = (await c.query('SELECT * FROM svc_offerings WHERE id=$1 FOR UPDATE', [oid])).rows[0];
      if (!cur0) throw notFound('Offering');
      await supplierAccess(user, cur0.profile_id, ['owner', 'sales'], c);
      const merged = { ...cur0, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
      merged.rate_minor = merged.rate_minor === null ? undefined : Number(merged.rate_minor);
      merged.specs = await checkOffer(merged);
      const keys = Object.keys(rest).filter((k) => rest[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to change');
      if (keys.includes('specs')) rest.specs = merged.specs;
      const set = keys.map((k, n) => `${k}=$${n + 3}`).join(', ');
      const r = (await c.query(`UPDATE svc_offerings SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [oid, row_version, ...keys.map((k) => (k === 'media' ? JSON.stringify(rest[k]) : rest[k]))])).rows[0];
      if (!r) throw conflict('This offering changed since you opened it — reload and try again');
      return r;
    });
  },
});
cap({
  name: 'list_service_offerings', method: 'GET', path: '/service-offerings', tag: TAG, auth: 'public',
  summary: 'Browse active offerings by category, mode, supplier. Suspended suppliers are hidden.',
  input: z.object({ category: z.string().optional(), mode: z.enum(['service', 'goods', 'mixed']).optional(), profile_id: id.optional(), q: z.string().max(80).optional(), ...page }),
  handler: (_, i) => many(
    `SELECT o.*, coalesce(p.trading_name, p.legal_name) AS supplier_name FROM svc_offerings o JOIN svc_profiles p ON p.id=o.profile_id
      WHERE o.status='active' AND p.status='active' AND ($1::text IS NULL OR o.category=$1) AND ($2::text IS NULL OR o.mode=$2) AND ($3::uuid IS NULL OR o.profile_id=$3) AND ($4::text IS NULL OR o.title ILIKE '%'||$4||'%')
      ORDER BY o.created_at DESC, o.id LIMIT $5 OFFSET $6`, [i.category ?? null, i.mode ?? null, i.profile_id ?? null, i.q ?? null, i.limit, i.offset]),
});
cap({
  name: 'list_my_service_offerings', method: 'GET', path: '/supplier-profiles/:id/offerings', tag: TAG, summary: 'All offerings of your supplier, including drafts and archived.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) { await supplierAccess(user, i.id, null); return many('SELECT * FROM svc_offerings WHERE profile_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]); },
});

// ---------------------------------------------------------------- blackout days
cap({
  name: 'set_supplier_blackout', method: 'POST', path: '/supplier-profiles/:id/blackouts', tag: TAG, status: 201,
  summary: 'Mark a day the supplier cannot work (capacity checks respect it).',
  input: z.object({ id, day, reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    await supplierAccess(user, i.id, ['owner', 'scheduler']);
    return one('INSERT INTO svc_blackouts(profile_id, day, reason) VALUES ($1,$2,$3) ON CONFLICT (profile_id, day) DO UPDATE SET reason=EXCLUDED.reason RETURNING *', [i.id, i.day, i.reason ?? null]);
  },
});
