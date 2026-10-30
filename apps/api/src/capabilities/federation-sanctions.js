// Federation & Governing Body OS (#475) 4/4: competition sanctioning. A governing body sanctions an EXISTING SportArena event: the sanction references the
// canonical event (never a second one), checks it against the body's published conditions read live from the event's own venue, officials, insurance
// and entries, and records an immutable decision with the policy version it was made under.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { requireApproved } from '../access.js';
import { hasOrgGrant } from '../org-access.js';
import { authority, need, mustBeActive, bodyById, lockBody, logFed, historyOf, nextNumber, policyAt, paramsOf, check, blocking, AFF_STATUS, LIC_STATUS, today, lineage, subtree, plain } from '../federation.js';
import { gate } from '../federation-approvals.js';
import { subjectFor, needStaff, staffCan, staffRecipients, evidenceIn, addEvidence, evidenceList, readEvidence, removeEvidence, missingDocuments } from '../federation-subjects.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const OFFICIAL_ROLES = ['referee', 'umpire', 'linesman', 'scorer'];
const categoryList = z.array(text(60).min(1)).max(30).describe('the age groups, divisions or classes the competition covers');

async function organiserEvent(user, eventId, c = pool) {
  const ev = plain((await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0]);
  if (!ev) throw notFound('Event');
  const ok = ev.organizer_id === user.id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c);
  return { ev, organiser: ok };
}

/** The checks a sanction runs, from the body's published conditions and the event as it stands NOW (venue, crew, insurance, entries). */
export async function sanctionChecks(c, s, ev, { range, withDocuments = true } = {}) {
  const pol = await policyAt(s.body_id, 'sanction', { sportId: ev.sport_id, seasonYear: Number(String(range?.from ?? ev.starts_on ?? today()).slice(0, 4)) }, c);
  const p = paramsOf('sanction', pol);
  const from = range?.from ?? s.requested_starts_on, to = range?.to ?? s.requested_ends_on;
  const evFrom = ev.starts_on, evTo = ev.ends_on, iso = (d) => d;
  const checks = [
    check('event_open', 'The event is still going ahead', !['cancelled', 'completed'].includes(ev.status), ev.status),
    check('dates', 'The sanctioned dates cover the event', !!evFrom && !!evTo && iso(from) <= evFrom && iso(to) >= evTo, evFrom ? `Event runs ${evFrom} to ${evTo}` : 'The event has no dates yet'),
  ];
  if (p.lead_time_days) {
    const left = evFrom ? Math.floor((new Date(`${evFrom}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 864e5) : null;
    checks.push(check('lead_time', `At least ${p.lead_time_days} days' notice`, left !== null && left >= p.lead_time_days, left === null ? 'No start date' : `${left} days to the start`));
  }
  if (p.require_venue) checks.push(check('venue', 'A venue is confirmed', !!ev.venue_id, ev.venue_id ? null : 'The event has no venue yet'));
  if (p.require_ruleset) {
    const rv = s.ruleset_version_id ? (await c.query('SELECT version, format_key, label FROM ruleset_versions WHERE id=$1 AND sport_id=$2', [s.ruleset_version_id, ev.sport_id])).rows[0] : null;
    checks.push(check('ruleset', 'Plays under a governed rule version', !!rv && (!p.min_ruleset_version || rv.version >= p.min_ruleset_version), rv ? `${rv.label} v${rv.version}` : 'Choose the governed rule version the competition runs under'));
  }
  if (p.min_officials || p.require_licensed_officials) {
    const crew = (await c.query(
      `SELECT a.user_id, r.role FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status IN ('accepted','completed') AND r.role = ANY($2)`, [ev.id, OFFICIAL_ROLES])).rows;
    const people = [...new Set(crew.map((x) => x.user_id))];
    if (p.min_officials) checks.push(check('officials', `At least ${p.min_officials} officials confirmed`, people.length >= p.min_officials, `${people.length} confirmed`));
    if (p.require_licensed_officials) {
      const up = await lineage(s.body_id, c);
      const ok = people.length ? (await c.query(
        `SELECT DISTINCT l.holder_id FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id
          WHERE l.body_id = ANY($1) AND l.holder_id = ANY($2) AND t.holder_role='official' AND t.sport_id=$3 AND t.grade_rank >= $4 AND (${LIC_STATUS('l')})='active'`, [up, people, ev.sport_id, p.min_official_grade_rank])).rows.map((x) => x.holder_id) : [];
      const bad = people.filter((u) => !ok.includes(u)).length;
      checks.push(check('licensed_officials', `Officials hold a current licence${p.min_official_grade_rank ? ` of grade rank ${p.min_official_grade_rank} or above` : ''}`, people.length > 0 && bad === 0, people.length ? (bad ? `${bad} of ${people.length} without a qualifying licence` : `${people.length} licensed`) : 'No officials confirmed yet'));
    }
  }
  if (p.require_insurance) {
    const ins = (await c.query("SELECT 1 FROM insurance_policies WHERE subject_type='event' AND subject_id=$1 AND status='active' AND starts_on <= $2::date AND ends_on >= $3::date LIMIT 1", [ev.id, evFrom ?? today(), evTo ?? evFrom ?? today()])).rowCount > 0;
    checks.push(check('insurance', 'Event insurance covers the dates', ins, ins ? null : 'No active event insurance covers the event dates'));
  }
  if (p.require_affiliated_entrants) {
    const down = await subtree(s.body_id, c);
    const rows = (await c.query(
      `SELECT t.id, t.organisation_id, EXISTS (SELECT 1 FROM fed_affiliations a WHERE a.organisation_id=t.organisation_id AND a.body_id = ANY($2) AND (${AFF_STATUS('a')})='approved') AS ok
         FROM event_entries e JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status='accepted'`, [ev.id, down])).rows;
    const bad = rows.filter((r) => !r.ok).length;
    checks.push(check('entrants', 'Every entered team is from an affiliated club', rows.length > 0 && bad === 0, rows.length ? (bad ? `${bad} of ${rows.length} teams are not from an affiliated club` : `${rows.length} teams, all affiliated`) : 'No accepted entries yet'));
  }
  if (withDocuments && p.required_documents?.length) {
    const missing = s.id ? await missingDocuments(c, 'sanction', s.id, p.required_documents) : p.required_documents;
    checks.push(check('documents', 'Required documents are attached', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : `${p.required_documents.length} attached`));
  }
  return { checks, policy: pol, params: p };
}

const SAN_COLS = `s.id, s.body_id, bo.name AS body_name, b.abbreviation AS body_abbreviation, s.event_id, e.name AS event_name, e.kind AS event_kind, e.status AS event_status, e.sport_id, sp.name AS sport_name, e.city AS event_city,
  e.starts_on::text AS event_starts_on, e.ends_on::text AS event_ends_on, e.venue_id, v.name AS venue_name, eo.name AS organiser_organisation, s.status, s.sanction_no, s.categories, s.approved_categories, s.requested_starts_on::text AS requested_starts_on, s.requested_ends_on::text AS requested_ends_on,
  s.approved_starts_on::text AS approved_starts_on, s.approved_ends_on::text AS approved_ends_on, s.ruleset_version_id, rv.label AS ruleset_label, rv.version AS ruleset_version, s.conditions, s.override_reason, s.decision_reason, s.decided_at, s.row_version, s.created_at,
  CASE WHEN s.status IN ('approved','suspended') AND (e.status = 'cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on) THEN true ELSE false END AS drift`;
const SAN_FROM = `fed_sanctions s JOIN governing_bodies b ON b.id=s.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN events e ON e.id=s.event_id JOIN sports sp ON sp.id=e.sport_id
  LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN organisations eo ON eo.id=e.organisation_id LEFT JOIN ruleset_versions rv ON rv.id=s.ruleset_version_id`;
export const sanctionRow = async (sid, c = pool) => (await c.query(`SELECT ${SAN_COLS} FROM ${SAN_FROM} WHERE s.id=$1`, [sid])).rows[0];

const ACTIONS = {
  staff: { requested: ['start_review', 'request_info', 'approve', 'reject'], under_review: ['request_info', 'approve', 'reject'], needs_info: ['reject'], approved: ['suspend', 'revoke'], suspended: ['reinstate', 'revoke'] },
  party: { requested: ['amend', 'withdraw'], under_review: ['withdraw'], needs_info: ['amend', 'resubmit', 'withdraw'], approved: ['withdraw'], suspended: ['withdraw'] },
};

async function detail(s, c = pool) {
  const row = await sanctionRow(s.row.id, c);
  const acts = [...(staffCan(s, 'sanctions') ? ACTIONS.staff[row.status] ?? [] : []), ...(s.party ? ACTIONS.party[row.status] ?? [] : [])];
  const pol = await policyAt(s.row.body_id, 'sanction', { sportId: s.event.sport_id }, c);
  return {
    ...row, as: { party: s.party, staff: !!s.auth && !s.auth.viaAncestor }, actions: acts, requirements: pol ? { policy_title: pol.title, version: pol.version, inherited: pol.inherited, ...paramsOf('sanction', pol) } : null,
    evidence: await evidenceList('sanction', s.row.id, c), history: await historyOf('sanction', s.row.id, c), decided_checks: s.row.checks,
    ...((staffCan(s, 'sanctions') || s.party) && ['requested', 'under_review', 'needs_info', 'approved', 'suspended'].includes(row.status) ? { preview: (await sanctionChecks(c, s.row, s.event, { range: { from: row.approved_starts_on ?? row.requested_starts_on, to: row.approved_ends_on ?? row.requested_ends_on } })).checks } : {}),
  };
}

// ------------------------------------------------------------------ request / amend / withdraw
cap({
  name: 'check_sanction_readiness', method: 'GET', path: '/federation/sanction-readiness', tag: TAG,
  summary: 'Before asking, see how an event measures up to a body\'s published sanctioning conditions: venue, rule version, officials and their licences, insurance, entrants. Read live from the event; nothing is stored. For the event\'s organisers and the body\'s staff.',
  input: z.object({ body_id: id, event_id: id, ruleset_version_id: id.optional() }),
  async handler({ user }, i) {
    const { ev, organiser } = await organiserEvent(user, i.event_id);
    const auth = await authority(user, i.body_id, { optional: true });
    if (!organiser && !auth) throw notFound('Event');
    const body = await bodyById(i.body_id);
    const fake = { id: null, body_id: i.body_id, ruleset_version_id: i.ruleset_version_id ?? null, requested_starts_on: ev.starts_on, requested_ends_on: ev.ends_on };
    const r = await sanctionChecks(pool, fake, ev, { range: { from: ev.starts_on, to: ev.ends_on }, withDocuments: false });
    return { body: { id: body.id, name: body.name }, event: { id: ev.id, name: ev.name }, requirements: r.policy ? { policy_title: r.policy.title, version: r.policy.version, inherited: r.policy.inherited, ...r.params } : null, checks: r.checks, ready: blocking(r.checks).length === 0 };
  },
});

cap({
  name: 'request_sanction', method: 'POST', path: '/federation/sanctions', tag: TAG, status: 201,
  summary: 'Ask a governing body to sanction one of your events (the event\'s organiser or its organisation\'s admins). Name the categories the competition covers, optionally the governed rule version it runs under, and the dates if they differ from the event\'s. This references your existing event: no second event is created, and nothing about the event changes.',
  input: z.object({ body_id: id, event_id: id, categories: categoryList.default([]), ruleset_version_id: id.optional(), starts_on: day.optional(), ends_on: day.optional(), note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    const { ev, organiser } = await organiserEvent(user, i.event_id, c);
    if (!organiser) throw forbidden('Only the event\'s organisers can ask for a sanction');
    await lockBody(c, i.body_id);
    const body = await bodyById(i.body_id, c);
    mustBeActive(body);
    if (!(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.body_id, ev.sport_id])).rowCount) throw badRequest('This body does not govern the event\'s sport');
    if (['cancelled', 'completed'].includes(ev.status)) throw conflict(`This event is ${ev.status}`);
    const from = i.starts_on ?? ev.starts_on, to = i.ends_on ?? ev.ends_on ?? from;
    if (!from) throw badRequest('Set the event\'s dates first, or give the dates to sanction');
    if (to < from) throw badRequest('The end date is before the start date');
    if (i.ruleset_version_id && !(await c.query('SELECT 1 FROM ruleset_versions WHERE id=$1 AND sport_id=$2', [i.ruleset_version_id, ev.sport_id])).rowCount) throw badRequest('That rule version is for another sport');
    let s;
    try {
      s = (await c.query('INSERT INTO fed_sanctions(body_id, event_id, applicant_id, categories, ruleset_version_id, requested_starts_on, requested_ends_on, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.body_id, i.event_id, user.id, i.categories, i.ruleset_version_id ?? null, from, to, i.note || null])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('This body already has an open or current sanction for this event'); throw e; }
    await logFed(c, i.body_id, 'sanction', s.id, 'requested', { to: 'requested', actor: user.id, detail: { event_id: i.event_id } });
    for (const uid of await staffRecipients(c, body, ['sanctioner'])) await notify(c, uid, { kind: 'federation_sanction_requested', title: 'New sanction request', body: `${ev.name} asks ${body.abbreviation} for a sanction.`, data: { sanction_id: s.id, body_id: body.id }, dedupe_key: `fed-san-req:${s.id}:${uid}` });
    return sanctionRow(s.id, c);
  }),
});

cap({
  name: 'amend_sanction', method: 'PATCH', path: '/federation/sanctions/:id', tag: TAG,
  summary: 'Change a request that is waiting or was sent back (the event\'s organisers): the categories, the governed rule version, the dates or the note. Set `resubmit` to send a request that needed more information back for review.',
  input: z.object({ id, categories: categoryList.optional(), ruleset_version_id: id.nullish(), starts_on: day.optional(), ends_on: day.optional(), note: text(1000).optional(), resubmit: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'sanction', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the event\'s organisers amend a request');
    if (!['requested', 'needs_info'].includes(s.row.status)) throw conflict(`This request is ${s.row.status}`);
    if (i.ruleset_version_id && !(await c.query('SELECT 1 FROM ruleset_versions WHERE id=$1 AND sport_id=$2', [i.ruleset_version_id, s.event.sport_id])).rowCount) throw badRequest('That rule version is for another sport');
    const from = i.starts_on ?? s.row.requested_starts_on, to = i.ends_on ?? s.row.requested_ends_on;
    if (to < from) throw badRequest('The end date is before the start date');
    const status = i.resubmit && s.row.status === 'needs_info' ? 'requested' : s.row.status;
    await c.query('UPDATE fed_sanctions SET categories=$2, ruleset_version_id=$3, requested_starts_on=$4, requested_ends_on=$5, note=$6, status=$7, row_version=row_version+1, updated_at=now() WHERE id=$1',
      [s.row.id, i.categories ?? s.row.categories, i.ruleset_version_id === undefined ? s.row.ruleset_version_id : i.ruleset_version_id, from, to, i.note ?? s.row.note, status]);
    await logFed(c, s.row.body_id, 'sanction', s.row.id, status !== s.row.status ? 'resubmitted' : 'amended', { from: s.row.status, to: status, actor: user.id });
    return sanctionRow(s.row.id, c);
  }),
});

cap({
  name: 'withdraw_sanction', method: 'POST', path: '/federation/sanctions/:id/withdraw', tag: TAG,
  summary: 'Withdraw a request, or give up a sanction (the event\'s organisers). The record stays.',
  input: z.object({ id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'sanction', i.id, { c, lock: true });
    if (!s.party) throw forbidden('Only the event\'s organisers withdraw');
    if (!(ACTIONS.party[s.row.status] ?? []).includes('withdraw')) throw conflict(`This request is ${s.row.status}`);
    await c.query("UPDATE fed_sanctions SET status='withdrawn', row_version=row_version+1, updated_at=now() WHERE id=$1", [s.row.id]);
    await logFed(c, s.row.body_id, 'sanction', s.row.id, 'withdrawn', { from: s.row.status, to: 'withdrawn', actor: user.id, reason: i.reason });
    return sanctionRow(s.row.id, c);
  }),
});

// ------------------------------------------------------------------ decisions
cap({
  name: 'decide_sanction', method: 'POST', path: '/federation/sanctions/:id/decision', tag: TAG,
  summary: 'Decide a sanction request (sanctioning officer/admin): start_review, request_info, approve, reject, suspend, reinstate or revoke. Approval sets the sanction number, the approved dates and categories and any conditions, after running the body\'s published conditions against the event as it is now; a failed condition needs an `override_reason`, recorded as a compliance exception. The decision keeps the policy version it was made under. Pass `version` to refuse a decision on a record that changed meanwhile.',
  input: z.object({ id, action: z.enum(['start_review', 'request_info', 'approve', 'reject', 'suspend', 'reinstate', 'revoke']), reason: text(500).optional(), approved_categories: categoryList.optional(), approved_starts_on: day.optional(), approved_ends_on: day.optional(),
    conditions: z.array(text(200).min(2)).max(10).optional(), override_reason: text(500).min(5).optional(), version: z.number().int().min(1).optional(), approval_id: id.optional().describe('the second person\'s approval, where the body requires four eyes') }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await subjectFor(user, 'sanction', i.id, { c, lock: true });
    needStaff(s, 'sanctions');
    const r = s.row;
    if (i.version && i.version !== r.row_version) throw conflict('This request changed since you opened it; reload and decide again', { code: 'stale_version' });
    if (!(ACTIONS.staff[r.status] ?? []).includes(i.action)) throw conflict(`You cannot ${i.action.replace('_', ' ')} a request that is ${r.status}`);
    if (['request_info', 'reject', 'suspend', 'revoke'].includes(i.action) && !i.reason?.trim()) throw badRequest('Give a reason; the organiser is shown it');
    const body = await bodyById(r.body_id, c);
    let patch = {}, to;
    if (i.action === 'start_review') to = 'under_review';
    else if (i.action === 'request_info') to = 'needs_info';
    else if (i.action === 'reject') { to = 'rejected'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'suspend') { to = 'suspended'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'revoke') { to = 'revoked'; patch = { decision_reason: i.reason }; }
    else if (i.action === 'reinstate') { to = 'approved'; patch = { decision_reason: i.reason ?? null }; }
    else {
      mustBeActive(body);
      const from = i.approved_starts_on ?? r.requested_starts_on, toD = i.approved_ends_on ?? r.requested_ends_on;
      if (toD < from) throw badRequest('The end date is before the start date');
      const { checks, policy } = await sanctionChecks(c, r, s.event, { range: { from, to: toD } });
      const fails = blocking(checks);
      if (fails.length && !i.override_reason) throw conflict(`Not all conditions are met: ${fails.map((x) => x.label).join('; ')}. Fix them, or approve with an override reason.`, { code: 'requirements_not_met', checks });
      await gate(c, user, { bodyId: r.body_id, actions: fails.length ? ['eligibility_override', 'sanction_approve'] : ['sanction_approve'], subjectType: 'sanction', subjectId: r.id, request: { act: 'approve', override: fails.length ? i.override_reason : null }, approvalId: i.approval_id });
      to = 'approved';
      patch = { sanction_no: r.sanction_no ?? await nextNumber(c, r.body_id, 'sanction', String(from).slice(0, 4)), approved_categories: i.approved_categories ?? r.categories, approved_starts_on: from, approved_ends_on: toD, conditions: i.conditions ?? r.conditions,
        checks: JSON.stringify(checks), policy_version_id: policy?.version_id ?? null, override_reason: fails.length ? i.override_reason : null, decision_reason: i.reason ?? null };
    }
    const keys = Object.keys(patch);
    await c.query(`UPDATE fed_sanctions SET status=$2, decided_by=$3, decided_at=now(), row_version=row_version+1, updated_at=now()${keys.map((k, n) => `, ${k}=$${n + 4}`).join('')} WHERE id=$1`, [r.id, to, user.id, ...keys.map((k) => patch[k])]);
    await logFed(c, r.body_id, 'sanction', r.id, i.action, { from: r.status, to, actor: user.id, reason: i.reason ?? patch.override_reason,
      detail: { ...(patch.override_reason ? { override_reason: patch.override_reason } : {}), ...(patch.sanction_no ? { sanction_no: patch.sanction_no, approved_starts_on: patch.approved_starts_on, approved_ends_on: patch.approved_ends_on, conditions: patch.conditions } : {}), ...(patch.policy_version_id ? { policy_version_id: patch.policy_version_id } : {}) } });
    const msg = { start_review: ['Sanction under review', 'The body has started reviewing your request.'], request_info: ['More information needed', i.reason], approve: ['Competition sanctioned', `${s.event.name} is sanctioned: ${patch.sanction_no ?? ''}.`],
      reject: ['Sanction not granted', i.reason], suspend: ['Sanction suspended', i.reason], reinstate: ['Sanction reinstated', 'Your sanction is back in force.'], revoke: ['Sanction revoked', i.reason] }[i.action];
    await notify(c, r.applicant_id, { kind: `federation_sanction_${i.action}`, title: msg[0], body: `${body.abbreviation}: ${msg[1] ?? ''}`, data: { sanction_id: r.id, event_id: r.event_id }, dedupe_key: `fed-san:${r.id}:${r.row_version + 1}` });
    await audit(c, user.id, `federation_sanction_${i.action}`, 'fed_sanctions', r.id);
    return sanctionRow(r.id, c);
  }),
});

// ------------------------------------------------------------------ reads
cap({
  name: 'list_sanctions', method: 'GET', path: '/federation/sanctions', tag: TAG,
  summary: 'Sanction requests and sanctions. As a body\'s staff (or staff of a body above it): pass `body_id`, optionally `include_descendants`. As an organiser: pass `mine` for your events\' requests, or `event_id`. `drift` lists approved sanctions whose event has since moved outside the approved dates or been cancelled.',
  input: z.object({ body_id: id.optional(), event_id: id.optional(), mine: z.coerce.boolean().optional(), status: z.enum(['requested', 'under_review', 'needs_info', 'approved', 'rejected', 'suspended', 'revoked', 'withdrawn']).optional(), drift: z.coerce.boolean().optional(), q: text(80).optional(), include_descendants: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    if (!i.body_id && !i.mine && !i.event_id) throw badRequest('Give body_id, event_id or mine');
    const auth = i.body_id ? await authority(user, i.body_id, { optional: true }) : null;
    if (i.body_id && !auth && !i.mine && !i.event_id) throw notFound('Governing body');
    const bodyIds = i.body_id ? (auth && i.include_descendants ? await subtree(i.body_id) : [i.body_id]) : null;
    if (i.event_id && !auth) { const { organiser } = await organiserEvent(user, i.event_id); if (!organiser) throw notFound('Event'); }
    const mineFilter = !auth;
    const where = `($1::uuid[] IS NULL OR s.body_id = ANY($1)) AND ($2::uuid IS NULL OR s.event_id=$2) AND ($3::boolean IS FALSE OR (e.organizer_id=$4 OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=e.organisation_id AND m.user_id=$4 AND m.status='active' AND m.role IN ('owner','admin'))))
      AND ($5::text IS NULL OR s.status=$5) AND ($6::boolean IS NULL OR (CASE WHEN s.status IN ('approved','suspended') AND (e.status='cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on) THEN true ELSE false END)=$6)
      AND ($7::text IS NULL OR e.name ILIKE '%'||$7||'%' OR s.sanction_no ILIKE '%'||$7||'%')`;
    const a = [bodyIds, i.event_id ?? null, mineFilter, user.id, i.status ?? null, i.drift ?? null, i.q || null];
    const total = await one(`SELECT count(*)::int AS n FROM ${SAN_FROM} WHERE ${where}`, a);
    const items = await many(`SELECT ${SAN_COLS} FROM ${SAN_FROM} WHERE ${where} ORDER BY (s.status IN ('requested','under_review')) DESC, s.created_at DESC, s.id LIMIT $8 OFFSET $9`, [...a, i.limit, i.offset]);
    return { total: total.n, items };
  },
});

cap({
  name: 'get_sanction', method: 'GET', path: '/federation/sanctions/:id', tag: TAG,
  summary: 'One sanction request with its conditions, a live readiness check, the evidence list (metadata only), decision history and the actions you may take (the body\'s staff and the event\'s organisers).',
  input: z.object({ id }),
  async handler({ user }, i) { return detail(await subjectFor(user, 'sanction', i.id)); },
});
cap({
  name: 'add_sanction_evidence', method: 'POST', path: '/federation/sanctions/:id/evidence', tag: TAG, status: 201,
  summary: 'Attach a document or reference to a sanction request that is waiting or was sent back. Encrypted; only metadata is ever listed.',
  input: z.object({ id }).and(evidenceIn),
  handler: ({ user }, i) => tx(async (c) => { const s = await subjectFor(user, 'sanction', i.id, { c, lock: true }); const { id: _id, ...e } = i; return addEvidence(c, s, user, e); }),
});
cap({
  name: 'read_sanction_evidence', method: 'GET', path: '/federation/sanctions/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Read one evidence item in full (the organiser, or the body\'s sanctioning officer/compliance/admin). Every read is audit-logged.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => readEvidence(c, await subjectFor(user, 'sanction', i.id, { c }), user, i.evidence_id)),
});
cap({
  name: 'remove_sanction_evidence', method: 'DELETE', path: '/federation/sanctions/:id/evidence/:evidence_id', tag: TAG,
  summary: 'Take an item off a request that is still waiting or was sent back. It is hidden, not erased.',
  input: z.object({ id, evidence_id: id }),
  handler: ({ user }, i) => tx(async (c) => removeEvidence(c, await subjectFor(user, 'sanction', i.id, { c, lock: true }), i.evidence_id)),
});

cap({
  name: 'get_event_sanctions', method: 'GET', path: '/events/:id/sanctions', tag: TAG, auth: 'public',
  summary: 'Which governing bodies sanction an event, in force today (public): body, sanction number, status, approved dates, categories and conditions.',
  input: z.object({ id }),
  async handler(_ctx, i) {
    if (!(await one('SELECT 1 FROM events WHERE id=$1', [i.id]))) throw notFound('Event');
    return many(
      `SELECT s.id, s.body_id, bo.name AS body_name, b.abbreviation AS body_abbreviation, b.level, s.sanction_no, s.status, s.approved_starts_on::text AS approved_starts_on, s.approved_ends_on::text AS approved_ends_on, s.approved_categories, s.conditions,
              CASE WHEN e.status = 'cancelled' OR e.starts_on < s.approved_starts_on OR e.ends_on > s.approved_ends_on THEN true ELSE false END AS drift
         FROM fed_sanctions s JOIN governing_bodies b ON b.id=s.body_id JOIN organisations bo ON bo.id=b.organisation_id JOIN events e ON e.id=s.event_id WHERE s.event_id=$1 AND s.status IN ('approved','suspended','revoked') ORDER BY s.decided_at DESC`, [i.id]);
  },
});

cap({
  name: 'list_jurisdiction_events', method: 'GET', path: '/federation/bodies/:id/events', tag: TAG,
  summary: 'Competitions under a body\'s jurisdiction, read live from the canonical events: events in the sports it governs that are run by an organisation affiliated with it (or with a body recognised under it), or that it has been asked to sanction. Public event facts only, with this body\'s sanction state.',
  input: z.object({ id, include_descendants: z.coerce.boolean().default(true), sanctioned: z.enum(['yes', 'no', 'pending']).optional(), from: day.optional(), to: day.optional(), q: text(80).optional(), ...page }),
  async handler({ user }, i) {
    await authority(user, i.id);
    const down = i.include_descendants ? await subtree(i.id) : [i.id];
    const where = `e.sport_id IN (SELECT sport_id FROM governing_body_sports WHERE body_id = ANY($1) AND ended_on IS NULL)
      AND (EXISTS (SELECT 1 FROM fed_affiliations a WHERE a.organisation_id=e.organisation_id AND a.body_id = ANY($1) AND (${AFF_STATUS('a')})='approved') OR EXISTS (SELECT 1 FROM fed_sanctions x WHERE x.event_id=e.id AND x.body_id = ANY($1) AND x.status NOT IN ('withdrawn','rejected','revoked')))
      AND ($2::date IS NULL OR e.ends_on >= $2) AND ($3::date IS NULL OR e.starts_on <= $3) AND ($4::text IS NULL OR e.name ILIKE '%'||$4||'%')
      AND ($5::text IS NULL OR ($5='yes' AND san.status IN ('approved','suspended')) OR ($5='pending' AND san.status IN ('requested','under_review','needs_info')) OR ($5='no' AND (san.id IS NULL OR san.status IN ('rejected','withdrawn','revoked'))))`;
    const from = `events e JOIN sports sp ON sp.id=e.sport_id LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN organisations o ON o.id=e.organisation_id
      LEFT JOIN LATERAL (SELECT x.id, x.status, x.sanction_no FROM fed_sanctions x WHERE x.event_id=e.id AND x.body_id=$6 ORDER BY (x.status IN ('approved','suspended')) DESC, x.created_at DESC LIMIT 1) san ON true`;
    const a = [down, i.from ?? null, i.to ?? null, i.q || null, i.sanctioned ?? null, i.id];
    const total = await one(`SELECT count(*)::int AS n FROM ${from} WHERE ${where}`, a);
    const items = await many(`SELECT e.id, e.name, e.kind, e.status, e.starts_on::text AS starts_on, e.ends_on::text AS ends_on, e.city, sp.name AS sport_name, v.name AS venue_name, o.name AS organiser_organisation, san.id AS sanction_id, san.status AS sanction_status, san.sanction_no
      FROM ${from} WHERE ${where} ORDER BY e.starts_on NULLS LAST, e.id LIMIT $7 OFFSET $8`, [...a, i.limit, i.offset]);
    return { total: total.n, items };
  },
});
