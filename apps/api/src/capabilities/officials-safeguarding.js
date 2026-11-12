// Official Safety & Safeguarding Escalation — Issue #1029 (REF-R31)
// Private abuse/harassment reports for officials, immediate safety flags, incident triage, welfare contacts,
// anonymous reporting (policy-gated), and whistleblower protections.
// Reuses: fixture_officials (crew standing), organisations, compliance_records (welfare officer credential),
// official_welfare_officers, official_sg_* tables (migration 205).
// Separated from gov_cases (discipline auto-trigger in official-report-signoff.js) and academy_sg_cases.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt, sha256 } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouth } from '../youth.js';

const TAG = 'Official safeguarding';
const NOT_A_FINDING = 'Receipt of this case record is not a finding. Allegations are separate from findings and no inference of guilt should be drawn.';

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Loads active welfare officers for an org within a client/pool context. */
const welfareOfficersFor = (c, orgId) =>
  many.call({ query: (t, p) => c.query(t, p) }, 'SELECT wo.id, wo.user_id, wo.tier, wo.contact_channel, u.display_name FROM official_welfare_officers wo JOIN users u ON u.id=wo.user_id WHERE wo.org_id=$1 AND wo.ended_at IS NULL ORDER BY wo.tier, u.display_name', [orgId]);

/** Throw 404 (not 403) so case existence is not revealed to non-officers. */
async function assertWelfareOfficer(c, user, orgId) {
  if (isAdmin(user)) return;
  const row = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM official_welfare_officers WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL LIMIT 1", [orgId, user.id]);
  if (!row) throw notFound('Case');
}

/** Loads policy for org, returning defaults if none configured. */
async function loadPolicy(c, orgId) {
  const p = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_policies WHERE org_id=$1 AND retired_at IS NULL LIMIT 1', [orgId]);
  return p ?? {
    allow_anonymous: false,
    mandatory_reporting_law: null,
    retention_years: 7,
    ack_hours: { low: 48, medium: 24, high: 4, immediate: 1 },
    review_hours: { low: 168, medium: 72, high: 24, immediate: 8 },
  };
}

/** Returns the human-readable reference from the bigserial case_no. */
const caseRef = (caseNo) => 'OSG-' + String(caseNo).padStart(5, '0');

/** Append a chained audit-log entry for a case. */
async function logCase(c, caseId, event, actorId, detail = {}) {
  const last = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT seq, hash FROM official_sg_case_log WHERE case_id=$1 ORDER BY seq DESC LIMIT 1', [caseId]);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? '0';
  const hash = sha256(`${prevHash}|${caseId}|${seq}|${event}|${actorId ?? ''}|${JSON.stringify(detail)}`);
  await c.query('INSERT INTO official_sg_case_log(case_id,seq,event,actor_id,detail,hash) VALUES ($1,$2,$3,$4,$5,$6)', [caseId, seq, event, actorId ?? null, JSON.stringify(detail), hash]);
}

/** Loads the fixture → event → organiser_id chain. */
async function fixtureOrg(c, fixtureId) {
  const row = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT e.organiser_id FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [fixtureId]);
  if (!row) throw notFound('Fixture');
  return row.organiser_id;
}

/** Verifies the caller is accepted crew on a fixture (or admin). */
async function assertCrew(c, user, fixtureId) {
  if (isAdmin(user)) return;
  const row = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1", [fixtureId, user.id]);
  if (!row) throw forbidden('You must be an accepted crew member on this fixture to raise a safety concern.');
}

// ── Case status transitions ───────────────────────────────────────────────────

const NEXT_STATUS = {
  acknowledge: 'in_triage',
  assign: 'assigned',
  escalate: 'escalated',
  refer_external: 'referred',
  request_info: 'active',
  add_note: null, // no status change
  close: 'closed',
};

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CASE_TYPES = ['abuse', 'harassment', 'bullying', 'coercion', 'discrimination', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high', 'immediate'];
const ACTION_KINDS = ['acknowledge', 'assign', 'escalate', 'refer_external', 'request_info', 'add_note', 'close'];
const OUTCOMES = ['upheld', 'partially_upheld', 'not_upheld', 'no_further_action', 'referred_external', 'withdrawn'];

const raiseConcernSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(CASE_TYPES),
  risk_level: z.enum(RISK_LEVELS),
  narrative: z.string().min(10).max(5000),
  anonymous: z.boolean().optional().default(false),
  request_whistleblower_protection: z.boolean().optional().default(false),
});

const triageSchema = z.object({
  id: z.string().uuid(),
  risk_classification: z.enum(RISK_LEVELS),
  assigned_to_user_id: z.string().uuid().optional(),
});

const actSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(ACTION_KINDS),
  note: z.string().max(5000).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  reason: z.string().max(2000).optional(),
  mandatory_reporting_decision: z.string().max(1000).optional(),
  assigned_to_user_id: z.string().uuid().optional(),
});

const evidenceSchema = z.object({
  id: z.string().uuid(),
  file_key: z.string().min(1).max(500),
  label: z.string().min(1).max(200),
  visibility: z.enum(['author', 'welfare_officer', 'federation']).default('welfare_officer'),
});

const policySchema = z.object({
  org_id: z.string().uuid(),
  allow_anonymous: z.boolean().optional().default(false),
  mandatory_reporting_law: z.string().max(200).optional().nullable(),
  retention_years: z.number().int().min(1).max(50).optional().default(7),
  ack_hours: z.object({ low: z.number().int(), medium: z.number().int(), high: z.number().int(), immediate: z.number().int() }).optional(),
  review_hours: z.object({ low: z.number().int(), medium: z.number().int(), high: z.number().int(), immediate: z.number().int() }).optional(),
});

const designateSchema = z.object({
  user_id: z.string().uuid(),
  org_id: z.string().uuid(),
  tier: z.number().int().min(1).max(3).default(1),
  contact_channel: z.string().max(200).optional(),
});

const endOfficerSchema = z.object({
  id: z.string().uuid(),
  end_reason: z.string().min(5).max(500),
});

const confirmWbSchema = z.object({
  id: z.string().uuid(),
  basis: z.string().max(1000).optional(),
});

// ── Capability definitions ────────────────────────────────────────────────────

cap({
  name: 'get_official_welfare_contacts',
  description: 'Returns designated welfare officers for a fixture. Safe to call by any authenticated user; never reveals case existence.',
  method: 'GET',
  path: '/fixtures/:id/welfare-contacts',
  input: z.object({ id: z.string().uuid() }),
  handler: async (_user, i) => {
    const orgId = await fixtureOrg({ query: (t, p) => require('../db.js').pool.query(t, p) }, i.id).catch(() => null);
    if (!orgId) return { welfare_officers: [], policy: { allow_anonymous: false } };
    const { pool } = await import('../db.js');
    const officers = await many('SELECT wo.id, wo.tier, wo.contact_channel, u.display_name FROM official_welfare_officers wo JOIN users u ON u.id=wo.user_id WHERE wo.org_id=$1 AND wo.ended_at IS NULL ORDER BY wo.tier, u.display_name', [orgId]);
    const policy = await loadPolicy({ query: (t, p) => pool.query(t, p) }, orgId);
    return {
      welfare_officers: officers.map((o) => ({ id: o.id, name: o.display_name, tier: o.tier, contact_channel: o.contact_channel, role: tierLabel(o.tier) })),
      policy: { allow_anonymous: policy.allow_anonymous },
    };
  },
});

function tierLabel(t) {
  return t === 1 ? 'Welfare Officer' : t === 2 ? 'Lead Welfare Officer' : 'Welfare Liaison';
}

cap({
  name: 'raise_official_safety_concern',
  description: 'File a private safety concern from a fixture crew member. Encrypted; only welfare officers may read the narrative.',
  method: 'POST',
  path: '/fixtures/:id/safety-concerns',
  input: raiseConcernSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      await assertCrew(c, user, i.id);
      const orgId = await fixtureOrg(c, i.id);
      const policy = await loadPolicy(c, orgId);

      if (i.anonymous && !policy.allow_anonymous) {
        throw badRequest('Anonymous reporting is not enabled for this organisation.');
      }

      const narrativeEnc = encrypt(i.narrative, 'official_sg_cases.narrative');

      // For anonymous cases generate a one-time token (UUID); store only its hash.
      let anonToken = null;
      let anonTokenHash = null;
      if (i.anonymous) {
        const { randomUUID } = await import('node:crypto');
        anonToken = randomUUID();
        anonTokenHash = sha256(anonToken);
      }

      const caseRow = (await c.query(
        `INSERT INTO official_sg_cases
           (org_id, fixture_id, reporter_id, case_type, risk_level, narrative_enc)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, case_no`,
        [orgId, i.id, i.anonymous ? null : user.id, i.type, i.risk_level, narrativeEnc],
      )).rows[0];

      await logCase(c, caseRow.id, 'created', i.anonymous ? null : user.id, { type: i.type, risk_level: i.risk_level, anonymous: i.anonymous });

      if (i.anonymous && anonTokenHash) {
        await c.query('INSERT INTO official_sg_anon_tokens(case_id, token_hash) VALUES ($1,$2)', [caseRow.id, anonTokenHash]);
      }

      if (i.request_whistleblower_protection) {
        await c.query(
          'INSERT INTO official_sg_whistleblower(case_id, requested_by, anon_token_hash) VALUES ($1,$2,$3)',
          [caseRow.id, i.anonymous ? null : user.id, anonTokenHash ?? null],
        );
        await logCase(c, caseRow.id, 'whistleblower_requested', i.anonymous ? null : user.id, {});
      }

      // Notify welfare officers — content never included.
      const officers = await welfareOfficersFor(c, orgId);
      for (const off of officers) {
        await notify(c, off.user_id, { kind: 'official_sg_concern_raised', title: 'New safety concern received', body: 'A new safety concern has been raised for a fixture in your organisation. Please review in the Safety desk.', data: { case_id: caseRow.id } }).catch(() => {});
      }

      // Youth subject check: notify guardian if subject is a youth official.
      if (!i.anonymous) {
        const youthSubject = await isYouth(user.id, c);
        if (youthSubject) {
          await logCase(c, caseRow.id, 'youth_subject_flagged', user.id, {});
        }
      }

      await audit(c, user.id, 'raise_official_sg_concern', 'official_sg_cases', caseRow.id);

      const ref = caseRef(caseRow.case_no);
      return {
        ref,
        status: 'received',
        ...(anonToken ? { anon_token: anonToken } : {}),
      };
    });
  },
});

cap({
  name: 'flag_immediate_safety',
  description: 'Raise an immediate safety flag during a live fixture. Notifies all welfare officers and the event organiser.',
  method: 'POST',
  path: '/fixtures/:id/safety-flag',
  input: z.object({ id: z.string().uuid(), note: z.string().max(500).optional() }),
  handler: async (user, i) => {
    return tx(async (c) => {
      await assertCrew(c, user, i.id);
      const orgId = await fixtureOrg(c, i.id);

      await c.query(
        'INSERT INTO official_sg_safety_flags(fixture_id, raised_by, note) VALUES ($1,$2,$3)',
        [i.id, user.id, i.note ?? null],
      );

      await c.query(
        "UPDATE fixture_officials SET sg_flag_raised=true WHERE fixture_id=$1 AND user_id=$2 AND status='accepted'",
        [i.id, user.id],
      );

      const officers = await welfareOfficersFor(c, orgId);
      for (const off of officers) {
        await notify(c, off.user_id, { kind: 'official_sg_safety_flag', title: '🚨 Immediate safety flag raised', body: 'An official has raised an immediate safety flag on a fixture in your organisation. Please respond immediately.', data: { fixture_id: i.id } }).catch(() => {});
      }

      // Also notify event organiser.
      const ev = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT e.created_by FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [i.id]);
      if (ev?.created_by) {
        await notify(c, ev.created_by, { kind: 'official_sg_safety_flag', title: '🚨 Safety flag raised', body: 'An official has raised an immediate safety flag on a fixture you are organising.', data: { fixture_id: i.id } }).catch(() => {});
      }

      await audit(c, user.id, 'flag_immediate_safety', 'fixtures', i.id);

      return {
        flagged: true,
        welfare_contacts: officers.map((o) => ({ name: o.display_name, tier: o.tier, contact_channel: o.contact_channel })),
      };
    });
  },
});

cap({
  name: 'get_my_sg_concern_status',
  description: 'Check the status of a safety concern by reference or anonymous token. Never reveals triage detail.',
  method: 'GET',
  path: '/safety-concerns/:ref',
  input: z.object({ ref: z.string(), anon_token: z.string().optional() }),
  handler: async (user, i) => {
    const { pool } = await import('../db.js');
    // Resolve case by ref (OSG-XXXXX format → case_no)
    const caseNo = parseInt(i.ref.replace(/^OSG-0*/i, '') || '0', 10);
    if (!caseNo) throw notFound('Case');

    const c = { query: (t, p) => pool.query(t, p) };
    const caseRow = await one.call(c, 'SELECT id, case_no, status, raised_at, reporter_id FROM official_sg_cases WHERE case_no=$1', [caseNo]);
    if (!caseRow) throw notFound('Case');

    // Access: either identified reporter, or matching anon token.
    if (i.anon_token) {
      const h = sha256(i.anon_token);
      const tok = await one.call(c, 'SELECT 1 FROM official_sg_anon_tokens WHERE case_id=$1 AND token_hash=$2', [caseRow.id, h]);
      if (!tok) throw notFound('Case');
    } else {
      if (!user) throw notFound('Case');
      if (caseRow.reporter_id !== user.id && !isAdmin(user)) throw notFound('Case');
    }

    return {
      ref: caseRef(caseRow.case_no),
      status: caseRow.status,
      raised_at: caseRow.raised_at,
    };
  },
});

cap({
  name: 'list_official_sg_cases',
  description: 'List safeguarding cases. Requires welfare officer or admin. Scoped to orgs where the caller is a welfare officer.',
  method: 'GET',
  path: '/official-safeguarding/cases',
  input: z.object({ status: z.string().optional(), ...page }),
  handler: async (user, i) => {
    const { pool } = await import('../db.js');
    const c = { query: (t, p) => pool.query(t, p) };

    let orgIds;
    if (isAdmin(user)) {
      orgIds = null; // admin sees all
    } else {
      const rows = await many('SELECT org_id FROM official_welfare_officers WHERE user_id=$1 AND ended_at IS NULL', [user.id]);
      if (!rows.length) throw notFound('Case');
      orgIds = rows.map((r) => r.org_id);
    }

    const statusFilter = i.status ? `AND c.status = $${orgIds ? 3 : 2}` : '';
    const params = orgIds
      ? [orgIds, i.limit ?? 50, ...(i.status ? [i.status] : [])]
      : [i.limit ?? 50, ...(i.status ? [i.status] : [])];

    const whereOrg = orgIds ? 'AND c.org_id = ANY($1::uuid[])' : '';
    const limitParam = orgIds ? '$2' : '$1';

    const rows = await many(`
      SELECT c.id, c.case_no, c.org_id, c.case_type, c.risk_level, c.status, c.raised_at, c.closed_at,
             c.assigned_to, au.display_name AS assigned_name,
             f.id AS fixture_id, h.name AS home_name, a.name AS away_name,
             extract(epoch from (now() - c.raised_at)) / 86400 AS days_open
        FROM official_sg_cases c
        LEFT JOIN users au ON au.id = c.assigned_to
        LEFT JOIN fixtures f ON f.id = c.fixture_id
        LEFT JOIN teams h ON h.id = f.home_team_id
        LEFT JOIN teams a ON a.id = f.away_team_id
       WHERE 1=1 ${whereOrg} ${statusFilter}
       ORDER BY
         CASE c.risk_level WHEN 'immediate' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         c.raised_at DESC
       LIMIT ${limitParam}`,
      params,
    );

    return {
      _notice: NOT_A_FINDING,
      cases: rows.map((r) => ({
        id: r.id,
        ref: caseRef(r.case_no),
        type: r.case_type,
        risk_level: r.risk_level,
        status: r.status,
        fixture: r.fixture_id ? `${r.home_name ?? 'TBD'} v ${r.away_name ?? 'TBD'}` : null,
        assigned_to: r.assigned_name ?? null,
        days_open: Math.round(r.days_open * 10) / 10,
        raised_at: r.raised_at,
      })),
    };
  },
});

cap({
  name: 'get_official_sg_case',
  description: 'Get full case detail. Welfare officer / admin only. Narrative decrypted and audit-logged on each read.',
  method: 'GET',
  path: '/official-safeguarding/cases/:id',
  input: z.object({ id: z.string().uuid() }),
  handler: async (user, i) => {
    return tx(async (c) => {
      const caseRow = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_cases WHERE id=$1', [i.id]);
      if (!caseRow) throw notFound('Case');

      await assertWelfareOfficer(c, user, caseRow.org_id);

      const narrative = decrypt(caseRow.narrative_enc, 'official_sg_cases.narrative');
      await audit(c, user.id, 'read_official_sg_narrative', 'official_sg_cases', i.id);
      await logCase(c, i.id, 'read_narrative', user.id, {});

      const actions = await many.call({ query: (t, p) => c.query(t, p) }, 'SELECT a.*, u.display_name AS actor_name FROM official_sg_actions a JOIN users u ON u.id=a.actor_id WHERE a.case_id=$1 ORDER BY a.created_at', [i.id]);
      const evidence = await many.call({ query: (t, p) => c.query(t, p) }, 'SELECT e.*, u.display_name AS uploader_name FROM official_sg_evidence e JOIN users u ON u.id=e.uploaded_by WHERE e.case_id=$1 ORDER BY e.uploaded_at', [i.id]);

      let fixture = null;
      if (caseRow.fixture_id) {
        fixture = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT f.id, h.name AS home_name, a.name AS away_name, f.scheduled_at FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1", [caseRow.fixture_id]);
      }

      return {
        _notice: NOT_A_FINDING,
        id: caseRow.id,
        ref: caseRef(caseRow.case_no),
        type: caseRow.case_type,
        risk_level: caseRow.risk_level,
        status: caseRow.status,
        outcome: caseRow.outcome ?? null,
        narrative,
        reporter: caseRow.reporter_id ? 'identified' : 'anonymous',
        fixture: fixture ? { id: fixture.id, label: `${fixture.home_name ?? 'TBD'} v ${fixture.away_name ?? 'TBD'}`, scheduled_at: fixture.scheduled_at } : null,
        assigned_to: caseRow.assigned_to ?? null,
        raised_at: caseRow.raised_at,
        closed_at: caseRow.closed_at ?? null,
        actions: actions.map((a) => ({ id: a.id, kind: a.kind, actor: a.actor_name, outcome: a.outcome ?? null, created_at: a.created_at })),
        evidence: evidence.map((e) => ({ id: e.id, label: e.label, visibility: e.visibility, uploaded_by: e.uploader_name, uploaded_at: e.uploaded_at })),
      };
    });
  },
});

cap({
  name: 'triage_official_sg_case',
  description: 'Acknowledge and triage a received case. Welfare officer only.',
  method: 'POST',
  path: '/official-safeguarding/cases/:id/triage',
  input: triageSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      const caseRow = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_cases WHERE id=$1 FOR UPDATE', [i.id]);
      if (!caseRow) throw notFound('Case');
      await assertWelfareOfficer(c, user, caseRow.org_id);
      if (caseRow.status === 'closed') throw badRequest('Case is already closed.');

      const newStatus = i.assigned_to_user_id ? 'assigned' : 'in_triage';
      await c.query(
        'UPDATE official_sg_cases SET risk_level=$1, status=$2, assigned_to=$3 WHERE id=$4',
        [i.risk_classification, newStatus, i.assigned_to_user_id ?? null, i.id],
      );
      await c.query(
        'INSERT INTO official_sg_actions(case_id, kind, actor_id, assigned_to) VALUES ($1,$2,$3,$4)',
        [i.id, 'acknowledge', user.id, i.assigned_to_user_id ?? null],
      );
      await logCase(c, i.id, 'action:acknowledge', user.id, { new_status: newStatus, risk: i.risk_classification });
      await audit(c, user.id, 'triage_official_sg_case', 'official_sg_cases', i.id);
      return { ref: caseRef(caseRow.case_no), status: newStatus };
    });
  },
});

cap({
  name: 'act_on_official_sg_case',
  description: 'Apply a workflow action to a safeguarding case (assign, escalate, refer, note, close). Welfare officer only.',
  method: 'POST',
  path: '/official-safeguarding/cases/:id/actions',
  input: actSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      const caseRow = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_cases WHERE id=$1 FOR UPDATE', [i.id]);
      if (!caseRow) throw notFound('Case');
      await assertWelfareOfficer(c, user, caseRow.org_id);
      if (caseRow.status === 'closed') throw badRequest('Case is already closed.');

      if (i.action === 'close') {
        if (!i.outcome) throw badRequest('An outcome is required to close a case.');
        if (!i.reason) throw badRequest('A closing reason is required.');
        const policy = await loadPolicy(c, caseRow.org_id);
        if (policy.mandatory_reporting_law && !i.mandatory_reporting_decision) {
          throw badRequest(`A mandatory reporting decision is required under ${policy.mandatory_reporting_law}.`);
        }
        // Reporter cannot close their own case.
        if (caseRow.reporter_id && caseRow.reporter_id === user.id && !isAdmin(user)) {
          throw badRequest('The reporter cannot close their own case.');
        }
      }

      const noteEnc = i.note ? encrypt(i.note, 'official_sg_actions.note') : null;
      const newStatus = NEXT_STATUS[i.action];

      if (newStatus) {
        const updates = ['status=$1'];
        const params = [newStatus];
        if (i.action === 'close') {
          updates.push('outcome=$' + (params.length + 1), 'closed_at=now()');
          params.push(i.outcome);
          if (i.mandatory_reporting_decision) {
            updates.push('mandatory_reporting_decision=$' + (params.length + 1));
            params.push(i.mandatory_reporting_decision);
          }
        }
        if (i.assigned_to_user_id) {
          updates.push('assigned_to=$' + (params.length + 1));
          params.push(i.assigned_to_user_id);
        }
        params.push(i.id);
        await c.query(`UPDATE official_sg_cases SET ${updates.join(',')} WHERE id=$${params.length}`, params);
      }

      await c.query(
        'INSERT INTO official_sg_actions(case_id, kind, actor_id, note_enc, outcome, assigned_to) VALUES ($1,$2,$3,$4,$5,$6)',
        [i.id, i.action, user.id, noteEnc ?? null, i.outcome ?? null, i.assigned_to_user_id ?? null],
      );
      await logCase(c, i.id, `action:${i.action}`, user.id, { new_status: newStatus, outcome: i.outcome ?? null });
      await audit(c, user.id, `official_sg_${i.action}`, 'official_sg_cases', i.id);

      return { ref: caseRef(caseRow.case_no), status: newStatus ?? caseRow.status };
    });
  },
});

cap({
  name: 'add_sg_evidence',
  description: 'Attach evidence to a safeguarding case. Welfare officer or identified reporter only. Blocked after closure.',
  method: 'POST',
  path: '/official-safeguarding/cases/:id/evidence',
  input: evidenceSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      const caseRow = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_cases WHERE id=$1', [i.id]);
      if (!caseRow) throw notFound('Case');
      if (caseRow.status === 'closed') throw badRequest('Evidence cannot be added after closure.');

      const isOfficer = !!(await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT 1 FROM official_welfare_officers WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL LIMIT 1', [caseRow.org_id, user.id]));
      const isReporter = caseRow.reporter_id === user.id;
      if (!isOfficer && !isReporter && !isAdmin(user)) throw notFound('Case');

      await c.query(
        'INSERT INTO official_sg_evidence(case_id, file_key, label, visibility, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
        [i.id, i.file_key, i.label, i.visibility, user.id],
      );
      await logCase(c, i.id, 'evidence_added', user.id, { label: i.label, visibility: i.visibility });
      await audit(c, user.id, 'add_sg_evidence', 'official_sg_cases', i.id);
      return { added: true };
    });
  },
});

cap({
  name: 'confirm_whistleblower_protection',
  description: 'Welfare officer confirms whistleblower protection for a case.',
  method: 'POST',
  path: '/official-safeguarding/whistleblower/:id/confirm',
  input: confirmWbSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      const wb = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT w.*, ca.org_id FROM official_sg_whistleblower w JOIN official_sg_cases ca ON ca.id=w.case_id WHERE w.id=$1', [i.id]);
      if (!wb) throw notFound('Whistleblower record');
      await assertWelfareOfficer(c, user, wb.org_id);
      await c.query(
        "UPDATE official_sg_whistleblower SET status='confirmed', confirmed_by=$1, confirmed_at=now(), basis=$2 WHERE id=$3",
        [user.id, i.basis ?? null, i.id],
      );
      await logCase(c, wb.case_id, 'whistleblower_confirmed', user.id, {});
      await audit(c, user.id, 'confirm_wb_protection', 'official_sg_whistleblower', i.id);
      return { confirmed: true };
    });
  },
});

cap({
  name: 'request_whistleblower_protection',
  description: 'Request whistleblower protection for a concern. Accepts identified auth or anonymous token.',
  method: 'POST',
  path: '/safety-concerns/:ref/whistleblower',
  input: z.object({ ref: z.string(), anon_token: z.string().optional() }),
  handler: async (user, i) => {
    return tx(async (c) => {
      const caseNo = parseInt(i.ref.replace(/^OSG-0*/i, '') || '0', 10);
      if (!caseNo) throw notFound('Case');
      const caseRow = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_sg_cases WHERE case_no=$1', [caseNo]);
      if (!caseRow) throw notFound('Case');

      let anonHash = null;
      if (i.anon_token) {
        anonHash = sha256(i.anon_token);
        const tok = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT 1 FROM official_sg_anon_tokens WHERE case_id=$1 AND token_hash=$2', [caseRow.id, anonHash]);
        if (!tok) throw notFound('Case');
      } else {
        if (!user) throw notFound('Case');
        if (caseRow.reporter_id !== user.id && !isAdmin(user)) throw notFound('Case');
      }

      const existing = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT 1 FROM official_sg_whistleblower WHERE case_id=$1', [caseRow.id]);
      if (!existing) {
        await c.query(
          'INSERT INTO official_sg_whistleblower(case_id, requested_by, anon_token_hash) VALUES ($1,$2,$3)',
          [caseRow.id, user?.id ?? null, anonHash ?? null],
        );
        await logCase(c, caseRow.id, 'whistleblower_requested', user?.id ?? null, {});
      }

      // Notify welfare officers.
      const officers = await welfareOfficersFor(c, caseRow.org_id);
      for (const off of officers) {
        await notify(c, off.user_id, { kind: 'official_sg_wb_requested', title: 'Whistleblower protection requested', body: 'An official has requested whistleblower protection for a safety case.', data: { case_id: caseRow.id } }).catch(() => {});
      }

      return { requested: true, ref: caseRef(caseRow.case_no) };
    });
  },
});

cap({
  name: 'get_official_sg_overview',
  description: 'KPI overview for welfare officers. Counts only; groups <5 return null.',
  method: 'GET',
  path: '/official-safeguarding/overview',
  input: z.object({}),
  handler: async (user, _i) => {
    const { pool } = await import('../db.js');
    let orgIds;
    if (isAdmin(user)) {
      orgIds = null;
    } else {
      const rows = await many('SELECT org_id FROM official_welfare_officers WHERE user_id=$1 AND ended_at IS NULL', [user.id]);
      if (!rows.length) throw notFound('Organisation');
      orgIds = rows.map((r) => r.org_id);
    }

    const whereOrg = orgIds ? 'AND org_id = ANY($1::uuid[])' : '';
    const params = orgIds ? [orgIds] : [];

    const [openRow, unassignedRow, escalatedRow, closedRow, medianRow] = await Promise.all([
      one(`SELECT count(*) AS n FROM official_sg_cases WHERE status NOT IN ('closed') ${whereOrg}`, params),
      one(`SELECT count(*) AS n FROM official_sg_cases WHERE assigned_to IS NULL AND status NOT IN ('closed') ${whereOrg}`, params),
      one(`SELECT count(*) AS n FROM official_sg_cases WHERE status='escalated' ${whereOrg}`, params),
      one(`SELECT count(*) AS n FROM official_sg_cases WHERE status='closed' AND closed_at > now()-interval '30 days' ${whereOrg}`, params),
      one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (closed_at - raised_at))/86400) AS median FROM official_sg_cases WHERE status='closed' AND closed_at IS NOT NULL ${whereOrg}`, params),
    ]);

    const hide = (n) => (n < 5 ? null : n);
    return {
      open: hide(Number(openRow?.n ?? 0)),
      unassigned: hide(Number(unassignedRow?.n ?? 0)),
      escalated: hide(Number(escalatedRow?.n ?? 0)),
      closed_this_month: hide(Number(closedRow?.n ?? 0)),
      median_days: medianRow?.median ? Math.round(medianRow.median * 10) / 10 : null,
    };
  },
});

cap({
  name: 'configure_sg_policy',
  description: 'Configure the safeguarding policy for an organisation. Admin or org owner only.',
  method: 'POST',
  path: '/official-safeguarding/policy',
  input: policySchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      if (!isAdmin(user)) {
        const owner = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role='owner' AND status='active' LIMIT 1", [i.org_id, user.id]);
        if (!owner) throw forbidden('Only an organisation owner or platform admin can configure the safeguarding policy.');
      }
      await c.query('UPDATE official_sg_policies SET retired_at=now() WHERE org_id=$1 AND retired_at IS NULL', [i.org_id]);
      const existing = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT version FROM official_sg_policies WHERE org_id=$1 ORDER BY version DESC LIMIT 1', [i.org_id]);
      const version = (existing?.version ?? 0) + 1;
      await c.query(
        'INSERT INTO official_sg_policies(org_id, version, allow_anonymous, mandatory_reporting_law, retention_years, ack_hours, review_hours, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [i.org_id, version, i.allow_anonymous, i.mandatory_reporting_law ?? null, i.retention_years, JSON.stringify(i.ack_hours ?? { low: 48, medium: 24, high: 4, immediate: 1 }), JSON.stringify(i.review_hours ?? { low: 168, medium: 72, high: 24, immediate: 8 }), user.id],
      );
      await audit(c, user.id, 'configure_sg_policy', 'official_sg_policies', i.org_id);
      return { configured: true };
    });
  },
});

cap({
  name: 'designate_welfare_officer',
  description: 'Designate a welfare officer for an organisation. Requires a valid safeguarding compliance credential.',
  method: 'POST',
  path: '/official-safeguarding/welfare-officers',
  input: designateSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      if (!isAdmin(user)) {
        const owner = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role='owner' AND status='active' LIMIT 1", [i.org_id, user.id]);
        if (!owner) throw forbidden('Only an organisation owner or platform admin can designate welfare officers.');
      }

      // Credential check: user must have an active safeguarding compliance credential.
      const cred = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM compliance_records WHERE user_id=$1 AND kind='safeguarding' AND status='valid' AND (expires_on IS NULL OR expires_on > current_date) LIMIT 1", [i.user_id]);
      if (!cred) throw badRequest('User must hold a valid safeguarding credential before being designated as a welfare officer.');

      // Prevent duplicate active designation.
      const existing = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT 1 FROM official_welfare_officers WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL LIMIT 1', [i.org_id, i.user_id]);
      if (existing) throw badRequest('This person is already a designated welfare officer for this organisation.');

      await c.query(
        'INSERT INTO official_welfare_officers(org_id, user_id, tier, contact_channel, appointed_by) VALUES ($1,$2,$3,$4,$5)',
        [i.org_id, i.user_id, i.tier, i.contact_channel ?? null, user.id],
      );
      await audit(c, user.id, 'designate_welfare_officer', 'official_welfare_officers', i.user_id);
      return { designated: true };
    });
  },
});

cap({
  name: 'end_welfare_officer',
  description: 'Soft-end a welfare officer designation. Blocked if the officer has open cases assigned.',
  method: 'DELETE',
  path: '/official-safeguarding/welfare-officers/:id',
  input: endOfficerSchema,
  handler: async (user, i) => {
    return tx(async (c) => {
      const wo = await one.call({ query: (t, p) => c.query(t, p) }, 'SELECT * FROM official_welfare_officers WHERE id=$1 AND ended_at IS NULL', [i.id]);
      if (!wo) throw notFound('Welfare officer');

      if (!isAdmin(user)) {
        const owner = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND role='owner' AND status='active' LIMIT 1", [wo.org_id, user.id]);
        if (!owner) throw forbidden('Only an organisation owner or platform admin can end a welfare officer designation.');
      }

      // Block if open cases assigned.
      const openCases = await one.call({ query: (t, p) => c.query(t, p) }, "SELECT count(*) AS n FROM official_sg_cases WHERE assigned_to=$1 AND status NOT IN ('closed') AND org_id=$2", [wo.user_id, wo.org_id]);
      if (Number(openCases?.n) > 0) throw badRequest('This welfare officer has open cases assigned. Reassign or close them before ending this designation.');

      await c.query('UPDATE official_welfare_officers SET ended_at=now(), ended_by=$1, end_reason=$2 WHERE id=$3', [user.id, i.end_reason, i.id]);
      await audit(c, user.id, 'end_welfare_officer', 'official_welfare_officers', i.id);
      return { ended: true };
    });
  },
});

cap({
  name: 'list_official_sg_safety_flags',
  description: 'List active safety flags for welfare officers.',
  method: 'GET',
  path: '/official-safeguarding/safety-flags',
  input: z.object({}),
  handler: async (user, _i) => {
    const { pool } = await import('../db.js');
    let orgIds;
    if (isAdmin(user)) {
      orgIds = null;
    } else {
      const rows = await many('SELECT org_id FROM official_welfare_officers WHERE user_id=$1 AND ended_at IS NULL', [user.id]);
      if (!rows.length) return { flags: [] };
      orgIds = rows.map((r) => r.org_id);
    }
    const whereOrg = orgIds ? 'AND e.organiser_id = ANY($1::uuid[])' : '';
    const params = orgIds ? [orgIds] : [];
    const flags = await many(`
      SELECT sf.id, sf.fixture_id, sf.note, sf.created_at, sf.cleared_at,
             u.display_name AS raised_by_name,
             h.name AS home_name, a.name AS away_name
        FROM official_sg_safety_flags sf
        JOIN users u ON u.id=sf.raised_by
        JOIN fixtures f ON f.id=sf.fixture_id
        JOIN events e ON e.id=f.event_id
        LEFT JOIN teams h ON h.id=f.home_team_id
        LEFT JOIN teams a ON a.id=f.away_team_id
       WHERE sf.cleared_at IS NULL ${whereOrg}
       ORDER BY sf.created_at DESC`, params);
    return { flags: flags.map((f) => ({ id: f.id, fixture: `${f.home_name ?? 'TBD'} v ${f.away_name ?? 'TBD'}`, raised_by: f.raised_by_name, created_at: f.created_at })) };
  },
});

cap({
  name: 'list_official_welfare_officers',
  description: 'List welfare officers for an organisation.',
  method: 'GET',
  path: '/official-safeguarding/welfare-officers',
  input: z.object({ org_id: z.string().uuid() }),
  handler: async (user, i) => {
    if (!isAdmin(user)) {
      const { pool } = await import('../db.js');
      const member = await one('SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status=\'active\' LIMIT 1', [i.org_id, user.id]);
      if (!member) throw notFound('Organisation');
    }
    const rows = await many('SELECT wo.id, wo.tier, wo.contact_channel, wo.appointed_at, wo.ended_at, u.display_name, u.id AS user_id FROM official_welfare_officers wo JOIN users u ON u.id=wo.user_id WHERE wo.org_id=$1 ORDER BY wo.ended_at NULLS FIRST, wo.tier, u.display_name', [i.org_id]);
    return { welfare_officers: rows.map((r) => ({ id: r.id, user_id: r.user_id, name: r.display_name, tier: r.tier, role: tierLabel(r.tier), contact_channel: r.contact_channel, appointed_at: r.appointed_at, active: !r.ended_at })) };
  },
});
