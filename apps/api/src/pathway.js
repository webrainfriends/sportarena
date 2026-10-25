// Pathway planning (issue #335): shared pieces for the athlete's own plan and for what a coach may see of it.
// The plan extends the study bucket list (targets) and reads trials, enquiries, evidence and credentials from where they live.
// Free text the athlete types is encrypted. A coach reads only what the athlete shared, re-checked on every request.
import { pool, one, many } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { audit, isAdmin } from './helpers.js';
import { guardianLink, guardiansOf, hasConsent, isYouth, canSeeYouth } from './youth.js';
import { coachesAthlete } from './passport-sections.js';

export const SCOPES = ['targets', 'goals', 'deadlines', 'scholarships', 'offers', 'outcomes'];
export const EVIDENCE_TYPES = ['academic_evidence', 'credential', 'passport_reference', 'passport_video', 'performance'];
export const OPEN_STAGES = ['saved', 'shortlisted', 'applying', 'applied'];

export const seal = (text, col) => encrypt(text, `pathway.${col}`);
export const open = (enc, col) => decrypt(enc, `pathway.${col}`);
export const stale = () => conflict('This was changed elsewhere; reload and try again', { code: 'stale_version' });

/** Who may act for an athlete: themselves, or a currently verified guardian of a young person. */
export async function actingFor(user, athleteId, c) {
  if (!athleteId || athleteId === user.id) return user.id;
  if (isAdmin(user)) return athleteId;
  if (!(await guardianLink(user.id, athleteId, c))) throw forbidden('You are not a verified guardian of this young person');
  return athleteId;
}

/** A young person acting for themselves needs a guardian's current consent for this purpose; a verified guardian acting is the consent. */
export async function youthGate(c, actorId, athleteId, purpose, what) {
  if (actorId !== athleteId) return;
  if ((await isYouth(athleteId, c)) && !(await hasConsent(athleteId, purpose, c))) {
    throw conflict(`A verified guardian has not given current consent for ${what}. Ask a guardian to allow it under Family & guardians.`, { code: 'guardian_consent_required', purpose });
  }
}

export const logEvent = (c, { userId, bucketId = null, kind, from = null, to = null, detail = null, actorId = null }) =>
  (c ?? pool).query('INSERT INTO pathway_events(user_id, bucket_id, kind, from_value, to_value, detail, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [userId, bucketId, kind, from, to, detail, actorId]);

/** The athlete's live bucket item (a target), or 404. */
export async function ownBucket(c, userId, bucketId) {
  const b = (await (c ?? pool).query('SELECT * FROM study_bucket WHERE id=$1 AND user_id=$2 AND removed_at IS NULL', [bucketId, userId])).rows[0];
  if (!b) throw notFound('Target');
  return b;
}

/** Move a target forward to `stage` (never backwards past the stages the athlete set by hand) and record it. */
export async function advanceBucket(c, b, stage, actorId, detail) {
  if (b.status === stage) return b;
  const row = (await c.query('UPDATE study_bucket SET status=$2, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [b.id, stage])).rows[0];
  await logEvent(c, { userId: b.user_id, bucketId: b.id, kind: 'stage', from: b.status, to: stage, detail, actorId });
  return row;
}

// ------------------------------------------------------------------ evidence
const EVIDENCE_SQL = {
  academic_evidence: "SELECT id, kind || ' · ' || institution AS label, provenance FROM academic_evidence WHERE id=$1 AND user_id=$2 AND removed_at IS NULL",
  credential: "SELECT id, title AS label, 'institution_issued' AS provenance FROM credentials WHERE id=$1 AND user_id=$2 AND status='issued' AND (expires_on IS NULL OR expires_on >= current_date)",
  passport_reference: "SELECT id, 'Coach reference' AS label, 'coach_reference' AS provenance FROM passport_references WHERE id=$1 AND user_id=$2 AND status='approved' AND removed_at IS NULL",
  passport_video: "SELECT id, title AS label, 'athlete_video_approved' AS provenance FROM passport_videos WHERE id=$1 AND user_id=$2 AND status='approved' AND removed_at IS NULL",
  performance: "SELECT id, metric || ' ' || value::text AS label, provenance FROM performances WHERE id=$1 AND user_id=$2",
};

/** The athlete's own evidence row (label + honest provenance), or 404. Content is never read: only what it is called and where it came from. */
export async function evidenceOf(c, userId, type, id) {
  const r = (await (c ?? pool).query(EVIDENCE_SQL[type], [id, userId])).rows[0];
  if (!r) throw notFound('Evidence');
  return r;
}

export const PROVENANCE = {
  self_reported: 'Self-reported', institution_issued: 'Issued by the institution', coach_reference: 'Coach reference approved by you',
  athlete_video_approved: 'Video approved by a coach', approved_competition: 'Approved competition result', imported: 'Imported',
};

// ------------------------------------------------------------------ sections (own plan and shared view read the same code)
export function progress(g) {
  if (g.current === null || g.current === undefined) return null;
  const cur = Number(g.current);
  let p;
  if (g.measure === 'yes_no') p = cur >= 1 ? 1 : 0;
  else if (g.baseline !== null && g.baseline !== undefined && Number(g.baseline) !== Number(g.target)) p = (cur - Number(g.baseline)) / (Number(g.target) - Number(g.baseline));
  else p = Number(g.target) > 0 ? cur / Number(g.target) : 0;
  return Math.max(0, Math.min(1, Math.round(p * 100) / 100));
}

const GOAL_COLS = 'g.id, g.user_id, g.sport_id, g.metric_key, g.evidence, g.academic_measure, g.kind, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, g.bucket_id, g.title, g.measure, g.unit, g.baseline::float8 AS baseline, g.target::float8 AS target, g.current::float8 AS current, g.target_date, g.status, g.notes_enc, g.achieved_at, g.row_version, g.created_at';
export async function goalsOf(userId) {
  const rows = await many(`SELECT ${GOAL_COLS} FROM pathway_goals g LEFT JOIN sports s ON s.id=g.sport_id WHERE g.user_id=$1 AND g.removed_at IS NULL ORDER BY g.status='active' DESC, g.target_date NULLS LAST, g.created_at, g.id`, [userId]);
  const { liveCurrent } = await import('./pathway-goals.js');
  const out = [];
  for (const { notes_enc, user_id, sport_id, ...g } of rows) {
    const live = await liveCurrent({ ...g, user_id, sport_id }); // a goal that follows a sport result tracks the athlete's best figure by itself
    const now = live ?? g.current;
    out.push({ ...g, current: now, current_source: live !== null ? 'live' : 'manual', notes: open(notes_enc, 'goal_notes'), progress: progress({ ...g, current: now }) });
  }
  return out;
}

export async function scholarshipsOf(userId, { includeAll = true } = {}) {
  const rows = await many(
    `SELECT sc.id, sc.bucket_id, sc.name, sc.amount_minor::float8 AS amount_minor, sc.currency, sc.period, sc.status, sc.due_on, sc.notes_enc, sc.row_version, sc.created_at
       FROM pathway_scholarships sc WHERE sc.user_id=$1 AND sc.removed_at IS NULL ORDER BY sc.created_at, sc.id`, [userId]);
  if (!rows.length) return [];
  const items = await many(
    `SELECT i.id, i.scholarship_id, i.requirement, i.source_type, i.source_id, i.attached_at FROM pathway_scholarship_items i
      WHERE i.scholarship_id = ANY($1) AND i.removed_at IS NULL ORDER BY i.created_at, i.id`, [rows.map((r) => r.id)]);
  const out = [];
  const meta = new Map();
  for (const it of items) {
    let m = null;
    if (it.source_type) { try { m = await evidenceOf(null, userId, it.source_type, it.source_id); } catch { m = null; } } // evidence later removed or revoked: shown as missing, never as met
    meta.set(it.id, m);
  }
  for (const r of rows) {
    const mine = items.filter((i) => i.scholarship_id === r.id).map((i) => {
      const m = meta.get(i.id);
      return { id: i.id, requirement: i.requirement, met: !!m, source_type: m ? i.source_type : null, evidence_label: m?.label ?? null, provenance: m ? m.provenance : null, provenance_label: m ? PROVENANCE[m.provenance] ?? m.provenance : null, source_id: includeAll && m ? i.source_id : undefined, attached_at: m ? i.attached_at : null };
    });
    const { notes_enc, ...rest } = r;
    out.push({ ...rest, notes: includeAll ? open(notes_enc, 'scholarship_notes') : undefined, items: mine, met: mine.filter((i) => i.met).length, total: mine.length });
  }
  return out;
}

const OFFER_COLS = 'o.id, o.bucket_id, o.scholarship_id, o.title, o.tuition_minor::float8 AS tuition_minor, o.other_minor::float8 AS other_minor, o.scholarship_minor::float8 AS scholarship_minor, o.currency, o.period, o.reply_by, o.starts_on, o.conditions_enc, o.source, o.status, o.decided_at, o.decision_note_enc, o.row_version, o.created_at, (o.reply_by - current_date)::int AS days_left';
export async function offersOf(userId, { ids = null } = {}) {
  const rows = await many(`SELECT ${OFFER_COLS} FROM pathway_offers o WHERE o.user_id=$1 AND o.removed_at IS NULL AND ($2::uuid[] IS NULL OR o.id = ANY($2)) ORDER BY o.created_at, o.id`, [userId, ids]);
  const names = await bucketNames(userId, rows.map((r) => r.bucket_id));
  return rows.map(({ conditions_enc, decision_note_enc, ...o }) => ({
    ...o, net_minor: o.tuition_minor + o.other_minor - o.scholarship_minor, institution: names.get(o.bucket_id)?.institution ?? null, target: names.get(o.bucket_id)?.title ?? null,
    conditions: open(conditions_enc, 'offer_conditions'), decision_note: open(decision_note_enc, 'offer_decision'),
    source_label: 'Entered by you; not verified by the institution',
  }));
}

/** Offers side by side. Amounts are never converted between currencies (or between yearly and total): each (currency, period) is its own table. */
export function compareOffers(offers) {
  const groups = new Map();
  for (const o of offers.filter((x) => x.status !== 'declined')) {
    const k = `${o.currency}/${o.period}`;
    if (!groups.has(k)) groups.set(k, { currency: o.currency, period: o.period, offers: [] });
    groups.get(k).offers.push(o);
  }
  const out = [...groups.values()].map((g) => {
    const best = g.offers.length > 1 ? Math.min(...g.offers.map((o) => o.net_minor)) : null;
    return { ...g, offers: g.offers.sort((a, b) => a.net_minor - b.net_minor || a.id.localeCompare(b.id)).map((o) => ({ ...o, lowest_net_cost: best !== null && o.net_minor === best })) };
  });
  return { groups: out, mixed: out.length > 1, notice: out.length > 1 ? 'These offers are in different currencies or periods, so they are shown separately and never converted.' : null };
}

export async function bucketNames(userId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { bucketFor } = await import('./capabilities/education-discovery.js');
  for (const b of await bucketFor(userId, { limit: 500, offset: 0, ids })) out.set(b.id, b);
  return out;
}

export async function deadlinesOf(userId, { includePast = false, limit = 100, offset = 0 } = {}) {
  const rows = await many(
    `SELECT * FROM (
       SELECT d.id, 'own' AS source, d.kind, d.title, d.due_on, (d.done_at IS NOT NULL) AS done, d.bucket_id, d.row_version, d.remind_days
         FROM pathway_deadlines d WHERE d.user_id=$1 AND d.removed_at IS NULL
       UNION ALL
       SELECT b.id, 'target', 'application', NULL, b.target_date, (b.status NOT IN ('saved','shortlisted','applying')), b.id, NULL::int, NULL::int
         FROM study_bucket b WHERE b.user_id=$1 AND b.removed_at IS NULL AND b.target_date IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pathway_deadlines d WHERE d.bucket_id=b.id AND d.kind='application' AND d.due_on=b.target_date AND d.removed_at IS NULL)
       UNION ALL
       SELECT e.id, 'trial', 'trial', ev.name, ev.starts_on, (ev.starts_on < current_date), NULL::uuid, NULL::int, NULL::int
         FROM event_entries e JOIN events ev ON ev.id=e.event_id AND ev.kind='trial'
        WHERE e.user_id=$1 AND e.team_id IS NULL AND e.status NOT IN ('withdrawn','rejected') AND ev.starts_on IS NOT NULL
       UNION ALL
       SELECT o.id, 'offer', 'offer_reply', o.title, o.reply_by, (o.status <> 'open'), o.bucket_id, NULL::int, NULL::int
         FROM pathway_offers o WHERE o.user_id=$1 AND o.removed_at IS NULL AND o.reply_by IS NOT NULL
       UNION ALL
       SELECT sc.id, 'scholarship', 'scholarship', sc.name, sc.due_on, (sc.status NOT IN ('exploring')), sc.bucket_id, NULL::int, NULL::int
         FROM pathway_scholarships sc WHERE sc.user_id=$1 AND sc.removed_at IS NULL AND sc.due_on IS NOT NULL
     ) x WHERE x.due_on IS NOT NULL AND ($2::boolean OR NOT x.done)
       ORDER BY x.due_on, x.kind, x.id LIMIT $3 OFFSET $4`, [userId, includePast, limit, offset]);
  const names = await bucketNames(userId, [...new Set(rows.map((r) => r.bucket_id).filter(Boolean))]);
  const today = (await one('SELECT current_date AS d')).d;
  return rows.map((r) => ({
    ...r, target: r.bucket_id ? names.get(r.bucket_id)?.institution ?? names.get(r.bucket_id)?.title ?? null : null,
    days_left: Math.round((new Date(r.due_on) - new Date(today)) / 86400000), overdue: !r.done && new Date(r.due_on) < new Date(today),
  }));
}

export async function eventsOf(userId, { limit = 50, offset = 0 } = {}) {
  const rows = await many('SELECT id, bucket_id, kind, from_value, to_value, detail, at FROM pathway_events WHERE user_id=$1 ORDER BY at DESC, id LIMIT $2 OFFSET $3', [userId, limit, offset]);
  const names = await bucketNames(userId, [...new Set(rows.map((r) => r.bucket_id).filter(Boolean))]);
  return rows.map((r) => ({ ...r, target: r.bucket_id ? names.get(r.bucket_id)?.title ?? null : null }));
}

export async function outcomesOf(userId, { limit = 50, offset = 0 } = {}) {
  const { bucketFor } = await import('./capabilities/education-discovery.js');
  const targets = await bucketFor(userId, { limit: 500, offset: 0 });
  const counts = {};
  for (const t of targets) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { counts, targets: targets.map((t) => ({ id: t.id, title: t.title, institution: t.institution, target_type: t.target_type, status: t.status, enquiry_status: t.enquiry_status })), timeline: await eventsOf(userId, { limit, offset }) };
}

// ------------------------------------------------------------------ sharing with a coach
/**
 * The live share that lets `user` read `athleteId`'s plan, or 404 (so its existence is not leaked). Checked on every request: the share must
 * be unrevoked and unexpired, the person must still coach the athlete, and for a young person a guardian's current sharing consent must hold.
 */
export async function liveShare(user, athleteId, c) {
  const db = c ?? pool;
  const s = (await db.query('SELECT * FROM pathway_shares WHERE athlete_id=$1 AND recipient_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [athleteId, user.id])).rows[0];
  if (!s) throw notFound('Shared pathway');
  if (!(await coachesAthlete(user.id, athleteId))) throw notFound('Shared pathway');
  if ((await isYouth(athleteId, c)) && (!(await hasConsent(athleteId, 'recruitment_sharing', c)) || !(await canSeeYouth(user, athleteId)))) throw notFound('Shared pathway');
  return s;
}

/** The sections a share allows, in the same shape the athlete sees (private ids and enquiry links removed). */
export async function sharedView(athleteId, scopes) {
  const has = (s) => scopes.includes(s);
  const view = {};
  const { bucketFor } = await import('./capabilities/education-discovery.js');
  if (has('targets')) view.targets = (await bucketFor(athleteId, { limit: 100, offset: 0 })).map(({ id, target_type, title, institution, city, country, status, target_date, listed_on_platform, enquiry_status }) => ({ id, target_type, title, institution, city, country, status, target_date, listed_on_platform, enquiry_status }));
  if (has('goals')) view.goals = (await goalsOf(athleteId)).map(({ notes, bucket_id, ...g }) => g);
  if (has('deadlines')) view.deadlines = (await deadlinesOf(athleteId, { includePast: false })).map(({ bucket_id, ...d }) => d);
  if (has('scholarships')) view.scholarships = (await scholarshipsOf(athleteId, { includeAll: false })).map(({ notes, bucket_id, ...s }) => s);
  if (has('offers')) view.offers = compareOffers(await offersOf(athleteId)).groups.map((g) => ({ ...g, offers: g.offers.map(({ conditions, decision_note, scholarship_id, bucket_id, ...o }) => o) })); // conditions and notes are the athlete's own words: never shared
  if (has('outcomes')) view.outcomes = await outcomesOf(athleteId, { limit: 50, offset: 0 });
  return view;
}

export const auditSharedRead = (user, share) => audit(null, user.id, 'read_pii', 'pathway_shares', share.id);

/** Plain rows for a CSV of whatever sections are given. */
export function exportRows(view) {
  const rows = [];
  const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
  for (const t of view.targets ?? []) rows.push({ section: 'target', item: t.title, status: t.status, date: d(t.target_date), detail: [t.institution, t.city, t.country].filter(Boolean).join(', ') });
  for (const g of view.goals ?? []) rows.push({ section: `${g.kind} goal`, item: g.title, status: g.status, date: d(g.target_date), detail: `${g.current ?? '–'} of ${g.target ?? 'yes'} ${g.unit ?? ''}`.trim() });
  for (const x of view.deadlines ?? []) rows.push({ section: 'deadline', item: x.title ?? x.kind, status: x.done ? 'done' : x.overdue ? 'overdue' : 'open', date: d(x.due_on), detail: [x.kind, x.target].filter(Boolean).join(' · ') });
  for (const s of view.scholarships ?? []) rows.push({ section: 'scholarship', item: s.name, status: s.status, date: d(s.due_on), amount: s.amount_minor === null || s.amount_minor === undefined ? '' : s.amount_minor / 100, currency: s.currency ?? '', detail: `evidence ${s.met} of ${s.total}` });
  for (const g of Array.isArray(view.offers) ? view.offers : []) for (const o of g.offers) rows.push({ section: 'offer', item: o.title, status: o.status, date: d(o.reply_by), amount: o.net_minor / 100, currency: o.currency, detail: `net cost ${g.period === 'per_year' ? 'per year' : 'in total'}; ${o.source_label}` });
  for (const e of view.outcomes?.timeline ?? []) rows.push({ section: 'outcome', item: e.target ?? '', status: e.to_value ?? '', date: d(e.at), detail: `${e.kind}${e.from_value ? ` from ${e.from_value}` : ''}${e.detail ? ` – ${e.detail}` : ''}` });
  return rows;
}
export const EXPORT_COLS = ['section', 'item', 'status', 'date', 'amount', 'currency', 'detail'];

export { guardiansOf };
