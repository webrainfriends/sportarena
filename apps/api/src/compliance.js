// Compliance, safeguarding & eligibility (#595): the one engine that decides, explains and gates. Nothing here is specific to a sport, a module or a
// regulator: a requirement says WHAT is needed, an obligation says WHO must have it and WHAT an unmet one blocks, and a record is what the subject has
// provided. Existing records are REFERENCED live, never copied: a platform verification (verification_cases), a federation licence (fed_licences) and a
// supplier credential (svc_credentials) can each satisfy a requirement ("linked"), so expiry or revocation there applies here on the next read.
//
// Subject states (deterministic, same inputs -> same output):
//   met | expiring (valid, inside the reminder window) | grace (expired, inside the grace period) | pending_review | missing | expired | rejected | revoked | waived
//   blocking = a mandatory obligation in missing / expired / rejected / revoked.   decision: blocked > pending (something awaits a reviewer) > clear.
import { pool } from './db.js';
import { decrypt } from './crypto.js';
import { isAdmin } from './helpers.js';
import { conflict } from './errors.js';
import { orgRole } from './org-access.js';
import { isYouth, canSeeYouth, guardianLink } from './youth.js';
import { engagementsOf, ENGAGEMENTS } from './accreditation.js';
import { authority, can, LIC_STATUS } from './federation.js';
import { TYPES as VERIFICATION_TYPES } from './verification.js';
import { roles as GLOBAL_ROLES } from './registry.js';
import { CLASS_LABEL, STATUS_OF, applicability, factsFor, namesDimension, settleTopics, statusCounts } from './compliance-policy.js';

export const CATEGORIES = {
  qualification: 'Qualification or certificate', background_check: 'Background check status', safeguarding_training: 'Safeguarding training',
  safeguarding_acknowledgement: 'Safeguarding acknowledgement', federation_requirement: 'Federation or competition requirement', event_permit: 'Event permit',
  insurance: 'Insurance', licence: 'Licence', declaration: 'Declaration', conflict_of_interest: 'Conflict of interest', attestation: 'Attestation', other: 'Other requirement',
};
/** Categories whose reference is never shown to anyone but the holder (and their guardian). */
export const SENSITIVE_CATEGORIES = ['background_check'];
export const CONSEQUENCES = {
  youth_contact: 'Contact with young people (team chat, recruiter and sponsor messages)',
  youth_access: 'Access to young people\'s profiles and records as a team coach or manager',
  registration: 'Competition registration and match-day eligibility',
  accreditation: 'Event accreditation and gate access',
  event_open: 'Opening an event for entries',
  event_start: 'Starting an event',
  tender_award: 'Recommending a tender award (the supplier, and the event it serves)',
};
export const SCOPES = ['platform', 'organisation', 'body', 'event'];
export const SUBJECTS = ['person', 'organisation', 'event'];
export const METHODS = { evidence: 'Evidence a reviewer approves', declaration: 'Declaration the person makes', linked: 'Checked from an existing record' };
export const SOURCE_KINDS = {
  verification: 'Platform verification', federation_licence: 'Federation licence', service_credential: 'Supplier credential',
};
const BAD = ['missing', 'expired', 'rejected', 'revoked'];
export const NEVER_WAIVABLE_CLASSES = ['legal_mandatory', 'regulatory'];       // a law or a regulation is not the organisation's to waive
export const STATE_LABEL = {
  unknown: 'Cannot be judged yet', met: 'Met', expiring: 'Expiring soon', grace: 'Expired – in grace period', pending_review: 'Awaiting review', missing: 'Missing', expired: 'Expired', rejected: 'Not accepted', revoked: 'Revoked', waived: 'Waived',
};

const dayMs = 864e5;
/** 17 Oct 2026: dates inside explanations are read by people, not parsed. */
const nice = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const asDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const between = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const todayOf = async (c) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

/** Roles you can aim an obligation at, per scope kind: always read from here so the app offers real choices and never a typed role. */
export function roleChoices(scopeKind, subjectKind) {
  if (subjectKind === 'organisation') return [...['club', 'academy', 'school', 'other'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })), { value: 'supplier', label: 'Supplier bidding on a tender' }];
  if (subjectKind === 'event') return ['tournament', 'league', 'friendly', 'camp', 'trial'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
  const label = (k) => k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
  const globals = GLOBAL_ROLES.filter((r) => !['admin', 'platform_admin'].includes(r)).map((r) => ({ value: r, label: label(r) }));
  if (scopeKind === 'event') return Object.entries(ENGAGEMENTS).map(([value, e]) => ({ value, label: e.label, hint: e.description }));
  if (scopeKind === 'body') return ['athlete', 'coach', 'official', 'administrator', 'other'].map((v) => ({ value: v, label: label(v) }));
  if (scopeKind === 'organisation') return [...['owner', 'admin', 'coach', 'finance'].map((v) => ({ value: v, label: label(v) })), ...globals.filter((g) => g.value !== 'coach')];
  return globals;
}

// ---------------------------------------------------------------- who manages a scope
/** Names for scopes (shown next to a requirement so a person knows who asks for it). */
export async function scopeName(c, kind, id) {
  if (kind === 'platform') return 'SportArena';
  const q = kind === 'organisation' ? 'SELECT name FROM organisations WHERE id=$1' : kind === 'event' ? 'SELECT name FROM events WHERE id=$1' : 'SELECT o.name FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE b.id=$1';
  return (await c.query(q, [id])).rows[0]?.name ?? null;
}

/**
 * May `user` run this scope's compliance? Read live on every call. `write` = define requirements, decide records, grant waivers; otherwise reading
 * statuses and queues. Platform scope belongs to the platform team only; organisation scope to owners and admins; event scope to the organiser (or the
 * organising organisation's owners and admins); body scope to the body's administrators and its licensing / registrar roles (read adds compliance and auditors).
 */
export async function manages(user, scopeKind, scopeId, { write = false, c = pool } = {}) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (scopeKind === 'platform') return false;
  if (scopeKind === 'organisation') return ['owner', 'admin'].includes(await orgRole(user, scopeId, c));
  if (scopeKind === 'event') {
    const ev = (await c.query('SELECT organizer_id, organisation_id FROM events WHERE id=$1', [scopeId])).rows[0];
    if (!ev) return false;
    if (ev.organizer_id === user.id) return true;
    return ev.organisation_id ? ['owner', 'admin'].includes(await orgRole(user, ev.organisation_id, c)) : false;
  }
  const auth = await authority(user, scopeId, { c, optional: true });
  if (!auth) return false;
  if (auth.admin) return true;
  if (auth.viaAncestor) return false;
  return write ? auth.roles.some((r) => ['licensing', 'registrar'].includes(r.role)) : can(auth, 'evidence') || can(auth, 'reports');
}

/** People to tell about a scope: its managers (organisation owners and admins, the event organiser, body administrators, the platform team). */
export async function managerIds(c, scopeKind, scopeId) {
  if (scopeKind === 'platform') return (await c.query("SELECT id FROM users WHERE 'admin' = ANY(roles)")).rows.map((r) => r.id);
  if (scopeKind === 'organisation') return (await c.query("SELECT user_id AS id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [scopeId])).rows.map((r) => r.id);
  if (scopeKind === 'event') {
    return (await c.query(
      `SELECT e.organizer_id AS id FROM events e WHERE e.id=$1
       UNION SELECT m.user_id FROM events e JOIN organisation_members m ON m.organisation_id=e.organisation_id AND m.status='active' AND m.role IN ('owner','admin') WHERE e.id=$1`, [scopeId])).rows.map((r) => r.id);
  }
  return (await c.query(
    `SELECT m.user_id AS id FROM governing_bodies b JOIN organisation_members m ON m.organisation_id=b.organisation_id AND m.status='active' AND m.role IN ('owner','admin') WHERE b.id=$1
     UNION SELECT r.user_id FROM governing_body_roles r WHERE r.body_id=$1 AND r.status='active' AND r.role IN ('licensing','registrar')`, [scopeId])).rows.map((r) => r.id);
}

/** May `user` see/act for this subject as the holder: themself, a verified guardian of a young person, an organisation's owner/admin, an event's organiser. */
export async function holderAccess(user, subjectKind, subjectId, c = pool) {
  if (!user) return null;
  if (subjectKind === 'person') {
    if (user.id === subjectId) return 'self';
    if (await guardianLink(user.id, subjectId, c)) return 'guardian';
    return isAdmin(user) ? 'admin' : null;
  }
  if (isAdmin(user)) return 'admin';
  if (subjectKind === 'organisation') return ['owner', 'admin'].includes(await orgRole(user, subjectId, c)) ? 'manager' : null;
  return (await manages(user, 'event', subjectId, { c })) ? 'manager' : null;
}

// ---------------------------------------------------------------- linked sources (read live, never copied)
const SOURCES = {
  /** A platform verification (coach, physio, doctor …) approved, unexpired and unrevoked. */
  async verification(c, subject, src) {
    const type = src.type;
    const st = subject.kind === 'person' ? 'user' : subject.kind;
    const r = (await c.query(
      `SELECT id, status, decided_at::date::text AS issued_on, expires_at::date::text AS expires_on FROM verification_cases
        WHERE subject_type=$1 AND subject_id=$2 AND type=$3 ORDER BY (status='approved') DESC, submitted_at DESC LIMIT 1`, [st, subject.id, type])).rows[0];
    if (!r) return { raw: 'missing', where: 'Me → Onboarding & verification' };
    const ref = { kind: 'verification', id: r.id };
    if (r.status === 'approved') return { raw: 'valid', issued_on: r.issued_on, expires_on: r.expires_on, ref };
    if (['submitted', 'in_review', 'needs_info'].includes(r.status)) return { raw: 'pending', ref };
    return { raw: r.status === 'revoked' ? 'revoked' : 'rejected', ref };
  },
  /** A federation licence of a chosen type (or any licence of a body) that is active and unexpired. */
  async federation_licence(c, subject, src) {
    if (subject.kind !== 'person') return { raw: 'missing' };
    const r = (await c.query(
      `SELECT l.id, ${LIC_STATUS('l')} AS status, l.issued_on::text AS issued_on, l.expires_on::text AS expires_on FROM fed_licences l
        WHERE l.holder_id=$1 AND ($2::uuid IS NULL OR l.type_id=$2) AND ($3::uuid IS NULL OR l.body_id=$3) AND l.status <> 'draft'
        ORDER BY (${LIC_STATUS('l')}='active') DESC, l.created_at DESC LIMIT 1`, [subject.id, src.licence_type_id ?? null, src.body_id ?? null])).rows[0];
    if (!r) return { raw: 'missing', where: 'Federation → Licences' };
    const ref = { kind: 'federation_licence', id: r.id };
    if (r.status === 'active') return { raw: 'valid', issued_on: r.issued_on, expires_on: r.expires_on, ref };
    if (['submitted', 'under_review', 'needs_info'].includes(r.status)) return { raw: 'pending', ref };
    if (r.status === 'expired') return { raw: 'valid', issued_on: r.issued_on, expires_on: r.expires_on ?? addDays(asDay(new Date()), -1), ref };
    return { raw: r.status === 'revoked' ? 'revoked' : 'rejected', ref };
  },
  /** A supplier credential (first aid, safeguarding, insurance …). Only credentials somebody actually checked count; a self-declared one waits for a check. */
  async service_credential(c, subject, src) {
    const own = subject.kind === 'organisation' ? 'p.organisation_id = $1' : 'p.owner_id = $1';
    if (subject.kind === 'event') return { raw: 'missing' };
    const r = (await c.query(
      `SELECT k.id, k.verification, k.valid_from::text AS issued_on, k.valid_to::text AS expires_on FROM svc_credentials k JOIN svc_profiles p ON p.id=k.profile_id
        WHERE ${own} AND k.kind=$2 AND k.status='active' ORDER BY (k.verification <> 'self_declared') DESC, k.valid_to DESC NULLS FIRST LIMIT 1`, [subject.id, src.credential_kind])).rows[0];
    if (!r) return { raw: 'missing', where: 'Services → Credentials' };
    const ref = { kind: 'service_credential', id: r.id };
    return r.verification === 'self_declared' ? { raw: 'pending', ref } : { raw: 'valid', issued_on: r.issued_on, expires_on: r.expires_on, ref };
  },
};
export const sourceProblems = (src) => {
  if (src?.kind === 'verification') return VERIFICATION_TYPES.includes(src.type) ? null : 'Choose which platform verification satisfies this';
  if (src?.kind === 'federation_licence') return src.licence_type_id || src.body_id ? null : 'Choose the licence type or governing body';
  if (src?.kind === 'service_credential') return src.credential_kind ? null : 'Choose the credential type';
  return 'Choose the existing record that satisfies this';
};

// ---------------------------------------------------------------- which obligations apply to a subject
const youthSql = (a) => `(${a}.youth_until IS NOT NULL AND ${a}.youth_until > current_date)`;

/** Adults who lead, coach or manage young people in the scope (teams of the organisation, accepted teams of the event, or anywhere for platform and body scopes). */
async function worksWithYouth(c, userId, scopeKind, scopeId) {
  if ((await c.query(`SELECT 1 FROM users u WHERE u.id=$1 AND ${youthSql('u')}`, [userId])).rowCount) return false;
  const scope = scopeKind === 'organisation' ? 'AND t.organisation_id = $2' : scopeKind === 'event' ? 'AND t.id IN (SELECT team_id FROM event_entries WHERE event_id=$2 AND status=\'accepted\' AND team_id IS NOT NULL)' : '';
  const r = await c.query(
    `SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id AND m.status='active' JOIN users y ON y.id=m.user_id AND ${youthSql('y')}
      WHERE (t.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members s WHERE s.team_id=t.id AND s.user_id=$1 AND s.status='active' AND s.role IN ('coach','manager'))) ${scope} LIMIT 1`,
    scope ? [userId, scopeId] : [userId]);
  if (r.rowCount) return true;
  if (scopeKind !== 'event') return false;
  // staff and officials of an event that has young participants
  return !!(await c.query(
    `SELECT 1 FROM event_entries en JOIN users y ON y.id = en.user_id AND ${youthSql('y')} WHERE en.event_id=$1 AND en.status='accepted'
     UNION SELECT 1 FROM event_entries en JOIN team_members m ON m.team_id=en.team_id AND m.status='active' JOIN users y ON y.id=m.user_id AND ${youthSql('y')} WHERE en.event_id=$1 AND en.status='accepted' LIMIT 1`, [scopeId])).rowCount;
}

const OB_SQL = `SELECT o.id AS ob_id, o.roles AS ob_roles, o.sport_id AS ob_sport_id, o.youth_work, o.mandatory, o.consequences, o.starts_on::text AS starts_on, o.ends_on::text AS ends_on,
                       o.country AS ob_country, o.region AS ob_region, o.municipality AS ob_municipality, o.body_ids, o.competition_ids, o.venue_ids, o.event_types, o.min_age, o.max_age, r.*
                  FROM comp_obligations o JOIN comp_requirements r ON r.id = o.requirement_id
                 WHERE (o.archived_at IS NULL OR o.archived_at::date > $2::date) AND (r.archived_at IS NULL OR r.archived_at::date > $2::date) AND r.approval_status = 'approved'
                   AND r.subject_kind = $1 AND o.starts_on <= $2::date AND (o.ends_on IS NULL OR o.ends_on >= $2::date)`;

/**
 * The obligations that apply to this subject right now. Persons are placed in each scope from the canonical records (organisation membership,
 * event engagements, federation licences, global roles), so nothing is copied and leaving the organisation or the event ends the obligation.
 * `scope` ({kind, id}) narrows to one scope (a manager's view); `consequence` keeps only obligations that block that thing.
 */
export async function applicable(c, subject, { scope = null, consequence = null, scopes = null, asOf = null, context = null, forced = null, forcedRoles = [], actor = null } = {}) {
  const day = asOf ?? await todayOf(c);
  let rows = (await c.query(OB_SQL, [subject.kind, day])).rows;
  if (scope) rows = rows.filter((r) => r.scope_kind === scope.kind && (scope.id ? r.scope_id === scope.id : r.scope_kind === 'platform'));
  if (scopes) rows = rows.filter((r) => scopes.some((s) => s.kind === r.scope_kind && (s.id ?? null) === (r.scope_id ?? null)));
  if (consequence) rows = rows.filter((r) => r.consequences.includes(consequence));
  if (!rows.length) return [];

  const place = new Map(); // `${kind}:${id}` -> Set(roles) | null when the subject is not in that scope
  const key = (r) => `${r.scope_kind}:${r.scope_id ?? ''}`;
  const keys = [...new Set(rows.map(key))];
  const sportsOf = subject.kind === 'person' ? new Set((await c.query('SELECT sport_id FROM sport_profiles WHERE user_id=$1 AND archived_at IS NULL', [subject.id])).rows.map((x) => x.sport_id)) : new Set();
  const u = subject.kind === 'person' ? (await c.query('SELECT roles FROM users WHERE id=$1', [subject.id])).rows[0] : null;
  let org = null, ev = null;
  if (subject.kind === 'organisation') org = (await c.query('SELECT id, kind, status FROM organisations WHERE id=$1', [subject.id])).rows[0];
  if (subject.kind === 'event') ev = (await c.query('SELECT id, kind, sport_id, organisation_id FROM events WHERE id=$1', [subject.id])).rows[0];

  for (const k of keys) {
    const [kind, id] = k.split(':');
    if (subject.kind === 'person') {
      if (kind === 'platform') place.set(k, new Set(u?.roles ?? []));
      else if (kind === 'organisation') {
        const m = (await c.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [id, subject.id])).rows[0];
        place.set(k, m ? new Set([m.role, ...(u?.roles ?? [])]) : null);
      } else if (kind === 'event') {
        const e = (await c.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
        const eng = e ? await engagementsOf(c, e, subject.id) : new Set();
        place.set(k, eng.size ? eng : null);
      } else {
        const l = (await c.query(
          `SELECT DISTINCT t.holder_role FROM fed_licences l JOIN fed_licence_types t ON t.id=l.type_id WHERE l.body_id=$1 AND l.holder_id=$2 AND l.status NOT IN ('draft','rejected','withdrawn')`, [id, subject.id])).rows;
        place.set(k, l.length ? new Set(l.map((x) => x.holder_role)) : null);
      }
    } else if (subject.kind === 'organisation') {
      if (!org) { place.set(k, null); continue; }
      const here = kind === 'platform' || (kind === 'organisation' && id === org.id)
        || (kind === 'body' && (await c.query("SELECT 1 FROM fed_affiliations WHERE body_id=$1 AND organisation_id=$2 AND status IN ('approved','suspended')", [id, org.id])).rowCount > 0);
      place.set(k, here ? new Set([org.kind]) : null);
    } else {
      if (!ev) { place.set(k, null); continue; }
      const here = kind === 'platform' || (kind === 'event' && id === ev.id) || (kind === 'organisation' && id === ev.organisation_id)
        || (kind === 'body' && (await c.query("SELECT 1 FROM fed_affiliations WHERE body_id=$1 AND organisation_id=$2 AND status IN ('approved','suspended')", [id, ev.organisation_id]).catch(() => ({ rowCount: 0 }))).rowCount > 0);
      place.set(k, here ? new Set([ev.kind]) : null);
    }
  }

  if (forced) for (const k of keys) if (forced.has(k)) place.set(k, new Set([...(place.get(k) ?? []), ...forcedRoles]));

  const out = [];
  for (const r of rows) {
    const have = place.get(key(r));
    if (!have) continue;
    if (r.ob_roles.length && !r.ob_roles.some((x) => have.has(x))) continue;
    if (r.ob_sport_id) {
      const sport = subject.kind === 'person' ? sportsOf.has(r.ob_sport_id) || (r.scope_kind === 'event' && (await c.query('SELECT 1 FROM events WHERE id=$1 AND sport_id=$2', [r.scope_id, r.ob_sport_id])).rowCount > 0) : ev?.sport_id === r.ob_sport_id;
      if (!sport) continue;
    }
    if (r.youth_work && !(subject.kind === 'person' && await worksWithYouth(c, subject.id, r.scope_kind, r.scope_id))) continue;
    out.push(r);
  }

  // the policy layer: jurisdiction, governing bodies, competitions, venues, event types and age, judged against facts read live. A rule that names none
  // of these costs nothing here. Then rules of one topic compete (see compliance-policy.js).
  let facts = null;
  const judged = [], excluded = [];
  for (const r of out) {
    if (!namesDimension(r)) { judged.push({ ...r, policy: { result: 'yes', no: [], unknown: [] } }); continue; }
    facts ??= await factsFor(c, subject, context ?? {}, { asOf: day, actor });
    const a = applicability(r, facts.values, facts.na);
    if (a.result === 'no') excluded.push({ row: r, reason: `Does not apply: ${a.no.join(', ')} differ${a.no.length === 1 ? 's' : ''}` });
    else judged.push({ ...r, policy: a });
  }
  const order = new Map(out.map((r, n) => [r.ob_id, n]));
  const { kept, superseded } = settleTopics(judged);
  kept.sort((a, b) => order.get(a.ob_id) - order.get(b.ob_id));
  for (const x of superseded) excluded.push({ row: x.row, by: x.by, reason: `Overridden for topic "${x.row.topic}" by ${x.by.name} (${(CLASS_LABEL[x.by.classification] ?? x.by.classification).toLowerCase()})` });
  kept.facts = facts;
  kept.excluded = excluded;
  return kept;
}

// ---------------------------------------------------------------- state
/** Pure: the state of one obligation from the best record (or linked source result), the waiver and today. Exported for tests. */
export function resolveState(req, ob, rec, today, waiver) {
  const windowMax = Math.max(0, ...(req.reminder_days ?? []));
  let state = 'missing', expires = rec?.expires_on ?? null, daysLeft = null;
  if (rec?.status === 'valid') {
    daysLeft = expires ? between(today, expires) : null;
    if (daysLeft !== null && daysLeft < 0) state = -daysLeft <= (req.grace_days ?? 0) ? 'grace' : 'expired';
    else if (daysLeft !== null && daysLeft <= windowMax) state = 'expiring';
    else state = 'met';
  } else if (rec?.status === 'submitted') state = 'pending_review';
  else if (rec?.status === 'rejected') state = 'rejected';
  else if (rec?.status === 'revoked') state = 'revoked';
  if (rec?.renewal_pending && ['expired', 'grace'].includes(state)) state = 'pending_review';
  let waived = null;
  if (waiver && BAD.includes(state)) { waived = waiver; state = 'waived'; }
  const blocking = !!ob.mandatory && BAD.includes(state);
  return { state, blocking, days_left: daysLeft, waived };
}

const explain = (req, st, rec) => {
  const n = req.name;
  switch (st.state) {
    case 'met': return `${n} is in order${rec?.expires_on ? ` until ${nice(rec.expires_on)}` : ''}.`;
    case 'expiring': return `${n} expires on ${nice(rec.expires_on)} (${st.days_left} day${st.days_left === 1 ? '' : 's'} left). Renew it before then.`;
    case 'grace': return `${n} expired on ${nice(rec.expires_on)}; it still counts for ${(req.grace_days ?? 0) + st.days_left} more day${(req.grace_days ?? 0) + st.days_left === 1 ? '' : 's'} while it is renewed.`;
    case 'pending_review': return rec?.previous_expired ? `A renewal of ${n} is awaiting review.` : `${n} has been submitted and is awaiting review.`;
    case 'expired': return `${n} expired on ${nice(rec.expires_on)}.`;
    case 'rejected': return `${n} was not accepted${rec?.decided_at && !SENSITIVE_CATEGORIES.includes(req.category) && rec.decision_reason ? `: ${rec.decision_reason}` : '. Submit it again.'}`;
    case 'revoked': return `${n} was withdrawn by the reviewer. Submit it again.`;
    case 'waived': return `${n} is waived until ${nice(st.waived.effective_to)}: ${st.waived.reason}`;
    default: return `${n} has not been provided.`;
  }
};

const nextStep = (req, st, rec, src) => {
  if (['met', 'waived'].includes(st.state)) return null;
  if (st.state === 'pending_review') return { action: 'wait', label: 'Waiting for the reviewer' };
  if (req.method === 'linked') return { action: 'open_source', label: src?.where ? `Update it in ${src.where}` : 'Update the linked record', source: req.source?.kind };
  if (req.method === 'declaration') return { action: 'declare', label: st.state === 'missing' ? 'Read and make the declaration' : 'Make the declaration again' };
  return { action: 'submit', label: ['expiring', 'grace', 'expired'].includes(st.state) ? 'Submit the renewal' : 'Submit the evidence' };
};

/** The most relevant record of a subject for a requirement: a current valid one, else the open submission, else the latest decision. */
function pickRecord(list, today) {
  const valid = list.filter((r) => r.status === 'valid').sort((a, b) => (b.expires_on ?? '9999') .localeCompare(a.expires_on ?? '9999'))[0];
  const open = list.find((r) => r.status === 'submitted');
  if (valid) {
    const live = !valid.expires_on || valid.expires_on >= today;
    if (open && !live) return { ...valid, status: 'valid', renewal_pending: true, previous_expired: true, open };
    return { ...valid, open };
  }
  if (open) return { ...open, open };
  return list.filter((r) => ['rejected', 'revoked'].includes(r.status)).sort((a, b) => b.submitted_at - a.submitted_at)[0] ?? null;
}

const REC_COLS = `id, requirement_id, requirement_version, status, outcome, issued_on::text AS issued_on, expires_on::text AS expires_on, provider, submitted_at, decided_at, decision_reason, previous_id, (reference_enc IS NOT NULL) AS has_reference, (detail_enc IS NOT NULL) AS has_detail, statement_version, (SELECT count(*)::int FROM comp_files f WHERE f.record_id = comp_records.id AND f.removed_at IS NULL) AS file_count`;

/**
 * Evaluate a subject: every applicable obligation with its state, a plain-language explanation and the next step.
 * Pure reads. Returns { items, decision, counts }.
 */
export async function evaluateSubject(c, subject, opts = {}) {
  const real = await todayOf(c);
  const today = opts.asOf ?? opts.today ?? real;
  const obs = await applicable(c, subject, { ...opts, asOf: today });
  const excluded = (obs.excluded ?? []).map((x) => ({
    obligation_id: x.row.ob_id, requirement: { code: x.row.code, name: x.row.name }, classification: x.row.classification, topic: x.row.topic ?? null, outcome: 'does_not_apply', reason: x.reason,
    superseded_by: x.by ? { requirement: x.by.name, classification: x.by.classification } : null,
  }));
  const facts = obs.facts ? { values: obs.facts.values, sources: obs.facts.sources } : { values: {}, sources: {} };
  if (!obs.length) return { subject, today, items: [], excluded, facts, decision: 'clear', counts: { met: 0, expiring: 0, pending: 0, blocked: 0, waived: 0, unknown: 0 }, statuses: statusCounts([]) };
  const reqIds = [...new Set(obs.map((o) => o.id))];
  // an earlier date shows the wording in force then: the latest version saved on or before it (nothing is ever deleted, so history is kept)
  if (today < real) {
    const past = (await c.query(
      `SELECT DISTINCT ON (requirement_id) requirement_id, version, snapshot FROM comp_requirement_versions WHERE requirement_id = ANY($1) AND changed_at::date <= $2::date ORDER BY requirement_id, version DESC`, [reqIds, today])).rows;
    for (const o of obs) {
      const v = past.find((x) => x.requirement_id === o.id);
      if (v) for (const k of ['name', 'description', 'category', 'method', 'source', 'requires_review', 'validity_days', 'reminder_days', 'grace_days', 'escalate_after_days', 'statement']) if (v.snapshot[k] !== undefined) o[k] = v.snapshot[k];
      if (v) o.version = v.version;
    }
  }
  const recs = (await c.query(`SELECT ${REC_COLS} FROM comp_records WHERE subject_kind=$1 AND subject_id=$2 AND requirement_id = ANY($3) AND status IN ('submitted','valid','rejected','revoked')`, [subject.kind, subject.id, reqIds])).rows;
  const waivers = (await c.query(
    `SELECT id, requirement_id, reason, effective_to::text AS effective_to FROM comp_waivers WHERE subject_kind=$1 AND subject_id=$2 AND requirement_id = ANY($3) AND revoked_at IS NULL AND effective_from <= $4::date AND effective_to >= $4::date ORDER BY effective_to DESC`,
    [subject.kind, subject.id, reqIds, today])).rows;
  // safeguarding that protects young people, and background checks, can never be waived (grant_compliance_waiver refuses them too)
  const unwaivable = new Set((await c.query("SELECT DISTINCT requirement_id FROM comp_obligations WHERE requirement_id = ANY($1) AND archived_at IS NULL AND consequences && ARRAY['youth_contact','youth_access']", [reqIds])).rows.map((x) => x.requirement_id));
  const names = new Map();
  const items = [];
  for (const r of obs) {
    const advisory = r.classification === 'recommended_standard';
    const waivable = r.waivable !== false && !NEVER_WAIVABLE_CLASSES.includes(r.classification) && r.category !== 'background_check' && !unwaivable.has(r.id);
    let rec = null, src = null, st;
    if (r.policy.result === 'unknown') {
      st = { state: 'unknown', blocking: !!r.mandatory && !advisory, days_left: null, waived: null };
    } else {
      if (r.method === 'linked') {
        src = await SOURCES[r.source.kind](c, subject, r.source);
        rec = src.raw === 'valid' ? { status: 'valid', issued_on: src.issued_on, expires_on: src.expires_on } : src.raw === 'pending' ? { status: 'submitted' } : ['rejected', 'revoked'].includes(src.raw) ? { status: src.raw } : null;
      } else rec = pickRecord(recs.filter((x) => x.requirement_id === r.id), today);
      const waiver = waivers.find((w) => w.requirement_id === r.id) ?? null;
      st = resolveState(r, { mandatory: r.mandatory }, rec, today, waiver);
      if (advisory) st.blocking = false;     // a recommended standard advises; it never stops anything
    }
    const sk = `${r.scope_kind}:${r.scope_id ?? ''}`;
    if (!names.has(sk)) names.set(sk, await scopeName(c, r.scope_kind, r.scope_id));
    const missing = r.policy.unknown ?? [];
    items.push({
      obligation_id: r.ob_id, requirement_id: r.id,
      requirement: { code: r.code, name: r.name, description: r.description, category: r.category, category_label: CATEGORIES[r.category], method: r.method, version: r.version, validity_days: r.validity_days, sensitive: r.sensitive, source: r.method === 'linked' ? r.source : null, statement: r.method === 'declaration' ? r.statement : null },
      scope: { kind: r.scope_kind, id: r.scope_id, name: names.get(sk) },
      mandatory: r.mandatory, consequences: r.consequences, waivable,
      state: st.state, state_label: STATE_LABEL[st.state], blocking: st.blocking, days_left: st.days_left,
      status: STATUS_OF[st.state], outcome: st.state === 'unknown' ? 'unknown' : st.blocking && waivable ? 'exception_required' : 'applies',
      policy: {
        classification: r.classification, classification_label: CLASS_LABEL[r.classification], topic: r.topic ?? null,
        jurisdiction: { country: r.ob_country ?? null, region: r.ob_region ?? null, municipality: r.ob_municipality ?? null },
        applies: { body_ids: r.body_ids, competition_ids: r.competition_ids, venue_ids: r.venue_ids, event_types: r.event_types, min_age: r.min_age, max_age: r.max_age },
        effective_from: r.starts_on, effective_to: r.ends_on, source_title: r.source_title ?? null, source_url: r.source_url ?? null, approval_owner: r.approval_owner ?? null, missing_facts: missing,
      },
      issued_on: rec?.issued_on ?? null, expires_on: rec?.expires_on ?? null,
      record: (rec?.open ?? rec)?.id ? (({ id, status, outcome, file_count, submitted_at, decided_at }) => ({ id, status, outcome: outcome ?? null, file_count: file_count ?? 0, can_attach: status === 'submitted', submitted_at, decided_at }))(rec.open ?? rec) : null,
      waiver: st.waived ? { id: st.waived.id, reason: st.waived.reason, effective_to: st.waived.effective_to } : null,
      explanation: st.state === 'unknown' ? `${r.name} might apply, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on record, so it cannot be judged yet.` : explain(r, st, rec),
      next_step: st.state === 'unknown' ? { action: 'add_facts', label: `Add the missing information (${missing.join(', ')})` } : nextStep(r, st, rec, src),
      linked: src?.ref ?? null,
    });
  }
  return { subject, today, items, excluded, facts, statuses: statusCounts(items), ...summarise(items) };
}

export function summarise(items) {
  const counts = { met: 0, expiring: 0, pending: 0, blocked: 0, waived: 0, unknown: 0 };
  for (const i of items) {
    if (i.state === 'unknown') counts.unknown++;
    if (i.blocking) counts.blocked++;
    else if (i.state === 'pending_review') counts.pending++;
    else if (['expiring', 'grace'].includes(i.state)) counts.expiring++;
    else if (i.state === 'waived') counts.waived++;
    else if (i.state === 'met') counts.met++;
  }
  const mandatoryPending = items.some((i) => i.mandatory && i.policy?.classification !== 'recommended_standard' && i.state === 'pending_review');
  return { counts, decision: counts.blocked ? 'blocked' : mandatoryPending ? 'pending' : 'clear' };
}

// ---------------------------------------------------------------- the gate other modules call
const orgsOf = (ctx) => [...new Set([ctx.organisation_id, ...(ctx.organisation_ids ?? [])].filter(Boolean))];

/**
 * Does this person satisfy every obligation that blocks `consequence` in this context? `ctx` = { event_id, organisation_id, organisation_ids, body_ids }.
 * Platform-scope obligations always count; organisation, event and body obligations count only for the context they belong to.
 * Returns { decision: 'clear' | 'pending' | 'blocked', reasons: [text], items }.
 */
export async function gate(c, userId, consequence, ctx = {}, extra = {}) {
  const r = await evaluateSubject(c, { kind: 'person', id: userId }, { consequence, scopes: scopesOf(ctx), context: ctx, ...extra });
  const bad = r.items.filter((i) => i.blocking || (i.mandatory && i.state === 'pending_review' && i.policy?.classification !== 'recommended_standard'));
  return { decision: r.decision, reasons: bad.map((i) => i.explanation), items: bad };
}

/** The scopes whose rulebooks count in a context: the platform's, the event's, the organisations' and the governing bodies'. */
export function scopesOf(ctx = {}) {
  const scopes = [{ kind: 'platform', id: null }];
  if (ctx.event_id) scopes.push({ kind: 'event', id: ctx.event_id });
  for (const o of orgsOf(ctx)) scopes.push({ kind: 'organisation', id: o });
  for (const b of ctx.body_ids ?? []) scopes.push({ kind: 'body', id: b });
  return scopes;
}

/** Any live obligation blocking this consequence in the context? Lets callers skip per-person work entirely when nothing is configured. */
export async function hasObligations(c, consequence, ctx = {}) {
  const r = await c.query(
    `SELECT 1 FROM comp_obligations o JOIN comp_requirements q ON q.id=o.requirement_id
      WHERE o.archived_at IS NULL AND q.archived_at IS NULL AND q.approval_status='approved' AND q.subject_kind='person' AND $1 = ANY(o.consequences) AND o.starts_on <= current_date AND (o.ends_on IS NULL OR o.ends_on >= current_date)
        AND (q.scope_kind='platform' OR (q.scope_kind='event' AND q.scope_id=$2) OR (q.scope_kind='organisation' AND q.scope_id = ANY($3::uuid[])) OR (q.scope_kind='body' AND q.scope_id = ANY($4::uuid[]))) LIMIT 1`,
    [consequence, ctx.event_id ?? null, orgsOf(ctx), ctx.body_ids ?? []]);
  return r.rowCount > 0;
}

const refuse = (consequence, g, what) => conflict(`Safeguarding requirements must be met before ${what}.`, { code: 'compliance_required', consequence, reasons: g.reasons });

/** The organisations whose teams a young person plays for: their rulebooks apply to any adult who works with that young person. */
const orgsOfYouth = async (c, childId) => (await c.query(
  'SELECT DISTINCT t.organisation_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status=\'active\' AND t.organisation_id IS NOT NULL', [childId])).rows.map((r) => r.organisation_id);

/**
 * Policy-driven youth restriction: an adult may not message a team that has young members until every obligation that blocks 'youth_contact' is met.
 * Pending counts as not met here: safeguarding is conservative. Young people themselves are never restricted by this.
 */
export async function assertMayContactYouth(c, userId, team) {
  const ctx = { organisation_id: team.organisation_id };
  if (!(await hasObligations(c, 'youth_contact', ctx))) return;
  if (await isYouth(userId, c)) return;
  if (!(await c.query(`SELECT 1 FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' AND ${youthSql('u')} LIMIT 1`, [team.id])).rowCount) return;
  const g = await gate(c, userId, 'youth_contact', ctx);
  if (g.decision !== 'clear') throw refuse('youth_contact', g, 'you can contact young people in this team');
}

/** The same restriction for a direct message from an adult (a recruiter, a sponsor) to one young person. */
export async function assertMayMessageYouth(c, senderId, childId) {
  if (!(await isYouth(childId, c)) || (await isYouth(senderId, c))) return;
  const ctx = { organisation_ids: await orgsOfYouth(c, childId) };
  if (!(await hasObligations(c, 'youth_contact', ctx))) return;
  const g = await gate(c, senderId, 'youth_contact', ctx);
  if (g.decision !== 'clear') throw refuse('youth_contact', g, 'you can message this young person');
}

/** May this adult see a young person's profile and records as a team coach or manager? True unless an obligation that blocks 'youth_access' is not met. */
export async function mayAccessYouth(c, viewerId, childId) {
  const ctx = { organisation_ids: await orgsOfYouth(c, childId) };
  if (!(await hasObligations(c, 'youth_access', ctx))) return true;
  return (await gate(c, viewerId, 'youth_access', ctx)).decision === 'clear';
}

// ---------------------------------------------------------------- people in a scope (for the manager's roll-up)
export async function peopleInScope(c, scopeKind, scopeId, { limit = 25, offset = 0 } = {}) {
  let sql, params;
  if (scopeKind === 'organisation') {
    sql = `SELECT id FROM (SELECT user_id AS id FROM organisation_members WHERE organisation_id=$1 AND status='active'
             UNION SELECT t.owner_id FROM teams t WHERE t.organisation_id=$1 AND t.archived_at IS NULL
             UNION SELECT m.user_id FROM teams t JOIN team_members m ON m.team_id=t.id AND m.status='active' AND m.role IN ('coach','manager') WHERE t.organisation_id=$1 AND t.archived_at IS NULL) x ORDER BY id`;
    params = [scopeId];
  } else if (scopeKind === 'event') {
    sql = `SELECT id FROM (
             SELECT organizer_id AS id FROM events WHERE id=$1
             UNION SELECT a.user_id FROM event_staff_assignments a WHERE a.event_id=$1 AND a.status='accepted'
             UNION SELECT fo.user_id FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id WHERE f.event_id=$1 AND fo.status='accepted'
             UNION SELECT vendor_user_id FROM event_vendors WHERE event_id=$1 AND status='accepted'
             UNION SELECT cr.user_id FROM event_vendor_crew cr JOIN event_vendors v ON v.id=cr.vendor_id WHERE cr.event_id=$1 AND cr.removed_at IS NULL AND v.status='accepted'
             UNION SELECT user_id FROM event_entries WHERE event_id=$1 AND status='accepted' AND user_id IS NOT NULL
             UNION SELECT m.user_id FROM event_entries en JOIN team_members m ON m.team_id=en.team_id AND m.status='active' WHERE en.event_id=$1 AND en.status='accepted'
             UNION SELECT m.user_id FROM event_department_members m WHERE m.event_id=$1 AND m.status='active') x WHERE id IS NOT NULL ORDER BY id`;
    params = [scopeId];
  } else if (scopeKind === 'body') {
    sql = "SELECT DISTINCT holder_id AS id FROM fed_licences WHERE body_id=$1 AND status NOT IN ('draft','rejected','withdrawn') ORDER BY 1";
    params = [scopeId];
  } else {
    sql = "SELECT id FROM users WHERE cardinality(roles) > 0 ORDER BY id";
    params = [];
  }
  const all = (await c.query(sql, params)).rows.map((r) => r.id);
  return { total: all.length, ids: all.slice(offset, offset + limit) };
}

/** The subjects of a kind that live in a scope, paged: people from the canonical records, organisations and events by ownership or affiliation. */
export async function subjectsInScope(c, scopeKind, scopeId, subjectKind, { limit, offset }) {
  if (subjectKind === 'person') return peopleInScope(c, scopeKind, scopeId, { limit, offset });
  let sql, params = [];
  if (subjectKind === 'organisation') {
    if (scopeKind === 'organisation') { sql = 'SELECT id FROM organisations WHERE id=$1'; params = [scopeId]; }
    else if (scopeKind === 'body') { sql = "SELECT DISTINCT organisation_id AS id FROM fed_affiliations WHERE body_id=$1 AND status IN ('approved','suspended')"; params = [scopeId]; }
    else if (scopeKind === 'platform') sql = "SELECT id FROM organisations WHERE status='active' ORDER BY name";
    else sql = "SELECT organisation_id AS id FROM events WHERE id=$1 AND organisation_id IS NOT NULL", params = [scopeId];
  } else if (scopeKind === 'event') { sql = 'SELECT id FROM events WHERE id=$1'; params = [scopeId]; }
  else if (scopeKind === 'organisation') { sql = "SELECT id FROM events WHERE organisation_id=$1 AND status <> 'cancelled' ORDER BY starts_on DESC NULLS LAST"; params = [scopeId]; }
  else if (scopeKind === 'body') { sql = "SELECT e.id FROM events e JOIN fed_affiliations a ON a.organisation_id=e.organisation_id AND a.body_id=$1 AND a.status IN ('approved','suspended') WHERE e.status <> 'cancelled'"; params = [scopeId]; }
  else sql = "SELECT id FROM events WHERE status <> 'cancelled' ORDER BY starts_on DESC NULLS LAST";
  const all = (await c.query(sql, params)).rows.map((r) => r.id);
  return { total: all.length, ids: all.slice(offset, offset + limit) };
}

/** Display names, with a young person's name withheld from anyone who may not see them. */
export async function nameFor(c, viewer, kind, id) {
  if (kind === 'person') {
    const u = (await c.query(`SELECT display_name, ${youthSql('users')} AS youth FROM users WHERE id=$1`, [id])).rows[0];
    if (!u) return null;
    if (u.youth && !(await canSeeYouth(viewer, id))) return 'Protected participant';
    return u.display_name;
  }
  return (await c.query(kind === 'organisation' ? 'SELECT name FROM organisations WHERE id=$1' : 'SELECT name FROM events WHERE id=$1', [id])).rows[0]?.name ?? null;
}

export const reveal = (enc, ctx) => (enc ? decrypt(enc, ctx) : null);
