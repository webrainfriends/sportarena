// The referee's reporting extract (#88): a PDF of their assignments, closure forms, fees, feedback and linked disputes. The referee owns it, builds it
// from their own record, and may share it with a named person for a limited time; every build, share and read is audit-logged, and a recipient's
// access is re-checked on every download (so revoking takes effect at once).
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { many, one, tx } from '../db.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { saveEncrypted, loadEncrypted, docHeaders } from '../doc-store.js';
import { buildExtract } from '../officials-extract.js';
import { renderOfficialExtract } from '../documents/official-extract.js';

const TAG = 'Officials';
const FOLDER = 'official-extracts';
const ctx = (userId) => `official_extract:${userId}`;
const day = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const yearAgo = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const COLS = "id, user_id, sport_id, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to, sha256, file_name, size_bytes, pages, counts, created_at";

cap({
  name: 'build_official_extract', method: 'POST', path: '/me/officials/extracts', tag: TAG, status: 201,
  summary: 'Build my officiating extract as a PDF (default: the last 12 months): assignments and their history, the closure forms in detail (score sheet, sign-offs, my reports and every revision), fees and payment status, linked disputes, and feedback once enough people have answered. A frozen, fingerprinted snapshot kept on my profile. A retried request with the same client_key returns the original.',
  input: z.object({ from: day.optional(), to: day.optional(), sport_id: id.optional(), client_key: z.string().trim().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const from = i.from ?? yearAgo(), to = i.to ?? today();
    if (to < from) throw badRequest('The end date is before the start date');
    if (Date.parse(to) - Date.parse(from) > 5 * 366 * 864e5) throw badRequest('An extract covers at most five years');
    if (i.client_key) {
      const dup = await one(`SELECT ${COLS} FROM official_extracts WHERE user_id=$1 AND client_key=$2`, [user.id, i.client_key]);
      if (dup) return dup;
    }
    const nextDay = new Date(Date.parse(to) + 864e5).toISOString().slice(0, 10);
    const { snapshot, sha256, logos } = await buildExtract(user, { from, to: nextDay, sportId: i.sport_id });
    if (!snapshot.counts.assignments && !snapshot.sports.length) throw badRequest('There is nothing to report yet: add a referee sport profile or take an assignment first');
    snapshot.period.to = to;
    const createdAt = new Date();
    const docId = (await one('SELECT gen_random_uuid() AS id')).id;
    const { buffer, pages } = await renderOfficialExtract({ snapshot, createdAt, id: docId, sha256, logos });
    const saved = await saveEncrypted(FOLDER, ctx(user.id), buffer);
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO official_extracts(id, user_id, sport_id, period_from, period_to, sha256, file_name, size_bytes, pages, counts, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
        [docId, user.id, i.sport_id ?? null, from, to, sha256, saved.file, buffer.length, pages, JSON.stringify(snapshot.counts), i.client_key ?? null])).rows[0];
      await audit(c, user.id, 'build_official_extract', 'official_extracts', row.id);
      return row;
    });
  },
});

cap({
  name: 'list_my_official_extracts', method: 'GET', path: '/me/officials/extracts', tag: TAG,
  summary: 'My officiating extracts, newest first, with who they are currently shared with.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${COLS} FROM official_extracts WHERE user_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    for (const r of rows) {
      r.shares = await many(`SELECT s.id, s.recipient_id, u.display_name AS recipient_name, s.expires_at, s.revoked_at, (s.revoked_at IS NULL AND s.expires_at > now()) AS active FROM official_extract_shares s JOIN users u ON u.id=s.recipient_id WHERE s.extract_id=$1 ORDER BY s.created_at DESC`, [r.id]);
      delete r.user_id;
    }
    return rows;
  },
});

cap({
  name: 'share_official_extract', method: 'POST', path: '/me/officials/extracts/:id/shares', tag: TAG, status: 201,
  summary: 'Share one of my extracts with a named person (an organiser, federation officer or selector) for up to 90 days. They can read it until it expires or I revoke it.',
  input: z.object({ id, recipient_id: id, days: z.number().int().min(1).max(90).default(14) }),
  async handler({ user }, i) {
    if (i.recipient_id === user.id) throw badRequest('That is you');
    return tx(async (c) => {
      const ex = (await c.query('SELECT * FROM official_extracts WHERE id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
      if (!ex) throw notFound('extract');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.recipient_id])).rowCount) throw notFound('person');
      await c.query('UPDATE official_extract_shares SET revoked_at=now() WHERE extract_id=$1 AND recipient_id=$2 AND revoked_at IS NULL', [ex.id, i.recipient_id]);
      const s = (await c.query("INSERT INTO official_extract_shares(extract_id, recipient_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3)) RETURNING id, recipient_id, expires_at", [ex.id, i.recipient_id, i.days])).rows[0];
      await audit(c, user.id, 'share_official_extract', 'official_extract_shares', s.id);
      await notify(c, i.recipient_id, { kind: 'official_extract_shared', title: 'An officiating record was shared with you', body: `${user.display_name} shared their officiating record until ${s.expires_at.toISOString().slice(0, 10)}.`, data: { extract_id: ex.id } });
      return s;
    });
  },
});

cap({
  name: 'revoke_official_extract_share', method: 'POST', path: '/me/officials/extract-shares/:id/revoke', tag: TAG,
  summary: 'Stop sharing an extract. The person loses access on their next read; repeating this is harmless.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT s.id FROM official_extract_shares s JOIN official_extracts e ON e.id=s.extract_id WHERE s.id=$1 AND e.user_id=$2', [i.id, user.id]);
    if (!s) throw notFound('share');
    await one('UPDATE official_extract_shares SET revoked_at=coalesce(revoked_at, now()) WHERE id=$1 RETURNING id', [i.id]);
    await audit(null, user.id, 'revoke_official_extract_share', 'official_extract_shares', i.id);
    return { id: i.id, revoked: true };
  },
});

cap({
  name: 'list_official_extracts_shared_with_me', method: 'GET', path: '/me/officials/extracts-shared', tag: TAG,
  summary: 'Officiating extracts people have shared with me that are still open.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT e.id, to_char(e.period_from, 'YYYY-MM-DD') AS period_from, to_char(e.period_to, 'YYYY-MM-DD') AS period_to, e.pages, e.created_at, u.display_name AS owner_name, u.handle AS owner_handle, s.expires_at
       FROM official_extract_shares s JOIN official_extracts e ON e.id=s.extract_id JOIN users u ON u.id=e.user_id
      WHERE s.recipient_id=$1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.expires_at, e.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

/** Binary route: the PDF itself, for the owner or a person with a live share. Access is checked on every request. */
export function officialExtractRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  r.get('/official-extracts/:id/pdf', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization); if (!user) throw unauthorized();
      const eid = String(req.params.id); if (!/^[0-9a-f-]{36}$/.test(eid)) throw notFound('extract');
      const ex = await one('SELECT * FROM official_extracts WHERE id=$1', [eid]);
      const shared = ex && ex.user_id !== user.id && await one('SELECT 1 AS ok FROM official_extract_shares WHERE extract_id=$1 AND recipient_id=$2 AND revoked_at IS NULL AND expires_at > now()', [eid, user.id]);
      if (!ex || (ex.user_id !== user.id && !shared)) throw notFound('extract');
      const buffer = await loadEncrypted(FOLDER, ctx(ex.user_id), ex.file_name);
      await audit(null, user.id, ex.user_id === user.id ? 'read_official_extract' : 'read_shared_official_extract', 'official_extracts', ex.id);
      res.set(docHeaders('application/pdf', buffer)).set('Content-Disposition', `inline; filename="officiating-extract-${String(ex.period_to.toISOString?.().slice(0, 10) ?? ex.period_to)}.pdf"`);
      res.end(buffer);
    } catch (e) { fail(res, e); }
  });
  return r;
}
