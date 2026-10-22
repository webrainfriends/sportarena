import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireRelationship } from '../coaching.js';
import { guardiansOf, guardianLink, isYouth } from '../youth.js';
import { requireTeam } from './coaching-journal.js';
import { series, PROVENANCE } from './coaching-goals.js';
import { canReadReportVersion, reportVersionFor } from '../coaching-report-access.js';
import { notifyReportPublished } from '../coaching-notify.js';

// Coaching reports (issue #269, slice 4). The server builds every section from the coach's own records, filtered for the audience, so
// the client can never smuggle a private note into a shared report. Publishing freezes an immutable numbered snapshot.
const TAG = 'Coaching reports';
const COACH = ['coach'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (n) => z.string().trim().max(n);
const KINDS = ['session', 'athlete_progress', 'goal_review', 'team_training', 'match_debrief', 'period_review', 'action_summary'];
const AUDIENCES = ['coach_private', 'athlete', 'guardian', 'team_staff'];
const selection = z.object({
  goals: z.boolean().default(true), metrics: z.boolean().default(true), actions: z.boolean().default(true),
  observation_ids: z.array(id).max(60).default([]), session_record_ids: z.array(id).max(40).default([]),
});
const fields = {
  kind: z.enum(KINDS), title: text(160).min(2), audience: z.enum(AUDIENCES), from: day, to: day, selection: selection.default({}), narrative: text(6000).optional(),
};

/** What each audience may be shown. A private note can never be selected for anyone but the coach. */
const NOTE_VISIBILITY = { coach_private: ['coach_private', 'staff', 'player', 'team'], team_staff: ['staff', 'player', 'team'], athlete: ['player'], guardian: ['player'] };

async function authorise(user, r) {
  if (r.athlete_id) await requireRelationship(user, r.athlete_id);
  if (r.team_id) await requireTeam(user, r.team_id);
  if (r.athlete_id && r.team_id && !(await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [r.team_id, r.athlete_id]))) throw badRequest('That athlete is not on this team');
  if (r.audience === 'guardian') {
    if (!(await isYouth(r.athlete_id)) || !(await guardiansOf(r.athlete_id)).length) throw badRequest('A guardian report needs a young person with a verified guardian');
  }
}

/** Reject a selection the audience may not see (and say which notes), before anything is stored. */
async function checkSelection(user, r) {
  const sel = r.selection;
  if (sel.observation_ids.length) {
    const rows = await many('SELECT id, visibility, athlete_id, team_id FROM coaching_observations WHERE id = ANY($1::uuid[]) AND coach_id=$2', [sel.observation_ids, user.id]);
    if (rows.length !== new Set(sel.observation_ids).size) throw badRequest('Some selected notes are not yours');
    const wrongSubject = rows.filter((o) => !((r.athlete_id && o.athlete_id === r.athlete_id) || (r.team_id && o.team_id === r.team_id && (!o.athlete_id || !r.athlete_id || o.athlete_id === r.athlete_id))));
    if (wrongSubject.length) throw badRequest('Some selected notes are about someone else');
    const hidden = rows.filter((o) => !NOTE_VISIBILITY[r.audience].includes(o.visibility));
    if (hidden.length) throw badRequest(`${hidden.length} selected note${hidden.length === 1 ? ' is' : 's are'} not shared with this audience (${hidden.map((o) => o.visibility.replace('_', ' ')).join(', ')}). Change the note's visibility first, or leave it out.`);
  }
  if (sel.session_record_ids.length) {
    const n = (await one('SELECT count(*)::int AS n FROM coaching_session_records WHERE id = ANY($1::uuid[]) AND coach_id=$2', [sel.session_record_ids, user.id])).n;
    if (n !== new Set(sel.session_record_ids).size) throw badRequest('Some selected sessions are not yours');
  }
}

const shortDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Build the audience-safe sections from live records. Used for the preview and, at publish time, for the frozen snapshot. */
async function build(user, r) {
  const priv = r.audience === 'coach_private';
  const to = `${shortDate(r.period_to)}T23:59:59Z`, from = shortDate(r.period_from);
  const sel = r.selection;
  const subject = r.athlete_id ? (await one('SELECT display_name FROM users WHERE id=$1', [r.athlete_id])).display_name : (await one('SELECT name FROM teams WHERE id=$1', [r.team_id])).name;
  const sections = [];
  if (r.narrative) sections.push({ key: 'summary', title: 'Summary', kind: 'text', body: r.narrative });
  if (sel.goals) {
    const goals = await many(
      `SELECT g.title, g.status, g.category, g.review_on, g.athlete_text, g.criterion, (SELECT count(*)::int FROM coaching_goal_evidence e WHERE e.goal_id=g.id) AS evidence FROM coaching_goals g
        WHERE g.coach_id=$1 AND (($2::uuid IS NOT NULL AND g.athlete_id=$2) OR ($3::uuid IS NOT NULL AND g.team_id=$3 AND $2::uuid IS NULL)) AND g.status IN ('planned','active','achieved','paused') AND ($4::boolean OR g.athlete_text IS NOT NULL)
        ORDER BY g.review_on NULLS LAST, g.id`, [user.id, r.athlete_id, r.team_id, priv || r.audience === 'team_staff']);
    if (goals.length) sections.push({ key: 'goals', title: 'Goals', kind: 'items', items: goals.map((g) => ({ title: g.title, meta: `${g.status}${g.review_on ? ` · review ${shortDate(g.review_on)}` : ''}${priv || r.audience === 'team_staff' ? ` · ${g.evidence} evidence` : ''}`, body: priv || r.audience === 'team_staff' ? (g.criterion ?? g.athlete_text) : g.athlete_text })) });
  }
  if (sel.metrics && r.athlete_id) {
    const keys = ['attendance_rate', 'plan_completion', 'action_completion'];
    const extra = await many(`SELECT DISTINCT 'measurement:' || metric AS k FROM coaching_measurements WHERE coach_id=$1 AND athlete_id=$2 AND measured_on BETWEEN $3::date AND $4::date ORDER BY 1`, [user.id, r.athlete_id, from, shortDate(r.period_to)]);
    const metrics = [];
    // rubric scores come from the coach's (possibly private) observations, so they appear only in the coach's own copy
    if (priv) for (const x of await many(`SELECT DISTINCT 'rubric:' || rubric_id || ':' || dimension_key AS k FROM coaching_observations WHERE coach_id=$1 AND athlete_id=$2 AND rubric_id IS NOT NULL AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz ORDER BY 1`, [user.id, r.athlete_id, from, to])) extra.push(x);
    for (const k of [...keys, ...extra.map((x) => x.k)]) {
      const m = await series(user, r.athlete_id, k, from, shortDate(r.period_to));
      metrics.push({ title: m.label, value: m.value == null ? null : `${m.value}${m.unit === '%' ? '%' : ` ${m.unit ?? ''}`}`.trim(), meta: `${PROVENANCE[m.provenance]} · ${m.sample} record${m.sample === 1 ? '' : 's'}${m.excluded?.not_recorded ? ` · ${m.excluded.not_recorded} not recorded` : ''}`, body: m.definition });
    }
    sections.push({ key: 'metrics', title: 'Numbers', kind: 'items', items: metrics.map((m) => ({ ...m, value: m.value ?? 'No data' })) });
  }
  if (sel.observation_ids.length) {
    const obs = await many(`SELECT obs_type, skill_tag, note, observed_at FROM coaching_observations WHERE id = ANY($1::uuid[]) AND coach_id=$2 AND visibility = ANY($3::text[]) ORDER BY observed_at, id`, [sel.observation_ids, user.id, NOTE_VISIBILITY[r.audience]]);
    sections.push({ key: 'notes', title: 'Coach notes', kind: 'items', items: obs.map((o) => ({ title: o.skill_tag ?? o.obs_type.replace(/_/g, ' '), meta: shortDate(o.observed_at), body: o.note })) });
  }
  if (sel.session_record_ids.length) {
    const recs = await many(
      `SELECT r.title, coalesce(r.started_at, r.scheduled_at, r.created_at) AS at, r.team_summary, r.private_summary, p.attendance FROM coaching_session_records r
         LEFT JOIN coaching_session_participants p ON p.session_record_id=r.id AND p.athlete_id=$3 WHERE r.id = ANY($1::uuid[]) AND r.coach_id=$2 ORDER BY at, r.id`, [sel.session_record_ids, user.id, r.athlete_id]);
    sections.push({ key: 'sessions', title: 'Sessions', kind: 'items', items: recs.map((x) => ({ title: x.title, meta: `${shortDate(x.at)}${r.athlete_id && x.attendance ? ` · ${x.attendance === 'expected' ? 'attendance not recorded' : x.attendance.replace('_', ' ')}` : ''}`, body: [x.team_summary, priv ? x.private_summary : null].filter(Boolean).join('\n') || undefined })) });
  }
  if (sel.actions) {
    const acts = await many(
      `SELECT a.title, a.status, a.due_at, a.completion_note FROM coaching_actions a WHERE a.coach_id=$1 AND a.status IN ('open','in_progress','done') AND (a.shared OR $4::boolean)
          AND (($2::uuid IS NOT NULL AND a.athlete_id=$2) OR ($3::uuid IS NOT NULL AND a.team_id=$3 AND $2::uuid IS NULL)) ORDER BY a.due_at NULLS LAST, a.id LIMIT 40`, [user.id, r.athlete_id, r.team_id, priv || r.audience === 'team_staff']);
    if (acts.length) sections.push({ key: 'actions', title: 'Next steps', kind: 'items', items: acts.map((a) => ({ title: a.title, meta: `${a.status.replace('_', ' ')}${a.due_at ? ` · due ${shortDate(a.due_at)}` : ''}`, body: a.completion_note ?? undefined })) });
  }
  const coach = await one('SELECT display_name FROM users WHERE id=$1', [user.id]);
  return {
    title: r.title, kind: r.kind, audience: r.audience, subject, period: { from, to: shortDate(r.period_to) }, coach_name: coach.display_name, sections,
    disclosure: priv ? 'Private copy: not shared with anyone.' : `Prepared for ${r.audience.replace('_', ' ')}. Coach-private notes are never included in shared reports.`,
  };
}

const load = async (user, rid) => {
  const r = await one('SELECT * FROM coaching_reports WHERE id=$1 AND coach_id=$2', [rid, user.id]);
  if (!r) throw notFound('Report');
  return r;
};
const asSubject = (r) => ({ ...r, selection: r.selection });

async function narrativeFromDraft(user, r, draftId) {
  const d = await one('SELECT * FROM coaching_ai_drafts WHERE id=$1 AND coach_id=$2', [draftId, user.id]);
  if (!d) throw notFound('Draft');
  if (d.status === 'discarded') throw badRequest('That draft was discarded');
  if (r.audience !== 'coach_private' && (d.options?.audience ?? 'coach_private') !== r.audience) throw badRequest(`That draft was written for ${(d.options?.audience ?? 'coach_private').replace('_', ' ')} evidence. Ask the copilot again with audience "${r.audience}" so private notes are left out.`);
  if ((d.athlete_id && d.athlete_id !== r.athlete_id) || (!d.athlete_id && d.team_id && d.team_id !== r.team_id)) throw badRequest('That draft is about someone else');
  const items = (d.output.items ?? []).filter((x) => x.basis === 'observed');
  return [d.output.headline, ...items.map((x) => `• ${x.title}${x.detail ? `: ${x.detail}` : ''}`)].join('\n');
}

cap({
  name: 'create_coaching_report', method: 'POST', path: '/coaching/reports', tag: TAG, auth: COACH, status: 201,
  summary: 'Start a report for an athlete or team you coach: choose the audience (just you, the athlete, a verified guardian, or the team\'s coaching staff), the period and what goes in. Only notes already visible to that audience can be selected. Optionally start the summary from an AI draft written for the same audience; you must confirm you reviewed it before publishing.',
  input: z.object({ athlete_id: id.optional(), team_id: id.optional(), ...fields, ai_draft_id: id.optional() }),
  async handler({ user }, i) {
    if (!i.athlete_id && !i.team_id) throw badRequest('Name an athlete or a team');
    if (i.to < i.from) throw badRequest('to is before from');
    const r = { athlete_id: i.athlete_id ?? null, team_id: i.team_id ?? null, kind: i.kind, title: i.title, audience: i.audience, period_from: i.from, period_to: i.to, selection: selection.parse(i.selection ?? {}), narrative: i.narrative ?? null };
    if (i.audience === 'athlete' && !i.athlete_id) throw badRequest('An athlete report needs an athlete');
    if (i.audience === 'guardian' && !i.athlete_id) throw badRequest('A guardian report needs an athlete');
    if (i.audience === 'team_staff' && !i.team_id) throw badRequest('A staff report needs the team');
    await authorise(user, r); await checkSelection(user, r);
    let fromAi = false;
    if (i.ai_draft_id) { r.narrative = await narrativeFromDraft(user, r, i.ai_draft_id); fromAi = true; }
    return one(
      `INSERT INTO coaching_reports(coach_id, athlete_id, team_id, kind, title, audience, period_from, period_to, selection, narrative, narrative_from_ai, ai_draft_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [user.id, r.athlete_id, r.team_id, r.kind, r.title, r.audience, r.period_from, r.period_to, JSON.stringify(r.selection), r.narrative, fromAi, i.ai_draft_id ?? null]);
  },
});

cap({
  name: 'update_coaching_report', method: 'PATCH', path: '/coaching/reports/:id', tag: TAG, auth: COACH,
  summary: 'Change a report\'s definition (title, audience, period, what is included, your summary). Needs the row_version you loaded. Versions already published are never changed; the next publish makes a new one.',
  input: z.object({ id, row_version: z.number().int().min(1), title: fields.title.optional(), kind: fields.kind.optional(), audience: fields.audience.optional(), from: day.optional(), to: day.optional(), selection: selection.optional(), narrative: text(6000).optional(), ai_draft_id: id.optional() }),
  async handler({ user }, i) {
    const cur = await load(user, i.id);
    const n = { ...cur, title: i.title ?? cur.title, kind: i.kind ?? cur.kind, audience: i.audience ?? cur.audience, period_from: i.from ?? shortDate(cur.period_from), period_to: i.to ?? shortDate(cur.period_to), selection: i.selection ?? cur.selection, narrative: i.narrative ?? cur.narrative };
    if (shortDate(n.period_to) < shortDate(n.period_from)) throw badRequest('to is before from');
    if (n.audience === 'athlete' && !n.athlete_id) throw badRequest('An athlete report needs an athlete');
    if (n.audience === 'guardian' && !n.athlete_id) throw badRequest('A guardian report needs an athlete');
    if (n.audience === 'team_staff' && !n.team_id) throw badRequest('A staff report needs the team');
    await authorise(user, n); await checkSelection(user, n);
    let fromAi = cur.narrative_from_ai;
    if (i.ai_draft_id) { n.narrative = await narrativeFromDraft(user, n, i.ai_draft_id); fromAi = true; }
    else if (n.audience !== cur.audience && cur.narrative_from_ai && cur.ai_draft_id) throw badRequest('The summary came from an AI draft for another audience. Rewrite it or import a draft for this audience.');
    const row = await one(
      `UPDATE coaching_reports SET title=$3, kind=$4, audience=$5, period_from=$6, period_to=$7, selection=$8, narrative=$9, narrative_from_ai=$10, ai_draft_id=coalesce($11, ai_draft_id), row_version=row_version+1, updated_at=now()
        WHERE id=$1 AND row_version=$2 RETURNING *`, [cur.id, i.row_version, n.title, n.kind, n.audience, n.period_from, n.period_to, JSON.stringify(n.selection), n.narrative, fromAi, i.ai_draft_id ?? null]);
    if (!row) throw conflict('This report was changed elsewhere - reload it first');
    return row;
  },
});

cap({
  name: 'preview_coaching_report', method: 'GET', path: '/coaching/reports/:id/preview', tag: TAG, auth: COACH,
  summary: 'Exactly what would be published now for the chosen audience, built from live records. Nothing is stored or shared.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await load(user, i.id);
    await authorise(user, r); await checkSelection(user, r);
    return { report_id: r.id, next_version: r.latest_version + 1, needs_ai_review: r.narrative_from_ai, snapshot: await build(user, asSubject(r)) };
  },
});

cap({
  name: 'publish_coaching_report', method: 'POST', path: '/coaching/reports/:id/publish', tag: TAG, auth: COACH, status: 201,
  summary: 'Freeze the report as the next numbered version for its audience. The content is rebuilt on the server at this moment, the version can never be edited, and a summary that started as an AI draft needs confirm_reviewed=true. Needs a current coaching relationship. Publishing the same content again returns the existing latest version instead of a duplicate.',
  input: z.object({ id, row_version: z.number().int().min(1), confirm_reviewed: z.boolean().default(false) }),
  async handler({ user }, i) {
    const r0 = await load(user, i.id);
    if (r0.row_version !== i.row_version) throw conflict('This report was changed since you looked at it - preview it again');
    if (r0.narrative_from_ai && !i.confirm_reviewed) throw badRequest('Your summary started as an AI draft. Read it, then publish with confirm_reviewed = true.');
    await authorise(user, r0); await checkSelection(user, r0);
    const snapshot = { ...(await build(user, asSubject(r0))), published_at: new Date().toISOString() };
    const body = { ...snapshot }; delete body.published_at;
    const sha = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM coaching_reports WHERE id=$1 FOR UPDATE', [r0.id])).rows[0];
      if (r.row_version !== i.row_version) throw conflict('This report was changed since you looked at it - preview it again');
      const prev = r.latest_version ? (await c.query('SELECT version, audience, snapshot_sha256, published_at FROM coaching_report_versions WHERE report_id=$1 AND version=$2', [r.id, r.latest_version])).rows[0] : null;
      if (prev && prev.snapshot_sha256 === sha && prev.audience === r.audience) return { report_id: r.id, version: prev.version, audience: prev.audience, published_at: prev.published_at, unchanged: true };
      const version = r.latest_version + 1;
      const v = (await c.query('INSERT INTO coaching_report_versions(report_id, version, audience, snapshot, snapshot_sha256, published_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING report_id, version, audience, published_at', [r.id, version, r.audience, JSON.stringify(snapshot), sha, user.id])).rows[0];
      await c.query('UPDATE coaching_reports SET latest_version=$2, updated_at=now() WHERE id=$1', [r.id, version]);
      await audit(c, user.id, 'publish_coaching_report', 'coaching_reports', r.id);
      const recipients = r.audience === 'athlete' ? [r.athlete_id] : r.audience === 'guardian' ? await guardiansOf(r.athlete_id) : r.audience === 'team_staff' ? (await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role='coach'", [r.team_id])).rows.map((x) => x.user_id) : [];
      await notifyReportPublished(c, { report: r, version, recipients });
      return { ...v, unchanged: false };
    });
  },
});

cap({
  name: 'list_coaching_reports', method: 'GET', path: '/coaching/reports', tag: TAG, auth: COACH,
  summary: 'Your reports, most recently changed first.', input: z.object({ athlete_id: id.optional(), team_id: id.optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT id, kind, title, audience, athlete_id, team_id, period_from, period_to, latest_version, row_version, updated_at FROM coaching_reports WHERE coach_id=$1 AND ($2::uuid IS NULL OR athlete_id=$2) AND ($3::uuid IS NULL OR team_id=$3) ORDER BY updated_at DESC, id LIMIT $4 OFFSET $5`, [user.id, i.athlete_id ?? null, i.team_id ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_coaching_report', method: 'GET', path: '/coaching/reports/:id', tag: TAG, auth: COACH,
  summary: 'A report definition with the list of its published versions.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await load(user, i.id);
    const versions = await many('SELECT version, audience, published_at FROM coaching_report_versions WHERE report_id=$1 ORDER BY version DESC', [r.id]);
    return { ...r, versions };
  },
});

cap({
  name: 'get_coaching_report_version', method: 'GET', path: '/coaching/reports/:id/versions/:version', tag: TAG, auth: 'user',
  summary: 'One published, frozen version. Readable by its author and, live-checked, by the audience it was published for (the athlete, a verified guardian, or the team\'s coaches). Nobody else gets it, not even to learn that it exists.',
  input: z.object({ id, version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    const v = await reportVersionFor(i.id, i.version);
    if (!v || !(await canReadReportVersion(user, v))) throw notFound('Report');
    if (v.coach_id !== user.id) await audit(null, user.id, 'read_coaching_report', 'coaching_reports', v.report_id);
    return { report_id: v.report_id, version: v.version, audience: v.audience, snapshot: v.snapshot };
  },
});

cap({
  name: 'my_coaching_reports', method: 'GET', path: '/me/coaching-reports', tag: TAG, auth: 'user',
  summary: 'Reports published to you (as the athlete), or with child_id to those published for the guardians of a young person you are a verified guardian of. Latest version of each.',
  input: z.object({ child_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.child_id && !(await guardianLink(user.id, i.child_id))) throw forbidden('You are not a verified guardian of this young person');
    const audience = i.child_id ? 'guardian' : 'athlete', athlete = i.child_id ?? user.id;
    // newest version published to this audience, even if a later version went elsewhere: what was shared stays shared
    return many(
      `SELECT * FROM (SELECT DISTINCT ON (r.id) r.id AS report_id, v.version, r.title, r.kind, v.published_at, u.display_name AS coach_name FROM coaching_reports r JOIN coaching_report_versions v ON v.report_id=r.id JOIN users u ON u.id=r.coach_id
        WHERE r.athlete_id=$1 AND v.audience=$2 ORDER BY r.id, v.version DESC) x ORDER BY published_at DESC, report_id LIMIT $3 OFFSET $4`, [athlete, audience, i.limit, i.offset]);
  },
});
