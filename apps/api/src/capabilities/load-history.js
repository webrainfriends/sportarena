import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { requireGuardian, requireConsent } from '../youth.js';
import { workload } from '../readiness.js';
import { SOURCES, LOAD_COLS, snapshot, revise, reasonOf, loadKindFor, sourcesFor, resolveMinutes, resolveRpe, manualCandidates, staleCheck, sourceAccess, CONSENT_PURPOSE } from '../load-history.js';

// Unified training and match load history (#328). The existing session_loads table stays the one source of load; these capabilities link its rows
// to confirmed completed training sessions and verified match appearances, reconcile manual logs against them, and keep a correction history.
const TAG = 'Athlete health';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const reason = z.string().trim().min(3).max(300).describe('why; private, encrypted at rest');
const sourceIn = z.enum(SOURCES);

const OUT = `${LOAD_COLS}, ts.title AS ts_title, tp.title AS ts_context, mt.name AS m_team, mev.name AS m_competition`;
const FROM = `FROM session_loads l
  LEFT JOIN training_sessions ts ON ts.id=l.training_session_id LEFT JOIN training_plans tp ON tp.id=ts.plan_id
  LEFT JOIN match_appearances ma ON ma.id=l.appearance_id LEFT JOIN fixtures mf ON mf.id=ma.fixture_id LEFT JOIN teams mt ON mt.id=ma.team_id LEFT JOIN events mev ON mev.id=mf.event_id`;

/** Shape one row for the client; a source the viewer no longer has consent for keeps its numbers but loses its title and competition. */
function shape(r, access) {
  const hidden = r.source !== 'manual' && !access[r.source];
  const { ts_title, ts_context, m_team, m_competition, ...rest } = r;
  return {
    ...rest, corrected: r.corrections > 0, minutes_label: r.minutes_basis === 'match_verified' ? 'verified match minutes' : 'entered by the athlete',
    source_title: hidden ? null : r.source === 'match' ? m_team ?? 'Match' : ts_title ?? null, source_context: hidden ? null : r.source === 'match' ? m_competition : ts_context, source_hidden: hidden,
  };
}

const loadById = async (c, loadId, userId, { lock = false } = {}) => {
  const row = (await c.query(`SELECT l.*, l.session_date::text AS session_date FROM session_loads l WHERE l.id=$1 AND l.user_id=$2 AND l.archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [loadId, userId])).rows[0];
  if (!row) throw notFound('Load record');
  return row;
};
const publicRow = async (c, loadId) => {
  const r = (await c.query(`SELECT ${OUT} ${FROM} WHERE l.id=$1`, [loadId])).rows[0];
  return shape(r, { training_session: true, match: true });
};
const slim = ({ id: rid, session_date, kind, minutes, rpe, load, row_version }) => ({ id: rid, session_date, kind, minutes, rpe, load, row_version });

cap({
  name: 'list_load_history', method: 'GET', path: '/me/load-history', tag: TAG,
  summary: 'Your unified training and match load history (default last 28 days): manual logs, completed training sessions and verified matches in one list, each with its source, minutes (verified or entered by you), RPE, load and whether it was ever corrected. `pending` lists confirmed sessions and matches with no load record yet: they need your RPE and are not counted until you add it, nothing is estimated. `possible_duplicates` pairs a manual log with a same-day pending session so you can link them instead of counting twice. A guardian can read a young person\'s with user_id (audit-logged); a young person needs a guardian\'s current consent for sources involving a coach or a team.',
  input: z.object({ user_id: id.optional(), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    const uid = i.user_id ?? user.id;
    if (uid !== user.id) { if (!isAdmin(user)) await requireGuardian(user, uid); await audit(null, user.id, 'read_load_history', 'user', uid); }
    const to = i.to ?? today(), from = i.from ?? plusDays(to, -27);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw badRequest('Range is limited to a year');
    const access = await sourceAccess(uid);
    const where = 'WHERE l.user_id=$1 AND l.archived_at IS NULL AND l.session_date BETWEEN $2 AND $3';
    const entries = (await many(`SELECT ${OUT} ${FROM} ${where} ORDER BY l.session_date DESC, l.created_at DESC, l.id LIMIT $4 OFFSET $5`, [uid, from, to, i.limit, i.offset])).map((r) => shape(r, access));
    const totals = await one(`SELECT count(*)::int AS entries, coalesce(sum(l.minutes),0)::int AS minutes, coalesce(sum(l.load),0)::int AS load,
        count(*) FILTER (WHERE l.source='manual')::int AS manual, count(*) FILTER (WHERE l.source='training_session')::int AS training_sessions, count(*) FILTER (WHERE l.source='match')::int AS matches
        FROM session_loads l ${where}`, [uid, from, to]);
    const pending = await sourcesFor({ query }, uid, { from, to, includeTraining: access.training_session, includeMatches: access.match });
    const manual = await many(`SELECT id, session_date::text AS session_date, kind, minutes, rpe, load, row_version FROM session_loads WHERE user_id=$1 AND source='manual' AND archived_at IS NULL AND session_date BETWEEN $2 AND $3 ORDER BY session_date DESC, created_at DESC, id`, [uid, plusDays(from, -1), plusDays(to, 1)]);
    const possible_duplicates = [];
    for (const p of pending) {
      const kind = loadKindFor(p.source, p.session_kind);
      const near = manual.filter((m) => Math.abs(Date.parse(m.session_date) - Date.parse(p.date)) <= 86400000 && (kind === 'match') === (m.kind === 'match'));
      if (near.length) possible_duplicates.push({ source: p.source, source_id: p.id, source_title: p.title, date: p.date, manual: near });
    }
    const loads = await many('SELECT session_date::text AS session_date, load FROM session_loads WHERE user_id=$1 AND archived_at IS NULL AND session_date BETWEEN $2 AND $3', [uid, plusDays(to, -90), to]);
    return {
      user_id: uid, window: { from, to }, entries, totals, pending, possible_duplicates,
      hidden_sources: Object.entries(access).filter(([, ok]) => !ok).map(([source]) => ({ source, reason: 'guardian_consent_required', purpose: CONSENT_PURPOSE[source] })),
      workload: (({ ratio, status }) => ({ ratio, status }))(workload(loads, to)),
      basis: 'Minutes and RPE are entered or confirmed by the athlete. Sessions and matches without a load record are shown but never counted or estimated.',
    };
  },
});

// ---------- record a load from a confirmed session or match ----------

/** Attach a manual record to a source (shared by link_session_load and record_load_from_source). Runs in a transaction. */
async function linkManual(c, user, manual, src, { useSourceMinutes, why, expected }) {
  if (expected !== undefined) staleCheck(manual, expected);
  if (Math.abs(Date.parse(manual.session_date) - Date.parse(src.date)) > 86400000) throw badRequest('That log is on a different day from the session: correct its date first, or log the session separately', { code: 'date_mismatch' });
  if (src.load_id) throw conflict('That session already has a load record', { code: 'already_recorded', load_id: src.load_id });
  const before = snapshot(manual);
  const m = useSourceMinutes ? resolveMinutes(src, undefined) : { minutes: manual.minutes, basis: manual.minutes_basis };
  const col = src.source === 'match' ? 'appearance_id' : 'training_session_id';
  const row = (await c.query(
    `UPDATE session_loads SET source=$2, ${col}=$3, session_date=$4, kind=$5, minutes=$6, minutes_basis=$7, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *, session_date::text AS session_date`,
    [manual.id, src.source, src.id, src.date, loadKindFor(src.source, src.session_kind), m.minutes, m.basis])).rows[0];
  await revise(c, row, user.id, 'linked', before, why);
  return row;
}

const isUnique = (e) => e?.code === '23505';

cap({
  name: 'record_load_from_source', method: 'POST', path: '/me/load-history/record', tag: TAG, status: 201,
  summary: 'Add a load record for a training session you completed or a match you played. You give the RPE (a training session you already rated keeps that rating) and the minutes you actually trained; a match with verified playing time uses it. Nothing is estimated. Safe to repeat: the same request returns the existing record, and a source can only ever be counted once. If you already logged this session by hand on that day you get 409 `possible_duplicate` and must either pass `link_load_id` to turn that log into this record or `separate: true` to keep both.',
  input: z.object({
    source: sourceIn, source_id: id, minutes: z.number().int().min(1).max(600).optional(), rpe: z.number().int().min(1).max(10).optional(),
    link_load_id: id.optional().describe('an existing manual log that is this same session'), separate: z.boolean().optional().describe('keep your manual log of that day as a different session'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const src = (await sourcesFor(c, user.id, { from: '1970-01-01', to: '2999-12-31', source: i.source, sourceId: i.source_id, pendingOnly: false }))[0];
    if (!src) throw notFound(i.source === 'match' ? 'Match' : 'Session');
    await requireConsent(user.id, CONSENT_PURPOSE[i.source], i.source === 'match' ? 'your match records' : 'your coaching records', c);
    if (src.load_id) {
      const ex = (await c.query('SELECT minutes, rpe FROM session_loads WHERE id=$1', [src.load_id])).rows[0];
      if ((i.minutes === undefined || i.minutes === ex.minutes) && (i.rpe === undefined || i.rpe === ex.rpe)) return { ...(await publicRow(c, src.load_id)), existing: true };
      throw conflict('This session already has a load record; correct that record instead', { code: 'already_recorded', load_id: src.load_id });
    }
    const kind = loadKindFor(src.source, src.session_kind);
    if (i.link_load_id) {
      const manual = await loadById(c, i.link_load_id, user.id, { lock: true });
      if (manual.source !== 'manual') throw conflict('That record is already linked to a session', { code: 'already_linked' });
      try {
        const row = await linkManual(c, user, manual, src, { useSourceMinutes: false, why: 'Linked to a confirmed session' });
        return { ...(await publicRow(c, row.id)), existing: false, linked: true }; // the log keeps the athlete's own minutes and RPE
      } catch (e) {
        if (isUnique(e)) throw conflict('That session already has a load record', { code: 'already_recorded' });
        throw e;
      }
    }
    const { minutes, basis } = resolveMinutes(src, i.minutes);
    const rpe = resolveRpe(src, i.rpe);
    const candidates = await manualCandidates(c, user.id, src.date, kind);
    if (candidates.length && !i.separate) throw conflict('You already logged a session that day. Link it to this one, or say it is a separate session, so it is not counted twice', { code: 'possible_duplicate', candidates: candidates.map(slim) });
    const col = src.source === 'match' ? 'appearance_id' : 'training_session_id';
    const row = (await c.query(
      `INSERT INTO session_loads(user_id, session_date, kind, minutes, rpe, source, ${col}, minutes_basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (${col}) WHERE ${col} IS NOT NULL AND archived_at IS NULL DO NOTHING RETURNING *, session_date::text AS session_date`,
      [user.id, src.date, kind, minutes, rpe, src.source, src.id, basis])).rows[0];
    if (!row) { // a concurrent request recorded it first: return that one rather than a second copy
      const ex = (await c.query(`SELECT id FROM session_loads WHERE ${col}=$1 AND archived_at IS NULL`, [src.id])).rows[0];
      return { ...(await publicRow(c, ex.id)), existing: true };
    }
    await revise(c, row, user.id, 'created', null, null);
    return { ...(await publicRow(c, row.id)), existing: false };
  }),
});

cap({
  name: 'link_session_load', method: 'POST', path: '/me/loads/:id/link', tag: TAG,
  summary: 'Reconcile a manual log with the confirmed training session or match it really was, so it is counted once. The log keeps your RPE (and your minutes unless `use_source_minutes`, which needs verified match time); it takes the session\'s date and type. The change is kept in the record\'s history. A stale `expected_version` gets 409.',
  input: z.object({ id, source: sourceIn, source_id: id, expected_version: z.number().int().min(1), use_source_minutes: z.boolean().default(false), reason: reason.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const manual = await loadById(c, i.id, user.id, { lock: true });
    if (manual.source !== 'manual') throw conflict('That record is already linked to a session', { code: 'already_linked' });
    const src = (await sourcesFor(c, user.id, { from: '1970-01-01', to: '2999-12-31', source: i.source, sourceId: i.source_id, pendingOnly: false }))[0];
    if (!src) throw notFound(i.source === 'match' ? 'Match' : 'Session');
    await requireConsent(user.id, CONSENT_PURPOSE[i.source], i.source === 'match' ? 'your match records' : 'your coaching records', c);
    try {
      const row = await linkManual(c, user, manual, src, { useSourceMinutes: i.use_source_minutes, why: i.reason ?? 'Linked to a confirmed session', expected: i.expected_version });
      return publicRow(c, row.id);
    } catch (e) {
      if (isUnique(e)) throw conflict('That session already has a load record', { code: 'already_recorded' });
      throw e;
    }
  }),
});

// ---------- corrections ----------

cap({
  name: 'correct_session_load', method: 'PATCH', path: '/me/loads/:id', tag: TAG,
  summary: 'Correct a load record\'s minutes or RPE (and, for a manual log that is not linked to a session, its date or type). A reason is required and every change is kept in the history; a stale `expected_version` gets 409. A record linked to a session or match keeps that session\'s date and type.',
  input: z.object({
    id, expected_version: z.number().int().min(1), reason,
    minutes: z.number().int().min(1).max(600).optional(), rpe: z.number().int().min(1).max(10).optional(),
    date: day.optional(), kind: z.enum(['training', 'match', 'gym', 'other']).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const l = await loadById(c, i.id, user.id, { lock: true });
    staleCheck(l, i.expected_version);
    if (i.minutes === undefined && i.rpe === undefined && i.date === undefined && i.kind === undefined) throw badRequest('Say what to correct');
    if ((i.date !== undefined || i.kind !== undefined) && l.source !== 'manual') throw badRequest('This record is linked to a session or match: its date and type come from there. Archive it and record again if it is the wrong session', { code: 'source_locked' });
    if (i.date !== undefined && i.date > plusDays(today(), 1)) throw badRequest('That date is in the future');
    const next = { session_date: i.date ?? l.session_date, kind: i.kind ?? l.kind, minutes: i.minutes ?? l.minutes, rpe: i.rpe ?? l.rpe };
    if (next.session_date === l.session_date && next.kind === l.kind && next.minutes === l.minutes && next.rpe === l.rpe) throw badRequest('Nothing changed');
    const basis = i.minutes !== undefined && i.minutes !== l.minutes ? 'athlete_entered' : l.minutes_basis;
    const before = snapshot(l);
    const row = (await c.query(
      `UPDATE session_loads SET session_date=$2, kind=$3, minutes=$4, rpe=$5, minutes_basis=$6, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *, session_date::text AS session_date`,
      [l.id, next.session_date, next.kind, next.minutes, next.rpe, basis])).rows[0];
    await revise(c, row, user.id, 'corrected', before, i.reason);
    return publicRow(c, row.id);
  }),
});

cap({
  name: 'list_session_load_revisions', method: 'GET', path: '/me/loads/:id/revisions', tag: TAG,
  summary: 'The full history of one load record: when it was created or linked, each correction with the values before and after and your reason, and when it was archived. Newest first. Reasons are decrypted for you and the read is audit-logged; a guardian can read a young person\'s.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const l = await one('SELECT id, user_id FROM session_loads WHERE id=$1', [i.id]);
    if (!l) throw notFound('Load record');
    if (l.user_id !== user.id) { if (!isAdmin(user)) { try { await requireGuardian(user, l.user_id); } catch { throw notFound('Load record'); } } }
    const rows = await many('SELECT id, action, row_version, before, after, reason_enc, actor_id, created_at FROM session_load_revisions WHERE load_id=$1 ORDER BY created_at DESC, row_version DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
    if (rows.some((r) => r.reason_enc) || l.user_id !== user.id) await audit(null, user.id, 'read_load_revisions', 'session_loads', l.id);
    return rows.map(({ reason_enc, ...r }) => ({ ...r, reason: reasonOf(reason_enc) }));
  },
});
