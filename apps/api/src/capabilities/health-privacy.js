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
  name: 'list_my_health_data_requests', method: 'GET', path: '/me/health/requests', tag: TAG, scope: 'clinical',
  summary: 'Your health data requests with deadline, status and the answer.', input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many('SELECT * FROM health_data_requests WHERE subject_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [user.id, i.limit, i.offset]);
    return rows.map(reqOut);
  },
});

cap({
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
