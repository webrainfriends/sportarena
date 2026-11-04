// Academy OS 3/3 close-out: branded PDF packs (athlete progress report, management review, finance pack) on the SHARED document stack (templates,
// brand kits, encrypted storage, append-only generated_documents, live-checked audited download). Nothing new is stored but the PDF and its hash:
// every figure is read from the same functions the screens use (athlete-safe progress, executive home, P&L and receivables), frozen into a snapshot
// at issue time. No coach-private note, clinical record, legal strategy or contact detail is ever printed, and nothing is sent anywhere.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { saveEncrypted } from '../doc-store.js';
import { orgFor } from '../org-access.js';
import { requireGuardian } from '../youth.js';
import { toMajor } from '../currency.js';
import { STAFF, STAFF_MONEY } from '../academy.js';
import { starterFor } from '../documents/layout.js';
import { renderSectionDocument } from '../documents/render.js';
import { pnl, ageing, DEFINITIONS } from '../academy-finance.js';
import { officialEvidence } from '../academy-outcomes.js';
import { loadLogo, mustAccess } from './branded-documents.js';
import { progressFor } from './academy-pathways.js';
import { executiveHome } from './academy-executive.js';

const TAG = 'Academy';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const ds = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** The three packs. `type` prefixes generated_documents.source_type, which carries the academy so the download can re-check access live. */
const KINDS = {
  progress: { family: 'academy_progress_report', type: 'academy_progress', title: 'Academy progress report' },
  management: { family: 'academy_management_review', type: 'academy_management', title: 'Academy management review' },
  finance: { family: 'academy_finance_pack', type: 'academy_finance', title: 'Academy finance pack' },
};
const NA = 'Not available';
const money = (m, cur) => (m == null ? NA : `${cur} ${toMajor(Number(m), cur)}`);
const pct = (v) => (v == null ? NA : `${v}%`);
const num = (v) => (v == null ? NA : String(v));
/** Cohorts under three are never printed as a number: a small group could identify a young person. */
const safeCount = (n) => (n == null ? NA : n < 3 ? 'fewer than 3' : String(n));

// ------------------------------------------------------------------ access (also used, live, by every download)
async function inCoachScope(orgId, athleteId, coachId) {
  return !!(await one("SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused','completed','graduated') LIMIT 1", [orgId, athleteId, coachId]));
}
/** Owner/admin of the academy, the coach of that athlete, the athlete themself, or the verified guardian of a young athlete. 404 for anyone else. */
async function progressAccess(user, orgId, athleteId) {
  const enrolled = await one('SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.programme_id IS NOT NULL LIMIT 1', [orgId, athleteId]);
  if (!enrolled) throw notFound('Athlete');
  const staff = await orgFor(user, orgId, [...STAFF, 'coach']).then((r) => r, () => null);
  if (staff) {
    if (staff.role === 'coach' && !(await inCoachScope(orgId, athleteId, user.id))) throw notFound('Athlete');
    return { staff: true };
  }
  if (user.id !== athleteId) await requireGuardian(user, athleteId).catch(() => { throw notFound('Athlete'); });
  return { staff: false };
}
const TYPES = Object.fromEntries(Object.values(KINDS).map((k) => [k.type, k]));
/** Live check for the shared download route (a removed coach, revoked guardian or lapsed role loses access at once). */
export async function canReadAcademyPack(user, sourceType, sourceId) {
  const [type, orgId] = sourceType.split(':');
  try {
    if (type === KINDS.progress.type) await progressAccess(user, orgId, sourceId);
    else if (type === KINDS.management.type) await orgFor(user, orgId, STAFF);
    else if (type === KINDS.finance.type) await orgFor(user, orgId, STAFF_MONEY);
    else throw notFound('Document');
  } catch { throw notFound('Document'); }
}
export const isAcademyPackType = (t) => Object.hasOwn(TYPES, String(t).split(':')[0]);

// ------------------------------------------------------------------ snapshots (what the PDF says, frozen at issue)
const frame = (kind, org, extra) => ({ title: KINDS[kind].title, organisation: org.name, legal_name: org.legal_name ?? null, address: org.billing_address ?? null, issued_at: new Date().toISOString(), ...extra });
const orgOf = (orgId) => one('SELECT o.name, ap.legal_name, ap.billing_address FROM organisations o LEFT JOIN academy_profiles ap ON ap.organisation_id=o.id WHERE o.id=$1', [orgId]);
const LABEL = {
  decision: { place: 'Placed on the pathway', remain: 'Stays at this level', promote: 'Promoted', move_programme: 'Moved programme', invite_squad: 'Invited to a squad', reassess: 'Reassessment recommended', graduate: 'Graduated', pause: 'Progression paused' },
  outcome: { pending: 'Pending', criteria_met: 'Criteria met', criteria_partly_met: 'Criteria partly met', criteria_not_met: 'Criteria not yet met' },
};

export async function progressSnapshot(orgId, athleteId) {
  const org = await orgOf(orgId);
  const athlete = await one('SELECT display_name FROM users WHERE id=$1', [athleteId]);
  const pr = await progressFor(athleteId, { onlyOrgId: orgId });
  const a = pr.academies[0];
  if (!a) throw conflict('There is no academy progress to report yet');
  const sections = [{ title: 'Athlete', items: [{ title: 'Athlete', value: athlete.display_name }, { title: 'Academy', value: org.name }, { title: 'Prepared', value: today() }] }];
  for (const p of a.pathways) {
    sections.push({ title: `Pathway: ${p.title}`, items: [
      { title: 'Current level', value: p.graduated ? 'Graduated' : p.level_title ?? p.level ?? 'Not yet placed' },
      { title: 'Next level', value: p.next_level ?? 'None - this is the final level' },
      { title: 'Next review', value: p.next_review_on ?? NA, meta: 'About 90 days after the latest assessment or decision' },
      ...(p.destinations?.length ? [{ title: 'Where it can lead', value: p.destinations.map((d) => d.label).join(' · ') }] : []),
    ] });
    if (p.decisions.length) sections.push({ title: `Decisions: ${p.title}`, items: p.decisions.map((d) => ({ title: `${ds(d.created_at)} · ${LABEL.decision[d.decision] ?? d.decision}`, value: d.from_level || d.to_level ? `${d.from_level ?? '-'} to ${d.to_level ?? '-'}` : '', meta: `Decided by academy staff. Reason: ${d.reason}` })) });
    if (p.assessments.length) sections.push({ title: `Assessments: ${p.title}`, items: p.assessments.map((x) => ({ title: `${x.level_key} · ${ds(x.period_from)} to ${ds(x.period_to)}`, value: LABEL.outcome[x.outcome] ?? x.outcome, meta: x.comment ? `Assessor comment: ${x.comment}` : 'Coach-observed evidence. Private coach notes are not included.' })) });
  }
  if (pr.is_youth && !pr.coaching_consent) sections.push({ title: 'Coaching material', body: 'Assessment details are not shown because a guardian has not allowed coaching material to be shared.' });
  sections.push({ title: 'Attendance', body: a.attendance_pct_8w == null ? 'Not enough attendance has been recorded in the last 8 weeks.' : `${a.attendance_pct_8w}% attendance over the last 8 weeks.`, items: a.attendance_weeks.map((w) => ({ title: `Week of ${ds(w.week)}`, value: `${w.present} present · ${w.absent} absent` })) });
  const off = await officialEvidence(athleteId, daysAgo(365), today());
  sections.push({ title: 'Official competition results', body: 'Approved competition results only, kept apart from coaching assessments.', items: off.results.length ? off.results.map((r) => ({ title: `${r.sport} · ${r.metric}`, value: `average ${r.avg_value} over ${r.n} result${r.n === 1 ? '' : 's'}`, meta: 'Official, last 12 months' })) : [{ title: 'No approved results in the last 12 months', value: '' }] });
  sections.push({ title: 'About this report', body: 'Coaching assessments are coach-observed. Attendance is recorded by the academy. Official results come from approved competitions. They are shown side by side and never combined into one score. Coaches\' private notes, health information and fees are never included.' });
  return frame('progress', org, { addressee: pr.is_youth ? `Parent / guardian of ${athlete.display_name}` : athlete.display_name, reference: `PRG-${athleteId.replace(/-/g, '').slice(0, 8).toUpperCase()}`, sections });
}

export async function managementSnapshot(orgId, role, from, to) {
  const org = await orgOf(orgId);
  const h = await executiveHome(orgId, role, { from, to });
  const sections = [{ title: 'Period', items: [{ title: 'From', value: from }, { title: 'To', value: to }, { title: 'Basis', value: h.finance?.basis?.revenue ?? DEFINITIONS.basis }] }];
  if (h.people) sections.push({ title: 'People and demand', items: [
    { title: 'Active athletes', value: num(h.people.enrolled_athletes) }, { title: 'New / returning', value: `${num(h.people.new_athletes)} new · ${num(h.people.returning_athletes)} returning` },
    { title: 'Capacity used', value: pct(h.people.utilisation_pct), meta: h.people.formulas?.utilisation }, { title: 'On a waitlist', value: num(h.people.waitlisted) },
  ] });
  if (h.delivery) sections.push({ title: 'Delivery', items: [
    { title: 'Sessions scheduled / completed', value: `${num(h.delivery.sessions_scheduled)} / ${num(h.delivery.sessions_completed)}` }, { title: 'Sessions cancelled', value: num(h.delivery.sessions_cancelled), meta: h.delivery.formulas?.cancellation_rate },
    { title: 'Cancellation rate', value: pct(h.delivery.cancellation_rate_pct) }, { title: 'Attendance', value: pct(h.delivery.attendance_pct) }, { title: 'Staffing exceptions', value: num(h.delivery.staffing_exceptions), meta: h.delivery.formulas?.staffing_exceptions },
  ] });
  if (h.outcomes) sections.push({ title: 'Outcomes', items: [
    { title: 'Assessments approved', value: num(h.outcomes.assessments_approved) }, { title: 'Awaiting review', value: num(h.outcomes.assessments_awaiting_review) }, { title: 'Athletes needing a pathway review', value: safeCount(h.outcomes.review_queue) },
    ...h.outcomes.level_distribution.map((l) => ({ title: `${l.title} · ${l.level ?? 'unplaced'}`, value: safeCount(l.n), meta: LABEL.decision[l.decision] ?? l.decision })),
  ] });
  if (h.retention) sections.push({ title: 'Retention indicators', body: 'Stated rules over recorded facts. No prediction and nothing is done automatically.', items: [{ title: 'Athletes with at least one indicator', value: safeCount(h.retention.athletes_flagged) }, ...Object.entries(h.retention.indicators).map(([k, v]) => ({ title: k.replace(/_/g, ' '), value: safeCount(v) }))] });
  for (const c of h.finance.currencies) {
    sections.push({ title: `Finance (${c.currency})`, items: [
      { title: 'Management revenue', value: money(c.management_revenue_minor, c.currency) }, { title: 'Cash collected', value: money(c.cash_collected_minor, c.currency) }, { title: 'Outstanding', value: money(c.outstanding_minor, c.currency) },
      { title: 'Staff cost', value: money(c.staff_cost_minor, c.currency), meta: 'Approved payroll, then manual entries where payroll has none' }, { title: 'Venue cost', value: money(c.venue_cost_minor, c.currency), meta: 'Confirmed venue bookings, then manual entries' },
      { title: 'Cost not tied to a programme', value: money(c.unattributed_cost_minor, c.currency) }, { title: 'Contribution', value: money(c.contribution_minor, c.currency) },
      { title: 'Operating result', value: money(c.operating_result_minor, c.currency), meta: c.cost_picture_complete ? undefined : 'Cost picture is incomplete, so the margin is not shown' }, { title: 'Margin', value: pct(c.margin_pct) },
    ] });
    if (c.by_branch?.length) sections.push({ title: `By branch (${c.currency})`, items: c.by_branch.map((b) => ({ title: b.name, value: `Revenue ${money(b.management_revenue_minor, c.currency)} · Result ${money(b.operating_result_minor, c.currency)}`, meta: b.archived ? 'Archived branch' : undefined })) });
  }
  for (const g of h.finance.ageing) sections.push({ title: `Receivables ageing (${g.currency})`, items: [{ title: 'Total outstanding', value: money(g.total_minor, g.currency) }, ...Object.entries(g.buckets).map(([k, b]) => ({ title: k.replace('d', '').replace('_', ' to ').replace('plus', '+').replace('not yet due', 'Not yet due'), value: `${money(b.amount_minor, g.currency)} (${b.count})` }))] });
  if (h.partners) sections.push({ title: 'Partners and risk', items: [{ title: 'Active sponsorships', value: num(h.partners.active_sponsorships) }, { title: 'Overdue sponsor obligations', value: num(h.partners.overdue_sponsor_obligations) }, { title: 'Care providers linked', value: num(h.partners.providers) }, { title: 'Open legal matters', value: num(h.partners.legal_open_matters), meta: 'Count only. Legal detail stays in the Legal module.' }] });
  sections.push({ title: 'About this review', body: `${DEFINITIONS.basis} A figure that cannot be known from the data is shown as "${NA}", never as zero. Currencies are never added together.` });
  return frame('management', org, { addressee: `${org.name} leadership`, reference: `MGT-${orgId.replace(/-/g, '').slice(0, 8).toUpperCase()}`, sections });
}

export async function financeSnapshot(orgId, from, to) {
  const org = await orgOf(orgId);
  const p = await pnl(orgId, { from, to });
  const ag = await ageing(orgId, to);
  const sections = [{ title: 'Period and basis', items: [{ title: 'From', value: from }, { title: 'To', value: to }, { title: 'Revenue basis', value: p.basis.revenue }, { title: 'Cash basis', value: p.basis.cash }, { title: 'Staff cost basis', value: p.basis.staff_cost }, { title: 'Venue cost basis', value: p.basis.venue_cost }, { title: 'Status', value: 'Management view, not statutory or audited accounts' }] }];
  if (!p.currencies.length) sections.push({ title: 'No activity', body: 'There are no charges or costs in this period.' });
  for (const c of p.currencies) {
    const t = c.totals, cur = c.currency;
    sections.push({ title: `Profit and loss (${cur})`, items: [
      { title: 'Gross billed', value: money(t.gross_billed_minor, cur) }, { title: 'Discounts', value: money(t.discounts_minor, cur) },
      { title: 'Scholarship / bursary / sponsor funding', value: t.funded_minor ? `${money(t.funded_minor.scholarship, cur)} / ${money(t.funded_minor.bursary, cur)} / ${money(t.funded_minor.sponsor, cur)}` : NA },
      { title: 'Net invoiced', value: money(t.net_invoiced_minor, cur) }, { title: 'Refunds', value: money(t.refunds_minor, cur) }, { title: 'Management revenue', value: money(t.management_revenue_minor, cur), meta: DEFINITIONS.management_revenue },
      { title: 'Cash collected', value: money(t.cash_collected_minor, cur) }, { title: 'Outstanding', value: money(t.outstanding_minor, cur) },
      { title: 'Staff cost', value: money(t.staff_cost_minor, cur) }, { title: 'Venue cost', value: money(t.venue_cost_minor, cur) }, { title: 'Other direct cost', value: money(t.other_direct_cost_minor, cur) },
      { title: 'Cost not tied to a programme', value: money(t.unattributed_cost_minor, cur), meta: DEFINITIONS.unattributed_cost },
      { title: 'Allocated overhead', value: money(t.allocated_overhead_minor, cur) }, { title: 'Contribution', value: money(t.contribution_minor, cur) },
      { title: 'Operating result', value: money(t.operating_result_minor, cur), meta: t.cost_picture_complete ? undefined : 'Some programmes have no staff cost yet, so the picture is incomplete' }, { title: 'Margin', value: pct(t.margin_pct) },
    ] });
    if (c.programmes.length) sections.push({ title: `By programme (${cur})`, items: c.programmes.map((r) => ({ title: r.title, value: `Revenue ${money(r.management_revenue_minor, cur)} · Result ${money(r.operating_result_minor, cur)} · Margin ${pct(r.margin_pct)}`, meta: `Sources: ${r.sources.charges} charges, ${r.sources.payroll_lines} payroll lines, ${r.sources.venue_bookings} venue bookings, ${r.sources.cost_entries} manual entries${r.missing_costs.length ? ` · missing: ${r.missing_costs.join(', ')}` : ''}` })) });
    if (c.by_branch?.length) sections.push({ title: `By branch (${cur})`, items: c.by_branch.map((b) => ({ title: b.name, value: `Revenue ${money(b.management_revenue_minor, cur)} · Result ${money(b.operating_result_minor, cur)}` })) });
  }
  for (const g of ag.currencies) sections.push({ title: `Receivables ageing as of ${ag.as_of} (${g.currency})`, items: [{ title: 'Total outstanding', value: money(g.total_minor, g.currency) }, { title: 'Due within 14 days', value: money(g.due_within_14_days_minor, g.currency) }, ...Object.entries(g.buckets).map(([k, b]) => ({ title: k, value: `${money(b.amount_minor, g.currency)} (${b.count})` }))] });
  sections.push({ title: 'Cost sources and gaps', items: [
    { title: 'Manual cost entries set aside because payroll or a booking covers them', value: num(p.cost_sources.manual_entries_superseded) },
    { title: 'Approved payroll timesheets with no pay term (cost not counted)', value: num(p.cost_sources.payroll_unpriced_timesheets) },
    { title: 'Sessions with no venue booking (venue cost not counted)', value: num(p.cost_sources.venue_sessions_unbooked) },
  ] });
  sections.push({ title: 'About these figures', body: `${DEFINITIONS.basis} Currencies are never added together. ${DEFINITIONS.direct_costs}` });
  return frame('finance', org, { addressee: `${org.name} finance`, reference: `FIN-${orgId.replace(/-/g, '').slice(0, 8).toUpperCase()}`, sections });
}

// ------------------------------------------------------------------ issue + list
const COLS = 'id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, generated_by, created_at';
const view = (r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` });

async function issue(user, kind, orgId, sourceId, snapshot, templateId) {
  const K = KINDS[kind];
  let ver = null;
  if (templateId) {
    const t = await one('SELECT * FROM document_templates WHERE id=$1', [templateId]);
    await mustAccess(user, t, 'Template');
    if (t.family !== K.family || t.organisation_id !== orgId) throw badRequest(`Pick one of this academy's ${K.family.replace(/_/g, ' ')} templates`);
    if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
    ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
    if (!ver) throw conflict('Publish the template before generating documents from it');
  }
  const sourceType = `${K.type}:${orgId}`;
  // identical content for the same person and template is the same document: a retry never makes a second copy, changed data makes a new one
  const { issued_at: _t, ...stable } = snapshot;
  const snapshotSha = createHash('sha256').update(JSON.stringify(stable)).update(ver?.id ?? 'starter').digest('hex');
  const dup = await one(`SELECT ${COLS} FROM generated_documents WHERE source_type=$1 AND source_id=$2 AND generated_by=$3 AND snapshot_sha=$4 ORDER BY created_at DESC LIMIT 1`, [sourceType, sourceId, user.id, snapshotSha]);
  if (dup) return { ...view(dup), duplicate: true };
  const layout = ver ? ver.layout : starterFor(K.family, 'classic');
  const { buffer, pages } = await renderSectionDocument({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot });
  const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
  const row = await one(
    `INSERT INTO generated_documents(id, family, source_type, source_id, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by, snapshot_sha)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
    [did, K.family, sourceType, sourceId, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id, snapshotSha]);
  await audit(null, user.id, 'generate_document', 'generated_documents', did);
  await audit(null, user.id, `generate_academy_${kind}_pdf`, 'organisations', orgId);
  return view(row);
}
const period = (i) => ({ from: i.from ?? daysAgo(90), to: i.to ?? today() });
const range = (p) => { if (p.to < p.from) throw badRequest('The end date is before the start date'); if (Date.parse(p.to) - Date.parse(p.from) > 400 * 864e5) throw badRequest('Choose a period of at most 13 months'); return p; };

cap({
  name: 'generate_academy_progress_report', method: 'POST', path: '/organisations/:id/academy/athletes/:athlete_id/progress-report', tag: TAG, status: 201,
  summary: 'Branded PDF progress report for one athlete (academy owner/admin, the athlete\'s coach, the athlete, or their verified guardian). It prints only what the athlete-safe progress view shows: pathway level, decisions, assessments the athlete may see (a young person\'s coaching material needs guardian consent), attendance and approved official results, labelled by origin and never merged into one score. No private coach notes, health or fee data. Identical content returns the same document (duplicate:true).',
  input: z.object({ id, athlete_id: id, template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const { staff } = await progressAccess(user, i.id, i.athlete_id);
    if (i.template_id && !staff) throw badRequest('Only academy staff can pick a template');
    await audit(null, user.id, 'read_academy_progress_report', 'users', i.athlete_id);
    return issue(user, 'progress', i.id, i.athlete_id, await progressSnapshot(i.id, i.athlete_id), i.template_id);
  },
});

cap({
  name: 'generate_academy_management_review', method: 'POST', path: '/organisations/:id/academy/management-review', tag: TAG, status: 201,
  summary: 'Branded PDF management review of the academy for a period (owner/admin): people, delivery, outcomes (small groups suppressed), retention indicators, finance by currency and branch, receivables ageing and partner counts, from the same figures as the Executive Home. Legal and clinical detail are never printed. Management view, not statutory accounts.',
  input: z.object({ id, from: day.optional(), to: day.optional(), template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const { role } = await orgFor(user, i.id, STAFF);
    const p = range(period(i));
    return issue(user, 'management', i.id, i.id, await managementSnapshot(i.id, role, p.from, p.to), i.template_id);
  },
});

cap({
  name: 'generate_academy_finance_pack', method: 'POST', path: '/organisations/:id/academy/finance-pack', tag: TAG, status: 201,
  summary: 'Branded PDF finance pack (owner/admin/finance): management P&L per currency and programme/branch, cash vs invoice basis, cost sources and gaps (unpriced timesheets, unbooked sessions), and receivables ageing as of the end date. Every figure comes from the same functions as the P&L screen; it states plainly that it is a management view, not statutory accounts. No private coaching or clinical data.',
  input: z.object({ id, from: day.optional(), to: day.optional(), template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    await orgFor(user, i.id, STAFF_MONEY);
    const p = range(period(i));
    return issue(user, 'finance', i.id, i.id, await financeSnapshot(i.id, p.from, p.to), i.template_id);
  },
});

cap({
  name: 'list_academy_pack_documents', method: 'GET', path: '/organisations/:id/academy/documents', tag: TAG,
  summary: 'PDFs already issued for this academy, newest first: kind progress (give athlete_id; staff, coach, athlete or guardian), management (owner/admin) or finance (owner/admin/finance). Each has a secure, audited download url.',
  input: z.object({ id, kind: z.enum(['progress', 'management', 'finance']), athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const K = KINDS[i.kind];
    let sourceId = i.id;
    if (i.kind === 'progress') { if (!i.athlete_id) throw badRequest('Give the athlete'); await progressAccess(user, i.id, i.athlete_id); sourceId = i.athlete_id; }
    else await orgFor(user, i.id, i.kind === 'management' ? STAFF : STAFF_MONEY);
    return (await many(`SELECT ${COLS} FROM generated_documents WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [`${K.type}:${i.id}`, sourceId, i.limit, i.offset])).map(view);
  },
});
