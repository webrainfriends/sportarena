// PS-09: class-aware para-sport results, leaderboards and records.
// Results are bound to the athlete's sport class at submission time; the snapshot is frozen in JSONB and
// never contains clinical text. Cross-class comparisons are refused. All caps go through the standard
// cap() registry so REST, OpenAPI and MCP share identical behaviour.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound, unprocessable, conflict } from '../errors.js';
import { isAdmin, sportBySlugOrId } from '../helpers.js';
import { validateValue, officialPoints } from '../scoring/performance-rules.js';
import { resolveRule } from '../scoring/metric-defs.js';
import { onResultsChanged } from '../rankings/data.js';
import { outcomeAt } from '../para.js';
import { notify } from '../notify.js';

const TAG = 'Para results';
const t = (n) => z.string().trim().min(1).max(n);

// classification_snapshot stores ONLY: {class_code, status, version_ref, effective_from}
// Never clinical text. sport_class NULL = non-para row (backward-compatible).
function buildSnapshot(o) {
  return { class_code: o.class_code, status: o.status, version_ref: o.decision_ref ?? null, effective_from: o.effective_from };
}

async function loadLiveOutcome(c, athleteId, sportId) {
  const o = await outcomeAt({ query: (q, p) => c.query(q, p) }, athleteId, sportId, new Date(), null);
  return o;
}

async function requireParaOutcome(c, athleteId, sportId, classCode) {
  const o = await loadLiveOutcome(c, athleteId, sportId);
  if (!o) throw unprocessable('No classification on record for this athlete in this sport. A result cannot be recorded without an active sport class.');
  if (o.status === 'not_eligible') throw unprocessable('This athlete is not eligible to compete in this sport. A result cannot be recorded.');
  if (classCode && o.class_code !== classCode) throw unprocessable(`The submitted class (${classCode}) does not match the athlete's current class (${o.class_code}).`);
  return o;
}

async function detectRecords(c, perf) {
  if (!perf.sport_class) return { world_record: false, national_record: false, personal_best: false, records: [] };
  const { sport_id, sport_class, metric, value, unit, direction, user_id, event_id, id: perfId, achieved_on } = perf;
  const sport = await one('SELECT slug FROM sports WHERE id=$1', [sport_id]);
  const better = direction === 'lower' ? (a, b) => a < b : (a, b) => a > b;
  const detected = [];

  const checkType = async (record_type, extraWhere, params) => {
    const existing = (await c.query(
      `SELECT id, value FROM para_records WHERE sport_id=$1 AND sport_class=$2 AND metric=$3 AND record_type=$4 AND status='current' ${extraWhere} LIMIT 1`,
      [sport_id, sport_class, metric, record_type, ...params])).rows[0];
    if (!existing || better(value, existing.value)) {
      if (existing) {
        await c.query("UPDATE para_records SET status='historic', superseded_by_id=CURRVAL('para_records_id_seq') WHERE id=$1", []);
        // insert new, then update old to point to it
      }
      const rec = (await c.query(
        `INSERT INTO para_records(sport_id, sport_class, metric, unit, direction, record_type, value, holder_user_id, achieved_at, event_id, performance_id, provenance, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'official','pending_ratification') RETURNING id`,
        [sport_id, sport_class, metric, unit ?? null, direction ?? 'lower', record_type, value, user_id, achieved_on ?? new Date().toISOString().slice(0, 10), event_id ?? null, perfId])).rows[0];
      if (existing) await c.query('UPDATE para_records SET status=$1, superseded_by_id=$2 WHERE id=$3', ['historic', rec.id, existing.id]);
      detected.push({ record_type, id: rec.id });
      return true;
    }
    return false;
  };

  // personal best
  const pb = await checkType('personal_best', 'AND holder_user_id=$5', [user_id]);

  // world record (no country restriction)
  const wr = await checkType('world', '', []);

  // national record — look up athlete's nationality
  const nat = (await c.query('SELECT nationality FROM users WHERE id=$1', [user_id])).rows[0]?.nationality;
  const nr = nat ? await checkType('national', 'AND governing_body=$5', [nat]) : false;

  if (wr || nr || pb) onResultsChanged(sport_id);
  return { world_record: wr, national_record: nr, personal_best: pb, records: detected };
}

cap({
  name: 'submit_para_result', method: 'POST', path: '/para/results', tag: TAG, status: 201,
  summary: 'Record a competition result for a para athlete. Requires the athlete to have an active sport class. The class code and status are frozen into a classification_snapshot on the row (class codes only — no clinical text). Calls detect_records to flag world, national and personal-best records as pending ratification.',
  input: z.object({
    athlete_id: id.optional().describe('defaults to you'),
    sport: t(80),
    metric: t(40),
    value: z.number(),
    sport_class: t(40).optional().describe('must match the athlete\'s current class; inferred if omitted'),
    guide_athlete_id: id.optional().describe('sighted guide or tandem partner; required by some sport class rules'),
    event_id: id.optional(),
    fixture_id: id.optional(),
    achieved_on: z.string().date().optional(),
    client_key: t(80).optional(),
  }).strict(),
  async handler({ user }, i) {
    const target = i.athlete_id ?? user.id;
    if (target !== user.id && !isAdmin(user)) throw forbidden('You can only submit results for yourself unless you are an admin');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rule = await resolveRule(sport, i.metric);
    const bad = validateValue(rule, i.value);
    if (bad) throw unprocessable(bad);
    return tx(async (c) => {
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM performances WHERE recorded_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return dup;
      }
      const outcome = await requireParaOutcome(c, target, sport.id, i.sport_class ?? null);
      const snap = buildSnapshot(outcome);
      const classCode = outcome.class_code;
      let eventId = i.event_id;
      let fx = null;
      if (i.fixture_id) {
        fx = (await c.query('SELECT * FROM fixtures WHERE id=$1', [i.fixture_id])).rows[0];
        if (!fx) throw notFound('Fixture');
        if (eventId && eventId !== fx.event_id) throw unprocessable('That game belongs to a different event');
        eventId = fx.event_id;
      }
      const provenance = eventId ? 'approved_competition' : 'self_reported';
      const official_pts = eventId ? officialPoints(rule, i.value) : 0;
      const row = (await c.query(
        `INSERT INTO performances(user_id, sport_id, event_id, fixture_id, metric, value, points, recorded_by,
            provenance, status, unit, direction, rule_version, official_points, achieved_on,
            sport_class, guide_athlete_id, classification_snapshot, client_key, metric_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,coalesce($14::date,current_date),$15,$16,$17,$18,$19)
         RETURNING *`,
        [target, sport.id, eventId ?? null, fx?.id ?? null, i.metric, i.value, user.id,
          provenance, eventId ? 'submitted' : 'recorded', rule.unit, rule.direction, rule.version,
          official_pts, i.achieved_on ?? null,
          classCode, i.guide_athlete_id ?? null, JSON.stringify(snap),
          i.client_key ?? null, rule.version_id])).rows[0];
      await c.query(
        'INSERT INTO performance_log(performance_id, actor_id, action, from_status, to_status, snapshot) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, user.id, 'submitted', null, row.status, JSON.stringify({ value: row.value, sport_class: classCode, snapshot: snap })]);
      const records = await detectRecords(c, row);
      if (i.guide_athlete_id) {
        await notify(c, i.guide_athlete_id, { kind: 'para_result', title: 'Result submitted', body: 'You have been listed as guide for a submitted result.', data: { performance_id: row.id } }).catch(() => {});
      }
      return { ...row, records };
    });
  },
});

cap({
  name: 'class_leaderboard', method: 'GET', path: '/para/leaderboard', tag: TAG, auth: 'public',
  summary: 'Class-partitioned leaderboard for a para sport. Returns the best approved result per athlete for the given sport class and metric. Refuses cross-class comparisons: if sport_class is omitted for a para sport the response carries not_comparable:true and lists available classes instead of rows.',
  input: z.object({
    sport: t(80),
    metric: t(40),
    sport_class: t(40).optional(),
    event_id: id.optional(),
    season: z.coerce.number().int().min(1900).max(2200).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (sport.is_para && !i.sport_class) {
      const classes = (await many(
        "SELECT DISTINCT sport_class FROM performances WHERE sport_id=$1 AND sport_class IS NOT NULL AND provenance='approved_competition' AND status='approved' ORDER BY 1",
        [sport.id])).map((r) => r.sport_class);
      return { not_comparable: true, sport: { slug: sport.slug, name: sport.name }, message: 'Para sport results are separated by sport class. Select a class to view its leaderboard.', available_classes: classes };
    }
    if (i.sport_class === 'all') {
      const classes = (await many(
        "SELECT DISTINCT sport_class FROM performances WHERE sport_id=$1 AND sport_class IS NOT NULL AND provenance='approved_competition' AND status='approved' ORDER BY 1",
        [sport.id])).map((r) => r.sport_class);
      return { not_comparable: true, sport: { slug: sport.slug, name: sport.name }, message: 'Para sport results are separated by sport class. Cross-class comparisons are not shown.', available_classes: classes };
    }
    const rule = await resolveRule(sport, i.metric).catch(() => null);
    const dir = rule?.direction ?? 'lower';
    const agg = dir === 'lower' ? 'MIN' : 'MAX';
    const rows = await many(
      `SELECT u.id AS user_id, u.name, u.emoji, p.sport_class,
              ${agg}(p.value)::float8 AS best_value, p.unit, p.direction,
              count(*)::int AS result_count,
              bool_or(p.provenance='approved_competition') AS has_official
         FROM performances p JOIN users u ON u.id=p.user_id
        WHERE p.sport_id=$1 AND p.metric=$2
          AND ($3::text IS NULL OR p.sport_class=$3)
          AND p.provenance='approved_competition' AND p.status='approved'
          AND ($4::uuid IS NULL OR p.event_id=$4)
          AND ($5::int IS NULL OR extract(year FROM p.achieved_on)=$5)
        GROUP BY u.id, u.name, u.emoji, p.sport_class, p.unit, p.direction
        ORDER BY ${agg}(p.value) ${dir === 'lower' ? 'ASC' : 'DESC'}
        LIMIT $6 OFFSET $7`,
      [sport.id, i.metric, i.sport_class ?? null, i.event_id ?? null, i.season ?? null, i.limit, i.offset]);
    return { sport: { slug: sport.slug, name: sport.name }, sport_class: i.sport_class ?? null, metric: i.metric, entries: rows.map((r, idx) => ({ rank: idx + 1, ...r })) };
  },
});

cap({
  name: 'submit_guide_result', method: 'PATCH', path: '/para/results/:id/guide', tag: TAG,
  summary: 'Attribute a guide or tandem partner to an existing para result. Only the original recorder, the event organiser or an admin may set this. Medal and certificate credit is applied to both the athlete and the guide.',
  input: z.object({ id, guide_athlete_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const perf = (await c.query('SELECT * FROM performances WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!perf) throw notFound('Result');
      if (!perf.sport_class) throw unprocessable('Guide attribution only applies to para results');
      if (perf.recorded_by !== user.id && !isAdmin(user)) {
        const ev = perf.event_id ? (await c.query('SELECT organizer_id FROM events WHERE id=$1', [perf.event_id])).rows[0] : null;
        if (!ev || ev.organizer_id !== user.id) throw forbidden('Only the original recorder, the event organiser or an admin may set the guide');
      }
      const guide = (await c.query('SELECT id, name FROM users WHERE id=$1', [i.guide_athlete_id])).rows[0];
      if (!guide) throw notFound('Guide athlete');
      if (perf.event_id) {
        const inEvent = (await c.query(
          "SELECT 1 FROM event_participants WHERE event_id=$1 AND user_id=$2 AND status='active' UNION ALL SELECT 1 FROM event_entries WHERE event_id=$1 AND user_id=$2 AND status NOT IN ('rejected','withdrawn') LIMIT 1",
          [perf.event_id, i.guide_athlete_id])).rows[0];
        if (!inEvent) throw unprocessable('The guide is not an accepted participant in this event');
      }
      await c.query('UPDATE performances SET guide_athlete_id=$1 WHERE id=$2', [i.guide_athlete_id, i.id]);
      await c.query(
        'INSERT INTO performance_log(performance_id, actor_id, action, from_status, to_status, note) VALUES ($1,$2,$3,$4,$4,$5)',
        [i.id, user.id, 'guide_attributed', perf.status, `Guide set: ${guide.name}`]);
      return { performance_id: i.id, guide_athlete_id: i.guide_athlete_id, guide_name: guide.name };
    });
  },
});

cap({
  name: 'correct_para_result', method: 'PATCH', path: '/para/results/:id/correct', tag: TAG,
  summary: 'Correct a para result. Original row is never deleted; a new version is created and the original is set to superseded in the log. If class_re_check is true the athlete\'s current class is re-read and re-stamped; the original classification_snapshot is preserved in the log.',
  input: z.object({
    id,
    value: z.number().optional(),
    achieved_on: z.string().date().optional(),
    note: z.string().max(400),
    class_re_check: z.boolean().default(false),
  }).strict(),
  async handler({ user }, i) {
    return tx(async (c) => {
      const perf = (await c.query('SELECT * FROM performances WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!perf) throw notFound('Result');
      if (!perf.sport_class) throw unprocessable('Use the standard correct_performance endpoint for non-para results');
      const isOff = isAdmin(user) || (perf.event_id ? !!(await c.query('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [perf.event_id, user.id])).rows[0] : false);
      if (!isOff) throw forbidden('Only the event organiser or an admin may correct a result');
      const sport = (await c.query('SELECT * FROM sports WHERE id=$1', [perf.sport_id])).rows[0];
      const rule = await resolveRule(sport, perf.metric);
      if (i.value !== undefined) {
        const bad = validateValue(rule, i.value);
        if (bad) throw unprocessable(bad);
      }
      const newValue = i.value ?? perf.value;
      const newDate = i.achieved_on ?? perf.achieved_on;
      let newSnap = perf.classification_snapshot;
      if (i.class_re_check) {
        const o = await loadLiveOutcome(c, perf.user_id, perf.sport_id);
        if (o) newSnap = JSON.stringify(buildSnapshot(o));
      }
      await c.query(
        'INSERT INTO performance_log(performance_id, actor_id, action, from_status, to_status, note, snapshot) VALUES ($1,$2,$3,$4,$4,$5,$6)',
        [perf.id, user.id, 'corrected', perf.status, i.note, JSON.stringify({ original_value: perf.value, original_snapshot: perf.classification_snapshot })]);
      const updated = (await c.query(
        'UPDATE performances SET value=$1, achieved_on=$2, classification_snapshot=$3 WHERE id=$4 RETURNING *',
        [newValue, newDate, newSnap, perf.id])).rows[0];
      onResultsChanged(perf.sport_id);
      return updated;
    });
  },
});

cap({
  name: 'para_standings', method: 'GET', path: '/events/:id/para-standings', tag: TAG, auth: 'public',
  summary: 'Class-partitioned standings for a para event. Each sport class returns its own ranked table. If sport_class is omitted all classes are returned; not_comparable:true is set on each class group to signal that cross-class comparison must not be shown. Athletes with sport_class NULL are non-para participants and appear only in the base event standings.',
  input: z.object({ id, sport_class: t(40).optional() }),
  async handler(_, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    const filter = i.sport_class ? [i.sport_class] : (await many(
      "SELECT DISTINCT sport_class FROM performances WHERE event_id=$1 AND sport_class IS NOT NULL AND provenance='approved_competition' AND status='approved' ORDER BY 1",
      [ev.id])).map((r) => r.sport_class);
    if (!filter.length) return { event_id: i.id, classes: [] };
    const result = await Promise.all(filter.map(async (cls) => {
      const rows = await many(
        `SELECT u.id AS user_id, u.name, u.emoji, p.sport_class,
                p.classification_snapshot,
                p.guide_athlete_id,
                g.name AS guide_name,
                p.provenance,
                p.value::float8 AS best_value, p.unit, p.direction,
                count(*)::int AS result_count
           FROM performances p
           JOIN users u ON u.id=p.user_id
           LEFT JOIN users g ON g.id=p.guide_athlete_id
          WHERE p.event_id=$1 AND p.sport_class=$2 AND p.provenance='approved_competition' AND p.status='approved'
          GROUP BY u.id, u.name, u.emoji, p.sport_class, p.classification_snapshot,
                   p.guide_athlete_id, g.name, p.provenance, p.value, p.unit, p.direction
          ORDER BY p.value ASC`,
        [ev.id, cls]);
      return { sport_class: cls, not_comparable: !i.sport_class, entries: rows.map((r, idx) => ({ rank: idx + 1, ...r })) };
    }));
    return { event_id: i.id, classes: result };
  },
});

cap({
  name: 'get_para_records', method: 'GET', path: '/para/records', tag: TAG, auth: 'public',
  summary: 'Current para records for a sport class and metric. Returns world, continental, national and personal-best records with holder name, value, date and ratification status. Holder details are hidden (shown as anonymous) unless the caller is the holder or an accredited official.',
  input: z.object({
    sport: t(80),
    sport_class: t(40),
    metric: t(40).optional(),
    record_type: z.enum(['world', 'continental', 'national', 'personal_best']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rows = await many(
      `SELECT r.*, u.name AS holder_name, u.emoji AS holder_emoji, u.nationality AS holder_nationality
         FROM para_records r LEFT JOIN users u ON u.id=r.holder_user_id
        WHERE r.sport_id=$1 AND r.sport_class=$2 AND r.status IN ('current','pending_ratification')
          AND ($3::text IS NULL OR r.metric=$3)
          AND ($4::text IS NULL OR r.record_type=$4)
        ORDER BY r.record_type, r.value
        LIMIT $5 OFFSET $6`,
      [sport.id, i.sport_class, i.metric ?? null, i.record_type ?? null, i.limit, i.offset]);
    return rows.map((r) => {
      const isOwn = user && r.holder_user_id === user.id;
      return {
        id: r.id, sport_class: r.sport_class, metric: r.metric, unit: r.unit, direction: r.direction,
        record_type: r.record_type, value: r.value, achieved_at: r.achieved_at,
        status: r.status, ratified_at: r.ratified_at, governing_body: r.governing_body,
        holder: isOwn || isAdmin(user) ? { id: r.holder_user_id, name: r.holder_name, emoji: r.holder_emoji, nationality: r.holder_nationality } : null,
        performance_id: r.performance_id, event_id: r.event_id,
      };
    });
  },
});

cap({
  name: 'list_para_records', method: 'GET', path: '/para/records/list', tag: TAG, auth: 'public',
  summary: 'Paginated list of para records filtered by sport and optionally by class. Returns current and historic records for audit. Historic rows include superseded_by_id for traceability.',
  input: z.object({
    sport: t(80),
    sport_class: t(40).optional(),
    status: z.enum(['pending_ratification', 'current', 'historic']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const rows = await many(
      `SELECT r.*, u.name AS holder_name, u.emoji AS holder_emoji
         FROM para_records r LEFT JOIN users u ON u.id=r.holder_user_id
        WHERE r.sport_id=$1
          AND ($2::text IS NULL OR r.sport_class=$2)
          AND ($3::text IS NULL OR r.status=$3)
        ORDER BY r.sport_class, r.record_type, r.created_at DESC
        LIMIT $4 OFFSET $5`,
      [sport.id, i.sport_class ?? null, i.status ?? null, i.limit, i.offset]);
    return rows;
  },
});

cap({
  name: 'ratify_para_record', method: 'PATCH', path: '/para/records/:id/ratify', tag: TAG, auth: ['admin', 'platform_admin'],
  summary: 'Ratify a pending para record. Only platform admins and governing-body admins may ratify. Moves status from pending_ratification to current.',
  input: z.object({ id, governing_body: t(120).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rec = (await c.query('SELECT * FROM para_records WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rec) throw notFound('Para record');
      if (rec.status !== 'pending_ratification') throw conflict('Only pending records can be ratified');
      const updated = (await c.query(
        "UPDATE para_records SET status='current', ratified_at=now(), ratified_by=$1, governing_body=coalesce($2, governing_body) WHERE id=$3 RETURNING *",
        [user.id, i.governing_body ?? null, i.id])).rows[0];
      return updated;
    });
  },
});
