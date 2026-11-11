// Federation credential & disciplinary API reconciliation (#1026 / REF-R28) 2/2: disciplinary reconciliation.
// External federation disciplinary records are staged here, identity-matched, and reviewed before any touch of
// gov_cases or disc_sanctions. Existing gov_cases.needs_review flag is consumed as a reconciliation queue entry.
// Sanctions are never deleted; amendments use the replaces_id chain. Manually decided cases are never silently overwritten.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt } from '../crypto.js';
import { isPlatform } from '../platform.js';
import { authority, need, bodyById, logFed, nextNumber, today } from '../federation.js';
import { hasConsent, isYouth } from '../youth.js';
import { createHash } from 'node:crypto';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);

// ------------------------------------------------------------------ helpers
async function logRecon(db, subjectType, subjectId, action, actorId, detail = null) {
  await db.query(
    'INSERT INTO fed_reconciliation_events(subject_type,subject_id,action,actor_id,detail) VALUES($1,$2,$3,$4,$5)',
    [subjectType, subjectId, action, actorId, detail ? JSON.stringify(detail) : null]);
}

async function authorisedConnForDisc(user, connectorId, db = pool) {
  const conn = (await db.query('SELECT * FROM fed_credential_connectors WHERE id=$1 AND archived_at IS NULL', [connectorId])).rows[0];
  if (!conn) throw notFound('Connector');
  if (!isPlatform(user)) {
    const auth = await authority(user, conn.body_id, { c: db });
    need(auth, 'sanctions', conn.sport_id);
  }
  return conn;
}

function mapDiscKind(s) {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (['disciplin','card','caution','red','yellow','misconduct','send','eject'].some(k => sl.includes(k))) return 'discipline';
  if (['appeal'].some(k => sl.includes(k))) return 'appeal';
  if (['eligib','eligible'].some(k => sl.includes(k))) return 'eligibility_dispute';
  if (['protest'].some(k => sl.includes(k))) return 'protest';
  if (['licence','license'].some(k => sl.includes(k))) return 'licence_issue';
  if (['waiver'].some(k => sl.includes(k))) return 'waiver';
  return 'discipline';
}

function mapSanctionKind(s) {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (['warn','caution','yellow'].some(k => sl.includes(k))) return 'warning';
  if (['match'].some(k => sl.includes(k))) return 'match_suspension';
  if (['date','day','week','month'].some(k => sl.includes(k))) return 'date_suspension';
  if (['ban','compet'].some(k => sl.includes(k))) return 'competition_ban';
  if (['role','position'].some(k => sl.includes(k))) return 'role_suspension';
  if (['fine','payment','fee'].some(k => sl.includes(k))) return 'fine';
  if (['point','deduct'].some(k => sl.includes(k))) return 'points_deduction';
  return 'other';
}

// ------------------------------------------------------------------ import
cap({
  name: 'import_disciplinary_records', method: 'POST', path: '/federation-connectors/:id/disciplinary-import', tag: TAG, status: 201,
  summary: 'Import external disciplinary records from a federation connector via file upload or API pull. Records are staged in fed_staged_disciplinary pending review. Any existing gov_cases matching the external_ref have needs_review set to true. SHA-256 dedup prevents re-processing the same file.',
  input: z.object({
    id,
    file_data: z.string().optional().describe('Base64-encoded file content'),
    file_name: text(200).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const conn = await authorisedConnForDisc(user, i.id, c);
    if (conn.status !== 'approved') throw conflict('Connector is not approved', { code: 'connector_not_approved' });

    const locked = (await c.query('SELECT pg_try_advisory_xact_lock($1)', [hashToInt(i.id + '_disc')])).rows[0].pg_try_advisory_xact_lock;
    if (!locked) throw conflict('A disciplinary import is already running', { code: 'import_in_progress' });

    if (!i.file_data) throw badRequest('Provide file_data for file imports');
    const buf = Buffer.from(i.file_data, 'base64');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const dup = (await c.query('SELECT * FROM fed_disciplinary_import_batches WHERE connector_id=$1 AND file_sha256=$2', [i.id, sha256])).rows[0];
    if (dup) return { ...dup, replayed: true };

    let batchRow = (await c.query(
      `INSERT INTO fed_disciplinary_import_batches(connector_id,mode,file_sha256,started_by) VALUES($1,'file_upload',$2,$3) RETURNING *`,
      [i.id, sha256, user.id])).rows[0];

    const records = parseDiscFile(buf, conn.mapping ?? {});
    const counts = await stageDiscRecords(c, conn, batchRow.id, records);
    batchRow = (await c.query(
      `UPDATE fed_disciplinary_import_batches SET status=$2,total_records=$3,created_count=$4,conflict_count=$5,failed_count=$6,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [batchRow.id, counts.failed > 0 ? 'partial' : 'ok', counts.total, counts.created, counts.conflict, counts.failed])).rows[0];
    await logRecon(c, 'batch', batchRow.id, 'disc_import_created', user.id, { total: counts.total });
    await audit(c, user.id, 'import_disciplinary_records', 'fed_disciplinary_import_batches', batchRow.id);
    return { ...batchRow, replayed: false };
  }),
});

cap({
  name: 'list_disciplinary_import_batches', method: 'GET', path: '/federation-connectors/:id/disciplinary-batches', tag: TAG,
  summary: 'List disciplinary import batches for a connector, newest first.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await authorisedConnForDisc(user, i.id);
    return many(
      `SELECT b.*, u.display_name AS started_by_name FROM fed_disciplinary_import_batches b
         JOIN users u ON u.id=b.started_by WHERE b.connector_id=$1 ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_disciplinary_import_batch', method: 'GET', path: '/federation-disciplinary-batches/:id', tag: TAG,
  summary: 'Get a single disciplinary import batch with status summary.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = (await pool.query('SELECT * FROM fed_disciplinary_import_batches WHERE id=$1', [i.id])).rows[0];
    if (!b) throw notFound('Batch');
    await authorisedConnForDisc(user, b.connector_id);
    const summary = (await pool.query('SELECT status, count(*)::int AS n FROM fed_staged_disciplinary WHERE batch_id=$1 GROUP BY status', [i.id])).rows;
    return { ...b, status_summary: summary };
  },
});

// ------------------------------------------------------------------ staged disciplinary queue
cap({
  name: 'list_staged_disciplinary_records', method: 'GET', path: '/federation-staged-disciplinary', tag: TAG,
  summary: 'Paginated reconciliation queue: staged disciplinary records awaiting review, plus existing gov_cases with needs_review=true (flagged for re-evaluation). Filterable by connector, status, sport, mapped_kind, match confidence and body.',
  input: z.object({
    connector_id: id.optional(),
    body_id: id.optional(),
    include_needs_review_cases: z.coerce.boolean().default(true),
    status: z.enum(['pending','matched','conflict','accepted','rejected','disputed','manual_review']).optional(),
    sport_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    if (!isPlatform(user)) {
      const bid = i.body_id ?? (i.connector_id ? (await pool.query('SELECT body_id FROM fed_credential_connectors WHERE id=$1', [i.connector_id])).rows[0]?.body_id : null);
      if (!bid) throw badRequest('Supply body_id or connector_id');
      const auth = await authority(user, bid);
      need(auth, 'sanctions', i.sport_id);
    }
    // Staged records
    const staged = await many(
      `SELECT sd.id, 'staged' AS record_type, sd.connector_id, sd.batch_id, sd.external_ref,
              sd.matched_user_id, u.display_name AS subject_name, sd.match_confidence,
              sd.external_kind, sd.mapped_kind, sd.external_sanction_kind, sd.mapped_sanction_kind,
              sd.incident_date::text, sd.decided_date::text, sd.outcome, sd.sanction_detail,
              sd.status, sd.conflict_type, sd.conflict_detail,
              sd.existing_case_id, sd.existing_sanction_id,
              sd.reviewed_by, ru.display_name AS reviewed_by_name, sd.reviewed_at, sd.review_note, sd.created_at
         FROM fed_staged_disciplinary sd
         LEFT JOIN users u ON u.id=sd.matched_user_id
         LEFT JOIN users ru ON ru.id=sd.reviewed_by
        WHERE ($1::uuid IS NULL OR sd.connector_id=$1)
          AND ($2::uuid IS NULL OR sd.connector_id IN (SELECT id FROM fed_credential_connectors WHERE body_id=$2))
          AND ($3::text IS NULL OR sd.status=$3)
          AND ($4::uuid IS NULL OR sd.connector_id IN (SELECT id FROM fed_credential_connectors WHERE sport_id=$4))
        ORDER BY sd.created_at DESC LIMIT $5 OFFSET $6`,
      [i.connector_id ?? null, i.body_id ?? null, i.status ?? null, i.sport_id ?? null, i.limit, i.offset]);

    // gov_cases with needs_review=true (flagged by external reconciliation or manual flags)
    let needsReviewCases = [];
    if (i.include_needs_review_cases && !i.status) {
      needsReviewCases = (await pool.query(
        `SELECT g.id, 'needs_review_case' AS record_type, g.connector_id, g.kind, g.status AS case_status,
                g.category, g.sport_id, g.subject_user_id, u.display_name AS subject_name,
                g.review_reason, g.external_ref, g.needs_review, g.updated_at AS created_at
           FROM gov_cases g LEFT JOIN users u ON u.id=g.subject_user_id
          WHERE g.needs_review=true
            AND ($1::uuid IS NULL OR g.connector_id=$1)
            AND ($2::uuid IS NULL OR g.connector_id IN (SELECT id FROM fed_credential_connectors WHERE body_id=$2))
            AND ($3::uuid IS NULL OR g.sport_id=$3)
          ORDER BY g.updated_at DESC LIMIT 20`,
        [i.connector_id ?? null, i.body_id ?? null, i.sport_id ?? null])).rows;
    }
    return { staged, needs_review_cases: needsReviewCases };
  },
});

// ------------------------------------------------------------------ review
cap({
  name: 'review_staged_disciplinary_record', method: 'POST', path: '/federation-staged-disciplinary/:id/review', tag: TAG,
  summary: 'Accept, reject or flag a staged disciplinary record for manual review. Accepting creates a gov_case + disc_sanction with full provenance, or updates an existing case and clears needs_review. Sanctions are immutable; amendments use the replaces_id chain. Youth consent required. Never edits existing gov_case_events rows.',
  input: z.object({
    id,
    action: z.enum(['accept','reject','flag_manual']),
    review_note: text(500).optional(),
    appeal_deadline: z.string().date().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const sd = (await c.query('SELECT * FROM fed_staged_disciplinary WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!sd) throw notFound('Staged disciplinary record');
    const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [sd.connector_id])).rows[0];
    const auth = await authority(user, conn.body_id, { c });
    need(auth, 'sanctions', conn.sport_id);
    if (['accepted','rejected'].includes(sd.status)) throw conflict(`Already ${sd.status}`, { code: 'already_reviewed' });

    if (i.action === 'accept') {
      if (!sd.matched_user_id) throw badRequest('Cannot accept: no matched user');
      if (sd.match_confidence !== 'confirmed') throw badRequest('Cannot accept: identity match must be confirmed');
      if (await isYouth(sd.matched_user_id, c) && !(await hasConsent(sd.matched_user_id, 'discipline', c)))
        throw forbidden('Guardian consent required for a youth subject');

      let caseId, sanctionId;
      if (sd.existing_case_id) {
        // Update existing case: append event, clear needs_review — never edit existing events
        const gc = (await c.query('SELECT * FROM gov_cases WHERE id=$1', [sd.existing_case_id])).rows[0];
        if (gc) {
          await c.query(
            `UPDATE gov_cases SET needs_review=false, review_reason=NULL, external_ref=COALESCE(external_ref,$2),
                    connector_id=COALESCE(connector_id,$3), row_version=row_version+1, updated_at=now() WHERE id=$1`,
            [sd.existing_case_id, sd.external_ref, sd.connector_id]);
          await c.query(
            `INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,
              (SELECT coalesce(max(version),0)+1 FROM gov_case_events WHERE case_id=$1),'review_cleared',$2,$3)`,
            [sd.existing_case_id, user.id, i.review_note ?? 'Cleared after federation import reconciliation']);
          caseId = sd.existing_case_id;
        }
        // Amend sanction if incoming detail differs
        if (sd.existing_sanction_id && sd.sanction_detail) {
          const newSanction = (await c.query(
            `INSERT INTO disc_sanctions(case_id,kind,scope,status,external_ref,connector_id,provenance_batch_id,replaces_id,decided_at,decided_by)
             VALUES($1,$2,'competition','active',$3,$4,$5,$6,now(),$7) RETURNING id`,
            [caseId, sd.mapped_sanction_kind ?? 'other', sd.external_ref, sd.connector_id, sd.batch_id, sd.existing_sanction_id, user.id])).rows[0];
          sanctionId = newSanction.id;
          await logFed(c, conn.body_id, 'sanction', sanctionId, 'imported_amended', { actor: user.id, replaces: sd.existing_sanction_id });
        }
      } else {
        // Create new gov_case + disc_sanction
        const newCase = (await c.query(
          `INSERT INTO gov_cases(kind,status,category,sport_id,subject_user_id,subject_role,source,needs_review,
                                  appeal_deadline,opened_by,connector_id,external_ref)
           VALUES($1,'decided',$2,$3,$4,'official',$5::jsonb,false,$6,$7,$8,$9) RETURNING id`,
          [sd.mapped_kind ?? 'discipline', sd.external_kind ?? 'imported', conn.sport_id ?? null, sd.matched_user_id,
           JSON.stringify({ type: 'external_import', id: sd.id, external_ref: sd.external_ref }),
           i.appeal_deadline ?? null, user.id, sd.connector_id, sd.external_ref])).rows[0];
        caseId = newCase.id;
        await c.query(
          `INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,1,'opened',$2,$3)`,
          [caseId, user.id, 'Case created from federation disciplinary import']);
        await c.query(
          `INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,2,'decision',$2,$3)`,
          [caseId, user.id, `Imported from federation connector. Outcome: ${sd.outcome ?? 'recorded'}`]);
        if (sd.mapped_sanction_kind) {
          const newSanction = (await c.query(
            `INSERT INTO disc_sanctions(case_id,kind,scope,status,external_ref,connector_id,provenance_batch_id,decided_at,decided_by)
             VALUES($1,$2,'competition','active',$3,$4,$5,now(),$6) RETURNING id`,
            [caseId, sd.mapped_sanction_kind, sd.external_ref, sd.connector_id, sd.batch_id, user.id])).rows[0];
          sanctionId = newSanction.id;
          await c.query(
            `INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,3,'sanction_issued',$2,$3)`,
            [caseId, user.id, `Sanction imported: ${sd.mapped_sanction_kind}`]);
          await logFed(c, conn.body_id, 'sanction', sanctionId, 'imported_created', { actor: user.id, batch_id: sd.batch_id });
        }
        await logFed(c, conn.body_id, 'licence', caseId, 'disc_case_imported', { actor: user.id, external_ref: sd.external_ref });
      }
      await c.query(
        `UPDATE fed_staged_disciplinary SET status='accepted',reviewed_by=$2,reviewed_at=now(),review_note=$3,existing_case_id=COALESCE(existing_case_id,$4),updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null, caseId]);
      if (sd.matched_user_id)
        await notify(c, sd.matched_user_id, { kind: 'discipline_imported', title: 'Disciplinary record added', body: 'A disciplinary record from your federation has been added to your profile.', data: { case_id: caseId } });
      await logRecon(c, 'staged_disciplinary', i.id, 'accepted', user.id, { case_id: caseId, sanction_id: sanctionId });
    } else if (i.action === 'reject') {
      await c.query(
        `UPDATE fed_staged_disciplinary SET status='rejected',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null]);
      await logRecon(c, 'staged_disciplinary', i.id, 'rejected', user.id, { note: i.review_note });
    } else {
      await c.query(
        `UPDATE fed_staged_disciplinary SET status='manual_review',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`,
        [i.id, user.id, i.review_note ?? null]);
      await logRecon(c, 'staged_disciplinary', i.id, 'flagged_manual', user.id, { note: i.review_note });
    }
    await audit(c, user.id, 'review_staged_disciplinary_record', 'fed_staged_disciplinary', i.id);
    return (await c.query('SELECT * FROM fed_staged_disciplinary WHERE id=$1', [i.id])).rows[0];
  }),
});

// ------------------------------------------------------------------ conflicts
cap({
  name: 'list_reconciliation_conflicts', method: 'GET', path: '/federation-reconciliation-conflicts', tag: TAG,
  summary: 'All unresolved reconciliation conflicts across credential and disciplinary staged records for a connector or body.',
  input: z.object({ connector_id: id.optional(), body_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (!isPlatform(user)) {
      const bid = i.body_id ?? (i.connector_id ? (await pool.query('SELECT body_id FROM fed_credential_connectors WHERE id=$1', [i.connector_id])).rows[0]?.body_id : null);
      if (!bid) throw badRequest('Supply body_id or connector_id');
      const auth = await authority(user, bid);
      need(auth, 'compliance');
    }
    const creds = await many(
      `SELECT sc.id, 'credential' AS conflict_kind, sc.connector_id, sc.external_ref,
              sc.matched_user_id, u.display_name AS subject_name,
              sc.conflict_type, sc.conflict_detail, sc.external_grade, sc.mapped_grade,
              sc.external_standing, sc.mapped_standing, sc.existing_licence_id, sc.created_at
         FROM fed_staged_credentials sc LEFT JOIN users u ON u.id=sc.matched_user_id
        WHERE sc.status='conflict'
          AND ($1::uuid IS NULL OR sc.connector_id=$1)
          AND ($2::uuid IS NULL OR sc.connector_id IN (SELECT id FROM fed_credential_connectors WHERE body_id=$2))
        ORDER BY sc.created_at DESC LIMIT $3 OFFSET $4`,
      [i.connector_id ?? null, i.body_id ?? null, i.limit, i.offset]);
    const discs = await many(
      `SELECT sd.id, 'disciplinary' AS conflict_kind, sd.connector_id, sd.external_ref,
              sd.matched_user_id, u.display_name AS subject_name,
              sd.conflict_type, sd.conflict_detail, sd.mapped_kind, sd.mapped_sanction_kind,
              sd.existing_case_id, sd.existing_sanction_id, sd.created_at
         FROM fed_staged_disciplinary sd LEFT JOIN users u ON u.id=sd.matched_user_id
        WHERE sd.status='conflict'
          AND ($1::uuid IS NULL OR sd.connector_id=$1)
          AND ($2::uuid IS NULL OR sd.connector_id IN (SELECT id FROM fed_credential_connectors WHERE body_id=$2))
        ORDER BY sd.created_at DESC LIMIT $3 OFFSET $4`,
      [i.connector_id ?? null, i.body_id ?? null, i.limit, i.offset]);
    return { credentials: creds, disciplinary: discs };
  },
});

cap({
  name: 'resolve_reconciliation_conflict', method: 'POST', path: '/federation-reconciliation-conflicts/:id/resolve', tag: TAG,
  summary: 'Resolve a reconciliation conflict: keep_platform (staged record is rejected, platform data wins), adopt_external (staged record is accepted, amends existing via replaces_id chain), or escalate (opens a gov_case of kind licence_issue for formal review).',
  input: z.object({
    id,
    conflict_kind: z.enum(['credential','disciplinary']),
    resolution: z.enum(['keep_platform','adopt_external','escalate']),
    note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.conflict_kind === 'credential') {
      const sc = (await c.query('SELECT * FROM fed_staged_credentials WHERE id=$1 AND status=\'conflict\' FOR UPDATE', [i.id])).rows[0];
      if (!sc) throw notFound('Credential conflict');
      const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [sc.connector_id])).rows[0];
      const auth = await authority(user, conn.body_id, { c });
      need(auth, 'licences', conn.sport_id);

      if (i.resolution === 'keep_platform') {
        await c.query(`UPDATE fed_staged_credentials SET status='rejected',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`, [i.id, user.id, i.note ?? 'Conflict resolved: platform record kept']);
        if (sc.existing_licence_id)
          await c.query(`UPDATE fed_licences SET sync_status='manual',updated_at=now() WHERE id=$1`, [sc.existing_licence_id]);
        await logRecon(c, 'staged_credential', i.id, 'conflict_keep_platform', user.id, { note: i.note });
      } else if (i.resolution === 'adopt_external') {
        if (!sc.matched_user_id || sc.match_confidence !== 'confirmed')
          throw badRequest('Cannot adopt: identity match must be confirmed');
        if (sc.existing_licence_id) {
          await c.query(`UPDATE fed_licences SET grade=$2, sync_status='in_sync', external_ref=$3, connector_id=$4, last_synced_at=now(), updated_at=now() WHERE id=$1`,
            [sc.existing_licence_id, sc.mapped_grade ?? sc.external_grade, sc.external_ref, sc.connector_id]);
          await logFed(c, conn.body_id, 'licence', sc.existing_licence_id, 'conflict_adopted_external', { actor: user.id, note: i.note });
        }
        await c.query(`UPDATE fed_staged_credentials SET status='accepted',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`, [i.id, user.id, i.note ?? 'Conflict resolved: external record adopted']);
        await logRecon(c, 'staged_credential', i.id, 'conflict_adopt_external', user.id, { note: i.note });
      } else {
        // Escalate: open licence_issue gov_case
        const gc = (await c.query(
          `INSERT INTO gov_cases(kind,status,category,sport_id,subject_user_id,subject_role,source,needs_review,review_reason,opened_by,connector_id,external_ref)
           VALUES('licence_issue','received','credential_conflict',$1,$2,'official',$3::jsonb,true,'Credential conflict escalated for formal review',$4,$5,$6) RETURNING id`,
          [conn.sport_id ?? null, sc.matched_user_id,
           JSON.stringify({ type: 'federation_import', id: sc.id, conflict_type: sc.conflict_type }),
           user.id, conn.body_id, sc.external_ref])).rows[0];
        await c.query(`UPDATE fed_staged_credentials SET status='disputed',dispute_case_id=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4,updated_at=now() WHERE id=$1`,
          [i.id, gc.id, user.id, i.note ?? 'Escalated to formal case']);
        await logRecon(c, 'staged_credential', i.id, 'conflict_escalated', user.id, { case_id: gc.id, note: i.note });
        return { resolution: 'escalated', case_id: gc.id };
      }
    } else {
      const sd = (await c.query('SELECT * FROM fed_staged_disciplinary WHERE id=$1 AND status=\'conflict\' FOR UPDATE', [i.id])).rows[0];
      if (!sd) throw notFound('Disciplinary conflict');
      const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [sd.connector_id])).rows[0];
      const auth = await authority(user, conn.body_id, { c });
      need(auth, 'sanctions', conn.sport_id);

      if (i.resolution === 'keep_platform') {
        await c.query(`UPDATE fed_staged_disciplinary SET status='rejected',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`, [i.id, user.id, i.note ?? 'Conflict resolved: platform record kept']);
        if (sd.existing_case_id) await c.query(`UPDATE gov_cases SET needs_review=false, updated_at=now() WHERE id=$1`, [sd.existing_case_id]);
        await logRecon(c, 'staged_disciplinary', i.id, 'conflict_keep_platform', user.id, { note: i.note });
      } else if (i.resolution === 'adopt_external') {
        if (sd.existing_sanction_id) {
          const newSanction = (await c.query(
            `INSERT INTO disc_sanctions(case_id,kind,scope,status,external_ref,connector_id,provenance_batch_id,replaces_id,decided_at,decided_by)
             VALUES($1,$2,'competition','active',$3,$4,$5,$6,now(),$7) RETURNING id`,
            [sd.existing_case_id, sd.mapped_sanction_kind ?? 'other', sd.external_ref, sd.connector_id, sd.batch_id, sd.existing_sanction_id, user.id])).rows[0];
          await logFed(c, conn.body_id, 'sanction', newSanction.id, 'conflict_adopted_external', { actor: user.id, replaces: sd.existing_sanction_id });
        }
        if (sd.existing_case_id) {
          await c.query(`UPDATE gov_cases SET needs_review=false, updated_at=now() WHERE id=$1`, [sd.existing_case_id]);
          await c.query(`INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,(SELECT coalesce(max(version),0)+1 FROM gov_case_events WHERE case_id=$1),'review_cleared',$2,$3)`,
            [sd.existing_case_id, user.id, 'Conflict resolved: external record adopted']);
        }
        await c.query(`UPDATE fed_staged_disciplinary SET status='accepted',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`, [i.id, user.id, i.note]);
        await logRecon(c, 'staged_disciplinary', i.id, 'conflict_adopt_external', user.id, { note: i.note });
      } else {
        const gc = (await c.query(
          `INSERT INTO gov_cases(kind,status,category,sport_id,subject_user_id,subject_role,source,needs_review,review_reason,opened_by,connector_id,external_ref)
           VALUES('discipline','received','discipline_conflict',$1,$2,'official',$3::jsonb,true,'Discipline conflict escalated for formal review',$4,$5,$6) RETURNING id`,
          [conn.sport_id ?? null, sd.matched_user_id,
           JSON.stringify({ type: 'federation_import', id: sd.id, conflict_type: sd.conflict_type }),
           user.id, conn.body_id, sd.external_ref])).rows[0];
        await c.query(`UPDATE fed_staged_disciplinary SET status='disputed',reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$1`, [i.id, user.id, i.note]);
        await logRecon(c, 'staged_disciplinary', i.id, 'conflict_escalated', user.id, { case_id: gc.id });
        return { resolution: 'escalated', case_id: gc.id };
      }
    }
    await audit(c, user.id, 'resolve_reconciliation_conflict', 'fed_staged_disciplinary', i.id);
    return { resolution: i.resolution };
  }),
});

// ------------------------------------------------------------------ needs_review queue actions
cap({
  name: 'flag_case_needs_review', method: 'POST', path: '/federation-cases/:id/flag-review', tag: TAG,
  summary: 'Flag an existing gov_case for reconciliation review (needs_review=true). Use when external data has been corrected or new evidence from a federation import conflicts with the existing case. Appends a flagged event — existing events are never edited.',
  input: z.object({ id, review_reason: text(300).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const gc = (await c.query('SELECT * FROM gov_cases WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!gc) throw notFound('Case');
    if (gc.connector_id) {
      const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [gc.connector_id])).rows[0];
      if (conn) { const auth = await authority(user, conn.body_id, { c }); need(auth, 'compliance'); }
    } else if (!isPlatform(user)) throw forbidden('Only federation compliance officers or platform admins can flag cases for review');
    await c.query(`UPDATE gov_cases SET needs_review=true,review_reason=$2,row_version=row_version+1,updated_at=now() WHERE id=$1`, [i.id, i.review_reason]);
    await c.query(`INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,(SELECT coalesce(max(version),0)+1 FROM gov_case_events WHERE case_id=$1),'flagged',$2,$3)`,
      [i.id, user.id, i.review_reason]);
    await logRecon(c, 'staged_disciplinary', i.id, 'case_flagged', user.id, { review_reason: i.review_reason });
    await audit(c, user.id, 'flag_case_needs_review', 'gov_cases', i.id);
    return { case_id: i.id, needs_review: true };
  }),
});

cap({
  name: 'clear_case_review', method: 'POST', path: '/federation-cases/:id/clear-review', tag: TAG,
  summary: 'Clear the needs_review flag on a gov_case after the review is complete. Appends a review_cleared event — existing events are never edited or deleted.',
  input: z.object({ id, resolution_note: text(500).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const gc = (await c.query('SELECT * FROM gov_cases WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!gc) throw notFound('Case');
    if (!gc.needs_review) throw conflict('This case is not flagged for review');
    if (gc.connector_id) {
      const conn = (await c.query('SELECT * FROM fed_credential_connectors WHERE id=$1', [gc.connector_id])).rows[0];
      if (conn) { const auth = await authority(user, conn.body_id, { c }); need(auth, 'compliance'); }
    } else if (!isPlatform(user)) throw forbidden('Only federation compliance officers or platform admins can clear review flags');
    await c.query(`UPDATE gov_cases SET needs_review=false,review_reason=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1`, [i.id]);
    await c.query(`INSERT INTO gov_case_events(id,case_id,version,action,actor_id,note) VALUES(gen_random_uuid(),$1,(SELECT coalesce(max(version),0)+1 FROM gov_case_events WHERE case_id=$1),'review_cleared',$2,$3)`,
      [i.id, user.id, i.resolution_note]);
    await logRecon(c, 'staged_disciplinary', i.id, 'case_review_cleared', user.id, { note: i.resolution_note });
    await audit(c, user.id, 'clear_case_review', 'gov_cases', i.id);
    return { case_id: i.id, needs_review: false };
  }),
});

// ------------------------------------------------------------------ internal helpers
function hashToInt(str) {
  let h = BigInt(0);
  for (const ch of str) h = (h * 31n + BigInt(ch.charCodeAt(0))) % (2n ** 31n);
  return Number(h);
}

function parseDiscFile(buf, _mapping) {
  try {
    const text = buf.toString('utf-8').trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      const data = JSON.parse(text);
      const rows = Array.isArray(data) ? data : [data];
      return rows.map((r, idx) => normaliseDiscRecord(r, idx));
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    return lines.slice(1).map((line, idx) => {
      const cols = line.split(',');
      const rec = {};
      headers.forEach((h, j) => { rec[h] = (cols[j] ?? '').trim(); });
      return normaliseDiscRecord(rec, idx);
    });
  } catch { return []; }
}

function normaliseDiscRecord(r, idx) {
  const extKind = r.kind ?? r.type ?? r.category ?? r.offence_type ?? '';
  const extSanctionKind = r.sanction ?? r.punishment ?? r.sanction_type ?? '';
  return {
    external_ref: r.id ?? r.ref ?? r.case_id ?? r.external_ref ?? `disc_row_${idx}`,
    external_identifier: r.registration_number ?? r.reg_no ?? r.external_id ?? null,
    external_kind: extKind || null,
    mapped_kind: mapDiscKind(extKind),
    external_sanction_kind: extSanctionKind || null,
    mapped_sanction_kind: mapSanctionKind(extSanctionKind),
    incident_date: r.incident_date ?? r.offence_date ?? r.match_date ?? null,
    decided_date: r.decided_date ?? r.decision_date ?? null,
    outcome: r.outcome ?? r.result ?? null,
    sanction_detail: r.sanction_detail ?? r.detail ?? null,
    holder_name: r.name ?? r.full_name ?? r.player_name ?? null,
    raw: r,
  };
}

async function stageDiscRecords(c, conn, batchId, records) {
  const counts = { total: records.length, created: 0, conflict: 0, failed: 0 };
  for (const rec of records) {
    try {
      // Identity lookup
      const identityMatch = rec.external_identifier
        ? (await c.query(`SELECT user_id FROM external_identities WHERE external_id=$1 AND status='confirmed' LIMIT 1`, [rec.external_identifier])).rows[0]
        : null;
      const matchedUserId = identityMatch?.user_id ?? null;
      const matchConf = identityMatch ? 'confirmed' : null;

      // Check for existing case with same external_ref from this connector
      let existingCaseId = null, existingSanctionId = null, status = matchedUserId ? 'matched' : 'pending', conflictType = null, conflictDetail = null;
      if (matchedUserId) {
        const exCase = (await c.query(`SELECT id, outcome FROM gov_cases WHERE connector_id=$1 AND external_ref=$2 LIMIT 1`, [conn.id, rec.external_ref])).rows[0];
        if (exCase) {
          existingCaseId = exCase.id;
          if (exCase.outcome && rec.outcome && exCase.outcome !== rec.outcome) {
            status = 'conflict'; conflictType = 'outcome_conflict'; conflictDetail = { existing_outcome: exCase.outcome, incoming_outcome: rec.outcome }; counts.conflict++;
          }
          const exSanction = (await c.query(`SELECT id FROM disc_sanctions WHERE external_ref=$1 AND connector_id=$2 AND status='active' LIMIT 1`, [rec.external_ref, conn.id])).rows[0];
          if (exSanction) existingSanctionId = exSanction.id;
        }
      }

      const existing = (await c.query('SELECT id, status FROM fed_staged_disciplinary WHERE connector_id=$1 AND external_ref=$2', [conn.id, rec.external_ref])).rows[0];
      if (existing) { if (['accepted','rejected'].includes(existing.status)) continue; }
      else {
        await c.query(
          `INSERT INTO fed_staged_disciplinary(batch_id,connector_id,external_ref,raw_payload,matched_user_id,match_confidence,external_kind,mapped_kind,external_sanction_kind,mapped_sanction_kind,incident_date,decided_date,outcome,sanction_detail,status,conflict_type,conflict_detail,existing_case_id,existing_sanction_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [batchId, conn.id, rec.external_ref, JSON.stringify(rec.raw), matchedUserId, matchConf,
           rec.external_kind, rec.mapped_kind, rec.external_sanction_kind, rec.mapped_sanction_kind,
           rec.incident_date, rec.decided_date, rec.outcome, rec.sanction_detail ? JSON.stringify(rec.sanction_detail) : null,
           status, conflictType, conflictDetail ? JSON.stringify(conflictDetail) : null, existingCaseId, existingSanctionId]);
        counts.created++;
        // Set needs_review on matching existing gov_case
        if (existingCaseId)
          await c.query(`UPDATE gov_cases SET needs_review=true,review_reason='External federation import has a conflicting or updated record',row_version=row_version+1,updated_at=now() WHERE id=$1 AND needs_review=false`, [existingCaseId]);
      }
    } catch { counts.failed++; }
  }
  return counts;
}
