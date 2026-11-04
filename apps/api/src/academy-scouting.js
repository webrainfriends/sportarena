// Academy talent scouting & recruitment journey (issue #790): the rules every scouting capability shares.
// A prospect is a Talent CRM entry (recruiter_list_entries) held under the athlete's live grant; a campaign only links to it. Nothing is copied:
// identity, evaluations, grants and consent are read live from their canonical tables on every call, so a revoked grant or withdrawn guardian
// consent takes effect on the next request. Contact details are never returned here.
import { one, many } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { orgFor } from './org-access.js';
import { STAFF } from './academy.js';
import { BASES, CRITERIA, grantState } from './recruiter.js';
import { isAdmin, audit } from './helpers.js';
import { decrypt } from './crypto.js';
import { ageOf, guardiansOf, isYouth } from './youth.js';
import { notify } from './notify.js';

export const OBJECTIVES = ['build_intake', 'scholarship', 'pathway_to_pro', 'talent_id', 'replace_departures'];
export const SCOUTING_MODES = ['open_trial_day', 'tournament', 'school_visit', 'club_visit', 'video_review'];
export const MEMBER_ROLES = ['scout', 'regional_lead', 'committee', 'chair', 'safeguarding_officer'];
export const VOTER_ROLES = ['committee', 'chair', 'safeguarding_officer'];
export const SCOUT_ROLES = ['scout', 'regional_lead'];
export const REFERRAL_KINDS = ['school', 'club', 'federation', 'coach', 'agent', 'event', 'open_day', 'self', 'other'];
export const ENTRY_STAGES = ['prospect', 'evaluated', 'committee', 'decided', 'invited', 'applied', 'enrolled', 'declined', 'withdrawn'];
export const LEVELS = ['grassroots', 'regional', 'state_national', 'pro_club_youth'];
export const SLA_KEYS = ['evaluate', 'committee', 'invite', 'trial'];
export const RESIDENCY = ['day', 'residential', 'either'];
export const CONTACT_POLICIES = ['via_guardian', 'via_academy', 'direct_adult_only'];

/** Weights over the platform's own evaluation criteria, so a campaign rubric and a scout's evaluation always speak the same language. */
export const rubricTotal = (rubric) => (rubric ?? []).reduce((t, r) => t + (Number(r.weight) || 0), 0);

/** Weighted 0-100 score of an evaluation under a campaign rubric (criteria the scout did not rate are left out and the rest re-weighted). */
export function weightedScore(rubric, ratings) {
  let w = 0, s = 0;
  for (const r of rubric ?? []) {
    const v = ratings?.[r.key];
    if (v == null) continue;
    w += r.weight; s += r.weight * ((v - 1) / 4);
  }
  return w ? Math.round((s / w) * 100) : null;
}

const isOrgStaff = (user, orgId, c) => orgFor(user, orgId, STAFF, { c }).then(() => true, () => false);

/**
 * The campaign and what the caller may do with it. 404 for anyone with no part in it (existence is not leaked).
 *   staff     owner/admin of the academy, or the campaign owner  -> manage everything
 *   roles     the caller's active campaign roles                  -> scout / committee / safeguarding
 */
export async function campaignFor(user, id, { c, lock = false } = {}) {
  const q = c ? (t, p) => c.query(t, p).then((x) => x.rows) : many;
  const [campaign] = await q(`SELECT * FROM academy_scouting_campaigns WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!campaign) throw notFound('Campaign');
  const roles = new Set((await q('SELECT role FROM academy_campaign_members WHERE campaign_id=$1 AND user_id=$2 AND removed_at IS NULL', [id, user.id])).map((r) => r.role));
  const staff = isAdmin(user) || campaign.owner_id === user.id || (await isOrgStaff(user, campaign.organisation_id, c));
  if (!staff && !roles.size) throw notFound('Campaign');
  return { campaign, staff, roles };
}
export const mayManage = (a) => { if (!a.staff) throw forbidden('Only the academy owner, an admin or the campaign owner can change a campaign'); };
export const mayScout = (a) => { if (!SCOUT_ROLES.some((r) => a.roles.has(r))) throw forbidden('You are not a scout on this campaign'); };
export const mayVote = (a) => { if (!VOTER_ROLES.some((r) => a.roles.has(r))) throw forbidden('You are not on this campaign\'s committee'); };
export const mayRead = (a) => a.staff || VOTER_ROLES.some((r) => a.roles.has(r)) || SCOUT_ROLES.some((r) => a.roles.has(r));

export const membersOf = (c, campaignId) => (c ? c.query.bind(c) : (t, p) => many(t, p).then((rows) => ({ rows })))(
  `SELECT m.id, m.user_id, m.role, m.region, m.capacity, u.display_name, u.handle FROM academy_campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 AND m.removed_at IS NULL ORDER BY m.role, u.display_name, m.id`, [campaignId]).then((r) => r.rows);

/** The youngest and oldest age the brief reaches on the day the campaign starts (null when the birth years are not set yet). */
export function bandAges(campaign) {
  const year = new Date(campaign.starts_on ?? new Date()).getUTCFullYear();
  if (campaign.birth_year_min == null || campaign.birth_year_max == null) return null;
  return { youngest: year - campaign.birth_year_max, oldest: year - campaign.birth_year_min };
}
export const reachesMinors = (campaign) => (bandAges(campaign)?.youngest ?? 99) < 18;
export const reachesUnder16 = (campaign) => (bandAges(campaign)?.youngest ?? 99) < 16;

/**
 * What still stops this campaign launching, and what is ready. Enforced by `launch` on the server; the app only shows it. Each item names the
 * wizard step that fixes it.
 */
export async function readiness(campaign, members) {
  const ready = [], blockers = [];
  const check = (ok, code, step, label, fix) => (ok ? ready : blockers).push(ok ? { code, step, label } : { code, step, label: fix ?? label });
  const by = (roles) => members.filter((m) => roles.includes(m.role));
  const voters = new Set(by(VOTER_ROLES).map((m) => m.user_id));
  check(!!campaign.name && !!campaign.objective, 'mandate', 1, 'Mandate set', 'Name the campaign and choose its objective');
  check(campaign.sport_ids.length > 0, 'sports', 1, `${campaign.sport_ids.length} sport(s)`, 'Choose at least one sport');
  const progs = campaign.programme_ids.length ? await many("SELECT id FROM academy_programmes WHERE id = ANY($1) AND organisation_id=$2 AND status='published'", [campaign.programme_ids, campaign.organisation_id]) : [];
  check(progs.length > 0 && progs.length === campaign.programme_ids.length, 'programme', 1, 'Feeds published programme(s)', 'Pick the published programme(s) this campaign feeds');
  check(!!campaign.target_places, 'target', 1, `${campaign.target_places} target places`, 'Set the number of target places');
  check(!!campaign.starts_on && !!campaign.ends_on && !!campaign.decision_by && campaign.decision_by >= campaign.ends_on, 'window', 1, 'Window and decision deadline set', 'Set the campaign window and a decision deadline on or after its end');
  check(!!campaign.owner_id, 'owner', 1, 'Campaign owner assigned', 'Assign a campaign owner');
  check(campaign.birth_year_min != null && campaign.birth_year_max != null, 'eligibility', 2, `Born ${campaign.birth_year_min}–${campaign.birth_year_max}`, 'Set the birth-year range');
  check(campaign.regions.length > 0, 'regions', 3, `${campaign.regions.length} region(s)`, 'Add at least one region');
  const uncovered = campaign.regions.filter((r) => !members.some((m) => SCOUT_ROLES.includes(m.role) && m.region === r));
  check(campaign.regions.length > 0 && !uncovered.length, 'coverage', 4, 'Every region has a lead or scout', `No lead or scout for ${uncovered.join(', ') || 'any region'}: assign one or remove the region`);
  check(by(['scout']).length > 0, 'scouts', 4, `${by(['scout']).length} scout(s)`, 'Assign at least one scout');
  const rubric = campaign.rubric ?? [];
  check(rubric.length >= 2 && rubricTotal(rubric) === 100, 'rubric', 5, 'Rubric weights total 100%', `Rubric weights total ${rubricTotal(rubric)}%: they must be 100% across at least two criteria`);
  check(!(campaign.required_bases.length && campaign.required_bases.every((b) => b === 'profile_only')), 'bases', 5, 'Evidence rules set', 'Evidence cannot rest on a profile alone');
  if (reachesMinors(campaign)) check(campaign.guardian_consent_required, 'consent', 6, 'Guardian consent required', 'This age band includes young people: guardian consent cannot be switched off');
  check(voters.size >= campaign.committee_quorum, 'committee', 7, `${voters.size} committee member(s) for quorum ${campaign.committee_quorum}`, `Committee has ${voters.size} member(s) but quorum is ${campaign.committee_quorum}`);
  if (reachesUnder16(campaign)) check(by(['safeguarding_officer']).length > 0, 'safeguarding_officer', 7, 'Safeguarding officer on the committee', 'A safeguarding officer must sit on the committee for under-16 campaigns');
  return { ready, blockers, pct: Math.round((ready.length / (ready.length + blockers.length)) * 100) };
}

/** Birth year from the encrypted date of birth. The decryption is audit-logged. */
export async function birthYearOf(c, athleteId, actorId) {
  const u = (await c.query('SELECT dob_enc FROM users WHERE id=$1', [athleteId])).rows[0];
  if (!u?.dob_enc) return null;
  await audit(c, actorId, 'read_pii', 'users', athleteId);
  return new Date(decrypt(u.dob_enc, 'users.dob')).getUTCFullYear();
}

/** A scout adds a prospect only when it fits the brief: sport, birth year, region, assigned scout, spare capacity. Everything it checks is live. */
export async function checkProspect(c, campaign, scoutMember, request, athleteId, actorId, region) {
  if (campaign.status !== 'active') throw conflict('This campaign is not open for new prospects');
  if (!campaign.sport_ids.includes(request.sport_id)) throw badRequest('This campaign does not scout that sport');
  if (region && !campaign.regions.includes(region)) throw badRequest('That region is not part of this campaign');
  const regions = scoutMember.map((m) => m.region).filter(Boolean);
  if (region && regions.length && !regions.includes(region)) throw forbidden('You are not assigned to that region');
  const year = await birthYearOf(c, athleteId, actorId);
  if (year == null) throw badRequest('This athlete has no date of birth on file, so eligibility cannot be checked');
  if (year < campaign.birth_year_min || year > campaign.birth_year_max) throw badRequest(`Outside the campaign's birth-year range (${campaign.birth_year_min}–${campaign.birth_year_max})`);
  const capacity = scoutMember.reduce((t, m) => t + (m.capacity ?? 0), 0);
  if (capacity) {
    const n = (await c.query("SELECT count(*)::int AS n FROM academy_campaign_entries WHERE campaign_id=$1 AND scout_id=$2 AND stage NOT IN ('declined','withdrawn')", [campaign.id, actorId])).rows[0].n;
    if (n >= capacity) throw conflict('You are at your prospect capacity for this campaign');
  }
  return { birth_year: year, age: ageOf(`${year}-07-01`) };
}

export const logEvent = (c, campaignId, entryId, kind, { from = null, to = null, actor = null, note = null } = {}) =>
  c.query('INSERT INTO academy_campaign_events(campaign_id, campaign_entry_id, kind, from_stage, to_stage, actor_id, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())', [campaignId, entryId, kind, from, to, actor, note]);

/** The grant behind a prospect, live right now (verification, window, revocation, guardian consent). Not cached. */
export async function liveState(row) {
  const g = await grantState({ id: row.request_id, status: row.grant_status, expires_at: row.grant_expires_at, recruiter_id: row.scout_id, athlete_id: row.athlete_id, granted_scopes: row.granted_scopes });
  return g;
}

export const ENTRY_SQL = `
  SELECT ce.*, e.request_id, r.status AS grant_status, r.expires_at AS grant_expires_at, r.granted_scopes, r.sport_id, s.slug AS sport_slug, s.name AS sport,
         (SELECT count(*)::int FROM academy_campaign_shares sh WHERE sh.campaign_entry_id=ce.id AND sh.round=ce.round) AS shared_evaluations,
         (SELECT count(DISTINCT v.voter_id)::int FROM academy_committee_votes v WHERE v.campaign_entry_id=ce.id AND v.round=ce.round) AS votes_cast,
         rs.name AS referral_source, rs.kind AS referral_kind
    FROM academy_campaign_entries ce JOIN recruiter_list_entries e ON e.id=ce.entry_id JOIN recruiter_access_requests r ON r.id=e.request_id JOIN sports s ON s.id=r.sport_id
    LEFT JOIN academy_referral_sources rs ON rs.id=ce.referral_source_id`;

/** An entry as the campaign sees it: the athlete's identity only while access is live; stage, region and source always (they are the academy's own record). */
export async function presentEntry(row, { withIdentity = true } = {}) {
  const g = await liveState(row);
  const { request_id, grant_status, grant_expires_at, granted_scopes, ...rest } = row;
  const base = { ...rest, access_live: g.live, access_note: g.live ? null : g.reason };
  if (!g.live || !withIdentity) return { ...base, athlete: null, athlete_id: undefined };
  const a = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [row.athlete_id]);
  return { ...base, athlete: { ...a, is_youth: await isYouth(row.athlete_id) } };
}

/** Tell the athlete (or the guardians of a young person) that scouting activity touched them. Generic wording only. */
export async function tellAthlete(c, athleteId, kind, title, data, dedupe) {
  const to = (await isYouth(athleteId, c)) ? await guardiansOf(athleteId, c) : [athleteId];
  for (const uid of to) await notify(c, uid, { kind: `academy_scouting_${kind}`, title, body: 'Open Gotmygame to see the details.', data, dedupe_key: `scouting:${kind}:${dedupe}:${uid}` });
}

export const stale = () => conflict('This was changed by someone else. Reload and try again.');
export { BASES, CRITERIA };
