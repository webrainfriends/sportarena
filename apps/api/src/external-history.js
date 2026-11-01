// External verified league and federation history (#323): the core. A source (a league or federation) sends records; they are STAGED, matched to a
// player through a confirmed identity, reviewed by that source's own staff, and only then become verified entries on the career timeline (#311).
// Two honest adapters: `api_json` pulls the source's HTTPS feed (needs real API access from the source), `file_import` takes an export uploaded by the
// source's staff. A player's own file/OCR import (ImportMatches) is never verification and never touches this path.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { blindIndex, decrypt, encrypt } from './crypto.js';
import { isPlatform } from './platform.js';
import { authority, can } from './federation.js';
import { checkEndpoint } from './access-providers.js';
import { csvToObjects } from './csv.js';
import { LEVELS } from './career.js';

export const MAX_FILE_BYTES = 2 * 2 ** 20;
export const MAX_RECORDS = 5000;
const MAX_PAGES = 10, TIMEOUT_MS = 15_000, MAX_RESPONSE = 4 * 2 ** 20;
const SECRET_CTX = 'external_feed_sources.secret', PAYLOAD_CTX = 'external_history_records.payload';

export const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const refIdx = (sourceId, ref) => blindIndex(`${sourceId}|${norm(ref)}`);
const nameIdx = (name) => blindIndex(`name|${norm(name)}`);
const licIdx = (no) => blindIndex(`lic|${norm(no)}`);

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'not a real date');
const opt = (t) => t.nullish().transform((v) => (v === '' || v == null ? undefined : v));
/** The one record shape every adapter produces (schema "gotmygame-history/v1"). */
export const RECORD = z.object({
  external_ref: z.string().trim().min(1).max(120),
  person: z.object({ ref: opt(z.string().trim().max(120)), name: opt(z.string().trim().min(2).max(120)), licence_no: opt(z.string().trim().max(60)) })
    .refine((p) => p.ref || p.name || p.licence_no, 'Say who it is about: a person ref, a licence number or a name'),
  club: z.string().trim().min(2).max(120),
  sport: opt(z.string().trim().max(60)),
  season: opt(z.string().trim().min(2).max(40)),
  starts_on: iso,
  ends_on: opt(iso),
  position: opt(z.string().trim().min(1).max(60)),
  level: opt(z.enum(LEVELS)),
  jersey_no: opt(z.coerce.number().int().min(0).max(999)),
  withdrawn: z.boolean().optional().default(false),
}).refine((r) => !r.ends_on || r.ends_on >= r.starts_on, { message: 'ends before it starts', path: ['ends_on'] });

/** CSV header -> record. Columns: external_ref, person_ref, person_name, licence_no, club, sport, season, starts_on, ends_on, position, level, jersey_no, withdrawn. */
export function fromCsvRow(r) {
  return {
    external_ref: r.external_ref, club: r.club, sport: r.sport, season: r.season, starts_on: r.starts_on, ends_on: r.ends_on, position: r.position, level: r.level, jersey_no: r.jersey_no,
    withdrawn: /^(1|true|yes)$/i.test(String(r.withdrawn ?? '')),
    person: { ref: r.person_ref, name: r.person_name, licence_no: r.licence_no },
  };
}

/** Parse a staff-uploaded export into raw record objects (validation happens per record, so one bad row never loses the rest). */
export function parseUpload(format, content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { error: `Files can be up to ${MAX_FILE_BYTES / 2 ** 20} MB` };
  let rows;
  if (format === 'json') {
    try { const j = JSON.parse(content); rows = Array.isArray(j) ? j : j?.records; } catch { return { error: 'That is not valid JSON' }; }
    if (!Array.isArray(rows)) return { error: 'Expected a list of records, or {"records": [...]}' };
  } else {
    rows = csvToObjects(content).map(fromCsvRow);
  }
  if (!rows.length) return { error: 'The file has no records' };
  if (rows.length > MAX_RECORDS) return { error: `Send at most ${MAX_RECORDS} records at a time` };
  return { rows };
}

const OUTCOME = (outcome, message) => ({ outcome, message });
/** Pull from an approved api_json source. Silence, a redirect, a non-2xx, a bad body or a slow reply is 'unavailable'; nothing is ever assumed. Pages until the source says it is done. */
export async function pullFeed(source) {
  if (source.adapter !== 'api_json' || !source.endpoint_url) return OUTCOME('unavailable', 'This source has no live feed. Import a file instead.');
  const bad = checkEndpoint(source.endpoint_url);
  if (bad) return OUTCOME('unavailable', bad);
  const token = source.secret_enc ? decrypt(source.secret_enc, SECRET_CTX) : null;
  let cursor = source.cursor ?? null, rows = [], pages = 0;
  try {
    for (; pages < MAX_PAGES; pages++) {
      const u = new URL(source.endpoint_url);
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (res.status === 401 || res.status === 403) return OUTCOME('rejected', 'The source refused our credentials');
      if (!res.ok) return { ...OUTCOME('unavailable', `The source answered ${res.status}`), rows, cursor };
      const text = await res.text();
      if (text.length > MAX_RESPONSE) return { ...OUTCOME('unavailable', 'The source sent more than we accept in one page'), rows, cursor };
      let j; try { j = JSON.parse(text); } catch { return { ...OUTCOME('unavailable', 'The source did not send valid JSON'), rows, cursor }; }
      if (!Array.isArray(j?.records)) return { ...OUTCOME('unavailable', 'The source reply has no "records" list'), rows, cursor };
      rows.push(...j.records);
      if (rows.length > MAX_RECORDS) return { ...OUTCOME('unavailable', `The source sent more than ${MAX_RECORDS} records`), rows: rows.slice(0, MAX_RECORDS), cursor };
      if (typeof j.next_cursor === 'string' && j.next_cursor && j.next_cursor !== cursor) cursor = j.next_cursor; else { return { outcome: 'ok', rows, cursor: typeof j.next_cursor === 'string' ? j.next_cursor : cursor }; }
    }
    return { outcome: 'ok', rows, cursor, more: true };
  } catch {
    return { ...OUTCOME('unavailable', 'The source could not be reached'), rows, cursor };
  }
}

/** May this user run (review, import, sync) this source? The platform team, or the source body's admins / registrars. Read live. */
export async function sourceAuthority(user, source, c = pool) {
  if (isPlatform(user)) return true;
  if (!source.body_id) return false;
  const auth = await authority(user, source.body_id, { c, optional: true });
  return can(auth, 'affiliations', source.sport_id);
}

const sportIdOf = async (c, slugOrId, fallback) => {
  if (!slugOrId) return fallback ?? null;
  const r = (await c.query('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [slugOrId])).rows[0];
  return r?.id ?? null;
};

/** The player for a record by a confirmed identity link on the source's person ref. Names only ever suggest candidates to a reviewer, never link. */
export async function resolveUser(c, source, rec) {
  if (!rec.person_ref_idx) return null;
  const r = (await c.query("SELECT user_id FROM external_identities WHERE source_id=$1 AND ref_idx=$2 AND status='confirmed'", [source.id, rec.person_ref_idx])).rows[0];
  return r ? { user_id: r.user_id, match_method: 'identity' } : null;
}

/** The licence number matches a licence this source's own body issued (the body's register is the authority). Ambiguity (two holders) matches nobody. */
export async function resolveByLicence(c, source, licenceNo) {
  if (!licenceNo || !source.body_id) return null;
  const rows = (await c.query("SELECT DISTINCT holder_id FROM fed_licences WHERE body_id=$1 AND licence_no IS NOT NULL AND lower(trim(licence_no))=lower(trim($2))", [source.body_id, licenceNo])).rows;
  return rows.length === 1 ? { user_id: rows[0].holder_id, match_method: 'licence' } : null;
}

const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

/**
 * Stage raw records inside one batch. Each record is validated and written on its own savepoint, so one bad row is reported (recoverable) and the rest are kept.
 * A re-delivery of the same external_ref with identical content is `unchanged`; with different content it becomes a new version, and an already-accepted record is
 * flagged `changed` for review (the timeline entry itself is never touched until a reviewer applies it).
 */
export async function stageRecords(c, source, batchId, via, rawRows) {
  const out = { received: rawRows.length, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };
  let i = 0;
  for (const raw of rawRows) {
    i++;
    const parsed = RECORD.safeParse(raw);
    const fail = (msg) => { out.failed++; if (out.errors.length < 50) out.errors.push({ row: i, external_ref: typeof raw?.external_ref === 'string' ? raw.external_ref.slice(0, 120) : null, error: msg }); };
    if (!parsed.success) { fail(parsed.error.issues.map((x) => `${x.path.join('.') || 'record'}: ${x.message}`).slice(0, 3).join('; ')); continue; }
    const r = parsed.data;
    const sportId = await sportIdOf(c, r.sport, source.sport_id);
    if (!sportId) { fail(r.sport ? `unknown sport "${r.sport}"` : 'this source covers several sports, so the record must name its sport'); continue; }
    if (source.sport_id && sportId !== source.sport_id) { fail('the record is for a different sport than this source covers'); continue; }
    await c.query('SAVEPOINT rec');
    try {
      const personRefIdx = r.person.ref ? refIdx(source.id, r.person.ref) : null;
      const hash = hashOf(r);
      const payload = encrypt(JSON.stringify(r), PAYLOAD_CTX);
      const cur = (await c.query('SELECT * FROM external_history_records WHERE source_id=$1 AND external_ref=$2 FOR UPDATE', [source.id, r.external_ref])).rows[0];
      const cols = {
        person_ref_idx: personRefIdx, person_ref_enc: r.person.ref ? encrypt(r.person.ref, 'external_history_records.person_ref') : null,
        person_name_enc: r.person.name ? encrypt(r.person.name, 'external_history_records.person_name') : null, person_name_idx: r.person.name ? nameIdx(r.person.name) : null,
        licence_idx: r.person.licence_no ? licIdx(r.person.licence_no) : null, licence_enc: r.person.licence_no ? encrypt(r.person.licence_no, 'external_history_records.licence') : null,
      };
      if (!cur) {
        const found = (await resolveUser(c, source, { person_ref_idx: personRefIdx })) ?? (await resolveByLicence(c, source, r.person.licence_no));
        const row = (await c.query(
          `INSERT INTO external_history_records(source_id, external_ref, person_ref_idx, person_ref_enc, person_name_enc, person_name_idx, licence_idx, licence_enc, sport_id, club_name, season_label, starts_on, ends_on,
             position, competition_level, jersey_no, withdrawn, payload_hash, payload_enc, via, user_id, match_method, batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
          [source.id, r.external_ref, cols.person_ref_idx, cols.person_ref_enc, cols.person_name_enc, cols.person_name_idx, cols.licence_idx, cols.licence_enc, sportId, r.club, r.season ?? null, r.starts_on, r.ends_on ?? null,
            r.position ?? null, r.level ?? null, r.jersey_no ?? null, r.withdrawn, hash, payload, via, found?.user_id ?? null, found?.match_method ?? null, batchId])).rows[0];
        await c.query('INSERT INTO external_history_record_versions(record_id, version, payload_hash, payload_enc, batch_id) VALUES ($1,1,$2,$3,$4)', [row.id, hash, payload, batchId]);
        out.created++;
      } else if (cur.payload_hash === hash) {
        out.unchanged++;
      } else {
        const version = cur.version + 1;
        // the first delivery stays in the versions table; the row carries the latest. Accepted records wait for a reviewer before the timeline changes.
        const status = cur.status === 'accepted' ? (r.withdrawn ? 'withdrawn' : 'changed') : cur.status === 'rejected' ? 'new' : cur.status;
        const found = cur.user_id || cur.status === 'disputed' ? null : (await resolveUser(c, source, { person_ref_idx: personRefIdx })) ?? (await resolveByLicence(c, source, r.person.licence_no));
        await c.query(
          `UPDATE external_history_records SET person_ref_idx=$2, person_ref_enc=$3, person_name_enc=$4, person_name_idx=$5, licence_idx=$6, licence_enc=$7, sport_id=$8, club_name=$9, season_label=$10, starts_on=$11, ends_on=$12,
             position=$13, competition_level=$14, jersey_no=$15, withdrawn=$16, payload_hash=$17, payload_enc=$18, version=$19, via=$20, status=$21,
             user_id=coalesce(user_id,$22), match_method=CASE WHEN user_id IS NULL THEN $23 ELSE match_method END, batch_id=$24, row_version=row_version+1, updated_at=now() WHERE id=$1`,
          [cur.id, cols.person_ref_idx, cols.person_ref_enc, cols.person_name_enc, cols.person_name_idx, cols.licence_idx, cols.licence_enc, sportId, r.club, r.season ?? null, r.starts_on, r.ends_on ?? null,
            r.position ?? null, r.level ?? null, r.jersey_no ?? null, r.withdrawn, hash, payload, version, via, status, found?.user_id ?? null, found?.match_method ?? null, batchId]);
        await c.query('INSERT INTO external_history_record_versions(record_id, version, payload_hash, payload_enc, batch_id) VALUES ($1,$2,$3,$4,$5)', [cur.id, version, hash, payload, batchId]);
        out.updated++;
      }
      await c.query('RELEASE SAVEPOINT rec');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT rec');
      fail('could not be stored');
    }
  }
  return out;
}

/** After an identity is confirmed, resolve every waiting record from that source for that person ref. */
export async function resolveWaiting(c, sourceId, refIndex, userId) {
  return (await c.query(
    "UPDATE external_history_records SET user_id=$3, match_method='identity', row_version=row_version+1, updated_at=now() WHERE source_id=$1 AND person_ref_idx=$2 AND user_id IS NULL AND status IN ('new','changed')", [sourceId, refIndex, userId])).rowCount;
}

/** Existing timeline entries this record may be the same as: same sport, same canonical club (by alias or name), overlapping or touching dates. */
export async function possibleDuplicates(c, rec, source) {
  if (!rec.user_id) return [];
  const alias = (await c.query('SELECT team_id, organisation_id FROM external_club_aliases WHERE source_id=$1 AND alias=$2', [source.id, norm(rec.club_name)])).rows[0];
  return (await c.query(
    `SELECT m.id, m.row_version, coalesce(t.name, o.name, m.club_name) AS club, m.starts_on::text AS starts_on, m.ends_on::text AS ends_on, m.verification_status, m.source
       FROM career_memberships m LEFT JOIN teams t ON t.id=m.team_id LEFT JOIN organisations o ON o.id=m.organisation_id
      WHERE m.user_id=$1 AND m.sport_id=$2 AND m.archived_at IS NULL AND m.external_record_id IS NULL
        AND (lower(coalesce(t.name, o.name, m.club_name))=lower($3) OR ($4::uuid IS NOT NULL AND m.team_id=$4) OR ($5::uuid IS NOT NULL AND (m.organisation_id=$5 OR t.organisation_id=$5)))
        AND m.starts_on <= coalesce($7::date, 'infinity'::date) AND coalesce(m.ends_on, 'infinity'::date) >= $6::date - 31
      ORDER BY m.starts_on, m.id LIMIT 10`,
    [rec.user_id, rec.sport_id, rec.club_name, alias?.team_id ?? null, alias?.organisation_id ?? null, rec.starts_s, rec.ends_s ?? null])).rows;
}

export const readPayload = (rec) => JSON.parse(decrypt(rec.payload_enc, PAYLOAD_CTX));
