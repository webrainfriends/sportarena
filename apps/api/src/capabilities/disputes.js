// Disputes (SPOR-70, 71, 72, 74): staff context for a case's linked records, and routing/decisions for disputes on game data.
// Everything here READS the canonical records or calls their own capabilities; a case never edits another domain directly.
import { z } from 'zod';
import { capabilities, cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { MANAGER_ROLES } from '../ontology/iptc.js';
import { ACTIVE, SLA_SQL } from '../cases.js';
import { canManageGame } from './games.js';

const TAG = 'Support & Disputes';

// Only what a person handling the case needs to judge it. Deliberately no clinical text (appointment reason, notes),
// no policy numbers, no provider payment references.
const SAFE = {
  payment: ['payments', 'purpose_type, purpose_id, provider, amount_cents, currency, status, refunded_cents, created_at, paid_at, refunded_at'],
  reservation: ['reservations', 'code, status, currency, subtotal_cents, discount_cents, total_cents, created_at'],
  booking: ['bookings', 'status, starts_at, ends_at, price_cents, payment_status, refund_cents'],
  invoice: ['invoices', 'number, kind, status, currency, total_cents, tax_cents, issued_at, paid_at'],
  shop_order: ['shop_orders', 'status, quantity, total_cents, created_at'],
  coach_hire: ['coach_hires', 'status, payment_status, starts_at, duration_min, total_cents, created_at'],
  appointment: ['appointments', 'status, starts_at, duration_min, created_at'],
  insurance_policy: ['insurance_policies', 'status, starts_on, ends_on, amount_cents'],
  sponsorship: ['sponsorships', 'status, target_type, amount_cents, starts_on, ends_on'],
  event: ['events', 'name, status, starts_on'],
  game: ['games', 'title, status, starts_at'],
  fixture: ['fixtures', 'status, home_score, away_score, scheduled_at'],
};

cap({
  name: 'get_case_records', method: 'GET', path: '/admin/cases/:id/records', tag: TAG, auth: ['admin'],
  summary: 'Platform team: a safe summary of each canonical record a case links to (amounts, statuses, dates). Clinical text, policy numbers and provider payment references are never included. The read is audit-logged; you cannot read records on your own case.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cs = await one('SELECT id, requester_id FROM cases WHERE id=$1', [i.id]);
    if (!cs) throw notFound('Case');
    if (cs.requester_id === user.id) throw forbidden('Another platform team member must handle your own case');
    const links = await many('SELECT entity_type, entity_id FROM case_links WHERE case_id=$1 ORDER BY created_at', [i.id]);
    const out = [];
    for (const l of links) {
      const [table, cols] = SAFE[l.entity_type];
      out.push({ entity_type: l.entity_type, entity_id: l.entity_id, record: await one(`SELECT ${cols} FROM ${table} WHERE id=$1`, [l.entity_id]) });
    }
    await audit(null, user.id, 'read_case_records', 'cases', i.id);
    return out;
  },
});

// ------------------------------------------------------------------ game data disputes
/** May this person decide a game-data dispute? Game managers, the event organiser, the fixture's referee, or admin. Never the requester. */
export async function officialCanHandle(user, cs) {
  if (cs.routed_to !== 'game_officials' || cs.requester_id === user.id) return false;
  if (isAdmin(user)) return true;
  const link = await one("SELECT entity_type, entity_id FROM case_links WHERE case_id=$1 AND entity_type IN ('game','fixture') LIMIT 1", [cs.id]);
  if (!link) return false;
  if (link.entity_type === 'game') { const g = await one('SELECT * FROM games WHERE id=$1', [link.entity_id]); return !!g && canManageGame(user, g); }
  const f = await one('SELECT f.referee_id, e.organizer_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [link.entity_id]);
  return !!f && [f.referee_id, f.organizer_id].includes(user.id);
}

cap({
  name: 'list_game_disputes', method: 'GET', path: '/game-disputes', tag: TAG,
  summary: 'Disputes about game data that are routed to you as a game manager, event organiser or fixture referee (the platform team sees all). The requester is never listed as their own decider.',
  input: z.object({ status: z.enum(['active', 'resolved']).default('active'), ...page }),
  handler: ({ user }, i) => many(
    `SELECT c.id, c.case_no, c.subject, c.status, c.details, c.created_at, ${SLA_SQL} AS sla_state, l.entity_type, l.entity_id
       FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type IN ('game','fixture')
       LEFT JOIN games g ON l.entity_type='game' AND g.id=l.entity_id
       LEFT JOIN fixtures f ON l.entity_type='fixture' AND f.id=l.entity_id
       LEFT JOIN events e ON e.id = COALESCE(f.event_id, g.competition_id)
      WHERE c.routed_to='game_officials' AND c.requester_id <> $1 AND (($2 = 'active' AND c.status = ANY($3)) OR ($2 = 'resolved' AND c.status = 'resolved'))
        AND ($4 OR g.created_by=$1 OR e.organizer_id=$1 OR f.referee_id=$1
             OR EXISTS (SELECT 1 FROM associations a WHERE a.target_type='game' AND a.target_id=g.id AND a.user_id=$1 AND a.status='active' AND a.role = ANY($5)))
      ORDER BY c.created_at LIMIT $6 OFFSET $7`,
    [user.id, i.status, ACTIVE, isAdmin(user), MANAGER_ROLES, i.limit, i.offset]),
});

const call = (name, user, input) => {
  const c = capabilities.find((x) => x.name === name);
  return c.handler({ user }, c.input.parse(input));
};

cap({
  name: 'decide_game_dispute', method: 'POST', path: '/game-disputes/:id/decision', tag: TAG,
  summary: 'Game manager / event organiser / fixture referee / admin: accept or reject a game-data dispute. Accepting applies the claimed value through the normal result capability (update_game_participant or record_result, with its own permission and validation rules), and keeps the before/after in an immutable correction record. Participants are notified. The requester cannot decide their own dispute.',
  input: z.object({ id, decision: z.enum(['accept', 'reject']), reason: z.string().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cs = (await c.query("SELECT * FROM cases WHERE id=$1 AND kind='dispute' AND category='game_data' FOR UPDATE", [i.id])).rows[0];
      if (!cs || !(await officialCanHandle(user, cs))) throw notFound('Dispute');
      if (!ACTIVE.includes(cs.status)) throw conflict(`Case is ${cs.status}`);
      const link = (await c.query("SELECT entity_type, entity_id FROM case_links WHERE case_id=$1 AND entity_type IN ('game','fixture') LIMIT 1", [cs.id])).rows[0];
      const { contested_field: field, claimed_value: claimed, participant_id: participantId } = cs.details;
      let correction = null;
      if (i.decision === 'accept') {
        if (link.entity_type === 'game') {
          const p = (await c.query('SELECT * FROM game_participants WHERE id=$1 AND game_id=$2', [participantId, link.entity_id])).rows[0];
          if (!p) throw notFound('Participant');
          const before = p[field] === null || isNaN(Number(p[field])) ? p[field] : Number(p[field]);
          await call('update_game_participant', user, { id: link.entity_id, participant_id: participantId, [field]: claimed });
          correction = { target_type: 'game_participant', target_id: participantId, before, after: claimed };
        } else {
          const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [link.entity_id])).rows[0];
          if (f.home_score === null || f.away_score === null) throw badRequest('This fixture has no recorded result to correct yet');
          const next = { home_score: f.home_score, away_score: f.away_score, [field]: claimed };
          await call('record_result', user, { id: link.entity_id, ...next });
          correction = { target_type: 'fixture', target_id: link.entity_id, before: f[field], after: claimed };
        }
        await c.query('INSERT INTO case_corrections(case_id, target_type, target_id, field, before, after, applied_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [cs.id, correction.target_type, correction.target_id, field, JSON.stringify(correction.before), JSON.stringify(correction.after), user.id]);
      }
      const accepted = i.decision === 'accept';
      await c.query("UPDATE cases SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), first_responded_at=coalesce(first_responded_at, now()), assignee_id=coalesce(assignee_id,$3), updated_at=now() WHERE id=$1", [cs.id, i.reason, user.id]);
      await c.query('INSERT INTO case_events(case_id, actor_id, action, from_status, to_status, reason, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [cs.id, user.id, accepted ? 'correction_accepted' : 'correction_rejected', cs.status, 'resolved', i.reason, JSON.stringify(correction ? { field, before: correction.before, after: correction.after } : { field })]);
      // everyone whose result changed (or who raised it) hears about it, with generic wording
      if (accepted) {
        const who = link.entity_type === 'game'
          ? (await c.query("SELECT user_id AS id FROM game_participants WHERE game_id=$1 AND user_id IS NOT NULL UNION SELECT m.user_id FROM game_participants p JOIN team_members m ON m.team_id=p.team_id AND m.status='active' WHERE p.game_id=$1", [link.entity_id])).rows
          : (await c.query("SELECT m.user_id AS id FROM fixtures f JOIN team_members m ON m.team_id IN (f.home_team_id, f.away_team_id) AND m.status='active' WHERE f.id=$1", [link.entity_id])).rows;
        const ids = [...new Set([cs.requester_id, ...who.map((r) => r.id)])].filter((x) => x !== user.id).slice(0, 300);
        for (const uid of ids) await notify(c, uid, { kind: 'case_update', title: 'A result was corrected', body: `Case #${cs.case_no}: a recorded result you are part of was corrected after review.`, data: { case_id: cs.id, case_no: cs.case_no } });
      } else await notify(c, cs.requester_id, { kind: 'case_update', title: `Case #${cs.case_no} decided`, body: i.reason, data: { case_id: cs.id, case_no: cs.case_no } });
      return { id: cs.id, status: 'resolved', decision: i.decision, ...(correction ? { correction: { field, before: correction.before, after: correction.after } } : {}) };
    });
  },
});
