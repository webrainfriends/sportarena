import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { guardianLink, isYouth, requireConsent } from '../youth.js';
import { RELATIONSHIP_SQL } from '../coaching.js';
import { toCsv } from '../csv.js';
import { notify } from '../notify.js';
import { saveEncrypted } from '../doc-store.js';
import { starterFor } from '../documents/layout.js';
import { renderSeasonReport } from '../documents/season-report.js';
import { accessBlock, reasonText, shareState } from '../wellness-sharing.js';
import { CSV_COLUMNS, NEVER_INCLUDED, SECTIONS, buildPack, eligibleReports, fingerprint, packRows, seasonsFor } from '../export-pack.js';
import { loadLogo, mustAccess } from './branded-documents.js';

// Athlete season / career export packs (#332). A pack is a frozen, fingerprinted snapshot built from the canonical records (see export-pack.js).
// The athlete, or a young person's verified guardian, builds packs for themselves and can hand a coach a revocable share. A coach builds a pack
// only from a live share, and every later read or download of any pack re-checks the live share, coaching relationship and guardian consent.
const TAG = 'Season reports';
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const endOf = (d) => {
  if (d < today()) throw badRequest('The end date is in the past');
  if (d > plusDays(today(), 365)) throw badRequest('Sharing can run for at most one year; renew it later');
  return `${plusDays(d, 1)}T00:00:00Z`;
};
const key = z.string().trim().min(8).max(80).optional().describe('idempotency key: a retried request with the same key returns the original pack instead of making a second');
const sectionsIn = z.array(z.enum(SECTIONS)).min(1).max(SECTIONS.length).describe('matches, results, goals, awards, career, reports, evidence. Private notes, health and wellness data, contact details and date of birth are never included.');
const scopeIn = {
  scope: z.enum(['season', 'career']).describe('a calendar season (UTC year) or the whole career'),
  season: z.number().int().min(1950).max(2200).optional().describe('the year, for a season pack'),
  sport: z.string().trim().max(60).optional().describe('sport slug or id; leave out for all sports'),
};
const ordered = (s) => SECTIONS.filter((x) => s.includes(x));

/** Validate scope + sport and return the canonical scope. */
async function scopeOf(i) {
  if (i.scope === 'season' && !i.season) throw badRequest('Pick a season year');
  if (i.scope === 'career' && i.season) throw badRequest('A career pack covers every season; leave the season out');
  let sportId = null;
  if (i.sport) { const s = await sportBySlugOrId(i.sport); if (!s) throw notFound('Sport'); sportId = s.id; }
  return { kind: i.scope, year: i.scope === 'season' ? i.season : null, sportId };
}

/** Whose pack is this call about? The adult athlete themself, or a young person's verified guardian. Young people cannot arrange exports alone. */
async function subjectOf(user, athleteId) {
  if (!athleteId || athleteId === user.id) {
    if (await isYouth(user.id)) throw forbidden('A parent or guardian arranges exports for you');
    return { athleteId: user.id, kind: 'self' };
  }
  if (!(await guardianLink(user.id, athleteId))) throw forbidden('You are not a verified guardian of this young person');
  return { athleteId, kind: 'guardian' };
}

/** Why a coach cannot use this share right now, or null. */
export async function shareBlock(c, s) {
  if (s.revoked_at) return 'revoked';
  if (new Date(s.expires_at) <= new Date()) return 'expired';
  return accessBlock(c, s.athlete_id, s.recipient_id, 'coach');
}

const event = (c, athleteId, actor, action, { shareId = null, packId = null, ...detail } = {}) =>
  c.query('INSERT INTO export_pack_events(athlete_id, actor_id, share_id, pack_id, action, detail) VALUES ($1,$2,$3,$4,$5,$6)', [athleteId, actor, shareId, packId, action, detail]);

const SHARE_COLS = 's.id, s.athlete_id, s.recipient_id, s.scope_kind, s.season_year, s.sport_id, s.sections, s.expires_at, s.version, s.revoked_at, s.created_at, s.updated_at';
const PACK_COLS = 'p.id, p.athlete_id, p.created_by, p.share_id, p.scope_kind, p.season_year, p.sport_id, p.sections, p.report_ids, p.snapshot_sha256, p.created_at';

/** May `user` read this pack right now? Returns how ('self' | 'guardian' | 'staff'), else 404 (outsiders) or 403 with the reason (a coach whose share ended). */
async function packAccess(user, p, c = { query }) {
  if (p.athlete_id === user.id) { if (await isYouth(user.id, c)) throw notFound('Export pack'); return 'self'; }
  if (await guardianLink(user.id, p.athlete_id, c)) return 'guardian';
  if (p.share_id && p.created_by === user.id) {
    const s = (await c.query('SELECT * FROM export_pack_shares WHERE id=$1', [p.share_id])).rows[0];
    const block = s && (await shareBlock(c, s));
    if (!s || block) throw forbidden(block ? reasonText(block) : 'No access.');
    return 'staff';
  }
  throw notFound('Export pack');
}
const packOf = async (packId, c = { query }) => {
  const p = (await c.query(`SELECT ${PACK_COLS}, p.snapshot FROM export_packs p WHERE p.id=$1`, [packId])).rows[0];
  if (!p) throw notFound('Export pack');
  return p;
};
const documentsOf = (packId) => many(
  "SELECT id, template_version_id, size_bytes, sha256, pages, created_at FROM generated_documents WHERE source_type='export_pack' AND source_id=$1 ORDER BY created_at DESC, id LIMIT 50", [packId])
  .then((rows) => rows.map((r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` })));
const summarise = (snap) => Object.fromEntries(['matches', 'results', 'goals', 'awards', 'career', 'reports'].filter((k) => snap[k]).map((k) => [k, snap[k].rows.length]));

// ---------- options ----------

cap({
  name: 'get_export_pack_options', method: 'GET', path: '/me/export-pack-options', tag: TAG,
  summary: 'What you can put in a season or career pack: the seasons you have records in, your sports, the coaching reports published to you that you may include, your branded report templates, and the coaches you could share a pack with. A verified guardian passes athlete_id for a young person.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const s = await subjectOf(user, i.athlete_id);
    if (s.kind === 'guardian') await audit(null, user.id, 'read_child_export_options', 'users', s.athleteId);
    const viewer = { kind: s.kind, userId: user.id };
    const [seasons, sports, reports, templates, recipients, athlete] = await Promise.all([
      seasonsFor(s.athleteId),
      many('SELECT DISTINCT sp.slug, sp.name, sp.emoji FROM active_sport_profiles p JOIN sports sp ON sp.id=p.sport_id WHERE p.user_id=$1 ORDER BY sp.name', [s.athleteId]),
      eligibleReports(s.athleteId, viewer, { kind: 'career' }),
      many(`SELECT t.id, t.name, t.kit_id, (SELECT max(version) FROM document_template_versions v WHERE v.template_id=t.id) AS latest_version FROM document_templates t
             WHERE t.family='season_report' AND t.archived_at IS NULL AND t.owner_user_id=$1 AND EXISTS (SELECT 1 FROM document_template_versions v WHERE v.template_id=t.id) ORDER BY t.created_at DESC, t.id LIMIT 50`, [user.id]),
      s.kind === 'self' || s.kind === 'guardian'
        ? many(`SELECT DISTINCT u.id, u.display_name, u.handle FROM (${RELATIONSHIP_SQL}) r JOIN users u ON u.id=r.coach_id WHERE r.athlete_id=$1 AND u.id <> $1 ORDER BY u.display_name, u.id LIMIT 50`, [s.athleteId])
        : [],
      one('SELECT id, display_name, handle FROM users WHERE id=$1', [s.athleteId]),
    ]);
    const usable = [];
    for (const r of recipients) if (!(await accessBlock({ query }, s.athleteId, r.id, 'coach'))) usable.push(r);
    return { athlete, mode: s.kind, seasons, sports, reports, templates, recipients: usable, sections: SECTIONS, never_included: NEVER_INCLUDED };
  },
});

// ---------- build packs ----------

const packIn = { athlete_id: id.optional(), ...scopeIn, sections: sectionsIn, report_ids: z.array(id).max(50).default([]) };

cap({
  name: 'preview_export_pack', method: 'POST', path: '/export-packs/preview', tag: TAG, scope: 'read',
  summary: 'See exactly what a pack would contain, without saving anything. Same builder and the same permission rules as create_export_pack. A verified guardian passes athlete_id for a young person; the read is audited.',
  input: z.object(packIn),
  async handler({ user }, i) {
    const s = await subjectOf(user, i.athlete_id);
    const scope = await scopeOf(i);
    if (s.kind === 'guardian') await audit(null, user.id, 'read_child_export_preview', 'users', s.athleteId);
    return { snapshot: await buildPack({ athleteId: s.athleteId, viewer: { kind: s.kind, userId: user.id }, scope, sections: ordered(i.sections), reportIds: i.report_ids }) };
  },
});

cap({
  name: 'create_export_pack', method: 'POST', path: '/export-packs', tag: TAG, status: 201,
  summary: 'Freeze a season or career pack (matches, results, goals, awards, career timeline, coaching reports you were sent, evidence) with provenance and a fingerprint. An athlete or guardian chooses the scope; a coach passes share_id and gets exactly what the athlete shared. Repeating the same client_key returns the same pack. Download it as CSV or a branded PDF.',
  input: z.object({ athlete_id: id.optional(), share_id: id.optional(), scope: scopeIn.scope.optional(), season: scopeIn.season, sport: scopeIn.sport, sections: sectionsIn.optional(), report_ids: z.array(id).max(50).default([]), client_key: key }),
  async handler({ user }, i) {
    let existing = null;
    if (i.client_key) existing = (await one(`SELECT ${PACK_COLS}, p.snapshot FROM export_packs p WHERE p.created_by=$1 AND p.client_key=$2`, [user.id, i.client_key]));
    const respond = async (p) => ({ ...p, summary: summarise(p.snapshot), documents: await documentsOf(p.id), duplicate: true });
    if (i.share_id) {
      return tx(async (c) => {
        // FOR SHARE: a revoke that starts meanwhile waits for this read; once it commits the next read is refused
        const s = (await c.query('SELECT * FROM export_pack_shares WHERE id=$1 AND recipient_id=$2 FOR SHARE', [i.share_id, user.id])).rows[0];
        if (!s) throw notFound('Share');
        const block = await shareBlock(c, s);
        if (block) throw forbidden(reasonText(block));
        if (existing) { if (existing.share_id !== s.id) throw conflict('That key was used for a different pack', { code: 'key_reused' }); return respond(existing); }
        const scope = { kind: s.scope_kind, year: s.season_year, sportId: s.sport_id };
        const snapshot = await buildPack({ athleteId: s.athlete_id, viewer: { kind: 'staff', userId: user.id }, scope, sections: ordered(s.sections) });
        const row = await insertPack(c, { athleteId: s.athlete_id, createdBy: user.id, shareId: s.id, scope, sections: ordered(s.sections), reportIds: [], snapshot, key: i.client_key });
        if (row.duplicate) return respond(await packOf(row.id));
        await event(c, s.athlete_id, user.id, 'created', { shareId: s.id, packId: row.id });
        await audit(c, user.id, 'create_export_pack', 'export_packs', row.id);
        return { ...row.pack, snapshot, summary: summarise(snapshot), documents: [], duplicate: false };
      });
    }
    if (!i.scope || !i.sections) throw badRequest('Choose a scope and the sections to include');
    const s = await subjectOf(user, i.athlete_id);
    const scope = await scopeOf(i);
    const sections = ordered(i.sections);
    if (existing) {
      if (existing.athlete_id !== s.athleteId || existing.scope_kind !== scope.kind || existing.season_year !== scope.year || existing.sport_id !== scope.sportId || existing.sections.join() !== sections.join()) throw conflict('That key was used for a different pack', { code: 'key_reused' });
      return respond(existing);
    }
    if (sections.includes('reports')) {
      const ok = new Set((await eligibleReports(s.athleteId, { kind: s.kind, userId: user.id }, scope)).map((r) => r.report_id));
      const bad = i.report_ids.filter((r) => !ok.has(r));
      if (bad.length) throw badRequest('One of those reports is not available to include (it may not be published to you for this period)');
    }
    const snapshot = await buildPack({ athleteId: s.athleteId, viewer: { kind: s.kind, userId: user.id }, scope, sections, reportIds: i.report_ids });
    return tx(async (c) => {
      if (s.kind === 'guardian' && !(await guardianLink(user.id, s.athleteId, c))) throw forbidden('You are not a verified guardian of this young person');
      const row = await insertPack(c, { athleteId: s.athleteId, createdBy: user.id, shareId: null, scope, sections, reportIds: i.report_ids, snapshot, key: i.client_key });
      if (row.duplicate) return respond(await packOf(row.id));
      await event(c, s.athleteId, user.id, 'created', { packId: row.id, prepared_for: s.kind });
      await audit(c, user.id, s.kind === 'guardian' ? 'create_child_export_pack' : 'create_export_pack', 'export_packs', row.id);
      return { ...row.pack, snapshot, summary: summarise(snapshot), documents: [], duplicate: false };
    });
  },
});

async function insertPack(c, { athleteId, createdBy, shareId, scope, sections, reportIds, snapshot, key: clientKey }) {
  const sha = fingerprint(snapshot);
  const r = (await c.query(
    `INSERT INTO export_packs(athlete_id, created_by, share_id, scope_kind, season_year, sport_id, sections, report_ids, snapshot, snapshot_sha256, client_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (created_by, client_key) WHERE client_key IS NOT NULL DO NOTHING
     RETURNING id, athlete_id, created_by, share_id, scope_kind, season_year, sport_id, sections, report_ids, snapshot_sha256, created_at`,
    [athleteId, createdBy, shareId, scope.kind, scope.year, scope.sportId, sections, reportIds, JSON.stringify(snapshot), sha, clientKey ?? null])).rows[0];
  if (r) return { id: r.id, pack: r, duplicate: false };
  return { id: (await c.query('SELECT id FROM export_packs WHERE created_by=$1 AND client_key=$2', [createdBy, clientKey])).rows[0].id, duplicate: true };
}

// ---------- read / list / download ----------

cap({
  name: 'list_export_packs', method: 'GET', path: '/export-packs', tag: TAG,
  summary: 'Packs about you (or, for a guardian, a young person) and packs you built from a share, newest first. Each row says who prepared it, what it covers and whether you can still open it.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    let athlete = null;
    if (i.athlete_id) athlete = (await subjectOf(user, i.athlete_id)).athleteId;
    else if (!(await isYouth(user.id))) athlete = user.id;
    const rows = await many(
      `SELECT ${PACK_COLS}, au.display_name AS athlete_name, cu.display_name AS created_by_name, p.snapshot->'scope'->>'label' AS label, p.snapshot->>'prepared_for' AS prepared_for,
              (SELECT count(*)::int FROM generated_documents d WHERE d.source_type='export_pack' AND d.source_id=p.id) AS documents
         FROM export_packs p JOIN users au ON au.id=p.athlete_id JOIN users cu ON cu.id=p.created_by
        WHERE CASE WHEN $2::uuid IS NOT NULL THEN p.athlete_id=$1 ELSE (p.athlete_id=$1 OR p.created_by=$3) END
        ORDER BY p.created_at DESC, p.id LIMIT $4 OFFSET $5`, [athlete, i.athlete_id ?? null, user.id, i.limit, i.offset]);
    const out = [];
    for (const r of rows) {
      let live = true, reason = null;
      try { await packAccess(user, r); } catch (e) { live = false; reason = e.status === 403 ? e.message : 'No access.'; }
      out.push({ ...r, live, blocked_reason: reason });
    }
    return out;
  },
});

cap({
  name: 'get_export_pack', method: 'GET', path: '/export-packs/:id', tag: TAG,
  summary: 'One frozen pack with its provenance, what was left out and the PDFs made from it. Access is re-checked on every call; a coach\'s views are logged and visible to the athlete.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await packOf(i.id);
    const how = await packAccess(user, p);
    if (how !== 'self') { await event({ query }, p.athlete_id, user.id, 'viewed', { packId: p.id, as: how }); await audit(null, user.id, 'read_export_pack', 'export_packs', p.id); }
    return { ...p, access: how, summary: summarise(p.snapshot), documents: await documentsOf(p.id) };
  },
});

cap({
  name: 'export_pack_csv', method: 'GET', path: '/export-packs/:id/csv', tag: TAG,
  summary: 'The pack as one CSV (a row per match, result, goal, award, membership and report, each labelled with its section, provenance and verification, plus a row for anything withheld). Same live access checks as viewing; the download is logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await packOf(i.id);
    const how = await packAccess(user, p);
    const rows = packRows(p.snapshot);
    await event({ query }, p.athlete_id, user.id, 'csv', { packId: p.id, as: how });
    await audit(null, user.id, 'export_pack_csv', 'export_packs', p.id);
    return { filename: `season-report-${p.snapshot.athlete.handle}-${p.snapshot.scope.year ?? 'career'}.csv`, content_type: 'text/csv', rows: rows.length, sha256: p.snapshot_sha256, csv: toCsv(CSV_COLUMNS, rows) };
  },
});

cap({
  name: 'generate_export_pack_pdf', method: 'POST', path: '/export-packs/:id/pdf', tag: TAG, status: 201,
  summary: 'Render the pack as a PDF, optionally with one of your published season_report templates (your brand kit, logo, header and footer). The words and figures are the frozen pack; a template only chooses presentation. The same pack and template return the PDF you already have. Download with GET /branded-documents/{id}/file.',
  input: z.object({ id, template_id: id.optional() }),
  async handler({ user }, i) {
    const p = await packOf(i.id);
    const how = await packAccess(user, p);
    let ver = null;
    if (i.template_id) {
      const t = await one('SELECT * FROM document_templates WHERE id=$1', [i.template_id]);
      await mustAccess(user, t, 'Template');
      if (t.family !== 'season_report') throw badRequest('That template is for a different document');
      if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
      ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
      if (!ver) throw conflict('Publish the template before generating documents from it');
    }
    const COLS = 'id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, created_at';
    const again = await one(`SELECT ${COLS} FROM generated_documents WHERE source_type='export_pack' AND source_id=$1 AND generated_by=$2 AND template_version_id IS NOT DISTINCT FROM $3 ORDER BY created_at DESC, id LIMIT 1`, [p.id, user.id, ver?.id ?? null]);
    if (again) return { ...again, url: `/api/v1/branded-documents/${again.id}/file`, duplicate: true };
    const layout = ver ? ver.layout : starterFor('season_report', 'classic');
    const { buffer, pages } = await renderSeasonReport({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), pack: p.snapshot, createdAt: new Date(p.created_at), packId: p.id, sha256: p.snapshot_sha256 });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'season_report','export_pack',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [did, p.id, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await event({ query }, p.athlete_id, user.id, 'pdf', { packId: p.id, as: how, document_id: did });
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return { ...row, url: `/api/v1/branded-documents/${did}/file`, duplicate: false };
  },
});

/** Called by the document download route: may `user` open a PDF made from this pack, right now? */
export async function canReadPackDocument(user, packId) {
  const p = await packOf(packId);
  await packAccess(user, p);
  await event({ query }, p.athlete_id, user.id, 'pdf', { packId: p.id, downloaded: true });
}

// ---------- share a pack with a coach ----------

cap({
  name: 'create_export_pack_share', method: 'POST', path: '/me/export-pack-shares', tag: TAG, status: 201,
  summary: 'Let a coach who currently coaches you build a season or career pack of the sections you choose, until a date. They get only what you tick (goals only if you also shared those goals with them); they never get private notes or health data. Repeating the same request returns the share you already have; a different one for the same coach must be edited. A young person\'s share is arranged by their verified guardian (athlete_id) and needs current coaching consent.',
  input: z.object({ athlete_id: id.optional(), recipient_id: id, ...scopeIn, sections: sectionsIn, expires_on: day.describe('last day of access (UTC); at most one year ahead') }),
  async handler({ user }, i) {
    const s = await subjectOf(user, i.athlete_id);
    if (i.recipient_id === s.athleteId) throw badRequest('You cannot share with yourself');
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [i.recipient_id]))) throw notFound('Recipient');
    const scope = await scopeOf(i);
    const sections = ordered(i.sections);
    const expires = endOf(i.expires_on);
    return tx(async (c) => {
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [s.athleteId]); // serialises concurrent shares and edits for this athlete
      const blocked = await accessBlock(c, s.athleteId, i.recipient_id, 'coach');
      if (blocked === 'guardian_consent') await requireConsent(s.athleteId, 'coaching', 'sharing a report pack', c);
      if (blocked) throw forbidden('You can share with a coach who currently coaches you');
      for (const e of (await c.query('UPDATE export_pack_shares SET revoked_at=now(), revoked_by=NULL WHERE athlete_id=$1 AND recipient_id=$2 AND revoked_at IS NULL AND expires_at <= now() RETURNING id', [s.athleteId, i.recipient_id])).rows) await event(c, s.athleteId, null, 'expired', { shareId: e.id });
      const live = (await c.query(`SELECT ${SHARE_COLS} FROM export_pack_shares s WHERE s.athlete_id=$1 AND s.recipient_id=$2 AND s.revoked_at IS NULL FOR UPDATE`, [s.athleteId, i.recipient_id])).rows[0];
      if (live) {
        const same = live.scope_kind === scope.kind && live.season_year === scope.year && live.sport_id === scope.sportId && live.sections.join() === sections.join() && new Date(live.expires_at).getTime() === Date.parse(expires);
        if (same) return live;
        throw conflict('You already share a pack with this coach. Edit that share instead.', { code: 'share_exists', share_id: live.id, version: live.version });
      }
      const r = (await c.query(
        `INSERT INTO export_pack_shares(athlete_id, recipient_id, scope_kind, season_year, sport_id, sections, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${SHARE_COLS.replaceAll('s.', '')}`, [s.athleteId, i.recipient_id, scope.kind, scope.year, scope.sportId, sections, expires, user.id])).rows[0];
      await event(c, s.athleteId, user.id, 'granted', { shareId: r.id, sections, scope: scope.kind, season: scope.year, expires_at: expires });
      await audit(c, user.id, 'grant_export_pack_share', 'export_pack_shares', r.id);
      await notify(c, i.recipient_id, { kind: 'export_pack_shared', title: 'An athlete shared a season report with you', body: 'Open Shared reports to build the pack they chose.', data: { screen: 'SeasonReports', share_id: r.id }, dedupe_key: `export_pack_shared:${r.id}` });
      return r;
    });
  },
});

cap({
  name: 'update_export_pack_share', method: 'PATCH', path: '/me/export-pack-shares/:id', tag: TAG,
  summary: 'Change what a live pack share covers (sections, season or sport, end date). Send the `version` you last saw: if it changed elsewhere you get a 409 and must reload. Narrowing takes effect at once; packs the coach already built stay in your history.',
  input: z.object({ id, version: z.number().int().min(1), sections: sectionsIn.optional(), scope: scopeIn.scope.optional(), season: scopeIn.season, sport: scopeIn.sport.nullable().optional(), expires_on: day.optional() }),
  async handler({ user }, i) {
    if (i.sections === undefined && i.scope === undefined && i.sport === undefined && i.expires_on === undefined && i.season === undefined) throw badRequest('Nothing to change');
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM export_pack_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      if (s.athlete_id !== user.id && !(await guardianLink(user.id, s.athlete_id, c))) throw notFound('Share');
      if (s.revoked_at || new Date(s.expires_at) <= new Date()) throw conflict('This share has ended. Create a new one.', { code: 'share_ended' });
      if (s.version !== i.version) throw conflict('This share changed since you opened it. Reload and try again.', { code: 'stale_version', version: s.version });
      const kind = i.scope ?? s.scope_kind;
      const year = kind === 'career' ? null : (i.season ?? (i.scope === 'season' ? null : s.season_year));
      if (kind === 'season' && !year) throw badRequest('Pick a season year');
      let sportId = s.sport_id;
      if (i.sport !== undefined) { sportId = null; if (i.sport) { const sp = await sportBySlugOrId(i.sport); if (!sp) throw notFound('Sport'); sportId = sp.id; } }
      const sections = i.sections ? ordered(i.sections) : s.sections;
      const expires = i.expires_on ? endOf(i.expires_on) : s.expires_at;
      const u = (await c.query(
        `UPDATE export_pack_shares SET scope_kind=$2, season_year=$3, sport_id=$4, sections=$5, expires_at=$6, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${SHARE_COLS.replaceAll('s.', '')}`,
        [s.id, kind, year, sportId, sections, expires])).rows[0];
      await event(c, s.athlete_id, user.id, 'updated', { shareId: s.id, sections, scope: kind, season: year });
      await audit(c, user.id, 'update_export_pack_share', 'export_pack_shares', s.id);
      return u;
    });
  },
});

cap({
  name: 'revoke_export_pack_share', method: 'POST', path: '/me/export-pack-shares/:id/revoke', tag: TAG,
  summary: 'Stop sharing. The coach loses access on their next read or download, including of packs they already built; the share and what it covered stay in your history. Repeating it is harmless. A verified guardian can do this for a young athlete.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM export_pack_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      if (s.athlete_id !== user.id && !(await guardianLink(user.id, s.athlete_id, c))) throw notFound('Share');
      if (s.revoked_at) return { id: s.id, state: 'revoked', revoked_at: s.revoked_at };
      const r = (await c.query('UPDATE export_pack_shares SET revoked_at=now(), revoked_by=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING revoked_at', [s.id, user.id])).rows[0];
      await event(c, s.athlete_id, user.id, 'revoked', { shareId: s.id });
      await audit(c, user.id, 'revoke_export_pack_share', 'export_pack_shares', s.id);
      await notify(c, s.recipient_id, { kind: 'export_pack_share_revoked', title: 'A shared season report was stopped', body: 'An athlete stopped sharing a season report with you.', data: { screen: 'SeasonReports' }, dedupe_key: `export_pack_share_revoked:${s.id}` });
      return { id: s.id, state: 'revoked', revoked_at: r.revoked_at };
    });
  },
});

cap({
  name: 'list_export_pack_shares', method: 'GET', path: '/me/export-pack-shares', tag: TAG,
  summary: 'Your pack shares (or a young athlete\'s, for their guardian): each with its state, whether the coach can use it right now and why not, and a recent activity log of grants, views, CSV and PDF downloads.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = (await subjectOf(user, i.athlete_id)).athleteId;
    const rows = await many(
      `SELECT ${SHARE_COLS}, u.display_name AS recipient_name, u.handle AS recipient_handle, sp.name AS sport,
              (SELECT count(*)::int FROM export_pack_events e WHERE e.share_id=s.id AND e.action='created') AS packs
         FROM export_pack_shares s JOIN users u ON u.id=s.recipient_id LEFT JOIN sports sp ON sp.id=s.sport_id WHERE s.athlete_id=$1
        ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [athlete, i.limit, i.offset]);
    const shares = [];
    for (const s of rows) {
      const state = shareState(s);
      const block = state === 'active' ? await shareBlock({ query }, s) : null;
      shares.push({ ...s, state, live: state === 'active' && !block, blocked_reason: block ? reasonText(block) : null });
    }
    const activity = await many(
      `SELECT e.id, e.share_id, e.pack_id, e.action, e.created_at, u.display_name AS actor_name FROM export_pack_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC, e.id LIMIT 30`, [athlete]);
    return { shares, activity };
  },
});

cap({
  name: 'list_export_pack_shared_with_me', method: 'GET', path: '/export-pack-shared', tag: TAG, auth: ['coach'],
  summary: 'Coach: athletes who shared a season or career pack with you, what they chose, and whether you can build it right now. A share that ended, or whose coaching relationship or consent lapsed, shows why and no data.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${SHARE_COLS}, u.display_name AS athlete_name, u.handle AS athlete_handle, sp.name AS sport
         FROM export_pack_shares s JOIN users u ON u.id=s.athlete_id LEFT JOIN sports sp ON sp.id=s.sport_id
        WHERE s.recipient_id=$1 AND (s.revoked_at IS NULL OR s.revoked_at > now() - interval '30 days')
        ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, u.display_name, s.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    const out = [];
    for (const s of rows) {
      const state = shareState(s);
      const block = state === 'active' ? await shareBlock({ query }, s) : state;
      out.push({ ...s, state, live: !block, blocked_reason: block ? reasonText(block) : null });
    }
    return out;
  },
});
