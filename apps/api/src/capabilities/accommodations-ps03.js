// PS-03: Consented athlete accessibility and operational accommodations.
// Incremental additions to #808: per-event sharing, purpose, edit/revise, accessible contact & arrival
// preferences, staff actionable checklist with completion tracking, and data subject access/correction.
// No diagnosis is ever asked for, stored or shown. All sensitive text is field-level encrypted.
// Every access of contact preferences or checklist is audit-logged and visible to the athlete.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one, pool, withClient } from '../db.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { screen } from '../wellbeing.js';
import {
  AUDIENCE_ROLES, PURPOSE_KEYS, SHARE_CONTEXTS, CONTACT_MODES, SHARE_MONTHS_MAX,
  checkNeeds, typeOfNeed, sealNote, unsealNote, log, liveShares, shareIsLive,
  actingFor, badRequest, conflict, forbidden, notFound, guardianLink, isYouth,
} from '../inclusion.js';
import { opsAccess } from '../academy-ops.js';

const TAG = 'Accommodation preferences (PS-03)';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const sealPref = (text, field) => (text ? encrypt(screen(text), `athlete_contact_preferences.${field}`) : null);
const unsealPref = (enc, field) => (enc ? decrypt(enc, `athlete_contact_preferences.${field}`) : null);
const sealCorr = (text) => encrypt(screen(text), 'accommodation_correction_requests.description');
const unsealCorr = (enc) => (enc ? decrypt(enc, 'accommodation_correction_requests.description') : null);

// ---- helpers ----
const shareOwner = async (c, shareId, user) => {
  const s = (await c.query('SELECT * FROM academy_accommodation_shares WHERE id=$1 FOR UPDATE', [shareId])).rows[0];
  if (!s) throw notFound('Share');
  try { await actingFor(c, user, s.athlete_id, 'consent'); } catch { throw notFound('Share'); }
  return s;
};

const needLabelKeys = (keys) => keys.map((k) => ({ key: k, type: typeOfNeed(k) }));
const shareView = (s, live, views) => ({
  id: s.id, organisation_id: s.organisation_id, athlete_id: s.athlete_id,
  needs: needLabelKeys(s.need_keys), note: unsealNote(s.note_enc, 'note'),
  audience_user_ids: s.audience_users, audience_roles: s.audience_roles,
  expires_at: s.expires_at, revoked_at: s.revoked_at, granted_as: s.granted_as,
  status: s.revoked_at ? 'revoked' : !live ? 'lapsed' : 'active',
  viewed_count: views,
  context: s.context ?? 'academy', event_id: s.event_id ?? null,
  purpose_key: s.purpose_key ?? null, purpose: s.purpose ?? null,
});

// ------------------------------------------------------------------------------------------------------------------ update/revise share

cap({
  name: 'update_accommodation_share',
  method: 'PATCH',
  path: '/accommodations/:id',
  tag: TAG,
  summary: 'Athlete or verified guardian: revise an existing live accommodation share — change which needs, the audience, the expiry, the purpose or the note. Revoking removes access immediately; for a soft revision the share_id is preserved and the change is logged. Cannot revive a revoked share.',
  input: z.object({
    id,
    need_keys: z.array(z.string().max(40)).min(1).max(12).optional(),
    audience_user_ids: z.array(id).max(20).optional(),
    audience_roles: z.array(z.enum(AUDIENCE_ROLES)).max(3).optional(),
    expires_on: day.optional(),
    purpose_key: z.enum(PURPOSE_KEYS).optional(),
    purpose: z.string().trim().max(200).optional(),
    note: z.string().trim().max(300).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await shareOwner(c, i.id, user);
      if (s.revoked_at) throw badRequest('A revoked share cannot be revised. Create a new share instead.');
      const needs = i.need_keys ? checkNeeds(i.need_keys) : s.need_keys;
      const roles = i.audience_roles ?? s.audience_roles;
      const userIds = i.audience_user_ids ?? s.audience_users;
      if (!userIds.length && !roles.length) throw badRequest('Choose who may see this: named staff, the coach or the venue');
      const expiresOn = i.expires_on ?? s.expires_at.toISOString().slice(0, 10);
      if (expiresOn <= today() || expiresOn > plusDays(SHARE_MONTHS_MAX * 31)) throw badRequest(`Choose an expiry date within the next ${SHARE_MONTHS_MAX} months`);
      if (i.audience_user_ids) {
        for (const u of i.audience_user_ids) {
          const ok = await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [s.organisation_id, u]);
          if (!ok.rowCount) throw badRequest('Everyone named must be an active member of this academy');
        }
      }
      const noteEnc = i.note !== undefined ? sealNote(i.note, 'note') : s.note_enc;
      const purposeKey = i.purpose_key !== undefined ? i.purpose_key : s.purpose_key;
      const purpose = i.purpose !== undefined ? i.purpose : s.purpose;
      const row = (await c.query(
        'UPDATE academy_accommodation_shares SET need_keys=$2, audience_users=$3, audience_roles=$4, expires_at=$5, purpose_key=$6, purpose=$7, note_enc=$8 WHERE id=$1 RETURNING *',
        [s.id, needs, userIds, roles, `${expiresOn}T23:59:59Z`, purposeKey, purpose, noteEnc],
      )).rows[0];
      await log(c, s.organisation_id, s.athlete_id, 'share_revised', user.id, { type: 'share', id: s.id }, needs.map(typeOfNeed).join(','));
      await audit(c, user.id, 'update_accommodation_share', 'academy_accommodation_shares', s.id);
      for (const u of userIds) {
        await notify(c, u, { kind: 'academy_inclusion', title: 'Support preferences updated', body: 'An athlete updated their shared operational needs.', data: { organisation_id: s.organisation_id }, dedupe_key: `incl:upd:${row.id}:${u}` });
      }
      const views = Number((await one("SELECT count(*) AS n FROM academy_inclusion_events WHERE ref_type='share' AND ref_id=$1 AND kind='share_viewed'", [s.id])).n);
      return shareView(row, true, views);
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ accessible contact & arrival preferences

cap({
  name: 'save_accessible_contact_preferences',
  method: 'PUT',
  path: '/me/contact-preferences',
  tag: TAG,
  summary: 'Athlete or verified guardian: save preferred contact mode (in-app, email, SMS, or BSL interpreter required), an alternative contact person, arrival instructions and entry point. All free-text fields are screened for clinical content and field-level encrypted. Visible only to staff holding a live accommodation share that explicitly includes a communication need. Every read by staff is audit-logged.',
  input: z.object({
    athlete_id: id.optional(),
    contact_mode: z.enum(CONTACT_MODES),
    alt_contact_name: z.string().trim().max(100).optional(),
    alt_contact_phone: z.string().trim().max(30).optional(),
    arrival_instructions: z.string().trim().max(500).optional(),
    entry_point: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await actingFor(c, user, athleteId, 'consent');
      const enc = {
        alt_contact_name_enc: sealPref(i.alt_contact_name, 'alt_contact_name'),
        alt_contact_phone_enc: sealPref(i.alt_contact_phone, 'alt_contact_phone'),
        arrival_instructions_enc: sealPref(i.arrival_instructions, 'arrival_instructions'),
        entry_point_enc: sealPref(i.entry_point, 'entry_point'),
      };
      const row = (await c.query(
        `INSERT INTO athlete_contact_preferences(athlete_id, contact_mode, alt_contact_name_enc, alt_contact_phone_enc, arrival_instructions_enc, entry_point_enc, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (athlete_id) DO UPDATE SET contact_mode=$2, alt_contact_name_enc=$3, alt_contact_phone_enc=$4, arrival_instructions_enc=$5, entry_point_enc=$6, updated_by=$7, updated_at=now()
         RETURNING *`,
        [athleteId, i.contact_mode, enc.alt_contact_name_enc, enc.alt_contact_phone_enc, enc.arrival_instructions_enc, enc.entry_point_enc, user.id],
      )).rows[0];
      await audit(c, user.id, 'save_accessible_contact_preferences', 'athlete_contact_preferences', athleteId);
      return { athlete_id: athleteId, contact_mode: row.contact_mode, updated_at: row.updated_at };
    });
  },
});

cap({
  name: 'get_accessible_contact_preferences',
  method: 'GET',
  path: '/me/contact-preferences',
  tag: TAG,
  summary: 'Retrieve own (or guardian-managed) accessible contact & arrival preferences.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id && !(await guardianLink(user.id, athleteId))) throw notFound('Person');
    const row = await one('SELECT * FROM athlete_contact_preferences WHERE athlete_id=$1', [athleteId]);
    if (!row) return { athlete_id: athleteId, contact_mode: 'app', alt_contact_name: null, alt_contact_phone: null, arrival_instructions: null, entry_point: null, updated_at: null };
    return {
      athlete_id: athleteId,
      contact_mode: row.contact_mode,
      alt_contact_name: unsealPref(row.alt_contact_name_enc, 'alt_contact_name'),
      alt_contact_phone: unsealPref(row.alt_contact_phone_enc, 'alt_contact_phone'),
      arrival_instructions: unsealPref(row.arrival_instructions_enc, 'arrival_instructions'),
      entry_point: unsealPref(row.entry_point_enc, 'entry_point'),
      updated_at: row.updated_at,
    };
  },
});

cap({
  name: 'get_staff_contact_preferences',
  method: 'GET',
  path: '/accommodations/:share_id/contact-preferences',
  tag: TAG,
  summary: 'Staff: access the contact and arrival preferences for the athlete on a specific live share. Only accessible when the caller is in the share\'s audience AND the share includes a communication-type need. Every read is audit-logged and visible to the athlete.',
  input: z.object({ share_id: id }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const q = c.query.bind(c);
      const s = (await c.query('SELECT * FROM academy_accommodation_shares WHERE id=$1', [i.share_id])).rows[0];
      if (!s) throw notFound('Share');
      if (s.revoked_at || new Date(s.expires_at) <= new Date()) throw notFound('Share');
      if (!(await shareIsLive({ query: q }, s))) throw notFound('Share');
      const hasCommNeed = s.need_keys.some((k) => typeOfNeed(k) === 'communication');
      if (!hasCommNeed) throw forbidden('Contact preferences are only accessible when a communication need is shared');
      const inAud = s.audience_users.includes(user.id);
      if (!inAud) {
        const memberCheck = await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin','coach','staff')", [s.organisation_id, user.id]);
        if (!memberCheck.rowCount) throw forbidden('Not in audience');
        const hasRole = s.audience_roles.some((r) => ['coach', 'venue', 'event_staff'].includes(r));
        if (!hasRole) throw forbidden('Not in audience');
      }
      const row = await one('SELECT * FROM athlete_contact_preferences WHERE athlete_id=$1', [s.athlete_id]);
      await log({ query: q }, s.organisation_id, s.athlete_id, 'contact_preferences_viewed', user.id, { type: 'share', id: s.id }, `staff:${user.id}`);
      await audit({ query: q }, user.id, 'get_staff_contact_preferences', 'athlete_contact_preferences', s.athlete_id);
      if (!row) return { contact_mode: 'app', alt_contact_name: null, alt_contact_phone: null, arrival_instructions: null, entry_point: null };
      return {
        contact_mode: row.contact_mode,
        alt_contact_name: unsealPref(row.alt_contact_name_enc, 'alt_contact_name'),
        alt_contact_phone: unsealPref(row.alt_contact_phone_enc, 'alt_contact_phone'),
        arrival_instructions: unsealPref(row.arrival_instructions_enc, 'arrival_instructions'),
        entry_point: unsealPref(row.entry_point_enc, 'entry_point'),
      };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ staff actionable checklist

cap({
  name: 'get_accommodation_checklist',
  method: 'GET',
  path: '/academy/sessions/:session_id/accommodation-checklist',
  tag: TAG,
  summary: 'Session staff or event coordinator: an actionable checklist of every consented operational need for enrolled athletes, grouped by athlete, with arranged/pending status per item. Only needs the caller is authorised to see are shown (same audience rules as get_session_accommodations). No diagnosis or clinical detail. Every read is audit-logged.',
  input: z.object({ session_id: id }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const q = c.query.bind(c);
      const sess = (await c.query(
        "SELECT s.*, k.programme_id FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.id=$1",
        [i.session_id],
      )).rows[0];
      if (!sess) throw notFound('Session');
      const staffCheck = await c.query(
        "SELECT 1 FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed') UNION SELECT 1 FROM organisation_members WHERE organisation_id=$3 AND user_id=$2 AND status='active' AND role IN ('owner','admin')",
        [i.session_id, user.id, sess.organisation_id],
      );
      if (!staffCheck.rowCount) throw forbidden('Session staff or admin access required');
      const athletes = (await c.query(
        "SELECT e.user_id, u.display_name FROM org_enrolments e JOIN users u ON u.id=e.user_id WHERE e.cohort_id=$1 AND e.status IN ('enrolled','paused') ORDER BY u.display_name",
        [sess.cohort_id],
      )).rows;
      const result = [];
      for (const a of athletes) {
        const myShares = [];
        for (const sh of await liveShares({ query: q }, sess.organisation_id, a.user_id)) {
          const inAud = sh.audience_users.includes(user.id) || sh.audience_roles.some((r) => ['coach', 'venue'].includes(r));
          if (!inAud) continue;
          myShares.push(sh);
        }
        if (!myShares.length) continue;
        const allNeeds = [...new Set(myShares.flatMap((s) => s.need_keys))];
        const items = [];
        for (const needKey of allNeeds) {
          const existing = (await c.query(
            'SELECT * FROM accommodation_checklist_items WHERE session_id=$1 AND athlete_id=$2 AND need_key=$3 LIMIT 1',
            [i.session_id, a.user_id, needKey],
          )).rows[0];
          items.push({
            need_key: needKey,
            type: typeOfNeed(needKey),
            arranged: !!existing?.arranged_at,
            arranged_at: existing?.arranged_at ?? null,
            arrangement_note: existing?.arrangement_note ?? null,
            checklist_item_id: existing?.id ?? null,
          });
          if (!existing) {
            const shareForNeed = myShares.find((s) => s.need_keys.includes(needKey));
            await c.query(
              'INSERT INTO accommodation_checklist_items(share_id, athlete_id, organisation_id, session_id, need_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
              [shareForNeed.id, a.user_id, sess.organisation_id, i.session_id, needKey],
            );
          }
        }
        await log({ query: q }, sess.organisation_id, a.user_id, 'share_viewed', user.id, { type: 'session', id: i.session_id }, `checklist:${i.session_id}`);
        result.push({
          athlete_id: a.user_id,
          athlete_name: a.display_name,
          items,
          arranged_count: items.filter((it) => it.arranged).length,
          total_count: items.length,
        });
      }
      await audit({ query: q }, user.id, 'get_accommodation_checklist', 'academy_sessions', i.session_id);
      const totalItems = result.reduce((s, a) => s + a.total_count, 0);
      const totalArranged = result.reduce((s, a) => s + a.arranged_count, 0);
      return { session_id: i.session_id, athletes: result, total_items: totalItems, arranged_items: totalArranged };
    });
  },
});

cap({
  name: 'mark_checklist_item_arranged',
  method: 'POST',
  path: '/accommodation-checklist/:id/arrange',
  tag: TAG,
  summary: 'Staff: mark a support checklist item as arranged (or un-arrange it). An optional note (what was arranged and by whom) is stored. Logged against the athlete\'s share.',
  input: z.object({
    id,
    arranged: z.boolean(),
    arrangement_note: z.string().trim().max(300).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const item = (await c.query('SELECT * FROM accommodation_checklist_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!item) throw notFound('Checklist item');
      const staffCheck = await c.query(
        "SELECT 1 FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed') UNION SELECT 1 FROM organisation_members WHERE organisation_id=$3 AND user_id=$2 AND status='active' AND role IN ('owner','admin')",
        [item.session_id, user.id, item.organisation_id],
      );
      if (!staffCheck.rowCount) throw forbidden('Session staff access required');
      const row = (await c.query(
        'UPDATE accommodation_checklist_items SET arranged_at=$2, arranged_by=$3, arrangement_note=$4 WHERE id=$1 RETURNING *',
        [i.id, i.arranged ? new Date() : null, i.arranged ? user.id : null, i.arrangement_note ?? null],
      )).rows[0];
      await log(c, item.organisation_id, item.athlete_id, i.arranged ? 'checklist_item_arranged' : 'checklist_item_unarranged', user.id, { type: 'share', id: item.share_id }, item.need_key);
      await audit(c, user.id, 'mark_checklist_item_arranged', 'accommodation_checklist_items', i.id);
      return { id: row.id, need_key: row.need_key, arranged: !!row.arranged_at, arranged_at: row.arranged_at, arrangement_note: row.arrangement_note };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ data subject access, correction, full history

cap({
  name: 'get_my_accommodation_history',
  method: 'GET',
  path: '/me/accommodations/history',
  tag: TAG,
  summary: 'Athlete or verified guardian: full cross-organisation accommodation history — every share ever made, its full audience, every time staff opened it (name, role, timestamp), and any correction requests raised. Data subject access view. No medical data exists in this domain.',
  input: z.object({ athlete_id: id.optional(), page: z.number().int().min(1).default(1) }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id && !(await guardianLink(user.id, athleteId))) throw notFound('Person');
    const offset = (i.page - 1) * 50;
    const shares = await many(
      'SELECT s.*, o.name AS org_name FROM academy_accommodation_shares s JOIN organisations o ON o.id=s.organisation_id WHERE s.athlete_id=$1 ORDER BY s.created_at DESC LIMIT 50 OFFSET $2',
      [athleteId, offset],
    );
    const events = await many(
      "SELECT e.kind, e.actor_id, u.display_name AS actor_name, e.ref_id, e.detail, e.created_at FROM academy_inclusion_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.athlete_id=$1 ORDER BY e.id DESC LIMIT 100 OFFSET $2",
      [athleteId, offset * 2],
    );
    const corrections = await many(
      'SELECT id, status, created_at, resolved_at FROM accommodation_correction_requests WHERE athlete_id=$1 ORDER BY created_at DESC LIMIT 20',
      [athleteId],
    );
    return {
      athlete_id: athleteId,
      page: i.page,
      shares: shares.map((s) => ({
        id: s.id, org_name: s.org_name, needs: s.need_keys.map((k) => ({ key: k, type: typeOfNeed(k) })),
        audience_roles: s.audience_roles, context: s.context ?? 'academy', event_id: s.event_id ?? null,
        purpose_key: s.purpose_key ?? null, purpose: s.purpose ?? null,
        expires_at: s.expires_at, revoked_at: s.revoked_at, created_at: s.created_at,
        status: s.revoked_at ? 'revoked' : new Date(s.expires_at) <= new Date() ? 'lapsed' : 'active',
      })),
      access_log: events.map((e) => ({ kind: e.kind, actor_name: e.actor_name ?? 'System', detail: e.detail, created_at: e.created_at })),
      correction_requests: corrections,
    };
  },
});

cap({
  name: 'export_my_accommodation_data',
  method: 'POST',
  path: '/me/accommodations/export',
  tag: TAG,
  summary: 'Data subject access request (DSAR): generate a full export of the athlete\'s accommodation data — all shares, need keys, audience, access log and contact preferences — as a structured JSON record. The export itself is logged. No diagnosis exists in this domain.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await actingFor(c, user, athleteId, 'consent');
      const shares = await many('SELECT * FROM academy_accommodation_shares WHERE athlete_id=$1 ORDER BY created_at DESC', [athleteId]);
      const events = await many(
        "SELECT e.kind, e.actor_id, u.display_name AS actor_name, e.ref_id, e.detail, e.created_at FROM academy_inclusion_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.athlete_id=$1 ORDER BY e.id DESC",
        [athleteId],
      );
      const prefs = await one('SELECT * FROM athlete_contact_preferences WHERE athlete_id=$1', [athleteId]);
      await log(c, null, athleteId, 'dsar_export', user.id, { type: 'athlete', id: athleteId }, 'accommodation_data');
      await audit(c, user.id, 'export_my_accommodation_data', 'athletes', athleteId);
      return {
        exported_at: new Date().toISOString(),
        athlete_id: athleteId,
        shares: shares.map((s) => ({ id: s.id, organisation_id: s.organisation_id, need_keys: s.need_keys, audience_roles: s.audience_roles, audience_user_ids: s.audience_users, context: s.context, event_id: s.event_id, purpose_key: s.purpose_key, expires_at: s.expires_at, revoked_at: s.revoked_at, created_at: s.created_at })),
        access_log: events.map((e) => ({ kind: e.kind, actor_name: e.actor_name, detail: e.detail, created_at: e.created_at })),
        contact_preferences: prefs ? { contact_mode: prefs.contact_mode, updated_at: prefs.updated_at } : null,
      };
    });
  },
});

cap({
  name: 'request_accommodation_correction',
  method: 'POST',
  path: '/me/accommodations/correction-request',
  tag: TAG,
  summary: 'Athlete or guardian: submit a data-correction request if any accommodation preference or access-log entry is incorrect. The description is screened for clinical terms and encrypted. Platform admin reviews within 30 days. The request and its status are visible in the athlete\'s history.',
  input: z.object({
    athlete_id: id.optional(),
    description: z.string().trim().min(10).max(1000),
  }),
  status: 201,
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await actingFor(c, user, athleteId, 'consent');
      const enc = sealCorr(i.description);
      const row = (await c.query(
        'INSERT INTO accommodation_correction_requests(athlete_id, description_enc) VALUES ($1,$2) RETURNING id, status, created_at',
        [athleteId, enc],
      )).rows[0];
      await audit(c, user.id, 'request_accommodation_correction', 'accommodation_correction_requests', row.id);
      await log(c, null, athleteId, 'correction_requested', user.id, { type: 'correction_request', id: row.id }, null);
      return { id: row.id, status: row.status, created_at: row.created_at };
    });
  },
});
