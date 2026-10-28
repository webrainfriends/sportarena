// Smart Attendance & Access (#510): the one access layer for academies, teams, events and venues. Rotating QR passes and site codes, geofenced
// self check-in, RFID/NFC credentials, front-desk entries, gate / smart-lock adapters, grants that follow their source, anomaly reports and a
// report that keeps capture evidence apart from final attendance. The rules live in src/access-layer.js; every capture feeds the canonical
// records (academy_attendance, team_attendance, bookings, accreditation_scans) instead of a table of its own.
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind, isAdmin } from '../helpers.js';
import { blindIndex, encrypt, decrypt } from '../crypto.js';
import { requireGuardian } from '../youth.js';
import { orgFor, hasOrgGrant } from '../org-access.js';
import { mustManage, canManage } from '../booking/engine.js';
import { canManageTeam } from './teams.js';
import { isOrganiser } from './event-departments.js';
import { isGateOperator } from '../accreditation.js';
import { settleRevocations } from '../access-grants.js';
import { PROVIDERS, providerOf, checkEndpoint, verifyText, SECRET_CTX } from '../access-providers.js';
import {
  DOMAINS, METHODS, MANUAL_REASONS, MESSAGES, capture, reviewCapture, loadSubject, isOperator, viewOf, openReason, passFor, siteCodeFor, offlinePackFor, issueGrant, ADAPTERS,
} from '../access-layer.js';

const TAG = 'Smart attendance & access';
const domain = z.enum(DOMAINS).describe('academy_session | team_event | venue_access | event_gate');
const ref = z.string().trim().min(36).max(80).describe('academy session id; <team id>_e_<event id> or <team id>_f_<fixture id>; or an access point id');
const when = z.string().datetime({ offset: true });
const geo = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().min(0).max(100000).optional() })
  .describe('The device location. It is compared with the venue geofence once and is never stored.');
const key = z.string().min(8).max(80);

const captureInput = {
  domain, subject_ref: ref, method: z.enum(METHODS), direction: z.enum(['in', 'out']).default('in'),
  token: z.string().max(300).optional().describe('the scanned QR text (qr)'),
  credential: z.string().trim().min(2).max(200).optional().describe('the raw card/tag id as read by the reader (rfid, nfc); never stored'),
  provider: z.string().trim().min(2).max(40).default('generic').describe('reader/credential provider the id belongs to'),
  user_id: id.optional().describe('the person (manual only)'), athlete_id: id.optional().describe('a guardian checking a young person in themselves'),
  released_to_user_id: id.optional().describe('who is collecting a young person (check-out)'),
  geo: geo.optional(), reason_code: z.enum(MANUAL_REASONS).optional(), note: z.string().trim().max(300).optional(),
  idempotency_key: key.optional(), device_id: z.string().max(80).optional(),
  captured_at: when.optional().describe('offline scans only: when the device saw it'), offline: z.boolean().default(false),
};
const captureObj = z.object(captureInput);

// ---------------------------------------------------------------------------------------------------------------------------------- reference
cap({
  name: 'get_access_options', method: 'GET', path: '/access/options', tag: TAG,
  summary: 'What the access layer offers: capture methods, domains, the hardware adapters that exist, manual-entry reasons and the plain-language message for every outcome code. For building scanners and front-desk screens.',
  async handler() {
    return { domains: DOMAINS, methods: METHODS, manual_reasons: MANUAL_REASONS, providers: Object.entries(PROVIDERS).map(([k, p]) => ({ key: k, label: p.label, description: p.description, hardware: p.hardware })), messages: MESSAGES };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------- QR
cap({
  name: 'get_access_pass', method: 'GET', path: '/access/pass', tag: TAG,
  summary: 'Your rotating QR pass for one session, team event, venue door or event gate (a guardian passes athlete_id for a young person). It changes every 30 seconds, only means something for that one subject and works once, so a screenshot or a shared code does not check anyone in twice. Re-request it when refresh_in_s runs out.',
  input: z.object({ domain, subject_ref: ref, athlete_id: id.optional() }),
  handler: ({ user }, i) => tx((c) => passFor(c, user, i.domain, i.subject_ref, i.athlete_id)),
});
cap({
  name: 'get_access_site_code', method: 'GET', path: '/access/site-code', tag: TAG,
  summary: 'Staff: the rotating code to show on a tablet at the door so people arriving can check themselves in with their own phone (60-second steps, valid for a few minutes). Only for subjects that allow self check-in. When the geofence is on, the arriving phone must also be near the venue.',
  input: z.object({ domain, subject_ref: ref }),
  handler: ({ user }, i) => tx((c) => siteCodeFor(c, user, i.domain, i.subject_ref)),
});
cap({
  name: 'get_access_offline_pack', method: 'GET', path: '/access/offline-pack', tag: TAG,
  summary: 'Staff: what a scanner needs to keep checking passes while the network is down, for one session or team event: a key limited to that subject that expires shortly after it ends. Offline scans are labelled unverified until they sync, and the server re-checks every one then. Gates need a live check, so they have no pack.',
  input: z.object({ domain: z.enum(['academy_session', 'team_event']), subject_ref: ref }),
  handler: ({ user }, i) => tx((c) => offlinePackFor(c, user, i.domain, i.subject_ref)),
});

// ---------------------------------------------------------------------------------------------------------------------------------- my passes
cap({
  name: 'list_my_access_passes', method: 'GET', path: '/me/access/passes', tag: TAG,
  summary: 'Everything you (or a young person you are a verified guardian of) can show a rotating pass for right now or in the next hours: academy sessions you are enrolled in, team events and fixtures, venue doors where you have a current booking or membership, and event gates where you hold an approved accreditation. One list, so nobody has to hunt for the right code. Open one with get_access_pass.',
  async handler({ user }) {
    const kids = (await pool.query("SELECT l.child_id FROM guardian_links l JOIN users u ON u.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND u.youth_until IS NOT NULL AND u.youth_until > current_date", [user.id])).rows.map((r) => r.child_id);
    const me = (await pool.query("SELECT 1 FROM users WHERE id=$1 AND (youth_until IS NULL OR youth_until <= current_date)", [user.id])).rowCount ? [user.id] : [];
    const who = [...me, ...kids];
    const people = Object.fromEntries((await pool.query("SELECT id, display_name, (youth_until IS NOT NULL AND youth_until > current_date) AS youth FROM users WHERE id = ANY($1)", [who])).rows.map((r) => [r.id, r]));
    const out = [];
    const push = (domain, subject_ref, title, subtitle, starts_at, ends_at, athleteId) => out.push({ domain, subject_ref, title, subtitle, starts_at, ends_at, athlete: athleteId ? { id: athleteId, display_name: people[athleteId]?.display_name, youth: !!people[athleteId]?.youth, is_me: athleteId === user.id } : null });
    if (who.length) {
      for (const r of (await pool.query(
        `SELECT s.id, s.title, s.starts_at, s.ends_at, o.name AS org, u.id AS athlete_id FROM academy_sessions s JOIN organisations o ON o.id=s.organisation_id CROSS JOIN LATERAL unnest($1::uuid[]) AS u(id)
          WHERE s.status='published' AND s.starts_at < now() + interval '12 hours' AND s.ends_at > now() - interval '30 minutes'
            AND (EXISTS (SELECT 1 FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.user_id=u.id AND e.status='enrolled') OR EXISTS (SELECT 1 FROM academy_attendance g WHERE g.session_id=s.id AND g.user_id=u.id AND g.guest)) ORDER BY s.starts_at`, [who])).rows)
        push('academy_session', r.id, r.title, r.org, r.starts_at, r.ends_at, r.athlete_id);
      for (const r of (await pool.query(
        `SELECT DISTINCT t.id AS team_id, t.name AS team, e.id AS event_id, e.name AS event, e.starts_on, e.ends_on, m.user_id FROM team_members m JOIN teams t ON t.id=m.team_id JOIN event_entries en ON en.team_id IN (t.id, t.parent_team_id) AND en.status='accepted' JOIN events e ON e.id=en.event_id
          WHERE m.user_id = ANY($1) AND m.status='active' AND current_date BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on)`, [who])).rows)
        push('team_event', `${r.team_id}_e_${r.event_id}`, r.event, r.team, r.starts_on, r.ends_on, r.user_id);
      for (const r of (await pool.query(
        `SELECT DISTINCT f.id AS fixture_id, t.id AS team_id, t.name AS team, e.name AS event, f.scheduled_at, m.user_id FROM team_members m JOIN teams t ON t.id=m.team_id JOIN fixtures f ON f.home_team_id IN (t.id, t.parent_team_id) OR f.away_team_id IN (t.id, t.parent_team_id) JOIN events e ON e.id=f.event_id
          WHERE m.user_id = ANY($1) AND m.status='active' AND f.status IN ('scheduled','live') AND f.scheduled_at BETWEEN now() - interval '3 hours' AND now() + interval '8 hours'`, [who])).rows)
        push('team_event', `${r.team_id}_f_${r.fixture_id}`, `${r.event}: match`, r.team, r.scheduled_at, null, r.user_id);
    }
    for (const r of (await pool.query(
      `SELECT DISTINCT p.id, p.name, v.name AS venue FROM access_points p JOIN venues v ON v.id=p.venue_id
        WHERE p.status='active' AND (EXISTS (SELECT 1 FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN reservations rs ON rs.id=b.reservation_id WHERE r.venue_id=p.venue_id AND rs.user_id=$1 AND b.status='confirmed' AND rs.status='confirmed' AND b.starts_at - (p.early_min * interval '1 minute') <= now() + interval '2 hours' AND b.ends_at + interval '30 minutes' >= now())
          OR EXISTS (SELECT 1 FROM user_plans up WHERE up.venue_id=p.venue_id AND up.user_id=$1 AND up.kind='membership' AND up.status='active' AND up.expires_at > now())) ORDER BY v.name, p.name`, [user.id])).rows)
      push('venue_access', r.id, r.name, r.venue, null, null, user.id);
    for (const r of (await pool.query(
      `SELECT DISTINCT p.id, p.name, e.name AS event FROM access_points p JOIN events e ON e.id=p.event_id JOIN accreditations a ON a.event_id=p.event_id AND a.holder_id=$1 AND a.status='approved' AND a.access='active' WHERE p.status='active' ORDER BY e.name, p.name`, [user.id])).rows)
      push('event_gate', r.id, r.name, r.event, null, null, user.id);
    return out;
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------- capture
cap({
  name: 'record_access_capture', method: 'POST', path: '/access/captures', tag: TAG, status: 201,
  summary: 'The single way to check someone in or out, for every method: scan a personal pass (qr, staff), the door code (qr, the person), tap a card or tag (rfid / nfc, staff or reader), self or geofenced check-in (the person or their guardian) or a front-desk entry with a reason (manual). The server judges it live against the canonical roster, booking, membership or accreditation, applies the youth/guardian rules, then writes the same attendance/arrival/scan record the rest of the platform reads. Always answers with a verdict: recorded / granted, denied, pending_review (staff confirm) or provider_unavailable (nothing was opened). A retry with the same idempotency_key changes nothing.',
  input: captureObj,
  handler: ({ user }, i) => tx(async (c) => {
    const out = await capture(c, { user, ...i });
    return out;
  }),
});

cap({
  name: 'sync_access_captures', method: 'POST', path: '/access/captures/sync', tag: TAG,
  summary: 'Offline reconciliation. A scanner that kept working without a connection sends what it saw (each with its own idempotency_key and captured_at). Each is re-judged now against live data and recorded as offline evidence; one that no longer holds (the booking was cancelled meanwhile, the pass was already used elsewhere) comes back as a conflict, never as a silent success. Safe to send again.',
  input: z.object({ items: z.array(captureObj.extend({ idempotency_key: key, captured_at: when })).min(1).max(100) }),
  async handler({ user }, i) {
    const results = [];
    for (const item of i.items) {
      try {
        const out = await tx((c) => capture(c, { user, ...item, offline: true }));
        const v = out.capture.verdict;
        results.push({ idempotency_key: item.idempotency_key, status: out.replayed ? 'already_synced' : (['granted', 'recorded'].includes(v) ? 'synced' : 'conflict'), capture: out.capture });
      } catch (e) {
        results.push({ idempotency_key: item.idempotency_key, status: 'rejected', error: { status: e.status ?? 500, code: e.code ?? 'error', message: e.message } });
      }
    }
    return { results, synced: results.filter((r) => r.status === 'synced' || r.status === 'already_synced').length, conflicts: results.filter((r) => r.status === 'conflict').length, rejected: results.filter((r) => r.status === 'rejected').length };
  },
});

// scope helper shared by the lists and the report: exactly one of organisation / venue / event / team / one subject
const scopeShape = { organisation_id: id.optional(), venue_id: id.optional(), event_id: id.optional(), team_id: id.optional(), domain: domain.optional(), subject_ref: ref.optional() };
async function scopeOf(user, i, c = pool) {
  const given = [i.organisation_id, i.venue_id, i.event_id, i.team_id, i.subject_ref].filter(Boolean).length;
  if (given !== 1) throw badRequest('Choose one scope: organisation_id, venue_id, event_id, team_id, or domain with subject_ref');
  if (i.organisation_id) { await orgFor(user, i.organisation_id, ['owner', 'admin', 'coach'], { c }); return { col: 'organisation_id', val: i.organisation_id, kind: 'organisation' }; }
  if (i.venue_id) { await mustManage(user, i.venue_id, c); return { col: 'venue_id', val: i.venue_id, kind: 'venue' }; }
  if (i.event_id) {
    const ev = await mustFind('events', i.event_id, '*', c);
    if (!(await isGateOperator(user, ev, c))) throw forbidden('Only the organiser and accreditation or security staff can see this');
    return { col: 'event_id', val: i.event_id, kind: 'event' };
  }
  if (i.team_id) { const t = await mustFind('teams', i.team_id, '*', c); if (!(await canManageTeam(user, t))) throw forbidden('Only the team owner or managers can see this'); return { col: 'team_id', val: i.team_id, kind: 'team' }; }
  if (!i.domain) throw badRequest('Give the domain with the subject_ref');
  const sub = await loadSubject(c, i.domain, i.subject_ref);
  if (!(await isOperator(user, sub, c))) throw notFound('Subject');
  return { col: 'subject_ref', val: i.subject_ref, kind: 'subject' };
}
const range = (i) => [i.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), i.to ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10)];
const day = z.string().date();

cap({
  name: 'list_access_captures', method: 'GET', path: '/access/captures', tag: TAG,
  summary: 'The capture evidence for a scope you run (an organisation, venue, event, team or one session / door): who was presented, how, the verdict, whether it was offline, and where it was written. Held captures (pending_review) are the front desk\'s work list. Reasons typed by staff are decrypted and the read is audited. Never returns coordinates or raw credentials.',
  input: z.object({ ...scopeShape, verdict: z.enum(['granted', 'recorded', 'denied', 'pending_review', 'provider_unavailable']).optional(), method: z.enum(METHODS).optional(), user_id: id.optional(), unresolved: z.coerce.boolean().default(false), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    const sc = await scopeOf(user, i);
    const [from, to] = range(i);
    const rows = await many(
      `SELECT k.*, r.decision AS review_decision, r.at AS reviewed_at FROM access_captures k LEFT JOIN access_capture_reviews r ON r.capture_id=k.id
        WHERE k.${sc.col}=$1 AND k.received_at >= $2::date AND k.received_at < $3::date + 1 AND ($4::text IS NULL OR k.verdict=$4) AND ($5::text IS NULL OR k.method=$5) AND ($6::uuid IS NULL OR k.user_id=$6)
          AND (NOT $7::boolean OR (k.verdict='pending_review' AND r.capture_id IS NULL)) ORDER BY k.received_at DESC, k.id DESC LIMIT $8 OFFSET $9`,
      [sc.val, from, to, i.verdict ?? null, i.method ?? null, i.user_id ?? null, i.unresolved, i.limit, i.offset]);
    const out = [];
    for (const r of rows) {
      const reason = r.reason_enc ? openReason(r.reason_enc) : null;
      if (reason) await audit(null, user.id, 'read_access_reason', 'access_captures', r.id);
      out.push({ ...(await viewOf(pool, r)), reason: reason, review: r.review_decision ? { decision: r.review_decision, at: r.reviewed_at } : null });
    }
    return out;
  },
});

cap({
  name: 'review_access_capture', method: 'POST', path: '/access/captures/:id/review', tag: TAG,
  summary: 'Staff decide a held capture (outside the geofence, no location, or a mark staff had already set): accept records it by hand with your reason, reject keeps the evidence only. Attendance corrections keep actor, reason and history. Idempotent: a capture can be reviewed once.',
  input: z.object({ id, decision: z.enum(['accepted', 'rejected']), reason: z.string().trim().min(3).max(300) }),
  handler: ({ user }, i) => tx((c) => reviewCapture(c, user, i.id, i.decision, i.reason)),
});

// ---------------------------------------------------------------------------------------------------------------------------------- RFID / NFC credentials
const CRED_CTX = 'access_credentials';
cap({
  name: 'register_access_credential', method: 'POST', path: '/access/credentials', tag: TAG, status: 201,
  summary: 'Map a card, tag or wristband to a person. A person registers their own, a guardian a young person\'s, or an organisation owner/admin an enrolled athlete\'s (organisation_id). The raw id is only used to make a lookup hash and is never stored or shown again; presenting it later is still judged against the live roster, booking or accreditation, so a tag is never an identity by itself.',
  input: z.object({ kind: z.enum(['rfid', 'nfc']), provider: z.string().trim().min(2).max(40).default('generic'), identifier: z.string().trim().min(2).max(200), user_id: id.optional(), organisation_id: id.optional(), label: z.string().trim().max(60).optional(), expires_at: when.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const who = i.user_id ?? user.id;
    if (who !== user.id) {
      if (i.organisation_id && (isAdmin(user) || (await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c)))) {
        if (!(await c.query("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.status='enrolled'", [i.organisation_id, who])).rowCount) throw notFound('Athlete');
      } else await requireGuardian(user, who, c);
    }
    const idx = blindIndex(`${i.provider}:${i.identifier}`);
    if ((await c.query("SELECT 1 FROM access_credentials WHERE provider=$1 AND credential_idx=$2 AND status IN ('active','suspended')", [i.provider, idx])).rowCount) throw conflict('That card or tag is already registered. End it first to move it to someone else.');
    const row = (await c.query('INSERT INTO access_credentials(user_id, kind, provider, credential_idx, label, expires_at, registered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, user_id, kind, provider, label, status, expires_at, created_at', [who, i.kind, i.provider, idx, i.label ?? null, i.expires_at ?? null, user.id])).rows[0];
    await audit(c, user.id, 'register_access_credential', CRED_CTX, row.id);
    return row;
  }),
});
cap({
  name: 'list_access_credentials', method: 'GET', path: '/access/credentials', tag: TAG,
  summary: 'Your registered cards and tags (a guardian passes user_id for a young person). Shows label, kind, provider, status and expiry, never the id.',
  input: z.object({ user_id: id.optional() }),
  async handler({ user }, i) {
    const who = i.user_id ?? user.id;
    if (who !== user.id) await requireGuardian(user, who);
    return many('SELECT id, user_id, kind, provider, label, status, expires_at, created_at, ended_at FROM access_credentials WHERE user_id=$1 ORDER BY created_at DESC', [who]);
  },
});
cap({
  name: 'end_access_credential', method: 'POST', path: '/access/credentials/:id/end', tag: TAG,
  summary: 'Suspend, restore or revoke a card or tag. Revoking is permanent and frees the tag to be registered again. Works at once: the next presentation is denied. The owner, a guardian, or the organisation admin who registered it.',
  input: z.object({ id, action: z.enum(['suspend', 'restore', 'revoke']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const cr = (await c.query('SELECT * FROM access_credentials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cr || cr.status === 'revoked') throw notFound('Credential');
    if (cr.user_id !== user.id && cr.registered_by !== user.id && !isAdmin(user)) await requireGuardian(user, cr.user_id, c).catch(() => { throw notFound('Credential'); });
    const to = i.action === 'suspend' ? 'suspended' : i.action === 'restore' ? 'active' : 'revoked';
    const row = (await c.query('UPDATE access_credentials SET status=$2, ended_at=CASE WHEN $2=\'revoked\' THEN now() ELSE NULL END, ended_by=CASE WHEN $2=\'revoked\' THEN $3::uuid ELSE NULL END WHERE id=$1 RETURNING id, status', [cr.id, to, user.id])).rows[0];
    await audit(c, user.id, `${i.action}_access_credential`, CRED_CTX, cr.id);
    return row;
  }),
});

// ---------------------------------------------------------------------------------------------------------------------------------- access points (gates, doors, locks, readers)
const safePoint = ({ secret_enc, ...p }) => ({ ...p, has_secret: !!secret_enc });
async function pointAuthority(user, p, c = pool) {
  if (p.venue_id) await mustManage(user, p.venue_id, c);
  else if (!(await isOrganiser(user, await mustFind('events', p.event_id, '*', c), c))) throw forbidden('Only the organiser can manage access points');
}
const pointShape = {
  name: z.string().trim().min(2).max(80), kind: z.enum(['door', 'gate', 'turnstile', 'smart_lock', 'locker_bank', 'reader']).default('door'),
  provider: z.enum(Object.keys(PROVIDERS)).default('manual'), endpoint_url: z.string().url().max(500).optional(),
  geo_checkin: z.boolean().default(false), geo_radius_m: z.number().int().min(50).max(2000).default(150), early_min: z.number().int().min(0).max(240).default(15),
};
const newSecret = () => `acs_${randomBytes(24).toString('base64url')}`;

cap({
  name: 'create_access_point', method: 'POST', path: '/access/points', tag: TAG, status: 201,
  summary: 'Set up a door, gate, turnstile, smart lock or reader at a venue (venue team) or at an event, optionally for one accreditation zone (organiser). Choose the adapter: manual (front desk, no hardware) or a signed webhook controller. A controller gets a shared secret, shown once here, that signs commands to it and the device events it sends back.',
  input: z.object({ venue_id: id.optional(), event_id: id.optional(), zone_id: id.optional(), ...pointShape }),
  handler: ({ user }, i) => tx(async (c) => {
    if (!!i.venue_id === !!i.event_id) throw badRequest('Give either venue_id or event_id');
    if (i.zone_id && (!i.event_id || !(await c.query('SELECT 1 FROM accreditation_zones WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.zone_id, i.event_id])).rowCount)) throw notFound('Zone');
    await pointAuthority(user, i, c);
    if (PROVIDERS[i.provider].hardware) { const bad = i.endpoint_url ? checkEndpoint(i.endpoint_url) : 'A controller needs an endpoint_url'; if (bad) throw badRequest(bad); }
    const secret = PROVIDERS[i.provider].hardware ? newSecret() : null;
    const row = (await c.query(
      `INSERT INTO access_points(venue_id, event_id, zone_id, name, kind, provider, endpoint_url, secret_enc, geo_checkin, geo_radius_m, early_min, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.venue_id ?? null, i.event_id ?? null, i.zone_id ?? null, i.name, i.kind, i.provider, PROVIDERS[i.provider].hardware ? i.endpoint_url : null, secret ? encrypt(secret, SECRET_CTX) : null, i.geo_checkin, i.geo_radius_m, i.early_min, user.id])).rows[0];
    await audit(c, user.id, 'create_access_point', 'access_points', row.id);
    return { ...safePoint(row), secret, secret_note: secret ? 'Keep this secret in the controller. It is not shown again.' : null };
  }),
});
cap({
  name: 'list_access_points', method: 'GET', path: '/access/points', tag: TAG,
  summary: 'The doors, gates and readers of a venue (venue team) or an event (organiser / gate staff). Secrets are never returned.',
  input: z.object({ venue_id: id.optional(), event_id: id.optional(), include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    if (!!i.venue_id === !!i.event_id) throw badRequest('Give either venue_id or event_id');
    if (i.venue_id) await mustManage(user, i.venue_id);
    else if (!(await isGateOperator(user, await mustFind('events', i.event_id)))) throw forbidden('Only the organiser and accreditation or security staff can see this');
    return (await many(`SELECT * FROM access_points WHERE ${i.venue_id ? 'venue_id' : 'event_id'}=$1 AND ($2 OR status='active') ORDER BY name, id`, [i.venue_id ?? i.event_id, i.include_archived])).map(safePoint);
  },
});
cap({
  name: 'update_access_point', method: 'PATCH', path: '/access/points/:id', tag: TAG,
  summary: 'Rename, retune the geofence, change the controller URL, rotate its secret (shown once) or archive an access point. Archiving keeps its history.',
  input: z.object({ id, name: pointShape.name.optional(), kind: pointShape.kind.optional(), endpoint_url: pointShape.endpoint_url, geo_checkin: z.boolean().optional(), geo_radius_m: pointShape.geo_radius_m.optional(), early_min: pointShape.early_min.optional(), rotate_secret: z.boolean().default(false), archive: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM access_points WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Access point');
    await pointAuthority(user, p, c).catch((e) => { throw e.status === 403 ? notFound('Access point') : e; });
    if (i.endpoint_url) { const bad = !PROVIDERS[p.provider].hardware ? 'This access point has no controller' : checkEndpoint(i.endpoint_url); if (bad) throw badRequest(bad); }
    const secret = i.rotate_secret && PROVIDERS[p.provider].hardware ? newSecret() : null;
    const row = (await c.query(
      `UPDATE access_points SET name=coalesce($2,name), kind=coalesce($3,kind), endpoint_url=coalesce($4,endpoint_url), geo_checkin=coalesce($5,geo_checkin), geo_radius_m=coalesce($6,geo_radius_m), early_min=coalesce($7,early_min),
         secret_enc=coalesce($8,secret_enc), status=CASE WHEN $9::boolean IS TRUE THEN 'archived' WHEN $9::boolean IS FALSE THEN 'active' ELSE status END, archived_at=CASE WHEN $9::boolean IS TRUE THEN now() WHEN $9::boolean IS FALSE THEN NULL ELSE archived_at END WHERE id=$1 RETURNING *`,
      [p.id, i.name ?? null, i.kind ?? null, i.endpoint_url ?? null, i.geo_checkin ?? null, i.geo_radius_m ?? null, i.early_min ?? null, secret ? encrypt(secret, SECRET_CTX) : null, i.archive ?? null])).rows[0];
    await audit(c, user.id, 'update_access_point', 'access_points', p.id);
    return { ...safePoint(row), secret };
  }),
});

cap({
  name: 'submit_access_device_event', method: 'POST', path: '/access/device-events', tag: TAG, auth: 'public', status: 201,
  summary: 'For gate, turnstile and reader hardware: report that a card or tag was presented at an access point. Authenticated by an HMAC-SHA256 signature (hex) of "<point_id>|<ts>|<nonce>|<method>|<provider>|<credential>|<direction>" with the access point secret; ts is unix seconds within two minutes of now, nonce makes a retry safe. The server maps the credential to a person and decides from live data: `granted: true` is the only answer a device may act on. A raw tag id is never stored.',
  input: z.object({ point_id: id, ts: z.coerce.number().int(), nonce: key, method: z.enum(['rfid', 'nfc']).default('rfid'), provider: z.string().trim().min(2).max(40).default('generic'), credential: z.string().trim().min(2).max(200), direction: z.enum(['in', 'out']).default('in'), signature: z.string().length(64) }),
  async handler(_ctx, i) {
    const p = (await pool.query("SELECT * FROM access_points WHERE id=$1 AND status='active'", [i.point_id])).rows[0];
    const sig = p?.secret_enc ? `${i.point_id}|${i.ts}|${i.nonce}|${i.method}|${i.provider}|${i.credential}|${i.direction}` : null;
    if (!p || !sig || Math.abs(Date.now() / 1000 - i.ts) > 120 || !verifyText(decrypt(p.secret_enc, SECRET_CTX), sig, i.signature)) throw notFound('Access point');
    const domainOf = p.venue_id ? 'venue_access' : 'event_gate';
    const out = await tx((c) => capture(c, { device: true, domain: domainOf, subject_ref: p.id, method: i.method, provider: i.provider, credential: i.credential, direction: i.direction, idempotency_key: i.nonce, device_id: `point:${p.id.slice(0, 8)}` }));
    const v = out.capture;
    return { granted: v.verdict === 'granted', verdict: v.verdict, reason_code: v.reason_code, message: v.message, capture_id: v.id, replayed: out.replayed };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------- grants (temporary hardware credentials)
async function pointFor(user, pointId, c = pool) {
  const p = (await c.query('SELECT * FROM access_points WHERE id=$1', [pointId])).rows[0];
  if (!p) throw notFound('Access point');
  await pointAuthority(user, p, c).catch((e) => { throw e.status === 403 ? notFound('Access point') : e; });
  return p;
}
cap({
  name: 'issue_access_grant', method: 'POST', path: '/access/points/:id/grants', tag: TAG, status: 201,
  summary: 'Give smart-lock or gate hardware a temporary credential for something that is valid right now: a booking at the venue, a locker assignment, or an event accreditation. The window comes from the source, the controller mints its own credential (the locker PIN is never sent), and the grant is revoked when the source is cancelled, released, revoked or ends. If the controller does not confirm, nothing is recorded as issued (502).',
  input: z.object({ id, source_type: z.enum(['booking', 'locker_assignment', 'accreditation']), source_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await pointFor(user, i.id, c);
    if ((i.source_type === 'accreditation') !== !!p.event_id) throw badRequest(i.source_type === 'accreditation' ? 'Accreditation grants belong to event access points' : 'Venue access points take booking or locker grants');
    const g = await issueGrant(c, user, p, i).catch(async (e) => { if (e.status === 502) { await audit(null, user.id, 'access_grant_provider_unavailable', 'access_points', p.id); } throw e; });
    await audit(c, user.id, 'issue_access_grant', 'access_grants', g.id);
    return g;
  }),
});
cap({
  name: 'list_access_grants', method: 'GET', path: '/access/points/:id/grants', tag: TAG,
  summary: 'The temporary credentials at an access point and their honest state: active, revoke_pending (the source ended but the controller has not confirmed the revocation yet), revoked or expired.',
  input: z.object({ id, status: z.enum(['active', 'revoke_pending', 'revoked', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    await pointFor(user, i.id);
    return many(`SELECT g.id, g.source_type, g.source_id, g.status, g.valid_from, g.valid_to, g.revoke_reason, g.revoked_at, g.created_at, u.display_name FROM access_grants g JOIN users u ON u.id=g.user_id WHERE g.access_point_id=$1 AND ($2::text IS NULL OR g.status=$2) ORDER BY g.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'revoke_access_grant', method: 'POST', path: '/access/grants/:id/revoke', tag: TAG,
  summary: 'Revoke a temporary credential now. The controller is told straight away; until it confirms, the grant shows as revoke_pending and the worker keeps retrying.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const g = (await pool.query('SELECT * FROM access_grants WHERE id=$1', [i.id])).rows[0];
    if (!g) throw notFound('Grant');
    await pointFor(user, g.access_point_id);
    await pool.query("UPDATE access_grants SET status='revoke_pending', revoke_reason='revoked_by_staff' WHERE id=$1 AND status='active'", [g.id]);
    await settleRevocations([g.id]);
    await audit(null, user.id, 'revoke_access_grant', 'access_grants', g.id);
    return (await pool.query('SELECT id, status, revoke_reason, revoked_at FROM access_grants WHERE id=$1', [g.id])).rows[0];
  },
});
cap({
  name: 'list_access_revocations', method: 'GET', path: '/access/points/:id/revocations', tag: TAG,
  summary: 'For controllers that cache credentials: every grant at this access point revoked or expired since a moment. Poll with the previous as_of.',
  input: z.object({ id, since: when.optional() }),
  async handler({ user }, i) {
    await pointFor(user, i.id);
    const rows = await many("SELECT id AS grant_id, source_type, source_id, provider_ref, status, revoke_reason, coalesce(revoked_at, valid_to) AS at FROM access_grants WHERE access_point_id=$1 AND status IN ('revoke_pending','revoked','expired') AND ($2::timestamptz IS NULL OR coalesce(revoked_at, valid_to) > $2) ORDER BY 6", [i.id, i.since ?? null]);
    return { as_of: new Date().toISOString(), grants: rows };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------- anomalies
cap({
  name: 'list_access_anomalies', method: 'GET', path: '/access/anomalies', tag: TAG,
  summary: 'Things worth a look in a scope you run: a pass used twice, repeated or simultaneous scans, a check-in outside its window or the geofence, an inactive membership, a cancelled booking or accreditation, an unknown card, a controller that could not be reached. Reported neutrally: nothing here blocks or accuses anyone by itself.',
  input: z.object({ ...scopeShape, status: z.enum(['open', 'reviewed', 'dismissed']).optional(), kind: z.string().max(40).optional(), ...page }),
  async handler({ user }, i) {
    const sc = await scopeOf(user, i);
    return many(
      `SELECT a.id, a.kind, a.status, a.created_at, a.domain, a.subject_ref, a.capture_id, a.reviewed_at, u.display_name AS person, k.method, k.verdict, k.reason_code
         FROM access_anomalies a LEFT JOIN users u ON u.id=a.user_id JOIN access_captures k ON k.id=a.capture_id WHERE a.${sc.col}=$1 AND ($2::text IS NULL OR a.status=$2) AND ($3::text IS NULL OR a.kind=$3) ORDER BY a.created_at DESC, a.id DESC LIMIT $4 OFFSET $5`,
      [sc.val, i.status ?? null, i.kind ?? null, i.limit, i.offset]);
  },
});
cap({
  name: 'review_access_anomaly', method: 'POST', path: '/access/anomalies/:id/review', tag: TAG,
  summary: 'Mark an anomaly reviewed or dismissed, with a short note kept encrypted. It never changes attendance by itself; correct attendance from the session or capture.',
  input: z.object({ id, status: z.enum(['reviewed', 'dismissed']), note: z.string().trim().min(3).max(300) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM access_anomalies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Anomaly');
    const sub = await loadSubject(c, a.domain, a.subject_ref).catch(() => null);
    if (!sub || !(await isOperator(user, sub, c))) throw notFound('Anomaly');
    return (await c.query('UPDATE access_anomalies SET status=$2, reviewed_by=$3, reviewed_at=now(), note_enc=$4 WHERE id=$1 RETURNING id, status, reviewed_at', [a.id, i.status, user.id, encrypt(i.note, 'access_anomalies.note')])).rows[0];
  }),
});

// ---------------------------------------------------------------------------------------------------------------------------------- report
cap({
  name: 'get_access_report', method: 'GET', path: '/access/report', tag: TAG,
  summary: 'Attendance and access trends for a scope you run, kept in two layers: capture evidence (how people were presented, denials by reason, offline and held captures, anomalies) and the final canonical status (academy attendance, team check-ins, venue arrivals against no-shows, event gate scans). A scan is never counted as final attendance by itself.',
  input: z.object({ ...scopeShape, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const sc = await scopeOf(user, i);
    const [from, to] = range(i);
    const q = (sql, extra = []) => pool.query(sql, [sc.val, from, to, ...extra]).then((r) => r.rows);
    const win = 'k.received_at >= $2::date AND k.received_at < $3::date + 1';
    const [byMethod, byVerdict, denials, flags, anomalies] = await Promise.all([
      q(`SELECT k.method, count(*)::int AS n FROM access_captures k WHERE k.${sc.col}=$1 AND ${win} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT k.verdict, count(*)::int AS n FROM access_captures k WHERE k.${sc.col}=$1 AND ${win} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT k.reason_code, count(*)::int AS n FROM access_captures k WHERE k.${sc.col}=$1 AND ${win} AND k.verdict IN ('denied','provider_unavailable') GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT count(*) FILTER (WHERE k.offline)::int AS offline, count(*) FILTER (WHERE k.verdict='pending_review' AND NOT EXISTS (SELECT 1 FROM access_capture_reviews r WHERE r.capture_id=k.id))::int AS held, count(*)::int AS total FROM access_captures k WHERE k.${sc.col}=$1 AND ${win}`),
      q(`SELECT a.kind, count(*)::int AS n, count(*) FILTER (WHERE a.status='open')::int AS open FROM access_anomalies a WHERE a.${sc.col}=$1 AND a.created_at >= $2::date AND a.created_at < $3::date + 1 GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    let final = null;
    if (sc.kind === 'organisation' || (sc.kind === 'subject' && i.domain === 'academy_session')) {
      const where = sc.kind === 'organisation' ? 's.organisation_id=$1' : 's.id=$1::uuid';
      const rows = await q(`SELECT a.status, count(*)::int AS n FROM academy_attendance a JOIN academy_sessions s ON s.id=a.session_id WHERE ${where} AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 AND s.status<>'cancelled' GROUP BY 1`);
      const n = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const attended = (n.present ?? 0) + (n.late ?? 0) + (n.left_early ?? 0), counted = attended + (n.absent ?? 0);
      const weekly = await q(`SELECT date_trunc('week', s.starts_at)::date AS week, count(*) FILTER (WHERE a.status IN ('present','late','left_early'))::int AS attended, count(*) FILTER (WHERE a.status IN ('present','late','left_early','absent'))::int AS counted FROM academy_attendance a JOIN academy_sessions s ON s.id=a.session_id WHERE ${where} AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1 AND s.status<>'cancelled' GROUP BY 1 ORDER BY 1`);
      final = { source: 'academy_attendance', by_status: n, attendance_rate: counted ? Math.round((attended / counted) * 1000) / 10 : null, no_show_rate: counted ? Math.round(((n.absent ?? 0) / counted) * 1000) / 10 : null, weekly: weekly.map((w) => ({ week: w.week, attendance_rate: w.counted ? Math.round((w.attended / w.counted) * 1000) / 10 : null, counted: w.counted })) };
    } else if (sc.kind === 'venue') {
      const [r] = await q("SELECT count(*) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS arrived, count(*) FILTER (WHERE b.checked_in_at IS NULL AND b.status IN ('confirmed','no_show') AND b.ends_at < now())::int AS not_arrived, count(*) FILTER (WHERE b.status='no_show')::int AS marked_no_show FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.starts_at >= $2::date AND b.starts_at < $3::date + 1 AND b.status IN ('confirmed','no_show')");
      final = { source: 'bookings', ...r, no_show_rate: r.arrived + r.not_arrived ? Math.round((r.not_arrived / (r.arrived + r.not_arrived)) * 1000) / 10 : null };
    } else if (sc.kind === 'team') {
      const [r] = await q('SELECT count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in, count(*) FILTER (WHERE rsvp=\'going\' AND checked_in_at IS NULL)::int AS going_not_arrived, count(*) FILTER (WHERE checked_out_at IS NOT NULL)::int AS checked_out FROM team_attendance WHERE team_id=$1 AND created_at >= $2::date AND created_at < $3::date + 1');
      final = { source: 'team_attendance', ...r };
    } else if (sc.kind === 'event') {
      final = { source: 'accreditation_scans', by_result: await q('SELECT result, count(*)::int AS n FROM accreditation_scans WHERE event_id=$1 AND at >= $2::date AND at < $3::date + 1 GROUP BY 1 ORDER BY 2 DESC') };
    }
    return {
      scope: { kind: sc.kind, id: sc.val }, from, to,
      evidence: { total: flags[0].total, by_method: byMethod, by_verdict: byVerdict, denials_by_reason: denials.map((d) => ({ ...d, message: MESSAGES[d.reason_code] ?? null })), offline: flags[0].offline, held_for_review: flags[0].held },
      anomalies, final,
      note: 'Evidence counts presentations. Final figures come from the canonical records and only change when staff or a validated capture changes them.',
    };
  },
});
