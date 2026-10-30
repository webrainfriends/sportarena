// Federation & Governing Body OS (#475): Federation Home (the workspace dashboard), source-linked reports with auditable exports, and branded
// certificates, licences and sanction letters (the shared branded-document stack, #249). Every number is read from the canonical records with the same
// status rules the lists use, so the dashboard, the lists and the reports reconcile.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { saveEncrypted } from '../doc-store.js';
import { toCsv } from '../csv.js';
import { starterFor } from '../documents/layout.js';
import { renderEnrolmentLetter } from '../documents/render.js';
import { gate } from '../federation-approvals.js';
import { YOUTH_SQL } from '../youth.js';
import { authority, canSome, need, jurisdictionScope, EXC_COLS, EXC_FROM, subtree, bodyById, logFed, AFF_STATUS, LIC_STATUS, today, dateStr } from '../federation.js';
import { subjectFor, staffCan } from '../federation-subjects.js';
import { officerOf } from '../integrity.js';
import { loadLogo, mustAccess } from './branded-documents.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const MAX_EXPORT_ROWS = 5000;
const ds = (d) => dateStr(d);

// ------------------------------------------------------------------ home
const countBy = (rows, key = 'st') => Object.fromEntries(rows.map((r) => [r[key], r.n]));

cap({
  name: 'get_federation_home', method: 'GET', path: '/federation/bodies/:id/home', tag: TAG,
  summary: 'Federation Home: what needs the body\'s attention now. Affiliation applications and renewals, licence renewals and expiries, sanction requests, competitions under its jurisdiction, compliance exceptions (decisions approved over a failed requirement, and sanctioned events that have since moved), unresolved appeal cases linked to its records, open and upcoming registration and transfer windows, and breakdowns by sport, season and region. Staff of the body, or of a body above it. `include_descendants` rolls in the bodies recognised under it.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    const body = auth.body;
    const scope = jurisdictionScope(auth);       // staff limited to some jurisdictions see their own queues, and only this body
    const ids = i.include_descendants && !scope ? await subtree(i.id) : [i.id];
    const [aff, licSt, sanSt, affExp, licExp, drift, pendAff, pendLic, pendSan, comps, windows, cases, byBody, bySport, bySeason, exceptions, children] = await Promise.all([
      many(`SELECT ${AFF_STATUS('a')} AS st, count(*)::int AS n FROM fed_affiliations a WHERE a.body_id = ANY($1) GROUP BY 1`, [ids]),
      many(`SELECT ${LIC_STATUS('l')} AS st, count(*)::int AS n FROM fed_licences l WHERE l.body_id = ANY($1) GROUP BY 1`, [ids]),
      many('SELECT s.status AS st, count(*)::int AS n FROM fed_sanctions s WHERE s.body_id = ANY($1) GROUP BY 1', [ids]),
      one(`SELECT count(*) FILTER (WHERE a.effective_to <= current_date + 30)::int AS d30, count(*) FILTER (WHERE a.effective_to <= current_date + 60)::int AS d60 FROM fed_affiliations a WHERE a.body_id = ANY($1) AND a.status='approved' AND a.effective_to >= current_date`, [ids]),
      one(`SELECT count(*) FILTER (WHERE l.expires_on <= current_date + 30)::int AS d30, count(*) FILTER (WHERE l.expires_on <= current_date + 60)::int AS d60 FROM fed_licences l WHERE l.body_id = ANY($1) AND l.status='active' AND l.expires_on >= current_date`, [ids]),
      one(`SELECT count(*)::int AS n FROM fed_sanctions s JOIN events e ON e.id=s.event_id WHERE s.body_id = ANY($1) AND s.status IN ('approved','suspended') AND (e.status='cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on)`, [ids]),
      many(`SELECT a.id, o.name AS label, c.name AS sub, a.status, a.season_year, a.submitted_at, a.body_id FROM fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id WHERE a.body_id = ANY($1) AND ($2::uuid[] IS NULL OR a.jurisdiction_id = ANY($2)) AND a.status IN ('submitted','under_review','needs_info') ORDER BY a.submitted_at LIMIT 5`, [ids, scope]),
      many(`SELECT l.id, u.display_name AS label, t.name AS sub, l.status, l.submitted_at, l.body_id FROM fed_licences l JOIN users u ON u.id=l.holder_id JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id = ANY($1) AND ($2::uuid[] IS NULL OR l.jurisdiction_id = ANY($2)) AND l.status IN ('submitted','under_review','needs_info') ORDER BY l.submitted_at LIMIT 5`, [ids, scope]),
      many(`SELECT s.id, e.name AS label, e.starts_on::text AS sub, s.status, s.created_at AS submitted_at, s.body_id FROM fed_sanctions s JOIN events e ON e.id=s.event_id WHERE s.body_id = ANY($1) AND ($2::uuid[] IS NULL OR s.jurisdiction_id = ANY($2)) AND s.status IN ('requested','under_review','needs_info') ORDER BY s.created_at LIMIT 5`, [ids, scope]),
      one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE san.status IN ('approved','suspended'))::int AS sanctioned, count(*) FILTER (WHERE san.status IN ('requested','under_review','needs_info'))::int AS pending,
                  count(*) FILTER (WHERE (san.id IS NULL OR san.status IN ('rejected','withdrawn','revoked')) AND e.starts_on >= current_date)::int AS unsanctioned_upcoming
             FROM events e LEFT JOIN LATERAL (SELECT x.id, x.status FROM fed_sanctions x WHERE x.event_id=e.id AND x.body_id=$2 ORDER BY (x.status IN ('approved','suspended')) DESC, x.created_at DESC LIMIT 1) san ON true
            WHERE e.status <> 'cancelled' AND e.sport_id IN (SELECT sport_id FROM governing_body_sports WHERE body_id = ANY($1) AND ended_on IS NULL)
              AND (EXISTS (SELECT 1 FROM fed_affiliations a WHERE a.organisation_id=e.organisation_id AND a.body_id = ANY($1) AND (${AFF_STATUS('a')})='approved') OR EXISTS (SELECT 1 FROM fed_sanctions x WHERE x.event_id=e.id AND x.body_id = ANY($1) AND x.status NOT IN ('withdrawn','rejected','revoked')))`, [ids, i.id]),
      many(`SELECT d.id, d.kind, d.title, d.starts_on::text AS starts_on, d.ends_on::text AS ends_on, (current_date BETWEEN d.starts_on AND d.ends_on) AS open FROM fed_dates d
             WHERE d.body_id=$1 AND d.status='active' AND d.kind IN ('registration_window','transfer_window') AND d.ends_on >= current_date AND d.starts_on <= current_date + 60 ORDER BY d.starts_on LIMIT 10`, [i.id]),
      many(`SELECT c.case_no, c.kind, c.category, c.status, c.created_at, l.entity_type, l.entity_id FROM case_links l JOIN cases c ON c.id=l.case_id
             WHERE l.entity_type IN ('federation_licence','federation_affiliation','federation_sanction') AND c.status NOT IN ('resolved','withdrawn')
               AND ((l.entity_type='federation_licence' AND EXISTS (SELECT 1 FROM fed_licences x WHERE x.id=l.entity_id AND x.body_id = ANY($1)))
                 OR (l.entity_type='federation_affiliation' AND EXISTS (SELECT 1 FROM fed_affiliations x WHERE x.id=l.entity_id AND x.body_id = ANY($1)))
                 OR (l.entity_type='federation_sanction' AND EXISTS (SELECT 1 FROM fed_sanctions x WHERE x.id=l.entity_id AND x.body_id = ANY($1)))) ORDER BY c.created_at DESC LIMIT 10`, [ids]),
      many(`SELECT b.id AS body_id, bo.name, b.level, b.country, b.region, b.state, b.district,
                   (SELECT count(*)::int FROM fed_affiliations a WHERE a.body_id=b.id AND (${AFF_STATUS('a')})='approved') AS affiliations,
                   (SELECT count(*)::int FROM fed_licences l WHERE l.body_id=b.id AND (${LIC_STATUS('l')})='active') AS licences,
                   (SELECT count(*)::int FROM fed_sanctions s WHERE s.body_id=b.id AND s.status='approved') AS sanctions
              FROM governing_bodies b JOIN organisations bo ON bo.id=b.organisation_id WHERE b.id = ANY($1) ORDER BY (b.id=$2) DESC, bo.name`, [ids, i.id]),
      many(`SELECT sp.id AS sport_id, sp.name AS sport_name, sum(x.aff)::int AS affiliations, sum(x.lic)::int AS licences, sum(x.san)::int AS sanctions FROM (
              SELECT c.sport_id, 1 AS aff, 0 AS lic, 0 AS san FROM fed_affiliations a JOIN fed_affiliation_categories c ON c.id=a.category_id WHERE a.body_id = ANY($1) AND (${AFF_STATUS('a')})='approved' AND c.sport_id IS NOT NULL
              UNION ALL SELECT t.sport_id, 0, 1, 0 FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id = ANY($1) AND (${LIC_STATUS('l')})='active'
              UNION ALL SELECT e.sport_id, 0, 0, 1 FROM fed_sanctions s JOIN events e ON e.id=s.event_id WHERE s.body_id = ANY($1) AND s.status='approved') x JOIN sports sp ON sp.id=x.sport_id GROUP BY 1, 2 ORDER BY 2`, [ids]),
      many(`SELECT y AS season_year, sum(aff)::int AS affiliations, sum(lic)::int AS licences, sum(san)::int AS sanctions FROM (
              SELECT a.season_year AS y, 1 AS aff, 0 AS lic, 0 AS san FROM fed_affiliations a WHERE a.body_id = ANY($1) AND (${AFF_STATUS('a')}) IN ('approved','expired','suspended')
              UNION ALL SELECT extract(year FROM l.issued_on)::int, 0, 1, 0 FROM fed_licences l WHERE l.body_id = ANY($1) AND l.issued_on IS NOT NULL AND (${LIC_STATUS('l')}) IN ('active','expired','suspended')
              UNION ALL SELECT extract(year FROM s.approved_starts_on)::int, 0, 0, 1 FROM fed_sanctions s WHERE s.body_id = ANY($1) AND s.status IN ('approved','suspended')) x GROUP BY 1 ORDER BY 1 DESC LIMIT 8`, [ids]),
      many(`SELECT * FROM (
              SELECT e.subject_type AS type, e.subject_id AS id, x.label, e.reason, e.decided_at AS at, e.body_id, 'override' AS kind, x.decided_by_name AS by, e.id AS exception_id, x.review_due, x.overdue
                FROM fed_exceptions e JOIN (SELECT ${EXC_COLS} FROM ${EXC_FROM}) x ON x.id=e.id
               WHERE e.body_id = ANY($1) AND e.status IN ('open','extended') AND ($2::uuid[] IS NULL OR x.jurisdiction_id = ANY($2))
              UNION ALL SELECT 'sanction', s.id, ev.name, CASE WHEN ev.status='cancelled' THEN 'The event was cancelled after it was sanctioned' ELSE 'The event dates moved outside the sanctioned dates' END, ev.created_at, s.body_id, 'event_moved', NULL, NULL, NULL, false
                FROM fed_sanctions s JOIN events ev ON ev.id=s.event_id WHERE s.body_id = ANY($1) AND s.status IN ('approved','suspended') AND (ev.status='cancelled' OR ev.starts_on < s.approved_starts_on OR ev.ends_on > s.approved_ends_on) AND ($2::uuid[] IS NULL OR s.jurisdiction_id = ANY($2))
            ) y ORDER BY overdue DESC, at DESC NULLS LAST LIMIT 12`, [ids, scope]),
      many(`SELECT l.child_id AS body_id, bo.name, b.level, b.abbreviation FROM governing_body_links l JOIN governing_bodies b ON b.id=l.child_id JOIN organisations bo ON bo.id=b.organisation_id WHERE l.parent_id=$1 AND l.status='recognised' ORDER BY bo.name`, [i.id]),
    ]);
    const links = await one("SELECT count(*)::int AS n FROM governing_body_links WHERE (parent_id=$1 OR child_id=$1) AND status='requested'", [i.id]);
    const a = countBy(aff), l = countBy(licSt), s = countBy(sanSt);
    return {
      body: { id: body.id, name: body.name, level: body.level, abbreviation: body.abbreviation, country: body.country, status: body.status },
      scope: { include_descendants: i.include_descendants, bodies: ids.length },
      me: { user_id: user.id, admin: auth.admin, roles: auth.roles.map((r) => r.role), read_only_via_parent: auth.viaAncestor, can: Object.fromEntries(['affiliations', 'licences', 'sanctions', 'governance', 'evidence', 'reports', 'exceptions'].map((p) => [p, canSome(auth, p)]).concat([['integrity', !!(await officerOf(user, body.id))]])) },
      counts: {
        affiliations: { pending: (a.submitted ?? 0) + (a.under_review ?? 0), needs_info: a.needs_info ?? 0, approved: a.approved ?? 0, suspended: a.suspended ?? 0, expired: a.expired ?? 0, expiring_30: affExp.d30, expiring_60: affExp.d60 },
        licences: { pending: (l.submitted ?? 0) + (l.under_review ?? 0), needs_info: l.needs_info ?? 0, active: l.active ?? 0, suspended: l.suspended ?? 0, expired: l.expired ?? 0, expiring_30: licExp.d30, expiring_60: licExp.d60 },
        sanctions: { pending: (s.requested ?? 0) + (s.under_review ?? 0), needs_info: s.needs_info ?? 0, approved: s.approved ?? 0, suspended: s.suspended ?? 0, moved: drift.n },
        competitions: comps, exceptions: exceptions.length, cases: cases.length, link_requests: links.n,
      },
      queue: { affiliations: pendAff, licences: pendLic, sanctions: pendSan },
      windows, cases: cases.map((c) => ({ ...c, link_type: c.entity_type.replace('federation_', '') })), exceptions, children,
      breakdown: { by_sport: bySport, by_season: bySeason, by_region: byBody },
    };
  },
});

// ------------------------------------------------------------------ reports
const REPORTS = ['affiliations', 'licences', 'sanctions', 'jurisdiction'];
const COLUMNS = {
  affiliations: ['body', 'organisation', 'organisation_id', 'category', 'sport', 'season_year', 'affiliation_no', 'status_as_of', 'effective_from', 'effective_to', 'fee_status', 'policy_version', 'affiliation_id'],
  licences: ['body', 'licence_no', 'holder', 'holder_id', 'type', 'holder_role', 'sport', 'discipline', 'grade', 'status_as_of', 'issued_on', 'expires_on', 'club', 'policy_version', 'licence_id'],
  sanctions: ['body', 'sanction_no', 'event', 'event_id', 'sport', 'status_as_of', 'approved_from', 'approved_to', 'categories', 'conditions', 'override', 'policy_version', 'sanction_id'],
  jurisdiction: ['body', 'body_id', 'level', 'parent', 'country', 'region', 'state', 'district', 'affiliations_in_force', 'licences_in_force', 'sanctions_in_force'],
};

async function buildReport(i, ids) {
  const asOf = i.as_of ?? today();
  const f = [ids, asOf, i.sport_id ?? null, i.season_year ?? null];
  if (i.report === 'affiliations') {
    const w = `a.body_id = ANY($1) AND a.status IN ('approved','suspended','expired') AND a.effective_from <= $2 AND a.effective_to >= $2 AND a.decided_at::date <= $2 AND ($3::uuid IS NULL OR c.sport_id=$3) AND ($4::int IS NULL OR a.season_year=$4)`;
    const from = 'fed_affiliations a JOIN governing_bodies b ON b.id=a.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id LEFT JOIN sports sp ON sp.id=c.sport_id LEFT JOIN fed_policy_versions pv ON pv.id=a.policy_version_id LEFT JOIN fed_policies pp ON pp.id=pv.policy_id';
    const rows = await many(`SELECT bo.name AS body, o.name AS organisation, o.id AS organisation_id, c.name AS category, sp.name AS sport, a.season_year, a.affiliation_no, CASE WHEN a.status='suspended' THEN 'suspended' ELSE 'in_force' END AS status_as_of,
        a.effective_from::text AS effective_from, a.effective_to::text AS effective_to, a.fee_status, CASE WHEN pv.id IS NULL THEN NULL ELSE pp.title || ' v' || pv.version END AS policy_version, a.id AS affiliation_id FROM ${from} WHERE ${w} ORDER BY bo.name, o.name, a.id LIMIT ${MAX_EXPORT_ROWS + 1}`, f);
    return { asOf, rows, totals: countBy(await many(`SELECT CASE WHEN a.status='suspended' THEN 'suspended' ELSE 'in_force' END AS st, count(*)::int AS n FROM ${from} WHERE ${w} GROUP BY 1`, f)) };
  }
  if (i.report === 'licences') {
    const w = `l.body_id = ANY($1) AND l.status IN ('active','suspended','expired') AND l.issued_on <= $2 AND l.expires_on >= $2 AND l.decided_at::date <= $2 AND ($3::uuid IS NULL OR t.sport_id=$3) AND ($4::int IS NULL OR extract(year FROM l.issued_on)=$4)`;
    const from = 'fed_licences l JOIN governing_bodies b ON b.id=l.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN fed_licence_types t ON t.id=l.type_id JOIN sports sp ON sp.id=t.sport_id JOIN users u ON u.id=l.holder_id LEFT JOIN fed_affiliations af ON af.id=l.affiliation_id LEFT JOIN organisations co ON co.id=af.organisation_id LEFT JOIN fed_policy_versions pv ON pv.id=l.policy_version_id LEFT JOIN fed_policies pp ON pp.id=pv.policy_id';
    const rows = await many(`SELECT bo.name AS body, l.licence_no, CASE WHEN ${YOUTH_SQL} THEN 'Youth participant' ELSE u.display_name END AS holder, CASE WHEN ${YOUTH_SQL} THEN NULL ELSE u.id END AS holder_id, t.name AS type, t.holder_role, sp.name AS sport, t.discipline, l.grade, CASE WHEN l.status='suspended' THEN 'suspended' ELSE 'good_standing' END AS status_as_of,
        l.issued_on::text AS issued_on, l.expires_on::text AS expires_on, co.name AS club, CASE WHEN pv.id IS NULL THEN NULL ELSE pp.title || ' v' || pv.version END AS policy_version, l.id AS licence_id FROM ${from} WHERE ${w} ORDER BY bo.name, u.display_name, l.id LIMIT ${MAX_EXPORT_ROWS + 1}`, f);
    return { asOf, rows, redactions: { youth_holders: rows.filter((x) => x.holder === 'Youth participant').length }, totals: countBy(await many(`SELECT CASE WHEN l.status='suspended' THEN 'suspended' ELSE 'good_standing' END AS st, count(*)::int AS n FROM ${from} WHERE ${w} GROUP BY 1`, f)) };
  }
  if (i.report === 'sanctions') {
    const w = `s.body_id = ANY($1) AND s.status IN ('approved','suspended') AND s.approved_starts_on <= $2 AND s.approved_ends_on >= $2 AND s.decided_at::date <= $2 AND ($3::uuid IS NULL OR e.sport_id=$3) AND ($4::int IS NULL OR extract(year FROM s.approved_starts_on)=$4)`;
    const from = 'fed_sanctions s JOIN governing_bodies b ON b.id=s.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN events e ON e.id=s.event_id JOIN sports sp ON sp.id=e.sport_id LEFT JOIN fed_policy_versions pv ON pv.id=s.policy_version_id LEFT JOIN fed_policies pp ON pp.id=pv.policy_id';
    const rows = await many(`SELECT bo.name AS body, s.sanction_no, e.name AS event, e.id AS event_id, sp.name AS sport, CASE WHEN s.status='suspended' THEN 'suspended' ELSE 'in_force' END AS status_as_of, s.approved_starts_on::text AS approved_from, s.approved_ends_on::text AS approved_to,
        array_to_string(coalesce(s.approved_categories, s.categories), '; ') AS categories, array_to_string(s.conditions, '; ') AS conditions, s.override_reason AS override, CASE WHEN pv.id IS NULL THEN NULL ELSE pp.title || ' v' || pv.version END AS policy_version, s.id AS sanction_id FROM ${from} WHERE ${w} ORDER BY bo.name, e.starts_on, s.id LIMIT ${MAX_EXPORT_ROWS + 1}`, f);
    return { asOf, rows, totals: countBy(await many(`SELECT CASE WHEN s.status='suspended' THEN 'suspended' ELSE 'in_force' END AS st, count(*)::int AS n FROM ${from} WHERE ${w} GROUP BY 1`, f)) };
  }
  const rows = await many(
    `SELECT bo.name AS body, b.id AS body_id, b.level, po.name AS parent, b.country, b.region, b.state, b.district,
            (SELECT count(*)::int FROM fed_affiliations a WHERE a.body_id=b.id AND a.status IN ('approved','suspended') AND a.effective_from <= $2 AND a.effective_to >= $2 AND a.decided_at::date <= $2 AND a.status='approved') AS affiliations_in_force,
            (SELECT count(*)::int FROM fed_licences l WHERE l.body_id=b.id AND l.status IN ('active','expired') AND l.issued_on <= $2 AND l.expires_on >= $2 AND l.decided_at::date <= $2 AND l.status='active') AS licences_in_force,
            (SELECT count(*)::int FROM fed_sanctions s WHERE s.body_id=b.id AND s.status='approved' AND s.approved_starts_on <= $2 AND s.approved_ends_on >= $2 AND s.decided_at::date <= $2) AS sanctions_in_force
       FROM governing_bodies b JOIN organisations bo ON bo.id=b.organisation_id
       LEFT JOIN governing_body_links pl ON pl.child_id=b.id AND pl.status='recognised' LEFT JOIN governing_bodies pb ON pb.id=pl.parent_id LEFT JOIN organisations po ON po.id=pb.organisation_id
      WHERE b.id = ANY($1) ORDER BY bo.name, b.id`, [ids, asOf]);
  return { asOf, rows, totals: { bodies: rows.length, affiliations_in_force: rows.reduce((n, r) => n + r.affiliations_in_force, 0), licences_in_force: rows.reduce((n, r) => n + r.licences_in_force, 0), sanctions_in_force: rows.reduce((n, r) => n + r.sanctions_in_force, 0) } };
}

cap({
  name: 'get_federation_report', method: 'GET', path: '/federation/bodies/:id/reports/:report', tag: TAG,
  summary: 'A source-linked report for a body and the bodies recognised under it: `affiliations`, `licences`, `sanctions` (what was in force on the `as_of` date, with the effective dates, the policy version the decision used and the id of the source record) or `jurisdiction` (the hierarchy with what each body has in force). Needs a reporting role (auditor, compliance, or a registrar/licensing/sanctioning officer/secretary) or admin. `format=csv` returns a spreadsheet and records the export (who, when, filters, row count and a hash of the file); exports are capped at 5,000 rows.',
  input: z.object({ id, report: z.enum(REPORTS), as_of: day.optional(), season_year: z.coerce.number().int().min(1990).max(2200).optional(), sport_id: id.optional(), include_descendants: z.coerce.boolean().default(true), format: z.enum(['json', 'csv']).default('json'), purpose: text(300).min(5).optional().describe('why the file is taken (required for a CSV export; kept with the export log)'), approval_id: id.optional().describe('the second person\'s approval, where the body requires four eyes for exports'), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const r = await buildReport(i, ids);
    const cols = COLUMNS[i.report];
    if (i.format === 'csv') {
      if (r.rows.length > MAX_EXPORT_ROWS) throw badRequest(`This export has more than ${MAX_EXPORT_ROWS} rows; narrow it by sport or season`);
      if (!i.purpose) throw badRequest('Say why you are taking this file (purpose); it is kept with the export log');
      const csv = toCsv(cols, r.rows);
      const sha256 = createHash('sha256').update(csv).digest('hex');
      await tx(async (c) => {
        const ap = await gate(c, user, { bodyId: i.id, actions: ['bulk_export'], subjectType: 'report', subjectId: i.id, request: { report: i.report, as_of: i.as_of ?? null, season_year: i.season_year ?? null, sport_id: i.sport_id ?? null, include_descendants: i.include_descendants }, approvalId: i.approval_id });
        await c.query('INSERT INTO fed_exports(body_id, report, filters, as_of, row_count, sha256, exported_by, purpose, approval_id, redactions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [i.id, i.report, { season_year: i.season_year ?? null, sport_id: i.sport_id ?? null, include_descendants: i.include_descendants }, r.asOf, r.rows.length, sha256, user.id, i.purpose, ap?.id ?? null, r.redactions ?? {}]);
        await audit(c, user.id, 'export_federation_report', 'governing_bodies', i.id);
      });
      return { report: i.report, as_of: r.asOf, rows: r.rows.length, filename: `${auth.body.abbreviation}-${i.report}-${r.asOf}.csv`, sha256, csv };
    }
    const rows = r.rows.slice(i.offset, i.offset + i.limit);
    return { report: i.report, as_of: r.asOf, scope: { bodies: ids.length, include_descendants: i.include_descendants }, columns: cols, totals: r.totals, total: r.rows.length, truncated: r.rows.length > MAX_EXPORT_ROWS, rows };
  },
});

cap({
  name: 'list_federation_exports', method: 'GET', path: '/federation/bodies/:id/exports', tag: TAG,
  summary: 'The log of exports taken from a body: who, when, which report and filters, how many rows and the file hash (reporting roles).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    need(await authority(user, i.id), 'reports');
    return many('SELECT e.id, e.report, e.filters, e.as_of::text AS as_of, e.row_count, e.sha256, e.created_at, u.display_name AS exported_by FROM fed_exports e JOIN users u ON u.id=e.exported_by WHERE e.body_id=$1 ORDER BY e.created_at DESC, e.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ branded documents
const COLS = 'id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, generated_by, created_at';
const view = (r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` });
const KINDS = { affiliation: 'federation_affiliation', licence: 'federation_licence', sanction: 'federation_sanction' };

/** Live check on every download: the body's staff or the other party, never anyone else. */
export async function canReadFederationDocument(user, sourceType, sourceId) {
  const type = Object.entries(KINDS).find(([, v]) => v === sourceType)?.[0];
  if (!type) throw notFound('Document');
  const s = await subjectFor(user, type, sourceId);
  if (!s.party && (!s.auth || s.auth.viaAncestor)) throw notFound('Document');
}

async function snapshotOf(s, note) {
  const body = await bodyById(s.row.body_id);
  const head = { organisation: body.name, legal_name: body.legal_name ?? null, address: null, issued_at: new Date().toISOString() };
  const closing = { title: 'About this document', body: `Issued from the ${body.name} register on ${new Date().toISOString().slice(0, 10)}. It records the position on that day; standing can change, so confirm it with ${body.name} when it matters.` };
  const welcome = (t) => ({ title: 'Statement', body: note?.trim() || t });
  if (s.type === 'affiliation') {
    const a = await one(`SELECT a.*, ${AFF_STATUS('a')} AS eff, o.name AS org_name, c.name AS category, sp.name AS sport FROM fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id LEFT JOIN sports sp ON sp.id=c.sport_id WHERE a.id=$1`, [s.row.id]);
    if (a.eff !== 'approved') throw conflict(`A certificate is issued for an affiliation in force; this one is ${a.eff}`);
    return { ...head, title: 'Certificate of affiliation', addressee: a.org_name, reference: a.affiliation_no, sections: [
      welcome(`${a.org_name} is recognised as an affiliated ${a.category}${a.sport ? ` (${a.sport})` : ''} of ${body.name} for the ${a.season_year} season.`),
      { title: 'Affiliation', items: [{ title: 'Affiliation number', value: a.affiliation_no }, { title: 'Category', value: a.category }, ...(a.sport ? [{ title: 'Sport', value: a.sport }] : []), { title: 'Season', value: String(a.season_year) }, { title: 'Valid', value: `${ds(a.effective_from)} to ${ds(a.effective_to)}` }] }, closing] };
  }
  if (s.type === 'licence') {
    const l = await one(`SELECT l.*, ${LIC_STATUS('l')} AS eff, u.display_name, t.name AS type_name, t.holder_role, sp.name AS sport, t.discipline, co.name AS club FROM fed_licences l JOIN users u ON u.id=l.holder_id JOIN fed_licence_types t ON t.id=l.type_id JOIN sports sp ON sp.id=t.sport_id LEFT JOIN fed_affiliations af ON af.id=l.affiliation_id LEFT JOIN organisations co ON co.id=af.organisation_id WHERE l.id=$1`, [s.row.id]);
    if (l.eff !== 'active') throw conflict(`A licence document is issued for a licence in good standing; this one is ${l.eff}`);
    return { ...head, title: `${l.type_name} licence`, addressee: l.display_name, reference: l.licence_no, sections: [
      welcome(`${l.display_name} holds a ${l.type_name} licence${l.grade ? ` (${l.grade})` : ''} for ${l.sport}${l.discipline ? ` · ${l.discipline}` : ''} issued by ${body.name}.`),
      { title: 'Licence', items: [{ title: 'Licence number', value: l.licence_no }, { title: 'Role', value: l.holder_role }, { title: 'Sport', value: `${l.sport}${l.discipline ? ` · ${l.discipline}` : ''}` }, ...(l.grade ? [{ title: 'Grade', value: l.grade }] : []), { title: 'Valid', value: `${ds(l.issued_on)} to ${ds(l.expires_on)}` }, ...(l.club ? [{ title: 'Club', value: l.club }] : []), { title: 'Verification code', value: l.public_code, meta: 'Anyone can confirm this licence with the code on Sportarena' }] }, closing] };
  }
  const r = await one(`SELECT s.*, e.name AS event_name, sp.name AS sport, rv.label AS rv_label, rv.version AS rv_version, u.display_name AS applicant FROM fed_sanctions s JOIN events e ON e.id=s.event_id JOIN sports sp ON sp.id=e.sport_id JOIN users u ON u.id=s.applicant_id LEFT JOIN ruleset_versions rv ON rv.id=s.ruleset_version_id WHERE s.id=$1`, [s.row.id]);
  if (r.status !== 'approved') throw conflict(`A sanction letter is issued for an approved sanction; this one is ${r.status}`);
  const cats = (r.approved_categories ?? r.categories ?? []).join(', ');
  return { ...head, title: 'Letter of sanction', addressee: r.applicant, reference: r.sanction_no, sections: [
    welcome(`${body.name} sanctions ${r.event_name} (${r.sport}) on the dates and conditions below.`),
    { title: 'Sanction', items: [{ title: 'Sanction number', value: r.sanction_no }, { title: 'Competition', value: r.event_name }, { title: 'Approved dates', value: `${ds(r.approved_starts_on)} to ${ds(r.approved_ends_on)}` }, ...(cats ? [{ title: 'Categories', value: cats }] : []), ...(r.rv_label ? [{ title: 'Rules', value: `${r.rv_label} v${r.rv_version}` }] : [])] },
    ...(r.conditions?.length ? [{ title: 'Conditions', items: r.conditions.map((x, n) => ({ title: `${n + 1}`, value: x })) }] : []), closing] };
}

cap({
  name: 'generate_federation_document', method: 'POST', path: '/federation/documents', tag: TAG, status: 201,
  summary: 'Issue the branded certificate of affiliation, licence document or sanction letter for a record in force, through the shared branded-document stack (templates, brand kit, encrypted PDF, append-only). The body\'s registrar/licensing/sanctioning officer or admin may add a statement and pick a published `federation_document` template of the body; the other party gets the default document. Each issue is a new immutable document.',
  input: z.object({ subject_type: z.enum(['affiliation', 'licence', 'sanction']), subject_id: id, note: text(1000).optional(), template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const s = await subjectFor(user, i.subject_type, i.subject_id);
    const perm = { affiliation: 'affiliations', licence: 'licences', sanction: 'sanctions' }[i.subject_type];
    const staff = staffCan(s, perm);
    if (!staff && !s.party) throw forbidden('Only the body\'s officers or the other party can issue this');
    if (!staff && (i.note || i.template_id)) throw forbidden('Only the body\'s officers can customise the document');
    const sourceType = KINDS[i.subject_type];
    if (!staff) {
      const existing = await one(`SELECT ${COLS} FROM generated_documents WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC, id LIMIT 1`, [sourceType, s.row.id]);
      if (existing) return view(existing);
    }
    let ver = null;
    if (i.template_id) {
      const t = await one('SELECT * FROM document_templates WHERE id=$1', [i.template_id]);
      await mustAccess(user, t, 'Template');
      if (!t || t.family !== 'federation_document' || t.organisation_id !== s.auth.body.organisation_id) throw badRequest('Pick one of this body\'s federation document templates');
      if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
      ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
      if (!ver) throw conflict('Publish the template before generating documents from it');
    }
    const layout = ver ? ver.layout : starterFor('federation_document', 'classic');
    const snapshot = await snapshotOf(s, i.note);
    const { buffer, pages } = await renderEnrolmentLetter({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'federation_document',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
      [did, sourceType, s.row.id, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    await tx((c) => logFed(c, s.row.body_id, i.subject_type, s.row.id, 'document_issued', { actor: user.id, detail: { document_id: did } }));
    return view(row);
  },
});

cap({
  name: 'list_federation_documents', method: 'GET', path: '/federation/documents', tag: TAG,
  summary: 'The certificates, licence documents and sanction letters issued for one record, newest first (the body\'s officers and the other party).',
  input: z.object({ subject_type: z.enum(['affiliation', 'licence', 'sanction']), subject_id: id, ...page }),
  async handler({ user }, i) {
    const s = await subjectFor(user, i.subject_type, i.subject_id);
    if (!s.party && (!s.auth || s.auth.viaAncestor)) throw notFound('Record');
    return (await many(`SELECT ${COLS} FROM generated_documents WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, [KINDS[i.subject_type], s.row.id, i.limit, i.offset])).map(view);
  },
});
