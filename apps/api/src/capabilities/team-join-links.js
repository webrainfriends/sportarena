// Instant team joining by shareable link / QR code (gaps audit, feature 4).
// Three modes: open (direct join), request (manager reviews), role_specific (direct join to a specific role).
// Codes are 8-char collision-resistant uppercase alphanum. Rate-limited at gateway level.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { canManageTeam } from './teams.js';

const TAG = 'Team join links';
const CONSONANTS = 'BCDFGHJKLMNPQRSTVWXYZ';
const VOWELS = 'AEIOU';
const DIGITS = '23456789';

function genCode() {
  // Pattern: 3 chars (mix of consonants/vowels) + hyphen + 3 chars + 1 digit
  // Readable, pronounceable-ish, no ambiguous chars (0O, 1I)
  const rnd = (s) => s[Math.floor(Math.random() * s.length)];
  const a = rnd(CONSONANTS) + rnd(VOWELS) + rnd(CONSONANTS);
  const b = rnd(CONSONANTS) + rnd(VOWELS) + rnd(CONSONANTS);
  return `${a}-${b}${rnd(DIGITS)}`;
}

async function requireManager(user, teamId) {
  const team = await one('SELECT * FROM teams WHERE id=$1', [teamId]);
  if (!team) throw notFound('Team');
  if (!await canManageTeam(user, team)) throw forbidden('Team manager access required');
  return team;
}

cap({
  name: 'create_team_join_link', method: 'POST', path: '/teams/:team_id/join-links', tag: TAG,
  summary: 'Create a shareable invite link for a team (manager)',
  auth: 'user',
  input: z.object({
    team_id: id,
    mode: z.enum(['open','request','role_specific']),
    role: z.enum(['player','volunteer','coach','manager','physio']).default('player'),
    max_uses: z.number().int().min(1).optional(),
    expires_at: z.string().datetime().optional(),
    age_min: z.number().int().min(0).optional(),
    age_max: z.number().int().min(0).optional(),
    guardian_required: z.boolean().default(false),
    federation_auto_register: z.boolean().default(false),
  }),
  handler: async ({ user }, { team_id, mode, role, max_uses, expires_at, age_min, age_max, guardian_required, federation_auto_register }) => {
    await requireManager(user, team_id);
    // generate unique code with up to 10 retries for collision avoidance
    let code;
    for (let i = 0; i < 10; i++) {
      const candidate = genCode();
      const existing = await one('SELECT id FROM team_join_links WHERE code=$1 AND revoked_at IS NULL', [candidate]);
      if (!existing) { code = candidate; break; }
    }
    if (!code) throw badRequest('Could not generate a unique code — please try again');
    const link = await one(
      `INSERT INTO team_join_links(team_id,created_by,code,mode,role,max_uses,expires_at,age_min,age_max,guardian_required,federation_auto_register)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [team_id, user.id, code, mode, role, max_uses ?? null, expires_at ?? null, age_min ?? null, age_max ?? null, guardian_required, federation_auto_register]
    );
    return {
      link: {
        ...link,
        deep_link_url: `https://app.sportarena.com/join/${code}`,
        qr_data: code,
      },
    };
  },
});

cap({
  name: 'list_team_join_links', method: 'GET', path: '/teams/:team_id/join-links', tag: TAG,
  summary: 'List active invite links for a team (manager)',
  auth: 'user',
  input: z.object({ team_id: id }),
  handler: async ({ user }, { team_id }) => {
    await requireManager(user, team_id);
    const links = await many(
      `SELECT l.*,
        (SELECT MAX(r.joined_at) FROM team_join_referrals r WHERE r.link_id=l.id) AS last_used,
        (SELECT COUNT(*) FROM team_join_requests r WHERE r.link_id=l.id AND r.status='pending') AS pending_request_count
       FROM team_join_links l WHERE l.team_id=$1 AND l.revoked_at IS NULL ORDER BY l.created_at DESC`,
      [team_id]
    );
    return { links: links.map(l => ({ ...l, deep_link_url: `https://app.sportarena.com/join/${l.code}`, qr_data: l.code })) };
  },
});

cap({
  name: 'revoke_team_join_link', method: 'DELETE', path: '/join-links/:id', tag: TAG,
  summary: 'Revoke an invite link (manager)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: linkId }) => {
    const link = await one('SELECT * FROM team_join_links WHERE id=$1', [linkId]);
    if (!link) throw notFound('Join link');
    await requireManager(user, link.team_id);
    await one('UPDATE team_join_links SET revoked_at=now() WHERE id=$1', [linkId]);
    return { revoked: true };
  },
});

cap({
  name: 'get_team_by_join_code', method: 'GET', path: '/join/:code', tag: TAG,
  summary: 'Look up team info by join code (public — for the join landing page)',
  auth: 'public',
  input: z.object({ code: z.string().min(4).max(20) }),
  handler: async (_, { code }) => {
    const link = await one(
      `SELECT l.*, t.name AS team_name, t.emoji AS team_emoji, t.avatar_url AS team_logo,
              s.name AS sport_name, s.slug AS sport_slug,
              (SELECT COUNT(*) FROM team_members WHERE team_id=l.team_id AND left_at IS NULL) AS member_count
       FROM team_join_links l
       JOIN teams t ON t.id=l.team_id
       LEFT JOIN sports s ON s.id=t.sport_id
       WHERE l.code=$1 AND l.revoked_at IS NULL`,
      [code]
    );
    if (!link) throw notFound('Join link');
    return {
      link: {
        id: link.id,
        code: link.code,
        team_name: link.team_name,
        team_emoji: link.team_emoji,
        team_logo: link.team_logo,
        sport_name: link.sport_name,
        sport_slug: link.sport_slug,
        member_count: Number(link.member_count),
        mode: link.mode,
        role: link.role,
        age_min: link.age_min,
        age_max: link.age_max,
        guardian_required: link.guardian_required,
        is_expired: link.expires_at ? new Date(link.expires_at) < new Date() : false,
        is_full: link.max_uses != null && link.used_count >= link.max_uses,
      },
    };
  },
});

cap({
  name: 'join_team_by_code', method: 'POST', path: '/join/:code', tag: TAG,
  summary: 'Join a team using an invite code',
  auth: 'user',
  input: z.object({
    code: z.string().min(4).max(20),
    managed_child_id: id.optional(),
  }),
  handler: async ({ user }, { code, managed_child_id }) => {
    const link = await one('SELECT * FROM team_join_links WHERE code=$1 AND revoked_at IS NULL', [code]);
    if (!link) throw notFound('Join link');
    if (link.expires_at && new Date(link.expires_at) < new Date()) throw badRequest('This link has expired');
    if (link.max_uses != null && link.used_count >= link.max_uses) throw badRequest('This link is full');
    const actingUserId = managed_child_id ?? user.id;
    if (managed_child_id) {
      const child = await one('SELECT * FROM users WHERE id=$1 AND managed_by_guardian_id=$2', [managed_child_id, user.id]);
      if (!child) throw forbidden('Not a managed child of this guardian');
    }
    // age gate
    if (link.age_min != null || link.age_max != null) {
      const target = await one('SELECT dob_enc FROM users WHERE id=$1', [actingUserId]);
      if (target?.dob_enc) {
        const dob = target.dob_enc; // decrypt only if needed
        const { decrypt: dec } = await import('../crypto.js');
        const dobStr = dec(dob);
        const age = Math.floor((Date.now() - new Date(dobStr)) / (365.25 * 86400000));
        if (link.age_min != null && age < link.age_min) throw badRequest(`Minimum age for this link is ${link.age_min}`);
        if (link.age_max != null && age > link.age_max) throw badRequest(`Maximum age for this link is ${link.age_max}`);
      }
    }
    // guardian required check
    if (link.guardian_required) {
      const hasGuardian = await one('SELECT id FROM guardian_links WHERE youth_id=$1 AND status=\'active\' LIMIT 1', [actingUserId]);
      if (!hasGuardian) throw badRequest('A verified guardian link is required to join this team');
    }
    if (link.mode === 'open' || link.mode === 'role_specific') {
      // check not already a member
      const existing = await one('SELECT id FROM team_members WHERE team_id=$1 AND user_id=$2 AND left_at IS NULL', [link.team_id, actingUserId]);
      if (existing) throw conflict('Already a member of this team');
      await tx(async (c) => {
        await c.query(
          'INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [link.team_id, actingUserId, link.role]
        );
        await c.query('UPDATE team_join_links SET used_count=used_count+1 WHERE id=$1', [link.id]);
        if (managed_child_id) {
          await c.query('INSERT INTO team_join_referrals(link_id,referrer_id,referred_id) VALUES($1,$2,$3)', [link.id, user.id, managed_child_id]);
        } else {
          await c.query('INSERT INTO team_join_referrals(link_id,referrer_id,referred_id) VALUES($1,$2,$3)', [link.id, user.id, user.id]);
        }
      });
      return { joined: true, team_id: link.team_id, role: link.role };
    } else {
      // mode === 'request'
      const existing = await one('SELECT id FROM team_join_requests WHERE link_id=$1 AND requester_id=$2', [link.id, actingUserId]);
      if (existing) throw conflict('Already requested to join via this link');
      const req = await one(
        'INSERT INTO team_join_requests(link_id,requester_id,managed_child_id) VALUES($1,$2,$3) RETURNING *',
        [link.id, actingUserId, managed_child_id ?? null]
      );
      // notify team managers
      const managers = await many(
        `SELECT DISTINCT u.id FROM team_members tm JOIN users u ON u.id=tm.user_id
         WHERE tm.team_id=$1 AND tm.role IN ('captain','manager','coach') AND tm.left_at IS NULL`,
        [link.team_id]
      );
      for (const m of managers) {
        await notify(m.id, {
          title: 'New join request',
          body: `${user.display_name} wants to join your team`,
          data: { type: 'join_request', request_id: req.id, team_id: link.team_id },
        });
      }
      return { requested: true, request_id: req.id };
    }
  },
});

cap({
  name: 'list_join_requests', method: 'GET', path: '/teams/:team_id/join-requests', tag: TAG,
  summary: 'List pending join requests (manager)',
  auth: 'user',
  input: z.object({ team_id: id }),
  handler: async ({ user }, { team_id }) => {
    await requireManager(user, team_id);
    const requests = await many(
      `SELECT r.*, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color,
              l.role, l.code AS link_code, l.mode
       FROM team_join_requests r
       JOIN team_join_links l ON l.id=r.link_id
       JOIN users u ON u.id=r.requester_id
       WHERE l.team_id=$1 AND r.status='pending'
       ORDER BY r.created_at`,
      [team_id]
    );
    return { requests };
  },
});

cap({
  name: 'decide_join_request', method: 'PATCH', path: '/join-requests/:id', tag: TAG,
  summary: 'Approve or decline a join request (manager)',
  auth: 'user',
  input: z.object({
    id,
    decision: z.enum(['approved','declined']),
    note: z.string().max(500).optional(),
  }),
  handler: async ({ user }, { id: requestId, decision, note }) => {
    const req = await one(
      `SELECT r.*, l.team_id, l.role, l.id AS link_id FROM team_join_requests r JOIN team_join_links l ON l.id=r.link_id WHERE r.id=$1`,
      [requestId]
    );
    if (!req) throw notFound('Join request');
    await requireManager(user, req.team_id);
    if (req.status !== 'pending') throw badRequest('Request already decided');
    await tx(async (c) => {
      await c.query(
        'UPDATE team_join_requests SET status=$1, decided_by=$2, decided_at=now(), note_enc=$3 WHERE id=$4',
        [decision, user.id, note ? encrypt(note) : null, requestId]
      );
      if (decision === 'approved') {
        await c.query(
          'INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [req.team_id, req.requester_id, req.role]
        );
        await c.query('UPDATE team_join_links SET used_count=used_count+1 WHERE id=$1', [req.link_id]);
        await c.query('INSERT INTO team_join_referrals(link_id,referrer_id,referred_id) VALUES($1,$2,$3)', [req.link_id, req.requester_id, req.requester_id]);
      }
    });
    await notify(req.requester_id, {
      title: decision === 'approved' ? 'Join request approved!' : 'Join request update',
      body: decision === 'approved' ? 'Your request to join the team has been approved!' : 'Your join request was not taken forward.',
      data: { type: 'join_decision', request_id: requestId, decision },
    });
    return { decision };
  },
});

cap({
  name: 'get_my_join_request_status', method: 'GET', path: '/me/join-requests', tag: TAG,
  summary: 'Get my pending and decided join requests',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    const requests = await many(
      `SELECT r.*, l.role, l.code, t.name AS team_name, t.emoji AS team_emoji
       FROM team_join_requests r
       JOIN team_join_links l ON l.id=r.link_id
       JOIN teams t ON t.id=l.team_id
       WHERE r.requester_id=$1 ORDER BY r.created_at DESC`,
      [user.id]
    );
    return { requests };
  },
});

cap({
  name: 'get_join_link_referrals', method: 'GET', path: '/join-links/:id/referrals', tag: TAG,
  summary: 'Get referral summary for a join link (manager)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: linkId }) => {
    const link = await one('SELECT * FROM team_join_links WHERE id=$1', [linkId]);
    if (!link) throw notFound('Join link');
    await requireManager(user, link.team_id);
    const summary = await many(
      `SELECT u.id, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color,
              COUNT(*) AS referral_count
       FROM team_join_referrals r JOIN users u ON u.id=r.referrer_id
       WHERE r.link_id=$1 AND r.referrer_id != r.referred_id
       GROUP BY u.id ORDER BY referral_count DESC LIMIT 20`,
      [linkId]
    );
    const total = await one('SELECT COUNT(*) AS n FROM team_join_referrals WHERE link_id=$1', [linkId]);
    return { total: Number(total.n), top_referrers: summary };
  },
});
