// Data-residency control plane (#961): country-aware region assignment, Singapore fallback consent,
// migration requests, and platform-admin region activation/audit.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'Data Residency';
const POLICY_VERSION = 1;

// canonical text shown to a user before they consent to Singapore storage; hash is recorded in residency_consents
const SG_POLICY_TEXT = `GotMyGame will store and process your personal data in AWS Singapore (ap-southeast-1). Singapore PDPA applies. You may withdraw consent at any time from Account → Data Residency, which will pause your account pending migration to a supported region. Data categories: profile & identity, sport records, device & session, payment references. Purposes: platform access, event management, results & rankings, communications, support & safety.`;
const policyHash = () => createHash('sha256').update(`v${POLICY_VERSION}:${SG_POLICY_TEXT}`).digest('hex').slice(0, 16);
const policyInfo = () => ({ policy_text: SG_POLICY_TEXT, policy_version: POLICY_VERSION, policy_text_hash: policyHash() });

// ---- public: list all provisioned+healthy+approved regions
cap({
  name: 'list_supported_data_regions',
  method: 'GET', path: '/data-residency/regions', tag: TAG,
  auth: 'public',
  summary: 'List all data regions that are provisioned, healthy and policy-approved. Use to populate country pickers and validate home_country selections.',
  handler: async () => {
    const rows = await many(`SELECT country_code, aws_region, display_name, policy_version, effective_at
      FROM residency_region_catalog
      WHERE is_provisioned AND is_healthy AND is_policy_approved AND retired_at IS NULL
      ORDER BY country_code`);
    return { regions: rows };
  },
});

// ---- preview: given a country code, what region would be assigned and is SG fallback needed?
cap({
  name: 'preview_residency_placement',
  method: 'GET', path: '/data-residency/preview', tag: TAG,
  summary: 'Given a home country, return the region assignment that would be made. Returns supported_region if an in-country region is active, or fallback_required:true if Singapore consent is needed.',
  input: z.object({ country: z.string().length(2).toUpperCase() }),
  async handler(_ctx, { country }) {
    const row = await one(`SELECT aws_region, display_name, is_provisioned, is_healthy, is_policy_approved
      FROM residency_region_catalog WHERE country_code = $1 AND retired_at IS NULL ORDER BY effective_at DESC LIMIT 1`, [country]);
    if (!row) return { country, supported: false, fallback_required: true, fallback_region: 'ap-southeast-1', fallback_display: 'Singapore', ...policyInfo() };
    if (row.is_provisioned && row.is_healthy && row.is_policy_approved)
      return { country, supported: true, region: row.aws_region, display_name: row.display_name, fallback_required: false, ...policyInfo() };
    return { country, supported: false, fallback_required: true, fallback_region: 'ap-southeast-1', fallback_display: 'Singapore', ...policyInfo() };
  },
});

// ---- my residency: current assignment + consent history
cap({
  name: 'get_my_data_residency',
  method: 'GET', path: '/data-residency/me', tag: TAG,
  summary: 'Return the calling user\'s current residency assignment, consent history, active migration request (if any), and the home_country on their profile.',
  async handler({ user }) {
    const assignment = await one('SELECT * FROM residency_assignments WHERE subject_kind=$1 AND subject_id=$2', ['user', user.id]);
    const consents = await many('SELECT id, source_country, destination_region, purposes, affirmative, policy_version, decided_at, revoked_at FROM residency_consents WHERE subject_id=$1 ORDER BY decided_at DESC', [user.id]);
    const transfer = await one('SELECT id, from_region, to_region, transfer_state, requested_at FROM residency_transfers WHERE subject_id=$1 AND transfer_state NOT IN ($2,$3,$4) ORDER BY requested_at DESC LIMIT 1', [user.id, 'verified_complete', 'blocked', 'rolled_back']);
    const profile = await one('SELECT home_country FROM users WHERE id=$1', [user.id]);
    return { home_country: profile.home_country, assignment: assignment ?? null, consents, active_transfer: transfer ?? null };
  },
});

// ---- Singapore fallback consent
cap({
  name: 'grant_singapore_fallback_consent',
  method: 'POST', path: '/data-residency/consent/singapore', tag: TAG,
  summary: 'Record the user\'s affirmative consent to Singapore (ap-southeast-1) fallback storage. The policy_version and policy_text_hash in the request must match the current server-side policy, or 409 is returned. Creates a residency_assignment if one does not exist.',
  input: z.object({
    source_country: z.string().length(2).toUpperCase(),
    policy_version: z.number().int().min(1),
    policy_text_hash: z.string().min(8),
    data_categories: z.array(z.string()).min(1),
    purposes: z.array(z.string()).min(1),
    guardian_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (i.policy_version !== POLICY_VERSION) throw conflict('Policy has been updated — please reload and review the current consent text before agreeing');
    if (i.policy_text_hash !== policyHash()) throw conflict('Policy text hash mismatch — please reload and review the current consent text before agreeing');
    return tx(async (c) => {
      await c.query('INSERT INTO residency_consents(subject_id,guardian_id,source_country,destination_region,purposes,affirmative,policy_version,policy_text_hash,data_categories) VALUES($1,$2,$3,$4,$5,true,$6,$7,$8)',
        [user.id, i.guardian_id ?? null, i.source_country, 'ap-southeast-1', i.purposes, i.policy_version, i.policy_text_hash, i.data_categories]);
      const existing = await c.query('SELECT id FROM residency_assignments WHERE subject_kind=$1 AND subject_id=$2', ['user', user.id]);
      if (!existing.rows.length) {
        await c.query('INSERT INTO residency_assignments(subject_kind,subject_id,home_region,jurisdiction,legal_basis,transfer_basis) VALUES($1,$2,$3,$4,$5,$6)',
          ['user', user.id, 'ap-southeast-1', i.source_country, 'consent', 'Singapore PDPA Transfer Limitation Obligation — explicit consent']);
      }
      await c.query('UPDATE users SET home_country=$1 WHERE id=$2', [i.source_country, user.id]);
      return { consented: true, region: 'ap-southeast-1', policy_version: i.policy_version };
    });
  },
});

// ---- withdraw Singapore fallback consent
cap({
  name: 'withdraw_fallback_consent',
  method: 'DELETE', path: '/data-residency/consent/singapore', tag: TAG,
  summary: 'Withdraw Singapore fallback consent. Records revocation with reason. The residency_assignment lifecycle_status is set to migration_pending — account operations continue while a migration is arranged.',
  input: z.object({ reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const consent = await c.query('SELECT id FROM residency_consents WHERE subject_id=$1 AND destination_region=$2 AND affirmative=true AND revoked_at IS NULL ORDER BY decided_at DESC LIMIT 1', [user.id, 'ap-southeast-1']);
      if (!consent.rows.length) throw notFound('active Singapore consent');
      await c.query('UPDATE residency_consents SET revoked_at=now(), revocation_reason=$1 WHERE id=$2', [i.reason ?? null, consent.rows[0].id]);
      await c.query("UPDATE residency_assignments SET lifecycle_status='migration_pending' WHERE subject_kind='user' AND subject_id=$1", [user.id]);
      return { revoked: true, lifecycle_status: 'migration_pending' };
    });
  },
});

// ---- request region migration
cap({
  name: 'request_data_region_move',
  method: 'POST', path: '/data-residency/migration', tag: TAG,
  summary: 'Submit a request to migrate personal data from the current region to a new one. The destination must be provisioned, healthy and policy-approved for the user\'s jurisdiction. Creates a residency_transfer in state "requested".',
  input: z.object({ to_region: z.string().min(5).max(30) }),
  async handler({ user }, i) {
    const assignment = await one('SELECT * FROM residency_assignments WHERE subject_kind=$1 AND subject_id=$2', ['user', user.id]);
    if (!assignment) throw badRequest('No residency assignment found — complete onboarding first');
    if (assignment.home_region === i.to_region) throw conflict('Already in the requested region');
    const dest = await one('SELECT * FROM residency_region_catalog WHERE aws_region=$1 AND country_code=$2 AND is_provisioned AND is_healthy AND is_policy_approved AND retired_at IS NULL', [i.to_region, assignment.jurisdiction]);
    if (!dest) throw badRequest('Destination region is not provisioned, healthy and approved for your jurisdiction');
    const existing = await one("SELECT id FROM residency_transfers WHERE subject_id=$1 AND transfer_state NOT IN ('verified_complete','blocked','rolled_back')", [user.id]);
    if (existing) throw conflict('A migration is already in progress');
    const row = await one('INSERT INTO residency_transfers(subject_id,from_region,to_region,legal_basis) VALUES($1,$2,$3,$4) RETURNING id,transfer_state,requested_at',
      [user.id, assignment.home_region, i.to_region, 'user_request']);
    return { transfer_id: row.id, state: row.transfer_state, from_region: assignment.home_region, to_region: i.to_region, requested_at: row.requested_at };
  },
});

// ---- poll migration status
cap({
  name: 'get_region_move_status',
  method: 'GET', path: '/data-residency/migration/:transfer_id', tag: TAG,
  summary: 'Get the current state of a region migration request. Only the subject user may read it.',
  input: z.object({ transfer_id: id }),
  async handler({ user }, i) {
    const row = await one('SELECT * FROM residency_transfers WHERE id=$1', [i.transfer_id]);
    if (!row) throw notFound('transfer');
    if (row.subject_id !== user.id && !isAdmin(user)) throw notFound('transfer');
    return row;
  },
});

// ---- admin: get region policy for a country
cap({
  name: 'get_region_policy',
  method: 'GET', path: '/data-residency/admin/policy/:country_code', tag: TAG,
  summary: 'Platform admin: read the full residency policy entry for a country.',
  input: z.object({ country_code: z.string().length(2).toUpperCase() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const rows = await many('SELECT * FROM residency_region_catalog WHERE country_code=$1 ORDER BY effective_at DESC', [i.country_code]);
    if (!rows.length) throw notFound('country policy');
    return { country_code: i.country_code, entries: rows };
  },
});

// ---- admin: activate a region
cap({
  name: 'approve_region_activation',
  method: 'POST', path: '/data-residency/admin/regions/:region_id/activate', tag: TAG,
  summary: 'Platform admin: mark a residency_region_catalog entry as provisioned, healthy and policy-approved. Use after the AWS infrastructure is confirmed live and legal review is complete.',
  input: z.object({
    region_id: id,
    policy_version: z.number().int().min(1).optional(),
    notes: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const row = await one('UPDATE residency_region_catalog SET is_provisioned=true, is_healthy=true, is_policy_approved=true, policy_version=COALESCE($2,policy_version), notes=COALESCE($3,notes) WHERE id=$1 RETURNING *',
      [i.region_id, i.policy_version ?? null, i.notes ?? null]);
    if (!row) throw notFound('region catalog entry');
    await audit(null, user.id, 'activate_region', 'residency_region_catalog', i.region_id);
    return { activated: true, region: row };
  },
});

// ---- admin: audit residency assignments
cap({
  name: 'audit_residency_assignments',
  method: 'GET', path: '/data-residency/admin/audit', tag: TAG,
  summary: 'Platform admin: paginated view of residency assignments and consent events. This read is itself audit-logged.',
  input: z.object({ ...page, subject_kind: z.enum(['user','org','minor','venue','event']).optional() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    await audit(null, user.id, 'read_residency_assignments', 'residency_assignments', null);
    const { limit = 50, offset = 0 } = i;
    const rows = await many(
      `SELECT ra.*, u.handle FROM residency_assignments ra LEFT JOIN users u ON u.id=ra.subject_id
       WHERE ($1::text IS NULL OR ra.subject_kind=$1)
       ORDER BY ra.assigned_at DESC LIMIT $2 OFFSET $3`,
      [i.subject_kind ?? null, limit, offset]);
    const total = (await one(`SELECT count(*)::int AS n FROM residency_assignments WHERE ($1::text IS NULL OR subject_kind=$1)`, [i.subject_kind ?? null])).n;
    return { total, offset, rows };
  },
});

// ---- admin: compliance export
cap({
  name: 'export_region_compliance',
  method: 'GET', path: '/data-residency/admin/compliance-export', tag: TAG,
  summary: 'Platform admin: export a compliance summary — all assignments, consents, and active migrations, with counts by region, jurisdiction and consent status. Audit-logged.',
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    await audit(null, user.id, 'export_region_compliance', 'residency_region_catalog', null);
    const byRegion = await many(`SELECT home_region, jurisdiction, lifecycle_status, count(*)::int AS subjects FROM residency_assignments GROUP BY home_region, jurisdiction, lifecycle_status ORDER BY home_region, jurisdiction`);
    const consentSummary = await many(`SELECT destination_region, source_country, affirmative, count(*)::int AS n, count(revoked_at)::int AS revoked FROM residency_consents GROUP BY destination_region, source_country, affirmative ORDER BY destination_region, source_country`);
    const activeMigrations = await many(`SELECT transfer_state, count(*)::int AS n FROM residency_transfers WHERE transfer_state NOT IN ('verified_complete','blocked','rolled_back') GROUP BY transfer_state`);
    return { generated_at: new Date(), by_region: byRegion, consent_summary: consentSummary, active_migrations: activeMigrations };
  },
});

// ---- set home country on own profile (called during onboarding; triggers residency preview)
cap({
  name: 'set_home_country',
  method: 'PATCH', path: '/me/home-country', tag: TAG,
  summary: 'Set or update the user\'s home country (ISO 3166-1 alpha-2). Does not create a residency_assignment — call grant_singapore_fallback_consent or the response from preview_residency_placement governs that. Country changes after assignment are not automatically applied; a migration must be requested.',
  input: z.object({ home_country: z.string().length(2).toUpperCase() }),
  async handler({ user }, i) {
    await one('UPDATE users SET home_country=$1 WHERE id=$2', [i.home_country, user.id]);
    return { home_country: i.home_country };
  },
});

// ---- list all regions (provisioned and not) for admin; public endpoint returns only provisioned+healthy+approved
cap({
  name: 'list_all_data_regions',
  method: 'GET', path: '/data-residency/admin/regions', tag: TAG,
  summary: 'Platform admin: list all residency_region_catalog entries including unprovisioned and suspended regions, with full status fields.',
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    const rows = await many(`SELECT id, country_code, aws_region, display_name, is_provisioned, is_healthy, is_policy_approved, policy_version, effective_at, retired_at, notes
      FROM residency_region_catalog WHERE retired_at IS NULL ORDER BY country_code, effective_at DESC`);
    return { regions: rows };
  },
});

// ---- admin: suspend a region (sets is_healthy=false to prevent new placements)
cap({
  name: 'suspend_region',
  method: 'POST', path: '/data-residency/admin/regions/:region_id/suspend', tag: TAG,
  summary: 'Platform admin: suspend a region — sets is_healthy=false so no new assignments are made to it. Existing assignments are not moved.',
  input: z.object({ region_id: id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const row = await one('UPDATE residency_region_catalog SET is_healthy=false, notes=COALESCE($2,notes) WHERE id=$1 RETURNING *',
      [i.region_id, i.reason ?? null]);
    if (!row) throw notFound('region catalog entry');
    await audit(null, user.id, 'suspend_region', 'residency_region_catalog', i.region_id);
    return { suspended: true, region: row };
  },
});

// ---- org residency: return org's current assignment + member consent summary
cap({
  name: 'get_org_data_residency',
  method: 'GET', path: '/data-residency/org/:org_id', tag: TAG,
  summary: 'Return an organisation\'s current residency assignment and an aggregate member consent summary. Requires org admin role.',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    const membership = await one('SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND left_at IS NULL', [i.org_id, user.id]);
    if (!membership && !isAdmin(user)) throw notFound('organisation');
    if (!['admin', 'owner'].includes(membership?.role) && !isAdmin(user)) throw notFound('organisation');
    const assignment = await one("SELECT * FROM residency_assignments WHERE subject_kind='org' AND subject_id=$1", [i.org_id]);
    const org = await one('SELECT id, name, country FROM orgs WHERE id=$1', [i.org_id]);
    if (!org) throw notFound('organisation');
    const memberSummary = await one(`
      SELECT
        count(*) FILTER (WHERE ra.id IS NOT NULL AND ra.lifecycle_status='active') AS consented,
        count(*) FILTER (WHERE ra.id IS NULL) AS pending,
        count(*) FILTER (WHERE om.role IS NOT NULL AND u.birth_date IS NOT NULL AND date_part('year',age(u.birth_date)) < 16) AS youth_total
      FROM org_members om
      JOIN users u ON u.id = om.user_id
      LEFT JOIN residency_assignments ra ON ra.subject_kind='user' AND ra.subject_id=u.id
      WHERE om.org_id=$1 AND om.left_at IS NULL`, [i.org_id]);
    return { org: { id: org.id, name: org.name, country: org.country }, assignment: assignment ?? null, member_summary: memberSummary };
  },
});

// ---- waitlist: record notification preference for when a region becomes available
cap({
  name: 'join_region_waitlist',
  method: 'POST', path: '/data-residency/waitlist', tag: TAG,
  summary: 'Record that the user wants to be notified when a local data region becomes available for their home country. Stores only the user\'s preference — no personal data transfer occurs.',
  input: z.object({ country: z.string().length(2).toUpperCase() }),
  async handler({ user }, i) {
    await one(`INSERT INTO residency_consents(subject_id, source_country, destination_region, purposes, affirmative, policy_version, policy_text_hash, data_categories)
      VALUES($1,$2,'waitlist',ARRAY['notification'],false,$3,$4,ARRAY['none'])
      ON CONFLICT DO NOTHING RETURNING id`,
      [user.id, i.country, POLICY_VERSION, policyHash()]);
    return { waitlisted: true, country: i.country };
  },
});
