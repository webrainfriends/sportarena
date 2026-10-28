// Find & Join Games (issue #508): the rules shared by every open-game capability. An open game is a `games` row plus the marketplace
// terms in `open_games`; seats are `open_game_members`. Seat changes always run under a row lock on the open game so capacity,
// waitlist promotion and retries stay consistent. Nothing here reserves a venue: the canonical booking is linked and read live.
import { query } from './db.js';
import { badRequest, conflict } from './errors.js';
import { decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { notify } from './notify.js';
import { hasConsent, isYouth } from './youth.js';
import { fromLocal, addDays, toLocal, validTimezone } from './booking/time.js';

export const LEVELS = ['beginner', 'amateur', 'semi_pro', 'pro'];
export const LEVEL_LABEL = { beginner: 'Beginner', amateur: 'Amateur', semi_pro: 'Semi-pro', pro: 'Pro' };
export const SEAT = ['confirmed']; // statuses that take a seat
export const LIVE = ['guardian_pending', 'requested', 'waitlisted', 'confirmed'];
/** Chat and attendance windows, in hours. */
export const CHAT_GRACE_HOURS = 48;
export const CHECK_IN_EARLY_MIN = 60;

export const endOf = (g) => (g.ends_at ? new Date(g.ends_at) : new Date(+new Date(g.starts_at) + 3 * 36e5));
export const chatClosesAt = (g) => new Date(+endOf(g) + CHAT_GRACE_HOURS * 36e5);

/** Lock the open game row (serialises seat changes) and return it with its game. */
export async function lockOpenGame(c, openGameId) {
  const og = (await c.query('SELECT * FROM open_games WHERE id=$1 FOR UPDATE', [openGameId])).rows[0];
  if (!og) return null;
  const g = (await c.query('SELECT g.*, s.name AS sport_name, s.slug AS sport_slug FROM games g JOIN sports s ON s.id=g.sport_id WHERE g.id=$1', [og.game_id])).rows[0];
  return { og, g };
}

export const seatsTaken = async (c, openGameId) => Number((await c.query("SELECT count(*) AS n FROM open_game_members WHERE open_game_id=$1 AND status='confirmed'", [openGameId])).rows[0].n);

/** What one confirmed seat costs: a flat price, or the pitch split across the maximum squad (rounded up so the host is never short). */
export const shareFor = (og) => (og.cost_mode === 'per_player' ? Number(og.cost_cents) : og.cost_mode === 'split_total' ? Math.ceil(Number(og.cost_cents) / og.max_players) : 0);

/** Where a game's venue stands, always read from the canonical booking. */
export const bookingStateSql = `CASE WHEN g.venue_id IS NULL THEN 'no_venue'
  WHEN og.booking_id IS NULL THEN 'unbooked'
  WHEN b.status = 'confirmed' THEN 'confirmed' ELSE 'cancelled' END`;

/** Whole years from a date of birth held encrypted. Decryption is audit-logged. null when no date of birth is on file. */
export async function ageOfUser(userId, actor, c) {
  const u = (await (c ?? { query }).query('SELECT dob_enc FROM users WHERE id=$1', [userId])).rows[0];
  if (!u?.dob_enc) return null;
  await audit(c ?? null, actor?.id ?? null, 'open_game_age_check', 'users', userId);
  const d = new Date(decrypt(u.dob_enc, 'users.dob'));
  if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now < new Date(Date.UTC(now.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) a--;
  return a;
}

/** Can this person take a seat at all? Audience, age band and (for young people) guardian consent. Returns { youth }. */
export async function assertCanPlay(c, og, subjectId, actor) {
  const youth = await isYouth(subjectId, c);
  if (og.audience === 'adults' && youth) throw conflict('This game is for adults only', { code: 'adults_only' });
  if (og.audience === 'youth' && !youth) throw conflict('This game is for young players only', { code: 'youth_only' });
  if (og.min_age != null || og.max_age != null) {
    const age = await ageOfUser(subjectId, actor, c);
    if (age == null) throw conflict('Add your date of birth to join an age-restricted game', { code: 'age_required' });
    if ((og.min_age != null && age < og.min_age) || (og.max_age != null && age > og.max_age)) throw conflict(`This game is for ages ${og.min_age ?? 0}${og.max_age != null ? `–${og.max_age}` : '+'}`, { code: 'age_band' });
  }
  return { youth };
}

/** The level a person declared for this game's sport, or null when they have no profile for it. */
export const levelFor = async (c, userId, sportId) => (await c.query('SELECT level FROM sport_profiles WHERE user_id=$1 AND sport_id=$2 AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1', [userId, sportId])).rows[0]?.level ?? null;

/** fit: 'fits' | 'below' | 'above' | 'unknown' | 'open' (the game states no level). Advisory unless the game auto-approves. */
export function levelFit(og, level) {
  if (!og.skill_min && !og.skill_max) return 'open';
  if (!level) return 'unknown';
  const i = LEVELS.indexOf(level);
  if (og.skill_min && i < LEVELS.indexOf(og.skill_min)) return 'below';
  if (og.skill_max && i > LEVELS.indexOf(og.skill_max)) return 'above';
  return 'fits';
}

/** Move the oldest approved waitlisted people into freed seats. Returns the members promoted. */
export async function promoteWaitlist(c, og, g) {
  const promoted = [];
  for (;;) {
    if ((await seatsTaken(c, og.id)) >= og.max_players) break;
    const next = (await c.query("SELECT * FROM open_game_members WHERE open_game_id=$1 AND status='waitlisted' AND approved ORDER BY created_at, id LIMIT 1 FOR UPDATE", [og.id])).rows[0];
    if (!next) break;
    if (!(await hasConsent(next.user_id, 'participation', c))) { // a young person whose guardian withdrew consent is never promoted
      await c.query("UPDATE open_game_members SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [next.id]);
      continue;
    }
    const share = shareFor(og);
    await c.query("UPDATE open_game_members SET status='confirmed', share_cents=$2::bigint, share_status=CASE WHEN $2::bigint > 0 THEN 'due' ELSE 'none' END, updated_at=now() WHERE id=$1", [next.id, share]);
    promoted.push(next);
    await notifyMember(c, next, { kind: 'open_game_promoted', title: 'You are in!', body: `A seat opened up in "${g.title}" and it is yours.`, key: `og_promoted:${next.id}` }, og);
  }
  return promoted;
}

/** Tell a seat holder (and, for a young person, their guardians instead of them) about something. Generic wording only. */
export async function notifyMember(c, member, { kind, title, body, key }, og) {
  const data = { open_game_id: og.id, game_id: og.game_id, member_id: member.id };
  const to = (await isYouth(member.user_id, c)) ? [...new Set([...(await guardianIds(c, member.user_id)), ...(member.applied_by ? [member.applied_by] : [])])] : [member.user_id];
  for (const uid of to) await notify(c, uid, { kind, title, body, data, dedupe_key: key ? `${key}:${uid}` : undefined });
}
const guardianIds = async (c, childId) => (await c.query("SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [childId])).rows.map((r) => r.guardian_id);

/** After a seat is taken: tell the host when the game is nearly full / full (once per level). */
export async function nudgeHost(c, og, g) {
  const left = og.max_players - (await seatsTaken(c, og.id));
  if (left > 1) return;
  await notify(c, og.host_id, {
    kind: left === 0 ? 'open_game_full' : 'open_game_nearly_full', title: left === 0 ? 'Your game is full' : 'Your game is nearly full',
    body: left === 0 ? `"${g.title}" has every seat taken. New people join the waitlist.` : `Only one seat left in "${g.title}".`,
    data: { open_game_id: og.id, game_id: og.game_id }, dedupe_key: `og_fill:${og.id}:${left}:${og.row_version}`,
  });
}

/** Tell everyone holding a place that the time or place changed, or that the game is off. */
export async function notifyAll(c, og, g, { kind, title, body, statuses = ['confirmed', 'waitlisted', 'requested'], key }) {
  const { rows } = await c.query('SELECT * FROM open_game_members WHERE open_game_id=$1 AND status = ANY($2)', [og.id, statuses]);
  for (const m of rows) if (m.user_id !== og.host_id) await notifyMember(c, m, { kind, title, body, key: key && `${key}:${m.id}` }, og);
}

/** The window helper behind `when=today|tomorrow|weekend|week`, evaluated in the caller's time zone. */
export function whenWindow(when, tz = 'UTC', now = new Date()) {
  if (!validTimezone(tz)) throw badRequest('Unknown time zone');
  const today = toLocal(now, tz).date;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const day0 = (d) => fromLocal(d, 0, tz);
  if (when === 'now') return { from: now, to: new Date(+now + 3 * 36e5) };
  if (when === 'today') return { from: now, to: day0(addDays(today, 1)) };
  if (when === 'tomorrow') return { from: day0(addDays(today, 1)), to: day0(addDays(today, 2)) };
  if (when === 'week') return { from: now, to: day0(addDays(today, 7)) };
  // weekend: Saturday 00:00 to Monday 00:00; on Saturday/Sunday the rest of this weekend
  const toSat = dow === 6 || dow === 0 ? 0 : 6 - dow;
  const sat = addDays(today, dow === 0 ? -1 : toSat);
  return { from: now > day0(sat) ? now : day0(sat), to: day0(addDays(sat, 2)) };
}
