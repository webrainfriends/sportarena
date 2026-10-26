// Beneficiary performance and community impact (#303). Extends the performance review of an agreement (#145 §7, `sponsorship-performance.js`):
// the same per-agreement consent switch now also covers team/event participation and results (read live from the canonical games and entries),
// plus development milestones, community outcomes and outside results recorded here with source, date, unit and sample size.
// Corrections are append-only and replace the old figure in every current view and export. Nothing here can block, reduce or release a payment.
// Pre-award evidence goes through the applicant's own passport link (#64) or, for a team/event, its live results, and stops the moment the share is revoked.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt, newOpaqueToken, sha256 } from '../crypto.js';
import { toCsv } from '../csv.js';
import { notifyRecipient } from '../youth-sponsorship.js';
import { logHistory, dealContext } from '../sponsor-agreements.js';
import { notifySponsor } from '../sponsor-access.js';
import { redactBlind } from '../sponsorship-evaluation.js';
import { SECTION_FLAGS, scopeOf, liveLinkById } from '../passport-sections.js';
import { buildPassport } from './passport.js';
import { programFor } from './sponsorship-programs.js';
import { RUNNING, assertSponsorMayRead, sourcesFor, teamEventResults, shapeRecord, listRecords, SOURCE_LABELS, ymd } from '../sponsorship-impact.js';

const TAG = 'Sponsors';
const date = z.string().date();
const NOTE_CTX = 'sponsorship_impact.note';
const today = () => new Date().toISOString().slice(0, 10);
// Notifications carry no figures, titles or notes.
const ping = (c, to, ctx) => {
  const msg = { kind: 'sponsorship_performance', title: 'Impact evidence was updated', body: `Open the ${ctx.sp.name} agreement to see the update.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, 'performance', msg, ctx.d.department_id) : notifyRecipient(c, to, msg);
};

const FIELDS = {
  kind: z.enum(['result', 'milestone', 'community']).describe('result = an outcome from outside the platform; milestone = a development milestone; community = a community outcome (e.g. children coached)'),
  title: z.string().trim().min(2).max(120), metric: z.string().trim().min(1).max(60), value: z.coerce.number().finite(), unit: z.string().trim().min(1).max(30),
  sample_size: z.coerce.number().int().min(1).max(100000000).describe('how many people, games or sessions the figure is based on'),
  source: z.enum(['organiser_record', 'third_party', 'self_reported']), source_ref: z.string().trim().min(2).max(200).describe('who or what the figure comes from, e.g. the body that issued it'),
  occurred_on: date, period_end: date, note: z.string().trim().min(1).max(1000),
};

/** Cross-field rules, checked before the database constraints so the message is plain. */
function check(r) {
  if (r.occurred_on > today()) throw badRequest('occurred_on is in the future; record what has already happened');
  if (r.period_end && r.period_end < r.occurred_on) throw badRequest('period_end is before occurred_on');
  if (r.value != null && !r.unit) throw badRequest('Give the unit for the value (e.g. children, hours, seconds)');
  if (r.kind === 'community' && (!r.metric || r.value == null || r.sample_size == null)) throw badRequest('A community outcome needs a metric, a value with its unit, and the sample size it is based on');
  if (r.source === 'third_party' && !r.source_ref) throw badRequest('Name the third party the figure comes from (source_ref)');
}
const COLS = ['kind', 'title', 'metric', 'value', 'unit', 'sample_size', 'source', 'source_ref', 'occurred_on', 'period_end'];
const insert = (c, sponsorshipId, r, note, userId, extra = {}) => c.query(
  `INSERT INTO sponsorship_impact_records(sponsorship_id, ${COLS.join(', ')}, note_enc, recorded_by, supersedes_id, correction_reason)
   VALUES ($1, ${COLS.map((_, n) => `$${n + 2}`).join(', ')}, $${COLS.length + 2}, $${COLS.length + 3}, $${COLS.length + 4}, $${COLS.length + 5}) RETURNING *`,
  [sponsorshipId, ...COLS.map((k) => r[k] ?? null), encrypt(note ?? null, NOTE_CTX), userId, extra.supersedes ?? null, extra.reason ?? null]);

/** The beneficiary side that may write: the athlete (or verified guardian), the team owner, the event organiser or an organisation representative. */
async function writer(c, sponsorshipId, user) {
  const ctx = await dealContext(c, sponsorshipId, user, { lock: true });
  if (ctx.role !== 'recipient') throw forbidden('Only the beneficiary records impact evidence; a sponsor cannot enter or change it');
  if (!RUNNING.includes(ctx.d.status)) throw conflict(`Evidence can be recorded once the agreement has been accepted (it is ${ctx.d.status})`);
  return ctx;
}

cap({
  name: 'record_sponsorship_impact', method: 'POST', path: '/sponsorships/:id/impact', tag: TAG, status: 201,
  summary: 'Beneficiary (athlete or guardian, team owner, event organiser, organisation representative): record a development milestone, a community outcome or a result from outside the platform for an agreement, with where it comes from (organiser record, third party or self-reported), the date or period, the unit and the sample size. Team and event games are read live from the platform and are not entered here. It is shown to the sponsor only while you have switched sharing on, labelled with its source, and it never changes a payment, a due or the agreement. A mistake is fixed with a correction, never by editing history.',
  input: z.object({ id, kind: FIELDS.kind, title: FIELDS.title, metric: FIELDS.metric.optional(), value: FIELDS.value.optional(), unit: FIELDS.unit.optional(), sample_size: FIELDS.sample_size.optional(), source: FIELDS.source, source_ref: FIELDS.source_ref.optional(),
    occurred_on: FIELDS.occurred_on, period_end: FIELDS.period_end.optional(), note: FIELDS.note.optional() }),
  async handler({ user }, i) {
    check(i);
    return tx(async (c) => {
      const ctx = await writer(c, i.id, user);
      const row = (await insert(c, ctx.d.id, i, i.note, user.id)).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'impact_recorded');
      if (ctx.d.performance_access) await ping(c, 'sponsor', ctx);
      return shapeRecord({ ...row, recorded_by_name: user.display_name }, i.note ?? null);
    });
  },
});

async function lockedRecord(c, recordId, user) {
  const r0 = (await c.query('SELECT sponsorship_id FROM sponsorship_impact_records WHERE id=$1', [recordId])).rows[0];
  if (!r0) throw notFound('Impact record');
  const ctx = await writer(c, r0.sponsorship_id, user);
  const r = (await c.query('SELECT * FROM sponsorship_impact_records WHERE id=$1 FOR UPDATE', [recordId])).rows[0];
  return { ctx, r };
}
const stale = (r, v) => { if (r.status !== 'current') throw conflict(`This record was already ${r.status}; reload to see the current figure`, { code: 'stale_version' }); if (r.row_version !== v) throw conflict(`This record was changed by someone else (now version ${r.row_version}); reload and try again`, { code: 'stale_version', current_version: r.row_version }); };

cap({
  name: 'correct_sponsorship_impact', method: 'POST', path: '/sponsorship-impact/:id/correction', tag: TAG, status: 201,
  summary: 'Beneficiary: correct an impact record. Send the row_version you saw and only the fields that change, with a reason. The old figure is kept (marked superseded, with the reason) and the corrected one replaces it in every current view and export at once; a stale version is refused with 409. A record can be corrected from its latest version only.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: z.string().trim().min(2).max(500), title: FIELDS.title.optional(), metric: FIELDS.metric.nullable().optional(), value: FIELDS.value.nullable().optional(), unit: FIELDS.unit.nullable().optional(),
    sample_size: FIELDS.sample_size.nullable().optional(), source: FIELDS.source.optional(), source_ref: FIELDS.source_ref.nullable().optional(), occurred_on: FIELDS.occurred_on.optional(), period_end: FIELDS.period_end.nullable().optional(), note: FIELDS.note.nullable().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, r } = await lockedRecord(c, i.id, user);
      stale(r, i.row_version);
      const next = { ...r, occurred_on: ymd(r.occurred_on), period_end: ymd(r.period_end), value: r.value === null ? null : Number(r.value) };
      for (const k of COLS) if (i[k] !== undefined) next[k] = i[k];
      check(next);
      const note = i.note === undefined ? (r.note_enc ? decrypt(r.note_enc, NOTE_CTX) : null) : i.note;
      await c.query("UPDATE sponsorship_impact_records SET status='superseded', row_version=row_version+1 WHERE id=$1", [r.id]);
      const row = (await insert(c, ctx.d.id, next, note, user.id, { supersedes: r.id, reason: i.reason })).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'impact_corrected');
      if (ctx.d.performance_access) await ping(c, 'sponsor', ctx);
      return shapeRecord({ ...row, recorded_by_name: user.display_name }, note);
    });
  },
});

cap({
  name: 'withdraw_sponsorship_impact', method: 'POST', path: '/sponsorship-impact/:id/withdraw', tag: TAG,
  summary: 'Beneficiary: withdraw an impact record that should not have been recorded. It disappears from current views and exports but is kept in the history with your reason. A stale version is refused with 409.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: z.string().trim().min(2).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ctx, r } = await lockedRecord(c, i.id, user);
      stale(r, i.row_version);
      const row = (await c.query("UPDATE sponsorship_impact_records SET status='withdrawn', row_version=row_version+1, correction_reason=$2 WHERE id=$1 RETURNING *", [r.id, i.reason])).rows[0];
      await logHistory(c, ctx.d.id, ctx.d.terms_version, user.id, 'impact_withdrawn');
      if (ctx.d.performance_access) await ping(c, 'sponsor', ctx);
      return shapeRecord({ ...row, recorded_by_name: user.display_name }, null);
    });
  },
});

/** Impact view of one agreement under the caller's live access (also the base of the export). */
async function readImpact(c, user, i, { exporting = false } = {}) {
  const ctx = await dealContext(c, i.id, user);
  if (ctx.role === 'admin') throw forbidden('Impact evidence is between the two sides');
  if (exporting && ctx.role === 'sponsor') ctx.need('export', 'export impact evidence');
  await assertSponsorMayRead(c, ctx, exporting ? 'export the beneficiary\'s results' : 'read the beneficiary\'s results');
  return ctx;
}

cap({
  name: 'list_sponsorship_impact', method: 'GET', path: '/sponsorships/:id/impact', tag: TAG,
  summary: 'Impact evidence of one agreement: development milestones, community outcomes and outside results, each with its source, date, unit and sample size, current figures first (corrections replace the figure they correct; `history=true` also lists superseded and withdrawn ones with the reason). `groups` summarises per kind, metric and unit; different metrics and units are never combined into one score. The sponsor reads this only while the beneficiary has switched sharing on (and only the shared kinds of source): after revocation the next read is refused with 403 and nothing is deleted. Reading by a sponsor is audit-logged.',
  input: z.object({ id, history: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const ctx = await readImpact(pool, user, i);
    const sources = sourcesFor(ctx);
    const rows = await listRecords(pool, ctx.d.id, { sources, history: i.history, limit: i.limit, offset: i.offset });
    const groups = (await pool.query(
      `SELECT kind, metric, unit, count(*)::int AS records, coalesce(sum(sample_size),0)::int AS sample_size, to_char(min(occurred_on),'YYYY-MM-DD') AS first_on, to_char(max(occurred_on),'YYYY-MM-DD') AS latest_on
         FROM sponsorship_impact_records WHERE sponsorship_id=$1 AND status='current' AND source = ANY($2::text[]) GROUP BY kind, metric, unit ORDER BY kind, metric NULLS FIRST, unit NULLS FIRST`, [ctx.d.id, sources])).rows;
    if (ctx.role === 'sponsor') await audit(null, user.id, 'read_sponsorship_impact', 'sponsorships', ctx.d.id);
    return {
      agreement_id: ctx.d.id, role: ctx.role, access: { enabled: ctx.d.performance_access, scope: ctx.d.performance_scope },
      sources_shown: sources.map((s) => ({ source: s, label: SOURCE_LABELS[s] })),
      total: rows[0]?.total ?? 0, limit: i.limit, offset: i.offset, groups,
      items: rows.map((r) => shapeRecord(r, r.note_enc ? decrypt(r.note_enc, NOTE_CTX) : null)),
      note: 'Entered by the beneficiary and labelled with its source; not verified by the platform. Corrections replace the corrected figure. Nothing here changes a payment, a due or the agreement.',
    };
  },
});

cap({
  name: 'export_sponsorship_impact', method: 'GET', path: '/sponsorships/:id/impact-export', tag: TAG,
  summary: 'CSV of the agreement\'s current impact evidence and, for a team or event, its live participation and results: kind, title, metric, value, unit, sample size, source, date or period. Free-text notes are not exported. Sponsor side: brand managers, finance and auditors, and only while the beneficiary\'s sharing is on (revoking stops the next export). Every export is audit-logged.',
  input: z.object({ id, from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    const ctx = await readImpact(pool, user, i, { exporting: true });
    const sources = sourcesFor(ctx);
    const stored = await listRecords(pool, ctx.d.id, { sources, history: false, limit: 5000, offset: 0 });
    const live = await teamEventResults(pool, ctx.d.target_type, ctx.d.target_id, { from: i.from, to: i.to });
    const out = stored.map((r) => { const x = shapeRecord(r, null); return { section: 'recorded', kind: x.kind, title: x.title, metric: x.metric ?? '', value: x.value ?? '', unit: x.unit ?? '', sample_size: x.sample_size ?? 'not stated', source: x.source_label, source_ref: x.source_ref ?? '', from: x.occurred_on, to: x.period_end ?? '', corrected: x.corrected ? 'yes' : 'no' }; });
    for (const r of live.results) out.push({ section: 'platform', kind: 'results', title: `${r.sport_name} - ${r.evidence_label}`, metric: 'wins-losses-ties', value: `${r.wins}-${r.losses}-${r.ties}`, unit: 'games', sample_size: r.sample_size, source: r.source_label, source_ref: '', from: r.first_on, to: r.latest_on, corrected: 'no' });
    await audit(null, user.id, 'export_sponsorship_impact', 'sponsorships', ctx.d.id);
    return { filename: 'sponsorship-impact.csv', rows: out.length, csv: toCsv(['section', 'kind', 'title', 'metric', 'value', 'unit', 'sample_size', 'source', 'source_ref', 'from', 'to', 'corrected'], out) };
  },
});

// ---- Pre-award evidence (#64) ----------------------------------------------------------------------------------------------------------------------
const SHARE_SECTIONS = ['show_matches', 'show_results', 'show_awards', 'show_credentials', 'show_career', 'show_video', 'show_references'];
const sectionsInput = Object.fromEntries(SHARE_SECTIONS.map((k) => [k, z.boolean().default(false)]));

cap({
  name: 'share_application_evidence', method: 'POST', path: '/program-applications/:id/evidence-share', tag: TAG,
  summary: 'Applicant: share evidence with the brand reviewing one funding application, or stop sharing it. An athlete chooses which passport sections to show (matches, approved results, awards, certificates, career, approved video and references - never contact details, health or academic files); this creates an expiring passport link tied to this application, which also appears (and can be revoked) among your passport links. A team or event applicant shares its live game results and entries. Revoking, or the link expiring, ends every later read and nothing is deleted. Only the applicant can do this, only while the application is submitted.',
  input: z.object({ id, enabled: z.boolean(), expires_in_days: z.number().int().min(1).max(90).default(60), ...sectionsInput }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM sponsorship_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a || a.applicant_id !== user.id) throw notFound('Application'); // never reveals another person's application
      const revoke = async () => { if (a.evidence_link_id) await c.query('UPDATE passport_links SET revoked_at=now(), version=version+1, updated_at=now() WHERE id=$1 AND revoked_at IS NULL', [a.evidence_link_id]); };
      if (!i.enabled) {
        await revoke();
        await c.query('UPDATE sponsorship_applications SET evidence_shared=false WHERE id=$1', [a.id]);
        await audit(c, user.id, 'revoke_application_evidence', 'sponsorship_applications', a.id);
        return { application_id: a.id, shared: false };
      }
      if (a.status !== 'submitted') throw conflict(`Evidence can be shared while the application is submitted (it is ${a.status})`);
      let linkId = null, expires = null, sections = null;
      if (a.target_type === 'athlete') {
        if (a.target_id !== user.id) throw forbidden('Only the athlete shares their own passport');
        sections = Object.fromEntries(SHARE_SECTIONS.map((k) => [k, i[k]]));
        if (!SHARE_SECTIONS.some((k) => i[k])) throw badRequest('Choose at least one section to share');
        await revoke(); // a new choice replaces the old link, so the scope can only be what was last chosen
        const flags = Object.fromEntries(SECTION_FLAGS.map((k) => [k, !!sections[k]]));
        const l = (await c.query(
          `INSERT INTO passport_links(user_id, created_by, token_hash, label, ${SECTION_FLAGS.join(', ')}, expires_at)
           VALUES ($1,$1,$2,'Funding application', ${SECTION_FLAGS.map((_, n) => `$${n + 3}`).join(', ')}, now() + $${SECTION_FLAGS.length + 3} * interval '1 day') RETURNING id, expires_at`,
          [user.id, sha256(newOpaqueToken()), ...SECTION_FLAGS.map((k) => flags[k]), i.expires_in_days])).rows[0]; // the secret is never kept: only this application can open the link
        linkId = l.id; expires = l.expires_at;
      }
      await c.query('UPDATE sponsorship_applications SET evidence_shared=true, evidence_link_id=$2, evidence_shared_at=now(), evidence_shared_by=$3 WHERE id=$1', [a.id, linkId, user.id]);
      await audit(c, user.id, 'share_application_evidence', 'sponsorship_applications', a.id);
      const sp = (await c.query('SELECT s.* FROM sponsors s JOIN sponsorship_programs p ON p.sponsor_id=s.id WHERE p.id=$1', [a.program_id])).rows[0];
      await notifySponsor(c, sp, 'evaluation', { kind: 'sponsorship_program', title: 'An applicant shared evidence', body: 'Open the application to review what was shared.', data: { program_id: a.program_id, application_id: a.id } });
      return { application_id: a.id, shared: true, expires_at: expires, sections };
    });
  },
});

cap({
  name: 'get_application_evidence', method: 'GET', path: '/program-applications/:id/evidence', tag: TAG,
  summary: 'Brand reviewer (evaluation role): the evidence an applicant chose to share with this application - an athlete\'s passport sections, or a team\'s or event\'s live results. `state` is `shared`, `not_shared`, `revoked` (it was shared and then withdrawn or expired: no figures are returned) or `closed` (the application is no longer under review). Consent, the link\'s expiry and a young person\'s guardian consent are re-checked on every read, and every read is audit-logged. Another brand gets 403; an anonymous applicant stays anonymous until they consent to be identified.',
  input: z.object({ id, from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    const a = (await pool.query('SELECT * FROM sponsorship_applications WHERE id=$1', [i.id])).rows[0];
    if (!a) throw notFound('Application');
    await programFor(user, a.program_id, 'evaluation', pool);
    const [shape] = await redactBlind([{ id: a.id }]);
    if (shape.anonymized) throw conflict('This applicant is anonymous until they consent to be identified; shared evidence identifies them');
    const base = { application_id: a.id, target_type: a.target_type, state: 'not_shared', shared_at: a.evidence_shared_at };
    if (!['submitted', 'awarded'].includes(a.status)) return { ...base, state: 'closed' };
    if (!a.evidence_shared) return { ...base, state: a.evidence_shared_at ? 'revoked' : 'not_shared' };
    if (a.target_type === 'athlete') {
      const link = a.evidence_link_id ? await liveLinkById(a.evidence_link_id) : null;
      if (!link) return { ...base, state: 'revoked' };
      const passport = await buildPassport(a.applicant_id, scopeOf(link), { viewerId: user.id });
      await audit(null, user.id, 'read_application_evidence', 'sponsorship_applications', a.id);
      return { ...base, state: 'shared', expires_at: link.expires_at, sections: scopeOf(link), passport, note: 'Shared by the applicant for this application only; self-reported items are labelled and not verified.' };
    }
    const team_event = await teamEventResults(pool, a.target_type, a.target_id, { from: i.from, to: i.to });
    await audit(null, user.id, 'read_application_evidence', 'sponsorship_applications', a.id);
    return { ...base, state: 'shared', team_event, note: 'Read live from the platform\'s game and entry records; sports are not combined into one score.' };
  },
});
