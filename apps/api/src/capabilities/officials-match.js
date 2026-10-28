// Match-day support for officials (#88): the pre-match briefing and checklist, official incident / match reports, and grounded rules Q&A.
// The live console itself is the existing Match Centre (canonical match_events, idempotent via client_key) and results go through the
// score-sheet workflow; nothing here is a second scoreboard, result store or dispute system.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { ask, aiConfigured, AI_RULES, quoteData } from '../ai.js';
import { fixtureContext } from './match-tracking.js';
import { checklistFor, checklistItems } from '../officials-checklist.js';
import { isYouthEvent } from '../spectator.js';
import { rulesetForEvent } from '../scoring/state.js';
import { bookFor } from '../rulebook/catalog.js';
import { resolveBook, standardHash } from '../rulebook/apply.js';
import { setView, currentSettings } from './rulebook.js';

const TAG = 'Officials';
const CATEGORIES = ['match_report', 'misconduct', 'send_off', 'abandonment', 'venue_incident', 'equipment_field', 'protest_noted', 'other'];
// Reports are operational. These words say a clinical detail is being recorded, which belongs in the health module (never in an official's report).
const CLINICAL = /\b(diagnos\w*|fractur\w*|concuss\w*|ligament|torn|sprain\w*|medicat\w*|prescri\w*|surgery|mental health|depress\w*|dislocat\w*)\b/i;
const noClinical = (text) => { if (text && CLINICAL.test(text)) throw badRequest('Keep the report operational: say that play stopped and who attended, not medical detail. Clinical information is never stored in an official report.'); };

/** The caller's standing on a fixture: organiser/admin, or accepted (or completed) crew. Anyone else is told it does not exist. */
async function standing(user, fixtureId) {
  const x = await fixtureContext(user, fixtureId, pool);
  const crew = (await one("SELECT role FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1", [fixtureId, user.id])) ?? (x.f.referee_id === user.id ? { role: 'referee' } : null);
  const admin = isAdmin(user);
  if (!x.organiser && !crew && !admin) throw notFound('Fixture');
  return { ...x, crew, admin, may: x.organiser || admin };
}

// ------------------------------------------------------------------ briefing + checklist
cap({
  name: 'get_match_briefing', method: 'GET', path: '/fixtures/:id/briefing', tag: TAG,
  summary: 'The pre-match briefing for confirmed crew and the organiser: match, venue, crew, the rules in force (standard book and the event\'s local rules), period structure, line-ups (names withheld for youth events) and the pre-match checklist. No private contact details.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    const f = x.f, ev = x.ev;
    const row = await one(
      `SELECT s.id AS sport_id, s.slug, s.name, s.emoji, h.name AS home_name, a.name AS away_name, r.name AS resource_name, ve.name AS venue_name, ve.city AS venue_city, ve.timezone AS timezone,
              o.display_name AS organiser_name, o.handle AS organiser_handle
         FROM fixtures f JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id JOIN users o ON o.id=e.organizer_id
         LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues ve ON ve.id=r.venue_id WHERE f.id=$1`, [f.id]);
    const crew = await many(
      `SELECT fo.id, fo.role, u.id AS user_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color, fo.fee_minor::float8 AS fee_minor, fo.fee_currency, fo.pay_status, fo.pay_confirmed_at FROM fixture_officials fo JOIN users u ON u.id=fo.user_id
        WHERE fo.fixture_id=$1 AND fo.status='accepted' ORDER BY fo.role, u.display_name`, [f.id]);
    for (const m of crew) if (!x.may && m.user_id !== user.id) { m.fee_minor = null; m.fee_currency = null; m.pay_status = null; m.pay_confirmed_at = null; } // fees are between the organiser and that official
    const youth = isYouthEvent(ev);
    const lineups = {};
    for (const side of ['home', 'away']) {
      const team = f[`${side}_team_id`];
      if (!team) { lineups[side] = null; continue; }
      const rows = await many(
        `SELECT m.status, u.display_name FROM match_appearances m JOIN users u ON u.id=m.user_id WHERE m.fixture_id=$1 AND m.team_id=$2 AND m.archived_at IS NULL AND m.status IN ('started','substitute_on','unused_sub') ORDER BY m.status, u.display_name`, [f.id, team]);
      lineups[side] = { declared: rows.length > 0, count: rows.length, players: youth ? null : rows.map((r) => ({ name: r.display_name, status: r.status })) };
    }
    const pinned = await rulesetForEvent(f.event_id, null, f.id);
    const local = await many("SELECT id FROM local_rule_sets WHERE scope='event' AND event_id=$1 AND status='active' AND sport_id=$2 ORDER BY updated_at DESC LIMIT 1", [f.event_id, row.sport_id]);
    let rules = null;
    const std = bookFor(row.slug);
    if (std) {
      let view = null;
      if (local[0]) view = await setView(local[0].id);
      const book = resolveBook(row.slug, view?.format ?? undefined, view ? currentSettings(view) : {});
      rules = {
        book: book.name, governing_body: book.body, official_url: book.official_url, standard_hash: standardHash(row.slug, view?.format ?? undefined),
        local: view ? { id: view.id, name: view.name, version: view.current_version } : null, local_changes: book.changes ?? [],
      };
    }
    return {
      fixture: { id: f.id, scheduled_at: f.scheduled_at, duration_min: f.duration_min, status: f.status, round: f.round, timezone: row.timezone ?? 'UTC' },
      event: { id: ev.id, name: ev.name, official_policy: ev.official_policy, youth },
      sport: { id: row.sport_id, slug: row.slug, name: row.name, emoji: row.emoji },
      teams: { home: row.home_name, away: row.away_name }, venue: { resource: row.resource_name, name: row.venue_name, city: row.venue_city },
      my_role: x.crew?.role ?? (x.organiser ? 'organiser' : 'admin'), crew, lineups,
      structure: {
        label: pinned.ruleset.label, kind: pinned.ruleset.kind, periods: pinned.ruleset.periods, sets: pinned.ruleset.sets ?? null, extra_time: pinned.ruleset.extra_time ?? null,
        shootout: pinned.ruleset.shootout ?? null, draw_allowed: pinned.ruleset.draw_allowed, source: pinned.source, ruleset_version: pinned.version,
        actions: [...(pinned.ruleset.events ?? []).map((e) => e.label), ...(pinned.ruleset.stats ?? []).map((e) => e.label)],
      },
      rules, organiser: { name: row.organiser_name, handle: row.organiser_handle, contact: 'in_app' },
      checklist: await checklistFor(f.id, row.slug),
      safety: 'Follow the venue\'s emergency plan. Stop play if there is any risk and call the venue emergency contact. SportArena does not store medical detail.',
    };
  },
});

cap({
  name: 'set_briefing_check', method: 'POST', path: '/fixtures/:id/briefing/checks', tag: TAG,
  summary: 'Tick or untick a pre-match check. Every change is logged with who and when; repeating the current state changes nothing.',
  input: z.object({ id, item_key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), done: z.boolean() }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (['completed', 'cancelled'].includes(x.f.status)) throw badRequest(`The match is ${x.f.status}`);
    const sport = await one('SELECT s.slug FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [x.f.event_id]);
    if (!checklistItems(sport.slug).some((it) => it.key === i.item_key)) throw badRequest('That is not a check for this sport');
    return tx(async (c) => {
      await c.query('SELECT 1 FROM fixtures WHERE id=$1 FOR UPDATE', [i.id]);
      const last = (await c.query('SELECT done FROM fixture_checklist_log WHERE fixture_id=$1 AND item_key=$2 ORDER BY at DESC, id DESC LIMIT 1', [i.id, i.item_key])).rows[0];
      if ((last?.done ?? false) !== i.done) await c.query('INSERT INTO fixture_checklist_log(fixture_id, item_key, done, actor_id) VALUES ($1,$2,$3,$4)', [i.id, i.item_key, i.done, user.id]);
      return { checklist: await checklistFor(i.id, sport.slug) };
    });
  },
});

cap({
  name: 'get_briefing_check_history', method: 'GET', path: '/fixtures/:id/briefing/checks/history', tag: TAG,
  summary: 'Who ticked or unticked each pre-match check, and when (crew and organiser).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await standing(user, i.id);
    return many(`SELECT l.id, l.item_key, l.done, l.at, u.display_name AS actor_name FROM fixture_checklist_log l JOIN users u ON u.id=l.actor_id WHERE l.fixture_id=$1 ORDER BY l.at DESC, l.id DESC LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ reports
const reportView = (r, rev, user, mayAll) => ({
  id: r.id, fixture_id: r.fixture_id, category: r.category, status: r.status, revision: r.revision, author_id: r.author_id, author_name: r.author_name, created_at: r.created_at, updated_at: r.updated_at,
  summary: rev.summary, visibility: rev.visibility, match_event_id: rev.match_event_id, person_id: rev.person_id, person_name: rev.person_name ?? null, team_id: rev.team_id, team_name: rev.team_name ?? null,
  note: rev.note_enc && (mayAll || r.author_id === user.id) ? decrypt(rev.note_enc, 'official_report.note') : null,
});
const REV_SQL = `SELECT v.*, p.display_name AS person_name, t.name AS team_name FROM official_report_revisions v LEFT JOIN users p ON p.id=v.person_id LEFT JOIN teams t ON t.id=v.team_id`;

cap({
  name: 'file_official_report', method: 'POST', path: '/fixtures/:id/reports', tag: TAG, status: 201,
  summary: 'A confirmed official files a match or incident report (misconduct, send-off, abandonment, venue or equipment issue, protest noted). Operational facts only: clinical detail is refused. Revisions are append-only, the note is encrypted, and the organiser is told a report exists (not its content).',
  input: z.object({
    id, category: z.enum(CATEGORIES), summary: z.string().trim().min(2).max(200), note: z.string().trim().max(4000).optional(), match_event_id: id.optional(), person_id: id.optional(), team_id: id.optional(),
    visibility: z.enum(['author', 'organiser']).default('organiser'),
  }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (!x.crew) throw notFound('Fixture');
    if (x.f.status === 'cancelled') throw badRequest('The match was cancelled');
    noClinical(i.summary); noClinical(i.note);
    if (i.match_event_id && !(await one('SELECT 1 AS ok FROM match_events WHERE id=$1 AND fixture_id=$2', [i.match_event_id, i.id]))) throw badRequest('That event is not part of this match');
    if (i.team_id && ![x.f.home_team_id, x.f.away_team_id].includes(i.team_id)) throw badRequest('That team is not in this match');
    if (i.person_id && !(await one('SELECT 1 AS ok FROM match_appearances WHERE fixture_id=$1 AND user_id=$2 UNION SELECT 1 FROM team_members WHERE team_id IN ($3,$4) AND user_id=$2 AND status=\'active\' LIMIT 1', [i.id, i.person_id, x.f.home_team_id, x.f.away_team_id]))) throw badRequest('That person is not part of this match');
    return tx(async (c) => {
      const r = (await c.query('INSERT INTO official_reports(fixture_id, author_id, category) VALUES ($1,$2,$3) RETURNING *', [i.id, user.id, i.category])).rows[0];
      await c.query(
        'INSERT INTO official_report_revisions(report_id, revision, summary, note_enc, match_event_id, person_id, team_id, visibility, actor_id) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)',
        [r.id, i.summary, i.note ? encrypt(i.note, 'official_report.note') : null, i.match_event_id ?? null, i.person_id ?? null, i.team_id ?? null, i.visibility, user.id]);
      await audit(c, user.id, 'official_report.file', 'official_report', r.id);
      await notify(c, x.ev.organizer_id, { kind: 'official_report', title: 'Official report filed', body: `${x.ev.name}: ${i.category.replace(/_/g, ' ')} report filed by a match official.`, data: { fixture_id: i.id, report_id: r.id } });
      return { id: r.id, fixture_id: i.id, category: r.category, revision: 1, created_at: r.created_at };
    });
  },
});

cap({
  name: 'revise_official_report', method: 'POST', path: '/official-reports/:id/revise', tag: TAG,
  summary: 'The author revises a report. The earlier revision is kept (append-only) and a reason is required.',
  input: z.object({ id, summary: z.string().trim().min(2).max(200), note: z.string().trim().max(4000).optional(), reason: z.string().trim().min(2).max(300), visibility: z.enum(['author', 'organiser']).optional() }),
  async handler({ user }, i) {
    noClinical(i.summary); noClinical(i.note);
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM official_reports WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r || r.author_id !== user.id) throw notFound('Report');
      const prev = (await c.query('SELECT * FROM official_report_revisions WHERE report_id=$1 ORDER BY revision DESC LIMIT 1', [i.id])).rows[0];
      const next = r.revision + 1;
      await c.query(
        'INSERT INTO official_report_revisions(report_id, revision, summary, note_enc, match_event_id, person_id, team_id, visibility, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [i.id, next, i.summary, i.note ? encrypt(i.note, 'official_report.note') : prev.note_enc, prev.match_event_id, prev.person_id, prev.team_id, i.visibility ?? prev.visibility, i.reason, user.id]);
      await c.query("UPDATE official_reports SET revision=$2, status='revised', updated_at=now() WHERE id=$1", [i.id, next]);
      await audit(c, user.id, 'official_report.revise', 'official_report', i.id);
      return { id: i.id, revision: next };
    });
  },
});

cap({
  name: 'list_fixture_official_reports', method: 'GET', path: '/fixtures/:id/reports', tag: TAG,
  summary: 'Reports on a match. The organiser (and the platform team) see every report that is visible to the organiser; an official sees their own. Reading a note is audit-logged.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    const rows = await many(
      `SELECT r.*, u.display_name AS author_name FROM official_reports r JOIN users u ON u.id=r.author_id WHERE r.fixture_id=$1 ORDER BY r.created_at, r.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
    const out = [];
    for (const r of rows) {
      const rev = (await many(`${REV_SQL} WHERE v.report_id=$1 ORDER BY v.revision DESC LIMIT 1`, [r.id]))[0];
      const mine = r.author_id === user.id;
      if (!mine && !(x.may && (rev.visibility === 'organiser' || x.admin))) continue; // another official's report, or one kept by its author
      if (rev.note_enc) await audit(null, user.id, 'official_report.read', 'official_report', r.id);
      out.push(reportView(r, rev, user, x.may));
    }
    return out;
  },
});

cap({
  name: 'get_official_report', method: 'GET', path: '/official-reports/:id', tag: TAG,
  summary: 'One report with its full revision history (author, organiser or platform team).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('SELECT r.*, u.display_name AS author_name FROM official_reports r JOIN users u ON u.id=r.author_id WHERE r.id=$1', [i.id]);
    if (!r) throw notFound('Report');
    const x = await standing(user, r.fixture_id).catch(() => null);
    const revs = await many(`${REV_SQL} WHERE v.report_id=$1 ORDER BY v.revision DESC`, [i.id]);
    const mine = r.author_id === user.id;
    if (!mine && !(x?.may && (revs[0].visibility === 'organiser' || x.admin))) throw notFound('Report');
    await audit(null, user.id, 'official_report.read', 'official_report', r.id);
    const disputes = await many("SELECT DISTINCT c.id, c.case_no, c.status, c.subject FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture' WHERE l.entity_id=$1 AND c.routed_to='game_officials'", [r.fixture_id]);
    return { ...reportView(r, revs[0], user, !!x?.may), revisions: revs.map((v) => ({ revision: v.revision, summary: v.summary, reason: v.reason, at: v.at, actor_id: v.actor_id })), disputes };
  },
});

// ------------------------------------------------------------------ rules Q&A
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'what', 'how', 'when', 'does', 'do', 'can', 'if', 'it', 'be', 'by', 'with', 'that', 'this', 'at', 'as', 'there', 'i', 'my', 'we', 'rule', 'rules']);
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
// Calls on the field and changes to a match are the official's alone. The assistant explains governed rules and never makes, signals or records them.
const CALL = /(\bshould (i|the (ref|referee|umpire))\b|\bdo i (award|give|issue|show|send)|\bmust i\b|\bwas (that|it|he|she|the)\b.{0,40}\b(foul|offside|handball|penalty|dive|red|yellow|legal|illegal|out|no.?ball|wide|goal|try)\b|\bis (he|she|[a-z]+) guilty\b|\b(give|award|issue|show|send off|book)\b.{0,30}\b(card|penalty|free.?kick|foul)|\b(change|set|update|record|edit|override|correct|add)\b.{0,30}\b(score|result|card|penalty|goal)\b)/i;

cap({
  name: 'ask_official_rules', method: 'GET', path: '/officials/rules/ask', tag: TAG,
  summary: 'Ask the rules: explains the governed rulebook (and the event\'s local rules) with citations to the section used. It never makes or signals a call, judges a player, issues a card or penalty, or changes a score; those questions are declined. If the rulebook does not cover the question, it says so.',
  input: z.object({ question: z.string().trim().min(3).max(300), fixture_id: id.optional(), sport: z.string().max(60).optional() }),
  async handler({ user }, i) {
    let slug = i.sport, localId = null, format;
    if (i.fixture_id) {
      const x = await standing(user, i.fixture_id);
      slug = (await one('SELECT s.slug FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [x.f.event_id])).slug;
      localId = (await one("SELECT id FROM local_rule_sets WHERE scope='event' AND event_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1", [x.f.event_id]))?.id ?? null;
    }
    if (!slug) throw badRequest('Give a fixture_id or a sport');
    const base = { question: i.question, can_not: ['make or signal a call', 'judge a player or issue a card or penalty', 'change a score or result'] };
    if (CALL.test(i.question)) return { ...base, answer: null, declined: true, message: 'That is a call for the match official. I can explain what the rulebook says about a situation in general, but I do not make, signal or record decisions, judge players or change a result.', citations: [] };
    const sport = await one('SELECT slug FROM sports WHERE slug=$1 OR id::text=$1', [slug]);
    if (!sport || !bookFor(sport.slug)) return { ...base, answer: null, insufficient: true, message: 'There is no governed rulebook for this sport yet, so I cannot answer from the rules.', citations: [] };
    let view = null;
    if (localId) view = await setView(localId);
    format = view?.format ?? undefined;
    const book = resolveBook(sport.slug, format, view ? currentSettings(view) : {});
    const q = new Set(tokens(i.question));
    const scored = book.cards.map((c) => ({ c, score: tokens(`${c.title} ${c.body} ${c.params.map((p) => p.label).join(' ')}`).filter((w) => q.has(w)).length + tokens(c.title).filter((w) => q.has(w)).length })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || String(a.c.key).localeCompare(String(b.c.key))).slice(0, 3);
    if (!scored.length) return { ...base, answer: null, insufficient: true, message: `The ${book.name} rulebook in SportArena does not cover that, so I will not guess. Check the governing body's full text.`, citations: [], official_url: book.official_url };
    const citations = scored.map(({ c }, n) => ({ n: n + 1, no: c.no ?? null, title: c.title, text: c.body, settings: c.params.map((p) => ({ label: p.label, value: p.value, standard: p.std, local_change: p.changed })), source: `${book.name} (${book.body})`, official_url: book.official_url }));
    const version = { standard_hash: standardHash(sport.slug, format), local: view ? { id: view.id, name: view.name, version: view.current_version } : null };
    let answer = null;
    if (aiConfigured()) {
      const data = citations.map((c) => `[${c.n}] ${c.title}: ${quoteData(c.text, 700)} ${c.settings.map((s) => `${s.label}=${s.value}${s.local_change ? ' (local change)' : ''}`).join('; ')}`).join('\n');
      answer = await ask({
        system: `You explain the rules of a sport to a match official, using ONLY the numbered sections in <data>. Cite sections like [1]. If they do not answer the question, say so. ${AI_RULES} You must never make or suggest a call on a specific incident, judge a person, recommend a card or penalty, or change a score; if asked, decline.`,
        user: `Question: ${quoteData(i.question, 300)}\n<data>\n${data}\n</data>`, maxTokens: 400,
      });
    }
    return { ...base, answer: answer ?? `From ${book.name}: ${citations[0].title}. ${citations[0].text}`, ai: Boolean(answer), citations, rule_version: version };
  },
});
