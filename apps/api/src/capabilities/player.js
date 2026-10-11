import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { csvToObjects } from '../csv.js';
import { ACTIVITIES_CTE, ACTIVITY_COLS } from '../athlete-history.js';
import { matchTemplate, matchTypesFor } from '../match-template.js';
import { sportBySlugOrId } from '../helpers.js';

// ---------- sport profiles (the player's "cards") ----------

const PROFILE_COLS = `p.id, p.role, p.level, p.position, p.jersey_no, p.club, p.experience_years, p.hourly_rate_cents, p.is_default,
  s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji`;
/** Default profile first, then oldest first. */
const PROFILE_ORDER = 'ORDER BY p.is_default DESC, p.created_at, p.id';

const profileFields = {
  level: z.enum(['beginner', 'amateur', 'semi_pro', 'pro']),
  position: z.string().max(60),
  jersey_no: z.coerce.number().int().min(0).max(999),
  club: z.string().max(80),
  experience_years: z.coerce.number().int().min(0).max(80),
  hourly_rate_cents: z.coerce.number().int().min(0).describe('coaches/physios/doctors: price per hour in minor units'),
  license_no: z.string().max(60).describe('encrypted at rest'),
};

async function ownProfile(userId, profileId, client) {
  const row = (await (client ?? { query }).query('SELECT * FROM sport_profiles WHERE id=$1 AND user_id=$2', [profileId, userId])).rows[0];
  if (!row) throw notFound('Sport profile');
  return row;
}

const EMPTY = { matches: 0, wins: 0, draws: 0, losses: 0, avg_rating: null, minutes: 0, last_played: null };
/** Fold grouped rows (one per official/self side) into the card summary shape. */
function foldSummary(rows) {
  if (!rows.length) return { ...EMPTY };
  const sum = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const rated = sum('rated');
  return {
    matches: sum('matches'), wins: sum('wins'), draws: sum('draws'), losses: sum('losses'),
    avg_rating: rated ? Math.round((rows.reduce((t, r) => t + Number(r.rating_sum ?? 0), 0) / rated) * 10) / 10 : null,
    minutes: sum('minutes'), last_played: rows.map((r) => r.last_played).sort().pop() ?? null,
  };
}
function foldMetrics(rows) {
  const by = new Map();
  for (const r of rows) {
    const m = by.get(r.metric) ?? { metric: r.metric, total: 0, best: -Infinity, matches: 0 };
    m.total += Number(r.total); m.best = Math.max(m.best, Number(r.best)); m.matches += r.matches;
    by.set(r.metric, m);
  }
  return [...by.values()].sort((x, y) => y.total - x.total || (x.metric < y.metric ? -1 : 1));
}

cap({
  name: 'list_my_sport_profiles', method: 'GET', path: '/me/sport-profiles', tag: 'Player',
  summary: 'Your sport profiles as dashboard cards — the default profile is always first. Each card carries the match summary over your whole history (what you logged plus official SportArena games/fixtures you played — counted once), `official_summary` (official only), `self_summary` (logged/imported only), totals per metric and recent form.',
  async handler({ user }) {
    const [profiles, sums, metrics, form] = await Promise.all([
      many(`SELECT ${PROFILE_COLS} FROM sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 ${PROFILE_ORDER}`, [user.id]),
      many(`${ACTIVITIES_CTE}
            SELECT sport_profile_id, is_official, count(*)::int AS matches,
                   count(*) FILTER (WHERE result='win')::int AS wins, count(*) FILTER (WHERE result='draw')::int AS draws, count(*) FILTER (WHERE result='loss')::int AS losses,
                   count(rating)::int AS rated, coalesce(sum(rating),0) AS rating_sum, coalesce(sum(minutes),0)::int AS minutes, to_char(max(played_on),'YYYY-MM-DD') AS last_played
              FROM acts WHERE sport_profile_id IS NOT NULL GROUP BY sport_profile_id, is_official`, [user.id]),
      many(`${ACTIVITIES_CTE}
            SELECT a.sport_profile_id, a.is_official, e.key AS metric, sum(e.value::numeric) AS total, max(e.value::numeric) AS best, count(*)::int AS matches
              FROM acts a, jsonb_each_text(a.stats) e WHERE a.sport_profile_id IS NOT NULL GROUP BY a.sport_profile_id, a.is_official, e.key`, [user.id]),
      many(`${ACTIVITIES_CTE}
            SELECT sport_profile_id, array_agg(result ORDER BY played_at DESC, activity_id) AS form
              FROM (SELECT sport_profile_id, result, played_at, activity_id, row_number() OVER (PARTITION BY sport_profile_id ORDER BY played_at DESC, activity_id) AS rn
                      FROM acts WHERE sport_profile_id IS NOT NULL) x WHERE rn <= 5 GROUP BY sport_profile_id`, [user.id]),
    ]);
    return profiles.map((p) => {
      const mine = sums.filter((x) => x.sport_profile_id === p.id);
      const mm = metrics.filter((m) => m.sport_profile_id === p.id);
      return {
        ...p,
        summary: foldSummary(mine),
        official_summary: foldSummary(mine.filter((x) => x.is_official)),
        self_summary: foldSummary(mine.filter((x) => !x.is_official)),
        metrics: foldMetrics(mm),
        official_metrics: foldMetrics(mm.filter((m) => m.is_official)),
        form: form.find((f) => f.sport_profile_id === p.id)?.form ?? [],
      };
    });
  },
});

cap({
  name: 'list_my_detected_sports', method: 'GET', path: '/me/detected-sports', tag: 'Player',
  summary: 'Sports where SportArena officially knows you played (finished games, fixtures you were confirmed in) but you have no athlete sport profile yet. Nothing about level/club/position is invented — add the sport and this history appears on its card at once.',
  async handler({ user }) {
    return many(`${ACTIVITIES_CTE}
      SELECT s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, count(*)::int AS matches,
             count(*) FILTER (WHERE a.result='win')::int AS wins, count(*) FILTER (WHERE a.result='draw')::int AS draws, count(*) FILTER (WHERE a.result='loss')::int AS losses,
             to_char(max(a.played_on),'YYYY-MM-DD') AS last_played
        FROM acts a JOIN sports s ON s.id=a.sport_id
       WHERE a.is_official AND a.sport_profile_id IS NULL GROUP BY s.id ORDER BY max(a.played_at) DESC, s.slug`, [user.id]);
  },
});

cap({
  name: 'update_sport_profile', method: 'PATCH', path: '/me/sport-profiles/:id', tag: 'Player',
  summary: 'Edit one of your sport profiles (level, position, jersey, club, experience, licence number).',
  input: z.object({ id, ...Object.fromEntries(Object.entries(profileFields).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    await ownProfile(user.id, i.id);
    const { id: pid, license_no, ...rest } = i;
    const sets = { ...rest };
    if (license_no !== undefined) sets.license_no_enc = encrypt(license_no, 'sport_profiles.license_no');
    const keys = Object.keys(sets).filter((k) => sets[k] !== undefined);
    if (!keys.length) throw badRequest('Nothing to update');
    await query(`UPDATE sport_profiles SET ${keys.map((k, n) => `${k} = $${n + 3}`).join(', ')} WHERE id=$1 AND user_id=$2`, [pid, user.id, ...keys.map((k) => sets[k])]);
    return { ok: true };
  },
});

cap({
  name: 'set_default_sport_profile', method: 'POST', path: '/me/sport-profiles/:id/default', tag: 'Player',
  summary: 'Make this sport profile your default; it is always listed first.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      await ownProfile(user.id, i.id, c);
      await c.query('UPDATE sport_profiles SET is_default=false WHERE user_id=$1 AND is_default', [user.id]);
      await c.query('UPDATE sport_profiles SET is_default=true WHERE id=$1', [i.id]);
    });
    return { ok: true };
  },
});

cap({
  name: 'delete_sport_profile', method: 'DELETE', path: '/me/sport-profiles/:id', tag: 'Player',
  summary: 'Remove a sport profile and the matches you logged under it. Official games/fixtures are never removed — they stay on your history and reappear if you add the sport again. If it was the default, your oldest remaining profile takes over.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const p = await ownProfile(user.id, i.id, c);
      await c.query('UPDATE player_match_links SET removed_at=now() WHERE removed_at IS NULL AND player_match_id IN (SELECT id FROM player_matches WHERE sport_profile_id=$1)', [i.id]);
      await c.query('DELETE FROM sport_profiles WHERE id=$1', [i.id]);
      if (p.is_default) await c.query('UPDATE sport_profiles SET is_default=true WHERE id = (SELECT id FROM sport_profiles WHERE user_id=$1 ORDER BY created_at, id LIMIT 1)', [user.id]);
    });
    return { ok: true };
  },
});

// ---------- match performance ----------

const num = z.preprocess((v) => (v === null || v === '' ? undefined : v), z.coerce.number().finite().optional());
const text = (max) => z.preprocess((v) => (v === null || v === '' ? undefined : v), z.string().max(max).optional());
const metricKey = /^[a-z][a-z0-9_]{0,39}$/;

const matchCore = z.object({
  played_on: z.string().date().describe('YYYY-MM-DD'),
  opponent: text(80), venue: text(80), competition: text(80),
  result: z.preprocess((v) => (typeof v === 'string' ? ({ w: 'win', won: 'win', d: 'draw', drawn: 'draw', tie: 'draw', l: 'loss', lost: 'loss', lose: 'loss' }[v.trim().toLowerCase()] ?? v.trim().toLowerCase()) : v), z.enum(['win', 'draw', 'loss']).optional()),
  score_for: num, score_against: num,
  minutes: z.preprocess((v) => (v === null || v === '' ? undefined : v), z.coerce.number().int().min(0).max(1000).optional()),
  rating: num.pipe(z.number().min(0).max(10).optional()),
  notes: text(500),
  match_type: text(30),
});
const CORE_KEYS = Object.keys(matchCore.shape);

/** Validate one raw match (API body or CSV row). Unknown numeric keys become sport stats. Returns {value} or {errors}. */
function normaliseMatch(raw) {
  const core = Object.fromEntries(CORE_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  const parsed = matchCore.safeParse(core);
  const errors = parsed.success ? [] : parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`);
  const stats = {};
  const extra = raw.stats && typeof raw.stats === 'object' ? raw.stats : Object.fromEntries(Object.entries(raw).filter(([k]) => !CORE_KEYS.includes(k) && k !== 'stats'));
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!metricKey.test(k)) errors.push(`${k}: stat names are lower-case letters, digits and _ (max 40)`);
    else if (!Number.isFinite(n)) errors.push(`${k}: must be a number`);
    else stats[k] = n;
  }
  if (Object.keys(stats).length > 30) errors.push('stats: at most 30 per match');
  if (errors.length) return { errors };
  const m = parsed.data;
  // infer the result from the score when it isn't given
  if (!m.result && m.score_for !== undefined && m.score_against !== undefined) m.result = m.score_for > m.score_against ? 'win' : m.score_for < m.score_against ? 'loss' : 'draw';
  return { value: { ...m, stats } };
}

const COLS = ['user_id', 'sport_profile_id', 'played_on', 'opponent', 'venue', 'competition', 'result', 'score_for', 'score_against', 'minutes', 'rating', 'notes', 'stats', 'source', 'match_type'];
const rowParams = (userId, profileId, m, source) => [userId, profileId, m.played_on, m.opponent ?? null, m.venue ?? null, m.competition ?? null, m.result ?? null, m.score_for ?? null, m.score_against ?? null, m.minutes ?? null, m.rating ?? null, m.notes ?? null, JSON.stringify(m.stats), source, m.match_type ?? null];

cap({
  name: 'record_match', method: 'POST', path: '/me/matches', tag: 'Player', status: 201,
  summary: 'Log one match under a sport profile. `stats` holds the numbers of the columns from get_match_template for that sport and match type (e.g. smashes for badminton, runs for cricket).',
  input: z.object({
    sport_profile_id: id, played_on: z.string().date(), opponent: z.string().max(80).optional(), venue: z.string().max(80).optional(), competition: z.string().max(80).optional(),
    result: z.enum(['win', 'draw', 'loss']).optional(), score_for: z.number().optional(), score_against: z.number().optional(),
    minutes: z.number().int().min(0).max(1000).optional(), rating: z.number().min(0).max(10).optional(), notes: z.string().max(500).optional(),
    stats: z.record(z.string(), z.number()).default({}),
    match_type: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/).optional().describe('singles, doubles, t20 … — see get_match_template'),
  }),
  async handler({ user }, i) {
    await ownProfile(user.id, i.sport_profile_id);
    const { sport_profile_id, ...raw } = i;
    const r = normaliseMatch(raw);
    if (r.errors) throw badRequest('Invalid match', r.errors);
    const ph = COLS.map((_, n) => `$${n + 1}`).join(',');
    return one(`INSERT INTO player_matches(${COLS.join(',')}) VALUES (${ph}) RETURNING id`, rowParams(user.id, sport_profile_id, r.value, 'manual'));
  },
});

cap({
  name: 'get_match_template', method: 'GET', path: '/sports/:sport/match-template', tag: 'Player',
  summary: 'The columns to fill in when logging a match of this sport and match type (e.g. badminton singles vs doubles): built from the IPTC Sport Schema statistics and the Olympic / Asian Games programmes, tailored by AI when it is configured and otherwise built in. Also lists the sport\'s match types and how to label the two scores (games won, goals for…). Use the returned keys in `stats`.',
  input: z.object({ sport: z.string().max(60), match_type: z.string().max(30).optional() }),
  async handler(_, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (i.match_type && !matchTypesFor(sport).includes(i.match_type)) throw badRequest(`Unknown match type for ${sport.name}. Choose one of: ${matchTypesFor(sport).join(', ')}`);
    return matchTemplate(sport, i.match_type);
  },
});

cap({
  name: 'list_my_matches', method: 'GET', path: '/me/matches', tag: 'Player',
  summary: 'Your unified match history, newest first: matches you logged or imported plus official SportArena games/fixtures you played, each once and tagged with `provenance` (manual | imported | official_game | official_fixture) and `verification`. Official rows have a source reference (game_id / fixture_id / event_id), cannot be deleted here, and carry your private rating/notes if you added any. Without sport_profile_id, official sports you have no profile for are included too (sport_profile_id null).',
  input: z.object({
    sport_profile_id: id.optional(), sport: z.string().max(60).optional().describe('sport slug'),
    source: z.enum(['all', 'self', 'official']).default('all'),
    verification: z.enum(['self_reported', 'imported', 'official']).optional(),
    from: z.string().date().optional(), to: z.string().date().optional(), competition_id: id.optional(), ...page,
  }),
  handler: ({ user }, i) => many(
    `${ACTIVITIES_CTE}
     SELECT ${ACTIVITY_COLS}, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji
       FROM acts a JOIN sports s ON s.id = a.sport_id
      WHERE ($2::uuid IS NULL OR a.sport_profile_id = $2) AND ($3::text IS NULL OR s.slug = $3)
        AND ($4::text = 'all' OR ($4 = 'official') = a.is_official)
        AND ($5::text IS NULL OR a.verification = $5)
        AND ($6::date IS NULL OR a.played_on >= $6) AND ($7::date IS NULL OR a.played_on <= $7)
        AND ($8::uuid IS NULL OR a.event_id = $8)
      ORDER BY a.played_at DESC, a.activity_id LIMIT $9 OFFSET $10`,
    [user.id, i.sport_profile_id ?? null, i.sport ?? null, i.source, i.verification ?? null, i.from ?? null, i.to ?? null, i.competition_id ?? null, i.limit, i.offset]),
});

cap({
  name: 'delete_match', method: 'DELETE', path: '/me/matches/:id', tag: 'Player', summary: 'Remove one match you logged or imported (it is archived, never erased). Official games/fixtures are not yours to delete — correct them through the game/result or dispute workflow.',
  input: z.object({ id: z.string().max(80) }),
  async handler({ user }, i) {
    if (!id.safeParse(i.id).success) throw forbidden('Official matches cannot be deleted from My Sports — report a wrong result through the dispute flow');
    const r = await query('UPDATE player_matches SET archived_at=now() WHERE id=$1 AND user_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!r.rowCount) throw notFound('Match');
    await query('UPDATE player_match_links SET removed_at=now() WHERE player_match_id=$1 AND removed_at IS NULL', [i.id]);
    return { ok: true };
  },
});

// ---------- reconciling a match you logged with the official record ----------

/** Official activities of this athlete that could be the one they logged by hand (same sport, within a day). Never merged silently. */
async function candidatesFor(userId, m) {
  return many(
    `${ACTIVITIES_CTE}
     SELECT ${ACTIVITY_COLS},
            (lower(coalesce(a.opponent,'')) <> '' AND lower(coalesce(a.opponent,'')) = lower(coalesce($3,''))) AS opponent_matches,
            (a.played_on = $2::date) AS same_day
       FROM acts a
      WHERE a.is_official AND a.linked_match_id IS NULL AND a.sport_id = $4 AND a.played_on BETWEEN $2::date - 1 AND $2::date + 1
      ORDER BY (a.played_on = $2::date) DESC, (lower(coalesce(a.opponent,'')) = lower(coalesce($3,''))) DESC, a.played_at DESC, a.activity_id`,
    [userId, m.played_on, m.opponent, m.sport_id]);
}
async function ownManual(userId, matchId) {
  const m = await one("SELECT m.id, to_char(m.played_on,'YYYY-MM-DD') AS played_on, m.opponent, sp.sport_id FROM player_matches m JOIN sport_profiles sp ON sp.id=m.sport_profile_id WHERE m.id=$1 AND m.user_id=$2 AND m.archived_at IS NULL", [matchId, userId]);
  if (!m) throw notFound('Match');
  return m;
}

cap({
  name: 'list_match_link_candidates', method: 'GET', path: '/me/matches/:id/link-candidates', tag: 'Player',
  summary: 'Official games/fixtures you played in the same sport on (or a day either side of) the date of a match you logged — "possible duplicate: link to official match". Only your own participation is shown.',
  input: z.object({ id }),
  async handler({ user }, i) { return candidatesFor(user.id, await ownManual(user.id, i.id)); },
});

cap({
  name: 'link_match', method: 'POST', path: '/me/matches/:id/link', tag: 'Player',
  summary: 'Confirm that a match you logged is an official game/fixture you played, so it counts once. The official result and stats win; your note and rating stay yours. Idempotent. The official record must be one of your own (same sport) — you cannot link to anyone else\'s game.',
  input: z.object({ id, source_type: z.enum(['game', 'fixture']), source_id: id }),
  async handler({ user }, i) {
    const m = await ownManual(user.id, i.id);
    const ok = await one(`${ACTIVITIES_CTE} SELECT 1 AS ok FROM acts a WHERE a.is_official AND a.source_type=$2 AND a.source_id=$3 AND a.sport_id=$4`, [user.id, i.source_type, i.source_id, m.sport_id]);
    if (!ok) throw badRequest('That official match is not one you played in this sport');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`link:${user.id}`]);
      const have = (await c.query('SELECT source_type, source_id FROM player_match_links WHERE player_match_id=$1 AND removed_at IS NULL', [m.id])).rows[0];
      if (have) {
        if (have.source_type === i.source_type && have.source_id === i.source_id) return { ok: true, linked: true };
        throw conflict('This match is already linked to a different official match — unlink it first');
      }
      const taken = (await c.query('SELECT 1 FROM player_match_links WHERE user_id=$1 AND source_type=$2 AND source_id=$3 AND removed_at IS NULL', [user.id, i.source_type, i.source_id])).rowCount;
      if (taken) throw conflict('That official match is already linked to another match you logged');
      await c.query("INSERT INTO player_match_links(user_id, player_match_id, source_type, source_id, match_method, created_by) VALUES ($1,$2,$3,$4,'user_confirmed',$1)", [user.id, m.id, i.source_type, i.source_id]);
      return { ok: true, linked: true };
    });
  },
});

cap({
  name: 'unlink_match', method: 'POST', path: '/me/matches/:id/unlink', tag: 'Player',
  summary: 'Undo a link you confirmed between a logged match and an official one. The logged match counts again on its own; the official record is untouched.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await ownManual(user.id, i.id);
    await query('UPDATE player_match_links SET removed_at=now() WHERE player_match_id=$1 AND user_id=$2 AND removed_at IS NULL', [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'annotate_official_match', method: 'POST', path: '/me/official-matches/:source_type/:source_id/note', tag: 'Player',
  summary: 'Add your private rating (0-10) and/or notes to an official match you played. Never changes the official result or stats and is never shown by game/event APIs. Send both empty to clear.',
  input: z.object({ source_type: z.enum(['game', 'fixture']), source_id: id, rating: z.number().min(0).max(10).nullable().optional(), notes: z.string().max(500).nullable().optional() }),
  async handler({ user }, i) {
    const mine = await one(`${ACTIVITIES_CTE} SELECT 1 AS ok FROM acts a WHERE a.is_official AND a.source_type=$2 AND a.source_id=$3`, [user.id, i.source_type, i.source_id]);
    if (!mine) throw notFound('Official match');
    if ((i.rating ?? null) === null && !(i.notes ?? '').trim()) {
      await query('DELETE FROM player_match_notes WHERE user_id=$1 AND source_type=$2 AND source_id=$3', [user.id, i.source_type, i.source_id]);
      return { ok: true };
    }
    await query(
      `INSERT INTO player_match_notes(user_id, source_type, source_id, rating, notes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, source_type, source_id) DO UPDATE SET rating=EXCLUDED.rating, notes=EXCLUDED.notes, updated_at=now()`,
      [user.id, i.source_type, i.source_id, i.rating ?? null, (i.notes ?? '').trim() || null]);
    return { ok: true };
  },
});

const MAX_IMPORT_ROWS = 500;
cap({
  name: 'import_matches', method: 'POST', path: '/me/matches/import', tag: 'Player',
  summary: `Bulk-import match performance into a sport profile from CSV text or JSON rows (max ${MAX_IMPORT_ROWS} rows, CSV ≤ 80k chars). CSV header: played_on (required, YYYY-MM-DD), opponent, venue, competition, result (win/draw/loss), score_for, score_against, minutes, rating (0-10), notes — every other column is a numeric sport stat (goals, assists, …). All-or-nothing: any invalid row rejects the file with row-level errors. Use dry_run to preview. Rows already logged (same date, opponent and competition) are skipped.`,
  input: z.object({
    sport_profile_id: id,
    csv: z.string().max(80_000).optional().describe('CSV text with a header row'),
    rows: z.array(z.record(z.string(), z.unknown())).max(MAX_IMPORT_ROWS).optional().describe('same columns as the CSV, as JSON objects'),
    dry_run: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    if (!i.csv === !i.rows) throw badRequest('Provide either csv or rows');
    await ownProfile(user.id, i.sport_profile_id);
    const raws = i.csv ? csvToObjects(i.csv) : i.rows;
    if (!raws.length) throw badRequest('No data rows found');
    if (raws.length > MAX_IMPORT_ROWS) throw badRequest(`At most ${MAX_IMPORT_ROWS} rows per import`);

    const errors = [], valid = [];
    raws.forEach((raw, n) => {
      const r = normaliseMatch(raw);
      if (r.errors) errors.push({ row: n + 1, errors: r.errors }); else valid.push({ row: n + 1, ...r.value });
    });
    const key = (m) => [m.played_on, (m.opponent ?? '').toLowerCase(), (m.competition ?? '').toLowerCase()].join('|');
    const have = new Set((await many("SELECT to_char(played_on,'YYYY-MM-DD') AS played_on, opponent, competition FROM player_matches WHERE sport_profile_id=$1 AND archived_at IS NULL", [i.sport_profile_id])).map((m) => key({ ...m, opponent: m.opponent ?? undefined, competition: m.competition ?? undefined })));
    const fresh = [], skipped = [];
    for (const m of valid) {
      if (have.has(key(m))) skipped.push(m.row); else { have.add(key(m)); fresh.push(m); }
    }
    const preview = fresh.slice(0, 5).map(({ row, ...m }) => ({ row, ...m }));
    if (i.dry_run) return { dry_run: true, rows: raws.length, importable: fresh.length, skipped: skipped.length, errors, preview };
    if (errors.length) throw badRequest(`${errors.length} of ${raws.length} rows are invalid — nothing was imported`, errors);
    if (fresh.length) {
      await tx(async (c) => {
        const per = COLS.length;
        const values = fresh.map((_, n) => `(${COLS.map((__, k) => `$${n * per + k + 1}`).join(',')})`).join(',');
        await c.query(`INSERT INTO player_matches(${COLS.join(',')}) VALUES ${values}`, fresh.flatMap((m) => rowParams(user.id, i.sport_profile_id, m, 'import')));
      });
    }
    return { dry_run: false, rows: raws.length, imported: fresh.length, skipped: skipped.length };
  },
});
