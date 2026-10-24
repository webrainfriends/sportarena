// Academy OS 2/3: the workforce. Staff are existing users with an organisation membership; only the organisation-scoped engagement
// (title, type, scope, permissions, availability, leave) lives here. Credentials are read from the canonical verification badges.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { badgesFor } from '../verification.js';
import { opsAccess, staffIssues, PERMS, TEMPLATES, ADMINS } from '../academy-ops.js';
import { hhmm } from '../booking/time.js';

const TAG = 'Academy operations';
const day = z.string().date();
const time = z.string().regex(/^\d{1,2}:\d{2}$/);

const publicEng = ({ notes_enc, ...e }) => e;

cap({
  name: 'upsert_academy_engagement', method: 'POST', path: '/organisations/:id/academy/staff/:user_id', tag: TAG,
  summary: 'Create or update a person\'s academy engagement (owner/admin): job title, employee/contractor/volunteer, scope (sports, groups), permission set, required credentials, manager and HR notes (encrypted, owner/admin only). The person must already be an active member (invite them as "staff" or "coach"). Role changes are audit-logged; revocation (state ended/suspended) takes effect on their next request.',
  input: z.object({
    id, user_id: id, job_title: z.string().trim().min(2).max(80), template: z.enum(Object.keys(TEMPLATES)).default('custom'),
    engagement_type: z.enum(['employee', 'contractor', 'volunteer']).default('employee'), staff_ref: z.string().max(40).optional(), state: z.enum(['active', 'leave', 'suspended', 'ended']).default('active'),
    starts_on: day.optional(), ends_on: day.optional(), manager_id: id.optional(), permissions: z.array(z.enum(PERMS)).max(PERMS.length).optional(),
    scope_sports: z.array(z.string().max(40)).max(20).default([]), scope_cohort_ids: z.array(id).max(100).default([]), required_credentials: z.array(z.enum(['coach_badge'])).default([]),
    notes: z.string().max(2000).optional(), row_version: z.number().int().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    if (!a.admin) throw forbidden('Only owners and admins manage staff engagements');
    const m = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rows[0];
    if (!m) throw badRequest('That person is not an active member of this organisation');
    if (i.ends_on && i.starts_on && i.ends_on < i.starts_on) throw badRequest('The end date is before the start date');
    if (i.manager_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.manager_id])).rowCount) throw badRequest('The manager must be an active member');
    if (i.scope_cohort_ids.length && (await c.query('SELECT count(*)::int AS n FROM org_cohorts WHERE organisation_id=$1 AND id = ANY($2)', [i.id, i.scope_cohort_ids])).rows[0].n !== i.scope_cohort_ids.length) throw badRequest('A scoped group does not belong to this organisation');
    const perms = i.permissions ?? TEMPLATES[i.template].permissions;
    const cur = (await c.query('SELECT * FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2 FOR UPDATE', [i.id, i.user_id])).rows[0];
    if (cur && i.row_version !== undefined && cur.row_version !== i.row_version) throw conflict('This engagement was changed by someone else. Reload and try again.', { row_version: cur.row_version });
    if (m.role === 'owner' && i.state !== 'active') throw conflict('An owner cannot be suspended or ended here; transfer ownership first');
    const notes = i.notes === undefined ? cur?.notes_enc ?? null : i.notes ? encrypt(i.notes, 'org_staff_engagements.notes') : null;
    const row = (await c.query(
      `INSERT INTO org_staff_engagements(organisation_id, user_id, job_title, template, engagement_type, staff_ref, state, starts_on, ends_on, manager_id, permissions, scope_sports, scope_cohort_ids, required_credentials, notes_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (organisation_id, user_id) DO UPDATE SET job_title=EXCLUDED.job_title, template=EXCLUDED.template, engagement_type=EXCLUDED.engagement_type, staff_ref=EXCLUDED.staff_ref, state=EXCLUDED.state, starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on,
         manager_id=EXCLUDED.manager_id, permissions=EXCLUDED.permissions, scope_sports=EXCLUDED.scope_sports, scope_cohort_ids=EXCLUDED.scope_cohort_ids, required_credentials=EXCLUDED.required_credentials, notes_enc=EXCLUDED.notes_enc, row_version=org_staff_engagements.row_version+1, updated_at=now()
       RETURNING *`,
      [i.id, i.user_id, i.job_title, i.template, i.engagement_type, i.staff_ref ?? null, i.state, i.starts_on ?? null, i.ends_on ?? null, i.manager_id ?? null, perms, i.scope_sports, i.scope_cohort_ids, i.required_credentials, notes])).rows[0];
    await audit(c, user.id, cur ? 'update_academy_engagement' : 'create_academy_engagement', 'org_staff_engagements', row.id);
    // someone who is no longer active must not keep upcoming assignments: they surface as cover requests, nothing is silently dropped
    if (i.state !== 'active') {
      const open = await c.query(
        `SELECT st.session_id FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id WHERE st.user_id=$1 AND s.organisation_id=$2 AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published') AND s.starts_at > now()`, [i.user_id, i.id]);
      for (const r of open.rows) await c.query("INSERT INTO academy_cover_requests(session_id, requester_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [r.session_id, i.user_id, `Engagement is ${i.state}`]);
    }
    return publicEng(row);
  }),
});

cap({
  name: 'list_academy_staff', method: 'GET', path: '/organisations/:id/academy/staff', tag: TAG,
  summary: 'Academy staff: members with their engagement, scope, permissions, credential status (from verified badges), hours scheduled this week and open items. Needs organisation-wide schedule or timesheets access. HR notes are never in the list. Also returns the job-title templates.',
  input: z.object({ id, ...page, limit: z.coerce.number().int().min(1).max(200).default(100) }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    if (!a.hasBroad('schedule') && !a.hasBroad('timesheets')) throw forbidden('You do not have access to academy staff');
    const rows = await many(
      `SELECT m.user_id, m.role, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, e.id AS engagement_id, e.job_title, e.template, e.engagement_type, e.state, e.permissions, e.scope_sports, e.scope_cohort_ids, e.required_credentials, e.starts_on, e.ends_on, e.manager_id, e.row_version, e.staff_ref,
              (SELECT coalesce(sum(extract(epoch FROM (s.ends_at - s.starts_at)) / 60), 0)::int FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id WHERE st.user_id=m.user_id AND s.organisation_id=m.organisation_id AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published') AND s.starts_at >= date_trunc('week', now()) AND s.starts_at < date_trunc('week', now()) + interval '7 days') AS week_minutes,
              (SELECT count(*)::int FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id WHERE st.user_id=m.user_id AND s.organisation_id=m.organisation_id AND st.status='assigned' AND s.status IN ('draft','published') AND s.starts_at > now()) AS unconfirmed
         FROM organisation_members m JOIN users u ON u.id=m.user_id LEFT JOIN org_staff_engagements e ON e.organisation_id=m.organisation_id AND e.user_id=m.user_id
        WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('owner','admin','coach','staff','finance') ORDER BY u.display_name, m.user_id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    const badges = await badgesFor('user', rows.map((r) => r.user_id));
    return {
      templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, title: t.title, permissions: t.permissions })),
      staff: rows.map((r) => {
        const b = (badges.get(r.user_id) ?? []).find((x) => x.type === 'coach');
        const days = b ? Math.ceil((new Date(b.expires_at) - Date.now()) / 86400000) : null;
        return { ...r, credential: { coach_badge: b ? { verified_at: b.verified_at, expires_at: b.expires_at, days_left: days, expiring_soon: days != null && days <= 60 } : null, missing: (r.required_credentials ?? []).includes('coach_badge') && !b } };
      }),
    };
  },
});

cap({
  name: 'get_academy_engagement', method: 'GET', path: '/organisations/:id/academy/staff/:user_id', tag: TAG,
  summary: 'One person\'s engagement. Owner/admin also receive the HR notes; reading them is audit-logged. A person can read their own engagement without the notes.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    if (!a.admin && user.id !== i.user_id) throw forbidden('Only owners and admins can read another person\'s engagement');
    const e = await one('SELECT * FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2', [i.id, i.user_id]);
    if (!e) throw notFound('Engagement');
    if (!a.admin) return publicEng(e);
    if (e.notes_enc) await audit(null, user.id, 'read_academy_engagement_notes', 'org_staff_engagements', e.id);
    return { ...publicEng(e), notes: e.notes_enc ? decrypt(e.notes_enc, 'org_staff_engagements.notes') : null };
  },
});

// ------------------------------------------------------------------ availability and leave
cap({
  name: 'set_academy_availability', method: 'POST', path: '/organisations/:id/academy/availability', tag: TAG, status: 201,
  summary: 'Set standing weekly availability or a one-off exception for yourself (or, as owner/admin, for someone else). With replace_weekly the previous weekly pattern is retired and the new one takes effect; with no weekly rows at all a person counts as available.',
  input: z.object({
    id, user_id: id.optional(), replace_weekly: z.boolean().default(false),
    weekly: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: time, end_time: time })).max(28).default([]),
    exception: z.object({ on_date: day, start_time: time, end_time: time, reason: z.string().max(200).optional() }).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    const who = i.user_id ?? user.id;
    if (who !== user.id && !a.admin) throw forbidden('You can only set your own availability');
    if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, who])).rowCount) throw badRequest('Not an active member');
    const span = (w) => { const s = hhmm(w.start_time), e = hhmm(w.end_time); if (Number.isNaN(s) || Number.isNaN(e) || e <= s) throw badRequest('End time must be after start time'); return [s, e]; };
    if (i.replace_weekly) await c.query("UPDATE academy_staff_availability SET status='cancelled' WHERE organisation_id=$1 AND user_id=$2 AND kind='weekly' AND status='approved'", [i.id, who]);
    for (const w of i.weekly) { const [s, e] = span(w); await c.query("INSERT INTO academy_staff_availability(organisation_id, user_id, kind, weekday, start_min, end_min) VALUES ($1,$2,'weekly',$3,$4,$5)", [i.id, who, w.weekday, s, e]); }
    if (i.exception) { const [s, e] = span(i.exception); await c.query("INSERT INTO academy_staff_availability(organisation_id, user_id, kind, on_date, start_min, end_min, reason) VALUES ($1,$2,'exception',$3,$4,$5,$6)", [i.id, who, i.exception.on_date, s, e, i.exception.reason ?? null]); }
    // standing availability may now conflict with existing assignments: report them, never silently drop anyone
    const clashes = await c.query(
      `SELECT st.session_id, s.title, s.starts_at FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id WHERE st.user_id=$1 AND s.organisation_id=$2 AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published') AND s.starts_at > now() ORDER BY s.starts_at LIMIT 200`, [who, i.id]);
    const affected = [];
    for (const r of clashes.rows) {
      const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1', [r.session_id])).rows[0];
      const issues = (await staffIssues(c, i.id, who, s.starts_at, s.ends_at, { excludeSessionId: s.id, tz: s.timezone })).filter((x) => x.kind === 'availability');
      if (issues.length) affected.push({ session_id: s.id, title: s.title, starts_at: s.starts_at });
    }
    return { ok: true, sessions_outside_availability: affected };
  }),
});

cap({
  name: 'list_academy_availability', method: 'GET', path: '/organisations/:id/academy/availability', tag: TAG,
  summary: 'Availability, exceptions and leave for yourself, or for everyone (owner/admin; add user_id to narrow). Leave board: pass kind=time_off.',
  input: z.object({ id, user_id: id.optional(), kind: z.enum(['weekly', 'exception', 'time_off']).optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    const who = a.admin || a.has('schedule') ? i.user_id ?? null : user.id;
    if (i.user_id && i.user_id !== user.id && !a.admin && !a.has('schedule')) throw forbidden('You can only see your own availability');
    return many(
      `SELECT v.*, u.display_name FROM academy_staff_availability v JOIN users u ON u.id=v.user_id
        WHERE v.organisation_id=$1 AND ($2::uuid IS NULL OR v.user_id=$2) AND ($3::text IS NULL OR v.kind=$3) AND v.status = coalesce($4, v.status) AND ($4::text IS NOT NULL OR v.status <> 'cancelled')
        ORDER BY v.kind, v.on_date NULLS LAST, v.weekday, v.start_min, v.id LIMIT $5 OFFSET $6`, [i.id, who ?? (a.admin || a.has('schedule') ? null : user.id), i.kind ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'request_academy_time_off', method: 'POST', path: '/organisations/:id/academy/time-off', tag: TAG, status: 201,
  summary: 'Request time off for a date range. Owner/admin are told. Nothing is blocked until it is approved; approval then opens cover requests for any session already assigned in that range.',
  input: z.object({ id, on_date: day, ends_on: day.optional(), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await opsAccess(user, i.id, { write: true, c });
    if (i.ends_on && i.ends_on < i.on_date) throw badRequest('The end date is before the start date');
    const r = (await c.query("INSERT INTO academy_staff_availability(organisation_id, user_id, kind, on_date, ends_on, reason, status) VALUES ($1,$2,'time_off',$3,$4,$5,'pending') RETURNING *", [i.id, user.id, i.on_date, i.ends_on ?? null, i.reason ?? null])).rows[0];
    for (const m of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role = ANY($2) AND status='active' AND user_id<>$3", [i.id, ADMINS, user.id])).rows) {
      await notify(c, m.user_id, { kind: 'academy_time_off_request', title: 'Time off requested', body: 'Open Academy Operations to review.', data: { organisation_id: i.id, request_id: r.id }, dedupe_key: `academy-timeoff:${r.id}:${m.user_id}` });
    }
    return r;
  }),
});

cap({
  name: 'decide_academy_time_off', method: 'POST', path: '/academy/time-off/:id/decision', tag: TAG,
  summary: 'Approve or reject a time-off request (owner/admin; not your own). Approval returns the sessions that now need cover and opens a cover request for each.',
  input: z.object({ id, approve: z.boolean(), note: z.string().max(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query("SELECT * FROM academy_staff_availability WHERE id=$1 AND kind='time_off' FOR UPDATE", [i.id])).rows[0];
    if (!r) throw notFound('Time-off request');
    const a = await opsAccess(user, r.organisation_id, { write: true, c });
    if (!a.admin) throw forbidden('Only owners and admins decide time off');
    if (r.user_id === user.id && !a.perms.has('payroll') && !(a.role === 'owner')) throw forbidden('You cannot approve your own time off');
    if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
    await c.query('UPDATE academy_staff_availability SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [r.id, i.approve ? 'approved' : 'rejected', user.id]);
    let needs_cover = [];
    if (i.approve) {
      needs_cover = (await c.query(
        `SELECT st.session_id, s.title, s.starts_at FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id
          WHERE st.user_id=$1 AND s.organisation_id=$2 AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published')
            AND (s.starts_at AT TIME ZONE s.timezone)::date BETWEEN $3::date AND coalesce($4::date, $3::date) ORDER BY s.starts_at`, [r.user_id, r.organisation_id, r.on_date, r.ends_on])).rows;
      for (const n of needs_cover) await c.query("INSERT INTO academy_cover_requests(session_id, requester_id, reason) VALUES ($1,$2,'Approved time off') ON CONFLICT DO NOTHING", [n.session_id, r.user_id]);
    }
    await notify(c, r.user_id, { kind: 'academy_time_off_decision', title: i.approve ? 'Time off approved' : 'Time off not approved', body: i.note ?? 'Open Gotmygame for details.', data: { organisation_id: r.organisation_id, request_id: r.id }, dedupe_key: `academy-timeoff-decision:${r.id}` });
    await audit(c, user.id, i.approve ? 'approve_academy_time_off' : 'reject_academy_time_off', 'academy_staff_availability', r.id);
    return { ok: true, status: i.approve ? 'approved' : 'rejected', sessions_needing_cover: needs_cover };
  }),
});

// ------------------------------------------------------------------ cover and swaps
cap({
  name: 'request_academy_cover', method: 'POST', path: '/academy/sessions/:id/cover', tag: TAG, status: 201,
  summary: 'Report an absence / ask for cover on a session you are assigned to (kind cover), or propose a swap with a named colleague (kind swap, which still needs a manager to confirm). Owners and admins are told. Repeating the request returns the open one.',
  input: z.object({ id, kind: z.enum(['cover', 'swap']).default('cover'), swap_with: id.optional(), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_sessions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    if (!(await c.query("SELECT 1 FROM academy_session_staff WHERE session_id=$1 AND user_id=$2 AND status IN ('assigned','confirmed')", [s.id, user.id])).rowCount) throw forbidden('You are not assigned to this session');
    if (!['draft', 'published'].includes(s.status) || s.starts_at < new Date()) throw conflict('Cover can only be requested for an upcoming session');
    if (i.kind === 'swap' && !i.swap_with) throw badRequest('Say who you want to swap with');
    const open = (await c.query("SELECT * FROM academy_cover_requests WHERE session_id=$1 AND requester_id=$2 AND status='open'", [s.id, user.id])).rows[0];
    if (open) return open;
    const r = (await c.query('INSERT INTO academy_cover_requests(session_id, requester_id, kind, swap_with, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *', [s.id, user.id, i.kind, i.swap_with ?? null, i.reason ?? null])).rows[0];
    for (const m of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role = ANY($2) AND status='active'", [s.organisation_id, ADMINS])).rows) {
      await notify(c, m.user_id, { kind: 'academy_cover_needed', title: 'A session needs cover', body: 'Open Academy Operations to find a substitute.', data: { session_id: s.id, organisation_id: s.organisation_id, request_id: r.id }, dedupe_key: `academy-cover-req:${r.id}:${m.user_id}` });
    }
    return r;
  }),
});

cap({
  name: 'list_academy_cover_requests', method: 'GET', path: '/organisations/:id/academy/cover', tag: TAG,
  summary: 'Open cover and swap requests with the session, who asked and why (schedule access). A request is filled by assigning someone with assign_academy_staff and replaces, which also closes it.',
  input: z.object({ id, status: z.enum(['open', 'filled', 'declined', 'cancelled']).default('open'), ...page }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    a.need('schedule');
    return many(
      `SELECT r.*, s.title, s.starts_at, s.ends_at, s.cohort_id, u.display_name AS requester_name, cu.display_name AS cover_name
         FROM academy_cover_requests r JOIN academy_sessions s ON s.id=r.session_id JOIN users u ON u.id=r.requester_id LEFT JOIN users cu ON cu.id=r.cover_user_id
        WHERE s.organisation_id=$1 AND r.status=$2 ORDER BY s.starts_at, r.id LIMIT $3 OFFSET $4`, [i.id, i.status, i.limit, i.offset]);
  },
});

cap({
  name: 'close_academy_cover_request', method: 'POST', path: '/academy/cover/:id/close', tag: TAG,
  summary: 'Decline a cover/swap request (schedule access) or withdraw your own.',
  input: z.object({ id, action: z.enum(['decline', 'cancel']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const r = (await c.query("SELECT r.*, s.organisation_id FROM academy_cover_requests r JOIN academy_sessions s ON s.id=r.session_id WHERE r.id=$1 FOR UPDATE OF r", [i.id])).rows[0];
    if (!r) throw notFound('Cover request');
    const a = await opsAccess(user, r.organisation_id, { write: true, c });
    if (i.action === 'cancel' ? r.requester_id !== user.id : !a.has('schedule')) throw forbidden('You cannot close this request');
    if (r.status !== 'open') throw conflict(`This request is already ${r.status}`);
    await c.query('UPDATE academy_cover_requests SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [r.id, i.action === 'cancel' ? 'cancelled' : 'declined', user.id]);
    if (i.action === 'decline') await notify(c, r.requester_id, { kind: 'academy_cover_declined', title: 'Your cover request was not approved', body: 'Open Gotmygame for details.', data: { session_id: r.session_id }, dedupe_key: `academy-cover-declined:${r.id}` });
    return { ok: true };
  }),
});

// ------------------------------------------------------------------ shifts (non-session work)
const dt = z.string().datetime({ offset: true });
cap({
  name: 'create_academy_shift', method: 'POST', path: '/organisations/:id/academy/shifts', tag: TAG, status: 201,
  summary: 'Plan non-session work for a staff member: registration desk, programme coordination, safeguarding duty, event support. Same clash, leave and availability checks as a session assignment; the person is asked to acknowledge it. This is academy work; a venue\'s own duty roster stays with the venue and is referenced, not copied.',
  input: z.object({ id, user_id: id, title: z.string().trim().min(2).max(80), duty_label: z.string().max(40).optional(), starts_at: dt, ends_at: dt, programme_id: id.optional(), timezone: z.string().max(60).default('UTC') }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('schedule');
    if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('The shift ends before it starts');
    if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.user_id])).rowCount) throw badRequest('Only active members can be rostered');
    const eng = (await c.query('SELECT state FROM org_staff_engagements WHERE organisation_id=$1 AND user_id=$2', [i.id, i.user_id])).rows[0];
    if (eng && eng.state !== 'active') throw conflict(`This person is ${eng.state} and cannot be rostered`);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('academy-staff:' || $1, 0))", [i.user_id]);
    const iss = await staffIssues(c, i.id, i.user_id, i.starts_at, i.ends_at, { tz: i.timezone });
    if (iss.length) throw conflict('This person cannot take that shift', { conflicts: iss });
    const r = (await c.query('INSERT INTO academy_shifts(organisation_id, user_id, title, duty_label, programme_id, timezone, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [i.id, i.user_id, i.title, i.duty_label ?? null, i.programme_id ?? null, i.timezone, i.starts_at, i.ends_at, user.id])).rows[0];
    await notify(c, i.user_id, { kind: 'academy_shift', title: 'You were rostered for a shift', body: 'Open Gotmygame to confirm.', data: { shift_id: r.id, organisation_id: i.id }, dedupe_key: `academy-shift:${r.id}:${i.user_id}` });
    return r;
  }),
});

cap({
  name: 'respond_academy_shift', method: 'POST', path: '/academy/shifts/:id/respond', tag: TAG,
  summary: 'Acknowledge (accept) or decline your own shift. Declining tells the owners and admins so the shift can be covered.',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const sh = (await c.query("UPDATE academy_shifts SET status=$2, responded_at=now(), row_version=row_version+1 WHERE id=$1 AND user_id=$3 AND status IN ('assigned','confirmed') RETURNING *", [i.id, i.accept ? 'confirmed' : 'declined', user.id])).rows[0];
    if (!sh) throw notFound('Shift');
    if (!i.accept) for (const m of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role = ANY($2) AND status='active'", [sh.organisation_id, ADMINS])).rows) {
      await notify(c, m.user_id, { kind: 'academy_shift_declined', title: 'A shift needs cover', body: 'Open Academy Operations.', data: { shift_id: sh.id, organisation_id: sh.organisation_id }, dedupe_key: `academy-shift-declined:${sh.id}:${m.user_id}` });
    }
    return sh;
  }),
});

cap({
  name: 'cancel_academy_shift', method: 'DELETE', path: '/academy/shifts/:id', tag: TAG,
  summary: 'Cancel a planned shift (schedule access). History stays; the person is told.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const sh = (await c.query('SELECT * FROM academy_shifts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!sh) throw notFound('Shift');
    (await opsAccess(user, sh.organisation_id, { write: true, c })).need('schedule');
    await c.query("UPDATE academy_shifts SET status='cancelled', row_version=row_version+1 WHERE id=$1", [sh.id]);
    await notify(c, sh.user_id, { kind: 'academy_shift_cancelled', title: 'A shift was cancelled', body: 'Open Gotmygame for details.', data: { shift_id: sh.id }, dedupe_key: `academy-shift-cancel:${sh.id}` });
    return { ok: true };
  }),
});

cap({
  name: 'list_academy_shifts', method: 'GET', path: '/organisations/:id/academy/shifts', tag: TAG,
  summary: 'Planned shifts in a date range: everyone\'s for schedule access, otherwise only your own.',
  input: z.object({ id, from: day, to: day, ...page }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    return many(
      `SELECT sh.*, u.display_name FROM academy_shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.organisation_id=$1 AND sh.status <> 'cancelled' AND sh.starts_at >= $2::date AND sh.starts_at < $3::date + 1 AND ($4 OR sh.user_id=$5) ORDER BY sh.starts_at, sh.id LIMIT $6 OFFSET $7`,
      [i.id, i.from, i.to, a.has('schedule'), user.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ personal agenda
cap({
  name: 'get_my_academy_agenda', method: 'GET', path: '/me/academy/agenda', tag: TAG,
  summary: 'Your academy commitments over a date range across every organisation: assigned sessions (with venue and what you still need to confirm), open cover requests and leave. Phone-first coach view. The same sessions also appear in the coach calendar as source-linked items; nothing is stored twice.',
  input: z.object({ from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const from = i.from ?? new Date().toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10);
    if (to < from || Date.parse(to) - Date.parse(from) > 93 * 86400000) throw badRequest('Choose a range of at most 93 days');
    const sessions = await many(
      `SELECT s.id, s.organisation_id, o.name AS organisation, s.cohort_id, k.name AS cohort, s.title, s.starts_at, s.ends_at, s.timezone, s.status, st.role, st.status AS my_status, st.duty_label, s.sport, s.self_checkin,
              (SELECT v.name || ' · ' || r.name FROM session_venue_links l JOIN bookings b ON b.id=l.booking_id AND b.status='confirmed' JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE l.session_type='academy_session' AND l.session_id=s.id AND l.released_at IS NULL LIMIT 1) AS venue,
              (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.status='enrolled') AS enrolled,
              EXISTS (SELECT 1 FROM academy_cover_requests r WHERE r.session_id=s.id AND r.requester_id=$1 AND r.status='open') AS cover_requested
         FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN org_cohorts k ON k.id=s.cohort_id JOIN organisations o ON o.id=s.organisation_id
        WHERE st.user_id=$1 AND st.status IN ('assigned','confirmed') AND s.status IN ('draft','published') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1
        ORDER BY s.starts_at, s.id`, [user.id, from, to]);
    const leave = await many("SELECT id, organisation_id, on_date, ends_on, status, reason FROM academy_staff_availability WHERE user_id=$1 AND kind='time_off' AND status IN ('pending','approved') AND coalesce(ends_on, on_date) >= $2::date AND on_date <= $3::date ORDER BY on_date", [user.id, from, to]);
    const shifts = await many("SELECT sh.id, sh.organisation_id, o.name AS organisation, sh.title, sh.duty_label, sh.starts_at, sh.ends_at, sh.timezone, sh.status FROM academy_shifts sh JOIN organisations o ON o.id=sh.organisation_id WHERE sh.user_id=$1 AND sh.status IN ('assigned','confirmed') AND sh.starts_at >= $2::date AND sh.starts_at < $3::date + 1 ORDER BY sh.starts_at, sh.id", [user.id, from, to]);
    return { from, to, shifts: shifts.map((s) => ({ ...s, source_type: 'academy_shift', source_id: s.id, needs_response: s.status === 'assigned' })), sessions: sessions.map((s) => ({ ...s, source_type: 'academy_session', source_id: s.id, needs_response: s.my_status === 'assigned' && s.status === 'published' })), time_off: leave };
  },
});
