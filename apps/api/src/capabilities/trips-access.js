// PS-23: Accessible athlete delegation travel and transport logistics.
// One definition → REST + OpenAPI + MCP. Access needs are athlete-controlled and privacy-scoped:
// notes and clinical detail never reach transport providers. Diagnosis is never stored or disclosed.
// Reuses tripCtx, audienceOf, record, assertOpen from trips.js and suitability-state pattern from venue-accessibility.js.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { LIVE_PARTICIPANT, assertOpen, audienceOf, record, tripCtx } from '../trips.js';

const TAG = 'Para Sport Travel';

const NEED_TYPES = [
  'wav', 'securement', 'guide_dog', 'hearing_loop', 'escort',
  'manual_support', 'medication_carry_on',
  'rooming_roll_in', 'rooming_hoist', 'rooming_ground_floor',
];
const NEED_TYPE_SET = new Set(NEED_TYPES);
const needType = z.string().refine((v) => NEED_TYPE_SET.has(v), (v) => ({ message: `Unknown need type: ${v}. Known: ${NEED_TYPES.join(', ')}` }));

const NEED_LABEL = {
  wav: 'Wheelchair-accessible vehicle',
  securement: 'Wheelchair securement',
  guide_dog: 'Guide dog accommodation',
  hearing_loop: 'Hearing loop',
  escort: 'Escort / personal assistant',
  manual_support: 'Manual handling support',
  medication_carry_on: 'Medication carry-on allowance',
  rooming_roll_in: 'Roll-in shower',
  rooming_hoist: 'Room hoist',
  rooming_ground_floor: 'Ground floor or lift access',
};

function decryptNeed(row, ops) {
  const out = { ...row };
  if (row.note_enc) {
    if (ops) {
      try { out.note = decryptFields(row, 'trip_access_needs', ['note']).note; } catch { out.note = null; }
    } else {
      out.note = null;
    }
  } else {
    out.note = null;
  }
  delete out.note_enc;
  return out;
}

function providerProjection(need) {
  if (need.scope !== 'provider_minimal') return null;
  if (need.need_type.startsWith('rooming_') || need.need_type === 'medication_carry_on') return null;
  return { need_type: need.need_type, label: NEED_LABEL[need.need_type] };
}

async function recheckSegment(c, tripId, segmentId) {
  const seg = (await c.query(
    'SELECT * FROM trip_segments WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL',
    [segmentId, tripId])).rows[0];
  if (!seg) return [];

  const participants = (await c.query(
    'SELECT sp.participant_id FROM trip_segment_passengers sp WHERE sp.segment_id=$1 AND sp.removed_at IS NULL',
    [segmentId])).rows.map((r) => r.participant_id);
  if (!participants.length) return [];

  const needs = (await c.query(
    'SELECT n.* FROM trip_access_needs n WHERE n.participant_id = ANY($1::uuid[]) AND n.trip_id=$2 AND n.archived_at IS NULL',
    [participants, tripId])).rows;
  if (!needs.length) return [];

  let vehicle = null;
  if (seg.vehicle_id) {
    vehicle = (await c.query('SELECT * FROM academy_transport_vehicles WHERE id=$1', [seg.vehicle_id])).rows[0] ?? null;
  }

  let venueFeatures = {};
  if (seg.destination_venue_id) {
    const rows = (await c.query(
      'SELECT feature, confidence, expires_at FROM academy_venue_access_features WHERE venue_id=$1 AND retired_at IS NULL',
      [seg.destination_venue_id])).rows;
    for (const r of rows) venueFeatures[r.feature] = r;
  }

  const countByType = {};
  for (const n of needs) countByType[n.need_type] = (countByType[n.need_type] ?? 0) + 1;

  const results = [];
  for (const [nt, count] of Object.entries(countByType)) {
    let state = 'unknown';
    if (nt === 'wav') {
      if (!vehicle) state = 'unknown';
      else if (vehicle.wheelchair_spaces >= count) state = 'met';
      else if (vehicle.wheelchair_spaces > 0) state = 'partial';
      else state = 'gap';
    } else if (nt === 'securement') {
      if (!vehicle) state = 'unknown';
      else if (vehicle.securement_points >= count) state = 'met';
      else if (vehicle.securement_points > 0) state = 'partial';
      else state = 'gap';
    } else if (nt === 'hearing_loop') {
      const vf = venueFeatures['hearing_loop'];
      const vehOk = vehicle ? vehicle.hearing_loop : null;
      const venueOk = vf && (!vf.expires_at || new Date(vf.expires_at) > new Date());
      state = (vehOk || venueOk) ? 'met' : (vehOk === null && !vf) ? 'unknown' : 'gap';
    } else {
      state = 'unknown';
    }
    results.push({ need_type: nt, state });
  }

  for (const { need_type, state } of results) {
    await c.query(
      `INSERT INTO trip_segment_access_suitability(segment_id, need_type, state, checked_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT (segment_id, need_type)
       DO UPDATE SET state=$3, checked_at=now()
       WHERE trip_segment_access_suitability.overridden_at IS NULL`,
      [segmentId, need_type, state]);
  }

  return results;
}

async function maybeInsertWavAlert(c, tripId, segmentId) {
  const rows = (await c.query(
    "SELECT state FROM trip_segment_access_suitability WHERE segment_id=$1 AND need_type='wav'",
    [segmentId])).rows;
  if (rows.some((r) => r.state === 'gap' || r.state === 'partial')) {
    await c.query(
      `INSERT INTO trip_access_alerts(trip_id, segment_id, alert_type, detail)
       VALUES($1,$2,'wav_capacity_gap',$3::jsonb)
       ON CONFLICT DO NOTHING`,
      [tripId, segmentId, JSON.stringify({ reason: 'vehicle_change' })]);
  }
}

// ── GET /trips/:id/access ─────────────────────────────────────────────────────
cap({
  name: 'get_trip_access_plan', method: 'GET', path: '/trips/:id/access', tag: TAG,
  summary: 'Return the access plan for a trip: per-participant needs (notes decrypted for ops/managers), segment suitability, open alerts and summary counts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const { trip, ops, manager } = ctx;

    const needRows = (await pool.query(
      `SELECT n.*, tp.user_id, u.display_name, tp.role
       FROM trip_access_needs n
       JOIN trip_participants tp ON tp.id = n.participant_id
       JOIN users u ON u.id = tp.user_id
       WHERE n.trip_id=$1 AND n.archived_at IS NULL
       ORDER BY u.display_name, n.need_type`,
      [trip.id])).rows;

    const byParticipant = {};
    for (const row of needRows) {
      const pid = row.participant_id;
      if (!byParticipant[pid]) byParticipant[pid] = { participant_id: pid, user_id: row.user_id, display_name: row.display_name, role: row.role, needs: [] };
      byParticipant[pid].needs.push({ ...decryptNeed(row, ops || manager), label: NEED_LABEL[row.need_type] });
    }

    const suitability = (await pool.query(
      `SELECT s.*, seg.origin, seg.destination, seg.mode, seg.depart_at, seg.status AS segment_status
       FROM trip_segment_access_suitability s
       JOIN trip_segments seg ON seg.id = s.segment_id
       WHERE seg.trip_id=$1 AND seg.archived_at IS NULL
       ORDER BY seg.depart_at, s.need_type`,
      [trip.id])).rows;

    const alerts = (await pool.query(
      `SELECT a.*, seg.origin, seg.destination FROM trip_access_alerts a
       LEFT JOIN trip_segments seg ON seg.id = a.segment_id
       WHERE a.trip_id=$1 AND a.resolved_at IS NULL
       ORDER BY a.created_at DESC`,
      [trip.id])).rows;

    return {
      trip_id: trip.id,
      participants: Object.values(byParticipant),
      suitability,
      alerts,
      counts: {
        with_needs: Object.keys(byParticipant).length,
        segments_checked: new Set(suitability.map((s) => s.segment_id)).size,
        open_alerts: alerts.length,
      },
    };
  },
});

// ── POST /trips/:id/access/needs ──────────────────────────────────────────────
cap({
  name: 'add_trip_access_need', method: 'POST', path: '/trips/:id/access/needs', tag: TAG,
  summary: 'Declare an access need for yourself or your ward on this trip. Need types are fixed values; free-text notes are field-encrypted and shown only to trip ops/managers — never to transport providers. Idempotent on (trip, participant, need_type).',
  input: z.object({
    id,
    participant_id: id.optional(),
    need_type: needType,
    scope: z.enum(['ops_only', 'provider_minimal']).default('ops_only'),
    note: z.string().trim().max(500).optional(),
    idempotency_key: z.string().max(80).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);

      let participant;
      if (i.participant_id) {
        if (!ctx.wardIds.has(i.participant_id) && !ctx.manager) throw forbidden('You may only manage needs for yourself or your wards.');
        participant = (await c.query(
          'SELECT * FROM trip_participants WHERE id=$1 AND trip_id=$2 AND status = ANY($3)',
          [i.participant_id, i.id, LIVE_PARTICIPANT])).rows[0];
        if (!participant) throw notFound('Participant');
      } else {
        if (!ctx.mine) throw forbidden('You are not on this trip.');
        participant = ctx.mine;
      }

      const enc = i.note ? encryptFields({ note: i.note }, 'trip_access_needs', ['note']) : {};

      const row = (await c.query(
        `INSERT INTO trip_access_needs(trip_id, participant_id, need_type, note_enc, scope)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (trip_id, participant_id, need_type) DO UPDATE
           SET note_enc=EXCLUDED.note_enc, scope=EXCLUDED.scope,
               archived_at=NULL, archived_by=NULL, updated_at=now()
         RETURNING *`,
        [i.id, participant.id, i.need_type, enc.note_enc ?? null, i.scope])).rows[0];

      await audit(c, user.id, 'add_access_need', 'trip_access_needs', row.id);
      await record(c, ctx.trip, user.id, {
        entity: 'access_need', entityId: row.id, action: 'added', version: 1,
        snapshot: { need_type: i.need_type, scope: i.scope },
        affected: await audienceOf(c, ctx.trip, [participant.id]),
        title: `Access need added: ${NEED_LABEL[i.need_type]}`,
        body: ctx.trip.name,
      });

      return { ...decryptNeed(row, true), label: NEED_LABEL[i.need_type] };
    });
  },
});

// ── PATCH /trips/:id/access/needs/:needId ─────────────────────────────────────
cap({
  name: 'update_trip_access_need', method: 'PATCH', path: '/trips/:id/access/needs/:needId', tag: TAG,
  summary: 'Update the scope or encrypted note on an existing access need. Only the owner, their active guardian, or the trip manager may update it.',
  input: z.object({
    id, needId: id,
    scope: z.enum(['ops_only', 'provider_minimal']).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);

      const need = (await c.query(
        'SELECT * FROM trip_access_needs WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL',
        [i.needId, i.id])).rows[0];
      if (!need) throw notFound('Access need');

      const isOwn = ctx.mine?.id === need.participant_id;
      const isWard = ctx.wardIds.has(need.participant_id);
      if (!isOwn && !isWard && !ctx.manager) throw forbidden('You may not edit this access need.');

      const enc = i.note !== undefined ? encryptFields({ note: i.note }, 'trip_access_needs', ['note']) : {};
      const scope = i.scope ?? need.scope;
      const noteEnc = i.note !== undefined ? (enc.note_enc ?? null) : need.note_enc;

      const row = (await c.query(
        'UPDATE trip_access_needs SET scope=$1, note_enc=$2, updated_at=now() WHERE id=$3 RETURNING *',
        [scope, noteEnc, i.needId])).rows[0];

      await audit(c, user.id, 'update_access_need', 'trip_access_needs', row.id);
      return { ...decryptNeed(row, true), label: NEED_LABEL[row.need_type] };
    });
  },
});

// ── DELETE /trips/:id/access/needs/:needId ────────────────────────────────────
cap({
  name: 'remove_trip_access_need', method: 'DELETE', path: '/trips/:id/access/needs/:needId', tag: TAG,
  summary: 'Soft-delete (archive) an access need. The record is retained for audit. Only the owner, their active guardian, or the trip manager may remove it.',
  input: z.object({ id, needId: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      const need = (await c.query(
        'SELECT * FROM trip_access_needs WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL',
        [i.needId, i.id])).rows[0];
      if (!need) throw notFound('Access need');
      const isOwn = ctx.mine?.id === need.participant_id;
      const isWard = ctx.wardIds.has(need.participant_id);
      if (!isOwn && !isWard && !ctx.manager) throw forbidden('You may not remove this access need.');
      await c.query(
        'UPDATE trip_access_needs SET archived_at=now(), archived_by=$1, updated_at=now() WHERE id=$2',
        [user.id, i.needId]);
      await audit(c, user.id, 'remove_access_need', 'trip_access_needs', i.needId);
      return { removed: true };
    });
  },
});

// ── GET /trips/:id/access/suitability ─────────────────────────────────────────
cap({
  name: 'get_trip_access_suitability', method: 'GET', path: '/trips/:id/access/suitability', tag: TAG,
  summary: 'Return the accessibility suitability state for every transport segment in this trip. States: met, partial, gap, unknown. Manager overrides are indicated.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tripCtx(user, i.id);
    const rows = (await pool.query(
      `SELECT s.*, seg.origin, seg.destination, seg.mode, seg.mode_label,
              seg.depart_at, seg.arrive_at, seg.depart_tz, seg.status AS seg_status, seg.vehicle_id,
              u.display_name AS overridden_by_name
       FROM trip_segment_access_suitability s
       JOIN trip_segments seg ON seg.id=s.segment_id
       LEFT JOIN users u ON u.id=s.overridden_by
       WHERE seg.trip_id=$1 AND seg.archived_at IS NULL
       ORDER BY seg.depart_at, s.need_type`,
      [i.id])).rows;
    return { suitability: rows };
  },
});

// ── POST /trips/:id/access/suitability/recheck ────────────────────────────────
cap({
  name: 'recheck_trip_access_suitability', method: 'POST', path: '/trips/:id/access/suitability/recheck', tag: TAG,
  summary: 'Trip manager: recompute accessibility suitability for all segments (or one). Compares declared needs against vehicle accessibility specs and venue features. Manager overrides are preserved.',
  input: z.object({ id, segment_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      if (!ctx.manager) throw forbidden('Only the trip manager may recheck suitability.');
      const segs = i.segment_id
        ? (await c.query('SELECT id FROM trip_segments WHERE id=$1 AND trip_id=$2 AND archived_at IS NULL', [i.segment_id, i.id])).rows
        : (await c.query("SELECT id FROM trip_segments WHERE trip_id=$1 AND archived_at IS NULL AND status<>'cancelled'", [i.id])).rows;
      const results = [];
      for (const seg of segs) {
        const r = await recheckSegment(c, i.id, seg.id);
        results.push({ segment_id: seg.id, checks: r });
        await maybeInsertWavAlert(c, i.id, seg.id);
      }
      return { rechecked: results.length, results };
    });
  },
});

// ── PATCH /trips/:id/access/suitability/:suitId ───────────────────────────────
cap({
  name: 'override_trip_access_suitability', method: 'PATCH', path: '/trips/:id/access/suitability/:suitId', tag: TAG,
  summary: 'Trip manager: manually override a suitability state with a note (e.g. mark met after verbal confirmation with provider). Override is preserved across rechecks.',
  input: z.object({
    id, suitId: id,
    state: z.enum(['met', 'partial', 'gap', 'unknown']),
    note: z.string().trim().min(5).max(300),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      if (!ctx.manager) throw forbidden('Only the trip manager may override suitability.');
      const row = (await c.query(
        `UPDATE trip_segment_access_suitability
         SET state=$1, note=$2, overridden_by=$3, overridden_at=now(), checked_at=now()
         WHERE id=$4 RETURNING *`,
        [i.state, i.note, user.id, i.suitId])).rows[0];
      if (!row) throw notFound('Suitability record');
      return row;
    });
  },
});

// ── GET /trips/:id/access/alerts ──────────────────────────────────────────────
cap({
  name: 'get_trip_access_alerts', method: 'GET', path: '/trips/:id/access/alerts', tag: TAG,
  summary: 'Return accessibility alerts for a trip: WAV gaps, vehicle cancellations, changed status, arrival conflicts. Defaults to open alerts only.',
  input: z.object({ id, include_resolved: z.boolean().default(false) }),
  async handler({ user }, i) {
    await tripCtx(user, i.id);
    const rows = (await pool.query(
      `SELECT a.*, seg.origin, seg.destination, seg.mode, seg.depart_at,
              u.display_name AS resolved_by_name
       FROM trip_access_alerts a
       LEFT JOIN trip_segments seg ON seg.id=a.segment_id
       LEFT JOIN users u ON u.id=a.resolved_by
       WHERE a.trip_id=$1 ${i.include_resolved ? '' : 'AND a.resolved_at IS NULL'}
       ORDER BY a.created_at DESC`,
      [i.id])).rows;
    return { alerts: rows };
  },
});

// ── PATCH /trips/:id/access/alerts/:alertId/resolve ───────────────────────────
cap({
  name: 'resolve_trip_access_alert', method: 'PATCH', path: '/trips/:id/access/alerts/:alertId/resolve', tag: TAG,
  summary: 'Trip manager: mark an accessibility alert as resolved once a contingency is in place or the issue is confirmed clear.',
  input: z.object({ id, alertId: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      if (!ctx.manager) throw forbidden('Only the trip manager may resolve alerts.');
      const row = (await c.query(
        'UPDATE trip_access_alerts SET resolved_at=now(), resolved_by=$1 WHERE id=$2 AND trip_id=$3 AND resolved_at IS NULL RETURNING *',
        [user.id, i.alertId, i.id])).rows[0];
      if (!row) throw notFound('Alert or already resolved');
      return { resolved: true, alert: row };
    });
  },
});

// ── GET /vehicles/:vehicleId/access-specs ─────────────────────────────────────
cap({
  name: 'get_vehicle_access_specs', method: 'GET', path: '/vehicles/:vehicleId/access-specs', tag: TAG,
  summary: 'Return the accessibility specifications for an academy transport vehicle: wheelchair spaces, low-floor, hoist, securement points, hearing loop, and verification metadata.',
  input: z.object({ vehicleId: id }),
  async handler({ user }, i) {
    const row = (await pool.query(
      `SELECT v.id, v.description, v.capacity,
              v.wheelchair_spaces, v.low_floor, v.hoist, v.securement_points, v.hearing_loop,
              v.access_verified_at, u.display_name AS access_verified_by_name
       FROM academy_transport_vehicles v
       LEFT JOIN users u ON u.id=v.access_verified_by
       WHERE v.id=$1`,
      [i.vehicleId])).rows[0];
    if (!row) throw notFound('Vehicle');
    return row;
  },
});

// ── PATCH /vehicles/:vehicleId/access-specs ───────────────────────────────────
cap({
  name: 'update_vehicle_access_specs', method: 'PATCH', path: '/vehicles/:vehicleId/access-specs', tag: TAG,
  summary: 'Organisation staff: record or update the accessibility specifications for an academy transport vehicle.',
  input: z.object({
    vehicleId: id,
    wheelchair_spaces: z.number().int().min(0).max(20).optional(),
    low_floor: z.boolean().optional(),
    hoist: z.boolean().optional(),
    securement_points: z.number().int().min(0).max(20).optional(),
    hearing_loop: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM academy_transport_vehicles WHERE id=$1', [i.vehicleId])).rows[0];
      if (!v) throw notFound('Vehicle');
      const specs = {
        ...(i.wheelchair_spaces !== undefined && { wheelchair_spaces: i.wheelchair_spaces }),
        ...(i.low_floor !== undefined && { low_floor: i.low_floor }),
        ...(i.hoist !== undefined && { hoist: i.hoist }),
        ...(i.securement_points !== undefined && { securement_points: i.securement_points }),
        ...(i.hearing_loop !== undefined && { hearing_loop: i.hearing_loop }),
      };
      const fields = Object.keys(specs);
      if (!fields.length) throw badRequest('No fields to update');
      const sets = fields.map((f, idx) => `${f}=$${idx + 2}`).join(', ');
      const vals = fields.map((f) => specs[f]);
      const updated = (await c.query(
        `UPDATE academy_transport_vehicles SET ${sets}, access_verified_at=now(), access_verified_by=$1 WHERE id=$${fields.length + 2} RETURNING *`,
        [user.id, ...vals, i.vehicleId])).rows[0];
      if (!updated) throw notFound('Vehicle');
      await audit(c, user.id, 'update_vehicle_access_specs', 'academy_transport_vehicles', i.vehicleId);
      return {
        id: updated.id,
        wheelchair_spaces: updated.wheelchair_spaces,
        low_floor: updated.low_floor,
        hoist: updated.hoist,
        securement_points: updated.securement_points,
        hearing_loop: updated.hearing_loop,
        access_verified_at: updated.access_verified_at,
      };
    });
  },
});

// ── GET /trips/:id/access/needs/provider ──────────────────────────────────────
cap({
  name: 'get_trip_provider_access_manifest', method: 'GET', path: '/trips/:id/access/needs/provider', tag: TAG,
  summary: 'Trip ops/manager: produce a provider-safe manifest of access needs. Only need types with scope=provider_minimal are included; notes, rooming needs and medication needs are excluded. Safe to share with transport providers.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops && !ctx.manager) throw forbidden('Trip operations access required.');
    const needs = (await pool.query(
      `SELECT n.need_type, n.scope, tp.user_id, u.display_name
       FROM trip_access_needs n
       JOIN trip_participants tp ON tp.id=n.participant_id
       JOIN users u ON u.id=tp.user_id
       WHERE n.trip_id=$1 AND n.archived_at IS NULL`,
      [i.id])).rows;
    const manifest = needs
      .map((n) => { const p = providerProjection(n); return p ? { ...p, display_name: n.display_name } : null; })
      .filter(Boolean);
    return { trip_id: i.id, provider_needs: manifest, count: manifest.length };
  },
});
