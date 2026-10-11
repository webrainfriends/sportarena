import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { notify } from '../notify.js';
import { publish } from '../live.js';
import { advanceKnockout, isKnockout } from '../tournament/advance.js';
import { fixtureContext } from './match-tracking.js';
import { liveState, loggedEvents, rulesetForEvent } from '../scoring/state.js';
import { computeScore, matchPhase } from '../scoring/engine.js';
import { sheetAnomalies, hasErrors } from '../scoring/checks.js';

const TAG = 'Score sheets';
const q = (c) => c ?? pool;
const OPEN = ['draft', 'submitted', 'approved', 'rejected'];

const needScorer = (x) => { if (!x.canScore) throw forbidden('Only the organiser or the match officials can do that'); };
const needViewer = (x) => { if (!x.canScore && !x.side) throw forbidden('Only the organiser, the match officials and the team managers can see an unpublished sheet'); };
const needOrganiser = (x) => { if (!x.organiser) throw forbidden('Only the organiser can do that'); };
const log = (c, sheetId, actor, action, from, to, note, snap) =>
  c.query('INSERT INTO score_sheet_log(sheet_id, actor_id, action, from_status, to_status, note, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sheetId, actor, action, from, to, note ?? null, snap ? JSON.stringify(snap) : null]);
const snap = (s) => ({ home_score: s.home_score, away_score: s.away_score, winner_team_id: s.winner_team_id, version: s.version, round: s.round });

async function loadSheet(sheetId, c, lock = false) {
  const s = (await q(c).query(`SELECT * FROM score_sheets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [sheetId])).rows[0];
  if (!s) throw notFound('Score sheet');
  return s;
}
const totalsOf = (rs, score) => ({ ruleset: rs.label, kind: rs.kind, sets: score.sets, periods: score.periods, current_set: score.current_set, stats: score.stats });
const winnerTeam = (f, home, away) => (home === away ? null : home > away ? f.home_team_id : f.away_team_id);
const notifyParties = async (c, f, ev, user, msg) => {
  const owners = (await c.query('SELECT DISTINCT owner_id FROM teams WHERE id = ANY($1::uuid[])', [[f.home_team_id, f.away_team_id].filter(Boolean)])).rows.map((r) => r.owner_id);
  for (const uid of new Set([ev.organizer_id, ...owners])) if (uid && uid !== user.id) await notify(c, uid, { kind: 'score_sheet', ...msg, data: { event_id: ev.id, fixture_id: f.id } });
};

/** A sheet with who signed it this round, its history and the two sides. */
export async function sheetView(sheetId, c) {
  const s = await loadSheet(sheetId, c);
  const [signoffs, history, f] = await Promise.all([
    q(c).query(`SELECT o.role, o.decision, o.comment, o.at, o.user_id, u.display_name FROM score_sheet_signoffs o JOIN users u ON u.id=o.user_id WHERE o.sheet_id=$1 AND o.round=$2 ORDER BY o.at`, [s.id, s.round]).then((r) => r.rows),
    q(c).query('SELECT l.action, l.from_status, l.to_status, l.note, l.at, u.display_name AS actor_name FROM score_sheet_log l JOIN users u ON u.id=l.actor_id WHERE l.sheet_id=$1 ORDER BY l.at', [s.id]).then((r) => r.rows),
    q(c).query(`SELECT f.id, f.round, f.round_kind, f.status, f.scheduled_at, h.id AS home_id, h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.id AS away_id, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color
                  FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [s.fixture_id]).then((r) => r.rows[0]),
  ]);
  const need = ['referee', 'home_manager', 'away_manager'];
  return { ...s, fixture: f, signoffs, history, pending_signoffs: need.filter((r) => !signoffs.some((x) => x.role === r && x.decision === 'signed')), disputes: signoffs.filter((x) => x.decision === 'disputed') };
}

// ------------------------------------------------------------------ creating
cap({
  name: 'end_match', method: 'POST', path: '/fixtures/:id/end', tag: TAG,
  summary: 'Full time (organiser or match official). Closes any open period, marks the game finished and opens a draft score sheet pre-filled from the match log. The result is not official until the sheet is approved and published.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const sheet = await tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (!['live', 'paused'].includes(x.f.status)) throw conflict(`Only a live or paused game can be ended; this one is ${x.f.status}`);
      if ((await c.query('SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status = ANY($2)', [i.id, OPEN])).rowCount) throw conflict('This game already has a score sheet in progress');
      const { ruleset } = await rulesetForEvent(x.f.event_id, c);
      let events = await loggedEvents(i.id, c);
      if (ruleset.kind !== 'manual' && matchPhase(ruleset, events).period_open) {
        const seq = (await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM match_events WHERE fixture_id=$1', [i.id])).rows[0].n;
        await c.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, period, recorded_by, payload) VALUES ($1,$2,$3,'period_end',$4,$5,'{\"auto\":true}')", [i.id, x.f.event_id, seq, matchPhase(ruleset, events).period, user.id]);
        events = await loggedEvents(i.id, c);
      }
      await c.query("UPDATE fixtures SET status='finished', finished_at=now(), paused_by_event=false WHERE id=$1", [i.id]);
      const score = computeScore(ruleset, events);
      const manual = ruleset.kind === 'manual';
      const created = (await c.query(
        `INSERT INTO score_sheets(fixture_id, event_id, source, home_score, away_score, winner_team_id, totals, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [i.id, x.f.event_id, manual ? 'manual' : 'match_log', manual ? null : score.home, manual ? null : score.away, manual ? null : winnerTeam(x.f, score.home, score.away), JSON.stringify(totalsOf(ruleset, score)), user.id])).rows[0];
      await log(c, created.id, user.id, 'created', null, 'draft', manual ? 'Opened for manual totals' : 'Pre-filled from the match log', snap(created));
      return created;
    });
    publish(`fixture:${i.id}`, await liveState(i.id));
    return sheet;
  },
});

cap({
  name: 'start_score_sheet', method: 'POST', path: '/fixtures/:id/score-sheet', tag: TAG, status: 201,
  summary: 'Open a score sheet for a game that was not tracked live (scheduled or already at full time), then fill in the totals.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (!['scheduled', 'finished', 'completed'].includes(x.f.status)) throw conflict(x.f.status === 'live' || x.f.status === 'paused' ? 'The game is still on: end it to open the sheet' : `A ${x.f.status} game has no score sheet`);
      if (!x.f.home_team_id || !x.f.away_team_id) throw conflict('The teams for this game are not decided yet');
      if ((await c.query('SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status = ANY($2)', [i.id, OPEN])).rowCount) throw conflict('This game already has a score sheet in progress');
      if ((await c.query("SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status='published'", [i.id])).rowCount) throw conflict('This game has a published result; revise it instead');
      const { ruleset } = await rulesetForEvent(x.f.event_id, c);
      const version = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM score_sheets WHERE fixture_id=$1', [i.id])).rows[0].v;
      const prefill = x.f.status === 'completed';
      const s = (await c.query(
        `INSERT INTO score_sheets(fixture_id, event_id, version, source, home_score, away_score, winner_team_id, totals, created_by) VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8) RETURNING *`,
        [i.id, x.f.event_id, version, prefill ? x.f.home_score : null, prefill ? x.f.away_score : null, prefill ? x.f.winner_team_id : null, JSON.stringify({ ruleset: ruleset.label, kind: ruleset.kind }), user.id])).rows[0];
      await log(c, s.id, user.id, 'created', null, 'draft', prefill ? 'Opened from the result recorded earlier' : 'Opened for manual totals', snap(s));
      return s;
    });
  },
});

cap({
  name: 'update_score_sheet', method: 'PATCH', path: '/score-sheets/:id', tag: TAG,
  summary: 'Fix the totals on a draft or rejected sheet (organiser or match official). If the score differs from what the match log computed, say why in adjusted_reason. A rejected sheet goes back to draft.',
  input: z.object({ id, home_score: z.number().int().min(0).max(1000).optional(), away_score: z.number().int().min(0).max(1000).optional(), winner_team_id: id.nullable().optional(), notes: z.string().max(2000).optional(), adjusted_reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c);
      needScorer(x);
      if (!['draft', 'rejected'].includes(s.status)) throw conflict(`A ${s.status} sheet cannot be edited${s.status === 'published' ? '; revise it instead' : ''}`);
      const home = i.home_score ?? s.home_score, away = i.away_score ?? s.away_score;
      if (i.winner_team_id && ![x.f.home_team_id, x.f.away_team_id].includes(i.winner_team_id)) throw badRequest('winner_team_id must be the home or away team');
      let winner = i.winner_team_id === undefined ? s.winner_team_id : i.winner_team_id;
      if (home != null && away != null && home !== away && i.winner_team_id === undefined) winner = winnerTeam(x.f, home, away);
      let reason = i.adjusted_reason ?? s.adjusted_reason;
      if (s.source === 'match_log' && home != null && away != null) {
        const { ruleset } = await rulesetForEvent(s.event_id, c);
        const comp = computeScore(ruleset, await loggedEvents(s.fixture_id, c));
        if ((comp.home !== home || comp.away !== away) && !reason) throw badRequest(`The match log adds up to ${comp.home}–${comp.away}; say why the sheet differs (adjusted_reason)`);
        if (comp.home === home && comp.away === away) reason = null;
      }
      const out = (await c.query(
        `UPDATE score_sheets SET home_score=$2, away_score=$3, winner_team_id=$4, notes=coalesce($5,notes), adjusted_reason=$6, status='draft', rejected_reason=CASE WHEN status='rejected' THEN rejected_reason END WHERE id=$1 RETURNING *`,
        [i.id, home, away, winner, i.notes ?? null, reason])).rows[0];
      await log(c, s.id, user.id, 'edited', s.status, 'draft', reason, snap(out));
      return out;
    });
  },
});

// ------------------------------------------------------------------ workflow
cap({
  name: 'submit_score_sheet', method: 'POST', path: '/score-sheets/:id/submit', tag: TAG,
  summary: 'Submit the sheet for sign-off (organiser or match official). Runs the sanity checks: errors (impossible sets, a level knockout with no winner …) stop it; warnings go to the approver. The referee\'s submission counts as their signature; team managers are told to sign.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c);
      needScorer(x);
      if (!['draft', 'rejected'].includes(s.status)) throw conflict(`A ${s.status} sheet cannot be submitted`);
      const { ruleset } = await rulesetForEvent(s.event_id, c);
      const found = sheetAnomalies(ruleset, await loggedEvents(s.fixture_id, c), s, x.f);
      if (hasErrors(found)) throw conflict('The sheet has problems to fix before it can be submitted', { anomalies: found });
      const round = s.submitted_at ? s.round + 1 : s.round; // a sheet that was submitted before starts a fresh round of sign-offs
      const out = (await c.query("UPDATE score_sheets SET status='submitted', round=$2, anomalies=$3, submitted_by=$4, submitted_at=now() WHERE id=$1 RETURNING *", [i.id, round, JSON.stringify(found), user.id])).rows[0];
      await c.query("INSERT INTO score_sheet_signoffs(sheet_id, round, role, user_id, decision) VALUES ($1,$2,'referee',$3,'signed')", [i.id, round, user.id]); // the submitting official (or organiser acting as scorer) signs for the officials
      if (x.f.status === 'scheduled') await c.query("UPDATE fixtures SET status='finished', finished_at=now() WHERE id=$1", [x.f.id]);
      await log(c, s.id, user.id, 'submitted', s.status, 'submitted', found.length ? `${found.length} note(s) for the approver` : null, snap(out));
      await notifyParties(c, x.f, x.ev, user, { title: 'Score sheet ready to sign', body: `${x.ev.name}: ${out.home_score}–${out.away_score}. Check and sign, or dispute it.` });
      return out;
    });
  },
});

cap({
  name: 'sign_score_sheet', method: 'POST', path: '/score-sheets/:id/sign', tag: TAG,
  summary: 'A team manager signs the submitted sheet for their side, or disputes it with a comment. A manager of both sides signs for both.',
  input: z.object({ id, decision: z.enum(['signed', 'disputed']), comment: z.string().min(2).max(500).optional() }),
  async handler({ user }, i) {
    if (i.decision === 'disputed' && !i.comment) throw badRequest('Say what is wrong when you dispute a sheet');
    return tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c);
      if (!x.side) throw forbidden('Only a manager of one of the two teams can sign');
      if (s.status !== 'submitted') throw conflict(`Only a submitted sheet can be signed; this one is ${s.status}`);
      const roles = x.side === 'both' ? ['home_manager', 'away_manager'] : [`${x.side}_manager`];
      for (const role of roles) {
        const had = (await c.query('SELECT 1 FROM score_sheet_signoffs WHERE sheet_id=$1 AND round=$2 AND role=$3', [s.id, s.round, role])).rowCount;
        if (had) throw conflict('That side has already answered this round');
        await c.query('INSERT INTO score_sheet_signoffs(sheet_id, round, role, user_id, decision, comment) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, s.round, role, user.id, i.decision, i.comment ?? null]);
      }
      await log(c, s.id, user.id, i.decision === 'signed' ? 'signed' : 'disputed', 'submitted', 'submitted', i.comment, { roles });
      if (i.decision === 'disputed') await notify(c, x.ev.organizer_id, { kind: 'score_sheet', title: 'Score sheet disputed', body: `${x.ev.name}: ${i.comment}`, data: { event_id: x.ev.id, fixture_id: x.f.id } });
      return sheetView(s.id, c);
    });
  },
});

cap({
  name: 'approve_score_sheet', method: 'POST', path: '/score-sheets/:id/approve', tag: TAG,
  summary: 'Organiser approves a submitted sheet. It needs the referee and both team managers to have signed with no dispute; otherwise pass waived_reason to approve anyway (recorded on the sheet).',
  input: z.object({ id, waived_reason: z.string().min(3).max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c);
      needOrganiser(x);
      if (s.status !== 'submitted') throw conflict(`Only a submitted sheet can be approved; this one is ${s.status}`);
      const v = await sheetView(s.id, c);
      if ((v.pending_signoffs.length || v.disputes.length) && !i.waived_reason) throw conflict('Not every side has signed off', { pending: v.pending_signoffs, disputes: v.disputes.map((d) => ({ role: d.role, comment: d.comment })) });
      const out = (await c.query("UPDATE score_sheets SET status='approved', approved_by=$2, approved_at=now(), waived_reason=$3 WHERE id=$1 RETURNING *", [i.id, user.id, v.pending_signoffs.length || v.disputes.length ? i.waived_reason : null])).rows[0];
      await log(c, s.id, user.id, 'approved', 'submitted', 'approved', out.waived_reason, snap(out));
      return out;
    });
  },
});

cap({
  name: 'reject_score_sheet', method: 'POST', path: '/score-sheets/:id/reject', tag: TAG,
  summary: 'Organiser sends a submitted or approved sheet back to the referee with a reason. Sign-offs start again on the next submission.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c);
      needOrganiser(x);
      if (!['submitted', 'approved'].includes(s.status)) throw conflict(`Only a submitted or approved sheet can be rejected; this one is ${s.status}`);
      const out = (await c.query("UPDATE score_sheets SET status='rejected', rejected_by=$2, rejected_at=now(), rejected_reason=$3, approved_by=NULL, approved_at=NULL, waived_reason=NULL WHERE id=$1 RETURNING *", [i.id, user.id, i.reason])).rows[0];
      await log(c, s.id, user.id, 'rejected', s.status, 'rejected', i.reason, snap(out));
      if (s.submitted_by) await notify(c, s.submitted_by, { kind: 'score_sheet', title: 'Score sheet sent back', body: `${x.ev.name}: ${i.reason}`, data: { event_id: x.ev.id, fixture_id: x.f.id } });
      return out;
    });
  },
});

cap({
  name: 'publish_score_sheet', method: 'POST', path: '/score-sheets/:id/publish', tag: TAG,
  summary: 'Organiser publishes an approved sheet. This is the only step that writes the official result: the game becomes completed, standings update, and a knockout winner moves into the next round. A previously published version is kept as superseded.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const s = await loadSheet(i.id, c, true);
      const x = await fixtureContext(user, s.fixture_id, c, { lock: true });
      needOrganiser(x);
      if (s.status !== 'approved') throw conflict(`Only an approved sheet can be published; this one is ${s.status}`);
      if (s.home_score == null || s.away_score == null) throw conflict('The sheet has no score');
      let winner = winnerTeam(x.f, s.home_score, s.away_score) ?? s.winner_team_id;
      if (isKnockout(x.f) && !winner) throw conflict('A knockout game needs a winner');
      await c.query("UPDATE score_sheets SET status='superseded' WHERE fixture_id=$1 AND status='published'", [s.fixture_id]);
      const done = (await c.query("UPDATE score_sheets SET status='published', published_by=$2, published_at=now() WHERE id=$1 RETURNING *", [i.id, user.id])).rows[0];
      const fx = (await c.query("UPDATE fixtures SET home_score=$2, away_score=$3, winner_team_id=$4, status='completed', finished_at=coalesce(finished_at, now()), paused_by_event=false WHERE id=$1 RETURNING *", [s.fixture_id, s.home_score, s.away_score, winner ?? null])).rows[0];
      if (isKnockout(fx) && winner) await advanceKnockout(c, fx, winner);
      await log(c, s.id, user.id, 'published', 'approved', 'published', s.version > 1 ? `Version ${s.version}: ${s.revision_reason ?? 'correction'}` : null, snap(done));
      await notifyParties(c, x.f, x.ev, user, { title: 'Result published', body: `${x.ev.name}: ${s.home_score}–${s.away_score}` });
      return done;
    });
    publish(`fixture:${out.fixture_id}`, await liveState(out.fixture_id));
    return out;
  },
});

cap({
  name: 'revise_score_sheet', method: 'POST', path: '/fixtures/:id/score-sheet/revise', tag: TAG, status: 201,
  summary: 'Open a correction of a published result as a new version with a reason (organiser). The published result stays in force until the new version is approved and published; the old one is kept as superseded.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needOrganiser(x);
      const pub = (await c.query("SELECT * FROM score_sheets WHERE fixture_id=$1 AND status='published'", [i.id])).rows[0];
      if (!pub) throw conflict('There is no published result to revise');
      if ((await c.query('SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status = ANY($2)', [i.id, OPEN])).rowCount) throw conflict('A correction is already in progress');
      const version = (await c.query('SELECT max(version)+1 AS v FROM score_sheets WHERE fixture_id=$1', [i.id])).rows[0].v;
      const s = (await c.query(
        `INSERT INTO score_sheets(fixture_id, event_id, version, source, home_score, away_score, winner_team_id, totals, notes, revises_id, revision_reason, created_by)
         VALUES ($1,$2,$3,'revision',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [i.id, pub.event_id, version, pub.home_score, pub.away_score, pub.winner_team_id, JSON.stringify(pub.totals), pub.notes, pub.id, i.reason, user.id])).rows[0];
      await log(c, s.id, user.id, 'created', null, 'draft', `Revision of v${pub.version}: ${i.reason}`, snap(s));
      return s;
    });
  },
});

// ------------------------------------------------------------------ reading
cap({
  name: 'get_score_sheet', method: 'GET', path: '/fixtures/:id/score-sheet', tag: TAG,
  summary: 'The score sheet being worked on for a game (or the latest one), with sign-offs, who still has to sign, checks and history. Organiser, match officials and the two team managers.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    needViewer(x);
    const s = (await pool.query(`SELECT id FROM score_sheets WHERE fixture_id=$1 ORDER BY (status = ANY($2)) DESC, version DESC LIMIT 1`, [i.id, OPEN])).rows[0];
    if (!s) throw notFound('Score sheet');
    return sheetView(s.id);
  },
});

cap({
  name: 'list_score_sheets', method: 'GET', path: '/events/:id/score-sheets', tag: TAG,
  summary: 'All score sheets of an event waiting for action, newest first (organiser). Filter by status.',
  input: z.object({ id, status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'published', 'superseded']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(
      `SELECT s.id, s.fixture_id, s.version, s.status, s.home_score, s.away_score, s.source, s.submitted_at, s.published_at, jsonb_array_length(s.anomalies) AS notes,
              h.name AS home_name, a.name AS away_name, f.scheduled_at
         FROM score_sheets s JOIN fixtures f ON f.id=s.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE s.event_id=$1 AND ($2::text IS NULL OR s.status=$2) ORDER BY coalesce(s.submitted_at, s.created_at) DESC`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'list_published_results', method: 'GET', path: '/events/:id/results', tag: TAG, auth: 'public',
  summary: 'The official, published results of an event: every game\'s approved score sheet (latest version), with sets/periods and who signed. This is the public score sheet.',
  input: z.object({ id }),
  async handler(_, i) {
    const ev = await mustFind('events', i.id, 'id, status');
    if (ev.status === 'draft') throw notFound('Event');
    return many(
      `SELECT s.id AS sheet_id, s.fixture_id, s.version, s.home_score, s.away_score, s.winner_team_id, s.totals, s.published_at, s.revision_reason, f.round, f.round_kind, f.scheduled_at,
              h.id AS home_id, h.name AS home_name, h.emoji AS home_emoji, a.id AS away_id, a.name AS away_name, a.emoji AS away_emoji,
              (SELECT jsonb_agg(jsonb_build_object('role', o.role, 'decision', o.decision) ORDER BY o.at) FROM score_sheet_signoffs o WHERE o.sheet_id=s.id AND o.round=s.round) AS signoffs
         FROM score_sheets s JOIN fixtures f ON f.id=s.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE s.event_id=$1 AND s.status='published' ORDER BY f.scheduled_at, s.published_at`, [i.id]);
  },
});

cap({
  name: 'get_published_score_sheet', method: 'GET', path: '/fixtures/:id/result', tag: TAG, auth: 'public',
  summary: 'The published score sheet of one game: final score, sets and periods, tracked parameters, version history and the sign-offs.', input: z.object({ id }),
  async handler(_, i) {
    const s = (await pool.query(
      `SELECT s.id FROM score_sheets s JOIN events e ON e.id=s.event_id WHERE s.fixture_id=$1 AND s.status='published' AND e.status <> 'draft'`, [i.id])).rows[0];
    if (!s) throw notFound('Published result');
    const v = await sheetView(s.id);
    const versions = await many("SELECT version, status, published_at, revision_reason, home_score, away_score FROM score_sheets WHERE fixture_id=$1 AND status IN ('published','superseded') ORDER BY version", [i.id]);
    const { anomalies, history, waived_reason, adjusted_reason, rejected_reason, created_by, submitted_by, approved_by, rejected_by, published_by, pending_signoffs, disputes, ...pub } = v;
    return { ...pub, signoffs: v.signoffs.map(({ user_id, comment, ...o }) => o), versions };
  },
});
