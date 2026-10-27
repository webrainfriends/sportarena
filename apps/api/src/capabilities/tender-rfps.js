// Tender zone, buyer side: guided RFP authoring, validation, approval, scheduled publication, addenda, schedule control, team and audit.
// The canonical record is proc_projects (shared with #458). Tender cards in the Billboard are projections of it, never a second copy.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { hasOrgGrant } from '../org-access.js';
import { isSupportedCurrency } from '../currency.js';
import { rubricSchema } from '../tender/scoring.js';
import { auditLog, assertMayCreate, buyerIds, buyerRoles, can, entityUserIds, getProject, lockProject, mandatesOf, requireBuyer, requireEntity, stageOf, tellUsers, verifyAudit, BUYER_ROLES, opening } from '../tender/core.js';
import { castVote, onApproved, onRejected, requestApproval } from '../tender/approvals.js';
import { cardOf, lotsOf, questionsOf, validateProject } from '../tender/rfp.js';
import { templateBody, questionT } from './tender-parties.js';

const TAG = 'Tender zone';
const dt = z.string().datetime({ offset: true });
const date = z.string().date();
const lotIn = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), title: z.string().min(2).max(120), description: z.string().max(1000).optional(), service_family: z.string().max(40).optional(), qty: z.number().positive().max(1e7), unit: z.string().max(30).optional(), estimate_minor: money.optional(), allow_partial: z.boolean().default(true), bundle_with: z.array(z.string()).max(20).default([]), starts_on: date.optional(), ends_on: date.optional(), site: z.string().max(120).optional() });
const credReq = z.object({ kind: z.enum(['insurance', 'safeguarding', 'safety_certificate', 'trade_licence', 'tax_registration', 'qualification', 'other']), title: z.string().max(120), verified_required: z.boolean().default(false) });
const SCALAR = ['title', 'objective', 'scope', 'inclusions', 'exclusions', 'category', 'location', 'contract_type', 'prep_start', 'service_start', 'service_end', 'teardown_end', 'currency', 'budget_minor', 'budget_public', 'ceiling_minor', 'cost_basis', 'publication', 'envelope_mode', 'timezone', 'publish_at', 'clarification_deadline', 'site_visit_at', 'site_visit_mandatory', 'closes_at', 'opens_at', 'evaluation_due', 'negotiation_due', 'award_target', 'standstill_days', 'allow_revision', 'allow_withdrawal', 'allow_alternatives', 'quorum', 'required_credentials', 'disclosure', 'fx', 'sites', 'renewal_options', 'renewal_term_months', 'renewal_ceiling_minor', 'notice_days', 'milestones', 'reserve_policy'];
const editable = z.object({
  title: z.string().min(3).max(140), objective: z.string().max(3000).nullable(), scope: z.string().max(10000).nullable(), inclusions: z.string().max(4000).nullable(), exclusions: z.string().max(4000).nullable(), category: z.string().min(2).max(40), location: z.string().max(200).nullable(),
  contract_type: z.enum(['one_off', 'fixed_term', 'recurring', 'framework']), prep_start: date.nullable(), service_start: date.nullable(), service_end: date.nullable(), teardown_end: date.nullable(),
  currency: z.string().length(3).refine(isSupportedCurrency, 'Unsupported currency'), budget_minor: money.nullable(), budget_public: z.boolean(), ceiling_minor: money.nullable(), cost_basis: z.enum(['net', 'gross']),
  publication: z.enum(['public', 'restricted', 'invite_only', 'private']), envelope_mode: z.enum(['open', 'sealed_single', 'sealed_dual']),
  timezone: z.string().max(60).refine((z0) => { try { new Intl.DateTimeFormat('en', { timeZone: z0 }); return true; } catch { return false; } }, 'Unknown time zone'),
  publish_at: dt.nullable(), clarification_deadline: dt.nullable(), site_visit_at: dt.nullable(), site_visit_mandatory: z.boolean(), closes_at: dt.nullable(), opens_at: dt.nullable(), evaluation_due: dt.nullable(), negotiation_due: dt.nullable(), award_target: dt.nullable(),
  standstill_days: z.number().int().min(0).max(60), allow_revision: z.boolean(), allow_withdrawal: z.boolean(), allow_alternatives: z.boolean(), quorum: z.number().int().min(1).max(10),
  required_credentials: z.array(credReq).max(20), disclosure: z.object({ rank: z.boolean().default(false), bidder_count: z.boolean().default(false), award_public: z.boolean().default(false) }),
  fx: z.object({ date: date, base: z.string().length(3), rates: z.record(z.string().length(3), z.string().regex(/^\d+(\.\d{1,8})?$/)) }).nullable(),
  sites: z.array(z.object({ venue_id: id.optional(), label: z.string().min(1).max(120) })).max(30),
  renewal_options: z.number().int().min(0).max(10), renewal_term_months: z.number().int().min(1).max(60).nullable(), renewal_ceiling_minor: money.nullable(), notice_days: z.number().int().min(0).max(365),
  milestones: z.array(z.object({ name: z.string().min(2).max(120), due_on: date, description: z.string().max(500).optional() })).max(30),
  reserve_policy: z.enum(['none', 'next_ranked']),
}).partial();

// ------------------------------------------------------------------ create & edit
async function applyStructure(c, pid, i) {
  if (i.lots) {
    const keep = i.lots.map((l) => l.code);
    await c.query('UPDATE proc_lots SET archived_at=now() WHERE project_id=$1 AND archived_at IS NULL AND NOT (code = ANY($2))', [pid, keep]);
    let pos = 0;
    for (const l of i.lots) await c.query(`INSERT INTO proc_lots(project_id, code, title, description, service_family, qty, unit, estimate_minor, allow_partial, bundle_with, starts_on, ends_on, site, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (project_id, code) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, service_family=EXCLUDED.service_family, qty=EXCLUDED.qty, unit=EXCLUDED.unit, estimate_minor=EXCLUDED.estimate_minor, allow_partial=EXCLUDED.allow_partial, bundle_with=EXCLUDED.bundle_with, starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on, site=EXCLUDED.site, position=EXCLUDED.position, archived_at=NULL`,
      [pid, l.code, l.title, l.description ?? null, l.service_family ?? null, l.qty, l.unit ?? null, l.estimate_minor ?? null, l.allow_partial ?? true, l.bundle_with ?? [], l.starts_on ?? null, l.ends_on ?? null, l.site ?? null, pos++]);
  }
  if (i.questions) {
    await c.query('UPDATE proc_questions SET archived_at=now() WHERE project_id=$1 AND archived_at IS NULL AND NOT (key = ANY($2))', [pid, i.questions.map((q) => q.key)]);
    let pos = 0;
    for (const q of i.questions) await c.query(`INSERT INTO proc_questions(project_id, key, section, prompt, type, options, unit, required, pass_fail, pass_value, evidence_required, lot_code, show_if, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (project_id, key) DO UPDATE SET section=EXCLUDED.section, prompt=EXCLUDED.prompt, type=EXCLUDED.type, options=EXCLUDED.options, unit=EXCLUDED.unit, required=EXCLUDED.required, pass_fail=EXCLUDED.pass_fail, pass_value=EXCLUDED.pass_value, evidence_required=EXCLUDED.evidence_required, lot_code=EXCLUDED.lot_code, show_if=EXCLUDED.show_if, position=EXCLUDED.position, archived_at=NULL`,
      [pid, q.key, q.section, q.prompt, q.type, q.options ? JSON.stringify(q.options) : null, q.unit ?? null, q.required ?? true, q.pass_fail ?? false, q.pass_value === undefined ? null : JSON.stringify(q.pass_value), q.evidence_required ?? false, q.lot_code ?? null, q.show_if ? JSON.stringify(q.show_if) : null, pos++]);
  }
}

cap({
  name: 'create_rfp', method: 'POST', path: '/rfps', tag: TAG, status: 201,
  summary: 'Start a tender (RFI to qualify suppliers, RFP to evaluate solutions, or RFQ for a price request) as the acting organisation and/or for an event you manage. The acting entity and event mandate are recorded on the tender; personal access, a supplier role or plain organisation membership do not authorise it. Optionally start from a template (lots, questionnaire and rubric are copied; no suppliers, prices or people are). Returns the draft.',
  input: z.object({ kind: z.enum(['rfi', 'rfp', 'rfq']).default('rfp'), title: z.string().min(3).max(140), category: z.string().min(2).max(40), organisation_id: id.optional(), event_id: id.optional(), venue_id: id.optional().describe('hire suppliers for a venue you own or manage'), template_id: id.optional(), sport: z.string().optional(), currency: z.string().length(3).default('INR'), contract_type: z.enum(['one_off', 'fixed_term', 'recurring', 'framework']).default('one_off'), timezone: z.string().max(60).default('UTC') }),
  async handler({ user }, i) {
    if (!isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    return tx(async (c) => {
      await assertMayCreate(user, i, c);
      let org = i.organisation_id ?? null;
      if (i.event_id && !org) org = (await c.query('SELECT organisation_id FROM events WHERE id=$1', [i.event_id])).rows[0]?.organisation_id ?? null;
      const venue = i.venue_id ? (await c.query('SELECT name, organisation_id FROM venues WHERE id=$1', [i.venue_id])).rows[0] : null;
      if (venue && !org) org = venue.organisation_id ?? null;
      const sport = i.sport ? (await c.query('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport])).rows[0] : null;
      if (i.sport && !sport) throw notFound('Sport');
      let tpl = null;
      if (i.template_id) {
        const t = (await c.query('SELECT * FROM proc_templates WHERE id=$1 AND archived_at IS NULL', [i.template_id])).rows[0];
        if (!t || (t.owner_user_id !== user.id && !(t.organisation_id && await hasOrgGrant(user, t.organisation_id, ['owner', 'admin'], c)))) throw notFound('Template');
        tpl = templateBody.parse(t.body);
      }
      const p = (await c.query(`INSERT INTO proc_projects(ref, kind, organisation_id, owner_user_id, event_id, venue_id, sites, title, category, sport_id, currency, contract_type, timezone, rubric, envelope_mode)
        VALUES ('TND-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('proc_ref_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [i.kind, org, user.id, i.event_id ?? null, i.venue_id ?? null, JSON.stringify(venue ? [{ venue_id: i.venue_id, label: venue.name }] : []), i.title, i.category, sport?.id ?? null, i.currency, tpl?.contract_type ?? i.contract_type, i.timezone, tpl?.rubric ?? null, tpl?.envelope_mode ?? 'sealed_dual'])).rows[0];
      if (tpl) await applyStructure(c, p.id, tpl);
      await auditLog(c, p.id, user.id, 'rfp_created', { kind: i.kind, organisation_id: org, event_id: i.event_id ?? null, venue_id: i.venue_id ?? null, template_id: i.template_id ?? null });
      return p;
    });
  },
});

cap({
  name: 'update_rfp', method: 'PATCH', path: '/rfps/:id', tag: TAG,
  summary: 'Edit a draft tender. Send the row_version you read (a stale one is a 409). Scalar fields, sites (with venue ids), required credentials, disclosure rules, the FX snapshot for comparison, and replace-by-code lists of lots and questions and the evaluation rubric. After approval a tender can no longer be edited here: use an addendum. Removed lots/questions are archived, not deleted.',
  input: z.object({ id, row_version: z.number().int(), sport: z.string().optional(), lots: z.array(lotIn).max(200).optional(), questions: z.array(questionT).max(300).optional(), rubric: rubricSchema.nullable().optional() }).extend(editable.shape),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'edit', c, { lock: true });
      if (p.status !== 'draft') throw conflict('Only a draft can be edited. Approved and published tenders change through addenda.');
      if (p.row_version !== i.row_version) throw conflict('Someone else changed this tender; reload and try again');
      const keys = SCALAR.filter((k) => i[k] !== undefined);
      const vals = keys.map((k) => (['required_credentials', 'disclosure', 'fx', 'sites', 'milestones'].includes(k) && i[k] !== null ? JSON.stringify(i[k]) : i[k]));
      if (i.sites) for (const s of i.sites) if (s.venue_id && !(await c.query('SELECT 1 FROM venues WHERE id=$1', [s.venue_id])).rowCount) throw notFound('Venue');
      const sets = keys.map((k, n) => `${k}=$${n + 3}`);
      if (i.sport !== undefined) { const sp = (await c.query('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport])).rows[0]; if (!sp) throw notFound('Sport'); sets.push(`sport_id=$${keys.length + 3}`); vals.push(sp.id); }
      if (i.rubric !== undefined) { sets.push(`rubric=$${vals.length + 3}`); vals.push(i.rubric === null ? null : JSON.stringify(i.rubric)); }
      const row = (await c.query(`UPDATE proc_projects SET ${sets.map((s) => `${s},`).join(' ')} row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`, [p.id, i.row_version, ...vals])).rows[0];
      await applyStructure(c, p.id, i);
      await auditLog(c, p.id, user.id, 'rfp_edited', { fields: [...keys, ...(i.lots ? ['lots'] : []), ...(i.questions ? ['questions'] : []), ...(i.rubric !== undefined ? ['rubric'] : [])] });
      return row;
    });
  },
});

cap({
  name: 'list_tender_documents', method: 'GET', path: '/rfps/:id/documents', tag: TAG,
  summary: 'The tender pack for the buying team: every document with who it is for, whether suppliers must acknowledge it for the site visit, who added it and when, and the version history of amended documents (an amendment is a new file that points at the one it replaced; the earlier file is archived, never deleted). Files themselves are uploaded with PUT /rfps/:id/files and opened from /tender-files/:id.',
  input: z.object({ id, include_archived: z.enum(['true', 'false']).default('false') }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    const rows = await many(`SELECT f.id, f.name, f.mime, f.bytes, f.audience, f.visit_pack, f.replaces_id, f.archived_at, f.created_at, u.handle AS added_by,
        (f.archived_at IS NULL) AS current, EXISTS (SELECT 1 FROM proc_visit_acks k WHERE k.file_id=f.id) AS acknowledged
      FROM proc_files f LEFT JOIN users u ON u.id=f.uploaded_by
      WHERE f.project_id=$1 AND f.entity_id IS NULL AND ($2 OR f.archived_at IS NULL) ORDER BY f.created_at`, [p.id, i.include_archived === 'true']);
    return { editable: p.status === 'draft' && can(roles, 'files'), documents: rows };
  },
});

cap({
  name: 'archive_tender_document', method: 'POST', path: '/rfps/:id/documents/:file_id/archive', tag: TAG,
  summary: 'Take a document out of a draft tender pack. It is archived, not deleted, and stays in the history. After approval the pack cannot lose a document: add the amended one and issue an addendum instead.',
  input: z.object({ id, file_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'files', c, { lock: true });
      if (p.status !== 'draft') throw conflict('After approval a document cannot be removed. Add the amended document as a new one and issue an addendum that says what changed.');
      const r = (await c.query('UPDATE proc_files SET archived_at=now() WHERE id=$1 AND project_id=$2 AND entity_id IS NULL AND archived_at IS NULL RETURNING id, name', [i.file_id, p.id])).rows[0];
      if (!r) throw notFound('File');
      await auditLog(c, p.id, user.id, 'file_archived', { file_id: r.id });
      return { id: r.id, archived: true };
    });
  },
});

cap({
  name: 'validate_rfp', method: 'POST', path: '/rfps/:id/validate', tag: TAG,
  summary: 'Check a tender before approval: missing scope, inconsistent dates, budget and currency, unknown bundles, questionnaire gaps, rubric weights. Errors block approval and publication; warnings do not.',
  input: z.object({ id }),
  async handler({ user }, i) { const { project } = await requireBuyer(user, i.id, 'view'); return validateProject(pool, project); },
});

cap({
  name: 'preview_rfp', method: 'GET', path: '/rfps/:id/preview', tag: TAG,
  summary: 'Preview exactly what suppliers will see: the public notice card, the restricted card, or the supplier view of the full pack (lots, questionnaire, schedule). Nothing confidential (budget unless published, rubric weights, other suppliers) is included.',
  input: z.object({ id, view: z.enum(['public', 'restricted', 'supplier']).default('public') }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'view');
    const card = await cardOf(p);
    if (i.view === 'public') return { view: 'public', card };
    if (i.view === 'restricted') return { view: 'restricted', card: { ...card, objective: undefined }, note: 'Restricted suppliers see the card and request access; the full pack opens after approval and terms.' };
    return { view: 'supplier', card, notice: { objective: p.objective, scope: p.scope, inclusions: p.inclusions, exclusions: p.exclusions, lots: await lotsOf(pool, p.id), questions: await questionsOf(pool, p.id), schedule: scheduleOf(p), required_credentials: p.required_credentials } };
  },
});

export const scheduleOf = (p) => Object.fromEntries(['publish_at', 'clarification_deadline', 'site_visit_at', 'closes_at', 'opens_at', 'evaluation_due', 'negotiation_due', 'award_target'].map((k) => [k, p[k] ? { local_timezone: p.timezone, utc: new Date(p[k]).toISOString() } : null]));

// ------------------------------------------------------------------ read
cap({
  name: 'list_my_rfps', method: 'GET', path: '/rfps', tag: TAG, summary: 'Tenders you run or are a team member of, newest first, with stage and counts.',
  input: z.object({ stage: z.string().max(20).optional(), organisation_id: id.optional(), event_id: id.optional(), q: z.string().max(80).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT p.* FROM proc_projects p WHERE ($2::uuid IS NULL OR p.organisation_id=$2) AND ($3::uuid IS NULL OR p.event_id=$3) AND ($4::text IS NULL OR p.title ILIKE $4 OR p.ref ILIKE $4)
      AND (p.owner_user_id=$1 OR EXISTS (SELECT 1 FROM proc_members m WHERE m.project_id=p.id AND m.user_id=$1 AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()))
        OR (p.venue_id IS NOT NULL AND EXISTS (SELECT 1 FROM venues vv WHERE vv.id=p.venue_id AND (vv.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff vs WHERE vs.venue_id=vv.id AND vs.user_id=$1 AND vs.role='manager' AND vs.removed_at IS NULL))))
        OR (p.organisation_id IS NOT NULL AND (EXISTS (SELECT 1 FROM organisation_members om WHERE om.organisation_id=p.organisation_id AND om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin')) OR EXISTS (SELECT 1 FROM proc_mandates pm WHERE pm.organisation_id=p.organisation_id AND pm.user_id=$1 AND pm.role='procurement_admin' AND pm.revoked_at IS NULL AND (pm.expires_at IS NULL OR pm.expires_at > now())))))
      ORDER BY p.created_at DESC, p.id LIMIT $5 OFFSET $6`, [user.id, i.organisation_id ?? null, i.event_id ?? null, i.q ? `%${i.q}%` : null, i.limit, i.offset]);
    const out = [];
    for (const p of rows) {
      const stage = stageOf(p);
      if (i.stage && stage !== i.stage) continue;
      const n = await one("SELECT (SELECT count(*)::int FROM proc_participants WHERE project_id=$1) AS participants, (SELECT count(*)::int FROM proc_proposals WHERE project_id=$1 AND status='submitted') AS submitted", [p.id]);
      out.push({ id: p.id, ref: p.ref, kind: p.kind, title: p.title, category: p.category, status: p.status, stage, publication: p.publication, closes_at: p.closes_at, organisation_id: p.organisation_id, event_id: p.event_id, venue_id: p.venue_id, row_version: p.row_version, ...n });
    }
    return out;
  },
});

cap({
  name: 'get_rfp', method: 'GET', path: '/rfps/:id', tag: TAG,
  summary: 'The full buyer-side view of a tender: fields, lots, questionnaire, team and your roles, approvals, schedule in local time and UTC, files, openings, and counts. Sealed proposal content is never included here.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    const [lots, questions, members, approvals, openings, counts, addenda, files, rounds] = await Promise.all([
      lotsOf(pool, p.id), questionsOf(pool, p.id),
      many("SELECT m.user_id, u.handle, u.display_name, m.role, m.expires_at, m.substitute_for FROM proc_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND m.revoked_at IS NULL ORDER BY m.created_at", [p.id]),
      many("SELECT a.id, a.kind, a.status, a.required, a.reason, a.requested_by, a.created_at, (SELECT count(*)::int FROM proc_approval_votes v WHERE v.approval_id=a.id AND v.decision='approve') AS approvals FROM proc_approvals a WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 30", [p.id]),
      many('SELECT envelope, round, opened_at, participants, hash FROM proc_openings WHERE project_id=$1 ORDER BY opened_at', [p.id]),
      one("SELECT (SELECT count(*)::int FROM proc_participants WHERE project_id=$1) AS participants, (SELECT count(*)::int FROM proc_proposals WHERE project_id=$1 AND status='submitted') AS proposals_submitted, (SELECT count(*)::int FROM proc_qna WHERE project_id=$1 AND answered_at IS NULL) AS questions_waiting", [p.id]),
      many('SELECT n, summary, material, rfp_version, issued_at FROM proc_addenda WHERE project_id=$1 ORDER BY n', [p.id]),
      many("SELECT id, name, mime, bytes, audience, visit_pack, created_at FROM proc_files WHERE project_id=$1 AND entity_id IS NULL AND archived_at IS NULL ORDER BY created_at", [p.id]),
      many('SELECT n, kind, invited, closes_at, note FROM proc_rounds WHERE project_id=$1 ORDER BY n', [p.id]),
    ]);
    const { fx, ...rest } = p;
    return { ...rest, fx, stage: stageOf(p), schedule: scheduleOf(p), my_roles: roles, can: ['edit', 'request_approval', 'approve', 'publish', 'addendum', 'schedule', 'invite', 'open', 'rank', 'recommend', 'scenario', 'members', 'audit', 'files', 'qna', 'order', 'rounds', 'gate', 'consensus', 'report', 'disqualify_request', 'score_technical', 'score_commercial'].filter((a) => can(roles, a)), lots, questions, members, approvals, openings, counts, addenda, files, rounds };
  },
});

// ------------------------------------------------------------------ team, conflicts
cap({
  name: 'set_rfp_member', method: 'POST', path: '/rfps/:id/members', tag: TAG,
  summary: 'Give a person a role on this tender (author, technical_evaluator, commercial_evaluator, chair, approver, opener, legal_reviewer, auditor, stakeholder), optionally until a date or as a substitute for someone, or revoke it (revoke: true). Approvers need approver authority from the organisation (a procurement mandate or owner/admin). Revocation takes effect on their next request; history stays in the audit trail.',
  input: z.object({ id, handle: z.string().min(2).max(40), role: z.enum(BUYER_ROLES.filter((r) => r !== 'owner')), expires_at: dt.optional(), substitute_for: z.string().max(40).optional(), revoke: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'members', c, { lock: true });
      const u = (await c.query('SELECT id, handle, display_name FROM users WHERE lower(handle)=lower($1)', [i.handle.replace(/^@/, '')])).rows[0];
      if (!u) throw notFound('Person');
      if (i.revoke) {
        await c.query('UPDATE proc_members SET revoked_at=now() WHERE project_id=$1 AND user_id=$2 AND role=$3 AND revoked_at IS NULL', [p.id, u.id, i.role]);
        await auditLog(c, p.id, user.id, 'member_revoked', { user_id: u.id, role: i.role });
        return { revoked: true };
      }
      if (i.role === 'approver' && p.organisation_id) {
        const ok = (await mandatesOf(u, p.organisation_id, p.event_id, c)).includes('approver') || await hasOrgGrant(u, p.organisation_id, ['owner', 'admin'], c);
        if (!ok) throw forbidden('That person has no approver authority in the organisation. Grant them a procurement mandate first.');
      }
      if (['technical_evaluator', 'commercial_evaluator', 'chair', 'opener', 'approver'].includes(i.role)) {
        const aff = await c.query("SELECT 1 FROM proc_participants pa JOIN supplier_entity_members m ON m.entity_id=pa.entity_id AND m.user_id=$2 AND m.status='active' WHERE pa.project_id=$1", [p.id, u.id]);
        if (aff.rowCount) throw conflict('That person works for a supplier taking part in this tender and cannot sit on the buyer team');
      }
      const sub = i.substitute_for ? (await c.query('SELECT id FROM users WHERE lower(handle)=lower($1)', [i.substitute_for.replace(/^@/, '')])).rows[0] : null;
      await c.query('INSERT INTO proc_members(project_id, user_id, role, expires_at, substitute_for, added_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, user_id, role) WHERE revoked_at IS NULL DO UPDATE SET expires_at=EXCLUDED.expires_at, substitute_for=EXCLUDED.substitute_for', [p.id, u.id, i.role, i.expires_at ?? null, sub?.id ?? null, user.id]);
      await auditLog(c, p.id, user.id, 'member_set', { user_id: u.id, role: i.role, expires_at: i.expires_at ?? null });
      await tellUsers(c, [u.id], p, 'tender_role', 'You were added to a tender', `You now have the ${i.role.replace(/_/g, ' ')} role on tender ${p.ref}.`, i.role);
      return { user_id: u.id, handle: u.handle, role: i.role, expires_at: i.expires_at ?? null };
    });
  },
});

cap({
  name: 'declare_rfp_conflict', method: 'POST', path: '/rfps/:id/conflicts', tag: TAG,
  summary: 'Declare whether you have a conflict of interest on this tender (or with one supplier). Evaluators must declare before scoring. A declared conflict with a supplier recuses you from that supplier\'s bids; supplier-affiliated people can never grade their own organisation.',
  input: z.object({ id, has_conflict: z.boolean(), entity_id: id.optional(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'view');
    if (i.has_conflict && !i.note) throw badRequest('Describe the conflict');
    const r = await one('INSERT INTO proc_conflicts(project_id, user_id, has_conflict, entity_id, note) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.id, user.id, i.has_conflict, i.entity_id ?? null, i.note ?? null]);
    await auditLog(pool, p.id, user.id, 'conflict_declared', { has_conflict: i.has_conflict, entity_id: i.entity_id ?? null });
    return r;
  },
});

// ------------------------------------------------------------------ approval & publication
async function planApproval(c, p, user) {
  const v = await validateProject(c, p);
  if (!v.ok) throw unprocessable('Fix the listed problems first', { issues: v.issues });
  return requestApproval(c, p, user, 'publish', { row_version: p.row_version, version: p.version }, null, p.budget_minor);
}

cap({
  name: 'request_rfp_approval', method: 'POST', path: '/rfps/:id/request-approval', tag: TAG,
  summary: 'Send a validated draft for approval before publication. The rubric is frozen when approved. The number of approvals depends on the organisation\'s thresholds; the requester can never be an approver of their own request.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'request_approval', c, { lock: true });
      if (p.status !== 'draft') throw conflict('Only a draft can be sent for approval');
      const a = await planApproval(c, p, user);
      await c.query("UPDATE proc_projects SET status='in_review', updated_at=now() WHERE id=$1", [p.id]);
      return a;
    });
  },
});

cap({
  name: 'decide_approval', method: 'POST', path: '/approvals/:id/decide', tag: TAG,
  summary: 'Approve or reject a pending request (publish, award, material addendum, disqualification, reinstatement, late submission, deadline extension, reissue). Approvers must differ from the requester; the final approval executes the decision in the same step. Rejecting needs a reason.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), reason: z.string().max(1000).optional() }),
  handler: ({ user }, i) => tx((c) => castVote(c, user, i.id, i.decision, i.reason)),
});

cap({
  name: 'list_pending_approvals', method: 'GET', path: '/approvals', tag: TAG, summary: 'Approvals waiting for you across the tenders where you are an approver (or owner).', input: z.object({ ...page }),
  async handler({ user }, i) {
    return many(`SELECT a.id, a.kind, a.required, a.reason, a.created_at, a.requested_by, p.id AS project_id, p.ref, p.title,
        (SELECT count(*)::int FROM proc_approval_votes v WHERE v.approval_id=a.id AND v.decision='approve') AS approvals
      FROM proc_approvals a JOIN proc_projects p ON p.id=a.project_id
      WHERE a.status='pending' AND a.requested_by <> $1 AND NOT EXISTS (SELECT 1 FROM proc_approval_votes v WHERE v.approval_id=a.id AND v.user_id=$1)
        AND (p.owner_user_id=$1 OR EXISTS (SELECT 1 FROM proc_members m WHERE m.project_id=p.id AND m.user_id=$1 AND m.role='approver' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())))
      ORDER BY a.created_at LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});

onApproved('publish', async (c, a, p) => {
  const frozen = p.rubric ? (p.rubric_frozen_at ? p.rubric_version : p.rubric_version + 1) : p.rubric_version;
  await c.query("UPDATE proc_projects SET status='approved', rubric_frozen_at = CASE WHEN rubric IS NULL THEN rubric_frozen_at ELSE coalesce(rubric_frozen_at, now()) END, rubric_version=$2, approvals_required=$3, updated_at=now() WHERE id=$1", [p.id, frozen, a.required]);
  await tellUsers(c, [a.requested_by], p, 'tender_approved', 'Tender approved', `Tender ${p.ref} is approved and ready to publish.`, 'approved');
});
onRejected('publish', async (c, a, p) => { await c.query("UPDATE proc_projects SET status='draft', row_version=row_version+1 WHERE id=$1", [p.id]); await tellUsers(c, [a.requested_by], p, 'tender_rejected', 'Tender sent back', `Tender ${p.ref} was not approved. Open it to see the reason.`, a.id); });

cap({
  name: 'publish_rfp', method: 'POST', path: '/rfps/:id/publish', tag: TAG,
  summary: 'Publish an approved tender now, or at its publish_at time (shown to suppliers only from then on). The tender must still validate. Invited suppliers and people with matching category alerts are notified.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'publish', c, { lock: true });
      if (p.status !== 'approved') throw conflict('Get the tender approved before publishing it');
      const v = await validateProject(c, p);
      if (!v.ok) throw unprocessable('The tender no longer validates', { issues: v.issues });
      const row = (await c.query("UPDATE proc_projects SET status='published', published_at=coalesce(publish_at, now()), version=version, updated_at=now() WHERE id=$1 RETURNING *", [p.id])).rows[0];
      await c.query("INSERT INTO proc_rounds(project_id, n, kind, created_by) VALUES ($1,1,'initial',$2) ON CONFLICT DO NOTHING", [p.id, user.id]);
      await auditLog(c, p.id, user.id, 'rfp_published', { publish_at: row.publish_at, closes_at: row.closes_at });
      const invited = (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1 AND status='invited'", [p.id])).rows;
      for (const r of invited) await tellUsers(c, await entityUserIds(r.entity_id, c, ['owner', 'bid_manager']), row, 'tender_invited', 'You are invited to a tender', `You are invited to respond to tender ${row.ref}. It closes ${new Date(row.closes_at).toISOString()}.`, 'invite');
      const alerts = (await c.query(`SELECT DISTINCT a.user_id FROM tender_alerts a LEFT JOIN sports s ON s.id=$4 WHERE a.archived_at IS NULL AND ($1::text = 'public') AND (a.category IS NULL OR lower(a.category)=lower($2)) AND (a.sport_slug IS NULL OR a.sport_slug=s.slug) AND (a.region IS NULL OR $3 ILIKE '%' || a.region || '%')`, [row.publication, row.category, row.location ?? '', row.sport_id])).rows;
      await tellUsers(c, alerts.map((r) => r.user_id), row, 'tender_alert', 'New tender in your categories', `A new tender "${row.title}" (${row.ref}) was published.`, 'alert');
      return row;
    });
  },
});

// ------------------------------------------------------------------ addenda & schedule control
const CHANGES = z.object({ scope: z.string().max(10000).optional(), inclusions: z.string().max(4000).optional(), exclusions: z.string().max(4000).optional(), objective: z.string().max(3000).optional(), clarification_deadline: dt.optional(), site_visit_at: dt.optional(), opens_at: dt.optional(), lots: z.array(lotIn).max(200).optional(), questions: z.array(questionT).max(300).optional(), rubric: rubricSchema.optional() });

cap({
  name: 'issue_addendum', method: 'POST', path: '/rfps/:id/addenda', tag: TAG, status: 201,
  summary: 'Publish a numbered addendum with its reason and the changed sections. A clarification-only addendum is issued at once. A material change (scope, lots, questions, rubric, schedule) needs approval and, once approved, bumps the tender version, notifies every participant, requires their acknowledgement before they can submit, and extends the deadline to at least 48 hours after issue. Rubric changes are refused once any proposal exists, so evaluation is never changed after bids are seen.',
  input: z.object({ id, summary: z.string().min(3).max(300), body: z.string().max(5000).optional(), reason: z.string().min(3).max(500), changes: CHANGES.default({}), new_closes_at: dt.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'addendum', c, { lock: true });
      if (!['published', 'approved'].includes(p.status)) throw conflict('Addenda apply to approved or published tenders');
      if (await opening(p.id, 'technical', 1, c)) throw conflict('Proposals are already open; the tender can no longer change');
      const material = Object.keys(i.changes).length > 0 || !!i.new_closes_at;
      if (i.changes.rubric && (await c.query("SELECT 1 FROM proc_proposals WHERE project_id=$1 AND status='submitted'", [p.id])).rowCount) throw conflict('Proposals have been submitted, so the evaluation rubric can no longer change. Cancel and reissue, or start a new round.');
      if (!material) return addendum(c, p, user, { ...i, material: false, changes: {} });
      const a = await requestApproval(c, p, user, 'material_change', { summary: i.summary, body: i.body ?? null, reason: i.reason, changes: i.changes, new_closes_at: i.new_closes_at ?? null, subject: `add:${i.summary.slice(0, 40)}` }, i.reason);
      return { approval_id: a.id, status: 'approval_pending', note: 'The material addendum takes effect when approved.' };
    });
  },
});

async function addendum(c, p, user, i) {
  const n = ((await c.query('SELECT coalesce(max(n),0)+1 AS n FROM proc_addenda WHERE project_id=$1', [p.id])).rows[0].n);
  const ver = i.material ? p.version + 1 : p.version;
  const row = (await c.query('INSERT INTO proc_addenda(project_id, n, summary, body, changed_sections, material, rfp_version, new_closes_at, reason, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [p.id, n, i.summary, i.body ?? null, Object.keys(i.changes ?? {}), i.material, ver, i.new_closes_at ?? null, i.reason, user.id])).rows[0];
  if (i.material) {
    const ch = i.changes ?? {};
    await applyStructure(c, p.id, ch);
    const sets = ['version=$2', 'row_version=row_version+1', 'updated_at=now()'], vals = [p.id, ver];
    for (const k of ['scope', 'inclusions', 'exclusions', 'objective', 'clarification_deadline', 'site_visit_at', 'opens_at']) if (ch[k] !== undefined) { vals.push(ch[k]); sets.push(`${k}=$${vals.length}`); }
    if (ch.rubric) { vals.push(JSON.stringify(ch.rubric)); sets.push(`rubric=$${vals.length}`, 'rubric_version=rubric_version+1'); }
    vals.push(i.new_closes_at ?? null); sets.push(`closes_at = CASE WHEN $${vals.length}::timestamptz IS NOT NULL THEN $${vals.length} WHEN closes_at IS NOT NULL THEN greatest(closes_at, now() + interval '48 hours') ELSE closes_at END`);
    await c.query(`UPDATE proc_projects SET ${sets.join(', ')} WHERE id=$1`, vals);
  }
  await auditLog(c, p.id, user.id, 'addendum_issued', { n, material: i.material, reason: i.reason });
  const parts = (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1 AND status IN ('invited','interested','requested','approved')", [p.id])).rows;
  for (const r of parts) await tellUsers(c, await entityUserIds(r.entity_id, c, ['owner', 'bid_manager']), p, 'tender_addendum', 'Addendum issued', `Tender ${p.ref}: addendum ${n}. ${i.summary}`, `add${n}`);
  return row;
}
onApproved('material_change', async (c, a, p, user) => { await addendum(c, await getProject(p.id, c), { id: a.requested_by }, { ...a.payload, material: true }); });

cap({
  name: 'acknowledge_addendum', method: 'POST', path: '/tenders/:id/addenda/:n/acknowledge', tag: TAG,
  summary: 'Record that your supplier entity has read an addendum. Every addendum must be acknowledged before you can submit.', input: z.object({ id, n: z.coerce.number().int().min(1), entity_id: id }),
  async handler({ user }, i) {
    await requireEntity(user, i.entity_id, ['owner', 'bid_manager', 'signatory']);
    const a = await one('SELECT 1 FROM proc_addenda WHERE project_id=$1 AND n=$2', [i.id, i.n]);
    if (!a) throw notFound('Addendum');
    await pool.query('INSERT INTO proc_addendum_acks(project_id, n, entity_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [i.id, i.n, i.entity_id, user.id]);
    return { acknowledged: true };
  },
});

cap({
  name: 'change_rfp_schedule', method: 'POST', path: '/rfps/:id/schedule', tag: TAG,
  summary: 'Extend the deadline (before it passes: at once; after it passes but before opening: needs approval, for outage recovery or an exceptional late window), suspend or resume submissions (resume can extend the deadline by the time suspended), cancel the tender, or allow one supplier a late window (needs approval). Every action needs a reason and is recorded in the append-only audit. Nothing changes once proposals are opened.',
  input: z.object({ id, action: z.enum(['extend', 'suspend', 'resume', 'cancel', 'late_window']), reason: z.string().min(5).max(500), new_closes_at: dt.optional(), entity_id: id.optional(), until: dt.optional(), extend_by_suspension: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'schedule', c, { lock: true });
      if (await opening(p.id, 'technical', 1, c) && i.action !== 'cancel') throw conflict('Proposals are already open');
      if (i.action === 'cancel') {
        if (['awarded', 'cancelled', 'archived'].includes(p.status)) throw conflict('This tender can no longer be cancelled');
        await c.query("UPDATE proc_projects SET status='cancelled', cancelled_reason=$2, updated_at=now() WHERE id=$1", [p.id, i.reason]);
        await auditLog(c, p.id, user.id, 'rfp_cancelled', { reason: i.reason });
        for (const r of (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1", [p.id])).rows) await tellUsers(c, await entityUserIds(r.entity_id, c), p, 'tender_cancelled', 'Tender cancelled', `Tender ${p.ref} was cancelled.`, 'cancel');
        return { status: 'cancelled' };
      }
      if (p.status !== 'published') throw conflict('Only a published tender has a live schedule');
      if (i.action === 'suspend') {
        if (p.suspended_at) throw conflict('Already suspended');
        await c.query('UPDATE proc_projects SET suspended_at=now(), suspend_reason=$2 WHERE id=$1', [p.id, i.reason]);
        await auditLog(c, p.id, user.id, 'rfp_suspended', { reason: i.reason });
        return { status: 'suspended' };
      }
      if (i.action === 'resume') {
        if (!p.suspended_at) throw conflict('Not suspended');
        const extra = i.extend_by_suspension && p.closes_at ? `closes_at = closes_at + (now() - suspended_at),` : '';
        const row = (await c.query(`UPDATE proc_projects SET ${extra} suspended_at=NULL, suspend_reason=NULL WHERE id=$1 RETURNING closes_at`, [p.id])).rows[0];
        await auditLog(c, p.id, user.id, 'rfp_resumed', { reason: i.reason, closes_at: row.closes_at });
        return { status: 'open', closes_at: row.closes_at };
      }
      if (i.action === 'late_window') {
        if (!i.entity_id || !i.until) throw badRequest('Say which supplier and until when');
        return requestApproval(c, p, user, 'late_submission', { entity_id: i.entity_id, until: i.until, subject: `late:${i.entity_id}` }, i.reason);
      }
      // extend
      if (!i.new_closes_at) throw badRequest('Give the new deadline');
      if (new Date(i.new_closes_at) <= new Date(p.closes_at)) throw badRequest('The new deadline must be later than the current one');
      if (new Date() < new Date(p.closes_at)) {
        await c.query('UPDATE proc_projects SET closes_at=$2, row_version=row_version+1 WHERE id=$1', [p.id, i.new_closes_at]);
        await auditLog(c, p.id, user.id, 'deadline_extended', { from: p.closes_at, to: i.new_closes_at, reason: i.reason });
        for (const r of (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1 AND status <> 'declined'", [p.id])).rows) await tellUsers(c, await entityUserIds(r.entity_id, c), p, 'tender_extended', 'Deadline extended', `Tender ${p.ref} now closes ${new Date(i.new_closes_at).toISOString()}.`, `ext${i.new_closes_at}`);
        return { status: 'extended', closes_at: i.new_closes_at };
      }
      return requestApproval(c, p, user, 'deadline_extension', { new_closes_at: i.new_closes_at, subject: 'extend' }, i.reason);
    });
  },
});
onApproved('deadline_extension', async (c, a, p) => {
  await c.query('UPDATE proc_projects SET closes_at=$2, row_version=row_version+1 WHERE id=$1', [p.id, a.payload.new_closes_at]);
  await auditLog(c, p.id, a.requested_by, 'deadline_extended_after_close', { to: a.payload.new_closes_at, approval_id: a.id });
  for (const r of (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1 AND status <> 'declined'", [p.id])).rows) await tellUsers(c, await entityUserIds(r.entity_id, c), p, 'tender_extended', 'Deadline extended', `Tender ${p.ref} reopened until ${a.payload.new_closes_at}.`, `ext2${a.payload.new_closes_at}`);
});
onApproved('late_submission', async (c, a, p) => { await auditLog(c, p.id, a.requested_by, 'late_window_granted', a.payload); });

cap({
  name: 'reissue_rfp', method: 'POST', path: '/rfps/:id/reissue', tag: TAG, status: 201,
  summary: 'Create a new draft from a cancelled or closed tender (lots, questionnaire, rubric and settings are copied; bids, awards, approvals and the schedule are not). The original keeps its full history and links to the new tender.',
  input: z.object({ id, reason: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'edit', c, { lock: true });
      if (!['cancelled', 'closed', 'awarded'].includes(p.status)) throw conflict('Only a cancelled, closed or awarded tender can be reissued');
      const n = (await c.query(`INSERT INTO proc_projects(ref, kind, parent_id, organisation_id, owner_user_id, event_id, sites, title, objective, scope, inclusions, exclusions, category, sport_id, location, contract_type, prep_start, service_start, service_end, teardown_end, currency, budget_minor, budget_public, ceiling_minor, cost_basis, publication, envelope_mode, timezone, site_visit_mandatory, standstill_days, allow_revision, allow_withdrawal, allow_alternatives, quorum, required_credentials, disclosure, rubric)
        SELECT 'TND-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('proc_ref_seq')::text, 5, '0'), kind, id, organisation_id, $2, event_id, sites, title, objective, scope, inclusions, exclusions, category, sport_id, location, contract_type, prep_start, service_start, service_end, teardown_end, currency, budget_minor, budget_public, ceiling_minor, cost_basis, publication, envelope_mode, timezone, site_visit_mandatory, standstill_days, allow_revision, allow_withdrawal, allow_alternatives, quorum, required_credentials, disclosure, rubric FROM proc_projects WHERE id=$1 RETURNING *`, [p.id, user.id])).rows[0];
      await c.query('UPDATE proc_projects n SET renewal_options=o.renewal_options, renewal_term_months=o.renewal_term_months, renewal_ceiling_minor=o.renewal_ceiling_minor, notice_days=o.notice_days, milestones=o.milestones, reserve_policy=o.reserve_policy FROM proc_projects o WHERE o.id=$1 AND n.id=$2', [p.id, n.id]);
      await c.query('INSERT INTO proc_lots(project_id, code, title, description, service_family, qty, unit, estimate_minor, allow_partial, bundle_with, starts_on, ends_on, site, position) SELECT $2, code, title, description, service_family, qty, unit, estimate_minor, allow_partial, bundle_with, starts_on, ends_on, site, position FROM proc_lots WHERE project_id=$1 AND archived_at IS NULL', [p.id, n.id]);
      await c.query('INSERT INTO proc_questions(project_id, key, section, prompt, type, options, unit, required, pass_fail, pass_value, evidence_required, lot_code, show_if, position) SELECT $2, key, section, prompt, type, options, unit, required, pass_fail, pass_value, evidence_required, lot_code, show_if, position FROM proc_questions WHERE project_id=$1 AND archived_at IS NULL', [p.id, n.id]);
      await auditLog(c, p.id, user.id, 'rfp_reissued', { new_id: n.id, reason: i.reason });
      await auditLog(c, n.id, user.id, 'rfp_created', { reissued_from: p.id, reason: i.reason });
      return n;
    });
  },
});

cap({
  name: 'archive_rfp', method: 'POST', path: '/rfps/:id/archive', tag: TAG, summary: 'Archive a finished tender (closed, awarded or cancelled). Nothing is deleted; it leaves the active list and keeps its full history.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'schedule', c, { lock: true });
      if (!['closed', 'awarded', 'cancelled'].includes(p.status)) throw conflict('Only a finished tender can be archived');
      await c.query("UPDATE proc_projects SET status='archived' WHERE id=$1", [p.id]);
      await auditLog(c, p.id, user.id, 'rfp_archived', {});
      return { status: 'archived' };
    });
  },
});

cap({
  name: 'get_rfp_audit', method: 'GET', path: '/rfps/:id/audit', tag: TAG, summary: 'The append-only audit trail of a tender (auditor, owner or chair) with a check that the hash chain is intact.', input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    if (!can(roles, 'audit') && !can(roles, 'rank')) throw forbidden('Only the owner, chair or an auditor can read the audit trail');
    const rows = await many('SELECT a.id, a.action, a.detail, a.at, u.handle AS actor FROM proc_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.project_id=$1 ORDER BY a.id LIMIT $2 OFFSET $3', [p.id, i.limit, i.offset]);
    return { chain_broken_at: await verifyAudit(p.id), entries: rows };
  },
});
