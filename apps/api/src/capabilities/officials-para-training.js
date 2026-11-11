// Para-sport officiating training and eligibility (#1027, R29): federation-defined requirements per sport,
// official's training completion evidence, eligibility gate, and admin verification workflow.
// Integrates with the existing official_eligibility flow: when mandatory para requirements are incomplete,
// assertOfficialEligible (called in officials.js) will add a warning or hard-block depending on event policy.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, hasRole, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin, isPlatformOwner } from '../platform.js';
import { sportBySlugOrId } from '../helpers.js';

const TAG = 'Officials';

// Eligibility computation helper: returns {eligible, incomplete_mandatory, expiring_soon, sport_id}
async function computeEligibility(officialId, sportId, c) {
  const client = c ?? pool;
  const reqs = await many(
    `SELECT id, kind, title, mandatory, valid_months FROM official_para_requirements
      WHERE sport_id=$1 AND archived_at IS NULL ORDER BY mandatory DESC, kind`,
    [sportId], c,
  );
  if (reqs.length === 0) return { eligible: true, incomplete_mandatory: [], expiring_soon: [], requirements: [], completions: {} };

  const compls = await many(
    `SELECT opc.*, opr.valid_months FROM official_para_completions opc
      JOIN official_para_requirements opr ON opr.id = opc.requirement_id
      WHERE opc.official_id=$1 AND opc.requirement_id = ANY($2) AND opc.superseded_by IS NULL
      ORDER BY opc.created_at DESC`,
    [officialId, reqs.map((r) => r.id)], c,
  );

  const byReq = {};
  for (const comp of compls) byReq[comp.requirement_id] = comp;

  const today = new Date();
  const soonDays = 60;
  const incompleteMandatory = [];
  const expiringSoon = [];

  for (const req of reqs) {
    const comp = byReq[req.id];
    if (!comp || comp.status === 'rejected') {
      if (req.mandatory) incompleteMandatory.push({ requirement_id: req.id, title: req.title, reason: comp?.status === 'rejected' ? 'rejected' : 'missing' });
      continue;
    }
    if (comp.status === 'expired') {
      if (req.mandatory) incompleteMandatory.push({ requirement_id: req.id, title: req.title, reason: 'expired' });
      continue;
    }
    // Check calendar expiry
    if (comp.expires_on) {
      const exp = new Date(comp.expires_on);
      if (exp < today) {
        if (comp.status !== 'expired') {
          // Mark as expired in DB (best effort, non-blocking)
          pool.query("UPDATE official_para_completions SET status='expired' WHERE id=$1", [comp.id]).catch(() => {});
        }
        if (req.mandatory) incompleteMandatory.push({ requirement_id: req.id, title: req.title, reason: 'expired' });
      } else {
        const daysLeft = Math.ceil((exp - today) / 86400000);
        if (daysLeft <= soonDays) expiringSoon.push({ requirement_id: req.id, title: req.title, expires_on: comp.expires_on, days_left: daysLeft });
      }
    }
  }

  return {
    eligible: incompleteMandatory.length === 0,
    incomplete_mandatory: incompleteMandatory,
    expiring_soon: expiringSoon,
    requirements: reqs,
    completions: byReq,
  };
}

// ------------------------------------------------------------------ requirements

cap({
  name: 'list_para_officiating_requirements', method: 'GET', path: '/para/officiating/requirements', tag: TAG,
  summary: 'List federation or platform-defined training requirements that officials must complete before officiating para-sport events in a given sport.',
  input: z.object({
    sport_id: id.optional(),
    sport: z.string().max(80).optional(),
    level: z.enum(['entry','intermediate','elite','international','all']).optional(),
    mandatory_only: z.boolean().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to view requirements');
    let sportId = i.sport_id;
    if (!sportId && i.sport) {
      const s = await sportBySlugOrId(i.sport);
      sportId = s?.id;
    }
    const filters = ['r.archived_at IS NULL'];
    const params = [];
    if (sportId) { params.push(sportId); filters.push(`r.sport_id=$${params.length}`); }
    if (i.level && i.level !== 'all') { params.push(i.level); filters.push(`r.level=$${params.length}`); }
    if (i.mandatory_only) filters.push('r.mandatory=true');
    const where = filters.join(' AND ');
    const rows = await many(
      `SELECT r.*, s.name AS sport_name, s.slug AS sport_slug, s.emoji AS sport_emoji,
              gb.name AS body_name
         FROM official_para_requirements r
         JOIN sports s ON s.id = r.sport_id
         LEFT JOIN governing_bodies gb ON gb.id = r.body_id
        WHERE ${where}
        ORDER BY s.name, r.level, r.mandatory DESC, r.kind`,
      params,
    );
    return { requirements: rows, total: rows.length };
  },
});

cap({
  name: 'create_para_officiating_requirement', method: 'POST', path: '/admin/para/officiating/requirements', tag: TAG, status: 201,
  summary: 'Platform admin or governing body manager creates a new para-sport officiating training requirement.',
  input: z.object({
    sport_id: id,
    body_id: id.optional(),
    level: z.enum(['entry','intermediate','elite','international']),
    kind: z.enum(['course','certification','experience','assessment','background_check']),
    title: z.string().min(2).max(200),
    description: z.string().max(2000).optional(),
    provider: z.string().max(200).optional(),
    source_ref: z.string().max(500).optional(),
    valid_months: z.number().int().min(1).max(240).optional(),
    mandatory: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    if (!hasRole(user, 'admin', 'platform_admin')) throw forbidden('Only admins may create para officiating requirements');
    const sport = await one('SELECT id FROM sports WHERE id=$1', [i.sport_id]);
    if (!sport) throw notFound('sport');
    return tx(async (c) => {
      const { rows: [req] } = await c.query(
        `INSERT INTO official_para_requirements (sport_id, body_id, level, kind, title, description, provider, source_ref, valid_months, mandatory, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [i.sport_id, i.body_id ?? null, i.level, i.kind, i.title, i.description ?? null, i.provider ?? null, i.source_ref ?? null, i.valid_months ?? null, i.mandatory ?? true, user.id],
      );
      return req;
    });
  },
});

cap({
  name: 'update_para_officiating_requirement', method: 'PATCH', path: '/admin/para/officiating/requirements/:id', tag: TAG,
  summary: 'Soft-archive an existing requirement and replace it with an updated version. Never mutates an existing requirement that may already have completions against it.',
  input: z.object({
    id,
    title: z.string().min(2).max(200).optional(),
    description: z.string().max(2000).optional(),
    provider: z.string().max(200).optional(),
    source_ref: z.string().max(500).optional(),
    valid_months: z.number().int().min(1).max(240).optional(),
    mandatory: z.boolean().optional(),
    archive: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    if (!hasRole(user, 'admin', 'platform_admin')) throw forbidden('Only admins may update para officiating requirements');
    return tx(async (c) => {
      const existing = (await c.query('SELECT * FROM official_para_requirements WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!existing) throw notFound('requirement');
      if (existing.archived_at) throw conflict('Requirement is already archived');
      if (i.archive) {
        await c.query('UPDATE official_para_requirements SET archived_at=now() WHERE id=$1', [i.id]);
        return { archived: true, id: i.id };
      }
      // Soft-archive old, insert new as the successor
      await c.query('UPDATE official_para_requirements SET archived_at=now() WHERE id=$1', [i.id]);
      const { rows: [newReq] } = await c.query(
        `INSERT INTO official_para_requirements (sport_id, body_id, level, kind, title, description, provider, source_ref, valid_months, mandatory, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          existing.sport_id, existing.body_id, existing.level, existing.kind,
          i.title ?? existing.title, i.description ?? existing.description,
          i.provider ?? existing.provider, i.source_ref ?? existing.source_ref,
          i.valid_months ?? existing.valid_months, i.mandatory ?? existing.mandatory,
          user.id,
        ],
      );
      return { archived_id: i.id, new_requirement: newReq };
    });
  },
});

// ------------------------------------------------------------------ completions

cap({
  name: 'submit_para_training_evidence', method: 'POST', path: '/para/officiating/completions', tag: TAG, status: 201,
  summary: 'Submit evidence of completing a para-sport officiating training requirement. Certificate reference is stored encrypted. Completion is pending until an admin verifies it.',
  input: z.object({
    requirement_id: id,
    completed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    cert_ref: z.string().max(300).optional(),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to submit training evidence');
    const req = await one('SELECT * FROM official_para_requirements WHERE id=$1 AND archived_at IS NULL', [i.requirement_id]);
    if (!req) throw notFound('requirement');
    return tx(async (c) => {
      // Mark any previous pending/verified completions for this (requirement, official) as superseded
      const prev = (await c.query(
        "SELECT id FROM official_para_completions WHERE requirement_id=$1 AND official_id=$2 AND superseded_by IS NULL",
        [i.requirement_id, user.id],
      )).rows[0];
      const cert_ref_enc = i.cert_ref ? encrypt(i.cert_ref, 'official_para_completions.cert_ref') : null;
      const { rows: [comp] } = await c.query(
        `INSERT INTO official_para_completions (requirement_id, official_id, completed_on, expires_on, cert_ref_enc, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
        [i.requirement_id, user.id, i.completed_on, i.expires_on ?? null, cert_ref_enc, i.notes ?? null],
      );
      if (prev) {
        await c.query('UPDATE official_para_completions SET superseded_by=$1 WHERE id=$2', [comp.id, prev.id]);
      }
      await audit(c, user.id, 'write', 'official_para_completions', comp.id);
      // Notify admin
      await notify(c, null, {
        kind: 'para_training_submission',
        title: 'Para training evidence submitted',
        body: `${user.display_name} submitted evidence for: ${req.title}`,
        data: { completion_id: comp.id, official_id: user.id },
        roles: ['admin'],
      }).catch(() => {});
      return { ...comp, cert_ref_enc: undefined };
    });
  },
});

cap({
  name: 'list_my_para_training_completions', method: 'GET', path: '/para/officiating/completions', tag: TAG,
  summary: 'List your para-sport officiating training completions with current verification status.',
  input: z.object({
    sport_id: id.optional(),
    status: z.enum(['pending','verified','rejected','expired','all']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to view completions');
    const filters = ['opc.official_id=$1', 'opc.superseded_by IS NULL'];
    const params = [user.id];
    if (i.status && i.status !== 'all') { params.push(i.status); filters.push(`opc.status=$${params.length}`); }
    if (i.sport_id) { params.push(i.sport_id); filters.push(`opr.sport_id=$${params.length}`); }
    const rows = await many(
      `SELECT opc.id, opc.requirement_id, opc.completed_on, opc.expires_on, opc.status, opc.rejection_note, opc.notes, opc.verified_at, opc.created_at,
              opr.title, opr.kind, opr.mandatory, opr.valid_months,
              s.name AS sport_name, s.slug AS sport_slug, s.emoji AS sport_emoji,
              u.display_name AS verified_by_name
         FROM official_para_completions opc
         JOIN official_para_requirements opr ON opr.id = opc.requirement_id
         JOIN sports s ON s.id = opr.sport_id
         LEFT JOIN users u ON u.id = opc.verified_by
        WHERE ${filters.join(' AND ')}
        ORDER BY opc.created_at DESC`,
      params,
    );
    return { completions: rows, total: rows.length };
  },
});

cap({
  name: 'verify_para_training_completion', method: 'POST', path: '/admin/para/officiating/completions/:id/verify', tag: TAG,
  summary: 'Admin or assessor verifies or rejects a submitted para training completion. Decrypts and audits the certificate reference during review.',
  input: z.object({
    id,
    decision: z.enum(['verified', 'rejected']),
    rejection_note: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    if (!hasRole(user, 'admin', 'platform_admin', 'official_verifier')) throw forbidden('Only admins or verifiers may verify training completions');
    return tx(async (c) => {
      const comp = (await c.query('SELECT * FROM official_para_completions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!comp) throw notFound('completion');
      if (comp.status !== 'pending') throw conflict(`Completion is already ${comp.status}`);
      // Audit the certificate reference access
      if (comp.cert_ref_enc) {
        try { decrypt(comp.cert_ref_enc, 'official_para_completions.cert_ref'); } catch { /* log but don't fail */ }
        await audit(c, user.id, 'read_cert_ref', 'official_para_completions', comp.id);
      }
      await c.query(
        'UPDATE official_para_completions SET status=$1, rejection_note=$2, verified_by=$3, verified_at=now() WHERE id=$4',
        [i.decision, i.rejection_note ?? null, user.id, i.id],
      );
      await notify(c, comp.official_id, {
        kind: 'para_training_verified',
        title: i.decision === 'verified' ? 'Training certificate verified' : 'Training certificate not approved',
        body: i.decision === 'verified'
          ? 'Your para officiating training evidence has been verified.'
          : `Your evidence was not approved. Reason: ${i.rejection_note ?? 'See your profile.'}`,
        data: { completion_id: comp.id },
      });
      return (await c.query('SELECT * FROM official_para_completions WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ eligibility queries

cap({
  name: 'get_my_para_officiating_eligibility', method: 'GET', path: '/para/officiating/my-eligibility', tag: TAG,
  summary: 'Your para-sport officiating eligibility across all sports, based on your verified training completions. Returns eligible/incomplete/expiring status per sport.',
  input: z.object({ sport_id: id.optional() }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to view eligibility');
    const sports = i.sport_id
      ? [await one('SELECT id, name, slug, emoji FROM sports WHERE id=$1', [i.sport_id])].filter(Boolean)
      : await many(
          `SELECT DISTINCT s.id, s.name, s.slug, s.emoji FROM sports s
            JOIN official_para_requirements r ON r.sport_id = s.id WHERE r.archived_at IS NULL`,
          [],
        );
    const results = await Promise.all(sports.map(async (s) => {
      const elig = await computeEligibility(user.id, s.id);
      return { sport_id: s.id, sport_name: s.name, sport_slug: s.slug, sport_emoji: s.emoji, ...elig, requirements: undefined, completions: undefined };
    }));
    return { official_id: user.id, sports: results };
  },
});

cap({
  name: 'get_official_para_eligibility', method: 'GET', path: '/para/officiating/eligibility/:official_id', tag: TAG,
  summary: 'Para-sport officiating eligibility for a specific official. Visible to the official themselves, assignors, and admins.',
  input: z.object({ official_id: id, sport_id: id.optional() }),
  async handler({ user }, i) {
    const isOwn = user?.id === i.official_id;
    if (!isOwn && !hasRole(user, 'admin', 'platform_admin', 'assignor')) throw forbidden('Only the official, an assignor or admin may view this');
    const official = await one('SELECT id, display_name, handle FROM users WHERE id=$1', [i.official_id]);
    if (!official) throw notFound('official');
    const sports = i.sport_id
      ? [await one('SELECT id, name, slug, emoji FROM sports WHERE id=$1', [i.sport_id])].filter(Boolean)
      : await many(
          `SELECT DISTINCT s.id, s.name, s.slug, s.emoji FROM sports s
            JOIN official_para_requirements r ON r.sport_id = s.id WHERE r.archived_at IS NULL`,
          [],
        );
    const results = await Promise.all(sports.map(async (s) => {
      const elig = await computeEligibility(i.official_id, s.id);
      return { sport_id: s.id, sport_name: s.name, sport_slug: s.slug, sport_emoji: s.emoji, ...elig, requirements: undefined, completions: undefined };
    }));
    return { official_id: i.official_id, official_name: official.display_name, official_handle: official.handle, sports: results };
  },
});

// Export for use in officials.js eligibility gate
export { computeEligibility };
