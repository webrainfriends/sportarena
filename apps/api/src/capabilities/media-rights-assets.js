// Sports Media, Broadcast & Rights (#482) 3/4: governed media and clips (rights metadata), content collections, commercial deliverables and measured reach.
// Ownership is never inferred from who uploaded: the owner is declared. What a viewer may see is decided on every request from the asset's own rights
// (status, embargo, expiry, territory, platform), the viewer's licence in force, the package's delay, takedown of the asset or its source, and the LIVE guardian
// media consent of every young person in it. Photos and PDFs live encrypted in the document store; video stays an external link.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { authenticate } from '../auth.js';
import { requireApproved } from '../access.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { hasConsent } from '../youth.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { scanBuffer, scanPolicy } from '../malware-scan.js';
import { RIGHT_KEYS, PLATFORMS, ASSET_COLS, assetState, entitlementsFor, licenceCovers, evaluateRights, recordRightsCheck, provenanceOf, logMr, historyOf, eventOf, isOrganiserOf, myPartners, partnerFor, partnerAdmins, eventOrganisers, IN_FORCE } from '../media-rights.js';
import { notifyAssetFollowers } from '../media-fans.js';
import { MR_UNIT_KINDS } from '../sponsor-roi.js';

const TAG = 'Media assets';
const text = (n) => z.string().trim().max(n);
const dt = z.string().datetime({ offset: true });
const https = z.string().url().regex(/^https:\/\//, 'Use a secure https link').max(500);
const country = z.string().regex(/^[A-Z]{2}$/);
const KINDS = ['video', 'clip', 'photo', 'audio', 'graphic', 'document'];
const CONSENT_KINDS = ['guardian_media', 'athlete_release', 'team_release', 'agreement', 'not_required'];

/** Who the caller is for an asset: organiser, the creator, a member of the owning partner, or a licensee with entitlements. */
export async function viewerOf(user, a, c = pool) {
  const ev = await eventOf(a.event_id, c);
  const organiser = await isOrganiserOf(user, ev, c);
  const owner = !!user && (a.creator_id === user.id || (a.owner_partner_id ? (await myPartners(user, c)).some((p) => p.partner_id === a.owner_partner_id) : false));
  const ownerCanAct = !!user && (organiser || (a.owner_partner_id ? (await myPartners(user, c)).some((p) => p.partner_id === a.owner_partner_id && p.can_act) : false) || (a.creator_id === user.id && !a.owner_partner_id && a.owner_kind !== 'organiser'));
  const ents = user && !organiser && !owner ? await entitlementsFor(user, { eventId: a.event_id, c }) : [];
  const inColl = ents.some((e) => e.scope_kind === 'collection') ? (await c.query('SELECT collection_id FROM mr_collection_items WHERE asset_id=$1 AND removed_at IS NULL', [a.id])).rows.map((r) => r.collection_id) : [];
  return { ev, organiser, owner, ownerCanAct, ents, inColl };
}
/** Is the asset visible to this viewer right now? Privileged people see their own material in any state; everyone else only sees what is live and licensed to them. */
export async function visibleTo(a, v, c = pool) {
  const state = await assetState(a, c);
  if (v.organiser || v.owner) return { state, visible: true, privileged: true };
  if (state !== 'live' || a.audience === 'private') return { state, visible: false };
  if (a.audience === 'public') return { state, visible: true };
  return { state, visible: v.ents.some((e) => licenceCovers(a, e, v.inColl)) };
}
export const getAsset = async (aid, c = pool) => {
  const a = (await c.query(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.id=$1`, [aid])).rows[0];
  if (!a) throw notFound('Asset');
  return a;
};
const linkOf = (a) => (a.source_kind === 'upload' ? (a.stored_file ? `/api/v1/media/assets/${a.id}/file` : null) : a.external_url);

/** The public-safe shape (what a licensee or the public gets) versus the full rights record (organiser, creator, owner). */
async function shape(a, v, vis, c = pool) {
  const base = { id: a.id, event_id: a.event_id, fixture_id: a.fixture_id, parent_asset_id: a.parent_asset_id, kind: a.kind, right_kind: a.right_kind, title: a.title, caption: a.caption, credit: a.credit, platforms: a.platforms, publish_at: a.publish_at, expires_at: a.expires_at, content_type: a.content_type, link: vis.state === 'live' || vis.privileged ? linkOf(a) : null };
  if (!vis.privileged) return base;
  const subjects = (await c.query(
    `SELECT s.id, s.user_id, s.team_id, s.consent_kind, s.consent_ref, u.display_name, t.name AS team_name FROM mr_asset_subjects s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN teams t ON t.id=s.team_id WHERE s.asset_id=$1 AND s.removed_at IS NULL ORDER BY s.created_at`, [a.id])).rows;
  for (const s of subjects) s.media_consent_ok = s.user_id ? await hasConsent(s.user_id, 'media', c) : true;
  return { ...base, state: vis.state, status: a.status, status_reason: a.status_reason, audience: a.audience, territory_mode: a.territory_mode, countries: a.countries, embargo_until: a.embargo_until, owner_kind: a.owner_kind, owner_partner_id: a.owner_partner_id, owner_name: a.owner_name,
    creator_id: a.creator_id, source_kind: a.source_kind, file_pending: a.source_kind === 'upload' && !a.stored_file, subjects, source_blocked: a.source_blocked, row_version: a.row_version, can: { act: v.ownerCanAct, take_down: v.organiser } };
}

const subjectInput = z.object({ user_id: id.optional(), team_id: id.optional(), consent_kind: z.enum(CONSENT_KINDS), consent_ref: text(160).optional() }).refine((s) => s.user_id || s.team_id, 'Name a person or a team');
async function putSubjects(c, a, subjects, actor) {
  await c.query('UPDATE mr_asset_subjects SET removed_at=now() WHERE asset_id=$1 AND removed_at IS NULL', [a.id]);
  for (const s of subjects) {
    if (s.user_id && !(await c.query('SELECT 1 FROM users WHERE id=$1', [s.user_id])).rowCount) throw notFound('Person');
    if (s.team_id && !(await c.query('SELECT 1 FROM teams WHERE id=$1', [s.team_id])).rowCount) throw notFound('Team');
    await c.query('INSERT INTO mr_asset_subjects(asset_id, user_id, team_id, consent_kind, consent_ref, added_by) VALUES ($1,$2,$3,$4,$5,$6)', [a.id, s.user_id ?? null, s.team_id ?? null, s.consent_kind, s.consent_ref ?? null, actor]);
  }
}
/** Young people in an asset need current guardian media consent before it can be published. */
async function youthWithoutConsent(c, aid) {
  const out = [];
  for (const s of (await c.query('SELECT user_id FROM mr_asset_subjects WHERE asset_id=$1 AND removed_at IS NULL AND user_id IS NOT NULL', [aid])).rows) if (!(await hasConsent(s.user_id, 'media', c))) out.push(s.user_id);
  return out;
}

// ------------------------------------------------------------------ collections
cap({
  name: 'save_media_collection', method: 'POST', path: '/events/:id/media/collections', tag: TAG, status: 201,
  summary: 'Create (or rename / archive) an approved content collection of an event: a named set of assets that a rights package can be scoped to. Organiser only.',
  input: z.object({ id, collection_id: id.optional(), name: text(100).min(2), description: text(500).optional(), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    if (!(await isOrganiserOf(user, ev, c))) throw forbidden('Only the organiser of this event can do that');
    try {
      if (i.collection_id) {
        const r = (await c.query('UPDATE mr_collections SET name=$3, description=$4, archived_at=CASE WHEN $5::boolean THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 AND event_id=$2 RETURNING *', [i.collection_id, i.id, i.name, i.description ?? null, !!i.archived])).rows[0];
        if (!r) throw notFound('Collection');
        return r;
      }
      const r = (await c.query('INSERT INTO mr_collections(event_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.name, i.description ?? null, user.id])).rows[0];
      await logMr(c, i.id, 'collection', r.id, 'created', { actor: user.id });
      return r;
    } catch (e) { if (e.code === '23505') throw conflict('There is already a collection with that name'); throw e; }
  }),
});

cap({
  name: 'list_media_collections', method: 'GET', path: '/events/:id/media/collections', tag: TAG,
  summary: 'The content collections of an event with how many assets each holds. Organiser only.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    if (!(await isOrganiserOf(user, ev))) throw forbidden('Only the organiser of this event can do that');
    return many('SELECT c.*, (SELECT count(*)::int FROM mr_collection_items x WHERE x.collection_id=c.id AND x.removed_at IS NULL) AS assets FROM mr_collections c WHERE c.event_id=$1 AND ($2 OR c.archived_at IS NULL) ORDER BY c.name', [i.id, i.include_archived]);
  },
});

cap({
  name: 'set_collection_assets', method: 'POST', path: '/media/collections/:id/assets', tag: TAG,
  summary: 'Add assets to a collection, or take some out (they stay in the library). Only assets of the same event can be added.',
  input: z.object({ id, add: z.array(id).max(200).default([]), remove: z.array(id).max(200).default([]) }),
  handler: ({ user }, i) => tx(async (c) => {
    const col = (await c.query('SELECT * FROM mr_collections WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!col) throw notFound('Collection');
    if (!(await isOrganiserOf(user, await eventOf(col.event_id, c), c))) throw notFound('Collection');
    if (col.archived_at) throw conflict('This collection is archived');
    if (i.add.length && (await c.query('SELECT count(*)::int AS n FROM mr_assets WHERE id = ANY($1) AND event_id=$2', [i.add, col.event_id])).rows[0].n !== new Set(i.add).size) throw badRequest('Only assets of this event can be added');
    for (const a of new Set(i.add)) await c.query('INSERT INTO mr_collection_items(collection_id, asset_id, added_by) VALUES ($1,$2,$3) ON CONFLICT (collection_id, asset_id) DO UPDATE SET removed_at=NULL, added_by=EXCLUDED.added_by, added_at=now()', [col.id, a, user.id]);
    if (i.remove.length) await c.query('UPDATE mr_collection_items SET removed_at=now() WHERE collection_id=$1 AND asset_id = ANY($2) AND removed_at IS NULL', [col.id, i.remove]);
    await logMr(c, col.event_id, 'collection', col.id, 'assets_changed', { actor: user.id, detail: { added: i.add.length, removed: i.remove.length } });
    return { id: col.id, assets: (await c.query('SELECT count(*)::int AS n FROM mr_collection_items WHERE collection_id=$1 AND removed_at IS NULL', [col.id])).rows[0].n };
  }),
});

// ------------------------------------------------------------------ assets
const rightsInput = {
  audience: z.enum(['private', 'licensed', 'public']).default('private').describe('private: only the organiser, the creator and the owner; licensed: only partners whose licence covers it; public'),
  territory_mode: z.enum(['worldwide', 'include', 'exclude']).default('worldwide'), countries: z.array(country).max(250).default([]), platforms: z.array(z.enum(PLATFORMS)).max(8).default([]),
  publish_at: dt.optional(), embargo_until: dt.optional(), expires_at: dt.optional(),
};
const checkDates = (i) => {
  if (i.territory_mode !== 'worldwide' && !i.countries.length) throw badRequest('Name the countries this restriction covers');
  const t = (x) => (x ? new Date(x).getTime() : null);
  if (t(i.expires_at) && t(i.publish_at) && t(i.expires_at) <= t(i.publish_at)) throw badRequest('The asset must expire after it is published');
  if (t(i.expires_at) && t(i.embargo_until) && t(i.expires_at) <= t(i.embargo_until)) throw badRequest('The asset must expire after its embargo lifts');
};

cap({
  name: 'register_media_asset', method: 'POST', path: '/events/:id/media/assets', tag: TAG, status: 201,
  summary: 'Register a media asset or clip with its rights: the game it comes from, who made it, WHO OWNS it (declared, never assumed from the upload), the right it is released under, audience, territory and platform limits, publish / embargo / expiry dates, who appears in it with their consent, and the asset it was cut from (a derivative). Give an https `external_url` for video or audio, or leave it out for a photo / PDF and upload the file to `PUT /media/assets/:id/file`. It starts as a draft.',
  input: z.object({ id, kind: z.enum(KINDS), right_kind: z.enum(RIGHT_KEYS), title: text(140).min(2), caption: text(500).optional(), credit: text(120).optional(), fixture_id: id.optional(), parent_asset_id: id.optional(),
    owner_kind: z.enum(['organiser', 'partner', 'athlete', 'third_party']), owner_partner_id: id.optional(), owner_name: text(160).optional(), external_url: https.optional(), subjects: z.array(subjectInput).max(50).default([]), ...rightsInput }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await eventOf(i.id, c);
    const organiser = await isOrganiserOf(user, ev, c);
    const mine = await myPartners(user, c);
    const ents = organiser ? [] : (await entitlementsFor(user, { eventId: i.id, c }));
    const crew = organiser ? false : (await c.query("SELECT 1 FROM mr_crew WHERE event_id=$1 AND user_id=$2 AND status IN ('assigned','acknowledged')", [i.id, user.id])).rowCount > 0;
    if (!organiser && !ents.length && !crew) throw notFound('Event');
    checkDates(i);
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    if (i.owner_kind === 'organiser' && !organiser) throw forbidden('Only the organiser can register organiser-owned material');
    if (i.owner_kind === 'partner') {
      if (!i.owner_partner_id) throw badRequest('Say which media partner owns it');
      if (!organiser && !mine.some((p) => p.partner_id === i.owner_partner_id && p.can_act)) throw forbidden('You can only register material for a partner you act for');
      if (!(await c.query("SELECT 1 FROM media_partners WHERE id=$1 AND status='active'", [i.owner_partner_id])).rowCount) throw notFound('Media partner');
    } else if (i.owner_partner_id) throw badRequest('Only partner-owned material names a partner');
    if (['athlete', 'third_party'].includes(i.owner_kind) && !i.owner_name) throw badRequest('Name the owner or rights holder');
    if (i.parent_asset_id) {
      const par = await getAsset(i.parent_asset_id, c);
      if (par.event_id !== i.id) throw badRequest('A derivative must come from an asset of the same event');
      const pv = await viewerOf(user, par, c);
      if (!pv.organiser && !pv.owner) throw forbidden('Only the organiser or the owner of the source can cut a derivative from it');
      if (['withdrawn', 'taken_down'].includes(par.status)) throw conflict('The source asset has been withdrawn');
    }
    if (i.kind === 'photo' || i.kind === 'document' || i.kind === 'graphic') { /* may be uploaded or linked */ } else if (!i.external_url) throw badRequest('Video and audio are kept where they are hosted: give its https link');
    const r = (await c.query(
      `INSERT INTO mr_assets(event_id, fixture_id, parent_asset_id, kind, right_kind, title, caption, credit, creator_id, owner_kind, owner_partner_id, owner_name, source_kind, external_url, audience, territory_mode, countries, platforms, publish_at, embargo_until, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [i.id, i.fixture_id ?? null, i.parent_asset_id ?? null, i.kind, i.right_kind, i.title, i.caption ?? null, i.credit ?? null, user.id, i.owner_kind, i.owner_partner_id ?? null, i.owner_name ?? null, i.external_url ? 'external_link' : 'upload', i.external_url ?? null,
        i.audience, i.territory_mode, i.territory_mode === 'worldwide' ? [] : [...new Set(i.countries)], [...new Set(i.platforms)], i.publish_at ?? null, i.embargo_until ?? null, i.expires_at ?? null])).rows[0];
    await putSubjects(c, r, i.subjects, user.id);
    await logMr(c, i.id, 'asset', r.id, 'registered', { actor: user.id, detail: { right_kind: r.right_kind, owner_kind: r.owner_kind, parent: r.parent_asset_id } });
    const a = await getAsset(r.id, c);
    return shape(a, await viewerOf(user, a, c), { state: 'draft', visible: true, privileged: true }, c);
  }),
});

cap({
  name: 'update_media_asset_rights', method: 'POST', path: '/media/assets/:id/rights', tag: TAG,
  summary: 'Change an asset\'s rights metadata (title, caption, credit, right, audience, territory, platforms, publish / embargo / expiry dates) or who appears in it. The organiser, the creator and the owning partner can; it is a new version and the change is logged. A withdrawn or taken-down asset can only be restored by the organiser.',
  input: z.object({ id, row_version: z.number().int().min(1), title: text(140).min(2).optional(), caption: text(500).nullish(), credit: text(120).nullish(), right_kind: z.enum(RIGHT_KEYS).optional(), fixture_id: id.nullish(),
    audience: z.enum(['private', 'licensed', 'public']).optional(), territory_mode: z.enum(['worldwide', 'include', 'exclude']).optional(), countries: z.array(country).max(250).optional(), platforms: z.array(z.enum(PLATFORMS)).max(8).optional(),
    publish_at: dt.nullish(), embargo_until: dt.nullish(), expires_at: dt.nullish(), subjects: z.array(subjectInput).max(50).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query('SELECT id FROM mr_assets WHERE id=$1 FOR UPDATE', [i.id]);
    const a = await getAsset(i.id, c);
    const v = await viewerOf(user, a, c);
    if (!v.organiser && !v.owner) throw notFound('Asset');
    if (!v.ownerCanAct) throw forbidden('Your role cannot change this asset');
    if (a.row_version !== i.row_version) throw conflict('Someone changed this asset; reload it', { code: 'stale_version' });
    if (['withdrawn', 'taken_down'].includes(a.status)) throw conflict('Restore the asset to a draft first');
    const n = { ...a, ...Object.fromEntries(Object.entries(i).filter(([k, x]) => x !== undefined && !['id', 'row_version', 'subjects'].includes(k))) };
    checkDates({ ...n, countries: n.countries ?? [] });
    if (n.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [n.fixture_id, a.event_id])).rowCount) throw badRequest('Choose a game of this event');
    const row = (await c.query(
      `UPDATE mr_assets SET title=$2, caption=$3, credit=$4, right_kind=$5, fixture_id=$6, audience=$7, territory_mode=$8, countries=$9, platforms=$10, publish_at=$11, embargo_until=$12, expires_at=$13, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [a.id, n.title, n.caption, n.credit, n.right_kind, n.fixture_id, n.audience, n.territory_mode, n.territory_mode === 'worldwide' ? [] : [...new Set(n.countries)], [...new Set(n.platforms ?? [])], n.publish_at, n.embargo_until, n.expires_at])).rows[0];
    if (i.subjects) await putSubjects(c, row, i.subjects, user.id);
    await logMr(c, a.event_id, 'asset', a.id, 'rights_changed', { actor: user.id, detail: { audience: row.audience, publish_at: row.publish_at, embargo_until: row.embargo_until, expires_at: row.expires_at } });
    const fresh = await getAsset(a.id, c);
    return shape(fresh, v, { state: await assetState(fresh, c), visible: true, privileged: true }, c);
  }),
});

const ASSET_ACTIONS = z.enum(['publish', 'withdraw', 'take_down', 'restore']);
cap({
  name: 'set_media_asset_status', method: 'POST', path: '/media/assets/:id/status', tag: TAG,
  summary: 'Publish a draft, withdraw it, take it down, or restore it to draft. Publishing needs a file or link, an owner, and current guardian media consent for every young person in it. Withdrawing and taking down need a reason, are never deletion (the record, the file and the history are kept for retention and contract purposes), and hide the asset and every clip derived from it at once. Only the organiser can take down.',
  input: z.object({ id, action: ASSET_ACTIONS, reason: text(500).optional(), row_version: z.number().int().min(1) }),
  handler: async ({ user }, i) => {
   // a blocked publish is still written down: the check is recorded after the failed transaction has rolled back
   const blocked = {};
   try { return await tx(async (c) => {
    await c.query('SELECT id FROM mr_assets WHERE id=$1 FOR UPDATE', [i.id]);
    const a = await getAsset(i.id, c);
    const v = await viewerOf(user, a, c);
    if (!v.organiser && !v.owner) throw notFound('Asset');
    if (a.row_version !== i.row_version) throw conflict('Someone changed this asset; reload it', { code: 'stale_version' });
    let to;
    if (i.action === 'publish') {
      if (!v.ownerCanAct) throw forbidden('Your role cannot publish this asset');
      if (a.status !== 'draft') throw conflict('Only a draft can be published');
      const check = await evaluateRights(c, a, { purpose: 'publish', viewer: v });
      if (!check.allowed) {
        blocked.check = { a, user, purpose: 'publish', result: check };
        const f = check.rules.find((r) => !r.ok);
        if (f.rule === 'file') throw badRequest(f.detail, { code: 'file_required' });
        if (f.rule === 'consent') throw conflict(f.detail, { code: 'guardian_consent_required', purpose: 'media', count: f.count });
        throw conflict(f.detail, { code: `rights_${f.rule}`, rules: check.rules });
      }
      await recordRightsCheck(c, a, { user, purpose: 'publish', result: check });
      to = 'published';
    } else if (i.action === 'withdraw') {
      if (!v.ownerCanAct && a.creator_id !== (user?.id)) throw forbidden('Your role cannot withdraw this asset');
      if (a.status !== 'published') throw conflict('Only a published asset can be withdrawn');
      to = 'withdrawn';
    } else if (i.action === 'take_down') {
      if (!v.organiser) throw forbidden('Only the organiser can take an asset down');
      if (['taken_down'].includes(a.status)) throw conflict('Already taken down');
      to = 'taken_down';
    } else {
      if (!v.organiser) throw forbidden('Only the organiser can restore an asset');
      if (!['withdrawn', 'taken_down'].includes(a.status)) throw conflict('Only a withdrawn or taken-down asset can be restored');
      to = 'draft';
    }
    if (['withdraw', 'take_down'].includes(i.action) && !i.reason) throw badRequest('Say why', { code: 'reason_required' });
    const row = (await c.query('UPDATE mr_assets SET status=$2, status_reason=$3, status_changed_by=$4, status_changed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [a.id, to, i.reason ?? null, user.id])).rows[0];
    await logMr(c, a.event_id, 'asset', a.id, i.action, { actor: user.id, detail: { from: a.status, to, reason: i.reason ?? null } });
    if (['withdraw', 'take_down'].includes(i.action)) {
      const who = [a.creator_id, ...(a.owner_partner_id ? await partnerAdmins(c, a.owner_partner_id) : []), ...(await eventOrganisers(c, v.ev))];
      for (const uid of new Set(who)) if (uid !== user.id) await notify(c, uid, { kind: `media_asset_${i.action}`, title: i.action === 'take_down' ? 'Media taken down' : 'Media withdrawn', body: `${a.title} · ${v.ev.name}: ${i.reason}`, data: { asset_id: a.id }, dedupe_key: `mr-asset-${i.action}:${a.id}:${row.row_version}:${uid}` });
    }
    const fresh = await getAsset(a.id, c);
    const state = await assetState(fresh, c);
    if (i.action === 'publish') await notifyAssetFollowers(c, fresh, state);
    return shape(fresh, v, { state, visible: true, privileged: true }, c);
   }); } catch (e) {
     if (blocked.check) await recordRightsCheck(pool, blocked.check.a, blocked.check).catch(() => {});
     throw e;
   }
  },
});

cap({
  name: 'list_media_assets', method: 'GET', path: '/events/:id/media/assets', tag: TAG,
  summary: 'The media of an event as the caller may see it. The organiser sees every asset with its live state (draft, scheduled, embargoed, live, expired, consent lapsed, withdrawn, taken down, source withdrawn); creators and owning partners see their own; licensed partners and the public see only what is live and covered by their rights.',
  input: z.object({ id, fixture_id: id.optional(), right_kind: z.enum(RIGHT_KEYS).optional(), state: z.enum(['draft', 'scheduled', 'embargoed', 'live', 'expired', 'consent_lapsed', 'withdrawn', 'taken_down', 'source_withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventOf(i.id);
    const organiser = await isOrganiserOf(user, ev);
    if (!organiser && ev.status === 'draft') throw notFound('Event');
    const rows = await many(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.event_id=$1 AND ($2::uuid IS NULL OR a.fixture_id=$2) AND ($3::text IS NULL OR a.right_kind=$3)
      AND ($4 OR a.creator_id=$5 OR a.owner_partner_id = ANY($6) OR (a.status='published' AND a.audience <> 'private')) ORDER BY a.created_at DESC LIMIT 500`,
      [i.id, i.fixture_id ?? null, i.right_kind ?? null, organiser, user?.id ?? null, (await myPartners(user)).map((p) => p.partner_id)]);
    const out = [];
    for (const a of rows) {
      const v = await viewerOf(user, a);
      const vis = await visibleTo(a, v);
      if (!vis.visible || (i.state && vis.state !== i.state)) continue;
      out.push(await shape(a, v, vis));
    }
    return { total: out.length, items: out.slice(i.offset, i.offset + i.limit) };
  },
});

cap({
  name: 'get_media_asset', method: 'GET', path: '/media/assets/:id', tag: TAG,
  summary: 'One asset: its rights, state and (for the organiser, creator and owner) who appears in it with live consent status, the clips derived from it, and its history. Anyone else gets a 404 unless it is live and covered by their rights.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await getAsset(i.id).catch(() => { throw notFound('Asset'); });
    const v = await viewerOf(user, a);
    const vis = await visibleTo(a, v);
    if (!vis.visible) throw notFound('Asset');
    const out = await shape(a, v, vis);
    if (!vis.privileged) return out;
    return { ...out, derivatives: await many('SELECT id, title, kind, status FROM mr_assets WHERE parent_asset_id=$1 ORDER BY created_at', [a.id]), history: await historyOf('asset', a.id) };
  },
});

// ------------------------------------------------------------------ bytes: upload and governed download (outside the JSON router, like the other document folders)
export function mediaAssetFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });

  // PUT /api/v1/media/assets/:id/file?name=…   body = the raw photo or PDF (draft assets only; replacing keeps the earlier file on disk)
  r.put('/media/assets/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      const { id: aid } = z.object({ id }).parse({ id: req.params.id });
      const a = await getAsset(aid);
      const v = await viewerOf(user, a);
      if (!v.organiser && !v.owner) throw notFound('Asset');
      if (!v.ownerCanAct) throw forbidden('Your role cannot change this asset');
      if (a.source_kind !== 'upload') throw conflict('This asset is a link; it has no file');
      if (a.status !== 'draft') throw conflict('Files can only be added to a draft');
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Upload a JPEG, PNG or WebP photo, or a PDF. Video is kept where it is hosted: register it with its https link.');
      const scan = await scanBuffer(buf);
      if (scan.status === 'infected') throw badRequest('That file was rejected by the malware scan');
      if (scan.status === 'unavailable' && scanPolicy().mode === 'required') throw new AppError(503, 'scan_unavailable', 'Files cannot be checked right now. Try again shortly.');
      const { file } = await saveEncrypted('media-rights', 'mr_assets.stored_file', buf);
      const name = String(req.query.name ?? 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
      await tx(async (c) => {
        await c.query('UPDATE mr_assets SET stored_file=$2, file_name=$3, content_type=$4, size_bytes=$5, sha256=$6, row_version=row_version+1, updated_at=now() WHERE id=$1', [a.id, file, name, t.type, buf.length, createHash('sha256').update(buf).digest('hex')]);
        await logMr(c, a.event_id, 'asset', a.id, 'file_uploaded', { actor: user.id, detail: { content_type: t.type, bytes: buf.length } });
      });
      res.status(201).json({ id: a.id, content_type: t.type, size_bytes: buf.length, url: `/api/v1/media/assets/${a.id}/file` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/media/assets/:id/file — needs the Authorization header for anything that is not public; rights are re-checked on every request.
  r.get('/media/assets/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization).catch(() => null);
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Asset');
      const a = await getAsset(req.params.id);
      if (a.source_kind !== 'upload' || !a.stored_file) throw notFound('Asset');
      const vis = await visibleTo(a, await viewerOf(user, a));
      if (!vis.visible) throw notFound('Asset');
      if (a.audience !== 'public' && !user) throw unauthorized();
      if (user && !vis.privileged) await recordRightsCheck(pool, a, { user, purpose: 'download', result: { allowed: true, rules: [{ rule: 'visibility', ok: true, label: 'Live, and covered by the audience or licence' }], provenance: await provenanceOf(pool, a) } });
      const bytes = await loadEncrypted('media-rights', 'mr_assets.stored_file', a.stored_file);
      res.set(docHeaders(a.content_type, bytes)).send(bytes);
    } catch (e) { fail(res, e); }
  });
  return r;
}

// ------------------------------------------------------------------ commercial deliverables and measured reach
const licForDeliverables = async (user, lid, c = pool) => {
  const lic = (await c.query('SELECT l.*, p.event_id, e.organizer_id, e.organisation_id AS event_org_id FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN events e ON e.id=p.event_id WHERE l.id=$1', [lid])).rows[0];
  if (!lic) throw notFound('Licence');
  const ev = await eventOf(lic.event_id, c);
  const organiser = await isOrganiserOf(user, ev, c);
  let partner = null; try { partner = await partnerFor(user, lic.partner_id, { c }); } catch { /* not a member */ }
  if (!organiser && !partner) throw notFound('Licence');
  return { lic, ev, organiser, partner, partnerCanAct: !!partner && ['owner', 'admin', 'manager', 'legal', 'approver'].includes(partner.role) };
};
const DEL_VIEW = `d.*, s.status AS sponsorship_status, sp.name AS sponsor_name`;
const DEL_FROM = `mr_deliverables d LEFT JOIN sponsorships s ON s.id=d.sponsorship_id LEFT JOIN sponsors sp ON sp.id=s.sponsor_id`;

cap({
  name: 'save_media_deliverable', method: 'POST', path: '/media/licences/:id/deliverables', tag: TAG, status: 201,
  summary: 'Record a commercial deliverable a licence carries (naming mention, graphic overlay, content piece, signage), optionally pointing at the sponsorship of the event it fulfils. The Sponsorship agreement stays authoritative; this only tracks delivery. Organiser only. Pass `deliverable_id` to change one.',
  input: z.object({ id, deliverable_id: id.optional(), kind: z.enum(['naming_mention', 'graphic_overlay', 'content_piece', 'signage', 'other']), title: text(140).min(2), detail: text(1000).optional(), due_at: dt.optional(), sponsorship_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licForDeliverables(user, i.id, c);
    if (!a.organiser) throw forbidden('Only the organiser can set deliverables');
    if (i.sponsorship_id && !(await c.query("SELECT 1 FROM sponsorships WHERE id=$1 AND target_type='event' AND target_id=$2", [i.sponsorship_id, a.lic.event_id])).rowCount) throw badRequest('That sponsorship is not one of this event\'s');
    // sponsor inventory (#519): once the event sells this kind of placement, a deliverable that names a sponsorship needs that sponsorship's live booking
    let bookingId = null;
    const unitKinds = MR_UNIT_KINDS[i.kind] ?? [];
    if (i.sponsorship_id && unitKinds.length && (await c.query("SELECT 1 FROM sponsor_inventory_units WHERE target_type='event' AND target_id=$1 AND status='active' AND kind = ANY($2)", [a.lic.event_id, unitKinds])).rowCount) {
      bookingId = (await c.query(`SELECT b.id FROM sponsor_inventory_bookings b JOIN sponsor_inventory_units u ON u.id=b.unit_id WHERE b.sponsorship_id=$1 AND b.status='confirmed' AND b.ends_on >= current_date
        AND u.target_type='event' AND u.target_id=$2 AND u.kind = ANY($3) ORDER BY b.starts_on LIMIT 1`, [i.sponsorship_id, a.lic.event_id, unitKinds])).rows[0]?.id;
      if (!bookingId) throw conflict('This event sells that kind of placement as sponsor inventory: the sponsor needs a live booking for it first', { code: 'inventory_required' });
    }
    let row;
    if (i.deliverable_id) {
      row = (await c.query("UPDATE mr_deliverables SET kind=$3, title=$4, detail=$5, due_at=$6, sponsorship_id=$7, booking_id=$8 WHERE id=$1 AND licence_id=$2 AND status IN ('planned','missed') RETURNING *", [i.deliverable_id, a.lic.id, i.kind, i.title, i.detail ?? null, i.due_at ?? null, i.sponsorship_id ?? null, bookingId])).rows[0];
      if (!row) throw conflict('That deliverable cannot be changed any more');
    } else row = (await c.query('INSERT INTO mr_deliverables(licence_id, kind, title, detail, due_at, sponsorship_id, created_by, booking_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [a.lic.id, i.kind, i.title, i.detail ?? null, i.due_at ?? null, i.sponsorship_id ?? null, user.id, bookingId])).rows[0];
    await logMr(c, a.lic.event_id, 'deliverable', row.id, i.deliverable_id ? 'updated' : 'created', { actor: user.id });
    return row;
  }),
});

cap({
  name: 'set_media_deliverable_status', method: 'POST', path: '/media/deliverables/:id/status', tag: TAG,
  summary: 'Mark a deliverable delivered (the partner, with evidence: a link or one of its assets), verified or missed (the organiser). Verification needs a delivery first.',
  input: z.object({ id, status: z.enum(['delivered', 'verified', 'missed']), evidence_url: https.optional(), evidence_asset_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM mr_deliverables WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!d) throw notFound('Deliverable');
    const a = await licForDeliverables(user, d.licence_id, c);
    if (i.status === 'delivered') {
      if (!a.partnerCanAct && !a.organiser) throw forbidden('Your role cannot do that');
      if (!['planned', 'missed'].includes(d.status)) throw conflict('Already delivered');
      if (d.booking_id && !(await c.query("SELECT 1 FROM sponsor_inventory_bookings WHERE id=$1 AND status='confirmed'", [d.booking_id])).rowCount) throw conflict('The sponsor inventory booking that authorised this placement was released', { code: 'booking_released' });
      if (!i.evidence_url && !i.evidence_asset_id) throw badRequest('Attach evidence of delivery: a link or an asset', { code: 'evidence_required' });
      if (i.evidence_asset_id && !(await c.query('SELECT 1 FROM mr_assets WHERE id=$1 AND event_id=$2', [i.evidence_asset_id, a.lic.event_id])).rowCount) throw badRequest('That asset is not one of this event\'s');
    } else {
      if (!a.organiser) throw forbidden('Only the organiser can do that');
      if (i.status === 'verified' && d.status !== 'delivered') throw conflict('Only a delivered item can be verified');
    }
    const row = (await c.query(
      `UPDATE mr_deliverables SET status=$2, evidence_url=coalesce($3, evidence_url), evidence_asset_id=coalesce($4, evidence_asset_id), delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
              verified_by=CASE WHEN $2='verified' THEN $5::uuid ELSE verified_by END, verified_at=CASE WHEN $2='verified' THEN now() ELSE verified_at END WHERE id=$1 RETURNING *`,
      [d.id, i.status, i.evidence_url ?? null, i.evidence_asset_id ?? null, user.id])).rows[0];
    await logMr(c, a.lic.event_id, 'deliverable', d.id, i.status, { actor: user.id });
    return row;
  }),
});

cap({
  name: 'list_media_deliverables', method: 'GET', path: '/media/licences/:id/deliverables', tag: TAG,
  summary: 'The deliverables of a licence with their delivery state, the linked sponsorship (its own status, read live) and the measured reach recorded against them. Reach is only what a named analytics source reported; nothing is estimated.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await licForDeliverables(user, i.id);
    const items = await many(`SELECT ${DEL_VIEW} FROM ${DEL_FROM} WHERE d.licence_id=$1 ORDER BY d.due_at NULLS LAST, d.created_at`, [i.id]);
    const measured = await many('SELECT id, deliverable_id, stream_id, metric, value, period_start, period_end, source_name, source_ref, created_at FROM mr_measurements WHERE licence_id=$1 ORDER BY period_end DESC LIMIT 200', [i.id]);
    return { items, measurements: measured, note: measured.length ? 'Reach shown is as reported by each named source.' : 'No measured reach has been recorded. SportArena does not estimate impressions or ROI.' };
  },
});

cap({
  name: 'record_media_measurement', method: 'POST', path: '/media/licences/:id/measurements', tag: TAG, status: 201,
  summary: 'Record a number measured by a named provider or analytics source (views, unique viewers, peak concurrent, watch minutes, impressions) for a period, against a licence, optionally a stream or deliverable. The source name and reference are required, and nothing here is ever estimated or extrapolated.',
  input: z.object({ id, metric: z.enum(['views', 'unique_viewers', 'peak_concurrent', 'watch_minutes', 'impressions']), value: z.number().int().min(0).max(1_000_000_000_000), period_start: dt, period_end: dt, source_name: text(80).min(2), source_ref: text(300).min(2), stream_id: id.optional(), deliverable_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licForDeliverables(user, i.id, c);
    if (!a.organiser && !a.partnerCanAct) throw forbidden('Your role cannot do that');
    if (new Date(i.period_end) < new Date(i.period_start)) throw badRequest('The period must end after it starts');
    if (new Date(i.period_start) > new Date()) throw badRequest('A measurement cannot be for the future');
    if (i.stream_id && !(await c.query('SELECT 1 FROM mr_streams WHERE id=$1 AND licence_id=$2', [i.stream_id, a.lic.id])).rowCount) throw badRequest('That stream is not under this licence');
    if (i.deliverable_id && !(await c.query('SELECT 1 FROM mr_deliverables WHERE id=$1 AND licence_id=$2', [i.deliverable_id, a.lic.id])).rowCount) throw badRequest('That deliverable is not on this licence');
    const row = (await c.query('INSERT INTO mr_measurements(licence_id, stream_id, deliverable_id, metric, value, period_start, period_end, source_name, source_ref, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [a.lic.id, i.stream_id ?? null, i.deliverable_id ?? null, i.metric, i.value, i.period_start, i.period_end, i.source_name, i.source_ref, user.id])).rows[0];
    await logMr(c, a.lic.event_id, 'measurement', row.id, 'recorded', { actor: user.id, detail: { metric: row.metric, source: row.source_name } });
    return row;
  }),
});
