// Sports Disciplinary & Sanctions (#479): the pure policy engine, the sport vocabulary, who may act, and the ONE live read of a person's disciplinary block that
// competition eligibility consumes (via integrity.activeSportingSanction, so there is still a single source). Nothing here copies a match event, a fixture or a score:
// cases reference them, and served matches are derived from fixtures every time they are asked for, so they can never drift from what really happened.
import { z } from 'zod';
import { pool } from './db.js';
import { isAdmin } from './helpers.js';
import { hasOrgGrant } from './org-access.js';
import { isGuardianOf } from './federation.js';
import { notFound, forbidden } from './errors.js';
import { notify } from './notify.js';
import { guardiansOf } from './youth.js';
import { builtinRuleset } from './scoring/rulesets.js';

export const NOT_A_FINDING = 'A referral or an allegation is not a finding. Nothing here is a sanction until an authorised panel records a decision.';
export const SANCTION_KINDS = ['warning', 'match_suspension', 'date_suspension', 'competition_ban', 'role_suspension', 'fine', 'points_deduction', 'other'];
export const CASE_STATES = ['opened', 'under_review', 'decided', 'closed', 'withdrawn'];
/** node-pg returns `date` columns as local-midnight Date objects; every comparison here uses plain YYYY-MM-DD strings. */
export const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v == null ? null : String(v).slice(0, 10));
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ------------------------------------------------------------------------------------------------------------------ sport vocabulary
/** Disciplinary kinds the live scoring rulesets can record, with how they count by default. */
export const KIND_INFO = {
  yellow_card: { label: 'Yellow card', family: 'cards', points: 1 },
  green_card: { label: 'Green card', family: 'cards', points: 1 },
  black_card: { label: 'Black card', family: 'cards', points: 2 },
  two_minute: { label: '2-minute suspension', family: 'cards', points: 1 },
  red_card: { label: 'Red card', family: 'cards', points: 0, dismissal: true },
  warning: { label: 'Warning', family: 'conduct_levels', points: 1 },
  chukoku: { label: 'Chukoku (warning)', family: 'conduct_levels', points: 1 },
  keikoku: { label: 'Keikoku', family: 'conduct_levels', points: 2 },
  point_deduction: { label: 'Point deduction', family: 'conduct_levels', points: 2 },
  technical_foul: { label: 'Technical foul', family: 'foul_limits', points: 1 },
};
const FAMILY_LABEL = {
  cards: 'Card-based discipline (cautions and dismissals)',
  conduct_levels: 'Graded conduct warnings and penalties',
  foul_limits: 'Foul limits and technical fouls',
  generic: 'Generic misconduct referral (labelled fallback: this sport records no cautions in live scoring)',
};
/** Each sport's native discipline model, from the kinds its live ruleset can record; a sport with none is a LABELLED generic fallback, never a silent default. */
export function disciplineModelOf(sport) {
  let rs = null;
  try { rs = builtinRuleset(sport); } catch { rs = null; }
  const have = new Set([...(rs?.stats ?? []), ...(rs?.events ?? [])].map((s) => s.kind));
  const kinds = Object.keys(KIND_INFO).filter((k) => have.has(k));
  const foulLimit = rs?.basketball?.player_fouls_out;
  // a bare `warning` / `foul` is what the generic team-points ruleset records for every sport; it does not make a sport native
  const real = kinds.filter((k) => k !== 'warning');
  let family = 'generic';
  if (real.some((k) => KIND_INFO[k].family === 'cards')) family = 'cards';
  else if (real.some((k) => KIND_INFO[k].family === 'conduct_levels')) family = 'conduct_levels';
  else if (foulLimit) family = 'foul_limits';
  return { family, label: FAMILY_LABEL[family], native: family !== 'generic', kinds: family === 'foul_limits' && !kinds.length ? ['technical_foul'] : kinds };
}

// ------------------------------------------------------------------------------------------------------------------ policy
export const CATEGORIES = ['violent_conduct', 'serious_foul_play', 'abusive_language', 'dissent', 'persistent_infringement', 'doping_adjacent_referral', 'team_misconduct', 'coach_misconduct', 'official_misconduct', 'ineligible_player', 'other'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const policyParams = z.object({
  card_points: z.record(z.string(), z.number().int().min(0).max(20)).default({}).describe('caution points each card kind adds toward accumulation (kind → points)'),
  accumulation: z.array(z.object({ points: z.number().int().min(1).max(50), matches: z.number().int().min(1).max(50) })).max(6).default([]).describe('reaching `points` cautions earns a `matches` suspension'),
  carry_over: z.enum(['reset', 'keep_excess']).default('reset').describe('after a threshold fires: start again at zero, or keep the points above it'),
  direct: z.array(z.object({ kind: z.string().min(2).max(40), matches: z.number().int().min(1).max(50) })).max(12).default([]).describe('a card kind that on its own earns a suspension (for example red_card)'),
  second_caution: z.object({ kind: z.string().min(2).max(40), matches: z.number().int().min(1).max(50) }).nullable().default(null).describe('two of this card kind to the same person in ONE match earn a suspension'),
  expire_after_days: z.number().int().min(1).max(3650).nullable().default(null).describe('cautions older than this stop counting (null = never within the scope)'),
  scope: z.enum(['competition', 'sport']).default('competition').describe('a suspension is served in this competition only, or in any competition of the sport'),
  abandoned_counts: z.boolean().default(false).describe('does an abandoned match count as served?'),
  repeat_offence: z.object({ within_days: z.number().int().min(1).max(3650), add_matches: z.number().int().min(1).max(20) }).nullable().default(null),
  categories: z.array(z.enum(CATEGORIES)).max(20).default(CATEGORIES),
  authority: z.object({ fines: z.boolean().default(false), points_deduction: z.boolean().default(false), fine_cap_minor: z.number().int().min(1).max(1_000_000_000).nullable().default(null), points_cap: z.number().int().min(1).max(100).nullable().default(null) }).default({ fines: false, points_deduction: false, fine_cap_minor: null, points_cap: null }),
  appeal_window_days: z.number().int().min(1).max(60).default(7),
  stay_on_appeal: z.boolean().default(false).describe('a lodged appeal pauses the sanctions until it is decided'),
  public_disclosure: z.enum(['none']).default('none').describe('suspensions are never shown on public profiles, rosters or exports; the only outward result is an official verification attestation'),
}).strict();

/**
 * Deterministic: the same cards and the same params always give the same triggers. `cards` = [{ id, kind, fixture_id, at, player_id }], any order;
 * they are sorted by (at, id) so a retry or a sweep cannot change the answer. Returns [{ match_event_id, rule, matches, total }].
 */
export function evaluateThresholds(params, cards) {
  const p = policyParams.parse(params ?? {});
  const list = cards.map((x) => ({ ...x, at: new Date(x.at).toISOString() })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = [];
  let total = 0;
  const acc = [...p.accumulation].sort((a, b) => a.points - b.points);
  const seenInFixture = new Map();
  const live = [];
  for (const card of list) {
    const pts = p.card_points[card.kind] ?? 0;
    // expiry: points older than the window (measured to this card) stop counting
    live.push({ ...card, pts });
    if (p.expire_after_days) {
      const cutoff = new Date(new Date(card.at).getTime() - p.expire_after_days * 86400000).toISOString();
      total = live.filter((x) => x.at >= cutoff && !x.spent).reduce((t, x) => t + x.pts, 0);
    } else total += pts;
    const direct = p.direct.find((d) => d.kind === card.kind);
    if (direct) out.push({ match_event_id: card.id, rule: 'direct', matches: direct.matches, total });
    if (p.second_caution && card.kind === p.second_caution.kind) {
      const key = `${card.fixture_id}:${card.kind}`;
      const n = (seenInFixture.get(key) ?? 0) + 1;
      seenInFixture.set(key, n);
      if (n === 2) out.push({ match_event_id: card.id, rule: 'second_caution', matches: p.second_caution.matches, total });
    }
    // the highest threshold reached fires once, then the count restarts (or keeps its excess)
    const hit = [...acc].reverse().find((t) => pts > 0 && total >= t.points);
    if (hit) {
      out.push({ match_event_id: card.id, rule: 'accumulation', matches: hit.matches, total });
      const keep = p.carry_over === 'keep_excess' ? total - hit.points : 0;
      for (const x of live) x.spent = true;
      total = keep;
      if (keep) live.push({ id: `carry:${card.id}`, at: card.at, pts: keep });
    }
  }
  return out;
}

/** Repeat-offence escalation: extra matches when the person already has upheld decisions inside the window. */
export function escalate(params, matches, priorUpheld) {
  const r = policyParams.parse(params ?? {}).repeat_offence;
  return r && priorUpheld > 0 ? matches + r.add_matches * priorUpheld : matches;
}

// ------------------------------------------------------------------------------------------------------------------ access
/** The competition's disciplinary authority: its organiser (owner, org owner/admin, platform admin) or a panel member / secretary it appointed. */
export async function authorityOf(user, competitionId, { c = pool } = {}) {
  if (!user) return null;
  const cm = (await c.query('SELECT owner_id, organisation_id FROM comp_competitions WHERE id=$1', [competitionId])).rows[0];
  if (!cm) return null;
  if (cm.owner_id === user.id) return { as: 'organiser' };
  if (cm.organisation_id && (await hasOrgGrant(user, cm.organisation_id, ['owner', 'admin'], c))) return { as: 'organiser' };
  const m = (await c.query('SELECT role FROM disc_members WHERE competition_id=$1 AND user_id=$2 AND ended_at IS NULL', [competitionId, user.id])).rows[0];
  if (m) return { as: m.role };
  return null;
}
export const mayDecide = (a) => a?.as === 'organiser' || a?.as === 'panel';

export async function lockCase(c, id) {
  const r = (await c.query('SELECT * FROM disc_cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!r) throw notFound('Case');
  return r;
}
/** The case and how the caller stands: authority (organiser|panel|secretary), team (a manager of the subject's team), subject (the person or their guardian). 404 for everyone else. */
export async function caseFor(user, id, { c = pool, lock = false } = {}) {
  const row = lock ? await lockCase(c, id) : (await c.query('SELECT * FROM disc_cases WHERE id=$1', [id])).rows[0];
  if (!row) throw notFound('Case');
  const a = await authorityOf(user, row.competition_id, { c });
  if (a) return { row, as: a.as };
  if (row.subject_user_id === user.id) return { row, as: 'subject' };
  if (row.subject_user_id && (await isGuardianOf(user.id, row.subject_user_id, c))) return { row, as: 'subject', guardian: true };
  if (row.team_id) {
    const t = (await c.query('SELECT owner_id FROM teams WHERE id=$1', [row.team_id])).rows[0];
    const staff = t?.owner_id === user.id || (await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role IN ('captain','manager','coach')", [row.team_id, user.id])).rowCount > 0;
    if (staff) return { row, as: 'team' };
  }
  throw notFound('Case');
}
export function needDecide(s) { if (s.as !== 'organiser' && s.as !== 'panel') throw forbidden('Only the disciplinary panel or the organiser can do that'); }

export const log = (c, caseId, action, { actor = null, from = null, to = null, reason = null, detail = {} } = {}) =>
  c.query('INSERT INTO disc_events(case_id, action, actor_id, from_status, to_status, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [caseId, action, actor, from, to, reason, detail]);

/** A neutral notice: it says only that there is something to open, never the category, the allegation or the outcome. */
export async function tell(c, userId, caseRow, { guardians = true } = {}) {
  const msg = { kind: 'discipline_update', title: 'Update on a competition matter', body: 'Open SportArena to view it.', data: { governance_notice: true } };
  await notify(c, userId, { ...msg, dedupe_key: `disc:${caseRow.id}:${caseRow.row_version}:${userId}` });
  if (guardians && userId === caseRow.subject_user_id) for (const g of await guardiansOf(userId, c)) await notify(c, g, { ...msg, dedupe_key: `disc:${caseRow.id}:${caseRow.row_version}:${g}` });
}
export async function nextCaseNo(c, competitionId) {
  const n = (await c.query("SELECT nextval('disc_case_seq')::int AS n")).rows[0].n;
  const ab = (await c.query('SELECT upper(left(regexp_replace(slug, \'[^a-z0-9]\', \'\', \'g\'), 4)) AS a FROM comp_competitions WHERE id=$1', [competitionId])).rows[0]?.a || 'COMP';
  return `${ab}-DISC-${new Date().getUTCFullYear()}-${String(n).padStart(4, '0')}`;
}

/** The policy version that governs a season: the season's own, else the competition default. null = no policy published yet. */
export async function policyFor(c, competitionId, seasonId) {
  const r = await c.query(
    `SELECT v.*, p.season_id FROM disc_policies p JOIN disc_policy_versions v ON v.policy_id=p.id
      WHERE p.competition_id=$1 AND (p.season_id=$2 OR p.season_id IS NULL)
      ORDER BY (p.season_id IS NOT NULL) DESC, v.version DESC LIMIT 1`, [competitionId, seasonId]);
  return r.rows[0] ?? null;
}

// ------------------------------------------------------------------------------------------------------------------ serving
/**
 * How a match suspension stands, derived from the fixtures themselves. Counting starts after the sanction's effective date (and after the offending match).
 * completed/finished = served; abandoned = served only if the policy says so; cancelled and postponed never count (a postponed match counts once it is played);
 * scheduled / live / paused = still to come. `ahead` is the number of still-to-come matches before `at`.
 */
export async function serviceOf(c, sanction, caseRow, params, { at = new Date() } = {}) {
  if (sanction.kind !== 'match_suspension' || !caseRow.team_id) return null;
  const p = policyParams.parse(params ?? {});
  const scope = sanction.scope === 'sport' || p.scope === 'sport';
  const src = caseRow.fixture_id ? (await c.query('SELECT scheduled_at FROM fixtures WHERE id=$1', [caseRow.fixture_id])).rows[0] : null;
  const from = sanction.effective_from ? new Date(`${ymd(sanction.effective_from)}T00:00:00Z`) : new Date(sanction.created_at);
  const after = src && new Date(src.scheduled_at) > from ? new Date(src.scheduled_at) : from;
  const rows = (await c.query(
    `SELECT f.id, f.status, f.scheduled_at, f.event_id FROM fixtures f JOIN events e ON e.id=f.event_id
      WHERE (f.home_team_id=$1 OR f.away_team_id=$1) AND f.scheduled_at > $2
        AND ${scope ? 'e.sport_id=$3' : 'f.event_id=$3'}
      ORDER BY f.scheduled_at, f.id`, [caseRow.team_id, after, scope ? caseRow.sport_id : caseRow.event_id])).rows;
  const fixtures = rows.map((f) => {
    let state;
    if (f.status === 'completed' || f.status === 'finished') state = 'served';
    else if (f.status === 'abandoned') state = p.abandoned_counts ? 'served' : 'skipped_abandoned';
    else if (f.status === 'cancelled') state = 'skipped_cancelled';
    else if (f.status === 'postponed') state = 'skipped_postponed';
    else state = 'to_come';
    return { fixture_id: f.id, scheduled_at: f.scheduled_at, status: f.status, state };
  });
  const served = Math.min(sanction.matches, fixtures.filter((f) => f.state === 'served').length);
  const remaining = Math.max(0, sanction.matches - served);
  const comeAhead = fixtures.filter((f) => f.state === 'to_come' && new Date(f.scheduled_at) < at).length;
  return { matches: sanction.matches, served, remaining, ahead: comeAhead, fixtures };
}

/**
 * The one live read of a disciplinary block. A person is blocked when an active, un-stayed sanction of an upheld, current decision applies in this competition/sport:
 * a date suspension or ban inside its dates, a match suspension with matches still to serve (and this match is within them), or an interim suspension not yet decided.
 * Exposes only that a block exists and until when; never the case, the category, the evidence or the reason.
 */
export async function activeDisciplineBlock(c, userId, sportId, onDay = today(), { eventId = null, at = new Date() } = {}) {
  const comp = eventId ? (await c.query('SELECT competition_id FROM comp_seasons WHERE event_id=$1', [eventId])).rows[0]?.competition_id ?? null : null;
  const rows = (await c.query(
    `SELECT s.*, k.id AS case_id, k.team_id, k.event_id, k.sport_id, k.fixture_id, k.competition_id, k.season_id, k.policy_version_id
       FROM disc_sanctions s JOIN disc_cases k ON k.id=s.case_id JOIN disc_decisions d ON d.id=s.decision_id
      WHERE k.subject_user_id=$1 AND k.sport_id=$2 AND s.status='active' AND d.superseded_at IS NULL AND d.outcome='upheld'
        AND s.kind IN ('match_suspension','date_suspension','competition_ban')
        AND (s.scope='sport' OR k.competition_id IS NOT DISTINCT FROM $3)
      ORDER BY s.created_at`, [userId, sportId, comp])).rows;
  let best = null;
  for (const s of rows) {
    if (s.kind === 'match_suspension') {
      const v = (await c.query('SELECT params FROM disc_policy_versions WHERE id=$1', [s.policy_version_id])).rows[0];
      const sv = await serviceOf(c, s, s, v?.params ?? {}, { at });
      if (sv && sv.remaining > 0 && sv.ahead < sv.remaining) best ??= { id: s.id, valid_until: null };
    } else {
      const from = ymd(s.effective_from);
      const to = ymd(s.effective_to);
      if ((!from || from <= onDay) && (!to || to >= onDay)) { if (!best || (best.valid_until && (!to || to > best.valid_until))) best = { id: s.id, valid_until: to }; }
    }
  }
  if (best) return best;
  // an interim suspension (policy permitting) blocks while the matter is pending, and is not a finding
  const i = (await c.query(
    `SELECT k.id, k.interim_until::text AS valid_until FROM disc_cases k
      WHERE k.subject_user_id=$1 AND k.sport_id=$2 AND k.interim_status='interim_suspension' AND k.status IN ('opened','under_review')
        AND (k.interim_until IS NULL OR k.interim_until >= $4::date) AND (k.competition_id IS NOT DISTINCT FROM $3 OR $3 IS NULL)
      ORDER BY k.created_at LIMIT 1`, [userId, sportId, comp, onDay])).rows[0];
  return i ? { id: i.id, valid_until: i.valid_until } : null;
}

/** A card was voided or corrected: flag every case it fed for re-evaluation. Prior decisions are untouched. */
export async function flagForEvent(c, matchEventId, actor, why) {
  const rows = (await c.query("UPDATE disc_cases SET reevaluation='flagged', updated_at=now(), row_version=row_version+1 WHERE match_event_id=$1 AND status<>'withdrawn' AND reevaluation IS DISTINCT FROM 'flagged' RETURNING id, status", [matchEventId])).rows;
  for (const r of rows) await log(c, r.id, 'source_event_corrected', { actor, reason: why ?? 'The match event this case came from was corrected or voided', detail: { match_event_id: matchEventId } });
  return rows.length;
}
export { isAdmin };
