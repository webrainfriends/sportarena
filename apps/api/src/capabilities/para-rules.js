// Para rule packs, lineup validation and override approvals (#834). Incremental on the registration/eligibility engine (#477) and the governed
// classification outcome (#488): no second entity for players, classes or policies. A pack is published per competition, referenced by the
// eligibility policy (rules.para_pack_id) and evaluated inside the same preflight points (registration, squad selection, lock, kick-off).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';
import { DEFINITION, classOf, latestPack, memberCheck } from '../para-rules.js';
import { latestPolicy, paraLineup, protectedIds, PROTECTED_NAME } from '../registration.js';
import { getEvent, isEventStaff, mustStaff } from './registration.js';

const TAG = 'Para rules';
const txt = (n) => z.string().trim().max(n);
const q = { query: (t, p) => many(t, p).then((rows) => ({ rows })) };

/** Who may look at a team's lineup: the organiser or a manager of that team. Everyone else gets a 404 (existence is never leaked). */
async function teamViewer(user, ev, teamId) {
  const staff = await isEventStaff(user, ev);
  const team = await one('SELECT * FROM teams WHERE id=$1', [teamId]);
  if (!team) throw notFound('Team');
  const manager = !staff && (await canManageTeam(user, team));
  if (!staff && !manager) throw notFound('Team');
  return { staff, manager, team };
}
cap({
  name: 'publish_para_rule_pack', method: 'POST', path: '/events/:id/para/rule-packs', tag: TAG, status: 201,
  summary: 'Publish a new version of the para rule pack of a competition: eligible classes, category groupings, accepted classification statuses and declarative validators (class-points cap, class quotas, required roles, lineup size) transcribed from the publisher\'s rulebook. Versions are immutable; reference a version from the eligibility policy (rules.para_pack_id) to lock it. Organiser only.',
  input: z.object({ id, title: txt(120).min(2), publisher: txt(120).min(2).describe('the governing body whose rulebook this transcribes'), source_ref: txt(500).min(2).describe('rulebook section or URL'), definition: DEFINITION, expected_version: z.number().int().min(0) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await mustStaff(user, i.id, c);
      if (!ev.sport_id) throw conflict('Choose the sport of the competition first');
      await c.query('SELECT id FROM events WHERE id=$1 FOR UPDATE', [ev.id]);
      const cur = (await c.query('SELECT coalesce(max(version),0) AS v FROM para_rule_packs WHERE event_id=$1', [ev.id])).rows[0].v;
      if (cur !== i.expected_version) throw conflict('The rule pack changed since you loaded it', { code: 'stale_version', current_version: cur });
      const row = (await c.query(
        `INSERT INTO para_rule_packs(event_id, sport_id, version, title, publisher, source_ref, definition, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, version, title, publisher, source_ref, created_at`, [ev.id, ev.sport_id, cur + 1, i.title, i.publisher, i.source_ref, JSON.stringify(i.definition), user.id])).rows[0];
      await audit(c, user.id, 'publish_para_rule_pack', 'events', ev.id);
      return row;
    });
  },
});

cap({
  name: 'list_para_rule_packs', method: 'GET', path: '/events/:id/para/rule-packs', tag: TAG,
  summary: 'Every published version of the competition\'s para rule pack with its definition, and which one the current eligibility policy is locked to. Visible to the organiser and to managers of teams entered in the competition.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const staff = await isEventStaff(user, ev);
    if (!staff && !(await one(`SELECT 1 FROM reg_registrations r JOIN team_members m ON m.team_id=r.team_id AND m.user_id=$2 AND m.status='active' WHERE r.event_id=$1 LIMIT 1`, [ev.id, user.id]))) throw notFound('Event');
    const packs = await many('SELECT id, version, title, publisher, source_ref, definition, created_at FROM para_rule_packs WHERE event_id=$1 ORDER BY version DESC', [ev.id]);
    const policy = await latestPolicy(ev.id);
    return { packs, locked_pack_id: policy?.rules?.para_pack_id ?? null, can_manage: staff };
  },
});

cap({
  name: 'check_para_lineup', method: 'POST', path: '/fixtures/:id/para/lineup-check', tag: TAG,
  summary: 'Validate a team\'s lineup in a fixture against the competition\'s locked para rule pack: per-person class acceptance and every validator, with plain-language reasons, remediation and approved overrides applied. Without `members` the saved squad is checked; with `members` a lineup is tried out without saving. Read-only apart from the audit entry. Organiser or team manager.',
  input: z.object({ id, team_id: id, members: z.array(z.object({ user_id: id, slot: z.enum(['court', 'bench', 'staff']).default('court'), role: txt(40).optional(), tags: z.array(txt(40)).max(10).default([]) }).strict()).max(60).optional() }),
  async handler({ user }, i) {
    const fixture = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!fixture || ![fixture.home_team_id, fixture.away_team_id].includes(i.team_id)) throw notFound('Fixture');
    const ev = await getEvent(fixture.event_id);
    await teamViewer(user, ev, i.team_id);
    const policy = await latestPolicy(ev.id);
    if (!policy?.rules?.para_pack_id) throw conflict('This competition has no para rule pack', { code: 'no_pack' });
    const rows = i.members?.map((m) => ({ user_id: m.user_id, role: m.slot === 'staff' ? 'coach' : m.slot === 'bench' ? 'substitute' : 'player', slot: m.slot, discipline_role: m.role, tags: m.tags }));
    if (rows) { const ok = new Set((await many("SELECT user_id FROM reg_registrations WHERE event_id=$1 AND team_id=$2 AND status IN ('submitted','under_review','registered','suspended')", [ev.id, i.team_id])).map((r) => r.user_id)); if (rows.some((r) => r.slot !== 'staff' && !ok.has(r.user_id))) throw badRequest('Only people registered with this team can be in a lineup'); }
    const l = await paraLineup(q, ev, policy, fixture, i.team_id, { at: fixture.scheduled_at ?? new Date(), rows });
    await audit(null, user.id, 'check_para_lineup', 'fixtures', fixture.id);
    return { policy_version: policy.version, enforcement: policy.enforcement, ...presentLineup(l) };
  },
});

/** Class code and administrative status only, never anything clinical. */
function presentLineup(l) {
  return {
    pack: l.pack, valid: l.valid, pending: l.pending, applied_overrides: l.applied_overrides ?? [],
    members: l.people.map((m) => ({ user_id: m.user_id, display_name: m.name, slot: m.slot, role: m.role ?? null, class_code: m.class_code, class_status: m.status })),
    member_checks: l.members, checks: l.checks,
  };
}

cap({
  name: 'get_para_eligibility_projection', method: 'GET', path: '/events/:id/para/eligibility', tag: TAG,
  summary: 'Classification-safe eligibility projection: for each registered person the class code, administrative status and whether the competition\'s pack accepts it, with the plain-language reason. Never evidence, diagnosis, assessment notes or case history. The organiser sees everyone, a team manager their teams, an athlete only themselves (their entry explanation).',
  input: z.object({ id, team_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const staff = await isEventStaff(user, ev);
    const policy = await latestPolicy(ev.id);
    const packId = policy?.rules?.para_pack_id;
    const pack = packId ? await latestPack(q, ev.id, packId) : null;
    if (!pack) return { pack: null, rows: [] };
    const def = DEFINITION.parse(pack.definition);
    const args = [ev.id], w = ["r.event_id=$1", "r.status IN ('submitted','under_review','registered','suspended')"];
    if (!staff) {
      const teams = (await many(`SELECT t.id FROM teams t WHERE EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('manager','coach','captain','owner'))`, [user.id])).map((t) => t.id);
      args.push(user.id, teams); w.push('(r.user_id=$2 OR r.team_id = ANY($3::uuid[]))');
    }
    if (i.team_id) { args.push(i.team_id); w.push(`r.team_id=$${args.length}`); }
    args.push(i.limit, i.offset);
    const regs = await many(`SELECT r.id, r.user_id, r.team_id, r.status, u.display_name FROM reg_registrations r JOIN users u ON u.id=r.user_id WHERE ${w.join(' AND ')} ORDER BY u.display_name, r.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    if (!staff && !regs.length) throw notFound('Event');
    const hidden = await protectedIds(regs.map((r) => r.user_id));
    const rows = [];
    for (const r of regs) {
      const cls = await classOf(q, def, ev, r.user_id, new Date());
      const m = memberCheck(def, { user_id: r.user_id, ...cls });
      rows.push({ registration_id: r.id, user_id: r.user_id, team_id: r.team_id, display_name: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name, class_code: cls.class_code, class_status: cls.status, decision: m.status === 'pass' ? 'accepted' : m.status === 'pending' ? 'pending' : 'not_accepted', reason: m.reason, remediation: m.remediation ?? null });
    }
    await audit(null, user.id, 'read_para_eligibility_projection', 'events', ev.id);
    return { pack: { id: pack.id, version: pack.version, title: pack.title, publisher: pack.publisher }, accepted_classes: def.classes.map((c) => c.code), categories: def.categories, rows };
  },
});

cap({
  name: 'request_para_override', method: 'POST', path: '/events/:id/para/overrides', tag: TAG, status: 201,
  summary: 'Ask the organiser for a documented override of one lineup rule of the pack for a team (one fixture or the whole competition). Nothing changes until a different organiser approves it; an approved override shows the check as waived and is recorded in the match snapshot.',
  input: z.object({ id, team_id: id, rule_id: txt(60).min(1), fixture_id: id.optional(), reason: txt(1000).min(3) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await getEvent(i.id, c);
      await teamViewer(user, ev, i.team_id);
      const policy = await latestPolicy(ev.id, c);
      const pack = policy?.rules?.para_pack_id ? await latestPack(c, ev.id, policy.rules.para_pack_id) : null;
      if (!pack) throw conflict('This competition has no para rule pack', { code: 'no_pack' });
      if (!DEFINITION.parse(pack.definition).rules.some((r) => r.id === i.rule_id) && i.rule_id !== 'member_class') throw badRequest(`"${i.rule_id}" is not a rule of the pack`);
      if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, ev.id])).rows[0]) throw notFound('Fixture');
      const row = (await c.query(
        `INSERT INTO para_overrides(event_id, pack_id, fixture_id, team_id, rule_id, reason_enc, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, rule_id, team_id, fixture_id, created_at`,
        [ev.id, pack.id, i.fixture_id ?? null, i.team_id, i.rule_id, encrypt(i.reason, 'para_overrides.reason'), user.id])).rows[0];
      await audit(c, user.id, 'request_para_override', 'events', ev.id);
      if (ev.organizer_id && ev.organizer_id !== user.id) await notify(c, ev.organizer_id, { kind: 'para_override', title: 'Para rule override requested', body: ev.name, data: { event_id: ev.id, override_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'decide_para_override', method: 'POST', path: '/para/overrides/:id/decision', tag: TAG,
  summary: 'Approve or reject a requested override, or revoke an approved one. The decider must be an organiser other than the requester. Approval needs an end time (at most the end of the competition window you choose, max 366 days).',
  input: z.object({ id, decision: z.enum(['approved', 'rejected', 'revoked']), note: txt(1000).min(3), effective_to: z.string().datetime({ offset: true }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = (await c.query('SELECT * FROM para_overrides WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!o) throw notFound('Override');
      const ev = await mustStaff(user, o.event_id, c);
      if (o.requested_by === user.id) throw forbidden('A different organiser must decide your request');
      if (i.decision === 'revoked' ? o.status !== 'approved' : o.status !== 'requested') throw conflict(`The override is already ${o.status}`);
      let to = null;
      if (i.decision === 'approved') {
        to = i.effective_to ? new Date(i.effective_to) : null;
        if (!to || !(to > new Date()) || to.getTime() - Date.now() > 366 * 864e5) throw badRequest('Approval needs an end time in the future, within a year');
      }
      await c.query('UPDATE para_overrides SET status=$2, decided_by=$3, decided_at=now(), decision_note_enc=$4, effective_to=$5 WHERE id=$1', [o.id, i.decision, user.id, encrypt(i.note, 'para_overrides.decision_note'), to]);
      await audit(c, user.id, `para_override_${i.decision}`, 'events', ev.id);
      await notify(c, o.requested_by, { kind: 'para_override', title: `Para rule override ${i.decision}`, body: ev.name, data: { event_id: ev.id, override_id: o.id } });
      return { id: o.id, status: i.decision, effective_to: to };
    });
  },
});

cap({
  name: 'list_para_overrides', method: 'GET', path: '/events/:id/para/overrides', tag: TAG,
  summary: 'Override requests and approvals for the competition (organiser: all; a team manager: their teams). Reasons are encrypted and are not returned here.',
  input: z.object({ id, status: z.enum(['requested', 'approved', 'rejected', 'revoked']).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await getEvent(i.id);
    const staff = await isEventStaff(user, ev);
    const args = [ev.id], w = ['o.event_id=$1'];
    if (!staff) { args.push(user.id); w.push(`(o.requested_by=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$2 AND m.status='active' AND m.role IN ('manager','coach','captain','owner')))`); }
    if (i.status) { args.push(i.status); w.push(`o.status=$${args.length}`); }
    args.push(i.limit, i.offset);
    const rows = await many(`SELECT o.id, o.team_id, t.name AS team_name, o.fixture_id, o.rule_id, o.status, o.requested_by, o.decided_by, o.decided_at, o.effective_to, o.created_at FROM para_overrides o JOIN teams t ON t.id=o.team_id WHERE ${w.join(' AND ')} ORDER BY o.created_at DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    if (!staff && !rows.length && !(await one(`SELECT 1 FROM reg_registrations r JOIN team_members m ON m.team_id=r.team_id AND m.user_id=$2 AND m.status='active' WHERE r.event_id=$1 LIMIT 1`, [ev.id, user.id]))) throw notFound('Event');
    return rows;
  },
});

cap({
  name: 'get_para_lineup_snapshots', method: 'GET', path: '/fixtures/:id/para/snapshots', tag: TAG,
  summary: 'The lineup decisions locked for a fixture (lock and kick-off): pack version, the exact pack definition and the class codes used, so the decision can be reproduced after the rules or classifications change. Organiser or team manager (own team).',
  input: z.object({ id, team_id: id.optional() }),
  async handler({ user }, i) {
    const fixture = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!fixture) throw notFound('Fixture');
    const ev = await getEvent(fixture.event_id);
    const staff = await isEventStaff(user, ev);
    let teams = [fixture.home_team_id, fixture.away_team_id].filter(Boolean);
    if (!staff) { const own = []; for (const t of teams) { try { await teamViewer(user, ev, t); own.push(t); } catch { /* not theirs */ } } if (!own.length) throw notFound('Fixture'); teams = own; }
    if (i.team_id) teams = teams.filter((t) => t === i.team_id);
    return many('SELECT team_id, stage, pack_id, pack_version, valid, members, checks, overrides, evaluated_at FROM para_lineup_snapshots WHERE fixture_id=$1 AND team_id = ANY($2::uuid[]) ORDER BY evaluated_at, stage', [fixture.id, teams]);
  },
});
