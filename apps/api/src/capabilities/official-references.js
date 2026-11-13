// Referee professional references and endorsements (#1002 REF-R33).
// Extends official_portfolio_references (migration 207 + 219).
// Distinct from: official-reputation.js (public testimony / off_testimony),
//                officials-assessments.js (formal private assessments),
//                official-career-portfolio.js (portfolio view + basic portfolio/references/* endpoints).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Officials';
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
  .split(',').map((e) => e.trim()).filter(Boolean);
const text = (n) => z.string().trim().min(1).max(n);
const REF_TYPES = /** @type {const} */ (['federation','club','assignor','academy','coach','event_organiser']);
const REPORT_REASONS = /** @type {const} */ (['self_endorsement','conflict','inaccurate','abusive','spam','other']);
const TOKEN_BYTES = 24; // 48 hex chars
const TOKEN_TTL_DAYS = 14;

// ------------------------------------------------------------------ helpers

function refAudit(c, refId, actorId, action, payload = {}) {
  return c.query(
    `INSERT INTO official_reference_audit(reference_id, actor_id, action, payload) VALUES ($1,$2,$3,$4)`,
    [refId, actorId, action, JSON.stringify(payload)],
  );
}

function stripEnc(r) {
  if (!r) return r;
  const { reference_text_enc, sport_context_enc, invitee_email_enc,
          contact_email_enc, contact_name_enc, request_note_enc, ...rest } = r;
  return rest;
}

async function decryptRef(r, { includeText = false, includeContext = true } = {}) {
  if (!r) return r;
  const out = { ...r };
  if (r.contact_name_enc) { out.contact_name = await decrypt(r.contact_name_enc); }
  if (r.contact_email_enc) { out.contact_email = await decrypt(r.contact_email_enc); }
  if (r.request_note_enc) { out.request_note = await decrypt(r.request_note_enc); }
  if (includeContext && r.sport_context_enc) { out.sport_context = await decrypt(r.sport_context_enc); }
  if (includeText && r.reference_text_enc && !r.is_confidential) {
    out.reference_text = await decrypt(r.reference_text_enc);
  } else {
    out.reference_text = null;
  }
  return stripEnc(out);
}

async function requireOrgStaff(c, orgId, userId, adminUser) {
  if (isAdmin(adminUser)) return;
  const ok = (await c.query(
    `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND left_at IS NULL`,
    [orgId, userId],
  )).rowCount > 0;
  if (!ok) throw forbidden('Only organisation staff can perform this action');
}

async function requirePlatformAdmin(user) {
  if (!PLATFORM_ADMIN_EMAILS.includes(user.email)) throw forbidden('Platform admin only');
}

function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

function tokenExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + TOKEN_TTL_DAYS);
  return d.toISOString();
}

// ------------------------------------------------------------------ request reference

cap({
  name: 'request_reference',
  method: 'POST',
  path: '/me/officials/references',
  tag: TAG,
  status: 201,
  summary: 'Request a professional reference from a federation, club, assignor, academy, coach or event organiser. Supports direct, verified-association and secure-link invite methods. Detects self-endorsement conflicts.',
  input: z.object({
    referee_type: z.enum(REF_TYPES),
    org_id: id.optional(),
    body_id: id.optional(),
    sport_id: id.optional(),
    tenure_from: z.string().date().optional(),
    tenure_to: z.string().date().optional(),
    sport_context: text(500).optional(),
    is_confidential: z.boolean().default(false),
    expiry_date: z.string().date().optional(),
    invite_method: z.enum(['direct','verified_association','secure_link']).default('direct'),
    invitee_email: z.string().email().max(200).optional(),
    request_note: text(800).optional(),
    contact_name: text(100).optional(),
    contact_email: z.string().email().max(200).optional(),
  }).refine(
    (r) => r.org_id || r.body_id || (r.invite_method === 'secure_link' && r.invitee_email),
    'Provide an organisation, governing body, or an email address for a secure-link invite',
  ),
  handler: ({ user }, i) => tx(async (c) => {
    const orgId = i.org_id ?? i.body_id ?? null;

    // Duplicate pending guard
    if (orgId) {
      const dup = (await c.query(
        `SELECT 1 FROM official_portfolio_references
         WHERE user_id=$1 AND (org_id=$2 OR body_id=$2) AND response_status='pending' AND revoked_at IS NULL`,
        [user.id, orgId],
      )).rowCount;
      if (dup > 0) throw conflict('A pending reference request already exists for this organisation');
    }

    // Self-endorsement detection
    let conflictFlag = false;
    let conflictReason = null;
    if (orgId) {
      const isMember = (await c.query(
        `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND left_at IS NULL`,
        [orgId, user.id],
      )).rowCount > 0;
      if (isMember) {
        conflictFlag = true;
        conflictReason = 'You are listed as a member of this organisation (self-endorsement risk)';
      }
    }

    // Encrypt PII
    const contextEnc   = i.sport_context   ? await encrypt(i.sport_context)   : null;
    const noteEnc      = i.request_note    ? await encrypt(i.request_note)    : null;
    const nameEnc      = i.contact_name    ? await encrypt(i.contact_name)    : null;
    const emailEnc     = i.contact_email   ? await encrypt(i.contact_email)   : null;
    const inviteeEnc   = i.invitee_email   ? await encrypt(i.invitee_email)   : null;

    // Secure-link token
    let token = null;
    let tokenExpires = null;
    if (i.invite_method === 'secure_link') {
      token = generateToken();
      tokenExpires = tokenExpiry();
    }

    const row = (await c.query(
      `INSERT INTO official_portfolio_references(
         user_id, org_id, body_id, sport_id, relationship,
         referee_type, invite_method, invite_token, invite_token_expires_at,
         invitee_email_enc, tenure_from, tenure_to, sport_context_enc, is_confidential,
         expiry_date, conflict_flag, conflict_reason,
         contact_name_enc, contact_email_enc, request_note_enc
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        user.id, i.org_id ?? null, i.body_id ?? null, i.sport_id ?? null,
        'worked_with', // default relationship; can be extended later
        i.referee_type, i.invite_method, token, tokenExpires,
        inviteeEnc, i.tenure_from ?? null, i.tenure_to ?? null, contextEnc, i.is_confidential,
        i.expiry_date ?? null, conflictFlag, conflictReason,
        nameEnc, emailEnc, noteEnc,
      ],
    )).rows[0];

    await refAudit(c, row.id, user.id, 'requested', { referee_type: i.referee_type, invite_method: i.invite_method, conflict_flag: conflictFlag });
    await audit(c, user.id, 'request_reference', 'official_portfolio_references', row.id);

    // Notify org admins (direct / verified_association invites)
    if (orgId && i.invite_method !== 'secure_link') {
      const admins = (await c.query(
        `SELECT user_id FROM org_members WHERE org_id=$1 AND role IN ('owner','admin') AND left_at IS NULL LIMIT 5`,
        [orgId],
      )).rows;
      for (const a of admins) {
        await notify(c, a.user_id, {
          kind: 'official_reference_request',
          title: 'Professional reference request received',
          body: 'An official is requesting a professional reference from your organisation.',
          data: { reference_id: row.id },
        });
      }
    }

    return decryptRef(row);
  }),
});

// ------------------------------------------------------------------ list my references

cap({
  name: 'list_my_references',
  method: 'GET',
  path: '/me/officials/references',
  tag: TAG,
  summary: 'List all my professional reference requests with status, type, sport, tenure and provenance. Never returns encrypted reference text.',
  input: z.object({
    ...page.shape,
    status: z.enum(['pending','approved','declined','revoked']).optional(),
    referee_type: z.enum(REF_TYPES).optional(),
  }),
  async handler({ user }, i) {
    const conditions = ['r.user_id=$1','r.moderation_status <> \'redacted\''];
    const params = [user.id];
    if (i.status) { params.push(i.status); conditions.push(`r.response_status=$${params.length}`); }
    if (i.referee_type) { params.push(i.referee_type); conditions.push(`r.referee_type=$${params.length}`); }
    const where = conditions.join(' AND ');
    params.push(i.limit ?? 25, i.offset ?? 0);
    const rows = await many(
      `SELECT r.*,
              o.name  AS org_name,  o.avatar_url  AS org_avatar,
              ob.name AS body_name, ob.avatar_url AS body_avatar,
              s.name  AS sport_name, s.emoji AS sport_emoji,
              u.display_name AS responded_by_name,
              (r.expiry_date IS NOT NULL AND r.expiry_date < now()::date) AS is_expired
       FROM official_portfolio_references r
       LEFT JOIN organisations o  ON o.id  = r.org_id
       LEFT JOIN organisations ob ON ob.id = r.body_id
       LEFT JOIN sports s         ON s.id  = r.sport_id
       LEFT JOIN users u          ON u.id  = r.responded_by
       WHERE ${where}
       ORDER BY
         CASE r.response_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return Promise.all(rows.map((r) => decryptRef(r)));
  },
});

// ------------------------------------------------------------------ get my reference detail

cap({
  name: 'get_my_reference',
  method: 'GET',
  path: '/me/officials/references/:id',
  tag: TAG,
  summary: 'Full detail of one of my reference requests including audit trail and pending corrections. Confidential references suppress the reference text.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(
      `SELECT r.*,
              o.name  AS org_name,  o.avatar_url  AS org_avatar,
              ob.name AS body_name, ob.avatar_url AS body_avatar,
              s.name  AS sport_name, s.emoji AS sport_emoji,
              u.display_name AS responded_by_name,
              (r.expiry_date IS NOT NULL AND r.expiry_date < now()::date) AS is_expired
       FROM official_portfolio_references r
       LEFT JOIN organisations o  ON o.id  = r.org_id
       LEFT JOIN organisations ob ON ob.id = r.body_id
       LEFT JOIN sports s         ON s.id  = r.sport_id
       LEFT JOIN users u          ON u.id  = r.responded_by
       WHERE r.id=$1`,
      [i.id],
    );
    if (!r) throw notFound('reference');
    if (r.user_id !== user.id && !isAdmin(user)) throw forbidden();
    if (r.moderation_status === 'redacted' && !isAdmin(user)) throw notFound('reference');

    const [corrections, auditTrail] = await Promise.all([
      many(
        `SELECT id, status, created_at FROM official_reference_corrections WHERE reference_id=$1 ORDER BY created_at DESC`,
        [i.id],
      ),
      many(
        `SELECT action, payload, created_at FROM official_reference_audit WHERE reference_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [i.id],
      ),
    ]);

    const decoded = await decryptRef(r, { includeText: true, includeContext: true });
    return { ...decoded, corrections, audit_trail: auditTrail };
  },
});

// ------------------------------------------------------------------ revoke my reference

cap({
  name: 'revoke_my_reference',
  method: 'POST',
  path: '/me/officials/references/:id/revoke',
  tag: TAG,
  summary: 'Revoke a reference — either party (official or responding org staff) may revoke. Data is kept; status changes to revoked.',
  input: z.object({ id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('reference');
    const isOwner = r.user_id === user.id;
    const isResponder = r.responded_by === user.id;
    const orgId = r.org_id ?? r.body_id;
    const isOrgStaff = orgId && (await c.query(
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND left_at IS NULL`,
      [orgId, user.id],
    )).rowCount > 0;
    if (!isOwner && !isResponder && !isOrgStaff && !isAdmin(user)) throw forbidden();
    if (r.revoked_at) throw conflict('Reference is already revoked');

    await c.query(
      `UPDATE official_portfolio_references
       SET response_status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3, updated_at=now()
       WHERE id=$1`,
      [i.id, user.id, i.reason ?? null],
    );
    await refAudit(c, i.id, user.id, 'revoked', { reason: i.reason });
    await audit(c, user.id, 'revoke_reference', 'official_portfolio_references', i.id);

    // Notify the other party
    const notifyId = isOwner ? r.responded_by : r.user_id;
    if (notifyId) {
      await notify(c, notifyId, {
        kind: 'official_reference_revoked',
        title: 'Professional reference revoked',
        body: 'A professional reference has been revoked.',
        data: { reference_id: i.id },
      });
    }

    return (await c.query(`SELECT id, response_status, revoked_at, revoked_by FROM official_portfolio_references WHERE id=$1`, [i.id])).rows[0];
  }),
});

// ------------------------------------------------------------------ request correction

cap({
  name: 'request_reference_correction',
  method: 'POST',
  path: '/me/officials/references/:id/corrections',
  tag: TAG,
  status: 201,
  summary: 'Ask the original respondent to correct an approved reference — reason and proposed change are encrypted.',
  input: z.object({
    id,
    reason: text(800),
    proposed_change: text(1000).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('reference');
    if (r.user_id !== user.id) throw forbidden();
    if (r.response_status !== 'approved') throw badRequest('Corrections can only be requested on approved references');

    const reasonEnc = await encrypt(i.reason);
    const changeEnc = i.proposed_change ? await encrypt(i.proposed_change) : null;

    const corr = (await c.query(
      `INSERT INTO official_reference_corrections(reference_id, requester_id, reason_enc, proposed_change_enc)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [i.id, user.id, reasonEnc, changeEnc],
    )).rows[0];

    await refAudit(c, i.id, user.id, 'correction_requested', { correction_id: corr.id });

    if (r.responded_by) {
      await notify(c, r.responded_by, {
        kind: 'official_reference_correction_requested',
        title: 'Correction requested on a reference',
        body: 'An official has requested a correction on a reference you issued.',
        data: { reference_id: i.id, correction_id: corr.id },
      });
    }

    return { id: corr.id, created_at: corr.created_at };
  }),
});

// ------------------------------------------------------------------ report abuse

cap({
  name: 'report_reference',
  method: 'POST',
  path: '/me/officials/references/:id/reports',
  tag: TAG,
  status: 201,
  summary: 'Report a reference for self-endorsement, conflict of interest, inaccuracy, abuse or spam. Notifies platform admins for moderation.',
  input: z.object({
    id,
    reason: z.enum(REPORT_REASONS),
    detail: text(800).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query(`SELECT id FROM official_portfolio_references WHERE id=$1`, [i.id])).rows[0];
    if (!r) throw notFound('reference');

    const detailEnc = i.detail ? await encrypt(i.detail) : null;
    const rep = (await c.query(
      `INSERT INTO official_reference_reports(reference_id, reporter_id, reason, detail_enc)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [i.id, user.id, i.reason, detailEnc],
    )).rows[0];

    await refAudit(c, i.id, user.id, 'reported', { reason: i.reason });

    if (PLATFORM_ADMIN_EMAILS.length) {
      const admins = (await c.query(
        `SELECT id FROM users WHERE email = ANY($1)`,
        [PLATFORM_ADMIN_EMAILS],
      )).rows;
      for (const a of admins) {
        await notify(c, a.id, {
          kind: 'official_reference_reported',
          title: 'Reference reported for review',
          body: `A professional reference has been reported: ${i.reason}.`,
          data: { reference_id: i.id, report_id: rep.id },
          urgent: false,
        });
      }
    }

    return { id: rep.id, created_at: rep.created_at };
  }),
});

// ------------------------------------------------------------------ get invite link

cap({
  name: 'get_reference_invite_link',
  method: 'GET',
  path: '/me/officials/references/:id/invite-link',
  tag: TAG,
  summary: 'Get (or regenerate an expired) secure-link token for a reference request using the secure_link invite method.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('reference');
    if (r.user_id !== user.id) throw forbidden();
    if (r.invite_method !== 'secure_link') throw badRequest('This reference does not use the secure-link invite method');
    if (r.response_status !== 'pending') throw conflict(`Reference is already ${r.response_status}`);

    let token = r.invite_token;
    let expires = r.invite_token_expires_at;

    if (!token || new Date(expires) <= new Date()) {
      token = generateToken();
      expires = tokenExpiry();
      await c.query(
        `UPDATE official_portfolio_references SET invite_token=$2, invite_token_expires_at=$3, updated_at=now() WHERE id=$1`,
        [i.id, token, expires],
      );
      await refAudit(c, i.id, user.id, 'invite_link_regenerated', {});
    }

    return { token, expires_at: expires, link_path: `/official-references/respond/${token}` };
  }),
});

// ------------------------------------------------------------------ respond via invite link (public)

cap({
  name: 'respond_via_invite_link',
  method: 'POST',
  path: '/official-references/respond/:token',
  tag: TAG,
  auth: 'public',
  summary: 'Respond to a professional reference request using a secure invite link. The token is single-use once responded.',
  input: z.object({
    token: z.string().min(48).max(48),
    response: z.enum(['approved','declined']),
    reference_text: text(2000).optional(),
    public_summary: text(300).optional(),
  }),
  handler: (_ctx, i) => tx(async (c) => {
    const r = (await c.query(
      `SELECT * FROM official_portfolio_references
       WHERE invite_token=$1 AND invite_token_expires_at > now() AND response_status='pending'
       FOR UPDATE`,
      [i.token],
    )).rows[0];
    if (!r) throw badRequest('invalid_or_expired_token');
    if (i.response === 'approved' && !i.public_summary && !i.reference_text) {
      throw badRequest('A summary or reference text is required when approving');
    }

    const refTextEnc = i.reference_text ? await encrypt(i.reference_text) : null;
    await c.query(
      `UPDATE official_portfolio_references
       SET response_status=$2, responded_at=now(), invite_method='secure_link', is_verified=false,
           reference_text_enc=COALESCE($3, reference_text_enc),
           public_summary=COALESCE($4, public_summary),
           updated_at=now()
       WHERE id=$1`,
      [r.id, i.response, refTextEnc, i.public_summary ?? null],
    );
    await refAudit(c, r.id, null, 'responded_via_link', { response: i.response });
    await notify(c, r.user_id, {
      kind: 'official_reference_responded',
      title: `Professional reference ${i.response}`,
      body: `Your reference request has been ${i.response}.`,
      data: { reference_id: r.id },
    });

    return { status: i.response };
  }),
});

// ------------------------------------------------------------------ org: list incoming requests

cap({
  name: 'list_incoming_reference_requests',
  method: 'GET',
  path: '/orgs/:org_id/official-references/pending',
  tag: TAG,
  summary: 'Organisation staff: list pending professional reference requests directed at this organisation.',
  input: z.object({ org_id: id, ...page.shape }),
  async handler({ user }, i) {
    await requireOrgStaff(pool, i.org_id, user.id, user);
    const rows = await many(
      `SELECT r.*,
              u.display_name AS referee_name, u.avatar_url AS referee_avatar,
              s.name AS sport_name, s.emoji AS sport_emoji,
              (r.expiry_date IS NOT NULL AND r.expiry_date < now()::date) AS is_expired
       FROM official_portfolio_references r
       JOIN  users u ON u.id = r.user_id
       LEFT JOIN sports s ON s.id = r.sport_id
       WHERE (r.org_id=$1 OR r.body_id=$1) AND r.response_status='pending' AND r.revoked_at IS NULL
         AND r.moderation_status <> 'redacted'
       ORDER BY r.created_at
       LIMIT $2 OFFSET $3`,
      [i.org_id, i.limit ?? 25, i.offset ?? 0],
    );
    return Promise.all(rows.map((r) => decryptRef(r, { includeContext: true })));
  },
});

// ------------------------------------------------------------------ org: respond to reference request

cap({
  name: 'respond_to_reference_request',
  method: 'POST',
  path: '/orgs/:org_id/official-references/:id/respond',
  tag: TAG,
  summary: 'Organisation staff: approve or decline a professional reference request with encrypted reference text. Marks the reference as identity-verified.',
  input: z.object({
    org_id: id,
    id,
    response: z.enum(['approved','declined']),
    reference_text: text(2000).optional(),
    public_summary: text(300).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await requireOrgStaff(c, i.org_id, user.id, user);
    const r = (await c.query(
      `SELECT * FROM official_portfolio_references WHERE id=$1 AND (org_id=$2 OR body_id=$2) FOR UPDATE`,
      [i.id, i.org_id],
    )).rows[0];
    if (!r) throw notFound('reference');
    if (r.response_status !== 'pending') throw conflict(`Reference is already ${r.response_status}`);
    if (i.response === 'approved' && !i.public_summary) throw badRequest('A public summary is required when approving');

    const refTextEnc = i.reference_text ? await encrypt(i.reference_text) : null;
    await c.query(
      `UPDATE official_portfolio_references
       SET response_status=$2, responded_by=$3, responded_at=now(),
           is_verified=true, verifier_org_id=$4,
           reference_text_enc=COALESCE($5, reference_text_enc),
           public_summary=COALESCE($6, public_summary),
           updated_at=now()
       WHERE id=$1`,
      [i.id, i.response, user.id, i.org_id, refTextEnc, i.public_summary ?? null],
    );
    await refAudit(c, i.id, user.id, 'responded', { response: i.response, org_id: i.org_id, is_verified: true });
    await audit(c, user.id, 'respond_reference', 'official_portfolio_references', i.id);
    await notify(c, r.user_id, {
      kind: 'official_reference_responded',
      title: `Professional reference ${i.response}`,
      body: `Your reference request has been ${i.response} by ${i.org_id}.`,
      data: { reference_id: i.id },
    });

    const updated = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1`, [i.id])).rows[0];
    return decryptRef(updated);
  }),
});

// ------------------------------------------------------------------ admin moderation

cap({
  name: 'admin_moderate_reference',
  method: 'POST',
  path: '/admin/official-references/:id/moderate',
  tag: TAG,
  summary: 'Platform admin: flag, clear or redact a professional reference. Redact zeroes out reference text and hides the entry from all public surfaces.',
  input: z.object({
    id,
    action: z.enum(['flag','clear','redact']),
    note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await requirePlatformAdmin(user);
    const r = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!r) throw notFound('reference');

    const statusMap = { flag: 'flagged', clear: 'cleared', redact: 'redacted' };
    const newStatus = statusMap[i.action];

    if (i.action === 'redact') {
      await c.query(
        `UPDATE official_portfolio_references
         SET moderation_status=$2, moderated_by=$3, moderated_at=now(), moderation_note=$4,
             reference_text_enc='', public_summary=null, updated_at=now()
         WHERE id=$1`,
        [i.id, newStatus, user.id, i.note ?? null],
      );
    } else {
      await c.query(
        `UPDATE official_portfolio_references
         SET moderation_status=$2, moderated_by=$3, moderated_at=now(), moderation_note=$4, updated_at=now()
         WHERE id=$1`,
        [i.id, newStatus, user.id, i.note ?? null],
      );
    }

    await refAudit(c, i.id, user.id, `moderation_${i.action}`, { note: i.note });
    await audit(c, user.id, `moderate_reference_${i.action}`, 'official_portfolio_references', i.id);

    return (await c.query(
      `SELECT id, response_status, moderation_status, moderated_by, moderated_at, moderation_note FROM official_portfolio_references WHERE id=$1`,
      [i.id],
    )).rows[0];
  }),
});
