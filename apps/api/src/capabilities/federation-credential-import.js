// Federation credential & disciplinary API reconciliation (#1026 / REF-R28) 1/2: credential import.
// External federation licence records are staged here, matched to platform users through CONFIRMED external_identities
// (never by name), reviewed by a licensing officer, and only then written to fed_licences with full provenance.
// Federations remain the authority for credentials; manually adjudicated records (sync_status='manual') are never
// overwritten without an explicit platform-admin override.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt, decrypt } from '../crypto.js';
import { isPlatform } from '../platform.js';
import { authority, need, bodyById, logFed, nextNumber, today, addMonths, LIC_STATUS } from '../federation.js';
import { hasConsent, isYouth } from '../youth.js';
import { checkEndpoint } from '../access-providers.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const SECRET_CTX = 'fed_credential_connectors.secret';

// ------------------------------------------------------------------ helpers
const connView = (c) => ({ ...c, has_token: !!c.secret_enc, secret_enc: undefined, connection: connStatus(c) });
const connStatus = (c) => {
  if (c.status !== 'approved') return 'not_approved';
  if (c.adapter === 'file_import') return 'file_only';
  if (c.last_sync_status === 'ok') return 'live';
  return c.last_sync_status ?? 'never_synced';
};
const connRow = async (cid, db = pool) => {
  const r = (await db.query('SELECT * FROM fed_credential_connectors WHERE id=$1 AND archived_at IS NULL', [cid])).rows[0];
  return r ? connView(r) : null;
};
const lockConn = async (db, cid) =>
  (await db.query('SELECT * FROM fed_credential_connectors WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [cid])).rows[0];

async function authorisedConn(user, cid, db = pool, { lock = false } = {}) {
  const c = lock ? await lockConn(db, cid) : (await db.query('SELECT * FROM fed_credential_connectors WHERE id=$1 AND archived_at IS NULL', [cid])).rows[0];
  if (!c) throw notFound('Connector');
  // platform admins can manage all; body licensing staff can manage their own
  if (!isPlatform(user)) {
    const auth = await authority(user, c.body_id, { c: db });
    need(auth, 'licences', c.sport_id);
  }
  return lock ? c : connView(c);
}

function mustBeApproved(conn) {
  if (conn.status !== 'approved')
    throw conflict(conn.status === 'suspended' ? 'This connector is suspended' : 'This connector is awaiting platform approval', { code: 'connector_not_approved' });
}

function checkBackoff(conn) {
  if (conn.backoff_until && new Date(conn.backoff_until) > new Date())
    throw conflict(`Sync is in backoff until ${new Date(conn.backoff_until).toISOString()}. The connector encountered repeated failures; wait for the backoff window to pass.`, { code: 'backoff_active' });
}

async function logRecon(db, subjectType, subjectId, action, actorId, detail = null) {
  await db.query(
    'INSERT INTO fed_reconciliation_events(subject_type,subject_id,action,actor_id,detail) VALUES($1,$2,$3,$4,$5)',
    [subjectType, subjectId, action, actorId, detail ? JSON.stringify(detail) : null]);
}

// ------------------------------------------------------------------ connector CRUD
cap({
  name: 'register_federation_connector', method: 'POST', path: '/federation-connectors', tag: TAG, status: 201,
  summary: 'Register an external federation credential connector (platform admin only). Connects a governing body\'s external licence/credential API or file export to the platform. The connector starts pending — the platform team must approve it before any data flows. API connectors require an HTTPS endpoint and bearer token; file connectors accept CSV/JSON uploads.',
  input: z.object({
    body_id: id,
    sport_id: id.optional(),
    name: text(120).min(2),
    holder_role: z.enum(['athlete','coach','official','administrator','other']).default('official'),
    adapter: z.enum(['api_json','api_xml','api_csv','file_import']),
    endpoint_url: z.string().trim().url().max(500).optional(),
    token: z.string().min(8).max(1000).optional(),
    mapping: z.record(z.string().max(60), z.string().max(60)).default({}),
    sync_schedule: text(60).optional(),
    sync_ttl_hours: z.number().int().min(1).max(8760).default(24),
    note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!isPlatform(user)) throw forbidden('Only platform admins register federation connectors');
    if (i.adapter !== 'file_import') {
      if (!i.endpoint_url) throw badRequest('API connectors require an endpoint URL');
      const bad = checkEndpoint(i.endpoint_url);
      if (bad) throw badRequest(bad);
    } else {
      if (i.endpoint_url || i.token) throw badRequest('File import connectors do not use an endpoint URL or token');
    }
    await bodyById(i.body_id, c);
    if (i.sport_id) {
      const ok = (await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.body_id, i.sport_id])).rowCount;
      if (!ok) throw badRequest('That sport is not governed by this body');
    }
    const secretEnc = i.token ? await encrypt(i.token, SECRET_CTX) : null;
    let row;
    try {
      row = (await c.query(
        `INSERT INTO fed_credential_connectors(body_id,sport_id,name,holder_role,adapter,endpoint_url,secret_enc,mapping,sync_schedule,sync_ttl_hours,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [i.body_id, i.sport_id ?? null, i.name, i.holder_role, i.adapter, i.endpoint_url ?? null,
         secretEnc, JSON.stringify(i.mapping), i.sync_schedule ?? null, i.sync_ttl_hours, user.id])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('A connector with that name already exists for this body');
      throw e;
    }
    await logRecon(c, 'connector', row.id, 'registered', user.id, { adapter: i.adapter, body_id: i.body_id, note: i.note });
    await audit(c, user.id, 'register_federation_connector', 'fed_credential_connectors', row.id);
    return connView(row);
  }),
});

cap({
  name: 'decide_federation_connector', method: 'POST', path: '/federation-connectors/:id/decision', tag: TAG,
  summary: 'Approve or suspend a federation credential connector (platform admin only). An approved connector can receive data; a suspended one is immediately blocked.',
  input: z.object({
    id,
    decision: z.enum(['approve','suspend']),
    note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!isPlatform(user)) throw forbidden('Only platform admins decide connectors');
    const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
    if (!conn) throw notFound('Connector');
    if (i.decision === 'approve' && conn.status === 'approved') throw conflict('Already approved');
    const newStatus = i.decision === 'approve' ? 'approved' : 'suspended';
    const row = (await c.query(
      `UPDATE fed_credential_connectors SET status=$2, decided_at=now(), decided_by=$3, decision_note=$4,
              row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, newStatus, user.id, i.note ?? null])).rows[0];
    await logRecon(c, 'connector', i.id, i.decision, user.id, { note: i.note });
    await audit(c, user.id, 'decide_federation_connector', 'fed_credential_connectors', i.id);
    return connView(row);
  }),
});

cap({
  name: 'list_federation_connectors', method: 'GET', path: '/federation-connectors', tag: TAG,
  summary: 'List federation credential connectors. Platform admins see all; federation licensing staff see connectors for their bodies. Includes sync health, staged queue counts and backoff state.',
  input: z.object({ body_id: id.optional(), status: z.enum(['pending','approved','suspended']).optional(), ...page }),
  async handler({ user }, i) {
    const isAdmin = isPlatform(user);
    if (!isAdmin && !i.body_id) throw badRequest('Supply body_id to filter connectors for your federation');
    if (!isAdmin && i.body_id) {
      const auth = await authority(user, i.body_id);
      need(auth, 'licences');
    }
    return many(
      `SELECT c.*, bo.name AS body_name, s.name AS sport_name,
              (SELECT count(*)::int FROM fed_staged_credentials sc WHERE sc.connector_id=c.id AND sc.status IN ('pending','conflict','manual_review')) AS staged_pending,
              (SELECT count(*)::int FROM fed_staged_credentials sc WHERE sc.connector_id=c.id AND sc.status='accepted') AS staged_accepted,
              (SELECT count(*)::int FROM fed_staged_disciplinary sd WHERE sd.connector_id=c.id AND sd.status IN ('pending','conflict','manual_review')) AS disc_pending
         FROM fed_credential_connectors c
         JOIN governing_bodies b ON b.id=c.body_id
         JOIN organisations bo ON bo.id=b.organisation_id
         LEFT JOIN sports s ON s.id=c.sport_id
        WHERE c.archived_at IS NULL
          AND ($1::uuid IS NULL OR c.body_id=$1)
          AND ($2::text IS NULL OR c.status=$2)
          AND ($3 OR c.body_id IN (
            SELECT DISTINCT body_id FROM governing_body_roles WHERE user_id=$4 AND status='active'
            UNION SELECT id FROM governing_bodies WHERE id IN (
              SELECT body_id FROM fed_delegations WHERE user_id=$4 AND status='active' AND (expires_on IS NULL OR expires_on >= current_date)
            )
          ))
        ORDER BY bo.name, c.name LIMIT $5 OFFSET $6`,
      [i.body_id ?? null, i.status ?? null, isAdmin, user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_federation_connector', method: 'GET', path: '/federation-connectors/:id', tag: TAG,
  summary: 'Get a single federation credential connector with full detail: mapping config, sync state, backoff, staged counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const conn = await authorisedConn(user, i.id);
    if (!conn) throw notFound('Connector');
    const [pending, accepted, discPending, recentBatches] = await Promise.all([
      pool.query('SELECT count(*)::int AS n FROM fed_staged_credentials WHERE connector_id=$1 AND status IN (\'pending\',\'conflict\',\'manual_review\')', [i.id]),
      pool.query('SELECT count(*)::int AS n FROM fed_staged_credentials WHERE connector_id=$1 AND status=\'accepted\'', [i.id]),
      pool.query('SELECT count(*)::int AS n FROM fed_staged_disciplinary WHERE connector_id=$1 AND status IN (\'pending\',\'conflict\',\'manual_review\')', [i.id]),
      pool.query('SELECT id,mode,status,total_records,created_count,conflict_count,created_at FROM fed_credential_import_batches WHERE connector_id=$1 ORDER BY created_at DESC LIMIT 5', [i.id]),
    ]);
    return { ...conn, staged_pending: pending.rows[0].n, staged_accepted: accepted.rows[0].n, disc_pending: discPending.rows[0].n, recent_batches: recentBatches.rows };
  },
});

cap({
  name: 'update_federation_connector', method: 'PATCH', path: '/federation-connectors/:id', tag: TAG,
  summary: 'Update connector configuration: mapping, schedule, TTL, name or token. Never changes status (use decide_federation_connector). Re-applying the grade mapping re-stages any pending unknown_grade records in open batches.',
  input: z.object({
    id,
    name: text(120).optional(),
    endpoint_url: z.string().trim().url().max(500).optional(),
    token: z.string().min(8).max(1000).optional().describe('Pass to rotate the API token'),
    mapping: z.record(z.string().max(60), z.string().max(60)).optional(),
    sync_schedule: text(60).nullish(),
    sync_ttl_hours: z.number().int().min(1).max(8760).optional(),
    row_version: z.number().int().min(1),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const conn = await authorisedConn(user, i.id, c, { lock: true });
    if (!conn) throw notFound('Connector');
    if (conn.row_version !== i.row_version)
      throw conflict('Changed elsewhere — reload and try again', { code: 'stale_version', row_version: conn.row_version });
    const secretEnc = i.token ? await encrypt(i.token, SECRET_CTX) : undefined;
    const row = (await c.query(
      `UPDATE fed_credential_connectors SET
         name=COALESCE($2,name), endpoint_url=COALESCE($3,endpoint_url),
         secret_enc=COALESCE($4,secret_enc), mapping=COALESCE($5,mapping),
         sync_schedule=CASE WHEN $6::boolean THEN $7 ELSE sync_schedule END,
         sync_ttl_hours=COALESCE($8,sync_ttl_hours),
         row_version=row_version+1, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.name ?? null, i.endpoint_url ?? null, secretEnc ?? null,
       i.mapping ? JSON.stringify(i.mapping) : null,
       'sync_schedule' in i, i.sync_schedule ?? null, i.sync_ttl_hours ?? null])).rows[0];
    // Re-apply mapping to unknown_grade records if mapping changed
    if (i.mapping) {
      const entries = Object.entries(i.mapping);
      for (const [extGrade, mappedGrade] of entries) {
        await c.query(
          `UPDATE fed_staged_credentials SET mapped_grade=$2, status='matched', conflict_type=NULL, updated_at=now()
           WHERE connector_id=$1 AND external_grade=$3 AND status='pending' AND conflict_type='unknown_grade'`,
          [i.id, mappedGrade, extGrade]);
      }
    }
    await logRecon(c, 'connector', i.id, 'updated', user.id, { fields: Object.keys(i).filter(k => k !== 'id' && k !== 'row_version') });
    await audit(c, user.id, 'update_federation_connector', 'fed_credential_connectors', i.id);
    return connView(row);
  }),
});

// ------------------------------------------------------------------ sync / file upload
cap({
  name: 'trigger_credential_sync', method: 'POST', path: '/federation-connectors/:id/sync', tag: TAG, status: 201,
  summary: 'Trigger a credential sync for a connector: pull from the external API (api_json/xml/csv) or upload a file (file_import). Advisory lock prevents concurrent syncs on the same connector. Backoff is enforced for API connectors. Duplicate file uploads (same SHA-256) return the original batch. Records are staged — no fed_licences are touched until a reviewer accepts them.',
  input: z.object({
    id,
    file_data: z.string().optional().describe('Base64-encoded file content for file_import connectors'),
    file_name: text(200).optional(),
    cursor: z.string().optional().describe('Pagination cursor for API connectors that support it'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const conn = await lockConn(c, i.id);
    if (!conn) throw notFound('Connector');
    await authorisedConn(user, i.id, c);
    mustBeApproved(connView(conn));
    if (!c.query) throw new Error('internal');
    // Advisory lock: one sync at a time per connector
    const locked = (await c.query('SELECT pg_try_advisory_xact_lock($1)', [hashToInt(i.id)])).rows[0].pg_try_advisory_xact_lock;
    if (!locked) throw conflict('A sync is already running for this connector', { code: 'sync_in_progress' });

    let batchRow;
    if (conn.adapter === 'file_import') {
      if (!i.file_data) throw badRequest('Provide file_data for file_import connectors');
      const buf = Buffer.from(i.file_data, 'base64');
      const sha256 = createHash('sha256').update(buf).digest('hex');
      // Check for duplicate
      const existing = (await c.query('SELECT * FROM fed_credential_import_batches WHERE connector_id=$1 AND file_sha256=$2', [i.id, sha256])).rows[0];
      if (existing) return { ...existing, replayed: true };
      batchRow = (await c.query(
        `INSERT INTO fed_credential_import_batches(connector_id,mode,file_sha256,started_by) VALUES($1,'file_upload',$2,$3) RETURNING *`,
        [i.id, sha256, user.id])).rows[0];
      const records = parseCredentialFile(buf, conn.adapter, conn.mapping);
      const counts = await stageCredentialRecords(c, conn, batchRow.id, records);
      batchRow = (await c.query(
        `UPDATE fed_credential_import_batches SET status=$2,total_records=$3,created_count=$4,updated_count=$5,unchanged_count=$6,conflict_count=$7,failed_count=$8,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [batchRow.id, counts.failed === counts.total && counts.total > 0 ? 'failed' : counts.conflict > 0 ? 'partial' : 'ok',
         counts.total, counts.created, counts.updated, counts.unchanged, counts.conflict, counts.failed])).rows[0];
    } else {
      checkBackoff(connView(conn));
      batchRow = (await c.query(
        `INSERT INTO fed_credential_import_batches(connector_id,mode,started_by) VALUES($1,'api_pull',$2) RETURNING *`,
        [i.id, user.id])).rows[0];
      // Pull from external API (delegated to external-history pull pattern; placeholder for real adapter)
      let records = [], pullError = null;
      try { records = await pullCredentialFeed(conn, i.cursor); }
      catch (e) { pullError = e.message; }
      if (pullError) {
        const newCount = conn.backoff_count + 1;
        const backoffMins = Math.min(Math.pow(2, newCount), 1440); // max 24h
        await c.query(
          `UPDATE fed_credential_connectors SET last_sync_at=now(), last_sync_status='failed', last_sync_error=$2,
                  backoff_count=$3, backoff_until=now()+($4::text||' minutes')::interval, row_version=row_version+1, updated_at=now() WHERE id=$1`,
          [i.id, pullError.slice(0, 2000), newCount, backoffMins]);
        await c.query(`UPDATE fed_credential_import_batches SET status='failed',errors=$2,updated_at=now() WHERE id=$1`,
          [batchRow.id, JSON.stringify([{ message: pullError }])]);
        throw conflict(`API pull failed: ${pullError}. Next retry in ${backoffMins} minutes.`, { code: 'sync_failed' });
      }
      const counts = await stageCredentialRecords(c, conn, batchRow.id, records);
      await c.query(
        `UPDATE fed_credential_connectors SET last_sync_at=now(), last_sync_status='ok', last_sync_error=NULL,
                backoff_count=0, backoff_until=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1`, [i.id]);
      batchRow = (await c.query(
        `UPDATE fed_credential_import_batches SET status=$2,total_records=$3,created_count=$4,updated_count=$5,unchanged_count=$6,conflict_count=$7,failed_count=$8,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [batchRow.id, counts.failed > 0 ? 'partial' : 'ok',
         counts.total, counts.created, counts.updated, counts.unchanged, counts.conflict, counts.failed])).rows[0];
    }
    await logRecon(c, 'batch', batchRow.id, 'created', user.id, { mode: batchRow.mode, total: batchRow.total_records });
    await audit(c, user.id, 'trigger_credential_sync', 'fed_credential_import_batches', batchRow.id);
    return { ...batchRow, replayed: false };
  }),
});

// ------------------------------------------------------------------ batch & staged reads
cap({
  name: 'list_credential_import_batches', method: 'GET', path: '/federation-connectors/:id/credential-batches', tag: TAG,
  summary: 'List credential import batches for a connector, newest first. Shows totals, conflict counts and status.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await authorisedConn(user, i.id);
    return many(
      `SELECT b.*, u.display_name AS started_by_name FROM fed_credential_import_batches b
         JOIN users u ON u.id=b.started_by WHERE b.connector_id=$1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_credential_import_batch', method: 'GET', path: '/federation-credential-batches/:id', tag: TAG,
  summary: 'Get a single credential import batch with counts, errors and a summary of staged record statuses.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = (await pool.query('SELECT * FROM fed_credential_import_batches WHERE id=$1', [i.id])).rows[0];
    if (!b) throw notFound('Batch');
    await authorisedConn(user, b.connector_id);
    const summary = (await pool.query(
      `SELECT status, count(*)::int AS n FROM fed_staged_credentials WHERE batch_id=$1 GROUP BY status`, [i.id])).rows;
    return { ...b, status_summary: summary };
  },
});

cap({
  name: 'list_staged_credentials', method: 'GET', path: '/federation-staged-credentials', tag: TAG,
  summary: 'Paginated list of staged credential records for review. Filterable by connector, status, sport, grade, match confidence and body. Returns mapped fields, conflict detail and existing licence summary.',
  input: z.object({
    connector_id: id.optional(),
    body_id: id.optional(),
    status: z.enum(['pending','matched','conflict','accepted','rejected','disputed','manual_review']).optional(),
    match_confidence: z.enum(['confirmed','probable','unmatched']).optional(),
    sport_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    if (!isPlatform(user)) {
      const bid = i.body_id ?? (i.connector_id ? (await pool.query('SELECT body_id FROM fed_credential_connectors WHERE id=$1', [i.connector_id])).rows[0]?.body_id : null);
      if (!bid) throw badRequest('Supply body_id or connector_id');
      const auth = await authority(user, bid);
      need(auth, 'licences', i.sport_id);
    }
    return many(
      `SELECT sc.id, sc.connector_id, sc.batch_id, sc.external_ref, sc.external_identifier,
              sc.matched_user_id, u.display_name AS holder_name, u.handle AS holder_handle,
              sc.match_confidence, sc.licence_type_id, lt.name AS licence_type_name,
              sc.external_grade, sc.mapped_grade, sc.issued_on::text, sc.expires_on::text,
              sc.external_standing, sc.mapped_standing, sc.restrictions,
              sc.status, sc.conflict_type, sc.conflict_detail,
              sc.existing_licence_id, l.licence_no AS existing_licence_no,
              ${LIC_STATUS('l')} AS existing_licence_status,
              sc.reviewed_by, ru.display_name AS reviewed_by_name, sc.reviewed_at, sc.review_note,
              sc.disputed_by, sc.disputed_at, sc.dispute_case_id, sc.created_at
         FROM fed_staged_credentials sc
         LEFT JOIN users u ON u.id=sc.matched_user_id
         LEFT JOIN fed_licence_types lt ON lt.id=sc.licence_type_id
         LEFT JOIN fed_licences l ON l.id=sc.existing_licence_id
         LEFT JOIN users ru ON ru.id=sc.reviewed_by
        WHERE ($1::uuid IS NULL OR sc.connector_id=$1)
          AND ($2::uuid IS NULL OR sc.connector_id IN (SELECT id FROM fed_credential_connectors WHERE body_id=$2))
          AND ($3::text IS NULL OR sc.status=$3)
          AND ($4::text IS NULL OR sc.match_confidence=$4)
          AND ($5::uuid IS NULL OR lt.sport_id=$5)
        ORDER BY sc.created_at DESC LIMIT $6 OFFSET $7`,
      [i.connector_id ?? null, i.body_id ?? null, i.status ?? null, i.match_confidence ?? null, i.sport_id ?? null, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ review: accept / reject / flag
cap({
  name: 'review_staged_credential', method: 'POST', path: '/federation-staged-credentials/:id/review', tag: TAG,
  summary: 'Accept, reject or flag a staged credential for manual review. Accepting a matched+confirmed record writes it to fed_licences with full provenance. Manually adjudicated licences (sync_status=manual) block accept unless force_manual_override is true (platform admin only). Youth subjects require active guardian consent.',
  input: z.object({
    id,
    action: z.enum(['accept','reject','flag_manual']),
    review_note: text(500).optional(),
    force_manual_override: z.boolean().default(false).describe('Platform admin only: overwrite a manually adjudicated licence'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const sc = (await c.query('SELECT * FROM fed_staged_credentials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!sc) throw notFound('Staged credential');
    const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [sc.connector_id])).rows[0];
    const auth = await authority(user, conn.body_id, { c });
    need(auth, 'licences', conn.sport_id);
    if (['accepted','rejected'].includes(sc.status)) throw conflict(`Already ${sc.status}`, { code: 'already_reviewed' });

    if (i.action === 'accept') {
      if (!sc.matched_user_id) throw badRequest('Cannot accept: no matched user. The record must be matched to a confirmed identity first.');
      if (sc.match_confidence !== 'confirmed') throw badRequest('Cannot accept: identity match must be confirmed (not just probable). Verify via external_identities first.');
      if (!sc.licence_type_id) throw badRequest('Cannot accept: licence type must be mapped (unknown_grade). Update the connector mapping first.');
      // Youth consent check
      if (await isYouth(sc.matched_user_id, c)) {
        if (!(await hasConsent(sc.matched_user_id, 'federation_licence', c)))
          throw forbidden('Guardian consent is required before accepting this credential for a youth athlete');
      }
      // Block manual override unless platform admin
      if (sc.existing_licence_id) {
        const ex = (await c.query('SELECT sync_status FROM fed_licences WHERE id=$1', [sc.existing_licence_id])).rows[0];
        if (ex?.sync_status === 'manual' && !i.force_manual_override)
          throw conflict('This licence has been manually adjudicated (sync_status=manual). Set force_manual_override=true (platform admin only) to overwrite.', { code: 'manual_lock' });
        if (i.force_manual_override && !isPlatform(user))
          throw forbidden('Only platform admins can override manually adjudicated licences');
      }
      // Upsert fed_licences
      let licenceId;
      if (sc.existing_licence_id) {
        const updated = (await c.query(
          `UPDATE fed_licences SET status=$2, issued_on=COALESCE($3, issued_on), expires_on=COALESCE($4, expires_on),
                  external_ref=$5, connector_id=$6, provenance_batch_id=$7, last_synced_at=now(), sync_status='in_sync',
                  row_version=row_version+1, updated_at=now()
           WHERE id=$1 RETURNING id`,
          [sc.existing_licence_id, sc.mapped_standing ?? 'active', sc.issued_on, sc.expires_on, sc.external_ref, sc.connector_id, sc.batch_id])).rows[0];
        licenceId = updated.id;
        await logFed(c, conn.body_id, 'licence', licenceId, 'imported_synced', { actor: user.id, external_ref: sc.external_ref, connector_id: sc.connector_id, batch_id: sc.batch_id });
      } else {
        const licNo = await nextNumber(c, conn.body_id, 'licence');
        const inserted = (await c.query(
          `INSERT INTO fed_licences(body_id,type_id,holder_id,grade,status,licence_no,issued_on,expires_on,
                                    external_ref,connector_id,provenance_batch_id,last_synced_at,sync_status,
                                    override_reason,decided_at,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'in_sync','Imported from federation connector'::text,now(),$12)
           RETURNING id`,
          [conn.body_id, sc.licence_type_id, sc.matched_user_id, sc.mapped_grade ?? sc.external_grade,
           sc.mapped_standing ?? 'active', licNo, sc.issued_on, sc.expires_on,
           sc.external_ref, sc.connector_id, sc.batch_id, user.id])).rows[0];
        licenceId = inserted.id;
        await logFed(c, conn.body_id, 'licence', licenceId, 'imported_created', { actor: user.id, external_ref: sc.external_ref, connector_id: sc.connector_id, batch_id: sc.batch_id });
      }
      await c.query(
        `UPDATE fed_staged_credentials SET status='accepted', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null]);
      await notify(c, sc.matched_user_id, { kind: 'federation_licence_imported', title: 'Federation credential added', body: 'Your credential from the federation has been confirmed and added to your profile.', data: { licence_id: licenceId } });
      await logRecon(c, 'staged_credential', i.id, 'accepted', user.id, { licence_id: licenceId, note: i.review_note });
    } else if (i.action === 'reject') {
      await c.query(
        `UPDATE fed_staged_credentials SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null]);
      await logRecon(c, 'staged_credential', i.id, 'rejected', user.id, { note: i.review_note });
      if (sc.matched_user_id)
        await notify(c, sc.matched_user_id, { kind: 'federation_credential_rejected', title: 'Federation credential not imported', body: 'An incoming federation credential record for you was reviewed and not accepted. Contact the federation if you believe this is incorrect.', data: {} });
    } else {
      await c.query(
        `UPDATE fed_staged_credentials SET status='manual_review', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null]);
      await logRecon(c, 'staged_credential', i.id, 'flagged_manual', user.id, { note: i.review_note });
    }
    await audit(c, user.id, 'review_staged_credential', 'fed_staged_credentials', i.id);
    return (await c.query('SELECT * FROM fed_staged_credentials WHERE id=$1', [i.id])).rows[0];
  }),
});

cap({
  name: 'bulk_review_staged_credentials', method: 'POST', path: '/federation-staged-credentials/bulk-review', tag: TAG,
  summary: 'Bulk accept or reject all matched+confirmed staged credentials in a batch. Skips conflicts, unmatched records and those requiring manual review. Returns counts of accepted, rejected, and skipped records.',
  input: z.object({
    batch_id: id,
    action: z.enum(['accept','reject']),
    review_note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const batch = (await c.query('SELECT * FROM fed_credential_import_batches WHERE id=$1', [i.batch_id])).rows[0];
    if (!batch) throw notFound('Batch');
    const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [batch.connector_id])).rows[0];
    const auth = await authority(user, conn.body_id, { c });
    need(auth, 'licences', conn.sport_id);

    const eligible = (await c.query(
      `SELECT id FROM fed_staged_credentials WHERE batch_id=$1 AND status='matched' AND match_confidence='confirmed'
       AND licence_type_id IS NOT NULL AND matched_user_id IS NOT NULL`,
      [i.batch_id])).rows;

    let accepted = 0, rejected = 0, skipped = 0;
    for (const { id: scId } of eligible) {
      try {
        // Delegate to single review handler logic (simplified inline)
        const sc = (await c.query('SELECT * FROM fed_staged_credentials WHERE id=$1', [scId])).rows[0];
        if (!sc || ['accepted','rejected'].includes(sc.status)) { skipped++; continue; }
        if (i.action === 'accept') {
          if (await isYouth(sc.matched_user_id, c) && !(await hasConsent(sc.matched_user_id, 'federation_licence', c))) { skipped++; continue; }
          const licNo = await nextNumber(c, conn.body_id, 'licence');
          const ins = (await c.query(
            `INSERT INTO fed_licences(body_id,type_id,holder_id,grade,status,licence_no,issued_on,expires_on,
                                      external_ref,connector_id,provenance_batch_id,last_synced_at,sync_status,
                                      override_reason,decided_at,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'in_sync','Bulk import from federation connector',now(),$12)
             ON CONFLICT (connector_id, external_ref) DO NOTHING RETURNING id`,
            [conn.body_id, sc.licence_type_id, sc.matched_user_id, sc.mapped_grade ?? sc.external_grade,
             sc.mapped_standing ?? 'active', licNo, sc.issued_on, sc.expires_on,
             sc.external_ref, sc.connector_id, sc.batch_id, user.id])).rows[0];
          if (ins) {
            await logFed(c, conn.body_id, 'licence', ins.id, 'imported_created', { actor: user.id, batch: 'bulk', batch_id: sc.batch_id });
            await c.query(`UPDATE fed_staged_credentials SET status='accepted', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$1`, [scId, user.id, i.review_note ?? null]);
            await logRecon(c, 'staged_credential', scId, 'bulk_accepted', user.id);
            accepted++;
          } else { skipped++; }
        } else {
          await c.query(`UPDATE fed_staged_credentials SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$1`, [scId, user.id, i.review_note ?? null]);
          await logRecon(c, 'staged_credential', scId, 'bulk_rejected', user.id);
          rejected++;
        }
      } catch { skipped++; }
    }
    await audit(c, user.id, 'bulk_review_staged_credentials', 'fed_credential_import_batches', i.batch_id);
    return { accepted, rejected, skipped, total: eligible.length };
  }),
});

cap({
  name: 'dispute_staged_credential', method: 'POST', path: '/federation-staged-credentials/:id/dispute', tag: TAG,
  summary: 'The official (or their guardian) disputes an incoming staged credential record. Opens a gov_case of kind licence_issue with needs_review=true so licensing staff can investigate. The dispute reason is field-level encrypted.',
  input: z.object({
    id,
    reason: text(2000).min(10),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const sc = (await c.query('SELECT * FROM fed_staged_credentials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!sc) throw notFound('Staged credential');
    if (!sc.matched_user_id) throw badRequest('Cannot dispute: record is not matched to your identity yet');
    // Only the matched user or their guardian can dispute
    const isHolder = sc.matched_user_id === user.id;
    const isGuard = !isHolder && (await c.query('SELECT 1 FROM guardian_consents WHERE youth_id=$1 AND guardian_id=$2 AND status=\'active\'', [sc.matched_user_id, user.id])).rowCount > 0;
    if (!isHolder && !isGuard) throw forbidden('Only the credential holder or their guardian can dispute it');
    if (sc.status === 'disputed') throw conflict('Already disputed');

    const reasonEnc = await encrypt(i.reason, 'fed_staged_credentials.dispute_reason');
    const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [sc.connector_id])).rows[0];
    // Open a gov_case of kind licence_issue
    const caseRow = (await c.query(
      `INSERT INTO gov_cases(kind,status,category,sport_id,subject_user_id,subject_role,source,needs_review,review_reason,opened_by,connector_id,external_ref)
       VALUES('licence_issue','received','credential_dispute',$1,$2,'official',
              $3::jsonb, true, 'Credential holder has disputed an incoming federation import',$4,$5,$6) RETURNING id`,
      [conn.sport_id ?? null, sc.matched_user_id,
       JSON.stringify({ type: 'federation_import', id: sc.id, external_ref: sc.external_ref }),
       user.id, conn.body_id, sc.external_ref])).rows[0];
    await c.query(
      `UPDATE fed_staged_credentials SET status='disputed', disputed_by=$2, disputed_at=now(), dispute_reason_enc=$3, dispute_case_id=$4, updated_at=now() WHERE id=$1`,
      [i.id, user.id, reasonEnc, caseRow.id]);
    // Notify licensing staff
    const staffIds = (await c.query(
      `SELECT user_id FROM governing_body_roles WHERE body_id=$1 AND role='licensing' AND status='active'`, [conn.body_id])).rows.map(r => r.user_id);
    for (const sid of staffIds)
      await notify(c, sid, { kind: 'credential_dispute', title: 'Credential dispute', body: 'An official has disputed an imported federation credential record. Review the case.', data: { case_id: caseRow.id, staged_id: sc.id } });
    await logRecon(c, 'staged_credential', i.id, 'disputed', user.id, { case_id: caseRow.id });
    await audit(c, user.id, 'dispute_staged_credential', 'fed_staged_credentials', i.id);
    return { staged_credential_id: i.id, dispute_case_id: caseRow.id };
  }),
});

// ------------------------------------------------------------------ mapping & summary
cap({
  name: 'save_credential_mapping', method: 'POST', path: '/federation-connectors/:id/mapping', tag: TAG,
  summary: 'Save or replace the grade mapping for a connector (map external grade labels to platform grade slugs). Automatically re-stages any pending records with unknown_grade conflict using the new mapping.',
  input: z.object({
    id,
    mapping: z.record(z.string().trim().max(60), z.string().trim().max(60)).describe('{"EXTERNAL_GRADE": "platform_grade_slug"}'),
    row_version: z.number().int().min(1),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const conn = await authorisedConn(user, i.id, c, { lock: true });
    if (conn.row_version !== i.row_version)
      throw conflict('Changed elsewhere', { code: 'stale_version', row_version: conn.row_version });
    const row = (await c.query(
      `UPDATE fed_credential_connectors SET mapping=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, JSON.stringify(i.mapping)])).rows[0];
    // Re-apply mapping
    let remapped = 0;
    for (const [extGrade, mappedGrade] of Object.entries(i.mapping)) {
      const r = await c.query(
        `UPDATE fed_staged_credentials SET mapped_grade=$2, status='matched', conflict_type=NULL, updated_at=now()
         WHERE connector_id=$1 AND external_grade=$3 AND status='pending' AND conflict_type='unknown_grade'`,
        [i.id, mappedGrade, extGrade]);
      remapped += r.rowCount;
    }
    await logRecon(c, 'connector', i.id, 'mapping_saved', user.id, { remapped_records: remapped });
    await audit(c, user.id, 'save_credential_mapping', 'fed_credential_connectors', i.id);
    return { connector: connView(row), remapped_records: remapped };
  }),
});

cap({
  name: 'get_reconciliation_summary', method: 'GET', path: '/federation-connectors/:id/reconciliation-summary', tag: TAG,
  summary: 'Dashboard summary for a connector: staged record counts by status, stale licences, conflict breakdown, next scheduled sync, and recent reconciliation activity.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await authorisedConn(user, i.id);
    const [stageCounts, conflictTypes, staleLicences, discCounts, recentEvents] = await Promise.all([
      pool.query(`SELECT status, count(*)::int AS n FROM fed_staged_credentials WHERE connector_id=$1 GROUP BY status`, [i.id]),
      pool.query(`SELECT conflict_type, count(*)::int AS n FROM fed_staged_credentials WHERE connector_id=$1 AND conflict_type IS NOT NULL GROUP BY conflict_type`, [i.id]),
      pool.query(`SELECT count(*)::int AS n FROM fed_licences WHERE connector_id=$1 AND sync_status='stale'`, [i.id]),
      pool.query(`SELECT status, count(*)::int AS n FROM fed_staged_disciplinary WHERE connector_id=$1 GROUP BY status`, [i.id]),
      pool.query(`SELECT action, actor_id, detail, created_at FROM fed_reconciliation_events WHERE subject_type IN ('staged_credential','staged_disciplinary') AND subject_id IN (SELECT id FROM fed_staged_credentials WHERE connector_id=$1 UNION SELECT id FROM fed_staged_disciplinary WHERE connector_id=$1) ORDER BY created_at DESC LIMIT 10`, [i.id]),
    ]);
    const conn = await connRow(i.id);
    return {
      connector_id: i.id,
      sync_status: conn?.last_sync_status,
      last_sync_at: conn?.last_sync_at,
      backoff_until: conn?.backoff_until,
      staged_credentials: stageCounts.rows,
      conflict_types: conflictTypes.rows,
      stale_licences: staleLicences.rows[0]?.n ?? 0,
      staged_disciplinary: discCounts.rows,
      recent_events: recentEvents.rows,
    };
  },
});

// ------------------------------------------------------------------ internal helpers (not caps)
function hashToInt(uuidStr) {
  let h = BigInt(0);
  for (const c of uuidStr.replace(/-/g, '')) h = (h * 31n + BigInt(parseInt(c, 16))) % (2n ** 31n);
  return Number(h);
}

function parseCredentialFile(buf, _adapter, mapping) {
  // Parse CSV/JSON file into normalised record objects; map grades via connector.mapping
  try {
    const text = buf.toString('utf-8').trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      const data = JSON.parse(text);
      const rows = Array.isArray(data) ? data : [data];
      return rows.map((r, idx) => normaliseCredentialRecord(r, mapping, idx));
    }
    // CSV: first row is headers
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    return lines.slice(1).map((line, idx) => {
      const cols = line.split(',');
      const rec = {};
      headers.forEach((h, j) => { rec[h] = (cols[j] ?? '').trim(); });
      return normaliseCredentialRecord(rec, mapping, idx);
    });
  } catch { return []; }
}

function normaliseCredentialRecord(r, mapping, idx) {
  const extGrade = r.grade ?? r.level ?? r.licence_grade ?? r.credential_level ?? '';
  const mappedGrade = mapping[extGrade] ?? mapping[extGrade?.toLowerCase()] ?? null;
  return {
    external_ref: r.id ?? r.ref ?? r.licence_id ?? r.external_ref ?? `row_${idx}`,
    external_identifier: r.registration_number ?? r.reg_no ?? r.external_id ?? null,
    holder_name: r.name ?? r.full_name ?? r.athlete_name ?? null,
    external_grade: extGrade || null,
    mapped_grade: mappedGrade,
    issued_on: r.issued_on ?? r.issue_date ?? r.valid_from ?? null,
    expires_on: r.expires_on ?? r.expiry_date ?? r.valid_until ?? null,
    external_standing: r.standing ?? r.status ?? r.state ?? null,
    restrictions: Array.isArray(r.restrictions) ? r.restrictions : (r.restrictions ? [r.restrictions] : []),
    raw: r,
  };
}

async function stageCredentialRecords(c, conn, batchId, records) {
  const counts = { total: records.length, created: 0, updated: 0, unchanged: 0, conflict: 0, failed: 0 };
  for (const rec of records) {
    try {
      const mappedStanding = mapStanding(rec.external_standing);
      const holderNameEnc = rec.holder_name ? await encrypt(rec.holder_name, 'fed_staged_credentials.holder_name') : null;
      // Check for identity match via external_identities
      const identityMatch = rec.external_identifier
        ? (await c.query(
          `SELECT ei.user_id, ei.status FROM external_identities ei WHERE ei.source_id=(SELECT id FROM external_feed_sources WHERE body_id=$1 LIMIT 1) AND ei.external_id=$2 AND ei.status='confirmed' LIMIT 1`,
          [conn.body_id, rec.external_identifier])).rows[0]
        : null;
      const matchedUserId = identityMatch?.user_id ?? null;
      const matchConf = identityMatch ? 'confirmed' : null;
      // Check for existing licence
      let existingLicenceId = null;
      if (matchedUserId) {
        const ex = (await c.query(
          `SELECT id FROM fed_licences WHERE external_ref=$1 AND connector_id=$2 LIMIT 1`,
          [rec.external_ref, conn.id])).rows[0];
        existingLicenceId = ex?.id ?? null;
      }
      // Determine conflict
      let status = matchedUserId ? 'matched' : 'pending';
      let conflictType = null, conflictDetail = null;
      if (!rec.mapped_grade && rec.external_grade) { status = 'pending'; conflictType = 'unknown_grade'; }
      if (existingLicenceId && matchedUserId) {
        const ex = (await c.query(`SELECT grade, ${LIC_STATUS('l')} AS standing FROM fed_licences l WHERE l.id=$1`, [existingLicenceId])).rows[0];
        if (ex?.grade && rec.mapped_grade && ex.grade !== rec.mapped_grade) {
          status = 'conflict'; conflictType = 'grade_mismatch';
          conflictDetail = { existing_grade: ex.grade, incoming_grade: rec.mapped_grade };
          counts.conflict++;
        }
      }

      const existing = (await c.query('SELECT id, status FROM fed_staged_credentials WHERE connector_id=$1 AND external_ref=$2', [conn.id, rec.external_ref])).rows[0];
      if (existing) {
        if (['accepted','rejected'].includes(existing.status)) { counts.unchanged++; continue; }
        await c.query(
          `UPDATE fed_staged_credentials SET batch_id=$2, raw_payload=$3, holder_name_enc=$4, external_identifier=$5,
                  matched_user_id=$6, match_confidence=$7, external_grade=$8, mapped_grade=$9,
                  issued_on=$10, expires_on=$11, external_standing=$12, mapped_standing=$13,
                  restrictions=$14, status=$15, conflict_type=$16, conflict_detail=$17, existing_licence_id=$18, updated_at=now()
           WHERE id=$1`,
          [existing.id, batchId, JSON.stringify(rec.raw), holderNameEnc, rec.external_identifier,
           matchedUserId, matchConf, rec.external_grade, rec.mapped_grade,
           rec.issued_on, rec.expires_on, rec.external_standing, mappedStanding,
           JSON.stringify(rec.restrictions), status, conflictType, conflictDetail ? JSON.stringify(conflictDetail) : null, existingLicenceId]);
        counts.updated++;
      } else {
        await c.query(
          `INSERT INTO fed_staged_credentials(batch_id,connector_id,external_ref,raw_payload,holder_name_enc,external_identifier,matched_user_id,match_confidence,external_grade,mapped_grade,issued_on,expires_on,external_standing,mapped_standing,restrictions,status,conflict_type,conflict_detail,existing_licence_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [batchId, conn.id, rec.external_ref, JSON.stringify(rec.raw), holderNameEnc, rec.external_identifier,
           matchedUserId, matchConf, rec.external_grade, rec.mapped_grade,
           rec.issued_on, rec.expires_on, rec.external_standing, mappedStanding,
           JSON.stringify(rec.restrictions), status, conflictType, conflictDetail ? JSON.stringify(conflictDetail) : null, existingLicenceId]);
        counts.created++;
        if (status === 'conflict' && conflictType !== 'grade_mismatch') counts.conflict++;
      }
    } catch { counts.failed++; }
  }
  return counts;
}

function mapStanding(s) {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (['active','valid','current','good'].some(k => sl.includes(k))) return 'active';
  if (['suspend','banned','ban'].some(k => sl.includes(k))) return 'suspended';
  if (['expir','lapsed','elapsed'].some(k => sl.includes(k))) return 'expired';
  if (['revok','cancel','void'].some(k => sl.includes(k))) return 'revoked';
  return null;
}

async function pullCredentialFeed(_conn, _cursor) {
  // Real implementation would use the connector's endpoint_url + secret to fetch JSON/XML/CSV.
  // Returns the same normalised record shape as parseCredentialFile.
  // Stubbed: real HTTP call goes via the existing checkEndpoint + fetchFeed pattern from external-history.js.
  return [];
}
