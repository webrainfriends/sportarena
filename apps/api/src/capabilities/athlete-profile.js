import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { isYouth } from '../youth.js';
import { METRICS, METRIC_KEYS, SCOPES, SCOPED_FIELDS, canonical, completeness, optionsFor } from '../athlete-profile.js';

const TAG = 'Player';
const scope = z.enum(SCOPES);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Verified affiliations come from records the platform already holds — teams you were accepted into and credentials an organisation issued — never from free text. */
export const affiliationsFor = async (userId, sportId) => [
  ...(await many(
    `SELECT 'team' AS kind, t.id AS ref_id, t.name AS label, m.role, to_char(m.joined_at,'YYYY-MM-DD') AS since
       FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id=$1 AND m.status='active' AND t.sport_id=$2 ORDER BY t.name, t.id`, [userId, sportId])),
  ...(await many(
    `SELECT 'credential' AS kind, c.id AS ref_id, c.title AS label, o.name AS issuer, to_char(c.issued_on,'YYYY-MM-DD') AS since
       FROM credentials c JOIN organisations o ON o.id = c.organisation_id
      WHERE c.user_id=$1 AND c.status='issued' AND (c.expires_on IS NULL OR c.expires_on >= current_date) AND (c.sport_id IS NULL OR c.sport_id=$2) ORDER BY c.title, c.id`, [userId, sportId])),
].map((a) => ({ ...a, verified: true }));

async function ownCard(userId, profileId, c) {
  const row = (await (c ?? { query }).query('SELECT * FROM sport_profiles WHERE id=$1 AND user_id=$2', [profileId, userId])).rows[0];
  if (!row) throw notFound('Sport profile');
  return row;
}

/** Young people share nothing beyond private until guardian-controlled sharing (#319) decides who may see what. */
async function assertMayShare(user, sc) {
  if (sc && sc !== 'private' && (await isYouth(user.id))) throw badRequest('Sharing for young athletes is controlled by their guardian — keep this private for now');
}

cap({
  name: 'get_profile_options', method: 'GET', path: '/sports/:slug/profile-options', tag: TAG, auth: 'public',
  summary: 'Position and playing-preference suggestions for a sport, plus the measurement metrics and units an athlete may opt in to.',
  input: z.object({ slug: z.string() }),
  async handler(_, i) {
    const sport = await sportBySlugOrId(i.slug);
    if (!sport) throw notFound('Sport');
    return optionsFor(sport.slug);
  },
});

cap({
  name: 'update_athlete_profile', method: 'PATCH', path: '/me/sport-profiles/:id/athlete', tag: TAG,
  summary: 'Set dominant side, several positions, playing preferences and who may see each field (private, coach, recruiter or public). New fields are private until you share them.',
  input: z.object({
    id, dominant_side: z.enum(['left', 'right', 'both']).nullable().optional(),
    positions: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
    play_prefs: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    field_scopes: z.object(Object.fromEntries(SCOPED_FIELDS.map((f) => [f, scope.optional()]))).optional(),
  }),
  async handler({ user }, i) {
    for (const sc of Object.values(i.field_scopes ?? {}).filter(Boolean)) await assertMayShare(user, sc);
    return tx(async (c) => {
      const card = await ownCard(user.id, i.id, c);
      const positions = i.positions ? [...new Set(i.positions)] : undefined;
      const scopes = i.field_scopes ? { ...card.field_scopes, ...i.field_scopes } : undefined;
      await c.query(
        `UPDATE sport_profiles SET dominant_side = CASE WHEN $3 THEN $4 ELSE dominant_side END, positions = coalesce($5::text[], positions), play_prefs = coalesce($6::text[], play_prefs),
                field_scopes = coalesce($7::jsonb, field_scopes), position = CASE WHEN $5::text[] IS NOT NULL THEN $5[1] ELSE position END
          WHERE id=$1 AND user_id=$2`,
        [i.id, user.id, i.dominant_side !== undefined, i.dominant_side ?? null, positions ?? null, i.play_prefs ? [...new Set(i.play_prefs)] : null, scopes ? JSON.stringify(scopes) : null]);
      return { ok: true };
    });
  },
});

cap({
  name: 'add_measurement', method: 'POST', path: '/me/sport-profiles/:id/measurements', tag: TAG, status: 201,
  summary: 'Opt in to record a dated measurement (height, weight, wingspan, jump, sprint) with its unit and who measured it. Validated per metric and unit; the value is encrypted at rest and private until you share it.',
  input: z.object({
    id, metric: z.enum(METRIC_KEYS), unit: z.string().max(12), value: z.coerce.number().finite(), measured_on: day,
    source: z.enum(['self', 'coach', 'test']).default('self'), note: z.string().max(200).optional(), scope: scope.default('private'),
  }),
  async handler({ user }, i) {
    await ownCard(user.id, i.id);
    if (canonical(i.metric, i.unit, i.value) == null) throw badRequest(`${METRICS[i.metric].label} must be in ${Object.keys(METRICS[i.metric].units).join(' or ')} and within a human range`);
    if (i.measured_on > new Date().toISOString().slice(0, 10)) throw badRequest('Measurement date cannot be in the future');
    await assertMayShare(user, i.scope);
    return one(
      `INSERT INTO athlete_measurements (user_id, sport_profile_id, metric, unit, value_enc, measured_on, source, note, scope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, metric, unit, to_char(measured_on,'YYYY-MM-DD') AS measured_on, source, note, scope`,
      [user.id, i.id, i.metric, i.unit, encrypt(String(i.value), 'athlete_measurements.value'), i.measured_on, i.source, i.note ?? null, i.scope]);
  },
});

const MEASURE_COLS = `id, metric, unit, value_enc, to_char(measured_on,'YYYY-MM-DD') AS measured_on, source, note, scope, revoked_at, created_at`;
const present = ({ value_enc, ...m }) => ({ ...m, value: Number(decrypt(value_enc, 'athlete_measurements.value')) });

cap({
  name: 'list_measurements', method: 'GET', path: '/me/sport-profiles/:id/measurements', tag: TAG,
  summary: 'Your dated measurements for one sport profile, newest first (revoked ones are marked). Reading decrypts the values and is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await ownCard(user.id, i.id);
    const rows = await many(`SELECT ${MEASURE_COLS} FROM athlete_measurements WHERE sport_profile_id=$1 AND user_id=$2 ORDER BY measured_on DESC, created_at DESC, id`, [i.id, user.id]);
    if (rows.length) await audit(null, user.id, 'read_athlete_measurements', 'sport_profiles', i.id);
    return rows.map(present);
  },
});

cap({
  name: 'update_measurement_scope', method: 'PATCH', path: '/me/measurements/:id', tag: TAG,
  summary: 'Change who may see one measurement (private, coach, recruiter, public).',
  input: z.object({ id, scope }),
  async handler({ user }, i) {
    await assertMayShare(user, i.scope);
    const row = await one('UPDATE athlete_measurements SET scope=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [i.id, user.id, i.scope]);
    if (!row) throw notFound('Measurement');
    return { ok: true };
  },
});

cap({
  name: 'revoke_measurement', method: 'POST', path: '/me/measurements/:id/revoke', tag: TAG,
  summary: 'Withdraw a measurement: it stops being visible to anyone but you at once. The record is kept (never deleted) and can be restored.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one("UPDATE athlete_measurements SET revoked_at=now(), scope='private' WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id", [i.id, user.id]);
    if (!row) throw notFound('Measurement');
    return { ok: true };
  },
});

cap({
  name: 'restore_measurement', method: 'POST', path: '/me/measurements/:id/restore', tag: TAG,
  summary: 'Bring back a revoked measurement (still private until you share it).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one('UPDATE athlete_measurements SET revoked_at=NULL WHERE id=$1 AND user_id=$2 AND revoked_at IS NOT NULL RETURNING id', [i.id, user.id]);
    if (!row) throw notFound('Measurement');
    return { ok: true };
  },
});

cap({
  name: 'get_athlete_profile', method: 'GET', path: '/me/sport-profiles/:id/athlete', tag: TAG,
  summary: 'The full athlete card for editing: dominant side, positions, preferences, field scopes, verified affiliations, completeness and the sport\'s suggestion lists.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const card = await ownCard(user.id, i.id);
    const [affiliations, m, sport] = await Promise.all([
      affiliationsFor(user.id, card.sport_id),
      one('SELECT count(*)::int AS n FROM athlete_measurements WHERE sport_profile_id=$1 AND user_id=$2 AND revoked_at IS NULL', [i.id, user.id]),
      one('SELECT slug FROM sports WHERE id=$1', [card.sport_id]),
    ]);
    return {
      id: card.id, dominant_side: card.dominant_side, positions: card.positions, play_prefs: card.play_prefs, field_scopes: card.field_scopes,
      archived_at: card.archived_at, affiliations, completeness: completeness(card, { measurements: m.n, affiliations: affiliations.length }), options: optionsFor(sport.slug),
    };
  },
});

cap({
  name: 'restore_sport_profile', method: 'POST', path: '/me/sport-profiles/:id/restore', tag: TAG,
  summary: 'Bring back an archived sport profile with everything logged under it (matches, history, measurements). It returns as a normal card, not the default.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sport_profiles:${user.id}`]);
      const card = await ownCard(user.id, i.id, c);
      if (!card.archived_at) return { ok: true };
      const hasDefault = (await c.query('SELECT 1 FROM sport_profiles WHERE user_id=$1 AND archived_at IS NULL AND is_default', [user.id])).rowCount;
      await c.query('UPDATE sport_profiles SET archived_at=NULL, is_default=$2 WHERE id=$1', [i.id, !hasDefault]);
      return { ok: true };
    });
  },
});

cap({
  name: 'list_archived_sport_profiles', method: 'GET', path: '/me/sport-profiles/archived', tag: TAG,
  summary: 'Sport profiles you archived, with how many matches are kept under each so you can restore them.',
  async handler({ user }) {
    return many(
      `SELECT p.id, p.role, p.level, to_char(p.archived_at,'YYYY-MM-DD') AS archived_on, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
              (SELECT count(*)::int FROM player_matches m WHERE m.sport_profile_id=p.id AND m.archived_at IS NULL) AS matches_kept
         FROM sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.archived_at IS NOT NULL ORDER BY p.archived_at DESC, p.id`, [user.id]);
  },
});
