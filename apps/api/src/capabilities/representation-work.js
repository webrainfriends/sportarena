// Sports agent & player representation (issue #484) 4/5: what an agent does inside a mandate. Opportunity outreach and the pipeline, actions that need the
// athlete's approval, authorised conversations, and taking part in #333 player-contract discussions and shared sponsorship agreements. A high-impact
// commitment (accepting a position, signing, approving a transfer) is never an action here: it stays with the athlete or guardian in the canonical workflow.
import { z } from 'zod';
import { cap, id, page, capabilities } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';
import { SECTIONS } from '../opportunity.js';
import { VERSION_COLS as CONTRACT_VERSION_COLS, loadPayer, loadContract, versionsOf as contractVersions } from '../player-contracts.js';
import {
  APPROVAL_DAYS, actingFor, assess, athleteSideOf, canDecide, detectDealConflicts, loadAgent, loadMandate, logEvent, notifyAgentSide, notifyAthleteSide, requireLive,
} from '../representation.js';
import { subjectTitle } from './representation-access.js';

const TAG = 'Representation';
const text = (n) => z.string().trim().max(n);
const stale = () => conflict('This record changed; reload it and try again', { code: 'stale_version' });
const dec = (v, ctx) => (v ? decrypt(v, ctx) : null);

// ------------------------------------------------------------------ opportunity pipeline
const PIPE_COLS = `p.id, p.mandate_id, p.post_id, p.stage, p.athlete_response, p.draft_message, p.draft_sections, p.response_id, p.note_enc, p.row_version, p.created_at, p.updated_at,
  b.title AS post_title, b.kind AS post_kind, b.status AS post_status, b.closes_at, s.name AS sport_name, s.emoji AS sport_emoji, u.display_name AS added_by_name`;
const PIPE_FROM = 'FROM representation_pipeline p JOIN billboard_posts b ON b.id=p.post_id LEFT JOIN sports s ON s.id=b.sport_id JOIN users u ON u.id=p.added_by';
const pipeView = ({ note_enc, ...r }) => ({ ...r, note: dec(note_enc, 'representation_pipeline.note') });

cap({
  name: 'share_opportunity', method: 'POST', path: '/representation/mandates/:id/pipeline', tag: TAG, status: 201,
  summary: 'Agent: put a canonical Billboard opportunity (a post that is open and in one of the mandate\'s sports) in front of the athlete and into your pipeline, with an optional note to them. Needs the opportunity-outreach purpose and the "share opportunities" action. Nothing is copied; the athlete answers interested or not interested. Sharing again changes nothing.',
  input: z.object({ id, post_id: id, note: text(500).optional() }),
  async handler({ user }, i) {
    const post = await one("SELECT id, title, status, sport_id, closes_at, author_id FROM billboard_posts WHERE id=$1", [i.post_id]);
    if (!post) throw notFound('Opportunity');
    return tx(async (c) => {
      const live = await requireLive(c, user, i.id, { purpose: 'opportunity_outreach', action: 'share_opportunities', staff: 'outreach', sport_id: post.sport_id ?? undefined });
      if (post.status !== 'open' || (post.closes_at && new Date(post.closes_at) <= new Date())) throw conflict('That opportunity is closed', { code: 'closed' });
      if (post.author_id === live.mandate.athlete_id) throw badRequest('That is the athlete\'s own post');
      const r = await c.query('INSERT INTO representation_pipeline(mandate_id, post_id, note_enc, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (mandate_id, post_id) DO NOTHING RETURNING id', [i.id, i.post_id, encrypt(i.note, 'representation_pipeline.note'), user.id]);
      const row = r.rows[0] ?? (await c.query('SELECT id FROM representation_pipeline WHERE mandate_id=$1 AND post_id=$2', [i.id, i.post_id])).rows[0];
      if (r.rowCount) {
        await logEvent(c, i.id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', 'opportunity_shared', { subject_type: 'billboard_post', subject_id: i.post_id });
        await notifyAthleteSide(c, live.mandate, { kind: 'representation_opportunity', title: 'Your agent shared an opportunity', body: `${post.title}. Say whether you are interested; nothing is sent to the poster without your approval.` }, user.id);
      }
      return pipeView((await c.query(`SELECT ${PIPE_COLS} ${PIPE_FROM} WHERE p.id=$1`, [row.id])).rows[0]);
    });
  },
});

cap({
  name: 'list_representation_pipeline', method: 'GET', path: '/representation/mandates/:id/pipeline', tag: TAG,
  summary: 'The opportunities shared under a mandate with their stage: shared, drafting, awaiting your approval, submitted, outcome or dropped. Athlete side and agent side both see it (it is the agent\'s own working record and what they told the athlete).',
  input: z.object({ id, stage: z.enum(['shared', 'interest_requested', 'drafting', 'awaiting_athlete', 'submitted', 'outcome', 'dropped']).optional(), ...page }),
  async handler({ user }, i) {
    await loadMandate(pool, user, i.id);
    return (await many(`SELECT ${PIPE_COLS} ${PIPE_FROM} WHERE p.mandate_id=$1 AND ($2::text IS NULL OR p.stage=$2) ORDER BY p.updated_at DESC, p.id LIMIT $3 OFFSET $4`, [i.id, i.stage ?? null, i.limit, i.offset])).map(pipeView);
  },
});

cap({
  name: 'respond_to_shared_opportunity', method: 'POST', path: '/representation/pipeline/:id/response', tag: TAG,
  summary: 'Athlete side: say whether you are interested in an opportunity your agent shared. This sends nothing to the poster. A guardian answers for a young person.',
  input: z.object({ id, response: z.enum(['interested', 'not_interested']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM representation_pipeline WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Opportunity');
      const ctx = await loadMandate(c, user, p.mandate_id, { lock: true });
      if (!canDecide(ctx.side)) throw forbidden('Only the athlete or a guardian answers');
      if (ctx.mandate.status !== 'active') throw conflict('This mandate is not in force', { code: 'not_active' });
      const stage = i.response === 'not_interested' ? 'dropped' : p.stage === 'shared' ? 'drafting' : p.stage;
      await c.query('UPDATE representation_pipeline SET athlete_response=$2, stage=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', [p.id, i.response, stage]);
      await logEvent(c, p.mandate_id, user.id, ctx.side, 'opportunity_answered', { subject_type: 'billboard_post', subject_id: p.post_id, detail: { response: i.response } });
      await notifyAgentSide(c, ctx.mandate, { kind: 'representation_answer', title: i.response === 'interested' ? 'The athlete is interested' : 'The athlete passed on an opportunity', body: (await c.query('SELECT title FROM billboard_posts WHERE id=$1', [p.post_id])).rows[0]?.title ?? '' }, user.id);
      return pipeView((await c.query(`SELECT ${PIPE_COLS} ${PIPE_FROM} WHERE p.id=$1`, [p.id])).rows[0]);
    });
  },
});

cap({
  name: 'update_pipeline_item', method: 'PATCH', path: '/representation/pipeline/:id', tag: TAG,
  summary: 'Agent: update your pipeline entry - your note to the athlete, the stage (shared, drafting, outcome, dropped) and a draft application (message and the passport sections to share). A draft is only a draft: the athlete must approve it before anything is sent. Needs the matching allowed action. Send row_version.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1), stage: z.enum(['shared', 'drafting', 'outcome', 'dropped']).optional(), note: text(500).nullish(), draft_message: text(500).nullish(), draft_sections: z.array(z.enum(SECTIONS)).max(5).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM representation_pipeline WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Opportunity');
      const drafting = i.draft_message !== undefined || i.draft_sections !== undefined;
      const live = await requireLive(c, user, p.mandate_id, { purpose: 'opportunity_outreach', action: drafting ? 'draft_applications' : 'track_pipeline', staff: 'outreach' });
      if (p.row_version !== i.row_version) throw stale();
      if (['submitted'].includes(p.stage) && drafting) throw conflict('An application was already submitted', { code: 'already_applied' });
      await c.query(
        `UPDATE representation_pipeline SET stage=coalesce($2, stage), note_enc=CASE WHEN $3::boolean THEN $4 ELSE note_enc END, draft_message=CASE WHEN $5::boolean THEN $6 ELSE draft_message END, draft_sections=coalesce($7, draft_sections), row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [p.id, i.stage ?? null, i.note !== undefined, encrypt(i.note, 'representation_pipeline.note'), i.draft_message !== undefined, i.draft_message ?? null, i.draft_sections ? [...new Set(i.draft_sections)] : null]);
      await logEvent(c, p.mandate_id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', drafting ? 'application_drafted' : 'pipeline_updated', { subject_type: 'billboard_post', subject_id: p.post_id, detail: { stage: i.stage ?? p.stage } });
      return pipeView((await c.query(`SELECT ${PIPE_COLS} ${PIPE_FROM} WHERE p.id=$1`, [p.id])).rows[0]);
    });
  },
});

// ------------------------------------------------------------------ approvals
const APPROVAL_COLS = `a.id, a.mandate_id, a.kind, a.pipeline_id, a.summary, a.status, a.requested_by, a.decided_by, a.decided_at, a.decision_note, a.result, a.expires_at, a.row_version, a.created_at, u.display_name AS requested_by_name`;

cap({
  name: 'request_representation_approval', method: 'POST', path: '/representation/pipeline/:id/approval', tag: TAG, status: 201,
  summary: 'Agent: ask the athlete (or a guardian) to approve expressing interest in a shared opportunity, or submitting the drafted application. The application is sent as the athlete only after they approve; accepting a position or an offer is never an approval kind. Expires after the approval window. Repeating returns the pending request.',
  input: z.object({ id, kind: z.enum(['express_interest', 'submit_application']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT p.*, b.title AS post_title FROM representation_pipeline p JOIN billboard_posts b ON b.id=p.post_id WHERE p.id=$1 FOR UPDATE OF p', [i.id])).rows[0];
      if (!p) throw notFound('Opportunity');
      const live = await requireLive(c, user, p.mandate_id, { purpose: 'opportunity_outreach', action: i.kind === 'express_interest' ? 'express_interest' : 'draft_applications', staff: 'outreach' });
      if (p.response_id) throw conflict('An application was already submitted for this opportunity', { code: 'already_applied' });
      if (i.kind === 'submit_application' && !p.draft_message && !p.draft_sections.length) throw badRequest('Draft the application first so the athlete can read what would be sent');
      const pending = (await c.query("SELECT id FROM representation_approvals WHERE pipeline_id=$1 AND kind=$2 AND status='pending' AND expires_at > now()", [p.id, i.kind])).rows[0];
      let aid = pending?.id;
      if (!aid) {
        const summary = i.kind === 'express_interest' ? `Tell the poster you are interested in "${p.post_title}"` : `Apply to "${p.post_title}"${p.draft_message ? ` with this message: ${p.draft_message}` : ''}`;
        aid = (await c.query(
          "INSERT INTO representation_approvals(mandate_id, kind, pipeline_id, summary, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING id",
          [p.mandate_id, i.kind, p.id, summary.slice(0, 300), user.id, String(APPROVAL_DAYS())])).rows[0].id;
        await c.query("UPDATE representation_pipeline SET stage='awaiting_athlete', row_version=row_version+1, updated_at=now() WHERE id=$1", [p.id]);
        await logEvent(c, p.mandate_id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', 'approval_requested', { subject_type: 'billboard_post', subject_id: p.post_id, detail: { kind: i.kind } });
        await notifyAthleteSide(c, live.mandate, { kind: 'representation_approval', title: 'Your agent needs your approval', body: summary.slice(0, 200), data: { approval_id: aid } }, user.id);
      }
      return (await c.query(`SELECT ${APPROVAL_COLS} FROM representation_approvals a JOIN users u ON u.id=a.requested_by WHERE a.id=$1`, [aid])).rows[0];
    });
  },
});

cap({
  name: 'list_representation_approvals', method: 'GET', path: '/representation/mandates/:id/approvals', tag: TAG,
  summary: 'Approvals asked under a mandate: waiting, approved, declined, cancelled or expired. Both sides see them.',
  input: z.object({ id, status: z.enum(['pending', 'approved', 'declined', 'cancelled', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    await loadMandate(pool, user, i.id);
    return many(`SELECT ${APPROVAL_COLS} FROM representation_approvals a JOIN users u ON u.id=a.requested_by WHERE a.mandate_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.created_at DESC, a.id LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'cancel_representation_approval', method: 'POST', path: '/representation/approvals/:id/cancel', tag: TAG,
  summary: 'Agent: take back an approval request that is still waiting.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM representation_approvals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Approval');
      const ctx = await loadMandate(c, user, a.mandate_id);
      if (!ctx.acting) throw forbidden('Only the agent side can cancel its request');
      if (a.status === 'cancelled') return a;
      if (a.status !== 'pending') throw conflict(`That approval is ${a.status}`, { code: 'not_pending' });
      await c.query("UPDATE representation_approvals SET status='cancelled', row_version=row_version+1 WHERE id=$1", [a.id]);
      if (a.pipeline_id) await c.query("UPDATE representation_pipeline SET stage='drafting', row_version=row_version+1, updated_at=now() WHERE id=$1 AND stage='awaiting_athlete'", [a.pipeline_id]);
      await logEvent(c, a.mandate_id, user.id, 'agent', 'approval_cancelled', { detail: { kind: a.kind } });
      return { ...a, status: 'cancelled' };
    });
  },
});

cap({
  name: 'decide_representation_approval', method: 'POST', path: '/representation/approvals/:id/decision', tag: TAG,
  summary: 'Athlete side: approve or decline what the agent asked. Approving a submit_application sends the application to the poster as you (for a young person: as the guardian on their behalf), using the normal application rules and eligibility; approving express_interest tells the poster you are interested. The mandate must still be live. Repeating a decision changes nothing.',
  input: z.object({ id, decision: z.enum(['approve', 'decline']), note: text(500).optional(), row_version: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    const a0 = await one('SELECT * FROM representation_approvals WHERE id=$1', [i.id]);
    if (!a0) throw notFound('Approval');
    const ctx0 = await loadMandate(pool, user, a0.mandate_id);
    if (!canDecide(ctx0.side)) throw forbidden(ctx0.side === 'youth' ? 'A guardian approves for a young person' : 'Only the athlete or a guardian decides');
    if (a0.status !== 'pending') {
      const same = (a0.status === 'approved') === (i.decision === 'approve') && ['approved', 'declined'].includes(a0.status);
      if (same) return { ...a0 };
      throw conflict(`That approval is ${a0.status}`, { code: 'not_pending' });
    }
    if (i.row_version != null && a0.row_version !== i.row_version) throw stale();
    if (new Date(a0.expires_at) <= new Date()) throw conflict('That approval has expired; ask your agent to request it again', { code: 'expired' });
    let result = {};
    if (i.decision === 'approve') {
      const state = await assess(pool, ctx0.mandate, { agent: ctx0.agent });
      if (!state.live) { const e = forbidden('This mandate is not in force, so nothing can be sent on your behalf'); e.details = { code: 'mandate_not_live', reason: state.reason }; throw e; }
      const p = await one('SELECT p.*, b.title FROM representation_pipeline p JOIN billboard_posts b ON b.id=p.post_id WHERE p.id=$1', [a0.pipeline_id]);
      if (a0.kind === 'submit_application') {
        // exactly the athlete's own application, through the canonical rules (eligibility, consent, one response per post); the key makes a retry harmless
        const respond = capabilities.find((x) => x.name === 'respond_to_post');
        const youth = await isYouth(ctx0.mandate.athlete_id);
        const out = await respond.handler({ user }, { id: p.post_id, message: p.draft_message ?? undefined, shared_sections: p.draft_sections, source_kind: 'other', on_behalf_of: youth ? ctx0.mandate.athlete_id : undefined, idempotency_key: `rep-${a0.id}` });
        result = { response_id: out.id, post_id: out.post_id, replayed: !!out.replayed };
      } else {
        const post = await one('SELECT author_id, title FROM billboard_posts WHERE id=$1', [p.post_id]);
        const youth = await isYouth(ctx0.mandate.athlete_id);
        const who = youth ? 'A representative' : (await one('SELECT display_name FROM users WHERE id=$1', [ctx0.mandate.athlete_id])).display_name;
        await notify(null, post.author_id, { kind: 'representation_interest', title: 'Interest in your opportunity', body: `${who}${youth ? '' : '\'s representative'} expressed interest in "${post.title}". They have not applied; an application comes from the athlete.`, data: { post_id: p.post_id } });
        result = { notified: post.author_id ? true : false };
      }
    }
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM representation_approvals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.status !== 'pending') return a;
      const next = i.decision === 'approve' ? 'approved' : 'declined';
      await c.query('UPDATE representation_approvals SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, result=$5, row_version=row_version+1 WHERE id=$1', [a.id, next, user.id, i.note ?? null, JSON.stringify(result)]);
      if (a.pipeline_id) {
        if (i.decision === 'approve' && a.kind === 'submit_application') await c.query("UPDATE representation_pipeline SET stage='submitted', response_id=$2, athlete_response='interested', row_version=row_version+1, updated_at=now() WHERE id=$1", [a.pipeline_id, result.response_id]);
        else if (i.decision === 'approve') await c.query("UPDATE representation_pipeline SET athlete_response='interested', stage=CASE WHEN stage='awaiting_athlete' THEN 'drafting' ELSE stage END, row_version=row_version+1, updated_at=now() WHERE id=$1", [a.pipeline_id]);
        else await c.query("UPDATE representation_pipeline SET stage=CASE WHEN stage='awaiting_athlete' THEN 'drafting' ELSE stage END, row_version=row_version+1, updated_at=now() WHERE id=$1", [a.pipeline_id]);
      }
      await logEvent(c, a.mandate_id, user.id, ctx0.side, `approval_${next}`, { detail: { kind: a.kind, ...result } });
      await notifyAgentSide(c, ctx0.mandate, { kind: 'representation_approval_decided', title: next === 'approved' ? 'Approved' : 'Declined', body: a.summary.slice(0, 160) }, user.id);
      return { ...a, status: next, result, decided_by: user.id };
    });
  },
});

// ------------------------------------------------------------------ authorised conversations
cap({
  name: 'log_representation_contact', method: 'POST', path: '/representation/mandates/:id/contacts', tag: TAG, status: 201,
  summary: 'Agent: record a conversation or contact request with a club, organiser or sponsor about the athlete\'s opportunities. Needs the "manage conversations" action (and, for a young person, the guardian\'s current contact consent). The athlete side can read the log. The summary is encrypted.',
  input: z.object({ id, pipeline_id: id.optional(), channel: z.enum(['call', 'email', 'meeting', 'message', 'other']), counterparty: text(160).min(2), summary: text(1000).min(2), happened_on: z.string().date() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const live = await requireLive(c, user, i.id, { purpose: 'opportunity_outreach', action: 'manage_conversations', staff: 'outreach' });
      if (i.pipeline_id && !(await c.query('SELECT 1 FROM representation_pipeline WHERE id=$1 AND mandate_id=$2', [i.pipeline_id, i.id])).rowCount) throw notFound('Opportunity');
      const r = (await c.query('INSERT INTO representation_contacts(mandate_id, pipeline_id, channel, counterparty, summary_enc, happened_on, logged_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, mandate_id, pipeline_id, channel, counterparty, happened_on::text AS happened_on, created_at',
        [i.id, i.pipeline_id ?? null, i.channel, i.counterparty, encrypt(i.summary, 'representation_contacts.summary'), i.happened_on, user.id])).rows[0];
      await logEvent(c, i.id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', 'contact_logged', { detail: { channel: i.channel, counterparty: i.counterparty } });
      return r;
    });
  },
});

cap({
  name: 'list_representation_contacts', method: 'GET', path: '/representation/mandates/:id/contacts', tag: TAG,
  summary: 'The conversations the agent logged under a mandate. Both sides read them; reads by the athlete side are audit-logged.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ctx = await loadMandate(pool, user, i.id);
    const rows = await many('SELECT c.id, c.pipeline_id, c.channel, c.counterparty, c.summary_enc, c.happened_on::text AS happened_on, c.created_at, u.display_name AS logged_by_name FROM representation_contacts c JOIN users u ON u.id=c.logged_by WHERE c.mandate_id=$1 ORDER BY c.happened_on DESC, c.created_at DESC, c.id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
    if (ctx.side) await audit(null, user.id, 'read_representation_contacts', 'representation_mandates', i.id);
    return rows.map(({ summary_enc, ...r }) => ({ ...r, summary: dec(summary_enc, 'representation_contacts.summary') }));
  },
});

// ------------------------------------------------------------------ player-contract discussions (#333 stays the only contract table)
const CONTRACT_NEED = { purpose: 'contract_negotiation', category: 'contract_workflow', staff: 'negotiate' };
const noteView = ({ body_enc, ...n }) => ({ ...n, body: dec(body_enc, 'representation_notes.body') });

cap({
  name: 'list_represented_contracts', method: 'GET', path: '/representation/mandates/:id/contracts', tag: TAG,
  summary: 'Agent: the player contracts the athlete shared with you under this mandate, each with its version in force, any version waiting for signatures and your own review state.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireLive(pool, user, i.id, { ...CONTRACT_NEED, staff: 'view' });
    return many(
      `SELECT k.id, k.contract_no, k.title, k.role, k.status, k.currency, k.current_version, g.level,
              (SELECT version FROM player_contract_versions v WHERE v.contract_id=k.id AND v.status='proposed') AS pending_version,
              (SELECT r.state FROM representation_contract_reviews r WHERE r.mandate_id=g.mandate_id AND r.contract_id=k.id ORDER BY r.version_no DESC LIMIT 1) AS review_state
         FROM representation_grants g JOIN player_contracts k ON k.id=g.subject_id AND k.payee_id=(SELECT athlete_id FROM representation_mandates WHERE id=g.mandate_id)
        WHERE g.mandate_id=$1 AND g.subject_type='player_contract' AND g.revoked_at IS NULL AND k.status <> 'draft' ORDER BY k.created_at DESC`, [i.id]);
  },
});

cap({
  name: 'get_represented_contract', method: 'GET', path: '/representation/mandates/:id/contracts/:contract_id', tag: TAG,
  summary: 'Agent: one shared player contract as you are allowed to see it - its versions with terms, status and who signed, your review state and your negotiation notes. No bank details, ledger, expenses, payout runs or other people\'s notes. Live-checked and audit-logged; it stops the moment the athlete stops sharing or the mandate ends.',
  input: z.object({ id, contract_id: id }),
  async handler({ user }, i) {
    const live = await requireLive(pool, user, i.id, { ...CONTRACT_NEED, staff: 'view', subject: { type: 'player_contract', id: i.contract_id, level: 'view' } });
    const k = await one("SELECT id, contract_no, title, role, status, currency, current_version, row_version, team_id, event_id, payee_id FROM player_contracts WHERE id=$1 AND payee_id=$2 AND status <> 'draft'", [i.contract_id, live.mandate.athlete_id]);
    if (!k) throw notFound('Contract');
    const payer = await loadPayer(k);
    const versions = (await pool.query(`SELECT ${CONTRACT_VERSION_COLS} FROM player_contract_versions WHERE contract_id=$1 AND status <> 'draft' ORDER BY version`, [k.id])).rows;
    const sigs = versions.length ? (await pool.query('SELECT version_id, party, decision, signed_at FROM player_contract_signatures WHERE version_id = ANY($1) ORDER BY signed_at', [versions.map((v) => v.id)])).rows : [];
    const reviews = await many('SELECT version_no, state, updated_at FROM representation_contract_reviews WHERE mandate_id=$1 AND contract_id=$2 ORDER BY version_no', [i.id, k.id]);
    const notes = (await many('SELECT n.id, n.version_no, n.kind, n.visibility, n.body_enc, n.suggestion, n.created_at, u.display_name AS author FROM representation_notes n JOIN users u ON u.id=n.author_id WHERE n.mandate_id=$1 AND n.contract_id=$2 ORDER BY n.created_at', [i.id, k.id])).map(noteView);
    await audit(null, user.id, 'read_represented_contract', 'player_contracts', k.id);
    const grant = await one("SELECT level FROM representation_grants WHERE mandate_id=$1 AND subject_type='player_contract' AND subject_id=$2 AND revoked_at IS NULL", [i.id, k.id]);
    const { team_id, event_id, payee_id, ...head } = k;
    return {
      ...head, payer: { type: payer.type, name: payer.row?.name ?? null }, level: grant.level,
      versions: versions.map((v) => ({ ...v, required_parties: v.required_parties, signatures: sigs.filter((s) => s.version_id === v.id).map(({ party, decision, signed_at }) => ({ party, decision, signed_at })) })),
      reviews, notes, reminder: 'Only the athlete (and a guardian for a young person) signs. Your review and notes never replace a signature.', as_of: new Date().toISOString(), mandate_id: live.mandate.id,
    };
  },
});

cap({
  name: 'set_contract_review_state', method: 'POST', path: '/representation/mandates/:id/contracts/:contract_id/review', tag: TAG,
  summary: 'Agent: track where you are on a version of a shared contract (to review, reviewing, reviewed, changes requested). This is your own tracking and an update the athlete can see; it is not an approval and never counts as a signature.',
  input: z.object({ id, contract_id: id, version_no: z.coerce.number().int().min(1), state: z.enum(['to_review', 'reviewing', 'reviewed', 'changes_requested']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const live = await requireLive(c, user, i.id, { ...CONTRACT_NEED, subject: { type: 'player_contract', id: i.contract_id, level: 'view' } });
      if (!(await c.query('SELECT 1 FROM player_contract_versions WHERE contract_id=$1 AND version=$2 AND status <> $3', [i.contract_id, i.version_no, 'draft'])).rowCount) throw notFound('Version');
      const r = (await c.query(
        `INSERT INTO representation_contract_reviews(mandate_id, contract_id, version_no, state, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (mandate_id, contract_id, version_no) DO UPDATE SET state=EXCLUDED.state, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING mandate_id, contract_id, version_no, state, updated_at`, [i.id, i.contract_id, i.version_no, i.state, user.id])).rows[0];
      await logEvent(c, i.id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', 'contract_review', { subject_type: 'player_contract', subject_id: i.contract_id, detail: { version: i.version_no, state: i.state } });
      return r;
    });
  },
});

cap({
  name: 'add_negotiation_note', method: 'POST', path: '/representation/mandates/:id/contracts/:contract_id/notes', tag: TAG, status: 201,
  summary: 'Agent: comment on a shared contract (needs the participate level). A note has controlled visibility - agent only, the athlete too, or all parties of the contract including the club - and may carry a suggestion in words and numbers. A suggestion is never applied to the contract: a change goes through a normal amendment that the athlete signs. The text is encrypted.',
  input: z.object({ id, contract_id: id, version_no: z.coerce.number().int().min(1).optional(), kind: z.enum(['note', 'suggestion']).default('note'), visibility: z.enum(['agent_only', 'athlete', 'all_parties']), body: text(2000).min(2),
    suggestion: z.object({ topic: text(80).min(2), proposal: text(500).min(2), amount_cents: z.coerce.number().int().min(0).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const live = await requireLive(c, user, i.id, { ...CONTRACT_NEED, subject: { type: 'player_contract', id: i.contract_id, level: 'participate' } });
      const k = (await c.query("SELECT * FROM player_contracts WHERE id=$1 AND payee_id=$2 AND status IN ('offered','active')", [i.contract_id, live.mandate.athlete_id])).rows[0];
      if (!k) throw conflict('That contract is not open for discussion (it must be offered or active)', { code: 'not_open' });
      if (i.kind === 'suggestion' && !i.suggestion) throw badRequest('A suggestion needs its topic and proposal');
      const n = (await c.query('INSERT INTO representation_notes(mandate_id, contract_id, version_no, kind, visibility, body_enc, suggestion, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, version_no, kind, visibility, suggestion, created_at',
        [i.id, k.id, i.version_no ?? null, i.kind, i.visibility, encrypt(i.body, 'representation_notes.body'), JSON.stringify(i.suggestion ?? {}), user.id])).rows[0];
      await logEvent(c, i.id, user.id, live.acting.via === 'staff' ? 'staff' : 'agent', 'negotiation_note', { subject_type: 'player_contract', subject_id: k.id, detail: { visibility: i.visibility, kind: i.kind } });
      if (i.visibility !== 'agent_only') await notifyAthleteSide(c, live.mandate, { kind: 'representation_note', title: i.kind === 'suggestion' ? 'Your agent suggested a change' : 'Your agent added a note', body: `${k.contract_no}. Open the contract to read it.`, data: { contract_id: k.id } }, user.id);
      if (i.visibility === 'all_parties') {
        const payer = await loadPayer(k, c);
        const to = payer.type === 'team' ? payer.row.owner_id : payer.row.organizer_id;
        if (to) await notify(c, to, { kind: 'representation_note', title: 'A representative commented on a contract', body: `${k.contract_no}. Open the contract to read it.`, data: { contract_id: k.id } });
      }
      return n;
    });
  },
});

cap({
  name: 'list_negotiation_notes', method: 'GET', path: '/player-contracts/:id/negotiation-notes', tag: TAG,
  summary: 'Notes an agent made about this contract that are visible to you: the person paid (and their guardian) see notes marked for the athlete or all parties; the club sees only notes marked for all parties. Agent-only notes are never shown here.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { contract, access } = await loadContract(user, i.id, pool);
    const levels = access.role === 'staff' ? ['all_parties'] : ['athlete', 'all_parties'];
    return (await many('SELECT n.id, n.version_no, n.kind, n.visibility, n.body_enc, n.suggestion, n.created_at, u.display_name AS author FROM representation_notes n JOIN users u ON u.id=n.author_id WHERE n.contract_id=$1 AND n.visibility = ANY($2) ORDER BY n.created_at', [contract.id, levels])).map(noteView);
  },
});

// ------------------------------------------------------------------ sponsorship agreements shared by the athlete
const SPONSOR_NEED = { category: 'sponsorship_discussions', staff: 'view' };
cap({
  name: 'list_represented_sponsorships', method: 'GET', path: '/representation/mandates/:id/sponsorships', tag: TAG,
  summary: 'Agent: the sponsorship agreements the athlete shared with you under this mandate. Needs the sponsorship purpose (or endorsement) and the sponsorship-discussions access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const live = await requireLive(pool, user, i.id, SPONSOR_NEED);
    if (!live.version.purposes.some((p) => p === 'sponsorship_commercial' || p === 'media_endorsement')) { const e = forbidden('This mandate has no sponsorship purpose'); e.details = { code: 'mandate_not_live', reason: 'purpose_not_in_mandate' }; throw e; }
    return many(
      `SELECT s.id, s.agreement_ref, sp.name AS sponsor_name, s.status, s.currency, s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.terms_version, s.accepted_version
         FROM representation_grants g JOIN sponsorships s ON s.id=g.subject_id AND s.target_type='athlete' AND s.target_id=$2 JOIN sponsors sp ON sp.id=s.sponsor_id
        WHERE g.mandate_id=$1 AND g.subject_type='sponsorship' AND g.revoked_at IS NULL ORDER BY s.created_at DESC`, [i.id, live.mandate.athlete_id]);
  },
});

cap({
  name: 'get_represented_sponsorship', method: 'GET', path: '/representation/mandates/:id/sponsorships/:sponsorship_id', tag: TAG,
  summary: 'Agent: one shared sponsorship agreement - parties, status, dates, committed money lines and the money confirmed so far. Not the sponsor\'s private notes or messages. Live-checked and audit-logged. You cannot accept or change an agreement for the athlete.',
  input: z.object({ id, sponsorship_id: id }),
  async handler({ user }, i) {
    const live = await requireLive(pool, user, i.id, { ...SPONSOR_NEED, subject: { type: 'sponsorship', id: i.sponsorship_id, level: 'view' } });
    if (!live.version.purposes.some((p) => p === 'sponsorship_commercial' || p === 'media_endorsement')) { const e = forbidden('This mandate has no sponsorship purpose'); e.details = { code: 'mandate_not_live', reason: 'purpose_not_in_mandate' }; throw e; }
    const s = await one("SELECT s.id, s.agreement_ref, sp.name AS sponsor_name, s.status, s.currency, s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.terms_version, s.accepted_version, s.decided_at FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.id=$1 AND s.target_type='athlete' AND s.target_id=$2", [i.sponsorship_id, live.mandate.athlete_id]);
    if (!s) throw notFound('Sponsorship');
    const lines = await many("SELECT kind, label, currency, total_cents, cadence, first_due_on::text AS first_due_on FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 ORDER BY position", [s.id, s.accepted_version ?? s.terms_version]);
    const money = await one("SELECT coalesce(sum(p.amount_cents - p.refunded_cents),0)::bigint AS confirmed_cents FROM sponsorship_payments p JOIN sponsorship_obligations o ON o.id=p.obligation_id WHERE o.sponsorship_id=$1 AND o.kind='money' AND p.status='confirmed'", [s.id]);
    await audit(null, user.id, 'read_represented_sponsorship', 'sponsorships', s.id);
    return { ...s, lines, confirmed_cents: Number(money.confirmed_cents), reminder: 'Only the athlete accepts or changes a sponsorship agreement.', as_of: new Date().toISOString(), mandate_id: live.mandate.id };
  },
});
