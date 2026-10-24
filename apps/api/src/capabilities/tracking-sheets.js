// Tools > Scoring & Game Tracking (#416): the tool catalogue, reusable sheet templates and the tracking sheets themselves.
// This is an authoring/capture layer over the canonical scoring engine. A sheet never touches fixtures, match_events or score
// sheets: linking one to a game makes a result proposal (capabilities/result-proposals.js) that needs governed review.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { aiConfigured, AI_RULES, askJson, quoteData } from '../ai.js';
import { orgRole } from '../org-access.js';
import { isOrganiser } from './event-departments.js';
import { fixtureContext } from './match-tracking.js';
import { builtinRuleset } from '../scoring/rulesets.js';
import { rulesetForEvent } from '../scoring/state.js';
import { BEST_OF, buildLayout, customiseBase, customiseSchema, entryRejection, hashOf, newRef, sheetResult, trackingMode, validateTotals, variantsFor, withFormat } from '../tracking/logic.js';

const TAG = 'Tools';
const q = (c) => c ?? pool;
const MAX_ENTRIES = 3000;
const kindKey = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

// ------------------------------------------------------------------ shared helpers (also used by result-proposals.js)
export const sportOf = async (v) => { const s = await sportBySlugOrId(v); if (!s) throw notFound('Sport'); return s; };

/** Pin an immutable template version. Identical layouts are reused, so a sheet always keeps exactly what it was created from. */
export async function pinVersion(c, { sport, variant = '', ruleset, layout, origin = 'platform', name, userId = null, templateId = null, version = 1 }) {
  const layout_hash = hashOf({ layout, ruleset, templateId });
  const found = (await c.query('SELECT * FROM tracking_sheet_template_versions WHERE sport_id=$1 AND variant=$2 AND layout_hash=$3', [sport.id, variant, layout_hash])).rows[0];
  if (found) return found;
  return (await c.query(
    `INSERT INTO tracking_sheet_template_versions(template_id, sport_id, variant, version, origin, name, layout, ruleset, ruleset_hash, layout_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (sport_id, variant, layout_hash) DO NOTHING RETURNING *`,
    [templateId, sport.id, variant, version, origin, name ?? layout.title, JSON.stringify(layout), JSON.stringify(ruleset), hashOf(ruleset), layout_hash, userId])).rows[0]
    ?? (await c.query('SELECT * FROM tracking_sheet_template_versions WHERE sport_id=$1 AND variant=$2 AND layout_hash=$3', [sport.id, variant, layout_hash])).rows[0];
}

/** What a signed-in user may do with a game they are not running: propose a result when the event is public and the game can have one. */
export async function linkContext(user, fixtureId, c, { lock = false } = {}) {
  const x = await fixtureContext(user, fixtureId, c, { lock });
  const hidden = x.ev.status === 'draft' || x.ev.status === 'cancelled';
  if (hidden && !x.organiser && !x.official && !x.side) throw notFound('Fixture');
  return x;
}
export const proposable = (x) => {
  if (x.ev.status === 'draft' || x.ev.status === 'cancelled') return 'This event is not open for results';
  if (['cancelled', 'postponed', 'abandoned'].includes(x.f.status)) return `A ${x.f.status} game cannot take a result`;
  if (!x.f.home_team_id || !x.f.away_team_id) return 'The teams for this game are not decided yet';
  return null;
};

async function ownSheet(user, sheetId, c, { lock = false } = {}) {
  const s = (await q(c).query(`SELECT * FROM tracking_sheets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [sheetId])).rows[0];
  if (!s || (s.owner_id !== user.id && !isAdmin(user))) throw notFound('Tracking sheet'); // never confirm that someone else's sheet exists
  return s;
}
export { ownSheet };

const versionOf = async (vid, c) => (await q(c).query('SELECT * FROM tracking_sheet_template_versions WHERE id=$1', [vid])).rows[0];
const entriesOf = async (sheetId, c, all = true) => (await q(c).query(`SELECT id, seq, kind, side, period, label, payload, recorded_at, voided_at, void_reason FROM tracking_sheet_entries WHERE sheet_id=$1${all ? '' : ' AND voided_at IS NULL'} ORDER BY seq`, [sheetId])).rows;

/** A sheet with its pinned template, entries, computed result and checks. */
export async function sheetView(sheetId, c) {
  const s = (await q(c).query('SELECT * FROM tracking_sheets WHERE id=$1', [sheetId])).rows[0];
  if (!s) throw notFound('Tracking sheet');
  const v = await versionOf(s.template_version_id, c);
  const entries = await entriesOf(s.id, c);
  const result = sheetResult(v.ruleset, entries, s.manual_totals);
  const checks = result.home == null ? [] : validateTotals(v.ruleset, result);
  const fixture = s.fixture_id ? (await q(c).query(
    `SELECT f.id, f.status, f.scheduled_at, e.name AS event_name, h.name AS home_name, a.name AS away_name FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [s.fixture_id])).rows[0] : null;
  const proposal = s.fixture_id ? (await q(c).query('SELECT id, state, round FROM result_proposals WHERE sheet_id=$1 ORDER BY created_at DESC LIMIT 1', [s.id])).rows[0] ?? null : null;
  return {
    ...s, official: false, label: s.mode === 'linked' ? 'Result proposal - not official until approved' : 'Unofficial / standalone',
    template: { id: v.id, version: v.version, name: v.name, origin: v.origin, layout: v.layout, ruleset: v.ruleset, ruleset_hash: v.ruleset_hash },
    entries, result, checks, fixture, proposal,
  };
}

// ------------------------------------------------------------------ catalogue
cap({
  name: 'list_tool_catalogue', method: 'GET', path: '/tools', tag: TAG,
  summary: 'The Tools module: reusable utilities available to every signed-in user, with what is waiting for the caller.',
  async handler({ user }) {
    const mine = await one("SELECT count(*) FILTER (WHERE status='in_progress')::int AS in_progress, count(*)::int AS total FROM tracking_sheets WHERE owner_id=$1 AND status <> 'archived'", [user.id]);
    return [
      { key: 'document_designer', title: 'Document Designer', route: 'BrandedDocuments', summary: 'Brand kits, logos and PDF templates for invoices, reports and letters.' },
      { key: 'scoring_tracking', title: 'Scoring & Game Tracking', route: 'ScoringTool', summary: 'Sport templates, a live tracker, printable sheets, upload and linked result proposals.', in_progress: mine.in_progress, sheets: mine.total },
    ];
  },
});

// ------------------------------------------------------------------ templates
const variantOf = (sport, ruleset, v) => { const list = variantsFor(sport, ruleset); return v && list.includes(v) ? v : list[0]; };
const templateRow = (t) => ({ ...t, key: t.id });

cap({
  name: 'list_tracking_templates', method: 'GET', path: '/tracking/templates', tag: TAG,
  summary: 'Sheet templates for a sport: the governed platform starter (always available, derived from the sport\'s scoring rules, no AI needed) plus your personal and your organisations\' published templates.',
  input: z.object({ sport: z.string().min(1), variant: z.string().max(30).optional(), best_of: z.coerce.number().int().optional() }),
  async handler({ user }, i) {
    const sport = await sportOf(i.sport);
    const base = builtinRuleset(sport);
    const variants = variantsFor(sport, base);
    const variant = variantOf(sport, base, i.variant);
    const rs = withFormat(base, { best_of: i.best_of });
    const starter = { key: 'starter', scope: 'platform', name: `${rs.label} starter`, variant, layout: buildLayout(sport, rs, variant), ruleset: rs, formats: base.kind === 'sets' ? BEST_OF : null, origin: 'platform' };
    const mine = await many(
      `SELECT t.id, t.name, t.scope, t.variant, t.status, t.current_version, t.updated_at FROM tracking_sheet_templates t
        WHERE t.sport_id=$1 AND t.status='published' AND (t.owner_user_id=$2 OR t.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$2 AND status='active'))
        ORDER BY t.name, t.id`, [sport.id, user.id]);
    return { sport: { id: sport.id, slug: sport.slug, name: sport.name, scoring: sport.scoring, emoji: sport.emoji }, mode: trackingMode(sport, rs), variants, starter, templates: mine.map(templateRow) };
  },
});

async function readableTemplate(user, templateId, c) {
  const t = (await q(c).query('SELECT * FROM tracking_sheet_templates WHERE id=$1', [templateId])).rows[0];
  const ok = t && (t.owner_user_id === user.id || isAdmin(user) || (t.organisation_id && await orgRole(user, t.organisation_id, c)));
  if (!ok) throw notFound('Template');
  return t;
}

cap({
  name: 'get_tracking_template', method: 'GET', path: '/tracking/templates/:id', tag: TAG,
  summary: 'One saved template with its draft customisation and published versions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await readableTemplate(user, i.id);
    const versions = await many('SELECT id, version, origin, created_at, ruleset_hash FROM tracking_sheet_template_versions WHERE template_id=$1 ORDER BY version DESC', [t.id]);
    return { ...t, versions };
  },
});

const templateInput = {
  name: z.string().trim().min(2).max(80), sport: z.string().min(1), variant: z.string().max(30).optional(), best_of: z.number().int().optional(),
  scope: z.enum(['personal', 'organisation', 'event']).default('personal'), organisation_id: id.optional(), event_id: id.optional(),
  customise: customiseSchema,
};

cap({
  name: 'create_tracking_template', method: 'POST', path: '/tracking/templates', tag: TAG, status: 201,
  summary: 'Save a customised sheet layout as a draft. Layouts can show/hide and reorder non-scoring stats, rename labels, add non-official notes fields and set paper; scoring events and rules cannot be changed. Publish it to freeze a version.',
  input: z.object(templateInput),
  async handler({ user }, i) {
    const sport = await sportOf(i.sport);
    const rs = builtinRuleset(sport);
    if (i.best_of && (rs.kind !== 'sets' || !BEST_OF.includes(i.best_of))) throw badRequest('Best-of applies to set-based sports only (1, 3 or 5)');
    if (i.scope === 'organisation') { const r = await orgRole(user, i.organisation_id); if (!i.organisation_id || !['owner', 'admin', 'coach'].includes(r)) throw forbidden('Only an owner, admin or coach of the organisation can save its templates'); }
    if (i.scope === 'event') { const ev = i.event_id && await one('SELECT * FROM events WHERE id=$1', [i.event_id]); if (!ev) throw notFound('Event'); if (!(await isOrganiser(user, ev))) throw forbidden('Only the event organiser can save an event template'); }
    return tx(async (c) => {
      const t = (await c.query(
        `INSERT INTO tracking_sheet_templates(sport_id, variant, scope, owner_user_id, organisation_id, event_id, name, draft, best_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [sport.id, variantOf(sport, rs, i.variant), i.scope, user.id, i.scope === 'organisation' ? i.organisation_id : null, i.scope === 'event' ? i.event_id : null, i.name, JSON.stringify(i.customise), i.best_of ?? null])).rows[0];
      await audit(c, user.id, 'create_tracking_template', 'tracking_sheet_templates', t.id);
      return t;
    });
  },
});

cap({
  name: 'publish_tracking_template', method: 'POST', path: '/tracking/templates/:id/publish', tag: TAG,
  summary: 'Freeze the draft as a new immutable version. Sheets already started keep the version they were created from.',
  input: z.object({ id, customise: customiseBase.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = await readableTemplate(user, i.id, c);
      if (t.owner_user_id !== user.id && !isAdmin(user)) throw forbidden('Only the template owner can publish it');
      if (t.status === 'retired') throw conflict('A retired template cannot be published again');
      const sport = await one('SELECT * FROM sports WHERE id=$1', [t.sport_id]);
      const draft = i.customise ?? t.draft;
      const rs = withFormat(builtinRuleset(sport), { best_of: t.best_of });
      const layout = buildLayout(sport, rs, t.variant, draft);
      const version = t.current_version + 1;
      const v = (await c.query(
        `INSERT INTO tracking_sheet_template_versions(template_id, sport_id, variant, version, origin, name, layout, ruleset, ruleset_hash, layout_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [t.id, sport.id, t.variant, version, t.origin === 'ai' ? 'ai' : 'user', t.name, JSON.stringify(layout), JSON.stringify(rs), hashOf(rs), hashOf({ layout, rs, tid: t.id, version }), user.id])).rows[0];
      await c.query("UPDATE tracking_sheet_templates SET status='published', current_version=$2, draft=$3, updated_at=now() WHERE id=$1", [t.id, version, JSON.stringify(draft)]);
      await audit(c, user.id, 'publish_tracking_template', 'tracking_sheet_templates', t.id);
      return { template_id: t.id, version: v.version, version_id: v.id, layout: v.layout };
    });
  },
});

cap({
  name: 'retire_tracking_template', method: 'POST', path: '/tracking/templates/:id/retire', tag: TAG,
  summary: 'Stop offering a template for new sheets. Existing sheets and versions are untouched.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const t = await readableTemplate(user, i.id);
    if (t.owner_user_id !== user.id && !isAdmin(user)) throw forbidden('Only the template owner can retire it');
    await pool.query("UPDATE tracking_sheet_templates SET status='retired', updated_at=now() WHERE id=$1", [t.id]);
    return { id: t.id, status: 'retired' };
  },
});

cap({
  name: 'prepare_tracking_template', method: 'POST', path: '/tracking/templates/prepare', tag: TAG,
  summary: 'Suggest a layout for a brief ("U12 football, track fouls and cards"). The AI may only choose from the sport\'s governed stats and arrange them; without AI the deterministic starter is returned. Nothing is saved.',
  input: z.object({ sport: z.string().min(1), variant: z.string().max(30).optional(), brief: z.string().trim().max(300).optional() }),
  async handler(_ctx, i) {
    const sport = await sportOf(i.sport);
    const rs = builtinRuleset(sport);
    const governed = rs.stats.map((s) => s.kind);
    let custom = { hidden_stats: [], stat_order: governed, labels: {}, notes_fields: [], orientation: 'portrait', paper: 'A4', signatures: true };
    let source = 'deterministic', explanation = 'The standard sheet for this sport, built from its scoring rules.';
    if (i.brief && governed.length && aiConfigured()) {
      const out = await askJson({
        system: `You arrange a sports score/tracking sheet. You may only choose from these governed stat kinds: ${governed.join(', ')}. Never invent scoring rules or stats. ${AI_RULES}`,
        user: `Sport: ${sport.name}. Brief: <data>${quoteData(i.brief, 300)}</data>. Choose which governed stats to show (in order) and optional short notes-field titles.`,
        shape: '{"show":["kind",...],"notes_fields":["short title",...],"explanation":"one sentence"}',
        schema: z.object({ show: z.array(z.string()).max(30), notes_fields: z.array(z.string().max(40)).max(4).default([]), explanation: z.string().max(300).default('') }),
      });
      if (out) {
        const show = out.show.filter((k) => governed.includes(k));
        custom = { ...custom, hidden_stats: governed.filter((k) => !show.includes(k)), stat_order: show, notes_fields: out.notes_fields };
        source = 'ai'; explanation = out.explanation || 'Arranged from the sport\'s governed stats.';
      }
    }
    return { source, explanation, customise: custom, layout: buildLayout(sport, rs, variantOf(sport, rs, i.variant), custom), governed_stats: governed, note: 'AI-arranged layouts only reorder governed stats; they cannot change scoring.' };
  },
});

// ------------------------------------------------------------------ sheets
const rowSchema = z.object({ order: z.number().int().min(0).max(100).optional(), lane: z.string().max(10).optional(), name: z.string().trim().max(80).optional(), result: z.string().trim().max(20).optional(), status: z.enum(['', 'DNS', 'DNF', 'DQ']).optional(), rank: z.number().int().min(1).max(200).optional() });
const totalsSchema = z.object({
  home: z.number().int().min(0).max(999), away: z.number().int().min(0).max(999),
  sets: z.array(z.object({ home: z.number().int().min(0).max(300), away: z.number().int().min(0).max(300) })).max(9).optional(),
  periods: z.array(z.object({ period: z.number().int().min(1).max(20).optional(), home: z.number().int().min(0).max(999), away: z.number().int().min(0).max(999) })).max(20).optional(),
  stats: z.object({ home: z.record(kindKey, z.number().int().min(0).max(999)), away: z.record(kindKey, z.number().int().min(0).max(999)) }).optional(),
});
export { totalsSchema, rowSchema };

cap({
  name: 'create_tracking_sheet', method: 'POST', path: '/tracking/sheets', tag: TAG, status: 201,
  summary: 'Start a tracking sheet. Anyone signed in can start a standalone (unofficial) one. Giving fixture_id starts a linked sheet for that game: it uses the event\'s pinned rules and canonical team names, and stays a proposal until reviewed. A repeated client_key returns the same sheet.',
  input: z.object({
    sport: z.string().min(1).optional(), variant: z.string().max(30).optional(), best_of: z.number().int().optional(), template_id: id.optional(),
    fixture_id: id.optional(), title: z.string().trim().max(120).optional(), labels: z.object({ home: z.string().trim().max(60).optional(), away: z.string().trim().max(60).optional() }).optional(),
    context_type: z.enum(['academy_session', 'coach_session', 'team', 'event']).optional(), context_id: id.optional(),
    occurred_at: z.string().datetime().optional(), client_key: z.string().min(1).max(64).optional(),
  }),
  async handler({ user }, i) {
    if (i.client_key) { const dup = await one('SELECT id FROM tracking_sheets WHERE owner_id=$1 AND client_key=$2', [user.id, i.client_key]); if (dup) return sheetView(dup.id); }
    return tx(async (c) => {
      let sport, ruleset, fixture = null, tpl = null, published = null, custom = {}, variant = '';
      if (i.template_id) {
        tpl = await readableTemplate(user, i.template_id, c);
        if (tpl.status !== 'published') throw conflict('Publish the template before using it');
        published = (await c.query('SELECT * FROM tracking_sheet_template_versions WHERE template_id=$1 AND version=$2', [tpl.id, tpl.current_version])).rows[0];
        custom = published.layout.custom ?? {}; // the frozen version, not the draft that may have moved on
        sport = await one('SELECT * FROM sports WHERE id=$1', [tpl.sport_id]);
        variant = tpl.variant;
      } else {
        if (!i.sport && !i.fixture_id) throw badRequest('Choose a sport');
      }
      if (i.fixture_id) {
        const x = await linkContext(user, i.fixture_id, c);
        const why = proposable(x); if (why) throw conflict(why);
        const evSport = await one('SELECT * FROM sports WHERE id=$1', [x.ev.sport_id]);
        if (sport && sport.id !== evSport.id) throw badRequest('This template is for a different sport than the game');
        if (i.sport && (await sportOf(i.sport)).id !== evSport.id) throw badRequest('The sport does not match the game');
        sport = evSport;
        ruleset = (await rulesetForEvent(x.f.event_id, c)).ruleset;
        const names = (await c.query('SELECT h.name AS home, a.name AS away FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1', [x.f.id])).rows[0];
        fixture = { id: x.f.id, labels: { home: names.home, away: names.away }, at: x.f.scheduled_at };
      } else {
        sport = sport ?? await sportOf(i.sport);
        ruleset = withFormat(tpl?.best_of ? withFormat(builtinRuleset(sport), { best_of: tpl.best_of }) : builtinRuleset(sport), { best_of: i.best_of });
        if (i.best_of && ruleset.kind !== 'sets') throw badRequest('Best-of applies to set-based sports only');
      }
      variant = variantOf(sport, ruleset, variant || i.variant);
      const layout = buildLayout(sport, ruleset, variant, custom);
      const v = (published && !fixture && !i.best_of) ? published : await pinVersion(c, { sport, variant, ruleset, layout, origin: tpl ? 'user' : 'platform', name: tpl?.name ?? layout.title, userId: user.id, templateId: tpl?.id ?? null, version: tpl?.current_version ?? 1 });
      const labels = fixture ? fixture.labels : { home: i.labels?.home || 'Home', away: i.labels?.away || 'Away' };
      const s = (await c.query(
        `INSERT INTO tracking_sheets(ref, template_version_id, owner_id, sport_id, mode, fixture_id, context_type, context_id, title, labels, occurred_at, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [newRef(), v.id, user.id, sport.id, fixture ? 'linked' : 'standalone', fixture?.id ?? null, i.context_type ?? null, i.context_id ?? null, i.title ?? null, JSON.stringify(labels), i.occurred_at ?? fixture?.at ?? new Date().toISOString(), i.client_key ?? null])).rows[0];
      await audit(c, user.id, 'create_tracking_sheet', 'tracking_sheets', s.id);
      return sheetView(s.id, c);
    });
  },
});

cap({
  name: 'get_tracking_sheet', method: 'GET', path: '/tracking/sheets/:id', tag: TAG,
  summary: 'A tracking sheet with its pinned template, entry history, computed result and checks. Only its owner can read it.',
  input: z.object({ id }),
  async handler({ user }, i) { await ownSheet(user, i.id); return sheetView(i.id); },
});

cap({
  name: 'update_tracking_sheet', method: 'PATCH', path: '/tracking/sheets/:id', tag: TAG,
  summary: 'Record on a sheet that is in progress: add an entry (validated by the canonical scoring rules), undo an entry (it is voided and kept in the history, never deleted), or edit labels, notes, totals and result rows.',
  input: z.object({
    id, title: z.string().trim().max(120).nullish(), notes: z.string().trim().max(2000).nullish(), occurred_at: z.string().datetime().optional(),
    labels: z.object({ home: z.string().trim().min(1).max(60).optional(), away: z.string().trim().min(1).max(60).optional() }).optional(),
    manual_totals: totalsSchema.nullish(), rows: z.array(rowSchema).max(60).optional(),
    add_entry: z.object({ kind: kindKey, side: z.enum(['home', 'away']).optional(), period: z.number().int().min(1).max(20).optional(), label: z.string().trim().max(60).optional(), payload: z.record(z.string(), z.unknown()).optional(), client_key: z.string().min(1).max(64).optional() }).optional(),
    void_entry: z.object({ entry_id: id.optional(), reason: z.string().trim().max(200).optional() }).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await ownSheet(user, i.id, c, { lock: true });
      if (s.status !== 'in_progress') throw conflict('This sheet is completed. Start a new sheet to record more.');
      const v = await versionOf(s.template_version_id, c);
      if (i.labels && s.mode === 'linked') throw badRequest('Team names come from the game and cannot be changed');
      const sets = [], vals = [s.id];
      const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (i.title !== undefined) set('title', i.title);
      if (i.notes !== undefined) set('notes', i.notes);
      if (i.occurred_at) set('occurred_at', i.occurred_at);
      if (i.labels) set('labels', JSON.stringify({ ...s.labels, ...Object.fromEntries(Object.entries(i.labels).filter(([, x]) => x)) }));
      if (i.manual_totals !== undefined) {
        if (i.manual_totals && (await entriesOf(s.id, c, false)).length) throw conflict('This sheet has live entries; undo them or start a new sheet to type totals instead');
        set('manual_totals', i.manual_totals ? JSON.stringify(i.manual_totals) : null);
      }
      if (i.rows) set('rows', JSON.stringify(i.rows));
      if (i.add_entry) {
        const e = i.add_entry;
        if (e.client_key) { const dup = (await c.query('SELECT 1 FROM tracking_sheet_entries WHERE sheet_id=$1 AND client_key=$2', [s.id, e.client_key])).rowCount; if (dup) { if (sets.length) await c.query(`UPDATE tracking_sheets SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals); return sheetView(s.id, c); } }
        if (s.manual_totals) throw conflict('This sheet holds typed totals; clear them to track live');
        const live = await entriesOf(s.id, c, false);
        if (live.length >= MAX_ENTRIES) throw conflict('This sheet is full; complete it and start another');
        const why = e.kind === 'note' ? null : entryRejection(v.ruleset, live, e);
        if (why) throw conflict(why);
        const seq = (await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM tracking_sheet_entries WHERE sheet_id=$1', [s.id])).rows[0].n;
        await c.query('INSERT INTO tracking_sheet_entries(sheet_id, seq, kind, side, period, label, payload, client_key, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [s.id, seq, e.kind, e.side ?? null, e.period ?? null, e.label ?? null, JSON.stringify(e.payload ?? {}), e.client_key ?? null, user.id]);
      }
      if (i.void_entry) {
        const target = i.void_entry.entry_id
          ? (await c.query('SELECT * FROM tracking_sheet_entries WHERE id=$1 AND sheet_id=$2 AND voided_at IS NULL', [i.void_entry.entry_id, s.id])).rows[0]
          : (await c.query('SELECT * FROM tracking_sheet_entries WHERE sheet_id=$1 AND voided_at IS NULL ORDER BY seq DESC LIMIT 1', [s.id])).rows[0];
        if (!target) throw conflict('There is nothing to undo');
        await c.query('UPDATE tracking_sheet_entries SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [target.id, user.id, i.void_entry.reason ?? 'Undone']);
      }
      await c.query(`UPDATE tracking_sheets SET ${sets.length ? `${sets.join(', ')}, ` : ''}updated_at=now() WHERE id=$1`, vals);
      return sheetView(s.id, c);
    });
  },
});

cap({
  name: 'complete_tracking_sheet', method: 'POST', path: '/tracking/sheets/:id/complete', tag: TAG,
  summary: 'Finish a sheet and keep it as the record. Standalone sheets stay personal and unofficial.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await ownSheet(user, i.id, c, { lock: true });
      if (s.status === 'completed') return sheetView(s.id, c);
      if (s.status !== 'in_progress') throw conflict('This sheet is archived');
      await c.query("UPDATE tracking_sheets SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1", [s.id]);
      await audit(c, user.id, 'complete_tracking_sheet', 'tracking_sheets', s.id);
      return sheetView(s.id, c);
    });
  },
});

cap({
  name: 'archive_tracking_sheet', method: 'POST', path: '/tracking/sheets/:id/archive', tag: TAG,
  summary: 'Hide a sheet from your list. Nothing is deleted; proposals made from it keep their evidence.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await ownSheet(user, i.id);
    await pool.query("UPDATE tracking_sheets SET status='archived', updated_at=now() WHERE id=$1", [s.id]);
    return { id: s.id, status: 'archived' };
  },
});

cap({
  name: 'list_my_tracking_sheets', method: 'GET', path: '/tracking/sheets', tag: TAG,
  summary: 'Your sheets, newest first (stable order). Filter by sport, status, standalone/linked, proposal state or date range.',
  input: z.object({
    sport: z.string().optional(), status: z.enum(['in_progress', 'completed', 'archived']).optional(), mode: z.enum(['standalone', 'linked']).optional(),
    proposal_state: z.string().optional(), context_type: z.string().optional(), from: z.string().optional(), to: z.string().optional(), ...page,
  }),
  async handler({ user }, i) {
    const where = ['s.owner_id=$1'], vals = [user.id];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (i.sport) add('s.sport_id=?', (await sportOf(i.sport)).id);
    if (i.status) add('s.status=?', i.status); else where.push("s.status <> 'archived'");
    if (i.mode) add('s.mode=?', i.mode);
    if (i.context_type) add('s.context_type=?', i.context_type);
    if (i.from) add('s.occurred_at >= ?', i.from);
    if (i.to) add('s.occurred_at <= ?', i.to);
    if (i.proposal_state) add('EXISTS (SELECT 1 FROM result_proposals p WHERE p.sheet_id=s.id AND p.state=?)', i.proposal_state);
    vals.push(i.limit, i.offset);
    const rows = await many(
      `SELECT s.id, s.ref, s.title, s.mode, s.status, s.provenance, s.labels, s.occurred_at, s.completed_at, s.created_at, s.fixture_id, s.context_type, s.context_id, s.manual_totals,
              sp.name AS sport_name, sp.emoji AS sport_emoji, v.name AS template_name, v.version AS template_version, v.ruleset,
              (SELECT p.state FROM result_proposals p WHERE p.sheet_id=s.id ORDER BY p.created_at DESC LIMIT 1) AS proposal_state
         FROM tracking_sheets s JOIN sports sp ON sp.id=s.sport_id JOIN tracking_sheet_template_versions v ON v.id=s.template_version_id
        WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
    const entries = rows.length ? await many('SELECT sheet_id, seq, kind, side, period, voided_at FROM tracking_sheet_entries WHERE sheet_id = ANY($1) ORDER BY seq', [rows.map((r) => r.id)]) : [];
    return rows.map(({ ruleset, manual_totals, ...r }) => {
      const res = sheetResult(ruleset, entries.filter((e) => e.sheet_id === r.id), manual_totals);
      return { ...r, official: false, label: r.mode === 'linked' ? 'Proposal' : 'Unofficial / standalone', score: res.home == null ? null : { home: res.home, away: res.away } };
    });
  },
});

// Link candidates: games the caller could propose a result for. Hidden (draft/cancelled) events are never shown to outsiders.
cap({
  name: 'find_tracking_link_candidates', method: 'GET', path: '/tracking/link-candidates', tag: TAG,
  summary: 'Games a sheet could be linked to: same sport, around the sheet\'s date, with team names that resemble the sheet\'s labels. The server re-checks everything when you propose; an id alone proves nothing.',
  input: z.object({ sheet_id: id.optional(), sport: z.string().optional(), q: z.string().trim().max(80).optional(), around: z.string().datetime().optional(), days: z.coerce.number().int().min(0).max(30).default(3), limit: z.coerce.number().int().min(1).max(30).default(15) }),
  async handler({ user }, i) {
    let sportId, around = i.around ? new Date(i.around) : new Date(), terms = i.q ? [i.q] : [];
    if (i.sheet_id) {
      const s = await ownSheet(user, i.sheet_id);
      sportId = s.sport_id; around = i.around ? around : new Date(s.occurred_at);
      if (!i.q) terms = [s.labels?.home, s.labels?.away].filter((t) => t && !['Home', 'Away'].includes(t));
    } else if (i.sport) sportId = (await sportOf(i.sport)).id;
    else throw badRequest('Give a sheet or a sport');
    const from = new Date(around.getTime() - i.days * 864e5), to = new Date(around.getTime() + (i.days + 1) * 864e5);
    const rows = await many(
      `SELECT f.id, f.status, f.scheduled_at, f.round, e.id AS event_id, e.name AS event_name, e.kind AS event_kind, h.name AS home_name, a.name AS away_name
         FROM fixtures f JOIN events e ON e.id=f.event_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
        WHERE e.sport_id=$1 AND e.status NOT IN ('draft','cancelled') AND f.status NOT IN ('cancelled','postponed','abandoned') AND f.scheduled_at BETWEEN $2 AND $3
          AND ($4::text[] IS NULL OR cardinality($4::text[])=0 OR EXISTS (SELECT 1 FROM unnest($4::text[]) t WHERE h.name ILIKE '%'||t||'%' OR a.name ILIKE '%'||t||'%' OR e.name ILIKE '%'||t||'%'))
        ORDER BY abs(extract(epoch FROM f.scheduled_at - $5::timestamptz)), f.id LIMIT $6`, [sportId, from, to, terms.length ? terms : null, around, i.limit]);
    const out = [];
    for (const r of rows) {
      const x = await fixtureContext(user, r.id, null);
      const taken = await one("SELECT state FROM result_proposals WHERE fixture_id=$1 AND state IN ('proposed','under_review','changes_requested','approved','disputed') LIMIT 1", [r.id]);
      out.push({ ...r, can_review: x.canScore || !!x.side, open_proposal: taken?.state ?? null });
    }
    return out;
  },
});
