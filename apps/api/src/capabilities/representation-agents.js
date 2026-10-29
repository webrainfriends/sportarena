// Sports agent & player representation (issue #484) 1/5: agent and agency identity. A profile is a business identity, never access to anyone: the
// verified badge is the platform's own verification case (type 'agent') and says what was checked; licences are declarations until a reviewer checks them.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { CONTACT_ACTIONS, DATA_ACCESS, NEVER_SHARED, ATHLETE_ONLY, PURPOSES, STAFF_PERMS, actingFor, agentOfUser, agentStanding, loadAgent, noWaiver, APPROVAL_DAYS } from '../representation.js';

const TAG = 'Representation';
const text = (n) => z.string().trim().max(n);
const market = z.string().trim().toUpperCase().regex(/^([A-Z]{2}|WW)$/, 'Use a two-letter country code, or WW for worldwide');
const day = z.string().date();

/** Who may see an agent profile: it is listed and verified, or the viewer works for it, or has a mandate with it. */
async function visibleTo(user, agent, c = pool) {
  if (!agent) return false;
  if (agent.is_public && agent.status === 'active' && (await agentStanding(c, agent)).verified) return true;
  if (await actingFor(c, user, agent)) return true;
  return !!(await c.query(
    `SELECT 1 FROM representation_mandates m WHERE m.agent_id=$1 AND (m.athlete_id=$2 OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$2 AND l.child_id=m.athlete_id AND l.status='active' AND l.revoked_at IS NULL)) LIMIT 1`, [agent.id, user.id])).rowCount;
}

export async function profileView(agent, { owner = false, c = pool } = {}) {
  const [standing, sports, org] = await Promise.all([
    agentStanding(c, agent),
    agent.sport_ids.length ? c.query('SELECT id, slug, name, emoji FROM sports WHERE id = ANY($1) ORDER BY name', [agent.sport_ids]).then((r) => r.rows) : [],
    agent.organisation_id ? c.query('SELECT id, name, city FROM organisations WHERE id=$1', [agent.organisation_id]).then((r) => r.rows[0] ?? null) : null,
  ]);
  const out = {
    id: agent.id, kind: agent.kind, display_name: agent.display_name, bio: agent.bio, sports, markets: agent.markets, is_public: agent.is_public, status: agent.status, organisation: org, row_version: agent.row_version,
    verification: { verified: standing.verified, verified_at: standing.verified_at, expires_at: standing.expires_at, checked: standing.checked.map(({ label, note }) => ({ label, note })), statement: standing.statement },
    licences: standing.licences.map(({ id: lid, issuing_body, grade, jurisdiction, sport_id, reference_last4, valid_from, valid_to, standing: st }) => ({ id: lid, issuing_body, grade, jurisdiction, sport_id, reference_last4, valid_from, valid_to, standing: st })),
  };
  if (owner) {
    out.staff = await c.query(`SELECT s.id, s.user_id, s.permissions, s.status, u.display_name, u.handle FROM agent_staff s JOIN users u ON u.id=s.user_id WHERE s.agent_id=$1 AND s.status='active' ORDER BY s.created_at`, [agent.id]).then((r) => r.rows);
    out.interests = await c.query('SELECT id, kind, target_type, target_id, label, created_at FROM agent_interests WHERE agent_id=$1 AND ended_at IS NULL ORDER BY created_at', [agent.id]).then((r) => r.rows);
    out.suspended_reason = agent.suspended_reason;
  }
  return out;
}

// ------------------------------------------------------------------ the published access matrix
cap({
  name: 'get_representation_matrix', method: 'GET', path: '/representation/matrix', tag: TAG, auth: 'public',
  summary: 'The mandate and access matrix: what a representation mandate can cover, what an athlete controls, what an agent can never see or do, and who can do what. Public and read-only.',
  handler: async () => ({
    purposes: PURPOSES, data_access: DATA_ACCESS, contact_actions: CONTACT_ACTIONS, staff_permissions: STAFF_PERMS,
    never_shared: NEVER_SHARED, athlete_only: ATHLETE_ONLY,
    conflict_policy: { cannot_be_accepted_by_athlete: noWaiver(), note: 'SportArena flags possible conflicts and records the decision of the people involved. It never decides whether a conflict is legally acceptable.' },
    approval_window_days: APPROVAL_DAYS(),
    live_checks: ['mandate agreed by every required party and inside its dates', 'agent not suspended', 'agent verification current', 'licence relied on current and checked', 'purpose, data category and action are in the agreed version', 'for a young person, the guardian\'s current consent', 'for a private item, a grant for that exact item', 'no open conflict on the item'],
    matrix: [
      { action: 'Create or propose a mandate', athlete: 'yes', guardian: 'yes (for a young person)', youth_athlete: 'no (a guardian proposes)', agent: 'yes', agency_staff: 'no' },
      { action: 'Sign a mandate version', athlete: 'yes', guardian: 'yes, and required for a young person', youth_athlete: 'yes, together with a guardian', agent: 'yes', agency_staff: 'no' },
      { action: 'Revoke a mandate (takes effect at once)', athlete: 'yes', guardian: 'yes', youth_athlete: 'yes', agent: 'ends it from their side', agency_staff: 'no' },
      { action: 'Grant an item (video, application, contract, sponsorship)', athlete: 'yes', guardian: 'yes', youth_athlete: 'no', agent: 'no', agency_staff: 'no' },
      { action: 'Read the public Sports Passport', athlete: 'own', guardian: 'yes', youth_athlete: 'own', agent: 'if allowed in the mandate', agency_staff: 'if allowed, and staff may act' },
      { action: 'Read a granted private item', athlete: 'own', guardian: 'yes', youth_athlete: 'own', agent: 'only that item, while the mandate is live', agency_staff: 'same, if the athlete allowed staff' },
      { action: 'Share an opportunity / log a conversation / draft an application', athlete: 'n/a', guardian: 'n/a', youth_athlete: 'n/a', agent: 'if the action is allowed', agency_staff: 'with the outreach permission' },
      { action: 'Express interest or submit an application', athlete: 'approves, then it is sent as the athlete', guardian: 'approves for a young person', youth_athlete: 'no', agent: 'asks for approval only', agency_staff: 'asks for approval only' },
      { action: 'Accept a position or offer, sign a contract or amendment, approve a transfer', athlete: 'only the athlete', guardian: 'also required for a young person', youth_athlete: 'with a guardian', agent: 'never', agency_staff: 'never' },
      { action: 'Comment on contract terms, keep negotiation notes', athlete: 'sees notes made visible to them', guardian: 'same', youth_athlete: 'same', agent: 'on granted contracts, within the mandate', agency_staff: 'with the negotiate permission' },
      { action: 'Medical, private coaching, family finance, passwords, unrelated messages', athlete: 'own', guardian: 'per guardian rules', youth_athlete: 'own', agent: 'never', agency_staff: 'never' },
      { action: 'Commission terms, statements, payments', athlete: 'sees and confirms', guardian: 'same', youth_athlete: 'sees', agent: 'issues statements and confirms receipt', agency_staff: 'with the commission permission' },
    ],
  }),
});

// ------------------------------------------------------------------ my profile
cap({
  name: 'get_my_agent_profile', method: 'GET', path: '/agents/me', tag: TAG,
  summary: 'Your agent or agency profile with verification, licences, delegated staff and declared interests, and any profiles you work for as delegated staff. null when you have none.',
  async handler({ user }) {
    const own = await agentOfUser(pool, user.id);
    const staffOf = await many(
      `SELECT a.id, a.display_name, a.kind, s.permissions FROM agent_staff s JOIN agent_profiles a ON a.id=s.agent_id WHERE s.user_id=$1 AND s.status='active' AND a.status='active'
         AND (a.kind='individual' OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=a.organisation_id AND m.user_id=$1 AND m.status='active'))`, [user.id]);
    return { profile: own ? await profileView(own, { owner: true }) : null, works_for: staffOf };
  },
});

cap({
  name: 'save_agent_profile', method: 'POST', path: '/agents/me', tag: TAG, status: 201,
  summary: 'Create or update your agent profile. An agency profile belongs to an organisation you own or administer and you answer for it. Listing in the directory is your choice (is_public). Nothing here gives access to any athlete: only a mandate an athlete agrees does. Updates need row_version.',
  input: z.object({
    kind: z.enum(['individual', 'agency']).optional(), organisation_id: id.optional(), display_name: text(120).min(2), bio: text(1000).nullish(),
    sport_ids: z.array(id).max(300).default([]), markets: z.array(market).max(250).default([]), is_public: z.boolean().default(false), row_version: z.coerce.number().int().min(1).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_profile:${user.id}`]);
      if (i.sport_ids.length && Number((await c.query('SELECT count(*) AS n FROM sports WHERE id = ANY($1)', [i.sport_ids])).rows[0].n) !== new Set(i.sport_ids).size) throw badRequest('One of the sports does not exist');
      const markets = [...new Set(i.markets)].sort();
      if (markets.includes('WW') && markets.length > 1) throw badRequest('Worldwide (WW) already covers every market');
      const sports = [...new Set(i.sport_ids)];
      const cur = await agentOfUser(c, user.id);
      if (cur) {
        if (i.row_version == null) throw badRequest('Send row_version from the last read');
        if (cur.row_version !== i.row_version) throw conflict('This profile changed; reload it', { code: 'stale_version' });
        if ((i.kind && i.kind !== cur.kind) || (i.organisation_id && i.organisation_id !== cur.organisation_id)) throw badRequest('The kind and organisation of a profile cannot change; mandates may rely on them');
        const r = (await c.query('UPDATE agent_profiles SET display_name=$2, bio=$3, sport_ids=$4, markets=$5, is_public=$6, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, i.display_name, i.bio ?? null, sports, markets, i.is_public])).rows[0];
        await audit(c, user.id, 'update_agent_profile', 'agent_profiles', r.id);
        return profileView(r, { owner: true, c });
      }
      const kind = i.kind ?? 'individual';
      if (kind === 'agency') {
        if (!i.organisation_id) throw badRequest('An agency profile needs organisation_id');
        if (!(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c))) throw forbidden('Only an owner or admin of the organisation can create its agency profile');
        if ((await c.query('SELECT 1 FROM agent_profiles WHERE organisation_id=$1', [i.organisation_id])).rowCount) throw conflict('That organisation already has an agency profile');
      } else if (i.organisation_id) throw badRequest('An individual profile has no organisation');
      const r = (await c.query('INSERT INTO agent_profiles(kind, user_id, organisation_id, display_name, bio, sport_ids, markets, is_public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [kind, user.id, i.organisation_id ?? null, i.display_name, i.bio ?? null, sports, markets, i.is_public])).rows[0];
      await c.query("UPDATE users SET roles = array_append(roles, 'agent') WHERE id=$1 AND NOT ('agent' = ANY(roles))", [user.id]);
      await audit(c, user.id, 'create_agent_profile', 'agent_profiles', r.id);
      return profileView(r, { owner: true, c });
    });
  },
});

async function mine(user, c = pool) {
  const a = await agentOfUser(c, user.id);
  if (!a) throw notFound('Agent profile');
  return a;
}

cap({
  name: 'add_agent_licence', method: 'POST', path: '/agents/me/licences', tag: TAG, status: 201,
  summary: 'Declare a licence or registration: issuing body, grade or type, jurisdiction, validity and (optionally) the reference. The reference is encrypted; only its last four characters are ever shown. It stays "declared" until the SportArena review team checks it as part of your verification; an expired validity date shows as expired.',
  input: z.object({ issuing_body: text(120).min(2), grade: text(80).default(''), jurisdiction: market, sport_id: id.optional(), reference: text(60).optional(), valid_from: day.optional(), valid_to: day.optional() }),
  async handler({ user }, i) {
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('The validity cannot end before it starts');
    const a = await mine(user);
    const ref = i.reference?.trim() || null;
    const r = await one(
      `INSERT INTO agent_licences(agent_id, issuing_body, grade, jurisdiction, sport_id, reference_enc, reference_last4, valid_from, valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, issuing_body, grade, jurisdiction, sport_id, reference_last4, valid_from::text AS valid_from, valid_to::text AS valid_to, status`,
      [a.id, i.issuing_body, i.grade, i.jurisdiction, i.sport_id ?? null, encrypt(ref, 'agent_licences.reference'), ref ? ref.slice(-4) : null, i.valid_from ?? null, i.valid_to ?? null]);
    return { ...r, standing: 'declared' };
  },
});

cap({
  name: 'withdraw_agent_licence', method: 'DELETE', path: '/agents/me/licences/:id', tag: TAG,
  summary: 'Withdraw a declared licence. The row is kept; a mandate that relied on it stops being live until it is amended.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await mine(user);
    const r = await one("UPDATE agent_licences SET status='withdrawn', updated_at=now() WHERE id=$1 AND agent_id=$2 AND status='declared' RETURNING id", [i.id, a.id]);
    if (!r) throw notFound('Licence');
    return { id: r.id, status: 'withdrawn' };
  },
});

cap({
  name: 'add_agent_interest', method: 'POST', path: '/agents/me/interests', tag: TAG, status: 201,
  summary: 'Declare an interest in a club, sponsor, supplier or related party (a business stake or relationship). Every deal you join is compared with these, and a match opens a conflict the athlete must decide before you continue.',
  input: z.object({ kind: z.enum(['club', 'sponsor', 'supplier', 'related_party', 'other']), target_type: z.enum(['team', 'organisation', 'sponsor', 'user']).optional(), target_id: id.optional(), label: text(160).min(2), note: text(500).optional() }),
  async handler({ user }, i) {
    if (!!i.target_type !== !!i.target_id) throw badRequest('Give both target_type and target_id, or neither');
    const a = await mine(user);
    return one('INSERT INTO agent_interests(agent_id, kind, target_type, target_id, label, note_enc, declared_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, target_type, target_id, label, created_at', [a.id, i.kind, i.target_type ?? null, i.target_id ?? null, i.label, encrypt(i.note, 'agent_interests.note'), user.id]);
  },
});

cap({
  name: 'end_agent_interest', method: 'DELETE', path: '/agents/me/interests/:id', tag: TAG,
  summary: 'Mark a declared interest as ended. It stays on record for past conflict checks.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await mine(user);
    const r = await one('UPDATE agent_interests SET ended_at=now() WHERE id=$1 AND agent_id=$2 AND ended_at IS NULL RETURNING id', [i.id, a.id]);
    if (!r) throw notFound('Interest');
    return { id: r.id, ended: true };
  },
});

cap({
  name: 'add_agent_staff', method: 'POST', path: '/agents/me/staff', tag: TAG, status: 201,
  summary: 'Delegate to a member of your agency (view, outreach, negotiate, commission). Staff can only act inside your mandates, only where the athlete allowed agency staff, and never beyond the permissions you give. An agency\'s staff must belong to its organisation. Staff cannot be one of your own clients.',
  input: z.object({ user_id: id, permissions: z.array(z.enum(STAFF_PERMS)).min(1).default(['view']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await mine(user, c);
      if (i.user_id === user.id) throw badRequest('You are already the principal of this profile');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
      if (a.kind === 'agency' && !(await c.query("SELECT 1 FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active'", [a.organisation_id, i.user_id])).rowCount) throw badRequest('Staff of an agency must be active members of its organisation');
      if (a.kind === 'individual') throw badRequest('Only an agency profile can have delegated staff');
      if ((await c.query("SELECT 1 FROM representation_mandates WHERE agent_id=$1 AND athlete_id=$2 AND status IN ('proposed','active')", [a.id, i.user_id])).rowCount) throw conflict('That person is one of your clients; they cannot also act for you', { code: 'conflict_of_interest' });
      const perms = [...new Set(i.permissions)];
      const r = (await c.query(
        `INSERT INTO agent_staff(agent_id, user_id, permissions, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (agent_id, user_id) DO UPDATE SET permissions=EXCLUDED.permissions, status='active', removed_at=NULL RETURNING id, user_id, permissions, status`, [a.id, i.user_id, perms, user.id])).rows[0];
      await audit(c, user.id, 'add_agent_staff', 'agent_profiles', a.id);
      await notify(c, i.user_id, { kind: 'agent_staff_added', title: `You can now work for ${a.display_name}`, body: 'You act only inside mandates athletes have agreed, and only where they allowed agency staff.', data: { agent_id: a.id } });
      return r;
    });
  },
});

cap({
  name: 'remove_agent_staff', method: 'DELETE', path: '/agents/me/staff/:id', tag: TAG,
  summary: 'Remove delegated staff. Their access stops at once; what they did stays in the history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await mine(user);
    const r = await one("UPDATE agent_staff SET status='removed', removed_at=now() WHERE id=$1 AND agent_id=$2 AND status='active' RETURNING id", [i.id, a.id]);
    if (!r) throw notFound('Staff member');
    return { id: r.id, status: 'removed' };
  },
});

// ------------------------------------------------------------------ directory
cap({
  name: 'list_agents', method: 'GET', path: '/agents', tag: TAG,
  summary: 'Find verified agents and agencies that chose to be listed. Filter by sport, market (country code) and name. Listing is not an endorsement and gives no access to anyone.',
  input: z.object({ q: text(80).optional(), sport_id: id.optional(), market: market.optional(), ...page }),
  async handler(_ctx, i) {
    const rows = await many(
      `SELECT a.* FROM agent_profiles a
        WHERE a.is_public AND a.status='active' AND ($1::text IS NULL OR a.display_name ILIKE '%' || $1 || '%') AND ($2::uuid IS NULL OR $2 = ANY(a.sport_ids)) AND ($3::text IS NULL OR $3 = ANY(a.markets) OR 'WW' = ANY(a.markets))
          AND EXISTS (SELECT 1 FROM verification_cases k WHERE k.type='agent' AND k.subject_type='user' AND k.subject_id=a.user_id AND k.status='approved' AND k.expires_at > now())
        ORDER BY a.display_name, a.id LIMIT $4 OFFSET $5`, [i.q ?? null, i.sport_id ?? null, i.market ?? null, i.limit, i.offset]);
    return Promise.all(rows.map((a) => profileView(a)));
  },
});

cap({
  name: 'get_agent', method: 'GET', path: '/agents/:id', tag: TAG,
  summary: 'An agent or agency profile: sports, markets, what verification actually checked, and licences with their standing (declared, verified or expired). Visible when listed and verified, or when you work for it or have a mandate with it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await loadAgent(pool, i.id);
    if (!(await visibleTo(user, a))) throw notFound('Agent');
    return profileView(a, { owner: !!(await actingFor(pool, user, a)) && a.user_id === user.id });
  },
});

// ------------------------------------------------------------------ platform team
cap({
  name: 'suspend_agent', method: 'POST', path: '/admin/agents/:id/suspension', tag: TAG, auth: ['admin'],
  summary: 'Platform team: suspend or reinstate an agent profile. A suspended agent has no live access under any mandate until reinstated; mandates, notes and commission history are kept. A reason is required to suspend.',
  input: z.object({ id, suspended: z.boolean(), reason: text(500).optional() }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    if (i.suspended && !i.reason) throw badRequest('A reason is required to suspend');
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM agent_profiles WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Agent');
      if (a.user_id === user.id) throw forbidden('Another platform team member must decide about your own profile');
      await c.query("UPDATE agent_profiles SET status=$2, suspended_reason=$3, suspended_at=CASE WHEN $2='suspended' THEN now() ELSE NULL END, suspended_by=CASE WHEN $2='suspended' THEN $4::uuid ELSE NULL END, row_version=row_version+1, updated_at=now() WHERE id=$1", [a.id, i.suspended ? 'suspended' : 'active', i.suspended ? i.reason : null, user.id]);
      await audit(c, user.id, i.suspended ? 'suspend_agent' : 'reinstate_agent', 'agent_profiles', a.id);
      await notify(c, a.user_id, { kind: 'agent_status', title: i.suspended ? 'Your agent profile is suspended' : 'Your agent profile is active again', body: i.suspended ? i.reason : 'Mandates athletes agreed are usable again while they remain in force.', data: { agent_id: a.id } });
      for (const m of (await c.query("SELECT * FROM representation_mandates WHERE agent_id=$1 AND status='active'", [a.id])).rows) {
        const { logEvent, notifyAthleteSide } = await import('../representation.js');
        await logEvent(c, m.id, user.id, 'system', i.suspended ? 'agent_suspended' : 'agent_reinstated');
        await notifyAthleteSide(c, m, { kind: 'representation_agent_status', title: i.suspended ? 'Your agent has been suspended' : 'Your agent was reinstated', body: i.suspended ? 'They have no access to your information while suspended.' : 'Their access resumes under the terms you agreed.' });
      }
      return { id: a.id, status: i.suspended ? 'suspended' : 'active' };
    });
  },
});
