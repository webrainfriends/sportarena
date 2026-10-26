// Tender zone: reports and exports, bounded asynchronous export jobs, and the assistive-AI controls. The manual workflow never depends on
// AI: with no key configured every capability here still works (suggestions are simply absent). AI never scores, ranks, disqualifies,
// negotiates or awards, supplier text is quoted as untrusted data, and every AI call is recorded with model, input hash and output.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { toCsv } from '../csv.js';
import { enqueue, runJobs } from '../jobs.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { askJson, aiConfigured, aiModel, quoteData, AI_RULES, z as zz } from '../ai.js';
import { auditLog, buyerRoles, can, entityUserIds, getProject, readEnvelope, requireBuyer, requireEntity } from '../tender/core.js';
import { buyerReport, supplierReport, flatten } from '../tender/reports.js';
import { xlsx, zip } from '../tender/xlsx.js';
import { validateProject, lotsOf, questionsOf } from '../tender/rfp.js';
import { currentSubmission, reviewerChecks } from '../tender/evaluation.js';
import { checklist } from './tender-proposals.js';
import { readDraft } from './tender-proposals.js';
import { tenderDocument } from '../tender/documents.js';
import { notify } from '../notify.js';

const TAG = 'Tender zone';
const filters = z.object({ organisation_id: id.optional(), event_id: id.optional(), category: z.string().max(40).optional(), stage: z.string().max(20).optional(), currency: z.string().length(3).optional(), from: z.string().date().optional(), to: z.string().date().optional(), date_basis: z.enum(['published', 'created', 'closing']).default('published'), entity_id: id.optional() });
const reportOf = async (user, scope, f) => (scope === 'supplier' ? supplierReport(user, f) : buyerReport(user, f));

cap({
  name: 'tender_report', method: 'GET', path: '/procurement/reports', tag: TAG,
  summary: 'Reports. Buyer: sourcing pipeline by stage, publication and upcoming deadlines, participation and conversion (with denominators), qualification outcomes, reviewer workload, competition, cycle time, committed spend and call-offs per currency, observed and forecast savings against the tender\'s own published budget, unfilled lots, and venue/date overlap warnings. Supplier: invitations, drafts and submissions, clarification deadlines, success rate (with its denominator) and the awarded order pipeline. Filter by organisation, event, category, stage, currency and date range; the date basis is stated in the result. Currencies are never added together.',
  input: z.object({ scope: z.enum(['buyer', 'supplier']).default('buyer'), ...filters.shape }),
  handler: ({ user }, i) => { const { scope, ...f } = i; return reportOf(user, scope, f); },
});

cap({
  name: 'export_tender_report_now', method: 'GET', path: '/procurement/reports/export', tag: TAG,
  summary: 'Download a small report as CSV or XLSX straight away (up to 5,000 rows, safe against spreadsheet formula injection). It is built from the same object as the dashboard, so the totals reconcile. For anything larger use request_tender_export, which runs in the background. Returns the file as text (csv) or base64 (xlsx).',
  input: z.object({ scope: z.enum(['buyer', 'supplier']).default('buyer'), format: z.enum(['csv', 'xlsx']).default('csv'), ...filters.shape }),
  async handler({ user }, i) {
    const { scope, format, ...f } = i;
    const rows = flatten(await reportOf(user, scope, f));
    const body = format === 'xlsx' ? xlsx([['metric', 'value'], ...rows.map((r) => [r.metric, typeof r.value === 'number' ? r.value : String(r.value)])], 'Report') : toCsv(['metric', 'value'], rows);
    return { filename: `tender-report-${scope}.${format}`, content_type: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', encoding: format === 'xlsx' ? 'base64' : 'utf8', data: format === 'xlsx' ? body.toString('base64') : body, rows: rows.length, truncated: rows.length >= 5000 };
  },
});

cap({
  name: 'request_tender_export', method: 'POST', path: '/procurement/exports', tag: TAG, status: 202,
  summary: 'Start a background export: a report as CSV or XLSX, or a tender pack (notice, lots, questionnaire, published Q&A and addenda as a ZIP) for a tender you run. The worker builds it, stores it encrypted, and you download it with get_tender_export. Bounded to 5,000 report rows and 200 pack entries.',
  input: z.object({ kind: z.enum(['report', 'tender_pack']), format: z.enum(['csv', 'xlsx', 'zip']), scope: z.enum(['buyer', 'supplier']).default('buyer'), project_id: id.optional(), ...filters.shape }),
  async handler({ user }, i) {
    if (i.kind === 'tender_pack') { if (!i.project_id || i.format !== 'zip') throw badRequest('A tender pack is a ZIP for one tender'); await requireBuyer(user, i.project_id, 'view'); }
    else if (!['csv', 'xlsx'].includes(i.format)) throw badRequest('Reports export as CSV or XLSX');
    return tx(async (c) => {
      const { kind, format, ...params } = i;
      const row = (await c.query('INSERT INTO proc_exports(user_id, kind, format, params) VALUES ($1,$2,$3,$4) RETURNING id, status, kind, format, created_at', [user.id, kind, format, JSON.stringify(params)])).rows[0];
      await enqueue(c, { category: 'tender', kind: 'tender.export', payload: { export_id: row.id }, dedupeKey: `tender.export:${row.id}` });
      return row;
    });
  },
});

cap({
  name: 'list_tender_exports', method: 'GET', path: '/procurement/exports', tag: TAG, summary: 'Your background exports, newest first, with their status.', input: z.object({ ...page }),
  handler: ({ user }, i) => many('SELECT id, kind, format, status, name, row_count, truncated, error, created_at, completed_at FROM proc_exports WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_tender_export', method: 'GET', path: '/procurement/exports/:id', tag: TAG,
  summary: 'Status of a background export and, when ready, the file (text for CSV, base64 for XLSX and ZIP). Only the person who requested it can read it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await one('SELECT * FROM proc_exports WHERE id=$1 AND user_id=$2', [i.id, user.id]);
    if (!x) throw notFound('Export');
    if (x.status !== 'ready') return { id: x.id, status: x.status, error: x.error };
    const buf = await loadEncrypted('procurement', 'proc_exports.stored', x.stored);
    return { id: x.id, status: 'ready', filename: x.name, content_type: x.mime, encoding: x.format === 'csv' ? 'utf8' : 'base64', data: x.format === 'csv' ? buf.toString('utf8') : buf.toString('base64'), rows: x.row_count, truncated: x.truncated };
  },
});

async function buildPack(user, projectId) {
  const { project: p } = await requireBuyer(user, projectId, 'view');
  const files = [], push = (name, data) => files.push({ name, data });
  push('notice.pdf', (await tenderDocument(user, 'notice', p.id)).buffer);
  push('lots.csv', toCsv(['code', 'title', 'qty', 'unit', 'description'], await lotsOf(pool, p.id)));
  push('questionnaire.csv', toCsv(['key', 'section', 'prompt', 'type', 'required', 'lot_code'], await questionsOf(pool, p.id)));
  push('qna.csv', toCsv(['question', 'answer', 'answered_at'], await many('SELECT question, answer, answered_at FROM proc_qna WHERE project_id=$1 AND published AND answered_at IS NOT NULL ORDER BY created_at LIMIT 200', [p.id])));
  for (const a of await many('SELECT n FROM proc_addenda WHERE project_id=$1 ORDER BY n LIMIT 100', [p.id])) push(`addendum-${a.n}.pdf`, (await tenderDocument(user, 'addendum', p.id, { n: a.n })).buffer);
  return { buf: zip(files), rows: files.length };
}

const handlers = {
  'tender.export': async ({ export_id }) => {
    const x = await one('SELECT * FROM proc_exports WHERE id=$1', [export_id]);
    if (!x || x.status !== 'queued') return;
    try {
      const user = await one('SELECT id, roles FROM users WHERE id=$1', [x.user_id]);
      let buf, mime, name, rows, truncated = false;
      if (x.kind === 'tender_pack') { const r = await buildPack(user, x.params.project_id); buf = r.buf; rows = r.rows; mime = 'application/zip'; name = 'tender-pack.zip'; }
      else {
        const { scope = 'buyer', ...f } = x.params;
        const flat = flatten(await reportOf(user, scope, f)); rows = flat.length; truncated = flat.length >= 5000;
        if (x.format === 'xlsx') { buf = xlsx([['metric', 'value'], ...flat.map((r) => [r.metric, typeof r.value === 'number' ? r.value : String(r.value)])], 'Report'); mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
        else { buf = Buffer.from(toCsv(['metric', 'value'], flat)); mime = 'text/csv; charset=utf-8'; }
        name = `tender-report-${scope}.${x.format}`;
      }
      const { file } = await saveEncrypted('procurement', 'proc_exports.stored', buf);
      await pool.query("UPDATE proc_exports SET status='ready', stored=$2, name=$3, mime=$4, row_count=$5, truncated=$6, completed_at=now() WHERE id=$1", [x.id, file, name, mime, rows, truncated]);
    } catch (e) {
      await pool.query("UPDATE proc_exports SET status='failed', error=$2, completed_at=now() WHERE id=$1", [x.id, String(e.message).slice(0, 300)]);
    }
  },
};
export const runTenderJobs = () => runJobs('tender', handlers);

/** Deadline reminders: suppliers who took part but have not submitted are told once, in the last 24 hours before close. Idempotent per person and tender. */
export async function sendTenderReminders() {
  const rows = await many(`SELECT p.id, p.ref, p.title, p.closes_at, pa.entity_id FROM proc_projects p JOIN proc_participants pa ON pa.project_id=p.id AND pa.status IN ('invited','interested','approved')
    WHERE p.status='published' AND p.suspended_at IS NULL AND p.closes_at > now() AND p.closes_at <= now() + interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM proc_proposals pr WHERE pr.project_id=p.id AND pr.entity_id=pa.entity_id AND pr.status='submitted')`);
  let n = 0;
  for (const x of rows) for (const uid of await entityUserIds(x.entity_id, pool, ['owner', 'bid_manager', 'signatory'])) {
    const sent = await notify(null, uid, { kind: 'tender_deadline', title: 'Tender closes soon', body: `Tender ${x.ref} closes ${new Date(x.closes_at).toISOString()} and you have not submitted yet.`, data: { project_id: x.id, ref: x.ref }, dedupe_key: `tender_deadline:${x.id}:${uid}` });
    if (sent) n++;
  }
  return n;
}

// ------------------------------------------------------------------ assistive AI (optional, controlled)
const recordRun = (projectId, userId, purpose, input, output) => pool.query('INSERT INTO proc_ai_runs(project_id, user_id, purpose, model, input_hash, output) VALUES ($1,$2,$3,$4,$5,$6)', [projectId, userId, purpose, aiConfigured() ? aiModel() : null, createHash('sha256').update(JSON.stringify(input)).digest('hex'), output ? JSON.stringify(output) : null]);
const SUGGEST = zz.object({ suggestions: zz.array(zz.object({ field: zz.string().max(60), suggestion: zz.string().max(300) })).max(8) });

cap({
  name: 'tender_ai_checklist', method: 'POST', path: '/rfps/:id/ai/checklist', tag: TAG,
  summary: 'Authoring checklist for a draft tender. The checklist itself is deterministic (the same checks that gate approval) and always works. When an AI model is configured it may add a few drafting suggestions; they are suggestions only, you edit and decide, and the tender text is sent as quoted data. With AI off or unavailable the checklist is returned without suggestions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'edit');
    const base = await validateProject(pool, p);
    let suggestions = [];
    if (aiConfigured()) {
      const input = { title: quoteData(p.title), scope: quoteData(p.scope, 1500), lots: (await lotsOf(pool, p.id)).map((l) => quoteData(l.title, 80)) };
      const out = await askJson({ system: `You help a buyer write a clear sports-services tender. Suggest up to 8 concrete improvements to unclear or missing scope, acceptance criteria or evidence requirements. ${AI_RULES}`, user: `<data>${JSON.stringify(input)}</data>`, schema: SUGGEST, shape: '{"suggestions":[{"field":"scope","suggestion":"..."}]}' });
      suggestions = out?.suggestions ?? [];
      await recordRun(p.id, user.id, 'authoring_checklist', input, out);
    }
    return { ...base, ai: { available: aiConfigured(), suggestions, note: 'Suggestions are drafts for you to review. They never change the tender.' } };
  },
});

cap({
  name: 'tender_ai_proposal_checklist', method: 'POST', path: '/proposals/:id/ai/checklist', tag: TAG,
  summary: 'Supplier: the deterministic list of unanswered or invalid items in your proposal (always available), plus, when AI is configured, plain-language hints about the tender\'s questions. Your proposal text is not sent to the model and nothing is submitted for you.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const pr = await one('SELECT * FROM proc_proposals WHERE id=$1', [i.id]);
    if (!pr) throw notFound('Proposal');
    await requireEntity(user, pr.entity_id);
    const p = await getProject(pr.project_id);
    const part = await one('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, pr.entity_id]);
    const base = await checklist(pool, p, pr, readDraft(pr), part);
    let hints = [];
    if (aiConfigured()) {
      const qs = (await questionsOf(pool, p.id)).map((q) => ({ key: q.key, prompt: quoteData(q.prompt, 200), required: q.required, evidence_required: q.evidence_required }));
      const out = await askJson({ system: `You help a supplier understand what a tender asks for. For each of up to 8 questions say in plain words what a strong answer covers. ${AI_RULES}`, user: `<data>${JSON.stringify(qs)}</data>`, schema: SUGGEST, shape: '{"suggestions":[{"field":"question key","suggestion":"..."}]}' });
      hints = out?.suggestions ?? [];
      await recordRun(p.id, user.id, 'proposal_checklist', { questions: qs.length }, out);
    }
    return { ...base, ai: { available: aiConfigured(), hints } };
  },
});

const SUMMARY = zz.object({ points: zz.array(zz.object({ text: zz.string().max(400), source: zz.object({ question_key: zz.string().max(40) }) })).max(12), uncertainty: zz.string().max(400) });

cap({
  name: 'tender_ai_evidence_summary', method: 'POST', path: '/rfps/:id/proposals/:pid/ai/summary', tag: TAG,
  summary: 'Reviewer aid: summarise the evidence in ONE opened technical envelope you are assigned to, as points that each cite the question they come from, with a stated uncertainty. Supplier text is sent as untrusted quoted data and never as instructions; no other supplier\'s content is included; points without a valid source are dropped. The model, input hash and output are recorded. It never scores, ranks, qualifies or decides. With AI off this returns available:false and the manual evaluation is unaffected.',
  input: z.object({ id, pid: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p, roles } = await requireBuyer(user, i.id, 'read_technical', c);
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.pid, p.id])).rows[0];
      if (!pr || pr.status !== 'submitted') throw notFound('Proposal');
      await reviewerChecks(c, p, user, pr);
      if (!aiConfigured()) return { available: false, note: 'AI assistance is not enabled. Evaluate from the proposal directly.' };
      const sub = await currentSubmission(c, pr);
      const content = await readEnvelope(user, roles, p, sub, 'technical', c);
      const qs = await questionsOf(c, p.id);
      const known = new Set(qs.map((q) => q.key));
      const input = { questions: qs.filter((q) => q.section !== 'commercial').map((q) => ({ key: q.key, prompt: quoteData(q.prompt, 160) })), answers: Object.fromEntries(Object.entries(content.answers ?? {}).filter(([k]) => known.has(k)).map(([k, v]) => [k, quoteData(typeof v === 'string' ? v : JSON.stringify(v), 700)])) };
      const out = await askJson({ system: `You assist a tender evaluator. Summarise what the supplier's answers actually say, one point per finding, each citing the question key it comes from. State plainly what is missing or unclear. Never recommend a score or a decision. ${AI_RULES}`, user: `<data>${JSON.stringify(input)}</data>`, schema: SUMMARY, shape: '{"points":[{"text":"...","source":{"question_key":"..."}}],"uncertainty":"..."}', maxTokens: 1000 });
      const points = (out?.points ?? []).filter((x) => known.has(x.source.question_key));
      const result = { available: true, points, dropped_without_source: (out?.points?.length ?? 0) - points.length, uncertainty: out?.uncertainty ?? 'The model gave no usable answer; read the proposal directly.', model: aiModel(), note: 'Assistive only. Official scores are given by people against the frozen rubric.' };
      await c.query('INSERT INTO proc_ai_runs(project_id, user_id, purpose, model, input_hash, output) VALUES ($1,$2,$3,$4,$5,$6)', [p.id, user.id, 'evidence_summary', aiModel(), createHash('sha256').update(JSON.stringify(input)).digest('hex'), JSON.stringify(result)]);
      await auditLog(c, p.id, user.id, 'ai_summary', { proposal_id: pr.id });
      return result;
    });
  },
});
