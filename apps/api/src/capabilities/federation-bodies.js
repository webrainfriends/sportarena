// Federation & Governing Body OS (#475) 1/4: governing-body identity, jurisdiction, the recognised hierarchy and scoped delegation.
// A governing body is an organisation (identity, legal details, contact, owners and admins stay in `organisations`) plus a `governing_bodies` row.
// The hierarchy is acyclic and versioned: a recognition is a row that is ended, never rewritten, and every step lands in the append-only fed_events.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { requireApproved } from '../access.js';
import { LEVELS, ROLES, ROLE_LABEL, POLICY_KINDS, authority, can, canSome, need, bodyById, lockBody, lineage, logFed, historyOf, BODY_SQL } from '../federation.js';

const TAG = 'Federation';
const text = (n) => z.string().trim().max(n);
const country = z.string().regex(/^[A-Z]{2}$/, 'two-letter country code');
const sportRef = z.object({ sport_id: id, discipline: text(60).default('') });
const PUBLIC_BODY = 'b.id, b.level, b.abbreviation, b.country, b.region, b.state, b.district, b.status, o.name, o.website, o.contact_email, o.contact_phone, o.description';
const LOCK_KEY = "SELECT pg_advisory_xact_lock(hashtextextended('federation:hierarchy', 0))";

const sportsOf = (bodyId, c = pool) => c.query(
  `SELECT gs.id, gs.sport_id, s.name AS sport_name, s.slug, s.emoji, gs.discipline, gs.started_on FROM governing_body_sports gs JOIN sports s ON s.id=gs.sport_id
    WHERE gs.body_id=$1 AND gs.ended_on IS NULL ORDER BY s.name, gs.discipline`, [bodyId]).then((r) => r.rows);
const parentOf = (bodyId, c = pool) => c.query(
  `SELECT l.id AS link_id, l.effective_from, ${PUBLIC_BODY} FROM governing_body_links l JOIN governing_bodies b ON b.id=l.parent_id JOIN organisations o ON o.id=b.organisation_id
    WHERE l.child_id=$1 AND l.status='recognised'`, [bodyId]).then((r) => r.rows[0] ?? null);
const childrenOf = (bodyId, c = pool) => c.query(
  `SELECT l.id AS link_id, l.effective_from, ${PUBLIC_BODY} FROM governing_body_links l JOIN governing_bodies b ON b.id=l.child_id JOIN organisations o ON o.id=b.organisation_id
    WHERE l.parent_id=$1 AND l.status='recognised' ORDER BY o.name`, [bodyId]).then((r) => r.rows);

/** Hierarchy writes run one at a time, so two recognitions that would close a loop together can never both pass. */
async function wouldLoop(c, parentId, childId) {
  return (await lineage(parentId, c)).includes(childId);
}

cap({
  name: 'create_governing_body', method: 'POST', path: '/federation/bodies', tag: TAG, status: 201,
  summary: 'Set up a federation, association or league as a governing body. Pass `organisation_id` to turn an organisation you own into one (nothing about it changes), or a `name` to create the organisation and the governing body together. Choose the governing level, the sports and disciplines, and the jurisdiction. You become its owner. To sit under a national or regional body, ask for recognition afterwards (propose_body_link).',
  input: z.object({
    organisation_id: id.optional().describe('an organisation you own; omit to create a new one'), name: text(80).min(2).optional(),
    level: z.enum(LEVELS), abbreviation: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2 to 8 letters or digits').describe('prefix of the affiliation, licence and sanction numbers'),
    country: country.optional(), region: text(80).optional(), state: text(80).optional(), district: text(80).optional(),
    sports: z.array(sportRef).min(1).max(40), legal_name: text(160).optional(), registration_no: text(60).optional(), website: text(200).optional(),
    contact_email: z.union([z.literal(''), z.string().trim().email().max(200)]).optional(), contact_phone: text(40).optional(), description: text(1000).optional(),
  }).refine((v) => v.organisation_id || v.name, { message: 'Give an organisation or a name' }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    let orgId = i.organisation_id;
    if (orgId) {
      const m = (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role='owner'", [orgId, user.id])).rowCount;
      if (!m && !isAdmin(user)) throw notFound('Organisation');
      if ((await c.query('SELECT 1 FROM governing_bodies WHERE organisation_id=$1', [orgId])).rowCount) throw conflict('That organisation is already a governing body');
    } else {
      const o = (await c.query(
        `INSERT INTO organisations(name, kind, city, created_by, legal_name, registration_no, website, contact_email, contact_phone, description) VALUES ($1,'federation',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [i.name, i.district ?? i.state ?? i.region ?? null, user.id, i.legal_name || null, i.registration_no || null, i.website || null, i.contact_email || null, i.contact_phone || null, i.description || null])).rows[0];
      orgId = o.id;
      await c.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, invited_by) VALUES ($1,$2,'owner','active',now(),$2)", [orgId, user.id]);
    }
    const dup = await c.query('SELECT 1 FROM governing_bodies WHERE abbreviation=$1 AND coalesce(country, \'\')=$2 AND level=$3', [i.abbreviation, i.country ?? '', i.level]);
    if (dup.rowCount) throw conflict(`${i.abbreviation} is already used by another ${i.level} body${i.country ? ` in ${i.country}` : ''}`);
    const body = (await c.query(
      'INSERT INTO governing_bodies(organisation_id, level, abbreviation, country, region, state, district, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [orgId, i.level, i.abbreviation, i.country ?? null, i.region || null, i.state || null, i.district || null, user.id])).rows[0];
    for (const s of i.sports) {
      if (!(await c.query('SELECT 1 FROM sports WHERE id=$1', [s.sport_id])).rowCount) throw badRequest('Unknown sport');
      await c.query('INSERT INTO governing_body_sports(body_id, sport_id, discipline) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [body.id, s.sport_id, s.discipline]);
    }
    await logFed(c, body.id, 'body', body.id, 'created', { to: 'active', actor: user.id, detail: { level: i.level } });
    await audit(c, user.id, 'create_governing_body', 'governing_bodies', body.id);
    return { ...(await bodyById(body.id, c)), sports: await sportsOf(body.id, c) };
  }),
});

cap({
  name: 'list_governing_bodies', method: 'GET', path: '/federation/bodies', tag: TAG, auth: 'public',
  summary: 'Find recognised governing bodies by name, sport, country, level or parent. Public profile only: name, level, jurisdiction, sports and contact.',
  input: z.object({ q: text(80).optional(), sport_id: id.optional(), country: country.optional(), level: z.enum(LEVELS).optional(), parent_id: id.optional(), ...page }),
  async handler(_ctx, i) {
    const rows = await many(
      `SELECT ${PUBLIC_BODY}, (SELECT po.name FROM governing_body_links l JOIN governing_bodies pb ON pb.id=l.parent_id JOIN organisations po ON po.id=pb.organisation_id WHERE l.child_id=b.id AND l.status='recognised') AS parent_name,
              (SELECT coalesce(json_agg(json_build_object('sport_id', s.id, 'name', s.name, 'emoji', s.emoji, 'discipline', gs.discipline) ORDER BY s.name), '[]') FROM governing_body_sports gs JOIN sports s ON s.id=gs.sport_id WHERE gs.body_id=b.id AND gs.ended_on IS NULL) AS sports
         FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id
        WHERE b.status='active' AND ($1::text IS NULL OR o.name ILIKE '%'||$1||'%' OR b.abbreviation ILIKE $1||'%')
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM governing_body_sports gs WHERE gs.body_id=b.id AND gs.sport_id=$2 AND gs.ended_on IS NULL))
          AND ($3::text IS NULL OR b.country=$3) AND ($4::text IS NULL OR b.level=$4)
          AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM governing_body_links l WHERE l.child_id=b.id AND l.parent_id=$5 AND l.status='recognised'))
        ORDER BY o.name, b.id LIMIT $6 OFFSET $7`, [i.q ?? null, i.sport_id ?? null, i.country ?? null, i.level ?? null, i.parent_id ?? null, i.limit, i.offset]);
    return rows;
  },
});

cap({
  name: 'my_governing_bodies', method: 'GET', path: '/federation/mine', tag: TAG,
  summary: 'The governing bodies you run or hold a federation role on, with what you may do on each.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${PUBLIC_BODY}, b.organisation_id, b.status AS body_status, (SELECT m.role FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')) AS org_role,
              coalesce((SELECT json_agg(DISTINCT r.role) FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$1 AND r.status='active'), '[]') AS roles
         FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id
        WHERE ${isAdmin(user) ? 'true' : `(EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=b.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))
              OR EXISTS (SELECT 1 FROM governing_body_roles r WHERE r.body_id=b.id AND r.user_id=$1 AND r.status='active'))`}
        ORDER BY o.name, b.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    return rows;
  },
});

cap({
  name: 'get_governing_body', method: 'GET', path: '/federation/bodies/:id', tag: TAG, auth: 'public',
  summary: 'A governing body: public profile, sports, jurisdiction, recognised parent and child bodies, and what clubs and people can apply for (affiliation categories and licence types). Signed-in staff also get what they may do here.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const b = await one(`SELECT ${PUBLIC_BODY}, b.organisation_id FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id=$1`, [i.id]);
    if (!b) throw notFound('Governing body');
    const [sports, parent, children, categories, licence_types] = await Promise.all([
      sportsOf(b.id), parentOf(b.id), childrenOf(b.id),
      many(`SELECT id, name, applicant_kind, sport_id, description, fee_minor, currency, duration_months FROM fed_affiliation_categories WHERE body_id=$1 AND archived_at IS NULL ORDER BY name`, [b.id]),
      many(`SELECT t.id, t.name, t.holder_role, t.sport_id, s.name AS sport_name, t.discipline, t.grade, t.grade_rank, t.duration_months, t.fee_minor, t.currency, t.requires_affiliation FROM fed_licence_types t JOIN sports s ON s.id=t.sport_id WHERE t.body_id=$1 AND t.archived_at IS NULL ORDER BY s.name, t.name`, [b.id]),
    ]);
    const auth = user ? await authority(user, b.id, { optional: true }) : null;
    const { organisation_id, ...pub } = b;
    return { ...pub, sports, parent, children, categories, licence_types, me: auth ? { admin: auth.admin, roles: auth.roles.map((r) => r.role), read_only_via_parent: auth.viaAncestor, can: Object.fromEntries(['affiliations', 'licences', 'sanctions', 'governance', 'evidence', 'reports', 'exceptions'].map((p) => [p, canSome(auth, p)])) } : null };
  },
});

cap({
  name: 'update_governing_body', method: 'PATCH', path: '/federation/bodies/:id', tag: TAG,
  summary: 'Change a body\'s level or jurisdiction, or the sports and disciplines it governs (owner/admin). A sport you drop is ended, not deleted: the licences, affiliations and sanctions issued under it keep their record. The legal and contact details are the organisation\'s own: edit those with update_organisation.',
  input: z.object({ id, level: z.enum(LEVELS).optional(), country: country.nullish(), region: text(80).nullish(), state: text(80).nullish(), district: text(80).nullish(), sports: z.array(sportRef).min(1).max(40).optional(), version: z.number().int().min(1).optional().describe('row_version you last saw') }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    need(auth, 'governance');
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins change its level, jurisdiction or sports');
    const b = await lockBody(c, i.id);
    if (i.version && i.version !== b.row_version) throw conflict('This body changed since you opened it; reload and try again', { code: 'stale_version' });
    const pick = (k) => (i[k] === undefined ? b[k] : i[k] || null);
    await c.query('UPDATE governing_bodies SET level=$2, country=$3, region=$4, state=$5, district=$6, row_version=row_version+1, updated_at=now() WHERE id=$1',
      [b.id, i.level ?? b.level, pick('country'), pick('region'), pick('state'), pick('district')]);
    if (i.sports) {
      const want = new Set(i.sports.map((s) => `${s.sport_id}|${s.discipline}`));
      for (const s of i.sports) {
        if (!(await c.query('SELECT 1 FROM sports WHERE id=$1', [s.sport_id])).rowCount) throw badRequest('Unknown sport');
        await c.query('INSERT INTO governing_body_sports(body_id, sport_id, discipline) VALUES ($1,$2,$3) ON CONFLICT (body_id, sport_id, discipline) DO UPDATE SET ended_on=NULL', [b.id, s.sport_id, s.discipline]);
      }
      for (const cur of (await c.query('SELECT id, sport_id, discipline FROM governing_body_sports WHERE body_id=$1 AND ended_on IS NULL', [b.id])).rows) {
        if (!want.has(`${cur.sport_id}|${cur.discipline}`)) await c.query('UPDATE governing_body_sports SET ended_on=current_date WHERE id=$1', [cur.id]);
      }
    }
    await logFed(c, b.id, 'body', b.id, 'updated', { actor: user.id, detail: { fields: Object.keys(i).filter((k) => !['id', 'version'].includes(k)) } });
    return { ...(await bodyById(b.id, c)), sports: await sportsOf(b.id, c) };
  }),
});

cap({
  name: 'set_governing_body_status', method: 'POST', path: '/federation/bodies/:id/status', tag: TAG,
  summary: 'Suspend, archive or reinstate a governing body (owner/admin; the platform team can suspend too). A suspended or archived body takes no new applications or decisions; everything it already issued and its history stay readable.',
  input: z.object({ id, status: z.enum(['active', 'suspended', 'archived']), reason: text(500).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins change its status');
    const b = await lockBody(c, i.id);
    if (b.status === i.status) throw conflict(`Already ${b.status}`);
    await c.query('UPDATE governing_bodies SET status=$2, status_reason=$3, row_version=row_version+1, updated_at=now() WHERE id=$1', [b.id, i.status, i.reason]);
    await logFed(c, b.id, 'body', b.id, `status_${i.status}`, { from: b.status, to: i.status, actor: user.id, reason: i.reason });
    await audit(c, user.id, 'set_governing_body_status', 'governing_bodies', b.id);
    return bodyById(b.id, c);
  }),
});

// ------------------------------------------------------------------ recognition (the hierarchy)
const linkView = (l) => l;
cap({
  name: 'propose_body_link', method: 'POST', path: '/federation/links', tag: TAG, status: 201,
  summary: 'Ask for a body to be recognised under another (national → regional → league). Run by an admin of either side: the other side answers. An admin of both sides is recognised at once. A body has one recognised parent at a time, and the hierarchy can never loop.',
  input: z.object({ parent_id: id, child_id: id, reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    if (i.parent_id === i.child_id) throw badRequest('A body cannot be recognised under itself');
    await c.query(LOCK_KEY);
    const pa = await authority(user, i.parent_id, { c, optional: true }), ca = await authority(user, i.child_id, { c, optional: true });
    const parentAdmin = !!pa?.admin, childAdmin = !!ca?.admin;
    if (!parentAdmin && !childAdmin) throw notFound('Governing body');
    const parent = await lockBody(c, i.parent_id), child = await lockBody(c, i.child_id);
    if (parent.status !== 'active' || child.status !== 'active') throw conflict('Both bodies must be active');
    if (await wouldLoop(c, i.parent_id, i.child_id)) throw conflict('That would put a body under one of its own descendants');
    if ((await c.query("SELECT 1 FROM governing_body_links WHERE child_id=$1 AND status='recognised'", [i.child_id])).rowCount) throw conflict('That body is already recognised under a parent; end that recognition first');
    const both = parentAdmin && childAdmin;
    let l;
    try {
      l = (await c.query(
        `INSERT INTO governing_body_links(parent_id, child_id, status, requested_by, requested_side, reason, decided_by, effective_from, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.parent_id, i.child_id, both ? 'recognised' : 'requested', user.id, parentAdmin ? 'parent' : 'child', i.reason ?? null, both ? user.id : null, both ? new Date() : null, both ? new Date() : null])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('There is already an open request for this pair'); throw e; }
    await logFed(c, i.child_id, 'link', l.id, both ? 'recognised' : 'requested', { to: l.status, actor: user.id, reason: i.reason, detail: { parent_id: i.parent_id, child_id: i.child_id } });
    if (!both) {
      const otherBody = parentAdmin ? child : parent;
      const staff = (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [otherBody.organisation_id])).rows;
      const me = parentAdmin ? parent : child;
      for (const s of staff) await notify(c, s.user_id, { kind: 'federation_link_request', title: 'Recognition request', body: parentAdmin ? `${me.abbreviation} asks to recognise your body.` : `${me.abbreviation} asks to be recognised under your body.`, data: { link_id: l.id }, dedupe_key: `fed-link:${l.id}:${s.user_id}` });
    }
    return linkView(l);
  }),
});

cap({
  name: 'respond_body_link', method: 'POST', path: '/federation/links/:id/respond', tag: TAG,
  summary: 'Answer a recognition request (the other side recognises or declines) or withdraw your own (the side that asked).',
  input: z.object({ id, decision: z.enum(['recognise', 'decline', 'withdraw']), reason: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query(LOCK_KEY);
    const l = (await c.query('SELECT * FROM governing_body_links WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!l) throw notFound('Link');
    const pa = await authority(user, l.parent_id, { c, optional: true }), ca = await authority(user, l.child_id, { c, optional: true });
    const side = pa?.admin ? 'parent' : null, cside = ca?.admin ? 'child' : null;
    if (!side && !cside) throw notFound('Link');
    if (l.status !== 'requested') throw conflict(`This request is already ${l.status}`);
    const mine = l.requested_side === 'parent' ? !!side : !!cside;
    const other = l.requested_side === 'parent' ? !!cside : !!side;
    if (i.decision === 'withdraw') { if (!mine) throw forbidden('Only the side that asked can withdraw'); }
    else if (!other) throw forbidden('Only the other side can answer this request');
    let status = i.decision === 'withdraw' ? 'withdrawn' : i.decision === 'decline' ? 'declined' : 'recognised';
    if (status === 'recognised') {
      if (await wouldLoop(c, l.parent_id, l.child_id)) throw conflict('That would put a body under one of its own descendants');
      if ((await c.query("SELECT 1 FROM governing_body_links WHERE child_id=$1 AND status='recognised'", [l.child_id])).rowCount) throw conflict('That body is already recognised under a parent');
    }
    const out = (await c.query('UPDATE governing_body_links SET status=$2, decided_by=$3, decided_at=now(), effective_from=CASE WHEN $2=\'recognised\' THEN current_date END, reason=coalesce($4, reason) WHERE id=$1 RETURNING *', [l.id, status, user.id, i.reason ?? null])).rows[0];
    await logFed(c, l.child_id, 'link', l.id, status, { from: 'requested', to: status, actor: user.id, reason: i.reason, detail: { parent_id: l.parent_id, child_id: l.child_id } });
    const asked = (await c.query('SELECT 1 FROM users WHERE id=$1', [l.requested_by])).rowCount ? l.requested_by : null;
    if (asked && asked !== user.id) await notify(c, asked, { kind: 'federation_link_answer', title: 'Recognition request answered', body: `Your recognition request was ${status}.`, data: { link_id: l.id }, dedupe_key: `fed-link-ans:${l.id}` });
    return linkView(out);
  }),
});

cap({
  name: 'end_body_link', method: 'POST', path: '/federation/links/:id/end', tag: TAG,
  summary: 'End a recognition (an admin of either body). The link is kept with its end date; the bodies and everything they issued are untouched.',
  input: z.object({ id, reason: text(500).min(3) }),
  handler: ({ user }, i) => tx(async (c) => {
    await c.query(LOCK_KEY);
    const l = (await c.query('SELECT * FROM governing_body_links WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!l) throw notFound('Link');
    const pa = await authority(user, l.parent_id, { c, optional: true }), ca = await authority(user, l.child_id, { c, optional: true });
    if (!pa?.admin && !ca?.admin) throw notFound('Link');
    if (l.status !== 'recognised') throw conflict(`Nothing to end: this link is ${l.status}`);
    const out = (await c.query("UPDATE governing_body_links SET status='ended', effective_to=current_date, decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1 RETURNING *", [l.id, user.id, i.reason])).rows[0];
    await logFed(c, l.child_id, 'link', l.id, 'ended', { from: 'recognised', to: 'ended', actor: user.id, reason: i.reason, detail: { parent_id: l.parent_id, child_id: l.child_id } });
    return linkView(out);
  }),
});

cap({
  name: 'list_body_links', method: 'GET', path: '/federation/bodies/:id/links', tag: TAG,
  summary: 'The recognition history of a body: its parent, its children, open requests and ended links (staff of the body, or of a body above it).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await authority(user, i.id);
    return many(
      `SELECT l.id, l.status, l.requested_side, l.reason, l.effective_from, l.effective_to, l.created_at, l.decided_at,
              l.parent_id, po.name AS parent_name, l.child_id, co.name AS child_name, CASE WHEN l.child_id=$1 THEN 'parent' ELSE 'child' END AS other_side
         FROM governing_body_links l JOIN governing_bodies pb ON pb.id=l.parent_id JOIN organisations po ON po.id=pb.organisation_id JOIN governing_bodies cb ON cb.id=l.child_id JOIN organisations co ON co.id=cb.organisation_id
        WHERE l.parent_id=$1 OR l.child_id=$1 ORDER BY (l.status='requested') DESC, (l.status='recognised') DESC, l.created_at DESC, l.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ scoped delegation
cap({
  name: 'grant_federation_role', method: 'POST', path: '/federation/bodies/:id/roles', tag: TAG, status: 201,
  summary: 'Give a person one scoped job on the body (registrar, licensing officer, sanctioning officer, secretary, compliance, auditor), for every sport or for one (owner/admin). Roles are checked live on every call and can be revoked at once. None of them can see a club\'s finance, coaching notes or medical data.',
  input: z.object({ id, user_id: id, role: z.enum(ROLES), sport_id: id.optional().describe('limit the role to one sport the body governs'), jurisdiction_ids: z.array(id).max(50).default([]).describe('limit the role to records in these jurisdictions of the body (regions, states, districts); empty = the whole body') }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins grant roles');
    const b = await lockBody(c, i.id);
    mustBeStaffable(b);
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
    if (i.sport_id && !(await c.query('SELECT 1 FROM governing_body_sports WHERE body_id=$1 AND sport_id=$2 AND ended_on IS NULL', [b.id, i.sport_id])).rowCount) throw badRequest('That sport is not one this body governs');
    const juris = [...new Set(i.jurisdiction_ids)];
    if (juris.length && (await c.query('SELECT count(*)::int AS n FROM fed_jurisdictions WHERE body_id=$1 AND archived_at IS NULL AND id = ANY($2)', [b.id, juris])).rows[0].n !== juris.length) throw badRequest('Pick jurisdictions that belong to this body');
    let r;
    try { r = (await c.query('INSERT INTO governing_body_roles(body_id, user_id, role, sport_id, jurisdiction_ids, granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.id, i.user_id, i.role, i.sport_id ?? null, juris, user.id])).rows[0]; }
    catch (e) { if (e.code === '23505') throw conflict('They already hold that role'); throw e; }
    await logFed(c, b.id, 'role', r.id, 'granted', { to: 'active', actor: user.id, detail: { user_id: i.user_id, role: i.role, sport_id: i.sport_id ?? null, jurisdiction_ids: juris } });
    await notify(c, i.user_id, { kind: 'federation_role', title: 'Federation role', body: `You are now ${ROLE_LABEL[i.role]} for ${b.abbreviation}.`, data: { body_id: b.id }, dedupe_key: `fed-role:${r.id}` });
    return r;
  }),
});
function mustBeStaffable(b) { if (b.status === 'archived') throw conflict('This body is archived'); }

cap({
  name: 'revoke_federation_role', method: 'DELETE', path: '/federation/bodies/:id/roles/:role_id', tag: TAG,
  summary: 'Take a scoped role away (owner/admin). It stops working immediately; the grant is kept in history.',
  input: z.object({ id, role_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const auth = await authority(user, i.id, { c });
    if (!auth.admin) throw forbidden('Only the body\'s owners and admins revoke roles');
    const r = (await c.query("UPDATE governing_body_roles SET status='revoked', revoked_by=$3, revoked_at=now() WHERE id=$1 AND body_id=$2 AND status='active' RETURNING *", [i.role_id, i.id, user.id])).rows[0];
    if (!r) throw notFound('Role');
    await logFed(c, i.id, 'role', r.id, 'revoked', { from: 'active', to: 'revoked', actor: user.id, detail: { user_id: r.user_id, role: r.role } });
    return r;
  }),
});

cap({
  name: 'list_federation_roles', method: 'GET', path: '/federation/bodies/:id/roles', tag: TAG,
  summary: 'Who runs the body: organisation owners and admins, and the people holding scoped roles (any staff of the body).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await authority(user, i.id);
    const b = await bodyById(i.id);
    const [owners, roles] = await Promise.all([
      many(`SELECT ${PUBLIC_USER}, m.role FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('owner','admin') ORDER BY m.role, u.display_name`, [b.organisation_id]),
      many(`SELECT r.id AS role_id, r.role, r.sport_id, s.name AS sport_name, r.jurisdiction_ids, coalesce((SELECT json_agg(j.name ORDER BY j.name) FROM fed_jurisdictions j WHERE j.id = ANY(r.jurisdiction_ids)), '[]') AS jurisdiction_names, r.granted_at, ${PUBLIC_USER} FROM governing_body_roles r JOIN users u ON u.id=r.user_id LEFT JOIN sports s ON s.id=r.sport_id WHERE r.body_id=$1 AND r.status='active' ORDER BY r.role, u.display_name`, [i.id]),
    ]);
    return { owners, roles, role_labels: ROLE_LABEL };
  },
});

cap({
  name: 'list_federation_history', method: 'GET', path: '/federation/bodies/:id/history', tag: TAG,
  summary: 'The body\'s immutable decision log: who did what, when and why (staff of the body).',
  input: z.object({ id, subject_type: z.enum(['body', 'link', 'role', 'affiliation', 'licence', 'sanction', 'policy', 'date']).optional(), ...page }),
  async handler({ user }, i) {
    const a = await authority(user, i.id);
    need(a, 'reports');
    return many(
      `SELECT e.id, e.subject_type, e.subject_id, e.action, e.from_status, e.to_status, e.reason, e.created_at, u.display_name AS actor_name FROM fed_events e LEFT JOIN users u ON u.id=e.actor_id
        WHERE e.body_id=$1 AND ($2::text IS NULL OR e.subject_type=$2) ORDER BY e.created_at DESC, e.id LIMIT $3 OFFSET $4`, [i.id, i.subject_type ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'list_policy_kinds', method: 'GET', path: '/federation/policy-kinds', tag: TAG, auth: 'public',
  summary: 'The kinds of governing requirement a body can publish, whether the platform enforces them at decision time, and the fields each one takes.',
  handler: () => Object.entries(POLICY_KINDS).map(([kind, k]) => ({ kind, label: k.label, enforced: k.enforced, fields: Object.entries(k.params.shape).map(([name, s]) => ({ name, optional: s.isOptional?.() ?? false })) })),
});
