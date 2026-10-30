// Federation governance at scale (#525): delegated administration, maker-checker approvals, policy inheritance, hierarchy rollups with published
// metric definitions, privacy-safe aggregate reporting and periodic access review. Everything extends the Federation OS (#475/#477): same hierarchy,
// roles, policies and immutable history. Nothing here copies federation data; every number is read from the canonical records.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { ROLES, ROLE_LABEL, POLICY_KINDS, authority, need, can, bodyById, lineage, subtree, logFed, historyOf, policyAt, paramsOf, today, AFF_STATUS, LIC_STATUS } from '../federation.js';
import { APPROVAL_ACTIONS, hashOf, ruleFor, rulesFor, checkerAuthority } from '../federation-approvals.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const MIN_CELL = 5;   // person-level counts below this are suppressed, so a small cell (often youth) never identifies anyone

// ------------------------------------------------------------------ delegated administration
cap({
  name: 'grant_federation_delegation', method: 'POST', path: '/federation/bodies/:id/delegations', tag: TAG, status: 201,
  summary: 'Delegate ONE federation role to a person on this body and the bodies recognised beneath it, down to `max_depth` levels (0 = this body only), optionally for one sport and until a date (owner/admin of this body only; a delegate cannot delegate further). It never reaches sibling bodies, the bodies above, or a club\'s private data, is checked live on every call, and is revocable at once.',
  input: z.object({ id, user_id: id, role: z.enum(ROLES), max_depth: z.number().int().min(0).max(8).default(1), sport_id: id.optional(), expires_on: day.optional(), reason: text(500).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins delegate');
    if (auth.body.status === 'archived') throw conflict('This body is archived');
    if (i.user_id === user.id) throw badRequest('You cannot delegate to yourself');
    if (i.expires_on && i.expires_on < today()) throw badRequest('The expiry date is in the past');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [i.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    let d;
    try { d = (await c.query('INSERT INTO fed_delegations(body_id, user_id, role, sport_id, max_depth, expires_on, reason, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.user_id, i.role, i.sport_id ?? null, i.max_depth, i.expires_on ?? null, i.reason, user.id])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('They already hold that delegation here'); throw e; }
    await logFed(c, i.id, 'delegation', d.id, 'granted', { to: 'active', actor: user.id, reason: i.reason, detail: { user_id: i.user_id, role: i.role, max_depth: i.max_depth, sport_id: i.sport_id ?? null, expires_on: i.expires_on ?? null } });
    await notify(c, i.user_id, { kind: 'federation_delegation', title: 'Delegated federation role', body: `You can act as ${ROLE_LABEL[i.role]} for ${auth.body.abbreviation}${i.max_depth ? ` and the bodies beneath it (${i.max_depth} level${i.max_depth > 1 ? 's' : ''})` : ''}.`, data: { body_id: i.id }, dedupe_key: `fed-deleg:${d.id}` });
    await audit(c, user.id, 'grant_federation_delegation', 'fed_delegations', d.id);
    return d;
  }),
});

cap({
  name: 'revoke_federation_delegation', method: 'DELETE', path: '/federation/bodies/:id/delegations/:delegation_id', tag: TAG,
  summary: 'Withdraw a delegation (owner/admin). It stops working at once; the grant and the reason it ended stay in history.',
  input: z.object({ id, delegation_id: id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins revoke delegations');
    const d = (await c.query("UPDATE fed_delegations SET status='revoked', revoked_by=$3, revoked_at=now(), revoke_reason=$4 WHERE id=$1 AND body_id=$2 AND status='active' RETURNING *", [i.delegation_id, i.id, user.id, i.reason ?? null])).rows[0];
    if (!d) throw notFound('Delegation');
    await logFed(c, i.id, 'delegation', d.id, 'revoked', { from: 'active', to: 'revoked', actor: user.id, reason: i.reason, detail: { user_id: d.user_id, role: d.role } });
    await audit(c, user.id, 'revoke_federation_delegation', 'fed_delegations', d.id);
    return d;
  }),
});

cap({
  name: 'list_federation_delegations', method: 'GET', path: '/federation/bodies/:id/delegations', tag: TAG,
  summary: 'Delegations granted on this body: who holds which role, how many levels down, for which sport, until when and why (staff of the body). `mine` lists the delegations you hold anywhere.',
  input: z.object({ id, include_ended: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    return many(
      `SELECT d.id, d.role, d.max_depth, d.sport_id, s.name AS sport_name, d.expires_on::text AS expires_on, d.reason, d.status, d.granted_at, d.revoked_at, d.revoke_reason,
              (d.status='active' AND (d.expires_on IS NULL OR d.expires_on >= current_date)) AS in_force, ${PUBLIC_USER}
         FROM fed_delegations d JOIN users u ON u.id=d.user_id LEFT JOIN sports s ON s.id=d.sport_id
        WHERE d.body_id=$1 AND ($2 OR d.status='active') ORDER BY d.status, d.granted_at DESC, d.id LIMIT $3 OFFSET $4`, [i.id, i.include_ended, i.limit, i.offset]);
  },
});

cap({
  name: 'my_federation_delegations', method: 'GET', path: '/federation/delegations/mine', tag: TAG,
  summary: 'The delegated roles you hold, with the body they were granted on, how far down they reach and when they end.',
  async handler({ user }) {
    return many(
      `SELECT d.id, d.body_id, bo.name AS body_name, d.role, d.max_depth, d.expires_on::text AS expires_on, d.reason FROM fed_delegations d JOIN governing_bodies b ON b.id=d.body_id JOIN organisations bo ON bo.id=b.organisation_id
        WHERE d.user_id=$1 AND d.status='active' AND (d.expires_on IS NULL OR d.expires_on >= current_date) ORDER BY bo.name`, [user.id]);
  },
});

// ------------------------------------------------------------------ maker-checker
const ACTION = z.enum(Object.keys(APPROVAL_ACTIONS));

cap({
  name: 'set_federation_approval_rule', method: 'POST', path: '/federation/bodies/:id/approval-rules', tag: TAG, status: 201,
  summary: 'Require (or stop requiring) a second person\'s approval for a high-impact action on this body (owner/admin). A rule on a body binds every body beneath it: a child can ask for more, never for less. Rules are appended, not edited, so the history of who tightened or relaxed what stays.',
  input: z.object({ id, action: ACTION, required: z.boolean(), reason: text(500).min(5) }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins set approval rules');
    const r = (await c.query('INSERT INTO fed_approval_rules(body_id, action, required, reason, set_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, i.action, i.required, i.reason, user.id])).rows[0];
    await logFed(c, i.id, 'approval_rule', r.id, i.required ? 'required' : 'relaxed', { actor: user.id, reason: i.reason, detail: { action: i.action } });
    await audit(c, user.id, 'set_federation_approval_rule', 'fed_approval_rules', r.id);
    const inForce = await ruleFor(i.id, i.action, c);
    return { ...r, in_force: !!inForce, source_body_id: inForce?.body_id ?? null, inherited: !!inForce && inForce.body_id !== i.id };
  }),
});

cap({
  name: 'get_federation_approval_rules', method: 'GET', path: '/federation/bodies/:id/approval-rules', tag: TAG,
  summary: 'Which actions on this body need a second person, and which body\'s rule requires each (staff of the body).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const rules = await rulesFor(i.id);
    const names = Object.fromEntries((await many('SELECT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id = ANY($1)', [await lineage(i.id)])).map((x) => [x.id, x.name]));
    return Object.entries(APPROVAL_ACTIONS).map(([action, a]) => ({ action, label: a.label, required: !!rules[action], source_body_id: rules[action]?.body_id ?? null, source_name: rules[action] ? names[rules[action].body_id] : null, inherited: !!rules[action] && rules[action].body_id !== i.id, reason: rules[action]?.reason ?? null, since: rules[action]?.set_at ?? null }));
  },
});

/** The exact terms an approval covers, shaped like the request the guarded action will make. */
async function requestShape(c, bodyId, i) {
  const a = APPROVAL_ACTIONS[i.action];
  if (i.action === 'bulk_export') {
    if (!i.report) throw badRequest('Say which report');
    return { subjectId: bodyId, request: { report: i.report, as_of: i.as_of ?? null, season_year: i.season_year ?? null, sport_id: i.sport_id ?? null, include_descendants: i.include_descendants ?? true } };
  }
  if (!i.subject_id) throw badRequest('Say which record the approval is for');
  const table = { affiliation: 'fed_affiliations', licence: 'fed_licences', sanction: 'fed_sanctions', policy: 'fed_policies' }[a.subject];
  const row = (await c.query(`SELECT * FROM ${table} WHERE id=$1`, [i.subject_id])).rows[0];
  if (!row || row.body_id !== bodyId) throw notFound('Record');
  if (i.action === 'policy_publish') {
    if (!i.effective_from) throw badRequest('Give the date the version takes effect');
    const parsed = POLICY_KINDS[row.kind].params.safeParse(i.params ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues.map((x) => `${x.path.join('.') || 'params'}: ${x.message}`).join('; '));
    return { subjectId: row.id, request: { effective_from: i.effective_from, params: parsed.data } };
  }
  if (i.action === 'affiliation_suspend') { if (!i.reason?.trim()) throw badRequest('Give the reason the applicant will be shown'); return { subjectId: row.id, request: { act: 'suspend', reason: i.reason } }; }
  const over = ['eligibility_override', 'credential_exception'].includes(i.action);
  if (over && !i.override_reason) throw badRequest('An override needs the override reason that will be recorded');
  if (!over && i.override_reason) throw badRequest('Use the override action when approving over a failed requirement');
  return { subjectId: row.id, request: { act: 'approve', override: over ? i.override_reason : null } };
}

cap({
  name: 'request_federation_approval', method: 'POST', path: '/federation/bodies/:id/approvals', tag: TAG, status: 201,
  summary: 'Ask a second person to approve a high-impact action (the maker). Give the exact terms (for a decision: the override reason or suspension reason; for a requirement version: its date and parameters; for a file export: the report and filters) and a summary with evidence references. Once a different, entitled person approves, repeat the action with the returned approval id within 7 days. The approval covers exactly these terms and can be used once.',
  input: z.object({ id, action: ACTION, subject_id: id.optional().describe('the affiliation, licence, sanction or policy (not needed for a file export)'),
    summary: text(500).min(5), evidence: z.array(text(300).min(3)).max(10).default([]).describe('record ids or https links; references only'),
    override_reason: text(500).min(5).optional(), reason: text(500).optional(), effective_from: day.optional(), params: z.record(z.string(), z.any()).optional(),
    report: z.enum(['affiliations', 'licences', 'sanctions', 'jurisdiction']).optional(), as_of: day.optional(), season_year: z.number().int().min(1990).max(2200).optional(), sport_id: id.optional(), include_descendants: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    need(auth, APPROVAL_ACTIONS[i.action].perm);
    const rule = await ruleFor(i.id, i.action, c);
    if (!rule) throw conflict('This action does not need a second person\'s approval here');
    if (i.evidence.some((e) => /^[a-z]+:\/\//i.test(e) && !/^https:\/\//i.test(e))) throw badRequest('Evidence links must use https');
    const { subjectId, request } = await requestShape(c, i.id, i);
    const dup = await c.query("SELECT id FROM fed_approvals WHERE body_id=$1 AND action=$2 AND subject_id=$3 AND payload_hash=$4 AND status='pending' AND expires_at > now()", [i.id, i.action, subjectId, hashOf(request)]);
    if (dup.rowCount) throw conflict('That approval has already been asked for and is waiting', { code: 'approval_pending', approval_id: dup.rows[0].id });
    const a = (await c.query(
      `INSERT INTO fed_approvals(body_id, action, subject_type, subject_id, payload_hash, summary, evidence, rule_body_id, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.action, APPROVAL_ACTIONS[i.action].subject, subjectId, hashOf(request), i.summary, i.evidence, rule.body_id, user.id])).rows[0];
    await logFed(c, i.id, 'approval', a.id, 'requested', { to: 'pending', actor: user.id, reason: i.summary, detail: { action: i.action, subject_id: subjectId, rule_body_id: rule.body_id, evidence: i.evidence } });
    await audit(c, user.id, 'request_federation_approval', 'fed_approvals', a.id);
    return a;
  }),
});

const APPROVAL_COLS = `a.id, a.body_id, a.action, a.subject_type, a.subject_id, a.summary, a.evidence, a.rule_body_id, a.status, a.requested_at, a.expires_at, a.decided_at, a.decision_reason, a.authority_source, a.consumed_at,
  CASE WHEN a.status='pending' AND a.expires_at < now() THEN 'expired' ELSE a.status END AS state, (a.consumed_at IS NOT NULL) AS used,
  ru.display_name AS requested_by_name, a.requested_by, du.display_name AS decided_by_name, rb.name AS rule_body_name`;
const APPROVAL_FROM = `fed_approvals a JOIN users ru ON ru.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by
  JOIN (SELECT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id) rb ON rb.id=a.rule_body_id`;

cap({
  name: 'decide_federation_approval', method: 'POST', path: '/federation/approvals/:id/decision', tag: TAG,
  summary: 'Approve or reject a pending request (the checker). You must be entitled to do the action yourself on that body (your own role, a delegation, or a role on a body above) and cannot be the person who asked. The decision is final and kept with who decided, on what authority and why.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM fed_approvals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Approval');
    const src = await checkerAuthority(user, a.body_id, APPROVAL_ACTIONS[a.action].perm, c);
    if (!src) throw notFound('Approval');   // outsiders learn nothing about the request
    if (a.requested_by === user.id) throw forbidden('You cannot decide your own request; a second person must');
    if (a.status !== 'pending') throw conflict(`This request is already ${a.status}`);
    if (new Date(a.expires_at) < new Date()) throw conflict('This request has expired; ask again');
    if (i.decision === 'reject' && !i.reason?.trim()) throw badRequest('Give a reason for rejecting');
    const to = i.decision === 'approve' ? 'approved' : 'rejected';
    const r = (await c.query('UPDATE fed_approvals SET status=$2, decided_by=$3, decided_at=now(), decision_reason=$4, authority_source=$5 WHERE id=$1 RETURNING *', [a.id, to, user.id, i.reason ?? null, src])).rows[0];
    await logFed(c, a.body_id, 'approval', a.id, to, { from: 'pending', to, actor: user.id, reason: i.reason, detail: { action: a.action, authority_source: src, subject_id: a.subject_id } });
    await notify(c, a.requested_by, { kind: `federation_approval_${to}`, title: `Approval ${to}`, body: `${APPROVAL_ACTIONS[a.action].label}: ${to}${i.reason ? ` — ${i.reason}` : ''}.`, data: { approval_id: a.id, body_id: a.body_id }, dedupe_key: `fed-appr:${a.id}:${to}` });
    await audit(c, user.id, `federation_approval_${to}`, 'fed_approvals', a.id);
    return r;
  }),
});

cap({
  name: 'cancel_federation_approval', method: 'POST', path: '/federation/approvals/:id/cancel', tag: TAG,
  summary: 'Withdraw your own pending request.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM fed_approvals WHERE id=$1 AND requested_by=$2 FOR UPDATE', [i.id, user.id])).rows[0];
    if (!a) throw notFound('Approval');
    if (a.status !== 'pending') throw conflict(`This request is already ${a.status}`);
    // cancelling is the requester's own act; the guard allows it because the request is still pending
    const r = (await c.query("UPDATE fed_approvals SET status='cancelled', decided_at=now(), decision_reason='Withdrawn by the requester' WHERE id=$1 RETURNING *", [a.id])).rows[0];
    await logFed(c, a.body_id, 'approval', a.id, 'cancelled', { from: 'pending', to: 'cancelled', actor: user.id });
    return r;
  }),
});

cap({
  name: 'list_federation_approvals', method: 'GET', path: '/federation/bodies/:id/approvals', tag: TAG,
  summary: 'Approval requests for this body and the bodies beneath it. `awaiting_me` shows the ones you could decide (not your own); `mine` the ones you asked for.',
  input: z.object({ id, state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(), awaiting_me: z.coerce.boolean().default(false), mine: z.coerce.boolean().default(false), include_descendants: z.coerce.boolean().default(true), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const rows = await many(
      `SELECT * FROM (SELECT ${APPROVAL_COLS}, ab.name AS body_name FROM ${APPROVAL_FROM} JOIN (SELECT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id) ab ON ab.id=a.body_id
         WHERE a.body_id = ANY($1) AND ($3::uuid IS NULL OR a.requested_by=$3)) x
        WHERE ($2::text IS NULL OR x.state=$2) AND (NOT $4 OR (x.state='pending' AND x.requested_by <> $5))
        ORDER BY x.requested_at DESC, x.id LIMIT $6 OFFSET $7`, [ids, i.state ?? null, i.mine ? user.id : null, i.awaiting_me, user.id, i.limit, i.offset]);
    if (!i.awaiting_me) return rows;
    const ok = [];
    for (const r of rows) if (await checkerAuthority(user, r.body_id, APPROVAL_ACTIONS[r.action].perm)) ok.push(r);
    return ok;
  },
});

cap({
  name: 'get_federation_approval', method: 'GET', path: '/federation/approvals/:id', tag: TAG,
  summary: 'One approval request with its full trail: who asked, why, the evidence references, who decided on what authority, and whether it was used.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one(`SELECT ${APPROVAL_COLS} FROM ${APPROVAL_FROM} WHERE a.id=$1`, [i.id]);
    if (!a) throw notFound('Approval');
    const auth = await authority(user, a.body_id, { optional: true });
    if (!(auth && can(auth, 'reports')) && a.requested_by !== user.id) throw notFound('Approval');
    return { ...a, label: APPROVAL_ACTIONS[a.action].label, history: await historyOf('approval', i.id) };
  },
});

// ------------------------------------------------------------------ policy inheritance
cap({
  name: 'get_policy_inheritance', method: 'GET', path: '/federation/bodies/:id/policy-inheritance', tag: TAG, auth: 'public',
  summary: 'How a requirement reaches a body: every body from the top of the hierarchy down that publishes one of this kind, with its version in force, whether it is locked against local override, and which one actually applies here and why (public).',
  input: z.object({ id, kind: z.enum(Object.keys(POLICY_KINDS)), sport_id: id.optional(), category: text(60).default(''), season_year: z.coerce.number().int().min(1990).max(2200).optional(), on: day.optional() }),
  async handler(_ctx, i) {
    await bodyById(i.id);
    const on = i.on ?? today();
    const chain = await lineage(i.id);
    const effective = await policyAt(i.id, i.kind, { sportId: i.sport_id ?? null, category: i.category, seasonYear: i.season_year ?? null, date: on });
    const rows = await many(
      `SELECT p.id AS policy_id, p.body_id, bo.name AS body_name, p.title, p.local_override, p.sport_id, p.category, p.season_year,
              v.id AS version_id, v.version, v.effective_from::text AS effective_from, v.summary
         FROM fed_policies p JOIN governing_bodies b ON b.id=p.body_id JOIN organisations bo ON bo.id=b.organisation_id
         LEFT JOIN LATERAL (SELECT * FROM fed_policy_versions x WHERE x.policy_id=p.id AND x.effective_from <= $3::date ORDER BY x.effective_from DESC LIMIT 1) v ON true
        WHERE p.body_id = ANY($1) AND p.kind=$2 AND p.status='active' AND (p.sport_id IS NULL OR p.sport_id=$4::uuid OR $4::uuid IS NULL)`, [chain, i.kind, on, i.sport_id ?? null]);
    const levels = rows.map((r) => ({ ...r, locked: r.local_override === 'locked', distance: chain.indexOf(r.body_id), applies: r.policy_id === effective?.policy_id,
      why: r.policy_id === effective?.policy_id ? (r.local_override === 'locked' && r.body_id !== i.id ? 'Locked by a body above: nothing beneath it may override this requirement' : r.body_id === i.id ? 'This body\'s own requirement' : 'Inherited: nobody nearer publishes one')
        : (effective?.local_override === 'locked' ? 'Overridden by a locked requirement above' : 'Overridden by a more specific or nearer requirement') }))
      .sort((a, b) => b.distance - a.distance);
    return { kind: i.kind, on, effective: effective ? { policy_id: effective.policy_id, version_id: effective.version_id, version: effective.version, source_body_id: effective.body_id, inherited: effective.inherited, locked: effective.local_override === 'locked', params: paramsOf(i.kind, effective) } : null, levels };
  },
});

// ------------------------------------------------------------------ hierarchy rollup, with the definition of every number
export const METRICS = {
  affiliations_in_force: { label: 'Affiliations in force', unit: 'organisations', person_level: false, definition: 'Affiliation applications with status approved whose effective_to is today or later. Suspended and expired affiliations are not counted.' },
  affiliations_suspended: { label: 'Affiliations suspended', unit: 'organisations', person_level: false, definition: 'Affiliations currently suspended and not past their end date.' },
  affiliations_expiring: { label: 'Affiliations expiring in 60 days', unit: 'organisations', person_level: false, definition: 'Affiliations in force whose effective_to falls within the next 60 days.' },
  organisations: { label: 'Affiliated organisations', unit: 'organisations', person_level: false, definition: 'Distinct organisations holding at least one affiliation in force.' },
  licences_good_standing: { label: 'Licences in good standing', unit: 'licences', person_level: true, definition: 'Licences with status active and an expiry of today or later. Counts below 5 are suppressed.' },
  licences_suspended: { label: 'Licences suspended', unit: 'licences', person_level: true, definition: 'Licences currently suspended and not past their expiry. Counts below 5 are suppressed.' },
  licences_expiring: { label: 'Licences expiring in 60 days', unit: 'licences', person_level: true, definition: 'Licences in good standing that expire within the next 60 days. Counts below 5 are suppressed.' },
  athletes: { label: 'Licensed athletes', unit: 'people', person_level: true, definition: 'Distinct people holding an athlete licence in good standing. Counts below 5 are suppressed; no age, health or identity detail is shown.' },
  credential_health_pct: { label: 'Credential health', unit: 'percent', person_level: true, definition: 'Licences in good standing and not expiring within 60 days, as a share of all licences that are active, suspended or expired in the last 12 months. Suppressed with the counts it is built from.' },
  sanctions_in_force: { label: 'Competitions sanctioned', unit: 'sanctions', person_level: false, definition: 'Sanctions with status approved and an approved end date of today or later.' },
  awaiting_decision: { label: 'Applications awaiting a decision', unit: 'applications', person_level: false, definition: 'Affiliation, licence and sanction applications that are submitted, under review or waiting for information from the applicant.' },
  exceptions: { label: 'Approved over a failed requirement', unit: 'decisions', person_level: false, definition: 'Affiliations, licences and sanctions in force that were approved with a recorded override reason.' },
};

cap({
  name: 'list_federation_metric_definitions', method: 'GET', path: '/federation/metric-definitions', tag: TAG, auth: 'public',
  summary: 'The published definition of every number on the federation dashboards and reports, the unit, and whether it counts people (and is therefore suppressed in small cells).',
  handler: () => Object.entries(METRICS).map(([key, m]) => ({ key, ...m, min_cell: m.person_level ? MIN_CELL : null })),
});

async function rollup(focal, { sportId = null, seasonYear = null } = {}) {
  // `own` = the focal body alone; every direct child stands for itself and everything beneath it.
  const groups = `WITH RECURSIVE kids(root, id, depth) AS (
      SELECT l.child_id, l.child_id, 0 FROM governing_body_links l WHERE l.parent_id=$1 AND l.status='recognised'
      UNION ALL SELECT k.root, l.child_id, k.depth + 1 FROM governing_body_links l JOIN kids k ON l.parent_id=k.id WHERE l.status='recognised' AND k.depth < 12),
    grp(root, id) AS (SELECT $1::uuid, $1::uuid UNION ALL SELECT root, id FROM kids)`;
  const [aff, lic, san, pend, nodes] = await Promise.all([
    many(`${groups} SELECT g.root, count(*) FILTER (WHERE a.status='approved' AND a.effective_to >= current_date)::int AS in_force, count(*) FILTER (WHERE a.status='suspended' AND a.effective_to >= current_date)::int AS suspended,
            count(*) FILTER (WHERE a.status='approved' AND a.effective_to BETWEEN current_date AND current_date + 60)::int AS expiring, count(DISTINCT a.organisation_id) FILTER (WHERE a.status='approved' AND a.effective_to >= current_date)::int AS organisations,
            count(*) FILTER (WHERE a.status='approved' AND a.effective_to >= current_date AND a.override_reason IS NOT NULL)::int AS exceptions
          FROM grp g JOIN fed_affiliations a ON a.body_id=g.id JOIN fed_affiliation_categories c ON c.id=a.category_id
         WHERE ($2::uuid IS NULL OR c.sport_id=$2) AND ($3::int IS NULL OR a.season_year=$3) GROUP BY g.root`, [focal, sportId, seasonYear]),
    many(`${groups} SELECT g.root, count(*) FILTER (WHERE l.status='active' AND l.expires_on >= current_date)::int AS good, count(*) FILTER (WHERE l.status='suspended' AND l.expires_on >= current_date)::int AS suspended,
            count(*) FILTER (WHERE l.status='active' AND l.expires_on BETWEEN current_date AND current_date + 60)::int AS expiring,
            count(*) FILTER (WHERE l.status IN ('active','suspended') AND l.expires_on < current_date AND l.expires_on >= current_date - 365)::int AS lapsed,
            count(DISTINCT l.holder_id) FILTER (WHERE l.status='active' AND l.expires_on >= current_date AND t.holder_role='athlete')::int AS athletes,
            count(*) FILTER (WHERE l.status='active' AND l.expires_on >= current_date AND l.override_reason IS NOT NULL)::int AS exceptions
          FROM grp g JOIN fed_licences l ON l.body_id=g.id JOIN fed_licence_types t ON t.id=l.type_id
         WHERE ($2::uuid IS NULL OR t.sport_id=$2) AND ($3::int IS NULL OR extract(year FROM l.issued_on)=$3) GROUP BY g.root`, [focal, sportId, seasonYear]),
    many(`${groups} SELECT g.root, count(*) FILTER (WHERE s.status='approved' AND s.approved_ends_on >= current_date)::int AS in_force, count(*) FILTER (WHERE s.status='approved' AND s.approved_ends_on >= current_date AND s.override_reason IS NOT NULL)::int AS exceptions
          FROM grp g JOIN fed_sanctions s ON s.body_id=g.id JOIN events e ON e.id=s.event_id WHERE ($2::uuid IS NULL OR e.sport_id=$2) AND ($3::int IS NULL OR extract(year FROM s.approved_starts_on)=$3) GROUP BY g.root`, [focal, sportId, seasonYear]),
    many(`${groups} SELECT g.root, sum(n)::int AS n FROM grp g JOIN (
            SELECT body_id, count(*) AS n FROM fed_affiliations WHERE status IN ('submitted','under_review','needs_info') GROUP BY body_id
            UNION ALL SELECT body_id, count(*) FROM fed_licences WHERE status IN ('submitted','under_review','needs_info') GROUP BY body_id
            UNION ALL SELECT body_id, count(*) FROM fed_sanctions WHERE status IN ('requested','under_review','needs_info') GROUP BY body_id) x ON x.body_id=g.id GROUP BY g.root`, [focal]),
    many(`${groups} SELECT g.root, count(*)::int AS bodies FROM grp g GROUP BY g.root`, [focal]),
  ]);
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.root, r]));
  const A = by(aff), L = by(lic), S = by(san), P = by(pend), N = by(nodes);
  const heads = await many('SELECT b.id AS body_id, o.name, b.level, b.abbreviation, b.state, b.region, b.district FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id = ANY($1)', [Object.keys(N)]);
  const rows = heads.map((h) => {
    const a = A[h.body_id] ?? {}, l = L[h.body_id] ?? {}, s = S[h.body_id] ?? {};
    const denom = (l.good ?? 0) + (l.suspended ?? 0) + (l.lapsed ?? 0);
    return { ...h, scope: h.body_id === focal ? 'this body only' : 'this body and everything beneath it', bodies: N[h.body_id]?.bodies ?? 1, own: h.body_id === focal,
      affiliations_in_force: a.in_force ?? 0, affiliations_suspended: a.suspended ?? 0, affiliations_expiring: a.expiring ?? 0, organisations: a.organisations ?? 0,
      licences_good_standing: l.good ?? 0, licences_suspended: l.suspended ?? 0, licences_expiring: l.expiring ?? 0, athletes: l.athletes ?? 0,
      credential_health_pct: denom ? Math.round((((l.good ?? 0) - (l.expiring ?? 0)) / denom) * 100) : null,
      sanctions_in_force: s.in_force ?? 0, awaiting_decision: P[h.body_id]?.n ?? 0, exceptions: (a.exceptions ?? 0) + (l.exceptions ?? 0) + (s.exceptions ?? 0) };
  }).sort((x, y) => (y.own - x.own) || x.name.localeCompare(y.name));
  return suppress(rows);
}

/** Primary suppression of person-level cells below MIN_CELL, plus complementary suppression so a single hidden cell cannot be recovered from the others. */
export function suppress(rows) {
  const keys = Object.entries(METRICS).filter(([, m]) => m.person_level).map(([k]) => k);
  const out = rows.map((r) => ({ ...r, suppressed: [] }));
  for (const k of keys.filter((x) => x !== 'credential_health_pct')) {
    const kids = out.filter((r) => !r.own);
    for (const r of out) if (typeof r[k] === 'number' && r[k] > 0 && r[k] < MIN_CELL) r.suppressed.push(k);
    const hidden = kids.filter((r) => r.suppressed.includes(k));
    if (hidden.length === 1) { const next = kids.filter((r) => !r.suppressed.includes(k) && typeof r[k] === 'number').sort((a, b) => a[k] - b[k])[0]; if (next) next.suppressed.push(k); }
  }
  for (const r of out) {
    if (r.suppressed.some((k) => ['licences_good_standing', 'licences_suspended', 'licences_expiring'].includes(k))) r.suppressed.push('credential_health_pct');
    for (const k of new Set(r.suppressed)) r[k] = null;
    r.suppressed = [...new Set(r.suppressed)];
  }
  return out;
}

cap({
  name: 'get_federation_rollup', method: 'GET', path: '/federation/bodies/:id/rollup', tag: TAG,
  summary: 'The affiliation dashboard across the hierarchy: this body and each body recognised directly beneath it (with everything under that one), showing affiliations, organisations, licence and credential health, expiries, sanctions, applications awaiting a decision and approvals over a failed requirement. Counts of people below 5 are suppressed. Every number is defined in `list_federation_metric_definitions` and drills into the records with `list_federation_rollup_records`.',
  input: z.object({ id, sport_id: id.optional(), season_year: z.coerce.number().int().min(1990).max(2200).optional() }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports', i.sport_id ?? null);
    const rows = await rollup(i.id, { sportId: i.sport_id ?? null, seasonYear: i.season_year ?? null });
    await audit(null, user.id, 'view_federation_rollup', 'governing_bodies', i.id);
    return { body: { id: auth.body.id, name: auth.body.name, level: auth.body.level }, as_of: today(), min_cell: MIN_CELL, definitions: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, { label: m.label, unit: m.unit, definition: m.definition }])), rows };
  },
});

const DRILL = {
  affiliations_in_force: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status='approved' AND a.effective_to >= current_date", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, a.effective_to::text AS ends_on, a.body_id", order: 'o.name' },
  affiliations_suspended: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status='suspended' AND a.effective_to >= current_date", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, a.effective_to::text AS ends_on, a.body_id", order: 'o.name' },
  affiliations_expiring: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status='approved' AND a.effective_to BETWEEN current_date AND current_date + 60", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, a.effective_to::text AS ends_on, a.body_id", order: 'a.effective_to, o.name' },
  organisations: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status='approved' AND a.effective_to >= current_date", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, a.effective_to::text AS ends_on, a.body_id", order: 'o.name' },
  sanctions_in_force: { alias: 's', from: "fed_sanctions s JOIN events e ON e.id=s.event_id", where: "s.status='approved' AND s.approved_ends_on >= current_date", sport: 'e.sport_id', year: 'extract(year FROM s.approved_starts_on)', cols: "s.id AS record_id, 'sanction' AS type, e.name AS label, s.sanction_no AS number, s.status, s.approved_ends_on::text AS ends_on, s.body_id", order: 'e.name' },
  exceptions: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status='approved' AND a.effective_to >= current_date AND a.override_reason IS NOT NULL", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, a.effective_to::text AS ends_on, a.body_id", order: 'o.name' },
  awaiting_decision: { alias: 'a', from: "fed_affiliations a JOIN organisations o ON o.id=a.organisation_id JOIN fed_affiliation_categories c ON c.id=a.category_id", where: "a.status IN ('submitted','under_review','needs_info')", sport: 'c.sport_id', year: 'a.season_year', cols: "a.id AS record_id, 'affiliation' AS type, o.name AS label, a.affiliation_no AS number, a.status, NULL::text AS ends_on, a.body_id", order: 'a.submitted_at NULLS LAST' },
};

cap({
  name: 'list_federation_rollup_records', method: 'GET', path: '/federation/bodies/:id/rollup/records', tag: TAG,
  summary: 'Drill from an organisation-level dashboard number into the records behind it (reporting roles). Person-level numbers (licences, athletes) are not drillable here; the licences report lists them for the roles that may see them, with youth holders withheld.',
  input: z.object({ id, metric: z.enum(Object.keys(DRILL)), node_id: id.optional().describe('a body in this body\'s hierarchy; omit for this body and everything beneath it'), sport_id: id.optional(), season_year: z.coerce.number().int().min(1990).max(2200).optional(), ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports', i.sport_id ?? null);
    const all = await subtree(i.id);
    if (i.node_id && !all.includes(i.node_id)) throw notFound('Body');
    const ids = i.node_id ? await subtree(i.node_id) : all;
    const d = DRILL[i.metric];
    const rows = await many(
      `SELECT ${d.cols}, bo.name AS body_name FROM ${d.from} JOIN governing_bodies b ON b.id=${d.alias}.body_id JOIN organisations bo ON bo.id=b.organisation_id
        WHERE ${d.alias}.body_id = ANY($1) AND ${d.where} AND ($2::uuid IS NULL OR ${d.sport} = $2) AND ($3::int IS NULL OR ${d.year} = $3) ORDER BY ${d.order}, 1 LIMIT $4 OFFSET $5`, [ids, i.sport_id ?? null, i.season_year ?? null, i.limit, i.offset]);
    const total = (await one(`SELECT count(*)::int AS n FROM ${d.from} WHERE ${d.alias}.body_id = ANY($1) AND ${d.where} AND ($2::uuid IS NULL OR ${d.sport} = $2) AND ($3::int IS NULL OR ${d.year} = $3)`, [ids, i.sport_id ?? null, i.season_year ?? null])).n;
    return { metric: i.metric, definition: METRICS[i.metric].definition, total, rows };
  },
});

// ------------------------------------------------------------------ configurable aggregate reporting (no individual rows, small cells suppressed)
const MEASURES = {
  affiliations: { from: "fed_affiliations a JOIN fed_affiliation_categories c ON c.id=a.category_id JOIN governing_bodies b ON b.id=a.body_id", body: 'a.body_id', sport: 'c.sport_id', year: 'a.season_year',
    state: { in_force: "a.status='approved' AND a.effective_to >= current_date", suspended: "a.status='suspended' AND a.effective_to >= current_date", expiring: "a.status='approved' AND a.effective_to BETWEEN current_date AND current_date + 60", expired: "a.status IN ('approved','suspended') AND a.effective_to < current_date" }, unit: 'organisations', person: false, count: 'count(*)' },
  licences: { from: "fed_licences l JOIN fed_licence_types t ON t.id=l.type_id JOIN governing_bodies b ON b.id=l.body_id", body: 'l.body_id', sport: 't.sport_id', year: 'extract(year FROM l.issued_on)',
    state: { in_force: "l.status='active' AND l.expires_on >= current_date", suspended: "l.status='suspended' AND l.expires_on >= current_date", expiring: "l.status='active' AND l.expires_on BETWEEN current_date AND current_date + 60", expired: "l.status IN ('active','suspended') AND l.expires_on < current_date" }, unit: 'licences', person: true, count: 'count(*)' },
  sanctions: { from: "fed_sanctions s JOIN events e ON e.id=s.event_id JOIN governing_bodies b ON b.id=s.body_id", body: 's.body_id', sport: 'e.sport_id', year: 'extract(year FROM s.approved_starts_on)', event: 's.event_id',
    state: { in_force: "s.status='approved' AND s.approved_ends_on >= current_date", suspended: "s.status='suspended' AND s.approved_ends_on >= current_date", expiring: "s.status='approved' AND s.approved_ends_on BETWEEN current_date AND current_date + 60", expired: "s.status IN ('approved','suspended') AND s.approved_ends_on < current_date" }, unit: 'sanctions', person: false, count: 'count(*)' },
};
const GROUPS = { level: 'b.level', country: 'b.country', region: 'b.region', state: 'b.state', district: 'b.district' };

cap({
  name: 'get_federation_aggregate', method: 'GET', path: '/federation/bodies/:id/aggregate', tag: TAG,
  summary: 'A configurable aggregate across the hierarchy: count affiliations, licences or sanctions, grouped by body level, geography (country, region, state, district), sport, season or standing, and filtered by sport, season, body level, geography, competition (sanctions) and credential state (in force, suspended, expiring, expired). Only totals are returned; person-level cells below 5 are suppressed and no age, health or identity data is ever included.',
  input: z.object({ id, measure: z.enum(Object.keys(MEASURES)), group_by: z.enum(['level', 'country', 'region', 'state', 'district', 'sport', 'season', 'status']).default('level'), credential_state: z.enum(['in_force', 'suspended', 'expiring', 'expired']).optional(),
    sport_id: id.optional(), season_year: z.coerce.number().int().min(1990).max(2200).optional(), level: z.string().max(30).optional(), country: z.string().length(2).optional(), state: text(80).optional(), region: text(80).optional(), district: text(80).optional(), event_id: id.optional(), include_descendants: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    need(auth, 'reports', i.sport_id ?? null);
    const m = MEASURES[i.measure];
    if (i.event_id && !m.event) throw badRequest('Competition is a filter for sanctions only');
    const ids = i.include_descendants ? await subtree(i.id) : [i.id];
    const stateSql = i.credential_state ? m.state[i.credential_state] : 'true';
    const groupSql = i.group_by === 'status' ? `CASE ${Object.entries(m.state).map(([k, w]) => `WHEN ${w} THEN '${k}'`).join(' ')} ELSE 'other' END` : i.group_by === 'season' ? `(${m.year})::text` : i.group_by === 'sport' ? 'sp.name' : GROUPS[i.group_by];
    const rows = await many(
      `SELECT coalesce(${groupSql}, 'unspecified') AS key, ${m.count}::int AS n
         FROM ${m.from} ${i.group_by === 'sport' ? `LEFT JOIN sports sp ON sp.id=${m.sport}` : ''}
        WHERE ${m.body} = ANY($1) AND ${stateSql} AND ($2::uuid IS NULL OR ${m.sport}=$2) AND ($3::int IS NULL OR ${m.year}=$3) AND ($4::text IS NULL OR b.level=$4) AND ($5::text IS NULL OR b.country=$5)
          AND ($6::text IS NULL OR b.state=$6) AND ($7::text IS NULL OR b.region=$7) AND ($8::text IS NULL OR b.district=$8) ${m.event ? 'AND ($9::uuid IS NULL OR ' + m.event + '=$9)' : 'AND $9::uuid IS NULL'} GROUP BY 1 ORDER BY 1`,
      [ids, i.sport_id ?? null, i.season_year ?? null, i.level ?? null, i.country ?? null, i.state ?? null, i.region ?? null, i.district ?? null, i.event_id ?? null]);
    // Youth are only ever counted inside these totals, never separated out. Person-level cells under the floor are hidden, and a lone hidden cell takes its smallest neighbour with it.
    let out = rows.map((r) => ({ key: r.key, count: r.n }));
    let suppressed = 0;
    if (m.person) {
      out = out.map((r) => (r.count < MIN_CELL ? (suppressed++, { key: r.key, count: null, suppressed: true }) : r));
      if (suppressed === 1 && out.length > 1) { const next = out.filter((r) => !r.suppressed).sort((a, b) => a.count - b.count)[0]; next.count = null; next.suppressed = true; suppressed++; }
    }
    await audit(null, user.id, 'view_federation_aggregate', 'governing_bodies', i.id);
    return { measure: i.measure, unit: m.unit, group_by: i.group_by, filters: { credential_state: i.credential_state ?? null, sport_id: i.sport_id ?? null, season_year: i.season_year ?? null, level: i.level ?? null, country: i.country ?? null, state: i.state ?? null, region: i.region ?? null, district: i.district ?? null, event_id: i.event_id ?? null },
      as_of: today(), bodies: ids.length, min_cell: m.person ? MIN_CELL : null, suppressed_cells: suppressed,
      total: out.every((r) => r.count != null) ? out.reduce((s, r) => s + r.count, 0) : null, rows: out };
  },
});

// ------------------------------------------------------------------ access review
const STALE_DAYS = 90;

async function accessSnapshot(rootId, ids) {
  const stale = `(SELECT max(s.last_seen_at) FROM auth_sessions s WHERE s.user_id=u.id)`;
  const [admins, roles, deleg, tokens, sso, recent, flagged] = await Promise.all([
    many(`SELECT m.id AS ref_id, m.organisation_id, b.id AS body_id, m.role, m.source, ${PUBLIC_USER}, ${stale} AS last_seen_at, (m.provisioned_connection_id IS NOT NULL) AS provisioned
            FROM organisation_members m JOIN governing_bodies b ON b.organisation_id=m.organisation_id JOIN users u ON u.id=m.user_id
           WHERE b.id = ANY($1) AND m.status='active' AND m.role IN ('owner','admin') ORDER BY b.id, u.display_name`, [ids]),
    many(`SELECT r.id AS ref_id, r.body_id, r.role, r.sport_id, r.granted_at, ${PUBLIC_USER}, ${stale} AS last_seen_at FROM governing_body_roles r JOIN users u ON u.id=r.user_id WHERE r.body_id = ANY($1) AND r.status='active' ORDER BY r.body_id, u.display_name`, [ids]),
    many(`SELECT d.id AS ref_id, d.body_id, d.role, d.max_depth, d.expires_on::text AS expires_on, d.reason, d.granted_at, ${PUBLIC_USER}, ${stale} AS last_seen_at, (d.expires_on IS NOT NULL AND d.expires_on < current_date) AS lapsed
            FROM fed_delegations d JOIN users u ON u.id=d.user_id WHERE d.body_id = ANY($1) AND d.status='active' ORDER BY d.body_id, u.display_name`, [ids]),
    many(`SELECT t.user_id, count(*)::int AS tokens, max(t.last_used_at) AS last_used_at, bool_or('full' = ANY(t.scopes) OR 'admin' = ANY(t.scopes)) AS broad, bool_or(t.expires_at IS NULL) AS never_expires
            FROM api_tokens t WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND t.user_id IN (
              SELECT m.user_id FROM organisation_members m JOIN governing_bodies b ON b.organisation_id=m.organisation_id WHERE b.id = ANY($1) AND m.status='active' AND m.role IN ('owner','admin')
              UNION SELECT user_id FROM governing_body_roles WHERE body_id = ANY($1) AND status='active' UNION SELECT user_id FROM fed_delegations WHERE body_id = ANY($1) AND status='active') GROUP BY t.user_id`, [ids]),
    many(`SELECT b.id AS body_id, c.id AS connection_id, c.protocol, c.status, c.local_login, (c.status='active') AS active,
                 (SELECT count(*)::int FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.status='active' AND m.source='scim') AS scim_members,
                 (SELECT count(*)::int FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.status='active' AND m.source='sso') AS sso_members,
                 (SELECT count(*)::int FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.status='active' AND m.source='manual' AND m.role IN ('owner','admin')) AS manual_admins
            FROM governing_bodies b LEFT JOIN org_sso_connections c ON c.organisation_id=b.organisation_id AND c.status <> 'disabled' WHERE b.id = ANY($1)`, [ids]),
    many(`SELECT e.body_id, e.actor_id, u.display_name AS actor_name, e.subject_type, e.action, e.created_at FROM fed_events e LEFT JOIN users u ON u.id=e.actor_id
           WHERE e.body_id = ANY($1) AND e.created_at > now() - interval '30 days' AND e.action IN ('approve','suspend','revoke','reinstate','granted','revoked','approved','rejected','used','required','relaxed','reinstated')
           ORDER BY e.created_at DESC LIMIT 40`, [ids]),
    many(`SELECT ri.kind, ri.ref_id, ri.body_id, ri.user_id, ri.reason, r.created_at FROM fed_access_review_items ri JOIN fed_access_reviews r ON r.id=ri.review_id
           WHERE ri.body_id = ANY($1) AND ri.decision='flag' AND ri.kind='org_admin' AND EXISTS (SELECT 1 FROM organisation_members m WHERE m.id=ri.ref_id AND m.status='active') ORDER BY r.created_at DESC`, [ids]),
  ]);
  const isStale = (r) => !r.last_seen_at || (Date.now() - new Date(r.last_seen_at).getTime()) / 864e5 > STALE_DAYS;
  const tok = Object.fromEntries(tokens.map((t) => [t.user_id, t]));
  const withFlags = (rows, kind) => rows.map((r) => ({ ...r, kind, stale: isStale(r), service: tok[r.id] ? { tokens: tok[r.id].tokens, last_used_at: tok[r.id].last_used_at, broad: tok[r.id].broad, never_expires: tok[r.id].never_expires } : null }));
  return { admins: withFlags(admins, 'org_admin'), roles: withFlags(roles, 'role'), delegations: withFlags(deleg, 'delegation'), identity: sso, recent_sensitive: recent, pending_revocations: flagged, stale_days: STALE_DAYS };
}

cap({
  name: 'get_federation_access_review', method: 'GET', path: '/federation/bodies/:id/access-review', tag: TAG,
  summary: 'The access review for this body and every body beneath it: organisation owners/admins, scoped roles, delegations (with expiry), accounts not seen for 90 days, API tokens held by those people (service identities, flagging broad or never-expiring ones), single sign-on and SCIM-managed membership per body, sensitive actions in the last 30 days and revocations still pending from earlier reviews (owner/admin of the body or an auditor).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    if (!auth.admin && !auth.roles.some((r) => r.role === 'auditor')) throw forbidden('Access reviews are for the body\'s owners, admins and auditors');
    const ids = await subtree(i.id);
    const names = Object.fromEntries((await many('SELECT b.id, o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id = ANY($1)', [ids])).map((x) => [x.id, x.name]));
    const snap = await accessSnapshot(i.id, ids);
    const named = (r) => ({ ...r, body_name: names[r.body_id] });
    await audit(null, user.id, 'view_federation_access_review', 'governing_bodies', i.id);
    const last = await one('SELECT r.id, r.created_at, r.kept, r.revoked, r.flagged, u.display_name AS reviewer_name FROM fed_access_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.body_id=$1 ORDER BY r.created_at DESC LIMIT 1', [i.id]);
    const flat = [...snap.admins, ...snap.roles, ...snap.delegations];
    return { body_id: i.id, bodies: ids.length, generated_at: new Date().toISOString(), last_review: last,
      summary: { admins: snap.admins.length, roles: snap.roles.length, delegations: snap.delegations.length, stale: flat.filter((r) => r.stale).length, lapsed_delegations: snap.delegations.filter((d) => d.lapsed).length, service_identities: new Set(flat.filter((r) => r.service).map((r) => r.id)).size, broad_tokens: flat.filter((r) => r.service?.broad).length, pending_revocations: snap.pending_revocations.length },
      admins: snap.admins.map(named), roles: snap.roles.map(named), delegations: snap.delegations.map(named), identity: snap.identity.map(named), recent_sensitive: snap.recent_sensitive.map(named), pending_revocations: snap.pending_revocations.map(named), stale_days: STALE_DAYS };
  },
});

cap({
  name: 'record_federation_access_review', method: 'POST', path: '/federation/bodies/:id/access-reviews', tag: TAG, status: 201,
  summary: 'Certify an access review (owner/admin). For each scoped role or delegation reviewed say keep or revoke (revoking takes effect now and keeps history); for an organisation owner/admin say keep or flag (a flag stays visible as a pending revocation until the organisation removes them). Anything in scope you do not mention is recorded as kept, so the certification always covers the whole snapshot.',
  input: z.object({ id, decisions: z.array(z.object({ kind: z.enum(['role', 'delegation', 'org_admin']), ref_id: id, decision: z.enum(['keep', 'revoke', 'flag']), reason: text(500).optional() })).max(500).default([]), note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins certify an access review');
    const ids = await subtree(i.id);
    const snap = await accessSnapshot(i.id, ids);
    const index = new Map([...snap.admins, ...snap.roles, ...snap.delegations].map((r) => [`${r.kind}:${r.ref_id}`, r]));
    const given = new Map();
    for (const d of i.decisions) {
      const r = index.get(`${d.kind}:${d.ref_id}`);
      if (!r) throw badRequest(`${d.kind} ${d.ref_id} is not part of this review`);
      if (d.decision === 'revoke' && d.kind === 'org_admin') throw badRequest('An organisation\'s own admins are removed by that organisation; flag them instead');
      if (d.decision === 'flag' && d.kind !== 'org_admin') throw badRequest('Flag applies to organisation owners and admins; revoke roles and delegations');
      if (d.decision !== 'keep' && !d.reason?.trim()) throw badRequest('Give a reason for every revoke or flag');
      given.set(`${d.kind}:${d.ref_id}`, d);
    }
    const rev = (await c.query('INSERT INTO fed_access_reviews(body_id, reviewer_id, scope_note, nodes) VALUES ($1,$2,$3,$4) RETURNING *', [i.id, user.id, i.note ?? null, ids.length])).rows[0];
    let kept = 0, revoked = 0, flagged = 0;
    for (const [key, r] of index) {
      const d = given.get(key) ?? { kind: r.kind, ref_id: r.ref_id, decision: 'keep' };
      await c.query('INSERT INTO fed_access_review_items(review_id, body_id, kind, ref_id, user_id, decision, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)', [rev.id, r.body_id, d.kind, d.ref_id, r.id, d.decision, d.reason ?? null]);
      if (d.decision === 'keep') kept++;
      else if (d.decision === 'flag') flagged++;
      else {
        revoked++;
        if (d.kind === 'role') await c.query("UPDATE governing_body_roles SET status='revoked', revoked_by=$2, revoked_at=now() WHERE id=$1 AND status='active'", [d.ref_id, user.id]);
        else await c.query("UPDATE fed_delegations SET status='revoked', revoked_by=$2, revoked_at=now(), revoke_reason=$3 WHERE id=$1 AND status='active'", [d.ref_id, user.id, d.reason]);
        await logFed(c, r.body_id, d.kind === 'role' ? 'role' : 'delegation', d.ref_id, 'revoked_in_review', { from: 'active', to: 'revoked', actor: user.id, reason: d.reason, detail: { review_id: rev.id, user_id: r.id } });
      }
    }
    await c.query('UPDATE fed_access_reviews SET kept=$2, revoked=$3, flagged=$4 WHERE id=$1', [rev.id, kept, revoked, flagged]);
    await logFed(c, i.id, 'access_review', rev.id, 'certified', { actor: user.id, reason: i.note, detail: { nodes: ids.length, kept, revoked, flagged } });
    await audit(c, user.id, 'record_federation_access_review', 'fed_access_reviews', rev.id);
    return { ...rev, kept, revoked, flagged };
  }),
});

cap({
  name: 'list_federation_access_reviews', method: 'GET', path: '/federation/bodies/:id/access-reviews', tag: TAG,
  summary: 'Past certified access reviews of this body: who certified, when, how many grants were kept, revoked or flagged (owner/admin or auditor).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const auth = await authority(user, i.id);
    if (!auth.admin && !auth.roles.some((r) => r.role === 'auditor')) throw forbidden('Access reviews are for the body\'s owners, admins and auditors');
    return many('SELECT r.id, r.nodes, r.kept, r.revoked, r.flagged, r.scope_note, r.created_at, u.display_name AS reviewer_name FROM fed_access_reviews r JOIN users u ON u.id=r.reviewer_id WHERE r.body_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3', [i.id, i.limit, i.offset]);
  },
});
