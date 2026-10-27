// Race operations (issue #487), part 3: publishing results (provisional -> final -> corrected), classifications and awards from explicit event policy,
// the public live/results experience, the timing-desk dashboard, bounded exports and the athlete's own view.
// Published results are frozen snapshots: a later correction creates a new publication, it never rewrites an earlier one.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { YOUTH_SQL } from '../youth.js';
import { classify, fmtMs, toCsv, encodeCursor, decodeCursor, governedStatuses, rulesSchema } from '../race.js';
import { TAG, ACTIVE_ENTRY, serial, lockRace, raceCtx, raceLog, sealReason } from './race-setup.js';
import { isFinalised, resultsStale, reconcileBatch } from './race-timing.js';

const BIB_SORT = (col) => `coalesce((CASE WHEN ${col} ~ '^[0-9]{1,15}$' THEN ${col}::bigint END), 9223372036854775807)`;
const chunk = (a, n) => { const out = []; for (let k = 0; k < a.length; k += n) out.push(a.slice(k, k + n)); return out; };
const REVIEW_FLAGS = ['review', 'needs_review'];
const CLASSIFICATION = /^(overall|gender:(male|female)|category:[0-9a-f-]{36})$/;
const likeEsc = (t) => t.replace(/[\\%_]/g, (m) => `\\${m}`);

// ---------------------------------------------------------------- publishing

async function openItems(c, disciplineId) {
  const r = (await c.query(
    `SELECT (SELECT count(*)::int FROM race_cutoffs WHERE discipline_id=$1 AND review='pending') AS pending_cutoffs,
            (SELECT count(*)::int FROM race_exceptions WHERE discipline_id=$1 AND state='open' AND kind IN ('needs_review','negative_time','status_conflict','out_of_order','multiple_reads','no_start_read','no_gun_time')) AS blocking_exceptions,
            (SELECT count(*)::int FROM race_corrections WHERE discipline_id=$1 AND state='proposed') AS proposed_corrections,
            (SELECT count(*)::int FROM race_protests WHERE discipline_id=$1 AND status='open') AS open_protests,
            (SELECT count(*)::int FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND e.race_status IN ('registered','started')) AS unresolved_entrants`, [disciplineId])).rows[0];
  return r;
}

const SESSION_STATUS = (s) => (s === 'finished' ? 'finished' : s === 'dns' ? 'dns' : s === 'dq' ? 'dq' : 'dnf');

/** Write the published result into the canonical result session (event_sessions / event_session_entries), so points, certificates and the rest of the games engine see it. */
async function syncCanonical(c, ctx, rows, userId) {
  const d = ctx.d;
  let sessionId = d.session_id;
  if (!sessionId) {
    sessionId = (await c.query(
      "INSERT INTO event_sessions(event_id, discipline_id, stage, label, status, venue_id, created_by, completed_at) VALUES ($1,$2,'final',$3,'completed',$4,$5, now()) RETURNING id",
      [d.event_id, d.id, `${d.name} – Race`, d.venue_id, userId])).rows[0].id;
    await c.query('UPDATE race_setups SET session_id=$2 WHERE discipline_id=$1', [d.id, sessionId]);
  } else await c.query("UPDATE event_sessions SET status='completed', completed_at=coalesce(completed_at, now()) WHERE id=$1", [sessionId]);
  await c.query("UPDATE event_disciplines SET status='ongoing' WHERE id=$1 AND status IN ('nominations','scheduled')", [d.id]);
  for (const part of chunk(rows, 2000)) await c.query(
    `INSERT INTO event_session_entries(session_id, participant_id, house_id, result_value, position, result_status, note)
     SELECT $1, pid, hid, tv, pos, st, 'Published from race timing' FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::int[], $6::text[]) AS t(pid, hid, tv, pos, st)
     ON CONFLICT (session_id, participant_id) WHERE participant_id IS NOT NULL DO UPDATE SET result_value=EXCLUDED.result_value, position=EXCLUDED.position, result_status=EXCLUDED.result_status, house_id=EXCLUDED.house_id`,
    [sessionId, part.map((r) => r.participant_id), part.map((r) => r.house_id ?? null), part.map((r) => (r.race_status === 'finished' && r.official_time_ms != null ? Number(r.official_time_ms) / 1000 : null)),
      part.map((r) => (r.race_status === 'finished' ? r.rank_overall ?? null : null)), part.map((r) => SESSION_STATUS(r.race_status))]);
  return sessionId;
}

cap({
  name: 'publish_race_results', method: 'POST', path: '/races/:id/publications', tag: TAG, status: 201,
  summary: 'Freeze the current results as a publication: `provisional` (live, may change), `final` (once) or `corrected` (after a final, carrying approved corrections). A publication is an immutable snapshot with the policy and course version, provenance (sources, imports, reads, approvals) and ranks for overall, declared-gender, declared-category and team classifications; final and corrected also generate the awards (ties per the pinned rule) and write the result into the event\'s canonical result session. Final needs a chief official, reconciled results and no open cutoff reviews, exceptions, proposed corrections, protests or unresolved starters, unless you acknowledge them explicitly (recorded in the provenance).',
  input: z.object({ id, label: z.enum(['provisional', 'final', 'corrected']), note: z.string().max(500).optional(), acknowledge_open_items: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'chief');
      await lockRace(c, i.id);
      const d = ctx.d, rules = ctx.rules;
      const finalised = await isFinalised(c, i.id);
      if (i.label === 'provisional' && finalised) throw conflict('Results are already final; publish a corrected result');
      if (i.label === 'final' && finalised) throw conflict('Final results are already published; publish a corrected result after approving corrections');
      if (i.label === 'corrected' && !finalised) throw conflict('Nothing is final yet; publish final first');
      const stale = await resultsStale(c, i.id);
      const never = !(await c.query('SELECT 1 FROM race_runs WHERE discipline_id=$1 LIMIT 1', [i.id])).rowCount;
      if (never) throw conflict('Reconcile the timing data before publishing');
      if (stale && i.label !== 'provisional' && !finalised) throw conflict('Evidence or settings changed since the last reconciliation; reconcile again before publishing');
      const open = await openItems(c, i.id);
      const openTotal = Object.values(open).reduce((a, b) => a + b, 0);
      if (i.label !== 'provisional' && openTotal && !i.acknowledge_open_items) throw conflict('There are open items to settle before publishing', open);

      const entrants = (await c.query(
        `SELECT e.id AS entrant_id, e.participant_id, e.category_id, p.gender, p.house_id, bib.ref AS bib_no, r.id AS result_id, r.race_status, r.official_time_ms, r.gun_time_ms, r.net_time_ms, r.splits, r.flags,
                extract(epoch from r.finish_at) * 1000 AS finish_ms
           FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
           JOIN race_results r ON r.entrant_id=e.id AND r.superseded_at IS NULL
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
          WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY}`, [i.id])).rows;
      const cats = (await c.query('SELECT * FROM race_categories WHERE discipline_id=$1', [i.id])).rows;
      const rankable = entrants.filter((e) => e.race_status === 'finished' && e.official_time_ms !== null).map((e) => ({ id: e.entrant_id, bib: e.bib_no, time: Number(e.official_time_ms), finish_ms: Math.round(Number(e.finish_ms ?? 0)), gender: e.gender, category_id: e.category_id, house_id: e.house_id }));
      const cl = classify(rankable, { tieRule: rules.tie_rule, categories: cats, team: rules.team_scoring });
      const genderRank = new Map(), catRank = new Map();
      for (const m of cl.gender.values()) for (const [k, v] of m) genderRank.set(k, v.rank);
      for (const m of cl.category.values()) for (const [k, v] of m) catRank.set(k, v.rank);
      const version = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM race_publications WHERE discipline_id=$1', [i.id])).rows[0].n;
      const prov = (await c.query(
        `SELECT (SELECT count(*)::int FROM race_reads WHERE discipline_id=$1) AS reads, (SELECT count(*)::int FROM race_imports WHERE discipline_id=$1) AS imports,
                (SELECT count(*)::int FROM race_corrections WHERE discipline_id=$1 AND state='approved') AS corrections,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind, 'integration', s.integration, 'provider_label', s.provider_label, 'reads', (SELECT count(*)::int FROM race_reads x WHERE x.source_id=s.id))), '[]'::jsonb) FROM race_sources s WHERE s.discipline_id=$1) AS sources,
                (SELECT max(created_at) FROM race_runs WHERE discipline_id=$1) AS last_reconciled_at,
                (SELECT course_version FROM race_runs WHERE discipline_id=$1 ORDER BY created_at DESC LIMIT 1) AS course_version`, [i.id])).rows[0];
      const pub = (await c.query(
        `INSERT INTO race_publications(discipline_id, version, label, policy_version, course_version, entrants, finishers, provenance, note, published_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.id, version, i.label, ctx.policyVersion, prov.course_version, entrants.length, rankable.length,
          JSON.stringify({ reads: prov.reads, imports: prov.imports, approved_corrections: prov.corrections, sources: prov.sources, last_reconciled_at: prov.last_reconciled_at, stale_when_published: stale, acknowledged_open_items: i.acknowledge_open_items ? open : null }), i.note ?? null, user.id])).rows[0];
      const rows = entrants.map((e) => ({ ...e, rank_overall: cl.overall.get(e.entrant_id)?.rank ?? null, rank_gender: genderRank.get(e.entrant_id) ?? null, rank_category: catRank.get(e.entrant_id) ?? null, tied: cl.overall.get(e.entrant_id)?.tied ?? false }));
      for (const part of chunk(rows, 1000)) await c.query(
        `INSERT INTO race_published_results(publication_id, entrant_id, result_id, bib_no, race_status, official_time_ms, gun_time_ms, net_time_ms, rank_overall, rank_gender, rank_category, tied, category_id, gender, house_id, splits)
         SELECT $1, x.entrant_id, x.result_id, x.bib_no, x.race_status, x.official_time_ms, x.gun_time_ms, x.net_time_ms, x.rank_overall, x.rank_gender, x.rank_category, x.tied, x.category_id, x.gender, x.house_id,
                CASE WHEN x.review THEN '[]'::jsonb ELSE x.splits END
           FROM jsonb_to_recordset($2::jsonb) AS x(entrant_id uuid, result_id uuid, bib_no text, race_status text, official_time_ms bigint, gun_time_ms bigint, net_time_ms bigint, rank_overall int, rank_gender int, rank_category int, tied boolean, category_id uuid, gender text, house_id uuid, splits jsonb, review boolean)`,
        [pub.id, JSON.stringify(part.map((e) => ({ entrant_id: e.entrant_id, result_id: e.result_id, bib_no: e.bib_no, race_status: e.race_status, official_time_ms: e.official_time_ms, gun_time_ms: e.gun_time_ms, net_time_ms: e.net_time_ms,
          rank_overall: e.rank_overall, rank_gender: e.rank_gender, rank_category: e.rank_category, tied: e.tied, category_id: e.category_id, gender: e.gender, house_id: e.house_id, splits: e.splits, review: (e.flags ?? []).some((f) => REVIEW_FLAGS.includes(f)) })))]);
      let awards = 0;
      if (i.label !== 'provisional') {
        const out = [];
        const take = (key, label, ranks, depth) => {
          for (const [entrantId, v] of ranks) if (v.rank <= depth) { const r = rankable.find((x) => x.id === entrantId); out.push({ classification: key, class_label: label, rank: v.rank, entrant_id: entrantId, house_id: null, time_ms: r.time, tied: v.tied }); }
        };
        take('overall', 'Overall', cl.overall, rules.award_depth);
        for (const [g, ranks] of cl.gender) take(`gender:${g}`, g === 'male' ? 'Men' : 'Women', ranks, rules.award_depth);
        for (const [cid, ranks] of cl.category) { const cat = cats.find((x) => x.id === cid); take(`category:${cid}`, cat.name, ranks, cat.award_depth ?? rules.award_depth); }
        for (const t of cl.teams) if (t.rank <= rules.award_depth) out.push({ classification: 'team', class_label: 'Teams', rank: t.rank, entrant_id: null, house_id: t.house_id, time_ms: t.time, tied: t.tied });
        for (const part of chunk(out, 2000)) await c.query(
          `INSERT INTO race_awards(publication_id, classification, class_label, rank, entrant_id, house_id, time_ms, tied)
           SELECT $1, x.classification, x.class_label, x.rank, x.entrant_id, x.house_id, x.time_ms, x.tied FROM jsonb_to_recordset($2::jsonb) AS x(classification text, class_label text, rank int, entrant_id uuid, house_id uuid, time_ms bigint, tied boolean)`,
          [pub.id, JSON.stringify(part)]);
        awards = out.length;
        await syncCanonical(c, ctx, rows, user.id);
      }
      await raceLog(c, { discipline_id: i.id, subject: 'publication', subject_id: pub.id, action: `published_${i.label}`, after: { version, entrants: entrants.length, finishers: rankable.length, awards }, actor_id: user.id });
      return { ...pub, awards, open_items: open, refinalize_required: !!d.finalized_at && i.label !== 'provisional' };
    });
  },
});

cap({
  name: 'list_race_publications', method: 'GET', path: '/races/:id/publications', tag: TAG,
  summary: 'Every publication of a race, newest first, with its label, versions, counts and provenance. The history of what the public was shown.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => { await raceCtx(c, user, i.id); return (await c.query('SELECT * FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC', [i.id])).rows; }),
});

cap({
  name: 'close_out_race', method: 'POST', path: '/races/:id/close-out', tag: TAG,
  summary: 'Settle everyone still unresolved before final results: entrants who never started become DNS and entrants who started without a finish become DNF, in one governed step with a written reason and the official as the source (each gets a status-history row). Dry run first; entrants with a pending cutoff review are left for their review.',
  input: z.object({ id, dns_reason: z.string().trim().min(5).max(300).default('Did not start: no start read and not marked by officials'), dnf_reason: z.string().trim().min(5).max(300).default('Did not finish: started without a finish read'), dry_run: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id, 'chief');
      await lockRace(c, i.id);
      if (await isFinalised(c, i.id)) throw conflict('Results are final; use governed corrections');
      if (await resultsStale(c, i.id)) throw conflict('Reconcile the timing data first so only real non-starters and non-finishers are closed out');
      const rows = (await c.query(
        `SELECT e.id, e.race_status FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
          WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} AND e.status_locked=false AND e.race_status IN ('registered','started')
            AND NOT EXISTS (SELECT 1 FROM race_cutoffs k WHERE k.entrant_id=e.id AND k.review='pending')`, [i.id])).rows;
      const dns = rows.filter((r) => r.race_status === 'registered'), dnf = rows.filter((r) => r.race_status === 'started');
      if (!i.dry_run) {
        for (const [list, to, why] of [[dns, 'dns', i.dns_reason], [dnf, 'dnf', i.dnf_reason]]) for (const part of chunk(list, 2000)) {
          await c.query("UPDATE race_entrants SET race_status=$2, status_locked=true, updated_at=now() WHERE id = ANY($1)", [part.map((r) => r.id), to]);
          await c.query("INSERT INTO race_status_log(entrant_id, from_status, to_status, source, reason_enc, evidence, actor_id) SELECT x, $2, $3, 'official', $4, $5, $6 FROM unnest($1::uuid[]) AS x",
            [part.map((r) => r.id), to === 'dns' ? 'registered' : 'started', to, sealReason(why), JSON.stringify({ close_out: true }), user.id]);
        }
        await reconcileBatch(c, ctx, { entrantIds: [...dns, ...dnf].map((r) => r.id), actorId: user.id });
        await raceLog(c, { discipline_id: i.id, subject: 'entrant', action: 'race_closed_out', after: { dns: dns.length, dnf: dnf.length }, actor_id: user.id });
      }
      return { dry_run: i.dry_run, dns: dns.length, dnf: dnf.length };
    });
  },
});

// ---------------------------------------------------------------- results, classifications, awards (organiser / crew)

cap({
  name: 'list_race_results', method: 'GET', path: '/races/:id/results', tag: TAG,
  summary: 'Results for the timing desk, paged with a keyset cursor. `view=current` is the live derived result (every entrant, with flags and splits); `view=published` is the latest frozen publication. Filter by classification (overall, gender:male|female, category:<id>) and search by bib or name.',
  input: z.object({ id, view: z.enum(['current', 'published']).default('current'), classification: z.string().max(60).default('overall'), q: z.string().max(80).optional(), after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id);
      const pub = i.view === 'published' ? (await c.query('SELECT * FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [i.id])).rows[0] : null;
      if (i.view === 'published' && !pub) return { view: 'published', label: null, items: [], next: null };
      const args = [pub ? pub.id : i.id], where = [];
      const p = (v) => { args.push(v); return `$${args.length}`; };
      if (i.q) { const q = p(i.q); where.push(`(lower(x.bib_no)=lower(${q}) OR x.full_name ILIKE '%' || ${q} || '%')`); }
      const cls = i.classification;
      if (!CLASSIFICATION.test(cls)) throw badRequest('Unknown classification');
      if (cls.startsWith('gender:')) where.push(`x.gender=${p(cls.slice(7))}`);
      else if (cls.startsWith('category:')) where.push(`x.category_id=${p(cls.slice(9))}::uuid`);
      const rankCol = cls.startsWith('gender:') ? 'rank_gender' : cls.startsWith('category:') ? 'rank_category' : 'rank_overall';
      const cur = decodeCursor(i.after);
      if (cur) where.push(`(x.sort_rank, x.bib_sort, x.entrant_id) > (${p(cur[0])}::int, ${p(cur[1])}::bigint, ${p(cur[2])}::uuid)`);
      let sql;
      if (pub) {
        sql = `SELECT r.entrant_id, r.bib_no, r.race_status, r.official_time_ms, r.gun_time_ms, r.net_time_ms, r.${rankCol} AS rank_col, r.rank_overall, r.rank_gender, r.rank_category, r.tied, r.category_id, r.gender, r.splits, pp.full_name, cat.name AS category
                 FROM race_published_results r JOIN race_entrants e ON e.id=r.entrant_id JOIN event_participants pp ON pp.id=e.participant_id LEFT JOIN race_categories cat ON cat.id=r.category_id WHERE r.publication_id=$1`;
      } else {
        const tie = ctx.rules.tie_rule === 'earlier_crossing' ? ', r.finish_at' : '';
        sql = `SELECT e.id AS entrant_id, bib.ref AS bib_no, r.race_status, r.official_time_ms, r.gun_time_ms, r.net_time_ms, r.flags, r.splits, r.version, r.policy_version, r.course_version, p.full_name, p.gender, e.category_id, cat.name AS category,
                 CASE WHEN r.race_status='finished' AND r.official_time_ms IS NOT NULL THEN rank() OVER (PARTITION BY ${cls.startsWith('gender:') ? 'p.gender' : cls.startsWith('category:') ? 'e.category_id' : "'all'"} ORDER BY r.official_time_ms${tie}) END AS rank_col,
                 CASE WHEN r.race_status='finished' AND r.official_time_ms IS NOT NULL THEN rank() OVER (ORDER BY r.official_time_ms${tie}) END AS rank_overall
                 FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
                 JOIN race_results r ON r.entrant_id=e.id AND r.superseded_at IS NULL LEFT JOIN race_categories cat ON cat.id=e.category_id
                 LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
                WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY}`;
      }
      const rows = (await c.query(`SELECT x.* FROM (SELECT y.*, coalesce(y.rank_col, 2147483647)::int AS sort_rank, coalesce((CASE WHEN y.bib_no ~ '^[0-9]{1,15}$' THEN y.bib_no::bigint END), 9223372036854775807) AS bib_sort FROM (${sql}) y) x ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.sort_rank, x.bib_sort, x.entrant_id LIMIT ${p(i.limit + 1)}`, args)).rows;
      const items = rows.slice(0, i.limit), last = items[items.length - 1];
      const out = items.map(({ sort_rank, bib_sort, ...r }) => ({ ...r, rank: r.rank_col, official_time: fmtMs(r.official_time_ms), gun_time: fmtMs(r.gun_time_ms), net_time: fmtMs(r.net_time_ms) }));
      return { view: i.view, label: pub?.label ?? 'current', publication_id: pub?.id ?? null, classification: cls, items: out, next: rows.length > i.limit ? encodeCursor([last.sort_rank, String(last.bib_sort), last.entrant_id]) : null };
    });
  },
});

cap({
  name: 'get_race_awards', method: 'GET', path: '/races/:id/awards', tag: TAG,
  summary: 'Awards of a final or corrected publication, grouped by classification (overall, declared gender, declared category, teams). Generated only from the pinned policy and explicit entrant fields; ties are shown as ties, never broken silently. Organiser and crew see names.',
  input: z.object({ id, publication_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id);
      const pub = i.publication_id
        ? (await c.query('SELECT * FROM race_publications WHERE id=$1 AND discipline_id=$2', [i.publication_id, i.id])).rows[0]
        : (await c.query("SELECT * FROM race_publications WHERE discipline_id=$1 AND label IN ('final','corrected') ORDER BY version DESC LIMIT 1", [i.id])).rows[0];
      if (!pub) return { publication: null, classifications: [] };
      const rows = (await c.query(
        `SELECT a.classification, a.class_label, a.rank, a.time_ms, a.tied, a.entrant_id, a.house_id, pp.full_name, bib.ref AS bib_no, h.name AS club
           FROM race_awards a LEFT JOIN race_entrants e ON e.id=a.entrant_id LEFT JOIN event_participants pp ON pp.id=e.participant_id
           LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active' LEFT JOIN event_houses h ON h.id=a.house_id
          WHERE a.publication_id=$1 ORDER BY a.classification, a.rank, a.time_ms, ${BIB_SORT('bib.ref')}, a.id`, [pub.id])).rows;
      const groups = new Map();
      for (const r of rows) { if (!groups.has(r.classification)) groups.set(r.classification, { classification: r.classification, label: r.class_label, awards: [] }); groups.get(r.classification).awards.push({ ...r, time: fmtMs(r.time_ms) }); }
      return { publication: { id: pub.id, version: pub.version, label: pub.label, policy_version: pub.policy_version, published_at: pub.published_at }, classifications: [...groups.values()] };
    });
  },
});

cap({
  name: 'export_race_results', method: 'GET', path: '/races/:id/export', tag: TAG,
  summary: 'CSV of the latest publication in bounded pages (up to 5000 rows per call, follow `next`). Organiser only; contains names, so every export is audit-logged. Spreadsheet formula characters are neutralised.',
  input: z.object({ id, after: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(5000).default(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await raceCtx(c, user, i.id, 'organizer');
      const pub = (await c.query('SELECT * FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [i.id])).rows[0];
      if (!pub) throw conflict('Nothing has been published yet');
      const cur = decodeCursor(i.after);
      const rows = (await c.query(
        `SELECT r.entrant_id, r.rank_overall, r.bib_no, pp.full_name, r.gender, cat.name AS category, h.name AS club, r.race_status, r.official_time_ms, r.gun_time_ms, r.net_time_ms, r.rank_gender, r.rank_category, r.tied
           FROM race_published_results r JOIN race_entrants e ON e.id=r.entrant_id JOIN event_participants pp ON pp.id=e.participant_id LEFT JOIN race_categories cat ON cat.id=r.category_id LEFT JOIN event_houses h ON h.id=pp.house_id
          WHERE r.publication_id=$1 ${cur ? 'AND (coalesce(r.rank_overall, 2147483647), r.entrant_id) > ($3::int, $4::uuid)' : ''} ORDER BY coalesce(r.rank_overall, 2147483647), r.entrant_id LIMIT $2`,
        cur ? [pub.id, i.limit + 1, cur[0], cur[1]] : [pub.id, i.limit + 1])).rows;
      const page = rows.slice(0, i.limit), last = page[page.length - 1];
      await audit(c, user.id, 'export_race_results', 'race', i.id);
      const cols = ['rank', 'bib', 'name', 'gender', 'category', 'club', 'status', 'official_time', 'gun_time', 'net_time', 'gender_rank', 'category_rank', 'tied'];
      const csv = toCsv(cols, page.map((r) => ({ rank: r.rank_overall, bib: r.bib_no, name: r.full_name, gender: r.gender, category: r.category, club: r.club, status: r.race_status, official_time: fmtMs(r.official_time_ms), gun_time: fmtMs(r.gun_time_ms), net_time: fmtMs(r.net_time_ms), gender_rank: r.rank_gender, category_rank: r.rank_category, tied: r.tied ? 'yes' : '' })));
      return { publication_id: pub.id, label: pub.label, version: pub.version, rows: page.length, csv, next: rows.length > i.limit ? encodeCursor([last.rank_overall ?? 2147483647, last.entrant_id]) : null };
    });
  },
});

// ---------------------------------------------------------------- public live / results (only what the policy allows)

/** A name is shown only when the race switched names on, the entrant agreed, and they are not a young account holder. */
const NAME_VISIBLE = `(p.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p.user_id AND ${YOUTH_SQL}))`;

async function publicRace(disciplineId) {
  const d = await one('SELECT d.id, d.name, d.status, d.event_id FROM race_setups s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.discipline_id=$1', [disciplineId]);
  const pol = d && await one('SELECT rules FROM race_policies WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [disciplineId]);
  const rules = pol ? rulesSchema.parse(pol.rules) : null;
  if (!d || !rules?.public.enabled) throw notFound('Race');
  const pub = await one('SELECT id, version, label, published_at, entrants, finishers, policy_version, provenance FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [disciplineId]);
  return { d, rules, pub };
}

const STATUS_LABEL = { finished: 'Finished', dns: 'Did not start', dnf: 'Did not finish', dq: 'Disqualified', cutoff: 'Missed cutoff', started: 'On course', registered: 'Registered' };

function publicRow(r, rules) {
  const showName = rules.public.names && r.name_public && r.name_visible;
  const splits = rules.public.splits ? (r.splits ?? []).filter((s) => s.status === 'read').map((s) => ({ code: s.code, label: s.label, distance_m: s.distance_m, time: fmtMs(s.net_ms ?? s.gun_ms), segment: fmtMs(s.segment_ms) })) : undefined;
  return {
    bib: r.bib_no, name: showName ? r.full_name : null, status: r.race_status, status_label: STATUS_LABEL[r.race_status] ?? r.race_status,
    rank: r.rank_overall ?? null, tied: r.tied ?? false, time: fmtMs(r.official_time_ms), category: rules.public.categories ? r.category ?? null : null,
    gender_rank: rules.public.categories ? r.rank_gender ?? null : undefined, category_rank: rules.public.categories ? r.rank_category ?? null : undefined, splits,
  };
}

const PUB_SELECT = `r.bib_no, r.race_status, r.official_time_ms, r.rank_overall, r.rank_gender, r.rank_category, r.tied, r.splits, e.name_public, ${NAME_VISIBLE} AS name_visible, p.full_name, cat.name AS category`;
const PUB_FROM = `race_published_results r JOIN race_entrants e ON e.id=r.entrant_id JOIN event_participants p ON p.id=e.participant_id LEFT JOIN race_categories cat ON cat.id=r.category_id`;

cap({
  name: 'get_race_live', method: 'GET', path: '/races/:id/live', tag: TAG, auth: 'public',
  summary: 'Public race progress for the live page: race and event, whether results are provisional, final or corrected and when they were published, wave start status, the course checkpoints, entrant/started/finished counts and the leading finishers. Only available when the organiser switched the public page on; shows no contact, medical or youth data and no names unless the race and the entrant allowed them.',
  input: z.object({ id, top: z.coerce.number().int().min(0).max(25).default(10) }),
  async handler(_, i) {
    const { d, rules, pub } = await publicRace(i.id);
    const [ev, waves, counts, course, categories] = await Promise.all([
      one('SELECT id, name, starts_on, city FROM events WHERE id=$1', [d.event_id]),
      many("SELECT name, start_at, gun_at, status FROM race_waves WHERE discipline_id=$1 AND status <> 'cancelled' ORDER BY position, start_at", [i.id]),
      one(`SELECT count(*) FILTER (WHERE ${ACTIVE_ENTRY})::int AS entrants, count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND e.race_status IN ('started','finished'))::int AS started,
                  count(*) FILTER (WHERE ${ACTIVE_ENTRY} AND e.race_status='finished')::int AS finished
             FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id WHERE e.discipline_id=$1`, [i.id]),
      many("SELECT cp.code, cp.label, cp.kind, cp.distance_m, c.unit FROM race_courses c JOIN race_checkpoints cp ON cp.course_id=c.id WHERE c.discipline_id=$1 AND c.status='published' ORDER BY cp.seq", [i.id]),
      rules.public.categories ? many('SELECT id, name FROM race_categories WHERE discipline_id=$1 AND archived_at IS NULL ORDER BY lower(name)', [i.id]) : [],
    ]);
    const leaders = pub && i.top ? (await many(`SELECT ${PUB_SELECT} FROM ${PUB_FROM} WHERE r.publication_id=$1 AND r.rank_overall IS NOT NULL ORDER BY r.rank_overall, r.entrant_id LIMIT $2`, [pub.id, i.top])).map((r) => publicRow(r, rules)) : [];
    return {
      race: { id: d.id, name: d.name, status: d.status }, event: ev, results: pub ? { label: pub.label, version: pub.version, published_at: pub.published_at, finishers: pub.finishers } : { label: 'not_published', version: null, published_at: null, finishers: 0 },
      // how the published numbers were verified: aggregates only, no device, person or vendor detail
      verification: pub ? { policy_version: pub.policy_version, reconciled_at: pub.provenance?.last_reconciled_at ?? null, approved_corrections: pub.provenance?.approved_corrections ?? 0, timing_sources: (pub.provenance?.sources ?? []).map((x) => x.kind) } : null,
      waves, counts, course, categories, leaders, features: { names: rules.public.names, splits: rules.public.splits, categories: rules.public.categories },
    };
  },
});

cap({
  name: 'search_race_public', method: 'GET', path: '/races/:id/search', tag: TAG, auth: 'public',
  summary: 'Find an entrant on the public page by bib number (always) or by name prefix (only entrants whose name is public). Returns the published rank, time and status with the provisional/final label, plus approved splits when the race publishes them. Entrants that withheld their name appear by bib only.',
  input: z.object({ id, q: z.string().trim().min(1).max(60) }),
  async handler(_, i) {
    const { rules, pub } = await publicRace(i.id);
    if (!pub) return { label: 'not_published', items: [] };
    const byName = rules.public.names && i.q.length >= 3;
    const rows = await many(
      `SELECT ${PUB_SELECT} FROM ${PUB_FROM}
        WHERE r.publication_id=$1 AND (lower(r.bib_no)=lower($2) ${byName ? `OR (e.name_public AND ${NAME_VISIBLE} AND p.full_name ILIKE $3 || '%')` : ''}) ORDER BY r.rank_overall NULLS LAST, r.bib_no LIMIT 10`, byName ? [pub.id, i.q, likeEsc(i.q)] : [pub.id, i.q]);
    return { label: pub.label, as_of: pub.published_at, items: rows.map((r) => publicRow(r, rules)) };
  },
});

cap({
  name: 'get_race_public_results', method: 'GET', path: '/races/:id/public-results', tag: TAG, auth: 'public',
  summary: 'The published results list for the public page, paged by rank. Classification: overall, gender:male|female or category:<id> (declared fields only, when the race shows categories). Always labelled provisional, final or corrected with its publication time.',
  input: z.object({ id, classification: z.string().max(60).default('overall'), after: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  async handler(_, i) {
    const { rules, pub } = await publicRace(i.id);
    if (!pub) return { label: 'not_published', items: [], next: null };
    const cls = i.classification;
    if (!CLASSIFICATION.test(cls)) throw badRequest('Unknown classification');
    if (cls !== 'overall' && !rules.public.categories) throw badRequest('This race shows the overall classification only');
    const args = [pub.id], where = [];
    const p = (v) => { args.push(v); return `$${args.length}`; };
    const col = cls.startsWith('gender:') ? 'rank_gender' : cls.startsWith('category:') ? 'rank_category' : 'rank_overall';
    if (cls.startsWith('gender:')) where.push(`r.gender=${p(cls.slice(7))}`);
    else if (cls.startsWith('category:')) where.push(`r.category_id=${p(cls.slice(9))}::uuid`);
    const cur = decodeCursor(i.after);
    if (cur) where.push(`(r.${col}, ${BIB_SORT('r.bib_no')}, r.entrant_id) > (${p(cur[0])}::int, ${p(cur[1])}::bigint, ${p(cur[2])}::uuid)`);
    const rows = await many(`SELECT ${PUB_SELECT}, r.entrant_id, ${BIB_SORT('r.bib_no')} AS bib_sort FROM ${PUB_FROM} WHERE r.publication_id=$1 AND r.${col} IS NOT NULL ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY r.${col}, ${BIB_SORT('r.bib_no')}, r.entrant_id LIMIT ${p(i.limit + 1)}`, args);
    const items = rows.slice(0, i.limit), last = items[items.length - 1];
    return { label: pub.label, as_of: pub.published_at, classification: cls, items: items.map((r) => publicRow(r, rules)), next: rows.length > i.limit ? encodeCursor([last[col], String(last.bib_sort), last.entrant_id]) : null };
  },
});

// ---------------------------------------------------------------- operational dashboard

cap({
  name: 'get_race_desk', method: 'GET', path: '/races/:id/desk', tag: TAG,
  summary: 'The timing desk in one call: entrant readiness (missing bibs, unassigned chips, unplaced entrants), wave capacity and start status, reads per checkpoint, duplicate and missing reads, the finish queue (on course, recent finishers), open timing exceptions, DNS/DNF/DQ/cutoff counts, pending cutoff reviews, corrections and protests, publication status, whether results are stale, and a prioritised "to do next" list.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await raceCtx(c, user, i.id);
      const d = ctx.d;
      const q = serial(c);
      const [ready, status, waves, reads, flags, exceptions, queue, recent, cutoffs, corrections, pub, stale, unpublished, runs] = await Promise.all([
        q.query(`SELECT count(*)::int AS entrants, count(*) FILTER (WHERE bib.id IS NULL)::int AS no_bib, count(*) FILTER (WHERE chip.id IS NULL)::int AS no_chip, count(*) FILTER (WHERE e.wave_id IS NULL)::int AS no_wave,
                        (SELECT count(*)::int FROM race_assignments a WHERE a.discipline_id=$1 AND a.state IN ('lost','damaged') AND NOT EXISTS (SELECT 1 FROM race_assignments b WHERE b.entrant_id=a.entrant_id AND b.kind=a.kind AND b.state='active')) AS lost_or_damaged
                   FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id
                   LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active' LEFT JOIN race_assignments chip ON chip.entrant_id=e.id AND chip.kind='chip' AND chip.state='active'
                  WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY}`, [i.id]).then((r) => r.rows[0]),
        q.query(`SELECT e.race_status AS status, count(*)::int AS n FROM race_entrants e JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id WHERE e.discipline_id=$1 AND ${ACTIVE_ENTRY} GROUP BY 1`, [i.id]).then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n]))),
        q.query(`SELECT w.id, w.name, w.start_at, w.gun_at, w.status, w.capacity, (SELECT count(*)::int FROM race_wave_assignments a JOIN race_entrants e ON e.id=a.entrant_id JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_participants p ON p.id=e.participant_id WHERE a.wave_id=w.id AND a.ended_at IS NULL AND ${ACTIVE_ENTRY}) AS assigned
                   FROM race_waves w WHERE w.discipline_id=$1 AND w.status <> 'cancelled' ORDER BY w.position, w.start_at`, [i.id]).then((r) => r.rows),
        q.query('SELECT checkpoint_code AS code, count(*)::int AS reads, max(observed_at) AS last_read FROM race_reads WHERE discipline_id=$1 GROUP BY 1 ORDER BY 1', [i.id]).then((r) => r.rows),
        q.query(`SELECT count(*) FILTER (WHERE 'duplicate_read' = ANY(flags))::int AS duplicate_reads, count(*) FILTER (WHERE 'missing_read' = ANY(flags))::int AS missing_reads FROM race_results WHERE discipline_id=$1 AND superseded_at IS NULL`, [i.id]).then((r) => r.rows[0]),
        q.query("SELECT kind, count(*)::int AS n FROM race_exceptions WHERE discipline_id=$1 AND state='open' GROUP BY 1 ORDER BY 2 DESC", [i.id]).then((r) => r.rows),
        q.query(`SELECT e.id AS entrant_id, bib.ref AS bib_no, pp.full_name, r.start_at
                   FROM race_entrants e JOIN event_participants pp ON pp.id=e.participant_id JOIN race_results r ON r.entrant_id=e.id AND r.superseded_at IS NULL
                   LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active' WHERE e.discipline_id=$1 AND e.race_status='started' ORDER BY r.start_at NULLS LAST, e.id LIMIT 20`, [i.id]).then((r) => r.rows),
        q.query(`SELECT e.id AS entrant_id, bib.ref AS bib_no, pp.full_name, r.finish_at, r.official_time_ms, r.flags FROM race_entrants e JOIN event_participants pp ON pp.id=e.participant_id JOIN race_results r ON r.entrant_id=e.id AND r.superseded_at IS NULL
                   LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active' WHERE e.discipline_id=$1 AND e.race_status='finished' ORDER BY r.finish_at DESC NULLS LAST LIMIT 10`, [i.id]).then((r) => r.rows.map((x) => ({ ...x, time: fmtMs(x.official_time_ms) }))),
        q.query("SELECT count(*) FILTER (WHERE review='pending')::int AS pending, count(*) FILTER (WHERE outcome='missed' AND review='pending')::int AS missed, count(*) FILTER (WHERE outcome='no_evidence' AND review='pending')::int AS no_evidence FROM race_cutoffs WHERE discipline_id=$1", [i.id]).then((r) => r.rows[0]),
        q.query(`SELECT (SELECT count(*)::int FROM race_corrections WHERE discipline_id=$1 AND state='proposed') AS proposed, (SELECT count(*)::int FROM race_protests WHERE discipline_id=$1 AND status='open') AS open_protests`, [i.id]).then((r) => r.rows[0]),
        q.query('SELECT id, version, label, published_at, finishers FROM race_publications WHERE discipline_id=$1 ORDER BY version DESC LIMIT 1', [i.id]).then((r) => r.rows[0] ?? null),
        resultsStale(q, i.id),
        q.query(`SELECT count(*)::int AS n FROM race_results r WHERE r.discipline_id=$1 AND r.superseded_at IS NULL AND r.created_at > coalesce((SELECT max(published_at) FROM race_publications WHERE discipline_id=$1), '-infinity')`, [i.id]).then((r) => r.rows[0].n),
        q.query('SELECT created_at, entrants, changed FROM race_runs WHERE discipline_id=$1 ORDER BY created_at DESC LIMIT 1', [i.id]).then((r) => r.rows[0] ?? null),
      ]);
      const finalised = await isFinalised(c, i.id);
      const open = await openItems(c, i.id);
      const todo = [];
      const add = (key, label, count, severity = 'normal') => { if (count) todo.push({ key, label, count, severity }); };
      add('bibs', 'Entrants without a bib', ready.no_bib);
      add('chips', 'Entrants without a timing chip', ready.no_chip);
      add('waves', 'Entrants not placed in a wave', ready.no_wave);
      add('reconcile', 'Reconcile the timing data (evidence changed)', stale && (reads.length || runs) ? 1 : 0, 'high');
      add('exceptions', 'Timing exceptions to review', exceptions.reduce((a, x) => a + x.n, 0), 'high');
      add('cutoffs', 'Cutoff findings awaiting an official', cutoffs.pending, 'high');
      add('corrections', 'Corrections awaiting approval', corrections.proposed, 'high');
      add('protests', 'Open protests', corrections.open_protests, 'high');
      add('unresolved', 'Entrants with no outcome yet (close out before final)', open.unresolved_entrants);
      add('publish', finalised ? 'Changes since the last publication: publish a corrected result' : 'Results changed since the last publication', unpublished && pub ? 1 : 0);
      return {
        race: { id: d.id, name: d.name, status: d.status, event_id: ctx.ev.id }, access: { organizer: ctx.organizer, chief: ctx.chief },
        readiness: ready, statuses: status, waves, reads_per_checkpoint: reads, duplicate_reads: flags.duplicate_reads, missing_reads: flags.missing_reads,
        exceptions, finish_queue: { on_course: status.started ?? 0, on_course_sample: queue, recent_finishers: recent }, cutoffs, corrections, publication: pub, final: finalised, results_stale: stale, unpublished_changes: unpublished, last_reconcile: runs, todo,
        governed_statuses: governedStatuses(ctx.rules),
      };
    });
  },
});

// ---------------------------------------------------------------- the athlete's own view

cap({
  name: 'list_my_race_entries', method: 'GET', path: '/me/races', tag: TAG,
  summary: 'Your own race entries: event and race, bib, start wave and time, your race status and your published result (rank, time, provisional/final label). Only your own record.',
  input: z.object({}),
  async handler({ user }) {
    return many(
      `SELECT d.id AS race_id, d.name AS race, ev.id AS event_id, ev.name AS event, ev.starts_on, e.id AS entrant_id, bib.ref AS bib_no, e.race_status, w.name AS wave, w.start_at AS wave_start, n.status AS entry_state,
              pr.label AS result_label, pr.published_at, pu.rank_overall, pu.official_time_ms, pu.race_status AS published_status
         FROM event_participants p JOIN race_entrants e ON e.participant_id=p.id JOIN discipline_nominations n ON n.id=e.nomination_id JOIN event_disciplines d ON d.id=e.discipline_id JOIN events ev ON ev.id=d.event_id
         LEFT JOIN race_waves w ON w.id=e.wave_id LEFT JOIN race_assignments bib ON bib.entrant_id=e.id AND bib.kind='bib' AND bib.state='active'
         LEFT JOIN LATERAL (SELECT id, label, published_at FROM race_publications WHERE discipline_id=d.id ORDER BY version DESC LIMIT 1) pr ON true
         LEFT JOIN race_published_results pu ON pu.publication_id=pr.id AND pu.entrant_id=e.id
        WHERE p.user_id=$1 ORDER BY ev.starts_on DESC NULLS LAST, d.name LIMIT 100`, [user.id])
      .then((rows) => rows.map(({ official_time_ms, ...r }) => ({ ...r, official_time: fmtMs(official_time_ms) })));
  },
});
