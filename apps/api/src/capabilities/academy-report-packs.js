// Academy OS P2 / Gap 27 (#807): governed report packs. One capability set (REST + OpenAPI + MCP) over the EXISTING pack snapshots in academy-packs.js and the
// shared document stack: a pack is drafted (by a person or a schedule), reviewed by a different person, approved, issued as the encrypted PDF row in
// generated_documents, delivered through canonical notifications and, if needed, revoked. Draft and issued versions are immutable (DB trigger);
// a correction is a NEW version. Nothing here recalculates a figure: the snapshot functions the screens and PDFs already share produce them.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { orgFor } from '../org-access.js';
import { STAFF, STAFF_MONEY } from '../academy.js';
import { guardiansOf, isYouth } from '../youth.js';
import { notify } from '../notify.js';
import { pnl } from '../academy-finance.js';
import { starterFor } from '../documents/layout.js';
import { renderSectionDocument } from '../documents/render.js';
import { loadLogo } from './branded-documents.js';
import { KINDS, progressAccess, progressSnapshot, termSnapshot, managementSnapshot, financeSnapshot, campusSnapshot, issue, orgOf } from './academy-packs.js';

const TAG = 'Academy';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const kindEnum = z.enum(['progress', 'term', 'management', 'finance', 'campus']);
const ATHLETE_KINDS = ['progress', 'term'];
const NA = 'Not available';
/** Who may read the issued file and what every copy always leaves out: shown on the review screen and frozen with the pack. */
export const AUDIENCE = {
  progress: { readers: ['academy owner/admin', 'the athlete’s coach', 'the athlete', 'a verified guardian of a young athlete'], never: ['finance', 'clinical or welfare notes', 'coach-private notes', 'staff-private feedback'] },
  term: { readers: ['academy owner/admin', 'the athlete’s coach', 'the athlete', 'a verified guardian of a young athlete'], never: ['finance', 'clinical or welfare notes', 'coach-private notes', 'staff-private feedback', 'school grades'] },
  management: { readers: ['academy owner/admin'], never: ['legal detail', 'clinical detail', 'coach-private notes', 'counts under three'] },
  finance: { readers: ['academy owner/admin', 'academy finance'], never: ['coaching or clinical data', 'personal data'] },
  campus: { readers: ['academy owner/admin'], never: ['legal detail', 'clinical detail', 'coach-private notes', 'counts under three'] },
};
const BASIS_TEXT = {
  progress: 'Athlete-safe progress view: coach-observed assessments, academy attendance and approved official results, kept apart.',
  term: 'Athlete-safe progress view for the term plus attendance in the term and the school’s band where shared. Nothing is combined into one score.',
  management: 'Management view of the academy from the same figures as the Executive Home. Not statutory accounts.',
  finance: 'Management accounts from the finance ledger, approved payroll and confirmed venue bookings. Not statutory or audited accounts.',
  campus: 'Management view of one campus from the same figures as the Executive Home and P&L, filtered to its programmes.',
};

// ------------------------------------------------------------------ access
/** Who may DRAFT a pack: athlete reports by owner/admin or the athlete’s own coach, the money pack by owner/admin/finance, the rest by owner/admin. */
async function draftAccess(user, kind, orgId, subjectId) {
  if (ATHLETE_KINDS.includes(kind)) { const a = await progressAccess(user, orgId, subjectId); if (!a.staff) throw forbidden('Only academy staff can draft this report'); return; }
  await orgFor(user, orgId, kind === 'finance' ? STAFF_MONEY : STAFF);
}
/** Approving, issuing and revoking are for the academy’s owner or admin. */
const reviewerOf = (user, orgId) => orgFor(user, orgId, STAFF);
/** Can this person see the pack at all, and in full? Staff and the (still authorised) author see everything; an athlete or guardian sees only an issued/withdrawn athlete report. */
async function viewAccess(user, p) {
  const staff = await orgFor(user, p.organisation_id, p.kind === 'finance' ? STAFF_MONEY : STAFF).then(() => true, () => false);
  if (staff) return 'full';
  if (user.id === p.author_id && ATHLETE_KINDS.includes(p.kind)) { const a = await progressAccess(user, p.organisation_id, p.subject_id).then((r) => r, () => null); if (a?.staff) return 'full'; }
  if (ATHLETE_KINDS.includes(p.kind) && ['issued', 'revoked'].includes(p.status)) { const a = await progressAccess(user, p.organisation_id, p.subject_id).then((r) => r, () => null); if (a) return 'audience'; }
  throw notFound('Report');
}
const PACK_COLS = 'id, organisation_id, kind, subject_id, period_from::text AS period_from, period_to::text AS period_to, version, status, template_id, snapshot_sha, basis, evidence, gaps, audience, gaps_acknowledged, review_note, schedule_id, author_id, submitted_at, approved_by, approved_at, issued_by, issued_at, document_id, revoked_by, revoked_at, revoke_reason, supersedes_id, row_version, created_at';
const loadPack = async (orgId, packId, c = pool) => {
  const p = (await c.query(`SELECT ${PACK_COLS}, snapshot FROM academy_report_packs WHERE id=$1 AND organisation_id=$2`, [packId, orgId])).rows[0];
  if (!p) throw notFound('Report');
  return p;
};
const event = (c, packId, action, actorId, note = null, detail = {}) => c.query('INSERT INTO academy_report_pack_events(pack_id, action, actor_id, note, detail) VALUES ($1,$2,$3,$4,$5)', [packId, action, actorId, note, detail]);
const ROW = (p, mode) => {
  const { snapshot, ...r } = p;
  const url = p.document_id && p.status === 'issued' ? `/api/v1/branded-documents/${p.document_id}/file` : null;
  if (mode === 'audience') return { id: r.id, organisation_id: r.organisation_id, kind: r.kind, status: r.status, period_from: r.period_from, period_to: r.period_to, version: r.version, issued_at: r.issued_at, revoked_at: r.revoked_at, url, title: KINDS[r.kind].title };
  return { ...r, title: KINDS[r.kind].title, url };
};

// ------------------------------------------------------------------ building a draft: snapshot + basis + evidence + gaps
const stamp = async (key, sql, params) => { const r = await one(sql, params); return { key, rows: r.n, latest: r.latest ? new Date(r.latest).toISOString() : null }; };
async function evidenceFor(kind, orgId, subjectId, from, to, costSources) {
  const out = [];
  if (ATHLETE_KINDS.includes(kind)) {
    out.push(await stamp('pathway_decisions', 'SELECT count(*)::int AS n, max(created_at) AS latest FROM academy_progression_decisions WHERE organisation_id=$1 AND athlete_id=$2', [orgId, subjectId]));
    out.push(await stamp('assessments', "SELECT count(*)::int AS n, max(created_at) AS latest FROM academy_assessments WHERE organisation_id=$1 AND athlete_id=$2 AND status='approved'", [orgId, subjectId]));
    out.push(await stamp('attendance', 'SELECT count(*)::int AS n, max(a.session_date) AS latest FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id WHERE k.organisation_id=$1 AND a.user_id=$2 AND a.session_date BETWEEN $3 AND $4', [orgId, subjectId, from, to]));
  } else {
    out.push(await stamp('sessions', 'SELECT count(*)::int AS n, max(starts_at) AS latest FROM academy_sessions WHERE organisation_id=$1 AND starts_at >= $2::date AND starts_at < $3::date + 1', [orgId, from, to]));
    out.push(await stamp('attendance', 'SELECT count(*)::int AS n, max(a.session_date) AS latest FROM org_attendance a JOIN org_cohorts k ON k.id=a.cohort_id WHERE k.organisation_id=$1 AND a.session_date BETWEEN $2 AND $3', [orgId, from, to]));
    const p = costSources?.programmes ?? { charges: 0, payroll_lines: 0, venue_bookings: 0, cost_entries: 0 };
    out.push({ key: 'ledger_charges', rows: p.charges, latest: null }, { key: 'payroll_lines', rows: p.payroll_lines, latest: null }, { key: 'venue_bookings', rows: p.venue_bookings, latest: null }, { key: 'cost_entries', rows: p.cost_entries, latest: null });
  }
  return out;
}
/** Everything that could not be known, found in the frozen snapshot itself: "Not available" items plus the cost sources the ledger could not count. */
function gapsFrom(snapshot, cost) {
  const g = [];
  for (const s of snapshot.sections) {
    if (s.body === NA) g.push({ section: s.title, item: null, why: 'No data for this section' });
    if (s.title === 'Coaching material') g.push({ section: s.title, item: null, why: 'A guardian has not allowed coaching material to be shared' });
    for (const it of s.items ?? []) if (it.value === NA) g.push({ section: s.title, item: it.title, why: it.meta ?? 'Cannot be known from the recorded data' });
  }
  if (cost?.payroll_unpriced_timesheets) g.push({ section: 'Cost sources', item: 'Approved timesheets with no pay term', why: `${cost.payroll_unpriced_timesheets} timesheet(s): cost not counted` });
  if (cost?.venue_sessions_unbooked) g.push({ section: 'Cost sources', item: 'Sessions with no venue booking', why: `${cost.venue_sessions_unbooked} session(s): venue cost not counted` });
  return g;
}
async function build(user, kind, orgId, subjectId, from, to) {
  let snapshot, cost = null, cs = null;
  if (kind === 'progress') snapshot = await progressSnapshot(orgId, subjectId);
  else if (kind === 'term') snapshot = await termSnapshot(orgId, subjectId, from, to, user);
  else if (kind === 'campus') { snapshot = await campusSnapshot(orgId, subjectId, from, to); cost = snapshot._cost_sources; }
  else if (kind === 'finance') { snapshot = await financeSnapshot(orgId, from, to); }
  else { const { role } = await orgFor(user, orgId, STAFF); snapshot = await managementSnapshot(orgId, role, from, to); }
  if (kind === 'finance' || kind === 'management') cost = (await pnl(orgId, { from, to })).cost_sources;
  if (cost) { const pn = await pnl(orgId, { from, to, branchId: kind === 'campus' ? subjectId : undefined }); const sum = { charges: 0, payroll_lines: 0, venue_bookings: 0, cost_entries: 0 }; for (const c of pn.currencies) for (const r of c.programmes) for (const k of Object.keys(sum)) sum[k] += r.sources?.[k] ?? 0; cs = { programmes: sum }; }
  const { _gaps, _cost_sources, ...clean } = snapshot;
  const gaps = [...(_gaps ?? []).map((w) => ({ section: 'Campus', item: null, why: w })), ...gapsFrom(clean, cost)];
  const org = await orgOf(orgId);
  const currencies = [...new Set(clean.sections.map((s) => /\(([A-Z]{3})\)/.exec(s.title)?.[1]).filter(Boolean))];
  const basis = { period: { from, to }, as_of: new Date().toISOString(), basis: BASIS_TEXT[kind], currencies, issuer: org.name, legal_name: org.legal_name ?? null, reference: clean.reference };
  return { snapshot: clean, gaps, basis, evidence: await evidenceFor(kind, orgId, subjectId, from, to, cs), audience: AUDIENCE[kind] };
}
const stableSha = (snapshot) => { const { issued_at: _t, ...stable } = snapshot; return createHash('sha256').update(JSON.stringify(stable)).digest('hex'); };
const range = (from, to) => { if (to < from) throw badRequest('The end date is before the start date'); if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw badRequest('Choose a period of at most 13 months'); };
async function subjectFor(kind, orgId, subjectId) {
  if (kind === 'campus') { if (!subjectId || !(await one('SELECT 1 FROM academy_branches WHERE id=$1 AND organisation_id=$2', [subjectId, orgId]))) throw notFound('Branch'); return subjectId; }
  if (ATHLETE_KINDS.includes(kind)) { if (!subjectId) throw badRequest('Choose the athlete'); return subjectId; }
  return orgId;
}

/** Draft a pack (a person or the scheduler). Identical content for the same subject and period is the same open pack, never a second copy. */
export async function draftPack(user, orgId, { kind, subject_id, from, to, template_id, schedule_id = null }) {
  await draftAccess(user, kind, orgId, ATHLETE_KINDS.includes(kind) ? subject_id : null);
  const subject = await subjectFor(kind, orgId, subject_id);
  const f = from ?? daysAgo(kind === 'term' ? 120 : 90), t = to ?? today();
  range(f, t);
  if (template_id) {
    const tp = await one('SELECT family, organisation_id, status, archived_at FROM document_templates WHERE id=$1', [template_id]);
    if (!tp || tp.organisation_id !== orgId || tp.family !== KINDS[kind].family) throw badRequest(`Pick one of this academy's ${KINDS[kind].family.replace(/_/g, ' ')} templates`);
    if (tp.status === 'retired' || tp.archived_at) throw conflict('That template is retired');
  }
  const b = await build(user, kind, orgId, subject, f, t);
  const sha = stableSha(b.snapshot);
  const dup = await one("SELECT id FROM academy_report_packs WHERE organisation_id=$1 AND kind=$2 AND subject_id=$3 AND period_from=$4 AND period_to=$5 AND snapshot_sha=$6 AND status IN ('draft','in_review','approved') ORDER BY created_at DESC LIMIT 1", [orgId, kind, subject, f, t, sha]);
  if (dup) return { ...ROW(await loadPack(orgId, dup.id), 'full'), duplicate: true };
  const prev = await one("SELECT id, version, status FROM academy_report_packs WHERE organisation_id=$1 AND kind=$2 AND subject_id=$3 AND period_from=$4 AND period_to=$5 ORDER BY version DESC LIMIT 1", [orgId, kind, subject, f, t]);
  const row = await tx(async (c) => {
    if (prev && ['draft', 'in_review', 'approved'].includes(prev.status)) { await c.query("UPDATE academy_report_packs SET status='superseded', row_version=row_version+1 WHERE id=$1", [prev.id]); await event(c, prev.id, 'superseded', user.id); }
    const r = (await c.query(
      `INSERT INTO academy_report_packs(organisation_id, kind, subject_id, period_from, period_to, version, template_id, snapshot, snapshot_sha, basis, evidence, gaps, audience, schedule_id, author_id, supersedes_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [orgId, kind, subject, f, t, (prev?.version ?? 0) + 1, template_id ?? null, b.snapshot, sha, b.basis, JSON.stringify(b.evidence), JSON.stringify(b.gaps), b.audience, schedule_id, user.id, prev?.id ?? null])).rows[0];
    await event(c, r.id, schedule_id ? 'drafted_by_schedule' : 'drafted', schedule_id ? null : user.id, null, { version: (prev?.version ?? 0) + 1, gaps: b.gaps.length });
    return r;
  });
  await audit(null, user.id, 'draft_academy_report_pack', 'academy_report_packs', row.id);
  return ROW(await loadPack(orgId, row.id), 'full');
}

cap({
  name: 'create_academy_report_pack', method: 'POST', path: '/organisations/:id/academy/report-packs', tag: TAG, status: 201,
  summary: 'Draft a branded academy report pack for review: kind progress (development/assessment report) or term (athlete; owner/admin or the athlete’s coach), management or campus (owner/admin; campus needs a branch), finance (owner/admin/finance). The figures are frozen into an immutable snapshot with its data basis, evidence versions, gaps and audience. Nothing is visible to the athlete or guardian until a different person approves it and it is issued. Identical content returns the same open draft (duplicate:true).',
  input: z.object({ id, kind: kindEnum, subject_id: id.optional().describe('athlete (progress, term) or branch (campus)'), from: day.optional(), to: day.optional(), template_id: id.optional() }),
  async handler({ user }, i) { requireApproved(user); return draftPack(user, i.id, i); },
});

cap({
  name: 'new_academy_report_pack_version', method: 'POST', path: '/organisations/:id/academy/report-packs/:pack_id/new-version', tag: TAG, status: 201,
  summary: 'Rebuild a pack from today’s records as the next version (a draft, in-review or approved pack is superseded; an issued pack stays issued until you revoke it). The old version is never changed.',
  input: z.object({ id, pack_id: id }),
  async handler({ user }, i) {
    requireApproved(user);
    const p = await loadPack(i.id, i.pack_id);
    await viewAccess(user, p).then((m) => m === 'full' || Promise.reject(notFound('Report')));
    if (p.status === 'revoked' || p.status === 'superseded') throw conflict('Start from the latest version of this report');
    const r = await draftPack(user, i.id, { kind: p.kind, subject_id: p.subject_id, from: p.period_from, to: p.period_to, template_id: p.template_id ?? undefined });
    return r;
  },
});

cap({
  name: 'list_academy_report_packs', method: 'GET', path: '/organisations/:id/academy/report-packs', tag: TAG,
  summary: 'The academy’s report packs, newest first, filtered by status or kind. Owner/admin see all; finance only the finance pack; a coach only the athlete reports they drafted. Snapshots are not included (open one to see it).',
  input: z.object({ id, status: z.enum(['draft', 'in_review', 'approved', 'issued', 'revoked', 'superseded']).optional(), kind: kindEnum.optional(), subject_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const m = await orgFor(user, i.id, ['owner', 'admin', 'finance', 'coach']);
    const kinds = STAFF.includes(m.role) ? null : m.role === 'finance' ? ['finance'] : ATHLETE_KINDS;
    const rows = await many(`SELECT ${PACK_COLS} FROM academy_report_packs WHERE organisation_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR kind=$3) AND ($4::uuid IS NULL OR subject_id=$4) AND ($5::text[] IS NULL OR kind = ANY($5)) AND ($6::uuid IS NULL OR author_id=$6)
      ORDER BY created_at DESC, id LIMIT $7 OFFSET $8`, [i.id, i.status ?? null, i.kind ?? null, i.subject_id ?? null, kinds, m.role === 'coach' ? user.id : null, i.limit, i.offset]);
    return rows.map((r) => ROW(r, 'full'));
  },
});

cap({
  name: 'get_academy_report_pack', method: 'GET', path: '/organisations/:id/academy/report-packs/:pack_id', tag: TAG,
  summary: 'One report pack with its frozen content, data basis, evidence versions, gaps, audience and full history (staff and the drafting coach). The athlete or verified guardian of an issued athlete report gets only its status and secure download link. Everyone else gets 404.',
  input: z.object({ id, pack_id: id }),
  async handler({ user }, i) {
    const p = await loadPack(i.id, i.pack_id);
    const mode = await viewAccess(user, p);
    if (mode === 'audience') return ROW(p, 'audience');
    const events = await many('SELECT e.id, e.action, e.actor_id, u.display_name AS actor_name, e.note, e.detail, e.created_at FROM academy_report_pack_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.pack_id=$1 ORDER BY e.created_at, e.id', [p.id]);
    const subject = ATHLETE_KINDS.includes(p.kind) ? (await one('SELECT display_name FROM users WHERE id=$1', [p.subject_id]))?.display_name : p.kind === 'campus' ? (await one('SELECT name FROM academy_branches WHERE id=$1', [p.subject_id]))?.name : null;
    await audit(null, user.id, 'read_academy_report_pack', 'academy_report_packs', p.id);
    return { ...ROW(p, 'full'), subject_name: subject ?? null, snapshot: p.snapshot, events };
  },
});

cap({
  name: 'submit_academy_report_pack', method: 'POST', path: '/organisations/:id/academy/report-packs/:pack_id/submit', tag: TAG,
  summary: 'Send a draft to review. Only a draft can be submitted; its content does not change.',
  input: z.object({ id, pack_id: id }),
  async handler({ user }, i) {
    requireApproved(user);
    const p = await loadPack(i.id, i.pack_id);
    if ((await viewAccess(user, p)) !== 'full') throw notFound('Report');
    const r = await tx(async (c) => {
      const u = (await c.query("UPDATE academy_report_packs SET status='in_review', submitted_at=now(), review_note=NULL, row_version=row_version+1 WHERE id=$1 AND status='draft' RETURNING id", [p.id])).rows[0];
      if (!u) throw conflict('Only a draft can be sent to review');
      await event(c, p.id, 'submitted', user.id);
      const reviewers = (await c.query("SELECT DISTINCT user_id FROM organisation_members WHERE organisation_id=$1 AND role IN ('owner','admin') AND status='active' AND user_id<>$2", [i.id, user.id])).rows;
      for (const r of reviewers) await notify(c, r.user_id, { kind: 'academy_report', title: 'A report is waiting for your review', body: 'Open Academy, then Reports, to review it. Figures are not included in this message.', data: { organisation_id: i.id, pack_id: p.id }, dedupe_key: `pack-review:${p.id}:${r.user_id}` });
      return u;
    });
    await audit(null, user.id, 'submit_academy_report_pack', 'academy_report_packs', r.id);
    return ROW(await loadPack(i.id, p.id), 'full');
  },
});

cap({
  name: 'review_academy_report_pack', method: 'POST', path: '/organisations/:id/academy/report-packs/:pack_id/review', tag: TAG,
  summary: 'Approve or send back a pack that is in review (owner/admin, never the person who drafted it). Approving a pack that has gaps needs acknowledge_gaps:true. Sending back needs a note and returns it to draft.',
  input: z.object({ id, pack_id: id, decision: z.enum(['approve', 'request_changes']), note: z.string().trim().max(500).optional(), acknowledge_gaps: z.boolean().optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    await reviewerOf(user, i.id);
    const p = await loadPack(i.id, i.pack_id);
    if (p.author_id === user.id) throw forbidden('A report must be approved by someone other than the person who drafted it');
    if (i.decision === 'request_changes' && !i.note) throw badRequest('Say what needs to change');
    if (i.decision === 'approve' && p.gaps.length && !i.acknowledge_gaps) throw badRequest(`This report has ${p.gaps.length} gap(s). Acknowledge them to approve`);
    await tx(async (c) => {
      const sql = i.decision === 'approve'
        ? "UPDATE academy_report_packs SET status='approved', approved_by=$2, approved_at=now(), gaps_acknowledged=$3, review_note=$4, row_version=row_version+1 WHERE id=$1 AND status='in_review' RETURNING id"
        : "UPDATE academy_report_packs SET status='draft', review_note=$4, submitted_at=NULL, row_version=row_version+1 WHERE id=$1 AND status='in_review' AND $2::uuid IS NOT NULL AND $3::boolean IS NOT NULL RETURNING id";
      const u = (await c.query(sql, [p.id, user.id, !!i.acknowledge_gaps, i.note ?? null])).rows[0];
      if (!u) throw conflict('Only a report in review can be decided');
      await event(c, p.id, i.decision === 'approve' ? 'approved' : 'changes_requested', user.id, i.note ?? null, i.decision === 'approve' ? { gaps_acknowledged: p.gaps.length > 0 } : {});
      if (i.decision === 'request_changes') await notify(c, p.author_id, { kind: 'academy_report', title: 'A report needs changes', body: 'Open Academy, then Reports, for the reviewer’s note.', data: { organisation_id: i.id, pack_id: p.id }, dedupe_key: `pack-changes:${p.id}:${p.row_version}` });
    });
    await audit(null, user.id, `${i.decision}_academy_report_pack`, 'academy_report_packs', p.id);
    return ROW(await loadPack(i.id, p.id), 'full');
  },
});

/** Who is told about an issued or withdrawn athlete report: the verified guardians of a young athlete, otherwise the athlete. Never anyone else. */
const recipientsOf = async (p) => (!ATHLETE_KINDS.includes(p.kind) ? [] : (await isYouth(p.subject_id)) ? await guardiansOf(p.subject_id) : [p.subject_id]);

cap({
  name: 'issue_academy_report_pack', method: 'POST', path: '/organisations/:id/academy/report-packs/:pack_id/issue', tag: TAG, status: 201,
  summary: 'Issue an approved pack: renders the frozen snapshot as the branded PDF through the shared document stack (encrypted, hashed, append-only), records the issuer, and for an athlete report notifies the verified guardian (or the adult athlete) without any figures in the message. Only an approved pack can be issued, once.',
  input: z.object({ id, pack_id: id }),
  async handler({ user }, i) {
    requireApproved(user);
    await reviewerOf(user, i.id);
    const p = await loadPack(i.id, i.pack_id);
    if (p.status !== 'approved') throw conflict('Only an approved report can be issued');
    const snapshot = { ...p.snapshot, issued_at: new Date().toISOString() };
    const doc = await issue(user, p.kind, i.id, p.kind === 'management' || p.kind === 'finance' || p.kind === 'campus' ? i.id : p.subject_id, snapshot, p.template_id ?? undefined, { fresh: true });
    const to = await recipientsOf(p);
    await tx(async (c) => {
      const u = (await c.query("UPDATE academy_report_packs SET status='issued', issued_by=$2, issued_at=now(), document_id=$3, row_version=row_version+1 WHERE id=$1 AND status='approved' RETURNING id", [p.id, user.id, doc.id])).rows[0];
      if (!u) throw conflict('This report was already issued');
      await event(c, p.id, 'issued', user.id, null, { document_id: doc.id, sha256: doc.sha256, pages: doc.pages });
      for (const uid of to) await notify(c, uid, { kind: 'academy_report', title: 'A new academy report is ready', body: 'Open GotMyGame to read it. The report is not included in this message.', data: { organisation_id: i.id, pack_id: p.id }, dedupe_key: `pack-issued:${p.id}:${uid}` });
      if (to.length) await event(c, p.id, 'delivered', null, null, { recipients: to.length, channel: 'in_app_notification' });
    });
    await audit(null, user.id, 'issue_academy_report_pack', 'academy_report_packs', p.id);
    return ROW(await loadPack(i.id, p.id), 'full');
  },
});

cap({
  name: 'revoke_academy_report_pack', method: 'POST', path: '/organisations/:id/academy/report-packs/:pack_id/revoke', tag: TAG,
  summary: 'Withdraw an issued pack (owner/admin) with a reason. The file stops opening at once for the athlete, guardian and coach (owner/admin keep it for the record); history is kept and the recipients are told it was withdrawn.',
  input: z.object({ id, pack_id: id, reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    requireApproved(user);
    await reviewerOf(user, i.id);
    const p = await loadPack(i.id, i.pack_id);
    const to = await recipientsOf(p);
    await tx(async (c) => {
      const u = (await c.query("UPDATE academy_report_packs SET status='revoked', revoked_by=$2, revoked_at=now(), revoke_reason=$3, row_version=row_version+1 WHERE id=$1 AND status='issued' RETURNING id", [p.id, user.id, i.reason])).rows[0];
      if (!u) throw conflict('Only an issued report can be revoked');
      await event(c, p.id, 'revoked', user.id, i.reason);
      for (const uid of to) await notify(c, uid, { kind: 'academy_report', title: 'An academy report was withdrawn', body: 'Open GotMyGame for details. The file can no longer be opened.', data: { organisation_id: i.id, pack_id: p.id }, dedupe_key: `pack-revoked:${p.id}:${uid}` });
    });
    await audit(null, user.id, 'revoke_academy_report_pack', 'academy_report_packs', p.id);
    return ROW(await loadPack(i.id, p.id), 'full');
  },
});

cap({
  name: 'list_my_academy_reports', method: 'GET', path: '/academy/reports', tag: TAG,
  summary: 'Issued (and withdrawn) academy athlete reports for yourself or, as a verified guardian, for a young athlete: title, period, status and a secure download link. Only issued athlete reports appear; finance, management and anything in draft never do.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    if (athlete !== user.id) { const { requireGuardian } = await import('../youth.js'); await requireGuardian(user, athlete).catch(() => { throw notFound('Athlete'); }); }
    const rows = await many(`SELECT ${PACK_COLS} FROM academy_report_packs WHERE subject_id=$1 AND kind IN ('progress','term') AND status IN ('issued','revoked') ORDER BY issued_at DESC NULLS LAST, id LIMIT $2 OFFSET $3`, [athlete, i.limit, i.offset]);
    await audit(null, user.id, 'list_my_academy_reports', 'users', athlete);
    return rows.map((r) => ROW(r, 'audience'));
  },
});

// ------------------------------------------------------------------ schedules: the scheduler only ever makes DRAFTS
const scopeSchema = z.object({ cohort_id: id.optional(), branch_id: id.optional() }).strict();
async function checkScope(orgId, kind, scope) {
  if (ATHLETE_KINDS.includes(kind)) { if (!scope.cohort_id || !(await one('SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2', [scope.cohort_id, orgId]))) throw badRequest('Choose the group this schedule is for'); return { cohort_id: scope.cohort_id }; }
  if (kind === 'campus') { if (!scope.branch_id || !(await one('SELECT 1 FROM academy_branches WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [scope.branch_id, orgId]))) throw badRequest('Choose the campus this schedule is for'); return { branch_id: scope.branch_id }; }
  return {};
}
const SCHED_COLS = 'id, organisation_id, kind, cadence, scope, lookback_days, template_id, next_run_on::text AS next_run_on, last_run_on::text AS last_run_on, paused_at, archived_at, created_by, row_version, created_at';
cap({
  name: 'create_academy_report_schedule', method: 'POST', path: '/organisations/:id/academy/report-schedules', tag: TAG, status: 201,
  summary: 'Schedule recurring DRAFTS of a pack (weekly, monthly or quarterly; for a group of athletes or one campus). The scheduler only creates drafts under your live authority and notifies the reviewers; a different person must still approve and issue every report. A person who loses their role stops producing drafts.',
  input: z.object({ id, kind: kindEnum, cadence: z.enum(['weekly', 'monthly', 'quarterly']), scope: scopeSchema.default({}), lookback_days: z.number().int().min(7).max(400).default(90), template_id: id.optional(), first_run_on: day.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    await draftAccess(user, i.kind, i.id, null).catch(async (e) => { if (!ATHLETE_KINDS.includes(i.kind)) throw e; await orgFor(user, i.id, STAFF); });
    const scope = await checkScope(i.id, i.kind, i.scope);
    if (i.template_id) { const t = await one('SELECT family, organisation_id FROM document_templates WHERE id=$1', [i.template_id]); if (!t || t.organisation_id !== i.id || t.family !== KINDS[i.kind].family) throw badRequest('Pick one of this academy’s templates for this report'); }
    const r = await one(`INSERT INTO academy_report_schedules(organisation_id, kind, cadence, scope, lookback_days, template_id, next_run_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${SCHED_COLS}`, [i.id, i.kind, i.cadence, scope, i.lookback_days, i.template_id ?? null, i.first_run_on ?? today(), user.id]);
    await audit(null, user.id, 'create_academy_report_schedule', 'academy_report_schedules', r.id);
    return r;
  },
});
cap({
  name: 'list_academy_report_schedules', method: 'GET', path: '/organisations/:id/academy/report-schedules', tag: TAG,
  summary: 'Recurring report schedules for this academy (owner/admin; finance sees the finance schedules).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, STAFF_MONEY);
    return many(`SELECT ${SCHED_COLS} FROM academy_report_schedules WHERE organisation_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR kind=$2) ORDER BY next_run_on, id LIMIT $3 OFFSET $4`, [i.id, role === 'finance' ? 'finance' : null, i.limit, i.offset]);
  },
});
cap({
  name: 'update_academy_report_schedule', method: 'PATCH', path: '/organisations/:id/academy/report-schedules/:schedule_id', tag: TAG,
  summary: 'Pause, resume, archive or change the cadence of a schedule (optimistic: send the row_version you read). Schedules are archived, never deleted; drafts already made are kept.',
  input: z.object({ id, schedule_id: id, row_version: z.number().int(), paused: z.boolean().optional(), archived: z.boolean().optional(), cadence: z.enum(['weekly', 'monthly', 'quarterly']).optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const s = await one('SELECT * FROM academy_report_schedules WHERE id=$1 AND organisation_id=$2', [i.schedule_id, i.id]);
    if (!s) throw notFound('Schedule');
    await orgFor(user, i.id, s.kind === 'finance' ? STAFF_MONEY : STAFF);
    const r = await one(`UPDATE academy_report_schedules SET paused_at = CASE WHEN $3::boolean IS NULL THEN paused_at WHEN $3 THEN coalesce(paused_at, now()) ELSE NULL END, archived_at = CASE WHEN $4::boolean IS TRUE THEN coalesce(archived_at, now()) ELSE archived_at END,
        cadence = coalesce($5, cadence), row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING ${SCHED_COLS}`, [s.id, i.row_version, i.paused ?? null, i.archived ?? null, i.cadence ?? null]);
    if (!r) throw conflict('This schedule changed since you opened it. Reload and try again');
    await audit(null, user.id, 'update_academy_report_schedule', 'academy_report_schedules', s.id);
    return r;
  },
});

cap({
  name: 'get_academy_report_hub', method: 'GET', path: '/organisations/:id/academy/report-hub', tag: TAG,
  summary: 'The Reports & packs overview: the five pack kinds with whether you may draft each, how many templates the academy has published for each, and the review figures (awaiting review, overdue, issued in the last 90 days, scheduled, revoked) for the packs you may see.',
  input: z.object({ id }),
  async handler({ user, ...rest }, i) {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'finance', 'coach']);
    const staff = STAFF.includes(role);
    const mayKinds = staff ? Object.keys(KINDS) : role === 'finance' ? ['finance'] : ATHLETE_KINDS;
    const tpl = Object.fromEntries((await many("SELECT family, count(*)::int AS n FROM document_templates WHERE organisation_id=$1 AND archived_at IS NULL AND status <> 'retired' AND family = ANY($2) GROUP BY 1", [i.id, Object.values(KINDS).map((k) => k.family)])).map((r) => [r.family, r.n]));
    const k = await one(`SELECT count(*) FILTER (WHERE status='in_review')::int AS awaiting_review, count(*) FILTER (WHERE status='in_review' AND submitted_at < now() - interval '3 days')::int AS overdue,
        count(*) FILTER (WHERE status='issued' AND issued_at > now() - interval '90 days')::int AS issued_90d, count(*) FILTER (WHERE status='revoked')::int AS revoked, count(*) FILTER (WHERE status IN ('draft','approved'))::int AS open_drafts
      FROM academy_report_packs WHERE organisation_id=$1 AND kind = ANY($2) AND ($3::uuid IS NULL OR author_id=$3)`, [i.id, mayKinds, role === 'coach' ? user.id : null]);
    const sc = staff || role === 'finance' ? await one("SELECT count(*)::int AS n, min(next_run_on)::text AS next FROM academy_report_schedules WHERE organisation_id=$1 AND archived_at IS NULL AND paused_at IS NULL AND ($2::text IS NULL OR kind=$2)", [i.id, role === 'finance' ? 'finance' : null]) : { n: 0, next: null };
    return { my_role: role, can_review: staff, kinds: Object.entries(KINDS).map(([kind, v]) => ({ kind, title: v.title, family: v.family, can_draft: mayKinds.includes(kind), scope: ATHLETE_KINDS.includes(kind) ? 'athlete' : kind === 'campus' ? 'campus' : 'academy', templates: tpl[v.family] ?? 0, audience: AUDIENCE[kind] })), figures: { ...k, scheduled: sc.n, next_scheduled_on: sc.next } };
  },
});

/** The draft preview PDF: the frozen snapshot on the same renderer, stamped DRAFT, never stored. Staff and the drafting coach only; every download is audit-logged. */
export async function draftPdf(user, packId) {
  const p = (await one(`SELECT ${PACK_COLS}, snapshot FROM academy_report_packs WHERE id=$1`, [packId]));
  if (!p) throw notFound('Report');
  if ((await viewAccess(user, p)) !== 'full') throw notFound('Report');
  const ver = p.template_id ? await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [p.template_id]) : null;
  const snapshot = { ...p.snapshot, title: p.status === 'issued' ? p.snapshot.title : `${p.snapshot.title} (DRAFT v${p.version})`, issued_at: new Date().toISOString() };
  const { buffer } = await renderSectionDocument({ layout: ver ? ver.layout : starterFor(KINDS[p.kind].family, 'classic'), kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot });
  await audit(null, user.id, 'preview_academy_report_pack', 'academy_report_packs', p.id);
  return buffer;
}

cap({
  name: 'search_academy_report_subjects', method: 'GET', path: '/organisations/:id/academy/report-subjects', tag: TAG,
  summary: 'Search-and-pick source for the report forms: athletes enrolled in an academy programme (a coach only sees their own groups), the academy’s groups (cohorts) and its campuses (branches). Returns { value, label, sub } options.',
  input: z.object({ id, what: z.enum(['athlete', 'cohort', 'branch']), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(25) }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    const like = `%${(i.q ?? '').replace(/[%_\\]/g, '\\$&')}%`;
    if (i.what === 'branch') { if (role === 'coach') return []; return many("SELECT id AS value, name AS label, city AS sub FROM academy_branches WHERE organisation_id=$1 AND archived_at IS NULL AND name ILIKE $2 ORDER BY name LIMIT $3", [i.id, like, i.limit]); }
    if (i.what === 'cohort') return many("SELECT k.id AS value, k.name AS label, p.title AS sub FROM org_cohorts k LEFT JOIN academy_programmes p ON p.id=k.programme_id WHERE k.organisation_id=$1 AND k.status='active' AND k.name ILIKE $2 AND ($4::uuid IS NULL OR k.coach_id=$4) ORDER BY k.name LIMIT $3", [i.id, like, i.limit, role === 'coach' ? user.id : null]);
    return many(`SELECT DISTINCT ON (u.display_name, u.id) u.id AS value, u.display_name AS label, k.name AS sub FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id
      WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.status IN ('enrolled','paused','completed','graduated') AND u.display_name ILIKE $2 AND ($4::uuid IS NULL OR k.coach_id=$4) ORDER BY u.display_name, u.id LIMIT $3`, [i.id, like, i.limit, role === 'coach' ? user.id : null]);
  },
});
