// Academy talent scouting (issue #790), part 2: prospects, the committee and the hand-off to admissions, and recruitment outcome reporting.
// A prospect is a Talent CRM entry (recruiter_list_entries) under the athlete's live grant. Evaluations stay the scout's own until the scout submits
// a snapshot to the committee. An invitation creates (or links) a canonical academy application and carries the source and consent across;
// there is no second trial scheduler or admissions record. Every read re-checks the grant and guardian consent live: revocation hides a prospect at once.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt } from '../crypto.js';
import { toCsv } from '../csv.js';
import { orgFor } from '../org-access.js';
import { STAFF, insertCharges, lockProgramme, moveStage, seatsFree, tell } from '../academy.js';
import { grantState } from '../recruiter.js';
import { isYouth } from '../youth.js';
import {
  ENTRY_SQL, SCOUT_ROLES, VOTER_ROLES, campaignFor, checkProspect, logEvent, mayManage, mayRead, mayScout, presentEntry, stale, tellAthlete, weightedScore, liveState,
} from '../academy-scouting.js';

const TAG = 'Academy';
const version = z.number().int().min(1);
const text = (n) => z.string().trim().min(1).max(n);

const SELECT = `${ENTRY_SQL}`;
const EXTRA = `,
  (SELECT count(*)::int FROM recruiter_evaluations v WHERE v.entry_id=ce.entry_id AND v.archived_at IS NULL AND v.basis <> 'profile_only') AS evaluations,
  (SELECT array_agg(DISTINCT v.basis) FROM recruiter_evaluations v WHERE v.entry_id=ce.entry_id AND v.archived_at IS NULL) AS bases,
  app.stage AS application_stage`;
const BASE = SELECT.replace('FROM academy_campaign_entries ce', `${EXTRA}\n    FROM academy_campaign_entries ce`).replace('LEFT JOIN academy_referral_sources rs ON rs.id=ce.referral_source_id', 'LEFT JOIN academy_referral_sources rs ON rs.id=ce.referral_source_id LEFT JOIN academy_applications app ON app.id=ce.application_id');

/** Where the family stands on the canonical application, so the campaign never keeps a second copy of that status. */
export function journeyStage(row) {
  const s = row.application_stage;
  if (!s) return row.stage;
  if (s === 'enrolled') return 'enrolled';
  if (['declined', 'withdrawn', 'expired', 'cancelled'].includes(s)) return 'declined';
  if (['enquiry', 'trial_requested', 'trial_booked', 'trial_completed'].includes(s)) return 'invited';
  return 'applied';
}

/** The latest vote of each committee member in the current round. */
async function tally(c, row, campaign) {
  const q = (t, p) => (c ? c.query(t, p).then((r) => r.rows) : many(t, p));
  const votes = await q(
    `SELECT DISTINCT ON (v.voter_id) v.voter_id, v.vote, v.reason, v.created_at, u.display_name, m.role
       FROM academy_committee_votes v JOIN users u ON u.id=v.voter_id
       LEFT JOIN LATERAL (SELECT role FROM academy_campaign_members mm WHERE mm.campaign_id=$3 AND mm.user_id=v.voter_id AND mm.removed_at IS NULL AND mm.role = ANY($4) ORDER BY (mm.role='safeguarding_officer') DESC LIMIT 1) m ON true
      WHERE v.campaign_entry_id=$1 AND v.round=$2 ORDER BY v.voter_id, v.created_at DESC`, [row.id, row.round, campaign.id, VOTER_ROLES]);
  const voters = await q(`SELECT DISTINCT m.user_id, u.display_name FROM academy_campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 AND m.removed_at IS NULL AND m.role = ANY($2)
                          AND NOT EXISTS (SELECT 1 FROM academy_campaign_conflicts k WHERE k.campaign_id=m.campaign_id AND k.user_id=m.user_id AND k.athlete_id=$3) ORDER BY u.display_name, m.user_id`, [campaign.id, VOTER_ROLES, row.athlete_id]);
  const eligible = new Set(voters.map((v) => v.user_id));
  const counted = votes.filter((v) => eligible.has(v.voter_id));
  const n = (k) => counted.filter((v) => v.vote === k).length;
  return {
    votes: counted, advance: n('advance'), hold: n('hold'), decline: n('decline'), cast: counted.length, quorum: campaign.committee_quorum, rule: campaign.committee_rule,
    quorum_met: counted.length >= campaign.committee_quorum, pending: voters.filter((v) => !counted.some((x) => x.voter_id === v.user_id)).map((v) => ({ user_id: v.user_id, display_name: v.display_name })),
    safeguarding_decline: counted.some((v) => v.role === 'safeguarding_officer' && v.vote === 'decline'),
  };
}

/** What the committee decides from the votes: majority or unanimous; a safeguarding officer's decline stops an advance for a young person. */
export function outcomeOf(t, youth) {
  const total = t.cast;
  let out;
  if (t.rule === 'unanimous') out = t.advance === total ? 'advance' : t.decline > 0 ? 'decline' : 'hold';
  else out = t.advance * 2 > total ? 'advance' : t.decline * 2 > total ? 'decline' : 'hold';
  if (out === 'advance' && youth && t.safeguarding_decline) out = 'hold';
  return out;
}

/**
 * The prospect and what the caller may see of it. Scouts see their own prospects, regional leads their region's, committee members what has been submitted,
 * owners/admins everything. 404 for anyone else.
 */
async function entryFor(user, entryId, { c, lock = false } = {}) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows) : many;
  const [row] = await q(`${BASE} WHERE ce.id=$1`, [entryId]);
  if (!row) throw notFound('Prospect');
  const a = await campaignFor(user, row.campaign_id, { c, lock });
  const mine = row.scout_id === user.id;
  const regions = (await q("SELECT region FROM academy_campaign_members WHERE campaign_id=$1 AND user_id=$2 AND removed_at IS NULL AND role='regional_lead'", [row.campaign_id, user.id])).map((r) => r.region);
  const lead = regions.includes(row.region);
  const committee = VOTER_ROLES.some((r) => a.roles.has(r)) && row.submitted_at != null;
  if (!(a.staff || mine || lead || committee)) throw notFound('Prospect');
  if (lock && c) await c.query('SELECT id FROM academy_campaign_entries WHERE id=$1 FOR UPDATE', [entryId]);
  return { row, a, mine, lead, committee };
}

const present = async (row, view) => ({ ...(await presentEntry(row)), journey_stage: journeyStage(row), evaluations: row.evaluations, bases: view?.mine ? row.bases : undefined });

async function ownCrmEntry(user, entryId, c) {
  const e = (await c.query('SELECT e.*, l.recruiter_id FROM recruiter_list_entries e JOIN recruiter_lists l ON l.id=e.list_id WHERE e.id=$1 AND l.recruiter_id=$2 AND e.archived_at IS NULL', [entryId, user.id])).rows[0];
  if (!e) throw notFound('Talent CRM entry');
  return e;
}

// ------------------------------------------------------------------ prospects
cap({
  name: 'add_campaign_prospect', method: 'POST', path: '/academy/scouting/campaigns/:id/prospects', tag: TAG, status: 201,
  summary: 'A scout puts one of their Talent CRM entries (an athlete they hold a live grant for) into a campaign. The server checks the brief (sport, birth year, region you are assigned to, your capacity) and records the referral source. No athlete data is copied; adding the same entry twice returns the existing prospect.',
  input: z.object({ id, entry_id: id, referral_source_id: id.nullable().optional(), region: text(80).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campaignFor(user, i.id, { c, lock: true });
    mayScout(a);
    const e = await ownCrmEntry(user, i.entry_id, c);
    const request = (await c.query('SELECT * FROM recruiter_access_requests WHERE id=$1', [e.request_id])).rows[0];
    const g = await grantState(request);
    if (!g.live) throw forbidden('Access to this athlete is not active, so they cannot be put in a campaign');
    const dupe = (await c.query('SELECT id FROM academy_campaign_entries WHERE campaign_id=$1 AND entry_id=$2', [a.campaign.id, e.id])).rows[0];
    if (dupe) return { ...(await present((await c.query(`${BASE} WHERE ce.id=$1`, [dupe.id])).rows[0], { mine: true })), replayed: true };
    if ((await c.query("SELECT 1 FROM academy_campaign_entries WHERE campaign_id=$1 AND athlete_id=$2 AND stage NOT IN ('declined','withdrawn')", [a.campaign.id, e.athlete_id])).rows.length) throw conflict('This athlete is already a prospect in this campaign');
    if (i.referral_source_id && !(await c.query('SELECT 1 FROM academy_referral_sources WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.referral_source_id, a.campaign.organisation_id])).rows.length) throw badRequest('That referral source is not part of this academy');
    const mem = (await c.query("SELECT * FROM academy_campaign_members WHERE campaign_id=$1 AND user_id=$2 AND removed_at IS NULL AND role = ANY($3)", [a.campaign.id, user.id, SCOUT_ROLES])).rows;
    await checkProspect(c, a.campaign, mem, request, e.athlete_id, user.id, i.region ?? null);
    const row = (await c.query('INSERT INTO academy_campaign_entries(campaign_id, entry_id, athlete_id, scout_id, region, referral_source_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [a.campaign.id, e.id, e.athlete_id, user.id, i.region ?? null, i.referral_source_id ?? null])).rows[0];
    await logEvent(c, a.campaign.id, row.id, 'prospect_added', { to: 'prospect', actor: user.id });
    await tellAthlete(c, e.athlete_id, 'prospect_added', 'Scouting update', { campaign_id: a.campaign.id }, `${row.id}:added`);
    await audit(c, user.id, 'add_campaign_prospect', 'users', e.athlete_id);
    return present((await c.query(`${BASE} WHERE ce.id=$1`, [row.id])).rows[0], { mine: true });
  }),
});

cap({
  name: 'list_campaign_prospects', method: 'GET', path: '/academy/scouting/campaigns/:id/prospects', tag: TAG,
  summary: 'The campaign\'s prospects with stage, region, source and access state. Scouts see their own, regional leads their region, committee members what has been submitted, owners/admins everything. Athletes whose access has ended are shown as "access ended" without identity.',
  input: z.object({ id, stage: z.string().max(20).optional(), region: z.string().max(80).optional(), referral_source_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const a = await campaignFor(user, i.id);
    mayRead(a);
    const lead = (await many("SELECT region FROM academy_campaign_members WHERE campaign_id=$1 AND user_id=$2 AND removed_at IS NULL AND role='regional_lead'", [i.id, user.id])).map((r) => r.region);
    const committee = VOTER_ROLES.some((r) => a.roles.has(r));
    const rows = await many(
      `${BASE} WHERE ce.campaign_id=$1 AND ($2::text IS NULL OR ce.stage=$2) AND ($3::text IS NULL OR ce.region=$3) AND ($4::uuid IS NULL OR ce.referral_source_id=$4)
         AND ($5::boolean OR ce.scout_id=$6 OR ce.region = ANY($7) OR ($8::boolean AND ce.submitted_at IS NOT NULL)) ORDER BY ce.updated_at DESC, ce.id LIMIT $9 OFFSET $10`,
      [i.id, i.stage ?? null, i.region ?? null, i.referral_source_id ?? null, a.staff, user.id, lead, committee, i.limit, i.offset]);
    return Promise.all(rows.map((r) => present(r, { mine: r.scout_id === user.id })));
  },
});

cap({
  name: 'get_campaign_prospect', method: 'GET', path: '/academy/scouting/prospects/:id', tag: TAG,
  summary: 'The committee file for one prospect: guardian-consent state, the evaluations the scout submitted (ratings, basis and date as submitted; notes only when the scout released them, and reading them is audit-logged), authorised video links, votes with the tally and quorum, the decision log and the application it led to. When access has ended only the stage is shown.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { row, a, mine, committee } = await entryFor(user, i.id);
    const base = await present(row, { mine });
    const events = await many('SELECT kind, from_stage, to_stage, actor_id, note, created_at FROM academy_campaign_events WHERE campaign_entry_id=$1 ORDER BY created_at, id', [row.id]);
    if (!base.access_live) return { prospect: base, events, redacted: true };
    const youth = await isYouth(row.athlete_id);
    const campaign = a.campaign;
    const shares = await many('SELECT sh.id, sh.round, sh.snapshot, sh.notes_released, sh.created_at, sh.evaluation_id FROM academy_campaign_shares sh WHERE sh.campaign_entry_id=$1 ORDER BY sh.round, sh.created_at, sh.id', [row.id]);
    const evaluations = [];
    for (const s of shares) {
      let notes = null;
      if (s.notes_released && (a.staff || committee || mine)) {
        const ev = await one('SELECT notes_enc FROM recruiter_evaluations WHERE id=$1', [s.evaluation_id]);
        if (ev?.notes_enc) { notes = decrypt(ev.notes_enc, 'recruiter_evaluations.notes'); await audit(null, user.id, 'read_scouting_notes', 'users', row.athlete_id); }
      }
      evaluations.push({ id: s.id, round: s.round, ...s.snapshot, notes_released: s.notes_released, notes, shared_at: s.created_at });
    }
    const videos = await many(
      `SELECT pv.id, pv.title, pv.link_url, pv.created_at FROM academy_campaign_videos cv JOIN passport_videos pv ON pv.id=cv.passport_video_id
        WHERE cv.campaign_entry_id=$1 AND pv.status='approved' AND pv.removed_at IS NULL AND pv.link_url IS NOT NULL ORDER BY cv.created_at, cv.id`, [row.id]);
    const t = await tally(null, row, campaign);
    const conflicted = !!(await one('SELECT 1 FROM academy_campaign_conflicts WHERE campaign_id=$1 AND user_id=$2 AND athlete_id=$3', [campaign.id, user.id, row.athlete_id]));
    const isVoter = VOTER_ROLES.some((r) => a.roles.has(r));
    const own = t.votes.find((v) => v.voter_id === user.id) ?? null;
    const application = row.application_id ? await one('SELECT id, stage, programme_id, source_consent FROM academy_applications WHERE id=$1', [row.application_id]) : null;
    const consent = youth ? { required: true, current: true, note: 'A guardian\'s consent is current. If it is withdrawn this record disappears from the committee at once.' } : { required: false, current: true, note: 'Adult athlete: their own access grant is current.' };
    return {
      prospect: base, evaluations, videos: videos.map((v) => ({ id: v.id, title: v.title, url: v.link_url })), video_note: 'Links to the athlete\'s own coach-approved videos. Nothing is copied, and a link stops working when the athlete\'s access ends.',
      tally: { advance: t.advance, hold: t.hold, decline: t.decline, cast: t.cast, quorum: t.quorum, rule: t.rule, quorum_met: t.quorum_met, pending: t.pending },
      votes: a.staff || isVoter ? t.votes.map((v) => ({ voter_id: v.voter_id, voter: v.display_name, vote: v.vote, reason: v.reason, at: v.created_at })) : [],
      can_vote: isVoter && !conflicted && row.stage === 'committee', own_vote: own ? { vote: own.vote, reason: own.reason } : null, conflict_declared: conflicted,
      can_decide: (a.staff || a.roles.has('chair')) && row.stage === 'committee' && t.quorum_met,
      can_invite: a.staff && row.stage === 'decided' && row.decision === 'advance' && !row.application_id,
      outcome_if_decided: t.quorum_met ? outcomeOf(t, youth) : null,
      consent, application, events, programmes: campaign.programme_ids.length ? await many('SELECT id, title FROM academy_programmes WHERE id = ANY($1) ORDER BY title, id', [campaign.programme_ids]) : [], campaign: { id: campaign.id, name: campaign.name, rubric: campaign.rubric, min_evaluations: campaign.min_evaluations, required_bases: campaign.required_bases, programme_ids: campaign.programme_ids },
    };
  },
});

cap({
  name: 'submit_prospect_to_committee', method: 'POST', path: '/academy/scouting/prospects/:id/submit', tag: TAG,
  summary: 'The scout submits a prospect to the committee with a snapshot of chosen evaluations (the originals stay yours), whether to release your private notes, and authorised passport videos. The campaign\'s minimum evaluations and required evidence bases are enforced. The athlete (or guardian) is told in generic wording.',
  input: z.object({ id, row_version: version, evaluation_ids: z.array(id).min(1).max(10), release_notes: z.boolean().default(false), video_ids: z.array(id).max(5).default([]) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a, mine } = await entryFor(user, i.id, { c, lock: true });
    if (!mine) throw forbidden('Only the scout who holds this prospect can submit it');
    const cur = (await c.query('SELECT * FROM academy_campaign_entries WHERE id=$1', [row.id])).rows[0];
    if (cur.row_version !== i.row_version) throw stale();
    if (!['prospect', 'evaluated'].includes(cur.stage)) throw conflict('This prospect has already been submitted');
    if (a.campaign.status !== 'active') throw conflict('This campaign is not active');
    if (!(await liveState(row)).live) throw forbidden('Access to this athlete is not active');
    const evs = (await c.query('SELECT * FROM recruiter_evaluations WHERE id = ANY($1) AND entry_id=$2 AND archived_at IS NULL', [i.evaluation_ids, row.entry_id])).rows;
    if (evs.length !== new Set(i.evaluation_ids).size) throw badRequest('One of those evaluations is not yours or has been archived');
    const counting = evs.filter((e) => e.basis !== 'profile_only');
    if (counting.length < a.campaign.min_evaluations) throw conflict(`This campaign needs at least ${a.campaign.min_evaluations} evaluation(s) that rest on more than a profile`, { code: 'min_evaluations', needed: a.campaign.min_evaluations, have: counting.length });
    const missing = a.campaign.required_bases.filter((b) => !evs.some((e) => e.basis === b));
    if (missing.length) throw conflict(`The submitted evaluations must include: ${missing.join(', ').replaceAll('_', ' ')}`, { code: 'required_bases', missing });
    if (a.campaign.notes_private === false && i.release_notes === false) throw badRequest('This campaign expects notes to be released to the committee');
    const vids = i.video_ids.length ? (await c.query("SELECT id FROM passport_videos WHERE id = ANY($1) AND user_id=$2 AND status='approved' AND removed_at IS NULL AND link_url IS NOT NULL", [i.video_ids, row.athlete_id])).rows : [];
    if (vids.length !== new Set(i.video_ids).size) throw badRequest('A video is not available: only the athlete\'s own coach-approved video links can be referenced');
    for (const e of evs) {
      const snapshot = { basis: e.basis, observed_on: new Date(e.observed_on).toISOString().slice(0, 10), ratings: e.ratings, overall: e.overall, weighted: weightedScore(a.campaign.rubric, e.ratings), scout_id: row.scout_id };
      await c.query('INSERT INTO academy_campaign_shares(campaign_entry_id, evaluation_id, round, snapshot, notes_released, shared_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [row.id, e.id, cur.round, snapshot, i.release_notes, user.id]);
    }
    for (const v of vids) await c.query('INSERT INTO academy_campaign_videos(campaign_entry_id, passport_video_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, v.id, user.id]);
    const up = (await c.query("UPDATE academy_campaign_entries SET stage='committee', submitted_at=coalesce(submitted_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
    await logEvent(c, a.campaign.id, row.id, 'submitted', { from: cur.stage, to: 'committee', actor: user.id, note: `${evs.length} evaluation(s), notes ${i.release_notes ? 'released' : 'kept private'}` });
    await tellAthlete(c, row.athlete_id, 'committee', 'Scouting update', { campaign_id: a.campaign.id }, `${row.id}:${cur.round}:committee`);
    await audit(c, user.id, 'submit_prospect_to_committee', 'users', row.athlete_id);
    return present((await c.query(`${BASE} WHERE ce.id=$1`, [up.id])).rows[0], { mine: true });
  }),
});

cap({
  name: 'cast_committee_vote', method: 'POST', path: '/academy/scouting/prospects/:id/votes', tag: TAG, status: 201,
  summary: 'A committee member votes advance, hold or decline on a submitted prospect (a reason is required to decline). Votes are append-only: changing your mind adds a vote, the latest one counts, and the history stays. Members with a declared conflict cannot vote, and nothing can be voted on once access to the athlete has ended.',
  input: z.object({ id, vote: z.enum(['advance', 'hold', 'decline']), reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a } = await entryFor(user, i.id, { c, lock: true });
    if (!VOTER_ROLES.some((r) => a.roles.has(r))) throw forbidden('You are not on this campaign\'s committee');
    if (row.stage !== 'committee') throw conflict('This prospect is not awaiting a committee vote');
    if (!(await liveState(row)).live) throw conflict('Access to this athlete has ended, so no vote can be taken');
    if ((await c.query('SELECT 1 FROM academy_campaign_conflicts WHERE campaign_id=$1 AND user_id=$2 AND athlete_id=$3', [a.campaign.id, user.id, row.athlete_id])).rows.length) throw forbidden('You declared a conflict of interest for this athlete');
    if (i.vote === 'decline' && !i.reason) throw badRequest('Give a reason for declining');
    await c.query('INSERT INTO academy_committee_votes(campaign_entry_id, round, voter_id, vote, reason) VALUES ($1,$2,$3,$4,$5)', [row.id, row.round, user.id, i.vote, i.reason ?? null]);
    await logEvent(c, a.campaign.id, row.id, 'vote', { actor: user.id, note: i.vote });
    await audit(c, user.id, 'cast_committee_vote', 'users', row.athlete_id);
    const t = await tally(c, row, a.campaign);
    return { vote: i.vote, cast: t.cast, quorum: t.quorum, quorum_met: t.quorum_met, advance: t.advance, hold: t.hold, decline: t.decline };
  }),
});

cap({
  name: 'declare_campaign_conflict', method: 'POST', path: '/academy/scouting/prospects/:id/conflict', tag: TAG, status: 201,
  summary: 'Declare a conflict of interest (a relationship with this athlete, their family or their agent). It excludes you from voting on them and is kept on the record.',
  input: z.object({ id, reason: text(300).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a } = await entryFor(user, i.id, { c });
    await c.query('INSERT INTO academy_campaign_conflicts(campaign_id, user_id, athlete_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (campaign_id, user_id, athlete_id) DO NOTHING', [a.campaign.id, user.id, row.athlete_id, i.reason]);
    await logEvent(c, a.campaign.id, row.id, 'conflict_declared', { actor: user.id });
    return { declared: true };
  }),
});

cap({
  name: 'decide_campaign_prospect', method: 'POST', path: '/academy/scouting/prospects/:id/decision', tag: TAG,
  summary: 'Close the committee round once quorum has voted (chair, owner or admin). The outcome is computed from the votes by the campaign\'s rule (majority or unanimous; a safeguarding officer\'s decline stops an advance for a young person) and recorded with the tally. "Advance" can then be invited; "hold" returns the prospect for more evidence and opens a new round; "decline" closes it.',
  input: z.object({ id, row_version: version, note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a } = await entryFor(user, i.id, { c, lock: true });
    if (!(a.staff || a.roles.has('chair'))) throw forbidden('Only the chair, the campaign owner or an academy admin closes a vote');
    const cur = (await c.query('SELECT * FROM academy_campaign_entries WHERE id=$1', [row.id])).rows[0];
    if (cur.row_version !== i.row_version) throw stale();
    if (cur.stage !== 'committee') throw conflict('This prospect is not awaiting a decision');
    if (!(await liveState(row)).live) throw conflict('Access to this athlete has ended, so no decision can be taken');
    const t = await tally(c, row, a.campaign);
    if (!t.quorum_met) throw conflict(`Quorum is ${t.quorum} and ${t.cast} member(s) have voted`, { code: 'quorum_not_met', cast: t.cast, quorum: t.quorum });
    const youth = await isYouth(row.athlete_id, c);
    const out = outcomeOf(t, youth);
    const stage = out === 'advance' ? 'decided' : out === 'decline' ? 'declined' : 'evaluated';
    const up = (await c.query(
      `UPDATE academy_campaign_entries SET stage=$2, decision=$3, decision_note=$4, decided_by=$5, decided_at=now(), round=CASE WHEN $3='hold' THEN round+1 ELSE round END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, stage, out, i.note ?? null, user.id])).rows[0];
    await logEvent(c, a.campaign.id, row.id, 'decision', { from: 'committee', to: stage, actor: user.id, note: `${out}: ${t.advance} advance, ${t.hold} hold, ${t.decline} decline (quorum ${t.quorum}, ${t.rule})${youth && t.safeguarding_decline && out === 'hold' ? ' - safeguarding officer declined' : ''}` });
    await audit(c, user.id, 'decide_campaign_prospect', 'users', row.athlete_id);
    return { outcome: out, stage: up.stage, tally: { advance: t.advance, hold: t.hold, decline: t.decline, cast: t.cast, quorum: t.quorum }, row_version: up.row_version };
  }),
});

cap({
  name: 'invite_campaign_prospect', method: 'POST', path: '/academy/scouting/prospects/:id/invite', tag: TAG, status: 201,
  summary: 'After an advance decision, invite the prospect into the academy\'s existing admissions flow: a trial (the family books a session on the academy timetable) or an offered place. This creates the canonical academy application with the campaign, referral source, region and the consent in force recorded on it, or links the application the athlete already has. Owner/admin only; guardian consent and live access are required for young people.',
  input: z.object({ id, row_version: version, programme_id: id, mode: z.enum(['trial', 'offer']), cohort_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a } = await entryFor(user, i.id, { c, lock: true });
    mayManage(a);
    const cur = (await c.query('SELECT * FROM academy_campaign_entries WHERE id=$1', [row.id])).rows[0];
    if (cur.application_id) {
      const app = (await c.query('SELECT id, stage, row_version FROM academy_applications WHERE id=$1', [cur.application_id])).rows[0];
      return { application_id: app.id, stage: app.stage, linked_existing: true, replayed: true };
    }
    if (cur.row_version !== i.row_version) throw stale();
    if (cur.stage !== 'decided' || cur.decision !== 'advance') throw conflict('The committee has to decide to advance this prospect before an invitation');
    const live = await liveState(row);
    if (!live.live) throw conflict('Access to this athlete has ended or guardian consent is no longer current, so they cannot be invited');
    if (!a.campaign.programme_ids.includes(i.programme_id)) throw badRequest('Invite into one of the programmes this campaign feeds');
    const p = await lockProgramme(c, i.programme_id);
    if (p.organisation_id !== a.campaign.organisation_id || p.status !== 'published') throw conflict('That programme is not published');
    const v = (await c.query('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [p.id, p.current_version])).rows[0];
    if (!v) throw conflict('Publish the programme terms first');
    if (i.cohort_id && !(await c.query("SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.cohort_id, p.organisation_id])).rows.length) throw badRequest('That group is not part of this academy');
    if (i.mode === 'trial' && !p.trial_enabled) throw conflict('This programme does not offer a trial');
    if (i.mode === 'offer' && (await seatsFree(c, p)) <= 0) throw conflict('No place is free in that programme');
    // the consent in force, recorded on the application so the source of this invitation stays provable
    const request = (await c.query('SELECT id, decided_by, decided_at, purpose FROM recruiter_access_requests WHERE id=$1', [row.request_id])).rows[0];
    const youth = await isYouth(row.athlete_id, c);
    const gc = youth ? (await c.query("SELECT granted_by, granted_at FROM youth_consents WHERE child_id=$1 AND purpose='recruitment'", [row.athlete_id])).rows[0] : null;
    const consent = { purpose: 'recruitment', status: 'current', request_id: request.id, athlete_grant_decided_by: request.decided_by, athlete_grant_decided_at: request.decided_at, guardian_consent: youth ? { granted_by: gc?.granted_by ?? null, granted_at: gc?.granted_at ?? null } : null, captured_at: new Date().toISOString() };
    const existing = (await c.query("SELECT * FROM academy_applications WHERE programme_id=$1 AND athlete_id=$2 AND stage NOT IN ('declined','withdrawn','expired','cancelled') FOR UPDATE", [p.id, row.athlete_id])).rows[0];
    let app;
    const src = [a.campaign.id, row.id, row.referral_source_id, row.region, JSON.stringify(consent)];
    if (existing) {
      app = (await c.query('UPDATE academy_applications SET source_kind=coalesce(source_kind,$2), source_campaign_id=coalesce(source_campaign_id,$3), source_entry_id=coalesce(source_entry_id,$4), source_referral_id=coalesce(source_referral_id,$5), source_region=coalesce(source_region,$6), source_consent=coalesce(source_consent,$7), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [existing.id, 'scouting', ...src])).rows[0];
    } else if (i.mode === 'offer') {
      app = (await c.query("INSERT INTO academy_applications(organisation_id, programme_id, version_id, athlete_id, applicant_id, stage, offer_expires_at, cohort_id, source_kind, source_campaign_id, source_entry_id, source_referral_id, source_region, source_consent) VALUES ($1,$2,$3,$4,$4,'offered',$5,$6,'scouting',$7,$8,$9,$10,$11) RETURNING *",
        [p.organisation_id, p.id, v.id, row.athlete_id, new Date(Date.now() + v.offer_valid_hours * 3600e3), i.cohort_id ?? null, ...src])).rows[0];
      await c.query("INSERT INTO academy_application_events(application_id, to_stage, actor_id, reason) VALUES ($1,'offered',$2,'Invitation from scouting campaign')", [app.id, user.id]);
      await tell(c, app, 'offer', 'You have been offered a place');
    } else {
      const e0 = (await c.query("INSERT INTO academy_applications(organisation_id, programme_id, version_id, athlete_id, applicant_id, stage, cohort_id, source_kind, source_campaign_id, source_entry_id, source_referral_id, source_region, source_consent) VALUES ($1,$2,$3,$4,$4,'enquiry',$5,'scouting',$6,$7,$8,$9,$10) RETURNING *",
        [p.organisation_id, p.id, v.id, row.athlete_id, i.cohort_id ?? null, ...src])).rows[0];
      await c.query("INSERT INTO academy_application_events(application_id, to_stage, actor_id, reason) VALUES ($1,'enquiry',$2,'Invitation from scouting campaign')", [e0.id, user.id]);
      app = await moveStage(c, e0, 'trial_requested', { actor: user.id, reason: 'Trial offered by a scouting campaign' });
      if (Number(v.trial_fee_minor) > 0) await insertCharges(c, { applicationId: app.id, orgId: app.organisation_id, payerId: app.applicant_id, rows: [{ kind: 'trial', due_on: new Date().toISOString().slice(0, 10), currency: v.currency, gross_minor: Number(v.trial_fee_minor), discount_minor: 0, funded_minor: 0, tax_minor: 0, amount_minor: Number(v.trial_fee_minor), terms: { version: v.version } }] });
      await tell(c, app, 'trial_requested', 'You have been invited to a trial');
    }
    await c.query("UPDATE academy_campaign_entries SET stage='invited', application_id=$2, invited_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1", [row.id, app.id]);
    await logEvent(c, a.campaign.id, row.id, 'invited', { from: 'decided', to: 'invited', actor: user.id, note: `${i.mode} into ${p.title}${existing ? ' (linked to the existing application)' : ''}` });
    await audit(c, user.id, 'invite_campaign_prospect', 'academy_applications', app.id);
    return { application_id: app.id, stage: app.stage, mode: i.mode, linked_existing: !!existing };
  }),
});

cap({
  name: 'withdraw_campaign_prospect', method: 'POST', path: '/academy/scouting/prospects/:id/withdraw', tag: TAG,
  summary: 'The scout or an academy admin takes a prospect out of the campaign. The record, its evaluations and votes stay for the audit trail; the athlete can be added again later.',
  input: z.object({ id, row_version: version, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { row, a, mine } = await entryFor(user, i.id, { c, lock: true });
    if (!(mine || a.staff)) throw forbidden('Only the scout or an academy admin can withdraw a prospect');
    const cur = (await c.query('SELECT * FROM academy_campaign_entries WHERE id=$1', [row.id])).rows[0];
    if (cur.row_version !== i.row_version) throw stale();
    if (['invited', 'applied', 'enrolled', 'declined', 'withdrawn'].includes(cur.stage) || cur.application_id) throw conflict('This prospect has moved on and cannot be withdrawn here');
    const up = (await c.query("UPDATE academy_campaign_entries SET stage='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
    await logEvent(c, a.campaign.id, row.id, 'withdrawn', { from: cur.stage, to: 'withdrawn', actor: user.id, note: i.reason ?? null });
    return { stage: up.stage, row_version: up.row_version };
  }),
});

// ------------------------------------------------------------------ outcome reporting
const median = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const days = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 864e5 * 10) / 10) : null);
const APPLIED = ['application_draft', 'submitted', 'under_review', 'offered', 'waitlisted', 'offer_accepted', 'enrolled'];

async function buildReport(user, orgId, { campaign_id, region, referral_source_id, from, to }) {
  let campaigns;
  if (campaign_id) {
    const a = await campaignFor(user, campaign_id);
    mayRead(a);
    if (a.campaign.organisation_id !== orgId) throw notFound('Campaign');
    campaigns = [a.campaign];
  } else {
    await orgFor(user, orgId, STAFF);
    campaigns = await many("SELECT * FROM academy_scouting_campaigns WHERE organisation_id=$1 AND status <> 'draft' ORDER BY created_at DESC, id", [orgId]);
  }
  const ids = campaigns.map((c) => c.id);
  const rows = ids.length ? await many(
    `SELECT ce.id, ce.campaign_id, ce.scout_id, ce.region, ce.referral_source_id, ce.stage, ce.decision, ce.created_at, ce.updated_at, ce.submitted_at, ce.decided_at, ce.invited_at, app.stage AS app_stage, rs.name AS source_name, rs.kind AS source_kind
       FROM academy_campaign_entries ce LEFT JOIN academy_applications app ON app.id=ce.application_id LEFT JOIN academy_referral_sources rs ON rs.id=ce.referral_source_id
      WHERE ce.campaign_id = ANY($1) AND ($2::text IS NULL OR ce.region=$2) AND ($3::uuid IS NULL OR ce.referral_source_id=$3) AND ($4::date IS NULL OR ce.created_at::date >= $4) AND ($5::date IS NULL OR ce.created_at::date <= $5)`,
    [ids, region ?? null, referral_source_id ?? null, from ?? null, to ?? null]) : [];
  const step = (r) => ({ prospects: 1, committee: r.submitted_at ? 1 : 0, advanced: r.decision === 'advance' || r.invited_at ? 1 : 0, invited: r.invited_at ? 1 : 0, applied: APPLIED.includes(r.app_stage) ? 1 : 0, enrolled: r.app_stage === 'enrolled' ? 1 : 0 });
  const add = (t, r) => { for (const [k, v] of Object.entries(step(r))) t[k] = (t[k] ?? 0) + v; return t; };
  const funnel = rows.reduce(add, { prospects: 0, committee: 0, advanced: 0, invited: 0, applied: 0, enrolled: 0 });
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); const g = m.get(k) ?? { key: k, label: labelFn(r), prospects: 0, committee: 0, advanced: 0, invited: 0, applied: 0, enrolled: 0 }; add(g, r); m.set(k, g); }
    return [...m.values()].sort((p, q) => q.prospects - p.prospects || String(p.label).localeCompare(q.label));
  };
  const members = ids.length ? await many("SELECT m.campaign_id, m.user_id, m.role, m.region, m.capacity, u.display_name FROM academy_campaign_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id = ANY($1) AND m.removed_at IS NULL", [ids]) : [];
  const regions = [...new Set(campaigns.flatMap((c) => c.regions))].sort();
  const by_region = regions.map((rg) => {
    const g = group((r) => r.region, (r) => r.region).find((x) => x.key === rg) ?? { key: rg, label: rg, prospects: 0, committee: 0, advanced: 0, invited: 0, applied: 0, enrolled: 0 };
    const scouts = new Set(members.filter((m) => m.region === rg && SCOUT_ROLES.includes(m.role)).map((m) => m.user_id));
    return { ...g, scouts: scouts.size, coverage_gap: scouts.size === 0 };
  });
  const scoutCap = new Map();
  for (const m of members.filter((x) => SCOUT_ROLES.includes(x.role))) { const s = scoutCap.get(m.user_id) ?? { user_id: m.user_id, name: m.display_name, capacity: 0 }; s.capacity += m.capacity ?? 0; scoutCap.set(m.user_id, s); }
  const by_scout = [...scoutCap.values()].map((s) => ({ ...s, prospects: rows.filter((r) => r.scout_id === s.user_id && r.stage !== 'withdrawn').length, submitted: rows.filter((r) => r.scout_id === s.user_id && r.submitted_at).length }));
  const by_source = group((r) => r.referral_source_id ?? 'none', (r) => r.source_name ?? 'Unattributed').map((g) => ({ ...g, kind: rows.find((r) => (r.referral_source_id ?? 'none') === g.key)?.source_kind ?? null }));
  const now = Date.now();
  const sla = campaigns.map((c) => {
    const s = c.sla_days ?? {};
    const over = (cond, d) => (d ? rows.filter((r) => r.campaign_id === c.id && cond(r) && (now - new Date(r.updated_at ?? r.created_at)) / 864e5 > d).length : null);
    return { campaign_id: c.id, name: c.name, sla_days: s,
      overdue: { evaluate: over((r) => r.stage === 'prospect', s.evaluate), committee: over((r) => r.stage === 'committee', s.committee), invite: over((r) => r.stage === 'decided', s.invite) } };
  });
  return {
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, target_places: c.target_places, pipeline_target: c.pipeline_target })),
    funnel, conversion: { prospect_to_enrolled: funnel.prospects ? Math.round((funnel.enrolled / funnel.prospects) * 100) : null, invited_to_enrolled: funnel.invited ? Math.round((funnel.enrolled / funnel.invited) * 100) : null },
    median_days: { prospect_to_submitted: median(rows.map((r) => days(r.created_at, r.submitted_at))), submitted_to_decision: median(rows.map((r) => days(r.submitted_at, r.decided_at))), decision_to_invite: median(rows.map((r) => days(r.decided_at, r.invited_at))) },
    by_source, by_region, by_scout, sla, targets: { places: campaigns.reduce((t, c) => t + (c.target_places ?? 0), 0), pipeline: campaigns.reduce((t, c) => t + (c.pipeline_target ?? 0), 0) },
    note: 'Counts only: no athlete is named. Young people appear as numbers, never as names, in this report and its export.',
  };
}
const REPORT_IN = { id, campaign_id: id.optional(), region: z.string().max(80).optional(), referral_source_id: id.optional(), from: z.string().date().optional(), to: z.string().date().optional() };

cap({
  name: 'get_academy_scouting_report', method: 'GET', path: '/organisations/:id/academy/scouting/report', tag: TAG,
  summary: 'Recruitment outcomes from the canonical records: the funnel (prospect, committee, advanced, invited, applied, enrolled), conversion, median days between steps, results by referral source, region (with coverage gaps) and scout (against capacity), and campaigns running past their SLA. Counts only, never names. Owner/admin, or a member of the campaign when one campaign is asked for.',
  input: z.object(REPORT_IN),
  handler: ({ user }, { id: orgId, ...f }) => buildReport(user, orgId, f),
});

cap({
  name: 'export_academy_scouting_report', method: 'GET', path: '/organisations/:id/academy/scouting/report/export', tag: TAG,
  summary: 'The recruitment outcome report as CSV: one row per referral source and per region, counts only (no athlete names). The export is audit-logged.',
  input: z.object(REPORT_IN),
  async handler({ user }, { id: orgId, ...f }) {
    const r = await buildReport(user, orgId, f);
    const rows = [...r.by_source.map((g) => ({ scope: 'referral_source', name: g.label, ...g })), ...r.by_region.map((g) => ({ scope: 'region', name: g.label, ...g }))];
    await audit(null, user.id, 'export_scouting_report', 'organisations', orgId);
    return { filename: 'scouting-outcomes.csv', rows: rows.length, csv: toCsv(['scope', 'name', 'prospects', 'committee', 'advanced', 'invited', 'applied', 'enrolled'], rows) };
  },
});

// ------------------------------------------------------------------ helpers for the scout's own Talent CRM screen
cap({
  name: 'get_my_prospect_for_entry', method: 'GET', path: '/me/scouting/entries/:entry_id', tag: TAG,
  summary: 'Is this Talent CRM entry (one of your own) a prospect in a scouting campaign? Returns the campaign, stage and what the committee needs from you (evaluations to submit), or null.',
  input: z.object({ entry_id: id }),
  async handler({ user }, i) {
    const own = await one('SELECT e.id FROM recruiter_list_entries e JOIN recruiter_lists l ON l.id=e.list_id WHERE e.id=$1 AND l.recruiter_id=$2', [i.entry_id, user.id]);
    if (!own) throw notFound('Talent CRM entry');
    const row = await one(`${BASE} WHERE ce.entry_id=$1 AND ce.stage NOT IN ('declined','withdrawn') ORDER BY ce.created_at DESC LIMIT 1`, [i.entry_id]);
    if (!row) return null;
    const c = await one('SELECT id, name, min_evaluations, required_bases, status FROM academy_scouting_campaigns WHERE id=$1', [row.campaign_id]);
    return { id: row.id, stage: row.stage, journey_stage: journeyStage(row), row_version: row.row_version, round: row.round, region: row.region, evaluations: row.evaluations, campaign: c };
  },
});

cap({
  name: 'list_prospect_video_options', method: 'GET', path: '/academy/scouting/prospects/:id/video-options', tag: TAG,
  summary: 'The athlete\'s own coach-approved video links a scout may reference when submitting a prospect (only while access is live). Links only; nothing is copied.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { row, mine } = await entryFor(user, i.id);
    if (!mine) throw forbidden('Only the scout who holds this prospect can choose videos');
    if (!(await liveState(row)).live) throw forbidden('Access to this athlete is not active');
    return many("SELECT id, title, link_url AS url FROM passport_videos WHERE user_id=$1 AND status='approved' AND removed_at IS NULL AND link_url IS NOT NULL ORDER BY created_at DESC, id LIMIT 50", [row.athlete_id]);
  },
});
