import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { newOpaqueToken, sha256 } from '../crypto.js';
import { PUBLIC_USER } from '../helpers.js';
import { guardianLink, isYouth, requireConsent } from '../youth.js';
import { ACTIVITIES_CTE } from '../athlete-history.js';
import { config } from '../config.js';
import { profileCredentials } from '../education.js';
import { FULL_SCOPE, SECTION_FLAGS, openLink, recruitmentSections, scopeOf } from '../passport-sections.js';
import { publicCareer } from '../career.js';

const TAG = 'Passport';

// The passport is a read-only athlete CV built from existing records at read time: sport cards, match counts per season (with how much is
// official vs self-reported), approved competition results and awards. It carries no personal identification data (no email, phone, date
// of birth, address, notes or health data), and what is shown is chosen by the athlete when they create each link.
export async function buildPassport(userId, scope = FULL_SCOPE, ctx = {}) {
  const u = await one(`SELECT ${PUBLIC_USER.replace('u.roles, ', '')} FROM users u WHERE u.id=$1`, [userId]);
  // the timeline is checked at read time: a young person's is never shown on a share link, so consent changes and link revocation take effect at once
  const [profiles, activity, results, awards, credentials, memberships] = await Promise.all([
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
    scope.show_career && !(await isYouth(userId)) ? publicCareer(userId) : [],
  ]);
  const rec = await recruitmentSections(userId, scope, ctx);
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
    memberships: scope.show_career ? memberships : null,
    ...rec,
    evidence: 'Match counts mix official games with matches the athlete logged themselves (see official_matches). Results listed are approved competition results only. Videos and coach references appear only after a coach approved the video and the athlete approved the reference; academic items marked self_reported were entered by the athlete and are not verified. Memberships marked verified were confirmed by the club; others are self-reported.',
    generated_at: new Date().toISOString(),
  };
}

const SHOW = Object.fromEntries(SECTION_FLAGS.map((k) => [k, z.boolean().default(['show_matches', 'show_results', 'show_awards', 'show_credentials'].includes(k))]));
const COLS = `id, label, ${SECTION_FLAGS.join(', ')}, recipient_id, expires_at, revoked_at, version, view_count, last_viewed_at, created_at`;

/** Whose passport is this call about? Yourself, or a young person you are a verified guardian of. Young people cannot arrange sharing alone. */
async function subjectOf(user, athleteId) {
  if (!athleteId || athleteId === user.id) {
    if (await isYouth(user.id)) throw forbidden('A parent or guardian needs to arrange sharing for you');
    return user.id;
  }
  if (!(await guardianLink(user.id, athleteId))) throw forbidden('You are not a verified guardian of this young person');
  return athleteId;
}
async function checkRecipient(recipientId, athleteId) {
  if (!recipientId) return;
  if (recipientId === athleteId) throw conflict('Pick someone other than the athlete');
  if (!(await one('SELECT 1 FROM users WHERE id=$1', [recipientId]))) throw notFound('Recipient');
}
/** A link you may manage: your own, or one for a young person you are a verified guardian of. */
async function manageable(user, linkId) {
  const l = await one('SELECT * FROM passport_links WHERE id=$1', [linkId]);
  if (!l || (l.user_id !== user.id && !(await guardianLink(user.id, l.user_id)))) throw notFound('Passport link');
  return l;
}

cap({
  name: 'create_passport_link', method: 'POST', path: '/me/passport-links', tag: TAG, status: 201,
  summary: 'Create a share link to your player passport for a coach or scout. You choose what it shows (match history, approved results, awards, certificates, and for recruitment: approved video, approved coach references, preferences, availability, academic evidence), who may open it (anyone with the link, or one signed-in person) and when it expires (up to 90 days). The secret is shown once; put it in a QR code. A young person\'s link is arranged by their verified guardian (pass athlete_id) and works only while the guardian\'s recruitment_sharing consent is in force.',
  input: z.object({ athlete_id: id.optional(), label: z.string().trim().max(60).optional(), expires_in_days: z.number().int().min(1).max(90).default(30), recipient_id: id.optional(), ...SHOW }),
  async handler({ user }, i) {
    const owner = await subjectOf(user, i.athlete_id);
    if (owner !== user.id) await requireConsent(owner, 'recruitment_sharing', 'sharing this passport');
    await checkRecipient(i.recipient_id, owner);
    const token = newOpaqueToken();
    const row = await one(
      `INSERT INTO passport_links(user_id, created_by, token_hash, label, recipient_id, ${SECTION_FLAGS.join(', ')}, expires_at)
       VALUES ($1,$2,$3,$4,$5, ${SECTION_FLAGS.map((_, n) => `$${n + 6}`).join(', ')}, now() + $${SECTION_FLAGS.length + 6} * interval '1 day') RETURNING ${COLS}`,
      [owner, user.id, sha256(token), i.label || null, i.recipient_id ?? null, ...SECTION_FLAGS.map((k) => i[k]), i.expires_in_days]);
    const path = `/?passport=${encodeURIComponent(token)}`;
    return { ...row, token, path, url: config.appUrl ? `${String(config.appUrl).replace(/\/$/, '')}${path}` : null };
  },
});

cap({
  name: 'list_passport_links', method: 'GET', path: '/me/passport-links', tag: TAG,
  summary: 'Passport share links, newest first, with what each shows, who it is for, how often it was opened and whether it is active, expired or revoked. Pass athlete_id as a guardian to see a young person\'s links. The secret is never shown again.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const owner = i.athlete_id && i.athlete_id !== user.id ? (await subjectOf(user, i.athlete_id)) : user.id;
    return many(
      `SELECT ${COLS.split(', ').map((c) => `l.${c}`).join(', ')}, r.display_name AS recipient_name,
              CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.expires_at <= now() THEN 'expired' ELSE 'active' END AS status
         FROM passport_links l LEFT JOIN users r ON r.id=l.recipient_id WHERE l.user_id=$1 ORDER BY l.created_at DESC, l.id LIMIT 200`, [owner]);
  },
});

cap({
  name: 'update_passport_link', method: 'PATCH', path: '/me/passport-links/:id', tag: TAG,
  summary: 'Change what an active passport link shows, who it is for, its label or how long it lasts (from now). Send the version you last saw; a stale version is refused (409) so two devices cannot overwrite each other. Takes effect on the next open of the link.',
  input: z.object({ id, version: z.number().int().min(1), label: z.string().trim().max(60).nullable().optional(), expires_in_days: z.number().int().min(1).max(90).optional(), recipient_id: id.nullable().optional(),
    ...Object.fromEntries(SECTION_FLAGS.map((k) => [k, z.boolean().optional()])) }),
  async handler({ user }, i) {
    const l = await manageable(user, i.id);
    if (l.revoked_at || new Date(l.expires_at) <= new Date()) throw conflict('This link is no longer active; create a new one');
    if (i.recipient_id) await checkRecipient(i.recipient_id, l.user_id);
    const sets = [], vals = [i.id, i.version];
    const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (i.label !== undefined) set('label', i.label || null);
    if (i.recipient_id !== undefined) set('recipient_id', i.recipient_id);
    for (const k of SECTION_FLAGS) if (i[k] !== undefined) set(k, i[k]);
    if (i.expires_in_days !== undefined) { vals.push(i.expires_in_days); sets.push(`expires_at=now() + $${vals.length} * interval '1 day'`); }
    const row = await one(`UPDATE passport_links SET ${[...sets, 'version=version+1', 'updated_at=now()'].join(', ')} WHERE id=$1 AND version=$2 AND revoked_at IS NULL AND expires_at > now() RETURNING ${COLS}`, vals);
    if (!row) throw conflict('This link was changed elsewhere; reload and try again', { code: 'stale_version' });
    return row;
  },
});

cap({
  name: 'revoke_passport_link', method: 'POST', path: '/me/passport-links/:id/revoke', tag: TAG,
  summary: 'Turn a passport link off immediately (you, or a young person\'s verified guardian). The record stays so you can see it was shared.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await manageable(user, i.id);
    const row = await one('UPDATE passport_links SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id, revoked_at', [i.id]);
    if (!row) throw notFound('Passport link');
    return row;
  },
});

cap({
  name: 'get_my_passport', method: 'GET', path: '/me/passport', tag: TAG,
  summary: 'Preview your own player passport exactly as a link would show it (everything on; only approved videos and references).',
  handler: ({ user }) => buildPassport(user.id, FULL_SCOPE, { viewerId: user.id }),
});

cap({
  name: 'get_passport', method: 'GET', path: '/passport/:token', tag: TAG, auth: 'public',
  summary: 'Open a player passport from a share link. Anyone holding a valid, unexpired, unrevoked link can read it, unless it is addressed to one person: then you must be signed in as that person. It contains no personal identification data. Each open is counted; for a person-addressed link the signed-in viewer is recorded.',
  input: z.object({ token: z.string().min(10).max(200) }),
  async handler({ user }, i) {
    const link = await openLink(sha256(i.token), user, 'passport');
    return { ...(await buildPassport(link.user_id, scopeOf(link), { viewerId: user?.id ?? null, token: i.token })), expires_at: link.expires_at, addressed_to_you: !!link.recipient_id };
  },
});

cap({
  name: 'export_passport', method: 'GET', path: '/passport/:token/export', tag: TAG, auth: 'public',
  summary: 'The passport behind a share link as a downloadable JSON document. Same gate as opening the link: revoked, expired, other-recipient or consent-withdrawn links are refused, and the export contains only what the link shows.',
  input: z.object({ token: z.string().min(10).max(200) }),
  async handler({ user }, i) {
    const link = await openLink(sha256(i.token), user, 'export');
    return { format: 'sportarena.passport.v1', exported_at: new Date().toISOString(), expires_at: link.expires_at, passport: await buildPassport(link.user_id, scopeOf(link), { viewerId: user?.id ?? null, token: i.token }) };
  },
});
