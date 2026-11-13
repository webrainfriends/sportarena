// Federation Data Exchange Governance (#525)
// Approved inbound/outbound exchange profiles, field-scope validation,
// immutable run log, reconciliation, and four-eyes gate for personal outbound.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { authority, need, logFed } from '../federation.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);

// ---- field-scope allow-lists (prevents arbitrary column references) -----------
const ALLOWED_AFF_FIELDS = new Set(['id','body_id','club_name','sport_id','status','tier',
  'approved_at','expires_on','season_year','region','country_code']);
const ALLOWED_LIC_FIELDS = new Set(['id','body_id','holder_type','sport_id','status',
  'licence_class','approved_at','expires_on','season_year']);

function validateScope(scope) {
  if (!scope || typeof scope !== 'object') return;
  const bad = [
    ...(scope.affiliations ?? []).filter((f) => !ALLOWED_AFF_FIELDS.has(f)),
    ...(scope.licences    ?? []).filter((f) => !ALLOWED_LIC_FIELDS.has(f)),
  ];
  if (bad.length) throw badRequest(`Field scope contains disallowed fields: ${bad.join(', ')}`);
}

function hasPersonalFields(scope) {
  if (!scope) return false;
  const non_id = (arr) => (arr ?? []).some((f) => !['id','body_id','sport_id','status'].includes(f));
  return non_id(scope.affiliations) || non_id(scope.licences);
}

const DIRECTION = z.enum(['inbound','outbound']);
const REC_TYPE  = z.enum(['national_body','government','anti_doping','media','research','insurance','other']);
const FREQUENCY = z.enum(['on_demand','daily','weekly','monthly','annual','triggered']);
const EX_STATUS = z.enum(['active','suspended','archived']);
const RUN_STATUS= z.enum(['running','success','failed','partial']);

// ---- capabilities -------------------------------------------------------------

cap({
  name: 'create_fed_exchange_profile',
  tag: TAG, status: 201,
  summary: 'Create an approved inbound or outbound data-exchange profile for a governing body. Requires admin role.',
  method: 'POST', path: '/federation/bodies/:id/exchange-profiles',
  input: z.object({
    id,
    direction:       DIRECTION,
    name:            text(120).min(2),
    recipient_name:  text(200).min(2),
    recipient_type:  REC_TYPE,
    lawful_purpose:  text(500).min(10),
    field_scope:     z.record(z.string(), z.array(z.string())).default({}),
    includes_youth:  z.boolean().default(false),
    includes_health: z.boolean().default(false),
    frequency:       FREQUENCY,
    approved_by:     text(200).min(2),
    approval_ref:    text(120).optional(),
  }),
  handler: async ({ user }, i) => {
    const auth = await authority(user, i.id);
    need(auth, 'admin');
    validateScope(i.field_scope);
    const r = await pool.query(
      `INSERT INTO fed_exchange_profiles
         (body_id,direction,name,recipient_name,recipient_type,lawful_purpose,field_scope,
          includes_youth,includes_health,frequency,approved_by,approval_ref,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [i.id, i.direction, i.name, i.recipient_name, i.recipient_type, i.lawful_purpose,
       JSON.stringify(i.field_scope), i.includes_youth, i.includes_health, i.frequency,
       i.approved_by, i.approval_ref ?? null, user.id]);
    const profile = r.rows[0];
    await tx(async (c) => {
      await logFed(c, i.id, 'exchange_profile', profile.id, 'created', { actor: user.id, detail: { direction: i.direction, recipient_name: i.recipient_name, frequency: i.frequency } });
      await audit(c, user.id, 'create_fed_exchange_profile', 'fed_exchange_profiles', profile.id);
    });
    return profile;
  },
});

cap({
  name: 'update_fed_exchange_profile',
  tag: TAG,
  summary: 'Update an exchange profile. Requires admin role.',
  method: 'PATCH', path: '/federation/exchange-profiles/:id',
  input: z.object({
    id,
    name:            text(120).min(2).optional(),
    lawful_purpose:  text(500).min(10).optional(),
    field_scope:     z.record(z.string(), z.array(z.string())).optional(),
    includes_youth:  z.boolean().optional(),
    includes_health: z.boolean().optional(),
    frequency:       FREQUENCY.optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!existing) throw notFound('Exchange profile');
    const auth = await authority(user, existing.body_id);
    need(auth, 'admin');
    const updates = {};
    for (const k of ['name','lawful_purpose','includes_youth','includes_health','frequency']) {
      if (i[k] !== undefined) updates[k] = i[k];
    }
    if (i.field_scope !== undefined) {
      validateScope(i.field_scope);
      updates.field_scope = JSON.stringify(i.field_scope);
    }
    if (!Object.keys(updates).length) return existing;
    const cols = Object.keys(updates).map((k, idx) => `${k}=$${idx + 2}`).join(', ');
    const r = await pool.query(
      `UPDATE fed_exchange_profiles SET ${cols} WHERE id=$1 RETURNING *`,
      [i.id, ...Object.values(updates)]);
    await tx(async (c) => {
      await logFed(c, existing.body_id, 'exchange_profile', i.id, 'updated', { actor: user.id, detail: updates });
      await audit(c, user.id, 'update_fed_exchange_profile', 'fed_exchange_profiles', i.id);
    });
    return r.rows[0];
  },
});

cap({
  name: 'suspend_fed_exchange_profile',
  tag: TAG,
  summary: 'Suspend or reactivate an exchange profile. Requires admin role.',
  method: 'POST', path: '/federation/exchange-profiles/:id/suspend',
  input: z.object({
    id,
    action: z.enum(['suspend','reactivate']),
    reason: text(500).optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!existing) throw notFound('Exchange profile');
    const auth = await authority(user, existing.body_id);
    need(auth, 'admin');
    let r;
    if (i.action === 'suspend') {
      r = await pool.query(
        `UPDATE fed_exchange_profiles SET status='suspended', suspended_at=now(), suspended_reason=$2 WHERE id=$1 RETURNING *`,
        [i.id, i.reason ?? null]);
    } else {
      r = await pool.query(
        `UPDATE fed_exchange_profiles SET status='active', suspended_at=null, suspended_reason=null WHERE id=$1 RETURNING *`,
        [i.id]);
    }
    await tx(async (c) => {
      await logFed(c, existing.body_id, 'exchange_profile', i.id, `${i.action}d`, { actor: user.id, detail: { reason: i.reason } });
      await audit(c, user.id, `${i.action}_fed_exchange_profile`, 'fed_exchange_profiles', i.id);
    });
    return r.rows[0];
  },
});

cap({
  name: 'list_fed_exchange_profiles',
  tag: TAG,
  summary: 'List exchange profiles for a governing body. Requires reports or admin role.',
  method: 'GET', path: '/federation/bodies/:id/exchange-profiles',
  input: z.object({
    id,
    direction: DIRECTION.optional(),
    status:    EX_STATUS.optional(),
  }),
  handler: async ({ user }, i) => {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const clauses = ['p.body_id=$1'];
    const params  = [i.id];
    if (i.direction) { params.push(i.direction); clauses.push(`p.direction=$${params.length}`); }
    if (i.status)    { params.push(i.status);    clauses.push(`p.status=$${params.length}`); }
    const rows = await many(
      `SELECT p.*, (SELECT row_to_json(lr) FROM (
         SELECT status, row_count, started_at, finished_at FROM fed_exchange_runs
         WHERE profile_id=p.id ORDER BY started_at DESC LIMIT 1) lr) AS last_run
       FROM fed_exchange_profiles p WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC`,
      params);
    return { profiles: rows };
  },
});

cap({
  name: 'get_fed_exchange_profile',
  tag: TAG,
  summary: 'Get a single exchange profile with its last 20 run summaries. Requires reports or admin role.',
  method: 'GET', path: '/federation/exchange-profiles/:id',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const profile = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!profile) throw notFound('Exchange profile');
    const auth = await authority(user, profile.body_id);
    need(auth, 'reports');
    const runs = await many(
      `SELECT id,direction,status,row_count,error_summary,sha256,started_at,finished_at,
              reconciliation,triggered_by
       FROM fed_exchange_runs WHERE profile_id=$1 ORDER BY started_at DESC LIMIT 20`,
      [i.id]);
    return { profile, runs };
  },
});

cap({
  name: 'record_fed_exchange_run',
  tag: TAG, status: 201,
  summary: 'Record a data-exchange run. Outbound runs with personal fields require a live bulk_export approval. Requires reports role.',
  method: 'POST', path: '/federation/exchange-profiles/:id/runs',
  input: z.object({
    id,
    status:         RUN_STATUS,
    row_count:      z.number().int().min(0).optional(),
    error_summary:  text(500).optional(),
    redactions:     z.record(z.string(), z.any()).default({}),
    sha256:         z.string().optional(),
    finished_at:    z.string().optional(),
    reconciliation: z.record(z.string(), z.any()).default({}),
    approval_id:    id.optional(),
  }),
  handler: async ({ user }, i) => {
    const profile = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!profile) throw notFound('Exchange profile');
    if (profile.status !== 'active') throw conflict('Profile is not active');
    const auth = await authority(user, profile.body_id);
    need(auth, 'reports');

    if (profile.direction === 'outbound' && hasPersonalFields(profile.field_scope)) {
      if (!i.approval_id) throw Object.assign(new Error('Outbound profile with personal data requires a bulk_export approval_id'), { status: 403 });
      const apRow = await pool.query(
        `SELECT id FROM fed_approvals WHERE id=$1 AND body_id=$2 AND action='bulk_export' AND status='approved' AND consumed_at IS NULL`,
        [i.approval_id, profile.body_id]);
      if (!apRow.rows.length) throw Object.assign(new Error('No live bulk_export approval for this body'), { status: 403 });
    }

    const r = await pool.query(
      `INSERT INTO fed_exchange_runs
         (profile_id,body_id,direction,triggered_by,approval_id,status,row_count,
          error_summary,redactions,sha256,finished_at,reconciliation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.id, profile.body_id, profile.direction, user.id, i.approval_id ?? null, i.status,
       i.row_count ?? null, i.error_summary ?? null, JSON.stringify(i.redactions), i.sha256 ?? null,
       i.finished_at ?? null, JSON.stringify(i.reconciliation)]);
    const run = r.rows[0];
    await tx(async (c) => {
      await logFed(c, profile.body_id, 'exchange_run', run.id, 'recorded', { actor: user.id, detail: { direction: profile.direction, status: i.status, row_count: i.row_count } });
      await audit(c, user.id, 'record_fed_exchange_run', 'fed_exchange_runs', run.id);
    });
    return run;
  },
});

cap({
  name: 'list_fed_exchange_runs',
  tag: TAG,
  summary: 'List recent exchange runs for a profile (up to 100). Requires reports role.',
  method: 'GET', path: '/federation/exchange-profiles/:id/runs',
  input: z.object({
    id,
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  handler: async ({ user }, i) => {
    const profile = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!profile) throw notFound('Exchange profile');
    const auth = await authority(user, profile.body_id);
    need(auth, 'reports');
    const runs = await many(
      'SELECT * FROM fed_exchange_runs WHERE profile_id=$1 ORDER BY started_at DESC LIMIT $2',
      [i.id, i.limit]);
    return { runs };
  },
});

cap({
  name: 'get_fed_exchange_reconciliation',
  tag: TAG,
  summary: 'Get aggregated reconciliation statistics for a profile across its last N runs. Requires reports role.',
  method: 'GET', path: '/federation/exchange-profiles/:id/reconciliation',
  input: z.object({
    id,
    runs: z.coerce.number().int().min(1).max(50).default(10),
  }),
  handler: async ({ user }, i) => {
    const profile = (await pool.query('SELECT * FROM fed_exchange_profiles WHERE id=$1', [i.id])).rows[0];
    if (!profile) throw notFound('Exchange profile');
    const auth = await authority(user, profile.body_id);
    need(auth, 'reports');
    const rows = await many(
      `SELECT id, status, row_count, started_at, finished_at, reconciliation
       FROM fed_exchange_runs WHERE profile_id=$1 ORDER BY started_at DESC LIMIT $2`,
      [i.id, i.runs]);
    const totals = rows.reduce((acc, row) => {
      const rec = row.reconciliation || {};
      acc.expected  += rec.expected  ?? 0;
      acc.received  += rec.received  ?? 0;
      acc.matched   += rec.matched   ?? 0;
      acc.unmatched += rec.unmatched ?? 0;
      acc.new_rows  += rec.new_rows  ?? 0;
      acc.rows      += row.row_count ?? 0;
      return acc;
    }, { expected: 0, received: 0, matched: 0, unmatched: 0, new_rows: 0, rows: 0 });
    return { profile_id: i.id, runs_examined: rows.length, totals, runs: rows };
  },
});
