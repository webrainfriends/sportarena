// Para-sport classification in competition (PS-02, #832): integration only. The classification records, panels, appeals and clinical evidence stay in #488
// (para-*.js); the eligibility engine and registration stay in #477 (registration.js). This file adds role-partitioned PROJECTIONS of the governed class onto
// entries and fixtures, the organiser's category check, and policy-approved provisional participation. It stores no assessment, no diagnosis and no evidence,
// and nothing here lets a person or an AI assign a class: the class is always read from the authorised outcome (or a second-officer-verified external reference).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { actingFor } from '../youth.js';
import { latestPolicy, entryClassCheck, checkDecision, classesFor, protectedIds, PROTECTED_NAME } from '../registration.js';
import { getEvent, isEventStaff, mustStaff } from './registration.js';

const TAG = 'Para classification';
const day = z.string().date();
export const NOTE = 'A competition class is an administrative sporting classification, not a medical diagnosis.';
const NO_FILTER = { query: (t, p) => many(t, p).then((rows) => ({ rows })) };

/** The only fields of a check source any competition role may see: class, status, authority label, version, decision reference, provisional end date. */
export const permitted = (s) => (s ? { kind: s.kind ?? null, class_code: s.class_code ?? null, class_status: s.class_status ?? null, authority: s.label ?? null, version: s.version ?? null, decision_ref: s.decision_ref ?? null, valid_until: s.valid_until ?? null } : null);
const shapeCheck = (r) => (r ? { status: r.status, decision: checkDecision(r), reason: r.reason, source: permitted(r.source) } : null);

cap({
  name: 'my_para_entries', method: 'GET', path: '/me/para-entries', tag: TAG, scope: 'clinical',
  summary: 'Where the athlete\'s (or ward\'s) governed class applies: each competition entry with the class frozen at entry and registration, the class in force now, provisional participation and the plain-language reason. Class, status, authority, version and decision reference only: never a case, panel, evidence or appeal grounds. A verified guardian sees a young athlete\'s entries; nobody else does.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const athleteId = i.athlete_id ?? user.id;
    await actingFor(user, athleteId, 'consent');
    const regs = await many(
      `SELECT r.id, r.event_id, r.division_id, r.status, r.roster_list, e.name AS event, e.sport_id, d.name AS category
         FROM reg_registrations r JOIN events e ON e.id=r.event_id LEFT JOIN reg_divisions d ON d.id=r.division_id
        WHERE r.user_id=$1 AND r.status IN ('submitted','under_review','registered','suspended') ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [athleteId, i.limit, i.offset]);
    const entries = [];
    for (const r of regs) {
      const policy = await latestPolicy(r.event_id);
      const live = policy ? shapeCheck(await entryClassCheck(NO_FILTER, { id: r.event_id, sport_id: r.sport_id }, policy, { user_id: athleteId, division_id: r.division_id })) : null;
      if (!live) continue; // a competition that does not use classification for this category has nothing to show
      const frozen = await many('SELECT stage, decision, check_status, reason, source, policy_version, created_at FROM para_entry_snapshots WHERE registration_id=$1 ORDER BY created_at', [r.id]);
      entries.push({ registration_id: r.id, event_id: r.event_id, event: r.event, category: r.category, registration_status: r.status, accepted_classes: classesFor(policy.rules, r.division_id), live,
        frozen: frozen.map((f) => ({ stage: f.stage, decision: f.decision, reason: f.reason, source: permitted(f.source), policy_version: f.policy_version, at: f.created_at })) });
    }
    return { entries, note: NOTE };
  },
});

cap({
  name: 'check_para_category', method: 'GET', path: '/events/:id/para/check', tag: TAG,
  summary: 'Organiser category check: does this athlete\'s governed class (or verified external reference) satisfy the chosen category of the competition, on a date? Reads the authorised outcome; a class is never guessed or typed in. Returns the class, status, authority, version, decision reference and the reason; never any case, panel or medical evidence. Audit-logged.',
  input: z.object({ id, user_id: id, division_id: id.optional(), on: day.optional() }),
  handler: async ({ user }, i) => {
    const ev = await mustStaff(user, i.id);
    const policy = await latestPolicy(ev.id);
    if (!policy) throw conflict('This competition has no eligibility policy');
    if (i.division_id && !(await one('SELECT 1 FROM reg_divisions WHERE id=$1 AND event_id=$2', [i.division_id, ev.id]))) throw badRequest('Unknown category for this competition');
    const accepted = classesFor(policy.rules, i.division_id);
    const r = await entryClassCheck(NO_FILTER, ev, policy, { user_id: i.user_id, division_id: i.division_id ?? null }, i.on ? new Date(`${i.on}T12:00:00Z`) : new Date());
    await audit(null, user.id, 'read_para_category_check', 'events', ev.id);
    const hidden = await protectedIds([i.user_id]);
    const p = await one('SELECT display_name FROM users WHERE id=$1', [i.user_id]);
    return { athlete: hidden.has(i.user_id) ? PROTECTED_NAME : p?.display_name ?? null, applies: !!r, accepted_classes: accepted, policy_version: policy.version, provisional_allowed: !!policy.rules.allow_provisional, result: shapeCheck(r), note: NOTE };
  },
});

cap({
  name: 'para_event_summary', method: 'GET', path: '/events/:id/para/summary', tag: TAG,
  summary: 'Organiser overview of para entries in a competition: how many have a confirmed class, are pending or in review, are provisional or not eligible, and which entries need attention. Permitted fields only; the organiser never sees case, panel or evidence content.',
  input: z.object({ id, ...page }),
  handler: async ({ user }, i) => {
    const ev = await mustStaff(user, i.id);
    const policy = await latestPolicy(ev.id);
    const regs = policy ? await many(
      `SELECT r.id, r.user_id, r.division_id, r.status, u.display_name, d.name AS category FROM reg_registrations r JOIN users u ON u.id=r.user_id LEFT JOIN reg_divisions d ON d.id=r.division_id
        WHERE r.event_id=$1 AND r.status IN ('submitted','under_review','registered','suspended') ORDER BY r.created_at LIMIT $2 OFFSET $3`, [ev.id, i.limit, i.offset]) : [];
    const hidden = await protectedIds(regs.map((r) => r.user_id));
    const k = { entries: 0, confirmed: 0, pending: 0, provisional: 0, not_eligible: 0 }, attention = [];
    for (const r of regs) {
      const c = await entryClassCheck(NO_FILTER, ev, policy, r);
      if (!c) continue;
      k.entries++;
      const bucket = c.status === 'waived' && c.source?.kind === 'para_provisional' ? 'provisional' : c.status === 'pass' ? 'confirmed' : c.status === 'fail' && !/on record/i.test(c.reason) ? 'not_eligible' : 'pending';
      k[bucket]++;
      if (bucket !== 'confirmed') attention.push({ registration_id: r.id, user_id: r.user_id, athlete: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name, category: r.category, bucket, ...shapeCheck(c) });
    }
    await audit(null, user.id, 'read_para_event_summary', 'events', ev.id);
    return { policy_version: policy?.version ?? null, counts: k, attention, note: NOTE };
  },
});

cap({
  name: 'grant_para_provisional', method: 'POST', path: '/events/:id/para/provisional', tag: TAG, status: 201,
  summary: 'Approve provisional participation for an athlete whose classification is pending, under review or not yet on record, only where the competition policy allows it. Needs a reason and an end date (at most 12 months). Refused where the athlete\'s classification is "not eligible" or outside the category. Records the approver; never creates or implies a class.',
  input: z.object({ id, user_id: id, reason: z.string().trim().min(3).max(1000), valid_until: day }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = await mustStaff(user, i.id, c);
    const policy = await latestPolicy(ev.id, c);
    if (!policy?.rules.allow_provisional) throw conflict('This competition\'s policy does not allow provisional participation', { code: 'provisional_not_allowed' });
    const today = new Date().toISOString().slice(0, 10);
    if (i.valid_until < today || (new Date(i.valid_until) - new Date(today)) / 864e5 > 366) throw badRequest('The end date must be within the next 12 months');
    const r = await entryClassCheck(c, ev, { ...policy, rules: { ...policy.rules, allow_provisional: false } }, { user_id: i.user_id, division_id: (await c.query("SELECT division_id FROM reg_registrations WHERE event_id=$1 AND user_id=$2 AND status IN ('submitted','under_review','registered') ORDER BY created_at DESC LIMIT 1", [ev.id, i.user_id])).rows[0]?.division_id ?? null });
    if (!r) throw conflict('Classification is not used for this athlete\'s category');
    if (r.status === 'pass') throw conflict('The athlete already has a confirmed class');
    if (!/on record|awaiting|needs review|unverified/i.test(r.reason)) throw conflict('Provisional participation is not available for this classification outcome', { code: 'provisional_refused' });
    const row = (await c.query('INSERT INTO para_provisional(event_id, user_id, reason_enc, valid_until, approved_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, valid_until::text AS valid_until, created_at',
      [ev.id, i.user_id, encrypt(i.reason, 'para_provisional.reason'), i.valid_until, user.id])).rows[0];
    await audit(c, user.id, 'grant_para_provisional', 'events', ev.id);
    await notify(c, i.user_id, { kind: 'registration', title: 'Provisional participation was approved', body: `${ev.name}, until ${i.valid_until}. This is not a classification decision.`, data: { event_id: ev.id } });
    return row;
  }),
});

cap({
  name: 'revoke_para_provisional', method: 'POST', path: '/para/provisional/:id/revoke', tag: TAG,
  summary: 'End a provisional participation approval. Match locks already taken keep what they recorded; later checks no longer see it.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM para_provisional WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Provisional approval');
    await mustStaff(user, p.event_id, c).catch((e) => { throw e.status === 403 ? notFound('Provisional approval') : e; });
    if (p.revoked_at) throw conflict('Already ended');
    await c.query('UPDATE para_provisional SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [i.id, user.id]);
    await audit(c, user.id, 'revoke_para_provisional', 'events', p.event_id);
    return { id: p.id, revoked: true };
  }),
});

cap({
  name: 'get_fixture_para_summary', method: 'GET', path: '/fixtures/:id/para', tag: TAG,
  summary: 'Permitted para summary for a fixture, for event staff and the officials assigned to it: per locked player the class, status, authority, rules version and decision reference frozen at match lock, so a later reclassification never changes the record of this match. No case, panel, evidence or grounds; officials cannot change a class.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const fx = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!fx) throw notFound('Fixture');
    const ev = await getEvent(fx.event_id);
    const official = await one("SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status IN ('accepted','completed')", [fx.id, user.id]);
    if (!(await isEventStaff(user, ev)) && !official) throw notFound('Fixture');
    const rows = await many(
      `SELECT s.team_id, t.name AS team, s.user_id, u.display_name, s.stage, s.policy_version, s.checks FROM reg_snapshots s JOIN teams t ON t.id=s.team_id JOIN users u ON u.id=s.user_id
        WHERE s.fixture_id=$1 ORDER BY t.name, u.display_name, s.stage`, [fx.id]);
    const hidden = await protectedIds(rows.map((r) => r.user_id));
    const players = rows.map((r) => ({ ...r, check: r.checks.find((x) => x.rule === 'classification') ?? null })).filter((r) => r.check)
      .map((r) => ({ team_id: r.team_id, team: r.team, athlete: hidden.has(r.user_id) ? PROTECTED_NAME : r.display_name, stage: r.stage, policy_version: r.policy_version, status: r.check.status, reason: r.check.reason, source: permitted(r.check.source) }));
    await audit(null, user.id, 'read_fixture_para_summary', 'fixtures', fx.id);
    return { fixture_id: fx.id, locked: rows.length > 0, players, note: NOTE };
  },
});
