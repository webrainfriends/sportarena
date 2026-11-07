// PS-20: Accessible para-sport Learn & Study content catalogue (#850).
// Governed, versioned, beginner-to-advanced learning paths published by the platform or approved
// institutions. Extends Learn & Study (education-catalogue.js) — no duplication of institution
// discovery, no new LMS. Credential issuance reuses credentials.js pattern.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';
import { isYouth, guardiansOf } from '../youth.js';

const TAG = 'Para learning';
const https = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Links must use https');
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const STATUSES = ['draft', 'submitted', 'approved', 'published', 'retired'];
const newCode = () => `PL-${randomBytes(5).toString('hex').toUpperCase()}`;

const blockSchema = z.object({ type: z.enum(['heading', 'text', 'checklist', 'tip']), text: z.string().min(1).max(5000) });
const sourceSchema = z.object({ title: z.string().max(200).optional(), owner: z.string().max(200).optional(), licence: z.string().max(200).optional(), source_url: https.optional() }).default({});

// ── helpers ──────────────────────────────────────────────────────────────────

async function pathOrNotFound(pathId) {
  const row = await one('SELECT * FROM para_learn_paths WHERE id=$1', [pathId]);
  if (!row) throw notFound('Learning path');
  return row;
}

async function draftVersionOf(pathId) {
  return one("SELECT * FROM para_learn_path_versions WHERE path_id=$1 AND status='draft'", [pathId]);
}

async function publishedVersionOf(pathId) {
  return one("SELECT * FROM para_learn_path_versions WHERE path_id=$1 AND status='published' ORDER BY version DESC LIMIT 1", [pathId]);
}

async function checkPublisher(user, publisherOrgId) {
  if (!publisherOrgId) {
    // Platform-published path: requires platform admin
    await mustBePlatformAdmin(user);
    return;
  }
  // Institution-published: check the org is in the approved publisher list
  const pub = await one(
    "SELECT 1 FROM para_learn_publisher_orgs WHERE organisation_id=$1 AND revoked_at IS NULL AND (sport_id IS NULL)",
    [publisherOrgId],
  );
  if (!pub) throw forbidden('Organisation does not have publishing access for para-sport learning paths');
  // Must be an admin/owner of that org
  const member = await one(
    "SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND status='active' AND left_at IS NULL",
    [publisherOrgId, user.id],
  );
  if (!member) throw forbidden('You must be an owner or admin of the publishing organisation');
}

// ── 1. list_para_learn_paths ─────────────────────────────────────────────────
cap({
  name: 'list_para_learn_paths', method: 'GET', path: '/para/learn/paths', tag: TAG, auth: 'public',
  summary: 'Browse published para-sport learning paths. Filter by sport slug and level. Each path shows its modules count, estimated time and source attribution. No disability or classification data is used for filtering.',
  input: z.object({ sport: z.string().min(1).optional(), level_key: z.enum(LEVELS).optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    return many(
      `SELECT p.id, p.slug, p.level_key, p.title, p.summary, p.sport_id, s.name AS sport_name, s.emoji AS sport_emoji, s.slug AS sport_slug,
              o.name AS publisher_name, v.id AS version_id, v.version, v.estimated_minutes, v.source_attribution, v.published_at,
              (SELECT count(*) FROM para_learn_modules m WHERE m.version_id=v.id) AS module_count
         FROM para_learn_paths p
         JOIN sports s ON s.id=p.sport_id
         JOIN para_learn_path_versions v ON v.path_id=p.id AND v.status='published'
         LEFT JOIN organisations o ON o.id=p.publisher_org_id
        WHERE ($1::uuid IS NULL OR p.sport_id=$1) AND ($2::text IS NULL OR p.level_key=$2)
        ORDER BY s.name, p.level_key, p.created_at LIMIT $3 OFFSET $4`,
      [sport?.id ?? null, i.level_key ?? null, i.limit, i.offset],
    );
  },
});

// ── 2. get_para_learn_path ───────────────────────────────────────────────────
cap({
  name: 'get_para_learn_path', method: 'GET', path: '/para/learn/paths/:id', tag: TAG, auth: 'public',
  summary: 'Full detail for a published learning path: version, ordered modules with accessible media metadata, assessments count per module, objectives and source attribution.',
  input: z.object({ id }),
  async handler(_, i) {
    const path = await pathOrNotFound(i.id);
    const ver = await publishedVersionOf(path.id);
    if (!ver) throw notFound('Learning path');
    const sport = await one('SELECT id, slug, name, emoji FROM sports WHERE id=$1', [path.sport_id]);
    const pub = path.publisher_org_id ? await one('SELECT name FROM organisations WHERE id=$1', [path.publisher_org_id]) : null;
    const modules = await many(
      `SELECT m.id, m.position, m.title, m.body_blocks, m.source_attribution, m.caption_url, m.transcript_url,
              m.alt_text, m.audio_description, m.external_url, m.estimated_minutes, m.required,
              (SELECT count(*) FROM para_learn_assessments a WHERE a.module_id=m.id) AS assessment_count
         FROM para_learn_modules m WHERE m.version_id=$1 ORDER BY m.position, m.created_at`,
      [ver.id],
    );
    return { path: { id: path.id, slug: path.slug, level_key: path.level_key, title: path.title, summary: path.summary },
      sport, publisher: pub ? { name: pub.name } : { name: 'Sportarena' },
      version: { id: ver.id, version: ver.version, objectives: ver.objectives, estimated_minutes: ver.estimated_minutes,
        source_attribution: ver.source_attribution, copyright_note: ver.copyright_note, published_at: ver.published_at },
      modules };
  },
});

// ── 3. create_para_learn_path ────────────────────────────────────────────────
cap({
  name: 'create_para_learn_path', method: 'POST', path: '/para/learn/paths', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team or approved institution: create a new learning path for a para-sport. Automatically creates a draft version. Platform team leave publisher_org_id empty; approved institutions include their org id.',
  input: z.object({ sport: z.string().min(1), level_key: z.enum(LEVELS), title: z.string().trim().min(2).max(120), summary: z.string().trim().max(500).optional(), publisher_org_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await checkPublisher(user, i.publisher_org_id ?? null);
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const slug = `${sport.slug}-${i.level_key}-${Date.now()}`;
    let path;
    try {
      path = (await c.query(
        'INSERT INTO para_learn_paths(sport_id, slug, level_key, title, summary, publisher_org_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [sport.id, slug, i.level_key, i.title, i.summary ?? null, i.publisher_org_id ?? null, user.id],
      )).rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('A learning path for this sport and level already exists');
      throw e;
    }
    const ver = (await c.query(
      'INSERT INTO para_learn_path_versions(path_id, version, created_by) VALUES ($1,1,$2) RETURNING *',
      [path.id, user.id],
    )).rows[0];
    await audit(c, user.id, 'create_para_learn_path', 'para_learn_paths', path.id);
    return { ...path, version: ver };
  }),
});

// ── 4. save_para_learn_path_version ─────────────────────────────────────────
cap({
  name: 'save_para_learn_path_version', method: 'POST', path: '/para/learn/paths/:id/draft', tag: TAG, auth: ['admin'],
  summary: 'Update the draft version of a learning path: objectives, estimated duration, source attribution and copyright note. If no draft exists, a new draft version is created from the last published version.',
  input: z.object({ id, objectives: z.array(z.object({ text: z.string().min(1).max(500) })).optional(), estimated_minutes: z.number().int().min(1).max(600).optional(), source_attribution: sourceSchema.optional(), copyright_note: z.string().max(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const path = await pathOrNotFound(i.id);
    await checkPublisher(user, path.publisher_org_id);
    let draft = await draftVersionOf(path.id);
    if (!draft) {
      const last = await one('SELECT version FROM para_learn_path_versions WHERE path_id=$1 ORDER BY version DESC LIMIT 1', [path.id]);
      const nextVer = (last?.version ?? 0) + 1;
      draft = (await c.query(
        'INSERT INTO para_learn_path_versions(path_id, version, created_by) VALUES ($1,$2,$3) RETURNING *',
        [path.id, nextVer, user.id],
      )).rows[0];
      // Copy modules from last published version
      const pub = await publishedVersionOf(path.id);
      if (pub) {
        await c.query(
          `INSERT INTO para_learn_modules(version_id, position, title, body_blocks, source_attribution, caption_url, transcript_url, alt_text, audio_description, external_url, estimated_minutes, required)
           SELECT $2, position, title, body_blocks, source_attribution, caption_url, transcript_url, alt_text, audio_description, external_url, estimated_minutes, required
             FROM para_learn_modules WHERE version_id=$1`,
          [pub.id, draft.id],
        );
      }
    }
    return one(
      `UPDATE para_learn_path_versions
          SET objectives        = coalesce($2::jsonb, objectives),
              estimated_minutes = coalesce($3, estimated_minutes),
              source_attribution = coalesce($4::jsonb, source_attribution),
              copyright_note    = coalesce($5, copyright_note)
        WHERE id=$1 RETURNING *`,
      [draft.id, i.objectives ? JSON.stringify(i.objectives) : null, i.estimated_minutes ?? null, i.source_attribution ? JSON.stringify(i.source_attribution) : null, i.copyright_note ?? null],
    );
  }),
});

// ── 5. save_para_learn_module ────────────────────────────────────────────────
cap({
  name: 'save_para_learn_module', method: 'POST', path: '/para/learn/path-versions/:version_id/modules', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Add a module (content block) to a draft path version. Include accessible media metadata: caption_url, transcript_url, alt_text, audio_description. body_blocks follow [{type, text}] format.',
  input: z.object({ version_id: id, position: z.number().int().min(0).max(999).default(0), title: z.string().trim().min(2).max(200), body_blocks: z.array(blockSchema).min(1), source_attribution: sourceSchema.optional(), caption_url: https.optional(), transcript_url: https.optional(), alt_text: z.string().max(500).optional(), audio_description: z.string().max(1000).optional(), external_url: https.optional(), estimated_minutes: z.number().int().min(1).max(120).optional(), required: z.boolean().default(true) }),
  async handler({ user }, i) {
    const ver = await one('SELECT * FROM para_learn_path_versions WHERE id=$1', [i.version_id]);
    if (!ver) throw notFound('Path version');
    if (ver.status !== 'draft') throw conflict('Modules can only be added to a draft version');
    const path = await pathOrNotFound(ver.path_id);
    await checkPublisher(user, path.publisher_org_id);
    return one(
      `INSERT INTO para_learn_modules(version_id, position, title, body_blocks, source_attribution, caption_url, transcript_url, alt_text, audio_description, external_url, estimated_minutes, required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.version_id, i.position, i.title, JSON.stringify(i.body_blocks), i.source_attribution ? JSON.stringify(i.source_attribution) : null, i.caption_url ?? null, i.transcript_url ?? null, i.alt_text ?? null, i.audio_description ?? null, i.external_url ?? null, i.estimated_minutes ?? null, i.required],
    );
  },
});

// ── 6. update_para_learn_module ──────────────────────────────────────────────
cap({
  name: 'update_para_learn_module', method: 'PATCH', path: '/para/learn/modules/:id', tag: TAG, auth: ['admin'],
  summary: 'Update a module in a draft path version. All fields are optional; only provided ones change. The version must still be in draft.',
  input: z.object({ id, position: z.number().int().min(0).max(999).optional(), title: z.string().trim().min(2).max(200).optional(), body_blocks: z.array(blockSchema).min(1).optional(), source_attribution: sourceSchema.optional(), caption_url: https.nullable().optional(), transcript_url: https.nullable().optional(), alt_text: z.string().max(500).nullable().optional(), audio_description: z.string().max(1000).nullable().optional(), external_url: https.nullable().optional(), estimated_minutes: z.number().int().min(1).max(120).nullable().optional(), required: z.boolean().optional() }),
  async handler({ user }, i) {
    const mod = await one('SELECT m.*, v.status, v.path_id FROM para_learn_modules m JOIN para_learn_path_versions v ON v.id=m.version_id WHERE m.id=$1', [i.id]);
    if (!mod) throw notFound('Module');
    if (mod.status !== 'draft') throw conflict('Modules can only be edited on a draft version');
    const path = await pathOrNotFound(mod.path_id);
    await checkPublisher(user, path.publisher_org_id);
    return one(
      `UPDATE para_learn_modules SET
        position=coalesce($2, position), title=coalesce($3, title), body_blocks=coalesce($4::jsonb, body_blocks),
        source_attribution=coalesce($5::jsonb, source_attribution),
        caption_url=CASE WHEN $6::boolean THEN $7 ELSE caption_url END,
        transcript_url=CASE WHEN $8::boolean THEN $9 ELSE transcript_url END,
        alt_text=CASE WHEN $10::boolean THEN $11 ELSE alt_text END,
        audio_description=CASE WHEN $12::boolean THEN $13 ELSE audio_description END,
        external_url=CASE WHEN $14::boolean THEN $15 ELSE external_url END,
        estimated_minutes=CASE WHEN $16::boolean THEN $17 ELSE estimated_minutes END,
        required=coalesce($18, required)
       WHERE id=$1 RETURNING *`,
      [i.id, i.position ?? null, i.title ?? null, i.body_blocks ? JSON.stringify(i.body_blocks) : null,
        i.source_attribution ? JSON.stringify(i.source_attribution) : null,
        'caption_url' in i, i.caption_url ?? null,
        'transcript_url' in i, i.transcript_url ?? null,
        'alt_text' in i, i.alt_text ?? null,
        'audio_description' in i, i.audio_description ?? null,
        'external_url' in i, i.external_url ?? null,
        'estimated_minutes' in i, i.estimated_minutes ?? null,
        i.required ?? null],
    );
  },
});

// ── 7. save_para_learn_assessment ────────────────────────────────────────────
cap({
  name: 'save_para_learn_assessment', method: 'POST', path: '/para/learn/modules/:id/assessments', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Add a check question to a module. Exactly one option must be marked correct. plain_language_hint gives a plain-language clue shown to the learner.',
  input: z.object({ id, question: z.string().trim().min(2).max(500), options: z.array(z.object({ label: z.string().min(1).max(200), is_correct: z.boolean() })).min(2).max(6), plain_language_hint: z.string().max(400).optional(), max_retakes: z.number().int().min(0).max(10).default(3), position: z.number().int().min(0).max(99).default(0) })
    .refine((v) => v.options.filter((o) => o.is_correct).length === 1, 'Exactly one option must be marked correct'),
  async handler({ user }, i) {
    const mod = await one('SELECT m.*, v.status, v.path_id FROM para_learn_modules m JOIN para_learn_path_versions v ON v.id=m.version_id WHERE m.id=$1', [i.id]);
    if (!mod) throw notFound('Module');
    if (mod.status !== 'draft') throw conflict('Assessments can only be added to a draft version');
    const path = await pathOrNotFound(mod.path_id);
    await checkPublisher(user, path.publisher_org_id);
    return one(
      'INSERT INTO para_learn_assessments(module_id, question, options, plain_language_hint, max_retakes, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [i.id, i.question, JSON.stringify(i.options), i.plain_language_hint ?? null, i.max_retakes, i.position],
    );
  },
});

// ── 8. submit_para_learn_path ────────────────────────────────────────────────
cap({
  name: 'submit_para_learn_path', method: 'POST', path: '/para/learn/path-versions/:version_id/submit', tag: TAG, auth: ['admin'],
  summary: 'Submit a draft learning path for editorial review. Validates: at least one module, source attribution present on the version. Status moves to submitted.',
  input: z.object({ version_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const ver = (await c.query('SELECT * FROM para_learn_path_versions WHERE id=$1 FOR UPDATE', [i.version_id])).rows[0];
    if (!ver) throw notFound('Path version');
    if (ver.status !== 'draft') throw conflict(`Cannot submit a version in status '${ver.status}'`);
    const path = await pathOrNotFound(ver.path_id);
    await checkPublisher(user, path.publisher_org_id);
    const moduleCount = (await c.query('SELECT count(*) FROM para_learn_modules WHERE version_id=$1', [i.version_id])).rows[0].count;
    if (parseInt(moduleCount) === 0) throw badRequest('Add at least one module before submitting');
    const attr = ver.source_attribution ?? {};
    if (!attr.owner && !attr.source_url) throw badRequest('Source attribution (owner or source_url) is required before submission');
    const updated = (await c.query("UPDATE para_learn_path_versions SET status='submitted' WHERE id=$1 RETURNING *", [i.version_id])).rows[0];
    await audit(c, user.id, 'submit_para_learn_path', 'para_learn_path_versions', i.version_id);
    return updated;
  }),
});

// ── 9. review_para_learn_path ────────────────────────────────────────────────
cap({
  name: 'review_para_learn_path', method: 'POST', path: '/para/learn/path-versions/:version_id/review', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: approve a submitted path, then publish it; or reject it back to draft; or retire a published path. approve and publish require platform-admin role. reject moves submitted → draft (a new draft replaces it). retire marks the path as no longer active.',
  input: z.object({ version_id: id, action: z.enum(['approve', 'reject', 'publish', 'retire']), note: z.string().max(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    if (['approve', 'publish', 'retire'].includes(i.action)) await mustBePlatformAdmin(user);
    const ver = (await c.query('SELECT * FROM para_learn_path_versions WHERE id=$1 FOR UPDATE', [i.version_id])).rows[0];
    if (!ver) throw notFound('Path version');
    const transitions = { approve: ['submitted', 'approved'], publish: ['approved', 'published'], retire: ['published', 'retired'], reject: ['submitted', 'draft'] };
    const [from, to] = transitions[i.action];
    if (ver.status !== from) throw conflict(`Cannot ${i.action} a version in status '${ver.status}' (expected '${from}')`);
    const extra = {};
    if (to === 'approved') { extra.approved_by = user.id; extra.approved_at = new Date(); }
    if (to === 'published') extra.published_at = new Date();
    // reject: delete current draft and move submitted back to draft (re-open for editing)
    if (i.action === 'reject') {
      await c.query("DELETE FROM para_learn_path_versions WHERE path_id=$1 AND status='draft'", [ver.path_id]);
    }
    const setClauses = Object.entries({ status: to, ...extra }).map(([k], n) => `${k}=$${n + 2}`).join(',');
    const vals = [i.version_id, to, ...Object.values(extra)];
    const updated = (await c.query(`UPDATE para_learn_path_versions SET ${setClauses} WHERE id=$1 RETURNING *`, vals)).rows[0];
    await audit(c, user.id, `para_learn_path_${i.action}`, 'para_learn_path_versions', i.version_id);
    return updated;
  }),
});

// ── 10. record_para_learn_progress ───────────────────────────────────────────
cap({
  name: 'record_para_learn_progress', method: 'POST', path: '/para/learn/progress', tag: TAG, status: 201,
  summary: 'Record completion of a module (and optionally an assessment answer). On first completion of all required modules for a path, a badge is automatically issued via the existing credential system. Youth athletes require guardian consent (checked via the existing youth consent system).',
  input: z.object({ path_id: id, version_id: id, module_id: id, assessment_id: id.optional(), answer_index: z.number().int().min(0).max(5).optional(), attempt_number: z.number().int().min(1).default(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const youth = await isYouth(user.id, c);
    if (youth) {
      const consent = (await c.query("SELECT 1 FROM youth_consents WHERE child_id=$1 AND purpose='learning' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1", [user.id])).rowCount;
      if (!consent) throw forbidden('Guardian consent is required for learning progress on a youth account');
    }
    const mod = await one('SELECT m.*, v.path_id, v.id AS v_id FROM para_learn_modules m JOIN para_learn_path_versions v ON v.id=m.version_id WHERE m.id=$1 AND v.id=$2 AND v.path_id=$3', [i.module_id, i.version_id, i.path_id]);
    if (!mod) throw notFound('Module');

    let passed = null;
    if (i.assessment_id) {
      const asmnt = await one('SELECT * FROM para_learn_assessments WHERE id=$1 AND module_id=$2', [i.assessment_id, i.module_id]);
      if (!asmnt) throw notFound('Assessment');
      // Retake cap
      if (asmnt.max_retakes > 0) {
        const tries = (await c.query('SELECT count(*) FROM para_learn_progress WHERE athlete_id=$1 AND assessment_id=$2', [user.id, i.assessment_id])).rows[0].count;
        if (parseInt(tries) >= asmnt.max_retakes) throw conflict('Maximum attempts reached for this assessment');
      }
      passed = (asmnt.options[i.answer_index ?? -1]?.is_correct === true);
    }

    const prog = (await c.query(
      'INSERT INTO para_learn_progress(athlete_id, path_id, version_id, module_id, assessment_id, answer_index, passed, attempt_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [user.id, i.path_id, i.version_id, i.module_id, i.assessment_id ?? null, i.answer_index ?? null, passed, i.attempt_number],
    )).rows[0];

    // Check if all required modules are now complete → issue badge
    const credential = await _maybeIssueCredential(c, user.id, i.path_id, i.version_id);

    return { ...prog, credential_issued: !!credential, credential };
  }),
});

async function _maybeIssueCredential(c, athleteId, pathId, versionId) {
  // Already issued?
  const link = (await c.query('SELECT * FROM para_learn_credential_links WHERE athlete_id=$1 AND path_id=$2', [athleteId, pathId])).rows[0];
  if (link) return null;

  // Count required modules vs completed
  const { rows: [counts] } = await c.query(
    `SELECT
       (SELECT count(*) FROM para_learn_modules WHERE version_id=$2 AND required=true) AS required_total,
       (SELECT count(DISTINCT module_id) FROM para_learn_progress WHERE athlete_id=$1 AND version_id=$2
         AND module_id IN (SELECT id FROM para_learn_modules WHERE version_id=$2 AND required=true)
         AND (assessment_id IS NULL OR passed=true)) AS completed`,
    [athleteId, versionId],
  );
  if (parseInt(counts.required_total) === 0 || parseInt(counts.completed) < parseInt(counts.required_total)) return null;

  // Issue badge
  const path = await one('SELECT p.*, s.name AS sport_name, s.emoji AS sport_emoji FROM para_learn_paths p JOIN sports s ON s.id=p.sport_id WHERE p.id=$1', [pathId]);
  const ver = await one('SELECT * FROM para_learn_path_versions WHERE id=$1', [versionId]);
  const { randomBytes: rb } = await import('node:crypto');
  const code = `PL-${rb(5).toString('hex').toUpperCase()}`;

  const cred = (await c.query(
    `INSERT INTO credentials(user_id, organisation_id, sport_id, kind, title, description, issued_on, code, issued_by, show_on_profile)
     VALUES ($1, NULL, $2, 'badge', $3, $4, current_date, $5, $1, true) RETURNING id, kind, title, code`,
    [athleteId, path.sport_id, `${path.sport_emoji} ${path.title}`, `Completed ${path.level_key} learning path for ${path.sport_name}`, code],
  )).rows[0];

  await c.query(
    'INSERT INTO para_learn_credential_links(athlete_id, path_id, version_id, credential_id) VALUES ($1,$2,$3,$4)',
    [athleteId, pathId, versionId, cred.id],
  );

  await notify(c, athleteId, { kind: 'credential_issued', title: `${path.sport_emoji} Learning path complete`, body: `You earned a badge for completing the ${path.title} path. Find it in your Badges.`, data: { credential_id: cred.id } });

  return cred;
}

// ── 11. get_para_learn_progress ──────────────────────────────────────────────
cap({
  name: 'get_para_learn_progress', method: 'GET', path: '/para/learn/progress', tag: TAG,
  summary: 'Get the calling athlete\'s learning progress: per-path completion percentage, module-level status and credential issuance. Optionally filter by sport slug.',
  input: z.object({ path_id: id.optional(), sport: z.string().optional() }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const paths = await many(
      `SELECT p.id AS path_id, p.title, p.level_key, s.slug AS sport_slug, s.emoji AS sport_emoji,
              v.id AS version_id, v.estimated_minutes,
              (SELECT count(*) FROM para_learn_modules m WHERE m.version_id=v.id AND m.required=true) AS required_total,
              (SELECT count(DISTINCT pr.module_id) FROM para_learn_progress pr
                 WHERE pr.athlete_id=$1 AND pr.version_id=v.id
                   AND pr.module_id IN (SELECT m.id FROM para_learn_modules m WHERE m.version_id=v.id AND m.required=true)
                   AND (pr.assessment_id IS NULL OR pr.passed=true)) AS completed_count,
              cl.credential_id, cl.issued_at AS credential_issued_at
         FROM para_learn_paths p
         JOIN sports s ON s.id=p.sport_id
         JOIN para_learn_path_versions v ON v.path_id=p.id AND v.status='published'
         LEFT JOIN para_learn_credential_links cl ON cl.path_id=p.id AND cl.athlete_id=$1
        WHERE ($2::uuid IS NULL OR p.sport_id=$2) AND ($3::uuid IS NULL OR p.id=$3)
          AND EXISTS (SELECT 1 FROM para_learn_progress pr WHERE pr.athlete_id=$1 AND pr.path_id=p.id)
        ORDER BY p.created_at`,
      [user.id, sport?.id ?? null, i.path_id ?? null],
    );
    // For path_id queries also fetch completed module ids for the UI tick marks
    const completedModules = i.path_id ? await many(
      `SELECT DISTINCT module_id FROM para_learn_progress WHERE athlete_id=$1 AND version_id=(SELECT id FROM para_learn_path_versions WHERE path_id=$2 AND status='published' ORDER BY version DESC LIMIT 1) AND (assessment_id IS NULL OR passed=true)`,
      [user.id, i.path_id],
    ) : [];
    return paths.map((r) => ({
      ...r,
      completion_pct: r.required_total > 0 ? Math.round((r.completed_count / r.required_total) * 100) : 0,
      credential_issued: !!r.credential_id,
      module_completions: i.path_id ? completedModules.map((m) => m.module_id) : undefined,
    }));
  },
});

// ── 12. list_para_learn_recommendations ──────────────────────────────────────
cap({
  name: 'list_para_learn_recommendations', method: 'GET', path: '/para/learn/recommendations', tag: TAG,
  summary: 'Up to 6 published learning paths recommended for the athlete, based solely on their declared para-sport interests (from their sport profile and para pathway). No disability classification or medical data is used.',
  input: z.object({}),
  async handler({ user }) {
    // Declared sports from para pathway milestones — no classification or diagnosis
    const sports = await many(
      `SELECT DISTINCT s.id AS sport_id FROM para_pathway_milestones p JOIN sports s ON s.slug = p.sport WHERE p.athlete_id=$1
       UNION
       SELECT DISTINCT sp.sport_id FROM sport_profiles sp JOIN sports ps ON ps.id = sp.sport_id AND ps.is_para = true WHERE sp.user_id=$1 AND sp.archived_at IS NULL
       LIMIT 10`,
      [user.id],
    );
    if (!sports.length) {
      // Fall back to any published beginner paths
      return many(
        `SELECT p.id, p.title, p.level_key, s.name AS sport_name, s.emoji AS sport_emoji, s.slug AS sport_slug,
                v.estimated_minutes, v.published_at
           FROM para_learn_paths p JOIN sports s ON s.id=p.sport_id
           JOIN para_learn_path_versions v ON v.path_id=p.id AND v.status='published'
          WHERE p.level_key='beginner' ORDER BY v.published_at DESC LIMIT 6`,
        [],
      );
    }
    const sportIds = sports.map((s) => s.sport_id);
    return many(
      `SELECT p.id, p.title, p.level_key, s.name AS sport_name, s.emoji AS sport_emoji, s.slug AS sport_slug,
              v.estimated_minutes, v.published_at
         FROM para_learn_paths p JOIN sports s ON s.id=p.sport_id
         JOIN para_learn_path_versions v ON v.path_id=p.id AND v.status='published'
        WHERE p.sport_id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM para_learn_credential_links cl WHERE cl.athlete_id=$2 AND cl.path_id=p.id)
        ORDER BY p.level_key='beginner' DESC, v.published_at DESC LIMIT 6`,
      [sportIds, user.id],
    );
  },
});

// ── read helpers for the UI ──────────────────────────────────────────────────

cap({
  name: 'get_para_learn_module', method: 'GET', path: '/para/learn/modules/:id', tag: TAG, auth: 'public',
  summary: 'Get a single module with its full body blocks and accessible media metadata.',
  input: z.object({ id }),
  async handler(_, i) {
    const mod = await one('SELECT * FROM para_learn_modules WHERE id=$1', [i.id]);
    if (!mod) throw notFound('Module');
    return mod;
  },
});

cap({
  name: 'list_para_learn_module_assessments', method: 'GET', path: '/para/learn/modules/:id/assessments', tag: TAG, auth: 'public',
  summary: 'List all check questions for a module, ordered by position.',
  input: z.object({ id }),
  async handler(_, i) {
    const mod = await one('SELECT 1 FROM para_learn_modules WHERE id=$1', [i.id]);
    if (!mod) throw notFound('Module');
    return many('SELECT * FROM para_learn_assessments WHERE module_id=$1 ORDER BY position, created_at', [i.id]);
  },
});

cap({
  name: 'list_para_learn_admin_paths', method: 'GET', path: '/para/learn/admin/paths', tag: TAG, auth: ['admin'],
  summary: 'Admin: list all learning paths across all statuses (draft, submitted, approved, published, retired) for the publishing queue.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return many(
      `SELECT p.id, p.slug, p.level_key, p.title, p.sport_id, s.name AS sport_name, s.emoji AS sport_emoji,
              o.name AS publisher_name, v.id AS version_id, v.version, v.status, v.published_at
         FROM para_learn_paths p
         JOIN sports s ON s.id=p.sport_id
         LEFT JOIN para_learn_path_versions v ON v.path_id=p.id AND v.version=(SELECT max(v2.version) FROM para_learn_path_versions v2 WHERE v2.path_id=p.id)
         LEFT JOIN organisations o ON o.id=p.publisher_org_id
        ORDER BY v.status, s.name, p.created_at LIMIT $1 OFFSET $2`,
      [i.limit, i.offset],
    );
  },
});

// ── 13a. set_learn_module_a11y ────────────────────────────────────────────────
// PS-08: fills the caption/alt-text gap on learning modules (para-spectator-accessibility.js
// covers media streams; this covers the learning content itself).
cap({
  name: 'set_learn_module_a11y', method: 'PATCH', path: '/para/learn/modules/:id/accessibility', tag: TAG,
  summary: 'Set accessibility metadata (captions, audio description, transcript) on a para-learn module.',
  input: z.object({
    id:            id,
    caption_ref:   z.string().url().optional(),
    audio_desc_ref: z.string().url().optional(),
    transcript_ref: z.string().url().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await mustBePlatformAdmin(user);
    const mod = (await c.query(
      'SELECT m.id, v.path_id FROM para_learn_modules m JOIN para_learn_path_versions v ON v.id=m.version_id WHERE m.id=$1',
      [i.id]
    )).rows[0];
    if (!mod) throw notFound('Module');
    const row = (await c.query(
      `UPDATE para_learn_modules
       SET caption_ref=COALESCE($2, caption_ref),
           audio_desc_ref=COALESCE($3, audio_desc_ref),
           transcript_ref=COALESCE($4, transcript_ref),
           a11y_reviewed_at=now(), a11y_reviewed_by=$5
       WHERE id=$1 RETURNING id, caption_ref, audio_desc_ref, transcript_ref, a11y_reviewed_at`,
      [i.id, i.caption_ref ?? null, i.audio_desc_ref ?? null, i.transcript_ref ?? null, user.id]
    )).rows[0];
    await audit(c, user.id, 'set_learn_module_a11y', 'para_learn_modules', i.id);
    return row;
  }),
});

// ── 13b. get_learn_module_a11y ────────────────────────────────────────────────
cap({
  name: 'get_learn_module_a11y', method: 'GET', path: '/para/learn/modules/:id/accessibility', tag: TAG, auth: 'public',
  summary: 'Return accessibility metadata for a para-learn module (caption, transcript, audio description URLs).',
  input: z.object({ id }),
  handler: async (_, i) => {
    const row = await one(
      'SELECT id, caption_ref, audio_desc_ref, transcript_ref, a11y_reviewed_at FROM para_learn_modules WHERE id=$1',
      [i.id]
    );
    if (!row) throw notFound('Module');
    return row;
  },
});

// ── 13. manage_para_learn_publisher ──────────────────────────────────────────
cap({
  name: 'manage_para_learn_publisher', method: 'POST', path: '/para/learn/publishers', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: grant or revoke an institution\'s permission to submit para-sport learning path content for editorial review.',
  input: z.object({ organisation_id: id, sport_id: id.optional(), action: z.enum(['approve', 'revoke']) }),
  handler: ({ user }, i) => tx(async (c) => {
    await mustBePlatformAdmin(user);
    const org = (await c.query('SELECT id, name FROM organisations WHERE id=$1', [i.organisation_id])).rows[0];
    if (!org) throw notFound('Organisation');
    if (i.action === 'approve') {
      await c.query(
        `INSERT INTO para_learn_publisher_orgs(organisation_id, sport_id, approved_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (organisation_id, sport_id) DO UPDATE SET revoked_at=NULL, revoked_by=NULL, approved_by=$3, approved_at=now()`,
        [i.organisation_id, i.sport_id ?? null, user.id],
      );
    } else {
      await c.query(
        'UPDATE para_learn_publisher_orgs SET revoked_at=now(), revoked_by=$2 WHERE organisation_id=$1 AND revoked_at IS NULL',
        [i.organisation_id, user.id],
      );
    }
    await audit(c, user.id, `para_learn_publisher_${i.action}`, 'para_learn_publisher_orgs', i.organisation_id);
    return { organisation_id: i.organisation_id, name: org.name, action: i.action };
  }),
});
