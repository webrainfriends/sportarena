import { z } from 'zod';
import { send } from '../http.js';

export const fields = z.object({ tenant_id: z.string().max(80).optional() }).strict();
export const secrets = [];

export async function test(cfg) {
  const r = await send('GET', 'https://api.xero.com/connections', { headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}` } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Xero rejected the OAuth token'), { permanent: true });
  return { ok: true, message: 'Xero reachable' };
}

export async function pull(cfg, ctx) {
  if (!cfg.tenant_id) return { summary: { invoices: 0 } };
  const r = await send('GET', 'https://api.xero.com/api.xro/2.0/Invoices?page=1', {
    headers: { accept: 'application/json', authorization: `Bearer ${cfg.oauth_token ?? ''}`, 'xero-tenant-id': cfg.tenant_id },
  });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Xero rejected the OAuth token'), { permanent: true });
  if (r.status !== 200) throw new Error(`Xero answered ${r.status}`);
  let json; try { json = JSON.parse(r.text); } catch { throw Object.assign(new Error('Xero did not return JSON'), { permanent: true }); }
  return { summary: { invoices: json?.Invoices?.length ?? 0 } };
}

export const sandbox = { invoices: 14, payments: 8, contacts: 32, accounts: 7 };
