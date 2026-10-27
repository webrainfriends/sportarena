// Sports Media, Broadcast & Rights (#482) 1/4: media partners, the rights inventory (packages scoped to a competition, a game or a collection) and the licence
// each partner holds. A partner is an organisation; events and games are the canonical ones. A licence grants exactly the rights, platforms, territory and dates
// written on it and nothing else: it never opens a team, player or organisation record. Rights are read live (an expired licence stops at its end date).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import {
  RIGHTS, RIGHT_KEYS, PLATFORMS, PARTNER_KINDS, IN_FORCE, LIC_STAGE, logMr, historyOf, eventOf, isOrganiserOf, myPartners, partnerFor, partnerAdmins, eventOrganisers,
  terr, territoryWithin, platformsWithin, exclusivityConflicts, entitlementsFor, assetState, licenceCovers, ASSET_COLS, LIVE_RIGHTS,
} from '../media-rights.js';

const TAG = 'Media rights';
const text = (n) => z.string().trim().max(n);
const dt = z.string().datetime({ offset: true });
const country = z.string().regex(/^[A-Z]{2}$/);
const right = z.enum(RIGHT_KEYS);
const platform = z.enum(PLATFORMS);

const eventRow = async (user, eventId, c, { organiser = false } = {}) => {
  const ev = await eventOf(eventId, c);
  const org = await isOrganiserOf(user, ev, c);
  if (organiser && !org) throw forbidden('Only the organiser of this event can do that');
  return { ev, org };
};

// ------------------------------------------------------------------ partners
cap({
  name: 'register_media_partner', method: 'POST', path: '/media/partners', tag: TAG, status: 201,
  summary: 'Register an organisation you own or administer as a media partner (broadcaster, streaming platform, radio, press, photo agency, production company, data licensee …). Its identity, members and legal details stay on the organisation; this only marks it as able to hold rights.',
  input: z.object({ organisation_id: id, kind: z.enum(PARTNER_KINDS) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true, c });
    try {
      const m = (await c.query('INSERT INTO media_partners(organisation_id, kind, registered_by) VALUES ($1,$2,$3) RETURNING *', [org.id, i.kind, user.id])).rows[0];
      await logMr(c, null, 'partner', m.id, 'registered', { actor: user.id, detail: { kind: i.kind } });
      return { ...m, name: org.name };
    } catch (e) { if (e.code === '23505') throw conflict('This organisation is already a media partner'); throw e; }
  }),
});

cap({
  name: 'search_media_partners', method: 'GET', path: '/media/partners/search', tag: TAG,
  summary: 'Find registered media partners by name or kind, to offer them rights. Only the name and kind are shown.',
  input: z.object({ q: text(80).optional(), kind: z.enum(PARTNER_KINDS).optional(), ...page }),
  handler: (_ctx, i) => many(
    `SELECT m.id, o.name, m.kind FROM media_partners m JOIN organisations o ON o.id=m.organisation_id
      WHERE m.status='active' AND o.status='active' AND ($1::text IS NULL OR o.name ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR m.kind=$2) ORDER BY o.name LIMIT $3 OFFSET $4`, [i.q ?? null, i.kind ?? null, i.limit, i.offset]),
});

cap({
  name: 'list_my_media_partners', method: 'GET', path: '/media/partners/mine', tag: TAG,
  summary: 'The media partner organisations you belong to, with your role and whether it can act for the partner.',
  input: z.object({}),
  handler: ({ user }) => myPartners(user),
});

// ------------------------------------------------------------------ packages
const pkgInput = {
  scope_kind: z.enum(['event', 'fixture', 'collection']).default('event').describe('what the rights cover: the whole competition, one game, or an approved content collection'),
  fixture_id: id.optional(), collection_id: id.optional(),
  name: text(120).min(2), rights: z.array(right).min(1).max(12),
  territory_mode: z.enum(['worldwide', 'include', 'exclude']).default('worldwide'), countries: z.array(country).max(250).default([]),
  platforms: z.array(platform).max(8).default([]).describe('empty = every platform'), languages: z.array(text(10)).max(20).default([]),
  exclusivity: z.enum(['exclusive', 'non_exclusive']).default('non_exclusive'), valid_from: dt, valid_to: dt,
  content_scope: text(1000).optional(), embargo_minutes: z.number().int().min(0).max(525600).default(0).describe('how long after a game ends before replay, highlights, clips and archive may be published'),
  sublicensing: z.enum(['none', 'with_approval', 'allowed']).default('none'),
};
const PKG_VIEW = `p.*, (SELECT count(*)::int FROM mr_licences l WHERE l.package_id=p.id AND l.stage='active' AND l.effective_to > now()) AS active_licences,
  (SELECT count(*)::int FROM mr_licences l WHERE l.package_id=p.id AND l.stage IN ('proposed','negotiating')) AS open_proposals`;

cap({
  name: 'save_rights_package', method: 'POST', path: '/events/:id/media/packages', tag: TAG, status: 201,
  summary: 'Define (or change) a rights package for a competition you organise: which rights (live, replay, highlights, clips, audio, photography, press, data feed, archive, social), for which territory and platforms, exclusive or not, the validity window, content scope, the delay after a game before after-the-fact content may go out, and sublicensing. Pass `package_id` to change one that has no licences yet; licensed terms change through the licence.',
  input: z.object({ id, package_id: id.optional(), ...pkgInput }),
  handler: ({ user }, i) => tx(async (c) => {
    const { ev } = await eventRow(user, i.id, c, { organiser: true });
    if (ev.status === 'cancelled') throw conflict('This event is cancelled');
    if (new Date(i.valid_to) <= new Date(i.valid_from)) throw badRequest('The validity window must end after it starts');
    if (i.territory_mode !== 'worldwide' && !i.countries.length) throw badRequest('Name the countries this territory covers');
    if (i.scope_kind === 'fixture') {
      if (!i.fixture_id || !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    } else if (i.fixture_id) throw badRequest('Only a game-scoped package names a game');
    if (i.scope_kind === 'collection') {
      if (!i.collection_id || !(await c.query('SELECT 1 FROM mr_collections WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [i.collection_id, i.id])).rowCount) throw badRequest('Choose a content collection of this event');
    } else if (i.collection_id) throw badRequest('Only a collection-scoped package names a collection');
    const v = [i.scope_kind, i.fixture_id ?? null, i.collection_id ?? null, i.name, [...new Set(i.rights)], i.territory_mode, i.territory_mode === 'worldwide' ? [] : [...new Set(i.countries)], [...new Set(i.platforms)], i.languages, i.exclusivity, i.valid_from, i.valid_to, i.content_scope ?? null, i.embargo_minutes, i.sublicensing];
    let row;
    if (i.package_id) {
      const cur = (await c.query('SELECT * FROM mr_packages WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.package_id, i.id])).rows[0];
      if (!cur) throw notFound('Rights package');
      if ((await c.query("SELECT 1 FROM mr_licences l WHERE l.package_id=$1 AND l.stage IN ('proposed','negotiating','active','suspended')", [cur.id])).rowCount) throw conflict('This package has licences; change their terms on the licence, or end them first');
      row = (await c.query(
        `UPDATE mr_packages SET scope_kind=$2, fixture_id=$3, collection_id=$4, name=$5, rights=$6, territory_mode=$7, countries=$8, platforms=$9, languages=$10, exclusivity=$11, valid_from=$12, valid_to=$13, content_scope=$14, embargo_minutes=$15, sublicensing=$16, row_version=row_version+1, updated_at=now()
          WHERE id=$1 RETURNING *`, [cur.id, ...v])).rows[0];
      await logMr(c, i.id, 'package', row.id, 'updated', { actor: user.id });
    } else {
      row = (await c.query(
        `INSERT INTO mr_packages(event_id, created_by, scope_kind, fixture_id, collection_id, name, rights, territory_mode, countries, platforms, languages, exclusivity, valid_from, valid_to, content_scope, embargo_minutes, sublicensing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`, [i.id, user.id, ...v])).rows[0];
      await logMr(c, i.id, 'package', row.id, 'created', { actor: user.id, detail: { rights: row.rights } });
    }
    return row;
  }),
});

cap({
  name: 'set_rights_package_status', method: 'POST', path: '/media/packages/:id/status', tag: TAG,
  summary: 'Offer a package to the market (open), pause new proposals (closed), return it to draft, or withdraw it. A package with live or pending licences cannot be withdrawn until they are ended.',
  input: z.object({ id, status: z.enum(['draft', 'open', 'closed', 'withdrawn']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM mr_packages WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Rights package');
    await eventRow(user, p.event_id, c, { organiser: true });
    if (p.status === 'withdrawn') throw conflict('A withdrawn package stays withdrawn');
    if (['draft', 'withdrawn'].includes(i.status) && (await c.query("SELECT 1 FROM mr_licences WHERE package_id=$1 AND stage IN ('proposed','negotiating','active','suspended') AND (stage <> 'active' OR effective_to > now())", [p.id])).rowCount) {
      throw conflict('End or decline the licences on this package first');
    }
    const row = (await c.query('UPDATE mr_packages SET status=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [p.id, i.status])).rows[0];
    await logMr(c, p.event_id, 'package', p.id, `status_${i.status}`, { actor: user.id });
    return row;
  }),
});

cap({
  name: 'list_rights_packages', method: 'GET', path: '/events/:id/media/packages', tag: TAG,
  summary: 'The rights inventory of an event. The organiser sees every package with its licence counts; everyone else sees only packages that are open for proposals.',
  input: z.object({ id, status: z.enum(['draft', 'open', 'closed', 'withdrawn']).optional() }),
  async handler({ user }, i) {
    const { ev, org } = await eventRow(user, i.id, null);
    if (!org && ev.status === 'draft') throw notFound('Event');
    return many(`SELECT ${PKG_VIEW}, fx.scheduled_at AS fixture_at, c.name AS collection_name FROM mr_packages p LEFT JOIN fixtures fx ON fx.id=p.fixture_id LEFT JOIN mr_collections c ON c.id=p.collection_id
      WHERE p.event_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3 OR p.status='open') ORDER BY p.created_at DESC`, [i.id, i.status ?? null, org]);
  },
});

// ------------------------------------------------------------------ licences
const termsInput = {
  approved_rights: z.array(right).min(1).max(12), approved_platforms: z.array(platform).max(8).default([]),
  territory_mode: z.enum(['worldwide', 'include', 'exclude']).default('worldwide'), countries: z.array(country).max(250).default([]),
  effective_from: dt, effective_to: dt, fee_minor: z.number().int().min(0).max(1_000_000_000_000).default(0), currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  note: text(1000).optional(), negotiation_ref: text(120).optional(),
};
const LIC_FROM = `mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN events e ON e.id=p.event_id JOIN media_partners m ON m.id=l.partner_id JOIN organisations o ON o.id=m.organisation_id`;
const LIC_COLS = `l.*, ${LIC_STAGE('l')} AS stage_now, ${IN_FORCE()} AS in_force, p.name AS package_name, p.event_id, p.scope_kind, p.fixture_id, p.collection_id, p.rights AS package_rights, p.platforms AS package_platforms, p.territory_mode AS package_territory, p.countries AS package_countries, p.exclusivity, p.sublicensing, p.embargo_minutes,
  p.valid_from AS package_from, p.valid_to AS package_to, e.name AS event_name, e.organizer_id, e.organisation_id AS event_org_id, o.name AS partner_name, m.kind AS partner_kind, m.organisation_id AS partner_org_id,
  CASE WHEN l.effective_to > now() THEN GREATEST(0, ceil(extract(epoch FROM (l.effective_to - now())) / 86400))::int END AS days_left`;
const licRow = async (lid, c = pool) => (await c.query(`SELECT ${LIC_COLS} FROM ${LIC_FROM} WHERE l.id=$1`, [lid])).rows[0];

/** The licence and which side the caller is on. 404 for anyone who is neither the organiser nor a member of the partner. */
async function licenceAccess(user, lid, c = pool, { lock = false } = {}) {
  if (lock) await c.query('SELECT id FROM mr_licences WHERE id=$1 FOR UPDATE', [lid]);
  const lic = await licRow(lid, c);
  if (!lic) throw notFound('Licence');
  const ev = await eventOf(lic.event_id, c);
  const organiser = await isOrganiserOf(user, ev, c);
  let partner = null;
  try { partner = await partnerFor(user, lic.partner_id, { c }); } catch { /* not a member */ }
  if (!organiser && !partner) throw notFound('Licence');
  return { lic, ev, organiser, partner, partnerCanAct: !!partner && ['owner', 'admin', 'manager', 'legal', 'approver'].includes(partner.role) };
}

/** A licence may only narrow its package: rights, platforms, territory and dates all inside what the package offers. */
function checkTerms(pkg, t) {
  const bad = [];
  if (!t.approved_rights.every((r) => pkg.rights.includes(r))) bad.push('rights outside the package');
  if (!platformsWithin(t.approved_platforms, pkg.platforms)) bad.push('platforms outside the package');
  if (t.territory_mode !== 'worldwide' && !t.countries.length) bad.push('countries missing');
  if (!territoryWithin(terr(t), terr(pkg))) bad.push('territory wider than the package');
  if (new Date(t.effective_to) <= new Date(t.effective_from)) bad.push('the licence must end after it starts');
  if (new Date(t.effective_from) < new Date(pkg.valid_from) || new Date(t.effective_to) > new Date(pkg.valid_to)) bad.push('dates outside the package window');
  if (bad.length) throw badRequest(`These terms do not fit the package: ${bad.join('; ')}`, { code: 'terms_outside_package', problems: bad });
}
const termsRow = (t) => [[...new Set(t.approved_rights)], [...new Set(t.approved_platforms)], t.territory_mode, t.territory_mode === 'worldwide' ? [] : [...new Set(t.countries)], t.effective_from, t.effective_to, t.fee_minor, t.currency, t.note ?? null, t.negotiation_ref ?? null];

async function nextLicenceNo(c, partnerId, year) {
  const r = (await c.query('UPDATE media_partners SET licence_seq=licence_seq+1 WHERE id=$1 RETURNING licence_seq AS n', [partnerId])).rows[0];
  return `MR-${year}-${partnerId.slice(0, 4).toUpperCase()}-${String(r.n).padStart(4, '0')}`;
}
const tell = async (c, userIds, exceptId, msg) => { for (const uid of new Set(userIds)) if (uid !== exceptId) await notify(c, uid, msg); };

cap({
  name: 'propose_media_licence', method: 'POST', path: '/media/packages/:id/licences', tag: TAG, status: 201,
  summary: 'Open a licence on a rights package. The organiser offers it to a partner (`partner_id`), or a partner applies for an open package it belongs to. The terms can only narrow the package. The other side then accepts, negotiates or declines.',
  input: z.object({ id, partner_id: id, ...termsInput }),
  handler: ({ user }, i) => tx(async (c) => {
    const pkg = (await c.query('SELECT * FROM mr_packages WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!pkg) throw notFound('Rights package');
    const { ev, org } = await eventRow(user, pkg.event_id, c);
    let side = org ? 'organiser' : null;
    if (!org) {
      await partnerFor(user, i.partner_id, { write: true, c });
      if (pkg.status !== 'open' || ev.status === 'draft') throw notFound('Rights package');
      side = 'partner';
    }
    if (!['draft', 'open'].includes(pkg.status) && side === 'organiser') throw conflict('This package is not open for licences');
    const m = (await c.query("SELECT m.*, o.name FROM media_partners m JOIN organisations o ON o.id=m.organisation_id WHERE m.id=$1 AND m.status='active' AND o.status='active'", [i.partner_id])).rows[0];
    if (!m) throw notFound('Media partner');
    checkTerms(pkg, i);
    let lic;
    try {
      lic = (await c.query(
        `INSERT INTO mr_licences(package_id, partner_id, licence_no, proposed_by_side, approved_rights, approved_platforms, territory_mode, countries, effective_from, effective_to, fee_minor, currency, note, negotiation_ref, proposed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [pkg.id, m.id, await nextLicenceNo(c, m.id, new Date().getFullYear()), side, ...termsRow(i), user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('This partner already has an open offer on this package'); throw e; }
    await logMr(c, pkg.event_id, 'licence', lic.id, 'proposed', { actor: user.id, detail: { side, rights: lic.approved_rights, fee_minor: lic.fee_minor, currency: lic.currency } });
    const them = side === 'organiser' ? await partnerAdmins(c, m.id) : await eventOrganisers(c, ev);
    await tell(c, them, user.id, { kind: 'media_licence_proposed', title: 'Media rights proposal', body: `${side === 'organiser' ? `${ev.name} offers ${m.name}` : `${m.name} asks for rights to ${ev.name}`}: ${lic.approved_rights.map((r) => RIGHTS[r]).join(', ')}.`, data: { licence_id: lic.id, event_id: ev.id }, dedupe_key: `mr-proposed:${lic.id}` });
    return licRow(lic.id, c);
  }),
});

cap({
  name: 'revise_media_licence', method: 'POST', path: '/media/licences/:id/terms', tag: TAG,
  summary: 'Counter-propose different terms while a licence is still being agreed. The other side must then accept the revised terms; every version is kept in the history. Once active, terms change by renewing, not by editing.',
  input: z.object({ id, row_version: z.number().int().min(1), ...termsInput }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licenceAccess(user, i.id, c, { lock: true });
    if (!['proposed', 'negotiating'].includes(a.lic.stage)) throw conflict('Terms can only be revised before the licence is active');
    if (a.lic.row_version !== i.row_version) throw conflict('Someone changed this licence; reload it', { code: 'stale_version' });
    if (!a.organiser && !a.partnerCanAct) throw forbidden('Your role cannot act for the partner');
    checkTerms((await c.query('SELECT * FROM mr_packages WHERE id=$1', [a.lic.package_id])).rows[0], i);
    const side = a.organiser ? 'organiser' : 'partner';
    const row = (await c.query(
      `UPDATE mr_licences SET approved_rights=$2, approved_platforms=$3, territory_mode=$4, countries=$5, effective_from=$6, effective_to=$7, fee_minor=$8, currency=$9, note=$10, negotiation_ref=$11,
              proposed_by_side=$12, stage='negotiating', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [i.id, ...termsRow(i), side])).rows[0];
    await logMr(c, a.lic.event_id, 'licence', row.id, 'revised', { actor: user.id, detail: { side, rights: row.approved_rights, fee_minor: row.fee_minor, currency: row.currency, from: row.effective_from, to: row.effective_to } });
    const them = side === 'organiser' ? await partnerAdmins(c, a.lic.partner_id) : await eventOrganisers(c, a.ev);
    await tell(c, them, user.id, { kind: 'media_licence_revised', title: 'Media rights terms changed', body: `${a.lic.event_name}: revised terms for ${a.lic.partner_name} are waiting for your answer.`, data: { licence_id: row.id }, dedupe_key: `mr-revised:${row.id}:${row.row_version}` });
    return licRow(row.id, c);
  }),
});

const ACTIONS = z.enum(['accept', 'decline', 'suspend', 'reinstate', 'terminate']);
cap({
  name: 'decide_media_licence', method: 'POST', path: '/media/licences/:id/decision', tag: TAG,
  summary: 'Answer a licence. The side that did NOT make the latest offer accepts it (it becomes active, from its start date) or declines. The organiser can suspend, reinstate or terminate an active licence; the partner can terminate its own. Exclusive packages cannot overlap another licence on the same rights, platforms, territory and dates.',
  input: z.object({ id, action: ACTIONS, reason: text(500).optional(), row_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licenceAccess(user, i.id, c, { lock: true });
    const { lic } = a;
    if (lic.row_version !== i.row_version) throw conflict('Someone changed this licence; reload it', { code: 'stale_version' });
    const mySide = a.organiser ? 'organiser' : 'partner';
    if (mySide === 'partner' && !a.partnerCanAct) throw forbidden('Your role cannot act for the partner');
    const stage = lic.stage_now;
    let to;
    if (i.action === 'accept' || i.action === 'decline') {
      if (!['proposed', 'negotiating'].includes(stage)) throw conflict('Only a licence being agreed can be answered');
      if (i.action === 'accept' && lic.proposed_by_side === mySide) throw forbidden('The other side has to accept your offer');
      to = i.action === 'accept' ? 'active' : 'declined';
      if (to === 'active') {
        if (new Date(lic.effective_to) <= new Date()) throw conflict('These dates have already passed; revise them');
        const pkg = (await c.query('SELECT * FROM mr_packages WHERE id=$1', [lic.package_id])).rows[0];
        if (pkg.status === 'withdrawn') throw conflict('This package has been withdrawn');
        if ((await c.query("SELECT 1 FROM mr_licences WHERE package_id=$1 AND partner_id=$2 AND id <> $3 AND stage = 'active' AND tstzrange(effective_from, effective_to) && tstzrange($4, $5)", [lic.package_id, lic.partner_id, lic.id, lic.effective_from, lic.effective_to])).rowCount) throw conflict('This partner already holds this package for part of those dates; start the renewal when the current licence ends');
        const clash = await exclusivityConflicts(c, lic, pkg);
        if (clash.length) throw conflict('Another licence already holds overlapping exclusive rights', { code: 'exclusivity_conflict', conflicts: clash });
      }
    } else if (i.action === 'suspend') {
      if (!a.organiser) throw forbidden('Only the organiser can suspend a licence'); if (stage !== 'active') throw conflict('Only an active licence can be suspended'); to = 'suspended';
    } else if (i.action === 'reinstate') {
      if (!a.organiser) throw forbidden('Only the organiser can reinstate a licence'); if (stage !== 'suspended') throw conflict('Only a suspended licence can be reinstated'); to = 'active';
    } else {
      if (!['active', 'suspended'].includes(stage)) throw conflict('Only an active or suspended licence can be terminated'); to = 'terminated';
    }
    if (['decline', 'suspend', 'terminate'].includes(i.action) && !i.reason) throw badRequest('Say why', { code: 'reason_required' });
    const row = (await c.query(
      `UPDATE mr_licences SET stage=$2, decision_note=$3, decided_by=$4, decided_at=now(), ended_at=CASE WHEN $2 IN ('terminated','declined') THEN now() ELSE ended_at END, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [lic.id, to, i.reason ?? null, user.id])).rows[0];
    if (['terminated', 'suspended'].includes(to)) {   // a feed credential must stop with the licence, on every surface, straight away
      const g = (await c.query("UPDATE mr_feed_grants SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3 WHERE licence_id=$1 AND status='active' RETURNING api_token_id", [lic.id, user.id, `Licence ${to}`])).rows;
      if (g.length) await c.query('UPDATE api_tokens SET revoked_at=now() WHERE id = ANY($1) AND revoked_at IS NULL', [g.map((x) => x.api_token_id).filter(Boolean)]);
    }
    await logMr(c, lic.event_id, 'licence', lic.id, i.action, { actor: user.id, detail: { by: mySide, from: lic.stage, to, reason: i.reason ?? null } });
    const them = [...(await partnerAdmins(c, lic.partner_id)), ...(await eventOrganisers(c, a.ev))];
    await tell(c, them, user.id, { kind: `media_licence_${i.action}`, title: `Media licence ${to.replace('_', ' ')}`, body: `${lic.licence_no} · ${lic.event_name} · ${lic.partner_name}${i.reason ? `: ${i.reason}` : ''}`, data: { licence_id: lic.id }, dedupe_key: `mr-${i.action}:${lic.id}:${row.row_version}` });
    return licRow(row.id, c);
  }),
});

cap({
  name: 'link_media_licence_records', method: 'POST', path: '/media/licences/:id/records', tag: TAG,
  summary: 'Attach the executed legal terms to a licence: a contract reference and/or an agreement from the organisation agreements (it must belong to the event organisation or the partner). The legal text stays in Legal; this only points at it.',
  input: z.object({ id, contract_ref: text(120).nullish(), agreement_id: id.nullish() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licenceAccess(user, i.id, c, { lock: true });
    if (!a.organiser && !a.partnerCanAct) throw forbidden('Your role cannot do that');
    if (['declined', 'terminated', 'expired'].includes(a.lic.stage_now)) throw conflict('This licence has ended');
    if (i.agreement_id) {
      const ag = (await c.query('SELECT organisation_id, status, archived_at FROM org_agreements WHERE id=$1', [i.agreement_id])).rows[0];
      if (!ag || ag.archived_at || ![a.lic.event_org_id, a.lic.partner_org_id].includes(ag.organisation_id)) throw badRequest('Choose an agreement of the organiser or of the partner');
    }
    const row = (await c.query('UPDATE mr_licences SET contract_ref=$2, agreement_id=$3, updated_at=now() WHERE id=$1 RETURNING *', [i.id, i.contract_ref ?? a.lic.contract_ref, i.agreement_id === undefined ? a.lic.agreement_id : i.agreement_id])).rows[0];
    await logMr(c, a.lic.event_id, 'licence', row.id, 'records_linked', { actor: user.id, detail: { contract_ref: row.contract_ref, agreement_id: row.agreement_id } });
    return licRow(row.id, c);
  }),
});

cap({
  name: 'renew_media_licence', method: 'POST', path: '/media/licences/:id/renew', tag: TAG, status: 201,
  summary: 'Start a renewal of a licence that is active, expiring or has ended: a new proposal that points at the old one, with the same rights and a new window (and optionally a new fee). The old licence is left exactly as it was.',
  input: z.object({ id, effective_from: dt.optional(), effective_to: dt, fee_minor: z.number().int().min(0).max(1_000_000_000_000).optional(), note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await licenceAccess(user, i.id, c, { lock: true });
    if (!['active', 'expired', 'suspended'].includes(a.lic.stage_now)) throw conflict('Only an active, suspended or expired licence can be renewed');
    const side = a.organiser ? 'organiser' : 'partner';
    if (side === 'partner' && !a.partnerCanAct) throw forbidden('Your role cannot act for the partner');
    const pkg = (await c.query('SELECT * FROM mr_packages WHERE id=$1', [a.lic.package_id])).rows[0];
    if (pkg.status === 'withdrawn') throw conflict('This package has been withdrawn');
    const from = i.effective_from ?? a.lic.effective_to.toISOString();
    const t = { approved_rights: a.lic.approved_rights, approved_platforms: a.lic.approved_platforms, territory_mode: a.lic.territory_mode, countries: a.lic.countries, effective_from: from, effective_to: i.effective_to, fee_minor: i.fee_minor ?? Number(a.lic.fee_minor), currency: a.lic.currency, note: i.note, negotiation_ref: a.lic.negotiation_ref };
    checkTerms(pkg, t);
    let row;
    try {
      row = (await c.query(
        `INSERT INTO mr_licences(package_id, partner_id, licence_no, proposed_by_side, approved_rights, approved_platforms, territory_mode, countries, effective_from, effective_to, fee_minor, currency, note, negotiation_ref, proposed_by, renewal_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [pkg.id, a.lic.partner_id, await nextLicenceNo(c, a.lic.partner_id, new Date().getFullYear()), side, ...termsRow(t), user.id, a.lic.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('This partner already has an open licence on this package; let it end first, or revise it'); throw e; }
    await logMr(c, a.lic.event_id, 'licence', row.id, 'renewal_proposed', { actor: user.id, detail: { renewal_of: a.lic.id, side } });
    const them = side === 'organiser' ? await partnerAdmins(c, a.lic.partner_id) : await eventOrganisers(c, a.ev);
    await tell(c, them, user.id, { kind: 'media_licence_renewal', title: 'Media rights renewal', body: `${a.lic.event_name}: renewal of ${a.lic.licence_no} is waiting for your answer.`, data: { licence_id: row.id }, dedupe_key: `mr-renewal:${row.id}` });
    return licRow(row.id, c);
  }),
});

cap({
  name: 'get_media_licence', method: 'GET', path: '/media/licences/:id', tag: TAG,
  summary: 'One licence with its package, what it permits, the linked legal records, its feed credentials (no secrets), deliverables and full history. Visible to the organiser and to the partner\'s members only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await licenceAccess(user, i.id);
    const lic = a.lic;
    const agreement = lic.agreement_id ? (await one('SELECT id, title, kind, status, effective_from, effective_to FROM org_agreements WHERE id=$1', [lic.agreement_id])) : null;
    const [feeds, deliverables, streams] = await Promise.all([
      many("SELECT id, consumer_name, datasets, mode, rate_per_minute, daily_quota, valid_to, status, (status='active' AND valid_to > now()) AS usable FROM mr_feed_grants WHERE licence_id=$1 ORDER BY created_at DESC", [lic.id]),
      many('SELECT id, kind, title, status, due_at, sponsorship_id FROM mr_deliverables WHERE licence_id=$1 ORDER BY due_at NULLS LAST, created_at', [lic.id]),
      many("SELECT id, provider, fixture_id, state, scheduled_start, access_policy FROM mr_streams WHERE licence_id=$1 AND status='active' ORDER BY scheduled_start NULLS LAST", [lic.id]),
    ]);
    const can = { respond: ['proposed', 'negotiating'].includes(lic.stage_now) && lic.proposed_by_side !== (a.organiser ? 'organiser' : 'partner') && (a.organiser || a.partnerCanAct) };
    return { ...lic, as: { organiser: a.organiser, partner: !!a.partner, can_act: a.organiser || a.partnerCanAct }, can, agreement, feeds, deliverables, streams, history: await historyOf('licence', lic.id) };
  },
});

cap({
  name: 'list_media_licences', method: 'GET', path: '/events/:id/media/licences', tag: TAG,
  summary: 'Every licence on an event you organise, with partner, rights, window, fee and standing, and how many days are left.',
  input: z.object({ id, stage: z.enum(['proposed', 'negotiating', 'active', 'suspended', 'terminated', 'expired', 'declined']).optional(), ...page }),
  async handler({ user }, i) {
    await eventRow(user, i.id, null, { organiser: true });
    return many(`SELECT ${LIC_COLS} FROM ${LIC_FROM} WHERE p.event_id=$1 AND ($2::text IS NULL OR ${LIC_STAGE('l')}=$2) ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [i.id, i.stage ?? null, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ the media partner's workspace
cap({
  name: 'get_media_workspace', method: 'GET', path: '/media-workspace', tag: TAG,
  summary: 'Everything a media partner needs in one view: the rights it holds right now, the games and events those rights cover, the media it may use (with embargo and delay conditions), the production schedule and its crew\'s accreditation, the data feeds it can call, and notices (answers owed, licences about to expire). It reads only the licensed scope: a media agreement never opens a team, player or organisation record.',
  input: z.object({ partner_id: id.optional() }),
  async handler({ user }, i) {
    const partners = await myPartners(user);
    if (!partners.length) return { partners: [], partner: null, licences: [], notices: [] };
    const partner = partners.find((p) => p.partner_id === i.partner_id) ?? partners[0];
    if (i.partner_id && partner.partner_id !== i.partner_id) throw notFound('Media partner');
    const all = await many(`SELECT ${LIC_COLS} FROM ${LIC_FROM} WHERE l.partner_id=$1 ORDER BY l.effective_to DESC`, [partner.partner_id]);
    const live = all.filter((l) => l.in_force);
    const eventIds = [...new Set(live.map((l) => l.event_id))];
    const ents = (await entitlementsFor(user, { c: pool })).filter((e) => e.partner_id === partner.partner_id);
    const fixtures = eventIds.length ? await many(
      `SELECT f.id, f.event_id, f.scheduled_at, f.status, f.round, f.finished_at, h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji
         FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id JOIN events ev ON ev.id=f.event_id
        WHERE f.event_id = ANY($1) AND ev.status <> 'draft' AND f.status <> 'cancelled' ORDER BY f.scheduled_at LIMIT 300`, [eventIds]) : [];
    const inScope = (f) => ents.some((e) => e.event_id === f.event_id && (e.scope_kind !== 'fixture' || e.fixture_id === f.id));
    const scoped = fixtures.filter(inScope);
    const events = eventIds.length ? await many('SELECT e.id, e.name, e.status, e.starts_on, e.ends_on, e.banner_emoji, s.name AS sport, v.name AS venue FROM events e JOIN sports s ON s.id=e.sport_id LEFT JOIN venues v ON v.id=e.venue_id WHERE e.id = ANY($1) ORDER BY e.starts_on', [eventIds]) : [];
    const runSheet = eventIds.length ? await many(
      `SELECT r.id, r.event_id, r.fixture_id, r.phase, r.title, r.starts_at, r.ends_at, r.location, r.status FROM mr_run_items r WHERE r.event_id = ANY($1) AND r.status <> 'cancelled' AND r.ends_at > now() - interval '1 day' ORDER BY r.starts_at LIMIT 200`, [eventIds]) : [];
    const crew = await many(
      `SELECT c.id, c.event_id, c.fixture_id, c.role, c.status, c.call_time, c.zones, u.display_name, coalesce((SELECT m.accreditation FROM event_department_members m WHERE m.id=c.department_member_id), 'none') AS accreditation
         FROM mr_crew c JOIN users u ON u.id=c.user_id WHERE c.licence_id = ANY($1) AND c.status <> 'released' ORDER BY c.call_time NULLS LAST`, [all.map((l) => l.id)]);
    const feeds = await many(
      `SELECT g.id, g.licence_id, g.consumer_name, g.datasets, g.mode, g.rate_per_minute, g.daily_quota, g.valid_to, (g.status='active' AND g.valid_to > now()) AS usable,
              coalesce((SELECT sum(u.calls) FROM mr_feed_usage u WHERE u.grant_id=g.id AND u.day=current_date), 0)::int AS calls_today
         FROM mr_feed_grants g WHERE g.licence_id = ANY($1) ORDER BY g.created_at DESC`, [live.map((l) => l.id)]);
    const streams = eventIds.length ? await many(
      "SELECT id, event_id, fixture_id, provider, state, scheduled_start, scheduled_end, access_policy, licence_id, (playback_ref IS NOT NULL) AS has_playback FROM mr_streams WHERE event_id = ANY($1) AND status='active' ORDER BY scheduled_start NULLS LAST", [eventIds]) : [];
    const assetRows = eventIds.length ? await many(`SELECT ${ASSET_COLS} FROM mr_assets a WHERE a.event_id = ANY($1) AND a.status = 'published' AND a.audience <> 'private' ORDER BY a.created_at DESC LIMIT 200`, [eventIds]) : [];
    const media = [];
    for (const a of assetRows) {
      if (a.owner_partner_id !== partner.partner_id && a.audience !== 'public') {
        const inCollection = (await many('SELECT collection_id FROM mr_collection_items WHERE asset_id=$1 AND removed_at IS NULL', [a.id])).map((r) => r.collection_id);
        if (!ents.some((e) => licenceCovers(a, e, inCollection))) continue;
      }
      if (await assetState(a) !== 'live') continue;
      media.push({ id: a.id, event_id: a.event_id, fixture_id: a.fixture_id, kind: a.kind, right_kind: a.right_kind, title: a.title, credit: a.credit, platforms: a.platforms, publish_at: a.publish_at, expires_at: a.expires_at });
      if (media.length >= 60) break;
    }
    const dayMs = 86400000;
    const notices = [
      ...all.filter((l) => ['proposed', 'negotiating'].includes(l.stage) && l.proposed_by_side === 'organiser').map((l) => ({ kind: 'answer_owed', licence_id: l.id, text: `${l.event_name}: an offer is waiting for your answer` })),
      ...live.filter((l) => new Date(l.effective_to).getTime() - Date.now() < 30 * dayMs).map((l) => ({ kind: 'expiring', licence_id: l.id, text: `${l.event_name}: rights end in ${l.days_left} day${l.days_left === 1 ? '' : 's'}` })),
      ...crew.filter((c) => c.accreditation !== 'issued' && c.status !== 'declined').map((c) => ({ kind: 'accreditation', crew_id: c.id, text: `${c.display_name} (${c.role.replace('_', ' ')}) has no issued badge yet` })),
    ];
    const conditions = live.map((l) => ({ licence_id: l.id, event_id: l.event_id, delay_minutes: l.embargo_minutes, sublicensing: l.sublicensing,
      text: [LIVE_RIGHTS.some((r) => l.approved_rights.includes(r)) ? 'Live rights apply while the game is on.' : null,
        l.embargo_minutes && l.approved_rights.some((r) => !LIVE_RIGHTS.includes(r)) ? `Replay, highlights, clips and archive may be published ${l.embargo_minutes} minutes after a game ends.` : null,
        l.sublicensing === 'none' ? 'No sublicensing.' : l.sublicensing === 'with_approval' ? 'Sublicensing needs the organiser\'s approval.' : 'Sublicensing allowed.'].filter(Boolean).join(' ') }));
    return {
      partners, partner, licences: all, events, fixtures: scoped, run_sheet: runSheet, crew, feeds, streams, media, notices, conditions,
      summary: { held_now: live.length, awaiting_answer: all.filter((l) => ['proposed', 'negotiating'].includes(l.stage)).length, expiring_30d: notices.filter((n) => n.kind === 'expiring').length },
    };
  },
});

cap({
  name: 'list_open_rights_packages', method: 'GET', path: '/media-opportunities', tag: TAG,
  summary: 'Rights packages that organisers have opened to media partners, across events that are open or running, with what each offers. For partners looking for rights to apply for. Shows whether one of your partner organisations already has an offer on it.',
  input: z.object({ q: text(80).optional(), right: right.optional(), ...page }),
  async handler({ user }, i) {
    const mine = (await myPartners(user)).map((p) => p.partner_id);
    return many(
      `SELECT p.id, p.name, p.event_id, e.name AS event_name, e.starts_on, e.ends_on, s.name AS sport, p.scope_kind, p.rights, p.platforms, p.territory_mode, p.countries, p.exclusivity, p.valid_from, p.valid_to, p.embargo_minutes,
              EXISTS (SELECT 1 FROM mr_licences l WHERE l.package_id=p.id AND l.partner_id = ANY($1) AND l.stage IN ('proposed','negotiating','active','suspended')) AS already_involved
         FROM mr_packages p JOIN events e ON e.id=p.event_id JOIN sports s ON s.id=e.sport_id
        WHERE p.status='open' AND p.valid_to > now() AND e.status IN ('open','ongoing','paused') AND ($2::text IS NULL OR e.name ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR $3 = ANY(p.rights))
        ORDER BY e.starts_on NULLS LAST, p.created_at DESC LIMIT $4 OFFSET $5`, [mine, i.q ?? null, i.right ?? null, i.limit, i.offset]);
  },
});
