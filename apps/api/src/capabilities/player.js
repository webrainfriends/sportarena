import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { csvToObjects } from '../csv.js';

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

cap({
  name: 'list_my_sport_profiles', method: 'GET', path: '/me/sport-profiles', tag: 'Player',
  summary: 'Your sport profiles as dashboard cards — the default profile is always first. Each card carries match summary, totals per metric and recent form.',
  async handler({ user }) {
    const [profiles, sums, metrics, form] = await Promise.all([
      many(`SELECT ${PROFILE_COLS} FROM sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 ${PROFILE_ORDER}`, [user.id]),
      many(`SELECT sport_profile_id, count(*)::int AS matches,
                   count(*) FILTER (WHERE result='win')::int AS wins, count(*) FILTER (WHERE result='draw')::int AS draws, count(*) FILTER (WHERE result='loss')::int AS losses,
                   round(avg(rating),1) AS avg_rating, coalesce(sum(minutes),0)::int AS minutes, to_char(max(played_on),'YYYY-MM-DD') AS last_played
              FROM player_matches WHERE user_id=$1 GROUP BY sport_profile_id`, [user.id]),
      many(`SELECT m.sport_profile_id, e.key AS metric, sum(e.value::numeric) AS total, max(e.value::numeric) AS best, count(*)::int AS matches
              FROM player_matches m, jsonb_each_text(m.stats) e WHERE m.user_id=$1 GROUP BY m.sport_profile_id, e.key ORDER BY sum(e.value::numeric) DESC, e.key`, [user.id]),
      many(`SELECT sport_profile_id, array_agg(result ORDER BY played_on DESC, created_at DESC) AS form
              FROM (SELECT sport_profile_id, result, played_on, created_at, row_number() OVER (PARTITION BY sport_profile_id ORDER BY played_on DESC, created_at DESC) AS rn
                      FROM player_matches WHERE user_id=$1) x WHERE rn <= 5 GROUP BY sport_profile_id`, [user.id]),
    ]);
    const empty = { matches: 0, wins: 0, draws: 0, losses: 0, avg_rating: null, minutes: 0, last_played: null };
    return profiles.map((p) => {
      const { sport_profile_id, ...summary } = sums.find((x) => x.sport_profile_id === p.id) ?? empty;
      return {
        ...p,
        summary,
        metrics: metrics.filter((m) => m.sport_profile_id === p.id).map(({ sport_profile_id: _, ...m }) => m),
        form: form.find((f) => f.sport_profile_id === p.id)?.form ?? [],
      };
    });
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
  summary: 'Remove a sport profile and the match history logged under it. If it was the default, your oldest remaining profile takes over.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const p = await ownProfile(user.id, i.id, c);
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

const MATCH_COLS = `m.id, m.sport_profile_id, to_char(m.played_on,'YYYY-MM-DD') AS played_on, m.opponent, m.venue, m.competition, m.result,
  m.score_for, m.score_against, m.minutes, m.rating, m.notes, m.stats, m.source, m.created_at`;
const COLS = ['user_id', 'sport_profile_id', 'played_on', 'opponent', 'venue', 'competition', 'result', 'score_for', 'score_against', 'minutes', 'rating', 'notes', 'stats', 'source'];
const rowParams = (userId, profileId, m, source) => [userId, profileId, m.played_on, m.opponent ?? null, m.venue ?? null, m.competition ?? null, m.result ?? null, m.score_for ?? null, m.score_against ?? null, m.minutes ?? null, m.rating ?? null, m.notes ?? null, JSON.stringify(m.stats), source];

cap({
  name: 'record_match', method: 'POST', path: '/me/matches', tag: 'Player', status: 201,
  summary: 'Log one match under a sport profile. `stats` holds sport-specific numbers (goals, assists, runs, wickets, …).',
  input: z.object({
    sport_profile_id: id, played_on: z.string().date(), opponent: z.string().max(80).optional(), venue: z.string().max(80).optional(), competition: z.string().max(80).optional(),
    result: z.enum(['win', 'draw', 'loss']).optional(), score_for: z.number().optional(), score_against: z.number().optional(),
    minutes: z.number().int().min(0).max(1000).optional(), rating: z.number().min(0).max(10).optional(), notes: z.string().max(500).optional(),
    stats: z.record(z.string(), z.number()).default({}),
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
  name: 'list_my_matches', method: 'GET', path: '/me/matches', tag: 'Player', summary: 'Your match log, newest first; filter by sport profile.',
  input: z.object({ sport_profile_id: id.optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${MATCH_COLS} FROM player_matches m WHERE m.user_id=$1 AND ($2::uuid IS NULL OR m.sport_profile_id=$2) ORDER BY m.played_on DESC, m.created_at DESC LIMIT $3 OFFSET $4`,
    [user.id, i.sport_profile_id ?? null, i.limit, i.offset]),
});

cap({
  name: 'delete_match', method: 'DELETE', path: '/me/matches/:id', tag: 'Player', summary: 'Delete one logged match.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await query('DELETE FROM player_matches WHERE id=$1 AND user_id=$2', [i.id, user.id]);
    if (!r.rowCount) throw notFound('Match');
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
    const have = new Set((await many("SELECT to_char(played_on,'YYYY-MM-DD') AS played_on, opponent, competition FROM player_matches WHERE sport_profile_id=$1", [i.sport_profile_id])).map((m) => key({ ...m, opponent: m.opponent ?? undefined, competition: m.competition ?? undefined })));
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
