// Sporting discipline & governance cases (#479 / #563). ONE case table (gov_cases) for discipline, appeals, protests, eligibility disputes, licence issues and
// waivers; sanctions and service live in disc_sanctions. Canonical match events stay the evidence: a case holds a REFERENCE to the event, never a second
// incident log, and a decision never edits a score or an official's record (a points deduction goes through the competition adjustment mechanism).
// Suspensions are read live by the eligibility engine, served matches are derived from completed fixtures, every step lands in append-only gov_case_events.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { guardianLink, guardiansOf, isYouth } from '../youth.js';
import { authority, can } from '../federation.js';
import { canManageTeam } from './teams.js';
import { canManageCompetition, readComp, manageComp } from './competitions.js';
import { POLICY, SANCTION_KINDS, FINE_FLOW, thresholdFor, appealDeadline, modelFor } from '../discipline.js';
import { serviceFor } from '../discipline-live.js';

const TAG = 'Discipline';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v == null ? null : String(v).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const stale = (k) => conflict(`This case was changed (now version ${k.row_version}); reload and try again`, { code: 'stale_version', current_version: k.row_version });
const log = (c, k, action, actor, { from = null, to = null, detail = {} } = {}) =>
  c.query('INSERT INTO gov_case_events(case_id,version,action,from_status,to_status,actor_id,detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [k.id, k.row_version, action, from, to, actor, detail]);
const lockCase = async (c, cid) => { const k = (await c.query('SELECT * FROM gov_cases WHERE id=$1 FOR UPDATE', [cid])).rows[0]; if (!k) throw notFound('Case'); return k; };
const latestPolicy = async (c, competitionId) => (await c.query('SELECT * FROM disc_policies WHERE competition_id=$1 ORDER BY version DESC LIMIT 1', [competitionId])).rows[0] ?? null;
const policyOf = (row) => POLICY.parse(row?.rules ?? {});

/** The competition of a case plus the caller's standing. A competition without a case context falls back to platform staff only. */
async function ctxOf(c, user, k) {
  const cm = k.competition_id ? (await c.query('SELECT * FROM comp_competitions WHERE id=$1', [k.competition_id])).rows[0] : null;
  const body = cm?.organisation_id ? (await c.query('SELECT id FROM governing_bodies WHERE organisation_id=$1', [cm.organisation_id])).rows[0] : null;
  let staff = isAdmin(user) || (cm ? await canManageCompetition(user, cm, c) : false);
  if (!staff && body) { const a = await authority(user, body.id, { c, optional: true }); staff = can(a, 'sanctions', k.sport_id); }
  return { cm, staff };
}
async function canSee(c, user, k, x) {
  if (x.staff || user.id === k.opened_by || user.id === k.subject_user_id) return true;
  if (k.subject_user_id && (await guardianLink(user.id, k.subject_user_id, c))) return true;
  if (k.subject_team_id) { const t = (await c.query('SELECT * FROM teams WHERE id=$1', [k.subject_team_id])).rows[0]; if (t && (await canManageTeam(user, t))) return true; }
  return false;
}
const mustSee = async (c, user, k) => { const x = await ctxOf(c, user, k); if (!(await canSee(c, user, k, x))) throw notFound('Case'); return x; };

async function sanctionsOf(c, caseId, { withService = true } = {}) {
  const rows = (await c.query('SELECT * FROM disc_sanctions WHERE case_id=$1 ORDER BY decided_at, id', [caseId])).rows;
  const out = [];
  for (const s of rows) {
    const service = withService && s.kind === 'match_suspension' && s.status !== 'overturned' ? await serviceFor(c, s) : null;
    const { reason_enc, ...rest } = s;
    out.push({ ...rest, starts_on: ymd(s.starts_on), ends_on: ymd(s.ends_on), reason: reason_enc ? decrypt(reason_enc, 'disc_sanctions.reason') : null, service });
  }
  return out;
}
async function present(c, user, k, x) {
  const { summary_enc, decision_enc, ...rest } = k;
  const events = (await c.query('SELECT version, action, from_status, to_status, actor_id, detail, created_at FROM gov_case_events WHERE case_id=$1 ORDER BY created_at, id', [k.id])).rows;
  const links = (await c.query('SELECT entity_type, entity_id, created_at FROM gov_case_links WHERE case_id=$1 ORDER BY created_at', [k.id])).rows;
  const subj = k.subject_user_id ? (await c.query('SELECT display_name FROM users WHERE id=$1', [k.subject_user_id])).rows[0] : null;
  const youth = k.subject_user_id ? await isYouth(k.subject_user_id, c) : false;
  const policy = k.policy_id ? (await c.query('SELECT version, rules FROM disc_policies WHERE id=$1', [k.policy_id])).rows[0] : null;
  return {
    ...rest, appeal_deadline: ymd(k.appeal_deadline), subject_name: subj?.display_name ?? null, subject_is_youth: youth,
    summary: summary_enc ? decrypt(summary_enc, 'gov_cases.summary') : null, decision: decision_enc ? decrypt(decision_enc, 'gov_cases.decision') : null,
    sanctions: await sanctionsOf(c, k.id), events, links, policy, can_decide: x.staff,
    appeal_open: k.status === 'decided' && !!k.appeal_deadline && ymd(k.appeal_deadline) >= today(),
  };
}

// ------------------------------------------------------------------ policy
cap({
  name: 'publish_discipline_policy', method: 'POST', path: '/competitions/:id/discipline-policy', tag: TAG, status: 201, auth: ['organizer', 'admin'],
  summary: 'Publish a new, immutable version of a competition\'s disciplinary policy: caution accumulation thresholds, the dismissal rule, scope, carry-over, appeal window and stay, and what the panel may impose. Earlier cases keep the version they were opened under.',
  input: z.object({ id, rules: POLICY, note: z.string().trim().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cm = await manageComp(c, user, i.id, { lock: true });
    const version = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM disc_policies WHERE competition_id=$1', [cm.id])).rows[0].v;
    const r = (await c.query('INSERT INTO disc_policies(competition_id,version,rules,note,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [cm.id, version, i.rules, i.note ?? null, user.id])).rows[0];
    await audit(c, user.id, 'discipline.policy_publish', 'competition', cm.id);
    return r;
  }),
});

cap({
  name: 'get_discipline_policy', method: 'GET', path: '/competitions/:id/discipline-policy', tag: TAG, auth: 'public',
  summary: 'The current disciplinary policy of a competition, its version history and the sport\'s discipline vocabulary (cards, offence levels, code violations …); a sport with no native vocabulary says so and uses a labelled generic fallback.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const { cm } = await readComp(pool, user, i.id);
    const sport = (await pool.query('SELECT id, slug, name, scoring, category FROM sports WHERE id=$1', [cm.sport_id])).rows[0];
    const versions = await many('SELECT version, rules, note, created_at FROM disc_policies WHERE competition_id=$1 ORDER BY version DESC', [cm.id]);
    return { competition_id: cm.id, sport: { id: sport.id, slug: sport.slug, name: sport.name }, vocabulary: modelFor(sport), current: versions[0] ?? null, versions };
  },
});

// ------------------------------------------------------------------ opening a case from a canonical incident
const subjectIn = z.object({ subject_user_id: id.optional(), subject_team_id: id.optional(), subject_role: z.enum(['player', 'coach', 'official', 'team', 'organisation']).default('player') });
cap({
  name: 'open_discipline_case', method: 'POST', path: '/discipline/cases', tag: TAG, status: 201,
  summary: 'Open a disciplinary case from a canonical match event or an official\'s report (or a manual referral by competition staff). The case REFERENCES the incident; cautions accumulate under the policy version and reaching a threshold issues the suspension automatically; a dismissal can set an interim suspension that is shown as interim, never as a finding. Retrying the same incident returns the same case.',
  input: z.object({
    competition_id: id, season_id: id.optional(), fixture_id: id.optional(), category: z.enum(['caution', 'dismissal', 'misconduct']),
    source: z.object({ type: z.enum(['match_event', 'official_report', 'manual']), id: id.optional() }), summary: z.string().trim().max(2000).optional(), ...subjectIn.shape,
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const cm = (await c.query('SELECT * FROM comp_competitions WHERE id=$1 FOR UPDATE', [i.competition_id])).rows[0];
    if (!cm) throw notFound('Competition');
    const fixture = i.fixture_id ? (await c.query('SELECT f.*, cs.competition_id, cs.id AS season_id FROM fixtures f JOIN comp_seasons cs ON cs.event_id=f.event_id WHERE f.id=$1', [i.fixture_id])).rows[0] : null;
    if (i.fixture_id && (!fixture || fixture.competition_id !== cm.id)) throw badRequest('That fixture is not in this competition');
    const staff = isAdmin(user) || (await canManageCompetition(user, cm, c)) || (fixture && fixture.referee_id === user.id);
    if (!staff) throw notFound('Competition');
    if (i.source.type !== 'manual' && !i.source.id) throw badRequest('Reference the incident (source.id)');
    if (!i.subject_user_id && !i.subject_team_id) throw badRequest('Name the person or team the case is about');
    if (i.category !== 'misconduct' && (!i.subject_user_id || !i.subject_team_id)) throw badRequest('A caution or dismissal names the person and the team they serve with');
    if (i.source.type === 'match_event') {
      const ev = (await c.query('SELECT * FROM match_events WHERE id=$1 AND fixture_id=$2', [i.source.id, i.fixture_id ?? null])).rows[0];
      if (!ev) throw badRequest('That match event does not belong to this fixture');
      if (ev.voided_at) throw conflict('That match event was voided or corrected; use the event that replaced it', { code: 'event_voided' });
      if (i.subject_user_id && ev.player_id && ev.player_id !== i.subject_user_id) throw badRequest('That event was recorded against a different person');
    }
    if (i.subject_team_id && i.subject_user_id && !(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2", [i.subject_team_id, i.subject_user_id])).rowCount) throw badRequest('The person is not on that team');
    const seasonId = i.season_id ?? fixture?.season_id ?? null;
    const dup = (await c.query("SELECT * FROM gov_cases WHERE kind='discipline' AND source->>'type'=$1 AND source->>'id'=$2 AND subject_user_id IS NOT DISTINCT FROM $3 AND parent_case_id IS NULL", [i.source.type, i.source.id ?? null, i.subject_user_id ?? null])).rows[0];
    if (dup && i.source.id) return present(c, user, dup, await ctxOf(c, user, dup));
    const pol = await latestPolicy(c, cm.id); const rules = policyOf(pol);
    if (i.subject_user_id) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`disc:${cm.id}:${i.subject_user_id}`]); // accumulation for one person runs one at a time
    const interim = i.category === 'dismissal' && rules.dismissal.interim;
    const k = (await c.query(
      `INSERT INTO gov_cases(kind,status,category,competition_id,season_id,fixture_id,sport_id,subject_user_id,subject_team_id,subject_role,policy_id,policy_version,source,summary_enc,opened_by)
       VALUES ('discipline',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [interim ? 'interim' : 'received', i.category, cm.id, seasonId, i.fixture_id ?? null, cm.sport_id, i.subject_user_id ?? null, i.subject_team_id ?? null, i.subject_role, pol?.id ?? null, pol?.version ?? null,
        { type: i.source.type, ...(i.source.id ? { id: i.source.id } : {}) }, i.summary ? encrypt(i.summary, 'gov_cases.summary') : null, user.id])).rows[0];
    await log(c, k, 'opened', user.id, { to: k.status, detail: { category: i.category, source: i.source.type } });
    const startsAfter = fixture?.scheduled_at ?? null;
    if (interim) {
      const s = (await c.query(
        `INSERT INTO disc_sanctions(case_id,kind,status,subject_user_id,team_id,competition_id,season_id,scope,sport_id,matches,starts_on,starts_after,decided_by) VALUES ($1,'match_suspension','interim',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [k.id, i.subject_user_id, i.subject_team_id, cm.id, seasonId, rules.scope, cm.sport_id, rules.dismissal.suspension_matches, today(), startsAfter, user.id])).rows[0];
      await log(c, k, 'interim_set', user.id, { detail: { sanction_id: s.id, matches: s.matches, note: 'Interim measure pending review; not a finding' } });
    }
    let auto = null;
    if (i.category === 'caution' && rules.caution_thresholds.length) {
      const counted = (await c.query(
        `SELECT count(*)::int AS n FROM gov_cases WHERE kind='discipline' AND category='caution' AND subject_user_id=$1 AND competition_id=$2 AND status NOT IN ('withdrawn','dismissed')
            AND ($3::boolean OR season_id IS NOT DISTINCT FROM $4::uuid) AND ($5::int IS NULL OR created_at > now() - ($5::int || ' days')::interval)`,
        [i.subject_user_id, cm.id, rules.carry_over === 'next_season', seasonId, rules.expiry_days ?? null])).rows[0].n;
      const hit = thresholdFor(rules, counted);
      if (hit) {
        const a = (await c.query(
          `INSERT INTO gov_cases(kind,status,category,competition_id,season_id,fixture_id,sport_id,subject_user_id,subject_team_id,subject_role,policy_id,policy_version,source,auto,outcome,opened_by,decided_by,decided_at,appeal_deadline)
           VALUES ('discipline','decided','caution_accumulation',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'upheld',$11,$11,now(),$12) RETURNING *`,
          [cm.id, seasonId, i.fixture_id ?? null, cm.sport_id, i.subject_user_id, i.subject_team_id, i.subject_role, pol.id, pol.version, { type: 'accumulation', id: k.id }, user.id, appealDeadline(today(), rules)])).rows[0];
        const s = (await c.query(
          `INSERT INTO disc_sanctions(case_id,kind,status,subject_user_id,team_id,competition_id,season_id,scope,sport_id,matches,starts_on,starts_after,decided_by,reason_enc) VALUES ($1,'match_suspension','active',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [a.id, i.subject_user_id, i.subject_team_id, cm.id, seasonId, rules.scope, cm.sport_id, hit.suspension_matches, today(), startsAfter, user.id, encrypt(`Automatic: ${hit.count} cautions reached under policy v${pol.version}`, 'disc_sanctions.reason')])).rows[0];
        await log(c, a, 'auto_raised', user.id, { to: 'decided', detail: { cautions: hit.count, matches: hit.suspension_matches, sanction_id: s.id, policy_version: pol.version, from_case: k.id } });
        auto = a.id;
      }
    }
    await audit(c, user.id, 'discipline.case_open', 'gov_case', k.id);
    if (auto) {
      const who = [i.subject_user_id, ...(await guardiansOf(i.subject_user_id, c))];
      for (const uid of new Set(who)) await notify(c, uid, { kind: 'discipline_update', title: 'A suspension was applied', body: 'Open Discipline for the details and your right to appeal.', data: { case_id: auto } });
    }
    return { ...(await present(c, user, k, await ctxOf(c, user, k))), auto_case_id: auto };
  }),
});

cap({
  name: 'open_governance_case', method: 'POST', path: '/governance/cases', tag: TAG, status: 201,
  summary: 'Open a protest, eligibility dispute, licence issue or waiver request about a competition. It references canonical records (fixture, licence, registration …) through links instead of copying them. A protest never changes a result by itself; the competition authority decides and any consequence goes through its own mechanism.',
  input: z.object({
    kind: z.enum(['protest', 'eligibility_dispute', 'licence_issue', 'waiver']), competition_id: id, season_id: id.optional(), fixture_id: id.optional(), category: z.string().trim().min(2).max(60),
    summary: z.string().trim().min(3).max(2000), links: z.array(z.object({ entity_type: z.enum(['fed_licence', 'fed_affiliation', 'reg_registration', 'reg_exception', 'fixture', 'match_event', 'int_case', 'support_case', 'transfer']), entity_id: id })).max(10).default([]),
    waiver_rule: z.enum(['window', 'division_age', 'licence', 'transfer', 'loan', 'classification', 'disciplinary', 'contract', 'roster_limit', 'quota', 'guardian_consent']).optional(), ...subjectIn.shape,
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const cm = (await c.query('SELECT * FROM comp_competitions WHERE id=$1', [i.competition_id])).rows[0];
    if (!cm) throw notFound('Competition');
    if (i.kind === 'waiver' && (!i.subject_user_id || !i.waiver_rule || !i.season_id)) throw badRequest('A waiver names the person, the rule and the season');
    const team = i.subject_team_id ? (await c.query('SELECT * FROM teams WHERE id=$1', [i.subject_team_id])).rows[0] : null;
    const may = isAdmin(user) || (await canManageCompetition(user, cm, c)) || user.id === i.subject_user_id || (i.subject_user_id && (await guardianLink(user.id, i.subject_user_id, c))) || (team && (await canManageTeam(user, team)));
    // a protest or dispute about a game may also be raised by the manager of either team in that fixture
    let inGame = false;
    if (!may && i.fixture_id && ['protest', 'eligibility_dispute'].includes(i.kind)) {
      const f = (await c.query('SELECT f.home_team_id, f.away_team_id FROM fixtures f JOIN comp_seasons cs ON cs.event_id=f.event_id WHERE f.id=$1 AND cs.competition_id=$2', [i.fixture_id, cm.id])).rows[0];
      for (const tid of [f?.home_team_id, f?.away_team_id].filter(Boolean)) { const t = (await c.query('SELECT * FROM teams WHERE id=$1', [tid])).rows[0]; if (t && (await canManageTeam(user, t))) inGame = true; }
    }
    if (!may && !inGame) throw notFound('Competition');
    const k = (await c.query(
      `INSERT INTO gov_cases(kind,status,category,competition_id,season_id,fixture_id,sport_id,subject_user_id,subject_team_id,subject_role,source,summary_enc,opened_by)
       VALUES ($1,'received',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.kind, i.kind === 'waiver' ? `waiver:${i.waiver_rule}` : i.category, cm.id, i.season_id ?? null, i.fixture_id ?? null, cm.sport_id, i.subject_user_id ?? null, i.subject_team_id ?? null, i.subject_role, { type: 'manual' }, encrypt(i.summary, 'gov_cases.summary'), user.id])).rows[0];
    for (const l of i.links) await c.query('INSERT INTO gov_case_links(case_id,entity_type,entity_id,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [k.id, l.entity_type, l.entity_id, user.id]);
    await log(c, k, 'opened', user.id, { to: 'received', detail: { kind: i.kind } });
    await audit(c, user.id, 'governance.case_open', 'gov_case', k.id);
    return present(c, user, k, await ctxOf(c, user, k));
  }),
});

// ------------------------------------------------------------------ decisions
const sanctionIn = z.object({
  kind: z.enum(SANCTION_KINDS), matches: z.number().int().min(1).max(100).optional(), starts_on: day.optional(), ends_on: day.optional(), team_id: id.optional(),
  amount_minor: z.number().int().min(0).max(1_000_000_000_000).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), points: z.number().int().min(1).max(100).optional(),
  scope: z.enum(['competition', 'sport']).optional(), public: z.boolean().default(false), reason: z.string().trim().max(500).optional(),
});

async function issueSanction(c, user, k, rules, s) {
  if (s.kind === 'fine' && !rules.fine_authority) throw forbidden('This competition\'s policy does not let the panel impose fines');
  if (s.kind === 'points_deduction' && !rules.points_deduction_authority) throw forbidden('This competition\'s policy does not let the panel deduct points');
  if (s.kind === 'match_suspension' && !s.matches) throw badRequest('A match suspension needs a number of matches');
  if (s.kind === 'fine' && (s.amount_minor == null || !s.currency)) throw badRequest('A fine needs an amount and a currency');
  const teamId = s.team_id ?? k.subject_team_id;
  if (['match_suspension', 'points_deduction'].includes(s.kind) && !teamId) throw badRequest('Name the team');
  let adjustmentId = null;
  if (s.kind === 'points_deduction') {
    const m = (await c.query("SELECT division_id FROM comp_memberships WHERE season_id=$1 AND team_id=$2 AND status='accepted' AND division_id IS NOT NULL", [k.season_id, teamId])).rows[0];
    if (!k.season_id || !m) throw badRequest('A points deduction needs a season in which the team sits in a division');
    adjustmentId = (await c.query('INSERT INTO comp_adjustments(season_id,division_id,team_id,points_delta,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [k.season_id, m.division_id, teamId, -s.points, `Disciplinary: ${s.reason ?? `case ${k.id.slice(0, 8)}`}`.slice(0, 500), user.id])).rows[0].id;
  }
  const r = (await c.query(
    `INSERT INTO disc_sanctions(case_id,kind,status,subject_user_id,team_id,competition_id,season_id,scope,sport_id,matches,starts_on,ends_on,amount_minor,currency,fine_state,points,adjustment_id,public,reason_enc,decided_by)
     VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [k.id, s.kind, k.subject_user_id, teamId ?? null, k.competition_id, k.season_id, s.scope ?? rules.scope, k.sport_id, s.matches ?? null, s.starts_on ?? today(), s.ends_on ?? null, s.amount_minor ?? null, s.currency ?? null,
      s.kind === 'fine' ? 'imposed' : null, s.points ?? null, adjustmentId, !!s.public, s.reason ? encrypt(s.reason, 'disc_sanctions.reason') : null, user.id])).rows[0];
  return r;
}

cap({
  name: 'decide_governance_case', method: 'POST', path: '/governance/cases/:id/decision', tag: TAG,
  summary: 'The competition authority or sanctioning body decides a case with reasons. A disciplinary decision may impose warnings, match or date suspensions, bans, role suspensions, fines or points deductions the policy permits; interim measures are superseded by the final one. A granted waiver creates the eligibility exception through the registration mechanism. The appeal deadline starts now.',
  input: z.object({
    id, expected_version: z.number().int().min(1), outcome: z.enum(['upheld', 'no_case', 'granted', 'refused']), reason: z.string().trim().min(3).max(2000),
    sanctions: z.array(sanctionIn).max(6).default([]), waiver_until: z.string().datetime({ offset: true }).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = await lockCase(c, i.id); const x = await mustSee(c, user, k);
    if (!x.staff) throw forbidden('Only the competition authority decides a case');
    if (k.row_version !== i.expected_version) throw stale(k);
    if (!['received', 'under_review', 'interim'].includes(k.status)) throw conflict(`A ${k.status} case cannot be decided`, { code: 'bad_transition' });
    if (k.kind === 'appeal') throw badRequest('Appeals are decided with decide_appeal');
    const pol = k.policy_id ? policyOf((await c.query('SELECT rules FROM disc_policies WHERE id=$1', [k.policy_id])).rows[0]) : policyOf(null);
    if (k.kind === 'discipline' && i.outcome === 'upheld' && !i.sanctions.length) throw badRequest('Impose at least a warning, or decide no case to answer');
    if (k.kind !== 'discipline' && i.sanctions.length) throw badRequest('Only disciplinary cases impose sanctions');
    const final = [];
    if (k.kind === 'discipline') {
      // interim measures are superseded by the final decision (kept, flagged, never edited)
      await c.query("UPDATE disc_sanctions SET status=CASE WHEN $2 THEN 'overturned' ELSE 'expired' END, superseded_at=now() WHERE case_id=$1 AND status='interim' AND superseded_at IS NULL", [k.id, i.outcome === 'no_case']);
      if (i.outcome === 'upheld') for (const s of i.sanctions) final.push(await issueSanction(c, user, k, pol, s));
    }
    if (k.kind === 'waiver' && i.outcome === 'granted') {
      const rule = k.category.replace('waiver:', '');
      const s = (await c.query('SELECT event_id FROM comp_seasons WHERE id=$1', [k.season_id])).rows[0];
      if (!s) throw badRequest('The waiver\'s season is missing');
      const until = i.waiver_until ?? new Date(Date.now() + 30 * 864e5).toISOString();
      const ex = (await c.query('INSERT INTO reg_exceptions(event_id,user_id,rule_key,reason_enc,effective_to,granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [s.event_id, k.subject_user_id, rule, encrypt(i.reason, 'reg_exceptions.reason'), until, user.id])).rows[0];
      await c.query('INSERT INTO gov_case_links(case_id,entity_type,entity_id,created_by) VALUES ($1,$2,$3,$4)', [k.id, 'reg_exception', ex.id, user.id]);
    }
    const status = i.outcome === 'no_case' ? 'dismissed' : k.kind === 'discipline' ? 'decided' : 'decided';
    const r = (await c.query(
      `UPDATE gov_cases SET status=$2, outcome=$3, decision_enc=$4, decided_by=$5, decided_at=now(), appeal_deadline=$6, needs_review=false, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [k.id, status, i.outcome, encrypt(i.reason, 'gov_cases.decision'), user.id, i.outcome === 'no_case' ? null : appealDeadline(today(), pol)])).rows[0];
    await log(c, r, 'decision', user.id, { from: k.status, to: status, detail: { outcome: i.outcome, sanctions: final.map((s) => s.id), policy_version: k.policy_version } });
    for (const s of final) await log(c, r, 'sanction_issued', user.id, { detail: { sanction_id: s.id, kind: s.kind, matches: s.matches } });
    await audit(c, user.id, 'governance.case_decide', 'gov_case', k.id);
    const who = new Set([k.subject_user_id, ...(k.subject_user_id ? await guardiansOf(k.subject_user_id, c) : [])].filter(Boolean));
    for (const uid of who) await notify(c, uid, { kind: 'discipline_update', title: 'A decision was made on your case', body: 'Open Discipline to read it and see how to appeal.', data: { case_id: k.id } });
    return present(c, user, r, x);
  }),
});

cap({
  name: 'file_appeal', method: 'POST', path: '/governance/cases/:id/appeal', tag: TAG, status: 201,
  summary: 'Appeal a decided case within the policy\'s appeal window. The person concerned, their verified guardian or their team\'s manager may appeal. If the policy stays sanctions pending appeal, blocking sanctions stop blocking until the appeal is decided. One appeal per decision.',
  input: z.object({ id, grounds: z.string().trim().min(10).max(2000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = await lockCase(c, i.id); await mustSee(c, user, k);
    if (k.status !== 'decided') throw conflict(`Only a decided case can be appealed (this one is ${k.status})`, { code: 'not_decided' });
    if (k.kind === 'appeal') throw badRequest('An appeal decision is final; file a new case if the facts changed');
    if (!k.appeal_deadline || ymd(k.appeal_deadline) < today()) throw conflict('The appeal window has closed', { code: 'appeal_window_closed', deadline: ymd(k.appeal_deadline) });
    const team = k.subject_team_id ? (await c.query('SELECT * FROM teams WHERE id=$1', [k.subject_team_id])).rows[0] : null;
    const may = user.id === k.subject_user_id || (k.subject_user_id && (await guardianLink(user.id, k.subject_user_id, c))) || (team && (await canManageTeam(user, team)));
    if (!may) throw forbidden('Only the person concerned, their guardian or their team manager can appeal');
    const pol = k.policy_id ? policyOf((await c.query('SELECT rules FROM disc_policies WHERE id=$1', [k.policy_id])).rows[0]) : policyOf(null);
    const a = (await c.query(
      `INSERT INTO gov_cases(kind,status,category,competition_id,season_id,fixture_id,sport_id,subject_user_id,subject_team_id,subject_role,parent_case_id,policy_id,policy_version,source,summary_enc,opened_by)
       VALUES ('appeal','received','appeal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [k.competition_id, k.season_id, k.fixture_id, k.sport_id, k.subject_user_id, k.subject_team_id, k.subject_role, k.id, k.policy_id, k.policy_version, { type: 'appeal', id: k.id }, encrypt(i.grounds, 'gov_cases.summary'), user.id])).rows[0];
    const stay = pol.stay_on_appeal;
    const r = (await c.query("UPDATE gov_cases SET status='appealed', stay=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [k.id, stay])).rows[0];
    if (stay) await c.query("UPDATE disc_sanctions SET status='stayed' WHERE case_id=$1 AND status='active' AND superseded_at IS NULL", [k.id]);
    await log(c, r, 'appeal_filed', user.id, { from: 'decided', to: 'appealed', detail: { appeal_id: a.id, stay } });
    await log(c, a, 'opened', user.id, { to: 'received', detail: { appeal_of: k.id } });
    await audit(c, user.id, 'governance.appeal_file', 'gov_case', a.id);
    return present(c, user, a, await ctxOf(c, user, a));
  }),
});

cap({
  name: 'decide_appeal', method: 'POST', path: '/governance/appeals/:id/decision', tag: TAG,
  summary: 'The appeal panel decides: upheld (original stands, any stay ends), reduced (the original is superseded by the shorter sanction you give), overturned (sanctions are overturned and points deductions reversed) or remitted (back for a fresh hearing; sanctions stay suspended). The original decision and its history are never edited.',
  input: z.object({ id, expected_version: z.number().int().min(1), outcome: z.enum(['upheld', 'reduced', 'overturned', 'remitted']), reason: z.string().trim().min(3).max(2000), reduced_matches: z.number().int().min(1).max(100).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await lockCase(c, i.id);
    if (a.kind !== 'appeal') throw badRequest('That is not an appeal');
    const x = await mustSee(c, user, a);
    if (!x.staff) throw forbidden('Only the appeal panel decides an appeal');
    if (a.row_version !== i.expected_version) throw stale(a);
    if (!['received', 'under_review'].includes(a.status)) throw conflict(`A ${a.status} appeal cannot be decided`, { code: 'bad_transition' });
    const k = await lockCase(c, a.parent_case_id);
    const sanctions = (await c.query("SELECT * FROM disc_sanctions WHERE case_id=$1 AND superseded_at IS NULL AND status IN ('active','stayed') ORDER BY decided_at", [k.id])).rows;
    if (i.outcome === 'reduced') {
      const ms = sanctions.filter((s) => s.kind === 'match_suspension');
      if (!ms.length || !i.reduced_matches || ms.some((s) => i.reduced_matches >= s.matches)) throw badRequest('A reduction needs a match suspension and a shorter number of matches');
    }
    for (const s of sanctions) {
      if (i.outcome === 'upheld') { if (s.status === 'stayed') await c.query("UPDATE disc_sanctions SET status='active' WHERE id=$1", [s.id]); }
      else if (i.outcome === 'overturned') {
        await c.query("UPDATE disc_sanctions SET status='overturned', superseded_at=now() WHERE id=$1", [s.id]);
        if (s.adjustment_id) {
          const adj = (await c.query('SELECT * FROM comp_adjustments WHERE id=$1', [s.adjustment_id])).rows[0];
          await c.query('INSERT INTO comp_adjustments(season_id,division_id,team_id,points_delta,reason,reverses_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [adj.season_id, adj.division_id, adj.team_id, -adj.points_delta, 'Reversed on appeal', adj.id, user.id]);
        }
      } else if (i.outcome === 'reduced' && s.kind === 'match_suspension') {
        await c.query("UPDATE disc_sanctions SET superseded_at=now(), status='expired' WHERE id=$1", [s.id]);
        const n = (await c.query(
          `INSERT INTO disc_sanctions(case_id,kind,status,subject_user_id,team_id,competition_id,season_id,scope,sport_id,matches,starts_on,starts_after,replaces_id,public,reason_enc,decided_by)
           VALUES ($1,'match_suspension','active',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [k.id, s.subject_user_id, s.team_id, s.competition_id, s.season_id, s.scope, s.sport_id, i.reduced_matches, s.starts_on, s.starts_after, s.id, s.public, encrypt(`Reduced on appeal: ${i.reason}`.slice(0, 500), 'disc_sanctions.reason'), user.id])).rows[0];
        await log(c, k, 'sanction_amended', user.id, { detail: { from: s.id, to: n.id, matches: i.reduced_matches } });
      } else if (i.outcome === 'remitted' && s.status === 'active') await c.query("UPDATE disc_sanctions SET status='stayed' WHERE id=$1", [s.id]);
      else if (i.outcome === 'reduced' && s.status === 'stayed') await c.query("UPDATE disc_sanctions SET status='active' WHERE id=$1", [s.id]);
    }
    const parentStatus = i.outcome === 'remitted' ? 'under_review' : 'decided';
    const kr = (await c.query(
      `UPDATE gov_cases SET status=$2, stay=false, appeal_deadline=NULL, outcome=CASE WHEN $3='remitted' THEN NULL ELSE $3 END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [k.id, parentStatus, i.outcome])).rows[0];
    const ar = (await c.query("UPDATE gov_cases SET status='closed', outcome=$2, decision_enc=$3, decided_by=$4, decided_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [a.id, i.outcome, encrypt(i.reason, 'gov_cases.decision'), user.id])).rows[0];
    await log(c, ar, 'appeal_decided', user.id, { from: a.status, to: 'closed', detail: { outcome: i.outcome } });
    await log(c, kr, 'appeal_decided', user.id, { from: 'appealed', to: parentStatus, detail: { outcome: i.outcome, appeal_id: a.id } });
    await audit(c, user.id, 'governance.appeal_decide', 'gov_case', a.id);
    const who = new Set([k.subject_user_id, ...(k.subject_user_id ? await guardiansOf(k.subject_user_id, c) : [])].filter(Boolean));
    for (const uid of who) await notify(c, uid, { kind: 'discipline_update', title: 'Your appeal was decided', body: 'Open Discipline for the outcome.', data: { case_id: k.id } });
    return present(c, user, ar, x);
  }),
});

cap({
  name: 'set_sanction_fine_state', method: 'POST', path: '/discipline/sanctions/:id/fine', tag: TAG,
  summary: 'Move a fine through imposed → invoiced → paid (or waived) with the canonical invoice reference. Money state is separate from the sporting state: an unpaid fine does not extend a suspension and a paid one does not end one.',
  input: z.object({ id, fine_state: z.enum(['invoiced', 'paid', 'waived']), invoice_ref: z.string().trim().max(120).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query("SELECT * FROM disc_sanctions WHERE id=$1 AND kind='fine' FOR UPDATE", [i.id])).rows[0];
    if (!s) throw notFound('Sanction');
    const k = await lockCase(c, s.case_id); const x = await mustSee(c, user, k);
    if (!x.staff) throw forbidden('Only the competition authority manages fines');
    if (!FINE_FLOW[s.fine_state].includes(i.fine_state)) throw conflict(`A fine cannot go from ${s.fine_state} to ${i.fine_state}`, { code: 'bad_fine_transition', allowed: FINE_FLOW[s.fine_state] });
    const r = (await c.query('UPDATE disc_sanctions SET fine_state=$2, invoice_ref=coalesce($3,invoice_ref) WHERE id=$1 RETURNING id, fine_state, invoice_ref', [s.id, i.fine_state, i.invoice_ref ?? null])).rows[0];
    await log(c, k, 'fine_state', user.id, { detail: { sanction_id: s.id, from: s.fine_state, to: i.fine_state } });
    return r;
  }),
});

cap({
  name: 'clear_case_review_flag', method: 'POST', path: '/governance/cases/:id/review', tag: TAG,
  summary: 'After the canonical source of a case (a match event or result) was corrected, a reviewer confirms the case still stands or withdraws it. The flag is cleared only with a recorded reason; nothing is deleted.',
  input: z.object({ id, expected_version: z.number().int().min(1), action: z.enum(['confirm', 'withdraw']), reason: z.string().trim().min(3).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const k = await lockCase(c, i.id); const x = await mustSee(c, user, k);
    if (!x.staff) throw forbidden('Only the competition authority reviews a flagged case');
    if (k.row_version !== i.expected_version) throw stale(k);
    if (!k.needs_review) throw conflict('This case is not flagged for review', { code: 'not_flagged' });
    const withdraw = i.action === 'withdraw';
    if (withdraw) await c.query("UPDATE disc_sanctions SET status='overturned', superseded_at=now() WHERE case_id=$1 AND superseded_at IS NULL AND status IN ('interim','active','stayed')", [k.id]);
    const r = (await c.query("UPDATE gov_cases SET needs_review=false, status=CASE WHEN $2 THEN 'withdrawn' ELSE status END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [k.id, withdraw])).rows[0];
    await log(c, r, withdraw ? 'withdrawn' : 'review_cleared', user.id, { from: k.status, to: r.status, detail: { reason: i.reason } });
    return present(c, user, r, x);
  }),
});

// ------------------------------------------------------------------ reading
cap({
  name: 'get_governance_case', method: 'GET', path: '/governance/cases/:id', tag: TAG,
  summary: 'One case with its sanctions (served and remaining matches derived from completed fixtures), links to the canonical records, the policy version it was decided under and the full history. Visible to the person concerned, their guardian, their team manager and the competition authority; everyone else gets 404.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const k = (await pool.query('SELECT * FROM gov_cases WHERE id=$1', [i.id])).rows[0];
    if (!k) throw notFound('Case');
    const x = await mustSee(pool, user, k);
    if (user.id !== k.subject_user_id) await audit(pool, user.id, 'governance.case_read', 'gov_case', k.id);
    return present(pool, user, k, x);
  },
});

cap({
  name: 'list_governance_cases', method: 'GET', path: '/governance/cases', tag: TAG,
  summary: 'The case queue. Pass `competition_id` as competition staff to see the whole queue (filter by kind, status, flagged), or omit it to see only cases about you, your children or your teams.',
  input: z.object({ competition_id: id.optional(), kind: z.enum(['discipline', 'appeal', 'eligibility_dispute', 'protest', 'licence_issue', 'waiver']).optional(), status: z.enum(['received', 'under_review', 'interim', 'decided', 'appealed', 'closed', 'dismissed', 'withdrawn']).optional(), needs_review: z.coerce.boolean().optional(), ...page }),
  handler: async ({ user }, i) => {
    let staffOf = false;
    if (i.competition_id) {
      const cm = (await pool.query('SELECT * FROM comp_competitions WHERE id=$1', [i.competition_id])).rows[0];
      if (!cm) throw notFound('Competition');
      const body = cm.organisation_id ? (await pool.query('SELECT id FROM governing_bodies WHERE organisation_id=$1', [cm.organisation_id])).rows[0] : null;
      staffOf = isAdmin(user) || (await canManageCompetition(user, cm, pool)) || (body ? can(await authority(user, body.id, { optional: true }), 'sanctions', cm.sport_id) : false);
      if (!staffOf) throw notFound('Competition');
    }
    const rows = await many(
      `SELECT k.id,k.kind,k.status,k.category,k.competition_id,k.season_id,k.fixture_id,k.subject_user_id,k.subject_team_id,k.outcome,k.auto,k.needs_review,k.appeal_deadline,k.policy_version,k.created_at,k.decided_at,
              u.display_name AS subject_name, t.name AS subject_team,
              (SELECT count(*)::int FROM disc_sanctions s WHERE s.case_id=k.id AND s.superseded_at IS NULL AND s.status IN ('interim','active')) AS live_sanctions
         FROM gov_cases k LEFT JOIN users u ON u.id=k.subject_user_id LEFT JOIN teams t ON t.id=k.subject_team_id
        WHERE ($1::uuid IS NULL OR k.competition_id=$1)
          AND ($1::uuid IS NOT NULL OR k.subject_user_id=$2 OR k.opened_by=$2
               OR EXISTS (SELECT 1 FROM guardian_links g WHERE g.guardian_id=$2 AND g.child_id=k.subject_user_id AND g.status='active' AND g.revoked_at IS NULL)
               OR t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=k.subject_team_id AND m.user_id=$2 AND m.status='active' AND m.role IN ('captain','manager')))
          AND ($3::text IS NULL OR k.kind=$3) AND ($4::text IS NULL OR k.status=$4) AND ($5::boolean IS NULL OR k.needs_review=$5)
        ORDER BY k.needs_review DESC, k.created_at DESC LIMIT $6 OFFSET $7`, [i.competition_id ?? null, user.id, i.kind ?? null, i.status ?? null, i.needs_review ?? null, i.limit, i.offset]);
    return { items: rows.map((r) => ({ ...r, appeal_deadline: ymd(r.appeal_deadline) })), staff: staffOf, limit: i.limit, offset: i.offset };
  },
});

cap({
  name: 'get_suspension_status', method: 'GET', path: '/discipline/suspensions', tag: TAG,
  summary: 'Suspensions affecting a person (or a whole team for squad selection): kind, status, matches served and remaining derived from completed fixtures (postponed and cancelled games do not count). The same state the eligibility engine reads at selection and match lock.',
  input: z.object({ user_id: id.optional(), team_id: id.optional() }).refine((v) => v.user_id || v.team_id, { message: 'Give a person or a team' }),
  handler: async ({ user }, i) => {
    if (i.team_id) {
      const t = (await pool.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
      if (!t || !(isAdmin(user) || (await canManageTeam(user, t)))) throw notFound('Team');
    } else if (!(isAdmin(user) || user.id === i.user_id || (await guardianLink(user.id, i.user_id, pool)))) throw notFound('Person');
    const rows = (await pool.query(
      `SELECT s.*, u.display_name FROM disc_sanctions s JOIN users u ON u.id=s.subject_user_id
        WHERE s.superseded_at IS NULL AND s.status IN ('interim','active','stayed') AND s.kind IN ('match_suspension','date_suspension','competition_ban','role_suspension')
          AND ($1::uuid IS NULL OR s.subject_user_id=$1) AND ($2::uuid IS NULL OR s.team_id=$2) ORDER BY s.decided_at`, [i.user_id ?? null, i.team_id ?? null])).rows;
    const items = [];
    for (const s of rows) {
      const service = s.kind === 'match_suspension' ? await serviceFor(pool, s) : null;
      items.push({ id: s.id, case_id: s.case_id, subject_user_id: s.subject_user_id, subject_name: s.display_name, kind: s.kind, status: s.status, matches: s.matches, starts_on: ymd(s.starts_on), ends_on: ymd(s.ends_on), competition_id: s.competition_id, team_id: s.team_id, blocking: s.status !== 'stayed' && !service?.done, service });
    }
    return { items };
  },
});

cap({
  name: 'list_public_sanctions', method: 'GET', path: '/competitions/:id/sanctions', tag: TAG, auth: 'public',
  summary: 'Public disciplinary information for a competition: only when its policy allows disclosure, only sanctions marked public, never a young person, never evidence or reasons.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const { cm } = await readComp(pool, user, i.id);
    const pol = policyOf(await latestPolicy(pool, cm.id));
    if (pol.public_disclosure !== 'sanctions') return { items: [], disclosure: 'none', limit: i.limit, offset: i.offset };
    const rows = await many(
      `SELECT s.id, s.kind, s.matches, s.starts_on, s.ends_on, u.display_name AS subject_name, t.name AS team
         FROM disc_sanctions s JOIN users u ON u.id=s.subject_user_id LEFT JOIN teams t ON t.id=s.team_id
        WHERE s.competition_id=$1 AND s.public AND s.superseded_at IS NULL AND s.status IN ('active','stayed','served') AND s.kind <> 'fine'
          AND NOT (u.youth_until IS NOT NULL AND u.youth_until > current_date)
        ORDER BY s.decided_at DESC LIMIT $2 OFFSET $3`, [cm.id, i.limit, i.offset]);
    return { items: rows.map((r) => ({ ...r, starts_on: ymd(r.starts_on), ends_on: ymd(r.ends_on) })), disclosure: 'sanctions', limit: i.limit, offset: i.offset };
  },
});

