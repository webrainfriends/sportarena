// Competition eligibility (issue #477): authorised exceptions, clearance dependencies (references to licence / transfer / loan / disciplinary /
// classification records held elsewhere), the explainable match-day decision, the match-lock snapshot and the deterministic report.
// Rules live in src/registration.js; the policy that applies is the competition's latest version. Exceptions sit BESIDE rules and registrations,
// they never edit either. Snapshots preserve the exact rule set and decision used, so a later policy change never rewrites history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { canManageTeam } from './teams.js';
import { DEP_KINDS, EXCEPTION_RULES, evaluate, evaluateMany, fixtureSquadIds, latestPolicy, lockFixtureEligibility, protectedIds, PROTECTED_NAME } from '../registration.js';
import { REG_COLS, REG_FROM, getEvent, isEventStaff, mustStaff, rosterSummary, viewer } from './registration.js';

const TAG = 'Competition registration';
const txt = (n) => z.string().trim().max(n);
const iso = z.string().date();

// ------------------------------------------------------------------ exceptions / waivers

cap({
  name: 'grant_eligibility_exception', method: 'POST', path: '/events/:id/registration/exceptions', tag: TAG, status: 201,
  summary: 'Grant a documented exception for one person and one rule, for a limited period. Only rules the policy lists as waivable can be waived. The exception never changes the rule or the registration: the decision simply shows the check as waived, naming the exception. Reason and evidence are kept encrypted.',
  input: z.object({ id, user_id: id, rule_key: z.enum(EXCEPTION_RULES), reason: txt(1000).min(3), evidence: txt(500).optional(), effective_from: z.string().datetime({ offset: true }).optional(), effective_to: z.string().datetime({ offset: true }) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await mustStaff(user, i.id, c);
      const policy = await latestPolicy(ev.id, c);
      if (!policy) throw conflict('Publish an eligibility policy first: exceptions are defined by the policy');
      if (!(policy.rules.waivable ?? []).includes(i.rule_key)) throw conflict(`The policy does not allow an exception to ${i.rule_key}`, { code: 'not_waivable', waivable: policy.rules.waivable ?? [] });
      const from = i.effective_from ? new Date(i.effective_from) : new Date(), to = new Date(i.effective_to);
      if (!(to > from)) throw badRequest('The exception ends before it starts');
      if (to.getTime() - from.getTime() > 366 * 864e5) throw badRequest('An exception can last at most a year; renew it if it is still needed');
      const row = (await c.query(
        `INSERT INTO reg_exceptions(event_id, user_id, rule_key, reason_enc, evidence_enc, effective_from, effective_to, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, user_id, rule_key, effective_from, effective_to, granted_by, created_at`,
        [ev.id, i.user_id, i.rule_key, encrypt(i.reason, 'reg_exceptions.reason'), i.evidence ? encrypt(i.evidence, 'reg_exceptions.evidence') : null, from, to, user.id])).rows[0];
      await notify(c, i.user_id, { kind: 'registration', title: 'An exception was recorded for your registration', body: ev.name, data: { event_id: ev.id } });
      return row;
    });
  },
});

cap({
  name: 'revoke_eligibility_exception', method: 'POST', path: '/registration/exceptions/:id/revoke', tag: TAG,
  summary: 'Revoke an exception with a reason. Decisions already locked into a match snapshot keep what they recorded; later checks no longer see the waiver.',
  input: z.object({ id, reason: txt(500).min(3) }),
  async handler({ user }, i) {
    const ex = await one('SELECT * FROM reg_exceptions WHERE id=$1', [i.id]);
    if (!ex) throw notFound('Exception');
    await mustStaff(user, ex.event_id).catch((e) => { throw e.status === 403 ? notFound('Exception') : e; });
    if (ex.revoked_at) throw conflict('Already revoked');
    return one('UPDATE reg_exceptions SET revoked_at=now(), revoked_by=$2, revoke_reason_enc=$3 WHERE id=$1 RETURNING id, rule_key, revoked_at', [i.id, user.id, encrypt(i.reason, 'reg_exceptions.revoke')]);
  },
});

cap({
  name: 'list_eligibility_exceptions', method: 'GET', path: '/events/:id/registration/exceptions', tag: TAG,
  summary: 'Exceptions granted in a competition, newest first, with who granted them, the period and (for the organiser, audit-logged) the reason and evidence. Filter to those in force now with `active`.',
  input: z.object({ id, active: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const ev = await mustStaff(user, i.id);
    const rows = await many(
      `SELECT x.id, x.user_id, p.display_name, x.rule_key, x.reason_enc, x.evidence_enc, x.effective_from, x.effective_to, x.granted_by, g.display_name AS granted_by_name, x.revoked_at,
              (x.revoked_at IS NULL AND x.effective_from <= now() AND x.effective_to > now()) AS in_force, x.created_at
         FROM reg_exceptions x JOIN users p ON p.id=x.user_id JOIN users g ON g.id=x.granted_by WHERE x.event_id=$1 ${i.active ? 'AND x.revoked_at IS NULL AND x.effective_from <= now() AND x.effective_to > now()' : ''}
        ORDER BY x.created_at DESC, x.id LIMIT $2 OFFSET $3`, [ev.id, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_eligibility_exceptions', 'events', ev.id);
    const hidden = await protectedIds(rows.map((r) => r.user_id));
    return rows.map(({ reason_enc, evidence_enc, ...r }) => ({ ...r, display_name: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name, reason: decrypt(reason_enc, 'reg_exceptions.reason'), evidence: evidence_enc ? decrypt(evidence_enc, 'reg_exceptions.evidence') : null }));
  },
});

// ------------------------------------------------------------------ clearance dependencies (suspensions, transfers, licences ...)

cap({
  name: 'record_eligibility_dependency', method: 'POST', path: '/events/:id/registration/dependencies', tag: TAG, status: 201,
  summary: 'Record the state of a licence, transfer, loan, disciplinary (suspension) or classification clearance for a player as a REFERENCE to the authoritative record held elsewhere (source_ref / source_label): clear, pending or blocked, with an optional validity period. A new record supersedes the previous one of the same kind; both stay. Eligibility reads this; nothing about the underlying case is copied here.',
  input: z.object({ id, user_id: id, kind: z.enum(DEP_KINDS), status: z.enum(['clear', 'pending', 'blocked']), source_ref: txt(120).optional(), source_label: txt(120).optional(), valid_from: iso.optional(), valid_until: iso.optional(), note: txt(500).optional() }),
  async handler({ user }, i) {
    if (i.valid_from && i.valid_until && i.valid_until < i.valid_from) throw badRequest('valid_until is before valid_from');
    return tx(async (c) => {
      const ev = await mustStaff(user, i.id, c);
      await c.query('UPDATE reg_dependencies SET superseded_at=now() WHERE event_id=$1 AND user_id=$2 AND kind=$3 AND superseded_at IS NULL', [ev.id, i.user_id, i.kind]);
      const row = (await c.query(
        `INSERT INTO reg_dependencies(event_id, user_id, kind, status, source_ref, source_label, valid_from, valid_until, note_enc, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, user_id, kind, status, source_ref, source_label, valid_from::text AS valid_from, valid_until::text AS valid_until, created_at`,
        [ev.id, i.user_id, i.kind, i.status, i.source_ref ?? null, i.source_label ?? null, i.valid_from ?? null, i.valid_until ?? null, i.note ? encrypt(i.note, 'reg_dependencies.note') : null, user.id])).rows[0];
      if (i.status !== 'clear') await notify(c, i.user_id, { kind: 'registration', title: `Your ${i.kind} status was updated`, body: ev.name, data: { event_id: ev.id } });
      return row;
    });
  },
});

cap({
  name: 'list_eligibility_dependencies', method: 'GET', path: '/events/:id/registration/dependencies', tag: TAG,
  summary: 'Current clearance dependencies (suspensions, licences, transfers, loans, classification) in a competition. The organiser sees the reference and note (audit-logged); a team manager sees only kind, state and validity for their own players, never the source or notes.',
  input: z.object({ id, user_id: id.optional(), kind: z.enum(DEP_KINDS).optional(), status: z.enum(['clear', 'pending', 'blocked']).optional(), history: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const v = await viewer(user, ev);
    const args = [ev.id], w = ['x.event_id=$1'];
    const add = (sql, val) => { args.push(val); w.push(sql.replaceAll('?', `$${args.length}`)); };
    if (!v.staff) {
      if (!v.teams.size) throw notFound('Event');
      add("x.user_id IN (SELECT user_id FROM reg_registrations WHERE event_id=$1 AND team_id = ANY(?::uuid[]) AND status IN ('submitted','under_review','registered','suspended'))", [...v.teams]);
    }
    if (!i.history) w.push('x.superseded_at IS NULL');
    if (i.user_id) add('x.user_id=?', i.user_id);
    if (i.kind) add('x.kind=?', i.kind);
    if (i.status) add('x.status=?', i.status);
    args.push(i.limit, i.offset);
    const rows = await many(
      `SELECT x.id, x.user_id, p.display_name, x.kind, x.status, x.source_ref, x.source_label, x.note_enc, x.valid_from::text AS valid_from, x.valid_until::text AS valid_until, x.superseded_at, x.created_at,
              (x.superseded_at IS NULL AND (x.valid_until IS NULL OR x.valid_until >= current_date) AND (x.valid_from IS NULL OR x.valid_from <= current_date)) AS in_force
         FROM reg_dependencies x JOIN users p ON p.id=x.user_id WHERE ${w.join(' AND ')} ORDER BY x.created_at DESC, x.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    if (v.staff && rows.some((r) => r.note_enc)) await audit(null, user.id, 'read_eligibility_dependencies', 'events', ev.id);
    const hidden = await protectedIds(rows.map((r) => r.user_id));
    return rows.map(({ note_enc, source_ref, source_label, ...r }) => ({ ...r, display_name: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name,
      ...(v.staff ? { source_ref, source_label, note: note_enc ? decrypt(note_enc, 'reg_dependencies.note') : null } : {}) }));
  },
});

// ------------------------------------------------------------------ the decision

/** What a non-organiser may see of a check: the rule, its state and the plain-language reason, never the source label (which can carry federation / admin text). */
const publicCheck = (k) => ({ rule: k.rule, status: k.status, reason: k.reason, ...(k.source ? { source: { kind: k.source.kind, id: k.source.id } } : {}) });

async function decide(c, user, ev, teamId, userIds, fixture) {
  const policy = await latestPolicy(ev.id, c);
  if (!policy) return { policy_version: null, enforcement: null, decisions: userIds.map((u) => ({ user_id: u, team_id: teamId, decision: 'unknown', checks: [{ rule: 'policy', status: 'unknown', reason: 'This competition has no eligibility policy yet' }] })) };
  const ctx = { event: ev, policy, actorId: user.id, at: fixture?.scheduled_at ?? new Date() };
  const decisions = await evaluateMany(c, ctx, teamId, userIds);
  return { policy_version: policy.version, enforcement: policy.enforcement, block_on: policy.rules.block_on, decisions };
}

async function present(out, staff) {
  const users = out.decisions.length ? await many('SELECT id, display_name, handle, avatar_emoji, avatar_color FROM users WHERE id = ANY($1::uuid[])', [out.decisions.map((d) => d.user_id)]) : [];
  const by = new Map(users.map((u) => [u.id, u]));
  const hidden = await protectedIds(users.map((u) => u.id));
  const decisions = out.decisions.map((d) => {
    const u = by.get(d.user_id), p = hidden.has(d.user_id);
    return { user_id: d.user_id, team_id: d.team_id, display_name: p ? PROTECTED_NAME : u?.display_name ?? null, avatar_emoji: p ? null : u?.avatar_emoji ?? null, decision: d.decision,
      reasons: d.checks.filter((k) => k.status !== 'pass').map((k) => k.reason), checks: staff ? d.checks : d.checks.map(publicCheck), registration_id: d.registration_id ?? null };
  });
  const count = (k) => decisions.filter((d) => d.decision === k).length;
  return { policy_version: out.policy_version, enforcement: out.enforcement, block_on: out.block_on ?? null, summary: { eligible: count('eligible'), ineligible: count('ineligible'), pending: count('pending'), unknown: count('unknown') }, decisions };
}

cap({
  name: 'check_fixture_eligibility', method: 'GET', path: '/fixtures/:id/eligibility', tag: TAG,
  summary: 'The match-day decision (eligible / ineligible / pending / unknown) with plain-language reasons and source references, for one team\'s selected squad in a fixture, or for one player (user_id) before selecting them. Evaluated on the server against the competition\'s current policy; the same evaluation runs again when the match is locked or started. The organiser sees full detail; a team manager sees their own team; a player sees only themselves.',
  input: z.object({ id, team_id: id, user_id: id.optional() }),
  async handler({ user }, i) {
    const fixture = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!fixture || ![fixture.home_team_id, fixture.away_team_id].includes(i.team_id)) throw notFound('Fixture');
    const ev = await getEvent(fixture.event_id);
    const staff = await isEventStaff(user, ev);
    const team = await one('SELECT * FROM teams WHERE id=$1', [i.team_id]);
    const manager = !staff && (await canManageTeam(user, team));
    if (!staff && !manager && !(i.user_id && i.user_id === user.id)) throw notFound('Fixture');
    const ids = i.user_id ? [i.user_id] : await fixtureSquadIds(null, fixture, i.team_id);
    const c = { query: (t, p) => many(t, p).then((rows) => ({ rows })) };
    return present(await decide(c, user, ev, i.team_id, ids, fixture), staff);
  },
});

cap({
  name: 'check_player_eligibility', method: 'GET', path: '/events/:id/eligibility', tag: TAG,
  summary: 'The same decision outside a fixture: is this player eligible to represent this team in the competition today. Use it from squad pickers to show a badge before selecting. Same visibility rules as the fixture check.',
  input: z.object({ id, team_id: id, user_id: id.optional() }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const staff = await isEventStaff(user, ev);
    const team = await one('SELECT * FROM teams WHERE id=$1', [i.team_id]);
    if (!team) throw notFound('Team');
    const manager = !staff && (await canManageTeam(user, team));
    const target = i.user_id ?? user.id;
    if (!staff && !manager && target !== user.id) throw notFound('Team');
    const ids = i.user_id || !manager ? [target] : (await many("SELECT user_id FROM reg_registrations WHERE event_id=$1 AND team_id=$2 AND status IN ('submitted','under_review','registered','suspended')", [ev.id, i.team_id])).map((r) => r.user_id);
    const c = { query: (t, p) => many(t, p).then((rows) => ({ rows })) };
    return present(await decide(c, user, ev, i.team_id, ids, null), staff);
  },
});

// ------------------------------------------------------------------ match lock + snapshots

cap({
  name: 'lock_fixture_eligibility', method: 'POST', path: '/fixtures/:id/eligibility/lock', tag: TAG, status: 201,
  summary: 'Lock the squads of a fixture: evaluates every selected player against the current policy and stores, per player, the decision, the reasons, the policy version and the exact rule set used. A blocking policy refuses the lock while a selected player is not eligible (per its block_on setting). Repeating it returns what was already locked. Starting the match locks again under the `start` stage, so both moments are on record. Later policy changes never alter a stored snapshot.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fixture = (await c.query('SELECT * FROM fixtures WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!fixture) throw notFound('Fixture');
      const ev = await mustStaff(user, fixture.event_id, c);
      if (!(await latestPolicy(ev.id, c))) throw conflict('This competition has no eligibility policy');
      const r = await lockFixtureEligibility(c, ev, fixture, user.id, 'lock');
      await audit(c, user.id, 'lock_fixture_eligibility', 'fixtures', fixture.id);
      return { fixture_id: fixture.id, policy_version: r.policy_version, newly_locked: r.locked, players: r.decisions.length };
    });
  },
});

cap({
  name: 'get_eligibility_snapshots', method: 'GET', path: '/fixtures/:id/eligibility/snapshots', tag: TAG,
  summary: 'The eligibility decisions preserved when a fixture\'s squads were locked and when it started: policy version, rule set, per-player decision and reasons, and who locked it. The organiser sees all; a team manager sees their own team.',
  input: z.object({ id, team_id: id.optional() }),
  async handler({ user }, i) {
    const fixture = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!fixture) throw notFound('Fixture');
    const ev = await getEvent(fixture.event_id);
    const v = await viewer(user, ev);
    if (!v.staff && !v.teams.size) throw notFound('Fixture');
    const args = [fixture.id], w = ['s.fixture_id=$1'];
    if (!v.staff) { args.push([...v.teams]); w.push(`s.team_id = ANY($${args.length}::uuid[])`); }
    if (i.team_id) { args.push(i.team_id); w.push(`s.team_id=$${args.length}`); }
    const rows = await many(`SELECT s.id, s.team_id, t.name AS team_name, s.user_id, u.display_name, s.stage, s.decision, s.checks, s.policy_version, s.rules, s.registration_id, s.registration_version, s.evaluated_at, s.locked_by
        FROM reg_snapshots s JOIN users u ON u.id=s.user_id JOIN teams t ON t.id=s.team_id WHERE ${w.join(' AND ')} ORDER BY s.stage, t.name, u.display_name, s.id`, args);
    const hidden = await protectedIds(rows.map((r) => r.user_id));
    return rows.map((r) => ({ ...r, display_name: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name,
      checks: v.staff ? r.checks : r.checks.map(publicCheck), rules: v.staff ? r.rules : undefined }));
  },
});

// ------------------------------------------------------------------ reports

cap({
  name: 'get_registration_report', method: 'GET', path: '/events/:id/registration/report', tag: TAG,
  summary: 'A deterministic registration report for the organiser: roster compliance per team, every registration (team, player, number, list, status, origin, window, dates), exceptions in force and open clearance dependencies, ordered the same way every time. `format=csv` returns the registrations as CSV. Exporting is audit-logged; young people without current consent appear as "Protected participant" and organiser notes and reasons are never included.',
  input: z.object({ id, format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    const ev = await mustStaff(user, i.id);
    const regs = await many(`SELECT ${REG_COLS} FROM ${REG_FROM} WHERE r.event_id=$1 ORDER BY t.name, t.id, lower(u.display_name), r.id`, [ev.id]);
    const hidden = await protectedIds(regs.map((r) => r.user_id));
    const rows = regs.map((r) => ({ team: r.team_name, player: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name, registration_no: r.registration_no ?? '', status: r.status, roster_list: r.roster_list, division: r.division_name ?? '',
      origin_class: r.origin_class, window: r.window_kind ?? '', effective_from: r.effective_from ?? '', effective_to: r.effective_to ?? '' }));
    await audit(null, user.id, 'export_registration_report', 'events', ev.id);
    const cols = ['team', 'player', 'registration_no', 'status', 'roster_list', 'division', 'origin_class', 'window', 'effective_from', 'effective_to'];
    if (i.format === 'csv') return { filename: `registrations-${ev.id.slice(0, 8)}.csv`, rows: rows.length, csv: toCsv(cols, rows) };
    const exceptions = await many(`SELECT x.rule_key, count(*)::int AS n FROM reg_exceptions x WHERE x.event_id=$1 AND x.revoked_at IS NULL AND x.effective_from <= now() AND x.effective_to > now() GROUP BY 1 ORDER BY 1`, [ev.id]);
    const holds = await many("SELECT kind, status, count(*)::int AS n FROM reg_dependencies WHERE event_id=$1 AND superseded_at IS NULL AND status <> 'clear' GROUP BY 1,2 ORDER BY 1,2", [ev.id]);
    const byStatus = await many('SELECT status, count(*)::int AS n FROM reg_registrations WHERE event_id=$1 GROUP BY 1 ORDER BY 1', [ev.id]);
    return { event: { id: ev.id, name: ev.name }, rosters: await rosterSummary(ev), totals: byStatus, exceptions_in_force: exceptions, open_dependencies: holds, registrations: rows };
  },
});
