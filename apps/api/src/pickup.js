// Academy pickup, handover and daily athlete safety (#788). One module owns the rules so the REST routes, OpenAPI, MCP tools, the
// background sweep and the legacy QR check-out gate all decide the same way.
// It only reads canonical records: guardian links and consents (youth.js), pickup_delegates (extended, not duplicated), academy sessions and
// attendance. Arrival (access_captures) and attendance (academy_attendance) are never copied; a handover is its own, separate fact.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, badRequest, conflict, forbidden } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { notify } from './notify.js';
import { guardiansOf, guardianLink, guardianCan } from './youth.js';

export const MODES = ['collected', 'walks_home', 'transport'];
/** Checks a handover can carry. qr and passphrase are verified by the server; id_seen and photo_match are what the staff member attests (no image or ID number is kept). */
export const CHECKS = ['qr', 'passphrase', 'id_seen', 'photo_match'];
export const RELATIONSHIPS = ['parent', 'grandparent', 'sibling', 'relative', 'family_friend', 'neighbour', 'driver', 'transport_service', 'other'];
export const SAFETY_KINDS = ['blocked_pickup', 'late_pickup', 'no_show', 'override', 'unconfirmed_handover', 'disputed_handover', 'offline_conflict', 'welfare_concern', 'incident'];
export const OFFLINE_MAX_AGE_MS = 12 * 3600_000;

export const DEFAULT_POLICY = { late_after_min: 10, second_after_min: 20, officer_after_min: 40, no_show_after_min: 15, confirm_timeout_min: 10, require_guardian_confirmation: true, safeguarding_officer_id: null, version: 0 };
export const policyFor = async (c, orgId) => (await c.query('SELECT * FROM academy_pickup_policies WHERE organisation_id=$1 AND retired_at IS NULL', [orgId])).rows[0] ?? { ...DEFAULT_POLICY, organisation_id: orgId };

// ------------------------------------------------------------------------------------------------------------------ passphrase
/** A short spoken phrase the collector tells staff. Stored only as a salted scrypt hash and compared in constant time. */
export const hashPhrase = (p) => { const salt = randomBytes(16); return `s1$${salt.toString('hex')}$${scryptSync(String(p).trim().toLowerCase(), salt, 32).toString('hex')}`; };
export function phraseMatches(hash, p) {
  const [v, salt, h] = String(hash ?? '').split('$');
  if (v !== 's1' || !salt || !h || !p) return false;
  const got = scryptSync(String(p).trim().toLowerCase(), Buffer.from(salt, 'hex'), 32), want = Buffer.from(h, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
export const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

// ------------------------------------------------------------------------------------------------------------------ who may collect
/**
 * SQL for "this pickup_delegates row (alias a) lets its person collect at instant ts": collect right, validity window, not revoked at ts,
 * unused if one-time, inside its weekday and local-time window, and the guardian who granted it is still a verified guardian now.
 * ts is an SQL expression, `now()` for a live decision or `$n::timestamptz` to judge an offline capture as of when it happened.
 */
export const liveDelegateSql = (a = 'd', ts = 'now()') => `(${a}.can_collect AND ${a}.valid_from <= ${ts} AND ${a}.expires_at > ${ts} AND (${a}.revoked_at IS NULL OR ${a}.revoked_at > ${ts}) AND (NOT ${a}.one_time OR ${a}.used_at IS NULL)
  AND (${a}.weekdays IS NULL OR extract(isodow FROM (${ts} AT TIME ZONE ${a}.tz))::int = ANY(${a}.weekdays::int[]))
  AND (${a}.from_time IS NULL OR (${ts} AT TIME ZONE ${a}.tz)::time >= ${a}.from_time) AND (${a}.to_time IS NULL OR (${ts} AT TIME ZONE ${a}.tz)::time <= ${a}.to_time)
  AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=${a}.granted_by AND gl.child_id=${a}.child_id AND gl.status='active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now())))`;

/** The guardian link as it stood at `at` (a guardian whose authority was withdrawn after an offline scan still counted when it happened). */
export const guardianAt = async (c, guardianId, childId, at) => (await c.query(
  `SELECT l.* FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id=$2 AND coalesce(l.decided_at, l.created_at) <= $3
      AND ((l.status='active' AND l.revoked_at IS NULL) OR (l.revoked_at IS NOT NULL AND l.revoked_at > $3)) AND (l.expires_at IS NULL OR l.expires_at > $3) ORDER BY l.created_at DESC LIMIT 1`, [guardianId, childId, at])).rows[0] ?? null;

export const delegatesAt = async (c, childId, orgId, at = new Date()) => (await c.query(
  `SELECT d.* FROM pickup_delegates d WHERE d.child_id=$1 AND ${liveDelegateSql('d', '$3::timestamptz')} AND (d.organisation_id IS NULL OR d.organisation_id=$2) ORDER BY d.created_at, d.id`, [childId, orgId, at])).rows;

const departureAt = async (c, childId, orgId, mode, at) => (await c.query(
  `SELECT m.id FROM pickup_departure_modes m WHERE m.child_id=$1 AND m.mode=$3 AND (m.organisation_id IS NULL OR m.organisation_id=$2) AND m.created_at <= $4 AND (m.revoked_at IS NULL OR m.revoked_at > $4) AND (m.valid_until IS NULL OR m.valid_until > $4)
      AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=m.granted_by AND gl.child_id=m.child_id AND gl.status='active' AND gl.revoked_at IS NULL) LIMIT 1`, [childId, orgId, mode, at])).rows[0] ?? null;

/**
 * Decide whether `collector` may take `athleteId` home in `mode` at `at`. Never throws for a refusal: returns { ok:false, code, reasons }.
 * ok:true carries { kind: guardian|delegate|self, link?, delegate?, checks[] } where checks are the ones the server itself verified plus what staff attested.
 */
export const MAX_PHRASE_TRIES = 5;     // wrong passphrases per athlete in 10 minutes before the desk is told to stop guessing and call the guardian
export async function authorise(c, { athleteId, orgId, collectorUserId = null, delegateId = null, mode, at = new Date(), passphrase = null, attested = [], qrOk = false, sessionRef = null, actor = null }) {
  const attest = attested.filter((x) => x === 'id_seen' || x === 'photo_match');
  if (mode !== 'collected') {
    const perm = await departureAt(c, athleteId, orgId, mode, at);
    if (!perm) return { ok: false, code: 'departure_not_permitted', reasons: [`no_guardian_permission_${mode}`] };
    return { ok: true, kind: 'self', permission: perm.id, checks: attest };
  }
  if (!collectorUserId && !delegateId) return { ok: false, code: 'collector_required', reasons: ['choose_collector'] };
  if (collectorUserId) {
    const link = await guardianAt(c, collectorUserId, athleteId, at);
    if (link && !(link.scopes ?? []).includes('pickup')) return { ok: false, code: 'pickup_not_authorised', reasons: ['guardian_pickup_scope_withheld'] };
    if (link) return { ok: true, kind: 'guardian', link, checks: [...(qrOk ? ['qr'] : []), ...attest] };
  }
  const ds = await delegatesAt(c, athleteId, orgId, at);
  const d = ds.find((x) => (delegateId && x.id === delegateId) || (collectorUserId && x.delegate_user_id === collectorUserId));
  if (!d) {
    // say why when the person was authorised and no longer is, so the desk can explain instead of guessing
    const was = collectorUserId && (await c.query('SELECT revoked_at, expires_at, one_time, used_at FROM pickup_delegates WHERE child_id=$1 AND delegate_user_id=$2 ORDER BY created_at DESC LIMIT 1', [athleteId, collectorUserId])).rows[0];
    const why = !was ? 'not_on_list' : was.revoked_at ? 'revoked' : was.one_time && was.used_at ? 'already_used' : new Date(was.expires_at) <= at ? 'expired' : 'outside_allowed_time';
    return { ok: false, code: 'pickup_not_authorised', reasons: [why] };
  }
  const checks = [];
  if (d.passphrase_hash) {
    const tries = (await c.query("SELECT count(*)::int AS n FROM academy_handover_events WHERE athlete_id=$1 AND kind='passphrase_failed' AND created_at > now() - interval '10 minutes'", [athleteId])).rows[0].n;
    if (tries >= MAX_PHRASE_TRIES) return { ok: false, code: 'too_many_attempts', reasons: ['too_many_attempts'], delegate: d.id };
    if (!phraseMatches(d.passphrase_hash, passphrase)) {
      if (passphrase && sessionRef) await c.query("INSERT INTO academy_handover_events(organisation_id, session_id, athlete_id, kind, actor_id, detail) VALUES ($1,$2,$3,'passphrase_failed',$4,'wrong')", [sessionRef.organisation_id, sessionRef.id, athleteId, actor]);
      return { ok: false, code: 'passphrase_required', reasons: [passphrase ? 'passphrase_wrong' : 'passphrase_missing'], delegate: d.id };
    }
    checks.push('passphrase');
  }
  if (qrOk && collectorUserId && d.delegate_user_id === collectorUserId) checks.push('qr');
  checks.push(...attest);
  if (!checks.length) return { ok: false, code: 'verification_required', reasons: ['verify_identity'], delegate: d.id };
  return { ok: true, kind: 'delegate', delegate: d, checks: [...new Set(checks)] };
}

// ------------------------------------------------------------------------------------------------------------------ people to tell
/** Safeguarding routing with minimal disclosure: the officer named in the policy, else everyone holding the safeguarding permission, else the academy's owners/admins. */
export async function safeguardingOfficers(c, orgId, policy) {
  const out = new Set();
  if (policy?.safeguarding_officer_id) out.add(policy.safeguarding_officer_id);
  for (const r of (await c.query("SELECT user_id FROM org_staff_engagements WHERE organisation_id=$1 AND state='active' AND 'safeguarding' = ANY(permissions) AND (ends_on IS NULL OR ends_on >= current_date)", [orgId])).rows) out.add(r.user_id);
  if (!out.size) for (const r of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [orgId])).rows) out.add(r.user_id);
  return [...out];
}
export const emergencyContacts = async (c, childId) => (await c.query(
  `SELECT d.* FROM pickup_delegates d WHERE d.child_id=$1 AND d.is_emergency AND d.revoked_at IS NULL AND d.expires_at > now() ORDER BY d.emergency_rank NULLS LAST, d.created_at`, [childId])).rows;

const nameOf = async (c, id) => (await c.query('SELECT display_name FROM users WHERE id=$1', [id])).rows[0]?.display_name ?? 'The athlete';

async function logHandover(c, h, kind, actorId, detail = null) {
  await c.query('INSERT INTO academy_handover_events(organisation_id, session_id, athlete_id, handover_id, kind, actor_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [h.organisation_id, h.session_id, h.athlete_id, h.id ?? null, kind, actorId ?? null, detail]);
}

// ------------------------------------------------------------------------------------------------------------------ safety events
/**
 * Open (or find) a safety event. dedupeKey makes sweeps and retries idempotent. The list shows kind/severity/status only; free text is encrypted
 * and only readable through get_academy_safety_event (safeguarding permission, audit-logged).
 */
export async function openSafetyEvent(c, { orgId, sessionId = null, athleteId, handoverId = null, kind, severity = 'medium', summary = null, routedTo = [], actorId = null, dedupeKey = null, caseId = null }) {
  if (!SAFETY_KINDS.includes(kind)) throw badRequest('Unknown safety event kind');
  const r = await c.query(
    `INSERT INTO academy_safety_events(organisation_id, session_id, athlete_id, handover_id, kind, severity, summary_enc, routed_to, opened_by, dedupe_key, case_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
    [orgId, sessionId, athleteId, handoverId, kind, severity, summary ? encrypt(summary, 'academy_safety_events.summary') : null, routedTo, actorId, dedupeKey, caseId]);
  const row = r.rows[0];
  if (!row) return { event: (await c.query('SELECT * FROM academy_safety_events WHERE dedupe_key=$1', [dedupeKey])).rows[0], created: false };
  await c.query("INSERT INTO academy_safety_event_log(event_id, kind, actor_id, detail) VALUES ($1,'opened',$2,$3)", [row.id, actorId, kind]);
  if (routedTo.length) for (const u of routedTo) {
    await notify(c, u, { kind: 'academy_safety_event', title: 'Safety event needs attention', body: 'Open Academy > Safety & pickup. Details are shown only to safeguarding staff.', urgent: severity === 'high', data: { event_id: row.id, organisation_id: orgId }, dedupe_key: `safety:${row.id}:${u}` });
  }
  return { event: row, created: true };
}

async function resolveEvents(c, handoverId, kinds, actorId, why) {
  const rows = (await c.query("UPDATE academy_safety_events SET status='resolved', resolved_at=now(), resolved_by=$3, row_version=row_version+1 WHERE handover_id=$1 AND kind = ANY($2) AND status <> 'resolved' RETURNING id", [handoverId, kinds, actorId])).rows;
  for (const e of rows) await c.query("INSERT INTO academy_safety_event_log(event_id, kind, actor_id, detail) VALUES ($1,'resolved',$2,$3)", [e.id, actorId, why]);
}

// ------------------------------------------------------------------------------------------------------------------ handover
/** The handover row for a session and athlete, created (state awaiting) on first touch and locked for the rest of the transaction. */
export async function lockHandover(c, s, athleteId) {
  await c.query(
    `INSERT INTO academy_handovers(organisation_id, session_id, athlete_id, expected_pickup_at) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, athlete_id) DO NOTHING`, [s.organisation_id, s.id, athleteId, s.ends_at]);
  return (await c.query('SELECT * FROM academy_handovers WHERE session_id=$1 AND athlete_id=$2 FOR UPDATE', [s.id, athleteId])).rows[0];
}

export async function tellGuardians(c, athleteId, h, { kind, title, body, urgent = false, key }) {
  for (const g of await guardiansOf(athleteId, c)) await notify(c, g, { kind, title, body, urgent, data: { handover_id: h.id, child_id: athleteId, session_id: h.session_id }, dedupe_key: `${key}:${h.id}:${g}` });
}

/**
 * Record a handover. Returns { handover } or { denied } (a refusal is recorded as a blocked event and guardians are told, then the caller answers 403).
 * Guardian confirmation (the approved default): the athlete stays in the academy's care until a guardian confirms, unless the collector is the guardian
 * presenting their own pass, or staff override with a written reason. A refused (unauthorised) collector can never be overridden.
 */
export async function recordHandover(c, { s, athleteId, collectorUserId = null, delegateId = null, mode = 'collected', passphrase = null, attested = [], qrOk = false, overrideReason = null, actor, key = null, at = new Date(), offline = false }) {
  if (key) {
    const prior = (await c.query('SELECT * FROM academy_handovers WHERE recorded_by=$1 AND idempotency_key=$2', [actor, key])).rows[0];
    if (prior) return { handover: prior, replayed: true };
  }
  const h = await lockHandover(c, s, athleteId);
  if (h.state === 'handed_over') throw conflict('This athlete has already been handed over', { code: 'already_handed_over' });
  const att = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, athleteId])).rows[0];
  if (!att || !['present', 'late', 'left_early'].includes(att.status)) throw conflict('This athlete has not arrived at the session, so there is nobody to hand over', { code: 'not_arrived' });
  const policy = await policyFor(c, s.organisation_id);
  const a = await authorise(c, { athleteId, orgId: s.organisation_id, collectorUserId, delegateId, mode, at, passphrase, attested, qrOk, sessionRef: s, actor });
  if (!a.ok) {
    await logHandover(c, h, 'blocked', actor, a.reasons[0]);
    const officers = await safeguardingOfficers(c, s.organisation_id, policy);
    await openSafetyEvent(c, { orgId: s.organisation_id, sessionId: s.id, athleteId, handoverId: h.id, kind: offline ? 'offline_conflict' : 'blocked_pickup', severity: a.code === 'pickup_not_authorised' ? 'high' : 'medium', routedTo: officers, actorId: actor, dedupeKey: `blocked:${h.id}:${a.code}:${a.reasons[0]}:${Math.floor(at.getTime() / 600000)}` });
    await tellGuardians(c, athleteId, h, { kind: 'pickup_blocked', title: 'A pickup was stopped', body: `${await nameOf(c, athleteId)} stays with the academy. Someone who is not authorised asked to collect.`, urgent: true, key: `blocked:${a.reasons[0]}:${Math.floor(at.getTime() / 600000)}` });
    return { denied: a, handover: h };
  }
  if (a.kind === 'delegate' && a.delegate.id) await c.query('UPDATE pickup_delegates SET used_at = CASE WHEN one_time THEN coalesce(used_at, $2) ELSE used_at END, updated_at=now() WHERE id=$1', [a.delegate.id, at]);
  const checks = [...new Set(a.checks)];
  let state = 'pending_confirmation', method = null, confirmedBy = null, confirmedAt = null, overrideEnc = null;
  if (a.kind === 'self' || !policy.require_guardian_confirmation) state = 'handed_over';
  else if (a.kind === 'guardian' && checks.includes('qr') && a.link && (a.link.scopes ?? []).includes('pickup')) { state = 'handed_over'; method = 'guardian_qr'; confirmedBy = collectorUserId; confirmedAt = at; }
  else if (overrideReason) { state = 'handed_over'; method = 'staff_override'; overrideEnc = encrypt(overrideReason, 'academy_handovers.override_reason'); }
  const row = (await c.query(
    `UPDATE academy_handovers SET state=$2, departure_mode=$3, collector_user_id=$4, delegate_id=$5, collector_kind=$6, checks=$7, recorded_by=$8, recorded_at=$9, received_at=now(), offline=$10,
        guardian_confirmed_by=$11, guardian_confirmed_at=$12, confirm_method=$13, override_reason_enc=$14, handed_over_at=$15, idempotency_key=$16, row_version=row_version+1, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [h.id, state, mode, collectorUserId ?? a.delegate?.delegate_user_id ?? null, a.delegate?.id ?? null, a.kind, checks, actor, at, offline, confirmedBy, confirmedAt, method, overrideEnc, state === 'handed_over' ? at : null, key])).rows[0];
  await logHandover(c, row, 'recorded', actor, `${mode}:${a.kind}:${checks.join('+') || 'none'}${offline ? ':offline' : ''}`);
  const name = await nameOf(c, athleteId);
  if (state === 'pending_confirmation') {
    await tellGuardians(c, athleteId, row, { kind: 'pickup_confirm', title: 'Confirm the pickup', body: `Is someone collecting ${name} now? Open Family & guardians to confirm or stop it.`, urgent: true, key: 'confirm' });
  } else {
    await tellGuardians(c, athleteId, row, { kind: 'pickup_done', title: 'Pickup recorded', body: `${name} has left the academy (${mode.replace('_', ' ')}).`, key: 'done' });
    await resolveEvents(c, row.id, ['late_pickup', 'unconfirmed_handover'], actor, 'handed_over');
  }
  if (method === 'staff_override') {
    await logHandover(c, row, 'override', actor, 'guardian_confirmation_overridden');
    await openSafetyEvent(c, { orgId: s.organisation_id, sessionId: s.id, athleteId, handoverId: row.id, kind: 'override', severity: 'low', summary: overrideReason, routedTo: await safeguardingOfficers(c, s.organisation_id, policy), actorId: actor, dedupeKey: `override:${row.id}` });
  }
  return { handover: row, replayed: false };
}

/** A verified guardian (with the pickup scope) confirms or stops a pending handover. Stopping keeps the athlete in care and alerts safeguarding. */
export async function confirmHandover(c, { handoverId, user, confirm, via = 'guardian_app' }) {
  const h = (await c.query('SELECT * FROM academy_handovers WHERE id=$1 FOR UPDATE', [handoverId])).rows[0];
  const link = h && await guardianLink(user.id, h.athlete_id, c);
  if (!h || !link) throw new AppError(404, 'not_found', 'Handover not found');           // do not reveal existence to anyone who is not this child's guardian
  if (!(await guardianCan(link, 'pickup', h.organisation_id, c))) throw new AppError(403, 'guardian_scope_required', 'Your guardian authority for this young person does not cover pickups (pickup)', { scope: 'pickup' });
  if (h.state === 'handed_over') return { handover: h, replayed: true };
  if (h.state !== 'pending_confirmation') throw conflict('There is nothing waiting for your confirmation', { code: 'not_pending' });
  const policy = await policyFor(c, h.organisation_id);
  if (confirm) {
    const row = (await c.query("UPDATE academy_handovers SET state='handed_over', guardian_confirmed_by=$2, guardian_confirmed_at=now(), confirm_method=$3, handed_over_at=coalesce(recorded_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [h.id, user.id, via])).rows[0];
    await logHandover(c, row, 'guardian_confirmed', user.id, via);
    await resolveEvents(c, row.id, ['late_pickup', 'unconfirmed_handover'], user.id, 'guardian_confirmed');
    for (const g of await guardiansOf(h.athlete_id, c)) if (g !== user.id) await notify(c, g, { kind: 'pickup_done', title: 'Pickup confirmed', body: `${await nameOf(c, h.athlete_id)}'s pickup was confirmed by another guardian.`, data: { handover_id: h.id, child_id: h.athlete_id }, dedupe_key: `confirmed:${h.id}:${g}` });
    return { handover: row };
  }
  const row = (await c.query("UPDATE academy_handovers SET state='disputed', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [h.id])).rows[0];
  await logHandover(c, row, 'guardian_disputed', user.id, via);
  const officers = await safeguardingOfficers(c, h.organisation_id, policy);
  await openSafetyEvent(c, { orgId: h.organisation_id, sessionId: h.session_id, athleteId: h.athlete_id, handoverId: h.id, kind: 'disputed_handover', severity: 'high', routedTo: officers, actorId: user.id, dedupeKey: `disputed:${h.id}` });
  if (h.recorded_by) await notify(c, h.recorded_by, { kind: 'pickup_stopped', title: 'Guardian stopped the pickup', body: 'Keep the athlete with you and contact the safeguarding officer.', urgent: true, data: { handover_id: h.id, session_id: h.session_id }, dedupe_key: `stopped:${h.id}` });
  return { handover: row };
}

/**
 * One escalation step for a handover that is late: 1 = tell guardians, 2 = second guardian + emergency contacts, 3 = safeguarding officer.
 * Idempotent (levels only go up; notifications and events are de-duplicated).
 */
export async function escalate(c, h, level, { actor = null, policy } = {}) {
  if (level <= h.escalation_level) return h;
  const name = await nameOf(c, h.athlete_id);
  const p = policy ?? await policyFor(c, h.organisation_id);
  if (level >= 1) await tellGuardians(c, h.athlete_id, h, { kind: 'pickup_late', title: 'Pickup is late', body: `${name} is still waiting at the academy. Please collect or call the front desk.`, urgent: true, key: 'late1' });
  if (level >= 2) {
    await tellGuardians(c, h.athlete_id, h, { kind: 'pickup_late', title: 'Pickup is overdue', body: `${name} has been waiting a while. The academy is now trying your emergency contacts.`, urgent: true, key: 'late2' });
    for (const e of await emergencyContacts(c, h.athlete_id)) if (e.delegate_user_id) await notify(c, e.delegate_user_id, { kind: 'pickup_late', title: 'Please help collect a young person', body: 'You are listed as an emergency contact and the pickup is overdue. Contact the academy front desk.', urgent: true, data: { handover_id: h.id }, dedupe_key: `late2e:${h.id}:${e.delegate_user_id}` });
  }
  const officers = level >= 3 ? await safeguardingOfficers(c, h.organisation_id, p) : [];
  const row = (await c.query('UPDATE academy_handovers SET escalation_level=$2, escalated_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [h.id, level])).rows[0];
  await logHandover(c, row, 'escalated', actor, `level_${level}`);
  const { event, created } = await openSafetyEvent(c, { orgId: h.organisation_id, sessionId: h.session_id, athleteId: h.athlete_id, handoverId: h.id, kind: 'late_pickup', severity: level >= 3 ? 'high' : 'medium', routedTo: officers, actorId: actor, dedupeKey: `late:${h.id}` });
  if (!created && level >= 3 && event.status !== 'resolved') {
    await c.query("UPDATE academy_safety_events SET severity='high', status='escalated', routed_to=$2, row_version=row_version+1 WHERE id=$1", [event.id, officers]);
    await c.query("INSERT INTO academy_safety_event_log(event_id, kind, actor_id, detail) VALUES ($1,'escalated',$2,'officer')", [event.id, actor]);
    for (const u of officers) await notify(c, u, { kind: 'academy_safety_event', title: 'Safety event needs attention', body: 'A pickup is overdue. Open Academy > Safety & pickup.', urgent: true, data: { event_id: event.id, organisation_id: h.organisation_id }, dedupe_key: `safety:${event.id}:${u}` });
  }
  return row;
}

/** Decrypted notes of an event. Callers must hold the safeguarding permission and write an audit row. */
export const eventNotes = (e) => ({ summary: decrypt(e.summary_enc, 'academy_safety_events.summary'), resolution: decrypt(e.resolution_enc, 'academy_safety_events.resolution') });
