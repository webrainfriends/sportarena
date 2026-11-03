// Handing a published team performance report to an organisation (an academy, club or sponsor): an expiring, revocable share of one frozen,
// aggregate-only version. The organisation's owners and admins read it in the app (or export a PDF); every read is audited; the coach can revoke at any time.
// The coach can also download the PDF themselves (generate_coaching_report_document) and forward it: a copy made that way cannot be revoked.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { renderCoachingReport } from '../documents/render.js';
import { starterFor } from '../documents/layout.js';

const TAG = 'Coaching report sharing';
const COACH = ['coach'];
const READERS = ['owner', 'admin'];
const MAX_DAYS = 365;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function ownReport(user, reportId) {
  const r = await one('SELECT * FROM coaching_reports WHERE id=$1 AND coach_id=$2', [reportId, user.id]);
  if (!r) throw notFound('Report');
  return r;
}

/** A share the caller may read now: live, not expired, and the caller is an owner or admin of the organisation it was shared with. 404 otherwise. */
async function liveShareFor(user, shareId) {
  const s = await one(
    `SELECT s.*, v.snapshot, v.published_at, r.title, r.coach_id, o.name AS organisation_name FROM coaching_report_shares s
       JOIN coaching_report_versions v ON v.report_id=s.report_id AND v.version=s.version JOIN coaching_reports r ON r.id=s.report_id JOIN organisations o ON o.id=s.organisation_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_on >= current_date`, [shareId]);
  if (!s || !(await hasOrgGrant(user, s.organisation_id, READERS))) throw notFound('Report');
  return s;
}

cap({
  name: 'share_coaching_report', method: 'POST', path: '/coaching/reports/:id/shares', tag: TAG, auth: COACH, status: 201,
  summary: 'Share a published team performance report version (audience "organisation", aggregate only) with an organisation: its owners and admins are told and can read the frozen version, or export it as a PDF, until the expiry date or until you revoke. Defaults to the latest version. Sharing the same version with the same organisation again returns the existing share. Nothing about any athlete is individually named in such a report.',
  input: z.object({ id, version: z.number().int().min(1).optional(), organisation_id: id, expires_on: z.string().date().optional().describe(`defaults to 90 days; at most ${MAX_DAYS} days`), note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    const r = await ownReport(user, i.id);
    const v = await one('SELECT version, audience FROM coaching_report_versions WHERE report_id=$1 AND version=coalesce($2::int, $3)', [r.id, i.version ?? null, r.latest_version]);
    if (!v) throw conflict('Publish the report first', { code: 'not_published' });
    if (v.audience !== 'organisation') throw badRequest('Only a version published for an organisation can be shared with one. Set the audience to organisation and publish again.', { code: 'wrong_audience' });
    const org = await one("SELECT id, name FROM organisations WHERE id=$1 AND status='active' AND approval_status='approved'", [i.organisation_id]);
    if (!org) throw notFound('Organisation');
    const expires = i.expires_on ?? plusDays(90);
    if (expires < today()) throw badRequest('The expiry date is in the past');
    if (expires > plusDays(MAX_DAYS)) throw badRequest(`A share can last at most ${MAX_DAYS} days`);
    return tx(async (c) => {
      const live = (await c.query('SELECT * FROM coaching_report_shares WHERE report_id=$1 AND version=$2 AND organisation_id=$3 AND revoked_at IS NULL', [r.id, v.version, org.id])).rows[0];
      if (live) return { ...live, organisation_name: org.name, unchanged: true };
      const s = (await c.query('INSERT INTO coaching_report_shares(report_id, version, organisation_id, shared_by, note, expires_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [r.id, v.version, org.id, user.id, i.note ?? null, expires])).rows[0];
      await audit(c, user.id, 'share_coaching_report', 'coaching_report_shares', s.id);
      for (const m of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role = ANY($2)", [org.id, READERS])).rows) {
        await notify(c, m.user_id, { kind: 'coaching_report_shared', title: 'A performance report was shared with you', body: `${r.title} (aggregate only), shared with ${org.name}.`, data: { share_id: s.id }, dedupe_key: `crs:${s.id}:${m.user_id}` });
      }
      return { ...s, organisation_name: org.name, unchanged: false };
    });
  },
});

cap({
  name: 'list_coaching_report_shares', method: 'GET', path: '/coaching/reports/:id/shares', tag: TAG, auth: COACH,
  summary: 'Who a report has been shared with: organisation, version, expiry and whether it was revoked.', input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const r = await ownReport(user, i.id);
    return many(
      `SELECT s.id, s.version, s.organisation_id, o.name AS organisation_name, s.note, s.expires_on, s.created_at, s.revoked_at, (s.revoked_at IS NULL AND s.expires_on >= current_date) AS live
         FROM coaching_report_shares s JOIN organisations o ON o.id=s.organisation_id WHERE s.report_id=$1 ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [r.id, i.limit, i.offset]);
  },
});

cap({
  name: 'revoke_coaching_report_share', method: 'POST', path: '/coaching/report-shares/:id/revoke', tag: TAG, auth: COACH,
  summary: 'Stop sharing a report with an organisation now. The organisation can no longer read or export it; the record of the share is kept.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT s.id FROM coaching_report_shares s JOIN coaching_reports r ON r.id=s.report_id WHERE s.id=$1 AND r.coach_id=$2', [i.id, user.id]);
    if (!s) throw notFound('Share');
    return tx(async (c) => {
      const row = (await c.query('UPDATE coaching_report_shares SET revoked_at=coalesce(revoked_at, now()), revoked_by=coalesce(revoked_by, $2) WHERE id=$1 RETURNING id, revoked_at', [s.id, user.id])).rows[0];
      await audit(c, user.id, 'revoke_coaching_report_share', 'coaching_report_shares', s.id);
      return row;
    });
  },
});

cap({
  name: 'list_shared_coaching_reports', method: 'GET', path: '/me/shared-coaching-reports', tag: TAG, auth: 'user',
  summary: 'Performance reports coaches have shared with an organisation you own or administer (live shares only, newest first).', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT s.id, s.version, s.expires_on, s.created_at, s.note, o.id AS organisation_id, o.name AS organisation_name, r.title, v.snapshot->>'subject' AS subject, v.snapshot->'period' AS period, v.snapshot->>'coach_name' AS coach_name, v.published_at
       FROM coaching_report_shares s JOIN organisations o ON o.id=s.organisation_id JOIN coaching_reports r ON r.id=s.report_id JOIN coaching_report_versions v ON v.report_id=s.report_id AND v.version=s.version
      WHERE s.revoked_at IS NULL AND s.expires_on >= current_date AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=s.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role = ANY($2))
      ORDER BY s.created_at DESC, s.id LIMIT $3 OFFSET $4`, [user.id, READERS, i.limit, i.offset]),
});

cap({
  name: 'get_shared_coaching_report', method: 'GET', path: '/me/shared-coaching-reports/:id', tag: TAG, auth: 'user',
  summary: 'Read the frozen report version shared with your organisation. Checked live on every read: a revoked or expired share, or someone who is no longer an owner or admin, gets 404. Every read is audited.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await liveShareFor(user, i.id);
    await audit(null, user.id, 'read_shared_coaching_report', 'coaching_report_shares', s.id);
    return { id: s.id, organisation_name: s.organisation_name, version: s.version, expires_on: s.expires_on, note: s.note, snapshot: s.snapshot, published_at: s.published_at };
  },
});

cap({
  name: 'export_shared_coaching_report', method: 'GET', path: '/me/shared-coaching-reports/:id/export', tag: TAG, auth: 'user',
  summary: 'The shared report as a PDF (base64), under the same live checks as reading it. Audited.', input: z.object({ id }),
  async handler({ user }, i) {
    const s = await liveShareFor(user, i.id);
    const { buffer, pages } = await renderCoachingReport({ layout: starterFor('coaching_report', 'classic'), kit: null, logo: null, snapshot: s.snapshot, version: s.version });
    await audit(null, user.id, 'export_shared_coaching_report', 'coaching_report_shares', s.id);
    return { filename: `${s.title.replace(/[^\w.-]+/g, '_').slice(0, 80)}_v${s.version}.pdf`, content_type: 'application/pdf', encoding: 'base64', content: buffer.toString('base64'), pages };
  },
});
