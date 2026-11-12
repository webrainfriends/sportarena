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
import { ask, askDetailed, aiConfigured, AI_RULES, quoteData } from '../ai.js';
import { fixtureContext, roleContext } from './match-tracking.js';
import { packOf } from './rule-packs.js';
import { checklistFor, checklistItems } from '../officials-checklist.js';
import { isYouthEvent } from '../spectator.js';
import { rulesetForEvent } from '../scoring/state.js';
import { bookFor } from '../rulebook/catalog.js';
import { resolveBook, standardHash } from '../rulebook/apply.js';
import { setView, currentSettings } from './rulebook.js';
import { mapLinks } from './venues.js';
import { randomBytes } from 'node:crypto';

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
      fixture: { id: f.id, event_id: f.event_id, scheduled_at: f.scheduled_at, duration_min: f.duration_min, status: f.status, round: f.round, timezone: row.timezone ?? 'UTC' },
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
      safety: 'Follow the venue\'s emergency plan. Stop play if there is any risk and call the venue emergency contact. GotMyGame does not store medical detail.',
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

// ------------------------------------------------------------------ rule session helpers
/** Resolve the governing rule pack and local settings for a fixture. */
async function resolvePackForFixture(fixtureId) {
  const f = await one('SELECT e.id AS event_id, s.slug, s.name AS sport_name, e.comp_season_id FROM fixtures fx JOIN events e ON e.id=fx.event_id JOIN sports s ON s.id=e.sport_id WHERE fx.id=$1', [fixtureId]);
  if (!f) throw notFound('Fixture');
  let pack = null, localId = null, localName = null, effectiveDate = null, packVersion = null, packName = null;
  if (f.comp_season_id) {
    try { const p = await packOf(pool, f.comp_season_id); pack = p?.current ?? null; } catch { /* no pack */ }
  }
  if (pack) { packVersion = pack.version; packName = pack.name; }
  const lrs = await one("SELECT lr.id, lr.name FROM local_rule_sets ls JOIN local_rule_versions lr ON lr.set_id=ls.id AND lr.id=ls.current_version_id WHERE ls.scope='event' AND ls.event_id=$1 AND ls.status='active' ORDER BY lr.published_at DESC LIMIT 1", [f.event_id]);
  if (lrs) { localId = lrs.id; localName = lrs.name; }
  // effective date: from pack created_at or local version
  if (pack) effectiveDate = pack.created_at ? String(pack.created_at).slice(0, 10) : null;
  return { slug: f.slug, sportName: f.sport_name, packRow: pack, localId, localName, effectiveDate, packVersion, packName };
}

/** Resolve book cards from a session's stored pack snapshot or live resolveBook. */
function resolveCardsFromSession(session) {
  // sessions store slug/format; re-resolve live (snapshot stored separately for offline)
  return resolveBook(session.sport_slug, session.sport_format ?? undefined, {});
}

/** Build a standard pack hash using session's stored pack. Falls back to standardHash. */
function hashForSession(session) {
  return session.pack_hash ?? standardHash(session.sport_slug, session.sport_format ?? undefined);
}

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
    let slug = i.sport, localId = null, format, packMeta = null;
    if (i.fixture_id) {
      const x = await standing(user, i.fixture_id);
      const r = await resolvePackForFixture(i.fixture_id);
      slug = r.slug; localId = r.localId;
      packMeta = r.packRow ? { gov_pack_id: r.packRow.id, gov_pack_version: r.packVersion, gov_pack_name: r.packName, effective_date: r.effectiveDate } : null;
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
    if (!scored.length) return { ...base, answer: null, insufficient: true, message: `The ${book.name} rulebook in GotMyGame does not cover that, so I will not guess. Check the governing body's full text.`, citations: [], official_url: book.official_url };
    const citations = scored.map(({ c }, n) => ({ n: n + 1, no: c.no ?? null, title: c.title, text: c.body, settings: c.params.map((p) => ({ label: p.label, value: p.value, standard: p.std, local_change: p.changed })), source: `${book.name} (${book.body})`, official_url: book.official_url }));
    const version = { standard_hash: standardHash(sport.slug, format), local: view ? { id: view.id, name: view.name, version: view.current_version } : null, ...(packMeta ?? {}) };
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

// ------------------------------------------------------------------ versioned rule AI session caps

cap({
  name: 'start_rule_session', method: 'POST', path: '/fixtures/:id/rule-sessions', tag: TAG,
  summary: 'Start a versioned rules Q&A session for a fixture. The session is anchored to the governing rule pack in force at this moment. Any previous open session for the same user+fixture is closed.',
  input: z.object({ id, sport_format: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    const r = await resolvePackForFixture(i.id);
    const format = i.sport_format ?? null;
    const book = resolveBook(r.slug, format ?? undefined, {});
    const hash = standardHash(r.slug, format ?? undefined);
    // Close any existing open session for this user+fixture
    await pool.query("UPDATE rule_ai_sessions SET status='closed', closed_at=now() WHERE fixture_id=$1 AND user_id=$2 AND status='open'", [i.id, user.id]);
    const sess = await one(
      `INSERT INTO rule_ai_sessions (fixture_id,user_id,sport_slug,sport_format,gov_pack_id,gov_pack_version,gov_pack_name,local_rule_version_id,local_rule_set_name,effective_date,pack_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [i.id, user.id, r.slug, format, r.packRow?.id ?? null, r.packVersion ?? null, r.packName ?? null, r.localId ?? null, r.localName ?? null, r.effectiveDate ?? null, hash],
    );
    return { session_id: sess.id, sport: r.slug, sport_name: r.sportName, format, pack_name: r.packName, pack_version: r.packVersion, effective_date: r.effectiveDate, pack_hash: hash, rulebook_name: book.name };
  },
});

cap({
  name: 'ask_rule_session', method: 'POST', path: '/rule-sessions/:id/ask', tag: TAG,
  summary: 'Ask a follow-up or new rules question within a versioned session. Returns an answer with citations, or a single clarifying question if the query is ambiguous.',
  input: z.object({ id, question: z.string().trim().min(3).max(500) }),
  async handler({ user }, i) {
    const sess = await one('SELECT * FROM rule_ai_sessions WHERE id=$1', [i.id]);
    if (!sess) throw notFound('Session');
    if (sess.user_id !== user.id) throw notFound('Session');
    if (sess.status !== 'open') throw badRequest('Session is closed');
    const base = { session_id: i.id, question: i.question };
    // Safety: decline on-field calls
    if (CALL.test(i.question)) {
      const turn = await one(
        'INSERT INTO rule_ai_turns (session_id,turn_no,question,declined,ai_used,citations_json) VALUES ($1,$2,$3,true,false,\'[]\') RETURNING id,turn_no',
        [i.id, (sess.turn_count || 0) + 1],
      );
      await pool.query('UPDATE rule_ai_sessions SET turn_count=turn_count+1 WHERE id=$1', [i.id]);
      return { ...base, turn_id: turn.id, turn_no: turn.turn_no, type: 'declined', text: 'That is a call for the match official. I can explain what the rulebook says about a situation in general, but I do not make, signal or record decisions, judge players or change a result.', citations: [] };
    }
    // Keyword-score relevant cards (top 5)
    const book = resolveCardsFromSession(sess);
    const q = new Set(tokens(i.question));
    const scored = book.cards.map((c) => ({ c, score: tokens(`${c.title} ${c.body} ${c.params.map((p) => p.label).join(' ')}`).filter((w) => q.has(w)).length + tokens(c.title).filter((w) => q.has(w)).length })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    if (!scored.length) {
      const turn = await one(
        'INSERT INTO rule_ai_turns (session_id,turn_no,question,insufficient,ai_used,citations_json,rule_hash) VALUES ($1,$2,$3,true,false,\'[]\',$4) RETURNING id,turn_no',
        [i.id, (sess.turn_count || 0) + 1, i.question, hashForSession(sess)],
      );
      await pool.query('UPDATE rule_ai_sessions SET turn_count=turn_count+1 WHERE id=$1', [i.id]);
      return { ...base, turn_id: turn.id, turn_no: turn.turn_no, type: 'insufficient', text: `The ${book.name} rulebook does not cover that — I will not guess. Check the governing body's official text.`, citations: [] };
    }
    const citations = scored.map(({ c }, n) => ({ n: n + 1, no: c.no ?? null, title: c.title, text: c.body, settings: c.params.map((p) => ({ label: p.label, value: p.value, local_change: p.changed })), source: `${book.name} (${book.body})`, official_url: book.official_url }));
    // Build prior-turn context (last 6 turns for context window)
    const priorTurns = await many('SELECT turn_no,question,answer,clarifying_question FROM rule_ai_turns WHERE session_id=$1 ORDER BY turn_no DESC LIMIT 6', [i.id]);
    const history = priorTurns.reverse().map((t) => `Q${t.turn_no}: ${t.question}\nA${t.turn_no}: ${t.answer ?? t.clarifying_question ?? '(unanswered)'}`).join('\n');
    let answer = null, clarifyingQ = null, model = null, inTok = null, outTok = null, aiUsed = false;
    if (aiConfigured()) {
      const data = citations.map((c) => `[${c.n}] ${c.title}: ${quoteData(c.text, 700)}`).join('\n');
      const packInfo = sess.gov_pack_name ? `${sess.gov_pack_name} v${sess.gov_pack_version ?? '?'}, effective ${sess.effective_date ?? 'unknown'}` : book.name;
      const res = await askDetailed({
        system: `You are a sport rules reference assistant for ${sess.sport_slug}. Use ONLY the numbered rule cards in <data>. Cite card numbers like [1]. Pack in force: ${packInfo}. ${AI_RULES} Never make rulings, issue cards, change scores or suggest on-field decisions. If the question is genuinely ambiguous about which rule applies, ask ONE focused clarifying question by starting your response with "CLARIFY: ". Otherwise answer directly.`,
        user: `${history ? `Conversation so far:\n${history}\n\n` : ''}Current question: ${quoteData(i.question, 400)}\n<data>\n${data}\n</data>`,
        maxTokens: 500,
      });
      aiUsed = true; model = res.model ?? null; inTok = res.usage?.input_tokens ?? null; outTok = res.usage?.output_tokens ?? null;
      if (res.text.startsWith('CLARIFY:')) { clarifyingQ = res.text.slice(8).trim(); } else { answer = res.text; }
    } else {
      answer = `From ${book.name}: ${citations[0].title}. ${citations[0].text}`;
    }
    const citJson = JSON.stringify(citations);
    const turn = await one(
      'INSERT INTO rule_ai_turns (session_id,turn_no,question,answer,clarifying_question,ai_used,model,input_tokens,output_tokens,citations_json,rule_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id,turn_no',
      [i.id, (sess.turn_count || 0) + 1, i.question, answer, clarifyingQ, aiUsed, model, inTok, outTok, citJson, hashForSession(sess)],
    );
    await pool.query('UPDATE rule_ai_sessions SET turn_count=turn_count+1 WHERE id=$1', [i.id]);
    return { ...base, turn_id: turn.id, turn_no: turn.turn_no, type: clarifyingQ ? 'clarification' : 'answer', text: answer ?? clarifyingQ, citations: answer ? citations : [], ai: aiUsed };
  },
});

cap({
  name: 'get_rule_session', method: 'GET', path: '/rule-sessions/:id', tag: TAG,
  summary: 'Retrieve a versioned rule session with all its turns and citations.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const sess = await one('SELECT * FROM rule_ai_sessions WHERE id=$1', [i.id]);
    if (!sess) throw notFound('Session');
    // Allow session owner or event managers/admins
    const isOwner = sess.user_id === user.id;
    if (!isOwner) {
      const x = await standing(user, sess.fixture_id).catch(() => null);
      if (!x?.may) throw notFound('Session');
    }
    const turns = await many('SELECT id,turn_no,question,answer,clarifying_question,declined,insufficient,citations_json,ai_used,escalated,created_at FROM rule_ai_turns WHERE session_id=$1 ORDER BY turn_no', [i.id]);
    const escalations = await many('SELECT id,turn_id,status,reason,created_at FROM rule_ai_escalations WHERE session_id=$1 ORDER BY created_at', [i.id]);
    return { ...sess, turns, escalations };
  },
});

cap({
  name: 'list_rule_sessions', method: 'GET', path: '/fixtures/:id/rule-sessions', tag: TAG,
  summary: 'List all rule sessions for a fixture (most recent first). Visible to assigned officials and event managers.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    const isOrg = x?.admin || isAdmin(user);
    // Organisers see all; officials see only their own
    const filter = isOrg ? 'WHERE fixture_id=$1' : 'WHERE fixture_id=$1 AND user_id=$2';
    const params = isOrg ? [i.id] : [i.id, user.id];
    const sessions = await many(`SELECT s.id,s.user_id,s.sport_slug,s.gov_pack_name,s.gov_pack_version,s.effective_date,s.pack_hash,s.status,s.turn_count,s.created_at,s.closed_at FROM rule_ai_sessions s ${filter} ORDER BY s.created_at DESC LIMIT 20`, params);
    return { sessions };
  },
});

cap({
  name: 'escalate_rule_turn', method: 'POST', path: '/rule-sessions/:id/turns/:turn_id/escalate', tag: TAG,
  summary: 'Escalate a rule Q&A turn for human review by the event organiser or assessor body.',
  input: z.object({ id, turn_id: id, reason: z.string().trim().min(5).max(500), routed_to_body_id: id.optional() }),
  async handler({ user }, i) {
    const sess = await one('SELECT * FROM rule_ai_sessions WHERE id=$1', [i.id]);
    if (!sess) throw notFound('Session');
    if (sess.user_id !== user.id) throw notFound('Session');
    const turn = await one('SELECT * FROM rule_ai_turns WHERE id=$1 AND session_id=$2', [i.turn_id, i.id]);
    if (!turn) throw notFound('Turn');
    if (turn.escalated) throw badRequest('Turn already escalated');
    // Get event_id via fixture
    const fx = await one('SELECT event_id FROM fixtures WHERE id=$1', [sess.fixture_id]);
    if (!fx) throw notFound('Fixture');
    const esc = await one(
      'INSERT INTO rule_ai_escalations (session_id,turn_id,raised_by,reason,event_id,routed_to_body_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,created_at',
      [i.id, i.turn_id, user.id, i.reason, fx.event_id, i.routed_to_body_id ?? null],
    );
    // Mark turn as escalated — via direct UPDATE (escalated is a status flag, not content; append-only rule blocks content edits only)
    await pool.query('UPDATE rule_ai_turns SET escalated=true WHERE id=$1', [i.turn_id]);
    await notify(null, fx.event_id, { kind: 'rule_escalation', escalation_id: esc.id, session_id: i.id, turn_no: turn.turn_no });
    return { escalation_id: esc.id, session_id: i.id, turn_id: i.turn_id, created_at: esc.created_at };
  },
});

cap({
  name: 'list_rule_escalations', method: 'GET', path: '/rule-escalations', tag: TAG,
  summary: 'List open rule escalations routed to this user\'s events (organiser) or assessor body. Requires event manager / assessor role.',
  input: z.object({ event_id: id.optional(), status: z.enum(['open', 'resolved', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    if (!isAdmin(user)) {
      // Must be organiser of at least one event — filter to events they manage
      const managed = await many("SELECT e.id FROM events e JOIN event_roles r ON r.event_id=e.id AND r.user_id=$1 AND r.role IN ('organiser','admin','assessor') WHERE e.status != 'archived'", [user.id]);
      if (!managed.length) throw notFound('Escalations');
      const ids = managed.map((e) => e.id);
      const statusFilter = i.status ? `AND esc.status=$2` : '';
      const params = i.status ? [ids, i.status] : [ids];
      const rows = await many(`SELECT esc.*,s.sport_slug,t.question,t.answer FROM rule_ai_escalations esc JOIN rule_ai_sessions s ON s.id=esc.session_id JOIN rule_ai_turns t ON t.id=esc.turn_id WHERE esc.event_id=ANY($1::uuid[]) ${statusFilter} ORDER BY esc.created_at DESC LIMIT 50`, params);
      return { escalations: rows };
    }
    const params = []; const filters = [];
    if (i.event_id) { params.push(i.event_id); filters.push(`esc.event_id=$${params.length}`); }
    if (i.status) { params.push(i.status); filters.push(`esc.status=$${params.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await many(`SELECT esc.*,s.sport_slug,t.question,t.answer FROM rule_ai_escalations esc JOIN rule_ai_sessions s ON s.id=esc.session_id JOIN rule_ai_turns t ON t.id=esc.turn_id ${where} ORDER BY esc.created_at DESC LIMIT 50`, params);
    return { escalations: rows };
  },
});

cap({
  name: 'resolve_rule_escalation', method: 'POST', path: '/rule-escalations/:id/resolve', tag: TAG,
  summary: 'Resolve a rule escalation with a human clarification and outcome. Visible to the official who raised it.',
  input: z.object({ id, resolution_note: z.string().trim().min(5).max(2000), outcome: z.enum(['confirmed', 'amended', 'deferred']) }),
  async handler({ user }, i) {
    const esc = await one('SELECT * FROM rule_ai_escalations WHERE id=$1', [i.id]);
    if (!esc) throw notFound('Escalation');
    if (esc.status !== 'open') throw badRequest('Escalation already resolved');
    // Must be event organiser/admin or platform admin
    const x = await one("SELECT 1 FROM event_roles WHERE event_id=$1 AND user_id=$2 AND role IN ('organiser','admin','assessor')", [esc.event_id, user.id]);
    if (!x && !isAdmin(user)) throw notFound('Escalation');
    const noteEnc = encrypt(i.resolution_note);
    await pool.query("UPDATE rule_ai_escalations SET status='resolved',resolved_by=$1,resolution_note_enc=$2,resolution_outcome=$3,resolved_at=now() WHERE id=$4", [user.id, noteEnc, i.outcome, i.id]);
    await audit(esc.event_id, user.id, 'rule_escalation.resolved', 'rule_ai_escalation', i.id);
    await notify(null, esc.raised_by, { kind: 'rule_escalation_resolved', escalation_id: i.id, outcome: i.outcome });
    return { escalation_id: i.id, outcome: i.outcome, resolved_at: new Date().toISOString() };
  },
});

cap({
  name: 'get_offline_rule_pack', method: 'GET', path: '/fixtures/:id/offline-rules', tag: TAG,
  summary: 'Get the full resolved rule pack for a fixture suitable for offline caching on the mobile client. Returns a signed content token valid for 7 days.',
  input: z.object({ id, sport_format: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    const r = await resolvePackForFixture(i.id);
    const format = i.sport_format ?? null;
    const book = resolveBook(r.slug, format ?? undefined, {});
    const hash = standardHash(r.slug, format ?? undefined);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // Upsert snapshot row (keep existing if same hash — append-only table, no update needed)
    const existing = await one('SELECT id FROM rule_pack_snapshots WHERE fixture_id=$1 AND user_id=$2 AND pack_hash=$3 AND expires_at>now()', [i.id, user.id, hash]);
    let snapId = existing?.id;
    if (!snapId) {
      const snap = await one(
        'INSERT INTO rule_pack_snapshots (fixture_id,user_id,gov_pack_id,sport_slug,sport_format,content_json,pack_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id',
        [i.id, user.id, r.packRow?.id ?? null, r.slug, format, JSON.stringify(book), hash, expiresAt],
      );
      snapId = snap.id;
    }
    return {
      snap_id: snapId,
      sport: r.slug,
      sport_name: r.sportName,
      pack_name: r.packName ?? book.name,
      pack_version: r.packVersion,
      effective_date: r.effectiveDate,
      pack_hash: hash,
      expires_at: expiresAt.toISOString(),
      content: book,
    };
  },
});

// ------------------------------------------------------------------ R10 additions

cap({
  name: 'list_fixture_audit', method: 'GET', path: '/fixtures/:id/audit', tag: TAG,
  summary: 'Tamper-evident audit trail for a fixture (organiser and platform admin only). Returns SHA-256 chained rows.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (!x.organiser && !x.admin) throw notFound('Fixture');
    const rows = await many(
      `SELECT al.id, al.action, al.actor_id, al.subject_type, al.subject_id, al.detail, al.created_at, al.hash
         FROM audit_log al WHERE al.subject_id=$1 ORDER BY al.created_at DESC, al.id DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset],
    );
    return { rows, fixture_id: i.id };
  },
});

cap({
  name: 'get_role_permissions', method: 'GET', path: '/fixtures/:id/permissions', tag: TAG,
  summary: 'Returns the calling user\'s role-based permissions on this fixture (crew member, organiser, observer, scorer, etc.).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await roleContext(user, i.id, pool);
    return {
      fixture_id: i.id,
      role: ctx.officialRole,
      organiser: ctx.organiser,
      official: ctx.official,
      canScore: ctx.canScore,
      canFileReport: ctx.canFileReport,
      canSubmitReport: ctx.canSubmitReport,
      canReadAllReports: ctx.canReadAllReports,
      canObserve: ctx.canObserve,
      isChief: ctx.isChief,
      isScorer: ctx.isScorer,
      isObserver: ctx.isObserver,
    };
  },
});

// ─── R21: Arrival logistics & venue check-in ────────────────────────────────

cap({
  name: 'dispatch_fixture_logistics', method: 'POST', path: '/fixtures/:id/logistics', tag: TAG,
  summary: 'Organiser dispatches the venue logistics packet (parking, gate, official room, equipment checklist, emergency contacts) to all accepted officials. Generates per-official check-in codes.',
  input: z.object({
    id,
    parking_notes: z.string().max(1000).optional(),
    gate_instructions: z.string().max(1000).optional(),
    official_room: z.string().max(500).optional(),
    reporting_location_notes: z.string().max(1000).optional(),
    check_in_deadline_min: z.number().int().min(0).max(120).default(20),
    emergency_contacts: z.array(z.object({
      label: z.string().max(100),
      phone: z.string().max(30),
      role: z.string().max(80),
    })).max(10).default([]),
    equipment_checklist: z.array(z.object({
      id: z.string().max(60),
      label: z.string().max(200),
      required: z.boolean().default(false),
    })).max(50).default([]),
  }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (!x.may) throw notFound();

    const encContacts = i.emergency_contacts.map(c => ({
      label: c.label,
      role: c.role,
      phone_enc: encrypt(c.phone),
    }));

    await tx(async (c) => {
      await c.query(
        `INSERT INTO fixture_logistics
           (fixture_id, parking_notes, gate_instructions, official_room,
            reporting_location_notes, emergency_contacts, equipment_checklist,
            check_in_deadline_min, dispatched_at, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,now())
         ON CONFLICT (fixture_id) DO UPDATE SET
           parking_notes=EXCLUDED.parking_notes,
           gate_instructions=EXCLUDED.gate_instructions,
           official_room=EXCLUDED.official_room,
           reporting_location_notes=EXCLUDED.reporting_location_notes,
           emergency_contacts=EXCLUDED.emergency_contacts,
           equipment_checklist=EXCLUDED.equipment_checklist,
           check_in_deadline_min=EXCLUDED.check_in_deadline_min,
           dispatched_at=now(),
           updated_at=now()`,
        [i.id, i.parking_notes??null, i.gate_instructions??null, i.official_room??null,
         i.reporting_location_notes??null, JSON.stringify(encContacts),
         JSON.stringify(i.equipment_checklist), i.check_in_deadline_min, user.id],
      );

      // Assign check-in codes to any accepted officials that don't have one yet
      const officials = await c.query(
        `SELECT fo.id, fo.user_id, fo.check_in_code, u.display_name
         FROM fixture_officials fo JOIN users u ON u.id=fo.user_id
         WHERE fo.fixture_id=$1 AND fo.status='accepted'`,
        [i.id],
      );
      for (const off of officials.rows) {
        if (!off.check_in_code) {
          const code = randomBytes(4).toString('hex').toUpperCase();
          await c.query(`UPDATE fixture_officials SET check_in_code=$1 WHERE id=$2`, [code, off.id]);
        }
        // Notify each official
        notify(c, off.user_id, {
          kind: 'logistics_dispatched',
          title: 'Venue logistics ready',
          body: `Venue details and check-in code have been sent for your upcoming fixture.`,
          data: { fixture_id: i.id },
        });
      }
    });

    audit(null, user.id, 'dispatch_fixture_logistics', 'fixture', i.id);
    return { ok: true, fixture_id: i.id };
  },
});

cap({
  name: 'get_arrival_logistics', method: 'GET', path: '/fixtures/:id/logistics', tag: TAG,
  summary: 'Official or organiser retrieves the venue logistics packet including map links, check-in code, weather, reporting instructions and equipment checklist.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);

    const [logistics, fixture, fo] = await Promise.all([
      one(`SELECT fl.*, v.id AS venue_id, v.name AS venue_name, v.address, v.city, v.lat, v.lng
           FROM fixture_logistics fl
           LEFT JOIN fixtures f ON f.id=fl.fixture_id
           LEFT JOIN venues v ON v.id=f.venue_id
           WHERE fl.fixture_id=$1`, [i.id]),
      one(`SELECT f.scheduled_at, f.reporting_min, f.venue_id, f.status
           FROM fixtures f WHERE f.id=$1`, [i.id]),
      one(`SELECT fo.check_in_code, fo.reporting_min, fo.logistics_viewed_at
           FROM fixture_officials fo
           WHERE fo.fixture_id=$1 AND fo.user_id=$2 AND fo.status='accepted' LIMIT 1`,
          [i.id, user.id]),
    ]);

    if (!logistics) return { dispatched: false, fixture_id: i.id };

    // Mark logistics as viewed by this official
    if (fo && !fo.logistics_viewed_at) {
      pool.query(`UPDATE fixture_officials SET logistics_viewed_at=now()
                  WHERE fixture_id=$1 AND user_id=$2`, [i.id, user.id]);
    }

    // Decrypt phones only for the requesting user (not bulk-exposed)
    const contacts = (logistics.emergency_contacts || []).map(c => ({
      label: c.label,
      role: c.role,
      phone: decrypt(c.phone_enc),
    }));

    const checkIn = await one(
      `SELECT checked_in_at, method, is_late FROM fixture_official_check_ins
       WHERE fixture_id=$1 AND official_id=$2`, [i.id, user.id],
    );

    audit(null, user.id, 'view_arrival_logistics', 'fixture', i.id);

    const venue = logistics.venue_id ? { id: logistics.venue_id, name: logistics.venue_name, address: logistics.address, city: logistics.city, lat: logistics.lat, lng: logistics.lng } : null;
    return {
      fixture_id: i.id,
      dispatched: true,
      dispatched_at: logistics.dispatched_at,
      parking_notes: logistics.parking_notes,
      gate_instructions: logistics.gate_instructions,
      official_room: logistics.official_room,
      reporting_location_notes: logistics.reporting_location_notes,
      check_in_deadline_min: logistics.check_in_deadline_min,
      equipment_checklist: logistics.equipment_checklist || [],
      emergency_contacts: x.may ? contacts : [],   // organiser sees contacts; crew sees empty (use own code)
      map_links: venue ? mapLinks(venue) : null,
      weather: logistics.weather_fetched_at && (Date.now() - new Date(logistics.weather_fetched_at).getTime() < 3600_000)
        ? logistics.weather_cache : null,
      // Official-specific fields
      check_in_code: fo?.check_in_code ?? null,
      reporting_min: fo?.reporting_min ?? fixture?.reporting_min ?? 30,
      scheduled_at: fixture?.scheduled_at,
      check_in: checkIn ?? null,
    };
  },
});

cap({
  name: 'check_in_official', method: 'POST', path: '/fixtures/:id/check-in', tag: TAG,
  summary: 'Official checks in at the venue via QR scan, geofence auto-detect, or manual code. Idempotent — calling again returns the existing record. Late arrivals trigger organiser alerts.',
  input: z.object({
    id,
    method: z.enum(['qr', 'geofence', 'manual_code', 'organiser_manual']),
    check_in_code: z.string().max(20).optional(),
    official_id: z.string().uuid().optional(),   // organiser_manual only
    location_consent: z.boolean().default(false),
    late_reason: z.string().max(500).optional(),
    estimated_arrival_min: z.number().int().min(1).max(240).optional(),
  }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);

    // Determine which official is being checked in
    const targetOfficialId = (i.method === 'organiser_manual' && x.may && i.official_id)
      ? i.official_id
      : user.id;

    // Load official's fixture assignment
    const fo = await one(
      `SELECT fo.check_in_code, fo.reporting_min, f.scheduled_at,
              fl.check_in_deadline_min
       FROM fixture_officials fo
       JOIN fixtures f ON f.id=fo.fixture_id
       LEFT JOIN fixture_logistics fl ON fl.fixture_id=fo.fixture_id
       WHERE fo.fixture_id=$1 AND fo.user_id=$2 AND fo.status='accepted'`,
      [i.id, targetOfficialId],
    );
    if (!fo) throw badRequest('No accepted assignment found for this official on this fixture.');

    // Code verification
    if (i.method === 'qr' || i.method === 'manual_code') {
      if (!i.check_in_code) throw badRequest('check_in_code is required for qr and manual_code methods.');
      if (fo.check_in_code !== i.check_in_code.toUpperCase()) throw badRequest('Check-in code does not match.');
    }

    // Geofence requires explicit consent in both request and stored preference
    if (i.method === 'geofence') {
      if (!i.location_consent) throw badRequest('location_consent must be true for geofence check-in.');
      const consent = await one(`SELECT geofence_check_in FROM official_location_consent WHERE official_id=$1`, [targetOfficialId]);
      if (!consent?.geofence_check_in) throw badRequest('Geofence check-in is not enabled for this official. Update location consent first.');
    }

    // Idempotency: check if already checked in
    const existing = await one(
      `SELECT id, checked_in_at, method, is_late FROM fixture_official_check_ins
       WHERE fixture_id=$1 AND official_id=$2`, [i.id, targetOfficialId],
    );
    if (existing) return { already_checked_in: true, ...existing };

    const now = new Date();
    const deadline = fo.scheduled_at
      ? new Date(fo.scheduled_at.getTime() - (fo.check_in_deadline_min ?? 20) * 60_000)
      : null;
    const isLate = deadline ? now > deadline : false;

    const record = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO fixture_official_check_ins
           (fixture_id, official_id, method, is_late, late_reason, estimated_arrival_min,
            location_consent, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (fixture_id, official_id) DO NOTHING
         RETURNING *`,
        [i.id, targetOfficialId, i.method, isLate, i.late_reason??null,
         i.estimated_arrival_min??null, i.location_consent, user.id],
      );

      if (isLate && rows.length > 0) {
        // Notify organiser(s)
        const orgs = await c.query(
          `SELECT u.id FROM fixture_event_orgs feo JOIN users u ON u.id=feo.user_id WHERE feo.fixture_id=$1`,
          [i.id],
        );
        const official = await c.query(`SELECT display_name FROM users WHERE id=$1`, [targetOfficialId]);
        for (const org of orgs.rows) {
          notify(c, org.id, {
            kind: 'official_late',
            title: 'Official late check-in',
            body: `${official.rows[0]?.display_name ?? 'An official'} checked in late${i.estimated_arrival_min ? ` (ETA +${i.estimated_arrival_min}min)` : ''}.`,
            data: { fixture_id: i.id, official_id: targetOfficialId },
          });
        }
      }

      return rows[0] ?? existing;
    });

    audit(null, user.id, 'check_in_official', 'fixture', i.id);
    return record;
  },
});

cap({
  name: 'report_late_check_in', method: 'POST', path: '/fixtures/:id/late-report', tag: TAG,
  summary: 'Official self-reports a late arrival with reason and ETA before physically checking in. Notifies the organiser immediately.',
  input: z.object({
    id,
    reason: z.string().min(1).max(500),
    estimated_arrival_min: z.number().int().min(1).max(240),
  }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (!x.crew) throw notFound();

    const fo = await one(
      `SELECT fo.id FROM fixture_officials fo WHERE fo.fixture_id=$1 AND fo.user_id=$2 AND fo.status='accepted'`,
      [i.id, user.id],
    );
    if (!fo) throw badRequest('No accepted assignment found.');

    await tx(async (c) => {
      await c.query(
        `INSERT INTO fixture_official_check_ins
           (fixture_id, official_id, method, is_late, late_reason, estimated_arrival_min, location_consent, actor_id)
         VALUES ($1,$2,'manual_code',true,$3,$4,false,$2)
         ON CONFLICT (fixture_id, official_id) DO UPDATE SET
           is_late=true, late_reason=EXCLUDED.late_reason,
           estimated_arrival_min=EXCLUDED.estimated_arrival_min,
           checked_in_at=now()`,
        [i.id, user.id, i.reason, i.estimated_arrival_min],
      );

      const orgs = await c.query(
        `SELECT u.id FROM fixture_event_orgs feo JOIN users u ON u.id=feo.user_id WHERE feo.fixture_id=$1`,
        [i.id],
      );
      const official = await c.query(`SELECT display_name FROM users WHERE id=$1`, [user.id]);
      for (const org of orgs.rows) {
        notify(c, org.id, {
          kind: 'official_late_report',
          title: 'Official reports late arrival',
          body: `${official.rows[0]?.display_name ?? 'An official'} reports late, ETA +${i.estimated_arrival_min}min: ${i.reason}`,
          data: { fixture_id: i.id, official_id: user.id },
        });
      }
    });

    audit(null, user.id, 'report_late_check_in', 'fixture', i.id);
    return { ok: true };
  },
});

cap({
  name: 'list_arrival_status', method: 'GET', path: '/fixtures/:id/arrival-status', tag: TAG,
  summary: 'Organiser or assignor sees the real-time check-in status of every accepted official crew member for this fixture.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await standing(user, i.id);
    if (!x.may) throw notFound();

    const rows = await many(
      `SELECT fo.user_id AS official_id, u.display_name, u.avatar_url,
              fo.role, fo.reporting_min,
              ci.checked_in_at, ci.method, ci.is_late, ci.estimated_arrival_min,
              fo.logistics_viewed_at,
              CASE WHEN ci.id IS NOT NULL THEN
                CASE WHEN ci.is_late THEN 'late' ELSE 'checked_in' END
              ELSE 'pending' END AS status
       FROM fixture_officials fo
       JOIN users u ON u.id=fo.user_id
       LEFT JOIN fixture_official_check_ins ci
         ON ci.fixture_id=fo.fixture_id AND ci.official_id=fo.user_id
       WHERE fo.fixture_id=$1 AND fo.status='accepted'
       ORDER BY fo.role, u.display_name`,
      [i.id],
    );

    return { fixture_id: i.id, crew: rows };
  },
});

cap({
  name: 'update_official_location_consent', method: 'POST', path: '/officials/location-consent', tag: TAG,
  summary: 'Official updates their personal preference for geofence-based automatic check-in. No precise location is ever stored.',
  input: z.object({
    geofence_check_in: z.boolean(),
  }),
  async handler({ user }, i) {
    await pool.query(
      `INSERT INTO official_location_consent (official_id, geofence_check_in, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (official_id) DO UPDATE SET geofence_check_in=EXCLUDED.geofence_check_in, updated_at=now()`,
      [user.id, i.geofence_check_in],
    );
    audit(null, user.id, 'update_location_consent', 'user', user.id);
    return { ok: true, geofence_check_in: i.geofence_check_in };
  },
});
