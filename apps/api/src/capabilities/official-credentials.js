// Official Credential Verification Hub (#993 REF-R02).
// Federation-issued credential lifecycle: self-submission, encrypted private proof, evidence vault,
// federation reviewer queue with checklist and decision, renewal, re-verification, badge on public profile.
// Distinct from official-verification.js (standing attestation) and official-profile.js (self-declared credentials).
// Security: officials see only their own credentials (404 for others); reviewer access requires governing_body_roles;
// private_proof is encrypted and reveal is audit-logged; reviewer notes are encrypted and never returned to the official.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, hasRole } from '../helpers.js';
import { requireApproved } from '../access.js';
import { notify } from '../notify.js';

const TAG = 'Official credentials';
const text = (n) => z.string().trim().max(n);
const textMin = (n, x) => z.string().trim().min(n).max(x);
const SCOPES = ['international', 'national', 'regional', 'district', 'club'];
const CRED_STATUSES = ['draft', 'submitted', 'under_review', 'needs_info', 'active', 'rejected', 'suspended', 'expired', 'revoked', 'withdrawn'];
const REVIEW_STATUSES = ['pending', 'under_review', 'info_requested', 'approved', 'rejected', 'withdrawn'];
const today = () => new Date().toISOString().slice(0, 10);

/** Only the holder (or admin) may access a credential. Returns 404 to prevent existence leaks. */
async function ownLicence(c, licenceId, userId, isAdmin = false) {
  const row = (await c.query('SELECT * FROM fed_licences WHERE id=$1', [licenceId])).rows[0];
  if (!row) throw notFound('Credential');
  if (!isAdmin && row.holder_id !== userId) throw notFound('Credential');
  return row;
}

/** Check whether a user has a licensing role in the governing body that issued the licence. */
async function isLicensingReviewer(c, userId, bodyId) {
  const r = (await c.query(
    "SELECT 1 FROM governing_body_roles WHERE body_id=$1 AND user_id=$2 AND role IN ('registrar','licensing') AND status='active' LIMIT 1",
    [bodyId, userId])).rows[0];
  return !!r;
}

/** Mask the licence_no: show first 4 + bullets */
function maskLicenceNo(no) {
  if (!no || no.length <= 4) return no;
  return no.slice(0, Math.min(8, no.length - 4)) + '●●●●';
}

/** Strip reviewer-only fields before returning to the licence holder */
function safeCredential(row, includePrivateProof = false) {
  const { private_proof_enc, ...rest } = row;
  return {
    ...rest,
    licence_no_masked: maskLicenceNo(row.licence_no),
    has_private_proof: !!private_proof_enc,
    private_proof: includePrivateProof && private_proof_enc ? decrypt(private_proof_enc, 'fed_licences.private_proof') : undefined,
  };
}

// ------------------------------------------------------------------ official: list own credentials
cap({
  name: 'list_my_credentials', method: 'GET', path: '/me/credentials', tag: TAG,
  summary: 'List all federation-issued credentials for the signed-in official, with expiry status and badge settings. Private proof is never returned here.',
  input: z.object({
    status: z.enum(CRED_STATUSES).optional(),
    sport_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    const rows = await many(
      `SELECT l.id, l.body_id, l.type_id, l.holder_id, l.status, l.licence_no, l.grade, l.scope,
              l.disciplines, l.region, l.issued_on, l.expires_on, l.badge_on_profile, l.row_version,
              l.submitted_at, l.created_at, l.updated_at,
              gb.organisation_id, o.name AS body_name,
              lt.sport_id, lt.name AS licence_type, lt.holder_role,
              s.name AS sport_name, s.emoji AS sport_emoji,
              (SELECT json_build_object('id', r.id, 'status', r.status, 'created_at', r.created_at, 'decision_at', r.decision_at)
                 FROM official_cred_reviews r WHERE r.fed_licence_id=l.id ORDER BY r.created_at DESC LIMIT 1) AS latest_review,
              CASE WHEN l.expires_on IS NOT NULL AND l.expires_on < current_date THEN true ELSE false END AS is_expired,
              CASE WHEN l.expires_on IS NOT NULL AND l.expires_on BETWEEN current_date AND current_date + 30 THEN true ELSE false END AS expiring_soon
         FROM fed_licences l
         JOIN governing_bodies gb ON gb.id = l.body_id
         JOIN organisations o ON o.id = gb.organisation_id
         JOIN fed_licence_types lt ON lt.id = l.type_id
         LEFT JOIN sports s ON s.id = lt.sport_id
        WHERE l.holder_id = $1
          AND ($2::text IS NULL OR l.status = $2)
          AND ($3::uuid IS NULL OR lt.sport_id = $3)
        ORDER BY l.created_at DESC
        LIMIT $4 OFFSET $5`,
      [user.id, i.status || null, i.sport_id || null, i.limit, i.offset]);
    return rows.map((r) => safeCredential(r));
  },
});

// ------------------------------------------------------------------ official: get one credential detail
cap({
  name: 'get_my_credential', method: 'GET', path: '/me/credentials/:id', tag: TAG,
  summary: 'Get full detail of one federation credential the signed-in official holds. Private proof is not returned; use the reveal endpoint.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      const [evidence, reviews, auditLog] = await Promise.all([
        c.query(`SELECT id, requirement, file_name, content_type, size_bytes, added_by, created_at
                   FROM fed_evidence WHERE subject_type='licence' AND subject_id=$1 AND removed_at IS NULL ORDER BY created_at`, [i.id]),
        c.query(`SELECT id, status, request_no, decision_at, created_at, updated_at
                   FROM official_cred_reviews WHERE fed_licence_id=$1 ORDER BY created_at DESC`, [i.id]),
        c.query(`SELECT action, entity, entity_id, actor_id, created_at FROM audit_log WHERE entity='fed_licences' AND entity_id=$1 ORDER BY created_at DESC LIMIT 50`, [i.id]),
      ]);
      return {
        ...safeCredential(row),
        evidence: evidence.rows,
        reviews: reviews.rows,
        audit_trail: auditLog.rows,
      };
    });
  },
});

// ------------------------------------------------------------------ official: reveal private proof (audit-logged)
cap({
  name: 'reveal_credential_private_proof', method: 'POST', path: '/me/credentials/:id/reveal-proof', tag: TAG,
  summary: 'Reveal the encrypted private proof (verification PIN / code) for one credential. Every call is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      if (!row.private_proof_enc) throw notFound('Private proof');
      await audit(c, user.id, 'credential.private_proof_revealed', 'fed_licences', i.id);
      return { private_proof: decrypt(row.private_proof_enc, 'fed_licences.private_proof') };
    });
  },
});

// ------------------------------------------------------------------ official: submit for verification
cap({
  name: 'submit_credential_for_review', method: 'POST', path: '/me/credentials/:id/submit', tag: TAG,
  summary: 'Submit a draft or rejected credential to the issuing federation for verification. Creates a review record and notifies the body\'s licensing team.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      if (!['draft', 'rejected', 'needs_info'].includes(row.status)) throw conflict(`Credential is already ${row.status}`);
      const existing = (await c.query("SELECT id FROM official_cred_reviews WHERE fed_licence_id=$1 AND status IN ('pending','under_review','info_requested')", [i.id])).rows[0];
      if (existing) throw conflict('A review is already open for this credential');
      await c.query("UPDATE fed_licences SET status='submitted', submitted_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$1", [i.id]);
      const review = (await c.query(
        "INSERT INTO official_cred_reviews(fed_licence_id, reviewer_org_id, status, request_no) VALUES ($1, $2, 'pending', $3) RETURNING *",
        [i.id, row.body_id, `CR-${new Date().getUTCFullYear()}-${Date.now().toString(36).toUpperCase()}`])).rows[0];
      await audit(c, user.id, 'credential.submitted', 'fed_licences', i.id);
      // notify body's licensing staff
      const licRoles = (await c.query(
        "SELECT user_id FROM governing_body_roles WHERE body_id=$1 AND role IN ('registrar','licensing') AND status='active'",
        [row.body_id])).rows;
      for (const lr of licRoles) {
        await notify(c, lr.user_id, { kind: 'credential_review', title: 'New credential review request', body: 'A new licence has been submitted for verification.', data: { review_id: review.id, licence_id: i.id } }).catch(() => {});
      }
      return { review_id: review.id, status: 'submitted' };
    });
  },
});

// ------------------------------------------------------------------ official: request re-verification
cap({
  name: 'request_credential_reverification', method: 'POST', path: '/me/credentials/:id/re-verify', tag: TAG,
  summary: 'Request re-verification of an already verified or expiring credential. Opens a new review in the federation\'s queue.',
  input: z.object({ id, reason: text(500).optional() }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      if (!['active', 'expired'].includes(row.status)) throw conflict(`Cannot re-verify a credential in status ${row.status}`);
      const existing = (await c.query("SELECT id FROM official_cred_reviews WHERE fed_licence_id=$1 AND status IN ('pending','under_review','info_requested')", [i.id])).rows[0];
      if (existing) throw conflict('A review is already open');
      const review = (await c.query(
        "INSERT INTO official_cred_reviews(fed_licence_id, reviewer_org_id, status, request_no) VALUES ($1, $2, 'pending', $3) RETURNING *",
        [i.id, row.body_id, `RV-${new Date().getUTCFullYear()}-${Date.now().toString(36).toUpperCase()}`])).rows[0];
      await audit(c, user.id, 'credential.reverification_requested', 'fed_licences', i.id);
      return { review_id: review.id };
    });
  },
});

// ------------------------------------------------------------------ official: start renewal
cap({
  name: 'start_credential_renewal', method: 'POST', path: '/me/credentials/:id/renew', tag: TAG,
  summary: 'Start a renewal application for an expiring or expired credential. Creates a new fed_licence row linked to the current one (previous_id).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      if (!['active', 'expired', 'suspended'].includes(row.status)) throw conflict(`Cannot renew a credential in status ${row.status}`);
      const existing = (await c.query('SELECT id FROM fed_licences WHERE previous_id=$1 AND status IN ($2,$3,$4,$5,$6)', [i.id, 'draft', 'submitted', 'under_review', 'needs_info', 'active'])).rows[0];
      if (existing) throw conflict('A renewal is already in progress');
      const renewal = (await c.query(
        `INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, grade, scope, disciplines, region, previous_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, now(), now()) RETURNING id`,
        [row.body_id, row.type_id, row.holder_id, user.id, row.grade, row.scope, row.disciplines, row.region, i.id])).rows[0];
      await audit(c, user.id, 'credential.renewal_started', 'fed_licences', renewal.id);
      return { renewal_id: renewal.id, status: 'draft' };
    });
  },
});

// ------------------------------------------------------------------ official: toggle badge on profile
cap({
  name: 'toggle_credential_badge', method: 'PATCH', path: '/me/credentials/:id/badge', tag: TAG,
  summary: 'Show or hide a verified credential badge on the public official profile. Only verified credentials may show a badge.',
  input: z.object({ id, badge_on_profile: z.boolean() }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const row = await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      if (i.badge_on_profile && row.status !== 'active') throw badRequest('Only verified (active) credentials can show a badge on your profile');
      await c.query('UPDATE fed_licences SET badge_on_profile=$1, updated_at=now(), row_version=row_version+1 WHERE id=$2', [i.badge_on_profile, i.id]);
      await audit(c, user.id, `credential.badge_${i.badge_on_profile ? 'shown' : 'hidden'}`, 'fed_licences', i.id);
      return { badge_on_profile: i.badge_on_profile };
    });
  },
});

// ------------------------------------------------------------------ reviewer: list queue
cap({
  name: 'list_credential_review_queue', method: 'GET', path: '/credential-reviews', tag: TAG,
  summary: 'Federation licensing staff: list pending credential review requests for governing bodies the caller administers. Sorted by SLA urgency.',
  input: z.object({
    body_id: id.optional(),
    status: z.enum(REVIEW_STATUSES).optional(),
    sport_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    // Find bodies where the caller is a registrar or licensing officer
    const bodies = await many(
      "SELECT body_id FROM governing_body_roles WHERE user_id=$1 AND role IN ('registrar','licensing') AND status='active'",
      [user.id]);
    if (!bodies.length && !hasRole(user, 'admin')) throw forbidden('No federation licensing role found');
    const bodyIds = bodies.map((b) => b.body_id);
    const rows = await many(
      `SELECT r.id, r.fed_licence_id, r.status, r.request_no, r.decision_at, r.created_at, r.reviewer_user_id,
              l.licence_no, l.grade, l.scope, l.disciplines, l.region, l.expires_on, l.body_id,
              lt.name AS licence_type, lt.holder_role,
              s.name AS sport_name, s.emoji AS sport_emoji,
              u.id AS holder_user_id, u.display_name AS holder_name, u.avatar_emoji, u.avatar_color,
              o.name AS body_name
         FROM official_cred_reviews r
         JOIN fed_licences l ON l.id = r.fed_licence_id
         JOIN fed_licence_types lt ON lt.id = l.type_id
         LEFT JOIN sports s ON s.id = lt.sport_id
         JOIN users u ON u.id = l.holder_id
         JOIN governing_bodies gb ON gb.id = l.body_id
         JOIN organisations o ON o.id = gb.organisation_id
        WHERE (l.body_id = ANY($1::uuid[]) OR $2)
          AND ($3::uuid IS NULL OR l.body_id = $3)
          AND ($4::text IS NULL OR r.status = $4)
          AND ($5::uuid IS NULL OR lt.sport_id = $5)
        ORDER BY
          CASE r.status WHEN 'info_requested' THEN 1 WHEN 'under_review' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,
          r.created_at ASC
        LIMIT $6 OFFSET $7`,
      [bodyIds, hasRole(user, 'admin'), i.body_id || null, i.status || null, i.sport_id || null, i.limit, i.offset]);
    return rows;
  },
});

// ------------------------------------------------------------------ reviewer: get review detail (evidence decryption is separate)
cap({
  name: 'get_credential_review', method: 'GET', path: '/credential-reviews/:id', tag: TAG,
  summary: 'Get full detail of a credential review including checklist state. Evidence files are listed (metadata only); decrypt each via the evidence endpoint.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const review = (await c.query('SELECT * FROM official_cred_reviews WHERE id=$1', [i.id])).rows[0];
      if (!review) throw notFound('Credential review');
      const licence = (await c.query('SELECT * FROM fed_licences WHERE id=$1', [review.fed_licence_id])).rows[0];
      if (!licence) throw notFound('Credential');
      const isAdmin_ = hasRole(user, 'admin');
      const isReviewer = await isLicensingReviewer(c, user.id, licence.body_id);
      if (!isAdmin_ && !isReviewer) throw notFound('Credential review');
      const [evidence, auditLog] = await Promise.all([
        c.query(`SELECT id, requirement, file_name, content_type, size_bytes, added_by, created_at
                   FROM fed_evidence WHERE subject_type='licence' AND subject_id=$1 AND removed_at IS NULL ORDER BY created_at`, [review.fed_licence_id]),
        c.query(`SELECT action, entity_id, actor_id, created_at FROM audit_log WHERE entity='fed_licences' AND entity_id=$1 ORDER BY created_at DESC LIMIT 30`, [review.fed_licence_id]),
      ]);
      // reviewer notes decrypted for reviewer only, never returned to holder
      const notes = review.reviewer_notes_enc ? decrypt(review.reviewer_notes_enc, 'official_cred_reviews.reviewer_notes') : null;
      if (notes) await audit(c, user.id, 'credential.reviewer_notes_read', 'official_cred_reviews', i.id);
      const licRow = { ...licence };
      delete licRow.private_proof_enc;
      return {
        review: { ...review, reviewer_notes: notes, reviewer_notes_enc: undefined },
        licence: { ...licRow, licence_no_masked: maskLicenceNo(licence.licence_no) },
        evidence: evidence.rows,
        audit_trail: auditLog.rows,
      };
    });
  },
});

// ------------------------------------------------------------------ reviewer: claim (take into review)
cap({
  name: 'claim_credential_review', method: 'POST', path: '/credential-reviews/:id/claim', tag: TAG,
  summary: 'Licensing reviewer claims a pending review to work on it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const review = (await c.query('SELECT * FROM official_cred_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!review) throw notFound('Review');
      const licence = (await c.query('SELECT body_id FROM fed_licences WHERE id=$1', [review.fed_licence_id])).rows[0];
      const isAdmin_ = hasRole(user, 'admin');
      if (!isAdmin_ && !(await isLicensingReviewer(c, user.id, licence.body_id))) throw notFound('Review');
      if (review.status !== 'pending') throw conflict(`Review is already ${review.status}`);
      await c.query("UPDATE official_cred_reviews SET status='under_review', reviewer_user_id=$1, updated_at=now() WHERE id=$2", [user.id, i.id]);
      await c.query("UPDATE fed_licences SET status='under_review', updated_at=now(), row_version=row_version+1 WHERE id=$1", [review.fed_licence_id]);
      await audit(c, user.id, 'credential.review_claimed', 'official_cred_reviews', i.id);
      return { status: 'under_review' };
    });
  },
});

// ------------------------------------------------------------------ reviewer: decide
cap({
  name: 'decide_credential_review', method: 'POST', path: '/credential-reviews/:id/decide', tag: TAG,
  summary: 'Approve, reject, or request more information for a credential. Approving sets status to active; rejecting records the reason (encrypted, reviewer only).',
  input: z.object({
    id,
    decision: z.enum(['approved', 'rejected', 'info_requested']),
    reviewer_notes: text(2000).optional(),
    checklist: z.record(z.string(), z.boolean()).optional(),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const review = (await c.query('SELECT * FROM official_cred_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!review) throw notFound('Review');
      const licence = (await c.query('SELECT * FROM fed_licences WHERE id=$1 FOR UPDATE', [review.fed_licence_id])).rows[0];
      const isAdmin_ = hasRole(user, 'admin');
      if (!isAdmin_ && !(await isLicensingReviewer(c, user.id, licence.body_id))) throw notFound('Review');
      if (!['pending', 'under_review', 'info_requested'].includes(review.status)) throw conflict(`Review is already ${review.status}`);
      const notesEnc = i.reviewer_notes ? encrypt(i.reviewer_notes, 'official_cred_reviews.reviewer_notes') : review.reviewer_notes_enc;
      const newReviewStatus = i.decision;
      const newLicenceStatus = i.decision === 'approved' ? 'active' : i.decision === 'rejected' ? 'rejected' : 'needs_info';
      await c.query(
        'UPDATE official_cred_reviews SET status=$1, reviewer_notes_enc=$2, checklist=$3, decision_at=now(), reviewer_user_id=$4, updated_at=now() WHERE id=$5',
        [newReviewStatus, notesEnc, JSON.stringify({ ...review.checklist, ...(i.checklist || {}) }), user.id, i.id]);
      await c.query('UPDATE fed_licences SET status=$1, decided_by=$2, decided_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$2', [newLicenceStatus, user.id, licence.id]);
      await audit(c, user.id, `credential.review_${i.decision}`, 'official_cred_reviews', i.id);
      // notify the holder
      const msgMap = { approved: 'Your credential has been verified.', rejected: 'Your credential review was not approved. Check the review for details.', info_requested: 'Your credential reviewer has requested additional information.' };
      await notify(c, licence.holder_id, { kind: 'credential_decision', title: 'Credential update', body: msgMap[i.decision], data: { licence_id: licence.id, review_id: i.id } }).catch(() => {});
      return { status: newReviewStatus, licence_status: newLicenceStatus };
    });
  },
});

// ------------------------------------------------------------------ reviewer: decrypt evidence (audit-logged)
cap({
  name: 'decrypt_credential_evidence', method: 'POST', path: '/credential-reviews/:id/evidence/:evidenceId/decrypt', tag: TAG,
  summary: 'Decrypt and return an evidence file reference for review. Encrypted at rest; every call is audit-logged with who, what, when.',
  input: z.object({ id, evidenceId: id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const review = (await c.query('SELECT * FROM official_cred_reviews WHERE id=$1', [i.id])).rows[0];
      if (!review) throw notFound('Review');
      const licence = (await c.query('SELECT body_id FROM fed_licences WHERE id=$1', [review.fed_licence_id])).rows[0];
      const isAdmin_ = hasRole(user, 'admin');
      if (!isAdmin_ && !(await isLicensingReviewer(c, user.id, licence.body_id))) throw notFound('Review');
      const ev = (await c.query("SELECT * FROM fed_evidence WHERE id=$1 AND subject_type='licence' AND subject_id=$2 AND removed_at IS NULL", [i.evidenceId, review.fed_licence_id])).rows[0];
      if (!ev) throw notFound('Evidence');
      await audit(c, user.id, 'credential.evidence_decrypted', 'fed_evidence', ev.id);
      return {
        id: ev.id,
        file_name: ev.file_name,
        content_type: ev.content_type,
        reference: ev.reference_enc ? decrypt(ev.reference_enc, 'fed_evidence.reference') : null,
        file_enc: ev.file_enc || null,
      };
    });
  },
});

// ------------------------------------------------------------------ public: verified badges on a profile
cap({
  name: 'get_official_credential_badges', method: 'GET', path: '/official-profiles/:id/credential-badges', tag: TAG, auth: 'public',
  summary: 'Public: return verified credential badges for an official\'s profile (only where badge_on_profile=true and status=active).',
  input: z.object({ id }),
  async handler(_ctx, i) {
    return many(
      `SELECT l.id, l.grade, l.scope, l.disciplines, l.issued_on, l.expires_on,
              lt.name AS licence_type, lt.holder_role,
              s.name AS sport_name, s.emoji AS sport_emoji,
              o.name AS body_name, gb.abbreviation AS body_abbr
         FROM fed_licences l
         JOIN official_profiles p ON p.user_id = l.holder_id
         JOIN fed_licence_types lt ON lt.id = l.type_id
         LEFT JOIN sports s ON s.id = lt.sport_id
         JOIN governing_bodies gb ON gb.id = l.body_id
         JOIN organisations o ON o.id = gb.organisation_id
        WHERE p.id = $1 AND l.badge_on_profile = true AND l.status = 'active' AND p.archived_at IS NULL
        ORDER BY l.scope, l.created_at`,
      [i.id]);
  },
});

// ------------------------------------------------------------------ official: audit trail
cap({
  name: 'get_credential_audit_trail', method: 'GET', path: '/me/credentials/:id/audit', tag: TAG,
  summary: 'Full audit trail for one of the signed-in official\'s credentials: submissions, decisions, evidence reads, proof reveals.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      await ownLicence(c, i.id, user.id, hasRole(user, 'admin'));
      return many(
        `SELECT a.action, a.entity, a.entity_id, a.actor_id, a.created_at, u.display_name AS actor_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE (a.entity = 'fed_licences' AND a.entity_id = $1)
             OR (a.entity = 'official_cred_reviews' AND a.entity_id IN (SELECT id FROM official_cred_reviews WHERE fed_licence_id=$1))
          ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
        [i.id, i.limit, i.offset]);
    });
  },
});

// ------------------------------------------------------------------ update reviewer checklist
cap({
  name: 'update_credential_checklist', method: 'PATCH', path: '/credential-reviews/:id/checklist', tag: TAG,
  summary: 'Update the reviewer\'s verification checklist for a credential review (ticking/unticking items).',
  input: z.object({ id, checklist: z.record(z.string(), z.boolean()) }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const review = (await c.query('SELECT * FROM official_cred_reviews WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!review) throw notFound('Review');
      const licence = (await c.query('SELECT body_id FROM fed_licences WHERE id=$1', [review.fed_licence_id])).rows[0];
      const isAdmin_ = hasRole(user, 'admin');
      if (!isAdmin_ && !(await isLicensingReviewer(c, user.id, licence.body_id))) throw notFound('Review');
      const merged = { ...review.checklist, ...i.checklist };
      await c.query('UPDATE official_cred_reviews SET checklist=$1, updated_at=now() WHERE id=$2', [JSON.stringify(merged), i.id]);
      return { checklist: merged };
    });
  },
});
