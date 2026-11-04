// Academy curriculum licensing & content marketplace (#804): the rules. Nothing here copies content: a pack item REFERENCES a published curriculum /
// methodology version (#782); entitlement is read live from the licence row on every request; money is canonical payments + the finance ledger
// (purpose 'content_licence'); territory arithmetic is src/media-rights.js. The capability surface is src/capabilities/academy-content.js.
import { pool } from './db.js';
import { AppError, conflict, forbidden, notFound } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { audit } from './helpers.js';
import { notify } from './notify.js';
import { opsAccess } from './academy-ops.js';
import { orgFor } from './org-access.js';
import { territoryWithin, terr } from './media-rights.js';

export const ITEM_KINDS = ['curriculum', 'methodology', 'drill', 'module', 'video', 'document'];
export const ELIGIBILITY = ['open', 'affiliated', 'invited'];
export const REASONS = ['non_payment', 'breach', 'rights_dispute', 'safeguarding', 'requested_by_licensee', 'end_of_term', 'other'];
export const CASE_KINDS = ['support', 'takedown', 'rights_dispute', 'safeguarding', 'billing'];
export const LICENCE_ACTIONS = ['suspend', 'reinstate', 'revoke'];
const DAY = 86400000;
/** pg hands a `date` column back as a local-midnight Date: read its calendar day, not its UTC instant. */
export const ymd = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

// ------------------------------------------------------------------------------------------------------------------ who may do what
/** Publishing authority: owners/admins, or a staff member holding the `curriculum` permission. Read live. */
export async function publisherAccess(user, orgId, { write = false, c } = {}) {
  const a = await opsAccess(user, orgId, { write, c });
  return a.need('curriculum');
}
/** Buying authority (accept terms, pay, assign seats): the organisation's owners and admins. */
export const buyerAccess = (user, orgId, { write = false, c } = {}) => orgFor(user, orgId, ['owner', 'admin'], { write, c });

export const stageNow = (l) => {
  if (!['active', 'suspended'].includes(l.stage) || !l.effective_to) return l.stage;
  const end = new Date(`${ymd(l.effective_to)}T23:59:59Z`).getTime();
  if (Date.now() <= end) return l.stage;
  return l.stage === 'active' && Date.now() <= end + (l.grace_days ?? 0) * DAY ? 'grace' : 'expired';
};
const readable = (s) => ['active', 'grace'].includes(s);

export async function orgCountry(c, orgId) {
  return (await c.query("SELECT country FROM addresses WHERE owner_kind='organisation' AND owner_id=$1 AND country IS NOT NULL ORDER BY (kind='billing') DESC, created_at LIMIT 1", [orgId])).rows[0]?.country ?? null;
}

/** May this organisation buy this pack? Eligibility + territory, decided on the server from live records. Returns null when yes, otherwise the reason. */
export async function whyNotEligible(c, pack, buyerOrgId) {
  if (pack.organisation_id === buyerOrgId) return 'This is your own academy’s pack';
  if (pack.status !== 'published') return 'This pack is not published';
  const org = (await c.query('SELECT id, parent_organisation_id, status FROM organisations WHERE id=$1', [buyerOrgId])).rows[0];
  if (!org || org.status !== 'active') return 'The organisation is not active';
  if (pack.territory_mode !== 'worldwide') {
    const cc = await orgCountry(c, buyerOrgId);
    if (!cc) return 'Add the organisation’s country to its address to check territory';
    const ok = pack.territory_mode === 'include' ? pack.countries.includes(cc) : !pack.countries.includes(cc);
    if (!ok) return `This pack is not released in ${cc}`;
  }
  if (pack.eligibility === 'affiliated') {
    const network = org.parent_organisation_id === pack.organisation_id;
    const aff = network || (await c.query("SELECT 1 FROM fed_affiliations WHERE organisation_id=$1 AND status='approved' AND (effective_from IS NULL OR effective_from <= current_date) AND (effective_to IS NULL OR effective_to >= current_date) LIMIT 1", [buyerOrgId])).rowCount > 0;
    if (!aff) return 'This pack is open to affiliated organisations only';
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ the entitlement check
/** Everything that decides whether `user` may read `itemId` under `licenceId`, evaluated now. Throws 404 (never 403) when the caller has no business knowing. */
export async function entitlement(c, user, licenceId, itemId = null, { offline = false } = {}) {
  const l = (await c.query('SELECT l.*, p.organisation_id AS publisher_org, p.status AS pack_status, p.current_version, p.title AS pack_title, p.offline_allowed AS pack_offline FROM academy_content_licences l JOIN academy_content_packs p ON p.id=l.pack_id WHERE l.id=$1', [licenceId])).rows[0];
  if (!l) throw notFound('Licence');
  const member = (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [l.licensee_org_id, user.id])).rowCount > 0;
  const seat = (await c.query("SELECT 1 FROM academy_content_seats WHERE licence_id=$1 AND user_id=$2 AND status='active'", [l.id, user.id])).rowCount > 0;
  if (!member || !seat) throw notFound('Licence');
  const state = stageNow(l);
  if (!readable(state)) throw new AppError(402, 'licence_inactive', `This licence is ${state === 'awaiting_payment' ? 'waiting for payment' : state}; ask your academy administrator to renew it`, { stage: state });
  if (l.pack_status === 'retired' && l.stage !== 'active') throw new AppError(402, 'licence_inactive', 'This pack has been withdrawn');
  const cc = l.territory_mode === 'worldwide' ? null : await orgCountry(c, l.licensee_org_id);
  if (l.territory_mode !== 'worldwide' && (!cc || (l.territory_mode === 'include' ? !l.countries.includes(cc) : l.countries.includes(cc)))) throw new AppError(402, 'out_of_territory', 'This licence does not cover your organisation’s territory');
  const version = l.pinned_version ?? l.current_version;
  const v = (await c.query("SELECT * FROM academy_content_pack_versions WHERE pack_id=$1 AND version=$2 AND status IN ('published','superseded')", [l.pack_id, version])).rows[0];
  if (!v) throw new AppError(402, 'not_published', 'No published version is available under this licence');
  let item = null;
  if (itemId) {
    item = (await c.query('SELECT * FROM academy_content_pack_items WHERE id=$1 AND version_id=$2', [itemId, v.id])).rows[0];
    if (!item) throw notFound('Item');
    if ((await c.query('SELECT 1 FROM academy_content_takedowns WHERE item_id=$1 AND lifted_at IS NULL', [item.id])).rowCount) throw new AppError(410, 'item_withdrawn', 'The publisher has withdrawn this item');
    if (offline && (item.youth_footage || !l.offline_allowed)) throw new AppError(403, 'offline_not_allowed', item.youth_footage ? 'Footage showing young people can only be streamed' : 'Offline access is not part of this licence');
  }
  return { licence: l, state, version: v, item };
}

/** Resolve what a pack item points at, read-only and only if published: the referenced curriculum / methodology content is never copied into the buyer's tables. */
export async function resolveReference(c, item) {
  if (item.kind === 'curriculum') {
    const r = (await c.query("SELECT v.version, v.objectives, v.phases, v.effective_from, cu.title, cu.age_min, cu.age_max, cu.level_key FROM academy_curriculum_versions v JOIN academy_curricula cu ON cu.id=v.curriculum_id WHERE v.id=$1 AND v.status IN ('published','superseded')", [item.ref_id])).rows[0];
    return r ?? null;
  }
  if (item.kind === 'methodology' || item.kind === 'drill') {
    const r = (await c.query('SELECT m.title, mv.version, mv.philosophy, mv.competencies, mv.drills, mv.stages, mv.game_model, mv.standards FROM academy_methodology_versions mv JOIN academy_methodologies m ON m.id=mv.methodology_id WHERE mv.methodology_id=$1 AND mv.version=$2', [item.ref_id, item.ref_version])).rows[0];
    if (!r) return null;
    if (item.kind === 'drill') return { title: r.title, version: r.version, drill: (r.drills ?? []).find((d) => d.key === item.ref_key) ?? null };
    return r;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ licence history, seats, consumption
export const logLicence = (c, licenceId, actorId, action, detail = {}) =>
  c.query('INSERT INTO academy_content_licence_events(licence_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [licenceId, actorId, action, detail]);

export const seatsUsed = async (c, licenceId) => (await c.query("SELECT count(*)::int AS n FROM academy_content_seats WHERE licence_id=$1 AND status='active'", [licenceId])).rows[0].n;

/** The licence is over (revoked, expired, withdrawn): seats are released and offline grants are revoked in the same transaction. Rows are kept. */
export async function endAccess(c, licenceId) {
  await c.query("UPDATE academy_content_offline_grants SET revoked_at=now() WHERE licence_id=$1 AND revoked_at IS NULL", [licenceId]);
}

/** A pending renewal (or first purchase) became active: the previous licence for this buyer ends and its seats move across. */
export async function activateLicence(c, licenceId, actorId) {
  const cur = (await c.query("SELECT renewal_of FROM academy_content_licences WHERE id=$1 AND stage IN ('proposed','awaiting_payment') FOR UPDATE", [licenceId])).rows[0];
  if (!cur) return false;
  // the licence being renewed ends first (one running licence per pack and buyer), and its seats move across
  const old = cur.renewal_of ? (await c.query("UPDATE academy_content_licences SET stage='expired', updated_at=now(), row_version=row_version+1 WHERE id=$1 AND stage IN ('active','suspended','expired') RETURNING id", [cur.renewal_of])).rows[0] : null;
  const l = (await c.query("UPDATE academy_content_licences SET stage='active', paid_at=coalesce(paid_at, CASE WHEN price_minor>0 THEN now() END), updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [licenceId])).rows[0];
  if (old) {
    await c.query("INSERT INTO academy_content_seats(licence_id, user_id, assigned_by) SELECT $1, user_id, assigned_by FROM academy_content_seats WHERE licence_id=$2 AND status='active' ON CONFLICT DO NOTHING", [licenceId, old.id]);
    await c.query("UPDATE academy_content_seats SET status='released', released_at=now() WHERE licence_id=$1 AND status='active'", [old.id]);
    await endAccess(c, old.id);
    await logLicence(c, old.id, actorId, 'renewed', { by: licenceId });
  }
  await logLicence(c, licenceId, actorId, 'activated', { paid: Number(l.price_minor) > 0 });
  return l;
}

/** The checkout was paid: the licence becomes active. False when it can no longer be fulfilled (withdrawn meanwhile), so the payment is refunded. */
export async function fulfilContentLicencePaid(c, licenceId, payerId) {
  const l = await activateLicence(c, licenceId, payerId);
  if (!l) return false;
  const p = (await c.query('SELECT p.organisation_id, p.title FROM academy_content_packs p WHERE p.id=$1', [l.pack_id])).rows[0];
  const admins = (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [p.organisation_id])).rows;
  for (const a of admins) await notify(c, a.user_id, { kind: 'content_licence_paid', title: 'Content licence paid', body: `A licence for “${p.title}” was paid and is now active.`, data: { licence_id: l.id }, dedupe_key: `content-licence-paid:${l.id}:${a.user_id}` });
  return true;
}

/** Sweep (run from the worker): licences past their window and grace end; seats stay as history but grants are revoked. Idempotent. */
export async function expireAcademyContent(c = pool) {
  const due = (await c.query("SELECT id FROM academy_content_licences WHERE stage IN ('active','suspended') AND effective_to IS NOT NULL AND effective_to + grace_days < current_date")).rows;
  for (const { id } of due) {
    await c.query("UPDATE academy_content_licences SET stage='expired', updated_at=now(), row_version=row_version+1 WHERE id=$1 AND stage IN ('active','suspended')", [id]);
    await endAccess(c, id);
    await logLicence(c, id, null, 'expired', {});
  }
  const offline = await c.query('UPDATE academy_content_offline_grants SET revoked_at=now() WHERE revoked_at IS NULL AND expires_at < now()');
  return { expired: due.length, offline_lapsed: offline.rowCount };
}


// ------------------------------------------------------------------------------------------------------------------ the coaching workflow
/** The text of a licensed item as plan blocks for the coach's own coaching record (the same record "Load drills" writes to, #782).
 *  `copy` writes the instructions into the block (only when the licence lets the coach keep an offline copy); otherwise the block is a titled
 *  reference whose text is read live through the licence. Footage and documents are never plan blocks. */
export function planBlocks(item, ref, licenceId, { copy }) {
  const tags = (n) => [`item:${item.id}`, `i:${n}`, `licence:${licenceId}`, 'licensed'];
  const live = 'Licensed content: open it from the session’s Licensed content panel.';
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const out = [];
  if (item.kind === 'drill' && ref?.drill) {
    const d = ref.drill;
    out.push({ kind: d.kind ?? 'skill_drill', title: clip(d.title ?? item.title, 120), duration_min: d.duration_min ?? item.minutes ?? 10, tags: tags(0),
      ...(copy ? { instructions: clip(d.instructions, 2000), setup: clip(d.setup, 500), cues: (d.cues ?? []).slice(0, 10).map((x) => clip(x, 200)), success_criteria: clip(d.success_criteria, 500), area: clip(d.area, 120), equipment: (d.equipment ?? []).slice(0, 15).map((x) => clip(x, 60)), work_rest: clip(d.work_rest, 60), progression: clip(d.progression, 300), regression: clip(d.regression, 300) } : { instructions: live }) });
  } else if (item.kind === 'curriculum' && ref?.objectives) {
    ref.objectives.slice(0, 12).forEach((o, n) => out.push({ kind: 'custom', title: clip(o.title, 120), objective: clip(o.title, 500), duration_min: 10, trains: o.competency_key ? [String(o.competency_key).slice(0, 40)] : undefined, tags: tags(n),
      ...(copy ? { success_criteria: clip(o.success_criteria, 500), target_rpe: o.rpe_target >= 1 && o.rpe_target <= 10 ? Math.round(o.rpe_target) : undefined } : { instructions: live }) }));
  } else if (item.kind === 'module') {
    const text = (item.body?.blocks ?? []).map((b) => b.text).join('\n\n');
    out.push({ kind: 'custom', title: clip(item.title, 120), duration_min: item.minutes ?? 10, tags: tags(0), instructions: copy ? clip(text, 2000) : live });
  }
  return out.map((b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== null)));
}

export const termEnd = (from, months) => addMonths(from, months);
export const dayStart = today;
export { territoryWithin, terr, audit, encrypt, decrypt, conflict, forbidden, notFound };
