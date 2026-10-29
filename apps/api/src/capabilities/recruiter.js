// Verified recruiter & scout workspace (issue #313). Verification reuses verification_cases (type 'recruiter'); athlete data is read live from the
// canonical sport profile / measurements / career tables under a scoped, time-limited, revocable grant that the athlete (or a guardian) decides.
// Notes, ratings and contact logs are the recruiter's own and are encrypted; nothing is ever deleted (archived or superseded, with history).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { toCsv } from '../csv.js';
import { isYouth, requireConsent } from '../youth.js';
import { assertMayMessageYouth } from '../compliance.js';
import {
  BASES, CRITERIA, GRANT_SCOPES, MAX_WINDOW_DAYS, PURPOSES, REQUEST_SQL, SCOPE_LABELS, STAGES,
  athleteAudience, dossier, grantState, isVerifiedRecruiter, ownRequest, presentRequest, requireAthleteSide, requireLive, requireVerifiedRecruiter, sweepExpired,
} from '../recruiter.js';

const TAG = 'Recruiter';
const R = ['recruiter'];
const iso = z.string().date();
const key = z.string().min(8).max(80);
const version = z.number().int().min(1);
const scopes = z.array(z.enum(GRANT_SCOPES)).min(1).max(GRANT_SCOPES.length);
const stale = (cur) => conflict('This was changed elsewhere. Reload and try again.', { code: 'stale_version', row_version: cur.row_version });
const endOf = (d) => new Date(`${d}T23:59:59.999Z`);
const today = () => new Date().toISOString().slice(0, 10);
const LOCK_REQ = 'SELECT * FROM recruiter_access_requests WHERE id=$1 FOR UPDATE';

// ------------------------------------------------------------------ recruiter identity
cap({
  name: 'get_recruiter_profile', method: 'GET', path: '/recruiter/profile', tag: TAG, auth: R,
  summary: 'Your recruiter workspace profile and verification status. Verification (identity + proof you recruit for an organisation) is required before you can ask any athlete for access; it never grants access on its own.',
  async handler({ user }) {
    const profile = await one('SELECT user_id, organisation_id, org_name, sport_ids, regions, bio, row_version, updated_at FROM recruiter_profiles WHERE user_id=$1', [user.id]);
    const sports = profile?.sport_ids?.length ? await many('SELECT id, slug, name, emoji FROM sports WHERE id = ANY($1) ORDER BY name, id', [profile.sport_ids]) : [];
    const org = profile?.organisation_id ? await one('SELECT id, name FROM organisations WHERE id=$1', [profile.organisation_id]) : null;
    const verification = await one(`SELECT id, case_no, status, submitted_at, decided_at, expires_at FROM verification_cases WHERE type='recruiter' AND subject_id=$1 ORDER BY submitted_at DESC LIMIT 1`, [user.id]);
    const verified = await isVerifiedRecruiter(user.id);
    const counts = await one(
      `SELECT count(*) FILTER (WHERE status='requested' AND expires_at > now())::int AS pending,
              count(*) FILTER (WHERE status='approved' AND expires_at > now())::int AS active
         FROM recruiter_access_requests WHERE recruiter_id=$1`, [user.id]);
    return { profile: profile ? { ...profile, sports, organisation: org } : null, verified, verification, ...counts };
  },
});

cap({
  name: 'save_recruiter_profile', method: 'POST', path: '/recruiter/profile', tag: TAG, auth: R,
  summary: 'Set who you recruit for: the organisation (pick one on the platform, or type its name if it is not listed), the sports and regions you cover and a short bio. Send row_version when updating.',
  input: z.object({
    organisation_id: id.nullable().optional(), org_name: z.string().trim().min(2).max(120).nullable().optional(),
    sport_ids: z.array(id).max(12).default([]), regions: z.array(z.string().trim().min(2).max(80)).max(12).default([]),
    bio: z.string().trim().max(600).nullable().optional(), row_version: version.optional(),
  }),
  async handler({ user }, i) {
    if (i.organisation_id && i.org_name) throw badRequest('Use either a listed organisation or a typed name, not both');
    if (i.organisation_id && !(await one("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [i.organisation_id]))) throw notFound('Organisation');
    if (i.sport_ids.length && (await one('SELECT count(*)::int AS n FROM sports WHERE id = ANY($1)', [i.sport_ids])).n !== new Set(i.sport_ids).size) throw notFound('Sport');
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM recruiter_profiles WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      const vals = [user.id, i.organisation_id ?? null, i.org_name ?? null, [...new Set(i.sport_ids)], [...new Set(i.regions)], i.bio ?? null];
      if (!cur) {
        await c.query('INSERT INTO recruiter_profiles(user_id, organisation_id, org_name, sport_ids, regions, bio) VALUES ($1,$2,$3,$4,$5,$6)', vals);
      } else {
        if (i.row_version !== cur.row_version) throw stale(cur);
        await c.query('UPDATE recruiter_profiles SET organisation_id=$2, org_name=$3, sport_ids=$4, regions=$5, bio=$6, row_version=row_version+1, updated_at=now() WHERE user_id=$1', vals);
      }
      return (await c.query('SELECT user_id, organisation_id, org_name, sport_ids, regions, bio, row_version, updated_at FROM recruiter_profiles WHERE user_id=$1', [user.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ finding an athlete (exact handle only; never a browsable list)
cap({
  name: 'find_athlete_for_recruiter', method: 'GET', path: '/recruiter/athletes/lookup', tag: TAG, auth: R,
  summary: 'Look up one athlete by their exact handle (shared by the athlete, a club or a passport link) so you can ask them for access. There is no search or browse of athletes; a young person shows only a name and that a guardian decides.',
  input: z.object({ handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/) }),
  async handler({ user }, i) {
    await requireVerifiedRecruiter(user);
    const u = await one("SELECT id, handle, display_name, avatar_emoji, avatar_color, avatar_url FROM users WHERE handle=$1 AND id <> $2 AND access_status IS DISTINCT FROM 'suspended'", [i.handle, user.id]);
    const sports = u ? await many("SELECT DISTINCT s.id, s.slug, s.name, s.emoji FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.role='athlete' ORDER BY s.name, s.id", [u.id]) : [];
    if (!u || !sports.length) throw notFound('Athlete');
    const youth = await isYouth(u.id);
    await audit(null, user.id, 'recruiter_lookup', 'users', u.id);
    const open = await many("SELECT id, sport_id, status FROM recruiter_access_requests WHERE recruiter_id=$1 AND athlete_id=$2 AND status IN ('requested','approved') AND expires_at > now()", [user.id, u.id]);
    return { ...u, is_youth: youth, decided_by: youth ? 'guardian' : 'athlete', sports, open_requests: open };
  },
});

// ------------------------------------------------------------------ access requests (recruiter side)
cap({
  name: 'create_recruiter_request', method: 'POST', path: '/recruiter/requests', tag: TAG, auth: R, status: 201,
  summary: `Ask one athlete for scoped access for a stated purpose and a limited time (up to ${MAX_WINDOW_DAYS} days). The athlete, or for a young person a verified guardian, chooses what to allow. Direct contact details are never available for a young person. Send a unique idempotency_key so a retry cannot create a second request.`,
  input: z.object({ athlete_id: id, sport: z.string(), scopes, purpose: z.enum(PURPOSES), message: z.string().trim().max(500).optional(), expires_on: iso, idempotency_key: key }),
  async handler({ user }, i) {
    await requireVerifiedRecruiter(user);
    if (i.athlete_id === user.id) throw badRequest('You cannot request access to yourself');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const days = (endOf(i.expires_on) - Date.now()) / 864e5;
    if (!(days > 0)) throw badRequest('Choose an end date in the future');
    if (days > MAX_WINDOW_DAYS) throw badRequest(`Access can be asked for at most ${MAX_WINDOW_DAYS} days at a time`);
    return tx(async (c) => {
      const prior = (await c.query('SELECT id FROM recruiter_access_requests WHERE recruiter_id=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (prior) return { ...(await presentRequest(await one(`${REQUEST_SQL} WHERE r.id=$1`, [prior.id]))), replayed: true };
      const has = (await c.query("SELECT 1 FROM active_sport_profiles WHERE user_id=$1 AND sport_id=$2 AND role='athlete'", [i.athlete_id, sport.id])).rows[0];
      if (!has) throw notFound('Athlete'); // same answer whether the person, the sport profile or the account does not exist
      const youth = await isYouth(i.athlete_id, c);
      if (youth && i.scopes.includes('contact')) throw badRequest('Direct contact details are not shared for young people. Ask for messages instead; a guardian takes part.');
      await sweepExpired(c, 'recruiter_id=$1 AND athlete_id=$2 AND sport_id=$3', [user.id, i.athlete_id, sport.id]);
      let row;
      try {
        row = (await c.query(
          `INSERT INTO recruiter_access_requests(recruiter_id, athlete_id, sport_id, scopes, purpose, message, expires_at, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [user.id, i.athlete_id, sport.id, [...new Set(i.scopes)], i.purpose, i.message ?? null, endOf(i.expires_on), i.idempotency_key])).rows[0];
      } catch (e) {
        if (e.code === '23505' && /recruiter_requests_one_open/.test(e.constraint ?? '')) throw conflict('You already have an open request for this athlete and sport', { code: 'duplicate_request' });
        throw e;
      }
      for (const to of await athleteAudience(i.athlete_id, c)) {
        await notify(c, to, { kind: 'recruiter_request', title: 'A recruiter asked for access', body: `${user.display_name} (verified recruiter) asked to see parts of ${youth ? 'a young person\'s' : 'your'} ${sport.name} profile for ${i.purpose}.`, data: { request_id: row.id }, dedupe_key: `recruiter_request:${row.id}:${to}` });
      }
      return presentRequest((await c.query(`${REQUEST_SQL} WHERE r.id=$1`, [row.id])).rows[0]);
    });
  },
});

cap({
  name: 'list_recruiter_requests', method: 'GET', path: '/recruiter/requests', tag: TAG, auth: R,
  summary: 'Your access requests, newest first, each with whether access is live right now and, if not, why (waiting, declined, expired, revoked, consent withdrawn, verification lapsed).',
  input: z.object({ status: z.enum(['requested', 'approved', 'declined', 'withdrawn', 'revoked', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    await sweepExpired({ query }, 'recruiter_id=$1', [user.id]);
    const rows = await many(
      `SELECT x.*, u.handle AS athlete_handle, u.display_name AS athlete_name, u.avatar_emoji, u.avatar_color
         FROM (${REQUEST_SQL}) x JOIN users u ON u.id = x.athlete_id WHERE x.recruiter_id=$1 AND ($2::text IS NULL OR x.status=$2)
        ORDER BY x.created_at DESC, x.id LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]);
    return Promise.all(rows.map(async (r) => ({ ...(await presentRequest(r)), is_youth: await isYouth(r.athlete_id) })));
  },
});

cap({
  name: 'withdraw_recruiter_request', method: 'POST', path: '/recruiter/requests/:id/withdraw', tag: TAG, auth: R,
  summary: 'Withdraw a waiting request, or end an approved grant yourself. The athlete is told; saved list entries stay with their data withheld.',
  input: z.object({ id, row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(LOCK_REQ, [i.id])).rows[0];
      if (!cur || cur.recruiter_id !== user.id) throw notFound('Access request');
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (!['requested', 'approved'].includes(cur.status)) return presentRequest(await one(`${REQUEST_SQL} WHERE r.id=$1`, [cur.id]));
      const next = cur.status === 'requested' ? 'withdrawn' : 'revoked';
      await c.query("UPDATE recruiter_access_requests SET status=$2, revoked_by=CASE WHEN $2='revoked' THEN $3::uuid END, revoked_at=CASE WHEN $2='revoked' THEN now() END, row_version=row_version+1, updated_at=now() WHERE id=$1", [cur.id, next, user.id]);
      for (const to of await athleteAudience(cur.athlete_id, c)) await notify(c, to, { kind: 'recruiter_withdrawn', title: 'A recruiter ended their request', body: `${user.display_name} ${next === 'withdrawn' ? 'withdrew their request' : 'ended their access'}.`, data: { request_id: cur.id } });
      return presentRequest((await c.query(`${REQUEST_SQL} WHERE r.id=$1`, [cur.id])).rows[0]);
    });
  },
});

cap({
  name: 'get_recruiter_athlete', method: 'GET', path: '/recruiter/requests/:id/athlete', tag: TAG, auth: R,
  summary: 'What this athlete has allowed you to see, read live: only the approved scopes (playing profile, shared measurements with units and dates, verified career timeline). Refused as soon as the grant expires, is revoked, your verification lapses or a guardian withdraws consent. Every read is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { request, scopes: live } = await requireLive(user, i.id);
    const full = await one(`${REQUEST_SQL} WHERE r.id=$1`, [request.id]);
    return dossier(full, live, user);
  },
});

cap({
  name: 'get_recruiter_contact', method: 'GET', path: '/recruiter/requests/:id/contact', tag: TAG, auth: R,
  summary: 'The athlete\'s direct contact details (email and, if they have one, phone), only while they have allowed the contact scope. Decryption is audit-logged. Never available for a young person; use messages.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { request } = await requireLive(user, i.id, 'contact');
    const u = await one('SELECT display_name, email_enc, phone_enc FROM users WHERE id=$1', [request.athlete_id]);
    await audit(null, user.id, 'decrypt_recruiter_contact', 'users', request.athlete_id);
    return { display_name: u.display_name, email: decrypt(u.email_enc, 'users.email'), phone: u.phone_enc ? decrypt(u.phone_enc, 'users.phone') : null, expires_at: request.expires_at };
  },
});

// ------------------------------------------------------------------ athlete / guardian side
cap({
  name: 'list_my_recruiter_requests', method: 'GET', path: '/me/recruiter-requests', tag: TAG,
  summary: 'Recruiter requests for you, or for a young person you are a verified guardian of (pass athlete_id). Shows who is asking, whether they are verified right now, what they want and why.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['requested', 'approved', 'declined', 'withdrawn', 'revoked', 'expired']).optional(), ...page }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId === user.id && (await isYouth(user.id))) {
      // a young person sees that a guardian is deciding, nothing more
      return [];
    }
    if (athleteId !== user.id) await requireAthleteSide(user, athleteId);
    const rows = await many(
      `SELECT x.*, u.handle AS recruiter_handle, u.display_name AS recruiter_name, u.avatar_emoji, u.avatar_color, p.org_name, o.name AS organisation
         FROM (${REQUEST_SQL}) x JOIN users u ON u.id = x.recruiter_id LEFT JOIN recruiter_profiles p ON p.user_id = x.recruiter_id LEFT JOIN organisations o ON o.id = p.organisation_id
        WHERE x.athlete_id=$1 AND ($2::text IS NULL OR x.status=$2) ORDER BY x.created_at DESC, x.id LIMIT $3 OFFSET $4`, [athleteId, i.status ?? null, i.limit, i.offset]);
    return Promise.all(rows.map(async (r) => ({ ...(await presentRequest(r)), recruiter_verified: await isVerifiedRecruiter(r.recruiter_id), scope_labels: SCOPE_LABELS })));
  },
});

cap({
  name: 'decide_recruiter_request', method: 'POST', path: '/me/recruiter-requests/:id/decision', tag: TAG,
  summary: 'Approve (all or some of the scopes asked, possibly for a shorter time) or decline a recruiter\'s request. For a young person only a verified guardian can decide, and only while a guardian\'s current "recruitment" consent is in force. The recruiter must still be verified.',
  input: z.object({ id, decision: z.enum(['approve', 'decline']), granted_scopes: scopes.optional(), expires_on: iso.optional(), note: z.string().trim().max(300).optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(LOCK_REQ, [i.id])).rows[0];
      if (!cur) throw notFound('Access request');
      await requireAthleteSide(user, cur.athlete_id, c);
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (cur.status !== 'requested') throw conflict(`This request is already ${cur.status}`, { code: 'already_decided', status: cur.status });
      if (new Date(cur.expires_at) <= new Date()) { await sweepExpired(c, 'id=$1', [cur.id]); throw conflict('This request has expired. Ask the recruiter to send a new one.', { code: 'expired' }); }
      const youth = await isYouth(cur.athlete_id, c);
      let granted = [];
      let until = cur.expires_at;
      if (i.decision === 'approve') {
        if (!(await isVerifiedRecruiter(cur.recruiter_id))) throw conflict('This recruiter\'s verification is no longer current', { code: 'recruiter_unverified' });
        if (youth) {
          await requireConsent(cur.athlete_id, 'recruitment', 'recruiters seeing their profile', c);
        }
        granted = [...new Set(i.granted_scopes ?? cur.scopes)];
        if (!granted.every((s) => cur.scopes.includes(s))) throw badRequest('You can only allow what was asked for');
        if (youth && granted.includes('contact')) throw badRequest('Direct contact details are not shared for young people');
        if (i.expires_on) {
          const e = endOf(i.expires_on);
          if (!(e > new Date())) throw badRequest('Choose an end date in the future');
          if (e > new Date(cur.expires_at)) throw badRequest('You cannot allow longer than the recruiter asked for');
          until = e;
        }
      }
      await c.query(
        `UPDATE recruiter_access_requests SET status=$2, granted_scopes=$3, expires_at=$4, decided_by=$5, decided_at=now(), decision_note=$6, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [cur.id, i.decision === 'approve' ? 'approved' : 'declined', granted, until, user.id, i.note ?? null]);
      await audit(c, user.id, i.decision === 'approve' ? 'approve_recruiter_access' : 'decline_recruiter_access', 'users', cur.athlete_id);
      await notify(c, cur.recruiter_id, { kind: 'recruiter_decision', title: i.decision === 'approve' ? 'Access approved' : 'Request declined', body: i.decision === 'approve' ? 'An athlete allowed you to see parts of their profile.' : 'An athlete declined your request.', data: { request_id: cur.id } });
      return presentRequest((await c.query(`${REQUEST_SQL} WHERE r.id=$1`, [cur.id])).rows[0]);
    });
  },
});

cap({
  name: 'revoke_recruiter_access', method: 'POST', path: '/me/recruiter-requests/:id/revoke', tag: TAG,
  summary: 'End a recruiter\'s access now. It takes effect on the very next read, message or export. Saved list entries stay with the recruiter but the athlete\'s data is withheld from them, and the message thread is closed.',
  input: z.object({ id, reason: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query(LOCK_REQ, [i.id])).rows[0];
      if (!cur) throw notFound('Access request');
      if (!isAdmin(user)) await requireAthleteSide(user, cur.athlete_id, c);
      if (!['requested', 'approved'].includes(cur.status)) return presentRequest(await one(`${REQUEST_SQL} WHERE r.id=$1`, [cur.id]));
      await c.query("UPDATE recruiter_access_requests SET status='revoked', revoked_by=$2, revoked_at=now(), decision_note=coalesce($3, decision_note), row_version=row_version+1, updated_at=now() WHERE id=$1", [cur.id, user.id, i.reason ?? null]);
      await c.query('UPDATE recruiter_threads SET closed_by=$2, closed_at=now() WHERE request_id=$1 AND closed_at IS NULL', [cur.id, user.id]);
      await audit(c, user.id, 'revoke_recruiter_access', 'users', cur.athlete_id);
      await notify(c, cur.recruiter_id, { kind: 'recruiter_revoked', title: 'Access ended', body: 'An athlete ended your access. Their data is no longer available to you.', data: { request_id: cur.id } });
      return presentRequest((await c.query(`${REQUEST_SQL} WHERE r.id=$1`, [cur.id])).rows[0]);
    });
  },
});

// ------------------------------------------------------------------ saved lists
const ENTRY_SQL = `
  SELECT e.id, e.list_id, e.athlete_id, e.request_id, e.stage, e.row_version, e.archived_at, e.created_at, e.updated_at,
         r.status AS grant_status, r.expires_at AS grant_expires_at, r.granted_scopes, r.recruiter_id, r.sport_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
         (SELECT round(avg(v.overall)::numeric, 1)::float FROM recruiter_evaluations v WHERE v.entry_id=e.id AND v.archived_at IS NULL) AS avg_overall,
         (SELECT count(*)::int FROM recruiter_evaluations v WHERE v.entry_id=e.id AND v.archived_at IS NULL) AS evaluations,
         (SELECT max(k.contacted_on)::text FROM recruiter_contacts k WHERE k.entry_id=e.id) AS last_contact_on,
         (SELECT min(k.follow_up_on)::text FROM recruiter_contacts k WHERE k.entry_id=e.id AND k.follow_up_on >= current_date AND NOT EXISTS (SELECT 1 FROM recruiter_contacts k2 WHERE k2.entry_id=e.id AND k2.contacted_on >= k.follow_up_on)) AS next_follow_up_on
    FROM recruiter_list_entries e JOIN recruiter_access_requests r ON r.id = e.request_id JOIN sports s ON s.id = r.sport_id`;

/** An entry as the recruiter sees it: athlete identity only while the grant is live; the pipeline fields are always theirs. */
async function presentEntry(row) {
  const g = await grantState({ ...row, status: row.grant_status, expires_at: row.grant_expires_at, recruiter_id: row.recruiter_id, athlete_id: row.athlete_id });
  const { granted_scopes, recruiter_id, ...rest } = row;
  const base = { ...rest, access: g.live ? 'live' : g.reason, scopes: g.scopes };
  if (!g.live) return { ...base, athlete: null, redacted: true };
  const a = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color, avatar_url FROM users WHERE id=$1', [row.athlete_id]);
  return { ...base, athlete: { ...a, is_youth: await isYouth(row.athlete_id) }, redacted: false };
}

const ownList = async (user, listId, client) => {
  const q = client ? (t, p) => client.query(t, p).then((x) => x.rows[0]) : one;
  const l = await q('SELECT * FROM recruiter_lists WHERE id=$1 AND recruiter_id=$2', [listId, user.id]);
  if (!l) throw notFound('List');
  return l;
};
const ownEntry = async (user, entryId, client) => {
  const q = client ? (t, p) => client.query(t, p).then((x) => x.rows[0]) : one;
  const e = await q(`${ENTRY_SQL} WHERE e.id=$1 AND r.recruiter_id=$2`, [entryId, user.id]);
  if (!e) throw notFound('List entry');
  return e;
};

cap({
  name: 'list_recruiter_lists', method: 'GET', path: '/recruiter/lists', tag: TAG, auth: R,
  summary: 'Your saved lists with how many athletes are at each pipeline stage.',
  input: z.object({ include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    return many(
      `SELECT l.id, l.name, l.sport_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, l.row_version, l.archived_at, l.created_at,
              (SELECT count(*)::int FROM recruiter_list_entries e WHERE e.list_id=l.id AND e.archived_at IS NULL) AS athletes,
              coalesce((SELECT jsonb_object_agg(g.stage, g.n) FROM (SELECT stage, count(*)::int AS n FROM recruiter_list_entries e WHERE e.list_id=l.id AND e.archived_at IS NULL GROUP BY stage) g), '{}'::jsonb) AS stages
         FROM recruiter_lists l LEFT JOIN sports s ON s.id = l.sport_id WHERE l.recruiter_id=$1 AND ($2::boolean OR l.archived_at IS NULL) ORDER BY l.created_at DESC, l.id`, [user.id, i.include_archived]);
  },
});

cap({
  name: 'create_recruiter_list', method: 'POST', path: '/recruiter/lists', tag: TAG, auth: R, status: 201,
  summary: 'Create a saved list (for example "Spring trials"), optionally for one sport.',
  input: z.object({ name: z.string().trim().min(2).max(80), sport: z.string().optional() }),
  async handler({ user }, i) {
    await requireVerifiedRecruiter(user);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    try {
      return await one('INSERT INTO recruiter_lists(recruiter_id, name, sport_id) VALUES ($1,$2,$3) RETURNING id, name, sport_id, row_version, archived_at, created_at', [user.id, i.name, sport?.id ?? null]);
    } catch (e) {
      if (e.code === '23505') throw conflict('You already have a list with that name', { code: 'duplicate_list' });
      throw e;
    }
  },
});

cap({
  name: 'update_recruiter_list', method: 'PATCH', path: '/recruiter/lists/:id', tag: TAG, auth: R,
  summary: 'Rename a list or archive / restore it (lists and their entries are never deleted).',
  input: z.object({ id, name: z.string().trim().min(2).max(80).optional(), archived: z.boolean().optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM recruiter_lists WHERE id=$1 AND recruiter_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!cur) throw notFound('List');
      if (cur.row_version !== i.row_version) throw stale(cur);
      try {
        return (await c.query(
          `UPDATE recruiter_lists SET name=coalesce($2, name), archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN coalesce(archived_at, now()) END, row_version=row_version+1, updated_at=now() WHERE id=$1
           RETURNING id, name, sport_id, row_version, archived_at, created_at`, [i.id, i.name ?? null, i.archived ?? null])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('You already have a list with that name', { code: 'duplicate_list' });
        throw e;
      }
    });
  },
});

cap({
  name: 'list_recruiter_entries', method: 'GET', path: '/recruiter/lists/:id/entries', tag: TAG, auth: R,
  summary: 'The athletes on a list with pipeline stage, average evaluation, last contact and next follow-up. Athletes whose access ended are shown without their identity or data ("access ended"), but their stage and your own scores stay.',
  input: z.object({ id, stage: z.enum(STAGES).optional(), ...page }),
  async handler({ user }, i) {
    await ownList(user, i.id);
    const rows = await many(`${ENTRY_SQL} WHERE e.list_id=$1 AND e.archived_at IS NULL AND ($2::text IS NULL OR e.stage=$2) ORDER BY e.created_at, e.id LIMIT $3 OFFSET $4`, [i.id, i.stage ?? null, i.limit, i.offset]);
    return Promise.all(rows.map(presentEntry));
  },
});

cap({
  name: 'add_recruiter_entry', method: 'POST', path: '/recruiter/lists/:id/entries', tag: TAG, auth: R, status: 201,
  summary: 'Save an athlete to a list. Only possible while you hold a live grant for them, so there is no way to build a list of people who have not allowed you to see them. Saving the same athlete twice returns the existing entry.',
  input: z.object({ id, request_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const list = (await c.query('SELECT * FROM recruiter_lists WHERE id=$1 AND recruiter_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!list) throw notFound('List');
      if (list.archived_at) throw conflict('Restore this list before adding to it');
      const { request } = await requireLive(user, i.request_id, null, c);
      if (list.sport_id && list.sport_id !== request.sport_id) throw badRequest('This list is for a different sport');
      const dupe = (await c.query('SELECT id FROM recruiter_list_entries WHERE list_id=$1 AND athlete_id=$2 AND archived_at IS NULL', [list.id, request.athlete_id])).rows[0];
      if (dupe) return { ...(await presentEntry(await ownEntry(user, dupe.id, c))), replayed: true };
      const e = (await c.query('INSERT INTO recruiter_list_entries(list_id, athlete_id, request_id) VALUES ($1,$2,$3) RETURNING id', [list.id, request.athlete_id, request.id])).rows[0];
      await c.query("INSERT INTO recruiter_entry_events(entry_id, action, to_stage, actor_id) VALUES ($1,'added','prospect',$2)", [e.id, user.id]);
      return presentEntry(await ownEntry(user, e.id, c));
    });
  },
});

cap({
  name: 'update_recruiter_entry', method: 'PATCH', path: '/recruiter/entries/:id', tag: TAG, auth: R,
  summary: 'Move an athlete between pipeline stages (prospect, shortlist, contacted, trial, offer, passed) or archive / restore the entry. A stale row_version is refused; every move is kept in the entry history.',
  input: z.object({ id, stage: z.enum(STAGES).optional(), archived: z.boolean().optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT e.* FROM recruiter_list_entries e JOIN recruiter_lists l ON l.id=e.list_id WHERE e.id=$1 AND l.recruiter_id=$2 FOR UPDATE OF e', [i.id, user.id])).rows[0];
      if (!cur) throw notFound('List entry');
      if (cur.row_version !== i.row_version) throw stale(cur);
      const stage = i.stage ?? cur.stage;
      const archive = i.archived === undefined ? !!cur.archived_at : i.archived;
      if (stage === cur.stage && archive === !!cur.archived_at) return presentEntry(await ownEntry(user, cur.id, c));
      try {
        await c.query('UPDATE recruiter_list_entries SET stage=$2, archived_at=CASE WHEN $3 THEN coalesce(archived_at, now()) END, row_version=row_version+1, updated_at=now() WHERE id=$1', [cur.id, stage, archive]);
      } catch (e) {
        if (e.code === '23505') throw conflict('This athlete is already on that list', { code: 'duplicate_entry' });
        throw e;
      }
      await c.query('INSERT INTO recruiter_entry_events(entry_id, action, from_stage, to_stage, actor_id) VALUES ($1,$2,$3,$4,$5)',
        [cur.id, stage !== cur.stage ? 'moved' : archive ? 'archived' : 'restored', cur.stage, stage, user.id]);
      return presentEntry(await ownEntry(user, cur.id, c));
    });
  },
});

cap({
  name: 'get_recruiter_entry', method: 'GET', path: '/recruiter/entries/:id', tag: TAG, auth: R,
  summary: 'One saved athlete with your evaluations, contact log and stage history. Your notes and contact summaries are withheld while the athlete\'s access is not live; ratings and dates stay.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await ownEntry(user, i.id);
    const entry = await presentEntry(row);
    const live = !entry.redacted;
    const evals = (await many(
      `SELECT id, basis, observed_on::text AS observed_on, ratings, overall, notes_enc, row_version, created_at, updated_at FROM recruiter_evaluations WHERE entry_id=$1 AND archived_at IS NULL ORDER BY observed_on DESC, id`, [i.id]))
      .map(({ notes_enc, ...e }) => ({ ...e, notes: live && notes_enc ? decrypt(notes_enc, 'recruiter_evaluations.notes') : null, withheld: !live && !!notes_enc }));
    const contacts = (await many('SELECT id, kind, contacted_on::text AS contacted_on, summary_enc, follow_up_on::text AS follow_up_on, created_at FROM recruiter_contacts WHERE entry_id=$1 ORDER BY contacted_on DESC, id', [i.id]))
      .map(({ summary_enc, ...k }) => ({ ...k, summary: live && summary_enc ? decrypt(summary_enc, 'recruiter_contacts.summary') : null, withheld: !live && !!summary_enc }));
    const events = await many('SELECT action, from_stage, to_stage, created_at FROM recruiter_entry_events WHERE entry_id=$1 ORDER BY created_at, id', [i.id]);
    return { ...entry, evaluations: evals, contacts, events, criteria: CRITERIA };
  },
});

// ------------------------------------------------------------------ evaluations
const ratings = z.object(Object.fromEntries(CRITERIA.map((k) => [k, z.number().int().min(1).max(5).optional()]))).strict().default({});

cap({
  name: 'save_recruiter_evaluation', method: 'POST', path: '/recruiter/entries/:id/evaluations', tag: TAG, auth: R, status: 201,
  summary: 'Record an evaluation of a saved athlete: ratings per criterion, an overall 1-5 score, what it was based on (live viewing, video, match report, trial, profile only), the date observed and private notes (encrypted). Needs a live grant; evaluations are private to you and the athlete never sees them.',
  input: z.object({ id, basis: z.enum(BASES), observed_on: iso, ratings, overall: z.number().int().min(1).max(5), notes: z.string().trim().max(2000).optional(), idempotency_key: key }),
  async handler({ user }, i) {
    if (i.observed_on > today()) throw badRequest('The observation date cannot be in the future');
    return tx(async (c) => {
      const prior = (await c.query('SELECT id FROM recruiter_evaluations WHERE recruiter_id=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (prior) return { id: prior.id, replayed: true };
      const e = await ownEntry(user, i.id, c);
      if (e.archived_at) throw conflict('Restore this entry before evaluating');
      await requireLive(user, e.request_id, null, c);
      const row = (await c.query(
        `INSERT INTO recruiter_evaluations(entry_id, recruiter_id, basis, observed_on, ratings, overall, notes_enc, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, basis, observed_on::text AS observed_on, ratings, overall, row_version, created_at`,
        [i.id, user.id, i.basis, i.observed_on, i.ratings, i.overall, i.notes ? encrypt(i.notes, 'recruiter_evaluations.notes') : null, i.idempotency_key])).rows[0];
      await c.query('INSERT INTO recruiter_evaluation_revisions(evaluation_id, row_version, snapshot, actor_id) VALUES ($1,1,$2,$3)', [row.id, { basis: i.basis, observed_on: i.observed_on, ratings: i.ratings, overall: i.overall, has_notes: !!i.notes }, user.id]);
      await audit(c, user.id, 'write_recruiter_evaluation', 'users', e.athlete_id);
      return row;
    });
  },
});

cap({
  name: 'update_recruiter_evaluation', method: 'PATCH', path: '/recruiter/evaluations/:id', tag: TAG, auth: R,
  summary: 'Correct an evaluation (ratings, overall, basis, date, notes) or archive it. Send the row_version you loaded; every version stays in its revision history.',
  input: z.object({ id, basis: z.enum(BASES).optional(), observed_on: iso.optional(), ratings: ratings.optional(), overall: z.number().int().min(1).max(5).optional(), notes: z.string().trim().max(2000).nullable().optional(), archived: z.boolean().optional(), row_version: version }),
  async handler({ user }, i) {
    if (i.observed_on && i.observed_on > today()) throw badRequest('The observation date cannot be in the future');
    return tx(async (c) => {
      const cur = (await c.query('SELECT *, observed_on::text AS observed_s FROM recruiter_evaluations WHERE id=$1 AND recruiter_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!cur) throw notFound('Evaluation');
      if (cur.row_version !== i.row_version) throw stale(cur);
      const e = await ownEntry(user, cur.entry_id, c);
      await requireLive(user, e.request_id, null, c);
      const next = { basis: i.basis ?? cur.basis, observed_on: i.observed_on ?? cur.observed_s, ratings: i.ratings ?? cur.ratings, overall: i.overall ?? cur.overall };
      const notes = i.notes === undefined ? cur.notes_enc : i.notes ? encrypt(i.notes, 'recruiter_evaluations.notes') : null;
      const row = (await c.query(
        `UPDATE recruiter_evaluations SET basis=$2, observed_on=$3, ratings=$4, overall=$5, notes_enc=$6, archived_at=CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN coalesce(archived_at, now()) END, row_version=row_version+1, updated_at=now() WHERE id=$1
         RETURNING id, basis, observed_on::text AS observed_on, ratings, overall, row_version, archived_at, updated_at`, [i.id, next.basis, next.observed_on, next.ratings, next.overall, notes, i.archived ?? null])).rows[0];
      await c.query('INSERT INTO recruiter_evaluation_revisions(evaluation_id, row_version, snapshot, actor_id) VALUES ($1,$2,$3,$4)', [row.id, row.row_version, { ...next, has_notes: !!notes, archived: !!row.archived_at }, user.id]);
      await audit(c, user.id, 'write_recruiter_evaluation', 'users', e.athlete_id);
      return row;
    });
  },
});

// ------------------------------------------------------------------ recruitment contact log
cap({
  name: 'log_recruiter_contact', method: 'POST', path: '/recruiter/entries/:id/contacts', tag: TAG, auth: R, status: 201,
  summary: 'Log a recruitment contact (call, email, meeting, message) with a private summary and an optional follow-up date. Needs a live grant. The log is append-only; follow-ups show on the list until a later contact is logged.',
  input: z.object({ id, kind: z.enum(['call', 'email', 'meeting', 'message', 'other']), contacted_on: iso, summary: z.string().trim().max(1000).optional(), follow_up_on: iso.optional(), idempotency_key: key }),
  async handler({ user }, i) {
    if (i.contacted_on > today()) throw badRequest('The contact date cannot be in the future');
    if (i.follow_up_on && i.follow_up_on < i.contacted_on) throw badRequest('The follow-up cannot be before the contact');
    return tx(async (c) => {
      const prior = (await c.query('SELECT id FROM recruiter_contacts WHERE recruiter_id=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (prior) return { id: prior.id, replayed: true };
      const e = await ownEntry(user, i.id, c);
      await requireLive(user, e.request_id, null, c);
      const row = (await c.query(
        `INSERT INTO recruiter_contacts(entry_id, recruiter_id, kind, contacted_on, summary_enc, follow_up_on, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, kind, contacted_on::text AS contacted_on, follow_up_on::text AS follow_up_on, created_at`,
        [i.id, user.id, i.kind, i.contacted_on, i.summary ? encrypt(i.summary, 'recruiter_contacts.summary') : null, i.follow_up_on ?? null, i.idempotency_key])).rows[0];
      if (e.stage === 'prospect' || e.stage === 'shortlist') {
        await c.query("UPDATE recruiter_list_entries SET stage='contacted', row_version=row_version+1, updated_at=now() WHERE id=$1", [e.id]);
        await c.query("INSERT INTO recruiter_entry_events(entry_id, action, from_stage, to_stage, actor_id) VALUES ($1,'moved',$2,'contacted',$3)", [e.id, e.stage, user.id]);
      }
      return row;
    });
  },
});

// ------------------------------------------------------------------ permission-controlled messaging
/** Who is this person on the request? The recruiter, the adult athlete, or a guardian of a young athlete (a young person cannot message alone). */
async function participant(user, r, client) {
  if (user.id === r.recruiter_id) return 'recruiter';
  return requireAthleteSide(user, r.athlete_id, client);
}

async function messageableRequest(user, requestId, client) {
  const q = client ? (t, p) => client.query(t, p).then((x) => x.rows[0]) : one;
  const r = await q('SELECT * FROM recruiter_access_requests WHERE id=$1', [requestId]);
  if (!r) throw notFound('Access request');
  const role = await participant(user, r, client).catch(() => { throw notFound('Access request'); });
  return { r, role };
}

cap({
  name: 'send_recruiter_message', method: 'POST', path: '/recruiter/requests/:id/messages', tag: TAG, status: 201,
  summary: 'Send a message on an access request. Allowed only while the athlete has allowed messages and the grant is live, and while the thread is open. Either side can write: the recruiter, the adult athlete, or for a young person a guardian (who answers on their behalf). Bodies are encrypted. Send a unique idempotency_key.',
  input: z.object({ id, body: z.string().trim().min(1).max(2000), idempotency_key: key }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const prior = (await c.query('SELECT m.id, m.thread_id FROM recruiter_messages m WHERE m.sender_id=$1 AND m.idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
      if (prior) return { id: prior.id, replayed: true };
      const { r, role } = await messageableRequest(user, i.id, c);
      const g = await grantState(r);
      if (!g.live || !g.scopes.includes('messages')) {
        const e = forbidden('Messaging is not active for this request');
        e.details = { code: 'access_not_live', reason: g.live ? 'scope_not_granted' : g.reason };
        throw e;
      }
      if (role === 'recruiter') await assertMayMessageYouth(c, user.id, r.athlete_id); // policy-driven safeguarding (#595)
      await c.query('INSERT INTO recruiter_threads(request_id) VALUES ($1) ON CONFLICT (request_id) DO NOTHING', [r.id]);
      const thread = (await c.query('SELECT * FROM recruiter_threads WHERE request_id=$1 FOR UPDATE', [r.id])).rows[0];
      if (thread.closed_at) throw conflict('This conversation has been closed', { code: 'thread_closed' });
      const m = (await c.query(
        'INSERT INTO recruiter_messages(thread_id, sender_id, sender_role, body_enc, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id, sender_role, created_at',
        [thread.id, user.id, role, encrypt(i.body, 'recruiter_messages.body'), i.idempotency_key])).rows[0];
      const to = role === 'recruiter' ? await athleteAudience(r.athlete_id, c) : [r.recruiter_id];
      for (const t of to) await notify(c, t, { kind: 'recruiter_message', title: 'New message', body: `${user.display_name} sent a message about a recruitment request.`, data: { request_id: r.id } });
      return m;
    });
  },
});

cap({
  name: 'list_recruiter_messages', method: 'GET', path: '/recruiter/requests/:id/messages', tag: TAG,
  summary: 'The conversation on an access request, oldest first. The recruiter can read it only while access is live; the athlete (or a young person\'s guardian) can always read their history. Every read of a thread is audit-logged.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { r, role } = await messageableRequest(user, i.id);
    const g = await grantState(r);
    if (role === 'recruiter' && (!g.live || !g.scopes.includes('messages'))) {
      const e = forbidden('Access to this conversation is not active');
      e.details = { code: 'access_not_live', reason: g.live ? 'scope_not_granted' : g.reason };
      throw e;
    }
    const thread = await one('SELECT id, closed_at FROM recruiter_threads WHERE request_id=$1', [r.id]);
    if (!thread) return { closed: false, can_send: g.live && g.scopes.includes('messages'), messages: [] };
    const rows = await many('SELECT m.id, m.sender_id, m.sender_role, m.body_enc, m.created_at, u.display_name AS sender FROM recruiter_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at, m.id LIMIT $2 OFFSET $3', [thread.id, i.limit, i.offset]);
    await audit(null, user.id, 'read_recruiter_thread', 'users', r.athlete_id);
    return { closed: !!thread.closed_at, can_send: !thread.closed_at && g.live && g.scopes.includes('messages'), messages: rows.map(({ body_enc, ...m }) => ({ ...m, mine: m.sender_id === user.id, body: decrypt(body_enc, 'recruiter_messages.body') })) };
  },
});

cap({
  name: 'set_recruiter_thread_closed', method: 'POST', path: '/me/recruiter-requests/:id/thread', tag: TAG,
  summary: 'Close (or reopen) the conversation with a recruiter without ending their other access. Only the athlete, or a young person\'s guardian.',
  input: z.object({ id, closed: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM recruiter_access_requests WHERE id=$1', [i.id])).rows[0];
      if (!r) throw notFound('Access request');
      await requireAthleteSide(user, r.athlete_id, c);
      if (role === 'recruiter') await assertMayMessageYouth(c, user.id, r.athlete_id); // policy-driven safeguarding (#595)
      await c.query('INSERT INTO recruiter_threads(request_id) VALUES ($1) ON CONFLICT (request_id) DO NOTHING', [r.id]);
      return (await c.query('UPDATE recruiter_threads SET closed_at=CASE WHEN $2 THEN coalesce(closed_at, now()) END, closed_by=CASE WHEN $2 THEN $3::uuid END WHERE request_id=$1 RETURNING id, closed_at', [r.id, i.closed, user.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ export
cap({
  name: 'export_recruiter_list', method: 'GET', path: '/recruiter/lists/:id/export', tag: TAG, auth: R,
  summary: 'Export a list as CSV. Only athletes whose access is live appear with name and handle; others show "access ended". No contact details, notes or private data are ever included. The export is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const list = await ownList(user, i.id);
    const rows = await many(`${ENTRY_SQL} WHERE e.list_id=$1 AND e.archived_at IS NULL ORDER BY e.created_at, e.id`, [list.id]);
    const out = [];
    for (const row of rows) {
      const e = await presentEntry(row);
      out.push({ athlete: e.redacted ? 'access ended' : e.athlete.display_name, handle: e.redacted ? '' : e.athlete.handle, sport: e.sport, stage: e.stage, access: e.access, access_until: e.grant_expires_at ? new Date(e.grant_expires_at).toISOString().slice(0, 10) : '', avg_overall: e.avg_overall ?? '', evaluations: e.evaluations, last_contact_on: e.last_contact_on ?? '', next_follow_up_on: e.next_follow_up_on ?? '' });
    }
    await audit(null, user.id, 'export_recruiter_list', 'recruiter_lists', list.id);
    return { filename: 'recruiter-list.csv', rows: out.length, csv: toCsv(['athlete', 'handle', 'sport', 'stage', 'access', 'access_until', 'avg_overall', 'evaluations', 'last_contact_on', 'next_follow_up_on'], out) };
  },
});
