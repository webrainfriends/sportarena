// Academics & school integration (#783), part 1: links, consent, the academic timetable and its clash check, attendance summaries,
// coach / school / guardian coordination tasks, the academy overview and the access log. A school is the canonical institution organisation;
// a link points an academy enrolment at it and copies nothing. Every capability asks viewOf() what THIS caller may see of THIS athlete: the
// athlete and their verified guardian see their own record, the school sees what it was granted, the academy sees only what was granted to it and
// only as far as the staff member's own academic permission goes. There is no scout, recruiter or sponsor audience.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { opsAccess } from '../academy-ops.js';
import { guardiansOf, guardianLink } from '../youth.js';
import {
  ITEM_KINDS, SOURCES, SCOPES, SCHOOL_KINDS, consentFor, covers, grantor, maxExpiry, viewOf, linkFor, visibleLink, logRead, sealJson, openJson, overlaps, academicClashes, addDays, ymd,
} from '../academics.js';

const TAG = 'Academics';
const day = z.string().date();
const time = z.string().regex(/^\d{1,2}:\d{2}$/);
const text = (n) => z.string().trim().max(n);
const today = () => new Date().toISOString().slice(0, 10);
const CURRICULA = ['cbse', 'icse', 'state_board', 'ib', 'igcse', 'a_level', 'us_high_school', 'spanish_eso', 'other'];
const ITEM_SEAL = 'academic_items.title';
const TASK_SEAL = 'academic_tasks.note';

const publicLink = (l, extra = {}) => ({ id: l.id, organisation_id: l.organisation_id, enrolment_id: l.enrolment_id, athlete_id: l.athlete_id, athlete_name: l.athlete_name, school: { id: l.school_org_id, name: l.school_name, kind: l.school_kind, verified: l.school_approval === 'approved' },
  provider_kind: l.provider_kind, curriculum: l.curriculum, year_group: l.year_group, liaison_user_id: l.liaison_user_id, starts_on: ymd(l.starts_on), ends_on: ymd(l.ends_on), status: l.status, row_version: l.row_version, ...extra });
const needLead = async (user, orgId, write = false, c) => { const a = await opsAccess(user, orgId, { write, c }); a.need('academics'); return a; };

/** Tell the athlete (and the guardians of a minor) that an academy is asking for, or has linked, their school record. */
async function tellFamily(c, athleteId, orgId, title, body, data = {}) {
  const who = new Set([athleteId, ...(await guardiansOf(athleteId, c)).map((g) => (typeof g === 'string' ? g : g.guardian_id ?? g.id))]);
  for (const u of who) await notify(c, u, { kind: 'academic_consent', title, body, data: { organisation_id: orgId, athlete_id: athleteId, ...data } }).catch(() => null);
}

// ---------------------------------------------------------------------------- links
cap({
  name: 'link_enrolment_to_school', method: 'POST', path: '/organisations/:id/academics/links', tag: TAG, status: 201,
  summary: 'Link an academy enrolment to the school, college or education provider the athlete attends (academic lead or owner/admin). The provider is the canonical institution organisation already on the platform (its identity is never copied); an unverified institution is flagged as such. Linking shares nothing: no timetable, attendance or attainment flows until the athlete (or a minor\'s verified guardian) grants consent, and the athlete and guardians are told. Idempotent per enrolment + provider.',
  input: z.object({ id, enrolment_id: id, school_org_id: id, provider_kind: z.enum(['school', 'college', 'tutoring', 'online_school']).default('school'), curriculum: z.enum(CURRICULA).optional(), year_group: text(30).optional(), student_ref: text(40).optional(),
    liaison_user_id: id.optional(), starts_on: day.optional(), ends_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await needLead(user, i.id, true, c);
    const e = (await c.query("SELECT e.id, e.user_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1 AND k.organisation_id=$2 AND e.status='enrolled'", [i.enrolment_id, i.id])).rows[0];
    if (!e) throw notFound('Enrolment');
    const sc = (await c.query('SELECT id, name, kind, approval_status FROM organisations WHERE id=$1 AND status=\'active\'', [i.school_org_id])).rows[0];
    if (!sc || !SCHOOL_KINDS.includes(sc.kind)) throw badRequest('Choose a school, college or university that is on the platform (create it as an organisation of that type first)');
    if (i.liaison_user_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.school_org_id, i.liaison_user_id])).rowCount) throw badRequest('The liaison must be an active member of the school organisation');
    if (i.ends_on && i.starts_on && i.ends_on < i.starts_on) throw badRequest('The end date is before the start date');
    const prior = (await c.query("SELECT id FROM academic_links WHERE enrolment_id=$1 AND school_org_id=$2 AND provider_kind=$3 AND status='active'", [i.enrolment_id, i.school_org_id, i.provider_kind])).rows[0];
    if (prior) return publicLink(await linkFor(c, prior.id), { replayed: true });
    const row = (await c.query(
      `INSERT INTO academic_links(organisation_id, enrolment_id, athlete_id, school_org_id, provider_kind, curriculum, year_group, student_ref_enc, liaison_user_id, starts_on, ends_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, CURRENT_DATE),$11,$12) RETURNING id`,
      [i.id, e.id, e.user_id, i.school_org_id, i.provider_kind, i.curriculum ?? null, i.year_group ?? null, i.student_ref ? encrypt(i.student_ref, 'academic_links.student_ref') : null, i.liaison_user_id ?? null, i.starts_on ?? null, i.ends_on ?? null, user.id])).rows[0];
    await audit(c, user.id, 'link_enrolment_to_school', 'academic_links', row.id);
    await tellFamily(c, e.user_id, i.id, 'Academic sharing needs your decision', `${sc.name} has been linked to the academy record. Nothing is shared until you choose what to share and for how long.`, { link_id: row.id });
    return publicLink(await linkFor(c, row.id));
  }),
});

const stateOf = (g) => (!g ? 'not_granted' : g.expires_on <= addDays(today(), 30) ? 'expiring' : 'active');
cap({
  name: 'list_academic_links', method: 'GET', path: '/organisations/:id/academics/links', tag: TAG,
  summary: 'Athletes linked to a school, with what the caller may see: consent state, the progress band, whether attendance is below the floor, and the next exam. A coach sees flags only; the academic lead sees the numbers the athlete granted; subject-level grades are never in this list. Filter by school or consent state.',
  input: z.object({ id, school_org_id: id.optional(), consent: z.enum(['active', 'expiring', 'not_granted']).optional(), q: text(60).optional(), include_ended: z.coerce.boolean().default(false), ...page }),
  handler: async ({ user }, i) => {
    const a = await opsAccess(user, i.id);
    if (!(a.has('academics') || a.has('roster') || a.has('attendance') || a.has('schedule'))) throw forbidden('You do not have access to academic information in this academy');
    const links = (await pool.query(
      `SELECT l.*, l.starts_on::text AS starts_on, l.ends_on::text AS ends_on, sc.name AS school_name, sc.kind AS school_kind, sc.approval_status AS school_approval, u.display_name AS athlete_name
         FROM academic_links l JOIN organisations sc ON sc.id=l.school_org_id JOIN users u ON u.id=l.athlete_id
        WHERE l.organisation_id=$1 AND ($2::boolean OR l.status='active') AND ($3::uuid IS NULL OR l.school_org_id=$3) AND ($4::text IS NULL OR u.display_name ILIKE '%'||$4||'%') ORDER BY u.display_name, l.id LIMIT 800`,
      [i.id, i.include_ended, i.school_org_id ?? null, i.q ?? null])).rows;
    const grants = new Map((await pool.query("SELECT *, expires_on::text AS expires_on FROM academic_consents WHERE party_org_id=$1 AND revoked_at IS NULL AND expires_on >= CURRENT_DATE", [i.id])).rows.map((g) => [g.athlete_id, g]));
    const ids = links.map((l) => l.id);
    const snaps = new Map((await pool.query("SELECT DISTINCT ON (s.link_id) s.link_id, s.progress_band, s.term_label FROM academic_snapshots s WHERE s.link_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) ORDER BY s.link_id, s.created_at DESC", [ids])).rows.map((r) => [r.link_id, r]));
    const att = new Map((await pool.query("SELECT DISTINCT ON (x.link_id) x.link_id, x.sessions_total, x.present FROM academic_attendance x WHERE x.link_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=x.id) ORDER BY x.link_id, x.period_to DESC", [ids])).rows.map((r) => [r.link_id, r]));
    const floor = (await pool.query('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL', [i.id])).rows[0].f;
    const exams = (await pool.query("SELECT link_id, min(starts_at) AS next FROM academic_items WHERE link_id = ANY($1) AND kind='exam' AND status='active' AND starts_at > now() GROUP BY 1", [ids])).rows;
    const nextExam = new Map(exams.map((r) => [r.link_id, r.next]));
    const tasks = new Map((await pool.query("SELECT link_id, count(*)::int AS n FROM academic_tasks WHERE link_id = ANY($1) AND status IN ('open','in_progress') GROUP BY 1", [ids])).rows.map((r) => [r.link_id, r.n]));
    const lead = a.has('academics');
    const out = [];
    for (const l of links) {
      const g = grants.get(l.athlete_id) ?? null, state = stateOf(g);
      if (i.consent && state !== i.consent) continue;
      const sn = snaps.get(l.id), at = att.get(l.id);
      const pct = at && at.sessions_total ? Math.round((at.present / at.sessions_total) * 100) : null;
      out.push(publicLink(l, {
        consent: { state, expires_on: g?.expires_on ?? null, scopes: g?.scopes ?? [], detail: g?.detail ?? null },
        band: covers(g, 'attainment') ? sn?.progress_band ?? null : undefined, term: covers(g, 'attainment') ? sn?.term_label ?? null : undefined,
        attendance: covers(g, 'attendance') ? (lead ? { pct } : { below_floor: pct != null && pct < floor }) : undefined,
        next_exam: covers(g, 'timetable') ? nextExam.get(l.id) ?? null : undefined, open_tasks: tasks.get(l.id) ?? 0,
      }));
    }
    return { total: out.length, items: out.slice(i.offset, i.offset + i.limit), floor_pct: floor, can_manage: lead };
  },
});

cap({
  name: 'update_academic_link', method: 'PATCH', path: '/academics/links/:id', tag: TAG,
  summary: 'Change the year group, curriculum, student reference or school liaison of a link, or end it (kept as history; consent for an ended link stops being used). Academic lead or owner/admin; optimistic concurrency via row_version.',
  input: z.object({ id, year_group: text(30).optional(), curriculum: z.enum(CURRICULA).optional(), student_ref: text(40).optional(), liaison_user_id: id.nullable().optional(), ends_on: day.optional(), end: z.boolean().optional(), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const l0 = await linkFor(c, i.id);
    await needLead(user, l0.organisation_id, true, c);
    const l = (await c.query('SELECT * FROM academic_links WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (i.row_version !== undefined && l.row_version !== i.row_version) throw conflict('This link was changed by someone else. Reload and try again.', { row_version: l.row_version });
    if (l.status === 'ended') throw conflict('This link has ended and is read-only');
    if (i.liaison_user_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [l.school_org_id, i.liaison_user_id])).rowCount) throw badRequest('The liaison must be an active member of the school organisation');
    await c.query(`UPDATE academic_links SET year_group=coalesce($2, year_group), curriculum=coalesce($3, curriculum), student_ref_enc=coalesce($4, student_ref_enc), liaison_user_id=CASE WHEN $5::boolean THEN $6 ELSE liaison_user_id END, ends_on=coalesce($7::date, ends_on),
      status=CASE WHEN $8::boolean THEN 'ended' ELSE status END, ended_at=CASE WHEN $8::boolean THEN now() ELSE ended_at END, ended_by=CASE WHEN $8::boolean THEN $9::uuid ELSE ended_by END, row_version=row_version+1 WHERE id=$1`,
      [i.id, i.year_group ?? null, i.curriculum ?? null, i.student_ref ? encrypt(i.student_ref, 'academic_links.student_ref') : null, i.liaison_user_id !== undefined, i.liaison_user_id ?? null, i.ends_on ?? null, !!i.end, user.id]);
    await audit(c, user.id, i.end ? 'end_academic_link' : 'update_academic_link', 'academic_links', i.id);
    return publicLink(await linkFor(c, i.id));
  }),
});

// ---------------------------------------------------------------------------- consent: the athlete (or a minor's verified guardian) decides
cap({
  name: 'grant_academic_consent', method: 'POST', path: '/academics/consents', tag: TAG, status: 201,
  summary: 'Decide what one party may see of an athlete\'s academic record: the academy or the linked school, for which scopes (timetable, attendance, attainment), at what level (summary: blocks / flags / progress band; detail: subject text and subject-level grades), and until when (at most a year; never open-ended). An adult athlete grants for themselves; for a minor only a verified guardian with consent authority can, and the minor cannot. A new grant replaces the previous one for that party. Nothing is shared with anyone else, ever.',
  input: z.object({ athlete_id: id, party_org_id: id, scopes: z.array(z.enum(SCOPES)).min(1).max(3), detail: z.enum(['summary', 'detail']).default('summary'), expires_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const link = (await c.query("SELECT organisation_id, school_org_id FROM academic_links WHERE athlete_id=$1 AND status='active' AND (organisation_id=$2 OR school_org_id=$2) LIMIT 1", [i.athlete_id, i.party_org_id])).rows[0];
    if (!link) throw notFound('Academic link');
    const as = await grantor(c, user, i.athlete_id, link.organisation_id);
    if (!as) throw notFound('Academic link');
    const exp = i.expires_on ?? addDays(today(), 180);
    if (exp < today() || exp > maxExpiry()) throw badRequest('Choose an end date within the next year');
    await c.query('UPDATE academic_consents SET revoked_at=now(), revoked_by=$3 WHERE athlete_id=$1 AND party_org_id=$2 AND revoked_at IS NULL', [i.athlete_id, i.party_org_id, user.id]);
    const row = (await c.query("INSERT INTO academic_consents(athlete_id, party_org_id, party_role, scopes, detail, granted_by, granted_as, expires_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, expires_on::text AS expires_on",
      [i.athlete_id, i.party_org_id, link.organisation_id === i.party_org_id ? 'academy' : 'school', i.scopes, i.detail, user.id, as, exp])).rows[0];
    await audit(c, user.id, 'grant_academic_consent', 'academic_consents', row.id);
    return row;
  }),
});

cap({
  name: 'revoke_academic_consent', method: 'POST', path: '/academics/consents/:id/revoke', tag: TAG,
  summary: 'Withdraw academic consent for a party at any moment (the athlete, or a minor\'s verified guardian). The party sees nothing from that moment; what was already recorded is kept but hidden from them. Clash checks stop using the timetable at once.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const g = (await c.query('SELECT * FROM academic_consents WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [i.id])).rows[0];
    if (!g) throw notFound('Consent');
    const link = (await c.query('SELECT organisation_id FROM academic_links WHERE athlete_id=$1 AND (organisation_id=$2 OR school_org_id=$2) LIMIT 1', [g.athlete_id, g.party_org_id])).rows[0];
    const as = await grantor(c, user, g.athlete_id, link?.organisation_id).catch(() => null);
    if (!as) throw notFound('Consent');
    await c.query('UPDATE academic_consents SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [i.id, user.id]);
    await audit(c, user.id, 'revoke_academic_consent', 'academic_consents', i.id);
    return { revoked: true };
  }),
});

cap({
  name: 'list_my_academic_consents', method: 'GET', path: '/me/academics/consents', tag: TAG,
  summary: 'The academic sharing choices for the signed-in athlete, or for a child they are a verified guardian of (pass athlete_id): each linked school and academy, what is shared with whom, until when, and how many times it was read. This is where the athlete or guardian grants, changes or withdraws.',
  input: z.object({ athlete_id: id.optional() }),
  handler: async ({ user }, i) => {
    // no athlete_id: the caller's own record plus every young person they are a verified guardian of
    let targets;
    if (i.athlete_id) { if (i.athlete_id !== user.id && !(await guardianLink(user.id, i.athlete_id))) throw notFound('Athlete'); targets = [i.athlete_id]; }
    else targets = [user.id, ...(await pool.query("SELECT child_id FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id])).rows.map((r) => r.child_id)];
    const target = targets;
    const links = (await pool.query(
      `SELECT l.*, l.starts_on::text AS starts_on, l.ends_on::text AS ends_on, sc.name AS school_name, sc.kind AS school_kind, sc.approval_status AS school_approval, ac.name AS academy_name, u.display_name AS athlete_name
         FROM academic_links l JOIN organisations sc ON sc.id=l.school_org_id JOIN organisations ac ON ac.id=l.organisation_id JOIN users u ON u.id=l.athlete_id WHERE l.athlete_id = ANY($1) AND l.status='active' ORDER BY u.display_name, ac.name, sc.name`, [target])).rows;
    const grants = (await pool.query("SELECT *, expires_on::text AS expires_on FROM academic_consents WHERE athlete_id = ANY($1) AND revoked_at IS NULL AND expires_on >= CURRENT_DATE", [target])).rows;
    const reads = (await pool.query("SELECT organisation_id, actor_side, count(*)::int AS n, max(at) AS last FROM academic_access_log WHERE athlete_id = ANY($1) AND at > now() - interval '90 days' GROUP BY 1,2", [target])).rows;
    return links.map((l) => ({ link: publicLink(l), academy: { id: l.organisation_id, name: l.academy_name }, parties: [
      { role: 'academy', org_id: l.organisation_id, name: l.academy_name, consent: grants.find((g) => g.athlete_id === l.athlete_id && g.party_org_id === l.organisation_id) ?? null, reads_90d: reads.filter((r) => r.organisation_id === l.organisation_id && r.actor_side === 'academy').reduce((n, r) => n + r.n, 0) },
      { role: 'school', org_id: l.school_org_id, name: l.school_name, consent: grants.find((g) => g.athlete_id === l.athlete_id && g.party_org_id === l.school_org_id) ?? null, reads_90d: reads.filter((r) => r.actor_side === 'school' && r.organisation_id === l.school_org_id).reduce((n, r) => n + r.n, 0) },
    ] }));
  },
});

cap({
  name: 'request_academic_consent', method: 'POST', path: '/academics/links/:id/consent-request', tag: TAG, status: 201,
  summary: 'Ask the athlete (and a minor\'s guardians) to decide on academic sharing for this link: they get a notification and the request appears in their sharing choices. Academic lead or owner/admin. It grants nothing.',
  input: z.object({ id, message: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const l = await linkFor(c, i.id);
    await needLead(user, l.organisation_id, true, c);
    await tellFamily(c, l.athlete_id, l.organisation_id, 'Academic sharing needs your decision', i.message ?? `${l.school_name} is linked to the academy record. Choose what to share, with whom and for how long.`, { link_id: l.id });
    await audit(c, user.id, 'request_academic_consent', 'academic_links', l.id);
    return { requested: true };
  }),
});

// ---------------------------------------------------------------------------- the academic timetable
const ITEM = z.object({
  kind: z.enum(ITEM_KINDS), title: text(120).optional(), starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), start_time: time.optional(), end_time: time.optional(), from_on: day.optional(), to_on: day.optional(), timezone: text(60).default('UTC'),
  high_stakes: z.boolean().default(false), blocks_sport: z.boolean().default(true), source_ref: text(120).optional(),
}).superRefine((v, ctx) => {
  const one = v.starts_at && v.ends_at && !v.weekdays, weekly = !v.starts_at && v.weekdays && v.start_time && v.end_time && v.from_on;
  if (!one && !weekly) ctx.addIssue({ code: 'custom', message: 'Give either a start and end, or weekdays with times and a first date' });
  if (one && new Date(v.ends_at) <= new Date(v.starts_at)) ctx.addIssue({ code: 'custom', message: 'The end is before the start' });
  if (weekly && v.end_time <= v.start_time) ctx.addIssue({ code: 'custom', message: 'The end time is before the start time' });
  if (v.kind === 'exam' && weekly) ctx.addIssue({ code: 'custom', message: 'An exam is a single sitting: give its start and end' });
});

/** Can the caller write timetable data for this link, and as which source? Athlete / guardian: unverified; school and the academic lead: verified entry. */
function writer(v, scope) {
  if (v.side === 'athlete' || v.side === 'guardian') return { source: 'athlete_entered', verified: false };
  if (v.side === 'school' && v.record && v[scope] !== 'none') return { source: 'manual_verified', verified: true };
  if (v.side === 'academy' && v.record && v[scope] !== 'none') return { source: 'manual_verified', verified: true };
  throw forbidden(v.grant ? 'You are not allowed to record this' : 'The athlete has not granted this to you yet');
}
const occurrenceSessions = async (c, link, items) => {
  const out = [];
  const sessions = (await c.query("SELECT s.id, s.title, s.starts_at, s.ends_at, s.status FROM academic_links l JOIN org_enrolments e ON e.id=l.enrolment_id JOIN academy_sessions s ON s.cohort_id=e.cohort_id WHERE l.id=$1 AND s.status IN ('draft','published') AND s.ends_at > now() ORDER BY s.starts_at LIMIT 400", [link.id])).rows;
  for (const s of sessions) if (items.some((it) => overlaps({ ...it, timezone: it.timezone ?? 'UTC' }, new Date(s.starts_at), new Date(s.ends_at)))) out.push({ session_id: s.id, title: s.title, starts_at: s.starts_at, status: s.status });
  return out;
};

/** The one writer of timetable items (interactive entry and imports share it): sources and verification follow who is writing. */
export async function saveItems(c, l, v, w, user, items) {
  const created = [];
  for (const it of items) {
      const r = (await c.query(
        `INSERT INTO academic_items(link_id, kind, title_enc, starts_at, ends_at, weekdays, start_time, end_time, from_on, to_on, timezone, high_stakes, blocks_sport, source, source_org_id, source_ref, verified_by, verified_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *, from_on::text AS from_on, to_on::text AS to_on, start_time::text AS start_time, end_time::text AS end_time`,
        [l.id, it.kind, it.title ? encrypt(it.title, ITEM_SEAL) : null, it.starts_at ?? null, it.ends_at ?? null, it.weekdays ?? null, it.start_time ?? null, it.end_time ?? null, it.from_on ?? null, it.to_on ?? null, it.timezone, it.high_stakes, it.kind === 'holiday' ? false : it.blocks_sport,
          w.source, v.side === 'school' ? l.school_org_id : null, it.source_ref ?? null, w.verified ? user.id : null, w.verified ? new Date() : null, user.id])).rows[0];
      created.push(r);
  }
  return created;
}

cap({
  name: 'add_academic_items', method: 'POST', path: '/academics/links/:id/items', tag: TAG, status: 201,
  summary: 'Add school-day blocks, exams, tutoring, school events, holidays or deadlines to an athlete\'s academic timetable: one-off (start and end) or weekly (weekdays, times and dates). The school and the academic lead record verified entries (needs the athlete\'s timetable consent); the athlete or guardian may add their own, marked unverified. The subject text is encrypted. The response lists the academy sessions that would clash, so a clash is seen before schedule publication, not after.',
  input: z.object({ id, items: z.array(ITEM).min(1).max(60) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await visibleLink(c, user, i.id);
    if (l.status !== 'active') throw conflict('This link has ended');
    const w = writer(v, 'timetable');
    const created = await saveItems(c, l, v, w, user, i.items);
    await audit(c, user.id, 'add_academic_items', 'academic_links', l.id);
    return { created: created.map((r) => ({ id: r.id, kind: r.kind, source: r.source, verified: !!r.verified_at })), clashes: await occurrenceSessions(c, l, created) };
  }),
});

cap({
  name: 'update_academic_item', method: 'PATCH', path: '/academics/items/:id', tag: TAG,
  summary: 'Reschedule or cancel an academic timetable item, or change whether it blocks sport (the school, the academic lead, or the athlete/guardian for their own entries). Letting sport override a high-stakes exam is not possible: an exam flagged high-stakes always blocks. Every change is audit-logged.',
  input: z.object({ id, starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(), blocks_sport: z.boolean().optional(), cancel: z.boolean().optional(), high_stakes: z.boolean().optional(), reason: text(200).optional(), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const it = (await c.query('SELECT * FROM academic_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!it) throw notFound('Item');
    const { l, v } = await visibleLink(c, user, it.link_id);
    const w = writer(v, 'timetable');
    if (!w.verified && it.source !== 'athlete_entered') throw forbidden('Only the school or the academic lead can change a verified entry');
    if (i.row_version !== undefined && it.row_version !== i.row_version) throw conflict('This item was changed by someone else.', { row_version: it.row_version });
    if (i.blocks_sport === false && (it.high_stakes || i.high_stakes) && it.kind === 'exam') throw badRequest('A high-stakes exam always blocks sport');
    if (i.blocks_sport === false && !i.reason) throw badRequest('Say why sport may overlap this (it is recorded)');
    const sets = { starts_at: i.starts_at, ends_at: i.ends_at, blocks_sport: i.blocks_sport, high_stakes: i.high_stakes, status: i.cancel ? 'cancelled' : undefined };
    const keys = Object.keys(sets).filter((k) => sets[k] !== undefined);
    if (!keys.length) return { id: it.id };
    if (keys.includes('starts_at') !== keys.includes('ends_at')) throw badRequest('Give both the new start and end');
    await c.query(`UPDATE academic_items SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')}, row_version=row_version+1 WHERE id=$1`, [it.id, ...keys.map((k) => sets[k])]);
    await audit(c, user.id, i.cancel ? 'cancel_academic_item' : 'update_academic_item', 'academic_items', it.id);
    const fresh = (await c.query('SELECT *, from_on::text AS from_on, to_on::text AS to_on, start_time::text AS start_time, end_time::text AS end_time FROM academic_items WHERE id=$1', [it.id])).rows[0];
    return { id: it.id, status: fresh.status, clashes: i.cancel ? [] : await occurrenceSessions(c, l, [fresh]) };
  }),
});

const SOURCE_LABEL = { manual_verified: 'Verified entry', partner_import: 'Partner import', partner_api: 'Partner API', athlete_entered: 'Entered by the athlete (unverified)' };
cap({
  name: 'list_academic_timetable', method: 'GET', path: '/academics/links/:id/timetable', tag: TAG,
  summary: 'The athlete\'s academic timetable for a date range (at most 92 days), expanded into dated occurrences, each with its source and whether it is verified. The athlete, guardian, school and the academic lead (with detail consent) see the subject text; academy staff with schedule access see only the kind and the time. Reads are recorded in the access log.',
  input: z.object({ id, from: day.default(() => today()), to: day.optional() }),
  handler: async ({ user }, i) => {
    const { l, v } = await visibleLink(pool, user, i.id);
    if (v.timetable === 'none') throw forbidden('No timetable has been shared with you');
    const to = i.to ?? addDays(i.from, 30);
    if (to < i.from || new Date(to) - new Date(i.from) > 92 * 864e5) throw badRequest('Choose a range of at most 92 days');
    const items = (await pool.query("SELECT i.*, i.from_on::text AS from_on, i.to_on::text AS to_on, i.start_time::text AS start_time, i.end_time::text AS end_time, o.name AS source_name FROM academic_items i LEFT JOIN organisations o ON o.id=i.source_org_id WHERE i.link_id=$1 AND i.status='active'", [l.id])).rows;
    const out = [];
    for (const it of items) {
      const base = { item_id: it.id, kind: it.kind, high_stakes: it.high_stakes, blocks_sport: it.blocks_sport, source: it.source, source_label: SOURCE_LABEL[it.source] + (it.source_name ? ` · ${it.source_name}` : ''), verified: !!it.verified_at, title: v.timetable === 'full' ? (it.title_enc ? decrypt(it.title_enc, ITEM_SEAL) : null) : undefined };
      if (it.starts_at) { if (ymd(it.starts_at) >= i.from && ymd(it.starts_at) <= to) out.push({ ...base, starts_at: it.starts_at, ends_at: it.ends_at }); continue; }
      for (let d = i.from; d <= to; d = addDays(d, 1)) {
        const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
        if (it.weekdays.includes(wd) && d >= it.from_on && d <= (it.to_on ?? '9999-12-31')) out.push({ ...base, date: d, start_time: it.start_time, end_time: it.end_time, timezone: it.timezone });
      }
    }
    await logRead(pool, l.athlete_id, v.side === 'school' ? l.school_org_id : l.organisation_id, user, v.side, 'timetable', v.timetable === 'full' ? 'detail' : 'summary');
    return { link: publicLink(l), view: v.timetable, items: out.sort((x, y) => String(x.starts_at ?? `${x.date}T${x.start_time}`).localeCompare(String(y.starts_at ?? `${y.date}T${y.start_time}`))).slice(0, 600) };
  },
});

cap({
  name: 'check_academic_clashes', method: 'GET', path: '/organisations/:id/academics/clashes', tag: TAG,
  summary: 'Sport-study clashes before the academy schedule is published. Without starts_at/ends_at: every draft and published session in the window (default the next 21 days) that overlaps a consented school exam, lesson block or tutoring session of someone in its group. With starts_at, ends_at and cohort_id: the same check for a session you are about to create. Staff see the athlete, the kind of commitment and the time, never the subject or any grade. Needs schedule or academic access.',
  input: z.object({ id, from: day.optional(), to: day.optional(), cohort_id: id.optional(), starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional() }),
  handler: async ({ user }, i) => {
    const a = await opsAccess(user, i.id);
    if (!(a.has('schedule') || a.has('academics'))) throw forbidden('You need schedule or academic access to check clashes');
    if (i.starts_at) {
      if (!i.cohort_id || !i.ends_at) throw badRequest('Give cohort_id, starts_at and ends_at');
      const k = (await pool.query('SELECT id FROM org_cohorts WHERE id=$1 AND organisation_id=$2', [i.cohort_id, i.id])).rows[0];
      if (!k) throw notFound('Cohort');
      const clashes = await academicClashes(pool, { cohort_id: i.cohort_id, organisation_id: i.id, starts_at: i.starts_at, ends_at: i.ends_at });
      return { clashes, publishable: clashes.length === 0 };
    }
    const from = i.from ?? today(), to = i.to ?? addDays(from, 21);
    const sessions = (await pool.query("SELECT * FROM academy_sessions WHERE organisation_id=$1 AND status IN ('draft','published') AND starts_at >= $2::date AND starts_at < $3::date + 1 ORDER BY starts_at LIMIT 300", [i.id, from, to])).rows;
    const out = [];
    for (const s of sessions) { const clashes = await academicClashes(pool, s); if (clashes.length) out.push({ session_id: s.id, title: s.title, cohort_id: s.cohort_id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, clashes }); }
    return { from, to, checked: sessions.length, sessions: out };
  },
});

cap({
  name: 'list_academic_calendar', method: 'GET', path: '/organisations/:id/academics/calendar', tag: TAG,
  summary: 'The consented school commitments of the academy\'s linked athletes over a window (default the next 30 days), for planning: who has an exam or a lesson block when. Staff see the athlete, the kind and the time; the subject only for the academic lead with detail consent. Needs schedule or academic access.',
  input: z.object({ id, from: day.optional(), to: day.optional(), kind: z.enum(ITEM_KINDS).optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await opsAccess(user, i.id);
    if (!(a.has('schedule') || a.has('academics'))) throw forbidden('You need schedule or academic access to see the school calendar');
    const from = i.from ?? today(), to = i.to ?? addDays(from, 30);
    const rows = (await pool.query(
      `SELECT i.*, i.from_on::text AS from_on, i.to_on::text AS to_on, i.start_time::text AS start_time, i.end_time::text AS end_time, u.display_name AS athlete_name, l.athlete_id, g.detail AS consent_detail
         FROM academic_items i JOIN academic_links l ON l.id=i.link_id JOIN users u ON u.id=l.athlete_id
         JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE AND 'timetable' = ANY(g.scopes)
        WHERE l.organisation_id=$1 AND l.status='active' AND i.status='active' AND ($2::text IS NULL OR i.kind=$2) LIMIT 4000`, [i.id, i.kind ?? null])).rows;
    const out = [];
    for (const it of rows) {
      const base = { item_id: it.id, link_id: it.link_id, athlete_id: it.athlete_id, athlete_name: it.athlete_name, kind: it.kind, high_stakes: it.high_stakes, blocks_sport: it.blocks_sport, verified: !!it.verified_at, title: a.has('academics') && it.consent_detail === 'detail' ? (it.title_enc ? decrypt(it.title_enc, ITEM_SEAL) : null) : undefined };
      if (it.starts_at) { if (ymd(it.starts_at) >= from && ymd(it.starts_at) <= to) out.push({ ...base, starts_at: it.starts_at, ends_at: it.ends_at }); continue; }
      for (let d = from; d <= to; d = addDays(d, 1)) if (it.weekdays.includes(new Date(`${d}T12:00:00Z`).getUTCDay()) && d >= it.from_on && d <= (it.to_on ?? '9999-12-31')) out.push({ ...base, date: d, start_time: it.start_time, end_time: it.end_time });
    }
    out.sort((x, y) => String(x.starts_at ?? `${x.date}T${x.start_time}`).localeCompare(String(y.starts_at ?? `${y.date}T${y.start_time}`)));
    return { from, to, total: out.length, items: out.slice(i.offset, i.offset + i.limit) };
  },
});

// ---------------------------------------------------------------------------- attendance summaries (period totals only)
const pctOf = (r) => (r.sessions_total ? Math.round((r.present / r.sessions_total) * 1000) / 10 : null);
export async function raiseTask(c, t) {
  const row = (await c.query(
    `INSERT INTO academic_tasks(organisation_id, link_id, kind, title, reason_code, due_on, note_enc, source_type, source_id, dedupe_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (organisation_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('open','in_progress') DO NOTHING RETURNING id`,
    [t.organisation_id, t.link_id, t.kind, t.title, t.reason_code ?? null, t.due_on ?? null, t.note ? encrypt(t.note, TASK_SEAL) : null, t.source_type ?? null, t.source_id ?? null, t.dedupe_key ?? null, t.created_by ?? null])).rows[0];
  if (!row) return null;
  for (const p of t.people ?? []) await c.query('INSERT INTO academic_task_people(task_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, p.user_id, p.role]);
  for (const p of t.people ?? []) await notify(c, p.user_id, { kind: 'academic_task', title: 'Academic coordination needed', body: t.title, data: { organisation_id: t.organisation_id, task_id: row.id } }).catch(() => null);
  return row.id;
}
/** Who should hear about a task on this link: the academic leads, the cohort's coach, the school liaison and (for a minor) the guardians. Names only; no grades are ever part of a task. */
export async function peopleFor(c, l) {
  const out = [];
  const leads = (await c.query("SELECT user_id FROM org_staff_engagements WHERE organisation_id=$1 AND state='active' AND 'academics' = ANY(permissions)", [l.organisation_id])).rows;
  for (const r of leads) out.push({ user_id: r.user_id, role: 'academic_lead' });
  const coach = (await c.query('SELECT k.coach_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [l.enrolment_id])).rows[0]?.coach_id;
  if (coach) out.push({ user_id: coach, role: 'coach' });
  if (l.liaison_user_id) out.push({ user_id: l.liaison_user_id, role: 'school_liaison' });
  for (const g of await guardiansOf(l.athlete_id, c)) out.push({ user_id: typeof g === 'string' ? g : g.guardian_id ?? g.id, role: 'guardian' });
  return out;
}

/** The one writer of an attendance summary (interactive entry and imports share it): validates the totals, versions a correction, and raises the exception task once. */
export async function saveAttendance(c, l, v, w, user, i) {
  if (i.period_to < i.period_from) throw badRequest('The period ends before it starts');
  if (i.present + i.authorised_absent + i.unauthorised_absent > i.sessions_total) throw badRequest('Present plus absences cannot exceed the sessions in the period');
  if (i.late > i.present) throw badRequest('Late arrivals are counted within present');
  const prev = (await c.query('SELECT id, version FROM academic_attendance WHERE link_id=$1 AND period_from=$2 AND period_to=$3 AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=academic_attendance.id) ORDER BY version DESC LIMIT 1', [l.id, i.period_from, i.period_to])).rows[0];
  const row = (await c.query(
    `INSERT INTO academic_attendance(link_id, period_from, period_to, sessions_total, present, late, authorised_absent, unauthorised_absent, version, supersedes_id, source, source_org_id, source_ref, verified_by, verified_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$14) RETURNING *`,
    [l.id, i.period_from, i.period_to, i.sessions_total, i.present, i.late, i.authorised_absent, i.unauthorised_absent, (prev?.version ?? 0) + 1, prev?.id ?? null, v.side === 'school' ? 'manual_verified' : w.source, v.side === 'school' ? l.school_org_id : null, i.source_ref ?? null, user.id])).rows[0];
  await audit(c, user.id, 'record_academic_attendance', 'academic_links', l.id);
  const floor = (await c.query('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL', [l.organisation_id])).rows[0].f;
  const pct = pctOf(row);
  let task = null;
  if (pct != null && (pct < floor || row.unauthorised_absent / row.sessions_total > 0.05)) {
    task = await raiseTask(c, { organisation_id: l.organisation_id, link_id: l.id, kind: 'attendance_exception', title: `School attendance below the expected level for ${l.athlete_name}`, reason_code: row.unauthorised_absent / row.sessions_total > 0.05 ? 'unauthorised_absence' : 'low_attendance', due_on: addDays(today(), 7),
      source_type: 'academic_attendance', source_id: row.id, dedupe_key: `att:${l.id}`, people: await peopleFor(c, l) });
  }
  return { id: row.id, version: row.version, attendance_pct: pct, below_floor: pct != null && pct < floor, floor_pct: floor, task_id: task };
}

cap({
  name: 'record_academic_attendance', method: 'POST', path: '/academics/links/:id/attendance', tag: TAG, status: 201,
  summary: 'Record a school attendance SUMMARY for a period (totals only: sessions, present, late, authorised and unauthorised absence; no day-by-day record is kept). The school and the academic lead record verified summaries (needs the athlete\'s attendance consent); a correction for the same period is a new version and the earlier one is kept. A summary below the academy\'s attendance floor raises an attendance-exception task for the coach, the school liaison and the guardian, automatically and only once.',
  input: z.object({ id, period_from: day, period_to: day, sessions_total: z.number().int().min(1).max(2000), present: z.number().int().min(0), late: z.number().int().min(0).default(0), authorised_absent: z.number().int().min(0).default(0), unauthorised_absent: z.number().int().min(0).default(0), source_ref: text(120).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await visibleLink(c, user, i.id);
    if (v.side === 'athlete' || v.side === 'guardian') throw forbidden('Attendance is recorded by the school or the academic lead');
    const w = writer(v, 'attendance');
    return saveAttendance(c, l, v, w, user, i);
  }),
});

cap({
  name: 'list_academic_attendance', method: 'GET', path: '/academics/links/:id/attendance', tag: TAG,
  summary: 'School attendance summaries for a link, newest first, each with its source and version. The athlete, guardian, school and the academic lead see the numbers; other academy staff see only whether the latest summary is below the floor. Reads are recorded.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { l, v } = await visibleLink(pool, user, i.id);
    if (v.attendance === 'none') throw forbidden('No attendance has been shared with you');
    const rows = (await pool.query("SELECT x.*, x.period_from::text AS period_from, x.period_to::text AS period_to, o.name AS source_name FROM academic_attendance x LEFT JOIN organisations o ON o.id=x.source_org_id WHERE x.link_id=$1 AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=x.id) ORDER BY x.period_to DESC LIMIT 24", [l.id])).rows;
    const floor = (await pool.query('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL', [l.organisation_id])).rows[0].f;
    await logRead(pool, l.athlete_id, v.side === 'school' ? l.school_org_id : l.organisation_id, user, v.side, 'attendance');
    if (v.attendance === 'flag') return { view: 'flag', floor_pct: floor, below_floor: rows.length ? pctOf(rows[0]) < floor : null, latest_period: rows[0] ? { from: rows[0].period_from, to: rows[0].period_to } : null };
    return { view: 'summary', floor_pct: floor, items: rows.map((r) => ({ id: r.id, period_from: r.period_from, period_to: r.period_to, sessions_total: r.sessions_total, present: r.present, late: r.late, authorised_absent: r.authorised_absent, unauthorised_absent: r.unauthorised_absent, pct: pctOf(r), version: r.version, verified: !!r.verified_at, source: r.source, source_label: SOURCE_LABEL[r.source] + (r.source_name ? ` · ${r.source_name}` : ''), source_ref: r.source_ref })) };
  },
});

// ---------------------------------------------------------------------------- coordination tasks (coach / school / guardian), never grades
const TASK_KINDS = ['exam_clash', 'attendance_exception', 'coach_school_sync', 'guardian_meeting', 'tutoring', 'report_due', 'other'];
const REASONS = ['clash_with_exam', 'clash_with_class', 'low_attendance', 'unauthorised_absence', 'late_pattern', 'report_overdue', 'needs_support', 'other'];
cap({
  name: 'create_academic_task', method: 'POST', path: '/academics/links/:id/tasks', tag: TAG, status: 201,
  summary: 'Open a coordination task about an athlete between the coach, the school liaison, the guardian and the academic lead: a clash to resolve, an attendance exception, a coach-school sync, a guardian meeting, tutoring, an overdue report. Tasks carry a reason code and dates, never grades; the free note is encrypted. Participants are told. Academic lead or owner/admin, or the school liaison.',
  input: z.object({ id, kind: z.enum(TASK_KINDS), title: text(120).min(3), reason_code: z.enum(REASONS).optional(), due_on: day.optional(), note: text(1000).optional(), people: z.array(z.enum(['academic_lead', 'coach', 'school_liaison', 'guardian'])).default(['academic_lead', 'coach']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await visibleLink(c, user, i.id);
    if (!(v.side === 'academy' && v.manage) && v.side !== 'school') throw forbidden('Only the academic lead or the school can open an academic task');
    const all = await peopleFor(c, l);
    const people = all.filter((p) => i.people.includes(p.role) && p.user_id !== user.id);
    const id_ = await raiseTask(c, { organisation_id: l.organisation_id, link_id: l.id, kind: i.kind, title: i.title, reason_code: i.reason_code, due_on: i.due_on, note: i.note, created_by: user.id, people });
    await audit(c, user.id, 'create_academic_task', 'academic_tasks', id_);
    return { id: id_ };
  }),
});

async function taskAccess(c, user, taskId) {
  const t = (await c.query('SELECT t.*, t.due_on::text AS due_on, l.athlete_id, l.school_org_id, l.organisation_id AS org, u.display_name AS athlete_name FROM academic_tasks t JOIN academic_links l ON l.id=t.link_id JOIN users u ON u.id=l.athlete_id WHERE t.id=$1', [taskId])).rows[0];
  if (!t) throw notFound('Task');
  const mine = (await c.query('SELECT role FROM academic_task_people WHERE task_id=$1 AND user_id=$2', [taskId, user.id])).rows.map((r) => r.role);
  let lead = false; try { lead = (await opsAccess(user, t.org, { c })).has('academics'); } catch { /* not academy staff */ }
  const school = (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [t.school_org_id, user.id])).rowCount > 0;
  if (!(mine.length || lead || isAdmin(user) || (school && mine.length))) throw notFound('Task');
  return { t, lead: lead || isAdmin(user), mine };
}

cap({
  name: 'list_academic_tasks', method: 'GET', path: '/organisations/:id/academics/tasks', tag: TAG,
  summary: 'Coordination tasks for the academy: the academic lead sees all; a coach or any participant sees the tasks they are part of. Filter by status or kind. Titles, reason codes and dates only; the encrypted note is opened one task at a time.',
  input: z.object({ id, status: z.enum(['open', 'in_progress', 'done', 'cancelled', 'active']).default('active'), kind: z.enum(TASK_KINDS).optional(), mine: z.coerce.boolean().default(false), ...page }),
  handler: async ({ user }, i) => {
    let lead = false; try { lead = (await opsAccess(user, i.id)).has('academics'); } catch { /* participant outside the academy */ }
    const rows = (await pool.query(
      `SELECT t.id, t.kind, t.title, t.reason_code, t.due_on::text AS due_on, t.status, t.created_at, l.id AS link_id, u.display_name AS athlete_name,
              (SELECT coalesce(json_agg(json_build_object('user_id', p.user_id, 'role', p.role, 'name', pu.display_name)), '[]') FROM academic_task_people p JOIN users pu ON pu.id=p.user_id WHERE p.task_id=t.id) AS people,
              (SELECT count(*)::int FROM academic_task_messages m WHERE m.task_id=t.id) AS messages
         FROM academic_tasks t JOIN academic_links l ON l.id=t.link_id JOIN users u ON u.id=l.athlete_id
        WHERE t.organisation_id=$1 AND (($2::text = 'active' AND t.status IN ('open','in_progress')) OR t.status=$2) AND ($3::text IS NULL OR t.kind=$3)
          AND ($4::boolean OR EXISTS (SELECT 1 FROM academic_task_people p WHERE p.task_id=t.id AND p.user_id=$5))
        ORDER BY t.due_on NULLS LAST, t.created_at DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status, i.kind ?? null, lead && !i.mine, user.id, i.limit, i.offset])).rows;
    if (!lead && !rows.length && !(await pool.query('SELECT 1 FROM academic_task_people p JOIN academic_tasks t ON t.id=p.task_id WHERE t.organisation_id=$1 AND p.user_id=$2 LIMIT 1', [i.id, user.id])).rowCount) {
      if (!isAdmin(user)) throw notFound('Organisation');
    }
    return rows.map((r) => ({ ...r, overdue: r.due_on && r.due_on < today() && ['open', 'in_progress'].includes(r.status) }));
  },
});

cap({
  name: 'get_academic_task', method: 'GET', path: '/academics/tasks/:id', tag: TAG,
  summary: 'One coordination task with its participants, its encrypted note and the message thread (participants and the academic lead only; reading is audit-logged).',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { t, lead, mine } = await taskAccess(pool, user, i.id);
    const people = (await pool.query('SELECT p.user_id, p.role, u.display_name FROM academic_task_people p JOIN users u ON u.id=p.user_id WHERE p.task_id=$1 ORDER BY p.role', [t.id])).rows;
    const msgs = (await pool.query('SELECT m.id, m.created_at, m.author_id, u.display_name, m.body_enc FROM academic_task_messages m JOIN users u ON u.id=m.author_id WHERE m.task_id=$1 ORDER BY m.created_at', [t.id])).rows;
    await audit(pool, user.id, 'read_academic_task', 'academic_tasks', t.id);
    return { id: t.id, kind: t.kind, title: t.title, reason_code: t.reason_code, due_on: t.due_on, status: t.status, athlete_name: t.athlete_name, link_id: t.link_id, note: t.note_enc ? decrypt(t.note_enc, TASK_SEAL) : null, people,
      messages: msgs.map((m) => ({ id: m.id, at: m.created_at, author_id: m.author_id, author: m.display_name, body: decrypt(m.body_enc, 'academic_task_messages.body') })), can_manage: lead || mine.length > 0 };
  },
});

cap({
  name: 'update_academic_task', method: 'PATCH', path: '/academics/tasks/:id', tag: TAG,
  summary: 'Move a task along (in progress, done, cancelled), change its due date, or add a message to the thread (participants and the academic lead). Messages are encrypted. Closing records who and when.',
  input: z.object({ id, status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), due_on: day.optional(), message: text(1000).optional(), row_version: z.number().int().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { t } = await taskAccess(c, user, i.id);
    if (i.row_version !== undefined && t.row_version !== i.row_version) throw conflict('This task was changed by someone else.', { row_version: t.row_version });
    if (['done', 'cancelled'].includes(t.status) && i.status && i.status !== t.status) throw conflict('This task is closed');
    if (i.message) await c.query('INSERT INTO academic_task_messages(task_id, author_id, body_enc) VALUES ($1,$2,$3)', [t.id, user.id, encrypt(i.message, 'academic_task_messages.body')]);
    await c.query(`UPDATE academic_tasks SET status=coalesce($2, status), due_on=coalesce($3::date, due_on), closed_at=CASE WHEN $2 IN ('done','cancelled') THEN now() ELSE closed_at END, closed_by=CASE WHEN $2 IN ('done','cancelled') THEN $4::uuid ELSE closed_by END, row_version=row_version+1 WHERE id=$1`, [t.id, i.status ?? null, i.due_on ?? null, user.id]);
    await audit(c, user.id, 'update_academic_task', 'academic_tasks', t.id);
    return { id: t.id, status: i.status ?? t.status };
  }),
});

/** Turn clashes on upcoming sessions and low attendance into tasks, once each (dedupe keys), for the people who can resolve them. */
export async function scanAcademicExceptions(c, orgId) {
  let made = 0;
  const from = today(), to = addDays(from, 21);
  const sessions = (await c.query("SELECT * FROM academy_sessions WHERE organisation_id=$1 AND status IN ('draft','published') AND starts_at >= $2::date AND starts_at < $3::date + 1 ORDER BY starts_at LIMIT 300", [orgId, from, to])).rows;
  for (const s of sessions) for (const cl of await academicClashes(c, s)) {
    const l = await linkFor(c, cl.link_id);
    const id_ = await raiseTask(c, { organisation_id: orgId, link_id: l.id, kind: 'exam_clash', title: `Sport session clashes with school: ${l.athlete_name}`, reason_code: cl.code.includes('exam') ? 'clash_with_exam' : 'clash_with_class', due_on: ymd(s.starts_at) > today() ? addDays(ymd(s.starts_at), -1) : today(),
      source_type: 'academic_item', source_id: cl.source_id, dedupe_key: `clash:${cl.source_id}:${s.id}`, people: (await peopleFor(c, l)).filter((p) => ['academic_lead', 'coach'].includes(p.role)) });
    if (id_) made++;
  }
  return made;
}
cap({
  name: 'scan_academic_exceptions', method: 'POST', path: '/organisations/:id/academics/exceptions/scan', tag: TAG,
  summary: 'Raise coordination tasks for the sport-study clashes on upcoming sessions (next 21 days). Safe to repeat: each clash becomes one task for the academic lead and the coach. The same scan runs in the background.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => { await needLead(user, i.id, true, c); return { raised: await scanAcademicExceptions(c, i.id) }; }),
});
export async function runAcademicSweeps() {
  const orgs = (await pool.query("SELECT DISTINCT organisation_id FROM academic_links WHERE status='active'")).rows;
  let n = 0;
  for (const o of orgs) await tx(async (c) => { n += await scanAcademicExceptions(c, o.organisation_id); });
  return n;
}

// ---------------------------------------------------------------------------- overview and the athlete's own access log
cap({
  name: 'get_academics_overview', method: 'GET', path: '/organisations/:id/academics/overview', tag: TAG,
  summary: 'The academic operating picture for the academy (academic lead or owner/admin): how many enrolled athletes are linked to a school and how many have granted consent, consents about to expire, exams in the next 14 days, sport-study clashes on upcoming sessions, attendance below the floor, progress bands (only for athletes who granted attainment), open and overdue tasks, and a breakdown by school. Aggregates only; no grades.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    await needLead(user, i.id);
    const q = (sql, p = [i.id]) => pool.query(sql, p).then((r) => r.rows);
    const [[enr], [lk], [cons], [exp], [tk], schools, bands] = await Promise.all([
      q("SELECT count(*)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status='enrolled'"),
      q("SELECT count(*)::int AS n FROM academic_links WHERE organisation_id=$1 AND status='active'"),
      q("SELECT count(DISTINCT l.athlete_id)::int AS active, count(DISTINCT l.athlete_id) FILTER (WHERE g.expires_on <= CURRENT_DATE + 30)::int AS expiring FROM academic_links l JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE WHERE l.organisation_id=$1 AND l.status='active'"),
      q("SELECT count(*)::int AS n, count(*) FILTER (WHERE i.high_stakes)::int AS high FROM academic_items i JOIN academic_links l ON l.id=i.link_id JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE AND 'timetable' = ANY(g.scopes) WHERE l.organisation_id=$1 AND l.status='active' AND i.kind='exam' AND i.status='active' AND i.starts_at >= now() AND i.starts_at < now() + interval '14 days'"),
      q("SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open, count(*) FILTER (WHERE status IN ('open','in_progress') AND due_on < CURRENT_DATE)::int AS overdue FROM academic_tasks WHERE organisation_id=$1"),
      q("SELECT sc.id, sc.name, sc.approval_status = 'approved' AS verified, count(*)::int AS athletes FROM academic_links l JOIN organisations sc ON sc.id=l.school_org_id WHERE l.organisation_id=$1 AND l.status='active' GROUP BY 1,2,3 ORDER BY athletes DESC, sc.name"),
      q("SELECT s.progress_band AS band, count(*)::int AS n FROM academic_snapshots s JOIN academic_links l ON l.id=s.link_id JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE AND 'attainment' = ANY(g.scopes) WHERE l.organisation_id=$1 AND l.status='active' AND NOT EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) AND s.id IN (SELECT DISTINCT ON (link_id) id FROM academic_snapshots ORDER BY link_id, created_at DESC) GROUP BY 1"),
    ]);
    const floor = (await q('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL'))[0].f;
    const lowAtt = (await q("SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (x.link_id) x.sessions_total, x.present FROM academic_attendance x JOIN academic_links l ON l.id=x.link_id JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.organisation_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE AND 'attendance' = ANY(g.scopes) WHERE l.organisation_id=$1 AND l.status='active' AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=x.id) ORDER BY x.link_id, x.period_to DESC) r WHERE r.present * 100.0 / r.sessions_total < " + Number(floor)))[0].n;
    const clashes = (await pool.query("SELECT * FROM academy_sessions WHERE organisation_id=$1 AND status IN ('draft','published') AND starts_at >= now() AND starts_at < now() + interval '21 days' ORDER BY starts_at LIMIT 300", [i.id])).rows;
    let clashing = 0; const clashSessions = [];
    for (const s of clashes) { const cl = await academicClashes(pool, s); if (cl.length) { clashing++; if (clashSessions.length < 8) clashSessions.push({ session_id: s.id, title: s.title, starts_at: s.starts_at, status: s.status, clashes: cl.map((x) => ({ code: x.code, message: x.message })) }); } }
    return { enrolled: enr.n, linked: lk.n, coverage_pct: enr.n ? Math.round((lk.n / enr.n) * 100) : null, consent: { active: cons.active, expiring: cons.expiring, missing: Math.max(0, lk.n - cons.active) }, exams_14d: exp.n, high_stakes_14d: exp.high,
      clashing_sessions: clashing, clash_sessions: clashSessions, attendance_below_floor: lowAtt, floor_pct: floor, bands: Object.fromEntries(['on_track', 'watch', 'support_needed'].map((b) => [b, bands.find((x) => x.band === b)?.n ?? 0])), tasks: tk, schools };
  },
});

cap({
  name: 'list_academic_access_log', method: 'GET', path: '/academics/links/:id/access-log', tag: TAG,
  summary: 'Who looked at this athlete\'s academic record, when, which part (timetable, attendance, attainment) and at what level: for the athlete, or a minor\'s verified guardian, only. The academy cannot read who else has read the record.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const l = await linkFor(pool, i.id);
    if (!(user.id === l.athlete_id || (await guardianLink(user.id, l.athlete_id)))) throw notFound('Academic link');
    return many(`SELECT g.id, g.at, g.scope, g.detail, g.actor_side, u.display_name AS actor_name, o.name AS organisation_name FROM academic_access_log g JOIN users u ON u.id=g.actor_id LEFT JOIN organisations o ON o.id=g.organisation_id WHERE g.athlete_id=$1 ORDER BY g.at DESC LIMIT $2 OFFSET $3`, [l.athlete_id, i.limit, i.offset]);
  },
});

// ---------------------------------------------------------------------------- the school's own list: the athletes who granted this school access
cap({
  name: 'list_school_athletes', method: 'GET', path: '/organisations/:id/academics/school-athletes', tag: TAG,
  summary: 'For a school, college or university organisation (its staff only): the athletes linked to it by an academy, with the academy\'s name, year group and what each athlete has granted THIS school (timetable, attendance, attainment) and until when. Nothing about the academy\'s sport side is included, and athletes who have not granted the school anything appear without any data.',
  input: z.object({ id, q: text(60).optional(), ...page }),
  handler: async ({ user }, i) => {
    const m = (await pool.query("SELECT m.role, o.kind FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active'", [i.id, user.id])).rows[0];
    if (!m || !SCHOOL_KINDS.includes(m.kind) || !['owner', 'admin', 'coach', 'staff'].includes(m.role)) throw notFound('Organisation');
    const rows = (await pool.query(
      `SELECT l.id AS link_id, l.athlete_id, u.display_name AS athlete_name, l.year_group, l.curriculum, ac.name AS academy_name, l.liaison_user_id, g.scopes, g.detail, g.expires_on::text AS expires_on
         FROM academic_links l JOIN users u ON u.id=l.athlete_id JOIN organisations ac ON ac.id=l.organisation_id
         LEFT JOIN academic_consents g ON g.athlete_id=l.athlete_id AND g.party_org_id=l.school_org_id AND g.revoked_at IS NULL AND g.expires_on >= CURRENT_DATE
        WHERE l.school_org_id=$1 AND l.status='active' AND ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%') ORDER BY u.display_name LIMIT $3 OFFSET $4`, [i.id, i.q ?? null, i.limit, i.offset])).rows;
    return rows.map((r) => ({ ...r, mine: r.liaison_user_id === user.id, granted: r.scopes ?? [], consent_state: !r.scopes ? 'not_granted' : r.expires_on <= addDays(today(), 30) ? 'expiring' : 'active' }));
  },
});

cap({
  name: 'search_academic_providers', method: 'GET', path: '/organisations/:id/academics/providers', tag: TAG,
  summary: 'Find a school, college or university already on the platform to link an athlete to (academic lead or owner/admin): by name or city, whether or not it lists itself in the public directory. Returns the institution\'s name, type, city and whether the platform has verified it; no contact details.',
  input: z.object({ id, q: text(80).optional(), limit: z.coerce.number().int().min(1).max(40).default(20) }),
  handler: async ({ user }, i) => {
    await needLead(user, i.id);
    return many("SELECT id, name, kind, city, approval_status = 'approved' AS verified FROM organisations WHERE kind IN ('school','college','university') AND status='active' AND approval_status IN ('approved','pending') AND ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR city ILIKE '%'||$1||'%') ORDER BY (approval_status='approved') DESC, name LIMIT $2", [i.q ?? null, i.limit]);
  },
});
