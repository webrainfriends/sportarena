// Para-sport officials workflow (#1027, R29): class-code context for the official's lineup view, sport-adapted
// procedures, the official's own accessibility needs, and classification protest / equipment non-conformance
// incident filing. Officials see para_outcomes (competition sport class only) — never para_cases, para_evidence
// or any medical classifier data. The classification workflow remains entirely separate.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, hasRole, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { isYouthEvent } from '../spectator.js';
import { fixtureContext } from './match-tracking.js';
import { packOf } from './rule-packs.js';

const TAG = 'Officials';

// Reports must be operational. This guard blocks medical detail from incidents (same as official-reports).
const CLINICAL = /\b(diagnos\w*|fractur\w*|concuss\w*|ligament|torn|sprain\w*|medicat\w*|prescri\w*|surgery|mental health|depress\w*|dislocat\w*)\b/i;
const noClinical = (text) => { if (text && CLINICAL.test(text)) throw badRequest('Keep the incident operational: describe what you observed on the field, not medical detail. Medical information is never stored in an official incident report.'); };

const INCIDENT_KINDS = ['classification_protest', 'equipment_non_conformance', 'procedure_breach', 'guide_pairing', 'other'];
const NEED_KINDS = ['hearing_loop', 'large_font', 'high_contrast', 'screen_reader', 'haptic_alerts', 'written_comms', 'sign_language_interpreter', 'assistive_device', 'other'];

/** The caller's standing on a fixture — same guard as officials-match.js. */
async function standing(user, fixtureId) {
  const x = await fixtureContext(user, fixtureId, pool);
  const crew = (await one("SELECT role FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1", [fixtureId, user.id])) ??
               (x.f.referee_id === user.id ? { role: 'referee' } : null);
  const admin = isAdmin(user);
  if (!x.organiser && !crew && !admin) throw notFound('Fixture');
  return { ...x, crew, admin, may: x.organiser || admin };
}

// ------------------------------------------------------------------ para match context

cap({
  name: 'get_para_match_context', method: 'GET', path: '/fixtures/:id/para-context', tag: TAG,
  summary: 'Competition sport class codes for every athlete in this fixture, sourced from federation-approved para_outcomes only. Officials never see medical evidence, classifier assessment records or para_cases. Provisional-status athletes are flagged. Youth athlete names are suppressed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { f, ev, organiser, crew, admin } = await standing(user, i.id);
    const youth = isYouthEvent(ev);

    // Load class codes from para_outcomes joined to game participants.
    // We explicitly only touch para_outcomes (the public competition result) — never para_cases or para_evidence.
    const athletes = await many(
      `SELECT
         ma.id AS appearance_id,
         ma.team_id,
         ma.status AS appearance_status,
         CASE WHEN $2 THEN NULL ELSE u.display_name END AS display_name,
         u.id AS athlete_id,
         u.handle,
         u.avatar_emoji,
         u.avatar_color,
         po.class_code,
         po.class_name,
         po.category,
         po.outcome_status,
         po.provisional,
         pc.events AS eligible_events,
         pc.categories AS eligible_categories,
         t.name AS team_name,
         t.emoji AS team_emoji
       FROM match_appearances ma
       JOIN users u ON u.id = ma.user_id
       LEFT JOIN para_outcomes po
         ON po.athlete_id = ma.user_id
        AND po.sport_id   = (SELECT sport_id FROM events WHERE id = $3)
        AND po.outcome_status IN ('confirmed','temporary','review_required')
        AND po.archived_at IS NULL
       LEFT JOIN para_classes pc ON pc.id = po.class_id
       LEFT JOIN teams t ON t.id = ma.team_id
       WHERE ma.fixture_id = $1 AND ma.archived_at IS NULL
       ORDER BY t.name, u.display_name`,
      [f.id, youth, ev.id],
    );

    // Count provisional athletes for the briefing summary.
    const provisional_count = athletes.filter((a) => a.provisional).length;
    const has_para = athletes.some((a) => a.class_code != null);

    return {
      fixture_id: f.id,
      sport_id: ev.sport_id,
      has_para_athletes: has_para,
      provisional_count,
      youth_names_suppressed: youth,
      privacy_notice: 'Competition sport class codes only. Medical evidence, diagnosis and classifier assessment records are not accessible from this endpoint.',
      athletes: athletes.map((a) => ({
        appearance_id: a.appearance_id,
        athlete_id: a.athlete_id,
        display_name: a.display_name,
        handle: a.handle,
        avatar_emoji: a.avatar_emoji,
        avatar_color: a.avatar_color,
        team_name: a.team_name,
        team_emoji: a.team_emoji,
        appearance_status: a.appearance_status,
        para: a.class_code ? {
          class_code: a.class_code,
          class_name: a.class_name,
          category: a.category,
          outcome_status: a.outcome_status,
          provisional: a.provisional ?? false,
          eligible_events: a.eligible_events ?? [],
          eligible_categories: a.eligible_categories ?? [],
        } : null,
      })),
    };
  },
});

// ------------------------------------------------------------------ sport-adapted procedure

// Hardcoded IPC/federation-standard para procedure hints per sport slug.
// Organisers can add per-fixture overrides via set_fixture_para_procedure.
const PARA_PROCEDURES = {
  athletics: {
    time_extensions: 'False-start rules per standard IPC Athletics Rules of Competition. Photo-finish mandatory for all T/F-class track events. Starting-block prosthetic attachments allowed; starter confirms before "Set" command.',
    substitution_limits: 'Standard athletics substitution rules apply. No additional substitutions for para classification.',
    signal_protocols: 'Dual-signal required (auditory + visual light flash on blocks) whenever a heat includes athletes with hearing impairment. False-start: red flag raised simultaneously with tone. Finish-line judge: verbal + arm signal for each heat.',
    communication_adaptations: 'Written communication boards on request for deaf athletes. Interpreter positioning must not obstruct timing equipment. Visual countdown display recommended for start sequence.',
    equipment_notes: 'Prosthetic blades and racing chairs must comply with IPC Athletics Technical Rules Rule 54–61. Any suspected non-conformance must be reported immediately to the technical delegate before the event commences.',
    source_ref: 'IPC Athletics Technical Rules 2025–2028 · Rule 54–61',
  },
  wheelchair_basketball: {
    time_extensions: 'Shot clock: standard 24-second rule applies. No additional time extension for wheelchair manoeuvring. Personal-foul limit unchanged. Shot-clock operator receives dual auditory + visual signal from officials.',
    substitution_limits: 'Five substitutions per game per IWBF rules. Wheelchair malfunction: referee may grant a 60-second timeout for chair adjustment at their discretion (once per team per game).',
    signal_protocols: 'Whistle plus arm signal for all calls. Scoreboard must show audible buzzer + visible countdown. Announcement system must have hearing-loop-compatible output for accessible seating.',
    communication_adaptations: 'Written boards for chair-side communication with deaf athletes. Interpreter can be positioned on the bench line with explicit referee acknowledgement.',
    equipment_notes: 'All competition wheelchairs must comply with IWBF Equipment Regulations. Anti-tip devices, footrests and frames are inspected pre-game by the equipment inspector. Officials do not inspect chairs — refer to equipment inspector.',
    source_ref: 'IWBF Official Rules 2022–2026 · Rules 1–4 (Equipment & Players)',
  },
  blind_football: {
    time_extensions: 'Two 25-minute halves, 10-minute half-time. No time-wasting extension; standard IBSA rules apply.',
    substitution_limits: 'Maximum 5 substitutions per match from a maximum bench of 4.',
    signal_protocols: 'Referee must use a distinctive two-tone whistle sequence to signal the goalkeeper when kicking (toque). "Voy!" call protocol: attackers must verbalise before attempting to tackle. Officials must remain silent except for official calls.',
    communication_adaptations: 'No spectator noise during active play (mandatory quiet zones). PA announcer must pause. Officials use tactile shoulder taps plus whistle for direct communication with outfield players. Guides (behind each goal) must only call their agreed signal.',
    equipment_notes: 'Ball must contain noise-maker (bell) compliant with IBSA Footb-B2 standard. Goalkeepers are sighted — confirm eye-shielding compliance for B1 outfield players before kick-off.',
    source_ref: 'IBSA Blind Football Rules 2024–2028 · Article 4–10',
  },
  sitting_volleyball: {
    time_extensions: 'Five sets; first four sets to 25 points, fifth set to 15. No time extensions specific to para classification.',
    substitution_limits: 'Standard volleyball substitution rules (6 per set). Players must maintain sitting position with at least one buttock touching the floor when making contact with the ball.',
    signal_protocols: 'Standard volleyball hand signals. Net-fault signal: official must check that the contact rule (buttock on floor) is applied consistently throughout the match.',
    communication_adaptations: 'Line judges must use arm signals simultaneously with any call, as the court surface noise may impede hearing. Scoring board must be clearly visible from both ends.',
    equipment_notes: 'Court dimensions: 10m × 6m. Net heights: men 1.15m, women 1.05m. Net tape and antennas as per standard volleyball.',
    source_ref: 'World ParaVolley Rules of the Game 2024 · Article 1–5',
  },
  boccia: {
    time_extensions: 'Time clock starts when ball is released. BC1/BC2: 5 minutes per end. BC3/BC4: 4 minutes per end. Time-out: 1 per athlete per end, maximum 60 seconds.',
    substitution_limits: 'Individual competition: no substitutions. Team BC1/BC2: substitutions allowed before an end starts.',
    signal_protocols: 'Referee signals via visual flag (yellow = time warning, red = infringement). Quiet during play — no auditory signals except formal calls. Tactile ramp inspection conducted before each end for BC3.',
    communication_adaptations: 'Athletes using communication devices: referee must wait for the full signal before ruling time. BISFed rule 11.2 applies. Interpreters must be pre-registered.',
    equipment_notes: 'All balls inspected per BISFed equipment regulations. Ramps must comply with approved specifications. Classification documents (BC class) are on record — do not request or handle.',
    source_ref: 'BISFed Boccia Rules of Sport 2024–2028 · Article 11–14',
  },
  goalball: {
    time_extensions: 'Two 12-minute halves. Penalty awarded immediately for infringement; no extra time in regular play.',
    substitution_limits: 'Two timeouts per team per half. Substitutions between periods only.',
    signal_protocols: 'Absolute silence required during play — this is a legal requirement under IBSA rules. Officials must enforce silence on bench, sideline and spectators. Whistle only for stoppages. Tactile shoulder signal to restart play.',
    communication_adaptations: 'Written boards for coach communication. Sound system must be on mute during active play. Officials\' calls must be verbal and confirmed with the goal judge tactile signal.',
    equipment_notes: 'All players must wear opaque eyeshades at all times. Referee must verify eyeshade compliance before play starts. Ball must produce audible rattle throughout play.',
    source_ref: 'IBSA Goalball Rules of the Game 2024 · Rule 2–8',
  },
};

const DEFAULT_PROCEDURE = {
  time_extensions: 'Standard sport rules apply. Refer to the sport-specific IPC/federation para procedure documentation for this sport.',
  substitution_limits: 'Standard sport substitution rules apply.',
  signal_protocols: 'All signals should be both auditory and visual where applicable.',
  communication_adaptations: 'Written communication boards are recommended for all para-sport fixtures. Interpreter positioning at referee discretion.',
  equipment_notes: 'Equipment compliance per governing-body regulations. Refer to the technical delegate for para-specific equipment checks.',
  source_ref: 'IPC Sports Technical Rules — refer to governing body for sport-specific guidance',
};

cap({
  name: 'get_para_officiating_procedure', method: 'GET', path: '/sports/:sport/para-procedure', tag: TAG,
  summary: 'Sport-specific para officiating procedure: time extensions, substitution rules, dual signal protocols, communication adaptations and equipment conformance triggers. Returns IPC/federation-standard guidance for the sport slug, supplemented by any locally stored overrides.',
  input: z.object({ sport: z.string().min(1).max(80) }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to view officiating procedures');
    const sport = await one('SELECT id, slug, name, emoji FROM sports WHERE slug=$1 OR id::text=$1', [i.sport]);
    if (!sport) throw notFound('sport');
    const base = PARA_PROCEDURES[sport.slug] ?? DEFAULT_PROCEDURE;
    return { sport_id: sport.id, sport_slug: sport.slug, sport_name: sport.name, sport_emoji: sport.emoji, ...base };
  },
});

cap({
  name: 'get_fixture_para_procedure', method: 'GET', path: '/fixtures/:id/para-procedure', tag: TAG,
  summary: 'Sport-specific para officiating procedure for a fixture, including any per-fixture overrides set by the organiser.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { f, ev } = await standing(user, i.id);
    const sport = await one('SELECT id, slug, name, emoji FROM sports WHERE id=$1', [ev.sport_id]);
    const base = PARA_PROCEDURES[sport?.slug] ?? DEFAULT_PROCEDURE;
    const override = await one('SELECT overrides FROM para_fixture_procedures WHERE fixture_id=$1', [f.id]);
    const merged = override ? { ...base, ...override.overrides } : base;
    return { fixture_id: f.id, sport_id: ev.sport_id, sport_slug: sport?.slug, sport_name: sport?.name, ...merged, has_overrides: !!override };
  },
});

cap({
  name: 'set_fixture_para_procedure', method: 'POST', path: '/fixtures/:id/para-procedure', tag: TAG,
  summary: 'Organiser sets per-fixture overrides to the standard para officiating procedure (e.g. modified signal protocol for a specific venue).',
  input: z.object({
    id,
    time_extensions: z.string().max(1000).optional(),
    substitution_limits: z.string().max(1000).optional(),
    signal_protocols: z.string().max(1000).optional(),
    communication_adaptations: z.string().max(1000).optional(),
    equipment_notes: z.string().max(1000).optional(),
    other: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { f, ev, may } = await standing(user, i.id);
      if (!may) throw forbidden('Only the organiser or an admin may set fixture procedure overrides');
      const overrides = {};
      for (const k of ['time_extensions','substitution_limits','signal_protocols','communication_adaptations','equipment_notes','other']) {
        if (i[k] != null) overrides[k] = i[k];
      }
      await c.query(
        `INSERT INTO para_fixture_procedures (fixture_id, sport_id, overrides, set_by, set_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (fixture_id) DO UPDATE SET overrides=$3, set_by=$4, set_at=now()`,
        [f.id, ev.sport_id, JSON.stringify(overrides), user.id],
      );
      return { fixture_id: f.id, overrides };
    });
  },
});

cap({
  name: 'get_offline_para_rules', method: 'GET', path: '/fixtures/:id/offline-para-rules', tag: TAG,
  summary: 'Returns a signed sport-specific para procedure pack for offline use. Token is valid for 7 days.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { f, ev } = await standing(user, i.id);
    const sport = await one('SELECT id, slug, name FROM sports WHERE id=$1', [ev.sport_id]);
    const base = PARA_PROCEDURES[sport?.slug] ?? DEFAULT_PROCEDURE;
    const override = await one('SELECT overrides FROM para_fixture_procedures WHERE fixture_id=$1', [f.id]);
    const merged = override ? { ...base, ...override.overrides } : base;
    const token = await packOf({ content: merged, sport_id: ev.sport_id, fixture_id: f.id }, user.id, 7);
    return { token, sport_name: sport?.name, fixture_id: f.id, valid_days: 7 };
  },
});

// ------------------------------------------------------------------ official's own accessibility needs

cap({
  name: 'get_my_assistive_needs', method: 'GET', path: '/me/assistive-needs', tag: TAG,
  summary: 'Get your declared assistive device and communication needs for match-day use. Used to adapt match controls and flag needs to co-officials and venue.',
  input: z.object({}),
  async handler({ user }) {
    if (!user) throw forbidden('Sign in to view accessibility preferences');
    const row = await one('SELECT prefs, needs FROM official_assistive_needs WHERE official_id=$1', [user.id]);
    if (!row) return { prefs: {}, needs: [] };
    // Decrypt detail fields
    const needs = (row.needs ?? []).map((n) => ({
      ...n,
      detail: n.detail_enc ? (() => { try { return decrypt(n.detail_enc, 'official_assistive_needs.detail'); } catch { return null; } })() : null,
      detail_enc: undefined,
    }));
    await audit(null, user.id, 'read', 'official_assistive_needs', user.id);
    return { prefs: row.prefs ?? {}, needs };
  },
});

cap({
  name: 'set_my_assistive_needs', method: 'POST', path: '/me/assistive-needs', tag: TAG,
  summary: 'Declare your accessibility needs and preferences for match-day controls. Sensitive device details are stored encrypted. These are used to adapt the match console layout and to flag requirements to co-officials and venue staff.',
  input: z.object({
    prefs: z.object({
      large_targets: z.boolean().optional(),
      high_contrast: z.boolean().optional(),
      screen_reader: z.boolean().optional(),
      hearing_loop: z.boolean().optional(),
      haptic_alerts: z.boolean().optional(),
      written_comms: z.boolean().optional(),
    }).optional(),
    needs: z.array(z.object({
      kind: z.enum(NEED_KINDS),
      detail: z.string().max(500).optional(),
      severity: z.enum(['preferred','required','critical']).optional(),
      notes: z.string().max(500).optional(),
    })).max(20).optional(),
  }),
  async handler({ user }, i) {
    if (!user) throw forbidden('Sign in to save accessibility preferences');
    return tx(async (c) => {
      const needs = (i.needs ?? []).map((n) => ({
        kind: n.kind,
        severity: n.severity ?? 'required',
        notes: n.notes ?? null,
        detail_enc: n.detail ? encrypt(n.detail, 'official_assistive_needs.detail') : null,
      }));
      await c.query(
        `INSERT INTO official_assistive_needs (official_id, prefs, needs, updated_by, updated_at)
         VALUES ($1,$2,$3,$1,now())
         ON CONFLICT (official_id) DO UPDATE SET prefs=$2, needs=$3, updated_by=$1, updated_at=now()`,
        [user.id, JSON.stringify(i.prefs ?? {}), JSON.stringify(needs)],
      );
      await audit(c, user.id, 'write', 'official_assistive_needs', user.id);
      return { saved: true, need_count: needs.length };
    });
  },
});

// ------------------------------------------------------------------ para incident reports

cap({
  name: 'file_para_incident', method: 'POST', path: '/fixtures/:id/para-incidents', tag: TAG, status: 201,
  summary: 'File a classification protest, equipment non-conformance or procedure breach for a fixture. This creates an operational incident record and a formal Case forwarded to the governing body. Medical detail is not accepted. This does not update the athlete\'s classification record.',
  input: z.object({
    id,
    kind: z.enum(INCIDENT_KINDS),
    description: z.string().min(10).max(2000),
    athlete_id: id.optional(),
    class_code: z.string().max(20).optional(),
  }),
  async handler({ user }, i) {
    const { f, ev, crew } = await standing(user, i.id);
    if (!crew) throw forbidden('Only confirmed crew may file para incidents');
    noClinical(i.description);
    if (i.athlete_id) {
      // confirm athlete is in this fixture
      const ap = await one('SELECT id FROM match_appearances WHERE fixture_id=$1 AND user_id=$2 AND archived_at IS NULL LIMIT 1', [f.id, i.athlete_id]);
      if (!ap) throw badRequest('Athlete is not in this fixture');
    }
    return tx(async (c) => {
      const { rows: [incident] } = await c.query(
        `INSERT INTO para_official_incidents (fixture_id, filed_by, kind, description, athlete_id, class_code, status)
         VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING *`,
        [f.id, user.id, i.kind, i.description, i.athlete_id ?? null, i.class_code ?? null],
      );
      // Also create a Cases record so the federation gets notified through the standard dispute workflow.
      const KIND_LABEL = {
        classification_protest: 'Para classification protest',
        equipment_non_conformance: 'Para equipment non-conformance',
        procedure_breach: 'Para procedure breach',
        guide_pairing: 'Para guide pairing concern',
        other: 'Para officiating incident',
      };
      const { rows: [caseRow] } = await c.query(
        `INSERT INTO cases (reporter_id, subject, description, category, priority, status, entity_kind, entity_id)
         VALUES ($1,$2,$3,'officiating_integrity','normal','open','fixture',$4) RETURNING id`,
        [user.id, `${KIND_LABEL[i.kind]} — Fixture #${f.id.slice(0,8)}`, i.description, f.id],
      );
      await c.query('UPDATE para_official_incidents SET case_id=$1 WHERE id=$2', [caseRow.id, incident.id]);
      // Notify organiser
      await notify(c, ev.organizer_id, {
        kind: 'para_incident_filed',
        title: KIND_LABEL[i.kind],
        body: `${user.display_name} filed a para incident for ${ev.name}.`,
        data: { fixture_id: f.id, incident_id: incident.id },
      });
      return { ...incident, case_id: caseRow.id };
    });
  },
});

cap({
  name: 'list_para_incidents', method: 'GET', path: '/fixtures/:id/para-incidents', tag: TAG,
  summary: 'List classification protests and equipment non-conformance incidents for a fixture.',
  input: z.object({ id, status: z.enum(['open','under_review','resolved','dismissed','all']).optional() }),
  async handler({ user }, i) {
    await standing(user, i.id);
    const filter = i.status && i.status !== 'all' ? `AND poi.status='${i.status}'` : '';
    const rows = await many(
      `SELECT poi.*, u.display_name AS filed_by_name, u.handle AS filed_by_handle,
              a.display_name AS athlete_name
         FROM para_official_incidents poi
         JOIN users u ON u.id = poi.filed_by
         LEFT JOIN users a ON a.id = poi.athlete_id
        WHERE poi.fixture_id=$1 ${filter}
        ORDER BY poi.created_at DESC`,
      [i.id],
    );
    return { incidents: rows, total: rows.length };
  },
});

cap({
  name: 'resolve_para_incident', method: 'PATCH', path: '/para-incidents/:id/resolve', tag: TAG,
  summary: 'Organiser or admin resolves or dismisses a para incident.',
  input: z.object({
    id,
    status: z.enum(['resolved', 'dismissed', 'under_review']),
    resolution: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const incident = (await c.query('SELECT * FROM para_official_incidents WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!incident) throw notFound('para incident');
      const { f, may } = await standing(user, incident.fixture_id);
      if (!may) throw forbidden('Only the organiser or admin may resolve para incidents');
      await c.query(
        'UPDATE para_official_incidents SET status=$1, resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$4',
        [i.status, i.resolution ?? null, user.id, i.id],
      );
      return (await c.query('SELECT * FROM para_official_incidents WHERE id=$1', [i.id])).rows[0];
    });
  },
});
