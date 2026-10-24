import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { newOpaqueToken, sha256 } from '../crypto.js';
import { PUBLIC_USER } from '../helpers.js';
import { isYouth } from '../youth.js';
import { ACTIVITIES_CTE } from '../athlete-history.js';
import { config } from '../config.js';
import { profileCredentials } from '../education.js';

const TAG = 'Passport';

// The passport is a read-only athlete CV built from existing records at read time: sport cards, match counts per season (with how much is
// official vs self-reported), approved competition results and awards. It carries no personal identification data (no email, phone, date
// of birth, address, notes or health data), and what is shown is chosen by the athlete when they create each link.
export async function buildPassport(userId, scope = { show_matches: true, show_results: true, show_awards: true, show_credentials: true }) {
  const u = await one(`SELECT ${PUBLIC_USER.replace('u.roles, ', '')} FROM users u WHERE u.id=$1`, [userId]);
  const [profiles, activity, results, awards, credentials] = await Promise.all([
    many(`SELECT s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, p.role, p.level, p.position, p.jersey_no, p.club, p.experience_years, p.is_default
            FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 ORDER BY p.is_default DESC, p.created_at, p.id`, [userId]),
    scope.show_matches ? many(
      `${ACTIVITIES_CTE}
       SELECT extract(year FROM a.played_on)::int AS season, s.slug AS sport_slug, count(*)::int AS matches,
              count(*) FILTER (WHERE a.result='win')::int AS wins, count(*) FILTER (WHERE a.result='draw')::int AS draws, count(*) FILTER (WHERE a.result='loss')::int AS losses,
              count(*) FILTER (WHERE a.is_official)::int AS official_matches
         FROM acts a JOIN sports s ON s.id=a.sport_id GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [userId]) : [],
    scope.show_results ? many(
      `SELECT s.slug AS sport_slug, s.name AS sport, p.metric, p.unit, coalesce(p.direction,'higher') AS direction, count(*)::int AS results,
              (CASE WHEN bool_or(p.direction='lower') THEN min(p.value) ELSE max(p.value) END)::float8 AS best
         FROM performances p JOIN sports s ON s.id=p.sport_id
        WHERE p.user_id=$1 AND p.provenance='approved_competition' AND p.status='approved'
        GROUP BY s.slug, s.name, p.metric, p.unit, coalesce(p.direction,'higher') ORDER BY s.slug, p.metric`, [userId]) : [],
    scope.show_awards ? many(
      `SELECT a.kind, a.name, e.name AS event_name, extract(year FROM a.awarded_at)::int AS year
         FROM awards a LEFT JOIN events e ON e.id=a.event_id WHERE a.user_id=$1 ORDER BY a.awarded_at DESC LIMIT 100`, [userId]) : [],
    scope.show_credentials ? profileCredentials(userId) : [],
  ]);
  // career totals per sport, derived from the same season rows
  const career = new Map();
  for (const r of activity) {
    const c = career.get(r.sport_slug) ?? { sport_slug: r.sport_slug, matches: 0, wins: 0, draws: 0, losses: 0, official_matches: 0 };
    for (const k of ['matches', 'wins', 'draws', 'losses', 'official_matches']) c[k] += r[k];
    career.set(r.sport_slug, c);
  }
  return {
    athlete: u, sport_profiles: profiles,
    career: scope.show_matches ? [...career.values()] : null, seasons: scope.show_matches ? activity : null,
    verified_results: scope.show_results ? results : null, awards: scope.show_awards ? awards : null, credentials: scope.show_credentials ? credentials : null,
    evidence: 'Match counts mix official games with matches the athlete logged themselves (see official_matches). Results listed are approved competition results only.',
    generated_at: new Date().toISOString(),
  };
}

const scopeOf = (l) => ({ show_matches: l.show_matches, show_results: l.show_results, show_awards: l.show_awards, show_credentials: l.show_credentials });

cap({
  name: 'create_passport_link', method: 'POST', path: '/me/passport-links', tag: TAG, status: 201,
  summary: 'Create a share link to your player passport for a coach or scout. You choose what it shows (match history by season, approved results, awards, certificates and badges) and when it expires (up to 90 days). The secret is shown once; put it in a QR code. Not available to young people.',
  input: z.object({ label: z.string().trim().max(60).optional(), expires_in_days: z.number().int().min(1).max(90).default(30), show_matches: z.boolean().default(true), show_results: z.boolean().default(true), show_awards: z.boolean().default(true), show_credentials: z.boolean().default(true) }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw forbidden('A parent or guardian needs to arrange sharing for you');
    const token = newOpaqueToken();
    const row = await one(
      `INSERT INTO passport_links(user_id, token_hash, label, show_matches, show_results, show_awards, show_credentials, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + $8 * interval '1 day')
       RETURNING id, label, show_matches, show_results, show_awards, show_credentials, expires_at, created_at`,
      [user.id, sha256(token), i.label || null, i.show_matches, i.show_results, i.show_awards, i.show_credentials, i.expires_in_days]);
    const path = `/?passport=${encodeURIComponent(token)}`;
    return { ...row, token, path, url: config.appUrl ? `${String(config.appUrl).replace(/\/$/, '')}${path}` : null };
  },
});

cap({
  name: 'list_passport_links', method: 'GET', path: '/me/passport-links', tag: TAG,
  summary: 'Your passport share links, newest first, with what each shows, how often it was opened and whether it is active, expired or revoked. The secret is never shown again.',
  handler: ({ user }) => many(
    `SELECT id, label, show_matches, show_results, show_awards, show_credentials, expires_at, revoked_at, view_count, last_viewed_at, created_at,
            CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS status
       FROM passport_links WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [user.id]),
});

cap({
  name: 'revoke_passport_link', method: 'POST', path: '/me/passport-links/:id/revoke', tag: TAG,
  summary: 'Turn a passport link off immediately. The record stays so you can see it was shared.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('UPDATE passport_links SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id, revoked_at', [i.id, user.id]);
    if (!row) throw notFound('Passport link');
    return row;
  },
});

cap({
  name: 'get_my_passport', method: 'GET', path: '/me/passport', tag: TAG,
  summary: 'Preview your own player passport exactly as a link would show it (everything on).',
  handler: ({ user }) => buildPassport(user.id),
});

cap({
  name: 'get_passport', method: 'GET', path: '/passport/:token', tag: TAG, auth: 'public',
  summary: 'Open a player passport from a share link. Anyone holding a valid, unexpired, unrevoked link can read it; it contains no personal identification data. Each open is counted, nothing about the viewer is stored.',
  input: z.object({ token: z.string().min(10).max(200) }),
  async handler(_, i) {
    const link = await one('UPDATE passport_links SET view_count=view_count+1, last_viewed_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id, show_matches, show_results, show_awards, show_credentials, expires_at', [sha256(i.token)]);
    // a wrong, expired or revoked link all look the same
    if (!link) throw notFound('Passport link');
    return { ...(await buildPassport(link.user_id, scopeOf(link))), expires_at: link.expires_at };
  },
});
