import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { hasConsent } from '../youth.js';
import { revokeSession } from '../sessions.js';
import { toErrorBody } from '../invoke.js';
import { CORE_KEYS, normaliseMatch, ownProfile, COLS, rowParams } from './player.js';

// Offline player capture and reliable synchronisation (issue #336). The app keeps match logs, workout logs and training loads as
// encrypted drafts on the device and uploads them here in batches. Every operation carries a client_key, so a retry after a dropped
// connection, a double tap or a second device never creates a second record. A change made from an out-of-date copy is not applied
// silently: it becomes a conflict that the player settles (keep mine / keep the server's / merge field by field), and whichever
// version loses is kept. Consent and ownership are checked again at sync time, so a draft written before a guardian withdrew
// consent or a coach link ended is refused (and kept on the device), never applied.
const TAG = 'Offline sync';
const key = z.string().trim().min(8).max(80).describe('idempotency key made on the device when the draft was saved');
const when = z.string().datetime({ offset: true }).optional().describe('when the player captured it (shown in the queue; the server never trusts it for ordering rules)');
const MAX_OPS = 50;
const PLATFORMS = ['ios', 'ipados', 'android', 'web'];

const matchChanges = z.object(Object.fromEntries([
  ...CORE_KEYS.map((k) => [k, z.any().optional()]),
  ['stats', z.record(z.string(), z.number()).optional()],
])).strict();

const opSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('match_create'), client_key: key, captured_at: when,
    data: z.object({ sport_profile_id: id }).passthrough().describe('the same fields as record_match') }),
  z.object({ kind: z.literal('match_update'), client_key: key, captured_at: when, target_id: id,
    base_version: z.number().int().min(1).describe('row_version of the match when the draft was started'),
    changes: matchChanges }),
  z.object({ kind: z.literal('workout_log'), client_key: key, captured_at: when, session_id: id,
    expected_version: z.number().int().min(1), status: z.enum(['completed', 'skipped']).optional(), athlete_rpe: z.number().int().min(1).max(10).optional(),
    athlete_feedback: z.string().max(1000).optional(), actuals: z.any().optional() }),
  z.object({ kind: z.literal('load_log'), client_key: key, captured_at: when,
    data: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), kind: z.enum(['training', 'match', 'gym', 'other']).default('training'),
      minutes: z.number().int().min(1).max(600), rpe: z.number().int().min(1).max(10) }) }),
]);

const deviceIn = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/).describe('random id the app makes once per install'),
  label: z.string().trim().max(60).optional(), platform: z.enum(PLATFORMS),
});

const PAYLOAD_CTX = 'sync_operations.payload';
const SNAPSHOT_CTX = 'player_match_revisions.snapshot';
const sealed = (op) => encrypt(JSON.stringify(op), PAYLOAD_CTX);
const unsealed = (enc) => JSON.parse(decrypt(enc, PAYLOAD_CTX));
const cap_ = (name) => capabilities.find((c) => c.name === name);

const revoked = () => new AppError(403, 'device_revoked', 'This device was signed out of syncing. Its saved drafts must be removed from it.', { wipe: true });

/** Make sure the device is known, not revoked, and remember which login session it is using. */
async function touchDevice(user, d, queued) {
  // a signed-out device is never updated: it must not take over another login session or look active again
  if (await one('SELECT 1 FROM sync_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NOT NULL', [user.id, d.id])) throw revoked();
  const row = await one(
    `INSERT INTO sync_devices(user_id, device_id, label, platform, session_id, last_sync_at, last_queued)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() END, coalesce($6,0))
     ON CONFLICT (user_id, device_id) DO UPDATE SET label=coalesce(EXCLUDED.label, sync_devices.label), platform=EXCLUDED.platform,
       session_id=coalesce(EXCLUDED.session_id, sync_devices.session_id),
       last_sync_at=CASE WHEN $6::int IS NULL THEN sync_devices.last_sync_at ELSE now() END, last_queued=coalesce($6, sync_devices.last_queued)
     RETURNING *`,
    [user.id, d.id, d.label ?? null, d.platform, user.session_id ?? null, queued ?? null]);
  return row;
}

const matchRow = (c, userId, matchId) => c.query(
  `SELECT id, sport_profile_id, played_on::text AS played_on, opponent, venue, competition, result, score_for, score_against, minutes, rating, notes, stats, match_type, row_version
     FROM player_matches WHERE id=$1 AND user_id=$2 AND archived_at IS NULL FOR UPDATE`, [matchId, userId]).then((r) => r.rows[0]);

const MATCH_COLS = ['played_on', 'opponent', 'venue', 'competition', 'result', 'score_for', 'score_against', 'minutes', 'rating', 'notes', 'stats', 'match_type'];
/** Write `changes` over the current row (one revision kept) and bump row_version. */
async function writeMatch(c, userId, cur, changes, reason) {
  const raw = { ...Object.fromEntries(CORE_KEYS.map((k) => [k, cur[k]])), ...changes, stats: { ...(cur.stats ?? {}), ...(changes.stats ?? {}) } };
  const r = normaliseMatch(raw);
  if (r.errors) throw badRequest('Invalid match', r.errors);
  await c.query('INSERT INTO player_match_revisions(match_id, row_version, snapshot_enc, reason) VALUES ($1,$2,$3,$4)',
    [cur.id, cur.row_version, encrypt(JSON.stringify(cur), SNAPSHOT_CTX), reason]);
  const m = r.value;
  const vals = [m.played_on, m.opponent ?? null, m.venue ?? null, m.competition ?? null, m.result ?? null, m.score_for ?? null, m.score_against ?? null, m.minutes ?? null, m.rating ?? null, m.notes ?? null, JSON.stringify(m.stats), m.match_type ?? null];
  const set = MATCH_COLS.map((k, n) => `${k}=$${n + 3}`).join(', ');
  return (await c.query(`UPDATE player_matches SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id, row_version`, [cur.id, userId, ...vals])).rows[0];
}

const staleVersion = (extra) => conflict('This record changed on another device after your draft was started', { code: 'stale_version', ...extra });

/** Coach-assigned workouts need current coaching consent when the player is young; self-reported matches and loads stay private to the player. */
async function checkWorkoutAccess(c, user, sessionId) {
  const s = (await c.query('SELECT p.athlete_id, p.coach_id FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE s.id=$1', [sessionId])).rows[0];
  if (!s || s.athlete_id !== user.id) throw notFound('Session');
  if (s.coach_id && !(await hasConsent(user.id, 'coaching', c))) {
    throw conflict('A verified guardian has not given current consent for coaching. Your draft is kept on this device.', { code: 'guardian_consent_required', purpose: 'coaching' });
  }
}

/** Apply one operation. Returns { target_id, row_version?, result }. Throws AppError for refusals and conflicts. */
async function apply(c, user, op) {
  switch (op.kind) {
    case 'match_create': {
      const { sport_profile_id, ...raw } = op.data;
      await ownProfile(user.id, sport_profile_id, c);
      const r = normaliseMatch(raw);
      if (r.errors) throw badRequest('Invalid match', r.errors);
      const ph = COLS.map((_, n) => `$${n + 1}`).join(',');
      const made = (await c.query(
        `INSERT INTO player_matches(${COLS.join(',')}) VALUES (${ph}) ON CONFLICT (user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id, row_version`,
        rowParams(user.id, sport_profile_id, { ...r.value, client_key: op.client_key }, 'manual'))).rows[0]
        ?? (await c.query('SELECT id, row_version FROM player_matches WHERE user_id=$1 AND client_key=$2', [user.id, op.client_key])).rows[0];
      return { target_id: made.id, row_version: made.row_version };
    }
    case 'match_update': {
      const cur = await matchRow(c, user.id, op.target_id);
      if (!cur) throw notFound('Match');
      if (cur.row_version !== op.base_version) throw staleVersion({ target_id: cur.id, row_version: cur.row_version });
      const w = await writeMatch(c, user.id, cur, op.changes, 'sync_update');
      return { target_id: w.id, row_version: w.row_version };
    }
    case 'load_log': {
      const d = op.data;
      const date = d.date ?? new Date().toISOString().slice(0, 10);
      if (date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) throw badRequest('A session cannot be logged for a future date');
      const made = (await c.query(
        `INSERT INTO session_loads(user_id, session_date, kind, minutes, rpe, client_key) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`, [user.id, date, d.kind, d.minutes, d.rpe, op.client_key])).rows[0]
        ?? (await c.query('SELECT id FROM session_loads WHERE user_id=$1 AND client_key=$2', [user.id, op.client_key])).rows[0];
      return { target_id: made.id };
    }
    case 'workout_log': {
      await checkWorkoutAccess(c, user, op.session_id);
      const update = cap_('update_training_session');
      const input = update.input.parse({ id: op.session_id, status: op.status, athlete_rpe: op.athlete_rpe, athlete_feedback: op.athlete_feedback, actuals: op.actuals, expected_version: op.expected_version });
      const s = await update.handler({ user, meta: {} }, input);
      return { target_id: s.id, row_version: s.version };
    }
    default: throw badRequest('Unknown operation');
  }
}

const isStale = (e) => e instanceof AppError && e.status === 409 && e.details?.code === 'stale_version';
const outcome = (e) => {
  const b = toErrorBody(e);
  if (e instanceof AppError || b.status < 500) return { code: b.code === 'conflict' ? (b.details?.code ?? 'conflict') : b.code, message: b.message, details: b.details };
  return null;
};
const draftOf = (op) => { const { kind, client_key, captured_at, ...rest } = op; return rest; };

/** Run one operation exactly once. The ledger row is claimed first, so a concurrent or repeated upload of the same key returns the first outcome. */
async function runOp(user, deviceId, op) {
  const base = { client_key: op.client_key, kind: op.kind };
  try {
    return await tx(async (c) => {
      let led = (await c.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_key=$2 FOR UPDATE', [user.id, op.client_key])).rows[0];
      if (!led) {
        led = (await c.query(
          `INSERT INTO sync_operations(user_id, device_id, client_key, kind, status, captured_at) VALUES ($1,$2,$3,$4,'rejected',$5)
           ON CONFLICT (user_id, client_key) DO NOTHING RETURNING *`, [user.id, deviceId, op.client_key, op.kind, op.captured_at ?? null])).rows[0];
        if (!led) led = (await c.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_key=$2 FOR UPDATE', [user.id, op.client_key])).rows[0];
        else led.fresh = true;
      }
      if (led.kind !== op.kind) throw badRequest('This client_key was already used for a different kind of operation');
      if (['applied', 'resolved', 'conflict'].includes(led.status) && !led.fresh) {
        return { ...base, status: led.status === 'conflict' ? 'conflict' : 'duplicate', operation_id: led.id, target_id: led.target_id, ...(led.result ?? {}), ...(led.status === 'conflict' ? { code: led.reason_code, message: led.reason } : {}) };
      }
      try {
        const sp = 'op';
        await c.query(`SAVEPOINT ${sp}`);
        let r;
        try { r = await apply(c, user, op); } catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
        await c.query(
          `UPDATE sync_operations SET status='applied', target_id=$2, base_version=$3, result=$4, payload_enc=NULL, reason_code=NULL, reason=NULL, device_id=$5, attempts=attempts+$6, updated_at=now() WHERE id=$1`,
          [led.id, r.target_id, op.base_version ?? op.expected_version ?? null, JSON.stringify(r), deviceId, led.fresh ? 0 : 1]);
        return { ...base, status: 'applied', operation_id: led.id, ...r };
      } catch (e) {
        const stale = isStale(e);
        const o = outcome(e);
        if (!o) throw e;
        const status = stale ? 'conflict' : 'rejected';
        await c.query(
          `UPDATE sync_operations SET status=$2, target_id=$3, base_version=$4, payload_enc=$5, result=$6, reason_code=$7, reason=$8, device_id=$9, attempts=attempts+$10, updated_at=now() WHERE id=$1`,
          [led.id, status, op.target_id ?? op.session_id ?? e.details?.target_id ?? null, op.base_version ?? op.expected_version ?? null, sealed(draftOf(op)),
            stale ? JSON.stringify({ target_id: e.details?.target_id ?? op.target_id ?? op.session_id ?? null, row_version: e.details?.row_version ?? e.details?.version ?? null }) : null,
            stale ? 'stale_version' : o.code, o.message, deviceId, led.fresh ? 0 : 1]);
        return { ...base, status, operation_id: led.id, code: stale ? 'stale_version' : o.code, message: o.message, retryable: !stale && ['guardian_consent_required', 'unauthorized'].includes(o.code) };
      }
    });
  } catch (e) {
    const b = toErrorBody(e);
    if (e instanceof AppError && b.status < 500) return { ...base, status: 'rejected', code: b.code, message: b.message, retryable: false };
    return { ...base, status: 'error', code: 'server_error', message: 'The server could not save this item; it will be retried', retryable: true };
  }
}

cap({
  name: 'sync_offline_batch', method: 'POST', path: '/me/sync', tag: TAG,
  summary: 'Upload drafts captured offline (match logs, edits to a match log, workout logs, training loads), up to 50 per request, in the order they were captured. Each item has a client_key: uploading the same key again returns the first outcome as `duplicate`, so retries are safe. Per item the outcome is `applied`, `duplicate`, `conflict` (the record changed elsewhere; settle it with resolve_sync_conflict), `rejected` (invalid, no longer permitted such as withdrawn guardian consent; the draft stays with the player) or `error` (retry later). A device that was signed out of syncing gets 403 `device_revoked` with details.wipe so it removes its local drafts.',
  input: z.object({ device: deviceIn, queued: z.number().int().min(0).max(10000).optional().describe('how many drafts this device still holds after this request'), ops: z.array(opSchema).min(1).max(MAX_OPS) }),
  async handler({ user }, i) {
    const dev = await touchDevice(user, i.device, i.queued ?? i.ops.length);
    const seen = new Set();
    const results = [];
    for (const op of i.ops) {
      if (seen.has(op.client_key)) { results.push({ client_key: op.client_key, kind: op.kind, status: 'rejected', code: 'bad_request', message: 'The same client_key appears twice in one request', retryable: false }); continue; }
      seen.add(op.client_key);
      results.push(await runOp(user, dev.device_id, op));
    }
    const tally = (s) => results.filter((r) => r.status === s).length;
    return { device_id: dev.device_id, synced_at: new Date().toISOString(), applied: tally('applied'), duplicate: tally('duplicate'), conflict: tally('conflict'), rejected: tally('rejected'), error: tally('error'), results };
  },
});

// ------------------------------------------------------------------------------------------------ queue on the server
const serverView = async (c, userId, row) => {
  if (row.kind === 'match_update' && row.target_id) {
    const m = (await c.query(`SELECT id, played_on::text AS played_on, opponent, venue, competition, result, score_for, score_against, minutes, rating, notes, stats, match_type, row_version FROM player_matches WHERE id=$1 AND user_id=$2`, [row.target_id, userId])).rows[0];
    return m ?? null;
  }
  if (row.kind === 'workout_log' && row.target_id) {
    return (await c.query(`SELECT s.id, s.title, s.status, s.athlete_rpe, s.athlete_feedback, s.actuals, s.version AS row_version FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE s.id=$1 AND p.athlete_id=$2`, [row.target_id, userId])).rows[0] ?? null;
  }
  return null;
};

const present = async (c, userId, r, withDraft) => {
  const out = { id: r.id, client_key: r.client_key, kind: r.kind, status: r.status, target_id: r.target_id, code: r.reason_code, message: r.reason, resolution: r.resolution, device_id: r.device_id,
    captured_at: r.captured_at, created_at: r.created_at, updated_at: r.updated_at, resolved_at: r.resolved_at };
  if (withDraft && r.payload_enc) { out.draft = unsealed(r.payload_enc); out.server = await serverView(c, userId, r); }
  return out;
};

cap({
  name: 'list_sync_operations', method: 'GET', path: '/me/sync/operations', tag: TAG,
  summary: 'Your uploaded offline items and what happened to each, newest first. Items that conflict or were refused include the draft you saved and, for conflicts, the record as it is now so the two can be compared. Reading drafts is audit-logged.',
  input: z.object({ status: z.enum(['applied', 'conflict', 'rejected', 'resolved']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT * FROM sync_operations WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]);
    const detail = rows.filter((r) => r.payload_enc);
    if (detail.length) await audit(null, user.id, 'read_sync_drafts', 'sync_operations', null);
    return Promise.all(rows.map((r) => present({ query }, user.id, r, ['conflict', 'rejected'].includes(r.status))));
  },
});

cap({
  name: 'resolve_sync_conflict', method: 'POST', path: '/me/sync/operations/:id/resolve', tag: TAG,
  summary: 'Settle a conflict. `keep_server` leaves the record as it is now (your draft is kept in the history); `keep_mine` applies your whole draft on top of the current record; `merge` (match logs only) takes only the listed `fields` from your draft. The version that is replaced is always kept (match revisions), never deleted.',
  input: z.object({ id, resolution: z.enum(['keep_mine', 'keep_server', 'merge']), fields: z.array(z.enum(CORE_KEYS)).min(1).max(CORE_KEYS.length).optional().describe('with merge: which fields to take from your draft') }),
  async handler({ user }, i) {
    if (i.resolution === 'merge' && !i.fields?.length) throw badRequest('Choose which fields to take from your draft');
    return tx(async (c) => {
      const op = (await c.query('SELECT * FROM sync_operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!op) throw notFound('Sync item');
      if (op.status === 'resolved' && op.resolution === i.resolution) return { id: op.id, status: 'resolved', resolution: op.resolution }; // safe repeat
      if (op.status !== 'conflict') throw conflict(`This item is ${op.status}, there is nothing to settle`);
      await audit(c, user.id, 'resolve_sync_conflict', 'sync_operations', op.id);
      const draft = unsealed(op.payload_enc);
      let result = op.result ?? {};
      if (i.resolution !== 'keep_server') {
        if (op.kind === 'match_update') {
          const cur = await matchRow(c, user.id, op.target_id);
          if (!cur) throw notFound('Match');
          const changes = i.resolution === 'merge' ? Object.fromEntries(i.fields.filter((f) => f in draft.changes).map((f) => [f, draft.changes[f]])) : draft.changes;
          if (i.resolution === 'merge' && !Object.keys(changes).length) throw badRequest('None of those fields were changed in your draft');
          const w = await writeMatch(c, user.id, cur, changes, i.resolution === 'merge' ? 'conflict_merge' : 'conflict_keep_mine');
          result = { target_id: w.id, row_version: w.row_version };
        } else if (op.kind === 'workout_log') {
          if (i.resolution === 'merge') throw badRequest('Merging applies to match logs; choose keep_mine or keep_server for a workout');
          await checkWorkoutAccess(c, user, op.target_id);
          const cur = (await c.query('SELECT version FROM training_sessions WHERE id=$1', [op.target_id])).rows[0];
          const update = cap_('update_training_session');
          const s = await update.handler({ user, meta: {} }, update.input.parse({ id: op.target_id, status: draft.status, athlete_rpe: draft.athlete_rpe, athlete_feedback: draft.athlete_feedback, actuals: draft.actuals, expected_version: cur.version }));
          result = { target_id: s.id, row_version: s.version };
        } else throw badRequest('This kind of item cannot conflict');
      }
      await c.query(`UPDATE sync_operations SET status='resolved', resolution=$2, result=$3, resolved_at=now(), updated_at=now() WHERE id=$1`, [op.id, i.resolution, JSON.stringify(result)]);
      return { id: op.id, status: 'resolved', resolution: i.resolution, ...result };
    });
  },
});

cap({
  name: 'discard_sync_draft', method: 'POST', path: '/me/sync/operations/:id/discard', tag: TAG,
  summary: 'Give up a refused draft (for example one whose guardian consent was withdrawn). The server keeps only the outcome; the encrypted draft text is removed from the server record.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(`UPDATE sync_operations SET payload_enc=NULL, updated_at=now() WHERE id=$1 AND user_id=$2 AND status='rejected' RETURNING id, status`, [i.id, user.id]);
    if (!r) throw notFound('Refused sync item');
    return r;
  },
});

// ------------------------------------------------------------------------------------------------ devices
const devicePublic = (d, user) => ({ id: d.id, device_id: d.device_id, label: d.label, platform: d.platform, registered_at: d.registered_at, last_sync_at: d.last_sync_at, queued: d.last_queued, revoked_at: d.revoked_at, current: !!user.session_id && d.session_id === user.session_id });

cap({
  name: 'register_sync_device', method: 'POST', path: '/me/sync/devices', tag: TAG, status: 201,
  summary: 'Name this device for offline sync (label and platform). Safe to repeat. A device that you signed out of syncing gets 403 `device_revoked`: it must wipe its drafts and register again with a new device id.',
  input: deviceIn,
  async handler({ user }, i) { return devicePublic(await touchDevice(user, i, null), user); },
});

cap({
  name: 'list_sync_devices', method: 'GET', path: '/me/sync/devices', tag: TAG,
  summary: 'Devices that sync for you, with last sync time, how many drafts each still holds, and which is this one. Signed-out devices are listed with revoked_at.',
  async handler({ user }) {
    return (await many('SELECT * FROM sync_devices WHERE user_id=$1 ORDER BY revoked_at IS NOT NULL, last_sync_at DESC NULLS LAST, registered_at DESC, id', [user.id])).map((d) => devicePublic(d, user));
  },
});

cap({
  name: 'revoke_sync_device', method: 'DELETE', path: '/me/sync/devices/:id', tag: TAG,
  summary: 'Sign a device out of offline sync: its login session ends now and its saved drafts are removed from it the next time it connects. Records already uploaded stay.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('UPDATE sync_devices SET revoked_at=coalesce(revoked_at, now()) WHERE id=$1 AND user_id=$2 RETURNING *', [i.id, user.id]);
    if (!d) throw notFound('Device');
    let signedOut = false;
    if (d.session_id) { await revokeSession(d.session_id, 'device_revoked'); signedOut = true; }
    await audit(null, user.id, 'revoke_sync_device', 'sync_devices', d.id);
    return { ...devicePublic(d, user), signed_out: signedOut };
  },
});
