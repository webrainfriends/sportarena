// Academy pickup, handover and daily athlete safety (#788): the staff desk, the management oversight and the safety-event workflow.
// Rules live in src/pickup.js; this file is the capability surface (REST + OpenAPI + MCP from one definition). Arrival and attendance stay in
// access_captures / academy_attendance and are only read here; the handover is its own, separate and append-logged fact.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { opsAccess, sessionFor } from '../academy-ops.js';
import { checkToken, readToken } from '../access-layer.js';
import { MODES, OFFLINE_MAX_AGE_MS, SAFETY_KINDS, authorise, delegatesAt, emergencyContacts, escalate, eventNotes, lockHandover, openSafetyEvent, policyFor, recordHandover, safeguardingOfficers } from '../pickup.js';

const TAG = 'Academy safety & pickup';
const PRESENT = ['present', 'late', 'left_early'];

// ------------------------------------------------------------------------------------------------------------------ the board
const roster = (c, s) => c.query(
  `SELECT u.id AS user_id, u.display_name, u.avatar_emoji, u.avatar_color, (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth, coalesce(a.status,'expected') AS attendance, a.reason_code, a.arrived_at, a.left_at,
          h.id AS handover_id, h.state, h.departure_mode, h.collector_kind, h.checks, h.recorded_at, h.handed_over_at, h.guardian_confirmed_at, h.confirm_method, h.escalation_level, h.offline, h.collector_user_id, h.delegate_id,
          (SELECT count(*)::int FROM academy_safety_events e WHERE e.athlete_id=u.id AND e.session_id=$1 AND e.status <> 'resolved') AS open_events
     FROM (SELECT e.user_id FROM org_enrolments e WHERE e.cohort_id=$2 AND e.status='enrolled' UNION SELECT user_id FROM academy_attendance WHERE session_id=$1 AND guest) r
     JOIN users u ON u.id=r.user_id LEFT JOIN academy_attendance a ON a.session_id=$1 AND a.user_id=u.id LEFT JOIN academy_handovers h ON h.session_id=$1 AND h.athlete_id=u.id ORDER BY u.display_name, u.id`, [s.id, s.cohort_id]);

/** Who staff may release this young person to right now: guardians who hold the pickup scope and collectors that are live. Names only, never phone numbers. */
async function collectorsOf(c, athleteId, orgId, names) {
  const out = (await c.query("SELECT l.guardian_id AS user_id, u.display_name FROM guardian_links l JOIN users u ON u.id=l.guardian_id WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND 'pickup' = ANY(l.scopes) ORDER BY l.created_at, l.id", [athleteId]))
    .rows.map((g) => ({ kind: 'guardian', user_id: g.user_id, name: g.display_name, relationship: 'guardian', needs_passphrase: false }));
  for (const d of await delegatesAt(c, athleteId, orgId)) {
    names.n++;
    out.push({ kind: 'delegate', user_id: d.delegate_user_id, delegate_id: d.id, name: d.delegate_user_id ? (await c.query('SELECT display_name FROM users WHERE id=$1', [d.delegate_user_id])).rows[0]?.display_name : decrypt(d.delegate_name_enc, 'pickup_delegates.name'),
      relationship: d.relationship, needs_passphrase: !!d.passphrase_hash, one_time: d.one_time, weekdays: d.weekdays, from_time: d.from_time, to_time: d.to_time });
  }
  return out;
}

async function board(c, s, user) {
  const policy = await policyFor(c, s.organisation_id);
  const now = Date.now(), ends = new Date(s.ends_at).getTime(), starts = new Date(s.starts_at).getTime();
  const rows = (await roster(c, s)).rows; const names = { n: 0 };
  const athletes = [];
  for (const r of rows) {
    const arrived = PRESENT.includes(r.attendance);
    let phase;
    if (!r.is_youth) phase = arrived ? 'attending' : r.attendance;
    else if (r.state === 'handed_over') phase = 'handed_over';
    else if (r.state === 'disputed') phase = 'disputed';
    else if (r.state === 'pending_confirmation') phase = 'pending_confirmation';
    else if (arrived) phase = now > ends + policy.late_after_min * 60000 ? 'late' : 'in_care';
    else if (['absent', 'excused', 'not_held'].includes(r.attendance)) phase = r.attendance;
    else phase = now > starts + policy.no_show_after_min * 60000 ? 'no_show' : 'expected';
    athletes.push({
      user_id: r.user_id, display_name: r.display_name, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color, is_youth: r.is_youth, needs_handover: r.is_youth, attendance: r.attendance, arrived_at: r.arrived_at, phase,
      minutes_late: phase === 'late' || (r.state === 'pending_confirmation' && now > ends) ? Math.max(0, Math.floor((now - ends) / 60000)) : 0,
      handover: r.handover_id ? { id: r.handover_id, state: r.state, mode: r.departure_mode, collector_kind: r.collector_kind, checks: r.checks, recorded_at: r.recorded_at, handed_over_at: r.handed_over_at, confirm_method: r.confirm_method, escalation_level: r.escalation_level, offline: r.offline } : null,
      open_events: r.open_events, collectors: r.is_youth && arrived && r.state !== 'handed_over' ? await collectorsOf(c, r.user_id, s.organisation_id, names) : [],
    });
  }
  const count = (f) => athletes.filter(f).length;
  const kids = athletes.filter((a) => a.needs_handover);
  if (names.n) await audit(c, user.id, 'read_pickup_board', 'academy_sessions', s.id);
  return {
    session: { id: s.id, title: s.title, sport: s.sport, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, organisation_id: s.organisation_id, cohort_name: s.cohort_name },
    issued_at: new Date().toISOString(), policy: { late_after_min: policy.late_after_min, second_after_min: policy.second_after_min, officer_after_min: policy.officer_after_min, no_show_after_min: policy.no_show_after_min, confirm_timeout_min: policy.confirm_timeout_min, require_guardian_confirmation: policy.require_guardian_confirmation },
    kpis: { expected: athletes.length, arrived: count((a) => PRESENT.includes(a.attendance)), in_care: count((a) => ['in_care', 'late', 'pending_confirmation', 'disputed'].includes(a.phase)), handed_over: count((a) => a.phase === 'handed_over'), late: count((a) => a.phase === 'late'),
      pending_confirmation: count((a) => a.phase === 'pending_confirmation'), no_show: count((a) => a.phase === 'no_show'), exceptions: kids.reduce((n, a) => n + a.open_events, 0) },
    athletes,
  };
}

cap({
  name: 'get_academy_pickup_board', method: 'GET', path: '/academy/sessions/:id/pickup', tag: TAG,
  summary: 'Staff desk for one academy session: every athlete with arrival, attendance and handover kept as separate facts, the phase they are in (expected, in care, pending guardian confirmation, late, handed over, no-show), who may collect each young person right now (names only), and the key metrics. Needs attendance access to the session. Also what a device caches for offline use (issued_at tells how fresh it is).',
  input: z.object({ id }),
  async handler({ user }, i) { return tx(async (c) => { const { s } = await sessionFor(user, i.id, 'attendance', { c }); return board(c, s, user); }); },
});

// ------------------------------------------------------------------------------------------------------------------ verify + record
const qrVerified = (token, s, collectorUserId, at) => {
  if (!token || !collectorUserId) return false;
  const t = readToken(token);
  return !!t && t.type === 'P' && t.domain === 'academy_session' && t.ref === s.id && t.userId === collectorUserId && checkToken(t, at) === 'ok';
};
const collectorInput = {
  athlete_id: id, mode: z.enum(MODES).default('collected'), collector_user_id: id.optional(), delegate_id: id.optional(),
  passphrase: z.string().min(1).max(60).optional(), pass_token: z.string().max(300).optional().describe('the collector\'s QR (get_pickup_pass); verified by the server'),
  attested: z.array(z.enum(['id_seen', 'photo_match'])).max(2).default([]).describe('what the staff member saw; no image or ID number is stored'),
};

cap({
  name: 'verify_academy_collector', method: 'POST', path: '/academy/sessions/:id/pickup/verify', tag: TAG,
  summary: 'Staff: check whether a collector (or a departure mode such as walking home) is allowed for an athlete right now, without recording anything. Returns the ticks the desk shows (authorised, QR valid, passphrase, ID seen) or the reason it is refused. The record_academy_handover call re-checks on the server.',
  input: z.object({ id, ...collectorInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await sessionFor(user, i.id, 'attendance', { c });
      const at = new Date();
      const a = await authorise(c, { athleteId: i.athlete_id, orgId: s.organisation_id, collectorUserId: i.collector_user_id ?? null, delegateId: i.delegate_id ?? null, mode: i.mode, at, passphrase: i.passphrase ?? null, attested: i.attested, qrOk: qrVerified(i.pass_token, s, i.collector_user_id, at), sessionRef: s, actor: user.id });
      return a.ok ? { ok: true, kind: a.kind, checks: a.checks } : { ok: false, code: a.code, reasons: a.reasons };
    });
  },
});

const handoverInput = { ...collectorInput, override_reason: z.string().min(10).max(500).optional().describe('only to hand over without a guardian confirmation; recorded, and safeguarding is told'), idempotency_key: z.string().min(8).max(80), captured_at: z.string().datetime().optional().describe('when it happened on a device that was offline') };

async function record(user, sessionId, i, { offline = false } = {}) {
  const out = await tx(async (c) => {
    const { s } = await sessionFor(user, sessionId, 'attendance', { write: true, c });
    const at = offline && i.captured_at ? new Date(i.captured_at) : new Date();
    if (+at > Date.now() + 120_000) throw badRequest('captured_at is in the future');
    if (offline && Date.now() - +at > OFFLINE_MAX_AGE_MS) throw new AppError(409, 'offline_too_old', 'This offline handover is too old to accept. Check the athlete with the guardian and record it again.');
    return recordHandover(c, { s, athleteId: i.athlete_id, collectorUserId: i.collector_user_id ?? null, delegateId: i.delegate_id ?? null, mode: i.mode, passphrase: i.passphrase ?? null, attested: i.attested, qrOk: qrVerified(i.pass_token, s, i.collector_user_id, at), overrideReason: i.override_reason ?? null, actor: user.id, key: i.idempotency_key, at, offline });
  });
  if (!out.denied) await audit(null, user.id, out.replayed ? 'replay_academy_handover' : 'record_academy_handover', 'academy_handovers', out.handover.id);
  if (out.denied) throw new AppError(403, out.denied.code, 'This person cannot take this athlete. The athlete stays in the academy\'s care and the guardians have been told.', { reasons: out.denied.reasons });
  return { id: out.handover.id, state: out.handover.state, replayed: !!out.replayed, awaiting_guardian: out.handover.state === 'pending_confirmation' };
}

cap({
  name: 'record_academy_handover', method: 'POST', path: '/academy/sessions/:id/pickup/handover', tag: TAG, status: 201,
  summary: 'Staff: record who took custody of an athlete at the end of a session. Unauthorised collectors are refused (403) and recorded as a safety event with the guardians told; a collector\'s authority withdrawn a moment ago is already gone. A young person leaves only with a verified guardian, a live collector (schedule, one-time use, passphrase honoured) or a departure mode a guardian allowed. Supervision transfers when a guardian confirms (confirm_academy_handover), when the collector is a guardian showing their own QR, or when staff give an override reason. Idempotent on idempotency_key.',
  input: z.object({ id, ...handoverInput }),
  async handler({ user }, i) { return record(user, i.id, i); },
});

cap({
  name: 'sync_academy_handovers', method: 'POST', path: '/academy/pickup/sync', tag: TAG,
  summary: 'Staff device: upload handovers captured without a network, up to 50, each with its own idempotency_key and captured_at. Every item is judged as of when it happened (a permission withdrawn before then is refused and raised for review), is applied once, and answers synced | already_synced | conflict | rejected, so the device can safely retry the whole batch.',
  input: z.object({ items: z.array(z.object({ session_id: id, ...handoverInput, captured_at: z.string().datetime() })).min(1).max(50) }),
  async handler({ user }, i) {
    const results = [];
    for (const it of i.items) {
      try {
        const r = await record(user, it.session_id, it, { offline: true });
        results.push({ idempotency_key: it.idempotency_key, status: r.replayed ? 'already_synced' : 'synced', id: r.id, state: r.state });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ idempotency_key: it.idempotency_key, status: e.status === 403 || e.status === 409 ? 'conflict' : 'rejected', code: e.code ?? String(e.status), reasons: e.details?.reasons, message: e.message });
      }
    }
    return { results };
  },
});

cap({
  name: 'escalate_academy_pickup', method: 'POST', path: '/academy/sessions/:id/pickup/escalate', tag: TAG,
  summary: 'Staff: step up a late pickup by hand: 1 tells the guardians, 2 also tries the second guardian and emergency contacts, 3 routes it to the safeguarding officer with a safety event. The sweep does the same on the academy\'s timings; levels only go up and repeating one changes nothing.',
  input: z.object({ id, athlete_id: id, level: z.number().int().min(1).max(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await sessionFor(user, i.id, 'attendance', { write: true, c });
      const att = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, i.athlete_id])).rows[0];
      if (!att || !PRESENT.includes(att.status)) throw notFound('Athlete');
      const h = await lockHandover(c, s, i.athlete_id);
      if (h.state === 'handed_over') throw conflict('This athlete has already been handed over', { code: 'already_handed_over' });
      const row = await escalate(c, h, i.level, { actor: user.id });
      return { id: row.id, escalation_level: row.escalation_level };
    });
  },
});

cap({
  name: 'get_academy_pickup_contacts', method: 'GET', path: '/academy/sessions/:id/pickup/contacts', tag: TAG,
  summary: 'Staff: phone numbers to call about an athlete who is in the academy\'s care and not yet handed over: the guardians and the emergency contacts in the order the family set. Decrypted, audit-logged, and refused for anyone who has already left or never arrived.',
  input: z.object({ id, athlete_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await sessionFor(user, i.id, 'attendance', { c });
      const att = (await c.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [s.id, i.athlete_id])).rows[0];
      const h = (await c.query('SELECT state FROM academy_handovers WHERE session_id=$1 AND athlete_id=$2', [s.id, i.athlete_id])).rows[0];
      if (!att || !PRESENT.includes(att.status) || h?.state === 'handed_over') throw notFound('Athlete');
      const guardians = (await c.query("SELECT u.display_name, u.phone_enc FROM guardian_links l JOIN users u ON u.id=l.guardian_id WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY l.created_at, l.id", [i.athlete_id])).rows
        .map((g) => ({ name: g.display_name, relationship: 'guardian', phone: decrypt(g.phone_enc, 'users.phone') }));
      const emergency = [];
      for (const e of await emergencyContacts(c, i.athlete_id)) emergency.push({ name: e.delegate_user_id ? (await c.query('SELECT display_name FROM users WHERE id=$1', [e.delegate_user_id])).rows[0]?.display_name : decrypt(e.delegate_name_enc, 'pickup_delegates.name'), relationship: e.relationship, phone: decrypt(e.phone_enc, 'pickup_delegates.phone') });
      await audit(c, user.id, 'read_pickup_contacts', 'users', i.athlete_id);
      return { guardians, emergency };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ safety events
const orgInput = { id };
const detailAccess = async (user, orgId, c) => { const a = await opsAccess(user, orgId, { c }); if (!a.has('safeguarding')) throw forbidden('Safety event details are for safeguarding staff'); return a; };
const staffAccess = async (user, orgId, c, write = false) => { const a = await opsAccess(user, orgId, { write, c }); if (!a.has('safeguarding') && !a.has('attendance')) throw forbidden('You do not have attendance or safeguarding access to this academy'); return a; };
const EVENT_COLS = `e.id, e.kind, e.severity, e.status, e.session_id, e.athlete_id, u.display_name AS athlete_name, e.opened_at, e.acknowledged_at, e.resolved_at, e.handover_id, (e.case_id IS NOT NULL) AS has_case, s.title AS session_title,
  (e.summary_enc IS NOT NULL) AS has_details`;

cap({
  name: 'report_academy_safety_event', method: 'POST', path: '/organisations/:id/academy/safety/events', tag: TAG, status: 201,
  summary: 'Staff: raise a welfare concern or an incident for an athlete, optionally linked to a session and a platform case. It is routed to the safeguarding officer (the policy\'s officer, else everyone holding the safeguarding permission, else the owners). The free text is encrypted and shown only to safeguarding staff; everyone else sees the kind, severity and status.',
  input: z.object({ ...orgInput, athlete_id: id, session_id: id.optional(), kind: z.enum(['welfare_concern', 'incident']), severity: z.enum(['low', 'medium', 'high']).default('medium'), summary: z.string().min(5).max(2000), case_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await staffAccess(user, i.id, c, true);
      if (!(await c.query("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2", [i.id, i.athlete_id])).rowCount) throw notFound('Athlete');
      if (i.session_id && !(await c.query('SELECT 1 FROM academy_sessions WHERE id=$1 AND organisation_id=$2', [i.session_id, i.id])).rowCount) throw notFound('Session');
      if (i.case_id && !(await c.query('SELECT 1 FROM cases WHERE id=$1', [i.case_id])).rowCount) throw notFound('Case');
      const policy = await policyFor(c, i.id);
      const { event } = await openSafetyEvent(c, { orgId: i.id, sessionId: i.session_id ?? null, athleteId: i.athlete_id, kind: i.kind, severity: i.severity, summary: i.summary, routedTo: await safeguardingOfficers(c, i.id, policy), actorId: user.id, caseId: i.case_id ?? null });
      return { id: event.id, status: event.status, severity: event.severity };
    });
  },
});

cap({
  name: 'list_academy_safety_events', method: 'GET', path: '/organisations/:id/academy/safety/events', tag: TAG,
  summary: 'Safety events for an academy, newest first, with minimal disclosure: kind, severity, status, athlete, session and time, never the notes. Filter by status or kind.',
  input: z.object({ ...orgInput, status: z.enum(['open', 'acknowledged', 'escalated', 'resolved', 'unresolved']).optional(), kind: z.enum(SAFETY_KINDS).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await staffAccess(user, i.id, c);
      return (await c.query(
        `SELECT ${EVENT_COLS} FROM academy_safety_events e JOIN users u ON u.id=e.athlete_id LEFT JOIN academy_sessions s ON s.id=e.session_id
          WHERE e.organisation_id=$1 AND ($2::text IS NULL OR e.status=$2 OR ($2='unresolved' AND e.status <> 'resolved')) AND ($3::text IS NULL OR e.kind=$3) ORDER BY e.opened_at DESC, e.id DESC LIMIT $4 OFFSET $5`,
        [i.id, i.status === 'unresolved' ? 'unresolved' : (i.status ?? null), i.kind ?? null, i.limit, i.offset])).rows;
    });
  },
});

const eventOf = async (c, eventId) => (await c.query('SELECT e.*, u.display_name AS athlete_name FROM academy_safety_events e JOIN users u ON u.id=e.athlete_id WHERE e.id=$1', [eventId])).rows[0];

cap({
  name: 'get_academy_safety_event', method: 'GET', path: '/academy/safety/events/:id', tag: TAG,
  summary: 'Safeguarding staff: one safety event with its notes (decrypted, audit-logged) and its append-only history. Anyone without the safeguarding permission gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = await eventOf(c, i.id);
      if (!e) throw notFound('Safety event');
      try { await detailAccess(user, e.organisation_id, c); } catch (err) { if (err instanceof AppError) throw notFound('Safety event'); throw err; }
      const { summary, resolution } = eventNotes(e);
      const history = (await c.query('SELECT l.kind, l.actor_id, a.display_name AS actor_name, l.detail, l.created_at FROM academy_safety_event_log l LEFT JOIN users a ON a.id=l.actor_id WHERE l.event_id=$1 ORDER BY l.created_at, l.id', [e.id])).rows;
      await audit(c, user.id, 'read_academy_safety_event', 'academy_safety_events', e.id);
      return { id: e.id, organisation_id: e.organisation_id, kind: e.kind, severity: e.severity, status: e.status, athlete_id: e.athlete_id, athlete_name: e.athlete_name, session_id: e.session_id, handover_id: e.handover_id, case_id: e.case_id, opened_at: e.opened_at, routed_to_count: e.routed_to.length, summary, resolution, history };
    });
  },
});

cap({
  name: 'update_academy_safety_event', method: 'PATCH', path: '/academy/safety/events/:id', tag: TAG,
  summary: 'Safeguarding staff: acknowledge, escalate (to severity high and every officer) or resolve a safety event. Resolving needs a short note (encrypted). Every step is added to the event\'s append-only history.',
  input: z.object({ id, action: z.enum(['acknowledge', 'escalate', 'resolve']), note: z.string().min(5).max(2000).optional() }).refine((v) => v.action !== 'resolve' || !!v.note, 'Say how it was resolved'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e0 = (await c.query('SELECT * FROM academy_safety_events WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!e0) throw notFound('Safety event');
      try { await detailAccess(user, e0.organisation_id, c); } catch (err) { if (err instanceof AppError) throw notFound('Safety event'); throw err; }
      if (e0.status === 'resolved') throw conflict('This event is already resolved', { code: 'already_resolved' });
      let row;
      if (i.action === 'acknowledge') row = (await c.query("UPDATE academy_safety_events SET status=CASE WHEN status='open' THEN 'acknowledged' ELSE status END, acknowledged_by=coalesce(acknowledged_by,$2), acknowledged_at=coalesce(acknowledged_at,now()), row_version=row_version+1 WHERE id=$1 RETURNING *", [i.id, user.id])).rows[0];
      else if (i.action === 'escalate') {
        const officers = await safeguardingOfficers(c, e0.organisation_id, await policyFor(c, e0.organisation_id));
        row = (await c.query("UPDATE academy_safety_events SET status='escalated', severity='high', routed_to=$2, row_version=row_version+1 WHERE id=$1 RETURNING *", [i.id, officers])).rows[0];
      } else row = (await c.query("UPDATE academy_safety_events SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_enc=$3, row_version=row_version+1 WHERE id=$1 RETURNING *", [i.id, user.id, encrypt(i.note, 'academy_safety_events.resolution')])).rows[0];
      await c.query('INSERT INTO academy_safety_event_log(event_id, kind, actor_id, detail) VALUES ($1,$2,$3,$4)', [i.id, i.action === 'acknowledge' ? 'acknowledged' : i.action === 'escalate' ? 'escalated' : 'resolved', user.id, i.action]);
      await audit(c, user.id, `${i.action}_academy_safety_event`, 'academy_safety_events', i.id);
      return { id: row.id, status: row.status, severity: row.severity };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ oversight + policy
cap({
  name: 'get_academy_safety_overview', method: 'GET', path: '/organisations/:id/academy/safety', tag: TAG,
  summary: 'Management oversight for an academy: today\'s athletes on site, on-time arrival, late pickups, no-shows, handovers waiting for a guardian, verified handovers, open safety events, eight weeks of late pickups, the exceptions queue (kind, severity, status only), and which young athletes have no live collector on file. Names appear only as needed to act; notes never do.',
  input: z.object({ ...orgInput, weeks: z.coerce.number().int().min(2).max(26).default(8) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await staffAccess(user, i.id, c);
      const policy = await policyFor(c, i.id);
      const day = (await c.query(
        `SELECT count(DISTINCT at.user_id) FILTER (WHERE at.status IN ('present','late','left_early'))::int AS on_site,
                count(*) FILTER (WHERE at.status IN ('present','late','left_early'))::int AS arrived, count(*) FILTER (WHERE at.status = 'present')::int AS on_time
           FROM academy_sessions s JOIN academy_attendance at ON at.session_id=s.id WHERE s.organisation_id=$1 AND s.status IN ('published','completed') AND s.starts_at >= date_trunc('day', now()) AND s.starts_at < date_trunc('day', now()) + interval '1 day'`, [i.id])).rows[0];
      const hv = (await c.query(
        `SELECT count(*) FILTER (WHERE state='handed_over')::int AS handed_over, count(*) FILTER (WHERE state='handed_over' AND (cardinality(checks) > 0 OR confirm_method IS NOT NULL))::int AS verified, count(*) FILTER (WHERE state='pending_confirmation')::int AS pending,
                count(*) FILTER (WHERE state IN ('awaiting','disputed') AND escalation_level > 0)::int AS late_open
           FROM academy_handovers WHERE organisation_id=$1 AND expected_pickup_at >= date_trunc('day', now()) AND expected_pickup_at < date_trunc('day', now()) + interval '1 day'`, [i.id])).rows[0];
      const noShows = (await c.query("SELECT count(*)::int AS n FROM academy_safety_events WHERE organisation_id=$1 AND kind='no_show' AND opened_at >= date_trunc('day', now())", [i.id])).rows[0].n;
      const lateToday = (await c.query("SELECT count(*)::int AS n FROM academy_safety_events WHERE organisation_id=$1 AND kind='late_pickup' AND opened_at >= date_trunc('day', now())", [i.id])).rows[0].n;
      const open = (await c.query("SELECT count(*)::int AS n FROM academy_safety_events WHERE organisation_id=$1 AND status <> 'resolved'", [i.id])).rows[0].n;
      const offline = (await c.query("SELECT count(*)::int AS n FROM academy_safety_events WHERE organisation_id=$1 AND kind='offline_conflict' AND status <> 'resolved'", [i.id])).rows[0].n;
      const trend = (await c.query(
        `SELECT to_char(w.wk, 'IYYY-"W"IW') AS week, w.wk::date AS starts_on, coalesce(count(e.id),0)::int AS late_pickups
           FROM generate_series(date_trunc('week', now()) - make_interval(weeks => $2 - 1), date_trunc('week', now()), interval '1 week') AS w(wk)
           LEFT JOIN academy_safety_events e ON e.organisation_id=$1 AND e.kind='late_pickup' AND e.opened_at >= w.wk AND e.opened_at < w.wk + interval '1 week' GROUP BY w.wk ORDER BY w.wk`, [i.id, i.weeks])).rows;
      const queue = (await c.query(
        `SELECT ${EVENT_COLS} FROM academy_safety_events e JOIN users u ON u.id=e.athlete_id LEFT JOIN academy_sessions s ON s.id=e.session_id
          WHERE e.organisation_id=$1 AND e.status <> 'resolved' ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.opened_at DESC LIMIT 25`, [i.id])).rows;
      const youth = (await c.query(
        `SELECT DISTINCT u.id AS athlete_id, u.display_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id AND k.organisation_id=$1 JOIN users u ON u.id=e.user_id AND (u.youth_until IS NOT NULL AND u.youth_until > current_date) WHERE e.status='enrolled'`, [i.id])).rows;
      const without = [];
      for (const y of youth) {
        const g = (await c.query("SELECT 1 FROM guardian_links l WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND 'pickup' = ANY(l.scopes) LIMIT 1", [y.athlete_id])).rowCount;
        if (!g) without.push(y);
      }
      return {
        organisation_id: i.id, scope: 'organisation', can_see_details: a.has('safeguarding'), policy: { late_after_min: policy.late_after_min, second_after_min: policy.second_after_min, officer_after_min: policy.officer_after_min, no_show_after_min: policy.no_show_after_min, confirm_timeout_min: policy.confirm_timeout_min, require_guardian_confirmation: policy.require_guardian_confirmation, is_default: !policy.id },
        kpis: { on_site: day.on_site, on_time_pct: day.arrived ? Math.round((100 * day.on_time) / day.arrived) : null, late_pickups_today: lateToday, no_shows_today: noShows, pending_confirmation: hv.pending, verified_handover_pct: hv.handed_over ? Math.round((100 * hv.verified) / hv.handed_over) : null, open_events: open, offline_conflicts: offline },
        trend, queue, coverage: { youth_athletes: youth.length, without_live_guardian_pickup: without.length, athletes_without_guardian: without.slice(0, 25) },
      };
    });
  },
});

const timingShape = {
  late_after_min: z.number().int().min(1).max(240), second_after_min: z.number().int().min(1).max(480), officer_after_min: z.number().int().min(1).max(720), no_show_after_min: z.number().int().min(1).max(240), confirm_timeout_min: z.number().int().min(1).max(120),
  require_guardian_confirmation: z.boolean(), safeguarding_officer_id: id.nullable().optional(),
};

cap({
  name: 'get_academy_pickup_policy', method: 'GET', path: '/organisations/:id/academy/safety/policy', tag: TAG,
  summary: 'The academy\'s late-pickup, no-show and guardian-confirmation settings (the built-in defaults of 10 / 20 / 40 minutes apply until one is saved).',
  input: z.object(orgInput),
  async handler({ user }, i) { return tx(async (c) => { await staffAccess(user, i.id, c); const p = await policyFor(c, i.id); return { ...p, is_default: !p.id }; }); },
});

cap({
  name: 'set_academy_pickup_policy', method: 'POST', path: '/organisations/:id/academy/safety/policy', tag: TAG,
  summary: 'Owner/admin: set the escalation timings (minutes after the session ends: guardians, second guardian + emergency contacts, safeguarding officer), when a no-show is raised, how long a handover may wait for a guardian, and whether guardian confirmation is required. A new version replaces the old one, which is retired, not deleted.',
  input: z.object({ ...orgInput, ...timingShape }).refine((v) => v.late_after_min <= v.second_after_min && v.second_after_min <= v.officer_after_min, 'Escalation steps must be in order'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.id, { write: true, c });
      if (!a.admin) throw forbidden('Only an owner or admin can change the pickup policy');
      if (i.safeguarding_officer_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.safeguarding_officer_id])).rowCount) throw badRequest('The safeguarding officer must be a member of this organisation');
      const cur = (await c.query('SELECT version FROM academy_pickup_policies WHERE organisation_id=$1 AND retired_at IS NULL FOR UPDATE', [i.id])).rows[0];
      await c.query('UPDATE academy_pickup_policies SET retired_at=now() WHERE organisation_id=$1 AND retired_at IS NULL', [i.id]);
      const r = (await c.query(
        `INSERT INTO academy_pickup_policies(organisation_id, late_after_min, second_after_min, officer_after_min, no_show_after_min, confirm_timeout_min, require_guardian_confirmation, safeguarding_officer_id, version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.id, i.late_after_min, i.second_after_min, i.officer_after_min, i.no_show_after_min, i.confirm_timeout_min, i.require_guardian_confirmation, i.safeguarding_officer_id ?? null, (cur?.version ?? 0) + 1, user.id])).rows[0];
      await audit(c, user.id, 'set_academy_pickup_policy', 'organisations', i.id);
      return r;
    });
  },
});
