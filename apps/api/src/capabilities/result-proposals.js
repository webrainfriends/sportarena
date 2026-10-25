// Tools > Scoring & Game Tracking (#416): turning a tracking sheet into a PROPOSED result for a real game, the governed review of it,
// and the hand-over to the existing score-sheet lifecycle. A proposal never changes fixtures, match_events or standings. Approval only
// makes it eligible to be applied; applying opens a draft score sheet, which then needs the usual sign-offs, approval and publication.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../errors.js';
import { notify } from '../notify.js';
import { mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { fixtureContext } from './match-tracking.js';
import { loggedEvents, rulesetForEvent } from '../scoring/state.js';
import { computeScore } from '../scoring/engine.js';
import { boardFor, hashOf, evaluateProposal, hasErrors, nextRequirement, parseMark, policyFor, policySchema, sheetResult, validateTotals } from '../tracking/logic.js';
import { linkContext, ownSheet, proposable, sheetView } from './tracking-sheets.js';
import { eventAccess } from './multisport.js';
import { isAssignedOfficial, recordSessionResults, sessionDetail } from './multisport-play.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Result proposals';
const q = (c) => c ?? pool;
const OPEN = ['proposed', 'under_review', 'changes_requested', 'approved', 'disputed'];
const REVIEWABLE = ['proposed', 'under_review'];

const rolesOf = (x) => [x.organiser && 'organiser', x.official && 'official', (x.side === 'home' || x.side === 'both') && 'home_manager', (x.side === 'away' || x.side === 'both') && 'away_manager'].filter(Boolean);

// ------------------------------------------------------------------ sessions (heats, finals and races of a multi-sport programme)
/** What the caller is on this session: organiser, an assigned official, nothing else (there are no team managers in a heat). */
async function sessionContext(user, sessionId, c) {
  const s = (await q(c).query('SELECT s.*, d.sport_id, d.mode, d.result_type, d.name AS discipline FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.id=$1', [sessionId])).rows[0];
  if (!s) throw notFound('Session');
  const { ev, scope } = await eventAccess(q(c), user, s.event_id);
  const official = isAdmin(user) || (await isAssignedOfficial(q(c), user.id, s.id));
  return { kind: 'session', s, ev, organiser: !!scope.organizer, official, side: null, canScore: !!scope.organizer || official };
}
const contextOf = (user, p, c) => (p.session_id ? sessionContext(user, p.session_id, c) : fixtureContext(user, p.fixture_id, c));
/** The event's policy limited to the roles a session has (organiser, assigned official); a policy that asks for nothing a session has falls back on official-then-organiser. */
function sessionPolicy(ev) {
  const p = policyFor(ev);
  const requirements = p.requirements.map((r) => ({ ...r, roles: r.roles.filter((z) => z === 'organiser' || z === 'official') })).filter((r) => r.roles.length);
  if (!requirements.length) return policySchema.parse({ mode: 'sequential', requirements: [{ key: 'official', label: 'Chief official', roles: ['official'] }, { key: 'organiser', label: 'Organiser', roles: ['organiser'] }] });
  return policySchema.parse({ ...p, requirements, quorum: p.quorum && p.quorum <= requirements.length ? p.quorum : null });
}
async function snapshotOfSession(sessionId, c) {
  const s = (await q(c).query('SELECT status FROM event_sessions WHERE id=$1', [sessionId])).rows[0];
  const e = (await q(c).query("SELECT id, result_status, result_value::text AS v, position FROM event_session_entries WHERE session_id=$1 AND result_status <> 'scratched' ORDER BY id", [sessionId])).rows;
  return { session_status: s.status, entries: e.map((r) => [r.id, r.result_status, r.v, r.position]) };
}
async function sessionReviewers(c, x) {
  const ids = new Set([x.ev.organizer_id]);
  for (const r of (await c.query("SELECT st.user_id FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id WHERE sh.session_id=$1 AND sh.status='assigned' AND st.status='accepted'", [x.s.id])).rows) ids.add(r.user_id);
  ids.delete(null); ids.delete(undefined);
  return ids;
}

/** What the canonical record looks like right now. A proposal whose snapshot no longer matches is stale and must be re-reviewed. */
async function snapshotOf(fixtureId, c) {
  const f = (await q(c).query('SELECT status, home_score, away_score FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  const pub = (await q(c).query("SELECT id, version, home_score, away_score FROM score_sheets WHERE fixture_id=$1 AND status='published'", [fixtureId])).rows[0] ?? null;
  const open = (await q(c).query("SELECT id, status FROM score_sheets WHERE fixture_id=$1 AND status IN ('draft','submitted','approved','rejected')", [fixtureId])).rows[0] ?? null;
  const log = (await q(c).query('SELECT count(*)::int AS n, coalesce(max(seq),0)::int AS last FROM match_events WHERE fixture_id=$1 AND voided_at IS NULL', [fixtureId])).rows[0];
  return { fixture_status: f.status, fixture_score: f.home_score == null ? null : [f.home_score, f.away_score], published: pub && { id: pub.id, version: pub.version, score: [pub.home_score, pub.away_score] }, open_sheet: open && { id: open.id, status: open.status }, log_events: log.n, log_last_seq: log.last };
}

const swapSide = (s) => (s === 'home' ? 'away' : s === 'away' ? 'home' : s);
/** The proposed canonical result, computed on the server from the sheet (never from client-sent totals), mapped to the game's home/away. */
function payloadFrom(result, labels, homeIs, sheetRef, ruleset) {
  const swap = homeIs === 'away';
  const pick = (h, a) => (swap ? [a, h] : [h, a]);
  const [hs, as] = pick(result.home, result.away);
  const sets = result.sets?.map((s) => { const [h, a] = pick(s.home, s.away); return { ...s, home: h, away: a, winner: s.winner ? (swap ? swapSide(s.winner) : s.winner) : undefined }; }) ?? null;
  const periods = result.periods?.map((p) => { const [h, a] = pick(p.home, p.away); return { ...p, home: h, away: a }; }) ?? null;
  const stats = swap ? { home: result.stats?.away ?? {}, away: result.stats?.home ?? {} } : (result.stats ?? { home: {}, away: {} });
  return { home_score: hs, away_score: as, winner: hs === as ? null : hs > as ? 'home' : 'away', sets, periods, stats, ruleset: ruleset.label, kind: ruleset.kind, source: result.source, sheet_ref: sheetRef, sheet_labels: labels };
}

/** Sheets tracked under different rules than the game uses cannot be proposed: the result would not mean the same thing. */
function compatible(sheetRs, eventRs) {
  if (sheetRs.kind !== eventRs.kind) return `This sheet was tracked as ${sheetRs.label} but the game is scored as ${eventRs.label}`;
  if (eventRs.kind === 'sets' && (sheetRs.sets.best_of !== eventRs.sets.best_of || sheetRs.sets.points_to_win !== eventRs.sets.points_to_win)) return `The game is best of ${eventRs.sets.best_of} to ${eventRs.sets.points_to_win}; this sheet was tracked as best of ${sheetRs.sets.best_of} to ${sheetRs.sets.points_to_win}`;
  return null;
}

async function reviewers(c, x) {
  if (x.kind === 'session') return sessionReviewers(c, x);
  const ids = new Set([x.ev.organizer_id, x.f.referee_id]);
  for (const r of (await c.query("SELECT user_id FROM fixture_officials WHERE fixture_id=$1 AND status='accepted'", [x.f.id])).rows) ids.add(r.user_id);
  for (const r of (await c.query('SELECT owner_id FROM teams WHERE id = ANY($1::uuid[])', [[x.f.home_team_id, x.f.away_team_id].filter(Boolean)])).rows) ids.add(r.owner_id);
  ids.delete(null); ids.delete(undefined);
  return ids;
}
const tell = (c, uid, p, title, body) => notify(c, uid, { kind: 'result_proposal', title, body, data: { proposal_id: p.id, fixture_id: p.fixture_id ?? undefined, session_id: p.session_id ?? undefined, event_id: p.event_id }, dedupe_key: `rp:${p.id}:${p.round}:${title}:${uid}` });

// ------------------------------------------------------------------ policy
cap({
  name: 'get_result_approval_policy', method: 'GET', path: '/events/:id/result-approval-policy', tag: TAG,
  summary: 'Who must review a proposed result for this event: its own policy, or the default for its kind (friendly: referee or organiser; league: referee and both managers; tournament: scorer/referee then organiser).',
  input: z.object({ id }),
  async handler(_ctx, i) {
    const ev = await mustFind('events', i.id);
    if (ev.status === 'draft') throw notFound('Event');
    return { policy: policyFor(ev), source: ev.result_approval_policy ? 'event' : 'default', roles: ['organiser', 'official', 'home_manager', 'away_manager'] };
  },
});

cap({
  name: 'set_result_approval_policy', method: 'POST', path: '/events/:id/result-approval-policy', tag: TAG,
  summary: 'Set the review policy for proposed results (organiser): required roles, sequential or parallel, quorum, organiser override with a reason, no self-approval. Proposals already under review keep the policy they were submitted under.',
  input: z.object({ id, policy: policySchema }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    await pool.query('UPDATE events SET result_approval_policy=$2 WHERE id=$1', [i.id, JSON.stringify(i.policy)]);
    return { policy: i.policy, source: 'event' };
  },
});

// ------------------------------------------------------------------ submit
cap({
  name: 'submit_result_proposal', method: 'POST', path: '/tracking/sheets/:id/proposals', tag: TAG, status: 201,
  summary: 'Propose a completed sheet as the result of a real game. Any signed-in user may submit where the event\'s policy allows; submitting grants no approval authority and changes nothing official. Repeating the call returns the same proposal; after changes were requested it opens a new review round.',
  input: z.object({ id, fixture_id: id, home_is: z.enum(['home', 'away']).default('home').describe('which side of the game the sheet\'s "home" column is') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await linkContext(user, i.fixture_id, c, { lock: true });
      const s = await ownSheet(user, i.id, c, { lock: true });
      const why = proposable(x); if (why) throw conflict(why);
      if (s.status !== 'completed') throw conflict('Complete the sheet before proposing it');
      if (s.sport_id !== x.ev.sport_id) throw badRequest('This sheet is for a different sport than the game');
      if (s.mode === 'linked' && s.fixture_id !== x.f.id) throw conflict('This sheet is already linked to a different game');
      const policy = policyFor(x.ev);
      if (!policy.allow_public_submission && !x.canScore && !x.side) throw forbidden('This event only accepts results from its organiser, officials and team managers');
      const v = (await c.query('SELECT * FROM tracking_sheet_template_versions WHERE id=$1', [s.template_version_id])).rows[0];
      const eventRs = (await rulesetForEvent(x.f.event_id, c, x.f.id)).ruleset;
      const incompatible = compatible(v.ruleset, eventRs); if (incompatible) throw conflict(incompatible);
      const entries = (await c.query('SELECT seq, kind, side, period, voided_at FROM tracking_sheet_entries WHERE sheet_id=$1 ORDER BY seq', [s.id])).rows;
      const result = sheetResult(eventRs, entries, s.manual_totals);
      const checks = validateTotals(eventRs, result);
      if (hasErrors(checks)) throw new AppError(422, 'unprocessable', `The sheet cannot be proposed: ${checks.filter((k) => k.severity === 'error').map((k) => k.message).join('; ')}`, checks);
      const payload = payloadFrom(result, s.labels, i.home_is, s.ref, eventRs);
      const base = await snapshotOf(x.f.id, c);
      const imp = (await c.query("SELECT id FROM tracking_sheet_imports WHERE sheet_id=$1 AND state='confirmed' ORDER BY created_at DESC LIMIT 1", [s.id])).rows[0];
      const existing = (await c.query('SELECT * FROM result_proposals WHERE fixture_id=$1 AND sheet_id=$2 AND state = ANY($3) FOR UPDATE', [x.f.id, s.id, OPEN])).rows[0];
      let p, duplicate = false;
      if (existing) {
        const stale = hashOf(await snapshotOf(x.f.id, c)) !== hashOf(existing.base_snapshot);
        if (existing.submitted_by !== user.id && !isAdminLike(x)) throw conflict('Someone else already proposed this sheet for this game');
        if (!stale && [...REVIEWABLE, 'approved'].includes(existing.state)) { duplicate = true; p = existing; }
        else {
          p = (await c.query(
            `UPDATE result_proposals SET state='proposed', round=round+1, payload=$2, policy=$3, home_is=$4, ruleset_hash=$5, template_version_id=$6, base_snapshot=$7, import_id=$8, updated_at=now() WHERE id=$1 RETURNING *`,
            [existing.id, JSON.stringify(payload), JSON.stringify(policy), i.home_is, hashOf(eventRs), v.id, JSON.stringify(base), imp?.id ?? existing.import_id])).rows[0];
        }
      } else {
        p = (await c.query(
          `INSERT INTO result_proposals(fixture_id, event_id, sheet_id, import_id, submitted_by, home_is, payload, policy, ruleset_hash, template_version_id, base_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [x.f.id, x.f.event_id, s.id, imp?.id ?? null, user.id, i.home_is, JSON.stringify(payload), JSON.stringify(policy), hashOf(eventRs), v.id, JSON.stringify(base)])).rows[0];
        if (s.mode !== 'linked') await c.query("UPDATE tracking_sheets SET mode='linked', fixture_id=$2, updated_at=now() WHERE id=$1", [s.id, x.f.id]); // provenance (live/upload) stays as it was
      }
      if (!duplicate) for (const uid of await reviewers(c, x)) if (uid !== user.id) await tell(c, uid, p, 'Result proposed', 'A result was proposed for a game you help run. Review it in Tools.');
      return { ...p, duplicate, warnings: checks };
    });
  },
});
const isAdminLike = (x) => x.organiser;

const UNIT_FOR = { time: 'time', distance: 'distance', score: 'score' };
/** The rows of a results sheet as the session's results: a mark per finished entry, DNS/DNF/DQ as such. Marks are parsed here, never taken from the client. */
function resultsFromRows(sheet, layout, mapping, session, entries) {
  const unit = layout.results.unit, want = session.result_type;
  const ok = (unit === 'time' && want === 'time') || (unit === 'distance' && want === 'distance') || ((unit === 'score' || unit === 'lift') && want === 'score');
  if (!ok) throw conflict(`This sheet records ${unit === 'lift' ? 'lifting totals' : unit === 'time' ? 'times' : unit === 'distance' ? 'distances' : 'scores'}, but the session ranks by ${want}`);
  const rows = layout.results.unit === 'lift' ? boardFor(layout, { rows: sheet.rows }).rows : sheet.rows;
  const ids = new Set(entries.map((e) => e.id));
  const seenRow = new Set(), seenEntry = new Set();
  const results = mapping.map((m) => {
    const r = rows[m.row];
    if (!r) throw badRequest(`Row ${m.row + 1} is not on the sheet`);
    if (!ids.has(m.entry_id)) throw badRequest('An entry does not belong to this session');
    if (seenRow.has(m.row) || seenEntry.has(m.entry_id)) throw badRequest('Each row and each entry can be matched only once');
    seenRow.add(m.row); seenEntry.add(m.entry_id);
    const status = r.status ? r.status.toLowerCase() : 'finished';
    if (status !== 'finished') return { entry_id: m.entry_id, status, row: m.row };
    const value = unit === 'lift' ? r.total : parseMark(r.result);
    if (value == null) throw new AppError(422, 'unprocessable', `Row ${m.row + 1}${r.name ? ` (${r.name})` : ''} has no readable ${unit === 'time' ? 'time' : 'mark'}. Fix it on the sheet, or mark DNS / DNF / DQ.`);
    return { entry_id: m.entry_id, status: 'finished', value, row: m.row };
  });
  const missing = entries.filter((e) => !seenEntry.has(e.id));
  if (missing.length) throw new AppError(422, 'unprocessable', `${missing.length} ${missing.length === 1 ? 'entry in' : 'entries in'} the session ${missing.length === 1 ? 'is' : 'are'} not matched to a row. Match everyone, using DNS for anyone who did not start.`);
  return { results, summary: results.map((r) => ({ row: r.row, entry_id: r.entry_id, name: rows[r.row].name ?? null, lane: rows[r.row].lane ?? null, status: r.status, mark: rows[r.row].result ?? null, value: r.value ?? null })) };
}

cap({
  name: 'submit_session_result_proposal', method: 'POST', path: '/tracking/sheets/:id/session-proposals', tag: TAG, status: 201,
  summary: 'Propose a completed heat, field or race sheet as the result of a real session of a multi-sport programme. Each row is matched to a session entry; the marks are read from the sheet on the server. Reviewed under the event\'s policy by the organiser and the session\'s assigned officials; approval alone changes nothing: applying records the results through the normal session results path.',
  input: z.object({ id, session_id: id, mapping: z.array(z.object({ row: z.number().int().min(0).max(59), entry_id: id })).min(1).max(64) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = await sessionContext(user, i.session_id, c);
      if ((x.ev.status === 'draft' || x.ev.status === 'cancelled') && !x.canScore) throw notFound('Session');
      if (x.ev.status === 'cancelled') throw conflict('This event is cancelled');
      if (x.s.status === 'cancelled') throw conflict('This session is cancelled');
      const sheet = await ownSheet(user, i.id, c, { lock: true });
      if (sheet.status !== 'completed') throw conflict('Complete the sheet before proposing it');
      if (sheet.sport_id !== x.s.sport_id) throw badRequest('This sheet is for a different sport than the session');
      if (sheet.fixture_id) throw conflict('This sheet is already linked to a game');
      if (sheet.session_id && sheet.session_id !== x.s.id) throw conflict('This sheet is already linked to a different session');
      const v = (await c.query('SELECT * FROM tracking_sheet_template_versions WHERE id=$1', [sheet.template_version_id])).rows[0];
      if (v.layout.mode !== 'results') throw conflict('Only heat, field and race sheets can be proposed for a session');
      const policy = sessionPolicy(x.ev);
      const entries = (await c.query("SELECT id FROM event_session_entries WHERE session_id=$1 AND result_status <> 'scratched'", [x.s.id])).rows;
      const built = resultsFromRows(sheet, v.layout, i.mapping, x.s, entries);
      const payload = { kind: 'session', session_id: x.s.id, session_label: x.s.label, stage: x.s.stage, discipline: x.s.discipline, unit: v.layout.results.unit, results: built.results.map(({ row, ...r }) => r), rows: built.summary, sheet_ref: sheet.ref, ruleset: v.layout.title };
      const base = await snapshotOfSession(x.s.id, c);
      const imp = (await c.query("SELECT id FROM tracking_sheet_imports WHERE sheet_id=$1 AND state='confirmed' ORDER BY created_at DESC LIMIT 1", [sheet.id])).rows[0];
      const existing = (await c.query('SELECT * FROM result_proposals WHERE session_id=$1 AND sheet_id=$2 AND state = ANY($3) FOR UPDATE', [x.s.id, sheet.id, OPEN])).rows[0];
      let p, duplicate = false;
      if (existing) {
        const stale = hashOf(await snapshotOfSession(x.s.id, c)) !== hashOf(existing.base_snapshot);
        if (existing.submitted_by !== user.id && !x.organiser) throw conflict('Someone else already proposed this sheet for this session');
        if (!stale && [...REVIEWABLE, 'approved'].includes(existing.state) && hashOf(existing.payload) === hashOf(payload)) { duplicate = true; p = existing; }
        else {
          p = (await c.query("UPDATE result_proposals SET state='proposed', round=round+1, payload=$2, policy=$3, ruleset_hash=$4, template_version_id=$5, base_snapshot=$6, import_id=$7, updated_at=now() WHERE id=$1 RETURNING *",
            [existing.id, JSON.stringify(payload), JSON.stringify(policy), hashOf(v.layout.results), v.id, JSON.stringify(base), imp?.id ?? existing.import_id])).rows[0];
        }
      } else {
        p = (await c.query(
          `INSERT INTO result_proposals(session_id, event_id, sheet_id, import_id, submitted_by, home_is, payload, policy, ruleset_hash, template_version_id, base_snapshot)
           VALUES ($1,$2,$3,$4,$5,'home',$6,$7,$8,$9,$10) RETURNING *`,
          [x.s.id, x.s.event_id, sheet.id, imp?.id ?? null, user.id, JSON.stringify(payload), JSON.stringify(policy), hashOf(v.layout.results), v.id, JSON.stringify(base)])).rows[0];
        if (sheet.mode !== 'linked') await c.query("UPDATE tracking_sheets SET mode='linked', session_id=$2, updated_at=now() WHERE id=$1", [sheet.id, x.s.id]);
      }
      if (!duplicate) for (const uid of await sessionReviewers(c, x)) if (uid !== user.id) await tell(c, uid, p, 'Result proposed', 'A heat result was proposed for a session you help run. Review it in Tools.');
      return { ...p, duplicate };
    });
  },
});

// ------------------------------------------------------------------ read
async function proposalFor(user, proposalId, c, { lock = false } = {}) {
  const p = (await q(c).query(`SELECT * FROM result_proposals WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [proposalId])).rows[0];
  if (!p) throw notFound('Result proposal');
  const x = await contextOf(user, p, c);
  const submitter = p.submitted_by === user.id;
  if (!submitter && !x.canScore && !x.side) throw notFound('Result proposal'); // outsiders cannot tell it exists
  return { p, x, submitter };
}

async function sessionViewOf(user, p, x, c) {
  const [reviews, snap, detail, sheet, imp, submitter] = await Promise.all([
    q(c).query('SELECT r.round, r.resolved_role, r.requirement_key, r.decision, r.comment, r.override, r.at, u.display_name AS reviewer_name FROM result_proposal_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.proposal_id=$1 ORDER BY r.at, r.id', [p.id]).then((r) => r.rows),
    snapshotOfSession(p.session_id, c), sessionDetail(user, p.session_id), sheetView(p.sheet_id, c),
    p.import_id ? one('SELECT id, file_name, content_type, size_bytes, provider, confidence, warnings, created_at FROM tracking_sheet_imports WHERE id=$1', [p.import_id]) : null,
    one('SELECT display_name FROM users WHERE id=$1', [p.submitted_by]),
  ]);
  const current = reviews.filter((r) => r.round === p.round);
  const ev = evaluateProposal(p.policy, current);
  const roles = rolesOf(x);
  const open = OPEN.includes(p.state);
  const stale = open && hashOf(snap) !== hashOf(p.base_snapshot);
  const recorded = detail.entries.filter((e) => e.result_status !== 'registered' && e.result_status !== 'scratched');
  const differences = [];
  if (recorded.length) differences.push({ code: 'results_already_recorded', severity: 'warn', message: `${recorded.length} result${recorded.length === 1 ? ' is' : 's are'} already recorded for this session. Applying corrects them; the earlier values stay in the audit trail.` });
  if (stale) differences.push({ code: 'stale', severity: 'error', message: 'The session\'s results changed after this was proposed. It must be re-submitted and reviewed again.' });
  const myReq = REVIEWABLE.includes(p.state) && p.submitted_by !== user.id ? nextRequirement(p.policy, current, roles) : null;
  return {
    ...p, kind: 'session', submitter_name: submitter?.display_name, stale, evidence: imp && { ...imp, url: `/api/v1/tracking/imports/${imp.id}/file` },
    approval: { requirements: p.policy.requirements.map((r) => ({ ...r, approved: ev.approved.includes(r.key) })), approved: ev.approved, pending: ev.pending, mode: p.policy.mode, quorum: p.policy.quorum },
    reviews, my_roles: roles, can_review: !!myReq,
    can_override: REVIEWABLE.includes(p.state) && p.policy.allow_organiser_override && roles.includes('organiser') && p.submitted_by !== user.id,
    can_apply: p.state === 'approved' && x.canScore && !stale, needs_reconcile: false, can_withdraw: open && p.submitted_by === user.id,
    current: { session_status: snap.session_status, entries: detail.entries.map((e) => ({ id: e.id, name: e.full_name ?? e.team_name, lane: e.lane, status: e.result_status, value: e.result_value, position: e.position })) },
    differences, warnings: differences, ruleset: { label: p.payload.ruleset, kind: 'session' }, sheet: { ref: sheet.ref, labels: sheet.labels, entries: [], provenance: sheet.provenance },
    session: { id: detail.id, label: detail.label, stage: detail.stage, discipline: detail.discipline, status: detail.status, scheduled_at: detail.scheduled_at, event_id: detail.event_id },
    fixture: null,
  };
}

async function viewOf(user, p, x, c) {
  if (p.session_id) return sessionViewOf(user, p, x, c);
  const [reviews, snap, eventRs, logEvents, sheet, imp, submitter] = await Promise.all([
    q(c).query('SELECT r.round, r.resolved_role, r.requirement_key, r.decision, r.comment, r.override, r.at, u.display_name AS reviewer_name FROM result_proposal_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.proposal_id=$1 ORDER BY r.at, r.id', [p.id]).then((r) => r.rows),
    snapshotOf(p.fixture_id, c), rulesetForEvent(p.event_id, c, p.fixture_id).then((r) => r.ruleset), loggedEvents(p.fixture_id, c),
    sheetView(p.sheet_id, c), p.import_id ? one('SELECT id, file_name, content_type, size_bytes, provider, confidence, warnings, created_at FROM tracking_sheet_imports WHERE id=$1', [p.import_id]) : null,
    one('SELECT display_name FROM users WHERE id=$1', [p.submitted_by]),
  ]);
  const current = reviews.filter((r) => r.round === p.round);
  const ev = evaluateProposal(p.policy, current);
  const roles = rolesOf(x);
  const open = OPEN.includes(p.state);
  const stale = open && hashOf(snap) !== hashOf(p.base_snapshot);
  const logScore = logEvents.length && eventRs.kind !== 'manual' ? computeScore(eventRs, logEvents) : null;
  const differences = [];
  if (snap.published && (snap.published.score[0] !== p.payload.home_score || snap.published.score[1] !== p.payload.away_score)) differences.push({ code: 'differs_from_published', severity: 'warn', message: `The published result is ${snap.published.score[0]}-${snap.published.score[1]}; this proposes ${p.payload.home_score}-${p.payload.away_score}. Applying opens a correction, the published result stays in force until the new one is published.` });
  if (logScore && (logScore.home !== p.payload.home_score || logScore.away !== p.payload.away_score)) differences.push({ code: 'differs_from_match_log', severity: 'error', message: `The live match log adds up to ${logScore.home}-${logScore.away}. The organiser must reconcile this with a reason before it can be applied.` });
  if (snap.open_sheet) differences.push({ code: 'score_sheet_in_progress', severity: 'warn', message: `A score sheet is already ${snap.open_sheet.status}. Finish or reject it first.` });
  if (stale) differences.push({ code: 'stale', severity: 'error', message: 'The official record changed after this was proposed. It must be re-submitted and reviewed again.' });
  const warnings = [...validateTotals(eventRs, { home: p.payload.home_score, away: p.payload.away_score, sets: p.payload.sets, periods: p.payload.periods }), ...differences];
  const myReq = REVIEWABLE.includes(p.state) && p.submitted_by !== user.id ? nextRequirement(p.policy, current, roles) : null;
  return {
    ...p, submitter_name: submitter?.display_name, stale, evidence: imp && { ...imp, url: `/api/v1/tracking/imports/${imp.id}/file` },
    approval: { requirements: p.policy.requirements.map((r) => ({ ...r, approved: ev.approved.includes(r.key) })), approved: ev.approved, pending: ev.pending, mode: p.policy.mode, quorum: p.policy.quorum },
    reviews, my_roles: roles, can_review: !!myReq || (REVIEWABLE.includes(p.state) && p.submitted_by !== user.id && roles.length > 0 && p.policy.requirements.some((r) => r.roles.some((z) => roles.includes(z)))),
    can_override: REVIEWABLE.includes(p.state) && p.policy.allow_organiser_override && roles.includes('organiser') && p.submitted_by !== user.id,
    can_apply: p.state === 'approved' && x.canScore && !stale, needs_reconcile: differences.some((d) => d.code === 'differs_from_match_log' || d.code === 'differs_from_published'),
    can_withdraw: open && p.submitted_by === user.id,
    current: { fixture_status: snap.fixture_status, fixture_score: snap.fixture_score, published: snap.published, open_sheet: snap.open_sheet, live_log: logScore && { home: logScore.home, away: logScore.away, events: logEvents.length } },
    differences, warnings, ruleset: { label: eventRs.label, kind: eventRs.kind }, sheet: { ref: sheet.ref, labels: sheet.labels, entries: sheet.entries.filter((e) => !e.voided_at).slice(-60), provenance: sheet.provenance },
    fixture: (await q(c).query('SELECT f.id, f.status, f.scheduled_at, e.name AS event_name, h.name AS home_name, a.name AS away_name FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1', [p.fixture_id])).rows[0],
  };
}

cap({
  name: 'get_result_proposal', method: 'GET', path: '/tracking/proposals/:id', tag: TAG,
  summary: 'A proposed result with everything a reviewer needs: the game, pinned rules, proposed vs current official values and differences, evidence, warnings, review status per required role, and what the caller may do.',
  input: z.object({ id }),
  async handler({ user }, i) { const { p, x } = await proposalFor(user, i.id); return viewOf(user, p, x); },
});

cap({
  name: 'list_fixture_result_proposals', method: 'GET', path: '/fixtures/:id/result-proposals', tag: TAG,
  summary: 'Proposals for one game (organiser, match officials and team managers).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await fixtureContext(user, i.id);
    if (!x.canScore && !x.side) throw forbidden('Only the organiser, the match officials and the team managers can see proposals for a game');
    return many('SELECT p.id, p.state, p.round, p.payload->>\'home_score\' AS home_score, p.payload->>\'away_score\' AS away_score, p.created_at, u.display_name AS submitter_name FROM result_proposals p JOIN users u ON u.id=p.submitted_by WHERE p.fixture_id=$1 ORDER BY p.created_at DESC, p.id', [i.id]);
  },
});

cap({
  name: 'list_proposals_awaiting_my_review', method: 'GET', path: '/tracking/awaiting-review', tag: TAG,
  summary: 'Proposals where the caller holds a role that can act now (review, or apply once approved). Roles are resolved from the game\'s own assignments, not anything the caller declares.',
  async handler({ user }) {
    const rows = await many(
      `SELECT p.id, p.fixture_id, p.event_id, p.state, p.round, p.policy, p.payload, p.submitted_by, p.created_at, e.name AS event_name, h.name AS home_name, a.name AS away_name
         FROM result_proposals p JOIN events e ON e.id=p.event_id JOIN fixtures f ON f.id=p.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE p.state IN ('proposed','under_review','approved') AND p.submitted_by <> $1 ORDER BY p.created_at, p.id LIMIT 200`, [user.id]);
    const out = [];
    for (const r of rows) {
      const x = await fixtureContext(user, r.fixture_id);
      if (!x.canScore && !x.side) continue;
      const roles = rolesOf(x);
      const current = (await pool.query('SELECT decision, requirement_key FROM result_proposal_reviews WHERE proposal_id=$1 AND round=$2', [r.id, r.round])).rows;
      const action = r.state === 'approved' ? (x.canScore ? 'apply' : null) : nextRequirement(r.policy, current, roles) ? 'review' : null;
      if (action) { const { policy, ...rest } = r; out.push({ ...rest, action, my_roles: roles }); }
    }
    const sess = await many(
      `SELECT p.id, p.session_id, p.event_id, p.state, p.round, p.policy, p.payload, p.submitted_by, p.created_at, e.name AS event_name, s.label AS session_label
         FROM result_proposals p JOIN events e ON e.id=p.event_id JOIN event_sessions s ON s.id=p.session_id
        WHERE p.session_id IS NOT NULL AND p.state IN ('proposed','under_review','approved') AND p.submitted_by <> $1 ORDER BY p.created_at, p.id LIMIT 200`, [user.id]);
    for (const r of sess) {
      const x = await sessionContext(user, r.session_id, null);
      if (!x.canScore) continue;
      const roles = rolesOf(x);
      const current = (await pool.query('SELECT decision, requirement_key FROM result_proposal_reviews WHERE proposal_id=$1 AND round=$2', [r.id, r.round])).rows;
      const action = r.state === 'approved' ? 'apply' : nextRequirement(r.policy, current, roles) ? 'review' : null;
      if (action) { const { policy, ...rest } = r; out.push({ ...rest, kind: 'session', home_name: r.session_label, away_name: null, action, my_roles: roles }); }
    }
    return out;
  },
});

// ------------------------------------------------------------------ review
cap({
  name: 'review_result_proposal', method: 'POST', path: '/tracking/proposals/:id/review', tag: TAG,
  summary: 'Approve, request changes, reject or dispute a proposed result. The role you act as is resolved from the game\'s assignments. You cannot review your own submission. An organiser may approve all remaining steps with a reason only if the event policy allows overriding. Every decision is recorded and cannot be edited.',
  input: z.object({ id, decision: z.enum(['approve', 'changes_requested', 'reject', 'dispute']), comment: z.string().trim().max(1000).optional(), requirement_key: z.string().max(24).optional(), override_reason: z.string().trim().min(5).max(500).optional() }),
  async handler({ user }, i) {
    if (i.decision !== 'approve' && !i.comment) throw badRequest('Say why: a comment is required unless you approve');
    return tx(async (c) => {
      const { p, x } = await proposalFor(user, i.id, c, { lock: true });
      if (!REVIEWABLE.includes(p.state)) throw conflict(`This proposal is ${p.state.replace('_', ' ')}`);
      if (p.policy.no_self_approval && p.submitted_by === user.id) throw forbidden('You submitted this proposal, so someone else has to review it');
      const roles = rolesOf(x);
      if (!roles.length) throw forbidden('Only the organiser, the match officials and the team managers of this game can review it');
      const current = (await c.query('SELECT reviewer_id, decision, requirement_key FROM result_proposal_reviews WHERE proposal_id=$1 AND round=$2', [p.id, p.round])).rows;
      const insert = (key, role, override = false, comment = i.comment) =>
        c.query('INSERT INTO result_proposal_reviews(proposal_id, round, reviewer_id, resolved_role, requirement_key, decision, comment, override) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [p.id, p.round, user.id, role, key, i.decision, comment ?? null, override]);
      try {
        if (i.override_reason) {
          if (i.decision !== 'approve') throw badRequest('Override applies to approvals only');
          if (!p.policy.allow_organiser_override) throw forbidden('This event\'s policy does not allow an organiser override');
          if (!roles.includes('organiser')) throw forbidden('Only the organiser can override');
          const open = p.policy.requirements.filter((r) => !current.some((d) => d.decision === 'approve' && d.requirement_key === r.key));
          if (!open.length) throw conflict('Nothing is left to approve');
          for (const r of open) await insert(r.key, 'organiser', true, `Override: ${i.override_reason}`);
          await c.query('UPDATE result_proposals SET override_reason=$2 WHERE id=$1', [p.id, i.override_reason]);
        } else {
          const req = i.decision === 'approve'
            ? nextRequirement(p.policy, current, roles, i.requirement_key)
            : p.policy.requirements.find((r) => (!i.requirement_key || r.key === i.requirement_key) && r.roles.some((z) => roles.includes(z)));
          if (!req) throw forbidden(p.policy.mode === 'sequential' && i.decision === 'approve' ? 'It is not your step yet, or your role is not asked to approve' : 'Your role is not asked to review this proposal');
          if (current.some((d) => d.reviewer_id === user.id && d.requirement_key === req.key)) throw conflict('You already reviewed this step');
          await insert(req.key, req.roles.find((z) => roles.includes(z)));
        }
      } catch (e) { if (e.code === '23505') throw conflict('You already reviewed this step'); throw e; }
      const all = (await c.query('SELECT decision, requirement_key FROM result_proposal_reviews WHERE proposal_id=$1 AND round=$2', [p.id, p.round])).rows;
      const next = evaluateProposal(p.policy, all);
      const upd = (await c.query('UPDATE result_proposals SET state=$2, updated_at=now() WHERE id=$1 RETURNING *', [p.id, next.state])).rows[0];
      const tellers = new Set([p.submitted_by]);
      if (next.state === 'approved') for (const uid of await reviewers(c, x)) tellers.add(uid);
      const msg = { approved: 'Result approved - ready to apply', rejected: 'Result rejected', changes_requested: 'Changes requested on your result', disputed: 'Result disputed', under_review: 'Another approval completed' }[next.state];
      if (msg) for (const uid of tellers) if (uid !== user.id) await tell(c, uid, upd, msg, 'Open Tools to see the details.');
      return viewOf(user, upd, x, c);
    });
  },
});

cap({
  name: 'withdraw_result_proposal', method: 'POST', path: '/tracking/proposals/:id/withdraw', tag: TAG,
  summary: 'Withdraw your own proposal while it is still open. The sheet stays yours; reviews are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, x, submitter } = await proposalFor(user, i.id, c, { lock: true });
      if (!submitter) throw forbidden('Only the submitter can withdraw a proposal');
      if (!OPEN.includes(p.state)) throw conflict(`This proposal is ${p.state}`);
      const upd = (await c.query("UPDATE result_proposals SET state='withdrawn', updated_at=now() WHERE id=$1 RETURNING *", [p.id])).rows[0];
      return viewOf(user, upd, x, c);
    });
  },
});

// ------------------------------------------------------------------ apply
cap({
  name: 'apply_approved_result_proposal', method: 'POST', path: '/tracking/proposals/:id/apply', tag: TAG,
  summary: 'Hand an approved proposal to the score-sheet lifecycle (organiser or match official): it opens a draft score sheet - or a correction of the published result - which still needs the normal sign-offs, approval and publication. Re-checks the official record first; a conflict with the live match log or a published result needs the organiser and a reason. Repeating the call is safe.',
  input: z.object({ id, reconcile_reason: z.string().trim().min(5).max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { p, x } = await proposalFor(user, i.id, c, { lock: true });
      if (!x.canScore) throw forbidden('Only the organiser or the match officials can apply a proposal');
      if (p.session_id) {
        if (p.state === 'applied') return { already_applied: true, session_id: p.session_id };
        if (p.state !== 'approved') throw conflict(`Only an approved proposal can be applied; this one is ${p.state.replace('_', ' ')}`);
        if (hashOf(await snapshotOfSession(p.session_id, c)) !== hashOf(p.base_snapshot)) throw conflict('The session\'s results changed after this was approved. Ask the submitter to re-submit it for review.', { stale: true });
        const done = await recordSessionResults(c, user, { id: p.session_id, complete: true, results: p.payload.results.map((r) => ({ entry_id: r.entry_id, status: r.status, ...(r.value != null ? { value: r.value } : {}) })) });
        await c.query("UPDATE result_proposals SET state='applied', applied_by=$2, applied_at=now(), updated_at=now() WHERE id=$1", [p.id, user.id]);
        await c.query("UPDATE result_proposals SET state='superseded', updated_at=now() WHERE session_id=$1 AND id <> $2 AND state IN ('proposed','under_review','changes_requested','approved','disputed')", [p.session_id, p.id]);
        await tell(c, p.submitted_by, p, 'Result proposal applied', 'Your proposed heat result is now recorded for the session.');
        return { already_applied: false, session_id: p.session_id, entries: done.entries };
      }
      if (p.state === 'applied') return { already_applied: true, score_sheet: (await c.query('SELECT * FROM score_sheets WHERE id=$1', [p.applied_score_sheet_id])).rows[0] };
      if (p.state !== 'approved') throw conflict(`Only an approved proposal can be applied; this one is ${p.state.replace('_', ' ')}`);
      const fx = (await fixtureContext(user, p.fixture_id, c, { lock: true })).f;
      const snap = await snapshotOf(p.fixture_id, c);
      if (hashOf(snap) !== hashOf(p.base_snapshot)) throw conflict('The official record changed after this was approved. Ask the submitter to re-submit it for review.', { stale: true });
      if (['live', 'paused'].includes(fx.status)) throw conflict('The game is still on: end it first');
      if (snap.open_sheet) throw conflict(`A score sheet is already ${snap.open_sheet.status}; finish or reject it before applying this`);
      const eventRs = (await rulesetForEvent(p.event_id, c, p.fixture_id)).ruleset;
      const log = await loggedEvents(p.fixture_id, c);
      const logged = log.filter((e) => !e.voided_at).length && eventRs.kind !== 'manual' ? computeScore(eventRs, log) : null;
      const pay = p.payload;
      const differsLog = logged && (logged.home !== pay.home_score || logged.away !== pay.away_score);
      const differsPub = snap.published && (snap.published.score[0] !== pay.home_score || snap.published.score[1] !== pay.away_score);
      if (snap.published && !differsPub) throw conflict('This matches the published result already, so there is nothing to apply');
      if (differsLog || differsPub) {
        if (!x.organiser) throw forbidden('This changes the live match log or a published result: only the organiser can apply it, with a reason');
        if (!i.reconcile_reason) throw badRequest('Say why the match log or published result is being superseded (reconcile_reason)', { needs: 'reconcile_reason' });
      }
      const winnerTeam = pay.home_score === pay.away_score ? null : pay.home_score > pay.away_score ? fx.home_team_id : fx.away_team_id;
      const version = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM score_sheets WHERE fixture_id=$1', [p.fixture_id])).rows[0].v;
      const reviews = (await c.query('SELECT u.display_name, r.resolved_role FROM result_proposal_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.proposal_id=$1 AND r.round=$2 AND r.decision=\'approve\' ORDER BY r.at', [p.id, p.round])).rows;
      const notes = `Proposed from tracking sheet ${pay.sheet_ref}; approved by ${reviews.map((r) => `${r.display_name} (${r.resolved_role})`).join(', ') || 'policy'}.${i.reconcile_reason ? ` Reconciled: ${i.reconcile_reason}` : ''}`;
      const totals = { ruleset: pay.ruleset, kind: pay.kind, sets: pay.sets, periods: pay.periods, stats: pay.stats, proposal_id: p.id, sheet_ref: pay.sheet_ref };
      const pub = snap.published ? (await c.query("SELECT id FROM score_sheets WHERE fixture_id=$1 AND status='published'", [p.fixture_id])).rows[0] : null;
      const s = (await c.query(
        `INSERT INTO score_sheets(fixture_id, event_id, version, source, home_score, away_score, winner_team_id, totals, notes, adjusted_reason, revises_id, revision_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [p.fixture_id, p.event_id, version, pub ? 'revision' : 'manual', pay.home_score, pay.away_score, winnerTeam, JSON.stringify(totals), notes, i.reconcile_reason ?? null, pub?.id ?? null, pub ? `Approved proposal ${pay.sheet_ref}: ${i.reconcile_reason}` : null, user.id])).rows[0];
      await c.query('INSERT INTO score_sheet_log(sheet_id, actor_id, action, from_status, to_status, note, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.id, user.id, 'created', null, 'draft', `From approved result proposal ${pay.sheet_ref}`, JSON.stringify({ home_score: s.home_score, away_score: s.away_score, winner_team_id: s.winner_team_id, version: s.version, round: s.round })]);
      await c.query("UPDATE result_proposals SET state='applied', applied_score_sheet_id=$2, applied_by=$3, applied_at=now(), updated_at=now() WHERE id=$1", [p.id, s.id, user.id]);
      await c.query("UPDATE result_proposals SET state='superseded', updated_at=now() WHERE fixture_id=$1 AND id <> $2 AND state IN ('proposed','under_review','changes_requested','approved','disputed')", [p.fixture_id, p.id]);
      await tell(c, p.submitted_by, { ...p, round: p.round }, 'Result proposal applied', 'Your proposed result is now with the score-sheet sign-off.');
      return { already_applied: false, score_sheet: s };
    });
  },
});
