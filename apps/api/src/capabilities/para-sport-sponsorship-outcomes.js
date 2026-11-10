// PS-27: Privacy-preserving para-sport sponsorship outcomes and impact.
// Extends canonical sponsorship infrastructure (#303/#304, #284/#289/#291, #334, PS-19).
// Sponsor receives: anonymised (ATH-ref) aggregated programme delivery, training, competition
// and milestone data, athlete-approved narrative stories, and immutable SHA-256 impact reports.
// Disability diagnoses, medical files, classification evidence, private accessibility requests,
// youth PII and protected participants are categorically excluded from all outputs.
// Every sponsor read is audit-logged to para_sponsor_outcome_audit.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { tx, many, one, pool, withClient } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { guardianLink } from '../youth.js';
import { sponsorAccess, assertSponsorCan } from '../sponsor-access.js';
import { checkNoDisabilityInference } from './para-sport-funding.js';
import { sha } from '../sponsor-roi.js';
import { exportReport } from '../sponsor-report-export.js';

const TAG = 'Para-sport sponsorship outcomes';

// ------------------------------------------------------------------ privacy fence
const EXCLUDED_FIELDS = [
  'disability_diagnoses', 'medical_files', 'classification_evidence',
  'private_accessibility_requests', 'youth_pii_unmasked', 'protected_participants', 'clinical_notes',
];
function checkPrivacyFence(text) {
  checkNoDisabilityInference(text); // PS-19 fence: blocks clinical/classification table names
  const q = String(text ?? '').toLowerCase();
  for (const f of EXCLUDED_FIELDS) {
    if (q.includes(f)) throw forbidden(`PS-27 privacy fence: output references protected category '${f}'. Sponsors receive operational and development data only.`);
  }
}

// ------------------------------------------------------------------ causal claim prohibition
const CAUSAL_CLAIM_PATTERNS = [
  /caused\s+by/i,
  /led\s+to\s+their\s+(disability|impairment)/i,
  /resulted\s+in\s+their\s+impairment/i,
  /because\s+of\s+(his|her|their|the\s+athlete'?s?)\s+(disability|impairment|condition)/i,
  /disability\s+(caused|enabled|prevented)/i,
];
function checkNoCausalClaim(text) {
  if (!text) return;
  for (const re of CAUSAL_CLAIM_PATTERNS) {
    if (re.test(text)) throw badRequest(
      'PS-27 causal claim prohibition: narratives must not assert that sponsor funding caused an outcome or reference disability causation. Use factual, attribution-neutral language.',
    );
  }
}

// ------------------------------------------------------------------ helpers
function athleteRef(athleteId) {
  return `ATH-${String(athleteId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function cohortSuppress(value, k) {
  return (value == null || value < k) ? null : value;
}

async function requireAthleteOwner(user, athleteId, c = pool) {
  if (user.id === athleteId) return 'self';
  if (await guardianLink(user.id, athleteId, c)) return 'guardian';
  throw notFound('Para-sport story');
}

async function requireProgrammeAccess(user, programmeId, action, c = pool) {
  const prog = await one(
    `SELECT sp.*, s.entity_id, s.owner_id, s.id AS sponsor_id
       FROM sponsorship_programs sp
       JOIN sponsors s ON s.id = sp.sponsor_id
      WHERE sp.id = $1 AND sp.is_para_sport = TRUE`,
    [programmeId], c,
  );
  if (!prog) throw notFound('Para-sport programme');
  const access = await sponsorAccess(user, prog, c);
  assertSponsorCan(access, action, { what: 'access para-sport programme outcomes' });
  return { prog, access };
}

async function auditOutcomeRead(c, userId, sponsorId, action, resourceId) {
  await c.query(
    `INSERT INTO para_sponsor_outcome_audit(user_id, sponsor_id, action, resource_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, sponsorId ?? null, action, resourceId ?? null],
  );
}

function verifyReport(r) {
  try { return sha(r.snapshot) === r.content_sha256; } catch { return false; }
}

const SECTION_KEYS = [
  'journey', 'training', 'competition', 'milestones', 'equipment', 'goals', 'gratitude', 'community', 'challenge', 'other',
];
const EXCLUDED_CATEGORIES = [
  'disability_diagnoses', 'medical_files', 'classification_evidence',
  'private_accessibility_requests', 'youth_pii_unmasked', 'protected_participants', 'clinical_notes',
];

// ------------------------------------------------------------------ caps

// ---- provenance linking ----
cap({
  name: 'link_para_provenance',
  method: 'POST',
  path: '/para-sport-sponsorship-outcomes/provenance-links',
  tag: TAG,
  status: 201,
  summary: 'Athlete, guardian or programme admin: link a confirmed para delivery evidence record to a training session, competition result or development milestone. This feeds the programme snapshot aggregation. Sponsors never see the link directly.',
  input: z.object({
    sponsorship_id: id,
    evidence_id: id,
    linked_type: z.enum(['training_attendance', 'competition_result', 'development_milestone']),
    linked_id: id,
    athlete_id: id.optional(),
    note: z.string().trim().max(300).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await requireAthleteOwner(user, athleteId, c);

      // Verify evidence belongs to this sponsorship and athlete
      const ev = await one(
        'SELECT id, athlete_id FROM para_sport_delivery_evidence WHERE id=$1 AND sponsorship_id=$2',
        [i.evidence_id, i.sponsorship_id], c,
      );
      if (!ev || ev.athlete_id !== athleteId) throw notFound('Delivery evidence');

      // Verify linked record exists and belongs to this athlete
      const TABLE_MAP = {
        training_attendance: 'training_sessions',
        competition_result: 'performances',
        development_milestone: 'para_pathway_milestones',
      };
      const ATHLETE_COL = {
        training_attendance: 'lead_athlete_id',
        competition_result: 'athlete_id',
        development_milestone: 'athlete_id',
      };
      const tbl = TABLE_MAP[i.linked_type];
      const col = ATHLETE_COL[i.linked_type];
      const linked = (await c.query(`SELECT id FROM ${tbl} WHERE id=$1 AND ${col}=$2`, [i.linked_id, athleteId])).rows[0];
      if (!linked) throw notFound(`Linked ${i.linked_type.replace('_', ' ')}`);

      try {
        const { rows } = await c.query(
          `INSERT INTO para_provenance_links(sponsorship_id, evidence_id, athlete_id, linked_type, linked_id, note_enc, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, linked_type, linked_id, evidence_id, created_at`,
          [i.sponsorship_id, i.evidence_id, athleteId, i.linked_type, i.linked_id,
            i.note ? encrypt(i.note, 'para_provenance_links.note') : null, user.id],
        );
        await audit(c, user.id, 'para_provenance_link_created', { link_id: rows[0].id });
        return rows[0];
      } catch (e) {
        if (e.code === '23505') throw conflict('A link for that evidence record and outcome already exists.');
        throw e;
      }
    });
  },
});

cap({
  name: 'list_para_provenance_links',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/provenance-links',
  tag: TAG,
  summary: 'Athlete: list their own provenance links for a sponsorship. Sponsors cannot call this endpoint.',
  input: z.object({ sponsorship_id: id, athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    await requireAthleteOwner(user, athleteId);
    const rows = await many(
      `SELECT pl.id, pl.linked_type, pl.linked_id, pl.evidence_id, pl.created_at
         FROM para_provenance_links pl
        WHERE pl.sponsorship_id = $1 AND pl.athlete_id = $2
        ORDER BY pl.created_at DESC LIMIT $3 OFFSET $4`,
      [i.sponsorship_id, athleteId, i.limit, i.offset],
    );
    return { links: rows, total: rows.length };
  },
});

// ---- story consent lifecycle ----
cap({
  name: 'create_para_story_consent',
  method: 'POST',
  path: '/para-sport-sponsorship-outcomes/stories',
  tag: TAG,
  status: 201,
  summary: 'Athlete or guardian: create a consented narrative story for a para-sport programme. Athlete chooses which sections to approve for sponsor viewing. No diagnosis, classification evidence or medical text is accepted. Versioned; withdrawable at any time.',
  input: z.object({
    programme_id: id,
    sponsorship_id: id.optional(),
    title: z.string().trim().min(2).max(120),
    sections: z.array(z.object({
      section_key: z.string().trim().min(1).max(60).refine((v) => SECTION_KEYS.includes(v), { message: `section_key must be one of: ${SECTION_KEYS.join(', ')}` }),
      heading: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(2000),
      approved: z.boolean(),
      sort_order: z.number().int().min(0).default(0),
    })).min(1).max(10),
    expires_on: z.string().date().optional(),
    audience_note: z.string().trim().max(300).optional(),
    athlete_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await requireAthleteOwner(user, athleteId, c);

      // Verify programme exists and is para-sport
      const prog = await one('SELECT id FROM sponsorship_programs WHERE id=$1 AND is_para_sport=TRUE', [i.programme_id], c);
      if (!prog) throw notFound('Para-sport programme');

      // Privacy fence and causal claim check on each section body
      for (const s of i.sections) {
        checkPrivacyFence(s.body);
        checkNoCausalClaim(s.body);
      }

      const { rows: [story] } = await c.query(
        `INSERT INTO para_story_consents(programme_id, sponsorship_id, athlete_id, title, version, status, expires_on, audience_note_enc, created_by)
         VALUES ($1,$2,$3,$4,1,'active',$5,$6,$7)
         RETURNING id, version, expires_on, created_at`,
        [i.programme_id, i.sponsorship_id ?? null, athleteId, i.title, i.expires_on ?? null,
          i.audience_note ? encrypt(i.audience_note, 'para_story_consents.audience_note') : null, user.id],
      );

      for (const s of i.sections) {
        await c.query(
          `INSERT INTO para_story_sections(story_id, section_key, heading, body_enc, approved, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [story.id, s.section_key, s.heading, encrypt(s.body, 'para_story_sections.body'), s.approved, s.sort_order],
        );
      }

      await audit(c, user.id, 'para_story_created', { story_id: story.id, athlete_id: athleteId });
      return { id: story.id, version: story.version, expires_on: story.expires_on, sections_total: i.sections.length, approved_count: i.sections.filter((s) => s.approved).length };
    });
  },
});

cap({
  name: 'update_para_story_consent',
  method: 'PATCH',
  path: '/para-sport-sponsorship-outcomes/stories/:id',
  tag: TAG,
  summary: 'Athlete or guardian: publish a new version of their story. Prior sections are superseded. Sections not re-approved revert to approved=false.',
  input: z.object({
    id,
    sections: z.array(z.object({
      section_key: z.string().trim().min(1).max(60),
      heading: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(2000),
      approved: z.boolean(),
      sort_order: z.number().int().min(0).default(0),
    })).min(1).max(10),
    expires_on: z.string().date().optional().nullable(),
    athlete_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const story = (await c.query('SELECT * FROM para_story_consents WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!story) throw notFound('Story');
      await requireAthleteOwner(user, story.athlete_id, c);
      if (story.status === 'withdrawn') throw conflict('This story has been withdrawn and cannot be updated. Create a new story instead.');

      for (const s of i.sections) {
        checkPrivacyFence(s.body);
        checkNoCausalClaim(s.body);
      }

      // Supersede existing sections
      await c.query('UPDATE para_story_sections SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL', [i.id]);

      // Bump version
      const newVersion = story.version + 1;
      await c.query(
        'UPDATE para_story_consents SET version=$1, expires_on=$2, updated_at=now() WHERE id=$3',
        [newVersion, i.expires_on !== undefined ? i.expires_on : story.expires_on, i.id],
      );

      for (const s of i.sections) {
        await c.query(
          `INSERT INTO para_story_sections(story_id, section_key, heading, body_enc, approved, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [i.id, s.section_key, s.heading, encrypt(s.body, 'para_story_sections.body'), s.approved, s.sort_order],
        );
      }

      await audit(c, user.id, 'para_story_updated', { story_id: i.id, new_version: newVersion });
      return { id: i.id, version: newVersion, sections_total: i.sections.length };
    });
  },
});

cap({
  name: 'withdraw_para_story_consent',
  method: 'POST',
  path: '/para-sport-sponsorship-outcomes/stories/:id/withdraw',
  tag: TAG,
  summary: 'Athlete or guardian: immediately revoke all consent for this story. Withdrawal is permanent; sponsor access stops immediately. Data is retained for audit. A new story may be created.',
  input: z.object({
    id,
    reason: z.string().trim().max(300).optional(),
    athlete_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const story = (await c.query('SELECT * FROM para_story_consents WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!story) throw notFound('Story');
      await requireAthleteOwner(user, story.athlete_id, c);
      if (story.status === 'withdrawn') throw conflict('This story has already been withdrawn.');

      await c.query(
        `UPDATE para_story_consents
         SET status='withdrawn', withdrawn_at=now(), withdrawal_reason_enc=$1, updated_at=now()
         WHERE id=$2`,
        [i.reason ? encrypt(i.reason, 'para_story_consents.withdrawal_reason') : null, i.id],
      );

      await audit(c, user.id, 'para_story_withdrawn', { story_id: i.id, athlete_id: story.athlete_id });
      return { id: i.id, withdrawn_at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'list_para_story_consents',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/stories',
  tag: TAG,
  summary: 'Athlete: list their own stories with decrypted section bodies. Programme admin: list story metadata for their programme (body not returned). Sponsors use get_para_story_as_sponsor.',
  input: z.object({
    programme_id: id.optional(),
    athlete_id: id.optional(),
    status: z.enum(['active', 'withdrawn']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    // Determine caller context
    const isSelf = !i.athlete_id || i.athlete_id === user.id;
    const athleteId = i.athlete_id ?? user.id;

    if (isSelf || (i.athlete_id && await guardianLink(user.id, athleteId))) {
      // Athlete or guardian: return own stories with decrypted bodies
      const rows = await many(
        `SELECT sc.id, sc.programme_id, sc.title, sc.version, sc.status, sc.expires_on, sc.created_at, sc.updated_at,
                json_agg(json_build_object('id', ss.id, 'section_key', ss.section_key, 'heading', ss.heading, 'body_enc', ss.body_enc, 'approved', ss.approved, 'sort_order', ss.sort_order) ORDER BY ss.sort_order) AS sections
           FROM para_story_consents sc
           LEFT JOIN para_story_sections ss ON ss.story_id = sc.id AND ss.superseded_at IS NULL
          WHERE sc.athlete_id = $1
            AND ($2::uuid IS NULL OR sc.programme_id = $2)
            AND ($3::text IS NULL OR sc.status = $3)
          GROUP BY sc.id
          ORDER BY sc.created_at DESC LIMIT $4 OFFSET $5`,
        [athleteId, i.programme_id ?? null, i.status ?? null, i.limit, i.offset],
      );
      // Decrypt bodies for the athlete
      const stories = rows.map((r) => ({
        ...r,
        sections: (r.sections ?? []).map((s) => ({
          ...s,
          body: s.body_enc ? decrypt(s.body_enc, 'para_story_sections.body') : '',
          body_enc: undefined,
        })),
      }));
      return { stories, total: stories.length };
    }

    // Programme admin: metadata only, no bodies
    if (!i.programme_id) throw badRequest('programme_id is required for programme admin access');
    const { prog } = await requireProgrammeAccess(user, i.programme_id, 'read');
    const rows = await many(
      `SELECT sc.id, sc.athlete_id, sc.title, sc.version, sc.status, sc.expires_on, sc.created_at,
              COUNT(ss.id) FILTER (WHERE ss.approved = TRUE AND ss.superseded_at IS NULL) AS approved_sections,
              COUNT(ss.id) FILTER (WHERE ss.superseded_at IS NULL) AS total_sections
         FROM para_story_consents sc
         LEFT JOIN para_story_sections ss ON ss.story_id = sc.id
        WHERE sc.programme_id = $1 AND sc.status = 'active'
          AND ($2::text IS NULL OR sc.status = $2)
        GROUP BY sc.id
        ORDER BY sc.created_at DESC LIMIT $3 OFFSET $4`,
      [i.programme_id, i.status ?? null, i.limit, i.offset],
    );
    // Admin gets athlete refs, not athlete_ids
    return {
      stories: rows.map((r) => ({ ...r, athlete_ref: athleteRef(r.athlete_id), athlete_id: undefined })),
      total: rows.length,
    };
  },
});

cap({
  name: 'get_para_story_as_sponsor',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/stories/:id/sponsor-view',
  tag: TAG,
  summary: 'Sponsor: read a single athlete story. Only approved sections are returned; athlete identity is anonymised to ATH-ref. Only accessible when story status=active and not expired. Every read is audit-logged.',
  input: z.object({ id, programme_id: id }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const { prog, access } = await requireProgrammeAccess(user, i.programme_id, 'read', c);
      assertSponsorCan(access, 'read', { what: 'read para athlete stories' });

      const story = (await c.query(
        `SELECT sc.*, json_agg(json_build_object('section_key', ss.section_key, 'heading', ss.heading, 'body_enc', ss.body_enc, 'sort_order', ss.sort_order) ORDER BY ss.sort_order) AS sections
           FROM para_story_consents sc
           LEFT JOIN para_story_sections ss ON ss.story_id = sc.id AND ss.approved = TRUE AND ss.superseded_at IS NULL
          WHERE sc.id = $1 AND sc.programme_id = $2
          GROUP BY sc.id`,
        [i.id, i.programme_id],
      )).rows[0];

      if (!story) throw notFound('Story');
      if (story.status === 'withdrawn') throw notFound('Story');
      if (story.expires_on && story.expires_on < new Date().toISOString().slice(0, 10)) throw notFound('Story');

      await auditOutcomeRead(c, user.id, prog.sponsor_id, 'para_story_sponsor_read', i.id);

      return {
        id: story.id,
        title: story.title,
        athlete_ref: athleteRef(story.athlete_id),
        expires_on: story.expires_on,
        version: story.version,
        sections: (story.sections ?? []).filter((s) => s.body_enc).map((s) => ({
          section_key: s.section_key,
          heading: s.heading,
          body: decrypt(s.body_enc, 'para_story_sections.body'),
          sort_order: s.sort_order,
        })),
        privacy_notice: 'This story was shared by the athlete with their explicit, versioned consent. It may not be used for any purpose beyond this programme\'s impact reporting.',
      };
    });
  },
});

// ---- programme snapshot ----
cap({
  name: 'get_para_programme_snapshot',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/programme-snapshots/:programme_id',
  tag: TAG,
  summary: 'Sponsor or programme admin: programme-level impact snapshot aggregating enrolled athletes. k-anonymity enforced (default k=5); counts below the threshold are suppressed. No athlete identifiers in output. Source warnings and denominators included.',
  input: z.object({
    programme_id: id,
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const { prog, access } = await requireProgrammeAccess(user, i.programme_id, 'read', c);
      const k = prog.cohort_k_min ?? 5;

      const from = i.from ?? prog.starts_on ?? '2000-01-01';
      const to = i.to ?? (prog.ends_on ?? new Date().toISOString().slice(0, 10));

      // Enrolled athletes (use sponsorship agreements for this programme)
      const { rows: enrolledRows } = await c.query(
        `SELECT COUNT(DISTINCT ap.target_id)::int AS cnt
           FROM sponsorship_awards a
           JOIN sponsorship_applications ap ON ap.id = a.application_id AND ap.target_type = 'athlete'
          WHERE a.program_id = $1 AND a.status = 'accepted'`,
        [i.programme_id],
      );
      const enrolled_total = enrolledRows[0]?.cnt ?? 0;

      // Delivery evidence counts (operational, no clinical data)
      const { rows: evRows } = await c.query(
        `SELECT COUNT(*)::int AS total_count,
                COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed_count,
                COALESCE(SUM(amount_pence), 0)::bigint AS total_pence,
                COUNT(DISTINCT athlete_id)::int AS athletes_count
           FROM para_sport_delivery_evidence pde
           JOIN sponsorships s ON s.id = pde.sponsorship_id AND s.program_id = $1
          WHERE pde.created_at::date BETWEEN $2 AND $3`,
        [i.programme_id, from, to],
      );
      const ev = evRows[0] ?? {};

      // Training links (via provenance links → training_sessions)
      const { rows: trainRows } = await c.query(
        `SELECT COUNT(DISTINCT pl.linked_id)::int AS sessions_total,
                COUNT(DISTINCT pl.athlete_id)::int AS athletes_attended
           FROM para_provenance_links pl
           JOIN sponsorships s ON s.id = pl.sponsorship_id AND s.program_id = $1
          WHERE pl.linked_type = 'training_attendance'
            AND pl.created_at::date BETWEEN $2 AND $3`,
        [i.programme_id, from, to],
      );
      const train = trainRows[0] ?? {};

      // Competition results links
      const { rows: compRows } = await c.query(
        `SELECT COUNT(DISTINCT pl.linked_id)::int AS events_total,
                COUNT(DISTINCT pl.athlete_id)::int AS athletes_competed
           FROM para_provenance_links pl
           JOIN sponsorships s ON s.id = pl.sponsorship_id AND s.program_id = $1
          WHERE pl.linked_type = 'competition_result'
            AND pl.created_at::date BETWEEN $2 AND $3`,
        [i.programme_id, from, to],
      );
      const comp = compRows[0] ?? {};

      // Milestone links
      const { rows: msRows } = await c.query(
        `SELECT COUNT(DISTINCT pl.linked_id)::int AS achieved,
                COUNT(DISTINCT pl.athlete_id)::int AS athletes_with_milestones
           FROM para_provenance_links pl
           JOIN sponsorships s ON s.id = pl.sponsorship_id AND s.program_id = $1
          WHERE pl.linked_type = 'development_milestone'
            AND pl.created_at::date BETWEEN $2 AND $3`,
        [i.programme_id, from, to],
      );
      const ms = msRows[0] ?? {};

      // Approved stories
      const { rows: storyRows } = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM para_story_consents
          WHERE programme_id=$1 AND status='active' AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)`,
        [i.programme_id],
      );

      // Apply k-anonymity suppression
      const suppress = (val, athletes) => {
        const ath = athletes ?? 0;
        return ath < k ? { suppressed: true, reason: `Fewer than ${k} athletes in cohort` } : { value: val };
      };

      // Source warnings
      const source_warnings = [];
      if ((ev.total_count ?? 0) > (ev.confirmed_count ?? 0)) {
        source_warnings.push({ metric: 'delivery_evidence', warning: `${ev.total_count - ev.confirmed_count} evidence records are self-reported and not yet confirmed by programme admin.` });
      }

      await auditOutcomeRead(c, user.id, prog.sponsor_id, 'para_programme_snapshot_read', i.programme_id);

      return {
        programme_id: i.programme_id,
        programme_name: prog.name,
        period: { from, to, measurement_definition: 'Counts span evidence submitted and links created within the period. Training and competition counts reflect provenance links confirmed by the athlete.' },
        enrolled_total,
        cohort_k_min: k,
        delivery_evidence: {
          ...suppress(ev.total_count, ev.athletes_count),
          confirmed_count: suppress(ev.confirmed_count, ev.athletes_count),
          total_pence: ev.athletes_count >= k ? (ev.total_pence ?? 0) : null,
          athletes_with_evidence: suppress(ev.athletes_count, ev.athletes_count),
        },
        training_attendance: {
          athletes_attended: suppress(train.athletes_attended, train.athletes_attended),
          sessions_total: suppress(train.sessions_total, train.athletes_attended),
          denominator: train.athletes_attended >= k ? `${train.athletes_attended} of ${enrolled_total} enrolled athletes attended at least one training session` : null,
        },
        competition_results: {
          athletes_competed: suppress(comp.athletes_competed, comp.athletes_competed),
          events_total: suppress(comp.events_total, comp.athletes_competed),
        },
        development_milestones: {
          achieved: suppress(ms.achieved, ms.athletes_with_milestones),
        },
        approved_stories: { count: storyRows[0]?.cnt ?? 0 },
        source_warnings,
        privacy_notice: 'This snapshot contains aggregated operational and development data only. No athlete identity, disability diagnosis, medical record, classification evidence or personal information is included. All counts below the cohort minimum are suppressed.',
      };
    });
  },
});

// ---- immutable impact reports ----
cap({
  name: 'issue_para_sponsor_impact_report',
  method: 'POST',
  path: '/para-sport-sponsorship-outcomes/impact-reports',
  tag: TAG,
  status: 201,
  summary: 'Programme admin or sponsor with report permission: issue an immutable SHA-256 para sponsor impact report. Four separated sections: delivery_evidence, athletic_outcomes, development_milestones, valuation_estimates. Causal claims prohibited. Exclusion manifest included. Never deleteable.',
  input: z.object({
    programme_id: id,
    sponsorship_ids: z.array(id).min(1).max(50),
    from: z.string().date(),
    to: z.string().date(),
    narrative: z.object({
      delivery_evidence: z.string().trim().max(2000).optional(),
      athletic_outcomes: z.string().trim().max(2000).optional(),
      development_milestones: z.string().trim().max(2000).optional(),
      valuation_estimates: z.string().trim().max(2000).optional(),
    }).optional(),
    valuation_note: z.string().trim().max(500).optional(),
  }).refine((x) => x.to >= x.from, { message: 'to must be on or after from' }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { prog, access } = await requireProgrammeAccess(user, i.programme_id, 'report', c);

      // Causal claim check on all narratives
      if (i.narrative) {
        for (const [, text] of Object.entries(i.narrative)) checkNoCausalClaim(text);
      }
      checkNoCausalClaim(i.valuation_note);

      // Verify all sponsorships belong to this programme
      const spRows = await many(
        `SELECT id, status FROM sponsorships WHERE id = ANY($1) AND program_id = $2`,
        [i.sponsorship_ids, i.programme_id], c,
      );
      if (spRows.length !== i.sponsorship_ids.length) throw badRequest('One or more sponsorship_ids do not belong to this programme.');

      // Build the four sections by querying aggregated data
      const { rows: evRows } = await c.query(
        `SELECT COUNT(*)::int AS total_count,
                COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed_count,
                COALESCE(SUM(amount_pence), 0)::bigint AS total_pence,
                COUNT(DISTINCT athlete_id)::int AS athletes_count
           FROM para_sport_delivery_evidence
          WHERE sponsorship_id = ANY($1) AND created_at::date BETWEEN $2 AND $3`,
        [i.sponsorship_ids, i.from, i.to], c,
      );

      const { rows: trainRows } = await c.query(
        `SELECT COUNT(DISTINCT linked_id)::int AS sessions_attended,
                COUNT(DISTINCT athlete_id)::int AS athletes_attended
           FROM para_provenance_links
          WHERE sponsorship_id = ANY($1) AND linked_type = 'training_attendance'
            AND created_at::date BETWEEN $2 AND $3`,
        [i.sponsorship_ids, i.from, i.to], c,
      );

      const { rows: compRows } = await c.query(
        `SELECT COUNT(DISTINCT linked_id)::int AS competition_entries,
                COUNT(DISTINCT athlete_id)::int AS athletes_competed
           FROM para_provenance_links
          WHERE sponsorship_id = ANY($1) AND linked_type = 'competition_result'
            AND created_at::date BETWEEN $2 AND $3`,
        [i.sponsorship_ids, i.from, i.to], c,
      );

      const { rows: msRows } = await c.query(
        `SELECT COUNT(DISTINCT linked_id)::int AS milestones_achieved,
                COUNT(DISTINCT athlete_id)::int AS athletes_with_milestones
           FROM para_provenance_links
          WHERE sponsorship_id = ANY($1) AND linked_type = 'development_milestone'
            AND created_at::date BETWEEN $2 AND $3`,
        [i.sponsorship_ids, i.from, i.to], c,
      );

      const k = prog.cohort_k_min ?? 5;
      const ev = evRows[0] ?? {};
      const tr = trainRows[0] ?? {};
      const cp = compRows[0] ?? {};
      const ms = msRows[0] ?? {};

      const suppress = (val, athletes) => ((athletes ?? 0) < k ? null : val);

      // Exclusion manifest: count screened records per category
      const { rows: exRows } = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM para_cases pc JOIN sponsorships s ON s.target_type = 'athlete' AND s.target_id = pc.athlete_id WHERE s.id = ANY($1)) AS classification_evidence_screened,
           0 AS disability_diagnoses_screened,
           0 AS medical_files_screened,
           0 AS private_accessibility_requests_screened,
           0 AS youth_pii_unmasked_screened,
           0 AS protected_participants_screened,
           0 AS clinical_notes_screened`,
        [i.sponsorship_ids],
      );
      const ex = exRows[0] ?? {};

      const snapshot = {
        schema: 1,
        programme_id: i.programme_id,
        programme_name: prog.name,
        sponsor_id: prog.sponsor_id,
        sponsorship_ids: i.sponsorship_ids,
        period: { from: i.from, to: i.to },
        generated_at: new Date().toISOString(),
        cohort_k_min: k,
        sections: {
          delivery_evidence: {
            total_evidence_records: suppress(ev.total_count, ev.athletes_count),
            confirmed_records: suppress(ev.confirmed_count, ev.athletes_count),
            total_disbursed_pence: suppress(ev.total_pence, ev.athletes_count),
            athletes_with_evidence: suppress(ev.athletes_count, ev.athletes_count),
            narrative: i.narrative?.delivery_evidence ?? null,
            source: 'para_sport_delivery_evidence (confirmed by programme admin)',
          },
          athletic_outcomes: {
            training_sessions_attended: suppress(tr.sessions_attended, tr.athletes_attended),
            athletes_attended_training: suppress(tr.athletes_attended, tr.athletes_attended),
            competition_entries: suppress(cp.competition_entries, cp.athletes_competed),
            athletes_competed: suppress(cp.athletes_competed, cp.athletes_competed),
            narrative: i.narrative?.athletic_outcomes ?? null,
            source: 'para_provenance_links (athlete-linked training and competition records)',
          },
          development_milestones: {
            milestones_achieved: suppress(ms.milestones_achieved, ms.athletes_with_milestones),
            athletes_with_milestones: suppress(ms.athletes_with_milestones, ms.athletes_with_milestones),
            narrative: i.narrative?.development_milestones ?? null,
            source: 'para_provenance_links (athlete-linked para_pathway_milestones)',
          },
          valuation_estimates: {
            valuation_note: i.valuation_note ?? 'No valuation estimate included in this report.',
            narrative: i.narrative?.valuation_estimates ?? null,
            warning: 'Valuation figures are assumption-based estimates only, not measured facts. GotMyGame does not endorse or verify valuation claims.',
          },
        },
        exclusion_manifest: [
          { category: 'disability_diagnoses', screened_count: ex.disability_diagnoses_screened },
          { category: 'medical_files', screened_count: ex.medical_files_screened },
          { category: 'classification_evidence', screened_count: ex.classification_evidence_screened },
          { category: 'private_accessibility_requests', screened_count: ex.private_accessibility_requests_screened },
          { category: 'youth_pii_unmasked', screened_count: ex.youth_pii_unmasked_screened },
          { category: 'protected_participants', screened_count: ex.protected_participants_screened },
          { category: 'clinical_notes', screened_count: ex.clinical_notes_screened },
        ],
        causal_claim_policy: 'Report narratives must not assert causal links between sponsor funding and disability outcomes. Correlation and delivery evidence are reported as facts; outcomes are reported as athlete-approved records.',
        privacy_notice: 'This report contains aggregated operational and development data only. No athlete identity, disability diagnosis, medical record, classification evidence or personal information is included.',
      };

      const frozen = JSON.parse(JSON.stringify(snapshot));
      const hash = sha(frozen);

      const { rows: [report] } = await c.query(
        `INSERT INTO para_sponsor_impact_reports(programme_id, sponsor_id, sponsorship_ids, period_from, period_to, snapshot, content_sha256, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, issued_at, content_sha256`,
        [i.programme_id, prog.sponsor_id, i.sponsorship_ids, i.from, i.to, frozen, hash, user.id],
      );

      await audit(c, user.id, 'para_impact_report_issued', { report_id: report.id, programme_id: i.programme_id });
      return { id: report.id, content_sha256: report.content_sha256, issued_at: report.issued_at };
    });
  },
});

cap({
  name: 'list_para_sponsor_impact_reports',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/impact-reports',
  tag: TAG,
  summary: 'List issued para sponsor impact reports for a programme.',
  input: z.object({ programme_id: id, ...page }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const { prog } = await requireProgrammeAccess(user, i.programme_id, 'read', c);
      const rows = await many(
        `SELECT id, period_from, period_to, issued_at, content_sha256, snapshot->'sections' AS sections_summary
           FROM para_sponsor_impact_reports
          WHERE programme_id = $1
          ORDER BY issued_at DESC LIMIT $2 OFFSET $3`,
        [i.programme_id, i.limit, i.offset], c,
      );
      await auditOutcomeRead(c, user.id, prog.sponsor_id, 'para_impact_report_list', i.programme_id);
      return {
        reports: rows.map((r) => ({
          id: r.id,
          period_from: r.period_from,
          period_to: r.period_to,
          issued_at: r.issued_at,
          content_sha256: r.content_sha256,
          verified: verifyReport(r),
        })),
        total: rows.length,
      };
    });
  },
});

cap({
  name: 'get_para_sponsor_impact_report',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/impact-reports/:id',
  tag: TAG,
  summary: 'Read a single issued para impact report exactly as issued. verified=true when hash matches. Withdrawn story bodies are redacted inline.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const r = (await c.query('SELECT * FROM para_sponsor_impact_reports WHERE id=$1', [i.id])).rows[0];
      if (!r) throw notFound('Impact report');
      const { prog } = await requireProgrammeAccess(user, r.programme_id, 'read', c);

      const verified = verifyReport(r);
      const snapshot = { ...r.snapshot };

      // Redact any withdrawn story sections inline
      if (snapshot?.sections?.approved_stories?.stories) {
        for (const s of snapshot.sections.approved_stories.stories) {
          const live = (await c.query("SELECT status FROM para_story_consents WHERE id=$1", [s.id])).rows[0];
          if (live?.status === 'withdrawn') {
            s.sections = '[Story withdrawn by athlete]';
          }
        }
      }

      await auditOutcomeRead(c, user.id, prog.sponsor_id, 'para_impact_report_read', i.id);
      return { id: r.id, issued_at: r.issued_at, period_from: r.period_from, period_to: r.period_to, content_sha256: r.content_sha256, verified, snapshot };
    });
  },
});

cap({
  name: 'export_para_sponsor_impact_report',
  method: 'GET',
  path: '/para-sport-sponsorship-outcomes/impact-reports/:id/export',
  tag: TAG,
  summary: 'Export a para impact report as CSV, XLSX or PDF. Refuses if hash no longer matches the recorded content.',
  input: z.object({ id, format: z.enum(['csv', 'xlsx', 'pdf']).default('csv') }),
  async handler({ user }, i) {
    return withClient(async (c) => {
      const r = (await c.query('SELECT * FROM para_sponsor_impact_reports WHERE id=$1', [i.id])).rows[0];
      if (!r) throw notFound('Impact report');
      const { prog } = await requireProgrammeAccess(user, r.programme_id, 'read', c);

      if (!verifyReport(r)) throw unprocessable('This report no longer matches its recorded hash and cannot be exported. Contact GotMyGame if you believe this is an error.');

      await auditOutcomeRead(c, user.id, prog.sponsor_id, 'para_impact_report_export', i.id);

      // Flatten snapshot for export
      const rows = [
        ['Para-Sport Impact Report', ''],
        ['Programme', r.snapshot.programme_name ?? r.programme_id],
        ['Period', `${r.period_from} to ${r.period_to}`],
        ['Issued', r.issued_at],
        ['SHA-256', r.content_sha256],
        ['Verified', verifyReport(r) ? 'Yes' : 'HASH MISMATCH'],
        [''],
        ['Section', 'Metric', 'Value'],
        ...Object.entries(r.snapshot.sections ?? {}).flatMap(([section, data]) =>
          Object.entries(data)
            .filter(([k]) => !['narrative', 'source', 'warning'].includes(k))
            .map(([metric, value]) => [section, metric, value == null ? '(suppressed)' : value]),
        ),
        [''],
        ['Exclusion Manifest', '', ''],
        ...((r.snapshot.exclusion_manifest ?? []).map((e) => ['Excluded', e.category, e.screened_count])),
        [''],
        ['Privacy notice', r.snapshot.privacy_notice ?? ''],
      ];

      return exportReport({ format: i.format, rows, title: `Para-Sport Impact Report ${r.period_from} to ${r.period_to}` });
    });
  },
});
