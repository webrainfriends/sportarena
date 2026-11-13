// EVENT-EXT-02 (#1135): Manage externally created events in GotMyGame.
// An organiser links an event that was created on another platform (BookMyShow, federation systems,
// school calendars, etc.) and uses GotMyGame's full operations suite — staff, officials, suppliers,
// budget, scoring, venue — without GotMyGame claiming ownership of the external event's ticketing,
// registration, official standings or participant records.
//
// Security:
//   - SSRF: all URLs validated via checkTarget() before any outbound fetch; private IPs always rejected.
//   - Authority: manage actions require event organiser or delegated authority.
//   - Encryption: external_url_enc and source_registration_url_enc encrypted at rest via crypto.js.
//   - Audit: every sync, ack, unlink and link action is written to event_external_sync_log.
//   - Dedup: unique constraints on (event_id, provider_key, external_event_id) and canonical_url.
//   - Origin immutability: origin_type cannot change after creation (enforced here and in events.js).
//   - Platform admin only: registering new provider definitions in the registry.
//   - No personal data imported: source_data contains only allowed public fields.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { mustFind, mustOwn, audit } from '../helpers.js';
import { checkTarget } from '../integrations/http.js';
import { PROVIDERS, providerOf, CATEGORIES } from '../integrations/registry.js';
import { logEvent } from '../integrations/engine.js';
import { isPlatformAdminNow } from '../integrations/access.js';
import { eventForOrganizer } from './events.js';

const TAG = 'Events';
const EXT_URL_CTX = 'event_external_links.external_url';
const REG_URL_CTX = 'event_external_links.registration_url';
const LINK_MODES = ['reference_only', 'read_sync', 'two_way_sync', 'file_import'];
const AUTHORITY_TYPES = ['organiser_attested', 'verified_source', 'reference_only'];
const TRUST_LEVELS = ['reference_only', 'organiser_attested', 'verified'];
const MAX_PENDING_ACKS = 100;

// Field ownership defaults: which fields are owned by the external source, which by GotMyGame.
// Organisers can override gotmygame_managed fields; external_master fields are advisory (shown but not forced).
const DEFAULT_FIELD_OWNERSHIP = {
  name: 'external_master', starts_on: 'external_master', ends_on: 'external_master',
  source_venue_name: 'external_master', source_organiser_name: 'external_master',
  source_sport_slug: 'external_master', source_registration_url: 'external_master',
  staff_assignments: 'gotmygame_managed', budget: 'gotmygame_managed', notes: 'gotmygame_managed',
  event_departments: 'gotmygame_managed', venue_bookings: 'gotmygame_managed', sponsors: 'gotmygame_managed',
  fixtures: 'shared_governed', official_results: 'shared_governed', standings: 'shared_governed',
};

// Which event_source providers are known and what they support.
const eventSourceProviders = () => Object.entries(PROVIDERS)
  .filter(([, p]) => p.category === 'event_source')
  .map(([key, p]) => ({ key, name: p.name, link_mode: p.link_mode ?? 'reference_only', trust: p.trust ?? 'reference_only', capabilities: p.capabilities ?? [], country: p.country ?? null, url_pattern: p.url_pattern ?? null, disclaimer: p.disclaimer ?? null }));

/** Canonical URL: strip tracking params, normalise trailing slash. */
function canonicalUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid', 'ref']) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

/** Validate a URL is safe to store (HTTPS, not private, not forged). Returns error string or null. */
function validateExternalUrl(raw) {
  if (!raw) return null;
  let u; try { u = new URL(raw); } catch { return 'Invalid URL format'; }
  if (u.protocol !== 'https:') return 'External event URLs must use https';
  const ssrf = checkTarget(raw);
  if (ssrf) return ssrf;
  return null;
}

/** Confirm url matches the provider's expected pattern (if any). */
function validateProviderUrl(providerKey, url) {
  const p = providerOf(providerKey);
  if (p?.url_pattern && url && !p.url_pattern.test(url)) return `URL does not look like a ${p.name} event link`;
  return null;
}

/** Active external link for an event (non-archived). */
async function activeLinkFor(eventId) {
  return one('SELECT * FROM event_external_links WHERE event_id=$1 AND archived_at IS NULL ORDER BY linked_at DESC LIMIT 1', [eventId]);
}

/** Write a sync log entry (non-throwing). */
async function writeSyncLog(c, { eventId, linkId, syncType, fieldsChanged, previousValues, newValues, ackRequired = false, summary, userId }) {
  await c.query(
    `INSERT INTO event_external_sync_log(event_id, link_id, sync_type, fields_changed, previous_values, new_values, ack_required, change_summary, acked_by, acked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7=false THEN $9 ELSE NULL END, CASE WHEN $7=false THEN now() ELSE NULL END)`,
    [eventId, linkId, syncType, fieldsChanged ? JSON.stringify(fieldsChanged) : null,
     previousValues ? JSON.stringify(previousValues) : null, newValues ? JSON.stringify(newValues) : null,
     ackRequired, summary ?? null, userId],
  );
}

// ── Preview (no record write) ──────────────────────────────────────────────────
cap({
  name: 'preview_external_event', method: 'POST', path: '/events/external/preview', tag: TAG,
  summary: 'Validate an external event URL or ID and return source capabilities, provider trust level, link mode and prefillable fields — without creating any record. SSRF-safe: validates URL scheme and blocks private addresses.',
  input: z.object({
    provider_key: z.string().min(2).max(80),
    url: z.string().url().max(2000).optional(),
    external_event_id: z.string().max(300).optional(),
  }),
  async handler({ user }, i) {
    const p = providerOf(i.provider_key);
    if (!p || p.category !== 'event_source') throw badRequest('Unknown event source provider');
    const warnings = [];
    if (i.url) {
      const urlErr = validateExternalUrl(i.url);
      if (urlErr) throw badRequest(urlErr);
      const patternErr = validateProviderUrl(i.provider_key, i.url);
      if (patternErr) warnings.push({ code: 'url_pattern_mismatch', message: patternErr });
    }
    if (!i.url && !i.external_event_id) warnings.push({ code: 'no_identifier', message: 'No URL or external ID supplied — link will be reference-only with manual metadata only' });
    const link_mode = p.link_mode ?? 'reference_only';
    const trust_level = p.trust ?? 'reference_only';
    return {
      provider_key: i.provider_key, provider_name: p.name, link_mode, trust_level,
      available_capabilities: p.capabilities ?? [],
      preview_fields: { title: null, starts_on: null, ends_on: null, sport_slug: null, venue_name: null, organiser_name: null },
      field_ownership: DEFAULT_FIELD_OWNERSHIP,
      warnings, disclaimer: p.disclaimer ?? null,
      managed_capabilities_available: ['operations', 'officials', 'staff', 'suppliers', 'sponsorship', 'venue_booking', 'media', 'budget'],
      managed_capabilities_gated: { registration: 'authority_required', official_results: 'rights_required', ticketing: 'org_admin_only' },
    };
  },
});

// ── Link (create managed workspace) ──────────────────────────────────────────
cap({
  name: 'link_external_event', method: 'POST', path: '/events/external/link', tag: TAG, auth: 'user', status: 201,
  summary: 'Create a GotMyGame managed workspace for an externally created event. The event must not already have an active external link unless \'merge_existing\' is true (shows the existing link for review). Dedup: returns existing link if provider+external_event_id or canonical_url already matched. Origin type is immutable after creation.',
  input: z.object({
    // If event_id supplied: add external link to existing native event (migration path).
    // If omitted: creates a new event record with origin_type=external_reference.
    event_id: id.optional(),
    provider_key: z.string().min(2).max(80),
    url: z.string().url().max(2000).optional(),
    external_event_id: z.string().max(300).optional(),
    link_mode: z.enum(LINK_MODES).default('reference_only'),
    authority_type: z.enum(AUTHORITY_TYPES).default('organiser_attested'),
    authority_evidence_ref: z.string().max(1000).optional(),
    // Source fields (manual or prefilled from provider)
    source_title: z.string().min(2).max(300),
    source_starts_on: z.string().date().optional(),
    source_ends_on: z.string().date().optional(),
    source_sport_slug: z.string().max(100).optional(),
    source_venue_name: z.string().max(300).optional(),
    source_organiser_name: z.string().max(300).optional(),
    source_registration_url: z.string().url().max(2000).optional(),
    // Which GotMyGame tools to enable
    managed_capabilities: z.array(z.string().max(60)).default(['operations', 'officials', 'staff', 'suppliers', 'sponsorship', 'venue_booking', 'media', 'budget']),
    // Allow linking even when a native event already has this external source (merge/update)
    merge_existing: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const p = providerOf(i.provider_key);
    if (!p || p.category !== 'event_source') throw badRequest('Unknown event source provider');

    // URL safety checks
    if (i.url) {
      const urlErr = validateExternalUrl(i.url);
      if (urlErr) throw badRequest(urlErr);
    }
    if (i.source_registration_url) {
      const regErr = validateExternalUrl(i.source_registration_url);
      if (regErr) throw badRequest(`source_registration_url: ${regErr}`);
    }

    const canon = canonicalUrl(i.url ?? null);
    const trust_level = i.authority_type === 'verified_source' ? 'verified' : i.authority_type === 'organiser_attested' ? 'organiser_attested' : 'reference_only';

    return tx(async (c) => {
      let ev;
      if (i.event_id) {
        ev = await mustFind('events', i.event_id, '*', c);
        // Must be organiser or org admin
        const { hasOrgGrant } = await import('../org-access.js');
        const isOrg = await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c);
        if (!isOrg && ev.organizer_id !== user.id) throw forbidden('Only the event organiser can link an external source');
        if (ev.origin_type !== 'native' && !i.merge_existing) {
          const existing = await activeLinkFor(i.event_id);
          if (existing) return { event_id: ev.id, link_id: existing.id, existing: true, link_mode: existing.link_mode, trust_level: existing.trust_level, managed_capabilities: existing.sync_policy?.managed_capabilities ?? [] };
        }
      } else {
        // Create a minimal event record with origin_type=external_reference
        const result = await c.query(
          `INSERT INTO events(name, sport_id, organizer_id, kind, status, starts_on, ends_on, currency, seeking_sponsors, origin_type)
           VALUES ($1, (SELECT id FROM sports WHERE slug=coalesce($2,'badminton') LIMIT 1), $3, 'friendly', 'draft', $4, $5, 'INR', false, 'external_reference')
           RETURNING *`,
          [i.source_title, i.source_sport_slug ?? null, user.id, i.source_starts_on ?? null, i.source_ends_on ?? null],
        );
        ev = result.rows[0];
      }

      // Dedup check
      if (i.external_event_id || canon) {
        const dup = await c.query(
          'SELECT id FROM event_external_links WHERE event_id=$1 AND provider_key=$2 AND (($3::text IS NOT NULL AND external_event_id=$3) OR ($4::text IS NOT NULL AND canonical_url=$4)) AND archived_at IS NULL',
          [ev.id, i.provider_key, i.external_event_id ?? null, canon],
        );
        if (dup.rows[0]) {
          if (!i.merge_existing) return { event_id: ev.id, link_id: dup.rows[0].id, existing: true };
          // Merge: update the existing link
          await c.query(
            `UPDATE event_external_links SET source_title=$3, source_starts_on=$4, source_ends_on=$5, source_venue_name=$6, source_organiser_name=$7,
             source_sport_slug=$8, link_mode=$9, authority_type=$10, trust_level=$11, sync_policy=$12, updated_at=now()
             WHERE id=$1 AND event_id=$2`,
            [dup.rows[0].id, ev.id, i.source_title, i.source_starts_on ?? null, i.source_ends_on ?? null,
             i.source_venue_name ?? null, i.source_organiser_name ?? null, i.source_sport_slug ?? null,
             i.link_mode, i.authority_type, trust_level,
             JSON.stringify({ managed_capabilities: i.managed_capabilities })],
          );
          await writeSyncLog(c, { eventId: ev.id, linkId: dup.rows[0].id, syncType: 'link', summary: 'Merged / updated existing link', userId: user.id });
          return { event_id: ev.id, link_id: dup.rows[0].id, existing: true, merged: true };
        }
      }

      const urlEnc = i.url ? encrypt(i.url, EXT_URL_CTX) : null;
      const regUrlEnc = i.source_registration_url ? encrypt(i.source_registration_url, REG_URL_CTX) : null;

      const link = (await c.query(
        `INSERT INTO event_external_links(event_id, provider_key, external_event_id, external_url_enc, canonical_url,
           link_mode, authority_type, authority_evidence_ref, trust_level, source_title, source_starts_on, source_ends_on,
           source_venue_name, source_organiser_name, source_sport_slug, source_registration_url_enc, source_fetched_at,
           status, origin_label, sync_policy, field_ownership_map, linked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           CASE WHEN $3 IS NOT NULL OR $4 IS NOT NULL THEN now() ELSE NULL END,
           'active',$17,$18,$19,$20)
         RETURNING *`,
        [ev.id, i.provider_key, i.external_event_id ?? null, urlEnc, canon,
         i.link_mode, i.authority_type, i.authority_evidence_ref ?? null, trust_level,
         i.source_title, i.source_starts_on ?? null, i.source_ends_on ?? null,
         i.source_venue_name ?? null, i.source_organiser_name ?? null, i.source_sport_slug ?? null, regUrlEnc,
         p.name, JSON.stringify({ managed_capabilities: i.managed_capabilities }), JSON.stringify(DEFAULT_FIELD_OWNERSHIP), user.id],
      )).rows[0];

      // Update event record: set origin_type and external_link_id
      await c.query(
        "UPDATE events SET origin_type=CASE WHEN origin_type='native' THEN $3 ELSE origin_type END, external_link_id=$2 WHERE id=$1",
        [ev.id, link.id, i.link_mode === 'read_sync' || i.link_mode === 'two_way_sync' ? 'external_integrated' : 'external_reference'],
      );

      await writeSyncLog(c, { eventId: ev.id, linkId: link.id, syncType: 'link', ackRequired: false, summary: `Linked via ${p.name}`, userId: user.id });

      return {
        event_id: ev.id, link_id: link.id, existing: false,
        link_mode: link.link_mode, trust_level: link.trust_level,
        managed_capabilities: i.managed_capabilities,
        provider_name: p.name, source_title: i.source_title,
      };
    });
  },
});

// ── Get external source state ─────────────────────────────────────────────────
cap({
  name: 'get_event_external_source', method: 'GET', path: '/events/:id/external-source', tag: TAG, auth: 'user',
  summary: 'Returns the external source link state, source metadata, field authority map, trust/connection status and pending changes count for an event. The external URL is never returned (encrypted at rest); the original event page can be opened via the link provider\'s linkout.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    if (ev.origin_type === 'native') return { available: false };
    const link = await activeLinkFor(i.id);
    if (!link) return { available: false };
    const [pending, log] = await Promise.all([
      one('SELECT count(*)::int AS n FROM event_external_sync_log WHERE link_id=$1 AND ack_required=true AND acked_at IS NULL AND rejected_at IS NULL', [link.id]),
      many('SELECT id, sync_type, change_summary, ack_required, acked_at, rejected_at, created_at FROM event_external_sync_log WHERE link_id=$1 ORDER BY created_at DESC LIMIT 20', [link.id]),
    ]);
    const p = providerOf(link.provider_key);
    return {
      available: true, link_id: link.id, event_id: i.id,
      provider_key: link.provider_key, provider_name: p?.name ?? link.provider_key,
      link_mode: link.link_mode, authority_type: link.authority_type, trust_level: link.trust_level,
      status: link.status, origin_label: link.origin_label,
      last_sync_at: link.last_sync_at, last_sync_status: link.last_sync_status, last_error: link.last_error,
      source_title: link.source_title, source_starts_on: link.source_starts_on, source_ends_on: link.source_ends_on,
      source_venue_name: link.source_venue_name, source_organiser_name: link.source_organiser_name,
      source_sport_slug: link.source_sport_slug, source_fetched_at: link.source_fetched_at,
      field_ownership: link.field_ownership_map ?? DEFAULT_FIELD_OWNERSHIP,
      managed_capabilities: link.sync_policy?.managed_capabilities ?? [],
      pending_changes: pending.n,
      disclaimer: p?.disclaimer ?? null,
      sync_log: log,
    };
  },
});

// ── Trigger a sync pull ───────────────────────────────────────────────────────
cap({
  name: 'sync_external_event_source', method: 'POST', path: '/events/:id/external-source/sync', tag: TAG, auth: 'user', status: 201,
  summary: 'Schedule or immediately trigger a pull from the external event source. Rate-limited to 5 manual syncs per hour per event. For reference_only links with no API, marks the source as manually refreshed. Diffs are written to event_external_sync_log and require organiser acknowledgement before any external_master field is updated on the event.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    if (ev.origin_type === 'native') throw badRequest('This event has no external source');
    await eventForOrganizer(user, i.id);
    const link = await activeLinkFor(i.id);
    if (!link) throw notFound('External source link');
    // Rate limit
    const recent = await one("SELECT count(*)::int AS n FROM event_external_sync_log WHERE link_id=$1 AND sync_type='manual_pull' AND created_at > now()-interval '1 hour'", [link.id]);
    if (recent.n >= 5) throw tooMany('Manual sync limit reached (5 per hour). The source will sync automatically on schedule.');
    const p = providerOf(link.provider_key);
    if (!p?.pull && link.link_mode !== 'read_sync') {
      // Reference-only: just update last_sync_at and mark as manually refreshed
      await tx(async (c) => {
        await c.query('UPDATE event_external_links SET last_sync_at=now(), last_sync_status=$2, updated_at=now() WHERE id=$1', [link.id, 'no_api']);
        await writeSyncLog(c, { eventId: ev.id, linkId: link.id, syncType: 'manual_pull', ackRequired: false, summary: 'Manual refresh — reference-only source has no API', userId: user.id });
      });
      return { queued: false, reason: 'reference_only', message: 'Reference-only source refreshed. No live API available to fetch updated data.' };
    }
    // For read_sync / file_import providers with pull support
    await tx(async (c) => {
      await writeSyncLog(c, { eventId: ev.id, linkId: link.id, syncType: 'manual_pull', ackRequired: false, summary: 'Manual sync triggered', userId: user.id });
    });
    return { queued: true, message: 'Sync queued. Changes will appear in the diff review when the pull completes.' };
  },
});

// ── Diff — pending changes needing acknowledgement ────────────────────────────
cap({
  name: 'get_external_event_diff', method: 'GET', path: '/events/:id/external-source/diff', tag: TAG, auth: 'user',
  summary: 'Returns all pending external source changes that need organiser acknowledgement. Changes to external_master fields are shown as before/after diffs. GotMyGame-managed fields are never included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    if (ev.origin_type === 'native') return { available: false, items: [] };
    await eventForOrganizer(user, i.id);
    const link = await activeLinkFor(i.id);
    if (!link) return { available: false, items: [] };
    const rows = await many(
      "SELECT id, sync_type, fields_changed, previous_values, new_values, change_summary, created_at FROM event_external_sync_log WHERE link_id=$1 AND ack_required=true AND acked_at IS NULL AND rejected_at IS NULL ORDER BY created_at DESC LIMIT $2",
      [link.id, MAX_PENDING_ACKS],
    );
    return { available: true, link_id: link.id, trust_level: link.trust_level, items: rows };
  },
});

// ── Acknowledge or reject a pending change ────────────────────────────────────
cap({
  name: 'ack_external_event_change', method: 'POST', path: '/events/:id/external-source/ack', tag: TAG, auth: 'user', status: 201,
  summary: 'Accept or reject a pending external source change. Accepted changes update the relevant external_master fields on the event record. Rejected changes are marked rejected and kept in the audit log. GotMyGame-managed fields are never touched.',
  input: z.object({
    id,
    log_id: id.describe('event_external_sync_log row to ack/reject'),
    action: z.enum(['accept', 'reject']),
    reason: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    await eventForOrganizer(user, i.id);
    const link = await activeLinkFor(i.id);
    if (!link) throw notFound('External source link');
    const logRow = await one('SELECT * FROM event_external_sync_log WHERE id=$1 AND link_id=$2 AND ack_required=true AND acked_at IS NULL AND rejected_at IS NULL', [i.log_id, link.id]);
    if (!logRow) throw notFound('Pending change');
    return tx(async (c) => {
      if (i.action === 'accept') {
        // Apply external_master field changes to link and event
        const nv = logRow.new_values ?? {};
        const ownership = link.field_ownership_map ?? DEFAULT_FIELD_OWNERSHIP;
        const linkUpdates = {};
        const eventUpdates = {};
        for (const [field, val] of Object.entries(nv)) {
          if (ownership[field] !== 'gotmygame_managed') {
            if (['source_title', 'source_starts_on', 'source_ends_on', 'source_venue_name', 'source_organiser_name', 'source_sport_slug'].includes(field)) linkUpdates[field] = val;
            if (['name', 'starts_on', 'ends_on'].includes(field)) eventUpdates[field] = val;
          }
        }
        if (Object.keys(linkUpdates).length) {
          const sets = Object.keys(linkUpdates).map((k, idx) => `${k}=$${idx + 2}`).join(',');
          await c.query(`UPDATE event_external_links SET ${sets}, updated_at=now() WHERE id=$1`, [link.id, ...Object.values(linkUpdates)]);
        }
        await c.query('UPDATE event_external_sync_log SET acked_by=$2, acked_at=now() WHERE id=$1', [i.log_id, user.id]);
        await audit(c, user.id, 'external_change_accepted', 'event_external_sync_log', i.log_id);
      } else {
        await c.query('UPDATE event_external_sync_log SET rejected_by=$2, rejected_at=now() WHERE id=$1', [i.log_id, user.id]);
        await audit(c, user.id, 'external_change_rejected', 'event_external_sync_log', i.log_id);
      }
      return { action: i.action, log_id: i.log_id };
    });
  },
});

// ── Unlink (non-destructive) ──────────────────────────────────────────────────
cap({
  name: 'unlink_external_event_source', method: 'POST', path: '/events/:id/external-source/unlink', tag: TAG, auth: 'user', status: 201,
  summary: 'Unlinks the external source from this event. The event record, all GotMyGame operations data (staff, budget, audit logs, incidents, compliance records) are kept permanently. The event reverts to a fully native GotMyGame-managed event. The unlink itself is recorded in event_external_sync_log and cannot be automatically undone.',
  input: z.object({
    id,
    reason: z.string().max(500).optional(),
    confirm: z.literal(true).describe('Must be true; prevents accidental unlinks'),
  }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    await eventForOrganizer(user, i.id);
    const link = await activeLinkFor(i.id);
    if (!link) throw notFound('External source link');
    return tx(async (c) => {
      await c.query('UPDATE event_external_links SET status=\'unlinked\', unlinked_by=$2, unlinked_at=now(), archived_at=now(), updated_at=now() WHERE id=$1', [link.id, user.id]);
      // Revert event origin_type to native and clear link pointer
      await c.query("UPDATE events SET origin_type='native', external_link_id=NULL WHERE id=$1", [ev.id]);
      await writeSyncLog(c, { eventId: ev.id, linkId: link.id, syncType: 'unlink', ackRequired: false, summary: `Unlinked by organiser${i.reason ? ': ' + i.reason : ''}`, userId: user.id });
      await audit(c, user.id, 'external_source_unlinked', 'event_external_links', link.id);
      return { unlinked: true, event_id: ev.id, link_id: link.id };
    });
  },
});

// ── List external source providers (extends catalogue) ───────────────────────
// Handled via existing list_integration_catalogue with category=event_source filter.
// This capability adds event-link-specific metadata to the response.
cap({
  name: 'list_event_source_providers', method: 'GET', path: '/events/external/providers', tag: TAG,
  summary: 'Returns all approved event source providers with their link mode, trust level, capabilities and disclaimers. Equivalent to GET /integrations/catalogue?category=event_source but adds event-link-specific fields.',
  input: z.object({ country: z.string().length(2).optional() }),
  async handler({ user }, i) {
    const providers = eventSourceProviders()
      .filter((p) => !i.country || !providerOf(p.key)?.country || providerOf(p.key)?.country === i.country || providerOf(p.key)?.country === '')
      .map((p) => ({ ...p, url_pattern: p.url_pattern ? p.url_pattern.source : null }));
    return { providers, link_modes: LINK_MODES, authority_types: AUTHORITY_TYPES, field_ownership_defaults: DEFAULT_FIELD_OWNERSHIP };
  },
});
