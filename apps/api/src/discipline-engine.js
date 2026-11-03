// Sports Disciplinary & Sanctions (#479): the write side shared by the capabilities, the card sweep and the worker. One transaction per decision; every change is a new
// row that supersedes the old one, so the full history survives. Fines go through canonical team finance (a 'fine' charge), points deductions through the competition
// adjustment mechanism (recordAdjustment), and neither edits a match result or a referee record.
import { badRequest, conflict } from './errors.js';
import { encrypt } from './crypto.js';
import { audit } from './helpers.js';
import { raiseBatch } from './team-money.js';
import { syncTeamChargeInvoice } from './team-invoices.js';
import { recordAdjustment, divisionRow } from './capabilities/competitions.js';
import { policyParams, evaluateThresholds, escalate, policyFor, nextCaseNo, log, tell, addDays, today, KIND_INFO } from './discipline.js';

export const sealText = (t, col) => (t ? encrypt(t, `disc.${col}`) : null);

/** Cards of a season that feed its policy: canonical match_events, never voided, with a named player. */
async function seasonCards(c, season, kinds) {
  return (await c.query(
    `SELECT m.id, m.kind, m.fixture_id, m.player_id, m.team_id, COALESCE(m.occurred_at, m.recorded_at) AS at
       FROM match_events m WHERE m.event_id=$1 AND m.voided_at IS NULL AND m.player_id IS NOT NULL AND m.kind = ANY($2::text[])`, [season.event_id, kinds])).rows;
}
export const policyKinds = (p) => [...new Set([...Object.keys(p.card_points), ...p.direct.map((d) => d.kind), ...(p.second_caution ? [p.second_caution.kind] : [])])];

/** The standing of everyone with cards in a season against the policy (read-only; powers the watchlist). */
export async function watchlist(c, season, version) {
  if (!version) return [];
  const p = policyParams.parse(version.params);
  const kinds = policyKinds(p);
  if (!kinds.length) return [];
  const cards = await seasonCards(c, season, kinds);
  const by = new Map();
  for (const x of cards) (by.get(x.player_id) ?? by.set(x.player_id, []).get(x.player_id)).push(x);
  const next = [...p.accumulation].sort((a, b) => a.points - b.points);
  return [...by].map(([player_id, list]) => {
    const triggers = evaluateThresholds(p, list);
    const pts = list.reduce((t, x) => t + (p.card_points[x.kind] ?? 0), 0);
    const spent = triggers.filter((t) => t.rule === 'accumulation').length;
    const toNext = next[0] ? Math.max(0, next[0].points - (pts - spent * next[0].points)) : null;
    return { player_id, team_id: list.find((x) => x.team_id)?.team_id ?? null, cards: list.length, points: pts, triggers: triggers.length, points_to_next_threshold: toNext, by_kind: Object.fromEntries(list.reduce((m, x) => m.set(x.kind, (m.get(x.kind) ?? 0) + 1), new Map())) };
  }).sort((a, b) => b.points - a.points || b.cards - a.cards);
}

async function teamOfPlayer(c, season, userId, hint) {
  if (hint) return hint;
  const r = (await c.query("SELECT team_id FROM reg_registrations WHERE event_id=$1 AND user_id=$2 AND status='registered' ORDER BY created_at DESC LIMIT 1", [season.event_id, userId])).rows[0];
  return r?.team_id ?? null;
}

/**
 * Turn a season's canonical cards into cases and, where the published policy says the consequence is automatic, into the policy decision. Idempotent: a card feeds one case
 * per person (unique index), so a retry, a second sweep or the worker can never make a duplicate. Returns the cases created.
 */
export async function deriveCases(c, seasonId, { actor = null } = {}) {
  const season = (await c.query('SELECT s.*, e.sport_id FROM comp_seasons s JOIN events e ON e.id=s.event_id WHERE s.id=$1', [seasonId])).rows[0];
  if (!season) return [];
  const version = await policyFor(c, season.competition_id, season.id);
  if (!version) return [];
  const p = policyParams.parse(version.params);
  const kinds = policyKinds(p);
  if (!kinds.length) return [];
  const cards = await seasonCards(c, season, kinds);
  const by = new Map();
  for (const x of cards) (by.get(x.player_id) ?? by.set(x.player_id, []).get(x.player_id)).push(x);
  const made = [];
  for (const [playerId, list] of by) {
    const best = new Map();   // one case per triggering card: the strictest rule that fired on it
    for (const t of evaluateThresholds(p, list)) {
      const cur = best.get(t.match_event_id);
      if (!cur || t.matches > cur.matches) best.set(t.match_event_id, t);
    }
    for (const [eventId, t] of best) {
      const card = list.find((x) => x.id === eventId);
      const exists = (await c.query('SELECT 1 FROM disc_cases WHERE match_event_id=$1 AND subject_user_id=$2', [eventId, playerId])).rowCount;
      if (exists) continue;
      const teamId = await teamOfPlayer(c, season, playerId, card.team_id);
      const prior = p.repeat_offence ? (await c.query(
        `SELECT count(*)::int AS n FROM disc_cases k JOIN disc_decisions d ON d.case_id=k.id AND d.superseded_at IS NULL AND d.outcome='upheld'
          WHERE k.subject_user_id=$1 AND k.competition_id=$2 AND d.created_at >= now() - ($3 || ' days')::interval`, [playerId, season.competition_id, String(p.repeat_offence.within_days)])).rows[0].n : 0;
      const matches = escalate(p, t.matches, prior);
      const category = t.rule === 'direct' ? 'serious_foul_play' : 'persistent_infringement';
      const row = (await c.query(
        `INSERT INTO disc_cases(case_no, competition_id, season_id, event_id, sport_id, policy_version_id, source_type, match_event_id, fixture_id, subject_kind, subject_user_id, team_id, category, status, opened_by)
         VALUES ($1,$2,$3,$4,$5,$6,'threshold',$7,$8,'player',$9,$10,$11,'decided',$12) ON CONFLICT DO NOTHING RETURNING *`,
        [await nextCaseNo(c, season.competition_id), season.competition_id, season.id, season.event_id, season.sport_id, version.id, eventId, card.fixture_id, playerId, teamId, category, actor])).rows[0];
      if (!row) continue;
      await log(c, row.id, 'case_opened', { actor, detail: { source: 'threshold', rule: t.rule, card: card.kind, policy_version: version.version } });
      const d = (await c.query(
        `INSERT INTO disc_decisions(case_id, kind, outcome, authority, policy_version_id, reason_enc, automatic, decided_by) VALUES ($1,'initial','upheld','policy',$2,$3,true,NULL) RETURNING *`,
        [row.id, version.id, sealText(`Automatic consequence under the published policy (version ${version.version}): ${t.rule === 'accumulation' ? 'caution threshold reached' : t.rule === 'second_caution' ? 'second caution in one match' : `${KIND_INFO[card.kind]?.label ?? card.kind}`}.`, 'decision')])).rows[0];
      await c.query("INSERT INTO disc_sanctions(decision_id, case_id, kind, scope, matches, effective_from, label) VALUES ($1,$2,'match_suspension',$3,$4,$5,$6)",
        [d.id, row.id, p.scope, matches, today(), `${matches}-match suspension`]);
      await log(c, row.id, 'decision_recorded', { actor, to: 'decided', detail: { automatic: true, matches, rule: t.rule } });
      if (!actor) await audit(c, null, 'discipline_automatic_decision', 'disc_cases', row.id);
      await tell(c, playerId, row);
      made.push(row);
    }
  }
  return made;
}

// ------------------------------------------------------------------------------------------------------------------ decisions
async function divisionOfTeam(c, seasonId, teamId) {
  const r = (await c.query(
    "SELECT d.id FROM comp_memberships m JOIN comp_divisions d ON d.id=m.division_id WHERE d.season_id=$1 AND m.team_id=$2 AND m.status='accepted' ORDER BY m.created_at DESC LIMIT 1", [seasonId, teamId])).rows[0];
  if (!r) throw badRequest('That team is not in a division of this season, so a points deduction cannot be applied');
  return r.id;
}

/** Validate one sanction against the case and the policy that governs it. */
function checkSanction(s, caseRow, p) {
  if (s.kind === 'match_suspension' && !s.matches) throw badRequest('Give the number of matches');
  if (s.kind === 'date_suspension' && !(s.effective_from && s.effective_to)) throw badRequest('A date-based suspension needs a start and an end date');
  if (s.effective_from && s.effective_to && s.effective_to < s.effective_from) throw badRequest('The end date is before the start date');
  if (s.kind === 'fine') {
    if (!p.authority.fines) throw badRequest('This competition’s policy does not give the panel authority to fine');
    if (!s.amount_minor) throw badRequest('Give the fine amount');
    if (p.authority.fine_cap_minor && s.amount_minor > p.authority.fine_cap_minor) throw badRequest(`The fine is above the policy cap of ${p.authority.fine_cap_minor} (minor units)`);
  }
  if (s.kind === 'points_deduction') {
    if (!p.authority.points_deduction) throw badRequest('This competition’s policy does not give the panel authority to deduct points');
    if (!s.points) throw badRequest('Give the points to deduct');
    if (p.authority.points_cap && s.points > p.authority.points_cap) throw badRequest(`The deduction is above the policy cap of ${p.authority.points_cap} points`);
  }
  if (s.kind === 'role_suspension' && !['coach', 'official'].includes(caseRow.subject_kind)) throw badRequest('A role suspension applies to a coach or an official');
  if (s.kind === 'other' && !s.label) throw badRequest('Describe the sanction');
}

/** Take a superseded sanction out of force and undo its money/standings effect the canonical way (reversing row; unpaid charge cancelled). */
async function retire(c, sanction, actor, why) {
  await c.query("UPDATE disc_sanctions SET status='superseded' WHERE id=$1", [sanction.id]);
  const note = [];
  if (sanction.comp_adjustment_id) {
    const a = (await c.query('SELECT * FROM comp_adjustments WHERE id=$1', [sanction.comp_adjustment_id])).rows[0];
    try { await recordAdjustment(c, await divisionRow(c, a.division_id), { team_id: a.team_id, reverses_id: a.id, reason: `Reversal: ${why}`, user_id: actor, disc_sanction_id: sanction.id }); note.push('points_reversed'); }
    catch (e) { note.push('points_not_reversed'); if (!e.status) throw e; }
  }
  if (sanction.team_charge_id) {
    const r = (await c.query("UPDATE team_charges SET status='cancelled' WHERE id=$1 AND status='awaiting_payment' AND settled_minor=0 RETURNING id", [sanction.team_charge_id])).rowCount;
    if (r) {
      await c.query("INSERT INTO team_charge_entries(charge_id, kind, reason_enc, actor_id, idempotency_key) VALUES ($1,'cancelled',$2,$3,'cancelled')", [sanction.team_charge_id, sealText(why, 'fine'), actor]);
      await syncTeamChargeInvoice(c, sanction.team_charge_id);
      note.push('fine_cancelled');
    } else note.push('fine_already_paid_or_settled');
  }
  return note;
}

/**
 * Record a decision. The previous live decision (if any) is superseded in the same transaction and its sanctions leave force; the new sanctions are created
 * (`stayed` when an appeal is pending under a stay policy). Authority, reason and policy version are stored with the decision.
 */
export async function recordDecision(c, caseRow, { user, kind, outcome, authority, reason, sanctions = [], stay = false, supersede = true }) {
  const version = caseRow.policy_version_id ? (await c.query('SELECT * FROM disc_policy_versions WHERE id=$1', [caseRow.policy_version_id])).rows[0] : null;
  const live = (await policyFor(c, caseRow.competition_id, caseRow.season_id)) ?? version;
  const p = policyParams.parse((live ?? version)?.params ?? {});
  if (outcome === 'upheld' && !sanctions.length) throw badRequest('An upheld decision needs at least one sanction (a warning counts)');
  if (outcome !== 'upheld' && sanctions.length) throw badRequest('A dismissed case carries no sanctions');
  for (const s of sanctions) checkSanction(s, caseRow, p);
  const prev = (await c.query('SELECT * FROM disc_decisions WHERE case_id=$1 AND superseded_at IS NULL FOR UPDATE', [caseRow.id])).rows[0];
  if (prev && !supersede) throw conflict('This case already has a decision; record an amendment');
  const notes = [];
  if (prev) {
    await c.query('UPDATE disc_decisions SET superseded_at=now() WHERE id=$1', [prev.id]);
    for (const s of (await c.query("SELECT * FROM disc_sanctions WHERE decision_id=$1 AND status IN ('active','stayed')", [prev.id])).rows) notes.push(...(await retire(c, s, user.id, reason)));
  }
  const d = (await c.query(
    `INSERT INTO disc_decisions(case_id, kind, outcome, authority, policy_version_id, reason_enc, decided_by, supersedes_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [caseRow.id, prev ? (kind === 'initial' ? 'amendment' : kind) : kind, outcome, authority, (live ?? version)?.id ?? null, sealText(reason, 'decision'), user.id, prev?.id ?? null])).rows[0];
  const team = caseRow.team_id ? (await c.query('SELECT * FROM teams WHERE id=$1', [caseRow.team_id])).rows[0] : null;
  const out = [];
  for (const s of sanctions) {
    const status = stay ? 'stayed' : 'active';
    const row = (await c.query(
      `INSERT INTO disc_sanctions(decision_id, case_id, kind, scope, matches, effective_from, effective_to, amount_minor, currency, points, label, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [d.id, caseRow.id, s.kind, s.scope ?? p.scope, s.matches ?? null, s.effective_from ?? (['match_suspension', 'date_suspension', 'competition_ban'].includes(s.kind) ? today() : null), s.effective_to ?? null,
        s.amount_minor ?? null, s.kind === 'fine' ? (team?.currency ?? 'INR') : null, s.points ?? null, s.label ?? null, status])).rows[0];
    if (s.kind === 'fine') {
      if (!team) throw badRequest('A fine needs the team the person plays for');
      const member = caseRow.subject_kind === 'team' ? team.owner_id : caseRow.subject_user_id;
      const batch = (await c.query(
        `INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, event_id, fixture_id, idempotency_key, created_by)
         VALUES ($1,'fine',$2,$3,$4,'fixed',$5,$6,$7,$8) RETURNING *`,
        [team.id, `Disciplinary fine ${caseRow.case_no}`.slice(0, 120), team.currency, s.amount_minor, caseRow.event_id, caseRow.fixture_id, `disc-fine:${row.id}`, user.id])).rows[0];
      const r = await raiseBatch(c, { team, batch, members: [{ user_id: member, amount_minor: s.amount_minor }], actor: user.id });
      if (!r.charges[0]) throw conflict('The fine could not be raised: no verified payer is on record for this person');
      await c.query('UPDATE disc_sanctions SET team_charge_id=$2 WHERE id=$1', [row.id, r.charges[0].id]);
      row.team_charge_id = r.charges[0].id;
    }
    if (s.kind === 'points_deduction' && !stay) {
      const tid = caseRow.team_id;
      if (!tid) throw badRequest('A points deduction needs the team');
      const div = await divisionRow(c, await divisionOfTeam(c, caseRow.season_id, tid));
      const a = await recordAdjustment(c, div, { team_id: tid, points_delta: -s.points, reason: `Disciplinary ${caseRow.case_no}`, user_id: user.id, disc_sanction_id: row.id });
      await c.query('UPDATE disc_sanctions SET comp_adjustment_id=$2 WHERE id=$1', [row.id, a.id]);
      row.comp_adjustment_id = a.id;
    }
    out.push(row);
  }
  await c.query("UPDATE disc_cases SET status='decided', reevaluation=CASE WHEN reevaluation='flagged' THEN 'reviewed' ELSE reevaluation END, interim_status='none', row_version=row_version+1, updated_at=now() WHERE id=$1", [caseRow.id]);
  await log(c, caseRow.id, d.kind === 'initial' ? 'decision_recorded' : `decision_${d.kind}`, { actor: user.id, from: caseRow.status, to: 'decided', reason, detail: { outcome, authority, sanctions: out.map((x) => x.kind), superseded: prev?.id ?? null, effects: notes } });
  await audit(c, user.id, 'discipline_decision', 'disc_cases', caseRow.id);
  return { decision: d, sanctions: out };
}

/** Put stayed sanctions into force (points deductions are applied now), e.g. after an appeal is upheld or dismissed. */
export async function activateStayed(c, caseRow, user) {
  for (const s of (await c.query("SELECT * FROM disc_sanctions WHERE case_id=$1 AND status='stayed'", [caseRow.id])).rows) {
    await c.query("UPDATE disc_sanctions SET status='active' WHERE id=$1", [s.id]);
    if (s.kind === 'points_deduction' && !s.comp_adjustment_id && caseRow.team_id) {
      const div = await divisionRow(c, await divisionOfTeam(c, caseRow.season_id, caseRow.team_id));
      const a = await recordAdjustment(c, div, { team_id: caseRow.team_id, points_delta: -s.points, reason: `Disciplinary ${caseRow.case_no}`, user_id: user.id, disc_sanction_id: s.id });
      await c.query('UPDATE disc_sanctions SET comp_adjustment_id=$2 WHERE id=$1', [s.id, a.id]);
    }
  }
}
export { addDays };

import { tx } from './db.js';
/** Worker sweep: apply every published policy to the cards of seasons that are open or running. Idempotent; a retry changes nothing. */
export async function runDisciplineSweeps() {
  const seasons = (await (await import('./db.js')).pool.query(
    `SELECT DISTINCT s.id FROM comp_seasons s JOIN disc_policies p ON p.competition_id=s.competition_id AND (p.season_id IS NULL OR p.season_id=s.id) WHERE s.status IN ('open','active')`)).rows;
  let n = 0;
  for (const s of seasons) n += (await tx((c) => deriveCases(c, s.id))).length;
  return n;
}
