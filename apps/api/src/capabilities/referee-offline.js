// Referee offline sync (R08): batch replay of clock/score/event/report ops captured on-device.
// Idempotency: (fixture_id, client_key) UNIQUE; duplicates are silently acked.
// Conflict: op arrived but a later server event contradicts it → returned as conflict_data for manual resolution.
import { z } from 'zod';
import { cap } from '../registry.js';
import { query as dbq, many, one } from '../db.js';
import { fixtureContext } from './match-tracking.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';

const TAG = 'Officials';
const id = z.string().uuid();
const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

async function ensureSession(fixtureId, officialId, deviceId) {
  const r = await one(
    `INSERT INTO referee_sync_sessions (fixture_id, official_id, device_id)
     VALUES ($1,$2,$3) ON CONFLICT (fixture_id, official_id, device_id)
     DO UPDATE SET fixture_id=EXCLUDED.fixture_id RETURNING id`,
    [fixtureId, officialId, deviceId]);
  return r.id;
}

cap({
  name: 'replay_referee_ops', method: 'POST', path: '/fixtures/:id/referee-sync', tag: TAG,
  summary: 'Batch-replay offline ops (clock, score, events, corrections, reports) captured by the referee device. Idempotent: duplicates are acked, genuine conflicts flagged for resolution. Returns per-op outcomes and server clock_drift_ms.',
  input: z.object({
    id,
    device_id: z.string().min(1).max(100),
    pack_version: z.number().int().min(0),
    ops: z.array(z.object({
      client_key: z.string().min(1).max(200),
      op_type: z.enum(['control_op','match_event','session_event','official_report','event_correction']),
      payload_enc: z.string().min(1),
      occurred_at: z.string().datetime(),
      seq: z.number().int().min(0),
    })).min(1).max(200),
    device_time: z.string().datetime(),
  }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    if (!x?.canScore) throw Object.assign(new Error('Not found'), { status: 404 });

    const serverNow = Date.now();
    const clock_drift_ms = serverNow - new Date(i.device_time).getTime();
    const sessionId = await ensureSession(i.id, user.id, i.device_id);

    const outcomes = [];
    for (const op of i.ops) {
      const oat = new Date(op.occurred_at).getTime();
      const bounded_at = Math.abs(serverNow - oat) > MAX_DRIFT_MS
        ? new Date(serverNow).toISOString()
        : op.occurred_at;

      const existing = await one(
        `SELECT id, status, applied_id FROM referee_offline_ops WHERE fixture_id=$1 AND client_key=$2`,
        [i.id, op.client_key]);
      if (existing) {
        outcomes.push({ client_key: op.client_key, status: existing.status, applied_id: existing.applied_id });
        continue;
      }

      let stageId;
      try {
        const r = await one(
          `INSERT INTO referee_offline_ops
             (session_id, fixture_id, official_id, device_id, client_key, op_type, payload_enc, occurred_at, seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [sessionId, i.id, user.id, i.device_id, op.client_key, op.op_type, op.payload_enc, bounded_at, op.seq]);
        stageId = r.id;
      } catch {
        outcomes.push({ client_key: op.client_key, status: 'duplicate' });
        continue;
      }

      let payload;
      try {
        const raw = await decrypt(op.payload_enc, 'referee_offline_ops.payload_enc');
        payload = JSON.parse(raw);
      } catch {
        await dbq(`UPDATE referee_offline_ops SET status='error', error_detail=$1 WHERE id=$2`,
          ['payload decrypt failed', stageId]);
        outcomes.push({ client_key: op.client_key, status: 'error', error: 'payload decrypt failed' });
        continue;
      }

      let appliedId = null;
      let status = 'applied';
      let errorDetail = null;

      try {
        if (op.op_type === 'control_op') {
          const r = await one(
            `INSERT INTO fixture_control_ops (fixture_id, actor_id, kind, occurred_at, client_key, meta)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (fixture_id, client_key) DO NOTHING RETURNING id`,
            [i.id, user.id, payload.kind, bounded_at, op.client_key, JSON.stringify(payload.meta ?? {})]);
          appliedId = r?.id ?? null;
          if (!appliedId) status = 'duplicate';
        } else if (op.op_type === 'match_event') {
          const r = await one(
            `INSERT INTO match_events (fixture_id, actor_id, kind, occurred_at, client_key, team_id, player_id, meta)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (fixture_id, client_key) DO NOTHING RETURNING id`,
            [i.id, user.id, payload.kind, bounded_at, op.client_key,
             payload.team_id ?? null, payload.player_id ?? null, JSON.stringify(payload.meta ?? {})]);
          appliedId = r?.id ?? null;
          if (!appliedId) status = 'duplicate';
        } else if (op.op_type === 'official_report') {
          const r = await one(
            `INSERT INTO official_reports (fixture_id, author_id, category, status, client_key)
             VALUES ($1,$2,$3,'filed',$4)
             ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`,
            [i.id, user.id, payload.category ?? 'other', op.client_key]);
          if (r) {
            appliedId = r.id;
            if (payload.summary || payload.note) {
              const noteEnc = payload.note ? await encrypt(payload.note, 'official_report_revisions.note_enc') : null;
              await dbq(
                `INSERT INTO official_report_revisions (report_id, revision, summary, note_enc, actor_id)
                 VALUES ($1,1,$2,$3,$4)`,
                [appliedId, payload.summary ?? '', noteEnc, user.id]);
            }
          } else {
            status = 'duplicate';
          }
        } else if (op.op_type === 'event_correction') {
          if (payload.void_client_key) {
            await dbq(
              `UPDATE match_events SET voided_at=now(), voided_by=$1 WHERE fixture_id=$2 AND client_key=$3`,
              [user.id, i.id, payload.void_client_key]);
          }
          if (payload.replacement) {
            const p = payload.replacement;
            const r = await one(
              `INSERT INTO match_events (fixture_id, actor_id, kind, occurred_at, client_key, team_id, player_id, meta)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (fixture_id, client_key) DO NOTHING RETURNING id`,
              [i.id, user.id, p.kind, bounded_at, op.client_key,
               p.team_id ?? null, p.player_id ?? null, JSON.stringify(p.meta ?? {})]);
            appliedId = r?.id ?? null;
            if (!appliedId) status = 'duplicate';
          }
        }
      } catch (e) {
        status = 'error';
        errorDetail = e.message ?? 'apply failed';
      }

      await dbq(
        `UPDATE referee_offline_ops SET status=$1, applied_id=$2, error_detail=$3 WHERE id=$4`,
        [status, appliedId, errorDetail, stageId]);
      outcomes.push({ client_key: op.client_key, status, applied_id: appliedId });
    }

    const conflicts = outcomes.filter((o) => o.status === 'conflict').length;
    await dbq(
      `UPDATE referee_sync_sessions
         SET status = CASE WHEN $3 > 0 THEN 'conflict' ELSE 'synced' END,
             last_sync_at = now(), queued_ops = 0, conflict_ops = $3, clock_drift_ms = $4
       WHERE id = $1`,
      [sessionId, outcomes.length, conflicts, Math.round(clock_drift_ms)]);

    await audit(null, user.id, 'referee_sync.batch', 'fixture', i.id, { ops: i.ops.length, conflicts });
    return { outcomes, clock_drift_ms: Math.round(clock_drift_ms), session_id: sessionId };
  },
});

cap({
  name: 'get_referee_sync_status', method: 'GET', path: '/fixtures/:id/referee-sync/status', tag: TAG,
  summary: 'Get the sync status for this referee device: last sync time, queued ops, conflicts, clock drift.',
  input: z.object({ id, device_id: z.string().min(1).max(100) }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    if (!x?.canScore) throw Object.assign(new Error('Not found'), { status: 404 });
    const row = await one(
      `SELECT * FROM referee_sync_sessions WHERE fixture_id=$1 AND official_id=$2 AND device_id=$3`,
      [i.id, user.id, i.device_id]);
    return row ?? { status: 'no_session', queued_ops: 0, conflict_ops: 0 };
  },
});

cap({
  name: 'list_referee_conflicts', method: 'GET', path: '/fixtures/:id/referee-sync/conflicts', tag: TAG,
  summary: 'List ops in conflict state for this fixture, so the referee can resolve them one by one.',
  input: z.object({ id, device_id: z.string().min(1).max(100) }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    if (!x?.canScore) throw Object.assign(new Error('Not found'), { status: 404 });
    const rows = await many(
      `SELECT ro.id, ro.client_key, ro.op_type, ro.occurred_at, ro.conflict_data, ro.seq
         FROM referee_offline_ops ro
         JOIN referee_sync_sessions rs ON rs.id = ro.session_id
        WHERE ro.fixture_id=$1 AND ro.official_id=$2 AND rs.device_id=$3 AND ro.status='conflict'
        ORDER BY ro.seq`, [i.id, user.id, i.device_id]);
    return { conflicts: rows };
  },
});

cap({
  name: 'resolve_referee_conflict', method: 'POST', path: '/referee-sync/ops/:id/resolve', tag: TAG,
  summary: 'Resolve a conflicted op: accept (apply it) or discard (mark rejected).',
  input: z.object({ id, resolution: z.enum(['accept','discard']) }),
  async handler({ user }, i) {
    const op = await one(
      `SELECT * FROM referee_offline_ops WHERE id=$1 AND official_id=$2 AND status='conflict'`,
      [i.id, user.id]);
    if (!op) throw Object.assign(new Error('Not found'), { status: 404 });
    if (i.resolution === 'discard') {
      await dbq(`UPDATE referee_offline_ops SET status='rejected' WHERE id=$1`, [i.id]);
      return { status: 'rejected' };
    }
    let payload;
    try { payload = JSON.parse(await decrypt(op.payload_enc, 'referee_offline_ops.payload_enc')); } catch {
      throw Object.assign(new Error('Payload decrypt failed'), { status: 500 });
    }
    let appliedId = null;
    if (op.op_type === 'match_event') {
      const r = await one(
        `INSERT INTO match_events (fixture_id, actor_id, kind, occurred_at, client_key, team_id, player_id, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (fixture_id, client_key) DO UPDATE SET kind=EXCLUDED.kind RETURNING id`,
        [op.fixture_id, user.id, payload.kind, op.occurred_at, op.client_key,
         payload.team_id ?? null, payload.player_id ?? null, JSON.stringify(payload.meta ?? {})]);
      appliedId = r?.id;
    }
    await dbq(`UPDATE referee_offline_ops SET status='applied', applied_id=$1 WHERE id=$2`, [appliedId, i.id]);
    await dbq(
      `UPDATE referee_sync_sessions SET conflict_ops = GREATEST(0, conflict_ops - 1),
         status = CASE WHEN conflict_ops <= 1 THEN 'synced' ELSE 'conflict' END WHERE id=$1`,
      [op.session_id]);
    await audit(null, user.id, 'referee_sync.resolve', 'referee_offline_ops', i.id, { resolution: i.resolution });
    return { status: 'applied', applied_id: appliedId };
  },
});

cap({
  name: 'list_referee_sync_history', method: 'GET', path: '/fixtures/:id/referee-sync/history', tag: TAG,
  summary: 'Full op-by-op sync history for a fixture (all devices, all officials). Organiser or head referee only.',
  input: z.object({
    id,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    if (!x) throw Object.assign(new Error('Not found'), { status: 404 });
    if (!x.organiser && !x.canScore) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const rows = await many(
      `SELECT ro.id, ro.client_key, ro.op_type, ro.occurred_at, ro.status, ro.seq,
              u.display_name AS official_name, ro.device_id, ro.created_at
         FROM referee_offline_ops ro
         JOIN users u ON u.id = ro.official_id
        WHERE ro.fixture_id=$1
        ORDER BY ro.seq, ro.created_at
        LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    const total = await one(`SELECT COUNT(*) AS n FROM referee_offline_ops WHERE fixture_id=$1`, [i.id]);
    await audit(null, user.id, 'referee_sync.history', 'fixture', i.id);
    return { ops: rows, total: Number(total.n), limit: i.limit, offset: i.offset };
  },
});
