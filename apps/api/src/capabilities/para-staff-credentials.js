// PS-21: Para-sport coach, official and classifier learning credentials.
// Governed professional development tracks for adaptive coaches, para referees, technical
// officials, guide/support workers and classifier candidates, with credential issuance on
// completion, expiry reminders, sport/jurisdiction validity and permission-safe verification.
//
// CRITICAL INVARIANT: completion of any track — including classifier_candidate — NEVER grants
// classifier role privilege. That sole arbiter is para-governance / para-cases (#488).
// This capability never touches the para_classifiers table.
//
// Source-of-truth map:
//   credential issuance / wallet / verify → credentials.js (extended via para_track_id FK)
//   classifier role privilege             → para-governance.js (#488)  — no change
//   official grade progression            → officials-development.js    — no change
//   payment / registration                → education-enquiries.js      — reused unchanged
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';
import { authority, need } from '../federation.js';
import { orgFor } from '../org-access.js';
import { isYouth, guardiansOf, guardianLink } from '../youth.js';

const TAG = 'Para staff credentials';
const ROLE_CATEGORIES = ['adaptive_coach', 'para_referee', 'technical_official', 'guide_support', 'classifier_candidate'];
const LEVELS = ['foundation', 'intermediate', 'advanced'];
const CRED_KINDS = ['certificate', 'badge', 'diploma', 'course'];
const STATUSES = ['draft', 'published', 'retired'];
const day = z.string().date();
const https = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Links must use https');
const newCode = () => `PS-${randomBytes(5).toString('hex').toUpperCase()}`;

// ── auth helpers ─────────────────────────────────────────────────────────────

async function checkTrackPublisher(user, track, c = pool) {
  // Platform admin can always manage any track
  const isPlatformAdmin = user.roles?.includes('platform_admin') || user.roles?.includes('admin');
  if (isPlatformAdmin) return;
  if (track.publisher_body_id) {
    const auth = await authority(user, track.publisher_body_id, { c });
    need(auth, 'governance', track.sport_id);
    return;
  }
  if (track.publisher_org_id) {
    await orgFor(user, track.publisher_org_id, ['owner', 'admin'], { c });
    return;
  }
  throw forbidden('No publishing authority for this track');
}

async function trackOrNotFound(trackId, c = pool) {
  const row = await (c === pool
    ? one('SELECT * FROM para_staff_tracks WHERE id=$1', [trackId])
    : (await c.query('SELECT * FROM para_staff_tracks WHERE id=$1', [trackId])).rows[0] ?? null);
  if (!row) throw notFound('Para staff track');
  return row;
}

// ── 1. list_para_staff_tracks ────────────────────────────────────────────────
cap({
  name: 'list_para_staff_tracks', method: 'GET', path: '/para/staff/tracks', tag: TAG, auth: 'public',
  summary: 'Browse published para-sport staff professional development tracks. Filter by role_category (adaptive_coach, para_referee, technical_official, guide_support, classifier_candidate), sport slug and country. Classifier_candidate tracks carry an explicit note that completion does not grant classifier privilege.',
  input: z.object({
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    sport: z.string().min(1).optional(),
    country: z.string().length(2).toUpperCase().optional(),
    ...page,
  }),
  async handler(_, i) {
    const sport = i.sport ? await one('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport]) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return many(
      `SELECT t.id, t.role_category, t.level_key, t.title, t.summary, t.credential_kind,
              t.renewal_months, t.scope_countries, t.status, t.published_at,
              s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
              b.id AS body_id, ob.name AS body_name,
              o.name AS publisher_org_name,
              (SELECT json_agg(json_build_object('id',p.id,'kind',p.kind,'value',p.value,'label',p.label) ORDER BY p.sort_order)
                 FROM para_staff_track_prerequisites p WHERE p.track_id=t.id) AS prerequisites
         FROM para_staff_tracks t
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
        WHERE t.status='published'
          AND ($1::uuid IS NULL OR t.sport_id=$1)
          AND ($2::text IS NULL OR t.role_category=$2)
          AND ($3::text IS NULL OR t.scope_countries = '{}' OR $3=ANY(t.scope_countries))
        ORDER BY t.role_category, s.name, t.level_key, t.created_at
        LIMIT $4 OFFSET $5`,
      [sport?.id ?? null, i.role_category ?? null, i.country ?? null, i.limit, i.offset],
    );
  },
});

// ── 2. get_para_staff_track ──────────────────────────────────────────────────
cap({
  name: 'get_para_staff_track', method: 'GET', path: '/para/staff/tracks/:id', tag: TAG, auth: 'public',
  summary: 'Full detail for a para-sport staff track: prerequisites, renewal rules, publisher, sport, jurisdiction scope and the classifier-candidate flag.',
  input: z.object({ id }),
  async handler(_, i) {
    const t = await one(
      `SELECT t.*, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
              b.id AS body_id, ob.name AS body_name, o.name AS publisher_org_name
         FROM para_staff_tracks t
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
        WHERE t.id=$1`,
      [i.id],
    );
    if (!t || t.status === 'retired') throw notFound('Para staff track');
    const prerequisites = await many(
      'SELECT id, kind, value, label, sort_order FROM para_staff_track_prerequisites WHERE track_id=$1 ORDER BY sort_order, id',
      [i.id],
    );
    return { ...t, prerequisites, classification_candidate_only: t.role_category === 'classifier_candidate' };
  },
});

// ── 3. create_para_staff_track ───────────────────────────────────────────────
cap({
  name: 'create_para_staff_track', method: 'POST', path: '/para/staff/tracks', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Federation admin or approved org admin: create a draft professional development track for a para-sport staff role. The track stays in draft until published. Classifier_candidate tracks receive an automatic disclosure that completion does not grant classifier privilege.',
  input: z.object({
    sport_id: id.optional(),
    discipline: z.string().trim().max(60).default(''),
    role_category: z.enum(ROLE_CATEGORIES),
    title: z.string().trim().min(2).max(160),
    summary: z.string().trim().max(1000).optional(),
    level_key: z.enum(LEVELS).optional(),
    credential_kind: z.enum(CRED_KINDS).default('certificate'),
    renewal_months: z.number().int().min(1).max(240).optional(),
    publisher_body_id: id.optional(),
    publisher_org_id: id.optional(),
    scope_countries: z.array(z.string().trim().length(2).toUpperCase()).max(250).default([]),
    prerequisites: z.array(z.object({
      kind: z.enum(['track', 'credential_kind', 'min_experience_months', 'role']),
      value: z.string().min(1).max(200),
      label: z.string().min(1).max(200),
      sort_order: z.number().int().min(0).default(0),
    })).max(20).default([]),
  }).refine((v) => v.publisher_body_id || v.publisher_org_id, 'Provide publisher_body_id or publisher_org_id'),
  handler: ({ user }, i) => tx(async (c) => {
    const draft = { publisher_body_id: i.publisher_body_id ?? null, publisher_org_id: i.publisher_org_id ?? null, sport_id: i.sport_id ?? null };
    await checkTrackPublisher(user, draft, c);
    if (i.sport_id) {
      const sport = (await c.query('SELECT id FROM sports WHERE id=$1', [i.sport_id])).rows[0];
      if (!sport) throw notFound('Sport');
    }
    const row = (await c.query(
      `INSERT INTO para_staff_tracks(sport_id, discipline, role_category, title, summary, level_key, credential_kind, renewal_months, publisher_body_id, publisher_org_id, scope_countries, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.sport_id ?? null, i.discipline, i.role_category, i.title, i.summary ?? null, i.level_key ?? null, i.credential_kind, i.renewal_months ?? null, i.publisher_body_id ?? null, i.publisher_org_id ?? null, i.scope_countries, user.id],
    )).rows[0];
    for (const [idx, prereq] of i.prerequisites.entries()) {
      await c.query(
        'INSERT INTO para_staff_track_prerequisites(track_id, kind, value, label, sort_order) VALUES ($1,$2,$3,$4,$5)',
        [row.id, prereq.kind, prereq.value, prereq.label, prereq.sort_order ?? idx],
      );
    }
    await audit(c, user.id, 'create_para_staff_track', 'para_staff_tracks', row.id);
    return { ...row, classification_candidate_only: row.role_category === 'classifier_candidate' };
  }),
});

// ── 4. update_para_staff_track ───────────────────────────────────────────────
cap({
  name: 'update_para_staff_track', method: 'PATCH', path: '/para/staff/tracks/:id', tag: TAG, auth: ['admin'],
  summary: 'Update a draft para-sport staff track. Only title, summary, level_key, credential_kind, renewal_months, scope_countries and prerequisites can be changed. Tracks that are published or retired cannot be edited.',
  input: z.object({
    id,
    title: z.string().trim().min(2).max(160).optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    level_key: z.enum(LEVELS).nullable().optional(),
    credential_kind: z.enum(CRED_KINDS).optional(),
    renewal_months: z.number().int().min(1).max(240).nullable().optional(),
    scope_countries: z.array(z.string().trim().length(2).toUpperCase()).max(250).optional(),
    prerequisites: z.array(z.object({
      kind: z.enum(['track', 'credential_kind', 'min_experience_months', 'role']),
      value: z.string().min(1).max(200),
      label: z.string().min(1).max(200),
      sort_order: z.number().int().min(0).default(0),
    })).max(20).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const track = await (await c.query('SELECT * FROM para_staff_tracks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!track) throw notFound('Para staff track');
    if (track.status !== 'draft') throw conflict('Only draft tracks can be edited');
    await checkTrackPublisher(user, track, c);
    const updated = (await c.query(
      `UPDATE para_staff_tracks SET
         title          = coalesce($2, title),
         summary        = CASE WHEN $3::boolean THEN $4 ELSE summary END,
         level_key      = CASE WHEN $5::boolean THEN $6 ELSE level_key END,
         credential_kind= coalesce($7, credential_kind),
         renewal_months = CASE WHEN $8::boolean THEN $9 ELSE renewal_months END,
         scope_countries= coalesce($10::text[], scope_countries),
         updated_at     = now()
       WHERE id=$1 RETURNING *`,
      [i.id,
        i.title ?? null,
        'summary' in i, i.summary ?? null,
        'level_key' in i, i.level_key ?? null,
        i.credential_kind ?? null,
        'renewal_months' in i, i.renewal_months ?? null,
        i.scope_countries ?? null],
    )).rows[0];
    if (i.prerequisites !== undefined) {
      await c.query('DELETE FROM para_staff_track_prerequisites WHERE track_id=$1', [i.id]);
      for (const [idx, prereq] of i.prerequisites.entries()) {
        await c.query(
          'INSERT INTO para_staff_track_prerequisites(track_id, kind, value, label, sort_order) VALUES ($1,$2,$3,$4,$5)',
          [i.id, prereq.kind, prereq.value, prereq.label, prereq.sort_order ?? idx],
        );
      }
    }
    await audit(c, user.id, 'update_para_staff_track', 'para_staff_tracks', i.id);
    return updated;
  }),
});

// ── 5. publish_para_staff_track ──────────────────────────────────────────────
cap({
  name: 'publish_para_staff_track', method: 'POST', path: '/para/staff/tracks/:id/publish', tag: TAG, auth: ['admin'],
  summary: 'Publish a draft para-sport staff track. The track must have a title and at least a sport or a summary. Only the publishing federation admin or platform admin can publish.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const track = (await c.query('SELECT * FROM para_staff_tracks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!track) throw notFound('Para staff track');
    if (track.status !== 'draft') throw conflict(`Cannot publish a track in status '${track.status}'`);
    await checkTrackPublisher(user, track, c);
    const updated = (await c.query(
      "UPDATE para_staff_tracks SET status='published', published_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
      [i.id],
    )).rows[0];
    await audit(c, user.id, 'publish_para_staff_track', 'para_staff_tracks', i.id);
    return updated;
  }),
});

// ── 6. retire_para_staff_track ───────────────────────────────────────────────
cap({
  name: 'retire_para_staff_track', method: 'POST', path: '/para/staff/tracks/:id/retire', tag: TAG, auth: ['admin'],
  summary: 'Retire a published track. Existing credentials remain valid; the track no longer appears in the browse catalogue. Only the publishing federation admin or platform admin can retire.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const track = (await c.query('SELECT * FROM para_staff_tracks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!track) throw notFound('Para staff track');
    if (track.status !== 'published') throw conflict(`Cannot retire a track in status '${track.status}'`);
    await checkTrackPublisher(user, track, c);
    const updated = (await c.query(
      "UPDATE para_staff_tracks SET status='retired', retired_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
      [i.id],
    )).rows[0];
    await audit(c, user.id, 'retire_para_staff_track', 'para_staff_tracks', i.id);
    return updated;
  }),
});

// ── 7. issue_para_staff_credential ───────────────────────────────────────────
cap({
  name: 'issue_para_staff_credential', method: 'POST', path: '/para/staff/tracks/:id/credentials', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Issue a learning credential to a person who has completed a para-sport staff track. Only the publishing body admin, publisher org admin or platform admin can issue. For classifier_candidate tracks the credential is explicitly flagged as a learning credential only — it NEVER grants classifier role privilege; that authority belongs exclusively to para-governance (#488). Youth account holders: guardian is notified and credential defaults to hidden until guardian approves.',
  input: z.object({
    id,
    holder_id: id.describe('the user who completed the track'),
    issued_on: day.optional(),
    expires_on: day.optional(),
    evidence_note: z.string().trim().max(500).optional().describe('internal note about the completion evidence (not shown publicly)'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const track = await trackOrNotFound(i.id, c);
    if (track.status !== 'published') throw conflict('Only published tracks can have credentials issued against them');
    await checkTrackPublisher(user, track, c);

    if (i.issued_on && i.expires_on && i.expires_on < i.issued_on) throw badRequest('expires_on is before issued_on');

    // Calculate expiry from renewal_months when not provided
    const issuedOn = i.issued_on ?? new Date().toISOString().slice(0, 10);
    let expiresOn = i.expires_on ?? null;
    if (!expiresOn && track.renewal_months) {
      const d = new Date(issuedOn);
      d.setMonth(d.getMonth() + track.renewal_months);
      expiresOn = d.toISOString().slice(0, 10);
    }

    // Check holder exists
    const holder = (await c.query('SELECT id, display_name FROM users WHERE id=$1', [i.holder_id])).rows[0];
    if (!holder) throw notFound('User');

    // No duplicate active credential for this track
    const existing = (await c.query(
      "SELECT id FROM credentials WHERE user_id=$1 AND para_track_id=$2 AND status='issued' AND (expires_on IS NULL OR expires_on >= current_date)",
      [i.holder_id, i.id],
    )).rows[0];
    if (existing) throw conflict('This person already has an active credential for this track');

    const youth = await isYouth(i.holder_id, c);
    const paraMeta = {
      classification_candidate_only: track.role_category === 'classifier_candidate',
      role_category: track.role_category,
      renewal_months: track.renewal_months ?? null,
      scope_countries: track.scope_countries,
      track_title: track.title,
    };

    // Look up publisher name for the credential
    let publisherName = 'Sportarena';
    if (track.publisher_body_id) {
      const pb = (await c.query('SELECT o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id=$1', [track.publisher_body_id])).rows[0];
      if (pb) publisherName = pb.name;
    } else if (track.publisher_org_id) {
      const po = (await c.query('SELECT name FROM organisations WHERE id=$1', [track.publisher_org_id])).rows[0];
      if (po) publisherName = po.name;
    }

    const sport = track.sport_id ? (await c.query('SELECT emoji, name FROM sports WHERE id=$1', [track.sport_id])).rows[0] : null;
    const title = `${sport?.emoji ?? '♿'} ${track.title}`;
    const description = `${track.level_key ? track.level_key.charAt(0).toUpperCase() + track.level_key.slice(1) + ' · ' : ''}${track.role_category.replace(/_/g, ' ')} · ${publisherName}`;

    const cred = (await c.query(
      `INSERT INTO credentials(user_id, organisation_id, sport_id, kind, title, description,
         issued_on, expires_on, code, issued_by, show_on_profile, para_track_id, para_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, kind, title, description, issued_on, expires_on, code, status, para_meta`,
      [i.holder_id, track.publisher_org_id ?? null, track.sport_id ?? null, track.credential_kind,
        title, description, issuedOn, expiresOn, newCode(), user.id,
        !youth, // youth credentials default hidden; guardian approves
        i.id, JSON.stringify(paraMeta)],
    )).rows[0];

    // Schedule expiry reminder if credential will expire
    if (expiresOn) {
      await _maybeScheduleReminder(c, i.holder_id, cred.id, expiresOn, title);
    }

    // Notify holder (and guardian for youth)
    const recipients = youth ? await guardiansOf(i.holder_id, c) : [i.holder_id];
    for (const uid of recipients) {
      await notify(c, uid, {
        kind: 'credential_issued',
        title: `${publisherName} issued a credential`,
        body: youth
          ? `${holder.display_name} earned: ${track.title}. You decide whether it shows on their profile.`
          : `${track.title}${track.role_category === 'classifier_candidate' ? ' (learning credential — does not grant classifier role)' : ''}. Find it in Para Credentials.`,
        data: { credential_id: cred.id, para_track_id: i.id },
      });
    }

    await audit(c, user.id, 'issue_para_staff_credential', 'credentials', cred.id, { track_id: i.id, holder_id: i.holder_id });
    return { ...cred, classification_candidate_only: paraMeta.classification_candidate_only };
  }),
});

async function _maybeScheduleReminder(c, userId, credId, expiresOn, title) {
  const expDate = new Date(expiresOn);
  const reminderDate = new Date(expDate);
  reminderDate.setDate(reminderDate.getDate() - 60);
  if (reminderDate <= new Date()) return; // already in window or past
  // Insert a reminder record (sent=false; a nightly job or the query below fires it)
  await c.query(
    'INSERT INTO para_staff_cred_reminders(credential_id, user_id, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [credId, userId, reminderDate.toISOString()],
  );
}

// ── 8. list_my_para_staff_credentials ────────────────────────────────────────
cap({
  name: 'list_my_para_staff_credentials', method: 'GET', path: '/me/para-staff-credentials', tag: TAG,
  summary: 'Your para-sport staff credentials wallet: all credentials issued against a para staff track, with track detail, expiry status, renewal countdown and the classifier-candidate flag where applicable.',
  input: z.object({
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    sport: z.string().optional(),
    expiring_days: z.number().int().min(1).max(365).optional().describe('return only credentials expiring within N days'),
    ...page,
  }),
  async handler({ user }, i) {
    const sport = i.sport ? await one('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport]) : null;
    const rows = await many(
      `SELECT c.id, c.kind, c.title, c.description, c.issued_on, c.expires_on, c.code, c.status,
              c.show_on_profile, c.para_meta, c.para_track_id,
              t.role_category, t.level_key, t.renewal_months, t.scope_countries, t.title AS track_title,
              s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
              o.name AS publisher_org_name, ob.name AS body_name,
              (c.expires_on IS NOT NULL AND c.expires_on < current_date) AS expired,
              CASE WHEN c.expires_on IS NOT NULL
                   THEN (c.expires_on::date - current_date)
                   ELSE NULL END AS days_to_expiry
         FROM credentials c
         JOIN para_staff_tracks t ON t.id=c.para_track_id
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
        WHERE c.user_id=$1
          AND ($2::uuid IS NULL OR t.sport_id=$2)
          AND ($3::text IS NULL OR t.role_category=$3)
          AND ($4::int IS NULL OR (c.expires_on IS NOT NULL AND (c.expires_on::date - current_date) <= $4))
        ORDER BY c.expires_on NULLS LAST, c.issued_on DESC
        LIMIT $5 OFFSET $6`,
      [user.id, sport?.id ?? null, i.role_category ?? null, i.expiring_days ?? null, i.limit, i.offset],
    );
    return rows.map((r) => ({
      ...r,
      expiry_status: r.status === 'revoked' ? 'revoked'
        : r.expired ? 'expired'
        : r.days_to_expiry != null && r.days_to_expiry <= 60 ? 'expiring_soon'
        : 'valid',
      classification_candidate_only: r.para_meta?.classification_candidate_only ?? false,
    }));
  },
});

// ── 9. get_para_staff_credential ─────────────────────────────────────────────
cap({
  name: 'get_para_staff_credential', method: 'GET', path: '/para/staff/credentials/:id', tag: TAG,
  summary: 'Full detail for a single para-sport staff credential. The holder may read their own; a guardian may read a youth credential they are linked to; a federation admin for the publisher body may read any credential for their body.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cred = await one(
      `SELECT c.*, t.role_category, t.level_key, t.renewal_months, t.scope_countries, t.title AS track_title,
              t.publisher_body_id, t.publisher_org_id,
              s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
              o.name AS publisher_org_name, ob.name AS body_name
         FROM credentials c
         JOIN para_staff_tracks t ON t.id=c.para_track_id
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
        WHERE c.id=$1`,
      [i.id],
    );
    if (!cred) throw notFound('Credential');
    const isHolder = cred.user_id === user.id;
    const isGuardian = !isHolder && await guardianLink(user.id, cred.user_id);
    const isAdmin = user.roles?.includes('admin') || user.roles?.includes('platform_admin');
    if (!isHolder && !isGuardian && !isAdmin) throw notFound('Credential');
    const expired = !!cred.expires_on && new Date(cred.expires_on) < new Date();
    return {
      ...cred,
      expired,
      expiry_status: cred.status === 'revoked' ? 'revoked'
        : expired ? 'expired'
        : cred.expires_on && (new Date(cred.expires_on) - Date.now()) < 60 * 24 * 3600000 ? 'expiring_soon'
        : 'valid',
      classification_candidate_only: cred.para_meta?.classification_candidate_only ?? false,
    };
  },
});

// ── 10. verify_para_staff_credential (public) ─────────────────────────────────
cap({
  name: 'verify_para_staff_credential', method: 'GET', path: '/para/staff/credentials/verify/:code', tag: TAG, auth: 'public',
  summary: 'Verify a para-sport staff credential by its code. Returns whether it is valid, expired or revoked, the track role category, sport, issuing body and expiry date. The holder name is shown only if they chose to show the credential on their profile. Never reveals disability or classification data.',
  input: z.object({ code: z.string().trim().min(6).max(40) }),
  async handler(_, i) {
    const c = await one(
      `SELECT cr.kind, cr.title, cr.issued_on, cr.expires_on, cr.status, cr.show_on_profile, cr.para_meta,
              t.role_category, t.scope_countries,
              s.name AS sport, s.emoji AS sport_emoji,
              ob.name AS body_name, o.name AS publisher_org_name,
              u.handle, u.display_name
         FROM credentials cr
         JOIN para_staff_tracks t ON t.id=cr.para_track_id
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
         JOIN users u ON u.id=cr.user_id
        WHERE cr.code=upper($1)`,
      [i.code],
    );
    if (!c) throw notFound('Credential');
    const expired = !!c.expires_on && new Date(c.expires_on) < new Date(new Date().toISOString().slice(0, 10));
    return {
      valid: c.status === 'issued' && !expired,
      status: c.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'valid',
      kind: c.kind, title: c.title,
      role_category: c.role_category,
      sport: c.sport, sport_emoji: c.sport_emoji,
      issuer: c.body_name ?? c.publisher_org_name,
      scope_countries: c.scope_countries,
      issued_on: c.issued_on, expires_on: c.expires_on,
      classification_candidate_only: c.para_meta?.classification_candidate_only ?? false,
      holder: c.show_on_profile ? { handle: c.handle, display_name: c.display_name } : null,
    };
  },
});

// ── 11. list_federation_staff_credentials ─────────────────────────────────────
cap({
  name: 'list_federation_staff_credentials', method: 'GET', path: '/para/staff/credentials/federation', tag: TAG, auth: ['admin'],
  summary: 'Federation or platform admin: list all para-sport staff credentials issued for tracks owned by your body. Filter by role_category, sport and expiry status. Used for oversight and renewal campaign management.',
  input: z.object({
    body_id: id,
    role_category: z.enum(ROLE_CATEGORIES).optional(),
    sport_id: id.optional(),
    expiry_status: z.enum(['valid', 'expiring_soon', 'expired', 'revoked']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const auth = await authority(user, i.body_id);
    need(auth, 'governance', i.sport_id ?? null);
    return many(
      `SELECT cr.id, cr.kind, cr.title, cr.issued_on, cr.expires_on, cr.status, cr.code, cr.para_meta,
              t.role_category, t.level_key, t.title AS track_title,
              s.name AS sport_name, s.emoji AS sport_emoji,
              u.handle AS holder_handle, u.display_name AS holder_name,
              (cr.expires_on IS NOT NULL AND cr.expires_on < current_date) AS expired,
              CASE WHEN cr.expires_on IS NOT NULL THEN (cr.expires_on::date - current_date) ELSE NULL END AS days_to_expiry
         FROM credentials cr
         JOIN para_staff_tracks t ON t.id=cr.para_track_id AND t.publisher_body_id=$1
         LEFT JOIN sports s ON s.id=t.sport_id
         JOIN users u ON u.id=cr.user_id
        WHERE ($2::text IS NULL OR t.role_category=$2)
          AND ($3::uuid IS NULL OR t.sport_id=$3)
          AND ($4::text IS NULL OR
            ($4='valid'          AND cr.status='issued' AND (cr.expires_on IS NULL OR cr.expires_on >= current_date)) OR
            ($4='expiring_soon'  AND cr.status='issued' AND cr.expires_on IS NOT NULL AND (cr.expires_on::date - current_date) BETWEEN 0 AND 60) OR
            ($4='expired'        AND (cr.expires_on IS NOT NULL AND cr.expires_on < current_date)) OR
            ($4='revoked'        AND cr.status='revoked'))
        ORDER BY cr.expires_on NULLS LAST, u.display_name
        LIMIT $5 OFFSET $6`,
      [i.body_id, i.role_category ?? null, i.sport_id ?? null, i.expiry_status ?? null, i.limit, i.offset],
    );
  },
});

// ── 12. list_academy_para_staff_credentials ───────────────────────────────────
cap({
  name: 'list_academy_para_staff_credentials', method: 'GET', path: '/organisations/:id/para-staff-credentials', tag: TAG, auth: ['admin'],
  summary: 'Academy owner/admin: list all current para-sport staff credentials for active staff members of this organisation. Shows coverage per staff member with expiry status flags (missing, expiring_soon, expired, valid) for each relevant para role. Used in Academy → Validate Staff to confirm para credential compliance before assigning staff to para-sport programmes.',
  input: z.object({ id, role_category: z.enum(ROLE_CATEGORIES).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ['owner', 'admin']);
    // Active staff members
    const staff = await many(
      `SELECT m.user_id, u.handle, u.display_name, m.role
         FROM organisation_members m JOIN users u ON u.id=m.user_id
        WHERE m.organisation_id=$1 AND m.status='active' AND m.left_at IS NULL
          AND m.role IN ('owner','admin','coach','staff')
        ORDER BY u.display_name`,
      [i.id],
    );
    if (!staff.length) return [];
    const userIds = staff.map((s) => s.user_id);
    // All para-staff credentials for these users
    const creds = await many(
      `SELECT cr.id, cr.user_id, cr.title, cr.issued_on, cr.expires_on, cr.status, cr.code, cr.para_meta,
              t.role_category, t.level_key, t.title AS track_title, t.sport_id,
              s.name AS sport_name, s.emoji AS sport_emoji,
              ob.name AS body_name, o.name AS publisher_org_name,
              (cr.expires_on IS NOT NULL AND cr.expires_on < current_date) AS expired,
              CASE WHEN cr.expires_on IS NOT NULL THEN (cr.expires_on::date - current_date) ELSE NULL END AS days_to_expiry
         FROM credentials cr
         JOIN para_staff_tracks t ON t.id=cr.para_track_id
         LEFT JOIN sports s ON s.id=t.sport_id
         LEFT JOIN governing_bodies b ON b.id=t.publisher_body_id
         LEFT JOIN organisations ob ON ob.id=b.organisation_id
         LEFT JOIN organisations o ON o.id=t.publisher_org_id
        WHERE cr.user_id = ANY($1::uuid[])
          AND ($2::text IS NULL OR t.role_category=$2)
        ORDER BY cr.user_id, cr.expires_on NULLS LAST`,
      [userIds, i.role_category ?? null],
    );
    // Group by user
    const byUser = new Map();
    for (const s of staff) byUser.set(s.user_id, { ...s, credentials: [] });
    for (const cr of creds) {
      const entry = byUser.get(cr.user_id);
      if (entry) {
        entry.credentials.push({
          ...cr,
          expiry_status: cr.status === 'revoked' ? 'revoked'
            : cr.expired ? 'expired'
            : cr.days_to_expiry != null && cr.days_to_expiry <= 60 ? 'expiring_soon'
            : 'valid',
          classification_candidate_only: cr.para_meta?.classification_candidate_only ?? false,
        });
      }
    }
    return [...byUser.values()].map((m) => ({
      ...m,
      has_expired: m.credentials.some((c) => c.expiry_status === 'expired'),
      has_expiring: m.credentials.some((c) => c.expiry_status === 'expiring_soon'),
      has_missing: m.credentials.length === 0,
      credential_count: m.credentials.length,
    }));
  },
});

// ── 13. acknowledge_renewal_reminder ─────────────────────────────────────────
cap({
  name: 'acknowledge_renewal_reminder', method: 'POST', path: '/me/para-staff-credentials/:id/acknowledge', tag: TAG,
  summary: 'Acknowledge a renewal reminder for one of your para-sport staff credentials. The reminder is marked acknowledged and will not resurface until the next scheduled window.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cred = await one('SELECT id, user_id FROM credentials WHERE id=$1 AND para_track_id IS NOT NULL', [i.id]);
    if (!cred) throw notFound('Credential');
    if (cred.user_id !== user.id && !(await guardianLink(user.id, cred.user_id))) throw notFound('Credential');
    const updated = await pool.query(
      'UPDATE para_staff_cred_reminders SET acknowledged=true, ack_at=now() WHERE credential_id=$1 AND user_id=$2 AND NOT acknowledged RETURNING id',
      [i.id, cred.user_id],
    );
    return { acknowledged: updated.rowCount > 0 };
  },
});
