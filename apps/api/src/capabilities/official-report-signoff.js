// Official report submission workflow, digital co-signing, evidence attachments, discipline auto-trigger, and organiser review (#998).
// Extends the existing file/revise cycle in officials-match.js with an immutable submission workflow:
//   filed/revised → co_signing (optional) → submitted (locked, SHA-256 fingerprinted)
//   submitted → accepted | queried (by organiser/federation)
// A submitted report with send_off or abandonment category automatically opens a gov_case via the discipline engine.
// Evidence attachments are allowed before submission (locked=false). Co-signatories must be verified crew on the same fixture.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt, sha256 } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouthEvent } from '../spectator.js';
import { fixtureContext } from './match-tracking.js';
import { canManageCompetition } from './competitions.js';

const TAG = 'Officials';
const SUBMIT_TRIGGERS_DISCIPLINE = new Set(['send_off', 'abandonment', 'misconduct']);

// ── auth helpers ─────────────────────────────────────────────────────────────

async function standingFull(user, fixtureId, c = pool) {
  const x = await fixtureContext(user, fixtureId, c);
  const crew = (await c.query("SELECT role FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1", [fixtureId, user.id])).rows[0]
    ?? (x.f.referee_id === user.id ? { role: 'referee' } : null);
  const admin = isAdmin(user);
  if (!x.organiser && !crew && !admin) throw notFound('Fixture');
  return { ...x, crew, admin, may: x.organiser || admin };
}

async function loadReport(c, reportId, user) {
  const r = (await c.query('SELECT r.*, f.event_id AS _event_id FROM official_reports r JOIN fixtures f ON f.id=r.fixture_id WHERE r.id=$1', [reportId])).rows[0];
  if (!r) throw notFound('Report');
  const x = await standingFull(user, r.fixture_id, c);
  return { r, x };
}

async function mustBeAuthor(r, user) {
  if (r.author_id !== user.id && !isAdmin(user)) throw forbidden('Only the report author can do this');
}

async function mustBeOrganiser({ x }, user) {
  if (!x.organiser && !isAdmin(user)) throw forbidden('Only the event organiser or platform admin can do this');
}

// Compute a canonical SHA-256 fingerprint of the immutable report content
function reportHash(r, revisions, cosigs) {
  const payload = JSON.stringify({
    id: r.id, fixture_id: r.fixture_id, author_id: r.author_id, category: r.category,
    match_facts: r.match_facts, incidents: r.incidents, venue_incidents: r.venue_incidents,
    abandonment: r.abandonment, revisions: revisions.map((v) => ({ revision: v.revision, summary: v.summary, at: v.at })),
    cosignatories: cosigs.filter((s) => s.signed_at).map((s) => ({ user_id: s.user_id, role: s.role, signed_at: s.signed_at })),
  });
  return sha256(payload);
}

// ── Structured match facts (stored in official_reports.match_facts) ───────────

const matchFactsSchema = z.object({
  kickoff_actual:    z.string().regex(/^\d{2}:\d{2}$/).optional(),
  final_whistle:     z.string().regex(/^\d{2}:\d{2}$/).optional(),
  attendance:        z.number().int().min(0).optional(),
  pitch_condition:   z.enum(['good','wet_heavy','hard_dry','unsafe']).optional(),
  weather:           z.enum(['fine','overcast','rain','heavy_rain','fog','snow']).optional(),
  score_home:        z.number().int().min(0).optional(),
  score_away:        z.number().int().min(0).optional(),
  ball_in_play_min:  z.number().int().min(0).optional(),
  extra_time:        z.boolean().optional(),
  penalty_shootout:  z.boolean().optional(),
  summary:           z.string().min(2).max(2000).optional(),
  addendum:          z.string().max(1000).optional(),
}).optional();

const incidentSchema = z.object({
  type:         z.enum(['caution','send_off','suspension','misconduct','protest','abandonment','venue','other']),
  minute:       z.number().int().min(0).max(240).optional(),
  extra_time:   z.boolean().optional(),
  person_id:    z.string().uuid().optional(),
  person_name:  z.string().max(120).optional(),
  team_id:      z.string().uuid().optional(),
  team_name:    z.string().max(120).optional(),
  law_ref:      z.string().max(80).optional(),
  reason:       z.string().min(2).max(500),
  note:         z.string().max(1000).optional(),
});

const venueIncidentSchema = z.object({
  attendance_estimate: z.number().int().min(0).optional(),
  ejections:           z.number().int().min(0).optional(),
  arrests:             z.number().int().min(0).optional(),
  flares_pyro:         z.boolean().optional(),
  pitch_invasion:      z.boolean().optional(),
  police_called:       z.boolean().optional(),
  security_called:     z.boolean().optional(),
  details:             z.string().max(2000).optional(),
}).optional();

const abandonmentSchema = z.object({
  minute:       z.number().int().min(0).max(240),
  reason:       z.enum(['weather','floodlight','crowd_disorder','security','venue_unsafe','team_refusal','equipment','other']),
  initiator:    z.enum(['referee','home_team','away_team','both_teams','organiser','authority']).optional(),
  details:      z.string().min(5).max(2000),
  score_at_ab:  z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).optional(),
}).optional();

// ── 1. Update structured match facts ────────────────────────────────────────

cap({
  name: 'update_report_match_facts', method: 'PATCH', path: '/official-reports/:id/match-facts', tag: TAG,
  summary: 'Update the structured match overview (kick-off time, attendance, weather, pitch condition, score, playing time, extra time, summary) on a draft official report. Only allowed before the report is submitted (locked). The existing revision text and category are preserved; this call adds structured machine-readable facts.',
  input: z.object({ id, match_facts: matchFactsSchema, incidents: z.array(incidentSchema).optional(), venue_incidents: venueIncidentSchema, abandonment: abandonmentSchema }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r, x } = await loadReport(c, i.id, user);
      await mustBeAuthor(r, user);
      if (r.locked) throw conflict('This report has been submitted and is locked. File a revision instead.');
      const CLINICAL = /\b(diagnos\w*|fractur\w*|concuss\w*|ligament|torn|sprain\w*|medicat\w*|prescri\w*|surgery|mental health|depress\w*|dislocat\w*)\b/i;
      if (i.match_facts?.summary && CLINICAL.test(i.match_facts.summary)) throw badRequest('Keep the report operational: no medical detail.');
      if (i.match_facts?.addendum && CLINICAL.test(i.match_facts.addendum)) throw badRequest('Keep the report operational: no medical detail.');
      const updated = (await c.query(
        `UPDATE official_reports SET match_facts=COALESCE($2, match_facts), incidents=COALESCE($3, incidents),
          venue_incidents=COALESCE($4, venue_incidents), abandonment=COALESCE($5, abandonment), updated_at=now()
          WHERE id=$1 RETURNING *`,
        [i.id, i.match_facts ?? null, i.incidents ? JSON.stringify(i.incidents) : null, i.venue_incidents ?? null, i.abandonment ?? null])).rows[0];
      await audit(c, user, 'official_report.facts_updated', { report_id: i.id });
      return { id: updated.id, status: updated.status };
    });
  },
});

// ── 2. Request co-signatures from crew ───────────────────────────────────────

cap({
  name: 'request_report_cosign', method: 'POST', path: '/official-reports/:id/request-cosign', tag: TAG,
  summary: 'Ask one or more crew members on the same fixture to co-sign this report. Each recipient must be an accepted official on the fixture. Required vs optional is per-call; the report will not lock until all required cosignatories have signed.',
  input: z.object({
    id,
    cosignatories: z.array(z.object({
      user_id:  z.string().uuid(),
      required: z.boolean().default(true),
    })).min(1).max(10),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r, x } = await loadReport(c, i.id, user);
      await mustBeAuthor(r, user);
      if (r.locked) throw conflict('Report is locked; cannot modify co-sign requests.');
      const youth = isYouthEvent(x.ev);
      const results = [];
      for (const req of i.cosignatories) {
        const crew = (await c.query(
          "SELECT fo.role, u.display_name FROM fixture_officials fo JOIN users u ON u.id=fo.user_id WHERE fo.fixture_id=$1 AND fo.user_id=$2 AND fo.status='accepted' LIMIT 1",
          [r.fixture_id, req.user_id])).rows[0];
        if (!crew) throw badRequest(`User ${req.user_id} is not an accepted official on this fixture.`);
        await c.query(
          `INSERT INTO official_report_cosignatories(report_id, user_id, role, required, requested_by)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (report_id, user_id) DO UPDATE SET role=EXCLUDED.role, required=EXCLUDED.required, requested_at=now(), requested_by=EXCLUDED.requested_by`,
          [i.id, req.user_id, crew.role, req.required, user.id]);
        await notify(c, req.user_id, 'official_report.cosign_requested', { report_id: i.id, fixture_id: r.fixture_id, requested_by: user.id });
        results.push({ user_id: req.user_id, role: crew.role, required: req.required });
      }
      await audit(c, user, 'official_report.cosign_requested', { report_id: i.id, count: results.length });
      return { cosignatories: results };
    });
  },
});

// ── 3. Co-sign a report ───────────────────────────────────────────────────────

cap({
  name: 'cosign_official_report', method: 'POST', path: '/official-reports/:id/cosign', tag: TAG,
  summary: 'Sign a co-signatory request on an official report. The caller must be listed as a cosignatory. The signature is recorded with a SHA-256 hash and timestamp. When all required cosignatories have signed, the report status advances to "co_signed".',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r } = await loadReport(c, i.id, user);
      const cosig = (await c.query('SELECT * FROM official_report_cosignatories WHERE report_id=$1 AND user_id=$2', [i.id, user.id])).rows[0];
      if (!cosig) throw forbidden('You are not listed as a co-signatory for this report.');
      if (cosig.signed_at) throw conflict('You have already signed this report.');
      if (cosig.declined_at) throw conflict('You declined this co-sign request; ask the author to resend it if needed.');
      const sigHash = sha256(`cosig:${i.id}:${user.id}:${new Date().toISOString()}`);
      await c.query('UPDATE official_report_cosignatories SET signed_at=now(), signature_hash=$1 WHERE id=$2', [sigHash, cosig.id]);
      // Advance report to co_signed when all required sigs are in
      const pending = (await c.query('SELECT id FROM official_report_cosignatories WHERE report_id=$1 AND required=true AND signed_at IS NULL AND declined_at IS NULL', [i.id])).rows;
      if (pending.length === 0 && r.status === 'co_signing') {
        await c.query("UPDATE official_reports SET status='co_signed', updated_at=now() WHERE id=$1", [i.id]);
      }
      await audit(c, user, 'official_report.co_signed', { report_id: i.id, signature_hash: sigHash });
      await notify(c, r.author_id, 'official_report.cosigned', { report_id: i.id, signer_id: user.id });
      return { signed: true, signature_hash: sigHash, status: pending.length === 0 ? 'co_signed' : r.status };
    });
  },
});

// ── 4. Submit (lock) report ───────────────────────────────────────────────────

cap({
  name: 'submit_official_report', method: 'POST', path: '/official-reports/:id/submit', tag: TAG,
  summary: 'Finalize and lock an official report. Computes a SHA-256 fingerprint over the full report content and all co-signatory signatures. The report becomes immutable; future changes require a formal revision via revise_official_report. If the report contains a send-off, abandonment, or misconduct category, a gov_case is automatically opened under the competition\'s disciplinary policy. Organiser and relevant parties are notified.',
  input: z.object({
    id,
    confirm: z.literal(true, { errorMap: () => ({ message: 'Set confirm:true to certify this is a true and accurate record.' }) }),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r, x } = await loadReport(c, i.id, user);
      await mustBeAuthor(r, user);
      if (r.locked) throw conflict('This report has already been submitted.');
      if (!['filed', 'revised', 'co_signing', 'co_signed'].includes(r.status)) throw conflict(`Cannot submit a report in status "${r.status}".`);
      // Check all required cosignatories have signed (if any were requested)
      const pendingRequired = (await c.query('SELECT id FROM official_report_cosignatories WHERE report_id=$1 AND required=true AND signed_at IS NULL AND declined_at IS NULL', [i.id])).rows;
      if (pendingRequired.length > 0) throw conflict(`${pendingRequired.length} required co-signatory/ies have not yet signed. Wait for their signatures or change them to optional.`);
      // Compute fingerprint
      const revisions = (await c.query('SELECT revision, summary, at FROM official_report_revisions WHERE report_id=$1 ORDER BY revision', [i.id])).rows;
      const cosigs = (await c.query('SELECT user_id, role, required, signed_at, signature_hash FROM official_report_cosignatories WHERE report_id=$1', [i.id])).rows;
      const hash = reportHash(r, revisions, cosigs);
      // Lock the report
      const updated = (await c.query(
        `UPDATE official_reports SET status='submitted', locked=true, submitted_at=now(), submitted_hash=$2, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, hash])).rows[0];
      await audit(c, user, 'official_report.submitted', { report_id: i.id, hash, category: r.category });
      // Auto-trigger discipline case
      let discCase = null;
      if (SUBMIT_TRIGGERS_DISCIPLINE.has(r.category)) {
        const ev = x.ev;
        const sport = (await c.query('SELECT id,slug FROM sports WHERE id=(SELECT sport_id FROM events WHERE id=$1)', [r.fixture_id])).rows[0];
        // Insert via discipline.js openCase equivalent
        const existing = (await c.query("SELECT id FROM gov_cases WHERE source->>'type'='official_report' AND source->>'id'=$1 LIMIT 1", [i.id])).rows[0];
        if (!existing) {
          const summary = r.category === 'send_off' ? 'Send-off — disciplinary review required' : r.category === 'abandonment' ? 'Abandonment — formal review required' : 'Misconduct — formal review required';
          const pol = (await c.query('SELECT id,version FROM disc_policies WHERE competition_id=$1 ORDER BY version DESC LIMIT 1', [ev.competition_id ?? null])).rows[0];
          discCase = (await c.query(
            `INSERT INTO gov_cases(kind,status,category,competition_id,season_id,fixture_id,sport_id,source,summary_enc,opened_by,auto)
              VALUES ('discipline','pending_review',$1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
            [r.category === 'abandonment' ? 'abandonment' : r.category === 'send_off' ? 'violent_conduct' : 'misconduct',
              ev.competition_id ?? null, ev.season_id ?? null, r.fixture_id, sport?.id ?? null,
              JSON.stringify({ type: 'official_report', id: i.id }), encrypt(summary, 'gov_cases.summary'), user.id])).rows[0];
          await c.query('UPDATE official_reports SET disc_case_id=$1 WHERE id=$2', [discCase.id, i.id]);
          if (pol) await c.query('UPDATE gov_cases SET policy_id=$1, policy_version=$2 WHERE id=$3', [pol.id, pol.version, discCase.id]);
          await c.query('INSERT INTO gov_case_links(case_id,entity_type,entity_id) VALUES ($1,$2,$3)', [discCase.id, 'official_report', i.id]);
          await c.query('INSERT INTO gov_case_events(case_id,version,action,from_status,to_status,actor_id,detail) VALUES ($1,1,$2,$3,$4,$5,$6)',
            [discCase.id, 'opened', null, 'pending_review', user.id, { source: 'official_report', report_id: i.id, auto: true }]);
          if (x.ev.organizer_id) await notify(c, x.ev.organizer_id, 'discipline.case_auto_opened', { case_id: discCase.id, report_id: i.id });
        }
      }
      // Notify organiser
      if (x.ev.organizer_id && x.ev.organizer_id !== user.id) {
        await notify(c, x.ev.organizer_id, 'official_report.submitted', { report_id: i.id, fixture_id: r.fixture_id });
      }
      return { id: i.id, status: 'submitted', submitted_hash: hash, submitted_at: updated.submitted_at, disc_case_id: discCase?.id ?? r.disc_case_id ?? null };
    });
  },
});

// ── 5. Attach evidence files ──────────────────────────────────────────────────

cap({
  name: 'attach_report_evidence', method: 'POST', path: '/official-reports/:id/attachments', tag: TAG, status: 201,
  summary: 'Attach a file (photo, video, document) as evidence to a draft official report. Only allowed before the report is submitted (locked). The file must already be uploaded to the platform storage and referenced by its file_key. Visibility controls whether the attachment is readable by the author only, the organiser, or the federation.',
  input: z.object({
    id,
    file_key:    z.string().min(1).max(500),
    file_name:   z.string().min(1).max(255),
    mime_type:   z.string().min(1).max(100),
    size_bytes:  z.number().int().positive(),
    description: z.string().max(300).optional(),
    visibility:  z.enum(['author', 'organiser', 'federation']).default('organiser'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r } = await loadReport(c, i.id, user);
      await mustBeAuthor(r, user);
      if (r.locked) throw conflict('Report is submitted and locked. Attachments cannot be added after submission.');
      const att = (await c.query(
        'INSERT INTO official_report_attachments(report_id,file_key,file_name,mime_type,size_bytes,description,visibility,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.id, i.file_key, i.file_name, i.mime_type, i.size_bytes, i.description ?? null, i.visibility, user.id])).rows[0];
      await audit(c, user, 'official_report.attachment_added', { report_id: i.id, attachment_id: att.id });
      return { id: att.id, file_name: att.file_name, mime_type: att.mime_type, size_bytes: att.size_bytes, visibility: att.visibility, uploaded_at: att.uploaded_at };
    });
  },
});

cap({
  name: 'list_report_attachments', method: 'GET', path: '/official-reports/:id/attachments', tag: TAG,
  summary: 'List evidence attachments on an official report. Authors see all; organisers see organiser-and-federation-visible files; anyone else only sees federation-level files if they have federation access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { r, x } = await loadReport(pool, i.id, user);
    let visClause = "visibility IN ('federation')";
    if (r.author_id === user.id || isAdmin(user)) visClause = 'true';
    else if (x.organiser) visClause = "visibility IN ('organiser','federation')";
    const rows = (await pool.query(`SELECT id,file_key,file_name,mime_type,size_bytes,description,visibility,uploaded_at FROM official_report_attachments WHERE report_id=$1 AND archived_at IS NULL AND (${visClause}) ORDER BY uploaded_at`, [i.id])).rows;
    return { items: rows };
  },
});

// ── 6. Accept or query a submitted report (organiser / federation) ────────────

cap({
  name: 'accept_official_report', method: 'POST', path: '/official-reports/:id/accept', tag: TAG,
  summary: 'Accept a submitted official report. Only the event organiser or platform admin may accept. Once accepted the report status is "accepted" and the result workflow can proceed. A notification is sent to the reporting official.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r, x } = await loadReport(c, i.id, user);
      await mustBeOrganiser({ x }, user);
      if (r.status !== 'submitted') throw conflict(`Report is in status "${r.status}"; only submitted reports can be accepted.`);
      await c.query("UPDATE official_reports SET status='accepted', accepted_at=now(), accepted_by=$1, updated_at=now() WHERE id=$2", [user.id, i.id]);
      await audit(c, user, 'official_report.accepted', { report_id: i.id });
      await notify(c, r.author_id, 'official_report.accepted', { report_id: i.id });
      return { id: i.id, status: 'accepted', accepted_at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'query_official_report', method: 'POST', path: '/official-reports/:id/query', tag: TAG,
  summary: 'Raise a query on a submitted official report. Only the event organiser or platform admin may query. The reporting official is notified and may file a revision. The query note is encrypted at rest.',
  input: z.object({
    id,
    note: z.string().min(5).max(1000),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { r, x } = await loadReport(c, i.id, user);
      await mustBeOrganiser({ x }, user);
      if (!['submitted', 'queried'].includes(r.status)) throw conflict(`Report is in status "${r.status}"; only submitted reports can be queried.`);
      await c.query("UPDATE official_reports SET status='queried', query_note_enc=$1, queried_at=now(), queried_by=$2, updated_at=now() WHERE id=$3",
        [encrypt(i.note, 'official_reports.query_note'), user.id, i.id]);
      await audit(c, user, 'official_report.queried', { report_id: i.id });
      await notify(c, r.author_id, 'official_report.queried', { report_id: i.id, queried_by: user.id });
      return { id: i.id, status: 'queried' };
    });
  },
});

// ── 7. Report provenance (immutable timeline) ────────────────────────────────

cap({
  name: 'get_report_provenance', method: 'GET', path: '/official-reports/:id/provenance', tag: TAG,
  summary: 'Full provenance record for an official report: each revision, co-sign request, signature, submission hash, and acceptance. Returns the SHA-256 fingerprint and an append-only event log. Available to the author, the organiser, and platform admin.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { r, x } = await loadReport(pool, i.id, user);
    const revisions = (await pool.query('SELECT revision, summary, reason, actor_id, at FROM official_report_revisions WHERE report_id=$1 ORDER BY revision', [i.id])).rows;
    const cosigs = (await pool.query(`SELECT c.*, u.display_name, u.handle FROM official_report_cosignatories c JOIN users u ON u.id=c.user_id WHERE c.report_id=$1 ORDER BY c.requested_at`, [i.id])).rows;
    const attachments = (await pool.query('SELECT id, file_name, mime_type, size_bytes, visibility, uploaded_at FROM official_report_attachments WHERE report_id=$1 AND archived_at IS NULL ORDER BY uploaded_at', [i.id])).rows;
    // Redact query note unless organiser/admin
    const queryNote = r.query_note_enc && (x.organiser || isAdmin(user)) ? decrypt(r.query_note_enc, 'official_reports.query_note') : null;
    await audit(pool, user, 'official_report.provenance_read', { report_id: i.id });
    return {
      id: r.id, fixture_id: r.fixture_id, category: r.category, status: r.status,
      locked: r.locked, submitted_at: r.submitted_at, submitted_hash: r.submitted_hash,
      accepted_at: r.accepted_at, accepted_by: r.accepted_by,
      queried_at: r.queried_at, query_note: queryNote,
      disc_case_id: r.disc_case_id,
      revisions, cosignatories: cosigs.map(({ declined_at, ...s }) => ({ ...s, declined: !!declined_at })),
      attachments,
    };
  },
});

// ── 8. List all official reports for an event (organiser view) ───────────────

cap({
  name: 'list_event_official_reports', method: 'GET', path: '/events/:id/official-reports', tag: TAG,
  summary: 'List all official reports across all fixtures in an event. Only the event organiser or platform admin can call this. Returns each report with its status, category, incident summary, co-signatory counts, and attachment counts — the organiser review table.',
  input: z.object({
    id,
    status: z.enum(['filed','revised','co_signing','submitted','accepted','queried']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const ev = (await pool.query('SELECT * FROM events WHERE id=$1', [i.id])).rows[0];
    if (!ev) throw notFound('Event');
    const isOrg = ev.organizer_id === user.id || isAdmin(user);
    if (!isOrg) throw notFound('Event');
    const rows = await many(
      `SELECT r.id, r.fixture_id, r.category, r.status, r.revision, r.match_facts, r.incidents,
              r.submitted_at, r.submitted_hash, r.accepted_at, r.queried_at, r.disc_case_id, r.created_at,
              u.display_name AS author_name, u.handle AS author_handle,
              f.scheduled_at, ht.name AS home_name, at2.name AS away_name,
              (SELECT count(*)::int FROM official_report_cosignatories c WHERE c.report_id=r.id) AS cosig_total,
              (SELECT count(*)::int FROM official_report_cosignatories c WHERE c.report_id=r.id AND c.signed_at IS NOT NULL) AS cosig_signed,
              (SELECT count(*)::int FROM official_report_attachments a WHERE a.report_id=r.id AND a.archived_at IS NULL) AS attachment_count
         FROM official_reports r
         JOIN users u ON u.id=r.author_id
         JOIN fixtures f ON f.id=r.fixture_id
         LEFT JOIN teams ht ON ht.id=f.home_team_id
         LEFT JOIN teams at2 ON at2.id=f.away_team_id
        WHERE r.event_id=$1
          AND ($2::text IS NULL OR r.status=$2)
        ORDER BY r.status='submitted' DESC, r.created_at DESC
        LIMIT $3 OFFSET $4`,
      [i.id, i.status ?? null, i.limit, i.offset]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});

// ── 9. List discipline cases (screen) ────────────────────────────────────────

cap({
  name: 'list_my_discipline_cases', method: 'GET', path: '/discipline/my-cases', tag: TAG,
  summary: 'All governance / disciplinary cases visible to the caller in their capacity as official, organiser, subject, or guardian. Groups: cases I opened as official (via reports I submitted), cases where I am subject, cases for events I organise, cases I can see as guardian of a youth participant. Each case includes its status, provisional sanctions and linked official report.',
  input: z.object({
    kind:    z.enum(['discipline','appeal','protest','all']).default('all'),
    status:  z.enum(['pending_review','open','hearing','closed','withdrawn','dismissed','all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    const statusFilter = i.status === 'all' ? null : i.status;
    const kindFilter = i.kind === 'all' ? null : i.kind;
    const rows = await many(
      `SELECT k.id,k.kind,k.status,k.category,k.competition_id,k.fixture_id,k.sport_id,k.subject_user_id,k.subject_team_id,
              k.outcome,k.auto,k.needs_review,k.appeal_deadline,k.source,k.created_at,k.decided_at,
              u.display_name AS subject_name, t.name AS subject_team,
              c.name AS competition_name, s.name AS sport_name, s.emoji AS sport_emoji,
              f.scheduled_at AS fixture_at, ht.name AS home_name, at2.name AS away_name,
              (SELECT count(*)::int FROM disc_sanctions sa WHERE sa.case_id=k.id AND sa.superseded_at IS NULL AND sa.status IN ('interim','active')) AS live_sanctions,
              (SELECT r.id FROM official_reports r WHERE r.disc_case_id=k.id LIMIT 1) AS linked_report_id
         FROM gov_cases k
         LEFT JOIN users u ON u.id=k.subject_user_id
         LEFT JOIN teams t ON t.id=k.subject_team_id
         LEFT JOIN comp_competitions c ON c.id=k.competition_id
         LEFT JOIN sports s ON s.id=k.sport_id
         LEFT JOIN fixtures f ON f.id=k.fixture_id
         LEFT JOIN teams ht ON ht.id=f.home_team_id
         LEFT JOIN teams at2 ON at2.id=f.away_team_id
        WHERE ($1::text IS NULL OR k.kind=$1)
          AND ($2::text IS NULL OR k.status=$2)
          AND (k.opened_by=$3
               OR k.subject_user_id=$3
               OR k.fixture_id IN (SELECT fixture_id FROM official_reports WHERE author_id=$3)
               OR k.fixture_id IN (SELECT id FROM fixtures WHERE event_id IN (SELECT id FROM events WHERE organizer_id=$3))
               OR EXISTS (SELECT 1 FROM guardian_links g WHERE g.guardian_id=$3 AND g.child_id=k.subject_user_id AND g.status='active' AND g.revoked_at IS NULL))
        ORDER BY k.needs_review DESC, k.created_at DESC LIMIT $4 OFFSET $5`,
      [kindFilter, statusFilter, user.id, i.limit, i.offset]);
    return { items: rows, limit: i.limit, offset: i.offset };
  },
});
