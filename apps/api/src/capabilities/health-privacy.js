// Country health-privacy centre for patients (docs/health-compliance.md): which country's rules apply to my health data, the notice I
// accepted, my rights (access, correction, restriction, accounting of disclosures…) with the country's response time, a complete copy of my data,
// and a plain list of who opened or wrote to it. Opt-in: a person who never chooses a country is handled exactly as before.
import { z } from 'zod';
import { cap, capabilities, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { REGIMES, REGIME_CODES, REGIME_NOTICE_VERSION, REQUEST_KINDS, regimeView, DISCLAIMER } from '../health/regimes.js';
import { getPrivacyProfile, hostedIn } from '../health/privacy.js';

const TAG = 'Health';
const regimeCode = z.string().trim().toUpperCase().refine((v) => REGIME_CODES.includes(v), { message: `Choose one of: ${REGIME_CODES.join(', ')}` });
const kindEnum = z.enum(Object.keys(REQUEST_KINDS));

const summary = (r) => ({ code: r.code, name: r.name, flag: r.flag, localisation: r.localisation, laws: r.laws, regulators: r.regulators });

cap({
  name: 'list_health_regimes', method: 'GET', path: '/health-regimes', tag: TAG, auth: 'public', scope: 'read',
  summary: 'The countries whose health-data rules the doctors module follows (US, UK, Canada, UAE, India, Singapore, Malaysia, China, Japan, Australia, New Zealand): laws, regulators and medical-association codes, how health data is classed, consent, minors, retention, breach-notification clocks, patient rights and response time, cross-border and telehealth rules. A summary of public rules, not legal advice. `hosted_in` lists where this deployment stores data.',
  input: z.object({ code: regimeCode.optional() }),
  handler: async (_, i) => ({ notice_version: REGIME_NOTICE_VERSION, disclaimer: DISCLAIMER, hosted_in: hostedIn(), regimes: (i.code ? [i.code] : REGIME_CODES).map(regimeView) }),
});

cap({
  name: 'get_my_health_privacy', method: 'GET', path: '/medical/privacy', tag: TAG,
  summary: 'Your health-privacy centre: the country whose rules apply to your health data (null until you choose), the notice you accepted, whether your data is hosted in that country or you agreed to a transfer, your rights there, how long records are kept, requests that are open, and which providers you have shared with across a border.',
  input: z.object({}),
  async handler({ user }) {
    const prof = await getPrivacyProfile(user.id);
    const hosted = hostedIn();
    const r = prof ? regimeView(prof.regime) : null;
    const open = await one("SELECT count(*)::int AS n, count(*) FILTER (WHERE due_at < now())::int AS overdue FROM health_privacy_requests WHERE user_id=$1 AND status IN ('open','in_review')", [user.id]);
    const crossBorder = prof ? await many(
      `SELECT g.provider_id, u.display_name AS provider_name, g.provider_regime, g.scope, g.cross_border_ack_at FROM medical_grants g JOIN users u ON u.id=g.provider_id
        WHERE g.athlete_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.cross_border_ack_at IS NOT NULL`, [user.id]) : [];
    return {
      profile: prof && { regime: prof.regime, notice_version: prof.notice_version, notice_accepted_at: prof.notice_accepted_at, hosting_transfer_ack_at: prof.hosting_transfer_ack_at, notice_outdated: prof.notice_version < REGIME_NOTICE_VERSION },
      regime: r, hosted_in: hosted, hosted_in_my_country: prof ? hosted.includes(prof.regime) : null,
      available: REGIME_CODES.map((c) => ({ ...summary(REGIMES[c]), selectable: REGIMES[c].localisation !== 'strict' || hosted.includes(c), needs_transfer_ack: !hosted.includes(c) && REGIMES[c].localisation !== 'strict' })),
      open_requests: open, cross_border_shares: crossBorder, disclaimer: DISCLAIMER,
    };
// Health-data governance (US, UK, CA, AE, IN, SG, MY, CN, JP, AU, NZ): region + notice, who-accessed-my-data log, rights requests
// (access, export, correction, restriction, erasure, objection), privacy-incident register with regulator clocks, and compliance
// posture for operators and practices. Rules and deadlines come from src/health-regimes.js (operator reference, not legal advice).
// Nothing here deletes data: erasure/restriction ends provider access and holds the record until its retention date.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { clinicalCredential } from '../clinical-access.js';
import { COUNTRIES, DISCLAIMER, REGIMES, REGIME_VERSION, breachDue, publicRegime, regimeFor, requestDue, retainUntil } from '../health-regimes.js';
import { noticeState } from '../health-governance.js';

const TAG = 'Health privacy';
const country = z.string().trim().toUpperCase().refine((c) => COUNTRIES.includes(c), `Supported countries: ${COUNTRIES.join(', ')}`);

// ------------------------------------------------------------------ regimes, region and notice
cap({
  name: 'list_health_regimes', method: 'GET', path: '/health/regimes', tag: TAG, auth: 'public', scope: 'read',
  summary: 'The health-privacy rules this platform maps for each supported country: laws, regulator, professional bodies, consent, rights deadlines, breach clocks, retention, cross-border rules. Operator reference, not legal advice.',
  input: z.object({ country: z.string().trim().toUpperCase().optional() }),
  handler: (_, i) => {
    if (i.country) { const r = regimeFor(i.country); if (!r) throw notFound('Country'); return [publicRegime(r)]; }
    return Object.values(REGIMES).map(publicRegime);
  },
});

cap({
  name: 'get_my_health_region', method: 'GET', path: '/me/health/region', tag: TAG, scope: 'read',
  summary: 'The country whose health-privacy rules apply to you, the notice version you accepted, and whether you need to read a newer one.',
  async handler({ user }) {
    const s = await noticeState(user.id);
    return { country: s.country, regime: s.regime ? publicRegime(s.regime) : null, accepted_version: s.accepted_version, current_version: s.current_version, needs_notice: s.needs_notice, disclaimer: DISCLAIMER };
  },
});

cap({
  name: 'set_my_health_region', method: 'POST', path: '/medical/privacy', tag: TAG,
  summary: 'Choose the country whose health-data rules apply to you and accept its notice. If this deployment does not store data in that country you must agree to the transfer (`hosting_transfer_ack`); for UAE and China, which require health data to stay in-country, the choice is refused unless the deployment is hosted there. The choice and each acceptance are kept in an append-only history. Changing country never deletes anything.',
  input: z.object({ regime: regimeCode, accept_notice: z.literal(true).describe('you have read the notice for this country'), hosting_transfer_ack: z.boolean().default(false).describe('you agree your data is stored outside your country (required when the deployment is not hosted there)') }),
  async handler({ user }, i) {
    const r = REGIMES[i.regime], hosted = hostedIn().includes(i.regime);
    if (!hosted && r.localisation === 'strict') throw conflict(`${r.name}'s rules keep health data inside ${r.name}, and this deployment does not store data there, so we cannot honour that choice yet. Ask the operator to host in ${r.name}.`, { reason: 'localisation_unmet', regime: i.regime, hosted_in: hostedIn() });
    if (!hosted && !i.hosting_transfer_ack) throw conflict(`Your health data is stored outside ${r.name} (${hostedIn().map((c) => REGIMES[c].name).join(', ') || 'location not declared'}). ${r.cross_border} Confirm you agree to continue.`, { reason: 'transfer_ack_required', regime: i.regime, hosted_in: hostedIn() });
    return tx(async (c) => {
      const prev = (await c.query('SELECT regime FROM health_privacy_profiles WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      await c.query(
        `INSERT INTO health_privacy_profiles(user_id, regime, notice_version, notice_accepted_at, hosting_transfer_ack_at) VALUES ($1,$2,$3,now(),CASE WHEN $4::boolean THEN now() END)
         ON CONFLICT (user_id) DO UPDATE SET regime=$2, notice_version=$3, notice_accepted_at=now(), hosting_transfer_ack_at=CASE WHEN $4::boolean THEN now() END, updated_at=now()`, [user.id, i.regime, REGIME_NOTICE_VERSION, !hosted]);
      if (prev?.regime !== i.regime) await c.query("INSERT INTO health_privacy_events(user_id, action, regime, notice_version, detail) VALUES ($1,'set_region',$2,$3,$4)", [user.id, i.regime, REGIME_NOTICE_VERSION, prev ? `changed from ${prev.regime}` : null]);
      await c.query("INSERT INTO health_privacy_events(user_id, action, regime, notice_version) VALUES ($1,'accept_notice',$2,$3)", [user.id, i.regime, REGIME_NOTICE_VERSION]);
      if (!hosted) await c.query("INSERT INTO health_privacy_events(user_id, action, regime, notice_version, detail) VALUES ($1,'transfer_ack',$2,$3,$4)", [user.id, i.regime, REGIME_NOTICE_VERSION, `hosted in ${hostedIn().join(',') || 'undeclared'}`]);
      await audit(c, user.id, 'set_health_region', 'users', user.id);
      return { ok: true, regime: i.regime, notice_version: REGIME_NOTICE_VERSION, hosted_in_my_country: hosted };
    });
  },
});

// ------------------------------------------------------------------ patient rights requests
const nameOf = (kind) => REQUEST_KINDS[kind];
const view = (r, regimeRights) => ({ id: r.id, kind: r.kind, label: nameOf(r.kind), regime: r.regime, status: r.status, due_at: r.due_at, overdue: ['open', 'in_review'].includes(r.status) && new Date(r.due_at) < new Date(), statutory: (regimeRights ?? REGIMES[r.regime]?.rights ?? []).includes(r.kind), provider_id: r.provider_id, detail: decrypt(r.detail_enc, 'health_privacy_requests.detail'), resolution: decrypt(r.resolution_enc, 'health_privacy_requests.resolution'), resolved_at: r.resolved_at, created_at: r.created_at });

cap({
  name: 'create_health_privacy_request', method: 'POST', path: '/medical/privacy/requests', tag: TAG, status: 201,
  summary: 'Use a privacy right over your health data: see it, get a copy, correct it, limit sharing, object, ask for deletion, see who accessed it, withdraw a consent, or complain. The due date comes from your country\'s response time. Health records are kept for the legal retention period and are never silently deleted: a deletion request is answered by stopping all sharing and explaining what must be kept and why. `access`, `portability` and `accounting` are answered at once by export_my_health_data and list_health_disclosures.',
  input: z.object({ kind: kindEnum, detail: z.string().trim().max(2000).optional().describe('what you want, in your words (kept encrypted)'), provider_id: id.optional().describe('the provider it is about, if any') }),
  async handler({ user }, i) {
    const prof = await getPrivacyProfile(user.id);
    if (!prof) throw conflict('Choose the country whose rules apply to your health data first (set_my_health_region), so the right response time applies.', { reason: 'region_required' });
    const r = REGIMES[prof.regime];
    const dup = await one("SELECT id FROM health_privacy_requests WHERE user_id=$1 AND kind=$2 AND status IN ('open','in_review') AND provider_id IS NOT DISTINCT FROM $3", [user.id, i.kind, i.provider_id ?? null]);
    if (dup) throw conflict('You already have this request open.', { request_id: dup.id });
    const due = new Date(Date.now() + r.respond_days * 864e5);
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO health_privacy_requests(user_id, regime, kind, detail_enc, provider_id, due_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [user.id, prof.regime, i.kind, encrypt(i.detail, 'health_privacy_requests.detail'), i.provider_id ?? null, due])).rows[0];
      await c.query("INSERT INTO health_privacy_request_events(request_id, actor_id, from_status, to_status) VALUES ($1,$2,NULL,'open')", [row.id, user.id]);
      await audit(c, user.id, 'create_privacy_request', 'health_privacy_requests', row.id);
      const self = { access: 'export_my_health_data', portability: 'export_my_health_data', accounting: 'list_health_disclosures' }[i.kind] ?? null;
      return { ...view(row), self_serve: self, response_rule: r.response_rule };
  name: 'set_my_health_region', method: 'POST', path: '/me/health/region', tag: TAG, scope: 'write',
  summary: 'Choose the country whose health-privacy rules apply to you (patients) or your practice (physios, doctors) and record that you read its notice. Records which notice version you accepted.',
  input: z.object({ country, accept_notice: z.literal(true).describe('you confirm you read the notice shown for this country') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query('UPDATE users SET health_country=$2 WHERE id=$1', [user.id, i.country]);
      await c.query('INSERT INTO health_notice_acceptances(user_id, country, regime_version) VALUES ($1,$2,$3)', [user.id, i.country, REGIME_VERSION]);
      await audit(c, user.id, 'accept_health_notice', 'users', user.id);
      return { ok: true, country: i.country, accepted_version: REGIME_VERSION };
    });
  },
});

// ------------------------------------------------------------------ who accessed my data
const ACCESS_LABELS = {
  add_medical_record: 'Wrote a clinical record', list_medical_records: 'Read your health records', create_followup: 'Set a follow-up', update_followup: 'Updated a follow-up',
  list_context: 'Read your problems, allergies and medicines', create_encounter: 'Started visit notes', read_encounters: 'Read your visit notes', amend_encounter: 'Amended visit notes',
  sign_encounter: 'Signed visit notes', update_encounter: 'Edited visit notes', void_encounter: 'Voided visit notes', list_treatment_plans: 'Read your exercise plans',
  issue_clearance: 'Recorded a fit-to-play decision', withdraw_clearance: 'Withdrew a fit-to-play decision', list_clearances: 'Read your fit-to-play decisions',
  create_referral: 'Drafted a referral', list_referrals: 'Read your referrals', request_investigation: 'Requested a test', list_investigations: 'Read your tests and results',
  create_care_plan: 'Drafted a care plan', list_care_plans: 'Read your care plans', get_care_plan: 'Opened your care plan', log_care_plan_entry: 'Logged on your care plan',
  update_appointment: 'Updated your appointment', report_medical_incident: 'Logged an on-site medical incident', link_external_booking: 'Linked an outside booking', reconcile_external_booking: 'Updated an outside booking',
};
const humanise = (a) => a.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

cap({
  name: 'list_my_health_access_log', method: 'GET', path: '/me/health/access-log', tag: TAG, scope: 'clinical',
  summary: 'Who used your health data and when: every clinical read or write by a physio or doctor, and every blocked attempt. No clinical content is shown. Newest first.',
  input: z.object({ since: z.string().datetime({ offset: true }).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT a.id, a.action, a.entity, a.at, a.actor_id, u.display_name AS actor_name, u.roles AS actor_roles
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.entity_id=$1 AND a.actor_id IS DISTINCT FROM $1 AND a.action IN ('credential_check_allowed','credential_check_grace','credential_check_denied')
          AND a.entity LIKE 'clinical:%' AND a.entity NOT LIKE 'clinical:book_appointment%' AND ($4::timestamptz IS NULL OR a.at >= $4)
        ORDER BY a.at DESC, a.id DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.since ?? null]);
    return rows.map((r) => {
      const action = r.entity.split(':')[1];
      return { id: r.id, at: r.at, by: r.actor_name ?? 'A clinician', by_id: r.actor_id, role: (r.actor_roles ?? []).find((x) => ['doctor', 'physio'].includes(x)) ?? null, what: ACCESS_LABELS[action] ?? humanise(action), outcome: r.action === 'credential_check_denied' ? 'blocked' : 'allowed' };
    });
  },
});

// ------------------------------------------------------------------ rights requests
const logReq = (c, requestId, actor, action, from, to) => c.query('INSERT INTO health_data_request_events(request_id, actor_id, action, from_status, to_status) VALUES ($1,$2,$3,$4,$5)', [requestId, actor, action, from ?? null, to ?? null]);
const reqOut = ({ detail_enc, response_enc, ...r }) => ({ ...r, detail: detail_enc ? decrypt(detail_enc, 'health_data_requests.detail') : null, response: response_enc ? decrypt(response_enc, 'health_data_requests.response') : null, overdue: ['open', 'in_progress'].includes(r.status) && new Date(r.due_at) < new Date() });

cap({
  name: 'create_health_data_request', method: 'POST', path: '/me/health/requests', tag: TAG, scope: 'clinical', status: 201,
  summary: 'Ask for your health data rights to be applied: see it (access), correct it, restrict or object to its use, or ask for erasure. The platform answers within your country’s deadline. Erasure never deletes a record that must be kept: sharing stops and the record is held until its retention date. For a machine-readable copy use export_my_health_data.',
  input: z.object({ kind: z.enum(['access', 'correction', 'restriction', 'erasure', 'objection']), detail: z.string().trim().max(2000).optional().describe('what you want changed or restricted') }),
  async handler({ user }, i) {
    const s = await noticeState(user.id);
    if (i.kind === 'correction' && !i.detail) throw badRequest('Say what should be corrected');
    return tx(async (c) => {
      const dup = (await c.query("SELECT id FROM health_data_requests WHERE subject_id=$1 AND kind=$2 AND status IN ('open','in_progress')", [user.id, i.kind])).rows[0];
      if (dup) throw conflict(`You already have an open ${i.kind} request`, { request_id: dup.id });
      const r = (await c.query('INSERT INTO health_data_requests(subject_id, kind, country, regime_version, due_at, detail_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [user.id, i.kind, s.country, REGIME_VERSION, requestDue(s.regime), i.detail ? encrypt(i.detail, 'health_data_requests.detail') : null])).rows[0];
      await logReq(c, r.id, user.id, 'submitted', null, 'open');
      await audit(c, user.id, 'health_data_request', 'health_data_requests', r.id);
      return reqOut(r);
    });
  },
});

cap({
  name: 'list_my_health_privacy_requests', method: 'GET', path: '/medical/privacy/requests', tag: TAG,
  summary: 'Your privacy requests, newest first, with status, due date (and whether it is overdue) and the answer once given.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM health_privacy_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]);
    if (rows.some((r) => r.detail_enc || r.resolution_enc)) await audit(null, user.id, 'read_clinical', 'health_privacy_requests', user.id);
    return rows.map((r) => view(r));
  name: 'list_my_health_data_requests', method: 'GET', path: '/me/health/requests', tag: TAG, scope: 'clinical',
  summary: 'Your health data requests with deadline, status and the answer.', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM health_data_requests WHERE subject_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]);
    return rows.map(reqOut);
  },
});

cap({
  name: 'withdraw_health_privacy_request', method: 'POST', path: '/medical/privacy/requests/:id/withdraw', tag: TAG,
  summary: 'Withdraw one of your own open privacy requests. The request and its history stay on record.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM health_privacy_requests WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Request');
      if (!['open', 'in_review'].includes(r.status)) throw conflict(`That request is already ${r.status}`);
      const row = (await c.query("UPDATE health_privacy_requests SET status='withdrawn', updated_at=now() WHERE id=$1 RETURNING *", [r.id])).rows[0];
      await c.query("INSERT INTO health_privacy_request_events(request_id, actor_id, from_status, to_status) VALUES ($1,$2,$3,'withdrawn')", [r.id, user.id, r.status]);
      return view(row);
    });
  },
});

// ------------------------------------------------------------------ platform team: answering requests
cap({
  name: 'list_health_privacy_queue', method: 'GET', path: '/admin/health/privacy-requests', tag: TAG, auth: ['admin'],
  summary: 'Platform team: open patient privacy requests across countries, overdue first. Shows the request and the person\'s display name, never their records.',
  input: z.object({ status: z.enum(['open', 'in_review', 'fulfilled', 'refused', 'withdrawn', 'active']).default('active').describe('active = open or in review'), regime: regimeCode.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT r.*, u.display_name AS person FROM health_privacy_requests r JOIN users u ON u.id=r.user_id
        WHERE ($1 = 'active' AND r.status IN ('open','in_review') OR r.status = $1) AND ($2::text IS NULL OR r.regime=$2)
        ORDER BY (r.status IN ('open','in_review') AND r.due_at < now()) DESC, r.due_at ASC LIMIT $3 OFFSET $4`, [i.status, i.regime ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'read_clinical', 'health_privacy_requests', null);
    return rows.map((r) => ({ ...view(r), person: r.person, user_id: r.user_id }));
  },
});

const RESTRICTING = new Set(['restriction', 'erasure', 'withdraw_consent']);
cap({
  name: 'resolve_health_privacy_request', method: 'POST', path: '/admin/health/privacy-requests/:id/resolve', tag: TAG, auth: ['admin'],
  summary: 'Platform team: move a privacy request to in_review, fulfilled or refused (a refusal needs a reason the person can read). Fulfilling a restriction, deletion or consent-withdrawal request stops all sharing: every active grant (or just the named provider\'s) is revoked, kept in history. Records themselves are never deleted; explain in the note what is retained and for how long. The person is notified.',
  input: z.object({ id, status: z.enum(['in_review', 'fulfilled', 'refused']), note: z.string().trim().min(5).max(2000).optional().describe('what was done, or why it was refused (the person reads it)') }),
  async handler({ user }, i) {
    if (i.status === 'refused' && !i.note) throw badRequest('Say why the request is refused: the person will read it.');
    if (i.status === 'fulfilled' && !i.note) throw badRequest('Say what was done: the person will read it.');
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM health_privacy_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (!['open', 'in_review'].includes(r.status)) throw conflict(`That request is already ${r.status}`);
      const final = i.status !== 'in_review';
      const row = (await c.query('UPDATE health_privacy_requests SET status=$2, resolution_enc=coalesce($3, resolution_enc), resolved_by=CASE WHEN $4 THEN $5::uuid END, resolved_at=CASE WHEN $4 THEN now() END, updated_at=now() WHERE id=$1 RETURNING *',
        [r.id, i.status, encrypt(i.note, 'health_privacy_requests.resolution'), final, user.id])).rows[0];
      await c.query('INSERT INTO health_privacy_request_events(request_id, actor_id, from_status, to_status) VALUES ($1,$2,$3,$4)', [r.id, user.id, r.status, i.status]);
      let revoked = 0;
      if (i.status === 'fulfilled' && RESTRICTING.has(r.kind)) {
        const rs = await c.query('UPDATE medical_grants SET revoked_at=now() WHERE athlete_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR provider_id=$2) RETURNING provider_id, scope', [r.user_id, r.provider_id]);
        revoked = rs.rowCount;
        for (const g of rs.rows) await c.query("INSERT INTO medical_grant_events(athlete_id, provider_id, action, scope) VALUES ($1,$2,'revoke',$3)", [r.user_id, g.provider_id, g.scope]);
      }
      await audit(c, user.id, 'resolve_privacy_request', 'health_privacy_requests', r.id);
      await notify(c, r.user_id, { kind: 'privacy_request', title: i.status === 'in_review' ? 'We are looking at your privacy request' : i.status === 'fulfilled' ? 'Your privacy request is done' : 'We could not do your privacy request', body: 'Open Health → Privacy to read the answer.', data: { request_id: r.id } });
      return { ...view(row), grants_revoked: revoked };
    });
  },
});

// ------------------------------------------------------------------ accounting of disclosures
const ACTIONS = ['read_clinical', 'write_clinical', 'sign_clinical', 'void_clinical', 'review_clinical'];
const ACTION_LABEL = { read_clinical: 'Opened', write_clinical: 'Added or changed', sign_clinical: 'Signed', void_clinical: 'Voided', review_clinical: 'Reviewed' };
const AREA = { medical_records: 'Medical records', clinical_encounters: 'Consultations', clinical_context_entries: 'Allergies, problems and medicines', clinical_context_declarations: 'Allergies, problems and medicines', clinical_care_plans: 'Care plans', clinical_care_plan_entries: 'Care plans', clinical_investigations: 'Tests and results', clinical_results: 'Tests and results', clinical_referrals: 'Referrals', clinical_clearances: 'Fit-to-play decisions', appointment_followups: 'Follow-ups', treatment_plans: 'Exercise plans', event_medical_incidents: 'Event medical log' };
// [table, how the log row's entity_id reaches the patient]. Reads log the patient's id directly; writes log the row's id, so they join through the table.
const DIRECT = ['medical_records', 'clinical_encounters', 'clinical_context_entries', 'clinical_context_declarations', 'clinical_care_plans', 'clinical_investigations', 'clinical_referrals', 'clinical_clearances', 'appointment_followups'];
const DISCLOSURES_SQL = `
  SELECT at, actor_id, action, entity, event_id FROM (
    SELECT l.at, l.actor_id, l.action, l.entity, NULL::uuid AS event_id FROM audit_log l WHERE l.entity_id=$1 AND l.entity = ANY($3::text[]) AND l.action = ANY($2::text[])
    ${DIRECT.map((t) => `UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, NULL FROM audit_log l JOIN ${t} t ON t.id=l.entity_id WHERE l.entity='${t}' AND t.athlete_id=$1 AND l.action = ANY($2::text[])`).join('\n    ')}
    UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, NULL FROM audit_log l JOIN clinical_care_plan_entries e ON e.id=l.entity_id JOIN clinical_care_plans p ON p.id=e.plan_id WHERE l.entity='clinical_care_plan_entries' AND p.athlete_id=$1 AND l.action = ANY($2::text[])
    UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, NULL FROM audit_log l JOIN clinical_results r ON r.id=l.entity_id JOIN clinical_investigations v ON v.id=r.investigation_id WHERE l.entity='clinical_results' AND v.athlete_id=$1 AND l.action = ANY($2::text[])
    UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, NULL FROM audit_log l JOIN treatment_plans t ON t.id=l.entity_id WHERE l.entity='treatment_plans' AND t.patient_id=$1 AND l.action = ANY($2::text[])
    UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, m.event_id FROM audit_log l JOIN event_medical_incidents m ON m.id=l.entity_id JOIN event_participants p ON p.id=m.participant_id WHERE l.entity='event_medical_incidents' AND p.user_id=$1 AND l.action = ANY($2::text[])
    UNION ALL SELECT l.at, l.actor_id, l.action, l.entity, l.entity_id FROM audit_log l WHERE l.entity='event_medical_incidents' AND l.action='read_clinical' AND l.entity_id IN (SELECT m.event_id FROM event_medical_incidents m JOIN event_participants p ON p.id=m.participant_id WHERE p.user_id=$1)
  ) d WHERE d.actor_id IS DISTINCT FROM $1`;

cap({
  name: 'list_health_disclosures', method: 'GET', path: '/medical/disclosures', tag: TAG,
  summary: 'Accounting of disclosures: who opened, added to, signed or reviewed your health data (including the medical log of an event you played in), what area, and when - newest first - plus when you shared access with whom. Never shows clinical content. Fulfils an open "see who accessed my data" request.',
  input: z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT d.at, d.action, d.entity, d.event_id, u.display_name AS actor_name, u.roles AS actor_roles FROM (${DISCLOSURES_SQL}) d LEFT JOIN users u ON u.id=d.actor_id
        WHERE ($4::timestamptz IS NULL OR d.at >= $4) AND ($5::timestamptz IS NULL OR d.at <= $5) ORDER BY d.at DESC LIMIT $6 OFFSET $7`,
      [user.id, ACTIONS, DIRECT, i.from ?? null, i.to ?? null, i.limit, i.offset]);
    const sharing = await many('SELECT e.action, e.scope, e.expires_at, e.created_at, u.display_name AS provider_name FROM medical_grant_events e JOIN users u ON u.id=e.provider_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC LIMIT 100', [user.id]);
    await closeRequests(user.id, ['accounting']);
    await audit(null, user.id, 'read_disclosures', 'users', user.id);
    return { entries: rows.map((r) => ({ at: r.at, who: r.actor_name ?? 'Unknown', roles: (r.actor_roles ?? []).filter((x) => ['doctor', 'physio', 'admin', 'referee', 'coach'].includes(x)), what: ACTION_LABEL[r.action] ?? r.action, area: AREA[r.entity] ?? r.entity, event_id: r.event_id ?? null })), sharing };
  },
});

/** Close the person's own open requests of these kinds because the self-serve answer was just given (history kept). */
async function closeRequests(userId, kinds) {
  await tx(async (c) => {
    const rs = await c.query("UPDATE health_privacy_requests SET status='fulfilled', resolved_at=now(), resolution_enc=$3, updated_at=now() WHERE user_id=$1 AND kind = ANY($2::text[]) AND status IN ('open','in_review') RETURNING id", [userId, kinds, encrypt('Answered automatically from the Privacy screen.', 'health_privacy_requests.resolution')]);
    for (const r of rs.rows) await c.query("INSERT INTO health_privacy_request_events(request_id, actor_id, from_status, to_status) VALUES ($1,$2,'open','fulfilled')", [r.id, userId]);
  });
}

// ------------------------------------------------------------------ complete copy
const drain = async (user, name, extra = {}, max = 20) => {
  const c = capabilities.find((x) => x.name === name);
  const out = [];
  for (let off = 0; off < max * 100; off += 100) {
    const rows = await c.handler({ user }, c.input.parse({ limit: 100, offset: off, ...extra }));
    if (!Array.isArray(rows)) return rows;   // an object result (grants + history, context) is one document, not a page
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
};

cap({
  name: 'export_my_health_data', method: 'GET', path: '/medical/export', tag: TAG,
  summary: 'A complete copy of your own health data as one JSON document (right of access / portability): your country and consents, appointments, records, consultation summaries, care plans, tests, allergies/medicines, referrals, fit-to-play decisions, follow-ups, exercise plans, who you shared with, privacy requests, the medical log of events you played in, and the accounting of disclosures. Doctors\' private working notes are not part of it. The export is itself audit-logged; it fulfils open access/portability requests.',
  input: z.object({}),
  async handler({ user }) {
    const prof = await getPrivacyProfile(user.id);
    // run every section as a plain patient: a doctor or physio exporting their OWN data must not receive their patients' records
    const me = { ...user, roles: (user.roles ?? []).filter((r) => !['doctor', 'physio', 'admin', 'platform_admin'].includes(r)) };
    const section = async (name, extra) => { try { return await drain(me, name, extra); } catch (e) { return { unavailable: String(e.message).slice(0, 120) }; } };
    const mine = (rows, keep) => (Array.isArray(rows) ? rows.filter(keep) : rows);
    const [appointments, records, encounters, carePlans, investigations, referrals, clearances, followups, treatmentPlans, grants] = await Promise.all([
      section('list_appointments'), section('list_medical_records'), section('list_encounters'), section('list_care_plans'), section('list_investigations'), section('list_referrals', { box: 'mine' }),
      section('list_clearances'), section('list_my_followups'), section('list_treatment_plans'), section('list_my_grants'),
    ]);
    const context = await (async () => { const c = capabilities.find((x) => x.name === 'list_context'); try { return await c.handler({ user: me }, c.input.parse({ include_history: true, limit: 100 })); } catch (e) { return { unavailable: String(e.message).slice(0, 120) }; } })();
    const incidents = await many(
      `SELECT m.id, m.event_id, e.name AS event, m.severity, m.outcome, m.return_to_play, m.occurred_at, m.summary_enc, m.details_enc FROM event_medical_incidents m JOIN event_participants p ON p.id=m.participant_id JOIN events e ON e.id=m.event_id WHERE p.user_id=$1 ORDER BY m.occurred_at DESC`, [user.id]);
    const requests = (await many('SELECT * FROM health_privacy_requests WHERE user_id=$1 ORDER BY created_at DESC', [user.id])).map((r) => view(r));
    const history = await many('SELECT action, regime, notice_version, detail, created_at FROM health_privacy_events WHERE user_id=$1 ORDER BY created_at', [user.id]);
    const disclosures = await capabilities.find((x) => x.name === 'list_health_disclosures').handler({ user }, { limit: 100, offset: 0 });
    await audit(null, user.id, 'export_health_data', 'users', user.id);
    await audit(null, user.id, 'read_clinical', 'event_medical_incidents', user.id);
    await closeRequests(user.id, ['access', 'portability']);
    return {
      exported_at: new Date().toISOString(), format: 'gotmygame-health-export/1', person: { id: user.id, display_name: user.display_name },
      privacy: { country: prof?.regime ?? null, notice_version: prof?.notice_version ?? null, notice_accepted_at: prof?.notice_accepted_at ?? null, history },
      appointments: mine(appointments, (a) => a.athlete_id === user.id), records, consultation_summaries: encounters, care_plans: carePlans, tests_and_results: investigations, allergies_problems_medicines: context, referrals, fit_to_play: clearances, follow_ups: mine(followups, (f) => f.i_am_athlete), exercise_plans: mine(treatmentPlans, (p) => p.as === 'patient'),
      sharing: grants, event_medical_log: incidents.map(({ summary_enc, details_enc, ...r }) => ({ ...r, summary: decrypt(summary_enc, 'event_medical_incidents.summary'), details: decrypt(details_enc, 'event_medical_incidents.details') })),
      privacy_requests: requests, disclosures,
      note: 'This is the information the platform holds that you are entitled to see. Providers keep their own working notes under their professional duties; ask them, or raise a privacy request, for anything not shown.',
    };
  name: 'withdraw_health_data_request', method: 'POST', path: '/me/health/requests/:id/withdraw', tag: TAG, scope: 'clinical', input: z.object({ id }),
  summary: 'Withdraw your own open request. It stays in your history.',
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM health_data_requests WHERE id=$1 AND subject_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Request');
      if (!['open', 'in_progress'].includes(r.status)) throw conflict('That request is already closed');
      const out = (await c.query("UPDATE health_data_requests SET status='withdrawn', updated_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
      await logReq(c, i.id, user.id, 'withdrawn', r.status, 'withdrawn');
      return reqOut(out);
    });
  },
});

cap({
  name: 'list_health_data_request_queue', method: 'GET', path: '/admin/health/requests', tag: TAG, auth: ['admin'],
  summary: 'Platform team: open health data requests, oldest deadline first, with overdue flags. Names only, no clinical content.',
  input: z.object({ status: z.enum(['open', 'in_progress', 'fulfilled', 'declined', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT r.*, u.display_name AS subject_name FROM health_data_requests r JOIN users u ON u.id=r.subject_id
        WHERE ($1::text IS NULL AND r.status IN ('open','in_progress')) OR r.status=$1 ORDER BY r.due_at, r.id LIMIT $2 OFFSET $3`, [i.status ?? null, i.limit, i.offset]);
    if (rows.some((r) => r.detail_enc)) await audit(null, user.id, 'read_clinical', 'health_data_requests', null);
    return rows.map(reqOut);
  },
});

/** Last time anything clinical was written for this person: the retention clock starts there. */
const lastClinicalEntry = async (c, userId) => (await c.query(
  `SELECT max(t) AS t FROM (SELECT max(created_at) AS t FROM medical_records WHERE athlete_id=$1 UNION ALL SELECT max(starts_at) FROM appointments WHERE athlete_id=$1
    UNION ALL SELECT max(created_at) FROM clinical_context_entries WHERE athlete_id=$1) x`, [userId])).rows[0].t;

cap({
  name: 'resolve_health_data_request', method: 'POST', path: '/admin/health/requests/:id/resolve', tag: TAG, auth: ['admin'],
  summary: 'Platform team: start, fulfil or decline a health data request, with the reason shown to the person. Fulfilling restriction, erasure or objection ends every active provider consent at once and holds the record until its retention date; nothing is deleted.',
  input: z.object({ id, status: z.enum(['in_progress', 'fulfilled', 'declined']), response: z.string().trim().min(5).max(2000).optional() }),
  async handler({ user }, i) {
    if (i.status !== 'in_progress' && !i.response) throw badRequest('Give the person a reason or a note about what was done');
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM health_data_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (!['open', 'in_progress'].includes(r.status)) throw conflict('That request is already closed');
      let retain = null;
      if (i.status === 'fulfilled' && ['restriction', 'erasure', 'objection'].includes(r.kind)) {
        const regime = regimeFor(r.country);
        const u = (await c.query('SELECT dob_enc FROM users WHERE id=$1', [r.subject_id])).rows[0];
        let dob = null;
        if (u?.dob_enc && regime?.retention.minor_until_age) { await audit(c, user.id, 'read_pii', 'users', r.subject_id); dob = decrypt(u.dob_enc, 'users.dob'); }
        retain = regime ? retainUntil(regime, await lastClinicalEntry(c, r.subject_id), dob) : null;
        const revoked = (await c.query('UPDATE medical_grants SET revoked_at=now() WHERE athlete_id=$1 AND revoked_at IS NULL RETURNING provider_id, scope', [r.subject_id])).rows;
        for (const g of revoked) await c.query("INSERT INTO medical_grant_events(athlete_id, provider_id, action, scope) VALUES ($1,$2,'revoke',$3)", [r.subject_id, g.provider_id, g.scope]);
      }
      const out = (await c.query('UPDATE health_data_requests SET status=$2, response_enc=coalesce($3, response_enc), retain_until=$4, decided_by=$5, decided_at=CASE WHEN $2=\'in_progress\' THEN decided_at ELSE now() END, updated_at=now() WHERE id=$1 RETURNING *',
        [i.id, i.status, i.response ? encrypt(i.response, 'health_data_requests.response') : null, retain, user.id])).rows[0];
      await logReq(c, i.id, user.id, i.status, r.status, i.status);
      await audit(c, user.id, 'resolve_health_request', 'health_data_requests', i.id);
      await notify(c, r.subject_id, { kind: 'health_request', title: 'Your health data request was updated', body: 'Open Health → Privacy to read the answer.', data: { request_id: i.id } });
      return reqOut(out);
    });
  },
});

// ------------------------------------------------------------------ export (right of access / portability)
const cap_ = 5000;
cap({
  name: 'export_my_health_data', method: 'GET', path: '/me/health/export', tag: TAG, scope: 'clinical',
  summary: 'A complete machine-readable copy of the health data held about you (appointments, records, problems/allergies/medicines, follow-ups, consents, requests). Decrypted for you, audit-logged, and recorded as a fulfilled access request.',
  async handler({ user }) {
    const s = await noticeState(user.id);
    const q = (sql) => many(sql, [user.id]);
    const [appointments, records, context, followups, grants, grantEvents, clearances, requests] = await Promise.all([
      q(`SELECT a.id, a.starts_at, a.duration_min, a.status, a.reason_enc, p.display_name AS provider FROM appointments a JOIN users p ON p.id=a.provider_id WHERE a.athlete_id=$1 ORDER BY a.starts_at DESC LIMIT ${cap_}`),
      q(`SELECT r.id, r.kind, r.clearance, r.summary_enc, r.details_enc, r.created_at, p.display_name AS provider FROM medical_records r JOIN users p ON p.id=r.provider_id WHERE r.athlete_id=$1 ORDER BY r.created_at DESC LIMIT ${cap_}`),
      q(`SELECT e.id, e.kind, e.status, e.source, e.verification, e.label_enc, e.detail_enc, e.created_at FROM clinical_context_entries e WHERE e.athlete_id=$1 ORDER BY e.created_at DESC LIMIT ${cap_}`),
      q(`SELECT f.id, f.status, f.due_on, f.instruction_summary, f.details_enc, p.display_name AS provider FROM appointment_followups f JOIN users p ON p.id=f.provider_id WHERE f.athlete_id=$1 ORDER BY f.due_on DESC LIMIT ${cap_}`),
      q(`SELECT g.granted_at, g.revoked_at, g.expires_at, g.scope, p.display_name AS provider FROM medical_grants g JOIN users p ON p.id=g.provider_id WHERE g.athlete_id=$1 ORDER BY g.granted_at DESC`),
      q(`SELECT e.action, e.scope, e.expires_at, e.created_at AS at, p.display_name AS provider FROM medical_grant_events e JOIN users p ON p.id=e.provider_id WHERE e.athlete_id=$1 ORDER BY e.created_at DESC LIMIT ${cap_}`),
      q(`SELECT c.id, c.status, c.sport_id, c.assessed_on, c.valid_until, c.withdrawn_at FROM clinical_clearances c WHERE c.athlete_id=$1 ORDER BY c.created_at DESC LIMIT ${cap_}`),
      q(`SELECT id, kind, status, due_at, created_at, decided_at FROM health_data_requests WHERE subject_id=$1 ORDER BY created_at DESC`),
    ]);
    const data = {
      format: 'gotmygame-health-export', format_version: 1, generated_at: new Date().toISOString(), country: s.country, notice_version: s.accepted_version,
      appointments: appointments.map(({ reason_enc, ...r }) => ({ ...r, reason: reason_enc ? decrypt(reason_enc, 'appointments.reason') : null })),
      records: records.map(({ summary_enc, details_enc, ...r }) => ({ ...r, summary: decrypt(summary_enc, 'medical_records.summary'), details: details_enc ? decrypt(details_enc, 'medical_records.details') : null })),
      problems_allergies_medicines: context.map(({ label_enc, detail_enc, ...r }) => ({ ...r, name: decrypt(label_enc, 'clinical_context.label'), detail: detail_enc ? JSON.parse(decrypt(detail_enc, 'clinical_context.detail')) : {} })),
      followups: followups.map(({ details_enc, ...r }) => ({ ...r, details: details_enc ? decrypt(details_enc, 'followups.details') : null })),
      sharing: { current_and_past_consents: grants, history: grantEvents },
      fit_to_play_decisions: clearances,
      health_data_requests: requests,
      limits: `Each list holds at most ${cap_} newest entries. Exercise plans, care plans, referrals and test results are in their own screens; ask for an access request to receive them.`,
    };
    await tx(async (c) => {
      const r = (await c.query("INSERT INTO health_data_requests(subject_id, kind, status, country, regime_version, due_at, decided_by, decided_at) VALUES ($1,'export','fulfilled',$2,$3,now(),$1,now()) RETURNING id", [user.id, s.country, REGIME_VERSION])).rows[0];
      await logReq(c, r.id, user.id, 'exported', 'open', 'fulfilled');
      await audit(c, user.id, 'export_health_data', 'users', user.id);
    });
    return data;
  },
});

// ------------------------------------------------------------------ privacy / security incident register
const INCIDENT_KINDS = ['unauthorised_access', 'loss_or_theft', 'misdirected_disclosure', 'system_compromise', 'improper_retention', 'other'];
const incOut = ({ description_enc, ...r }) => ({ ...r, description: decrypt(description_enc, 'privacy_incidents.description'),
  regulator_overdue: r.status !== 'closed' && !r.regulator_notified_at && !!r.regulator_due_at && new Date(r.regulator_due_at) < new Date() });
const logInc = (c, incidentId, actor, action, from, to) => c.query('INSERT INTO privacy_incident_events(incident_id, actor_id, action, from_status, to_status) VALUES ($1,$2,$3,$4,$5)', [incidentId, actor, action, from ?? null, to ?? null]);

cap({
  name: 'report_privacy_incident', method: 'POST', path: '/health/incidents', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Report a privacy or security incident involving health data (wrong recipient, lost device, unauthorised access, event-coverage record exposed…). The regulator and individual notification clocks of the affected country start from when you became aware. Never put patient names or clinical detail in the description.',
  input: z.object({ kind: z.enum(INCIDENT_KINDS), severity: z.enum(['low', 'medium', 'high']), country, affected_people: z.number().int().min(0).max(10_000_000).default(0), health_data_involved: z.boolean().default(true),
    occurred_at: z.string().datetime({ offset: true }), event_id: id.optional().describe('the event it happened at, if any'), description: z.string().trim().min(10).max(2000) }),
  async handler({ user }, i) {
    if (Date.parse(i.occurred_at) > Date.now() + 6e4) throw badRequest('The incident cannot be in the future');
    if (i.event_id && !(await one('SELECT 1 FROM events WHERE id=$1', [i.event_id]))) throw notFound('Event');
    const aware = new Date();
    return tx(async (c) => {
      const r = (await c.query(
        'INSERT INTO privacy_incidents(reported_by, country, kind, severity, affected_people, health_data_involved, event_id, occurred_at, aware_at, regime_version, regulator_due_at, description_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [user.id, i.country, i.kind, i.severity, i.affected_people, i.health_data_involved, i.event_id ?? null, i.occurred_at, aware, REGIME_VERSION, breachDue(regimeFor(i.country), aware), encrypt(i.description, 'privacy_incidents.description')])).rows[0];
      await logInc(c, r.id, user.id, 'reported', null, 'open');
      await audit(c, user.id, 'report_privacy_incident', 'privacy_incidents', r.id);
      for (const a of (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows) await notify(c, a.id, { kind: 'privacy_incident', title: 'A privacy incident was reported', body: 'Open Health → Privacy → Incidents. A regulator clock may be running.', data: { incident_id: r.id } });
      return { ...incOut(r), obligations: regimeFor(i.country).breach };
    });
  },
});

cap({
  name: 'list_privacy_incidents', method: 'GET', path: '/health/incidents', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Privacy incidents you reported (platform team: all), regulator deadline and overdue flag.',
  input: z.object({ status: z.enum(['open', 'assessed', 'notified', 'closed']).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM privacy_incidents WHERE ($1::boolean OR reported_by=$2) AND ($3::text IS NULL OR status=$3) ORDER BY (status = \'closed\'), regulator_due_at NULLS LAST, created_at DESC LIMIT $4 OFFSET $5', [isAdmin(user), user.id, i.status ?? null, i.limit, i.offset]);
    return rows.map((r) => ({ ...incOut(r), obligations: regimeFor(r.country)?.breach ?? null }));
  },
});

const NEXT = { open: ['assessed', 'notified', 'closed'], assessed: ['notified', 'closed'], notified: ['closed'], closed: [] };
cap({
  name: 'update_privacy_incident', method: 'POST', path: '/admin/health/incidents/:id/update', tag: TAG, auth: ['admin'],
  summary: 'Platform team: move an incident along (assessed → notified → closed) and record when the regulator and the affected people were told. Closing without notifying anyone needs a reason (e.g. assessed as not notifiable).',
  input: z.object({ id, status: z.enum(['assessed', 'notified', 'closed']), regulator_notified_at: z.string().datetime({ offset: true }).optional(), individuals_notified_at: z.string().datetime({ offset: true }).optional(), note: z.string().trim().min(5).max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM privacy_incidents WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Incident');
      if (!NEXT[r.status].includes(i.status)) throw conflict(`An incident that is ${r.status} cannot move to ${i.status}`);
      const reg = i.regulator_notified_at ?? r.regulator_notified_at, ind = i.individuals_notified_at ?? r.individuals_notified_at;
      if (i.status === 'notified' && !reg && !ind) throw badRequest('Say when the regulator or the affected people were notified');
      if (i.status === 'closed' && !reg && !ind && !i.note) throw badRequest('Closing without a notification needs a reason');
      for (const t of [i.regulator_notified_at, i.individuals_notified_at]) if (t && Date.parse(t) > Date.now() + 6e4) throw badRequest('A notification time cannot be in the future');
      const out = (await c.query('UPDATE privacy_incidents SET status=$2, regulator_notified_at=$3, individuals_notified_at=$4, closed_at=CASE WHEN $2=\'closed\' THEN now() ELSE closed_at END, updated_at=now() WHERE id=$1 RETURNING *', [i.id, i.status, reg, ind])).rows[0];
      await logInc(c, i.id, user.id, i.note ? `${i.status}: ${i.note}` : i.status, r.status, i.status);
      await audit(c, user.id, 'update_privacy_incident', 'privacy_incidents', i.id);
      return incOut(out);
    });
  },
});

// ------------------------------------------------------------------ compliance posture (operator) and practice checklist
const check = (id, status, title, detail) => ({ id, status, title, detail });

cap({
  name: 'get_health_compliance_posture', method: 'GET', path: '/admin/health/posture', tag: TAG, auth: ['admin'],
  summary: 'Platform team: how this deployment measures up against the controls the health-privacy rules rely on (encryption keys, two-step verification, hosting country vs data-localisation rules, notices, overdue requests and incidents). Findings, not a certificate.',
  async handler() {
    const [byCountry, noMfa, noNotice, overdueReq, overdueInc, openInc] = await Promise.all([
      many('SELECT health_country AS country, count(*)::int AS people FROM users WHERE health_country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC'),
      one("SELECT count(*)::int AS n FROM users u WHERE (u.roles && ARRAY['doctor','physio']) AND NOT EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id=u.id AND m.disabled_at IS NULL)"),
      one(`SELECT count(*)::int AS n FROM users u WHERE u.health_country IS NOT NULL AND NOT EXISTS (SELECT 1 FROM health_notice_acceptances a WHERE a.user_id=u.id AND a.country=u.health_country AND a.regime_version >= $1)`, [REGIME_VERSION]),
      one("SELECT count(*)::int AS n FROM health_data_requests WHERE status IN ('open','in_progress') AND due_at < now()"),
      one("SELECT count(*)::int AS n FROM privacy_incidents WHERE status <> 'closed' AND regulator_notified_at IS NULL AND regulator_due_at < now()"),
      one("SELECT count(*)::int AS n FROM privacy_incidents WHERE status <> 'closed'"),
    ]);
    const host = config.health.hostingCountry;
    const checks = [
      check('keys', config.keyProvider === 'aws-kms' ? 'ok' : config.isProd ? 'warn' : 'ok', 'Field encryption key protection', config.keyProvider === 'aws-kms' ? 'The master key is wrapped by a cloud KMS.' : 'The master key comes from the environment. Use KEY_PROVIDER=aws-kms in production.'),
      check('mfa', config.mfaEnforce ? 'ok' : 'warn', 'Two-step verification for clinicians and admins', config.mfaEnforce ? 'Enforced for clinical and admin actions.' : 'Not enforced (MFA_ENFORCE). Turn it on in production.'),
      check('mfa_enrolled', noMfa.n === 0 ? 'ok' : 'warn', 'Clinicians enrolled in two-step verification', noMfa.n === 0 ? 'Every doctor and physio has two-step verification.' : `${noMfa.n} doctor/physio account(s) have not enrolled.`),
      check('http', config.allowInsecureHttp ? 'fail' : 'ok', 'Encrypted transport', config.allowInsecureHttp ? 'Plain HTTP is allowed (ALLOW_INSECURE_HTTP). Health data must travel over TLS.' : 'HTTPS is enforced in production.'),
      check('credentials', config.clinical.jurisdictions.length ? 'ok' : 'warn', 'Clinician licence jurisdictions', config.clinical.jurisdictions.length ? `Credentials accepted for: ${config.clinical.jurisdictions.join(', ')}.` : 'Any credential jurisdiction is accepted. Set CLINICAL_JURISDICTIONS to the countries you operate in.'),
      check('hosting', host ? 'ok' : 'warn', 'Hosting country declared', host ? `Health data is hosted in ${host}.` : 'Set HEALTH_DATA_HOSTING_COUNTRY so data-localisation rules can be checked.'),
    ];
    for (const row of byCountry) {
      const r = regimeFor(row.country);
      if (!r || !['localised', 'restricted'].includes(r.transfer.mode) || host === row.country) continue;
      checks.push(check(`transfer_${row.country}`, r.transfer.mode === 'localised' ? 'fail' : 'warn', `${r.name}: cross-border storage`, `${row.people} person(s) are governed by ${r.name} rules but data is hosted ${host ? 'in ' + host : 'in an undeclared country'}. ${r.transfer.note}`));
    }
    checks.push(check('notices', noNotice.n === 0 ? 'ok' : 'warn', 'Privacy notices accepted', noNotice.n === 0 ? 'Everyone with a chosen country accepted the current notice.' : `${noNotice.n} person(s) need to read the current notice.`));
    checks.push(check('requests', overdueReq.n === 0 ? 'ok' : 'fail', 'Rights requests answered on time', overdueReq.n === 0 ? 'No request is past its deadline.' : `${overdueReq.n} request(s) are past their deadline.`));
    checks.push(check('incidents', overdueInc.n === 0 ? 'ok' : 'fail', 'Incident notification clocks', overdueInc.n === 0 ? `${openInc.n} open incident(s), none past a regulator deadline.` : `${overdueInc.n} incident(s) are past a regulator deadline.`));
    return { checks, summary: { fail: checks.filter((x) => x.status === 'fail').length, warn: checks.filter((x) => x.status === 'warn').length, ok: checks.filter((x) => x.status === 'ok').length },
      people_by_country: byCountry.map((r) => ({ ...r, name: regimeFor(r.country)?.name ?? r.country })), hosting_country: host, regime_version: REGIME_VERSION, disclaimer: DISCLAIMER };
  },
});

cap({
  name: 'get_my_practice_compliance', method: 'GET', path: '/me/health/practice-compliance', tag: TAG, auth: ['physio', 'doctor'], scope: 'read',
  summary: 'Your practice checklist for the country you chose: notice read, licence current and valid in that country, two-step verification on, plus the rules that apply (deadlines, retention, breach clocks, telehealth).',
  async handler({ user }) {
    const s = await noticeState(user.id);
    const cred = await clinicalCredential(user.id);
    const [mfa, openInc, overdueInc] = await Promise.all([
      one('SELECT 1 AS x FROM user_mfa WHERE user_id=$1 AND disabled_at IS NULL', [user.id]),
      one("SELECT count(*)::int AS n FROM privacy_incidents WHERE reported_by=$1 AND status <> 'closed'", [user.id]),
      one("SELECT count(*)::int AS n FROM privacy_incidents WHERE reported_by=$1 AND status <> 'closed' AND regulator_notified_at IS NULL AND regulator_due_at < now()", [user.id]),
    ]);
    const lic = cred.case_id ? await one('SELECT jurisdiction FROM verification_cases WHERE id=$1', [cred.case_id]) : null;
    const licCountry = (lic?.jurisdiction ?? '').trim().toUpperCase().slice(0, 2) || null;
    const checks = [
      check('region', s.country ? 'ok' : 'fail', 'Practice country chosen', s.country ? `Your practice follows ${s.regime.name} rules.` : 'Choose the country whose rules apply to your practice.'),
      check('notice', !s.country ? 'fail' : s.needs_notice ? 'fail' : 'ok', 'Current privacy notice read', s.needs_notice || !s.country ? 'Read and accept the notice for your country.' : `Accepted version ${s.accepted_version}.`),
      check('credential', cred.ok ? 'ok' : 'fail', 'Professional verification current', cred.ok ? `Valid until ${new Date(cred.expires_at).toISOString().slice(0, 10)}.` : `Not current (${cred.reason}). Renew it under Me → Verification.`),
      check('licence_country', !s.country || !licCountry ? 'warn' : licCountry === s.country ? 'ok' : 'warn', 'Licence matches practice country', !licCountry ? 'Your verified licence does not record a jurisdiction.' : licCountry === s.country ? `Licence jurisdiction ${licCountry}.` : `Your licence says ${licCountry} but your practice country is ${s.country}.`),
      check('mfa', mfa ? 'ok' : 'fail', 'Two-step verification on', mfa ? 'Enabled.' : 'Enable it under Account security. Clinical actions need it.'),
      check('incidents', overdueInc.n ? 'fail' : 'ok', 'Incident reports', overdueInc.n ? `${overdueInc.n} incident(s) you reported are past a regulator deadline.` : `${openInc.n} open.`),
    ];
    return { country: s.country, regime: s.regime ? publicRegime(s.regime) : null, checks, ready: checks.every((x) => x.status !== 'fail'), disclaimer: DISCLAIMER };
  },
});
