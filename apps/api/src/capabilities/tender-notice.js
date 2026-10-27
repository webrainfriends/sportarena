// Tender zone, discovery and participation: the allowlisted Billboard cards, the notice a supplier reads, eligibility checks, interest /
// request / terms / NDA, clarifications (common Q&A), site visits, saved tenders and category alerts. A public notice never makes
// attachments, proposals or bidder identities public.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { auditLog, buyerIds, entityUserIds, getProject, myEntityIds, noticeAccess, requireBuyer, requireEntity, stageOf, tellUsers } from '../tender/core.js';
import { cardOf, credentialCheck, lotsOf, questionsOf, visitDocs } from '../tender/rfp.js';
export { credentialCheck };
import { scheduleOf } from './tender-rfps.js';

const TAG = 'Tender zone';

// ------------------------------------------------------------------ discovery
cap({
  name: 'list_tenders', method: 'GET', path: '/tenders', tag: TAG,
  summary: 'The Tender zone inside the Billboard: published tenders you are allowed to see, as allowlisted cards (reference, issuer and verified status, category, sport, sites, service dates, deadline with time zone and UTC, stage, who may take part, budget only if the issuer published it). Filter by issuer, category, sport, location, event, service period, deadline, procurement type, stage and saved. Stable sort and pagination. Restricted, invite-only and private tenders are invisible to people they do not concern.',
  input: z.object({ q: z.string().max(80).optional(), category: z.string().max(40).optional(), sport: z.string().max(60).optional(), location: z.string().max(80).optional(), event_id: id.optional(), issuer: z.string().max(80).optional(), kind: z.enum(['rfi', 'rfp', 'rfq']).optional(),
    service_from: z.string().date().optional(), service_to: z.string().date().optional(), closes_before: z.string().datetime({ offset: true }).optional(), stage: z.enum(['open', 'closing_soon', 'closed', 'awarded', 'all']).default('open'), saved: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional().describe('only tenders my supplier entities take part in'),
    sort: z.enum(['closes_at', 'published', 'title']).default('closes_at'), ...page }),
  async handler({ user }, i) {
    const ents = await myEntityIds(user);
    const args = [user.id, ents, i.q ? `%${i.q}%` : null, i.category?.toLowerCase() ?? null, i.sport ?? null, i.location ? `%${i.location}%` : null, i.event_id ?? null, i.issuer ? `%${i.issuer}%` : null, i.kind ?? null, i.service_from ?? null, i.service_to ?? null, i.closes_before ?? null, i.stage, !!i.saved, !!i.mine];
    const order = { closes_at: 'p.closes_at ASC NULLS LAST, p.id', published: 'p.published_at DESC, p.id', title: 'lower(p.title), p.id' }[i.sort];
    const rows = (await pool.query(`SELECT p.* FROM proc_projects p LEFT JOIN sports s ON s.id=p.sport_id LEFT JOIN organisations o ON o.id=p.organisation_id LEFT JOIN users ou ON ou.id=p.owner_user_id
      WHERE p.status IN ('published','evaluation','award','awarded','closed') AND (p.publish_at IS NULL OR p.publish_at <= now())
        AND (p.publication = 'public' OR (p.publication = 'restricted' AND cardinality($2::uuid[]) > 0) OR EXISTS (SELECT 1 FROM proc_participants pa WHERE pa.project_id=p.id AND pa.entity_id = ANY($2) AND pa.status <> 'declined'))
        AND ($3::text IS NULL OR p.title ILIKE $3 OR p.ref ILIKE $3 OR p.scope ILIKE $3) AND ($4::text IS NULL OR lower(p.category)=$4) AND ($5::text IS NULL OR s.slug=$5)
        AND ($6::text IS NULL OR p.location ILIKE $6) AND ($7::uuid IS NULL OR p.event_id=$7) AND ($8::text IS NULL OR o.name ILIKE $8 OR ou.display_name ILIKE $8) AND ($9::text IS NULL OR p.kind=$9)
        AND ($10::date IS NULL OR p.service_end >= $10) AND ($11::date IS NULL OR p.service_start <= $11) AND ($12::timestamptz IS NULL OR p.closes_at <= $12)
        AND (CASE $13 WHEN 'open' THEN p.status='published' AND p.suspended_at IS NULL AND p.closes_at > now()
                      WHEN 'closing_soon' THEN p.status='published' AND p.suspended_at IS NULL AND p.closes_at > now() AND p.closes_at < now() + interval '7 days'
                      WHEN 'closed' THEN p.status IN ('published','evaluation','award') AND p.closes_at <= now()
                      WHEN 'awarded' THEN p.status IN ('awarded','closed') ELSE true END)
        AND (NOT $14 OR EXISTS (SELECT 1 FROM tender_saved sv WHERE sv.project_id=p.id AND sv.user_id=$1 AND sv.removed_at IS NULL))
        AND (NOT $15 OR EXISTS (SELECT 1 FROM proc_participants pa WHERE pa.project_id=p.id AND pa.entity_id = ANY($2)))
      ORDER BY ${order} LIMIT ${i.limit} OFFSET ${i.offset}`, args)).rows;
    const saved = new Set((await many('SELECT project_id FROM tender_saved WHERE user_id=$1 AND removed_at IS NULL AND project_id = ANY($2)', [user.id, rows.map((r) => r.id)])).map((r) => r.project_id));
    const mine = new Map((await many('SELECT project_id, status FROM proc_participants WHERE entity_id = ANY($1) AND project_id = ANY($2)', [ents, rows.map((r) => r.id)])).map((r) => [r.project_id, r.status]));
    return Promise.all(rows.map(async (p) => ({ ...(await cardOf(p)), saved: saved.has(p.id), my_participation: mine.get(p.id) ?? null })));
  },
});

cap({
  name: 'get_tender', method: 'GET', path: '/tenders/:id', tag: TAG,
  summary: 'The notice: objective, scope, lots, schedule in local time and UTC, what is required to take part, addenda, common Q&A, files you may download, and your own participation and proposals. Restricted tenders show only the card until you are approved. Competing suppliers, bidder counts and ranks are never shown unless the tender\'s published policy discloses them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await getProject(i.id);
    const acc = await noticeAccess(user, p);
    const card = await cardOf(p);
    const restricted = !acc.buyer.length && p.publication !== 'public' && !(acc.part && ['invited', 'approved'].includes(acc.part.status));
    const base = { card, my_participation: acc.part, saved: !!(await one('SELECT 1 FROM tender_saved WHERE user_id=$1 AND project_id=$2 AND removed_at IS NULL', [user.id, p.id])), stage: stageOf(p), restricted_view: restricted, is_buyer: acc.buyer.length > 0 };
    if (restricted) return base;
    const participating = acc.buyer.length || (acc.part && ['invited', 'approved', 'interested'].includes(acc.part.status));
    const termsOk = acc.buyer.length || !!acc.part?.terms_accepted_at;
    const files = await many(`SELECT id, name, mime, bytes, audience, visit_pack FROM proc_files WHERE project_id=$1 AND entity_id IS NULL AND archived_at IS NULL AND scan='clean' AND (audience='public' OR ($2 AND audience='participants')) ORDER BY created_at`, [p.id, !!(participating && termsOk)]);
    const visit_acks = acc.entityIds.length ? await many('SELECT file_id, entity_id, acknowledged_at FROM proc_visit_acks WHERE project_id=$1 AND entity_id = ANY($2)', [p.id, acc.entityIds]) : [];
    const addenda = await many('SELECT n, summary, body, material, rfp_version, issued_at FROM proc_addenda WHERE project_id=$1 ORDER BY n', [p.id]);
    const unack = acc.entityIds.length ? await many('SELECT a.n FROM proc_addenda a WHERE a.project_id=$1 AND NOT EXISTS (SELECT 1 FROM proc_addendum_acks k WHERE k.project_id=a.project_id AND k.n=a.n AND k.entity_id = ANY($2))', [p.id, acc.entityIds]) : [];
    const outcome = p.disclosure?.award_public ? (await one("SELECT record, published_at FROM proc_award_publications WHERE project_id=$1 AND status='published'", [p.id])) : null;
    return { ...base, notice: { objective: p.objective, scope: p.scope, inclusions: p.inclusions, exclusions: p.exclusions, lots: await lotsOf(pool, p.id), schedule: scheduleOf(p), site_visit_mandatory: p.site_visit_mandatory, required_credentials: p.required_credentials, envelope_mode: p.envelope_mode, allow_alternatives: p.allow_alternatives, allow_revision: p.allow_revision, allow_withdrawal: p.allow_withdrawal, cost_basis: p.cost_basis, currency: p.currency, contract_type: p.contract_type, terms: { renewal_options: p.renewal_options, renewal_term_months: p.renewal_term_months, renewal_ceiling_minor: p.renewal_ceiling_minor ? Number(p.renewal_ceiling_minor) : null, notice_days: p.notice_days, milestones: p.milestones ?? [], reserve_policy: p.reserve_policy, ceiling_minor: p.contract_type === 'framework' && p.ceiling_minor && p.budget_public ? Number(p.ceiling_minor) : null }, fx: p.fx ? { date: p.fx.date, base: p.fx.base, currencies: Object.keys(p.fx.rates ?? {}) } : null },
      questionnaire: termsOk ? (await questionsOf(pool, p.id)).map(({ pass_value, ...q }) => q) : null, files, addenda, unacknowledged_addenda: unack.map((u) => u.n), visit_acks, public_award: outcome ? { ...outcome.record, published_at: outcome.published_at } : null };
  },
});

cap({
  name: 'check_tender_eligibility', method: 'GET', path: '/tenders/:id/eligibility', tag: TAG,
  summary: 'Check whether a supplier entity of yours meets the tender\'s qualification requirements (certificates, insurance and so on) and see exactly what is missing, expired or only declared. The same checks run at the qualification gate and again before an award.',
  input: z.object({ id, entity_id: id }),
  async handler({ user }, i) {
    const p = await getProject(i.id);
    await noticeAccess(user, p);
    await requireEntity(user, i.entity_id);
    const checks = await credentialCheck(pool, p, i.entity_id);
    return { entity_id: i.entity_id, checks, meets_requirements: checks.every((c) => c.state === 'ok') };
  },
});

// ------------------------------------------------------------------ participation
cap({
  name: 'join_tender', method: 'POST', path: '/tenders/:id/participation', tag: TAG,
  summary: 'Take part as one of your supplier entities: register interest (public notices), request participation (restricted), accept the tender terms or the NDA (needed before the questionnaire and participant documents open and before a proposal can start), accept an invitation, decline an invitation (with a reason) or withdraw interest.',
  input: z.object({ id, entity_id: id, action: z.enum(['interest', 'request', 'accept_terms', 'accept_nda', 'decline', 'withdraw']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await getProject(i.id, c);
      await noticeAccess(user, p, c);
      const needRole = ['accept_terms', 'accept_nda'].includes(i.action) ? ['owner', 'signatory'] : ['owner', 'bid_manager', 'signatory'];
      await requireEntity(user, i.entity_id, needRole, c);
      if (!['published'].includes(p.status) || p.suspended_at) throw conflict('This tender is not open for participation');
      if (p.closes_at && new Date() >= new Date(p.closes_at) && i.action !== 'withdraw' && i.action !== 'decline') throw conflict('The tender has closed');
      let row = (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2 FOR UPDATE', [p.id, i.entity_id])).rows[0];
      const upsert = async (status) => (await c.query(`INSERT INTO proc_participants(project_id, entity_id, status) VALUES ($1,$2,$3) ON CONFLICT (project_id, entity_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now() RETURNING *`, [p.id, i.entity_id, status])).rows[0];
      if (i.action === 'interest') {
        if (p.publication !== 'public') throw forbidden('This tender is not open to everyone. Request participation instead.');
        row = row && ['approved', 'invited'].includes(row.status) ? row : await upsert('interested');
      } else if (i.action === 'request') {
        if (p.publication === 'invite_only' && !row) throw notFound('Tender');
        if (p.publication === 'private') throw notFound('Tender');
        row = row && ['approved', 'invited'].includes(row.status) ? row : await upsert('requested');
        await tellUsers(c, await buyerIds(p, ['author']), p, 'tender_participation_request', 'Request to take part', `A supplier asked to take part in tender ${p.ref}.`, i.entity_id);
      } else if (!row) throw badRequest('Register interest or request participation first');
      else if (i.action === 'accept_terms') row = (await c.query('UPDATE proc_participants SET terms_accepted_at=coalesce(terms_accepted_at, now()), status = CASE WHEN status=\'invited\' THEN \'approved\' ELSE status END, updated_at=now() WHERE id=$1 RETURNING *', [row.id])).rows[0];
      else if (i.action === 'accept_nda') row = (await c.query('UPDATE proc_participants SET nda_accepted_at=coalesce(nda_accepted_at, now()), updated_at=now() WHERE id=$1 RETURNING *', [row.id])).rows[0];
      else if (i.action === 'decline') { if (!i.reason) throw badRequest('Say why you are declining'); row = (await c.query("UPDATE proc_participants SET status='declined', decline_reason=$2, updated_at=now() WHERE id=$1 RETURNING *", [row.id, i.reason])).rows[0]; }
      else row = (await c.query("UPDATE proc_participants SET status='withdrawn', updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      await auditLog(c, p.id, user.id, `participation_${i.action}`, { entity_id: i.entity_id });
      return row;
    });
  },
});

cap({
  name: 'invite_suppliers', method: 'POST', path: '/rfps/:id/invites', tag: TAG,
  summary: 'Invite supplier entities to a tender (before or after publication). Invited suppliers are notified when it is published (or at once if it already is). For restricted tenders, decide pending participation requests with approve / reject here too.',
  input: z.object({ id, entity_ids: z.array(id).max(100).default([]), decide: z.array(z.object({ entity_id: id, decision: z.enum(['approve', 'reject']), reason: z.string().max(300).optional() })).max(100).default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'invite', c, { lock: true });
      if (['cancelled', 'archived', 'awarded'].includes(p.status)) throw conflict('This tender is finished');
      const out = [];
      for (const eid of i.entity_ids) {
        if (!(await c.query("SELECT 1 FROM supplier_entities WHERE id=$1 AND status='active'", [eid])).rowCount) throw notFound('Supplier');
        const r = (await c.query("INSERT INTO proc_participants(project_id, entity_id, status, invited_by) VALUES ($1,$2,'invited',$3) ON CONFLICT (project_id, entity_id) DO UPDATE SET status = CASE WHEN proc_participants.status IN ('requested','interested','declined','withdrawn') THEN 'invited' ELSE proc_participants.status END, invited_by=$3, updated_at=now() RETURNING *", [p.id, eid, user.id])).rows[0];
        out.push(r);
        if (p.status === 'published') await tellUsers(c, await entityUserIds(eid, c, ['owner', 'bid_manager']), p, 'tender_invited', 'You are invited to a tender', `You are invited to respond to tender ${p.ref}.`, 'invite');
      }
      for (const d of i.decide) {
        const r = (await c.query("UPDATE proc_participants SET status=$3, decline_reason=$4, updated_at=now() WHERE project_id=$1 AND entity_id=$2 AND status='requested' RETURNING *", [p.id, d.entity_id, d.decision === 'approve' ? 'approved' : 'declined', d.reason ?? null])).rows[0];
        if (!r) throw notFound('Participation request');
        out.push(r);
        await tellUsers(c, await entityUserIds(d.entity_id, c, ['owner', 'bid_manager']), p, 'tender_participation', d.decision === 'approve' ? 'Participation approved' : 'Participation not approved', `Your request for tender ${p.ref} was ${d.decision === 'approve' ? 'approved' : 'not approved'}.`, `p${d.decision}`);
      }
      await auditLog(c, p.id, user.id, 'invites_updated', { invited: i.entity_ids.length, decided: i.decide.length });
      return out;
    });
  },
});

cap({
  name: 'list_rfp_participants', method: 'GET', path: '/rfps/:id/participants', tag: TAG,
  summary: 'Buyer team: who is invited, interested, requested or approved, whether terms and the NDA are accepted, and site-visit attendance. Suppliers never see this list.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'invite');
    return many(`SELECT pa.id, pa.entity_id, e.legal_name, e.kind, pa.status, pa.terms_accepted_at, pa.nda_accepted_at, pa.site_visit_attended, pa.site_visit_exempt_reason, pa.updated_at,
      (SELECT count(*)::int FROM proc_files f WHERE f.project_id=pa.project_id AND f.visit_pack AND f.archived_at IS NULL) AS visit_documents,
      (SELECT count(*)::int FROM proc_visit_acks k WHERE k.project_id=pa.project_id AND k.entity_id=pa.entity_id) AS visit_documents_acknowledged
      FROM proc_participants pa JOIN supplier_entities e ON e.id=pa.entity_id WHERE pa.project_id=$1 ORDER BY e.legal_name LIMIT $2 OFFSET $3`, [p.id, i.limit, i.offset]);
  },
});

cap({
  name: 'record_site_visit', method: 'POST', path: '/rfps/:id/site-visit', tag: TAG,
  summary: 'Record attendance at the site visit or pre-bid meeting for a supplier, or a permitted exemption with its reason. When attendance is mandatory, a proposal cannot be submitted without one of them.',
  input: z.object({ id, entity_id: id, attended: z.boolean().optional(), exempt_reason: z.string().max(300).optional() }).refine((v) => v.attended || v.exempt_reason, 'Record attendance or an exemption reason'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'invite', c, { lock: true });
      const r = (await c.query('UPDATE proc_participants SET site_visit_attended=$3, site_visit_exempt_reason=$4, updated_at=now() WHERE project_id=$1 AND entity_id=$2 RETURNING *', [p.id, i.entity_id, i.attended ?? null, i.exempt_reason ?? null])).rows[0];
      if (!r) throw notFound('Participant');
      await auditLog(c, p.id, user.id, 'site_visit_recorded', { entity_id: i.entity_id, attended: !!i.attended, exempt: !!i.exempt_reason });
      return r;
    });
  },
});

cap({
  name: 'mark_visit_document', method: 'POST', path: '/rfps/:id/visit-documents', tag: TAG,
  summary: 'Buying team: mark a pack document (a site safety briefing, access rules, an induction sheet) as one that every supplier must acknowledge for the site visit, or take the mark off a document nobody has acknowledged yet. Acknowledgements are kept for the record, so a document that has been acknowledged stays marked.',
  input: z.object({ id, file_id: id, visit_pack: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'files', c, { lock: true });
      if (['cancelled', 'archived'].includes(p.status)) throw conflict('This tender is finished');
      const f = (await c.query('SELECT * FROM proc_files WHERE id=$1 AND project_id=$2 AND entity_id IS NULL AND archived_at IS NULL', [i.file_id, p.id])).rows[0];
      if (!f) throw notFound('File');
      if (i.visit_pack && f.audience !== 'participants') throw badRequest('Only a document shared with participants can be a site-visit document');
      if (!i.visit_pack && (await c.query('SELECT 1 FROM proc_visit_acks WHERE file_id=$1', [f.id])).rowCount) throw conflict('Suppliers have already acknowledged this document, so it stays marked');
      await c.query('UPDATE proc_files SET visit_pack=$2 WHERE id=$1', [f.id, i.visit_pack]);
      await auditLog(c, p.id, user.id, 'visit_document_marked', { file_id: f.id, visit_pack: i.visit_pack });
      return { id: f.id, name: f.name, visit_pack: i.visit_pack };
    });
  },
});

cap({
  name: 'acknowledge_visit_documents', method: 'POST', path: '/tenders/:id/visit-documents/acknowledge', tag: TAG,
  summary: 'Record that your supplier entity has read the site-visit documents (safety briefing, access rules). Each acknowledgement is stored with the exact content fingerprint and cannot be undone. Needs accepted terms; it is separate from attending the visit and from any exemption. A proposal cannot be submitted, and cannot pass the qualification gate, while a document that existed at submission is unacknowledged.',
  input: z.object({ id, entity_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await getProject(i.id, c);
      await noticeAccess(user, p, c);
      await requireEntity(user, i.entity_id, ['owner', 'bid_manager', 'contributor', 'signatory'], c);
      const part = (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, i.entity_id])).rows[0];
      if (!part || !['invited', 'interested', 'approved'].includes(part.status)) throw forbidden('Register interest or accept the invitation first');
      if (!part.terms_accepted_at) throw conflict('Accept the tender terms first');
      if (p.status !== 'published' || p.suspended_at || (p.closes_at && new Date() >= new Date(p.closes_at))) throw conflict('This tender is not accepting responses');
      const before = await visitDocs(c, p.id, i.entity_id);
      for (const d of before.outstanding) {
        const f = (await c.query('SELECT sha256 FROM proc_files WHERE id=$1', [d.id])).rows[0];
        await c.query('INSERT INTO proc_visit_acks(project_id, entity_id, file_id, sha256, acknowledged_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entity_id, file_id) DO NOTHING', [p.id, i.entity_id, d.id, f.sha256, user.id]);
      }
      if (before.outstanding.length) await auditLog(c, p.id, user.id, 'visit_documents_acknowledged', { entity_id: i.entity_id, files: before.outstanding.map((d) => d.id) });
      const after = await visitDocs(c, p.id, i.entity_id);
      return { acknowledged: before.outstanding.length, outstanding: after.outstanding, documents: after.documents };
    });
  },
});

// ------------------------------------------------------------------ clarifications
cap({
  name: 'ask_tender_question', method: 'POST', path: '/tenders/:id/questions', tag: TAG, status: 201,
  summary: 'Ask the buyer a clarification question as one of your supplier entities, before the clarification deadline. Material answers are shared with every participant without your identity; only a buyer-approved private answer stays private. Do not put your prices or confidential details in a question.',
  input: z.object({ id, entity_id: id, question: z.string().min(5).max(2000), private: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await getProject(i.id, c);
      const acc = await noticeAccess(user, p, c);
      if (acc.buyer.length) throw forbidden('Buyers answer questions; they do not ask them');
      await requireEntity(user, i.entity_id, ['owner', 'bid_manager', 'contributor', 'signatory'], c);
      if (p.status !== 'published' || p.suspended_at) throw conflict('This tender is not open for questions');
      const dl = p.clarification_deadline ?? p.closes_at;
      if (dl && new Date() >= new Date(dl)) throw conflict('The clarification deadline has passed');
      if (p.publication !== 'public' && !(acc.part && ['invited', 'approved'].includes(acc.part.status))) throw forbidden('Questions open once you are approved to take part');
      const q = (await c.query('INSERT INTO proc_qna(project_id, entity_id, asked_by, question, private_requested) VALUES ($1,$2,$3,$4,$5) RETURNING id, question, created_at', [p.id, i.entity_id, user.id, i.question, i.private])).rows[0];
      await tellUsers(c, await buyerIds(p, ['author']), p, 'tender_question', 'New supplier question', `A supplier asked a question on tender ${p.ref}.`, q.id);
      return q;
    });
  },
});

cap({
  name: 'answer_tender_question', method: 'POST', path: '/rfps/:id/questions/:qid/answer', tag: TAG,
  summary: 'Answer a supplier question. A material answer (one that clarifies scope, dates or rules) is published to every participant without the asker\'s identity; otherwise you may keep it private to that supplier. No off-platform answer counts.',
  input: z.object({ id, qid: id, answer: z.string().min(2).max(4000), material: z.boolean().default(true), publish: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'qna', c, { lock: true });
      const publish = i.material ? true : i.publish;
      const q = (await c.query('UPDATE proc_qna SET answer=$3, answered_by=$4, answered_at=now(), published=$5 WHERE id=$2 AND project_id=$1 RETURNING *', [p.id, i.qid, i.answer, user.id, publish])).rows[0];
      if (!q) throw notFound('Question');
      await auditLog(c, p.id, user.id, 'question_answered', { qid: q.id, published: publish });
      const targets = publish ? (await c.query("SELECT entity_id FROM proc_participants WHERE project_id=$1 AND status <> 'declined'", [p.id])).rows.map((r) => r.entity_id) : [q.entity_id];
      for (const e of new Set([...targets, q.entity_id])) await tellUsers(c, await entityUserIds(e, c, ['owner', 'bid_manager']), p, 'tender_answer', 'Clarification published', `Tender ${p.ref} has a new answer.`, `qa${q.id}`);
      return { id: q.id, published: publish };
    });
  },
});

cap({
  name: 'list_tender_questions', method: 'GET', path: '/tenders/:id/questions', tag: TAG,
  summary: 'Common Q&A (answered, published questions without the asker\'s identity) plus, for suppliers, your own questions and private answers. Buyers see every question and who asked.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const p = await getProject(i.id);
    const acc = await noticeAccess(user, p);
    if (acc.buyer.length) return many('SELECT q.id, q.question, q.answer, q.published, q.created_at, q.answered_at, e.legal_name AS asked_by FROM proc_qna q JOIN supplier_entities e ON e.id=q.entity_id WHERE q.project_id=$1 ORDER BY q.created_at LIMIT $2 OFFSET $3', [p.id, i.limit, i.offset]);
    return many('SELECT q.id, q.question, q.answer, q.published, q.created_at, q.answered_at, (q.entity_id = ANY($2)) AS mine FROM proc_qna q WHERE q.project_id=$1 AND ((q.published AND q.answered_at IS NOT NULL) OR q.entity_id = ANY($2)) ORDER BY q.created_at LIMIT $3 OFFSET $4', [p.id, acc.entityIds, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ saved tenders & alerts
cap({
  name: 'save_tender', method: 'POST', path: '/tenders/:id/save', tag: TAG, summary: 'Bookmark a tender you can see, or remove the bookmark (saved: false).', input: z.object({ id, saved: z.boolean().default(true) }),
  async handler({ user }, i) {
    const p = await getProject(i.id);
    await noticeAccess(user, p);
    if (i.saved) await pool.query('INSERT INTO tender_saved(user_id, project_id) VALUES ($1,$2) ON CONFLICT (user_id, project_id) DO UPDATE SET removed_at=NULL', [user.id, p.id]);
    else await pool.query('UPDATE tender_saved SET removed_at=now() WHERE user_id=$1 AND project_id=$2', [user.id, p.id]);
    return { saved: i.saved };
  },
});
cap({
  name: 'set_tender_alert', method: 'POST', path: '/tender-alerts', tag: TAG, status: 201,
  summary: 'Get notified when a new public tender is published in a category, sport or region. Leave a field out to match any.', input: z.object({ category: z.string().max(40).optional(), sport: z.string().max(60).optional(), region: z.string().max(60).optional() }).refine((v) => v.category || v.sport || v.region, 'Choose a category, sport or region'),
  handler: ({ user }, i) => one('INSERT INTO tender_alerts(user_id, category, sport_slug, region) VALUES ($1,$2,$3,$4) RETURNING *', [user.id, i.category ?? null, i.sport ?? null, i.region ?? null]),
});
cap({ name: 'list_tender_alerts', method: 'GET', path: '/tender-alerts', tag: TAG, summary: 'Your tender alerts.', input: z.object({}), handler: ({ user }) => many('SELECT * FROM tender_alerts WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at', [user.id]) });
cap({
  name: 'remove_tender_alert', method: 'POST', path: '/tender-alerts/:id/remove', tag: TAG, summary: 'Stop a tender alert.', input: z.object({ id }),
  async handler({ user }, i) { const r = await one('UPDATE tender_alerts SET archived_at=now() WHERE id=$1 AND user_id=$2 AND archived_at IS NULL RETURNING id', [i.id, user.id]); if (!r) throw notFound('Alert'); return { removed: true }; },
});
