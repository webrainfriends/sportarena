// Sports agent & player representation (issue #484) 5/5b: conflicts of interest, and the agent's home (clients, reports, documents).
// A conflict is disclosed and decided by people. SportArena flags possible ones and records who decided what and when; it never decides whether
// a conflict is legally acceptable.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { toCsv } from '../csv.js';
import {
  CONFLICT_KINDS, actingFor, agentOfUser, agentStanding, assess, athleteSideOf, canDecide, inForce, ladderOf, loadAgent, loadMandate, logEvent, noWaiver, notifyAgentSide, notifyAthleteSide, raiseConflict, sumLadders, totalsOf,
} from '../representation.js';
import { mandateSummary } from './representation-mandates.js';

const TAG = 'Representation';
const text = (n) => z.string().trim().max(n);
const stale = () => conflict('This record changed; reload it and try again', { code: 'stale_version' });
const cview = ({ detail_enc, decision_note_enc, ...r }) => ({ ...r, detail: detail_enc ? decrypt(detail_enc, 'representation_conflicts.detail') : null, decision_note: decision_note_enc ? decrypt(decision_note_enc, 'representation_conflicts.decision') : null });

// ------------------------------------------------------------------ conflicts
cap({
  name: 'disclose_conflict', method: 'POST', path: '/representation/mandates/:id/conflicts', tag: TAG, status: 201,
  summary: 'Disclose a conflict of interest under a mandate: representing players on opposing sides of the same negotiation, an interest of the agent or agency in a club, supplier or sponsor, dual representation, or a related-party relationship. Either side can disclose. Until the athlete decides (acknowledge where policy allows, or reject) and the agent can recuse, the affected item stays blocked for the agent. SportArena does not judge whether it is acceptable.',
  input: z.object({ id, kind: z.enum(CONFLICT_KINDS), subject_type: z.enum(['player_contract', 'sponsorship', 'transfer', 'mandate']).default('mandate'), subject_id: id.optional(), counterparty: text(160).optional(), detail: text(1000).min(5) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await loadMandate(c, user, i.id, { lock: true });
      const raisedBy = ctx.side ? 'athlete' : 'agent';
      const subjectId = i.subject_type === 'mandate' ? ctx.mandate.id : i.subject_id;
      if (!subjectId) throw badRequest('Name the item (subject_id) this conflict is about');
      const row = (await c.query(
        `INSERT INTO representation_conflicts(agent_id, athlete_id, mandate_id, kind, subject_type, subject_id, counterparty, detail_enc, raised_by, raised_user, can_acknowledge) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.mandate.agent_id, ctx.mandate.athlete_id, ctx.mandate.id, i.kind, i.subject_type, subjectId, i.counterparty ?? null, encrypt(i.detail, 'representation_conflicts.detail'), raisedBy, user.id, !noWaiver().includes(i.kind)])).rows[0];
      await logEvent(c, ctx.mandate.id, user.id, raisedBy, 'conflict_disclosed', { subject_type: i.subject_type, subject_id: subjectId, detail: { kind: i.kind, conflict_id: row.id } });
      const msg = { kind: 'representation_conflict', title: 'A conflict of interest was disclosed', body: 'Review it before anything proceeds on the affected item.', data: { conflict_id: row.id } };
      if (ctx.side) await notifyAgentSide(c, ctx.mandate, msg, user.id); else await notifyAthleteSide(c, ctx.mandate, msg, user.id);
      await audit(c, user.id, 'disclose_conflict', 'representation_conflicts', row.id);
      return cview(row);
    });
  },
});

cap({
  name: 'list_representation_conflicts', method: 'GET', path: '/representation/mandates/:id/conflicts', tag: TAG,
  summary: 'Conflicts disclosed or flagged under a mandate, with who raised each (agent, athlete or the platform\'s automatic comparison), whether the athlete is allowed to accept it under policy, and the decision. Both sides read them.',
  input: z.object({ id, status: z.enum(['open', 'acknowledged', 'recused', 'rejected', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    await loadMandate(pool, user, i.id);
    return (await many('SELECT * FROM representation_conflicts WHERE mandate_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC, id LIMIT $3 OFFSET $4', [i.id, i.status ?? null, i.limit, i.offset])).map(cview);
  },
});

cap({
  name: 'decide_conflict', method: 'POST', path: '/representation/conflicts/:id/decision', tag: TAG,
  summary: 'Decide a conflict. The athlete (or a guardian) can acknowledge it - only for kinds policy allows them to accept - or reject it. The agent can recuse: step back from that item (its grants close; for a mandate-level conflict the agent ends the mandate). The person who disclosed it can withdraw it while open. Each decision is recorded with who and when.',
  input: z.object({ id, decision: z.enum(['acknowledge', 'reject', 'recuse', 'withdraw']), note: text(500).optional(), row_version: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cf = (await c.query('SELECT * FROM representation_conflicts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cf) throw notFound('Conflict');
      if (!cf.mandate_id) throw notFound('Conflict');
      const ctx = await loadMandate(c, user, cf.mandate_id, { lock: true });
      if (i.row_version != null && cf.row_version !== i.row_version) throw stale();
      const target = { acknowledge: 'acknowledged', reject: 'rejected', recuse: 'recused', withdraw: 'withdrawn' }[i.decision];
      if (cf.status === target) return cview(cf);
      const from = cf.status;
      if (i.decision === 'acknowledge') {
        if (!canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian can acknowledge a conflict');
        if (!cf.can_acknowledge) throw conflict('Under policy this kind of conflict cannot simply be accepted; reject it, or the agent recuses', { code: 'cannot_acknowledge' });
        if (from !== 'open') throw conflict(`That conflict is ${from}`, { code: 'not_open' });
      } else if (i.decision === 'reject') {
        if (!canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian can reject a conflict');
        if (!['open', 'acknowledged'].includes(from)) throw conflict(`That conflict is ${from}`, { code: 'not_open' });
      } else if (i.decision === 'recuse') {
        if (!ctx.acting || ctx.acting.via !== 'principal') throw forbidden('Only the agent can recuse');
        if (!['open', 'acknowledged'].includes(from)) throw conflict(`That conflict is ${from}`, { code: 'not_open' });
      } else {
        if (from !== 'open') throw conflict(`That conflict is ${from}`, { code: 'not_open' });
        if (cf.raised_by === 'system') throw forbidden('A conflict flagged automatically cannot be withdrawn; decide it');
        if (cf.raised_user !== user.id && !((cf.raised_by === 'athlete' && ctx.side) || (cf.raised_by === 'agent' && ctx.acting?.via === 'principal'))) throw forbidden('Only the side that disclosed it can withdraw it');
      }
      const row = (await c.query('UPDATE representation_conflicts SET status=$2, decided_by=$3, decided_at=now(), decision_note_enc=$4, row_version=row_version+1 WHERE id=$1 RETURNING *', [cf.id, target, user.id, encrypt(i.note, 'representation_conflicts.decision')])).rows[0];
      if (i.decision === 'recuse') {
        if (cf.subject_type === 'mandate') {
          await c.query("UPDATE representation_mandates SET status='revoked', ended_at=now(), end_kind='ended_by_agent', end_reason='The agent recused because of a conflict of interest', ended_by=$2, show_on_profile=false, row_version=row_version+1, updated_at=now() WHERE id=$1 AND status IN ('active','proposed')", [cf.mandate_id, user.id]);
          await c.query('UPDATE representation_grants SET revoked_at=now(), revoked_by=$2 WHERE mandate_id=$1 AND revoked_at IS NULL', [cf.mandate_id, user.id]);
        } else {
          await c.query('UPDATE representation_grants SET revoked_at=now(), revoked_by=$4 WHERE mandate_id=$1 AND subject_type=$2 AND subject_id=$3 AND revoked_at IS NULL', [cf.mandate_id, cf.subject_type, cf.subject_id, user.id]);
        }
      }
      await logEvent(c, cf.mandate_id, user.id, ctx.side ?? 'agent', `conflict_${target}`, { subject_type: cf.subject_type, subject_id: cf.subject_id, detail: { kind: cf.kind, conflict_id: cf.id } });
      await audit(c, user.id, `conflict_${target}`, 'representation_conflicts', cf.id);
      const msg = { kind: 'representation_conflict_decided', title: `A conflict was ${target}`, body: 'The decision is recorded in the representation history.', data: { conflict_id: cf.id } };
      if (ctx.side) await notifyAgentSide(c, ctx.mandate, msg, user.id); else await notifyAthleteSide(c, ctx.mandate, msg, user.id);
      return cview(row);
    });
  },
});

// ------------------------------------------------------------------ the agent's home
/** The agent profile the caller acts for: given, their own, or the one they are staff of. */
async function agentCtx(user, agentId) {
  if (agentId) {
    const a = await loadAgent(pool, agentId);
    const acting = a ? await actingFor(pool, user, a) : null;
    if (!acting) throw notFound('Agent');
    return acting;
  }
  const own = await agentOfUser(pool, user.id);
  if (own) return actingFor(pool, user, own);
  const s = await one("SELECT agent_id FROM agent_staff WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT 1", [user.id]);
  const a = s ? await loadAgent(pool, s.agent_id) : null;
  const acting = a ? await actingFor(pool, user, a) : null;
  if (!acting) throw notFound('Agent profile');
  return acting;
}
/** Mandates the acting person may see: all for the principal; for staff only those whose agreed version lets staff act. */
async function agentMandates(acting) {
  const rows = await many("SELECT m.* FROM representation_mandates m WHERE m.agent_id=$1 AND m.status <> 'draft' ORDER BY m.created_at DESC, m.id", [acting.agent.id]);
  if (acting.via === 'principal') return rows;
  const out = [];
  for (const m of rows) { const v = await inForce(pool, m); if (v?.allow_staff && acting.perms.includes('view')) out.push(m); }
  return out;
}

cap({
  name: 'list_agent_clients', method: 'GET', path: '/agent/clients', tag: TAG,
  summary: 'Agent home - Clients: the athletes you represent or have represented, with their mandates and whether each is live right now. Your own business record only; nothing private about the athlete is read here.',
  input: z.object({ agent_id: id.optional() }),
  async handler({ user }, i) {
    const acting = await agentCtx(user, i.agent_id);
    const rows = await agentMandates(acting);
    const byAthlete = new Map();
    for (const m of rows) {
      const s = await mandateSummary(pool, m, { agent: acting.agent, acting, side: null });
      const e = byAthlete.get(m.athlete_id) ?? { athlete: s.athlete, mandates: [] };
      e.mandates.push({ id: s.id, mandate_no: s.mandate_no, status: s.status, live: s.live, not_live_reason: s.not_live_reason, sports: s.sports, ends_on: s.ends_on, open_conflicts: s.open_conflicts, pending_approvals: s.pending_approvals });
      byAthlete.set(m.athlete_id, e);
    }
    return [...byAthlete.values()];
  },
});

async function homeNumbers(acting) {
  const rows = await agentMandates(acting);
  const ids = rows.map((m) => m.id);
  const today = new Date();
  const counts = { clients: new Set(rows.map((m) => m.athlete_id)).size, mandates: { active: 0, proposed: 0, ended: 0 }, live: 0, expiring_soon: [], not_live: [] };
  for (const m of rows) {
    if (m.status === 'active') counts.mandates.active++; else if (m.status === 'proposed') counts.mandates.proposed++; else counts.mandates.ended++;
    const st = await assess(pool, m, { agent: acting.agent });
    if (st.live) counts.live++;
    else if (m.status === 'active') counts.not_live.push({ mandate_id: m.id, mandate_no: m.mandate_no, reason: st.reason });
    if (st.live) { const days = Math.ceil((new Date(`${st.version.ends_on}T00:00:00Z`) - today) / 864e5); if (days <= 30) counts.expiring_soon.push({ mandate_id: m.id, mandate_no: m.mandate_no, ends_on: st.version.ends_on, days }); }
  }
  const one1 = async (sql) => (ids.length ? Number((await pool.query(sql, [ids])).rows[0].n) : 0);
  const pipeline = ids.length ? (await pool.query("SELECT stage, count(*)::int AS n FROM representation_pipeline WHERE mandate_id = ANY($1) GROUP BY stage", [ids])).rows : [];
  const deals = ids.length ? (await pool.query("SELECT id, currency FROM representation_deals WHERE mandate_id = ANY($1) AND status IN ('confirmed','ended')", [ids])).rows : [];
  const sums = {};
  for (const d of deals) sumLadders(sums, d.currency, await ladderOf(pool, d.id));
  const commission = totalsOf(sums);
  return {
    ...counts,
    pipeline: Object.fromEntries(pipeline.map((p) => [p.stage, p.n])),
    approvals_waiting: await one1("SELECT count(*) AS n FROM representation_approvals WHERE mandate_id = ANY($1) AND status='pending'"),
    contracts_shared: await one1("SELECT count(*) AS n FROM representation_grants WHERE mandate_id = ANY($1) AND subject_type='player_contract' AND revoked_at IS NULL"),
    contracts_to_review: await one1("SELECT count(*) AS n FROM representation_contract_reviews WHERE mandate_id = ANY($1) AND state='to_review'"),
    sponsorships_shared: await one1("SELECT count(*) AS n FROM representation_grants WHERE mandate_id = ANY($1) AND subject_type='sponsorship' AND revoked_at IS NULL"),
    transfers_shared: await one1("SELECT count(*) AS n FROM representation_grants WHERE mandate_id = ANY($1) AND subject_type='transfer' AND revoked_at IS NULL"),
    conflicts_open: await one1("SELECT count(*) AS n FROM representation_conflicts WHERE mandate_id = ANY($1) AND status='open'"),
    deals: deals.length, commission,
  };
}

cap({
  name: 'get_agent_home', method: 'GET', path: '/agent/home', tag: TAG,
  summary: 'Agent home: your profile and verification, plus the numbers behind Clients, Mandates, Opportunities, Negotiations, Transfers, Sponsorships, Commissions, Conflicts and Reports, with mandates that are not live right now (and why) and ones expiring within 30 days.',
  input: z.object({ agent_id: id.optional() }),
  async handler({ user }, i) {
    const acting = await agentCtx(user, i.agent_id);
    const standing = await agentStanding(pool, acting.agent);
    return {
      agent: { id: acting.agent.id, display_name: acting.agent.display_name, kind: acting.agent.kind, status: acting.agent.status, is_public: acting.agent.is_public },
      acting_as: acting.via, permissions: acting.perms,
      verification: { verified: standing.verified, expires_at: standing.expires_at, checked: standing.checked.map(({ label, note }) => ({ label, note })), licences: standing.licences.map(({ id: lid, issuing_body, grade, jurisdiction, valid_to, standing: st }) => ({ id: lid, issuing_body, grade, jurisdiction, valid_to, standing: st })) },
      ...(await homeNumbers(acting)),
    };
  },
});

cap({
  name: 'get_agent_report', method: 'GET', path: '/agent/report', tag: TAG,
  summary: 'Agent reports: every mandate with its state, and every commission account with owed, invoiced, reported and settled per currency. format=csv returns a file. It covers your own business records only; the export is audit-logged and honours the commission permission for staff.',
  input: z.object({ agent_id: id.optional(), format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    const acting = await agentCtx(user, i.agent_id);
    const mandates = await agentMandates(acting);
    const rows = [];
    for (const m of mandates) {
      const s = await mandateSummary(pool, m, { agent: acting.agent, acting, side: null });
      const deals = acting.via === 'principal' || acting.perms.includes('commission') ? await many("SELECT id, deal_ref, deal_type, currency, status FROM representation_deals WHERE mandate_id=$1 ORDER BY created_at", [m.id]) : [];
      if (!deals.length) rows.push({ mandate_no: s.mandate_no, athlete: s.athlete.display_name, status: s.status, live: s.live ? 'yes' : `no (${s.not_live_reason})`, ends_on: s.ends_on ?? '', deal: '', currency: '', owed: '', invoiced: '', reported: '', settled: '', outstanding: '' });
      for (const d of deals) { const l = await ladderOf(pool, d.id); const f = (n) => (n / 100).toFixed(2); rows.push({ mandate_no: s.mandate_no, athlete: s.athlete.display_name, status: s.status, live: s.live ? 'yes' : `no (${s.not_live_reason})`, ends_on: s.ends_on ?? '', deal: `${d.deal_type}:${d.deal_ref ?? d.id}`, currency: d.currency, owed: f(l.owed_cents), invoiced: f(l.invoiced_cents), reported: f(l.reported_cents), settled: f(l.settled_cents), outstanding: f(l.outstanding_cents) }); }
    }
    await audit(null, user.id, 'export_agent_report', 'agent_profiles', acting.agent.id);
    if (i.format === 'json') return { rows, generated_at: new Date().toISOString() };
    return { filename: 'agent-report.csv', rows: rows.length, csv: toCsv(['mandate_no', 'athlete', 'status', 'live', 'ends_on', 'deal', 'currency', 'owed', 'invoiced', 'reported', 'settled', 'outstanding'], rows) };
  },
});

cap({
  name: 'list_agent_documents', method: 'GET', path: '/agent/documents', tag: TAG,
  summary: 'Agent home - Documents: the signed mandate versions you can open as a document, and your commission statements, with their numbers and checksums.',
  input: z.object({ agent_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const acting = await agentCtx(user, i.agent_id);
    const mandates = await agentMandates(acting);
    const ids = mandates.map((m) => m.id);
    if (!ids.length) return { mandates: [], statements: [] };
    const versions = await many(`SELECT m.id AS mandate_id, m.mandate_no, v.version, v.kind, v.status, v.decided_at FROM representation_mandate_versions v JOIN representation_mandates m ON m.id=v.mandate_id WHERE m.id = ANY($1) AND v.status IN ('in_force','superseded') ORDER BY m.created_at DESC, v.version DESC LIMIT $2 OFFSET $3`, [ids, i.limit, i.offset]);
    const statements = acting.via === 'principal' || acting.perms.includes('commission')
      ? await many(`SELECT s.id, s.statement_no, s.amount_cents, s.currency, s.status, s.sha256, s.issued_at, m.mandate_no FROM representation_statements s JOIN representation_deals d ON d.id=s.deal_id JOIN representation_mandates m ON m.id=d.mandate_id WHERE m.id = ANY($1) ORDER BY s.issued_at DESC LIMIT $2 OFFSET $3`, [ids, i.limit, i.offset]) : [];
    return { mandates: versions, statements };
  },
});
