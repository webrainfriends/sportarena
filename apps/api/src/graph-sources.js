// Timeline sources for the Sports Graph (#561) that live in their own modules: registrations, accreditations, travel, payments, invoices,
// sponsorships, assessments, media assets, training sessions and opportunities. Each reads the canonical table at request time and returns
// plain rows [domain, at, type, title, summary, sourceTable, sourceId, extra]; nothing is copied. Who may see a domain is decided by the
// caller (graph-360.js) from the viewer's relationship; the queries here only narrow further where a second party (sponsor, coach, team
// manager, post author) is allowed to see their own side.
import { many, one } from './db.js';
import { isAdmin } from './helpers.js';
import { canManageTeam } from './capabilities/teams.js';

const money = (cents, cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(Number(cents) / 100); } catch { return `${(Number(cents) / 100).toFixed(2)} ${cur}`; } };
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const row = (domain, at, type, title, summary, table, id, extra) => [domain, at, type, title, summary, table, id, extra];

/** Domains only the person (or their guardian / an admin) may see, with the query that feeds each. */
export const PERSON_PRIVATE = {
  payment: async (id) => (await many(
    `SELECT p.id, p.purpose_type, p.status, p.amount_cents, p.currency, coalesce(p.paid_at, p.created_at) AS at FROM payments p WHERE p.payer_id=$1 AND p.status IN ('paid','refunded') ORDER BY 6 DESC LIMIT 100`, [id]))
    .map((p) => row('payment', p.at, p.purpose_type, `Payment: ${nice(p.purpose_type)}`, `${money(p.amount_cents, p.currency)} · ${p.status}`, 'payments', p.id)),
  invoice: async (id) => (await many(
    `SELECT i.id, i.number, i.kind, i.status, i.total_cents, i.currency, i.issued_at AS at, v.name AS venue FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.user_id=$1 ORDER BY i.issued_at DESC LIMIT 100`, [id]))
    .map((i) => row('invoice', i.at, i.kind, `${i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${i.number}`, `${i.venue} · ${money(i.total_cents, i.currency)} · ${i.status}`, 'invoices', i.id)),
  accreditation: async (id) => (await many(
    `SELECT a.id, a.status, a.access, coalesce(a.issued_at, a.submitted_at) AS at, e.name AS event, c.name AS category FROM accreditations a JOIN events e ON e.id=a.event_id JOIN accreditation_categories c ON c.id=a.category_id
      WHERE a.holder_id=$1 AND a.status <> 'draft' ORDER BY 4 DESC LIMIT 100`, [id]))
    .map((a) => row('accreditation', a.at, a.status, `Accreditation: ${a.event}`, [a.category, a.status === 'approved' && a.access === 'suspended' ? 'suspended' : a.status].join(' · '), 'accreditations', a.id)),
  travel: async (id) => (await many(
    `SELECT t.id, t.name, t.destination, t.depart_at AS at, t.status, p.role FROM trip_participants p JOIN trips t ON t.id=p.trip_id WHERE p.user_id=$1 AND p.status IN ('invited','confirmed') AND t.status <> 'cancelled' ORDER BY t.depart_at DESC LIMIT 100`, [id]))
    .map((t) => row('travel', t.at, 'trip', `Trip: ${t.name}`, `${t.destination} · ${nice(t.role)} · ${nice(t.status)}`, 'trips', t.id)),
  assessment: async (id) => (await many(
    `SELECT a.id, a.outcome, a.period_to AS at, p.title AS pathway, a.level_key FROM academy_assessments a JOIN academy_pathways p ON p.id=a.pathway_id WHERE a.athlete_id=$1 AND a.status='approved' ORDER BY a.period_to DESC LIMIT 100`, [id]))
    .map((a) => row('assessment', a.at, 'assessment', `Assessment: ${a.pathway}`, `${a.level_key} · ${nice(a.outcome)}`, 'academy_assessments', a.id)),
  training: async (id) => (await many(
    `SELECT s.id, s.title, s.kind, s.starts_at AS at, s.status FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE p.athlete_id=$1 AND s.status IN ('scheduled','completed') ORDER BY s.starts_at DESC LIMIT 100`, [id]))
    .map((s) => row('training', s.at, s.kind, `Training: ${s.title}`, `${nice(s.kind)} · ${s.status}`, 'training_sessions', s.id)),
  opportunity: async (id) => (await many(
    `SELECT r.id, r.status, r.created_at AS at, b.title, b.kind FROM billboard_responses r JOIN billboard_posts b ON b.id=r.post_id WHERE r.responder_id=$1 ORDER BY r.created_at DESC LIMIT 100`, [id]))
    .map((o) => row('opportunity', o.at, o.kind, `Opportunity: ${o.title}`, `${nice(o.kind)} · ${o.status}`, 'billboard_posts', o.id)),
};

/** Sponsors see the sponsorships they own even when they are not the athlete. */
export async function personSponsorships(viewer, id, owner) {
  const rows = await many(
    `SELECT s.id, s.status, coalesce(s.starts_on, s.created_at::date) AS at, sp.name AS sponsor, sp.owner_id FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id
      WHERE s.target_type='athlete' AND s.target_id=$1 AND s.status IN ('active','ended') ORDER BY 3 DESC LIMIT 100`, [id]);
  return rows.filter((s) => owner || s.owner_id === viewer?.id).map((s) => row('sponsorship', s.at, 'sponsorship', `Sponsored by ${s.sponsor}`, s.status, 'sponsorships', s.id));
}

/** A registration is seen by the person, their guardian, the managers of the registering team, and admins. */
export async function personRegistrations(viewer, id, owner) {
  const rows = await many(
    `SELECT r.id, r.status, r.team_id, coalesce(r.effective_from::timestamptz, r.created_at) AS at, r.registration_no, e.name AS event, t.name AS team, d.name AS division
       FROM reg_registrations r JOIN events e ON e.id=r.event_id JOIN teams t ON t.id=r.team_id LEFT JOIN reg_divisions d ON d.id=r.division_id WHERE r.user_id=$1 ORDER BY 4 DESC LIMIT 100`, [id]);
  const out = [];
  for (const r of rows) {
    if (!owner && !isAdmin(viewer)) { const team = await one('SELECT * FROM teams WHERE id=$1', [r.team_id]); if (!team || !(await canManageTeam(viewer, team))) continue; }
    out.push(row('registration', r.at, r.status, `Registration: ${r.event}`, [r.team, r.division, r.registration_no, nice(r.status)].filter(Boolean).join(' · '), 'reg_registrations', r.id));
  }
  return out;
}
/** A coach sees the sessions they run. */
export async function personTrainingForCoach(viewer, id) {
  if (!viewer) return [];
  return (await many(
    `SELECT s.id, s.title, s.kind, s.starts_at AS at, s.status FROM training_sessions s JOIN training_plans p ON p.id=s.plan_id WHERE p.athlete_id=$1 AND p.coach_id=$2 AND s.status IN ('scheduled','completed') ORDER BY s.starts_at DESC LIMIT 100`, [id, viewer.id]))
    .map((s) => row('training', s.at, s.kind, `Training: ${s.title}`, `${nice(s.kind)} · ${s.status}`, 'training_sessions', s.id));
}

// ------------------------------------------------------------------ organisations
/** Staff-only organisation domains. */
export const ORG_STAFF = {
  travel: async (id) => (await many(`SELECT t.id, t.name, t.destination, t.depart_at AS at, t.status FROM trips t WHERE t.organisation_id=$1 AND t.status <> 'cancelled' ORDER BY t.depart_at DESC LIMIT 100`, [id]))
    .map((t) => row('travel', t.at, 'trip', `Trip: ${t.name}`, `${t.destination} · ${nice(t.status)}`, 'trips', t.id)),
  invoice: async (id) => (await many(
    `SELECT i.id, i.number, i.kind, i.status, i.total_cents, i.currency, i.issued_at AS at, v.name AS venue FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE v.organisation_id=$1 ORDER BY i.issued_at DESC LIMIT 100`, [id]))
    .map((i) => row('invoice', i.at, i.kind, `${i.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${i.number}`, `${i.venue} · ${money(i.total_cents, i.currency)} · ${i.status}`, 'invoices', i.id)),
  registration: async (id) => (await many(
    `SELECT r.id, r.status, coalesce(r.effective_from::timestamptz, r.created_at) AS at, e.name AS event, t.name AS team, d.name AS division FROM reg_registrations r JOIN teams t ON t.id=r.team_id JOIN events e ON e.id=r.event_id LEFT JOIN reg_divisions d ON d.id=r.division_id
      WHERE t.organisation_id=$1 ORDER BY 3 DESC LIMIT 100`, [id]))
    .map((r) => row('registration', r.at, r.status, `Registration: ${r.team} in ${r.event}`, [r.division, nice(r.status)].filter(Boolean).join(' · '), 'reg_registrations', r.id)),
  accreditation: async (id) => (await many(
    `SELECT a.id, a.status, coalesce(a.issued_at, a.submitted_at) AS at, e.name AS event, c.name AS category FROM accreditations a JOIN events e ON e.id=a.event_id JOIN accreditation_categories c ON c.id=a.category_id
      WHERE e.organisation_id=$1 AND a.status <> 'draft' ORDER BY 3 DESC LIMIT 100`, [id]))
    .map((a) => row('accreditation', a.at, a.status, `Accreditation: ${a.event}`, `${a.category} · ${a.status}`, 'accreditations', a.id)),
  supplier: async (id) => (await many(
    `SELECT o.id, o.number, o.status, o.created_at AS at, coalesce(p.trading_name, p.legal_name) AS supplier FROM svc_orders o JOIN svc_profiles p ON p.id=o.profile_id
      WHERE o.event_id IN (SELECT id FROM events WHERE organisation_id=$1) OR o.venue_id IN (SELECT id FROM venues WHERE organisation_id=$1) OR p.organisation_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [id]))
    .map((o) => row('supplier', o.at, 'order', `Supplier order ${o.number}`, `${o.supplier} · ${nice(o.status)}`, 'svc_orders', o.id)),
  assessment: async (id) => (await many(
    `SELECT a.id, a.outcome, a.period_to AS at, p.title AS pathway FROM academy_assessments a JOIN academy_pathways p ON p.id=a.pathway_id WHERE a.organisation_id=$1 AND a.status='approved' ORDER BY a.period_to DESC LIMIT 100`, [id]))
    .map((a) => row('assessment', a.at, 'assessment', `Assessment approved: ${a.pathway}`, nice(a.outcome), 'academy_assessments', a.id)),
};
/** Public organisation domains: sponsorships of its teams and events, and its published media. Staff additionally see unpublished media. */
export async function orgSponsorships(id) {
  return (await many(
    `SELECT s.id, s.status, coalesce(s.starts_on, s.created_at::date) AS at, sp.name AS sponsor, s.target_type FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id
      WHERE s.status IN ('active','ended') AND ((s.target_type='team' AND s.target_id IN (SELECT id FROM teams WHERE organisation_id=$1)) OR (s.target_type='event' AND s.target_id IN (SELECT id FROM events WHERE organisation_id=$1)))
      ORDER BY 3 DESC LIMIT 100`, [id]))
    .map((s) => row('sponsorship', s.at, 'sponsorship', `Sponsored by ${s.sponsor}`, `${s.target_type} · ${s.status}`, 'sponsorships', s.id));
}
export async function orgMedia(id, staff) {
  return (await many(
    `SELECT m.id, m.kind, m.title, m.status, coalesce(m.publish_at, m.created_at) AS at, e.name AS event FROM mr_assets m JOIN events e ON e.id=m.event_id
      WHERE e.organisation_id=$1 AND (($2 AND m.status <> 'draft') OR (m.status='published' AND m.audience='public')) ORDER BY 5 DESC LIMIT 100`, [id, staff]))
    .map((m) => row('media', m.at, m.kind, m.title, `${m.event} · ${nice(m.kind)}${staff ? ` · ${m.status}` : ''}`, 'mr_assets', m.id));
}
