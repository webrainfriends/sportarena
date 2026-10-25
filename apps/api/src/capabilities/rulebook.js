// Tools > Sport rules: the standard rulebook for each sport as readable cards, and local rules (a competition's own settings, kept as
// immutable versions). The standard text is code (rulebook/catalog.js) and is never edited; a local rule set only stores what differs.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin } from '../helpers.js';
import { docHeaders } from '../doc-store.js';
import { orgRole } from '../org-access.js';
import { renderRulebook } from '../documents/render.js';
import { BOOKS, bookFor } from '../rulebook/catalog.js';
import { cleanValues, resolveBook, standardHash } from '../rulebook/apply.js';

const TAG = 'Tools';
const q = (c) => c ?? pool;
const ORG_WRITE = ['owner', 'admin', 'coach'];
const TEAM_WRITE = ['captain', 'coach', 'manager'];

const sportRow = async (slug, c) => (await q(c).query('SELECT id, slug, name, emoji FROM sports WHERE slug=$1 OR id::text=$1', [slug])).rows[0] ?? null;

/** May this user read a local rule set? Personal: its owner. Organisation/team: members. Event: anyone who can see the event. */
export async function canReadSet(user, s, c) {
  if (isAdmin(user) || s.owner_user_id === user.id) return true;
  if (s.scope === 'organisation') return !!(await orgRole(user, s.organisation_id, c));
  if (s.scope === 'team') return (await q(c).query("SELECT 1 FROM teams t WHERE t.id=$1 AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$2 AND m.status='active'))", [s.team_id, user.id])).rowCount > 0;
  if (s.scope === 'event') return (await q(c).query("SELECT 1 FROM events e WHERE e.id=$1 AND (e.status <> 'draft' OR e.organizer_id=$2)", [s.event_id, user.id])).rowCount > 0;
  return false;
}

/** May this user publish local rules at this scope? Resolved from real membership, never from a role the client names. */
async function canWriteScope(user, scope, ref, c) {
  if (scope === 'personal') return true;
  if (isAdmin(user)) return true;
  if (scope === 'organisation') return ORG_WRITE.includes(await orgRole(user, ref, c));
  if (scope === 'team') return (await q(c).query("SELECT 1 FROM teams t WHERE t.id=$1 AND (t.owner_id=$2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$2 AND m.status='active' AND m.role = ANY($3)))", [ref, user.id, TEAM_WRITE])).rowCount > 0;
  if (scope === 'event') return (await q(c).query('SELECT 1 FROM events e WHERE e.id=$1 AND e.organizer_id=$2', [ref, user.id])).rowCount > 0;
  return false;
}

export async function setView(setId, c) {
  const s = (await q(c).query(
    `SELECT s.*, sp.slug AS sport_slug, sp.name AS sport_name, sp.emoji AS sport_emoji, u.display_name AS owner_name,
            o.name AS organisation_name, t.name AS team_name, e.name AS event_name
       FROM local_rule_sets s JOIN sports sp ON sp.id=s.sport_id JOIN users u ON u.id=s.owner_user_id
       LEFT JOIN organisations o ON o.id=s.organisation_id LEFT JOIN teams t ON t.id=s.team_id LEFT JOIN events e ON e.id=s.event_id WHERE s.id=$1`, [setId])).rows[0];
  if (!s) throw notFound('Local rules');
  const versions = (await q(c).query('SELECT id, version, settings, base_hash, note, published_at, published_by FROM local_rule_versions WHERE set_id=$1 ORDER BY version DESC', [setId])).rows;
  return { ...s, versions, current: versions.find((v) => v.version === s.current_version) ?? null };
}

/** The settings a set was last published with (empty for a set with no published version yet). */
export const currentSettings = (s) => s.current?.settings ?? {};

async function readable(user, setId, c) {
  const s = (await q(c).query('SELECT * FROM local_rule_sets WHERE id=$1', [setId])).rows[0];
  if (!s || !(await canReadSet(user, s, c))) throw notFound('Local rules'); // never confirm that a private set exists
  return s;
}
export { readable as readableLocalRules };

// ------------------------------------------------------------------ the rulebook
cap({
  name: 'list_rulebooks', method: 'GET', path: '/rulebook', tag: TAG,
  summary: 'The standard rulebooks SportArena has for each supported sport, with the governing body and a link to its official book. Anyone signed in can read them.',
  async handler({ user }) {
    const mine = await many("SELECT sp.slug, count(*)::int AS n FROM local_rule_sets s JOIN sports sp ON sp.id=s.sport_id WHERE s.owner_user_id=$1 AND s.status='active' GROUP BY sp.slug", [user.id]);
    const count = Object.fromEntries(mine.map((r) => [r.slug, r.n]));
    const sports = await many('SELECT slug, name, emoji FROM sports WHERE slug = ANY($1) ORDER BY name', [Object.keys(BOOKS)]);
    return sports.map((s) => ({ slug: s.slug, name: BOOKS[s.slug].name, emoji: BOOKS[s.slug].emoji ?? s.emoji, body: BOOKS[s.slug].body, official_url: BOOKS[s.slug].official_url, formats: BOOKS[s.slug].formats ?? null, cards: BOOKS[s.slug].cards.length, my_local_sets: count[s.slug] ?? 0 }));
  },
});

cap({
  name: 'get_rulebook', method: 'GET', path: '/rulebook/:sport', tag: TAG,
  summary: 'One sport\'s rulebook as cards. With local_id the cards show that local rule set\'s values and mark every change against the standard.',
  input: z.object({ sport: z.string().min(1), format: z.string().max(20).optional(), local_id: id.optional() }),
  async handler({ user }, i) {
    const sp = await sportRow(i.sport);
    let b = sp && bookFor(sp.slug, i.format);
    if (!b) throw notFound('Rulebook');
    let values = {}, local = null;
    if (i.local_id) {
      const s = await readable(user, i.local_id);
      if (s.sport_id !== sp.id) throw badRequest('These local rules are for a different sport');
      const view = await setView(s.id);
      local = { id: s.id, name: s.name, scope: s.scope, version: view.current_version, status: s.status };
      values = currentSettings(view);
      if (s.format) b = bookFor(sp.slug, s.format); // the set was made for one format
    }
    return { ...resolveBook(b.slug, b.format, values), sport: { id: sp.id, slug: sp.slug }, local };
  },
});

// ------------------------------------------------------------------ local rules
cap({
  name: 'list_local_rules', method: 'GET', path: '/local-rules', tag: TAG,
  summary: 'Local rule sets you can use: yours, your organisations\' and teams\', and an event\'s when you give event_id.',
  input: z.object({ sport: z.string().optional(), event_id: id.optional(), include_retired: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const vals = [user.id], where = [];
    if (i.sport) { const sp = await sportRow(i.sport); if (!sp) throw notFound('Sport'); vals.push(sp.id); where.push(`s.sport_id=$${vals.length}`); }
    if (!i.include_retired) where.push("s.status='active'");
    vals.push(i.event_id ?? null);
    const rows = await many(
      `SELECT s.id, s.name, s.scope, s.format, s.status, s.current_version, s.updated_at, sp.slug AS sport_slug, sp.name AS sport_name, sp.emoji AS sport_emoji,
              s.owner_user_id, s.organisation_id, s.team_id, s.event_id, o.name AS organisation_name, t.name AS team_name, e.name AS event_name,
              (SELECT settings FROM local_rule_versions v WHERE v.set_id=s.id AND v.version=s.current_version) AS settings
         FROM local_rule_sets s JOIN sports sp ON sp.id=s.sport_id LEFT JOIN organisations o ON o.id=s.organisation_id LEFT JOIN teams t ON t.id=s.team_id LEFT JOIN events e ON e.id=s.event_id
        WHERE ${where.length ? `${where.join(' AND ')} AND ` : ''}(
              s.owner_user_id=$1
           OR (s.scope='organisation' AND s.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active'))
           OR (s.scope='team' AND (s.team_id IN (SELECT team_id FROM team_members WHERE user_id=$1 AND status='active') OR s.team_id IN (SELECT id FROM teams WHERE owner_id=$1)))
           OR (s.scope='event' AND s.event_id=$${vals.length}::uuid AND EXISTS (SELECT 1 FROM events ev WHERE ev.id=s.event_id AND (ev.status <> 'draft' OR ev.organizer_id=$1))))
        ORDER BY s.name, s.id`, vals);
    return rows.map((r) => ({ ...r, changes: Object.keys(r.settings ?? {}).length }));
  },
});

cap({
  name: 'get_local_rules', method: 'GET', path: '/local-rules/:id', tag: TAG,
  summary: 'A local rule set with every published version.',
  input: z.object({ id }),
  async handler({ user }, i) { await readable(user, i.id); return setView(i.id); },
});

cap({
  name: 'publish_local_rules', method: 'POST', path: '/local-rules', tag: TAG, status: 201,
  summary: 'Localise a sport\'s rulebook: publish the settings a competition, club, team or you change, as a new immutable version. Give set_id to publish a new version of an existing set. Only settings that differ from the standard are kept. Scope event needs the event organiser, organisation an owner/admin/coach, team its captain/coach/manager.',
  input: z.object({
    set_id: id.optional(), sport: z.string().min(1).optional(), format: z.string().max(20).optional(),
    scope: z.enum(['personal', 'organisation', 'team', 'event']).default('personal'), organisation_id: id.optional(), team_id: id.optional(), event_id: id.optional(),
    name: z.string().trim().min(2).max(80).optional(), settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])), note: z.string().trim().max(300).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      let set;
      if (i.set_id) {
        set = (await c.query('SELECT * FROM local_rule_sets WHERE id=$1 FOR UPDATE', [i.set_id])).rows[0];
        if (!set || !(await canReadSet(user, set, c))) throw notFound('Local rules');
        if (set.status === 'retired') throw conflict('These local rules are retired. Start a new set.');
        if (!(await canWriteScope(user, set.scope, set.organisation_id ?? set.team_id ?? set.event_id, c))) throw forbidden('You cannot publish rules for this scope');
        if (set.scope === 'personal' && set.owner_user_id !== user.id && !isAdmin(user)) throw forbidden('Only the owner can publish these rules');
      } else {
        if (!i.sport || !i.name) throw badRequest('Give the sport and a name for the new local rules');
        const sp = await sportRow(i.sport, c); if (!sp) throw notFound('Sport');
        const b = bookFor(sp.slug, i.format); if (!b) throw badRequest('This sport has no rulebook to localise yet');
        const ref = { personal: null, organisation: i.organisation_id, team: i.team_id, event: i.event_id }[i.scope];
        if (i.scope !== 'personal' && !ref) throw badRequest(`Give the ${i.scope} these rules are for`);
        if (!(await canWriteScope(user, i.scope, ref, c))) throw forbidden(i.scope === 'event' ? 'Only the event organiser can publish rules for an event' : 'You cannot publish rules for this scope');
        if (i.scope === 'event') {
          const ev = await c.query('SELECT sport_id FROM events WHERE id=$1', [ref]);
          if (!ev.rowCount) throw notFound('Event');
          if (ev.rows[0].sport_id !== sp.id) throw badRequest('That event is for a different sport');
        }
        set = (await c.query(
          `INSERT INTO local_rule_sets(sport_id, format, scope, owner_user_id, organisation_id, team_id, event_id, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [sp.id, b.format, i.scope, user.id, i.scope === 'organisation' ? ref : null, i.scope === 'team' ? ref : null, i.scope === 'event' ? ref : null, i.name])).rows[0];
      }
      const sp = (await c.query('SELECT slug FROM sports WHERE id=$1', [set.sport_id])).rows[0];
      const clean = cleanValues(sp.slug, set.format, i.settings);
      if (!clean.ok) throw badRequest(clean.error);
      const prev = set.current_version ? (await c.query('SELECT settings FROM local_rule_versions WHERE set_id=$1 AND version=$2', [set.id, set.current_version])).rows[0] : null;
      if (prev && JSON.stringify(prev.settings, Object.keys(prev.settings).sort()) === JSON.stringify(clean.values, Object.keys(clean.values).sort())) return setView(set.id, c); // same values again: no new version
      const version = set.current_version + 1;
      await c.query('INSERT INTO local_rule_versions(set_id, version, settings, base_hash, note, published_by) VALUES ($1,$2,$3,$4,$5,$6)', [set.id, version, JSON.stringify(clean.values), standardHash(sp.slug, set.format), i.note ?? null, user.id]);
      await c.query('UPDATE local_rule_sets SET current_version=$2, updated_at=now() WHERE id=$1', [set.id, version]);
      await audit(c, user.id, 'publish_local_rules', 'local_rule_sets', set.id);
      return setView(set.id, c);
    });
  },
});

cap({
  name: 'retire_local_rules', method: 'POST', path: '/local-rules/:id/retire', tag: TAG,
  summary: 'Stop offering a local rule set for new sheets. Published versions and sheets already started under them are untouched.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await readable(user, i.id);
    if (!(await canWriteScope(user, s.scope, s.organisation_id ?? s.team_id ?? s.event_id, null)) || (s.scope === 'personal' && s.owner_user_id !== user.id && !isAdmin(user))) throw forbidden('You cannot retire these rules');
    await pool.query("UPDATE local_rule_sets SET status='retired', updated_at=now() WHERE id=$1", [s.id]);
    await audit(null, user.id, 'retire_local_rules', 'local_rule_sets', s.id);
    return { id: s.id, status: 'retired' };
  },
});

/** Binary route: the rulebook as a PDF to print or hand out, optionally with a local rule set applied. */
export function rulebookRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  // GET /api/v1/rulebook/:sport/pdf?format=&local_id=
  r.get('/rulebook/:sport/pdf', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization); if (!user) throw unauthorized();
      const sp = await sportRow(String(req.params.sport));
      const b = sp && bookFor(sp.slug, req.query.format ? String(req.query.format) : undefined);
      if (!b) throw notFound('Rulebook');
      let values = {}, local = null;
      if (req.query.local_id) {
        const lid = String(req.query.local_id); if (!/^[0-9a-f-]{36}$/.test(lid)) throw notFound('Local rules');
        const s = await readable(user, lid);
        if (s.sport_id !== sp.id) throw badRequest('These local rules are for a different sport');
        const view = await setView(s.id);
        values = currentSettings(view); local = { name: s.name, scope: s.scope, version: s.current_version, by: view.owner_name };
      }
      const book = resolveBook(b.slug, b.format, values);
      const { buffer } = await renderRulebook({ book, local });
      await audit(null, user.id, 'generate_rulebook_pdf', 'sports', sp.id);
      res.set(docHeaders('application/pdf', buffer)).set('Content-Disposition', `inline; filename="${b.slug}-rulebook.pdf"`);
      res.end(buffer);
    } catch (e) { fail(res, e); }
  });
  return r;
}
