// Season, division & league administration (issue #576), extending #476 (competitions.js): season rollover, play-off stages, match-week administration
// (round windows, closing, shifting, the season calendar) and ranked-meet results for sports ranked by time, distance, weight or judged score.
// Everything reuses the canonical records: play-off games are ordinary fixtures linked through comp_fixture_links; a new season is a normal season
// created by the same code as create_season; nothing here copies a team, match or score (docs/competition-seasons.md).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { roundRobin, rankMeet } from '../competition-standings.js';
import { buildBracket, ROUND_LABEL } from '../tournament/bracket.js';
import { CLOSED, acceptedTeams, addDays, createSeasonRow, currentRules, divisionRow, isRanked, liveTable, logMembership, manageSeason, readSeason, sportModel, stamp, ymd } from './competitions.js';

const TAG = 'Competitions';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time (HH:MM)');
const reason = z.string().trim().min(3).max(500);
const txt = (n) => z.string().trim().min(1).max(n);

const roundRow = async (c, rid, { lock = false } = {}) => {
  const r = (await c.query(`SELECT * FROM comp_rounds WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [rid])).rows[0];
  if (!r) throw notFound('Round');
  return r;
};

// ------------------------------------------------------------------ match-week administration
cap({
  name: 'update_round', method: 'PATCH', path: '/rounds/:id', tag: TAG,
  summary: 'Rename a round / match week or move its scheduling window. A closed round must be reopened first. Games already in the round keep their kick-off; use shift_round to move them together.',
  input: z.object({ id, label: txt(60).optional(), starts_on: day.nullable().optional(), ends_on: day.nullable().optional(), window_enforced: z.boolean().optional().describe('hold the round\'s games to its window: a kick-off outside it then needs an explicit confirmation') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await roundRow(c, i.id, { lock: true });
      await manageSeason(c, user, r.season_id);
      if (r.closed_at) throw conflict(`${r.label} is closed; reopen it first`, { code: 'round_closed' });
      const keys = ['label', 'starts_on', 'ends_on', 'window_enforced'].filter((k) => i[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      try {
        const out = (await c.query(`UPDATE comp_rounds SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [r.id, ...keys.map((k) => i[k])])).rows[0];
        await audit(c, user.id, 'competition.round_update', 'competition_round', r.id);
        return { ...out, starts_on: ymd(out.starts_on), ends_on: ymd(out.ends_on) };
      } catch (e) { if (e.code === '23514') throw badRequest('A round must end on or after it starts'); throw e; }
    });
  },
});

cap({
  name: 'set_round_status', method: 'POST', path: '/rounds/:id/status', tag: TAG,
  summary: 'Close a match week once its games are settled (played, forfeited or cancelled; a ranked meet needs its results) so nobody reschedules or re-decides it by accident, or reopen it with a reason. Closing is refused while games are still open.',
  input: z.object({ id, action: z.enum(['close', 'reopen']), reason: reason.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await roundRow(c, i.id, { lock: true });
      await manageSeason(c, user, r.season_id);
      if (i.action === 'reopen') {
        if (!r.closed_at) throw conflict('This round is not closed');
        if (!i.reason) throw badRequest('Say why the round is reopened (reason)');
        const out = (await c.query('UPDATE comp_rounds SET closed_at=NULL, closed_by=NULL WHERE id=$1 RETURNING *', [r.id])).rows[0];
        await audit(c, user.id, 'competition.round_reopen', 'competition_round', r.id);
        return out;
      }
      if (r.closed_at) throw conflict('This round is already closed');
      const d = await divisionRow(c, r.division_id);
      const open = (await isRanked(c, d))
        ? (await c.query('SELECT CASE WHEN EXISTS (SELECT 1 FROM comp_meet_results WHERE round_id=$1) THEN 0 ELSE 1 END AS n', [r.id])).rows[0].n
        : (await c.query("SELECT count(*)::int AS n FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.round_id=$1 AND l.outcome='played' AND f.status NOT IN ('completed','cancelled')", [r.id])).rows[0].n;
      if (open) throw conflict(`${open} ${open === 1 ? 'game or meet is' : 'games are'} not settled yet`, { code: 'round_open', open });
      const out = (await c.query('UPDATE comp_rounds SET closed_at=now(), closed_by=$2 WHERE id=$1 RETURNING *', [r.id, user.id])).rows[0];
      await audit(c, user.id, 'competition.round_close', 'competition_round', r.id);
      return out;
    });
  },
});

cap({
  name: 'shift_round', method: 'POST', path: '/rounds/:id/shift', tag: TAG,
  summary: 'Move a whole match week by a number of days (for example a weather week or a public holiday): the round window and every game that has not been played move together, each change recorded with the reason. Played games never move.',
  input: z.object({ id, days: z.number().int().min(-60).max(60).refine((n) => n !== 0, 'Not zero'), reason }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await roundRow(c, i.id, { lock: true });
      const { s } = await manageSeason(c, user, r.season_id, { lock: true });
      if (r.closed_at) throw conflict(`${r.label} is closed; reopen it first`, { code: 'round_closed' });
      const games = (await c.query("SELECT f.* FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id WHERE l.round_id=$1 AND f.status IN ('scheduled','postponed') FOR UPDATE OF f", [r.id])).rows;
      for (const f of games) {
        const to = new Date(+new Date(f.scheduled_at) + i.days * 864e5).toISOString();
        await c.query("UPDATE fixtures SET scheduled_at=$2, status='scheduled' WHERE id=$1", [f.id, to]);
        await c.query("INSERT INTO comp_schedule_changes(season_id,division_id,fixture_id,action,from_at,to_at,reason,actor_id) VALUES ($1,$2,$3,'shifted',$4,$5,$6,$7)", [s.id, r.division_id, f.id, f.scheduled_at, to, i.reason, user.id]);
      }
      const out = (await c.query('UPDATE comp_rounds SET starts_on=starts_on + $2::int, ends_on=ends_on + $2::int WHERE id=$1 RETURNING *', [r.id, i.days])).rows[0];
      await audit(c, user.id, 'competition.round_shift', 'competition_round', r.id);
      return { round_id: r.id, label: r.label, days: i.days, games_moved: games.length, starts_on: ymd(out.starts_on), ends_on: ymd(out.ends_on) };
    });
  },
});

cap({
  name: 'list_season_calendar', method: 'GET', path: '/seasons/:id/calendar', tag: TAG, auth: 'public',
  summary: 'The season calendar across every division in time order: games (with division, round and window), ranked meets, and the season\'s registration and transfer windows. Filter by division, team, status or dates. The schedule history of each change is in `changes` for administrators.',
  input: z.object({ id, division_id: id.optional(), team_id: id.optional(), status: z.string().max(20).optional(), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    const { s, staff } = await readSeason(pool, user, i.id);
    const p = [s.id]; const w = ['l.season_id=$1', 'd.archived_at IS NULL'];
    if (i.division_id) { p.push(i.division_id); w.push(`l.division_id=$${p.length}`); }
    if (i.team_id) { p.push(i.team_id); w.push(`(f.home_team_id=$${p.length} OR f.away_team_id=$${p.length})`); }
    if (i.status) { p.push(i.status); w.push(`f.status=$${p.length}`); }
    if (i.from) { p.push(i.from); w.push(`f.scheduled_at >= $${p.length}`); }
    if (i.to) { p.push(`${i.to}T23:59:59Z`); w.push(`f.scheduled_at <= $${p.length}`); }
    const games = await many(
      `SELECT f.id, d.id AS division_id, d.name AS division, d.kind AS division_kind, rd.id AS round_id, rd.number AS round_number, rd.label AS round, rd.starts_on::text AS window_from, rd.ends_on::text AS window_to, rd.closed_at,
              f.scheduled_at, f.status, f.round_kind, f.home_team_id, h.name AS home, f.away_team_id, a.name AS away, f.home_score, f.away_score, l.outcome, l.postponed_reason
         FROM comp_fixture_links l JOIN fixtures f ON f.id=l.fixture_id JOIN comp_divisions d ON d.id=l.division_id LEFT JOIN comp_rounds rd ON rd.id=l.round_id
         LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
        WHERE ${w.join(' AND ')} ORDER BY f.scheduled_at, d.tier LIMIT ${i.limit} OFFSET ${i.offset}`, p);
    const meets = i.team_id || i.status ? [] : await many(
      `SELECT rd.id AS round_id, d.id AS division_id, d.name AS division, rd.number AS round_number, rd.label AS round, rd.starts_on::text AS window_from, rd.ends_on::text AS window_to, rd.closed_at,
              (SELECT count(*)::int FROM comp_meet_results m WHERE m.round_id=rd.id) AS results
         FROM comp_rounds rd JOIN comp_divisions d ON d.id=rd.division_id
        WHERE rd.season_id=$1 AND d.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM comp_fixture_links l WHERE l.round_id=rd.id) ${i.division_id ? 'AND d.id=$2' : ''} ORDER BY rd.starts_on, d.tier`, i.division_id ? [s.id, i.division_id] : [s.id]);
    const changes = staff ? await many('SELECT c.id, c.fixture_id, c.action, c.from_at, c.to_at, c.reason, c.actor_id, c.created_at FROM comp_schedule_changes c WHERE c.season_id=$1 ORDER BY c.created_at DESC LIMIT 50', [s.id]) : undefined;
    return { season: { id: s.id, label: s.label, status: s.status, starts_on: s.starts_on, ends_on: s.ends_on, registration_opens_on: s.registration_opens_on, registration_closes_on: s.registration_closes_on, transfer_opens_on: s.transfer_opens_on, transfer_closes_on: s.transfer_closes_on }, items: games, meets, changes, limit: i.limit, offset: i.offset };
  },
});

// ------------------------------------------------------------------ ranked meets (time, distance, weight, judged)
cap({
  name: 'record_meet_results', method: 'POST', path: '/rounds/:id/results', tag: TAG,
  summary: 'Publish the results of one meet of a ranked-meet division (a sport ranked by time, distance, weight or judged score). Give each team its value (the server ranks: fastest time or highest mark / score first, equal values share a place) or its place, and a status (finished, dns, dnf, dq). Publishing again replaces the listed teams\' results; every publication is kept in the meet log with its reason. Series points follow the season rules\' placement_points.',
  input: z.object({ id, results: z.array(z.object({ team_id: id, value: z.number().min(0).max(1e9).optional(), position: z.number().int().min(1).max(500).optional(), status: z.enum(['finished', 'dns', 'dnf', 'dq']).default('finished') })).min(1).max(500), reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = await roundRow(c, i.id, { lock: true });
      const { s } = await manageSeason(c, user, r.season_id, { lock: true });
      const d = await divisionRow(c, r.division_id);
      const model = await sportModel(c, d);
      if (model.model !== 'ranked_meets') throw unprocessable('This sport is played as fixtures between two sides; results come from the fixtures themselves', { code: 'head_to_head_sport' });
      if (r.closed_at) throw conflict(`${r.label} is closed; reopen it first`, { code: 'round_closed' });
      if (d.archived_at) throw conflict('This division is archived');
      const ids = i.results.map((x) => x.team_id);
      if (new Set(ids).size !== ids.length) throw badRequest('Each team appears once');
      const members = new Set((await acceptedTeams(c, d.id)).map((t) => t.team_id));
      if (ids.some((t) => !members.has(t))) throw badRequest('Every team must be an accepted team of this division');
      const ranked = rankMeet(i.results, model.best);
      if (ranked.some((x) => x.status === 'finished' && x.position == null)) throw badRequest('Give every finishing team a value or a place');
      for (const x of ranked) {
        await c.query(
          `INSERT INTO comp_meet_results(round_id,season_id,division_id,team_id,value,position,status,entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (round_id,team_id) DO UPDATE SET value=EXCLUDED.value, position=EXCLUDED.position, status=EXCLUDED.status, entered_by=EXCLUDED.entered_by, updated_at=now()`,
          [r.id, s.id, d.id, x.team_id, x.value ?? null, x.position, x.status, user.id]);
      }
      await c.query('INSERT INTO comp_meet_result_log(round_id,season_id,results,reason,actor_id) VALUES ($1,$2,$3,$4,$5)', [r.id, s.id, JSON.stringify(ranked), i.reason ?? null, user.id]);
      await audit(c, user.id, 'competition.meet_results', 'competition_round', r.id);
      return { round_id: r.id, results: ranked };
    });
  },
});

cap({
  name: 'list_division_meets', method: 'GET', path: '/divisions/:id/meets', tag: TAG, auth: 'public',
  summary: 'The meets of a ranked-meet division with each team\'s place, value and status, in meet order. `log=true` (administrators) adds the publication history of each meet.',
  input: z.object({ id, log: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const d = await divisionRow(pool, i.id);
    const { staff } = await readSeason(pool, user, d.season_id);
    const items = await many(
      `SELECT rd.id, rd.number, rd.label, rd.starts_on::text AS starts_on, rd.ends_on::text AS ends_on, rd.closed_at,
              coalesce((SELECT jsonb_agg(jsonb_build_object('team_id', m.team_id, 'team', t.name, 'position', m.position, 'value', m.value, 'status', m.status) ORDER BY m.position NULLS LAST, t.name)
                          FROM comp_meet_results m JOIN teams t ON t.id=m.team_id WHERE m.round_id=rd.id), '[]'::jsonb) AS results
         FROM comp_rounds rd WHERE rd.division_id=$1 ORDER BY rd.number LIMIT ${i.limit} OFFSET ${i.offset}`, [d.id]);
    if (i.log && staff) for (const m of items) m.log = await many('SELECT results, reason, actor_id, created_at FROM comp_meet_result_log WHERE round_id=$1 ORDER BY created_at DESC', [m.id]);
    return { items, limit: i.limit, offset: i.offset };
  },
});

// ------------------------------------------------------------------ play-off stage
cap({
  name: 'create_playoff_stage', method: 'POST', path: '/seasons/:id/playoff-stage', tag: TAG, status: 201,
  summary: 'Start a play-off stage inside an active season: the top N teams of a division\'s current table (seeded by it) play a knockout (with an optional third-place game) or a round robin. It is a division of kind "play-off" whose games are ordinary fixtures in the season\'s event, so scoring, officials and winner advancement work as everywhere else; the qualifiers keep their league membership. A knockout\'s final decides the season champion when the season is completed.',
  input: z.object({
    id, source_division_id: id, teams: z.number().int().min(2).max(32), format: z.enum(['knockout', 'round_robin']).default('knockout'), name: txt(80).optional(), third_place: z.boolean().default(false),
    first_round_on: day, days_between_rounds: z.number().int().min(1).max(30).default(7), kickoff: hhmm.default('18:00'), duration_min: z.number().int().min(10).max(600).default(90), utc_offset_minutes: z.number().int().min(-720).max(840).default(0),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await manageSeason(c, user, i.id, { lock: true });
      if (s.status !== 'active') throw conflict('Play-offs run while the season is in play', { code: 'not_active' });
      const src = await divisionRow(c, i.source_division_id, { lock: true });
      if (src.season_id !== s.id || src.archived_at) throw notFound('Division');
      if (src.kind === 'playoff') throw badRequest('Choose a league division as the source of the play-off');
      if (await isRanked(c, src)) throw unprocessable('A ranked-meet series qualifies by its series table; run a final meet instead', { code: 'ranked_meet_series' });
      const { table } = await liveTable(c, src, await currentRules(c, s.id));
      if (table.length < i.teams) throw conflict(`${src.name} has only ${table.length} teams`);
      const field = table.slice(0, i.teams);
      const name = i.name ?? `${src.name} play-offs`;
      let d;
      try {
        d = (await c.query("INSERT INTO comp_divisions(season_id,name,kind,tier,capacity,gender,min_age,max_age,stage_format,source_division_id,created_by) VALUES ($1,$2,'playoff',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [s.id, name, src.tier, Math.max(2, i.teams), src.gender, src.min_age, src.max_age, i.format === 'knockout' ? 'knockout' : 'league', src.id, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('This season already has a division with that name'); throw e; }
      for (const [k, t] of field.entries()) await c.query('INSERT INTO comp_stage_entries(division_id,season_id,team_id,seed,source_division_id,source_rank,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [d.id, s.id, t.team_id, k + 1, src.id, t.rank, user.id]);
      const seeds = field.map((t) => t.team_id);
      const link = (fid, rid) => c.query('INSERT INTO comp_fixture_links(fixture_id,season_id,division_id,round_id,created_by) VALUES ($1,$2,$3,$4,$5)', [fid, s.id, d.id, rid, user.id]);
      const mkRound = async (n, label, on) => (await c.query('INSERT INTO comp_rounds(season_id,division_id,number,label,starts_on,ends_on,created_by) VALUES ($1,$2,$3,$4,$5,$5,$6) RETURNING id', [s.id, d.id, n, label, on, user.id])).rows[0];
      let games = 0, rounds = 0;
      if (i.format === 'round_robin') {
        for (const [n, pairs] of roundRobin(seeds).entries()) {
          const on = addDays(i.first_round_on, n * i.days_between_rounds);
          const r = await mkRound(n + 1, `Play-off round ${n + 1}`, on); rounds++;
          for (const [h, a] of pairs) { const f = (await c.query('INSERT INTO fixtures(event_id,round,home_team_id,away_team_id,scheduled_at,duration_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [s.event_id, `Play-off round ${n + 1}`, h, a, stamp(on, i.kickoff, i.utc_offset_minutes), i.duration_min])).rows[0]; await link(f.id, r.id); games++; }
        }
      } else {
        const bracket = buildBracket(seeds, { thirdPlace: i.third_place });
        const byRound = new Map();
        for (const f of bracket.fixtures) (byRound.get(f.round_index) ?? byRound.set(f.round_index, []).get(f.round_index)).push(f);
        const ids = new Map();
        for (const [ri, list] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
          const on = addDays(i.first_round_on, ri * i.days_between_rounds);
          const label = ROUND_LABEL[list[0].round_kind];
          const r = await mkRound(ri + 1, label, on); rounds++;
          for (const f of list) {
            const row = (await c.query(
              'INSERT INTO fixtures(event_id,round,home_team_id,away_team_id,scheduled_at,duration_min,round_kind,bracket_slot,home_placeholder,away_placeholder) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
              [s.event_id, ROUND_LABEL[f.round_kind], f.home, f.away, stamp(on, i.kickoff, i.utc_offset_minutes), i.duration_min, f.round_kind, f.slot, f.home_placeholder, f.away_placeholder])).rows[0];
            ids.set(f.key, row.id); await link(row.id, r.id); games++;
          }
        }
        for (const f of bracket.fixtures) {
          if (f.win_feeds) await c.query('UPDATE fixtures SET win_feeds_fixture_id=$2, win_feeds_side=$3 WHERE id=$1', [ids.get(f.key), ids.get(f.win_feeds.key), f.win_feeds.side]);
          if (f.lose_feeds) await c.query('UPDATE fixtures SET lose_feeds_fixture_id=$2, lose_feeds_side=$3 WHERE id=$1', [ids.get(f.key), ids.get(f.lose_feeds.key), f.lose_feeds.side]);
        }
      }
      await audit(c, user.id, 'competition.playoff_create', 'competition_division', d.id);
      return { division: d, qualifiers: field.map((t, k) => ({ team_id: t.team_id, name: t.name, seed: k + 1, source_rank: t.rank })), rounds, fixtures: games, format: i.format };
    });
  },
});

// ------------------------------------------------------------------ rollover
cap({
  name: 'rollover_season', method: 'POST', path: '/seasons/:id/rollover', tag: TAG, status: 201,
  summary: 'Prepare the next season from a finished one in one step: a new draft season (its own canonical event), the same divisions and conferences (new rows, parents kept), the final rule version carried forward and, optionally, the accepted teams invited into the same divisions for their managers to accept. Fixtures, results, adjustments and play-off stages are never copied, teams that already have a season-end movement proposal are left to that decision, and the source season is untouched.',
  input: z.object({
    id, label: txt(60), starts_on: day, ends_on: day, registration_opens_on: day.optional(), registration_closes_on: day.optional(), transfer_opens_on: day.optional(), transfer_closes_on: day.optional(),
    copy_divisions: z.boolean().default(true), invite_teams: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s, cm } = await manageSeason(c, user, i.id, { lock: true, open: false });
      if (!CLOSED.has(s.status)) throw conflict('Complete the season before rolling it over', { code: 'not_completed' });
      if (cm.status === 'archived') throw conflict('This competition is archived');
      if (i.ends_on < i.starts_on) throw badRequest('The season must end on or after it starts');
      if (i.invite_teams && !i.copy_divisions) throw badRequest('Teams are invited into the copied divisions: turn copy_divisions on');
      const rv = await currentRules(c, s.id);
      const next = await createSeasonRow(c, user, cm, { ...i, rules: rv.rules, copy_rules_from_previous: false });
      const map = new Map();
      if (i.copy_divisions) {
        const divs = (await c.query("SELECT * FROM comp_divisions WHERE season_id=$1 AND archived_at IS NULL AND kind<>'playoff' ORDER BY (parent_id IS NOT NULL), tier, name", [s.id])).rows;
        for (const d of divs) {
          const nd = (await c.query('INSERT INTO comp_divisions(season_id,name,kind,tier,parent_id,capacity,gender,min_age,max_age,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
            [next.id, d.name, d.kind, d.tier, d.parent_id ? map.get(d.parent_id) ?? null : null, d.capacity, d.gender, d.min_age, d.max_age, user.id])).rows[0];
          map.set(d.id, nd.id);
        }
      }
      let invited = 0, left = 0;
      if (i.invite_teams) {
        const teams = (await c.query(
          `SELECT m.team_id, m.division_id, t.owner_id, t.name FROM comp_memberships m JOIN teams t ON t.id=m.team_id
            WHERE m.season_id=$1 AND m.status='accepted' AND m.division_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM comp_movements mv WHERE mv.season_id=m.season_id AND mv.team_id=m.team_id AND mv.status IN ('proposed','confirmed') AND mv.kind IN ('promotion','relegation'))`, [s.id])).rows;
        for (const t of teams) {
          if (!map.has(t.division_id)) { left++; continue; }
          const mem = (await c.query("INSERT INTO comp_memberships(season_id,division_id,team_id,status,created_by) VALUES ($1,$2,$3,'invited',$4) RETURNING *", [next.id, map.get(t.division_id), t.team_id, user.id])).rows[0];
          await logMembership(c, mem, 'invited', user.id, { reason: `Carried over from ${s.label}` });
          await notify(c, t.owner_id, { kind: 'competition_invitation', title: `${t.name} is invited to ${next.label}`, body: 'Accept the place in the competition.', data: { season_id: next.id, membership_id: mem.id } });
          invited++;
        }
      }
      await audit(c, user.id, 'competition.season_rollover', 'competition_season', next.id);
      return { season: next, rolled_from: s.id, divisions: map.size, teams_invited: invited, teams_left_to_movements: (await c.query("SELECT count(*)::int AS n FROM comp_movements WHERE season_id=$1 AND status IN ('proposed','confirmed') AND kind IN ('promotion','relegation')", [s.id])).rows[0].n, teams_without_division: left };
    });
  },
});

