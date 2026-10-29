// DB side of stages: write a planned stage (fixtures, ties, feeds, court bookings), keep the audit trail, retire fixtures on a governed redraw.
import { reserve } from '../capabilities/venues.js';
import { conflict } from '../errors.js';
import { isStarted } from './advance.js';

export const snapshotOf = (items) => items.map((x) => ({ key: x.key, round: x.round, home: x.home_team_id ?? x.home_placeholder ?? null, away: x.away_team_id ?? x.away_placeholder ?? null, scheduled_at: x.scheduled_at ?? null }));

/** Append to a stage's audit trail; versions count up from 1. */
export async function recordRevision(c, stageId, kind, { reason = null, actor = null, algorithm = null, inputs = {}, snapshot = {} } = {}) {
  const v = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM bracket_revisions WHERE stage_id=$1', [stageId])).rows[0].v;
  return (await c.query('INSERT INTO bracket_revisions(stage_id, version, kind, reason, actor_id, algorithm, inputs, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [stageId, v, kind, reason, actor, algorithm, JSON.stringify(inputs), JSON.stringify(snapshot)])).rows[0];
}

/**
 * Create the fixtures (and ties) of planned items that were all placed on the calendar, reserving each court slot.
 * items: plan items with scheduled_at / ends_at / resource_id / duration_min. Returns Map key -> fixture id.
 */
export async function writeItems(c, user, ev, stage, items) {
  const ids = new Map(), tieIds = new Map();
  for (const it of items) {
    await reserve(c, { resource_id: it.resource_id, user_id: user.id, event_id: ev.id, starts_at: it.scheduled_at, ends_at: it.ends_at, note: `${it.round}` });
    let tieId = null;
    if (it.tie || it.leg_no) {
      const key = it.tie.key;
      if (!tieIds.has(key)) {
        const a = it.leg_swap ? it.away_team_id : it.home_team_id, b = it.leg_swap ? it.home_team_id : it.away_team_id;
        tieIds.set(key, (await c.query('INSERT INTO bracket_ties(stage_id, key, kind, config, a_team_id, b_team_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [stage.id, key, it.tie.kind, JSON.stringify({ ...it.tie.config, label: it.tie.label }), a, b])).rows[0].id);
      }
      tieId = tieIds.get(key);
    }
    const dur = Math.min(600, Math.max(10, it.duration_min));
    const fx = (await c.query(
      `INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, resource_id, scheduled_at, duration_min, stage_id, round_kind, bracket_slot, home_placeholder, away_placeholder,
                            bracket_side, round_no, pool, tie_id, leg_no, leg_swap, conditional, winner_optional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [ev.id, it.round, it.home_team_id, it.away_team_id, it.resource_id, it.scheduled_at, dur, stage.id, it.round_kind, it.slot, it.home_placeholder, it.away_placeholder,
        it.bracket_side ?? null, it.round_no ?? null, it.pool ?? null, tieId, it.leg_no ?? null, !!it.leg_swap, it.conditional ? JSON.stringify(it.conditional) : null, !!it.winner_optional])).rows[0];
    ids.set(it.key, fx.id);
  }
  for (const it of items) {
    if (it.tie?.key && it.tie.win_feeds !== undefined) {
      await c.query('UPDATE bracket_ties SET win_feeds_fixture_id=$2, win_feeds_side=$3, lose_feeds_fixture_id=$4, lose_feeds_side=$5 WHERE id=$1',
        [tieIds.get(it.tie.key), it.tie.win_feeds ? ids.get(it.tie.win_feeds.key) : null, it.tie.win_feeds?.side ?? null, it.tie.lose_feeds ? ids.get(it.tie.lose_feeds.key) : null, it.tie.lose_feeds?.side ?? null]);
    }
    if (!it.win_feeds && !it.lose_feeds) continue;
    await c.query('UPDATE fixtures SET win_feeds_fixture_id=$2, win_feeds_side=$3, lose_feeds_fixture_id=$4, lose_feeds_side=$5 WHERE id=$1',
      [ids.get(it.key), it.win_feeds ? ids.get(it.win_feeds.key) : null, it.win_feeds?.side ?? null, it.lose_feeds ? ids.get(it.lose_feeds.key) : null, it.lose_feeds?.side ?? null]);
  }
  return ids;
}

/** Fixtures of a stage that count (not cancelled). */
export const liveFixtures = async (c, stageId) => (await c.query("SELECT * FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled' ORDER BY scheduled_at, bracket_slot", [stageId])).rows;

/** A redraw may only retire games nobody has started: nothing played is ever replaced silently. */
export async function retireUnstarted(c, stageId, reason, { roundNo = null } = {}) {
  const rows = (await c.query("SELECT * FROM fixtures WHERE stage_id=$1 AND status <> 'cancelled' AND ($2::int IS NULL OR round_no=$2) FOR UPDATE", [stageId, roundNo])).rows;
  const started = rows.filter(isStarted);
  if (started.length) throw conflict(`${started.length} game(s) have already started or been played; a redraw would replace them. Resolve them first (corrections keep history)`, { started: started.map((f) => f.id) });
  for (const f of rows) {
    await c.query("UPDATE fixtures SET status='cancelled', void_reason=$2 WHERE id=$1", [f.id, reason]);
    if (f.resource_id) await c.query(`UPDATE bookings SET status='cancelled' WHERE id=(SELECT id FROM bookings WHERE event_id=$1 AND resource_id=$2 AND starts_at=$3 AND source='fixture' AND status='confirmed' LIMIT 1)`, [f.event_id, f.resource_id, f.scheduled_at]);
  }
  if (roundNo == null) await c.query("UPDATE bracket_ties SET key = key || '@retired:' || id::text WHERE stage_id=$1", [stageId]);
  return rows.length;
}
