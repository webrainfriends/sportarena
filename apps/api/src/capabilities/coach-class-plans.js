// Plan, share and track a coach class. A class gets one coaching session record (the coaching journal's own record, source `coach_class`), so the
// plan (versioned blocks), attendance, notes, scores, summaries and goals are the ones the coach already uses: nothing is copied. What is new here
// is the sharing of a plan with the people who hold a seat, the student's read of it, and the class roster with each person's progress.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notifySeat } from '../coach-classes.js';
import { CONSENT_OK } from '../coaching-shared.js';
import { hasConsent } from '../youth.js';
import { openSession, savePlan } from './coaching-journal.js';
import { requireRelationship } from '../coaching.js';

const TAG = 'Coach classes';
const COACH = ['coach'];

async function ownClass(c, user, classId) {
  const k = await c.query('SELECT * FROM coach_classes WHERE id=$1', [classId]).then((r) => r.rows[0]);
  if (!k || (k.coach_id !== user.id && !isAdmin(user))) throw notFound('Class');
  return k;
}

/** Coach's own record for the class (created on first use), as the user who runs it. */
const recordFor = (user, k) => openSession({ ...user, id: k.coach_id }, { source_type: 'coach_class', source_id: k.id });

async function roster(rec, k) {
  const rows = await many(
    `SELECT z.id AS seat_id, z.user_id, z.attendance AS class_attendance, u.display_name, u.avatar_emoji, u.avatar_color,
            (u.youth_until IS NOT NULL AND u.youth_until > current_date) AS is_youth,
            (SELECT count(*)::int FROM coach_class_seats y JOIN coach_classes c2 ON c2.id=y.class_id WHERE c2.coach_id=$2 AND y.user_id=z.user_id AND y.status='confirmed' AND y.attendance='attended') AS attended,
            (SELECT count(*)::int FROM coach_class_seats y JOIN coach_classes c2 ON c2.id=y.class_id WHERE c2.coach_id=$2 AND y.user_id=z.user_id AND y.status='confirmed' AND y.attendance IS NOT NULL) AS recorded,
            (SELECT count(*)::int FROM coaching_observations o WHERE o.session_record_id=$1 AND o.athlete_id=z.user_id) AS notes,
            (SELECT o.score FROM coaching_observations o WHERE o.session_record_id=$1 AND o.athlete_id=z.user_id AND o.score IS NOT NULL ORDER BY o.observed_at DESC LIMIT 1) AS last_score,
            s.summary, coalesce(s.shared, false) AS summary_shared,
            (SELECT count(*)::int FROM coaching_goals g WHERE g.coach_id=$2 AND g.athlete_id=z.user_id AND g.status IN ('planned','active')) AS open_goals
       FROM coach_class_seats z JOIN users u ON u.id=z.user_id LEFT JOIN coaching_player_summaries s ON s.session_record_id=$1 AND s.athlete_id=z.user_id
      WHERE z.class_id=$3 AND z.status='confirmed' ORDER BY u.display_name, z.id`, [rec.id, k.coach_id, k.id]);
  return Promise.all(rows.map(async ({ attended, recorded, is_youth, ...r }) => ({
    ...r, is_youth, attended, recorded, attendance_rate: recorded ? Math.round((attended / recorded) * 100) : null,
    can_share: is_youth ? await hasConsent(r.user_id, 'coaching') : true,   // a young person's notes and summaries are shared only with a guardian's current coaching consent
  })));
}

cap({
  name: 'open_coach_class_workspace', method: 'POST', path: '/coach/classes/:id/workspace', tag: TAG, auth: COACH,
  summary: 'Coach: open the planning and tracking workspace of one of your classes. Creates the class\'s coaching record on first use (repeating returns the same one) and returns it with the current plan, whether and which version is shared with the seat holders, and the roster: each confirmed person with attendance here, attendance across your classes, notes, last score, summary state and open goals. Edit the plan with save_coaching_session_plan using the returned record id; note, score and summarise with the coaching journal capabilities.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const k = await tx((c) => ownClass(c, user, i.id));
    const rec = await recordFor(user, k);
    const plan = await one('SELECT version, blocks, created_at FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
    const previous = await many(
      `SELECT k2.id AS class_id, k2.title, k2.starts_at, r.plan_version FROM coach_classes k2 JOIN coaching_session_records r ON r.coach_id=k2.coach_id AND r.source_type='coach_class' AND r.source_id=k2.id::text
        WHERE k2.coach_id=$1 AND k2.id <> $2 AND r.plan_version > 0 ORDER BY k2.starts_at DESC LIMIT 20`, [k.coach_id, k.id]);
    return {
      class_id: k.id, record_id: rec.id, status: k.status, starts_at: k.starts_at, duration_min: k.duration_min, sport_id: k.sport_id, title: k.title, objective: rec.objective, plan: plan ?? { version: 0, blocks: [] },
      shared: rec.plan_shared_version != null, shared_version: rec.plan_shared_version, shared_at: rec.plan_shared_at, plan_changed_since_share: rec.plan_shared_version != null && rec.plan_shared_version !== rec.plan_version,
      roster: await roster(rec, k), copy_from: previous,
    };
  },
});

cap({
  name: 'share_coach_class_plan', method: 'POST', path: '/coach/classes/:id/plan/share', tag: TAG, auth: COACH,
  summary: 'Coach: share the current plan of a class with everyone who holds a confirmed seat (and a young person\'s guardian), or stop sharing. Only the objective and the blocks are shared, never your private coach notes. Sharing again after you edit the plan publishes the new version; people are told once per version.',
  input: z.object({ id, share: z.boolean() }),
  async handler({ user }, i) {
    const k = await tx((c) => ownClass(c, user, i.id));
    if (k.status === 'cancelled') throw conflict('This class was cancelled');
    const rec = await recordFor(user, k);
    if (i.share && !rec.plan_version) throw badRequest('Save a plan first', { code: 'no_plan' });
    return tx(async (c) => {
      const row = (await c.query(
        i.share
          ? 'UPDATE coaching_session_records SET plan_shared_version=plan_version, plan_shared_at=now(), plan_shared_by=$2, updated_at=now() WHERE id=$1 RETURNING plan_shared_version, plan_shared_at'
          : 'UPDATE coaching_session_records SET plan_shared_version=NULL, plan_shared_at=NULL, plan_shared_by=NULL, updated_at=now() WHERE id=$1 AND $2::uuid IS NOT NULL RETURNING plan_shared_version, plan_shared_at',
        [rec.id, user.id])).rows[0];
      let told = 0;
      if (i.share) {
        for (const seat of (await c.query("SELECT * FROM coach_class_seats WHERE class_id=$1 AND status='confirmed' ORDER BY created_at, id", [k.id])).rows) {
          await notifySeat(c, seat, { kind: 'coach_class_plan', title: 'Class plan shared', body: `Your coach shared the plan for "${k.title}".`, key: `cc_plan:${seat.id}:${row.plan_shared_version}` }, k);
          told++;
        }
      }
      return { class_id: k.id, shared: row.plan_shared_version != null, shared_version: row.plan_shared_version, shared_at: row.plan_shared_at, told };
    });
  },
});

cap({
  name: 'copy_coach_class_plan', method: 'POST', path: '/coach/classes/:id/plan/copy', tag: TAG, auth: COACH,
  summary: 'Coach: start this class\'s plan from the plan of another of your classes (its current version). The blocks become a new version here; the other class is untouched. Nothing is shared until you share it.',
  input: z.object({ id, from_class_id: id }),
  async handler({ user }, i) {
    const k = await tx((c) => ownClass(c, user, i.id));
    if (i.from_class_id === k.id) throw badRequest('Choose a different class');
    const from = await tx((c) => ownClass(c, user, i.from_class_id));
    const src = await one("SELECT r.objective, v.blocks FROM coaching_session_records r JOIN coaching_session_plan_versions v ON v.session_record_id=r.id AND v.version=r.plan_version WHERE r.coach_id=$1 AND r.source_type='coach_class' AND r.source_id=$2 AND r.plan_version > 0", [from.coach_id, from.id]);
    if (!src) throw notFound('Plan');
    const rec = await recordFor(user, k);
    const blocks = src.blocks.map(({ id: _drop, ...b }) => b);
    return savePlan({ ...user, id: k.coach_id }, rec.id, blocks, { objective: src.objective ?? undefined });
  },
});

cap({
  name: 'get_coach_class_plan', method: 'GET', path: '/coach/classes/:id/plan', tag: TAG, auth: 'user',
  summary: 'For someone who holds a confirmed seat in the class (or a guardian of a young person who does): the plan the coach shared (objective and blocks, never private coach notes) and what the coach chose to share about how you got on: your attendance and a summary written for you. Returns shared=false until the coach shares. Anyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const k = await one('SELECT id, coach_id, title, starts_at, status FROM coach_classes WHERE id=$1', [i.id]);
    if (!k) throw notFound('Class');
    const mine = await many(
      `SELECT z.user_id, z.attendance, u.display_name FROM coach_class_seats z JOIN users u ON u.id=z.user_id
        WHERE z.class_id=$1 AND z.status='confirmed' AND (z.user_id=$2 OR z.user_id IN (SELECT child_id FROM guardian_links WHERE guardian_id=$2 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())))
        ORDER BY (z.user_id=$2) DESC, u.display_name`, [k.id, user.id]);
    if (!mine.length) throw notFound('Class');
    const rec = await one("SELECT id, objective, plan_shared_version, plan_shared_at FROM coaching_session_records WHERE coach_id=$1 AND source_type='coach_class' AND source_id=$2", [k.coach_id, k.id.toString()]);
    const people = [];
    for (const m of mine) {
      const sum = rec ? await one(`SELECT s.summary FROM coaching_player_summaries s WHERE s.session_record_id=$1 AND s.athlete_id=$2 AND s.shared AND ${CONSENT_OK('$2::uuid')}`, [rec.id, m.user_id]) : null;
      people.push({ user_id: m.user_id, name: m.user_id === user.id ? null : m.display_name, attendance: m.attendance, summary: sum?.summary ?? null });
    }
    const base = { class_id: k.id, title: k.title, starts_at: k.starts_at, people };
    if (!rec || rec.plan_shared_version == null) return { ...base, shared: false };
    const v = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_shared_version]);
    const blocks = (v?.blocks ?? []).map(({ coach_notes, scope, unit, id: bid, ...b }) => ({ id: bid, ...b }));
    return { ...base, shared: true, version: rec.plan_shared_version, shared_at: rec.plan_shared_at, objective: rec.objective, blocks };
  },
});

// ---------------------------------------------------------------- scoring: the coach's own rubric, per person, per skill, with history

async function rubricOf(coachId, rubricId) {
  const r = await one('SELECT r.id, r.name, v.version, v.dimensions FROM coaching_rubrics r JOIN LATERAL (SELECT * FROM coaching_rubric_versions x WHERE x.rubric_id=r.id ORDER BY version DESC LIMIT 1) v ON true WHERE r.id=$1 AND r.coach_id=$2 AND r.archived_at IS NULL', [rubricId, coachId]);
  if (!r) throw notFound('Rubric');
  return r;
}

cap({
  name: 'get_coach_class_scores', method: 'GET', path: '/coach/classes/:id/scores', tag: TAG, auth: COACH,
  summary: 'Coach: the scoring grid of a class for one of your rubrics. For each confirmed person: the score given in this class for every skill (dimension) of the rubric, the previous scores for the same skill across your classes (oldest to newest, up to six) and the change since the last time. Scores are the coach\'s own judgement, labelled as such; nothing is computed or ranked.',
  input: z.object({ id, rubric_id: id }),
  async handler({ user }, i) {
    const k = await tx((c) => ownClass(c, user, i.id));
    const rubric = await rubricOf(k.coach_id, i.rubric_id);
    const rec = await recordFor(user, k);
    const people = await many("SELECT z.user_id, u.display_name FROM coach_class_seats z JOIN users u ON u.id=z.user_id WHERE z.class_id=$1 AND z.status='confirmed' ORDER BY u.display_name, z.id", [k.id]);
    const obs = people.length ? await many(
      `SELECT o.athlete_id, o.dimension_key, o.score::float AS score, o.observed_at, (o.session_record_id=$3) AS here
         FROM coaching_observations o WHERE o.coach_id=$1 AND o.rubric_id=$2 AND o.athlete_id = ANY($4::uuid[]) AND o.score IS NOT NULL ORDER BY o.observed_at, o.id`, [k.coach_id, rubric.id, rec.id, people.map((p) => p.user_id)]) : [];
    const rows = people.map((p) => {
      const mine = obs.filter((o) => o.athlete_id === p.user_id);
      const dims = {};
      for (const d of rubric.dimensions) {
        const series = mine.filter((o) => o.dimension_key === d.key);
        const here = series.filter((o) => o.here).at(-1) ?? null;
        const before = series.filter((o) => !o.here).map((o) => o.score);
        dims[d.key] = { score: here?.score ?? null, history: before.slice(-6), change: here && before.length ? Math.round((here.score - before.at(-1)) * 100) / 100 : null };
      }
      return { athlete_id: p.user_id, display_name: p.display_name, dimensions: dims };
    });
    return { class_id: k.id, record_id: rec.id, rubric: { id: rubric.id, name: rubric.name, version: rubric.version, dimensions: rubric.dimensions }, rows };
  },
});

cap({
  name: 'score_coach_class', method: 'POST', path: '/coach/classes/:id/scores', tag: TAG, auth: COACH,
  summary: 'Coach: save scores for the people in a class on the skills of one of your rubrics (a score within the dimension\'s own scale). Each score becomes a private coaching observation tied to this class and to the rubric version it was given under; re-scoring adds a newer score and keeps the old one. Only people with a confirmed seat can be scored, and a young person only while a guardian\'s participation consent is in force. Nothing is shared with the person by scoring.',
  input: z.object({ id, rubric_id: id, scores: z.array(z.object({ athlete_id: id, dimension_key: z.string().max(40), score: z.number() })).min(1).max(500) }),
  async handler({ user }, i) {
    const k = await tx((c) => ownClass(c, user, i.id));
    if (k.status === 'cancelled') throw conflict('This class was cancelled');
    const rubric = await rubricOf(k.coach_id, i.rubric_id);
    const rec = await recordFor(user, k);
    const seated = new Set((await many("SELECT user_id FROM coach_class_seats WHERE class_id=$1 AND status='confirmed'", [k.id])).map((r) => r.user_id));
    const dims = new Map(rubric.dimensions.map((d) => [d.key, d]));
    for (const s of i.scores) {
      const d = dims.get(s.dimension_key);
      if (!d) throw badRequest(`Unknown skill ${s.dimension_key}`);
      if (!seated.has(s.athlete_id)) throw badRequest('Someone you scored does not have a confirmed seat in this class');
      if (s.score < d.scale_min || s.score > d.scale_max) throw badRequest(`${d.name}: score must be between ${d.scale_min} and ${d.scale_max}`);
    }
    for (const a of new Set(i.scores.map((s) => s.athlete_id))) await requireRelationship({ ...user, id: k.coach_id }, a, ['coach_class']);
    return tx(async (c) => {
      let saved = 0;
      for (const s of i.scores) {
        const d = dims.get(s.dimension_key);
        // the same score again is not a new fact: skip it so a re-save never piles up identical rows
        const last = (await c.query('SELECT score::float AS score FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 AND session_record_id=$3 AND rubric_id=$4 AND dimension_key=$5 AND score IS NOT NULL ORDER BY observed_at DESC, id DESC LIMIT 1', [k.coach_id, s.athlete_id, rec.id, rubric.id, d.key])).rows[0];
        if (last && last.score === s.score) continue;
        await c.query(
          `INSERT INTO coaching_observations(coach_id, athlete_id, sport_id, session_record_id, obs_type, skill_tag, note, visibility, rubric_id, rubric_version, dimension_key, score)
           VALUES ($1,$2,$3,$4,'technical',$5,$6,'coach_private',$7,$8,$9,$10)`, [k.coach_id, s.athlete_id, k.sport_id, rec.id, d.name.slice(0, 60), `${d.name}: ${s.score}`, rubric.id, rubric.version, d.key, s.score]);
        saved++;
      }
      return { saved, record_id: rec.id };
    });
  },
});
