// Academics & school integration (#783), part 2: configurable attainment frameworks, versioned attainment snapshots with provenance, the
// academic progress view (shown separately from sport progress, with source labels), and partner / file imports. Subject-level grades are encrypted
// and read only by the athlete, a verified guardian, the school that supplied them, and an academy staff member who holds the explicit
// 'academics_detail' permission AND was given detail consent by the athlete / guardian. Everyone else with consent sees only the progress band.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { csvToObjects } from '../csv.js';
import { fromLocal } from '../booking/time.js';
import { opsAccess } from '../academy-ops.js';
import { decrypt } from '../crypto.js';
import { BANDS, SNAPSHOT_SOURCES, SCALES, consentFor, covers, viewOf, linkFor, visibleLink, logRead, sealJson, openJson, checkValue, suggestBand, ymd, addDays } from '../academics.js';
import { saveAttendance, saveItems } from './academy-academics.js';

const TAG = 'Academics';
const day = z.string().date();
const text = (n) => z.string().trim().max(n);
const today = () => new Date().toISOString().slice(0, 10);
const SEAL = 'academic_snapshots.values';
const SOURCE_LABEL = { school_report: 'School report', partner_import: 'Partner import', partner_api: 'Partner API', manual_verified: 'Verified entry', self_reported: 'Self-reported (unverified)' };

// ---------------------------------------------------------------------------- frameworks (the academy's way of reading progress)
cap({
  name: 'save_academic_framework', method: 'POST', path: '/organisations/:id/academics/frameworks', tag: TAG, status: 201,
  summary: 'Configure how the academy reads academic progress (academic lead or owner/admin): the scale (percentage, letter A–E, 9–1, IB 1–7, GPA, CBSE grades, or your own ordered bands), an optional subject list, the thresholds below which the suggested progress band becomes "watch" or "support needed", and the attendance floor that raises exceptions. Saving under an existing name makes a new version; earlier versions stay readable and snapshots keep the one they were recorded against.',
  input: z.object({ id, name: text(80).min(2), scale: z.enum(Object.keys(SCALES)), bands: z.array(text(20).min(1)).max(12).default([]), subjects: z.array(text(40).min(2)).max(30).default([]), watch_below: z.number().int().min(1).max(99).optional(), support_below: z.number().int().min(1).max(99).optional(), attendance_floor_pct: z.number().int().min(50).max(100).default(90) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await opsAccess(user, i.id, { write: true, c });
    a.need('academics');
    if (i.scale === 'custom' && i.bands.length < 2) throw badRequest('A custom scale needs at least two bands, best first');
    if (i.scale !== 'custom' && i.bands.length) throw badRequest('Bands are only for a custom scale');
    if (i.watch_below != null && i.support_below != null && i.support_below >= i.watch_below) throw badRequest('The support threshold must be below the watch threshold');
    const prev = (await c.query('SELECT id, version FROM academic_frameworks WHERE organisation_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL FOR UPDATE', [i.id, i.name])).rows[0];
    if (prev) await c.query('UPDATE academic_frameworks SET archived_at=now() WHERE id=$1', [prev.id]);
    const row = (await c.query('INSERT INTO academic_frameworks(organisation_id, name, scale, bands, subjects, watch_below, support_below, attendance_floor_pct, version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [i.id, i.name, i.scale, JSON.stringify(i.bands), i.subjects, i.watch_below ?? null, i.support_below ?? null, i.attendance_floor_pct, (prev?.version ?? 0) + 1, user.id])).rows[0];
    await audit(c, user.id, 'save_academic_framework', 'academic_frameworks', row.id);
    return row;
  }),
});

cap({
  name: 'list_academic_frameworks', method: 'GET', path: '/organisations/:id/academics/frameworks', tag: TAG,
  summary: 'The academy\'s attainment frameworks (current versions; pass include_archived for earlier ones), with the scales available and the option lists for letter and CBSE scales. Academy staff with any academic access.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    const a = await opsAccess(user, i.id);
    if (!(a.has('academics') || a.has('roster') || a.has('attendance'))) throw forbidden('You do not have access to academic information in this academy');
    const rows = (await pool.query('SELECT * FROM academic_frameworks WHERE organisation_id=$1 AND ($2::boolean OR archived_at IS NULL) ORDER BY lower(name), version DESC', [i.id, i.include_archived])).rows;
    return { frameworks: rows, scales: Object.entries(SCALES).map(([k, v]) => ({ key: k, label: v.label, options: v.options ?? null })), can_manage: a.has('academics') };
  },
});

// ---------------------------------------------------------------------------- snapshots (immutable versions with provenance)
const ROW = z.object({ subject: text(40).min(2), value: z.union([z.string().trim().min(1).max(20), z.number()]), comment: text(200).optional() });
cap({
  name: 'record_academic_snapshot', method: 'POST', path: '/academics/links/:id/snapshots', tag: TAG, status: 201,
  summary: 'Record an attainment snapshot for a term against one of the academy\'s frameworks, with its provenance (school report, partner import / API, verified entry, or self-reported by the athlete). Subject-level values are encrypted. The school records subject-level snapshots for athletes who granted it attainment; the academy needs the explicit academics_detail permission and detail consent to record subject-level values (otherwise it can record only a progress band the school told it, as a verified entry). Recording the same term again makes a new version that supersedes the previous one; nothing is overwritten. A progress band is suggested from the values and confirmed by the person recording.',
  input: z.object({ id, framework_id: id, term_label: text(40).min(2), period_from: day.optional(), period_to: day.optional(), rows: z.array(ROW).max(30).default([]), progress_band: z.enum(BANDS).optional(), source_kind: z.enum(SNAPSHOT_SOURCES), source_ref: text(120).optional(), reported_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await visibleLink(c, user, i.id);
    if (l.status !== 'active') throw conflict('This link has ended');
    const fw = (await c.query('SELECT * FROM academic_frameworks WHERE id=$1', [i.framework_id])).rows[0];
    if (!fw || (fw.organisation_id !== l.organisation_id && v.side !== 'school')) throw notFound('Framework');
    const self = v.side === 'athlete' || v.side === 'guardian';
    if (self && i.source_kind !== 'self_reported') throw forbidden('The athlete and guardian can only record self-reported entries');
    if (!self && i.source_kind === 'self_reported') throw badRequest('Self-reported is for the athlete or guardian');
    if (!self) {
      if (v.side === 'school' && v.attainment !== 'detail') throw forbidden('The athlete has not granted attainment to the school');
      if (v.side === 'academy') { if (!v.manage || v.attainment === 'none') throw forbidden('The athlete has not granted attainment to the academy'); if (i.rows.length && v.attainment !== 'detail') throw forbidden('Subject-level values need the academics_detail permission and detail consent'); }
      if (v.side === 'school' && !['school_report', 'partner_import', 'partner_api', 'manual_verified'].includes(i.source_kind)) throw badRequest('Choose where this came from');
    }
    if (!i.rows.length && !i.progress_band) throw badRequest('Give subject values, or a progress band');
    const clean = i.rows.map((r) => ({ subject: r.subject, value: checkValue(fw, r.value), comment: r.comment ?? null }));
    if (new Set(clean.map((r) => r.subject.toLowerCase())).size !== clean.length) throw badRequest('A subject appears twice');
    const band = i.progress_band ?? suggestBand(fw, clean);
    const prev = (await c.query('SELECT id, version FROM academic_snapshots s WHERE link_id=$1 AND lower(term_label)=lower($2) AND NOT EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) ORDER BY version DESC LIMIT 1', [l.id, i.term_label])).rows[0];
    const verified = !self;
    const row = (await c.query(
      `INSERT INTO academic_snapshots(link_id, framework_id, term_label, period_from, period_to, values_enc, progress_band, version, supersedes_id, source_kind, source_org_id, source_ref, reported_on, verified_by, verified_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, version, progress_band`,
      [l.id, fw.id, i.term_label, i.period_from ?? null, i.period_to ?? null, sealJson(clean, SEAL), band, (prev?.version ?? 0) + 1, prev?.id ?? null, i.source_kind, v.side === 'school' ? l.school_org_id : null, i.source_ref ?? null, i.reported_on ?? null, verified ? user.id : null, verified ? new Date() : null, user.id])).rows[0];
    await audit(c, user.id, 'record_academic_snapshot', 'academic_links', l.id);
    return { id: row.id, version: row.version, progress_band: row.progress_band, suggested_band: suggestBand(fw, clean), supersedes: prev?.id ?? null };
  }),
});

/** Redact a snapshot to what this caller may see: detail = subject values; band = term, band and provenance only. */
function shape(r, view) {
  const base = { id: r.id, term_label: r.term_label, period_from: ymd(r.period_from), period_to: ymd(r.period_to), version: r.version, current: !r.superseded, progress_band: r.progress_band, framework: { id: r.framework_id, name: r.framework_name, scale: r.scale, version: r.framework_version },
    provenance: { source_kind: r.source_kind, label: SOURCE_LABEL[r.source_kind] + (r.source_name ? ` · ${r.source_name}` : ''), source_ref: r.source_ref, reported_on: ymd(r.reported_on), verified: !!r.verified_at, verified_at: r.verified_at, recorded_at: r.created_at } };
  return view === 'detail' ? { ...base, rows: openJson(r.values_enc, SEAL) ?? [] } : base;
}
cap({
  name: 'list_academic_snapshots', method: 'GET', path: '/academics/links/:id/snapshots', tag: TAG,
  summary: 'Attainment snapshots for a link, newest term first, each with its provenance (source, who verified, when, version) and whether it is the current version. The athlete, guardian, the supplying school and an academy member with academics_detail and detail consent see subject-level values; an academy member with a summary grant sees only the progress band; nobody else sees anything. include_history shows superseded versions. Reads are recorded.',
  input: z.object({ id, include_history: z.coerce.boolean().default(false) }),
  handler: async ({ user }, i) => {
    const { l, v } = await visibleLink(pool, user, i.id);
    if (v.attainment === 'none') throw forbidden('No attainment has been shared with you');
    const rows = (await pool.query(
      `SELECT s.*, EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) AS superseded, f.name AS framework_name, f.scale, f.version AS framework_version, o.name AS source_name
         FROM academic_snapshots s JOIN academic_frameworks f ON f.id=s.framework_id LEFT JOIN organisations o ON o.id=s.source_org_id WHERE s.link_id=$1 ORDER BY s.created_at DESC LIMIT 120`, [l.id])).rows
      .filter((r) => i.include_history || !r.superseded)
      .filter((r) => v.side !== 'school' || r.source_org_id === l.school_org_id || r.created_by);
    await logRead(pool, l.athlete_id, v.side === 'school' ? l.school_org_id : l.organisation_id, user, v.side, 'attainment', v.attainment);
    return { view: v.attainment, items: rows.map((r) => shape(r, v.attainment)) };
  },
});

cap({
  name: 'get_academic_progress', method: 'GET', path: '/academics/links/:id/progress', tag: TAG,
  summary: 'The athlete\'s academic progress as one labelled block, for display next to (never merged with) sport progress: school and year group, the progress band by term (a trend), the latest school attendance, the next exam and the open coordination tasks, each tagged with its source and whether it is verified, and each limited to what the caller may see. Sport progress is read from the sport capabilities.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { l, v } = await visibleLink(pool, user, i.id);
    const g = v.side === 'academy' ? v.grant : null;
    const out = { link: { id: l.id, athlete_id: l.athlete_id, athlete_name: l.athlete_name, school: { id: l.school_org_id, name: l.school_name, verified: l.school_approval === 'approved' }, curriculum: l.curriculum, year_group: l.year_group, status: l.status },
      view: { side: v.side, timetable: v.timetable, attendance: v.attendance, attainment: v.attainment }, consent: g ? { scopes: g.scopes, detail: g.detail, expires_on: g.expires_on } : null };
    if (v.attainment !== 'none') {
      const rows = (await pool.query(
        `SELECT s.*, EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) AS superseded, f.name AS framework_name, f.scale, f.version AS framework_version, o.name AS source_name
           FROM academic_snapshots s JOIN academic_frameworks f ON f.id=s.framework_id LEFT JOIN organisations o ON o.id=s.source_org_id WHERE s.link_id=$1 ORDER BY s.created_at DESC LIMIT 60`, [l.id])).rows.filter((r) => !r.superseded);
      out.attainment = rows.slice(0, 6).map((r) => shape(r, v.attainment === 'detail' ? 'detail' : 'band'));
      await logRead(pool, l.athlete_id, v.side === 'school' ? l.school_org_id : l.organisation_id, user, v.side, 'attainment', v.attainment);
    }
    if (v.attendance !== 'none') {
      const r = (await pool.query("SELECT x.*, x.period_from::text AS period_from, x.period_to::text AS period_to, o.name AS source_name FROM academic_attendance x LEFT JOIN organisations o ON o.id=x.source_org_id WHERE x.link_id=$1 AND NOT EXISTS (SELECT 1 FROM academic_attendance n WHERE n.supersedes_id=x.id) ORDER BY x.period_to DESC LIMIT 1", [l.id])).rows[0];
      const floor = (await pool.query('SELECT coalesce(min(attendance_floor_pct), 90)::int AS f FROM academic_frameworks WHERE organisation_id=$1 AND archived_at IS NULL', [l.organisation_id])).rows[0].f;
      const pct = r && r.sessions_total ? Math.round((r.present / r.sessions_total) * 1000) / 10 : null;
      out.attendance = r ? { period: { from: r.period_from, to: r.period_to }, below_floor: pct < floor, floor_pct: floor, ...(v.attendance === 'summary' ? { pct, sessions_total: r.sessions_total, present: r.present, late: r.late, authorised_absent: r.authorised_absent, unauthorised_absent: r.unauthorised_absent } : {}), provenance: { label: SOURCE_LABEL[r.source === 'manual_verified' ? 'manual_verified' : r.source] ?? r.source, verified: !!r.verified_at, version: r.version, source_name: r.source_name } } : null;
    }
    if (v.timetable !== 'none') {
      const x = (await pool.query("SELECT i.id, i.kind, i.starts_at, i.high_stakes, i.verified_at FROM academic_items i WHERE i.link_id=$1 AND i.status='active' AND i.kind='exam' AND i.starts_at > now() ORDER BY i.starts_at LIMIT 1", [l.id])).rows[0];
      out.next_exam = x ? { starts_at: x.starts_at, high_stakes: x.high_stakes, verified: !!x.verified_at } : null;
    }
    out.open_tasks = v.side === 'academy' || v.side === 'school' ? (await pool.query("SELECT count(*)::int AS n FROM academic_tasks WHERE link_id=$1 AND status IN ('open','in_progress')", [l.id])).rows[0].n : undefined;
    return out;
  },
});

// ---------------------------------------------------------------------------- imports: file or partner API, previewed first, applied by the party that supplies the data
const KINDS = ['timetable', 'attendance', 'snapshot'];
const norm = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => (v === '' || v == null ? 0 : Number(v));

/** Who may supply this import? The school's own staff (for athletes who granted it that scope) or the academy's academic lead entering a school's data as a verified entry. */
async function importer(c, user, orgId, kind) {
  const org = (await c.query('SELECT id, kind FROM organisations WHERE id=$1 AND status=\'active\'', [orgId])).rows[0];
  if (!org) throw notFound('Organisation');
  const m = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [orgId, user.id])).rows[0];
  if (!m) throw notFound('Organisation');
  if (['school', 'college', 'university'].includes(org.kind)) { if (!['owner', 'admin', 'coach', 'staff'].includes(m.role)) throw forbidden('Only the school\'s staff can supply records'); return { side: 'school', org }; }
  const a = await opsAccess(user, orgId, { write: true, c });
  a.need('academics');
  if (kind === 'snapshot') a.need('academics_detail');
  return { side: 'academy', org, a };
}

async function matchRows(c, who, kind, rows, fwId) {
  const links = who.side === 'school'
    ? (await c.query("SELECT l.*, u.handle, u.display_name AS athlete_name FROM academic_links l JOIN users u ON u.id=l.athlete_id WHERE l.school_org_id=$1 AND l.status='active'", [who.org.id])).rows
    : (await c.query("SELECT l.*, u.handle, u.display_name AS athlete_name FROM academic_links l JOIN users u ON u.id=l.athlete_id WHERE l.organisation_id=$1 AND l.status='active'", [who.org.id])).rows;
  const byRef = new Map(), byHandle = new Map();
  for (const l of links) { byHandle.set(norm(l.handle), l); if (l.student_ref_enc) { try { byRef.set(norm(decrypt(l.student_ref_enc, 'academic_links.student_ref')), l); } catch { /* unreadable ref */ } } }
  const scope = kind === 'snapshot' ? 'attainment' : kind;
  const party = who.org.id;
  const fw = fwId ? (await c.query('SELECT * FROM academic_frameworks WHERE id=$1', [fwId])).rows[0] : null;
  const consents = new Map();
  const out = [];
  rows.forEach((r, n) => {
    out.push({ n: n + 1, raw: r });
  });
  for (const o of out) {
    const key = norm(o.raw.student_ref ?? o.raw.handle);
    const l = byRef.get(key) ?? byHandle.get(key);
    if (!l) { o.error = 'No linked athlete matches this student reference or handle'; continue; }
    if (!consents.has(l.athlete_id)) consents.set(l.athlete_id, await consentFor(c, l.athlete_id, party));
    if (!covers(consents.get(l.athlete_id), scope)) { o.error = 'The athlete has not granted this to you'; continue; }
    o.link = l;
    try {
      if (kind === 'attendance') {
        o.rec = { period_from: o.raw.period_from, period_to: o.raw.period_to, sessions_total: num(o.raw.sessions_total), present: num(o.raw.present), late: num(o.raw.late), authorised_absent: num(o.raw.authorised_absent), unauthorised_absent: num(o.raw.unauthorised_absent), source_ref: o.raw.source_ref };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.rec.period_from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(o.rec.period_to ?? '')) throw new Error('period_from and period_to must be dates (YYYY-MM-DD)');
        if (!o.rec.sessions_total || o.rec.present + o.rec.authorised_absent + o.rec.unauthorised_absent > o.rec.sessions_total) throw new Error('The totals do not add up');
      } else if (kind === 'timetable') {
        const k = norm(o.raw.kind);
        if (!['class_block', 'exam', 'tutoring', 'school_event', 'holiday', 'deadline'].includes(k)) throw new Error('Unknown kind');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.raw.date ?? '') || !/^\d{1,2}:\d{2}$/.test(o.raw.start_time ?? '') || !/^\d{1,2}:\d{2}$/.test(o.raw.end_time ?? '')) throw new Error('Give date (YYYY-MM-DD), start_time and end_time (HH:MM)');
        const tz = o.raw.timezone || 'UTC', toMin = (t) => { const [h, m] = t.split(':'); return +h * 60 + +m; };
        if (toMin(o.raw.end_time) <= toMin(o.raw.start_time)) throw new Error('The end is before the start');
        o.rec = { kind: k, title: o.raw.title || undefined, starts_at: fromLocal(o.raw.date, toMin(o.raw.start_time), tz).toISOString(), ends_at: fromLocal(o.raw.date, toMin(o.raw.end_time), tz).toISOString(), timezone: tz, high_stakes: ['1', 'true', 'yes'].includes(norm(o.raw.high_stakes)), blocks_sport: !['0', 'false', 'no'].includes(norm(o.raw.blocks_sport)), source_ref: o.raw.source_ref };
      } else {
        if (!fw) throw new Error('Choose a framework');
        o.rec = { term: o.raw.term, subject: o.raw.subject, value: checkValue(fw, o.raw.value), band: o.raw.band ? norm(o.raw.band) : undefined, reported_on: o.raw.reported_on, source_ref: o.raw.source_ref };
        if (!o.rec.term || !o.rec.subject) throw new Error('term and subject are required');
        if (o.rec.band && !BANDS.includes(o.rec.band)) throw new Error('band must be on_track, watch or support_needed');
      }
    } catch (e) { o.error = e.message; }
  }
  return { out, fw };
}

cap({
  name: 'import_academic_records', method: 'POST', path: '/organisations/:id/academics/imports', tag: TAG, status: 201,
  summary: 'Import timetable, attendance summaries or attainment for linked athletes, from a CSV file or from a partner system calling this API (records as JSON). Rows are matched to linked athletes by student reference or handle, checked against the athlete\'s consent for that party and scope, validated, and staged: nothing is applied until it is committed (or apply is true and every row is valid). The school\'s own staff supply their records (for athletes who granted that school the scope); the academy\'s academic lead can enter a school\'s data as a verified entry. CSV columns - timetable: student_ref, kind, date, start_time, end_time, timezone, title, high_stakes; attendance: student_ref, period_from, period_to, sessions_total, present, late, authorised_absent, unauthorised_absent; snapshot: student_ref, term, subject, value, band, reported_on (needs framework_id). Idempotent per idempotency_key.',
  input: z.object({ id, kind: z.enum(KINDS), csv: z.string().max(400000).optional(), records: z.array(z.record(z.string(), z.any())).max(2000).optional(), framework_id: id.optional(), source_ref: text(120).optional(), apply: z.boolean().default(false), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const who = await importer(c, user, i.id, i.kind);
    if (!i.csv && !i.records) throw badRequest('Send csv or records');
    if (i.idempotency_key) { const prior = (await c.query('SELECT id, status, summary FROM academic_imports WHERE organisation_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0]; if (prior) return { import_id: prior.id, status: prior.status, replayed: true, summary: prior.summary }; }
    const rows = i.records ?? csvToObjects(i.csv);
    if (!rows.length) throw badRequest('There are no rows');
    const { out } = await matchRows(c, who, i.kind, rows, i.framework_id);
    const ok = out.filter((o) => !o.error), bad = out.filter((o) => o.error);
    const summary = { total: out.length, ok: ok.length, invalid: bad.length, athletes: new Set(ok.map((o) => o.link.athlete_id)).size, errors: bad.slice(0, 50).map((o) => ({ row: o.n, reason: o.error })) };
    const staged = ok.map((o) => ({ link_id: o.link.id, rec: o.rec, n: o.n }));
    const imp = (await c.query("INSERT INTO academic_imports(organisation_id, kind, source_org_id, channel, rows_enc, summary, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [i.id, i.kind, who.side === 'school' ? who.org.id : null, i.records ? 'api' : 'file', sealJson({ framework_id: i.framework_id ?? null, source_ref: i.source_ref ?? null, rows: staged }, 'academic_imports.rows'), JSON.stringify(summary), user.id, i.idempotency_key ?? null])).rows[0];
    await audit(c, user.id, 'stage_academic_import', 'academic_imports', imp.id);
    if (i.apply && !bad.length) return { import_id: imp.id, ...(await applyImport(c, user, who, imp.id, i.kind)) };
    return { import_id: imp.id, status: 'staged', summary };
  }),
});

async function applyImport(c, user, who, importId, kind) {
  const imp = (await c.query("SELECT * FROM academic_imports WHERE id=$1 AND status='staged' FOR UPDATE", [importId])).rows[0];
  if (!imp) throw conflict('This import is not waiting to be applied');
  const data = openJson(imp.rows_enc, 'academic_imports.rows');
  let applied = 0;
  const groups = new Map();
  for (const r of data.rows) (groups.get(r.link_id) ?? groups.set(r.link_id, []).get(r.link_id)).push(r);
  for (const [linkId, rs] of groups) {
    const l = await linkFor(c, linkId);
    const v = await viewOf(c, user, l);
    const w = { source: who.side === 'school' ? 'manual_verified' : 'manual_verified', verified: true };
    const source = imp.channel === 'api' ? 'partner_api' : 'partner_import';
    if (kind === 'attendance') for (const r of rs) { await saveAttendance(c, l, v, w, user, { ...r.rec, source_ref: r.rec.source_ref ?? data.source_ref ?? undefined }); applied++; }
    if (kind === 'timetable') { await saveItems(c, l, v, { source, verified: true }, user, rs.map((r) => ({ ...r.rec, weekdays: undefined }))); applied += rs.length; }
    if (kind === 'snapshot') {
      const fw = (await c.query('SELECT * FROM academic_frameworks WHERE id=$1', [data.framework_id])).rows[0];
      const byTerm = new Map();
      for (const r of rs) (byTerm.get(r.rec.term) ?? byTerm.set(r.rec.term, []).get(r.rec.term)).push(r.rec);
      for (const [term, recs] of byTerm) {
        const values = recs.map((x) => ({ subject: x.subject, value: x.value, comment: null }));
        const band = recs.find((x) => x.band)?.band ?? suggestBand(fw, values);
        const prev = (await c.query('SELECT id, version FROM academic_snapshots s WHERE link_id=$1 AND lower(term_label)=lower($2) AND NOT EXISTS (SELECT 1 FROM academic_snapshots n WHERE n.supersedes_id=s.id) ORDER BY version DESC LIMIT 1', [l.id, term])).rows[0];
        await c.query(`INSERT INTO academic_snapshots(link_id, framework_id, term_label, values_enc, progress_band, version, supersedes_id, source_kind, source_org_id, source_ref, reported_on, verified_by, verified_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$12)`, [l.id, fw.id, term, sealJson(values, SEAL), band, (prev?.version ?? 0) + 1, prev?.id ?? null, source === 'partner_api' ? 'partner_api' : 'partner_import', who.side === 'school' ? l.school_org_id : null, data.source_ref, recs[0].reported_on ?? null, user.id]);
        applied++;
      }
    }
  }
  await c.query("UPDATE academic_imports SET status='applied', applied_at=now(), rows_enc=NULL WHERE id=$1", [importId]);
  await audit(c, user.id, 'apply_academic_import', 'academic_imports', importId);
  return { status: 'applied', applied };
}

cap({
  name: 'commit_academic_import', method: 'POST', path: '/organisations/:id/academics/imports/:import_id/commit', tag: TAG,
  summary: 'Apply a staged import: only the person who staged it (or another authorised member of the same organisation) can, and only the valid rows that were staged are written, each as a verified record with its source (file or partner API). The staged rows are then erased; the summary stays.',
  input: z.object({ id, import_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const imp = (await c.query('SELECT * FROM academic_imports WHERE id=$1 AND organisation_id=$2', [i.import_id, i.id])).rows[0];
    if (!imp) throw notFound('Import');
    const who = await importer(c, user, i.id, imp.kind);
    return applyImport(c, user, who, i.import_id, imp.kind);
  }),
});

cap({
  name: 'list_academic_imports', method: 'GET', path: '/organisations/:id/academics/imports', tag: TAG,
  summary: 'Recent imports for the organisation (file or partner API): what was staged, how many rows were valid, who supplied them and whether they were applied. Counts and reasons only; the staged rows are encrypted and erased once applied.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const m = (await pool.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, user.id])).rowCount;
    if (!m) throw notFound('Organisation');
    return (await pool.query('SELECT g.id, g.kind, g.channel, g.status, g.summary, g.created_at, g.applied_at, u.display_name AS by_name FROM academic_imports g JOIN users u ON u.id=g.created_by WHERE g.organisation_id=$1 ORDER BY g.created_at DESC LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset])).rows;
  },
});
