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
  },
});
