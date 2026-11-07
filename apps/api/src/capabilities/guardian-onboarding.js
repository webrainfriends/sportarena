// Parent-first creation of managed child profiles (gaps audit, feature 3).
// A guardian creates a "managed" account for their child — the child has no login credential.
// All PII (name, DOB, medical info) is field-level encrypted. Medical card decrypts are audit-logged.
// When the child reaches near-independence age the guardian can issue a claim link.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { getPolicy, refreshYouth, requireGuardian } from '../youth.js';
import { canManageTeam } from './teams.js';

const TAG = 'Guardian onboarding';
const BLOOD_TYPES = ['A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'];

async function requireOwnChild(user, childId) {
  const child = await one('SELECT * FROM users WHERE id=$1', [childId]);
  if (!child) throw notFound('Child profile');
  if (child.managed_by_guardian_id !== user.id && !isAdmin(user)) throw forbidden('Not your managed child');
  return child;
}

cap({
  name: 'create_managed_child_profile', method: 'POST', path: '/me/managed-children', tag: TAG,
  summary: 'Create a managed child profile (guardian)',
  auth: 'user',
  input: z.object({
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    gender: z.string().max(50).optional(),
    sports: z.array(z.string()).default([]),
  }),
  handler: async ({ user }, { first_name, last_name, dob, gender, sports }) => {
    const displayName = `${first_name} ${last_name}`;
    const child = await tx(async (c) => {
      const u = (await c.query(
        `INSERT INTO users(display_name, roles, is_managed, managed_by_guardian_id, dob_enc, gender, sports)
         VALUES($1, '{}', true, $2, $3, $4, $5) RETURNING *`,
        [displayName, user.id, encrypt(dob), gender ?? null, sports]
      )).rows[0];
      await c.query(
        `INSERT INTO user_profiles(user_id, first_name_enc, last_name_enc)
         VALUES($1, $2, $3)
         ON CONFLICT(user_id) DO UPDATE SET first_name_enc=$2, last_name_enc=$3`,
        [u.id, encrypt(first_name), encrypt(last_name)]
      ).catch(() => null); // user_profiles may not exist — non-fatal
      return u;
    });
    try { await refreshYouth(child.id); } catch {}
    return {
      child: {
        id: child.id,
        display_name: child.display_name,
        is_managed: true,
        sports: child.sports,
        gender: child.gender,
      },
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
              u.dob_enc, u.sports, u.claimed_at,
              (SELECT 1 FROM user_medical_cards WHERE user_id=u.id LIMIT 1) IS NOT NULL AS has_medical,
              (SELECT 1 FROM user_kit_sizes WHERE user_id=u.id LIMIT 1) IS NOT NULL AS has_kit,
              (SELECT 1 FROM user_academic_schedules WHERE user_id=u.id LIMIT 1) IS NOT NULL AS has_academic,
              (SELECT 1 FROM user_biometrics WHERE user_id=u.id LIMIT 1) IS NOT NULL AS has_biometrics
       FROM users u WHERE u.managed_by_guardian_id=$1 ORDER BY u.display_name`,
      [user.id]
    );
    return {
      children: children.map(c => {
        const dob = c.dob_enc ? decrypt(c.dob_enc) : null;
        const age = dob ? Math.floor((Date.now() - new Date(dob)) / (365.25 * 86400000)) : null;
        const checks = { profile: true, medical: c.has_medical, kit: c.has_kit, academic: c.has_academic, biometrics: c.has_biometrics, photo: !!c.avatar_url };
        const done = Object.values(checks).filter(Boolean).length;
        return {
          id: c.id,
          display_name: c.display_name,
          avatar_url: c.avatar_url, avatar_emoji: c.avatar_emoji, avatar_color: c.avatar_color,
          age, dob,
          sports: c.sports,
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
    const dob = child.dob_enc ? decrypt(child.dob_enc) : null;
    return {
      child: {
        id: child.id,
        display_name: child.display_name,
        avatar_url: child.avatar_url,
        dob,
        age: dob ? Math.floor((Date.now() - new Date(dob)) / (365.25 * 86400000)) : null,
        gender: child.gender,
        sports: child.sports,
        is_managed: child.is_managed,
        claimed_at: child.claimed_at,
      },
      medical: medical ? {
        blood_type: medical.blood_type,
        allergies: medical.allergies,
        conditions: medical.conditions_enc ? decrypt(medical.conditions_enc) : null,
        medications: medical.medications_enc ? decrypt(medical.medications_enc) : null,
        gp_name: medical.gp_name_enc ? decrypt(medical.gp_name_enc) : null,
        gp_phone: medical.gp_phone_enc ? decrypt(medical.gp_phone_enc) : null,
        emergency_contact_name: medical.emergency_contact_name_enc ? decrypt(medical.emergency_contact_name_enc) : null,
        emergency_contact_phone: medical.emergency_contact_phone_enc ? decrypt(medical.emergency_contact_phone_enc) : null,
        emergency_contact_relation: medical.emergency_contact_relation,
      } : null,
      kit: kit ? {
        shirt_size: kit.shirt_size_enc ? decrypt(kit.shirt_size_enc) : null,
        shorts_size: kit.shorts_size_enc ? decrypt(kit.shorts_size_enc) : null,
        boot_size: kit.boot_size_enc ? decrypt(kit.boot_size_enc) : null,
      } : null,
      academic: academic ? {
        school_name: academic.school_name_enc ? decrypt(academic.school_name_enc) : null,
        schedule: academic.schedule_enc ? decrypt(academic.schedule_enc) : null,
      } : null,
      biometrics: biometrics ? {
        height_cm: biometrics.height_cm_enc ? decrypt(biometrics.height_cm_enc) : null,
        weight_kg: biometrics.weight_kg_enc ? decrypt(biometrics.weight_kg_enc) : null,
        wingspan_cm: biometrics.wingspan_cm_enc ? decrypt(biometrics.wingspan_cm_enc) : null,
      } : null,
    };
  },
});

cap({
  name: 'update_managed_child_profile', method: 'PATCH', path: '/me/managed-children/:child_id', tag: TAG,
  summary: 'Update name, DOB, gender, sports, photo for a managed child',
  auth: 'user',
  input: z.object({
    child_id: id,
    first_name: z.string().min(1).max(100).optional(),
    last_name: z.string().min(1).max(100).optional(),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender: z.string().max(50).optional(),
    sports: z.array(z.string()).optional(),
    photo_url: z.string().url().optional(),
  }),
  handler: async ({ user }, { child_id, first_name, last_name, dob, gender, sports, photo_url }) => {
    const child = await requireOwnChild(user, child_id);
    const newName = (first_name || last_name)
      ? `${first_name ?? child.display_name.split(' ')[0]} ${last_name ?? child.display_name.split(' ').slice(1).join(' ')}`.trim()
      : null;
    await one(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        dob_enc = COALESCE($2, dob_enc),
        gender = COALESCE($3, gender),
        sports = COALESCE($4, sports),
        avatar_url = COALESCE($5, avatar_url)
       WHERE id=$6 RETURNING id`,
      [newName, dob ? encrypt(dob) : null, gender ?? null, sports ?? null, photo_url ?? null, child_id]
    );
    if (dob) { try { await refreshYouth(child_id); } catch {} }
    return { updated: true };
  },
});

cap({
  name: 'set_child_medical_card', method: 'PUT', path: '/me/managed-children/:child_id/medical', tag: TAG,
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
       conditions ? encrypt(conditions) : null, medications ? encrypt(medications) : null,
       gp_name ? encrypt(gp_name) : null, gp_phone ? encrypt(gp_phone) : null,
       encrypt(emergency_contact_name), encrypt(emergency_contact_phone), emergency_contact_relation ?? null]
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
    const isGuardian = child.managed_by_guardian_id === user.id;
    if (!isGuardian && !isAdmin(user)) {
      // allow team managers who manage a team this child is on
      const membership = await one(
        `SELECT tm.id FROM team_members tm
         JOIN team_members cm ON cm.team_id=tm.team_id AND cm.user_id=$1 AND cm.left_at IS NULL
         WHERE tm.user_id=$2 AND tm.left_at IS NULL AND cm.role IN ('captain','manager','coach') LIMIT 1`,
        [user.id, child_id]
      );
      if (!membership) throw forbidden('No access to this medical card');
    }
    const card = await one('SELECT * FROM user_medical_cards WHERE user_id=$1', [child_id]);
    if (!card) throw notFound('Medical card not set');
    await audit(null, user.id, 'medical_card_viewed', 'user_medical_cards', child_id);
    return {
      card: {
        blood_type: card.blood_type,
        allergies: card.allergies,
        conditions: card.conditions_enc ? decrypt(card.conditions_enc) : null,
        medications: card.medications_enc ? decrypt(card.medications_enc) : null,
        gp_name: card.gp_name_enc ? decrypt(card.gp_name_enc) : null,
        gp_phone: card.gp_phone_enc ? decrypt(card.gp_phone_enc) : null,
        emergency_contact_name: card.emergency_contact_name_enc ? decrypt(card.emergency_contact_name_enc) : null,
        emergency_contact_phone: card.emergency_contact_phone_enc ? decrypt(card.emergency_contact_phone_enc) : null,
        emergency_contact_relation: card.emergency_contact_relation,
        child_name: child.display_name,
      },
    };
  },
});

cap({
  name: 'set_child_kit_sizes', method: 'PUT', path: '/me/managed-children/:child_id/kit', tag: TAG,
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
      [child_id, shirt_size ? encrypt(shirt_size) : null, shorts_size ? encrypt(shorts_size) : null, boot_size ? encrypt(boot_size) : null]
    );
    return { saved: true };
  },
});

cap({
  name: 'set_child_academic_schedule', method: 'PUT', path: '/me/managed-children/:child_id/academic', tag: TAG,
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
      [child_id, school_name ? encrypt(school_name) : null, schedule ? encrypt(schedule) : null]
    );
    return { saved: true };
  },
});

cap({
  name: 'set_child_biometrics', method: 'PUT', path: '/me/managed-children/:child_id/biometrics', tag: TAG,
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
       height_cm != null ? encrypt(String(height_cm)) : null,
       weight_kg != null ? encrypt(String(weight_kg)) : null,
       wingspan_cm != null ? encrypt(String(wingspan_cm)) : null]
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
    const dob = decrypt(child.dob_enc);
    const ageYears = (Date.now() - new Date(dob)) / (365.25 * 86400000);
    const policy = await getPolicy(child_id).catch(() => ({ independent_age: 18 }));
    if (ageYears < policy.independent_age - 2) throw badRequest(`Child must be at least ${policy.independent_age - 2} to receive a claim invite`);
    // expire any existing unused token
    await one('UPDATE managed_account_claim_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [child_id]);
    const token = await one(
      'INSERT INTO managed_account_claim_tokens(user_id,contact_enc) VALUES($1,$2) RETURNING token',
      [child_id, encrypt(contact)]
    );
    return {
      token: token.token,
      claim_url: `https://app.sportarena.com/claim/${token.token}`,
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
    const row = await one('SELECT * FROM managed_account_claim_tokens WHERE token=$1', [token]);
    if (!row) throw notFound('Claim token');
    if (row.used_at) throw badRequest('This token has already been used');
    if (new Date(row.expires_at) < new Date()) throw badRequest('This token has expired');
    await one('UPDATE managed_account_claim_tokens SET used_at=now() WHERE id=$1', [row.id]);
    await one('UPDATE users SET claimed_at=now() WHERE id=$1', [row.user_id]);
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
      await notify(guardianId, {
        title: `${child.display_name}'s account is now independent`,
        body: `${child.display_name} now manages their own SportArena account.`,
        data: { type: 'child_independent', child_id },
      });
    }
    return { converted: true };
  },
});
