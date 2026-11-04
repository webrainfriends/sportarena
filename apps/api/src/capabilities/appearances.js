// Verified appearances, substitutions and minutes (issue #322). The match itself is the source: a lineup is set before kick-off,
// substitutions are logged against the game clock, minutes are computed at full time and verified when the result is published.
// Squad selection (team_squads) stays "who was picked"; this is "who actually played". Every change keeps a revision.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { isYouth, hasConsent, requireConsent, requireGuardian } from '../youth.js';
import { fixtureContext } from './match-tracking.js';
import { publish } from '../live.js';
import { liveState } from '../scoring/state.js';
import { ACTIVITIES_CTE } from '../athlete-history.js';
import { AUTHORITY, matchLength, minutesOn, ratesFrom } from '../appearances/minutes.js';

const TAG = 'Appearances';
const q = (c) => c ?? pool;
const COLS = 'id, fixture_id, team_id, user_id, status, on_clock_seconds, off_clock_seconds, match_clock_seconds, minutes_played::float AS minutes_played, minutes_basis, source, authority, row_version, verified_by, verified_at, archived_at, updated_at';
const snap = (a) => ({ status: a.status, on_clock_seconds: a.on_clock_seconds, off_clock_seconds: a.off_clock_seconds, minutes_played: a.minutes_played == null ? null : Number(a.minutes_played), minutes_basis: a.minutes_basis, source: a.source, authority: a.authority });
const rev = (c, a, action, actor, reason) => c.query('INSERT INTO match_appearance_revisions(appearance_id, row_version, action, snapshot, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6)', [a.id, a.row_version, action, JSON.stringify(snap(a)), reason ?? null, actor]);

/** Who may write: organiser / accepted officials, or the manager of the team concerned. The rank decides what they may overwrite. */
async function writer(user, fixtureId, c, { side, team } = {}) {
  const x = await fixtureContext(user, fixtureId, c, { lock: true });
  const published = (await c.query("SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status='published'", [fixtureId])).rowCount > 0;
  const mine = (t) => x.side === 'both' || (x.side && x.f[`${x.side}_team_id`] === t);
  const sideTeam = side ? x.f[`${side}_team_id`] : team;
  if (x.organiser) return { x, rank: published ? AUTHORITY.official_sheet : AUTHORITY.staff, published };
  if (x.canScore) return { x, rank: AUTHORITY.staff, published };
  if (sideTeam && mine(sideTeam)) return { x, rank: AUTHORITY.team_manager, published };
  throw forbidden('Only the organiser, the match officials or the manager of the team can do that');
}
const teamOf = (x, side) => { const t = x.f[`${side}_team_id`]; if (!t) throw conflict('That side of the game is not decided yet'); return t; };

async function eligible(c, fixture, teamId, userIds) {
  const ok = new Set((await c.query(
    `SELECT user_id FROM team_squads WHERE team_id=$1 AND (fixture_id=$2 OR event_id=$3) AND status IN ('selected','confirmed') AND role IN ('player','captain','vice_captain','substitute') AND user_id = ANY($4)
     UNION SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND user_id = ANY($4)`, [teamId, fixture.id, fixture.event_id, userIds])).rows.map((r) => r.user_id));
  const missing = userIds.filter((u) => !ok.has(u));
  if (missing.length) throw badRequest('Everyone in the lineup must be in the squad or on the active roster of the team', { user_ids: missing });
}

/** Minutes for every appearance of a game from the game clock. Manual entries and official-sheet values are never recomputed. */
export async function finalizeAppearances(c, fixtureId, actor) {
  const f = (await c.query('SELECT id, duration_min FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  if (!f) return 0;
  const events = (await c.query('SELECT kind, clock_seconds, voided_at FROM match_events WHERE fixture_id=$1', [fixtureId])).rows;
  const len = matchLength(events, f.duration_min);
  let n = 0;
  for (const a of (await c.query('SELECT * FROM match_appearances WHERE fixture_id=$1 AND archived_at IS NULL FOR UPDATE', [fixtureId])).rows) {
    if (['staff_entry', 'official_sheet'].includes(a.minutes_basis)) continue;
    const m = minutesOn({ status: a.status, on: a.on_clock_seconds, off: a.off_clock_seconds }, len.seconds);
    const basis = m == null ? null : (m === 0 ? a.minutes_basis : len.basis);
    if (Number(a.minutes_played) === m && a.minutes_basis === basis && a.match_clock_seconds === len.seconds) continue;
    const u = (await c.query('UPDATE match_appearances SET minutes_played=$2, minutes_basis=$3, match_clock_seconds=$4, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [a.id, m, basis, len.seconds])).rows[0];
    await rev(c, u, 'computed', actor, len.basis === 'scheduled_duration' ? 'Measured against the scheduled duration: no match clock was recorded' : null);
    n++;
  }
  return n;
}

/** The published result verifies the appearances it covers (official-sheet authority). Called by publish_score_sheet. */
export async function verifyAppearances(c, fixtureId, actor) {
  await finalizeAppearances(c, fixtureId, actor);
  for (const a of (await c.query('SELECT * FROM match_appearances WHERE fixture_id=$1 AND archived_at IS NULL AND verified_at IS NULL FOR UPDATE', [fixtureId])).rows) {
    const u = (await c.query('UPDATE match_appearances SET verified_by=$2, verified_at=now(), authority=greatest(authority,$3), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [a.id, actor, AUTHORITY.official_sheet])).rows[0];
    await rev(c, u, 'verified', actor, 'Result published');
  }
}

const bump = (c, a, set, args) => c.query(`UPDATE match_appearances SET ${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [a.id, ...args]).then((r) => r.rows[0]);

// ------------------------------------------------------------------ lineup
cap({
  name: 'set_match_lineup', method: 'POST', path: '/fixtures/:id/lineup', tag: TAG,
  summary: 'Name the starting players and the bench for one side before kick-off (organiser, match officials or that team\'s manager). Only people in the squad or on the active roster can be named; a young person needs a guardian\'s current participation consent. Replaces an earlier lineup of the same or lower authority; nobody is deleted — people dropped from the lineup are archived with a revision.',
  input: z.object({ id, side: z.enum(['home', 'away']), starters: z.array(id).min(1).max(40), bench: z.array(id).max(40).default([]) }),
  async handler({ user }, i) {
    const all = [...i.starters, ...i.bench];
    if (new Set(all).size !== all.length) throw badRequest('A player can only be named once');
    return tx(async (c) => {
      const { x, rank } = await writer(user, i.id, c, { side: i.side });
      if (x.f.status !== 'scheduled') throw conflict(`The lineup is set before kick-off; this game is ${x.f.status}. Correct individual appearances instead.`);
      const teamId = teamOf(x, i.side);
      await eligible(c, x.f, teamId, all);
      for (const u of all) if (await isYouth(u, c)) await requireConsent(u, 'participation', 'being named in a lineup', c);
      const existing = (await c.query('SELECT * FROM match_appearances WHERE fixture_id=$1 AND team_id=$2 FOR UPDATE', [i.id, teamId])).rows;
      if (existing.some((a) => a.authority > rank)) throw conflict('This lineup was set with higher authority and cannot be overwritten', { code: 'lower_authority' });
      const by = new Map(existing.map((a) => [a.user_id, a]));
      const want = new Map([...i.starters.map((u) => [u, 'started']), ...i.bench.map((u) => [u, 'unused_sub'])]);
      for (const [u, status] of want) {
        const a = by.get(u);
        if (!a) {
          const ins = (await c.query('INSERT INTO match_appearances(fixture_id, team_id, user_id, status, on_clock_seconds, source, authority, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (fixture_id, user_id) DO NOTHING RETURNING *',
            [i.id, teamId, u, status, status === 'started' ? 0 : null, 'lineup', rank, user.id])).rows[0];
          if (!ins) throw conflict('That player is already named for the other side of this game');
          await rev(c, ins, 'lineup', user.id);
        } else if (a.status !== status || a.archived_at) {
          const upd = await bump(c, a, 'status=$2, on_clock_seconds=$3, off_clock_seconds=NULL, minutes_played=NULL, minutes_basis=NULL, archived_at=NULL, authority=$4', [status, status === 'started' ? 0 : null, rank]);
          await rev(c, upd, 'lineup', user.id);
        }
      }
      for (const a of existing) if (!want.has(a.user_id) && !a.archived_at) {
        const upd = await bump(c, a, 'archived_at=now()', []);
        await rev(c, upd, 'archived', user.id, 'Removed from the lineup');
      }
      return (await c.query(`SELECT ${COLS} FROM match_appearances WHERE fixture_id=$1 AND team_id=$2 AND archived_at IS NULL ORDER BY (status='started') DESC, created_at, id`, [i.id, teamId])).rows;
    });
  },
});

// ------------------------------------------------------------------ substitutions
cap({
  name: 'record_substitution', method: 'POST', path: '/fixtures/:id/substitutions', tag: TAG, status: 201,
  summary: 'Log a substitution in a live or paused game: who comes off, who goes on, and the game-clock second. Both must be in the named lineup (starter or bench), the player coming off must be on the field, and a player who was substituted off does not return. Send a client_key to make retries safe.',
  input: z.object({ id, side: z.enum(['home', 'away']), player_off_id: id, player_on_id: id, clock_seconds: z.number().int().min(0).max(36000), period: z.number().int().min(1).max(20).optional(), client_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    if (i.player_off_id === i.player_on_id) throw badRequest('A player cannot replace themselves');
    const out = await tx(async (c) => {
      const { x, rank } = await writer(user, i.id, c, { side: i.side });
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM match_substitutions WHERE fixture_id=$1 AND client_key=$2', [i.id, i.client_key])).rows[0];
        if (dup) return { duplicate: true, substitution: dup };
      }
      if (!['live', 'paused'].includes(x.f.status)) throw conflict(`Substitutions are logged while the game is live or paused; this one is ${x.f.status}`);
      const teamId = teamOf(x, i.side);
      const get = async (u) => (await c.query('SELECT * FROM match_appearances WHERE fixture_id=$1 AND team_id=$2 AND user_id=$3 AND archived_at IS NULL FOR UPDATE', [i.id, teamId, u])).rows[0];
      const off = await get(i.player_off_id), on = await get(i.player_on_id);
      if (!off || !on) throw badRequest('Both players must be named in the lineup of this side. Set the lineup first.');
      if (!['started', 'substitute_on'].includes(off.status) || off.off_clock_seconds != null) throw conflict('The player coming off is not on the field');
      if (on.status !== 'unused_sub') throw conflict('The player going on must be an unused substitute');
      if (off.authority > rank || on.authority > rank) throw conflict('These appearances were set with higher authority and cannot be changed this way', { code: 'lower_authority' });
      if (i.clock_seconds < (off.on_clock_seconds ?? 0)) throw badRequest('The player coming off cannot leave before they came on');
      if (await isYouth(i.player_on_id, c)) await requireConsent(i.player_on_id, 'participation', 'playing in a game', c);
      const sub = (await c.query('INSERT INTO match_substitutions(fixture_id, team_id, player_off_id, player_on_id, period, clock_seconds, client_key, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.id, teamId, i.player_off_id, i.player_on_id, i.period ?? null, i.clock_seconds, i.client_key ?? null, user.id])).rows[0];
      const o = await bump(c, off, 'off_clock_seconds=$2, minutes_played=NULL, minutes_basis=NULL', [i.clock_seconds]);
      const n = await bump(c, on, "status='substitute_on', on_clock_seconds=$2, source='substitution', minutes_played=NULL, minutes_basis=NULL", [i.clock_seconds]);
      await rev(c, o, 'substituted_off', user.id); await rev(c, n, 'substituted_on', user.id);
      return { duplicate: false, substitution: sub };
    });
    publish(`fixture:${i.id}`, await liveState(i.id));
    return out;
  },
});

cap({
  name: 'void_substitution', method: 'POST', path: '/substitutions/:id/void', tag: TAG,
  summary: 'Cancel a wrongly logged substitution with a reason (organiser or match official, while the game is live or paused). Both players return to their earlier state; the substitution stays in the record, marked void. Not possible once the incoming player has been substituted off.',
  input: z.object({ id, reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM match_substitutions WHERE id=$1', [i.id]);
    if (!s) throw notFound('Substitution');
    return tx(async (c) => {
      const { x } = await writer(user, s.fixture_id, c);
      if (!x.canScore) throw forbidden('Only the organiser or the match officials can void a substitution');
      if (!['live', 'paused'].includes(x.f.status)) throw conflict('Substitutions can only be voided while the game is live or paused; after full time, correct the appearances');
      const cur = (await c.query('SELECT * FROM match_substitutions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.voided_at) throw conflict('Already voided');
      const get = async (u) => (await c.query('SELECT * FROM match_appearances WHERE fixture_id=$1 AND user_id=$2 FOR UPDATE', [cur.fixture_id, u])).rows[0];
      const off = await get(cur.player_off_id), on = await get(cur.player_on_id);
      if (on.off_clock_seconds != null) throw conflict('The player who came on has since been substituted off; void that substitution first');
      const o = await bump(c, off, 'off_clock_seconds=NULL, minutes_played=NULL, minutes_basis=NULL', []);
      const n = await bump(c, on, "status='unused_sub', on_clock_seconds=NULL, minutes_played=NULL, minutes_basis=NULL", []);
      await rev(c, o, 'substitution_voided', user.id, i.reason); await rev(c, n, 'substitution_voided', user.id, i.reason);
      await c.query('UPDATE match_substitutions SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [i.id, user.id, i.reason]);
      return { id: i.id, voided: true };
    });
  },
});

cap({
  name: 'finalize_appearances', method: 'POST', path: '/fixtures/:id/appearances/finalize', tag: TAG,
  summary: 'Compute minutes for every named player from the game clock once the game is at full time (organiser or match official). Minutes are NULL, never zero, where no valid clock exists. Manual and official-sheet values are left untouched. Publishing the result runs this and verifies the appearances.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { x } = await writer(user, i.id, c);
      if (!x.canScore) throw forbidden('Only the organiser or the match officials can do that');
      if (!['finished', 'completed'].includes(x.f.status)) throw conflict(`Minutes are computed at full time; this game is ${x.f.status}`);
      return { updated: await finalizeAppearances(c, i.id, user.id) };
    });
  },
});

// ------------------------------------------------------------------ corrections
cap({
  name: 'correct_appearance', method: 'POST', path: '/appearances/:id/correct', tag: TAG,
  summary: 'Correct one player\'s appearance (status, on/off clock or minutes) with a reason. Send the row_version you saw: a stale version returns a conflict. A source of lower authority than the current value is refused — official-sheet beats organiser/officials beats team manager. Every correction is kept as a revision.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: z.string().trim().min(3).max(500),
    status: z.enum(['started', 'substitute_on', 'unused_sub', 'dnp']).optional(), on_clock_seconds: z.number().int().min(0).max(36000).nullable().optional(),
    off_clock_seconds: z.number().int().min(0).max(36000).nullable().optional(), minutes_played: z.number().min(0).max(600).optional() }),
  async handler({ user }, i) {
    const a0 = await one('SELECT fixture_id, team_id FROM match_appearances WHERE id=$1', [i.id]);
    if (!a0) throw notFound('Appearance');
    return tx(async (c) => {
      const { x, rank } = await writer(user, a0.fixture_id, c, { team: a0.team_id });
      if (x.f.status === 'cancelled') throw conflict('The game was cancelled');
      const a = (await c.query('SELECT * FROM match_appearances WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.row_version !== i.row_version) throw conflict('This appearance changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: a.row_version });
      if (a.authority > rank) throw conflict('A higher-authority source set this appearance; ask the organiser to correct it', { code: 'lower_authority', authority: a.authority });
      const status = i.status ?? a.status;
      const nonPlay = ['unused_sub', 'dnp'].includes(status);
      let on = nonPlay ? null : (i.on_clock_seconds !== undefined ? i.on_clock_seconds : a.on_clock_seconds);
      let off = nonPlay ? null : (i.off_clock_seconds !== undefined ? i.off_clock_seconds : a.off_clock_seconds);
      if (!nonPlay && status === 'started' && on == null) on = 0;
      if (on != null && off != null && off < on) throw badRequest('The player cannot leave before they came on');
      const events = (await c.query('SELECT kind, clock_seconds, voided_at FROM match_events WHERE fixture_id=$1', [a0.fixture_id])).rows;
      const len = matchLength(events, x.f.duration_min);
      let minutes, basis;
      if (nonPlay) { minutes = 0; basis = a.minutes_basis ?? 'staff_entry'; }
      else if (i.minutes_played !== undefined) {
        if (len.basis === 'match_clock' && i.minutes_played > len.seconds / 60 + 0.5) throw badRequest(`Minutes cannot exceed the length of play (${Math.round(len.seconds / 6) / 10})`);
        minutes = i.minutes_played; basis = rank >= AUTHORITY.official_sheet ? 'official_sheet' : 'staff_entry';
      } else if (['finished', 'completed'].includes(x.f.status)) { minutes = minutesOn({ status, on, off }, len.seconds); basis = minutes == null ? null : len.basis; }
      else { minutes = null; basis = null; }
      const u = await bump(c, a, 'status=$2, on_clock_seconds=$3, off_clock_seconds=$4, minutes_played=$5, minutes_basis=$6, match_clock_seconds=$7, source=$8, authority=$9, verified_by=NULL, verified_at=NULL',
        [status, on, off, minutes, basis, len.seconds, rank >= AUTHORITY.official_sheet ? 'official_sheet' : 'staff', rank]);
      await rev(c, u, 'corrected', user.id, i.reason);
      await audit(c, user.id, 'correct_appearance', 'match_appearance', u.id);
      return (await c.query(`SELECT ${COLS} FROM match_appearances WHERE id=$1`, [u.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ reading
async function staffView(user, fixtureId) {
  const x = await fixtureContext(user, fixtureId);
  if (!x.canScore && !x.side) throw forbidden('Only the organiser, the match officials and the team managers can see this');
  return x;
}

cap({
  name: 'list_fixture_appearances', method: 'GET', path: '/fixtures/:id/appearances', tag: TAG,
  summary: 'Lineup, substitutions and minutes of a game with source, authority and verification (organiser, match officials, team managers). A young person without current guardian consent is shown as hidden.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await staffView(user, i.id);
    const rows = await many(`SELECT ${COLS.split(', ').map((c) => (c.includes('::') ? c.replace('minutes_played::float', 'a.minutes_played::float') : `a.${c}`)).join(', ')}, u.display_name FROM match_appearances a JOIN users u ON u.id=a.user_id WHERE a.fixture_id=$1 AND a.archived_at IS NULL ORDER BY a.team_id, (a.status='started') DESC, a.created_at, a.id`, [i.id]);
    const appearances = [];
    for (const r of rows) {
      if (await hasConsent(r.user_id, 'participation')) appearances.push(r);
      else appearances.push({ id: r.id, team_id: r.team_id, hidden: true, reason: 'guardian_consent_required' });
    }
    const hidden = new Set(rows.filter((r) => !appearances.find((a) => a.id === r.id && !a.hidden)).map((r) => r.user_id));
    const substitutions = (await many('SELECT id, team_id, player_off_id, player_on_id, period, clock_seconds, voided_at, void_reason, created_at FROM match_substitutions WHERE fixture_id=$1 ORDER BY clock_seconds, id', [i.id]))
      .map((s) => (hidden.has(s.player_off_id) || hidden.has(s.player_on_id) ? { id: s.id, team_id: s.team_id, clock_seconds: s.clock_seconds, hidden: true } : s));
    return { fixture_id: i.id, status: x.f.status, appearances, substitutions };
  },
});

cap({
  name: 'list_appearance_revisions', method: 'GET', path: '/appearances/:id/revisions', tag: TAG,
  summary: 'The full correction history of one appearance: every lineup, substitution, computation, correction and verification with who and why.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const a = await one('SELECT fixture_id, user_id FROM match_appearances WHERE id=$1', [i.id]);
    if (!a) throw notFound('Appearance');
    await staffView(user, a.fixture_id);
    if (!(await hasConsent(a.user_id, 'participation'))) throw forbidden('A guardian\'s consent for this young person has been withdrawn');
    return many('SELECT row_version, action, snapshot, reason, actor_id, created_at FROM match_appearance_revisions WHERE appearance_id=$1 ORDER BY row_version, created_at, id LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_player_appearances', method: 'GET', path: '/me/appearances', tag: TAG,
  summary: 'Your verified appearances (or a young person\'s you are guardian of, with user_id): games actually played, substitutions, minutes with source and verification, and per-90 rates computed only from games with verified playing time. A young person reading for themselves needs a guardian\'s current consent.',
  input: z.object({ user_id: id.optional(), per: z.coerce.number().int().min(1).max(120).default(90), ...page }),
  async handler({ user }, i) {
    const target = i.user_id ?? user.id;
    if (target !== user.id) { if (!isAdmin(user)) await requireGuardian(user, target); await audit(null, user.id, 'read_appearances', 'user', target); }
    else if (!(await hasConsent(target, 'participation'))) throw conflict('A guardian\'s current consent is needed to show this', { code: 'guardian_consent_required', purpose: 'participation' });
    const base = `FROM match_appearances a JOIN fixtures f ON f.id=a.fixture_id LEFT JOIN events ev ON ev.id=f.event_id LEFT JOIN teams t ON t.id=a.team_id
      WHERE a.user_id=$1 AND a.archived_at IS NULL AND f.status IN ('finished','completed')`;
    const rows = await many(`SELECT a.id, a.fixture_id, a.team_id, t.name AS team, ev.name AS competition, f.scheduled_at, a.status, a.on_clock_seconds, a.off_clock_seconds, a.minutes_played::float AS minutes_played,
        a.minutes_basis, a.source, a.authority, (a.verified_at IS NOT NULL) AS verified, a.row_version ${base} ORDER BY f.scheduled_at DESC, a.id LIMIT $2 OFFSET $3`, [target, i.limit, i.offset]);
    const all = await many(`SELECT a.fixture_id, a.minutes_played::float AS minutes_played, a.minutes_basis, a.status ${base} AND a.status IN ('started','substitute_on')`, [target]);
    const stats = new Map((await many(`${ACTIVITIES_CTE} SELECT fixture_id, stats FROM acts WHERE is_official AND fixture_id IS NOT NULL`, [target])).map((r) => [r.fixture_id, r.stats]));
    return { user_id: target, appearances: rows, played: all.length, rates: ratesFrom(all.map((r) => ({ ...r, stats: stats.get(r.fixture_id) ?? {} })), { per: i.per }) };
  },
});
