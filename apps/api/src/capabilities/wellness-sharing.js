import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { guardianLink, requireConsent } from '../youth.js';
import { RELATIONSHIP_SQL } from '../coaching.js';
import { toCsv } from '../csv.js';
import { readiness, workload } from '../readiness.js';
import { FIELDS, PURPOSES, KINDS, accessBlock, shareBlock, shareState, reasonText } from '../wellness-sharing.js';

const TAG = 'Athlete health';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fields = z.array(z.enum(FIELDS)).min(1).max(FIELDS.length).describe('what the recipient may see: sleep, soreness, mood, hydration, readiness, workload, body_map. Private notes can never be shared.');
const expiresOn = day.describe('last day of access (UTC); at most one year ahead');

/** end of `d` (UTC) as a timestamp; validates the window. */
const endOf = (d) => {
  if (d < today()) throw badRequest('The end date is in the past');
  if (d > plusDays(today(), 365)) throw badRequest('Sharing can run for at most one year; renew it later');
  return `${plusDays(d, 1)}T00:00:00Z`;
};

const BARE = 'id, athlete_id, recipient_id, recipient_kind, purpose, fields, history_days, expires_at, version, revoked_at, created_at, updated_at';
const SHARE_COLS = 's.id, s.athlete_id, s.recipient_id, s.recipient_kind, s.purpose, s.fields, s.history_days, s.expires_at, s.version, s.revoked_at, s.created_at, s.updated_at';
const event = (c, s, actor, action, detail = {}) => c.query('INSERT INTO wellness_share_events(share_id, athlete_id, recipient_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, s.athlete_id, s.recipient_id, actor, action, detail]);

/** The athlete themself, or a verified guardian of a young athlete. */
async function ownerOf(user, athleteId) {
  if (user.id === athleteId || isAdmin(user)) return athleteId;
  if (await guardianLink(user.id, athleteId)) return athleteId;
  throw notFound('Share'); // never reveal that it exists
}

// ---------- athlete: choose who ----------

cap({
  name: 'list_wellness_share_recipients', method: 'GET', path: '/me/wellness-shares/recipients', tag: TAG,
  summary: 'Who you can share wellness with: coaches who currently coach you, and physios/doctors you have already given medical access. Team or sponsor membership alone does not appear here.',
  input: z.object({ q: z.string().trim().max(60).optional() }),
  async handler({ user }, i) {
    const like = i.q ? `%${i.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const coaches = await many(
      `SELECT DISTINCT u.id, u.display_name, u.handle, 'coach' AS kind, 'Coaches you' AS detail FROM (${RELATIONSHIP_SQL}) r JOIN users u ON u.id=r.coach_id
        WHERE r.athlete_id=$1 AND u.id <> $1 AND ($2::text IS NULL OR u.display_name ILIKE $2 OR u.handle ILIKE $2) ORDER BY u.display_name, u.id LIMIT 50`, [user.id, like]);
    const providers = await many(
      `SELECT u.id, u.display_name, u.handle, 'provider' AS kind, g.scope AS detail FROM medical_grants g JOIN users u ON u.id=g.provider_id
        WHERE g.athlete_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full' AND ($2::text IS NULL OR u.display_name ILIKE $2 OR u.handle ILIKE $2) ORDER BY u.display_name, u.id LIMIT 50`, [user.id, like]);
    const out = [];
    for (const r of [...coaches, ...providers]) { if (!(await accessBlock({ query }, user.id, r.id, r.kind))) out.push(r); }
    return out;
  },
});

// ---------- athlete: create / edit / revoke ----------

cap({
  name: 'create_wellness_share', method: 'POST', path: '/me/wellness-shares', tag: TAG, status: 201,
  summary: 'Share chosen wellness fields with a coach or clinician for a purpose, a number of past days and until a date. Repeating the same request returns the share you already have; a different one for the same person and purpose must be edited instead. Young people need a guardian\'s current consent.',
  input: z.object({ recipient_id: id, purpose: z.enum(PURPOSES), fields, history_days: z.number().int().min(1).max(365).default(30), expires_on: expiresOn }),
  async handler({ user }, i) {
    if (i.recipient_id === user.id) throw badRequest('You cannot share with yourself');
    const rec = await one('SELECT id, display_name FROM users WHERE id=$1', [i.recipient_id]);
    if (!rec) throw notFound('Recipient');
    const fs = [...new Set(i.fields)].sort((a, b) => FIELDS.indexOf(a) - FIELDS.indexOf(b));
    const expires = endOf(i.expires_on);
    return tx(async (c) => {
      // the athlete row is the lock that serialises concurrent shares/edits for this athlete
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const kinds = [];
      for (const k of ['coach', 'provider']) if (!(await accessBlock(c, user.id, rec.id, k))) kinds.push(k);
      if (!kinds.length) {
        for (const k of ['coach', 'provider']) await requireConsent(user.id, KINDS[k], 'sharing wellness', c);
        throw forbidden('You can share with a coach who currently coaches you, or a verified physio/doctor you have given medical access');
      }
      const kind = kinds[0];
      await requireConsent(user.id, KINDS[kind], 'sharing wellness', c);
      // retire a lapsed share for the same person and purpose so it cannot block a fresh one (history stays)
      for (const e of (await c.query("UPDATE wellness_shares SET revoked_at=now(), revoked_by=NULL WHERE athlete_id=$1 AND recipient_id=$2 AND purpose=$3 AND revoked_at IS NULL AND expires_at <= now() RETURNING id, athlete_id, recipient_id", [user.id, rec.id, i.purpose])).rows) await event(c, e, null, 'expired');
      const live = (await c.query(`SELECT ${SHARE_COLS} FROM wellness_shares s WHERE s.athlete_id=$1 AND s.recipient_id=$2 AND s.purpose=$3 AND s.revoked_at IS NULL FOR UPDATE`, [user.id, rec.id, i.purpose])).rows[0];
      if (live) {
        const same = live.recipient_kind === kind && live.history_days === i.history_days && live.fields.join() === fs.join() && new Date(live.expires_at).getTime() === Date.parse(expires);
        if (same) return live; // duplicate / retry: idempotent
        throw conflict('You are already sharing for this purpose with this person. Edit that share instead.', { code: 'share_exists', share_id: live.id, version: live.version });
      }
      const s = (await c.query(`INSERT INTO wellness_shares(athlete_id, recipient_id, recipient_kind, purpose, fields, history_days, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING ${BARE}`, [user.id, rec.id, kind, i.purpose, fs, i.history_days, expires])).rows[0];
      await event(c, s, user.id, 'granted', { fields: fs, purpose: i.purpose, history_days: i.history_days, expires_at: expires });
      await audit(c, user.id, 'grant_wellness_share', 'wellness_shares', s.id);
      await notify(c, rec.id, { kind: 'wellness_shared', title: 'An athlete shared wellness with you', body: 'Open Shared wellness to see what they chose to share.', data: { screen: 'SharedWellness', share_id: s.id }, dedupe_key: `wellness_shared:${s.id}` });
      return s;
    });
  },
});

cap({
  name: 'update_wellness_share', method: 'PATCH', path: '/me/wellness-shares/:id', tag: TAG,
  summary: 'Change what a live share covers (fields, past days, end date). Send the `version` you last saw: if it changed elsewhere you get a 409 and must reload. Narrowing takes effect immediately.',
  input: z.object({ id, version: z.number().int().min(1), fields: fields.optional(), history_days: z.number().int().min(1).max(365).optional(), expires_on: expiresOn.optional() }),
  async handler({ user }, i) {
    if (i.fields === undefined && i.history_days === undefined && i.expires_on === undefined) throw badRequest('Nothing to change');
    const fs = i.fields ? [...new Set(i.fields)].sort((a, b) => FIELDS.indexOf(a) - FIELDS.indexOf(b)) : null;
    const expires = i.expires_on ? endOf(i.expires_on) : null;
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM wellness_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      await ownerOf(user, s.athlete_id);
      if (s.revoked_at || new Date(s.expires_at) <= new Date()) throw conflict('This share has ended. Create a new one.', { code: 'share_ended' });
      if (s.version !== i.version) throw conflict('This share changed since you opened it. Reload and try again.', { code: 'stale_version', version: s.version });
      const u = (await c.query(`UPDATE wellness_shares SET fields=coalesce($2::text[], fields), history_days=coalesce($3::int, history_days), expires_at=coalesce($4::timestamptz, expires_at), version=version+1, updated_at=now() WHERE id=$1
        RETURNING ${BARE}`, [s.id, fs, i.history_days ?? null, expires])).rows[0];
      await event(c, s, user.id, 'updated', { fields: u.fields, history_days: u.history_days, expires_at: u.expires_at });
      await audit(c, user.id, 'update_wellness_share', 'wellness_shares', s.id);
      return u;
    });
  },
});

cap({
  name: 'revoke_wellness_share', method: 'POST', path: '/me/wellness-shares/:id/revoke', tag: TAG,
  summary: 'Stop sharing. Access ends on the recipient\'s next read; the share and everything it showed stay in your history. Repeating it is harmless. A verified guardian can do this for a young athlete.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM wellness_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      await ownerOf(user, s.athlete_id);
      if (s.revoked_at) return { id: s.id, state: 'revoked', revoked_at: s.revoked_at };
      const r = (await c.query('UPDATE wellness_shares SET revoked_at=now(), revoked_by=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING revoked_at', [s.id, user.id])).rows[0];
      await event(c, s, user.id, 'revoked');
      await audit(c, user.id, 'revoke_wellness_share', 'wellness_shares', s.id);
      await notify(c, s.recipient_id, { kind: 'wellness_share_revoked', title: 'Wellness sharing stopped', body: 'An athlete stopped sharing wellness with you.', data: { screen: 'SharedWellness' }, dedupe_key: `wellness_share_revoked:${s.id}` });
      return { id: s.id, state: 'revoked', revoked_at: r.revoked_at };
    });
  },
});

cap({
  name: 'list_wellness_shares', method: 'GET', path: '/me/wellness-shares', tag: TAG,
  summary: 'Your sharing (or a young athlete\'s, for their guardian): every share with its state, whether the recipient can see it right now and why not, how often it was viewed, and a recent activity log.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = await ownerOf(user, i.athlete_id ?? user.id).catch(() => { throw forbidden('You are not a verified guardian of this young person'); });
    const rows = await many(
      `SELECT ${SHARE_COLS}, u.display_name AS recipient_name, u.handle AS recipient_handle,
              (SELECT count(*)::int FROM wellness_share_events e WHERE e.share_id=s.id AND e.action='viewed') AS views,
              (SELECT max(e.created_at) FROM wellness_share_events e WHERE e.share_id=s.id AND e.action='viewed') AS last_viewed_at
         FROM wellness_shares s JOIN users u ON u.id=s.recipient_id WHERE s.athlete_id=$1 ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [athlete, i.limit, i.offset]);
    const shares = [];
    for (const s of rows) {
      const state = shareState(s);
      const block = state === 'active' ? await shareBlock({ query }, s) : null;
      shares.push({ ...s, state, live: state === 'active' && !block, blocked_reason: block ? reasonText(block) : null });
    }
    const activity = await many(
      `SELECT e.id, e.share_id, e.action, e.created_at, u.display_name AS recipient_name FROM wellness_share_events e JOIN users u ON u.id=e.recipient_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC, e.id LIMIT 30`, [athlete]);
    return { shares, activity };
  },
});

// ---------- recipient: see what was shared ----------

cap({
  name: 'list_wellness_shared_with_me', method: 'GET', path: '/wellness-shared', tag: TAG,
  summary: 'Coach / clinician: athletes who share wellness with you, what they chose, and whether you can see it right now. Shares that ended or whose relationship or consent lapsed show why, without data.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT s.id, s.athlete_id, s.recipient_kind, s.purpose, s.fields, s.history_days, s.expires_at, s.revoked_at, s.created_at, u.display_name AS athlete_name, u.handle AS athlete_handle
         FROM wellness_shares s JOIN users u ON u.id=s.athlete_id WHERE s.recipient_id=$1 AND (s.revoked_at IS NULL OR s.revoked_at > now() - interval '30 days')
        ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, u.display_name, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    const out = [];
    for (const s of rows) {
      const state = shareState(s);
      const block = state === 'active' ? await shareBlock({ query }, { ...s, recipient_id: user.id }) : state;
      out.push({ ...s, state, live: !block, blocked_reason: block ? reasonText(block) : null });
    }
    return out;
  },
});

const num = (v) => (v == null ? null : Number(v));
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** Everything a recipient may see for a share, limited to the chosen fields and window. Runs inside the caller's transaction; the share row is locked FOR SHARE so a revoke waits for it. */
async function sharedView(c, user, shareId, { from, to } = {}, action) {
  const s = (await c.query('SELECT * FROM wellness_shares WHERE id=$1 AND recipient_id=$2 FOR SHARE', [shareId, user.id])).rows[0];
  if (!s) throw notFound('Share');
  const block = await shareBlock(c, s);
  if (block) throw forbidden(reasonText(block));
  const end = to ?? today(), start = from ?? plusDays(end, -(s.history_days - 1));
  const floor = plusDays(today(), -(s.history_days - 1));
  const f = new Set(s.fields);
  const lo = start < floor ? floor : start, hi = end > today() ? today() : end;
  if (hi < lo) throw badRequest('to is before from');
  const logs = (await c.query('SELECT log_date::text AS log_date, sleep_hours, sleep_quality, soreness, mood, water_ml FROM wellness_logs WHERE user_id=$1 AND log_date BETWEEN $2 AND $3 ORDER BY log_date DESC', [s.athlete_id, lo, hi])).rows;
  const days = logs.map((l) => ({
    date: l.log_date,
    ...(f.has('sleep') ? { sleep_hours: num(l.sleep_hours), sleep_quality: l.sleep_quality } : {}),
    ...(f.has('soreness') ? { soreness: l.soreness } : {}),
    ...(f.has('mood') ? { mood: l.mood } : {}),
    ...(f.has('hydration') ? { water_ml: l.water_ml } : {}),
  })).filter((d) => Object.keys(d).length > 1);
  const out = {
    share: { id: s.id, purpose: s.purpose, fields: s.fields, history_days: s.history_days, expires_at: s.expires_at },
    athlete: (await c.query('SELECT id, display_name, handle FROM users WHERE id=$1', [s.athlete_id])).rows[0],
    window: { from: lo, to: hi }, days,
    summary: {
      ...(f.has('sleep') ? { avg_sleep_hours: avg(logs.map((l) => num(l.sleep_hours)).filter((v) => v !== null)) } : {}),
      ...(f.has('soreness') ? { avg_soreness: avg(logs.map((l) => l.soreness).filter((v) => v !== null)) } : {}),
      ...(f.has('mood') ? { avg_mood: avg(logs.map((l) => l.mood).filter((v) => v !== null)) } : {}),
      ...(f.has('hydration') ? { avg_water_ml: avg(logs.map((l) => l.water_ml).filter((v) => v !== null)) } : {}),
    },
    not_shared: FIELDS.filter((x) => !f.has(x)).concat('notes'),
    basis: 'self_reported', note: 'Logged by the athlete. Guidance for coaching and care conversations, not a diagnosis.',
  };
  if (f.has('readiness') || f.has('workload')) {
    const date = hi;
    const loads = (await c.query('SELECT session_date::text AS session_date, load FROM session_loads WHERE user_id=$1 AND archived_at IS NULL AND session_date BETWEEN $2 AND $3', [s.athlete_id, plusDays(date, -90), date])).rows;
    const wl = workload(loads, date);
    if (f.has('workload')) {
      // the unified load history inside the shared window: where each load came from and whether the athlete corrected it, never reasons, titles or teams
      const entries = (await c.query(
        `SELECT l.id, l.session_date::text AS session_date, l.kind, l.minutes, l.rpe, l.load, l.source, l.minutes_basis,
                EXISTS (SELECT 1 FROM session_load_revisions r WHERE r.load_id=l.id AND r.action='corrected') AS corrected
           FROM session_loads l WHERE l.user_id=$1 AND l.archived_at IS NULL AND l.session_date BETWEEN $2 AND $3 ORDER BY l.session_date DESC, l.created_at DESC, l.id LIMIT 500`, [s.athlete_id, lo, hi])).rows;
      out.workload = { ratio: wl.ratio, status: wl.status, weeks: wl.weeks, entries };
    }
    if (f.has('readiness')) {
      const wellness = (await c.query('SELECT sleep_hours, sleep_quality, soreness, mood FROM wellness_logs WHERE user_id=$1 AND log_date=$2', [s.athlete_id, date])).rows[0] ?? null;
      const pain = (await c.query('SELECT DISTINCT ON (region, side, kind) severity FROM body_pain_logs WHERE user_id=$1 AND resolved_at IS NULL ORDER BY region, side, kind, created_at DESC', [s.athlete_id])).rows;
      const r = readiness({ wellness, pain, acwr: wl });
      out.readiness = { date, score: r.score, band: r.band };
    }
  }
  if (f.has('body_map')) {
    out.body_map = (await c.query(`SELECT DISTINCT ON (region, side, kind) region, side, kind, severity, started_on::text AS started_on FROM body_pain_logs WHERE user_id=$1 AND resolved_at IS NULL ORDER BY region, side, kind, created_at DESC`, [s.athlete_id])).rows;
  }
  await event(c, s, user.id, action, { from: lo, to: hi });
  await audit(c, user.id, action === 'exported' ? 'export_wellness_shared' : 'read_wellness_shared', 'wellness_shares', s.id);
  return out;
}

cap({
  name: 'get_shared_wellness', method: 'GET', path: '/wellness-shared/:id', tag: TAG,
  summary: 'Coach / clinician: the wellness an athlete shared through one share, limited to the fields and past days they chose (private notes never included). Access is re-checked on every call and each view is audit-logged and visible to the athlete.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  handler: ({ user }, i) => tx((c) => sharedView(c, user, i.id, i, 'viewed')),
});

cap({
  name: 'export_shared_wellness', method: 'GET', path: '/wellness-shared/:id/export', tag: TAG,
  summary: 'Coach / clinician: the same shared data as CSV (one row per logged day, only the chosen fields). Same live checks as viewing; the export is audit-logged and visible to the athlete.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const v = await sharedView(c, user, i.id, i, 'exported');
    const cols = ['date', ...['sleep_hours', 'sleep_quality', 'soreness', 'mood', 'water_ml'].filter((k) => v.days.some((d) => k in d))];
    const loadCols = ['session_date', 'kind', 'source', 'minutes', 'minutes_basis', 'rpe', 'load', 'corrected'];
    return { filename: `wellness-${v.athlete.handle}-${v.window.from}-${v.window.to}.csv`, content_type: 'text/csv', csv: toCsv(cols, v.days), rows: v.days.length, ...(v.workload ? { loads_filename: `load-history-${v.athlete.handle}-${v.window.from}-${v.window.to}.csv`, loads_csv: toCsv(loadCols, v.workload.entries), load_rows: v.workload.entries.length } : {}), basis: v.basis, not_shared: v.not_shared };
  }),
});
