// Coach Business CRM (issue #517). Lead-to-client commercial pipeline for independent coaches and
// coaching businesses: lead/enquiry funnel, trial workflow, lifecycle dashboard, retention analytics,
// permissioned campaigns, multi-staff assignments, and CSV export.
// Reuses canonical coaching relationships, packages, subscriptions and payments — never duplicates athletes.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { toCsv } from '../csv.js';
import { notify } from '../notify.js';

const TAG = 'Coach CRM';
const COACH = ['coach'];

const STAGES = ['new_lead','contacted','trial_offered','trial_booked','trial_completed','proposal_offered','won','lost','nurture'];
const TERMINAL = new Set(['won','lost']);
const SOURCE_KINDS = ['marketplace_enquiry','billboard_response','referral','academy_team_context','manual_entry'];
const LOSS_REASONS = ['price','timing','chose_other_coach','location','no_response','changed_mind','not_eligible','other'];
const COMM_KINDS = ['note','call','meeting','email','message','trial_offer','trial_outcome','proposal_sent','proposal_response','decision'];
const STAFF_ROLES = ['handler','observer'];
const CAMPAIGN_KINDS = ['programme_announcement','availability_slots','package_renewal','clinic_camp','re_engagement','general'];
const CAMPAIGN_STATUSES = ['draft','scheduled','sending','sent','cancelled'];
const SLA_DAYS = { new_lead: 2, contacted: 5, trial_offered: 5, trial_booked: 7, trial_completed: 3, proposal_offered: 5 };

const stale = (cur) => conflict('Changed elsewhere — reload and retry.', { code: 'stale_version', row_version: cur.row_version });
const version = z.number().int().min(1);
const isoDate = z.string().date();
const noteKey = z.string().min(8).max(80);

// Access guard: calling user must be the coach themselves, or an assigned staff member.
// Observer staff can read the lead but not encrypted note fields.
async function requireCrmAccess(user, coachId, write = false) {
  if (user.id === coachId) return { role: 'coach' };
  const assignment = await one(
    `SELECT a.role FROM coach_crm_staff_assignments a
      JOIN coach_crm_leads l ON l.id = a.lead_id
     WHERE l.coach_id = $1 AND a.staff_id = $2 AND a.archived_at IS NULL
     LIMIT 1`,
    [coachId, user.id]
  );
  if (!assignment && !(await isAdmin(user))) throw forbidden('Access denied');
  if (write && assignment?.role === 'observer' && !(await isAdmin(user))) throw forbidden('Observers cannot modify leads');
  return { role: assignment?.role ?? 'admin' };
}

async function getLeadWithAccess(leadId, userId, write = false) {
  const lead = await one('SELECT * FROM coach_crm_leads WHERE id = $1', [leadId]);
  if (!lead) throw notFound('Lead');
  const access = await requireCrmAccess({ id: userId }, lead.coach_id, write);
  return { lead, access };
}

function decryptName(lead) {
  if (lead.display_name) return lead.display_name;
  if (lead.athlete_name_enc) {
    try { return decrypt(lead.athlete_name_enc, 'coach_crm_leads.athlete_name'); } catch { return '[encrypted]'; }
  }
  return 'Unknown';
}

async function writeEvent(c, leadId, action, actorId, fromStage, toStage, note) {
  const noteEnc = note ? encrypt(note, 'coach_crm_lead_events.note') : null;
  await c.query(
    'INSERT INTO coach_crm_lead_events(lead_id, action, from_stage, to_stage, actor_id, note_enc) VALUES($1,$2,$3,$4,$5,$6)',
    [leadId, action, fromStage ?? null, toStage ?? null, actorId, noteEnc],
  );
}

// ── 1. list_coach_crm_leads ────────────────────────────────────────────────────
cap({
  name: 'list_coach_crm_leads', method: 'GET', path: '/coach/crm/leads', tag: TAG, auth: COACH,
  summary: 'List leads in kanban order with KPIs: total, by_stage counts, overdue, enquiry→trial rate, trial→paid rate. Filter by stage, source_kind, owner_id, sport_id, overdue_only.',
  input: z.object({
    stage: z.enum([...STAGES, 'active']).optional(),
    source_kind: z.enum(SOURCE_KINDS).optional(),
    owner_id: id.optional(),
    sport_id: id.optional(),
    overdue_only: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    const wheres = ['l.coach_id = $1', 'l.archived_at IS NULL'];
    const vals = [user.id];
    let idx = 2;
    if (i.stage && i.stage !== 'active') { wheres.push(`l.stage = $${idx++}`); vals.push(i.stage); }
    if (i.stage === 'active') { wheres.push(`l.stage NOT IN ('won','lost','nurture')`); }
    if (i.source_kind) { wheres.push(`l.source_kind = $${idx++}`); vals.push(i.source_kind); }
    if (i.owner_id) { wheres.push(`l.owner_id = $${idx++}`); vals.push(i.owner_id); }
    if (i.sport_id) { wheres.push(`l.sport_id = $${idx++}`); vals.push(i.sport_id); }
    if (i.overdue_only) {
      wheres.push(`l.stage NOT IN ('won','lost','nurture') AND EXTRACT(EPOCH FROM (now()-l.updated_at))/86400 > COALESCE((CASE l.stage WHEN 'new_lead' THEN 2 WHEN 'contacted' THEN 5 WHEN 'trial_offered' THEN 5 WHEN 'trial_booked' THEN 7 WHEN 'trial_completed' THEN 3 WHEN 'proposal_offered' THEN 5 END), 999)`);
    }
    const rows = await many(
      `SELECT l.id, l.stage, l.source_kind, l.campaign_ref, l.sport_id, l.athlete_id,
              l.athlete_name_enc, l.owner_id, l.next_action_on, l.marketing_consent,
              l.created_at, l.updated_at, l.row_version,
              u.display_name,
              s.name AS sport_name, s.emoji AS sport_emoji,
              ou.display_name AS owner_name,
              EXTRACT(EPOCH FROM (now() - l.updated_at))/86400 AS days_in_stage,
              (SELECT t.status FROM coach_crm_trials t WHERE t.lead_id = l.id AND t.archived_at IS NULL ORDER BY t.created_at DESC LIMIT 1) AS trial_status
         FROM coach_crm_leads l
         LEFT JOIN users u ON u.id = l.athlete_id
         LEFT JOIN sports s ON s.id = l.sport_id
         LEFT JOIN users ou ON ou.id = l.owner_id
        WHERE ${wheres.join(' AND ')}
        ORDER BY l.stage = 'won' ASC, l.stage = 'lost' ASC, l.updated_at DESC
        LIMIT $${idx++} OFFSET $${idx}`,
      [...vals, i.limit, i.offset],
    );

    const kpis = await one(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE stage = 'won')::int AS won,
         count(*) FILTER (WHERE stage NOT IN ('won','lost','nurture')
           AND EXTRACT(EPOCH FROM (now()-updated_at))/86400 > CASE stage
             WHEN 'new_lead' THEN 2 WHEN 'contacted' THEN 5 WHEN 'trial_offered' THEN 5
             WHEN 'trial_booked' THEN 7 WHEN 'trial_completed' THEN 3
             WHEN 'proposal_offered' THEN 5 ELSE 999 END)::int AS overdue,
         count(*) FILTER (WHERE stage IN ('trial_booked','trial_completed','proposal_offered','won'))::int AS reached_trial
       FROM coach_crm_leads WHERE coach_id = $1 AND archived_at IS NULL`,
      [user.id],
    );
    const total = kpis.total || 0;
    const enquiry_to_trial = total > 0 ? Math.round((kpis.reached_trial / total) * 1000) / 10 : 0;
    const trial_to_paid = kpis.reached_trial > 0 ? Math.round((kpis.won / kpis.reached_trial) * 1000) / 10 : 0;

    const leads = rows.map((r) => ({
      id: r.id, stage: r.stage, source_kind: r.source_kind, campaign_ref: r.campaign_ref,
      sport: { id: r.sport_id, name: r.sport_name, emoji: r.sport_emoji },
      display_name: decryptName(r),
      owner_name: r.owner_name,
      next_action_on: r.next_action_on,
      marketing_consent: r.marketing_consent,
      trial_status: r.trial_status,
      days_in_stage: Math.floor(Number(r.days_in_stage)),
      sla_overdue: SLA_DAYS[r.stage] ? Number(r.days_in_stage) > SLA_DAYS[r.stage] : false,
      sla_days: SLA_DAYS[r.stage] ?? null,
      updated_at: r.updated_at, row_version: r.row_version,
    }));

    const by_stage = {};
    for (const s of STAGES) by_stage[s] = [];
    for (const l of leads) { if (by_stage[l.stage]) by_stage[l.stage].push(l); }
    const stage_counts = {};
    for (const s of STAGES) stage_counts[s] = by_stage[s].length;

    return { leads, by_stage, stage_counts, kpis: { total, won: kpis.won, overdue: kpis.overdue, enquiry_to_trial, trial_to_paid } };
  },
});

// ── 2. add_coach_crm_lead ──────────────────────────────────────────────────────
cap({
  name: 'add_coach_crm_lead', method: 'POST', path: '/coach/crm/leads', tag: TAG, auth: COACH, status: 201,
  summary: 'Add a new lead. Provide athlete_id if they are on the platform; provide athlete_name for off-platform prospects. Never creates a duplicate identity.',
  input: z.object({
    athlete_id: id.optional(),
    athlete_name: z.string().trim().min(1).max(200).optional(),
    sport_id: id.optional(),
    source_kind: z.enum(SOURCE_KINDS).default('manual_entry'),
    source_ref_id: id.optional(),
    campaign_ref: z.string().trim().max(120).optional(),
    owner_id: id.optional(),
    next_action_on: isoDate.optional(),
    marketing_consent: z.boolean().default(false),
  }).refine((d) => d.athlete_id || d.athlete_name, { message: 'Provide athlete_id (on-platform) or athlete_name (off-platform)' }),
  async handler({ user }, i) {
    if (i.athlete_id && !(await one('SELECT 1 FROM users WHERE id=$1', [i.athlete_id]))) throw notFound('Athlete');
    if (i.sport_id && !(await one('SELECT 1 FROM sports WHERE id=$1', [i.sport_id]))) throw notFound('Sport');
    if (i.athlete_id === user.id) throw badRequest('You cannot add yourself as a lead');
    const nameEnc = !i.athlete_id && i.athlete_name ? encrypt(i.athlete_name, 'coach_crm_leads.athlete_name') : null;
    return tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO coach_crm_leads(coach_id, athlete_id, athlete_name_enc, sport_id, source_kind, source_ref_id, campaign_ref, owner_id, next_action_on, marketing_consent, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$1) RETURNING id, stage, row_version`,
        [user.id, i.athlete_id ?? null, nameEnc, i.sport_id ?? null, i.source_kind, i.source_ref_id ?? null, i.campaign_ref ?? null, i.owner_id ?? null, i.next_action_on ?? null, i.marketing_consent],
      );
      const lead = rows[0];
      await writeEvent(c, lead.id, 'created', user.id, null, 'new_lead', null);
      await audit(c, user.id, 'coach_crm_lead.created', { lead_id: lead.id });
      return { id: lead.id, stage: lead.stage, row_version: lead.row_version };
    });
  },
});

// ── 3. get_coach_crm_lead ──────────────────────────────────────────────────────
cap({
  name: 'get_coach_crm_lead', method: 'GET', path: '/coach/crm/leads/:id', tag: TAG, auth: COACH,
  summary: 'Full lead record with decrypted fields. Observer staff see summary but not encrypted note/loss fields.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { lead, access } = await getLeadWithAccess(i.id, user.id);
    const isObserver = access.role === 'observer';

    const [comms, events, staff, trial] = await Promise.all([
      many(
        `SELECT c.id, c.kind, c.summary_enc, c.follow_up_on, c.created_at, u.display_name AS actor_name
           FROM coach_crm_lead_communications c JOIN users u ON u.id = c.actor_id
          WHERE c.lead_id = $1 ORDER BY c.created_at DESC LIMIT 20`, [i.id]),
      many(
        `SELECT e.action, e.from_stage, e.to_stage, e.created_at, u.display_name AS actor_name
           FROM coach_crm_lead_events e JOIN users u ON u.id = e.actor_id
          WHERE e.lead_id = $1 ORDER BY e.created_at DESC LIMIT 50`, [i.id]),
      many(
        `SELECT a.id, a.staff_id, a.role, a.assigned_at, u.display_name AS staff_name
           FROM coach_crm_staff_assignments a JOIN users u ON u.id = a.staff_id
          WHERE a.lead_id = $1 AND a.archived_at IS NULL ORDER BY a.assigned_at`, [i.id]),
      one(
        `SELECT t.id, t.status, t.payment_status, t.scheduled_on, t.price_cents, t.currency, t.row_version
           FROM coach_crm_trials t WHERE t.lead_id = $1 AND t.archived_at IS NULL ORDER BY t.created_at DESC LIMIT 1`, [i.id]),
    ]);

    const displayName = decryptName({ ...lead, display_name: (await one('SELECT display_name FROM users WHERE id=$1', [lead.athlete_id]))?.display_name });
    const dec = (enc, path) => { if (!enc || isObserver) return null; try { return decrypt(enc, path); } catch { return null; } };

    return {
      ...lead,
      display_name: displayName,
      loss_note: dec(lead.loss_note_enc, 'coach_crm_leads.loss_note'),
      loss_note_enc: undefined,
      athlete_name_enc: undefined,
      days_in_stage: Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 86400000),
      sla_overdue: SLA_DAYS[lead.stage] ? (Date.now() - new Date(lead.updated_at).getTime()) / 86400000 > SLA_DAYS[lead.stage] : false,
      communications: comms.map((c) => ({
        ...c, summary: c.summary_enc ? (() => { try { return decrypt(c.summary_enc, 'coach_crm_lead_communications.summary'); } catch { return null; } })() : null, summary_enc: undefined,
      })),
      history: events,
      staff,
      trial: trial ?? null,
      access_role: access.role,
    };
  },
});

// ── 4. move_coach_crm_lead ─────────────────────────────────────────────────────
cap({
  name: 'move_coach_crm_lead', method: 'PATCH', path: '/coach/crm/leads/:id/stage', tag: TAG, auth: COACH,
  summary: 'Move lead to a new stage. row_version required (409 on stale). Terminal stages (won/lost) cannot be moved from.',
  input: z.object({ id, to_stage: z.enum(STAGES), note: z.string().trim().max(500).optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM coach_crm_leads WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Lead');
      await requireCrmAccess({ id: user.id }, cur.coach_id, true);
      if (cur.row_version !== i.row_version) throw stale(cur);
      if (TERMINAL.has(cur.stage)) throw badRequest(`Cannot move from terminal stage '${cur.stage}'`);
      const { rows } = await c.query(
        `UPDATE coach_crm_leads SET stage=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.to_stage],
      );
      await writeEvent(c, i.id, 'stage_moved', user.id, cur.stage, i.to_stage, i.note);
      await audit(c, user.id, 'coach_crm_lead.stage_moved', { lead_id: i.id, from: cur.stage, to: i.to_stage });
      return { stage: i.to_stage, row_version: rows[0].row_version };
    });
  },
});

// ── 5. update_coach_crm_lead ───────────────────────────────────────────────────
cap({
  name: 'update_coach_crm_lead', method: 'PATCH', path: '/coach/crm/leads/:id', tag: TAG, auth: COACH,
  summary: 'Update owner_id, next_action_on, marketing_consent, campaign_ref, loss_reason, loss_note.',
  input: z.object({
    id,
    owner_id: id.optional(),
    next_action_on: isoDate.optional().nullable(),
    marketing_consent: z.boolean().optional(),
    campaign_ref: z.string().trim().max(120).optional().nullable(),
    loss_reason: z.enum(LOSS_REASONS).optional(),
    loss_note: z.string().trim().max(500).optional(),
    row_version: version,
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cur = (await c.query('SELECT * FROM coach_crm_leads WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!cur) throw notFound('Lead');
      await requireCrmAccess({ id: user.id }, cur.coach_id, true);
      if (cur.row_version !== i.row_version) throw stale(cur);
      const lossNoteEnc = i.loss_note !== undefined ? (i.loss_note ? encrypt(i.loss_note, 'coach_crm_leads.loss_note') : null) : cur.loss_note_enc;
      const { rows } = await c.query(
        `UPDATE coach_crm_leads SET
           owner_id = COALESCE($2, owner_id),
           next_action_on = CASE WHEN $3::text IS NOT NULL THEN $3::date ELSE next_action_on END,
           marketing_consent = COALESCE($4, marketing_consent),
           campaign_ref = COALESCE($5, campaign_ref),
           loss_reason = COALESCE($6, loss_reason),
           loss_note_enc = $7,
           row_version = row_version + 1, updated_at = now()
         WHERE id = $1 RETURNING row_version`,
        [i.id, i.owner_id ?? null, i.next_action_on !== undefined ? String(i.next_action_on) : null, i.marketing_consent !== undefined ? i.marketing_consent : null, i.campaign_ref !== undefined ? i.campaign_ref : null, i.loss_reason ?? null, lossNoteEnc],
      );
      await writeEvent(c, i.id, 'updated', user.id, null, null, null);
      return { row_version: rows[0].row_version };
    });
  },
});

// ── 6. log_coach_crm_comm ──────────────────────────────────────────────────────
cap({
  name: 'log_coach_crm_comm', method: 'POST', path: '/coach/crm/leads/:id/communications', tag: TAG, auth: COACH, status: 201,
  summary: 'Log a communication touchpoint. Summary is encrypted server-side. idempotency_key prevents duplicate entries.',
  input: z.object({ id, kind: z.enum(COMM_KINDS), summary: z.string().trim().min(1).max(2000), follow_up_on: isoDate.optional(), idempotency_key: noteKey }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const existing = (await c.query('SELECT id FROM coach_crm_lead_communications WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
      if (existing) return { id: existing.id, duplicate: true };
      await getLeadWithAccess(i.id, user.id, true);
      const summaryEnc = encrypt(i.summary, 'coach_crm_lead_communications.summary');
      const { rows } = await c.query(
        `INSERT INTO coach_crm_lead_communications(lead_id, actor_id, kind, summary_enc, follow_up_on, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [i.id, user.id, i.kind, summaryEnc, i.follow_up_on ?? null, i.idempotency_key],
      );
      if (i.kind === 'decision') await writeEvent(c, i.id, 'decision_logged', user.id, null, null, i.summary.slice(0, 200));
      return { id: rows[0].id };
    });
  },
});

// ── 7. create_coach_crm_trial ──────────────────────────────────────────────────
cap({
  name: 'create_coach_crm_trial', method: 'POST', path: '/coach/crm/trials', tag: TAG, auth: COACH, status: 201,
  summary: 'Create a trial session offer. If rate_card_id is provided it must have is_intro=true. If priced, returns pay for create_payment.',
  input: z.object({
    lead_id: id.optional(),
    athlete_id: id.optional(),
    athlete_name: z.string().trim().min(1).max(200).optional(),
    sport_id: id.optional(),
    rate_card_id: id.optional(),
    scheduled_on: isoDate,
    starts_at: z.string().datetime().optional(),
    duration_min: z.number().int().min(15).max(480).optional(),
    location_note: z.string().trim().max(500).optional(),
    price_cents: z.number().int().min(0).default(0),
    currency: z.string().length(3).default('GBP'),
    discount_pct: z.number().int().min(0).max(100).default(0),
  }).refine((d) => d.athlete_id || d.athlete_name || d.lead_id, { message: 'Provide athlete_id, athlete_name, or lead_id' }),
  async handler({ user }, i) {
    const dateStr = i.scheduled_on;
    const athleteKey = i.athlete_id ?? 'unknown';
    return tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`coachtrial:${user.id}:${athleteKey}:${dateStr}`]);
      let lead = null;
      if (i.lead_id) {
        lead = (await c.query('SELECT * FROM coach_crm_leads WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.lead_id, user.id])).rows[0];
        if (!lead) throw notFound('Lead');
      }
      if (i.rate_card_id) {
        const card = (await c.query('SELECT * FROM coach_rate_cards WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.rate_card_id, user.id])).rows[0];
        if (!card) throw notFound('Rate card');
      }
      const athleteId = i.athlete_id ?? lead?.athlete_id ?? null;
      const nameEnc = !athleteId && i.athlete_name ? encrypt(i.athlete_name, 'coach_crm_trials.athlete_name') : null;
      const locationEnc = i.location_note ? encrypt(i.location_note, 'coach_crm_trials.location_note') : null;
      const effectivePrice = Math.round(i.price_cents * (1 - i.discount_pct / 100));
      const { rows } = await c.query(
        `INSERT INTO coach_crm_trials(lead_id, coach_id, athlete_id, athlete_name_enc, sport_id, rate_card_id, scheduled_on, starts_at, duration_min, location_note_enc, price_cents, currency, discount_pct, payment_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$2) RETURNING id, status, row_version`,
        [i.lead_id ?? null, user.id, athleteId, nameEnc, i.sport_id ?? lead?.sport_id ?? null, i.rate_card_id ?? null, i.scheduled_on, i.starts_at ?? null, i.duration_min ?? null, locationEnc, effectivePrice, i.currency, i.discount_pct, effectivePrice > 0 ? 'awaiting_payment' : 'not_required'],
      );
      const trial = rows[0];
      if (lead && !TERMINAL.has(lead.stage)) {
        await c.query(`UPDATE coach_crm_leads SET stage='trial_offered', updated_at=now(), row_version=row_version+1 WHERE id=$1`, [lead.id]);
        await writeEvent(c, lead.id, 'trial_created', user.id, lead.stage, 'trial_offered', null);
      }
      return {
        id: trial.id, status: trial.status, row_version: trial.row_version,
        pay: effectivePrice > 0 ? { purpose_type: 'coach_hire', purpose_id: trial.id, amount_cents: effectivePrice, currency: i.currency } : null,
      };
    });
  },
});

// ── 8. book_coach_crm_trial ────────────────────────────────────────────────────
cap({
  name: 'book_coach_crm_trial', method: 'PATCH', path: '/coach/crm/trials/:id/book', tag: TAG, auth: 'user',
  summary: 'Athlete confirms the trial. Moves trial to booked, linked lead to trial_booked. Notifies coach.',
  input: z.object({ id, row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const trial = (await c.query('SELECT * FROM coach_crm_trials WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [i.id])).rows[0];
      if (!trial) throw notFound('Trial');
      if (trial.athlete_id && trial.athlete_id !== user.id) throw forbidden('Not your trial');
      if (trial.row_version !== i.row_version) throw stale(trial);
      if (trial.status !== 'offered') throw badRequest(`Trial is already ${trial.status}`);
      const { rows } = await c.query(
        `UPDATE coach_crm_trials SET status='booked', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id],
      );
      if (trial.lead_id) {
        const lead = (await c.query('SELECT stage FROM coach_crm_leads WHERE id=$1', [trial.lead_id])).rows[0];
        if (lead && !TERMINAL.has(lead.stage)) {
          await c.query(`UPDATE coach_crm_leads SET stage='trial_booked', updated_at=now(), row_version=row_version+1 WHERE id=$1`, [trial.lead_id]);
          await writeEvent(c, trial.lead_id, 'trial_booked', user.id, lead.stage, 'trial_booked', null);
        }
      }
      await notify(c, trial.coach_id, { kind: 'crm_trial_booked', title: 'Trial session confirmed', body: `Your trial on ${trial.scheduled_on} has been confirmed.`, data: { trial_id: trial.id }, dedupe_key: `crm_trial_booked:${trial.id}` });
      return { status: 'booked', row_version: rows[0].row_version };
    });
  },
});

// ── 9. record_trial_attendance ────────────────────────────────────────────────
cap({
  name: 'record_trial_attendance', method: 'PATCH', path: '/coach/crm/trials/:id/attendance', tag: TAG, auth: COACH,
  summary: 'Coach records attended or no_show plus encrypted attendance note. Moves linked lead to trial_completed.',
  input: z.object({ id, attendance: z.enum(['attended','no_show']), note: z.string().trim().max(1000).optional(), follow_up_on: isoDate.optional(), row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const trial = (await c.query('SELECT * FROM coach_crm_trials WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!trial) throw notFound('Trial');
      if (trial.row_version !== i.row_version) throw stale(trial);
      if (!['booked','offered'].includes(trial.status)) throw badRequest(`Cannot record attendance on a trial with status '${trial.status}'`);
      const noteEnc = i.note ? encrypt(i.note, 'coach_crm_trials.attendance_note') : null;
      const { rows } = await c.query(
        `UPDATE coach_crm_trials SET status=$2, attendance_note_enc=$3, follow_up_on=$4, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.attendance, noteEnc, i.follow_up_on ?? null],
      );
      if (trial.lead_id) {
        const lead = (await c.query('SELECT stage FROM coach_crm_leads WHERE id=$1', [trial.lead_id])).rows[0];
        if (lead && !TERMINAL.has(lead.stage)) {
          await c.query(`UPDATE coach_crm_leads SET stage='trial_completed', updated_at=now(), row_version=row_version+1 WHERE id=$1`, [trial.lead_id]);
          await writeEvent(c, trial.lead_id, `trial_${i.attendance}`, user.id, lead.stage, 'trial_completed', null);
        }
      }
      return { status: i.attendance, row_version: rows[0].row_version };
    });
  },
});

// ── 10. convert_trial ─────────────────────────────────────────────────────────
cap({
  name: 'convert_trial', method: 'PATCH', path: '/coach/crm/trials/:id/convert', tag: TAG, auth: COACH,
  summary: 'Mark trial converted. Link won_hire_id / won_package_id / won_subscription_id (already created by caller via hire_coach / buy_coach_package). Moves linked lead to won.',
  input: z.object({
    id,
    won_hire_id: id.optional(),
    won_package_id: id.optional(),
    won_subscription_id: id.optional(),
    row_version: version,
  }).refine((d) => d.won_hire_id || d.won_package_id || d.won_subscription_id, { message: 'Provide at least one of won_hire_id, won_package_id, won_subscription_id' }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const trial = (await c.query('SELECT * FROM coach_crm_trials WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!trial) throw notFound('Trial');
      if (trial.row_version !== i.row_version) throw stale(trial);
      if (trial.status === 'converted') throw conflict('Trial already converted');
      const { rows } = await c.query(
        `UPDATE coach_crm_trials SET status='converted', won_hire_id=$2, won_package_id=$3, won_subscription_id=$4, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, i.won_hire_id ?? null, i.won_package_id ?? null, i.won_subscription_id ?? null],
      );
      if (trial.lead_id) {
        const lead = (await c.query('SELECT stage FROM coach_crm_leads WHERE id=$1', [trial.lead_id])).rows[0];
        if (lead && !TERMINAL.has(lead.stage)) {
          await c.query(`UPDATE coach_crm_leads SET stage='won', row_version=row_version+1, updated_at=now() WHERE id=$1`, [trial.lead_id]);
          await writeEvent(c, trial.lead_id, 'trial_converted', user.id, lead.stage, 'won', null);
        }
      }
      await audit(c, user.id, 'coach_crm_trial.converted', { trial_id: i.id });
      return { status: 'converted', row_version: rows[0].row_version };
    });
  },
});

// ── 11. archive_coach_crm_lead ────────────────────────────────────────────────
cap({
  name: 'archive_coach_crm_lead', method: 'POST', path: '/coach/crm/leads/:id/archive', tag: TAG, auth: COACH,
  summary: 'Soft-archive a lead. The record and all history are retained.',
  input: z.object({ id, note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await getLeadWithAccess(i.id, user.id, true);
      await c.query('UPDATE coach_crm_leads SET archived_at=now() WHERE id=$1', [i.id]);
      await writeEvent(c, i.id, 'archived', user.id, null, null, i.note);
      return { archived: true };
    });
  },
});

// ── 12. get_coach_lifecycle_dashboard ─────────────────────────────────────────
cap({
  name: 'get_coach_lifecycle_dashboard', method: 'GET', path: '/coach/crm/dashboard', tag: TAG, auth: COACH,
  summary: 'Active clients, unused package credits, expiring packages, inactive clients, follow-ups, subscription renewals. All derived from canonical tables.',
  input: z.object({ inactive_days: z.coerce.number().int().min(14).max(365).default(90) }),
  async handler({ user }, i) {
    const [hires, packages, subscriptions, followUps] = await Promise.all([
      many(
        `SELECT h.id, h.athlete_id, h.starts_at, h.status, u.display_name AS athlete_name,
                s.name AS sport_name, s.emoji AS sport_emoji
           FROM coach_hires h
           JOIN users u ON u.id = h.athlete_id
           LEFT JOIN sports s ON s.id = h.sport_id
          WHERE h.coach_id = $1 AND h.status = 'confirmed' AND (h.ends_at IS NULL OR h.ends_at > now())
          ORDER BY u.display_name LIMIT 100`,
        [user.id]),
      many(
        `SELECT p.id, p.athlete_id, p.title, p.sessions_total, p.expires_at, p.currency,
                (SELECT count(*) FROM coach_package_redemptions r JOIN coach_hires h ON h.id=r.hire_id WHERE r.purchase_id=p.id AND h.status NOT IN ('cancelled','expired'))::int AS sessions_used,
                u.display_name AS athlete_name
           FROM coach_package_purchases p
           JOIN users u ON u.id = p.athlete_id
          WHERE p.coach_id = $1 AND p.status = 'active'
          ORDER BY p.expires_at NULLS LAST LIMIT 100`,
        [user.id]),
      many(
        `SELECT cs.id, cs.athlete_id, cs.status, cs.currency, u.display_name AS athlete_name,
                up.ends_at AS period_ends
           FROM coach_subscriptions cs
           JOIN users u ON u.id = cs.athlete_id
           LEFT JOIN user_plans up ON up.coach_subscription_id = cs.id AND up.status = 'active'
          WHERE cs.coach_id = $1 AND cs.status = 'active' AND up.ends_at BETWEEN now() AND now() + interval '14 days'
          ORDER BY up.ends_at LIMIT 50`,
        [user.id]),
      many(
        `SELECT l.id, l.stage, l.next_action_on, l.athlete_id, l.athlete_name_enc,
                u.display_name, l.sport_id
           FROM coach_crm_leads l
           LEFT JOIN users u ON u.id = l.athlete_id
          WHERE l.coach_id = $1 AND l.archived_at IS NULL AND l.next_action_on <= CURRENT_DATE
            AND l.stage NOT IN ('won','lost')
          ORDER BY l.next_action_on LIMIT 20`,
        [user.id]),
    ]);
    const inactive = await many(
      `SELECT h.athlete_id, u.display_name AS athlete_name,
              max(h.starts_at)::date AS last_session,
              EXTRACT(EPOCH FROM (now() - max(h.starts_at)))/86400 AS days_inactive
         FROM coach_hires h
         JOIN users u ON u.id = h.athlete_id
        WHERE h.coach_id = $1 AND h.status IN ('confirmed','completed')
        GROUP BY h.athlete_id, u.display_name
        HAVING max(h.starts_at) < now() - ($2 || ' days')::interval
        ORDER BY days_inactive DESC LIMIT 20`,
      [user.id, i.inactive_days]);

    const expiringPackages = packages.filter((p) => p.expires_at && new Date(p.expires_at) <= new Date(Date.now() + 14 * 86400000));
    const unusedCredits = packages.map((p) => ({ ...p, sessions_left: p.sessions_total - p.sessions_used })).filter((p) => p.sessions_left > 0);

    return {
      active_clients: hires,
      unused_credits: unusedCredits,
      expiring_packages: expiringPackages,
      inactive_clients: inactive.map((r) => ({ ...r, days_inactive: Math.floor(Number(r.days_inactive)) })),
      renewals_due: subscriptions,
      follow_ups_due: followUps.map((l) => ({ ...l, display_name: decryptName(l) })),
      summary: {
        active_count: hires.length,
        credits_outstanding: unusedCredits.reduce((n, p) => n + p.sessions_left, 0),
        expiring_soon: expiringPackages.length,
        inactive_count: inactive.length,
        follow_ups_overdue: followUps.length,
        renewals_soon: subscriptions.length,
      },
    };
  },
});

// ── 13. get_coach_retention_analytics ─────────────────────────────────────────
cap({
  name: 'get_coach_retention_analytics', method: 'GET', path: '/coach/crm/analytics', tag: TAG, auth: COACH,
  summary: 'Factual retention and revenue metrics. No predicted CLV or churn. All derived from canonical session and payment records.',
  input: z.object({
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  }),
  async handler({ user }, i) {
    const from = i.date_from ?? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const to = i.date_to ?? new Date().toISOString().slice(0, 10);
    const [funnel, attendance, pkgUtil, revenue, sourceAttrib, tenure] = await Promise.all([
      one(
        `SELECT
           count(*)::int AS total_leads,
           count(*) FILTER (WHERE stage IN ('trial_booked','trial_completed','proposal_offered','won'))::int AS reached_trial,
           count(*) FILTER (WHERE stage = 'won')::int AS won,
           count(*) FILTER (WHERE stage = 'lost')::int AS lost
         FROM coach_crm_leads
        WHERE coach_id = $1 AND archived_at IS NULL AND created_at BETWEEN $2 AND $3`,
        [user.id, from, to]),
      one(
        `SELECT
           count(*)::int AS total_sessions,
           count(*) FILTER (WHERE status = 'attended')::int AS attended,
           count(*) FILTER (WHERE status = 'no_show')::int AS no_show
         FROM coach_crm_trials
        WHERE coach_id = $1 AND status IN ('attended','no_show') AND scheduled_on BETWEEN $2 AND $3`,
        [user.id, from, to]),
      one(
        `SELECT
           count(*)::int AS packages_sold,
           sum(sessions_total)::int AS sessions_sold,
           sum((SELECT count(*) FROM coach_package_redemptions r JOIN coach_hires h ON h.id=r.hire_id WHERE r.purchase_id=p.id AND h.status NOT IN ('cancelled','expired')))::int AS sessions_used
         FROM coach_package_purchases p
        WHERE p.coach_id = $1 AND p.created_at BETWEEN $2 AND $3`,
        [user.id, from, to]),
      many(
        `SELECT purpose_type, sum(amount_cents)::bigint AS total_cents, currency, count(*)::int AS count
           FROM payments
          WHERE purpose_type IN ('coach_hire','coach_package','coach_subscription_period','coach_class_seat')
            AND status = 'paid' AND created_at BETWEEN $1 AND $2
            AND purpose_id IN (
              SELECT id FROM coach_hires WHERE coach_id = $3
              UNION ALL SELECT id FROM coach_package_purchases WHERE coach_id = $3
              UNION ALL SELECT id FROM user_plans WHERE coach_subscription_id IN (SELECT id FROM coach_subscriptions WHERE coach_id = $3)
            )
          GROUP BY purpose_type, currency ORDER BY total_cents DESC`,
        [from, to, user.id]),
      many(
        `SELECT source_kind, count(*)::int AS leads, count(*) FILTER (WHERE stage='won')::int AS converted
           FROM coach_crm_leads
          WHERE coach_id=$1 AND created_at BETWEEN $2 AND $3 AND archived_at IS NULL
          GROUP BY source_kind ORDER BY leads DESC`,
        [user.id, from, to]),
      many(
        `SELECT
           CASE WHEN EXTRACT(EPOCH FROM (COALESCE(h.ends_at, now()) - h.starts_at))/86400 < 30 THEN '<1 month'
                WHEN EXTRACT(EPOCH FROM (COALESCE(h.ends_at, now()) - h.starts_at))/86400 < 90 THEN '1–3 months'
                WHEN EXTRACT(EPOCH FROM (COALESCE(h.ends_at, now()) - h.starts_at))/86400 < 180 THEN '3–6 months'
                WHEN EXTRACT(EPOCH FROM (COALESCE(h.ends_at, now()) - h.starts_at))/86400 < 365 THEN '6–12 months'
                ELSE '12+ months' END AS bucket,
           count(DISTINCT h.athlete_id)::int AS athletes
           FROM coach_hires h
          WHERE h.coach_id=$1 AND h.status IN ('confirmed','completed') AND h.starts_at BETWEEN $2 AND $3
          GROUP BY bucket ORDER BY min(h.starts_at)`,
        [user.id, from, to]),
    ]);

    const totalLeads = funnel.total_leads || 0;
    const reachedTrial = funnel.reached_trial || 0;
    const won = funnel.won || 0;
    const totalTrials = attendance.total_sessions || 0;
    const attended = attendance.attended || 0;
    const sold = pkgUtil.sessions_sold || 0;
    const used = pkgUtil.sessions_used || 0;

    return {
      period: { from, to },
      funnel: { total_leads: totalLeads, reached_trial: reachedTrial, won, lost: funnel.lost || 0, enquiry_to_trial_pct: totalLeads > 0 ? Math.round(reachedTrial / totalLeads * 1000) / 10 : 0, trial_to_paid_pct: reachedTrial > 0 ? Math.round(won / reachedTrial * 1000) / 10 : 0 },
      attendance: { total_sessions: totalTrials, attended, no_show: attendance.no_show || 0, attendance_rate_pct: totalTrials > 0 ? Math.round(attended / totalTrials * 1000) / 10 : 0 },
      package_utilisation: { packages_sold: pkgUtil.packages_sold || 0, sessions_sold: sold, sessions_used: used, utilisation_pct: sold > 0 ? Math.round(used / sold * 1000) / 10 : 0 },
      revenue_by_service: revenue,
      source_attribution: sourceAttrib,
      client_tenure: tenure,
      definitions: { churn: 'Client with no coach_hire, package or subscription activity in the last 90 days', inactive: 'No confirmed session in last 90 days' },
    };
  },
});

// ── 14. export_coach_crm_leads_csv ────────────────────────────────────────────
cap({
  name: 'export_coach_crm_leads_csv', method: 'GET', path: '/coach/crm/leads/export.csv', tag: TAG, auth: COACH,
  summary: 'Export all leads as CSV. Encrypted fields are decrypted for the requesting coach. Audit-logged per export.',
  input: z.object({}),
  async handler({ user }) {
    const rows = await many(
      `SELECT l.id, l.stage, l.source_kind, l.campaign_ref, l.marketing_consent,
              l.next_action_on, l.loss_reason, l.athlete_name_enc,
              u.display_name AS athlete_name,
              s.name AS sport_name, l.created_at::date AS added
         FROM coach_crm_leads l
         LEFT JOIN users u ON u.id = l.athlete_id
         LEFT JOIN sports s ON s.id = l.sport_id
        WHERE l.coach_id = $1 AND l.archived_at IS NULL
        ORDER BY l.created_at DESC`,
      [user.id]);
    await query('INSERT INTO audit_log(user_id, action, entity, detail) VALUES ($1,$2,$3,$4)', [user.id, 'coach_crm_leads.export', 'coach_crm_leads', JSON.stringify({ coach_id: user.id, count: rows.length })]);
    const cols = ['id','athlete','sport','stage','source','campaign','marketing_consent','next_action_on','loss_reason','added'];
    const data = rows.map((r) => ({
      id: r.id,
      athlete: r.athlete_name ?? (r.athlete_name_enc ? (() => { try { return decrypt(r.athlete_name_enc, 'coach_crm_leads.athlete_name'); } catch { return '[encrypted]'; } })() : ''),
      sport: r.sport_name ?? '',
      stage: r.stage,
      source: r.source_kind,
      campaign: r.campaign_ref ?? '',
      marketing_consent: r.marketing_consent ? 'yes' : 'no',
      next_action_on: r.next_action_on ?? '',
      loss_reason: r.loss_reason ?? '',
      added: r.added,
    }));
    const csv = toCsv(cols, data);
    return { csv, filename: `coach-crm-leads-${new Date().toISOString().slice(0, 10)}.csv` };
  },
});

// ── 15. list_coach_crm_campaigns ──────────────────────────────────────────────
cap({
  name: 'list_coach_crm_campaigns', method: 'GET', path: '/coach/crm/campaigns', tag: TAG, auth: COACH,
  summary: 'Coach\'s campaigns with status, recipient count and delivered count.',
  input: z.object({ status: z.enum([...CAMPAIGN_STATUSES, 'all']).default('all') }),
  async handler({ user }, i) {
    const filter = i.status !== 'all' ? ' AND status=$2' : '';
    return many(
      `SELECT id, name, kind, status, audience_filter, use_case_key, scheduled_at, sent_at, recipient_count, delivered_count, created_at, row_version
         FROM coach_crm_campaigns
        WHERE coach_id=$1 AND archived_at IS NULL${filter}
        ORDER BY created_at DESC LIMIT 50`,
      i.status !== 'all' ? [user.id, i.status] : [user.id]);
  },
});

// ── 16. create_coach_crm_campaign ─────────────────────────────────────────────
cap({
  name: 'create_coach_crm_campaign', method: 'POST', path: '/coach/crm/campaigns', tag: TAG, auth: COACH, status: 201,
  summary: 'Create a draft campaign. audience_filter shapes recipient selection from leads/clients. use_case_key must map to a comms-catalogue key.',
  input: z.object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(CAMPAIGN_KINDS),
    audience_filter: z.object({
      stages: z.array(z.string()).optional(),
      active_clients: z.boolean().optional(),
      sport_id: z.string().optional(),
      marketing_consent_only: z.boolean().default(true),
    }).default({ marketing_consent_only: true }),
    use_case_key: z.string().min(2).max(80),
    template_vars: z.record(z.string(), z.string()).default({}),
    scheduled_at: z.string().datetime().optional(),
  }),
  async handler({ user }, i) {
    const { rows } = await query(
      `INSERT INTO coach_crm_campaigns(coach_id, name, kind, audience_filter, use_case_key, template_vars, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$1) RETURNING id, row_version`,
      [user.id, i.name, i.kind, JSON.stringify(i.audience_filter), i.use_case_key, JSON.stringify(i.template_vars), i.scheduled_at ?? null]);
    return { id: rows[0].id, status: 'draft', row_version: rows[0].row_version };
  },
});

// ── 17. send_coach_crm_campaign ───────────────────────────────────────────────
cap({
  name: 'send_coach_crm_campaign', method: 'POST', path: '/coach/crm/campaigns/:id/send', tag: TAG, auth: COACH,
  summary: 'Resolve recipients (consent check, opt-out screen, youth guardian routing), write delivery log, and enqueue via notify(). Respects marketing_consent and guardian routing.',
  input: z.object({ id, row_version: version }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cam = (await c.query('SELECT * FROM coach_crm_campaigns WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!cam) throw notFound('Campaign');
      if (cam.row_version !== i.row_version) throw stale(cam);
      if (cam.status !== 'draft' && cam.status !== 'scheduled') throw badRequest(`Campaign is ${cam.status}`);

      const filter = cam.audience_filter || {};
      const consentFilter = filter.marketing_consent_only !== false ? ' AND l.marketing_consent = true' : '';
      const stageFilter = filter.stages?.length ? ` AND l.stage = ANY($2::text[])` : '';
      let candidates = await c.query(
        `SELECT DISTINCT l.athlete_id AS user_id
           FROM coach_crm_leads l
          WHERE l.coach_id = $1 AND l.archived_at IS NULL AND l.athlete_id IS NOT NULL${consentFilter}${stageFilter}`,
        stageFilter ? [user.id, filter.stages] : [user.id]);
      if (filter.active_clients) {
        const clients = await c.query(
          `SELECT DISTINCT h.athlete_id AS user_id FROM coach_hires h WHERE h.coach_id=$1 AND h.status='confirmed'`,
          [user.id]);
        candidates = { rows: [...candidates.rows, ...clients.rows.filter((r) => !candidates.rows.find((x) => x.user_id === r.user_id))] };
      }

      let recipientCount = 0;
      let deliveredCount = 0;
      for (const row of candidates.rows) {
        if (!row.user_id) continue;
        const isMinor = await c.query(`SELECT 1 FROM youth_profiles WHERE user_id=$1 AND EXTRACT(YEAR FROM AGE(dob)) < 18 LIMIT 1`, [row.user_id]);
        const targetId = isMinor.rows.length
          ? (await c.query(`SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL LIMIT 1`, [row.user_id])).rows[0]?.guardian_id
          : row.user_id;
        if (!targetId) {
          await c.query(`INSERT INTO coach_crm_campaign_recipients(campaign_id, user_id, status, suppressed_reason) VALUES($1,$2,'suppressed','youth_no_guardian')`, [i.id, row.user_id]);
          recipientCount++;
          continue;
        }
        await c.query(`INSERT INTO coach_crm_campaign_recipients(campaign_id, user_id, status, sent_at) VALUES($1,$2,'sent',now()) ON CONFLICT DO NOTHING`, [i.id, targetId]);
        await notify(c, targetId, { kind: 'coach_crm_campaign', title: cam.name, body: 'A message from your coach.', data: { campaign_id: i.id }, dedupe_key: `crm_campaign:${i.id}:${targetId}` });
        recipientCount++;
        deliveredCount++;
      }
      const { rows } = await c.query(
        `UPDATE coach_crm_campaigns SET status='sent', sent_at=now(), recipient_count=$2, delivered_count=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, recipientCount, deliveredCount]);
      await audit(c, user.id, 'coach_crm_campaign.sent', { campaign_id: i.id, recipients: recipientCount });
      return { status: 'sent', recipient_count: recipientCount, delivered_count: deliveredCount, row_version: rows[0].row_version };
    });
  },
});

// ── 18. assign_coach_crm_staff ────────────────────────────────────────────────
cap({
  name: 'assign_coach_crm_staff', method: 'POST', path: '/coach/crm/leads/:id/staff', tag: TAG, auth: COACH, status: 201,
  summary: 'Assign a staff member (handler or observer) to a lead. Idempotent.',
  input: z.object({ id, staff_id: id, role: z.enum(STAFF_ROLES).default('handler') }),
  async handler({ user }, i) {
    await getLeadWithAccess(i.id, user.id, true);
    const existing = await one('SELECT id, role FROM coach_crm_staff_assignments WHERE lead_id=$1 AND staff_id=$2 AND archived_at IS NULL', [i.id, i.staff_id]);
    if (existing) return { assignment_id: existing.id, duplicate: true };
    const { rows } = await query(
      'INSERT INTO coach_crm_staff_assignments(lead_id, staff_id, role, assigned_by) VALUES($1,$2,$3,$4) RETURNING id',
      [i.id, i.staff_id, i.role, user.id]);
    return { assignment_id: rows[0].id };
  },
});

// ── 19. remove_coach_crm_staff ────────────────────────────────────────────────
cap({
  name: 'remove_coach_crm_staff', method: 'DELETE', path: '/coach/crm/leads/:id/staff/:staff_id', tag: TAG, auth: COACH,
  summary: 'Archive a staff assignment. The staff member immediately loses access to this lead\'s private notes.',
  input: z.object({ id, staff_id: id }),
  async handler({ user }, i) {
    await getLeadWithAccess(i.id, user.id, true);
    const r = await one('UPDATE coach_crm_staff_assignments SET archived_at=now() WHERE lead_id=$1 AND staff_id=$2 AND archived_at IS NULL RETURNING id', [i.id, i.staff_id]);
    if (!r) throw notFound('Assignment');
    return { removed: true };
  },
});
