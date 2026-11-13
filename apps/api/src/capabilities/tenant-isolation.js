// Multi-role tenant isolation security console (issue #1129).
// Platform-admin-only: access-denied telemetry, permission matrix, revocation log, isolation summary.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { query } from '../db.js';
import { verifyAuditChain } from '../audit-chain.js';

const TAG = 'Security — Tenant Isolation';

// ── Canonical permission matrix ──────────────────────────────────────────────────────────────────
// domain × role_key → permission ('allow' | 'deny' | 'conditional' | 'na')
// Every 'deny' entry must have a corresponding negative_test name used by the CI suite.
const MATRIX = [
  // own_profile_pii
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'athlete',       permission: 'allow',       condition: null,                                  negative_test: null },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'guardian',      permission: 'conditional', condition: 'has_active_guardian_link',             negative_test: 'iso.guardian.cannot_read_pii_without_link' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'coach',         permission: 'deny',        condition: null,                                  negative_test: 'iso.coach.cannot_read_athlete_pii' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'referee',       permission: 'deny',        condition: null,                                  negative_test: 'iso.referee.cannot_read_athlete_pii' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'physio',        permission: 'conditional', condition: 'has_active_medical_grant',             negative_test: 'iso.physio.cannot_read_pii_without_grant' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'academy_admin', permission: 'deny',        condition: null,                                  negative_test: 'iso.academy_admin.cannot_read_athlete_pii' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'org_owner',     permission: 'deny',        condition: null,                                  negative_test: 'iso.org_owner.cannot_read_athlete_pii' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'sponsor_rep',   permission: 'deny',        condition: null,                                  negative_test: 'iso.sponsor_rep.cannot_read_athlete_pii' },
  { domain: 'own_profile_pii', data_owner: 'athlete', role_key: 'platform_admin',permission: 'allow',       condition: null,                                  negative_test: null },

  // clinical_records
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'athlete',        permission: 'allow',       condition: null,                                                 negative_test: null },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'guardian',       permission: 'conditional', condition: 'active_guardian_link_and_minor_athlete',              negative_test: 'iso.guardian.cannot_read_adult_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'coach',          permission: 'deny',        condition: null,                                                 negative_test: 'iso.coach.cannot_read_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'referee',        permission: 'deny',        condition: null,                                                 negative_test: 'iso.referee.cannot_read_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'physio',         permission: 'conditional', condition: 'has_active_verified_medical_grant',                  negative_test: 'iso.physio.cannot_read_clinical_without_grant' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'academy_admin',  permission: 'deny',        condition: null,                                                 negative_test: 'iso.academy_admin.cannot_read_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'org_owner',      permission: 'deny',        condition: null,                                                 negative_test: 'iso.org_owner.cannot_read_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'sponsor_rep',    permission: 'deny',        condition: null,                                                 negative_test: 'iso.sponsor_rep.cannot_read_clinical' },
  { domain: 'clinical_records', data_owner: 'athlete+provider', role_key: 'platform_admin', permission: 'deny',        condition: null,                                                 negative_test: 'iso.platform_admin.cannot_read_clinical_without_grant' },

  // finance_payouts
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'athlete',        permission: 'conditional', condition: 'is_own_payee_account',                negative_test: 'iso.athlete.cannot_read_other_payout' },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'guardian',       permission: 'na',          condition: null,                                  negative_test: null },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'coach',          permission: 'deny',        condition: null,                                  negative_test: 'iso.coach.cannot_read_finance' },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'referee',        permission: 'conditional', condition: 'is_own_payee_account',                negative_test: 'iso.referee.cannot_read_other_payout' },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'physio',         permission: 'deny',        condition: null,                                  negative_test: 'iso.physio.cannot_read_finance' },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'academy_admin',  permission: 'allow',       condition: null,                                  negative_test: null },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'org_owner',      permission: 'allow',       condition: null,                                  negative_test: null },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'sponsor_rep',    permission: 'deny',        condition: null,                                  negative_test: 'iso.sponsor_rep.cannot_read_finance' },
  { domain: 'finance_payouts', data_owner: 'payee_or_finance_role', role_key: 'platform_admin', permission: 'allow',       condition: null,                                  negative_test: null },

  // tax_id_rate_agreements
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'athlete',        permission: 'deny',  condition: null, negative_test: 'iso.athlete.cannot_read_tax_id' },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'guardian',       permission: 'na',    condition: null, negative_test: null },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'coach',          permission: 'deny',  condition: null, negative_test: 'iso.coach.cannot_read_tax_id' },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'referee',        permission: 'deny',  condition: null, negative_test: 'iso.referee.cannot_read_tax_id' },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'physio',         permission: 'deny',  condition: null, negative_test: 'iso.physio.cannot_read_tax_id' },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'academy_admin',  permission: 'allow', condition: null, negative_test: null },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'org_owner',      permission: 'allow', condition: null, negative_test: null },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'sponsor_rep',    permission: 'deny',  condition: null, negative_test: 'iso.sponsor_rep.cannot_read_tax_id' },
  { domain: 'tax_id_rate_agreements', data_owner: 'organisation_finance_role', role_key: 'platform_admin', permission: 'allow', condition: null, negative_test: null },

  // sponsor_campaigns
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'athlete',        permission: 'na',    condition: null,                             negative_test: null },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'guardian',       permission: 'na',    condition: null,                             negative_test: null },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'coach',          permission: 'deny',  condition: null,                             negative_test: 'iso.coach.cannot_read_sponsor_campaigns' },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'referee',        permission: 'deny',  condition: null,                             negative_test: 'iso.referee.cannot_read_sponsor_campaigns' },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'physio',         permission: 'deny',  condition: null,                             negative_test: 'iso.physio.cannot_read_sponsor_campaigns' },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'academy_admin',  permission: 'deny',  condition: null,                             negative_test: 'iso.academy_admin.cannot_read_sponsor_campaigns' },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'org_owner',      permission: 'deny',  condition: null,                             negative_test: 'iso.org_owner.cannot_read_other_sponsor_campaigns' },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'sponsor_rep',    permission: 'allow', condition: null,                             negative_test: null },
  { domain: 'sponsor_campaigns', data_owner: 'sponsor_org_members', role_key: 'platform_admin', permission: 'allow', condition: null,                             negative_test: null },

  // academy_roster
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'athlete',        permission: 'deny',        condition: null,                                negative_test: 'iso.athlete.cannot_list_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'guardian',       permission: 'deny',        condition: null,                                negative_test: 'iso.guardian.cannot_list_other_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'coach',          permission: 'allow',       condition: null,                                negative_test: null },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'referee',        permission: 'deny',        condition: null,                                negative_test: 'iso.referee.cannot_read_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'physio',         permission: 'deny',        condition: null,                                negative_test: 'iso.physio.cannot_read_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'academy_admin',  permission: 'allow',       condition: null,                                negative_test: null },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'org_owner',      permission: 'conditional', condition: 'is_parent_organisation_owner',       negative_test: 'iso.org_owner.cannot_read_unrelated_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'sponsor_rep',    permission: 'deny',        condition: null,                                negative_test: 'iso.sponsor_rep.cannot_read_academy_roster' },
  { domain: 'academy_roster', data_owner: 'academy_admin_or_coach', role_key: 'platform_admin', permission: 'allow',       condition: null,                                negative_test: null },

  // official_incidents
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'athlete',        permission: 'na',          condition: null,                                     negative_test: null },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'guardian',       permission: 'na',          condition: null,                                     negative_test: null },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'coach',          permission: 'deny',        condition: null,                                     negative_test: 'iso.coach.cannot_read_official_incidents' },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'referee',        permission: 'allow',       condition: null,                                     negative_test: null },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'physio',         permission: 'deny',        condition: null,                                     negative_test: 'iso.physio.cannot_read_official_incidents' },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'academy_admin',  permission: 'deny',        condition: null,                                     negative_test: 'iso.academy_admin.cannot_read_official_incidents' },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'org_owner',      permission: 'conditional', condition: 'is_fixture_host_organisation_owner',     negative_test: 'iso.org_owner.cannot_read_unrelated_incident' },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'sponsor_rep',    permission: 'deny',        condition: null,                                     negative_test: 'iso.sponsor_rep.cannot_read_official_incidents' },
  { domain: 'official_incidents', data_owner: 'referee_and_fixture_org', role_key: 'platform_admin', permission: 'allow',       condition: null,                                     negative_test: null },

  // youth_guardian_records
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'athlete',        permission: 'allow',       condition: 'own_records_only',                           negative_test: 'iso.athlete.cannot_read_other_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'guardian',       permission: 'allow',       condition: null,                                         negative_test: null },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'coach',          permission: 'deny',        condition: null,                                         negative_test: 'iso.coach.cannot_read_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'referee',        permission: 'deny',        condition: null,                                         negative_test: 'iso.referee.cannot_read_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'physio',         permission: 'deny',        condition: null,                                         negative_test: 'iso.physio.cannot_read_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'academy_admin',  permission: 'conditional', condition: 'athlete_enrolled_and_guardian_consent_given', negative_test: 'iso.academy_admin.cannot_read_youth_without_consent' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'org_owner',      permission: 'deny',        condition: null,                                         negative_test: 'iso.org_owner.cannot_read_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'sponsor_rep',    permission: 'deny',        condition: null,                                         negative_test: 'iso.sponsor_rep.cannot_read_youth_records' },
  { domain: 'youth_guardian_records', data_owner: 'guardian_minor_org', role_key: 'platform_admin', permission: 'allow',       condition: null,                                         negative_test: null },

  // private_files_evidence
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'athlete',        permission: 'allow',       condition: 'own_files_only',                negative_test: 'iso.athlete.cannot_download_other_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'guardian',       permission: 'conditional', condition: 'has_active_guardian_link',       negative_test: 'iso.guardian.cannot_download_unlinked_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'coach',          permission: 'conditional', condition: 'is_org_member_of_file_owner',    negative_test: 'iso.coach.cannot_download_unrelated_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'referee',        permission: 'conditional', condition: 'is_assigned_to_fixture',         negative_test: 'iso.referee.cannot_download_unassigned_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'physio',         permission: 'conditional', condition: 'has_active_medical_grant',       negative_test: 'iso.physio.cannot_download_evidence_without_grant' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'academy_admin',  permission: 'allow',       condition: 'scoped_to_own_org',             negative_test: 'iso.academy_admin.cannot_download_other_org_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'org_owner',      permission: 'allow',       condition: 'scoped_to_own_org',             negative_test: 'iso.org_owner.cannot_download_other_org_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'sponsor_rep',    permission: 'conditional', condition: 'related_to_active_campaign',     negative_test: 'iso.sponsor_rep.cannot_download_unrelated_evidence' },
  { domain: 'private_files_evidence', data_owner: 'resource_owner_and_verifier', role_key: 'platform_admin', permission: 'allow',       condition: null,                            negative_test: null },

  // mcp_ai_calls — same effective policy as first-party REST
  ...['athlete','guardian','coach','referee','physio','academy_admin','org_owner','sponsor_rep','platform_admin'].map((role_key) => ({
    domain: 'mcp_ai_calls',
    data_owner: 'same_as_rest_policy',
    role_key,
    permission: 'conditional',
    condition: 'same_effective_authorisation_as_rest_api — no prompt bypass, no cross-tenant retrieval',
    negative_test: `iso.mcp.${role_key}.cannot_bypass_rest_authz`,
  })),
];

// ── Capabilities ─────────────────────────────────────────────────────────────────────────────────

cap({
  name: 'get_tenant_isolation_summary',
  method: 'GET', path: '/security/tenant-isolation-summary',
  tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Dashboard summary: access-denied counts, IDOR attempts, revocations, audit chain status.',
  async handler() {
    const [denied, idor, boundary, revocations, matrix] = await Promise.all([
      one("SELECT count(*)::int AS n FROM access_denied_events WHERE at > now() - interval '24 hours'"),
      one("SELECT count(*)::int AS n FROM access_denied_events WHERE severity='high' AND error_code='not_found' AND at > now() - interval '24 hours'"),
      one("SELECT count(*)::int AS n FROM access_denied_events WHERE block_reason LIKE '%Role boundary%' AND at > now() - interval '24 hours'"),
      one("SELECT count(*)::int AS n FROM revocation_propagation_log WHERE at > now() - interval '24 hours'"),
      one('SELECT count(*)::int AS n, max(last_tested_at) AS last_tested_at FROM permission_matrix_entries'),
    ]);
    let auditChainOk = false;
    try { const r = await verifyAuditChain(); auditChainOk = r.first_break == null; } catch { auditChainOk = false; }
    return {
      total_access_denied_24h: denied?.n ?? 0,
      idor_attempts_24h: idor?.n ?? 0,
      role_boundary_blocks_24h: boundary?.n ?? 0,
      revocations_24h: revocations?.n ?? 0,
      audit_chain_verified: auditChainOk,
      matrix_entries_count: matrix?.n ?? 0,
      matrix_last_tested_at: matrix?.last_tested_at ?? null,
    };
  },
});

cap({
  name: 'get_access_denied_events',
  method: 'GET', path: '/security/access-denied-events',
  tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Paginated list of access-denied events with IDOR, role-boundary and cross-tenant blocks.',
  input: z.object({
    ...page,
    severity: z.enum(['low','medium','high','critical']).optional(),
    error_code: z.string().max(50).optional(),
    actor_id: z.string().uuid().optional(),
    capability: z.string().max(100).optional(),
    mcp_only: z.coerce.boolean().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  async handler(_, i) {
    const wheres = [];
    const params = [];
    const p = () => { params.push(null); return `$${params.length}`; };
    const push = (v) => { params.push(v); return `$${params.length}`; };
    if (i.severity)   wheres.push(`severity = ${push(i.severity)}`);
    if (i.error_code) wheres.push(`error_code = ${push(i.error_code)}`);
    if (i.actor_id)   wheres.push(`actor_id = ${push(i.actor_id)}`);
    if (i.capability) wheres.push(`capability = ${push(i.capability)}`);
    if (i.mcp_only)   wheres.push('mcp_call = true');
    if (i.from)       wheres.push(`at >= ${push(i.from)}`);
    if (i.to)         wheres.push(`at <= ${push(i.to)}`);
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = await many(
      `SELECT id, at, actor_id, active_role, acting_org_id, error_code, http_status,
              capability, method, path, attempted_entity, attempted_id,
              block_reason, ip_hash, user_agent_summary, mcp_call, severity
         FROM access_denied_events ${where}
        ORDER BY at DESC LIMIT ${push(i.limit)} OFFSET ${push(i.offset)}`,
      params,
    );
    const total = (await one(`SELECT count(*)::int AS n FROM access_denied_events ${where}`, params.slice(0, -2)))?.n ?? 0;
    return { items: rows, total, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_permission_matrix',
  method: 'GET', path: '/security/permission-matrix',
  tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Full role × domain permission matrix with tested negative cases and data owners.',
  async handler() {
    const rows = await many('SELECT * FROM permission_matrix_entries ORDER BY domain, role_key');
    return { items: rows, count: rows.length };
  },
});

cap({
  name: 'seed_permission_matrix',
  method: 'POST', path: '/security/permission-matrix/seed',
  tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Upsert the canonical permission matrix. Safe to call repeatedly (idempotent).',
  async handler() {
    let upserted = 0;
    for (const e of MATRIX) {
      await query(
        `INSERT INTO permission_matrix_entries (domain, data_owner, role_key, permission, condition, negative_test, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (domain, role_key) DO UPDATE SET
           data_owner    = EXCLUDED.data_owner,
           permission    = EXCLUDED.permission,
           condition     = EXCLUDED.condition,
           negative_test = EXCLUDED.negative_test,
           updated_at    = now()`,
        [e.domain, e.data_owner, e.role_key, e.permission, e.condition ?? null, e.negative_test ?? null],
      );
      upserted++;
    }
    return { upserted, total: MATRIX.length };
  },
});

cap({
  name: 'get_revocation_log',
  method: 'GET', path: '/security/revocation-log',
  tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Revocation propagation log: what sessions, notifications, URLs and cache were cleared per membership removal.',
  input: z.object({
    ...page,
    user_id: z.string().uuid().optional(),
    org_id:  z.string().uuid().optional(),
    from:    z.string().datetime().optional(),
    to:      z.string().datetime().optional(),
  }),
  async handler(_, i) {
    const wheres = [];
    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };
    if (i.user_id) wheres.push(`user_id = ${push(i.user_id)}`);
    if (i.org_id)  wheres.push(`org_id = ${push(i.org_id)}`);
    if (i.from)    wheres.push(`at >= ${push(i.from)}`);
    if (i.to)      wheres.push(`at <= ${push(i.to)}`);
    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const rows = await many(
      `SELECT id, at, user_id, org_id, revoked_by, reason,
              sessions_invalidated, notifications_cancelled, signed_urls_expired,
              cache_keys_cleared, deep_links_revoked
         FROM revocation_propagation_log ${where}
        ORDER BY at DESC LIMIT ${push(i.limit)} OFFSET ${push(i.offset)}`,
      params,
    );
    const total = (await one(`SELECT count(*)::int AS n FROM revocation_propagation_log ${where}`, params.slice(0, -2)))?.n ?? 0;
    return { items: rows, total, limit: i.limit, offset: i.offset };
  },
});

export { MATRIX };
