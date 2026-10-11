import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { readiness, workload } from '../readiness.js';

const TAG = 'Athlete health';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The athlete's own local date can be a day ahead of the server's; anything further out is a mistake. */
const notFuture = (d) => { if (d > plusDays(today(), 1)) throw badRequest('That date is in the future'); return d; };

export const REGIONS = ['head', 'neck', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand', 'chest', 'upper_back', 'lower_back', 'abdomen', 'hip', 'groin', 'glute', 'thigh_front', 'hamstring', 'knee', 'calf', 'shin', 'ankle', 'foot'];

// Everything here belongs to the athlete alone. Notes are encrypted at rest and every decrypted read is audit-logged; scores and charts
// use only the numbers. Nothing is shared with coaches or teams by these capabilities.

const WELLNESS_COLS = 'id, log_date::text AS log_date, sleep_hours, sleep_quality, soreness, mood, water_ml, (note_enc IS NOT NULL) AS has_note, updated_at';

cap({
  name: 'log_wellness', method: 'POST', path: '/me/wellness', tag: TAG,
  summary: 'Quick daily log: sleep hours and quality, soreness (0-10), mood (1-5), water and a private note. One row per day; anything you leave out keeps its earlier value, and `water_add_ml` adds to the day\'s total.',
  input: z.object({
    date: day.optional(),
    sleep_hours: z.number().min(0).max(24).optional(), sleep_quality: z.number().int().min(1).max(5).optional(),
    soreness: z.number().int().min(0).max(10).optional(), mood: z.number().int().min(1).max(5).optional(),
    water_ml: z.number().int().min(0).max(20000).optional().describe('set the day\'s total'), water_add_ml: z.number().int().min(1).max(5000).optional().describe('add to the day\'s total'),
    note: z.string().trim().max(500).optional().describe('private; encrypted at rest'),
  }),
  async handler({ user }, i) {
    const date = notFuture(i.date ?? today());
    const { date: _d, note, water_add_ml, ...rest } = i;
    if (!Object.values({ ...rest, note, water_add_ml }).some((v) => v !== undefined)) throw badRequest('Log at least one thing');
    return one(
      `INSERT INTO wellness_logs(user_id, log_date, sleep_hours, sleep_quality, soreness, mood, water_ml, note_enc)
       VALUES ($1,$2,$3::numeric,$4::smallint,$5::smallint,$6::smallint, coalesce($7::int, $8::int, 0), $9)
       ON CONFLICT (user_id, log_date) DO UPDATE SET
         sleep_hours = coalesce(EXCLUDED.sleep_hours, wellness_logs.sleep_hours), sleep_quality = coalesce(EXCLUDED.sleep_quality, wellness_logs.sleep_quality),
         soreness = coalesce(EXCLUDED.soreness, wellness_logs.soreness), mood = coalesce(EXCLUDED.mood, wellness_logs.mood),
         water_ml = CASE WHEN $7::int IS NOT NULL THEN $7 ELSE coalesce(wellness_logs.water_ml, 0) + coalesce($8::int, 0) END,
         note_enc = coalesce(EXCLUDED.note_enc, wellness_logs.note_enc), updated_at = now()
       RETURNING ${WELLNESS_COLS}`,
      [user.id, date, i.sleep_hours ?? null, i.sleep_quality ?? null, i.soreness ?? null, i.mood ?? null, i.water_ml ?? null, water_add_ml ?? null, encrypt(note, 'wellness_logs.note')]);
  },
});

cap({
  name: 'list_wellness', method: 'GET', path: '/me/wellness', tag: TAG,
  summary: 'Your daily wellness history (default last 14 days), newest first, with private notes decrypted for you. Reading notes is audit-logged.',
  input: z.object({ from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const to = i.to ?? today(), from = i.from ?? plusDays(to, -13);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw badRequest('Range is limited to a year');
    const rows = await many(`SELECT ${WELLNESS_COLS.replace('(note_enc IS NOT NULL) AS has_note', 'note_enc')} FROM wellness_logs WHERE user_id=$1 AND log_date BETWEEN $2 AND $3 ORDER BY log_date DESC`, [user.id, from, to]);
    if (rows.some((r) => r.note_enc)) await audit(null, user.id, 'read_wellness', 'wellness_logs', null);
    return rows.map(({ note_enc, ...r }) => ({ ...r, note: decrypt(note_enc, 'wellness_logs.note') }));
  },
});

// ---------- body map ----------

cap({
  name: 'log_body_pain', method: 'POST', path: '/me/body-pain', tag: TAG, status: 201,
  summary: 'Tap a body region and rate pain, tightness or fatigue from 1 to 10. Logging the same region again records a new reading (the history is kept); the latest open one is the current state.',
  input: z.object({
    region: z.enum(REGIONS), side: z.enum(['left', 'right', 'centre']).default('centre'), kind: z.enum(['pain', 'tightness', 'fatigue']).default('pain'),
    severity: z.number().int().min(1).max(10), started_on: day.optional(), note: z.string().trim().max(500).optional().describe('private; encrypted at rest'),
  }),
  async handler({ user }, i) {
    return one(
      `INSERT INTO body_pain_logs(user_id, region, side, kind, severity, started_on, note_enc) VALUES ($1,$2,$3,$4,$5, coalesce($6::date, current_date), $7)
       RETURNING id, region, side, kind, severity, started_on::text AS started_on, created_at`,
      [user.id, i.region, i.side, i.kind, i.severity, i.started_on ?? null, encrypt(i.note, 'body_pain_logs.note')]);
  },
});

const PAIN_COLS = 'id, region, side, kind, severity, started_on::text AS started_on, resolved_at, created_at, note_enc';

cap({
  name: 'list_body_pain', method: 'GET', path: '/me/body-pain', tag: TAG,
  summary: 'What your body map shows. By default the current open entries (latest reading per region, side and kind); with `history=true` every reading including resolved ones. Reading notes is audit-logged.',
  input: z.object({ history: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const rows = i.history
      ? await many(`SELECT ${PAIN_COLS} FROM body_pain_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 300`, [user.id])
      : await many(`SELECT DISTINCT ON (region, side, kind) ${PAIN_COLS} FROM body_pain_logs WHERE user_id=$1 AND resolved_at IS NULL ORDER BY region, side, kind, created_at DESC`, [user.id]);
    if (rows.some((r) => r.note_enc)) await audit(null, user.id, 'read_wellness', 'body_pain_logs', null);
    return rows.map(({ note_enc, ...r }) => ({ ...r, note: decrypt(note_enc, 'body_pain_logs.note') }));
  },
});

cap({
  name: 'resolve_body_pain', method: 'POST', path: '/me/body-pain/:id/resolve', tag: TAG,
  summary: 'Mark a body-map entry as better. Closes every open reading for that region, side and kind; the history stays.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('SELECT region, side, kind FROM body_pain_logs WHERE id=$1 AND user_id=$2', [i.id, user.id]);
    if (!row) throw notFound('Body-map entry');
    const r = await many(`UPDATE body_pain_logs SET resolved_at=now() WHERE user_id=$1 AND region=$2 AND side=$3 AND kind=$4 AND resolved_at IS NULL RETURNING id`, [user.id, row.region, row.side, row.kind]);
    return { resolved: r.length };
  },
});

// ---------- training load ----------

cap({
  name: 'log_session_load', method: 'POST', path: '/me/loads', tag: TAG, status: 201,
  summary: 'Log a session for your workload: minutes and how hard it felt (RPE 1-10). Load = minutes x RPE. Include matches; this is what the acute:chronic ratio is built from.',
  input: z.object({ date: day.optional(), kind: z.enum(['training', 'match', 'gym', 'other']).default('training'), minutes: z.number().int().min(1).max(600), rpe: z.number().int().min(1).max(10) }),
  handler: ({ user }, i) => one(
    `INSERT INTO session_loads(user_id, session_date, kind, minutes, rpe) VALUES ($1,$2,$3,$4,$5) RETURNING id, session_date::text AS session_date, kind, minutes, rpe, load`,
    [user.id, notFuture(i.date ?? today()), i.kind, i.minutes, i.rpe]),
});

cap({
  name: 'list_session_loads', method: 'GET', path: '/me/loads', tag: TAG,
  summary: 'Your logged sessions (default last 28 days), newest first.',
  input: z.object({ from: day.optional(), to: day.optional() }),
  handler: ({ user }, i) => {
    const to = i.to ?? today();
    return many(`SELECT id, session_date::text AS session_date, kind, minutes, rpe, load FROM session_loads WHERE user_id=$1 AND archived_at IS NULL AND session_date BETWEEN $2 AND $3 ORDER BY session_date DESC, created_at DESC LIMIT 500`, [user.id, i.from ?? plusDays(to, -27), to]);
  },
});

cap({
  name: 'archive_session_load', method: 'POST', path: '/me/loads/:id/archive', tag: TAG,
  summary: 'Remove a logged session from your workload (archived, not deleted).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('UPDATE session_loads SET archived_at=now() WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id, archived_at', [i.id, user.id]);
    if (!row) throw notFound('Session');
    return row;
  },
});

const loadsFor = (userId, date) => many('SELECT session_date::text AS session_date, load FROM session_loads WHERE user_id=$1 AND archived_at IS NULL AND session_date BETWEEN $2 AND $3', [userId, plusDays(date, -90), date]);

cap({
  name: 'get_workload', method: 'GET', path: '/me/workload', tag: TAG,
  summary: 'Acute:chronic workload ratio (7-day load vs your 28-day weekly average) with a band (low, optimal, caution, high) and eight weekly totals for a chart. "building" until you have three weeks of logs.',
  input: z.object({ date: day.optional() }),
  async handler({ user }, i) { const date = i.date ?? today(); return workload(await loadsFor(user.id, date), date); },
});

cap({
  name: 'get_readiness', method: 'GET', path: '/me/readiness', tag: TAG,
  summary: 'Your daily readiness score (0-100) from sleep, soreness and mood, with what is missing. Open body-map entries stand in for soreness, and a high workload ratio takes points off. Guidance only, not a diagnosis. Score is null until you log something.',
  input: z.object({ date: day.optional() }),
  async handler({ user }, i) {
    const date = i.date ?? today();
    const [wellness, pain, loads] = await Promise.all([
      one('SELECT sleep_hours, sleep_quality, soreness, mood, water_ml FROM wellness_logs WHERE user_id=$1 AND log_date=$2', [user.id, date]),
      many(`SELECT DISTINCT ON (region, side, kind) severity FROM body_pain_logs WHERE user_id=$1 AND resolved_at IS NULL ORDER BY region, side, kind, created_at DESC`, [user.id]),
      loadsFor(user.id, date),
    ]);
    const wl = workload(loads, date);
    return { date, ...readiness({ wellness, pain, acwr: wl }), logged: !!wellness, open_pain: pain.length, workload: { ratio: wl.ratio, status: wl.status }, water_ml: wellness?.water_ml ?? 0 };
  },
});
