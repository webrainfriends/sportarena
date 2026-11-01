// Federation extras (#703) 2/3: the background-check vendor adapter, as part of the existing compliance system (no second compliance flow).
// Order of events: the person (or their guardian) gives consent -> a check is ordered from a linked provider -> the provider reports clear / not clear / pending
// (webhook, or the poll sweep) -> a reviewer confirms through decide_compliance_record. Only the mapped state and the provider's reference are kept: never the report.
// Self-declaration stays refused (compliance.js checkReq), and every read of a check is audit-logged.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { actingFor } from '../youth.js';
import { addDays, applicable, holderAccess, managerIds, manages } from '../compliance.js';
import { orgRole } from '../org-access.js';
import { assertPublicHttpsUrl } from '../identity/safe-http.js';
import { adapterFor, availableKinds, CONFIG_FIELDS, VendorError, refIndex } from '../background-checks.js';
import { TAG, log, loadRequirement } from './compliance.js';

const today = async (c = pool) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

/** Load a background-check requirement for a person subject. */
async function checkRequirement(requirementId) {
  const req = await loadRequirement(requirementId);
  if (req.category !== 'background_check') throw badRequest('That requirement is not a background check');
  if (req.subject_kind !== 'person') throw badRequest('A background check is for a person');
  return req;
}

const consenter = (user, subjectId) => actingFor(user, subjectId, 'consent');   // the person, or a guardian holding the `consent` scope

const currentConsent = (c, subjectId, req) => c.query(
  'SELECT * FROM comp_check_consents WHERE subject_id=$1 AND requirement_id=$2 AND statement_version=$3 AND withdrawn_at IS NULL ORDER BY given_at DESC LIMIT 1', [subjectId, req.id, req.version]).then((r) => r.rows[0] ?? null);

// ---------------------------------------------------------------- consent
cap({
  name: 'record_background_check_consent', method: 'POST', path: '/compliance/background-checks/consent', tag: TAG, status: 201,
  summary: 'Give consent for a background check against the current version of a background-check requirement (the person, or the verified guardian of a young person with the `consent` scope). Consent comes first: no check can be ordered without a current one, and it can be withdrawn at any time. Pass confirm=true to confirm you have read what the check involves.',
  input: z.object({ requirement_id: id, subject_id: id.optional(), confirm: z.literal(true) }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? user.id, req = await checkRequirement(i.requirement_id);
    const by = await consenter(user, sid);
    return tx(async (c) => {
      const row = (await c.query('INSERT INTO comp_check_consents(subject_id, requirement_id, statement_version, given_by) VALUES ($1,$2,$3,$4) RETURNING id, statement_version, given_at', [sid, req.id, req.version, user.id])).rows[0];
      await log(c, { requirement_id: req.id, subject_kind: 'person', subject_id: sid, actor_id: user.id, action: 'check_consent_given', detail: { version: req.version, by } });
      await audit(c, user.id, 'record_background_check_consent', 'comp_check_consents', row.id);
      return { consent_id: row.id, statement_version: row.statement_version, given_at: row.given_at, given_by: by };
    });
  },
});

cap({
  name: 'withdraw_background_check_consent', method: 'POST', path: '/compliance/background-checks/consent/withdraw', tag: TAG,
  summary: 'Withdraw consent for background checks of a requirement (the person, or their guardian). A check already ordered keeps its history; no new check can be ordered until consent is given again.',
  input: z.object({ requirement_id: id, subject_id: id.optional() }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? user.id, req = await checkRequirement(i.requirement_id);
    await consenter(user, sid);
    return tx(async (c) => {
      const n = (await c.query('UPDATE comp_check_consents SET withdrawn_at=now() WHERE subject_id=$1 AND requirement_id=$2 AND withdrawn_at IS NULL', [sid, req.id])).rowCount;
      if (n) { await log(c, { requirement_id: req.id, subject_kind: 'person', subject_id: sid, actor_id: user.id, action: 'check_consent_withdrawn' }); await audit(c, user.id, 'withdraw_background_check_consent', 'comp_check_consents', sid); }
      return { withdrawn: n };
    });
  },
});

// ---------------------------------------------------------------- start
/** The provider credentials that apply: the requirement's organisation first, then the platform's. Without a provider, every linked one. */
async function credentialsFor(req, provider = null, c = pool) {
  const org = req.scope_kind === 'organisation' ? req.scope_id : null;
  return (await c.query('SELECT * FROM comp_vendor_credentials WHERE ($1::text IS NULL OR provider=$1) AND effective_to IS NULL AND (organisation_id = $2 OR organisation_id IS NULL) ORDER BY organisation_id NULLS LAST, provider', [provider, org])).rows;
}
const credentialFor = async (req, provider, c) => (await credentialsFor(req, provider, c))[0] ?? null;

cap({
  name: 'get_background_check_options', method: 'GET', path: '/compliance/background-checks/options', tag: TAG,
  summary: 'What the person (or their guardian, or a manager of the requirement\'s scope) needs to order a background check: the providers linked for this requirement, whether a current consent exists, and any check already waiting. Contains no credentials and no result.',
  input: z.object({ requirement_id: id, subject_id: id.optional() }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? user.id, req = await checkRequirement(i.requirement_id);
    const access = await holderAccess(user, 'person', sid);
    if (!access && !(await manages(user, req.scope_kind, req.scope_id, { write: true }))) throw notFound('Person');
    const providers = (await credentialsFor(req)).map((r) => adapterFor(r.provider)).filter(Boolean).map((a) => ({ provider: a.kind, label: a.label }));
    const consent = await currentConsent(pool, sid, req);
    const open = await one("SELECT id FROM comp_records WHERE requirement_id=$1 AND subject_kind='person' AND subject_id=$2 AND status='submitted' AND EXISTS (SELECT 1 FROM comp_check_vendor v WHERE v.record_id=comp_records.id)", [req.id, sid]);
    return { requirement: { id: req.id, name: req.name, version: req.version }, providers: [...new Map(providers.map((p) => [p.provider, p])).values()], consent: consent ? { given_at: consent.given_at, statement_version: consent.statement_version } : null, record_id: open?.id ?? null };
  },
});

cap({
  name: 'start_background_check', method: 'POST', path: '/compliance/background-checks', tag: TAG, status: 201,
  summary: 'Order a background check from a linked provider for a person, against a background-check requirement. Needs a current, unwithdrawn consent (409 `consent_required` otherwise) and is made by the person, their verified guardian, or the scope\'s managers. Only the provider\'s reference and the mapped state (clear / not clear / pending) are stored; a reviewer must still confirm the result with decide_compliance_record before it counts.',
  input: z.object({ requirement_id: id, subject_id: id.optional(), provider: z.string().min(2).max(40).optional() }),
  async handler({ user }, i) {
    const sid = i.subject_id ?? user.id, req = await checkRequirement(i.requirement_id);
    const access = await holderAccess(user, 'person', sid);
    const manager = await manages(user, req.scope_kind, req.scope_id, { write: true });
    if (!access && !manager) throw notFound('Person');
    if (!(await applicable(pool, { kind: 'person', id: sid }, { scope: { kind: req.scope_kind, id: req.scope_id } })).some((o) => o.id === req.id)) throw conflict('This requirement does not apply to them', { code: 'not_required' });
    const consent = await currentConsent(pool, sid, req);
    if (!consent) throw conflict('The person has not consented to this background check (or has withdrawn consent).', { code: 'consent_required' });
    const cred = await credentialFor(req, i.provider ?? null);
    const adapter = cred ? adapterFor(cred.provider) : null;
    if (!adapter) throw conflict('That provider is not linked for this requirement', { code: 'provider_not_linked' });
    const provider = cred.provider;
    if ((await one("SELECT 1 AS x FROM comp_records WHERE requirement_id=$1 AND subject_kind='person' AND subject_id=$2 AND status='submitted'", [req.id, sid]))) throw conflict('There is already a check waiting for review', { code: 'already_submitted' });
    const { decrypt } = await import('../crypto.js');
    const cfg = JSON.parse(decrypt(cred.config_enc, 'comp_vendor_credentials.config'));
    const person = await one('SELECT display_name FROM users WHERE id=$1', [sid]);
    const t = await today();
    // The only thing sent to the provider is our own opaque reference and the name; the provider collects anything else from the person itself.
    const rid = (await one('SELECT gen_random_uuid() AS id')).id;
    let started;
    try { started = await adapter.start({ cfg, reference: rid, name: person.display_name }); }
    catch (e) { if (e instanceof VendorError) throw new AppError(502, 'check_provider_unavailable', e.permanent ? 'The provider refused the request.' : 'The provider could not be reached. Nothing was ordered; try again shortly.', { code: e.code }); throw e; }
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO comp_records(id, requirement_id, requirement_version, subject_kind, subject_id, status, outcome, issued_on, expires_on, provider, reference_enc, submitted_by)
         VALUES ($1,$2,$3,'person',$4,'submitted','pending',$5,$6,$7,$8,$9) RETURNING id`,
        [rid, req.id, req.version, sid, t, req.validity_days ? addDays(t, req.validity_days) : null, provider, encrypt(started.ref, 'comp_records.reference'), user.id])).rows[0];
      await c.query('INSERT INTO comp_check_vendor(record_id, provider, provider_ref_enc, provider_ref_idx, credential_id, consent_id, started_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [row.id, provider, encrypt(started.ref, 'comp_check_vendor.provider_ref'), refIndex(provider, started.ref), cred.id, consent.id, user.id]);
      await log(c, { requirement_id: req.id, record_id: row.id, subject_kind: 'person', subject_id: sid, actor_id: user.id, action: 'check_ordered', detail: { provider } });
      await audit(c, user.id, 'start_background_check', 'comp_records', row.id);
      for (const m of await managerIds(c, req.scope_kind, req.scope_id)) if (m !== user.id) await notify(c, m, { kind: 'compliance_review', title: 'A background check was ordered', body: `${req.name} is with the provider. You will be told when a result is in.`, data: { record_id: row.id }, dedupe_key: `bgcheck-start:${row.id}:${m}` });
      return { record_id: row.id, provider, state: 'pending', status: 'submitted' };
    });
  },
});

// ---------------------------------------------------------------- read (audited)
cap({
  name: 'get_background_check', method: 'GET', path: '/compliance/records/:id/background-check', tag: TAG,
  summary: 'The provider side of a background check: provider, the mapped state (clear / not clear / pending), when it changed, consent, and who confirmed it. Never the provider\'s report, which is not stored. Visible to the person, a verified guardian and the scope\'s managers; every read is audit-logged and written to the record history. Anyone else gets a 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT k.id, k.requirement_id, k.subject_kind, k.subject_id, k.status, k.outcome, q.scope_kind, q.scope_id FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.id=$1', [i.id]);
    const v = r ? await one('SELECT v.*, c.given_at AS consent_at, c.statement_version, c.given_by FROM comp_check_vendor v JOIN comp_check_consents c ON c.id=v.consent_id WHERE v.record_id=$1', [i.id]) : null;
    if (!r || !v) throw notFound('Background check');
    const own = await holderAccess(user, r.subject_kind, r.subject_id);
    const mgr = await manages(user, r.scope_kind, r.scope_id);
    if (!own && !mgr) throw notFound('Background check');
    await audit(null, user.id, 'read_background_check', 'comp_records', r.id);
    await log(pool, { requirement_id: r.requirement_id, record_id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, actor_id: user.id, action: 'background_check_read' });
    return {
      record_id: r.id, provider: v.provider, state: v.state, record_status: r.status, outcome: r.outcome, started_at: v.started_at, state_changed_at: v.state_changed_at, last_polled_at: v.last_polled_at,
      consent: { given_at: v.consent_at, statement_version: v.statement_version }, confirmed_at: v.confirmed_at, confirmed: !!v.confirmed_at,
      awaiting_review: r.status === 'submitted' && v.state !== 'pending', can_confirm: !!mgr && r.status === 'submitted' && !!own === false,
      ...(mgr ? { last_error_code: v.last_error_code } : {}),
    };
  },
});

// ---------------------------------------------------------------- providers
cap({
  name: 'link_background_check_provider', method: 'POST', path: '/compliance/background-providers', tag: TAG, status: 201,
  summary: 'Link (or rotate) a background-check provider for an organisation you run (owner/admin), or for the whole platform (platform admin). Credentials are encrypted and write-only; linking again closes the previous credentials (kept as history). Returns the webhook path the provider should call; the provider signs each call with HMAC-SHA256 of the body in `x-signature` using the webhook secret.',
  input: z.object({ provider: z.string().min(2).max(40), organisation_id: id.optional(), config: z.record(z.string(), z.string().max(500)) }),
  async handler({ user }, i) {
    if (i.organisation_id ? !['owner', 'admin'].includes(await orgRole(user, i.organisation_id)) && !isAdmin(user) : !isAdmin(user)) throw i.organisation_id ? notFound('Organisation') : forbidden('Only the platform team links a platform-wide provider');
    const adapter = adapterFor(i.provider);
    if (!adapter) throw badRequest(`Unknown provider. Available: ${availableKinds().map((k) => k.kind).join(', ')}`);
    const f = CONFIG_FIELDS[i.provider], missing = f.required.filter((k) => !i.config[k]?.trim());
    if (missing.length) throw badRequest(`Provider settings are incomplete. Needed: ${f.required.join(', ')}`);
    const cfg = Object.fromEntries([...f.required, ...f.optional].filter((k) => i.config[k] !== undefined).map((k) => [k, i.config[k].trim()]));
    if (cfg.base_url) assertPublicHttpsUrl(cfg.base_url, 'The provider URL');
    return tx(async (c) => {
      await c.query('UPDATE comp_vendor_credentials SET effective_to=now() WHERE provider=$1 AND organisation_id IS NOT DISTINCT FROM $2 AND effective_to IS NULL', [i.provider, i.organisation_id ?? null]);
      const row = (await c.query('INSERT INTO comp_vendor_credentials(organisation_id, provider, config_enc, created_by) VALUES ($1,$2,$3,$4) RETURNING id, organisation_id, provider, effective_from',
        [i.organisation_id ?? null, i.provider, encrypt(JSON.stringify(cfg), 'comp_vendor_credentials.config'), user.id])).rows[0];
      await audit(c, user.id, 'link_background_check_provider', 'comp_vendor_credentials', row.id);
      return { ...row, webhook_path: `/api/v1/webhooks/background-checks/${row.id}` };
    });
  },
});

cap({
  name: 'list_background_check_providers', method: 'GET', path: '/compliance/background-providers', tag: TAG,
  summary: 'The providers that can be linked, and which are linked for the platform and for an organisation you run (pass organisation_id). Credentials are never returned.',
  input: z.object({ organisation_id: id.optional() }),
  async handler({ user }, i) {
    if (i.organisation_id && !['owner', 'admin'].includes(await orgRole(user, i.organisation_id)) && !isAdmin(user)) throw notFound('Organisation');
    const linked = await many('SELECT id, organisation_id, provider, effective_from FROM comp_vendor_credentials WHERE effective_to IS NULL AND (organisation_id IS NULL OR organisation_id = $1) ORDER BY organisation_id NULLS FIRST, provider', [i.organisation_id ?? null]);
    return { available: availableKinds(), linked: linked.map((l) => ({ ...l, level: l.organisation_id ? 'organisation' : 'platform' })) };
  },
});
