// Pause / resume of an accepted sponsorship agreement (#297). A pause never inserts, cancels or waives a due: it flags the not-yet-due dues in
// place (held_by_pause_id) and resume moves them in place, so the (sponsorship, version, line, seq) key makes duplicates impossible and a debt
// cannot disappear. Dues that were already due before the pause, or that anything has happened to (money reported or in checkout, goods,
// an endorsement submission), are never held.
import { pool, tx } from './db.js';

const rows = async (q, sql, params = []) => (await q.query(sql, params)).rows;
import { logHistory } from './sponsor-agreements.js';
import { notify } from './notify.js';
import { notifySponsor } from './sponsor-access.js';
import { ORG_TARGETS, primaryContact, targetOrgId } from './sponsor-beneficiaries.js';
import { sponsorContactUser } from './sponsor-identity-access.js';

export const PAUSE_REASONS = ['injury', 'season_break', 'funding_review', 'force_majeure', 'other'];
export const OPEN_PAUSE = ['requested', 'scheduled', 'active'];

const targetOwner = async (c, type, id) => type === 'event' ? (await c.query('SELECT organizer_id AS u FROM events WHERE id=$1', [id])).rows[0]?.u
  : type === 'team' ? (await c.query('SELECT owner_id AS u FROM teams WHERE id=$1', [id])).rows[0]?.u : id;

/** Tell both parties (never amounts or terms), except the person who acted. */
export async function pingParties(c, d, title, except = null) {
  const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [d.sponsor_id])).rows[0];
  const msg = { kind: 'sponsorship_update', title, body: `Open the ${sp.name} agreement to see the update.`, data: { sponsorship_id: d.id } };
  const to = ORG_TARGETS.includes(d.target_type) ? await primaryContact(c, await targetOrgId(c, d.target_type, d.target_id)) : await targetOwner(c, d.target_type, d.target_id);
  if (to && to !== except) await notify(c, to, msg);
  await notifySponsor(c, { ...sp, owner_id: await sponsorContactUser(c, sp) }, 'pause', msg, d.department_id, except);
}

/** The latest pause of an agreement (open one first), as both parties see it. */
export async function currentPause(q, sponsorshipId) {
  return rows(q,
    `SELECT p.id, p.requested_by_side, p.reason_code, p.reason, p.policy, p.effective_from::text AS effective_from, p.planned_resume_on::text AS planned_resume_on, p.status,
            p.decision_note, p.decided_at, p.resumed_on::text AS resumed_on, p.resumed_at, p.summary, p.created_at, ru.display_name AS requested_by, du.display_name AS decided_by
       FROM sponsorship_pauses p JOIN users ru ON ru.id=p.requested_by LEFT JOIN users du ON du.id=p.decided_by
      WHERE p.sponsorship_id=$1 ORDER BY (p.status IN ('requested','scheduled','active')) DESC, p.created_at DESC, p.id DESC`, [sponsorshipId]);
}

/**
 * Hold the dues a pause covers. Candidate rows are locked in one statement and flagged in a second one (a fresh snapshot), so a payment
 * reported a moment earlier is seen and keeps its due out of the pause.
 */
export async function applyPause(c, pause, d, actor) {
  await c.query(
    `SELECT id FROM sponsorship_obligations WHERE sponsorship_id=$1 AND status='scheduled' AND due_on >= $2 AND held_by_pause_id IS NULL ORDER BY id FOR UPDATE`, [d.id, pause.effective_from]);
  await c.query(
    `UPDATE sponsorship_obligations o SET held_by_pause_id=$3
      WHERE o.sponsorship_id=$1 AND o.status='scheduled' AND o.due_on >= $2 AND o.held_by_pause_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status IN ('reported','confirmed','awaiting_payment'))
        AND NOT EXISTS (SELECT 1 FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status <> 'rejected')
        AND NOT EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status <> 'revision_requested')`, [d.id, pause.effective_from, pause.id]);
  const stats = (await c.query("SELECT count(*)::int AS dues FROM sponsorship_obligations WHERE held_by_pause_id=$1", [pause.id])).rows[0];
  const money = await c.query("SELECT currency, sum(amount_cents)::bigint AS cents FROM sponsorship_obligations WHERE held_by_pause_id=$1 AND kind='money' GROUP BY currency ORDER BY currency", [pause.id]);
  const summary = { held_dues: stats.dues, held_cents: Object.fromEntries(money.rows.map((r) => [r.currency, Number(r.cents)])) };
  await c.query("UPDATE sponsorship_pauses SET status='active', summary=$2 WHERE id=$1", [pause.id, JSON.stringify(summary)]);
  await c.query("UPDATE sponsorships SET status='paused', pause_rev=pause_rev+1 WHERE id=$1", [d.id]);
  await logHistory(c, d.id, d.accepted_version ?? d.terms_version, actor, 'paused', `${pause.policy} from ${pause.effective_from}`);
  return summary;
}

/** What resuming today would do to each held due, and to the end of the agreement. Pure read. */
export async function resumePlan(q, pause, d) {
  const dues = await rows(q,
    `SELECT o.id, o.kind, l.label, o.currency, o.amount_cents, o.due_on::text AS due_on,
            (CASE $2 WHEN 'hold' THEN greatest(o.due_on, current_date) ELSE o.due_on + greatest(current_date - $3::date, 0) END)::text AS new_due_on
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.held_by_pause_id=$1 AND o.status='scheduled' ORDER BY o.due_on, o.id`, [pause.id, pause.policy, pause.effective_from]);
  const shift = (await rows(q, 'SELECT greatest(current_date - $1::date, 0)::int AS days', [pause.effective_from]))[0].days;
  const latest = dues.reduce((m, x) => (x.new_due_on > m ? x.new_due_on : m), '');
  const ends = d.ends ?? d.ends_on;
  let newEnds = ends;
  if (ends) {
    if (pause.policy === 'reschedule') newEnds = (await rows(q, 'SELECT ($1::date + $2::int)::text AS e', [ends, shift]))[0].e;
    if (latest && latest > newEnds) newEnds = latest;
  }
  const totals = {};
  for (const x of dues) if (x.kind === 'money') totals[x.currency] = (totals[x.currency] ?? 0) + Number(x.amount_cents);
  return { policy: pause.policy, resume_on: (await rows(q, 'SELECT current_date::text AS d'))[0].d, shift_days: shift, dues, totals, ends_on: ends ?? null, new_ends_on: newEnds ?? null };
}

/** Move the held dues in place, release them, and reopen the agreement. Never inserts a due. */
export async function applyResume(c, pause, d, actor) {
  const plan = await resumePlan(c, pause, d);
  await c.query(
    `UPDATE sponsorship_obligations o SET held_by_pause_id=NULL,
            original_due_on=CASE WHEN o.due_on <> n.new_due THEN coalesce(o.original_due_on, o.due_on) ELSE o.original_due_on END, due_on=n.new_due
       FROM (SELECT x.id, CASE $2 WHEN 'hold' THEN greatest(x.due_on, current_date) ELSE x.due_on + greatest(current_date - $3::date, 0) END AS new_due
               FROM sponsorship_obligations x WHERE x.held_by_pause_id=$1) n WHERE o.id=n.id`, [pause.id, pause.policy, pause.effective_from]);
  if (plan.new_ends_on && plan.new_ends_on !== plan.ends_on) await c.query('UPDATE sponsorships SET ends_on=$2 WHERE id=$1', [d.id, plan.new_ends_on]);
  const summary = { ...(pause.summary ?? {}), resumed_dues: plan.dues.length, shift_days: plan.shift_days, ends_on: plan.ends_on, new_ends_on: plan.new_ends_on };
  await c.query("UPDATE sponsorship_pauses SET status='resumed', resumed_by=$2, resumed_on=current_date, resumed_at=now(), summary=$3 WHERE id=$1", [pause.id, actor, JSON.stringify(summary)]);
  await c.query("UPDATE sponsorships SET status='active', pause_rev=pause_rev+1 WHERE id=$1", [d.id]);
  await logHistory(c, d.id, d.accepted_version ?? d.terms_version, actor, 'resumed', `${plan.dues.length} dues released`);
  return { plan, summary };
}

/** Ending an agreement closes its open pause and releases any held due, so a debt that is still owed stays payable. */
export async function closePauseOnEnd(c, sponsorshipId) {
  await c.query("UPDATE sponsorship_pauses SET status='ended' WHERE sponsorship_id=$1 AND status = ANY($2)", [sponsorshipId, OPEN_PAUSE]);
  await c.query('UPDATE sponsorship_obligations SET held_by_pause_id=NULL WHERE sponsorship_id=$1 AND held_by_pause_id IS NOT NULL', [sponsorshipId]);
}

/** Worker step: an approved pause whose start date has arrived takes effect. */
export async function activateDuePauses() {
  const due = await rows(pool, "SELECT id, sponsorship_id FROM sponsorship_pauses WHERE status='scheduled' AND effective_from <= current_date ORDER BY effective_from, id");
  let n = 0;
  for (const x of due) {
    n += await tx(async (c) => {
      const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1 FOR UPDATE', [x.sponsorship_id])).rows[0];
      const p = (await c.query("SELECT *, effective_from::text AS effective_from FROM sponsorship_pauses WHERE id=$1 AND status='scheduled' FOR UPDATE", [x.id])).rows[0];
      if (!p) return 0;
      if (d.status !== 'active') { await c.query("UPDATE sponsorship_pauses SET status='ended' WHERE id=$1", [p.id]); return 0; }
      await applyPause(c, p, d, p.decided_by);
      await pingParties(c, d, 'A sponsorship pause has started');
      return 1;
    });
  }
  return n;
}
