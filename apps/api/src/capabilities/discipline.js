// Sports Disciplinary & Sanctions (#479): policy, cases, decisions, sanctions and appeals as one capability definition each (REST + OpenAPI + MCP).
// Canonical cards and official reports are REFERENCED, never copied. Authorization, validation, encryption of free text and audit logging live here; anyone without
// standing gets a 404 so a case's existence is never leaked. Nothing here is ever shown on a public profile, roster or export (docs/discipline.md).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { isGuardianOf } from '../federation.js';
import { canManageTeam } from './teams.js';
import { seasonRow, recordAdjustment, divisionRow } from './competitions.js';
import {
  NOT_A_FINDING, SANCTION_KINDS, CATEGORIES, KIND_INFO, policyParams, disciplineModelOf, authorityOf, mayDecide, caseFor, needDecide, log, tell, nextCaseNo, policyFor, serviceOf, today, addDays,
} from '../discipline.js';
import { deriveCases, recordDecision, activateStayed, watchlist, sealText } from '../discipline-engine.js';

const TAG = 'Discipline';
const SCOPE = 'admin';          // a narrow API token never reaches disciplinary data
const text = (n) => z.string().trim().max(n);
const day = z.string().date();

const sanctionIn = z.object({
  kind: z.enum(SANCTION_KINDS), scope: z.enum(['competition', 'sport']).optional(), matches: z.number().int().min(1).max(200).optional(),
  effective_from: day.optional(), effective_to: day.optional(), amount_minor: z.number().int().min(1).max(1_000_000_000).optional(),
  points: z.number().int().min(1).max(100).optional(), label: text(120).optional(),
});

async function needAuthority(user, competitionId, c = pool) {
  const a = await authorityOf(user, competitionId, { c });
  if (!a) throw notFound('Competition');
  return a;
}
const clean = ({ summary_enc, notes_enc, ...r }) => r;

/** The case as a role may see it: authority sees everything; the subject sees the allegation and decisions but not panel notes; a team manager sees category, status and outcomes only. */
async function present(c, s, { audit: doAudit = false, user } = {}) {
  const r = s.row;
  const base = clean(r);
  const sv = (await c.query('SELECT * FROM disc_policy_versions WHERE id=$1', [r.policy_version_id])).rows[0];
  const decisions = (await c.query(
    `SELECT d.id, d.kind, d.outcome, d.authority, d.automatic, d.reason_enc, d.supersedes_id, d.superseded_at, d.created_at, u.display_name AS decided_by_name
       FROM disc_decisions d LEFT JOIN users u ON u.id=d.decided_by WHERE d.case_id=$1 ORDER BY d.created_at, d.id`, [r.id])).rows;
  const sanctions = (await c.query('SELECT * FROM disc_sanctions WHERE case_id=$1 ORDER BY created_at, id', [r.id])).rows;
  for (const x of sanctions) if (x.kind === 'match_suspension') x.service = await serviceOf(c, x, r, sv?.params ?? {});
  const out = { ...base, as: s.as, notice: NOT_A_FINDING, sanctions };
  out.decisions = decisions.map(({ reason_enc, ...d }) => ({ ...d, ...(s.as !== 'team' ? { reason: decrypt(reason_enc, 'disc.decision') } : {}) }));
  if (s.as !== 'team') out.summary = r.summary_enc ? decrypt(r.summary_enc, 'disc_cases.summary') : null;
  if (['organiser', 'panel', 'secretary'].includes(s.as)) {
    out.notes = r.notes_enc ? decrypt(r.notes_enc, 'disc_cases.notes') : null;
    out.evidence = (await c.query('SELECT id, kind, title, sha256, appeal_id, created_at FROM disc_evidence WHERE case_id=$1 ORDER BY created_at', [r.id])).rows;
    out.history = (await c.query('SELECT id, action, from_status, to_status, reason, detail, created_at FROM disc_events WHERE case_id=$1 ORDER BY id', [r.id])).rows;
  }
  out.appeals = (await c.query('SELECT id, decision_id, status, stay, deadline_on::text AS deadline_on, created_at, decided_at FROM disc_appeals WHERE case_id=$1 ORDER BY created_at', [r.id])).rows;
  if (['organiser', 'panel', 'secretary'].includes(s.as) || s.as === 'subject') {
    const names = await c.query('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [[r.subject_user_id].filter(Boolean)]);
    out.subject_name = names.rows[0]?.display_name ?? null;
  }
  if (doAudit) await audit(c, user.id, 'discipline_case_read', 'disc_cases', r.id);
  return out;
}

// ------------------------------------------------------------------ vocabulary (public: no personal data)
cap({
  name: 'get_disciplinary_vocabulary', method: 'GET', path: '/discipline/vocabulary', tag: TAG, auth: 'public',
  summary: 'What discipline can be recorded: misconduct categories, sanction kinds, and for each sport in the catalogue its native model (cards, graded conduct, foul limits) or a labelled generic fallback. Reference data only.',
  input: z.object({}),
  async handler() {
    const sports = await many('SELECT * FROM sports ORDER BY name');
    return { categories: CATEGORIES, sanction_kinds: SANCTION_KINDS, card_kinds: KIND_INFO, sports: sports.map((s) => ({ sport_id: s.id, slug: s.slug, name: s.name, ...disciplineModelOf(s) })) };
  },
});

cap({
  name: 'get_event_disciplinary_scope', method: 'GET', path: '/events/:id/discipline-scope', tag: TAG, scope: SCOPE,
  summary: 'Does this event run a disciplinary record, and where do I stand in it? Returns the competition and season the event is, and my authority (organiser, panel, secretary). 404 when the event is not a competition season or I have no standing, so the console can simply hide the Discipline tab.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = (await pool.query('SELECT s.id AS season_id, s.competition_id, s.label, c.name FROM comp_seasons s JOIN comp_competitions c ON c.id=s.competition_id WHERE s.event_id=$1', [i.id])).rows[0];
    if (!s) throw notFound('Event');
    const a = await authorityOf(user, s.competition_id);
    if (!a) throw notFound('Event');
    return { ...s, as: a.as, can_decide: mayDecide(a), policy: !!(await policyFor(pool, s.competition_id, s.season_id)) };
  },
});

// ------------------------------------------------------------------ policy
cap({
  name: 'save_disciplinary_policy', method: 'POST', path: '/competitions/:id/discipline/policy', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Publish a new, immutable version of the disciplinary policy for a competition (or for one season of it): caution points, accumulation thresholds, automatic suspensions, scope, served-match rules, fine / points authority, appeal window and stay. Earlier versions are kept; a case always cites the version that governed it. Organiser only.',
  input: z.object({ id, season_id: id.optional(), params: policyParams, note: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await needAuthority(user, i.id, c);
      if (a.as !== 'organiser') throw forbidden('Only the competition organiser can publish the disciplinary policy');
      if (i.season_id && (await seasonRow(c, i.season_id)).competition_id !== i.id) throw badRequest('That season belongs to another competition');
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`disc-policy:${i.id}:${i.season_id ?? ''}`]);
      let p = (await c.query('SELECT id FROM disc_policies WHERE competition_id=$1 AND season_id IS NOT DISTINCT FROM $2', [i.id, i.season_id ?? null])).rows[0];
      p ??= (await c.query('INSERT INTO disc_policies(competition_id, season_id, created_by) VALUES ($1,$2,$3) RETURNING id', [i.id, i.season_id ?? null, user.id])).rows[0];
      const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM disc_policy_versions WHERE policy_id=$1', [p.id])).rows[0].n;
      const v = (await c.query('INSERT INTO disc_policy_versions(policy_id, version, params, note, published_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.id, n, JSON.stringify(i.params), i.note ?? null, user.id])).rows[0];
      await audit(c, user.id, 'discipline_policy_published', 'disc_policy_versions', v.id);
      return { ...v, season_id: i.season_id ?? null };
    });
  },
});
cap({
  name: 'get_disciplinary_policy', method: 'GET', path: '/competitions/:id/discipline/policy', tag: TAG, scope: SCOPE,
  summary: 'The disciplinary policy that governs a season (its own version, else the competition default) and the version history. Competition authority only.',
  input: z.object({ id, season_id: id.optional() }),
  async handler({ user }, i) {
    await needAuthority(user, i.id);
    const current = await policyFor(pool, i.id, i.season_id ?? null);
    const history = await many(
      `SELECT v.id, v.version, v.note, v.created_at, p.season_id FROM disc_policy_versions v JOIN disc_policies p ON p.id=v.policy_id WHERE p.competition_id=$1 ORDER BY v.created_at DESC LIMIT 50`, [i.id]);
    return { current, defaults: policyParams.parse({}), history };
  },
});
cap({
  name: 'get_disciplinary_overview', method: 'GET', path: '/competitions/:id/discipline', tag: TAG, scope: SCOPE,
  summary: 'The disciplinary picture of a season in one call: open and decided cases, active suspensions, appeals due, cases flagged for re-evaluation, cards by team, and the caution watchlist of players near a threshold. Competition authority only; real counts, an honest empty state when nothing has happened.',
  input: z.object({ id, season_id: id }),
  async handler({ user }, i) {
    const a = await needAuthority(user, i.id);
    const s = await seasonRow(pool, i.season_id);
    if (s.competition_id !== i.id) throw notFound('Season');
    const v = await policyFor(pool, i.id, s.id);
    const q = (sql, args = [i.id, s.id]) => pool.query(sql, args).then((r) => r.rows);
    const [counts] = await q(`SELECT count(*) FILTER (WHERE status IN ('opened','under_review'))::int AS open, count(*) FILTER (WHERE status='decided')::int AS decided, count(*) FILTER (WHERE reevaluation='flagged')::int AS flagged,
      count(*) FILTER (WHERE interim_status='interim_suspension' AND status IN ('opened','under_review'))::int AS interim FROM disc_cases WHERE competition_id=$1 AND season_id=$2`);
    const [susp] = await q("SELECT count(DISTINCT k.subject_user_id)::int AS n FROM disc_sanctions s JOIN disc_cases k ON k.id=s.case_id JOIN disc_decisions d ON d.id=s.decision_id WHERE k.competition_id=$1 AND k.season_id=$2 AND s.status IN ('active','stayed') AND s.kind IN ('match_suspension','date_suspension','competition_ban') AND d.superseded_at IS NULL AND d.outcome='upheld'");
    const [apl] = await q("SELECT count(*)::int AS n FROM disc_appeals a JOIN disc_cases k ON k.id=a.case_id WHERE k.competition_id=$1 AND k.season_id=$2 AND a.status IN ('lodged','under_review')");
    const cards = await q('SELECT m.kind, m.team_id, t.name AS team_name, count(*)::int AS n FROM match_events m LEFT JOIN teams t ON t.id=m.team_id WHERE m.event_id=$1 AND m.voided_at IS NULL AND m.kind = ANY($2::text[]) AND m.player_id IS NOT NULL GROUP BY m.kind, m.team_id, t.name ORDER BY n DESC',
      [s.event_id, Object.keys(KIND_INFO)]);
    const wl = await watchlist(pool, s, v);
    const people = wl.length ? await many('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [wl.map((x) => x.player_id)]) : [];
    const nm = new Map(people.map((p) => [p.id, p.display_name]));
    return {
      as: a.as, season: { id: s.id, label: s.label, event_id: s.event_id }, policy: v ? { id: v.id, version: v.version } : null,
      metrics: { open_cases: counts.open, decided_cases: counts.decided, flagged_for_reevaluation: counts.flagged, interim_suspensions: counts.interim, people_suspended: susp.n, appeals_open: apl.n },
      cards_by_team: cards, watchlist: wl.map((x) => ({ ...x, display_name: nm.get(x.player_id) ?? null })),
    };
  },
});
cap({
  name: 'add_disciplinary_panel_member', method: 'POST', path: '/competitions/:id/discipline/panel', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Appoint a disciplinary panel member (can decide) or secretary (can open and manage cases, not decide). Organiser only; ending a membership keeps the record.',
  input: z.object({ id, user_id: id, role: z.enum(['panel', 'secretary']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await needAuthority(user, i.id, c);
      if (a.as !== 'organiser') throw forbidden('Only the organiser appoints the panel');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
      await c.query("UPDATE disc_members SET ended_at=now() WHERE competition_id=$1 AND user_id=$2 AND ended_at IS NULL", [i.id, i.user_id]);
      const m = (await c.query('INSERT INTO disc_members(competition_id, user_id, role, added_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, i.user_id, i.role, user.id])).rows[0];
      await audit(c, user.id, 'discipline_panel_member_added', 'disc_members', m.id);
      return m;
    });
  },
});
cap({
  name: 'end_disciplinary_panel_member', method: 'POST', path: '/competitions/:id/discipline/panel/:user_id/end', tag: TAG, scope: SCOPE,
  summary: 'End a panel membership (the record is kept). Organiser only.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const a = await needAuthority(user, i.id);
    if (a.as !== 'organiser') throw forbidden('Only the organiser appoints the panel');
    const r = await one('UPDATE disc_members SET ended_at=now() WHERE competition_id=$1 AND user_id=$2 AND ended_at IS NULL RETURNING id, ended_at', [i.id, i.user_id]);
    if (!r) throw notFound('Panel member');
    await audit(pool, user.id, 'discipline_panel_member_ended', 'disc_members', r.id);
    return r;
  },
});
cap({
  name: 'list_disciplinary_panel', method: 'GET', path: '/competitions/:id/discipline/panel', tag: TAG, scope: SCOPE,
  summary: 'The current disciplinary panel and secretaries of a competition. Competition authority only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await needAuthority(user, i.id);
    return many('SELECT m.id, m.user_id, m.role, m.created_at, u.display_name FROM disc_members m JOIN users u ON u.id=m.user_id WHERE m.competition_id=$1 AND m.ended_at IS NULL ORDER BY m.created_at', [i.id]);
  },
});

// ------------------------------------------------------------------ cases
cap({
  name: 'open_disciplinary_case', method: 'POST', path: '/competitions/:id/discipline/cases', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Open a disciplinary case from a canonical match event (a card), an official report, or an authorised manual referral. The source is referenced, never copied; one card feeds one case per person. Stores the governing policy version, category and the allegation (encrypted). An allegation is not a finding.',
  input: z.object({
    id, season_id: id, source: z.enum(['match_event', 'official_report', 'manual_referral']),
    match_event_id: id.optional(), official_report_id: id.optional(), fixture_id: id.optional(),
    subject_kind: z.enum(['player', 'team', 'coach', 'official']), subject_user_id: id.optional(), subject_team_id: id.optional(), team_id: id.optional(),
    category: z.enum(CATEGORIES), summary: text(4000).optional(),
    interim: z.enum(['none', 'pending_review', 'interim_suspension']).default('none'), interim_until: day.optional(),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const a = await needAuthority(user, i.id, c);
      const s = await seasonRow(c, i.season_id);
      if (s.competition_id !== i.id) throw notFound('Season');
      const ev = (await c.query('SELECT sport_id FROM events WHERE id=$1', [s.event_id])).rows[0];
      if (i.subject_kind === 'team' ? !i.subject_team_id : !i.subject_user_id) throw badRequest('Say who the case is about');
      let { match_event_id: me, official_report_id: rep, fixture_id: fx, team_id: tid } = i;
      if (i.source === 'match_event') {
        if (!me) throw badRequest('Choose the match event');
        const m = (await c.query('SELECT * FROM match_events WHERE id=$1 AND event_id=$2', [me, s.event_id])).rows[0];
        if (!m) throw notFound('Match event');
        if (m.voided_at) throw conflict('That event was voided; a voided event cannot start a case');
        fx = m.fixture_id; tid ??= m.team_id;
      }
      if (i.source === 'official_report') {
        if (!rep) throw badRequest('Choose the official report');
        const r = (await c.query('SELECT r.fixture_id, v.match_event_id, v.team_id, v.person_id FROM official_reports r JOIN official_report_revisions v ON v.report_id=r.id AND v.revision=r.revision JOIN fixtures f ON f.id=r.fixture_id WHERE r.id=$1 AND f.event_id=$2', [rep, s.event_id])).rows[0];
        if (!r) throw notFound('Official report');
        fx = r.fixture_id; me ??= r.match_event_id ?? undefined; tid ??= r.team_id ?? undefined;
      }
      if (i.source === 'manual_referral' && !i.summary) throw badRequest('Describe the matter being referred');
      if (fx && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [fx, s.event_id])).rowCount) throw badRequest('That match is not part of this season');
      if (i.interim === 'interim_suspension') {
        const v0 = await policyFor(c, i.id, s.id);
        if (!v0) throw badRequest('Publish a policy first: an interim suspension needs one that permits it');
        if (a.as !== 'organiser' && a.as !== 'panel') throw forbidden('Only the organiser or a panel member can impose an interim suspension');
      }
      const v = await policyFor(c, i.id, s.id);
      try {
        const row = (await c.query(
          `INSERT INTO disc_cases(case_no, competition_id, season_id, event_id, sport_id, policy_version_id, source_type, match_event_id, official_report_id, fixture_id, subject_kind, subject_user_id, subject_team_id, team_id, category, summary_enc, interim_status, interim_until, opened_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [await nextCaseNo(c, i.id), i.id, s.id, s.event_id, ev.sport_id, v?.id ?? null, i.source, me ?? null, rep ?? null, fx ?? null, i.subject_kind, i.subject_user_id ?? null, i.subject_team_id ?? null,
            i.subject_kind === 'team' ? i.subject_team_id : (tid ?? null), i.category, i.summary ? encrypt(i.summary, 'disc_cases.summary') : null, i.interim, i.interim_until ?? null, user.id])).rows[0];
        await log(c, row.id, 'case_opened', { actor: user.id, detail: { source: i.source, category: i.category, interim: i.interim } });
        await audit(c, user.id, 'discipline_case_opened', 'disc_cases', row.id);
        if (row.subject_user_id) await tell(c, row.subject_user_id, row);
        return clean(row);
      } catch (e) { if (e.code === '23505') throw conflict('That event already has a case for this person', { code: 'duplicate_case' }); throw e; }
    });
  },
});
cap({
  name: 'sweep_disciplinary_cards', method: 'POST', path: '/competitions/:id/discipline/sweep', tag: TAG, scope: SCOPE,
  summary: 'Apply the published policy to a season’s canonical cards now: opens a case (and records the automatic consequence the policy defines) for each threshold reached. Deterministic and idempotent; the worker runs the same function. Organiser or panel.',
  input: z.object({ id, season_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await needAuthority(user, i.id, c);
      if (!mayDecide(a)) throw forbidden('Only the organiser or a panel member can apply the policy');
      const s = await seasonRow(c, i.season_id);
      if (s.competition_id !== i.id) throw notFound('Season');
      const made = await deriveCases(c, s.id, { actor: user.id });
      return { opened: made.length, cases: made.map((m) => ({ id: m.id, case_no: m.case_no })) };
    });
  },
});
cap({
  name: 'list_disciplinary_cases', method: 'GET', path: '/competitions/:id/discipline/cases', tag: TAG, scope: SCOPE,
  summary: 'The cases of a competition season with filters (status, team, re-evaluation flag). Competition authority only. Paginated.',
  input: z.object({ id, season_id: id.optional(), status: z.enum(['opened', 'under_review', 'decided', 'closed', 'withdrawn']).optional(), team_id: id.optional(), flagged: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    await needAuthority(user, i.id);
    const rows = await many(
      `SELECT k.id, k.case_no, k.season_id, k.subject_kind, k.subject_user_id, k.team_id, k.category, k.status, k.interim_status, k.reevaluation, k.source_type, k.fixture_id, k.created_at, u.display_name AS subject_name, t.name AS team_name,
              (SELECT coalesce(json_agg(s.kind ORDER BY s.created_at), '[]') FROM disc_sanctions s WHERE s.case_id=k.id AND s.status IN ('active','stayed')) AS sanctions
         FROM disc_cases k LEFT JOIN users u ON u.id=k.subject_user_id LEFT JOIN teams t ON t.id=k.team_id
        WHERE k.competition_id=$1 AND ($2::uuid IS NULL OR k.season_id=$2) AND ($3::text IS NULL OR k.status=$3) AND ($4::uuid IS NULL OR k.team_id=$4) AND (NOT $5::boolean OR k.reevaluation='flagged')
        ORDER BY k.created_at DESC LIMIT $6 OFFSET $7`, [i.id, i.season_id ?? null, i.status ?? null, i.team_id ?? null, i.flagged ?? false, i.limit, i.offset]);
    return rows;
  },
});
cap({
  name: 'get_disciplinary_case', method: 'GET', path: '/discipline/cases/:id', tag: TAG, scope: SCOPE,
  summary: 'One case, shaped by who is asking: the panel sees everything (allegation, notes, evidence, history, service count); the person (or their guardian) sees the allegation, decisions and appeal rights but not panel notes; a manager of the team sees category, status and outcomes only. 404 for anyone else. Reads are audited.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => present(c, await caseFor(user, i.id, { c }), { audit: true, user }));
  },
});
cap({
  name: 'transition_disciplinary_case', method: 'POST', path: '/discipline/cases/:id/transition', tag: TAG, scope: SCOPE,
  summary: 'Move a case: start_review, withdraw (before a decision), close (after a decision), set_interim (none / pending_review / interim_suspension, panel only), or mark_reevaluated once a flagged case has been looked at. Guarded by row_version.',
  input: z.object({ id, action: z.enum(['start_review', 'withdraw', 'close', 'set_interim', 'mark_reevaluated']), reason: text(500).optional(), interim: z.enum(['none', 'pending_review', 'interim_suspension']).optional(), interim_until: day.optional(), notes: text(4000).optional(), version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await caseFor(user, i.id, { c, lock: true });
      if (!['organiser', 'panel', 'secretary'].includes(s.as)) throw notFound('Case');
      const r = s.row;
      if (i.version != null && i.version !== r.row_version) throw conflict('The case changed; reload it', { code: 'stale_version' });
      let status = r.status, set = '';
      const args = [r.id];
      if (i.action === 'start_review') { if (r.status !== 'opened') throw conflict('Only a newly opened case can be put under review'); status = 'under_review'; }
      else if (i.action === 'withdraw') { if (!['opened', 'under_review'].includes(r.status)) throw conflict('Only a case without a decision can be withdrawn'); needDecide(s); if (!i.reason) throw badRequest('Give a reason'); status = 'withdrawn'; set = ", interim_status='none'"; }
      else if (i.action === 'close') { if (r.status !== 'decided') throw conflict('Only a decided case can be closed'); needDecide(s); if ((await c.query("SELECT 1 FROM disc_appeals WHERE case_id=$1 AND status IN ('lodged','under_review')", [r.id])).rowCount) throw conflict('An appeal is still open'); status = 'closed'; }
      else if (i.action === 'set_interim') {
        needDecide(s);
        if (!i.interim) throw badRequest('Choose the interim status');
        if (!['opened', 'under_review'].includes(r.status)) throw conflict('An interim status applies only while a case is undecided');
        args.push(i.interim, i.interim_until ?? null);
        set = ', interim_status=$2, interim_until=$3';
      } else if (i.action === 'mark_reevaluated') { if (r.reevaluation !== 'flagged') throw conflict('This case is not flagged'); needDecide(s); set = ", reevaluation='reviewed'"; }
      if (i.notes) { args.push(encrypt(i.notes, 'disc_cases.notes')); set += `, notes_enc=$${args.length}`; }
      const row = (await c.query(`UPDATE disc_cases SET status='${status}'${set}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, args)).rows[0];
      await log(c, r.id, i.action, { actor: user.id, from: r.status, to: status, reason: i.reason ?? null, detail: i.interim ? { interim: i.interim } : {} });
      await audit(c, user.id, `discipline_${i.action}`, 'disc_cases', r.id);
      if (row.subject_user_id && ['withdraw', 'set_interim', 'start_review'].includes(i.action)) await tell(c, row.subject_user_id, row);
      return clean(row);
    });
  },
});
cap({
  name: 'add_disciplinary_evidence', method: 'POST', path: '/discipline/cases/:id/evidence', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Attach evidence to a case (panel, secretary, or the person for their own defence / appeal). The body is encrypted; internal evidence is never shown to a team manager and never public.',
  input: z.object({ id, kind: z.enum(['report', 'video', 'statement', 'document', 'other']), title: text(160).min(1), body: text(8000).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await caseFor(user, i.id, { c, lock: true });
      if (s.as === 'team') throw notFound('Case');
      if (s.row.status === 'closed' || s.row.status === 'withdrawn') throw conflict('This case is closed');
      const e = (await c.query('INSERT INTO disc_evidence(case_id, kind, title, body_enc, sha256, added_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, title, created_at', [i.id, i.kind, i.title, i.body ? encrypt(i.body, 'disc_evidence.body') : null, i.sha256 ?? null, user.id])).rows[0];
      await log(c, i.id, 'evidence_added', { actor: user.id, detail: { kind: i.kind, by: s.as } });
      return e;
    });
  },
});
cap({
  name: 'get_disciplinary_evidence', method: 'GET', path: '/discipline/evidence/:id', tag: TAG, scope: SCOPE,
  summary: 'Read one evidence item (decrypts it; the read is audited). Panel, secretary, or the person it concerns for evidence added to their own case.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const e = (await c.query('SELECT * FROM disc_evidence WHERE id=$1', [i.id])).rows[0];
      if (!e) throw notFound('Evidence');
      const s = await caseFor(user, e.case_id, { c });
      if (s.as === 'team') throw notFound('Evidence');
      await audit(c, user.id, 'discipline_evidence_read', 'disc_evidence', e.id);
      return { id: e.id, kind: e.kind, title: e.title, body: e.body_enc ? decrypt(e.body_enc, 'disc_evidence.body') : null, sha256: e.sha256, created_at: e.created_at };
    });
  },
});

// ------------------------------------------------------------------ decisions and sanctions
cap({
  name: 'decide_disciplinary_case', method: 'POST', path: '/discipline/cases/:id/decision', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Record the panel’s decision: upheld with one or more sanctions (warning, match suspension, date suspension, competition ban, role suspension, fine, points deduction, other) or dismissed. Stores authority, reason, policy version and effective dates. A fine becomes a team charge of kind fine; a points deduction a competition standings adjustment; neither touches a match result. A second decision on a case is an amendment that supersedes the first (history kept).',
  input: z.object({ id, outcome: z.enum(['upheld', 'dismissed', 'no_further_action']), reason: text(4000).min(3), sanctions: z.array(sanctionIn).max(8).default([]), version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await caseFor(user, i.id, { c, lock: true });
      needDecide(s);
      if (i.version != null && i.version !== s.row.row_version) throw conflict('The case changed; reload it', { code: 'stale_version' });
      if (['closed', 'withdrawn'].includes(s.row.status)) throw conflict('This case is closed');
      if ((await c.query("SELECT 1 FROM disc_appeals WHERE case_id=$1 AND status IN ('lodged','under_review')", [i.id])).rowCount) throw conflict('An appeal is open; it decides the outcome');
      const out = await recordDecision(c, s.row, { user, kind: 'initial', outcome: i.outcome, authority: s.as === 'panel' ? 'panel' : 'organiser', reason: i.reason, sanctions: i.sanctions });
      const fresh = (await c.query('SELECT * FROM disc_cases WHERE id=$1', [i.id])).rows[0];
      if (fresh.subject_user_id) await tell(c, fresh.subject_user_id, fresh);
      return { decision_id: out.decision.id, kind: out.decision.kind, sanctions: out.sanctions };
    });
  },
});
cap({
  name: 'lift_disciplinary_sanction', method: 'POST', path: '/discipline/sanctions/:id/lift', tag: TAG, scope: SCOPE,
  summary: 'Lift a sanction early (clemency or a correction) with a reason. The sanction and its history stay; a points deduction is reversed through a reversing standings row and an unpaid fine is cancelled. Panel or organiser.',
  input: z.object({ id, reason: text(500).min(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sn = (await c.query('SELECT * FROM disc_sanctions WHERE id=$1', [i.id])).rows[0];
      if (!sn) throw notFound('Sanction');
      const s = await caseFor(user, sn.case_id, { c, lock: true });
      needDecide(s);
      if (!['active', 'stayed'].includes(sn.status)) throw conflict('That sanction is not in force');
      await c.query("UPDATE disc_sanctions SET status='lifted' WHERE id=$1", [sn.id]);
      if (sn.comp_adjustment_id) {
        const a = (await c.query('SELECT * FROM comp_adjustments WHERE id=$1', [sn.comp_adjustment_id])).rows[0];
        await recordAdjustment(c, await divisionRow(c, a.division_id), { team_id: a.team_id, reverses_id: a.id, reason: `Lifted: ${i.reason}`, user_id: user.id, disc_sanction_id: sn.id });
      }
      if (sn.team_charge_id) await c.query("UPDATE team_charges SET status='cancelled' WHERE id=$1 AND status='awaiting_payment' AND settled_minor=0", [sn.team_charge_id]);
      await log(c, sn.case_id, 'sanction_lifted', { actor: user.id, reason: i.reason, detail: { sanction: sn.kind } });
      await audit(c, user.id, 'discipline_sanction_lifted', 'disc_sanctions', sn.id);
      return { id: sn.id, status: 'lifted' };
    });
  },
});

// ------------------------------------------------------------------ appeals
cap({
  name: 'lodge_disciplinary_appeal', method: 'POST', path: '/discipline/cases/:id/appeals', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Appeal the live decision within the policy window (the person, their guardian, or a manager of the team for a team case). Grounds are encrypted; where the policy stays sanctions on appeal, they are paused until the ruling. One open appeal per decision.',
  input: z.object({ id, grounds: text(6000).min(10) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await caseFor(user, i.id, { c, lock: true });
      if (!['subject', 'team'].includes(s.as)) throw forbidden('Only the person concerned (or their guardian or team) can appeal');
      const d = (await c.query("SELECT * FROM disc_decisions WHERE case_id=$1 AND superseded_at IS NULL AND outcome='upheld'", [i.id])).rows[0];
      if (!d) throw conflict('There is no upheld decision to appeal');
      const v = (await c.query('SELECT params FROM disc_policy_versions WHERE id=$1', [d.policy_version_id])).rows[0];
      const p = policyParams.parse(v?.params ?? {});
      const deadline = addDays(String(d.created_at.toISOString()).slice(0, 10), p.appeal_window_days);
      if (today() > deadline) throw conflict(`The appeal window closed on ${deadline}`, { code: 'appeal_window_closed', deadline });
      try {
        const a = (await c.query('INSERT INTO disc_appeals(case_id, decision_id, lodged_by, grounds_enc, deadline_on, stay) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, stay, deadline_on::text AS deadline_on, created_at',
          [i.id, d.id, user.id, encrypt(i.grounds, 'disc_appeals.grounds'), deadline, p.stay_on_appeal])).rows[0];
        if (p.stay_on_appeal) await c.query("UPDATE disc_sanctions SET status='stayed' WHERE decision_id=$1 AND status='active' AND kind IN ('match_suspension','date_suspension','competition_ban','role_suspension')", [d.id]);
        await log(c, i.id, 'appeal_lodged', { actor: user.id, detail: { appeal: a.id, stay: p.stay_on_appeal } });
        await audit(c, user.id, 'discipline_appeal_lodged', 'disc_appeals', a.id);
        return a;
      } catch (e) { if (e.code === '23505') throw conflict('An appeal is already open for this decision'); throw e; }
    });
  },
});
cap({
  name: 'rule_on_disciplinary_appeal', method: 'POST', path: '/discipline/appeals/:id/ruling', tag: TAG, scope: SCOPE,
  summary: 'Rule on an appeal: upheld (decision stands), reduced (give the replacement sanctions), overturned, or remitted (sent back for a fresh decision). The ruling is a new appeal_outcome decision that supersedes the original; the original stays in the history. Panel or organiser; the original decider is not the reviewer.',
  input: z.object({ id, outcome: z.enum(['upheld', 'reduced', 'overturned', 'remitted']), reason: text(4000).min(3), sanctions: z.array(sanctionIn).max(8).default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ap = (await c.query('SELECT * FROM disc_appeals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ap) throw notFound('Appeal');
      const s = await caseFor(user, ap.case_id, { c, lock: true });
      needDecide(s);
      if (!['lodged', 'under_review'].includes(ap.status)) throw conflict('That appeal has been decided');
      const prev = (await c.query('SELECT decided_by FROM disc_decisions WHERE id=$1', [ap.decision_id])).rows[0];
      if (prev?.decided_by === user.id) throw forbidden('The person who made the decision cannot rule on its appeal');
      let outcomeDecision = null;
      if (i.outcome === 'upheld') {
        await activateStayed(c, s.row, user);
      } else if (i.outcome === 'reduced') {
        if (!i.sanctions.length) throw badRequest('Give the reduced sanctions');
        outcomeDecision = (await recordDecision(c, s.row, { user, kind: 'appeal_outcome', outcome: 'upheld', authority: 'appeal_panel', reason: i.reason, sanctions: i.sanctions })).decision;
      } else if (i.outcome === 'overturned') {
        outcomeDecision = (await recordDecision(c, s.row, { user, kind: 'appeal_outcome', outcome: 'dismissed', authority: 'appeal_panel', reason: i.reason })).decision;
      } else {   // remitted: the decision leaves force and the case goes back for a fresh one
        await c.query('UPDATE disc_decisions SET superseded_at=now() WHERE id=$1', [ap.decision_id]);
        await c.query("UPDATE disc_sanctions SET status='superseded' WHERE decision_id=$1 AND status IN ('active','stayed')", [ap.decision_id]);
        await c.query("UPDATE disc_cases SET status='under_review', row_version=row_version+1, updated_at=now() WHERE id=$1", [ap.case_id]);
      }
      const a = (await c.query('UPDATE disc_appeals SET status=$2, reviewer_id=$3, outcome_decision_id=$4, decided_at=now() WHERE id=$1 RETURNING id, status, decided_at', [i.id, i.outcome, user.id, outcomeDecision?.id ?? null])).rows[0];
      await log(c, ap.case_id, 'appeal_ruled', { actor: user.id, reason: i.reason, detail: { appeal: ap.id, outcome: i.outcome } });
      await audit(c, user.id, 'discipline_appeal_ruled', 'disc_appeals', ap.id);
      const fresh = (await c.query('SELECT * FROM disc_cases WHERE id=$1', [ap.case_id])).rows[0];
      if (fresh.subject_user_id) await tell(c, fresh.subject_user_id, fresh);
      return a;
    });
  },
});

// ------------------------------------------------------------------ the person's and the team's own view
cap({
  name: 'list_my_disciplinary', method: 'GET', path: '/me/discipline', tag: TAG, scope: SCOPE,
  summary: 'My own disciplinary matters (and a young person’s I am the verified guardian of): status, outcome, remaining matches to serve and appeal rights. Private to the person; never public.',
  input: z.object({ person_id: id.optional() }),
  async handler({ user }, i) {
    const target = i.person_id ?? user.id;
    if (target !== user.id && !(await isGuardianOf(user.id, target))) throw notFound('Person');
    const rows = await many(
      `SELECT k.id, k.case_no, k.competition_id, k.season_id, k.category, k.status, k.interim_status, k.created_at, c.name AS competition_name, k.policy_version_id FROM disc_cases k JOIN comp_competitions c ON c.id=k.competition_id
        WHERE k.subject_user_id=$1 ORDER BY k.created_at DESC LIMIT 100`, [target]);
    const out = [];
    for (const r of rows) {
      const sanctions = await many("SELECT * FROM disc_sanctions WHERE case_id=$1 AND status IN ('active','stayed') ORDER BY created_at", [r.id]);
      const k = (await pool.query('SELECT * FROM disc_cases WHERE id=$1', [r.id])).rows[0];
      const v = (await pool.query('SELECT params FROM disc_policy_versions WHERE id=$1', [r.policy_version_id])).rows[0];
      for (const x of sanctions) if (x.kind === 'match_suspension') x.service = await serviceOf(pool, x, k, v?.params ?? {});
      const dec = (await pool.query("SELECT created_at FROM disc_decisions WHERE case_id=$1 AND superseded_at IS NULL AND outcome='upheld'", [r.id])).rows[0];
      const p = policyParams.parse(v?.params ?? {});
      out.push({ ...r, sanctions, appeal_deadline: dec ? addDays(dec.created_at.toISOString().slice(0, 10), p.appeal_window_days) : null, notice: NOT_A_FINDING });
    }
    await audit(pool, user.id, 'discipline_own_read', 'users', target);
    return out;
  },
});
cap({
  name: 'list_team_disciplinary', method: 'GET', path: '/teams/:id/discipline', tag: TAG, scope: SCOPE,
  summary: 'The disciplinary outcomes affecting a team’s people, for the team’s managers: sanction type, dates and matches remaining, never the allegation, evidence or panel notes. Team owner or manager only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const team = await one('SELECT * FROM teams WHERE id=$1', [i.id]);
    if (!team || !(await canManageTeam(user, team))) throw notFound('Team');
    const rows = await many(
      `SELECT k.id, k.case_no, k.subject_kind, k.subject_user_id, u.display_name AS subject_name, k.category, k.status, k.competition_id, c.name AS competition_name, k.created_at
         FROM disc_cases k JOIN comp_competitions c ON c.id=k.competition_id LEFT JOIN users u ON u.id=k.subject_user_id WHERE k.team_id=$1 AND k.status IN ('decided','closed') ORDER BY k.created_at DESC LIMIT 100`, [i.id]);
    const out = [];
    for (const r of rows) {
      const sanctions = await many("SELECT kind, scope, matches, effective_from::text AS effective_from, effective_to::text AS effective_to, label, status FROM disc_sanctions WHERE case_id=$1 AND status IN ('active','stayed') ORDER BY created_at", [r.id]);
      out.push({ ...r, sanctions });
    }
    return out;
  },
});
