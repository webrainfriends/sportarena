// Sports Media, Broadcast & Rights (#590): the auditable rights check before publishing, exporting or handing content to a partner, the audit trail of those checks,
// and the fan's own feed of public media from what they follow. The rules live in `media-rights.js`; this file only asks them and writes the answer down.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { notFound, badRequest } from '../errors.js';
import { RIGHTS_PURPOSES, PLATFORMS, evaluateRights, entitlementById, recordRightsCheck, licenceCovers, eventOf, isOrganiserOf } from '../media-rights.js';
import { viewerOf, visibleTo, getAsset } from './media-rights-assets.js';
import { followedMedia } from '../media-fans.js';

const TAG = 'Media rights checks';

cap({
  name: 'check_media_rights', method: 'POST', path: '/media/assets/:id/rights-check', tag: TAG, status: 201,
  summary: 'Ask whether an asset may be published, exported (copied or linked out) or distributed to a partner right now, for a platform and country if you name them. Every rule is answered (status, file, source, guardian media consent, expiry, embargo, schedule, audience, platform, territory, and the licence in force with its delay) together with the asset\'s provenance, and the check is written down for good whatever the answer. Organisers and owners can check a hand-over against a partner\'s licence with licence_id; a licensed partner checks against its own. Anyone who cannot see the asset gets 404.',
  input: z.object({ id, purpose: z.enum(RIGHTS_PURPOSES), licence_id: id.optional(), platform: z.enum(PLATFORMS).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await getAsset(i.id, c);
    const v = await viewerOf(user, a, c);
    const vis = await visibleTo(a, v, c);
    if (!vis.visible && !vis.privileged) throw notFound('Asset');
    const privileged = v.organiser || v.owner;
    if (i.purpose === 'publish' && !(v.organiser || v.ownerCanAct)) throw notFound('Asset');
    let ent = null;
    if (i.licence_id) {
      ent = privileged ? await entitlementById(c, i.licence_id) : v.ents.find((e) => e.licence_id === i.licence_id) ?? null;
      if (!ent && !privileged) throw notFound('Licence');
      if (!ent) throw badRequest('That licence is not in force', { code: 'licence_not_in_force' });
      if (ent.event_id !== a.event_id) throw badRequest('That licence is for a different event', { code: 'licence_other_event' });
      if (ent.scope_kind === 'collection') v.inColl = (await c.query('SELECT collection_id FROM mr_collection_items WHERE asset_id=$1 AND removed_at IS NULL', [a.id])).rows.map((r) => r.collection_id);
    } else if (!privileged) ent = v.ents.find((e) => licenceCovers(a, e, v.inColl)) ?? v.ents[0] ?? null;
    if (i.purpose === 'distribute' && !ent) throw badRequest('Say which partner licence the asset is being handed over under', { code: 'licence_required' });
    const result = await evaluateRights(c, a, { purpose: i.purpose, viewer: v, ent, platform: i.platform ?? null, country: i.country ?? null });
    const rec = await recordRightsCheck(c, a, { user, purpose: i.purpose, licenceId: ent?.licence_id ?? null, platform: i.platform ?? null, country: i.country ?? null, result });
    return { id: rec.id, checked_at: rec.checked_at, asset_id: a.id, licence_id: ent?.licence_id ?? null, platform: i.platform ?? null, country: i.country ?? null, outcome: result.allowed ? 'allowed' : 'blocked', ...result,
      provenance: privileged ? result.provenance : { owner_kind: result.provenance.owner_kind, owner_name: result.provenance.owner_name, credit: result.provenance.credit } };
  }),
});

cap({
  name: 'list_rights_checks', method: 'GET', path: '/events/:id/media/rights-checks', tag: TAG,
  summary: 'The audit trail of rights checks for an event, newest first: who asked, for which asset and use, the licence, the answer and the rules that failed. Organiser only. Filter by asset or by outcome.',
  input: z.object({ id, asset_id: id.optional(), outcome: z.enum(['allowed', 'blocked']).optional(), purpose: z.enum(['publish', 'export', 'distribute', 'download']).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw notFound('Event');
    const rows = await many(
      `SELECT k.id, k.asset_id, a.title AS asset_title, k.licence_id, l.licence_no, k.purpose, k.platform, k.country, k.outcome, k.checked_at, u.display_name AS checked_by,
              (SELECT coalesce(jsonb_agg(r->>'rule'), '[]') FROM jsonb_array_elements(k.rules) r WHERE (r->>'ok')::boolean = false) AS failed, k.provenance
         FROM mr_rights_checks k JOIN mr_assets a ON a.id=k.asset_id LEFT JOIN mr_licences l ON l.id=k.licence_id LEFT JOIN users u ON u.id=k.user_id
        WHERE k.event_id=$1 AND ($2::uuid IS NULL OR k.asset_id=$2) AND ($3::text IS NULL OR k.outcome=$3) AND ($4::text IS NULL OR k.purpose=$4)
        ORDER BY k.checked_at DESC, k.id LIMIT $5 OFFSET $6`, [i.id, i.asset_id ?? null, i.outcome ?? null, i.purpose ?? null, i.limit, i.offset]);
    const total = (await pool.query('SELECT count(*)::int AS n FROM mr_rights_checks WHERE event_id=$1 AND ($2::uuid IS NULL OR asset_id=$2) AND ($3::text IS NULL OR outcome=$3) AND ($4::text IS NULL OR purpose=$4)', [i.id, i.asset_id ?? null, i.outcome ?? null, i.purpose ?? null])).rows[0].n;
    return { total, items: rows };
  },
});

cap({
  name: 'list_my_media_feed', method: 'GET', path: '/me/media-feed', tag: 'Following',
  summary: 'The public photos and clips of the events, teams, games and athletes you follow, newest first. Only what the rights engine says is live, public and worldwide appears; it is held back the moment it is withdrawn, expires, goes under embargo or loses guardian consent. Turn on the "media" alert on a follow to be told when something new arrives. Following never opens anything private.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(60).default(30) }),
  async handler({ user }, i) { return { items: await followedMedia(user.id, { limit: i.limit }) }; },
});
