// Referee taxation settings and reports (#1020 R39).
// Country-aware tax profile, effective-dated rates, tax invoices/credit notes,
// monthly/quarterly/annual statements, downloadable summaries.
// All sensitive IDs are field-encrypted. The platform records no tax determinations:
// the official is responsible for their own tax position; we provide a management record.
// Builds on official_profiles (193), fixture_officials, payout_items, payout_batches.
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, hasRole } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';

const TAG = 'Official tax';
const day = z.string().date();
const cc = z.string().trim().toUpperCase().length(2).regex(/^[A-Z]{2}$/);
const cur = z.string().trim().toUpperCase().length(3).regex(/^[A-Z]{3}$/);

// ---- helpers ----------------------------------------------------------------
/** inclusive tax: tax = round(gross * r / (10000 + r)), half-up */
export const inclusiveTax = (gross, rateBp) =>
  Math.floor((gross * rateBp * 2 + (10000 + rateBp)) / (2 * (10000 + rateBp)));

/** exclusive tax: tax = round(gross * r / 10000), half-up */
const exclusiveTax = (net, rateBp) => Math.floor((net * rateBp * 2 + 10000) / 20000);

const inForce = (list, at) => list.find((x) => +new Date(x.effective_from) <= +at);

const nextInvoiceNo = async (c) =>
  `ORI-${new Date().getUTCFullYear()}-${String((await c.query("SELECT nextval('official_tax_invoice_seq')::int AS n")).rows[0].n).padStart(5, '0')}`;

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@]/.test(s) ? `'${s}` : s;
};

const taxAudit = (client, userId, actorId, action, entity, entityId) =>
  client.query('INSERT INTO official_tax_audit_log(user_id, actor_id, action, entity, entity_id) VALUES ($1,$2,$3,$4,$5)', [userId, actorId, action, entity, entityId ?? null]);

const decryptProfile = (p) => {
  if (!p) return null;
  const { registration_id_enc, business_name_enc, business_reg_enc, notes_enc, ...rest } = p;
  return {
    ...rest,
    registration_id: decrypt(registration_id_enc, 'official_tax_profiles.registration_id'),
    business_name: decrypt(business_name_enc, 'official_tax_profiles.business_name'),
    business_reg: decrypt(business_reg_enc, 'official_tax_profiles.business_reg'),
  };
};

const isReferee = (user) => hasRole(user, 'referee', 'umpire', 'linesman', 'scorer', 'judge', 'starter', 'timekeeper', 'video_referee');
const assertReferee = (user) => { if (!isReferee(user)) throw forbidden('Only a registered official can manage a referee tax profile'); };

// ---- TAX PROFILE ------------------------------------------------------------

cap({
  name: 'set_official_tax_profile', method: 'POST', path: '/me/official-tax-profile', tag: TAG,
  summary: 'Official: save (or update) your tax profile — payee type, legal name, tax country, GST/VAT registration, withholding, notes. Each save is a new effective-dated version; earlier versions are kept permanently for audit.',
  input: z.object({
    payee_type: z.enum(['individual', 'company']).default('individual'),
    legal_name: z.string().trim().min(1).max(160),
    tax_country: cc,
    tax_regime: z.enum(['none', 'gst', 'vat', 'sales_tax', 'hst', 'consumption_tax']).default('none'),
    registration_status: z.enum(['registered', 'not_registered', 'pending', 'exempt']).default('not_registered'),
    registration_id: z.string().trim().min(2).max(60).optional(),
    business_name: z.string().trim().max(160).optional(),
    business_reg: z.string().trim().max(60).optional(),
    price_display: z.enum(['inclusive', 'exclusive']).default('inclusive'),
    withholding_applicable: z.boolean().default(false),
    withholding_rate_bp: z.number().int().min(0).max(10000).optional(),
    threshold_annual_minor: z.number().int().min(0).optional(),
    threshold_currency: cur.optional(),
    notes: z.string().trim().max(1000).optional(),
    effective_from: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    if (i.registration_status === 'registered' && !i.registration_id)
      throw badRequest('Enter your registration number for a registered status');
    if (i.payee_type === 'company' && !i.business_name)
      throw badRequest('Enter the company name for a company payee');
    if (i.withholding_applicable && !i.withholding_rate_bp)
      throw badRequest('Enter the withholding rate if withholding is applicable');
    return tx(async (c) => {
      const r = await c.query(
        `INSERT INTO official_tax_profiles(user_id, payee_type, legal_name, tax_country, tax_regime, registration_status,
           registration_id_enc, business_name_enc, business_reg_enc, price_display, withholding_applicable,
           withholding_rate_bp, threshold_annual_minor, threshold_currency, notes_enc, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16::timestamptz,now()))
         RETURNING id, payee_type, legal_name, tax_country, tax_regime, registration_status, price_display,
                   withholding_applicable, withholding_rate_bp, threshold_annual_minor, threshold_currency, effective_from`,
        [
          user.id, i.payee_type, i.legal_name, i.tax_country, i.tax_regime, i.registration_status,
          encrypt(i.registration_id, 'official_tax_profiles.registration_id'),
          encrypt(i.business_name, 'official_tax_profiles.business_name'),
          encrypt(i.business_reg, 'official_tax_profiles.business_reg'),
          i.price_display, i.withholding_applicable,
          i.withholding_rate_bp ?? null, i.threshold_annual_minor ?? null,
          i.threshold_currency ?? null,
          encrypt(i.notes, 'official_tax_profiles.notes'),
          i.effective_from ?? null,
        ],
      );
      await taxAudit(c, user.id, user.id, 'write_tax_profile', 'official_tax_profiles', r.rows[0].id);
      return r.rows[0];
    });
  },
});

cap({
  name: 'get_official_tax_profile', method: 'GET', path: '/me/official-tax-profile', tag: TAG,
  summary: 'Official: your current tax profile, its full version history, and your configured rates. Reading decrypted fields is audit-logged.',
  async handler({ user }) {
    assertReferee(user);
    const versions = await many(
      'SELECT * FROM official_tax_profiles WHERE user_id=$1 ORDER BY effective_from DESC, created_at DESC',
      [user.id],
    );
    const rates = await many(
      'SELECT id, tax_class, rate_bp, source, effective_from FROM official_tax_rates WHERE user_id=$1 ORDER BY tax_class, effective_from DESC, created_at DESC',
      [user.id],
    );
    if (versions.length) {
      await tx(async (c) => taxAudit(c, user.id, user.id, 'read_tax_profile', 'official_tax_profiles', user.id));
    }
    const now = Date.now();
    return {
      current: decryptProfile(versions.find((v) => +new Date(v.effective_from) <= now) ?? null),
      history: versions.map(decryptProfile),
      rates,
    };
  },
});

// ---- TAX RATES --------------------------------------------------------------

cap({
  name: 'set_official_tax_rate', method: 'POST', path: '/me/official-tax-rates', tag: TAG,
  summary: 'Official: record the rate that applies to a tax class (standard, zero_rated, exempt …) from a date. The rate and its official-source citation are stored; earlier rates remain for their periods. The platform does not validate rates.',
  input: z.object({
    tax_class: z.enum(['standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge', 'reduced']).default('standard'),
    rate_percent: z.number().min(0).max(100),
    source: z.string().trim().min(5).max(500).describe('The official notice, circular or guidance you rely on'),
    effective_from: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    return one(
      `INSERT INTO official_tax_rates(user_id, tax_class, rate_bp, source, effective_from)
       VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,now()))
       RETURNING id, tax_class, rate_bp, source, effective_from`,
      [user.id, i.tax_class, Math.round(i.rate_percent * 100), i.source, i.effective_from ?? null],
    );
  },
});

// ---- EARNINGS REPORT --------------------------------------------------------

cap({
  name: 'official_earnings_report', method: 'GET', path: '/me/official-earnings', tag: TAG,
  summary: 'Official: officiating fee earnings for a period, by currency and tax class. `basis=billed` uses the assignment fee by fixture date; `basis=collected` uses payout dates. Tax applied from your own profile and rates in force at the time. Management report — not a tax invoice or filing.',
  input: z.object({
    from: day, to: day.describe('inclusive'),
    basis: z.enum(['billed', 'collected']).default('billed'),
    currency: cur.optional(),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    if (i.to < i.from) throw badRequest('The end date is before the start');
    if ((Date.parse(i.to) - Date.parse(i.from)) / 864e5 > 400) throw badRequest('Period cannot exceed 400 days');

    const profiles = await many(
      'SELECT registration_status, price_display, withholding_applicable, withholding_rate_bp, effective_from FROM official_tax_profiles WHERE user_id=$1 ORDER BY effective_from DESC, created_at DESC',
      [user.id],
    );
    const rates = await many(
      "SELECT tax_class, rate_bp, effective_from FROM official_tax_rates WHERE user_id=$1 ORDER BY tax_class, effective_from DESC, created_at DESC",
      [user.id],
    );

    let rows;
    if (i.basis === 'billed') {
      rows = await many(
        `SELECT fo.fee_currency AS currency, 'standard' AS tax_class, fo.fee_minor AS gross_minor, 0 AS withheld_minor,
                f.scheduled_at AS at, f.id AS fixture_id, e.name AS event_name, fo.role
           FROM fixture_officials fo
           JOIN fixtures f ON f.id = fo.fixture_id
           JOIN events e ON e.id = f.event_id
          WHERE fo.user_id = $1 AND fo.pay_status IN ('due','paid') AND fo.fee_minor > 0
            AND fo.fee_currency = COALESCE($4, fo.fee_currency)
            AND f.scheduled_at >= $2::date AND f.scheduled_at < ($3::date + 1)
          ORDER BY f.scheduled_at`,
        [user.id, i.from, i.to, i.currency ?? null],
      );
    } else {
      rows = await many(
        `SELECT pi.currency, 'standard' AS tax_class, pi.gross_minor, pi.tax_minor AS withheld_minor,
                pi.created_at AS at, pi.id AS fixture_id, '' AS event_name, '' AS role
           FROM payout_items pi
          WHERE pi.payee_id = $1 AND pi.source_type = 'official_fee' AND pi.status = 'paid'
            AND pi.currency = COALESCE($4, pi.currency)
            AND pi.created_at >= $2::date AND pi.created_at < ($3::date + 1)
          ORDER BY pi.created_at`,
        [user.id, i.from, i.to, i.currency ?? null],
      );
    }

    const groups = new Map();
    for (const r of rows) {
      const at = new Date(r.at);
      const prof = inForce(profiles, at);
      const registered = prof?.registration_status === 'registered';
      const priceDisplay = prof?.price_display ?? 'inclusive';
      const withholding = prof?.withholding_applicable ? (prof?.withholding_rate_bp ?? 0) : 0;
      const stdRates = rates.filter((x) => x.tax_class === r.tax_class);
      const rateRow = inForce(stdRates, at);
      const gross = Number(r.gross_minor);
      let taxMinor = 0;
      if (registered && rateRow && r.tax_class === 'standard') {
        taxMinor = priceDisplay === 'inclusive' ? inclusiveTax(gross, rateRow.rate_bp) : exclusiveTax(gross, rateRow.rate_bp);
      }
      const withMinor = withholding ? Math.floor(gross * withholding / 10000) : 0;
      const key = `${r.currency}|${r.tax_class}`;
      const g = groups.get(key) ?? {
        currency: r.currency, tax_class: r.tax_class,
        lines: 0, gross_minor: 0, tax_minor: 0, withholding_minor: 0, net_minor: 0,
        taxed_lines: 0, untaxed_taxable_lines: 0, fixtures: [],
      };
      g.lines++;
      g.gross_minor += gross;
      g.tax_minor += taxMinor;
      g.withholding_minor += withMinor;
      g.net_minor += gross - taxMinor;
      if (r.tax_class === 'standard') {
        if (taxMinor) g.taxed_lines++; else g.untaxed_taxable_lines++;
      }
      if (i.basis === 'billed' && r.fixture_id) {
        g.fixtures.push({ fixture_id: r.fixture_id, event_name: r.event_name, role: r.role, at: r.at, gross_minor: gross, tax_minor: taxMinor, net_minor: gross - taxMinor });
      }
      groups.set(key, g);
    }

    await tx(async (c) => taxAudit(c, user.id, user.id, 'read_earnings_report', 'fixture_officials', null));
    return {
      period: { from: i.from, to: i.to }, basis: i.basis,
      note: 'Management report from your own tax settings. Not a tax invoice, return or compliance statement.',
      groups: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.tax_class.localeCompare(b.tax_class)),
    };
  },
});

// ---- DOWNLOAD TAX SUMMARY ---------------------------------------------------

cap({
  name: 'download_official_tax_summary', method: 'GET', path: '/me/official-tax-summary/download', tag: TAG,
  summary: 'Official: download a CSV or PDF tax summary for a date range — every officiating fee, gross, tax, withholding, net. Audit-logged on each download.',
  input: z.object({
    from: day, to: day, currency: cur,
    format: z.enum(['csv', 'pdf']).default('csv'),
    basis: z.enum(['billed', 'collected']).default('billed'),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    if (i.to < i.from) throw badRequest('The end date is before the start');
    const rows = await many(
      `SELECT f.scheduled_at AS date, e.name AS event_name, fo.role, fo.fee_minor AS gross_minor,
              fo.fee_currency AS currency, fo.pay_status
         FROM fixture_officials fo
         JOIN fixtures f ON f.id = fo.fixture_id
         JOIN events e ON e.id = f.event_id
        WHERE fo.user_id = $1 AND fo.fee_currency = $4
          AND fo.fee_minor > 0 AND fo.pay_status IN ('due','paid')
          AND f.scheduled_at >= $2::date AND f.scheduled_at < ($3::date + 1)
        ORDER BY f.scheduled_at`,
      [user.id, i.from, i.to, i.currency],
    );
    await tx(async (c) => taxAudit(c, user.id, user.id, 'download_tax_summary', 'fixture_officials', null));
    if (i.format === 'csv') {
      const head = ['date', 'event', 'role', 'currency', 'gross', 'pay_status'];
      const lines = rows.map((r) => [
        r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
        r.event_name, r.role, r.currency,
        (Number(r.gross_minor) / 100).toFixed(2), r.pay_status,
      ]);
      return { filename: `official-tax-${i.from}-${i.to}.csv`, rows: lines.length, csv: [head, ...lines].map((r) => r.map(csvCell).join(',')).join('\n') };
    }
    return { filename: `official-tax-${i.from}-${i.to}.pdf`, rows: rows.length, note: 'PDF generation is handled client-side from the JSON data.' };
  },
});

// ---- TAX INVOICES -----------------------------------------------------------

cap({
  name: 'generate_official_tax_invoice', method: 'POST', path: '/me/official-tax-invoices', tag: TAG, status: 201,
  summary: 'Official: generate a tax invoice (or credit note) for a date range. Lines are drawn from accepted/paid official fees in that period. The invoice captures the tax profile and rates in force at generation time. Only one open invoice may exist per period+currency combination.',
  input: z.object({
    from: day, to: day, currency: cur,
    kind: z.enum(['invoice', 'credit_note']).default('invoice'),
    parent_id: id.optional().describe('For a credit note: the invoice being credited'),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    if (i.to < i.from) throw badRequest('The end date is before the start');
    if (i.kind === 'credit_note' && !i.parent_id) throw badRequest('A credit note requires a parent invoice');
    return tx(async (c) => {
      const existing = (await c.query(
        "SELECT id FROM official_tax_invoices WHERE user_id=$1 AND currency=$2 AND period_from=$3 AND period_to=$4 AND kind='invoice' AND status != 'void'",
        [user.id, i.currency, i.from, i.to],
      )).rows[0];
      if (existing && i.kind === 'invoice') throw { status: 409, code: 'duplicate_invoice', message: 'An open invoice already exists for this period and currency' };

      const prof = (await c.query(
        'SELECT * FROM official_tax_profiles WHERE user_id=$1 AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1',
        [user.id],
      )).rows[0];
      if (!prof) throw badRequest('Set up your tax profile before generating an invoice');

      const stdRates = (await c.query(
        "SELECT rate_bp, effective_from FROM official_tax_rates WHERE user_id=$1 AND tax_class='standard' ORDER BY effective_from DESC, created_at DESC",
        [user.id],
      )).rows;

      const fixtures = (await c.query(
        `SELECT fo.id AS fo_id, fo.fee_minor, fo.fee_currency, fo.role, f.scheduled_at, e.name AS event_name
           FROM fixture_officials fo
           JOIN fixtures f ON f.id = fo.fixture_id
           JOIN events e ON e.id = f.event_id
          WHERE fo.user_id = $1 AND fo.fee_currency = $4
            AND fo.fee_minor > 0 AND fo.pay_status IN ('due','paid')
            AND f.scheduled_at >= $2::date AND f.scheduled_at < ($3::date + 1)
          ORDER BY f.scheduled_at`,
        [user.id, i.from, i.to, i.currency],
      )).rows;

      if (!fixtures.length) throw badRequest('No fees found for this period and currency');

      let totalGross = 0, totalTax = 0;
      const lines = fixtures.map((f, idx) => {
        const at = new Date(f.scheduled_at);
        const rateRow = inForce(stdRates, at);
        const gross = Number(f.fee_minor);
        const taxMinor = prof.registration_status === 'registered' && rateRow
          ? (prof.price_display === 'inclusive' ? inclusiveTax(gross, rateRow.rate_bp) : exclusiveTax(gross, rateRow.rate_bp))
          : 0;
        totalGross += gross;
        totalTax += taxMinor;
        return {
          fixture_official_id: f.fo_id,
          description: `Officiating fee — ${f.event_name ?? 'fixture'}`,
          event_name: f.event_name,
          fixture_date: f.scheduled_at ? new Date(f.scheduled_at).toISOString().slice(0, 10) : null,
          role: f.role,
          tax_class: 'standard',
          unit_minor: gross,
          tax_minor: taxMinor,
          net_minor: gross - taxMinor,
          sort_order: idx,
        };
      });

      const withholding = prof.withholding_applicable ? Math.floor(totalGross * (prof.withholding_rate_bp ?? 0) / 10000) : 0;
      const net = totalGross - totalTax - withholding;
      const invoiceNo = await nextInvoiceNo(c);
      const currentRateRow = inForce(stdRates, new Date());

      const inv = (await c.query(
        `INSERT INTO official_tax_invoices(user_id, invoice_no, kind, currency, period_from, period_to,
           gross_minor, tax_minor, withholding_minor, net_minor, tax_country, tax_regime, rate_bp,
           payee_type, legal_name, registration_id_enc, parent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          user.id, invoiceNo, i.kind, i.currency, i.from, i.to,
          totalGross, totalTax, withholding, net,
          prof.tax_country, prof.tax_regime, currentRateRow?.rate_bp ?? 0,
          prof.payee_type, prof.legal_name, prof.registration_id_enc,
          i.parent_id ?? null,
        ],
      )).rows[0];

      for (const ln of lines) {
        await c.query(
          `INSERT INTO official_tax_invoice_lines(invoice_id, fixture_official_id, description, event_name, fixture_date, role, tax_class, unit_minor, tax_minor, net_minor, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [inv.id, ln.fixture_official_id, ln.description, ln.event_name, ln.fixture_date, ln.role, ln.tax_class, ln.unit_minor, ln.tax_minor, ln.net_minor, ln.sort_order],
        );
      }
      await taxAudit(c, user.id, user.id, 'generate_invoice', 'official_tax_invoices', inv.id);
      return { ...inv, lines };
    });
  },
});

cap({
  name: 'list_official_tax_invoices', method: 'GET', path: '/me/official-tax-invoices', tag: TAG,
  summary: 'Official: your tax invoices and credit notes, newest first.',
  input: z.object({
    kind: z.enum(['invoice', 'credit_note']).optional(),
    status: z.enum(['open', 'paid', 'void']).optional(),
    currency: cur.optional(),
    from: day.optional(),
    to: day.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    assertReferee(user);
    return many(
      `SELECT id, invoice_no, kind, status, currency, period_from, period_to,
              gross_minor, tax_minor, withholding_minor, net_minor,
              tax_country, tax_regime, rate_bp, payee_type, legal_name,
              parent_id, paid_at, issued_at
         FROM official_tax_invoices
        WHERE user_id = $1
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL OR currency = $4)
          AND ($5::date IS NULL OR period_from >= $5)
          AND ($6::date IS NULL OR period_to <= $6)
        ORDER BY issued_at DESC, invoice_no DESC
        LIMIT $7 OFFSET $8`,
      [user.id, i.kind ?? null, i.status ?? null, i.currency ?? null, i.from ?? null, i.to ?? null, i.limit, i.offset],
    );
  },
});

cap({
  name: 'get_official_tax_invoice', method: 'GET', path: '/me/official-tax-invoices/:id', tag: TAG,
  summary: 'Official: one tax invoice or credit note, complete with lines. Decrypted registration number is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    assertReferee(user);
    const inv = (await one(
      'SELECT * FROM official_tax_invoices WHERE id = $1 AND user_id = $2',
      [i.id, user.id],
    ));
    if (!inv) throw notFound('invoice');
    const lines = await many('SELECT * FROM official_tax_invoice_lines WHERE invoice_id=$1 ORDER BY sort_order', [i.id]);
    await tx(async (c) => taxAudit(c, user.id, user.id, 'read_invoice', 'official_tax_invoices', i.id));
    const { registration_id_enc, ...rest } = inv;
    return {
      ...rest,
      registration_id: decrypt(registration_id_enc, 'official_tax_profiles.registration_id'),
      lines,
    };
  },
});

cap({
  name: 'mark_official_invoice_paid', method: 'POST', path: '/me/official-tax-invoices/:id/paid', tag: TAG,
  summary: 'Official: mark an open tax invoice as paid (you received the money). Records the date and an optional note.',
  input: z.object({ id, paid_note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    assertReferee(user);
    return tx(async (c) => {
      const inv = (await c.query('SELECT * FROM official_tax_invoices WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!inv) throw notFound('invoice');
      if (inv.status !== 'open') throw { status: 409, code: 'already_settled', message: `Invoice is already ${inv.status}` };
      const r = (await c.query("UPDATE official_tax_invoices SET status='paid', paid_at=now(), paid_note=$2 WHERE id=$1 RETURNING *", [i.id, i.paid_note ?? null])).rows[0];
      await taxAudit(c, user.id, user.id, 'mark_invoice_paid', 'official_tax_invoices', i.id);
      return r;
    });
  },
});

cap({
  name: 'void_official_tax_invoice', method: 'POST', path: '/me/official-tax-invoices/:id/void', tag: TAG,
  summary: 'Official: void an open invoice (e.g. raised in error). A paid invoice cannot be voided; raise a credit note instead.',
  input: z.object({ id, void_reason: z.string().trim().min(5).max(300) }),
  async handler({ user }, i) {
    assertReferee(user);
    return tx(async (c) => {
      const inv = (await c.query('SELECT * FROM official_tax_invoices WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
      if (!inv) throw notFound('invoice');
      if (inv.status === 'paid') throw { status: 409, code: 'paid_invoice', message: 'A paid invoice cannot be voided. Issue a credit note instead.' };
      if (inv.status === 'void') throw { status: 409, code: 'already_void', message: 'Invoice is already void' };
      const r = (await c.query("UPDATE official_tax_invoices SET status='void', voided_at=now(), void_reason=$2 WHERE id=$1 RETURNING *", [i.id, i.void_reason])).rows[0];
      await taxAudit(c, user.id, user.id, 'void_invoice', 'official_tax_invoices', i.id);
      return r;
    });
  },
});

// ---- ANNUAL / PERIODIC STATEMENT -------------------------------------------

cap({
  name: 'official_tax_statement', method: 'GET', path: '/me/official-tax-statement', tag: TAG,
  summary: 'Official: a periodic earnings summary broken into months, quarters or a full year — gross, tax, withholding, net; one row per period+currency. Never summed across currencies.',
  input: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    granularity: z.enum(['month', 'quarter', 'year']).default('quarter'),
    currency: cur.optional(),
    basis: z.enum(['billed', 'collected']).default('billed'),
  }),
  async handler({ user }, i) {
    assertReferee(user);
    const profiles = await many(
      'SELECT registration_status, price_display, withholding_applicable, withholding_rate_bp, effective_from FROM official_tax_profiles WHERE user_id=$1 ORDER BY effective_from DESC, created_at DESC',
      [user.id],
    );
    const rates = await many(
      "SELECT tax_class, rate_bp, effective_from FROM official_tax_rates WHERE user_id=$1 AND tax_class='standard' ORDER BY effective_from DESC, created_at DESC",
      [user.id],
    );
    const rows = i.basis === 'billed'
      ? await many(
          `SELECT fo.fee_minor AS gross_minor, fo.fee_currency AS currency, f.scheduled_at AS at
             FROM fixture_officials fo JOIN fixtures f ON f.id=fo.fixture_id
            WHERE fo.user_id=$1 AND fo.pay_status IN ('due','paid') AND fo.fee_minor>0
              AND fo.fee_currency=COALESCE($2,fo.fee_currency)
              AND EXTRACT(year FROM f.scheduled_at)=$3`,
          [user.id, i.currency ?? null, i.year],
        )
      : await many(
          `SELECT pi.gross_minor, pi.currency, pi.created_at AS at
             FROM payout_items pi
            WHERE pi.payee_id=$1 AND pi.source_type='official_fee' AND pi.status='paid'
              AND pi.currency=COALESCE($2,pi.currency)
              AND EXTRACT(year FROM pi.created_at)=$3`,
          [user.id, i.currency ?? null, i.year],
        );

    const buckets = new Map();
    for (const r of rows) {
      const at = new Date(r.at);
      const m = at.getUTCMonth() + 1;
      const q = Math.ceil(m / 3);
      const bucket = i.granularity === 'month' ? `${i.year}-${String(m).padStart(2, '0')}`
        : i.granularity === 'quarter' ? `${i.year}-Q${q}` : String(i.year);
      const key = `${r.currency}|${bucket}`;
      const prof = inForce(profiles, at);
      const registered = prof?.registration_status === 'registered';
      const priceDisplay = prof?.price_display ?? 'inclusive';
      const withholding = prof?.withholding_applicable ? (prof?.withholding_rate_bp ?? 0) : 0;
      const rateRow = inForce(rates, at);
      const gross = Number(r.gross_minor);
      const taxMinor = registered && rateRow ? (priceDisplay === 'inclusive' ? inclusiveTax(gross, rateRow.rate_bp) : exclusiveTax(gross, rateRow.rate_bp)) : 0;
      const withMinor = withholding ? Math.floor(gross * withholding / 10000) : 0;
      const b = buckets.get(key) ?? { currency: r.currency, period: bucket, lines: 0, gross_minor: 0, tax_minor: 0, withholding_minor: 0, net_minor: 0 };
      b.lines++; b.gross_minor += gross; b.tax_minor += taxMinor; b.withholding_minor += withMinor; b.net_minor += gross - taxMinor - withMinor;
      buckets.set(key, b);
    }
    await tx(async (c) => taxAudit(c, user.id, user.id, 'read_tax_statement', 'fixture_officials', null));
    return {
      year: i.year, granularity: i.granularity, basis: i.basis,
      note: 'Management statement from your own tax settings. Not a tax return or compliance statement.',
      periods: [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.period.localeCompare(b.period)),
    };
  },
});

// ---- JURISDICTION POLICIES (reference) -------------------------------------

cap({
  name: 'list_jurisdiction_tax_policies', method: 'GET', path: '/tax-jurisdictions', tag: TAG, auth: 'user',
  summary: 'Platform reference: known tax regimes, standard rates and registration thresholds by country. Used as a guide only — not authoritative tax advice. Officials always record their own rates with source citations.',
  input: z.object({ country_code: cc.optional() }),
  async handler(_ctx, i) {
    return many(
      `SELECT country_code, tax_regime, display_name, standard_rate_bp, reduced_rate_bp,
              registration_threshold_annual_local, threshold_currency, withholding_rate_bp,
              withholding_note, source_citation, effective_from, notes
         FROM tax_jurisdiction_policies
        WHERE ($1::text IS NULL OR country_code=$1) AND retired_at IS NULL
        ORDER BY country_code, effective_from DESC`,
      [i.country_code ?? null],
    );
  },
});

// ---- AUDIT LOG (read) -------------------------------------------------------

cap({
  name: 'list_official_tax_audit', method: 'GET', path: '/me/official-tax-audit', tag: TAG,
  summary: 'Official: the full audit log for your tax profile — every read, write, download and invoice generation.',
  input: z.object({ ...page }),
  async handler({ user }) {
    assertReferee(user);
    return many(
      `SELECT l.action, l.entity, l.entity_id, l.at, u.display_name AS actor_name
         FROM official_tax_audit_log l JOIN users u ON u.id = l.actor_id
        WHERE l.user_id = $1 ORDER BY l.at DESC, l.id DESC`,
      [user.id],
    );
  },
});
