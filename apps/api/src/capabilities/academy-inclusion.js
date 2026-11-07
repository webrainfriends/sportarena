// Inclusive & adaptive academy programmes (#808). One definition -> REST + OpenAPI + MCP. The rules live in src/inclusion.js.
// Nothing here asks for, stores or shows a diagnosis. Programmes state what they offer; athletes (or verified guardians) share minimal operational
// flags with a named audience and an expiry; staff read only what was shared with them, every read is logged; directors see counts.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one } from '../db.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { opsAccess, sessionFor, heldVenue } from '../academy-ops.js';
import { mustManage } from '../booking/engine.js';
import { badgesFor } from '../verification.js';
import { orgFor } from '../org-access.js';
import {
  NEED_TYPES, VENUE_FEATURES, ELIGIBILITY, VARIANTS, LEVELS, AUDIENCE_ROLES, SHARE_MONTHS_MAX, SPORT_TEMPLATES, SCHEMES, NEED_TO_FEATURE, NEEDS_SUPPORT, MIN_GROUP, suppress, PURPOSE_KEYS, SHARE_CONTEXTS,
  catalogue, checkNeeds, typeOfNeed, sealNote, unsealNote, log, liveShares, shareIsLive, inAudience, actingFor, enrolled, badRequest, conflict, forbidden, notFound, isYouth, guardianLink,
} from '../inclusion.js';

const TAG = 'Academy inclusion';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const programmeFor = async (programmeId, c) => {
  const p = (await (c ?? { query: (q, a) => many(q, a).then((rows) => ({ rows })) }).query('SELECT id, organisation_id, sport, title FROM academy_programmes WHERE id=$1', [programmeId])).rows[0];
  if (!p) throw notFound('Programme');
  return p;
};
/** Known to the academy: enrolled, or has applied. Nobody else may be the subject of a share. */
const knownTo = async (c, orgId, athleteId) => (await enrolled(c, orgId, athleteId)) || !!(await c.query('SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 LIMIT 1', [orgId, athleteId])).rowCount;
const needLabelKeys = (keys) => keys.map((k) => ({ key: k, type: typeOfNeed(k) }));

// ------------------------------------------------------------------------------------------------------------------ catalogue + programme setup
cap({
  name: 'get_inclusion_catalogue', method: 'GET', path: '/academy/inclusion/catalogue', tag: TAG, auth: 'public',
  summary: 'The vocabulary for inclusive programmes: adjustment types and keys, venue access features, eligibility modes, pathway variants, descriptor levels, class schemes and the sport adaptation templates (a sport without its own template is served by one that says fallback: true). Reference data, no personal data.',
  async handler() { return catalogue(); },
});

const reqShape = z.object({
  venue_features: z.array(z.enum(VENUE_FEATURES)).max(12).default([]), staff_credential: z.string().trim().max(40).optional(), support_ratio: z.number().int().min(1).max(20).optional(),
  duty_cover: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
});

cap({
  name: 'save_programme_inclusion', method: 'PATCH', path: '/academy/programmes/:id/inclusion', tag: TAG,
  summary: 'Set a programme\'s inclusion profile (owner/admin or schedule permission): eligibility mode, accepted class schemes, sport adaptation templates, the adjustments offered to applicants, resource requirements (venue features, staff credential, support-person ratio, duty cover) and pathway alternatives. No diagnosis is ever collected. Send row_version when updating.',
  input: z.object({
    id, row_version: z.number().int().min(0).default(0), eligibility_mode: z.enum(ELIGIBILITY).default('open'), class_schemes: z.array(z.string().max(40)).max(40).default([]),
    sport_templates: z.array(z.enum(Object.keys(SPORT_TEMPLATES))).max(10).default([]), offered_needs: z.array(z.string().max(40)).max(40).default([]), requirements: reqShape.default({}),
    pathway_variants: z.array(z.enum(VARIANTS)).min(1).max(3).default(['standard']),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await programmeFor(i.id, c);
      const a = await opsAccess(user, p.organisation_id, { write: true, c });
      if (!a.admin && !a.hasBroad('schedule')) throw forbidden('Only an owner, admin or schedule manager can set a programme\'s inclusion profile');
      for (const s of i.class_schemes) if (!SCHEMES.includes(s)) throw badRequest(`Unknown class scheme: ${s}`);
      const needs = checkNeeds(i.offered_needs);
      if (i.eligibility_mode === 'class_required' && !i.class_schemes.length) throw badRequest('Choose at least one accepted class scheme when a classification is required');
      const cur = (await c.query('SELECT * FROM academy_programme_inclusion WHERE programme_id=$1 FOR UPDATE', [p.id])).rows[0];
      let row;
      if (!cur) row = (await c.query('INSERT INTO academy_programme_inclusion(programme_id, organisation_id, eligibility_mode, class_schemes, sport_templates, offered_needs, requirements, pathway_variants, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [p.id, p.organisation_id, i.eligibility_mode, i.class_schemes, i.sport_templates, needs, JSON.stringify(i.requirements), i.pathway_variants, user.id])).rows[0];
      else {
        if (cur.row_version !== i.row_version) throw conflict('This profile changed since you opened it. Reload and try again.', { code: 'stale_row_version', row_version: cur.row_version });
        row = (await c.query('UPDATE academy_programme_inclusion SET eligibility_mode=$2, class_schemes=$3, sport_templates=$4, offered_needs=$5, requirements=$6, pathway_variants=$7, version=version+1, row_version=row_version+1, updated_by=$8, updated_at=now() WHERE programme_id=$1 RETURNING *',
          [p.id, i.eligibility_mode, i.class_schemes, i.sport_templates, needs, JSON.stringify(i.requirements), i.pathway_variants, user.id])).rows[0];
      }
      await log(c, p.organisation_id, null, cur ? 'programme_inclusion_changed' : 'programme_inclusion_set', user.id, { type: 'programme', id: p.id }, `v${row.version}`);
      await audit(c, user.id, 'save_programme_inclusion', 'academy_programme_inclusion', p.id);
      return { ...row, fallback_templates: row.sport_templates.filter((t) => SPORT_TEMPLATES[t]?.fallback) };
    });
  },
});

cap({
  name: 'get_programme_inclusion', method: 'GET', path: '/academy/programmes/:id/inclusion', tag: TAG,
  summary: 'A programme\'s inclusion profile (any member of the academy). Empty (version 0) until first saved.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await programmeFor(i.id);
    await orgFor(user, p.organisation_id);
    const r = await one('SELECT * FROM academy_programme_inclusion WHERE programme_id=$1', [p.id]);
    return r ?? { programme_id: p.id, organisation_id: p.organisation_id, eligibility_mode: 'open', class_schemes: [], sport_templates: [], offered_needs: [], requirements: {}, pathway_variants: ['standard'], version: 0, row_version: 0 };
  },
});

cap({
  name: 'get_programme_adjustments', method: 'GET', path: '/academy/programmes/:id/adjustments', tag: TAG, auth: 'public',
  summary: 'For applicants: the adjustments a published programme offers and how it admits (open, class optional or required, mixed ability). Never asks for or shows a diagnosis; no internal data.',
  input: z.object({ id }),
  async handler(_, i) {
    const r = await one("SELECT p.id, p.title, pi.eligibility_mode, pi.class_schemes, pi.offered_needs, pi.pathway_variants FROM academy_programmes p LEFT JOIN academy_programme_inclusion pi ON pi.programme_id=p.id WHERE p.id=$1 AND p.status='published' AND p.public", [i.id]);
    if (!r) throw notFound('Programme');
    return { programme_id: r.id, title: r.title, eligibility_mode: r.eligibility_mode ?? 'open', class_schemes: r.class_schemes ?? [], offered: needLabelKeys(r.offered_needs ?? []), pathway_variants: r.pathway_variants ?? ['standard'] };
  },
});

// ------------------------------------------------------------------------------------------------------------------ venue access
cap({
  name: 'set_venue_access_feature', method: 'POST', path: '/venues/:id/access-features', tag: TAG,
  summary: 'Venue manager: record that the venue has (present: true) or no longer has (false) an access feature such as a lift, step-free route, accessible changing room or pool hoist. Retired features are kept, never deleted.',
  input: z.object({ id, feature: z.enum(VENUE_FEATURES), present: z.boolean() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    return tx(async (c) => {
      const live = (await c.query('SELECT id FROM academy_venue_access_features WHERE venue_id=$1 AND feature=$2 AND retired_at IS NULL', [i.id, i.feature])).rows[0];
      if (i.present && !live) await c.query('INSERT INTO academy_venue_access_features(venue_id, feature, verified_by) VALUES ($1,$2,$3)', [i.id, i.feature, user.id]);
      if (!i.present && live) await c.query('UPDATE academy_venue_access_features SET retired_at=now() WHERE id=$1', [live.id]);
      await audit(c, user.id, 'set_venue_access_feature', 'venues', i.id);
      return { venue_id: i.id, features: (await c.query('SELECT feature FROM academy_venue_access_features WHERE venue_id=$1 AND retired_at IS NULL ORDER BY feature', [i.id])).rows.map((r) => r.feature) };
    });
  },
});

cap({
  name: 'list_venue_access_features', method: 'GET', path: '/venues/:id/access-features', tag: TAG,
  summary: 'The access features a venue has recorded (any signed-in user). Venue facts, no personal data.',
  input: z.object({ id }),
  async handler(_, i) {
    if (!(await one('SELECT 1 AS x FROM venues WHERE id=$1', [i.id]))) throw notFound('Venue');
    return { venue_id: i.id, features: (await many('SELECT feature, verified_at FROM academy_venue_access_features WHERE venue_id=$1 AND retired_at IS NULL ORDER BY feature', [i.id])) };
  },
});

// ------------------------------------------------------------------------------------------------------------------ the athlete's own shares
const shareView = (s, live, views) => ({ id: s.id, organisation_id: s.organisation_id, athlete_id: s.athlete_id, needs: needLabelKeys(s.need_keys), note: unsealNote(s.note_enc, 'note'), audience_user_ids: s.audience_users, audience_roles: s.audience_roles, expires_at: s.expires_at, revoked_at: s.revoked_at, granted_as: s.granted_as, status: s.revoked_at ? 'revoked' : !live ? 'lapsed' : 'active', viewed_count: views, context: s.context ?? 'academy', event_id: s.event_id ?? null, purpose_key: s.purpose_key ?? null, purpose: s.purpose ?? null });

cap({
  name: 'share_accommodation', method: 'POST', path: '/me/accommodations', tag: TAG, status: 201,
  summary: 'Share minimal operational needs (equipment, access, support person, transport, communication, schedule) with named staff and/or the coach and venue of your sessions, until a date you choose. An adult decides for themself; a verified guardian with the consent scope decides for a young person. No diagnosis is asked for; an optional short note is screened for clinical content and encrypted. You can revoke at any time.',
  input: z.object({
    organisation_id: id, athlete_id: id.optional(), need_keys: z.array(z.string().max(40)).min(1).max(12), note: z.string().trim().max(300).optional(),
    audience_user_ids: z.array(id).max(20).default([]), audience_roles: z.array(z.enum(AUDIENCE_ROLES)).max(3).default([]), expires_on: day,
    context: z.enum(SHARE_CONTEXTS).default('academy'),
    event_id: id.optional(),
    purpose_key: z.enum(PURPOSE_KEYS).optional(),
    purpose: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      const as = await actingFor(c, user, athleteId, 'consent');
      if (!(await knownTo(c, i.organisation_id, athleteId))) throw notFound('Academy');
      const needs = checkNeeds(i.need_keys);
      if (!i.audience_user_ids.length && !i.audience_roles.length) throw badRequest('Choose who may see this: named staff, the coach or the venue');
      if (i.expires_on <= today() || i.expires_on > plusDays(SHARE_MONTHS_MAX * 31)) throw badRequest(`Choose an expiry date within the next ${SHARE_MONTHS_MAX} months`);
      if (i.context === 'event' && !i.event_id) throw badRequest('Provide an event_id when context is event');
      if (i.event_id) {
        const ev = await c.query("SELECT 1 FROM events WHERE id=$1", [i.event_id]);
        if (!ev.rowCount) throw badRequest('Event not found');
      }
      if (i.audience_roles.includes('event_staff') && i.context !== 'event') throw badRequest('event_staff audience requires event context');
      for (const u of i.audience_user_ids) {
        const ok = await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.organisation_id, u]);
        if (!ok.rowCount) throw badRequest('Everyone named must be an active member of this academy');
      }
      const row = (await c.query(
        'INSERT INTO academy_accommodation_shares(organisation_id, athlete_id, need_keys, note_enc, audience_users, audience_roles, granted_by, granted_as, expires_at, context, event_id, purpose_key, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [i.organisation_id, athleteId, needs, sealNote(i.note, 'note'), i.audience_user_ids, i.audience_roles, user.id, as, `${i.expires_on}T23:59:59Z`, i.context, i.event_id ?? null, i.purpose_key ?? null, i.purpose ?? null],
      )).rows[0];
      await log(c, i.organisation_id, athleteId, 'share_granted', user.id, { type: 'share', id: row.id }, needs.map(typeOfNeed).join(','));
      for (const u of i.audience_user_ids) await notify(c, u, { kind: 'academy_inclusion', title: 'An athlete shared an operational need with you', body: 'Open the session in Gotmygame to see what was shared with you.', data: { organisation_id: i.organisation_id }, dedupe_key: `incl:share:${row.id}:${u}` });
      await audit(c, user.id, 'share_accommodation', 'academy_accommodation_shares', row.id);
      return shareView(row, true, 0);
    });
  },
});

cap({
  name: 'list_my_accommodations', method: 'GET', path: '/me/accommodations', tag: TAG,
  summary: 'What you (or the young person you are the verified guardian of) have shared: each share with its audience, expiry, whether it is still live, how many times staff opened it, and the transparency log.',
  input: z.object({ organisation_id: id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id && !(await guardianLink(user.id, athleteId))) throw notFound('Person');
    const rows = await many('SELECT * FROM academy_accommodation_shares WHERE organisation_id=$1 AND athlete_id=$2 ORDER BY created_at DESC, id LIMIT 100', [i.organisation_id, athleteId]);
    const out = [];
    for (const r of rows) {
      const views = Number((await one("SELECT count(*) AS n FROM academy_inclusion_events WHERE ref_type='share' AND ref_id=$1 AND kind='share_viewed'", [r.id])).n);
      out.push(shareView(r, await shareIsLive({ query: (q, a) => many(q, a).then((x) => ({ rows: x })) }, r), views));
    }
    const events = await many("SELECT kind, actor_id, ref_id, detail, created_at FROM academy_inclusion_events WHERE organisation_id=$1 AND athlete_id=$2 ORDER BY id DESC LIMIT 50", [i.organisation_id, athleteId]);
    return { shares: out, log: events, active: out.filter((s) => s.status === 'active').length, expiring_30d: out.filter((s) => s.status === 'active' && new Date(s.expires_at) < new Date(Date.now() + 30 * 864e5)).length };
  },
});

cap({
  name: 'list_inclusion_audience', method: 'GET', path: '/me/accommodations/audience', tag: TAG,
  summary: 'The academy staff an athlete (or their guardian) may name when sharing: active members with a coaching, staff or owner role, name and role only.',
  input: z.object({ organisation_id: id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      await actingFor(c, user, athleteId, 'consent');
      if (!(await knownTo(c, i.organisation_id, athleteId))) throw notFound('Academy');
      return (await c.query("SELECT m.user_id, u.display_name, m.role FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('owner','admin','coach','staff') ORDER BY u.display_name, m.user_id LIMIT 200", [i.organisation_id])).rows;
    });
  },
});

cap({
  name: 'revoke_accommodation', method: 'POST', path: '/accommodations/:id/revoke', tag: TAG,
  summary: 'Withdraw a share immediately. Staff lose access on their next call. Only the person who may decide for the athlete can do this; the share and its history are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM academy_accommodation_shares WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Share');
      try { await actingFor(c, user, s.athlete_id, 'consent'); } catch { throw notFound('Share'); }
      if (!s.revoked_at) await c.query('UPDATE academy_accommodation_shares SET revoked_at=now(), revoked_by=$2 WHERE id=$1', [s.id, user.id]);
      await log(c, s.organisation_id, s.athlete_id, 'share_revoked', user.id, { type: 'share', id: s.id });
      await audit(c, user.id, 'revoke_accommodation', 'academy_accommodation_shares', s.id);
      return { id: s.id, status: 'revoked' };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ frontline staff
cap({
  name: 'get_session_accommodations', method: 'GET', path: '/academy/sessions/:id/accommodations', tag: TAG,
  summary: 'Frontline view for one session: for each enrolled athlete, only the live operational flags that athlete (or their guardian) shared with YOU (named, or as the session coach / venue manager). Directors without an audience place see nothing here. Diagnosis and medical detail do not exist in this domain. Every read is logged and visible to the athlete.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { s } = await sessionFor(user, i.id, 'view', { c });
      const ath = (await c.query("SELECT e.user_id, u.display_name FROM org_enrolments e JOIN users u ON u.id=e.user_id WHERE e.cohort_id=$1 AND e.status IN ('enrolled','paused') ORDER BY u.display_name, u.id", [s.cohort_id])).rows;
      const athletes = [];
      for (const a of ath) {
        const mine = [];
        for (const sh of await liveShares(c, s.organisation_id, a.user_id)) if (await inAudience(c, sh, user.id, s)) mine.push(sh);
        if (!mine.length) continue;
        athletes.push({ athlete_id: a.user_id, athlete_name: a.display_name, needs: needLabelKeys([...new Set(mine.flatMap((m) => m.need_keys))]), notes: mine.map((m) => unsealNote(m.note_enc, 'note')).filter(Boolean), expires_at: mine.reduce((x, m) => (x < m.expires_at ? x : m.expires_at), mine[0].expires_at) });
        for (const m of mine) await log(c, s.organisation_id, a.user_id, 'share_viewed', user.id, { type: 'share', id: m.id }, `session:${s.id}`);
      }
      return { session_id: s.id, athletes };
    });
  },
});

/** Requirements -> coverage for one session, from canonical sources: the programme's profile, the athletes' live shares (counts only), the held venue's access features and the session's staff. */
export async function readiness(c, s) {
  const profile = s.programme_id ? (await c.query('SELECT * FROM academy_programme_inclusion WHERE programme_id=$1', [s.programme_id])).rows[0] : null;
  const req = profile?.requirements ?? {};
  const ath = (await c.query("SELECT e.user_id FROM org_enrolments e WHERE e.cohort_id=$1 AND e.status IN ('enrolled','paused')", [s.cohort_id])).rows;
  const needs = new Map();
  let withNeeds = 0;
  for (const a of ath) {
    const sh = await liveShares(c, s.organisation_id, a.user_id);
    if (!sh.length) continue;
    withNeeds++;
    for (const k of new Set(sh.flatMap((x) => x.need_keys))) needs.set(k, (needs.get(k) ?? 0) + 1);
  }
  const venue = await heldVenue(c, s.id);
  const have = venue ? new Set((await c.query('SELECT feature FROM academy_venue_access_features WHERE venue_id=$1 AND retired_at IS NULL', [venue.venue_id])).rows.map((r) => r.feature)) : new Set();
  const staff = (await c.query("SELECT user_id, role, duty_label FROM academy_session_staff WHERE session_id=$1 AND status IN ('assigned','confirmed')", [s.id])).rows;
  const rows = [];
  const add = (code, state, detail = {}) => rows.push({ code, state, ...detail });
  const features = [...new Set([...(req.venue_features ?? []), ...[...needs.keys()].map((k) => NEED_TO_FEATURE[k]).filter(Boolean)])];
  for (const f of features) add(`venue_${f}`, !venue ? 'gap' : have.has(f) ? 'met' : 'gap', { kind: 'venue_feature', feature: f, venue_booked: !!venue });
  const supportAth = [...needs.entries()].filter(([k]) => NEEDS_SUPPORT.includes(k)).reduce((n, [, v]) => Math.max(n, v), 0);
  const supportNeeded = Math.max(supportAth, req.support_ratio && withNeeds ? Math.ceil(withNeeds / req.support_ratio) : 0);
  if (supportNeeded) { const got = staff.filter((x) => x.duty_label === 'support_person').length; add('support_persons', got >= supportNeeded ? 'met' : 'short', { kind: 'support', needed: supportNeeded, assigned: got }); }
  for (const d of req.duty_cover ?? []) add(`duty_${d}`, staff.some((x) => x.duty_label === d) ? 'met' : 'gap', { kind: 'duty', duty: d });
  if (req.staff_credential) {
    const lead = staff.find((x) => x.role === 'lead');
    const badges = lead ? await badgesFor('user', [lead.user_id]) : new Map();
    const ok = lead && (badges.get(lead.user_id) ?? []).some((b) => b.type === req.staff_credential && new Date(b.expires_at) > new Date(s.starts_at));
    add('staff_credential', ok ? 'met' : 'gap', { kind: 'credential', credential: req.staff_credential });
  }
  const equip = [...needs.entries()].filter(([k]) => typeOfNeed(k) === 'equipment').reduce((n, [, v]) => n + v, 0);
  if (equip) add('equipment', 'manual', { kind: 'equipment', athletes: equip });
  const level = rows.some((x) => x.state === 'gap') ? 'gap' : rows.some((x) => x.state === 'short') ? 'attention' : 'ready';
  return { session_id: s.id, level, athletes_with_needs: withNeeds, enrolled: ath.length, requirements: rows };
}

cap({
  name: 'get_session_readiness', method: 'GET', path: '/academy/sessions/:id/readiness', tag: TAG,
  summary: 'Adaptive-session readiness: the programme\'s requirements and the live needs shared by enrolled athletes (counts only, no names or types per person) checked against the venue\'s access features, assigned staff, support persons, duty cover and the lead coach\'s verified credential. state is met | short | gap | manual (equipment is confirmed in the Kit desk).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => { const { s } = await sessionFor(user, i.id, 'view', { c }); return readiness(c, s); });
  },
});

// ------------------------------------------------------------------------------------------------------------------ director overview + athlete strip
cap({
  name: 'get_inclusion_overview', method: 'GET', path: '/organisations/:id/academy/inclusion', tag: TAG,
  summary: 'Director view (owner/admin or schedule permission): adaptive programmes, athletes with live shares, shares expiring in 30 days, adjustment types in use, upcoming sessions with a gap (next 14 days) and classifications due for review. Counts only; any figure for a group under 5 is withheld (null).',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.id, { c });
      if (!a.admin && !a.hasBroad('schedule')) throw forbidden('You do not have access to the academy inclusion overview');
      const live = (await c.query("SELECT * FROM academy_accommodation_shares WHERE organisation_id=$1 AND revoked_at IS NULL AND expires_at > now()", [i.id])).rows;
      const liveOk = []; for (const r of live) if (await shareIsLive(c, r)) liveOk.push(r);
      const athletes = new Set(liveOk.map((r) => r.athlete_id)).size;
      const byType = {};
      for (const t of Object.keys(NEED_TYPES)) byType[t] = suppress(new Set(liveOk.filter((r) => r.need_keys.some((k) => typeOfNeed(k) === t)).map((r) => r.athlete_id)).size);
      const expiring = suppress(liveOk.filter((r) => new Date(r.expires_at) < new Date(Date.now() + 30 * 864e5)).length);
      const progs = (await c.query("SELECT p.id, p.title, p.sport, pi.eligibility_mode, pi.version FROM academy_programme_inclusion pi JOIN academy_programmes p ON p.id=pi.programme_id WHERE pi.organisation_id=$1 AND (pi.offered_needs <> '{}' OR pi.eligibility_mode <> 'open') ORDER BY p.title, p.id", [i.id])).rows;
      const sessions = (await c.query("SELECT * FROM academy_sessions WHERE organisation_id=$1 AND status='published' AND starts_at >= now() AND starts_at < now() + interval '14 days' ORDER BY starts_at, id LIMIT 100", [i.id])).rows;
      const attention = []; let ready = 0, checked = 0;
      for (const s of sessions) {
        const r = await readiness(c, s);
        if (!r.requirements.length) continue;
        checked++; if (r.level === 'ready') ready++; else attention.push({ session_id: s.id, title: s.title, starts_at: s.starts_at, level: r.level, open: r.requirements.filter((x) => x.state === 'gap' || x.state === 'short').map((x) => x.code) });
      }
      const due = (await c.query("SELECT count(DISTINCT o.athlete_id)::int AS n FROM para_outcomes o WHERE o.superseded_at IS NULL AND o.review_by IS NOT NULL AND o.review_by <= current_date + 90 AND EXISTS (SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=o.athlete_id AND e.status='enrolled')", [i.id])).rows[0].n;
      return { athletes_with_shares: suppress(athletes), expiring_30d: expiring, by_type: byType, min_group: MIN_GROUP, adaptive_programmes: progs, sessions_checked: checked, sessions_ready_pct: checked ? Math.round((ready / checked) * 100) : null, sessions_attention: attention, classifications_due_90d: suppress(due) };
    });
  },
});

cap({
  name: 'get_athlete_inclusion', method: 'GET', path: '/organisations/:id/academy/inclusion/athletes/:athlete_id', tag: TAG,
  summary: 'One athlete\'s inclusion strip for staff: the current para classification (class, status, review date) and what was shared with you specifically. The classification is shown only to staff the athlete or guardian named in a live share; everyone else gets 404.',
  input: z.object({ id, athlete_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.id, { c });
      if (!a.has('roster') && !a.eng) throw notFound('Athlete');
      if (!(await enrolled(c, i.id, i.athlete_id))) throw notFound('Athlete');
      const mine = [];
      for (const sh of await liveShares(c, i.id, i.athlete_id)) if (sh.audience_users.includes(user.id)) mine.push(sh);
      if (!mine.length) throw notFound('Athlete');
      const cls = (await c.query("SELECT o.class_code, o.status, o.review_by, o.expires_on, sp.name AS sport FROM para_outcomes o JOIN sports sp ON sp.id=o.sport_id WHERE o.athlete_id=$1 AND o.superseded_at IS NULL ORDER BY o.effective_from DESC, o.id LIMIT 10", [i.athlete_id])).rows;
      for (const m of mine) await log(c, i.id, i.athlete_id, 'share_viewed', user.id, { type: 'share', id: m.id }, 'athlete_strip');
      const adapted = (await c.query('SELECT x.assessment_id, x.pathway_variant, x.descriptors, x.signed_off_at FROM academy_adapted_assessments x WHERE x.organisation_id=$1 AND x.athlete_id=$2 ORDER BY x.created_at DESC LIMIT 10', [i.id, i.athlete_id])).rows;
      return { athlete_id: i.athlete_id, classifications: cls, shared_with_you: mine.map((m) => ({ id: m.id, needs: needLabelKeys(m.need_keys), expires_at: m.expires_at })), adapted_assessments: adapted };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ adapted assessment
const descriptor = z.object({ dimension_key: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().trim().min(1).max(120), level: z.enum(LEVELS), evidence_ref: id.optional() });

cap({
  name: 'save_adapted_assessment', method: 'POST', path: '/academy/assessments/:id/adaptation', tag: TAG, status: 201,
  summary: 'Coach-led adapted assessment on an existing academy assessment: choose the pathway alternative (standard, adapted, age-flexible) and describe each dimension with a descriptor level (emerging, developing, secure, exceeding). There is no numeric or universal score. The outcome, review and appeal stay on the canonical assessment.',
  input: z.object({ id, pathway_variant: z.enum(VARIANTS).default('adapted'), descriptors: z.array(descriptor).min(1).max(20), note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const as = (await c.query('SELECT * FROM academy_assessments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!as) throw notFound('Assessment');
      const a = await opsAccess(user, as.organisation_id, { write: true, c });
      if (!a.admin && as.assessor_id !== user.id) throw notFound('Assessment');
      const keys = i.descriptors.map((d) => d.dimension_key);
      if (new Set(keys).size !== keys.length) throw badRequest('Each dimension appears once');
      const cur = (await c.query('SELECT signed_off_at FROM academy_adapted_assessments WHERE assessment_id=$1', [as.id])).rows[0];
      if (cur?.signed_off_at) throw conflict('A signed-off adaptation cannot be changed. Record a reassessment instead.', { code: 'already_signed_off' });
      const row = (await c.query(`INSERT INTO academy_adapted_assessments(assessment_id, organisation_id, athlete_id, pathway_variant, descriptors, note_enc, adapted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (assessment_id) DO UPDATE SET pathway_variant=EXCLUDED.pathway_variant, descriptors=EXCLUDED.descriptors, note_enc=EXCLUDED.note_enc, updated_at=now() RETURNING assessment_id, pathway_variant, descriptors, signed_off_at`,
        [as.id, as.organisation_id, as.athlete_id, i.pathway_variant, JSON.stringify(i.descriptors), sealNote(i.note, 'note'), user.id])).rows[0];
      await log(c, as.organisation_id, as.athlete_id, 'adaptation_saved', user.id, { type: 'assessment', id: as.id }, i.pathway_variant);
      await audit(c, user.id, 'save_adapted_assessment', 'academy_adapted_assessments', as.id);
      return row;
    });
  },
});

cap({
  name: 'sign_off_adapted_assessment', method: 'POST', path: '/academy/assessments/:id/adaptation/sign-off', tag: TAG,
  summary: 'A second assessor (never the person who wrote it) signs off an adapted assessment. The athlete and guardian keep the appeal route on the canonical assessment.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x = (await c.query('SELECT * FROM academy_adapted_assessments WHERE assessment_id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!x) throw notFound('Adapted assessment');
      const a = await opsAccess(user, x.organisation_id, { write: true, c });
      if (!a.admin && !a.has('roster')) throw notFound('Adapted assessment');
      if (x.adapted_by === user.id) throw forbidden('A second assessor must sign this off, not the person who wrote it');
      if (x.signed_off_at) return { assessment_id: x.assessment_id, signed_off_at: x.signed_off_at };
      const r = (await c.query('UPDATE academy_adapted_assessments SET signed_off_by=$2, signed_off_at=now(), updated_at=now() WHERE assessment_id=$1 RETURNING assessment_id, signed_off_at', [i.id, user.id])).rows[0];
      await log(c, x.organisation_id, x.athlete_id, 'adaptation_signed_off', user.id, { type: 'assessment', id: x.assessment_id });
      await audit(c, user.id, 'sign_off_adapted_assessment', 'academy_adapted_assessments', x.assessment_id);
      return r;
    });
  },
});
