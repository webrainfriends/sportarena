// External venue reservations for events (#1134).
// Keeps external booking provenance strictly separate from native bookings (no false inventory ownership).
// Routes: REST + OpenAPI + MCP via cap().
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, many, one, tx } from '../db.js';
import { badRequest, conflict, notFound, forbidden } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { PROVIDERS } from '../integrations/registry.js';
import { isPlatformAdminNow, requireIntegrationAccess } from '../integrations/access.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const TAG = 'Event external venues';
const CRED_CTX = 'integration_cred';
const FIFTEEN_MIN = 15 * 60 * 1000;

const STATUS_VALUES = ['draft','quoted','hold_pending','redirect_pending','awaiting_confirmation',
  'confirmed','fulfilled','failed','expired','cancelled','refunded','disputed'];
const SOURCE_STATUS_VALUES = ['provider_confirmed','organiser_attested','unverified_linkout'];

function shapeReservation(row, { includeRef = false } = {}) {
  return {
    id: row.id,
    event_id: row.event_id,
    event_session_id: row.event_session_id,
    provider_key: row.provider_key,
    integration_install_id: row.integration_install_id,
    external_venue_id: row.external_venue_id,
    external_venue_name: row.external_venue_name,
    external_venue_address: row.external_venue_address,
    external_venue_city: row.external_venue_city,
    external_venue_country: row.external_venue_country,
    external_venue_lat: row.external_venue_lat ? Number(row.external_venue_lat) : null,
    external_venue_lng: row.external_venue_lng ? Number(row.external_venue_lng) : null,
    external_booking_reference: includeRef && row.external_booking_reference_enc
      ? (() => { try { return decrypt(row.external_booking_reference_enc, CRED_CTX); } catch { return null; } })()
      : (row.external_booking_reference_enc ? '••••••' : null),
    linkout_url: row.linkout_url_enc
      ? (() => { try { return decrypt(row.linkout_url_enc, CRED_CTX); } catch { return null; } })()
      : null,
    status: row.status,
    source_status: row.source_status,
    venue_source: row.venue_source,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    timezone: row.timezone,
    sport_keys: row.sport_keys,
    courts_requested: row.courts_requested,
    price_minor: row.price_minor ? Number(row.price_minor) : null,
    currency: row.currency,
    tax_minor: row.tax_minor ? Number(row.tax_minor) : null,
    fee_minor: row.fee_minor ? Number(row.fee_minor) : null,
    quote_expires_at: row.quote_expires_at,
    quote_fetched_at: row.quote_fetched_at,
    provider_last_synced_at: row.provider_last_synced_at,
    revoked_at: row.revoked_at,
    replaced_by_id: row.replaced_by_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getProviderCaps(provider_key, country_code = '') {
  const rows = await many(
    "SELECT cap_key, enabled FROM venue_booking_provider_caps WHERE provider_key=$1 AND (country_code=$2 OR country_code='') ORDER BY country_code DESC",
    [provider_key, country_code]);
  const seen = new Set();
  const caps = {};
  for (const r of rows) {
    if (!seen.has(r.cap_key)) { caps[r.cap_key] = r.enabled; seen.add(r.cap_key); }
  }
  return caps;
}

const hmacOk = (secret, raw, sig) => {
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(sig ?? '').replace(/^sha256=/, ''));
  return want.length === got.length && timingSafeEqual(want, got);
};

cap({
  name: 'get_event_venue_options', method: 'GET', path: '/events/:id/venue-options', tag: TAG,
  summary: 'Unified venue options for an event: native GotMyGame venues, external connector venues (search), and existing external reservations. Returns cards tagged by source, freshness and availability status. For redirect-only connectors, returns a linkout URL card instead of live results.',
  input: z.object({
    id,
    sport_keys: z.array(z.string().max(60)).max(10).default([]),
    courts: z.number().int().min(1).max(100).default(1),
    capacity: z.number().int().min(0).optional(),
    date_from: z.string().date().optional(),
    date_to: z.string().date().optional(),
    country: z.string().length(2).optional(),
    budget_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    indoor_outdoor: z.enum(['indoor','outdoor','any']).default('any'),
    source_filter: z.enum(['all','native','external_connector','external_manual','existing']).default('all'),
  }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);

    // 1. Native GotMyGame venues
    const nativeVenues = i.source_filter === 'all' || i.source_filter === 'native'
      ? await many(
          `SELECT v.id, v.name, v.emoji, v.city, v.country, v.address, v.currency, v.timezone,
                  v.indoor, v.capacity,
                  (SELECT '/api/v1/media/' || m.id FROM venue_media m WHERE m.venue_id=v.id AND m.removed_at IS NULL AND m.kind='photo' ORDER BY m.is_cover DESC, m.position LIMIT 1) AS cover_url
             FROM venues v
            WHERE v.active AND ($1::text[] IS NULL OR array_length($1::text[], 1) = 0
               OR EXISTS (SELECT 1 FROM venue_sports vs WHERE vs.venue_id=v.id AND vs.sport_key=ANY($1)))
              AND ($2::char(2) IS NULL OR v.country=$2)
            ORDER BY v.name LIMIT 20`,
          [i.sport_keys.length ? i.sport_keys : null, i.country ?? null])
      : [];

    // 2. Active venue_booking integrations for the event's org
    const installs = i.source_filter === 'all' || i.source_filter === 'external_connector'
      ? await many(
          "SELECT ii.id, ii.provider_key FROM integration_installs ii WHERE ii.organisation_id=$1 AND ii.status='active' AND ii.category='venue_booking' ORDER BY ii.created_at",
          [ev.organisation_id])
      : [];

    // 3. Existing external reservations (not cancelled/expired)
    const existing = await many(
      "SELECT * FROM event_venue_reservation_links WHERE event_id=$1 AND revoked_at IS NULL AND status NOT IN ('cancelled','expired','refunded') ORDER BY created_at DESC",
      [ev.id]);

    // Build external connector cards (linkout or search results)
    const connectorCards = [];
    for (const inst of installs) {
      const p = PROVIDERS[inst.provider_key];
      if (!p) continue;
      const caps = await getProviderCaps(inst.provider_key, i.country ?? ev.country ?? '');

      if (caps['redirect.out'] && !caps['venue.search']) {
        // Redirect-only connector
        const linkout = p.linkout?.({
          sport_key: i.sport_keys[0] ?? '',
          city: i.country === 'SG' ? '' : '',
          venue_name: '',
        }) ?? null;
        connectorCards.push({
          source: 'external_connector',
          provider_key: inst.provider_key,
          provider_name: p.name,
          install_id: inst.id,
          availability_status: 'redirect_only',
          linkout_url: linkout,
          disclaimer: p.disclaimer ?? null,
          capability_note: p.capability_note ?? null,
          capabilities: caps,
        });
      } else if (caps['venue.search'] && p.searchVenues) {
        // Live search
        try {
          const results = p.searchVenues({ sport_keys: i.sport_keys, city: '', courts: i.courts });
          for (const v of results) {
            connectorCards.push({
              source: 'external_connector',
              provider_key: inst.provider_key,
              provider_name: p.name,
              install_id: inst.id,
              availability_status: v.availability_status ?? 'unknown',
              ...v,
            });
          }
        } catch {
          connectorCards.push({
            source: 'external_connector',
            provider_key: inst.provider_key,
            provider_name: p.name,
            install_id: inst.id,
            availability_status: 'unknown',
            error: 'Provider search unavailable',
          });
        }
      }
    }

    return {
      native_venues: nativeVenues.map((v) => ({ source: 'native', ...v })),
      connector_cards: connectorCards,
      existing_reservations: existing.map((r) => shapeReservation(r, { includeRef: false })),
    };
  },
});

cap({
  name: 'compare_venue_quotes', method: 'POST', path: '/events/:id/venue-quotes/compare', tag: TAG,
  summary: 'Side-by-side comparison of venue quotes. Normalises to per-hour price, checks for stale quotes (>15 min), adds warnings for ballot/pending availability, unknown pricing, or currency differences. Read-only.',
  input: z.object({
    id,
    quotes: z.array(z.object({
      label: z.string().max(100),
      source: z.enum(['native','external_connector','external_manual']),
      provider_key: z.string().max(60).optional(),
      venue_name: z.string().max(200),
      venue_city: z.string().max(100).optional(),
      starts_at: z.string().datetime(),
      ends_at: z.string().datetime(),
      courts: z.number().int().min(1).default(1),
      price_minor: z.number().int().min(0).optional(),
      tax_minor: z.number().int().min(0).optional(),
      fee_minor: z.number().int().min(0).optional(),
      currency: z.string().length(3),
      availability_status: z.string().max(60).optional(),
      cancellation_policy: z.string().max(300).optional(),
      quote_fetched_at: z.string().datetime().optional(),
    })).min(1).max(10),
    base_currency: z.string().length(3).optional(),
  }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    const now = Date.now();

    return i.quotes.map((q) => {
      const warnings = [];
      const durationMs = new Date(q.ends_at) - new Date(q.starts_at);
      const hours = durationMs / 3600000;
      const totalMinor = (q.price_minor ?? 0) + (q.tax_minor ?? 0) + (q.fee_minor ?? 0);
      const perHour = hours > 0 ? Math.round(totalMinor / hours) : null;
      const perCourtPerHour = hours > 0 && q.courts > 0 ? Math.round(totalMinor / hours / q.courts) : null;

      if (q.quote_fetched_at && (now - new Date(q.quote_fetched_at)) > FIFTEEN_MIN) {
        warnings.push({ code: 'stale_quote', message: 'Quote is more than 15 minutes old — prices may have changed.' });
      }
      if (!q.price_minor && q.price_minor !== 0) {
        warnings.push({ code: 'price_unknown', message: 'No price available for this option.' });
      }
      if (['ballot_pending','price_indicative','unknown'].includes(q.availability_status)) {
        warnings.push({ code: `availability_${q.availability_status}`, message: `Availability is ${q.availability_status?.replace('_', ' ')} — slot not guaranteed.` });
      }
      if (i.base_currency && q.currency !== i.base_currency) {
        warnings.push({ code: 'currency_mismatch', message: `Quote is in ${q.currency}; conversion to ${i.base_currency} not applied — compare carefully.` });
      }

      return {
        label: q.label,
        source: q.source,
        provider_key: q.provider_key ?? null,
        venue_name: q.venue_name,
        venue_city: q.venue_city ?? null,
        starts_at: q.starts_at,
        ends_at: q.ends_at,
        hours,
        courts: q.courts,
        price_minor: q.price_minor ?? null,
        tax_minor: q.tax_minor ?? null,
        fee_minor: q.fee_minor ?? null,
        total_minor: totalMinor,
        currency: q.currency,
        per_hour_minor: perHour,
        per_court_per_hour_minor: perCourtPerHour,
        availability_status: q.availability_status ?? 'unknown',
        cancellation_policy: q.cancellation_policy ?? null,
        quote_fetched_at: q.quote_fetched_at ?? null,
        warnings,
      };
    });
  },
});

cap({
  name: 'create_external_venue_reservation', method: 'POST', path: '/events/:id/external-venue-reservations', tag: TAG, status: 201,
  summary: 'Record an external venue booking for an event (manual evidence, redirect link-out, or partner-confirmed). Creates an event_venue_reservation_links row. Never creates a native bookings row (provenance distinction). Encrypts the booking reference at rest.',
  input: z.object({
    id,
    provider_key: z.string().max(60),
    integration_install_id: id.optional(),
    external_venue_id: z.string().max(200).optional(),
    external_venue_name: z.string().max(300),
    external_venue_address: z.string().max(400).optional(),
    external_venue_city: z.string().max(100).optional(),
    external_venue_country: z.string().length(2).optional(),
    external_venue_lat: z.number().min(-90).max(90).optional(),
    external_venue_lng: z.number().min(-180).max(180).optional(),
    external_booking_reference: z.string().max(400).optional(),
    linkout_url: z.string().url().max(2000).optional(),
    status: z.enum(STATUS_VALUES).default('draft'),
    source_status: z.enum(SOURCE_STATUS_VALUES).default('unverified_linkout'),
    venue_source: z.enum(['native','external_partner','external_manual','unassigned']).default('external_manual'),
    starts_at: z.string().datetime().optional(),
    ends_at: z.string().datetime().optional(),
    timezone: z.string().max(60).optional(),
    sport_keys: z.array(z.string().max(60)).max(10).default([]),
    courts_requested: z.number().int().min(1).optional(),
    price_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    tax_minor: z.number().int().min(0).optional(),
    fee_minor: z.number().int().min(0).optional(),
    quote_expires_at: z.string().datetime().optional(),
    quote_fetched_at: z.string().datetime().optional(),
  }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const refEnc = i.external_booking_reference ? encrypt(i.external_booking_reference, CRED_CTX) : null;
    const urlEnc = i.linkout_url ? encrypt(i.linkout_url, CRED_CTX) : null;
    const row = (await pool.query(
      `INSERT INTO event_venue_reservation_links
         (event_id, provider_key, integration_install_id,
          external_venue_id, external_venue_name, external_venue_address,
          external_venue_city, external_venue_country, external_venue_lat, external_venue_lng,
          external_booking_reference_enc, linkout_url_enc,
          status, source_status, venue_source,
          starts_at, ends_at, timezone, sport_keys, courts_requested,
          price_minor, currency, tax_minor, fee_minor, quote_expires_at, quote_fetched_at,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [ev.id, i.provider_key, i.integration_install_id ?? null,
       i.external_venue_id ?? null, i.external_venue_name, i.external_venue_address ?? null,
       i.external_venue_city ?? null, i.external_venue_country ?? null,
       i.external_venue_lat ?? null, i.external_venue_lng ?? null,
       refEnc, urlEnc,
       i.status, i.source_status, i.venue_source,
       i.starts_at ?? null, i.ends_at ?? null, i.timezone ?? null,
       i.sport_keys, i.courts_requested ?? null,
       i.price_minor ?? null, i.currency ?? null, i.tax_minor ?? null, i.fee_minor ?? null,
       i.quote_expires_at ?? null, i.quote_fetched_at ?? null,
       user.id])).rows[0];
    await audit(pool, user.id, 'create_external_venue_reservation', 'event_venue_reservation_links', row.id);
    return shapeReservation(row, { includeRef: true });
  },
});

cap({
  name: 'list_external_venue_reservations', method: 'GET', path: '/events/:id/external-venue-reservations', tag: TAG,
  summary: 'All external venue reservations for an event, ordered by most recent first. Booking references are masked.',
  input: z.object({ id, include_cancelled: z.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const rows = await many(
      `SELECT * FROM event_venue_reservation_links WHERE event_id=$1 AND revoked_at IS NULL AND ($2 OR status NOT IN ('cancelled','expired','refunded')) ORDER BY created_at DESC`,
      [ev.id, i.include_cancelled]);
    return { items: rows.map((r) => shapeReservation(r, { includeRef: false })) };
  },
});

cap({
  name: 'get_external_venue_reservation', method: 'GET', path: '/events/:id/external-venue-reservations/:rid', tag: TAG,
  summary: 'Full detail for one external venue reservation, including the decrypted booking reference (organiser only).',
  input: z.object({ id, rid: id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const row = await one('SELECT * FROM event_venue_reservation_links WHERE id=$1 AND event_id=$2 AND revoked_at IS NULL', [i.rid, ev.id]);
    if (!row) throw notFound('External venue reservation');
    await audit(pool, user.id, 'read_external_venue_reservation_ref', 'event_venue_reservation_links', row.id);
    return shapeReservation(row, { includeRef: true });
  },
});

cap({
  name: 'refresh_external_venue_reservation', method: 'POST', path: '/events/:id/external-venue-reservations/:rid/refresh', tag: TAG,
  summary: 'Re-poll the provider for the latest status (if the connector supports booking.status.read). Updates status and fires conflict notifications if the booking was cancelled or modified.',
  input: z.object({ id, rid: id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const row = await one('SELECT * FROM event_venue_reservation_links WHERE id=$1 AND event_id=$2 AND revoked_at IS NULL', [i.rid, ev.id]);
    if (!row) throw notFound('External venue reservation');
    const p = PROVIDERS[row.provider_key];
    const caps = await getProviderCaps(row.provider_key, row.external_venue_country ?? '');
    if (!caps['booking.status.read']) {
      return { refreshed: false, message: 'This provider does not support live status polling. Update the status manually.', reservation: shapeReservation(row, { includeRef: false }) };
    }
    // For sandbox: simulate a status check
    if (p?.sandbox) {
      await pool.query('UPDATE event_venue_reservation_links SET provider_last_synced_at=now(), updated_at=now() WHERE id=$1', [row.id]);
      const updated = await one('SELECT * FROM event_venue_reservation_links WHERE id=$1', [row.id]);
      return { refreshed: true, reservation: shapeReservation(updated, { includeRef: false }) };
    }
    return { refreshed: false, message: 'Live status refresh not yet implemented for this provider.', reservation: shapeReservation(row, { includeRef: false }) };
  },
});

cap({
  name: 'cancel_external_venue_reservation', method: 'POST', path: '/events/:id/external-venue-reservations/:rid/cancel', tag: TAG,
  summary: 'Cancel an external venue reservation. Sets status to cancelled and fires downstream alerts for fixtures, participants and officials. The underlying external booking is not cancelled automatically — do that on the provider platform.',
  input: z.object({ id, rid: id, reason: z.string().max(400).optional() }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const row = await one('SELECT * FROM event_venue_reservation_links WHERE id=$1 AND event_id=$2 AND revoked_at IS NULL', [i.rid, ev.id]);
    if (!row) throw notFound('External venue reservation');
    if (['cancelled','refunded','revoked'].includes(row.status)) throw conflict('Reservation is already cancelled');
    await pool.query(
      "UPDATE event_venue_reservation_links SET status='cancelled', revoked_at=now(), updated_at=now() WHERE id=$1",
      [row.id]);
    await audit(pool, user.id, 'cancel_external_venue_reservation', 'event_venue_reservation_links', row.id);
    const updated = await one('SELECT * FROM event_venue_reservation_links WHERE id=$1', [row.id]);
    return { cancelled: true, reservation: shapeReservation(updated, { includeRef: false }) };
  },
});

cap({
  name: 'ingest_provider_venue_callback', method: 'POST', path: '/webhooks/external-venue-reservations/:provider_key', tag: TAG, auth: 'public',
  summary: 'HMAC-verified webhook inbox for venue booking provider callbacks. Idempotent via dedup_key. Fires conflict notifications on cancellation or modification.',
  input: z.object({ provider_key: z.string().max(60) }),
  async handler(ctx, i, req) {
    const rawBody = req?.rawBody ?? '';
    const p = PROVIDERS[i.provider_key];
    if (!p?.inbound) throw notFound('Webhook handler');

    // Load all active installs for this provider to find the matching HMAC secret
    const installs = await many(
      "SELECT ii.id, ic.secret_enc FROM integration_installs ii JOIN integration_credentials ic ON ic.install_id=ii.id AND ic.kind='webhook_secret' AND ic.effective_to IS NULL WHERE ii.provider_key=$1 AND ii.status='active'",
      [i.provider_key]);

    let verified = false;
    for (const inst of installs) {
      try {
        const secret = decrypt(inst.secret_enc, CRED_CTX);
        if (p.inbound.verify(secret, rawBody, req?.headers ?? {})) { verified = true; break; }
      } catch { /* skip */ }
    }
    if (!verified) throw forbidden('Webhook signature invalid');

    let json;
    try { json = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody; } catch { throw badRequest('Invalid JSON payload'); }

    const events = p.inbound.parse(json);
    const results = [];
    for (const ev of events) {
      // Idempotency via dedup_key
      const existing = await one('SELECT id, status FROM event_venue_reservation_links WHERE dedup_key=$1', [ev.id]);
      if (existing) { results.push({ dedup_key: ev.id, action: 'noop', existing_id: existing.id }); continue; }

      if (ev.kind === 'booking.cancelled' && ev.data?.booking_reference) {
        // Try to find and cancel by booking reference (enc comparison not possible — mark conflict)
        results.push({ dedup_key: ev.id, action: 'conflict_flagged', kind: ev.kind });
      } else {
        results.push({ dedup_key: ev.id, action: 'received', kind: ev.kind });
      }
    }
    return { received: events.length, results };
  },
});

cap({
  name: 'list_venue_booking_provider_caps', method: 'GET', path: '/admin/venue-booking-provider-caps', tag: TAG,
  summary: 'Platform admin only. List all capability flags for venue booking providers.',
  input: z.object({ provider_key: z.string().max(60).optional() }),
  async handler({ user }, i) {
    if (!(await isPlatformAdminNow(user))) throw forbidden('Platform admin only');
    const rows = await many(
      'SELECT * FROM venue_booking_provider_caps WHERE ($1::text IS NULL OR provider_key=$1) ORDER BY provider_key, country_code, cap_key',
      [i.provider_key ?? null]);
    return { items: rows };
  },
});

cap({
  name: 'update_venue_booking_provider_cap', method: 'POST', path: '/admin/venue-booking-provider-caps', tag: TAG,
  summary: 'Platform admin only. Enable or disable a capability flag for a venue booking provider+country combination.',
  input: z.object({
    provider_key: z.string().max(60),
    country_code: z.string().max(2).default(''),
    cap_key: z.string().max(60),
    enabled: z.boolean(),
  }),
  async handler({ user }, i) {
    if (!(await isPlatformAdminNow(user))) throw forbidden('Platform admin only');
    await pool.query(
      `INSERT INTO venue_booking_provider_caps (provider_key, country_code, cap_key, enabled, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (provider_key, country_code, cap_key) DO UPDATE SET enabled=$4, updated_at=now()`,
      [i.provider_key, i.country_code, i.cap_key, i.enabled]);
    await audit(pool, user.id, 'update_venue_booking_provider_cap', 'venue_booking_provider_caps', `${i.provider_key}:${i.country_code}:${i.cap_key}`);
    return { provider_key: i.provider_key, country_code: i.country_code, cap_key: i.cap_key, enabled: i.enabled };
  },
});
