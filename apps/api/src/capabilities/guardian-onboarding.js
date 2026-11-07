// Parent-first creation of managed child profiles (gaps audit, feature 3).
// A guardian creates a "managed" account for their child — the child has no login credential.
// All PII (name, DOB, medical info) is field-level encrypted. Medical card decrypts are audit-logged.
// When the child reaches near-independence age the guardian can issue a claim link.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { blindIndex, decrypt, encrypt, newOpaqueToken } from '../crypto.js';
import { config } from '../config.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { ageOf, getPolicy, guardianLink, refreshYouth } from '../youth.js';

const TAG = 'Guardian onboarding';
const BLOOD_TYPES = ['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'];

// Every *_enc value is bound to its column (AAD context), like the rest of the platform.
const MC = (table, field) => `${table}.${field}`;
const dec = (table, field, v) => (v ? decrypt(v, MC(table, field)) : null);
const enc = (table, field, v) => (v ? encrypt(v, MC(table, field)) : null);

/** The managing parent, a co-guardian with a live guardian link, or an admin. Anyone else learns nothing about the profile. */
async function requireOwnChild(user, childId) {
  const child = await one('SELECT * FROM users WHERE id=$1', [childId]);
  if (!child) throw notFound('Child profile');
  if (child.managed_by_guardian_id !== user.id && !isAdmin(user)) {
    if (!(await guardianLink(user.id, childId))) throw notFound('Child profile');
  }
  return child;
}

/** Sports of a person as catalogue rows (live sport profiles only). */
const sportsOf = (userIds) => many(
  `SELECT sp.user_id, s.slug, s.name FROM sport_profiles sp JOIN sports s ON s.id=sp.sport_id
    WHERE sp.user_id = ANY($1::uuid[]) AND sp.archived_at IS NULL ORDER BY sp.is_default DESC, s.name`, [userIds]);

/** Replace a child's sports by catalogue slug. Removed sports are archived, never deleted. */
async function setSports(c, childId, slugs) {
  const rows = (await c.query('SELECT id, slug FROM sports WHERE slug = ANY($1::text[])', [slugs])).rows;
  const unknown = slugs.filter((x) => !rows.some((r) => r.slug === x));
  if (unknown.length) throw badRequest(`Unknown sport: ${unknown.join(', ')}`);
  await c.query("UPDATE sport_profiles SET archived_at=now() WHERE user_id=$1 AND role='athlete' AND archived_at IS NULL AND NOT (sport_id = ANY($2::uuid[]))", [childId, rows.map((r) => r.id)]);
  const hasDefault = (await c.query('SELECT 1 FROM sport_profiles WHERE user_id=$1 AND is_default AND archived_at IS NULL', [childId])).rows.length > 0;
  let first = !hasDefault;
  for (const r of rows) {
    await c.query(
      `INSERT INTO sport_profiles(user_id, sport_id, role, is_default) VALUES($1,$2,'athlete',$3)
       ON CONFLICT (user_id, sport_id, role) DO UPDATE SET archived_at=NULL`, [childId, r.id, first]);
    first = false;
  }
}

cap({
  name: 'create_managed_child_profile', method: 'POST', path: '/me/managed-children', tag: TAG,
  summary: 'Create a managed child profile (guardian)',
  auth: 'user',
  input: z.object({
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sports: z.array(z.string().max(80)).max(20).default([]),
  }),
  handler: async ({ user }, { first_name, last_name, dob, sports }) => {
    if (isNaN(new Date(dob))) throw badRequest('Date of birth is not a valid date');
    if (new Date(dob) > new Date()) throw badRequest('Date of birth cannot be in the future');
    const displayName = `${first_name} ${last_name}`.trim();
    const handle = `m_${randomBytes(6).toString('hex')}`; // matches users_handle_check; a managed child has no sign-in
    const placeholderEmail = `${handle}@managed.invalid`;
    const parent = await one('SELECT jurisdiction FROM users WHERE id=$1', [user.id]);
    const childId = await tx(async (c) => {
      const u = (await c.query(
        `INSERT INTO users(handle, display_name, roles, password_hash, email_enc, email_idx, full_name_enc, dob_enc, is_managed, managed_by_guardian_id, jurisdiction)
         VALUES($1,$2,'{athlete}','!managed-no-login',$3,$4,$5,$6,true,$7,$8) RETURNING id`,
        [handle, displayName, encrypt(placeholderEmail, 'users.email'), blindIndex(placeholderEmail),
         encrypt(displayName, 'users.full_name'), encrypt(dob, 'users.dob'), user.id, parent?.jurisdiction ?? 'default']
      )).rows[0];
      if (sports.length) await setSports(c, u.id, sports);
      await refreshYouth(u.id, user.id, c);
      // the parent who creates the profile holds the live guardian link, so consent, scopes and revocation work like for any other child
      const policy = await getPolicy(parent?.jurisdiction ?? 'default', c);
      const l = (await c.query(
        `INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by, decided_by, decided_at, policy_jurisdiction, policy_version, expires_at)
         VALUES($1,$2,'parent','active',$1,$1,now(),$3,$4, now() + make_interval(days => $5)) RETURNING id`,
        [user.id, u.id, policy.jurisdiction, policy.version, policy.link_valid_days ?? 730]
      )).rows[0];
      await c.query("INSERT INTO guardian_link_events(link_id, actor_id, action, from_status, to_status, reason) VALUES($1,$2,'create_managed_child',NULL,'active','parent created managed profile')", [l.id, user.id]);
      await audit(c, user.id, 'managed_child_created', 'users', u.id);
      return u.id;
    });
    const rows = await sportsOf([childId]);
    return {
      child: { id: childId, display_name: displayName, is_managed: true, sports: rows.map((r) => r.name), sport_slugs: rows.map((r) => r.slug) },
    };
  },
});

cap({
  name: 'list_managed_children', method: 'GET', path: '/me/managed-children', tag: TAG,
  summary: 'List all managed child profiles for this guardian',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    const children = await many(
      `SELECT u.id, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color,
              u.dob_enc, u.claimed_at,
              EXISTS (SELECT 1 FROM user_medical_cards WHERE user_id=u.id) AS has_medical,
              EXISTS (SELECT 1 FROM user_kit_sizes WHERE user_id=u.id) AS has_kit,
              EXISTS (SELECT 1 FROM user_academic_schedules WHERE user_id=u.id) AS has_academic,
              EXISTS (SELECT 1 FROM user_biometrics WHERE user_id=u.id) AS has_biometrics
       FROM users u WHERE u.managed_by_guardian_id=$1 AND u.is_managed ORDER BY u.display_name`,
      [user.id]
    );
    const sportRows = children.length ? await sportsOf(children.map((c) => c.id)) : [];
    if (children.some((c) => c.dob_enc)) await audit(null, user.id, 'managed_children_dob_viewed', 'users', user.id);
    return {
      children: children.map(c => {
        const dob = dec('users', 'dob', c.dob_enc);
        const age = dob ? ageOf(dob) : null;
        const checks = { profile: true, medical: c.has_medical, kit: c.has_kit, academic: c.has_academic, biometrics: c.has_biometrics, photo: !!c.avatar_url };
        const done = Object.values(checks).filter(Boolean).length;
        const mine = sportRows.filter((r) => r.user_id === c.id);
        return {
          id: c.id,
          display_name: c.display_name,
          avatar_url: c.avatar_url, avatar_emoji: c.avatar_emoji, avatar_color: c.avatar_color,
          age, dob,
          sports: mine.map((r) => r.name),
          sport_slugs: mine.map((r) => r.slug),
          claimed_at: c.claimed_at,
          onboarding_pct: Math.round((done / 6) * 100),
          checks,
        };
      }),
    };
  },
});

cap({
  name: 'get_managed_child', method: 'GET', path: '/me/managed-children/:child_id', tag: TAG,
  summary: 'Get full decrypted profile of a managed child',
  auth: 'user',
  input: z.object({ child_id: id }),
  handler: async ({ user }, { child_id }) => {
    const child = await requireOwnChild(user, child_id);
    const [medical, kit, academic, biometrics] = await Promise.all([
      one('SELECT * FROM user_medical_cards WHERE user_id=$1', [child_id]),
      one('SELECT * FROM user_kit_sizes WHERE user_id=$1', [child_id]),
      one('SELECT * FROM user_academic_schedules WHERE user_id=$1', [child_id]),
      one('SELECT * FROM user_biometrics WHERE user_id=$1', [child_id]),
    ]);
    const dob = dec('users', 'dob', child.dob_enc);
    const sportRows = await sportsOf([child_id]);
    await audit(null, user.id, 'managed_child_profile_viewed', 'users', child_id);
    return {
      child: {
        id: child.id,
        display_name: child.display_name,
        avatar_url: child.avatar_url,
        dob,
        age: dob ? ageOf(dob) : null,
        sports: sportRows.map((r) => r.name),
        sport_slugs: sportRows.map((r) => r.slug),
        is_managed: child.is_managed,
        claimed_at: child.claimed_at,
      },
      medical: medical ? {
        blood_type: medical.blood_type,
        allergies: medical.allergies,
        conditions: dec('user_medical_cards', 'conditions', medical.conditions_enc),
        medications: dec('user_medical_cards', 'medications', medical.medications_enc),
        gp_name: dec('user_medical_cards', 'gp_name', medical.gp_name_enc),
        gp_phone: dec('user_medical_cards', 'gp_phone', medical.gp_phone_enc),
        emergency_contact_name: dec('user_medical_cards', 'emergency_contact_name', medical.emergency_contact_name_enc),
        emergency_contact_phone: dec('user_medical_cards', 'emergency_contact_phone', medical.emergency_contact_phone_enc),
        emergency_contact_relation: medical.emergency_contact_relation,
      } : null,
      kit: kit ? {
        shirt_size: dec('user_kit_sizes', 'shirt_size', kit.shirt_size_enc),
        shorts_size: dec('user_kit_sizes', 'shorts_size', kit.shorts_size_enc),
        boot_size: dec('user_kit_sizes', 'boot_size', kit.boot_size_enc),
      } : null,
      academic: academic ? {
        school_name: dec('user_academic_schedules', 'school_name', academic.school_name_enc),
        schedule: dec('user_academic_schedules', 'schedule', academic.schedule_enc),
      } : null,
      biometrics: biometrics ? {
        height_cm: dec('user_biometrics', 'height_cm', biometrics.height_cm_enc),
        weight_kg: dec('user_biometrics', 'weight_kg', biometrics.weight_kg_enc),
        wingspan_cm: dec('user_biometrics', 'wingspan_cm', biometrics.wingspan_cm_enc),
      } : null,
    };
  },
});

cap({
  name: 'update_managed_child_profile', method: 'PATCH', path: '/me/managed-children/:child_id', tag: TAG,
  summary: 'Update name, DOB, sports, photo for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    first_name: z.string().min(1).max(100).optional(),
    last_name: z.string().min(1).max(100).optional(),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sports: z.array(z.string().max(80)).max(20).optional(),
    photo_url: z.string().url().optional(),
  }),
  handler: async ({ user }, { child_id, first_name, last_name, dob, sports, photo_url }) => {
    const child = await requireOwnChild(user, child_id);
    if (dob && (isNaN(new Date(dob)) || new Date(dob) > new Date())) throw badRequest('Date of birth is not a valid date');
    const parts = child.display_name.split(' ');
    const newName = (first_name || last_name)
      ? `${first_name ?? parts[0]} ${last_name ?? parts.slice(1).join(' ')}`.trim()
      : null;
    await tx(async (c) => {
      await c.query(
        `UPDATE users SET
          display_name = COALESCE($1, display_name),
          full_name_enc = COALESCE($2, full_name_enc),
          dob_enc = COALESCE($3, dob_enc),
          avatar_url = COALESCE($4, avatar_url)
         WHERE id=$5`,
        [newName, newName ? encrypt(newName, 'users.full_name') : null, dob ? encrypt(dob, 'users.dob') : null, photo_url ?? null, child_id]
      );
      if (sports) await setSports(c, child_id, sports);
      if (dob) await refreshYouth(child_id, user.id, c);
      await audit(c, user.id, 'managed_child_updated', 'users', child_id);
    });
    return { updated: true };
  },
});

cap({
  name: 'set_child_medical_card', method: 'PATCH', path: '/me/managed-children/:child_id/medical', tag: TAG,
  summary: 'Set emergency medical card for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    blood_type: z.enum(BLOOD_TYPES).optional(),
    allergies: z.array(z.string()).default([]),
    conditions: z.string().max(2000).optional(),
    medications: z.string().max(2000).optional(),
    gp_name: z.string().max(200).optional(),
    gp_phone: z.string().max(50).optional(),
    emergency_contact_name: z.string().min(1).max(200),
    emergency_contact_phone: z.string().min(1).max(50),
    emergency_contact_relation: z.string().max(100).optional(),
  }),
  handler: async ({ user }, { child_id, blood_type, allergies, conditions, medications, gp_name, gp_phone, emergency_contact_name, emergency_contact_phone, emergency_contact_relation }) => {
    await requireOwnChild(user, child_id);
    await one(
      `INSERT INTO user_medical_cards(user_id,blood_type,allergies,conditions_enc,medications_enc,gp_name_enc,gp_phone_enc,emergency_contact_name_enc,emergency_contact_phone_enc,emergency_contact_relation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(user_id) DO UPDATE SET
         blood_type=$2,allergies=$3,conditions_enc=$4,medications_enc=$5,gp_name_enc=$6,gp_phone_enc=$7,
         emergency_contact_name_enc=$8,emergency_contact_phone_enc=$9,emergency_contact_relation=$10,updated_at=now()`,
      [child_id, blood_type ?? null, allergies,
       enc('user_medical_cards', 'conditions', conditions), enc('user_medical_cards', 'medications', medications),
       enc('user_medical_cards', 'gp_name', gp_name), enc('user_medical_cards', 'gp_phone', gp_phone),
       encrypt(emergency_contact_name, 'user_medical_cards.emergency_contact_name'), encrypt(emergency_contact_phone, 'user_medical_cards.emergency_contact_phone'), emergency_contact_relation ?? null]
    );
    await audit(null, user.id, 'medical_card_updated', 'user_medical_cards', child_id);
    return { saved: true };
  },
});

cap({
  name: 'get_child_medical_card', method: 'GET', path: '/managed-children/:child_id/medical-card', tag: TAG,
  summary: 'Get decrypted emergency medical card (guardian or team manager)',
  auth: 'user',
  input: z.object({ child_id: id }),
  handler: async ({ user }, { child_id }) => {
    const child = await one('SELECT * FROM users WHERE id=$1', [child_id]);
    if (!child) throw notFound('Child profile');
    const isGuardian = child.managed_by_guardian_id === user.id || !!(await guardianLink(user.id, child_id));
    if (!isGuardian && !isAdmin(user)) {
      // allow people who run a team this child is currently on
      const membership = await one(
        `SELECT 1 FROM team_members tm
         JOIN team_members cm ON cm.team_id=tm.team_id AND cm.user_id=$1 AND cm.status='active'
         WHERE tm.user_id=$2 AND tm.status='active' AND cm.role IN ('captain','manager','coach') LIMIT 1`,
        [user.id, child_id]
      );
      if (!membership) throw notFound('Medical card'); // no hint that the child exists
    }
    const card = await one('SELECT * FROM user_medical_cards WHERE user_id=$1', [child_id]);
    if (!card) throw notFound('Medical card not set');
    await audit(null, user.id, 'medical_card_viewed', 'user_medical_cards', child_id);
    return {
      card: {
        blood_type: card.blood_type,
        allergies: card.allergies,
        conditions: dec('user_medical_cards', 'conditions', card.conditions_enc),
        medications: dec('user_medical_cards', 'medications', card.medications_enc),
        gp_name: dec('user_medical_cards', 'gp_name', card.gp_name_enc),
        gp_phone: dec('user_medical_cards', 'gp_phone', card.gp_phone_enc),
        emergency_contact_name: dec('user_medical_cards', 'emergency_contact_name', card.emergency_contact_name_enc),
        emergency_contact_phone: dec('user_medical_cards', 'emergency_contact_phone', card.emergency_contact_phone_enc),
        emergency_contact_relation: card.emergency_contact_relation,
        child_name: child.display_name,
      },
    };
  },
});

cap({
  name: 'set_child_kit_sizes', method: 'PATCH', path: '/me/managed-children/:child_id/kit', tag: TAG,
  summary: 'Set kit sizes for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    shirt_size: z.string().max(10).optional(),
    shorts_size: z.string().max(10).optional(),
    boot_size: z.string().max(10).optional(),
  }),
  handler: async ({ user }, { child_id, shirt_size, shorts_size, boot_size }) => {
    await requireOwnChild(user, child_id);
    await one(
      `INSERT INTO user_kit_sizes(user_id,shirt_size_enc,shorts_size_enc,boot_size_enc)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET shirt_size_enc=$2,shorts_size_enc=$3,boot_size_enc=$4,updated_at=now()`,
      [child_id, enc('user_kit_sizes', 'shirt_size', shirt_size), enc('user_kit_sizes', 'shorts_size', shorts_size), enc('user_kit_sizes', 'boot_size', boot_size)]
    );
    return { saved: true };
  },
});

cap({
  name: 'set_child_academic_schedule', method: 'PATCH', path: '/me/managed-children/:child_id/academic', tag: TAG,
  summary: 'Set academic schedule for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    school_name: z.string().max(200).optional(),
    schedule: z.string().max(5000).optional(),
  }),
  handler: async ({ user }, { child_id, school_name, schedule }) => {
    await requireOwnChild(user, child_id);
    await one(
      `INSERT INTO user_academic_schedules(user_id,school_name_enc,schedule_enc)
       VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET school_name_enc=$2,schedule_enc=$3,updated_at=now()`,
      [child_id, enc('user_academic_schedules', 'school_name', school_name), enc('user_academic_schedules', 'schedule', schedule)]
    );
    return { saved: true };
  },
});

cap({
  name: 'set_child_biometrics', method: 'PATCH', path: '/me/managed-children/:child_id/biometrics', tag: TAG,
  summary: 'Set sport science biometrics for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    height_cm: z.number().min(50).max(250).optional(),
    weight_kg: z.number().min(10).max(200).optional(),
    wingspan_cm: z.number().min(50).max(260).optional(),
  }),
  handler: async ({ user }, { child_id, height_cm, weight_kg, wingspan_cm }) => {
    await requireOwnChild(user, child_id);
    await one(
      `INSERT INTO user_biometrics(user_id,height_cm_enc,weight_kg_enc,wingspan_cm_enc)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET height_cm_enc=$2,weight_kg_enc=$3,wingspan_cm_enc=$4,updated_at=now()`,
      [child_id,
       height_cm != null ? encrypt(String(height_cm), 'user_biometrics.height_cm') : null,
       weight_kg != null ? encrypt(String(weight_kg), 'user_biometrics.weight_kg') : null,
       wingspan_cm != null ? encrypt(String(wingspan_cm), 'user_biometrics.wingspan_cm') : null]
    );
    return { saved: true };
  },
});

cap({
  name: 'get_child_onboarding_status', method: 'GET', path: '/me/managed-children/:child_id/onboarding', tag: TAG,
  summary: 'Get onboarding checklist completion for a managed child',
  auth: 'user',
  input: z.object({ child_id: id }),
  handler: async ({ user }, { child_id }) => {
    const child = await requireOwnChild(user, child_id);
    const [medical, kit, academic, biometrics] = await Promise.all([
      one('SELECT emergency_contact_name_enc FROM user_medical_cards WHERE user_id=$1', [child_id]),
      one('SELECT user_id FROM user_kit_sizes WHERE user_id=$1', [child_id]),
      one('SELECT user_id FROM user_academic_schedules WHERE user_id=$1', [child_id]),
      one('SELECT user_id FROM user_biometrics WHERE user_id=$1', [child_id]),
    ]);
    const checks = {
      profile_complete: !!(child.display_name && child.dob_enc),
      medical_complete: !!(medical?.emergency_contact_name_enc),
      kit_complete: !!kit,
      academic_complete: !!academic,
      biometrics_set: !!biometrics,
      photo_set: !!child.avatar_url,
    };
    const done = Object.values(checks).filter(Boolean).length;
    return { checks, overall_pct: Math.round((done / 6) * 100) };
  },
});

cap({
  name: 'invite_child_to_claim_account', method: 'POST', path: '/me/managed-children/:child_id/claim-invite', tag: TAG,
  summary: 'Send account claim invite to a child approaching independence',
  auth: 'user',
  input: z.object({
    child_id: id,
    contact: z.string().min(3).max(500),
  }),
  handler: async ({ user }, { child_id, contact }) => {
    const child = await requireOwnChild(user, child_id);
    if (!child.dob_enc) throw badRequest('Child must have a date of birth set');
    await audit(null, user.id, 'managed_child_dob_checked', 'users', child_id);
    const dob = decrypt(child.dob_enc, 'users.dob');
    const ageYears = (Date.now() - new Date(dob)) / (365.25 * 86400000);
    const policy = await getPolicy(child.jurisdiction);
    if (ageYears < policy.independent_age - 2) throw badRequest(`Child must be at least ${policy.independent_age - 2} to receive a claim invite`);
    const token = await tx(async (c) => {
      // retire any earlier unused token, then issue a fresh URL-safe one
      await c.query('UPDATE managed_account_claim_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [child_id]);
      return (await c.query(
        'INSERT INTO managed_account_claim_tokens(user_id,token,contact_enc) VALUES($1,$2,$3) RETURNING token',
        [child_id, newOpaqueToken(), encrypt(contact, 'managed_account_claim_tokens.contact')]
      )).rows[0];
    });
    const base = String(config.appUrl ?? 'https://app.sportarena.com').replace(/\/$/, '');
    return {
      token: token.token,
      claim_url: `${base}/claim/${token.token}`,
      expires_in_days: 7,
    };
  },
});

cap({
  name: 'claim_managed_account', method: 'POST', path: '/claim/:token', tag: TAG,
  summary: 'Claim a managed account using a token from a guardian invite',
  auth: 'public',
  input: z.object({ token: z.string().min(10) }),
  handler: async (_, { token }) => {
    // single atomic use: only one caller can flip used_at, and only before expiry
    const row = await one(
      'UPDATE managed_account_claim_tokens SET used_at=now() WHERE token=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [token]);
    if (!row) throw notFound('Claim token'); // unknown, used and expired tokens look the same
    await one('UPDATE users SET claimed_at=COALESCE(claimed_at, now()) WHERE id=$1', [row.user_id]);
    return { user_id: row.user_id, next_step: 'setup_auth' };
  },
});

cap({
  name: 'convert_managed_to_independent', method: 'POST', path: '/admin/managed-children/:child_id/convert', tag: TAG,
  summary: 'Convert a managed account to an independent account (admin)',
  auth: ['admin'],
  input: z.object({ child_id: id }),
  handler: async ({ user }, { child_id }) => {
    const child = await one('SELECT * FROM users WHERE id=$1 AND is_managed=true', [child_id]);
    if (!child) throw notFound('Managed child profile');
    const guardianId = child.managed_by_guardian_id;
    await one('UPDATE users SET is_managed=false, managed_by_guardian_id=NULL, claimed_at=COALESCE(claimed_at,now()) WHERE id=$1', [child_id]);
    if (guardianId) {
      await notify(null, guardianId, {
        kind: 'child_independent',
        title: `${child.display_name}'s account is now independent`,
        body: `${child.display_name} now manages their own SportArena account.`,
        data: { type: 'child_independent', child_id },
      });
    }
    return { converted: true };
  },
});
