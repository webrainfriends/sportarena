// PS-18 — Adaptive Sports Equipment capability (#848).
// 30 endpoints: asset registry, loans/hire, event allocations,
// fitting appointments, service/inspection, athlete profile, sponsor funding.
// No tables from supply.js / academy-kit.js / coach-adaptive.js are modified.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { guardianLink } from '../youth.js';
import { encrypt, decrypt } from '../crypto.js';

// ─── vocabulary ──────────────────────────────────────────────────────────────

const ASSET_TYPES = [
  'sports_wheelchair', 'handcycle', 'throwing_frame', 'boccia_equipment',
  'adaptive_rowing_shell', 'sit_ski', 'prosthetic_sports_limb', 'assistive_device',
  'goalball_equipment', 'tandem_cycle', 'visually_impaired_guide_equipment',
  'powerchair', 'recumbent_trike', 'adaptive_surfboard', 'other',
];
const LOAN_PURPOSES  = ['session', 'event', 'trial', 'personal'];
const LOAN_STATUSES  = ['requested', 'confirmed', 'active', 'returned', 'cancelled', 'overdue'];
const SVC_TYPES      = ['routine', 'safety', 'repair', 'recall', 'pre_event'];
const CONDITION      = ['excellent', 'good', 'fair', 'damaged', 'missing'];
const SEVERITY       = ['minor', 'moderate', 'major', 'total_loss'];
const PASS_FAIL      = ['pass', 'fail', 'conditional'];
const FITTING_STATUS = ['requested', 'confirmed', 'completed', 'cancelled'];

// ─── 1. catalogue (public) ───────────────────────────────────────────────────

cap({
  name: 'get_adaptive_equipment_catalogue',
  method: 'GET', path: '/adaptive-equipment/catalogue',
  tag: 'Adaptive equipment', auth: 'public',
  summary: 'Vocabulary: asset types, sport map, service-frequency presets, compatibility language.',
  input: z.object({}),
  async handler() {
    return {
      asset_types: ASSET_TYPES.map((k) => ({ key: k })),
      loan_purposes: LOAN_PURPOSES,
      service_types: SVC_TYPES,
      condition_values: CONDITION,
      severity_values: SEVERITY,
      sports: await many('SELECT slug AS code, name FROM sports ORDER BY name'),
      compatibility_notice: 'Equipment suitability must be verified by a qualified fitter before use. This platform does not provide clinical recommendations.',
    };
  },
});

// ─── 2. asset registry ───────────────────────────────────────────────────────

cap({
  name: 'register_adaptive_asset',
  method: 'POST', path: '/adaptive-equipment/assets',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager', 'supplier'],
  status: 201,
  summary: 'Register a new adaptive equipment asset.',
  input: z.object({
    type: z.enum(ASSET_TYPES),
    name: z.string().min(2).max(200),
    sport_codes: z.array(z.string()).default([]),
    org_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    size_family: z.string().max(80).optional(),
    serial_number: z.string().max(120).optional(),
    purchase_date: z.string().optional(),
    purchase_value_cents: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).default('GBP'),
    funding_agreement_id: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const adjustment_notes_enc = i.notes ? await encrypt(i.notes) : null;
      const [row] = await c(
        `INSERT INTO adaptive_assets
          (type, name, sport_codes, org_id, venue_id, size_family, serial_number,
           purchase_date, purchase_value_cents, currency, funding_agreement_id,
           adjustment_notes_enc, status, owner_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'available',$13,$13)
         RETURNING *`,
        [i.type, i.name, i.sport_codes, i.org_id, i.venue_id, i.size_family, i.serial_number,
         i.purchase_date, i.purchase_value_cents, i.currency, i.funding_agreement_id,
         adjustment_notes_enc, user.id],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'list_adaptive_assets',
  method: 'GET', path: '/adaptive-equipment/assets',
  tag: 'Adaptive equipment', auth: true,
  summary: 'List adaptive assets with filters.',
  input: z.object({
    org_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    supplier_id: z.string().uuid().optional(),
    sport_code: z.string().optional(),
    type: z.enum(ASSET_TYPES).optional(),
    status: z.enum(['available', 'on_loan', 'in_service', 'retired']).optional(),
    event_id: z.string().uuid().optional(),
    q: z.string().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const filters = []; const params = [];
    const add = (sql, v) => { params.push(v); filters.push(sql.replace('?', `$${params.length}`)); };
    if (i.org_id)      add('a.org_id = ?', i.org_id);
    if (i.venue_id)    add('a.venue_id = ?', i.venue_id);
    if (i.supplier_id) add('a.created_by = ?', i.supplier_id);
    if (i.sport_code)  add('? = ANY(a.sport_codes)', i.sport_code);
    if (i.type)        add('a.type = ?', i.type);
    if (i.status)      add('a.status = ?', i.status);
    if (i.event_id)    add(`EXISTS (SELECT 1 FROM adaptive_event_allocations ea WHERE ea.asset_id = a.id AND ea.event_id = ? AND ea.cancelled_at IS NULL)`, i.event_id);
    if (i.q)           add('a.name ILIKE ?', `%${i.q.trim()}%`);
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    params.push(i.limit ?? 50, i.offset ?? 0);
    const lp = params.length;
    const items = await many(
      `SELECT a.*, o.name AS org_name, v.name AS venue_name
       FROM adaptive_assets a
       LEFT JOIN organisations o ON o.id = a.org_id
       LEFT JOIN venues v ON v.id = a.venue_id
       ${where} ORDER BY a.name LIMIT $${lp - 1} OFFSET $${lp}`,
      params,
    );
    return { items, total: items.length };
  },
});

cap({
  name: 'get_adaptive_asset',
  method: 'GET', path: '/adaptive-equipment/assets/:id',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Full asset detail including service log and event allocations.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const asset = await one('SELECT * FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const service_records = await many('SELECT * FROM adaptive_service_records WHERE asset_id=$1 ORDER BY performed_at DESC NULLS LAST', [i.id]);
    const event_allocations = await many('SELECT * FROM adaptive_event_allocations WHERE asset_id=$1 AND cancelled_at IS NULL ORDER BY start_dt', [i.id]);
    const loan = await one(`SELECT * FROM adaptive_loans WHERE asset_id=$1 AND status IN ('confirmed','active') ORDER BY start_date LIMIT 1`, [i.id]);
    return { ...asset, service_records, event_allocations, current_loan: loan ?? null };
  },
});

cap({
  name: 'update_adaptive_asset',
  method: 'PATCH', path: '/adaptive-equipment/assets/:id',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager', 'supplier'],
  summary: 'Update asset description, status, or retire it.',
  input: z.object({
    id,
    name: z.string().min(2).max(200).optional(),
    status: z.enum(['available', 'in_service', 'retired']).optional(),
    notes: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT * FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const adjustment_notes_enc = i.notes !== undefined ? (i.notes ? await encrypt(i.notes) : null) : asset.adjustment_notes_enc;
    await tx(async (c) => {
      await c(
        `UPDATE adaptive_assets SET
          name=COALESCE($2,name), status=COALESCE($3,status), adjustment_notes_enc=$4,
          retired_at=CASE WHEN $3='retired' AND retired_at IS NULL THEN NOW() ELSE retired_at END,
          row_version=row_version+1
         WHERE id=$1`,
        [i.id, i.name, i.status, adjustment_notes_enc],
      );
    });
    return { ok: true };
  },
});

cap({
  name: 'add_adaptive_asset_units',
  method: 'POST', path: '/adaptive-equipment/assets/:id/units',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager'],
  status: 201,
  summary: 'Add serial-numbered / barcoded units to an asset.',
  input: z.object({
    id,
    units: z.array(z.object({ serial_number: z.string(), barcode: z.string().optional() })).min(1),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT id FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    return tx(async (c) => {
      for (const u of i.units) {
        await c(
          "INSERT INTO adaptive_asset_units (asset_id,serial_number,barcode,status) VALUES ($1,$2,$3,'available') ON CONFLICT DO NOTHING",
          [i.id, u.serial_number, u.barcode],
        );
      }
      return { added: i.units.length };
    });
  },
});

// ─── 3. loans / hire ─────────────────────────────────────────────────────────

cap({
  name: 'request_adaptive_loan',
  method: 'POST', path: '/adaptive-equipment/loans',
  tag: 'Adaptive equipment', auth: true,
  status: 201,
  summary: 'Request a loan for self or ward.',
  input: z.object({
    asset_id: z.string().uuid(),
    start_date: z.string(),
    end_date: z.string(),
    purpose: z.enum(LOAN_PURPOSES),
    ward_id: z.string().uuid().optional(),
    deposit_waived: z.boolean().default(false),
    funding_agreement_id: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT * FROM adaptive_assets WHERE id=$1', [i.asset_id]);
    if (!asset) throw notFound('asset');
    if (asset.status !== 'available') throw conflict('asset_unavailable');
    const athlete_id = i.ward_id ?? user.id;
    if (i.ward_id && i.ward_id !== user.id) {
      const guardianship = await guardianLink(user.id, i.ward_id);
      if (!guardianship) throw badRequest('guardian_required');
    }
    return tx(async (c) => {
      const [row] = await c(
        `INSERT INTO adaptive_loans (asset_id,athlete_id,org_id,start_date,end_date,purpose,
           status,deposit_waived,funding_agreement_id,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9) RETURNING id`,
        [i.asset_id, athlete_id, asset.org_id, i.start_date, i.end_date,
         i.purpose, i.deposit_waived, i.funding_agreement_id, user.id],
      );
      await c('UPDATE adaptive_assets SET status=\'on_loan\', row_version=row_version+1 WHERE id=$1', [i.asset_id]);
      return { id: row.id };
    });
  },
});

cap({
  name: 'list_adaptive_loans',
  method: 'GET', path: '/adaptive-equipment/loans',
  tag: 'Adaptive equipment', auth: true,
  summary: 'My loans / org queue / venue queue.',
  input: z.object({
    org_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    status: z.enum(LOAN_STATUSES).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const filters = ['(l.athlete_id=$1 OR l.org_id=$2)'];
    const params = [user.id, user.org_id ?? null];
    if (i.org_id)  { params.push(i.org_id);  filters.push(`l.org_id=$${params.length}`); }
    if (i.status)  { params.push(i.status);  filters.push(`l.status=$${params.length}`); }
    params.push(i.limit ?? 50, i.offset ?? 0);
    const lp = params.length;
    const items = await many(
      `SELECT l.*, a.name AS asset_name, a.type AS asset_type
       FROM adaptive_loans l JOIN adaptive_assets a ON a.id=l.asset_id
       WHERE ${filters.join(' AND ')}
       ORDER BY l.start_date DESC LIMIT $${lp - 1} OFFSET $${lp}`,
      params,
    );
    return { items };
  },
});

cap({
  name: 'get_adaptive_loan',
  method: 'GET', path: '/adaptive-equipment/loans/:id',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Full loan detail including deposit ledger and incident log.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const loan = await one(
      `SELECT l.*, a.name AS asset_name, a.type AS asset_type
       FROM adaptive_loans l JOIN adaptive_assets a ON a.id=l.asset_id
       WHERE l.id=$1 AND (l.athlete_id=$2 OR l.org_id=$3)`,
      [i.id, user.id, user.org_id ?? null],
    );
    if (!loan) throw notFound('loan');
    await audit(null, user.id, 'view_loan', 'adaptive_loan', i.id);
    const incidents = await many(
      'SELECT id, severity, decision, charge_cents, decided_at, created_at FROM adaptive_loan_incidents WHERE loan_id=$1',
      [i.id],
    );
    return { ...loan, incidents };
  },
});

cap({
  name: 'confirm_adaptive_loan',
  method: 'POST', path: '/adaptive-equipment/loans/:id/confirm',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager'],
  summary: 'Confirm a loan request.',
  input: z.object({ id, deposit_collected: z.boolean().default(false) }),
  async handler({ user }, i) {
    const loan = await one("SELECT * FROM adaptive_loans WHERE id=$1 AND status='requested'", [i.id]);
    if (!loan) throw notFound('loan');
    return tx(async (c) => {
      await c(
        'UPDATE adaptive_loans SET status=\'confirmed\', deposit_paid_at=CASE WHEN $2 THEN NOW() ELSE NULL END, row_version=row_version+1 WHERE id=$1',
        [i.id, i.deposit_collected],
      );
      return { ok: true };
    });
  },
});

cap({
  name: 'handover_adaptive_loan',
  method: 'POST', path: '/adaptive-equipment/loans/:id/handover',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager'],
  summary: 'Record physical handover.',
  input: z.object({ id, condition_at_handover: z.enum(CONDITION).default('good') }),
  async handler({ user }, i) {
    const loan = await one("SELECT * FROM adaptive_loans WHERE id=$1 AND status='confirmed'", [i.id]);
    if (!loan) throw notFound('loan');
    return tx(async (c) => {
      await c(
        'UPDATE adaptive_loans SET status=\'active\', condition_at_handover=$2, row_version=row_version+1 WHERE id=$1',
        [i.id, i.condition_at_handover],
      );
      return { ok: true };
    });
  },
});

cap({
  name: 'return_adaptive_loan',
  method: 'POST', path: '/adaptive-equipment/loans/:id/return',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager'],
  summary: 'Record return and reconcile deposit.',
  input: z.object({ id, condition_at_return: z.enum(CONDITION), return_notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const loan = await one("SELECT * FROM adaptive_loans WHERE id=$1 AND status='active'", [i.id]);
    if (!loan) throw notFound('loan');
    return tx(async (c) => {
      await c(
        `UPDATE adaptive_loans SET status='returned', condition_at_return=$2,
           returned_at=NOW(), deposit_refunded_at=CASE WHEN deposit_paid_at IS NOT NULL THEN NOW() ELSE NULL END,
           row_version=row_version+1 WHERE id=$1`,
        [i.id, i.condition_at_return],
      );
      await c('UPDATE adaptive_assets SET status=\'available\', row_version=row_version+1 WHERE id=$1', [loan.asset_id]);
      return { ok: true };
    });
  },
});

cap({
  name: 'report_loan_incident',
  method: 'POST', path: '/adaptive-equipment/loans/:id/incident',
  tag: 'Adaptive equipment', auth: true,
  status: 201,
  summary: 'Report damage or loss on an active loan.',
  input: z.object({
    id,
    severity: z.enum(SEVERITY),
    description: z.string().min(10).max(2000),
    photos_ok: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const loan = await one(
      "SELECT * FROM adaptive_loans WHERE id=$1 AND athlete_id=$2 AND status IN ('active','confirmed')",
      [i.id, user.id],
    );
    if (!loan) throw notFound('loan');
    const description_enc = await encrypt(i.description);
    await audit(null, user.id, 'report_incident', 'adaptive_loan', i.id);
    return tx(async (c) => {
      const [row] = await c(
        'INSERT INTO adaptive_loan_incidents (loan_id,reported_by,severity,description_enc,photos_available) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [i.id, user.id, i.severity, description_enc, i.photos_ok],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'decide_loan_incident',
  method: 'POST', path: '/adaptive-equipment/loans/:id/incident-decision',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager'],
  summary: 'Approve / reject incident; apply charge or waive.',
  input: z.object({
    id,
    incident_id: z.string().uuid(),
    decision: z.enum(['approved', 'rejected', 'waived']),
    charge_cents: z.number().int().nonnegative().optional(),
  }),
  async handler({ user }, i) {
    const inc = await one('SELECT * FROM adaptive_loan_incidents WHERE id=$1 AND loan_id=$2', [i.incident_id, i.id]);
    if (!inc) throw notFound('incident');
    await tx(async (c) => {
      await c(
        'UPDATE adaptive_loan_incidents SET decision=$2, charge_cents=$3, decided_by=$4, decided_at=NOW() WHERE id=$1',
        [i.incident_id, i.decision, i.charge_cents ?? null, user.id],
      );
    });
    return { ok: true };
  },
});

cap({
  name: 'cancel_adaptive_loan',
  method: 'POST', path: '/adaptive-equipment/loans/:id/cancel',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Cancel a pending loan; refund deposit if paid.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const loan = await one(
      "SELECT * FROM adaptive_loans WHERE id=$1 AND athlete_id=$2 AND status IN ('requested','confirmed')",
      [i.id, user.id],
    );
    if (!loan) throw notFound('loan');
    return tx(async (c) => {
      await c(
        'UPDATE adaptive_loans SET status=\'cancelled\', cancelled_at=NOW(), deposit_refunded_at=CASE WHEN deposit_paid_at IS NOT NULL THEN NOW() ELSE NULL END, row_version=row_version+1 WHERE id=$1',
        [i.id],
      );
      await c('UPDATE adaptive_assets SET status=\'available\', row_version=row_version+1 WHERE id=$1', [loan.asset_id]);
      return { ok: true };
    });
  },
});

// ─── 4. event allocations ────────────────────────────────────────────────────

cap({
  name: 'allocate_asset_to_event',
  method: 'POST', path: '/adaptive-equipment/assets/:id/event-allocations',
  tag: 'Adaptive equipment', auth: ['event_manager', 'org_admin'],
  status: 201,
  summary: 'Reserve asset for an event window.',
  input: z.object({
    id,
    event_id: z.string().uuid(),
    start_dt: z.string(),
    end_dt: z.string(),
    notes: z.string().optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT * FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const conflict_check = await one(
      `SELECT id FROM adaptive_event_allocations WHERE asset_id=$1 AND cancelled_at IS NULL
       AND tstzrange(start_dt,end_dt,'[]') && tstzrange($2::timestamptz,$3::timestamptz,'[]')`,
      [i.id, i.start_dt, i.end_dt],
    );
    if (conflict_check) throw conflict('asset_already_allocated');
    return tx(async (c) => {
      const [row] = await c(
        'INSERT INTO adaptive_event_allocations (asset_id,event_id,start_dt,end_dt,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [i.id, i.event_id, i.start_dt, i.end_dt, i.notes, user.id],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'list_event_asset_allocations',
  method: 'GET', path: '/events/:event_id/adaptive-equipment',
  tag: 'Adaptive equipment', auth: true,
  summary: 'All assets allocated or needed for an event, with readiness flags.',
  input: z.object({ event_id: z.string().uuid() }),
  async handler({ user }, i) {
    const assets = await many(
      `SELECT a.id, a.name, a.type, a.status, a.sport_codes,
              ea.id AS alloc_id, ea.start_dt, ea.end_dt,
              (SELECT performed_at FROM adaptive_service_records sr WHERE sr.asset_id=a.id ORDER BY performed_at DESC LIMIT 1) AS last_service,
              (SELECT next_due_date FROM adaptive_service_records sr WHERE sr.asset_id=a.id ORDER BY performed_at DESC LIMIT 1) AS next_service_due
       FROM adaptive_event_allocations ea
       JOIN adaptive_assets a ON a.id=ea.asset_id
       WHERE ea.event_id=$1 AND ea.cancelled_at IS NULL`,
      [i.event_id],
    );
    return {
      assets: assets.map((a) => ({
        ...a,
        allocated: true,
        service_overdue: a.next_service_due ? new Date(a.next_service_due) < new Date() : false,
        readiness: a.status === 'available' && (!a.next_service_due || new Date(a.next_service_due) >= new Date()) ? 'ready' : 'needs_service',
      })),
    };
  },
});

cap({
  name: 'cancel_event_allocation',
  method: 'POST', path: '/adaptive-equipment/event-allocations/:id/cancel',
  tag: 'Adaptive equipment', auth: ['event_manager', 'org_admin'],
  summary: 'Release event reservation.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const alloc = await one('SELECT * FROM adaptive_event_allocations WHERE id=$1 AND cancelled_at IS NULL', [i.id]);
    if (!alloc) throw notFound('allocation');
    await tx(async (c) => {
      await c('UPDATE adaptive_event_allocations SET cancelled_at=NOW() WHERE id=$1', [i.id]);
    });
    return { ok: true };
  },
});

// ─── 5. fitting appointments ─────────────────────────────────────────────────

cap({
  name: 'create_fitting_appointment',
  method: 'POST', path: '/adaptive-equipment/fittings',
  tag: 'Adaptive equipment', auth: true,
  status: 201,
  summary: 'Book a fitting/setup appointment with a certified clinician.',
  input: z.object({
    asset_id: z.string().uuid(),
    clinician_id: z.string().uuid(),
    preferred_slot: z.string(),
    para_case_id: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT id FROM adaptive_assets WHERE id=$1', [i.asset_id]);
    if (!asset) throw notFound('asset');
    return tx(async (c) => {
      const slotEnd = new Date(new Date(i.preferred_slot).getTime() + 90 * 60000).toISOString();
      const [row] = await c(
        "INSERT INTO adaptive_fittings (asset_id,athlete_id,clinician_id,para_case_id,preferred_slot_start,preferred_slot_end,status,created_by) VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,'requested',$2) RETURNING id",
        [i.asset_id, user.id, i.clinician_id, i.para_case_id, i.preferred_slot, slotEnd],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'list_fitting_appointments',
  method: 'GET', path: '/adaptive-equipment/fittings',
  tag: 'Adaptive equipment', auth: true,
  summary: 'My fitting appointments / org queue.',
  input: z.object({
    asset_id: z.string().uuid().optional(),
    supplier_id: z.string().uuid().optional(),
    status: z.enum(FITTING_STATUS).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const filters = ['(f.athlete_id=$1 OR f.clinician_id=$1)'];
    const params = [user.id];
    if (i.asset_id)    { params.push(i.asset_id);    filters.push(`f.asset_id=$${params.length}`); }
    if (i.supplier_id) { params.push(i.supplier_id); filters.push(`f.clinician_id=$${params.length}`); }
    if (i.status)      { params.push(i.status);      filters.push(`f.status=$${params.length}`); }
    params.push(i.limit ?? 50, i.offset ?? 0);
    const lp = params.length;
    const items = await many(
      `SELECT f.*, a.name AS asset_name, p.display_name AS athlete_name
       FROM adaptive_fittings f
       JOIN adaptive_assets a ON a.id=f.asset_id
       LEFT JOIN users p ON p.id=f.athlete_id
       WHERE ${filters.join(' AND ')}
       ORDER BY f.preferred_slot_start DESC LIMIT $${lp - 1} OFFSET $${lp}`,
      params,
    );
    return { items };
  },
});

cap({
  name: 'update_fitting_appointment',
  method: 'PATCH', path: '/adaptive-equipment/fittings/:id',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Reschedule, confirm, complete, or cancel a fitting.',
  input: z.object({
    id,
    status: z.enum(FITTING_STATUS).optional(),
    slot_start: z.string().optional(),
  }),
  async handler({ user }, i) {
    const fit = await one(
      'SELECT * FROM adaptive_fittings WHERE id=$1 AND (athlete_id=$2 OR clinician_id=$2)',
      [i.id, user.id],
    );
    if (!fit) throw notFound('fitting');
    await tx(async (c) => {
      await c(
        'UPDATE adaptive_fittings SET status=COALESCE($2,status), preferred_slot_start=COALESCE($3::timestamptz,preferred_slot_start), row_version=row_version+1 WHERE id=$1',
        [i.id, i.status, i.slot_start],
      );
    });
    return { ok: true };
  },
});

cap({
  name: 'record_fitting_outcome',
  method: 'POST', path: '/adaptive-equipment/fittings/:id/outcome',
  tag: 'Adaptive equipment', auth: ['supplier', 'clinician'],
  summary: 'Record recommended size/adjustment settings (operational use only — no clinical data).',
  input: z.object({
    id,
    outcome_notes: z.string().max(2000).optional(),
    recommended_settings: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    const fit = await one('SELECT * FROM adaptive_fittings WHERE id=$1 AND clinician_id=$2', [i.id, user.id]);
    if (!fit) throw notFound('fitting');
    const outcome_notes_enc = i.outcome_notes ? await encrypt(i.outcome_notes) : null;
    const recommended_settings_enc = i.recommended_settings ? await encrypt(i.recommended_settings) : null;
    await audit(null, user.id, 'record_outcome', 'adaptive_fitting', i.id);
    await tx(async (c) => {
      await c(
        'UPDATE adaptive_fittings SET outcome_notes_enc=$2, recommended_adjustments_enc=$3, status=\'completed\', row_version=row_version+1 WHERE id=$1',
        [i.id, outcome_notes_enc, recommended_settings_enc],
      );
    });
    return { ok: true };
  },
});

// ─── 6. service / inspection ─────────────────────────────────────────────────

cap({
  name: 'create_service_record',
  method: 'POST', path: '/adaptive-equipment/assets/:id/service',
  tag: 'Adaptive equipment', auth: ['org_admin', 'venue_manager', 'supplier'],
  status: 201,
  summary: 'Log a service or inspection record for an asset.',
  input: z.object({
    id,
    service_type: z.enum(SVC_TYPES),
    technician: z.string().max(200),
    performed_at: z.string().optional(),
    next_due: z.string().optional(),
    pass_fail: z.enum(PASS_FAIL).default('pass'),
    findings: z.string().max(3000).optional(),
    service_order_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT id FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const findings_enc = i.findings ? await encrypt(i.findings) : null;
    return tx(async (c) => {
      const performed = i.performed_at ?? new Date().toISOString().slice(0, 10);
      const [row] = await c(
        `INSERT INTO adaptive_service_records
          (asset_id,service_type,technician_name,service_order_id,performed_at,next_due_date,pass_fail,findings_enc,created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9) RETURNING id`,
        [i.id, i.service_type, i.technician, i.service_order_id, performed, i.next_due, i.pass_fail, findings_enc, user.id],
      );
      await c(
        "UPDATE adaptive_assets SET status=CASE WHEN $2='safety' OR $2='repair' THEN 'in_service' ELSE status END, row_version=row_version+1 WHERE id=$1",
        [i.id, i.service_type],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'list_service_records',
  method: 'GET', path: '/adaptive-equipment/assets/:id/service',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Full service calendar for an asset.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const asset = await one('SELECT id FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const records = await many(
      'SELECT id,service_type,performed_at,next_due_date AS next_due,pass_fail,created_at FROM adaptive_service_records WHERE asset_id=$1 ORDER BY performed_at DESC NULLS LAST',
      [i.id],
    );
    return { records };
  },
});

cap({
  name: 'get_equipment_readiness',
  method: 'GET', path: '/adaptive-equipment/assets/:id/readiness',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Is this asset ready: service overdue, active loan, event conflict, recall?',
  input: z.object({ id }),
  async handler({ user }, i) {
    const asset = await one('SELECT * FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    const latest_svc = await one(
      'SELECT next_due_date AS next_due, service_type FROM adaptive_service_records WHERE asset_id=$1 ORDER BY performed_at DESC NULLS LAST LIMIT 1',
      [i.id],
    );
    const service_overdue = latest_svc?.next_due ? new Date(latest_svc.next_due) < new Date() : false;
    const recall = latest_svc?.service_type === 'recall';
    const active_loan = await one(
      "SELECT id FROM adaptive_loans WHERE asset_id=$1 AND status IN ('active','confirmed')",
      [i.id],
    );
    const event_conflict = await one(
      'SELECT id FROM adaptive_event_allocations WHERE asset_id=$1 AND cancelled_at IS NULL AND start_dt <= NOW() AND end_dt >= NOW()',
      [i.id],
    );
    return {
      asset_id: i.id,
      ready: !service_overdue && !recall && !active_loan && !event_conflict,
      service_overdue,
      has_recall: recall,
      has_active_loan: !!active_loan,
      has_conflict: !!event_conflict,
      next_service_due: latest_svc?.next_due ?? null,
    };
  },
});

cap({
  name: 'get_venue_equipment_readiness',
  method: 'GET', path: '/venues/:venue_id/adaptive-equipment/readiness',
  tag: 'Adaptive equipment', auth: ['venue_manager', 'event_manager'],
  summary: 'All venue assets with readiness flags and next service due.',
  input: z.object({ venue_id: z.string().uuid() }),
  async handler({ user }, i) {
    const assets = await many(
      `SELECT a.id, a.name, a.type, a.sport_codes, a.status,
              (SELECT next_due_date FROM adaptive_service_records sr WHERE sr.asset_id=a.id ORDER BY performed_at DESC NULLS LAST LIMIT 1) AS next_service_due,
              (SELECT service_type FROM adaptive_service_records sr WHERE sr.asset_id=a.id ORDER BY performed_at DESC NULLS LAST LIMIT 1) AS last_service_type
       FROM adaptive_assets a
       WHERE a.venue_id=$1 AND a.status != 'retired'
       ORDER BY a.name`,
      [i.venue_id],
    );
    return {
      assets: assets.map((a) => ({
        ...a,
        service_overdue: a.next_service_due ? new Date(a.next_service_due) < new Date() : false,
        has_conflict: false,
      })),
    };
  },
});

// ─── 7. athlete profile ───────────────────────────────────────────────────────

cap({
  name: 'get_my_adaptive_loans',
  method: 'GET', path: '/me/adaptive-equipment/loans',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Own loans past and present; guardian may pass ward_id.',
  input: z.object({ ward_id: z.string().uuid().optional() }),
  async handler({ user }, i) {
    const athlete_id = i.ward_id ?? user.id;
    if (i.ward_id && i.ward_id !== user.id) {
      const g = await guardianLink(user.id, i.ward_id);
      if (!g) throw badRequest('guardian_required');
    }
    await audit(null, user.id, 'view_my_loans', 'adaptive_loans', athlete_id);
    const items = await many(
      `SELECT l.*, a.name AS asset_name, a.type AS asset_type,
              (SELECT json_agg(json_build_object('id',ai.id,'severity',ai.severity,'decision',ai.decision,'created_at',ai.created_at))
               FROM adaptive_loan_incidents ai WHERE ai.loan_id=l.id) AS incidents
       FROM adaptive_loans l JOIN adaptive_assets a ON a.id=l.asset_id
       WHERE l.athlete_id=$1 ORDER BY l.start_date DESC`,
      [athlete_id],
    );
    return { items };
  },
});

cap({
  name: 'register_own_equipment',
  method: 'POST', path: '/me/adaptive-equipment/own',
  tag: 'Adaptive equipment', auth: true,
  status: 201,
  summary: 'Register athlete-owned equipment for venue records.',
  input: z.object({
    type: z.enum(ASSET_TYPES),
    name: z.string().min(2).max(200),
    description: z.string().max(2000).optional(),
    acquired_date: z.string().optional(),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const description_enc = i.description ? await encrypt(i.description) : null;
    const notes_enc = i.notes ? await encrypt(i.notes) : null;
    return tx(async (c) => {
      const [row] = await c(
        'INSERT INTO adaptive_athlete_equipment (athlete_id,type,name,description_enc,acquired_date,notes_enc) VALUES ($1,$2,$3,$4,$5::date,$6) RETURNING id',
        [user.id, i.type, i.name, description_enc, i.acquired_date, notes_enc],
      );
      return { id: row.id };
    });
  },
});

cap({
  name: 'get_own_equipment',
  method: 'GET', path: '/me/adaptive-equipment/own',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Own adaptive equipment profile.',
  input: z.object({}),
  async handler({ user }) {
    const items = await many(
      'SELECT id,type,name,acquired_date,row_version FROM adaptive_athlete_equipment WHERE athlete_id=$1 ORDER BY name',
      [user.id],
    );
    return { items };
  },
});

cap({
  name: 'update_own_equipment',
  method: 'PATCH', path: '/me/adaptive-equipment/own/:id',
  tag: 'Adaptive equipment', auth: true,
  summary: 'Update own equipment record.',
  input: z.object({
    id,
    name: z.string().min(2).max(200).optional(),
    description: z.string().max(2000).optional(),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const eq = await one(
      'SELECT * FROM adaptive_athlete_equipment WHERE id=$1 AND athlete_id=$2',
      [i.id, user.id],
    );
    if (!eq) throw notFound('equipment');
    const description_enc = i.description !== undefined ? (i.description ? await encrypt(i.description) : null) : eq.description_enc;
    const notes_enc = i.notes !== undefined ? (i.notes ? await encrypt(i.notes) : null) : eq.notes_enc;
    await tx(async (c) => {
      await c(
        'UPDATE adaptive_athlete_equipment SET name=COALESCE($2,name), description_enc=$3, notes_enc=$4, row_version=row_version+1 WHERE id=$1',
        [i.id, i.name, description_enc, notes_enc],
      );
    });
    return { ok: true };
  },
});

// ─── 8. sponsor funding ───────────────────────────────────────────────────────

cap({
  name: 'apply_sponsor_funding_to_asset',
  method: 'POST', path: '/adaptive-equipment/assets/:id/sponsor-funding',
  tag: 'Adaptive equipment', auth: ['org_admin'],
  status: 201,
  summary: 'Link a funding_agreement_id to an asset purchase or loan waiver.',
  input: z.object({
    id,
    funding_agreement_id: z.string().uuid(),
    notes: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    const asset = await one('SELECT id FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    return tx(async (c) => {
      await c(
        'UPDATE adaptive_assets SET funding_agreement_id=$2, row_version=row_version+1 WHERE id=$1',
        [i.id, i.funding_agreement_id],
      );
      return { ok: true };
    });
  },
});

cap({
  name: 'list_asset_sponsor_funding',
  method: 'GET', path: '/adaptive-equipment/assets/:id/sponsor-funding',
  tag: 'Adaptive equipment', auth: ['org_admin'],
  summary: 'Funding agreements covering this asset.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const asset = await one('SELECT id,funding_agreement_id FROM adaptive_assets WHERE id=$1', [i.id]);
    if (!asset) throw notFound('asset');
    return { funding_agreement_id: asset.funding_agreement_id };
  },
});
