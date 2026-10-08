// Youth accounts (issue #70): verified guardian relationships, purpose-specific consent, delegated pickup and check-in, age policy.
// A guardian link only becomes active after (1) the other person accepts the invitation, (2) evidence is submitted, (3) an existing
// guardian approves any additional guardian, and (4) the platform team reviews it. Consent is per purpose, expires, and stops counting
// the moment the guardian who gave it is no longer verified. Every state change lands in an append-only history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { prepEvidence } from '../cases.js';
import { canManageTeam } from './teams.js';
import { PURPOSES, RELATIONSHIPS, YOUTH_SQL, getPolicy, guardianLink, guardiansOf, hasConsent, isYouth, refreshYouth, requireConsent } from '../youth.js';

const TAG = 'Youth & guardians';
const DAY = 864e5;
const OPEN = ['invited', 'accepted', 'pending_review', 'active'];

const logLink = (c, linkId, actor, action, from, to, reason) => c.query(
  'INSERT INTO guardian_link_events(link_id, actor_id, action, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)', [linkId, actor, action, from ?? null, to ?? null, reason ?? null]);
const lockLink = async (c, linkId) => {
  const l = (await c.query('SELECT * FROM guardian_links WHERE id=$1 FOR UPDATE', [linkId])).rows[0];
  if (!l) throw notFound('Guardian link');
  return l;
};
/** Links are only visible to the two people in them (and the platform team); anyone else gets "not found". */
const partyLink = async (c, user, linkId) => {
  const l = await lockLink(c, linkId);
  if (!isAdmin(user) && ![l.guardian_id, l.child_id].includes(user.id)) throw notFound('Guardian link');
  return l;
};
/** Move a link to a new status in one statement; `cols` are extra columns to set (bound as parameters). */
const setStatus = async (c, l, actor, action, to, reason, cols = {}) => {
  const keys = Object.keys(cols);
  const row = (await c.query(`UPDATE guardian_links SET status=$2, updated_at=now()${keys.map((k, n) => `, ${k}=$${n + 3}`).join('')} WHERE id=$1 RETURNING *`, [l.id, to, ...keys.map((k) => cols[k])])).rows[0];
  await logLink(c, l.id, actor, action, l.status, to, reason);
  return row;
};
const linkView = (l) => ({
  id: l.id, guardian_id: l.guardian_id, child_id: l.child_id, relationship: l.relationship, status: l.status, requested_by: l.requested_by,
  needs_existing_guardian_approval: !!l.needs_co && !l.co_guardian_ok_at, expires_at: l.expires_at, decided_at: l.decided_at, decision_note: l.decision_note,
  revoked_at: l.revoked_at, created_at: l.created_at, policy_version: l.policy_version,
  guardian: l.guardian_name ? { id: l.guardian_id, display_name: l.guardian_name, avatar_emoji: l.guardian_emoji, avatar_color: l.guardian_color } : undefined,
  child: l.child_name ? { id: l.child_id, display_name: l.child_name, avatar_emoji: l.child_emoji, avatar_color: l.child_color } : undefined,
});
const LINK_SELECT = `SELECT l.*, g.display_name AS guardian_name, g.avatar_emoji AS guardian_emoji, g.avatar_color AS guardian_color,
    u.display_name AS child_name, u.avatar_emoji AS child_emoji, u.avatar_color AS child_color,
    (SELECT count(*) > 0 FROM guardian_links o WHERE o.child_id = l.child_id AND o.id <> l.id AND o.status = 'active' AND o.revoked_at IS NULL) AS needs_co
  FROM guardian_links l JOIN users g ON g.id = l.guardian_id JOIN users u ON u.id = l.child_id`;

// ---- age policy -------------------------------------------------------------------------------------------------------------

const fullLink = async (c, linkId) => linkView((await c.query(`${LINK_SELECT} WHERE l.id=$1`, [linkId])).rows[0]);

cap({
  name: 'get_age_policy', method: 'GET', path: '/youth/policy', tag: TAG, auth: 'public',
  summary: 'The age and consent rules in force for a jurisdiction (independence age, guardian limits, consent and link lifetimes, retention). Operator configuration, not legal advice.',
  input: z.object({ jurisdiction: z.string().max(40).default('default') }),
  handler: (_, i) => getPolicy(i.jurisdiction),
});

cap({
  name: 'set_age_policy', method: 'POST', path: '/youth/policy', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: publish a new version of a jurisdiction\'s age policy. Existing links and consents keep the version they were made under; who counts as youth is re-evaluated for people in that jurisdiction.',
  input: z.object({
    jurisdiction: z.string().min(2).max(40).regex(/^[a-z0-9_-]+$/), independent_age: z.number().int().min(13).max(21), max_guardians: z.number().int().min(1).max(4).default(2),
    link_valid_days: z.number().int().min(30).max(1825).default(730), consent_max_days: z.number().int().min(1).max(730).default(365),
    retention_days: z.number().int().min(30).max(3650).default(365), notes: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    const row = await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`age_policy:${i.jurisdiction}`]);
      // the built-in policy counts as version 1 of 'default'
      const v = (await c.query('SELECT greatest(coalesce(max(version),0), $2::int) + 1 AS v FROM age_policies WHERE jurisdiction=$1', [i.jurisdiction, i.jurisdiction === 'default' ? 1 : 0])).rows[0].v;
      return (await c.query(
        'INSERT INTO age_policies(jurisdiction, version, independent_age, max_guardians, link_valid_days, consent_max_days, retention_days, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [i.jurisdiction, v, i.independent_age, i.max_guardians, i.link_valid_days, i.consent_max_days, i.retention_days, i.notes ?? null, user.id])).rows[0];
    });
    const people = await many('SELECT id FROM users WHERE jurisdiction=$1 AND dob_enc IS NOT NULL', [i.jurisdiction]);
    for (const p of people) await refreshYouth(p.id, user.id);
    return { ...row, re_evaluated: people.length };
  },
});

cap({
  name: 'set_user_jurisdiction', method: 'PATCH', path: '/youth/users/:user_id/jurisdiction', tag: TAG, auth: ['admin'],
  summary: 'Platform team: assign the jurisdiction whose age policy applies to a person (exceptional / manual review). Re-evaluates whether they are youth.',
  input: z.object({ user_id: id, jurisdiction: z.string().min(2).max(40).regex(/^[a-z0-9_-]+$/), reason: z.string().min(5).max(300) }),
  async handler({ user }, i) {
    const r = await one('UPDATE users SET jurisdiction=$2 WHERE id=$1 RETURNING id', [i.user_id, i.jurisdiction]);
    if (!r) throw notFound('Person');
    await audit(null, user.id, 'set_jurisdiction', 'users', i.user_id);
    await refreshYouth(i.user_id, user.id);
    return { ok: true };
  },
});

cap({
  name: 'get_my_youth_status', method: 'GET', path: '/me/youth', tag: TAG,
  summary: 'Whether your account is a youth account, the date you become independent, the rules that apply, and which purposes your guardians currently allow.',
  async handler({ user }) {
    const row = await one(`SELECT to_char(u.youth_until,'YYYY-MM-DD') AS independent_on, ${YOUTH_SQL} AS is_youth, u.jurisdiction FROM users u WHERE u.id=$1`, [user.id]);
    const policy = await getPolicy(row.jurisdiction);
    const guardians = row.is_youth ? await guardiansOf(user.id) : [];
    const consents = {};
    if (row.is_youth) for (const p of PURPOSES) consents[p] = await hasConsent(user.id, p);
    return { is_youth: row.is_youth, independent_on: row.is_youth ? row.independent_on : null, policy: { jurisdiction: policy.jurisdiction, version: policy.version, independent_age: policy.independent_age }, active_guardians: guardians.length, consents };
  },
});

// ---- guardian relationships -------------------------------------------------------------------------------------------------

cap({
  name: 'request_guardian_link', method: 'POST', path: '/youth/guardian-links', tag: TAG, status: 201,
  summary: 'Start a guardian–child relationship. Either the adult or the young person can ask; the other must accept. Nothing is authorised until the platform team has reviewed evidence — you cannot make yourself someone\'s guardian.',
  input: z.object({
    handle: z.string().min(3).max(24).optional().describe('the other person\'s exact handle (young people are not searchable)'), as: z.enum(['guardian', 'child']).optional().describe('which side you are on when using handle'),
    guardian_id: id.optional(), child_id: id.optional(), relationship: z.enum(RELATIONSHIPS).default('parent'),
  }),
  async handler({ user }, i0) {
    const i = { ...i0 };
    if (i.handle) {
      if (!i.as) throw badRequest('Say whether you are the guardian or the child');
      const other = await one('SELECT id FROM users WHERE handle=$1', [i.handle.replace(/^@/, '').toLowerCase()]);
      if (!other) throw notFound('Person');
      if (i.as === 'guardian') Object.assign(i, { guardian_id: user.id, child_id: other.id }); else Object.assign(i, { guardian_id: other.id, child_id: user.id });
    }
    if (!i.guardian_id || !i.child_id) throw badRequest('Give the other person\'s handle, or both guardian_id and child_id');
    if (![i.guardian_id, i.child_id].includes(user.id)) throw forbidden('You can only ask for a relationship that includes you');
    if (i.guardian_id === i.child_id) throw badRequest('A person cannot be their own guardian');
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guardian:${i.child_id}`]);
      const child = (await c.query(`SELECT u.id, u.jurisdiction, ${YOUTH_SQL} AS is_youth FROM users u WHERE u.id=$1`, [i.child_id])).rows[0];
      const guardian = (await c.query(`SELECT u.id, ${YOUTH_SQL} AS is_youth FROM users u WHERE u.id=$1`, [i.guardian_id])).rows[0];
      if (!child || !guardian) throw notFound('Person');
      if (!child.is_youth) throw badRequest('That person is not under the independence age on record, so they do not need a guardian. They need a date of birth on their account.');
      if (guardian.is_youth) throw badRequest('A guardian must be an adult');
      const policy = await getPolicy(child.jurisdiction, c);
      const active = (await c.query("SELECT count(*)::int AS n FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL", [i.child_id])).rows[0].n;
      if (active >= policy.max_guardians) throw conflict(`This young person already has the maximum of ${policy.max_guardians} verified guardians`);
      const l = (await c.query(
        'INSERT INTO guardian_links(guardian_id, child_id, relationship, requested_by, policy_jurisdiction, policy_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [i.guardian_id, i.child_id, i.relationship, user.id, policy.jurisdiction, policy.version])).rows[0];
      await logLink(c, l.id, user.id, 'request', null, 'invited', null);
      const other = user.id === i.guardian_id ? i.child_id : i.guardian_id;
      await notify(c, other, { kind: 'guardian_request', title: 'Family link request', body: 'Someone asked to link accounts as parent or guardian. Open Family & guardians to answer.', data: { link_id: l.id } });
      return fullLink(c, l.id);
    });
  },
});

cap({
  name: 'respond_guardian_link', method: 'POST', path: '/youth/guardian-links/:id/respond', tag: TAG,
  summary: 'Accept or decline a family link request that someone else started. Accepting does not grant any authority yet: evidence and platform review still follow.',
  input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = await partyLink(c, user, i.id);
      if (l.requested_by === user.id || ![l.guardian_id, l.child_id].includes(user.id)) throw forbidden('The other person has to answer this request');
      if (l.status !== 'invited') throw conflict(`This request is already ${l.status.replace('_', ' ')}`);
      const row = await setStatus(c, l, user.id, i.accept ? 'accept' : 'decline', i.accept ? 'accepted' : 'declined', null);
      await notify(c, l.requested_by, { kind: 'guardian_response', title: i.accept ? 'Family link accepted' : 'Family link declined', body: i.accept ? 'Add proof of the relationship so the platform team can verify it.' : 'The request was declined.', data: { link_id: l.id } });
      return fullLink(c, row.id);
    });
  },
});

const evidenceIn = z.object({
  label: z.string().max(120).optional(),
  reference: z.string().min(2).max(500).optional().describe('https link or reference number'),
  file_name: z.string().max(120).optional(), data: z.string().max(7_200_000).optional().describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB'),
}).refine((e) => e.reference || e.data, 'Give a reference or attach a file');

cap({
  name: 'submit_guardian_evidence', method: 'POST', path: '/youth/guardian-links/:id/evidence', tag: TAG, status: 201,
  summary: 'Guardian: add proof of the relationship (a document or reference). It is encrypted, only the platform team reviewing it can open it (audit-logged), and the request moves to review.',
  input: z.object({ id, evidence: evidenceIn }),
  async handler({ user }, i) {
    const e = prepEvidence(i.evidence);
    return tx(async (c) => {
      const l = await partyLink(c, user, i.id);
      if (l.guardian_id !== user.id) throw forbidden('Only the guardian adds evidence');
      if (!['accepted', 'pending_review'].includes(l.status)) throw conflict(l.status === 'invited' ? 'Wait until the young person (or adult) accepts the request first' : `This request is ${l.status.replace('_', ' ')}`);
      await c.query('INSERT INTO guardian_evidence(link_id, submitted_by, label, reference_enc, file_name, content_type, size_bytes, sha256, file_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [l.id, user.id, e.label, e.reference_enc, e.file_name, e.content_type, e.size_bytes, e.sha256, e.file_enc]);
      const row = l.status === 'accepted' ? await setStatus(c, l, user.id, 'evidence', 'pending_review', null) : l;
      if (l.status === 'accepted') for (const a of (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows) await notify(c, a.id, { kind: 'guardian_review', title: 'Guardian link to review', body: 'A guardian relationship is waiting for evidence review.', data: { link_id: l.id } });
      return linkView(row);
    });
  },
});

cap({
  name: 'approve_additional_guardian', method: 'POST', path: '/youth/guardian-links/:id/approve', tag: TAG,
  summary: 'An existing verified guardian approves another adult being added as a guardian of the same young person. Without this the platform team will not verify the new link unless it records an exceptional-review reason.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = await lockLink(c, i.id);
      if (l.guardian_id === user.id) throw forbidden('You cannot approve your own link');
      if (!(await guardianLink(user.id, l.child_id, c))) throw notFound('Guardian link');
      if (!['invited', 'accepted', 'pending_review'].includes(l.status)) throw conflict(`This request is ${l.status.replace('_', ' ')}`);
      const row = (await c.query('UPDATE guardian_links SET co_guardian_ok_by=$2, co_guardian_ok_at=now(), updated_at=now() WHERE id=$1 RETURNING *', [l.id, user.id])).rows[0];
      await logLink(c, l.id, user.id, 'co_guardian_approved', l.status, l.status, null);
      return fullLink(c, row.id);
    });
  },
});

cap({
  name: 'list_guardian_reviews', method: 'GET', path: '/youth/reviews', tag: TAG, auth: ['admin'],
  summary: 'Platform team: guardian links waiting for evidence review, oldest first.',
  input: z.object({ ...page }),
  async handler(_, i) {
    return (await many(`${LINK_SELECT} WHERE l.status='pending_review' ORDER BY l.created_at, l.id LIMIT $1 OFFSET $2`, [i.limit, i.offset])).map(linkView);
  },
});

cap({
  name: 'get_guardian_evidence', method: 'GET', path: '/youth/guardian-links/:id/evidence', tag: TAG, auth: ['admin'],
  summary: 'Platform team: open the evidence submitted for a guardian link (decrypted; audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one('SELECT 1 FROM guardian_links WHERE id=$1', [i.id]))) throw notFound('Guardian link');
    const rows = await many('SELECT * FROM guardian_evidence WHERE link_id=$1 ORDER BY created_at, id', [i.id]);
    await audit(null, user.id, 'read_guardian_evidence', 'guardian_links', i.id);
    return rows.map((r) => ({
      id: r.id, label: r.label, created_at: r.created_at, reference: r.reference_enc ? decrypt(r.reference_enc, 'case_evidence.reference') : null,
      file: r.file_enc ? { name: r.file_name, content_type: r.content_type, size_bytes: r.size_bytes, sha256: r.sha256, data: decrypt(r.file_enc, 'case_evidence.file') } : null,
    }));
  },
});

cap({
  name: 'decide_guardian_link', method: 'POST', path: '/youth/guardian-links/:id/decision', tag: TAG, auth: ['admin'],
  summary: 'Platform team: verify or reject a guardian link after reviewing evidence. A second guardian needs an existing guardian\'s approval, or `exceptional` with a written reason. Verified links expire and must be renewed (policy link_valid_days).',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: z.string().min(3).max(500), exceptional: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l0 = (await c.query('SELECT child_id FROM guardian_links WHERE id=$1', [i.id])).rows[0];
      if (!l0) throw notFound('Guardian link');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guardian:${l0.child_id}`]);
      const l = await lockLink(c, i.id);
      if (l.status !== 'pending_review') throw conflict(`This request is ${l.status.replace('_', ' ')}, not waiting for review`);
      if ([l.guardian_id, l.child_id].includes(user.id)) throw forbidden('You cannot review a link you are part of');
      if (i.decision === 'reject') {
        const row = await setStatus(c, l, user.id, 'reject', 'rejected', i.note, { decided_by: user.id, decided_at: new Date(), decision_note: i.note });
        await notify(c, l.guardian_id, { kind: 'guardian_decision', title: 'Family link not verified', body: i.note, data: { link_id: l.id } });
        return linkView(row);
      }
      const policy = await getPolicy(l.policy_jurisdiction, c);
      const others = (await c.query("SELECT count(*)::int AS n FROM guardian_links WHERE child_id=$1 AND id<>$2 AND status='active' AND revoked_at IS NULL", [l.child_id, l.id])).rows[0].n;
      if (others >= policy.max_guardians) throw conflict(`This young person already has the maximum of ${policy.max_guardians} verified guardians`);
      if (others > 0 && !l.co_guardian_ok_at && !i.exceptional) throw conflict('An existing guardian has to approve an additional guardian, or record an exceptional review', { code: 'co_guardian_approval_required' });
      if (!(await isYouth(l.child_id, c))) throw conflict('This person has reached the independence age, so no guardian is needed');
      if (!(await one('SELECT 1 FROM guardian_evidence WHERE link_id=$1 LIMIT 1', [l.id]))) throw conflict('No evidence has been submitted');
      const expires = new Date(Date.now() + policy.link_valid_days * DAY);
      const row = (await c.query("UPDATE guardian_links SET status='active', decided_by=$2, decided_at=now(), decision_note=$3, expires_at=$4, updated_at=now() WHERE id=$1 RETURNING *", [l.id, user.id, i.note, expires])).rows[0];
      await logLink(c, l.id, user.id, i.exceptional && others > 0 && !l.co_guardian_ok_at ? 'approve_exceptional' : 'approve', 'pending_review', 'active', i.note);
      await audit(c, user.id, 'verify_guardian', 'guardian_links', l.id);
      for (const to of [l.guardian_id, l.child_id]) await notify(c, to, { kind: 'guardian_decision', title: 'Family link verified', body: 'The guardian can now manage permissions in Family & guardians.', data: { link_id: l.id } });
      return linkView(row);
    });
  },
});

cap({
  name: 'revoke_guardian_link', method: 'POST', path: '/youth/guardian-links/:id/revoke', tag: TAG,
  summary: 'End a guardian link. The guardian can end their own; the person who asked can withdraw a request that is not verified yet; the platform team can end any (for example after a dispute between guardians). Consents and pickup rights given by that guardian stop at once; history is kept.',
  input: z.object({ id, reason: z.string().min(3).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l = await partyLink(c, user, i.id);
      if (!OPEN.includes(l.status)) throw conflict(`This link is already ${l.status}`);
      const allowed = isAdmin(user) || l.guardian_id === user.id || (l.requested_by === user.id && l.status !== 'active');
      if (!allowed) throw forbidden('If you have a concern about a guardian, contact support: the platform team reviews it');
      const row = await setStatus(c, l, user.id, 'revoke', 'revoked', i.reason, { revoked_at: new Date(), revoked_by: user.id });
      if (l.status === 'active') {
        await audit(c, user.id, 'revoke_guardian', 'guardian_links', l.id);
        for (const to of new Set([l.guardian_id, l.child_id, ...(await guardiansOf(l.child_id, c))])) if (to !== user.id) await notify(c, to, { kind: 'guardian_revoked', title: 'A guardian link ended', body: 'Permissions given by that guardian no longer apply.', data: { link_id: l.id } });
      }
      return linkView(row);
    });
  },
});

cap({
  name: 'list_guardian_links', method: 'GET', path: '/youth/guardian-links', tag: TAG,
  summary: 'Your family links: children you are guardian of and guardians of yours, with state (invited, accepted, pending review, active, declined, rejected, revoked) and expiry. Newest first.',
  input: z.object({ approvals: z.coerce.boolean().optional().describe('instead: requests from other adults to become a guardian of a child you are a verified guardian of, waiting for your approval'), as: z.enum(['guardian', 'child']).optional(), status: z.enum(['invited', 'accepted', 'pending_review', 'active', 'declined', 'rejected', 'revoked']).optional(), ...page }),
  async handler({ user }, i) {
    if (i.approvals) {
      return (await many(
        `${LINK_SELECT} WHERE l.guardian_id <> $1 AND l.status IN ('invited','accepted','pending_review') AND l.co_guardian_ok_at IS NULL
           AND EXISTS (SELECT 1 FROM guardian_links m WHERE m.guardian_id=$1 AND m.child_id=l.child_id AND m.status='active' AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()))
         ORDER BY l.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset])).map((l) => ({ ...linkView(l), my_side: 'approver' }));
    }
    const rows = await many(
      `${LINK_SELECT} WHERE (($2::text IS NULL OR $2 = 'guardian') AND l.guardian_id = $1 OR ($2::text IS NULL OR $2 = 'child') AND l.child_id = $1)
         AND ($3::text IS NULL OR l.status = $3) ORDER BY l.created_at DESC, l.id DESC LIMIT $4 OFFSET $5`, [user.id, i.as ?? null, i.status ?? null, i.limit, i.offset]);
    return rows.map((l) => ({ ...linkView(l), my_side: l.guardian_id === user.id ? 'guardian' : 'child' }));
  },
});

// ---- purpose-specific consent -----------------------------------------------------------------------------------------------

cap({
  name: 'grant_youth_consent', method: 'POST', path: '/youth/children/:child_id/consents', tag: TAG, status: 201,
  summary: 'Guardian: allow one purpose for a young person — participation (teams, games, events), medical (sharing health records with providers), media (photos/videos) or contact (direct messages from adults). Recorded with the policy version, who gave it and when it expires. Renewing replaces the previous consent.',
  input: z.object({ child_id: id, purpose: z.enum(PURPOSES), expires_in_days: z.number().int().min(1).max(730).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const link = await guardianLink(user.id, i.child_id, c);
      if (!link) throw forbidden('You are not a verified guardian of this young person');
      const policy = await getPolicy(link.policy_jurisdiction, c);
      const days = Math.min(i.expires_in_days ?? policy.consent_max_days, policy.consent_max_days);
      const expires = new Date(Date.now() + days * DAY);
      const row = (await c.query(
        `INSERT INTO youth_consents(child_id, purpose, granted_by, policy_jurisdiction, policy_version, expires_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (child_id, purpose) DO UPDATE SET granted_by=EXCLUDED.granted_by, policy_jurisdiction=EXCLUDED.policy_jurisdiction, policy_version=EXCLUDED.policy_version,
           expires_at=EXCLUDED.expires_at, revoked_at=NULL, revoked_by=NULL, granted_at=now()
         RETURNING child_id, purpose, granted_by, policy_version, expires_at, granted_at`, [i.child_id, i.purpose, user.id, policy.jurisdiction, policy.version, expires])).rows[0];
      await c.query("INSERT INTO youth_consent_events(child_id, purpose, action, actor_id, policy_jurisdiction, policy_version, expires_at) VALUES ($1,$2,'grant',$3,$4,$5,$6)", [i.child_id, i.purpose, user.id, policy.jurisdiction, policy.version, expires]);
      await audit(c, user.id, 'grant_youth_consent', 'users', i.child_id);
      for (const to of new Set([i.child_id, ...(await guardiansOf(i.child_id, c))])) if (to !== user.id) await notify(c, to, { kind: 'youth_consent', title: 'A permission was allowed', body: `Permission for ${i.purpose} was allowed. Open Family & guardians for details.`, data: { child_id: i.child_id, purpose: i.purpose } });
      return { ...row, state: 'active' };
    });
  },
});

cap({
  name: 'revoke_youth_consent', method: 'DELETE', path: '/youth/children/:child_id/consents/:purpose', tag: TAG,
  summary: 'Guardian: withdraw a permission. It stops immediately for new actions (existing records stay). Any verified guardian can withdraw; the most restrictive choice wins.',
  input: z.object({ child_id: id, purpose: z.enum(PURPOSES) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (!(await guardianLink(user.id, i.child_id, c))) throw forbidden('You are not a verified guardian of this young person');
      const r = (await c.query('UPDATE youth_consents SET revoked_at=now(), revoked_by=$3 WHERE child_id=$1 AND purpose=$2 AND revoked_at IS NULL RETURNING policy_jurisdiction, policy_version', [i.child_id, i.purpose, user.id])).rows[0];
      if (r) {
        await c.query("INSERT INTO youth_consent_events(child_id, purpose, action, actor_id, policy_jurisdiction, policy_version) VALUES ($1,$2,'revoke',$3,$4,$5)", [i.child_id, i.purpose, user.id, r.policy_jurisdiction, r.policy_version]);
        await audit(c, user.id, 'revoke_youth_consent', 'users', i.child_id);
        for (const to of new Set([i.child_id, ...(await guardiansOf(i.child_id, c))])) if (to !== user.id) await notify(c, to, { kind: 'youth_consent', title: 'A permission was withdrawn', body: `Permission for ${i.purpose} was withdrawn.`, data: { child_id: i.child_id, purpose: i.purpose } });
      }
      return { ok: true, changed: !!r };
    });
  },
});

cap({
  name: 'list_youth_consents', method: 'GET', path: '/youth/children/:child_id/consents', tag: TAG,
  summary: 'Current state of each purpose (active / expired / revoked / not given) for a young person, plus the history of grants and withdrawals. Visible to the young person, their verified guardians and the platform team.',
  input: z.object({ child_id: id, ...page }),
  async handler({ user }, i) {
    if (user.id !== i.child_id && !isAdmin(user) && !(await guardianLink(user.id, i.child_id))) throw notFound('Young person');
    const rows = await many('SELECT purpose, expires_at, revoked_at, granted_by, granted_at, policy_version FROM youth_consents WHERE child_id=$1', [i.child_id]);
    const live = await Promise.all(PURPOSES.map(async (purpose) => {
      const r = rows.find((x) => x.purpose === purpose);
      const state = !r ? 'not_given' : r.revoked_at ? 'revoked' : new Date(r.expires_at) <= new Date() ? 'expired' : (await hasConsent(i.child_id, purpose)) ? 'active' : 'lapsed';
      return { purpose, state, ...(r ?? {}) };
    }));
    const history = await many(
      `SELECT e.purpose, e.action, e.actor_id, a.display_name AS actor_name, e.policy_version, e.expires_at, e.created_at FROM youth_consent_events e LEFT JOIN users a ON a.id=e.actor_id
        WHERE e.child_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`, [i.child_id, i.limit, i.offset]);
    return { consents: live, history };
  },
});

// ---- pickup delegation & check-in -------------------------------------------------------------------------------------------

const delegateLive = `d.revoked_at IS NULL AND d.valid_from <= now() AND d.expires_at > now()
  AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=d.granted_by AND l.child_id=d.child_id AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()))`;

cap({
  name: 'add_pickup_delegate', method: 'POST', path: '/youth/children/:child_id/pickup-delegates', tag: TAG, status: 201,
  summary: 'Guardian: authorise an adult to collect (and check in) a young person for a limited time. Give a person on the platform, a name (encrypted), or both. Coaches can only release the child to a guardian or a current delegate.',
  input: z.object({ child_id: id, delegate_user_id: id.optional(), delegate_handle: z.string().min(3).max(24).optional(), delegate_name: z.string().min(2).max(120).optional(), valid_days: z.number().int().min(1).max(90).default(30) }),
  async handler({ user }, i0) {
    const i = { ...i0 };
    if (i.delegate_handle) {
      const d = await one('SELECT id FROM users WHERE handle=$1', [i.delegate_handle.replace(/^@/, '').toLowerCase()]);
      if (!d) throw notFound('Person');
      i.delegate_user_id = d.id;
    }
    if (!i.delegate_user_id && !i.delegate_name) throw badRequest('Give a person or a name');
    return tx(async (c) => {
      if (!(await guardianLink(user.id, i.child_id, c))) throw forbidden('You are not a verified guardian of this young person');
      if (i.delegate_user_id) {
        if (i.delegate_user_id === i.child_id) throw badRequest('A child cannot be their own pickup');
        const d = (await c.query(`SELECT u.id, ${YOUTH_SQL} AS is_youth FROM users u WHERE u.id=$1`, [i.delegate_user_id])).rows[0];
        if (!d) throw notFound('Person');
        if (d.is_youth) throw badRequest('A pickup person must be an adult');
      }
      const r = (await c.query(
        'INSERT INTO pickup_delegates(child_id, delegate_user_id, delegate_name_enc, granted_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id, child_id, delegate_user_id, valid_from, expires_at',
        [i.child_id, i.delegate_user_id ?? null, encrypt(i.delegate_name, 'pickup_delegates.name'), user.id, i.valid_days])).rows[0];
      await audit(c, user.id, 'add_pickup_delegate', 'users', i.child_id);
      if (i.delegate_user_id) await notify(c, i.delegate_user_id, { kind: 'pickup_delegate', title: 'You can collect a young person', body: 'A guardian authorised you to pick someone up. Open Family & guardians.', data: { child_id: i.child_id } });
      return r;
    });
  },
});

cap({
  name: 'revoke_pickup_delegate', method: 'DELETE', path: '/youth/pickup-delegates/:id', tag: TAG,
  summary: 'Guardian: withdraw a pickup authorisation. It stops immediately.', input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT child_id FROM pickup_delegates WHERE id=$1', [i.id]);
    if (!d || !(await guardianLink(user.id, d.child_id))) throw notFound('Pickup authorisation');
    await one('UPDATE pickup_delegates SET revoked_at=coalesce(revoked_at, now()), revoked_by=coalesce(revoked_by, $2) WHERE id=$1 RETURNING id', [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'list_pickup_delegates', method: 'GET', path: '/youth/children/:child_id/pickup-delegates', tag: TAG,
  summary: 'Guardian: who is authorised to collect a young person, with validity and state. Names are decrypted (audit-logged). Newest first.',
  input: z.object({ child_id: id, ...page }),
  async handler({ user }, i) {
    if (!(await guardianLink(user.id, i.child_id)) && !isAdmin(user)) throw notFound('Young person');
    const rows = await many(
      `SELECT d.id, d.delegate_user_id, u.display_name AS delegate_display_name, d.delegate_name_enc, d.valid_from, d.expires_at, d.revoked_at, d.granted_by, (${delegateLive}) AS active
         FROM pickup_delegates d LEFT JOIN users u ON u.id=d.delegate_user_id WHERE d.child_id=$1 ORDER BY d.created_at DESC, d.id DESC LIMIT $2 OFFSET $3`, [i.child_id, i.limit, i.offset]);
    await audit(null, user.id, 'read_pickup_delegates', 'users', i.child_id);
    return rows.map(({ delegate_name_enc, ...r }) => ({ ...r, delegate_name: decrypt(delegate_name_enc, 'pickup_delegates.name') }));
  },
});

cap({
  name: 'check_in_child', method: 'POST', path: '/youth/teams/:team_id/check-ins', tag: TAG, status: 201,
  summary: 'Record a young person arriving (drop_off) or leaving (pickup) a team session. Done by a verified guardian, a current pickup delegate (pickup only) or a team manager. A pickup must be released to a guardian or current delegate. Needs current participation consent. Guardians are notified. Pass idempotency_key to make retries safe.',
  input: z.object({
    team_id: id, child_id: id, kind: z.enum(['drop_off', 'pickup']), released_to_user_id: id.optional().describe('guardian or delegate collecting the child (managers only)'),
    delegate_id: id.optional().describe('a named pickup authorisation (managers only)'), note: z.string().max(200).optional(), idempotency_key: z.string().min(8).max(80).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkin:${i.child_id}`]);
      if (i.idempotency_key) {
        const prior = (await c.query('SELECT * FROM youth_checkins WHERE actor_id=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
        if (prior) return { ...prior, replayed: true };
      }
      const team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
      if (!team) throw notFound('Team');
      const isGuardian = !!(await guardianLink(user.id, i.child_id, c));
      const delegateRow = i.kind === 'pickup' && (await c.query(`SELECT d.id FROM pickup_delegates d WHERE d.child_id=$1 AND d.delegate_user_id=$2 AND ${delegateLive} ORDER BY d.created_at DESC LIMIT 1`, [i.child_id, user.id])).rows[0];
      const isManager = await canManageTeam(user, team);
      if (!isGuardian && !delegateRow && !isManager) throw notFound('Young person'); // do not reveal who is on a team
      if (!(await isYouth(i.child_id, c))) throw badRequest('Check-in is for young people with a guardian');
      if (!(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.team_id, i.child_id])).rows.length) throw notFound('Young person');
      await requireConsent(i.child_id, 'participation', 'taking part in this team', c);

      let releasedTo = null; let delegateId = null;
      if (i.kind === 'pickup') {
        if (isGuardian && !i.released_to_user_id && !i.delegate_id) releasedTo = user.id;
        else if (delegateRow && !isGuardian && !i.released_to_user_id && !i.delegate_id) { releasedTo = user.id; delegateId = delegateRow.id; }
        else if (i.delegate_id) {
          const d = (await c.query(`SELECT d.id FROM pickup_delegates d WHERE d.id=$1 AND d.child_id=$2 AND ${delegateLive}`, [i.delegate_id, i.child_id])).rows[0];
          if (!d) throw forbidden('That person is not currently authorised to collect this young person');
          delegateId = d.id;
        } else if (i.released_to_user_id) {
          const g = await guardianLink(i.released_to_user_id, i.child_id, c);
          const d = !g && (await c.query(`SELECT d.id FROM pickup_delegates d WHERE d.child_id=$1 AND d.delegate_user_id=$2 AND ${delegateLive} LIMIT 1`, [i.child_id, i.released_to_user_id])).rows[0];
          if (!g && !d) throw forbidden('That person is not a guardian or an authorised pickup for this young person');
          releasedTo = i.released_to_user_id; delegateId = d?.id ?? null;
        } else throw badRequest('Say who is collecting the young person');
        if ((i.released_to_user_id || i.delegate_id) && !isManager && !isGuardian) throw forbidden('Only a guardian or team manager can release to someone else');
      } else if (!isGuardian && !isManager) throw forbidden('Only a guardian or team manager records a drop-off');

      const last = (await c.query("SELECT kind FROM youth_checkins WHERE child_id=$1 AND team_id=$2 AND at > now() - interval '24 hours' ORDER BY at DESC, id DESC LIMIT 1", [i.child_id, i.team_id])).rows[0];
      if (i.kind === 'drop_off' && last?.kind === 'drop_off') throw conflict('This young person is already checked in');
      if (i.kind === 'pickup' && last?.kind !== 'drop_off') throw conflict('This young person is not checked in');
      const row = (await c.query(
        'INSERT INTO youth_checkins(child_id, team_id, kind, actor_id, released_to_user_id, delegate_id, note, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.child_id, i.team_id, i.kind, user.id, releasedTo, delegateId, i.note ?? null, i.idempotency_key ?? null])).rows[0];
      for (const g of await guardiansOf(i.child_id, c)) if (g !== user.id) await notify(c, g, { kind: 'youth_checkin', title: i.kind === 'drop_off' ? 'Checked in' : 'Collected', body: `${team.name}: ${i.kind === 'drop_off' ? 'arrived' : 'collected'}.`, data: { child_id: i.child_id, team_id: i.team_id, checkin_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'list_youth_checkins', method: 'GET', path: '/youth/check-ins', tag: TAG,
  summary: 'Check-in history, newest first. A guardian passes child_id; the young person sees their own; a team manager passes team_id to see that team\'s sessions.',
  input: z.object({ child_id: id.optional(), team_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (!i.child_id && !i.team_id) throw badRequest('Give a child_id or a team_id');
    if (i.child_id && !(i.child_id === user.id || isAdmin(user) || (await guardianLink(user.id, i.child_id)))) {
      const team = i.team_id && (await one('SELECT * FROM teams WHERE id=$1', [i.team_id]));
      if (!team || !(await canManageTeam(user, team))) throw notFound('Young person');
    } else if (!i.child_id) {
      const team = await one('SELECT * FROM teams WHERE id=$1', [i.team_id]);
      if (!team || !(await canManageTeam(user, team))) throw notFound('Team');
    }
    return many(
      `SELECT k.id, k.child_id, c.display_name AS child_name, k.team_id, k.kind, k.actor_id, k.released_to_user_id, k.delegate_id, k.note, k.at
         FROM youth_checkins k JOIN users c ON c.id=k.child_id WHERE ($1::uuid IS NULL OR k.child_id=$1) AND ($2::uuid IS NULL OR k.team_id=$2) ORDER BY k.at DESC, k.id DESC LIMIT $3 OFFSET $4`,
      [i.child_id ?? null, i.team_id ?? null, i.limit, i.offset]);
  },
});
