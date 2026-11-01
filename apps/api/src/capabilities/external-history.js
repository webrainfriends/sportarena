// External verified league and federation history (#323). One definition -> REST + OpenAPI + MCP. The career timeline (#311) stays the only place a player's
// history lives: a source's records are staged here, matched to a player through a CONFIRMED identity, reviewed by that source's own staff, and only then become
// verified timeline entries labelled with where they came from. The player (or guardian) can dispute any of it; entries are archived, never deleted.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { isPlatform } from '../platform.js';
import { authority, can } from '../federation.js';
import { hasConsent, isYouth } from '../youth.js';
import { LEVELS, snapshot } from '../career.js';
import { checkEndpoint } from '../access-providers.js';
import { subject } from './career-timeline.js';
import { MAX_FILE_BYTES, norm, parseUpload, possibleDuplicates, pullFeed, readPayload, refIdx, resolveWaiting, sourceAuthority, stageRecords } from '../external-history.js';

const TAG = 'External history';
const SECRET_CTX = 'external_feed_sources.secret';
const stale = (cur) => conflict('This was changed elsewhere. Reload and try again.', { code: 'stale_version', row_version: cur.row_version });
const VIA = { feed: 'external_feed', file: 'external_file' };

// ------------------------------------------------------------------ sources
const SRC_COLS = `s.id, s.name, s.kind, s.adapter, s.sport_id, sp.slug AS sport_slug, sp.name AS sport, s.body_id, s.endpoint_url, (s.secret_enc IS NOT NULL) AS has_token, s.status, s.decided_at, s.decision_note,
  s.last_sync_at, s.last_sync_status, s.last_sync_error, s.row_version, s.created_at,
  (SELECT count(*)::int FROM external_history_records r WHERE r.source_id=s.id AND r.status IN ('new','changed','disputed','withdrawn')) AS needs_attention,
  (SELECT count(*)::int FROM external_history_records r WHERE r.source_id=s.id AND r.status='accepted') AS accepted,
  (SELECT count(*)::int FROM external_identities x WHERE x.source_id=s.id AND x.status='claimed') AS claims_waiting`;
const SRC_FROM = 'FROM external_feed_sources s LEFT JOIN sports sp ON sp.id=s.sport_id';
/** What the app may say about the connection. A feed is only "live" after a successful pull; the file path is never called live. */
const connection = (s) => (s.status !== 'approved' ? 'not_approved' : s.adapter === 'file_import' ? 'file_only' : s.last_sync_status === 'ok' ? 'live' : s.last_sync_status ? s.last_sync_status : 'never_synced');
const srcView = ({ ...s }) => ({ ...s, connection: connection(s) });
const srcOne = async (sid, c = pool) => { const r = await c.query(`SELECT ${SRC_COLS} ${SRC_FROM} WHERE s.id=$1 AND s.archived_at IS NULL`, [sid]); return r.rows[0] ? srcView(r.rows[0]) : null; };
const lockSource = async (c, sid) => (await c.query('SELECT * FROM external_feed_sources WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [sid])).rows[0];
/** The source if the caller runs it; a 404 otherwise, so an outsider cannot tell a source exists. */
async function managed(user, sid, c = pool, { lock = false } = {}) {
  const s = lock ? await lockSource(c, sid) : (await c.query('SELECT * FROM external_feed_sources WHERE id=$1 AND archived_at IS NULL', [sid])).rows[0];
  if (!s || !(await sourceAuthority(user, s, c))) throw notFound('Source');
  return s;
}
const mustBeApproved = (s) => { if (s.status !== 'approved') throw conflict(s.status === 'suspended' ? 'This source is suspended' : 'This source is waiting for the platform team to approve it', { code: 'source_not_approved' }); };

cap({
  name: 'create_history_source', method: 'POST', path: '/history-sources', tag: TAG, status: 201,
  summary: 'Register a league or federation as a source of verified history. Governing-body staff (registrar or admin) register sources for their body; the platform team registers any. A "live feed" source needs real HTTPS API access from that league (a bearer token is stored encrypted and never shown again); without it, use the file-import source, which is labelled honestly as an uploaded export, not a live feed. A new source must be approved by the platform team before anything it sends is used.',
  input: z.object({
    name: z.string().trim().min(2).max(120), kind: z.enum(['federation', 'league']), adapter: z.enum(['api_json', 'file_import']),
    sport: z.string().optional().describe('sport slug or id; leave out for a multi-sport source (each record then names its sport)'), body_id: id.optional(),
    endpoint_url: z.string().trim().url().max(500).optional(), token: z.string().min(8).max(500).optional(),
  }),
  async handler({ user }, i) {
    if (i.adapter === 'api_json') {
      if (!i.endpoint_url) throw badRequest('A live feed needs its HTTPS address');
      const bad = checkEndpoint(i.endpoint_url);
      if (bad) throw badRequest(bad);
    } else if (i.endpoint_url || i.token) throw badRequest('A file-import source has no feed address or token');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    if (i.body_id) {
      const auth = await authority(user, i.body_id, { optional: true });
      if (!auth || !can(auth, 'affiliations', sport?.id ?? null)) throw notFound('Governing body');
    } else if (!isPlatform(user)) throw forbidden('Register the source under the governing body you run');
    return tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO external_feed_sources(name, kind, adapter, sport_id, body_id, endpoint_url, secret_enc, status, decided_by, decided_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [i.name, i.kind, i.adapter, sport?.id ?? null, i.body_id ?? null, i.endpoint_url ?? null, i.token ? encrypt(i.token, SECRET_CTX) : null,
            isPlatform(user) ? 'approved' : 'pending', isPlatform(user) ? user.id : null, isPlatform(user) ? new Date() : null, user.id])).rows[0];
      } catch (e) { throw e.code === '23505' ? conflict('A source with that name already exists', { code: 'duplicate_source' }) : e; }
      await audit(c, user.id, 'create_history_source', 'external_feed_sources', row.id);
      return srcOne(row.id, c);
    });
  },
});

cap({
  name: 'list_history_sources', method: 'GET', path: '/history-sources', tag: TAG,
  summary: 'The sources you run: platform team sees all; governing-body staff see their body\'s. Each shows approval, how it connects (live / never synced / failed / file only), and how many records wait for review.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${SRC_COLS} ${SRC_FROM} WHERE s.archived_at IS NULL AND ($1::boolean OR s.body_id IS NOT NULL) ORDER BY s.name, s.id`, [isPlatform(user)]);
    const out = [];
    for (const s of rows) if (await sourceAuthority(user, s)) out.push(srcView(s));
    return out.slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'list_approved_history_sources', method: 'GET', path: '/history-sources/approved', tag: TAG,
  summary: 'Approved leagues and federations a player can link their ID with (name, kind, sport, and whether it is a live feed or an uploaded export). No endpoints or staff details.',
  input: z.object({ sport: z.string().optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(`SELECT s.id, s.name, s.kind, s.adapter, sp.slug AS sport_slug, sp.name AS sport, s.last_sync_status ${SRC_FROM}
                              WHERE s.status='approved' AND s.archived_at IS NULL AND ($1::uuid IS NULL OR s.sport_id IS NULL OR s.sport_id=$1) ORDER BY s.name, s.id LIMIT $2 OFFSET $3`, [sport?.id ?? null, i.limit, i.offset]);
    return rows.map((s) => ({ ...s, connection: connection({ ...s, status: 'approved' }) }));
  },
});

cap({
  name: 'update_history_source', method: 'PATCH', path: '/history-sources/:id', tag: TAG,
  summary: 'Rename a source or change its feed address / token. Send the row_version you loaded. Changing the address or token of an approved source sends it back to the platform team for approval (the platform team\'s own edits stay approved). The old token is never shown.',
  input: z.object({ id, row_version: z.number().int().min(1), name: z.string().trim().min(2).max(120).optional(), endpoint_url: z.string().trim().url().max(500).optional(), token: z.string().min(8).max(500).optional(), clear_token: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await managed(user, i.id, c, { lock: true });
      if (s.row_version !== i.row_version) throw stale(s);
      if ((i.endpoint_url || i.token || i.clear_token) && s.adapter !== 'api_json') throw badRequest('A file-import source has no feed address or token');
      if (i.endpoint_url) { const bad = checkEndpoint(i.endpoint_url); if (bad) throw badRequest(bad); }
      const secret = i.clear_token ? null : i.token ? encrypt(i.token, SECRET_CTX) : s.secret_enc;
      const feedChanged = (i.endpoint_url && i.endpoint_url !== s.endpoint_url) || !!i.token || !!i.clear_token;
      const reapprove = feedChanged && s.status === 'approved' && !isPlatform(user);
      try {
        await c.query(
          `UPDATE external_feed_sources SET name=$2, endpoint_url=$3, secret_enc=$4, status=CASE WHEN $5 THEN 'pending' ELSE status END, cursor=CASE WHEN $6 THEN NULL ELSE cursor END,
                  row_version=row_version+1, updated_at=now() WHERE id=$1`, [i.id, i.name ?? s.name, i.endpoint_url ?? s.endpoint_url, secret, reapprove, feedChanged && !!i.endpoint_url && i.endpoint_url !== s.endpoint_url]);
      } catch (e) { throw e.code === '23505' ? conflict('A source with that name already exists', { code: 'duplicate_source' }) : e; }
      await audit(c, user.id, 'update_history_source', 'external_feed_sources', i.id);
      return srcOne(i.id, c);
    });
  },
});

cap({
  name: 'decide_history_source', method: 'POST', path: '/history-sources/:id/decision', tag: TAG,
  summary: 'Platform team only: approve a source (its records can then be pulled/imported and reviewed) or suspend it (no new pulls, imports or acceptances; entries already confirmed stay, labelled with the source). A suspension needs a reason.',
  input: z.object({ id, decision: z.enum(['approve', 'suspend']), note: z.string().trim().max(500).optional(), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    if (!isPlatform(user)) throw forbidden('Only the platform team approves sources');
    if (i.decision === 'suspend' && !i.note) throw badRequest('Say why the source is suspended');
    return tx(async (c) => {
      const s = await lockSource(c, i.id);
      if (!s) throw notFound('Source');
      if (s.row_version !== i.row_version) throw stale(s);
      await c.query('UPDATE external_feed_sources SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, i.decision === 'approve' ? 'approved' : 'suspended', user.id, i.note ?? null]);
      await audit(c, user.id, `history_source_${i.decision}`, 'external_feed_sources', i.id);
      return srcOne(i.id, c);
    });
  },
});

// ------------------------------------------------------------------ intake
const batchView = (b) => ({ id: b.id, mode: b.mode, status: b.status, received: b.received, created: b.created, updated: b.updated, unchanged: b.unchanged, failed: b.failed, errors: b.errors, created_at: b.created_at });
const batchStatus = (o, extra) => (extra === 'failed' ? 'failed' : o.failed && (o.created || o.updated || o.unchanged) ? 'partial' : o.failed ? 'failed' : 'ok');

cap({
  name: 'sync_history_source', method: 'POST', path: '/history-sources/:id/sync', tag: TAG,
  summary: 'Pull new records from an approved live-feed source now. Records are staged for review, never published. A failing or slow feed leaves existing data untouched and reports why (unavailable / refused credentials); a second sync at the same time is refused. Re-delivered records are deduplicated by their external_ref.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await managed(user, i.id, c, { lock: true });
      mustBeApproved(s);
      if (s.adapter !== 'api_json') throw badRequest('This source has no live feed. Import its file instead.');
      if (!(await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`history-sync:${s.id}`])).rows[0].ok) throw conflict('A sync is already running for this source', { code: 'sync_in_progress' });
      const pulled = await pullFeed(s);
      const rows = pulled.rows ?? [];
      const batch = (await c.query("INSERT INTO external_history_batches(source_id, mode, started_by) VALUES ($1,'feed',$2) RETURNING id", [s.id, user.id])).rows[0];
      const out = rows.length ? await stageRecords(c, s, batch.id, 'feed', rows) : { received: 0, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };
      const failedPull = pulled.outcome !== 'ok';
      const status = failedPull ? (rows.length ? 'partial' : 'failed') : batchStatus(out);
      if (failedPull) out.errors.unshift({ row: null, external_ref: null, error: pulled.message });
      const b = (await c.query('UPDATE external_history_batches SET received=$2, created=$3, updated=$4, unchanged=$5, failed=$6, errors=$7, status=$8 WHERE id=$1 RETURNING *', [batch.id, out.received, out.created, out.updated, out.unchanged, out.failed, JSON.stringify(out.errors), status])).rows[0];
      await c.query('UPDATE external_feed_sources SET last_sync_at=now(), last_sync_status=$2, last_sync_error=$3, cursor=coalesce($4, cursor), row_version=row_version+1, updated_at=now() WHERE id=$1',
        [s.id, status, failedPull ? String(pulled.message).slice(0, 300) : null, failedPull && !rows.length ? null : pulled.cursor ?? null]);
      await audit(c, user.id, 'sync_history_source', 'external_feed_sources', s.id);
      return { ...batchView(b), outcome: pulled.outcome, message: pulled.message ?? null, more: !!pulled.more };
    });
  },
});

cap({
  name: 'import_history_file', method: 'POST', path: '/history-sources/:id/import', tag: TAG, status: 201,
  summary: 'Import an export file (CSV or JSON, up to 2 MB) for a source, as its staff. This is the honest fallback when a league has no API: records are staged for review exactly like a feed and later labelled "imported file", never "live feed". Each bad row is reported and skipped; good rows are kept. Re-sending the same file is a harmless replay. CSV columns: external_ref, person_ref, person_name, licence_no, club, sport, season, starts_on, ends_on, position, level, jersey_no, withdrawn.',
  input: z.object({ id, format: z.enum(['csv', 'json']), content: z.string().min(2).max(MAX_FILE_BYTES + 1024).optional(), data: z.string().min(4).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024).optional().describe('the file as base64 (what a phone or browser file picker returns); send content or data') }),
  async handler({ user }, i) {
    if (!!i.content === !!i.data) throw badRequest('Send the file as content or as data, not both');
    const text = i.content ?? Buffer.from(i.data.replace(/^data:[^,]*,/, ''), 'base64').toString('utf8').replace(/^\uFEFF/, '');
    const parsed = parseUpload(i.format, text);
    if (parsed.error) throw badRequest(parsed.error);
    const checksum = createHash('sha256').update(`${i.format}\n${text}`).digest('hex');
    return tx(async (c) => {
      const s = await managed(user, i.id, c, { lock: true });
      mustBeApproved(s);
      const prior = (await c.query('SELECT * FROM external_history_batches WHERE source_id=$1 AND checksum=$2', [s.id, checksum])).rows[0];
      if (prior) return { ...batchView(prior), replayed: true };
      const batch = (await c.query("INSERT INTO external_history_batches(source_id, mode, checksum, started_by) VALUES ($1,'file',$2,$3) RETURNING id", [s.id, checksum, user.id])).rows[0];
      const out = await stageRecords(c, s, batch.id, 'file', parsed.rows);
      const b = (await c.query('UPDATE external_history_batches SET received=$2, created=$3, updated=$4, unchanged=$5, failed=$6, errors=$7, status=$8 WHERE id=$1 RETURNING *', [batch.id, out.received, out.created, out.updated, out.unchanged, out.failed, JSON.stringify(out.errors), batchStatus(out)])).rows[0];
      await audit(c, user.id, 'import_history_file', 'external_feed_sources', s.id);
      return batchView(b);
    });
  },
});

cap({
  name: 'list_history_batches', method: 'GET', path: '/history-sources/:id/batches', tag: TAG,
  summary: 'Recent pulls and imports for a source you run: how many records arrived, were new, changed, unchanged or rejected as invalid (with the reasons).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await managed(user, i.id);
    return (await many('SELECT * FROM external_history_batches WHERE source_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset])).map(batchView);
  },
});

// ------------------------------------------------------------------ review
const STATUS_FILTER = { attention: ['new', 'changed', 'disputed', 'withdrawn'], new: ['new'], changed: ['changed'], disputed: ['disputed'], withdrawn: ['withdrawn'], accepted: ['accepted'], rejected: ['rejected'] };
const REC_COLS = `r.id, r.source_id, r.external_ref, r.status, r.via, r.version, r.row_version, r.club_name, r.season_label, r.starts_on::text AS starts_on, r.ends_on::text AS ends_on, r.starts_on::text AS starts_s, r.ends_on::text AS ends_s,
  r.position, r.competition_level, r.jersey_no, r.withdrawn, r.sport_id, sp.slug AS sport_slug, sp.name AS sport, r.user_id, r.match_method, r.membership_id, r.decided_at, r.decision_note, r.created_at, r.updated_at,
  r.person_ref_enc, r.person_name_enc, r.licence_enc, u.display_name AS user_name`;
const REC_FROM = 'FROM external_history_records r JOIN sports sp ON sp.id=r.sport_id LEFT JOIN users u ON u.id=r.user_id';

async function recordView(c, s, r) {
  const { person_ref_enc, person_name_enc, licence_enc, starts_s, ends_s, user_name, ...rest } = r;
  const person = {
    ref: person_ref_enc ? decrypt(person_ref_enc, 'external_history_records.person_ref') : null,
    name: person_name_enc ? decrypt(person_name_enc, 'external_history_records.person_name') : null,
    licence_no: licence_enc ? decrypt(licence_enc, 'external_history_records.licence') : null,
  };
  const out = { ...rest, person, user: r.user_id ? { id: r.user_id, display_name: user_name } : null };
  if (!r.user_id && person.name) {
    out.candidates = (await c.query(
      "SELECT id, display_name, handle FROM users u WHERE lower(display_name)=lower($1) AND (u.youth_until IS NULL OR u.youth_until <= current_date) ORDER BY id LIMIT 5", [person.name])).rows;
  }
  if (r.user_id && ['new', 'disputed', 'changed'].includes(r.status)) out.possible_duplicates = await possibleDuplicates(c, r, s);
  if (r.status === 'changed' || r.status === 'withdrawn') {
    const prev = (await c.query('SELECT payload_enc FROM external_history_record_versions WHERE record_id=$1 AND version=$2', [r.id, r.version - 1])).rows[0];
    if (prev) { const p = readPayload(prev); out.previous = { club: p.club, season: p.season ?? null, starts_on: p.starts_on, ends_on: p.ends_on ?? null, position: p.position ?? null, level: p.level ?? null, jersey_no: p.jersey_no ?? null }; }
  }
  return out;
}

cap({
  name: 'list_history_records', method: 'GET', path: '/history-sources/:id/records', tag: TAG,
  summary: 'The review queue for a source you run: staged records waiting to be matched and confirmed (status=attention, the default), or accepted / rejected ones. Each shows who it is about (decrypted: reading is audit-logged), the player it resolved to and how (confirmed identity or licence number), suggested players by name, and possible duplicates already on that player\'s timeline. Young people appear only while a guardian currently consents to participation.',
  input: z.object({ id, status: z.enum(Object.keys(STATUS_FILTER)).default('attention'), ...page }),
  async handler({ user }, i) {
    const s = await managed(user, i.id);
    const rows = await many(
      `SELECT ${REC_COLS} ${REC_FROM}
        WHERE r.source_id=$1 AND r.status = ANY($2)
          AND (r.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users y WHERE y.id=r.user_id AND y.youth_until IS NOT NULL AND y.youth_until > current_date)
               OR EXISTS (SELECT 1 FROM youth_consents yc WHERE yc.child_id=r.user_id AND yc.purpose='participation' AND yc.revoked_at IS NULL AND yc.expires_at > now()
                    AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=yc.granted_by AND gl.child_id=yc.child_id AND gl.status='active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now()))))
        ORDER BY r.created_at, r.id LIMIT $3 OFFSET $4`, [i.id, STATUS_FILTER[i.status], i.limit, i.offset]);
    const out = [];
    for (const r of rows) out.push(await recordView(pool, s, r));
    await audit(null, user.id, 'read_external_history', 'external_feed_sources', i.id);
    return out;
  },
});

const reviewIn = z.object({
  id, row_version: z.number().int().min(1), decision: z.enum(['accept', 'reject', 'apply_update', 'keep_current']),
  user_id: id.optional().describe('the player, when the record is not yet matched to one'),
  team_id: id.optional(), organisation_id: id.optional(),
  competition_level: z.enum(LEVELS).optional().describe('required when the source did not send a level'),
  reconcile: z.object({ mode: z.enum(['create', 'merge']), membership_id: id.optional() }).optional().describe('required when the player already has a similar entry: merge into it, or create a separate one'),
  note: z.string().trim().max(500).optional(),
});

async function clubFor(c, s, rec, i, userId) {
  let teamId = i.team_id ?? null, orgId = i.organisation_id ?? null;
  if (teamId && orgId) throw badRequest('Pick a team or an organisation, not both');
  if (!teamId && !orgId) {
    const a = (await c.query('SELECT team_id, organisation_id FROM external_club_aliases WHERE source_id=$1 AND alias=$2', [s.id, norm(rec.club_name)])).rows[0];
    teamId = a?.team_id ?? null; orgId = a?.organisation_id ?? null;
  } else {
    if (teamId) { const t = (await c.query('SELECT sport_id FROM teams WHERE id=$1', [teamId])).rows[0]; if (!t) throw notFound('Team'); if (t.sport_id !== rec.sport_id) throw badRequest('That team plays a different sport'); }
    if (orgId && !(await c.query('SELECT 1 FROM organisations WHERE id=$1', [orgId])).rowCount) throw notFound('Organisation');
    await c.query(
      `INSERT INTO external_club_aliases(source_id, alias, team_id, organisation_id, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_id, alias) DO UPDATE SET team_id=EXCLUDED.team_id, organisation_id=EXCLUDED.organisation_id, created_by=EXCLUDED.created_by`, [s.id, norm(rec.club_name), teamId, orgId, userId]);
  }
  return { teamId, orgId };
}

const evidenceFor = (c, membershipId, s, rec, userId) => c.query(
  'INSERT INTO career_membership_evidence(membership_id, kind, label, reference_enc, added_by) VALUES ($1,$2,$3,$4,$5)',
  [membershipId, 'competition_record', `${s.name} (${rec.via === 'feed' ? 'live feed' : 'imported file'})`, encrypt(`${s.name} record ${rec.external_ref} v${rec.version}`, 'career_membership_evidence.reference'), userId]);

cap({
  name: 'review_history_record', method: 'POST', path: '/history-records/:id/review', tag: TAG,
  summary: 'Decide a staged record as the source\'s staff. accept = confirm the player and put a verified, source-labelled entry on their timeline (the player is told and can dispute it); when the player already has a similar entry you must say whether to merge into it or create a separate one. reject = keep the record but never use it (a reason is required). apply_update / keep_current = what to do when the source later changed a record you accepted; apply_update on a withdrawn record un-verifies the entry (kept, not deleted). You cannot review a record about yourself.',
  input: reviewIn,
  async handler({ user }, i) {
    return tx(async (c) => {
      const probe = (await c.query('SELECT source_id FROM external_history_records WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('Record');
      const s = await managed(user, probe.source_id, c, { lock: true });
      const rec = (await c.query(`SELECT ${REC_COLS} ${REC_FROM} WHERE r.id=$1 FOR UPDATE OF r`, [i.id])).rows[0];
      if (rec.row_version !== i.row_version) throw stale(rec);
      const notPending = () => conflict(`This record is ${rec.status} and cannot take that decision`, { code: 'wrong_state', status: rec.status });

      if (i.decision === 'reject') {
        if (!['new', 'disputed'].includes(rec.status)) throw notPending();
        if (!i.note) throw badRequest('Say why it is rejected');
        await c.query("UPDATE external_history_records SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3, row_version=row_version+1, updated_at=now() WHERE id=$1", [rec.id, user.id, i.note]);
        await audit(c, user.id, 'history_record_reject', 'external_history_records', rec.id);
        return one_(c, s, rec.id);
      }
      mustBeApproved(s);

      if (i.decision === 'keep_current') {
        if (rec.status !== 'changed') throw notPending();
        await c.query("UPDATE external_history_records SET status='accepted', decided_by=$2, decided_at=now(), decision_note=$3, row_version=row_version+1, updated_at=now() WHERE id=$1", [rec.id, user.id, i.note ?? 'Kept the entry as it was']);
        await audit(c, user.id, 'history_record_keep', 'external_history_records', rec.id);
        return one_(c, s, rec.id);
      }

      if (i.decision === 'apply_update') {
        if (!['changed', 'withdrawn'].includes(rec.status) || !rec.membership_id) throw notPending();
        const m = (await c.query('SELECT * FROM career_memberships WHERE id=$1 FOR UPDATE', [rec.membership_id])).rows[0];
        if (rec.status === 'withdrawn') {
          await c.query("UPDATE career_memberships SET verification_status='unverified', verified_by=NULL, verified_at=NULL, verified_via=NULL, review_note=$2, row_version=row_version+1, updated_at=now() WHERE id=$1", [m.id, `Withdrawn by ${s.name}`]);
          await snapshot(c, m.id, 'external_withdrawn', user.id, i.note ?? `Withdrawn by ${s.name}`);
          await c.query("UPDATE external_history_records SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3, row_version=row_version+1, updated_at=now() WHERE id=$1", [rec.id, user.id, i.note ?? 'Withdrawn by the source']);
          await notify(c, m.user_id, { kind: 'history_external_withdrawn', title: `${s.name} withdrew a record`, body: 'The entry stays on your timeline, no longer marked verified.', data: { career_entry_id: m.id }, dedupe_key: `history-withdrawn:${rec.id}:${rec.version}` });
        } else {
          const club = await clubFor(c, s, rec, i, user.id);
          try {
            await c.query(
              `UPDATE career_memberships SET team_id=$2, organisation_id=$3, club_name=$4, season_label=$5, starts_on=$6, ends_on=$7, position=coalesce($8, position), competition_level=coalesce($9, competition_level), jersey_no=coalesce($10, jersey_no),
                      verification_status='verified', verified_by=$11, verified_at=now(), verified_via=$12, row_version=row_version+1, updated_at=now() WHERE id=$1`,
              [m.id, club.teamId, club.teamId ? null : club.orgId, club.teamId || club.orgId ? null : rec.club_name, rec.season_label, rec.starts_s, rec.ends_s, rec.position, rec.competition_level, rec.jersey_no, user.id, VIA[rec.via]]);
          } catch (e) { throw e.code === '23505' ? conflict('Applying that would duplicate another entry on the timeline', { code: 'duplicate_membership' }) : e; }
          await snapshot(c, m.id, 'external_updated', user.id, i.note ?? `Updated from ${s.name}`);
          await evidenceFor(c, m.id, s, rec, user.id);
          await c.query("UPDATE external_history_records SET status='accepted', decided_by=$2, decided_at=now(), decision_note=$3, row_version=row_version+1, updated_at=now() WHERE id=$1", [rec.id, user.id, i.note ?? null]);
          await notify(c, m.user_id, { kind: 'history_external_updated', title: `${s.name} corrected a record`, body: 'Your timeline entry was updated from their record. Open it to see the history.', data: { career_entry_id: m.id }, dedupe_key: `history-updated:${rec.id}:${rec.version}` });
        }
        await audit(c, user.id, 'history_record_apply_update', 'external_history_records', rec.id);
        return one_(c, s, rec.id);
      }

      // ---- accept
      if (!['new', 'disputed'].includes(rec.status)) throw notPending();
      if (rec.withdrawn) throw conflict('The source has withdrawn this record', { code: 'record_withdrawn' });
      const target = rec.user_id ?? i.user_id;
      if (!target) throw badRequest('Pick the player this record is about');
      if (rec.user_id && i.user_id && i.user_id !== rec.user_id) throw badRequest('This record is already matched to a different player');
      if (target === user.id) throw forbidden('You cannot review a record about yourself');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [target])).rowCount) throw notFound('Player');
      if (await isYouth(target, c) && !(await hasConsent(target, 'participation', c))) throw conflict('A guardian has not given current consent for participation', { code: 'guardian_consent_required' });
      const level = rec.competition_level ?? i.competition_level;
      if (!level) throw badRequest('The source did not send a competition level. Choose one.');
      const club = await clubFor(c, s, rec, i, user.id);

      // identity: the outside id belongs to exactly one player
      const full = (await c.query('SELECT person_ref_idx, person_ref_enc FROM external_history_records WHERE id=$1', [rec.id])).rows[0];
      if (full.person_ref_idx) {
        const held = (await c.query("SELECT id, user_id, status FROM external_identities WHERE source_id=$1 AND ref_idx=$2 AND status <> 'revoked' FOR UPDATE", [s.id, full.person_ref_idx])).rows[0];
        if (held && held.user_id !== target) throw conflict('That ID at this source is linked to a different player', { code: 'identity_conflict' });
        if (held) await c.query("UPDATE external_identities SET status='confirmed', confirmed_by=$2, confirmed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 AND status <> 'confirmed'", [held.id, user.id]);
        else await c.query("INSERT INTO external_identities(user_id, source_id, ref_idx, ref_enc, status, claimed_by, confirmed_by, confirmed_at) VALUES ($1,$2,$3,$4,'confirmed',$5,$5,now())", [target, s.id, full.person_ref_idx, full.person_ref_enc, user.id]);
      }

      const dups = await possibleDuplicates(c, { ...rec, user_id: target }, s);
      let mid;
      if (dups.length && !i.reconcile) throw conflict('This player already has a similar entry. Merge into it, or say it is a separate stint.', { code: 'reconcile_required', duplicates: dups });
      if (i.reconcile?.mode === 'merge') {
        const m = dups.find((d) => d.id === i.reconcile.membership_id);
        if (!m) throw badRequest('Choose one of the similar entries to merge into');
        const cur = (await c.query('SELECT * FROM career_memberships WHERE id=$1 FOR UPDATE', [m.id])).rows[0];
        try {
          await c.query(
            `UPDATE career_memberships SET team_id=coalesce($2::uuid, team_id), organisation_id=CASE WHEN $2::uuid IS NOT NULL THEN NULL ELSE coalesce($3::uuid, organisation_id) END, season_label=coalesce($4, season_label), starts_on=$5, ends_on=$6,
                    position=coalesce($7, position), competition_level=$8, jersey_no=coalesce($9, jersey_no), external_record_id=$10, verification_status='verified', verified_by=$11, verified_at=now(), verified_via=$12,
                    review_note=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1`,
            [cur.id, club.teamId, club.orgId, rec.season_label, rec.starts_s, rec.ends_s, rec.position, level, rec.jersey_no, rec.id, user.id, VIA[rec.via]]);
        } catch (e) { throw e.code === '23505' ? conflict('Merging would duplicate another entry on the timeline', { code: 'duplicate_membership' }) : e; }
        mid = cur.id;
        await snapshot(c, mid, 'external_merged', user.id, i.note ?? `Merged with the ${s.name} record`);
      } else {
        try {
          mid = (await c.query(
            `INSERT INTO career_memberships(user_id, sport_id, team_id, organisation_id, club_name, season_label, starts_on, ends_on, position, competition_level, jersey_no, source, verification_status, verified_by, verified_at, verified_via, external_record_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'external','verified',$12,now(),$13,$14,$12) RETURNING id`,
            [target, rec.sport_id, club.teamId, club.teamId ? null : club.orgId, club.teamId || club.orgId ? null : rec.club_name, rec.season_label, rec.starts_s, rec.ends_s, rec.position, level, rec.jersey_no, user.id, VIA[rec.via], rec.id])).rows[0].id;
        } catch (e) { throw e.code === '23505' ? conflict('That stint is already on the timeline. Merge into the existing entry.', { code: 'duplicate_membership' }) : e; }
        await snapshot(c, mid, 'external_linked', user.id, i.note ?? `Confirmed from ${s.name}`);
      }
      await evidenceFor(c, mid, s, rec, user.id);
      await c.query(
        "UPDATE external_history_records SET status='accepted', user_id=$2, match_method=coalesce(match_method,'manual'), membership_id=$3, decided_by=$4, decided_at=now(), decision_note=$5, row_version=row_version+1, updated_at=now() WHERE id=$1",
        [rec.id, target, mid, user.id, i.note ?? null]);
      if (full.person_ref_idx) await resolveWaiting(c, s.id, full.person_ref_idx, target);
      await audit(c, user.id, 'history_record_accept', 'external_history_records', rec.id);
      await notify(c, target, { kind: 'history_external_linked', title: `${s.name} confirmed a club on your timeline`, body: `${rec.club_name} is now marked as confirmed by ${s.name}. If it is not yours, you can dispute it.`, data: { career_entry_id: mid, record_id: rec.id }, dedupe_key: `history-linked:${rec.id}:${rec.version}` });
      return one_(c, s, rec.id);
    });
  },
});

async function one_(c, s, rid) {
  const r = (await c.query(`SELECT ${REC_COLS} ${REC_FROM} WHERE r.id=$1`, [rid])).rows[0];
  return recordView(c, s, r);
}

// ------------------------------------------------------------------ identity
const IDENT_COLS = `x.id, x.source_id, es.name AS source, x.status, x.user_id, x.ref_enc, x.row_version, x.created_at, x.confirmed_at`;

cap({
  name: 'claim_history_identity', method: 'POST', path: '/me/history-identities', tag: TAG, status: 201,
  summary: 'Say which ID a league or federation knows you by (your player/registration number there). Staff of that source confirm it before any of its records reach your timeline. A guardian can claim for a young person (pass user_id); a young person claiming for themselves needs a guardian\'s current consent. The ID is stored encrypted.',
  input: z.object({ source_id: id, external_ref: z.string().trim().min(1).max(120), user_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const target = await subject(user, i.user_id, { write: true }, c);
      const s = (await c.query("SELECT * FROM external_feed_sources WHERE id=$1 AND archived_at IS NULL AND status='approved'", [i.source_id])).rows[0];
      if (!s) throw notFound('Source');
      const idx = refIdx(s.id, i.external_ref);
      const held = (await c.query("SELECT id, user_id FROM external_identities WHERE source_id=$1 AND ref_idx=$2 AND status <> 'revoked'", [s.id, idx])).rows[0];
      if (held && held.user_id === target) return identity(c, held.id);
      if (held) throw conflict('That ID cannot be claimed here. Ask the league or federation to sort it out.', { code: 'identity_unavailable' });
      const row = (await c.query("INSERT INTO external_identities(user_id, source_id, ref_idx, ref_enc, claimed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [target, s.id, idx, encrypt(i.external_ref, 'external_history_records.person_ref'), user.id])).rows[0];
      if (target !== user.id) await audit(c, user.id, 'write_history_identity', 'users', target);
      return identity(c, row.id);
    });
  },
});

async function identity(c, iid) {
  const r = (await c.query(`SELECT ${IDENT_COLS} FROM external_identities x JOIN external_feed_sources es ON es.id=x.source_id WHERE x.id=$1`, [iid])).rows[0];
  const { ref_enc, ...rest } = r;
  return { ...rest, external_ref: decrypt(ref_enc, 'external_history_records.person_ref') };
}

cap({
  name: 'list_history_identities', method: 'GET', path: '/me/history-identities', tag: TAG,
  summary: 'The league / federation IDs you (or a young person you are guardian of, via user_id) have linked, and whether each is waiting for the source\'s staff or confirmed.',
  input: z.object({ user_id: id.optional(), include_revoked: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const target = await subject(user, i.user_id);
    const rows = await many(`SELECT ${IDENT_COLS} FROM external_identities x JOIN external_feed_sources es ON es.id=x.source_id WHERE x.user_id=$1 AND ($2::boolean OR x.status <> 'revoked') ORDER BY x.created_at, x.id LIMIT $3 OFFSET $4`, [target, i.include_revoked, i.limit, i.offset]);
    if (target !== user.id) await audit(null, user.id, 'read_history_identity', 'users', target);
    return rows.map(({ ref_enc, ...r }) => ({ ...r, external_ref: decrypt(ref_enc, 'external_history_records.person_ref') }));
  },
});

cap({
  name: 'revoke_history_identity', method: 'POST', path: '/me/history-identities/:id/revoke', tag: TAG,
  summary: 'Remove the link between you and an ID at a league / federation. Records waiting for review stop matching you; entries already confirmed from that ID are hidden from your timeline (kept, restorable by the source\'s staff re-confirming) and their records go back to the source\'s review queue as disputed.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = (await c.query('SELECT * FROM external_identities WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!x) throw notFound('Identity');
      await subject(user, x.user_id === user.id ? undefined : x.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Identity') : e; });
      if (x.row_version !== i.row_version) throw stale(x);
      if (x.status === 'revoked') return identity(c, x.id);
      await c.query("UPDATE external_identities SET status='revoked', revoked_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [x.id]);
      await c.query("UPDATE external_history_records SET user_id=NULL, match_method=NULL, row_version=row_version+1, updated_at=now() WHERE source_id=$1 AND person_ref_idx=$2 AND user_id=$3 AND status IN ('new','changed')", [x.source_id, x.ref_idx, x.user_id]);
      const accepted = (await c.query("SELECT id, membership_id FROM external_history_records WHERE source_id=$1 AND person_ref_idx=$2 AND user_id=$3 AND status IN ('accepted')", [x.source_id, x.ref_idx, x.user_id])).rows;
      for (const r of accepted) await disputeRecord(c, r, user.id, 'Identity link removed by the player');
      await audit(c, user.id, 'revoke_history_identity', 'users', x.user_id);
      return identity(c, x.id);
    });
  },
});

/** Hide the entry (kept, un-verified) and send the record back to the source's staff. Never deletes. */
async function disputeRecord(c, r, actorId, reason) {
  if (r.membership_id) {
    const m = (await c.query('SELECT * FROM career_memberships WHERE id=$1 FOR UPDATE', [r.membership_id])).rows[0];
    if (m && !m.archived_at) {
      await c.query("UPDATE career_memberships SET archived_at=now(), verification_status='unverified', verified_by=NULL, verified_at=NULL, verified_via=NULL, row_version=row_version+1, updated_at=now() WHERE id=$1", [m.id]);
      await snapshot(c, m.id, 'external_disputed', actorId, reason);
    }
  }
  const rec = (await c.query("UPDATE external_history_records SET status='disputed', user_id=NULL, match_method=NULL, decision_note=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING decided_by, source_id", [r.id, reason])).rows[0];
  if (rec?.decided_by) await notify(c, rec.decided_by, { kind: 'history_external_disputed', title: 'A player disputed a confirmed record', body: reason, data: { record_id: r.id, source_id: rec.source_id }, dedupe_key: `history-disputed:${r.id}:${Date.now()}` });
}

cap({
  name: 'list_history_claims', method: 'GET', path: '/history-sources/:id/claims', tag: TAG,
  summary: 'ID claims waiting for a source\'s staff: a player says "this is my ID at your league". Shows the claimed ID and the player\'s name. Reading is audit-logged; young people appear only while a guardian currently consents to participation.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await managed(user, i.id);
    const rows = await many(
      `SELECT x.id, x.status, x.row_version, x.created_at, x.ref_enc, x.user_id, u.display_name FROM external_identities x JOIN users u ON u.id=x.user_id
        WHERE x.source_id=$1 AND x.status='claimed'
          AND (NOT (u.youth_until IS NOT NULL AND u.youth_until > current_date) OR EXISTS (SELECT 1 FROM youth_consents yc WHERE yc.child_id=x.user_id AND yc.purpose='participation' AND yc.revoked_at IS NULL AND yc.expires_at > now()
                AND EXISTS (SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=yc.granted_by AND gl.child_id=yc.child_id AND gl.status='active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now()))))
        ORDER BY x.created_at, x.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    await audit(null, user.id, 'read_history_claims', 'external_feed_sources', i.id);
    return rows.map(({ ref_enc, ...r }) => ({ ...r, external_ref: decrypt(ref_enc, 'external_history_records.person_ref') }));
  },
});

cap({
  name: 'review_history_identity', method: 'POST', path: '/history-identities/:id/review', tag: TAG,
  summary: 'Confirm or reject a player\'s ID claim as the source\'s staff. Confirming matches every waiting record carrying that ID to the player (still subject to your review of each record). You cannot confirm your own claim. Rejecting needs a reason the player can read.',
  input: z.object({ id, decision: z.enum(['confirm', 'reject']), note: z.string().trim().max(500).optional(), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    if (i.decision === 'reject' && !i.note) throw badRequest('Say why the claim is rejected so the player can fix it');
    return tx(async (c) => {
      const probe = (await c.query('SELECT source_id FROM external_identities WHERE id=$1', [i.id])).rows[0];
      if (!probe) throw notFound('Claim');
      const s = await managed(user, probe.source_id, c, { lock: true });
      mustBeApproved(s);
      const x = (await c.query('SELECT * FROM external_identities WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (x.user_id === user.id) throw forbidden('You cannot confirm your own claim');
      if (x.row_version !== i.row_version) throw stale(x);
      if (x.status !== 'claimed') throw conflict('This claim is not waiting for review', { code: 'wrong_state', status: x.status });
      if (i.decision === 'confirm') {
        if (await isYouth(x.user_id, c) && !(await hasConsent(x.user_id, 'participation', c))) throw conflict('A guardian has not given current consent for participation', { code: 'guardian_consent_required' });
        await c.query("UPDATE external_identities SET status='confirmed', confirmed_by=$2, confirmed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [x.id, user.id]);
        await resolveWaiting(c, s.id, x.ref_idx, x.user_id);
      } else {
        await c.query("UPDATE external_identities SET status='revoked', revoked_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [x.id]);
      }
      await audit(c, user.id, `history_identity_${i.decision}`, 'external_identities', x.id);
      await notify(c, x.user_id, { kind: i.decision === 'confirm' ? 'history_identity_confirmed' : 'history_identity_rejected', title: i.decision === 'confirm' ? `${s.name} confirmed your ID` : `${s.name} could not confirm your ID`, body: i.note ?? 'Open your career timeline to see it.', data: { source_id: s.id } });
      return identity(c, x.id);
    });
  },
});

// ------------------------------------------------------------------ the player's view
cap({
  name: 'list_my_external_history', method: 'GET', path: '/me/external-history', tag: TAG,
  summary: 'Timeline entries confirmed (or changed / withdrawn) by an outside source, with where each came from (live feed or imported file), which version of the record it reflects and whether the source later changed it. Never includes the source\'s raw record, other people, or review notes. A guardian passes user_id for a young person.',
  input: z.object({ user_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const target = await subject(user, i.user_id);
    if (target !== user.id) await audit(null, user.id, 'read_external_history', 'users', target);
    return many(
      `SELECT r.id, es.id AS source_id, es.name AS source, r.via, r.status, r.version, r.club_name, sp.slug AS sport_slug, sp.name AS sport, r.starts_on::text AS starts_on, r.ends_on::text AS ends_on, r.season_label,
              r.membership_id, r.decided_at, r.row_version
         FROM external_history_records r JOIN external_feed_sources es ON es.id=r.source_id JOIN sports sp ON sp.id=r.sport_id
        WHERE r.user_id=$1 AND r.status IN ('accepted','changed','withdrawn') ORDER BY r.starts_on DESC, r.id LIMIT $2 OFFSET $3`, [target, i.limit, i.offset]);
  },
});

cap({
  name: 'dispute_external_history', method: 'POST', path: '/me/external-history/:id/dispute', tag: TAG,
  summary: 'Tell the source a confirmed record is not yours or is wrong. The timeline entry is hidden and un-verified (kept, never deleted), the record goes back to the source\'s staff, and the person who confirmed it is told. A guardian can do this for a young person.',
  input: z.object({ id, reason: z.string().trim().min(3).max(500), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM external_history_records WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r || !r.user_id) throw notFound('Record');
      await subject(user, r.user_id === user.id ? undefined : r.user_id, { write: true }, c).catch((e) => { throw e.status === 403 ? notFound('Record') : e; });
      if (r.row_version !== i.row_version) throw stale(r);
      if (!['accepted', 'changed', 'withdrawn'].includes(r.status)) throw conflict('That record cannot be disputed', { code: 'wrong_state', status: r.status });
      await disputeRecord(c, r, user.id, i.reason);
      await audit(c, user.id, 'dispute_external_history', 'external_history_records', r.id);
      return { id: r.id, status: 'disputed' };
    });
  },
});
