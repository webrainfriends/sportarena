// PS-06: Verified accessible venue and facility discovery.
// One definition -> REST + OpenAPI + MCP. Extends the simple boolean access features
// from academy-inclusion.js (#808) with rich verification metadata, outage management,
// booking suitability and event checklists. No personal data is ever collected here;
// confidence and evidence data are venue facts, not athlete records.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { mustManage } from '../booking/engine.js';
import { VENUE_FEATURES, VENUE_FEATURE_SET, badRequest, notFound, forbidden } from '../inclusion.js';

const TAG = 'Venue Accessibility';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const featureKey = z.string().refine((f) => VENUE_FEATURE_SET.has(f), (f) => ({ message: `Unknown access feature: ${f}. Known: ${VENUE_FEATURES.join(', ')}` }));

const CONFIDENCE_RANK = { provisional: 0, self_reported: 1, third_party: 2, certified: 3 };

function computeState(row) {
  if (!row) return 'unknown';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  return row.confidence;
}

async function activeOutage(c, venueId, feature, resourceId = null) {
  const r = resourceId
    ? (await c.query('SELECT * FROM venue_access_outages WHERE venue_id=$1 AND feature=$2 AND resource_id=$3 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1', [venueId, feature, resourceId])).rows[0]
    : (await c.query('SELECT * FROM venue_access_outages WHERE venue_id=$1 AND feature=$2 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1', [venueId, feature])).rows[0];
  return r ?? null;
}

async function notifyOutageBookers(c, venueId, resourceId, feature, msg) {
  const lookback = new Date(Date.now() + 90 * 864e5).toISOString();
  const q = resourceId
    ? 'SELECT DISTINCT b.user_id FROM bookings b WHERE b.resource_id=$1 AND b.starts_at > now() AND b.starts_at < $2 AND b.status IN (\'confirmed\',\'pending\')'
    : 'SELECT DISTINCT b.user_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.starts_at > now() AND b.starts_at < $2 AND b.status IN (\'confirmed\',\'pending\')';
  const bookers = (await c.query(q, [resourceId ?? venueId, lookback])).rows;
  for (const { user_id } of bookers) {
    await notify(c, user_id, { kind: 'venue_access_outage', title: msg.title, body: msg.body, data: { venue_id: venueId, feature }, dedupe_key: `vao:${venueId}:${feature}:${user_id}:${Date.now()}` });
  }
  return bookers.length;
}

// ------------------------------------------------------------------ upsert feature
cap({
  name: 'upsert_venue_access_feature', method: 'PATCH', path: '/venues/:venue_id/access-features/:feature', tag: TAG,
  summary: 'Venue manager: record or update a verified access feature with confidence level, source, assessor, evidence reference, dates and optional resource-level applicability. Upserts the live row; retired rows are never touched.',
  input: z.object({
    venue_id: id, feature: featureKey,
    confidence: z.enum(['provisional', 'self_reported', 'third_party', 'certified']),
    source: z.string().trim().max(200).optional(),
    assessor_name: z.string().trim().max(120).optional(),
    evidence_ref: z.string().trim().max(200).optional(),
    last_checked: day.optional(),
    expires_at: day.optional(),
    feature_detail: z.record(z.string(), z.unknown()).optional(),
    resource_id: id.optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM venues WHERE id=$1', [i.venue_id])).rowCount) throw notFound('Venue');
      const resourceId = i.resource_id ?? null;
      const live = (await c.query(
        'SELECT id FROM academy_venue_access_features WHERE venue_id=$1 AND feature=$2 AND (($3::uuid IS NULL AND resource_id IS NULL) OR resource_id=$3) AND retired_at IS NULL',
        [i.venue_id, i.feature, resourceId])).rows[0];
      let row;
      if (live) {
        row = (await c.query(
          `UPDATE academy_venue_access_features
             SET confidence=$3, source=$4, assessor_name=$5, evidence_ref=$6, last_checked=$7, expires_at=$8, feature_detail=$9, verified_by=$10, verified_at=now()
           WHERE id=$1 AND venue_id=$2 RETURNING *`,
          [live.id, i.venue_id, i.confidence, i.source ?? null, i.assessor_name ?? null, i.evidence_ref ?? null, i.last_checked ?? null, i.expires_at ?? null, JSON.stringify(i.feature_detail ?? {}), user.id])).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO academy_venue_access_features(venue_id, feature, confidence, source, assessor_name, evidence_ref, last_checked, expires_at, feature_detail, resource_id, verified_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [i.venue_id, i.feature, i.confidence, i.source ?? null, i.assessor_name ?? null, i.evidence_ref ?? null, i.last_checked ?? null, i.expires_at ?? null, JSON.stringify(i.feature_detail ?? {}), resourceId, user.id])).rows[0];
      }
      await audit(c, user.id, 'upsert_venue_access_feature', 'academy_venue_access_features', row.id);
      const outage = await activeOutage(c, i.venue_id, i.feature, resourceId);
      return { ...row, state: computeState(row), expired: !!(row.expires_at && new Date(row.expires_at) < new Date()), outage_active: !!outage };
    });
  },
});

// ------------------------------------------------------------------ list features (public)
cap({
  name: 'list_venue_access_features_verified', method: 'GET', path: '/venues/:venue_id/access-features', tag: TAG, auth: 'public',
  summary: 'All access features recorded for a venue, with confidence level, evidence dates, and any active outage. The full catalogue is returned — features with no row have state "unknown". Public read; no personal data.',
  input: z.object({ venue_id: id }),
  async handler(_, i) {
    if (!(await one('SELECT 1 AS x FROM venues WHERE id=$1', [i.venue_id]))) throw notFound('Venue');
    const rows = await many(
      'SELECT f.*, o.id AS outage_id, o.reason AS outage_reason, o.ends_at AS outage_ends_at FROM academy_venue_access_features f LEFT JOIN venue_access_outages o ON o.venue_id=f.venue_id AND o.feature=f.feature AND o.resolved_at IS NULL WHERE f.venue_id=$1 AND f.retired_at IS NULL ORDER BY f.feature',
      [i.venue_id]);
    const byFeature = new Map(rows.map((r) => [r.feature, r]));
    return {
      venue_id: i.venue_id,
      features: VENUE_FEATURES.map((feature) => {
        const r = byFeature.get(feature);
        if (!r) return { feature, state: 'unknown', outage_active: false, expired: false };
        const expired = !!(r.expires_at && new Date(r.expires_at) < new Date());
        return {
          feature, state: expired ? 'expired' : r.confidence,
          confidence: r.confidence, source: r.source, last_checked: r.last_checked,
          expires_at: r.expires_at, feature_detail: r.feature_detail, resource_id: r.resource_id,
          verified_at: r.verified_at, expired,
          outage_active: !!r.outage_id, outage_reason: r.outage_reason ?? null, outage_ends_at: r.outage_ends_at ?? null,
        };
      }),
    };
  },
});

// ------------------------------------------------------------------ single feature detail (public)
cap({
  name: 'get_venue_access_feature_detail', method: 'GET', path: '/venues/:venue_id/access-features/:feature', tag: TAG, auth: 'public',
  summary: 'Full detail for one access feature at a venue: confidence, source, evidence reference, expiry and any active outage.',
  input: z.object({ venue_id: id, feature: featureKey }),
  async handler(_, i) {
    if (!(await one('SELECT 1 AS x FROM venues WHERE id=$1', [i.venue_id]))) throw notFound('Venue');
    const r = await one(
      'SELECT * FROM academy_venue_access_features WHERE venue_id=$1 AND feature=$2 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [i.venue_id, i.feature]);
    const outage = r ? await one('SELECT * FROM venue_access_outages WHERE venue_id=$1 AND feature=$2 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1', [i.venue_id, i.feature]) : null;
    const expired = !!(r?.expires_at && new Date(r.expires_at) < new Date());
    return {
      venue_id: i.venue_id, feature: i.feature,
      state: r ? (expired ? 'expired' : r.confidence) : 'unknown',
      record: r ?? null, expired,
      outage_active: !!outage, outage: outage ?? null,
    };
  },
});

// ------------------------------------------------------------------ raise outage
cap({
  name: 'raise_access_outage', method: 'POST', path: '/venues/:venue_id/access-outages', tag: TAG, status: 201,
  summary: 'Venue manager: mark an access feature temporarily unavailable (maintenance, repair, damage). All future bookers in the next 90 days are notified by push.',
  input: z.object({
    venue_id: id,
    feature: featureKey,
    reason: z.string().trim().max(300).optional(),
    ends_at: z.string().datetime({ offset: true }).optional(),
    resource_id: id.optional(),
  }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    return tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM venues WHERE id=$1', [i.venue_id])).rowCount) throw notFound('Venue');
      const resourceId = i.resource_id ?? null;
      const existing = await activeOutage(c, i.venue_id, i.feature, resourceId);
      if (existing) throw badRequest('An active outage already exists for this feature. Resolve it first.');
      const row = (await c.query(
        'INSERT INTO venue_access_outages(venue_id, feature, resource_id, reason, ends_at, raised_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [i.venue_id, i.feature, resourceId, i.reason ?? null, i.ends_at ?? null, user.id])).rows[0];
      const count = await notifyOutageBookers(c, i.venue_id, resourceId, i.feature, {
        title: 'Access feature unavailable',
        body: `${i.feature.replace(/_/g, ' ')} is temporarily unavailable at this venue${i.reason ? `: ${i.reason}` : ''}.`,
      });
      await audit(c, user.id, 'raise_access_outage', 'venue_access_outages', row.id);
      return { ...row, bookers_notified: count };
    });
  },
});

// ------------------------------------------------------------------ resolve outage
cap({
  name: 'resolve_access_outage', method: 'PATCH', path: '/venues/:venue_id/access-outages/:outage_id/resolve', tag: TAG,
  summary: 'Venue manager: mark an outage resolved. Affected bookers are notified that the feature is available again.',
  input: z.object({ venue_id: id, outage_id: id }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    return tx(async (c) => {
      const o = (await c.query('SELECT * FROM venue_access_outages WHERE id=$1 AND venue_id=$2 FOR UPDATE', [i.outage_id, i.venue_id])).rows[0];
      if (!o) throw notFound('Outage');
      if (o.resolved_at) return { ...o, bookers_notified: 0 };
      const row = (await c.query(
        'UPDATE venue_access_outages SET resolved_at=now(), resolved_by=$2 WHERE id=$1 RETURNING *',
        [o.id, user.id])).rows[0];
      const count = await notifyOutageBookers(c, i.venue_id, o.resource_id, o.feature, {
        title: 'Access feature restored',
        body: `${o.feature.replace(/_/g, ' ')} is available again at this venue.`,
      });
      await audit(c, user.id, 'resolve_access_outage', 'venue_access_outages', o.id);
      return { ...row, bookers_notified: count };
    });
  },
});

// ------------------------------------------------------------------ list outages
cap({
  name: 'list_access_outages', method: 'GET', path: '/venues/:venue_id/access-outages', tag: TAG,
  summary: 'Venue manager: list active outages plus outages resolved in the last 30 days.',
  input: z.object({ venue_id: id, active_only: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    await mustManage(user, i.venue_id);
    const rows = i.active_only
      ? await many('SELECT * FROM venue_access_outages WHERE venue_id=$1 AND resolved_at IS NULL ORDER BY created_at DESC', [i.venue_id])
      : await many("SELECT * FROM venue_access_outages WHERE venue_id=$1 AND (resolved_at IS NULL OR resolved_at > now() - interval '30 days') ORDER BY resolved_at NULLS FIRST, created_at DESC", [i.venue_id]);
    return { venue_id: i.venue_id, outages: rows, active_count: rows.filter((r) => !r.resolved_at).length };
  },
});

// ------------------------------------------------------------------ booking suitability
cap({
  name: 'get_booking_access_suitability', method: 'GET', path: '/bookings/:booking_id/access-suitability', tag: TAG,
  summary: 'For a booking: the access feature suitability checklist for the booked resource and venue. No personal data is required or returned.',
  input: z.object({ booking_id: id }),
  async handler({ user }, i) {
    const booking = await one('SELECT b.*, r.venue_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE b.id=$1', [i.booking_id]);
    if (!booking) throw notFound('Booking');
    if (!user || (booking.user_id !== user.id && !(await one('SELECT 1 AS x FROM venues v WHERE v.id=$1 AND v.owner_id=$2', [booking.venue_id, user.id])))) {
      const isVenueTeam = !!(await one('SELECT 1 AS x FROM venues WHERE id=$1 AND owner_id=$2', [booking.venue_id, user?.id ?? 'none']));
      if (!isVenueTeam) throw notFound('Booking');
    }
    const featureRows = await many(
      'SELECT f.*, o.id AS outage_id, o.reason AS outage_reason, o.ends_at AS outage_ends_at FROM academy_venue_access_features f LEFT JOIN venue_access_outages o ON o.venue_id=f.venue_id AND o.feature=f.feature AND o.resolved_at IS NULL WHERE f.venue_id=$1 AND f.retired_at IS NULL',
      [booking.venue_id]);
    const byFeature = new Map(featureRows.map((r) => [r.feature, r]));
    const items = VENUE_FEATURES.map((feature) => {
      const r = byFeature.get(feature);
      if (!r) return { feature, state: 'unknown' };
      const expired = !!(r.expires_at && new Date(r.expires_at) < new Date());
      if (r.outage_id) return { feature, state: 'outage', outage_reason: r.outage_reason, outage_ends_at: r.outage_ends_at, confidence: r.confidence };
      if (expired) return { feature, state: 'expired', confidence: r.confidence };
      return { feature, state: 'met', confidence: r.confidence };
    });
    return { booking_id: i.booking_id, venue_id: booking.venue_id, resource_id: booking.resource_id, items, outage_count: items.filter((x) => x.state === 'outage').length };
  },
});

// ------------------------------------------------------------------ event access checklist
cap({
  name: 'get_event_access_checklist', method: 'GET', path: '/events/:event_id/access-checklist', tag: TAG,
  summary: 'Event organiser: for each session in the event, the access feature checklist per venue. Groups items by state: gap, outage, unknown, met. No personal data returned.',
  input: z.object({ event_id: id }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.event_id]);
    if (!ev) throw notFound('Event');
    if (!user) throw forbidden('Sign in to view the event access checklist');

    // Load all bookings for this event's fixtures
    const bookings = await many(
      'SELECT DISTINCT b.id, b.resource_id, r.venue_id, r.name AS resource_name, v.name AS venue_name, b.starts_at FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.event_id=$1 AND b.status IN (\'confirmed\',\'pending\') ORDER BY v.name, b.starts_at',
      [i.event_id]);

    const venueIds = [...new Set(bookings.map((b) => b.venue_id))];
    // load features + outages per venue
    const venueFeatures = new Map();
    for (const vid of venueIds) {
      const featureRows = await many(
        'SELECT f.*, o.id AS outage_id, o.reason AS outage_reason, o.ends_at AS outage_ends_at FROM academy_venue_access_features f LEFT JOIN venue_access_outages o ON o.venue_id=f.venue_id AND o.feature=f.feature AND o.resolved_at IS NULL WHERE f.venue_id=$1 AND f.retired_at IS NULL',
        [vid]);
      venueFeatures.set(vid, new Map(featureRows.map((r) => [r.feature, r])));
    }

    const sessions = bookings.map((b) => {
      const byFeat = venueFeatures.get(b.venue_id) ?? new Map();
      const items = VENUE_FEATURES.map((feature) => {
        const r = byFeat.get(feature);
        if (!r) return { feature, state: 'unknown' };
        const expired = !!(r.expires_at && new Date(r.expires_at) < new Date());
        if (r.outage_id) return { feature, state: 'outage', outage_reason: r.outage_reason, outage_ends_at: r.outage_ends_at, confidence: r.confidence };
        if (expired) return { feature, state: 'expired', confidence: r.confidence };
        return { feature, state: 'met', confidence: r.confidence };
      });
      return { booking_id: b.id, resource_id: b.resource_id, resource_name: b.resource_name, venue_id: b.venue_id, venue_name: b.venue_name, starts_at: b.starts_at, items };
    });

    const all = sessions.flatMap((s) => s.items);
    const summary = { met: all.filter((x) => x.state === 'met').length, gap: all.filter((x) => x.state === 'expired').length, unknown: all.filter((x) => x.state === 'unknown').length, outage: all.filter((x) => x.state === 'outage').length };
    return { event_id: i.event_id, sessions, summary };
  },
});
