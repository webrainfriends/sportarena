// Official career portfolio (#1009 REF-R17): career resume built from accepted engagements.
// Distinct from officials-extract.js (operational PDF) and officials-progression.js (grade management).
// Source of truth stays in fixture_officials, official_scheme_grades, fed_licences etc.; nothing is duplicated.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { encrypt, decrypt } from '../crypto.js';
import { saveEncrypted, loadEncrypted, docHeaders } from '../doc-store.js';
import { assemblePortfolio, publicFilter } from '../official-career-portfolio.js';
import { renderOfficialPortfolioPdf } from '../documents/official-portfolio.js';

const TAG = 'Officials';
const FOLDER = 'official-portfolio-exports';
const ctx = (uid) => `official_portfolio:${uid}`;
const day = z.string().date();
const text = (n) => z.string().trim().max(n);

// ------------------------------------------------------------------ settings

cap({
  name: 'get_portfolio_settings',
  method: 'GET',
  path: '/me/officials/portfolio/settings',
  tag: TAG,
  summary: 'Get my officiating portfolio visibility settings.',
  async handler({ user }) {
    const row = await one(`SELECT * FROM official_portfolio_settings WHERE user_id=$1`, [user.id]);
    return row ?? {
      user_id: user.id,
      visibility: 'private',
      show_grades: true, show_milestones: true, show_references: true,
      show_activity_chart: true, show_match_count: true,
      show_federation_recognition: true, show_education_cpd: false, show_assessments_summary: false,
      public_bio: null,
    };
  },
});

cap({
  name: 'configure_portfolio_visibility',
  method: 'PUT',
  path: '/me/officials/portfolio/settings',
  tag: TAG,
  summary: 'Configure which sections of my officiating portfolio are visible publicly and the overall visibility (public / link_only / private).',
  input: z.object({
    visibility: z.enum(['public', 'link_only', 'private']).optional(),
    show_grades: z.boolean().optional(),
    show_milestones: z.boolean().optional(),
    show_references: z.boolean().optional(),
    show_activity_chart: z.boolean().optional(),
    show_match_count: z.boolean().optional(),
    show_federation_recognition: z.boolean().optional(),
    show_education_cpd: z.boolean().optional(),
    show_assessments_summary: z.boolean().optional(),
    public_bio: text(500).nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const existing = (await c.query(`SELECT * FROM official_portfolio_settings WHERE user_id=$1 FOR UPDATE`, [user.id])).rows[0];
    const bioEnc = i.public_bio !== undefined
      ? (i.public_bio ? await encrypt(i.public_bio) : null)
      : (existing?.public_bio_enc ?? null);
    const fields = {
      visibility: i.visibility ?? existing?.visibility ?? 'private',
      show_grades: i.show_grades ?? existing?.show_grades ?? true,
      show_milestones: i.show_milestones ?? existing?.show_milestones ?? true,
      show_references: i.show_references ?? existing?.show_references ?? true,
      show_activity_chart: i.show_activity_chart ?? existing?.show_activity_chart ?? true,
      show_match_count: i.show_match_count ?? existing?.show_match_count ?? true,
      show_federation_recognition: i.show_federation_recognition ?? existing?.show_federation_recognition ?? true,
      show_education_cpd: i.show_education_cpd ?? existing?.show_education_cpd ?? false,
      show_assessments_summary: i.show_assessments_summary ?? existing?.show_assessments_summary ?? false,
      public_bio_enc: bioEnc,
    };
    if (existing) {
      await c.query(
        `UPDATE official_portfolio_settings SET visibility=$2, show_grades=$3, show_milestones=$4, show_references=$5,
           show_activity_chart=$6, show_match_count=$7, show_federation_recognition=$8,
           show_education_cpd=$9, show_assessments_summary=$10, public_bio_enc=$11, updated_at=now()
         WHERE user_id=$1`,
        [user.id, fields.visibility, fields.show_grades, fields.show_milestones, fields.show_references,
          fields.show_activity_chart, fields.show_match_count, fields.show_federation_recognition,
          fields.show_education_cpd, fields.show_assessments_summary, fields.public_bio_enc],
      );
    } else {
      await c.query(
        `INSERT INTO official_portfolio_settings(user_id, visibility, show_grades, show_milestones, show_references,
           show_activity_chart, show_match_count, show_federation_recognition, show_education_cpd, show_assessments_summary, public_bio_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [user.id, fields.visibility, fields.show_grades, fields.show_milestones, fields.show_references,
          fields.show_activity_chart, fields.show_match_count, fields.show_federation_recognition,
          fields.show_education_cpd, fields.show_assessments_summary, fields.public_bio_enc],
      );
    }
    await audit(c, user.id, 'update_portfolio_settings', 'official_portfolio_settings', user.id);
    return (await c.query(`SELECT * FROM official_portfolio_settings WHERE user_id=$1`, [user.id])).rows[0];
  }),
});

// ------------------------------------------------------------------ portfolio view

cap({
  name: 'get_officiating_portfolio',
  method: 'GET',
  path: '/me/officials/portfolio',
  tag: TAG,
  summary: 'My full officiating career portfolio: summary, per-sport breakdown, grades, licences, milestones, references, activity timeline.',
  input: z.object({ sport_id: id.optional() }),
  handler: async ({ user }, i) => {
    const data = await assemblePortfolio(user.id, { sportId: i.sport_id });
    const settings = await one(`SELECT * FROM official_portfolio_settings WHERE user_id=$1`, [user.id]);
    const milestones = await many(
      `SELECT m.*, s.name AS sport_name, s.emoji AS sport_emoji, o.name AS org_name
       FROM official_portfolio_milestones m
       LEFT JOIN sports s ON s.id = m.sport_id
       LEFT JOIN organisations o ON o.id = m.verifying_org_id
       WHERE m.user_id=$1 AND m.archived_at IS NULL ORDER BY m.milestone_date DESC`,
      [user.id],
    );
    const references = await many(
      `SELECT r.*, o.name AS org_name, ob.name AS body_name, s.name AS sport_name
       FROM official_portfolio_references r
       LEFT JOIN organisations o  ON o.id = r.org_id
       LEFT JOIN organisations ob ON ob.id = r.body_id
       LEFT JOIN sports s ON s.id = r.sport_id
       WHERE r.user_id=$1 AND r.revoked_at IS NULL ORDER BY r.created_at DESC`,
      [user.id],
    );
    const bio = settings?.public_bio_enc ? await decrypt(settings.public_bio_enc) : null;
    return { ...data, milestones, references, settings: { ...settings, public_bio: bio, public_bio_enc: undefined } };
  },
});

cap({
  name: 'get_public_officiating_portfolio',
  method: 'GET',
  path: '/officials/:id/portfolio',
  tag: TAG,
  auth: 'public',
  summary: 'Public view of an official\'s career portfolio. Privacy-filtered: private events excluded, PII omitted. Returns 404 for private portfolios (existence not leaked).',
  input: z.object({ id, sport_id: id.optional() }),
  async handler(_ctx, i) {
    const settings = await one(`SELECT * FROM official_portfolio_settings WHERE user_id=$1`, [i.id]);
    if (!settings || settings.visibility === 'private') throw notFound('portfolio');
    const data = await assemblePortfolio(i.id, { sportId: i.sport_id, publicOnly: true });
    const filtered = publicFilter(data, settings);
    const milestones = settings.show_milestones
      ? await many(
          `SELECT m.id, m.sport_id, m.role, m.title, m.competition_name, m.milestone_date, m.is_championship, m.verification_status, s.name AS sport_name, s.emoji AS sport_emoji
           FROM official_portfolio_milestones m LEFT JOIN sports s ON s.id = m.sport_id
           WHERE m.user_id=$1 AND m.archived_at IS NULL ORDER BY m.milestone_date DESC`,
          [i.id],
        )
      : [];
    const references = settings.show_references
      ? await many(
          `SELECT r.id, r.relationship, r.public_summary, r.response_status, r.sport_id, o.name AS org_name, ob.name AS body_name, s.name AS sport_name
           FROM official_portfolio_references r
           LEFT JOIN organisations o  ON o.id = r.org_id
           LEFT JOIN organisations ob ON ob.id = r.body_id
           LEFT JOIN sports s ON s.id = r.sport_id
           WHERE r.user_id=$1 AND r.response_status='approved' AND r.revoked_at IS NULL ORDER BY r.created_at DESC`,
          [i.id],
        )
      : [];
    const bio = settings.public_bio_enc ? await decrypt(settings.public_bio_enc) : null;
    return { ...filtered, milestones, references, public_bio: bio };
  },
});

// ------------------------------------------------------------------ milestones

cap({
  name: 'add_portfolio_milestone',
  method: 'POST',
  path: '/me/officials/portfolio/milestones',
  tag: TAG,
  status: 201,
  summary: 'Add a career milestone to my portfolio (e.g. "Referee, FIFA World Cup 2026"). Self-declared by default; an org staff member can be invited to verify it.',
  input: z.object({
    title: text(200),
    milestone_date: day,
    is_championship: z.boolean().default(false),
    sport_id: id.optional(),
    role: text(60).optional(),
    competition_name: text(200).optional(),
    description: text(1000).optional(),
    verifying_org_id: id.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const descEnc = i.description ? await encrypt(i.description) : null;
    const row = (await c.query(
      `INSERT INTO official_portfolio_milestones
         (user_id, sport_id, role, title, competition_name, milestone_date, is_championship, description_enc, verifying_org_id, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [user.id, i.sport_id ?? null, i.role ?? null, i.title, i.competition_name ?? null,
        i.milestone_date, i.is_championship, descEnc, i.verifying_org_id ?? null,
        i.verifying_org_id ? 'pending' : 'self_declared'],
    )).rows[0];
    if (i.verifying_org_id) {
      const admins = await c.query(
        `SELECT user_id FROM org_members WHERE org_id=$1 AND role IN ('owner','admin') AND left_at IS NULL LIMIT 5`,
        [i.verifying_org_id],
      );
      for (const a of admins.rows) {
        await notify(c, a.user_id, {
          kind: 'portfolio_verification_request',
          title: 'Portfolio verification requested',
          body: `An official requests verification of a career milestone: ${i.title}`,
          data: { milestone_id: row.id, user_id: user.id },
        });
      }
    }
    return row;
  }),
});

cap({
  name: 'edit_portfolio_milestone',
  method: 'PATCH',
  path: '/me/officials/portfolio/milestones/:id',
  tag: TAG,
  summary: 'Edit a self-declared career milestone. Verified milestones are immutable.',
  input: z.object({
    id,
    title: text(200).optional(),
    milestone_date: day.optional(),
    is_championship: z.boolean().optional(),
    sport_id: id.nullable().optional(),
    role: text(60).nullable().optional(),
    competition_name: text(200).nullable().optional(),
    description: text(1000).nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query(`SELECT * FROM official_portfolio_milestones WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!m) throw notFound('milestone');
    if (m.user_id !== user.id && !isAdmin(user)) throw forbidden('Not your milestone');
    if (m.verification_status === 'verified') throw conflict('Verified milestones are immutable');
    if (m.archived_at) throw conflict('Milestone is archived');
    const descEnc = i.description !== undefined ? (i.description ? await encrypt(i.description) : null) : m.description_enc;
    await c.query(
      `UPDATE official_portfolio_milestones
       SET title=COALESCE($2,title), milestone_date=COALESCE($3,milestone_date), is_championship=COALESCE($4,is_championship),
           sport_id=COALESCE($5,sport_id), role=COALESCE($6,role), competition_name=COALESCE($7,competition_name),
           description_enc=$8, updated_at=now()
       WHERE id=$1`,
      [i.id, i.title ?? null, i.milestone_date ?? null, i.is_championship ?? null,
        i.sport_id ?? null, i.role ?? null, i.competition_name ?? null, descEnc],
    );
    return (await c.query(`SELECT * FROM official_portfolio_milestones WHERE id=$1`, [i.id])).rows[0];
  }),
});

cap({
  name: 'delete_portfolio_milestone',
  method: 'DELETE',
  path: '/me/officials/portfolio/milestones/:id',
  tag: TAG,
  summary: 'Soft-archive a career milestone (data is kept, never hard-deleted).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query(`SELECT * FROM official_portfolio_milestones WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!m) throw notFound('milestone');
    if (m.user_id !== user.id && !isAdmin(user)) throw forbidden('Not your milestone');
    if (m.archived_at) return { archived: true };
    await c.query(`UPDATE official_portfolio_milestones SET archived_at=now(), updated_at=now() WHERE id=$1`, [i.id]);
    return { archived: true };
  }),
});

cap({
  name: 'verify_portfolio_milestone',
  method: 'POST',
  path: '/officials/portfolio/milestones/:id/verify',
  tag: TAG,
  summary: 'Organisation staff: verify or reject a pending career milestone. Verified milestones become immutable.',
  input: z.object({
    id,
    action: z.enum(['verify', 'reject']),
    note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query(`SELECT * FROM official_portfolio_milestones WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!m) throw notFound('milestone');
    if (!m.verifying_org_id) throw badRequest('No organisation set to verify this milestone');
    if (m.verification_status !== 'pending') throw conflict(`Milestone is ${m.verification_status}`);
    const isMember = (await c.query(
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND left_at IS NULL`,
      [m.verifying_org_id, user.id],
    )).rowCount > 0;
    if (!isMember && !isAdmin(user)) throw forbidden('Only the organisation\'s staff can verify this');
    const newStatus = i.action === 'verify' ? 'verified' : 'rejected';
    await c.query(
      `UPDATE official_portfolio_milestones SET verification_status=$2, verified_by=$3, verified_at=now(), verify_note=$4, updated_at=now() WHERE id=$1`,
      [i.id, newStatus, user.id, i.note ?? null],
    );
    await notify(c, m.user_id, {
      kind: 'portfolio_milestone_verified',
      title: `Career milestone ${newStatus}`,
      body: `Your milestone "${m.title}" has been ${newStatus}.`,
      data: { milestone_id: m.id },
    });
    return (await c.query(`SELECT * FROM official_portfolio_milestones WHERE id=$1`, [i.id])).rows[0];
  }),
});

// ------------------------------------------------------------------ references

cap({
  name: 'request_portfolio_reference',
  method: 'POST',
  path: '/me/officials/portfolio/references',
  tag: TAG,
  status: 201,
  summary: 'Request a reference for my portfolio from an organisation or governing body. Contact PII is field-encrypted and never published.',
  input: z.object({
    org_id: id.optional(),
    body_id: id.optional(),
    sport_id: id.optional(),
    relationship: z.enum(['worked_with', 'supervised', 'assessed', 'appointed']),
    contact_name: text(120).optional(),
    contact_email: z.string().email().max(200).optional(),
    request_note: text(500).optional(),
  }).refine((r) => r.org_id || r.body_id, 'Provide an organisation or governing body'),
  handler: ({ user }, i) => tx(async (c) => {
    const contactNameEnc = i.contact_name ? await encrypt(i.contact_name) : null;
    const contactEmailEnc = i.contact_email ? await encrypt(i.contact_email) : null;
    const noteEnc = i.request_note ? await encrypt(i.request_note) : null;
    const row = (await c.query(
      `INSERT INTO official_portfolio_references(user_id, org_id, body_id, sport_id, relationship, contact_name_enc, contact_email_enc, request_note_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.id, i.org_id ?? null, i.body_id ?? null, i.sport_id ?? null,
        i.relationship, contactNameEnc, contactEmailEnc, noteEnc],
    )).rows[0];
    const orgId = i.org_id ?? i.body_id;
    const admins = await c.query(
      `SELECT user_id FROM org_members WHERE org_id=$1 AND role IN ('owner','admin') AND left_at IS NULL LIMIT 5`,
      [orgId],
    );
    for (const a of admins.rows) {
      await notify(c, a.user_id, {
        kind: 'portfolio_reference_request',
        title: 'Reference request received',
        body: 'An official is requesting a career reference from your organisation.',
        data: { reference_id: row.id },
      });
    }
    return row;
  }),
});

cap({
  name: 'respond_portfolio_reference',
  method: 'POST',
  path: '/officials/portfolio/references/:id/respond',
  tag: TAG,
  summary: 'Organisation staff: approve or decline a reference request. If approved, a public_summary (non-PII one-liner) is shown; full reference_text is kept private.',
  input: z.object({
    id,
    action: z.enum(['approve', 'decline']),
    public_summary: text(300).optional(),
    reference_text: text(2000).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ref = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!ref) throw notFound('reference');
    if (ref.response_status !== 'pending') throw conflict(`Reference is already ${ref.response_status}`);
    const orgId = ref.org_id ?? ref.body_id;
    const isMember = (await c.query(
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND left_at IS NULL`,
      [orgId, user.id],
    )).rowCount > 0;
    if (!isMember && !isAdmin(user)) throw forbidden('Only the organisation\'s staff can respond');
    if (i.action === 'approve' && !i.public_summary) throw badRequest('A public summary is required when approving');
    const refTextEnc = i.reference_text ? await encrypt(i.reference_text) : null;
    await c.query(
      `UPDATE official_portfolio_references SET response_status=$2, public_summary=$3, reference_text_enc=$4, responded_by=$5, responded_at=now(), updated_at=now() WHERE id=$1`,
      [i.id, i.action === 'approve' ? 'approved' : 'declined', i.public_summary ?? null, refTextEnc, user.id],
    );
    await notify(c, ref.user_id, {
      kind: 'portfolio_reference_responded',
      title: `Reference ${i.action === 'approve' ? 'approved' : 'declined'}`,
      body: `Your reference request has been ${i.action === 'approve' ? 'approved' : 'declined'}.`,
      data: { reference_id: ref.id },
    });
    return (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1`, [i.id])).rows[0];
  }),
});

cap({
  name: 'revoke_portfolio_reference',
  method: 'POST',
  path: '/me/officials/portfolio/references/:id/revoke',
  tag: TAG,
  summary: 'Soft-remove a reference from my portfolio (keeps data for audit; never hard-deleted).',
  input: z.object({ id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ref = (await c.query(`SELECT * FROM official_portfolio_references WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!ref) throw notFound('reference');
    if (ref.user_id !== user.id && !isAdmin(user)) throw forbidden('Not your reference');
    if (ref.revoked_at) return { revoked: true };
    await c.query(
      `UPDATE official_portfolio_references SET revoked_at=now(), revoked_by=$2, revoke_reason=$3, updated_at=now() WHERE id=$1`,
      [i.id, user.id, i.reason ?? null],
    );
    return { revoked: true };
  }),
});

// ------------------------------------------------------------------ PDF export

cap({
  name: 'export_portfolio_pdf',
  method: 'POST',
  path: '/me/officials/portfolio/exports',
  tag: TAG,
  status: 201,
  summary: 'Generate a career portfolio PDF snapshot. Idempotent: a retried request with the same client_key returns the original. The PDF is a frozen, fingerprinted career credential distinct from the operational officiating extract.',
  input: z.object({
    sport_id: id.optional(),
    client_key: z.string().trim().min(8).max(80).optional(),
  }),
  handler: async ({ user }, i) => {
    if (i.client_key) {
      const dup = await one(`SELECT * FROM official_portfolio_snapshots WHERE user_id=$1 AND client_key=$2`, [user.id, i.client_key]);
      if (dup) return dup;
    }
    const data = await assemblePortfolio(user.id, { sportId: i.sport_id });
    if (!data.summary.total_matches && !data.grades.length) {
      throw badRequest('Nothing to export yet: take an assignment or add a grade first');
    }
    const settings = await one(`SELECT * FROM official_portfolio_settings WHERE user_id=$1`, [user.id]);
    const userRow = await one(`SELECT display_name, avatar_url FROM users WHERE id=$1`, [user.id]);
    const milestones = await many(
      `SELECT m.*, s.name AS sport_name FROM official_portfolio_milestones m LEFT JOIN sports s ON s.id=m.sport_id WHERE m.user_id=$1 AND m.archived_at IS NULL ORDER BY m.milestone_date DESC`,
      [user.id],
    );
    const references = await many(
      `SELECT r.*, o.name AS org_name FROM official_portfolio_references r LEFT JOIN organisations o ON o.id=r.org_id WHERE r.user_id=$1 AND r.response_status='approved' AND r.revoked_at IS NULL ORDER BY r.created_at DESC`,
      [user.id],
    );
    const snapshot = { user: userRow, ...data, milestones, references, settings };
    const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const docId = (await one(`SELECT gen_random_uuid() AS id`)).id;
    const createdAt = new Date();
    const { buffer, pages } = await renderOfficialPortfolioPdf({ snapshot, id: docId, sha256, createdAt });
    const saved = await saveEncrypted(FOLDER, ctx(user.id), buffer);
    return tx(async (c) => {
      const counts = {
        total_matches: data.summary.total_matches,
        sports: data.summary.sports_count,
        grades: data.grades.length,
        milestones: milestones.length,
      };
      const row = (await c.query(
        `INSERT INTO official_portfolio_snapshots(id, user_id, sha256, file_name, size_bytes, pages, sport_filter, counts, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [docId, user.id, sha256, saved.file, buffer.length, pages, i.sport_id ?? null, JSON.stringify(counts), i.client_key ?? null],
      )).rows[0];
      await audit(c, user.id, 'export_portfolio_pdf', 'official_portfolio_snapshots', docId);
      return row;
    });
  },
});

cap({
  name: 'list_portfolio_exports',
  method: 'GET',
  path: '/me/officials/portfolio/exports',
  tag: TAG,
  summary: 'List my previous career portfolio PDF exports, most recent first.',
  async handler({ user }) {
    return many(
      `SELECT id, sport_filter, sha256, file_name, size_bytes, pages, counts, created_at
       FROM official_portfolio_snapshots WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [user.id],
    );
  },
});

cap({
  name: 'download_portfolio_export',
  method: 'GET',
  path: '/me/officials/portfolio/exports/:id',
  tag: TAG,
  summary: 'Download a specific career portfolio PDF. The download is audit-logged.',
  input: z.object({ id }),
  handler: async ({ user, res }, i) => {
    const snap = await one(`SELECT * FROM official_portfolio_snapshots WHERE id=$1 AND user_id=$2`, [i.id, user.id]);
    if (!snap) throw notFound('export');
    await audit(pool, user.id, 'download_portfolio_pdf', 'official_portfolio_snapshots', snap.id);
    const buffer = await loadEncrypted(FOLDER, ctx(user.id), snap.file_name);
    res.set(docHeaders('application/pdf', buffer))
      .set('Content-Disposition', `inline; filename="career-portfolio-${snap.created_at.toISOString().slice(0, 10)}.pdf"`);
    res.send(buffer);
  },
});
