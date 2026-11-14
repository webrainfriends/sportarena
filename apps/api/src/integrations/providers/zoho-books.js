// Zoho Books OAuth2 provider for the Accounting Integration layer (#513).
// Credentials (refresh_token, client_id, client_secret) are stored encrypted via integration_credentials
// and are never logged or returned. The push() function is idempotent via Zoho's reference_id field.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { send } from '../http.js';

export const fields = z.object({
  region:          z.enum(['IN', 'US', 'EU', 'AU', 'JP']).default('IN').describe('Zoho data centre region'),
  organisation_id: z.string().max(80).optional().describe('Zoho Books organisation ID; set after test() lists available orgs'),
}).strict();

export const secrets = ['oauth_refresh_token', 'oauth_client_id', 'oauth_client_secret'];

export const sandbox = { invoices: 0, credit_notes: 0, payments: 0 };

const domainFor = (region) => {
  const map = { IN: 'in', US: 'com', EU: 'eu', AU: 'com.au', JP: 'jp' };
  return map[region] ?? 'in';
};

/** Refresh OAuth2 access token. Throws with permanent: true on bad credentials. */
async function refreshToken(cfg) {
  const domain = domainFor(cfg.region ?? 'IN');
  let r;
  try {
    r = await send('POST', `https://accounts.zoho.${domain}/oauth/v2/token`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.oauth_refresh_token ?? '',
        client_id: cfg.oauth_client_id ?? '',
        client_secret: cfg.oauth_client_secret ?? '',
      }).toString(),
    });
  } catch (err) {
    throw new Error(`Zoho token endpoint unreachable: ${err.message}`);
  }
  if (r.status === 400 || r.status === 401) throw Object.assign(new Error('Zoho rejected the credentials — check client ID, secret and refresh token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Zoho token endpoint answered ${r.status}`);
  let json;
  try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Zoho token endpoint did not return JSON'), { permanent: true }); }
  if (!json.access_token) throw Object.assign(new Error('Zoho did not return an access_token'), { permanent: true });
  return json.access_token;
}

/** GET helper against Zoho Books API, adding auth and org headers. */
async function booksGet(path, accessToken, orgId, region) {
  const domain = domainFor(region ?? 'IN');
  const url = `https://books.zoho.${domain}/api/v3${path}${orgId ? `?organization_id=${encodeURIComponent(orgId)}` : ''}`;
  const r = await send('GET', url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
  });
  return r;
}

/** POST helper against Zoho Books API. */
async function booksPost(path, body, accessToken, orgId, region) {
  const domain = domainFor(region ?? 'IN');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://books.zoho.${domain}/api/v3${path}${orgId ? `${sep}organization_id=${encodeURIComponent(orgId)}` : ''}`;
  const r = await send('POST', url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r;
}

/** Classify an HTTP error as retryable or permanent. */
function classifyError(status, text) {
  if (status === 429 || (status >= 500 && status < 600)) return new Error(`Zoho answered ${status}`);
  const err = new Error(`Zoho answered ${status}: ${String(text ?? '').slice(0, 200)}`);
  err.permanent = true;
  return err;
}

/** Test connection: refresh token, list organisations. */
export async function test(cfg) {
  const accessToken = await refreshToken(cfg);
  const domain = domainFor(cfg.region ?? 'IN');
  const r = await send('GET', `https://books.zoho.${domain}/api/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Zoho rejected the access token'), { permanent: true });
  if (r.status !== 200) throw classifyError(r.status, r.text);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Zoho did not return JSON'), { permanent: true }); }
  const orgs = (json?.organizations ?? []).map((o) => ({ id: o.organization_id, name: o.name, country: o.country_code }));
  return { ok: true, message: `Zoho Books connected — ${orgs.length} organisation(s) available`, organisations: orgs };
}

/** Lightweight health check: fetch one page of recent invoices for the connected org. */
export async function pull(cfg) {
  if (!cfg.organisation_id) return { summary: { invoices: 0, status: 'org_not_selected' } };
  try {
    const accessToken = await refreshToken(cfg);
    const r = await booksGet('/invoices?page=1&per_page=1', accessToken, cfg.organisation_id, cfg.region);
    if (r.status !== 200) return { summary: { invoices: 0 } };
    const json = JSON.parse(r.text ?? '{}');
    return { summary: { invoices: json?.page_context?.total ?? 0 } };
  } catch {
    return { summary: { invoices: 0 } };
  }
}

const DOC_ENDPOINT = {
  invoice:     '/invoices',
  credit_note: '/creditnotes',
  payment:     '/customerpayments',
  journal:     '/journals',
};

/** Build Zoho Books API payload for a document type from canonical export row + lines. */
function buildPayload(exportRow, lines, mappings, gstProfile) {
  const docDate = exportRow.exported_at ? String(exportRow.exported_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const refId = String(exportRow.document_id);
  const totalAmt = (lines || []).reduce((s, l) => s + (l.amount ?? 0), 0) / 100;

  if (exportRow.document_type === 'invoice') {
    return {
      reference_id: refId,
      date: docDate,
      reference_number: exportRow.external_ref ?? refId.slice(0, 8).toUpperCase(),
      line_items: (lines || []).map((ln, i) => ({
        name: ln.ledger_account,
        quantity: 1,
        rate: ln.amount / 100,
        account_id: ln.ledger_account,
        ...(ln.tax_component && ln.tax_component !== 'none' ? { tax_name: ln.tax_component.toUpperCase() } : {}),
      })),
      notes: `GotMyGame export — ${exportRow.document_type}`,
    };
  }
  if (exportRow.document_type === 'credit_note') {
    return {
      reference_id: refId,
      date: docDate,
      reference_number: exportRow.external_ref ?? refId.slice(0, 8).toUpperCase(),
      line_items: (lines || []).map((ln) => ({
        name: ln.ledger_account, quantity: 1, rate: ln.amount / 100, account_id: ln.ledger_account,
      })),
      notes: 'GotMyGame credit note export',
    };
  }
  if (exportRow.document_type === 'payment') {
    return {
      reference_id: refId, date: docDate,
      amount: totalAmt, payment_mode: 'cash',
      reference_number: exportRow.external_ref ?? refId.slice(0, 8).toUpperCase(),
      notes: 'GotMyGame payment export',
    };
  }
  return {
    reference_id: refId, date: docDate,
    journal_date: docDate,
    reference_number: exportRow.external_ref ?? refId.slice(0, 8).toUpperCase(),
    line_items: (lines || []).map((ln) => ({
      account_id: ln.ledger_account, description: ln.ledger_account,
      debit_or_credit: 'debit', amount: ln.amount / 100,
    })),
    notes: 'GotMyGame journal export',
  };
}

/**
 * Push an array of export rows to Zoho Books.
 * Uses reference_id for idempotency: if external_ref is set and payload_hash matches, skip.
 * Returns { exported, skipped, failed, errors }.
 */
export async function push(exports, linesByExport, mappings, gstProfile, cfg) {
  if (!cfg.organisation_id) throw Object.assign(new Error('Zoho Books organisation_id not configured — run test() and set it'), { permanent: true });

  let accessToken;
  try { accessToken = await refreshToken(cfg); } catch (err) { throw err; }

  let exported = 0; let skipped = 0; let failed = 0; const errors = [];

  for (const exp of exports) {
    const lines = linesByExport[exp.id] ?? [];
    const payload = buildPayload(exp, lines, mappings, gstProfile);
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    if (exp.payload_hash && exp.payload_hash === payloadHash && exp.external_ref) {
      skipped++;
      continue;
    }

    const endpoint = DOC_ENDPOINT[exp.document_type] ?? '/journals';
    try {
      const r = await booksPost(endpoint, payload, accessToken, cfg.organisation_id, cfg.region);
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        failed++;
        errors.push(`Zoho ${r.status} for ${exp.document_id} — will retry`);
        exp._failed = true; exp._retryable = true;
        continue;
      }
      if (r.status !== 200 && r.status !== 201) {
        failed++;
        errors.push(`Zoho ${r.status} for ${exp.document_id}: ${String(r.text ?? '').slice(0, 200)}`);
        exp._failed = true; exp._permanent = true;
        continue;
      }
      let json; try { json = JSON.parse(r.text); } catch { json = {}; }
      const externalRef = json?.invoice?.invoice_id ?? json?.creditnote?.creditnote_id ?? json?.payment?.payment_id ?? json?.journal?.journal_id ?? null;
      exp._newHash = payloadHash;
      exp._externalRef = externalRef;
      exp._exported = true;
      exported++;
    } catch (err) {
      failed++;
      errors.push(`${exp.document_id}: ${err.message}`);
      exp._failed = true;
    }
  }

  return { exported, skipped, failed, errors };
}
