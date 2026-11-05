// PS-17: Para-athlete doctor consultations and sport-specific clinical coordination.
// Extends the canonical medical system (#212): doctors may opt into sport-specific consultation
// scopes, build reusable para-sport consult templates, track para episodes, and prepare
// nonclinical support summaries that athletes consent to share with named staff (revocable).
//
// HARD boundaries enforced at every action:
//  1. Content returned to non-author/non-athlete viewers is NEVER clinical (no diagnosis,
//     medication, test results, case notes, or outcome measures).
//  2. A clinical clearance issued through this module NEVER references or implies a
//     para-sport classification outcome — classification is governed by para_cases.js / #488.
//  3. Specialisms declared here are consultation-scope markers only; they confer no
//     classification authority whatsoever.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';
import { SPECIALISATIONS } from './para-physio.js';

const TAG = 'Health';
const t = (n) => z.string().trim().max(n);

// Nonclinical content guard: reject summaries that appear to contain clinical content.
const CLINICAL_TERMS = ['diagnosis', 'diagnos', 'medication', 'prescribed', 'allergy', 'medic', 'treatment', 'pathology', 'blood', 'mri', 'scan ', 'fracture', 'surgery', 'disorder', 'syndrome', 'impairment classification', 'class ', 'classified', 'ipc class'];
function guardNonclinical(text) {
  const lower = text.toLowerCase();
  for (const term of CLINICAL_TERMS) {
    if (lower.includes(term)) throw badRequest(`Support summaries must not contain clinical information. Remove any reference to ${term.trim()} and describe only operational support needs.`);
  }
}

async function mustOwnTemplate(templateId, userId) {
  const t = await one('SELECT * FROM para_consult_templates WHERE id=$1', [templateId]);
  if (!t || t.provider_id !== userId) throw notFound('Consultation template');
  return t;
}

async function mustOwnEpisode(episodeId, userId) {
  const e = await one('SELECT * FROM para_doctor_episodes WHERE id=$1', [episodeId]);
  if (!e || e.doctor_id !== userId) throw notFound('Para episode');
  return e;
}

async function mustOwnSummary(summaryId, userId, role) {
  const s = await one('SELECT * FROM para_support_summaries WHERE id=$1', [summaryId]);
  if (!s) throw notFound('Support summary');
  if (role === 'doctor' && s.author_id !== userId) throw forbidden();
  if (role === 'athlete' && s.athlete_id !== userId) throw forbidden();
  return s;
}

// ── 1. Specialism declaration ──────────────────────────────────────────────────────────────────────

cap({
  name: 'get_para_doctor_catalogue', method: 'GET', path: '/para-doctor/catalogue', tag: TAG, auth: 'public',
  summary: 'Reference vocabulary for para-doctor consultations: valid sport specialisms. No personal data.',
  handler: async () => ({ specialisations: SPECIALISATIONS }),
});

cap({
  name: 'declare_para_doctor_specialism', credential: true, method: 'POST', path: '/para-doctor/specialisms', tag: TAG, auth: ['doctor'], status: 201,
  summary: 'Doctor opts into a named para-sport specialism. Specialisms inform consultation scope only — they never grant classification authority.',
  input: z.object({ specialism: z.enum(SPECIALISATIONS) }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'declare_para_doctor_specialism' });
    await tx(async (c) => {
      // Store as a JSON array on the provider's physio_para_expertise table (reuse PS-16 table, additive)
      await c.query(
        `INSERT INTO physio_para_expertise(provider_id, specialisation, source)
           VALUES ($1, $2, 'self_declared')
           ON CONFLICT (provider_id, specialisation) DO NOTHING`,
        [user.id, i.specialism]);
    });
    await audit(null, user.id, 'declare_specialism', 'physio_para_expertise', null);
    return { ok: true, specialism: i.specialism, note: 'This is a consultation scope marker only. It confers no classification authority.' };
  },
});

cap({
  name: 'list_my_para_doctor_specialisms', method: 'GET', path: '/para-doctor/specialisms', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: your declared para-sport specialisms.',
  handler: ({ user }) => many(
    `SELECT e.specialisation, e.source, e.created_at FROM physio_para_expertise e
       WHERE e.provider_id=$1 AND e.archived_at IS NULL ORDER BY e.created_at`, [user.id]),
});

// ── 2. Consultation templates ──────────────────────────────────────────────────────────────────────

cap({
  name: 'create_para_consult_template', credential: true, method: 'POST', path: '/para-doctor/templates', tag: TAG, auth: ['doctor'], status: 201,
  summary: 'Doctor creates a reusable para-sport consultation template for a sport context. Templates are declared per provider, not per athlete diagnosis.',
  input: z.object({
    sport: z.enum(SPECIALISATIONS),
    name: t(200).min(1),
    description: t(1000).optional(),
    fields: z.array(z.object({ key: t(80).min(1), label: t(200).min(1), type: z.enum(['text','multiline','number','date','choice','switch']), optional: z.boolean().default(true), options: z.array(t(200)).optional() })).max(30).default([]),
    status: z.enum(['active','draft']).default('draft'),
  }),
  async handler({ user }, i) {
    const cred = await requireVerifiedProvider(user.id, { action: 'create_para_consult_template' });
    return tx(async (c) => {
      await lockCredential(c, cred);
      const row = (await c.query(
        `INSERT INTO para_consult_templates(provider_id, sport, name_enc, description_enc, fields_json, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, provider_id, sport, status, use_count, created_at`,
        [user.id, i.sport, encrypt(i.name, 'para_consult_templates.name'), i.description ? encrypt(i.description, 'para_consult_templates.description') : null, JSON.stringify(i.fields), i.status])).rows[0];
      await audit(c, user.id, 'write_clinical', 'para_consult_templates', row.id);
      return { ...row, name: i.name, description: i.description ?? null };
    });
  },
});

cap({
  name: 'list_para_consult_templates', method: 'GET', path: '/para-doctor/templates', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: list your para-sport consultation templates.',
  input: z.object({ sport: z.enum(SPECIALISATIONS).optional(), status: z.enum(['active','draft','archived']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT id, provider_id, sport, name_enc, description_enc, fields_json, status, use_count, created_at, updated_at
         FROM para_consult_templates
         WHERE provider_id=$1 AND ($2::text IS NULL OR sport=$2) AND ($3::text IS NULL OR status=$3)
         ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [user.id, i.sport ?? null, i.status ?? null, i.limit, i.offset]);
    return rows.map(({ name_enc, description_enc, fields_json, ...r }) => ({
      ...r,
      name: decrypt(name_enc, 'para_consult_templates.name'),
      description: description_enc ? decrypt(description_enc, 'para_consult_templates.description') : null,
      fields: fields_json,
    }));
  },
});

cap({
  name: 'update_para_consult_template', credential: true, method: 'PATCH', path: '/para-doctor/templates/:id', tag: TAG, auth: ['doctor'],
  summary: 'Doctor updates one of their consultation templates.',
  input: z.object({ id, name: t(200).optional(), description: t(1000).optional(), fields: z.array(z.object({ key: t(80).min(1), label: t(200).min(1), type: z.enum(['text','multiline','number','date','choice','switch']), optional: z.boolean().default(true), options: z.array(t(200)).optional() })).max(30).optional(), status: z.enum(['active','draft','archived']).optional() }),
  async handler({ user }, i) {
    const cred = await requireVerifiedProvider(user.id, { action: 'update_para_consult_template' });
    return tx(async (c) => {
      await lockCredential(c, cred);
      const tmpl = await mustOwnTemplate(i.id, user.id);
      const sets = [], vals = [i.id];
      if (i.name !== undefined) { sets.push(`name_enc=$${vals.push(encrypt(i.name, 'para_consult_templates.name'))}`); }
      if (i.description !== undefined) { sets.push(`description_enc=$${vals.push(i.description ? encrypt(i.description, 'para_consult_templates.description') : null)}`); }
      if (i.fields !== undefined) { sets.push(`fields_json=$${vals.push(JSON.stringify(i.fields))}`); }
      if (i.status !== undefined) { sets.push(`status=$${vals.push(i.status)}`); }
      if (!sets.length) return { id: tmpl.id };
      sets.push('updated_at=now()');
      const row = (await c.query(`UPDATE para_consult_templates SET ${sets.join(',')} WHERE id=$1 RETURNING id, sport, status, use_count`, vals)).rows[0];
      await audit(c, user.id, 'write_clinical', 'para_consult_templates', i.id);
      return { ...row, name: i.name ?? decrypt(tmpl.name_enc, 'para_consult_templates.name') };
    });
  },
});

// ── 3. Para episodes ───────────────────────────────────────────────────────────────────────────────

cap({
  name: 'create_para_episode', credential: true, method: 'POST', path: '/para-doctor/episodes', tag: TAG, auth: ['doctor'], status: 201,
  summary: 'Doctor opens a para-sport episode for an athlete who has granted full medical access. Links to an optional appointment and consultation template.',
  input: z.object({ athlete_id: id, sport: z.enum(SPECIALISATIONS), template_id: id.optional(), appointment_id: id.optional() }),
  async handler({ user }, i) {
    const cred = await requireVerifiedProvider(user.id, { action: 'create_para_episode', athleteId: i.athlete_id });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you full medical access');
    return tx(async (c) => {
      await lockCredential(c, cred);
      if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [i.athlete_id, user.id])).rows[0]) throw forbidden('The athlete has not granted you full medical access');
      if (i.template_id) await mustOwnTemplate(i.template_id, user.id);
      const row = (await c.query(
        `INSERT INTO para_doctor_episodes(athlete_id, doctor_id, sport, template_id, appointment_id)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [i.athlete_id, user.id, i.sport, i.template_id ?? null, i.appointment_id ?? null])).rows[0];
      if (i.template_id) await c.query('UPDATE para_consult_templates SET use_count=use_count+1, updated_at=now() WHERE id=$1', [i.template_id]);
      await audit(c, user.id, 'write_clinical', 'para_doctor_episodes', row.id);
      await notify(c, i.athlete_id, { kind: 'para_episode_opened', title: 'Para-sport episode opened', body: 'Your doctor has opened a para-sport episode. Open Health to see it.', data: { episode_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'list_para_episodes', method: 'GET', path: '/para-doctor/episodes', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: list para episodes you have opened, optionally filtered by athlete or status.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['active','complete','archived']).optional(), ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT e.*, u.display_name AS athlete_name FROM para_doctor_episodes e
         JOIN users u ON u.id=e.athlete_id
         WHERE e.doctor_id=$1 AND ($2::uuid IS NULL OR e.athlete_id=$2) AND ($3::text IS NULL OR e.status=$3)
         ORDER BY e.created_at DESC LIMIT $4 OFFSET $5`,
      [user.id, i.athlete_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_para_episode', credential: true, method: 'GET', path: '/para-doctor/episodes/:id', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: get a single para episode (audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'get_para_episode' });
    const episode = await mustOwnEpisode(i.id, user.id);
    await audit(null, user.id, 'read_clinical', 'para_doctor_episodes', episode.athlete_id);
    const athlete = await one('SELECT display_name FROM users WHERE id=$1', [episode.athlete_id]);
    let template = null;
    if (episode.template_id) {
      const tmpl = await one('SELECT * FROM para_consult_templates WHERE id=$1', [episode.template_id]);
      if (tmpl) template = { id: tmpl.id, sport: tmpl.sport, name: decrypt(tmpl.name_enc, 'para_consult_templates.name'), fields: tmpl.fields_json };
    }
    return { ...episode, athlete_name: athlete?.display_name ?? null, template };
  },
});

cap({
  name: 'update_para_episode_status', credential: true, method: 'PATCH', path: '/para-doctor/episodes/:id/status', tag: TAG, auth: ['doctor'],
  summary: 'Doctor marks an episode complete or archived.',
  input: z.object({ id, status: z.enum(['complete','archived']) }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'update_para_episode_status' });
    const episode = await mustOwnEpisode(i.id, user.id);
    await tx(async (c) => {
      await c.query('UPDATE para_doctor_episodes SET status=$2, updated_at=now() WHERE id=$1', [episode.id, i.status]);
      await audit(c, user.id, 'write_clinical', 'para_doctor_episodes', episode.id);
    });
    return { id: episode.id, status: i.status };
  },
});

// ── 4. Support summaries ───────────────────────────────────────────────────────────────────────────

cap({
  name: 'draft_support_summary', credential: true, method: 'POST', path: '/para-doctor/support-summaries', tag: TAG, auth: ['doctor'], status: 201,
  summary: 'Doctor drafts a nonclinical support summary for an athlete (pending their consent). Content must be operational only: access needs, emergency contacts, logistics. No clinical information, diagnosis, medication or classification status.',
  input: z.object({ athlete_id: id, audience_label: t(300).min(1).describe('Who the summary is intended for, e.g. "Nadal Academy Staff"'), content: t(3000).min(10).describe('Nonclinical operational information only. No diagnosis, medication, test results or classification status.') }),
  async handler({ user }, i) {
    const cred = await requireVerifiedProvider(user.id, { action: 'draft_support_summary', athleteId: i.athlete_id });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you full medical access');
    guardNonclinical(i.content);
    return tx(async (c) => {
      await lockCredential(c, cred);
      if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [i.athlete_id, user.id])).rows[0]) throw forbidden('The athlete has not granted you full medical access');
      const row = (await c.query(
        `INSERT INTO para_support_summaries(athlete_id, author_id, audience_label, content_enc)
           VALUES ($1,$2,$3,$4) RETURNING id, athlete_id, author_id, audience_label, status, created_at`,
        [i.athlete_id, user.id, i.audience_label, encrypt(i.content, 'para_support_summaries.content')])).rows[0];
      await audit(c, user.id, 'write_clinical', 'para_support_summaries', row.id);
      await notify(c, i.athlete_id, { kind: 'support_summary_pending', title: 'Your doctor prepared a support summary', body: 'Review it in Health → Support and decide who can see it.', data: { summary_id: row.id } });
      return { ...row, note: 'The athlete must consent before this summary can be shared with anyone.' };
    });
  },
});

cap({
  name: 'list_support_summaries', method: 'GET', path: '/para-doctor/support-summaries', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: list support summaries you have drafted.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['pending_consent','active','revoked']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.id, s.athlete_id, u.display_name AS athlete_name, s.audience_label, s.status, s.athlete_consented_at, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM para_support_summary_access a WHERE a.summary_id=s.id AND a.revoked_at IS NULL) AS active_viewers
         FROM para_support_summaries s JOIN users u ON u.id=s.athlete_id
         WHERE s.author_id=$1 AND ($2::uuid IS NULL OR s.athlete_id=$2) AND ($3::text IS NULL OR s.status=$3)
         ORDER BY s.created_at DESC LIMIT $4 OFFSET $5`,
      [user.id, i.athlete_id ?? null, i.status ?? null, i.limit, i.offset]);
    return rows;
  },
});

cap({
  name: 'get_support_summary', credential: true, method: 'GET', path: '/para-doctor/support-summaries/:id', tag: TAG, auth: ['doctor'],
  summary: 'Doctor: get a support summary they authored (content decrypted, audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'get_support_summary' });
    const s = await mustOwnSummary(i.id, user.id, 'doctor');
    await audit(null, user.id, 'read_clinical', 'para_support_summaries', s.athlete_id);
    const access = await many(
      `SELECT a.grantee_id, u.display_name AS grantee_name, a.granted_at, a.revoked_at
         FROM para_support_summary_access a JOIN users u ON u.id=a.grantee_id
         WHERE a.summary_id=$1 ORDER BY a.granted_at`, [i.id]);
    const athlete = await one('SELECT display_name FROM users WHERE id=$1', [s.athlete_id]);
    return { ...s, athlete_name: athlete?.display_name ?? null, content: decrypt(s.content_enc, 'para_support_summaries.content'), access };
  },
});

// ── 5. Athlete consent and access control ─────────────────────────────────────────────────────────

cap({
  name: 'list_my_support_summaries', method: 'GET', path: '/me/support-summaries', tag: TAG,
  summary: 'Athlete: list support summaries prepared for you (content decrypted for you only; audit-logged).',
  input: z.object({ status: z.enum(['pending_consent','active','revoked']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.id, s.author_id, u.display_name AS author_name, s.audience_label, s.status, s.athlete_consented_at, s.created_at,
              (SELECT COUNT(*) FROM para_support_summary_access a WHERE a.summary_id=s.id AND a.revoked_at IS NULL) AS active_viewers
         FROM para_support_summaries s JOIN users u ON u.id=s.author_id
         WHERE s.athlete_id=$1 AND ($2::text IS NULL OR s.status=$2)
         ORDER BY s.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.status ?? null, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_own', 'para_support_summaries', null);
    // content is decrypted for the athlete only after they have set an explicit view intent; return them without content by default
    return rows;
  },
});

cap({
  name: 'get_my_support_summary', method: 'GET', path: '/me/support-summaries/:id', tag: TAG,
  summary: 'Athlete: read a single support summary prepared for them (content decrypted, audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    await audit(null, user.id, 'read_own', 'para_support_summaries', s.id);
    const access = await many(
      `SELECT a.grantee_id, u.display_name AS grantee_name, a.granted_at, a.revoked_at
         FROM para_support_summary_access a JOIN users u ON u.id=a.grantee_id
         WHERE a.summary_id=$1 ORDER BY a.granted_at`, [i.id]);
    const author = await one('SELECT display_name FROM users WHERE id=$1', [s.author_id]);
    return { ...s, author_name: author?.display_name ?? null, content: decrypt(s.content_enc, 'para_support_summaries.content'), access };
  },
});

cap({
  name: 'athlete_consent_support_summary', method: 'POST', path: '/me/support-summaries/:id/consent', tag: TAG,
  summary: 'Athlete approves a pending support summary, allowing the doctor to grant access to named staff.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    if (s.status !== 'pending_consent') throw badRequest(`This summary is already ${s.status}`);
    await tx(async (c) => {
      await c.query("UPDATE para_support_summaries SET status='active', athlete_consented_at=now(), updated_at=now() WHERE id=$1", [i.id]);
      await audit(c, user.id, 'consent_summary', 'para_support_summaries', i.id);
      await notify(c, s.author_id, { kind: 'support_summary_consented', title: 'Athlete approved the support summary', body: 'You can now share it with staff.', data: { summary_id: i.id } });
    });
    return { id: i.id, status: 'active' };
  },
});

cap({
  name: 'athlete_decline_support_summary', method: 'POST', path: '/me/support-summaries/:id/decline', tag: TAG,
  summary: 'Athlete declines a support summary (status → revoked). Existing access grants are ended.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    if (s.status === 'revoked') return { id: i.id, status: 'revoked' };
    await tx(async (c) => {
      await c.query("UPDATE para_support_summaries SET status='revoked', updated_at=now() WHERE id=$1", [i.id]);
      await c.query('UPDATE para_support_summary_access SET revoked_at=now() WHERE summary_id=$1 AND revoked_at IS NULL', [i.id]);
      await audit(c, user.id, 'revoke_summary', 'para_support_summaries', i.id);
      await notify(c, s.author_id, { kind: 'support_summary_declined', title: 'Athlete declined the support summary', body: 'The summary will not be shared.', data: { summary_id: i.id } });
    });
    return { id: i.id, status: 'revoked' };
  },
});

cap({
  name: 'grant_support_summary_access', method: 'POST', path: '/me/support-summaries/:id/access', tag: TAG, status: 201,
  summary: 'Athlete grants a named platform user access to an active support summary.',
  input: z.object({ id, grantee_id: id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    if (s.status !== 'active') throw badRequest('You must approve the summary before sharing it');
    if (i.grantee_id === user.id) throw badRequest('You cannot grant access to yourself');
    return tx(async (c) => {
      await c.query(
        `INSERT INTO para_support_summary_access(summary_id, grantee_id)
           VALUES ($1,$2)
           ON CONFLICT (summary_id, grantee_id) DO UPDATE SET revoked_at=NULL, granted_at=now()`,
        [i.id, i.grantee_id]);
      await audit(c, user.id, 'grant_summary_access', 'para_support_summary_access', i.id);
      const grantee = await one('SELECT display_name FROM users WHERE id=$1', [i.grantee_id]);
      await notify(c, i.grantee_id, { kind: 'support_summary_access', title: 'An athlete shared a support summary', body: 'Open Health to view the operational support information.', data: { summary_id: i.id } });
      return { ok: true, grantee_name: grantee?.display_name ?? null };
    });
  },
});

cap({
  name: 'revoke_support_summary_access', method: 'DELETE', path: '/me/support-summaries/:id/access/:grantee_id', tag: TAG,
  summary: 'Athlete revokes one person\'s access to a support summary.',
  input: z.object({ id, grantee_id: id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    await tx(async (c) => {
      await c.query('UPDATE para_support_summary_access SET revoked_at=now() WHERE summary_id=$1 AND grantee_id=$2 AND revoked_at IS NULL', [s.id, i.grantee_id]);
      await audit(c, user.id, 'revoke_summary_access', 'para_support_summary_access', s.id);
    });
    return { ok: true };
  },
});

cap({
  name: 'revoke_all_support_summary_access', method: 'POST', path: '/me/support-summaries/:id/revoke-all', tag: TAG,
  summary: 'Athlete revokes all access to a support summary and sets it to revoked.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await mustOwnSummary(i.id, user.id, 'athlete');
    await tx(async (c) => {
      await c.query('UPDATE para_support_summary_access SET revoked_at=now() WHERE summary_id=$1 AND revoked_at IS NULL', [s.id]);
      await c.query("UPDATE para_support_summaries SET status='revoked', updated_at=now() WHERE id=$1", [s.id]);
      await audit(c, user.id, 'revoke_summary_all', 'para_support_summaries', s.id);
      await notify(c, s.author_id, { kind: 'support_summary_revoked', title: 'Athlete revoked the support summary', body: 'The summary is no longer shared with anyone.', data: { summary_id: i.id } });
    });
    return { id: i.id, status: 'revoked' };
  },
});

cap({
  name: 'list_support_summary_access', method: 'GET', path: '/support-summaries/:id/access', tag: TAG,
  summary: 'List who has access to a support summary. Visible to the athlete subject or the doctor author.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM para_support_summaries WHERE id=$1', [i.id]);
    if (!s) throw notFound('Support summary');
    if (s.athlete_id !== user.id && s.author_id !== user.id) throw forbidden();
    if (s.author_id === user.id) await audit(null, user.id, 'read_clinical', 'para_support_summary_access', s.athlete_id);
    return many(
      `SELECT a.id, a.grantee_id, u.display_name AS grantee_name, a.granted_at, a.revoked_at
         FROM para_support_summary_access a JOIN users u ON u.id=a.grantee_id
         WHERE a.summary_id=$1 ORDER BY a.granted_at`, [i.id]);
  },
});

// Athlete: list their own para episodes (from their health file).
cap({
  name: 'list_my_para_episodes', method: 'GET', path: '/me/para-episodes', tag: TAG,
  summary: 'Athlete: list para-doctor episodes opened for them.',
  input: z.object({ status: z.enum(['active','complete','archived']).optional(), ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT e.id, e.sport, e.status, e.created_at, e.updated_at, u.display_name AS doctor_name, t.name_enc AS template_name_enc
         FROM para_doctor_episodes e
         JOIN users u ON u.id=e.doctor_id
         LEFT JOIN para_consult_templates t ON t.id=e.template_id
         WHERE e.athlete_id=$1 AND ($2::text IS NULL OR e.status=$2)
         ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.status ?? null, i.limit, i.offset]).then((rows) =>
      rows.map(({ template_name_enc, ...r }) => ({
        ...r,
        template_name: template_name_enc ? decrypt(template_name_enc, 'para_consult_templates.name') : null,
      })));
  },
});
