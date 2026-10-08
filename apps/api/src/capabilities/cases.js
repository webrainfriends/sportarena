// Support & dispute cases (SPOR-66, 78, 111, 112): one canonical case model. A case references existing records via case_links
// and never copies them. The requester sees the public thread and timeline; internal notes and staff-only events stay with the
// platform team. Every action lands in the append-only case_events timeline. Domain changes (refunds, corrections) are made by
// the owning capability, never from here.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { ACTIVE, CATEGORIES, LINK_TYPES, PRIORITIES, REOPEN_WINDOW_DAYS, SLA_SQL, assertCanLink, prepEvidence, slaDue } from '../cases.js';

const TAG = 'Support & Disputes';
const KINDS = ['support', 'dispute'];
const ALL_CATEGORIES = [...new Set(Object.values(CATEGORIES).flat())];
const evidenceIn = z.object({
  label: z.string().max(120).optional(),
  reference: z.string().min(2).max(500).optional().describe('https link or reference number'),
  file_name: z.string().max(120).optional(), data: z.string().max(7_200_000).optional().describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB'),
}).refine((e) => e.reference || e.data, 'Give a reference or attach a file');
const linkIn = z.object({ type: z.enum(LINK_TYPES), id });
const details = z.object({
  disputed_amount_cents: z.coerce.number().int().min(0).optional(), currency: z.string().length(3).optional(),
  contested_field: z.string().max(80).optional(), claimed_value: z.string().max(200).optional(),
}).strict().describe('structured, non-personal facts for disputes');

const COLS = `c.id, c.case_no, c.kind, c.category, c.priority, c.status, c.subject, c.requester_id, c.assignee_id, c.contact_channel, c.details,
  c.resolution, c.resolved_at, c.escalated_at, c.first_response_due, c.resolution_due, c.first_responded_at, c.created_at, c.updated_at, ${SLA_SQL} AS sla_state`;

const logEvent = (c, caseId, actor, action, from, to, reason, { data = {}, visibility = 'public' } = {}) => c.query(
  'INSERT INTO case_events(case_id, actor_id, action, from_status, to_status, reason, data, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
  [caseId, actor, action, from, to, reason ?? null, JSON.stringify(data), visibility]);
const addMessage = (c, caseId, author, visibility, body, kind = 'message') => c.query(
  'INSERT INTO case_messages(case_id, author_id, visibility, kind, body_enc) VALUES ($1,$2,$3,$4,$5)', [caseId, author, visibility, kind, encrypt(body, 'case_messages.body')]);
const lockCase = async (c, caseId) => {
  const row = (await c.query('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!row) throw notFound('Case');
  return row;
};
const adminIds = async (c) => (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows.map((r) => r.id);
const ownCase = async (c, user, caseId) => {
  const row = await lockCase(c, caseId);
  if (row.requester_id !== user.id) throw notFound('Case');
  return row;
};
/** Platform-team actions: a team member cannot work a case they raised themselves. */
const staffCase = async (c, user, caseId) => {
  const row = await lockCase(c, caseId);
  if (row.requester_id === user.id) throw forbidden('Another platform team member must handle your own case');
  return row;
};
const saveEvidence = (c, caseId, userId, items) => Promise.all(items.map((p) => c.query(
  'INSERT INTO case_evidence(case_id, label, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [caseId, p.label, p.reference_enc, p.file_name, p.content_type, p.size_bytes, p.sha256, p.file_enc, userId])));
const tell = (c, userId, caseRow, title, body) => notify(c, userId, { kind: 'case_update', title, body, data: { case_id: caseRow.id, case_no: caseRow.case_no } });

// ------------------------------------------------------------------ requester side
cap({
  name: 'list_case_categories', method: 'GET', path: '/cases/categories', tag: TAG, auth: 'public',
  summary: 'Case kinds, their categories, priorities, the record types a case can link to and the response targets (hours) by priority.',
  handler: async () => ({ kinds: CATEGORIES, priorities: PRIORITIES, link_types: LINK_TYPES, reopen_window_days: REOPEN_WINDOW_DAYS,
    sla_hours: Object.fromEntries(PRIORITIES.map((p) => [p, { first_response: slaDue(p, 0).first.getTime() / 36e5, resolution: slaDue(p, 0).resolution.getTime() / 36e5 }])) }),
});

cap({
  name: 'open_case', method: 'POST', path: '/cases', tag: TAG, status: 201,
  summary: 'Raise a support ticket (kind=support) or a dispute (kind=dispute). Link the booking/payment/event/game it is about instead of retyping it; a dispute must link at least one record you are party to. Returns the case number and status. Do not put passwords or card numbers in the text.',
  input: z.object({
    kind: z.enum(KINDS).default('support'), category: z.enum(ALL_CATEGORIES), subject: z.string().min(3).max(160), description: z.string().min(5).max(4000),
    priority: z.enum(['low', 'normal', 'high']).default('normal').describe('a hint; the platform team can change it'),
    contact_channel: z.enum(['in_app', 'email', 'push']).default('in_app'),
    links: z.array(linkIn).max(5).default([]), evidence: z.array(evidenceIn).max(5).default([]), details: details.optional(),
  }),
  async handler({ user }, i) {
    if (!CATEGORIES[i.kind].includes(i.category)) throw badRequest(`Category ${i.category} is not valid for a ${i.kind}`);
    if (i.kind === 'dispute' && !i.links.length) throw badRequest('A dispute must link the record it is about');
    if (i.details && i.kind !== 'dispute') throw badRequest('Structured details are only for disputes');
    for (const l of i.links) await assertCanLink(user, l.type, l.id);
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      if (i.kind === 'dispute') for (const l of i.links) {
        const dup = (await c.query(`SELECT c.case_no FROM cases c JOIN case_links l ON l.case_id=c.id WHERE c.kind='dispute' AND c.requester_id=$1 AND l.entity_type=$2 AND l.entity_id=$3 AND c.status = ANY($4)`, [user.id, l.type, l.id, ACTIVE])).rows[0];
        if (dup) throw conflict(`You already have an open dispute (#${dup.case_no}) about this ${l.type.replace(/_/g, ' ')}`);
      }
      const due = slaDue(i.priority);
      const row = (await c.query(
        `INSERT INTO cases(kind, category, priority, subject, requester_id, contact_channel, details, first_response_due, resolution_due) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, case_no, kind, category, priority, status, subject, first_response_due, resolution_due, created_at`,
        [i.kind, i.category, i.priority, i.subject, user.id, i.contact_channel, JSON.stringify(i.details ?? {}), due.first, due.resolution])).rows[0];
      for (const l of i.links) await c.query('INSERT INTO case_links(case_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, l.type, l.id]);
      await addMessage(c, row.id, user.id, 'public', i.description);
      await saveEvidence(c, row.id, user.id, prepared);
      await logEvent(c, row.id, user.id, 'open', null, 'open', null, { data: { links: i.links.length, evidence: prepared.length } });
      for (const a of await adminIds(c)) if (a !== user.id) await tell(c, a, row, `New ${i.kind} #${row.case_no}`, `${i.category.replace(/_/g, ' ')} · ${i.priority}`);
      return row;
    });
  },
});

cap({
  name: 'list_my_cases', method: 'GET', path: '/me/cases', tag: TAG,
  summary: 'Your support tickets and disputes, newest first, with status and response targets.',
  input: z.object({ kind: z.enum(KINDS).optional(), status: z.enum(['open', 'in_progress', 'awaiting_user', 'escalated', 'resolved', 'withdrawn', 'active']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${COLS} FROM cases c WHERE c.requester_id=$1 AND ($2::text IS NULL OR c.kind=$2)
       AND ($3::text IS NULL OR c.status=$3 OR ($3='active' AND c.status = ANY($4))) ORDER BY c.created_at DESC LIMIT $5 OFFSET $6`,
    [user.id, i.kind ?? null, i.status ?? null, ACTIVE, i.limit, i.offset]),
});

cap({
  name: 'get_case', method: 'GET', path: '/cases/:id', tag: TAG,
  summary: 'One case with its linked record references, the thread, evidence metadata and timeline. The requester sees only the public thread and public timeline; the platform team also sees internal notes and staff-only events (their read is audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one(`SELECT ${COLS} FROM cases c WHERE c.id=$1`, [i.id]);
    const staff = isAdmin(user) && row && row.requester_id !== user.id;
    if (!row || (row.requester_id !== user.id && !isAdmin(user))) throw notFound('Case');
    const vis = staff ? ['public', 'internal'] : ['public'];
    const [links, messages, evidence, history, people] = await Promise.all([
      many('SELECT entity_type, entity_id FROM case_links WHERE case_id=$1 ORDER BY created_at', [i.id]),
      many('SELECT m.id, m.visibility, m.kind, m.body_enc, m.created_at, m.author_id, u.display_name AS author FROM case_messages m JOIN users u ON u.id=m.author_id WHERE m.case_id=$1 AND m.visibility = ANY($2) ORDER BY m.created_at, m.id', [i.id, vis]),
      many('SELECT id, label, file_name, content_type, size_bytes, created_at, (reference_enc IS NOT NULL) AS has_reference FROM case_evidence WHERE case_id=$1 ORDER BY created_at', [i.id]),
      many('SELECT e.action, e.from_status, e.to_status, e.reason, e.visibility, e.data, e.created_at, u.display_name AS actor FROM case_events e JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 AND e.visibility = ANY($2) ORDER BY e.created_at, e.id', [i.id, vis]),
      many('SELECT id, display_name FROM users WHERE id = ANY($1)', [[row.requester_id, row.assignee_id].filter(Boolean)]),
    ]);
    if (staff) await audit(null, user.id, 'read_case', 'cases', i.id);
    const name = (uid) => people.find((p) => p.id === uid)?.display_name ?? null;
    return {
      ...row, requester: name(row.requester_id), assignee: name(row.assignee_id), links, evidence,
      thread: messages.map(({ body_enc, ...m }) => ({ ...m, body: decrypt(body_enc, 'case_messages.body') })),
      history: staff ? history : history.map(({ data, visibility, ...h }) => h),
    };
  },
});

cap({
  name: 'reply_case', method: 'POST', path: '/cases/:id/replies', tag: TAG, status: 201,
  summary: 'Add a reply (and optionally evidence) to your own open case, for example to answer a request for information.',
  input: z.object({ id, body: z.string().min(1).max(4000), evidence: z.array(evidenceIn).max(5).default([]) }),
  async handler({ user }, i) {
    const prepared = i.evidence.map(prepEvidence);
    return tx(async (c) => {
      const row = await ownCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict(row.status === 'resolved' ? 'This case is resolved. Reopen it to add more.' : 'This case is closed');
      await addMessage(c, row.id, user.id, 'public', i.body);
      await saveEvidence(c, row.id, user.id, prepared);
      const to = row.status === 'awaiting_user' ? 'in_progress' : row.status;
      await c.query('UPDATE cases SET status=$2, updated_at=now() WHERE id=$1', [row.id, to]);
      await logEvent(c, row.id, user.id, 'reply', row.status, to, null, { data: { evidence: prepared.length } });
      if (row.assignee_id) await tell(c, row.assignee_id, row, `Reply on case #${row.case_no}`, 'The requester replied.');
      return { id: row.id, status: to };
    });
  },
});

cap({
  name: 'withdraw_case', method: 'POST', path: '/cases/:id/withdraw', tag: TAG,
  summary: 'Withdraw your open case. The case and its history are kept.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await ownCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict('Only an open case can be withdrawn');
      await c.query("UPDATE cases SET status='withdrawn', updated_at=now() WHERE id=$1", [row.id]);
      await logEvent(c, row.id, user.id, 'withdraw', row.status, 'withdrawn', i.reason);
      return { id: row.id, status: 'withdrawn' };
    });
  },
});

cap({
  name: 'reopen_case', method: 'POST', path: '/cases/:id/reopen', tag: TAG,
  summary: `Reopen your resolved case within ${REOPEN_WINDOW_DAYS} days of the resolution, saying what is still wrong. Response targets restart.`,
  input: z.object({ id, reason: z.string().min(5).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await ownCase(c, user, i.id);
      if (row.status !== 'resolved') throw conflict('Only a resolved case can be reopened');
      if (new Date(row.resolved_at).getTime() < Date.now() - REOPEN_WINDOW_DAYS * 864e5) throw conflict(`Cases can only be reopened within ${REOPEN_WINDOW_DAYS} days. Please open a new case and link this one in the description.`);
      const due = slaDue(row.priority);
      await c.query("UPDATE cases SET status='open', resolution=NULL, resolved_by=NULL, resolved_at=NULL, first_responded_at=NULL, first_response_due=$2, resolution_due=$3, updated_at=now() WHERE id=$1", [row.id, due.first, due.resolution]);
      await addMessage(c, row.id, user.id, 'public', i.reason);
      await logEvent(c, row.id, user.id, 'reopen', 'resolved', 'open', i.reason);
      if (row.assignee_id) await tell(c, row.assignee_id, row, `Case #${row.case_no} reopened`, 'The requester reopened this case.');
      return { id: row.id, status: 'open' };
    });
  },
});

// ------------------------------------------------------------------ platform team
cap({
  name: 'list_case_queue', method: 'GET', path: '/admin/cases', tag: TAG, auth: ['admin'],
  summary: 'Platform team: the case queue. Filter by status (`active` = everything not resolved/withdrawn), kind, category, priority, SLA state (breached / at_risk / ok), assignee (me / unassigned / a user id) and free text (subject or case number). Most urgent first.',
  input: z.object({
    status: z.enum(['active', 'open', 'in_progress', 'awaiting_user', 'escalated', 'resolved', 'withdrawn']).default('active'), kind: z.enum(KINDS).optional(),
    category: z.enum(ALL_CATEGORIES).optional(), priority: z.enum(PRIORITIES).optional(), sla: z.enum(['breached', 'at_risk', 'ok']).optional(),
    assignee: z.string().max(40).optional(), q: z.string().max(100).optional(), ...page,
  }),
  async handler({ user }, i) {
    if (i.assignee && !['me', 'unassigned'].includes(i.assignee) && !id.safeParse(i.assignee).success) throw badRequest('assignee must be me, unassigned or a user id');
    const q = i.q?.trim();
    return many(
      `SELECT * FROM (SELECT ${COLS}, r.display_name AS requester, a.display_name AS assignee, (SELECT count(*)::int FROM case_links l WHERE l.case_id=c.id) AS link_count
          FROM cases c JOIN users r ON r.id=c.requester_id LEFT JOIN users a ON a.id=c.assignee_id
         WHERE (c.status=$1 OR ($1='active' AND c.status = ANY($2))) AND ($3::text IS NULL OR c.kind=$3) AND ($4::text IS NULL OR c.category=$4) AND ($5::text IS NULL OR c.priority=$5)
           AND (CASE WHEN $6::text IS NULL THEN true WHEN $6='me' THEN c.assignee_id=$7 WHEN $6='unassigned' THEN c.assignee_id IS NULL ELSE c.assignee_id::text=$6 END)
           AND ($8::text IS NULL OR c.subject ILIKE '%' || $8 || '%' OR c.case_no::text = $8)) q
        WHERE ($9::text IS NULL OR q.sla_state=$9)
        ORDER BY CASE q.sla_state WHEN 'breached' THEN 0 WHEN 'at_risk' THEN 1 ELSE 2 END, CASE q.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, q.created_at LIMIT $10 OFFSET $11`,
      [i.status, ACTIVE, i.kind ?? null, i.category ?? null, i.priority ?? null, i.assignee ?? null, user.id, q ? q.replace(/[%_\\]/g, '\\$&') : null, i.sla ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'triage_case', method: 'POST', path: '/admin/cases/:id/triage', tag: TAG, auth: ['admin'],
  summary: 'Platform team: assign a case (to yourself by default) and/or change its priority or category. A priority change restarts the response targets from the case creation time.',
  input: z.object({ id, assignee_id: id.optional(), priority: z.enum(PRIORITIES).optional(), category: z.enum(ALL_CATEGORIES).optional(), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await staffCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict(`Case is ${row.status}`);
      const assignee = i.assignee_id ?? (row.assignee_id ? undefined : user.id);
      if (assignee) {
        const a = (await c.query("SELECT id FROM users WHERE id=$1 AND 'admin' = ANY(roles)", [assignee])).rows[0];
        if (!a) throw badRequest('Cases can only be assigned to platform team members');
        if (assignee === row.requester_id) throw badRequest('A case cannot be assigned to its requester');
      }
      if (i.category && !CATEGORIES[row.kind].includes(i.category)) throw badRequest(`Category ${i.category} is not valid for a ${row.kind}`);
      const priority = i.priority ?? row.priority, due = slaDue(priority, new Date(row.created_at).getTime());
      const to = row.status === 'open' ? 'in_progress' : row.status;
      await c.query('UPDATE cases SET assignee_id=coalesce($2,assignee_id), priority=$3, category=coalesce($4,category), status=$5, first_response_due=$6, resolution_due=$7, updated_at=now() WHERE id=$1',
        [row.id, assignee ?? null, priority, i.category ?? null, to, due.first, due.resolution]);
      await logEvent(c, row.id, user.id, 'triage', row.status, to, i.reason, { visibility: 'internal', data: { assignee_id: assignee ?? row.assignee_id, priority, category: i.category ?? row.category } });
      return { id: row.id, status: to, assignee_id: assignee ?? row.assignee_id, priority };
    });
  },
});

cap({
  name: 'respond_case', method: 'POST', path: '/admin/cases/:id/respond', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: reply to the requester in the visible thread. `request_info=true` also asks them for more information and parks the case as awaiting_user. The first reply stops the first-response clock.',
  input: z.object({ id, body: z.string().min(1).max(4000), request_info: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await staffCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict(`Case is ${row.status}`);
      const to = i.request_info ? 'awaiting_user' : row.status === 'open' ? 'in_progress' : row.status;
      await addMessage(c, row.id, user.id, 'public', i.body, i.request_info ? 'info_request' : 'message');
      await c.query('UPDATE cases SET status=$2, assignee_id=coalesce(assignee_id,$3), first_responded_at=coalesce(first_responded_at, now()), updated_at=now() WHERE id=$1', [row.id, to, user.id]);
      await logEvent(c, row.id, user.id, i.request_info ? 'request_info' : 'respond', row.status, to);
      await tell(c, row.requester_id, row, i.request_info ? `More information needed on case #${row.case_no}` : `New reply on case #${row.case_no}`, 'Open the case to read it.');
      return { id: row.id, status: to };
    });
  },
});

cap({
  name: 'add_internal_note', method: 'POST', path: '/admin/cases/:id/notes', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: add a note only the platform team can see. It is never shown to the requester.',
  input: z.object({ id, body: z.string().min(1).max(4000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await staffCase(c, user, i.id);
      await addMessage(c, row.id, user.id, 'internal', i.body);
      await logEvent(c, row.id, user.id, 'internal_note', row.status, row.status, null, { visibility: 'internal' });
      return { id: row.id };
    });
  },
});

cap({
  name: 'escalate_case', method: 'POST', path: '/admin/cases/:id/escalate', tag: TAG, auth: ['admin'],
  summary: 'Platform team: escalate a case to another platform team member (raises priority to at least high and restarts the targets). A reason is required.',
  input: z.object({ id, assignee_id: id.optional(), reason: z.string().min(5).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await staffCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict(`Case is ${row.status}`);
      if (i.assignee_id) {
        const a = (await c.query("SELECT id FROM users WHERE id=$1 AND 'admin' = ANY(roles)", [i.assignee_id])).rows[0];
        if (!a || a.id === row.requester_id) throw badRequest('Escalate to another platform team member');
      }
      const priority = ['high', 'urgent'].includes(row.priority) ? row.priority : 'high', due = slaDue(priority);
      await c.query("UPDATE cases SET status='escalated', priority=$2, assignee_id=coalesce($3,assignee_id), escalated_at=now(), resolution_due=$4, updated_at=now() WHERE id=$1", [row.id, priority, i.assignee_id ?? null, due.resolution]);
      await logEvent(c, row.id, user.id, 'escalate', row.status, 'escalated', i.reason, { data: { assignee_id: i.assignee_id ?? row.assignee_id, priority } });
      if (i.assignee_id) await tell(c, i.assignee_id, row, `Case #${row.case_no} escalated to you`, i.reason);
      await tell(c, row.requester_id, row, `Case #${row.case_no} escalated`, 'Your case has been escalated for priority handling.');
      return { id: row.id, status: 'escalated', priority };
    });
  },
});

cap({
  name: 'resolve_case', method: 'POST', path: '/admin/cases/:id/resolve', tag: TAG, auth: ['admin'],
  summary: 'Platform team: mark a case resolved with the outcome the requester will see. Money or record changes are made first through the owning capability (for example the refund or booking actions) and then referenced here with `action_ref`; this endpoint changes nothing else.',
  input: z.object({ id, resolution: z.string().min(5).max(2000), action_ref: z.string().max(200).optional().describe('reference returned by the domain action that was taken') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await staffCase(c, user, i.id);
      if (!ACTIVE.includes(row.status)) throw conflict(`Case is ${row.status}`);
      await c.query("UPDATE cases SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), assignee_id=coalesce(assignee_id,$3), first_responded_at=coalesce(first_responded_at, now()), updated_at=now() WHERE id=$1", [row.id, i.resolution, user.id]);
      await logEvent(c, row.id, user.id, 'resolve', row.status, 'resolved', i.resolution, { data: i.action_ref ? { action_ref: i.action_ref } : {} });
      await tell(c, row.requester_id, row, `Case #${row.case_no} resolved`, i.resolution);
      return { id: row.id, status: 'resolved' };
    });
  },
});

cap({
  name: 'get_case_evidence', method: 'GET', path: '/admin/cases/:id/evidence', tag: TAG, auth: ['admin'],
  summary: 'Platform team: decrypted evidence references (and one file, by evidence_id) for a case. Every read is audit-logged. You cannot read evidence on your own case.',
  input: z.object({ id, evidence_id: id.optional().describe('include the file contents of this item (base64)') }),
  async handler({ user }, i) {
    const cs = await one('SELECT id, requester_id FROM cases WHERE id=$1', [i.id]);
    if (!cs) throw notFound('Case');
    if (cs.requester_id === user.id) throw forbidden('Another platform team member must handle your own case');
    const rows = await many('SELECT id, label, reference_enc, file_name, content_type, size_bytes, sha256, created_at, file_enc FROM case_evidence WHERE case_id=$1 ORDER BY created_at', [i.id]);
    await audit(null, user.id, 'read_case_evidence', 'cases', i.id);
    return rows.map((r) => ({
      id: r.id, label: r.label, reference: r.reference_enc ? decrypt(r.reference_enc, 'case_evidence.reference') : null,
      file_name: r.file_name, content_type: r.content_type, size_bytes: r.size_bytes, sha256: r.sha256, created_at: r.created_at,
      ...(i.evidence_id === r.id && r.file_enc ? { data: decrypt(r.file_enc, 'case_evidence.file') } : {}),
    }));
  },
});
