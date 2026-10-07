import { z } from 'zod';
import { cap, id, page, roles } from '../registry.js';
import { one, many, query } from '../db.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { blindIndex, decryptFields, encrypt, encryptFields, hashPassword, newOpaqueToken, sha256, verifyPassword } from '../crypto.js';
import { audit, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { signToken } from '../auth.js';

const PII = ['full_name', 'phone', 'dob', 'national_id', 'address'];
const pii = {
  full_name: z.string().min(2).max(120).optional(),
  phone: z.string().min(5).max(30).optional(),
  dob: z.string().date().optional().describe('YYYY-MM-DD'),
  national_id: z.string().min(3).max(40).optional(),
  address: z.string().max(300).optional(),
};
const selfRoles = roles.filter((r) => r !== 'admin');
const profileRoles = ['athlete', 'coach', 'referee', 'physio', 'doctor'];

cap({
  name: 'register', method: 'POST', path: '/auth/register', tag: 'Identity', auth: 'public', status: 201,
  summary: 'Create an account. Email and all personal identification fields are encrypted at rest.',
  input: z.object({
    handle: z.string().regex(/^[a-z0-9_]{3,24}$/, '3-24 chars: a-z, 0-9, _'),
    display_name: z.string().min(1).max(60),
    email: z.string().email(),
    password: z.string().min(10).max(200),
    roles: z.array(z.enum(selfRoles)).min(1).default(['athlete']),
    avatar_emoji: z.string().max(8).optional(),
    avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    ...pii,
  }),
  async handler(_, i) {
    const idx = blindIndex(i.email);
    if (await one('SELECT 1 FROM users WHERE email_idx = $1 OR handle = $2', [idx, i.handle])) throw conflict('Email or handle already registered');
    const enc = encryptFields(i, 'users', PII);
    const u = await one(
      `INSERT INTO users (handle, display_name, roles, password_hash, email_enc, email_idx, full_name_enc, phone_enc, dob_enc, national_id_enc, address_enc, avatar_emoji, avatar_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,'😎'),coalesce($13,'#FF3D81')) RETURNING id, handle, display_name, roles, avatar_emoji, avatar_color`,
      [i.handle, i.display_name, i.roles, hashPassword(i.password), encrypt(i.email, 'users.email'), idx,
        enc.full_name_enc ?? null, enc.phone_enc ?? null, enc.dob_enc ?? null, enc.national_id_enc ?? null, enc.address_enc ?? null, i.avatar_emoji, i.avatar_color],
    );
    return { user: u, token: await signToken(u) };
  },
});

cap({
  name: 'login', method: 'POST', path: '/auth/login', tag: 'Identity', auth: 'public',
  summary: 'Exchange email + password for a bearer token.',
  input: z.object({ email: z.string().email(), password: z.string() }),
  async handler(_, i) {
    const u = await one('SELECT id, handle, display_name, roles, avatar_emoji, avatar_color, password_hash FROM users WHERE email_idx = $1', [blindIndex(i.email)]);
    // always run a hash to keep timing similar for unknown emails
    const ok = verifyPassword(i.password, u?.password_hash ?? hashPassword('x'.repeat(12)));
    if (!u || !ok) throw unauthorized('Invalid email or password');
    delete u.password_hash;
    return { user: u, token: await signToken(u) };
  },
});

cap({
  name: 'get_me', method: 'GET', path: '/me', tag: 'Identity', auth: 'user',
  summary: 'Your account including decrypted personal identification fields (access is audit-logged).',
  async handler({ user }) {
    const row = await one('SELECT * FROM users WHERE id = $1', [user.id]);
    await audit(null, user.id, 'read_pii', 'users', user.id);
    return {
      id: row.id, handle: row.handle, display_name: row.display_name, roles: row.roles, bio: row.bio,
      avatar_emoji: row.avatar_emoji, avatar_color: row.avatar_color, created_at: row.created_at,
      email: decryptFields(row, 'users', ['email']).email, ...decryptFields(row, 'users', PII),
    };
  },
});

cap({
  name: 'update_me', method: 'PATCH', path: '/me', tag: 'Identity', auth: 'user',
  summary: 'Update profile and (encrypted) personal identification fields.',
  input: z.object({
    display_name: z.string().min(1).max(60).optional(), bio: z.string().max(500).optional(),
    avatar_emoji: z.string().max(8).optional(), avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), ...pii,
  }),
  async handler({ user }, i) {
    const enc = encryptFields(i, 'users', PII);
    const sets = {};
    for (const k of ['display_name', 'bio', 'avatar_emoji', 'avatar_color']) if (i[k] !== undefined) sets[k] = i[k];
    Object.assign(sets, enc);
    const keys = Object.keys(sets);
    if (!keys.length) throw badRequest('Nothing to update');
    await query(`UPDATE users SET ${keys.map((k, n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [user.id, ...keys.map((k) => sets[k])]);
    return { ok: true, updated: keys.map((k) => k.replace(/_enc$/, '')) };
  },
});

cap({
  name: 'create_api_token', method: 'POST', path: '/me/tokens', tag: 'Identity', auth: 'user', status: 201,
  summary: 'Create a long-lived API token (for scripts and MCP agents). The secret is shown once.',
  input: z.object({ name: z.string().min(1).max(60) }),
  async handler({ user }, i) {
    const token = newOpaqueToken();
    const row = await one('INSERT INTO api_tokens(user_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id, name, created_at', [user.id, i.name, sha256(token)]);
    return { ...row, token };
  },
});
cap({
  name: 'list_api_tokens', method: 'GET', path: '/me/tokens', tag: 'Identity', auth: 'user', summary: 'List your API tokens (no secrets).',
  handler: ({ user }) => many('SELECT id, name, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at DESC', [user.id]),
});
cap({
  name: 'revoke_api_token', method: 'DELETE', path: '/me/tokens/:id', tag: 'Identity', auth: 'user', summary: 'Revoke an API token.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await query('UPDATE api_tokens SET revoked_at = now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [i.id, user.id]);
    if (!r.rowCount) throw notFound('Token');
    return { ok: true };
  },
});

cap({
  name: 'list_sports', method: 'GET', path: '/sports', tag: 'Directory', auth: 'public', summary: 'All supported sports.',
  handler: () => many('SELECT * FROM sports ORDER BY name'),
});

cap({
  name: 'search_people', method: 'GET', path: '/people', tag: 'Directory', auth: 'public',
  summary: 'Find athletes, coaches, referees, physios and doctors by handle/name, role or sport. Public fields only.',
  input: z.object({ q: z.string().optional(), role: z.enum(profileRoles).optional(), sport: z.string().optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT DISTINCT ${PUBLIC_USER} FROM users u LEFT JOIN sport_profiles p ON p.user_id = u.id
        WHERE ($1::text IS NULL OR u.handle ILIKE $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR p.role = $2) AND ($3::uuid IS NULL OR p.sport_id = $3)
        ORDER BY u.display_name LIMIT $4 OFFSET $5`,
      [i.q ?? null, i.role ?? null, sport?.id ?? null, i.limit, i.offset],
    );
  },
});

cap({
  name: 'get_person', method: 'GET', path: '/people/:id', tag: 'Directory', auth: 'public',
  summary: 'Public profile: roles per sport, trophy cabinet counts, average testimonial rating. No personal identification data.',
  input: z.object({ id }),
  async handler(_, i) {
    const u = await one(`SELECT ${PUBLIC_USER}, u.created_at FROM users u WHERE u.id = $1`, [i.id]);
    if (!u) throw notFound('Person');
    const [profiles, awards, rating, teams] = await Promise.all([
      many('SELECT p.role, p.level, p.position, s.slug, s.name AS sport, s.emoji FROM sport_profiles p JOIN sports s ON s.id = p.sport_id WHERE p.user_id = $1', [i.id]),
      many('SELECT kind, count(*)::int AS n FROM awards WHERE user_id = $1 GROUP BY kind', [i.id]),
      one("SELECT round(avg(rating),2) AS avg, count(*)::int AS n FROM testimonials WHERE subject_type='user' AND subject_id=$1", [i.id]),
      many("SELECT t.id, t.name, t.emoji, t.color, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id=$1 AND m.status='active'", [i.id]),
    ]);
    return { ...u, sport_profiles: profiles, awards, rating, teams };
  },
});

cap({
  name: 'add_sport_profile', method: 'POST', path: '/me/sport-profiles', tag: 'Identity', auth: 'user', status: 201,
  summary: 'Declare yourself as athlete/coach/referee/physio/doctor in a sport. License numbers are encrypted.',
  input: z.object({
    sport: z.string().describe('sport slug or id'), role: z.enum(profileRoles),
    level: z.enum(['beginner', 'amateur', 'semi_pro', 'pro']).default('beginner'),
    position: z.string().max(60).optional(), license_no: z.string().max(60).optional(),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    return one(
      `INSERT INTO sport_profiles (user_id, sport_id, role, level, position, license_no_enc) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, sport_id, role) DO UPDATE SET level = EXCLUDED.level, position = EXCLUDED.position, license_no_enc = coalesce(EXCLUDED.license_no_enc, sport_profiles.license_no_enc)
       RETURNING id, sport_id, role, level, position`,
      [user.id, sport.id, i.role, i.level, i.position ?? null, encrypt(i.license_no, 'sport_profiles.license_no')],
    );
  },
});
