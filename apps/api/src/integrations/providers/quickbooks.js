import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ realm_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  if (!cfg.realm_id) return { ok: true, message: 'QuickBooks configured (realm_id not yet set)' };
  const r = await send('GET', `https://quickbooks.api.intuit.com/v3/company/${cfg.realm_id}/companyinfo/${cfg.realm_id}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` },
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('QuickBooks rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'QuickBooks reachable' };
}

export async function pull(cfg, ctx) {
  if (!cfg.realm_id) return { summary: { invoices: 0 } };
  const query = encodeURIComponent("SELECT * FROM Invoice MAXRESULTS 100");
  const r = await send('GET', `https://quickbooks.api.intuit.com/v3/company/${cfg.realm_id}/query?query=${query}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` },
  });
  if (r.status !== 200) throw new Error(`QuickBooks answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('QuickBooks did not return JSON'), { permanent: true }); }
  return { summary: { invoices: json?.QueryResponse?.Invoice?.length ?? 0 } };
}

export const sandbox = { invoices: 11, customers: 28, payments: 9, accounts: 5 };
