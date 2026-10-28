// The data behind a referee's reporting extract (#88): drawn live from the canonical records the referee is already entitled to see, then frozen
// into the PDF with a fingerprint. Assignments with their history, the closure forms (score sheet, sign-offs, the referee's own reports with every
// revision), fees and payment status, disputes linked to those matches, and feedback only above the anonymity threshold.
import { createHash } from 'node:crypto';
import { many, one, pool } from './db.js';
import { loadEncrypted } from './doc-store.js';
import { decrypt } from './crypto.js';
import { ASSIGNMENT_SQL, credentialFor } from './officials.js';
import { feedbackSummary } from './capabilities/officials-feedback.js';

const MAX_ROWS = 300;

const logoOf = async (kitId) => {
  if (!kitId) return null;
  const k = await one('SELECT k.id, k.name, k.display_name, a.sha256, a.file_name FROM brand_kits k JOIN brand_assets a ON a.id=k.logo_asset_id WHERE k.id=$1 AND k.archived_at IS NULL', [kitId]);
  if (!k) return null;
  try { return { sha: k.sha256, name: k.display_name ?? k.name, buffer: await loadEncrypted('brand', 'brand_assets.file', k.file_name) }; } catch { return null; }
};

/** What a closure report's header shows for one event: event and organisation names and dates, and the event's and organisation's logos (frozen into the PDF with this build). */
async function eventHeaders(eventIds, logos) {
  const out = new Map();
  const rows = await many(`SELECT e.id, e.name, e.starts_on, e.ends_on, e.city, e.brand_kit_id, e.organisation_id, o.name AS org_name FROM events e LEFT JOIN organisations o ON o.id=e.organisation_id WHERE e.id = ANY($1::uuid[])`, [eventIds]);
  for (const e of rows) {
    const ev = await logoOf(e.brand_kit_id);
    const orgKit = e.organisation_id ? await one('SELECT id FROM brand_kits WHERE organisation_id=$1 AND archived_at IS NULL AND logo_asset_id IS NOT NULL ORDER BY updated_at DESC, id LIMIT 1', [e.organisation_id]) : null;
    let org = orgKit ? await logoOf(orgKit.id) : null;
    if (org && ev && org.sha === ev.sha) org = null; // the same mark twice adds nothing
    for (const l of [ev, org]) if (l) logos.set(l.sha, l.buffer);
    out.set(e.id, { event: e.name, organisation: e.org_name, starts_on: e.starts_on, ends_on: e.ends_on, city: e.city, event_logo: ev?.sha ?? null, organisation_logo: org?.sha ?? null });
  }
  return out;
}


export async function buildExtract(user, { from, to, sportId }) {
  const lo = `${from}T00:00:00Z`, hi = `${to}T00:00:00Z`;
  const rows = await many(
    `SELECT x.*, f.home_score, f.away_score
       FROM (${ASSIGNMENT_SQL} WHERE fo.user_id=$1) x JOIN fixtures f ON f.id=x.fixture_id
      WHERE x.scheduled_at >= $2 AND x.scheduled_at < $3 AND ($4::uuid IS NULL OR x.sport_id=$4)
      ORDER BY x.scheduled_at, x.id LIMIT ${MAX_ROWS + 1}`, [user.id, lo, hi, sportId ?? null]);
  const truncated = rows.length > MAX_ROWS;
  const list = rows.slice(0, MAX_ROWS);
  const logos = new Map();
  const heads = await eventHeaders([...new Set(list.map((a) => a.event_id))], logos);
  const assignments = [];
  for (const a of list) {
    const history = await many('SELECT from_status, to_status, reason, at FROM fixture_official_history WHERE fixture_official_id=$1 ORDER BY at, id', [a.id]);
    const pay = await many('SELECT l.fee_minor, l.fee_currency, l.from_status, l.to_status, l.note, l.at, u.display_name AS actor_name FROM fixture_official_pay_log l JOIN users u ON u.id=l.actor_id WHERE l.fixture_official_id=$1 ORDER BY l.at, l.id', [a.id]);
    let closure = null;
    if (a.status === 'completed' || a.fixture_status === 'completed') {
      const sheet = await one(`SELECT * FROM score_sheets WHERE fixture_id=$1 AND status IN ('published','approved','submitted') ORDER BY (status='published') DESC, version DESC LIMIT 1`, [a.fixture_id]);
      const signoffs = sheet ? await many('SELECT s.role, s.decision, s.comment, s.at, u.display_name FROM score_sheet_signoffs s JOIN users u ON u.id=s.user_id WHERE s.sheet_id=$1 AND s.round=$2 ORDER BY s.at', [sheet.id, sheet.round]) : [];
      const log = sheet ? await many('SELECT l.action, l.from_status, l.to_status, l.note, l.at, u.display_name FROM score_sheet_log l JOIN users u ON u.id=l.actor_id WHERE l.sheet_id=$1 ORDER BY l.at, l.id', [sheet.id]) : [];
      const reports = await many('SELECT r.id, r.category, r.revision, r.created_at FROM official_reports r WHERE r.fixture_id=$1 AND r.author_id=$2 ORDER BY r.created_at, r.id', [a.fixture_id, user.id]);
      for (const r of reports) {
        r.revisions = (await many('SELECT revision, summary, note_enc, reason, visibility, at FROM official_report_revisions WHERE report_id=$1 ORDER BY revision', [r.id]))
          .map(({ note_enc, ...v }) => ({ ...v, note: note_enc ? decrypt(note_enc, 'official_report.note') : null }));
      }
      closure = {
        score: a.home_score != null ? `${a.home_name ?? 'Home'} ${a.home_score} - ${a.away_score} ${a.away_name ?? 'Away'}` : null,
        sheet: sheet && { version: sheet.version, status: sheet.status, source: sheet.source, submitted_at: sheet.submitted_at, approved_at: sheet.approved_at, published_at: sheet.published_at, adjusted_reason: sheet.adjusted_reason, waived_reason: sheet.waived_reason, notes: sheet.notes, anomalies: (sheet.anomalies ?? []).map((x) => x.message ?? x.code ?? String(x)), totals: sheet.totals },
        signoffs, log, reports,
      };
    }
    assignments.push({
      id: a.id, fixture_id: a.fixture_id, event_id: a.event_id, header: heads.get(a.event_id), home: a.home_name, away: a.away_name, duration_min: a.duration_min, city: a.venue_city, match: `${a.home_name ?? 'TBD'} v ${a.away_name ?? 'TBD'}`, event: a.event_name, round: a.round, sport: a.sport_name, scheduled_at: a.scheduled_at, role: a.role, status: a.status, reason: a.reason,
      venue: [a.resource_name, a.venue_name].filter(Boolean).join(' · ') || null, fee_minor: a.fee_minor == null ? null : Number(a.fee_minor), fee_currency: a.fee_currency, pay_status: a.pay_status, pay_confirmed_at: a.pay_confirmed_at, history, pay_log: pay, closure,
    });
  }
  const totals = {};
  for (const a of assignments) if (a.fee_minor != null && !['declined', 'withdrawn', 'released', 'cancelled'].includes(a.status)) {
    const t = (totals[a.fee_currency] ??= { currency: a.fee_currency, agreed: 0, due: 0, paid: 0, disputed: 0 });
    t[a.pay_status === 'none' ? 'agreed' : a.pay_status] += a.fee_minor;
  }
  const disputes = await many(
    `SELECT DISTINCT c.case_no, c.status, c.subject, c.created_at FROM cases c JOIN case_links l ON l.case_id=c.id AND l.entity_type='fixture'
       WHERE c.routed_to='game_officials' AND l.entity_id = ANY($1::uuid[]) ORDER BY c.created_at, c.case_no`, [assignments.map((a) => a.fixture_id)]);
  const sports = await many("SELECT s.id, s.name FROM active_sport_profiles p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.role='referee' ORDER BY s.name", [user.id]);
  const credentials = [];
  for (const s of sports) {
    if (sportId && s.id !== sportId) continue;
    const cred = await credentialFor(pool, user.id, s.id);
    credentials.push({ sport: s.name, verified_until: cred.verified?.expires_at ?? null, licence: cred.licence ? `${cred.licence.licence_type} (${cred.licence.body_name}) valid to ${String(cred.licence.expires_on).slice(0, 10)}` : null });
  }
  const feedback = await feedbackSummary(user.id, { from: lo, to: hi, sportId });
  const snapshot = {
    official: { name: user.display_name, handle: user.handle }, period: { from, to }, sports: sports.map((s) => s.name), credentials,
    counts: { assignments: assignments.length, completed: assignments.filter((a) => a.status === 'completed').length, reports: assignments.reduce((n, a) => n + (a.closure?.reports.length ?? 0), 0), disputes: disputes.length },
    truncated, assignments, payments: { totals: Object.values(totals) }, disputes, feedback,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { snapshot, sha256, logos };
}
